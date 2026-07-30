use crate::host_kernel_operation_store_v2::{
    HostCallerRequestBindingInputV2, HostCallerRequestBindingReceiptV2,
    HostCallerRequestDriveStateV2, HostCallerRequestRecoveryEvidenceV2,
    HostKernelOperationSettlementReceiptV2, HostKernelOperationSettlementV2,
    HostKernelStoredRunLifecycleV2,
};
use crate::host_kernel_run_v2::{
    HostKernelBridgeOperationV2, HostKernelCapabilityDecisionV2, HostKernelInitialInputV2,
    HostKernelPlanDecisionV2, HostKernelRunSpawnInputV2, HostKernelRunWorkspaceV2,
    HostKernelWaitKindV2,
};
use crate::host_run_broker_v2::{
    HostActiveRunRecordV2, HostRunSettingsCeilingV2, HostRunWorkspaceKindV2,
};
use crate::host_services::{HostPreparedBoundWorkspaceV2, HostPreparedEmptyWorkspaceV2};
use crate::host_v2_storage::{canonical_sha256, stable_json_sha256, HostV2StorageError};
use crate::kernel_v2_transport::{
    HostAuthorityRevokeResolveRequestV2, HostCapabilityDecisionApplyErrorV2,
    HostCapabilityDecisionKindV2, HostCapabilityDecisionRequestV2, HostResolvedAuthorityRevokeV2,
    HostTrustGrantRequestV2,
};
use crate::prelude::*;
use crate::session_bootstrap_v2::{HostProviderProfileBootstrapV2, HostSessionPriorEventsV2};
use crate::*;
use deepcode_kernel_abi::v2::{CommandRequestId, InputId, RunId, UserDecisionRefV2};
use deepcode_kernel_abi::v2_command::{
    CapabilityScopeDispositionV2, CapabilityScopePreviewReplyV2,
};
use deepcode_kernel_abi::{
    CapabilityLeaseIdV2, CapabilityScopePreviewIdV2, TrustPolicyIdV2, UserDecisionErrorV2,
    UserDecisionReplyV2, UserDecisionResponseEnvelopeV2, UserDecisionRevokeTargetV2,
    WorkspaceBindingRefV2,
};
use std::collections::{HashMap, HashSet};

const MAX_AUTOMATIC_SESSION_STEPS_V2: usize = 128;
const PLAN_ACTION_PROVIDER_CALL_BUDGET_V2: u16 = 32;
const HOST_RUN_OPEN_REQUEST_KIND_V2: &str = "agent.run.open.v2";
const HOST_USER_INPUT_REQUEST_KIND_V2: &str = "agent.run.user-input.v2";
const HOST_DECISION_REQUEST_KIND_V2: &str = "agent.run.decision.v2";
const HOST_AUTHORITY_REVOKE_REQUEST_KIND_V2: &str = "agent.run.authority-revoke.v2";
const HOST_CANCEL_REQUEST_KIND_V2: &str = "agent.run.cancel.v2";
const HOST_CALLER_RUN_OUTCOME_SCHEMA_V2: &str = "deepcode.host.agent-run-outcome.v2";
const HOST_AUTHORITY_REVOKE_OUTCOME_SCHEMA_V2: &str = "deepcode.host.authority-revoke-outcome.v2";

#[derive(Debug, Clone)]
pub(crate) struct AgentKernelV2Error {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl AgentKernelV2Error {
    fn invalid(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn from_storage(error: HostV2StorageError) -> Self {
        Self {
            code: error.code.to_string(),
            message: error.message,
        }
    }
}

#[derive(Debug)]
enum PreparedAgentWorkspaceV2 {
    Bound {
        prepared: HostPreparedBoundWorkspaceV2,
        workspace: HostKernelRunWorkspaceV2,
    },
    Empty {
        prepared: HostPreparedEmptyWorkspaceV2,
        workspace: HostKernelRunWorkspaceV2,
    },
}

impl PreparedAgentWorkspaceV2 {
    fn workspace(&self) -> HostKernelRunWorkspaceV2 {
        match self {
            Self::Bound { workspace, .. } | Self::Empty { workspace, .. } => workspace.clone(),
        }
    }

    fn is_empty(&self) -> bool {
        matches!(self, Self::Empty { .. })
    }

    fn active_folder_id(&self) -> Option<&str> {
        match self {
            Self::Bound { workspace, .. } | Self::Empty { workspace, .. } => {
                workspace.active_folder_id.as_deref()
            }
        }
    }

    fn discard(self, state: &AppState) -> Result<(), AgentKernelV2Error> {
        match self {
            Self::Bound { prepared, .. } => state
                .host_services
                .discard_prepared_bound_run_workspace(&prepared)
                .map_err(|error| {
                    AgentKernelV2Error::invalid(
                        "host_kernel_workspace_cleanup_failed",
                        error.message,
                    )
                }),
            Self::Empty { prepared, .. } => state
                .host_services
                .discard_prepared_empty_run_workspace(&prepared)
                .map_err(|error| {
                    AgentKernelV2Error::invalid(
                        "host_kernel_workspace_cleanup_failed",
                        error.message,
                    )
                }),
        }
    }
}

#[derive(Debug, Clone)]
struct DurablePlanActionV2 {
    plan_action_id: String,
    operation_id: String,
}

#[derive(Debug, Clone)]
struct RuntimeCapabilityWaitV2 {
    preview_id: String,
    operation_id: String,
    invocation_id: String,
    plan_action_id: Option<String>,
    expected_plan_revision: Option<String>,
}

#[derive(Debug, Clone)]
enum PreparedAgentDecisionV2 {
    Plan {
        plan_revision: String,
        decision: HostKernelPlanDecisionV2,
        guidance: Option<String>,
        operation_request_id: String,
    },
    Permission {
        wait: RuntimeCapabilityWaitV2,
        host_decision: HostCapabilityDecisionKindV2,
        session_decision: HostKernelCapabilityDecisionV2,
        guidance: String,
        operation_request_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlanPreviewAuthorizationModeV2 {
    UserAllow,
    AutoPlanTrust,
}

struct PreparedOpenCallerRequestV2 {
    prompt: String,
    attachments: Vec<AgentInputAttachmentV2>,
    caller_request_id: String,
    request_digest: String,
    host_run_id: String,
    input_id: InputId,
    opaque_input_ref: String,
    run_open_request_id: String,
    operation_request_id: String,
}

pub(crate) fn preadmit_open_agent_kernel_run_v2(
    state: &AppState,
    session_id: &str,
    body: &AgentSessionRunRequest,
) -> Result<Option<String>, AgentKernelV2Error> {
    let prepared = prepare_open_caller_request_v2(session_id, body)?;
    let binding = bind_open_caller_request_v2(state, session_id, &prepared)?;
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &binding)? {
        return Ok(Some(host_run_id));
    }
    if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
        return recover_driving_caller_request_v2(state, &binding).map(Some);
    }
    Ok(None)
}

pub(crate) async fn open_agent_kernel_run_v2(
    state: &AppState,
    session_id: &str,
    body: &AgentSessionRunRequest,
    profile_id: &str,
    project_context: Option<&Value>,
    start_event_count: usize,
) -> Result<String, AgentKernelV2Error> {
    let prepared = prepare_open_caller_request_v2(session_id, body)?;
    let binding = bind_open_caller_request_v2(state, session_id, &prepared)?;
    let host_run_id = caller_binding_string_v2(&binding, "hostRunId")?;
    let input_id = InputId::new(caller_binding_string_v2(&binding, "inputId")?).map_err(|_| {
        AgentKernelV2Error::invalid(
            "host_kernel_input_identity_invalid",
            "Durable Host caller request contains an invalid input identity.",
        )
    })?;
    let opaque_input_ref = caller_binding_string_v2(&binding, "opaqueInputRef")?;
    let run_open_request_id = caller_binding_string_v2(&binding, "runOpenRequestId")?;
    let operation_request_id = caller_binding_string_v2(&binding, "operationRequestId")?;
    if let Some(replayed_host_run_id) = restore_caller_run_outcome_v2(state, &binding)? {
        return Ok(replayed_host_run_id);
    }
    if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
        return recover_driving_caller_request_v2(state, &binding);
    }
    if let Some(active) = state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(session_id)
        .map_err(AgentKernelV2Error::from_storage)?
    {
        if binding.replayed && active.host_run_id == host_run_id {
            let error = AgentKernelV2Error::invalid(
                "host_caller_request_indeterminate",
                "Caller binding exists beside an active Run without durable drive ownership; replay is unsafe.",
            );
            settle_caller_error_outcome_v2(state, &binding, &error, true)?;
            return Err(error);
        }
        return Err(AgentKernelV2Error::invalid(
            "session_run_already_active",
            format!(
                "Session already has durable active Run {}; only an exact caller request replay can reuse it",
                active.host_run_id
            ),
        ));
    }
    let settings_transition = crate::settings_api::settings_transition_gate_v2()
        .read()
        .await;
    let provider_profile = provider_profile_bootstrap_v2(state, profile_id)?;
    let prior_session_events = {
        let sessions_dir = state
            .gui
            .lock()
            .expect("gui state lock")
            .paths
            .sessions_dir
            .clone();
        let events = read_session_kernel_v2_public_agent_events(&sessions_dir, session_id)
            .map_err(AgentKernelV2Error::from_storage)?;
        HostSessionPriorEventsV2::bounded(session_id, events)
            .map_err(AgentKernelV2Error::from_storage)?
    };
    let binding = match claim_caller_drive_or_restore_v2(state, binding)? {
        CallerDriveAdmissionV2::Acquired(binding) => binding,
        CallerDriveAdmissionV2::Replayed(host_run_id) => return Ok(host_run_id),
    };
    let prepared_workspace =
        match prepare_agent_workspace_v2(state, session_id, &host_run_id, body, project_context) {
            Ok(prepared_workspace) => prepared_workspace,
            Err(error) => {
                settle_caller_error_outcome_v2(state, &binding, &error, true)?;
                return Err(error);
            }
        };
    if prepared_workspace.is_empty() && !prepared.attachments.is_empty() {
        let error = AgentKernelV2Error::invalid(
            "agent_input_attachment_workspace_required",
            "Attachments require a bound workspace.",
        );
        settle_caller_error_outcome_v2(state, &binding, &error, false)?;
        let _ = prepared_workspace.discard(state);
        return Err(error);
    }
    if let Err(folder_error) = validate_agent_attachment_folder_binding_v2(
        &prepared.attachments,
        prepared_workspace.active_folder_id(),
    ) {
        let error = AgentKernelV2Error::invalid(folder_error.code, folder_error.message);
        settle_caller_error_outcome_v2(state, &binding, &error, false)?;
        let _ = prepared_workspace.discard(state);
        return Err(error);
    }
    let initial_input = HostKernelInitialInputV2 {
        input_id: input_id.clone(),
        opaque_input_ref,
        text: prepared.prompt,
        attachments: prepared.attachments,
        recorded_at: binding.recorded_at.clone(),
    };
    let operation = HostKernelBridgeOperationV2::InitialTurn {
        guidance: Vec::new(),
    };
    cache_new_agent_run_v2(
        state,
        &host_run_id,
        session_id,
        profile_id,
        usize::try_from(prior_session_events.source_event_version).unwrap_or(start_event_count),
    );
    let opened = state
        .kernel_session_v2
        .open_and_spawn_initial(HostKernelRunSpawnInputV2 {
            session_id: session_id.to_string(),
            host_run_id: host_run_id.clone(),
            caller_request_id: binding.caller_request_id.clone(),
            caller_request_digest: binding.request_digest.clone(),
            run_open_request_id,
            operation_request_id,
            provider_profile,
            prior_session_events,
            workspace: prepared_workspace.workspace(),
            initial_input,
            operation,
        })
        .await;
    let opened = match opened {
        Ok(opened) => opened,
        Err(error) => {
            let final_error = match state
                .host_services
                .active_runs_v2
                .resolve_session_active_run(session_id)
            {
                Ok(Some(active)) if active.host_run_id == host_run_id => {
                    mark_agent_run_v2(
                        state,
                        &host_run_id,
                        "waiting",
                        Some(format!(
                            "Kernel–Session v2 Run start requires recovery: {}",
                            error.message
                        )),
                        None,
                    );
                    AgentKernelV2Error::from_storage(error)
                }
                Ok(Some(_)) => AgentKernelV2Error::invalid(
                        "host_kernel_run_start_cleanup_pending",
                        format!(
                            "RunOpen failed with {}; another durable active Run prevents proving workspace cleanup ownership",
                            error.code
                        ),
                    ),
                Err(resolve_error) => AgentKernelV2Error::invalid(
                        "host_kernel_run_start_cleanup_pending",
                        format!(
                            "RunOpen failed with {}; active Run inspection failed with {}",
                            error.code, resolve_error.code
                        ),
                    ),
                Ok(None) => {
                    let cleanup = prepared_workspace.discard(state);
                    mark_agent_run_v2(
                        state,
                        &host_run_id,
                        "failed",
                        Some(format!(
                            "Kernel–Session v2 RunOpen failed: {}",
                            error.message
                        )),
                        None,
                    );
                    match cleanup {
                        Ok(()) => AgentKernelV2Error::from_storage(error),
                        Err(cleanup_error) => AgentKernelV2Error::invalid(
                            "host_kernel_run_start_cleanup_pending",
                            format!(
                                "RunOpen failed with {}; prepared workspace cleanup also failed with {}",
                                error.code, cleanup_error.code
                            ),
                        ),
                    }
                }
            };
            settle_caller_error_outcome_v2(state, &binding, &final_error, true)?;
            return Err(final_error);
        }
    };
    drop(settings_transition);
    if let Err(error) =
        drive_agent_kernel_run_v2(state, &opened.active_run, opened.initial_operation).await
    {
        settle_caller_error_outcome_v2(state, &binding, &error, true)?;
        return Err(error);
    }
    settle_caller_run_outcome_v2(state, &binding, &host_run_id)?;
    Ok(host_run_id)
}

pub(crate) async fn resolve_agent_kernel_decision_v2(
    state: &AppState,
    session_id: &str,
    body: &AgentSessionRunRequest,
) -> Result<String, AgentKernelV2Error> {
    let caller_request_id = required_caller_request_id_v2(Some(&body.caller_request_id))?;
    let route_run_id = body
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_interaction_identity_required",
                "A trusted decision requires the exact active Run identity.",
            )
        })?;
    let decision_kind = body
        .decision_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_interaction_kind_invalid",
                "A supported Kernel–Session v2 decision kind is required.",
            )
        })?;
    if !matches!(decision_kind, "plan" | "permission") {
        return Err(AgentKernelV2Error::invalid(
            "session_interaction_v2_unsupported",
            "The requested decision kind is not part of the Kernel–Session v2 contract.",
        ));
    }
    let normalized_guidance = body
        .guidance
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let request_material = json!({
        "schemaVersion": "deepcode.host.caller-request-payload.v2",
        "kind": HOST_DECISION_REQUEST_KIND_V2,
        "sessionId": session_id,
        "routeRunId": route_run_id,
        "callerRequestId": caller_request_id,
        "decisionKind": decision_kind,
        "decision": body.decision,
        "guidance": normalized_guidance,
        "targetId": body.target_id,
    });
    let request_digest =
        canonical_sha256(&request_material).map_err(AgentKernelV2Error::from_storage)?;
    let existing = state
        .host_services
        .kernel_operations_v2
        .caller_request_binding(
            session_id,
            caller_request_id,
            HOST_DECISION_REQUEST_KIND_V2,
            &request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if let Some(binding) = existing.as_ref() {
        if let Some(replayed_host_run_id) = restore_caller_run_outcome_v2(state, binding)? {
            return Ok(replayed_host_run_id);
        }
        if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
            return recover_driving_caller_request_v2(state, binding);
        }
    }
    let active = require_active_agent_kernel_run_v2(state, session_id, body.run_id.as_deref())?;
    ensure_agent_run_cache_v2(state, &active)?;
    let binding = match existing {
        Some(binding) => binding,
        None => {
            let current = latest_settlement_v2(state, &active)?;
            let prepared =
                prepare_agent_decision_v2(&active, body, &current, decision_kind, &request_digest)?;
            state
                .host_services
                .kernel_operations_v2
                .bind_caller_request(HostCallerRequestBindingInputV2 {
                    session_id: session_id.to_string(),
                    caller_request_id: caller_request_id.to_string(),
                    request_kind: HOST_DECISION_REQUEST_KIND_V2.to_string(),
                    request_digest: request_digest.clone(),
                    response_identity: prepared_agent_decision_identity_v2(
                        &active, &current, &prepared,
                    ),
                    recorded_at: now_rfc3339_utc_v2(),
                })
                .map_err(AgentKernelV2Error::from_storage)?
        }
    };
    if caller_binding_string_v2(&binding, "hostRunId")? != active.host_run_id
        || caller_binding_string_v2(&binding, "runId")? != active.run_id
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_run_conflict",
            "Durable Host decision is bound to a different Run.",
        ));
    }
    let prepared = decode_prepared_agent_decision_v2(&binding)?;
    let binding = match claim_caller_drive_or_restore_v2(state, binding)? {
        CallerDriveAdmissionV2::Acquired(binding) => binding,
        CallerDriveAdmissionV2::Replayed(host_run_id) => return Ok(host_run_id),
    };
    mark_agent_run_v2(
        state,
        &active.host_run_id,
        "running",
        Some("Applying trusted Kernel–Session v2 decision.".to_string()),
        None,
    );
    if let Err(error) = execute_prepared_agent_decision_v2(state, &active, &binding, prepared).await
    {
        settle_caller_error_outcome_v2(state, &binding, &error, true)?;
        return Err(error);
    }
    settle_caller_run_outcome_v2(state, &binding, &active.host_run_id)?;
    Ok(active.host_run_id)
}

