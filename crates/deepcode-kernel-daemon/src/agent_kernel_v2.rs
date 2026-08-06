use crate::host_kernel_operation_store_v2::{
    HostCallerRequestBindingInputV2, HostCallerRequestBindingReceiptV2,
    HostCallerRequestDriveStateV2, HostCallerRequestRecoveryEvidenceV2, HostKernelFailureCommitV2,
    HostKernelFailureDispositionV2, HostKernelFailureEffectV2, HostKernelLiveRunForDeletionV2,
    HostKernelOperationSettlementReceiptV2, HostKernelOperationSettlementV2,
    HostKernelStoredRunLifecycleV2, HostRunCallerDriveRecoveryV2,
};
use crate::host_kernel_run_v2::{
    HostKernelBridgeOperationV2, HostKernelCapabilityDecisionV2, HostKernelInitialInputV2,
    HostKernelPlanDecisionV2, HostKernelRunAdmittedV2, HostKernelRunSpawnInputV2,
    HostKernelRunWorkspaceV2, HostKernelStartupContinuationRunV2, HostKernelWaitKindV2,
};
use crate::host_kernel_wake_v2::{
    HostKernelWakeCancelOutcomeV2, HostKernelWakeKeyV2, HostKernelWakeLaneV2,
    HostKernelWakeOwnerV2, HostKernelWakeRegisterOutcomeV2, HostKernelWakeRetagOutcomeV2,
    HostKernelWakeSupervisorErrorV2, HostKernelWakeTransferOutcomeV2,
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
use crate::session_kernel_v2_store::{decode_session_work_authority_v3, SessionWorkAuthorityV3};
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
use std::time::Duration;

const MAX_AUTOMATIC_SESSION_STEPS_V2: usize = 128;
const PLAN_ACTION_PROVIDER_CALL_BUDGET_V2: u16 = 32;
const KERNEL_FACT_WAKE_POLL_INTERVAL_V2: Duration = Duration::from_millis(50);
const HOST_CALLER_SETTLEMENT_RETRY_INTERVAL_V2: Duration = Duration::from_millis(100);
const HOST_INPUT_PROJECTION_SETTLEMENT_GRACE_CHECKS_V2: u8 = 40;
const HOST_INPUT_ADMISSION_WAIT_CHECKS_V2: u16 = 1_200;
const HOST_RUN_OPEN_REQUEST_KIND_V2: &str = "agent.run.open.v2";
const HOST_USER_INPUT_REQUEST_KIND_V2: &str = "agent.run.user-input.v2";
const HOST_DECISION_REQUEST_KIND_V2: &str = "agent.run.decision.v2";
const HOST_AUTHORITY_REVOKE_REQUEST_KIND_V2: &str = "agent.run.authority-revoke.v2";
const HOST_CANCEL_REQUEST_KIND_V2: &str = "agent.run.cancel.v2";
const HOST_CALLER_RUN_ADMISSION_SCHEMA_V2: &str = "deepcode.host.agent-run-admission.v3";
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

    fn from_wake_supervisor(error: HostKernelWakeSupervisorErrorV2) -> Self {
        Self {
            code: error.code.to_string(),
            message: error.message,
        }
    }
}

#[derive(Clone)]
struct AgentKernelDriveContextV2 {
    kernel_v2: crate::kernel_v2_transport::KernelV2TransportState,
    kernel_session_v2: crate::host_kernel_run_v2::HostKernelRunCoordinatorV2,
    host_services: HostServices,
    session_runs: Arc<Mutex<HashMap<String, AgentRunState>>>,
}

impl AgentKernelDriveContextV2 {
    fn from_state(state: &AppState) -> Self {
        Self {
            kernel_v2: state.kernel_v2.clone(),
            kernel_session_v2: state.kernel_session_v2.clone(),
            host_services: state.host_services.clone(),
            session_runs: Arc::clone(&state.session_runs),
        }
    }
}

enum AgentKernelDriveBoundaryV2 {
    Complete,
    KernelWait(AgentKernelFactWaitV2),
    Failure {
        error: AgentKernelV2Error,
        indeterminate: bool,
    },
}

