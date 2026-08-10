use crate::host_run_broker_v2::{HostRunSettingsCeilingV2, HostRunWorkspaceKindV2};
use crate::host_v2_storage::{
    canonical_json_bytes, canonical_sha256, create_private_directory,
    reject_transport_capabilities, sha256_path_component, validate_bounded_identity,
    validate_safe_session_identity, validate_sha256_digest, HostV2StorageError,
};
use crate::host_workspace_registry_v2::HostWorkspaceRehydrateRecordV2;
use crate::session_bootstrap_v2::{
    HostProviderProfileBootstrapV2, HostSessionPriorEventsV2, HOST_SESSION_PRIOR_EVENTS_SCHEMA_V3,
};
use crate::AgentInputAttachmentV2;
use deepcode_kernel_abi::v2_command::{KernelCommandEnvelopeV2, KernelCommandV2, RunOpenReplyV2};
use deepcode_kernel_abi::WorkspaceBindingRefV2;
use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STORE_SCHEMA_V2: &str = "deepcode.host.kernel-durable-store.v4";
const RUN_ROW_SCHEMA_V2: &str = "deepcode.host.kernel-run.v4";
const BOOTSTRAP_SCHEMA_V2: &str = "deepcode.host.kernel-run-bootstrap.v2";
const CALLER_REQUEST_SCHEMA_V2: &str = "deepcode.host.caller-request.v3";
const OPERATION_ROW_SCHEMA_V2: &str = "deepcode.host.kernel-operation.v2";
const ATTEMPT_ROW_SCHEMA_V2: &str = "deepcode.host.kernel-dispatch-attempt.v2";
const HISTORY_SCHEMA_V3: &str = "deepcode.session.kernel-persistence.v3";
const PRODUCTION_FRAME_SCHEMA_V2: &str = "deepcode.session.kernel-production-request-frame.v2";
const PRODUCTION_REQUEST_SCHEMA_V2: &str = "deepcode.session.kernel-production-request.v2";
const PRODUCTION_RESPONSE_SCHEMA_V2: &str = "deepcode.session.kernel-production-response.v2";
const PREFETCHED_RUN_SCHEMA_V2: &str = "deepcode.session.prefetched-kernel-run.v2";
const SESSION_BOOTSTRAP_MATERIAL_SCHEMA_V2: &str =
    "deepcode.host.kernel-session-bootstrap-material.v2";
const HOST_RUN_OPEN_REQUEST_KIND_V2: &str = "agent.run.open.v2";
const HOST_CANCEL_REQUEST_KIND_V2: &str = "agent.run.cancel.v2";
const HOST_DECISION_REQUEST_KIND_V2: &str = "agent.run.decision.v2";
const HOST_USER_INPUT_REQUEST_KIND_V2: &str = "agent.run.user-input.v2";
const SQLITE_USER_VERSION_V2: i64 = 7;

const MAX_BOOTSTRAP_BYTES: usize = 8 * 1024 * 1024;
const MAX_INITIAL_INPUT_BYTES: usize = 1024 * 1024;
const MAX_OPERATION_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_RUN_ROWS: i64 = 16_384;
const MAX_CALLER_REQUEST_ROWS: i64 = 262_144;
const MAX_OPERATION_ROWS: i64 = 131_072;
const MAX_ATTEMPT_ROWS: i64 = 262_144;
const MAX_DATABASE_BYTES: i64 = 512 * 1024 * 1024;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const SQLITE_WAL_LIMIT_BYTES: i64 = 64 * 1024 * 1024;

static ATTEMPT_NONCE_V2: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostKernelBootstrapInitialInputV2 {
    pub(crate) input_id: String,
    pub(crate) opaque_input_ref: String,
    pub(crate) text: String,
    pub(crate) attachments: Vec<AgentInputAttachmentV2>,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostKernelSessionBootstrapMaterialV2 {
    schema_version: String,
    active_folder_id: Option<String>,
    initial_input: HostKernelBootstrapInitialInputV2,
    prior_session_events: HostSessionPriorEventsV2,
    provider_profile: HostProviderProfileBootstrapV2,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelRunOpeningInputV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) drive_caller_request_id: String,
    pub(crate) drive_request_digest: String,
    pub(crate) run_open_request_id: String,
    pub(crate) run_open_envelope: KernelCommandEnvelopeV2,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_canonical_root: PathBuf,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) active_folder_id: Option<String>,
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
    pub(crate) provider_profile: HostProviderProfileBootstrapV2,
    pub(crate) prior_session_events: HostSessionPriorEventsV2,
    pub(crate) initial_input: HostKernelBootstrapInitialInputV2,
    pub(crate) opening_recorded_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostKernelStoredRunLifecycleV2 {
    Opening,
    Active,
    Retired,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelRunOpeningRecordV2 {
    pub(crate) lifecycle: HostKernelStoredRunLifecycleV2,
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_open_request_id: String,
    pub(crate) run_open_envelope: KernelCommandEnvelopeV2,
    pub(crate) workspace_binding_ref: String,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_canonical_root: Option<PathBuf>,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) active_folder_id: Option<String>,
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
    pub(crate) provider_profile: HostProviderProfileBootstrapV2,
    pub(crate) prior_session_events: HostSessionPriorEventsV2,
    pub(crate) initial_input: HostKernelBootstrapInitialInputV2,
    pub(crate) opening_recorded_at: String,
    pub(crate) opening_digest: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelRunOpeningReceiptV2 {
    pub(crate) record: HostKernelRunOpeningRecordV2,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelBootstrapActivationV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_open_request_id: String,
    pub(crate) run_open_reply: RunOpenReplyV2,
    pub(crate) activated_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelBootstrapRecordV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) workspace_binding_ref: String,
    pub(crate) workspace_binding_digest: String,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_canonical_root: Option<PathBuf>,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) active_folder_id: Option<String>,
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
    pub(crate) run_open_reply: RunOpenReplyV2,
    pub(crate) provider_profile: HostProviderProfileBootstrapV2,
    pub(crate) prior_session_events: HostSessionPriorEventsV2,
    pub(crate) initial_input: HostKernelBootstrapInitialInputV2,
    pub(crate) bootstrap_digest: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelBootstrapReceiptV2 {
    pub(crate) record: HostKernelBootstrapRecordV2,
}

#[derive(Debug, Clone)]
pub(crate) enum HostKernelLiveRunForDeletionV2 {
    Opening(HostKernelRunOpeningRecordV2),
    Active(HostKernelBootstrapRecordV2),
}