pub(crate) fn revoke_agent_kernel_authority_v2(
    state: &AppState,
    session_id: &str,
    route_run_id: &str,
    body: &AgentAuthorityRevokeRequestV2,
) -> Result<Value, AgentKernelV2Error> {
    let caller_request_id =
        required_caller_request_id_v2(Some(&body.caller_request_id))?.to_string();
    let reason = body.reason.trim();
    if reason.is_empty() || reason.len() > 16 * 1024 || reason.chars().any(char::is_control) {
        return Err(AgentKernelV2Error::invalid(
            "host_authority_revoke_reason_invalid",
            "Authority revocation requires a bounded reason without control characters.",
        ));
    }
    let request_material = json!({
        "schemaVersion": "deepcode.host.caller-request-payload.v2",
        "kind": HOST_AUTHORITY_REVOKE_REQUEST_KIND_V2,
        "sessionId": session_id,
        "routeRunId": route_run_id,
        "callerRequestId": caller_request_id,
        "target": body.target,
        "reason": reason,
    });
    let request_digest =
        canonical_sha256(&request_material).map_err(AgentKernelV2Error::from_storage)?;
    let existing = state
        .host_services
        .kernel_operations_v2
        .caller_request_binding(
            session_id,
            &caller_request_id,
            HOST_AUTHORITY_REVOKE_REQUEST_KIND_V2,
            &request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    let binding = match existing {
        Some(binding) => binding,
        None => {
            let active = require_active_agent_kernel_run_v2(state, session_id, Some(route_run_id))?;
            let target = authority_revoke_target_v2(&body.target)?;
            let identity_material = json!({
                "schemaVersion": "deepcode.host.authority-revoke-identity.v2",
                "sessionId": session_id,
                "hostRunId": active.host_run_id,
                "runId": active.run_id,
                "callerRequestId": caller_request_id,
                "requestDigest": request_digest,
                "target": body.target,
                "reason": reason,
            });
            let request_id = CommandRequestId::new(stable_identity_v2(
                "authority-revoke-request",
                &identity_material,
            )?)
            .map_err(|_| {
                AgentKernelV2Error::invalid(
                    "host_authority_revoke_request_id_invalid",
                    "Authority revoke request identity is invalid.",
                )
            })?;
            let decision_ref = UserDecisionRefV2::new(stable_identity_v2(
                "authority-revoke-decision",
                &identity_material,
            )?)
            .map_err(|_| {
                AgentKernelV2Error::invalid(
                    "host_authority_revoke_decision_ref_invalid",
                    "Authority revoke decision identity is invalid.",
                )
            })?;
            let resolved = state
                .kernel_v2
                .resolve_host_authority_revoke(HostAuthorityRevokeResolveRequestV2 {
                    run_id: RunId::new(active.run_id.clone()).map_err(|_| {
                        AgentKernelV2Error::invalid(
                            "host_authority_revoke_run_id_invalid",
                            "Durable Kernel Run identity is invalid.",
                        )
                    })?,
                    decision_ref,
                    target,
                    reason: reason.to_string(),
                })
                .map_err(host_decision_error_v2)?;
            if resolved.run_id.as_str() != active.run_id {
                return Err(AgentKernelV2Error::invalid(
                    "host_authority_revoke_run_conflict",
                    "Kernel resolved authority revocation for a different Run.",
                ));
            }
            state
                .host_services
                .kernel_operations_v2
                .bind_caller_request(HostCallerRequestBindingInputV2 {
                    session_id: session_id.to_string(),
                    caller_request_id: caller_request_id.clone(),
                    request_kind: HOST_AUTHORITY_REVOKE_REQUEST_KIND_V2.to_string(),
                    request_digest: request_digest.clone(),
                    response_identity: json!({
                        "hostRunId": active.host_run_id,
                        "runId": active.run_id,
                        "requestId": request_id,
                        "resolved": resolved,
                    }),
                    recorded_at: now_rfc3339_utc_v2(),
                })
                .map_err(AgentKernelV2Error::from_storage)?
        }
    };
    require_authority_revoke_route_binding_v2(&binding, route_run_id)?;
    if let Some(result) = restore_authority_revoke_outcome_v2(&binding)? {
        return Ok(result);
    }
    let request_id = CommandRequestId::new(caller_binding_string_v2(&binding, "requestId")?)
        .map_err(|_| {
            AgentKernelV2Error::invalid(
                "host_authority_revoke_request_id_invalid",
                "Durable authority revoke request identity is invalid.",
            )
        })?;
    let resolved: HostResolvedAuthorityRevokeV2 = serde_json::from_value(
        binding
            .response_identity
            .get("resolved")
            .cloned()
            .ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "host_authority_revoke_identity_invalid",
                    "Durable authority revoke has no exact resolved decision.",
                )
            })?,
    )
    .map_err(|_| {
        AgentKernelV2Error::invalid(
            "host_authority_revoke_identity_invalid",
            "Durable authority revoke decision is invalid.",
        )
    })?;
    if resolved.run_id.as_str() != caller_binding_string_v2(&binding, "runId")? {
        return Err(AgentKernelV2Error::invalid(
            "host_authority_revoke_run_conflict",
            "Durable authority revoke decision is bound to a different Run.",
        ));
    }
    let response = state
        .kernel_v2
        .apply_host_resolved_authority_revoke(request_id.clone(), resolved)
        .map_err(host_decision_error_v2)?;
    match &response {
        UserDecisionResponseEnvelopeV2::Correlated {
            request_id: response_request_id,
            reply:
                UserDecisionReplyV2::Revoked { .. }
                | UserDecisionReplyV2::Stale { .. }
                | UserDecisionReplyV2::Error(_),
            ..
        } if response_request_id == &request_id => {}
        _ => {
            return Err(AgentKernelV2Error::invalid(
                "host_authority_revoke_reply_invalid",
                "Kernel returned an invalid or uncorrelated authority revoke reply.",
            ))
        }
    }
    let result = json!({
        "schemaVersion": HOST_AUTHORITY_REVOKE_OUTCOME_SCHEMA_V2,
        "hostRunId": caller_binding_string_v2(&binding, "hostRunId")?,
        "runId": caller_binding_string_v2(&binding, "runId")?,
        "response": response,
    });
    state
        .host_services
        .kernel_operations_v2
        .settle_caller_request(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            json!({
                "schemaVersion": HOST_AUTHORITY_REVOKE_OUTCOME_SCHEMA_V2,
                "disposition": "succeeded",
                "hostRunId": caller_binding_string_v2(&binding, "hostRunId")?,
                "runId": caller_binding_string_v2(&binding, "runId")?,
                "response": response,
            }),
            now_rfc3339_utc_v2(),
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    Ok(result)
}

fn validate_active_run_attachment_binding_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    attachments: &[AgentInputAttachmentV2],
) -> Result<(), AgentKernelV2Error> {
    if attachments.is_empty() {
        return Ok(());
    }
    if active.workspace_kind != HostRunWorkspaceKindV2::Bound {
        return Err(AgentKernelV2Error::invalid(
            "agent_input_attachment_workspace_required",
            "Attachments require a bound workspace.",
        ));
    }
    let workspace_binding_ref = WorkspaceBindingRefV2::new(active.workspace_binding_ref.clone())
        .map_err(|_| {
            AgentKernelV2Error::invalid(
                "agent_input_attachment_workspace_unverifiable",
                "The active Run workspace binding reference is invalid.",
            )
        })?;
    let current_binding = state
        .host_services
        .workspace
        .resolve_exact_run_binding(&workspace_binding_ref, &active.workspace_binding_identity)
        .map_err(|error| {
            AgentKernelV2Error::invalid(
                "agent_input_attachment_workspace_unverifiable",
                format!(
                    "The active Run workspace root cannot be proven unchanged: {}",
                    error.message
                ),
            )
        })?;
    if let Some(authoritative_folder_id) = active.active_folder_id.as_deref() {
        if current_binding.active_folder_id.as_deref() != Some(authoritative_folder_id) {
            return Err(AgentKernelV2Error::invalid(
                "agent_input_attachment_folder_binding_stale",
                "The durable Run folder identity no longer matches its exact workspace root.",
            ));
        }
    }
    validate_agent_attachment_folder_binding_v2(attachments, active.active_folder_id.as_deref())
        .map_err(|error| AgentKernelV2Error::invalid(error.code, error.message))
}

pub(crate) async fn submit_agent_kernel_user_input_v2(
    state: &AppState,
    session_id: &str,
    route_run_id: &str,
    guidance: &str,
    attachments: Option<&[AgentInputAttachmentV2]>,
    caller_request_id: &str,
) -> Result<String, AgentKernelV2Error> {
    let text = Some(guidance)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AgentKernelV2Error::invalid("empty_guidance", "guidance must not be empty"))?
        .to_string();
    let attachments = validate_agent_input_attachments_v2(attachments)
        .map_err(|error| AgentKernelV2Error::invalid(error.code, error.message))?;
    let caller_request_id = required_caller_request_id_v2(Some(caller_request_id))?;
    let request_material = json!({
        "schemaVersion": "deepcode.host.caller-request-payload.v2",
        "kind": HOST_USER_INPUT_REQUEST_KIND_V2,
        "sessionId": session_id,
        "routeRunId": route_run_id,
        "callerRequestId": caller_request_id,
        "text": text,
        "attachments": attachments,
    });
    let request_digest =
        canonical_sha256(&request_material).map_err(AgentKernelV2Error::from_storage)?;
    let existing = state
        .host_services
        .kernel_operations_v2
        .caller_request_binding(
            session_id,
            caller_request_id,
            HOST_USER_INPUT_REQUEST_KIND_V2,
            &request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if let Some(binding) = existing.as_ref() {
        if let Some(replayed_host_run_id) = restore_caller_run_outcome_v2(state, binding)? {
            return Ok(replayed_host_run_id);
        }
        if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
            return recover_or_resume_driving_user_input_v2(state, binding).await;
        }
    }
    let active = require_active_agent_kernel_run_v2(state, session_id, Some(route_run_id))?;
    validate_active_run_attachment_binding_v2(state, &active, &attachments)?;
    ensure_agent_run_cache_v2(state, &active)?;
    let binding = match existing {
        Some(binding) => binding,
        None => {
            let previous = latest_settlement_v2(state, &active)?;
            let recorded_at = now_rfc3339_utc_v2();
            let material = json!({
                "schemaVersion": "deepcode.host.agent-input.v2",
                "sessionId": session_id,
                "hostRunId": active.host_run_id,
                "runId": active.run_id,
                "callerRequestId": caller_request_id,
                "requestDigest": request_digest,
                "text": text,
                "attachments": attachments,
            });
            let input_id = typed_input_id("user", &material)?;
            let opaque_input_ref = stable_identity_v2("input-ref", &material)?;
            let identity_input = HostKernelInitialInputV2 {
                input_id: input_id.clone(),
                opaque_input_ref: opaque_input_ref.clone(),
                text: text.clone(),
                attachments: attachments.clone(),
                recorded_at: recorded_at.clone(),
            };
            let identity_operation = HostKernelBridgeOperationV2::UserInput {
                input: identity_input.clone(),
                guidance: Vec::new(),
            };
            let operation_request_id =
                next_operation_request_id_v2(&previous, &identity_operation)?;
            state
                .host_services
                .kernel_operations_v2
                .bind_caller_request(HostCallerRequestBindingInputV2 {
                    session_id: session_id.to_string(),
                    caller_request_id: caller_request_id.to_string(),
                    request_kind: HOST_USER_INPUT_REQUEST_KIND_V2.to_string(),
                    request_digest: request_digest.clone(),
                    response_identity: json!({
                        "hostRunId": active.host_run_id,
                        "runId": active.run_id,
                        "predecessorSettlementDigest": previous.settlement_digest,
                        "inputId": input_id.as_str(),
                        "opaqueInputRef": opaque_input_ref,
                        "operationRequestId": operation_request_id,
                        "semanticInput": identity_input,
                    }),
                    recorded_at,
                })
                .map_err(AgentKernelV2Error::from_storage)?
        }
    };
    if caller_binding_string_v2(&binding, "hostRunId")? != active.host_run_id
        || caller_binding_string_v2(&binding, "runId")? != active.run_id
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_run_conflict",
            "Durable Host caller request is bound to a different Run.",
        ));
    }
    let input = durable_user_input_from_binding_v2(&binding)?;
    let request_id = caller_binding_string_v2(&binding, "operationRequestId")?;
    let binding = match claim_user_input_drive_or_restore_v2(state, binding).await? {
        CallerDriveAdmissionV2::Acquired(binding) => binding,
        CallerDriveAdmissionV2::Replayed(host_run_id) => return Ok(host_run_id),
    };
    drive_bound_user_input_v2(state, &active, &binding, input, &request_id).await
}

