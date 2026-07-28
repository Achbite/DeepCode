use crate::host_kernel_operation_store_v2::{
    HostKernelOperationSettlementReceiptV2, HostKernelOperationSettlementV2,
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
use crate::host_v2_storage::{canonical_sha256, HostV2StorageError};
use crate::kernel_v2_transport::{
    HostCapabilityDecisionApplyErrorV2, HostCapabilityDecisionKindV2,
    HostCapabilityDecisionRequestV2,
};
use crate::prelude::*;
use crate::*;
use deepcode_kernel_abi::v2::{CommandRequestId, InputId, UserDecisionRefV2};
use deepcode_kernel_abi::v2_command::{
    CapabilityScopeDispositionV2, CapabilityScopePreviewReplyV2,
};
use deepcode_kernel_abi::{
    CapabilityScopePreviewIdV2, UserDecisionErrorV2, UserDecisionReplyV2,
    UserDecisionResponseEnvelopeV2,
};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_AUTOMATIC_SESSION_STEPS_V2: usize = 128;
const PLAN_ACTION_PROVIDER_CALL_BUDGET_V2: u16 = 32;

#[derive(Debug, Clone)]
pub(crate) struct AgentKernelV2Error {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl AgentKernelV2Error {
    fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn from_storage(error: HostV2StorageError) -> Self {
        Self {
            code: error.code,
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

pub(crate) async fn open_agent_kernel_run_v2(
    state: &AppState,
    session_id: &str,
    body: &AgentSessionRunRequest,
    profile_id: &str,
    project_context: Option<&Value>,
    start_event_count: usize,
) -> Result<String, AgentKernelV2Error> {
    reject_attachments(body.attachments.as_deref())?;
    let prompt = body
        .prompt
        .as_deref()
        .or(body.content.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "agent_prompt_required",
                "A non-empty prompt is required to open a Kernel–Session v2 Run.",
            )
        })?
        .to_string();
    let host_run_id = new_host_run_id_v2();
    let prepared_workspace =
        prepare_agent_workspace_v2(state, session_id, &host_run_id, body, project_context)?;
    let provider_profile_revision_digest = provider_profile_revision_digest_v2(state, profile_id)?;
    let initial_material = json!({
        "schemaVersion": "deepcode.host.agent-input.v2",
        "sessionId": session_id,
        "hostRunId": host_run_id,
        "callerRequestId": body.caller_request_id,
        "text": prompt,
    });
    let input_id = typed_input_id("initial", &initial_material)?;
    let initial_input = HostKernelInitialInputV2 {
        input_id: input_id.clone(),
        opaque_input_ref: stable_identity_v2("input-ref", &initial_material)?,
        text: prompt,
        recorded_at: now_rfc3339_utc_v2(),
    };
    let run_open_request_id = stable_identity_v2(
        "run-open",
        &json!({
            "sessionId": session_id,
            "hostRunId": host_run_id,
            "inputId": input_id,
            "workspaceBindingRef": prepared_workspace.workspace().workspace_binding_ref,
        }),
    )?;
    let operation = HostKernelBridgeOperationV2::InitialTurn {
        guidance: Vec::new(),
    };
    let operation_request_id =
        stable_operation_request_id_v2("initial-turn", &run_open_request_id, &operation)?;
    cache_new_agent_run_v2(
        state,
        &host_run_id,
        session_id,
        profile_id,
        start_event_count,
    );
    let opened = state
        .kernel_session_v2
        .open_and_spawn_initial(HostKernelRunSpawnInputV2 {
            session_id: session_id.to_string(),
            host_run_id: host_run_id.clone(),
            run_open_request_id,
            operation_request_id,
            provider_profile_id: Some(profile_id.to_string()),
            provider_profile_revision_digest: Some(provider_profile_revision_digest),
            workspace: prepared_workspace.workspace(),
            initial_input,
            operation,
        })
        .await;
    let opened = match opened {
        Ok(opened) => opened,
        Err(error) => {
            match state
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
                    return Err(AgentKernelV2Error::from_storage(error));
                }
                Ok(Some(_)) => {
                    return Err(AgentKernelV2Error::invalid(
                        "host_kernel_run_start_cleanup_pending",
                        format!(
                            "RunOpen failed with {}; another durable active Run prevents proving workspace cleanup ownership",
                            error.code
                        ),
                    ));
                }
                Err(resolve_error) => {
                    return Err(AgentKernelV2Error::invalid(
                        "host_kernel_run_start_cleanup_pending",
                        format!(
                            "RunOpen failed with {}; active Run inspection failed with {}",
                            error.code, resolve_error.code
                        ),
                    ));
                }
                Ok(None) => {}
            }
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
            return match cleanup {
                Ok(()) => Err(AgentKernelV2Error::from_storage(error)),
                Err(cleanup_error) => Err(AgentKernelV2Error::invalid(
                    "host_kernel_run_start_cleanup_pending",
                    format!(
                        "RunOpen failed with {}; prepared workspace cleanup also failed with {}",
                        error.code, cleanup_error.code
                    ),
                )),
            };
        }
    };
    drive_agent_kernel_run_v2(state, &opened.active_run, opened.initial_operation).await?;
    Ok(host_run_id)
}

pub(crate) async fn resolve_agent_kernel_decision_v2(
    state: &AppState,
    session_id: &str,
    body: &AgentSessionRunRequest,
) -> Result<String, AgentKernelV2Error> {
    reject_attachments(body.attachments.as_deref())?;
    let active = require_active_agent_kernel_run_v2(state, session_id, body.run_id.as_deref())?;
    ensure_agent_run_cache_v2(state, &active)?;
    mark_agent_run_v2(
        state,
        &active.host_run_id,
        "running",
        Some("Applying trusted Kernel–Session v2 decision.".to_string()),
        None,
    );
    match body.decision_kind.as_deref() {
        Some("plan") => resolve_plan_decision_v2(state, &active, body).await?,
        Some("permission") => resolve_runtime_capability_decision_v2(state, &active, body).await?,
        Some("requirement" | "review" | "boundary") => {
            return Err(AgentKernelV2Error::invalid(
                "session_interaction_v2_unsupported",
                "The requested legacy interaction has no Kernel–Session v2 mutation path.",
            ))
        }
        _ => {
            return Err(AgentKernelV2Error::invalid(
                "session_interaction_kind_invalid",
                "A supported Kernel–Session v2 decision kind is required.",
            ))
        }
    }
    Ok(active.host_run_id)
}

pub(crate) async fn submit_agent_kernel_user_input_v2(
    state: &AppState,
    session_id: &str,
    route_run_id: &str,
    body: &Value,
) -> Result<String, AgentKernelV2Error> {
    let attachments = body
        .get("attachments")
        .and_then(Value::as_array)
        .map(Vec::as_slice);
    reject_attachments(attachments)?;
    let active = require_active_agent_kernel_run_v2(state, session_id, Some(route_run_id))?;
    ensure_agent_run_cache_v2(state, &active)?;
    let text = body
        .get("guidance")
        .or_else(|| body.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AgentKernelV2Error::invalid("empty_guidance", "guidance must not be empty"))?
        .to_string();
    let previous = latest_settlement_v2(state, &active)?;
    let material = json!({
        "schemaVersion": "deepcode.host.agent-input.v2",
        "sessionId": session_id,
        "hostRunId": active.host_run_id,
        "runId": active.run_id,
        "previousSettlementDigest": previous.settlement_digest,
        "callerRequestId": body.get("callerRequestId"),
        "text": text,
    });
    let input = HostKernelInitialInputV2 {
        input_id: typed_input_id("user", &material)?,
        opaque_input_ref: stable_identity_v2("input-ref", &material)?,
        text,
        recorded_at: now_rfc3339_utc_v2(),
    };
    let operation = HostKernelBridgeOperationV2::UserInput {
        input,
        guidance: Vec::new(),
    };
    let request_id = next_operation_request_id_v2(&previous, &operation)?;
    mark_agent_run_v2(
        state,
        &active.host_run_id,
        "running",
        Some("New user input is advancing the control epoch.".to_string()),
        None,
    );
    let settlement = state
        .kernel_session_v2
        .submit_operation(session_id, &active.host_run_id, &request_id, operation)
        .await
        .map_err(AgentKernelV2Error::from_storage)?;
    drive_agent_kernel_run_v2(state, &active, settlement).await?;
    Ok(active.host_run_id)
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

pub(crate) async fn resolve_global_agent_permission_v2(
    state: &AppState,
    permission_id: &str,
    body: &Value,
) -> Result<String, AgentKernelV2Error> {
    let session_ids = {
        let gui = state.gui.lock().expect("gui state lock");
        gui.sessions
            .iter()
            .filter_map(|session| {
                session
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>()
    };
    let mut matched = None;
    for session_id in session_ids {
        let Some(active) = state
            .host_services
            .active_runs_v2
            .resolve_session_active_run(&session_id)
            .map_err(AgentKernelV2Error::from_storage)?
        else {
            continue;
        };
        let latest = latest_settlement_v2(state, &active)?;
        if continuation_kind_v2(&latest) == Some("awaitingUserScopeDecision")
            && continuation_field_v2(&latest, "previewId") == Some(permission_id)
        {
            if matched.is_some() {
                return Err(AgentKernelV2Error::invalid(
                    "session_permission_identity_conflict",
                    "Permission identity resolves to more than one active v2 Run.",
                ));
            }
            matched = Some((session_id, active));
        }
    }
    let Some((session_id, active)) = matched else {
        return Err(AgentKernelV2Error::invalid(
            "session_permission_not_found",
            "No exact active Kernel–Session v2 permission wait matches this identity.",
        ));
    };
    let decision = body
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("reject");
    let request = AgentSessionRunRequest {
        decision_kind: Some("permission".to_string()),
        decision: Some(decision.to_string()),
        guidance: body
            .get("guidance")
            .and_then(Value::as_str)
            .map(str::to_string),
        run_id: Some(active.run_id.clone()),
        target_id: Some(permission_id.to_string()),
        ..AgentSessionRunRequest::default()
    };
    resolve_runtime_capability_decision_v2(state, &active, &request).await?;
    Ok(session_id)
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
            empty_workspace_key: Some(prepared.empty_workspace_key.clone()),
            run_settings: prepared.run_settings.clone(),
        };
        return Ok(PreparedAgentWorkspaceV2::Empty {
            prepared,
            workspace,
        });
    }
    let workspace_path = project_context
        .and_then(|context| context.pointer("/workspaceBinding/openPath"))
        .and_then(Value::as_str)
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
        empty_workspace_key: None,
        run_settings: HostRunSettingsCeilingV2 {
            workspace_read: settings.workspace_read,
            workspace_write: settings.workspace_write,
            git_write: settings.git_write,
            web_read: settings.web_read,
            private_web_read: settings.private_web_read,
            auto_approve_plans: settings.auto_approve_plans,
        },
    };
    Ok(PreparedAgentWorkspaceV2::Bound {
        prepared,
        workspace,
    })
}

async fn resolve_plan_decision_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    body: &AgentSessionRunRequest,
) -> Result<(), AgentKernelV2Error> {
    let current = latest_settlement_v2(state, active)?;
    if continuation_kind_v2(&current) != Some("awaitingUserPlanConfirmation") {
        return Err(AgentKernelV2Error::invalid(
            "session_plan_decision_stale",
            "The durable v2 Run is not awaiting Plan confirmation.",
        ));
    }
    let plan_revision = continuation_field_v2(&current, "planRevision")
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
    if matches!(decision, HostKernelPlanDecisionV2::Accept) {
        approve_exact_plan_previews_v2(state, active, &plan_revision).await?;
    }
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
    let operation = HostKernelBridgeOperationV2::DecidePlan {
        plan_revision,
        decision,
        guidance,
    };
    let request_id = next_operation_request_id_v2(&current, &operation)?;
    let decided = state
        .kernel_session_v2
        .submit_operation(
            &active.session_id,
            &active.host_run_id,
            &request_id,
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

async fn approve_exact_plan_previews_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    plan_revision: &str,
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
                    "schemaVersion": "deepcode.host.plan-capability-decision.v2",
                    "runId": active.run_id,
                    "planRevision": plan_revision,
                    "planActionId": action.plan_action_id,
                    "operationId": action.operation_id,
                    "previewId": preview.preview_id,
                    "authorizationDigest": preview.authorization_digest,
                    "decision": "allow",
                });
                apply_host_scope_decision_v2(
                    state,
                    preview.preview_id.as_str(),
                    HostCapabilityDecisionKindV2::Allow,
                    "",
                    &decision_material,
                )?;
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

