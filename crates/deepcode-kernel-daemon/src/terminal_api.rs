use crate::prelude::*;
use crate::terminal_runtime::{shell_summary, DEFAULT_COLS, DEFAULT_ROWS};
use crate::*;

pub(crate) use crate::terminal_runtime::TerminalRuntime;

pub(crate) async fn runtime_shell() -> Json<ApiResponse> {
    ApiResponse::ok(shell_summary())
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
    let current = current_workspace(&state.runtime).map_err(|error| error.message)?;
    let root = current
        .current
        .as_ref()
        .and_then(|workspace| workspace.folders.first())
        .map(|folder| folder.absolute_path.as_str())
        .ok_or_else(|| "current workspace is missing".to_string())?;
    PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("canonicalize workspace root {root}: {error}"))
}