async fn drive_bound_user_input_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
    input: HostKernelInitialInputV2,
    request_id: &str,
) -> Result<String, AgentKernelV2Error> {
    let operation = HostKernelBridgeOperationV2::UserInput {
        input,
        guidance: Vec::new(),
    };
    mark_agent_run_v2(
        state,
        &active.host_run_id,
        "running",
        Some("New user input is advancing the control epoch.".to_string()),
        None,
    );
    let settlement = match state
        .kernel_session_v2
        .submit_operation(
            &active.session_id,
            &active.host_run_id,
            request_id,
            operation,
        )
        .await
        .map_err(AgentKernelV2Error::from_storage)
    {
        Ok(settlement) => settlement,
        Err(error) => {
            settle_caller_error_outcome_v2(state, binding, &error, true)?;
            return Err(error);
        }
    };
    if let Err(error) = drive_agent_kernel_run_v2(state, active, settlement).await {
        settle_caller_error_outcome_v2(state, binding, &error, true)?;
        return Err(error);
    }
    settle_caller_run_outcome_v2(state, binding, &active.host_run_id)?;
    Ok(active.host_run_id.clone())
}

fn durable_user_input_from_binding_v2(
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<HostKernelInitialInputV2, AgentKernelV2Error> {
    if binding.request_kind != HOST_USER_INPUT_REQUEST_KIND_V2 {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_kind_conflict",
            "Durable semantic user input belongs to a different caller request kind.",
        ));
    }
    let input: HostKernelInitialInputV2 = serde_json::from_value(
        binding
            .response_identity
            .get("semanticInput")
            .cloned()
            .ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "host_caller_request_semantic_input_missing",
                    "Durable Host caller request has no exact semantic user input.",
                )
            })?,
    )
    .map_err(|_| {
        AgentKernelV2Error::invalid(
            "host_caller_request_semantic_input_invalid",
            "Durable Host caller request semantic user input is invalid.",
        )
    })?;
    validate_agent_input_attachment_slice_v2(&input.attachments)
        .map_err(|error| AgentKernelV2Error::invalid(error.code, error.message))?;
    if input.text.is_empty() || input.text.trim() != input.text {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_semantic_input_invalid",
            "Durable Host caller request semantic user input text is invalid.",
        ));
    }
    if input.input_id.as_str() != caller_binding_string_v2(binding, "inputId")?
        || input.opaque_input_ref != caller_binding_string_v2(binding, "opaqueInputRef")?
        || input.recorded_at != binding.recorded_at
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_semantic_input_conflict",
            "Durable semantic user input does not match its caller request identity.",
        ));
    }
    Ok(input)
}

pub(crate) async fn cancel_agent_kernel_run_v2(
    state: &AppState,
    session_id: &str,
    route_run_id: &str,
    caller_request_id: &str,
) -> Result<Option<String>, AgentKernelV2Error> {
    let caller_request_id = required_caller_request_id_v2(Some(caller_request_id))?;
    let request_material = json!({
        "schemaVersion": "deepcode.host.caller-request-payload.v2",
        "kind": HOST_CANCEL_REQUEST_KIND_V2,
        "sessionId": session_id,
        "routeRunId": route_run_id,
        "callerRequestId": caller_request_id,
    });
    let request_digest =
        canonical_sha256(&request_material).map_err(AgentKernelV2Error::from_storage)?;
    let existing = state
        .host_services
        .kernel_operations_v2
        .caller_request_binding(
            session_id,
            caller_request_id,
            HOST_CANCEL_REQUEST_KIND_V2,
            &request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if let Some(binding) = existing.as_ref() {
        if let Some(replayed_host_run_id) = restore_caller_run_outcome_v2(state, binding)? {
            return Ok(Some(replayed_host_run_id));
        }
        if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
            return recover_driving_caller_request_v2(state, binding).map(Some);
        }
    }
    let Some(active) = state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(session_id)
        .map_err(AgentKernelV2Error::from_storage)?
    else {
        if existing.is_some() {
            return Err(AgentKernelV2Error::invalid(
                "host_caller_request_recovery_required",
                "The exact cancellation was admitted but has no durable response outcome; automatic retry is unsafe.",
            ));
        }
        return Ok(None);
    };
    require_route_run_identity_v2(&active, route_run_id)?;
    ensure_agent_run_cache_v2(state, &active)?;
    let binding = match existing {
        Some(binding) => binding,
        None => state
            .host_services
            .kernel_operations_v2
            .bind_caller_request(HostCallerRequestBindingInputV2 {
                session_id: session_id.to_string(),
                caller_request_id: caller_request_id.to_string(),
                request_kind: HOST_CANCEL_REQUEST_KIND_V2.to_string(),
                request_digest,
                response_identity: json!({
                    "hostRunId": active.host_run_id,
                    "runId": active.run_id,
                }),
                recorded_at: now_rfc3339_utc_v2(),
            })
            .map_err(AgentKernelV2Error::from_storage)?,
    };
    if caller_binding_string_v2(&binding, "hostRunId")? != active.host_run_id
        || caller_binding_string_v2(&binding, "runId")? != active.run_id
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_run_conflict",
            "Durable Host cancellation is bound to a different Run.",
        ));
    }
    let binding = match claim_caller_drive_or_restore_v2(state, binding)? {
        CallerDriveAdmissionV2::Acquired(binding) => binding,
        CallerDriveAdmissionV2::Replayed(host_run_id) => return Ok(Some(host_run_id)),
    };
    if let Err(error) = state
        .kernel_session_v2
        .retire_run_for_caller(
            session_id,
            &active.host_run_id,
            &active.run_id,
            &binding.caller_request_id,
            &binding.request_digest,
        )
        .await
        .map_err(AgentKernelV2Error::from_storage)
    {
        settle_caller_error_outcome_v2(state, &binding, &error, true)?;
        return Err(error);
    }
    mark_agent_run_v2(
        state,
        &active.host_run_id,
        "cancelled",
        Some("Kernel–Session v2 Run cancelled and its owned resources were retired.".to_string()),
        None,
    );
    settle_caller_run_outcome_v2(state, &binding, &active.host_run_id)?;
    Ok(Some(active.host_run_id))
}

pub(crate) async fn retire_agent_kernel_run_v2(
    state: &AppState,
    session_id: &str,
    route_run_id: Option<&str>,
    terminal_status: &str,
    message: &str,
) -> Result<Option<String>, AgentKernelV2Error> {
    let Some(active) = state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(session_id)
        .map_err(AgentKernelV2Error::from_storage)?
    else {
        return Ok(None);
    };
    if let Some(route_run_id) = route_run_id {
        require_route_run_identity_v2(&active, route_run_id)?;
    }
    ensure_agent_run_cache_v2(state, &active)?;
    state
        .kernel_session_v2
        .retire_run(session_id, &active.host_run_id, &active.run_id)
        .await
        .map_err(AgentKernelV2Error::from_storage)?;
    mark_agent_run_v2(
        state,
        &active.host_run_id,
        terminal_status,
        Some(message.to_string()),
        None,
    );
    Ok(Some(active.host_run_id))
}

pub(crate) fn restore_agent_kernel_run_cache_v2(
    state: &AppState,
    session_id: &str,
    route_run_id: &str,
) -> Result<String, AgentKernelV2Error> {
    let active = require_active_agent_kernel_run_v2(state, session_id, Some(route_run_id))?;
    ensure_agent_run_cache_v2(state, &active)?;
    Ok(active.host_run_id)
}

