use crate::host_run_broker_v2::{HostRunSettingsCeilingV2, HostRunWorkspaceKindV2};
use crate::host_v2_storage::{
    canonical_json_bytes, canonical_sha256, create_private_directory,
    reject_transport_capabilities, sha256_path_component, validate_bounded_identity,
    validate_safe_session_identity, validate_sha256_digest, HostV2StorageError,
};
use deepcode_kernel_abi::v2_command::{KernelCommandEnvelopeV2, KernelCommandV2, RunOpenReplyV2};
use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STORE_SCHEMA_V2: &str = "deepcode.host.kernel-durable-store.v2";
const RUN_ROW_SCHEMA_V2: &str = "deepcode.host.kernel-run.v2";
const BOOTSTRAP_SCHEMA_V2: &str = "deepcode.host.kernel-run-bootstrap.v2";
const OPERATION_ROW_SCHEMA_V2: &str = "deepcode.host.kernel-operation.v2";
const ATTEMPT_ROW_SCHEMA_V2: &str = "deepcode.host.kernel-dispatch-attempt.v2";
const HISTORY_SCHEMA_V2: &str = "deepcode.session.kernel-persistence.v2";
const PRODUCTION_FRAME_SCHEMA_V2: &str = "deepcode.session.kernel-production-request-frame.v2";
const PRODUCTION_REQUEST_SCHEMA_V2: &str = "deepcode.session.kernel-production-request.v2";
const PREFETCHED_RUN_SCHEMA_V2: &str = "deepcode.session.prefetched-kernel-run.v2";
const SQLITE_USER_VERSION_V2: i64 = 2;