async fn resolve_runtime_capability_decision_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    body: &AgentSessionRunRequest,
) -> Result<(), AgentKernelV2Error> {
    let current = latest_settlement_v2(state, active)?;
    let wait = runtime_capability_wait_v2(&current)?;
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
    let (host_decision, session_decision, guidance) = match body.decision.as_deref() {
        Some("accept") => (
            HostCapabilityDecisionKindV2::Allow,
            HostKernelCapabilityDecisionV2::Allow,
            String::new(),
        ),
        Some("reject") => {
            let guidance = body
                .guidance
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("User denied the requested capability; replan within approved scope.")
                .to_string();
            (
                HostCapabilityDecisionKindV2::Deny,
                HostKernelCapabilityDecisionV2::Deny,
                guidance,
            )
        }
        Some("revise") => {
            return Err(AgentKernelV2Error::invalid(
                "session_permission_revision_unsupported",
                "Permission requests support only accept or reject.",
            ))
        }
        _ => {
            return Err(AgentKernelV2Error::invalid(
                "session_interaction_decision_invalid",
                "Permission decision must be accept or reject.",
            ))
        }
    };
    let decision_material = json!({
        "schemaVersion": "deepcode.host.runtime-capability-decision.v2",
        "runId": active.run_id,
        "previousSettlementDigest": current.settlement_digest,
        "previewId": wait.preview_id,
        "operationId": wait.operation_id,
        "invocationId": wait.invocation_id,
        "decision": body.decision,
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
        preview_id: wait.preview_id.clone(),
        operation_id: wait.operation_id.clone(),
        invocation_id: wait.invocation_id.clone(),
        plan_action_id: wait.plan_action_id.clone(),
        expected_plan_revision: wait.expected_plan_revision.clone(),
    };
    let request_id = next_operation_request_id_v2(&current, &operation)?;
    let observed = state
        .kernel_session_v2
        .submit_operation(
            &active.session_id,
            &active.host_run_id,
            &request_id,
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
            operation_id: required_continuation_field_v2(&observed, "operationId")?.to_string(),
            invocation_id: required_continuation_field_v2(&observed, "invocationId")?.to_string(),
            preview_id: continuation_field_v2(&observed, "previewId").map(str::to_string),
            plan_action_id: continuation_field_v2(&observed, "planActionId").map(str::to_string),
            expected_plan_revision: continuation_field_v2(&observed, "expectedPlanRevision")
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

fn typed_input_id(purpose: &str, material: &Value) -> Result<InputId, AgentKernelV2Error> {
    InputId::new(stable_identity_v2(&format!("input-{purpose}"), material)?).map_err(|_| {
        AgentKernelV2Error::invalid(
            "host_kernel_input_identity_invalid",
            "Host-created Session input identity is invalid.",
        )
    })
}

fn provider_profile_revision_digest_v2(
    state: &AppState,
    profile_id: &str,
) -> Result<String, AgentKernelV2Error> {
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
    canonical_sha256(&profile).map_err(AgentKernelV2Error::from_storage)
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

fn reject_attachments(attachments: Option<&[Value]>) -> Result<(), AgentKernelV2Error> {
    if attachments.is_some_and(|attachments| !attachments.is_empty()) {
        return Err(AgentKernelV2Error::invalid(
            "session_kernel_attachments_unsupported",
            "Kernel–Session v2 does not accept attachment payloads until they have a ResourcePacket contract.",
        ));
    }
    Ok(())
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
    let mut runs = state.session_runs.lock().expect("session run state lock");
    if runs
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
    let events = session_projection(state, &active.session_id);
    runs.insert(
        active.host_run_id.clone(),
        AgentRunState {
            run_id: active.host_run_id.clone(),
            session_id: active.session_id.clone(),
            profile_id: bootstrap.provider_profile_id,
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

fn new_host_run_id_v2() -> String {
    static NEXT_HOST_RUN_V2: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT_HOST_RUN_V2.fetch_add(1, Ordering::Relaxed);
    format!("session-v2-run-{}-{sequence}", now_millis())
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
