#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

pub(crate) async fn runtime_shell() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "os": std::env::consts::OS,
        "preferredShell": "bash",
        "agentUsesUnixCommands": true,
        "problems": []
    }))
}

pub(crate) async fn terminal_capabilities() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "defaultShell": "bash",
        "shells": ["bash"],
        "supportsPty": false,
        "agentUsesUnixCommands": true,
        "shell": {
            "os": std::env::consts::OS,
            "preferredShell": "bash",
            "available": false,
            "command": "bash",
            "args": [],
            "managedBy": "deepcode-kernel",
            "problems": [{
                "code": "terminal_runtime_reserved",
                "message": "Interactive terminal sessions are reserved until Kernel PTY runtime lands."
            }]
        }
    }))
}

pub(crate) async fn terminal_warmup() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "state": "ready",
        "defaultShell": "bash",
        "startedAt": null,
        "completedAt": now_text(),
        "message": "Kernel host is ready; interactive PTY is reserved.",
        "problems": []
    }))
}

pub(crate) async fn terminal_sessions(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({ "sessions": gui.terminals }))
}

pub(crate) async fn terminal_create_session(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let id = format!("term-{}", now_millis());
    let now = now_text();
    let session = json!({
        "id": id,
        "name": body.get("name").and_then(Value::as_str).unwrap_or("终端 1"),
        "shellKind": body.get("shellKind").and_then(Value::as_str).unwrap_or("bash"),
        "cwd": body.get("cwd").and_then(Value::as_str).unwrap_or("."),
        "status": "running",
        "createdAt": now,
        "updatedAt": now,
        "order": gui.terminals.len()
    });
    gui.terminal_events.insert(
        id.clone(),
        vec![json!({
            "id": format!("evt-{id}-ready"),
            "sessionId": id,
            "sequence": 1,
            "type": "ready",
            "data": "Kernel terminal placeholder ready.",
            "timestamp": now_text()
        })],
    );
    gui.terminals.push(session.clone());
    ApiResponse::ok(session)
}

pub(crate) async fn terminal_input(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let events = gui.terminal_events.entry(session_id.clone()).or_default();
    let sequence = events.len() + 1;
    events.push(json!({
        "id": format!("evt-{session_id}-{sequence}"),
        "sessionId": session_id,
        "sequence": sequence,
        "type": "stdout",
        "data": format!("terminal runtime reserved; received input: {}", body.get("data").and_then(Value::as_str).unwrap_or("")),
        "timestamp": now_text()
    }));
    terminal_session_by_id(&gui, &session_id)
}

pub(crate) async fn terminal_resize(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    terminal_session_by_id(&gui, &session_id)
}

pub(crate) async fn terminal_update(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(session) = gui
        .terminals
        .iter_mut()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id.as_str()))
    {
        if let Some(name) = body.get("name").and_then(Value::as_str) {
            session["name"] = json!(name);
        }
        session["updatedAt"] = json!(now_text());
        return ApiResponse::ok(session.clone());
    }
    ApiResponse::error("terminal_not_found", "terminal session not found")
}

pub(crate) async fn terminal_restart(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    terminal_session_by_id(&gui, &session_id)
}

pub(crate) async fn terminal_delete(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let mut deleted = None;
    gui.terminals.retain(|session| {
        if session.get("id").and_then(Value::as_str) == Some(session_id.as_str()) {
            deleted = Some(session.clone());
            false
        } else {
            true
        }
    });
    gui.terminal_events.remove(&session_id);
    deleted
        .map(ApiResponse::ok)
        .unwrap_or_else(|| ApiResponse::error("terminal_not_found", "terminal session not found"))
}

pub(crate) async fn terminal_events(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    let events = query
        .get("sessionId")
        .and_then(|session_id| gui.terminal_events.get(session_id))
        .cloned()
        .unwrap_or_default();
    ApiResponse::ok(json!({ "events": events }))
}