const MAX_BOOTSTRAP_BYTES: usize = 8 * 1024 * 1024;
const MAX_INITIAL_INPUT_BYTES: usize = 1024 * 1024;
const MAX_OPERATION_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_RUN_ROWS: i64 = 16_384;
const MAX_OPERATION_ROWS: i64 = 131_072;
const MAX_ATTEMPT_ROWS: i64 = 262_144;
const MAX_OPERATION_PAGE_ITEMS: usize = 4_096;
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
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelRunOpeningInputV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_open_request_id: String,
    pub(crate) run_open_envelope: KernelCommandEnvelopeV2,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
    pub(crate) provider_profile_id: Option<String>,
    pub(crate) provider_profile_revision_digest: Option<String>,
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
    pub(crate) schema_version: String,
    pub(crate) history_schema: String,
    pub(crate) lifecycle: HostKernelStoredRunLifecycleV2,
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_open_request_id: String,
    pub(crate) run_open_envelope: KernelCommandEnvelopeV2,
    pub(crate) run_open_envelope_digest: String,
    pub(crate) workspace_binding_ref: String,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
    pub(crate) provider_profile_id: Option<String>,
    pub(crate) provider_profile_revision_digest: Option<String>,
    pub(crate) initial_input: HostKernelBootstrapInitialInputV2,
    pub(crate) opening_recorded_at: String,
    pub(crate) opening_digest: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelRunOpeningReceiptV2 {
    pub(crate) record: HostKernelRunOpeningRecordV2,
    pub(crate) replayed: bool,
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
    pub(crate) schema_version: String,
    pub(crate) history_schema: String,
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_open_request_id: String,
    pub(crate) run_id: String,
    pub(crate) workspace_binding_ref: String,
    pub(crate) workspace_binding_digest: String,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
    pub(crate) run_open_reply: RunOpenReplyV2,
    pub(crate) provider_profile_id: Option<String>,
    pub(crate) provider_profile_revision_digest: Option<String>,
    pub(crate) initial_input: HostKernelBootstrapInitialInputV2,
    pub(crate) opening_digest: String,
    pub(crate) bootstrap_digest: String,
    pub(crate) activated_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelBootstrapReceiptV2 {
    pub(crate) record: HostKernelBootstrapRecordV2,
    pub(crate) replayed: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelOperationPreparedV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) bootstrap_digest: String,
    pub(crate) provider_profile_revision_digest: Option<String>,
    pub(crate) operation_request_id: String,
    /// The complete production frame is a strict safe DTO. Host transport and
    /// process launch details are rejected before it becomes durable.
    pub(crate) production_frame: Value,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelPreparedOperationReceiptV2 {
    pub(crate) operation_sequence: u64,
    pub(crate) operation_request_id: String,
    pub(crate) production_frame: Value,
    pub(crate) production_frame_digest: String,
    pub(crate) recorded_at: String,
    pub(crate) replayed: bool,
}

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
    pub(crate) operation_sequence: u64,
    pub(crate) attempt_sequence: u64,
    pub(crate) operation_request_id: String,
    pub(crate) attempt_id: String,
    pub(crate) owner_instance_id: String,
    pub(crate) owner_binding_digest: String,
    pub(crate) state: HostKernelDispatchAttemptStateV2,
    pub(crate) recovery_of_attempt_id: Option<String>,
    pub(crate) observed_response: Option<Value>,
    pub(crate) response_digest: Option<String>,
    pub(crate) response_observed_at: Option<String>,
    pub(crate) replayed: bool,
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
    },
    FailedTerminal {
        error_code: String,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelPendingOperationV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) bootstrap_digest: String,
    pub(crate) provider_profile_revision_digest: Option<String>,
    pub(crate) operation_sequence: u64,
    pub(crate) operation_request_id: String,
    pub(crate) production_frame: Value,
    pub(crate) production_frame_digest: String,
    pub(crate) recorded_at: String,
    pub(crate) latest_attempt: Option<HostKernelDispatchAttemptReceiptV2>,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelPendingOperationPageV2 {
    pub(crate) operations: Vec<HostKernelPendingOperationV2>,
    pub(crate) high_water_operation_sequence: u64,
    pub(crate) has_more: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelOperationSettlementReceiptV2 {
    pub(crate) operation_sequence: u64,
    pub(crate) operation_request_id: String,
    pub(crate) attempt_id: String,
    pub(crate) settlement: HostKernelOperationSettlementV2,
    pub(crate) settlement_digest: String,
    pub(crate) replayed: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelStartupReconciliationV2 {
    pub(crate) opening_runs: Vec<HostKernelRunOpeningRecordV2>,
    pub(crate) active_runs: Vec<HostKernelBootstrapRecordV2>,
    pub(crate) pending_operations: Vec<HostKernelPendingOperationV2>,
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
                    return Ok(HostKernelRunOpeningReceiptV2 {
                        record,
                        replayed: true,
                    });
                }
                return Err(HostV2StorageError::conflict(
                    "host_kernel_run_open_request_conflict",
                    "RunOpen request identity is permanently bound to different durable content",
                ));
            }
            if stored_live_run_for_session(transaction, &prepared.session_id)?.is_some() {
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
                        workspace_binding_ref, workspace_binding_identity, workspace_kind,
                        empty_workspace_key, run_settings_json, provider_profile_id,
                        provider_revision_digest, initial_input_json, opening_recorded_at,
                        opening_digest
                     ) VALUES (
                        ?1, ?2, ?3, ?4, 'Opening', ?5, ?6, ?7, ?8, ?9, ?10,
                        ?11, ?12, ?13, ?14, ?15, ?16
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
                        workspace_kind_text(prepared.workspace_kind),
                        prepared.empty_workspace_key,
                        prepared.run_settings_json,
                        prepared.provider_profile_id,
                        prepared.provider_profile_revision_digest,
                        prepared.initial_input_json,
                        prepared.opening_recorded_at,
                        prepared.opening_digest,
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
                replayed: false,
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
                        replayed: false,
                    })
                }
                HostKernelStoredRunLifecycleV2::Active => {
                    if stored.bootstrap_digest.as_deref()
                        == Some(prepared.bootstrap_digest.as_str())
                    {
                        return Ok(HostKernelBootstrapReceiptV2 {
                            record: decode_bootstrap_record(&stored)?,
                            replayed: true,
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
                             SET lifecycle = 'Retired', retired_at = ?1
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
                    transaction
                        .execute(
                            "UPDATE host_kernel_runs
                             SET lifecycle = 'Retired', retired_at = ?1
                             WHERE id = ?2 AND lifecycle = 'Active'",
                            params![retired_at, stored.id],
                        )
                        .map_err(|error| {
                            database_error("host_kernel_run_retirement_failed", error)
                        })?;
                    Ok(false)
                }
                HostKernelStoredRunLifecycleV2::Retired => Ok(true),
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
            if let Some(existing) =
                stored_operation_by_request(transaction, &prepared.operation_request_id)?
            {
                if existing.run_row_id == run.id
                    && existing.production_frame_digest == prepared.production_frame_digest
                    && existing.run_id == prepared.run_id
                    && existing.bootstrap_digest == prepared.bootstrap_digest
                    && existing.provider_revision_digest
                        == prepared.provider_profile_revision_digest
                {
                    validate_stored_operation(&existing)?;
                    let production_frame = decode_stored_production_frame(&existing)?;
                    return Ok(HostKernelPreparedOperationReceiptV2 {
                        operation_sequence: positive_u64(
                            existing.operation_sequence,
                            "operationSequence",
                        )?,
                        operation_request_id: existing.operation_request_id,
                        production_frame,
                        production_frame_digest: existing.production_frame_digest,
                        recorded_at: existing.recorded_at,
                        replayed: true,
                    });
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
                        operation_request_id, run_id, bootstrap_digest,
                        provider_revision_digest, production_frame_json,
                        production_frame_digest, recorded_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        OPERATION_ROW_SCHEMA_V2,
                        run.id,
                        next_sequence,
                        prepared.operation_request_id,
                        prepared.run_id,
                        prepared.bootstrap_digest,
                        prepared.provider_profile_revision_digest,
                        prepared.production_frame_json,
                        prepared.production_frame_digest,
                        prepared.recorded_at,
                    ],
                )
                .map_err(|error| database_error("host_kernel_operation_prepare_failed", error))?;
            Ok(HostKernelPreparedOperationReceiptV2 {
                operation_sequence: positive_u64(next_sequence, "operationSequence")?,
                operation_request_id: prepared.operation_request_id,
                production_frame: prepared.production_frame,
                production_frame_digest: prepared.production_frame_digest,
                recorded_at: prepared.recorded_at,
                replayed: false,
            })
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
                return Err(HostV2StorageError::conflict(
                    match parse_attempt_state(&latest.state)? {
                        HostKernelDispatchAttemptStateV2::Lost
                        | HostKernelDispatchAttemptStateV2::Indeterminate => {
                            "host_kernel_dispatch_recovery_required"
                        }
                        _ => "host_kernel_dispatch_attempt_already_exists",
                    },
                    "Operation already has a dispatch attempt; a new attempt requires the explicit recovery API",
                ));
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
                    "Dispatch recovery requires an existing Lost or Indeterminate attempt",
                )
            })?;
            if latest.attempt_id != input.previous_attempt_id
                || !matches!(
                    parse_attempt_state(&latest.state)?,
                    HostKernelDispatchAttemptStateV2::Lost
                        | HostKernelDispatchAttemptStateV2::Indeterminate
                )
            {
                return Err(HostV2StorageError::conflict(
                    "host_kernel_dispatch_recovery_not_allowed",
                    "Only the latest Lost or Indeterminate attempt can be recovered",
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
                        false,
                    )
                }
                HostKernelDispatchAttemptStateV2::Committed
                | HostKernelDispatchAttemptStateV2::ResponseObserved
                | HostKernelDispatchAttemptStateV2::Settled => {
                    attempt_receipt(&stored_operation, attempt, true)
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
                        false,
                    )
                }
                HostKernelDispatchAttemptStateV2::Lost
                    if attempt.state_reason_code.as_deref() == Some(reason_code) =>
                {
                    attempt_receipt(&stored_operation, attempt, true)
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
                        false,
                    )
                }
                HostKernelDispatchAttemptStateV2::Indeterminate
                    if attempt.state_reason_code.as_deref() == Some(reason_code) =>
                {
                    attempt_receipt(&stored_operation, attempt, true)
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
                        false,
                    )
                }
                HostKernelDispatchAttemptStateV2::ResponseObserved
                | HostKernelDispatchAttemptStateV2::Settled
                    if attempt.response_digest.as_deref() == Some(response_digest.as_str()) =>
                {
                    attempt_receipt(&stored_operation, attempt, true)
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
                    return settlement_receipt(&stored_operation, true);
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
                    HostKernelDispatchAttemptStateV2::ResponseObserved
                    | HostKernelDispatchAttemptStateV2::Lost,
                ) => {}
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
            settlement_receipt(&settled, false)
        })
    }

    pub(crate) fn pending_operations(
        &self,
        session_id: &str,
        host_run_id: &str,
        after_operation_sequence: u64,
        limit: usize,
    ) -> Result<HostKernelPendingOperationPageV2, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        if limit == 0 || limit > MAX_OPERATION_PAGE_ITEMS {
            return Err(HostV2StorageError::invalid(
                "host_kernel_operation_page_limit_invalid",
                "Pending operation page limit is outside the v2 bound",
            ));
        }
        let after = i64::try_from(after_operation_sequence).map_err(|_| {
            HostV2StorageError::invalid(
                "host_kernel_operation_sequence_invalid",
                "afterOperationSequence exceeds the SQLite v2 range",
            )
        })?;
        self.with_connection(|connection| {
            let run = stored_run_by_session_host(connection, session_id, host_run_id)?.ok_or_else(
                || {
                    HostV2StorageError::not_found(
                        "host_kernel_run_not_found",
                        "Host Kernel Run was not found",
                    )
                },
            )?;
            let mut operations =
                query_pending_operations_for_run(connection, &run, after, limit + 1)?;
            let has_more = operations.len() > limit;
            operations.truncate(limit);
            Ok(HostKernelPendingOperationPageV2 {
                operations,
                high_water_operation_sequence: nonnegative_u64(
                    run.next_operation_sequence,
                    "highWaterOperationSequence",
                )?,
                has_more,
            })
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
            Ok(Some(verified_settlement_receipt(
                connection, &operation, true,
            )?))
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
                .map(|operation| verified_settlement_receipt(connection, operation, true))
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
                settlements.push(verified_settlement_receipt(connection, &operation, true)?);
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
    ) -> Result<HostKernelStartupReconciliationV2, HostV2StorageError> {
        validate_bounded_identity(reconciled_at, "reconciledAt", 1024)?;
        self.with_write_transaction(|transaction| {
            let marked = transaction
                .execute(
                    "UPDATE host_kernel_dispatch_attempts
                     SET state = 'Indeterminate', state_recorded_at = ?1,
                         state_reason_code = 'host_restart_write_outcome_unknown'
                     WHERE state IN ('Prepared', 'Committed')",
                    params![reconciled_at],
                )
                .map_err(|error| {
                    database_error("host_kernel_startup_reconciliation_failed", error)
                })?;

            let stored_runs = query_live_runs(transaction)?;
            let mut opening_runs = Vec::new();
            let mut active_runs = Vec::new();
            for stored in &stored_runs {
                match parse_run_lifecycle(&stored.lifecycle)? {
                    HostKernelStoredRunLifecycleV2::Opening => {
                        opening_runs.push(decode_opening_record(stored)?)
                    }
                    HostKernelStoredRunLifecycleV2::Active => {
                        active_runs.push(decode_bootstrap_record(stored)?)
                    }
                    HostKernelStoredRunLifecycleV2::Retired => {}
                }
            }
            let mut pending_operations = Vec::new();
            for stored in &stored_runs {
                if parse_run_lifecycle(&stored.lifecycle)? == HostKernelStoredRunLifecycleV2::Active
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
                attempts_marked_indeterminate: marked,
            })
        })
    }

    fn database_path(&self) -> PathBuf {
        self.sessions_dir
            .join(".host-v2")
            .join("host-kernel-v2.sqlite3")
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
        let directory = self.sessions_dir.join(".host-v2");
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

struct PreparedOpeningV2 {
    session_id: String,
    host_run_id: String,
    run_open_request_id: String,
    run_open_envelope_json: String,
    run_open_envelope_digest: String,
    workspace_binding_ref: String,
    workspace_binding_identity: String,
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
        let initial_input_value = serde_json::to_value(&input.initial_input).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_initial_input_invalid",
                format!("encode initial input: {error}"),
            )
        })?;
        reject_host_private_persistence_fields(&initial_input_value)?;
        let initial_input_json = canonical_json_string(&initial_input_value)?;
        let durable_opening_bytes = run_open_envelope_json
            .len()
            .checked_add(run_settings_json.len())
            .and_then(|value| value.checked_add(initial_input_json.len()))
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
        let opening_digest = canonical_sha256(&json!({
            "schemaVersion": RUN_ROW_SCHEMA_V2,
            "historySchema": HISTORY_SCHEMA_V2,
            "sessionId": input.session_id,
            "hostRunId": input.host_run_id,
            "runOpenRequestId": input.run_open_request_id,
            "runOpenEnvelopeDigest": run_open_envelope_digest,
            "workspaceBindingRef": workspace_binding_ref,
            "workspaceBindingIdentity": input.workspace_binding_identity,
            "workspaceKind": workspace_kind_text(input.workspace_kind),
            "emptyWorkspaceKey": input.empty_workspace_key,
            "runSettings": run_settings_value,
            "providerProfileId": input.provider_profile_id,
            "providerProfileRevisionDigest": input.provider_profile_revision_digest,
            "initialInput": initial_input_value,
            "openingRecordedAt": input.opening_recorded_at,
        }))?;
        Ok(Self {
            session_id: input.session_id,
            host_run_id: input.host_run_id,
            run_open_request_id: input.run_open_request_id,
            run_open_envelope_json,
            run_open_envelope_digest,
            workspace_binding_ref,
            workspace_binding_identity: input.workspace_binding_identity,
            workspace_kind: input.workspace_kind,
            empty_workspace_key: input.empty_workspace_key,
            run_settings_json,
            provider_profile_id: input.provider_profile_id,
            provider_profile_revision_digest: input.provider_profile_revision_digest,
            initial_input_json,
            opening_recorded_at: input.opening_recorded_at,
            opening_digest,
        })
    }
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
            "historySchema": HISTORY_SCHEMA_V2,
            "openingDigest": opening.opening_digest,
            "runId": run_id,
            "workspaceBindingRef": opening.workspace_binding_ref,
            "workspaceBindingDigest": workspace_binding_digest,
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
            production_frame: input.production_frame,
            production_frame_json,
            production_frame_digest,
            recorded_at: input.recorded_at,
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
                    singleton, run_rows, operation_rows, attempt_rows
                 ) VALUES (1, 0, 0, 0)",
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
        || user_table_count != 5
    {
        return Err(HostV2StorageError::conflict(
            "host_kernel_store_schema_unsupported",
            "Host Kernel durable store schema is not exact v2; migration and compatibility are disabled",
        ));
    }
    for required in [
        "host_store_meta",
        "host_store_limits",
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
    operation_rows INTEGER NOT NULL CHECK (operation_rows >= 0),
    attempt_rows INTEGER NOT NULL CHECK (attempt_rows >= 0)
) STRICT;

