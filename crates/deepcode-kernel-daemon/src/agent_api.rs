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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionRunRequest {
    pub(crate) op: String,
    pub(crate) content: Option<String>,
    pub(crate) workspace_path: Option<String>,
    pub(crate) no_workspace: Option<bool>,
    pub(crate) attachments: Option<Vec<AgentInputAttachmentV2>>,
    pub(crate) decision_kind: Option<String>,
    pub(crate) decision: Option<String>,
    pub(crate) guidance: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) target_id: Option<String>,
    pub(crate) caller_request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunCallerMutationRequest {
    pub(crate) caller_request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunGuidanceMutationRequest {
    pub(crate) guidance: String,
    pub(crate) workspace_path: Option<String>,
    pub(crate) no_workspace: Option<bool>,
    pub(crate) attachments: Option<Vec<AgentInputAttachmentV2>>,
    pub(crate) caller_request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentAuthorityRevokeTargetRequestV2 {
    CapabilityLease { lease_id: String },
    TrustPolicy { trust_policy_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentAuthorityRevokeRequestV2 {
    pub(crate) caller_request_id: String,
    pub(crate) target: AgentAuthorityRevokeTargetRequestV2,
    pub(crate) reason: String,
}

fn run_response(state: &AppState, session_id: &str, run_id: &str) -> Json<ApiResponse> {
    run_response_with_input_admission(state, session_id, run_id, None)
}

const HOST_CALLER_MUTATION_ERROR_SCHEMA_V2: &str = "deepcode.host.caller-mutation-error.v2";

fn caller_mutation_error_data(disposition: &str) -> Value {
    json!({
        "schemaVersion": HOST_CALLER_MUTATION_ERROR_SCHEMA_V2,
        "disposition": disposition,
    })
}

fn caller_mutation_rejection(
    code: impl Into<String>,
    message: impl Into<String>,
) -> Json<ApiResponse> {
    ApiResponse::error_with_data(code, message, caller_mutation_error_data("rejected"))
}

fn caller_mutation_rejection_response(mut response: Json<ApiResponse>) -> Json<ApiResponse> {
    if !response.0.ok && response.0.data.is_none() {
        response.0.data = Some(caller_mutation_error_data("rejected"));
    }
    response
}

fn caller_mutation_error_response(error: AgentKernelV2Error) -> Json<ApiResponse> {
    let code = error.code;
    let disposition = if matches!(
        code.as_str(),
        "host_caller_request_in_progress" | "host_user_input_admission_pending"
    ) {
        "pending"
    } else if code.contains("indeterminate")
        || matches!(
            code.as_str(),
            "host_user_input_projection_missing"
                | "host_initial_input_projection_missing"
                | "host_caller_request_recovery_required"
                | "host_caller_request_outcome_missing"
                | "host_caller_request_owner_missing"
                | "host_caller_request_user_input_admission_missing"
                | "host_user_input_admission_missing"
                | "host_run_open_admission_incomplete"
                | "host_run_open_startup_binding_lost"
                | "host_kernel_caller_drive_owner_lost_before_admission"
        )
    {
        "indeterminate"
    } else {
        "rejected"
    };
    ApiResponse::error_with_data(code, error.message, caller_mutation_error_data(disposition))
}

fn run_response_with_input_admission(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    input_id: Option<&str>,
) -> Json<ApiResponse> {
    let run = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.get(run_id)
            .filter(|run| run.session_id == session_id)
            .cloned()
    };
    let Some(run) = run else {
        return ApiResponse::error("agent_run_not_found", "agent run not found");
    };
    let Some(session) = session_metadata_payload(state, session_id) else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    ApiResponse::ok(json!({
        "run": run,
        "session": session,
        "inputId": input_id,
    }))
}

fn run_admission_response(
    state: &AppState,
    session_id: &str,
    admission: AgentKernelRunAdmissionV2,
) -> Json<ApiResponse> {
    let identity_matches = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.get(&admission.host_run_id).is_some_and(|run| {
            run.session_id == session_id
                && run.kernel_run_id.as_deref() == Some(admission.kernel_run_id.as_str())
        })
    };
    if !identity_matches {
        return ApiResponse::error(
            "agent_run_admission_identity_conflict",
            "Durable Run admission does not match its exact Host and Kernel Run identity.",
        );
    }
    run_response_with_input_admission(
        state,
        session_id,
        &admission.host_run_id,
        Some(&admission.input_id),
    )
}

fn require_verified_selectable_session(
    state: &AppState,
    session_id: &str,
) -> Result<(), Json<ApiResponse>> {
    let gui = state.gui.lock().expect("gui state lock");
    verified_selectable_session(&gui, session_id).map(|_| ())
}

fn session_metadata_payload(state: &AppState, session_id: &str) -> Option<Value> {
    let session = {
        let gui = state.gui.lock().expect("gui state lock");
        session_by_id(&gui, session_id)?.clone()
    };
    Some(session)
}

fn run_belongs_to_session(state: &AppState, session_id: &str, run_id: &str) -> bool {
    state
        .session_runs
        .lock()
        .expect("session run state lock")
        .get(run_id)
        .is_some_and(|run| run.session_id == session_id)
}

fn authoritative_project_run_context(
    state: &AppState,
    session: &Value,
    continuing_run: bool,
) -> Result<Option<Value>, KernelErrorEnvelope> {
    let Some(project_id) = session
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let project = {
        let gui = state.gui.lock().expect("gui state lock");
        project_by_id(&gui, project_id).cloned()
    }
    .ok_or_else(|| KernelErrorEnvelope {
        code: "project_root_unavailable".to_string(),
        message: "project record is unavailable; rebind the project directory".to_string(),
        message_key: None,
        args: None,
    })?;
    let kind = project
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("blank");
    if kind == "blank" {
        return Ok(Some(json!({
            "projectId": project_id,
            "kind": "blank",
            "rootStatus": "unbound"
        })));
    }
    let stored_binding = if continuing_run {
        session
            .get("workspaceBinding")
            .filter(|binding| binding.is_object())
            .cloned()
            .or_else(|| project_workspace_binding(&project))
    } else {
        project_workspace_binding(&project)
    }
    .ok_or_else(|| {
        if !continuing_run {
            set_project_root_status(state, project_id, "unavailable");
        }
        KernelErrorEnvelope {
            code: "project_root_unavailable".to_string(),
            message: "project workspace binding is unavailable; rebind the project directory"
                .to_string(),
            message_key: None,
            args: None,
        }
    })?;
    let resolved_binding = state
        .host_services
        .workspace
        .validate_project_binding(&stored_binding)
        .map_err(|error| {
            if !continuing_run {
                set_project_root_status(state, project_id, "unavailable");
            }
            KernelErrorEnvelope {
                code: error.code,
                message: format!("project workspace root is unavailable: {}", error.message),
                message_key: error.message_key,
                args: error.args,
            }
        })?;
    if !continuing_run {
        set_project_root_status(state, project_id, "ready");
    }
    Ok(Some(json!({
        "projectId": project_id,
        "kind": "folder",
        "rootStatus": "ready",
        "workspaceBinding": resolved_binding
    })))
}

pub(crate) fn session_run_admission_lock(
    session_id: &str,
) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::sync::{Arc, Mutex, OnceLock, Weak};

    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().expect("Session run admission lock registry");
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
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return caller_mutation_rejection_response(response);
    }
    if let Err(response) = require_verified_selectable_session(&state, &session_id) {
        return caller_mutation_rejection_response(response);
    }
    let Some(session) = session_metadata_payload(&state, &session_id) else {
        return caller_mutation_rejection("agent_session_not_found", "agent session not found");
    };
    if !session_schema_is_current(&session) {
        return caller_mutation_rejection_response(unsupported_session_schema_response());
    }
    match body.op.as_str() {
        "resolveDecision" => {
            let mutation_lock = session_run_admission_lock(&session_id);
            let _mutation_guard = mutation_lock.lock_owned().await;
            if let Err(response) = require_verified_selectable_session(&state, &session_id) {
                return caller_mutation_rejection_response(response);
            }
            if body.content.is_some()
                || body.workspace_path.is_some()
                || body.no_workspace.is_some()
                || body.attachments.is_some()
            {
                return caller_mutation_rejection(
                    "session_operation_v2_invalid",
                    "A decision cannot alter Run content, attachments, or workspace identity.",
                );
            }
            return match resolve_agent_kernel_decision_v2(&state, &session_id, &body).await {
                Ok(host_run_id) => run_response(&state, &session_id, &host_run_id),
                Err(error) => caller_mutation_error_response(error),
            };
        }
        "ask" => {
            let run_start_lock = session_run_admission_lock(&session_id);
            let _run_start_guard = run_start_lock.lock_owned().await;
            if let Err(response) = require_verified_selectable_session(&state, &session_id) {
                return caller_mutation_rejection_response(response);
            }
            let Some(session) = session_metadata_payload(&state, &session_id) else {
                return caller_mutation_rejection(
                    "agent_session_not_found",
                    "agent session not found",
                );
            };
            if !session_schema_is_current(&session) {
                return caller_mutation_rejection_response(unsupported_session_schema_response());
            }
            if body.decision_kind.is_some()
                || body.decision.is_some()
                || body.guidance.is_some()
                || body.run_id.is_some()
                || body.target_id.is_some()
            {
                return caller_mutation_rejection(
                    "session_operation_v2_invalid",
                    "A new ask cannot carry decision or active Run identity.",
                );
            }
            return agent_session_run_open_admitted(&state, &session_id, &body, &session).await;
        }
        _ => {
            return caller_mutation_rejection(
                "session_operation_v2_unsupported",
                "Only a new ask or an exact Plan/capability decision can enter the v2 Run path.",
            )
        }
    }
}