#[derive(Clone)]
struct AgentKernelFactWaitV2 {
    active: HostActiveRunRecordV2,
    predecessor: HostKernelOperationSettlementReceiptV2,
    observed_high_water: u64,
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

enum RecoveredCallerDriveActionV2 {
    Decision(PreparedAgentDecisionV2),
    UserInput {
        input: HostKernelInitialInputV2,
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

#[derive(Debug, Clone)]
pub(crate) struct AgentKernelRunAdmissionV2 {
    pub(crate) host_run_id: String,
    pub(crate) kernel_run_id: String,
    pub(crate) input_id: String,
}

pub(crate) struct AgentKernelUserInputAdmissionReceiptV2 {
    pub(crate) host_run_id: String,
    pub(crate) input_id: String,
}

pub(crate) enum AgentKernelUserInputAdmissionV2 {
    Ready(AgentKernelUserInputAdmissionReceiptV2),
    Pending {
        state: AppState,
        binding: HostCallerRequestBindingReceiptV2,
        host_run_id: String,
        input_id: String,
        persisted: Option<tokio::sync::oneshot::Receiver<Result<(), AgentKernelV2Error>>>,
    },
}

pub(crate) async fn await_agent_kernel_user_input_admission_v2(
    admission: AgentKernelUserInputAdmissionV2,
) -> Result<AgentKernelUserInputAdmissionReceiptV2, AgentKernelV2Error> {
    match admission {
        AgentKernelUserInputAdmissionV2::Ready(receipt) => Ok(receipt),
        AgentKernelUserInputAdmissionV2::Pending {
            state,
            binding,
            host_run_id,
            input_id,
            mut persisted,
        } => {
            for _ in 0..HOST_INPUT_ADMISSION_WAIT_CHECKS_V2 {
                if let Some(receiver) = persisted.as_mut() {
                    match receiver.try_recv() {
                        Ok(Ok(())) => persisted = None,
                        Ok(Err(error)) => return Err(error),
                        Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                        Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                            persisted = None;
                        }
                    }
                }
                let current = state
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
                            "The durable user-input caller disappeared before admission completed.",
                        )
                    })?;
                if let Some(restored_host_run_id) = restore_caller_run_outcome_v2(&state, &current)?
                {
                    let receipt =
                        user_input_admission_receipt_v2(&state, &current, restored_host_run_id)?;
                    if receipt.host_run_id != host_run_id || receipt.input_id != input_id {
                        return Err(AgentKernelV2Error::invalid(
                            "host_user_input_admission_identity_conflict",
                            "Durable user-input outcome does not match the exact pending admission identity.",
                        ));
                    }
                    return Ok(receipt);
                }
                if let Some(restored_host_run_id) = restore_caller_run_admission_v2(&current)? {
                    let receipt =
                        user_input_admission_receipt_v2(&state, &current, restored_host_run_id)?;
                    if receipt.host_run_id != host_run_id || receipt.input_id != input_id {
                        return Err(AgentKernelV2Error::invalid(
                            "host_user_input_admission_identity_conflict",
                            "Durable user-input admission does not match the exact pending identity.",
                        ));
                    }
                    return Ok(receipt);
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(AgentKernelV2Error::invalid(
                "host_user_input_admission_pending",
                "The exact user input is still pending durable admission; retry the same callerRequestId to query its outcome.",
            ))
        }
    }
}

pub(crate) async fn preadmit_open_agent_kernel_run_v2(
    state: &AppState,
    session_id: &str,
    body: &AgentSessionRunRequest,
) -> Result<Option<AgentKernelRunAdmissionV2>, AgentKernelV2Error> {
    let prepared = prepare_open_caller_request_v2(session_id, body)?;
    let binding = bind_open_caller_request_v2(state, session_id, &prepared)?;
    let input_id = caller_binding_string_v2(&binding, "inputId")?;
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &binding)? {
        require_initial_input_projection_v2(state, &binding)?;
        return exact_agent_run_admission_v2(state, session_id, &host_run_id, &input_id).map(Some);
    }
    if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
        if let Some(admission) = current_owned_open_admission_v2(state, &binding).await? {
            return Ok(Some(admission));
        }
        let host_run_id = recover_driving_run_open_v2(state, &binding)?;
        return exact_agent_run_admission_v2(state, session_id, &host_run_id, &input_id).map(Some);
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
) -> Result<AgentKernelRunAdmissionV2, AgentKernelV2Error> {
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
        require_initial_input_projection_v2(state, &binding)?;
        return exact_agent_run_admission_v2(
            state,
            session_id,
            &replayed_host_run_id,
            input_id.as_str(),
        );
    }
    if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
        if let Some(admission) = current_owned_open_admission_v2(state, &binding).await? {
            return Ok(admission);
        }
        let host_run_id = recover_driving_run_open_v2(state, &binding)?;
        return exact_agent_run_admission_v2(state, session_id, &host_run_id, input_id.as_str());
    }
    if let Some(active) = state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(session_id)
        .map_err(AgentKernelV2Error::from_storage)?
    {
        state
            .host_services
            .kernel_operations_v2
            .live_run_has_supported_history_schema(session_id, &active.host_run_id)
            .map_err(AgentKernelV2Error::from_storage)?;
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
    let binding = match claim_caller_drive_or_restore_v2(state, binding).await? {
        CallerDriveAdmissionV2::Acquired(binding) => binding,
        CallerDriveAdmissionV2::Replayed(host_run_id) => {
            return exact_agent_run_admission_v2(state, session_id, &host_run_id, input_id.as_str())
        }
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
        .open_and_dispatch_initial(
            HostKernelRunSpawnInputV2 {
                session_id: session_id.to_string(),
                host_run_id: host_run_id.clone(),
                caller_request_id: binding.caller_request_id.clone(),
                caller_request_digest: binding.request_digest.clone(),
                run_open_request_id,
                operation_request_id: operation_request_id.clone(),
                provider_profile,
                prior_session_events,
                workspace: prepared_workspace.workspace(),
                initial_input,
                operation,
            },
            || drop(settings_transition),
        )
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
    if let Err(error) = bind_agent_run_kernel_identity_v2(
        state,
        session_id,
        &host_run_id,
        &opened.active_run.run_id,
    ) {
        settle_caller_error_outcome_v2(state, &binding, &error, true)?;
        return Err(error);
    }
    let admission = AgentKernelRunAdmissionV2 {
        host_run_id: host_run_id.clone(),
        kernel_run_id: opened.active_run.run_id.clone(),
        input_id: input_id.as_str().to_string(),
    };
    let owner =
        host_kernel_initial_drive_owner_v2(&opened.active_run, &binding, &operation_request_id)?;
    let owner_for_cleanup = owner.clone();
    let owner_for_drive = owner.clone();
    let context = AgentKernelDriveContextV2::from_state(state);
    let supervisor_for_drive = state.kernel_wake_v2.clone();
    let failure_context = context.clone();
    let failure_binding = binding.clone();
    let failure_host_run_id = host_run_id.clone();
    let admission_state = state.clone();
    let admission_binding = binding.clone();
    let admission_host_run_id = host_run_id.clone();
    let admission_input_id = input_id.as_str().to_string();
    let (admission_sender, admission_receiver) =
        tokio::sync::oneshot::channel::<Result<(), AgentKernelV2Error>>();
    let registered = state
        .kernel_wake_v2
        .register_exclusive(owner, async move {
            let mut drive = Box::pin(drive_admitted_agent_kernel_run_v2(
                context,
                supervisor_for_drive,
                owner_for_drive,
                opened,
            ));
            let mut drive_completed = false;
            let admission_result = loop {
                tokio::select! {
                    _ = &mut drive => {
                        drive_completed = true;
                        match user_input_is_projected_v2(
                            &admission_state,
                            &admission_binding.session_id,
                            &admission_input_id,
                        ) {
                            Ok(true) => break settle_caller_run_outcome_v2(
                                &admission_state,
                                &admission_binding,
                                &admission_host_run_id,
                            ),
                            Ok(false) => break Err(AgentKernelV2Error::invalid(
                                "host_initial_input_projection_missing",
                                "The initial Session drive ended before its exact input.persisted projection became durable.",
                            )),
                            Err(error) => break Err(error),
                        }
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {
                        match user_input_is_projected_v2(
                            &admission_state,
                            &admission_binding.session_id,
                            &admission_input_id,
                        ) {
                            Ok(true) => break settle_caller_run_outcome_v2(
                                &admission_state,
                                &admission_binding,
                                &admission_host_run_id,
                            ),
                            Ok(false) => {}
                            Err(error) => break Err(error),
                        }
                    }
                }
            };
            if let Err(error) = &admission_result {
                let _ = settle_caller_error_outcome_v2(
                    &admission_state,
                    &admission_binding,
                    error,
                    true,
                );
            }
            let _ = admission_sender.send(admission_result);
            if !drive_completed {
                drive.await;
            }
        })
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor);
    let registered = match registered {
        Ok(HostKernelWakeRegisterOutcomeV2::Registered) => true,
        Ok(
            HostKernelWakeRegisterOutcomeV2::AlreadyExact
            | HostKernelWakeRegisterOutcomeV2::OwnerConflict,
        ) => {
            let error = AgentKernelV2Error::invalid(
                "host_kernel_initial_drive_owner_exists",
                "The exact initial Run drive already has a live supervisor owner.",
            );
            mark_agent_drive_v2(
                &failure_context,
                &failure_host_run_id,
                "waiting",
                Some(
                    "Kernel–Session v2 Run admission found a conflicting live drive owner."
                        .to_string(),
                ),
            );
            settle_caller_error_outcome_v2(state, &failure_binding, &error, true)?;
            return Err(error);
        }
        Err(error) => {
            mark_agent_drive_v2(
                &failure_context,
                &failure_host_run_id,
                "waiting",
                Some(format!(
                    "Kernel–Session v2 Run admission requires recovery: {}",
                    error.code
                )),
            );
            settle_caller_error_outcome_v2(state, &failure_binding, &error, true)?;
            return Err(error);
        }
    };
    debug_assert!(registered);
    let admission_result = match admission_receiver.await {
        Ok(result) => result,
        Err(_) => Err(AgentKernelV2Error::invalid(
            "host_kernel_initial_drive_owner_lost_before_admission",
            "The initial Run drive owner ended before it reported durable caller admission.",
        )),
    };
    if let Err(error) = admission_result {
        let _ = state
            .kernel_wake_v2
            .cancel_exact(owner_for_cleanup.key)
            .await;
        mark_agent_drive_v2(
            &failure_context,
            &failure_host_run_id,
            "waiting",
            Some(format!(
                "Kernel–Session v2 caller admission requires recovery: {}",
                error.code
            )),
        );
        let _ = settle_caller_error_outcome_v2(state, &failure_binding, &error, true);
        return Err(error);
    }
    Ok(admission)
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
        if let Some(admitted_host_run_id) =
            current_owned_caller_admission_v2(state, binding).await?
        {
            return Ok(admitted_host_run_id);
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
                    recorded_at: crate::utils::now_rfc3339_text(),
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
    let binding = match claim_caller_drive_or_restore_v2(state, binding).await? {
        CallerDriveAdmissionV2::Acquired(binding) => binding,
        CallerDriveAdmissionV2::Replayed(host_run_id) => return Ok(host_run_id),
    };
    admit_and_spawn_agent_decision_v2(state, active, binding, prepared).await
}

async fn admit_and_spawn_agent_decision_v2(
    state: &AppState,
    active: HostActiveRunRecordV2,
    binding: HostCallerRequestBindingReceiptV2,
    prepared: PreparedAgentDecisionV2,
) -> Result<String, AgentKernelV2Error> {
    let owner = host_kernel_caller_drive_owner_v2(&active, &binding)?;
    let owner_for_drive = owner.clone();
    let background_state = state.clone();
    let background_active = active.clone();
    let background_binding = binding.clone();
    let (admission_sender, admission_receiver) =
        tokio::sync::oneshot::channel::<Result<(), AgentKernelV2Error>>();
    let registration = match state
        .kernel_wake_v2
        .register_exclusive(owner.clone(), async move {
            let admitted_binding = match persist_caller_admission_v2(
                &background_state,
                &background_active,
                &background_binding,
                &owner_for_drive,
            ) {
                Ok(admitted_binding) => admitted_binding,
                Err(error) => {
                    let _ = admission_sender.send(Err(error));
                    return;
                }
            };
            mark_agent_run_v2(
                &background_state,
                &background_active.host_run_id,
                "running",
                Some("Applying trusted Kernel–Session v2 decision.".to_string()),
            );
            let _ = admission_sender.send(Ok(()));
            let result = execute_prepared_agent_decision_v2(
                &background_state,
                &background_active,
                &admitted_binding,
                prepared,
            )
            .await;
            finish_owned_caller_drive_v2(
                &background_state,
                &background_active,
                &admitted_binding,
                owner_for_drive,
                result,
            )
            .await;
        })
        .await
    {
        Ok(registration) => registration,
        Err(supervisor_error) => {
            drop(admission_receiver);
            let error = AgentKernelV2Error::from_wake_supervisor(supervisor_error);
            cleanup_unadmitted_caller_registration_v2(state, &binding, owner, None, &error).await?;
            return Err(error);
        }
    };
    if registration != HostKernelWakeRegisterOutcomeV2::Registered {
        drop(admission_receiver);
        let error = AgentKernelV2Error::invalid(
            "host_kernel_caller_drive_owner_conflict",
            "The exact decision caller could not acquire exclusive Run drive ownership.",
        );
        cleanup_unadmitted_caller_registration_v2(state, &binding, owner, None, &error).await?;
        return Err(error);
    }
    complete_caller_admission_v2(state, &active, binding, owner, admission_receiver, None).await
}

async fn admit_and_spawn_user_input_v2(
    state: &AppState,
    active: HostActiveRunRecordV2,
    binding: HostCallerRequestBindingReceiptV2,
    input: HostKernelInitialInputV2,
    request_id: String,
) -> Result<AgentKernelUserInputAdmissionV2, AgentKernelV2Error> {
    let owner = host_kernel_interrupt_owner_v2(&active, &binding)?;
    let continuation_owner = host_kernel_caller_drive_owner_v2(&active, &binding)?;
    let background_state = state.clone();
    let background_active = active.clone();
    let background_binding = binding.clone();
    let projected_input_id = input.input_id.as_str().to_string();
    let admission_input_id = projected_input_id.clone();
    let (persisted_sender, persisted_receiver) =
        tokio::sync::oneshot::channel::<Result<(), AgentKernelV2Error>>();
    let interrupt_owner = owner.clone();
    let future = async move {
        let mut persisted_sender = Some(persisted_sender);
        let dispatch_binding = match background_state
            .host_services
            .kernel_operations_v2
            .caller_request_binding(
                &background_binding.session_id,
                &background_binding.caller_request_id,
                &background_binding.request_kind,
                &background_binding.request_digest,
            )
            .map_err(AgentKernelV2Error::from_storage)
        {
            Ok(Some(current)) => current,
            Ok(None) => {
                let error = AgentKernelV2Error::invalid(
                    "host_caller_request_not_found",
                    "The durable user-input caller disappeared after interrupt ownership registration.",
                );
                if let Some(sender) = persisted_sender.take() {
                    let _ = sender.send(Err(error));
                }
                return;
            }
            Err(error) => {
                if let Some(sender) = persisted_sender.take() {
                    let _ = sender.send(Err(error));
                }
                return;
            }
        };
        match restore_caller_run_outcome_v2(&background_state, &dispatch_binding) {
            Ok(Some(_)) => {
                if let Some(sender) = persisted_sender.take() {
                    let _ = sender.send(Ok(()));
                }
                return;
            }
            Ok(None) => {}
            Err(error) => {
                if let Some(sender) = persisted_sender.take() {
                    let _ = sender.send(Err(error));
                }
                return;
            }
        }
        let exact_interrupt_owned = caller_binding_string_v2(&dispatch_binding, "hostRunId")
            .and_then(|host_run_id| {
                caller_binding_string_v2(&dispatch_binding, "runId")
                    .map(|run_id| (host_run_id, run_id))
            })
            .and_then(|(host_run_id, run_id)| {
                if host_run_id != background_active.host_run_id
                    || run_id != background_active.run_id
                {
                    return Err(AgentKernelV2Error::invalid(
                        "host_caller_request_run_conflict",
                        "Registered user input no longer belongs to the exact active Run.",
                    ));
                }
                Ok(())
            });
        let exact_interrupt_owned = match exact_interrupt_owned {
            Ok(()) => {
                current_owned_user_input_interrupt_v2(&background_state, &dispatch_binding).await
            }
            Err(error) => Err(error),
        };
        match exact_interrupt_owned {
            Ok(true) => {}
            Ok(false) => {
                let error = AgentKernelV2Error::invalid(
                    "host_interrupt_mailbox_owner_lost_before_dispatch",
                    "The exact durable interrupt owner was lost before Session user-input dispatch.",
                );
                let _ = settle_caller_error_outcome_v2(
                    &background_state,
                    &dispatch_binding,
                    &error,
                    false,
                );
                if let Some(sender) = persisted_sender.take() {
                    let _ = sender.send(Err(error));
                }
                return;
            }
            Err(error) => {
                let _ = settle_caller_error_outcome_v2(
                    &background_state,
                    &dispatch_binding,
                    &error,
                    false,
                );
                if let Some(sender) = persisted_sender.take() {
                    let _ = sender.send(Err(error));
                }
                return;
            }
        }
        let mut operation = Box::pin(submit_bound_user_input_v2(
            &background_state,
            &background_active,
            &dispatch_binding,
            input,
            &request_id,
        ));
        let mut operation_result = None;
        let mut post_operation_checks = 0_u8;
        loop {
            match projected_user_input_ready_v2(
                &background_state,
                &dispatch_binding,
                &projected_input_id,
            ) {
                Ok(true) => {
                    let cleanup =
                        cancel_owned_agent_kernel_drive_v2(&background_state, &background_active)
                            .await;
                    if let Err(error) = cleanup {
                        handle_owned_drive_error_v2(
                            &AgentKernelDriveContextV2::from_state(&background_state),
                            &background_active,
                            &error,
                        )
                        .await;
                        let _ = settle_caller_error_outcome_v2(
                            &background_state,
                            &dispatch_binding,
                            &error,
                            true,
                        );
                        if let Some(sender) = persisted_sender.take() {
                            let _ = sender.send(Err(error));
                        }
                        return;
                    }
                    let owner_instance_id = match dispatch_binding
                        .drive_owner_instance_id
                        .as_deref()
                    {
                        Some(owner_instance_id) => owner_instance_id,
                        None => {
                            let error = AgentKernelV2Error::invalid(
                                "host_caller_request_owner_missing",
                                "User-input Run drive handoff requires its exact durable owner instance.",
                            );
                            let _ = settle_caller_error_outcome_v2(
                                &background_state,
                                &dispatch_binding,
                                &error,
                                true,
                            );
                            if let Some(sender) = persisted_sender.take() {
                                let _ = sender.send(Err(error));
                            }
                            return;
                        }
                    };
                    let superseded_outcome = json!({
                        "schemaVersion": HOST_CALLER_RUN_OUTCOME_SCHEMA_V2,
                        "disposition": "indeterminate",
                        "hostRunId": background_active.host_run_id,
                        "error": {
                            "code": "host_caller_request_superseded_by_user_input",
                            "message": "A newer durable user input superseded this caller after its owned Run drive was quiesced.",
                        },
                        "causation": {
                            "supersedingCallerRequestId": dispatch_binding.caller_request_id,
                            "supersedingRequestDigest": dispatch_binding.request_digest,
                        },
                    });
                    let handed_off_binding = match background_state
                        .host_services
                        .kernel_operations_v2
                        .handoff_run_drive_to_interrupt_caller(
                            &dispatch_binding,
                            owner_instance_id,
                            superseded_outcome,
                            &crate::utils::now_rfc3339_text(),
                        )
                        .map_err(AgentKernelV2Error::from_storage)
                    {
                        Ok(binding) => binding,
                        Err(error) => {
                            handle_owned_drive_error_v2(
                                &AgentKernelDriveContextV2::from_state(&background_state),
                                &background_active,
                                &error,
                            )
                            .await;
                            let _ = settle_caller_error_outcome_v2(
                                &background_state,
                                &dispatch_binding,
                                &error,
                                true,
                            );
                            if let Some(sender) = persisted_sender.take() {
                                let _ = sender.send(Err(error));
                            }
                            return;
                        }
                    };
                    let transfer = background_state
                        .kernel_wake_v2
                        .transfer_exact(interrupt_owner, continuation_owner.clone())
                        .await;
                    if !matches!(transfer, Ok(HostKernelWakeTransferOutcomeV2::Transferred)) {
                        let error = match transfer {
                            Err(supervisor_error) => {
                                AgentKernelV2Error::from_wake_supervisor(supervisor_error)
                            }
                            Ok(outcome) => AgentKernelV2Error::invalid(
                                "host_interrupt_continuation_transfer_failed",
                                format!(
                                    "Durable user input could not transfer its exact interrupt owner to the Session continuation lane: {outcome:?}"
                                ),
                            ),
                        };
                        handle_owned_drive_error_v2(
                            &AgentKernelDriveContextV2::from_state(&background_state),
                            &background_active,
                            &error,
                        )
                        .await;
                        let _ = settle_caller_error_outcome_v2(
                            &background_state,
                            &handed_off_binding,
                            &error,
                            true,
                        );
                        if let Some(sender) = persisted_sender.take() {
                            let _ = sender.send(Err(error));
                        }
                        return;
                    }
                    let admitted_binding = match persist_caller_admission_v2(
                        &background_state,
                        &background_active,
                        &handed_off_binding,
                        &continuation_owner,
                    ) {
                        Ok(binding) => binding,
                        Err(error) => {
                            handle_owned_drive_error_v2(
                                &AgentKernelDriveContextV2::from_state(&background_state),
                                &background_active,
                                &error,
                            )
                            .await;
                            let _ = settle_caller_error_outcome_v2(
                                &background_state,
                                &handed_off_binding,
                                &error,
                                true,
                            );
                            if let Some(sender) = persisted_sender.take() {
                                let _ = sender.send(Err(error));
                            }
                            return;
                        }
                    };
                    if let Some(sender) = persisted_sender.take() {
                        let _ = sender.send(Ok(()));
                    }
                    let result = match operation_result.take() {
                        Some(result) => result,
                        None => operation.await,
                    };
                    let result = match result {
                        Ok(settlement) => {
                            drive_agent_kernel_until_boundary_v2(
                                &AgentKernelDriveContextV2::from_state(&background_state),
                                &background_active,
                                settlement,
                            )
                            .await
                        }
                        Err(error) => Err(error),
                    };
                    finish_owned_caller_drive_v2(
                        &background_state,
                        &background_active,
                        &admitted_binding,
                        continuation_owner,
                        result,
                    )
                    .await;
                    return;
                }
                Ok(false) => {}
                Err(error) => {
                    let _ = settle_caller_error_outcome_v2(
                        &background_state,
                        &dispatch_binding,
                        &error,
                        true,
                    );
                    if let Some(sender) = persisted_sender.take() {
                        let _ = sender.send(Err(error));
                    }
                    return;
                }
            }
            if operation_result.is_some() {
                post_operation_checks = post_operation_checks.saturating_add(1);
                if post_operation_checks >= HOST_INPUT_PROJECTION_SETTLEMENT_GRACE_CHECKS_V2 {
                    let context = AgentKernelDriveContextV2::from_state(&background_state);
                    let (error, indeterminate) = match operation_result.take() {
                        Some(Err(error)) => {
                            let disposition =
                                handle_owned_drive_error_v2(&context, &background_active, &error)
                                    .await;
                            (
                                error,
                                matches!(
                                    disposition,
                                    OwnedDriveErrorDispositionV2::RecoveryWaiting
                                        | OwnedDriveErrorDispositionV2::IndeterminateManual
                                ),
                            )
                        }
                        Some(Ok(settlement))
                            if !matches!(
                                &settlement.settlement,
                                HostKernelOperationSettlementV2::Succeeded { .. }
                            ) =>
                        {
                            match drive_agent_kernel_until_boundary_v2(
                                &context,
                                &background_active,
                                settlement,
                            )
                            .await
                            {
                                Ok(AgentKernelDriveBoundaryV2::Failure {
                                    error,
                                    indeterminate,
                                }) => (error, indeterminate),
                                Ok(
                                    AgentKernelDriveBoundaryV2::Complete
                                    | AgentKernelDriveBoundaryV2::KernelWait(_),
                                ) => {
                                    let error = AgentKernelV2Error::invalid(
                                        "host_user_input_projection_settlement_invalid",
                                        "A failed Session user input operation reached a non-failure drive boundary before its exact input.persisted projection became durable.",
                                    );
                                    handle_owned_drive_error_v2(
                                        &context,
                                        &background_active,
                                        &error,
                                    )
                                    .await;
                                    (error, true)
                                }
                                Err(error) => {
                                    let disposition = handle_owned_drive_error_v2(
                                        &context,
                                        &background_active,
                                        &error,
                                    )
                                    .await;
                                    (
                                        error,
                                        matches!(
                                            disposition,
                                            OwnedDriveErrorDispositionV2::RecoveryWaiting
                                                | OwnedDriveErrorDispositionV2::IndeterminateManual
                                        ),
                                    )
                                }
                            }
                        }
                        Some(Ok(_)) | None => {
                            let error = AgentKernelV2Error::invalid(
                                "host_user_input_projection_missing",
                                "Session user input operation ended before its exact input.persisted projection became durable.",
                            );
                            handle_owned_drive_error_v2(&context, &background_active, &error).await;
                            (error, true)
                        }
                    };
                    let _ = settle_caller_error_outcome_v2(
                        &background_state,
                        &dispatch_binding,
                        &error,
                        indeterminate,
                    );
                    if let Some(sender) = persisted_sender.take() {
                        let _ = sender.send(Err(error));
                    }
                    return;
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {}
                result = &mut operation, if operation_result.is_none() => {
                    operation_result = Some(result);
                }
            }
        }
    };
    let registration = state.kernel_wake_v2.register_exclusive(owner, future).await;
    let registration = match registration {
        Ok(registration) => registration,
        Err(supervisor_error) => {
            drop(persisted_receiver);
            let error = AgentKernelV2Error::from_wake_supervisor(supervisor_error);
            settle_caller_error_outcome_v2(state, &binding, &error, false)?;
            return Err(error);
        }
    };
    if registration != HostKernelWakeRegisterOutcomeV2::Registered {
        drop(persisted_receiver);
        let error = AgentKernelV2Error::invalid(
            "host_interrupt_mailbox_busy",
            "This Session already has one pending Host interrupt mutation; wait for its durable input admission before submitting another.",
        );
        settle_caller_error_outcome_v2(state, &binding, &error, false)?;
        return Err(error);
    }
    Ok(AgentKernelUserInputAdmissionV2::Pending {
        state: state.clone(),
        binding,
        host_run_id: active.host_run_id,
        input_id: admission_input_id,
        persisted: Some(persisted_receiver),
    })
}

async fn complete_caller_admission_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    binding: HostCallerRequestBindingReceiptV2,
    owner: HostKernelWakeOwnerV2,
    admission_receiver: tokio::sync::oneshot::Receiver<Result<(), AgentKernelV2Error>>,
    replaced_wait: Option<AgentKernelFactWaitV2>,
) -> Result<String, AgentKernelV2Error> {
    let error = match admission_receiver.await {
        Ok(Ok(())) => return Ok(active.host_run_id.clone()),
        Ok(Err(error)) => error,
        Err(_) => AgentKernelV2Error::invalid(
            "host_kernel_caller_drive_owner_lost_before_admission",
            "The caller drive owner ended before it reported durable admission.",
        ),
    };
    let cleanup = state
        .kernel_wake_v2
        .cancel_owner_exact(owner)
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor);
    let indeterminate = !matches!(
        cleanup,
        Ok(HostKernelWakeCancelOutcomeV2::Cancelled) | Ok(HostKernelWakeCancelOutcomeV2::Missing)
    );
    let restored_wait = match replaced_wait {
        Some(wait) => register_owned_agent_kernel_wait_v2(
            state,
            AgentKernelDriveContextV2::from_state(state),
            wait,
        )
        .await
        .is_ok(),
        None => true,
    };
    if indeterminate || !restored_wait {
        let _ = settle_caller_error_outcome_v2(state, &binding, &error, true);
    } else {
        let _ = abandon_unadmitted_caller_v2(state, &binding, &error);
    }
    Err(error)
}

fn persist_caller_admission_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
    owner: &HostKernelWakeOwnerV2,
) -> Result<HostCallerRequestBindingReceiptV2, AgentKernelV2Error> {
    let owner_instance_id = binding.drive_owner_instance_id.as_deref().ok_or_else(|| {
        AgentKernelV2Error::invalid(
            "host_caller_request_owner_missing",
            "Claimed caller request has no durable owner instance identity.",
        )
    })?;
    let (admission_boundary, input_id) =
        match binding.request_kind.as_str() {
            HOST_USER_INPUT_REQUEST_KIND_V2 => {
                let input_id = caller_binding_string_v2(binding, "inputId")?;
                require_user_input_admission_projection_v2(state, binding)?;
                ("input.persisted", Some(input_id))
            }
            HOST_DECISION_REQUEST_KIND_V2 => ("decision.admitted", None),
            _ => return Err(AgentKernelV2Error::invalid(
                "host_caller_request_admission_kind_conflict",
                "Only exact decision and user-input callers may persist an ordinary Run admission.",
            )),
        };
    let mut admission = json!({
        "schemaVersion": HOST_CALLER_RUN_ADMISSION_SCHEMA_V2,
        "admissionBoundary": admission_boundary,
        "sessionId": binding.session_id,
        "hostRunId": active.host_run_id,
        "runId": active.run_id,
        "callerRequestId": binding.caller_request_id,
        "requestDigest": binding.request_digest,
        "ownerDigest": owner.identity_digest,
    });
    if let Some(input_id) = input_id {
        admission
            .as_object_mut()
            .expect("caller admission JSON object")
            .insert("inputId".to_string(), Value::String(input_id));
    }
    state
        .host_services
        .kernel_operations_v2
        .admit_caller_request(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            owner_instance_id,
            admission,
            &crate::utils::now_rfc3339_text(),
        )
        .map_err(AgentKernelV2Error::from_storage)
}

async fn cleanup_unadmitted_caller_registration_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    owner: HostKernelWakeOwnerV2,
    replaced_wait: Option<AgentKernelFactWaitV2>,
    error: &AgentKernelV2Error,
) -> Result<(), AgentKernelV2Error> {
    let cancelled = state
        .kernel_wake_v2
        .cancel_owner_exact(owner)
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor);
    let restored_wait = match replaced_wait {
        Some(wait) => register_owned_agent_kernel_wait_v2(
            state,
            AgentKernelDriveContextV2::from_state(state),
            wait,
        )
        .await
        .is_ok(),
        None => true,
    };
    if matches!(
        cancelled,
        Ok(HostKernelWakeCancelOutcomeV2::Cancelled) | Ok(HostKernelWakeCancelOutcomeV2::Missing)
    ) && restored_wait
    {
        abandon_unadmitted_caller_v2(state, binding, error)
    } else {
        settle_caller_error_outcome_v2(state, binding, error, true)
    }
}

