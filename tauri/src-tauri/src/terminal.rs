use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use chrono::Utc;
use serde::{Deserialize, Serialize};

const MAX_EVENTS_PER_SESSION: usize = 500;

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("{0}")]
    Other(String),
    #[error("terminal_not_found: {0}")]
    NotFound(String),
    #[error("wsl_missing: Windows terminal defaults to WSL. Install WSL and configure Docker before using agent shell workflows.")]
    WslMissing,
}

impl From<std::io::Error> for TerminalError {
    fn from(value: std::io::Error) -> Self {
        TerminalError::Other(value.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProblem {
    pub code: String,
    pub message: String,
    pub fix_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistroStatus {
    pub name: String,
    pub state: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellEnvironmentStatus {
    pub os: String,
    pub preferred_shell: String,
    pub available: bool,
    pub command: String,
    pub args: Vec<String>,
    pub wsl: Option<WslStatus>,
    pub problems: Vec<ShellProblem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslStatus {
    pub installed: bool,
    pub default_distro: Option<String>,
    pub distros: Vec<WslDistroStatus>,
    pub docker_available: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCapability {
    pub default_shell: String,
    pub shells: Vec<String>,
    pub supports_pty: bool,
    pub agent_uses_unix_commands: bool,
    pub shell: ShellEnvironmentStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub name: String,
    pub shell_kind: String,
    pub cwd: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub order: u32,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    pub id: String,
    pub session_id: String,
    pub sequence: u64,
    pub r#type: String,
    pub data: Option<String>,
    pub exit_code: Option<u32>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalSessionRequest {
    pub name: Option<String>,
    pub shell_kind: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInputRequest {
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeRequest {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTerminalSessionRequest {
    pub name: Option<String>,
    pub order: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionsResult {
    pub sessions: Vec<TerminalSession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventsResult {
    pub events: Vec<TerminalEvent>,
}

#[derive(Clone)]
struct ShellSpec {
    kind: String,
    command: String,
    args: Vec<String>,
    cwd: String,
}

struct TerminalRecord {
    session: TerminalSession,
    child: Child,
    stdin: ChildStdin,
    events: Vec<TerminalEvent>,
    sequence: u64,
}

#[derive(Default)]
struct TerminalState {
    sessions: HashMap<String, TerminalRecord>,
}

pub struct TerminalManager {
    state: Arc<Mutex<TerminalState>>,
    next_id: AtomicU64,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(TerminalState::default())),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn capabilities(&self) -> TerminalCapability {
        terminal_capability()
    }

    pub fn list_sessions(&self) -> TerminalSessionsResult {
        let mut sessions: Vec<TerminalSession> = self
            .state
            .lock()
            .expect("terminal state poisoned")
            .sessions
            .values()
            .map(|record| record.session.clone())
            .collect();
        sessions.sort_by_key(|session| session.order);
        TerminalSessionsResult { sessions }
    }

    pub fn create_session(
        &self,
        request: CreateTerminalSessionRequest,
    ) -> Result<TerminalSession, TerminalError> {
        let shell = resolve_shell(request.shell_kind.as_deref(), request.cwd.as_deref())?;
        let order = self.state.lock().expect("terminal state poisoned").sessions.len() as u32;
        let id_number = self.next_id.fetch_add(1, Ordering::SeqCst);
        let id = format!("term-{}-{}", Utc::now().timestamp_millis(), id_number);
        let now = now_iso();
        let name = request.name.unwrap_or_else(|| format!("Terminal {}", order + 1));

        let mut command = Command::new(&shell.command);
        command.args(&shell.args);
        if !shell.cwd.is_empty() && shell.kind != "wsl" {
            command.current_dir(&shell.cwd);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        let mut child = command.spawn().map_err(map_spawn_error)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| TerminalError::Other("terminal_stdin_unavailable".into()))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let session = TerminalSession {
            id: id.clone(),
            name,
            shell_kind: shell.kind,
            cwd: shell.cwd,
            status: "running".into(),
            created_at: now.clone(),
            updated_at: now,
            order,
            exit_code: None,
        };

        let record = TerminalRecord {
            session: session.clone(),
            child,
            stdin,
            events: Vec::new(),
            sequence: 0,
        };

        {
            let mut state = self.state.lock().expect("terminal state poisoned");
            state.sessions.insert(id.clone(), record);
            push_event_locked(&mut state, &id, "status", Some("running".into()), None);
        }

        if let Some(stdout) = stdout {
            spawn_reader_thread(Arc::clone(&self.state), id.clone(), stdout, "stdout");
        }
        if let Some(stderr) = stderr {
            spawn_reader_thread(Arc::clone(&self.state), id.clone(), stderr, "stderr");
        }

        Ok(session)
    }

    pub fn send_input(
        &self,
        session_id: &str,
        request: TerminalInputRequest,
    ) -> Result<TerminalSession, TerminalError> {
        let mut state = self.state.lock().expect("terminal state poisoned");
        let record = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| TerminalError::NotFound(session_id.to_string()))?;
        if record.session.status != "running" {
            return Err(TerminalError::Other("terminal_session_not_running".into()));
        }
        record.stdin.write_all(request.data.as_bytes())?;
        record.stdin.flush()?;
        record.session.updated_at = now_iso();
        Ok(record.session.clone())
    }

    pub fn resize_session(
        &self,
        session_id: &str,
        request: TerminalResizeRequest,
    ) -> Result<TerminalSession, TerminalError> {
        let mut state = self.state.lock().expect("terminal state poisoned");
        push_event_locked(
            &mut state,
            session_id,
            "status",
            Some(format!("resize accepted: {}x{}", request.cols, request.rows)),
            None,
        );
        let record = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| TerminalError::NotFound(session_id.to_string()))?;
        record.session.updated_at = now_iso();
        Ok(record.session.clone())
    }

    pub fn update_session(
        &self,
        session_id: &str,
        request: UpdateTerminalSessionRequest,
    ) -> Result<TerminalSession, TerminalError> {
        let mut state = self.state.lock().expect("terminal state poisoned");
        let record = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| TerminalError::NotFound(session_id.to_string()))?;
        if let Some(name) = request.name.map(|value| value.trim().to_string()) {
            if !name.is_empty() {
                record.session.name = name;
            }
        }
        if let Some(order) = request.order {
            record.session.order = order;
        }
        record.session.updated_at = now_iso();
        Ok(record.session.clone())
    }

    pub fn restart_session(&self, session_id: &str) -> Result<TerminalSession, TerminalError> {
        let previous = self.delete_session(session_id)?;
        self.create_session(CreateTerminalSessionRequest {
            name: Some(previous.name),
            shell_kind: Some(previous.shell_kind),
            cwd: Some(previous.cwd),
        })
    }

    pub fn delete_session(&self, session_id: &str) -> Result<TerminalSession, TerminalError> {
        let mut state = self.state.lock().expect("terminal state poisoned");
        let mut record = state
            .sessions
            .remove(session_id)
            .ok_or_else(|| TerminalError::NotFound(session_id.to_string()))?;
        let _ = record.child.kill();
        record.session.status = "exited".into();
        record.session.updated_at = now_iso();
        record.session.exit_code = record.session.exit_code.or(Some(0));
        Ok(record.session)
    }

    pub fn get_events(&self, session_id: Option<&str>, after: Option<u64>) -> TerminalEventsResult {
        let after = after.unwrap_or(0);
        let mut events = Vec::new();
        let state = self.state.lock().expect("terminal state poisoned");
        for record in state.sessions.values() {
            if session_id.is_some_and(|id| id != record.session.id) {
                continue;
            }
            events.extend(
                record
                    .events
                    .iter()
                    .filter(|event| event.sequence > after)
                    .cloned(),
            );
        }
        events.sort_by(|a, b| {
            a.session_id
                .cmp(&b.session_id)
                .then_with(|| a.sequence.cmp(&b.sequence))
        });
        TerminalEventsResult { events }
    }
}

fn spawn_reader_thread<R>(
    state: Arc<Mutex<TerminalState>>,
    session_id: String,
    mut reader: R,
    event_type: &'static str,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let mut state = state.lock().expect("terminal state poisoned");
                    push_event_locked(&mut state, &session_id, event_type, Some(text), None);
                }
                Err(err) => {
                    let mut state = state.lock().expect("terminal state poisoned");
                    push_event_locked(
                        &mut state,
                        &session_id,
                        "error",
                        Some(err.to_string()),
                        None,
                    );
                    break;
                }
            }
        }
    });
}

fn push_event_locked(
    state: &mut TerminalState,
    session_id: &str,
    event_type: &str,
    data: Option<String>,
    exit_code: Option<u32>,
) {
    if let Some(record) = state.sessions.get_mut(session_id) {
        record.sequence += 1;
        let event = TerminalEvent {
            id: format!("{}-event-{}", session_id, record.sequence),
            session_id: session_id.to_string(),
            sequence: record.sequence,
            r#type: event_type.to_string(),
            data,
            exit_code,
            timestamp: now_iso(),
        };
        record.events.push(event);
        if record.events.len() > MAX_EVENTS_PER_SESSION {
            let overflow = record.events.len() - MAX_EVENTS_PER_SESSION;
            record.events.drain(0..overflow);
        }
    }
}

fn terminal_capability() -> TerminalCapability {
    let shell = shell_environment_status();
    let shells = if shell.os == "windows" {
        if shell.wsl.as_ref().is_some_and(|wsl| wsl.installed) {
            vec!["wsl".into(), "powershell".into(), "cmd".into()]
        } else {
            vec!["powershell".into(), "cmd".into()]
        }
    } else if shell.os == "macos" {
        vec!["zsh".into(), "bash".into()]
    } else {
        vec!["bash".into(), "zsh".into()]
    };

    TerminalCapability {
        default_shell: shell.preferred_shell.clone(),
        shells,
        supports_pty: false,
        agent_uses_unix_commands: true,
        shell,
    }
}

fn shell_environment_status() -> ShellEnvironmentStatus {
    let os = host_os();
    let spec = resolve_shell(None, None);
    match spec {
        Ok(spec) => ShellEnvironmentStatus {
            os,
            preferred_shell: spec.kind,
            available: true,
            command: spec.command,
            args: spec.args,
            wsl: wsl_status(),
            problems: Vec::new(),
        },
        Err(TerminalError::WslMissing) => ShellEnvironmentStatus {
            os,
            preferred_shell: "wsl".into(),
            available: false,
            command: "wsl.exe".into(),
            args: Vec::new(),
            wsl: wsl_status(),
            problems: vec![ShellProblem {
                code: "wsl_missing".into(),
                message: "WSL is not available. Agent shell workflows expect Unix commands.".into(),
                fix_hint: Some("Install WSL, configure a default distro, then install Docker if agent tasks need containers.".into()),
            }],
        },
        Err(err) => ShellEnvironmentStatus {
            os,
            preferred_shell: default_shell_kind().into(),
            available: false,
            command: default_shell_command().into(),
            args: Vec::new(),
            wsl: wsl_status(),
            problems: vec![ShellProblem {
                code: "shell_unavailable".into(),
                message: err.to_string(),
                fix_hint: None,
            }],
        },
    }
}

fn resolve_shell(kind: Option<&str>, cwd: Option<&str>) -> Result<ShellSpec, TerminalError> {
    let requested = kind
        .map(str::to_string)
        .unwrap_or_else(|| default_shell_kind().to_string());
    let cwd = cwd
        .map(str::to_string)
        .unwrap_or_else(default_cwd_string);

    match requested.as_str() {
        "wsl" => {
            if !wsl_available() {
                return Err(TerminalError::WslMissing);
            }
            Ok(ShellSpec {
                kind: "wsl".into(),
                command: "wsl.exe".into(),
                args: Vec::new(),
                cwd,
            })
        }
        "powershell" => Ok(ShellSpec {
            kind: "powershell".into(),
            command: if cfg!(windows) { "powershell.exe" } else { "pwsh" }.into(),
            args: vec!["-NoLogo".into()],
            cwd,
        }),
        "cmd" => Ok(ShellSpec {
            kind: "cmd".into(),
            command: "cmd.exe".into(),
            args: Vec::new(),
            cwd,
        }),
        "zsh" => Ok(ShellSpec {
            kind: "zsh".into(),
            command: if cfg!(windows) { "wsl.exe" } else { "/bin/zsh" }.into(),
            args: if cfg!(windows) {
                vec!["--exec".into(), "zsh".into()]
            } else {
                Vec::new()
            },
            cwd,
        }),
        _ => Ok(ShellSpec {
            kind: "bash".into(),
            command: if cfg!(windows) { "wsl.exe" } else { "/bin/bash" }.into(),
            args: if cfg!(windows) {
                if !wsl_available() {
                    return Err(TerminalError::WslMissing);
                }
                vec!["--exec".into(), "bash".into()]
            } else {
                Vec::new()
            },
            cwd,
        }),
    }
}

fn map_spawn_error(err: std::io::Error) -> TerminalError {
    if cfg!(windows) && err.kind() == std::io::ErrorKind::NotFound {
        TerminalError::WslMissing
    } else {
        TerminalError::Other(err.to_string())
    }
}

fn wsl_available() -> bool {
    if !cfg!(windows) {
        return false;
    }
    Command::new("where")
        .arg("wsl.exe")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn wsl_status() -> Option<WslStatus> {
    if !cfg!(windows) {
        return None;
    }
    Some(WslStatus {
        installed: wsl_available(),
        default_distro: None,
        distros: Vec::new(),
        docker_available: None,
    })
}

fn host_os() -> String {
    match std::env::consts::OS {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "macos",
        _ => "other",
    }
    .into()
}

fn default_shell_kind() -> &'static str {
    if cfg!(windows) {
        if wsl_available() {
            "wsl"
        } else {
            "powershell"
        }
    } else if cfg!(target_os = "macos") {
        "zsh"
    } else {
        "bash"
    }
}

fn default_shell_command() -> &'static str {
    if cfg!(windows) {
        if wsl_available() {
            "wsl.exe"
        } else {
            "powershell.exe"
        }
    } else if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    }
}

fn default_cwd_string() -> String {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .replace('\\', "/")
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}
