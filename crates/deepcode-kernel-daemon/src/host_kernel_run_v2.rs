use crate::host_kernel_operation_store_v2::{
    HostKernelBootstrapActivationV2, HostKernelBootstrapInitialInputV2,
    HostKernelBootstrapRecordV2, HostKernelDispatchAttemptStateV2, HostKernelDispatchPrepareV2,
    HostKernelDispatchRecoveryV2, HostKernelFailureCommitV2, HostKernelFailureDispositionV2,
    HostKernelFailureEffectV2, HostKernelLiveRunForDeletionV2,
    HostKernelOperationCallerCorrelationV2, HostKernelOperationFailureBoundaryV2,
    HostKernelOperationPreparedV2, HostKernelOperationRefV2,
    HostKernelOperationSettlementReceiptV2, HostKernelOperationSettlementV2,
    HostKernelOperationStoreV2, HostKernelPendingOperationV2, HostKernelPendingRequestLaneV2,
    HostKernelRunOpeningInputV2, HostKernelRunOpeningRecordV2, HostKernelStartupCancelRecoveryV2,
    HostKernelStoredRunLifecycleV2, HostRunCallerDriveRecoveryV2,
};
use crate::host_run_broker_v2::{
    HostActiveRunBrokerV2, HostActiveRunRecordV2, HostActiveRunRegistrationV2,
    HostBridgeChildLeaseV2, HostBridgeOwnershipV2, HostRunRetirementReceiptV2,
    HostRunSettingsCeilingV2, HostRunWorkspaceKindV2,
};
use crate::host_services::HostServices;
use crate::host_v2_storage::{canonical_sha256, reject_transport_capabilities, HostV2StorageError};
use crate::host_workspace_registry_v2::HostWorkspaceResolveErrorV2;
use crate::kernel_v2_transport::KernelV2TransportState;
use crate::session_bootstrap_v2::{HostProviderProfileBootstrapV2, HostSessionPriorEventsV2};
use crate::session_kernel_v2_store::{
    validate_session_work_authority_v3, SessionKernelV2Store, SessionWorkAuthorityV3,
};
use crate::{AgentInputAttachmentV3, UserAttachmentContextV1};
use deepcode_kernel_abi::v2::{
    CancellationReasonCodeV2, CancellationSourceV2, CommandRequestId, ControlFactV2, FactId,
    InputId, InvocationFactV2, KernelFactEnvelopeV2, KernelFactPayloadV2, RunId,
    RunRetirementReasonCodeV2,
};
use deepcode_kernel_abi::v2_command::{
    InvocationCancelReplyV2, InvocationPhaseV2, KernelCommandEnvelopeV2,
    KernelCommandResponseEnvelopeV2, KernelCommandV2, KernelReplyV2, RunOpenReplyV2, RunOpenV2,
};
use deepcode_kernel_abi::{RunCapabilityV2, WorkspaceBindingRefV2};
use deepcode_kernel_ledger::v2::CanonicalFactReader;
use deepcode_kernel_runtime::v2::SettingsCeilingV2;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::oneshot;

const SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA: &str =
    "deepcode.session.kernel-production-request.v2";
const SESSION_KERNEL_PRODUCTION_REQUEST_FRAME_V2_SCHEMA: &str =
    "deepcode.session.kernel-production-request-frame.v2";
const SESSION_KERNEL_PERSISTENCE_V3_SCHEMA: &str = "deepcode.session.kernel-persistence.v3";
const SESSION_KERNEL_PREFETCHED_RUN_V2_SCHEMA: &str = "deepcode.session.prefetched-kernel-run.v2";
const SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA: &str =
    "deepcode.session.kernel-production-response.v2";
const SESSION_KERNEL_PRODUCTION_RESPONSE_FRAME_V2_SCHEMA: &str =
    "deepcode.session.kernel-production-response-frame.v2";
const SESSION_KERNEL_RUN_CAPABILITY_ENV_V2: &str = "DEEPCODE_SESSION_RUN_CAPABILITY_V2";
const SESSION_KERNEL_API_BASE_ENV_V2: &str = "DEEPCODE_SESSION_API_BASE_V2";
const MAX_SESSION_KERNEL_RESPONSE_FRAME_BYTES_V2: usize = 4 * 1024 * 1024;
const SESSION_KERNEL_RESPONSE_TIMEOUT_V2: Duration = Duration::from_secs(10 * 60);
const RETRY_SAME_REQUEST_BACKOFF_V2: Duration = Duration::from_millis(25);
const RETRY_SAME_REQUEST_MAX_BACKOFF_V2: Duration = Duration::from_secs(1);
const HOST_KERNEL_STARTUP_RECOVERY_STATUS_SCHEMA_V2: &str =
    "deepcode.host.kernel-startup-recovery-status.v2";