#[derive(Debug, Clone)]
pub(crate) struct HostCallerRequestBindingInputV2 {
    pub(crate) session_id: String,
    pub(crate) caller_request_id: String,
    pub(crate) request_kind: String,
    pub(crate) request_digest: String,
    pub(crate) response_identity: Value,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostCallerRequestBindingReceiptV2 {
    pub(crate) session_id: String,
    pub(crate) caller_request_id: String,
    pub(crate) request_kind: String,
    pub(crate) request_digest: String,
    pub(crate) response_identity: Value,
    pub(crate) recorded_at: String,
    pub(crate) drive_state: HostCallerRequestDriveStateV2,
    pub(crate) drive_owner_instance_id: Option<String>,
    pub(crate) drive_started_at: Option<String>,
    pub(crate) admission: Option<Value>,
    pub(crate) admission_digest: Option<String>,
    pub(crate) admitted_at: Option<String>,
    pub(crate) outcome: Option<Value>,
    pub(crate) outcome_digest: Option<String>,
    pub(crate) replayed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostCallerRequestDriveStateV2 {
    Bound,
    Driving,
}

#[derive(Debug, Clone)]
pub(crate) struct HostCallerRequestDriveClaimReceiptV2 {
    pub(crate) binding: HostCallerRequestBindingReceiptV2,
    pub(crate) acquired: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct HostCallerRequestRecoveryEvidenceV2 {
    pub(crate) binding: HostCallerRequestBindingReceiptV2,
    pub(crate) run_lifecycle: Option<HostKernelStoredRunLifecycleV2>,
    pub(crate) kernel_run_id: Option<String>,
    pub(crate) provider_profile_id: Option<String>,
    pub(crate) run_recorded_at: Option<String>,
    pub(crate) retired_at: Option<String>,
    pub(crate) retirement_caller_request_id: Option<String>,
    pub(crate) retirement_request_digest: Option<String>,
    pub(crate) first_operation_present: bool,
    pub(crate) first_operation_pending: bool,
    pub(crate) first_settlement: Option<HostKernelOperationSettlementReceiptV2>,
    pub(crate) latest_settlement: Option<HostKernelOperationSettlementReceiptV2>,
}

#[derive(Debug, Clone)]
pub(crate) enum HostRunCallerDriveRecoveryV2 {
    NoDrive,
    Unadmitted(HostCallerRequestBindingReceiptV2),
    Admitted(HostCallerRequestBindingReceiptV2),
    Indeterminate(HostCallerRequestBindingReceiptV2),
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelOperationPreparedV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) bootstrap_digest: String,
    pub(crate) provider_profile_revision_digest: Option<String>,
    pub(crate) operation_request_id: String,
    pub(crate) caller_correlation: Option<HostKernelOperationCallerCorrelationV2>,
    /// The complete production frame is a strict safe DTO. Host transport and
    /// process launch details are rejected before it becomes durable.
    pub(crate) production_frame: Value,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelOperationCallerCorrelationV2 {
    pub(crate) caller_request_id: String,
    pub(crate) request_kind: String,
    pub(crate) request_digest: String,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct HostKernelPreparedOperationReceiptV2;

#[derive(Debug, Clone)]
pub(crate) struct HostKernelOperationRefV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) bootstrap_digest: String,
    pub(crate) operation_request_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelDispatchPrepareV2 {
    pub(crate) operation: HostKernelOperationRefV2,
    pub(crate) attempt_id: String,
    pub(crate) owner_instance_id: String,
    pub(crate) prepared_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelDispatchRecoveryV2 {
    pub(crate) operation: HostKernelOperationRefV2,
    pub(crate) previous_attempt_id: String,
    pub(crate) attempt_id: String,
    pub(crate) owner_instance_id: String,
    pub(crate) prepared_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostKernelDispatchAttemptStateV2 {
    Prepared,
    Committed,
    Indeterminate,
    Lost,
    ResponseObserved,
    Settled,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelDispatchAttemptReceiptV2 {
    pub(crate) attempt_id: String,
    pub(crate) owner_instance_id: String,
    pub(crate) state: HostKernelDispatchAttemptStateV2,
    pub(crate) observed_response: Option<Value>,
    pub(crate) response_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum HostKernelOperationSettlementV2 {
    Succeeded {
        response: Value,
        continuation: Value,
    },
    FailedRecoverable {
        error_code: String,
        boundary: HostKernelOperationFailureBoundaryV2,
    },
    FailedTerminal {
        error_code: String,
        boundary: HostKernelOperationFailureBoundaryV2,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelFailureDispositionV2 {
    CorrectRequest,
    RetrySameRequest,
    QueryFacts,
    DoNotRetry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelFailureCommitV2 {
    None,
    Committed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelFailureEffectV2 {
    None,
    Possible,
    Observed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelPendingRequestLaneV2 {
    Control,
    Effect,
    Query,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostKernelOperationFailureBoundaryV2 {
    pub(crate) disposition: HostKernelFailureDispositionV2,
    pub(crate) commit: HostKernelFailureCommitV2,
    pub(crate) effect: HostKernelFailureEffectV2,
    pub(crate) pending_request_lanes: Vec<HostKernelPendingRequestLaneV2>,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelPendingOperationV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) bootstrap_digest: String,
    pub(crate) operation_sequence: u64,
    pub(crate) operation_request_id: String,
    pub(crate) production_frame: Value,
    pub(crate) latest_attempt: Option<HostKernelDispatchAttemptReceiptV2>,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelOperationSettlementReceiptV2 {
    pub(crate) operation_request_id: String,
    pub(crate) settlement: HostKernelOperationSettlementV2,
    pub(crate) settlement_digest: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelStartupCancelRecoveryV2 {
    pub(crate) bootstrap: HostKernelBootstrapRecordV2,
    pub(crate) binding: HostCallerRequestBindingReceiptV2,
    pub(crate) cancel_operation_id: String,
    pub(crate) pending_operation: Option<HostKernelPendingOperationV2>,
    pub(crate) settlement: Option<HostKernelOperationSettlementReceiptV2>,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelStartupReconciliationV2 {
    pub(crate) opening_runs: Vec<HostKernelRunOpeningRecordV2>,
    pub(crate) active_runs: Vec<HostKernelBootstrapRecordV2>,
    pub(crate) pending_operations: Vec<HostKernelPendingOperationV2>,
    pub(crate) cancel_recoveries: Vec<HostKernelStartupCancelRecoveryV2>,
    pub(crate) unsupported_history_runs: Vec<(String, String)>,
    pub(crate) attempts_marked_indeterminate: usize,
}

#[derive(Clone)]
pub(crate) struct HostKernelOperationStoreV2 {
    sessions_dir: Arc<PathBuf>,
}

impl HostKernelOperationStoreV2 {
    pub(crate) fn new(sessions_dir: PathBuf) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
        }
    }

    pub(crate) fn workspace_rehydrate_records(
        &self,
        recoverable_session_ids: &HashSet<String>,
    ) -> Result<Vec<HostWorkspaceRehydrateRecordV2>, HostV2StorageError> {
        self.with_connection(|connection| {
            let stored_runs = query_live_runs(connection)?;
            let mut records = Vec::with_capacity(stored_runs.len());
            for stored in stored_runs {
                if !recoverable_session_ids.contains(&stored.session_id) {
                    continue;
                }
                let opening = match parse_run_lifecycle(&stored.lifecycle)? {
                    HostKernelStoredRunLifecycleV2::Opening
                    | HostKernelStoredRunLifecycleV2::Active => decode_opening_record(&stored)?,
                    HostKernelStoredRunLifecycleV2::Retired => continue,
                };
                let root = opening.workspace_canonical_root.ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_kernel_workspace_recovery_material_missing",
                        "UnsupportedHistorySchema: live Host Kernel Run has no Host-only workspace recovery root",
                    )
                })?;
                let reference = WorkspaceBindingRefV2::new(opening.workspace_binding_ref)
                    .map_err(|_| {
                        HostV2StorageError::conflict(
                            "host_kernel_recovery_workspace_binding_invalid",
                            "Durable Host bootstrap contains an invalid workspace binding reference",
                        )
                    })?;
                records.push(HostWorkspaceRehydrateRecordV2::new(
                    reference,
                    root,
                    Some(opening.workspace_binding_identity),
                ));
            }
            Ok(records)
        })
    }

    pub(crate) fn caller_request_binding(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
    ) -> Result<Option<HostCallerRequestBindingReceiptV2>, HostV2StorageError> {
        validate_caller_request_identity(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
        )?;
        self.with_connection(|connection| {
            let Some(stored) = stored_caller_request(connection, session_id, caller_request_id)?
            else {
                return Ok(None);
            };
            decode_caller_request_binding(stored, request_kind, request_digest, true).map(Some)
        })
    }

    pub(crate) fn bind_caller_request(
        &self,
        input: HostCallerRequestBindingInputV2,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        validate_caller_request_identity(
            &input.session_id,
            &input.caller_request_id,
            &input.request_kind,
            &input.request_digest,
        )?;
        validate_bounded_identity(&input.recorded_at, "recordedAt", 1024)?;
        reject_transport_capabilities(&input.response_identity)?;
        let response_identity_json = canonical_json_string(&input.response_identity)?;
        let response_identity_digest = canonical_sha256(&input.response_identity)?;
        if response_identity_json.len() > MAX_OPERATION_FRAME_BYTES {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_identity_too_large",
                "Host caller request identity exceeds its bounded size",
            ));
        }
        self.with_write_transaction(|transaction| {
            if let Some(stored) =
                stored_caller_request(transaction, &input.session_id, &input.caller_request_id)?
            {
                return decode_caller_request_binding(
                    stored,
                    &input.request_kind,
                    &input.request_digest,
                    true,
                );
            }
            reserve_row(transaction, "caller_request_rows", MAX_CALLER_REQUEST_ROWS)?;
            transaction
                .execute(
                    "INSERT INTO host_caller_requests (
                        schema_version, session_id, caller_request_id, request_kind,
                        request_digest, response_identity_json,
                        response_identity_digest, recorded_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        CALLER_REQUEST_SCHEMA_V2,
                        input.session_id,
                        input.caller_request_id,
                        input.request_kind,
                        input.request_digest,
                        response_identity_json,
                        response_identity_digest,
                        input.recorded_at,
                    ],
                )
                .map_err(|error| database_error("host_caller_request_bind_failed", error))?;
            Ok(HostCallerRequestBindingReceiptV2 {
                session_id: input.session_id,
                caller_request_id: input.caller_request_id,
                request_kind: input.request_kind,
                request_digest: input.request_digest,
                response_identity: input.response_identity,
                recorded_at: input.recorded_at,
                drive_state: HostCallerRequestDriveStateV2::Bound,
                drive_owner_instance_id: None,
                drive_started_at: None,
                admission: None,
                admission_digest: None,
                admitted_at: None,
                outcome: None,
                outcome_digest: None,
                replayed: false,
            })
        })
    }

    /// `Bound` is the only replay-safe admission state. Once a request becomes
    /// `Driving`, all later callers must reconcile its correlated operations or
    /// retirement; they must never acquire execution ownership again.
    pub(crate) fn claim_caller_request_drive(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        started_at: &str,
    ) -> Result<HostCallerRequestDriveClaimReceiptV2, HostV2StorageError> {
        validate_caller_request_identity(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
        )?;
        validate_bounded_identity(owner_instance_id, "driveOwnerInstanceId", 256)?;
        validate_bounded_identity(started_at, "driveStartedAt", 1024)?;
        self.with_write_transaction(|transaction| {
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_not_found",
                        "Host caller request must be bound before drive admission",
                    )
                })?;
            let existing =
                decode_caller_request_binding(stored, request_kind, request_digest, true)?;
            if existing.outcome.is_some()
                || existing.drive_state == HostCallerRequestDriveStateV2::Driving
            {
                return Ok(HostCallerRequestDriveClaimReceiptV2 {
                    binding: existing,
                    acquired: false,
                });
            }
            let changed = transaction
                .execute(
                    "UPDATE host_caller_requests
                     SET drive_state = 'Driving', drive_owner_instance_id = ?1,
                         drive_started_at = ?2
                     WHERE session_id = ?3 AND caller_request_id = ?4
                       AND drive_state = 'Bound' AND outcome_json IS NULL",
                    params![owner_instance_id, started_at, session_id, caller_request_id,],
                )
                .map_err(|error| database_error("host_caller_request_drive_claim_failed", error))?;
            if changed != 1 {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_drive_claim_conflict",
                    "Host caller request drive ownership changed before durable admission",
                ));
            }
            let host_run_id = existing
                .response_identity
                .get("hostRunId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Host caller request drive has no exact Host Run identity",
                    )
                })?;
            if let Some(run) = stored_run_by_session_host(transaction, session_id, host_run_id)? {
                if parse_run_lifecycle(&run.lifecycle)? != HostKernelStoredRunLifecycleV2::Active {
                    return Err(HostV2StorageError::conflict(
                        "host_caller_request_run_not_active",
                        "Host caller request cannot acquire a non-active Run drive",
                    ));
                }
                match (
                    run.drive_caller_request_id.as_deref(),
                    run.drive_request_digest.as_deref(),
                ) {
                    (None, None) => {
                        let changed = transaction
                            .execute(
                                "UPDATE host_kernel_runs
                                 SET drive_caller_request_id = ?1, drive_request_digest = ?2
                                 WHERE id = ?3 AND lifecycle = 'Active'
                                   AND drive_caller_request_id IS NULL
                                   AND drive_request_digest IS NULL",
                                params![caller_request_id, request_digest, run.id],
                            )
                            .map_err(|error| {
                                database_error("host_caller_request_run_drive_bind_failed", error)
                            })?;
                        if changed != 1 {
                            return Err(HostV2StorageError::conflict(
                                "host_caller_request_run_drive_conflict",
                                "Host Run drive ownership changed during caller admission",
                            ));
                        }
                    }
                    (Some(current_id), Some(current_digest))
                        if current_id == caller_request_id && current_digest == request_digest => {}
                    _ => {
                        return Err(HostV2StorageError::conflict(
                            "host_caller_request_run_drive_conflict",
                            "Host Run is already driven by another caller request",
                        ))
                    }
                }
            }
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::io(
                        "host_caller_request_drive_claim_lost",
                        "Drive-owned Host caller request disappeared before commit",
                    )
                })?;
            Ok(HostCallerRequestDriveClaimReceiptV2 {
                binding: decode_caller_request_binding(
                    stored,
                    request_kind,
                    request_digest,
                    false,
                )?,
                acquired: true,
            })
        })
    }

    /// Persists the stable HTTP admission result without releasing the
    /// ordinary Run drive. The exact owner remains responsible for either a
    /// terminal caller outcome or an explicit indeterminate settlement.
    pub(crate) fn admit_caller_request(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        admission: Value,
        admitted_at: &str,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        validate_caller_request_identity(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
        )?;
        validate_bounded_identity(owner_instance_id, "driveOwnerInstanceId", 256)?;
        validate_bounded_identity(admitted_at, "admittedAt", 1024)?;
        reject_transport_capabilities(&admission)?;
        let admission_json = canonical_json_string(&admission)?;
        if admission_json.len() > MAX_RESPONSE_BYTES {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_admission_too_large",
                "Host caller request admission exceeds its bounded size",
            ));
        }
        let admission_digest = canonical_sha256(&admission)?;
        self.with_write_transaction(|transaction| {
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_not_found",
                        "Host caller request must be bound before admission",
                    )
                })?;
            let existing =
                decode_caller_request_binding(stored, request_kind, request_digest, true)?;
            if let Some(existing_digest) = existing.admission_digest.as_deref() {
                if existing_digest == admission_digest {
                    return Ok(existing);
                }
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_admission_conflict",
                    "Host caller request admission is permanently bound to different content",
                ));
            }
            if existing.drive_state != HostCallerRequestDriveStateV2::Driving
                || existing.drive_owner_instance_id.as_deref() != Some(owner_instance_id)
                || existing.outcome.is_some()
            {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_not_driving",
                    "Only the exact unsettled drive owner may admit a Host caller request",
                ));
            }
            let host_run_id = existing
                .response_identity
                .get("hostRunId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Host caller request admission has no exact Host Run identity",
                    )
                })?;
            let run = stored_run_by_session_host(transaction, session_id, host_run_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_run_not_found",
                        "Host caller request admission is bound to a missing Run",
                    )
                })?;
            if parse_run_lifecycle(&run.lifecycle)? != HostKernelStoredRunLifecycleV2::Active
                || run.drive_caller_request_id.as_deref() != Some(caller_request_id)
                || run.drive_request_digest.as_deref() != Some(request_digest)
            {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_run_drive_conflict",
                    "Host caller request admission does not own the exact active Run drive",
                ));
            }
            let changed = transaction
                .execute(
                    "UPDATE host_caller_requests
                     SET admission_json = ?1, admission_digest = ?2, admitted_at = ?3
                     WHERE session_id = ?4 AND caller_request_id = ?5
                       AND drive_state = 'Driving' AND drive_owner_instance_id = ?6
                       AND admission_json IS NULL AND outcome_json IS NULL",
                    params![
                        admission_json,
                        admission_digest,
                        admitted_at,
                        session_id,
                        caller_request_id,
                        owner_instance_id,
                    ],
                )
                .map_err(|error| database_error("host_caller_request_admission_failed", error))?;
            if changed != 1 {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_admission_conflict",
                    "Host caller request drive changed before durable admission",
                ));
            }
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::io(
                        "host_caller_request_admission_lost",
                        "Admitted Host caller request disappeared before commit",
                    )
                })?;
            decode_caller_request_binding(stored, request_kind, request_digest, false)
        })
    }

    /// Classifies the exact durable caller correlation before startup restores
    /// any Run owner. A generic facts wait is safe only for `NoDrive`.
    pub(crate) fn caller_drive_recovery_for_run(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<HostRunCallerDriveRecoveryV2, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        self.with_connection(|connection| {
            let Some(run) = stored_run_by_session_host(connection, session_id, host_run_id)? else {
                return Ok(HostRunCallerDriveRecoveryV2::NoDrive);
            };
            if parse_run_lifecycle(&run.lifecycle)? != HostKernelStoredRunLifecycleV2::Active {
                return Ok(HostRunCallerDriveRecoveryV2::NoDrive);
            }
            let (caller_request_id, request_digest) = match (
                run.drive_caller_request_id.as_deref(),
                run.drive_request_digest.as_deref(),
            ) {
                (None, None) => return Ok(HostRunCallerDriveRecoveryV2::NoDrive),
                (Some(caller_request_id), Some(request_digest)) => {
                    (caller_request_id, request_digest)
                }
                _ => {
                    return Err(corrupt(
                        "Active Host Run has a partial caller drive identity",
                    ))
                }
            };
            let stored = stored_caller_request(connection, session_id, caller_request_id)?
                .ok_or_else(|| {
                    corrupt("Active Host Run drive references a missing caller request")
                })?;
            let request_kind = stored.request_kind.clone();
            let binding =
                decode_caller_request_binding(stored, &request_kind, request_digest, true)?;
            if binding.drive_state != HostCallerRequestDriveStateV2::Driving {
                return Err(corrupt(
                    "Active Host Run drive references a caller that is not Driving",
                ));
            }
            if binding
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.get("disposition"))
                .and_then(Value::as_str)
                == Some("indeterminate")
            {
                return Ok(HostRunCallerDriveRecoveryV2::Indeterminate(binding));
            }
            if binding.outcome.is_some() {
                return Err(corrupt(
                    "Terminal Host caller outcome retained an active Run drive",
                ));
            }
            if binding.admission.is_some() {
                Ok(HostRunCallerDriveRecoveryV2::Admitted(binding))
            } else {
                Ok(HostRunCallerDriveRecoveryV2::Unadmitted(binding))
            }
        })
    }

    pub(crate) fn unadmitted_driving_run_open_callers(
        &self,
        recoverable_session_ids: &HashSet<String>,
    ) -> Result<Vec<HostCallerRequestBindingReceiptV2>, HostV2StorageError> {
        for session_id in recoverable_session_ids {
            validate_safe_session_identity(session_id)?;
        }
        if recoverable_session_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(&format!(
                    "SELECT {} FROM host_caller_requests
                     WHERE request_kind = ?1
                       AND drive_state = 'Driving'
                       AND admission_json IS NULL
                       AND outcome_json IS NULL
                     ORDER BY session_id, caller_request_id",
                    CALLER_REQUEST_COLUMNS
                ))
                .map_err(|error| {
                    database_error("host_run_open_unadmitted_startup_query_failed", error)
                })?;
            let rows = statement
                .query_map(
                    params![HOST_RUN_OPEN_REQUEST_KIND_V2],
                    StoredCallerRequestV2::from_row,
                )
                .map_err(|error| {
                    database_error("host_run_open_unadmitted_startup_query_failed", error)
                })?;
            let mut bindings = Vec::new();
            for row in rows {
                let stored = row.map_err(|error| {
                    database_error("host_run_open_unadmitted_startup_query_failed", error)
                })?;
                if !recoverable_session_ids.contains(&stored.session_id) {
                    continue;
                }
                let request_digest = stored.request_digest.clone();
                let binding = decode_caller_request_binding(
                    stored,
                    HOST_RUN_OPEN_REQUEST_KIND_V2,
                    &request_digest,
                    true,
                )?;
                if binding.drive_state != HostCallerRequestDriveStateV2::Driving
                    || binding.admission.is_some()
                    || binding.outcome.is_some()
                {
                    return Err(corrupt(
                        "RunOpen unadmitted startup query returned an invalid caller boundary",
                    ));
                }
                bindings.push(binding);
            }
            Ok(bindings)
        })
    }

    pub(crate) fn driving_interrupt_callers(
        &self,
        recoverable_session_ids: &HashSet<String>,
    ) -> Result<Vec<HostCallerRequestBindingReceiptV2>, HostV2StorageError> {
        for session_id in recoverable_session_ids {
            validate_safe_session_identity(session_id)?;
        }
        if recoverable_session_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(&format!(
                    "SELECT {} FROM host_caller_requests
                     WHERE request_kind IN (?1, ?2)
                       AND drive_state = 'Driving'
                       AND outcome_json IS NULL
                     ORDER BY session_id, caller_request_id",
                    CALLER_REQUEST_COLUMNS
                ))
                .map_err(|error| database_error("host_interrupt_startup_query_failed", error))?;
            let rows = statement
                .query_map(
                    params![HOST_USER_INPUT_REQUEST_KIND_V2, HOST_CANCEL_REQUEST_KIND_V2],
                    StoredCallerRequestV2::from_row,
                )
                .map_err(|error| database_error("host_interrupt_startup_query_failed", error))?;
            let mut bindings = Vec::new();
            for row in rows {
                let stored = row.map_err(|error| {
                    database_error("host_interrupt_startup_query_failed", error)
                })?;
                if !recoverable_session_ids.contains(&stored.session_id) {
                    continue;
                }
                let request_kind = stored.request_kind.clone();
                let request_digest = stored.request_digest.clone();
                let binding =
                    decode_caller_request_binding(stored, &request_kind, &request_digest, true)?;
                if binding.drive_state != HostCallerRequestDriveStateV2::Driving
                    || binding.outcome.is_some()
                {
                    return Err(corrupt(
                        "Interrupt startup query returned an invalid caller boundary",
                    ));
                }
                if binding.admission.is_some() {
                    let host_run_id = binding
                        .response_identity
                        .get("hostRunId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            corrupt(
                                "Admitted interrupt startup recovery has no exact Host Run identity",
                            )
                        })?;
                    let run = stored_run_by_session_host(connection, &binding.session_id, host_run_id)?
                        .ok_or_else(|| {
                            corrupt(
                                "Admitted interrupt startup recovery references a missing Host Run",
                            )
                        })?;
                    if parse_run_lifecycle(&run.lifecycle)?
                        != HostKernelStoredRunLifecycleV2::Retired
                    {
                        // Active admitted callers are recovered by the ordinary
                        // active-Run owner restoration below. This query only
                        // adds the retained Retired+drive crash marker.
                        continue;
                    }
                    if run.drive_caller_request_id.as_deref()
                        != Some(binding.caller_request_id.as_str())
                        || run.drive_request_digest.as_deref()
                            != Some(binding.request_digest.as_str())
                    {
                        return Err(corrupt(
                            "Retired admitted interrupt lost its exact Run drive correlation",
                        ));
                    }
                }
                bindings.push(binding);
            }
            Ok(bindings)
        })
    }

    pub(crate) fn pending_interrupt_caller(
        &self,
        session_id: &str,
    ) -> Result<Option<HostCallerRequestBindingReceiptV2>, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(&format!(
                    "SELECT {} FROM host_caller_requests
                     WHERE session_id = ?1 AND request_kind IN (?2, ?3)
                       AND drive_state = 'Driving'
                       AND admission_json IS NULL
                       AND outcome_json IS NULL
                     ORDER BY caller_request_id",
                    CALLER_REQUEST_COLUMNS
                ))
                .map_err(|error| database_error("host_interrupt_mailbox_query_failed", error))?;
            let rows = statement
                .query_map(
                    params![
                        session_id,
                        HOST_USER_INPUT_REQUEST_KIND_V2,
                        HOST_CANCEL_REQUEST_KIND_V2,
                    ],
                    StoredCallerRequestV2::from_row,
                )
                .map_err(|error| database_error("host_interrupt_mailbox_query_failed", error))?;
            let mut pending = None;
            for row in rows {
                let stored = row.map_err(|error| {
                    database_error("host_interrupt_mailbox_query_failed", error)
                })?;
                if pending.is_some() {
                    return Err(corrupt(
                        "A Session has more than one pending durable Host mutation",
                    ));
                }
                let request_kind = stored.request_kind.clone();
                let request_digest = stored.request_digest.clone();
                let binding =
                    decode_caller_request_binding(stored, &request_kind, &request_digest, true)?;
                if binding.drive_state != HostCallerRequestDriveStateV2::Driving
                    || binding.admission.is_some()
                    || binding.outcome.is_some()
                {
                    return Err(corrupt(
                        "Pending interrupt query returned an invalid caller boundary",
                    ));
                }
                pending = Some(binding);
            }
            Ok(pending)
        })
    }

    pub(crate) fn reclaim_admitted_caller_request_drive(
        &self,
        binding: &HostCallerRequestBindingReceiptV2,
        owner_instance_id: &str,
        reclaimed_at: &str,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        self.reclaim_caller_request_drive_inner(binding, owner_instance_id, reclaimed_at, true)
    }

    fn reclaim_caller_request_drive_inner(
        &self,
        binding: &HostCallerRequestBindingReceiptV2,
        owner_instance_id: &str,
        reclaimed_at: &str,
        require_admission: bool,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        validate_bounded_identity(owner_instance_id, "driveOwnerInstanceId", 256)?;
        validate_bounded_identity(reclaimed_at, "driveStartedAt", 1024)?;
        self.with_write_transaction(|transaction| {
            let stored = stored_caller_request(
                transaction,
                &binding.session_id,
                &binding.caller_request_id,
            )?
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_caller_request_not_found",
                    "Startup caller drive recovery requires an exact durable binding",
                )
            })?;
            let current = decode_caller_request_binding(
                stored,
                &binding.request_kind,
                &binding.request_digest,
                true,
            )?;
            if current.drive_state != HostCallerRequestDriveStateV2::Driving
                || current.outcome.is_some()
                || if require_admission {
                    current.admission_digest != binding.admission_digest
                        || current.admission.is_none()
                } else {
                    current.admission.is_some() || binding.admission.is_some()
                }
            {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_reclaim_conflict",
                    "Startup caller drive recovery no longer matches the exact request boundary",
                ));
            }
            let host_run_id = current
                .response_identity
                .get("hostRunId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Startup caller drive recovery has no exact Host Run identity",
                    )
                })?;
            let run = stored_run_by_session_host(transaction, &binding.session_id, host_run_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_run_not_found",
                        "Startup caller drive recovery is bound to a missing Run",
                    )
                })?;
            if parse_run_lifecycle(&run.lifecycle)? != HostKernelStoredRunLifecycleV2::Active
                || run.drive_caller_request_id.as_deref()
                    != Some(binding.caller_request_id.as_str())
                || run.drive_request_digest.as_deref() != Some(binding.request_digest.as_str())
            {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_run_drive_conflict",
                    "Startup caller drive recovery no longer owns the exact active Run drive",
                ));
            }
            let changed = if require_admission {
                transaction.execute(
                    "UPDATE host_caller_requests
                     SET drive_owner_instance_id = ?1, drive_started_at = ?2
                     WHERE session_id = ?3 AND caller_request_id = ?4
                       AND request_digest = ?5 AND admission_digest = ?6
                       AND drive_state = 'Driving' AND outcome_json IS NULL
                       AND drive_owner_instance_id = ?7",
                    params![
                        owner_instance_id,
                        reclaimed_at,
                        binding.session_id,
                        binding.caller_request_id,
                        binding.request_digest,
                        binding.admission_digest,
                        binding.drive_owner_instance_id,
                    ],
                )
            } else {
                transaction.execute(
                    "UPDATE host_caller_requests
                     SET drive_owner_instance_id = ?1, drive_started_at = ?2
                     WHERE session_id = ?3 AND caller_request_id = ?4
                       AND request_digest = ?5 AND admission_digest IS NULL
                       AND drive_state = 'Driving' AND outcome_json IS NULL
                       AND drive_owner_instance_id = ?6",
                    params![
                        owner_instance_id,
                        reclaimed_at,
                        binding.session_id,
                        binding.caller_request_id,
                        binding.request_digest,
                        binding.drive_owner_instance_id,
                    ],
                )
            }
            .map_err(|error| database_error("host_caller_request_reclaim_failed", error))?;
            if changed != 1 {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_reclaim_conflict",
                    "Startup caller drive ownership changed before recovery",
                ));
            }
            let stored = stored_caller_request(
                transaction,
                &binding.session_id,
                &binding.caller_request_id,
            )?
            .ok_or_else(|| {
                HostV2StorageError::io(
                    "host_caller_request_reclaim_lost",
                    "Reclaimed Host caller request disappeared before commit",
                )
            })?;
            decode_caller_request_binding(
                stored,
                &binding.request_kind,
                &binding.request_digest,
                false,
            )
        })
    }

    /// Claims a high-priority control request without replacing the ordinary
    /// semantic caller that may still be driving the Run. The exact control
    /// operation is correlated separately when it is prepared.
    pub(crate) fn claim_caller_request_interrupt_drive(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        started_at: &str,
    ) -> Result<HostCallerRequestDriveClaimReceiptV2, HostV2StorageError> {
        if !matches!(
            request_kind,
            HOST_USER_INPUT_REQUEST_KIND_V2 | HOST_CANCEL_REQUEST_KIND_V2
        ) {
            return Err(HostV2StorageError::invalid(
                "host_interrupt_request_kind_invalid",
                "Only user input or exact cancellation may enter the Host interrupt mailbox",
            ));
        }
        validate_caller_request_identity(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
        )?;
        validate_bounded_identity(owner_instance_id, "driveOwnerInstanceId", 256)?;
        validate_bounded_identity(started_at, "driveStartedAt", 1024)?;
        self.with_write_transaction(|transaction| {
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_not_found",
                        "Host caller request must be bound before control admission",
                    )
                })?;
            let existing =
                decode_caller_request_binding(stored, request_kind, request_digest, true)?;
            if existing.outcome.is_some()
                || existing.drive_state == HostCallerRequestDriveStateV2::Driving
            {
                return Ok(HostCallerRequestDriveClaimReceiptV2 {
                    binding: existing,
                    acquired: false,
                });
            }
            let pending_interrupt_count: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM host_caller_requests
                     WHERE session_id = ?1 AND caller_request_id != ?2
                       AND request_kind IN (?3, ?4)
                       AND drive_state = 'Driving'
                       AND admission_json IS NULL
                       AND outcome_json IS NULL",
                    params![
                        session_id,
                        caller_request_id,
                        HOST_USER_INPUT_REQUEST_KIND_V2,
                        HOST_CANCEL_REQUEST_KIND_V2,
                    ],
                    |row| row.get(0),
                )
                .map_err(|error| database_error("host_interrupt_mailbox_query_failed", error))?;
            if pending_interrupt_count != 0 {
                return Err(HostV2StorageError::conflict(
                    "host_interrupt_mailbox_busy",
                    "This Session already has one pending durable Host mutation",
                ));
            }
            let host_run_id = existing
                .response_identity
                .get("hostRunId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Host control request has no exact Host Run identity",
                    )
                })?;
            let run_id = existing
                .response_identity
                .get("runId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Host control request has no exact Kernel Run identity",
                    )
                })?;
            let run = stored_run_by_session_host(transaction, session_id, host_run_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_run_not_found",
                        "Host control request is bound to a missing Run",
                    )
                })?;
            if parse_run_lifecycle(&run.lifecycle)? != HostKernelStoredRunLifecycleV2::Active
                || run.run_id.as_deref() != Some(run_id)
            {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_run_not_active",
                    "Host control request cannot acquire a non-active Run",
                ));
            }
            let changed = transaction
                .execute(
                    "UPDATE host_caller_requests
                     SET drive_state = 'Driving', drive_owner_instance_id = ?1,
                         drive_started_at = ?2
                     WHERE session_id = ?3 AND caller_request_id = ?4
                       AND drive_state = 'Bound' AND outcome_json IS NULL",
                    params![owner_instance_id, started_at, session_id, caller_request_id],
                )
                .map_err(|error| {
                    database_error("host_caller_control_request_drive_claim_failed", error)
                })?;
            if changed != 1 {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_drive_claim_conflict",
                    "Host control request drive ownership changed before durable admission",
                ));
            }
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::io(
                        "host_caller_request_drive_claim_lost",
                        "Drive-owned Host control request disappeared before commit",
                    )
                })?;
            Ok(HostCallerRequestDriveClaimReceiptV2 {
                binding: decode_caller_request_binding(
                    stored,
                    request_kind,
                    request_digest,
                    false,
                )?,
                acquired: true,
            })
        })
    }

    pub(crate) fn handoff_run_drive_to_interrupt_caller(
        &self,
        binding: &HostCallerRequestBindingReceiptV2,
        owner_instance_id: &str,
        superseded_outcome: Value,
        transferred_at: &str,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        if binding.request_kind != HOST_USER_INPUT_REQUEST_KIND_V2 {
            return Err(HostV2StorageError::invalid(
                "host_interrupt_drive_handoff_kind_invalid",
                "Only an exact user-input interrupt may take over an active Run drive",
            ));
        }
        validate_bounded_identity(owner_instance_id, "driveOwnerInstanceId", 256)?;
        validate_bounded_identity(transferred_at, "transferredAt", 1024)?;
        reject_transport_capabilities(&superseded_outcome)?;
        if superseded_outcome
            .get("disposition")
            .and_then(Value::as_str)
            != Some("indeterminate")
        {
            return Err(HostV2StorageError::invalid(
                "host_interrupt_drive_handoff_outcome_invalid",
                "Superseded Run drive ownership requires an indeterminate caller outcome",
            ));
        }
        let superseded_outcome_json = canonical_json_string(&superseded_outcome)?;
        if superseded_outcome_json.len() > MAX_RESPONSE_BYTES {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_outcome_too_large",
                "Superseded Host caller request outcome exceeds its bounded size",
            ));
        }
        let superseded_outcome_digest = canonical_sha256(&superseded_outcome)?;
        self.with_write_transaction(|transaction| {
            let stored = stored_caller_request(
                transaction,
                &binding.session_id,
                &binding.caller_request_id,
            )?
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_caller_request_not_found",
                    "Interrupt Run drive handoff requires an exact durable caller binding",
                )
            })?;
            let current = decode_caller_request_binding(
                stored,
                &binding.request_kind,
                &binding.request_digest,
                true,
            )?;
            if current.drive_state != HostCallerRequestDriveStateV2::Driving
                || current.drive_owner_instance_id.as_deref() != Some(owner_instance_id)
                || current.admission.is_some()
                || current.outcome.is_some()
            {
                return Err(HostV2StorageError::conflict(
                    "host_interrupt_drive_handoff_owner_conflict",
                    "Only the exact unsettled interrupt owner may take over the Run drive",
                ));
            }
            let host_run_id = current
                .response_identity
                .get("hostRunId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Interrupt Run drive handoff has no exact Host Run identity",
                    )
                })?;
            let run_id = current
                .response_identity
                .get("runId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Interrupt Run drive handoff has no exact Kernel Run identity",
                    )
                })?;
            if superseded_outcome.get("hostRunId").and_then(Value::as_str) != Some(host_run_id) {
                return Err(HostV2StorageError::conflict(
                    "host_interrupt_drive_handoff_outcome_conflict",
                    "Superseded caller outcome belongs to a different Host Run",
                ));
            }
            let run = stored_run_by_session_host(transaction, &binding.session_id, host_run_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_run_not_found",
                        "Interrupt Run drive handoff is bound to a missing Run",
                    )
                })?;
            if parse_run_lifecycle(&run.lifecycle)? != HostKernelStoredRunLifecycleV2::Active
                || run.run_id.as_deref() != Some(run_id)
            {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_run_not_active",
                    "Interrupt Run drive handoff requires the exact active Run",
                ));
            }

            match (
                run.drive_caller_request_id.as_deref(),
                run.drive_request_digest.as_deref(),
            ) {
                (Some(current_id), Some(current_digest))
                    if current_id == current.caller_request_id
                        && current_digest == current.request_digest => {}
                (None, None) => {
                    let changed = transaction
                        .execute(
                            "UPDATE host_kernel_runs
                             SET drive_caller_request_id = ?1, drive_request_digest = ?2
                             WHERE id = ?3 AND lifecycle = 'Active'
                               AND drive_caller_request_id IS NULL
                               AND drive_request_digest IS NULL",
                            params![current.caller_request_id, current.request_digest, run.id,],
                        )
                        .map_err(|error| {
                            database_error("host_interrupt_run_drive_handoff_failed", error)
                        })?;
                    if changed != 1 {
                        return Err(HostV2StorageError::conflict(
                            "host_interrupt_run_drive_handoff_conflict",
                            "Host Run drive changed before interrupt takeover",
                        ));
                    }
                }
                (Some(previous_id), Some(previous_digest)) => {
                    let previous_stored =
                        stored_caller_request(transaction, &binding.session_id, previous_id)?
                            .ok_or_else(|| {
                                HostV2StorageError::conflict(
                                    "host_interrupt_previous_drive_missing",
                                    "The superseded Host Run drive references a missing caller",
                                )
                            })?;
                    let previous_kind = previous_stored.request_kind.clone();
                    let previous = decode_caller_request_binding(
                        previous_stored,
                        &previous_kind,
                        previous_digest,
                        true,
                    )?;
                    if previous.drive_state != HostCallerRequestDriveStateV2::Driving
                        || previous.outcome.is_some()
                    {
                        return Err(HostV2StorageError::conflict(
                            "host_interrupt_previous_drive_conflict",
                            "The superseded Host Run caller is not an unsettled drive owner",
                        ));
                    }
                    let settled = transaction
                        .execute(
                            "UPDATE host_caller_requests
                             SET outcome_json = ?1, outcome_digest = ?2, settled_at = ?3
                             WHERE session_id = ?4 AND caller_request_id = ?5
                               AND request_digest = ?6 AND drive_state = 'Driving'
                               AND outcome_json IS NULL",
                            params![
                                superseded_outcome_json,
                                superseded_outcome_digest,
                                transferred_at,
                                binding.session_id,
                                previous_id,
                                previous_digest,
                            ],
                        )
                        .map_err(|error| {
                            database_error("host_interrupt_previous_drive_settle_failed", error)
                        })?;
                    if settled != 1 {
                        return Err(HostV2StorageError::conflict(
                            "host_interrupt_previous_drive_settle_conflict",
                            "The superseded Host Run caller changed before interrupt takeover",
                        ));
                    }
                    let changed = transaction
                        .execute(
                            "UPDATE host_kernel_runs
                             SET drive_caller_request_id = ?1, drive_request_digest = ?2
                             WHERE id = ?3 AND lifecycle = 'Active'
                               AND drive_caller_request_id = ?4
                               AND drive_request_digest = ?5",
                            params![
                                current.caller_request_id,
                                current.request_digest,
                                run.id,
                                previous_id,
                                previous_digest,
                            ],
                        )
                        .map_err(|error| {
                            database_error("host_interrupt_run_drive_handoff_failed", error)
                        })?;
                    if changed != 1 {
                        return Err(HostV2StorageError::conflict(
                            "host_interrupt_run_drive_handoff_conflict",
                            "Host Run drive changed before interrupt takeover",
                        ));
                    }
                }
                _ => return Err(corrupt(
                    "Active Host Run has a partial caller drive identity during interrupt takeover",
                )),
            }
            let stored = stored_caller_request(
                transaction,
                &binding.session_id,
                &binding.caller_request_id,
            )?
            .ok_or_else(|| {
                HostV2StorageError::io(
                    "host_interrupt_drive_handoff_lost",
                    "Interrupt caller disappeared before Run drive handoff commit",
                )
            })?;
            decode_caller_request_binding(
                stored,
                &binding.request_kind,
                &binding.request_digest,
                false,
            )
        })
    }

    pub(crate) fn settle_caller_request(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        outcome: Value,
        settled_at: String,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        self.settle_caller_request_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            None,
            outcome,
            settled_at,
        )
    }

    pub(crate) fn settle_owned_caller_request(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        admission_digest: &str,
        outcome: Value,
        settled_at: String,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        validate_bounded_identity(owner_instance_id, "driveOwnerInstanceId", 256)?;
        validate_sha256_digest(admission_digest, "admissionDigest")?;
        self.settle_caller_request_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            Some((owner_instance_id, admission_digest)),
            outcome,
            settled_at,
        )
    }

    pub(crate) fn settle_unadmitted_owned_caller_request(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        outcome: Value,
        settled_at: String,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        self.settle_unadmitted_owned_caller_request_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            owner_instance_id,
            outcome,
            settled_at,
            "failed",
            true,
            true,
        )
    }

    pub(crate) fn settle_unadmitted_owned_caller_indeterminate(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        outcome: Value,
        settled_at: String,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        self.settle_unadmitted_owned_caller_request_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            owner_instance_id,
            outcome,
            settled_at,
            "indeterminate",
            false,
            false,
        )
    }

    pub(crate) fn settle_unadmitted_owned_run_open_success(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        outcome: Value,
        settled_at: String,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        if request_kind != HOST_RUN_OPEN_REQUEST_KIND_V2 {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_run_open_success_kind_invalid",
                "Only RunOpen may persist an unadmitted successful caller outcome",
            ));
        }
        self.settle_unadmitted_owned_caller_request_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            owner_instance_id,
            outcome,
            settled_at,
            "succeeded",
            false,
            true,
        )
    }

    pub(crate) fn settle_unadmitted_owned_cancel_success(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        outcome: Value,
        settled_at: String,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        if request_kind != HOST_CANCEL_REQUEST_KIND_V2 {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_cancel_success_kind_invalid",
                "Only an exact Run cancellation may persist a control success outcome",
            ));
        }
        let evidence = self.caller_control_request_recovery_evidence(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
        )?;
        if evidence.run_lifecycle != Some(HostKernelStoredRunLifecycleV2::Retired)
            || evidence.retirement_caller_request_id.as_deref() != Some(caller_request_id)
            || evidence.retirement_request_digest.as_deref() != Some(request_digest)
            || !canonical_cancel_settlement_matches_binding(&evidence)?
        {
            return Err(HostV2StorageError::conflict(
                "host_caller_request_cancel_success_evidence_missing",
                "Run cancellation success requires exact canonical settlement and caller-correlated retirement evidence",
            ));
        }
        self.settle_unadmitted_owned_caller_request_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            owner_instance_id,
            outcome,
            settled_at,
            "succeeded",
            false,
            false,
        )
    }

    pub(crate) fn settle_unadmitted_owned_user_input_failure(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        outcome: Value,
        settled_at: String,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        if request_kind != HOST_USER_INPUT_REQUEST_KIND_V2 {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_user_input_failure_kind_invalid",
                "Only an exact user-input interrupt may persist this control failure outcome",
            ));
        }
        self.settle_unadmitted_owned_caller_request_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            owner_instance_id,
            outcome,
            settled_at,
            "failed",
            false,
            false,
        )
    }

    pub(crate) fn settle_unadmitted_owned_cancel_indeterminate(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        outcome: Value,
        settled_at: String,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        if request_kind != HOST_CANCEL_REQUEST_KIND_V2 {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_cancel_indeterminate_kind_invalid",
                "Only an exact Run cancellation may persist a control indeterminate outcome",
            ));
        }
        let evidence = self.caller_control_request_recovery_evidence(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
        )?;
        if evidence.run_lifecycle != Some(HostKernelStoredRunLifecycleV2::Retired) {
            return Err(HostV2StorageError::conflict(
                "host_caller_request_cancel_indeterminate_retirement_missing",
                "Indeterminate Run cancellation settlement requires completed run-wide safety retirement",
            ));
        }
        self.settle_unadmitted_owned_caller_request_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            owner_instance_id,
            outcome,
            settled_at,
            "indeterminate",
            false,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn settle_unadmitted_owned_caller_request_inner(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        owner_instance_id: &str,
        outcome: Value,
        settled_at: String,
        expected_disposition: &str,
        require_zero_operations: bool,
        release_run_drive: bool,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        validate_caller_request_identity(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
        )?;
        validate_bounded_identity(owner_instance_id, "driveOwnerInstanceId", 256)?;
        if require_zero_operations
            && !matches!(
                request_kind,
                HOST_DECISION_REQUEST_KIND_V2 | HOST_USER_INPUT_REQUEST_KIND_V2
            )
        {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_abandon_kind_invalid",
                "Only ordinary decision or user-input callers may use zero-effect abandonment",
            ));
        }
        if !require_zero_operations
            && !matches!(
                request_kind,
                HOST_RUN_OPEN_REQUEST_KIND_V2
                    | HOST_DECISION_REQUEST_KIND_V2
                    | HOST_USER_INPUT_REQUEST_KIND_V2
                    | HOST_CANCEL_REQUEST_KIND_V2
            )
        {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_unadmitted_kind_invalid",
                "Only RunOpen, decision, user-input, or exact cancellation callers may settle through the unadmitted owner boundary",
            ));
        }
        validate_bounded_identity(&settled_at, "settledAt", 1024)?;
        reject_transport_capabilities(&outcome)?;
        if outcome.get("disposition").and_then(Value::as_str) != Some(expected_disposition) {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_unadmitted_disposition_invalid",
                "Unadmitted caller settlement disposition does not match its requested boundary",
            ));
        }
        let outcome_json = canonical_json_string(&outcome)?;
        if outcome_json.len() > MAX_RESPONSE_BYTES {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_outcome_too_large",
                "Host caller request outcome exceeds its bounded size",
            ));
        }
        let outcome_digest = canonical_sha256(&outcome)?;
        self.with_write_transaction(|transaction| {
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_not_found",
                        "Host caller request must be bound before abandonment",
                    )
                })?;
            let existing =
                decode_caller_request_binding(stored, request_kind, request_digest, true)?;
            if existing.drive_state != HostCallerRequestDriveStateV2::Driving
                || existing.drive_owner_instance_id.as_deref() != Some(owner_instance_id)
                || existing.admission.is_some()
            {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_abandon_owner_conflict",
                    "Only the exact unadmitted caller owner may abandon this request",
                ));
            }
            if require_zero_operations {
                let correlated_operations: i64 = transaction
                    .query_row(
                        "SELECT COUNT(*) FROM host_kernel_operations
                         WHERE caller_request_id = ?1 AND caller_request_digest = ?2",
                        params![caller_request_id, request_digest],
                        |row| row.get(0),
                    )
                    .map_err(|error| {
                        database_error("host_caller_request_abandon_evidence_failed", error)
                    })?;
                if correlated_operations != 0 {
                    return Err(HostV2StorageError::conflict(
                        "host_caller_request_abandon_effect_conflict",
                        "A caller-correlated operation exists, so zero-effect abandonment is unsafe",
                    ));
                }
            }
            if let Some(existing_digest) = existing.outcome_digest.as_deref() {
                if existing_digest == outcome_digest {
                    return Ok(existing);
                }
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_outcome_conflict",
                    "Host caller request is already settled with different content",
                ));
            }
            let host_run_id = existing
                .response_identity
                .get("hostRunId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Unadmitted caller abandonment has no exact Host Run identity",
                    )
                })?;
            let changed = transaction
                .execute(
                    "UPDATE host_caller_requests
                     SET outcome_json = ?1, outcome_digest = ?2, settled_at = ?3
                     WHERE session_id = ?4 AND caller_request_id = ?5
                       AND outcome_json IS NULL AND admission_json IS NULL
                       AND drive_state = 'Driving' AND drive_owner_instance_id = ?6",
                    params![
                        outcome_json,
                        outcome_digest,
                        settled_at,
                        session_id,
                        caller_request_id,
                        owner_instance_id,
                    ],
                )
                .map_err(|error| database_error("host_caller_request_abandon_failed", error))?;
            if changed != 1 {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_abandon_conflict",
                    "Host caller request changed before zero-effect abandonment",
                ));
            }
            if release_run_drive {
                if stored_run_by_session_host(transaction, session_id, host_run_id)?.is_some() {
                    let released = transaction
                        .execute(
                            "UPDATE host_kernel_runs
                             SET drive_caller_request_id = NULL, drive_request_digest = NULL
                             WHERE session_id = ?1 AND host_run_id = ?2
                               AND drive_caller_request_id = ?3 AND drive_request_digest = ?4",
                            params![session_id, host_run_id, caller_request_id, request_digest],
                        )
                        .map_err(|error| {
                            database_error("host_caller_request_drive_release_failed", error)
                        })?;
                    if released != 1 {
                        return Err(HostV2StorageError::conflict(
                            "host_caller_request_drive_release_conflict",
                            "Unadmitted caller settlement did not release its exact Run drive",
                        ));
                    }
                } else if request_kind != HOST_RUN_OPEN_REQUEST_KIND_V2 {
                    return Err(HostV2StorageError::conflict(
                        "host_caller_request_run_missing",
                        "Ordinary unadmitted caller settlement requires its exact active Run",
                    ));
                }
            }
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::io(
                        "host_caller_request_settlement_lost",
                        "Abandoned Host caller request disappeared before commit",
                    )
                })?;
            decode_caller_request_binding(stored, request_kind, request_digest, false)
        })
    }

    fn settle_caller_request_inner(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        expected_owner: Option<(&str, &str)>,
        outcome: Value,
        settled_at: String,
    ) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
        validate_caller_request_identity(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
        )?;
        validate_bounded_identity(&settled_at, "settledAt", 1024)?;
        reject_transport_capabilities(&outcome)?;
        let release_run_drive =
            outcome.get("disposition").and_then(Value::as_str) != Some("indeterminate");
        let outcome_json = canonical_json_string(&outcome)?;
        if outcome_json.len() > MAX_RESPONSE_BYTES {
            return Err(HostV2StorageError::invalid(
                "host_caller_request_outcome_too_large",
                "Host caller request outcome exceeds its bounded size",
            ));
        }
        let outcome_digest = canonical_sha256(&outcome)?;
        self.with_write_transaction(|transaction| {
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_not_found",
                        "Host caller request must be bound before settlement",
                    )
                })?;
            let existing =
                decode_caller_request_binding(stored, request_kind, request_digest, true)?;
            if let Some((owner_instance_id, admission_digest)) = expected_owner {
                if existing.drive_state != HostCallerRequestDriveStateV2::Driving
                    || existing.drive_owner_instance_id.as_deref() != Some(owner_instance_id)
                    || existing.admission_digest.as_deref() != Some(admission_digest)
                {
                    return Err(HostV2StorageError::conflict(
                        "host_caller_request_owner_conflict",
                        "Only the exact admitted caller owner may settle this request",
                    ));
                }
            }
            if let Some(existing_digest) = &existing.outcome_digest {
                if existing_digest == &outcome_digest {
                    return Ok(existing);
                }
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_outcome_conflict",
                    "Host caller request is already settled with a different outcome",
                ));
            }
            let host_run_id = existing
                .response_identity
                .get("hostRunId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Host caller request settlement has no exact Host Run identity",
                    )
                })?;
            let changed = match expected_owner {
                Some((owner_instance_id, admission_digest)) => transaction.execute(
                    "UPDATE host_caller_requests
                     SET outcome_json = ?1, outcome_digest = ?2, settled_at = ?3
                     WHERE session_id = ?4 AND caller_request_id = ?5
                       AND outcome_json IS NULL AND drive_state = 'Driving'
                       AND drive_owner_instance_id = ?6 AND admission_digest = ?7",
                    params![
                        outcome_json,
                        outcome_digest,
                        settled_at,
                        session_id,
                        caller_request_id,
                        owner_instance_id,
                        admission_digest,
                    ],
                ),
                None => transaction.execute(
                    "UPDATE host_caller_requests
                     SET outcome_json = ?1, outcome_digest = ?2, settled_at = ?3
                     WHERE session_id = ?4 AND caller_request_id = ?5
                       AND outcome_json IS NULL",
                    params![
                        outcome_json,
                        outcome_digest,
                        settled_at,
                        session_id,
                        caller_request_id,
                    ],
                ),
            }
            .map_err(|error| database_error("host_caller_request_settle_failed", error))?;
            if changed != 1 {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_settle_conflict",
                    "Host caller request changed before durable settlement",
                ));
            }
            if release_run_drive {
                let released = transaction
                    .execute(
                        "UPDATE host_kernel_runs
                         SET drive_caller_request_id = NULL, drive_request_digest = NULL
                         WHERE session_id = ?1 AND host_run_id = ?2
                           AND drive_caller_request_id = ?3 AND drive_request_digest = ?4",
                        params![session_id, host_run_id, caller_request_id, request_digest,],
                    )
                    .map_err(|error| {
                        database_error("host_caller_request_drive_release_failed", error)
                    })?;
                if expected_owner.is_some() && released != 1 {
                    return Err(HostV2StorageError::conflict(
                        "host_caller_request_drive_release_conflict",
                        "Exact admitted caller settlement did not release its Run drive",
                    ));
                }
            }
            let stored = stored_caller_request(transaction, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::io(
                        "host_caller_request_settlement_lost",
                        "Settled Host caller request disappeared before commit",
                    )
                })?;
            decode_caller_request_binding(stored, request_kind, request_digest, false)
        })
    }

    pub(crate) fn caller_request_recovery_evidence(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
    ) -> Result<HostCallerRequestRecoveryEvidenceV2, HostV2StorageError> {
        self.caller_request_recovery_evidence_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            true,
        )
    }

    pub(crate) fn caller_control_request_recovery_evidence(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
    ) -> Result<HostCallerRequestRecoveryEvidenceV2, HostV2StorageError> {
        self.caller_request_recovery_evidence_inner(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
            false,
        )
    }

    fn caller_request_recovery_evidence_inner(
        &self,
        session_id: &str,
        caller_request_id: &str,
        request_kind: &str,
        request_digest: &str,
        require_run_drive: bool,
    ) -> Result<HostCallerRequestRecoveryEvidenceV2, HostV2StorageError> {
        validate_caller_request_identity(
            session_id,
            caller_request_id,
            request_kind,
            request_digest,
        )?;
        self.with_connection(|connection| {
            let stored = stored_caller_request(connection, session_id, caller_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_caller_request_not_found",
                        "Host caller request recovery requires an exact durable binding",
                    )
                })?;
            let binding =
                decode_caller_request_binding(stored, request_kind, request_digest, true)?;
            let host_run_id = binding
                .response_identity
                .get("hostRunId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_caller_request_identity_invalid",
                        "Host caller request recovery has no exact Host Run identity",
                    )
                })?;
            validate_bounded_identity(host_run_id, "hostRunId", 512)?;
            let run = stored_run_by_session_host(connection, session_id, host_run_id)?;
            if let Some(run) = run.as_ref().filter(|_| require_run_drive) {
                if run.drive_caller_request_id.as_deref()
                    != Some(binding.caller_request_id.as_str())
                    || run.drive_request_digest.as_deref() != Some(binding.request_digest.as_str())
                {
                    return Err(HostV2StorageError::conflict(
                        "host_caller_request_run_drive_conflict",
                        "Driving caller request does not own the exact durable Run correlation",
                    ));
                }
            }
            let (
                run_lifecycle,
                kernel_run_id,
                provider_profile_id,
                run_recorded_at,
                retired_at,
                retirement_caller_request_id,
                retirement_request_digest,
            ) = match run.as_ref() {
                Some(run) => {
                    let opening = decode_opening_record(run)?;
                    (
                        Some(opening.lifecycle),
                        run.run_id.clone(),
                        Some(opening.provider_profile.provider_profile_id),
                        Some(opening.opening_recorded_at),
                        run.retired_at.clone(),
                        run.retirement_caller_request_id.clone(),
                        run.retirement_request_digest.clone(),
                    )
                }
                None => (None, None, None, None, None, None, None),
            };
            if let (Some(expected_run_id), Some(run)) = (
                binding
                    .response_identity
                    .get("runId")
                    .and_then(Value::as_str),
                run.as_ref(),
            ) {
                if run.run_id.as_deref() != Some(expected_run_id) {
                    return Err(HostV2StorageError::conflict(
                        "host_caller_request_run_identity_conflict",
                        "Host caller request Kernel Run identity does not match durable state",
                    ));
                }
            }
            let first_operation_request_id = binding
                .response_identity
                .get("operationRequestId")
                .and_then(Value::as_str);
            if !require_run_drive && first_operation_request_id.is_none() {
                return Err(HostV2StorageError::conflict(
                    "host_caller_request_operation_identity_missing",
                    "Host control request recovery requires an exact operation identity",
                ));
            }
            let first_operation = first_operation_request_id
                .map(|operation_request_id| {
                    validate_operation_identity(operation_request_id)?;
                    stored_operation_by_request(connection, operation_request_id)
                })
                .transpose()?
                .flatten();
            if let (Some(run), Some(operation)) = (run.as_ref(), first_operation.as_ref()) {
                if operation.run_row_id != run.id {
                    return Err(HostV2StorageError::conflict(
                        "host_caller_request_operation_conflict",
                        "Host caller request first operation belongs to another Run",
                    ));
                }
                validate_stored_operation(operation)?;
                if operation.caller_request_id.as_deref()
                    != Some(binding.caller_request_id.as_str())
                    || operation.caller_request_digest.as_deref()
                        != Some(binding.request_digest.as_str())
                {
                    return Err(HostV2StorageError::conflict(
                        "host_caller_request_operation_correlation_conflict",
                        "Host caller request first operation lacks exact drive correlation",
                    ));
                }
            } else if first_operation.is_some() {
                return Err(corrupt(
                    "Host caller request operation references a missing Run",
                ));
            }
            let first_settlement = first_operation
                .as_ref()
                .filter(|operation| operation.settlement_digest.is_some())
                .map(|operation| verified_settlement_receipt(connection, operation))
                .transpose()?;
            let first_operation_present = first_operation.is_some();
            let first_operation_pending = first_operation
                .as_ref()
                .is_some_and(|operation| operation.settlement_digest.is_none());
            let latest_settlement = run
                .as_ref()
                .map(|run| {
                    connection
                        .query_row(
                            &format!(
                                "SELECT {} FROM host_kernel_operations
                                 WHERE run_row_id = ?1
                                   AND caller_request_id = ?2
                                   AND caller_request_digest = ?3
                                   AND settlement_digest IS NOT NULL
                                 ORDER BY operation_sequence DESC LIMIT 1",
                                OPERATION_COLUMNS
                            ),
                            params![run.id, binding.caller_request_id, binding.request_digest],
                            StoredOperationV2::from_row,
                        )
                        .optional()
                        .map_err(|error| {
                            database_error("host_kernel_operation_latest_query_failed", error)
                        })?
                        .as_ref()
                        .map(|operation| verified_settlement_receipt(connection, operation))
                        .transpose()
                })
                .transpose()?
                .flatten();
            Ok(HostCallerRequestRecoveryEvidenceV2 {
                binding,
                run_lifecycle,
                kernel_run_id,
                provider_profile_id,
                run_recorded_at,
                retired_at,
                retirement_caller_request_id,
                retirement_request_digest,
                first_operation_present,
                first_operation_pending,
                first_settlement,
                latest_settlement,
            })
        })
    }

    /// Durably reserves the Session before Kernel RunOpen. A second active or
    /// opening Run for the same Session is rejected by a partial unique index.
    pub(crate) fn begin_opening(
        &self,
        input: HostKernelRunOpeningInputV2,
    ) -> Result<HostKernelRunOpeningReceiptV2, HostV2StorageError> {
        let prepared = PreparedOpeningV2::new(input)?;
        self.with_write_transaction(|transaction| {
            if let Some(existing) =
                stored_run_by_open_request(transaction, &prepared.run_open_request_id)?
            {
                let record = decode_opening_record(&existing)?;
                if existing.opening_digest == prepared.opening_digest
                    && existing.session_id == prepared.session_id
                    && existing.host_run_id == prepared.host_run_id
                {
                    return Ok(HostKernelRunOpeningReceiptV2 { record });
                }
                return Err(HostV2StorageError::conflict(
                    "host_kernel_run_open_request_conflict",
                    "RunOpen request identity is permanently bound to different durable content",
                ));
            }
            if let Some(existing) = stored_live_run_for_session(transaction, &prepared.session_id)?
            {
                decode_opening_record(&existing)?;
                return Err(HostV2StorageError::conflict(
                    "host_kernel_session_run_already_live",
                    "Session already has an Opening or Active Host Kernel Run",
                ));
            }
            reserve_row(transaction, "run_rows", MAX_RUN_ROWS)?;
            transaction
                .execute(
                    "INSERT INTO host_kernel_runs (
                        schema_version, session_id, host_run_id, run_open_request_id,
                        lifecycle, run_open_envelope_json, run_open_envelope_digest,
                        workspace_binding_ref, workspace_binding_identity,
                        workspace_canonical_root, workspace_kind, empty_workspace_key,
                        run_settings_json, provider_profile_id,
                        provider_revision_digest, initial_input_json, opening_recorded_at,
                        opening_digest, opening_caller_request_id, opening_request_digest,
                        drive_caller_request_id, drive_request_digest
                     ) VALUES (
                        ?1, ?2, ?3, ?4, 'Opening', ?5, ?6, ?7, ?8, ?9, ?10,
                        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?18, ?19
                     )",
                    params![
                        RUN_ROW_SCHEMA_V2,
                        prepared.session_id,
                        prepared.host_run_id,
                        prepared.run_open_request_id,
                        prepared.run_open_envelope_json,
                        prepared.run_open_envelope_digest,
                        prepared.workspace_binding_ref,
                        prepared.workspace_binding_identity,
                        prepared.workspace_canonical_root,
                        workspace_kind_text(prepared.workspace_kind),
                        prepared.empty_workspace_key,
                        prepared.run_settings_json,
                        prepared.provider_profile_id,
                        prepared.provider_profile_revision_digest,
                        prepared.initial_input_json,
                        prepared.opening_recorded_at,
                        prepared.opening_digest,
                        prepared.drive_caller_request_id,
                        prepared.drive_request_digest,
                    ],
                )
                .map_err(|error| database_error("host_kernel_run_opening_write_failed", error))?;
            let stored = stored_run_by_open_request(transaction, &prepared.run_open_request_id)?
                .ok_or_else(|| {
                    HostV2StorageError::io(
                        "host_kernel_run_opening_write_lost",
                        "Opening Host Kernel Run disappeared before commit",
                    )
                })?;
            Ok(HostKernelRunOpeningReceiptV2 {
                record: decode_opening_record(&stored)?,
            })
        })
    }

    /// Atomically converts the exact Opening row into Active and binds the
    /// immutable safe RunOpen reply. Request/response correlation must already
    /// have been checked by the Host transport caller.
    pub(crate) fn activate_bootstrap(
        &self,
        input: HostKernelBootstrapActivationV2,
    ) -> Result<HostKernelBootstrapReceiptV2, HostV2StorageError> {
        validate_activation_input(&input)?;
        self.with_write_transaction(|transaction| {
            let stored = stored_run_exact(
                transaction,
                &input.session_id,
                &input.host_run_id,
                &input.run_open_request_id,
            )?
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_kernel_run_opening_not_found",
                    "Exact Opening Host Kernel Run was not found",
                )
            })?;
            let opening = decode_opening_record(&stored)?;
            let prepared = PreparedBootstrapV2::new(&opening, &input.run_open_reply)?;
            match opening.lifecycle {
                HostKernelStoredRunLifecycleV2::Opening => {
                    transaction
                        .execute(
                            "UPDATE host_kernel_runs
                             SET lifecycle = 'Active', run_id = ?1,
                                 run_open_reply_json = ?2,
                                 workspace_binding_digest = ?3,
                                 bootstrap_digest = ?4, activated_at = ?5
                             WHERE id = ?6 AND lifecycle = 'Opening'",
                            params![
                                prepared.run_id,
                                prepared.run_open_reply_json,
                                prepared.workspace_binding_digest,
                                prepared.bootstrap_digest,
                                input.activated_at,
                                stored.id,
                            ],
                        )
                        .map_err(|error| {
                            database_error("host_kernel_bootstrap_activation_failed", error)
                        })?;
                    let active = stored_run_by_id(transaction, stored.id)?.ok_or_else(|| {
                        HostV2StorageError::io(
                            "host_kernel_bootstrap_activation_lost",
                            "Activated Host Kernel Run disappeared before commit",
                        )
                    })?;
                    Ok(HostKernelBootstrapReceiptV2 {
                        record: decode_bootstrap_record(&active)?,
                    })
                }
                HostKernelStoredRunLifecycleV2::Active => {
                    if stored.bootstrap_digest.as_deref()
                        == Some(prepared.bootstrap_digest.as_str())
                    {
                        return Ok(HostKernelBootstrapReceiptV2 {
                            record: decode_bootstrap_record(&stored)?,
                        });
                    }
                    Err(HostV2StorageError::conflict(
                        "host_kernel_bootstrap_activation_conflict",
                        "Host Kernel Run is already Active with another bootstrap",
                    ))
                }
                HostKernelStoredRunLifecycleV2::Retired => Err(HostV2StorageError::conflict(
                    "host_kernel_bootstrap_activation_stale",
                    "Retired Host Kernel Run cannot be reactivated",
                )),
            }
        })
    }

    pub(crate) fn get_bootstrap(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<HostKernelBootstrapRecordV2, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        self.with_connection(|connection| {
            let stored = stored_run_by_session_host(connection, session_id, host_run_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_kernel_bootstrap_not_found",
                        "Host Kernel Run bootstrap was not found",
                    )
                })?;
            decode_bootstrap_record(&stored)
        })
    }

    pub(crate) fn live_run_has_supported_history_schema(
        &self,
        session_id: &str,
        route_run_id: &str,
    ) -> Result<bool, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(route_run_id, "routeRunId", 512)?;
        self.with_connection(|connection| {
            let Some(stored) = stored_live_run_for_session(connection, session_id)? else {
                return Ok(false);
            };
            if stored.host_run_id != route_run_id && stored.run_id.as_deref() != Some(route_run_id)
            {
                return Ok(false);
            }
            let session_bootstrap_value: Value =
                serde_json::from_str(&stored.initial_input_json)
                    .map_err(|_| corrupt("Host Kernel Session bootstrap JSON is corrupt"))?;
            require_supported_prior_events_schema(&session_bootstrap_value)?;
            Ok(true)
        })
    }

    pub(crate) fn session_has_live_run(
        &self,
        session_id: &str,
    ) -> Result<bool, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        self.with_connection(|connection| {
            Ok(stored_live_run_for_session(connection, session_id)?.is_some())
        })
    }

    pub(crate) fn live_run_for_deletion(
        &self,
        session_id: &str,
    ) -> Result<Option<HostKernelLiveRunForDeletionV2>, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        self.with_connection(|connection| {
            let Some(stored) = stored_live_run_for_session(connection, session_id)? else {
                return Ok(None);
            };
            match parse_run_lifecycle(&stored.lifecycle)? {
                HostKernelStoredRunLifecycleV2::Opening => decode_opening_record(&stored)
                    .map(HostKernelLiveRunForDeletionV2::Opening)
                    .map(Some),
                HostKernelStoredRunLifecycleV2::Active => decode_bootstrap_record(&stored)
                    .map(HostKernelLiveRunForDeletionV2::Active)
                    .map(Some),
                HostKernelStoredRunLifecycleV2::Retired => {
                    Err(corrupt("Live Host Kernel Run query returned a retired Run"))
                }
            }
        })
    }

    pub(crate) fn abandon_opening(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_open_request_id: &str,
        opening_digest: &str,
        retired_at: &str,
    ) -> Result<bool, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        for (field, value) in [
            ("hostRunId", host_run_id),
            ("runOpenRequestId", run_open_request_id),
            ("retiredAt", retired_at),
        ] {
            validate_bounded_identity(value, field, 1024)?;
        }
        validate_sha256_digest(opening_digest, "openingDigest")?;
        self.with_write_transaction(|transaction| {
            let stored =
                stored_run_exact(transaction, session_id, host_run_id, run_open_request_id)?
                    .ok_or_else(|| {
                        HostV2StorageError::not_found(
                            "host_kernel_run_opening_not_found",
                            "Exact Opening Host Kernel Run was not found",
                        )
                    })?;
            if stored.opening_digest != opening_digest {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_run_opening_digest_conflict",
                    "Opening digest does not match the durable Host Kernel Run",
                ));
            }
            match parse_run_lifecycle(&stored.lifecycle)? {
                HostKernelStoredRunLifecycleV2::Opening => {
                    transaction
                        .execute(
                            "UPDATE host_kernel_runs
                             SET lifecycle = 'Retired', retired_at = ?1,
                                 workspace_canonical_root = NULL
                             WHERE id = ?2 AND lifecycle = 'Opening'",
                            params![retired_at, stored.id],
                        )
                        .map_err(|error| {
                            database_error("host_kernel_run_opening_abandon_failed", error)
                        })?;
                    Ok(false)
                }
                HostKernelStoredRunLifecycleV2::Retired if stored.run_id.is_none() => Ok(true),
                HostKernelStoredRunLifecycleV2::Retired => Err(HostV2StorageError::conflict(
                    "host_kernel_run_opening_was_active",
                    "Retired activated Run cannot be replayed as an abandoned Opening",
                )),
                HostKernelStoredRunLifecycleV2::Active => Err(HostV2StorageError::conflict(
                    "host_kernel_run_opening_already_active",
                    "Active Host Kernel Run must use exact active retirement",
                )),
            }
        })
    }

    pub(crate) fn retire_active(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        bootstrap_digest: &str,
        retired_at: &str,
    ) -> Result<bool, HostV2StorageError> {
        self.retire_active_with_caller_correlation(
            session_id,
            host_run_id,
            run_id,
            bootstrap_digest,
            retired_at,
            None,
            false,
        )
    }

    pub(crate) fn retire_active_after_superseded_drive(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        bootstrap_digest: &str,
        retired_at: &str,
    ) -> Result<bool, HostV2StorageError> {
        self.retire_active_with_caller_correlation(
            session_id,
            host_run_id,
            run_id,
            bootstrap_digest,
            retired_at,
            None,
            true,
        )
    }

    pub(crate) fn retire_active_for_caller(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        bootstrap_digest: &str,
        retired_at: &str,
        caller_request_id: &str,
        request_digest: &str,
    ) -> Result<bool, HostV2StorageError> {
        validate_bounded_identity(caller_request_id, "retirementCallerRequestId", 512)?;
        validate_sha256_digest(request_digest, "retirementRequestDigest")?;
        self.retire_active_with_caller_correlation(
            session_id,
            host_run_id,
            run_id,
            bootstrap_digest,
            retired_at,
            Some((caller_request_id, request_digest)),
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn retire_active_for_caller_after_superseded_drive(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        bootstrap_digest: &str,
        retired_at: &str,
        caller_request_id: &str,
        request_digest: &str,
    ) -> Result<bool, HostV2StorageError> {
        validate_bounded_identity(caller_request_id, "retirementCallerRequestId", 512)?;
        validate_sha256_digest(request_digest, "retirementRequestDigest")?;
        self.retire_active_with_caller_correlation(
            session_id,
            host_run_id,
            run_id,
            bootstrap_digest,
            retired_at,
            Some((caller_request_id, request_digest)),
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn retire_active_with_caller_correlation(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        bootstrap_digest: &str,
        retired_at: &str,
        caller_correlation: Option<(&str, &str)>,
        clear_superseded_drive: bool,
    ) -> Result<bool, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        for (field, value) in [
            ("hostRunId", host_run_id),
            ("runId", run_id),
            ("retiredAt", retired_at),
        ] {
            validate_bounded_identity(value, field, 1024)?;
        }
        validate_sha256_digest(bootstrap_digest, "bootstrapDigest")?;
        self.with_write_transaction(|transaction| {
            let stored = stored_run_by_session_host(transaction, session_id, host_run_id)?
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_kernel_bootstrap_not_found",
                        "Host Kernel Run bootstrap was not found",
                    )
                })?;
            if stored.run_id.as_deref() != Some(run_id)
                || stored.bootstrap_digest.as_deref() != Some(bootstrap_digest)
            {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_run_retirement_identity_conflict",
                    "Run retirement does not match the exact active bootstrap",
                ));
            }
            match parse_run_lifecycle(&stored.lifecycle)? {
                HostKernelStoredRunLifecycleV2::Active => {
                    let (caller_request_id, request_digest) = caller_correlation
                        .map(|(caller_request_id, request_digest)| {
                            (Some(caller_request_id), Some(request_digest))
                        })
                        .unwrap_or((None, None));
                    let retirement_sql = if clear_superseded_drive {
                        "UPDATE host_kernel_runs
                         SET lifecycle = 'Retired', retired_at = ?1,
                             retirement_caller_request_id = ?2,
                             retirement_request_digest = ?3,
                             workspace_canonical_root = NULL,
                             drive_caller_request_id = NULL,
                             drive_request_digest = NULL
                         WHERE id = ?4 AND lifecycle = 'Active'"
                    } else {
                        "UPDATE host_kernel_runs
                         SET lifecycle = 'Retired', retired_at = ?1,
                             retirement_caller_request_id = ?2,
                             retirement_request_digest = ?3,
                             workspace_canonical_root = NULL
                         WHERE id = ?4 AND lifecycle = 'Active'"
                    };
                    transaction
                        .execute(
                            retirement_sql,
                            params![retired_at, caller_request_id, request_digest, stored.id],
                        )
                        .map_err(|error| {
                            database_error("host_kernel_run_retirement_failed", error)
                        })?;
                    Ok(false)
                }
                HostKernelStoredRunLifecycleV2::Retired => {
                    if stored.retirement_caller_request_id.as_deref()
                        == caller_correlation.map(|(caller_request_id, _)| caller_request_id)
                        && stored.retirement_request_digest.as_deref()
                            == caller_correlation.map(|(_, request_digest)| request_digest)
                    {
                        Ok(true)
                    } else {
                        Err(HostV2StorageError::conflict(
                            "host_kernel_run_retirement_caller_conflict",
                            "Retired Host Kernel Run has a different caller causation",
                        ))
                    }
                }
                HostKernelStoredRunLifecycleV2::Opening => Err(HostV2StorageError::conflict(
                    "host_kernel_run_retirement_not_active",
                    "Opening Host Kernel Run has no active bootstrap to retire",
                )),
            }
        })
    }

    pub(crate) fn prepare_operation(
        &self,
        input: HostKernelOperationPreparedV2,
    ) -> Result<HostKernelPreparedOperationReceiptV2, HostV2StorageError> {
        let prepared = PreparedOperationV2::new(input)?;
        self.with_write_transaction(|transaction| {
            let run = require_active_run(
                transaction,
                &prepared.session_id,
                &prepared.host_run_id,
                &prepared.run_id,
                &prepared.bootstrap_digest,
            )?;
            let bootstrap = decode_bootstrap_record(&run)?;
            validate_frame_against_bootstrap(&prepared.production_frame, &bootstrap)?;
            if run.provider_revision_digest != prepared.provider_profile_revision_digest {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_operation_provider_revision_conflict",
                    "Operation provider revision does not match the immutable bootstrap",
                ));
            }
            let caller_correlation =
                prepared_operation_caller_correlation(transaction, &run, &prepared)?;
            if let Some(existing) =
                stored_operation_by_request(transaction, &prepared.operation_request_id)?
            {
                if existing.run_row_id == run.id
                    && existing.production_frame_digest == prepared.production_frame_digest
                    && existing.run_id == prepared.run_id
                    && existing.bootstrap_digest == prepared.bootstrap_digest
                    && existing.provider_revision_digest
                        == prepared.provider_profile_revision_digest
                    && existing.caller_request_id
                        == caller_correlation
                            .as_ref()
                            .map(|correlation| correlation.0.clone())
                    && existing.caller_request_digest
                        == caller_correlation
                            .as_ref()
                            .map(|correlation| correlation.1.clone())
                {
                    validate_stored_operation(&existing)?;
                    decode_stored_production_frame(&existing)?;
                    return Ok(HostKernelPreparedOperationReceiptV2);
                }
                return Err(HostV2StorageError::conflict(
                    "host_kernel_operation_request_conflict",
                    "Operation request identity is permanently bound to different content",
                ));
            }
            reserve_row(transaction, "operation_rows", MAX_OPERATION_ROWS)?;
            let next_sequence = run.next_operation_sequence.checked_add(1).ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_kernel_operation_sequence_exhausted",
                    "Host Kernel operation sequence is exhausted",
                )
            })?;
            transaction
                .execute(
                    "UPDATE host_kernel_runs
                     SET next_operation_sequence = ?1
                     WHERE id = ?2 AND lifecycle = 'Active'",
                    params![next_sequence, run.id],
                )
                .map_err(|error| {
                    database_error("host_kernel_operation_sequence_write_failed", error)
                })?;
            transaction
                .execute(
                    "INSERT INTO host_kernel_operations (
                        schema_version, run_row_id, operation_sequence,
                        operation_request_id, caller_request_id, caller_request_digest,
                        run_id, bootstrap_digest,
                        provider_revision_digest, production_frame_json,
                        production_frame_digest, recorded_at
                     ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
                     )",
                    params![
                        OPERATION_ROW_SCHEMA_V2,
                        run.id,
                        next_sequence,
                        prepared.operation_request_id,
                        caller_correlation
                            .as_ref()
                            .map(|correlation| correlation.0.as_str()),
                        caller_correlation
                            .as_ref()
                            .map(|correlation| correlation.1.as_str()),
                        prepared.run_id,
                        prepared.bootstrap_digest,
                        prepared.provider_profile_revision_digest,
                        prepared.production_frame_json,
                        prepared.production_frame_digest,
                        prepared.recorded_at,
                    ],
                )
                .map_err(|error| database_error("host_kernel_operation_prepare_failed", error))?;
            positive_u64(next_sequence, "operationSequence")?;
            Ok(HostKernelPreparedOperationReceiptV2)
        })
    }

    pub(crate) fn prepared_operation(
        &self,
        input: HostKernelOperationPreparedV2,
    ) -> Result<Option<HostKernelPreparedOperationReceiptV2>, HostV2StorageError> {
        let prepared = PreparedOperationV2::new(input)?;
        self.with_connection(|connection| {
            let run = require_active_run(
                connection,
                &prepared.session_id,
                &prepared.host_run_id,
                &prepared.run_id,
                &prepared.bootstrap_digest,
            )?;
            let bootstrap = decode_bootstrap_record(&run)?;
            validate_frame_against_bootstrap(&prepared.production_frame, &bootstrap)?;
            if run.provider_revision_digest != prepared.provider_profile_revision_digest {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_operation_provider_revision_conflict",
                    "Operation provider revision does not match the immutable bootstrap",
                ));
            }
            let caller_correlation =
                prepared_operation_caller_correlation(connection, &run, &prepared)?;
            let Some(existing) =
                stored_operation_by_request(connection, &prepared.operation_request_id)?
            else {
                return Ok(None);
            };
            if existing.run_row_id != run.id
                || existing.production_frame_digest != prepared.production_frame_digest
                || existing.run_id != prepared.run_id
                || existing.bootstrap_digest != prepared.bootstrap_digest
                || existing.provider_revision_digest != prepared.provider_profile_revision_digest
                || existing.caller_request_id
                    != caller_correlation
                        .as_ref()
                        .map(|correlation| correlation.0.clone())
                || existing.caller_request_digest
                    != caller_correlation
                        .as_ref()
                        .map(|correlation| correlation.1.clone())
            {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_operation_request_conflict",
                    "Operation request identity is permanently bound to different content",
                ));
            }
            validate_stored_operation(&existing)?;
            decode_stored_production_frame(&existing)?;
            Ok(Some(HostKernelPreparedOperationReceiptV2))
        })
    }

    /// Issues an opaque attempt identity whose prefix is bound to the Host
    /// owner instance. It is an identity, not an authorization capability.
    pub(crate) fn issue_dispatch_attempt_id(
        &self,
        owner_instance_id: &str,
    ) -> Result<String, HostV2StorageError> {
        validate_bounded_identity(owner_instance_id, "ownerInstanceId", 512)?;
        let owner_component = sha256_path_component(owner_instance_id);
        let nonce = ATTEMPT_NONCE_V2.fetch_add(1, Ordering::Relaxed);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_kernel_attempt_clock_invalid",
                    "System clock cannot issue a dispatch attempt identity",
                )
            })?
            .as_nanos();
        let material = format!(
            "{owner_instance_id}:{}:{now}:{nonce}:{}",
            std::process::id(),
            self.database_path().display()
        );
        let opaque = sha256_path_component(&material);
        Ok(format!(
            "host_attempt_v2_{}_{}",
            &owner_component[..16],
            opaque
        ))
    }

    pub(crate) fn prepare_dispatch(
        &self,
        input: HostKernelDispatchPrepareV2,
    ) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
        validate_dispatch_prepare(&input)?;
        self.with_write_transaction(|transaction| {
            let operation = require_pending_operation(transaction, &input.operation, true)?;
            if let Some(existing) =
                stored_attempt_by_id(transaction, &input.attempt_id)?
            {
                return replay_exact_attempt(
                    existing,
                    &operation,
                    &input.owner_instance_id,
                    None,
                    &input.prepared_at,
                );
            }
            if let Some(latest) = latest_attempt(transaction, operation.id)? {
                return match parse_attempt_state(&latest.state)? {
                    HostKernelDispatchAttemptStateV2::Lost => {
                        Err(HostV2StorageError::conflict(
                            "host_kernel_dispatch_recovery_required",
                            "Operation has a proven pre-write Lost attempt; a new attempt requires the explicit recovery API",
                        ))
                    }
                    HostKernelDispatchAttemptStateV2::Indeterminate => {
                        Err(HostV2StorageError::conflict(
                            "host_kernel_dispatch_indeterminate_manual_reconciliation_required",
                            "Operation has an Indeterminate attempt and cannot be dispatched again without explicit fact reconciliation",
                        ))
                    }
                    _ => Err(HostV2StorageError::conflict(
                        "host_kernel_dispatch_attempt_already_exists",
                        "Operation already has a dispatch attempt",
                    )),
                };
            }
            insert_attempt(
                transaction,
                &operation,
                &input.attempt_id,
                &input.owner_instance_id,
                None,
                &input.prepared_at,
            )
        })
    }

    pub(crate) fn prepare_recovery_dispatch(
        &self,
        input: HostKernelDispatchRecoveryV2,
    ) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
        validate_dispatch_recovery(&input)?;
        self.with_write_transaction(|transaction| {
            let operation = require_pending_operation(transaction, &input.operation, true)?;
            if let Some(existing) = stored_attempt_by_id(transaction, &input.attempt_id)? {
                let previous =
                    stored_attempt_by_id(transaction, &input.previous_attempt_id)?.ok_or_else(
                        || {
                            HostV2StorageError::conflict(
                                "host_kernel_dispatch_recovery_predecessor_missing",
                                "Dispatch recovery predecessor is missing",
                            )
                        },
                    )?;
                if previous.operation_row_id != operation.id
                    || parse_attempt_state(&previous.state)?
                        != HostKernelDispatchAttemptStateV2::Lost
                {
                    return Err(HostV2StorageError::conflict(
                        "host_kernel_dispatch_recovery_not_allowed",
                        "Dispatch recovery replay is valid only when its exact predecessor is a Lost attempt",
                    ));
                }
                return replay_exact_attempt(
                    existing,
                    &operation,
                    &input.owner_instance_id,
                    Some(&input.previous_attempt_id),
                    &input.prepared_at,
                );
            }
            let latest = latest_attempt(transaction, operation.id)?.ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_kernel_dispatch_recovery_without_attempt",
                    "Dispatch recovery requires an existing Lost attempt",
                )
            })?;
            if latest.attempt_id != input.previous_attempt_id
                || parse_attempt_state(&latest.state)?
                    != HostKernelDispatchAttemptStateV2::Lost
            {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_dispatch_recovery_not_allowed",
                    "Only the latest Lost attempt can be recovered; Indeterminate attempts require explicit fact reconciliation",
                ));
            }
            insert_attempt(
                transaction,
                &operation,
                &input.attempt_id,
                &input.owner_instance_id,
                Some(&input.previous_attempt_id),
                &input.prepared_at,
            )
        })
    }

    pub(crate) fn prepare_response_retry_dispatch(
        &self,
        input: HostKernelDispatchRecoveryV2,
        retry_settlement: &HostKernelOperationSettlementV2,
    ) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
        validate_dispatch_recovery(&input)?;
        validate_settlement(retry_settlement)?;
        if !matches!(
            retry_settlement,
            HostKernelOperationSettlementV2::FailedRecoverable {
                boundary: HostKernelOperationFailureBoundaryV2 {
                    disposition: HostKernelFailureDispositionV2::RetrySameRequest,
                    ..
                },
                ..
            }
        ) {
            return Err(HostV2StorageError::invalid(
                "host_kernel_dispatch_retry_boundary_invalid",
                "Only an exact retrySameRequest response may create a response-bound retry attempt",
            ));
        }
        self.with_write_transaction(|transaction| {
            let operation = require_pending_operation(transaction, &input.operation, true)?;
            let previous = stored_attempt_by_id(transaction, &input.previous_attempt_id)?
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_kernel_dispatch_retry_predecessor_missing",
                        "Response-bound retry predecessor is missing",
                    )
                })?;
            if previous.operation_row_id != operation.id
                || parse_attempt_state(&previous.state)?
                    != HostKernelDispatchAttemptStateV2::ResponseObserved
            {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_dispatch_retry_not_allowed",
                    "Response-bound retry requires the exact ResponseObserved predecessor",
                ));
            }
            validate_failure_settlement_matches_observed_response(&previous, retry_settlement)?;
            let latest = latest_attempt(transaction, operation.id)?.ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_kernel_dispatch_retry_predecessor_missing",
                    "Response-bound retry has no latest predecessor",
                )
            })?;
            if let Some(existing) = stored_attempt_by_id(transaction, &input.attempt_id)? {
                if latest.attempt_id != existing.attempt_id {
                    return Err(HostV2StorageError::conflict(
                        "host_kernel_dispatch_retry_not_latest",
                        "Response-bound retry replay is not the latest operation attempt",
                    ));
                }
                return replay_exact_attempt(
                    existing,
                    &operation,
                    &input.owner_instance_id,
                    Some(&input.previous_attempt_id),
                    &input.prepared_at,
                );
            }
            if latest.attempt_id != input.previous_attempt_id {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_dispatch_retry_not_latest",
                    "Only the latest observed retry response may create a new attempt",
                ));
            }
            insert_attempt(
                transaction,
                &operation,
                &input.attempt_id,
                &input.owner_instance_id,
                Some(&input.previous_attempt_id),
                &input.prepared_at,
            )
        })
    }

    pub(crate) fn mark_dispatch_committed(
        &self,
        operation: &HostKernelOperationRefV2,
        attempt_id: &str,
        owner_instance_id: &str,
        committed_at: &str,
    ) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
        validate_attempt_transition(operation, attempt_id, owner_instance_id, committed_at)?;
        self.with_write_transaction(|transaction| {
            let stored_operation = require_pending_operation(transaction, operation, true)?;
            let attempt = require_owned_attempt(
                transaction,
                stored_operation.id,
                attempt_id,
                owner_instance_id,
            )?;
            match parse_attempt_state(&attempt.state)? {
                HostKernelDispatchAttemptStateV2::Prepared => {
                    update_attempt_state(transaction, attempt.id, "Committed", committed_at, None)?;
                    attempt_receipt(
                        &stored_operation,
                        stored_attempt_by_id(transaction, attempt_id)?.ok_or_else(|| {
                            HostV2StorageError::io(
                                "host_kernel_dispatch_attempt_lost",
                                "Committed dispatch attempt disappeared before commit",
                            )
                        })?,
                    )
                }
                HostKernelDispatchAttemptStateV2::Committed
                | HostKernelDispatchAttemptStateV2::ResponseObserved
                | HostKernelDispatchAttemptStateV2::Settled => {
                    attempt_receipt(&stored_operation, attempt)
                }
                HostKernelDispatchAttemptStateV2::Indeterminate
                | HostKernelDispatchAttemptStateV2::Lost => Err(HostV2StorageError::conflict(
                    "host_kernel_dispatch_commit_stale",
                    "Lost or Indeterminate dispatch cannot be promoted to Committed",
                )),
            }
        })
    }

    pub(crate) fn mark_dispatch_lost(
        &self,
        operation: &HostKernelOperationRefV2,
        attempt_id: &str,
        owner_instance_id: &str,
        lost_at: &str,
        reason_code: &str,
    ) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
        validate_attempt_transition(operation, attempt_id, owner_instance_id, lost_at)?;
        validate_bounded_identity(reason_code, "reasonCode", 512)?;
        self.with_write_transaction(|transaction| {
            let stored_operation = require_pending_operation(transaction, operation, true)?;
            let attempt = require_owned_attempt(
                transaction,
                stored_operation.id,
                attempt_id,
                owner_instance_id,
            )?;
            match parse_attempt_state(&attempt.state)? {
                HostKernelDispatchAttemptStateV2::Prepared => {
                    update_attempt_state(
                        transaction,
                        attempt.id,
                        "Lost",
                        lost_at,
                        Some(reason_code),
                    )?;
                    attempt_receipt(
                        &stored_operation,
                        stored_attempt_by_id(transaction, attempt_id)?.ok_or_else(|| {
                            HostV2StorageError::io(
                                "host_kernel_dispatch_attempt_lost",
                                "Lost dispatch attempt disappeared before commit",
                            )
                        })?,
                    )
                }
                HostKernelDispatchAttemptStateV2::Lost
                    if attempt.state_reason_code.as_deref() == Some(reason_code) =>
                {
                    attempt_receipt(&stored_operation, attempt)
                }
                _ => Err(HostV2StorageError::conflict(
                    "host_kernel_dispatch_lost_transition_invalid",
                    "Only a definitive prewrite Prepared attempt can become Lost",
                )),
            }
        })
    }

    pub(crate) fn mark_dispatch_indeterminate(
        &self,
        operation: &HostKernelOperationRefV2,
        attempt_id: &str,
        owner_instance_id: &str,
        observed_at: &str,
        reason_code: &str,
    ) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
        validate_attempt_transition(operation, attempt_id, owner_instance_id, observed_at)?;
        validate_bounded_identity(reason_code, "reasonCode", 512)?;
        self.with_write_transaction(|transaction| {
            let stored_operation = require_pending_operation(transaction, operation, true)?;
            let attempt = require_owned_attempt(
                transaction,
                stored_operation.id,
                attempt_id,
                owner_instance_id,
            )?;
            match parse_attempt_state(&attempt.state)? {
                HostKernelDispatchAttemptStateV2::Prepared
                | HostKernelDispatchAttemptStateV2::Committed => {
                    update_attempt_state(
                        transaction,
                        attempt.id,
                        "Indeterminate",
                        observed_at,
                        Some(reason_code),
                    )?;
                    attempt_receipt(
                        &stored_operation,
                        stored_attempt_by_id(transaction, attempt_id)?.ok_or_else(|| {
                            HostV2StorageError::io(
                                "host_kernel_dispatch_attempt_lost",
                                "Indeterminate dispatch attempt disappeared before commit",
                            )
                        })?,
                    )
                }
                HostKernelDispatchAttemptStateV2::Indeterminate
                    if attempt.state_reason_code.as_deref() == Some(reason_code) =>
                {
                    attempt_receipt(&stored_operation, attempt)
                }
                _ => Err(HostV2StorageError::conflict(
                    "host_kernel_dispatch_indeterminate_transition_invalid",
                    "Observed response, Lost, or Settled attempt cannot become Indeterminate",
                )),
            }
        })
    }

    pub(crate) fn observe_response(
        &self,
        operation: &HostKernelOperationRefV2,
        attempt_id: &str,
        owner_instance_id: &str,
        response: Value,
        observed_at: &str,
    ) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
        validate_attempt_transition(operation, attempt_id, owner_instance_id, observed_at)?;
        validate_persisted_response(&response)?;
        let response_json = canonical_json_string(&response)?;
        let response_digest = canonical_sha256(&response)?;
        self.with_write_transaction(|transaction| {
            let stored_operation = require_pending_operation(transaction, operation, true)?;
            let attempt = require_owned_attempt(
                transaction,
                stored_operation.id,
                attempt_id,
                owner_instance_id,
            )?;
            match parse_attempt_state(&attempt.state)? {
                HostKernelDispatchAttemptStateV2::Committed
                | HostKernelDispatchAttemptStateV2::Indeterminate => {
                    transaction
                        .execute(
                            "UPDATE host_kernel_dispatch_attempts
                             SET state = 'ResponseObserved', state_recorded_at = ?1,
                                 state_reason_code = NULL, response_json = ?2,
                                 response_digest = ?3, response_observed_at = ?1
                             WHERE id = ?4",
                            params![observed_at, response_json, response_digest, attempt.id],
                        )
                        .map_err(|error| {
                            database_error("host_kernel_response_observation_failed", error)
                        })?;
                    attempt_receipt(
                        &stored_operation,
                        stored_attempt_by_id(transaction, attempt_id)?.ok_or_else(|| {
                            HostV2StorageError::io(
                                "host_kernel_dispatch_attempt_lost",
                                "Response-observed attempt disappeared before commit",
                            )
                        })?,
                    )
                }
                HostKernelDispatchAttemptStateV2::ResponseObserved
                | HostKernelDispatchAttemptStateV2::Settled
                    if attempt.response_digest.as_deref() == Some(response_digest.as_str()) =>
                {
                    attempt_receipt(&stored_operation, attempt)
                }
                HostKernelDispatchAttemptStateV2::Prepared => Err(HostV2StorageError::conflict(
                    "host_kernel_response_before_dispatch",
                    "Response cannot be observed before dispatch is Committed",
                )),
                HostKernelDispatchAttemptStateV2::Lost => Err(HostV2StorageError::conflict(
                    "host_kernel_response_after_lost",
                    "Definitively Lost prewrite attempt cannot observe a response",
                )),
                _ => Err(HostV2StorageError::conflict(
                    "host_kernel_response_observation_conflict",
                    "Dispatch attempt already has a different response observation",
                )),
            }
        })
    }

    pub(crate) fn settle_operation(
        &self,
        operation: &HostKernelOperationRefV2,
        attempt_id: &str,
        owner_instance_id: &str,
        settlement: HostKernelOperationSettlementV2,
        settled_at: &str,
    ) -> Result<HostKernelOperationSettlementReceiptV2, HostV2StorageError> {
        validate_attempt_transition(operation, attempt_id, owner_instance_id, settled_at)?;
        validate_settlement(&settlement)?;
        if matches!(
            &settlement,
            HostKernelOperationSettlementV2::FailedRecoverable {
                boundary: HostKernelOperationFailureBoundaryV2 {
                    disposition: HostKernelFailureDispositionV2::RetrySameRequest,
                    ..
                },
                ..
            }
        ) {
            return Err(HostV2StorageError::conflict(
                "host_kernel_retry_not_terminal",
                "retrySameRequest is an observed retry directive and cannot terminally settle an operation",
            ));
        }
        let settlement_value = serde_json::to_value(&settlement).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_operation_settlement_invalid",
                format!("encode Host Kernel operation settlement: {error}"),
            )
        })?;
        let settlement_json = canonical_json_string(&settlement_value)?;
        let settlement_digest = canonical_sha256(&settlement_value)?;
        self.with_write_transaction(|transaction| {
            let stored_operation = require_operation(transaction, operation)?;
            let attempt = require_owned_attempt(
                transaction,
                stored_operation.id,
                attempt_id,
                owner_instance_id,
            )?;
            if has_nonlost_newer_attempt(
                transaction,
                stored_operation.id,
                attempt.attempt_sequence,
            )? {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_operation_newer_attempt_unresolved",
                    "Operation cannot settle while a newer recovery attempt is not definitively Lost",
                ));
            }
            if let Some(existing_digest) = &stored_operation.settlement_digest {
                if existing_digest == &settlement_digest
                    && stored_operation.settled_attempt_id.as_deref() == Some(attempt_id)
                {
                    return settlement_receipt(&stored_operation);
                }
                return Err(HostV2StorageError::conflict(
                    "host_kernel_operation_settlement_conflict",
                    "Operation already has a different terminal settlement",
                ));
            }
            match (&settlement, parse_attempt_state(&attempt.state)?) {
                (
                    HostKernelOperationSettlementV2::Succeeded { response, .. },
                    HostKernelDispatchAttemptStateV2::ResponseObserved,
                ) => {
                    let response_digest = canonical_sha256(response)?;
                    if attempt.response_digest.as_deref() != Some(response_digest.as_str()) {
                        return Err(HostV2StorageError::conflict(
                            "host_kernel_operation_success_response_conflict",
                            "Successful settlement does not match the exact observed response",
                        ));
                    }
                }
                (
                    HostKernelOperationSettlementV2::Succeeded { .. },
                    _,
                ) => {
                    return Err(HostV2StorageError::conflict(
                        "host_kernel_operation_success_before_response",
                        "Successful settlement requires a Committed dispatch and exact observed response",
                    ));
                }
                (
                    HostKernelOperationSettlementV2::FailedRecoverable { .. }
                    | HostKernelOperationSettlementV2::FailedTerminal { .. },
                    HostKernelDispatchAttemptStateV2::ResponseObserved,
                ) => validate_failure_settlement_matches_observed_response(
                    &attempt,
                    &settlement,
                )?,
                _ => {
                    return Err(HostV2StorageError::conflict(
                        "host_kernel_operation_failure_unresolved",
                        "Prepared, Committed, or Indeterminate dispatch cannot be terminally settled without observed evidence",
                    ));
                }
            }
            transaction
                .execute(
                    "UPDATE host_kernel_operations
                     SET settlement_json = ?1, settlement_digest = ?2,
                         settled_attempt_id = ?3, settled_at = ?4
                     WHERE id = ?5 AND settlement_digest IS NULL",
                    params![
                        settlement_json,
                        settlement_digest,
                        attempt_id,
                        settled_at,
                        stored_operation.id,
                    ],
                )
                .map_err(|error| {
                    database_error("host_kernel_operation_settlement_failed", error)
                })?;
            update_attempt_state(
                transaction,
                attempt.id,
                "Settled",
                settled_at,
                None,
            )?;
            let settled =
                stored_operation_by_id(transaction, stored_operation.id)?.ok_or_else(|| {
                    HostV2StorageError::io(
                        "host_kernel_operation_settlement_lost",
                        "Settled operation disappeared before commit",
                    )
                })?;
            settlement_receipt(&settled)
        })
    }

    pub(crate) fn settlement(
        &self,
        session_id: &str,
        host_run_id: &str,
        operation_request_id: &str,
    ) -> Result<Option<HostKernelOperationSettlementReceiptV2>, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        validate_operation_identity(operation_request_id)?;
        self.with_connection(|connection| {
            let Some(operation) = stored_operation_by_request(connection, operation_request_id)?
            else {
                return Ok(None);
            };
            let run = stored_run_by_id(connection, operation.run_row_id)?.ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_kernel_operation_run_missing",
                    "Operation references a missing Host Kernel Run",
                )
            })?;
            if run.session_id != session_id || run.host_run_id != host_run_id {
                return Ok(None);
            }
            validate_stored_operation(&operation)?;
            let bootstrap = decode_bootstrap_record(&run)?;
            let frame = decode_stored_production_frame(&operation)?;
            validate_frame_against_bootstrap(&frame, &bootstrap)?;
            if operation.settlement_digest.is_none() {
                return Ok(None);
            }
            Ok(Some(verified_settlement_receipt(connection, &operation)?))
        })
    }

    pub(crate) fn latest_settlement(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<Option<HostKernelOperationSettlementReceiptV2>, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        self.with_connection(|connection| {
            let Some(run) = stored_run_by_session_host(connection, session_id, host_run_id)? else {
                return Ok(None);
            };
            let operation = connection
                .query_row(
                    &format!(
                        "SELECT {} FROM host_kernel_operations
                         WHERE run_row_id = ?1 AND settlement_digest IS NOT NULL
                         ORDER BY operation_sequence DESC LIMIT 1",
                        OPERATION_COLUMNS
                    ),
                    params![run.id],
                    StoredOperationV2::from_row,
                )
                .optional()
                .map_err(|error| {
                    database_error("host_kernel_operation_latest_query_failed", error)
                })?;
            operation
                .as_ref()
                .map(|operation| verified_settlement_receipt(connection, operation))
                .transpose()
        })
    }

    pub(crate) fn settlements_for_run(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<Vec<HostKernelOperationSettlementReceiptV2>, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        self.with_connection(|connection| {
            let Some(run) = stored_run_by_session_host(connection, session_id, host_run_id)? else {
                return Ok(Vec::new());
            };
            let mut statement = connection
                .prepare(&format!(
                    "SELECT {} FROM host_kernel_operations
                     WHERE run_row_id = ?1 AND settlement_digest IS NOT NULL
                     ORDER BY operation_sequence ASC",
                    OPERATION_COLUMNS
                ))
                .map_err(|error| {
                    database_error("host_kernel_operation_list_query_failed", error)
                })?;
            let rows = statement
                .query_map(params![run.id], StoredOperationV2::from_row)
                .map_err(|error| {
                    database_error("host_kernel_operation_list_query_failed", error)
                })?;
            let mut settlements = Vec::new();
            for row in rows {
                let operation = row.map_err(|error| {
                    database_error("host_kernel_operation_list_query_failed", error)
                })?;
                settlements.push(verified_settlement_receipt(connection, &operation)?);
            }
            Ok(settlements)
        })
    }

    /// Startup reconciliation is deliberately conservative: a residual
    /// Prepared or Committed write can no longer be proven pre-effect, so it
    /// becomes Indeterminate. No operation settlement is synthesized.
    pub(crate) fn reconcile_startup(
        &self,
        reconciled_at: &str,
        recoverable_session_ids: &HashSet<String>,
        deletion_tombstone_ids: &HashSet<String>,
    ) -> Result<HostKernelStartupReconciliationV2, HostV2StorageError> {
        validate_bounded_identity(reconciled_at, "reconciledAt", 1024)?;
        self.with_write_transaction(|transaction| {
            let stored_runs = query_live_runs(transaction)?;
            let mut opening_runs = Vec::new();
            let mut active_runs = Vec::new();
            let mut unsupported_history_runs = Vec::new();
            let mut unsupported_run_row_ids = Vec::new();
            let mut supported_run_row_ids = Vec::new();
            for stored in &stored_runs {
                let recoverable = recoverable_session_ids.contains(&stored.session_id);
                let deletion_tombstone = deletion_tombstone_ids.contains(&stored.session_id);
                if !recoverable && !deletion_tombstone {
                    unsupported_run_row_ids.push(stored.id);
                    unsupported_history_runs
                        .push((stored.session_id.clone(), stored.host_run_id.clone()));
                    continue;
                }
                let decoded = match parse_run_lifecycle(&stored.lifecycle)? {
                    HostKernelStoredRunLifecycleV2::Opening => {
                        decode_opening_record(stored).map(|record| (Some(record), None))
                    }
                    HostKernelStoredRunLifecycleV2::Active => {
                        decode_bootstrap_record(stored).map(|record| (None, Some(record)))
                    }
                    HostKernelStoredRunLifecycleV2::Retired => continue,
                };
                match decoded {
                    Ok((Some(opening), None)) => {
                        if recoverable {
                            supported_run_row_ids.push(stored.id);
                        }
                        opening_runs.push(opening);
                    }
                    Ok((None, Some(active))) => {
                        if recoverable {
                            supported_run_row_ids.push(stored.id);
                        }
                        active_runs.push(active);
                    }
                    Ok(_) => {
                        return Err(corrupt(
                            "Host Kernel startup reconciliation decoded an invalid Run state",
                        ))
                    }
                    Err(error) if error.code == "unsupported_history_schema" => {
                        unsupported_run_row_ids.push(stored.id);
                        unsupported_history_runs
                            .push((stored.session_id.clone(), stored.host_run_id.clone()));
                    }
                    Err(error) => return Err(error),
                }
            }
            let mut marked = 0usize;
            for run_row_id in supported_run_row_ids {
                marked = marked.saturating_add(
                    transaction
                        .execute(
                            "UPDATE host_kernel_dispatch_attempts
                             SET state = 'Indeterminate', state_recorded_at = ?1,
                                 state_reason_code = 'host_restart_write_outcome_unknown'
                             WHERE state IN ('Prepared', 'Committed')
                               AND operation_row_id IN (
                                   SELECT id FROM host_kernel_operations
                                   WHERE run_row_id = ?2
                               )",
                            params![reconciled_at, run_row_id],
                        )
                        .map_err(|error| {
                            database_error("host_kernel_startup_reconciliation_failed", error)
                        })?,
                );
            }
            let cancel_recoveries = query_startup_cancel_recoveries(transaction, &active_runs)?;
            let cancel_run_keys = cancel_recoveries
                .iter()
                .map(|recovery| {
                    (
                        recovery.bootstrap.session_id.clone(),
                        recovery.bootstrap.host_run_id.clone(),
                    )
                })
                .collect::<HashSet<_>>();
            active_runs.retain(|bootstrap| {
                !cancel_run_keys
                    .contains(&(bootstrap.session_id.clone(), bootstrap.host_run_id.clone()))
            });
            let mut pending_operations = Vec::new();
            for stored in &stored_runs {
                if unsupported_run_row_ids.contains(&stored.id) {
                    continue;
                }
                if parse_run_lifecycle(&stored.lifecycle)? == HostKernelStoredRunLifecycleV2::Active
                    && !cancel_run_keys
                        .contains(&(stored.session_id.clone(), stored.host_run_id.clone()))
                {
                    pending_operations.extend(query_pending_operations_for_run(
                        transaction,
                        stored,
                        0,
                        MAX_OPERATION_ROWS as usize,
                    )?);
                }
            }
            pending_operations.sort_by(|left, right| {
                left.session_id
                    .cmp(&right.session_id)
                    .then_with(|| left.operation_sequence.cmp(&right.operation_sequence))
            });
            Ok(HostKernelStartupReconciliationV2 {
                opening_runs,
                active_runs,
                pending_operations,
                cancel_recoveries,
                unsupported_history_runs,
                attempts_marked_indeterminate: marked,
            })
        })
    }

    fn database_path(&self) -> PathBuf {
        self.sessions_dir
            .join(".host-v3")
            .join("host-kernel-v3.sqlite3")
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, HostV2StorageError>,
    ) -> Result<T, HostV2StorageError> {
        let connection = self.open_connection()?;
        let result = operation(&connection);
        secure_sqlite_files(&self.database_path())?;
        result
    }

    fn with_write_transaction<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T, HostV2StorageError>,
    ) -> Result<T, HostV2StorageError> {
        let mut connection = self.open_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| database_error("host_kernel_store_transaction_failed", error))?;
        let result = operation(&transaction);
        match result {
            Ok(value) => {
                transaction
                    .commit()
                    .map_err(|error| database_error("host_kernel_store_commit_failed", error))?;
                secure_sqlite_files(&self.database_path())?;
                Ok(value)
            }
            Err(error) => {
                drop(transaction);
                secure_sqlite_files(&self.database_path())?;
                Err(error)
            }
        }
    }

    fn open_connection(&self) -> Result<Connection, HostV2StorageError> {
        let directory = self.sessions_dir.join(".host-v3");
        create_private_store_directory(&directory)?;
        let path = self.database_path();
        create_private_sqlite_file_if_missing(&path)?;
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| database_error("host_kernel_store_open_failed", error))?;
        connection
            .busy_timeout(SQLITE_BUSY_TIMEOUT)
            .map_err(|error| database_error("host_kernel_store_busy_timeout_failed", error))?;
        initialize_or_validate_schema(&mut connection)?;
        configure_connection(&connection)?;
        secure_sqlite_files(&path)?;
        Ok(connection)
    }
}