fn prepare_open_caller_request_v2(
    session_id: &str,
    body: &AgentSessionRunRequest,
) -> Result<PreparedOpenCallerRequestV2, AgentKernelV2Error> {
    let prompt = body
        .content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "agent_prompt_required",
                "A non-empty prompt is required to open a Kernel–Session v2 Run.",
            )
        })?
        .to_string();
    let attachments = validate_agent_input_attachments_v2(body.attachments.as_deref())
        .map_err(|error| AgentKernelV2Error::invalid(error.code, error.message))?;
    let caller_request_id =
        required_caller_request_id_v2(Some(&body.caller_request_id))?.to_string();
    let no_workspace = body.no_workspace.unwrap_or(false);
    let workspace_path = (!no_workspace)
        .then(|| {
            body.workspace_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .flatten();
    let request_material = json!({
        "schemaVersion": "deepcode.host.caller-request-payload.v2",
        "kind": HOST_RUN_OPEN_REQUEST_KIND_V2,
        "sessionId": session_id,
        "callerRequestId": caller_request_id,
        "prompt": prompt,
        "attachments": attachments,
        "workspacePath": workspace_path,
        "noWorkspace": no_workspace,
    });
    let request_digest =
        canonical_sha256(&request_material).map_err(AgentKernelV2Error::from_storage)?;
    let host_run_id = stable_identity_v2(
        "host-run",
        &json!({
            "sessionId": session_id,
            "callerRequestId": caller_request_id,
        }),
    )?;
    let initial_material = json!({
        "schemaVersion": "deepcode.host.agent-input.v2",
        "sessionId": session_id,
        "hostRunId": host_run_id,
        "callerRequestId": caller_request_id,
        "requestDigest": request_digest,
        "text": prompt,
        "attachments": attachments,
    });
    let input_id = typed_input_id("initial", &initial_material)?;
    let opaque_input_ref = stable_identity_v2("input-ref", &initial_material)?;
    let run_open_request_id = stable_identity_v2(
        "run-open",
        &json!({
            "sessionId": session_id,
            "hostRunId": host_run_id,
            "callerRequestId": caller_request_id,
            "requestDigest": request_digest,
            "inputId": input_id,
        }),
    )?;
    let operation = HostKernelBridgeOperationV2::InitialTurn {
        guidance: Vec::new(),
    };
    let operation_request_id =
        stable_operation_request_id_v2("initial-turn", &run_open_request_id, &operation)?;
    Ok(PreparedOpenCallerRequestV2 {
        prompt,
        attachments,
        caller_request_id,
        request_digest,
        host_run_id,
        input_id,
        opaque_input_ref,
        run_open_request_id,
        operation_request_id,
    })
}

fn bind_open_caller_request_v2(
    state: &AppState,
    session_id: &str,
    prepared: &PreparedOpenCallerRequestV2,
) -> Result<HostCallerRequestBindingReceiptV2, AgentKernelV2Error> {
    state
        .host_services
        .kernel_operations_v2
        .bind_caller_request(HostCallerRequestBindingInputV2 {
            session_id: session_id.to_string(),
            caller_request_id: prepared.caller_request_id.clone(),
            request_kind: HOST_RUN_OPEN_REQUEST_KIND_V2.to_string(),
            request_digest: prepared.request_digest.clone(),
            response_identity: json!({
                "hostRunId": prepared.host_run_id,
                "inputId": prepared.input_id.as_str(),
                "opaqueInputRef": prepared.opaque_input_ref,
                "runOpenRequestId": prepared.run_open_request_id,
                "operationRequestId": prepared.operation_request_id,
            }),
            recorded_at: now_rfc3339_utc_v2(),
        })
        .map_err(AgentKernelV2Error::from_storage)
}

fn prepare_agent_workspace_v2(
    state: &AppState,
    session_id: &str,
    host_run_id: &str,
    body: &AgentSessionRunRequest,
    project_context: Option<&Value>,
) -> Result<PreparedAgentWorkspaceV2, AgentKernelV2Error> {
    let project_kind = project_context
        .and_then(|context| context.get("kind"))
        .and_then(Value::as_str);
    let no_workspace = matches!(project_kind, Some("blank"))
        || (project_context.is_none() && body.no_workspace.unwrap_or(false));
    if no_workspace {
        let prepared = state
            .host_services
            .prepare_empty_run_workspace(session_id, host_run_id)
            .map_err(|error| {
                AgentKernelV2Error::invalid("host_kernel_workspace_prepare_failed", error.message)
            })?;
        let workspace = HostKernelRunWorkspaceV2 {
            workspace_binding_ref: prepared.workspace_binding_ref.clone(),
            workspace_binding_identity: prepared.workspace_binding_identity.clone(),
            workspace_kind: HostRunWorkspaceKindV2::Empty,
            active_folder_id: None,
            empty_workspace_key: Some(prepared.empty_workspace_key.clone()),
            run_settings: prepared.run_settings.clone(),
        };
        return Ok(PreparedAgentWorkspaceV2::Empty {
            prepared,
            workspace,
        });
    }
    let project_workspace_path = project_context
        .and_then(|context| context.pointer("/workspaceBinding/openPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let workspace_path = project_workspace_path
        .or(body.workspace_path.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "host_kernel_workspace_required",
                "A trusted workspace path is required for this v2 Run.",
            )
        })?;
    let prepared = state
        .host_services
        .prepare_bound_run_workspace(workspace_path)
        .map_err(|error| {
            AgentKernelV2Error::invalid("host_kernel_workspace_prepare_failed", error.message)
        })?;
    let active_folder_id = project_workspace_path.and_then(|_| {
        project_context
            .and_then(|context| context.pointer("/workspaceBinding/activeFolderId"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    deepcode_kernel_abi::validate_optional_agent_attachment_id_v2(
        active_folder_id.as_deref(),
        "activeFolderId",
    )
    .map_err(|error| AgentKernelV2Error::invalid(error.code, error.message))?;
    let settings = state
        .kernel_v2
        .settings_resolver()
        .resolve_run_settings(&prepared.workspace_binding_ref)
        .map_err(|_| {
            AgentKernelV2Error::invalid(
                "host_kernel_settings_unavailable",
                "The Host could not resolve the immutable Run Settings ceiling.",
            )
        })?;
    let workspace = HostKernelRunWorkspaceV2 {
        workspace_binding_ref: prepared.workspace_binding_ref.clone(),
        workspace_binding_identity: prepared.workspace_binding_identity.clone(),
        workspace_kind: HostRunWorkspaceKindV2::Bound,
        active_folder_id,
        empty_workspace_key: None,
        run_settings: HostRunSettingsCeilingV2 {
            workspace_read: settings.workspace_read,
            workspace_write: settings.workspace_write,
            web_read: settings.web_read,
            auto_approve_plans: settings.auto_approve_plans,
        },
    };
    Ok(PreparedAgentWorkspaceV2::Bound {
        prepared,
        workspace,
    })
}

fn prepare_agent_decision_v2(
    active: &HostActiveRunRecordV2,
    body: &AgentSessionRunRequest,
    current: &HostKernelOperationSettlementReceiptV2,
    decision_kind: &str,
    request_digest: &str,
) -> Result<PreparedAgentDecisionV2, AgentKernelV2Error> {
    match decision_kind {
        "plan" => {
            if continuation_kind_v2(current) != Some("awaitingUserPlanConfirmation") {
                return Err(AgentKernelV2Error::invalid(
                    "session_plan_decision_stale",
                    "The durable v2 Run is not awaiting Plan confirmation.",
                ));
            }
            let plan_revision = continuation_field_v2(current, "planRevision")
                .ok_or_else(|| {
                    AgentKernelV2Error::invalid(
                        "session_plan_revision_missing",
                        "The durable Plan confirmation has no revision.",
                    )
                })?
                .to_string();
            let target_id = body
                .target_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    AgentKernelV2Error::invalid(
                        "session_plan_identity_required",
                        "Plan decision requires the exact plan revision.",
                    )
                })?;
            if target_id != plan_revision {
                return Err(AgentKernelV2Error::invalid(
                    "session_plan_decision_stale",
                    "Plan decision does not match the durable current Plan revision.",
                ));
            }
            let decision = match body.decision.as_deref() {
                Some("accept") => HostKernelPlanDecisionV2::Accept,
                Some("reject") => HostKernelPlanDecisionV2::Reject,
                Some("revise") => HostKernelPlanDecisionV2::Revise,
                _ => {
                    return Err(AgentKernelV2Error::invalid(
                        "session_interaction_decision_invalid",
                        "Plan decision must be accept, reject, or revise.",
                    ))
                }
            };
            let guidance = match decision {
                HostKernelPlanDecisionV2::Accept => body
                    .guidance
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                HostKernelPlanDecisionV2::Reject => Some(
                    body.guidance
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("User rejected the current Plan; produce a new Plan.")
                        .to_string(),
                ),
                HostKernelPlanDecisionV2::Revise => Some(
                    body.guidance
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("User requested a revised Plan.")
                        .to_string(),
                ),
            };
            let operation_request_id = stable_identity_v2(
                "decision-operation",
                &json!({
                    "requestDigest": request_digest,
                    "runId": active.run_id,
                    "decisionKind": "plan",
                    "planRevision": plan_revision,
                    "decision": plan_decision_name_v2(decision),
                    "guidance": guidance,
                }),
            )?;
            Ok(PreparedAgentDecisionV2::Plan {
                plan_revision,
                decision,
                guidance,
                operation_request_id,
            })
        }
        "permission" => {
            let wait = runtime_capability_wait_v2(current)?;
            let target_id = body
                .target_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    AgentKernelV2Error::invalid(
                        "session_permission_identity_required",
                        "Permission decision requires the exact scope preview identity.",
                    )
                })?;
            if target_id != wait.preview_id {
                return Err(AgentKernelV2Error::invalid(
                    "session_permission_decision_stale",
                    "Permission decision does not match the durable current capability wait.",
                ));
            }
            let (host_decision, session_decision, guidance) =
                normalized_permission_decision_v2(body)?;
            let operation_request_id = stable_identity_v2(
                "decision-operation",
                &json!({
                    "requestDigest": request_digest,
                    "runId": active.run_id,
                    "decisionKind": "permission",
                    "previewId": wait.preview_id,
                    "operationId": wait.operation_id,
                    "invocationId": wait.invocation_id,
                    "decision": capability_decision_name_v2(host_decision),
                    "guidance": guidance,
                }),
            )?;
            Ok(PreparedAgentDecisionV2::Permission {
                wait,
                host_decision,
                session_decision,
                guidance,
                operation_request_id,
            })
        }
        _ => Err(AgentKernelV2Error::invalid(
            "session_interaction_kind_invalid",
            "A supported Kernel–Session v2 decision kind is required.",
        )),
    }
}

fn prepared_agent_decision_identity_v2(
    active: &HostActiveRunRecordV2,
    current: &HostKernelOperationSettlementReceiptV2,
    prepared: &PreparedAgentDecisionV2,
) -> Value {
    match prepared {
        PreparedAgentDecisionV2::Plan {
            plan_revision,
            decision,
            guidance,
            operation_request_id,
        } => json!({
            "hostRunId": active.host_run_id,
            "runId": active.run_id,
            "predecessorSettlementDigest": current.settlement_digest,
            "decisionKind": "plan",
            "planRevision": plan_revision,
            "decision": plan_decision_name_v2(*decision),
            "guidance": guidance,
            "operationRequestId": operation_request_id,
        }),
        PreparedAgentDecisionV2::Permission {
            wait,
            host_decision,
            guidance,
            operation_request_id,
            ..
        } => json!({
            "hostRunId": active.host_run_id,
            "runId": active.run_id,
            "predecessorSettlementDigest": current.settlement_digest,
            "decisionKind": "permission",
            "previewId": wait.preview_id,
            "operationId": wait.operation_id,
            "invocationId": wait.invocation_id,
            "planActionId": wait.plan_action_id,
            "expectedPlanRevision": wait.expected_plan_revision,
            "decision": capability_decision_name_v2(*host_decision),
            "guidance": guidance,
            "operationRequestId": operation_request_id,
        }),
    }
}

fn decode_prepared_agent_decision_v2(
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<PreparedAgentDecisionV2, AgentKernelV2Error> {
    let operation_request_id = caller_binding_string_v2(binding, "operationRequestId")?;
    match binding
        .response_identity
        .get("decisionKind")
        .and_then(Value::as_str)
    {
        Some("plan") => {
            let decision = match binding
                .response_identity
                .get("decision")
                .and_then(Value::as_str)
            {
                Some("accept") => HostKernelPlanDecisionV2::Accept,
                Some("reject") => HostKernelPlanDecisionV2::Reject,
                Some("revise") => HostKernelPlanDecisionV2::Revise,
                _ => {
                    return Err(AgentKernelV2Error::invalid(
                        "host_caller_request_identity_invalid",
                        "Durable Host Plan decision has an invalid decision.",
                    ))
                }
            };
            Ok(PreparedAgentDecisionV2::Plan {
                plan_revision: caller_binding_string_v2(binding, "planRevision")?,
                decision,
                guidance: binding
                    .response_identity
                    .get("guidance")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                operation_request_id,
            })
        }
        Some("permission") => {
            let (host_decision, session_decision) = match binding
                .response_identity
                .get("decision")
                .and_then(Value::as_str)
            {
                Some("allow") => (
                    HostCapabilityDecisionKindV2::Allow,
                    HostKernelCapabilityDecisionV2::Allow,
                ),
                Some("deny") => (
                    HostCapabilityDecisionKindV2::Deny,
                    HostKernelCapabilityDecisionV2::Deny,
                ),
                _ => {
                    return Err(AgentKernelV2Error::invalid(
                        "host_caller_request_identity_invalid",
                        "Durable Host capability decision has an invalid decision.",
                    ))
                }
            };
            Ok(PreparedAgentDecisionV2::Permission {
                wait: RuntimeCapabilityWaitV2 {
                    preview_id: caller_binding_string_v2(binding, "previewId")?,
                    operation_id: caller_binding_string_v2(binding, "operationId")?,
                    invocation_id: caller_binding_string_v2(binding, "invocationId")?,
                    plan_action_id: binding
                        .response_identity
                        .get("planActionId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    expected_plan_revision: binding
                        .response_identity
                        .get("expectedPlanRevision")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
                host_decision,
                session_decision,
                guidance: binding
                    .response_identity
                    .get("guidance")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                operation_request_id,
            })
        }
        _ => Err(AgentKernelV2Error::invalid(
            "host_caller_request_identity_invalid",
            "Durable Host caller request has an invalid decision kind.",
        )),
    }
}

async fn execute_prepared_agent_decision_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
    prepared: PreparedAgentDecisionV2,
) -> Result<(), AgentKernelV2Error> {
    match prepared {
        PreparedAgentDecisionV2::Plan {
            plan_revision,
            decision,
            guidance,
            operation_request_id,
        } => {
            if matches!(decision, HostKernelPlanDecisionV2::Accept) {
                approve_exact_plan_previews_v2(
                    state,
                    active,
                    &plan_revision,
                    PlanPreviewAuthorizationModeV2::UserAllow,
                )
                .await?;
            }
            let operation = HostKernelBridgeOperationV2::DecidePlan {
                plan_revision,
                decision,
                guidance,
            };
            let decided = state
                .kernel_session_v2
                .submit_operation(
                    &active.session_id,
                    &active.host_run_id,
                    &operation_request_id,
                    operation,
                )
                .await
                .map_err(AgentKernelV2Error::from_storage)?;
            let settlement = if matches!(decision, HostKernelPlanDecisionV2::Accept) {
                let observed_high_water = success_response_v2(&decided)?
                    .pointer("/state/factsSnapshotHighWater")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        AgentKernelV2Error::invalid(
                            "session_kernel_facts_high_water_missing",
                            "Accepted Plan settlement has no exact facts high-water.",
                        )
                    })?;
                let reconcile = HostKernelBridgeOperationV2::ReconcileFacts {
                    observed_high_water,
                };
                let request_id = next_operation_request_id_v2(&decided, &reconcile)?;
                state
                    .kernel_session_v2
                    .submit_operation(
                        &active.session_id,
                        &active.host_run_id,
                        &request_id,
                        reconcile,
                    )
                    .await
                    .map_err(AgentKernelV2Error::from_storage)?
            } else {
                decided
            };
            drive_agent_kernel_run_v2(state, active, settlement).await
        }
        PreparedAgentDecisionV2::Permission {
            wait,
            host_decision,
            session_decision,
            guidance,
            operation_request_id,
        } => {
            let decision_material = json!({
                "schemaVersion": "deepcode.host.runtime-capability-decision.v2",
                "callerRequestDigest": binding.request_digest,
                "runId": active.run_id,
                "previewId": wait.preview_id,
                "operationId": wait.operation_id,
                "invocationId": wait.invocation_id,
                "decision": capability_decision_name_v2(host_decision),
                "guidance": guidance,
            });
            apply_host_scope_decision_v2(
                state,
                &wait.preview_id,
                host_decision,
                &guidance,
                &decision_material,
            )?;
            let operation = HostKernelBridgeOperationV2::ObserveCapabilityDecision {
                decision: session_decision,
                guidance: guidance.clone(),
                preview_id: wait.preview_id,
                operation_id: wait.operation_id,
                invocation_id: wait.invocation_id,
                plan_action_id: wait.plan_action_id,
                expected_plan_revision: wait.expected_plan_revision,
            };
            let observed = state
                .kernel_session_v2
                .submit_operation(
                    &active.session_id,
                    &active.host_run_id,
                    &operation_request_id,
                    operation,
                )
                .await
                .map_err(AgentKernelV2Error::from_storage)?;
            let settlement = if continuation_kind_v2(&observed) == Some("awaitingKernelWake") {
                let wait_kind = match continuation_field_v2(&observed, "waitKind") {
                    Some("capabilityDecisionFact") => HostKernelWaitKindV2::Capability,
                    Some("invocation") => HostKernelWaitKindV2::Invocation,
                    _ => {
                        return Err(AgentKernelV2Error::invalid(
                            "session_kernel_wake_kind_invalid",
                            "Session returned an unsupported exact wake continuation.",
                        ))
                    }
                };
                let wake = HostKernelBridgeOperationV2::ReconcileWake {
                    wait_kind,
                    operation_id: required_continuation_field_v2(&observed, "operationId")?
                        .to_string(),
                    invocation_id: required_continuation_field_v2(&observed, "invocationId")?
                        .to_string(),
                    preview_id: continuation_field_v2(&observed, "previewId").map(str::to_string),
                    plan_action_id: continuation_field_v2(&observed, "planActionId")
                        .map(str::to_string),
                    expected_plan_revision: continuation_field_v2(
                        &observed,
                        "expectedPlanRevision",
                    )
                    .map(str::to_string),
                    guidance: Vec::new(),
                };
                let request_id = next_operation_request_id_v2(&observed, &wake)?;
                state
                    .kernel_session_v2
                    .submit_operation(&active.session_id, &active.host_run_id, &request_id, wake)
                    .await
                    .map_err(AgentKernelV2Error::from_storage)?
            } else {
                observed
            };
            drive_agent_kernel_run_v2(state, active, settlement).await
        }
    }
}

fn normalized_permission_decision_v2(
    body: &AgentSessionRunRequest,
) -> Result<
    (
        HostCapabilityDecisionKindV2,
        HostKernelCapabilityDecisionV2,
        String,
    ),
    AgentKernelV2Error,
> {
    match body.decision.as_deref() {
        Some("accept") => Ok((
            HostCapabilityDecisionKindV2::Allow,
            HostKernelCapabilityDecisionV2::Allow,
            String::new(),
        )),
        Some("reject") => Ok((
            HostCapabilityDecisionKindV2::Deny,
            HostKernelCapabilityDecisionV2::Deny,
            body.guidance
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("User denied the requested capability; replan within approved scope.")
                .to_string(),
        )),
        Some("revise") => Err(AgentKernelV2Error::invalid(
            "session_permission_revision_unsupported",
            "Permission requests support only accept or reject.",
        )),
        _ => Err(AgentKernelV2Error::invalid(
            "session_interaction_decision_invalid",
            "Permission decision must be accept or reject.",
        )),
    }
}

fn plan_decision_name_v2(decision: HostKernelPlanDecisionV2) -> &'static str {
    match decision {
        HostKernelPlanDecisionV2::Accept => "accept",
        HostKernelPlanDecisionV2::Reject => "reject",
        HostKernelPlanDecisionV2::Revise => "revise",
    }
}