#[derive(Debug, Clone)]
pub(crate) struct HostKernelRunWorkspaceV2 {
    pub(crate) workspace_binding_ref: WorkspaceBindingRefV2,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_canonical_root: PathBuf,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) active_folder_id: Option<String>,
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostKernelInitialInputV2 {
    pub(crate) input_id: InputId,
    pub(crate) opaque_input_ref: String,
    pub(crate) text: String,
    pub(crate) attachments: Vec<AgentInputAttachmentV3>,
    pub(crate) attachment_contexts: Vec<UserAttachmentContextV1>,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum HostKernelBridgeOperationV2 {
    InitialTurn {
        guidance: Vec<String>,
    },
    ResumePlanAction {
        plan_action_id: String,
        expected_plan_revision: String,
        provider_call_budget: u16,
        guidance: Vec<String>,
    },
    UserInput {
        input: HostKernelInitialInputV2,
        guidance: Vec<String>,
    },
    Replan {
        expected_plan_revision: String,
        guidance: Vec<String>,
    },
    ResumePlanning {
        guidance: Vec<String>,
    },
    ResumeAfterBackpressure {
        operation_id: String,
        retry_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan_action_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_plan_revision: Option<String>,
        guidance: Vec<String>,
    },
    PreviewPlan {
        expected_plan_revision: String,
    },
    PublishPlanConfirmationReady {
        plan_revision: String,
    },
    DecidePlan {
        plan_revision: String,
        decision: HostKernelPlanDecisionV2,
        #[serde(skip_serializing_if = "Option::is_none")]
        guidance: Option<String>,
    },
    ObserveCapabilityDecision {
        decision: HostKernelCapabilityDecisionV2,
        guidance: String,
        preview_id: String,
        operation_id: String,
        invocation_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan_action_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_plan_revision: Option<String>,
    },
    ReconcileWake {
        wait_kind: HostKernelWaitKindV2,
        operation_id: String,
        invocation_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        preview_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan_action_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_plan_revision: Option<String>,
        guidance: Vec<String>,
    },
    ReconcileFacts {
        observed_high_water: u64,
    },
    CancelRun {
        caller_request_id: String,
        caller_request_digest: String,
        cancel_operation_id: String,
    },
    FinalizeReview {
        expected_work_authority: SessionWorkAuthorityV3,
    },
    RequestFinalAnswer {
        input_id: String,
        control_epoch: u64,
        work_authority: SessionWorkAuthorityV3,
        review_revision: u64,
        snapshot_high_water: u64,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelPlanDecisionV2 {
    Accept,
    Reject,
    Revise,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelCapabilityDecisionV2 {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelWaitKindV2 {
    Capability,
    Invocation,
}

pub(crate) struct HostKernelRunAdmittedV2 {
    pub(crate) active_run: HostActiveRunRecordV2,
    coordinator: HostKernelRunCoordinatorV2,
    initial_operation: HostKernelOperationCompletionReceiverV2,
}

impl HostKernelRunAdmittedV2 {
    pub(crate) async fn await_initial_operation(
        self,
    ) -> Result<HostKernelOperationSettlementReceiptV2, HostV2StorageError> {
        let key = HostKernelLiveRunKeyV2 {
            session_id: self.active_run.session_id.clone(),
            host_run_id: self.active_run.host_run_id.clone(),
            run_id: self.active_run.run_id.clone(),
        };
        self.coordinator
            .await_operation_completion(key, self.initial_operation)
            .await
    }
}

struct HostKernelRunStartedV2 {
    active_run: HostActiveRunRecordV2,
    initial_operation: HostKernelOperationCompletionReceiverV2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelStartupRecoveryPhaseV2 {
    Pending,
    Reconciling,
    Recovering,
    Ready,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelOperationRecoveryStateV2 {
    FirstDispatchResumed,
    LostDispatchResumed,
    RetrySameRequestResumed,
    RecoveredDispatchSettled,
    ObservedResponseSettled,
    CancellationEvidenceRecoveredAndRetired,
    CancellationSafetyRetired,
    BlockedIndeterminate,
    BlockedByIndeterminate,
    BlockedByRecoveryFailure,
    RecoveryFailed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostKernelOperationRecoveryStatusV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) operation_request_id: String,
    pub(crate) operation_sequence: u64,
    pub(crate) state: HostKernelOperationRecoveryStateV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostKernelStartupRecoveryStatusV2 {
    pub(crate) schema_version: &'static str,
    pub(crate) phase: HostKernelStartupRecoveryPhaseV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reconciled_at: Option<String>,
    pub(crate) opening_run_count: usize,
    pub(crate) active_run_count: usize,
    pub(crate) attempts_marked_indeterminate: usize,
    pub(crate) pending_dispatch_count: usize,
    pub(crate) startup_error_codes: Vec<String>,
    pub(crate) operations: Vec<HostKernelOperationRecoveryStatusV2>,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelStartupTombstoneFailureV2 {
    pub(crate) session_id: String,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

pub(crate) struct HostKernelStartupReconciliationOutcomeV2 {
    pub(crate) tombstone_failures: Vec<HostKernelStartupTombstoneFailureV2>,
    pub(crate) continuation_ready_runs: Vec<HostKernelStartupContinuationRunV2>,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelStartupContinuationRunV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) bootstrap_digest: String,
}

impl HostKernelStartupRecoveryStatusV2 {
    fn pending() -> Self {
        Self {
            schema_version: HOST_KERNEL_STARTUP_RECOVERY_STATUS_SCHEMA_V2,
            phase: HostKernelStartupRecoveryPhaseV2::Pending,
            reconciled_at: None,
            opening_run_count: 0,
            active_run_count: 0,
            attempts_marked_indeterminate: 0,
            pending_dispatch_count: 0,
            startup_error_codes: Vec::new(),
            operations: Vec::new(),
        }
    }

    fn unavailable() -> Self {
        let mut status = Self::pending();
        status.phase = HostKernelStartupRecoveryPhaseV2::Unavailable;
        status
            .startup_error_codes
            .push("host_kernel_startup_recovery_status_unavailable".to_string());
        status
    }

    fn record_error(&mut self, error_code: impl Into<String>) {
        let error_code = error_code.into();
        if !self.startup_error_codes.contains(&error_code) {
            self.startup_error_codes.push(error_code);
        }
    }

    fn refresh_phase(&mut self) {
        self.phase = if !self.startup_error_codes.is_empty()
            || self.operations.iter().any(|operation| {
                matches!(
                    operation.state,
                    HostKernelOperationRecoveryStateV2::BlockedIndeterminate
                        | HostKernelOperationRecoveryStateV2::BlockedByIndeterminate
                        | HostKernelOperationRecoveryStateV2::BlockedByRecoveryFailure
                        | HostKernelOperationRecoveryStateV2::CancellationSafetyRetired
                        | HostKernelOperationRecoveryStateV2::RecoveryFailed
                )
            }) {
            HostKernelStartupRecoveryPhaseV2::Degraded
        } else if self.pending_dispatch_count > 0 {
            HostKernelStartupRecoveryPhaseV2::Recovering
        } else {
            HostKernelStartupRecoveryPhaseV2::Ready
        };
    }
}

enum HostKernelStartupCancelDispositionV2 {
    CanonicalRetired,
    SafetyRetired { evidence_error_code: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct HostKernelLiveRunKeyV2 {
    session_id: String,
    host_run_id: String,
    run_id: String,
}

struct HostKernelPendingResponseV2 {
    operation: HostKernelOperationRefV2,
    attempt_id: String,
    owner_instance_id: String,
    production_frame: Value,
    completion: oneshot::Sender<Result<HostKernelOperationCompletionV2, HostV2StorageError>>,
}

enum HostKernelOperationCompletionV2 {
    Settled(HostKernelOperationSettlementReceiptV2),
    RetrySameRequest {
        operation: HostKernelOperationRefV2,
        previous_attempt_id: String,
        production_frame: Value,
        retry_settlement: HostKernelOperationSettlementV2,
    },
}

type HostKernelOperationCompletionReceiverV2 =
    oneshot::Receiver<Result<HostKernelOperationCompletionV2, HostV2StorageError>>;

struct HostKernelLiveBridgeV2 {
    bootstrap_digest: String,
    run_capability_digest: [u8; 32],
    child: HostBridgeChildLeaseV2,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: Arc<Mutex<HashMap<String, HostKernelPendingResponseV2>>>,
    failed: Arc<AtomicBool>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl HostKernelLiveBridgeV2 {
    fn shutdown(&self) -> Result<(), HostV2StorageError> {
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        let child_result = self.child.terminate_and_wait();
        let current_thread = thread::current().id();
        let workers = self
            .workers
            .lock()
            .map(|mut workers| std::mem::take(&mut *workers))
            .unwrap_or_default();
        for worker in workers {
            if worker.thread().id() != current_thread {
                let _ = worker.join();
            }
        }
        child_result
    }
}

impl Drop for HostKernelLiveBridgeV2 {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[derive(Clone)]
pub(crate) struct HostKernelBridgeAssetsV2 {
    bridge: Arc<PathBuf>,
    bridge_digest: Arc<[u8; 32]>,
    node: Arc<PathBuf>,
    node_digest: Arc<[u8; 32]>,
}

impl HostKernelBridgeAssetsV2 {
    pub(crate) fn resolve_at_daemon_start() -> Result<Self, HostV2StorageError> {
        let executable = std::env::current_exe().map_err(|error| {
            HostV2StorageError::io(
                "host_kernel_bridge_v2_executable_unavailable",
                format!("resolve daemon executable for Session bridge assets: {error}"),
            )
        })?;
        let executable = fs::canonicalize(executable).map_err(|error| {
            HostV2StorageError::io(
                "host_kernel_bridge_v2_executable_unavailable",
                format!("canonicalize daemon executable for Session bridge assets: {error}"),
            )
        })?;
        let executable_root = executable.parent().ok_or_else(|| {
            HostV2StorageError::not_found(
                "host_kernel_bridge_v2_asset_root_unavailable",
                "Daemon executable has no trusted asset root",
            )
        })?;
        let bridge = executable_root
            .ancestors()
            .flat_map(|ancestor| {
                [
                    ancestor.join("session-core/dist/hostBridgeV2.js"),
                    ancestor.join("userspace/session-core/dist/hostBridgeV2.js"),
                ]
            })
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_kernel_bridge_v2_unavailable",
                    "Trusted Session Kernel v2 bridge asset was not found beside the daemon distribution",
                )
            })
            .and_then(canonical_trusted_asset)?;
        let node = trusted_node_candidates(executable_root)
            .into_iter()
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_kernel_bridge_v2_node_unavailable",
                    "Trusted Session Kernel v2 Node runtime was not found",
                )
            })
            .and_then(canonical_trusted_asset)?;
        Ok(Self {
            bridge_digest: Arc::new(file_sha256(&bridge)?),
            node_digest: Arc::new(file_sha256(&node)?),
            bridge: Arc::new(bridge),
            node: Arc::new(node),
        })
    }

    fn verified_command(&self) -> Result<Command, HostV2StorageError> {
        if file_sha256(self.bridge.as_ref())? != *self.bridge_digest
            || file_sha256(self.node.as_ref())? != *self.node_digest
        {
            return Err(HostV2StorageError::conflict(
                "host_kernel_bridge_v2_asset_changed",
                "Trusted Session Kernel v2 bridge assets changed after daemon startup",
            ));
        }
        let mut command = Command::new(self.node.as_ref());
        command.arg(self.bridge.as_ref());
        Ok(command)
    }
}

#[derive(Clone)]
pub(crate) struct HostKernelRunCoordinatorV2 {
    host_services: HostServices,
    kernel_transport: KernelV2TransportState,
    bridge_assets: HostKernelBridgeAssetsV2,
    trusted_api_base: Arc<str>,
    live_bridges: Arc<Mutex<HashMap<HostKernelLiveRunKeyV2, Arc<HostKernelLiveBridgeV2>>>>,
    startup_recovery: Arc<Mutex<HostKernelStartupRecoveryStatusV2>>,
}

impl HostKernelRunCoordinatorV2 {
    pub(crate) fn new(
        host_services: HostServices,
        kernel_transport: KernelV2TransportState,
        bridge_assets: HostKernelBridgeAssetsV2,
        trusted_api_base: String,
    ) -> Result<Self, HostV2StorageError> {
        let trusted_api_base = validate_trusted_loopback_api_base(trusted_api_base)?;
        Ok(Self {
            host_services,
            kernel_transport,
            bridge_assets,
            trusted_api_base: Arc::from(trusted_api_base),
            live_bridges: Arc::new(Mutex::new(HashMap::new())),
            startup_recovery: Arc::new(Mutex::new(HostKernelStartupRecoveryStatusV2::pending())),
        })
    }

    pub(crate) fn startup_recovery_status(&self) -> HostKernelStartupRecoveryStatusV2 {
        self.startup_recovery
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| HostKernelStartupRecoveryStatusV2::unavailable())
    }

    fn replace_startup_recovery_status(
        &self,
        status: HostKernelStartupRecoveryStatusV2,
    ) -> Result<(), HostV2StorageError> {
        *self.startup_recovery.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_kernel_startup_recovery_status_unavailable",
                "Host Kernel startup recovery status owner is unavailable",
            )
        })? = status;
        Ok(())
    }

    pub(crate) fn shutdown_all_owned_bridges(&self) -> Result<(), HostV2StorageError> {
        let bridges = {
            let mut live = self
                .live_bridges
                .lock()
                .map_err(|_| live_registry_unavailable())?;
            live.drain().map(|(_, bridge)| bridge).collect::<Vec<_>>()
        };
        let mut first_error = None;
        for bridge in bridges {
            if let Err(error) = bridge.shutdown() {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub(crate) async fn retire_run(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
    ) -> Result<HostRunRetirementReceiptV2, HostV2StorageError> {
        self.retire_run_with_caller_correlation(
            session_id,
            host_run_id,
            run_id,
            RunRetirementReasonCodeV2::SessionEnded,
            None,
            false,
        )
        .await
    }

    pub(crate) async fn safety_retire_cancel_run(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
    ) -> Result<HostRunRetirementReceiptV2, HostV2StorageError> {
        let key = HostKernelLiveRunKeyV2 {
            session_id: session_id.to_string(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
        };
        match self
            .retire_run_with_caller_correlation(
                session_id,
                host_run_id,
                run_id,
                RunRetirementReasonCodeV2::HostRequested,
                None,
                true,
            )
            .await
        {
            Ok(receipt) => Ok(receipt),
            Err(error) => match self.remove_live_bridge(&key) {
                Ok(_) => Err(error),
                Err(cleanup_error) => Err(HostV2StorageError::io(
                    "host_kernel_cancel_safety_retirement_pending",
                    format!(
                        "Cancellation became indeterminate after {}; safety retirement also failed to remove its live Session bridge after {}",
                        error.code, cleanup_error.code
                    ),
                )),
            },
        }
    }

    async fn retire_run_with_caller_correlation(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        retirement_reason: RunRetirementReasonCodeV2,
        caller_correlation: Option<(&str, &str)>,
        settle_superseded_drive: bool,
    ) -> Result<HostRunRetirementReceiptV2, HostV2StorageError> {
        let turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(session_id)
            .await?;
        self.retire_run_with_turn_and_caller_correlation(
            &turn,
            session_id,
            host_run_id,
            run_id,
            retirement_reason,
            caller_correlation,
            settle_superseded_drive,
        )
    }

    fn retire_run_with_turn_and_caller_correlation(
        &self,
        turn: &crate::host_run_broker_v2::HostSessionTurnGuardV2,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        retirement_reason: RunRetirementReasonCodeV2,
        caller_correlation: Option<(&str, &str)>,
        settle_superseded_drive: bool,
    ) -> Result<HostRunRetirementReceiptV2, HostV2StorageError> {
        let bootstrap = self
            .host_services
            .kernel_operations_v2
            .get_bootstrap(session_id, host_run_id)?;
        if bootstrap.run_id != run_id {
            return Err(HostV2StorageError::conflict(
                "host_kernel_run_retirement_identity_conflict",
                "Run retirement does not match the exact durable bootstrap",
            ));
        }
        if settle_superseded_drive {
            self.settle_superseded_run_drive_before_retirement(
                session_id,
                host_run_id,
                caller_correlation,
                retirement_reason,
            )?;
        }
        let receipt = self.host_services.retire_kernel_run_with_turn_v2(
            turn,
            host_run_id,
            run_id,
            retirement_reason,
            None,
        )?;
        match caller_correlation {
            Some((caller_request_id, request_digest)) => {
                let operations = &self.host_services.kernel_operations_v2;
                if settle_superseded_drive {
                    operations.retire_active_for_caller_after_superseded_drive(
                        session_id,
                        host_run_id,
                        run_id,
                        &bootstrap.bootstrap_digest,
                        &crate::utils::now_text(),
                        caller_request_id,
                        request_digest,
                    )?;
                } else {
                    operations.retire_active_for_caller(
                        session_id,
                        host_run_id,
                        run_id,
                        &bootstrap.bootstrap_digest,
                        &crate::utils::now_text(),
                        caller_request_id,
                        request_digest,
                    )?;
                }
            }
            None => {
                let operations = &self.host_services.kernel_operations_v2;
                if settle_superseded_drive {
                    operations.retire_active_after_superseded_drive(
                        session_id,
                        host_run_id,
                        run_id,
                        &bootstrap.bootstrap_digest,
                        &crate::utils::now_text(),
                    )?;
                } else {
                    operations.retire_active(
                        session_id,
                        host_run_id,
                        run_id,
                        &bootstrap.bootstrap_digest,
                        &crate::utils::now_text(),
                    )?;
                }
            }
        }
        self.remove_live_bridge(&HostKernelLiveRunKeyV2 {
            session_id: session_id.to_string(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
        })?;
        Ok(receipt)
    }

    fn settle_superseded_run_drive_before_retirement(
        &self,
        session_id: &str,
        host_run_id: &str,
        retirement_caller: Option<(&str, &str)>,
        retirement_reason: RunRetirementReasonCodeV2,
    ) -> Result<(), HostV2StorageError> {
        let binding = match self
            .host_services
            .kernel_operations_v2
            .caller_drive_recovery_for_run(session_id, host_run_id)?
        {
            HostRunCallerDriveRecoveryV2::NoDrive
            | HostRunCallerDriveRecoveryV2::Indeterminate(_) => return Ok(()),
            HostRunCallerDriveRecoveryV2::Unadmitted(binding)
            | HostRunCallerDriveRecoveryV2::Admitted(binding) => binding,
        };
        if retirement_caller
            .map(|(caller_request_id, request_digest)| {
                caller_request_id == binding.caller_request_id
                    && request_digest == binding.request_digest
            })
            .unwrap_or(false)
        {
            return Ok(());
        }
        let (code, message) = if retirement_reason == RunRetirementReasonCodeV2::HostRequested {
            (
                "host_caller_request_superseded_by_run_cancellation",
                "The admitted Host caller was superseded by explicit Run cancellation; its exact effects must be reviewed before retry.",
            )
        } else {
            (
                "host_caller_request_superseded_by_run_retirement",
                "The admitted Host caller was superseded by explicit Run retirement; its exact effects must be reviewed before retry.",
            )
        };
        let outcome = json!({
            "schemaVersion": "deepcode.host.agent-run-outcome.v2",
            "disposition": "indeterminate",
            "hostRunId": host_run_id,
            "error": {
                "code": code,
                "message": message,
            },
        });
        let owner_instance_id = binding.drive_owner_instance_id.as_deref().ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_caller_request_owner_missing",
                "Superseded Run drive has no exact Host owner instance",
            )
        })?;
        if let Some(admission_digest) = binding.admission_digest.as_deref() {
            self.host_services
                .kernel_operations_v2
                .settle_owned_caller_request(
                    &binding.session_id,
                    &binding.caller_request_id,
                    &binding.request_kind,
                    &binding.request_digest,
                    owner_instance_id,
                    admission_digest,
                    outcome,
                    crate::utils::now_rfc3339_text(),
                )?;
        } else {
            self.host_services
                .kernel_operations_v2
                .settle_unadmitted_owned_caller_indeterminate(
                    &binding.session_id,
                    &binding.caller_request_id,
                    &binding.request_kind,
                    &binding.request_digest,
                    owner_instance_id,
                    outcome,
                    crate::utils::now_rfc3339_text(),
                )?;
        }
        Ok(())
    }

    /// Owns the complete first-turn transition. Durable Opening precedes the
    /// Host-only RunOpen, and a dispatch attempt is durable before any request
    /// byte can reach the Session bridge.
    async fn open_and_start_initial(
        &self,
        input: HostKernelRunSpawnInputV2,
    ) -> Result<HostKernelRunStartedV2, HostV2StorageError> {
        validate_spawn_input(&input)?;
        let turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(&input.session_id)
            .await?;
        let run_open_envelope = run_open_envelope(&input)?;
        let opening =
            self.host_services
                .kernel_operations_v2
                .begin_opening(HostKernelRunOpeningInputV2 {
                    session_id: input.session_id.clone(),
                    host_run_id: input.host_run_id.clone(),
                    drive_caller_request_id: input.caller_request_id.clone(),
                    drive_request_digest: input.caller_request_digest.clone(),
                    run_open_request_id: input.run_open_request_id.clone(),
                    run_open_envelope: run_open_envelope.clone(),
                    workspace_binding_identity: input.workspace.workspace_binding_identity.clone(),
                    workspace_canonical_root: input.workspace.workspace_canonical_root.clone(),
                    workspace_kind: input.workspace.workspace_kind,
                    active_folder_id: input.workspace.active_folder_id.clone(),
                    empty_workspace_key: input.workspace.empty_workspace_key.clone(),
                    run_settings: input.workspace.run_settings.clone(),
                    provider_profile: input.provider_profile.clone(),
                    prior_session_events: input.prior_session_events.clone(),
                    initial_input: bootstrap_initial_input(&input),
                    opening_recorded_at: crate::utils::now_text(),
                })?;
        match opening.record.lifecycle {
            HostKernelStoredRunLifecycleV2::Opening => {}
            HostKernelStoredRunLifecycleV2::Active => {
                let bootstrap = self
                    .host_services
                    .kernel_operations_v2
                    .get_bootstrap(&input.session_id, &input.host_run_id)?;
                let run_capability = self.ensure_run_transport_capability(&turn, &bootstrap)?;
                if let Some(initial_operation) =
                    self.host_services.kernel_operations_v2.settlement(
                        &input.session_id,
                        &input.host_run_id,
                        &input.operation_request_id,
                    )?
                {
                    self.ensure_live_bridge(&turn, &bootstrap, &run_capability)?;
                    let active_run = self
                        .host_services
                        .active_runs_v2
                        .resolve(&input.session_id, &input.host_run_id)?;
                    return Ok(HostKernelRunStartedV2 {
                        active_run,
                        initial_operation: completed_operation(initial_operation),
                    });
                }
                let completion = self.prepare_initial_dispatch(
                    &turn,
                    &bootstrap,
                    &run_capability,
                    &input.operation_request_id,
                    &input.operation,
                )?;
                let active_run = self
                    .host_services
                    .active_runs_v2
                    .resolve(&input.session_id, &input.host_run_id)?;
                drop(turn);
                return Ok(HostKernelRunStartedV2 {
                    active_run,
                    initial_operation: completion,
                });
            }
            HostKernelStoredRunLifecycleV2::Retired => {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_run_open_stale",
                    "Retired Host Run cannot be reopened",
                ))
            }
        }

        let (opened_response, run_capability) = match self
            .kernel_transport
            .open_run_host_with_settings(
                run_open_envelope,
                settings_ceiling(&input.workspace.run_settings),
            ) {
            Ok(opened) => opened,
            Err(error) => {
                return Err(self
                    .abandon_opening_after_error(&opening.record, workspace_resolve_error(error)))
            }
        };
        let run_open_reply = match run_open_reply(opened_response, &input.run_open_request_id) {
            Ok(reply) => reply,
            Err(error) => return Err(self.abandon_opening_after_error(&opening.record, error)),
        };
        let run_capability = match run_capability {
            Some(capability) => capability,
            None => {
                return Err(self.rollback_unactivated_run(
                    &opening.record,
                    &run_open_reply,
                    HostV2StorageError::conflict(
                        "host_kernel_run_recovery_required",
                        "Kernel Run exists without a current Host transport capability; use the Host recovery boundary",
                    ),
                ))
            }
        };
        let bootstrap = match self.host_services.kernel_operations_v2.activate_bootstrap(
            HostKernelBootstrapActivationV2 {
                session_id: input.session_id.clone(),
                host_run_id: input.host_run_id.clone(),
                run_open_request_id: input.run_open_request_id.clone(),
                run_open_reply: run_open_reply.clone(),
                activated_at: crate::utils::now_text(),
            },
        ) {
            Ok(bootstrap) => bootstrap,
            Err(error) => {
                return Err(self.rollback_unactivated_run(&opening.record, &run_open_reply, error))
            }
        };
        let receipt = self.host_services.active_runs_v2.register(
            &turn,
            HostActiveRunRegistrationV2 {
                session_id: input.session_id.clone(),
                host_run_id: input.host_run_id.clone(),
                run_id: run_open_reply.run_id.to_string(),
                bootstrap_digest: bootstrap.record.bootstrap_digest.clone(),
                workspace_binding_ref: input.workspace.workspace_binding_ref.to_string(),
                workspace_binding_digest: run_open_reply
                    .workspace_binding_digest
                    .as_str()
                    .to_string(),
                workspace_binding_identity: input.workspace.workspace_binding_identity.clone(),
                workspace_kind: input.workspace.workspace_kind,
                active_folder_id: input.workspace.active_folder_id.clone(),
                empty_workspace_key: input.workspace.empty_workspace_key.clone(),
                initial_input_id: input.initial_input.input_id.to_string(),
                initial_opaque_input_ref: input.initial_input.opaque_input_ref.clone(),
                run_settings: input.workspace.run_settings.clone(),
                recorded_at: input.initial_input.recorded_at.clone(),
            },
            match input.workspace.workspace_kind {
                HostRunWorkspaceKindV2::Bound => {
                    Some(input.workspace.workspace_canonical_root.as_path())
                }
                HostRunWorkspaceKindV2::Empty => None,
            },
        );
        let receipt = match receipt {
            Ok(receipt) => receipt,
            Err(error) => {
                return Err(self.rollback_activated_without_registration(&bootstrap.record, error))
            }
        };
        let snapshot = self
            .host_services
            .active_runs_v2
            .bind_run_transport_capability(
                &turn,
                &bootstrap.record.host_run_id,
                &bootstrap.record.run_id,
                &run_capability,
            )
            .and_then(|_| {
                self.host_services
                    .session_kernel_v2
                    .persist_tool_context_snapshot(
                        &bootstrap.record.session_id,
                        &bootstrap.record.run_id,
                        &run_capability,
                        &bootstrap.record.run_open_reply.tool_context,
                    )
                    .map(|_| ())
            });
        if let Err(error) = snapshot {
            if receipt.replayed {
                return Err(error);
            }
            return Err(self.rollback_registered_run(&turn, &bootstrap.record, error));
        }
        let started = self.prepare_initial_dispatch(
            &turn,
            &bootstrap.record,
            &run_capability,
            &input.operation_request_id,
            &input.operation,
        );
        let completion = match started {
            Ok(completion) => completion,
            Err(error) if receipt.replayed => return Err(error),
            Err(error) => {
                return Err(self.rollback_registered_run(&turn, &bootstrap.record, error))
            }
        };
        drop(turn);
        Ok(HostKernelRunStartedV2 {
            active_run: receipt.record,
            initial_operation: completion,
        })
    }

    /// Invokes `registered` after the active Run and first dispatch are
    /// durable, but before waiting on Session/Provider completion.
    pub(crate) async fn open_and_dispatch_initial(
        &self,
        input: HostKernelRunSpawnInputV2,
        registered: impl FnOnce(),
    ) -> Result<HostKernelRunAdmittedV2, HostV2StorageError> {
        let started = self.open_and_start_initial(input).await?;
        registered();
        Ok(HostKernelRunAdmittedV2 {
            active_run: started.active_run,
            coordinator: self.clone(),
            initial_operation: started.initial_operation,
        })
    }

    pub(crate) async fn submit_operation(
        &self,
        session_id: &str,
        host_run_id: &str,
        operation_request_id: &str,
        operation: HostKernelBridgeOperationV2,
    ) -> Result<HostKernelOperationSettlementReceiptV2, HostV2StorageError> {
        self.submit_operation_guarded(
            session_id,
            host_run_id,
            operation_request_id,
            operation,
            None,
            None,
            || {},
        )
        .await?
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_kernel_operation_unexpected_stale",
                "Unguarded Host Kernel operation became stale",
            )
        })
    }

    pub(crate) async fn submit_operation_if_latest_settlement(
        &self,
        session_id: &str,
        host_run_id: &str,
        operation_request_id: &str,
        operation: HostKernelBridgeOperationV2,
        expected_run_id: &str,
        expected_bootstrap_digest: &str,
        expected_settlement_digest: &str,
        dispatched: impl FnOnce(),
    ) -> Result<Option<HostKernelOperationSettlementReceiptV2>, HostV2StorageError> {
        self.submit_operation_guarded(
            session_id,
            host_run_id,
            operation_request_id,
            operation,
            Some((
                expected_run_id,
                expected_bootstrap_digest,
                expected_settlement_digest,
            )),
            None,
            dispatched,
        )
        .await
    }

    pub(crate) async fn submit_user_input_for_caller(
        &self,
        session_id: &str,
        host_run_id: &str,
        operation_request_id: &str,
        caller_request_id: &str,
        caller_request_digest: &str,
        operation: HostKernelBridgeOperationV2,
    ) -> Result<HostKernelOperationSettlementReceiptV2, HostV2StorageError> {
        self.submit_operation_guarded(
            session_id,
            host_run_id,
            operation_request_id,
            operation,
            None,
            Some(HostKernelOperationCallerCorrelationV2 {
                caller_request_id: caller_request_id.to_string(),
                request_kind: "agent.run.user-input.v2".to_string(),
                request_digest: caller_request_digest.to_string(),
            }),
            || {},
        )
        .await?
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_kernel_user_input_unexpected_stale",
                "Caller-correlated user input became stale before dispatch",
            )
        })
    }

    async fn submit_operation_guarded(
        &self,
        session_id: &str,
        host_run_id: &str,
        operation_request_id: &str,
        operation: HostKernelBridgeOperationV2,
        expected_predecessor: Option<(&str, &str, &str)>,
        caller_correlation: Option<HostKernelOperationCallerCorrelationV2>,
        dispatched: impl FnOnce(),
    ) -> Result<Option<HostKernelOperationSettlementReceiptV2>, HostV2StorageError> {
        let turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(session_id)
            .await?;
        if let Some((expected_run_id, expected_bootstrap_digest, expected_settlement_digest)) =
            expected_predecessor
        {
            let Some(active) = self
                .host_services
                .active_runs_v2
                .resolve_session_active_run(session_id)?
            else {
                return Ok(None);
            };
            if active.host_run_id != host_run_id
                || active.run_id != expected_run_id
                || active.bootstrap_digest != expected_bootstrap_digest
            {
                return Ok(None);
            }
            let Some(latest) = self
                .host_services
                .kernel_operations_v2
                .latest_settlement(session_id, host_run_id)?
            else {
                return Ok(None);
            };
            if latest.settlement_digest != expected_settlement_digest {
                return Ok(None);
            }
        }
        let bootstrap = self
            .host_services
            .kernel_operations_v2
            .get_bootstrap(session_id, host_run_id)?;
        if let Some((expected_run_id, expected_bootstrap_digest, _)) = expected_predecessor {
            if bootstrap.run_id != expected_run_id
                || bootstrap.bootstrap_digest != expected_bootstrap_digest
            {
                return Ok(None);
            }
        }
        let frame =
            production_request_frame_from_bootstrap(&bootstrap, operation_request_id, &operation)?;
        let prepared_input = || HostKernelOperationPreparedV2 {
            session_id: bootstrap.session_id.clone(),
            host_run_id: bootstrap.host_run_id.clone(),
            run_id: bootstrap.run_id.clone(),
            bootstrap_digest: bootstrap.bootstrap_digest.clone(),
            provider_profile_revision_digest: Some(
                bootstrap
                    .provider_profile
                    .provider_profile_revision_digest
                    .clone(),
            ),
            operation_request_id: operation_request_id.to_string(),
            caller_correlation: caller_correlation.clone(),
            production_frame: frame.clone(),
            recorded_at: crate::utils::now_text(),
        };
        let existing = self
            .host_services
            .kernel_operations_v2
            .prepared_operation(prepared_input())?;
        if let Some(settlement) = self.host_services.kernel_operations_v2.settlement(
            session_id,
            host_run_id,
            operation_request_id,
        )? {
            return Ok(Some(settlement));
        }
        let run_capability = self.ensure_run_transport_capability(&turn, &bootstrap)?;
        let live = self.ensure_live_bridge(&turn, &bootstrap, &run_capability)?;
        let key = HostKernelLiveRunKeyV2 {
            session_id: bootstrap.session_id.clone(),
            host_run_id: bootstrap.host_run_id.clone(),
            run_id: bootstrap.run_id.clone(),
        };
        if existing.is_none() && operation.requires_facts_preflight() {
            self.reconcile_kernel_facts_before_operation(&bootstrap, &live)
                .await?;
        }
        self.host_services
            .kernel_operations_v2
            .prepare_operation(prepared_input())?;
        let operation_ref = operation_ref(&bootstrap, operation_request_id);
        let completion = self.prepare_and_dispatch(&live, operation_ref, frame)?;
        // The exact operation is now durable and accepted by the live bridge.
        // Publish caller-visible drive state before awaiting a potentially long
        // Session/Provider completion, while stale guarded submissions remain
        // side-effect free and do not invoke this callback.
        dispatched();
        drop(turn);
        self.await_operation_completion(key, completion)
            .await
            .map(Some)
    }

    pub(crate) async fn cancel_run_for_caller(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        caller_request_id: &str,
        caller_request_digest: &str,
        cancel_operation_id: &str,
    ) -> Result<(), HostV2StorageError> {
        let turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(session_id)
            .await?;
        let bootstrap = self
            .host_services
            .kernel_operations_v2
            .get_bootstrap(session_id, host_run_id)?;
        if bootstrap.run_id != run_id {
            return Err(HostV2StorageError::conflict(
                "host_kernel_cancel_run_identity_conflict",
                "Run cancellation does not match the exact durable bootstrap",
            ));
        }
        let operation = HostKernelBridgeOperationV2::CancelRun {
            caller_request_id: caller_request_id.to_string(),
            caller_request_digest: caller_request_digest.to_string(),
            cancel_operation_id: cancel_operation_id.to_string(),
        };
        let frame =
            production_request_frame_from_bootstrap(&bootstrap, cancel_operation_id, &operation)?;
        let prepared = || HostKernelOperationPreparedV2 {
            session_id: bootstrap.session_id.clone(),
            host_run_id: bootstrap.host_run_id.clone(),
            run_id: bootstrap.run_id.clone(),
            bootstrap_digest: bootstrap.bootstrap_digest.clone(),
            provider_profile_revision_digest: Some(
                bootstrap
                    .provider_profile
                    .provider_profile_revision_digest
                    .clone(),
            ),
            operation_request_id: cancel_operation_id.to_string(),
            caller_correlation: Some(HostKernelOperationCallerCorrelationV2 {
                caller_request_id: caller_request_id.to_string(),
                request_kind: "agent.run.cancel.v2".to_string(),
                request_digest: caller_request_digest.to_string(),
            }),
            production_frame: frame.clone(),
            recorded_at: crate::utils::now_text(),
        };
        let existing = self
            .host_services
            .kernel_operations_v2
            .prepared_operation(prepared())?;
        let cancellation_operation = match self.host_services.kernel_operations_v2.settlement(
            session_id,
            host_run_id,
            cancel_operation_id,
        )? {
            Some(settlement) => settlement,
            None => {
                let key = HostKernelLiveRunKeyV2 {
                    session_id: session_id.to_string(),
                    host_run_id: host_run_id.to_string(),
                    run_id: run_id.to_string(),
                };
                let run_capability = self.ensure_run_transport_capability(&turn, &bootstrap)?;
                let live = self.ensure_live_bridge(&turn, &bootstrap, &run_capability)?;
                if existing.is_none() {
                    self.host_services
                        .kernel_operations_v2
                        .prepare_operation(prepared())?;
                }
                let completion = self.prepare_and_dispatch(
                    &live,
                    operation_ref(&bootstrap, cancel_operation_id),
                    frame,
                )?;
                self.await_operation_completion(key, completion).await?
            }
        };
        let acknowledgement = self.validate_cancel_run_settlement_against_kernel(
            &cancellation_operation,
            session_id,
            host_run_id,
            run_id,
            caller_request_id,
            caller_request_digest,
            cancel_operation_id,
        )?;
        self.host_services
            .projection_v2
            .require_durable_run_cancelled_projection(
                session_id,
                host_run_id,
                run_id,
                &acknowledgement.projection_id,
                &acknowledgement.projection_digest,
                &acknowledgement.projection_data,
            )?;
        self.retire_run_with_turn_and_caller_correlation(
            &turn,
            session_id,
            host_run_id,
            run_id,
            RunRetirementReasonCodeV2::HostRequested,
            Some((caller_request_id, caller_request_digest)),
            true,
        )?;
        Ok(())
    }

    fn validate_cancel_run_settlement_against_kernel(
        &self,
        settlement: &HostKernelOperationSettlementReceiptV2,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        caller_request_id: &str,
        caller_request_digest: &str,
        cancel_operation_id: &str,
    ) -> Result<ValidatedCancelRunAcknowledgementV2, HostV2StorageError> {
        let typed_run_id = RunId::new(run_id.to_string()).map_err(|_| {
            HostV2StorageError::conflict(
                "host_kernel_cancel_run_identity_invalid",
                "Cancel acknowledgement contains an invalid Kernel Run identity",
            )
        })?;
        let service = self.kernel_transport.service();
        let kernel_run_sequence_high_water = service
            .run_sequence_high_water(&typed_run_id)
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_kernel_cancel_fact_boundary_unavailable",
                    "Canonical Kernel Run fact boundary is unavailable for cancellation validation",
                )
            })?;
        validate_cancel_run_settlement(
            settlement,
            session_id,
            host_run_id,
            run_id,
            caller_request_id,
            caller_request_digest,
            cancel_operation_id,
            kernel_run_sequence_high_water,
            &service.fact_reader(),
        )
    }

    async fn reconcile_kernel_facts_before_operation(
        &self,
        bootstrap: &HostKernelBootstrapRecordV2,
        live: &Arc<HostKernelLiveBridgeV2>,
    ) -> Result<(), HostV2StorageError> {
        const MAX_PREFLIGHT_RECONCILIATIONS: usize = 8;

        let run_id = RunId::new(bootstrap.run_id.clone()).map_err(|_| {
            HostV2StorageError::conflict(
                "host_kernel_facts_run_id_invalid",
                "Durable Host bootstrap contains an invalid Kernel Run identity",
            )
        })?;
        for _ in 0..MAX_PREFLIGHT_RECONCILIATIONS {
            let kernel_high_water = self
                .kernel_transport
                .service()
                .run_sequence_high_water(&run_id)
                .map_err(|_| {
                    HostV2StorageError::conflict(
                        "host_kernel_facts_high_water_unavailable",
                        "Kernel facts high-water is unavailable for the active Run",
                    )
                })?;
            let session_high_water = self.latest_session_facts_high_water(bootstrap)?;
            if session_high_water >= kernel_high_water {
                return Ok(());
            }
            let operation_request_id = format!(
                "host-facts-preflight:{}",
                canonical_sha256(&json!({
                    "schemaVersion": "deepcode.host.kernel-facts-preflight.v2",
                    "sessionId": bootstrap.session_id,
                    "hostRunId": bootstrap.host_run_id,
                    "runId": bootstrap.run_id,
                    "observedHighWater": session_high_water,
                    "kernelHighWater": kernel_high_water,
                }))?
            );
            let operation = HostKernelBridgeOperationV2::ReconcileFacts {
                observed_high_water: session_high_water,
            };
            let frame = production_request_frame_from_bootstrap(
                bootstrap,
                &operation_request_id,
                &operation,
            )?;
            self.host_services.kernel_operations_v2.prepare_operation(
                HostKernelOperationPreparedV2 {
                    session_id: bootstrap.session_id.clone(),
                    host_run_id: bootstrap.host_run_id.clone(),
                    run_id: bootstrap.run_id.clone(),
                    bootstrap_digest: bootstrap.bootstrap_digest.clone(),
                    provider_profile_revision_digest: Some(
                        bootstrap
                            .provider_profile
                            .provider_profile_revision_digest
                            .clone(),
                    ),
                    operation_request_id: operation_request_id.clone(),
                    caller_correlation: None,
                    production_frame: frame.clone(),
                    recorded_at: crate::utils::now_text(),
                },
            )?;
            let settlement = match self.host_services.kernel_operations_v2.settlement(
                &bootstrap.session_id,
                &bootstrap.host_run_id,
                &operation_request_id,
            )? {
                Some(settlement) => settlement,
                None => {
                    let operation_ref = operation_ref(bootstrap, &operation_request_id);
                    let completion = self.prepare_and_dispatch(live, operation_ref, frame)?;
                    let key = HostKernelLiveRunKeyV2 {
                        session_id: bootstrap.session_id.clone(),
                        host_run_id: bootstrap.host_run_id.clone(),
                        run_id: bootstrap.run_id.clone(),
                    };
                    self.await_operation_completion(key, completion).await?
                }
            };
            require_successful_session_facts_high_water(&settlement)?;
        }
        Err(HostV2StorageError::conflict(
            "host_kernel_facts_preflight_incomplete",
            "Session did not catch up to the bounded Kernel facts high-water before operation",
        ))
    }

    fn latest_session_facts_high_water(
        &self,
        bootstrap: &HostKernelBootstrapRecordV2,
    ) -> Result<u64, HostV2StorageError> {
        let settlement = self
            .host_services
            .kernel_operations_v2
            .latest_settlement(&bootstrap.session_id, &bootstrap.host_run_id)?
            .ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_kernel_session_state_missing",
                    "Active Host Kernel Run has no settled Session state",
                )
            })?;
        require_successful_session_facts_high_water(&settlement)
    }

    fn prepare_initial_dispatch(
        &self,
        turn: &crate::host_run_broker_v2::HostSessionTurnGuardV2,
        bootstrap: &HostKernelBootstrapRecordV2,
        run_capability: &RunCapabilityV2,
        operation_request_id: &str,
        operation: &HostKernelBridgeOperationV2,
    ) -> Result<HostKernelOperationCompletionReceiverV2, HostV2StorageError> {
        self.host_services
            .active_runs_v2
            .bind_run_transport_capability(
                turn,
                &bootstrap.host_run_id,
                &bootstrap.run_id,
                run_capability,
            )?;
        let frame =
            production_request_frame_from_bootstrap(bootstrap, operation_request_id, operation)?;
        self.host_services.kernel_operations_v2.prepare_operation(
            HostKernelOperationPreparedV2 {
                session_id: bootstrap.session_id.clone(),
                host_run_id: bootstrap.host_run_id.clone(),
                run_id: bootstrap.run_id.clone(),
                bootstrap_digest: bootstrap.bootstrap_digest.clone(),
                provider_profile_revision_digest: Some(
                    bootstrap
                        .provider_profile
                        .provider_profile_revision_digest
                        .clone(),
                ),
                operation_request_id: operation_request_id.to_string(),
                caller_correlation: None,
                production_frame: frame.clone(),
                recorded_at: crate::utils::now_text(),
            },
        )?;
        if let Some(settlement) = self.host_services.kernel_operations_v2.settlement(
            &bootstrap.session_id,
            &bootstrap.host_run_id,
            operation_request_id,
        )? {
            self.ensure_live_bridge(turn, bootstrap, run_capability)?;
            return Ok(completed_operation(settlement));
        }
        let operation_ref = operation_ref(bootstrap, operation_request_id);
        let attempt = self.prepare_dispatch_attempt(operation_ref.clone())?;
        let live = self.ensure_live_bridge(turn, bootstrap, run_capability)?;
        self.dispatch_prepared_operation(
            &live,
            operation_ref,
            attempt.attempt_id,
            attempt.owner_instance_id,
            frame,
        )
    }

    fn prepare_and_dispatch(
        &self,
        live: &Arc<HostKernelLiveBridgeV2>,
        operation: HostKernelOperationRefV2,
        frame: Value,
    ) -> Result<HostKernelOperationCompletionReceiverV2, HostV2StorageError> {
        let attempt = self.prepare_dispatch_attempt(operation.clone())?;
        self.dispatch_prepared_operation(
            live,
            operation,
            attempt.attempt_id,
            attempt.owner_instance_id,
            frame,
        )
    }

    fn prepare_dispatch_attempt(
        &self,
        operation: HostKernelOperationRefV2,
    ) -> Result<PreparedHostDispatchV2, HostV2StorageError> {
        let owner_instance_id = self.host_services.active_runs_v2.owner_instance_id();
        let attempt_id = self
            .host_services
            .kernel_operations_v2
            .issue_dispatch_attempt_id(&owner_instance_id)?;
        self.host_services
            .kernel_operations_v2
            .prepare_dispatch(HostKernelDispatchPrepareV2 {
                operation,
                attempt_id: attempt_id.clone(),
                owner_instance_id: owner_instance_id.clone(),
                prepared_at: crate::utils::now_text(),
            })?;
        Ok(PreparedHostDispatchV2 {
            attempt_id,
            owner_instance_id,
        })
    }

    fn prepare_lost_recovery_dispatch_attempt(
        &self,
        operation: HostKernelOperationRefV2,
        previous_attempt_id: String,
    ) -> Result<PreparedHostDispatchV2, HostV2StorageError> {
        let owner_instance_id = self.host_services.active_runs_v2.owner_instance_id();
        let attempt_id = self
            .host_services
            .kernel_operations_v2
            .issue_dispatch_attempt_id(&owner_instance_id)?;
        self.host_services
            .kernel_operations_v2
            .prepare_recovery_dispatch(HostKernelDispatchRecoveryV2 {
                operation,
                previous_attempt_id,
                attempt_id: attempt_id.clone(),
                owner_instance_id: owner_instance_id.clone(),
                prepared_at: crate::utils::now_text(),
            })?;
        Ok(PreparedHostDispatchV2 {
            attempt_id,
            owner_instance_id,
        })
    }

    fn prepare_response_retry_dispatch_attempt(
        &self,
        operation: HostKernelOperationRefV2,
        previous_attempt_id: String,
        retry_settlement: &HostKernelOperationSettlementV2,
    ) -> Result<PreparedHostDispatchV2, HostV2StorageError> {
        let owner_instance_id = self.host_services.active_runs_v2.owner_instance_id();
        let attempt_id = self
            .host_services
            .kernel_operations_v2
            .issue_dispatch_attempt_id(&owner_instance_id)?;
        self.host_services
            .kernel_operations_v2
            .prepare_response_retry_dispatch(
                HostKernelDispatchRecoveryV2 {
                    operation,
                    previous_attempt_id,
                    attempt_id: attempt_id.clone(),
                    owner_instance_id: owner_instance_id.clone(),
                    prepared_at: crate::utils::now_text(),
                },
                retry_settlement,
            )?;
        Ok(PreparedHostDispatchV2 {
            attempt_id,
            owner_instance_id,
        })
    }

    async fn await_operation_completion(
        &self,
        key: HostKernelLiveRunKeyV2,
        mut completion: HostKernelOperationCompletionReceiverV2,
    ) -> Result<HostKernelOperationSettlementReceiptV2, HostV2StorageError> {
        let deadline = tokio::time::Instant::now() + SESSION_KERNEL_RESPONSE_TIMEOUT_V2;
        let mut retry_backoff = RETRY_SAME_REQUEST_BACKOFF_V2;
        loop {
            let remaining = deadline
                .checked_duration_since(tokio::time::Instant::now())
                .ok_or_else(|| {
                    HostV2StorageError::io(
                        "host_kernel_bridge_response_timeout",
                        "Session bridge response remains pending after the bounded Host wait",
                    )
                })?;
            let outcome = match tokio::time::timeout(remaining, completion).await {
                Ok(Ok(result)) => result?,
                Ok(Err(_)) => {
                    return Err(HostV2StorageError::io(
                        "host_kernel_bridge_response_worker_stopped",
                        "Session bridge response worker stopped before settling the operation",
                    ))
                }
                Err(_) => {
                    return Err(HostV2StorageError::io(
                        "host_kernel_bridge_response_timeout",
                        "Session bridge response remains pending after the bounded Host wait",
                    ))
                }
            };
            match outcome {
                HostKernelOperationCompletionV2::Settled(settlement) => return Ok(settlement),
                HostKernelOperationCompletionV2::RetrySameRequest {
                    operation,
                    previous_attempt_id,
                    production_frame,
                    retry_settlement,
                } => {
                    if operation.session_id != key.session_id
                        || operation.host_run_id != key.host_run_id
                        || operation.run_id != key.run_id
                    {
                        return Err(HostV2StorageError::conflict(
                            "host_kernel_dispatch_retry_run_conflict",
                            "Response-bound retry changed its exact Run identity",
                        ));
                    }
                    let sleep_for = std::cmp::min(retry_backoff, remaining);
                    tokio::time::sleep(sleep_for).await;
                    if tokio::time::Instant::now() >= deadline {
                        return Err(HostV2StorageError::io(
                            "host_kernel_retry_recovery_waiting",
                            "The exact retrySameRequest directive remains replay-safe but exhausted the current Host operation deadline",
                        ));
                    }
                    let live = self.live_bridge(&key)?;
                    let prepared = self.prepare_response_retry_dispatch_attempt(
                        operation.clone(),
                        previous_attempt_id,
                        &retry_settlement,
                    )?;
                    completion = self.dispatch_prepared_operation(
                        &live,
                        operation,
                        prepared.attempt_id,
                        prepared.owner_instance_id,
                        production_frame,
                    )?;
                    retry_backoff = std::cmp::min(
                        retry_backoff.saturating_mul(2),
                        RETRY_SAME_REQUEST_MAX_BACKOFF_V2,
                    );
                }
            }
        }
    }

    fn dispatch_prepared_operation(
        &self,
        live: &Arc<HostKernelLiveBridgeV2>,
        operation: HostKernelOperationRefV2,
        attempt_id: String,
        owner_instance_id: String,
        frame: Value,
    ) -> Result<HostKernelOperationCompletionReceiverV2, HostV2StorageError> {
        if live.failed.load(Ordering::Acquire) {
            return Err(self.dispatch_prewrite_failure(
                &operation,
                &attempt_id,
                &owner_instance_id,
                HostV2StorageError::conflict(
                    "host_kernel_live_bridge_unavailable",
                    "Session bridge is not live; the prepared dispatch was not written",
                ),
                "bridge_not_live_before_write",
            ));
        }
        match live.child.try_wait() {
            Ok(None) => {}
            Ok(Some(_)) => {
                live.failed.store(true, Ordering::Release);
                return Err(self.dispatch_prewrite_failure(
                    &operation,
                    &attempt_id,
                    &owner_instance_id,
                    HostV2StorageError::conflict(
                        "host_kernel_live_bridge_exited",
                        "Session bridge exited before the operation was written",
                    ),
                    "bridge_exited_before_write",
                ));
            }
            Err(error) => {
                return Err(self.dispatch_prewrite_failure(
                    &operation,
                    &attempt_id,
                    &owner_instance_id,
                    error,
                    "bridge_status_unavailable_before_write",
                ))
            }
        }
        let mut payload = match serde_json::to_vec(&frame) {
            Ok(payload) => payload,
            Err(error) => {
                return Err(self.dispatch_prewrite_failure(
                    &operation,
                    &attempt_id,
                    &owner_instance_id,
                    HostV2StorageError::invalid(
                        "host_kernel_bridge_request_encode_failed",
                        format!("encode Host Kernel v2 bridge request: {error}"),
                    ),
                    "bridge_request_encode_failed",
                ))
            }
        };
        payload.push(b'\n');
        let (completion, receiver) = oneshot::channel();
        let mut pending = match live.pending.lock() {
            Ok(pending) => pending,
            Err(_) => {
                return Err(self.dispatch_prewrite_failure(
                    &operation,
                    &attempt_id,
                    &owner_instance_id,
                    HostV2StorageError::io(
                        "host_kernel_bridge_pending_registry_unavailable",
                        "Session bridge response correlation registry is unavailable",
                    ),
                    "bridge_response_registry_unavailable_before_write",
                ))
            }
        };
        if pending.contains_key(&operation.operation_request_id) {
            return Err(self.dispatch_prewrite_failure(
                &operation,
                &attempt_id,
                &owner_instance_id,
                HostV2StorageError::conflict(
                    "host_kernel_operation_already_in_flight",
                    "Operation request already has an unresolved live dispatch",
                ),
                "operation_already_in_flight_before_write",
            ));
        }
        let mut stdin = match live.stdin.lock() {
            Ok(stdin) => stdin,
            Err(_) => {
                return Err(self.dispatch_prewrite_failure(
                    &operation,
                    &attempt_id,
                    &owner_instance_id,
                    HostV2StorageError::io(
                        "host_kernel_bridge_v2_stdin_unavailable",
                        "Session bridge stdin owner is unavailable",
                    ),
                    "bridge_stdin_unavailable_before_write",
                ))
            }
        };
        let Some(writer) = stdin.as_mut() else {
            return Err(self.dispatch_prewrite_failure(
                &operation,
                &attempt_id,
                &owner_instance_id,
                HostV2StorageError::conflict(
                    "host_kernel_live_bridge_closed",
                    "Session bridge stdin is closed",
                ),
                "bridge_stdin_closed_before_write",
            ));
        };
        pending.insert(
            operation.operation_request_id.clone(),
            HostKernelPendingResponseV2 {
                operation: operation.clone(),
                attempt_id: attempt_id.clone(),
                owner_instance_id: owner_instance_id.clone(),
                production_frame: frame,
                completion,
            },
        );
        if let Err(error) = writer.write_all(&payload).and_then(|_| writer.flush()) {
            live.failed.store(true, Ordering::Release);
            stdin.take();
            let pending_response = pending.remove(&operation.operation_request_id);
            let persistence = self
                .host_services
                .kernel_operations_v2
                .mark_dispatch_indeterminate(
                    &operation,
                    &attempt_id,
                    &owner_instance_id,
                    &crate::utils::now_text(),
                    "bridge_write_outcome_unknown",
                );
            let dispatch_error = match persistence {
                Ok(_) => HostV2StorageError::io(
                    "host_kernel_bridge_v2_write_indeterminate",
                    format!("Session bridge write outcome is unknown: {error}"),
                ),
                Err(store_error) => HostV2StorageError::io(
                    "host_kernel_bridge_v2_write_cleanup_pending",
                    format!(
                        "Session bridge write failed and durable dispatch reconciliation failed with {}",
                        store_error.code
                    ),
                ),
            };
            if let Some(pending_response) = pending_response {
                let _ = pending_response
                    .completion
                    .send(Err(dispatch_error.clone()));
            }
            return Err(dispatch_error);
        }
        if let Err(error) = self
            .host_services
            .kernel_operations_v2
            .mark_dispatch_committed(
                &operation,
                &attempt_id,
                &owner_instance_id,
                &crate::utils::now_text(),
            )
        {
            live.failed.store(true, Ordering::Release);
            stdin.take();
            let pending_response = pending.remove(&operation.operation_request_id);
            let _ = self
                .host_services
                .kernel_operations_v2
                .mark_dispatch_indeterminate(
                    &operation,
                    &attempt_id,
                    &owner_instance_id,
                    &crate::utils::now_text(),
                    "dispatch_commit_persistence_failed",
                );
            let dispatch_error = HostV2StorageError::io(
                "host_kernel_dispatch_commit_cleanup_pending",
                format!(
                    "Session bridge write completed but durable dispatch commit failed with {}",
                    error.code
                ),
            );
            if let Some(pending_response) = pending_response {
                let _ = pending_response
                    .completion
                    .send(Err(dispatch_error.clone()));
            }
            return Err(dispatch_error);
        }
        drop(stdin);
        drop(pending);
        Ok(receiver)
    }

    fn dispatch_prewrite_failure(
        &self,
        operation: &HostKernelOperationRefV2,
        attempt_id: &str,
        owner_instance_id: &str,
        error: HostV2StorageError,
        reason_code: &str,
    ) -> HostV2StorageError {
        match self.host_services.kernel_operations_v2.mark_dispatch_lost(
            operation,
            attempt_id,
            owner_instance_id,
            &crate::utils::now_text(),
            reason_code,
        ) {
            Ok(_) => error,
            Err(cleanup_error) => HostV2StorageError::io(
                "host_kernel_dispatch_prewrite_cleanup_pending",
                format!(
                    "Dispatch failed before write with {}; durable Lost transition failed after {}",
                    error.code, cleanup_error.code
                ),
            ),
        }
    }

    fn ensure_live_bridge(
        &self,
        turn: &crate::host_run_broker_v2::HostSessionTurnGuardV2,
        bootstrap: &HostKernelBootstrapRecordV2,
        run_capability: &RunCapabilityV2,
    ) -> Result<Arc<HostKernelLiveBridgeV2>, HostV2StorageError> {
        let key = HostKernelLiveRunKeyV2 {
            session_id: bootstrap.session_id.clone(),
            host_run_id: bootstrap.host_run_id.clone(),
            run_id: bootstrap.run_id.clone(),
        };
        let expected_capability_digest: [u8; 32] =
            Sha256::digest(run_capability.expose_to_transport().as_bytes()).into();
        match self.live_bridge(&key) {
            Ok(live) => {
                if live.bootstrap_digest != bootstrap.bootstrap_digest {
                    return Err(HostV2StorageError::conflict(
                        "host_kernel_live_bridge_bootstrap_conflict",
                        "Live Session bridge does not match the durable Run bootstrap",
                    ));
                }
                let child_exited = live.child.try_wait()?.is_some();
                if child_exited {
                    live.failed.store(true, Ordering::Release);
                }
                let capability_changed = live.run_capability_digest != expected_capability_digest;
                if !live.failed.load(Ordering::Acquire) && !capability_changed {
                    return Ok(live);
                }
                let pending = live.pending.lock().map_err(|_| {
                    HostV2StorageError::io(
                        "host_kernel_bridge_pending_registry_unavailable",
                        "Session bridge response correlation registry is unavailable",
                    )
                })?;
                if !pending.is_empty() {
                    return Err(HostV2StorageError::io(
                        "host_kernel_live_bridge_recovery_waiting",
                        "Session bridge recovery is waiting for in-flight response correlation to settle",
                    ));
                }
                drop(pending);
                self.remove_live_bridge(&key)?;
                self.spawn_live_bridge(turn, bootstrap, run_capability)
            }
            Err(error) if error.code == "host_kernel_live_bridge_not_found" => {
                self.spawn_live_bridge(turn, bootstrap, run_capability)
            }
            Err(error) => Err(error),
        }
    }

    fn ensure_run_transport_capability(
        &self,
        turn: &crate::host_run_broker_v2::HostSessionTurnGuardV2,
        bootstrap: &HostKernelBootstrapRecordV2,
    ) -> Result<RunCapabilityV2, HostV2StorageError> {
        let capability = match self.host_services.active_runs_v2.run_transport_capability(
            &bootstrap.session_id,
            &bootstrap.host_run_id,
            &bootstrap.run_id,
        ) {
            Ok(capability) => capability,
            Err(error) if error.code == "host_run_transport_capability_invalid" => {
                let capability = self.resume_run_capability(bootstrap)?;
                self.host_services
                    .active_runs_v2
                    .bind_run_transport_capability(
                        turn,
                        &bootstrap.host_run_id,
                        &bootstrap.run_id,
                        &capability,
                    )?;
                capability
            }
            Err(error) => return Err(error),
        };
        self.host_services
            .session_kernel_v2
            .persist_tool_context_snapshot(
                &bootstrap.session_id,
                &bootstrap.run_id,
                &capability,
                &bootstrap.run_open_reply.tool_context,
            )?;
        Ok(capability)
    }

    fn spawn_live_bridge(
        &self,
        turn: &crate::host_run_broker_v2::HostSessionTurnGuardV2,
        bootstrap: &HostKernelBootstrapRecordV2,
        run_capability: &RunCapabilityV2,
    ) -> Result<Arc<HostKernelLiveBridgeV2>, HostV2StorageError> {
        let mut command = self.bridge_assets.verified_command()?;
        command
            .env_clear()
            .env(
                SESSION_KERNEL_RUN_CAPABILITY_ENV_V2,
                run_capability.expose_to_transport(),
            )
            .env(
                SESSION_KERNEL_API_BASE_ENV_V2,
                self.trusted_api_base.as_ref(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        copy_safe_bridge_environment(&mut command);
        let child = self.host_services.active_runs_v2.spawn_bridge_child(
            turn,
            &bootstrap.host_run_id,
            &mut command,
        )?;
        let stdin = child.take_stdin()?.ok_or_else(|| {
            HostV2StorageError::io(
                "host_kernel_bridge_v2_stdin_unavailable",
                "Session Kernel v2 bridge stdin is unavailable",
            )
        })?;
        let stdout = child.take_stdout()?.ok_or_else(|| {
            HostV2StorageError::io(
                "host_kernel_bridge_v2_stdout_unavailable",
                "Session Kernel v2 bridge stdout is unavailable",
            )
        })?;
        let stderr = child.take_stderr()?.ok_or_else(|| {
            HostV2StorageError::io(
                "host_kernel_bridge_v2_stderr_unavailable",
                "Session Kernel v2 bridge stderr is unavailable",
            )
        })?;
        let key = HostKernelLiveRunKeyV2 {
            session_id: bootstrap.session_id.clone(),
            host_run_id: bootstrap.host_run_id.clone(),
            run_id: bootstrap.run_id.clone(),
        };
        let live = Arc::new(HostKernelLiveBridgeV2 {
            bootstrap_digest: bootstrap.bootstrap_digest.clone(),
            run_capability_digest: Sha256::digest(run_capability.expose_to_transport().as_bytes())
                .into(),
            child,
            stdin: Arc::new(Mutex::new(Some(stdin))),
            pending: Arc::new(Mutex::new(HashMap::new())),
            failed: Arc::new(AtomicBool::new(false)),
            workers: Mutex::new(Vec::new()),
        });
        {
            let mut bridges = self
                .live_bridges
                .lock()
                .map_err(|_| live_registry_unavailable())?;
            if bridges
                .keys()
                .any(|existing| existing.session_id == key.session_id)
            {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_session_bridge_already_live",
                    "Session already owns a live Kernel bridge",
                ));
            }
            bridges.insert(key.clone(), Arc::clone(&live));
        }
        let response_worker = {
            let operation_store = self.host_services.kernel_operations_v2.clone();
            let result_store = self.host_services.session_kernel_v2.clone();
            let run_capability = run_capability.clone();
            let pending = Arc::clone(&live.pending);
            let stdin = Arc::clone(&live.stdin);
            let failed = Arc::clone(&live.failed);
            let live_bridges = Arc::clone(&self.live_bridges);
            let key = key.clone();
            thread::Builder::new()
                .name("deepcode-session-v2-response".to_string())
                .spawn(move || {
                    run_response_worker(
                        operation_store,
                        result_store,
                        run_capability,
                        key,
                        stdout,
                        pending,
                        stdin,
                        failed,
                        live_bridges,
                    );
                })
                .map_err(|error| {
                    HostV2StorageError::io(
                        "host_kernel_bridge_response_worker_failed",
                        format!("spawn Session bridge response worker: {error}"),
                    )
                })
        };
        let response_worker = match response_worker {
            Ok(worker) => worker,
            Err(error) => {
                let _ = self.remove_live_bridge(&key);
                return Err(error);
            }
        };
        live.workers
            .lock()
            .map_err(|_| live_registry_unavailable())?
            .push(response_worker);
        let stderr_worker = thread::Builder::new()
            .name("deepcode-session-v2-stderr".to_string())
            .spawn(move || drain_bridge_stderr(stderr))
            .map_err(|error| {
                HostV2StorageError::io(
                    "host_kernel_bridge_stderr_worker_failed",
                    format!("spawn Session bridge stderr drainer: {error}"),
                )
            });
        match stderr_worker {
            Ok(worker) => live
                .workers
                .lock()
                .map_err(|_| live_registry_unavailable())?
                .push(worker),
            Err(error) => {
                let _ = self.remove_live_bridge(&key);
                return Err(error);
            }
        }
        Ok(live)
    }

    fn live_bridge(
        &self,
        key: &HostKernelLiveRunKeyV2,
    ) -> Result<Arc<HostKernelLiveBridgeV2>, HostV2StorageError> {
        self.live_bridges
            .lock()
            .map_err(|_| live_registry_unavailable())?
            .get(key)
            .cloned()
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_kernel_live_bridge_not_found",
                    "Exact live Session Kernel bridge was not found",
                )
            })
    }

    fn remove_live_bridge(&self, key: &HostKernelLiveRunKeyV2) -> Result<bool, HostV2StorageError> {
        let live = self
            .live_bridges
            .lock()
            .map_err(|_| live_registry_unavailable())?
            .remove(key);
        let Some(live) = live else {
            return Ok(false);
        };
        live.shutdown()?;
        Ok(true)
    }

    fn abandon_opening_after_error(
        &self,
        opening: &HostKernelRunOpeningRecordV2,
        error: HostV2StorageError,
    ) -> HostV2StorageError {
        match self.host_services.kernel_operations_v2.abandon_opening(
            &opening.session_id,
            &opening.host_run_id,
            &opening.run_open_request_id,
            &opening.opening_digest,
            &crate::utils::now_text(),
        ) {
            Ok(_) => error,
            Err(cleanup_error) => cleanup_pending_error(&error, &cleanup_error),
        }
    }

    fn rollback_unactivated_run(
        &self,
        opening: &HostKernelRunOpeningRecordV2,
        reply: &RunOpenReplyV2,
        error: HostV2StorageError,
    ) -> HostV2StorageError {
        let retired = self.kernel_transport.service().retire_run_host(
            reply.run_id.clone(),
            RunRetirementReasonCodeV2::RunOpenRollback,
            Some(error.code.to_string()),
        );
        let abandoned = self.host_services.kernel_operations_v2.abandon_opening(
            &opening.session_id,
            &opening.host_run_id,
            &opening.run_open_request_id,
            &opening.opening_digest,
            &crate::utils::now_text(),
        );
        match (retired, abandoned) {
            (Ok(_), Ok(_)) => error,
            (Err(_), _) => HostV2StorageError::io(
                "host_kernel_run_start_cleanup_pending",
                format!(
                    "Host Kernel Run start failed with {}; Kernel retirement remains pending",
                    error.code
                ),
            ),
            (_, Err(cleanup_error)) => cleanup_pending_error(&error, &cleanup_error),
        }
    }

    fn rollback_activated_without_registration(
        &self,
        bootstrap: &HostKernelBootstrapRecordV2,
        error: HostV2StorageError,
    ) -> HostV2StorageError {
        let run_id = match RunId::new(bootstrap.run_id.clone()) {
            Ok(run_id) => run_id,
            Err(_) => return cleanup_pending_error(&error, &error),
        };
        let retired = self.kernel_transport.service().retire_run_host(
            run_id,
            RunRetirementReasonCodeV2::RunOpenRollback,
            Some(error.code.to_string()),
        );
        let stored = self.host_services.kernel_operations_v2.retire_active(
            &bootstrap.session_id,
            &bootstrap.host_run_id,
            &bootstrap.run_id,
            &bootstrap.bootstrap_digest,
            &crate::utils::now_text(),
        );
        match (retired, stored) {
            (Ok(_), Ok(_)) => error,
            (Err(_), _) => HostV2StorageError::io(
                "host_kernel_run_start_cleanup_pending",
                format!(
                    "Host Kernel Run start failed with {}; Kernel retirement remains pending",
                    error.code
                ),
            ),
            (_, Err(cleanup_error)) => cleanup_pending_error(&error, &cleanup_error),
        }
    }

    fn rollback_registered_run(
        &self,
        turn: &crate::host_run_broker_v2::HostSessionTurnGuardV2,
        bootstrap: &HostKernelBootstrapRecordV2,
        error: HostV2StorageError,
    ) -> HostV2StorageError {
        let key = HostKernelLiveRunKeyV2 {
            session_id: bootstrap.session_id.clone(),
            host_run_id: bootstrap.host_run_id.clone(),
            run_id: bootstrap.run_id.clone(),
        };
        let _ = self.remove_live_bridge(&key);
        let retired = self.host_services.retire_kernel_run_with_turn_v2(
            turn,
            &bootstrap.host_run_id,
            &bootstrap.run_id,
            RunRetirementReasonCodeV2::RunOpenRollback,
            Some(error.code),
        );
        let stored = self.host_services.kernel_operations_v2.retire_active(
            &bootstrap.session_id,
            &bootstrap.host_run_id,
            &bootstrap.run_id,
            &bootstrap.bootstrap_digest,
            &crate::utils::now_text(),
        );
        match (retired, stored) {
            (Ok(_), Ok(_)) => error,
            (Err(cleanup_error), _) | (_, Err(cleanup_error)) => {
                cleanup_pending_error(&error, &cleanup_error)
            }
        }
    }

    pub(crate) async fn retire_session_durable_run(
        &self,
        session_id: &str,
    ) -> Result<bool, HostV2StorageError> {
        let Some(live_run) = self
            .host_services
            .kernel_operations_v2
            .live_run_for_deletion(session_id)?
        else {
            return Ok(false);
        };
        match live_run {
            HostKernelLiveRunForDeletionV2::Opening(opening) => {
                self.retire_tombstoned_opening_run(&opening).await?
            }
            HostKernelLiveRunForDeletionV2::Active(bootstrap) => {
                self.retire_tombstoned_active_run(
                    &bootstrap,
                    RunRetirementReasonCodeV2::SessionEnded,
                )
                .await?
            }
        }
        Ok(true)
    }

    pub(crate) async fn verify_session_retired_for_deletion(
        &self,
        session_id: &str,
    ) -> Result<(), HostV2StorageError> {
        let _turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(session_id)
            .await?;
        if self
            .host_services
            .kernel_operations_v2
            .session_has_live_run(session_id)?
        {
            return Err(HostV2StorageError::conflict(
                "agent_session_kernel_retirement_pending",
                "Session still has an Opening or Active Host Kernel Run",
            ));
        }
        self.host_services
            .active_runs_v2
            .verify_session_has_no_run_residue(session_id)?;
        if self
            .live_bridges
            .lock()
            .map_err(|_| live_registry_unavailable())?
            .keys()
            .any(|key| key.session_id == session_id)
        {
            return Err(HostV2StorageError::conflict(
                "host_session_live_bridge_retirement_pending",
                "Session still has a live Kernel bridge registry entry",
            ));
        }
        Ok(())
    }

    /// Rebinds cold Runs and resumes only dispatches whose durable evidence
    /// proves that no prior write crossed the effect boundary. A missing
    /// attempt is a first dispatch, and `Lost` proves pre-write failure.
    /// `ResponseObserved` is settled from its durable response without another
    /// dispatch. `Indeterminate` always remains blocked for explicit fact
    /// reconciliation.
    pub(crate) async fn reconcile_startup(
        &self,
        recoverable_session_ids: &std::collections::HashSet<String>,
        deletion_tombstones: &std::collections::HashSet<String>,
    ) -> Result<HostKernelStartupReconciliationOutcomeV2, HostV2StorageError> {
        if !self
            .live_bridges
            .lock()
            .map_err(|_| live_registry_unavailable())?
            .is_empty()
        {
            return Err(HostV2StorageError::conflict(
                "host_kernel_startup_reconciliation_not_cold",
                "Startup reconciliation requires an empty live bridge registry",
            ));
        }
        let reconciled_at = crate::utils::now_text();
        let mut recovery_status = HostKernelStartupRecoveryStatusV2::pending();
        recovery_status.phase = HostKernelStartupRecoveryPhaseV2::Reconciling;
        recovery_status.reconciled_at = Some(reconciled_at.clone());
        self.replace_startup_recovery_status(recovery_status.clone())?;
        let reconciliation = match self.host_services.kernel_operations_v2.reconcile_startup(
            &reconciled_at,
            recoverable_session_ids,
            deletion_tombstones,
        ) {
            Ok(reconciliation) => reconciliation,
            Err(error) => {
                recovery_status.record_error(error.code);
                recovery_status.refresh_phase();
                self.replace_startup_recovery_status(recovery_status)?;
                return Err(error);
            }
        };
        recovery_status.opening_run_count = reconciliation.opening_runs.len();
        recovery_status.active_run_count = reconciliation.active_runs.len();
        recovery_status.attempts_marked_indeterminate =
            reconciliation.attempts_marked_indeterminate;
        let mut tombstone_failures = Vec::new();
        for (session_id, _) in &reconciliation.unsupported_history_runs {
            recovery_status.record_error("unsupported_history_schema");
            self.host_services
                .active_runs_v2
                .record_startup_error("unsupported_history_schema");
            if deletion_tombstones.contains(session_id) {
                record_startup_tombstone_failure(
                    &mut tombstone_failures,
                    session_id,
                    HostV2StorageError::conflict(
                        "unsupported_history_schema",
                        "Deletion tombstone refers to an unsupported Host Kernel Run history",
                    ),
                );
            }
        }

        for cancellation in &reconciliation.cancel_recoveries {
            if deletion_tombstones.contains(&cancellation.bootstrap.session_id) {
                if let Err(error) = self
                    .retire_tombstoned_active_run(
                        &cancellation.bootstrap,
                        RunRetirementReasonCodeV2::HostRequested,
                    )
                    .await
                {
                    recovery_status.record_error(error.code);
                    self.host_services
                        .active_runs_v2
                        .record_startup_error(error.code);
                    if let Some(operation) = &cancellation.pending_operation {
                        recovery_status.operations.push(startup_operation_status(
                            operation,
                            HostKernelOperationRecoveryStateV2::RecoveryFailed,
                            Some(error.code),
                        ));
                    }
                    record_startup_tombstone_failure(
                        &mut tombstone_failures,
                        &cancellation.bootstrap.session_id,
                        error,
                    );
                }
                continue;
            }
            match self.recover_startup_cancel(cancellation).await {
                Ok(HostKernelStartupCancelDispositionV2::CanonicalRetired) => {
                    if let Some(operation) = &cancellation.pending_operation {
                        recovery_status.operations.push(startup_operation_status(
                            operation,
                            HostKernelOperationRecoveryStateV2::CancellationEvidenceRecoveredAndRetired,
                            None,
                        ));
                    }
                }
                Ok(HostKernelStartupCancelDispositionV2::SafetyRetired {
                    evidence_error_code,
                }) => {
                    let safety_code = "host_kernel_cancel_startup_safety_retired";
                    recovery_status.record_error(evidence_error_code);
                    recovery_status.record_error(safety_code);
                    self.host_services
                        .active_runs_v2
                        .record_startup_error(evidence_error_code);
                    self.host_services
                        .active_runs_v2
                        .record_startup_error(safety_code);
                    if let Some(operation) = &cancellation.pending_operation {
                        recovery_status.operations.push(startup_operation_status(
                            operation,
                            HostKernelOperationRecoveryStateV2::CancellationSafetyRetired,
                            Some(evidence_error_code),
                        ));
                    }
                }
                Err(error) => {
                    recovery_status.record_error(error.code);
                    self.host_services
                        .active_runs_v2
                        .record_startup_error(error.code);
                    if let Some(operation) = &cancellation.pending_operation {
                        recovery_status.operations.push(startup_operation_status(
                            operation,
                            HostKernelOperationRecoveryStateV2::RecoveryFailed,
                            Some(error.code),
                        ));
                    }
                }
            }
        }

        for opening in &reconciliation.opening_runs {
            if deletion_tombstones.contains(&opening.session_id) {
                if let Err(error) = self.retire_tombstoned_opening_run(opening).await {
                    recovery_status.record_error(error.code);
                    self.host_services
                        .active_runs_v2
                        .record_startup_error(error.code);
                    record_startup_tombstone_failure(
                        &mut tombstone_failures,
                        &opening.session_id,
                        error,
                    );
                }
                continue;
            }
            if let Err(error) = self.recover_opening_run(opening).await {
                recovery_status.record_error(error.code);
                self.host_services
                    .active_runs_v2
                    .record_startup_error(error.code);
            }
        }
        let mut pending_by_run =
            HashMap::<(String, String), Vec<HostKernelPendingOperationV2>>::new();
        for operation in reconciliation.pending_operations.iter().cloned() {
            pending_by_run
                .entry((operation.session_id.clone(), operation.host_run_id.clone()))
                .or_default()
                .push(operation);
        }
        let mut continuation_ready_runs =
            HashMap::<(String, String), HostKernelStartupContinuationRunV2>::new();
        let mut recovered_dispatches = Vec::<(
            String,
            String,
            String,
            String,
            HostKernelOperationCompletionReceiverV2,
        )>::new();
        for bootstrap in &reconciliation.active_runs {
            let run_key = (bootstrap.session_id.clone(), bootstrap.host_run_id.clone());
            let pending = pending_by_run.remove(&run_key).unwrap_or_default();
            if deletion_tombstones.contains(&bootstrap.session_id) {
                if let Err(error) = self
                    .retire_tombstoned_active_run(
                        bootstrap,
                        RunRetirementReasonCodeV2::SessionEnded,
                    )
                    .await
                {
                    recovery_status.record_error(error.code);
                    self.host_services
                        .active_runs_v2
                        .record_startup_error(error.code);
                    recovery_status
                        .operations
                        .extend(pending.iter().map(|operation| {
                            startup_operation_status(
                                operation,
                                HostKernelOperationRecoveryStateV2::RecoveryFailed,
                                Some(error.code),
                            )
                        }));
                    record_startup_tombstone_failure(
                        &mut tombstone_failures,
                        &bootstrap.session_id,
                        error,
                    );
                }
                continue;
            }
            let mut unresolved = Vec::new();
            let mut observation_failure = None;
            for operation in pending {
                if operation.latest_attempt.as_ref().is_some_and(|attempt| {
                    attempt.state == HostKernelDispatchAttemptStateV2::ResponseObserved
                }) {
                    let observed_settlement = self.observed_operation_settlement(&operation);
                    if observed_settlement
                        .as_ref()
                        .is_ok_and(is_retry_same_request_settlement)
                    {
                        unresolved.push(operation);
                        continue;
                    }
                    match self.settle_observed_operation(&operation) {
                        Ok(_) => recovery_status.operations.push(startup_operation_status(
                            &operation,
                            HostKernelOperationRecoveryStateV2::ObservedResponseSettled,
                            None,
                        )),
                        Err(error) => {
                            recovery_status.record_error(error.code);
                            self.host_services
                                .active_runs_v2
                                .record_startup_error(error.code);
                            recovery_status.operations.push(startup_operation_status(
                                &operation,
                                HostKernelOperationRecoveryStateV2::RecoveryFailed,
                                Some(error.code),
                            ));
                            observation_failure = Some(error.code);
                        }
                    }
                } else {
                    unresolved.push(operation);
                }
            }
            if let Some(error_code) = observation_failure {
                recovery_status
                    .operations
                    .extend(unresolved.iter().map(|operation| {
                        startup_operation_status(
                            operation,
                            HostKernelOperationRecoveryStateV2::BlockedByRecoveryFailure,
                            Some(error_code),
                        )
                    }));
                continue;
            }
            if unresolved.iter().any(|operation| {
                operation.latest_attempt.as_ref().is_some_and(|attempt| {
                    attempt.state == HostKernelDispatchAttemptStateV2::Indeterminate
                })
            }) {
                let error_code =
                    "host_kernel_dispatch_indeterminate_manual_reconciliation_required";
                recovery_status.record_error(error_code);
                self.host_services
                    .active_runs_v2
                    .record_startup_error(error_code);
                recovery_status
                    .operations
                    .extend(unresolved.iter().map(|operation| {
                        let state = if operation.latest_attempt.as_ref().is_some_and(|attempt| {
                            attempt.state == HostKernelDispatchAttemptStateV2::Indeterminate
                        }) {
                            HostKernelOperationRecoveryStateV2::BlockedIndeterminate
                        } else {
                            HostKernelOperationRecoveryStateV2::BlockedByIndeterminate
                        };
                        startup_operation_status(operation, state, Some(error_code))
                    }));
                continue;
            }
            if unresolved.iter().any(|operation| {
                operation.latest_attempt.as_ref().is_some_and(|attempt| {
                    matches!(
                        attempt.state,
                        HostKernelDispatchAttemptStateV2::Prepared
                            | HostKernelDispatchAttemptStateV2::Committed
                            | HostKernelDispatchAttemptStateV2::Settled
                    )
                })
            }) {
                let error_code = "host_kernel_pending_attempt_state_invalid";
                recovery_status.record_error(error_code);
                self.host_services
                    .active_runs_v2
                    .record_startup_error(error_code);
                recovery_status
                    .operations
                    .extend(unresolved.iter().map(|operation| {
                        startup_operation_status(
                            operation,
                            HostKernelOperationRecoveryStateV2::RecoveryFailed,
                            Some(error_code),
                        )
                    }));
                continue;
            }
            let dispatchable = unresolved;

            if let Err(error) = self.recover_active_run(bootstrap).await {
                recovery_status.record_error(error.code);
                self.host_services
                    .active_runs_v2
                    .record_startup_error(error.code);
                recovery_status
                    .operations
                    .extend(dispatchable.iter().map(|operation| {
                        startup_operation_status(
                            operation,
                            HostKernelOperationRecoveryStateV2::RecoveryFailed,
                            Some(error.code),
                        )
                    }));
                continue;
            }
            continuation_ready_runs.insert(
                run_key.clone(),
                HostKernelStartupContinuationRunV2 {
                    session_id: bootstrap.session_id.clone(),
                    host_run_id: bootstrap.host_run_id.clone(),
                    run_id: bootstrap.run_id.clone(),
                    bootstrap_digest: bootstrap.bootstrap_digest.clone(),
                },
            );
            if dispatchable.is_empty() {
                continue;
            }
            let live_key = HostKernelLiveRunKeyV2 {
                session_id: bootstrap.session_id.clone(),
                host_run_id: bootstrap.host_run_id.clone(),
                run_id: bootstrap.run_id.clone(),
            };
            let live = match self.live_bridge(&live_key) {
                Ok(live) => live,
                Err(error) => {
                    continuation_ready_runs.remove(&run_key);
                    recovery_status.record_error(error.code);
                    self.host_services
                        .active_runs_v2
                        .record_startup_error(error.code);
                    recovery_status
                        .operations
                        .extend(dispatchable.iter().map(|operation| {
                            startup_operation_status(
                                operation,
                                HostKernelOperationRecoveryStateV2::RecoveryFailed,
                                Some(error.code),
                            )
                        }));
                    continue;
                }
            };
            let mut blocked_after_failure = None;
            for operation in dispatchable {
                if let Some(error_code) = blocked_after_failure {
                    recovery_status.operations.push(startup_operation_status(
                        &operation,
                        HostKernelOperationRecoveryStateV2::BlockedByRecoveryFailure,
                        Some(error_code),
                    ));
                    continue;
                }
                let operation_ref = pending_operation_ref(&operation);
                let (prepared, state) = match operation.latest_attempt.as_ref() {
                    None => (
                        self.prepare_dispatch_attempt(operation_ref.clone()),
                        HostKernelOperationRecoveryStateV2::FirstDispatchResumed,
                    ),
                    Some(attempt) if attempt.state == HostKernelDispatchAttemptStateV2::Lost => (
                        self.prepare_lost_recovery_dispatch_attempt(
                            operation_ref.clone(),
                            attempt.attempt_id.clone(),
                        ),
                        HostKernelOperationRecoveryStateV2::LostDispatchResumed,
                    ),
                    Some(attempt)
                        if attempt.state == HostKernelDispatchAttemptStateV2::ResponseObserved =>
                    {
                        let settlement = self.observed_operation_settlement(&operation);
                        (
                            settlement.and_then(|settlement| {
                                self.prepare_response_retry_dispatch_attempt(
                                    operation_ref.clone(),
                                    attempt.attempt_id.clone(),
                                    &settlement,
                                )
                            }),
                            HostKernelOperationRecoveryStateV2::RetrySameRequestResumed,
                        )
                    }
                    Some(_) => {
                        continuation_ready_runs.remove(&run_key);
                        let error_code = "host_kernel_pending_attempt_state_invalid";
                        recovery_status.record_error(error_code);
                        self.host_services
                            .active_runs_v2
                            .record_startup_error(error_code);
                        recovery_status.operations.push(startup_operation_status(
                            &operation,
                            HostKernelOperationRecoveryStateV2::RecoveryFailed,
                            Some(error_code),
                        ));
                        blocked_after_failure = Some(error_code);
                        continue;
                    }
                };
                let prepared = match prepared {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        continuation_ready_runs.remove(&run_key);
                        recovery_status.record_error(error.code);
                        self.host_services
                            .active_runs_v2
                            .record_startup_error(error.code);
                        recovery_status.operations.push(startup_operation_status(
                            &operation,
                            HostKernelOperationRecoveryStateV2::RecoveryFailed,
                            Some(error.code),
                        ));
                        blocked_after_failure = Some(error.code);
                        continue;
                    }
                };
                match self.dispatch_prepared_operation(
                    &live,
                    operation_ref,
                    prepared.attempt_id,
                    prepared.owner_instance_id,
                    operation.production_frame.clone(),
                ) {
                    Ok(completion) => {
                        recovery_status
                            .operations
                            .push(startup_operation_status(&operation, state, None));
                        recovery_status.pending_dispatch_count += 1;
                        recovered_dispatches.push((
                            operation.session_id,
                            operation.host_run_id,
                            operation.run_id,
                            operation.operation_request_id,
                            completion,
                        ));
                    }
                    Err(error) => {
                        continuation_ready_runs.remove(&run_key);
                        recovery_status.record_error(error.code);
                        self.host_services
                            .active_runs_v2
                            .record_startup_error(error.code);
                        recovery_status.operations.push(startup_operation_status(
                            &operation,
                            HostKernelOperationRecoveryStateV2::RecoveryFailed,
                            Some(error.code),
                        ));
                        blocked_after_failure = Some(error.code);
                    }
                }
            }
            if blocked_after_failure.is_some() {
                if let Err(cleanup_error) = self.remove_live_bridge(&live_key) {
                    recovery_status.record_error(cleanup_error.code);
                    self.host_services
                        .active_runs_v2
                        .record_startup_error(cleanup_error.code);
                }
            }
        }
        if !pending_by_run.is_empty() {
            let error_code = "host_kernel_pending_operation_run_missing";
            recovery_status.record_error(error_code);
            self.host_services
                .active_runs_v2
                .record_startup_error(error_code);
            for operations in pending_by_run.into_values() {
                recovery_status
                    .operations
                    .extend(operations.iter().map(|operation| {
                        startup_operation_status(
                            operation,
                            HostKernelOperationRecoveryStateV2::RecoveryFailed,
                            Some(error_code),
                        )
                    }));
            }
        }
        recovery_status.refresh_phase();
        self.replace_startup_recovery_status(recovery_status)?;
        for (session_id, host_run_id, run_id, operation_request_id, completion) in
            recovered_dispatches
        {
            let key = HostKernelLiveRunKeyV2 {
                session_id: session_id.clone(),
                host_run_id: host_run_id.clone(),
                run_id: run_id.clone(),
            };
            let result = self
                .await_operation_completion(key.clone(), completion)
                .await;
            if result.is_err() {
                continuation_ready_runs.remove(&(session_id.clone(), host_run_id.clone()));
                if let Err(cleanup_error) = self.remove_live_bridge(&key) {
                    self.host_services
                        .active_runs_v2
                        .record_startup_error(cleanup_error.code);
                }
            }
            complete_startup_recovery_dispatch(
                &self.startup_recovery,
                &self.host_services.active_runs_v2,
                &session_id,
                &host_run_id,
                &operation_request_id,
                result.as_ref().err().map(|error| error.code),
            );
        }
        Ok(HostKernelStartupReconciliationOutcomeV2 {
            tombstone_failures,
            continuation_ready_runs: continuation_ready_runs.into_values().collect(),
        })
    }

    async fn retire_tombstoned_opening_run(
        &self,
        opening: &HostKernelRunOpeningRecordV2,
    ) -> Result<(), HostV2StorageError> {
        let _turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(&opening.session_id)
            .await?;
        let (response, _capability) = self
            .kernel_transport
            .open_run_host_with_settings(
                opening.run_open_envelope.clone(),
                self.resolve_recovery_settings(
                    opening.workspace_kind,
                    &opening.workspace_binding_ref,
                )?,
            )
            .map_err(workspace_resolve_error)?;
        let exact_reply = run_open_reply(response, &opening.run_open_request_id)?;
        self.kernel_transport
            .service()
            .retire_run_host(
                exact_reply.run_id,
                RunRetirementReasonCodeV2::SessionEnded,
                None,
            )
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_kernel_tombstone_opening_retirement_pending",
                    "Deletion tombstone RunOpen was recovered, but its Kernel Run could not be retired",
                )
            })?;
        self.host_services.kernel_operations_v2.abandon_opening(
            &opening.session_id,
            &opening.host_run_id,
            &opening.run_open_request_id,
            &opening.opening_digest,
            &crate::utils::now_text(),
        )?;
        Ok(())
    }

    async fn retire_tombstoned_active_run(
        &self,
        bootstrap: &HostKernelBootstrapRecordV2,
        retirement_reason: RunRetirementReasonCodeV2,
    ) -> Result<(), HostV2StorageError> {
        let turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(&bootstrap.session_id)
            .await?;
        self.retire_run_with_turn_and_caller_correlation(
            &turn,
            &bootstrap.session_id,
            &bootstrap.host_run_id,
            &bootstrap.run_id,
            retirement_reason,
            None,
            true,
        )?;
        Ok(())
    }

    async fn recover_startup_cancel(
        &self,
        recovery: &HostKernelStartupCancelRecoveryV2,
    ) -> Result<HostKernelStartupCancelDispositionV2, HostV2StorageError> {
        let canonical = self
            .recover_startup_cancel_settlement(recovery)
            .and_then(|settlement| {
                self.validate_cancel_run_settlement_against_kernel(
                    &settlement,
                    &recovery.bootstrap.session_id,
                    &recovery.bootstrap.host_run_id,
                    &recovery.bootstrap.run_id,
                    &recovery.binding.caller_request_id,
                    &recovery.binding.request_digest,
                    &recovery.cancel_operation_id,
                )
            })
            .and_then(|acknowledgement| {
                self.host_services
                    .projection_v2
                    .require_durable_run_cancelled_projection(
                        &recovery.bootstrap.session_id,
                        &recovery.bootstrap.host_run_id,
                        &recovery.bootstrap.run_id,
                        &acknowledgement.projection_id,
                        &acknowledgement.projection_digest,
                        &acknowledgement.projection_data,
                    )
            });
        let turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(&recovery.bootstrap.session_id)
            .await?;
        match canonical {
            Ok(()) => {
                self.retire_run_with_turn_and_caller_correlation(
                    &turn,
                    &recovery.bootstrap.session_id,
                    &recovery.bootstrap.host_run_id,
                    &recovery.bootstrap.run_id,
                    RunRetirementReasonCodeV2::HostRequested,
                    Some((
                        &recovery.binding.caller_request_id,
                        &recovery.binding.request_digest,
                    )),
                    true,
                )
                .map_err(|error| {
                    HostV2StorageError::io(
                        "host_kernel_cancel_startup_retirement_pending",
                        format!(
                            "Canonical startup cancellation was recovered, but Host retirement remains pending after {}",
                            error.code
                        ),
                    )
                })?;
                Ok(HostKernelStartupCancelDispositionV2::CanonicalRetired)
            }
            Err(evidence_error) => {
                self.retire_run_with_turn_and_caller_correlation(
                    &turn,
                    &recovery.bootstrap.session_id,
                    &recovery.bootstrap.host_run_id,
                    &recovery.bootstrap.run_id,
                    RunRetirementReasonCodeV2::HostRequested,
                    None,
                    true,
                )
                .map_err(|retirement_error| {
                    HostV2StorageError::io(
                        "host_kernel_cancel_startup_safety_retirement_pending",
                        format!(
                            "Cancellation recovery evidence is incomplete after {}; safety retirement remains pending after {}",
                            evidence_error.code, retirement_error.code
                        ),
                    )
                })?;
                Ok(HostKernelStartupCancelDispositionV2::SafetyRetired {
                    evidence_error_code: evidence_error.code,
                })
            }
        }
    }

    fn recover_startup_cancel_settlement(
        &self,
        recovery: &HostKernelStartupCancelRecoveryV2,
    ) -> Result<HostKernelOperationSettlementReceiptV2, HostV2StorageError> {
        if let Some(settlement) = &recovery.settlement {
            return Ok(settlement.clone());
        }
        let operation = recovery.pending_operation.as_ref().ok_or_else(|| {
            HostV2StorageError::not_found(
                "host_kernel_cancel_startup_operation_missing",
                "Driving cancellation has no durable Session operation",
            )
        })?;
        let attempt = operation.latest_attempt.as_ref().ok_or_else(|| {
            HostV2StorageError::not_found(
                "host_kernel_cancel_startup_attempt_missing",
                "Driving cancellation has no durable dispatch attempt",
            )
        })?;
        if attempt.state == HostKernelDispatchAttemptStateV2::ResponseObserved {
            return self.settle_observed_operation(operation);
        }
        if !matches!(
            attempt.state,
            HostKernelDispatchAttemptStateV2::Committed
                | HostKernelDispatchAttemptStateV2::Indeterminate
        ) {
            return Err(HostV2StorageError::conflict(
                "host_kernel_cancel_startup_attempt_unproven",
                "Cancellation dispatch has no recoverable post-write response evidence",
            ));
        }
        let response = self
            .host_services
            .session_kernel_v2
            .recover_operation_result_for_host(
                &operation.session_id,
                &operation.run_id,
                &operation.operation_request_id,
            )?
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "session_kernel_cancel_operation_result_missing",
                    "Cancellation response is not durable in the Session operation-result store",
                )
            })?;
        let operation_ref = pending_operation_ref(operation);
        self.host_services.kernel_operations_v2.observe_response(
            &operation_ref,
            &attempt.attempt_id,
            &attempt.owner_instance_id,
            response.clone(),
            &crate::utils::now_text(),
        )?;
        let key = HostKernelLiveRunKeyV2 {
            session_id: operation.session_id.clone(),
            host_run_id: operation.host_run_id.clone(),
            run_id: operation.run_id.clone(),
        };
        let settlement = settlement_from_observed_response(&key, &response)?;
        self.host_services.kernel_operations_v2.settle_operation(
            &operation_ref,
            &attempt.attempt_id,
            &attempt.owner_instance_id,
            settlement,
            &crate::utils::now_text(),
        )
    }

    fn settle_observed_operation(
        &self,
        operation: &HostKernelPendingOperationV2,
    ) -> Result<HostKernelOperationSettlementReceiptV2, HostV2StorageError> {
        let attempt = operation.latest_attempt.as_ref().ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_kernel_observed_response_attempt_missing",
                "Observed response recovery has no durable dispatch attempt",
            )
        })?;
        if attempt.state != HostKernelDispatchAttemptStateV2::ResponseObserved {
            return Err(HostV2StorageError::conflict(
                "host_kernel_observed_response_state_invalid",
                "Only a ResponseObserved attempt can be settled without dispatch",
            ));
        }
        let settlement = self.observed_operation_settlement(operation)?;
        self.host_services.kernel_operations_v2.settle_operation(
            &pending_operation_ref(operation),
            &attempt.attempt_id,
            &attempt.owner_instance_id,
            settlement,
            &crate::utils::now_text(),
        )
    }

    fn observed_operation_settlement(
        &self,
        operation: &HostKernelPendingOperationV2,
    ) -> Result<HostKernelOperationSettlementV2, HostV2StorageError> {
        let attempt = operation.latest_attempt.as_ref().ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_kernel_observed_response_attempt_missing",
                "Observed response recovery has no durable dispatch attempt",
            )
        })?;
        if attempt.state != HostKernelDispatchAttemptStateV2::ResponseObserved {
            return Err(HostV2StorageError::conflict(
                "host_kernel_observed_response_state_invalid",
                "Only a ResponseObserved attempt has a durable retry or settlement boundary",
            ));
        }
        let response = attempt.observed_response.as_ref().ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_kernel_observed_response_missing",
                "ResponseObserved recovery has no durable response evidence",
            )
        })?;
        let live_key = HostKernelLiveRunKeyV2 {
            session_id: operation.session_id.clone(),
            host_run_id: operation.host_run_id.clone(),
            run_id: operation.run_id.clone(),
        };
        settlement_from_observed_response(&live_key, response)
    }

    async fn recover_opening_run(
        &self,
        opening: &HostKernelRunOpeningRecordV2,
    ) -> Result<(), HostV2StorageError> {
        let turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(&opening.session_id)
            .await?;
        let (response, capability) = self
            .kernel_transport
            .open_run_host_with_settings(
                opening.run_open_envelope.clone(),
                self.resolve_recovery_settings(
                    opening.workspace_kind,
                    &opening.workspace_binding_ref,
                )?,
            )
            .map_err(workspace_resolve_error)?;
        let exact_reply = run_open_reply(response, &opening.run_open_request_id)?;
        let bootstrap = self
            .host_services
            .kernel_operations_v2
            .activate_bootstrap(HostKernelBootstrapActivationV2 {
                session_id: opening.session_id.clone(),
                host_run_id: opening.host_run_id.clone(),
                run_open_request_id: opening.run_open_request_id.clone(),
                run_open_reply: exact_reply,
                activated_at: crate::utils::now_text(),
            })?
            .record;
        let registration = self.host_services.active_runs_v2.register(
            &turn,
            active_registration_from_bootstrap(&bootstrap),
            active_workspace_root_for_registration(&bootstrap)?,
        )?;
        require_cold_bridge_ownership(&registration.record)?;
        let capability = match capability {
            Some(capability) => capability,
            None => self.resume_run_capability(&bootstrap)?,
        };
        self.host_services
            .active_runs_v2
            .bind_run_transport_capability(
                &turn,
                &bootstrap.host_run_id,
                &bootstrap.run_id,
                &capability,
            )?;
        self.host_services
            .session_kernel_v2
            .persist_tool_context_snapshot(
                &bootstrap.session_id,
                &bootstrap.run_id,
                &capability,
                &bootstrap.run_open_reply.tool_context,
            )?;
        self.ensure_live_bridge(&turn, &bootstrap, &capability)?;
        Ok(())
    }

    async fn recover_active_run(
        &self,
        bootstrap: &HostKernelBootstrapRecordV2,
    ) -> Result<(), HostV2StorageError> {
        let turn = self
            .host_services
            .active_runs_v2
            .begin_session_turn(&bootstrap.session_id)
            .await?;
        let registration = self.host_services.active_runs_v2.register(
            &turn,
            active_registration_from_bootstrap(bootstrap),
            active_workspace_root_for_registration(bootstrap)?,
        )?;
        require_cold_bridge_ownership(&registration.record)?;
        let capability = self.resume_run_capability(bootstrap)?;
        self.host_services
            .active_runs_v2
            .bind_run_transport_capability(
                &turn,
                &bootstrap.host_run_id,
                &bootstrap.run_id,
                &capability,
            )?;
        self.host_services
            .session_kernel_v2
            .persist_tool_context_snapshot(
                &bootstrap.session_id,
                &bootstrap.run_id,
                &capability,
                &bootstrap.run_open_reply.tool_context,
            )?;
        self.ensure_live_bridge(&turn, bootstrap, &capability)?;
        Ok(())
    }

    fn resume_run_capability(
        &self,
        bootstrap: &HostKernelBootstrapRecordV2,
    ) -> Result<RunCapabilityV2, HostV2StorageError> {
        let run_id = RunId::new(bootstrap.run_id.clone()).map_err(|_| {
            HostV2StorageError::conflict(
                "host_kernel_recovery_run_id_invalid",
                "Durable Host bootstrap contains an invalid Kernel Run identity",
            )
        })?;
        let workspace_binding_ref =
            WorkspaceBindingRefV2::new(bootstrap.workspace_binding_ref.clone()).map_err(|_| {
                HostV2StorageError::conflict(
                    "host_kernel_recovery_workspace_binding_invalid",
                    "Durable Host bootstrap contains an invalid workspace binding reference",
                )
            })?;
        let workspace_root = self
            .kernel_transport
            .workspace_resolver()
            .resolve_workspace_binding(&workspace_binding_ref)
            .map_err(workspace_resolve_error)?;
        let run_settings = self.resolve_recovery_settings(
            bootstrap.workspace_kind,
            &bootstrap.workspace_binding_ref,
        )?;
        if !workspace_root.is_absolute() {
            return Err(HostV2StorageError::conflict(
                "host_kernel_recovery_workspace_root_invalid",
                "Recovered workspace binding did not resolve to an absolute root",
            ));
        }
        let resumed = self
            .kernel_transport
            .service()
            .resume_run_host(run_id, workspace_binding_ref, &workspace_root, run_settings)
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_kernel_run_resume_failed",
                    "Kernel rejected Host-only Run transport recovery",
                )
            })?;
        let (reply, capability, _transport_generation, _disposition) = resumed.into_parts();
        reply.validate().map_err(|_| {
            HostV2StorageError::conflict(
                "host_kernel_run_resume_reply_invalid",
                "Kernel Host recovery returned an invalid public Run reply",
            )
        })?;
        if reply.run_id.as_str() != bootstrap.run_id
            || reply.workspace_binding_digest.as_str() != bootstrap.workspace_binding_digest
        {
            return Err(HostV2StorageError::conflict(
                "host_kernel_run_resume_identity_conflict",
                "Kernel Host recovery did not match the immutable durable Run identity",
            ));
        }
        Ok(capability)
    }

    fn resolve_recovery_settings(
        &self,
        workspace_kind: HostRunWorkspaceKindV2,
        workspace_binding_ref: &str,
    ) -> Result<SettingsCeilingV2, HostV2StorageError> {
        if workspace_kind == HostRunWorkspaceKindV2::Empty {
            return Ok(SettingsCeilingV2 {
                workspace_read: false,
                workspace_write: false,
                web_read: false,
                auto_approve_plans: false,
            });
        }
        let workspace_binding_ref = WorkspaceBindingRefV2::new(workspace_binding_ref.to_string())
            .map_err(|_| {
            HostV2StorageError::conflict(
                "host_kernel_recovery_workspace_binding_invalid",
                "Durable Host bootstrap contains an invalid workspace binding reference",
            )
        })?;
        self.kernel_transport
            .settings_resolver()
            .resolve_run_settings(&workspace_binding_ref)
            .map_err(workspace_resolve_error)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelRunSpawnInputV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) caller_request_id: String,
    pub(crate) caller_request_digest: String,
    pub(crate) run_open_request_id: String,
    pub(crate) operation_request_id: String,
    pub(crate) provider_profile: HostProviderProfileBootstrapV2,
    pub(crate) prior_session_events: HostSessionPriorEventsV2,
    pub(crate) workspace: HostKernelRunWorkspaceV2,
    pub(crate) initial_input: HostKernelInitialInputV2,
    pub(crate) operation: HostKernelBridgeOperationV2,
}