fn canonical_cancel_settlement_matches_binding(
    evidence: &HostCallerRequestRecoveryEvidenceV2,
) -> Result<bool, HostV2StorageError> {
    let identity = &evidence.binding.response_identity;
    let operation_request_id = identity
        .get("operationRequestId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_caller_request_operation_identity_missing",
                "Run cancellation success requires an exact operation identity",
            )
        })?;
    let cancel_operation_id = identity
        .get("cancelOperationId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_caller_request_cancel_operation_identity_missing",
                "Run cancellation success requires an exact cancel operation identity",
            )
        })?;
    let Some(settlement) = evidence.first_settlement.as_ref() else {
        return Ok(false);
    };
    if operation_request_id != cancel_operation_id
        || settlement.operation_request_id != operation_request_id
    {
        return Ok(false);
    }
    let HostKernelOperationSettlementV2::Succeeded {
        response,
        continuation,
    } = &settlement.settlement
    else {
        return Ok(false);
    };
    let outcome = response.get("outcome");
    let facts = outcome.and_then(|value| value.get("facts"));
    let projection = outcome.and_then(|value| value.get("projection"));
    Ok(
        continuation.get("kind").and_then(Value::as_str) == Some("terminalRunCancelled")
            && response.get("operationKind").and_then(Value::as_str) == Some("cancelRun")
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
                == Some(cancel_operation_id)
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

struct PreparedOpeningV2 {
    session_id: String,
    host_run_id: String,
    drive_caller_request_id: String,
    drive_request_digest: String,
    run_open_request_id: String,
    run_open_envelope_json: String,
    run_open_envelope_digest: String,
    workspace_binding_ref: String,
    workspace_binding_identity: String,
    workspace_canonical_root: String,
    workspace_kind: HostRunWorkspaceKindV2,
    empty_workspace_key: Option<String>,
    run_settings_json: String,
    provider_profile_id: Option<String>,
    provider_profile_revision_digest: Option<String>,
    initial_input_json: String,
    opening_recorded_at: String,
    opening_digest: String,
}

impl PreparedOpeningV2 {
    fn new(input: HostKernelRunOpeningInputV2) -> Result<Self, HostV2StorageError> {
        validate_opening_input(&input)?;
        let workspace_canonical_root =
            canonical_workspace_root_text(&input.workspace_canonical_root)?;
        let run_open_envelope_value =
            serde_json::to_value(&input.run_open_envelope).map_err(|error| {
                HostV2StorageError::invalid(
                    "host_kernel_run_open_envelope_invalid",
                    format!("encode RunOpen envelope: {error}"),
                )
            })?;
        reject_host_private_persistence_fields(&run_open_envelope_value)?;
        let run_open_envelope_json = canonical_json_string(&run_open_envelope_value)?;
        if run_open_envelope_json.len() > MAX_BOOTSTRAP_BYTES {
            return Err(HostV2StorageError::invalid(
                "host_kernel_run_open_envelope_too_large",
                "Safe RunOpen envelope exceeds the bounded bootstrap size",
            ));
        }
        let run_open_envelope_digest = canonical_sha256(&run_open_envelope_value)?;
        let run_settings_value = serde_json::to_value(&input.run_settings).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_run_settings_invalid",
                format!("encode Run Settings ceiling: {error}"),
            )
        })?;
        let run_settings_json = canonical_json_string(&run_settings_value)?;
        let session_bootstrap_material = HostKernelSessionBootstrapMaterialV2 {
            schema_version: SESSION_BOOTSTRAP_MATERIAL_SCHEMA_V2.to_string(),
            active_folder_id: input.active_folder_id.clone(),
            initial_input: input.initial_input.clone(),
            prior_session_events: input.prior_session_events.clone(),
            provider_profile: input.provider_profile.clone(),
        };
        let session_bootstrap_value =
            serde_json::to_value(&session_bootstrap_material).map_err(|error| {
                HostV2StorageError::invalid(
                    "host_kernel_session_bootstrap_invalid",
                    format!("encode Session bootstrap material: {error}"),
                )
            })?;
        reject_host_private_persistence_fields(&session_bootstrap_value)?;
        let initial_input_json = canonical_json_string(&session_bootstrap_value)?;
        let durable_opening_bytes = run_open_envelope_json
            .len()
            .checked_add(run_settings_json.len())
            .and_then(|value| value.checked_add(initial_input_json.len()))
            .and_then(|value| value.checked_add(workspace_canonical_root.len()))
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "host_kernel_run_opening_too_large",
                    "Host Kernel Opening size is not representable",
                )
            })?;
        if durable_opening_bytes > MAX_BOOTSTRAP_BYTES {
            return Err(HostV2StorageError::invalid(
                "host_kernel_run_opening_too_large",
                "Host Kernel Opening exceeds the bounded bootstrap size",
            ));
        }
        let workspace_binding_ref = match &input.run_open_envelope.command {
            KernelCommandV2::RunOpen(command) => command.workspace_binding_ref.to_string(),
            _ => unreachable!("validate_opening_input requires RunOpen"),
        };
        let opening_digest = opening_digest(
            &input,
            &workspace_binding_ref,
            &run_open_envelope_digest,
            &run_settings_value,
        )?;
        Ok(Self {
            session_id: input.session_id,
            host_run_id: input.host_run_id,
            drive_caller_request_id: input.drive_caller_request_id,
            drive_request_digest: input.drive_request_digest,
            run_open_request_id: input.run_open_request_id,
            run_open_envelope_json,
            run_open_envelope_digest,
            workspace_binding_ref,
            workspace_binding_identity: input.workspace_binding_identity,
            workspace_canonical_root,
            workspace_kind: input.workspace_kind,
            empty_workspace_key: input.empty_workspace_key,
            run_settings_json,
            provider_profile_id: Some(input.provider_profile.provider_profile_id),
            provider_profile_revision_digest: Some(
                input.provider_profile.provider_profile_revision_digest,
            ),
            initial_input_json,
            opening_recorded_at: input.opening_recorded_at,
            opening_digest,
        })
    }
}

