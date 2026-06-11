use crate::prelude::*;
use crate::*;
use deepcode_kernel_ledger::{
    KernelResource, KernelResourceCleanupPolicy, KernelResourceKind, KernelResourceOwner,
    KernelResourceRegistry, KernelResourceScope,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::BTreeMap;
use std::thread;

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 30;
const MAX_TERMINAL_EVENTS: usize = 2_000;

pub(crate) struct TerminalRuntime {
    sessions: BTreeMap<String, TerminalPtySession>,
    resources: KernelResourceRegistry,
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
    owner: KernelResourceOwner,
    exit_code: Arc<Mutex<Option<i32>>>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    events: Arc<Mutex<Vec<Value>>>,
    next_sequence: Arc<Mutex<u64>>,
}

impl TerminalRuntime {
    pub(crate) fn new() -> Self {
        Self {
            sessions: BTreeMap::new(),
            resources: KernelResourceRegistry::new(),
        }
    }

    fn capabilities(&self) -> Value {
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
                "command": shell.command,
                "args": shell.args,
                "managedBy": "deepcode-kernel",
                "problems": []
            }
        })
    }

    fn warmup_status(&self) -> Value {
        let shell = default_shell();
        json!({
            "state": "ready",
            "defaultShell": shell.kind,
            "startedAt": null,
            "completedAt": now_text(),
            "message": "Kernel PTY terminal runtime is ready.",
            "problems": []
        })
    }

    fn create_session(
        &mut self,
        name: Option<String>,
        requested_shell_kind: Option<String>,
        cwd: PathBuf,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, String> {
        let id = format!("term-{}", now_millis());
        let order = self.sessions.len();
        let owner = KernelResourceOwner::user_session(id.clone());
        self.spawn_session(
            id,
            name,
            requested_shell_kind,
            cwd,
            cols,
            rows,
            order,
            owner,
        )
    }

    fn spawn_session(
        &mut self,
        id: String,
        name: Option<String>,
        requested_shell_kind: Option<String>,
        cwd: PathBuf,
        cols: Option<u16>,
        rows: Option<u16>,
        order: usize,
        owner: KernelResourceOwner,
    ) -> Result<Value, String> {
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
        let mut command = CommandBuilder::new(&shell.command);
        for arg in &shell.args {
            command.arg(arg);
        }
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("DEEPCODE_TERMINAL", "1");

        let child = pty
            .slave
            .spawn_command(command)
            .map_err(|error| format!("spawn terminal shell {}: {error}", shell.command))?;
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
        let exit_code = Arc::new(Mutex::new(None));
        push_terminal_event(
            &events,
            &next_sequence,
            &id,
            "ready",
            Some(format!("Terminal ready at {}", cwd.display())),
            None,
        );
        let child = Arc::new(Mutex::new(child));
        spawn_terminal_reader(
            id.clone(),
            reader,
            Arc::clone(&events),
            Arc::clone(&next_sequence),
            Arc::clone(&child),
            Arc::clone(&exit_code),
        );

        let session = TerminalPtySession {
            id: id.clone(),
            name: name.unwrap_or_else(|| format!("终端 {}", order + 1)),
            shell_kind: shell.kind,
            cwd,
            status: "running".to_string(),
            created_at: now.clone(),
            updated_at: now,
            order,
            owner: owner.clone(),
            exit_code,
            writer,
            master: pty.master,
            child,
            events,
            next_sequence,
        };
        let output = session.to_json();
        self.resources
            .register(KernelResource::active(
                id.clone(),
                KernelResourceKind::TerminalSession,
                owner,
                KernelResourceScope::Session,
                KernelResourceCleanupPolicy::OnSessionEnd,
                serde_json::json!({
                    "terminalId": &id,
                    "cwd": session.cwd.to_string_lossy(),
                    "shellKind": &session.shell_kind,
                    "managedBy": "deepcode-kernel-terminal-runtime"
                }),
            ))
            .map_err(|error| format!("register terminal resource: {error}"))?;
        self.sessions.insert(id, session);
        Ok(output)
    }

    fn sessions_json(&mut self) -> Vec<Value> {
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

    fn input(&mut self, session_id: &str, data: &str) -> Result<Value, String> {
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

    fn resize(&mut self, session_id: &str, cols: u16, rows: u16) -> Result<Value, String> {
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

    fn update(&mut self, session_id: &str, body: &Value) -> Result<Value, String> {
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

    fn restart(&mut self, session_id: &str) -> Result<Value, String> {
        let (name, shell_kind, cwd, order, owner) = {
            let session = self
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| "terminal session not found".to_string())?;
            kill_child(&session.child);
            (
                session.name.clone(),
                session.shell_kind.clone(),
                session.cwd.clone(),
                session.order,
                session.owner.clone(),
            )
        };
        self.sessions.remove(session_id);
        let session_json = self.spawn_session(
            session_id.to_string(),
            Some(name),
            Some(shell_kind),
            cwd,
            None,
            None,
            order,
            owner,
        )?;
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

    fn delete(&mut self, session_id: &str) -> Result<Value, String> {
        let Some(session) = self.sessions.remove(session_id) else {
            return Err("terminal session not found".to_string());
        };
        kill_child(&session.child);
        let _ = self.resources.release(session_id);
        Ok(session.to_json())
    }

    fn events(&self, session_id: &str, after: u64) -> Vec<Value> {
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
}

impl Drop for TerminalRuntime {
    fn drop(&mut self) {
        for session in self.sessions.values() {
            let _ = self.resources.release(&session.id);
            kill_child(&session.child);
        }
    }
}

impl Drop for TerminalPtySession {
    fn drop(&mut self) {
        kill_child(&self.child);
    }
}

impl TerminalPtySession {
    fn refresh_status(&mut self) {
        if self.status != "running" {
            return;
        }
        if let Ok(mut child) = self.child.lock() {
            if let Ok(Some(status)) = child.try_wait() {
                self.status = "exited".to_string();
                self.updated_at = now_text();
                *self.exit_code.lock().expect("terminal exit code lock") =
                    Some(status.exit_code() as i32);
            }
        }
    }

    fn to_json(&self) -> Value {
        let exit_code = *self.exit_code.lock().expect("terminal exit code lock");
        json!({
            "id": self.id,
            "name": self.name,
            "shellKind": self.shell_kind,
            "cwd": self.cwd.to_string_lossy(),
            "status": self.status,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "order": self.order,
            "owner": &self.owner,
            "exitCode": exit_code
        })
    }
}

#[derive(Clone)]
struct ShellSpec {
    kind: String,
    command: String,
    args: Vec<String>,
}

pub(crate) async fn runtime_shell() -> Json<ApiResponse> {
    let shell = default_shell();
    ApiResponse::ok(json!({
        "os": host_os_kind(),
        "preferredShell": shell.kind,
        "agentUsesUnixCommands": !cfg!(windows),
        "problems": []
    }))
}

pub(crate) async fn terminal_capabilities(State(state): State<AppState>) -> Json<ApiResponse> {
    let runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    ApiResponse::ok(runtime.capabilities())
}

pub(crate) async fn terminal_warmup(State(state): State<AppState>) -> Json<ApiResponse> {
    let runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    ApiResponse::ok(runtime.warmup_status())
}

pub(crate) async fn terminal_sessions(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    ApiResponse::ok(json!({ "sessions": runtime.sessions_json() }))
}

pub(crate) async fn terminal_create_session(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let cwd = match terminal_cwd(&state, body.get("cwd").and_then(Value::as_str)) {
        Ok(cwd) => cwd,
        Err(message) => return ApiResponse::error("terminal_cwd_invalid", message),
    };
    let mut runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    match runtime.create_session(
        body.get("name").and_then(Value::as_str).map(str::to_string),
        body.get("shellKind")
            .and_then(Value::as_str)
            .map(str::to_string),
        cwd,
        body.get("cols")
            .and_then(Value::as_u64)
            .map(|value| value as u16),
        body.get("rows")
            .and_then(Value::as_u64)
            .map(|value| value as u16),
    ) {
        Ok(session) => ApiResponse::ok(session),
        Err(message) => ApiResponse::error("terminal_spawn_failed", message),
    }
}

pub(crate) async fn terminal_input(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let data = body.get("data").and_then(Value::as_str).unwrap_or_default();
    let mut runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    match runtime.input(&session_id, data) {
        Ok(session) => ApiResponse::ok(session),
        Err(message) => ApiResponse::error("terminal_input_failed", message),
    }
}

pub(crate) async fn terminal_resize(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let cols = body
        .get("cols")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_COLS as u64) as u16;
    let rows = body
        .get("rows")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_ROWS as u64) as u16;
    let mut runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    match runtime.resize(&session_id, cols, rows) {
        Ok(session) => ApiResponse::ok(session),
        Err(message) => ApiResponse::error("terminal_resize_failed", message),
    }
}

pub(crate) async fn terminal_update(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    match runtime.update(&session_id, &body) {
        Ok(session) => ApiResponse::ok(session),
        Err(message) => ApiResponse::error("terminal_not_found", message),
    }
}

pub(crate) async fn terminal_restart(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let mut runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    match runtime.restart(&session_id) {
        Ok(session) => ApiResponse::ok(session),
        Err(message) => ApiResponse::error("terminal_restart_failed", message),
    }
}

pub(crate) async fn terminal_delete(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let mut runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    match runtime.delete(&session_id) {
        Ok(session) => ApiResponse::ok(session),
        Err(message) => ApiResponse::error("terminal_not_found", message),
    }
}

pub(crate) async fn terminal_events(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<ApiResponse> {
    let session_id = query
        .get("sessionId")
        .map(String::as_str)
        .unwrap_or_default();
    let after = query
        .get("after")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let runtime = state
        .terminal_runtime
        .lock()
        .expect("terminal runtime lock");
    ApiResponse::ok(json!({ "events": runtime.events(session_id, after) }))
}

fn terminal_cwd(state: &AppState, requested: Option<&str>) -> Result<PathBuf, String> {
    let root = active_workspace_root(state)?;
    let candidate = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("canonicalize terminal cwd {}: {error}", candidate.display()))?;
    if !canonical.starts_with(&root) {
        return Err(format!(
            "terminal cwd {} is outside workspace root {}",
            canonical.display(),
            root.display()
        ));
    }
    if !canonical.is_dir() {
        return Err(format!(
            "terminal cwd {} is not a directory",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn active_workspace_root(state: &AppState) -> Result<PathBuf, String> {
    let current = current_workspace_json(&state.runtime).map_err(|error| error.message)?;
    let root = current
        .get("current")
        .and_then(|workspace| workspace.get("folders"))
        .and_then(Value::as_array)
        .and_then(|folders| folders.first())
        .and_then(|folder| folder.get("absolutePath"))
        .and_then(Value::as_str)
        .ok_or_else(|| "current workspace is missing".to_string())?;
    PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("canonicalize workspace root {root}: {error}"))
}

fn spawn_terminal_reader(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    events: Arc<Mutex<Vec<Value>>>,
    next_sequence: Arc<Mutex<u64>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    exit_code: Arc<Mutex<Option<i32>>>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let code = if let Ok(mut child) = child.lock() {
                        child
                            .try_wait()
                            .ok()
                            .flatten()
                            .map(|status| status.exit_code() as i32)
                    } else {
                        None
                    };
                    if let Some(code) = code {
                        *exit_code.lock().expect("terminal exit code lock") = Some(code);
                    }
                    push_terminal_event(&events, &next_sequence, &session_id, "exit", None, code);
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
    });
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

fn kill_child(child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
        let _ = child.wait();
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
            command: "powershell.exe".to_string(),
            args: Vec::new(),
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
        command: shell,
        args: Vec::new(),
    }
}

fn shell_spec(requested: Option<&str>) -> ShellSpec {
    match requested.unwrap_or_default() {
        "zsh" if !cfg!(windows) => ShellSpec {
            kind: "zsh".to_string(),
            command: if FsPath::new("/bin/zsh").exists() {
                "/bin/zsh".to_string()
            } else {
                "zsh".to_string()
            },
            args: Vec::new(),
        },
        "bash" if !cfg!(windows) => ShellSpec {
            kind: "bash".to_string(),
            command: if FsPath::new("/bin/bash").exists() {
                "/bin/bash".to_string()
            } else {
                "bash".to_string()
            },
            args: Vec::new(),
        },
        "cmd" if cfg!(windows) => ShellSpec {
            kind: "cmd".to_string(),
            command: "cmd.exe".to_string(),
            args: Vec::new(),
        },
        "wsl" if cfg!(windows) => ShellSpec {
            kind: "wsl".to_string(),
            command: "wsl.exe".to_string(),
            args: Vec::new(),
        },
        "powershell" if cfg!(windows) => ShellSpec {
            kind: "powershell".to_string(),
            command: "powershell.exe".to_string(),
            args: Vec::new(),
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
        let resource = runtime
            .resources
            .get(&session_id)
            .expect("terminal resource");
        assert_eq!(resource.kind, KernelResourceKind::TerminalSession);
        assert_eq!(
            resource.owner.kind,
            deepcode_kernel_ledger::KernelResourceOwnerKind::UserSession
        );

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
        runtime
            .delete(&session_id)
            .expect("delete terminal session");
        assert!(runtime.sessions_json().is_empty());
        assert_eq!(
            runtime.resources.get(&session_id).unwrap().state,
            deepcode_kernel_ledger::KernelResourceState::Released
        );
    }
}