struct PreparedHostDispatchV2 {
    attempt_id: String,
    owner_instance_id: String,
}

fn run_open_envelope(
    input: &HostKernelRunSpawnInputV2,
) -> Result<KernelCommandEnvelopeV2, HostV2StorageError> {
    let request_id = CommandRequestId::new(input.run_open_request_id.clone()).map_err(|_| {
        HostV2StorageError::invalid(
            "host_kernel_run_open_request_id_invalid",
            "RunOpen request identity is invalid",
        )
    })?;
    Ok(KernelCommandEnvelopeV2::new(
        request_id,
        KernelCommandV2::RunOpen(RunOpenV2 {
            workspace_binding_ref: input.workspace.workspace_binding_ref.clone(),
            input_id: input.initial_input.input_id.clone(),
            opaque_input_ref: input.initial_input.opaque_input_ref.clone(),
        }),
    ))
}

fn bootstrap_initial_input(input: &HostKernelRunSpawnInputV2) -> HostKernelBootstrapInitialInputV2 {
    HostKernelBootstrapInitialInputV2 {
        input_id: input.initial_input.input_id.to_string(),
        opaque_input_ref: input.initial_input.opaque_input_ref.clone(),
        text: input.initial_input.text.clone(),
        attachments: input.initial_input.attachments.clone(),
        attachment_contexts: input.initial_input.attachment_contexts.clone(),
        recorded_at: input.initial_input.recorded_at.clone(),
    }
}