fn opening_digest(
    input: &HostKernelRunOpeningInputV2,
    workspace_binding_ref: &str,
    run_open_envelope_digest: &str,
    run_settings_value: &Value,
) -> Result<String, HostV2StorageError> {
    canonical_sha256(&json!({
        "schemaVersion": RUN_ROW_SCHEMA_V2,
        "historySchema": HISTORY_SCHEMA_V3,
        "sessionId": input.session_id,
        "hostRunId": input.host_run_id,
        "driveCallerRequestId": input.drive_caller_request_id,
        "driveRequestDigest": input.drive_request_digest,
        "runOpenRequestId": input.run_open_request_id,
        "runOpenEnvelopeDigest": run_open_envelope_digest,
        "workspaceBindingRef": workspace_binding_ref,
        "workspaceBindingIdentity": input.workspace_binding_identity,
        "workspaceKind": workspace_kind_text(input.workspace_kind),
        "activeFolderId": input.active_folder_id,
        "emptyWorkspaceKey": input.empty_workspace_key,
        "runSettings": run_settings_value,
        "providerProfile": input.provider_profile,
        "priorSessionEvents": input.prior_session_events,
        "initialInput": input.initial_input,
        "openingRecordedAt": input.opening_recorded_at,
    }))
}

struct PreparedBootstrapV2 {
    run_id: String,
    run_open_reply_json: String,
    workspace_binding_digest: String,
    bootstrap_digest: String,
}

