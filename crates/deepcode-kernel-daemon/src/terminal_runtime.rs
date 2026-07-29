use crate::prelude::*;
use crate::*;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::BTreeMap;
use std::thread;
#[cfg(unix)]
use std::time::{Duration, Instant};

pub(crate) const DEFAULT_COLS: u16 = 120;
pub(crate) const DEFAULT_ROWS: u16 = 30;
const MAX_TERMINAL_EVENTS: usize = 2_000;
const HOST_TERMINAL_OWNER: &str = "deepcode-host-terminal";
#[cfg(unix)]
const TERMINAL_CHILD_GRACE_PERIOD: Duration = Duration::from_millis(500);

pub(crate) struct TerminalRuntime {
    sessions: BTreeMap<String, TerminalPtySession>,
}

struct TerminalPtySession {
    id: String,
    name: String,
    shell_kind: String,
    cwd: PathBuf,
    status: String,
    created_at: String,
    updated_at: String,
    order: usize,
    child: TerminalChildOwner,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    events: Arc<Mutex<Vec<Value>>>,
    next_sequence: Arc<Mutex<u64>>,
}

struct TerminalChildOwner {
    state: Arc<Mutex<TerminalChildState>>,
}

#[derive(Clone)]
struct TerminalChildObserver {
    state: Arc<Mutex<TerminalChildState>>,
}

struct TerminalChildState {
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    process_id: Option<u32>,
    #[cfg(unix)]
    process_group_id: Option<i32>,
    exit_code: Option<i32>,
}

struct TerminalSpawnRequest {
    id: String,
    name: Option<String>,
    requested_shell_kind: Option<String>,
    cwd: PathBuf,
    cols: Option<u16>,
    rows: Option<u16>,
    order: usize,
}

impl TerminalRuntime {
    pub(crate) fn new() -> Self {
        Self {
            sessions: BTreeMap::new(),
        }
    }

    pub(crate) fn capabilities(&self) -> Value {
        let shell = default_shell();
        json!({
            "defaultShell": shell.kind,
            "shells": available_shell_kinds(),
            "supportsPty": true,
            "agentUsesUnixCommands": !cfg!(windows),
            "shell": {
                "os": host_os_kind(),
                "preferredShell": shell.kind,
                "available": true,
                "command": shell.program,
                "args": shell.argv,
                "managedBy": HOST_TERMINAL_OWNER,
                "problems": []
            }
        })
    }

    pub(crate) fn warmup_status(&self) -> Value {
        let shell = default_shell();
        json!({
            "state": "ready",
            "defaultShell": shell.kind,
            "startedAt": null,
            "completedAt": now_text(),
            "message": "Host PTY terminal runtime is ready.",
            "problems": []
        })
    }