fn run_open_reply(
    response: KernelCommandResponseEnvelopeV2,
    expected_request_id: &str,
) -> Result<RunOpenReplyV2, HostV2StorageError> {
    match response {
        KernelCommandResponseEnvelopeV2::Correlated {
            request_id,
            reply: KernelReplyV2::RunOpened(reply),
            ..
        } if request_id.as_str() == expected_request_id => {
            reply.validate().map_err(|_| {
                HostV2StorageError::conflict(
                    "host_kernel_run_open_reply_invalid",
                    "Kernel RunOpen returned an invalid public reply",
                )
            })?;
            Ok(reply)
        }
        KernelCommandResponseEnvelopeV2::Correlated { request_id, .. }
            if request_id.as_str() != expected_request_id =>
        {
            Err(HostV2StorageError::conflict(
                "host_kernel_run_open_correlation_conflict",
                "Kernel RunOpen response does not match the exact request identity",
            ))
        }
        _ => Err(HostV2StorageError::conflict(
            "host_kernel_run_open_failed",
            "Kernel RunOpen did not return RunOpened",
        )),
    }
}

fn production_request_frame_from_bootstrap(
    bootstrap: &HostKernelBootstrapRecordV2,
    operation_request_id: &str,
    operation: &HostKernelBridgeOperationV2,
) -> Result<Value, HostV2StorageError> {
    validate_bridge_operation(operation)?;
    if let HostKernelBridgeOperationV2::CancelRun {
        cancel_operation_id,
        ..
    } = operation
    {
        if cancel_operation_id != operation_request_id {
            return Err(HostV2StorageError::conflict(
                "host_kernel_cancel_operation_identity_conflict",
                "Cancel operation identity must equal the outer operation request identity",
            ));
        }
    }
    let request = json!({
        "schemaVersion": SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA,
        "sessionId": bootstrap.session_id,
        "hostRunId": bootstrap.host_run_id,
        "runId": bootstrap.run_id,
        "historySchema": SESSION_KERNEL_PERSISTENCE_V3_SCHEMA,
        "providerProfile": bootstrap.provider_profile,
        "priorSessionEvents": bootstrap.prior_session_events,
        "prefetchedRun": {
            "schemaVersion": SESSION_KERNEL_PREFETCHED_RUN_V2_SCHEMA,
            "workspaceBindingRef": bootstrap.workspace_binding_ref,
            "inputId": bootstrap.initial_input.input_id,
            "opaqueInputRef": bootstrap.initial_input.opaque_input_ref,
            "runOpenReply": bootstrap.run_open_reply
        },
        "initialInput": bootstrap.initial_input,
        "operation": operation
    });
    reject_transport_capabilities(&request)?;
    crate::host_v2_storage::validate_bounded_identity(
        operation_request_id,
        "operationRequestId",
        512,
    )?;
    let frame = json!({
        "schemaVersion": SESSION_KERNEL_PRODUCTION_REQUEST_FRAME_V2_SCHEMA,
        "operationRequestId": operation_request_id,
        "request": request
    });
    reject_transport_capabilities(&frame)?;
    Ok(frame)
}

