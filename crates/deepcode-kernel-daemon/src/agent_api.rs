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
    pub(crate) interaction_id: Option<String>,
    pub(crate) interaction_revision: Option<String>,
    pub(crate) decision_request_id: Option<String>,
    pub(crate) review_id: Option<String>,
    pub(crate) host_language: Option<String>,
    pub(crate) goal_id: Option<String>,
    pub(crate) goal_revision: Option<u64>,
    pub(crate) objective: Option<String>,
    pub(crate) caller_request_id: Option<String>,
    pub(crate) request_digest: Option<String>,
    pub(crate) expected_domain_head_digest: Option<String>,
    pub(crate) predecessor_goal_ref: Option<Value>,
    #[serde(skip)]
    pub(crate) admitted_domain_head_digest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRunStreamQuery {
    pub(crate) since_event_count: Option<usize>,
    pub(crate) since_delta_seq: Option<u64>,
}

fn session_run_start_admission_lock(session_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::sync::{Arc, Mutex, OnceLock, Weak};

    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().expect("Session run start lock registry");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(session_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(session_id.to_string(), Arc::downgrade(&lock));
    lock
}

pub(crate) async fn agent_session_run_start(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<AgentSessionRunRequest>,
) -> Json<ApiResponse> {
    let Some((session, _events)) = session_payload(&state, &session_id) else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    if !session_schema_is_compatible(&session) {
        return incompatible_session_response();
    }
    let run_start_lock = session_run_start_admission_lock(&session_id);
    let _run_start_guard = run_start_lock.lock_owned().await;
    if body.decision_kind.is_some() {
        return match resolve_agent_kernel_decision_v2(&state, &session_id, &body).await {
            Ok(host_run_id) => run_response(&state, &session_id, &host_run_id),
            Err(error) => ApiResponse::error(error.code, error.message),
        };
    }
    if body.run_id.is_some() {
        return ApiResponse::error(
            "session_interaction_identity_required",
            "runId is accepted only for an exact Kernel–Session v2 decision.",
        );
    }
    if !matches!(body.op.as_deref(), None | Some("ask")) {
        return ApiResponse::error(
            "session_operation_v2_unsupported",
            "Only a new ask or an exact Plan/capability decision can enter the v2 Run path.",
        );
    }
    match state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(&session_id)
    {
        Ok(Some(active)) => {
            return ApiResponse::error(
                "session_run_already_active",
                format!(
                    "Session already has durable active Run {}; send user input or resolve its exact pending decision",
                    active.host_run_id
                ),
            )
        }
        Ok(None) => {}
        Err(error) => return ApiResponse::error(error.code, error.message),
    }
    let project_context = match authoritative_project_run_context(&state, &session, false) {
        Ok(context) => context,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    if let Some(binding) = project_context
        .as_ref()
        .and_then(|context| context.get("workspaceBinding"))
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
    let profile_id = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let llm_profiles = gui.llm_profiles.clone();
        let Some(stored_session) = session_mut(&mut gui, &session_id) else {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        };
        let stored_profile_id = stored_session
            .get("profileId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let profile_id = stored_profile_id
            .as_deref()
            .filter(|profile_id| llm_profile_is_enabled(&llm_profiles, profile_id))
            .map(str::to_string)
            .or_else(|| preferred_enabled_llm_profile_id(&llm_profiles));
        let Some(profile_id) = profile_id else {
            return ApiResponse::error(
                "llm_profile_unavailable",
                "no enabled LLM Profile is available for this session",
            );
        };
        if stored_profile_id.as_deref() != Some(profile_id.as_str()) {
            stored_session["profileId"] = json!(profile_id.clone());
            stored_session["updatedAt"] = json!(now_text());
            if let Err(error) = persist_session_index(&gui) {
                return ApiResponse::error("agent_session_persist_failed", error);
            }
        }
        profile_id
    };
    let start_event_count = session_projection(&state, &session_id).len();
    match open_agent_kernel_run_v2(
        &state,
        &session_id,
        &body,
        &profile_id,
        project_context.as_ref(),
        start_event_count,
    )
    .await
    {
        Ok(host_run_id) => run_response(&state, &session_id, &host_run_id),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn agent_session_run_get(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    if run_belongs_to_session(&state, &session_id, &run_id) {
        return run_response(&state, &session_id, &run_id);
    }
    match restore_agent_kernel_run_cache_v2(&state, &session_id, &run_id) {
        Ok(host_run_id) => run_response(&state, &session_id, &host_run_id),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn agent_session_run_cancel(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    match retire_agent_kernel_run_v2(
        &state,
        &session_id,
        Some(&run_id),
        "cancelled",
        "Kernel–Session v2 Run cancelled and its owned resources were retired.",
    )
    .await
    {
        Ok(Some(host_run_id)) => run_response(&state, &session_id, &host_run_id),
        Ok(None) => ApiResponse::error("agent_run_not_found", "agent run not found"),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn agent_session_run_delta(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(mut body): Json<Value>,
) -> Json<ApiResponse> {
    if !run_belongs_to_session(&state, &session_id, &run_id) {
        return ApiResponse::error("agent_run_not_found", "agent run not found");
    }
    canonicalize_projection_safe_integers(&mut body);
    if let Err(message) = validate_agent_timeline_delta(&state, &session_id, &body) {
        record_daemon_projection_delivery(
            &state,
            &session_id,
            &run_id,
            "daemon.timeline_delta_received",
            Some(&body),
            "rejected",
            true,
        );
        return ApiResponse::error("agent_timeline_delta_invalid", message);
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
    match submit_agent_kernel_user_input_v2(&state, &session_id, &run_id, &body).await {
        Ok(host_run_id) => run_response(&state, &session_id, &host_run_id),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
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
    if let Err(error) = retire_agent_kernel_run_v2(
        &state,
        &session_id,
        None,
        "cancelled",
        "Kernel–Session v2 Run cancelled and its owned resources were retired.",
    )
    .await
    {
        return ApiResponse::error(error.code, error.message);
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
    match resolve_global_agent_permission_v2(&state, &permission_id, &body).await {
        Ok(session_id) => {
            let gui = state.gui.lock().expect("gui state lock");
            session_result(&gui, &session_id)
        }
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

#[cfg(test)]
#[path = "agent_api_tests.rs"]
mod tests;