fn capability_decision_name_v2(decision: HostCapabilityDecisionKindV2) -> &'static str {
    match decision {
        HostCapabilityDecisionKindV2::Allow => "allow",
        HostCapabilityDecisionKindV2::Deny => "deny",
    }
}

async fn approve_exact_plan_previews_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    plan_revision: &str,
    mode: PlanPreviewAuthorizationModeV2,
) -> Result<(), AgentKernelV2Error> {
    let settlements = state
        .host_services
        .kernel_operations_v2
        .settlements_for_run(&active.session_id, &active.host_run_id)
        .map_err(AgentKernelV2Error::from_storage)?;
    let actions = exact_durable_plan_actions_v2(&settlements, plan_revision)?;
    let action_ids = actions
        .iter()
        .map(|action| action.plan_action_id.as_str())
        .collect::<HashSet<_>>();
    if action_ids.len() != actions.len() {
        return Err(AgentKernelV2Error::invalid(
            "session_plan_action_identity_conflict",
            "The durable current Plan contains duplicate PlanAction identities.",
        ));
    }
    let mut previews = HashMap::new();
    for settlement in &settlements {
        let Ok(response) = success_response_v2(settlement) else {
            continue;
        };
        if response.get("operationKind").and_then(Value::as_str) != Some("previewPlanAction") {
            continue;
        }
        let Some(preview_value) = response.pointer("/outcome/preview") else {
            continue;
        };
        let preview: CapabilityScopePreviewReplyV2 = serde_json::from_value(preview_value.clone())
            .map_err(|_| {
                AgentKernelV2Error::invalid(
                    "session_plan_preview_corrupt",
                    "A durable Plan preview is not strict Kernel v2.",
                )
            })?;
        let CapabilityScopePreviewReplyV2::Previewed { preview } = preview else {
            return Err(AgentKernelV2Error::invalid(
                "session_plan_preview_rejected",
                "The current Plan contains a rejected scope preview.",
            ));
        };
        if preview.plan_revision.as_str() != plan_revision {
            continue;
        }
        let plan_action_id = preview.plan_action_id.as_str().to_string();
        if previews.insert(plan_action_id, preview).is_some() {
            return Err(AgentKernelV2Error::invalid(
                "session_plan_preview_identity_conflict",
                "One PlanAction has multiple durable current preview records.",
            ));
        }
    }
    if previews.len() != actions.len() {
        return Err(AgentKernelV2Error::invalid(
            "session_plan_preview_incomplete",
            "The durable current Plan is missing one or more exact scope previews.",
        ));
    }
    for action in actions {
        let preview = previews.remove(&action.plan_action_id).ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_plan_preview_incomplete",
                "The durable current Plan is missing an exact PlanAction preview.",
            )
        })?;
        if preview.operation_id.as_str() != action.operation_id {
            return Err(AgentKernelV2Error::invalid(
                "session_plan_preview_binding_conflict",
                "PlanAction preview does not match the durable operation identity.",
            ));
        }
        match preview.disposition {
            CapabilityScopeDispositionV2::AutoIssuable => {}
            CapabilityScopeDispositionV2::RequiresUserDecision => {
                let decision_material = json!({
                    "schemaVersion": "deepcode.host.plan-authorization.v2",
                    "runId": active.run_id,
                    "planRevision": plan_revision,
                    "planActionId": action.plan_action_id,
                    "operationId": action.operation_id,
                    "previewId": preview.preview_id,
                    "authorizationDigest": preview.authorization_digest,
                    "authorizationMode": match mode {
                        PlanPreviewAuthorizationModeV2::UserAllow => "userAllow",
                        PlanPreviewAuthorizationModeV2::AutoPlanTrust => "autoPlanTrust",
                    },
                });
                match mode {
                    PlanPreviewAuthorizationModeV2::UserAllow => {
                        apply_host_scope_decision_v2(
                            state,
                            preview.preview_id.as_str(),
                            HostCapabilityDecisionKindV2::Allow,
                            "",
                            &decision_material,
                        )?;
                    }
                    PlanPreviewAuthorizationModeV2::AutoPlanTrust => {
                        apply_host_plan_trust_v2(
                            state,
                            preview.preview_id.as_str(),
                            &decision_material,
                        )?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn exact_durable_plan_actions_v2(
    settlements: &[HostKernelOperationSettlementReceiptV2],
    plan_revision: &str,
) -> Result<Vec<DurablePlanActionV2>, AgentKernelV2Error> {
    for settlement in settlements.iter().rev() {
        let Ok(response) = success_response_v2(settlement) else {
            continue;
        };
        if response
            .pointer("/state/planRevision")
            .and_then(Value::as_str)
            != Some(plan_revision)
        {
            continue;
        }
        let outcome = response.get("outcome").and_then(Value::as_object);
        let result = outcome.and_then(|outcome| outcome.get("result"));
        if result
            .and_then(|result| result.get("kind"))
            .and_then(Value::as_str)
            != Some("plan")
        {
            continue;
        }
        let plan = result
            .and_then(|result| result.get("plan"))
            .ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "session_plan_material_missing",
                    "The durable Plan outcome has no exact Plan material.",
                )
            })?;
        if plan.get("planRevision").and_then(Value::as_str) != Some(plan_revision) {
            return Err(AgentKernelV2Error::invalid(
                "session_plan_material_conflict",
                "The durable Plan material does not match the current revision.",
            ));
        }
        let actions = plan
            .get("actions")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "session_plan_material_invalid",
                    "The durable Plan has no structured action manifest.",
                )
            })?;
        return actions
            .iter()
            .map(|action| {
                let manifest = action.get("manifest").ok_or_else(|| {
                    AgentKernelV2Error::invalid(
                        "session_plan_material_invalid",
                        "A durable PlanAction has no scope manifest.",
                    )
                })?;
                if manifest.get("planRevision").and_then(Value::as_str) != Some(plan_revision) {
                    return Err(AgentKernelV2Error::invalid(
                        "session_plan_material_conflict",
                        "A durable PlanAction belongs to another Plan revision.",
                    ));
                }
                Ok(DurablePlanActionV2 {
                    plan_action_id: required_text_field_v2(manifest, "planActionId")?.to_string(),
                    operation_id: required_text_field_v2(manifest, "operationId")?.to_string(),
                })
            })
            .collect();
    }
    Err(AgentKernelV2Error::invalid(
        "session_plan_material_unavailable",
        "The exact durable current Plan is unavailable; projection text cannot authorize execution.",
    ))
}

fn runtime_capability_wait_v2(
    settlement: &HostKernelOperationSettlementReceiptV2,
) -> Result<RuntimeCapabilityWaitV2, AgentKernelV2Error> {
    if continuation_kind_v2(settlement) != Some("awaitingUserScopeDecision") {
        return Err(AgentKernelV2Error::invalid(
            "session_permission_decision_stale",
            "The durable v2 Run is not awaiting a capability decision.",
        ));
    }
    if continuation_field_v2(settlement, "disposition") == Some("autoIssuable") {
        return Err(AgentKernelV2Error::invalid(
            "session_permission_user_decision_unnecessary",
            "Auto-issuable scope is governed by Kernel trust policy, not a manual Host approval.",
        ));
    }
    let response = success_response_v2(settlement)?;
    let active_wait = response
        .pointer("/state/activeWait")
        .filter(|wait| wait.get("kind").and_then(Value::as_str) == Some("capability"))
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_permission_wait_missing",
                "The durable Session state has no exact capability ActiveWait.",
            )
        })?;
    let preview_id = required_text_field_v2(active_wait, "previewId")?.to_string();
    if continuation_field_v2(settlement, "previewId") != Some(preview_id.as_str()) {
        return Err(AgentKernelV2Error::invalid(
            "session_permission_wait_conflict",
            "Capability continuation and ActiveWait do not match.",
        ));
    }
    Ok(RuntimeCapabilityWaitV2 {
        preview_id,
        operation_id: required_text_field_v2(active_wait, "operationId")?.to_string(),
        invocation_id: required_text_field_v2(active_wait, "invocationId")?.to_string(),
        plan_action_id: continuation_field_v2(settlement, "planActionId").map(str::to_string),
        expected_plan_revision: continuation_field_v2(settlement, "expectedPlanRevision")
            .map(str::to_string),
    })
}

fn apply_host_scope_decision_v2(
    state: &AppState,
    preview_id: &str,
    decision: HostCapabilityDecisionKindV2,
    guidance: &str,
    identity_material: &Value,
) -> Result<(), AgentKernelV2Error> {
    let request_id = CommandRequestId::new(stable_identity_v2(
        "user-decision-request",
        identity_material,
    )?)
    .map_err(|_| {
        AgentKernelV2Error::invalid(
            "host_kernel_decision_request_id_invalid",
            "Trusted Host decision request identity is invalid.",
        )
    })?;
    let decision_ref =
        UserDecisionRefV2::new(stable_identity_v2("user-decision-ref", identity_material)?)
            .map_err(|_| {
                AgentKernelV2Error::invalid(
                    "host_kernel_decision_ref_invalid",
                    "Trusted Host decision reference is invalid.",
                )
            })?;
    let scope_preview_id =
        CapabilityScopePreviewIdV2::new(preview_id.to_string()).map_err(|_| {
            AgentKernelV2Error::invalid(
                "session_permission_identity_invalid",
                "Scope preview identity is not strict Kernel v2.",
            )
        })?;
    let response = state
        .kernel_v2
        .apply_host_capability_decision(HostCapabilityDecisionRequestV2 {
            request_id,
            decision_ref,
            scope_preview_id,
            decision,
            guidance: guidance.to_string(),
        })
        .map_err(host_decision_error_v2)?;
    match response {
        UserDecisionResponseEnvelopeV2::Correlated { reply, .. } => match (decision, reply) {
            (
                HostCapabilityDecisionKindV2::Allow,
                UserDecisionReplyV2::CapabilityIssued { .. }
                | UserDecisionReplyV2::ScopeExpansionRecorded { .. },
            )
            | (
                HostCapabilityDecisionKindV2::Deny,
                UserDecisionReplyV2::CapabilityDenied { .. }
                | UserDecisionReplyV2::ScopeExpansionDenied { .. },
            ) => Ok(()),
            (_, UserDecisionReplyV2::Stale { .. }) => Err(AgentKernelV2Error::invalid(
                "session_permission_decision_stale",
                "Kernel rejected a stale trusted capability decision.",
            )),
            (_, UserDecisionReplyV2::Error(error)) => Err(kernel_user_decision_error_v2(error)),
            _ => Err(AgentKernelV2Error::invalid(
                "host_kernel_decision_reply_mismatch",
                "Kernel decision reply does not match the trusted Host decision.",
            )),
        },
        UserDecisionResponseEnvelopeV2::UncorrelatedWireFailure { .. } => {
            Err(AgentKernelV2Error::invalid(
                "host_kernel_decision_uncorrelated",
                "Kernel returned an uncorrelated trusted decision failure.",
            ))
        }
    }
}

fn apply_host_plan_trust_v2(
    state: &AppState,
    preview_id: &str,
    identity_material: &Value,
) -> Result<(), AgentKernelV2Error> {
    let request_id = CommandRequestId::new(stable_identity_v2(
        "user-decision-request",
        identity_material,
    )?)
    .map_err(|_| {
        AgentKernelV2Error::invalid(
            "host_kernel_decision_request_id_invalid",
            "Trusted Host decision request identity is invalid.",
        )
    })?;
    let decision_ref =
        UserDecisionRefV2::new(stable_identity_v2("user-decision-ref", identity_material)?)
            .map_err(|_| {
                AgentKernelV2Error::invalid(
                    "host_kernel_decision_ref_invalid",
                    "Trusted Host decision reference is invalid.",
                )
            })?;
    let scope_preview_id =
        CapabilityScopePreviewIdV2::new(preview_id.to_string()).map_err(|_| {
            AgentKernelV2Error::invalid(
                "session_permission_identity_invalid",
                "Scope preview identity is not strict Kernel v2.",
            )
        })?;
    let trust_policy_id =
        TrustPolicyIdV2::new(stable_identity_v2("auto-plan-trust", identity_material)?).map_err(
            |_| {
                AgentKernelV2Error::invalid(
                    "host_kernel_trust_policy_id_invalid",
                    "Auto-plan trust policy identity is invalid.",
                )
            },
        )?;
    let response = state
        .kernel_v2
        .apply_host_trust_grant(HostTrustGrantRequestV2 {
            request_id,
            decision_ref,
            scope_preview_id,
            trust_policy_id,
            expires_at: None,
        })
        .map_err(host_decision_error_v2)?;
    match response {
        UserDecisionResponseEnvelopeV2::Correlated {
            reply: UserDecisionReplyV2::TrustGranted { .. },
            ..
        } => Ok(()),
        UserDecisionResponseEnvelopeV2::Correlated {
            reply: UserDecisionReplyV2::Stale { .. },
            ..
        } => Err(AgentKernelV2Error::invalid(
            "session_permission_decision_stale",
            "Kernel rejected a stale auto-plan trust decision.",
        )),
        UserDecisionResponseEnvelopeV2::Correlated {
            reply: UserDecisionReplyV2::Error(error),
            ..
        } => Err(kernel_user_decision_error_v2(error)),
        UserDecisionResponseEnvelopeV2::Correlated { .. } => Err(AgentKernelV2Error::invalid(
            "host_kernel_trust_reply_mismatch",
            "Kernel trust reply does not match the trusted Host decision.",
        )),
        UserDecisionResponseEnvelopeV2::UncorrelatedWireFailure { .. } => {
            Err(AgentKernelV2Error::invalid(
                "host_kernel_decision_uncorrelated",
                "Kernel returned an uncorrelated trusted decision failure.",
            ))
        }
    }
}