async fn finish_owned_caller_drive_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
    owner: HostKernelWakeOwnerV2,
    result: Result<AgentKernelDriveBoundaryV2, AgentKernelV2Error>,
) {
    match result {
        Ok(AgentKernelDriveBoundaryV2::Complete) => {
            settle_caller_run_outcome_while_owned_v2(state, active, binding).await;
        }
        Ok(AgentKernelDriveBoundaryV2::KernelWait(wait)) => {
            let wait_owner = match host_kernel_wake_owner_v2(&wait) {
                Ok(wait_owner) => wait_owner,
                Err(error) => {
                    settle_caller_error_outcome_while_owned_v2(
                        state, active, binding, &error, true,
                    )
                    .await;
                    return;
                }
            };
            let retagged = state
                .kernel_wake_v2
                .retag_exact(owner, wait_owner.clone())
                .await;
            if !matches!(retagged, Ok(HostKernelWakeRetagOutcomeV2::Retagged)) {
                let error = AgentKernelV2Error::invalid(
                    "host_kernel_wake_owner_retag_conflict",
                    "Caller drive could not transfer exact ownership to its Kernel facts wait.",
                );
                settle_caller_error_outcome_while_owned_v2(state, active, binding, &error, true)
                    .await;
                return;
            }
            settle_caller_run_outcome_while_owned_v2(state, active, binding).await;
            let context = AgentKernelDriveContextV2::from_state(state);
            if let Err(error) =
                drive_owned_agent_kernel_wait_v2(&context, &state.kernel_wake_v2, wait_owner, wait)
                    .await
            {
                handle_owned_drive_error_v2(&context, active, &error).await;
            }
        }
        Ok(AgentKernelDriveBoundaryV2::Failure {
            error,
            indeterminate,
        }) => {
            settle_caller_error_outcome_while_owned_v2(
                state,
                active,
                binding,
                &error,
                indeterminate,
            )
            .await;
        }
        Err(error) => {
            let context = AgentKernelDriveContextV2::from_state(state);
            let disposition = handle_owned_drive_error_v2(&context, active, &error).await;
            match disposition {
                OwnedDriveErrorDispositionV2::RecoveryWaiting => {
                    settle_caller_error_outcome_while_owned_v2(
                        state, active, binding, &error, true,
                    )
                    .await;
                }
                OwnedDriveErrorDispositionV2::IndeterminateManual => {
                    settle_caller_error_outcome_while_owned_v2(
                        state, active, binding, &error, true,
                    )
                    .await;
                }
                OwnedDriveErrorDispositionV2::FailedAndRetire
                | OwnedDriveErrorDispositionV2::StaleStop => {
                    settle_caller_error_outcome_while_owned_v2(
                        state, active, binding, &error, false,
                    )
                    .await;
                }
            }
        }
    }
}

async fn settle_caller_run_outcome_while_owned_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
) {
    let mut reported_error_code = None;
    loop {
        match settle_caller_run_outcome_v2(state, binding, &active.host_run_id) {
            Ok(()) => return,
            Err(error) => {
                if reported_error_code.as_deref() != Some(error.code.as_str()) {
                    mark_caller_settlement_retry_v2(
                        state,
                        active,
                        format!(
                            "Caller outcome persistence is retrying while exact Run ownership remains live: {}",
                            error.code
                        ),
                    );
                    reported_error_code = Some(error.code);
                }
                tokio::time::sleep(HOST_CALLER_SETTLEMENT_RETRY_INTERVAL_V2).await;
            }
        }
    }
}

async fn settle_caller_error_outcome_while_owned_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
    drive_error: &AgentKernelV2Error,
    indeterminate: bool,
) {
    let mut reported_error_code = None;
    loop {
        match settle_caller_error_outcome_v2(state, binding, drive_error, indeterminate) {
            Ok(()) => return,
            Err(error) => {
                if reported_error_code.as_deref() != Some(error.code.as_str()) {
                    mark_caller_settlement_retry_v2(
                        state,
                        active,
                        format!(
                            "Caller failure persistence is retrying while exact Run ownership remains live: {}",
                            error.code
                        ),
                    );
                    reported_error_code = Some(error.code);
                }
                tokio::time::sleep(HOST_CALLER_SETTLEMENT_RETRY_INTERVAL_V2).await;
            }
        }
    }
}

fn mark_caller_settlement_retry_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    message: String,
) {
    let lifecycle = state
        .session_runs
        .lock()
        .expect("session run state lock")
        .get(&active.host_run_id)
        .filter(|run| run.session_id == active.session_id)
        .map(|run| run.status.clone())
        .unwrap_or_else(|| "waiting".to_string());
    mark_agent_run_v2(state, &active.host_run_id, &lifecycle, Some(message));
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
                    recorded_at: crate::utils::now_rfc3339_text(),
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
            crate::utils::now_rfc3339_text(),
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
    workspace_path: Option<&str>,
    no_workspace: bool,
    attachments: Option<&[AgentInputAttachmentV2]>,
    caller_request_id: &str,
) -> Result<AgentKernelUserInputAdmissionV2, AgentKernelV2Error> {
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
        "workspacePath": workspace_path,
        "noWorkspace": no_workspace,
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
            return user_input_admission_receipt_v2(state, binding, replayed_host_run_id)
                .map(AgentKernelUserInputAdmissionV2::Ready);
        }
        if let Some(admitted_host_run_id) =
            current_owned_caller_admission_v2(state, binding).await?
        {
            return user_input_admission_receipt_v2(state, binding, admitted_host_run_id)
                .map(AgentKernelUserInputAdmissionV2::Ready);
        }
        if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
            if current_owned_user_input_interrupt_v2(state, binding).await? {
                return Ok(AgentKernelUserInputAdmissionV2::Pending {
                    state: state.clone(),
                    binding: binding.clone(),
                    host_run_id: caller_binding_string_v2(binding, "hostRunId")?,
                    input_id: caller_binding_string_v2(binding, "inputId")?,
                    persisted: None,
                });
            }
            let host_run_id = recover_or_resume_driving_user_input_v2(state, binding).await?;
            return user_input_admission_receipt_v2(state, binding, host_run_id)
                .map(AgentKernelUserInputAdmissionV2::Ready);
        }
    }
    let active = require_active_agent_kernel_run_v2(state, session_id, Some(route_run_id))?;
    validate_active_run_workspace_request_v2(state, &active, workspace_path, no_workspace)?;
    validate_active_run_attachment_binding_v2(state, &active, &attachments)?;
    ensure_agent_run_cache_v2(state, &active)?;
    let binding = match existing {
        Some(binding) => binding,
        None => {
            let recorded_at = crate::utils::now_rfc3339_text();
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
            // A semantic user input is the durable interrupt boundary itself.
            // It may arrive while the current Session operation is still
            // pending, so it cannot depend on a settlement that does not yet
            // exist. The immutable Run bootstrap plus the exact semantic input
            // provides a stable replay identity without weakening the later
            // handoff, projection, or caller-correlation checks.
            let operation_request_id = stable_operation_request_id_v2(
                "user-input-interrupt",
                &active.bootstrap_digest,
                &identity_operation,
            )?;
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
    let bound_before_claim = binding.clone();
    let claim = claim_user_input_drive_or_restore_v2(state, binding).await;
    let binding = match claim {
        Err(error) if error.code == "host_interrupt_mailbox_busy" => {
            settle_caller_error_outcome_v2(state, &bound_before_claim, &error, false)?;
            return Err(error);
        }
        Err(error) => return Err(error),
        Ok(CallerDriveAdmissionV2::Acquired(binding)) => binding,
        Ok(CallerDriveAdmissionV2::Replayed(host_run_id)) => {
            return user_input_admission_receipt_v2(state, &bound_before_claim, host_run_id)
                .map(AgentKernelUserInputAdmissionV2::Ready);
        }
    };
    admit_and_spawn_user_input_v2(state, active, binding, input, request_id).await
}

async fn execute_bound_user_input_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
    input: HostKernelInitialInputV2,
    request_id: &str,
) -> Result<AgentKernelDriveBoundaryV2, AgentKernelV2Error> {
    let settlement = submit_bound_user_input_v2(state, active, binding, input, request_id).await?;
    drive_agent_kernel_until_boundary_v2(
        &AgentKernelDriveContextV2::from_state(state),
        active,
        settlement,
    )
    .await
}

async fn submit_bound_user_input_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
    input: HostKernelInitialInputV2,
    request_id: &str,
) -> Result<HostKernelOperationSettlementReceiptV2, AgentKernelV2Error> {
    let operation = HostKernelBridgeOperationV2::UserInput {
        input,
        guidance: Vec::new(),
    };
    mark_agent_run_v2(
        state,
        &active.host_run_id,
        "running",
        Some("New user input is advancing the control epoch.".to_string()),
    );
    let settlement = state
        .kernel_session_v2
        .submit_user_input_for_caller(
            &active.session_id,
            &active.host_run_id,
            request_id,
            &binding.caller_request_id,
            &binding.request_digest,
            operation,
        )
        .await
        .map_err(AgentKernelV2Error::from_storage)?;
    Ok(settlement)
}

fn validate_active_run_workspace_request_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    workspace_path: Option<&str>,
    no_workspace: bool,
) -> Result<(), AgentKernelV2Error> {
    let workspace_path = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty());
    match active.workspace_kind {
        HostRunWorkspaceKindV2::Empty => {
            if !no_workspace || workspace_path.is_some() {
                return Err(AgentKernelV2Error::invalid(
                    "host_run_workspace_mismatch",
                    "The immutable active Run has no workspace, but guidance requested a workspace-bound continuation.",
                ));
            }
            Ok(())
        }
        HostRunWorkspaceKindV2::Bound => {
            if no_workspace {
                return Err(AgentKernelV2Error::invalid(
                    "host_run_workspace_mismatch",
                    "The immutable active Run is workspace-bound and cannot continue in no-workspace mode.",
                ));
            }
            let workspace_path = workspace_path.ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "agent_guidance_workspace_required",
                    "Guidance for a workspace-bound Run requires an exact workspace path.",
                )
            })?;
            let workspace_binding_ref =
                WorkspaceBindingRefV2::new(active.workspace_binding_ref.clone()).map_err(|_| {
                    AgentKernelV2Error::invalid(
                        "host_run_workspace_unverifiable",
                        "The immutable active Run has an invalid workspace binding reference.",
                    )
                })?;
            state
                .host_services
                .workspace
                .validate_requested_run_workspace(
                    workspace_path,
                    &workspace_binding_ref,
                    &active.workspace_binding_identity,
                )
                .map_err(|error| AgentKernelV2Error::invalid(error.code, error.message))
        }
    }
}

fn user_input_is_projected_v2(
    state: &AppState,
    session_id: &str,
    input_id: &str,
) -> Result<bool, AgentKernelV2Error> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let events = read_session_kernel_v2_public_agent_events(&sessions_dir, session_id)
        .map_err(AgentKernelV2Error::from_storage)?;
    Ok(events.iter().any(|event| {
        event
            .pointer("/payload/projectionKind")
            .and_then(Value::as_str)
            == Some("input.persisted")
            && event.pointer("/payload/inputId").and_then(Value::as_str) == Some(input_id)
    }))
}

fn projected_user_input_ready_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    input_id: &str,
) -> Result<bool, AgentKernelV2Error> {
    if !user_input_is_projected_v2(state, &binding.session_id, input_id)? {
        return Ok(false);
    }
    let evidence = state
        .host_services
        .kernel_operations_v2
        .caller_control_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if !evidence.first_operation_present {
        return Ok(false);
    }
    Ok(true)
}

fn require_user_input_admission_projection_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<(), AgentKernelV2Error> {
    if binding.request_kind != HOST_USER_INPUT_REQUEST_KIND_V2 {
        return Err(AgentKernelV2Error::invalid(
            "host_user_input_admission_kind_conflict",
            "The input.persisted admission boundary requires an exact user-input caller.",
        ));
    }
    let input_id = caller_binding_string_v2(binding, "inputId")?;
    if projected_user_input_ready_v2(state, binding, &input_id)? {
        Ok(())
    } else {
        Err(AgentKernelV2Error::invalid(
            "host_user_input_projection_missing",
            "User-input admission requires its exact input.persisted projection and caller-correlated Session dispatch.",
        ))
    }
}

fn require_initial_input_projection_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<(), AgentKernelV2Error> {
    if binding.request_kind != HOST_RUN_OPEN_REQUEST_KIND_V2 {
        return Err(AgentKernelV2Error::invalid(
            "host_initial_input_request_kind_conflict",
            "Initial input projection validation requires an exact RunOpen caller.",
        ));
    }
    let input_id = caller_binding_string_v2(binding, "inputId")?;
    if user_input_is_projected_v2(state, &binding.session_id, &input_id)? {
        Ok(())
    } else {
        Err(AgentKernelV2Error::invalid(
            "host_initial_input_projection_missing",
            "RunOpen cannot acknowledge the initial user input before its exact input.persisted projection is durable.",
        ))
    }
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
            return recover_or_resume_driving_cancel_v2(state, binding)
                .await
                .map(Some);
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
    supersede_pending_user_input_for_cancel_v2(state, &active).await?;
    let cancel_operation_id = stable_identity_v2(
        "operation-cancel",
        &json!({
            "schemaVersion": "deepcode.host.cancel-operation-identity.v2",
            "sessionId": session_id,
            "hostRunId": active.host_run_id,
            "runId": active.run_id,
            "callerRequestId": caller_request_id,
            "callerRequestDigest": request_digest,
        }),
    )?;
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
                    "operationRequestId": cancel_operation_id,
                    "cancelOperationId": cancel_operation_id,
                }),
                recorded_at: crate::utils::now_rfc3339_text(),
            })
            .map_err(AgentKernelV2Error::from_storage)?,
    };
    if caller_binding_string_v2(&binding, "hostRunId")? != active.host_run_id
        || caller_binding_string_v2(&binding, "runId")? != active.run_id
        || caller_binding_string_v2(&binding, "operationRequestId")? != cancel_operation_id
        || caller_binding_string_v2(&binding, "cancelOperationId")? != cancel_operation_id
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_run_conflict",
            "Durable Host cancellation is bound to a different Run.",
        ));
    }
    let bound_before_claim = binding.clone();
    let claim = claim_cancel_drive_or_restore_v2(state, binding).await;
    let binding = match claim {
        Err(error) if error.code == "host_interrupt_mailbox_busy" => {
            settle_caller_error_outcome_v2(state, &bound_before_claim, &error, false)?;
            return Err(error);
        }
        Err(error) => return Err(error),
        Ok(CallerDriveAdmissionV2::Acquired(binding)) => binding,
        Ok(CallerDriveAdmissionV2::Replayed(host_run_id)) => return Ok(Some(host_run_id)),
    };
    cancel_owned_agent_kernel_wait_v2(state, &active).await?;
    if let Err(error) = state
        .kernel_session_v2
        .cancel_run_for_caller(
            session_id,
            &active.host_run_id,
            &active.run_id,
            &binding.caller_request_id,
            &binding.request_digest,
            &cancel_operation_id,
        )
        .await
        .map_err(AgentKernelV2Error::from_storage)
    {
        let error = safety_retire_failed_cancel_v2(
            state,
            &binding,
            &active.host_run_id,
            &active.run_id,
            error,
        )
        .await?;
        return Err(error);
    }
    mark_agent_run_v2(
        state,
        &active.host_run_id,
        "cancelled",
        Some("Kernel–Session v2 Run cancelled and its owned resources were retired.".to_string()),
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
    let Some(live_run) = state
        .host_services
        .kernel_operations_v2
        .live_run_for_deletion(session_id)
        .map_err(AgentKernelV2Error::from_storage)?
    else {
        return Ok(None);
    };
    let (host_run_id, kernel_run_id) = match &live_run {
        HostKernelLiveRunForDeletionV2::Opening(opening) => (opening.host_run_id.as_str(), None),
        HostKernelLiveRunForDeletionV2::Active(bootstrap) => (
            bootstrap.host_run_id.as_str(),
            Some(bootstrap.run_id.as_str()),
        ),
    };
    if let Some(route_run_id) = route_run_id {
        if route_run_id != host_run_id && kernel_run_id != Some(route_run_id) {
            return Err(AgentKernelV2Error::invalid(
                "agent_run_identity_conflict",
                "Run identity does not match the exact durable Host/Kernel Run.",
            ));
        }
    }
    let host_run_id = host_run_id.to_string();
    if let HostKernelLiveRunForDeletionV2::Active(active) = &live_run {
        let active_record = require_active_agent_kernel_run_v2(
            state,
            &active.session_id,
            Some(&active.host_run_id),
        )?;
        settle_pending_user_input_before_control_v2(
            state,
            &active_record,
            "host_user_input_superseded_by_retirement",
            "The pending user input was superseded by explicit Run retirement and was not replayed.",
        )
        .await?;
        cancel_owned_agent_kernel_wait_identity_v2(
            state,
            &active.session_id,
            &active.host_run_id,
            &active.run_id,
        )
        .await?;
    }
    let retired = state
        .kernel_session_v2
        .retire_session_durable_run(session_id)
        .await
        .map_err(AgentKernelV2Error::from_storage)?;
    if !retired {
        state
            .kernel_session_v2
            .verify_session_retired_for_deletion(session_id)
            .await
            .map_err(AgentKernelV2Error::from_storage)?;
        if route_run_id.is_some() {
            return Err(AgentKernelV2Error::invalid(
                "agent_run_retirement_identity_stale",
                "Exact Run identity became terminal before the requested retirement completed.",
            ));
        }
        return Ok(None);
    }
    mark_agent_run_v2(
        state,
        &host_run_id,
        terminal_status,
        Some(message.to_string()),
    );
    Ok(Some(host_run_id))
}