CREATE TABLE host_kernel_runs (
    id INTEGER PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = 'deepcode.host.kernel-run.v2'),
    session_id TEXT NOT NULL,
    host_run_id TEXT NOT NULL,
    run_open_request_id TEXT NOT NULL UNIQUE,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('Opening', 'Active', 'Retired')),
    run_open_envelope_json TEXT NOT NULL,
    run_open_envelope_digest TEXT NOT NULL,
    workspace_binding_ref TEXT NOT NULL,
    workspace_binding_identity TEXT NOT NULL,
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
            AND run_id IS NULL
            AND run_open_reply_json IS NULL
            AND workspace_binding_digest IS NULL
            AND bootstrap_digest IS NULL
            AND activated_at IS NULL
            AND retired_at IS NULL)
        OR (lifecycle = 'Active'
            AND run_id IS NOT NULL
            AND run_open_reply_json IS NOT NULL
            AND workspace_binding_digest IS NOT NULL
            AND bootstrap_digest IS NOT NULL
            AND activated_at IS NOT NULL
            AND retired_at IS NULL)
        OR (lifecycle = 'Retired')
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
    validate_provider_pair(
        input.provider_profile_id.as_deref(),
        input.provider_profile_revision_digest.as_deref(),
    )?;
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

fn validate_provider_pair(
    provider_profile_id: Option<&str>,
    provider_revision_digest: Option<&str>,
) -> Result<(), HostV2StorageError> {
    match (provider_profile_id, provider_revision_digest) {
        (Some(profile_id), Some(revision)) => {
            validate_bounded_identity(profile_id, "providerProfileId", 512)?;
            validate_sha256_digest(revision, "providerProfileRevisionDigest")
        }
        (None, None) => Ok(()),
        _ => Err(HostV2StorageError::invalid(
            "host_kernel_provider_profile_incomplete",
            "Provider profile id and revision digest must be present together",
        )),
    }
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
            "prefetchedRun",
            "initialInput",
            "operation",
            "providerProfileId",
        ],
        &[
            "schemaVersion",
            "sessionId",
            "hostRunId",
            "runId",
            "historySchema",
            "prefetchedRun",
            "initialInput",
            "operation",
        ],
        "Production request",
    )?;
    if request.get("schemaVersion").and_then(Value::as_str) != Some(PRODUCTION_REQUEST_SCHEMA_V2)
        || request.get("historySchema").and_then(Value::as_str) != Some(HISTORY_SCHEMA_V2)
        || !request.get("operation").is_some_and(Value::is_object)
        || (request.contains_key("providerProfileId")
            && request
                .get("providerProfileId")
                .and_then(Value::as_str)
                .is_none())
    {
        return Err(HostV2StorageError::invalid(
            "host_kernel_operation_request_invalid",
            "Production request is not the exact safe v2 shape",
        ));
    }
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
    match (
        request.get("providerProfileId").and_then(Value::as_str),
        bootstrap.provider_profile_id.as_deref(),
    ) {
        (None, None) => {}
        (Some(actual), Some(expected)) if actual == expected => {}
        _ => {
            return Err(HostV2StorageError::conflict(
                "host_kernel_operation_provider_binding_conflict",
                "Production frame provider does not match the immutable bootstrap",
            ))
        }
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
        HostKernelOperationSettlementV2::FailedRecoverable { error_code }
        | HostKernelOperationSettlementV2::FailedTerminal { error_code } => {
            validate_bounded_identity(error_code, "errorCode", 512)
        }
    }
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
    attempt_receipt(operation, stored, false)
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
    attempt_receipt(operation, attempt, true)
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
    replayed: bool,
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
    Ok(HostKernelDispatchAttemptReceiptV2 {
        operation_sequence: positive_u64(operation.operation_sequence, "operationSequence")?,
        attempt_sequence: positive_u64(attempt.attempt_sequence, "attemptSequence")?,
        operation_request_id: operation.operation_request_id.clone(),
        attempt_id: attempt.attempt_id,
        owner_instance_id: attempt.owner_instance_id,
        owner_binding_digest: attempt.owner_binding_digest,
        state: parse_attempt_state(&attempt.state)?,
        recovery_of_attempt_id: attempt.recovery_of_attempt_id,
        observed_response,
        response_digest: attempt.response_digest,
        response_observed_at: attempt.response_observed_at,
        replayed,
    })
}