fn validate_bridge_operation(
    operation: &HostKernelBridgeOperationV2,
) -> Result<(), HostV2StorageError> {
    if let HostKernelBridgeOperationV2::CancelRun {
        caller_request_id,
        caller_request_digest,
        cancel_operation_id,
    } = operation
    {
        crate::host_v2_storage::validate_bounded_identity(
            caller_request_id,
            "callerRequestId",
            512,
        )?;
        crate::host_v2_storage::validate_sha256_digest(
            caller_request_digest,
            "callerRequestDigest",
        )?;
        crate::host_v2_storage::validate_bounded_identity(
            cancel_operation_id,
            "cancelOperationId",
            512,
        )?;
    }
    let plan_pair = match operation {
        HostKernelBridgeOperationV2::ResumeAfterBackpressure {
            plan_action_id,
            expected_plan_revision,
            ..
        }
        | HostKernelBridgeOperationV2::ObserveCapabilityDecision {
            plan_action_id,
            expected_plan_revision,
            ..
        }
        | HostKernelBridgeOperationV2::ReconcileWake {
            plan_action_id,
            expected_plan_revision,
            ..
        } => Some((plan_action_id, expected_plan_revision)),
        _ => None,
    };
    if plan_pair.is_some_and(|(plan_action_id, expected_plan_revision)| {
        plan_action_id.is_some() != expected_plan_revision.is_some()
    }) {
        return Err(HostV2StorageError::invalid(
            "host_kernel_bridge_plan_binding_incomplete",
            "Session bridge operation planActionId and expectedPlanRevision must be present together",
        ));
    }
    match operation {
        HostKernelBridgeOperationV2::PublishPlanConfirmationReady { plan_revision } => {
            crate::host_v2_storage::validate_bounded_identity(plan_revision, "planRevision", 512)?;
        }
        HostKernelBridgeOperationV2::FinalizeReview {
            expected_work_authority,
        } => validate_session_work_authority_v3(expected_work_authority)?,
        HostKernelBridgeOperationV2::RequestFinalAnswer {
            input_id,
            control_epoch,
            work_authority,
            review_revision,
            snapshot_high_water,
        } => {
            crate::host_v2_storage::validate_bounded_identity(input_id, "inputId", 512)?;
            if *control_epoch == 0
                || *control_epoch > 9_007_199_254_740_991
                || *review_revision == 0
                || *review_revision > 9_007_199_254_740_991
                || *snapshot_high_water > 9_007_199_254_740_991
            {
                return Err(HostV2StorageError::invalid(
                    "host_kernel_final_answer_binding_invalid",
                    "Final-answer operation contains an invalid epoch, Review revision, or facts high-water",
                ));
            }
            validate_session_work_authority_v3(work_authority)?;
        }
        _ => {}
    }
    Ok(())
}