pub(crate) fn restore_agent_kernel_run_cache_v2(
    state: &AppState,
    session_id: &str,
    route_run_id: &str,
) -> Result<String, AgentKernelV2Error> {
    let active = match require_active_agent_kernel_run_v2(state, session_id, Some(route_run_id)) {
        Ok(active) => active,
        Err(error) if error.code == "agent_run_not_active" => {
            state
                .host_services
                .kernel_operations_v2
                .live_run_has_supported_history_schema(session_id, route_run_id)
                .map_err(AgentKernelV2Error::from_storage)?;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
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
            recorded_at: crate::utils::now_rfc3339_text(),
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
            workspace_canonical_root: prepared.workspace_canonical_root.clone(),
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
        workspace_canonical_root: prepared.workspace_canonical_root.clone(),
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
                        .unwrap_or("User rejected the current Plan; do not execute it.")
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
) -> Result<AgentKernelDriveBoundaryV2, AgentKernelV2Error> {
    match prepared {
        PreparedAgentDecisionV2::Plan {
            plan_revision,
            decision,
            guidance,
            operation_request_id,
        } => {
            if matches!(decision, HostKernelPlanDecisionV2::Accept) {
                approve_exact_plan_previews_v2(
                    &state.host_services,
                    &state.kernel_v2,
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
            drive_agent_kernel_until_boundary_v2(
                &AgentKernelDriveContextV2::from_state(state),
                active,
                settlement,
            )
            .await
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
                &state.kernel_v2,
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
            drive_agent_kernel_until_boundary_v2(
                &AgentKernelDriveContextV2::from_state(state),
                active,
                settlement,
            )
            .await
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
    host_services: &HostServices,
    kernel_v2: &crate::kernel_v2_transport::KernelV2TransportState,
    active: &HostActiveRunRecordV2,
    plan_revision: &str,
    mode: PlanPreviewAuthorizationModeV2,
) -> Result<(), AgentKernelV2Error> {
    let settlements = host_services
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
                            kernel_v2,
                            preview.preview_id.as_str(),
                            HostCapabilityDecisionKindV2::Allow,
                            "",
                            &decision_material,
                        )?;
                    }
                    PlanPreviewAuthorizationModeV2::AutoPlanTrust => {
                        apply_host_plan_trust_v2(
                            kernel_v2,
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
    kernel_v2: &crate::kernel_v2_transport::KernelV2TransportState,
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
    let response = kernel_v2
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
    kernel_v2: &crate::kernel_v2_transport::KernelV2TransportState,
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
    let response = kernel_v2
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

async fn drive_admitted_agent_kernel_run_v2(
    context: AgentKernelDriveContextV2,
    supervisor: crate::host_kernel_wake_v2::HostKernelWakeSupervisorV2,
    owner: HostKernelWakeOwnerV2,
    admitted: HostKernelRunAdmittedV2,
) {
    let active = admitted.active_run.clone();
    let settlement = match admitted.await_initial_operation().await {
        Ok(settlement) => settlement,
        Err(error) => {
            let error = AgentKernelV2Error::from_storage(error);
            handle_owned_drive_error_v2(&context, &active, &error).await;
            return;
        }
    };
    let boundary = match drive_agent_kernel_until_boundary_v2(&context, &active, settlement).await {
        Ok(boundary) => boundary,
        Err(error) => {
            handle_owned_drive_error_v2(&context, &active, &error).await;
            return;
        }
    };
    match boundary {
        AgentKernelDriveBoundaryV2::KernelWait(wait) => {
            let wait_owner = match host_kernel_wake_owner_v2(&wait) {
                Ok(wait_owner) => wait_owner,
                Err(error) => {
                    handle_owned_drive_error_v2(&context, &active, &error).await;
                    return;
                }
            };
            if !matches!(
                supervisor.retag_exact(owner, wait_owner.clone()).await,
                Ok(HostKernelWakeRetagOutcomeV2::Retagged)
            ) {
                let error = AgentKernelV2Error::invalid(
                    "host_kernel_wake_owner_retag_conflict",
                    "Initial Run drive could not transfer exact ownership to its Kernel facts wait.",
                );
                handle_owned_drive_error_v2(&context, &active, &error).await;
                return;
            }
            if let Err(error) =
                drive_owned_agent_kernel_wait_v2(&context, &supervisor, wait_owner, wait).await
            {
                handle_owned_drive_error_v2(&context, &active, &error).await;
            }
        }
        AgentKernelDriveBoundaryV2::Complete | AgentKernelDriveBoundaryV2::Failure { .. } => {}
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwnedDriveErrorDispositionV2 {
    RecoveryWaiting,
    FailedAndRetire,
    IndeterminateManual,
    StaleStop,
}

fn classify_owned_drive_error_v2(error: &AgentKernelV2Error) -> OwnedDriveErrorDispositionV2 {
    match error.code.as_str() {
        "session_permission_decision_stale" | "host_kernel_operation_unexpected_stale" => {
            OwnedDriveErrorDispositionV2::StaleStop
        }
        "host_kernel_wake_supervisor_unavailable"
        | "host_kernel_retry_recovery_waiting"
        | "host_kernel_facts_high_water_unavailable"
        | "host_kernel_run_settings_unavailable"
        | "session_kernel_automatic_step_budget_exhausted"
        | "session_kernel_production_operation_receipts_busy" => {
            OwnedDriveErrorDispositionV2::RecoveryWaiting
        }
        "session_kernel_production_operation_request_conflict"
        | "session_kernel_continuation_invalid"
        | "session_kernel_continuation_unsupported"
        | "session_plan_revision_missing"
        | "session_kernel_facts_high_water_missing"
        | "session_kernel_wake_continuation_invalid"
        | "session_kernel_wake_kind_invalid"
        | "host_kernel_operation_encode_failed"
        | "host_kernel_live_bridge_bootstrap_conflict"
        | "host_kernel_final_answer_binding_invalid" => {
            OwnedDriveErrorDispositionV2::FailedAndRetire
        }
        _ => OwnedDriveErrorDispositionV2::IndeterminateManual,
    }
}

async fn handle_owned_drive_error_v2(
    context: &AgentKernelDriveContextV2,
    active: &HostActiveRunRecordV2,
    error: &AgentKernelV2Error,
) -> OwnedDriveErrorDispositionV2 {
    match classify_owned_drive_error_v2(error) {
        OwnedDriveErrorDispositionV2::StaleStop => OwnedDriveErrorDispositionV2::StaleStop,
        OwnedDriveErrorDispositionV2::RecoveryWaiting => {
            mark_agent_drive_v2(
                context,
                &active.host_run_id,
                "waiting",
                Some(format!(
                    "Kernel–Session v2 owned Run drive ended without a live continuation owner and requires explicit recovery: {}",
                    error.code
                )),
            );
            OwnedDriveErrorDispositionV2::RecoveryWaiting
        }
        OwnedDriveErrorDispositionV2::IndeterminateManual => {
            mark_agent_drive_v2(
                context,
                &active.host_run_id,
                "waiting",
                Some(format!(
                    "Kernel–Session v2 owned Run drive is indeterminate and requires explicit manual recovery: {}",
                    error.code
                )),
            );
            OwnedDriveErrorDispositionV2::IndeterminateManual
        }
        OwnedDriveErrorDispositionV2::FailedAndRetire => {
            let retirement = context
                .kernel_session_v2
                .retire_run(&active.session_id, &active.host_run_id, &active.run_id)
                .await;
            let retirement_succeeded = retirement.is_ok();
            let (lifecycle, message) = match retirement {
                Ok(_) => (
                    "failed",
                    format!(
                        "Kernel–Session v2 terminated after a deterministic drive failure: {}",
                        error.code
                    ),
                ),
                Err(retirement_error) => (
                    "waiting",
                    format!(
                        "Kernel–Session v2 deterministic drive failure requires durable retirement recovery after {}: {}",
                        error.code, retirement_error.code
                    ),
                ),
            };
            mark_agent_drive_v2(context, &active.host_run_id, lifecycle, Some(message));
            if retirement_succeeded {
                OwnedDriveErrorDispositionV2::FailedAndRetire
            } else {
                OwnedDriveErrorDispositionV2::RecoveryWaiting
            }
        }
    }
}

async fn drive_agent_kernel_until_boundary_v2(
    context: &AgentKernelDriveContextV2,
    active: &HostActiveRunRecordV2,
    mut settlement: HostKernelOperationSettlementReceiptV2,
) -> Result<AgentKernelDriveBoundaryV2, AgentKernelV2Error> {
    let mut last_facts_wait = None;
    for _ in 0..MAX_AUTOMATIC_SESSION_STEPS_V2 {
        match &settlement.settlement {
            HostKernelOperationSettlementV2::FailedRecoverable {
                error_code,
                boundary,
            } => {
                let indeterminate = boundary.disposition
                    == HostKernelFailureDispositionV2::QueryFacts
                    || boundary.commit != HostKernelFailureCommitV2::None
                    || boundary.effect != HostKernelFailureEffectV2::None
                    || !boundary.pending_request_lanes.is_empty();
                mark_agent_drive_v2(
                    context,
                    &active.host_run_id,
                    "waiting",
                    Some(if indeterminate {
                        format!(
                            "Kernel–Session v2 operation is indeterminate and requires explicit fact recovery: {error_code}"
                        )
                    } else {
                        format!("Kernel–Session v2 operation requires replay-safe recovery: {error_code}")
                    }),
                );
                return Ok(AgentKernelDriveBoundaryV2::Failure {
                    error: AgentKernelV2Error::invalid(
                        error_code.clone(),
                        if indeterminate {
                            "Session reported an operation whose commit or effect boundary requires explicit fact recovery."
                        } else {
                            "Session reported a replay-safe recoverable operation failure."
                        },
                    ),
                    indeterminate,
                });
            }
            HostKernelOperationSettlementV2::FailedTerminal { error_code, .. } => {
                if let Err(retirement_error) = context
                    .kernel_session_v2
                    .retire_run(&active.session_id, &active.host_run_id, &active.run_id)
                    .await
                {
                    let retirement_error = AgentKernelV2Error::from_storage(retirement_error);
                    mark_agent_drive_v2(
                        context,
                        &active.host_run_id,
                        "waiting",
                        Some(format!(
                            "Kernel–Session v2 terminal failure requires durable retirement recovery after {}: {}",
                            error_code, retirement_error.code
                        )),
                    );
                    return Err(retirement_error);
                }
                mark_agent_drive_v2(
                    context,
                    &active.host_run_id,
                    "failed",
                    Some(format!("Kernel–Session v2 operation failed: {error_code}")),
                );
                return Ok(AgentKernelDriveBoundaryV2::Failure {
                    error: AgentKernelV2Error::invalid(
                        error_code.clone(),
                        "Session reported a terminal operation failure.",
                    ),
                    indeterminate: false,
                });
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
                expected_work_authority: required_continuation_work_authority_v2(
                    &settlement,
                    "workAuthority",
                )?,
            },
            "readyToRequestFinalAnswer" => HostKernelBridgeOperationV2::RequestFinalAnswer {
                input_id: required_continuation_field_v2(&settlement, "inputId")?.to_string(),
                control_epoch: continuation_u64_field_v2(&settlement, "controlEpoch")?,
                work_authority: required_continuation_work_authority_v2(
                    &settlement,
                    "workAuthority",
                )?,
                review_revision: continuation_u64_field_v2(&settlement, "reviewRevision")?,
                snapshot_high_water: continuation_u64_field_v2(&settlement, "snapshotHighWater")?,
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
                    mark_agent_drive_v2(
                        context,
                        &active.host_run_id,
                        "waiting",
                        Some("Waiting for new canonical Kernel facts.".to_string()),
                    );
                    return Ok(AgentKernelDriveBoundaryV2::KernelWait(
                        AgentKernelFactWaitV2 {
                            active: active.clone(),
                            predecessor: settlement,
                            observed_high_water,
                        },
                    ));
                }
                last_facts_wait = Some(observed_high_water);
                HostKernelBridgeOperationV2::ReconcileFacts {
                    observed_high_water,
                }
            }
            "terminalProviderAnswer" | "terminalProviderStop" | "terminalFinalAnswer" => {
                if continuation_kind == "terminalFinalAnswer" {
                    validate_final_answer_continuation_binding_v2(&settlement)?;
                }
                context
                    .kernel_session_v2
                    .retire_run(&active.session_id, &active.host_run_id, &active.run_id)
                    .await
                    .map_err(AgentKernelV2Error::from_storage)?;
                mark_agent_drive_v2(
                    context,
                    &active.host_run_id,
                    "completed",
                    Some(match continuation_kind {
                        "terminalFinalAnswer" => {
                            "Kernel–Session v2 final answer committed against the frozen Review."
                                .to_string()
                        }
                        "terminalProviderAnswer" => {
                            "Kernel–Session v2 provider answer completed.".to_string()
                        }
                        _ => "Kernel–Session v2 provider turn completed.".to_string(),
                    }),
                );
                return Ok(AgentKernelDriveBoundaryV2::Complete);
            }
            "terminalFinalAnswerFailed" => {
                validate_final_answer_continuation_binding_v2(&settlement)?;
                let error_code = required_continuation_field_v2(&settlement, "errorCode")?;
                context
                    .kernel_session_v2
                    .retire_run(&active.session_id, &active.host_run_id, &active.run_id)
                    .await
                    .map_err(AgentKernelV2Error::from_storage)?;
                mark_agent_drive_v2(
                    context,
                    &active.host_run_id,
                    "failed",
                    Some(format!(
                        "Kernel–Session v2 final answer failed without retry: {error_code}"
                    )),
                );
                return Ok(AgentKernelDriveBoundaryV2::Complete);
            }
            "awaitingUserPlanConfirmation" => {
                let plan_revision =
                    required_continuation_field_v2(&settlement, "planRevision")?.to_string();
                if !continuation_bool_field_v2(&settlement, "confirmationReady")? {
                    let publish =
                        HostKernelBridgeOperationV2::PublishPlanConfirmationReady { plan_revision };
                    let request_id = next_operation_request_id_v2(&settlement, &publish)?;
                    mark_agent_drive_v2(
                        context,
                        &active.host_run_id,
                        "running",
                        Some(
                            "Publishing the post-settlement Plan confirmation boundary."
                                .to_string(),
                        ),
                    );
                    settlement = context
                        .kernel_session_v2
                        .submit_operation(
                            &active.session_id,
                            &active.host_run_id,
                            &request_id,
                            publish,
                        )
                        .await
                        .map_err(AgentKernelV2Error::from_storage)?;
                    continue;
                }
                let run_id = RunId::new(active.run_id.clone()).map_err(|_| {
                    AgentKernelV2Error::invalid(
                        "host_kernel_run_id_invalid",
                        "Durable active Host Run contains an invalid Kernel Run identity.",
                    )
                })?;
                let settings = context
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
                    approve_exact_plan_previews_v2(
                        &context.host_services,
                        &context.kernel_v2,
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
                    mark_agent_drive_v2(
                        context,
                        &active.host_run_id,
                        "running",
                        Some(
                            "Applying the persisted auto-plan setting through exact Kernel trust."
                                .to_string(),
                        ),
                    );
                    let decided = context
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
                    settlement = context
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
                mark_agent_drive_v2(
                    context,
                    &active.host_run_id,
                    "waiting",
                    Some("Waiting for exact Plan confirmation.".to_string()),
                );
                return Ok(AgentKernelDriveBoundaryV2::Complete);
            }
            "awaitingUserScopeDecision" => {
                mark_agent_drive_v2(
                    context,
                    &active.host_run_id,
                    "waiting",
                    Some("Waiting for an exact capability scope decision.".to_string()),
                );
                return Ok(AgentKernelDriveBoundaryV2::Complete);
            }
            "awaitingKernelWake" => {
                mark_agent_drive_v2(
                    context,
                    &active.host_run_id,
                    "waiting",
                    Some("Waiting for a canonical Kernel wake fact.".to_string()),
                );
                let observed_high_water = success_response_v2(&settlement)?
                    .pointer("/state/factsRunSequenceHighWater")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        AgentKernelV2Error::invalid(
                            "session_kernel_facts_high_water_missing",
                            "Kernel wake continuation has no exact facts run-sequence high-water.",
                        )
                    })?;
                kernel_wait_operation_v2(&settlement, observed_high_water)?;
                return Ok(AgentKernelDriveBoundaryV2::KernelWait(
                    AgentKernelFactWaitV2 {
                        active: active.clone(),
                        predecessor: settlement,
                        observed_high_water,
                    },
                ));
            }
            "manualRecoveryRequired" | "recoveryRequired" | "providerBudgetExhausted" => {
                mark_agent_drive_v2(
                    context,
                    &active.host_run_id,
                    "waiting",
                    Some(format!(
                        "Kernel–Session v2 requires explicit recovery at {continuation_kind}."
                    )),
                );
                return Ok(AgentKernelDriveBoundaryV2::Complete);
            }
            "providerTurnSuperseded" | "userInputSuperseded" => {
                mark_agent_drive_v2(
                    context,
                    &active.host_run_id,
                    "waiting",
                    Some("The previous provider turn was superseded by newer input.".to_string()),
                );
                return Ok(AgentKernelDriveBoundaryV2::Complete);
            }
            _ => {
                return Err(AgentKernelV2Error::invalid(
                    "session_kernel_continuation_unsupported",
                    format!("Unsupported Session v2 continuation: {continuation_kind}"),
                ))
            }
        };
        let request_id = next_operation_request_id_v2(&settlement, &operation)?;
        mark_agent_drive_v2(
            context,
            &active.host_run_id,
            "running",
            Some(format!(
                "Advancing Kernel–Session v2 continuation {continuation_kind}."
            )),
        );
        settlement = context
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
    mark_agent_drive_v2(
        context,
        &active.host_run_id,
        "waiting",
        Some("Automatic Session continuation budget exhausted.".to_string()),
    );
    Err(AgentKernelV2Error::invalid(
        "session_kernel_automatic_step_budget_exhausted",
        "Automatic Kernel–Session v2 continuation exceeded its bounded Host budget.",
    ))
}

async fn register_owned_agent_kernel_wait_v2(
    state: &AppState,
    context: AgentKernelDriveContextV2,
    wait: AgentKernelFactWaitV2,
) -> Result<(), AgentKernelV2Error> {
    let owner = host_kernel_wake_owner_v2(&wait)?;
    let owner_for_drive = owner.clone();
    let supervisor = state.kernel_wake_v2.clone();
    let supervisor_for_drive = supervisor.clone();
    let failure_context = context.clone();
    let failure_active = wait.active.clone();
    let outcome = supervisor
        .register_exclusive(owner, async move {
            if let Err(error) = drive_owned_agent_kernel_wait_v2(
                &context,
                &supervisor_for_drive,
                owner_for_drive,
                wait,
            )
            .await
            {
                handle_owned_drive_error_v2(&failure_context, &failure_active, &error).await;
            }
        })
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)?;
    match outcome {
        HostKernelWakeRegisterOutcomeV2::Registered
        | HostKernelWakeRegisterOutcomeV2::AlreadyExact => Ok(()),
        HostKernelWakeRegisterOutcomeV2::OwnerConflict => Err(AgentKernelV2Error::invalid(
            "host_kernel_wake_owner_conflict",
            "A different exact owner is already driving this Run.",
        )),
    }
}

async fn drive_owned_agent_kernel_wait_v2(
    context: &AgentKernelDriveContextV2,
    supervisor: &crate::host_kernel_wake_v2::HostKernelWakeSupervisorV2,
    mut owner: HostKernelWakeOwnerV2,
    mut wait: AgentKernelFactWaitV2,
) -> Result<(), AgentKernelV2Error> {
    loop {
        if !wait_for_kernel_fact_advance_v2(
            context,
            &wait.active,
            &wait.predecessor,
            wait.observed_high_water,
        )
        .await?
        {
            return Ok(());
        }
        let operation = kernel_wait_operation_v2(&wait.predecessor, wait.observed_high_water)?;
        let request_id = next_operation_request_id_v2(&wait.predecessor, &operation)?;
        let dispatch_context = context.clone();
        let dispatch_host_run_id = wait.active.host_run_id.clone();
        let settlement = context
            .kernel_session_v2
            .submit_operation_if_latest_settlement(
                &wait.active.session_id,
                &wait.active.host_run_id,
                &request_id,
                operation,
                &wait.active.run_id,
                &wait.active.bootstrap_digest,
                &wait.predecessor.settlement_digest,
                move || {
                    mark_agent_drive_v2(
                        &dispatch_context,
                        &dispatch_host_run_id,
                        "running",
                        Some(
                            "Canonical Kernel facts resumed the owned Session continuation."
                                .to_string(),
                        ),
                    );
                },
            )
            .await
            .map_err(AgentKernelV2Error::from_storage)?;
        let Some(settlement) = settlement else {
            return Ok(());
        };
        match drive_agent_kernel_until_boundary_v2(context, &wait.active, settlement).await? {
            AgentKernelDriveBoundaryV2::Complete => return Ok(()),
            AgentKernelDriveBoundaryV2::KernelWait(next_wait) => {
                let next_owner = host_kernel_wake_owner_v2(&next_wait)?;
                match supervisor
                    .retag_exact(owner.clone(), next_owner.clone())
                    .await
                    .map_err(AgentKernelV2Error::from_wake_supervisor)?
                {
                    HostKernelWakeRetagOutcomeV2::Retagged => {
                        owner = next_owner;
                        wait = next_wait;
                    }
                    HostKernelWakeRetagOutcomeV2::Missing
                    | HostKernelWakeRetagOutcomeV2::OwnerConflict
                    | HostKernelWakeRetagOutcomeV2::ReplacementKeyMismatch => {
                        return Err(AgentKernelV2Error::invalid(
                            "host_kernel_wake_owner_retag_conflict",
                            "Kernel facts continuation lost its exact wake owner during handoff.",
                        ))
                    }
                }
            }
            AgentKernelDriveBoundaryV2::Failure { .. } => return Ok(()),
        }
    }
}

fn kernel_wait_operation_v2(
    predecessor: &HostKernelOperationSettlementReceiptV2,
    observed_high_water: u64,
) -> Result<HostKernelBridgeOperationV2, AgentKernelV2Error> {
    match continuation_kind_v2(predecessor) {
        Some("awaitingKernelFacts") => {
            if continuation_u64_field_v2(predecessor, "observedHighWater")? != observed_high_water {
                return Err(AgentKernelV2Error::invalid(
                    "session_kernel_facts_high_water_conflict",
                    "Kernel facts wait identity changed before owned continuation registration.",
                ));
            }
            Ok(HostKernelBridgeOperationV2::ReconcileFacts {
                observed_high_water,
            })
        }
        Some("awaitingKernelWake") => {
            let wait_kind = match continuation_field_v2(predecessor, "waitKind") {
                Some("capabilityDecisionFact") => HostKernelWaitKindV2::Capability,
                Some("invocation") => HostKernelWaitKindV2::Invocation,
                _ => {
                    return Err(AgentKernelV2Error::invalid(
                        "session_kernel_wake_kind_invalid",
                        "Session returned an unsupported exact wake continuation.",
                    ))
                }
            };
            Ok(HostKernelBridgeOperationV2::ReconcileWake {
                wait_kind,
                operation_id: required_continuation_field_v2(predecessor, "operationId")?
                    .to_string(),
                invocation_id: required_continuation_field_v2(predecessor, "invocationId")?
                    .to_string(),
                preview_id: continuation_field_v2(predecessor, "previewId").map(str::to_string),
                plan_action_id: continuation_field_v2(predecessor, "planActionId")
                    .map(str::to_string),
                expected_plan_revision: continuation_field_v2(predecessor, "expectedPlanRevision")
                    .map(str::to_string),
                guidance: Vec::new(),
            })
        }
        _ => Err(AgentKernelV2Error::invalid(
            "session_kernel_wake_continuation_invalid",
            "Owned Kernel wake registration requires an exact Kernel wait continuation.",
        )),
    }
}

fn host_kernel_wake_owner_v2(
    wait: &AgentKernelFactWaitV2,
) -> Result<HostKernelWakeOwnerV2, AgentKernelV2Error> {
    let key = HostKernelWakeKeyV2 {
        session_id: wait.active.session_id.clone(),
        host_run_id: wait.active.host_run_id.clone(),
        run_id: wait.active.run_id.clone(),
        lane: HostKernelWakeLaneV2::Drive,
    };
    let identity_digest = canonical_sha256(&json!({
        "schemaVersion": "deepcode.host.kernel-wake-owner.v2",
        "sessionId": key.session_id,
        "hostRunId": key.host_run_id,
        "runId": key.run_id,
        "bootstrapDigest": wait.active.bootstrap_digest,
        "predecessorSettlementDigest": wait.predecessor.settlement_digest,
        "observedHighWater": wait.observed_high_water,
    }))
    .map_err(AgentKernelV2Error::from_storage)?;
    Ok(HostKernelWakeOwnerV2 {
        key,
        identity_digest,
    })
}

fn host_kernel_initial_drive_owner_v2(
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
    operation_request_id: &str,
) -> Result<HostKernelWakeOwnerV2, AgentKernelV2Error> {
    if binding.session_id != active.session_id
        || caller_binding_string_v2(binding, "hostRunId")? != active.host_run_id
        || binding.request_kind != HOST_RUN_OPEN_REQUEST_KIND_V2
    {
        return Err(AgentKernelV2Error::invalid(
            "host_kernel_initial_drive_identity_conflict",
            "Initial Run drive owner does not match its exact durable caller and Run identity.",
        ));
    }
    let key = HostKernelWakeKeyV2 {
        session_id: active.session_id.clone(),
        host_run_id: active.host_run_id.clone(),
        run_id: active.run_id.clone(),
        lane: HostKernelWakeLaneV2::Drive,
    };
    let identity_digest = canonical_sha256(&json!({
        "schemaVersion": "deepcode.host.kernel-initial-drive-owner.v2",
        "sessionId": key.session_id,
        "hostRunId": key.host_run_id,
        "runId": key.run_id,
        "bootstrapDigest": active.bootstrap_digest,
        "callerRequestId": binding.caller_request_id,
        "callerRequestDigest": binding.request_digest,
        "operationRequestId": operation_request_id,
    }))
    .map_err(AgentKernelV2Error::from_storage)?;
    Ok(HostKernelWakeOwnerV2 {
        key,
        identity_digest,
    })
}

fn host_kernel_caller_drive_owner_v2(
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<HostKernelWakeOwnerV2, AgentKernelV2Error> {
    if binding.session_id != active.session_id
        || caller_binding_string_v2(binding, "hostRunId")? != active.host_run_id
        || caller_binding_string_v2(binding, "runId")? != active.run_id
    {
        return Err(AgentKernelV2Error::invalid(
            "host_kernel_caller_drive_identity_conflict",
            "Caller drive owner does not match its exact durable caller and Run identity.",
        ));
    }
    let operation_request_id = caller_binding_string_v2(binding, "operationRequestId")?;
    let key = HostKernelWakeKeyV2 {
        session_id: active.session_id.clone(),
        host_run_id: active.host_run_id.clone(),
        run_id: active.run_id.clone(),
        lane: HostKernelWakeLaneV2::Drive,
    };
    let owner_identity = if binding.request_kind == HOST_USER_INPUT_REQUEST_KIND_V2 {
        json!({
            "schemaVersion": "deepcode.host.kernel-user-input-drive-owner.v1",
            "sessionId": key.session_id,
            "hostRunId": key.host_run_id,
            "runId": key.run_id,
            "bootstrapDigest": active.bootstrap_digest,
            "callerRequestId": binding.caller_request_id,
            "callerRequestDigest": binding.request_digest,
            "inputId": caller_binding_string_v2(binding, "inputId")?,
            "operationRequestId": operation_request_id,
        })
    } else {
        let predecessor_settlement_digest =
            caller_binding_string_v2(binding, "predecessorSettlementDigest")?;
        json!({
            "schemaVersion": "deepcode.host.kernel-caller-drive-owner.v2",
            "sessionId": key.session_id,
            "hostRunId": key.host_run_id,
            "runId": key.run_id,
            "bootstrapDigest": active.bootstrap_digest,
            "callerRequestId": binding.caller_request_id,
            "requestKind": binding.request_kind,
            "callerRequestDigest": binding.request_digest,
            "operationRequestId": operation_request_id,
            "predecessorSettlementDigest": predecessor_settlement_digest,
        })
    };
    let identity_digest =
        canonical_sha256(&owner_identity).map_err(AgentKernelV2Error::from_storage)?;
    if let Some(admission) = binding.admission.as_ref() {
        if admission.get("ownerDigest").and_then(Value::as_str) != Some(identity_digest.as_str()) {
            return Err(AgentKernelV2Error::invalid(
                "host_caller_request_admission_owner_conflict",
                "Durable caller admission is bound to a different exact wake owner.",
            ));
        }
    }
    Ok(HostKernelWakeOwnerV2 {
        key,
        identity_digest,
    })
}

fn host_kernel_interrupt_owner_v2(
    active: &HostActiveRunRecordV2,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<HostKernelWakeOwnerV2, AgentKernelV2Error> {
    if binding.session_id != active.session_id
        || binding.request_kind != HOST_USER_INPUT_REQUEST_KIND_V2
        || caller_binding_string_v2(binding, "hostRunId")? != active.host_run_id
        || caller_binding_string_v2(binding, "runId")? != active.run_id
    {
        return Err(AgentKernelV2Error::invalid(
            "host_kernel_interrupt_identity_conflict",
            "Interrupt owner does not match its exact durable user input and Run identity.",
        ));
    }
    let operation_request_id = caller_binding_string_v2(binding, "operationRequestId")?;
    let key = HostKernelWakeKeyV2 {
        session_id: active.session_id.clone(),
        host_run_id: active.host_run_id.clone(),
        run_id: active.run_id.clone(),
        lane: HostKernelWakeLaneV2::Interrupt,
    };
    let identity_digest = canonical_sha256(&json!({
        "schemaVersion": "deepcode.host.kernel-interrupt-owner.v2",
        "sessionId": key.session_id,
        "hostRunId": key.host_run_id,
        "runId": key.run_id,
        "bootstrapDigest": active.bootstrap_digest,
        "callerRequestId": binding.caller_request_id,
        "callerRequestDigest": binding.request_digest,
        "inputId": caller_binding_string_v2(binding, "inputId")?,
        "operationRequestId": operation_request_id,
    }))
    .map_err(AgentKernelV2Error::from_storage)?;
    Ok(HostKernelWakeOwnerV2 {
        key,
        identity_digest,
    })
}

fn latest_drive_settlement_v2(
    context: &AgentKernelDriveContextV2,
    active: &HostActiveRunRecordV2,
) -> Result<HostKernelOperationSettlementReceiptV2, AgentKernelV2Error> {
    context
        .host_services
        .kernel_operations_v2
        .latest_settlement(&active.session_id, &active.host_run_id)
        .map_err(AgentKernelV2Error::from_storage)?
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_kernel_settlement_missing",
                "Active Kernel–Session v2 Run has no durable Session settlement.",
            )
        })
}

async fn wait_for_kernel_fact_advance_v2(
    context: &AgentKernelDriveContextV2,
    active: &HostActiveRunRecordV2,
    predecessor: &HostKernelOperationSettlementReceiptV2,
    observed_high_water: u64,
) -> Result<bool, AgentKernelV2Error> {
    let run_id = RunId::new(active.run_id.clone()).map_err(|_| {
        AgentKernelV2Error::invalid(
            "host_kernel_run_id_invalid",
            "Durable active Host Run contains an invalid Kernel Run identity.",
        )
    })?;
    loop {
        let current = context
            .host_services
            .active_runs_v2
            .resolve_session_active_run(&active.session_id)
            .map_err(AgentKernelV2Error::from_storage)?;
        let Some(current) = current else {
            return Ok(false);
        };
        if current.host_run_id != active.host_run_id
            || current.run_id != active.run_id
            || current.bootstrap_digest != active.bootstrap_digest
        {
            return Ok(false);
        }
        if latest_drive_settlement_v2(context, &current)?.settlement_digest
            != predecessor.settlement_digest
        {
            return Ok(false);
        }
        let kernel_high_water = context
            .kernel_v2
            .service()
            .run_sequence_high_water(&run_id)
            .map_err(|_| {
                AgentKernelV2Error::invalid(
                    "host_kernel_facts_high_water_unavailable",
                    "Kernel facts high-water is unavailable for the active Run.",
                )
            })?;
        if kernel_high_water < observed_high_water {
            return Err(AgentKernelV2Error::invalid(
                "host_kernel_facts_high_water_regressed",
                "Kernel facts high-water regressed below the Session observation.",
            ));
        }
        if kernel_high_water > observed_high_water {
            return Ok(true);
        }
        tokio::time::sleep(KERNEL_FACT_WAKE_POLL_INTERVAL_V2).await;
    }
}

pub(crate) async fn restore_agent_kernel_caller_owners_v2(
    state: &AppState,
    recoverable_session_ids: &HashSet<String>,
) -> Result<HashSet<HostKernelWakeKeyV2>, AgentKernelV2Error> {
    let mut blocked_runs = HashSet::new();
    let stranded_run_open_callers = state
        .host_services
        .kernel_operations_v2
        .unadmitted_driving_run_open_callers(recoverable_session_ids)
        .map_err(AgentKernelV2Error::from_storage)?;
    for binding in stranded_run_open_callers {
        if let Err(error) = recover_driving_run_open_v2(state, &binding) {
            let recovered = state
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
                        "host_run_open_startup_binding_lost",
                        "Recovered RunOpen binding disappeared before startup settlement.",
                    )
                })?;
            if recovered.outcome.is_none() {
                return Err(error);
            }
        }
    }
    let stranded_interrupt_callers = state
        .host_services
        .kernel_operations_v2
        .driving_interrupt_callers(recoverable_session_ids)
        .map_err(AgentKernelV2Error::from_storage)?;
    for binding in stranded_interrupt_callers {
        let host_run_id = caller_binding_string_v2(&binding, "hostRunId")?;
        let result = match binding.request_kind.as_str() {
            HOST_USER_INPUT_REQUEST_KIND_V2 => {
                recover_or_resume_driving_user_input_v2(state, &binding).await
            }
            HOST_CANCEL_REQUEST_KIND_V2 => {
                recover_or_resume_driving_cancel_v2(state, &binding).await
            }
            _ => unreachable!("interrupt startup query returns only frozen control kinds"),
        };
        if let Err(error) = result {
            let recovered = state
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
                        "host_interrupt_startup_binding_lost",
                        "Recovered Host interrupt binding disappeared before startup settlement.",
                    )
                })?;
            if recovered.outcome.is_none() {
                return Err(error);
            }
            mark_agent_run_v2(
                state,
                &host_run_id,
                "waiting",
                Some(format!(
                    "A durable Host interrupt was closed during startup recovery: {}",
                    error.code
                )),
            );
        }
    }
    let active_runs = state
        .host_services
        .active_runs_v2
        .active_run_records()
        .map_err(AgentKernelV2Error::from_storage)?;
    for active in active_runs {
        let key = HostKernelWakeKeyV2 {
            session_id: active.session_id.clone(),
            host_run_id: active.host_run_id.clone(),
            run_id: active.run_id.clone(),
            lane: HostKernelWakeLaneV2::Drive,
        };
        let drive = state
            .host_services
            .kernel_operations_v2
            .caller_drive_recovery_for_run(&active.session_id, &active.host_run_id)
            .map_err(AgentKernelV2Error::from_storage)?;
        let binding = match drive {
            HostRunCallerDriveRecoveryV2::NoDrive => continue,
            HostRunCallerDriveRecoveryV2::Unadmitted(binding) => {
                let error = AgentKernelV2Error::invalid(
                    "host_caller_request_admission_incomplete",
                    "Daemon restart found a caller drive that never obtained durable admission.",
                );
                if binding.request_kind == HOST_RUN_OPEN_REQUEST_KIND_V2 {
                    settle_caller_error_outcome_v2(state, &binding, &error, true)?;
                    mark_agent_run_v2(
                        state,
                        &active.host_run_id,
                        "waiting",
                        Some(
                            "RunOpen crossed a durable execution boundary before caller admission; the exact Run is retained for explicit recovery."
                                .to_string(),
                        ),
                    );
                    blocked_runs.insert(key);
                } else if matches!(
                    binding.request_kind.as_str(),
                    HOST_DECISION_REQUEST_KIND_V2 | HOST_USER_INPUT_REQUEST_KIND_V2
                ) {
                    abandon_unadmitted_caller_v2(state, &binding, &error)?;
                    mark_agent_run_v2(
                        state,
                        &active.host_run_id,
                        "waiting",
                        Some(
                            "An unadmitted zero-effect caller was closed; a new request may continue the Run."
                                .to_string(),
                        ),
                    );
                } else {
                    settle_caller_error_outcome_v2(state, &binding, &error, true)?;
                    mark_agent_run_v2(
                        state,
                        &active.host_run_id,
                        "waiting",
                        Some(
                            "An unsupported unadmitted caller is retained for explicit recovery."
                                .to_string(),
                        ),
                    );
                    blocked_runs.insert(key);
                }
                continue;
            }
            HostRunCallerDriveRecoveryV2::Indeterminate(binding) => {
                restore_caller_run_admission_v2(&binding)?;
                if binding.request_kind == HOST_USER_INPUT_REQUEST_KIND_V2 {
                    require_user_input_admission_projection_v2(state, &binding)?;
                }
                ensure_agent_run_cache_v2(state, &active)?;
                mark_agent_run_v2(
                    state,
                    &active.host_run_id,
                    "waiting",
                    Some(
                        "An indeterminate caller drive is held for explicit manual recovery."
                            .to_string(),
                    ),
                );
                blocked_runs.insert(key);
                continue;
            }
            HostRunCallerDriveRecoveryV2::Admitted(binding) => binding,
        };
        restore_caller_run_admission_v2(&binding)?;
        if binding.request_kind == HOST_USER_INPUT_REQUEST_KIND_V2 {
            require_user_input_admission_projection_v2(state, &binding)?;
        }
        ensure_agent_run_cache_v2(state, &active)?;
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
        if evidence.first_operation_pending {
            let error = AgentKernelV2Error::invalid(
                "host_caller_request_indeterminate",
                "Daemon restart found an admitted caller with an unresolved Session dispatch; automatic replay is unsafe.",
            );
            settle_caller_error_outcome_v2(state, &binding, &error, true)?;
            mark_agent_run_v2(state, &active.host_run_id, "waiting", Some(error.message));
            blocked_runs.insert(key);
            continue;
        }
        let action = match binding.request_kind.as_str() {
            HOST_DECISION_REQUEST_KIND_V2 => {
                RecoveredCallerDriveActionV2::Decision(decode_prepared_agent_decision_v2(&binding)?)
            }
            HOST_USER_INPUT_REQUEST_KIND_V2 => RecoveredCallerDriveActionV2::UserInput {
                input: durable_user_input_from_binding_v2(&binding)?,
                operation_request_id: caller_binding_string_v2(&binding, "operationRequestId")?,
            },
            _ => {
                let error = AgentKernelV2Error::invalid(
                    "host_caller_request_kind_conflict",
                    "Startup caller recovery found an unsupported ordinary request kind.",
                );
                settle_caller_error_outcome_v2(state, &binding, &error, true)?;
                blocked_runs.insert(key);
                continue;
            }
        };
        if let RecoveredCallerDriveActionV2::UserInput { input, .. } = &action {
            validate_active_run_attachment_binding_v2(state, &active, &input.attachments)?;
        }
        let reclaimed = state
            .host_services
            .kernel_operations_v2
            .reclaim_admitted_caller_request_drive(
                &binding,
                &state.host_services.active_runs_v2.owner_instance_id(),
                &crate::utils::now_rfc3339_text(),
            )
            .map_err(AgentKernelV2Error::from_storage)?;
        let owner = host_kernel_caller_drive_owner_v2(&active, &reclaimed)?;
        let owner_for_drive = owner.clone();
        let background_state = state.clone();
        let background_active = active.clone();
        let outcome = state
            .kernel_wake_v2
            .register_exclusive(owner, async move {
                let result = match action {
                    RecoveredCallerDriveActionV2::Decision(prepared) => {
                        execute_prepared_agent_decision_v2(
                            &background_state,
                            &background_active,
                            &reclaimed,
                            prepared,
                        )
                        .await
                    }
                    RecoveredCallerDriveActionV2::UserInput {
                        input,
                        operation_request_id,
                    } => {
                        execute_bound_user_input_v2(
                            &background_state,
                            &background_active,
                            &reclaimed,
                            input,
                            &operation_request_id,
                        )
                        .await
                    }
                };
                finish_owned_caller_drive_v2(
                    &background_state,
                    &background_active,
                    &reclaimed,
                    owner_for_drive,
                    result,
                )
                .await;
            })
            .await
            .map_err(AgentKernelV2Error::from_wake_supervisor)?;
        if outcome != HostKernelWakeRegisterOutcomeV2::Registered {
            return Err(AgentKernelV2Error::invalid(
                "host_kernel_caller_restore_owner_conflict",
                "Startup could not restore the exact admitted caller owner.",
            ));
        }
        blocked_runs.insert(key);
    }
    Ok(blocked_runs)
}

