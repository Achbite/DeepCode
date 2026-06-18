#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionScopeQuery {
    pub(crate) workspace_id: Option<String>,
    pub(crate) workspace_hash: Option<String>,
    pub(crate) include_archived: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionRunRequest {
    pub(crate) op: Option<String>,
    pub(crate) content: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) attachments: Option<Vec<Value>>,
    pub(crate) workspace_path: Option<String>,
    pub(crate) no_workspace: Option<bool>,
    pub(crate) profile_id: Option<String>,
    pub(crate) workflow: Option<String>,
    pub(crate) requirement_confirmation_mode: Option<String>,
    pub(crate) review_continuation_mode: Option<String>,
    pub(crate) intervention_level: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) decision_kind: Option<String>,
    pub(crate) decision: Option<String>,
    pub(crate) guidance: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) target_id: Option<String>,
}

pub(crate) async fn agent_sessions_list(
    State(state): State<AppState>,
    Query(query): Query<AgentSessionScopeQuery>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
    let scope_key = scope_key_from_query(&query);
    let include_archived = query.include_archived.unwrap_or(false);
    let sessions = scoped_sessions(&gui, &scope_key, include_archived);
    let current_session_id = current_agent_session_id_for_scope(&mut gui, &scope_key);
    ApiResponse::ok(json!({
        "sessions": sessions,
        "currentSessionId": current_session_id,
        "workspaceScopeKey": scope_key
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
    let workspace_id = body.get("workspaceId").and_then(Value::as_str);
    let workspace_hash = body.get("workspaceHash").and_then(Value::as_str);
    let session = create_agent_session_value(
        &id,
        &now,
        body.get("title")
            .and_then(Value::as_str)
            .unwrap_or("New Agent Session"),
        mode,
        body.get("profileId").and_then(Value::as_str),
        workspace_id,
        workspace_hash,
    );
    let scope_key = session_scope_key(&session);
    gui.current_session_id = Some(id.clone());
    gui.current_session_ids_by_scope
        .insert(scope_key, id.clone());
    gui.session_projection_cache.insert(id.clone(), Vec::new());
    gui.trace_events.insert(id.clone(), Vec::new());
    gui.sessions.insert(0, session.clone());
    ApiResponse::ok(json!({ "session": session, "events": [] }))
}

pub(crate) async fn agent_session_current(
    State(state): State<AppState>,
    Query(query): Query<AgentSessionScopeQuery>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
    let scope_key = scope_key_from_query(&query);
    let Some(session_id) = current_agent_session_id_for_scope(&mut gui, &scope_key) else {
        return ApiResponse::ok(Value::Null);
    };
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_activate(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if has_session(&gui, &session_id) {
        if let Some(scope_key) = session_by_id(&gui, &session_id).map(session_scope_key) {
            gui.current_session_ids_by_scope
                .insert(scope_key, session_id.clone());
        }
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

pub(crate) async fn agent_session_delete(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let safe_session_id = safe_path_segment(&session_id);
    let (sessions_dir, archive_root, response_scope_key, response_current_id, response_sessions) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let Some(position) = gui.sessions.iter().position(|session| {
            session.get("id").and_then(Value::as_str) == Some(session_id.as_str())
        }) else {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        };

        let scope_key = session_scope_key(&gui.sessions[position]);
        gui.sessions.remove(position);
        gui.session_projection_cache.remove(&session_id);
        gui.trace_events.remove(&session_id);
        gui.current_session_ids_by_scope
            .retain(|_, current_id| current_id != &session_id);
        if gui.current_session_id.as_deref() == Some(session_id.as_str()) {
            gui.current_session_id = gui
                .sessions
                .iter()
                .find(|session| !is_archived_session(session))
                .and_then(|session| session.get("id").and_then(Value::as_str))
                .map(ToOwned::to_owned);
        }
        let response_current_id = current_agent_session_id_for_scope(&mut gui, &scope_key);
        let response_sessions = scoped_sessions(&gui, &scope_key, false);
        (
            gui.paths.sessions_dir.clone(),
            gui.paths.conversation_archives_dir.clone(),
            scope_key,
            response_current_id,
            response_sessions,
        )
    };

    remove_session_storage_dir(&sessions_dir, &safe_session_id);
    remove_conversation_archive_dirs(&archive_root, &safe_session_id);

    ApiResponse::ok(json!({
        "sessions": response_sessions,
        "currentSessionId": response_current_id,
        "workspaceScopeKey": response_scope_key
    }))
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
    let archived_scope_key = session_by_id(&gui, &session_id).map(session_scope_key);
    let was_global_current = gui.current_session_id.as_deref() == Some(session_id.as_str());
    let was_scoped_current = archived_scope_key
        .as_ref()
        .and_then(|scope| gui.current_session_ids_by_scope.get(scope))
        .map(|current| current == &session_id)
        .unwrap_or(false);
    let mut replacement_scope: Option<(Option<String>, Option<String>, Option<String>)> = None;
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if should_archive {
            if was_global_current || was_scoped_current {
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
    if should_archive {
        if let Some(scope_key) = archived_scope_key.as_ref() {
            gui.current_session_ids_by_scope.remove(scope_key);
        }
        if was_global_current || was_scoped_current {
            ensure_current_agent_session_for_scope(
                &mut gui,
                archived_scope_key.as_deref().unwrap_or("unbound-workspace"),
                replacement_scope,
            );
        }
    }
    let response_scope_key = archived_scope_key.unwrap_or_else(|| scope_key_from_parts(None, None));
    let response_current_id = current_agent_session_id_for_scope(&mut gui, &response_scope_key);
    let response_sessions = scoped_sessions(&gui, &response_scope_key, false);
    ApiResponse::ok(json!({
        "sessions": response_sessions,
        "currentSessionId": response_current_id,
        "workspaceScopeKey": response_scope_key
    }))
}

pub(crate) async fn agent_session_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_append_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let incoming = body
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    append_session_projection(&state, &session_id, incoming);
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_send_message(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let _ = (state, session_id, body);
    ApiResponse::error(
        "agent_messages_endpoint_removed",
        "Agent message sending is owned by userspace SessionDriverLoop. Use /api/kernel/commands, /api/llm/chat, and /api/agent/sessions/:id/events.",
    )
}

pub(crate) async fn agent_session_run_start(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<AgentSessionRunRequest>,
) -> Json<ApiResponse> {
    let Some((session, events)) = session_payload(&state, &session_id) else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    let start_event_count = events.len();
    let run_id = format!("session-run-{}", now_millis());
    let run = AgentRunState::running(run_id.clone(), session_id.clone());
    {
        let mut runs = state.session_runs.lock().expect("session run state lock");
        runs.insert(run_id.clone(), run.clone());
    }

    let intervention_level = body
        .intervention_level
        .clone()
        .or_else(|| user_setting_string(&state, "agent.interventionLevel"))
        .or_else(|| Some("medium".to_string()));
    let request = host_bridge_request(&session_id, &run_id, &body, intervention_level);
    let worker_state = state.clone();
    let worker_session_id = session_id.clone();
    let worker_run_id = run_id.clone();
    thread::spawn(move || {
        run_session_bridge_worker(
            worker_state,
            worker_session_id,
            worker_run_id,
            request,
            start_event_count,
        );
    });

    ApiResponse::ok(json!({
        "run": run,
        "session": session,
        "events": events
    }))
}

pub(crate) async fn agent_session_run_get(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    run_response(&state, &session_id, &run_id)
}

pub(crate) async fn agent_session_run_cancel(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    let changed = set_run_terminal(
        &state,
        &run_id,
        "cancelled",
        Some("Run cancelled by user.".to_string()),
        None,
    );
    if changed {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "workflow_stage",
                json!({
                    "stage": "session_run",
                    "phase": "cancel",
                    "status": "cancelled",
                    "summary": "Run cancelled by user.",
                    "channel": "task",
                    "visibility": "task",
                    "presentation": "stageSummary",
                    "runId": run_id.clone()
                }),
                &now_text(),
            )],
        );
    }
    run_response(&state, &session_id, &run_id)
}

pub(crate) async fn agent_session_run_delta(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if !run_belongs_to_session(&state, &session_id, &run_id) {
        return ApiResponse::error("agent_run_not_found", "agent run not found");
    }
    let delta = normalize_run_delta(&session_id, &run_id, body);
    {
        let mut deltas = state
            .session_run_deltas
            .lock()
            .expect("session run delta state lock");
        let queue = deltas.entry(run_id.clone()).or_default();
        queue.push(delta);
        const MAX_RUN_DELTAS: usize = 2_000;
        if queue.len() > MAX_RUN_DELTAS {
            let overflow = queue.len() - MAX_RUN_DELTAS;
            queue.drain(0..overflow);
        }
    }
    touch_run(&state, &run_id, None);
    run_response(&state, &session_id, &run_id)
}

pub(crate) async fn agent_session_run_guidance(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let run = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.get(&run_id)
            .filter(|run| run.session_id == session_id)
            .cloned()
    };
    let Some(run) = run else {
        return ApiResponse::error("agent_run_not_found", "agent run not found");
    };
    if run_status_terminal(&run.status) {
        return ApiResponse::error(
            "agent_run_not_active",
            "run is not active; start a new run or resolve the pending decision",
        );
    }
    let events = session_projection(&state, &session_id);
    if pending_permission_message(&events).is_some() {
        return ApiResponse::error(
            "permission_pending",
            "permission confirmation is pending; resolve it before sending guidance",
        );
    }
    let guidance = body
        .get("guidance")
        .or_else(|| body.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if guidance.is_empty() {
        return ApiResponse::error("empty_guidance", "guidance must not be empty");
    }
    let attachments = body
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let guidance_id = format!("guidance-{}", now_millis());
    append_session_projection(
        &state,
        &session_id,
        vec![agent_event(
            &session_id,
            "user_guidance",
            json!({
                "guidanceId": guidance_id,
                "content": guidance.clone(),
                "guidance": guidance.clone(),
                "attachments": attachments,
                "source": "user",
                "targetRunId": run_id.clone(),
                "targetInteractionKind": "runningRunGuidance",
                "effectiveCheckpoint": "nextProviderCall",
                "checkpointKind": "nextProviderCall",
                "status": "queued",
                "summary": "用户补充引导已记录，将在下一次 provider checkpoint 生效。",
                "channel": "user",
                "visibility": "conversation",
                "presentation": "body"
            }),
            &now_text(),
        )],
    );
    touch_run(&state, &run_id, Some("guidance queued".to_string()));
    run_response(&state, &session_id, &run_id)
}

pub(crate) async fn agent_session_run_stream(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
) -> Response {
    let stream_state = state.clone();
    let stream = async_stream::stream! {
        let mut sent_delta_count = 0usize;
        let mut sent_event_count = 0usize;
        let mut last_run_status = String::new();
        let mut heartbeat_at = Instant::now();
        loop {
            let run = {
                let runs = stream_state.session_runs.lock().expect("session run state lock");
                runs.get(&run_id)
                    .filter(|run| run.session_id == session_id)
                    .cloned()
            };
            let Some(run) = run else {
                yield sse_bytes("error", json!({
                    "code": "agent_run_not_found",
                    "message": "agent run not found",
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone()
                }));
                break;
            };

            if run.status != last_run_status {
                last_run_status = run.status.clone();
                yield sse_bytes("run", json!({
                    "run": run.clone(),
                    "sessionId": session_id.clone()
                }));
            }

            let deltas = {
                let deltas = stream_state
                    .session_run_deltas
                    .lock()
                    .expect("session run delta state lock");
                deltas.get(&run_id).cloned().unwrap_or_default()
            };
            for delta in deltas.iter().skip(sent_delta_count) {
                yield sse_bytes("delta", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "delta": delta
                }));
            }
            sent_delta_count = deltas.len();

            let events = session_projection(&stream_state, &session_id);
            if events.len() != sent_event_count {
                let new_events = events.iter().skip(sent_event_count).cloned().collect::<Vec<_>>();
                sent_event_count = events.len();
                yield sse_bytes("events", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "events": new_events,
                    "eventCount": sent_event_count
                }));
            }

            if run_status_terminal(&run.status) {
                yield sse_bytes("terminal", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "run": run.clone(),
                    "events": events
                }));
                break;
            }

            if heartbeat_at.elapsed() >= Duration::from_secs(10) {
                heartbeat_at = Instant::now();
                yield sse_bytes("heartbeat", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "at": now_text()
                }));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