async fn agent_session_run_open_admitted(
    state: &AppState,
    session_id: &str,
    body: &AgentSessionRunRequest,
    session: &Value,
) -> Json<ApiResponse> {
    match preadmit_open_agent_kernel_run_v2(state, session_id, body).await {
        Ok(Some(admission)) => return run_admission_response(state, session_id, admission),
        Ok(None) => {}
        Err(error) => return caller_mutation_error_response(error),
    }
    let project_context = match authoritative_project_run_context(state, session, false) {
        Ok(context) => context,
        Err(error) => return caller_mutation_rejection(error.code, error.message),
    };
    if let Some(binding) = project_context
        .as_ref()
        .and_then(|context| context.get("workspaceBinding"))
        .filter(|value| value.is_object())
    {
        let mut gui = state.gui.lock().expect("gui state lock");
        if let Some(stored_session) = session_mut(&mut gui, session_id) {
            stored_session["workspaceBinding"] = binding.clone();
            apply_workspace_binding_to_session(stored_session, binding);
            stored_session["updatedAt"] = json!(now_text());
        }
        if let Err(error) = crate::session_metadata_v2::persist_session_index(&gui) {
            return caller_mutation_rejection("agent_session_persist_failed", error);
        }
    }
    let profile_id = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let llm_profiles = gui.llm_profiles.clone();
        let Some(stored_session) = session_mut(&mut gui, session_id) else {
            return caller_mutation_rejection("agent_session_not_found", "agent session not found");
        };
        let stored_profile_id = stored_session
            .get("profileId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(profile_id) = stored_profile_id else {
            return caller_mutation_rejection(
                "llm_profile_unavailable",
                "this Session has no selected LLM Profile; select one before starting a Run",
            );
        };
        let profile_available = match effective_llm_profile_is_enabled(
            &state,
            &llm_profiles,
            &profile_id,
        ) {
            Ok(available) => available,
            Err(error) => {
                return caller_mutation_rejection(
                    error.code,
                    "Provider Profile availability could not be verified before starting the Session Run",
                )
            }
        };
        if !profile_available {
            return caller_mutation_rejection(
                "llm_profile_unavailable",
                "the Session's selected LLM Profile does not exist, is disabled, or its exact revision is unavailable; select or re-enable it explicitly",
            );
        }
        profile_id
    };
    let start_event_count = {
        let sessions_dir = state
            .gui
            .lock()
            .expect("gui state lock")
            .paths
            .sessions_dir
            .clone();
        match read_session_kernel_v2_public_agent_events(&sessions_dir, session_id) {
            Ok(events) => events.len(),
            Err(error) => return caller_mutation_rejection(error.code, error.message),
        }
    };
    match open_agent_kernel_run_v2(
        state,
        session_id,
        body,
        &profile_id,
        project_context.as_ref(),
        start_event_count,
    )
    .await
    {
        Ok(admission) => run_admission_response(state, session_id, admission),
        Err(error) => caller_mutation_error_response(error),
    }
}

