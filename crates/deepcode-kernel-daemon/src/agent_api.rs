#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolExecuteRequest {
    pub(crate) workspace_binding: Option<WorkspaceBinding>,
    pub(crate) tool_call: ToolCallRequest,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCallRequest {
    pub(crate) id: Option<String>,
    pub(crate) name: String,
    pub(crate) arguments: Value,
}

pub(crate) async fn agent_sessions_list(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
    ApiResponse::ok(json!({
        "sessions": gui.sessions,
        "currentSessionId": gui.current_session_id
    }))
}

pub(crate) async fn agent_session_create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let id = format!("session-{}", now_millis());
    let now = now_text();
    let mode = body
        .get("mode")
        .or_else(|| body.get("initialMode"))
        .and_then(Value::as_str)
        .unwrap_or("plan");
    let session = create_agent_session_value(
        &id,
        &now,
        body.get("title")
            .and_then(Value::as_str)
            .unwrap_or("New Agent Session"),
        mode,
        body.get("profileId").and_then(Value::as_str),
        body.get("workspaceId").and_then(Value::as_str),
        body.get("workspaceHash").and_then(Value::as_str),
    );
    gui.current_session_id = Some(id.clone());
    gui.session_projection_cache.insert(id.clone(), Vec::new());
    gui.trace_events.insert(id.clone(), Vec::new());
    gui.sessions.insert(0, session.clone());
    ApiResponse::ok(json!({ "session": session, "events": [] }))
}

pub(crate) async fn agent_session_current(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
    let Some(session_id) = gui.current_session_id.as_ref() else {
        return ApiResponse::ok(Value::Null);
    };
    session_result(&gui, session_id)
}

pub(crate) async fn agent_session_activate(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if has_session(&gui, &session_id) {
        gui.current_session_id = Some(session_id.clone());
        refresh_pending_session_titles(&mut gui);
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

pub(crate) async fn agent_session_rename(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if let Some(title) = body.get("title").and_then(Value::as_str) {
            session["title"] = json!(title);
            session["titleSource"] = json!("user");
        }
        session["updatedAt"] = json!(now_text());
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

pub(crate) async fn agent_session_archive(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let should_archive = body
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let was_current = gui.current_session_id.as_deref() == Some(session_id.as_str());
    let mut replacement_scope: Option<(Option<String>, Option<String>, Option<String>)> = None;
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if should_archive {
            if was_current {
                replacement_scope = Some((
                    session
                        .get("profileId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    session
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    session
                        .get("workspaceHash")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                ));
            }
            session["archivedAt"] = json!(now_text());
        } else {
            session
                .as_object_mut()
                .map(|object| object.remove("archivedAt"));
        }
    }
    if should_archive && was_current {
        ensure_current_agent_session(&mut gui, replacement_scope);
    }
    ApiResponse::ok(json!({
        "sessions": gui.sessions,
        "currentSessionId": gui.current_session_id
    }))
}

pub(crate) async fn agent_session_append_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let incoming = body
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    gui.session_projection_cache
        .entry(session_id.clone())
        .or_default()
        .extend(incoming);
    refresh_pending_session_titles(&mut gui);
    update_session_event_count(&mut gui, &session_id);
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_send_message(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let request = build_agent_run_request(&body);
    {
        let mut gui = state.gui.lock().expect("gui state lock");
        if !has_session(&gui, &session_id) {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        }
        maybe_auto_title_session(&mut gui, &session_id, &request.content);
    }

    let user_event = agent_event(
        &session_id,
        "user_msg",
        json!({
            "content": request.content,
            "attachments": body.get("attachments").cloned().unwrap_or_else(|| json!([])),
            "channel": "user",
            "visibility": "conversation"
        }),
        &now_text(),
    );
    append_session_projection(&state, &session_id, vec![user_event]);

    if let Err(error) = start_kernel_agent_run(&state, &session_id, request).await {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "error",
                json!({
                    "message": error,
                    "channel": "error",
                    "visibility": "conversation"
                }),
                &now_text(),
            )],
        );
    }

    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_cancel(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_trace(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    let events = gui
        .trace_events
        .get(&session_id)
        .cloned()
        .unwrap_or_default();
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "trace": {
            "sessionId": session_id,
            "events": events,
            "eventCount": events.len(),
            "updatedAt": now_text()
        }
    }))
}