pub(crate) async fn agent_session_cancel(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let active_runs = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.values()
            .filter(|run| run.session_id == session_id && run_status_active(&run.status))
            .map(|run| run.run_id.clone())
            .collect::<Vec<_>>()
    };
    for run_id in active_runs {
        let _ = set_run_terminal(
            &state,
            &run_id,
            "cancelled",
            Some("Run cancelled by user.".to_string()),
            None,
        );
    }
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
    record_kernel_events(&state, &kernel_events);
    let projection = kernel_events_to_agent_events(&session_id, &kernel_events);
    append_session_projection(&state, &session_id, projection);
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

fn run_response(state: &AppState, session_id: &str, run_id: &str) -> Json<ApiResponse> {
    let run = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.get(run_id)
            .filter(|run| run.session_id == session_id)
            .cloned()
    };
    let Some(run) = run else {
        return ApiResponse::error("agent_run_not_found", "agent run not found");
    };
    let Some((session, events)) = session_payload(state, session_id) else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    ApiResponse::ok(json!({
        "run": run,
        "session": session,
        "events": events
    }))
}

fn session_payload(state: &AppState, session_id: &str) -> Option<(Value, Vec<Value>)> {
    let gui = state.gui.lock().expect("gui state lock");
    let session = session_by_id(&gui, session_id)?.clone();
    let events = gui
        .session_projection_cache
        .get(session_id)
        .cloned()
        .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, session_id));
    Some((session, events))
}