    pub(crate) fn create_session(
        &mut self,
        name: Option<String>,
        requested_shell_kind: Option<String>,
        cwd: PathBuf,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, String> {
        let id = format!("term-{}", now_millis());
        let order = self.sessions.len();
        self.spawn_session(TerminalSpawnRequest {
            id,
            name,
            requested_shell_kind,
            cwd,
            cols,
            rows,
            order,
        })
    }

    fn spawn_session(&mut self, request: TerminalSpawnRequest) -> Result<Value, String> {
        let TerminalSpawnRequest {
            id,
            name,
            requested_shell_kind,
            cwd,
            cols,
            rows,
            order,
        } = request;
        let now = now_text();
        let shell = shell_spec(requested_shell_kind.as_deref());
        let size = PtySize {
            rows: rows.unwrap_or(DEFAULT_ROWS).max(1),
            cols: cols.unwrap_or(DEFAULT_COLS).max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pty = native_pty_system()
            .openpty(size)
            .map_err(|error| format!("open pty: {error}"))?;
        let mut command = CommandBuilder::new(&shell.program);
        for arg in &shell.argv {
            command.arg(arg);
        }
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("DEEPCODE_TERMINAL", "1");

        let child = pty
            .slave
            .spawn_command(command)
            .map_err(|error| format!("spawn terminal shell {}: {error}", shell.program))?;
        let process_id = child.process_id();
        #[cfg(unix)]
        let process_group_id = pty
            .master
            .process_group_leader()
            .filter(|process_group_id| {
                u32::try_from(*process_group_id)
                    .ok()
                    .is_some_and(|process_group_id| Some(process_group_id) == process_id)
            });
        #[cfg(not(unix))]
        let process_group_id = None;
        let child = TerminalChildOwner::new(child, process_id, process_group_id);
        drop(pty.slave);
        let reader = pty
            .master
            .try_clone_reader()
            .map_err(|error| format!("clone pty reader: {error}"))?;
        let writer = pty
            .master
            .take_writer()
            .map_err(|error| format!("open pty writer: {error}"))?;
        let events = Arc::new(Mutex::new(Vec::new()));
        let next_sequence = Arc::new(Mutex::new(1_u64));
        push_terminal_event(
            &events,
            &next_sequence,
            &id,
            "ready",
            Some(format!("Terminal ready at {}", cwd.display())),
            None,
        );
        spawn_terminal_reader(
            id.clone(),
            reader,
            Arc::clone(&events),
            Arc::clone(&next_sequence),
            child.observer(),
        )?;

        let session = TerminalPtySession {
            id: id.clone(),
            name: name.unwrap_or_else(|| format!("终端 {}", order + 1)),
            shell_kind: shell.kind,
            cwd,
            status: "running".to_string(),
            created_at: now.clone(),
            updated_at: now,
            order,
            child,
            writer,
            master: pty.master,
            events,
            next_sequence,
        };
        let output = session.to_json();
        self.sessions.insert(id, session);
        Ok(output)
    }

    pub(crate) fn sessions_json(&mut self) -> Vec<Value> {
        let mut sessions = self.sessions.values_mut().collect::<Vec<_>>();
        sessions.sort_by_key(|session| session.order);
        sessions
            .into_iter()
            .map(|session| {
                session.refresh_status();
                session.to_json()
            })
            .collect()
    }

    pub(crate) fn input(&mut self, session_id: &str, data: &str) -> Result<Value, String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "terminal session not found".to_string())?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("write terminal input: {error}"))?;
        session
            .writer
            .flush()
            .map_err(|error| format!("flush terminal input: {error}"))?;
        session.updated_at = now_text();
        Ok(session.to_json())
    }

    pub(crate) fn resize(
        &mut self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Value, String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "terminal session not found".to_string())?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("resize terminal: {error}"))?;
        session.updated_at = now_text();
        Ok(session.to_json())
    }

    pub(crate) fn update(&mut self, session_id: &str, body: &Value) -> Result<Value, String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "terminal session not found".to_string())?;
        if let Some(name) = body.get("name").and_then(Value::as_str) {
            session.name = name.to_string();
        }
        if let Some(order) = body.get("order").and_then(Value::as_u64) {
            session.order = order as usize;
        }
        session.updated_at = now_text();
        Ok(session.to_json())
    }

    pub(crate) fn restart(&mut self, session_id: &str) -> Result<Value, String> {
        let mut session = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| "terminal session not found".to_string())?;
        let name = session.name.clone();
        let shell_kind = session.shell_kind.clone();
        let cwd = session.cwd.clone();
        let order = session.order;
        session.shutdown();
        drop(session);
        let session_json = self.spawn_session(TerminalSpawnRequest {
            id: session_id.to_string(),
            name: Some(name),
            requested_shell_kind: Some(shell_kind),
            cwd,
            cols: None,
            rows: None,
            order,
        })?;
        if let Some(session) = self.sessions.get(session_id) {
            push_terminal_event(
                &session.events,
                &session.next_sequence,
                session_id,
                "status",
                Some("Terminal restarted.".to_string()),
                None,
            );
        }
        Ok(session_json)
    }

    pub(crate) fn delete(&mut self, session_id: &str) -> Result<Value, String> {
        let Some(mut session) = self.sessions.remove(session_id) else {
            return Err("terminal session not found".to_string());
        };
        session.shutdown();
        Ok(session.to_json())
    }

    pub(crate) fn events(&self, session_id: &str, after: u64) -> Vec<Value> {
        self.sessions
            .get(session_id)
            .map(|session| {
                session
                    .events
                    .lock()
                    .expect("terminal events lock")
                    .iter()
                    .filter(|event| {
                        event
                            .get("sequence")
                            .and_then(Value::as_u64)
                            .map(|sequence| sequence > after)
                            .unwrap_or(false)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn shutdown_all(&mut self) {
        for (_, mut session) in std::mem::take(&mut self.sessions) {
            session.shutdown();
        }
    }
}

impl TerminalPtySession {
    fn refresh_status(&mut self) {
        if self.status != "running" {
            return;
        }
        if self.child.observe_exit().is_some() {
            self.status = "exited".to_string();
            self.updated_at = now_text();
        }
    }

    fn shutdown(&mut self) {
        self.child.terminate_and_wait();
        self.status = "exited".to_string();
        self.updated_at = now_text();
    }

    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "shellKind": self.shell_kind,
            "cwd": self.cwd.to_string_lossy(),
            "status": self.status,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "order": self.order,
            "owner": HOST_TERMINAL_OWNER,
            "exitCode": self.child.exit_code()
        })
    }
}

impl TerminalChildOwner {
    fn new(
        child: Box<dyn portable_pty::Child + Send + Sync>,
        process_id: Option<u32>,
        process_group_id: Option<i32>,
    ) -> Self {
        #[cfg(not(unix))]
        let _ = process_group_id;
        Self {
            state: Arc::new(Mutex::new(TerminalChildState {
                child: Some(child),
                process_id,
                #[cfg(unix)]
                process_group_id,
                exit_code: None,
            })),
        }
    }

    fn observer(&self) -> TerminalChildObserver {
        TerminalChildObserver {
            state: Arc::clone(&self.state),
        }
    }

    fn observe_exit(&self) -> Option<i32> {
        observe_terminal_child_exit(&self.state)
    }

    fn exit_code(&self) -> Option<i32> {
        lock_terminal_child_state(&self.state).exit_code
    }

    fn terminate_and_wait(&mut self) -> Option<i32> {
        #[cfg(unix)]
        let (child, process_id, process_group_id) = {
            let mut state = lock_terminal_child_state(&self.state);
            let child = state.child.take();
            let process_id = state.process_id.take();
            let process_group_id = state.process_group_id.take();
            (child, process_id, process_group_id)
        };
        #[cfg(not(unix))]
        let (child, process_id) = {
            let mut state = lock_terminal_child_state(&self.state);
            (state.child.take(), state.process_id.take())
        };

        #[cfg(unix)]
        let exit_code = terminate_owned_unix_process_group(child, process_id, process_group_id);
        #[cfg(not(unix))]
        let exit_code = terminate_owned_child(child, process_id);

        let mut state = lock_terminal_child_state(&self.state);
        if exit_code.is_some() {
            state.exit_code = exit_code;
        }
        state.exit_code
    }
}

impl Drop for TerminalChildOwner {
    fn drop(&mut self) {
        self.terminate_and_wait();
    }
}

impl TerminalChildObserver {
    fn observe_exit(&self) -> Option<i32> {
        observe_terminal_child_exit(&self.state)
    }
}

fn lock_terminal_child_state(
    state: &Arc<Mutex<TerminalChildState>>,
) -> std::sync::MutexGuard<'_, TerminalChildState> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn observe_terminal_child_exit(state: &Arc<Mutex<TerminalChildState>>) -> Option<i32> {
    let mut state = lock_terminal_child_state(state);
    let exit_code = match state.child.as_mut() {
        Some(child) => child
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.exit_code() as i32),
        None => return state.exit_code,
    };
    if let Some(exit_code) = exit_code {
        state.exit_code = Some(exit_code);
        state.child.take();
    }
    state.exit_code
}