fn operation_ref(
    bootstrap: &HostKernelBootstrapRecordV2,
    operation_request_id: &str,
) -> HostKernelOperationRefV2 {
    HostKernelOperationRefV2 {
        session_id: bootstrap.session_id.clone(),
        host_run_id: bootstrap.host_run_id.clone(),
        run_id: bootstrap.run_id.clone(),
        bootstrap_digest: bootstrap.bootstrap_digest.clone(),
        operation_request_id: operation_request_id.to_string(),
    }
}

fn pending_operation_ref(operation: &HostKernelPendingOperationV2) -> HostKernelOperationRefV2 {
    HostKernelOperationRefV2 {
        session_id: operation.session_id.clone(),
        host_run_id: operation.host_run_id.clone(),
        run_id: operation.run_id.clone(),
        bootstrap_digest: operation.bootstrap_digest.clone(),
        operation_request_id: operation.operation_request_id.clone(),
    }
}

fn record_startup_tombstone_failure(
    failures: &mut Vec<HostKernelStartupTombstoneFailureV2>,
    session_id: &str,
    error: HostV2StorageError,
) {
    if let Some(existing) = failures
        .iter_mut()
        .find(|failure| failure.session_id == session_id)
    {
        existing.code = error.code;
        existing.message = error.message;
        return;
    }
    failures.push(HostKernelStartupTombstoneFailureV2 {
        session_id: session_id.to_string(),
        code: error.code,
        message: error.message,
    });
}

fn startup_operation_status(
    operation: &HostKernelPendingOperationV2,
    state: HostKernelOperationRecoveryStateV2,
    error_code: Option<&str>,
) -> HostKernelOperationRecoveryStatusV2 {
    HostKernelOperationRecoveryStatusV2 {
        session_id: operation.session_id.clone(),
        host_run_id: operation.host_run_id.clone(),
        run_id: operation.run_id.clone(),
        operation_request_id: operation.operation_request_id.clone(),
        operation_sequence: operation.operation_sequence,
        state,
        error_code: error_code.map(str::to_string),
    }
}

fn complete_startup_recovery_dispatch(
    startup_recovery: &Arc<Mutex<HostKernelStartupRecoveryStatusV2>>,
    active_runs: &HostActiveRunBrokerV2,
    session_id: &str,
    host_run_id: &str,
    operation_request_id: &str,
    error_code: Option<&'static str>,
) {
    let Ok(mut status) = startup_recovery.lock() else {
        active_runs.record_startup_error("host_kernel_startup_recovery_status_unavailable");
        return;
    };
    status.pending_dispatch_count = status.pending_dispatch_count.saturating_sub(1);
    let Some(operation) = status.operations.iter_mut().find(|operation| {
        operation.session_id == session_id
            && operation.host_run_id == host_run_id
            && operation.operation_request_id == operation_request_id
    }) else {
        status.record_error("host_kernel_startup_recovery_operation_status_missing");
        status.refresh_phase();
        active_runs.record_startup_error("host_kernel_startup_recovery_operation_status_missing");
        return;
    };
    match error_code {
        Some(error_code) => {
            operation.state = HostKernelOperationRecoveryStateV2::RecoveryFailed;
            operation.error_code = Some(error_code.to_string());
            status.record_error(error_code);
            active_runs.record_startup_error(error_code);
        }
        None => {
            operation.state = HostKernelOperationRecoveryStateV2::RecoveredDispatchSettled;
            operation.error_code = None;
        }
    }
    status.refresh_phase();
}

fn active_registration_from_bootstrap(
    bootstrap: &HostKernelBootstrapRecordV2,
) -> HostActiveRunRegistrationV2 {
    HostActiveRunRegistrationV2 {
        session_id: bootstrap.session_id.clone(),
        host_run_id: bootstrap.host_run_id.clone(),
        run_id: bootstrap.run_id.clone(),
        bootstrap_digest: bootstrap.bootstrap_digest.clone(),
        workspace_binding_ref: bootstrap.workspace_binding_ref.clone(),
        workspace_binding_digest: bootstrap.workspace_binding_digest.clone(),
        workspace_binding_identity: bootstrap.workspace_binding_identity.clone(),
        workspace_kind: bootstrap.workspace_kind,
        active_folder_id: bootstrap.active_folder_id.clone(),
        empty_workspace_key: bootstrap.empty_workspace_key.clone(),
        initial_input_id: bootstrap.initial_input.input_id.clone(),
        initial_opaque_input_ref: bootstrap.initial_input.opaque_input_ref.clone(),
        run_settings: bootstrap.run_settings.clone(),
        recorded_at: bootstrap.initial_input.recorded_at.clone(),
    }
}

fn active_workspace_root_for_registration(
    bootstrap: &HostKernelBootstrapRecordV2,
) -> Result<Option<&Path>, HostV2StorageError> {
    match bootstrap.workspace_kind {
        HostRunWorkspaceKindV2::Bound => bootstrap
            .workspace_canonical_root
            .as_deref()
            .map(Some)
            .ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_kernel_workspace_recovery_material_missing",
                    "UnsupportedHistorySchema: bound active Host Run has no Host-only workspace recovery root",
                )
            }),
        HostRunWorkspaceKindV2::Empty => Ok(None),
    }
}

fn require_cold_bridge_ownership(
    active_run: &HostActiveRunRecordV2,
) -> Result<(), HostV2StorageError> {
    match active_run.bridge_ownership {
        HostBridgeOwnershipV2::NotStarted | HostBridgeOwnershipV2::Reaped => Ok(()),
        HostBridgeOwnershipV2::SpawnPrepared { .. } | HostBridgeOwnershipV2::Owned { .. } => {
            Err(HostV2StorageError::conflict(
                "host_bridge_v2_owner_lost",
                "Durable Session bridge ownership has no exact live child handle in this Host process",
            ))
        }
    }
}

fn settings_ceiling(settings: &HostRunSettingsCeilingV2) -> SettingsCeilingV2 {
    SettingsCeilingV2 {
        workspace_read: settings.workspace_read,
        workspace_write: settings.workspace_write,
        web_read: settings.web_read,
        auto_approve_plans: settings.auto_approve_plans,
    }
}

fn workspace_resolve_error(error: HostWorkspaceResolveErrorV2) -> HostV2StorageError {
    match error {
        HostWorkspaceResolveErrorV2::NotFound => HostV2StorageError::not_found(
            "host_kernel_workspace_binding_not_found",
            "RunOpen workspace binding was not found",
        ),
        HostWorkspaceResolveErrorV2::Stale => HostV2StorageError::conflict(
            "host_kernel_workspace_binding_stale",
            "RunOpen workspace binding is stale",
        ),
        HostWorkspaceResolveErrorV2::Unavailable => HostV2StorageError::io(
            "host_kernel_workspace_binding_unavailable",
            "RunOpen workspace binding is unavailable",
        ),
    }
}