fn host_bridge_request(
    session_id: &str,
    host_run_id: &str,
    body: &AgentSessionRunRequest,
    intervention_level: Option<String>,
) -> Value {
    let op = body.op.as_deref().unwrap_or_else(|| {
        if body.decision_kind.is_some() {
            "resolveDecision"
        } else {
            "ask"
        }
    });
    let prompt = body
        .prompt
        .as_ref()
        .or(body.content.as_ref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    json!({
        "op": op,
        "apiBase": daemon_api_base(),
        "sessionId": session_id,
        "hostRunId": host_run_id,
        "prompt": prompt,
        "title": body.title.clone(),
        "attachments": body.attachments.clone().unwrap_or_default(),
        "workspacePath": body.workspace_path.clone(),
        "noWorkspace": body.no_workspace.unwrap_or(false),
        "profileId": body.profile_id.clone(),
        "workflow": body.workflow.clone(),
        "requirementConfirmationMode": body.requirement_confirmation_mode.clone(),
        "reviewContinuationMode": body.review_continuation_mode.clone(),
        "interventionLevel": intervention_level,
        "decisionKind": body.decision_kind.clone(),
        "decision": body.decision.clone(),
        "guidance": body.guidance.clone(),
        "runId": body.run_id.clone(),
        "targetId": body.target_id.clone()
    })
}

fn user_setting_string(state: &AppState, key: &str) -> Option<String> {
    let gui = state.gui.lock().expect("gui state lock");
    gui.user_settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn daemon_api_base() -> String {
    if let Ok(base_url) = std::env::var("DEEPCODE_API_URL") {
        let trimmed = base_url.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let host = std::env::var("DEEPCODE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DEEPCODE_PORT").unwrap_or_else(|_| "31245".to_string());
    format!("http://{host}:{port}")
}

fn run_session_bridge_worker(
    state: AppState,
    session_id: String,
    run_id: String,
    request: Value,
    start_event_count: usize,
) {
    let Some(bridge) = find_session_host_bridge_daemon() else {
        fail_run_with_event(
            &state,
            &session_id,
            &run_id,
            "session_bridge_unavailable",
            format!(
                "cannot find session host bridge; {}",
                session_host_bridge_hint_daemon()
            ),
        );
        return;
    };
    let node = find_session_host_node_daemon(&bridge);
    let mut child = match Command::new(&node)
        .arg(&bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            fail_run_with_event(
                &state,
                &session_id,
                &run_id,
                "session_bridge_spawn_failed",
                format!(
                    "failed to start Node runtime `{}` for bridge `{}`: {error}; {}",
                    node.display(),
                    bridge.display(),
                    session_host_bridge_hint_daemon()
                ),
            );
            return;
        }
    };

    match child.stdin.take() {
        Some(mut stdin) => {
            let payload = match serde_json::to_vec(&request) {
                Ok(payload) => payload,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    fail_run_with_event(
                        &state,
                        &session_id,
                        &run_id,
                        "session_bridge_request_encode_failed",
                        format!("failed to encode session run request: {error}"),
                    );
                    return;
                }
            };
            if let Err(error) = stdin.write_all(&payload) {
                let _ = child.kill();
                let _ = child.wait();
                fail_run_with_event(
                    &state,
                    &session_id,
                    &run_id,
                    "session_bridge_write_failed",
                    format!("failed to write session run request: {error}"),
                );
                return;
            }
        }
        None => {
            let _ = child.kill();
            let _ = child.wait();
            fail_run_with_event(
                &state,
                &session_id,
                &run_id,
                "session_bridge_stdin_unavailable",
                "session bridge stdin is unavailable",
            );
            return;
        }
    }

    match wait_for_session_bridge_output(&state, &session_id, &run_id, child, start_event_count) {
        Ok(output) => {
            finish_run_from_bridge_output(&state, &session_id, &run_id, output, start_event_count)
        }
        Err(BridgeWorkerStop::Projection(lifecycle)) => {
            finish_run_from_projection(&state, &run_id, lifecycle)
        }
        Err(BridgeWorkerStop::Cancelled) => {
            let _ = set_run_terminal(
                &state,
                &run_id,
                "cancelled",
                Some("Run cancelled by user.".to_string()),
                None,
            );
        }
        Err(BridgeWorkerStop::Failed(message)) => {
            fail_run_with_event(
                &state,
                &session_id,
                &run_id,
                "session_bridge_failed",
                message,
            );
        }
    }
}

enum BridgeWorkerStop {
    Projection(RunProjectionLifecycle),
    Cancelled,
    Failed(String),
}

fn wait_for_session_bridge_output(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    mut child: Child,
    start_event_count: usize,
) -> Result<Output, BridgeWorkerStop> {
    let started_at = Instant::now();
    let timeout = session_host_bridge_timeout();
    loop {
        if let Some(lifecycle) = projection_lifecycle(state, session_id, start_event_count) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(BridgeWorkerStop::Projection(lifecycle));
        }
        if run_cancelled(state, run_id) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(BridgeWorkerStop::Cancelled);
        }
        if let Some(limit) = timeout {
            if started_at.elapsed() >= limit {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BridgeWorkerStop::Failed(format!(
                    "session run timed out after {} ms; set DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS=0 to disable the hard timeout",
                    limit.as_millis()
                )));
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                return child.wait_with_output().map_err(|error| {
                    BridgeWorkerStop::Failed(format!(
                        "failed to read session bridge output: {error}"
                    ))
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BridgeWorkerStop::Failed(format!(
                    "failed to wait for session bridge output: {error}"
                )));
            }
        }
    }
}