#[cfg(unix)]
fn terminate_owned_unix_process_group(
    mut child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    process_id: Option<u32>,
    process_group_id: Option<i32>,
) -> Option<i32> {
    let Some(process_group_id) = process_group_id.filter(|process_group_id| {
        u32::try_from(*process_group_id)
            .ok()
            .is_some_and(|process_group_id| Some(process_group_id) == process_id)
    }) else {
        return terminate_owned_child(child, process_id);
    };

    signal_owned_unix_process_group(process_group_id, UNIX_SIGHUP);
    signal_owned_unix_process_group(process_group_id, UNIX_SIGTERM);

    let exit_code = child
        .as_mut()
        .and_then(|child| wait_for_terminal_child(child.as_mut(), TERMINAL_CHILD_GRACE_PERIOD));

    signal_owned_unix_process_group(process_group_id, UNIX_SIGKILL);
    if exit_code.is_some() {
        return exit_code;
    }

    let Some(mut child) = child else {
        return None;
    };
    let _ = child.kill();
    child.wait().ok().map(|status| status.exit_code() as i32)
}

fn terminate_owned_child(
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    _process_id: Option<u32>,
) -> Option<i32> {
    let Some(mut child) = child else {
        return None;
    };
    let _ = child.kill();
    child.wait().ok().map(|status| status.exit_code() as i32)
}