fn completed_operation(
    settlement: HostKernelOperationSettlementReceiptV2,
) -> HostKernelOperationCompletionReceiverV2 {
    let (sender, receiver) = oneshot::channel();
    let _ = sender.send(Ok(HostKernelOperationCompletionV2::Settled(settlement)));
    receiver
}

impl HostKernelBridgeOperationV2 {
    fn requires_facts_preflight(&self) -> bool {
        matches!(
            self,
            Self::ResumePlanAction { .. }
                | Self::Replan { .. }
                | Self::ResumePlanning { .. }
                | Self::ResumeAfterBackpressure { .. }
                | Self::PreviewPlan { .. }
                | Self::DecidePlan { .. }
                | Self::FinalizeReview { .. }
                | Self::RequestFinalAnswer { .. }
        )
    }
}

fn cleanup_pending_error(
    original: &HostV2StorageError,
    cleanup: &HostV2StorageError,
) -> HostV2StorageError {
    HostV2StorageError::io(
        "host_kernel_run_start_cleanup_pending",
        format!(
            "Host Kernel Run start failed with {}; durable cleanup remains pending after {}",
            original.code, cleanup.code
        ),
    )
}

fn live_registry_unavailable() -> HostV2StorageError {
    HostV2StorageError::io(
        "host_kernel_live_bridge_registry_unavailable",
        "Host live Session bridge registry is unavailable",
    )
}

fn run_response_worker(
    operation_store: HostKernelOperationStoreV2,
    result_store: SessionKernelV2Store,
    run_capability: RunCapabilityV2,
    key: HostKernelLiveRunKeyV2,
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<String, HostKernelPendingResponseV2>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    failed: Arc<AtomicBool>,
    live_bridges: Arc<Mutex<HashMap<HostKernelLiveRunKeyV2, Arc<HostKernelLiveBridgeV2>>>>,
) {
    let _registry_guard = HostKernelResponseWorkerRegistryGuardV2 {
        key: key.clone(),
        live_bridges,
    };
    let mut reader = BoundedNdjsonReaderV2::new(stdout);
    loop {
        let frame = match reader.next_frame() {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                fail_live_bridge(
                    &operation_store,
                    &pending,
                    &stdin,
                    &failed,
                    HostV2StorageError::io(
                        "host_kernel_bridge_stdout_closed",
                        "Session bridge stdout closed",
                    ),
                    "bridge_stdout_closed_before_response",
                );
                return;
            }
            Err(error) => {
                fail_live_bridge(
                    &operation_store,
                    &pending,
                    &stdin,
                    &failed,
                    error,
                    "bridge_response_frame_invalid",
                );
                return;
            }
        };
        let parsed = parse_response_frame(&result_store, &run_capability, &key, &frame);
        let (operation_request_id, response, settlement) = match parsed {
            Ok(parsed) => parsed,
            Err(error) => {
                fail_live_bridge(
                    &operation_store,
                    &pending,
                    &stdin,
                    &failed,
                    error,
                    "bridge_response_protocol_invalid",
                );
                return;
            }
        };
        let pending_response = match pending.lock() {
            Ok(mut pending) => pending.remove(&operation_request_id),
            Err(_) => {
                fail_live_bridge(
                    &operation_store,
                    &pending,
                    &stdin,
                    &failed,
                    HostV2StorageError::io(
                        "host_kernel_bridge_pending_registry_unavailable",
                        "Session bridge response correlation registry is unavailable",
                    ),
                    "bridge_response_registry_unavailable",
                );
                return;
            }
        };
        let Some(pending_response) = pending_response else {
            fail_live_bridge(
                &operation_store,
                &pending,
                &stdin,
                &failed,
                HostV2StorageError::conflict(
                    "host_kernel_bridge_response_uncorrelated",
                    "Session bridge returned an unknown operation response",
                ),
                "bridge_response_uncorrelated",
            );
            return;
        };
        let observed = operation_store.observe_response(
            &pending_response.operation,
            &pending_response.attempt_id,
            &pending_response.owner_instance_id,
            response,
            &crate::utils::now_text(),
        );
        if observed.is_ok() && is_retry_same_request_settlement(&settlement) {
            if pending_response
                .completion
                .send(Ok(HostKernelOperationCompletionV2::RetrySameRequest {
                    operation: pending_response.operation,
                    previous_attempt_id: pending_response.attempt_id,
                    production_frame: pending_response.production_frame,
                    retry_settlement: settlement,
                }))
                .is_err()
            {
                fail_live_bridge(
                    &operation_store,
                    &pending,
                    &stdin,
                    &failed,
                    HostV2StorageError::io(
                        "host_kernel_retry_owner_missing",
                        "Session requested retrySameRequest after its exact Host operation owner ended",
                    ),
                    "bridge_retry_owner_missing",
                );
                return;
            }
            continue;
        }
        let result = match observed {
            Ok(_) => operation_store
                .settle_operation(
                    &pending_response.operation,
                    &pending_response.attempt_id,
                    &pending_response.owner_instance_id,
                    settlement,
                    &crate::utils::now_text(),
                )
                .map(HostKernelOperationCompletionV2::Settled),
            Err(error) => {
                let cleanup = operation_store.mark_dispatch_indeterminate(
                    &pending_response.operation,
                    &pending_response.attempt_id,
                    &pending_response.owner_instance_id,
                    &crate::utils::now_text(),
                    "bridge_response_observation_failed",
                );
                Err(match cleanup {
                    Ok(_) => error,
                    Err(cleanup_error) => HostV2StorageError::io(
                        "host_kernel_bridge_response_cleanup_pending",
                        format!(
                            "Session bridge response persistence failed with {}; dispatch reconciliation failed after {}",
                            error.code, cleanup_error.code
                        ),
                    ),
                })
            }
        };
        let fatal = result.as_ref().err().cloned();
        let _ = pending_response.completion.send(result);
        if let Some(error) = fatal {
            fail_live_bridge(
                &operation_store,
                &pending,
                &stdin,
                &failed,
                error,
                "bridge_response_persistence_failed",
            );
            return;
        }
    }
}

fn is_retry_same_request_settlement(settlement: &HostKernelOperationSettlementV2) -> bool {
    matches!(
        settlement,
        HostKernelOperationSettlementV2::FailedRecoverable {
            boundary: HostKernelOperationFailureBoundaryV2 {
                disposition: HostKernelFailureDispositionV2::RetrySameRequest,
                commit: HostKernelFailureCommitV2::None,
                effect: HostKernelFailureEffectV2::None,
                pending_request_lanes,
            },
            ..
        } if pending_request_lanes.is_empty()
    )
}

struct HostKernelResponseWorkerRegistryGuardV2 {
    key: HostKernelLiveRunKeyV2,
    live_bridges: Arc<Mutex<HashMap<HostKernelLiveRunKeyV2, Arc<HostKernelLiveBridgeV2>>>>,
}

impl Drop for HostKernelResponseWorkerRegistryGuardV2 {
    fn drop(&mut self) {
        if let Ok(mut live_bridges) = self.live_bridges.lock() {
            live_bridges.remove(&self.key);
        }
    }
}

fn fail_live_bridge(
    store: &HostKernelOperationStoreV2,
    pending: &Arc<Mutex<HashMap<String, HostKernelPendingResponseV2>>>,
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    failed: &Arc<AtomicBool>,
    error: HostV2StorageError,
    reason_code: &str,
) {
    failed.store(true, Ordering::Release);
    if let Ok(mut stdin) = stdin.lock() {
        stdin.take();
    }
    let pending_responses = pending
        .lock()
        .map(|mut pending| pending.drain().map(|(_, value)| value).collect::<Vec<_>>())
        .unwrap_or_default();
    for pending_response in pending_responses {
        let persistence = store.mark_dispatch_indeterminate(
            &pending_response.operation,
            &pending_response.attempt_id,
            &pending_response.owner_instance_id,
            &crate::utils::now_text(),
            reason_code,
        );
        let response_error = match persistence {
            Ok(_) => error.clone(),
            Err(cleanup_error) => HostV2StorageError::io(
                "host_kernel_bridge_failure_cleanup_pending",
                format!(
                    "Session bridge failed with {}; durable attempt cleanup remains pending after {}",
                    error.code, cleanup_error.code
                ),
            ),
        };
        let _ = pending_response.completion.send(Err(response_error));
    }
}

fn parse_response_frame(
    result_store: &SessionKernelV2Store,
    run_capability: &RunCapabilityV2,
    key: &HostKernelLiveRunKeyV2,
    bytes: &[u8],
) -> Result<(String, Value, HostKernelOperationSettlementV2), HostV2StorageError> {
    let frame: Value = serde_json::from_slice(bytes).map_err(|_| {
        HostV2StorageError::invalid(
            "host_kernel_bridge_response_json_invalid",
            "Session bridge returned invalid response JSON",
        )
    })?;
    reject_transport_capabilities(&frame)?;
    let frame = exact_response_object(
        &frame,
        &["schemaVersion", "operationRequestId", "response"],
        "Session bridge response frame",
    )?;
    if frame.get("schemaVersion").and_then(Value::as_str)
        != Some(SESSION_KERNEL_PRODUCTION_RESPONSE_FRAME_V2_SCHEMA)
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_bridge_response_schema_invalid",
            "Session bridge response frame schema is not exact v2",
        ));
    }
    let operation_request_id = frame
        .get("operationRequestId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_bridge_response_identity_invalid",
                "Session bridge response has no operation identity",
            )
        })?
        .to_string();
    crate::host_v2_storage::validate_bounded_identity(
        &operation_request_id,
        "operationRequestId",
        512,
    )?;
    let response = frame.get("response").cloned().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_bridge_response_invalid",
            "Session bridge response body is missing",
        )
    })?;
    let ok = validate_response_outcome(&response)?;
    let (response, settlement) = if ok {
        let compact_continuation = validate_success_response(key, &response)?;
        let response = resolve_stored_success_response(
            result_store,
            run_capability,
            key,
            &operation_request_id,
            response,
        )?;
        let continuation = validate_success_response(key, &response)?;
        if continuation != compact_continuation {
            return Err(HostV2StorageError::conflict(
                "host_kernel_operation_result_continuation_conflict",
                "Stored operation result changed the compact response continuation",
            ));
        }
        let settlement = HostKernelOperationSettlementV2::Succeeded {
            response: response.clone(),
            continuation,
        };
        (response, settlement)
    } else {
        let settlement = settlement_from_observed_response(key, &response)?;
        (response, settlement)
    };
    Ok((operation_request_id, response, settlement))
}

fn validate_response_outcome(response: &Value) -> Result<bool, HostV2StorageError> {
    let response_object = response.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_bridge_response_invalid",
            "Session bridge response body must be an object",
        )
    })?;
    if response_object.get("schemaVersion").and_then(Value::as_str)
        != Some(SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA)
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_bridge_response_schema_invalid",
            "Session bridge response body schema is not exact v2",
        ));
    }
    response_object
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_bridge_response_invalid",
                "Session bridge response has no boolean outcome",
            )
        })
}

fn settlement_from_observed_response(
    key: &HostKernelLiveRunKeyV2,
    response: &Value,
) -> Result<HostKernelOperationSettlementV2, HostV2StorageError> {
    if validate_response_outcome(response)? {
        return Ok(HostKernelOperationSettlementV2::Succeeded {
            response: response.clone(),
            continuation: validate_success_response(key, response)?,
        });
    }
    let response_object = exact_response_object(
        response,
        &["schemaVersion", "ok", "error"],
        "Session bridge failure response",
    )?;
    let error_value = response_object.get("error").ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_bridge_response_error_invalid",
            "Failed Session bridge response has no error boundary",
        )
    })?;
    let error_object = exact_response_object(
        error_value,
        &[
            "code",
            "disposition",
            "commit",
            "effect",
            "pendingRequestLanes",
        ],
        "Session bridge failure boundary",
    )?;
    let error_code = error_object
        .get("code")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_bridge_response_error_invalid",
                "Session bridge failure has no error code",
            )
        })?
        .to_string();
    crate::host_v2_storage::validate_bounded_identity(&error_code, "errorCode", 512)?;
    let boundary = HostKernelOperationFailureBoundaryV2 {
        disposition: match error_object.get("disposition").and_then(Value::as_str) {
            Some("correctRequest") => HostKernelFailureDispositionV2::CorrectRequest,
            Some("retrySameRequest") => HostKernelFailureDispositionV2::RetrySameRequest,
            Some("queryFacts") => HostKernelFailureDispositionV2::QueryFacts,
            Some("doNotRetry") => HostKernelFailureDispositionV2::DoNotRetry,
            _ => {
                return Err(HostV2StorageError::invalid(
                    "host_kernel_bridge_response_disposition_invalid",
                    "Session bridge failure disposition is invalid",
                ))
            }
        },
        commit: match error_object.get("commit").and_then(Value::as_str) {
            Some("none") => HostKernelFailureCommitV2::None,
            Some("committed") => HostKernelFailureCommitV2::Committed,
            Some("unknown") => HostKernelFailureCommitV2::Unknown,
            _ => {
                return Err(HostV2StorageError::invalid(
                    "host_kernel_bridge_response_commit_invalid",
                    "Session bridge failure commit boundary is invalid",
                ))
            }
        },
        effect: match error_object.get("effect").and_then(Value::as_str) {
            Some("none") => HostKernelFailureEffectV2::None,
            Some("possible") => HostKernelFailureEffectV2::Possible,
            Some("observed") => HostKernelFailureEffectV2::Observed,
            _ => {
                return Err(HostV2StorageError::invalid(
                    "host_kernel_bridge_response_effect_invalid",
                    "Session bridge failure effect boundary is invalid",
                ))
            }
        },
        pending_request_lanes: error_object
            .get("pendingRequestLanes")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "host_kernel_bridge_response_pending_lanes_invalid",
                    "Session bridge failure pending request lanes are invalid",
                )
            })?
            .iter()
            .map(|lane| match lane.as_str() {
                Some("control") => Ok(HostKernelPendingRequestLaneV2::Control),
                Some("effect") => Ok(HostKernelPendingRequestLaneV2::Effect),
                Some("query") => Ok(HostKernelPendingRequestLaneV2::Query),
                _ => Err(HostV2StorageError::invalid(
                    "host_kernel_bridge_response_pending_lanes_invalid",
                    "Session bridge failure contains an unsupported pending request lane",
                )),
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    if boundary
        .pending_request_lanes
        .windows(2)
        .any(|lanes| lanes[0] >= lanes[1])
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_bridge_response_pending_lanes_invalid",
            "Session bridge failure pending request lanes must be unique and ordered",
        ));
    }
    let no_effect_retry = boundary.commit == HostKernelFailureCommitV2::None
        && boundary.effect == HostKernelFailureEffectV2::None
        && boundary.pending_request_lanes.is_empty();
    match boundary.disposition {
        HostKernelFailureDispositionV2::RetrySameRequest if no_effect_retry => {
            Ok(HostKernelOperationSettlementV2::FailedRecoverable {
                error_code,
                boundary,
            })
        }
        HostKernelFailureDispositionV2::CorrectRequest
        | HostKernelFailureDispositionV2::DoNotRetry
            if no_effect_retry =>
        {
            Ok(HostKernelOperationSettlementV2::FailedTerminal {
                error_code,
                boundary,
            })
        }
        HostKernelFailureDispositionV2::QueryFacts => {
            Ok(HostKernelOperationSettlementV2::FailedRecoverable {
                error_code,
                boundary,
            })
        }
        _ => Err(HostV2StorageError::invalid(
            "host_kernel_bridge_response_failure_boundary_invalid",
            "Session bridge failure boundary is internally inconsistent",
        )),
    }
}

fn validate_success_response(
    key: &HostKernelLiveRunKeyV2,
    response: &Value,
) -> Result<Value, HostV2StorageError> {
    let response_object = exact_response_object(
        response,
        &[
            "schemaVersion",
            "ok",
            "sessionId",
            "hostRunId",
            "runId",
            "operationGeneration",
            "authorityGeneration",
            "operationKind",
            "causalState",
            "state",
            "outcome",
            "continuation",
        ],
        "Session bridge success response",
    )?;
    if response_object.get("schemaVersion").and_then(Value::as_str)
        != Some(SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA)
        || response_object.get("ok").and_then(Value::as_bool) != Some(true)
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_bridge_response_schema_invalid",
            "Session bridge success response is not exact v2",
        ));
    }
    if response_object.get("sessionId").and_then(Value::as_str) != Some(key.session_id.as_str())
        || response_object.get("hostRunId").and_then(Value::as_str)
            != Some(key.host_run_id.as_str())
        || response_object.get("runId").and_then(Value::as_str) != Some(key.run_id.as_str())
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_bridge_response_run_conflict",
            "Session bridge response does not match the exact live Run",
        ));
    }
    response_object
        .get("continuation")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_bridge_response_continuation_invalid",
                "Successful Session bridge response has no continuation",
            )
        })
}

struct ValidatedCancelRunAcknowledgementV2 {
    projection_id: String,
    projection_digest: String,
    projection_data: Value,
}

