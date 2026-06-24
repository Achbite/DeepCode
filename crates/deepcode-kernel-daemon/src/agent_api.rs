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
    pub(crate) project_memory_mode: Option<Value>,
    pub(crate) sub_agent_mode: Option<Value>,
    pub(crate) sub_agent_max_parallel: Option<Value>,
    pub(crate) title: Option<String>,
    pub(crate) decision_kind: Option<String>,
    pub(crate) decision: Option<String>,
    pub(crate) guidance: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) target_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRunStreamQuery {
    pub(crate) since_event_count: Option<usize>,
    pub(crate) since_delta_seq: Option<u64>,
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
    let (
        sessions_dir,
        archive_root,
        memory_root,
        delete_scope_key,
        response_scope_key,
        response_current_id,
        response_sessions,
    ) = {
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
            gui.paths.memory_archives_dir.clone(),
            scope_key.clone(),
            scope_key,
            response_current_id,
            response_sessions,
        )
    };

    remove_session_storage_dir(&sessions_dir, &safe_session_id);
    remove_conversation_archive_dirs(&archive_root, &safe_session_id);
    let memory_cleanup = remove_session_memory_archive(
        &memory_root,
        &delete_scope_key,
        &safe_session_id,
        &session_id,
    );

    ApiResponse::ok(json!({
        "sessions": response_sessions,
        "currentSessionId": response_current_id,
        "workspaceScopeKey": response_scope_key,
        "memoryCleanup": memory_cleanup
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
    let run = AgentRunState::running(run_id.clone(), session_id.clone(), start_event_count);
    {
        let mut runs = state.session_runs.lock().expect("session run state lock");
        runs.insert(run_id.clone(), run.clone());
    }

    let intervention_level = body
        .intervention_level
        .clone()
        .or_else(|| user_setting_string(&state, "agent.interventionLevel"))
        .or_else(|| Some("medium".to_string()));
    let project_memory_mode = normalize_project_memory_mode(
        body.project_memory_mode.clone(),
        user_setting_string(&state, "agent.memory.projectMode"),
    );
    let sub_agent_mode = normalize_sub_agent_mode(
        body.sub_agent_mode.clone(),
        user_setting_string(&state, "agent.subagents.mode"),
    );
    let sub_agent_max_parallel = normalize_sub_agent_max_parallel(
        body.sub_agent_max_parallel.clone(),
        user_setting_string(&state, "agent.subagents.maxParallel"),
    );
    let request = host_bridge_request(
        &session_id,
        &run_id,
        &body,
        intervention_level,
        project_memory_mode,
        sub_agent_mode,
        sub_agent_max_parallel,
    );
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
    {
        let mut deltas = state
            .session_run_deltas
            .lock()
            .expect("session run delta state lock");
        let queue = deltas.entry(run_id.clone()).or_default();
        let delta_seq = queue
            .last()
            .and_then(|delta| delta.get("deltaSeq").and_then(Value::as_u64))
            .unwrap_or(0)
            + 1;
        let delta = normalize_run_delta(&session_id, &run_id, delta_seq, body);
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
    Query(query): Query<AgentRunStreamQuery>,
) -> Response {
    let stream_state = state.clone();
    let stream = async_stream::stream! {
        let mut sent_delta_seq = query.since_delta_seq.unwrap_or(0);
        let mut sent_event_count = query.since_event_count.unwrap_or_else(|| {
            let runs = stream_state.session_runs.lock().expect("session run state lock");
            runs.get(&run_id).map(|run| run.start_event_count).unwrap_or(0)
        });
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
            for delta in deltas.iter() {
                let Some(seq) = delta.get("deltaSeq").and_then(Value::as_u64) else {
                    continue;
                };
                if seq <= sent_delta_seq {
                    continue;
                }
                yield sse_bytes("delta", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "delta": delta
                }));
                sent_delta_seq = seq;
            }

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
    project_memory_mode: String,
    sub_agent_mode: String,
    sub_agent_max_parallel: u64,
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
        "projectMemoryMode": project_memory_mode,
        "subAgentMode": sub_agent_mode,
        "subAgentMaxParallel": sub_agent_max_parallel,
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

fn normalize_sub_agent_mode(value: Option<Value>, setting: Option<String>) -> String {
    let raw = value
        .as_ref()
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(setting);
    match raw.as_deref() {
        Some("auto") => "auto".to_string(),
        Some("off") => "off".to_string(),
        _ => "off".to_string(),
    }
}

fn normalize_project_memory_mode(value: Option<Value>, setting: Option<String>) -> String {
    let raw = value
        .as_ref()
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(setting);
    match raw.as_deref() {
        Some("auto") => "auto".to_string(),
        Some("confirm") => "confirm".to_string(),
        _ => "confirm".to_string(),
    }
}

fn normalize_sub_agent_max_parallel(value: Option<Value>, setting: Option<String>) -> u64 {
    let numeric = value
        .as_ref()
        .and_then(Value::as_u64)
        .or_else(|| {
            value
                .as_ref()
                .and_then(Value::as_str)
                .and_then(|item| item.parse::<u64>().ok())
        })
        .or_else(|| setting.and_then(|item| item.parse::<u64>().ok()))
        .unwrap_or(2);
    numeric.clamp(2, 2)
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

    if let Some(run_status) = result.get("runStatus").and_then(Value::as_str) {
        match run_status {
            "waiting" => {
                let message = result
                    .get("terminalReason")
                    .and_then(Value::as_str)
                    .unwrap_or("Session run is waiting for user input.")
                    .to_string();
                let _ = set_run_terminal(state, run_id, "waiting", Some(message), None);
                return;
            }
            "failed" => {
                let message = result
                    .get("terminalReason")
                    .and_then(Value::as_str)
                    .unwrap_or("Session run failed.")
                    .to_string();
                let _ = set_run_terminal(state, run_id, "failed", Some(message), None);
                return;
            }
            "cancelled" => {
                let message = result
                    .get("terminalReason")
                    .and_then(Value::as_str)
                    .unwrap_or("Session run is cancelled.")
                    .to_string();
                let _ = set_run_terminal(state, run_id, "cancelled", Some(message), None);
                return;
            }
            "completed" => {}
            _ => {}
        }
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
        RunProjectionLifecycle::Cancelled(message) => {
            let _ = set_run_terminal(state, run_id, "cancelled", Some(message), None);
        }
        RunProjectionLifecycle::Failed(message) => {
            let _ = set_run_terminal(state, run_id, "failed", Some(message), None);
        }
    }
}

#[derive(Debug, PartialEq)]
enum RunProjectionLifecycle {
    Completed(Option<String>),
    Waiting(String),
    Cancelled(String),
    Failed(String),
}

fn projection_lifecycle(
    state: &AppState,
    session_id: &str,
    start_event_count: usize,
) -> Option<RunProjectionLifecycle> {
    let events = session_projection(state, session_id);
    projection_lifecycle_from_events(&events, start_event_count)
}

fn projection_lifecycle_from_events(
    events: &[Value],
    start_event_count: usize,
) -> Option<RunProjectionLifecycle> {
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
        if let Some(message) = session_run_cancelled_message(event) {
            lifecycle = Some(RunProjectionLifecycle::Cancelled(message));
            continue;
        }
        if event_consumes_waiting_lifecycle(event) {
            lifecycle = None;
            continue;
        }
        if waiting_for_user_message(event).is_some() {
            lifecycle = waiting_for_user_message(event).map(RunProjectionLifecycle::Waiting);
        }
    }
    lifecycle
}

fn event_consumes_waiting_lifecycle(event: &Value) -> bool {
    match event.get("kind").and_then(Value::as_str) {
        Some("requirement_decision") | Some("permission_decision") => true,
        Some("session_run_state") => {
            event
                .get("payload")
                .and_then(|payload| payload.get("status"))
                .and_then(Value::as_str)
                == Some("running")
        }
        Some("plan_review") => event
            .get("payload")
            .and_then(|payload| payload.get("status"))
            .and_then(Value::as_str)
            .map(|status| {
                let status = status.to_ascii_lowercase();
                status == "accepted" || status == "rejected" || status == "needsrevision"
            })
            .unwrap_or(false),
        Some("review_summary") => event
            .get("payload")
            .and_then(|payload| payload.get("status"))
            .and_then(Value::as_str)
            .map(|status| {
                let status = status.to_ascii_lowercase();
                status != "waitinguserreview" && status != "pending"
            })
            .unwrap_or(false),
        _ => false,
    }
}

fn session_run_completed(event: &Value) -> bool {
    event.get("kind").and_then(Value::as_str) == Some("session_run_state")
        && event
            .get("payload")
            .and_then(|payload| payload.get("status"))
            .and_then(Value::as_str)
            == Some("completed")
}

fn session_run_cancelled_message(event: &Value) -> Option<String> {
    if event.get("kind").and_then(Value::as_str) != Some("session_run_state") {
        return None;
    }
    let status = event
        .get("payload")
        .and_then(|payload| payload.get("status"))
        .and_then(Value::as_str)?;
    if status != "cancelled" {
        return None;
    }
    Some(event_message(event).unwrap_or_else(|| "Session run is cancelled.".to_string()))
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

fn normalize_run_delta(
    session_id: &str,
    host_run_id: &str,
    delta_seq: u64,
    mut delta: Value,
) -> Value {
    if let Value::Object(object) = &mut delta {
        object
            .entry("sessionId".to_string())
            .or_insert_with(|| json!(session_id));
        object
            .entry("hostRunId".to_string())
            .or_insert_with(|| json!(host_run_id));
        object
            .entry("deltaSeq".to_string())
            .or_insert_with(|| json!(delta_seq));
        object
            .entry("receivedAt".to_string())
            .or_insert_with(|| json!(now_text()));
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
    Ok(bytes::Bytes::from(format!(
        "event: {event}\ndata: {data}\n\n"
    )))
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
    let tool_catalog_snapshot = deepcode_kernel_runtime::kernel_tool_catalog_snapshot();
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
            let tools = tool_catalog_snapshot
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.tool_id,
                        "description": format!("Kernel tool {} ({})", tool.tool_id, tool.capability),
                        "inputSchema": &tool.provider_schema,
                        "riskLevel": tool.risk.as_str(),
                        "needsApproval": tool.permission_mode.as_str() != "allow",
                        "allowedModes": ["readOnly", "plan", "askBeforeWrite"],
                        "capability": tool.capability,
                        "family": tool.family,
                        "operationKind": tool.operation_kind,
                        "permissionMode": tool.permission_mode,
                        "pathScopePolicy": tool.path_scope_policy,
                        "executionMode": tool.execution_mode,
                        "readOnly": tool.read_only,
                        "catalogVersion": tool_catalog_snapshot.catalog_version,
                        "catalogHash": &tool_catalog_snapshot.catalog_hash
                    })
                })
                .collect::<Vec<_>>();
            ApiResponse::ok(json!({
                "skills": skills,
                "tools": tools,
                "catalogVersion": deepcode_kernel_runtime::TOOL_CATALOG_VERSION,
                "catalogHash": &tool_catalog_snapshot.catalog_hash,
                "toolCatalog": tool_catalog_snapshot
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

pub(crate) fn remove_session_memory_archive(
    memory_root: &FsPath,
    workspace_scope_key: &str,
    safe_session_id: &str,
    session_id: &str,
) -> Value {
    let safe_scope_key = safe_path_segment(workspace_scope_key);
    let archive_dir = memory_root.join(&safe_scope_key);
    let sessions_dir = archive_dir.join("sessions");
    let targets = [
        sessions_dir.join(format!("{safe_session_id}.md")),
        sessions_dir.join(format!("{safe_session_id}.memory.json")),
    ];
    let mut removed_files = Vec::new();
    let mut missing_files = Vec::new();
    let mut errors = Vec::new();

    for target in targets {
        let display_path = target
            .strip_prefix(memory_root)
            .unwrap_or(target.as_path())
            .to_string_lossy()
            .to_string();
        if !target.starts_with(&sessions_dir) {
            errors.push(json!({
                "path": display_path,
                "code": "memory_cleanup_path_out_of_scope"
            }));
            continue;
        }
        if !target.exists() {
            missing_files.push(json!(display_path));
            continue;
        }
        match fs::remove_file(&target) {
            Ok(()) => removed_files.push(json!(display_path)),
            Err(error) => errors.push(json!({
                "path": display_path,
                "code": "memory_cleanup_remove_failed",
                "message": error.to_string()
            })),
        }
    }

    let project_archive_needs_refresh = !removed_files.is_empty();
    let manifest = append_session_memory_cleanup_manifest(
        &archive_dir,
        session_id,
        safe_session_id,
        &removed_files,
        &missing_files,
        &errors,
        project_archive_needs_refresh,
    );

    json!({
        "workspaceScopeKey": safe_scope_key,
        "sessionId": session_id,
        "safeSessionId": safe_session_id,
        "removedFiles": removed_files,
        "missingFiles": missing_files,
        "errors": errors,
        "projectArchiveNeedsRefresh": project_archive_needs_refresh,
        "manifestUpdated": manifest.get("updated").and_then(Value::as_bool).unwrap_or(false),
        "manifestError": manifest.get("error").cloned().unwrap_or(Value::Null)
    })
}

fn append_session_memory_cleanup_manifest(
    archive_dir: &FsPath,
    session_id: &str,
    safe_session_id: &str,
    removed_files: &[Value],
    missing_files: &[Value],
    errors: &[Value],
    project_archive_needs_refresh: bool,
) -> Value {
    if !archive_dir.exists() {
        return json!({
            "updated": false,
            "error": null
        });
    }
    let manifest_path = archive_dir.join("manifest.json");
    let mut manifest = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| {
            json!({
                "schemaVersion": "deepcode.session.memory-archive-manifest.v1",
                "archivePath": archive_dir.to_string_lossy()
            })
        });
    if !manifest.is_object() {
        manifest = json!({
            "schemaVersion": "deepcode.session.memory-archive-manifest.v1",
            "archivePath": archive_dir.to_string_lossy()
        });
    }

    let cleanup_event = json!({
        "event": "session_memory_removed",
        "sessionId": session_id,
        "safeSessionId": safe_session_id,
        "removedAt": now_text(),
        "removedFiles": removed_files,
        "missingFiles": missing_files,
        "errors": errors,
        "projectArchiveNeedsRefresh": project_archive_needs_refresh
    });

    if let Some(object) = manifest.as_object_mut() {
        object.insert(
            "projectArchiveNeedsRefresh".to_string(),
            json!(project_archive_needs_refresh),
        );
        if let Some(array) = object
            .get_mut("cleanupEvents")
            .and_then(Value::as_array_mut)
        {
            array.push(cleanup_event);
        } else {
            object.insert("cleanupEvents".to_string(), json!([cleanup_event]));
        }
        object.insert("updatedAt".to_string(), json!(now_text()));
    }

    match serde_json::to_string_pretty(&manifest) {
        Ok(content) => match fs::write(&manifest_path, content) {
            Ok(()) => json!({
                "updated": true,
                "error": null
            }),
            Err(error) => json!({
                "updated": false,
                "error": error.to_string()
            }),
        },
        Err(error) => json!({
            "updated": false,
            "error": error.to_string()
        }),
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
    fn cancelled_lifecycle_uses_explicit_session_run_state() {
        let event = json!({
            "kind": "session_run_state",
            "payload": {
                "status": "cancelled",
                "reason": "review",
                "summary": "Session run cancelled by user.",
                "visibility": "debug"
            }
        });
        assert_eq!(
            session_run_cancelled_message(&event).as_deref(),
            Some("Session run cancelled by user.")
        );
        assert!(!session_run_completed(&event));
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
    fn running_state_consumes_prior_waiting_lifecycle() {
        let events = vec![
            json!({
                "kind": "session_run_state",
                "payload": {
                    "status": "waiting",
                    "reason": "requirement",
                    "summary": "Session run is waiting for requirement confirmation."
                }
            }),
            json!({
                "kind": "requirement_decision",
                "payload": {
                    "requirementId": "requirement-1",
                    "decision": "accept"
                }
            }),
            json!({
                "kind": "plan_card",
                "payload": {
                    "planId": "plan-1",
                    "status": "awaitingTemporaryGrant",
                    "confirmable": true
                }
            }),
            json!({
                "kind": "plan_review",
                "payload": {
                    "planId": "plan-1",
                    "status": "accepted",
                    "confirmable": false
                }
            }),
            json!({
                "kind": "session_run_state",
                "payload": {
                    "status": "running",
                    "reason": "accepted_plan_execution",
                    "summary": "Accepted plan execution started."
                }
            }),
        ];
        assert_eq!(projection_lifecycle_from_events(&events, 0), None);
    }

    #[test]
    fn overlay_decision_allows_later_plan_waiting_lifecycle() {
        let events = vec![
            json!({
                "kind": "requirement_confirmation",
                "payload": {
                    "requirementId": "requirement-1",
                    "status": "waitingUserConfirmation"
                }
            }),
            json!({
                "kind": "requirement_decision",
                "payload": {
                    "requirementId": "requirement-1",
                    "decision": "accept"
                }
            }),
            json!({
                "kind": "plan_card",
                "payload": {
                    "planId": "plan-1",
                    "status": "awaitingTemporaryGrant",
                    "confirmable": true
                }
            }),
        ];
        assert_eq!(
            projection_lifecycle_from_events(&events, 0),
            Some(RunProjectionLifecycle::Waiting(
                "Session run is waiting for plan review.".to_string()
            ))
        );
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
    fn sub_agent_runtime_settings_are_forwarded_to_host_bridge() {
        let body = AgentSessionRunRequest {
            content: Some("test request".to_string()),
            project_memory_mode: Some(json!("auto")),
            sub_agent_mode: Some(json!("auto")),
            sub_agent_max_parallel: Some(json!("2")),
            ..Default::default()
        };
        let request = host_bridge_request(
            "session-subagent-forward",
            "run-subagent-forward",
            &body,
            Some("medium".to_string()),
            normalize_project_memory_mode(body.project_memory_mode.clone(), None),
            normalize_sub_agent_mode(body.sub_agent_mode.clone(), None),
            normalize_sub_agent_max_parallel(body.sub_agent_max_parallel.clone(), None),
        );
        assert_eq!(
            request.get("projectMemoryMode").and_then(Value::as_str),
            Some("auto")
        );
        assert_eq!(
            request.get("subAgentMode").and_then(Value::as_str),
            Some("auto")
        );
        assert_eq!(
            request.get("subAgentMaxParallel").and_then(Value::as_u64),
            Some(2)
        );
    }

    #[test]
    fn missing_or_invalid_sub_agent_mode_defaults_to_off() {
        assert_eq!(normalize_sub_agent_mode(None, None), "off");
        assert_eq!(normalize_project_memory_mode(None, None), "confirm");
        assert_eq!(
            normalize_project_memory_mode(Some(json!("invalid")), None),
            "confirm"
        );
        assert_eq!(
            normalize_project_memory_mode(None, Some("auto".to_string())),
            "auto"
        );
        assert_eq!(
            normalize_sub_agent_mode(Some(json!("invalid")), None),
            "off"
        );
        assert_eq!(
            normalize_sub_agent_mode(None, Some("auto".to_string())),
            "auto"
        );
        assert_eq!(
            normalize_sub_agent_mode(None, Some("off".to_string())),
            "off"
        );
        assert_eq!(normalize_sub_agent_max_parallel(None, None), 2);
        assert_eq!(
            normalize_sub_agent_max_parallel(Some(json!("invalid")), None),
            2
        );
        assert_eq!(normalize_sub_agent_max_parallel(Some(json!(16)), None), 2);
    }

    #[test]
    fn run_delta_normalization_attaches_monotonic_stream_cursor_fields() {
        let delta = normalize_run_delta(
            "session-generic",
            "run-generic",
            7,
            json!({
                "kind": "stage_delta",
                "payload": {
                    "status": "streaming"
                }
            }),
        );
        assert_eq!(
            delta.get("sessionId").and_then(Value::as_str),
            Some("session-generic")
        );
        assert_eq!(
            delta.get("hostRunId").and_then(Value::as_str),
            Some("run-generic")
        );
        assert_eq!(delta.get("deltaSeq").and_then(Value::as_u64), Some(7));
        assert!(delta.get("receivedAt").and_then(Value::as_str).is_some());
    }

    #[test]
    fn session_memory_cleanup_removes_only_target_session_files() {
        let root =
            std::env::temp_dir().join(format!("deepcode-agent-memory-cleanup-{}", now_millis()));
        let memory_root = root.join("memory").join("projects");
        let scope_key = format!("workspace-{}", now_millis());
        let session_id = format!("session-{}", now_millis());
        let other_session_id = format!("session-{}-other", now_millis());
        let safe_session = safe_path_segment(&session_id);
        let safe_other_session = safe_path_segment(&other_session_id);
        let archive_dir = memory_root.join(&scope_key);
        let sessions_dir = archive_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).expect("create session memory dir");
        fs::write(archive_dir.join("project.md"), "project memory").expect("project markdown");
        fs::write(
            archive_dir.join("manifest.json"),
            serde_json::to_string_pretty(&json!({
                "schemaVersion": "deepcode.session.memory-archive-manifest.v1",
                "workspaceScopeKey": scope_key,
                "cleanupEvents": []
            }))
            .expect("manifest json"),
        )
        .expect("manifest");
        fs::write(
            sessions_dir.join(format!("{safe_session}.md")),
            "session markdown",
        )
        .expect("session markdown");
        fs::write(
            sessions_dir.join(format!("{safe_session}.memory.json")),
            "{}",
        )
        .expect("session sidecar");
        fs::write(
            sessions_dir.join(format!("{safe_other_session}.md")),
            "other session markdown",
        )
        .expect("other session markdown");
        fs::write(
            sessions_dir.join(format!("{safe_other_session}.memory.json")),
            "{}",
        )
        .expect("other session sidecar");

        let cleanup =
            remove_session_memory_archive(&memory_root, &scope_key, &safe_session, &session_id);
        assert_eq!(
            cleanup.get("workspaceScopeKey").and_then(Value::as_str),
            Some(scope_key.as_str())
        );
        assert_eq!(
            cleanup
                .get("removedFiles")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        assert_eq!(
            cleanup
                .get("projectArchiveNeedsRefresh")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(!sessions_dir.join(format!("{safe_session}.md")).exists());
        assert!(!sessions_dir
            .join(format!("{safe_session}.memory.json"))
            .exists());
        assert!(sessions_dir
            .join(format!("{safe_other_session}.md"))
            .exists());
        assert!(sessions_dir
            .join(format!("{safe_other_session}.memory.json"))
            .exists());

        let manifest_content =
            fs::read_to_string(archive_dir.join("manifest.json")).expect("manifest content");
        let manifest: Value = serde_json::from_str(&manifest_content).expect("manifest json");
        let cleanup_events = manifest
            .get("cleanupEvents")
            .and_then(Value::as_array)
            .expect("cleanup events");
        assert_eq!(cleanup_events.len(), 1);
        assert_eq!(
            cleanup_events[0].get("event").and_then(Value::as_str),
            Some("session_memory_removed")
        );
        assert_eq!(
            cleanup_events[0].get("sessionId").and_then(Value::as_str),
            Some(session_id.as_str())
        );

        let _ = fs::remove_dir_all(root);
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