pub(crate) async fn agent_session_run_get(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    if let Err(response) = require_verified_selectable_session(&state, &session_id) {
        return response;
    }
    if run_belongs_to_session(&state, &session_id, &run_id) {
        return run_response(&state, &session_id, &run_id);
    }
    match restore_agent_kernel_run_cache_v2(&state, &session_id, &run_id) {
        Ok(host_run_id) => run_response(&state, &session_id, &host_run_id),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn agent_session_active_run(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    if let Err(response) = require_verified_selectable_session(&state, &session_id) {
        return response;
    }
    let active = match state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(&session_id)
    {
        Ok(active) => active,
        Err(error) => {
            return ApiResponse::error(error.code, error.message);
        }
    };
    let Some(active) = active else {
        return ApiResponse::ok(Value::Null);
    };
    if !run_belongs_to_session(&state, &session_id, &active.host_run_id) {
        if let Err(error) =
            restore_agent_kernel_run_cache_v2(&state, &session_id, &active.host_run_id)
        {
            return ApiResponse::error(error.code, error.message);
        }
    }
    run_response(&state, &session_id, &active.host_run_id)
}

pub(crate) async fn agent_session_run_cancel(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(body): Json<AgentRunCallerMutationRequest>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return caller_mutation_rejection_response(response);
    }
    if let Err(response) = require_verified_selectable_session(&state, &session_id) {
        return caller_mutation_rejection_response(response);
    }
    match cancel_agent_kernel_run_v2(&state, &session_id, &run_id, &body.caller_request_id).await {
        Ok(Some(host_run_id)) => run_response(&state, &session_id, &host_run_id),
        Ok(None) => caller_mutation_rejection("agent_run_not_found", "agent run not found"),
        Err(error) => caller_mutation_error_response(error),
    }
}

pub(crate) async fn agent_session_run_guidance(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(body): Json<AgentRunGuidanceMutationRequest>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return caller_mutation_rejection_response(response);
    }
    let mutation_lock = session_run_admission_lock(&session_id);
    let _mutation_guard = mutation_lock.lock_owned().await;
    if let Err(response) = require_verified_selectable_session(&state, &session_id) {
        return caller_mutation_rejection_response(response);
    }
    let Some(session) = session_metadata_payload(&state, &session_id) else {
        return caller_mutation_rejection("agent_session_not_found", "agent session not found");
    };
    let project_context = match authoritative_project_run_context(&state, &session, true) {
        Ok(context) => context,
        Err(error) => return caller_mutation_rejection(error.code, error.message),
    };
    let (workspace_path, no_workspace) = if let Some(project_context) = project_context.as_ref() {
        if project_context.get("kind").and_then(Value::as_str) == Some("blank") {
            if body.workspace_path.is_some() || body.no_workspace == Some(false) {
                return caller_mutation_rejection(
                    "agent_guidance_project_workspace_conflict",
                    "The authoritative project has no workspace, but guidance requested a workspace-bound continuation.",
                );
            }
            (None, true)
        } else {
            if body.no_workspace == Some(true) {
                return caller_mutation_rejection(
                    "agent_guidance_project_workspace_conflict",
                    "The authoritative project is workspace-bound and cannot continue in no-workspace mode.",
                );
            }
            let Some(authoritative_path) = project_context
                .pointer("/workspaceBinding/openPath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
            else {
                return caller_mutation_rejection(
                    "agent_guidance_workspace_required",
                    "Project-backed guidance has no authoritative workspace path.",
                );
            };
            let requested_path = body
                .workspace_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty());
            (
                Some(requested_path.unwrap_or(authoritative_path).to_string()),
                false,
            )
        }
    } else if body.no_workspace == Some(true) {
        if body.workspace_path.is_some() {
            return caller_mutation_rejection(
                "agent_guidance_workspace_conflict",
                "Guidance cannot request both a workspace path and no-workspace mode.",
            );
        }
        (None, true)
    } else {
        let Some(path) = body
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        else {
            return caller_mutation_rejection(
                "agent_guidance_workspace_required",
                "Guidance for a workspace-bound Run requires the current workspace path.",
            );
        };
        (Some(path.to_string()), false)
    };
    let admission = submit_agent_kernel_user_input_v2(
        &state,
        &session_id,
        &run_id,
        &body.guidance,
        workspace_path.as_deref(),
        no_workspace,
        body.attachments.as_deref(),
        &body.caller_request_id,
    )
    .await;
    let result = match admission {
        Ok(admission) => await_agent_kernel_user_input_admission_v2(admission).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(receipt) => run_response_with_input_admission(
            &state,
            &session_id,
            &receipt.host_run_id,
            Some(&receipt.input_id),
        ),
        Err(error) => caller_mutation_error_response(error),
    }
}

pub(crate) async fn agent_session_run_authority_revoke(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(body): Json<AgentAuthorityRevokeRequestV2>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let mutation_lock = session_run_admission_lock(&session_id);
    let _mutation_guard = mutation_lock.lock_owned().await;
    if let Err(response) = require_verified_selectable_session(&state, &session_id) {
        return response;
    }
    match revoke_agent_kernel_authority_v2(&state, &session_id, &run_id, &body) {
        Ok(result) => ApiResponse::ok(result),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

#[cfg(test)]
#[path = "agent_api_tests.rs"]
mod tests;
