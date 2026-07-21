use crate::prelude::*;
use crate::*;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionScopeQuery {
    pub(crate) project_id: Option<String>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) workspace_hash: Option<String>,
    pub(crate) include_archived: Option<bool>,
    pub(crate) include_all_scopes: Option<bool>,
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
    pub(crate) autonomy_mode: Option<String>,
    pub(crate) project_memory_mode: Option<Value>,
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

pub(crate) async fn agent_session_run_start(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<AgentSessionRunRequest>,
) -> Json<ApiResponse> {
    let Some((session, events)) = session_payload(&state, &session_id) else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    if !session_schema_is_compatible(&session) {
        return incompatible_session_response();
    }
    let continuing_run = body.run_id.is_some() || body.decision_kind.is_some();
    let project_context = match authoritative_project_run_context(&state, &session, continuing_run)
    {
        Ok(context) => context,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    if !continuing_run {
        if let Some(context) = project_context.as_ref() {
            if let Some(binding) = context
                .get("workspaceBinding")
                .filter(|value| value.is_object())
            {
                let mut gui = state.gui.lock().expect("gui state lock");
                if let Some(stored_session) = session_mut(&mut gui, &session_id) {
                    stored_session["workspaceBinding"] = binding.clone();
                    apply_workspace_binding_to_session(stored_session, binding);
                    stored_session["updatedAt"] = json!(now_text());
                }
                if let Err(error) = persist_session_index(&gui) {
                    return ApiResponse::error("agent_session_persist_failed", error);
                }
            }
        }
    }
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
    let autonomy_mode = body
        .autonomy_mode
        .clone()
        .or_else(|| user_setting_string(&state, "agent.permissions.autonomyMode"))
        .unwrap_or_else(|| "strict".to_string());
    let request = host_bridge_request(
        &session_id,
        &run_id,
        &body,
        intervention_level,
        project_memory_mode,
        autonomy_mode,
        project_context.as_ref(),
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
    request_run_cancellation(&state, &run_id);
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
    record_daemon_projection_delivery(
        &state,
        &session_id,
        &run_id,
        "daemon.timeline_delta_received",
        Some(&body),
        "accepted",
        false,
    );
    let normalized_delta = {
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
        queue.last().cloned().unwrap_or(Value::Null)
    };
    record_daemon_projection_delivery(
        &state,
        &session_id,
        &run_id,
        "daemon.timeline_delta_enqueued",
        Some(&normalized_delta),
        "accepted",
        false,
    );
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
                record_daemon_projection_delivery(
                    &stream_state,
                    &session_id,
                    &run_id,
                    "daemon.sse_delta_sent",
                    Some(delta),
                    "sent",
                    false,
                );
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
                let (terminal_events, terminal_event_count) =
                    terminal_stream_event_tail(&events, sent_event_count);
                sent_event_count = terminal_event_count;
                record_daemon_projection_delivery(
                    &stream_state,
                    &session_id,
                    &run_id,
                    "daemon.sse_terminal_sent",
                    None,
                    "sent",
                    true,
                );
                flush_daemon_projection_delivery_terminal(&stream_state, &run_id).await;
                yield sse_bytes("terminal", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "run": run.clone(),
                    "events": terminal_events,
                    "eventCount": sent_event_count
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
        request_run_cancellation(&state, &run_id);
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

#[cfg(test)]
#[path = "agent_api_tests.rs"]
mod tests;