fn finish_run_from_bridge_output(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    output: Output,
    start_event_count: usize,
) {
    if let Some(lifecycle) = projection_lifecycle(state, session_id, start_event_count) {
        finish_run_from_projection(state, run_id, lifecycle);
        return;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let result = match serde_json::from_str::<Value>(stdout.trim()) {
        Ok(result) => result,
        Err(error) => {
            fail_run_with_event(
                state,
                session_id,
                run_id,
                "session_bridge_invalid_json",
                format!(
                    "session bridge returned invalid JSON: {error}; stdout={}; stderr={}",
                    stdout.trim(),
                    stderr.trim()
                ),
            );
            return;
        }
    };
    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !output.status.success() || !ok {
        let message = result
            .get("message")
            .or_else(|| result.get("error"))
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                let stderr = stderr.trim();
                if stderr.is_empty() {
                    "session bridge failed".to_string()
                } else {
                    stderr.to_string()
                }
            });
        fail_run_with_event(state, session_id, run_id, "session_bridge_failed", message);
        return;
    }

    if let Some(lifecycle) = projection_lifecycle(state, session_id, start_event_count) {
        finish_run_from_projection(state, run_id, lifecycle);
        return;
    }

    if result.get("runStatus").and_then(Value::as_str) == Some("waiting") {
        let message = result
            .get("terminalReason")
            .and_then(Value::as_str)
            .unwrap_or("Session run is waiting for user input.")
            .to_string();
        let _ = set_run_terminal(state, run_id, "waiting", Some(message), None);
        return;
    }

    let final_text = result
        .get("finalText")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| latest_final_text(state, session_id, start_event_count));
    let _ = set_run_terminal(state, run_id, "completed", None, final_text);
}