pub(crate) async fn restore_agent_kernel_wait_owners_v2(
    state: &AppState,
    runs: &[HostKernelStartupContinuationRunV2],
    caller_owned_runs: &HashSet<HostKernelWakeKeyV2>,
) -> Result<(), AgentKernelV2Error> {
    for run in runs {
        let Some(active) = state
            .host_services
            .active_runs_v2
            .resolve_session_active_run(&run.session_id)
            .map_err(AgentKernelV2Error::from_storage)?
        else {
            continue;
        };
        if active.host_run_id != run.host_run_id
            || active.run_id != run.run_id
            || active.bootstrap_digest != run.bootstrap_digest
        {
            continue;
        }
        let key = HostKernelWakeKeyV2 {
            session_id: active.session_id.clone(),
            host_run_id: active.host_run_id.clone(),
            run_id: active.run_id.clone(),
            lane: HostKernelWakeLaneV2::Drive,
        };
        if caller_owned_runs.contains(&key)
            || !matches!(
                state
                    .host_services
                    .kernel_operations_v2
                    .caller_drive_recovery_for_run(&active.session_id, &active.host_run_id)
                    .map_err(AgentKernelV2Error::from_storage)?,
                HostRunCallerDriveRecoveryV2::NoDrive
            )
        {
            continue;
        }
        ensure_agent_run_cache_v2(state, &active)?;
        let predecessor = latest_settlement_v2(state, &active)?;
        if !matches!(
            predecessor.settlement,
            HostKernelOperationSettlementV2::Succeeded { .. }
        ) {
            continue;
        }
        let observed_high_water = match continuation_kind_v2(&predecessor) {
            Some("awaitingKernelFacts") => {
                continuation_u64_field_v2(&predecessor, "observedHighWater")?
            }
            Some("awaitingKernelWake") => success_response_v2(&predecessor)?
                .pointer("/state/factsRunSequenceHighWater")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    AgentKernelV2Error::invalid(
                        "session_kernel_facts_high_water_missing",
                        "Recovered Kernel wake has no exact facts run-sequence high-water.",
                    )
                })?,
            _ => continue,
        };
        kernel_wait_operation_v2(&predecessor, observed_high_water)?;
        register_owned_agent_kernel_wait_v2(
            state,
            AgentKernelDriveContextV2::from_state(state),
            AgentKernelFactWaitV2 {
                active,
                predecessor,
                observed_high_water,
            },
        )
        .await?;
    }
    Ok(())
}