#[cfg(unix)]
fn wait_for_terminal_child(child: &mut dyn portable_pty::Child, timeout: Duration) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().ok().flatten() {
            return Some(status.exit_code() as i32);
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn signal_owned_unix_process_group(process_group_id: i32, signal: i32) {
    if process_group_id <= 0 {
        return;
    }
    unsafe {
        let _ = deepcode_unix_kill(-process_group_id, signal);
    }
}

#[cfg(unix)]
const UNIX_SIGHUP: i32 = 1;
#[cfg(unix)]
const UNIX_SIGKILL: i32 = 9;
#[cfg(unix)]
const UNIX_SIGTERM: i32 = 15;

#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "kill"]
    fn deepcode_unix_kill(process_id: i32, signal: i32) -> i32;
}

#[derive(Clone)]
struct ShellSpec {
    kind: String,
    program: String,
    argv: Vec<String>,
}

pub(crate) fn shell_summary() -> Value {
    let shell = default_shell();
    json!({
        "os": host_os_kind(),
        "preferredShell": shell.kind,
        "agentUsesUnixCommands": !cfg!(windows),
        "problems": []
    })
}

fn spawn_terminal_reader(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    events: Arc<Mutex<Vec<Value>>>,
    next_sequence: Arc<Mutex<u64>>,
    child: TerminalChildObserver,
) -> Result<(), String> {
    thread::Builder::new()
        .name(format!("terminal-reader-{session_id}"))
        .spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let code = child.observe_exit();
                        push_terminal_event(
                            &events,
                            &next_sequence,
                            &session_id,
                            "exit",
                            None,
                            code,
                        );
                        break;
                    }
                    Ok(read) => {
                        let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                        push_terminal_event(
                            &events,
                            &next_sequence,
                            &session_id,
                            "stdout",
                            Some(text),
                            None,
                        );
                    }
                    Err(error) => {
                        push_terminal_event(
                            &events,
                            &next_sequence,
                            &session_id,
                            "error",
                            Some(format!("read terminal output: {error}")),
                            None,
                        );
                        break;
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("spawn terminal reader: {error}"))
}

fn push_terminal_event(
    events: &Arc<Mutex<Vec<Value>>>,
    next_sequence: &Arc<Mutex<u64>>,
    session_id: &str,
    event_type: &str,
    data: Option<String>,
    exit_code: Option<i32>,
) {
    let sequence = {
        let mut guard = next_sequence.lock().expect("terminal sequence lock");
        let sequence = *guard;
        *guard += 1;
        sequence
    };
    let mut event = json!({
        "id": format!("evt-{session_id}-{sequence}"),
        "sessionId": session_id,
        "sequence": sequence,
        "type": event_type,
        "timestamp": now_text()
    });
    if let Some(data) = data {
        event["data"] = json!(data);
    }
    if let Some(exit_code) = exit_code {
        event["exitCode"] = json!(exit_code);
    }
    let mut guard = events.lock().expect("terminal events lock");
    guard.push(event);
    if guard.len() > MAX_TERMINAL_EVENTS {
        let overflow = guard.len() - MAX_TERMINAL_EVENTS;
        guard.drain(0..overflow);
    }
}