fn finish_run_from_projection(state: &AppState, run_id: &str, lifecycle: RunProjectionLifecycle) {
    match lifecycle {
        RunProjectionLifecycle::Completed(final_text) => {
            let _ = set_run_terminal(state, run_id, "completed", None, final_text);
        }
        RunProjectionLifecycle::Waiting(message) => {
            let _ = set_run_terminal(state, run_id, "waiting", Some(message), None);
        }
        RunProjectionLifecycle::Failed(message) => {
            let _ = set_run_terminal(state, run_id, "failed", Some(message), None);
        }
    }
}

enum RunProjectionLifecycle {
    Completed(Option<String>),
    Waiting(String),
    Failed(String),
}

fn projection_lifecycle(
    state: &AppState,
    session_id: &str,
    start_event_count: usize,
) -> Option<RunProjectionLifecycle> {
    let events = session_projection(state, session_id);
    let mut lifecycle = None;
    for event in events.iter().skip(start_event_count) {
        if event.get("kind").and_then(Value::as_str) == Some("error") {
            lifecycle = Some(RunProjectionLifecycle::Failed(
                event_message(event).unwrap_or_else(|| "session run failed".to_string()),
            ));
            continue;
        }
        if is_final_assistant_event(event) {
            lifecycle = Some(RunProjectionLifecycle::Completed(event_message(event)));
            continue;
        }
        if session_run_completed(event) {
            lifecycle = Some(RunProjectionLifecycle::Completed(None));
            continue;
        }
        if waiting_for_user_message(event).is_some() {
            lifecycle = waiting_for_user_message(event).map(RunProjectionLifecycle::Waiting);
        }
    }
    lifecycle
}

fn session_run_completed(event: &Value) -> bool {
    event.get("kind").and_then(Value::as_str) == Some("session_run_state")
        && event
            .get("payload")
            .and_then(|payload| payload.get("status"))
            .and_then(Value::as_str)
            == Some("completed")
}

fn waiting_for_user_message(event: &Value) -> Option<String> {
    let kind = event.get("kind").and_then(Value::as_str)?;
    let payload = event.get("payload").unwrap_or(&Value::Null);
    match kind {
        "permission_request" => {
            Some("Session run is waiting for a permission decision.".to_string())
        }
        "session_run_state" => {
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if status == "waiting" {
                Some(
                    event_message(event)
                        .unwrap_or_else(|| "Session run is waiting for user input.".to_string()),
                )
            } else {
                None
            }
        }
        "requirement_confirmation" => {
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if status == "waitingUserConfirmation" {
                Some("Session run is waiting for requirement confirmation.".to_string())
            } else {
                None
            }
        }
        "plan_card" => {
            if payload.get("confirmable").and_then(Value::as_bool) == Some(false) {
                None
            } else {
                Some("Session run is waiting for plan review.".to_string())
            }
        }
        "plan_review" | "review_summary" => {
            if payload.get("confirmable").and_then(Value::as_bool) == Some(false)
                || payload.get("visibility").and_then(Value::as_str) == Some("debug")
            {
                return None;
            }
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if status.contains("waiting") || status == "pending" {
                Some("Session run is waiting for user review.".to_string())
            } else {
                None
            }
        }
        _ => None,
    }
}

