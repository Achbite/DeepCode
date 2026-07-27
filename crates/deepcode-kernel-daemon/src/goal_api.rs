use crate::prelude::*;
use crate::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoalStartRequest {
    caller_request_id: String,
    expected_goal_revision: u64,
    expected_domain_head: Value,
    objective: String,
    workspace_path: Option<String>,
    no_workspace: Option<bool>,
    host_language: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoalInteractionResolveRequest {
    caller_request_id: String,
    expected_goal_revision: u64,
    expected_domain_head: Value,
    interaction_revision: String,
    target_id: String,
    run_id: String,
    decision_kind: String,
    decision: String,
    guidance: Option<String>,
    workspace_path: Option<String>,
    no_workspace: Option<bool>,
    host_language: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoalMutationRequest {
    caller_request_id: String,
    expected_goal_revision: u64,
    expected_domain_head: Value,
    workspace_path: Option<String>,
    no_workspace: Option<bool>,
    host_language: Option<String>,
}

#[derive(Clone)]
struct CachedGoalProjection {
    head_digest: String,
    projection: Value,
}

fn goal_projection_cache() -> &'static Mutex<HashMap<String, CachedGoalProjection>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, CachedGoalProjection>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn goal_cache_key(
    sessions_dir: &FsPath,
    session_id: &str,
    goal_id: Option<&str>,
) -> String {
    format!(
        "{}\u{1f}{session_id}\u{1f}{}",
        sessions_dir.to_string_lossy(),
        goal_id.unwrap_or("<current>")
    )
}

pub(crate) fn invalidate_session_goal_projection_cache(
    sessions_dir: &FsPath,
    session_id: &str,
) {
    let prefix = format!("{}\u{1f}{session_id}\u{1f}", sessions_dir.to_string_lossy());
    goal_projection_cache()
        .lock()
        .expect("Goal projection cache lock")
        .retain(|key, _| !key.starts_with(&prefix));
}

pub(crate) async fn agent_session_goal_start(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<GoalStartRequest>,
) -> Json<ApiResponse> {
    if let Err(message) = validate_goal_request_identity(&body.caller_request_id) {
        return ApiResponse::error("session_goal_request_invalid", message);
    }
    let objective = body.objective.trim();
    if objective.is_empty() {
        return ApiResponse::error(
            "session_goal_request_invalid",
            "Goal objective must not be empty",
        );
    }
    if body.expected_goal_revision != 0 {
        return ApiResponse::error(
            "session_goal_revision_conflict",
            "Goal start requires expectedGoalRevision=0",
        );
    }
    let request_value = match serde_json::to_value(&body) {
        Ok(value) => value,
        Err(error) => {
            return ApiResponse::error(
                "session_goal_request_invalid",
                format!("Goal start request cannot be encoded: {error}"),
            )
        }
    };
    let request_digest = goal_request_digest("start", &request_value);
    let events = session_projection(&state, &session_id);
    if let Some(replay) = goal_command_replay(&events, &body.caller_request_id) {
        if replay.request_digest != request_digest {
            return ApiResponse::error(
                "session_goal_request_conflict",
                "Goal caller request ID was already used with different content",
            );
        }
        if !replay.settled {
            let Some(host_run_id) = replay.host_run_id.as_deref() else {
                return ApiResponse::error(
                    "session_goal_recovery_required",
                    "Goal advance admission has no recoverable Host run identity",
                );
            };
            if let Err(error) =
                await_goal_host_run_terminal(&state, &session_id, host_run_id).await
            {
                return ApiResponse::error(error.code, error.message);
            }
            let settled = goal_command_replay(
                &session_projection(&state, &session_id),
                &body.caller_request_id,
            )
            .is_some_and(|candidate| {
                candidate.request_digest == request_digest && candidate.settled
            });
            if !settled {
                return ApiResponse::error(
                    "session_goal_recovery_required",
                    "Goal advance Host run stopped without a canonical Goal settlement",
                );
            }
        }
        return goal_replay_response(
            &state,
            &session_id,
            &replay.goal_id,
            "start",
            Some(&body.caller_request_id),
            Some(&request_digest),
            replay.host_run_id.as_deref(),
            true,
        )
        .await;
    }
    let domain = match exact_goal_domain_state(
        &state,
        &session_id,
        &body.expected_domain_head,
    ) {
        Ok(domain) => domain,
        Err(response) => return response,
    };
    if domain
        .get("goalSlot")
        .and_then(|slot| slot.get("state"))
        .and_then(Value::as_str)
        != Some("empty")
    {
        return ApiResponse::error(
            "session_goal_already_active",
            "Session already has an active Goal",
        );
    }
    let predecessor_goal_ref = domain
        .pointer("/goalSlot/lastTerminalGoalRef")
        .filter(|value| value.is_object())
        .map(|value| {
            json!({
                "goalId": value.get("goalId").cloned(),
                "goalRevision": value.get("goalRevision").cloned(),
            })
        });
    let goal_id = new_goal_id();
    let expected_head_digest = domain
        .pointer("/head/headDigest")
        .and_then(Value::as_str)
        .expect("exact Goal domain state has a head digest")
        .to_string();
    let run_request = AgentSessionRunRequest {
        op: Some("startGoal".to_string()),
        content: Some(objective.to_string()),
        prompt: Some(objective.to_string()),
        workspace_path: body.workspace_path,
        no_workspace: body.no_workspace,
        workflow: Some("planFirst".to_string()),
        host_language: body.host_language,
        goal_id: Some(goal_id.clone()),
        goal_revision: Some(1),
        objective: Some(objective.to_string()),
        caller_request_id: Some(body.caller_request_id.clone()),
        request_digest: Some(request_digest.clone()),
        expected_domain_head_digest: Some(expected_head_digest),
        predecessor_goal_ref,
        ..AgentSessionRunRequest::default()
    };
    let started = agent_session_run_start(
        State(state.clone()),
        Path(session_id.clone()),
        Json(run_request),
    )
    .await;
    if !started.0.ok {
        return started;
    }
    let host_run_id = started
        .0
        .data
        .as_ref()
        .and_then(|value| value.pointer("/run/runId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    goal_replay_response(
        &state,
        &session_id,
        &goal_id,
        "start",
        Some(&body.caller_request_id),
        Some(&request_digest),
        host_run_id.as_deref(),
        false,
    )
    .await
}

pub(crate) async fn agent_session_goal_current(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    goal_read_response(&state, &session_id, None).await
}

pub(crate) async fn agent_session_goal_get(
    State(state): State<AppState>,
    Path((session_id, goal_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    goal_read_response(&state, &session_id, Some(&goal_id)).await
}

pub(crate) async fn agent_session_goal_interaction_resolve(
    State(state): State<AppState>,
    Path((session_id, goal_id, interaction_id)): Path<(String, String, String)>,
    Json(body): Json<GoalInteractionResolveRequest>,
) -> Json<ApiResponse> {
    if let Err(message) = validate_goal_request_identity(&body.caller_request_id) {
        return ApiResponse::error("session_goal_request_invalid", message);
    }
    let request_value = match serde_json::to_value(&body) {
        Ok(value) => value,
        Err(error) => {
            return ApiResponse::error(
                "session_goal_request_invalid",
                format!("Goal interaction request cannot be encoded: {error}"),
            )
        }
    };
    let request_digest = goal_request_digest("resolveInteraction", &request_value);
    let events = session_projection(&state, &session_id);
    if let Some(replay) = goal_command_replay(&events, &body.caller_request_id) {
        if replay.request_digest != request_digest {
            return ApiResponse::error(
                "session_goal_request_conflict",
                "Goal caller request ID was already used with different content",
            );
        }
        return goal_replay_response(
            &state,
            &session_id,
            &replay.goal_id,
            "resolveInteraction",
            Some(&body.caller_request_id),
            Some(&request_digest),
            replay.host_run_id.as_deref(),
            true,
        )
        .await;
    }
    let domain = match exact_goal_domain_state(
        &state,
        &session_id,
        &body.expected_domain_head,
    ) {
        Ok(domain) => domain,
        Err(response) => return response,
    };
    if body.expected_goal_revision == 0
        || domain.pointer("/goalSlot/state").and_then(Value::as_str) != Some("active")
        || domain.pointer("/goalSlot/goalId").and_then(Value::as_str) != Some(goal_id.as_str())
        || domain
            .pointer("/goalSlot/goalRevision")
            .and_then(Value::as_u64)
            != Some(body.expected_goal_revision)
    {
        return ApiResponse::error(
            "session_goal_revision_conflict",
            "Goal interaction no longer matches the active Goal revision",
        );
    }
    let projection = match read_goal_projection(&state, &session_id, Some(&goal_id)).await {
        Ok(Some(projection)) => projection,
        Ok(None) => {
            return ApiResponse::error("session_goal_not_found", "Goal projection is unavailable")
        }
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let pending = projection.get("pendingInteraction");
    if pending
        .and_then(|value| value.get("interactionId"))
        .and_then(Value::as_str)
        != Some(interaction_id.as_str())
        || pending
            .and_then(|value| value.get("interactionRevision"))
            .and_then(Value::as_str)
            != Some(body.interaction_revision.as_str())
        || pending
            .and_then(|value| value.get("targetId"))
            .and_then(Value::as_str)
            != Some(body.target_id.as_str())
        || pending
            .and_then(|value| value.get("runId"))
            .and_then(Value::as_str)
            != Some(body.run_id.as_str())
        || pending
            .and_then(|value| value.get("kind"))
            .and_then(Value::as_str)
            != Some(body.decision_kind.as_str())
    {
        return ApiResponse::error(
            "session_goal_interaction_mismatch",
            "Goal interaction identity changed before decision admission",
        );
    }
    let expected_head_digest = domain
        .pointer("/head/headDigest")
        .and_then(Value::as_str)
        .expect("exact Goal domain state has a head digest")
        .to_string();
    let run_request = AgentSessionRunRequest {
        op: Some("resolveGoalInteraction".to_string()),
        workspace_path: body.workspace_path,
        no_workspace: body.no_workspace,
        decision_kind: Some(body.decision_kind),
        decision: Some(body.decision),
        guidance: body.guidance,
        run_id: Some(body.run_id),
        target_id: Some(body.target_id),
        interaction_id: Some(interaction_id),
        interaction_revision: Some(body.interaction_revision),
        decision_request_id: Some(body.caller_request_id.clone()),
        host_language: body.host_language,
        goal_id: Some(goal_id.clone()),
        goal_revision: Some(body.expected_goal_revision),
        objective: projection
            .get("objective")
            .and_then(Value::as_str)
            .map(str::to_string),
        caller_request_id: Some(body.caller_request_id.clone()),
        request_digest: Some(request_digest.clone()),
        expected_domain_head_digest: Some(expected_head_digest),
        ..AgentSessionRunRequest::default()
    };
    let started = agent_session_run_start(
        State(state.clone()),
        Path(session_id.clone()),
        Json(run_request),
    )
    .await;
    if !started.0.ok {
        return started;
    }
    let host_run_id = started
        .0
        .data
        .as_ref()
        .and_then(|value| value.pointer("/run/runId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    goal_replay_response(
        &state,
        &session_id,
        &goal_id,
        "resolveInteraction",
        Some(&body.caller_request_id),
        Some(&request_digest),
        host_run_id.as_deref(),
        false,
    )
    .await
}

pub(crate) async fn agent_session_goal_advance(
    State(state): State<AppState>,
    Path((session_id, goal_id)): Path<(String, String)>,
    Json(body): Json<GoalMutationRequest>,
) -> Json<ApiResponse> {
    if let Err(message) = validate_goal_request_identity(&body.caller_request_id) {
        return ApiResponse::error("session_goal_request_invalid", message);
    }
    let request_value = match serde_json::to_value(&body) {
        Ok(value) => value,
        Err(error) => {
            return ApiResponse::error(
                "session_goal_request_invalid",
                format!("Goal advance request cannot be encoded: {error}"),
            )
        }
    };
    let request_digest = goal_request_digest("advance", &request_value);
    let events = session_projection(&state, &session_id);
    if let Some(replay) = goal_command_replay(&events, &body.caller_request_id) {
        if replay.request_digest != request_digest {
            return ApiResponse::error(
                "session_goal_request_conflict",
                "Goal caller request ID was already used with different content",
            );
        }
        if !replay.settled {
            let Some(host_run_id) = replay.host_run_id.as_deref() else {
                return ApiResponse::error(
                    "session_goal_recovery_required",
                    "Goal advance replay has no recoverable Host run identity",
                );
            };
            if let Err(error) =
                await_goal_host_run_terminal(&state, &session_id, host_run_id).await
            {
                return ApiResponse::error(error.code, error.message);
            }
            if !goal_command_replay(
                &session_projection(&state, &session_id),
                &body.caller_request_id,
            )
            .is_some_and(|candidate| {
                candidate.request_digest == request_digest && candidate.settled
            }) {
                return ApiResponse::error(
                    "session_goal_recovery_required",
                    "Goal advance replay stopped without canonical settlement",
                );
            }
        }
        return goal_replay_response(
            &state,
            &session_id,
            &replay.goal_id,
            "advance",
            Some(&body.caller_request_id),
            Some(&request_digest),
            replay.host_run_id.as_deref(),
            true,
        )
        .await;
    }
    let domain = match exact_goal_domain_state(
        &state,
        &session_id,
        &body.expected_domain_head,
    ) {
        Ok(domain) => domain,
        Err(response) => return response,
    };
    if body.expected_goal_revision == 0
        || domain.pointer("/goalSlot/state").and_then(Value::as_str) != Some("active")
        || domain.pointer("/goalSlot/goalId").and_then(Value::as_str)
            != Some(goal_id.as_str())
        || domain.pointer("/goalSlot/goalRevision").and_then(Value::as_u64)
            != Some(body.expected_goal_revision)
        || domain.pointer("/goalSlot/lifecycle").and_then(Value::as_str)
            != Some("running")
    {
        return ApiResponse::error(
            "session_goal_lifecycle_conflict",
            "Goal advance requires the exact active running Goal revision",
        );
    }
    let projection = match read_goal_projection(&state, &session_id, Some(&goal_id)).await {
        Ok(Some(projection)) => projection,
        Ok(None) => {
            return ApiResponse::error("session_goal_not_found", "Goal projection is unavailable")
        }
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    if projection.get("lifecycle").and_then(Value::as_str) != Some("running")
        || projection.get("pendingInteraction").is_some()
        || projection
            .pointer("/activeWait/value")
            .is_some_and(|value| !value.is_null())
    {
        return ApiResponse::error(
            "session_goal_lifecycle_conflict",
            "Goal advance is only admitted while running without an ActiveWait or pending interaction",
        );
    }
    let expected_head_digest = domain
        .pointer("/head/headDigest")
        .and_then(Value::as_str)
        .expect("exact Goal domain state has a head digest")
        .to_string();
    let run_request = AgentSessionRunRequest {
        op: Some("advanceGoal".to_string()),
        content: projection
            .get("objective")
            .and_then(Value::as_str)
            .map(str::to_string),
        workspace_path: body.workspace_path,
        no_workspace: body.no_workspace,
        host_language: body.host_language,
        goal_id: Some(goal_id.clone()),
        goal_revision: Some(body.expected_goal_revision),
        objective: projection
            .get("objective")
            .and_then(Value::as_str)
            .map(str::to_string),
        caller_request_id: Some(body.caller_request_id.clone()),
        request_digest: Some(request_digest.clone()),
        expected_domain_head_digest: Some(expected_head_digest),
        ..AgentSessionRunRequest::default()
    };
    let started = agent_session_run_start(
        State(state.clone()),
        Path(session_id.clone()),
        Json(run_request),
    )
    .await;
    if !started.0.ok {
        return started;
    }
    let host_run_id = started
        .0
        .data
        .as_ref()
        .and_then(|value| value.pointer("/run/runId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(host_run_id) = host_run_id else {
        return ApiResponse::error(
            "session_goal_recovery_required",
            "Goal advance started without an exact Host run identity",
        );
    };
    if let Err(error) = await_goal_host_run_terminal(&state, &session_id, &host_run_id).await {
        return ApiResponse::error(error.code, error.message);
    }
    let settled = goal_command_replay(
        &session_projection(&state, &session_id),
        &body.caller_request_id,
    )
    .is_some_and(|candidate| {
        candidate.request_digest == request_digest && candidate.settled
    });
    if !settled {
        return ApiResponse::error(
            "session_goal_recovery_required",
            "Goal advance Host run stopped without a canonical Goal settlement",
        );
    }
    goal_replay_response(
        &state,
        &session_id,
        &goal_id,
        "advance",
        Some(&body.caller_request_id),
        Some(&request_digest),
        Some(&host_run_id),
        false,
    )
    .await
}

pub(crate) async fn agent_session_goal_resume(
    State(state): State<AppState>,
    Path((session_id, goal_id)): Path<(String, String)>,
    Json(body): Json<GoalMutationRequest>,
) -> Json<ApiResponse> {
    agent_session_goal_lifecycle_mutation(
        state,
        session_id,
        goal_id,
        body,
        "resume",
    )
    .await
}

pub(crate) async fn agent_session_goal_cancel(
    State(state): State<AppState>,
    Path((session_id, goal_id)): Path<(String, String)>,
    Json(body): Json<GoalMutationRequest>,
) -> Json<ApiResponse> {
    agent_session_goal_lifecycle_mutation(
        state,
        session_id,
        goal_id,
        body,
        "cancel",
    )
    .await
}

async fn agent_session_goal_lifecycle_mutation(
    state: AppState,
    session_id: String,
    goal_id: String,
    body: GoalMutationRequest,
    operation: &'static str,
) -> Json<ApiResponse> {
    if let Err(message) = validate_goal_request_identity(&body.caller_request_id) {
        return ApiResponse::error("session_goal_request_invalid", message);
    }
    let request_value = match serde_json::to_value(&body) {
        Ok(value) => value,
        Err(error) => {
            return ApiResponse::error(
                "session_goal_request_invalid",
                format!("Goal {operation} request cannot be encoded: {error}"),
            )
        }
    };
    let request_digest = goal_request_digest(operation, &request_value);
    let events = session_projection(&state, &session_id);
    if let Some(replay) = goal_command_replay(&events, &body.caller_request_id) {
        if replay.request_digest != request_digest {
            return ApiResponse::error(
                "session_goal_request_conflict",
                "Goal caller request ID was already used with different content",
            );
        }
        if !replay.settled {
            let Some(host_run_id) = replay.host_run_id.as_deref() else {
                return ApiResponse::error(
                    "session_goal_recovery_required",
                    format!("Goal {operation} replay has no recoverable Host run identity"),
                );
            };
            if let Err(error) =
                await_goal_host_run_terminal(&state, &session_id, host_run_id).await
            {
                return ApiResponse::error(error.code, error.message);
            }
            if !goal_command_replay(
                &session_projection(&state, &session_id),
                &body.caller_request_id,
            )
            .is_some_and(|candidate| {
                candidate.request_digest == request_digest && candidate.settled
            }) {
                return ApiResponse::error(
                    "session_goal_recovery_required",
                    format!("Goal {operation} replay stopped without canonical settlement"),
                );
            }
        }
        return goal_replay_response(
            &state,
            &session_id,
            &replay.goal_id,
            operation,
            Some(&body.caller_request_id),
            Some(&request_digest),
            replay.host_run_id.as_deref(),
            true,
        )
        .await;
    }
    let domain = match exact_goal_domain_state(
        &state,
        &session_id,
        &body.expected_domain_head,
    ) {
        Ok(domain) => domain,
        Err(response) => return response,
    };
    let lifecycle = domain
        .pointer("/goalSlot/lifecycle")
        .and_then(Value::as_str);
    let lifecycle_allowed = match operation {
        "resume" => lifecycle == Some("suspended"),
        "cancel" => matches!(lifecycle, Some("running" | "suspended")),
        _ => false,
    };
    if body.expected_goal_revision == 0
        || domain.pointer("/goalSlot/state").and_then(Value::as_str) != Some("active")
        || domain.pointer("/goalSlot/goalId").and_then(Value::as_str)
            != Some(goal_id.as_str())
        || domain.pointer("/goalSlot/goalRevision").and_then(Value::as_u64)
            != Some(body.expected_goal_revision)
        || !lifecycle_allowed
    {
        return ApiResponse::error(
            "session_goal_lifecycle_conflict",
            format!("Goal {operation} requires the exact active Goal revision"),
        );
    }
    let projection = match read_goal_projection(&state, &session_id, Some(&goal_id)).await {
        Ok(Some(projection)) => projection,
        Ok(None) => {
            return ApiResponse::error("session_goal_not_found", "Goal projection is unavailable")
        }
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    if projection.get("lifecycle").and_then(Value::as_str) != lifecycle
        || projection.get("pendingInteraction").is_some()
        || projection.pointer("/checkpoint/status").and_then(Value::as_str)
            != Some("available")
    {
        return ApiResponse::error(
            "session_goal_lifecycle_conflict",
            format!(
                "Goal {operation} requires an exact checkpoint without a pending interaction"
            ),
        );
    }
    let pending_effect_state = latest_goal_pending_effect_state(
        &events,
        &goal_id,
        body.expected_goal_revision,
    );
    if operation == "resume" {
        let has_active_wait =
            projection.pointer("/activeWait/status").and_then(Value::as_str)
                == Some("available");
        let resumable =
            projection.pointer("/activeWait/value/resumable").and_then(Value::as_bool)
                == Some(true);
        if !has_active_wait
            || (!resumable && pending_effect_state.as_deref() != Some("dispatched"))
        {
            return ApiResponse::error(
                "session_goal_lifecycle_conflict",
                "Goal resume requires one checkpointed resumable ActiveWait or a dispatched effect eligible for read-only reconciliation",
            );
        }
    }
    if operation == "cancel"
        && matches!(
            pending_effect_state.as_deref(),
            Some("prepared" | "dispatched")
        )
    {
        return ApiResponse::error(
            "session_goal_lifecycle_conflict",
            "Goal cancel requires a safe checkpoint without an unobserved effect",
        );
    }
    let expected_head_digest = domain
        .pointer("/head/headDigest")
        .and_then(Value::as_str)
        .expect("exact Goal domain state has a head digest")
        .to_string();
    let run_request = AgentSessionRunRequest {
        op: Some(if operation == "resume" {
            "resumeGoal".to_string()
        } else {
            "cancelGoal".to_string()
        }),
        content: projection
            .get("objective")
            .and_then(Value::as_str)
            .map(str::to_string),
        workspace_path: body.workspace_path,
        no_workspace: body.no_workspace,
        host_language: body.host_language,
        goal_id: Some(goal_id.clone()),
        goal_revision: Some(body.expected_goal_revision),
        objective: projection
            .get("objective")
            .and_then(Value::as_str)
            .map(str::to_string),
        caller_request_id: Some(body.caller_request_id.clone()),
        request_digest: Some(request_digest.clone()),
        expected_domain_head_digest: Some(expected_head_digest),
        ..AgentSessionRunRequest::default()
    };
    let started = agent_session_run_start(
        State(state.clone()),
        Path(session_id.clone()),
        Json(run_request),
    )
    .await;
    if !started.0.ok {
        return started;
    }
    let host_run_id = started
        .0
        .data
        .as_ref()
        .and_then(|value| value.pointer("/run/runId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(host_run_id) = host_run_id else {
        return ApiResponse::error(
            "session_goal_recovery_required",
            format!("Goal {operation} started without an exact Host run identity"),
        );
    };
    if let Err(error) = await_goal_host_run_terminal(&state, &session_id, &host_run_id).await {
        return ApiResponse::error(error.code, error.message);
    }
    let settled = goal_command_replay(
        &session_projection(&state, &session_id),
        &body.caller_request_id,
    )
    .is_some_and(|candidate| {
        candidate.request_digest == request_digest && candidate.settled
    });
    if !settled {
        return ApiResponse::error(
            "session_goal_recovery_required",
            format!("Goal {operation} Host run stopped without canonical settlement"),
        );
    }
    goal_replay_response(
        &state,
        &session_id,
        &goal_id,
        operation,
        Some(&body.caller_request_id),
        Some(&request_digest),
        Some(&host_run_id),
        false,
    )
    .await
}

async fn goal_read_response(
    state: &AppState,
    session_id: &str,
    goal_id: Option<&str>,
) -> Json<ApiResponse> {
    match read_goal_projection(state, session_id, goal_id).await {
        Ok(projection) => {
            let source_domain_head = match projection
                .as_ref()
                .and_then(|value| value.get("sourceDomainHead"))
                .cloned()
            {
                Some(head) => head,
                None => match current_goal_domain_head(state, session_id) {
                    Ok(head) => head,
                    Err(error) => return ApiResponse::error(error.code, error.message),
                },
            };
            ApiResponse::ok(json!({
                "schemaVersion": "deepcode.session.goal-command-receipt.v1",
                "operation": "read",
                "sessionId": session_id,
                "goalId": projection.as_ref().and_then(|value| value.get("goalId")).cloned(),
                "goalRevision": projection
                    .as_ref()
                    .and_then(|value| value.get("goalRevision"))
                    .cloned(),
                "idempotent": false,
                "sourceDomainHead": source_domain_head,
                "projection": projection,
            }))
        }
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

#[derive(Debug)]
struct GoalCommandReplay {
    goal_id: String,
    request_digest: String,
    host_run_id: Option<String>,
    settled: bool,
}

fn goal_command_replay(events: &[Value], caller_request_id: &str) -> Option<GoalCommandReplay> {
    let mut replay: Option<GoalCommandReplay> = None;
    for event in events.iter().rev() {
        let Some(payload) = event.get("payload") else {
            continue;
        };
        let candidate = match event.get("kind").and_then(Value::as_str) {
            Some("session_goal_fact")
                if payload
                    .pointer("/command/callerRequestId")
                    .and_then(Value::as_str)
                    == Some(caller_request_id) =>
            {
                Some(GoalCommandReplay {
                    goal_id: payload.get("goalId").and_then(Value::as_str)?.to_string(),
                    request_digest: payload
                        .pointer("/command/requestDigest")
                        .and_then(Value::as_str)?
                        .to_string(),
                    host_run_id: payload
                        .pointer("/command/hostRunId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    settled: goal_fact_settles_command(
                        payload.get("factKind").and_then(Value::as_str),
                    ),
                })
            }
            Some("session_interaction_claim")
                if payload
                    .pointer("/goalCommand/callerRequestId")
                    .and_then(Value::as_str)
                    == Some(caller_request_id) =>
            {
                Some(GoalCommandReplay {
                    goal_id: payload
                        .pointer("/goalCommand/goalId")
                        .and_then(Value::as_str)?
                        .to_string(),
                    request_digest: payload
                        .pointer("/goalCommand/requestDigest")
                        .and_then(Value::as_str)?
                        .to_string(),
                    host_run_id: payload
                        .pointer("/goalCommand/hostRunId")
                        .or_else(|| payload.get("admittedRunId"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    settled: false,
                })
            }
            Some("session_run_state")
                if payload
                    .pointer("/goalCommand/callerRequestId")
                    .and_then(Value::as_str)
                    == Some(caller_request_id) =>
            {
                Some(GoalCommandReplay {
                    goal_id: payload
                        .pointer("/goalCommand/goalId")
                        .and_then(Value::as_str)?
                        .to_string(),
                    request_digest: payload
                        .pointer("/goalCommand/requestDigest")
                        .and_then(Value::as_str)?
                        .to_string(),
                    host_run_id: payload
                        .pointer("/goalCommand/hostRunId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    settled: matches!(
                        payload.get("status").and_then(Value::as_str),
                        Some("waiting" | "completed" | "failed" | "cancelled")
                    ),
                })
            }
            _ => None,
        };
        let Some(candidate) = candidate else {
            continue;
        };
        match replay.as_mut() {
            Some(existing)
                if existing.goal_id == candidate.goal_id
                    && existing.request_digest == candidate.request_digest =>
            {
                existing.settled |= candidate.settled;
                if existing.host_run_id.is_none() {
                    existing.host_run_id = candidate.host_run_id;
                }
            }
            None => replay = Some(candidate),
            Some(_) => {}
        }
    }
    replay
}

fn goal_fact_settles_command(fact_kind: Option<&str>) -> bool {
    matches!(
        fact_kind,
        Some(
            "planAwaitingAcceptance"
                | "planRevisionRequested"
                | "activated"
                | "resumed"
                | "budgetUsage"
                | "completed"
                | "failed"
                | "cancelled"
        )
    )
}

fn latest_goal_pending_effect_state(
    events: &[Value],
    goal_id: &str,
    goal_revision: u64,
) -> Option<String> {
    events.iter().rev().find_map(|event| {
        if event.get("kind").and_then(Value::as_str) != Some("session_goal_fact") {
            return None;
        }
        let payload = event.get("payload")?;
        if payload.get("factKind").and_then(Value::as_str) != Some("checkpoint")
            || payload.get("goalId").and_then(Value::as_str) != Some(goal_id)
            || payload.get("goalRevision").and_then(Value::as_u64)
                != Some(goal_revision)
        {
            return None;
        }
        payload
            .pointer("/checkpoint/pendingEffect/state")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some("none".to_string()))
    })
}

fn current_goal_domain_head(
    state: &AppState,
    session_id: &str,
) -> Result<Value, KernelErrorEnvelope> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let domain = session_domain_state(&sessions_dir, session_id).map_err(|error| {
        KernelErrorEnvelope {
            code: error.code.to_string(),
            message: error.message,
            message_key: None,
            args: None,
        }
    })?;
    serde_json::to_value(domain.head).map_err(|error| KernelErrorEnvelope {
        code: "session_goal_recovery_required".to_string(),
        message: format!("Goal domain head cannot be encoded: {error}"),
        message_key: None,
        args: None,
    })
}

async fn goal_replay_response(
    state: &AppState,
    session_id: &str,
    goal_id: &str,
    operation: &str,
    caller_request_id: Option<&str>,
    request_digest: Option<&str>,
    host_run_id: Option<&str>,
    idempotent: bool,
) -> Json<ApiResponse> {
    match read_goal_projection(state, session_id, Some(goal_id)).await {
        Ok(Some(projection)) => {
            let source_domain_head = projection.get("sourceDomainHead").cloned();
            let outcome = caller_request_id.and_then(|caller_request_id| {
                (projection
                    .pointer("/executionBudget/value/lastStep/callerRequestId")
                    .and_then(Value::as_str)
                    == Some(caller_request_id))
                .then(|| {
                    projection
                        .pointer("/executionBudget/value/lastStep/outcome")
                        .cloned()
                })
                .flatten()
            });
            ApiResponse::ok(json!({
                "schemaVersion": "deepcode.session.goal-command-receipt.v1",
                "operation": operation,
                "sessionId": session_id,
                "goalId": projection.get("goalId").cloned(),
                "goalRevision": projection.get("goalRevision").cloned(),
                "callerRequestId": caller_request_id,
                "requestDigest": request_digest,
                "idempotent": idempotent,
                "sourceDomainHead": source_domain_head,
                "projection": projection,
                "hostRunId": host_run_id,
                "outcome": outcome,
            }))
        }
        Ok(None) => ApiResponse::error(
            "session_goal_recovery_required",
            "Goal command committed no readable Goal projection",
        ),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn await_goal_host_run_terminal(
    state: &AppState,
    session_id: &str,
    host_run_id: &str,
) -> Result<(), KernelErrorEnvelope> {
    loop {
        let status = {
            let runs = state.session_runs.lock().expect("session run state lock");
            runs.get(host_run_id)
                .filter(|run| run.session_id == session_id)
                .map(|run| run.status.clone())
        };
        let Some(status) = status else {
            return Err(KernelErrorEnvelope {
                code: "session_goal_recovery_required".to_string(),
                message: format!("Goal Host run {host_run_id} disappeared before settlement"),
                message_key: None,
                args: None,
            });
        };
        if matches!(
            status.as_str(),
            "completed" | "failed" | "cancelled" | "waiting"
        ) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn exact_goal_domain_state(
    state: &AppState,
    session_id: &str,
    expected_head: &Value,
) -> Result<Value, Json<ApiResponse>> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let domain = session_domain_state(&sessions_dir, session_id).map_err(|error| {
        ApiResponse::error(error.code, error.message)
    })?;
    let domain = serde_json::to_value(domain).map_err(|error| {
        ApiResponse::error(
            "session_goal_recovery_required",
            format!("Goal domain state cannot be encoded: {error}"),
        )
    })?;
    if expected_head.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.session.domain-head.v1")
        || domain.get("head") != Some(expected_head)
    {
        return Err(ApiResponse::error(
            "session_goal_projection_stale",
            "Goal mutation expectedDomainHead does not match the canonical Session head",
        ));
    }
    Ok(domain)
}

async fn read_goal_projection(
    state: &AppState,
    session_id: &str,
    goal_id: Option<&str>,
) -> Result<Option<Value>, KernelErrorEnvelope> {
    let (sessions_dir, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        let session = session_by_id(&gui, session_id).cloned().ok_or_else(|| {
            KernelErrorEnvelope {
                code: "agent_session_not_found".to_string(),
                message: "agent session not found".to_string(),
                message_key: None,
                args: None,
            }
        })?;
        (gui.paths.sessions_dir.clone(), session)
    };
    let snapshot = read_session_domain_snapshot(&sessions_dir, session_id).map_err(
        |error| KernelErrorEnvelope {
            code: error.code.to_string(),
            message: error.message,
            message_key: None,
            args: None,
        },
    )?;
    let domain_state = session_domain_state_from_snapshot(session_id, &snapshot).map_err(
        |error| KernelErrorEnvelope {
            code: error.code.to_string(),
            message: error.message,
            message_key: None,
            args: None,
        },
    )?;
    let domain_value = serde_json::to_value(&domain_state).map_err(|error| {
        KernelErrorEnvelope {
            code: "session_goal_recovery_required".to_string(),
            message: format!("Goal domain state cannot be encoded: {error}"),
            message_key: None,
            args: None,
        }
    })?;
    let head_digest = domain_state.head.head_digest.clone();
    let cache_key = goal_cache_key(&sessions_dir, session_id, goal_id);
    if let Some(cached) = goal_projection_cache()
        .lock()
        .expect("Goal projection cache lock")
        .get(&cache_key)
        .filter(|cached| cached.head_digest == head_digest)
        .cloned()
    {
        return Ok((!cached.projection.is_null()).then_some(cached.projection));
    }
    let has_goal_fact = snapshot.events.iter().any(|event| {
        event.get("kind").and_then(Value::as_str) == Some("session_goal_fact")
    });
    if !has_goal_fact {
        if goal_id.is_some() {
            return Err(KernelErrorEnvelope {
                code: "session_goal_not_found".to_string(),
                message: "Goal does not exist in this Session".to_string(),
                message_key: None,
                args: None,
            });
        }
        return Ok(None);
    }
    let timeline = session_timeline(state, session_id).ok_or_else(|| KernelErrorEnvelope {
        code: "session_goal_projection_stale".to_string(),
        message: "Shared Conversation Projection is unavailable or stale".to_string(),
        message_key: None,
        args: None,
    })?;
    if timeline
        .get("sourceEventVersion")
        .and_then(Value::as_u64)
        != Some(domain_state.head.event_version)
    {
        return Err(KernelErrorEnvelope {
            code: "session_goal_projection_stale".to_string(),
            message: "Goal and Shared Conversation Projection sources do not match".to_string(),
            message_key: None,
            args: None,
        });
    }
    let request = json!({
        "op": "readGoal",
        "sessionId": session_id,
        "goalId": goal_id,
        "sessionResult": {
            "session": session,
            "events": snapshot.events,
            "appendWriteability": {
                "schemaVersion": "deepcode.session.append-writeability.v1",
                "status": "writable",
                "format": "domainBatchV1"
            },
            "domainState": domain_value
        },
        "conversationProjection": timeline
    });
    let result = tokio::task::spawn_blocking(move || run_readonly_session_bridge(request))
        .await
        .map_err(|error| KernelErrorEnvelope {
            code: "session_bridge_failed".to_string(),
            message: format!("read-only Goal bridge task failed: {error}"),
            message_key: None,
            args: None,
        })??;
    let projection = result.get("goalProjection").cloned().unwrap_or(Value::Null);
    if let Some(projection_head) = projection
        .pointer("/sourceDomainHead/headDigest")
        .and_then(Value::as_str)
    {
        if projection_head != head_digest {
            return Err(KernelErrorEnvelope {
                code: "session_goal_projection_stale".to_string(),
                message: "Goal bridge returned a projection for a different domain head"
                    .to_string(),
                message_key: None,
                args: None,
            });
        }
    }
    goal_projection_cache()
        .lock()
        .expect("Goal projection cache lock")
        .insert(
            cache_key,
            CachedGoalProjection {
                head_digest,
                projection: projection.clone(),
            },
        );
    Ok((!projection.is_null()).then_some(projection))
}

fn goal_request_digest(operation: &str, request: &Value) -> String {
    let bytes = serde_json::to_vec(&json!({
        "operation": operation,
        "request": request,
    }))
    .unwrap_or_default();
    deepcode_kernel_tools::hash_bytes(&bytes)
}

fn validate_goal_request_identity(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 240
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err(
            "callerRequestId must be bounded ASCII using letters, digits, '.', '_', ':' or '-'"
                .to_string(),
        );
    }
    Ok(())
}

fn new_goal_id() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(1);
    let sequence = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("goal-{}-{nanos}-{sequence}", std::process::id())
}