pub(crate) async fn agent_permission_resolve(
    State(state): State<AppState>,
    Path(permission_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let decision = body
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("reject")
        .to_string();
    let kernel_decision = if decision == "accept" {
        deepcode_kernel_abi::PermissionDecisionKind::Accept
    } else {
        deepcode_kernel_abi::PermissionDecisionKind::Reject
    };
    let kernel_events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::PermissionResolve {
                request_id: rid("agent-permission-resolve"),
                permission_id: permission_id.clone(),
                decision: kernel_decision,
            })
            .unwrap_or_else(|error| {
                vec![KernelEvent::Error {
                    request_id: Some(rid("agent-permission-resolve")),
                    run_id: None,
                    session_id: None,
                    error: KernelErrorEnvelope::from(&error),
                    message_key: None,
                    args: None,
                }]
            })
    };
    let session_id = kernel_events
        .iter()
        .find_map(kernel_event_session_id)
        .or_else(|| {
            state
                .gui
                .lock()
                .expect("gui state lock")
                .current_session_id
                .clone()
        })
        .unwrap_or_else(|| "session-unknown".to_string());
    if let Err(error) = drive_kernel_agent_loop(&state, &session_id, kernel_events).await {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "error",
                json!({
                    "message": error,
                    "channel": "error",
                    "visibility": "conversation"
                }),
                &now_text(),
            )],
        );
    }
    let gui = state.gui.lock().expect("gui state lock");
    if gui
        .sessions
        .iter()
        .any(|session| session.get("id").and_then(Value::as_str) == Some(session_id.as_str()))
    {
        session_result(&gui, &session_id)
    } else {
        ApiResponse::ok(json!({
            "sessionId": session_id,
            "events": gui
                .session_projection_cache
                .get(&session_id)
                .cloned()
                .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, &session_id))
        }))
    }
}

pub(crate) async fn agent_feedback() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "accepted": true,
        "message": "Feedback recorded by host compatibility layer."
    }))
}

pub(crate) async fn agent_workflow_config_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "config": gui.workflow_config,
        "storePath": gui.paths.workflow_config_path.to_string_lossy(),
        "initialized": true
    }))
}

pub(crate) async fn agent_workflow_config_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let config = body.get("config").cloned().unwrap_or_else(|| json!({}));
    let mut gui = state.gui.lock().expect("gui state lock");
    merge_object(&mut gui.workflow_config, &config);
    match atomic_write_json(&gui.paths.workflow_config_path, &gui.workflow_config) {
        Ok(()) => ApiResponse::ok(json!({
            "config": gui.workflow_config,
            "storePath": gui.paths.workflow_config_path.to_string_lossy(),
            "initialized": true
        })),
        Err(error) => ApiResponse::error("write_workflow_config_failed", error),
    }
}

pub(crate) async fn agent_parse_actions() -> Json<ApiResponse> {
    ApiResponse::ok(json!({ "actions": [], "errors": [] }))
}

pub(crate) async fn agent_fixture_run() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "parse": { "actions": [], "errors": [] },
        "observations": []
    }))
}

pub(crate) async fn agent_prompt_layers() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "layers": [{
            "id": "builtin-default",
            "kind": "builtin",
            "priority": 100,
            "contentHash": "builtin",
            "title": "Builtin default prompt"
        }]
    }))
}