async fn drive_agent_kernel_run_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    mut settlement: HostKernelOperationSettlementReceiptV2,
) -> Result<(), AgentKernelV2Error> {
    let mut last_facts_wait = None;
    for _ in 0..MAX_AUTOMATIC_SESSION_STEPS_V2 {
        match &settlement.settlement {
            HostKernelOperationSettlementV2::FailedRecoverable { error_code } => {
                mark_agent_run_v2(
                    state,
                    &active.host_run_id,
                    "waiting",
                    Some(format!(
                        "Kernel–Session v2 operation requires recovery: {error_code}"
                    )),
                    None,
                );
                return Ok(());
            }
            HostKernelOperationSettlementV2::FailedTerminal { error_code } => {
                state
                    .kernel_session_v2
                    .retire_run(&active.session_id, &active.host_run_id, &active.run_id)
                    .await
                    .map_err(AgentKernelV2Error::from_storage)?;
                mark_agent_run_v2(
                    state,
                    &active.host_run_id,
                    "failed",
                    Some(format!("Kernel–Session v2 operation failed: {error_code}")),
                    None,
                );
                return Ok(());
            }
            HostKernelOperationSettlementV2::Succeeded { .. } => {}
        }
        let continuation_kind = continuation_kind_v2(&settlement).ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_kernel_continuation_invalid",
                "Successful Session operation has no exact continuation kind.",
            )
        })?;
        let operation = match continuation_kind {
            "readyToPreviewPlanAction" => HostKernelBridgeOperationV2::PreviewPlanAction {
                plan_action_id: required_continuation_field_v2(&settlement, "planActionId")?
                    .to_string(),
                expected_plan_revision: required_continuation_field_v2(
                    &settlement,
                    "expectedPlanRevision",
                )?
                .to_string(),
            },
            "readyToDrivePlanAction" => HostKernelBridgeOperationV2::ResumePlanAction {
                plan_action_id: required_continuation_field_v2(&settlement, "planActionId")?
                    .to_string(),
                expected_plan_revision: required_continuation_field_v2(
                    &settlement,
                    "expectedPlanRevision",
                )?
                .to_string(),
                provider_call_budget: PLAN_ACTION_PROVIDER_CALL_BUDGET_V2,
                guidance: Vec::new(),
            },
            "readyToFinalizeReview" => HostKernelBridgeOperationV2::FinalizeReview {
                expected_plan_revision: required_continuation_field_v2(
                    &settlement,
                    "expectedPlanRevision",
                )?
                .to_string(),
            },
            "replanRequired" => {
                let response = success_response_v2(&settlement)?;
                let expected_plan_revision =
                    continuation_field_v2(&settlement, "expectedPlanRevision")
                        .or_else(|| {
                            response
                                .pointer("/state/planRevision")
                                .and_then(Value::as_str)
                        })
                        .ok_or_else(|| {
                            AgentKernelV2Error::invalid(
                                "session_plan_revision_missing",
                                "Replan continuation has no exact Plan revision.",
                            )
                        })?
                        .to_string();
                HostKernelBridgeOperationV2::Replan {
                    expected_plan_revision,
                    guidance: continuation_string_array_v2(&settlement, "guidance")?,
                }
            }
            "readyToResumePlanning" => HostKernelBridgeOperationV2::ResumePlanning {
                guidance: continuation_string_array_v2(&settlement, "guidance")?,
            },
            "awaitingBackpressureDeadline" => {
                HostKernelBridgeOperationV2::ResumeAfterBackpressure {
                    operation_id: required_continuation_field_v2(&settlement, "operationId")?
                        .to_string(),
                    retry_at: required_continuation_field_v2(&settlement, "retryAt")?.to_string(),
                    plan_action_id: continuation_field_v2(&settlement, "planActionId")
                        .map(str::to_string),
                    expected_plan_revision: continuation_field_v2(
                        &settlement,
                        "expectedPlanRevision",
                    )
                    .map(str::to_string),
                    guidance: Vec::new(),
                }
            }
            "awaitingKernelFacts" => {
                let observed_high_water =
                    continuation_u64_field_v2(&settlement, "observedHighWater")?;
                if last_facts_wait == Some(observed_high_water) {
                    mark_agent_run_v2(
                        state,
                        &active.host_run_id,
                        "waiting",
                        Some("Waiting for new canonical Kernel facts.".to_string()),
                        None,
                    );
                    return Ok(());
                }
                last_facts_wait = Some(observed_high_water);
                HostKernelBridgeOperationV2::ReconcileFacts {
                    observed_high_water,
                }
            }
            "terminalProviderAnswer" | "terminalProviderStop" | "terminalReview" => {
                let final_text = success_response_v2(&settlement)
                    .ok()
                    .and_then(extract_terminal_text_v2);
                state
                    .kernel_session_v2
                    .retire_run(&active.session_id, &active.host_run_id, &active.run_id)
                    .await
                    .map_err(AgentKernelV2Error::from_storage)?;
                mark_agent_run_v2(
                    state,
                    &active.host_run_id,
                    "completed",
                    Some(match continuation_kind {
                        "terminalReview" => {
                            "Kernel–Session v2 Review finalized from canonical facts.".to_string()
                        }
                        "terminalProviderAnswer" => {
                            "Kernel–Session v2 provider answer completed.".to_string()
                        }
                        _ => "Kernel–Session v2 provider turn completed.".to_string(),
                    }),
                    final_text,
                );
                return Ok(());
            }
            "awaitingUserPlanConfirmation" => {
                let run_id = RunId::new(active.run_id.clone()).map_err(|_| {
                    AgentKernelV2Error::invalid(
                        "host_kernel_run_id_invalid",
                        "Durable active Host Run contains an invalid Kernel Run identity.",
                    )
                })?;
                let settings = state
                    .kernel_v2
                    .service()
                    .run_settings_ceiling_host(&run_id)
                    .map_err(|_| {
                        AgentKernelV2Error::invalid(
                            "host_kernel_run_settings_unavailable",
                            "Current per-Run Settings ceiling is unavailable.",
                        )
                    })?;
                if settings.auto_approve_plans {
                    let plan_revision =
                        required_continuation_field_v2(&settlement, "planRevision")?.to_string();
                    approve_exact_plan_previews_v2(
                        state,
                        active,
                        &plan_revision,
                        PlanPreviewAuthorizationModeV2::AutoPlanTrust,
                    )
                    .await?;
                    let decide = HostKernelBridgeOperationV2::DecidePlan {
                        plan_revision,
                        decision: HostKernelPlanDecisionV2::Accept,
                        guidance: None,
                    };
                    let request_id = next_operation_request_id_v2(&settlement, &decide)?;
                    mark_agent_run_v2(
                        state,
                        &active.host_run_id,
                        "running",
                        Some(
                            "Applying the persisted auto-plan setting through exact Kernel trust."
                                .to_string(),
                        ),
                        None,
                    );
                    let decided = state
                        .kernel_session_v2
                        .submit_operation(
                            &active.session_id,
                            &active.host_run_id,
                            &request_id,
                            decide,
                        )
                        .await
                        .map_err(AgentKernelV2Error::from_storage)?;
                    let observed_high_water = success_response_v2(&decided)?
                        .pointer("/state/factsSnapshotHighWater")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| {
                            AgentKernelV2Error::invalid(
                                "session_kernel_facts_high_water_missing",
                                "Auto-approved Plan settlement has no exact facts high-water.",
                            )
                        })?;
                    let reconcile = HostKernelBridgeOperationV2::ReconcileFacts {
                        observed_high_water,
                    };
                    let request_id = next_operation_request_id_v2(&decided, &reconcile)?;
                    settlement = state
                        .kernel_session_v2
                        .submit_operation(
                            &active.session_id,
                            &active.host_run_id,
                            &request_id,
                            reconcile,
                        )
                        .await
                        .map_err(AgentKernelV2Error::from_storage)?;
                    continue;
                }
                mark_agent_run_v2(
                    state,
                    &active.host_run_id,
                    "waiting",
                    Some("Waiting for exact Plan confirmation.".to_string()),
                    None,
                );
                return Ok(());
            }
            "awaitingUserScopeDecision" => {
                mark_agent_run_v2(
                    state,
                    &active.host_run_id,
                    "waiting",
                    Some("Waiting for an exact capability scope decision.".to_string()),
                    None,
                );
                return Ok(());
            }
            "awaitingKernelWake" => {
                mark_agent_run_v2(
                    state,
                    &active.host_run_id,
                    "waiting",
                    Some("Waiting for a canonical Kernel wake fact.".to_string()),
                    None,
                );
                return Ok(());
            }
            "manualRecoveryRequired" | "recoveryRequired" | "providerBudgetExhausted" => {
                mark_agent_run_v2(
                    state,
                    &active.host_run_id,
                    "waiting",
                    Some(format!(
                        "Kernel–Session v2 requires explicit recovery at {continuation_kind}."
                    )),
                    None,
                );
                return Ok(());
            }
            "providerTurnSuperseded" | "userInputSuperseded" => {
                mark_agent_run_v2(
                    state,
                    &active.host_run_id,
                    "waiting",
                    Some("The previous provider turn was superseded by newer input.".to_string()),
                    None,
                );
                return Ok(());
            }
            _ => {
                return Err(AgentKernelV2Error::invalid(
                    "session_kernel_continuation_unsupported",
                    format!("Unsupported Session v2 continuation: {continuation_kind}"),
                ))
            }
        };
        let request_id = next_operation_request_id_v2(&settlement, &operation)?;
        mark_agent_run_v2(
            state,
            &active.host_run_id,
            "running",
            Some(format!(
                "Advancing Kernel–Session v2 continuation {continuation_kind}."
            )),
            None,
        );
        settlement = state
            .kernel_session_v2
            .submit_operation(
                &active.session_id,
                &active.host_run_id,
                &request_id,
                operation,
            )
            .await
            .map_err(AgentKernelV2Error::from_storage)?;
    }
    mark_agent_run_v2(
        state,
        &active.host_run_id,
        "waiting",
        Some("Automatic Session continuation budget exhausted.".to_string()),
        None,
    );
    Err(AgentKernelV2Error::invalid(
        "session_kernel_automatic_step_budget_exhausted",
        "Automatic Kernel–Session v2 continuation exceeded its bounded Host budget.",
    ))
}

fn require_active_agent_kernel_run_v2(
    state: &AppState,
    session_id: &str,
    route_run_id: Option<&str>,
) -> Result<HostActiveRunRecordV2, AgentKernelV2Error> {
    let active = state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(session_id)
        .map_err(AgentKernelV2Error::from_storage)?
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "agent_run_not_active",
                "Session has no durable active Kernel–Session v2 Run.",
            )
        })?;
    if let Some(route_run_id) = route_run_id {
        require_route_run_identity_v2(&active, route_run_id)?;
    }
    Ok(active)
}

fn require_route_run_identity_v2(
    active: &HostActiveRunRecordV2,
    route_run_id: &str,
) -> Result<(), AgentKernelV2Error> {
    if route_run_id == active.host_run_id || route_run_id == active.run_id {
        Ok(())
    } else {
        Err(AgentKernelV2Error::invalid(
            "agent_run_identity_conflict",
            "Run identity does not match the exact durable active Host/Kernel Run.",
        ))
    }
}

fn latest_settlement_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
) -> Result<HostKernelOperationSettlementReceiptV2, AgentKernelV2Error> {
    state
        .host_services
        .kernel_operations_v2
        .latest_settlement(&active.session_id, &active.host_run_id)
        .map_err(AgentKernelV2Error::from_storage)?
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_kernel_settlement_missing",
                "The durable active v2 Run has no settled Session operation.",
            )
        })
}

fn success_response_v2(
    settlement: &HostKernelOperationSettlementReceiptV2,
) -> Result<&Value, AgentKernelV2Error> {
    match &settlement.settlement {
        HostKernelOperationSettlementV2::Succeeded { response, .. } => Ok(response),
        HostKernelOperationSettlementV2::FailedRecoverable { error_code } => {
            Err(AgentKernelV2Error::invalid(
                "session_kernel_operation_recovery_required",
                format!("Session operation requires recovery: {error_code}"),
            ))
        }
        HostKernelOperationSettlementV2::FailedTerminal { error_code } => {
            Err(AgentKernelV2Error::invalid(
                "session_kernel_operation_failed",
                format!("Session operation failed terminally: {error_code}"),
            ))
        }
    }
}

fn continuation_v2(
    settlement: &HostKernelOperationSettlementReceiptV2,
) -> Option<&serde_json::Map<String, Value>> {
    match &settlement.settlement {
        HostKernelOperationSettlementV2::Succeeded { continuation, .. } => continuation.as_object(),
        _ => None,
    }
}

fn continuation_kind_v2(settlement: &HostKernelOperationSettlementReceiptV2) -> Option<&str> {
    continuation_v2(settlement)?
        .get("kind")
        .and_then(Value::as_str)
}

fn continuation_field_v2<'a>(
    settlement: &'a HostKernelOperationSettlementReceiptV2,
    field: &str,
) -> Option<&'a str> {
    continuation_v2(settlement)?.get(field)?.as_str()
}

fn required_continuation_field_v2<'a>(
    settlement: &'a HostKernelOperationSettlementReceiptV2,
    field: &str,
) -> Result<&'a str, AgentKernelV2Error> {
    continuation_field_v2(settlement, field).ok_or_else(|| {
        AgentKernelV2Error::invalid(
            "session_kernel_continuation_invalid",
            format!("Session continuation is missing {field}."),
        )
    })
}

fn continuation_u64_field_v2(
    settlement: &HostKernelOperationSettlementReceiptV2,
    field: &str,
) -> Result<u64, AgentKernelV2Error> {
    continuation_v2(settlement)
        .and_then(|continuation| continuation.get(field))
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_kernel_continuation_invalid",
                format!("Session continuation is missing numeric {field}."),
            )
        })
}

fn continuation_string_array_v2(
    settlement: &HostKernelOperationSettlementReceiptV2,
    field: &str,
) -> Result<Vec<String>, AgentKernelV2Error> {
    continuation_v2(settlement)
        .and_then(|continuation| continuation.get(field))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_kernel_continuation_invalid",
                format!("Session continuation is missing array {field}."),
            )
        })?
        .iter()
        .map(|value| {
            value.as_str().map(str::to_string).ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "session_kernel_continuation_invalid",
                    format!("Session continuation {field} contains non-text guidance."),
                )
            })
        })
        .collect()
}