impl PreparedBootstrapV2 {
    fn new(
        opening: &HostKernelRunOpeningRecordV2,
        reply: &RunOpenReplyV2,
    ) -> Result<Self, HostV2StorageError> {
        reply.validate().map_err(|_| {
            HostV2StorageError::invalid(
                "host_kernel_bootstrap_run_open_reply_invalid",
                "RunOpen reply failed strict v2 validation",
            )
        })?;
        let reply_value = serde_json::to_value(reply).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_bootstrap_run_open_reply_invalid",
                format!("encode RunOpen reply: {error}"),
            )
        })?;
        reject_host_private_persistence_fields(&reply_value)?;
        let envelope_value = serde_json::to_value(&opening.run_open_envelope).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_bootstrap_run_open_envelope_invalid",
                format!("encode durable RunOpen envelope: {error}"),
            )
        })?;
        let settings_value = serde_json::to_value(&opening.run_settings).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_bootstrap_settings_invalid",
                format!("encode durable Run Settings: {error}"),
            )
        })?;
        let initial_value = serde_json::to_value(&opening.initial_input).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_bootstrap_initial_input_invalid",
                format!("encode durable initial input: {error}"),
            )
        })?;
        let reply_bytes = canonical_json_bytes(&reply_value)?.len();
        let envelope_bytes = canonical_json_bytes(&envelope_value)?.len();
        let settings_bytes = canonical_json_bytes(&settings_value)?.len();
        let initial_bytes = canonical_json_bytes(&initial_value)?.len();
        let total_bytes = reply_bytes
            .checked_add(envelope_bytes)
            .and_then(|value| value.checked_add(settings_bytes))
            .and_then(|value| value.checked_add(initial_bytes))
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "host_kernel_bootstrap_too_large",
                    "Host Kernel bootstrap size is not representable",
                )
            })?;
        if total_bytes > MAX_BOOTSTRAP_BYTES {
            return Err(HostV2StorageError::invalid(
                "host_kernel_bootstrap_too_large",
                "Safe Host Kernel bootstrap exceeds its bounded size",
            ));
        }
        let run_id = reply.run_id.to_string();
        validate_bounded_identity(&run_id, "runId", 512)?;
        let workspace_binding_digest = reply.workspace_binding_digest.as_str().to_string();
        validate_sha256_digest(&workspace_binding_digest, "workspaceBindingDigest")?;
        let run_open_reply_json = canonical_json_string(&reply_value)?;
        let bootstrap_digest = canonical_sha256(&json!({
            "schemaVersion": BOOTSTRAP_SCHEMA_V2,
            "historySchema": HISTORY_SCHEMA_V3,
            "openingDigest": opening.opening_digest,
            "runId": run_id,
            "workspaceBindingRef": opening.workspace_binding_ref,
            "workspaceBindingDigest": workspace_binding_digest,
            "activeFolderId": opening.active_folder_id,
            "runOpenReply": reply_value,
        }))?;
        Ok(Self {
            run_id,
            run_open_reply_json,
            workspace_binding_digest,
            bootstrap_digest,
        })
    }
}

struct PreparedOperationV2 {
    session_id: String,
    host_run_id: String,
    run_id: String,
    bootstrap_digest: String,
    provider_profile_revision_digest: Option<String>,
    operation_request_id: String,
    caller_correlation: Option<HostKernelOperationCallerCorrelationV2>,
    production_frame: Value,
    production_frame_json: String,
    production_frame_digest: String,
    recorded_at: String,
}

impl PreparedOperationV2 {
    fn new(input: HostKernelOperationPreparedV2) -> Result<Self, HostV2StorageError> {
        validate_safe_session_identity(&input.session_id)?;
        for (field, value, maximum) in [
            ("hostRunId", input.host_run_id.as_str(), 512),
            ("runId", input.run_id.as_str(), 512),
            (
                "operationRequestId",
                input.operation_request_id.as_str(),
                512,
            ),
            ("recordedAt", input.recorded_at.as_str(), 1024),
        ] {
            validate_bounded_identity(value, field, maximum)?;
        }
        validate_sha256_digest(&input.bootstrap_digest, "bootstrapDigest")?;
        if let Some(digest) = &input.provider_profile_revision_digest {
            validate_sha256_digest(digest, "providerProfileRevisionDigest")?;
        }
        if let Some(correlation) = &input.caller_correlation {
            validate_caller_request_identity(
                &input.session_id,
                &correlation.caller_request_id,
                &correlation.request_kind,
                &correlation.request_digest,
            )?;
        }
        validate_production_frame(&input.production_frame, &input.operation_request_id)?;
        let production_frame_json = canonical_json_string(&input.production_frame)?;
        let production_frame_digest = canonical_sha256(&input.production_frame)?;
        Ok(Self {
            session_id: input.session_id,
            host_run_id: input.host_run_id,
            run_id: input.run_id,
            bootstrap_digest: input.bootstrap_digest,
            provider_profile_revision_digest: input.provider_profile_revision_digest,
            operation_request_id: input.operation_request_id,
            caller_correlation: input.caller_correlation,
            production_frame: input.production_frame,
            production_frame_json,
            production_frame_digest,
            recorded_at: input.recorded_at,
        })
    }
}

fn prepared_operation_caller_correlation(
    connection: &Connection,
    run: &StoredRunV2,
    prepared: &PreparedOperationV2,
) -> Result<Option<(String, String)>, HostV2StorageError> {
    let Some(correlation) = &prepared.caller_correlation else {
        return match (
            run.drive_caller_request_id.clone(),
            run.drive_request_digest.clone(),
        ) {
            (None, None) => Ok(None),
            (Some(caller_request_id), Some(request_digest)) => {
                Ok(Some((caller_request_id, request_digest)))
            }
            _ => Err(corrupt(
                "Host Kernel Run contains a partial caller drive correlation",
            )),
        };
    };
    let stored = stored_caller_request(
        connection,
        &prepared.session_id,
        &correlation.caller_request_id,
    )?
    .ok_or_else(|| {
        HostV2StorageError::not_found(
            "host_caller_request_not_found",
            "Explicit operation caller correlation has no durable caller request",
        )
    })?;
    let binding = decode_caller_request_binding(
        stored,
        &correlation.request_kind,
        &correlation.request_digest,
        true,
    )?;
    if binding.drive_state != HostCallerRequestDriveStateV2::Driving || binding.outcome.is_some() {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_caller_not_driving",
            "Explicit operation caller correlation is not an unsettled driving request",
        ));
    }
    let identity = &binding.response_identity;
    if identity.get("hostRunId").and_then(Value::as_str) != Some(prepared.host_run_id.as_str())
        || identity.get("runId").and_then(Value::as_str) != Some(prepared.run_id.as_str())
        || identity.get("operationRequestId").and_then(Value::as_str)
            != Some(prepared.operation_request_id.as_str())
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_caller_identity_conflict",
            "Explicit operation caller correlation does not match the exact Run and operation",
        ));
    }
    Ok(Some((
        correlation.caller_request_id.clone(),
        correlation.request_digest.clone(),
    )))
}

struct StoredCallerRequestV2 {
    schema_version: String,
    session_id: String,
    caller_request_id: String,
    request_kind: String,
    request_digest: String,
    response_identity_json: String,
    response_identity_digest: String,
    recorded_at: String,
    drive_state: String,
    drive_owner_instance_id: Option<String>,
    drive_started_at: Option<String>,
    admission_json: Option<String>,
    admission_digest: Option<String>,
    admitted_at: Option<String>,
    outcome_json: Option<String>,
    outcome_digest: Option<String>,
    settled_at: Option<String>,
}

impl StoredCallerRequestV2 {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            schema_version: row.get("schema_version")?,
            session_id: row.get("session_id")?,
            caller_request_id: row.get("caller_request_id")?,
            request_kind: row.get("request_kind")?,
            request_digest: row.get("request_digest")?,
            response_identity_json: row.get("response_identity_json")?,
            response_identity_digest: row.get("response_identity_digest")?,
            recorded_at: row.get("recorded_at")?,
            drive_state: row.get("drive_state")?,
            drive_owner_instance_id: row.get("drive_owner_instance_id")?,
            drive_started_at: row.get("drive_started_at")?,
            admission_json: row.get("admission_json")?,
            admission_digest: row.get("admission_digest")?,
            admitted_at: row.get("admitted_at")?,
            outcome_json: row.get("outcome_json")?,
            outcome_digest: row.get("outcome_digest")?,
            settled_at: row.get("settled_at")?,
        })
    }
}

#[derive(Debug)]
struct StoredRunV2 {
    id: i64,
    schema_version: String,
    session_id: String,
    host_run_id: String,
    run_open_request_id: String,
    lifecycle: String,
    run_open_envelope_json: String,
    run_open_envelope_digest: String,
    workspace_binding_ref: String,
    workspace_binding_identity: String,
    workspace_canonical_root: Option<String>,
    workspace_kind: String,
    empty_workspace_key: Option<String>,
    run_settings_json: String,
    provider_profile_id: Option<String>,
    provider_revision_digest: Option<String>,
    initial_input_json: String,
    opening_recorded_at: String,
    opening_digest: String,
    run_id: Option<String>,
    run_open_reply_json: Option<String>,
    workspace_binding_digest: Option<String>,
    bootstrap_digest: Option<String>,
    activated_at: Option<String>,
    retired_at: Option<String>,
    opening_caller_request_id: String,
    opening_request_digest: String,
    drive_caller_request_id: Option<String>,
    drive_request_digest: Option<String>,
    retirement_caller_request_id: Option<String>,
    retirement_request_digest: Option<String>,
    next_operation_sequence: i64,
}

impl StoredRunV2 {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            schema_version: row.get("schema_version")?,
            session_id: row.get("session_id")?,
            host_run_id: row.get("host_run_id")?,
            run_open_request_id: row.get("run_open_request_id")?,
            lifecycle: row.get("lifecycle")?,
            run_open_envelope_json: row.get("run_open_envelope_json")?,
            run_open_envelope_digest: row.get("run_open_envelope_digest")?,
            workspace_binding_ref: row.get("workspace_binding_ref")?,
            workspace_binding_identity: row.get("workspace_binding_identity")?,
            workspace_canonical_root: row.get("workspace_canonical_root")?,
            workspace_kind: row.get("workspace_kind")?,
            empty_workspace_key: row.get("empty_workspace_key")?,
            run_settings_json: row.get("run_settings_json")?,
            provider_profile_id: row.get("provider_profile_id")?,
            provider_revision_digest: row.get("provider_revision_digest")?,
            initial_input_json: row.get("initial_input_json")?,
            opening_recorded_at: row.get("opening_recorded_at")?,
            opening_digest: row.get("opening_digest")?,
            run_id: row.get("run_id")?,
            run_open_reply_json: row.get("run_open_reply_json")?,
            workspace_binding_digest: row.get("workspace_binding_digest")?,
            bootstrap_digest: row.get("bootstrap_digest")?,
            activated_at: row.get("activated_at")?,
            retired_at: row.get("retired_at")?,
            opening_caller_request_id: row.get("opening_caller_request_id")?,
            opening_request_digest: row.get("opening_request_digest")?,
            drive_caller_request_id: row.get("drive_caller_request_id")?,
            drive_request_digest: row.get("drive_request_digest")?,
            retirement_caller_request_id: row.get("retirement_caller_request_id")?,
            retirement_request_digest: row.get("retirement_request_digest")?,
            next_operation_sequence: row.get("next_operation_sequence")?,
        })
    }
}

#[derive(Debug)]
struct StoredOperationV2 {
    id: i64,
    schema_version: String,
    run_row_id: i64,
    operation_sequence: i64,
    operation_request_id: String,
    caller_request_id: Option<String>,
    caller_request_digest: Option<String>,
    run_id: String,
    bootstrap_digest: String,
    provider_revision_digest: Option<String>,
    production_frame_json: String,
    production_frame_digest: String,
    recorded_at: String,
    settlement_json: Option<String>,
    settlement_digest: Option<String>,
    settled_attempt_id: Option<String>,
    settled_at: Option<String>,
}

impl StoredOperationV2 {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            schema_version: row.get("schema_version")?,
            run_row_id: row.get("run_row_id")?,
            operation_sequence: row.get("operation_sequence")?,
            operation_request_id: row.get("operation_request_id")?,
            caller_request_id: row.get("caller_request_id")?,
            caller_request_digest: row.get("caller_request_digest")?,
            run_id: row.get("run_id")?,
            bootstrap_digest: row.get("bootstrap_digest")?,
            provider_revision_digest: row.get("provider_revision_digest")?,
            production_frame_json: row.get("production_frame_json")?,
            production_frame_digest: row.get("production_frame_digest")?,
            recorded_at: row.get("recorded_at")?,
            settlement_json: row.get("settlement_json")?,
            settlement_digest: row.get("settlement_digest")?,
            settled_attempt_id: row.get("settled_attempt_id")?,
            settled_at: row.get("settled_at")?,
        })
    }
}

#[derive(Debug)]
struct StoredAttemptV2 {
    id: i64,
    schema_version: String,
    operation_row_id: i64,
    attempt_sequence: i64,
    attempt_id: String,
    owner_instance_id: String,
    owner_binding_digest: String,
    recovery_of_attempt_id: Option<String>,
    state: String,
    prepared_at: String,
    state_recorded_at: String,
    state_reason_code: Option<String>,
    response_json: Option<String>,
    response_digest: Option<String>,
    response_observed_at: Option<String>,
}

impl StoredAttemptV2 {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            schema_version: row.get("schema_version")?,
            operation_row_id: row.get("operation_row_id")?,
            attempt_sequence: row.get("attempt_sequence")?,
            attempt_id: row.get("attempt_id")?,
            owner_instance_id: row.get("owner_instance_id")?,
            owner_binding_digest: row.get("owner_binding_digest")?,
            recovery_of_attempt_id: row.get("recovery_of_attempt_id")?,
            state: row.get("state")?,
            prepared_at: row.get("prepared_at")?,
            state_recorded_at: row.get("state_recorded_at")?,
            state_reason_code: row.get("state_reason_code")?,
            response_json: row.get("response_json")?,
            response_digest: row.get("response_digest")?,
            response_observed_at: row.get("response_observed_at")?,
        })
    }
}

fn configure_connection(connection: &Connection) -> Result<(), HostV2StorageError> {
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|error| database_error("host_kernel_store_busy_timeout_failed", error))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| database_error("host_kernel_store_pragma_failed", error))?;
    connection
        .pragma_update(None, "trusted_schema", "OFF")
        .map_err(|error| database_error("host_kernel_store_pragma_failed", error))?;
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|error| database_error("host_kernel_store_wal_failed", error))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(HostV2StorageError::io(
            "host_kernel_store_wal_unavailable",
            "Host Kernel v2 durable store requires SQLite WAL mode",
        ));
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| database_error("host_kernel_store_pragma_failed", error))?;
    connection
        .pragma_update(None, "wal_autocheckpoint", 1_000_i64)
        .map_err(|error| database_error("host_kernel_store_pragma_failed", error))?;
    connection
        .pragma_update(None, "journal_size_limit", SQLITE_WAL_LIMIT_BYTES)
        .map_err(|error| database_error("host_kernel_store_pragma_failed", error))?;
    let page_size: i64 = connection
        .pragma_query_value(None, "page_size", |row| row.get(0))
        .map_err(|error| database_error("host_kernel_store_pragma_failed", error))?;
    if page_size <= 0 {
        return Err(HostV2StorageError::io(
            "host_kernel_store_page_size_invalid",
            "SQLite returned an invalid page size for the Host Kernel store",
        ));
    }
    let maximum_pages = (MAX_DATABASE_BYTES / page_size).max(1);
    connection
        .pragma_update(None, "max_page_count", maximum_pages)
        .map_err(|error| database_error("host_kernel_store_pragma_failed", error))?;
    let effective_maximum: i64 = connection
        .pragma_query_value(None, "max_page_count", |row| row.get(0))
        .map_err(|error| database_error("host_kernel_store_pragma_failed", error))?;
    let current_pages: i64 = connection
        .pragma_query_value(None, "page_count", |row| row.get(0))
        .map_err(|error| database_error("host_kernel_store_pragma_failed", error))?;
    if effective_maximum > maximum_pages || current_pages > maximum_pages {
        return Err(HostV2StorageError::conflict(
            "host_kernel_store_database_limit",
            "Host Kernel v2 durable store exceeds its bounded database size",
        ));
    }
    Ok(())
}

fn initialize_or_validate_schema(connection: &mut Connection) -> Result<(), HostV2StorageError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("host_kernel_store_schema_lock_failed", error))?;
    let user_table_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| database_error("host_kernel_store_schema_inspect_failed", error))?;
    if user_table_count == 0 {
        transaction
            .execute_batch(SCHEMA_V2_SQL)
            .map_err(|error| database_error("host_kernel_store_schema_create_failed", error))?;
        transaction
            .execute(
                "INSERT INTO host_store_meta (
                    singleton, schema_discriminator, created_by_version
                 ) VALUES (1, ?1, ?2)",
                params![STORE_SCHEMA_V2, env!("CARGO_PKG_VERSION")],
            )
            .map_err(|error| database_error("host_kernel_store_schema_create_failed", error))?;
        transaction
            .execute(
                "INSERT INTO host_store_limits (
                    singleton, run_rows, caller_request_rows,
                    operation_rows, attempt_rows
                 ) VALUES (1, 0, 0, 0, 0)",
                [],
            )
            .map_err(|error| database_error("host_kernel_store_schema_create_failed", error))?;
        transaction
            .pragma_update(None, "user_version", SQLITE_USER_VERSION_V2)
            .map_err(|error| database_error("host_kernel_store_schema_create_failed", error))?;
        transaction
            .commit()
            .map_err(|error| database_error("host_kernel_store_schema_commit_failed", error))?;
        return Ok(());
    }
    let discriminator: Option<String> = transaction
        .query_row(
            "SELECT schema_discriminator FROM host_store_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| {
            HostV2StorageError::conflict(
                "host_kernel_store_schema_unsupported",
                "Existing Host Kernel store has no exact v2 schema discriminator",
            )
        })?;
    let user_version: i64 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| database_error("host_kernel_store_schema_inspect_failed", error))?;
    if discriminator.as_deref() != Some(STORE_SCHEMA_V2)
        || user_version != SQLITE_USER_VERSION_V2
        || user_table_count != 6
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_store_schema_unsupported",
            "Host Kernel durable store schema is not exact v2; migration and compatibility are disabled",
        ));
    }
    for required in [
        "host_store_meta",
        "host_store_limits",
        "host_caller_requests",
        "host_kernel_runs",
        "host_kernel_operations",
        "host_kernel_dispatch_attempts",
    ] {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
                 )",
                params![required],
                |row| row.get(0),
            )
            .map_err(|error| database_error("host_kernel_store_schema_inspect_failed", error))?;
        if !exists {
            return Err(HostV2StorageError::conflict(
                "host_kernel_store_schema_corrupt",
                "Exact v2 Host Kernel durable store is missing a required table",
            ));
        }
    }
    transaction
        .commit()
        .map_err(|error| database_error("host_kernel_store_schema_commit_failed", error))
}

const SCHEMA_V2_SQL: &str = r#"
CREATE TABLE host_store_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_discriminator TEXT NOT NULL,
    created_by_version TEXT NOT NULL
) STRICT;

CREATE TABLE host_store_limits (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    run_rows INTEGER NOT NULL CHECK (run_rows >= 0),
    caller_request_rows INTEGER NOT NULL CHECK (caller_request_rows >= 0),
    operation_rows INTEGER NOT NULL CHECK (operation_rows >= 0),
    attempt_rows INTEGER NOT NULL CHECK (attempt_rows >= 0)
) STRICT;

CREATE TABLE host_caller_requests (
    id INTEGER PRIMARY KEY,
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'deepcode.host.caller-request.v3'),
    session_id TEXT NOT NULL,
    caller_request_id TEXT NOT NULL,
    request_kind TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    response_identity_json TEXT NOT NULL,
    response_identity_digest TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    drive_state TEXT NOT NULL DEFAULT 'Bound'
        CHECK (drive_state IN ('Bound', 'Driving')),
    drive_owner_instance_id TEXT,
    drive_started_at TEXT,
    admission_json TEXT,
    admission_digest TEXT,
    admitted_at TEXT,
    outcome_json TEXT,
    outcome_digest TEXT,
    settled_at TEXT,
    CHECK (
        (drive_state = 'Bound'
            AND drive_owner_instance_id IS NULL
            AND drive_started_at IS NULL)
        OR (drive_state = 'Driving'
            AND drive_owner_instance_id IS NOT NULL
            AND drive_started_at IS NOT NULL)
    ),
    CHECK (
        (admission_json IS NULL AND admission_digest IS NULL AND admitted_at IS NULL)
        OR (admission_json IS NOT NULL
            AND admission_digest IS NOT NULL
            AND admitted_at IS NOT NULL)
    ),
    CHECK (
        (outcome_json IS NULL AND outcome_digest IS NULL AND settled_at IS NULL)
        OR (outcome_json IS NOT NULL
            AND outcome_digest IS NOT NULL
            AND settled_at IS NOT NULL)
    ),
    UNIQUE (session_id, caller_request_id)
) STRICT;

CREATE INDEX host_caller_requests_recorded
ON host_caller_requests(recorded_at, id);