fn host_os_kind() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

fn available_shell_kinds() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["powershell", "cmd", "wsl"]
    } else {
        vec!["bash", "zsh"]
    }
}

fn default_shell() -> ShellSpec {
    if cfg!(windows) {
        return ShellSpec {
            kind: "powershell".to_string(),
            program: "powershell.exe".to_string(),
            argv: Vec::new(),
        };
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if FsPath::new("/bin/zsh").exists() {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        });
    let kind = if shell.ends_with("zsh") {
        "zsh"
    } else {
        "bash"
    };
    ShellSpec {
        kind: kind.to_string(),
        program: shell,
        argv: Vec::new(),
    }
}

fn shell_spec(requested: Option<&str>) -> ShellSpec {
    match requested.unwrap_or_default() {
        "zsh" if !cfg!(windows) => ShellSpec {
            kind: "zsh".to_string(),
            program: if FsPath::new("/bin/zsh").exists() {
                "/bin/zsh".to_string()
            } else {
                "zsh".to_string()
            },
            argv: Vec::new(),
        },
        "bash" if !cfg!(windows) => ShellSpec {
            kind: "bash".to_string(),
            program: if FsPath::new("/bin/bash").exists() {
                "/bin/bash".to_string()
            } else {
                "bash".to_string()
            },
            argv: Vec::new(),
        },
        "cmd" if cfg!(windows) => ShellSpec {
            kind: "cmd".to_string(),
            program: "cmd.exe".to_string(),
            argv: Vec::new(),
        },
        "wsl" if cfg!(windows) => ShellSpec {
            kind: "wsl".to_string(),
            program: "wsl.exe".to_string(),
            argv: Vec::new(),
        },
        "powershell" if cfg!(windows) => ShellSpec {
            kind: "powershell".to_string(),
            program: "powershell.exe".to_string(),
            argv: Vec::new(),
        },
        _ => default_shell(),
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn pty_runtime_accepts_input_resize_restart_and_delete() {
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let mut runtime = TerminalRuntime::new();
        let session = runtime
            .create_session(
                Some("test terminal".to_string()),
                Some("bash".to_string()),
                cwd.clone(),
                Some(100),
                Some(24),
            )
            .expect("create terminal session");
        let session_id = session["id"].as_str().expect("session id").to_string();
        assert_eq!(
            session["cwd"].as_str(),
            Some(cwd.to_string_lossy().as_ref())
        );
        assert_eq!(session["owner"].as_str(), Some(HOST_TERMINAL_OWNER));

        runtime
            .resize(&session_id, 80, 20)
            .expect("resize terminal session");
        runtime
            .input(&session_id, "printf __DEEPCODE_TERMINAL_OK__\\n\n")
            .expect("send terminal input");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut saw_marker = false;
        while Instant::now() < deadline {
            saw_marker = runtime.events(&session_id, 0).iter().any(|event| {
                event
                    .get("data")
                    .and_then(Value::as_str)
                    .map(|data| data.contains("__DEEPCODE_TERMINAL_OK__"))
                    .unwrap_or(false)
            });
            if saw_marker {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(saw_marker, "expected PTY output marker");

        let restarted = runtime
            .restart(&session_id)
            .expect("restart terminal session");
        assert_eq!(restarted["id"].as_str(), Some(session_id.as_str()));
        assert_eq!(restarted["owner"].as_str(), Some(HOST_TERMINAL_OWNER));
        let deleted = runtime
            .delete(&session_id)
            .expect("delete terminal session");
        assert_eq!(deleted["status"].as_str(), Some("exited"));
        assert_eq!(deleted["owner"].as_str(), Some(HOST_TERMINAL_OWNER));
        assert!(
            deleted["exitCode"].is_i64() || deleted["exitCode"].is_u64(),
            "delete must synchronously terminate and wait for the owned child"
        );
        assert!(runtime.sessions_json().is_empty());
        assert!(runtime.events(&session_id, 0).is_empty());
    }
}