async fn cancel_owned_agent_kernel_wait_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
) -> Result<bool, AgentKernelV2Error> {
    cancel_owned_agent_kernel_wait_identity_v2(
        state,
        &active.session_id,
        &active.host_run_id,
        &active.run_id,
    )
    .await
}

async fn cancel_owned_agent_kernel_drive_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
) -> Result<bool, AgentKernelV2Error> {
    state
        .kernel_wake_v2
        .cancel_exact(HostKernelWakeKeyV2 {
            session_id: active.session_id.clone(),
            host_run_id: active.host_run_id.clone(),
            run_id: active.run_id.clone(),
            lane: HostKernelWakeLaneV2::Drive,
        })
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)
}

async fn cancel_owned_agent_kernel_wait_identity_v2(
    state: &AppState,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
) -> Result<bool, AgentKernelV2Error> {
    let drive_cancelled = state
        .kernel_wake_v2
        .cancel_exact(HostKernelWakeKeyV2 {
            session_id: session_id.to_string(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
            lane: HostKernelWakeLaneV2::Drive,
        })
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)?;
    let interrupt_cancelled = state
        .kernel_wake_v2
        .cancel_exact(HostKernelWakeKeyV2 {
            session_id: session_id.to_string(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
            lane: HostKernelWakeLaneV2::Interrupt,
        })
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)?;
    Ok(drive_cancelled || interrupt_cancelled)
}

async fn supersede_pending_user_input_for_cancel_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
) -> Result<(), AgentKernelV2Error> {
    settle_pending_user_input_before_control_v2(
        state,
        active,
        "host_user_input_superseded_by_cancel",
        "The pending user input was superseded by an explicit Run cancellation and was not replayed.",
    )
    .await
}

async fn settle_pending_user_input_before_control_v2(
    state: &AppState,
    active: &HostActiveRunRecordV2,
    failure_code: &str,
    failure_message: &str,
) -> Result<(), AgentKernelV2Error> {
    let Some(binding) = state
        .host_services
        .kernel_operations_v2
        .pending_interrupt_caller(&active.session_id)
        .map_err(AgentKernelV2Error::from_storage)?
    else {
        return Ok(());
    };
    if binding.request_kind == HOST_CANCEL_REQUEST_KIND_V2 {
        return Err(AgentKernelV2Error::invalid(
            "host_interrupt_mailbox_busy",
            "This Session already has a pending durable cancellation.",
        ));
    }
    if binding.request_kind != HOST_USER_INPUT_REQUEST_KIND_V2
        || caller_binding_string_v2(&binding, "hostRunId")? != active.host_run_id
        || caller_binding_string_v2(&binding, "runId")? != active.run_id
    {
        return Err(AgentKernelV2Error::invalid(
            "host_interrupt_mailbox_identity_conflict",
            "The pending Host mutation does not belong to the exact active Run.",
        ));
    }
    let interrupt_owner = host_kernel_interrupt_owner_v2(active, &binding)?;
    let continuation_owner = host_kernel_caller_drive_owner_v2(active, &binding)?;
    let interrupt_cancelled = state
        .kernel_wake_v2
        .cancel_owner_exact(interrupt_owner)
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)?;
    let continuation_cancelled = state
        .kernel_wake_v2
        .cancel_owner_exact(continuation_owner)
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)?;
    if !matches!(
        interrupt_cancelled,
        HostKernelWakeCancelOutcomeV2::Cancelled | HostKernelWakeCancelOutcomeV2::Missing
    ) || !matches!(
        continuation_cancelled,
        HostKernelWakeCancelOutcomeV2::Cancelled | HostKernelWakeCancelOutcomeV2::Missing
    ) {
        return Err(AgentKernelV2Error::invalid(
            "host_interrupt_mailbox_owner_conflict",
            "Cancellation could not acquire the exact pending Host interrupt owner.",
        ));
    }
    let evidence = state
        .host_services
        .kernel_operations_v2
        .caller_control_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if evidence.binding.outcome.is_some() {
        return Ok(());
    }
    let input_id = caller_binding_string_v2(&binding, "inputId")?;
    let input_projected = user_input_is_projected_v2(state, &binding.session_id, &input_id)?;
    let error = AgentKernelV2Error::invalid(failure_code, failure_message);
    settle_caller_error_outcome_v2(
        state,
        &evidence.binding,
        &error,
        input_projected || evidence.first_operation_present || evidence.binding.admission.is_some(),
    )
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
        HostKernelOperationSettlementV2::FailedRecoverable { error_code, .. } => {
            Err(AgentKernelV2Error::invalid(
                "session_kernel_operation_recovery_required",
                format!("Session operation requires recovery: {error_code}"),
            ))
        }
        HostKernelOperationSettlementV2::FailedTerminal { error_code, .. } => {
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

fn continuation_bool_field_v2(
    settlement: &HostKernelOperationSettlementReceiptV2,
    field: &str,
) -> Result<bool, AgentKernelV2Error> {
    continuation_v2(settlement)
        .and_then(|continuation| continuation.get(field))
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_kernel_continuation_invalid",
                format!("Session continuation is missing boolean {field}."),
            )
        })
}

fn required_continuation_work_authority_v2(
    settlement: &HostKernelOperationSettlementReceiptV2,
    field: &str,
) -> Result<SessionWorkAuthorityV3, AgentKernelV2Error> {
    let value = continuation_v2(settlement)
        .and_then(|continuation| continuation.get(field))
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "session_kernel_continuation_invalid",
                format!("Session continuation is missing {field}."),
            )
        })?;
    decode_session_work_authority_v3(value).map_err(|error| {
        AgentKernelV2Error::invalid(
            "session_kernel_continuation_invalid",
            format!(
                "Session continuation has invalid {field}: {}",
                error.message
            ),
        )
    })
}

fn validate_final_answer_continuation_binding_v2(
    settlement: &HostKernelOperationSettlementReceiptV2,
) -> Result<(), AgentKernelV2Error> {
    required_continuation_field_v2(settlement, "inputId")?;
    let control_epoch = continuation_u64_field_v2(settlement, "controlEpoch")?;
    let review_revision = continuation_u64_field_v2(settlement, "reviewRevision")?;
    let snapshot_high_water = continuation_u64_field_v2(settlement, "snapshotHighWater")?;
    if control_epoch == 0
        || control_epoch > 9_007_199_254_740_991
        || review_revision == 0
        || review_revision > 9_007_199_254_740_991
        || snapshot_high_water > 9_007_199_254_740_991
    {
        return Err(AgentKernelV2Error::invalid(
            "session_kernel_continuation_invalid",
            "Final-answer continuation has an invalid epoch, Review revision, or facts high-water.",
        ));
    }
    required_continuation_work_authority_v2(settlement, "workAuthority")?;
    Ok(())
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

fn user_input_admission_receipt_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    host_run_id: String,
) -> Result<AgentKernelUserInputAdmissionReceiptV2, AgentKernelV2Error> {
    if binding.request_kind != HOST_USER_INPUT_REQUEST_KIND_V2
        || caller_binding_string_v2(binding, "hostRunId")? != host_run_id
    {
        return Err(AgentKernelV2Error::invalid(
            "host_user_input_admission_identity_conflict",
            "User-input admission does not match its exact durable caller and Host Run identity.",
        ));
    }
    let admitted_host_run_id = restore_caller_run_admission_v2(binding)?.ok_or_else(|| {
        AgentKernelV2Error::invalid(
            "host_user_input_admission_missing",
            "User-input response cannot be acknowledged without its exact durable input.persisted admission.",
        )
    })?;
    if admitted_host_run_id != host_run_id {
        return Err(AgentKernelV2Error::invalid(
            "host_user_input_admission_identity_conflict",
            "User-input admission is bound to a different durable Host Run identity.",
        ));
    }
    let input_id = caller_binding_string_v2(binding, "inputId")?;
    require_user_input_admission_projection_v2(state, binding)?;
    Ok(AgentKernelUserInputAdmissionReceiptV2 {
        host_run_id,
        input_id,
    })
}

enum CallerDriveAdmissionV2 {
    Acquired(HostCallerRequestBindingReceiptV2),
    Replayed(String),
}

async fn current_owned_user_input_interrupt_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<bool, AgentKernelV2Error> {
    if binding.request_kind != HOST_USER_INPUT_REQUEST_KIND_V2
        || binding.drive_state != HostCallerRequestDriveStateV2::Driving
        || binding.outcome.is_some()
        || binding.drive_owner_instance_id.as_deref()
            != Some(
                state
                    .host_services
                    .active_runs_v2
                    .owner_instance_id()
                    .as_str(),
            )
    {
        return Ok(false);
    }
    let host_run_id = caller_binding_string_v2(binding, "hostRunId")?;
    let Some(active) = state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(&binding.session_id)
        .map_err(AgentKernelV2Error::from_storage)?
        .filter(|active| active.host_run_id == host_run_id)
    else {
        return Ok(false);
    };
    state
        .kernel_wake_v2
        .owns_exact(host_kernel_interrupt_owner_v2(&active, binding)?)
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)
}