fn is_final_assistant_event(event: &Value) -> bool {
    if event.get("kind").and_then(Value::as_str) != Some("assistant_msg") {
        return false;
    }
    let Some(payload) = event.get("payload") else {
        return false;
    };
    payload.get("channel").and_then(Value::as_str) == Some("final")
        || payload.get("kind").and_then(Value::as_str) == Some("final")
}

fn latest_final_text(
    state: &AppState,
    session_id: &str,
    start_event_count: usize,
) -> Option<String> {
    session_projection(state, session_id)
        .into_iter()
        .skip(start_event_count)
        .rev()
        .find_map(|event| {
            if is_final_assistant_event(&event) {
                event_message(&event)
            } else {
                None
            }
        })
}

fn event_message(event: &Value) -> Option<String> {
    event
        .get("payload")
        .and_then(|payload| {
            payload
                .get("content")
                .or_else(|| payload.get("summary"))
                .or_else(|| payload.get("message"))
        })
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
}

fn fail_run_with_event(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    code: &str,
    message: impl Into<String>,
) {
    let message = message.into();
    let _ = set_run_terminal(state, run_id, "failed", Some(message.clone()), None);
    append_session_projection(
        state,
        session_id,
        vec![agent_event(
            session_id,
            "error",
            json!({
                "code": code,
                "message": message,
                "summary": message,
                "channel": "error",
                "visibility": "conversation",
                "presentation": "body",
                "runId": run_id
            }),
            &now_text(),
        )],
    );
}

fn set_run_terminal(
    state: &AppState,
    run_id: &str,
    status: &str,
    message: Option<String>,
    final_text: Option<String>,
) -> bool {
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(run_id) else {
        return false;
    };
    if run_status_terminal(&run.status) {
        return false;
    }
    let now = now_text();
    run.status = status.to_string();
    run.updated_at = now.clone();
    run.completed_at = Some(now);
    run.message = message;
    run.final_text = final_text;
    true
}

fn touch_run(state: &AppState, run_id: &str, message: Option<String>) -> bool {
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(run_id) else {
        return false;
    };
    if run_status_terminal(&run.status) {
        return false;
    }
    run.updated_at = now_text();
    if let Some(message) = message {
        run.message = Some(message);
    }
    true
}

fn run_belongs_to_session(state: &AppState, session_id: &str, run_id: &str) -> bool {
    let runs = state.session_runs.lock().expect("session run state lock");
    runs.get(run_id)
        .map(|run| run.session_id == session_id)
        .unwrap_or(false)
}

fn normalize_run_delta(session_id: &str, host_run_id: &str, mut delta: Value) -> Value {
    if let Value::Object(object) = &mut delta {
        object.entry("sessionId".to_string()).or_insert_with(|| json!(session_id));
        object
            .entry("hostRunId".to_string())
            .or_insert_with(|| json!(host_run_id));
        object.entry("receivedAt".to_string()).or_insert_with(|| json!(now_text()));
    }
    delta
}

fn pending_permission_message(events: &[Value]) -> Option<String> {
    for event in events.iter().rev() {
        match event.get("kind").and_then(Value::as_str) {
            Some("permission_result") => return None,
            Some("permission_request") => {
                return Some(
                    event_message(event)
                        .unwrap_or_else(|| "permission confirmation is pending".to_string()),
                );
            }
            _ => {}
        }
    }
    None
}

fn sse_bytes(event: &str, payload: Value) -> Result<bytes::Bytes, std::convert::Infallible> {
    let data = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    Ok(bytes::Bytes::from(format!("event: {event}\ndata: {data}\n\n")))
}

fn run_cancelled(state: &AppState, run_id: &str) -> bool {
    let runs = state.session_runs.lock().expect("session run state lock");
    runs.get(run_id)
        .map(|run| run.status == "cancelled")
        .unwrap_or(false)
}

fn run_status_active(status: &str) -> bool {
    !run_status_terminal(status)
}

fn run_status_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "waiting")
}

fn session_host_bridge_timeout() -> Option<Duration> {
    const DEFAULT_TIMEOUT_MS: u64 = 600_000;
    let millis = std::env::var("DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    if millis == 0 {
        None
    } else {
        Some(Duration::from_millis(millis))
    }
}

fn find_session_host_bridge_daemon() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DEEPCODE_SESSION_BRIDGE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        if let Some(path) = find_bridge_from_root_daemon(&root) {
            return Some(path);
        }
    }
    None
}