fn settlement_receipt(
    operation: &StoredOperationV2,
    replayed: bool,
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
    Ok(HostKernelOperationSettlementReceiptV2 {
        operation_sequence: positive_u64(operation.operation_sequence, "operationSequence")?,
        operation_request_id: operation.operation_request_id.clone(),
        attempt_id: operation
            .settled_attempt_id
            .clone()
            .ok_or_else(|| corrupt("Settled operation has no attempt identity"))?,
        settlement,
        settlement_digest: digest,
        replayed,
    })
}

fn verified_settlement_receipt(
    connection: &Connection,
    operation: &StoredOperationV2,
    replayed: bool,
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
    let attempt = attempt_receipt(operation, attempt, replayed)?;
    if attempt.state != HostKernelDispatchAttemptStateV2::Settled {
        return Err(corrupt(
            "Settled Host Kernel operation attempt binding is invalid",
        ));
    }
    let settlement = settlement_receipt(operation, replayed)?;
    if let HostKernelOperationSettlementV2::Succeeded { response, .. } = &settlement.settlement {
        let response_digest = canonical_sha256(response)?;
        if attempt.response_digest.as_deref() != Some(response_digest.as_str()) {
            return Err(corrupt(
                "Successful settlement is not bound to the observed response",
            ));
        }
    }
    Ok(settlement)
}