fn next_operation_request_id_v2(
    previous: &HostKernelOperationSettlementReceiptV2,
    operation: &HostKernelBridgeOperationV2,
) -> Result<String, AgentKernelV2Error> {
    stable_operation_request_id_v2("continue", &previous.settlement_digest, operation)
}

fn stable_operation_request_id_v2(
    purpose: &str,
    predecessor: &str,
    operation: &HostKernelBridgeOperationV2,
) -> Result<String, AgentKernelV2Error> {
    let operation = serde_json::to_value(operation).map_err(|error| {
        AgentKernelV2Error::invalid(
            "host_kernel_operation_encode_failed",
            format!("Encode Session v2 operation identity: {error}"),
        )
    })?;
    stable_identity_v2(
        &format!("operation-{purpose}"),
        &json!({
            "schemaVersion": "deepcode.host.operation-identity.v2",
            "predecessor": predecessor,
            "operation": operation,
        }),
    )
}

fn authority_revoke_target_v2(
    target: &AgentAuthorityRevokeTargetRequestV2,
) -> Result<UserDecisionRevokeTargetV2, AgentKernelV2Error> {
    match target {
        AgentAuthorityRevokeTargetRequestV2::CapabilityLease { lease_id } => {
            let lease_id = lease_id.trim();
            CapabilityLeaseIdV2::new(lease_id.to_string())
                .map(|lease_id| UserDecisionRevokeTargetV2::CapabilityLease { lease_id })
                .map_err(|_| {
                    AgentKernelV2Error::invalid(
                        "host_authority_revoke_target_invalid",
                        "Authority revoke requires a valid capability lease identity.",
                    )
                })
        }
        AgentAuthorityRevokeTargetRequestV2::TrustPolicy { trust_policy_id } => {
            let trust_policy_id = trust_policy_id.trim();
            TrustPolicyIdV2::new(trust_policy_id.to_string())
                .map(|trust_policy_id| UserDecisionRevokeTargetV2::TrustPolicy { trust_policy_id })
                .map_err(|_| {
                    AgentKernelV2Error::invalid(
                        "host_authority_revoke_target_invalid",
                        "Authority revoke requires a valid trust policy identity.",
                    )
                })
        }
    }
}

fn require_authority_revoke_route_binding_v2(
    binding: &HostCallerRequestBindingReceiptV2,
    route_run_id: &str,
) -> Result<(), AgentKernelV2Error> {
    let host_run_id = caller_binding_string_v2(binding, "hostRunId")?;
    let run_id = caller_binding_string_v2(binding, "runId")?;
    if route_run_id == host_run_id || route_run_id == run_id {
        Ok(())
    } else {
        Err(AgentKernelV2Error::invalid(
            "host_authority_revoke_run_conflict",
            "Authority revoke route does not match its durable Host/Kernel Run identity.",
        ))
    }
}

fn restore_authority_revoke_outcome_v2(
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<Option<Value>, AgentKernelV2Error> {
    let Some(outcome) = binding.outcome.as_ref() else {
        return Ok(None);
    };
    if outcome.get("schemaVersion").and_then(Value::as_str)
        != Some(HOST_AUTHORITY_REVOKE_OUTCOME_SCHEMA_V2)
        || outcome.get("disposition").and_then(Value::as_str) != Some("succeeded")
    {
        return Err(AgentKernelV2Error::invalid(
            "host_authority_revoke_outcome_invalid",
            "Durable authority revoke outcome has an unsupported schema or disposition.",
        ));
    }
    let host_run_id = outcome
        .get("hostRunId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "host_authority_revoke_outcome_invalid",
                "Durable authority revoke outcome has no Host Run identity.",
            )
        })?;
    let run_id = outcome
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "host_authority_revoke_outcome_invalid",
                "Durable authority revoke outcome has no Kernel Run identity.",
            )
        })?;
    if host_run_id != caller_binding_string_v2(binding, "hostRunId")?
        || run_id != caller_binding_string_v2(binding, "runId")?
    {
        return Err(AgentKernelV2Error::invalid(
            "host_authority_revoke_outcome_conflict",
            "Durable authority revoke outcome conflicts with its request identity.",
        ));
    }
    let response: UserDecisionResponseEnvelopeV2 =
        serde_json::from_value(outcome.get("response").cloned().ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "host_authority_revoke_outcome_invalid",
                "Durable authority revoke outcome has no Kernel response.",
            )
        })?)
        .map_err(|_| {
            AgentKernelV2Error::invalid(
                "host_authority_revoke_outcome_invalid",
                "Durable authority revoke Kernel response is invalid.",
            )
        })?;
    response.validate().map_err(|_| {
        AgentKernelV2Error::invalid(
            "host_authority_revoke_outcome_invalid",
            "Durable authority revoke Kernel response violates the v2 wire contract.",
        )
    })?;
    let expected_request_id =
        CommandRequestId::new(caller_binding_string_v2(binding, "requestId")?).map_err(|_| {
            AgentKernelV2Error::invalid(
                "host_authority_revoke_request_id_invalid",
                "Durable authority revoke request identity is invalid.",
            )
        })?;
    if !matches!(
        &response,
        UserDecisionResponseEnvelopeV2::Correlated { request_id, .. }
            if request_id == &expected_request_id
    ) {
        return Err(AgentKernelV2Error::invalid(
            "host_authority_revoke_outcome_conflict",
            "Durable authority revoke response is not correlated to its exact request.",
        ));
    }
    Ok(Some(json!({
        "schemaVersion": HOST_AUTHORITY_REVOKE_OUTCOME_SCHEMA_V2,
        "hostRunId": host_run_id,
        "runId": run_id,
        "response": response,
    })))
}

fn stable_identity_v2(prefix: &str, material: &Value) -> Result<String, AgentKernelV2Error> {
    let digest = canonical_sha256(material).map_err(AgentKernelV2Error::from_storage)?;
    let digest = digest.strip_prefix("sha256:").ok_or_else(|| {
        AgentKernelV2Error::invalid(
            "host_kernel_identity_digest_invalid",
            "Canonical identity digest has an invalid format.",
        )
    })?;
    Ok(format!("host-v2-{prefix}-{digest}"))
}

fn required_caller_request_id_v2(value: Option<&str>) -> Result<&str, AgentKernelV2Error> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "caller_request_id_required",
                "A bounded callerRequestId is required for every Host mutation.",
            )
        })?;
    if value.chars().any(char::is_control) {
        return Err(AgentKernelV2Error::invalid(
            "caller_request_id_invalid",
            "callerRequestId must not contain control characters.",
        ));
    }
    Ok(value)
}

fn caller_binding_string_v2(
    binding: &HostCallerRequestBindingReceiptV2,
    field: &'static str,
) -> Result<String, AgentKernelV2Error> {
    binding
        .response_identity
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "host_caller_request_identity_invalid",
                format!("Durable Host caller request is missing exact {field}."),
            )
        })
}

enum CallerDriveAdmissionV2 {
    Acquired(HostCallerRequestBindingReceiptV2),
    Replayed(String),
}

async fn claim_user_input_drive_or_restore_v2(
    state: &AppState,
    binding: HostCallerRequestBindingReceiptV2,
) -> Result<CallerDriveAdmissionV2, AgentKernelV2Error> {
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
        return recover_or_resume_driving_user_input_v2(state, &binding)
            .await
            .map(CallerDriveAdmissionV2::Replayed);
    }
    let claim = state
        .host_services
        .kernel_operations_v2
        .claim_caller_request_drive(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            &state.host_services.active_runs_v2.owner_instance_id(),
            &now_rfc3339_utc_v2(),
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if claim.acquired {
        return Ok(CallerDriveAdmissionV2::Acquired(claim.binding));
    }
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &claim.binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    recover_or_resume_driving_user_input_v2(state, &claim.binding)
        .await
        .map(CallerDriveAdmissionV2::Replayed)
}

fn claim_caller_drive_or_restore_v2(
    state: &AppState,
    binding: HostCallerRequestBindingReceiptV2,
) -> Result<CallerDriveAdmissionV2, AgentKernelV2Error> {
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
        return recover_driving_caller_request_v2(state, &binding)
            .map(CallerDriveAdmissionV2::Replayed);
    }
    let claim = state
        .host_services
        .kernel_operations_v2
        .claim_caller_request_drive(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            &state.host_services.active_runs_v2.owner_instance_id(),
            &now_rfc3339_utc_v2(),
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if claim.acquired {
        return Ok(CallerDriveAdmissionV2::Acquired(claim.binding));
    }
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &claim.binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    recover_driving_caller_request_v2(state, &claim.binding).map(CallerDriveAdmissionV2::Replayed)
}

async fn recover_or_resume_driving_user_input_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<String, AgentKernelV2Error> {
    let evidence = state
        .host_services
        .kernel_operations_v2
        .caller_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &evidence.binding)? {
        return Ok(host_run_id);
    }
    let current_owner_instance_id = state.host_services.active_runs_v2.owner_instance_id();
    if evidence.binding.drive_owner_instance_id.as_deref()
        == Some(current_owner_instance_id.as_str())
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_in_progress",
            "The exact user-input request is still being driven by this Host instance; retry with the same callerRequestId to query its durable outcome.",
        ));
    }
    if evidence.binding.request_kind != HOST_USER_INPUT_REQUEST_KIND_V2
        || evidence.binding.drive_state != HostCallerRequestDriveStateV2::Driving
        || evidence.run_lifecycle != Some(HostKernelStoredRunLifecycleV2::Active)
    {
        return recover_driving_caller_request_v2(state, &evidence.binding);
    }
    let input = match durable_user_input_from_binding_v2(&evidence.binding) {
        Ok(input) => input,
        Err(_) => return recover_driving_caller_request_v2(state, &evidence.binding),
    };
    let host_run_id = caller_binding_string_v2(&evidence.binding, "hostRunId")?;
    let run_id = caller_binding_string_v2(&evidence.binding, "runId")?;
    let operation_request_id =
        match caller_binding_string_v2(&evidence.binding, "operationRequestId") {
            Ok(operation_request_id) => operation_request_id,
            Err(_) => return recover_driving_caller_request_v2(state, &evidence.binding),
        };
    let active = match require_active_agent_kernel_run_v2(
        state,
        &evidence.binding.session_id,
        Some(&run_id),
    ) {
        Ok(active) if active.host_run_id == host_run_id && active.run_id == run_id => active,
        Ok(_) | Err(_) => return recover_driving_caller_request_v2(state, &evidence.binding),
    };
    if let Err(error) =
        validate_active_run_attachment_binding_v2(state, &active, &input.attachments)
            .and_then(|_| ensure_agent_run_cache_v2(state, &active))
    {
        settle_caller_error_outcome_v2(state, &evidence.binding, &error, false)?;
        return Err(error);
    }
    if evidence.first_operation_present {
        if evidence.first_operation_pending {
            return recover_driving_caller_request_v2(state, &evidence.binding);
        }
        let Some(settlement) = evidence.latest_settlement else {
            return recover_driving_caller_request_v2(state, &evidence.binding);
        };
        if let Err(error) = drive_agent_kernel_run_v2(state, &active, settlement).await {
            settle_caller_error_outcome_v2(state, &evidence.binding, &error, true)?;
            return Err(error);
        }
        settle_caller_run_outcome_v2(state, &evidence.binding, &active.host_run_id)?;
        return Ok(active.host_run_id);
    }
    // UserInput has no facts preflight, and submit_operation durably prepares
    // its exact operation before dispatch. Absence here therefore proves that
    // no Session bridge request byte was written for this caller operation.
    drive_bound_user_input_v2(
        state,
        &active,
        &evidence.binding,
        input,
        &operation_request_id,
    )
    .await
}

fn recover_driving_caller_request_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<String, AgentKernelV2Error> {
    let evidence = state
        .host_services
        .kernel_operations_v2
        .caller_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &evidence.binding)? {
        return Ok(host_run_id);
    }
    match recovered_run_snapshot_v2(&evidence)? {
        Some(run) => {
            let host_run_id = run.run_id.clone();
            settle_caller_run_snapshot_v2(state, &evidence.binding, run)?;
            restore_caller_run_outcome_v2(
                state,
                &state
                    .host_services
                    .kernel_operations_v2
                    .caller_request_binding(
                        &binding.session_id,
                        &binding.caller_request_id,
                        &binding.request_kind,
                        &binding.request_digest,
                    )
                    .map_err(AgentKernelV2Error::from_storage)?
                    .ok_or_else(|| {
                        AgentKernelV2Error::invalid(
                            "host_caller_request_not_found",
                            "Recovered Host caller request disappeared after settlement.",
                        )
                    })?,
            )?
            .ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "host_caller_request_outcome_missing",
                    "Recovered Host caller request has no durable outcome.",
                )
            })
            .map(|_| host_run_id)
        }
        None => {
            let error = AgentKernelV2Error::invalid(
                "host_caller_request_indeterminate",
                recovery_indeterminate_message_v2(&evidence),
            );
            settle_caller_error_outcome_v2(state, &evidence.binding, &error, true)?;
            Err(error)
        }
    }
}

