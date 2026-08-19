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
    pub(crate) attachments: Option<Vec<AgentInputAttachmentV3>>,
    pub(crate) decision_kind: Option<String>,
    pub(crate) decision: Option<String>,
    pub(crate) guidance: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) target_id: Option<String>,
    pub(crate) option_id: Option<String>,
    pub(crate) interaction_id: Option<String>,
    pub(crate) interaction_revision: Option<String>,
    pub(crate) candidate_set_digest: Option<String>,
    pub(crate) expected_projection_cursor: Option<u64>,
    pub(crate) conversation_target: Option<AgentConversationTargetV1>,
    pub(crate) caller_request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentConversationDraftRunRequest {
    pub(crate) content: String,
    pub(crate) profile_id: String,
    pub(crate) attachments: Option<Vec<AgentInputAttachmentV3>>,
    pub(crate) conversation_draft_target: AgentConversationDraftTargetV1,
    pub(crate) caller_request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunCallerMutationRequest {
    pub(crate) conversation_target: AgentConversationTargetV1,
    pub(crate) caller_request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRunGuidanceMutationRequest {
    pub(crate) guidance: String,
    pub(crate) workspace_path: Option<String>,
    pub(crate) no_workspace: Option<bool>,
    pub(crate) attachments: Option<Vec<AgentInputAttachmentV3>>,
    pub(crate) conversation_target: AgentConversationTargetV1,
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
    let session = match public_agent_session_value(&session) {
        Ok(session) => session,
        Err(error) => return ApiResponse::error(error.code, error.message),
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
    let session = verified_selectable_session(&gui, session_id)?;
    if !session_is_publicly_visible(session) {
        return Err(ApiResponse::error(
            "agent_session_not_found",
            "agent session not found",
        ));
    }
    Ok(())
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
        if session
            .get("workspaceBinding")
            .is_some_and(|binding| !binding.is_null())
            || session_scope_key(session) != "unbound-workspace"
        {
            return Err(KernelErrorEnvelope {
                code: "project_session_binding_stale".to_string(),
                message: "Session binding no longer matches its authoritative blank Project; reload the canonical Session before sending".to_string(),
                message_key: None,
                args: None,
            });
        }
        return Ok(Some(json!({
            "projectId": project_id,
            "kind": "blank",
            "rootStatus": "unbound"
        })));
    }
    let project_binding = project_workspace_binding(&project).ok_or_else(|| {
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
    let session_binding = session
        .get("workspaceBinding")
        .filter(|binding| binding.is_object())
        .cloned()
        .ok_or_else(|| KernelErrorEnvelope {
            code: "project_session_binding_stale".to_string(),
            message: "Session has no canonical workspace binding for its Project; reload the canonical Session before sending".to_string(),
            message_key: None,
            args: None,
        })?;
    if session_binding != project_binding {
        return Err(KernelErrorEnvelope {
            code: "project_session_binding_stale".to_string(),
            message: "Session workspace binding no longer matches its Project; reload the canonical Session before sending".to_string(),
            message_key: None,
            args: None,
        });
    }
    let resolved_binding = state
        .host_services
        .workspace
        .validate_project_binding(&session_binding)
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

pub(crate) async fn agent_conversation_draft_run_start(
    State(state): State<AppState>,
    Json(body): Json<AgentConversationDraftRunRequest>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return caller_mutation_rejection_response(response);
    }
    let caller_request_id = body.caller_request_id.trim();
    let profile_id = body.profile_id.trim();
    if caller_request_id.is_empty()
        || caller_request_id.len() > 512
        || caller_request_id.chars().any(char::is_control)
        || profile_id.is_empty()
        || profile_id.len() > 512
        || profile_id.chars().any(char::is_control)
    {
        return caller_mutation_rejection(
            "conversation_draft_admission_identity_invalid",
            "Draft, Profile, and caller request identities must be non-empty bounded values",
        );
    }
    if body.content.trim().is_empty() {
        return caller_mutation_rejection(
            "conversation_draft_admission_invalid",
            "Conversation draft admission requires one non-empty user input",
        );
    }
    if let Err(error) = validate_agent_input_attachments_v3(body.attachments.as_deref()) {
        return caller_mutation_rejection(error.code, error.message);
    }
    let request_material = json!({
        "schemaVersion": "deepcode.host.conversation-draft-first-input.v1",
        "callerRequestId": caller_request_id,
        "content": body.content.trim(),
        "profileId": profile_id,
        "attachments": body.attachments.as_ref(),
        "conversationDraftTarget": &body.conversation_draft_target,
    });
    let request_digest = match crate::host_v2_storage::canonical_sha256(&request_material) {
        Ok(digest) => digest,
        Err(error) => return caller_mutation_rejection(error.code, error.message),
    };
    let admission_lock = session_run_admission_lock(&format!(
        "conversation-draft-admission:{}:{caller_request_id}",
        body.conversation_draft_target.target_id()
    ));
    let _admission_guard = admission_lock.lock_owned().await;
    let _project_binding_guard = agent_project_binding_transition_lock().lock_owned().await;
    let exact_draft_target =
        match require_conversation_draft_target_v1(&state, &body.conversation_draft_target) {
            Ok(target) => target,
            Err(error) => return caller_mutation_rejection(error.code, error.message),
        };
    let project_id = exact_draft_target.project_id().map(str::to_string);
    let (workspace_id, workspace_hash) = exact_draft_target.workspace_identity();

    let (session_id, session) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let matching = gui
            .sessions
            .iter()
            .filter(|session| {
                session
                    .pointer("/firstInputAdmission/callerRequestId")
                    .and_then(Value::as_str)
                    == Some(caller_request_id)
            })
            .collect::<Vec<_>>();
        if matching.len() > 1 {
            return caller_mutation_rejection(
                "conversation_draft_admission_conflict",
                "callerRequestId is bound to more than one pending draft Session",
            );
        }
        if let Some(existing) = matching.first().copied() {
            if existing.get("projectId").and_then(Value::as_str) != project_id.as_deref()
                || existing
                    .pointer("/firstInputAdmission/requestDigest")
                    .and_then(Value::as_str)
                    != Some(request_digest.as_str())
            {
                return caller_mutation_rejection(
                    "conversation_draft_admission_request_conflict",
                    "callerRequestId is already bound to different draft Session input material",
                );
            }
            let session_id = existing
                .get("id")
                .and_then(Value::as_str)
                .expect("validated Session identity")
                .to_string();
            (session_id, existing.clone())
        } else {
            let profile_available =
                match effective_llm_profile_is_enabled(&state, &gui.llm_profiles, profile_id) {
                    Ok(available) => available,
                    Err(error) => return caller_mutation_rejection(error.code, error.message),
                };
            if !profile_available {
                return caller_mutation_rejection(
                    "llm_profile_unavailable",
                    "The selected LLM Profile is disabled or unavailable",
                );
            }
            let session_id = match allocate_agent_session_id(&gui) {
                Ok(id) => id,
                Err(error) => {
                    return caller_mutation_rejection("agent_session_identity_unavailable", error)
                }
            };
            let now = now_text();
            let mut session = create_agent_session_value(
                &session_id,
                &now,
                "New Agent Session",
                Some(profile_id),
                workspace_id,
                workspace_hash,
            );
            if let Some(project_id) = project_id.as_deref() {
                let Some(project) = project_by_id(&gui, project_id).cloned() else {
                    return caller_mutation_rejection(
                        "agent_project_not_found",
                        "agent project not found",
                    );
                };
                session["projectId"] = json!(project_id);
                apply_project_binding_to_session(&mut session, &project);
            }
            session["firstInputAdmission"] = json!({
                "schemaVersion": "deepcode.host.conversation-draft-admission.v1",
                "targetKind": if project_id.is_some() { "project" } else { "public" },
                "projectId": project_id,
                "callerRequestId": caller_request_id,
                "requestDigest": request_digest,
                "status": "pending",
                "createdAt": now,
                "updatedAt": now,
            });
            gui.sessions.insert(0, session.clone());
            if let Err(error) = crate::session_metadata_v2::persist_session_index(&gui) {
                gui.sessions.retain(|candidate| {
                    candidate.get("id").and_then(Value::as_str) != Some(session_id.as_str())
                });
                return caller_mutation_rejection("agent_session_persist_failed", error);
            }
            (session_id, session)
        }
    };
    let _run_admission_guard = session_run_admission_lock(&session_id).lock_owned().await;

    let conversation_target = match agent_conversation_target_v1(&session) {
        Ok(target) => target,
        Err(error) => return caller_mutation_rejection(error.code, error.message),
    };
    let run_request = AgentSessionRunRequest {
        op: "ask".to_string(),
        content: Some(body.content.trim().to_string()),
        workspace_path: None,
        no_workspace: None,
        attachments: body.attachments,
        decision_kind: None,
        decision: None,
        guidance: None,
        run_id: None,
        target_id: None,
        option_id: None,
        interaction_id: None,
        interaction_revision: None,
        candidate_set_digest: None,
        expected_projection_cursor: None,
        conversation_target: Some(conversation_target),
        caller_request_id: caller_request_id.to_string(),
    };
    let response =
        agent_session_run_open_admitted(&state, &session_id, &run_request, &session).await;
    if !response.0.ok {
        return response;
    }

    let mut gui = state.gui.lock().expect("gui state lock");
    let previous_current_session_id = gui.current_session_id.clone();
    let scope_key = session_scope_key(&session);
    let previous_scope_session_id = gui.current_session_ids_by_scope.get(&scope_key).cloned();
    let admitted_at = now_text();
    let Some(stored_session) = gui
        .sessions
        .iter_mut()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(session_id.as_str()))
    else {
        return ApiResponse::error_with_data(
            "conversation_draft_admission_finalize_missing",
            "The admitted Run has no matching Session metadata to finalize",
            caller_mutation_error_data("indeterminate"),
        );
    };
    stored_session["firstInputAdmission"]["status"] = json!("admitted");
    stored_session["firstInputAdmission"]["updatedAt"] = json!(admitted_at);
    stored_session["updatedAt"] = json!(admitted_at);
    gui.current_session_id = Some(session_id.clone());
    gui.current_session_ids_by_scope
        .retain(|_, current_id| current_id != &session_id);
    if let Err(error) = crate::session_metadata_v2::persist_session_index(&gui) {
        if let Some(stored_session) = gui.sessions.iter_mut().find(|candidate| {
            candidate.get("id").and_then(Value::as_str) == Some(session_id.as_str())
        }) {
            stored_session["firstInputAdmission"]["status"] = json!("pending");
        }
        gui.current_session_id = previous_current_session_id;
        if let Some(previous) = previous_scope_session_id {
            gui.current_session_ids_by_scope.insert(scope_key, previous);
        }
        return ApiResponse::error_with_data(
            "conversation_draft_admission_finalize_failed",
            format!("The Run was admitted but Session activation could not be persisted: {error}"),
            caller_mutation_error_data("indeterminate"),
        );
    }
    drop(gui);
    response
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
    if let Err(error) =
        require_agent_conversation_target_v1(&session, body.conversation_target.as_ref())
    {
        return caller_mutation_rejection(error.code, error.message);
    }
    match body.op.as_str() {
        "resolveDecision" => {
            let mutation_lock = session_run_admission_lock(&session_id);
            let _mutation_guard = mutation_lock.lock_owned().await;
            if let Err(response) = require_verified_selectable_session(&state, &session_id) {
                return caller_mutation_rejection_response(response);
            }
            let Some(current_session) = session_metadata_payload(&state, &session_id) else {
                return caller_mutation_rejection(
                    "agent_session_not_found",
                    "agent session not found",
                );
            };
            if let Err(error) = require_agent_conversation_target_v1(
                &current_session,
                body.conversation_target.as_ref(),
            ) {
                return caller_mutation_rejection(error.code, error.message);
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
            if let Err(error) =
                require_agent_conversation_target_v1(&session, body.conversation_target.as_ref())
            {
                return caller_mutation_rejection(error.code, error.message);
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
    agent_session_run_cancel_inner(state, session_id, Some(run_id), body).await
}

pub(crate) async fn agent_session_current_run_cancel(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<AgentRunCallerMutationRequest>,
) -> Json<ApiResponse> {
    agent_session_run_cancel_inner(state, session_id, None, body).await
}

async fn agent_session_run_cancel_inner(
    state: AppState,
    session_id: String,
    run_id: Option<String>,
    body: AgentRunCallerMutationRequest,
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
    let target =
        match require_agent_conversation_target_v1(&session, Some(&body.conversation_target)) {
            Ok(target) => target,
            Err(error) => return caller_mutation_rejection(error.code, error.message),
        };
    let replay_run_id = if run_id.is_none() {
        match state
            .host_services
            .kernel_operations_v2
            .caller_request_host_run_id(&session_id, &body.caller_request_id, "agent.run.cancel.v2")
        {
            Ok(run_id) => run_id,
            Err(error) => return caller_mutation_rejection(error.code, error.message),
        }
    } else {
        None
    };
    let run_id = match run_id.or(replay_run_id) {
        Some(run_id) => run_id,
        None => match state
            .host_services
            .active_runs_v2
            .resolve_session_active_run(&session_id)
        {
            Ok(Some(active)) => active.host_run_id,
            Ok(None) => {
                return caller_mutation_rejection(
                    "agent_run_not_active",
                    "The Session has no authoritative active Run to cancel.",
                )
            }
            Err(error) => return caller_mutation_rejection(error.code, error.message),
        },
    };
    match cancel_agent_kernel_run_v2(
        &state,
        &session_id,
        &run_id,
        &body.caller_request_id,
        &target.target_revision,
    )
    .await
    {
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
    agent_session_run_guidance_inner(state, session_id, Some(run_id), body).await
}

pub(crate) async fn agent_session_current_run_guidance(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<AgentRunGuidanceMutationRequest>,
) -> Json<ApiResponse> {
    agent_session_run_guidance_inner(state, session_id, None, body).await
}

async fn agent_session_run_guidance_inner(
    state: AppState,
    session_id: String,
    run_id: Option<String>,
    body: AgentRunGuidanceMutationRequest,
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
    let target =
        match require_agent_conversation_target_v1(&session, Some(&body.conversation_target)) {
            Ok(target) => target,
            Err(error) => return caller_mutation_rejection(error.code, error.message),
        };
    let replay_run_id = if run_id.is_none() {
        match state
            .host_services
            .kernel_operations_v2
            .caller_request_host_run_id(
                &session_id,
                &body.caller_request_id,
                "agent.run.user-input.v2",
            ) {
            Ok(run_id) => run_id,
            Err(error) => return caller_mutation_rejection(error.code, error.message),
        }
    } else {
        None
    };
    let run_id = match run_id.or(replay_run_id) {
        Some(run_id) => run_id,
        None => match state
            .host_services
            .active_runs_v2
            .resolve_session_active_run(&session_id)
        {
            Ok(Some(active)) => active.host_run_id,
            Ok(None) => {
                return caller_mutation_rejection(
                    "agent_run_not_active",
                    "The Session has no authoritative active Run to receive guidance.",
                )
            }
            Err(error) => return caller_mutation_rejection(error.code, error.message),
        },
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
        &target.target_revision,
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