fn find_bridge_from_root_daemon(root: &FsPath) -> Option<PathBuf> {
    for ancestor in root.ancestors() {
        for candidate in [
            ancestor.join("session-core/dist/hostBridge.js"),
            ancestor.join("session-core/hostBridge.js"),
            ancestor.join("userspace/session-core/dist/hostBridge.js"),
            ancestor.join("DeepCode/userspace/session-core/dist/hostBridge.js"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn find_session_host_node_daemon(bridge: &FsPath) -> PathBuf {
    if let Ok(path) = std::env::var("DEEPCODE_NODE") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }

    let mut roots = Vec::new();
    if let Some(parent) = bridge.parent() {
        roots.push(parent.to_path_buf());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }

    for root in roots {
        if let Some(node) = find_node_from_root_daemon(&root) {
            return node;
        }
    }
    PathBuf::from(node_executable_name_daemon())
}

fn find_node_from_root_daemon(root: &FsPath) -> Option<PathBuf> {
    for ancestor in root.ancestors() {
        for candidate in [
            ancestor
                .join("node/bin")
                .join(node_executable_name_daemon()),
            ancestor.join("bin").join(node_executable_name_daemon()),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn node_executable_name_daemon() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn session_host_bridge_hint_daemon() -> &'static str {
    "run `pnpm --filter @deepcode/session-core build`, set DEEPCODE_SESSION_BRIDGE, set DEEPCODE_NODE, or use a packaged distribution that includes session-core/dist/hostBridge.js, node_modules/@deepcode/protocol, and node/bin/node"
}

pub(crate) fn latest_user_attachments_for_session(
    state: &AppState,
    session_id: &str,
) -> Vec<Value> {
    session_projection(state, session_id)
        .into_iter()
        .rev()
        .find_map(|event| {
            if event.get("kind").and_then(Value::as_str) != Some("user_msg") {
                return None;
            }
            let attachments = event
                .get("payload")
                .and_then(|payload| payload.get("attachments"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if attachments.is_empty() {
                None
            } else {
                Some(attachments)
            }
        })
        .unwrap_or_default()
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
    let workspace_scope_key = scope_key_from_parts(workspace_id, workspace_hash);
    json!({
        "id": id,
        "title": title,
        "mode": mode,
        "profileId": profile_id,
        "workspaceId": workspace_id,
        "workspaceHash": workspace_hash,
        "workspaceScopeKey": workspace_scope_key,
        "titleSource": "pending",
        "eventCount": 0,
        "createdAt": now,
        "updatedAt": now
    })
}

pub(crate) fn is_archived_session(session: &Value) -> bool {
    session.get("archivedAt").and_then(Value::as_str).is_some()
}

pub(crate) fn remove_session_storage_dir(sessions_dir: &FsPath, safe_session_id: &str) {
    let path = sessions_dir.join(safe_session_id);
    if path.starts_with(sessions_dir) {
        let _ = fs::remove_dir_all(path);
    }
}

pub(crate) fn remove_conversation_archive_dirs(archive_root: &FsPath, safe_session_id: &str) {
    let Ok(workspaces) = fs::read_dir(archive_root) else {
        return;
    };
    for workspace in workspaces.filter_map(Result::ok) {
        let session_dir = workspace.path().join(safe_session_id);
        if session_dir.starts_with(archive_root) {
            let _ = fs::remove_dir_all(session_dir);
        }
    }
}

pub(crate) fn scope_key_from_query(query: &AgentSessionScopeQuery) -> String {
    scope_key_from_parts(
        query.workspace_id.as_deref(),
        query.workspace_hash.as_deref(),
    )
}

pub(crate) fn scope_key_from_parts(
    workspace_id: Option<&str>,
    workspace_hash: Option<&str>,
) -> String {
    match (workspace_id, workspace_hash) {
        (Some(id), Some(hash)) if !id.trim().is_empty() && !hash.trim().is_empty() => {
            format!(
                "workspace-{}-{}",
                safe_path_segment(id),
                safe_path_segment(hash)
            )
        }
        (Some(id), _) if !id.trim().is_empty() => {
            format!("workspace-{}", safe_path_segment(id))
        }
        _ => "unbound-workspace".to_string(),
    }
}

pub(crate) fn session_scope_key(session: &Value) -> String {
    if let Some(scope_key) = session.get("workspaceScopeKey").and_then(Value::as_str) {
        if !scope_key.trim().is_empty() {
            return safe_path_segment(scope_key);
        }
    }
    scope_key_from_parts(
        session.get("workspaceId").and_then(Value::as_str),
        session.get("workspaceHash").and_then(Value::as_str),
    )
}

pub(crate) fn scoped_sessions(
    gui: &GuiState,
    scope_key: &str,
    include_archived: bool,
) -> Vec<Value> {
    gui.sessions
        .iter()
        .filter(|session| include_archived || !is_archived_session(session))
        .filter(|session| session_scope_key(session) == scope_key)
        .cloned()
        .collect()
}

pub(crate) fn session_by_id<'a>(gui: &'a GuiState, session_id: &str) -> Option<&'a Value> {
    gui.sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
}

pub(crate) fn current_agent_session_id_for_scope(
    gui: &mut GuiState,
    scope_key: &str,
) -> Option<String> {
    if let Some(current_id) = gui.current_session_ids_by_scope.get(scope_key) {
        if gui.sessions.iter().any(|session| {
            session.get("id").and_then(Value::as_str) == Some(current_id.as_str())
                && !is_archived_session(session)
                && session_scope_key(session) == scope_key
        }) {
            return Some(current_id.clone());
        }
    }

    let next_id = gui
        .sessions
        .iter()
        .find(|session| !is_archived_session(session) && session_scope_key(session) == scope_key)
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned);
    if let Some(next_id) = next_id.as_ref() {
        gui.current_session_ids_by_scope
            .insert(scope_key.to_string(), next_id.clone());
    }
    next_id
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

pub(crate) fn ensure_current_agent_session_for_scope(
    gui: &mut GuiState,
    scope_key: &str,
    fallback_scope: Option<(Option<String>, Option<String>, Option<String>)>,
) {
    if let Some(next_id) = gui
        .sessions
        .iter()
        .find(|session| !is_archived_session(session) && session_scope_key(session) == scope_key)
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
    {
        gui.current_session_ids_by_scope
            .insert(scope_key.to_string(), next_id.clone());
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
    gui.current_session_ids_by_scope
        .insert(session_scope_key(&session), id.clone());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_lifecycle_uses_explicit_session_run_state() {
        let event = json!({
            "kind": "session_run_state",
            "payload": {
                "status": "waiting",
                "reason": "plan_review",
                "summary": "Session run is waiting for plan review.",
                "visibility": "debug"
            }
        });
        assert_eq!(
            waiting_for_user_message(&event).as_deref(),
            Some("Session run is waiting for plan review.")
        );
    }

    #[test]
    fn completed_lifecycle_uses_explicit_session_run_state() {
        let event = json!({
            "kind": "session_run_state",
            "payload": {
                "status": "completed",
                "reason": "review",
                "summary": "Review accepted; session run completed.",
                "visibility": "debug"
            }
        });
        assert!(session_run_completed(&event));
        assert_eq!(waiting_for_user_message(&event), None);
    }

    #[test]
    fn driver_request_progress_is_not_a_lifecycle_owner() {
        let event = json!({
            "kind": "workflow_stage",
            "payload": {
                "stage": "driver.request_produced",
                "summary": "Session DriverRequest produced by Kernel.",
                "kernelEvent": {
                    "kind": "driver.request_produced"
                }
            }
        });
        assert!(!session_run_completed(&event));
        assert_eq!(waiting_for_user_message(&event), None);
    }

    #[test]
    fn debug_plan_review_is_not_a_waiting_lifecycle_owner() {
        let event = json!({
            "kind": "plan_review",
            "payload": {
                "status": "awaitingTemporaryGrant",
                "confirmable": false,
                "visibility": "debug",
                "summary": "Kernel preflight."
            }
        });
        assert_eq!(waiting_for_user_message(&event), None);
    }

    #[test]
    fn scoped_session_list_and_current_are_workspace_owned() {
        let mut gui = GuiState::new();
        let now = "2026-06-05T00:00:00Z";
        let session_a = create_agent_session_value(
            "session-a",
            now,
            "Workspace A",
            "plan",
            None,
            Some("workspace-a"),
            Some("hash-a"),
        );
        let session_b = create_agent_session_value(
            "session-b",
            now,
            "Workspace B",
            "plan",
            None,
            Some("workspace-b"),
            Some("hash-b"),
        );
        let scope_a = session_scope_key(&session_a);
        let scope_b = session_scope_key(&session_b);
        gui.sessions = vec![session_b, session_a];
        gui.current_session_ids_by_scope
            .insert(scope_a.clone(), "session-a".to_string());
        gui.current_session_ids_by_scope
            .insert(scope_b.clone(), "session-b".to_string());

        assert_eq!(
            scoped_sessions(&gui, &scope_a, false)
                .iter()
                .filter_map(|session| session.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["session-a"]
        );
        assert_eq!(
            scoped_sessions(&gui, &scope_b, false)
                .iter()
                .filter_map(|session| session.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["session-b"]
        );
        assert_eq!(
            current_agent_session_id_for_scope(&mut gui, &scope_a).as_deref(),
            Some("session-a")
        );
        assert_eq!(
            current_agent_session_id_for_scope(&mut gui, &scope_b).as_deref(),
            Some("session-b")
        );

        session_mut(&mut gui, "session-a").unwrap()["archivedAt"] = json!(now);
        gui.current_session_ids_by_scope.remove(&scope_a);
        ensure_current_agent_session_for_scope(
            &mut gui,
            &scope_a,
            Some((
                None,
                Some("workspace-a".to_string()),
                Some("hash-a".to_string()),
            )),
        );

        assert_ne!(
            current_agent_session_id_for_scope(&mut gui, &scope_a).as_deref(),
            Some("session-b")
        );
        assert_eq!(
            current_agent_session_id_for_scope(&mut gui, &scope_b).as_deref(),
            Some("session-b")
        );
    }
}