fn validate_cancel_run_settlement(
    settlement: &HostKernelOperationSettlementReceiptV2,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
    caller_request_id: &str,
    caller_request_digest: &str,
    cancel_operation_id: &str,
    kernel_run_sequence_high_water: u64,
    fact_reader: &CanonicalFactReader,
) -> Result<ValidatedCancelRunAcknowledgementV2, HostV2StorageError> {
    if settlement.operation_request_id != cancel_operation_id {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_settlement_identity_conflict",
            "Cancel settlement does not match the exact cancel operation identity",
        ));
    }
    let HostKernelOperationSettlementV2::Succeeded { response, .. } = &settlement.settlement else {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_not_acknowledged",
            "Session did not acknowledge canonical Run cancellation",
        ));
    };
    let response = exact_response_object(
        response,
        &[
            "schemaVersion",
            "ok",
            "sessionId",
            "hostRunId",
            "runId",
            "operationGeneration",
            "authorityGeneration",
            "operationKind",
            "causalState",
            "state",
            "outcome",
            "continuation",
        ],
        "Session cancel response",
    )?;
    if response.get("schemaVersion").and_then(Value::as_str)
        != Some(SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA)
        || response.get("ok").and_then(Value::as_bool) != Some(true)
        || response.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || response.get("hostRunId").and_then(Value::as_str) != Some(host_run_id)
        || response.get("runId").and_then(Value::as_str) != Some(run_id)
        || response.get("operationKind").and_then(Value::as_str) != Some("cancelRun")
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_response_identity_conflict",
            "Session cancel acknowledgement does not match the exact Run",
        ));
    }
    let outcome = exact_response_object(
        response.get("outcome").ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_cancel_outcome_invalid",
                "Session cancel acknowledgement has no outcome",
            )
        })?,
        &[
            "kind",
            "callerRequestId",
            "callerRequestDigest",
            "cancelOperationId",
            "controlEpoch",
            "cancellation",
            "facts",
            "projection",
        ],
        "Session cancel outcome",
    )?;
    if outcome.get("kind").and_then(Value::as_str) != Some("runCancelled")
        || outcome.get("callerRequestId").and_then(Value::as_str) != Some(caller_request_id)
        || outcome.get("callerRequestDigest").and_then(Value::as_str) != Some(caller_request_digest)
        || outcome.get("cancelOperationId").and_then(Value::as_str) != Some(cancel_operation_id)
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_outcome_identity_conflict",
            "Session cancel outcome changed immutable caller or operation identity",
        ));
    }
    crate::host_v2_storage::validate_sha256_digest(caller_request_digest, "callerRequestDigest")?;
    let control_epoch = outcome
        .get("controlEpoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_cancel_outcome_invalid",
                "Session cancel outcome has no valid control epoch",
            )
        })?;
    let cancellation_value = outcome.get("cancellation").cloned().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_cancel_outcome_invalid",
            "Session cancel outcome has no Kernel cancellation result",
        )
    })?;
    let cancellation: InvocationCancelReplyV2 = serde_json::from_value(cancellation_value.clone())
        .map_err(|_| {
            HostV2StorageError::invalid(
                "host_kernel_cancel_reply_invalid",
                "Session cancel outcome contains an invalid public Kernel cancellation reply",
            )
        })?;
    cancellation.validate().map_err(|_| {
        HostV2StorageError::invalid(
            "host_kernel_cancel_reply_invalid",
            "Session cancel outcome contains an invalid public Kernel cancellation reply",
        )
    })?;
    validate_invocation_cancel_reply_fact(fact_reader, run_id, control_epoch, &cancellation)?;
    if let InvocationCancelReplyV2::NoActiveInvocation {
        run_id: cancelled_run_id,
        control_epoch: cancelled_control_epoch,
    } = &cancellation
    {
        if cancelled_run_id.as_str() != run_id || cancelled_control_epoch.get() != control_epoch {
            return Err(HostV2StorageError::conflict(
                "host_kernel_cancel_reply_identity_conflict",
                "Kernel no-active-invocation reply does not match the cancelled Run",
            ));
        }
    }
    let facts_value = outcome.get("facts").cloned().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_cancel_facts_invalid",
            "Session cancel outcome has no reconciled facts boundary",
        )
    })?;
    let facts = exact_response_object(
        &facts_value,
        &[
            "afterLedgerSequence",
            "snapshotHighWater",
            "runSequenceHighWater",
            "caughtUp",
            "pendingFactBarrierCount",
        ],
        "Session cancel facts",
    )?;
    let after_ledger_sequence = cancel_u64_field(facts, "afterLedgerSequence")?;
    let snapshot_high_water = cancel_u64_field(facts, "snapshotHighWater")?;
    let run_sequence_high_water = cancel_u64_field(facts, "runSequenceHighWater")?;
    if after_ledger_sequence < snapshot_high_water
        || run_sequence_high_water != kernel_run_sequence_high_water
        || facts.get("caughtUp").and_then(Value::as_bool) != Some(true)
        || facts.get("pendingFactBarrierCount").and_then(Value::as_u64) != Some(0)
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_facts_incomplete",
            "Session cancellation did not reconcile its exact Kernel fact boundary",
        ));
    }
    let state = response
        .get("state")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_cancel_state_invalid",
                "Session cancel acknowledgement has no state summary",
            )
        })?;
    if state.get("controlEpoch").and_then(Value::as_u64) != Some(control_epoch)
        || state
            .get("factsAfterLedgerSequence")
            .and_then(Value::as_u64)
            != Some(after_ledger_sequence)
        || state.get("factsSnapshotHighWater").and_then(Value::as_u64) != Some(snapshot_high_water)
        || state
            .get("factsRunSequenceHighWater")
            .and_then(Value::as_u64)
            != Some(run_sequence_high_water)
        || state
            .get("pendingRequestLanes")
            .and_then(Value::as_array)
            .is_none_or(|lanes| !lanes.is_empty())
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_state_conflict",
            "Session cancel state does not match its reconciled cancellation outcome",
        ));
    }
    let projection = exact_response_object(
        outcome.get("projection").ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_cancel_projection_invalid",
                "Session cancel outcome has no projection acknowledgement",
            )
        })?,
        &["projectionId", "projectionDigest"],
        "Session cancel projection",
    )?;
    let projection_id = projection
        .get("projectionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_cancel_projection_invalid",
                "Session cancel outcome has no projection identity",
            )
        })?
        .to_string();
    let projection_digest = projection
        .get("projectionDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_cancel_projection_invalid",
                "Session cancel outcome has no projection digest",
            )
        })?
        .to_string();
    crate::host_v2_storage::validate_bounded_identity(&projection_id, "projectionId", 512)?;
    crate::host_v2_storage::validate_sha256_digest(&projection_digest, "projectionDigest")?;
    let expected_projection_id = format!("run:{run_id}:cancel:{cancel_operation_id}:settled");
    if projection_id != expected_projection_id {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_projection_identity_conflict",
            "Session cancel projection identity is not deterministic for the exact cancellation",
        ));
    }
    let continuation = exact_response_object(
        response.get("continuation").ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_cancel_continuation_invalid",
                "Session cancel acknowledgement has no terminal continuation",
            )
        })?,
        &[
            "kind",
            "cancelOperationId",
            "projectionId",
            "projectionDigest",
        ],
        "Session cancel continuation",
    )?;
    if continuation.get("kind").and_then(Value::as_str) != Some("terminalRunCancelled")
        || continuation
            .get("cancelOperationId")
            .and_then(Value::as_str)
            != Some(cancel_operation_id)
        || continuation.get("projectionId").and_then(Value::as_str) != Some(projection_id.as_str())
        || continuation.get("projectionDigest").and_then(Value::as_str)
            != Some(projection_digest.as_str())
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_continuation_conflict",
            "Session cancel continuation does not match the exact durable projection",
        ));
    }
    Ok(ValidatedCancelRunAcknowledgementV2 {
        projection_id,
        projection_digest,
        projection_data: json!({
            "callerRequestId": caller_request_id,
            "callerRequestDigest": caller_request_digest,
            "cancelOperationId": cancel_operation_id,
            "controlEpoch": control_epoch,
            "cancellation": cancellation_value,
            "facts": facts_value,
        }),
    })
}

fn validate_invocation_cancel_reply_fact(
    fact_reader: &CanonicalFactReader,
    run_id: &str,
    control_epoch: u64,
    reply: &InvocationCancelReplyV2,
) -> Result<(), HostV2StorageError> {
    match reply {
        InvocationCancelReplyV2::Requested {
            cancel_request_id,
            invocation_id,
            fact_id,
            ledger_sequence,
        } => validate_cancellation_requested_fact(
            fact_reader,
            ExpectedCancellationRequestedFactV2 {
                run_id,
                required_control_epoch: Some(control_epoch),
                cancel_request_id: cancel_request_id.as_str(),
                invocation_id: invocation_id.as_str(),
                fact_id,
                ledger_sequence: *ledger_sequence,
                require_user_command: true,
            },
        ),
        InvocationCancelReplyV2::AlreadyRequested {
            cancel_request_id,
            invocation_id,
            fact_id,
            ledger_sequence,
        } => validate_cancellation_requested_fact(
            fact_reader,
            ExpectedCancellationRequestedFactV2 {
                run_id,
                required_control_epoch: None,
                cancel_request_id: cancel_request_id.as_str(),
                invocation_id: invocation_id.as_str(),
                fact_id,
                ledger_sequence: *ledger_sequence,
                require_user_command: false,
            },
        ),
        InvocationCancelReplyV2::NoActiveInvocation { .. } => Ok(()),
        InvocationCancelReplyV2::AlreadyTerminal {
            invocation_id,
            terminal_fact_id,
            terminal_phase,
        } => {
            let fact = required_cancel_fact(fact_reader, terminal_fact_id)?;
            if &fact.fact_id != terminal_fact_id
                || fact.payload.run_id().as_str() != run_id
                || fact.payload.invocation_id().map(|id| id.as_str())
                    != Some(invocation_id.as_str())
                || terminal_invocation_phase_v2(&fact.payload) != Some(*terminal_phase)
            {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_cancel_fact_identity_conflict",
                    "Kernel terminal cancellation reply does not match its canonical invocation fact",
                ));
            }
            Ok(())
        }
    }
}

struct ExpectedCancellationRequestedFactV2<'a> {
    run_id: &'a str,
    required_control_epoch: Option<u64>,
    cancel_request_id: &'a str,
    invocation_id: &'a str,
    fact_id: &'a FactId,
    ledger_sequence: u64,
    require_user_command: bool,
}

fn validate_cancellation_requested_fact(
    fact_reader: &CanonicalFactReader,
    expected: ExpectedCancellationRequestedFactV2<'_>,
) -> Result<(), HostV2StorageError> {
    let fact = required_cancel_fact(fact_reader, expected.fact_id)?;
    let KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested {
        identity,
        source,
        reason_code,
        ..
    }) = &fact.payload
    else {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_fact_identity_conflict",
            "Kernel cancellation reply does not reference a canonical CancellationRequested fact",
        ));
    };
    if &fact.fact_id != expected.fact_id
        || fact.ledger_sequence != expected.ledger_sequence
        || identity.run_id.as_str() != expected.run_id
        || expected
            .required_control_epoch
            .is_some_and(|control_epoch| identity.control_epoch.get() != control_epoch)
        || identity.invocation_id.as_str() != expected.invocation_id
        || identity.cancel_request_id.as_str() != expected.cancel_request_id
        || (expected.require_user_command
            && (*source != CancellationSourceV2::ExplicitCommand
                || *reason_code != CancellationReasonCodeV2::UserRequested))
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_fact_identity_conflict",
            "Kernel cancellation reply changed its canonical Run, invocation, request, epoch, sequence, or source",
        ));
    }
    Ok(())
}

fn required_cancel_fact(
    fact_reader: &CanonicalFactReader,
    fact_id: &FactId,
) -> Result<KernelFactEnvelopeV2, HostV2StorageError> {
    fact_reader
        .get_by_fact_id(fact_id.as_str())
        .map_err(|_| {
            HostV2StorageError::io(
                "host_kernel_cancel_fact_lookup_unavailable",
                "Canonical Kernel cancellation fact lookup is unavailable",
            )
        })?
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_kernel_cancel_fact_missing",
                "Kernel cancellation reply references a missing canonical fact",
            )
        })
}

fn terminal_invocation_phase_v2(payload: &KernelFactPayloadV2) -> Option<InvocationPhaseV2> {
    match payload {
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolFailedBeforeEffect { .. }) => {
            Some(InvocationPhaseV2::FailedBeforeEffect)
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCancelledBeforeEffect { .. }) => {
            Some(InvocationPhaseV2::CancelledBeforeEffect)
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolTimedOutBeforeEffect { .. }) => {
            Some(InvocationPhaseV2::TimedOutBeforeEffect)
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCompleted { .. }) => {
            Some(InvocationPhaseV2::Completed)
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolFailedAfterObservedEffect {
            ..
        }) => Some(InvocationPhaseV2::FailedAfterObservedEffect),
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIndeterminate { .. }) => {
            Some(InvocationPhaseV2::Indeterminate)
        }
        _ => None,
    }
}

fn cancel_u64_field(
    value: &serde_json::Map<String, Value>,
    field: &'static str,
) -> Result<u64, HostV2StorageError> {
    value.get(field).and_then(Value::as_u64).ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_cancel_facts_invalid",
            format!("Session cancel facts has no valid {field}"),
        )
    })
}

fn resolve_stored_success_response(
    result_store: &SessionKernelV2Store,
    run_capability: &RunCapabilityV2,
    key: &HostKernelLiveRunKeyV2,
    operation_request_id: &str,
    compact_response: Value,
) -> Result<Value, HostV2StorageError> {
    let Some(outcome) = compact_response
        .get("outcome")
        .filter(|value| value.get("kind").and_then(Value::as_str) == Some("resultStored"))
    else {
        return Ok(compact_response);
    };
    let outcome = exact_response_object(
        outcome,
        &[
            "kind",
            "resultRef",
            "originalOutcomeKind",
            "storage",
            "recordId",
            "recordDigest",
            "resultDigest",
            "readPath",
        ],
        "Session stored result reference",
    )?;
    if outcome.get("storage").and_then(Value::as_str) != Some("sessionPersistenceRecord") {
        return Err(HostV2StorageError::invalid(
            "host_kernel_operation_result_storage_invalid",
            "Session stored result uses an unsupported storage class",
        ));
    }
    let required = |field: &'static str| {
        outcome
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "host_kernel_operation_result_reference_invalid",
                    format!("Session stored result has no {field}"),
                )
            })
    };
    let record_id = required("recordId")?;
    let record_digest = required("recordDigest")?;
    let result_digest = required("resultDigest")?;
    let original_outcome_kind = required("originalOutcomeKind")?;
    if original_outcome_kind == "resultStored"
        || outcome.get("resultRef").and_then(Value::as_str) != Some(record_id)
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_operation_result_reference_invalid",
            "Session stored result reference is recursive or internally inconsistent",
        ));
    }
    let resolved = result_store.resolve_operation_result(
        &key.session_id,
        &key.run_id,
        operation_request_id,
        record_id,
        record_digest,
        result_digest,
        run_capability,
    )?;
    let resolved_outcome_kind = resolved
        .get("outcome")
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str);
    if resolved_outcome_kind != Some(original_outcome_kind) {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_result_kind_conflict",
            "Stored operation result does not match its compact outcome kind",
        ));
    }
    for field in [
        "schemaVersion",
        "ok",
        "sessionId",
        "hostRunId",
        "runId",
        "operationGeneration",
        "authorityGeneration",
        "operationKind",
        "causalState",
        "state",
        "continuation",
    ] {
        if resolved.get(field) != compact_response.get(field) {
            return Err(HostV2StorageError::conflict(
                "host_kernel_operation_result_binding_conflict",
                format!("Stored operation result changed compact response field {field}"),
            ));
        }
    }
    Ok(resolved)
}

fn require_successful_session_facts_high_water(
    settlement: &HostKernelOperationSettlementReceiptV2,
) -> Result<u64, HostV2StorageError> {
    let HostKernelOperationSettlementV2::Succeeded { response, .. } = &settlement.settlement else {
        return Err(HostV2StorageError::conflict(
            "host_kernel_session_state_unavailable",
            "Latest Session operation did not produce a successful state snapshot",
        ));
    };
    response
        .get("state")
        .and_then(|state| state.get("factsRunSequenceHighWater"))
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_kernel_session_facts_high_water_invalid",
                "Session operation response has no valid facts run-sequence high-water",
            )
        })
}

fn exact_response_object<'a>(
    value: &'a Value,
    exact_fields: &[&str],
    label: &'static str,
) -> Result<&'a serde_json::Map<String, Value>, HostV2StorageError> {
    let object = value.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_bridge_response_shape_invalid",
            format!("{label} must be an object"),
        )
    })?;
    if object.len() != exact_fields.len()
        || object
            .keys()
            .any(|field| !exact_fields.contains(&field.as_str()))
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_bridge_response_shape_invalid",
            format!("{label} has unknown or missing fields"),
        ));
    }
    Ok(object)
}

struct BoundedNdjsonReaderV2<R> {
    reader: BufReader<R>,
    frame: Vec<u8>,
}

impl<R: Read> BoundedNdjsonReaderV2<R> {
    fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            frame: Vec::new(),
        }
    }

    fn next_frame(&mut self) -> Result<Option<Vec<u8>>, HostV2StorageError> {
        self.frame.clear();
        loop {
            let available = self.reader.fill_buf().map_err(|error| {
                HostV2StorageError::io(
                    "host_kernel_bridge_response_read_failed",
                    format!("read Session bridge response: {error}"),
                )
            })?;
            if available.is_empty() {
                if self.frame.is_empty() {
                    return Ok(None);
                }
                return Err(HostV2StorageError::invalid(
                    "host_kernel_bridge_response_unterminated",
                    "Session bridge response frame is not newline terminated",
                ));
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let take = newline.unwrap_or(available.len());
            if self.frame.len().saturating_add(take) > MAX_SESSION_KERNEL_RESPONSE_FRAME_BYTES_V2 {
                return Err(HostV2StorageError::invalid(
                    "host_kernel_bridge_response_too_large",
                    "Session bridge response frame exceeds the Host bound",
                ));
            }
            self.frame.extend_from_slice(&available[..take]);
            self.reader.consume(take + usize::from(newline.is_some()));
            if newline.is_some() {
                if self.frame.last() == Some(&b'\r') {
                    self.frame.pop();
                }
                if self.frame.is_empty() {
                    return Err(HostV2StorageError::invalid(
                        "host_kernel_bridge_response_empty",
                        "Session bridge returned an empty response frame",
                    ));
                }
                return Ok(Some(self.frame.clone()));
            }
        }
    }
}

fn drain_bridge_stderr(mut stderr: ChildStderr) {
    let mut buffer = [0_u8; 8192];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

fn validate_spawn_input(input: &HostKernelRunSpawnInputV2) -> Result<(), HostV2StorageError> {
    for (field, value, maximum) in [
        ("sessionId", input.session_id.as_str(), 512),
        ("hostRunId", input.host_run_id.as_str(), 512),
        ("callerRequestId", input.caller_request_id.as_str(), 512),
        ("runOpenRequestId", input.run_open_request_id.as_str(), 512),
        (
            "operationRequestId",
            input.operation_request_id.as_str(),
            512,
        ),
        (
            "workspaceBindingIdentity",
            input.workspace.workspace_binding_identity.as_str(),
            64 * 1024,
        ),
        (
            "opaqueInputRef",
            input.initial_input.opaque_input_ref.as_str(),
            64 * 1024,
        ),
        ("recordedAt", input.initial_input.recorded_at.as_str(), 1024),
    ] {
        crate::host_v2_storage::validate_bounded_identity(value, field, maximum)?;
    }
    crate::host_v2_storage::validate_sha256_digest(
        &input.caller_request_digest,
        "callerRequestDigest",
    )?;
    if input.initial_input.text.len() > 1024 * 1024 {
        return Err(HostV2StorageError::invalid(
            "host_kernel_initial_input_too_large",
            "Session Kernel v2 initial input exceeds the Host limit",
        ));
    }
    crate::validate_agent_input_attachment_slice_v3(&input.initial_input.attachments)
        .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;
    crate::validate_user_attachment_contexts_v1(
        &input.initial_input.attachments,
        &input.initial_input.attachment_contexts,
    )?;
    input.provider_profile.validate()?;
    input.prior_session_events.validate(&input.session_id)?;
    match input.workspace.workspace_kind {
        HostRunWorkspaceKindV2::Bound if input.workspace.empty_workspace_key.is_some() => {
            Err(HostV2StorageError::invalid(
                "host_kernel_workspace_binding_invalid",
                "Bound Session Run cannot carry an empty workspace key",
            ))
        }
        HostRunWorkspaceKindV2::Empty
            if input.workspace.empty_workspace_key.is_none()
                || input.workspace.run_settings != HostRunSettingsCeilingV2::empty_workspace() =>
        {
            Err(HostV2StorageError::invalid(
                "host_kernel_workspace_binding_invalid",
                "Empty Session Run requires its managed key and zero capability ceiling",
            ))
        }
        _ => Ok(()),
    }
}

fn copy_safe_bridge_environment(command: &mut Command) {
    for key in ["LANG", "LC_ALL", "TZ"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    if let Some(value) = std::env::var_os("SYSTEMROOT") {
        command.env("SYSTEMROOT", value);
    }
}

fn canonical_trusted_asset(path: PathBuf) -> Result<PathBuf, HostV2StorageError> {
    fs::canonicalize(path).map_err(|error| {
        HostV2StorageError::io(
            "host_kernel_bridge_v2_asset_resolve_failed",
            format!("canonicalize trusted Session Kernel v2 asset: {error}"),
        )
    })
}

fn trusted_node_candidates(executable_root: &Path) -> Vec<PathBuf> {
    let executable_name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = executable_root
        .ancestors()
        .flat_map(|ancestor| {
            [
                ancestor.join("node/bin").join(executable_name),
                ancestor.join("bin").join(executable_name),
            ]
        })
        .collect::<Vec<_>>();
    if let Some(home) = crate::utils::home_dir() {
        candidates.push(
            home.join(".local")
                .join("deepcode-node")
                .join("bin")
                .join(executable_name),
        );
    }
    if !cfg!(windows) {
        candidates.extend(
            [
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
    }
    candidates
}

fn file_sha256(path: &Path) -> Result<[u8; 32], HostV2StorageError> {
    let bytes = fs::read(path).map_err(|error| {
        HostV2StorageError::io(
            "host_kernel_bridge_v2_asset_read_failed",
            format!("read trusted Session Kernel v2 asset: {error}"),
        )
    })?;
    Ok(Sha256::digest(bytes).into())
}

fn validate_trusted_loopback_api_base(value: String) -> Result<String, HostV2StorageError> {
    let value = value.trim_end_matches('/').to_string();
    let authority = value.strip_prefix("http://").ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_bridge_v2_api_base_invalid",
            "Session Kernel v2 API base must be a daemon-owned loopback HTTP endpoint",
        )
    })?;
    let (host, port) = authority.rsplit_once(':').ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_bridge_v2_api_base_invalid",
            "Session Kernel v2 API base must include an explicit daemon listener port",
        )
    })?;
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]")
        || port.parse::<u16>().ok().filter(|port| *port != 0).is_none()
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_bridge_v2_api_base_invalid",
            "Session Kernel v2 API base must be a daemon-owned loopback HTTP endpoint",
        ));
    }
    Ok(value)
}