CREATE TABLE host_kernel_runs (
    id INTEGER PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = 'deepcode.host.kernel-run.v4'),
    session_id TEXT NOT NULL,
    host_run_id TEXT NOT NULL,
    run_open_request_id TEXT NOT NULL UNIQUE,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('Opening', 'Active', 'Retired')),
    run_open_envelope_json TEXT NOT NULL,
    run_open_envelope_digest TEXT NOT NULL,
    workspace_binding_ref TEXT NOT NULL,
    workspace_binding_identity TEXT NOT NULL,
    workspace_canonical_root TEXT,
    workspace_kind TEXT NOT NULL CHECK (workspace_kind IN ('bound', 'empty')),
    empty_workspace_key TEXT,
    run_settings_json TEXT NOT NULL,
    provider_profile_id TEXT,
    provider_revision_digest TEXT,
    initial_input_json TEXT NOT NULL,
    opening_recorded_at TEXT NOT NULL,
    opening_digest TEXT NOT NULL,
    run_id TEXT,
    run_open_reply_json TEXT,
    workspace_binding_digest TEXT,
    bootstrap_digest TEXT,
    activated_at TEXT,
    retired_at TEXT,
    opening_caller_request_id TEXT NOT NULL,
    opening_request_digest TEXT NOT NULL,
    drive_caller_request_id TEXT,
    drive_request_digest TEXT,
    retirement_caller_request_id TEXT,
    retirement_request_digest TEXT,
    next_operation_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (next_operation_sequence >= 0),
    UNIQUE (session_id, host_run_id),
    CHECK (
        (provider_profile_id IS NULL AND provider_revision_digest IS NULL)
        OR (provider_profile_id IS NOT NULL AND provider_revision_digest IS NOT NULL)
    ),
    CHECK (
        (workspace_kind = 'bound' AND empty_workspace_key IS NULL)
        OR (workspace_kind = 'empty' AND empty_workspace_key IS NOT NULL)
    ),
    CHECK (
        (lifecycle = 'Opening'
            AND workspace_canonical_root IS NOT NULL
            AND run_id IS NULL
            AND run_open_reply_json IS NULL
            AND workspace_binding_digest IS NULL
            AND bootstrap_digest IS NULL
            AND activated_at IS NULL
            AND retired_at IS NULL)
        OR (lifecycle = 'Active'
            AND workspace_canonical_root IS NOT NULL
            AND run_id IS NOT NULL
            AND run_open_reply_json IS NOT NULL
            AND workspace_binding_digest IS NOT NULL
            AND bootstrap_digest IS NOT NULL
            AND activated_at IS NOT NULL
            AND retired_at IS NULL)
        OR (lifecycle = 'Retired' AND workspace_canonical_root IS NULL)
    ),
    CHECK (
        length(opening_caller_request_id) > 0
        AND length(opening_request_digest) > 0
    ),
    CHECK (
        (drive_caller_request_id IS NULL AND drive_request_digest IS NULL)
        OR (drive_caller_request_id IS NOT NULL AND drive_request_digest IS NOT NULL)
    ),
    CHECK (
        (retirement_caller_request_id IS NULL AND retirement_request_digest IS NULL)
        OR (lifecycle = 'Retired'
            AND retirement_caller_request_id IS NOT NULL
            AND retirement_request_digest IS NOT NULL)
    )
) STRICT;

CREATE UNIQUE INDEX host_kernel_one_live_run_per_session
ON host_kernel_runs(session_id)
WHERE lifecycle IN ('Opening', 'Active');

CREATE UNIQUE INDEX host_kernel_unique_active_run_id
ON host_kernel_runs(run_id)
WHERE run_id IS NOT NULL;

CREATE INDEX host_kernel_runs_lifecycle_sequence
ON host_kernel_runs(lifecycle, id);

CREATE TABLE host_kernel_operations (
    id INTEGER PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = 'deepcode.host.kernel-operation.v2'),
    run_row_id INTEGER NOT NULL
        REFERENCES host_kernel_runs(id) ON DELETE RESTRICT,
    operation_sequence INTEGER NOT NULL CHECK (operation_sequence > 0),
    operation_request_id TEXT NOT NULL UNIQUE,
    caller_request_id TEXT,
    caller_request_digest TEXT,
    run_id TEXT NOT NULL,
    bootstrap_digest TEXT NOT NULL,
    provider_revision_digest TEXT,
    production_frame_json TEXT NOT NULL,
    production_frame_digest TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    settlement_json TEXT,
    settlement_digest TEXT,
    settled_attempt_id TEXT,
    settled_at TEXT,
    UNIQUE (run_row_id, operation_sequence),
    CHECK (
        (caller_request_id IS NULL AND caller_request_digest IS NULL)
        OR (caller_request_id IS NOT NULL AND caller_request_digest IS NOT NULL)
    ),
    CHECK (
        (settlement_json IS NULL
            AND settlement_digest IS NULL
            AND settled_attempt_id IS NULL
            AND settled_at IS NULL)
        OR (settlement_json IS NOT NULL
            AND settlement_digest IS NOT NULL
            AND settled_attempt_id IS NOT NULL
            AND settled_at IS NOT NULL)
    )
) STRICT;

CREATE INDEX host_kernel_operations_pending_sequence
ON host_kernel_operations(run_row_id, operation_sequence)
WHERE settlement_digest IS NULL;

CREATE TABLE host_kernel_dispatch_attempts (
    id INTEGER PRIMARY KEY,
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'deepcode.host.kernel-dispatch-attempt.v2'),
    operation_row_id INTEGER NOT NULL
        REFERENCES host_kernel_operations(id) ON DELETE RESTRICT,
    attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence > 0),
    attempt_id TEXT NOT NULL UNIQUE,
    owner_instance_id TEXT NOT NULL,
    owner_binding_digest TEXT NOT NULL,
    recovery_of_attempt_id TEXT
        REFERENCES host_kernel_dispatch_attempts(attempt_id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (
        state IN (
            'Prepared', 'Committed', 'Indeterminate', 'Lost',
            'ResponseObserved', 'Settled'
        )
    ),
    prepared_at TEXT NOT NULL,
    state_recorded_at TEXT NOT NULL,
    state_reason_code TEXT,
    response_json TEXT,
    response_digest TEXT,
    response_observed_at TEXT,
    UNIQUE (operation_row_id, attempt_sequence),
    CHECK (
        (response_json IS NULL
            AND response_digest IS NULL
            AND response_observed_at IS NULL)
        OR (response_json IS NOT NULL
            AND response_digest IS NOT NULL
            AND response_observed_at IS NOT NULL)
    ),
    CHECK (
        state NOT IN ('ResponseObserved', 'Settled')
        OR response_digest IS NOT NULL
        OR state = 'Settled'
    )
) STRICT;

CREATE INDEX host_kernel_attempts_operation_sequence
ON host_kernel_dispatch_attempts(operation_row_id, attempt_sequence DESC);
"#;

fn validate_opening_input(input: &HostKernelRunOpeningInputV2) -> Result<(), HostV2StorageError> {
    validate_safe_session_identity(&input.session_id)?;
    for (field, value, maximum) in [
        ("hostRunId", input.host_run_id.as_str(), 512),
        (
            "driveCallerRequestId",
            input.drive_caller_request_id.as_str(),
            512,
        ),
        ("runOpenRequestId", input.run_open_request_id.as_str(), 512),
        (
            "workspaceBindingIdentity",
            input.workspace_binding_identity.as_str(),
            64 * 1024,
        ),
        ("initialInputId", input.initial_input.input_id.as_str(), 512),
        (
            "initialOpaqueInputRef",
            input.initial_input.opaque_input_ref.as_str(),
            64 * 1024,
        ),
        (
            "initialRecordedAt",
            input.initial_input.recorded_at.as_str(),
            1024,
        ),
        (
            "openingRecordedAt",
            input.opening_recorded_at.as_str(),
            1024,
        ),
    ] {
        validate_bounded_identity(value, field, maximum)?;
    }
    validate_sha256_digest(&input.drive_request_digest, "driveRequestDigest")?;
    if let Some(active_folder_id) = input.active_folder_id.as_deref() {
        validate_bounded_identity(active_folder_id, "activeFolderId", 512)?;
    }
    if input.workspace_kind == HostRunWorkspaceKindV2::Empty && input.active_folder_id.is_some() {
        return Err(HostV2StorageError::invalid(
            "host_kernel_workspace_binding_invalid",
            "Empty Run cannot carry an active folder identity",
        ));
    }
    if !input
        .workspace_binding_identity
        .starts_with("deepcode.workspace-root.v2:")
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_workspace_identity_invalid",
            "Workspace binding identity must be the opaque v2 Host identity token",
        ));
    }
    if input.initial_input.text.len() > MAX_INITIAL_INPUT_BYTES {
        return Err(HostV2StorageError::invalid(
            "host_kernel_bootstrap_input_too_large",
            "Host Kernel initial input exceeds its bounded size",
        ));
    }
    crate::validate_agent_input_attachment_slice_v2(&input.initial_input.attachments)
        .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;
    input.provider_profile.validate()?;
    input.prior_session_events.validate(&input.session_id)?;
    validate_workspace_shape(
        input.workspace_kind,
        input.empty_workspace_key.as_deref(),
        &input.run_settings,
    )?;
    input.run_open_envelope.validate().map_err(|_| {
        HostV2StorageError::invalid(
            "host_kernel_run_open_envelope_invalid",
            "RunOpen envelope failed strict v2 validation",
        )
    })?;
    if input.run_open_envelope.request_id.as_str() != input.run_open_request_id {
        return Err(HostV2StorageError::conflict(
            "host_kernel_run_open_request_identity_conflict",
            "RunOpen envelope requestId does not match the durable request identity",
        ));
    }
    let KernelCommandV2::RunOpen(command) = &input.run_open_envelope.command else {
        return Err(HostV2StorageError::invalid(
            "host_kernel_run_open_command_required",
            "Opening persistence accepts only a strict v2 RunOpen envelope",
        ));
    };
    if command.input_id.as_str() != input.initial_input.input_id
        || command.opaque_input_ref != input.initial_input.opaque_input_ref
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_run_open_input_conflict",
            "RunOpen envelope does not match the exact durable initial input",
        ));
    }
    Ok(())
}

fn canonical_workspace_root_text(root: &Path) -> Result<String, HostV2StorageError> {
    if !root.is_absolute() {
        return Err(HostV2StorageError::invalid(
            "host_kernel_workspace_root_invalid",
            "Host-only workspace recovery root must be absolute",
        ));
    }
    let canonical = fs::canonicalize(root).map_err(|error| {
        HostV2StorageError::io(
            "host_kernel_workspace_root_unavailable",
            format!("validate Host-only workspace recovery root: {error}"),
        )
    })?;
    if canonical != root || !canonical.is_dir() {
        return Err(HostV2StorageError::conflict(
            "host_kernel_workspace_root_stale",
            "Host-only workspace recovery root is no longer the exact canonical directory",
        ));
    }
    fs::read_dir(&canonical).map_err(|error| {
        HostV2StorageError::io(
            "host_kernel_workspace_root_unavailable",
            format!("read Host-only workspace recovery root: {error}"),
        )
    })?;
    let text = canonical.to_str().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_workspace_root_encoding_unsupported",
            "Host-only workspace recovery root must be valid UTF-8",
        )
    })?;
    if text.is_empty() || text.len() > 64 * 1024 {
        return Err(HostV2StorageError::invalid(
            "host_kernel_workspace_root_invalid",
            "Host-only workspace recovery root exceeds its bounded storage shape",
        ));
    }
    Ok(text.to_string())
}

fn validate_caller_request_identity(
    session_id: &str,
    caller_request_id: &str,
    request_kind: &str,
    request_digest: &str,
) -> Result<(), HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    validate_bounded_identity(caller_request_id, "callerRequestId", 512)?;
    validate_bounded_identity(request_kind, "requestKind", 128)?;
    validate_sha256_digest(request_digest, "requestDigest")
}

fn validate_activation_input(
    input: &HostKernelBootstrapActivationV2,
) -> Result<(), HostV2StorageError> {
    validate_safe_session_identity(&input.session_id)?;
    for (field, value, maximum) in [
        ("hostRunId", input.host_run_id.as_str(), 512),
        ("runOpenRequestId", input.run_open_request_id.as_str(), 512),
        ("activatedAt", input.activated_at.as_str(), 1024),
    ] {
        validate_bounded_identity(value, field, maximum)?;
    }
    input.run_open_reply.validate().map_err(|_| {
        HostV2StorageError::invalid(
            "host_kernel_bootstrap_run_open_reply_invalid",
            "RunOpen reply failed strict v2 validation",
        )
    })
}

fn validate_workspace_shape(
    workspace_kind: HostRunWorkspaceKindV2,
    empty_workspace_key: Option<&str>,
    run_settings: &HostRunSettingsCeilingV2,
) -> Result<(), HostV2StorageError> {
    match workspace_kind {
        HostRunWorkspaceKindV2::Bound if empty_workspace_key.is_some() => {
            Err(HostV2StorageError::invalid(
                "host_kernel_workspace_binding_invalid",
                "Bound Run cannot carry an empty workspace key",
            ))
        }
        HostRunWorkspaceKindV2::Empty => {
            let key = empty_workspace_key.ok_or_else(|| {
                HostV2StorageError::invalid(
                    "host_kernel_workspace_binding_invalid",
                    "Empty Run requires a managed empty workspace key",
                )
            })?;
            validate_bounded_identity(key, "emptyWorkspaceKey", 512)?;
            if run_settings != &HostRunSettingsCeilingV2::empty_workspace() {
                return Err(HostV2StorageError::invalid(
                    "host_kernel_workspace_binding_invalid",
                    "Empty Run requires the zero capability Settings ceiling",
                ));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_production_frame(
    frame: &Value,
    operation_request_id: &str,
) -> Result<(), HostV2StorageError> {
    reject_host_private_persistence_fields(frame)?;
    if canonical_json_bytes(frame)?.len() > MAX_OPERATION_FRAME_BYTES {
        return Err(HostV2StorageError::invalid(
            "host_kernel_operation_frame_invalid",
            "Production frame must be a bounded JSON object",
        ));
    }
    let frame_object = exact_object_fields(
        frame,
        &["schemaVersion", "operationRequestId", "request"],
        &["schemaVersion", "operationRequestId", "request"],
        "Production frame",
    )?;
    if frame.get("schemaVersion").and_then(Value::as_str) != Some(PRODUCTION_FRAME_SCHEMA_V2)
        || frame.get("operationRequestId").and_then(Value::as_str) != Some(operation_request_id)
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_operation_frame_identity_invalid",
            "Production frame schema or operationRequestId is not exact v2",
        ));
    }
    let request = exact_object_fields(
        frame_object.get("request").ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_operation_frame_invalid",
                "Production frame has no request",
            )
        })?,
        &[
            "schemaVersion",
            "sessionId",
            "hostRunId",
            "runId",
            "historySchema",
            "providerProfile",
            "priorSessionEvents",
            "prefetchedRun",
            "initialInput",
            "operation",
        ],
        &[
            "schemaVersion",
            "sessionId",
            "hostRunId",
            "runId",
            "historySchema",
            "providerProfile",
            "priorSessionEvents",
            "prefetchedRun",
            "initialInput",
            "operation",
        ],
        "Production request",
    )?;
    if request.get("schemaVersion").and_then(Value::as_str) != Some(PRODUCTION_REQUEST_SCHEMA_V2)
        || request.get("historySchema").and_then(Value::as_str) != Some(HISTORY_SCHEMA_V3)
        || !request.get("operation").is_some_and(Value::is_object)
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_operation_request_invalid",
            "Production request is not the exact safe v2 shape",
        ));
    }
    let provider_profile: HostProviderProfileBootstrapV2 =
        serde_json::from_value(request.get("providerProfile").cloned().ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_operation_provider_profile_missing",
                "Production request has no immutable Provider profile",
            )
        })?)
        .map_err(|_| {
            HostV2StorageError::invalid(
                "host_kernel_operation_provider_profile_invalid",
                "Production request Provider profile is not exact v2",
            )
        })?;
    provider_profile.validate()?;
    let prior_events: HostSessionPriorEventsV2 =
        serde_json::from_value(request.get("priorSessionEvents").cloned().ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_operation_prior_events_missing",
                "Production request has no immutable prior Session event source",
            )
        })?)
        .map_err(|_| {
            HostV2StorageError::invalid(
                "host_kernel_operation_prior_events_invalid",
                "Production request prior Session events are not exact v2",
            )
        })?;
    prior_events.validate(
        request
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    Ok(())
}

fn validate_frame_against_bootstrap(
    frame: &Value,
    bootstrap: &HostKernelBootstrapRecordV2,
) -> Result<(), HostV2StorageError> {
    let request = frame
        .get("request")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_operation_request_invalid",
                "Production frame request is not an object",
            )
        })?;
    if request.get("sessionId").and_then(Value::as_str) != Some(bootstrap.session_id.as_str())
        || request.get("hostRunId").and_then(Value::as_str) != Some(bootstrap.host_run_id.as_str())
        || request.get("runId").and_then(Value::as_str) != Some(bootstrap.run_id.as_str())
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_run_binding_conflict",
            "Production frame does not match the exact Active Run identity",
        ));
    }
    let expected_provider_profile =
        serde_json::to_value(&bootstrap.provider_profile).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_operation_provider_profile_invalid",
                format!("encode bootstrap Provider profile: {error}"),
            )
        })?;
    let expected_prior_events =
        serde_json::to_value(&bootstrap.prior_session_events).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_operation_prior_events_invalid",
                format!("encode bootstrap prior Session events: {error}"),
            )
        })?;
    if request.get("providerProfile") != Some(&expected_provider_profile)
        || request.get("priorSessionEvents") != Some(&expected_prior_events)
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_session_bootstrap_conflict",
            "Production frame Session context differs from the immutable bootstrap",
        ));
    }
    let prefetched = exact_object_fields(
        request.get("prefetchedRun").ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_kernel_operation_prefetched_run_invalid",
                "Production request has no prefetched Run",
            )
        })?,
        &[
            "schemaVersion",
            "workspaceBindingRef",
            "inputId",
            "opaqueInputRef",
            "runOpenReply",
        ],
        &[
            "schemaVersion",
            "workspaceBindingRef",
            "inputId",
            "opaqueInputRef",
            "runOpenReply",
        ],
        "Prefetched Run",
    )?;
    if prefetched.get("schemaVersion").and_then(Value::as_str) != Some(PREFETCHED_RUN_SCHEMA_V2)
        || prefetched
            .get("workspaceBindingRef")
            .and_then(Value::as_str)
            != Some(bootstrap.workspace_binding_ref.as_str())
        || prefetched.get("inputId").and_then(Value::as_str)
            != Some(bootstrap.initial_input.input_id.as_str())
        || prefetched.get("opaqueInputRef").and_then(Value::as_str)
            != Some(bootstrap.initial_input.opaque_input_ref.as_str())
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_prefetched_run_conflict",
            "Production frame prefetched Run does not match the immutable bootstrap",
        ));
    }
    let expected_reply = serde_json::to_value(&bootstrap.run_open_reply).map_err(|error| {
        HostV2StorageError::invalid(
            "host_kernel_operation_prefetched_run_invalid",
            format!("encode bootstrap RunOpen reply: {error}"),
        )
    })?;
    let expected_input = serde_json::to_value(&bootstrap.initial_input).map_err(|error| {
        HostV2StorageError::invalid(
            "host_kernel_operation_initial_input_invalid",
            format!("encode bootstrap initial input: {error}"),
        )
    })?;
    if prefetched.get("runOpenReply") != Some(&expected_reply)
        || request.get("initialInput") != Some(&expected_input)
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_bootstrap_projection_conflict",
            "Production frame projection does not match the immutable bootstrap",
        ));
    }
    Ok(())
}

fn exact_object_fields<'a>(
    value: &'a Value,
    allowed: &[&str],
    required: &[&str],
    label: &'static str,
) -> Result<&'a serde_json::Map<String, Value>, HostV2StorageError> {
    let object = value.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_safe_dto_invalid",
            format!("{label} must be a JSON object"),
        )
    })?;
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_safe_dto_invalid",
            format!("{label} has unknown or missing fields"),
        ));
    }
    Ok(object)
}

fn validate_dispatch_prepare(
    input: &HostKernelDispatchPrepareV2,
) -> Result<(), HostV2StorageError> {
    validate_operation_ref(&input.operation)?;
    validate_bounded_identity(&input.owner_instance_id, "ownerInstanceId", 512)?;
    validate_bounded_identity(&input.prepared_at, "preparedAt", 1024)?;
    validate_attempt_id_for_owner(&input.attempt_id, &input.owner_instance_id)
}

fn validate_dispatch_recovery(
    input: &HostKernelDispatchRecoveryV2,
) -> Result<(), HostV2StorageError> {
    validate_operation_ref(&input.operation)?;
    validate_bounded_identity(&input.previous_attempt_id, "previousAttemptId", 512)?;
    validate_bounded_identity(&input.owner_instance_id, "ownerInstanceId", 512)?;
    validate_bounded_identity(&input.prepared_at, "preparedAt", 1024)?;
    validate_attempt_id_for_owner(&input.attempt_id, &input.owner_instance_id)?;
    if input.attempt_id == input.previous_attempt_id {
        return Err(HostV2StorageError::invalid(
            "host_kernel_dispatch_recovery_identity_invalid",
            "Recovery attempt must use a new opaque attempt identity",
        ));
    }
    Ok(())
}

fn validate_attempt_transition(
    operation: &HostKernelOperationRefV2,
    attempt_id: &str,
    owner_instance_id: &str,
    recorded_at: &str,
) -> Result<(), HostV2StorageError> {
    validate_operation_ref(operation)?;
    validate_bounded_identity(owner_instance_id, "ownerInstanceId", 512)?;
    validate_bounded_identity(recorded_at, "recordedAt", 1024)?;
    validate_attempt_id_for_owner(attempt_id, owner_instance_id)
}

fn validate_operation_ref(operation: &HostKernelOperationRefV2) -> Result<(), HostV2StorageError> {
    validate_safe_session_identity(&operation.session_id)?;
    for (field, value) in [
        ("hostRunId", operation.host_run_id.as_str()),
        ("runId", operation.run_id.as_str()),
        (
            "operationRequestId",
            operation.operation_request_id.as_str(),
        ),
    ] {
        validate_bounded_identity(value, field, 512)?;
    }
    validate_sha256_digest(&operation.bootstrap_digest, "bootstrapDigest")
}

fn validate_attempt_id_for_owner(
    attempt_id: &str,
    owner_instance_id: &str,
) -> Result<(), HostV2StorageError> {
    validate_bounded_identity(attempt_id, "attemptId", 512)?;
    let owner_component = sha256_path_component(owner_instance_id);
    let expected_prefix = format!("host_attempt_v2_{}_", &owner_component[..16]);
    let Some(opaque) = attempt_id.strip_prefix(&expected_prefix) else {
        return Err(HostV2StorageError::invalid(
            "host_kernel_dispatch_attempt_owner_invalid",
            "Dispatch attempt identity is not bound to the Host owner instance",
        ));
    };
    if opaque.len() != 64
        || !opaque
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_dispatch_attempt_identity_invalid",
            "Dispatch attempt identity is not an opaque v2 identity",
        ));
    }
    Ok(())
}

fn validate_persisted_response(response: &Value) -> Result<(), HostV2StorageError> {
    reject_host_private_persistence_fields(response)?;
    if !response.is_object() || canonical_json_bytes(response)?.len() > MAX_RESPONSE_BYTES {
        return Err(HostV2StorageError::invalid(
            "host_kernel_operation_response_invalid",
            "Observed response must be a bounded safe JSON object",
        ));
    }
    Ok(())
}

fn validate_settlement(
    settlement: &HostKernelOperationSettlementV2,
) -> Result<(), HostV2StorageError> {
    let value = serde_json::to_value(settlement).map_err(|error| {
        HostV2StorageError::invalid(
            "host_kernel_operation_settlement_invalid",
            format!("encode Host Kernel operation settlement: {error}"),
        )
    })?;
    reject_host_private_persistence_fields(&value)?;
    if canonical_json_bytes(&value)?.len() > MAX_RESPONSE_BYTES {
        return Err(HostV2StorageError::invalid(
            "host_kernel_operation_settlement_too_large",
            "Operation settlement exceeds its bounded size",
        ));
    }
    match settlement {
        HostKernelOperationSettlementV2::Succeeded {
            response,
            continuation,
        } if response.is_object() && continuation.is_object() => Ok(()),
        HostKernelOperationSettlementV2::Succeeded { .. } => Err(HostV2StorageError::invalid(
            "host_kernel_operation_settlement_invalid",
            "Successful settlement requires object response and continuation",
        )),
        HostKernelOperationSettlementV2::FailedRecoverable {
            error_code,
            boundary,
        } => {
            validate_bounded_identity(error_code, "errorCode", 512)?;
            let valid = match boundary.disposition {
                HostKernelFailureDispositionV2::RetrySameRequest => {
                    boundary.commit == HostKernelFailureCommitV2::None
                        && boundary.effect == HostKernelFailureEffectV2::None
                        && boundary.pending_request_lanes.is_empty()
                }
                HostKernelFailureDispositionV2::QueryFacts => {
                    boundary.commit == HostKernelFailureCommitV2::Unknown
                        && boundary.effect == HostKernelFailureEffectV2::Possible
                }
                HostKernelFailureDispositionV2::CorrectRequest
                | HostKernelFailureDispositionV2::DoNotRetry => false,
            };
            if !valid {
                return Err(HostV2StorageError::invalid(
                    "host_kernel_operation_failure_boundary_invalid",
                    "Recoverable Session failure has an inconsistent commit or effect boundary",
                ));
            }
            Ok(())
        }
        HostKernelOperationSettlementV2::FailedTerminal {
            error_code,
            boundary,
        } => {
            validate_bounded_identity(error_code, "errorCode", 512)?;
            if !matches!(
                boundary.disposition,
                HostKernelFailureDispositionV2::CorrectRequest
                    | HostKernelFailureDispositionV2::DoNotRetry
            ) || boundary.commit != HostKernelFailureCommitV2::None
                || boundary.effect != HostKernelFailureEffectV2::None
                || !boundary.pending_request_lanes.is_empty()
            {
                return Err(HostV2StorageError::invalid(
                    "host_kernel_operation_failure_boundary_invalid",
                    "Terminal Session failure has an inconsistent commit or effect boundary",
                ));
            }
            Ok(())
        }
    }
}

fn validate_failure_settlement_matches_observed_response(
    attempt: &StoredAttemptV2,
    settlement: &HostKernelOperationSettlementV2,
) -> Result<(), HostV2StorageError> {
    let observed = attempt
        .response_json
        .as_deref()
        .map(|response| {
            serde_json::from_str::<Value>(response)
                .map_err(|_| corrupt("Observed failure response JSON is corrupt"))
        })
        .transpose()?;
    validate_failure_settlement_matches_observed_response_record(observed.as_ref(), settlement)
}

fn validate_failure_settlement_matches_observed_response_record(
    observed: Option<&Value>,
    settlement: &HostKernelOperationSettlementV2,
) -> Result<(), HostV2StorageError> {
    let (error_code, boundary) = match settlement {
        HostKernelOperationSettlementV2::FailedRecoverable {
            error_code,
            boundary,
        }
        | HostKernelOperationSettlementV2::FailedTerminal {
            error_code,
            boundary,
        } => (error_code, boundary),
        HostKernelOperationSettlementV2::Succeeded { .. } => {
            return Err(HostV2StorageError::invalid(
                "host_kernel_operation_failure_binding_invalid",
                "Failure response verification cannot bind a successful settlement",
            ))
        }
    };
    let boundary_value = serde_json::to_value(boundary).map_err(|error| {
        HostV2StorageError::invalid(
            "host_kernel_operation_failure_binding_invalid",
            format!("encode failure boundary: {error}"),
        )
    })?;
    let mut error_value = boundary_value.as_object().cloned().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_kernel_operation_failure_binding_invalid",
            "Failure boundary did not encode as an object",
        )
    })?;
    error_value.insert("code".to_string(), Value::String(error_code.clone()));
    let expected = json!({
        "schemaVersion": PRODUCTION_RESPONSE_SCHEMA_V2,
        "ok": false,
        "error": error_value,
    });
    if observed != Some(&expected) {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_failure_response_conflict",
            "Failure settlement does not match the exact observed Session response",
        ));
    }
    Ok(())
}