pub(crate) async fn agent_tools(State(state): State<AppState>) -> Json<ApiResponse> {
    match dispatch_skill(
        &state.runtime,
        KernelCommand::SkillDiscover {
            request_id: rid("skill-discover"),
        },
    ) {
        Ok(output) => {
            let skills = output
                .get("skills")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let tools = skills
                .iter()
                .map(|skill| {
                    json!({
                        "name": skill.get("id").or_else(|| skill.get("name")).cloned().unwrap_or(Value::Null),
                        "description": skill.get("description").cloned().unwrap_or_else(|| json!("Kernel skill")),
                        "inputSchema": skill.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                        "riskLevel": skill.get("riskLevel").cloned().unwrap_or_else(|| json!("low")),
                        "needsApproval": skill.get("requiresApproval").cloned().unwrap_or_else(|| json!(false)),
                        "allowedModes": ["readOnly", "plan", "askBeforeWrite"]
                    })
                })
                .collect::<Vec<_>>();
            ApiResponse::ok(json!({
                "skills": skills,
                "tools": tools
            }))
        }
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) fn create_agent_session_value(
    id: &str,
    now: &str,
    title: &str,
    mode: &str,
    profile_id: Option<&str>,
    workspace_id: Option<&str>,
    workspace_hash: Option<&str>,
) -> Value {
    json!({
        "id": id,
        "title": title,
        "mode": mode,
        "profileId": profile_id,
        "workspaceId": workspace_id,
        "workspaceHash": workspace_hash,
        "titleSource": "pending",
        "eventCount": 0,
        "createdAt": now,
        "updatedAt": now
    })
}

pub(crate) fn is_archived_session(session: &Value) -> bool {
    session.get("archivedAt").and_then(Value::as_str).is_some()
}

pub(crate) fn ensure_current_agent_session(
    gui: &mut GuiState,
    fallback_scope: Option<(Option<String>, Option<String>, Option<String>)>,
) {
    if let Some(next_id) = gui
        .sessions
        .iter()
        .find(|session| !is_archived_session(session))
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
    {
        gui.current_session_id = Some(next_id);
        return;
    }

    let id = format!("session-{}", now_millis());
    let now = now_text();
    let (profile_id, workspace_id, workspace_hash) = fallback_scope.unwrap_or_default();
    let session = create_agent_session_value(
        &id,
        &now,
        "New Agent Session",
        "plan",
        profile_id.as_deref(),
        workspace_id.as_deref(),
        workspace_hash.as_deref(),
    );
    gui.current_session_id = Some(id.clone());
    gui.session_projection_cache.insert(id.clone(), Vec::new());
    gui.trace_events.insert(id.clone(), Vec::new());
    gui.sessions.insert(0, session);
}

pub(crate) fn compact_agent_session_title(content: &str) -> Option<String> {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    const TITLE_CHAR_LIMIT: usize = 28;
    let char_count = normalized.chars().count();
    if char_count <= TITLE_CHAR_LIMIT {
        return Some(normalized);
    }
    let title = normalized
        .chars()
        .take(TITLE_CHAR_LIMIT)
        .collect::<String>();
    Some(format!("{title}…"))
}

pub(crate) fn maybe_auto_title_session(gui: &mut GuiState, session_id: &str, content: &str) {
    let Some(title) = compact_agent_session_title(content) else {
        return;
    };
    if let Some(session) = session_mut(gui, session_id) {
        let source = session
            .get("titleSource")
            .and_then(Value::as_str)
            .unwrap_or("pending");
        if source == "pending" {
            session["title"] = json!(title);
            session["titleSource"] = json!("auto");
            session["updatedAt"] = json!(now_text());
        }
    }
}

pub(crate) fn first_user_message_content(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        if event.get("kind").and_then(Value::as_str) != Some("user_msg") {
            return None;
        }
        event
            .get("payload")
            .and_then(|payload| payload.get("content"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}

pub(crate) fn refresh_pending_session_titles(gui: &mut GuiState) {
    let sessions_dir = gui.paths.sessions_dir.clone();
    let pending_ids = gui
        .sessions
        .iter()
        .filter(|session| {
            session
                .get("titleSource")
                .and_then(Value::as_str)
                .unwrap_or("pending")
                == "pending"
        })
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    for session_id in pending_ids {
        let events = gui
            .session_projection_cache
            .get(&session_id)
            .cloned()
            .unwrap_or_else(|| read_session_projection_jsonl(&sessions_dir, &session_id));
        if let Some(content) = first_user_message_content(&events) {
            maybe_auto_title_session(gui, &session_id, &content);
        }
    }
}

pub(crate) fn has_session(gui: &GuiState, session_id: &str) -> bool {
    gui.sessions.iter().any(|session| {
        session.get("id").and_then(Value::as_str) == Some(session_id)
            && !is_archived_session(session)
    })
}

pub(crate) fn session_mut<'a>(gui: &'a mut GuiState, session_id: &str) -> Option<&'a mut Value> {
    gui.sessions
        .iter_mut()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
}

pub(crate) fn update_session_event_count(gui: &mut GuiState, session_id: &str) {
    let count = gui
        .session_projection_cache
        .get(session_id)
        .map(Vec::len)
        .unwrap_or_default();
    if let Some(session) = session_mut(gui, session_id) {
        session["eventCount"] = json!(count);
        session["updatedAt"] = json!(now_text());
    }
}

pub(crate) fn session_result(gui: &GuiState, session_id: &str) -> Json<ApiResponse> {
    let Some(session) = gui
        .sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
    else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    let events = gui
        .session_projection_cache
        .get(session_id)
        .cloned()
        .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, session_id));
    ApiResponse::ok(json!({
        "session": session,
        "events": events
    }))
}

pub(crate) fn agent_event(session_id: &str, kind: &str, payload: Value, ts: &str) -> Value {
    json!({
        "id": format!("evt-{}-{}", kind, now_millis()),
        "sessionId": session_id,
        "ts": ts,
        "kind": kind,
        "payload": payload
    })
}