fn decode_opening_record(
    stored: &StoredRunV2,
) -> Result<HostKernelRunOpeningRecordV2, HostV2StorageError> {
    if stored.schema_version != RUN_ROW_SCHEMA_V2 {
        return Err(corrupt("Host Kernel Run row schema is not exact v2"));
    }
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
    let initial_value: Value = serde_json::from_str(&stored.initial_input_json)
        .map_err(|_| corrupt("Host Kernel initial input JSON is corrupt"))?;
    reject_host_private_persistence_fields(&initial_value)?;
    let initial_input: HostKernelBootstrapInitialInputV2 =
        serde_json::from_value(initial_value.clone())
            .map_err(|_| corrupt("Host Kernel initial input is not exact v2"))?;
    let workspace_kind = parse_workspace_kind(&stored.workspace_kind)?;
    validate_workspace_shape(
        workspace_kind,
        stored.empty_workspace_key.as_deref(),
        &run_settings,
    )?;
    validate_provider_pair(
        stored.provider_profile_id.as_deref(),
        stored.provider_revision_digest.as_deref(),
    )?;
    let candidate = HostKernelRunOpeningInputV2 {
        session_id: stored.session_id.clone(),
        host_run_id: stored.host_run_id.clone(),
        run_open_request_id: stored.run_open_request_id.clone(),
        run_open_envelope: run_open_envelope.clone(),
        workspace_binding_identity: stored.workspace_binding_identity.clone(),
        workspace_kind,
        empty_workspace_key: stored.empty_workspace_key.clone(),
        run_settings: run_settings.clone(),
        provider_profile_id: stored.provider_profile_id.clone(),
        provider_profile_revision_digest: stored.provider_revision_digest.clone(),
        initial_input: initial_input.clone(),
        opening_recorded_at: stored.opening_recorded_at.clone(),
    };
    let prepared = PreparedOpeningV2::new(candidate)?;
    if prepared.opening_digest != stored.opening_digest
        || prepared.workspace_binding_ref != stored.workspace_binding_ref
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
    Ok(HostKernelRunOpeningRecordV2 {
        schema_version: RUN_ROW_SCHEMA_V2.to_string(),
        history_schema: HISTORY_SCHEMA_V2.to_string(),
        lifecycle,
        session_id: stored.session_id.clone(),
        host_run_id: stored.host_run_id.clone(),
        run_open_request_id: stored.run_open_request_id.clone(),
        run_open_envelope,
        run_open_envelope_digest: stored.run_open_envelope_digest.clone(),
        workspace_binding_ref: stored.workspace_binding_ref.clone(),
        workspace_binding_identity: stored.workspace_binding_identity.clone(),
        workspace_kind,
        empty_workspace_key: stored.empty_workspace_key.clone(),
        run_settings,
        provider_profile_id: stored.provider_profile_id.clone(),
        provider_profile_revision_digest: stored.provider_revision_digest.clone(),
        initial_input,
        opening_recorded_at: stored.opening_recorded_at.clone(),
        opening_digest: stored.opening_digest.clone(),
    })
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
    Ok(HostKernelBootstrapRecordV2 {
        schema_version: BOOTSTRAP_SCHEMA_V2.to_string(),
        history_schema: HISTORY_SCHEMA_V2.to_string(),
        session_id: opening.session_id,
        host_run_id: opening.host_run_id,
        run_open_request_id: opening.run_open_request_id,
        run_id: prepared.run_id,
        workspace_binding_ref: opening.workspace_binding_ref,
        workspace_binding_digest: prepared.workspace_binding_digest,
        workspace_binding_identity: opening.workspace_binding_identity,
        workspace_kind: opening.workspace_kind,
        empty_workspace_key: opening.empty_workspace_key,
        run_settings: opening.run_settings,
        run_open_reply: reply,
        provider_profile_id: opening.provider_profile_id,
        provider_profile_revision_digest: opening.provider_profile_revision_digest,
        initial_input: opening.initial_input,
        opening_digest: opening.opening_digest,
        bootstrap_digest: prepared.bootstrap_digest,
        activated_at: stored
            .activated_at
            .clone()
            .ok_or_else(|| corrupt("Active Host Kernel Run has no activation time"))?,
    })
}