async fn claim_user_input_drive_or_restore_v2(
    state: &AppState,
    binding: HostCallerRequestBindingReceiptV2,
) -> Result<CallerDriveAdmissionV2, AgentKernelV2Error> {
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    if let Some(host_run_id) = current_owned_caller_admission_v2(state, &binding).await? {
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
        .claim_caller_request_interrupt_drive(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            &state.host_services.active_runs_v2.owner_instance_id(),
            &crate::utils::now_rfc3339_text(),
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if claim.acquired {
        return Ok(CallerDriveAdmissionV2::Acquired(claim.binding));
    }
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &claim.binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    if let Some(host_run_id) = current_owned_caller_admission_v2(state, &claim.binding).await? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    recover_or_resume_driving_user_input_v2(state, &claim.binding)
        .await
        .map(CallerDriveAdmissionV2::Replayed)
}

async fn claim_cancel_drive_or_restore_v2(
    state: &AppState,
    binding: HostCallerRequestBindingReceiptV2,
) -> Result<CallerDriveAdmissionV2, AgentKernelV2Error> {
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    if binding.drive_state == HostCallerRequestDriveStateV2::Driving {
        return recover_or_resume_driving_cancel_v2(state, &binding)
            .await
            .map(CallerDriveAdmissionV2::Replayed);
    }
    let claim = state
        .host_services
        .kernel_operations_v2
        .claim_caller_request_interrupt_drive(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            &state.host_services.active_runs_v2.owner_instance_id(),
            &crate::utils::now_rfc3339_text(),
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if claim.acquired {
        return Ok(CallerDriveAdmissionV2::Acquired(claim.binding));
    }
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &claim.binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    recover_or_resume_driving_cancel_v2(state, &claim.binding)
        .await
        .map(CallerDriveAdmissionV2::Replayed)
}

async fn claim_caller_drive_or_restore_v2(
    state: &AppState,
    binding: HostCallerRequestBindingReceiptV2,
) -> Result<CallerDriveAdmissionV2, AgentKernelV2Error> {
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    if let Some(host_run_id) = current_owned_caller_admission_v2(state, &binding).await? {
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
            &crate::utils::now_rfc3339_text(),
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if claim.acquired {
        return Ok(CallerDriveAdmissionV2::Acquired(claim.binding));
    }
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &claim.binding)? {
        return Ok(CallerDriveAdmissionV2::Replayed(host_run_id));
    }
    if let Some(host_run_id) = current_owned_caller_admission_v2(state, &claim.binding).await? {
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
        .caller_control_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &evidence.binding)? {
        return Ok(host_run_id);
    }
    let host_run_id = caller_binding_string_v2(&evidence.binding, "hostRunId")?;
    if restore_caller_run_admission_v2(&evidence.binding)?.is_some() {
        require_user_input_admission_projection_v2(state, &evidence.binding)?;
        if evidence.run_lifecycle != Some(HostKernelStoredRunLifecycleV2::Active) {
            // Normal terminal retirement intentionally retains the exact
            // caller drive until its outcome is committed. If the daemon
            // stopped between those commits, recover the bounded terminal Run
            // snapshot and atomically persist the caller outcome + release.
            return recover_driving_caller_request_v2(state, &evidence.binding);
        }
        let active = require_active_agent_kernel_run_v2(
            state,
            &evidence.binding.session_id,
            Some(&host_run_id),
        )?;
        ensure_agent_run_cache_v2(state, &active)?;
        resume_admitted_user_input_drive_v2(state, active, evidence).await?;
        return Ok(host_run_id);
    }
    let input_id = caller_binding_string_v2(&evidence.binding, "inputId")?;
    let input_projected =
        user_input_is_projected_v2(state, &evidence.binding.session_id, &input_id)?;
    if input_projected && evidence.first_operation_present {
        let error = AgentKernelV2Error::invalid(
            "host_caller_request_indeterminate",
            "The user input was durably projected without a durable Run-drive transfer admission; automatic success recovery is unsafe.",
        );
        settle_caller_error_outcome_v2(state, &evidence.binding, &error, true)?;
        return Err(error);
    }
    let current_owner_instance_id = state.host_services.active_runs_v2.owner_instance_id();
    if evidence.binding.drive_owner_instance_id.as_deref()
        == Some(current_owner_instance_id.as_str())
    {
        if let Some(active) = state
            .host_services
            .active_runs_v2
            .resolve_session_active_run(&evidence.binding.session_id)
            .map_err(AgentKernelV2Error::from_storage)?
            .filter(|active| active.host_run_id == host_run_id)
        {
            let owner = host_kernel_interrupt_owner_v2(&active, &evidence.binding)?;
            if state
                .kernel_wake_v2
                .owns_exact(owner)
                .await
                .map_err(AgentKernelV2Error::from_wake_supervisor)?
            {
                return Err(AgentKernelV2Error::invalid(
                    "host_caller_request_in_progress",
                    "The exact user-input request is still being driven by this Host instance; retry with the same callerRequestId to query its durable outcome.",
                ));
            }
        }
    }
    let indeterminate = evidence.first_operation_present;
    let error = AgentKernelV2Error::invalid(
        if indeterminate {
            "host_caller_request_indeterminate"
        } else {
            "host_caller_request_admission_incomplete"
        },
        if input_projected {
            "A prior Host instance durably persisted the user input but ended without a recoverable caller-correlated Session settlement; the request was not replayed."
        } else if indeterminate {
            "A prior Host instance ended after caller-correlated user-input dispatch but before durable input.persisted admission; the request was not replayed."
        } else {
            "A prior Host instance ended before this user input reached durable input.persisted admission; submit a new caller request."
        },
    );
    settle_caller_error_outcome_v2(state, &evidence.binding, &error, indeterminate)?;
    Err(error)
}

async fn resume_admitted_user_input_drive_v2(
    state: &AppState,
    active: HostActiveRunRecordV2,
    evidence: HostCallerRequestRecoveryEvidenceV2,
) -> Result<(), AgentKernelV2Error> {
    let current_owner_instance_id = state.host_services.active_runs_v2.owner_instance_id();
    let first_operation_pending = evidence.first_operation_pending;
    let evidence_binding = evidence.binding;
    let binding = if evidence_binding.drive_owner_instance_id.as_deref()
        == Some(current_owner_instance_id.as_str())
    {
        evidence_binding
    } else {
        state
            .host_services
            .kernel_operations_v2
            .reclaim_admitted_caller_request_drive(
                &evidence_binding,
                &current_owner_instance_id,
                &crate::utils::now_rfc3339_text(),
            )
            .map_err(AgentKernelV2Error::from_storage)?
    };
    if first_operation_pending {
        let error = AgentKernelV2Error::invalid(
            "host_caller_request_indeterminate",
            "The admitted user-input dispatch has an unresolved Session operation; automatic replay is unsafe.",
        );
        settle_caller_error_outcome_v2(state, &binding, &error, true)?;
        return Err(error);
    }
    let input = durable_user_input_from_binding_v2(&binding)?;
    validate_active_run_attachment_binding_v2(state, &active, &input.attachments)?;
    let operation_request_id = caller_binding_string_v2(&binding, "operationRequestId")?;
    let owner = host_kernel_caller_drive_owner_v2(&active, &binding)?;
    let owner_for_drive = owner.clone();
    let background_state = state.clone();
    let background_active = active.clone();
    let background_binding = binding.clone();
    let outcome = state
        .kernel_wake_v2
        .register_exclusive(owner, async move {
            let result = execute_bound_user_input_v2(
                &background_state,
                &background_active,
                &background_binding,
                input,
                &operation_request_id,
            )
            .await;
            finish_owned_caller_drive_v2(
                &background_state,
                &background_active,
                &background_binding,
                owner_for_drive,
                result,
            )
            .await;
        })
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)?;
    match outcome {
        HostKernelWakeRegisterOutcomeV2::Registered
        | HostKernelWakeRegisterOutcomeV2::AlreadyExact => Ok(()),
        HostKernelWakeRegisterOutcomeV2::OwnerConflict => Err(AgentKernelV2Error::invalid(
            "host_kernel_caller_restore_owner_conflict",
            "The admitted user-input caller could not restore its exact live Run owner.",
        )),
    }
}

async fn recover_or_resume_driving_cancel_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<String, AgentKernelV2Error> {
    let host_run_id = caller_binding_string_v2(binding, "hostRunId")?;
    let run_id = caller_binding_string_v2(binding, "runId")?;
    let preflight_active = match state
        .host_services
        .active_runs_v2
        .resolve(&binding.session_id, &host_run_id)
    {
        Ok(active) => {
            if active.run_id != run_id {
                return fail_driving_cancel_v2(
                    state,
                    binding,
                    &active.host_run_id,
                    &active.run_id,
                    AgentKernelV2Error::invalid(
                        "host_caller_request_run_conflict",
                        "Durable cancellation identity does not match its exact active Host Run.",
                    ),
                )
                .await;
            }
            Some(active)
        }
        Err(error)
            if matches!(
                error.code,
                "host_active_run_not_found" | "host_active_run_retiring"
            ) =>
        {
            None
        }
        Err(error) => {
            return fail_driving_cancel_v2(
                state,
                binding,
                &host_run_id,
                &run_id,
                AgentKernelV2Error::from_storage(error),
            )
            .await;
        }
    };
    let evidence = match state
        .host_services
        .kernel_operations_v2
        .caller_control_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        ) {
        Ok(evidence) => evidence,
        Err(error) => {
            let error = AgentKernelV2Error::from_storage(error);
            if let Some(active) = preflight_active.as_ref() {
                return fail_driving_cancel_v2(
                    state,
                    binding,
                    &active.host_run_id,
                    &active.run_id,
                    error,
                )
                .await;
            }
            return Err(error);
        }
    };
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &evidence.binding)? {
        return Ok(host_run_id);
    }
    if evidence.binding.request_kind != HOST_CANCEL_REQUEST_KIND_V2
        || evidence.binding.drive_state != HostCallerRequestDriveStateV2::Driving
    {
        let error = AgentKernelV2Error::invalid(
            "host_caller_request_indeterminate",
            recovery_indeterminate_message_v2(&evidence),
        );
        if evidence.run_lifecycle == Some(HostKernelStoredRunLifecycleV2::Active) {
            return fail_driving_cancel_v2(state, &evidence.binding, &host_run_id, &run_id, error)
                .await;
        }
        settle_caller_error_outcome_v2(state, &evidence.binding, &error, true)?;
        return Err(error);
    }
    if evidence.run_lifecycle != Some(HostKernelStoredRunLifecycleV2::Active) {
        if let Some(run) = recovered_run_snapshot_v2(&evidence)? {
            let host_run_id = run.run_id.clone();
            settle_caller_run_snapshot_v2(state, &evidence.binding, run)?;
            return Ok(host_run_id);
        }
        let error = AgentKernelV2Error::invalid(
            "host_caller_request_indeterminate",
            recovery_indeterminate_message_v2(&evidence),
        );
        settle_caller_error_outcome_v2(state, &evidence.binding, &error, true)?;
        return Err(error);
    }
    if evidence.first_operation_pending {
        return fail_driving_cancel_v2(
            state,
            &evidence.binding,
            &host_run_id,
            &run_id,
            AgentKernelV2Error::invalid(
                "host_caller_request_indeterminate",
                "The exact cancellation has an unresolved Session dispatch; automatic redispatch is unsafe.",
            ),
        )
        .await;
    }
    let cancel_operation_id = match caller_binding_string_v2(&evidence.binding, "cancelOperationId")
    {
        Ok(cancel_operation_id) => cancel_operation_id,
        Err(error) => {
            return fail_driving_cancel_v2(state, &evidence.binding, &host_run_id, &run_id, error)
                .await;
        }
    };
    let operation_request_id =
        match caller_binding_string_v2(&evidence.binding, "operationRequestId") {
            Ok(operation_request_id) => operation_request_id,
            Err(error) => {
                return fail_driving_cancel_v2(
                    state,
                    &evidence.binding,
                    &host_run_id,
                    &run_id,
                    error,
                )
                .await;
            }
        };
    if operation_request_id != cancel_operation_id {
        return fail_driving_cancel_v2(
            state,
            &evidence.binding,
            &host_run_id,
            &run_id,
            AgentKernelV2Error::invalid(
                "host_caller_request_operation_conflict",
                "Durable cancellation operation identities do not match.",
            ),
        )
        .await;
    }
    let active = match require_active_agent_kernel_run_v2(
        state,
        &evidence.binding.session_id,
        Some(&run_id),
    ) {
        Ok(active) => active,
        Err(error) => {
            return fail_driving_cancel_v2(state, &evidence.binding, &host_run_id, &run_id, error)
                .await;
        }
    };
    if active.host_run_id != host_run_id || active.run_id != run_id {
        return fail_driving_cancel_v2(
            state,
            &evidence.binding,
            &host_run_id,
            &run_id,
            AgentKernelV2Error::invalid(
                "host_caller_request_run_conflict",
                "Durable cancellation is bound to a different active Run.",
            ),
        )
        .await;
    }
    if let Err(error) = ensure_agent_run_cache_v2(state, &active) {
        return fail_driving_cancel_v2(state, &evidence.binding, &host_run_id, &run_id, error)
            .await;
    }
    if let Err(error) = cancel_owned_agent_kernel_wait_v2(state, &active).await {
        return fail_driving_cancel_v2(state, &evidence.binding, &host_run_id, &run_id, error)
            .await;
    }
    if let Err(error) = state
        .kernel_session_v2
        .cancel_run_for_caller(
            &evidence.binding.session_id,
            &host_run_id,
            &run_id,
            &evidence.binding.caller_request_id,
            &evidence.binding.request_digest,
            &cancel_operation_id,
        )
        .await
        .map_err(AgentKernelV2Error::from_storage)
    {
        return fail_driving_cancel_v2(state, &evidence.binding, &host_run_id, &run_id, error)
            .await;
    }
    mark_agent_run_v2(
        state,
        &host_run_id,
        "cancelled",
        Some(
            "Kernel–Session v2 Run cancellation was recovered from canonical Session evidence."
                .to_string(),
        ),
    );
    settle_caller_run_outcome_v2(state, &evidence.binding, &host_run_id)?;
    Ok(host_run_id)
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
    if evidence.binding.admission.is_none()
        && evidence.binding.drive_owner_instance_id.as_deref()
            == Some(
                state
                    .host_services
                    .active_runs_v2
                    .owner_instance_id()
                    .as_str(),
            )
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_in_progress",
            "The exact caller request is still establishing durable admission in this Host instance.",
        ));
    }
    if evidence.run_lifecycle == Some(HostKernelStoredRunLifecycleV2::Retired) {
        if let Some(HostKernelOperationSettlementReceiptV2 {
            settlement: HostKernelOperationSettlementV2::FailedTerminal { error_code, .. },
            ..
        }) = evidence.latest_settlement.as_ref()
        {
            let error = AgentKernelV2Error::invalid(
                error_code.clone(),
                "Session reported a terminal operation failure.",
            );
            settle_caller_error_outcome_v2(state, &evidence.binding, &error, false)?;
            return Err(error);
        }
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

fn recover_driving_run_open_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<String, AgentKernelV2Error> {
    if binding.request_kind != HOST_RUN_OPEN_REQUEST_KIND_V2 {
        return Err(AgentKernelV2Error::invalid(
            "host_run_open_recovery_kind_conflict",
            "RunOpen recovery requires an exact RunOpen caller binding.",
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
    if let Some(host_run_id) = restore_caller_run_outcome_v2(state, &evidence.binding)? {
        return Ok(host_run_id);
    }
    let host_run_id = caller_binding_string_v2(&evidence.binding, "hostRunId")?;
    let input_id = caller_binding_string_v2(&evidence.binding, "inputId")?;
    if user_input_is_projected_v2(state, &evidence.binding.session_id, &input_id)? {
        let active = require_active_agent_kernel_run_v2(
            state,
            &evidence.binding.session_id,
            Some(&host_run_id),
        )?;
        ensure_agent_run_cache_v2(state, &active)?;
        settle_caller_run_outcome_v2(state, &evidence.binding, &host_run_id)?;
        return Ok(host_run_id);
    }
    let dispatched = evidence.first_operation_present;
    let error = AgentKernelV2Error::invalid(
        if dispatched {
            "host_run_open_admission_indeterminate"
        } else {
            "host_run_open_admission_incomplete"
        },
        if dispatched {
            "RunOpen dispatched its initial Session operation but ended before exact input.persisted admission; the request was not replayed."
        } else {
            "RunOpen ended before dispatching its initial Session operation or persisting exact input.persisted admission."
        },
    );
    settle_caller_error_outcome_v2(state, &evidence.binding, &error, dispatched)?;
    Err(error)
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
        let canonical_cancellation = cancel_settlement_matches_binding_v2(evidence)?;
        return Ok((caused_retirement && canonical_cancellation).then(|| {
            recovered_agent_run_state_v2(
                evidence,
                host_run_id,
                "cancelled",
                "Recovered exact caller-correlated cancellation.",
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
            HostKernelOperationSettlementV2::FailedRecoverable { error_code, .. },
            _,
        ) => Ok(Some(recovered_agent_run_state_v2(
            evidence,
            host_run_id,
            "waiting",
            &format!("Recovered operation requires recovery: {error_code}"),
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
        ))),
        (
            Some(HostKernelStoredRunLifecycleV2::Retired),
            HostKernelOperationSettlementV2::FailedTerminal { error_code, .. },
            _,
        ) => Ok(Some(recovered_agent_run_state_v2(
            evidence,
            host_run_id,
            "failed",
            &format!("Recovered terminal Session failure: {error_code}"),
        ))),
        (
            Some(HostKernelStoredRunLifecycleV2::Retired),
            HostKernelOperationSettlementV2::Succeeded { .. },
            Some("terminalProviderAnswer" | "terminalProviderStop" | "terminalFinalAnswer"),
        ) => Ok(Some(recovered_agent_run_state_v2(
            evidence,
            host_run_id,
            "completed",
            "Recovered terminal Session result from durable settlement and retirement.",
        ))),
        (
            Some(HostKernelStoredRunLifecycleV2::Retired),
            HostKernelOperationSettlementV2::Succeeded { .. },
            Some("terminalFinalAnswerFailed"),
        ) => Ok(Some(recovered_agent_run_state_v2(
            evidence,
            host_run_id,
            "failed",
            "Recovered terminal final-answer failure from durable settlement and retirement.",
        ))),
        _ => Ok(None),
    }
}

fn cancel_settlement_matches_binding_v2(
    evidence: &HostCallerRequestRecoveryEvidenceV2,
) -> Result<bool, AgentKernelV2Error> {
    let Some(settlement) = evidence.first_settlement.as_ref() else {
        return Ok(false);
    };
    let operation_request_id = caller_binding_string_v2(&evidence.binding, "operationRequestId")?;
    let cancel_operation_id = caller_binding_string_v2(&evidence.binding, "cancelOperationId")?;
    if operation_request_id != cancel_operation_id
        || settlement.operation_request_id != operation_request_id
        || continuation_kind_v2(settlement) != Some("terminalRunCancelled")
    {
        return Ok(false);
    }
    let HostKernelOperationSettlementV2::Succeeded { response, .. } = &settlement.settlement else {
        return Ok(false);
    };
    let outcome = response.get("outcome");
    let facts = outcome.and_then(|value| value.get("facts"));
    let projection = outcome.and_then(|value| value.get("projection"));
    Ok(
        response.get("operationKind").and_then(Value::as_str) == Some("cancelRun")
            && outcome
                .and_then(|value| value.get("kind"))
                .and_then(Value::as_str)
                == Some("runCancelled")
            && outcome
                .and_then(|value| value.get("callerRequestId"))
                .and_then(Value::as_str)
                == Some(evidence.binding.caller_request_id.as_str())
            && outcome
                .and_then(|value| value.get("callerRequestDigest"))
                .and_then(Value::as_str)
                == Some(evidence.binding.request_digest.as_str())
            && outcome
                .and_then(|value| value.get("cancelOperationId"))
                .and_then(Value::as_str)
                == Some(cancel_operation_id.as_str())
            && facts
                .and_then(|value| value.get("caughtUp"))
                .and_then(Value::as_bool)
                == Some(true)
            && facts
                .and_then(|value| value.get("pendingFactBarrierCount"))
                .and_then(Value::as_u64)
                == Some(0)
            && projection
                .and_then(|value| value.get("projectionId"))
                .and_then(Value::as_str)
                .is_some()
            && projection
                .and_then(|value| value.get("projectionDigest"))
                .and_then(Value::as_str)
                .is_some(),
    )
}

fn recovered_agent_run_state_v2(
    evidence: &HostCallerRequestRecoveryEvidenceV2,
    host_run_id: String,
    status: &str,
    message: &str,
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
        kernel_run_id: evidence.kernel_run_id.clone(),
        session_id: evidence.binding.session_id.clone(),
        profile_id: evidence.provider_profile_id.clone(),
        status: status.to_string(),
        start_event_count: 0,
        started_at,
        updated_at: updated_at.clone(),
        completed_at: matches!(status, "completed" | "failed" | "cancelled").then_some(updated_at),
        message: Some(message.to_string()),
    }
}

fn recovery_indeterminate_message_v2(evidence: &HostCallerRequestRecoveryEvidenceV2) -> String {
    format!(
        "The exact {} caller request crossed its durable drive boundary, but its bounded operation/retirement evidence cannot prove a replay-safe response.",
        evidence.binding.request_kind
    )
}

fn exact_agent_run_admission_v2(
    state: &AppState,
    session_id: &str,
    host_run_id: &str,
    input_id: &str,
) -> Result<AgentKernelRunAdmissionV2, AgentKernelV2Error> {
    let kernel_run_id = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.get(host_run_id)
            .filter(|run| run.session_id == session_id)
            .and_then(|run| run.kernel_run_id.clone())
    };
    if let Some(kernel_run_id) = kernel_run_id {
        return Ok(AgentKernelRunAdmissionV2 {
            host_run_id: host_run_id.to_string(),
            kernel_run_id,
            input_id: input_id.to_string(),
        });
    }
    let active = state
        .host_services
        .active_runs_v2
        .resolve(session_id, host_run_id)
        .map_err(AgentKernelV2Error::from_storage)?;
    ensure_agent_run_cache_v2(state, &active)?;
    bind_agent_run_kernel_identity_v2(state, session_id, host_run_id, &active.run_id)?;
    Ok(AgentKernelRunAdmissionV2 {
        host_run_id: host_run_id.to_string(),
        kernel_run_id: active.run_id,
        input_id: input_id.to_string(),
    })
}

async fn current_owned_open_admission_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<Option<AgentKernelRunAdmissionV2>, AgentKernelV2Error> {
    let current_owner_instance_id = state.host_services.active_runs_v2.owner_instance_id();
    if binding.request_kind != HOST_RUN_OPEN_REQUEST_KIND_V2
        || binding.drive_state != HostCallerRequestDriveStateV2::Driving
        || binding.drive_owner_instance_id.as_deref() != Some(current_owner_instance_id.as_str())
    {
        return Ok(None);
    }
    let host_run_id = caller_binding_string_v2(binding, "hostRunId")?;
    let Some(active) = state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(&binding.session_id)
        .map_err(AgentKernelV2Error::from_storage)?
    else {
        return Ok(None);
    };
    if active.host_run_id != host_run_id {
        return Ok(None);
    }
    state
        .host_services
        .kernel_operations_v2
        .live_run_has_supported_history_schema(&binding.session_id, &host_run_id)
        .map_err(AgentKernelV2Error::from_storage)?;
    require_initial_input_projection_v2(state, binding)?;
    let operation_request_id = caller_binding_string_v2(binding, "operationRequestId")?;
    let owner = host_kernel_initial_drive_owner_v2(&active, binding, &operation_request_id)?;
    if !state
        .kernel_wake_v2
        .owns_exact(owner)
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)?
    {
        return Ok(None);
    }
    ensure_agent_run_cache_v2(state, &active)?;
    bind_agent_run_kernel_identity_v2(state, &binding.session_id, &host_run_id, &active.run_id)?;
    Ok(Some(AgentKernelRunAdmissionV2 {
        host_run_id,
        kernel_run_id: active.run_id,
        input_id: caller_binding_string_v2(binding, "inputId")?,
    }))
}

async fn current_owned_caller_admission_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<Option<String>, AgentKernelV2Error> {
    let Some(host_run_id) = restore_caller_run_admission_v2(binding)? else {
        return Ok(None);
    };
    if !matches!(
        binding.request_kind.as_str(),
        HOST_DECISION_REQUEST_KIND_V2 | HOST_USER_INPUT_REQUEST_KIND_V2
    ) {
        return Ok(None);
    }
    let current_owner_instance_id = state.host_services.active_runs_v2.owner_instance_id();
    if binding.drive_state != HostCallerRequestDriveStateV2::Driving
        || binding.drive_owner_instance_id.as_deref() != Some(current_owner_instance_id.as_str())
    {
        return Ok(None);
    }
    let Some(active) = state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(&binding.session_id)
        .map_err(AgentKernelV2Error::from_storage)?
    else {
        return Ok(None);
    };
    if active.host_run_id != host_run_id
        || active.run_id != caller_binding_string_v2(binding, "runId")?
    {
        return Ok(None);
    }
    state
        .host_services
        .kernel_operations_v2
        .live_run_has_supported_history_schema(&binding.session_id, &host_run_id)
        .map_err(AgentKernelV2Error::from_storage)?;
    if binding.request_kind == HOST_USER_INPUT_REQUEST_KIND_V2 {
        require_user_input_admission_projection_v2(state, binding)?;
    }
    let owner = host_kernel_caller_drive_owner_v2(&active, binding)?;
    if !state
        .kernel_wake_v2
        .owns_exact(owner)
        .await
        .map_err(AgentKernelV2Error::from_wake_supervisor)?
    {
        return Ok(None);
    }
    ensure_agent_run_cache_v2(state, &active)?;
    Ok(Some(host_run_id))
}

fn restore_caller_run_admission_v2(
    binding: &HostCallerRequestBindingReceiptV2,
) -> Result<Option<String>, AgentKernelV2Error> {
    let Some(admission) = binding.admission.as_ref() else {
        return Ok(None);
    };
    if admission.get("schemaVersion").and_then(Value::as_str)
        != Some(HOST_CALLER_RUN_ADMISSION_SCHEMA_V2)
    {
        return Err(AgentKernelV2Error::invalid(
            "UnsupportedHistorySchema",
            "Durable Host caller request uses an unsupported admission schema; old live admission semantics are not decoded.",
        ));
    }
    let required = |field: &'static str| {
        admission
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AgentKernelV2Error::invalid(
                    "host_caller_request_admission_invalid",
                    format!("Durable Host caller admission is missing exact {field}."),
                )
            })
    };
    let host_run_id = required("hostRunId")?;
    required("ownerDigest")?;
    let admission_boundary = required("admissionBoundary")?;
    match binding.request_kind.as_str() {
        HOST_USER_INPUT_REQUEST_KIND_V2 => {
            if admission_boundary != "input.persisted"
                || required("inputId")? != caller_binding_string_v2(binding, "inputId")?
            {
                return Err(AgentKernelV2Error::invalid(
                    "host_caller_request_admission_conflict",
                    "Durable user-input admission does not bind its exact input.persisted boundary.",
                ));
            }
        }
        HOST_DECISION_REQUEST_KIND_V2 => {
            if admission_boundary != "decision.admitted" || admission.get("inputId").is_some() {
                return Err(AgentKernelV2Error::invalid(
                    "host_caller_request_admission_conflict",
                    "Durable decision admission has an invalid boundary or user-input identity.",
                ));
            }
        }
        _ => {
            return Err(AgentKernelV2Error::invalid(
                "host_caller_request_admission_kind_conflict",
                "Durable ordinary caller admission belongs to an unsupported request kind.",
            ))
        }
    }
    if required("sessionId")? != binding.session_id
        || host_run_id != caller_binding_string_v2(binding, "hostRunId")?
        || required("runId")? != caller_binding_string_v2(binding, "runId")?
        || required("callerRequestId")? != binding.caller_request_id
        || required("requestDigest")? != binding.request_digest
        || binding.admission_digest.is_none()
        || binding.admitted_at.is_none()
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_admission_conflict",
            "Durable Host caller admission does not match its immutable request identity.",
        ));
    }
    Ok(Some(host_run_id.to_string()))
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
    let run = reconcile_replayed_run_open_outcome_v2(state, binding, run)?;
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