fn reject_host_private_persistence_fields(value: &Value) -> Result<(), HostV2StorageError> {
    reject_transport_capabilities(value)?;
    match value {
        Value::Array(items) => {
            for item in items {
                reject_host_private_persistence_fields(item)?;
            }
        }
        Value::Object(fields) => {
            for (key, nested) in fields {
                let normalized = key
                    .bytes()
                    .filter(u8::is_ascii_alphanumeric)
                    .map(|byte| byte.to_ascii_lowercase())
                    .collect::<Vec<_>>();
                if matches!(
                    normalized.as_slice(),
                    b"absoluteroot"
                        | b"workspaceroot"
                        | b"apibase"
                        | b"nodepath"
                        | b"nodebinary"
                        | b"bridgepath"
                        | b"executablepath"
                ) {
                    return Err(HostV2StorageError::invalid(
                        "host_kernel_private_runtime_field_forbidden",
                        "Host-private root, transport, or process launch fields cannot enter v2 persistence",
                    ));
                }
                reject_host_private_persistence_fields(nested)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn canonical_json_string(value: &Value) -> Result<String, HostV2StorageError> {
    String::from_utf8(canonical_json_bytes(value)?).map_err(|_| {
        HostV2StorageError::invalid(
            "host_kernel_canonical_json_invalid",
            "Canonical Host Kernel JSON is not UTF-8",
        )
    })
}

fn workspace_kind_text(kind: HostRunWorkspaceKindV2) -> &'static str {
    match kind {
        HostRunWorkspaceKindV2::Bound => "bound",
        HostRunWorkspaceKindV2::Empty => "empty",
    }
}

fn parse_workspace_kind(value: &str) -> Result<HostRunWorkspaceKindV2, HostV2StorageError> {
    match value {
        "bound" => Ok(HostRunWorkspaceKindV2::Bound),
        "empty" => Ok(HostRunWorkspaceKindV2::Empty),
        _ => Err(corrupt("Host Kernel Run has an invalid workspace kind")),
    }
}

fn parse_run_lifecycle(value: &str) -> Result<HostKernelStoredRunLifecycleV2, HostV2StorageError> {
    match value {
        "Opening" => Ok(HostKernelStoredRunLifecycleV2::Opening),
        "Active" => Ok(HostKernelStoredRunLifecycleV2::Active),
        "Retired" => Ok(HostKernelStoredRunLifecycleV2::Retired),
        _ => Err(corrupt("Host Kernel Run has an invalid lifecycle")),
    }
}

fn parse_attempt_state(
    value: &str,
) -> Result<HostKernelDispatchAttemptStateV2, HostV2StorageError> {
    match value {
        "Prepared" => Ok(HostKernelDispatchAttemptStateV2::Prepared),
        "Committed" => Ok(HostKernelDispatchAttemptStateV2::Committed),
        "Indeterminate" => Ok(HostKernelDispatchAttemptStateV2::Indeterminate),
        "Lost" => Ok(HostKernelDispatchAttemptStateV2::Lost),
        "ResponseObserved" => Ok(HostKernelDispatchAttemptStateV2::ResponseObserved),
        "Settled" => Ok(HostKernelDispatchAttemptStateV2::Settled),
        _ => Err(corrupt("Host Kernel dispatch attempt has an invalid state")),
    }
}

fn reserve_row(
    transaction: &Transaction<'_>,
    column: &'static str,
    maximum: i64,
) -> Result<(), HostV2StorageError> {
    let sql = match column {
        "run_rows" => {
            "UPDATE host_store_limits SET run_rows = run_rows + 1
             WHERE singleton = 1 AND run_rows < ?1"
        }
        "caller_request_rows" => {
            "UPDATE host_store_limits
             SET caller_request_rows = caller_request_rows + 1
             WHERE singleton = 1 AND caller_request_rows < ?1"
        }
        "operation_rows" => {
            "UPDATE host_store_limits SET operation_rows = operation_rows + 1
             WHERE singleton = 1 AND operation_rows < ?1"
        }
        "attempt_rows" => {
            "UPDATE host_store_limits SET attempt_rows = attempt_rows + 1
             WHERE singleton = 1 AND attempt_rows < ?1"
        }
        _ => {
            return Err(HostV2StorageError::io(
                "host_kernel_store_limit_invalid",
                "Host Kernel store selected an unknown row limit",
            ))
        }
    };
    let changed = transaction
        .execute(sql, params![maximum])
        .map_err(|error| database_error("host_kernel_store_limit_update_failed", error))?;
    if changed != 1 {
        return Err(HostV2StorageError::conflict(
            "host_kernel_store_row_limit",
            "Host Kernel v2 durable store reached its bounded row limit",
        ));
    }
    Ok(())
}

fn require_active_run(
    connection: &Connection,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
    bootstrap_digest: &str,
) -> Result<StoredRunV2, HostV2StorageError> {
    let run =
        stored_run_by_session_host(connection, session_id, host_run_id)?.ok_or_else(|| {
            HostV2StorageError::not_found(
                "host_kernel_run_not_found",
                "Host Kernel Run was not found",
            )
        })?;
    if parse_run_lifecycle(&run.lifecycle)? != HostKernelStoredRunLifecycleV2::Active
        || run.run_id.as_deref() != Some(run_id)
        || run.bootstrap_digest.as_deref() != Some(bootstrap_digest)
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_active_run_identity_conflict",
            "Operation does not match the exact Active Host Kernel bootstrap",
        ));
    }
    decode_bootstrap_record(&run)?;
    Ok(run)
}

fn require_operation(
    connection: &Connection,
    operation: &HostKernelOperationRefV2,
) -> Result<StoredOperationV2, HostV2StorageError> {
    let stored = stored_operation_by_request(connection, &operation.operation_request_id)?
        .ok_or_else(|| {
            HostV2StorageError::not_found(
                "host_kernel_operation_not_found",
                "Host Kernel operation request was not found",
            )
        })?;
    let run = stored_run_by_id(connection, stored.run_row_id)?
        .ok_or_else(|| corrupt("Host Kernel operation references a missing Run"))?;
    if run.session_id != operation.session_id
        || run.host_run_id != operation.host_run_id
        || stored.run_id != operation.run_id
        || stored.bootstrap_digest != operation.bootstrap_digest
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_identity_conflict",
            "Operation reference does not match its immutable Active Run binding",
        ));
    }
    validate_stored_operation(&stored)?;
    let bootstrap = decode_bootstrap_record(&run)?;
    let frame = decode_stored_production_frame(&stored)?;
    validate_frame_against_bootstrap(&frame, &bootstrap)?;
    Ok(stored)
}

fn require_pending_operation(
    connection: &Connection,
    operation: &HostKernelOperationRefV2,
    require_active: bool,
) -> Result<StoredOperationV2, HostV2StorageError> {
    let stored = require_operation(connection, operation)?;
    if stored.settlement_digest.is_some() {
        return Err(HostV2StorageError::conflict(
            "host_kernel_operation_already_settled",
            "Settled Host Kernel operation cannot be dispatched",
        ));
    }
    if require_active {
        require_active_run(
            connection,
            &operation.session_id,
            &operation.host_run_id,
            &operation.run_id,
            &operation.bootstrap_digest,
        )?;
    }
    Ok(stored)
}

fn insert_attempt(
    transaction: &Transaction<'_>,
    operation: &StoredOperationV2,
    attempt_id: &str,
    owner_instance_id: &str,
    recovery_of_attempt_id: Option<&str>,
    prepared_at: &str,
) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
    reserve_row(transaction, "attempt_rows", MAX_ATTEMPT_ROWS)?;
    let latest = latest_attempt(transaction, operation.id)?;
    let next_sequence = latest
        .as_ref()
        .map(|attempt| attempt.attempt_sequence)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_kernel_dispatch_attempt_sequence_exhausted",
                "Dispatch attempt sequence is exhausted",
            )
        })?;
    let owner_binding_digest = canonical_sha256(&json!({
        "schemaVersion": ATTEMPT_ROW_SCHEMA_V2,
        "operationRequestId": &operation.operation_request_id,
        "operationSequence": operation.operation_sequence,
        "attemptSequence": next_sequence,
        "attemptId": attempt_id,
        "ownerInstanceId": owner_instance_id,
        "recoveryOfAttemptId": recovery_of_attempt_id,
        "bootstrapDigest": &operation.bootstrap_digest,
        "preparedAt": prepared_at,
    }))?;
    transaction
        .execute(
            "INSERT INTO host_kernel_dispatch_attempts (
                schema_version, operation_row_id, attempt_sequence, attempt_id,
                owner_instance_id, owner_binding_digest, recovery_of_attempt_id,
                state, prepared_at, state_recorded_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Prepared', ?8, ?8)",
            params![
                ATTEMPT_ROW_SCHEMA_V2,
                operation.id,
                next_sequence,
                attempt_id,
                owner_instance_id,
                owner_binding_digest,
                recovery_of_attempt_id,
                prepared_at,
            ],
        )
        .map_err(|error| database_error("host_kernel_dispatch_attempt_prepare_failed", error))?;
    let stored = stored_attempt_by_id(transaction, attempt_id)?.ok_or_else(|| {
        HostV2StorageError::io(
            "host_kernel_dispatch_attempt_lost",
            "Prepared dispatch attempt disappeared before commit",
        )
    })?;
    attempt_receipt(operation, stored)
}

fn replay_exact_attempt(
    attempt: StoredAttemptV2,
    operation: &StoredOperationV2,
    owner_instance_id: &str,
    recovery_of_attempt_id: Option<&str>,
    prepared_at: &str,
) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
    if attempt.operation_row_id != operation.id
        || attempt.owner_instance_id != owner_instance_id
        || attempt.recovery_of_attempt_id.as_deref() != recovery_of_attempt_id
        || attempt.prepared_at != prepared_at
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_dispatch_attempt_identity_conflict",
            "Dispatch attempt identity is permanently bound to different content",
        ));
    }
    attempt_receipt(operation, attempt)
}

fn require_owned_attempt(
    connection: &Connection,
    operation_row_id: i64,
    attempt_id: &str,
    owner_instance_id: &str,
) -> Result<StoredAttemptV2, HostV2StorageError> {
    let attempt = stored_attempt_by_id(connection, attempt_id)?.ok_or_else(|| {
        HostV2StorageError::not_found(
            "host_kernel_dispatch_attempt_not_found",
            "Dispatch attempt was not found",
        )
    })?;
    if attempt.operation_row_id != operation_row_id
        || attempt.owner_instance_id != owner_instance_id
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_dispatch_attempt_owner_conflict",
            "Dispatch attempt does not belong to the exact operation and Host owner",
        ));
    }
    validate_stored_attempt(&attempt)?;
    Ok(attempt)
}

fn update_attempt_state(
    transaction: &Transaction<'_>,
    attempt_row_id: i64,
    state: &'static str,
    recorded_at: &str,
    reason_code: Option<&str>,
) -> Result<(), HostV2StorageError> {
    transaction
        .execute(
            "UPDATE host_kernel_dispatch_attempts
             SET state = ?1, state_recorded_at = ?2, state_reason_code = ?3
             WHERE id = ?4",
            params![state, recorded_at, reason_code, attempt_row_id],
        )
        .map_err(|error| database_error("host_kernel_dispatch_state_write_failed", error))?;
    Ok(())
}

fn attempt_receipt(
    operation: &StoredOperationV2,
    attempt: StoredAttemptV2,
) -> Result<HostKernelDispatchAttemptReceiptV2, HostV2StorageError> {
    validate_stored_operation(operation)?;
    validate_stored_attempt(&attempt)?;
    if attempt.operation_row_id != operation.id {
        return Err(corrupt(
            "Dispatch attempt does not match its immutable operation",
        ));
    }
    let expected_owner_binding = canonical_sha256(&json!({
        "schemaVersion": ATTEMPT_ROW_SCHEMA_V2,
        "operationRequestId": &operation.operation_request_id,
        "operationSequence": operation.operation_sequence,
        "attemptSequence": attempt.attempt_sequence,
        "attemptId": &attempt.attempt_id,
        "ownerInstanceId": &attempt.owner_instance_id,
        "recoveryOfAttemptId": &attempt.recovery_of_attempt_id,
        "bootstrapDigest": &operation.bootstrap_digest,
        "preparedAt": &attempt.prepared_at,
    }))?;
    if attempt.owner_binding_digest != expected_owner_binding {
        return Err(corrupt(
            "Dispatch attempt failed owner-binding digest verification",
        ));
    }
    let observed_response = attempt
        .response_json
        .as_deref()
        .map(|value| {
            serde_json::from_str(value).map_err(|_| corrupt("Observed response JSON is corrupt"))
        })
        .transpose()?;
    positive_u64(operation.operation_sequence, "operationSequence")?;
    positive_u64(attempt.attempt_sequence, "attemptSequence")?;
    Ok(HostKernelDispatchAttemptReceiptV2 {
        attempt_id: attempt.attempt_id,
        owner_instance_id: attempt.owner_instance_id,
        state: parse_attempt_state(&attempt.state)?,
        observed_response,
        response_digest: attempt.response_digest,
    })
}

fn settlement_receipt(
    operation: &StoredOperationV2,
) -> Result<HostKernelOperationSettlementReceiptV2, HostV2StorageError> {
    validate_stored_operation(operation)?;
    let settlement_json = operation
        .settlement_json
        .as_ref()
        .ok_or_else(|| corrupt("Settled Host Kernel operation has no settlement JSON"))?;
    let value: Value = serde_json::from_str(settlement_json)
        .map_err(|_| corrupt("Host Kernel operation settlement JSON is corrupt"))?;
    reject_host_private_persistence_fields(&value)?;
    let digest = canonical_sha256(&value)?;
    if operation.settlement_digest.as_deref() != Some(digest.as_str()) {
        return Err(corrupt(
            "Host Kernel operation settlement failed digest verification",
        ));
    }
    let settlement: HostKernelOperationSettlementV2 = serde_json::from_value(value)
        .map_err(|_| corrupt("Host Kernel operation settlement is not exact v2"))?;
    validate_settlement(&settlement)?;
    positive_u64(operation.operation_sequence, "operationSequence")?;
    operation
        .settled_attempt_id
        .as_ref()
        .ok_or_else(|| corrupt("Settled operation has no attempt identity"))?;
    Ok(HostKernelOperationSettlementReceiptV2 {
        operation_request_id: operation.operation_request_id.clone(),
        settlement,
        settlement_digest: digest,
    })
}

fn verified_settlement_receipt(
    connection: &Connection,
    operation: &StoredOperationV2,
) -> Result<HostKernelOperationSettlementReceiptV2, HostV2StorageError> {
    validate_stored_operation(operation)?;
    let run = stored_run_by_id(connection, operation.run_row_id)?
        .ok_or_else(|| corrupt("Operation references a missing Host Kernel Run"))?;
    let bootstrap = decode_bootstrap_record(&run)?;
    let frame = decode_stored_production_frame(operation)?;
    validate_frame_against_bootstrap(&frame, &bootstrap)?;
    let settled_attempt_id = operation
        .settled_attempt_id
        .as_deref()
        .ok_or_else(|| corrupt("Settled Host Kernel operation has no attempt identity"))?;
    let attempt = stored_attempt_by_id(connection, settled_attempt_id)?
        .ok_or_else(|| corrupt("Settled Host Kernel operation references a missing attempt"))?;
    let attempt = attempt_receipt(operation, attempt)?;
    if attempt.state != HostKernelDispatchAttemptStateV2::Settled {
        return Err(corrupt(
            "Settled Host Kernel operation attempt binding is invalid",
        ));
    }
    let settlement = settlement_receipt(operation)?;
    if matches!(
        &settlement.settlement,
        HostKernelOperationSettlementV2::FailedRecoverable {
            boundary: HostKernelOperationFailureBoundaryV2 {
                disposition: HostKernelFailureDispositionV2::RetrySameRequest,
                ..
            },
            ..
        }
    ) {
        return Err(corrupt(
            "Settled Host Kernel operation contains a non-terminal retrySameRequest directive",
        ));
    }
    match &settlement.settlement {
        HostKernelOperationSettlementV2::Succeeded { response, .. } => {
            let response_digest = canonical_sha256(response)?;
            if attempt.response_digest.as_deref() != Some(response_digest.as_str()) {
                return Err(corrupt(
                    "Successful settlement is not bound to the observed response",
                ));
            }
        }
        HostKernelOperationSettlementV2::FailedRecoverable { .. }
        | HostKernelOperationSettlementV2::FailedTerminal { .. } => {
            validate_failure_settlement_matches_observed_response_record(
                attempt.observed_response.as_ref(),
                &settlement.settlement,
            )?;
        }
    }
    Ok(settlement)
}

fn decode_caller_request_binding(
    stored: StoredCallerRequestV2,
    expected_kind: &str,
    expected_request_digest: &str,
    replayed: bool,
) -> Result<HostCallerRequestBindingReceiptV2, HostV2StorageError> {
    if stored.schema_version != CALLER_REQUEST_SCHEMA_V2 {
        return Err(corrupt("Host caller request row schema is not exact v2"));
    }
    validate_caller_request_identity(
        &stored.session_id,
        &stored.caller_request_id,
        &stored.request_kind,
        &stored.request_digest,
    )?;
    validate_bounded_identity(&stored.recorded_at, "recordedAt", 1024)?;
    if stored.request_kind != expected_kind || stored.request_digest != expected_request_digest {
        return Err(HostV2StorageError::conflict(
            "host_caller_request_conflict",
            "Host caller request identity is permanently bound to different content",
        ));
    }
    let response_identity: Value = serde_json::from_str(&stored.response_identity_json)
        .map_err(|_| corrupt("Host caller response identity JSON is corrupt"))?;
    reject_transport_capabilities(&response_identity)?;
    validate_sha256_digest(&stored.response_identity_digest, "responseIdentityDigest")?;
    if canonical_sha256(&response_identity)? != stored.response_identity_digest {
        return Err(corrupt(
            "Host caller response identity failed digest verification",
        ));
    }
    let drive_state = match stored.drive_state.as_str() {
        "Bound" => HostCallerRequestDriveStateV2::Bound,
        "Driving" => HostCallerRequestDriveStateV2::Driving,
        _ => return Err(corrupt("Host caller request has an invalid drive state")),
    };
    match (
        drive_state,
        stored.drive_owner_instance_id.as_deref(),
        stored.drive_started_at.as_deref(),
    ) {
        (HostCallerRequestDriveStateV2::Bound, None, None) => {}
        (HostCallerRequestDriveStateV2::Driving, Some(owner), Some(started_at)) => {
            validate_bounded_identity(owner, "driveOwnerInstanceId", 256)?;
            validate_bounded_identity(started_at, "driveStartedAt", 1024)?;
        }
        _ => return Err(corrupt("Host caller request drive fields are partial")),
    }
    let (admission, admission_digest, admitted_at) = match (
        stored.admission_json,
        stored.admission_digest,
        stored.admitted_at,
    ) {
        (None, None, None) => (None, None, None),
        (Some(admission_json), Some(admission_digest), Some(admitted_at)) => {
            validate_sha256_digest(&admission_digest, "admissionDigest")?;
            validate_bounded_identity(&admitted_at, "admittedAt", 1024)?;
            let admission: Value = serde_json::from_str(&admission_json)
                .map_err(|_| corrupt("Host caller request admission JSON is corrupt"))?;
            reject_transport_capabilities(&admission)?;
            if canonical_sha256(&admission)? != admission_digest {
                return Err(corrupt(
                    "Host caller request admission failed digest verification",
                ));
            }
            (Some(admission), Some(admission_digest), Some(admitted_at))
        }
        _ => return Err(corrupt("Host caller request admission fields are partial")),
    };
    if admission.is_some() && drive_state != HostCallerRequestDriveStateV2::Driving {
        return Err(corrupt(
            "Host caller request admission is not bound to a live drive",
        ));
    }
    let (outcome, outcome_digest) = match (
        stored.outcome_json,
        stored.outcome_digest,
        stored.settled_at,
    ) {
        (None, None, None) => (None, None),
        (Some(outcome_json), Some(outcome_digest), Some(settled_at)) => {
            validate_sha256_digest(&outcome_digest, "outcomeDigest")?;
            validate_bounded_identity(&settled_at, "settledAt", 1024)?;
            let outcome: Value = serde_json::from_str(&outcome_json)
                .map_err(|_| corrupt("Host caller request outcome JSON is corrupt"))?;
            reject_transport_capabilities(&outcome)?;
            if canonical_sha256(&outcome)? != outcome_digest {
                return Err(corrupt(
                    "Host caller request outcome failed digest verification",
                ));
            }
            (Some(outcome), Some(outcome_digest))
        }
        _ => return Err(corrupt("Host caller request settlement fields are partial")),
    };
    Ok(HostCallerRequestBindingReceiptV2 {
        session_id: stored.session_id,
        caller_request_id: stored.caller_request_id,
        request_kind: stored.request_kind,
        request_digest: stored.request_digest,
        response_identity,
        recorded_at: stored.recorded_at,
        drive_state,
        drive_owner_instance_id: stored.drive_owner_instance_id,
        drive_started_at: stored.drive_started_at,
        admission,
        admission_digest,
        admitted_at,
        outcome,
        outcome_digest,
        replayed,
    })
}

fn decode_opening_record(
    stored: &StoredRunV2,
) -> Result<HostKernelRunOpeningRecordV2, HostV2StorageError> {
    if stored.schema_version != RUN_ROW_SCHEMA_V2 {
        return Err(corrupt("Host Kernel Run row schema is not exact v2"));
    }
    let session_bootstrap_value: Value = serde_json::from_str(&stored.initial_input_json)
        .map_err(|_| corrupt("Host Kernel Session bootstrap JSON is corrupt"))?;
    require_supported_prior_events_schema(&session_bootstrap_value)?;
    let lifecycle = parse_run_lifecycle(&stored.lifecycle)?;
    let envelope_value: Value = serde_json::from_str(&stored.run_open_envelope_json)
        .map_err(|_| corrupt("Host Kernel RunOpen envelope JSON is corrupt"))?;
    reject_host_private_persistence_fields(&envelope_value)?;
    if canonical_sha256(&envelope_value)? != stored.run_open_envelope_digest {
        return Err(corrupt(
            "Host Kernel RunOpen envelope failed digest verification",
        ));
    }
    let run_open_envelope: KernelCommandEnvelopeV2 = serde_json::from_value(envelope_value)
        .map_err(|_| corrupt("Host Kernel RunOpen envelope is not strict v2"))?;
    let settings_value: Value = serde_json::from_str(&stored.run_settings_json)
        .map_err(|_| corrupt("Host Kernel Settings JSON is corrupt"))?;
    let run_settings: HostRunSettingsCeilingV2 = serde_json::from_value(settings_value.clone())
        .map_err(|_| corrupt("Host Kernel Settings ceiling is not exact v2"))?;
    reject_host_private_persistence_fields(&session_bootstrap_value)?;
    let session_bootstrap: HostKernelSessionBootstrapMaterialV2 =
        serde_json::from_value(session_bootstrap_value)
            .map_err(|_| corrupt("Host Kernel Session bootstrap is not exact v2"))?;
    if session_bootstrap.schema_version != SESSION_BOOTSTRAP_MATERIAL_SCHEMA_V2 {
        return Err(corrupt(
            "Host Kernel Session bootstrap schema is unsupported",
        ));
    }
    session_bootstrap
        .provider_profile
        .validate()
        .map_err(|_| corrupt("Host Kernel Provider profile bootstrap is not exact v2"))?;
    session_bootstrap
        .prior_session_events
        .validate(&stored.session_id)
        .map_err(|error| {
            if error.code == "unsupported_history_schema" {
                error
            } else {
                corrupt("Host Kernel prior Session events are not exact v2")
            }
        })?;
    let initial_input = session_bootstrap.initial_input;
    let workspace_kind = parse_workspace_kind(&stored.workspace_kind)?;
    validate_workspace_shape(
        workspace_kind,
        stored.empty_workspace_key.as_deref(),
        &run_settings,
    )?;
    if stored.provider_profile_id.as_deref()
        != Some(
            session_bootstrap
                .provider_profile
                .provider_profile_id
                .as_str(),
        )
        || stored.provider_revision_digest.as_deref()
            != Some(
                session_bootstrap
                    .provider_profile
                    .provider_profile_revision_digest
                    .as_str(),
            )
    {
        return Err(corrupt(
            "Host Kernel Provider profile columns conflict with bootstrap material",
        ));
    }
    let workspace_canonical_root = match lifecycle {
        HostKernelStoredRunLifecycleV2::Opening | HostKernelStoredRunLifecycleV2::Active => {
            let root = stored.workspace_canonical_root.as_deref().ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_kernel_workspace_recovery_material_missing",
                    "UnsupportedHistorySchema: live Host Kernel Run has no Host-only workspace recovery root",
                )
            })?;
            let root = PathBuf::from(root);
            canonical_workspace_root_text(&root)?;
            Some(root)
        }
        HostKernelStoredRunLifecycleV2::Retired => {
            if stored.workspace_canonical_root.is_some() {
                return Err(corrupt(
                    "Retired Host Kernel Run retained a recoverable workspace root",
                ));
            }
            None
        }
    };
    let candidate = HostKernelRunOpeningInputV2 {
        session_id: stored.session_id.clone(),
        host_run_id: stored.host_run_id.clone(),
        drive_caller_request_id: stored.opening_caller_request_id.clone(),
        drive_request_digest: stored.opening_request_digest.clone(),
        run_open_request_id: stored.run_open_request_id.clone(),
        run_open_envelope: run_open_envelope.clone(),
        workspace_binding_identity: stored.workspace_binding_identity.clone(),
        workspace_canonical_root: workspace_canonical_root.clone().unwrap_or_default(),
        workspace_kind,
        active_folder_id: session_bootstrap.active_folder_id.clone(),
        empty_workspace_key: stored.empty_workspace_key.clone(),
        run_settings: run_settings.clone(),
        provider_profile: session_bootstrap.provider_profile.clone(),
        prior_session_events: session_bootstrap.prior_session_events.clone(),
        initial_input: initial_input.clone(),
        opening_recorded_at: stored.opening_recorded_at.clone(),
    };
    let (candidate_opening_digest, candidate_workspace_binding_ref) =
        if lifecycle == HostKernelStoredRunLifecycleV2::Retired {
            (
                opening_digest(
                    &candidate,
                    &stored.workspace_binding_ref,
                    &stored.run_open_envelope_digest,
                    &settings_value,
                )?,
                stored.workspace_binding_ref.clone(),
            )
        } else {
            let prepared = PreparedOpeningV2::new(candidate)?;
            (prepared.opening_digest, prepared.workspace_binding_ref)
        };
    if candidate_opening_digest != stored.opening_digest
        || candidate_workspace_binding_ref != stored.workspace_binding_ref
    {
        return Err(corrupt(
            "Host Kernel Opening row failed immutable digest verification",
        ));
    }
    match lifecycle {
        HostKernelStoredRunLifecycleV2::Opening
            if stored.run_id.is_some()
                || stored.bootstrap_digest.is_some()
                || stored.retired_at.is_some() =>
        {
            return Err(corrupt("Opening Host Kernel Run has active fields"))
        }
        HostKernelStoredRunLifecycleV2::Active
            if stored.run_id.is_none()
                || stored.run_open_reply_json.is_none()
                || stored.bootstrap_digest.is_none()
                || stored.activated_at.is_none()
                || stored.retired_at.is_some() =>
        {
            return Err(corrupt("Active Host Kernel Run is incomplete"))
        }
        HostKernelStoredRunLifecycleV2::Retired if stored.retired_at.is_none() => {
            return Err(corrupt("Retired Host Kernel Run has no retirement time"))
        }
        _ => {}
    }
    validate_bounded_identity(
        &stored.opening_caller_request_id,
        "openingCallerRequestId",
        512,
    )?;
    validate_sha256_digest(&stored.opening_request_digest, "openingRequestDigest")?;
    match (
        stored.drive_caller_request_id.as_deref(),
        stored.drive_request_digest.as_deref(),
    ) {
        (None, None) => {}
        (Some(caller_request_id), Some(request_digest)) => {
            validate_bounded_identity(caller_request_id, "driveCallerRequestId", 512)?;
            validate_sha256_digest(request_digest, "driveRequestDigest")?;
        }
        _ => return Err(corrupt("Host Kernel Run drive correlation is partial")),
    }
    if lifecycle == HostKernelStoredRunLifecycleV2::Opening
        && (stored.drive_caller_request_id.as_deref()
            != Some(stored.opening_caller_request_id.as_str())
            || stored.drive_request_digest.as_deref()
                != Some(stored.opening_request_digest.as_str()))
    {
        return Err(corrupt(
            "Opening Host Kernel Run lost its immutable caller drive correlation",
        ));
    }
    match (
        stored.retirement_caller_request_id.as_deref(),
        stored.retirement_request_digest.as_deref(),
    ) {
        (None, None) => {}
        (Some(caller_request_id), Some(request_digest))
            if lifecycle == HostKernelStoredRunLifecycleV2::Retired =>
        {
            validate_bounded_identity(caller_request_id, "retirementCallerRequestId", 512)?;
            validate_sha256_digest(request_digest, "retirementRequestDigest")?;
        }
        _ => {
            return Err(corrupt(
                "Host Kernel Run retirement caller correlation is partial or non-retired",
            ))
        }
    }
    Ok(HostKernelRunOpeningRecordV2 {
        lifecycle,
        session_id: stored.session_id.clone(),
        host_run_id: stored.host_run_id.clone(),
        run_open_request_id: stored.run_open_request_id.clone(),
        run_open_envelope,
        workspace_binding_ref: stored.workspace_binding_ref.clone(),
        workspace_binding_identity: stored.workspace_binding_identity.clone(),
        workspace_canonical_root,
        workspace_kind,
        active_folder_id: session_bootstrap.active_folder_id,
        empty_workspace_key: stored.empty_workspace_key.clone(),
        run_settings,
        provider_profile: session_bootstrap.provider_profile,
        prior_session_events: session_bootstrap.prior_session_events,
        initial_input,
        opening_recorded_at: stored.opening_recorded_at.clone(),
        opening_digest: stored.opening_digest.clone(),
    })
}