fn validate_stored_operation(operation: &StoredOperationV2) -> Result<(), HostV2StorageError> {
    if operation.schema_version != OPERATION_ROW_SCHEMA_V2 {
        return Err(corrupt("Host Kernel operation row schema is not exact v2"));
    }
    positive_u64(operation.operation_sequence, "operationSequence")?;
    validate_operation_identity(&operation.operation_request_id)?;
    validate_bounded_identity(&operation.run_id, "runId", 512)?;
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
                o.operation_request_id, o.run_id, o.bootstrap_digest,
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
            .map(|attempt| attempt_receipt(&operation, attempt, true))
            .transpose()?;
        output.push(HostKernelPendingOperationV2 {
            session_id: run.session_id.clone(),
            host_run_id: run.host_run_id.clone(),
            run_id: operation.run_id.clone(),
            bootstrap_digest: operation.bootstrap_digest.clone(),
            provider_profile_revision_digest: operation.provider_revision_digest.clone(),
            operation_sequence: positive_u64(operation.operation_sequence, "operationSequence")?,
            operation_request_id: operation.operation_request_id,
            production_frame,
            production_frame_digest: operation.production_frame_digest,
            recorded_at: operation.recorded_at,
            latest_attempt: latest,
        });
    }
    Ok(output)
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
    workspace_binding_ref, workspace_binding_identity, workspace_kind,
    empty_workspace_key, run_settings_json, provider_profile_id,
    provider_revision_digest, initial_input_json, opening_recorded_at,
    opening_digest, run_id, run_open_reply_json, workspace_binding_digest,
    bootstrap_digest, activated_at, retired_at, next_operation_sequence
";

const OPERATION_COLUMNS: &str = "
    id, schema_version, run_row_id, operation_sequence,
    operation_request_id, run_id, bootstrap_digest,
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

fn nonnegative_u64(value: i64, field: &'static str) -> Result<u64, HostV2StorageError> {
    if value < 0 {
        return Err(corrupt(format!("{field} is negative")));
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
        for candidate in [path.to_path_buf(), sidecar("-wal"), sidecar("-shm")] {
            match fs::symlink_metadata(&candidate) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(HostV2StorageError::io(
                        "host_kernel_store_file_invalid",
                        "Host Kernel v2 SQLite files must be private regular files",
                    ));
                }
                Ok(_) => fs::set_permissions(&candidate, fs::Permissions::from_mode(0o600))
                    .map_err(|error| {
                        HostV2StorageError::io(
                            "host_kernel_store_permissions_failed",
                            format!("secure SQLite Host Kernel v2 file: {error}"),
                        )
                    })?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
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