fn reconcile_replayed_run_open_outcome_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    run: AgentRunState,
) -> Result<AgentRunState, AgentKernelV2Error> {
    if binding.request_kind != HOST_RUN_OPEN_REQUEST_KIND_V2
        || matches!(run.status.as_str(), "completed" | "failed" | "cancelled")
    {
        return Ok(run);
    }
    let evidence = state
        .host_services
        .kernel_operations_v2
        // A retired Run no longer has live drive ownership. Terminal replay still
        // validates the immutable caller, Run, and first-operation correlations.
        .caller_control_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    let Some(mut recovered) = recovered_run_snapshot_v2(&evidence)? else {
        return Ok(run);
    };
    if !matches!(
        recovered.status.as_str(),
        "completed" | "failed" | "cancelled"
    ) {
        return Ok(run);
    }
    if recovered.run_id != run.run_id
        || recovered.session_id != run.session_id
        || recovered.kernel_run_id != run.kernel_run_id
        || (recovered.profile_id.is_some()
            && run.profile_id.is_some()
            && recovered.profile_id != run.profile_id)
    {
        return Err(AgentKernelV2Error::invalid(
            "host_caller_request_outcome_conflict",
            "Recovered terminal Run state conflicts with the immutable caller outcome identity.",
        ));
    }
    recovered.start_event_count = run.start_event_count;
    if run.profile_id.is_some() {
        recovered.profile_id = run.profile_id;
    }
    Ok(recovered)
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
    let operation_store = &state.host_services.kernel_operations_v2;
    let evidence = if matches!(
        binding.request_kind.as_str(),
        HOST_CANCEL_REQUEST_KIND_V2 | HOST_USER_INPUT_REQUEST_KIND_V2
    ) {
        operation_store.caller_control_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        )
    } else {
        operation_store.caller_request_recovery_evidence(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
        )
    }
    .map_err(AgentKernelV2Error::from_storage)?;
    let first_operation = evidence
        .first_settlement
        .as_ref()
        .map(|settlement| {
            json!({
                "operationRequestId": settlement.operation_request_id,
                "settlementDigest": settlement.settlement_digest,
            })
        })
        .or_else(|| {
            (binding.request_kind == HOST_USER_INPUT_REQUEST_KIND_V2
                && evidence.first_operation_present)
                .then(|| {
                    json!({
                        "operationRequestId": binding.response_identity
                            .get("operationRequestId")
                            .and_then(Value::as_str),
                        "settlementDigest": null,
                    })
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
    persist_caller_outcome_v2(
        state,
        binding,
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
    )?;
    Ok(())
}

fn settle_caller_error_outcome_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    error: &AgentKernelV2Error,
    indeterminate: bool,
) -> Result<(), AgentKernelV2Error> {
    persist_caller_outcome_v2(
        state,
        binding,
        json!({
            "schemaVersion": HOST_CALLER_RUN_OUTCOME_SCHEMA_V2,
            "disposition": if indeterminate { "indeterminate" } else { "failed" },
            "hostRunId": caller_binding_string_v2(binding, "hostRunId")?,
            "error": {
                "code": error.code,
                "message": error.message,
            },
        }),
    )?;
    Ok(())
}

fn abandon_unadmitted_caller_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    error: &AgentKernelV2Error,
) -> Result<(), AgentKernelV2Error> {
    let owner_instance_id = binding.drive_owner_instance_id.as_deref().ok_or_else(|| {
        AgentKernelV2Error::invalid(
            "host_caller_request_owner_missing",
            "Unadmitted caller abandonment requires its exact owner instance.",
        )
    })?;
    state
        .host_services
        .kernel_operations_v2
        .settle_unadmitted_owned_caller_request(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            owner_instance_id,
            json!({
                "schemaVersion": HOST_CALLER_RUN_OUTCOME_SCHEMA_V2,
                "disposition": "failed",
                "hostRunId": caller_binding_string_v2(binding, "hostRunId")?,
                "error": {
                    "code": error.code,
                    "message": error.message,
                },
            }),
            crate::utils::now_rfc3339_text(),
        )
        .map_err(AgentKernelV2Error::from_storage)?;
    Ok(())
}

fn persist_caller_outcome_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    outcome: Value,
) -> Result<(), AgentKernelV2Error> {
    let store = &state.host_services.kernel_operations_v2;
    match (
        binding.drive_owner_instance_id.as_deref(),
        binding.admission_digest.as_deref(),
    ) {
        (Some(owner_instance_id), Some(admission_digest)) => store.settle_owned_caller_request(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            owner_instance_id,
            admission_digest,
            outcome,
            crate::utils::now_rfc3339_text(),
        ),
        (Some(owner_instance_id), None)
            if binding.drive_state == HostCallerRequestDriveStateV2::Driving =>
        {
            match outcome.get("disposition").and_then(Value::as_str) {
                Some("indeterminate") if binding.request_kind == HOST_CANCEL_REQUEST_KIND_V2 => {
                    store.settle_unadmitted_owned_cancel_indeterminate(
                        &binding.session_id,
                        &binding.caller_request_id,
                        &binding.request_kind,
                        &binding.request_digest,
                        owner_instance_id,
                        outcome,
                        crate::utils::now_rfc3339_text(),
                    )
                }
                Some("indeterminate") => store.settle_unadmitted_owned_caller_indeterminate(
                    &binding.session_id,
                    &binding.caller_request_id,
                    &binding.request_kind,
                    &binding.request_digest,
                    owner_instance_id,
                    outcome,
                    crate::utils::now_rfc3339_text(),
                ),
                Some("succeeded") if binding.request_kind == HOST_CANCEL_REQUEST_KIND_V2 => store
                    .settle_unadmitted_owned_cancel_success(
                        &binding.session_id,
                        &binding.caller_request_id,
                        &binding.request_kind,
                        &binding.request_digest,
                        owner_instance_id,
                        outcome,
                        crate::utils::now_rfc3339_text(),
                    ),
                Some("succeeded") if binding.request_kind == HOST_USER_INPUT_REQUEST_KIND_V2 => {
                    Err(crate::host_v2_storage::HostV2StorageError::conflict(
                        "host_caller_request_user_input_admission_missing",
                        "User-input success requires durable Run-drive transfer admission",
                    ))
                }
                Some("succeeded") => store.settle_unadmitted_owned_run_open_success(
                    &binding.session_id,
                    &binding.caller_request_id,
                    &binding.request_kind,
                    &binding.request_digest,
                    owner_instance_id,
                    outcome,
                    crate::utils::now_rfc3339_text(),
                ),
                Some("failed") if binding.request_kind == HOST_USER_INPUT_REQUEST_KIND_V2 => store
                    .settle_unadmitted_owned_user_input_failure(
                        &binding.session_id,
                        &binding.caller_request_id,
                        &binding.request_kind,
                        &binding.request_digest,
                        owner_instance_id,
                        outcome,
                        crate::utils::now_rfc3339_text(),
                    ),
                Some("failed") => store.settle_unadmitted_owned_caller_request(
                    &binding.session_id,
                    &binding.caller_request_id,
                    &binding.request_kind,
                    &binding.request_digest,
                    owner_instance_id,
                    outcome,
                    crate::utils::now_rfc3339_text(),
                ),
                _ => Err(crate::host_v2_storage::HostV2StorageError::invalid(
                    "host_caller_request_outcome_disposition_invalid",
                    "Unadmitted caller outcome has no supported disposition",
                )),
            }
        }
        _ => store.settle_caller_request(
            &binding.session_id,
            &binding.caller_request_id,
            &binding.request_kind,
            &binding.request_digest,
            outcome,
            crate::utils::now_rfc3339_text(),
        ),
    }
    .map_err(AgentKernelV2Error::from_storage)?;
    Ok(())
}

async fn safety_retire_failed_cancel_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    host_run_id: &str,
    run_id: &str,
    cancellation_error: AgentKernelV2Error,
) -> Result<AgentKernelV2Error, AgentKernelV2Error> {
    let retirement = state
        .kernel_session_v2
        .safety_retire_cancel_run(&binding.session_id, host_run_id, run_id)
        .await;
    let final_error = match &retirement {
        Ok(_) => cancellation_error,
        Err(retirement_error) => AgentKernelV2Error::invalid(
            "host_kernel_cancel_safety_retirement_pending",
            format!(
                "Cancellation became indeterminate after {}; run-wide safety retirement remains pending after {}",
                cancellation_error.code, retirement_error.code
            ),
        ),
    };
    mark_agent_run_v2(
        state,
        host_run_id,
        "failed",
        Some(format!(
            "Run cancellation is indeterminate and cannot be reported as cancelled: {}",
            final_error.message
        )),
    );
    if retirement.is_ok() {
        settle_caller_error_outcome_v2(state, binding, &final_error, true)?;
    }
    Ok(final_error)
}

async fn fail_driving_cancel_v2(
    state: &AppState,
    binding: &HostCallerRequestBindingReceiptV2,
    host_run_id: &str,
    run_id: &str,
    error: AgentKernelV2Error,
) -> Result<String, AgentKernelV2Error> {
    Err(safety_retire_failed_cancel_v2(state, binding, host_run_id, run_id, error).await?)
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
                        && profile_reasoning_transport_is_compatible(profile)
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
    if state
        .provider_trace_v1
        .profile_revision_is_unavailable(profile_id, &revision_digest)
        .map_err(|error| {
            AgentKernelV2Error::invalid(
                error.code,
                "Provider Profile availability could not be verified for Run bootstrap.",
            )
        })?
    {
        return Err(AgentKernelV2Error::invalid(
            "llm_profile_revision_unavailable",
            "Selected LLM Profile revision is unavailable until the user explicitly re-enables it or saves a new revision.",
        ));
    }
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
    let reasoning_transport = profile
        .get("reasoningTransport")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AgentKernelV2Error::invalid(
                "llm_profile_reasoning_transport_invalid",
                "Selected LLM Profile requires a compatible reasoningTransport.",
            )
        })?;
    HostProviderProfileBootstrapV2::new(
        profile_id.to_string(),
        revision_digest,
        reasoning_transport.to_string(),
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

fn bind_agent_run_kernel_identity_v2(
    state: &AppState,
    session_id: &str,
    host_run_id: &str,
    kernel_run_id: &str,
) -> Result<(), AgentKernelV2Error> {
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let run = runs.get_mut(host_run_id).ok_or_else(|| {
        AgentKernelV2Error::invalid(
            "agent_run_cache_missing",
            "Host Run cache disappeared before its Kernel Run identity was bound.",
        )
    })?;
    if run.session_id != session_id {
        return Err(AgentKernelV2Error::invalid(
            "agent_run_session_identity_conflict",
            "Host Run cache belongs to another Session.",
        ));
    }
    match run.kernel_run_id.as_deref() {
        Some(existing) if existing != kernel_run_id => Err(AgentKernelV2Error::invalid(
            "agent_run_kernel_identity_conflict",
            "Host Run cache is already bound to another Kernel Run.",
        )),
        Some(_) => Ok(()),
        None => {
            run.kernel_run_id = Some(kernel_run_id.to_string());
            Ok(())
        }
    }
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
            kernel_run_id: Some(active.run_id.clone()),
            session_id: active.session_id.clone(),
            profile_id: Some(bootstrap.provider_profile.provider_profile_id),
            status: "waiting".to_string(),
            start_event_count: events.len(),
            started_at: active.recorded_at.clone(),
            updated_at: now_text(),
            completed_at: None,
            message: Some("Recovered durable Kernel–Session v2 Run.".to_string()),
        },
    );
    Ok(())
}

fn mark_agent_run_v2(state: &AppState, host_run_id: &str, status: &str, message: Option<String>) {
    mark_agent_run_state_v2(&state.session_runs, host_run_id, status, message);
}

fn mark_agent_drive_v2(
    context: &AgentKernelDriveContextV2,
    host_run_id: &str,
    status: &str,
    message: Option<String>,
) {
    mark_agent_run_state_v2(&context.session_runs, host_run_id, status, message);
}

fn mark_agent_run_state_v2(
    session_runs: &Arc<Mutex<HashMap<String, AgentRunState>>>,
    host_run_id: &str,
    status: &str,
    message: Option<String>,
) {
    let mut runs = session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(host_run_id) else {
        return;
    };
    let terminal_transition_allowed = run.status == "failed" && status == "cancelled";
    if matches!(run.status.as_str(), "completed" | "failed" | "cancelled")
        && run.status != status
        && !terminal_transition_allowed
    {
        return;
    }
    run.status = status.to_string();
    run.updated_at = now_text();
    run.message = message;
    run.completed_at =
        matches!(status, "completed" | "failed" | "cancelled").then(|| run.updated_at.clone());
}