fn require_supported_prior_events_schema(
    session_bootstrap_value: &Value,
) -> Result<(), HostV2StorageError> {
    if session_bootstrap_value
        .get("priorSessionEvents")
        .and_then(|value| value.get("schemaVersion"))
        .and_then(Value::as_str)
        == Some(HOST_SESSION_PRIOR_EVENTS_SCHEMA_V3)
    {
        Ok(())
    } else {
        Err(HostV2StorageError::invalid(
            "unsupported_history_schema",
            "UnsupportedHistorySchema: Host Kernel prior Session events use an unsupported schema",
        ))
    }
}

fn decode_bootstrap_record(
    stored: &StoredRunV2,
) -> Result<HostKernelBootstrapRecordV2, HostV2StorageError> {
    let opening = decode_opening_record(stored)?;
    if opening.lifecycle != HostKernelStoredRunLifecycleV2::Active
        && opening.lifecycle != HostKernelStoredRunLifecycleV2::Retired
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_bootstrap_not_active",
            "Opening Host Kernel Run has no activated bootstrap",
        ));
    }
    if opening.lifecycle == HostKernelStoredRunLifecycleV2::Retired && stored.run_id.is_none() {
        return Err(HostV2StorageError::conflict(
            "host_kernel_bootstrap_never_activated",
            "Abandoned Opening has no activated Host Kernel bootstrap",
        ));
    }
    let reply_json = stored
        .run_open_reply_json
        .as_ref()
        .ok_or_else(|| corrupt("Activated Host Kernel Run has no RunOpen reply"))?;
    let reply_value: Value = serde_json::from_str(reply_json)
        .map_err(|_| corrupt("Host Kernel RunOpen reply JSON is corrupt"))?;
    reject_host_private_persistence_fields(&reply_value)?;
    let reply: RunOpenReplyV2 = serde_json::from_value(reply_value)
        .map_err(|_| corrupt("Host Kernel RunOpen reply is not strict v2"))?;
    let prepared = PreparedBootstrapV2::new(&opening, &reply)?;
    if stored.run_id.as_deref() != Some(prepared.run_id.as_str())
        || stored.workspace_binding_digest.as_deref()
            != Some(prepared.workspace_binding_digest.as_str())
        || stored.bootstrap_digest.as_deref() != Some(prepared.bootstrap_digest.as_str())
    {
        return Err(corrupt(
            "Host Kernel bootstrap failed immutable digest verification",
        ));
    }
    let activated_at = stored
        .activated_at
        .as_deref()
        .ok_or_else(|| corrupt("Active Host Kernel Run has no activation time"))?;
    validate_bounded_identity(activated_at, "activatedAt", 1024)?;
    Ok(HostKernelBootstrapRecordV2 {
        session_id: opening.session_id,
        host_run_id: opening.host_run_id,
        run_id: prepared.run_id,
        workspace_binding_ref: opening.workspace_binding_ref,
        workspace_binding_digest: prepared.workspace_binding_digest,
        workspace_binding_identity: opening.workspace_binding_identity,
        workspace_canonical_root: opening.workspace_canonical_root,
        workspace_kind: opening.workspace_kind,
        active_folder_id: opening.active_folder_id,
        empty_workspace_key: opening.empty_workspace_key,
        run_settings: opening.run_settings,
        run_open_reply: reply,
        provider_profile: opening.provider_profile,
        prior_session_events: opening.prior_session_events,
        initial_input: opening.initial_input,
        bootstrap_digest: prepared.bootstrap_digest,
    })
}

fn validate_stored_operation(operation: &StoredOperationV2) -> Result<(), HostV2StorageError> {
    if operation.schema_version != OPERATION_ROW_SCHEMA_V2 {
        return Err(corrupt("Host Kernel operation row schema is not exact v2"));
    }
    positive_u64(operation.operation_sequence, "operationSequence")?;
    validate_operation_identity(&operation.operation_request_id)?;
    match (
        operation.caller_request_id.as_deref(),
        operation.caller_request_digest.as_deref(),
    ) {
        (None, None) => {}
        (Some(caller_request_id), Some(request_digest)) => {
            validate_bounded_identity(caller_request_id, "operationCallerRequestId", 512)?;
            validate_sha256_digest(request_digest, "operationCallerRequestDigest")?;
        }
        _ => {
            return Err(corrupt(
                "Host Kernel operation caller correlation is partial",
            ))
        }
    }
    validate_bounded_identity(&operation.run_id, "runId", 512)?;
    validate_bounded_identity(&operation.recorded_at, "recordedAt", 1024)?;
    validate_sha256_digest(&operation.bootstrap_digest, "bootstrapDigest")?;
    validate_sha256_digest(&operation.production_frame_digest, "productionFrameDigest")?;
    let production_frame = decode_stored_production_frame(operation)?;
    validate_production_frame(&production_frame, &operation.operation_request_id)?;
    if canonical_sha256(&production_frame)? != operation.production_frame_digest {
        return Err(corrupt(
            "Host Kernel production frame failed digest verification",
        ));
    }
    if let Some(revision) = &operation.provider_revision_digest {
        validate_sha256_digest(revision, "providerProfileRevisionDigest")?;
    }
    match (
        &operation.settlement_json,
        &operation.settlement_digest,
        &operation.settled_attempt_id,
        &operation.settled_at,
    ) {
        (None, None, None, None) => Ok(()),
        (Some(_), Some(digest), Some(attempt), Some(settled_at)) => {
            validate_sha256_digest(digest, "settlementDigest")?;
            validate_bounded_identity(attempt, "settledAttemptId", 512)?;
            validate_bounded_identity(settled_at, "settledAt", 1024)
        }
        _ => Err(corrupt(
            "Host Kernel operation settlement fields are partial",
        )),
    }
}

fn decode_stored_production_frame(
    operation: &StoredOperationV2,
) -> Result<Value, HostV2StorageError> {
    let value: Value = serde_json::from_str(&operation.production_frame_json)
        .map_err(|_| corrupt("Host Kernel production frame JSON is corrupt"))?;
    reject_host_private_persistence_fields(&value)?;
    Ok(value)
}

fn validate_stored_attempt(attempt: &StoredAttemptV2) -> Result<(), HostV2StorageError> {
    if attempt.schema_version != ATTEMPT_ROW_SCHEMA_V2 {
        return Err(corrupt(
            "Host Kernel dispatch attempt row schema is not exact v2",
        ));
    }
    positive_u64(attempt.attempt_sequence, "attemptSequence")?;
    validate_attempt_id_for_owner(&attempt.attempt_id, &attempt.owner_instance_id)?;
    validate_sha256_digest(&attempt.owner_binding_digest, "ownerBindingDigest")?;
    validate_bounded_identity(&attempt.prepared_at, "preparedAt", 1024)?;
    validate_bounded_identity(&attempt.state_recorded_at, "stateRecordedAt", 1024)?;
    let state = parse_attempt_state(&attempt.state)?;
    if let Some(previous) = &attempt.recovery_of_attempt_id {
        validate_bounded_identity(previous, "recoveryOfAttemptId", 512)?;
        if previous == &attempt.attempt_id {
            return Err(corrupt("Dispatch attempt recovers itself"));
        }
    }
    if let Some(reason) = &attempt.state_reason_code {
        validate_bounded_identity(reason, "stateReasonCode", 512)?;
    }
    let has_response = match (
        &attempt.response_json,
        &attempt.response_digest,
        &attempt.response_observed_at,
    ) {
        (None, None, None) => false,
        (Some(response_json), Some(digest), Some(observed_at)) => {
            let value: Value = serde_json::from_str(response_json)
                .map_err(|_| corrupt("Observed response JSON is corrupt"))?;
            validate_persisted_response(&value)?;
            if canonical_sha256(&value)? != *digest {
                return Err(corrupt("Observed response failed digest verification"));
            }
            validate_bounded_identity(observed_at, "responseObservedAt", 1024)?;
            true
        }
        _ => return Err(corrupt("Dispatch attempt response fields are partial")),
    };
    match state {
        HostKernelDispatchAttemptStateV2::Prepared
        | HostKernelDispatchAttemptStateV2::Committed
            if has_response || attempt.state_reason_code.is_some() =>
        {
            Err(corrupt(
                "Prepared or Committed attempt carries terminal observation fields",
            ))
        }
        HostKernelDispatchAttemptStateV2::Indeterminate
        | HostKernelDispatchAttemptStateV2::Lost
            if has_response || attempt.state_reason_code.is_none() =>
        {
            Err(corrupt(
                "Lost or Indeterminate attempt has invalid evidence fields",
            ))
        }
        HostKernelDispatchAttemptStateV2::ResponseObserved
            if !has_response || attempt.state_reason_code.is_some() =>
        {
            Err(corrupt(
                "ResponseObserved attempt has invalid response evidence",
            ))
        }
        HostKernelDispatchAttemptStateV2::Settled if attempt.state_reason_code.is_some() => {
            Err(corrupt("Settled attempt retains a transient reason code"))
        }
        _ => Ok(()),
    }
}

fn query_startup_cancel_recoveries(
    connection: &Connection,
    active_runs: &[HostKernelBootstrapRecordV2],
) -> Result<Vec<HostKernelStartupCancelRecoveryV2>, HostV2StorageError> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {} FROM host_caller_requests
             WHERE request_kind = ?1
               AND drive_state = 'Driving'
               AND outcome_json IS NULL
             ORDER BY id",
            CALLER_REQUEST_COLUMNS
        ))
        .map_err(|error| database_error("host_kernel_cancel_startup_query_failed", error))?;
    let rows = statement
        .query_map(
            params![HOST_CANCEL_REQUEST_KIND_V2],
            StoredCallerRequestV2::from_row,
        )
        .map_err(|error| database_error("host_kernel_cancel_startup_query_failed", error))?;
    let mut recoveries = Vec::new();
    let mut claimed_runs = HashSet::new();
    for row in rows {
        let stored =
            row.map_err(|error| database_error("host_kernel_cancel_startup_query_failed", error))?;
        let request_digest = stored.request_digest.clone();
        let binding = decode_caller_request_binding(
            stored,
            HOST_CANCEL_REQUEST_KIND_V2,
            &request_digest,
            true,
        )?;
        if binding.drive_state != HostCallerRequestDriveStateV2::Driving
            || binding.outcome.is_some()
        {
            return Err(corrupt(
                "Startup cancellation query returned a non-driving or settled caller request",
            ));
        }
        let identity = exact_object_fields(
            &binding.response_identity,
            &[
                "hostRunId",
                "runId",
                "operationRequestId",
                "cancelOperationId",
            ],
            &[
                "hostRunId",
                "runId",
                "operationRequestId",
                "cancelOperationId",
            ],
            "Host cancellation response identity",
        )?;
        let host_run_id = startup_cancel_identity(identity, "hostRunId")?.to_string();
        let run_id = startup_cancel_identity(identity, "runId")?.to_string();
        let operation_request_id =
            startup_cancel_identity(identity, "operationRequestId")?.to_string();
        let cancel_operation_id =
            startup_cancel_identity(identity, "cancelOperationId")?.to_string();
        if operation_request_id != cancel_operation_id {
            return Err(HostV2StorageError::conflict(
                "host_kernel_cancel_operation_identity_conflict",
                "Durable cancellation operation identities do not match",
            ));
        }
        let Some(bootstrap) = active_runs.iter().find(|bootstrap| {
            bootstrap.session_id == binding.session_id && bootstrap.host_run_id == host_run_id
        }) else {
            // Retired and unsupported-history Runs are already excluded from
            // ordinary startup recovery. Their exact caller outcome remains
            // available to the Agent recovery path.
            continue;
        };
        if bootstrap.run_id != run_id {
            return Err(HostV2StorageError::conflict(
                "host_kernel_cancel_run_identity_conflict",
                "Durable cancellation caller is bound to another Kernel Run",
            ));
        }
        let run_key = (binding.session_id.clone(), host_run_id.clone());
        if !claimed_runs.insert(run_key) {
            return Err(HostV2StorageError::conflict(
                "host_kernel_cancel_startup_ambiguous",
                "More than one unsettled cancellation caller is bound to the same active Run",
            ));
        }
        let run = stored_run_by_session_host(connection, &binding.session_id, &host_run_id)?
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_kernel_cancel_run_not_found",
                    "Startup cancellation is bound to a missing Host Run",
                )
            })?;
        if parse_run_lifecycle(&run.lifecycle)? != HostKernelStoredRunLifecycleV2::Active
            || run.run_id.as_deref() != Some(run_id.as_str())
        {
            return Err(HostV2StorageError::conflict(
                "host_kernel_cancel_run_not_active",
                "Startup cancellation is not bound to the exact active Run",
            ));
        }
        let operation = stored_operation_by_request(connection, &cancel_operation_id)?;
        let (pending_operation, settlement) = match operation {
            Some(operation) => {
                validate_stored_operation(&operation)?;
                if operation.run_row_id != run.id
                    || operation.run_id != run_id
                    || operation.caller_request_id.as_deref()
                        != Some(binding.caller_request_id.as_str())
                    || operation.caller_request_digest.as_deref()
                        != Some(binding.request_digest.as_str())
                {
                    return Err(HostV2StorageError::conflict(
                        "host_kernel_cancel_operation_correlation_conflict",
                        "Startup cancellation operation changed its exact Run or caller correlation",
                    ));
                }
                let production_frame = decode_stored_production_frame(&operation)?;
                validate_frame_against_bootstrap(&production_frame, bootstrap)?;
                validate_startup_cancel_operation_frame(
                    &production_frame,
                    &binding,
                    &cancel_operation_id,
                )?;
                if operation.settlement_digest.is_some() {
                    (
                        None,
                        Some(verified_settlement_receipt(connection, &operation)?),
                    )
                } else {
                    let latest_attempt = latest_attempt(connection, operation.id)?
                        .map(|attempt| attempt_receipt(&operation, attempt))
                        .transpose()?;
                    (
                        Some(HostKernelPendingOperationV2 {
                            session_id: binding.session_id.clone(),
                            host_run_id: host_run_id.clone(),
                            run_id: run_id.clone(),
                            bootstrap_digest: bootstrap.bootstrap_digest.clone(),
                            operation_sequence: positive_u64(
                                operation.operation_sequence,
                                "operationSequence",
                            )?,
                            operation_request_id: cancel_operation_id.clone(),
                            production_frame,
                            latest_attempt,
                        }),
                        None,
                    )
                }
            }
            None => (None, None),
        };
        recoveries.push(HostKernelStartupCancelRecoveryV2 {
            bootstrap: bootstrap.clone(),
            binding,
            cancel_operation_id,
            pending_operation,
            settlement,
        });
    }
    Ok(recoveries)
}

fn startup_cancel_identity<'a>(
    identity: &'a serde_json::Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, HostV2StorageError> {
    let value = identity.get(field).and_then(Value::as_str).ok_or_else(|| {
        HostV2StorageError::conflict(
            "host_kernel_cancel_identity_invalid",
            format!("Durable cancellation identity has no exact {field}"),
        )
    })?;
    validate_bounded_identity(value, field, 512)?;
    Ok(value)
}

fn validate_startup_cancel_operation_frame(
    frame: &Value,
    binding: &HostCallerRequestBindingReceiptV2,
    cancel_operation_id: &str,
) -> Result<(), HostV2StorageError> {
    let operation = frame
        .pointer("/request/operation")
        .ok_or_else(|| corrupt("Startup cancellation frame has no operation"))?;
    let operation = exact_object_fields(
        operation,
        &["kind", "data"],
        &["kind", "data"],
        "Startup cancellation operation",
    )?;
    if operation.get("kind").and_then(Value::as_str) != Some("cancelRun") {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_operation_kind_conflict",
            "Caller-correlated startup operation is not cancelRun",
        ));
    }
    let data = exact_object_fields(
        operation
            .get("data")
            .ok_or_else(|| corrupt("Startup cancellation operation has no data"))?,
        &[
            "callerRequestId",
            "callerRequestDigest",
            "cancelOperationId",
        ],
        &[
            "callerRequestId",
            "callerRequestDigest",
            "cancelOperationId",
        ],
        "Startup cancellation operation data",
    )?;
    if data.get("callerRequestId").and_then(Value::as_str)
        != Some(binding.caller_request_id.as_str())
        || data.get("callerRequestDigest").and_then(Value::as_str)
            != Some(binding.request_digest.as_str())
        || data.get("cancelOperationId").and_then(Value::as_str) != Some(cancel_operation_id)
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_cancel_operation_correlation_conflict",
            "Startup cancellation frame changed its exact caller or operation identity",
        ));
    }
    Ok(())
}

fn query_pending_operations_for_run(
    connection: &Connection,
    run: &StoredRunV2,
    after_sequence: i64,
    limit: usize,
) -> Result<Vec<HostKernelPendingOperationV2>, HostV2StorageError> {
    let bootstrap = decode_bootstrap_record(run)?;
    let limit = i64::try_from(limit).map_err(|_| {
        HostV2StorageError::invalid(
            "host_kernel_operation_page_limit_invalid",
            "Pending operation query limit exceeds SQLite range",
        )
    })?;
    let mut statement = connection
        .prepare(
            "SELECT
                o.id, o.schema_version, o.run_row_id, o.operation_sequence,
                o.operation_request_id, o.caller_request_id, o.caller_request_digest,
                o.run_id, o.bootstrap_digest,
                o.provider_revision_digest, o.production_frame_json,
                o.production_frame_digest,
                o.recorded_at, o.settlement_json, o.settlement_digest,
                o.settled_attempt_id, o.settled_at
             FROM host_kernel_operations o
             WHERE o.run_row_id = ?1
               AND o.operation_sequence > ?2
               AND o.settlement_digest IS NULL
             ORDER BY o.operation_sequence
             LIMIT ?3",
        )
        .map_err(|error| database_error("host_kernel_operation_query_failed", error))?;
    let rows = statement
        .query_map(
            params![run.id, after_sequence, limit],
            StoredOperationV2::from_row,
        )
        .map_err(|error| database_error("host_kernel_operation_query_failed", error))?;
    let mut output = Vec::new();
    for row in rows {
        let operation =
            row.map_err(|error| database_error("host_kernel_operation_query_failed", error))?;
        validate_stored_operation(&operation)?;
        let production_frame = decode_stored_production_frame(&operation)?;
        validate_frame_against_bootstrap(&production_frame, &bootstrap)?;
        let latest = latest_attempt(connection, operation.id)?
            .map(|attempt| attempt_receipt(&operation, attempt))
            .transpose()?;
        output.push(HostKernelPendingOperationV2 {
            session_id: run.session_id.clone(),
            host_run_id: run.host_run_id.clone(),
            run_id: operation.run_id.clone(),
            bootstrap_digest: operation.bootstrap_digest.clone(),
            operation_sequence: positive_u64(operation.operation_sequence, "operationSequence")?,
            operation_request_id: operation.operation_request_id,
            production_frame,
            latest_attempt: latest,
        });
    }
    Ok(output)
}

fn stored_caller_request(
    connection: &Connection,
    session_id: &str,
    caller_request_id: &str,
) -> Result<Option<StoredCallerRequestV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM host_caller_requests
                 WHERE session_id = ?1 AND caller_request_id = ?2",
                CALLER_REQUEST_COLUMNS
            ),
            params![session_id, caller_request_id],
            StoredCallerRequestV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_caller_request_query_failed", error))
}

fn stored_run_by_open_request(
    connection: &Connection,
    run_open_request_id: &str,
) -> Result<Option<StoredRunV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM host_kernel_runs WHERE run_open_request_id = ?1",
                RUN_COLUMNS
            ),
            params![run_open_request_id],
            StoredRunV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_kernel_run_query_failed", error))
}

fn stored_run_by_session_host(
    connection: &Connection,
    session_id: &str,
    host_run_id: &str,
) -> Result<Option<StoredRunV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM host_kernel_runs
                 WHERE session_id = ?1 AND host_run_id = ?2",
                RUN_COLUMNS
            ),
            params![session_id, host_run_id],
            StoredRunV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_kernel_run_query_failed", error))
}

fn stored_run_exact(
    connection: &Connection,
    session_id: &str,
    host_run_id: &str,
    run_open_request_id: &str,
) -> Result<Option<StoredRunV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM host_kernel_runs
                 WHERE session_id = ?1 AND host_run_id = ?2
                   AND run_open_request_id = ?3",
                RUN_COLUMNS
            ),
            params![session_id, host_run_id, run_open_request_id],
            StoredRunV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_kernel_run_query_failed", error))
}

fn stored_run_by_id(
    connection: &Connection,
    id: i64,
) -> Result<Option<StoredRunV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!("SELECT {} FROM host_kernel_runs WHERE id = ?1", RUN_COLUMNS),
            params![id],
            StoredRunV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_kernel_run_query_failed", error))
}

fn stored_live_run_for_session(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<StoredRunV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM host_kernel_runs
                 WHERE session_id = ?1 AND lifecycle IN ('Opening', 'Active')",
                RUN_COLUMNS
            ),
            params![session_id],
            StoredRunV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_kernel_run_query_failed", error))
}

fn query_live_runs(connection: &Connection) -> Result<Vec<StoredRunV2>, HostV2StorageError> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {} FROM host_kernel_runs
             WHERE lifecycle IN ('Opening', 'Active')
             ORDER BY id",
            RUN_COLUMNS
        ))
        .map_err(|error| database_error("host_kernel_run_query_failed", error))?;
    let rows = statement
        .query_map([], StoredRunV2::from_row)
        .map_err(|error| database_error("host_kernel_run_query_failed", error))?;
    rows.map(|row| row.map_err(|error| database_error("host_kernel_run_query_failed", error)))
        .collect()
}

fn stored_operation_by_request(
    connection: &Connection,
    operation_request_id: &str,
) -> Result<Option<StoredOperationV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM host_kernel_operations
                 WHERE operation_request_id = ?1",
                OPERATION_COLUMNS
            ),
            params![operation_request_id],
            StoredOperationV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_kernel_operation_query_failed", error))
}

fn stored_operation_by_id(
    connection: &Connection,
    id: i64,
) -> Result<Option<StoredOperationV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM host_kernel_operations WHERE id = ?1",
                OPERATION_COLUMNS
            ),
            params![id],
            StoredOperationV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_kernel_operation_query_failed", error))
}

fn stored_attempt_by_id(
    connection: &Connection,
    attempt_id: &str,
) -> Result<Option<StoredAttemptV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM host_kernel_dispatch_attempts WHERE attempt_id = ?1",
                ATTEMPT_COLUMNS
            ),
            params![attempt_id],
            StoredAttemptV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_kernel_attempt_query_failed", error))
}

fn latest_attempt(
    connection: &Connection,
    operation_row_id: i64,
) -> Result<Option<StoredAttemptV2>, HostV2StorageError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM host_kernel_dispatch_attempts
                 WHERE operation_row_id = ?1
                 ORDER BY attempt_sequence DESC LIMIT 1",
                ATTEMPT_COLUMNS
            ),
            params![operation_row_id],
            StoredAttemptV2::from_row,
        )
        .optional()
        .map_err(|error| database_error("host_kernel_attempt_query_failed", error))
}

fn has_nonlost_newer_attempt(
    connection: &Connection,
    operation_row_id: i64,
    attempt_sequence: i64,
) -> Result<bool, HostV2StorageError> {
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM host_kernel_dispatch_attempts
                WHERE operation_row_id = ?1
                  AND attempt_sequence > ?2
                  AND state != 'Lost'
             )",
            params![operation_row_id, attempt_sequence],
            |row| row.get(0),
        )
        .map_err(|error| database_error("host_kernel_attempt_query_failed", error))
}

const RUN_COLUMNS: &str = "
    id, schema_version, session_id, host_run_id, run_open_request_id,
    lifecycle, run_open_envelope_json, run_open_envelope_digest,
    workspace_binding_ref, workspace_binding_identity, workspace_canonical_root,
    workspace_kind, empty_workspace_key, run_settings_json, provider_profile_id,
    provider_revision_digest, initial_input_json, opening_recorded_at,
    opening_digest, run_id, run_open_reply_json, workspace_binding_digest,
    bootstrap_digest, activated_at, retired_at,
    opening_caller_request_id, opening_request_digest,
    drive_caller_request_id, drive_request_digest,
    retirement_caller_request_id, retirement_request_digest,
    next_operation_sequence
";

const CALLER_REQUEST_COLUMNS: &str = "
    schema_version, session_id, caller_request_id, request_kind,
    request_digest, response_identity_json, response_identity_digest, recorded_at,
    drive_state, drive_owner_instance_id, drive_started_at,
    admission_json, admission_digest, admitted_at,
    outcome_json, outcome_digest, settled_at
";

const OPERATION_COLUMNS: &str = "
    id, schema_version, run_row_id, operation_sequence,
    operation_request_id, caller_request_id, caller_request_digest,
    run_id, bootstrap_digest,
    provider_revision_digest, production_frame_json,
    production_frame_digest, recorded_at,
    settlement_json, settlement_digest, settled_attempt_id, settled_at
";

const ATTEMPT_COLUMNS: &str = "
    id, schema_version, operation_row_id, attempt_sequence, attempt_id,
    owner_instance_id, owner_binding_digest, recovery_of_attempt_id,
    state, prepared_at, state_recorded_at, state_reason_code,
    response_json, response_digest, response_observed_at
";

fn database_error(code: &'static str, error: rusqlite::Error) -> HostV2StorageError {
    HostV2StorageError::io(code, format!("SQLite Host Kernel v2 store: {error}"))
}

fn corrupt(message: impl Into<String>) -> HostV2StorageError {
    HostV2StorageError::conflict("host_kernel_store_corrupt", message)
}

fn positive_u64(value: i64, field: &'static str) -> Result<u64, HostV2StorageError> {
    if value <= 0 {
        return Err(corrupt(format!("{field} is not positive")));
    }
    Ok(value as u64)
}

fn validate_operation_identity(operation_request_id: &str) -> Result<(), HostV2StorageError> {
    validate_bounded_identity(operation_request_id, "operationRequestId", 512)
}

fn create_private_store_directory(path: &Path) -> Result<(), HostV2StorageError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(HostV2StorageError::io(
                "host_kernel_store_directory_invalid",
                "Host Kernel v2 store directory must be a private real directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(HostV2StorageError::io(
                "host_kernel_store_directory_inspect_failed",
                format!("inspect Host Kernel v2 store directory: {error}"),
            ));
        }
    }
    create_private_directory(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        HostV2StorageError::io(
            "host_kernel_store_directory_inspect_failed",
            format!("inspect Host Kernel v2 store directory: {error}"),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(HostV2StorageError::io(
            "host_kernel_store_directory_invalid",
            "Host Kernel v2 store directory must be a private real directory",
        ));
    }
    Ok(())
}

fn create_private_sqlite_file_if_missing(path: &Path) -> Result<(), HostV2StorageError> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path).map_err(|inspect_error| {
                HostV2StorageError::io(
                    "host_kernel_store_inspect_failed",
                    format!("inspect SQLite Host Kernel v2 file: {inspect_error}"),
                )
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(HostV2StorageError::io(
                    "host_kernel_store_file_invalid",
                    "Host Kernel v2 SQLite path must be a private regular file",
                ));
            }
        }
        Err(error) => {
            return Err(HostV2StorageError::io(
                "host_kernel_store_create_failed",
                format!("create private SQLite Host Kernel v2 file: {error}"),
            ));
        }
    }
    secure_sqlite_files(path)
}

fn secure_sqlite_files(path: &Path) -> Result<(), HostV2StorageError> {
    #[cfg(unix)]
    {
        use std::ffi::OsString;
        use std::os::unix::fs::PermissionsExt;
        let sidecar = |suffix: &str| {
            let mut value = OsString::from(path.as_os_str());
            value.push(suffix);
            PathBuf::from(value)
        };
        for (candidate, required) in [
            (path.to_path_buf(), true),
            (sidecar("-wal"), false),
            (sidecar("-shm"), false),
        ] {
            match fs::symlink_metadata(&candidate) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(HostV2StorageError::io(
                        "host_kernel_store_file_invalid",
                        "Host Kernel v2 SQLite files must be private regular files",
                    ));
                }
                Ok(_) => match fs::set_permissions(&candidate, fs::Permissions::from_mode(0o600)) {
                    Ok(()) => {}
                    // SQLite creates and removes WAL/SHM sidecars as
                    // connections overlap. A sidecar may legitimately vanish
                    // between the metadata check and chmod; the primary
                    // database is never optional.
                    Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(HostV2StorageError::io(
                            "host_kernel_store_permissions_failed",
                            format!("secure SQLite Host Kernel v2 file: {error}"),
                        ));
                    }
                },
                Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(HostV2StorageError::io(
                        "host_kernel_store_permissions_failed",
                        format!("inspect SQLite Host Kernel v2 file: {error}"),
                    ))
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