fn recovered_run_snapshot_v2(
    evidence: &HostCallerRequestRecoveryEvidenceV2,
) -> Result<Option<AgentRunState>, AgentKernelV2Error> {
    let host_run_id = caller_binding_string_v2(&evidence.binding, "hostRunId")?;
    if evidence.binding.request_kind == HOST_CANCEL_REQUEST_KIND_V2 {
        let caused_retirement = evidence.run_lifecycle
            == Some(HostKernelStoredRunLifecycleV2::Retired)
            && evidence.retirement_caller_request_id.as_deref()
                == Some(evidence.binding.caller_request_id.as_str())
            && evidence.retirement_request_digest.as_deref()
                == Some(evidence.binding.request_digest.as_str());
        return Ok(caused_retirement.then(|| {
            recovered_agent_run_state_v2(
                evidence,
                host_run_id,
                "cancelled",
                "Recovered exact caller-correlated cancellation.",
                None,
            )
        }));
    }
    if !evidence.first_operation_present
        || evidence.first_operation_pending
        || evidence.first_settlement.is_none()
    {
        return Ok(None);
    }
    let Some(latest) = evidence.latest_settlement.as_ref() else {
        return Ok(None);
    };
    match (
        evidence.run_lifecycle,
        &latest.settlement,
        continuation_kind_v2(latest),
    ) {
        (
            Some(HostKernelStoredRunLifecycleV2::Active),
            HostKernelOperationSettlementV2::FailedRecoverable { error_code },
            _,
        ) => Ok(Some(recovered_agent_run_state_v2(
            evidence,
            host_run_id,
            "waiting",
            &format!("Recovered operation requires recovery: {error_code}"),
            None,
        ))),
        (
            Some(HostKernelStoredRunLifecycleV2::Active),
            HostKernelOperationSettlementV2::Succeeded { .. },
            Some(
                "awaitingUserPlanConfirmation"
                | "awaitingUserScopeDecision"
                | "awaitingKernelWake"
                | "manualRecoveryRequired"
                | "recoveryRequired"
                | "providerBudgetExhausted"
                | "providerTurnSuperseded"
                | "userInputSuperseded",
            ),
        ) => Ok(Some(recovered_agent_run_state_v2(
            evidence,
            host_run_id,
            "waiting",
            "Recovered durable Session wait without replaying the caller request.",
            None,
        ))),
        (
            Some(HostKernelStoredRunLifecycleV2::Retired),
            HostKernelOperationSettlementV2::FailedTerminal { error_code },
            _,
        ) => Ok(Some(recovered_agent_run_state_v2(
            evidence,
            host_run_id,
            "failed",
            &format!("Recovered terminal Session failure: {error_code}"),
            None,
        ))),
        (
            Some(HostKernelStoredRunLifecycleV2::Retired),
            HostKernelOperationSettlementV2::Succeeded { .. },
            Some("terminalProviderAnswer" | "terminalProviderStop" | "terminalReview"),
        ) => Ok(Some(recovered_agent_run_state_v2(
            evidence,
            host_run_id,
            "completed",
            "Recovered terminal Session result from durable settlement and retirement.",
            success_response_v2(latest)
                .ok()
                .and_then(extract_terminal_text_v2),
        ))),
        _ => Ok(None),
    }
}

fn recovered_agent_run_state_v2(
    evidence: &HostCallerRequestRecoveryEvidenceV2,
    host_run_id: String,
    status: &str,
    message: &str,
    final_text: Option<String>,
) -> AgentRunState {
    let started_at = evidence
        .run_recorded_at
        .clone()
        .unwrap_or_else(|| evidence.binding.recorded_at.clone());
    let updated_at = evidence
        .retired_at
        .clone()
        .or_else(|| evidence.binding.drive_started_at.clone())
        .unwrap_or_else(|| evidence.binding.recorded_at.clone());
    AgentRunState {
        run_id: host_run_id,
        session_id: evidence.binding.session_id.clone(),
        profile_id: evidence.provider_profile_id.clone(),
        status: status.to_string(),
        start_event_count: 0,
        started_at,
        updated_at: updated_at.clone(),
        completed_at: matches!(status, "completed" | "failed" | "cancelled").then_some(updated_at),
        message: Some(message.to_string()),
        final_text,
    }
}

fn recovery_indeterminate_message_v2(evidence: &HostCallerRequestRecoveryEvidenceV2) -> String {
    format!(
        "The exact {} caller request crossed its durable drive boundary, but its bounded operation/retirement evidence cannot prove a replay-safe response.",
        evidence.binding.request_kind
    )
}

fn restore_caller_run_outcome_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<Option<String>, AgentKernelV2Error> {
    let Some(outcome) = binding.outcome.as_ref() else {
        return Ok(None);
    };
    if outcome.get("schemaVersion").and_then(Value::as_str)
        != Some(HOST_CALLER_RUN_OUTCOME_SCHEMA_V2)
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_outcome_invalid",
            "Durable Host caller request has an unsupported outcome schema.",
        ));
    }
    let disposition = outcome
        .get("disposition")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "host_caller_request_outcome_invalid",
                "Durable Host caller request outcome has no exact disposition.",
            )
        })?;
    let host_run_id = outcome
        .get("hostRunId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "host_caller_request_outcome_invalid",
                "Durable Host caller request outcome has no exact Host Run identity.",
            )
        })?
        .to_string();
    if caller_binding_string_v2(binding, "hostRunId")? != host_run_id {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_outcome_conflict",
            "Durable Host caller request outcome does not match its response identity.",
        ));
    }
    if matches!(disposition, "failed" | "indeterminate") {
        let code = outcome
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "host_caller_request_outcome_invalid",
                    "Durable Host caller request error outcome has no code.",
                )
            })?;
        let message = outcome
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "host_caller_request_outcome_invalid",
                    "Durable Host caller request error outcome has no message.",
                )
            })?;
        return Err(AgentKernelV2Error {
            code: if disposition == "indeterminate" {
                "host_caller_request_indeterminate".to_string()
            } else {
                code.to_string()
            },
            message: message.to_string(),
        });
    }
    if disposition != "succeeded" {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_outcome_invalid",
            "Durable Host caller request outcome disposition is unsupported.",
        ));
    }
    let run: AgentRunState =
        serde_json::from_value(outcome.get("run").cloned().ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "host_caller_request_outcome_invalid",
                "Durable Host caller request outcome has no bounded Run snapshot.",
            )
        })?)
        .map_err(|_| {
            AgentKernelV2Error::invalid(
                "host_caller_request_outcome_invalid",
                "Durable Host caller request Run snapshot is invalid.",
            )
        })?;
    if run.run_id != host_run_id || run.session_id != binding.session_id {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_outcome_conflict",
            "Durable Host caller request Run snapshot has conflicting identities.",
        ));
    }
    let mut runs = state.session_runs.lock().expect("session run state lock");
    match runs.get(&host_run_id) {
        Some(current) if current.session_id != binding.session_id => {
            return Err(AgentKernelV2Error::invalid(
                "host_caller_request_outcome_conflict",
                "In-memory Run state belongs to a different Session.",
            ))
        }
        Some(_) => {}
        None => {
            runs.insert(host_run_id.clone(), run);
        }
    }
    Ok(Some(host_run_id))
}

fn settle_caller_run_outcome_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    host_run_id: &str,
) -> Result<(), AgentKernelV2Error> {
    if caller_binding_string_v2(binding, "hostRunId")? != host_run_id {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_outcome_conflict",
            "Host caller request cannot settle a different Run.",
        ));
    }
    let run = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.get(host_run_id)
            .filter(|run| run.session_id == binding.session_id)
            .cloned()
    }
    .ok_or_else(|| {
        AgentKernelV2Error::invalid(
            "host_caller_request_outcome_missing",
            "Host caller request cannot settle before its exact Run state exists.",
        )
    })?;
    settle_caller_run_snapshot_v2(state, binding, run)
}

fn settle_caller_run_snapshot_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    run: AgentRunState,
) -> Result<(), AgentKernelV2Error> {
    let host_run_id = run.run_id.clone();
    if run.session_id != binding.session_id
        || caller_binding_string_v2(binding, "hostRunId")? != host_run_id
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_outcome_conflict",
            "Host caller request Run snapshot does not match its durable identity.",
        ));
    }
    let evidence = state
        .host_services
        .kernel_operations_v2
        .caller_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    let first_operation = evidence.first_settlement.as_ref().map(|settlement| {
        json!({
            "operationRequestId": settlement.operation_request_id,
            "settlementDigest": settlement.settlement_digest,
        })
    });
    let terminal_operation = evidence.latest_settlement.as_ref().map(|settlement| {
        json!({
            "operationRequestId": settlement.operation_request_id,
            "settlementDigest": settlement.settlement_digest,
        })
    });
    let caller_caused_retirement = evidence.retirement_caller_request_id.as_deref()
        == Some(binding.caller_request_id.as_str())
        && evidence.retirement_request_digest.as_deref() == Some(binding.request_digest.as_str());
    state
        .host_services
        .kernel_operations_v2
        .settle_caller_request(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            json!({
                "schemaVersion": HOST_CALLER_RUN_OUTCOME_SCHEMA_V2,
                "disposition": "succeeded",
                "hostRunId": host_run_id,
                "run": run,
                "causation": {
                    "firstOperation": first_operation,
                    "terminalOperation": terminal_operation,
                    "callerCausedRetirement": caller_caused_retirement,
                    "retiredAt": evidence.retired_at,
                },
            }),
            now_rfc3339_utc_v2(),
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    Ok(())
}

fn settle_caller_error_outcome_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    error: &AgentKernelV2Error,
    indeterminate: bool,
) -> Result<(), AgentKernelV2Error> {
    state
        .host_services
        .kernel_operations_v2
        .settle_caller_request(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            json!({
                "schemaVersion": HOST_CALLER_RUN_OUTCOME_SCHEMA_V2,
                "disposition": if indeterminate { "indeterminate" } else { "failed" },
                "hostRunId": caller_binding_string_v2(binding, "hostRunId")?,
                "error": {
                    "code": error.code,
                    "message": error.message,
                },
            }),
            now_rfc3339_utc_v2(),
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    Ok(())
}

fn typed_input_id(purpose: &str, material: &Value) -> Result<InputId, AgentKernelV2Error> {
    InputId::new(stable_identity_v2(&format!("input-{purpose}"), material)?).map_err(|_| {
        AgentKernelV2Error::invalid(
            "host_kernel_input_identity_invalid",
            "Host-created Session input identity is invalid.",
        )
    })
}

fn provider_profile_bootstrap_v2(
    state: &AppState,
    profile_id: &str,
) -> Result<HostProviderProfileBootstrapV2, AgentKernelV2Error> {
    let profile = {
        let gui = state.gui.lock().expect("gui state lock");
        gui.llm_profiles
            .get("profiles")
            .and_then(Value::as_array)
            .and_then(|profiles| {
                profiles.iter().find(|profile| {
                    profile.get("id").and_then(Value::as_str) == Some(profile_id)
                        && profile.get("enabled").and_then(Value::as_bool) == Some(true)
                })
            })
            .cloned()
    }
    .ok_or_else(|| {
        AgentKernelV2Error::invalid(
            "llm_profile_unavailable",
            "Selected LLM Profile is unavailable for the immutable v2 Run bootstrap.",
        )
    })?;
    let revision_digest = stable_json_sha256(&profile).map_err(AgentKernelV2Error::from_storage)?;
    let context_window_tokens = profile
        .get("contextWindowTokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "llm_profile_context_budget_invalid",
                "Selected LLM Profile requires a positive contextWindowTokens value.",
            )
        })?;
    let max_output_tokens = profile
        .get("maxOutputTokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "llm_profile_context_budget_invalid",
                "Selected LLM Profile requires a positive maxOutputTokens value.",
            )
        })?;
    HostProviderProfileBootstrapV2::new(
        profile_id.to_string(),
        revision_digest,
        context_window_tokens,
        max_output_tokens,
    )
    .map_err(AgentKernelV2Error::from_storage)
}

fn required_text_field_v2<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a str, AgentKernelV2Error> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_kernel_durable_material_invalid",
                format!("Durable v2 material is missing {field}."),
            )
        })
}

fn host_decision_error_v2(error: HostCapabilityDecisionApplyErrorV2) -> AgentKernelV2Error {
    match error {
        HostCapabilityDecisionApplyErrorV2::Kernel(error) => kernel_user_decision_error_v2(error),
        HostCapabilityDecisionApplyErrorV2::Transport(code) => AgentKernelV2Error::invalid(
            "host_kernel_decision_transport_failed",
            format!("Trusted Host decision transport failed: {code:?}"),
        ),
    }
}

fn kernel_user_decision_error_v2(error: UserDecisionErrorV2) -> AgentKernelV2Error {
    AgentKernelV2Error::invalid(
        "host_kernel_decision_rejected",
        format!("Kernel rejected the trusted Host decision: {error:?}"),
    )
}

fn cache_new_agent_run_v2(
    state: &AppState,
    host_run_id: &str,
    session_id: &str,
    profile_id: &str,
    start_event_count: usize,
) {
    let run = AgentRunState::running(
        host_run_id.to_string(),
        session_id.to_string(),
        profile_id.to_string(),
        start_event_count,
    );
    state
        .session_runs
        .lock()
        .expect("session run state lock")
        .insert(host_run_id.to_string(), run);
}

fn ensure_agent_run_cache_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
) -> Result<(), AgentKernelV2Error> {
    if state
        .session_runs
        .lock()
        .expect("session run state lock")
        .get(&active.host_run_id)
        .is_some_and(|run| run.session_id == active.session_id)
    {
        return Ok(());
    }
    let bootstrap = state
        .host_services
        .kernel_operations_v2
        .get_bootstrap(&active.session_id, &active.host_run_id)
        .map_err(AgentKernelV2Error::from_storage)?;
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let events = read_session_kernel_v2_public_agent_events(&sessions_dir, &active.session_id)
        .map_err(AgentKernelV2Error::from_storage)?;
    let mut runs = state.session_runs.lock().expect("session run state lock");
    if runs
        .get(&active.host_run_id)
        .is_some_and(|run| run.session_id == active.session_id)
    {
        return Ok(());
    }
    runs.insert(
        active.host_run_id.clone(),
        AgentRunState {
            run_id: active.host_run_id.clone(),
            session_id: active.session_id.clone(),
            profile_id: Some(bootstrap.provider_profile.provider_profile_id),
            status: "waiting".to_string(),
            start_event_count: events.len(),
            started_at: active.recorded_at.clone(),
            updated_at: now_text(),
            completed_at: None,
            message: Some("Recovered durable Kernel–Session v2 Run.".to_string()),
            final_text: None,
        },
    );
    Ok(())
}

fn mark_agent_run_v2(
    state: &AppState,
    host_run_id: &str,
    status: &str,
    message: Option<String>,
    final_text: Option<String>,
) {
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(host_run_id) else {
        return;
    };
    run.status = status.to_string();
    run.updated_at = now_text();
    run.message = message;
    if final_text.is_some() {
        run.final_text = final_text;
    }
    run.completed_at =
        matches!(status, "completed" | "failed" | "cancelled").then(|| run.updated_at.clone());
}

fn extract_terminal_text_v2(response: &Value) -> Option<String> {
    ["/outcome/result/text", "/outcome/step/result/text"]
        .into_iter()
        .find_map(|pointer| {
            response
                .pointer(pointer)
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn now_rfc3339_utc_v2() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let seconds = (millis / 1_000) as i64;
    let fractional = (millis % 1_000) as u32;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date_from_unix_days_v2(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fractional:03}Z")
}

fn civil_date_from_unix_days_v2(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}
