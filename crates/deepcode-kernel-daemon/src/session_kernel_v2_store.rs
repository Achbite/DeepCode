use crate::host_run_broker_v2::HostActiveRunBrokerV2;
use crate::host_v2_storage::{
    append_json_line_durable, canonical_json_bytes, canonical_sha256,
    reject_transport_capabilities, sha256_path_component, validate_bounded_identity,
    validate_safe_session_identity, validate_sha256_digest, value_without_field,
    with_storage_path_lock, HostV2StorageError, HostV2StorageErrorKind,
};
use crate::kernel_v2_transport::RUN_TRANSPORT_CAPABILITY_HEADER;
use crate::prelude::*;
use crate::provider_trace_v1::{
    ProviderTraceErrorV1, ProviderTraceIdentityV1, ProviderTracePurposeV1, ProviderTraceStoreV1,
    ProviderTraceWriterV1,
};
use crate::session_bootstrap_v2::HostSessionPriorEventsV2;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use deepcode_kernel_abi::RunCapabilityV2;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};

const SESSION_KERNEL_PERSISTENCE_V2_SCHEMA: &str = "deepcode.session.kernel-persistence.v2";
const SESSION_KERNEL_PERSISTENCE_RECORD_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-record.v2";
const SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-append-request.v2";
const SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-list-reply.v2";
const SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-append-reply.v2";
const SESSION_KERNEL_CHECKPOINT_V2_SCHEMA: &str = "deepcode.session.kernel-checkpoint.v2";
const SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA: &str =
    "deepcode.session.kernel-operation-result.v2";
const SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA: &str =
    "deepcode.session.kernel-host-projection-request.v2";
const SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA: &str =
    "deepcode.session.kernel-host-projection-reply.v2";
const HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA: &str = "deepcode.host.session-prior-events-page.v2";
const HOST_SESSION_PUBLIC_AGENT_EVENT_V2_SCHEMA: &str =
    "deepcode.host.session-public-agent-event.v2";
const HOST_SESSION_PUBLIC_TIMELINE_V2_SCHEMA: &str = "deepcode.host.session-public-timeline.v2";
pub(crate) const SESSION_KERNEL_V2_BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const MAX_V2_STORE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_V2_STORE_RECORD_BYTES: usize = SESSION_KERNEL_V2_BODY_LIMIT_BYTES;
const MAX_V2_STORE_RECORDS: usize = 100_000;
const MAX_PRIOR_EVENTS_PAGE_COUNT_V2: usize = 128;
const MAX_PRIOR_EVENTS_PAGE_BYTES_V2: usize = 1024 * 1024;
const MAX_PRIOR_EVENTS_SINGLE_EVENT_PAGE_BYTES_V2: usize = 8 * 1024 * 1024;
const MAX_PRIOR_EVENTS_PROJECTION_BYTES_V2: usize = 12 * 1024 * 1024;
const MAX_PRIOR_EVENTS_PAGE_CACHE_V2: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionKernelPersistenceRecordKindV2 {
    StoreHeader,
    Input,
    Plan,
    PlanDecision,
    PublicRequest,
    PublicRequestSettled,
    Checkpoint,
    OperationResult,
    Projection,
    ProjectionDelivered,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionKernelPersistenceRecordV2 {
    pub(crate) schema_version: String,
    pub(crate) record_id: String,
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) record_kind: SessionKernelPersistenceRecordKindV2,
    pub(crate) recorded_at: String,
    pub(crate) data: Value,
    pub(crate) record_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionKernelPersistenceAppendRequestV2 {
    schema_version: String,
    session_id: String,
    run_id: String,
    record: SessionKernelPersistenceRecordV2,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionKernelPersistenceListReplyV2 {
    schema_version: &'static str,
    session_id: String,
    run_id: String,
    records: Vec<SessionKernelPersistenceRecordV2>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionKernelPersistenceAppendReplyV2 {
    schema_version: &'static str,
    session_id: String,
    run_id: String,
    record_id: String,
    record_digest: String,
    replayed: bool,
}

#[derive(Clone)]
pub(crate) struct SessionKernelV2Store {
    sessions_dir: Arc<PathBuf>,
    active_runs: HostActiveRunBrokerV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionProviderTurnAdmissionV2 {
    pub(crate) provider_turn_id: String,
    pub(crate) control_epoch: u64,
    pub(crate) current_input_id: String,
    pub(crate) current_input_digest: String,
    pub(crate) provider_profile_id: String,
    pub(crate) provider_profile_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionProviderDispatchBindingV2 {
    pub(crate) provider_turn_id: String,
    pub(crate) run_id: String,
    pub(crate) control_epoch: u64,
    pub(crate) current_input_id: String,
    pub(crate) current_input_digest: String,
    pub(crate) purpose: ProviderTracePurposeV1,
}

impl SessionKernelV2Store {
    pub(crate) fn new(sessions_dir: PathBuf, active_runs: HostActiveRunBrokerV2) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            active_runs,
        }
    }

    fn list(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<Vec<SessionKernelPersistenceRecordV2>, HostV2StorageError> {
        self.active_runs
            .authorize_session_run_transport(session_id, run_id, capability)?;
        let path = self.run_store_path(session_id, run_id)?;
        with_storage_path_lock(&path, || read_run_store(&path, session_id, run_id))
    }

    pub(crate) fn provider_turn_admission(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        provider_turn_id: &str,
    ) -> Result<SessionProviderTurnAdmissionV2, HostV2StorageError> {
        validate_bounded_identity(provider_turn_id, "providerTurnId", 512)?;
        let records = self.list(session_id, run_id, capability)?;
        provider_turn_admission_from_records(&records, run_id, provider_turn_id)
    }

    pub(crate) fn commit_provider_dispatch(
        &self,
        capability: &RunCapabilityV2,
        expected_admission: &SessionProviderTurnAdmissionV2,
        exact_request_binding: &SessionProviderDispatchBindingV2,
        trace_store: &ProviderTraceStoreV1,
        trace_identity: ProviderTraceIdentityV1,
        exact_request_body: &[u8],
    ) -> Result<ProviderTraceWriterV1, ProviderTraceErrorV1> {
        let session_id = trace_identity.session_id.clone();
        let run_id = trace_identity.run_id.clone();
        let path = self.run_store_path(&session_id, &run_id)?;
        self.active_runs
            .with_authorized_session_run_transport_storage(
                &session_id,
                &run_id,
                capability,
                &path,
                || {
                    let records =
                        read_run_store(&path, &trace_identity.session_id, &trace_identity.run_id)?;
                    let current_admission = provider_turn_admission_from_records(
                        &records,
                        &trace_identity.run_id,
                        &trace_identity.provider_turn_id,
                    )?;
                    if &current_admission != expected_admission
                        || current_admission.provider_turn_id != trace_identity.provider_turn_id
                        || current_admission.control_epoch != trace_identity.control_epoch
                        || current_admission.current_input_id != trace_identity.user_turn_id
                        || current_admission.provider_profile_id != trace_identity.profile_id
                        || current_admission.provider_profile_revision
                            != trace_identity.profile_revision
                        || exact_request_binding.provider_turn_id
                            != current_admission.provider_turn_id
                        || exact_request_binding.run_id != trace_identity.run_id
                        || exact_request_binding.control_epoch != current_admission.control_epoch
                        || exact_request_binding.current_input_id
                            != current_admission.current_input_id
                        || exact_request_binding.current_input_digest
                            != current_admission.current_input_digest
                        || exact_request_binding.purpose != trace_identity.purpose
                    {
                        return Err(provider_dispatch_stale());
                    }
                    trace_store
                        .begin_committed_turn(trace_identity, exact_request_body)
                        .map_err(|error| HostV2StorageError::io(error.code, error.message))
                },
            )
            .map_err(ProviderTraceErrorV1::from)
    }

    fn append(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        request: SessionKernelPersistenceAppendRequestV2,
    ) -> Result<SessionKernelPersistenceAppendReplyV2, HostV2StorageError> {
        self.active_runs
            .authorize_session_run_transport(session_id, run_id, capability)?;
        if request.schema_version != SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA {
            return Err(HostV2StorageError::invalid(
                "session_kernel_persistence_schema_unsupported",
                "Session Kernel persistence append request has an unsupported schema",
            ));
        }
        if request.session_id != session_id
            || request.run_id != run_id
            || request.record.session_id != session_id
            || request.record.run_id != run_id
        {
            return Err(HostV2StorageError::invalid(
                "session_kernel_persistence_store_identity_mismatch",
                "Session Kernel persistence identities do not match the route",
            ));
        }
        validate_persistence_record(&request.record, session_id, run_id)?;
        let path = self.run_store_path(session_id, run_id)?;
        with_storage_path_lock(&path, || {
            let records = read_run_store(&path, session_id, run_id)?;
            if let Some(existing) = records
                .iter()
                .find(|record| record.record_id == request.record.record_id)
            {
                if existing.record_digest != request.record.record_digest {
                    return Err(HostV2StorageError::conflict(
                        "session_kernel_persistence_identity_conflict",
                        "Session Kernel persistence recordId has different durable content",
                    ));
                }
                return Ok(SessionKernelPersistenceAppendReplyV2 {
                    schema_version: SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA,
                    session_id: session_id.to_string(),
                    run_id: run_id.to_string(),
                    record_id: existing.record_id.clone(),
                    record_digest: existing.record_digest.clone(),
                    replayed: true,
                });
            }
            if records.is_empty() {
                require_store_header(&request.record, run_id)?;
            } else if request.record.record_kind
                == SessionKernelPersistenceRecordKindV2::StoreHeader
            {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_persistence_header_conflict",
                    "Session Kernel persistence stream already has its immutable header",
                ));
            }
            let value = serde_json::to_value(&request.record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_persistence_record_invalid",
                    format!("encode Session Kernel persistence record: {error}"),
                )
            })?;
            preflight_store_append(&path, records.len(), &value)?;
            append_json_line_durable(&path, &value)?;
            Ok(SessionKernelPersistenceAppendReplyV2 {
                schema_version: SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA,
                session_id: session_id.to_string(),
                run_id: run_id.to_string(),
                record_id: request.record.record_id,
                record_digest: request.record.record_digest,
                replayed: false,
            })
        })
    }

    fn get_record(
        &self,
        session_id: &str,
        run_id: &str,
        record_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<SessionKernelPersistenceRecordV2, HostV2StorageError> {
        self.active_runs
            .authorize_session_run_transport(session_id, run_id, capability)?;
        validate_bounded_identity(record_id, "recordId", 128 * 1024)?;
        let path = self.run_store_path(session_id, run_id)?;
        with_storage_path_lock(&path, || {
            read_run_store(&path, session_id, run_id)?
                .into_iter()
                .find(|record| record.record_id == record_id)
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "session_kernel_persistence_record_not_found",
                        "Session Kernel persistence record was not found",
                    )
                })
        })
    }

    pub(crate) fn resolve_operation_result(
        &self,
        session_id: &str,
        run_id: &str,
        operation_request_id: &str,
        record_id: &str,
        record_digest: &str,
        result_digest: &str,
        capability: &RunCapabilityV2,
    ) -> Result<Value, HostV2StorageError> {
        validate_bounded_identity(operation_request_id, "operationRequestId", 512)?;
        validate_bounded_identity(record_digest, "recordDigest", 512)?;
        validate_bounded_identity(result_digest, "resultDigest", 512)?;
        let record = self.get_record(session_id, run_id, record_id, capability)?;
        if record.record_kind != SessionKernelPersistenceRecordKindV2::OperationResult
            || record.record_digest != record_digest
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_operation_result_reference_conflict",
                "Stored Session operation result does not match its immutable reference",
            ));
        }
        let data = record.data.as_object().ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_operation_result_reference_conflict",
                "Stored Session operation result has an invalid durable envelope",
            )
        })?;
        if data.get("operationRequestId").and_then(Value::as_str) != Some(operation_request_id)
            || data.get("resultDigest").and_then(Value::as_str) != Some(result_digest)
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_operation_result_reference_conflict",
                "Stored Session operation result belongs to another operation or digest",
            ));
        }
        data.get("result").cloned().ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_operation_result_reference_conflict",
                "Stored Session operation result has no durable result payload",
            )
        })
    }

    /// Reads the deterministic Session operation-result record during
    /// Host-owned startup reconciliation. This intentionally bypasses the
    /// process-private Run transport capability because a restarted Host has
    /// not rebound or resumed the Session bridge yet. The full persistence
    /// stream, record digest, deterministic record identity, result digest,
    /// and Session/Run identities are still verified before any value is
    /// returned.
    pub(crate) fn recover_operation_result_for_host(
        &self,
        session_id: &str,
        run_id: &str,
        operation_request_id: &str,
    ) -> Result<Option<Value>, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        validate_bounded_identity(operation_request_id, "operationRequestId", 512)?;
        let record_id =
            format!("session-kernel-v2:{run_id}:operation-result:{operation_request_id}");
        let path = self.run_store_path(session_id, run_id)?;
        with_storage_path_lock(&path, || {
            let Some(record) = read_run_store(&path, session_id, run_id)?
                .into_iter()
                .find(|record| record.record_id == record_id)
            else {
                return Ok(None);
            };
            if record.record_kind != SessionKernelPersistenceRecordKindV2::OperationResult {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_operation_result_identity_conflict",
                    "Deterministic operation-result identity is bound to another record kind",
                ));
            }
            let data = record.data.as_object().ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_operation_result_invalid",
                    "Recovered Session operation result has an invalid durable envelope",
                )
            })?;
            let expected_fields = [
                "schemaVersion",
                "operationRequestId",
                "resultDigest",
                "result",
            ];
            if data.len() != expected_fields.len()
                || expected_fields
                    .iter()
                    .any(|field| !data.contains_key(*field))
                || data.get("schemaVersion").and_then(Value::as_str)
                    != Some(SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA)
                || data.get("operationRequestId").and_then(Value::as_str)
                    != Some(operation_request_id)
            {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_operation_result_identity_conflict",
                    "Recovered Session operation result changed its exact durable envelope",
                ));
            }
            let result_digest = data
                .get("resultDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "session_kernel_operation_result_invalid",
                        "Recovered Session operation result has no result digest",
                    )
                })?;
            validate_sha256_digest(result_digest, "resultDigest")?;
            let result = data.get("result").ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_operation_result_invalid",
                    "Recovered Session operation result has no durable result payload",
                )
            })?;
            if canonical_sha256(result)? != result_digest {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_operation_result_digest_mismatch",
                    "Recovered Session operation result failed its inner result digest",
                ));
            }
            Ok(Some(result.clone()))
        })
    }

    fn run_store_path(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<PathBuf, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        Ok(self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join(format!("{}.jsonl", sha256_path_component(run_id))))
    }
}

fn provider_turn_admission_from_records(
    records: &[SessionKernelPersistenceRecordV2],
    run_id: &str,
    provider_turn_id: &str,
) -> Result<SessionProviderTurnAdmissionV2, HostV2StorageError> {
    let mut latest: Option<(u64, String, &Value, bool)> = None;
    for record in records {
        let checkpoint = match record.record_kind {
            SessionKernelPersistenceRecordKindV2::Checkpoint => Some(&record.data),
            SessionKernelPersistenceRecordKindV2::PublicRequestSettled => {
                record.data.get("checkpoint")
            }
            _ => None,
        };
        let Some(checkpoint) = checkpoint else {
            continue;
        };
        let revision = checkpoint
            .get("checkpointRevision")
            .and_then(Value::as_u64)
            .ok_or_else(provider_turn_admission_invalid)?;
        match latest.as_mut() {
            None => {
                let digest =
                    canonical_sha256(checkpoint).map_err(|_| provider_turn_admission_invalid())?;
                latest = Some((revision, digest, checkpoint, false));
            }
            Some((latest_revision, latest_digest, latest_checkpoint, conflict))
                if revision > *latest_revision =>
            {
                let digest =
                    canonical_sha256(checkpoint).map_err(|_| provider_turn_admission_invalid())?;
                *latest_revision = revision;
                *latest_digest = digest;
                *latest_checkpoint = checkpoint;
                *conflict = false;
            }
            Some((latest_revision, latest_digest, _, conflict)) if revision == *latest_revision => {
                let digest =
                    canonical_sha256(checkpoint).map_err(|_| provider_turn_admission_invalid())?;
                if digest != *latest_digest {
                    *conflict = true;
                }
            }
            Some(_) => {}
        }
    }
    let (checkpoint_revision, _, checkpoint, revision_conflict) =
        latest.ok_or_else(provider_turn_admission_missing)?;
    if revision_conflict {
        return Err(provider_turn_admission_invalid());
    }
    if checkpoint.get("schemaVersion").and_then(Value::as_str)
        != Some(SESSION_KERNEL_CHECKPOINT_V2_SCHEMA)
    {
        return Err(provider_turn_admission_invalid());
    }
    let state = checkpoint
        .get("state")
        .and_then(Value::as_object)
        .ok_or_else(provider_turn_admission_invalid)?;
    if state.get("runId").and_then(Value::as_str) != Some(run_id) {
        return Err(provider_turn_admission_invalid());
    }
    if state.get("checkpointRevision").and_then(Value::as_u64) != Some(checkpoint_revision) {
        return Err(provider_turn_admission_invalid());
    }
    let control_epoch = state
        .get("controlEpoch")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(provider_turn_admission_invalid)?;
    let current_input_id = state
        .get("currentInputId")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_bounded_identity(current_input_id, "currentInputId", 512)?;
    let provider_turn = state
        .get("providerTurn")
        .and_then(Value::as_object)
        .ok_or_else(provider_turn_admission_missing)?;
    if provider_turn.get("providerTurnId").and_then(Value::as_str) != Some(provider_turn_id)
        || provider_turn.get("controlEpoch").and_then(Value::as_u64) != Some(control_epoch)
        || provider_turn.get("status").and_then(Value::as_str) != Some("active")
    {
        return Err(provider_turn_admission_missing());
    }
    let context_assembly = provider_turn
        .get("contextAssembly")
        .and_then(Value::as_object)
        .ok_or_else(provider_turn_admission_invalid)?;
    let profile = context_assembly
        .get("providerProfile")
        .and_then(Value::as_object)
        .ok_or_else(provider_turn_admission_invalid)?;
    let provider_profile_id = profile
        .get("providerProfileId")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_bounded_identity(provider_profile_id, "providerProfileId", 512)?;
    let provider_profile_revision = profile
        .get("providerProfileRevisionDigest")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_sha256_digest(provider_profile_revision, "providerProfileRevisionDigest")?;
    let sections = context_assembly
        .get("trimming")
        .and_then(|value| value.get("sections"))
        .and_then(Value::as_array)
        .ok_or_else(provider_turn_admission_invalid)?;
    let current_input_sections = sections
        .iter()
        .filter(|section| section.get("section").and_then(Value::as_str) == Some("currentInput"))
        .collect::<Vec<_>>();
    if current_input_sections.len() != 1 {
        return Err(provider_turn_admission_invalid());
    }
    let current_input_digest = current_input_sections[0]
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_sha256_digest(current_input_digest, "currentInputDigest")?;
    Ok(SessionProviderTurnAdmissionV2 {
        provider_turn_id: provider_turn_id.to_string(),
        control_epoch,
        current_input_id: current_input_id.to_string(),
        current_input_digest: current_input_digest.to_string(),
        provider_profile_id: provider_profile_id.to_string(),
        provider_profile_revision: provider_profile_revision.to_string(),
    })
}

fn provider_turn_admission_missing() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "provider_turn_admission_missing",
        "Provider transport has no exact active durable Session turn admission",
    )
}

fn provider_turn_admission_invalid() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "provider_turn_admission_invalid",
        "Provider transport durable Session turn admission is invalid",
    )
}

fn provider_dispatch_stale() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "provider_dispatch_stale",
        "Provider dispatch no longer matches the exact active durable Session turn",
    )
}

fn preflight_store_append(
    path: &FsPath,
    record_count: usize,
    value: &Value,
) -> Result<(), HostV2StorageError> {
    if record_count >= MAX_V2_STORE_RECORDS {
        return Err(HostV2StorageError::conflict(
            "host_v2_storage_limit_exceeded",
            "Host v2 JSONL stream reached its bounded record count",
        ));
    }
    let encoded = serde_json::to_vec(value).map_err(|error| {
        HostV2StorageError::invalid(
            "host_v2_storage_encode_failed",
            format!("encode Host v2 JSONL record: {error}"),
        )
    })?;
    if encoded.is_empty() || encoded.len() > MAX_V2_STORE_RECORD_BYTES {
        return Err(HostV2StorageError::conflict(
            "host_v2_storage_record_invalid",
            "Host v2 JSONL record is empty or exceeds its bounded size",
        ));
    }
    let current_bytes = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(HostV2StorageError::io(
                "host_v2_storage_read_failed",
                format!("inspect Host v2 JSONL stream before append: {error}"),
            ))
        }
    };
    let appended_bytes = u64::try_from(encoded.len())
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    if current_bytes.saturating_add(appended_bytes) > MAX_V2_STORE_FILE_BYTES {
        return Err(HostV2StorageError::conflict(
            "host_v2_storage_limit_exceeded",
            "Host v2 JSONL append would exceed its bounded size",
        ));
    }
    Ok(())
}

fn read_run_store(
    path: &FsPath,
    session_id: &str,
    run_id: &str,
) -> Result<Vec<SessionKernelPersistenceRecordV2>, HostV2StorageError> {
    let values = read_bounded_json_lines(path)?;
    let mut unique = Vec::with_capacity(values.len());
    let mut digests = HashMap::new();
    let mut header_count = 0usize;
    for (index, value) in values.into_iter().enumerate() {
        let record: SessionKernelPersistenceRecordV2 =
            serde_json::from_value(value).map_err(|error| {
                HostV2StorageError::conflict(
                    "session_kernel_persistence_history_unsupported",
                    format!("decode Session Kernel persistence record: {error}"),
                )
            })?;
        validate_persistence_record(&record, session_id, run_id).map_err(|error| {
            HostV2StorageError::conflict(
                "session_kernel_persistence_history_unsupported",
                error.message,
            )
        })?;
        if record.record_kind == SessionKernelPersistenceRecordKindV2::StoreHeader {
            header_count += 1;
            if index != 0 {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_persistence_history_unsupported",
                    "Session Kernel persistence header is not the first durable record",
                ));
            }
            require_store_header(&record, run_id)?;
        }
        match digests.get(&record.record_id) {
            Some(existing) if existing != &record.record_digest => {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_persistence_identity_conflict",
                    "Session Kernel persistence history has conflicting recordId content",
                ))
            }
            Some(_) => continue,
            None => {
                digests.insert(record.record_id.clone(), record.record_digest.clone());
                unique.push(record);
            }
        }
    }
    if !unique.is_empty() && header_count != 1 {
        return Err(HostV2StorageError::conflict(
            "session_kernel_persistence_history_unsupported",
            "Session Kernel persistence history has no unique v2 store header",
        ));
    }
    Ok(unique)
}

fn validate_persistence_record(
    record: &SessionKernelPersistenceRecordV2,
    session_id: &str,
    run_id: &str,
) -> Result<(), HostV2StorageError> {
    if record.schema_version != SESSION_KERNEL_PERSISTENCE_RECORD_V2_SCHEMA {
        return Err(HostV2StorageError::invalid(
            "session_kernel_persistence_schema_unsupported",
            "Session Kernel persistence record has an unsupported schema",
        ));
    }
    if record.session_id != session_id || record.run_id != run_id {
        return Err(HostV2StorageError::invalid(
            "session_kernel_persistence_store_identity_mismatch",
            "Session Kernel persistence record belongs to another Session or Run",
        ));
    }
    validate_safe_session_identity(session_id)?;
    validate_bounded_identity(run_id, "runId", 512)?;
    validate_bounded_identity(&record.record_id, "recordId", 128 * 1024)?;
    validate_bounded_identity(&record.recorded_at, "recordedAt", 128 * 1024)?;
    validate_bounded_identity(&record.record_digest, "recordDigest", 512)?;
    reject_transport_capabilities(&record.data)?;
    let value = serde_json::to_value(record).map_err(|error| {
        HostV2StorageError::invalid(
            "session_kernel_persistence_record_invalid",
            format!("encode Session Kernel persistence record: {error}"),
        )
    })?;
    let expected = canonical_sha256(&value_without_field(&value, "recordDigest")?)?;
    if expected != record.record_digest {
        return Err(HostV2StorageError::invalid(
            "session_kernel_persistence_digest_mismatch",
            "Session Kernel persistence record failed digest verification",
        ));
    }
    if record.record_kind == SessionKernelPersistenceRecordKindV2::OperationResult {
        validate_operation_result_record(record, session_id, run_id)?;
    }
    Ok(())
}

fn validate_operation_result_record(
    record: &SessionKernelPersistenceRecordV2,
    session_id: &str,
    run_id: &str,
) -> Result<(), HostV2StorageError> {
    let object = record.data.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_operation_result_invalid",
            "Session Kernel operation result data must be an object",
        )
    })?;
    let expected_keys = [
        "operationRequestId",
        "result",
        "resultDigest",
        "schemaVersion",
    ];
    if object.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !object.contains_key(*key))
        || object.get("schemaVersion").and_then(Value::as_str)
            != Some(SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA)
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_operation_result_invalid",
            "Session Kernel operation result has an invalid strict envelope",
        ));
    }
    let operation_request_id = object
        .get("operationRequestId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_operation_result_invalid",
                "Session Kernel operation result has no operationRequestId",
            )
        })?;
    validate_bounded_identity(operation_request_id, "operationRequestId", 512)?;
    if record.record_id
        != format!("session-kernel-v2:{run_id}:operation-result:{operation_request_id}")
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_operation_result_identity_mismatch",
            "Session Kernel operation result recordId does not bind its operationRequestId",
        ));
    }
    let result = object.get("result").ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_operation_result_invalid",
            "Session Kernel operation result payload is missing",
        )
    })?;
    let result_object = result.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_operation_result_invalid",
            "Session Kernel operation result payload must be an object",
        )
    })?;
    if result_object.get("ok").and_then(Value::as_bool) != Some(true)
        || result_object.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || result_object.get("runId").and_then(Value::as_str) != Some(run_id)
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_operation_result_identity_mismatch",
            "Session Kernel operation result payload belongs to another Session or Run",
        ));
    }
    let result_digest = object
        .get("resultDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_operation_result_invalid",
                "Session Kernel operation result has no resultDigest",
            )
        })?;
    validate_bounded_identity(result_digest, "resultDigest", 512)?;
    if canonical_sha256(result)? != result_digest {
        return Err(HostV2StorageError::invalid(
            "session_kernel_operation_result_digest_mismatch",
            "Session Kernel operation result failed digest verification",
        ));
    }
    Ok(())
}

fn require_store_header(
    record: &SessionKernelPersistenceRecordV2,
    run_id: &str,
) -> Result<(), HostV2StorageError> {
    if record.record_kind != SessionKernelPersistenceRecordKindV2::StoreHeader
        || record.record_id != format!("session-kernel-v2:{run_id}:store")
        || record.data
            != json!({
                "schemaVersion": SESSION_KERNEL_PERSISTENCE_V2_SCHEMA
            })
    {
        return Err(HostV2StorageError::conflict(
            "session_kernel_persistence_history_unsupported",
            "Session Kernel persistence stream requires the exact v2 store header",
        ));
    }
    Ok(())
}

fn read_bounded_json_lines(path: &FsPath) -> Result<Vec<Value>, HostV2StorageError> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(HostV2StorageError::io(
                "host_v2_storage_read_failed",
                format!("open Host v2 JSONL stream: {error}"),
            ))
        }
    };
    let size = file.metadata().map_err(|error| {
        HostV2StorageError::io(
            "host_v2_storage_read_failed",
            format!("inspect Host v2 JSONL stream: {error}"),
        )
    })?;
    if size.len() > MAX_V2_STORE_FILE_BYTES {
        return Err(HostV2StorageError::conflict(
            "host_v2_storage_limit_exceeded",
            "Host v2 JSONL stream exceeds its bounded size",
        ));
    }
    let mut values = Vec::new();
    for line in BufReader::new(file).lines() {
        if values.len() >= MAX_V2_STORE_RECORDS {
            return Err(HostV2StorageError::conflict(
                "host_v2_storage_limit_exceeded",
                "Host v2 JSONL stream exceeds its bounded record count",
            ));
        }
        let line = line.map_err(|error| {
            HostV2StorageError::io(
                "host_v2_storage_read_failed",
                format!("read Host v2 JSONL stream: {error}"),
            )
        })?;
        if line.is_empty() || line.len() > MAX_V2_STORE_RECORD_BYTES {
            return Err(HostV2StorageError::conflict(
                "host_v2_storage_record_invalid",
                "Host v2 JSONL stream contains an empty or oversized record",
            ));
        }
        values.push(serde_json::from_str(&line).map_err(|error| {
            HostV2StorageError::conflict(
                "host_v2_storage_record_invalid",
                format!("decode Host v2 JSONL record: {error}"),
            )
        })?);
    }
    Ok(values)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelProjectionEventV2 {
    projection_id: String,
    run_id: String,
    recorded_at: String,
    kind: String,
    data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionKernelHostProjectionRequestV2 {
    schema_version: String,
    session_id: String,
    host_run_id: String,
    projection_id: String,
    projection_digest: String,
    event: SessionKernelProjectionEventV2,
    agent_event: Value,
    timeline: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionKernelHostProjectionReplyV2 {
    schema_version: &'static str,
    projection_id: String,
    projection_digest: String,
    replayed: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostSessionPriorEventsPageQueryV2 {
    continuation: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSessionPriorEventsPageReplyV2 {
    schema_version: &'static str,
    session_id: String,
    host_run_id: String,
    run_id: String,
    source_event_version: u64,
    source_events_digest: String,
    snapshot_digest: String,
    start_event_index: u64,
    end_event_index_exclusive: u64,
    event_count: u64,
    events: Vec<Value>,
    events_digest: String,
    next_continuation: Option<String>,
    page_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSessionPublicAgentEventRecordV2 {
    schema_version: String,
    projection_id: String,
    projection_digest: String,
    agent_event_digest: String,
    agent_event: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSessionPublicTimelineRecordV2 {
    schema_version: String,
    projection_id: String,
    projection_digest: String,
    timeline_revision: u64,
    source_event_version: u64,
    timeline_digest: String,
    timeline: Value,
}

#[derive(Clone)]
pub(crate) struct SessionKernelProjectionSinkV2 {
    sessions_dir: Arc<PathBuf>,
    active_runs: HostActiveRunBrokerV2,
    projections: Arc<Mutex<HashMap<String, BTreeMap<String, (String, Value)>>>>,
    prior_event_prefixes: Arc<Mutex<HashMap<String, Arc<Vec<Value>>>>>,
}

impl SessionKernelProjectionSinkV2 {
    pub(crate) fn new(sessions_dir: PathBuf, active_runs: HostActiveRunBrokerV2) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            active_runs,
            projections: Arc::new(Mutex::new(HashMap::new())),
            prior_event_prefixes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn publish(
        &self,
        session_id: &str,
        host_run_id: &str,
        capability: &RunCapabilityV2,
        request: SessionKernelHostProjectionRequestV2,
    ) -> Result<SessionKernelHostProjectionReplyV2, HostV2StorageError> {
        validate_projection_request(&request, session_id, host_run_id)?;
        let active = self.active_runs.resolve(session_id, host_run_id)?;
        if active.run_id != request.event.run_id {
            return Err(HostV2StorageError::invalid(
                "session_kernel_projection_run_mismatch",
                "Session Kernel projection belongs to another Kernel Run",
            ));
        }
        self.active_runs.authorize_host_run_transport(
            session_id,
            host_run_id,
            &request.event.run_id,
            capability,
        )?;
        let path = self.projection_path(session_id, host_run_id)?;
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        let replayed = with_storage_path_lock(&guard_path, || {
            self.preflight_public_projection(session_id, &request)?;
            let replayed = if projection_request_replayed(&path, session_id, host_run_id, &request)?
            {
                true
            } else {
                self.preflight_public_projection_appends(session_id, host_run_id, &request, false)?;
                append_json_line_durable(
                    &path,
                    &serde_json::to_value(&request).map_err(|error| {
                        HostV2StorageError::invalid(
                            "session_kernel_projection_record_invalid",
                            format!("encode Host projection record: {error}"),
                        )
                    })?,
                )?;
                false
            };
            if replayed {
                self.preflight_public_projection_appends(session_id, host_run_id, &request, true)?;
            }
            self.publish_agent_event_locked(session_id, &request)?;
            self.publish_timeline_locked(session_id, &request)?;
            Ok(replayed)
        })?;
        self.remember_projection(session_id, host_run_id, &request)?;
        Ok(SessionKernelHostProjectionReplyV2 {
            schema_version: SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA,
            projection_id: request.projection_id,
            projection_digest: request.projection_digest,
            replayed,
        })
    }

    pub(crate) fn require_durable_run_cancelled_projection(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        projection_id: &str,
        projection_digest: &str,
        expected_data: &Value,
    ) -> Result<(), HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        for (field, value) in [
            ("hostRunId", host_run_id),
            ("runId", run_id),
            ("projectionId", projection_id),
        ] {
            validate_bounded_identity(value, field, 512)?;
        }
        validate_sha256_digest(projection_digest, "projectionDigest")?;
        reject_transport_capabilities(expected_data)?;
        let projection_path = self.projection_path(session_id, host_run_id)?;
        let mut durable_projection = None;
        for value in read_bounded_json_lines(&projection_path)? {
            let request: SessionKernelHostProjectionRequestV2 = serde_json::from_value(value)
                .map_err(|_| {
                    HostV2StorageError::conflict(
                        "session_kernel_projection_record_invalid",
                        "Host projection store contains an invalid strict v2 record",
                    )
                })?;
            validate_projection_request(&request, session_id, host_run_id)?;
            if request.projection_id == projection_id {
                durable_projection = Some(request);
                break;
            }
        }
        let request = durable_projection.ok_or_else(|| {
            HostV2StorageError::not_found(
                "session_kernel_cancel_projection_missing",
                "Canonical Session cancellation projection is not durable in the Host",
            )
        })?;
        if request.projection_digest != projection_digest
            || request.event.projection_id != projection_id
            || request.event.run_id != run_id
            || request.event.kind != "run.cancelled"
            || &request.event.data != expected_data
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_cancel_projection_conflict",
                "Canonical Session cancellation projection changed exact identity or content",
            ));
        }
        let agent_path = public_agent_event_path(self.sessions_dir.as_ref(), session_id)?;
        let mut public_agent_event = None;
        for value in read_bounded_json_lines(&agent_path)? {
            let record = decode_public_agent_event_record(value, session_id)?;
            if record.projection_id == projection_id {
                public_agent_event = Some(record);
                break;
            }
        }
        let public_agent_event = public_agent_event.ok_or_else(|| {
            HostV2StorageError::not_found(
                "session_kernel_cancel_public_event_missing",
                "Canonical Session cancellation AgentEvent is not durable",
            )
        })?;
        if public_agent_event.projection_digest != projection_digest
            || public_agent_event.agent_event != request.agent_event
            || public_agent_event
                .agent_event
                .get("kind")
                .and_then(Value::as_str)
                != Some("session_run_state")
            || public_agent_event
                .agent_event
                .pointer("/payload/projectionKind")
                .and_then(Value::as_str)
                != Some("run.cancelled")
            || public_agent_event
                .agent_event
                .pointer("/payload/status")
                .and_then(Value::as_str)
                != Some("cancelled")
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_cancel_public_event_conflict",
                "Canonical Session cancellation AgentEvent does not match its Host projection",
            ));
        }
        let timeline_path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
        let timeline = read_public_timeline_records(&timeline_path, session_id)?
            .into_iter()
            .find(|record| record.projection_id == projection_id)
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "session_kernel_cancel_public_timeline_missing",
                    "Canonical Session cancellation timeline is not durable",
                )
            })?;
        if timeline.projection_digest != projection_digest
            || timeline
                .timeline
                .pointer("/runProjection/runId")
                .and_then(Value::as_str)
                != Some(run_id)
            || timeline
                .timeline
                .pointer("/runProjection/status")
                .and_then(Value::as_str)
                != Some("cancelled")
            || timeline
                .timeline
                .pointer("/runProjection/phase")
                .and_then(Value::as_str)
                != Some("settled")
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_cancel_public_timeline_conflict",
                "Canonical Session cancellation timeline has conflicting identity or terminal state",
            ));
        }
        Ok(())
    }

    fn prior_events_page(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        frozen: &HostSessionPriorEventsV2,
        continuation: Option<&str>,
    ) -> Result<HostSessionPriorEventsPageReplyV2, HostV2StorageError> {
        frozen.validate(session_id)?;
        self.active_runs.authorize_host_run_transport(
            session_id,
            host_run_id,
            run_id,
            capability,
        )?;
        let (cache_key, source_events) =
            self.frozen_prior_event_prefix(session_id, host_run_id, run_id, frozen)?;
        let frozen_count = source_events.len();
        let start = decode_prior_events_continuation(
            continuation,
            session_id,
            host_run_id,
            run_id,
            frozen,
        )?;
        if start > frozen_count {
            return Err(HostV2StorageError::invalid(
                "host_session_prior_events_continuation_invalid",
                "Prior Session event continuation exceeds the frozen prefix",
            ));
        }
        let mut events = Vec::new();
        let mut encoded_bytes = 2usize;
        for event in source_events
            .iter()
            .skip(start)
            .take(MAX_PRIOR_EVENTS_PAGE_COUNT_V2)
        {
            let separator_bytes = usize::from(!events.is_empty());
            let event_bytes = canonical_json_bytes(event)?.len();
            let candidate_bytes = encoded_bytes
                .saturating_add(separator_bytes)
                .saturating_add(event_bytes);
            if events.is_empty() && candidate_bytes > MAX_PRIOR_EVENTS_SINGLE_EVENT_PAGE_BYTES_V2 {
                return Err(HostV2StorageError::invalid(
                    "host_session_prior_event_projection_limit_exceeded",
                    "A prior Session event exceeds the bounded projection page limit",
                ));
            }
            if !events.is_empty() && candidate_bytes > MAX_PRIOR_EVENTS_PAGE_BYTES_V2 {
                break;
            }
            events.push(event.clone());
            encoded_bytes = candidate_bytes;
        }
        let end = start.checked_add(events.len()).ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_session_prior_events_index_invalid",
                "Prior Session event page index is exhausted",
            )
        })?;
        let start_event_index = u64::try_from(start).map_err(|_| {
            HostV2StorageError::conflict(
                "host_session_prior_events_index_invalid",
                "Prior Session event page index is not representable",
            )
        })?;
        let end_event_index_exclusive = u64::try_from(end).map_err(|_| {
            HostV2StorageError::conflict(
                "host_session_prior_events_index_invalid",
                "Prior Session event page index is not representable",
            )
        })?;
        let event_count = u64::try_from(events.len()).map_err(|_| {
            HostV2StorageError::conflict(
                "host_session_prior_events_count_invalid",
                "Prior Session event page count is not representable",
            )
        })?;
        let events_digest = canonical_sha256(&Value::Array(events.clone()))?;
        let next_continuation = if end < frozen_count {
            Some(prior_events_continuation(
                end,
                session_id,
                host_run_id,
                run_id,
                frozen,
            )?)
        } else {
            None
        };
        let page_digest = canonical_sha256(&json!({
            "schemaVersion": HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA,
            "sessionId": session_id,
            "hostRunId": host_run_id,
            "runId": run_id,
            "sourceEventVersion": frozen.source_event_version,
            "sourceEventsDigest": frozen.source_events_digest,
            "snapshotDigest": frozen.snapshot_digest,
            "startEventIndex": start_event_index,
            "endEventIndexExclusive": end_event_index_exclusive,
            "eventCount": event_count,
            "events": events,
            "eventsDigest": events_digest,
            "nextContinuation": next_continuation,
        }))?;
        if next_continuation.is_none() {
            if let Ok(mut prefixes) = self.prior_event_prefixes.lock() {
                prefixes.remove(&cache_key);
            }
        }
        Ok(HostSessionPriorEventsPageReplyV2 {
            schema_version: HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA,
            session_id: session_id.to_string(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
            source_event_version: frozen.source_event_version,
            source_events_digest: frozen.source_events_digest.clone(),
            snapshot_digest: frozen.snapshot_digest.clone(),
            start_event_index,
            end_event_index_exclusive,
            event_count,
            events,
            events_digest,
            next_continuation,
            page_digest,
        })
    }

    fn frozen_prior_event_prefix(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        frozen: &HostSessionPriorEventsV2,
    ) -> Result<(String, Arc<Vec<Value>>), HostV2StorageError> {
        let cache_key = canonical_sha256(&json!({
            "schemaVersion": "deepcode.host.session-prior-events-cache-key.v2",
            "sessionId": session_id,
            "hostRunId": host_run_id,
            "runId": run_id,
            "snapshotDigest": frozen.snapshot_digest,
        }))?;
        if let Some(events) = self
            .prior_event_prefixes
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_session_prior_events_cache_unavailable",
                    "Prior Session event cache is unavailable",
                )
            })?
            .get(&cache_key)
            .cloned()
        {
            return Ok((cache_key, events));
        }
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        let source_events = with_storage_path_lock(&guard_path, || {
            let durable = read_session_kernel_v2_public_agent_events_unlocked(
                self.sessions_dir.as_ref(),
                session_id,
            )?;
            let frozen_count = usize::try_from(frozen.source_event_version).map_err(|_| {
                HostV2StorageError::conflict(
                    "host_session_prior_events_version_invalid",
                    "Frozen prior Session event version is not representable",
                )
            })?;
            if durable.len() < frozen_count {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_events_prefix_missing",
                    "Durable Session history no longer covers the frozen Run prefix",
                ));
            }
            let source_events = durable[..frozen_count].to_vec();
            let source_value = Value::Array(source_events.clone());
            if canonical_json_bytes(&source_value)?.len() > MAX_PRIOR_EVENTS_PROJECTION_BYTES_V2 {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_events_projection_limit_exceeded",
                    "Frozen Session history exceeds the bounded full-timeline projection limit",
                ));
            }
            if canonical_sha256(&source_value)? != frozen.source_events_digest {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_events_source_digest_mismatch",
                    "Durable Session history does not match the Run-bound frozen prefix",
                ));
            }
            let suffix_start = frozen_count
                .checked_sub(frozen.events.len())
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_session_prior_events_suffix_invalid",
                        "Frozen prior Session event suffix is inconsistent",
                    )
                })?;
            if source_events[suffix_start..] != frozen.events {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_events_suffix_mismatch",
                    "Durable Session history does not match the bounded Run bootstrap suffix",
                ));
            }
            Ok(Arc::new(source_events))
        })?;
        let mut prefixes = self.prior_event_prefixes.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_session_prior_events_cache_unavailable",
                "Prior Session event cache is unavailable",
            )
        })?;
        if prefixes.len() >= MAX_PRIOR_EVENTS_PAGE_CACHE_V2 {
            if let Some(oldest_key) = prefixes.keys().next().cloned() {
                prefixes.remove(&oldest_key);
            }
        }
        let events = prefixes
            .entry(cache_key.clone())
            .or_insert_with(|| Arc::clone(&source_events))
            .clone();
        Ok((cache_key, events))
    }

    pub(crate) fn status(&self) -> Value {
        let (run_count, projection_count) = self
            .projections
            .lock()
            .map(|projections| {
                (
                    projections.len(),
                    projections.values().map(BTreeMap::len).sum::<usize>(),
                )
            })
            .unwrap_or_default();
        json!({
            "status": "ready",
            "cachedRunCount": run_count,
            "cachedProjectionCount": projection_count
        })
    }

    fn preflight_public_projection(
        &self,
        session_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
    ) -> Result<(), HostV2StorageError> {
        let incoming_event_id = public_agent_event_id(&request.agent_event)?;
        let events = read_session_kernel_v2_public_agent_events_unlocked(
            self.sessions_dir.as_ref(),
            session_id,
        )?;
        let (anticipated_event_count, agent_event_replayed) = match events
            .iter()
            .find(|event| public_agent_event_id(event).ok() == Some(incoming_event_id))
        {
            Some(existing) if existing == &request.agent_event => (events.len() as u64, true),
            Some(_) => {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_event_identity_conflict",
                    "Session public AgentEvent id has different durable content",
                ))
            }
            None => (
                (events.len() as u64).checked_add(1).ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "session_kernel_public_event_limit",
                        "Session public AgentEvent count is exhausted",
                    )
                })?,
                false,
            ),
        };
        let incoming = public_timeline_record(request)?;
        let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
        let records = read_public_timeline_records(&path, session_id)?;
        if let Some(existing) = records
            .iter()
            .find(|record| record.projection_id == request.projection_id)
        {
            if existing == &incoming && agent_event_replayed {
                return Ok(());
            }
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_identity_conflict",
                "Session public timeline projection has different durable content",
            ));
        }
        if incoming.source_event_version != anticipated_event_count {
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_event_gap",
                "Session public timeline does not cover the exact durable AgentEvent prefix",
            ));
        }
        if let Some(latest) = records.last() {
            if incoming.timeline_revision <= latest.timeline_revision
                || incoming.source_event_version <= latest.source_event_version
            {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_timeline_stale",
                    "Session public timeline revision cannot replace a newer durable snapshot",
                ));
            }
        }
        validate_preserved_legacy_prefix(&records, &request.timeline)?;
        Ok(())
    }

    fn preflight_public_projection_appends(
        &self,
        session_id: &str,
        host_run_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
        host_projection_replayed: bool,
    ) -> Result<(), HostV2StorageError> {
        let projection_path = self.projection_path(session_id, host_run_id)?;
        if !host_projection_replayed {
            let projection_value = serde_json::to_value(request).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_projection_record_invalid",
                    format!("encode Host projection record: {error}"),
                )
            })?;
            let record_count = read_bounded_json_lines(&projection_path)?.len();
            preflight_projection_store_append(&projection_path, record_count, &projection_value)?;
        }

        let agent_record = HostSessionPublicAgentEventRecordV2 {
            schema_version: HOST_SESSION_PUBLIC_AGENT_EVENT_V2_SCHEMA.to_string(),
            projection_id: request.projection_id.clone(),
            projection_digest: request.projection_digest.clone(),
            agent_event_digest: canonical_sha256(&request.agent_event)?,
            agent_event: request.agent_event.clone(),
        };
        let agent_path = public_agent_event_path(self.sessions_dir.as_ref(), session_id)?;
        let agent_values = read_bounded_json_lines(&agent_path)?;
        let mut agent_replayed = false;
        for value in &agent_values {
            let existing = decode_public_agent_event_record(value.clone(), session_id)?;
            if public_agent_event_id(&existing.agent_event)?
                == public_agent_event_id(&agent_record.agent_event)?
            {
                if existing != agent_record {
                    return Err(HostV2StorageError::conflict(
                        "session_kernel_public_event_identity_conflict",
                        "Session public AgentEvent id has different durable content",
                    ));
                }
                agent_replayed = true;
                break;
            }
        }
        if !agent_replayed {
            let agent_value = serde_json::to_value(&agent_record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_public_event_invalid",
                    format!("encode Session public AgentEvent: {error}"),
                )
            })?;
            preflight_projection_store_append(&agent_path, agent_values.len(), &agent_value)?;
        }

        let timeline_record = public_timeline_record(request)?;
        let timeline_path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
        let timeline_records = read_public_timeline_records(&timeline_path, session_id)?;
        let timeline_replayed = timeline_records
            .iter()
            .find(|existing| existing.projection_id == request.projection_id)
            .is_some_and(|existing| existing == &timeline_record);
        if !timeline_replayed {
            let timeline_value = serde_json::to_value(&timeline_record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_public_timeline_invalid",
                    format!("encode Session public timeline: {error}"),
                )
            })?;
            preflight_projection_store_append(
                &timeline_path,
                timeline_records.len(),
                &timeline_value,
            )?;
        }
        Ok(())
    }

    fn publish_agent_event_locked(
        &self,
        session_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
    ) -> Result<(), HostV2StorageError> {
        let record = HostSessionPublicAgentEventRecordV2 {
            schema_version: HOST_SESSION_PUBLIC_AGENT_EVENT_V2_SCHEMA.to_string(),
            projection_id: request.projection_id.clone(),
            projection_digest: request.projection_digest.clone(),
            agent_event_digest: canonical_sha256(&request.agent_event)?,
            agent_event: request.agent_event.clone(),
        };
        let path = public_agent_event_path(self.sessions_dir.as_ref(), session_id)?;
        for value in read_bounded_json_lines(&path)? {
            let existing = decode_public_agent_event_record(value, session_id)?;
            if public_agent_event_id(&existing.agent_event)?
                == public_agent_event_id(&record.agent_event)?
            {
                if existing == record {
                    return Ok(());
                }
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_event_identity_conflict",
                    "Session public AgentEvent id has different durable content",
                ));
            }
        }
        append_json_line_durable(
            &path,
            &serde_json::to_value(record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_public_event_invalid",
                    format!("encode Session public AgentEvent: {error}"),
                )
            })?,
        )
    }

    fn publish_timeline_locked(
        &self,
        session_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
    ) -> Result<(), HostV2StorageError> {
        let record = public_timeline_record(request)?;
        let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
        let records = read_public_timeline_records(&path, session_id)?;
        if let Some(existing) = records
            .iter()
            .find(|existing| existing.projection_id == request.projection_id)
        {
            if existing == &record {
                return Ok(());
            }
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_identity_conflict",
                "Session public timeline projection has different durable content",
            ));
        }
        append_json_line_durable(
            &path,
            &serde_json::to_value(record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_public_timeline_invalid",
                    format!("encode Session public timeline: {error}"),
                )
            })?,
        )
    }

    pub(crate) fn latest_timeline(
        &self,
        session_id: &str,
    ) -> Result<Option<Value>, HostV2StorageError> {
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        with_storage_path_lock(&guard_path, || {
            let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
            let records = read_public_timeline_records(&path, session_id)?;
            records
                .last()
                .map(|record| normalize_latest_public_timeline(&record.timeline))
                .transpose()
        })
    }

    fn remember_projection(
        &self,
        session_id: &str,
        host_run_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
    ) -> Result<(), HostV2StorageError> {
        let key = format!("{session_id}\0{host_run_id}");
        let mapped = request.agent_event.clone();
        let mut projections = self.projections.lock().map_err(|_| {
            HostV2StorageError::io(
                "session_kernel_projection_cache_unavailable",
                "Session Kernel projection cache is unavailable",
            )
        })?;
        let run = projections.entry(key).or_default();
        if let Some((digest, _)) = run.get(&request.projection_id) {
            if digest != &request.projection_digest {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_projection_identity_conflict",
                    "Session Kernel projection cache has different immutable content",
                ));
            }
            return Ok(());
        }
        run.insert(
            request.projection_id.clone(),
            (request.projection_digest.clone(), mapped),
        );
        Ok(())
    }

    fn projection_path(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<PathBuf, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        Ok(self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join("host-projections")
            .join(format!("{}.jsonl", sha256_path_component(host_run_id))))
    }
}

fn preflight_projection_store_append(
    path: &FsPath,
    record_count: usize,
    value: &Value,
) -> Result<(), HostV2StorageError> {
    preflight_store_append(path, record_count, value).map_err(|error| {
        if matches!(
            error.code,
            "host_v2_storage_limit_exceeded" | "host_v2_storage_record_invalid"
        ) {
            HostV2StorageError::conflict(
                "session_kernel_projection_limit_exceeded",
                "Session projection would exceed the bounded durable Host projection store",
            )
        } else {
            error
        }
    })
}

fn projection_request_replayed(
    path: &FsPath,
    session_id: &str,
    host_run_id: &str,
    request: &SessionKernelHostProjectionRequestV2,
) -> Result<bool, HostV2StorageError> {
    for value in read_bounded_json_lines(path)? {
        let existing: SessionKernelHostProjectionRequestV2 = serde_json::from_value(value)
            .map_err(|error| {
                HostV2StorageError::conflict(
                    "session_kernel_projection_history_corrupt",
                    format!("decode Host projection record: {error}"),
                )
            })?;
        validate_projection_request(&existing, session_id, host_run_id).map_err(|error| {
            HostV2StorageError::conflict("session_kernel_projection_history_corrupt", error.message)
        })?;
        if existing.projection_id != request.projection_id {
            continue;
        }
        if existing.projection_digest == request.projection_digest
            && existing.event == request.event
            && existing.agent_event == request.agent_event
            && existing.timeline == request.timeline
        {
            return Ok(true);
        }
        return Err(HostV2StorageError::conflict(
            "session_kernel_projection_identity_conflict",
            "Session Kernel projectionId has different durable content",
        ));
    }
    Ok(false)
}

fn validate_projection_request(
    request: &SessionKernelHostProjectionRequestV2,
    session_id: &str,
    host_run_id: &str,
) -> Result<(), HostV2StorageError> {
    if request.schema_version != SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_schema_unsupported",
            "Session Kernel projection request has an unsupported schema",
        ));
    }
    if request.session_id != session_id
        || request.host_run_id != host_run_id
        || request.projection_id != request.event.projection_id
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_identity_mismatch",
            "Session Kernel projection identities do not match the route or event",
        ));
    }
    validate_safe_session_identity(session_id)?;
    for (field, value) in [
        ("hostRunId", host_run_id),
        ("projectionId", request.projection_id.as_str()),
        ("projectionDigest", request.projection_digest.as_str()),
        ("runId", request.event.run_id.as_str()),
        ("recordedAt", request.event.recorded_at.as_str()),
    ] {
        validate_bounded_identity(value, field, 512)?;
    }
    if !matches!(
        request.event.kind.as_str(),
        "plan.persisted"
            | "plan.decided"
            | "input.persisted"
            | "scope.previewed"
            | "provider.started"
            | "provider.completed"
            | "provider.stale"
            | "toolIntent.submitted"
            | "capability.awaiting"
            | "kernelFacts.reconciled"
            | "authorization.decided"
            | "review.revised"
            | "planAction.skipped"
            | "planAction.completed"
            | "run.cancelled"
            | "wait.changed"
            | "diagnostic"
    ) {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_kind_invalid",
            "Session Kernel projection kind is not supported",
        ));
    }
    let event = serde_json::to_value(&request.event).map_err(|error| {
        HostV2StorageError::invalid(
            "session_kernel_projection_record_invalid",
            format!("encode Session Kernel projection event: {error}"),
        )
    })?;
    reject_transport_capabilities(&event)?;
    validate_public_agent_event(
        &request.agent_event,
        session_id,
        Some((&request.projection_id, &request.event.recorded_at)),
    )?;
    reject_transport_capabilities(&request.timeline)?;
    crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
        &request.timeline,
    )
    .map_err(|message| {
        HostV2StorageError::invalid("session_kernel_public_timeline_invalid", message)
    })?;
    if request.timeline.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_timeline_identity_mismatch",
            "Session public timeline belongs to another Session",
        ));
    }
    let projection_payload = json!({
        "event": event,
        "agentEvent": request.agent_event,
        "timeline": request.timeline
    });
    if canonical_sha256(&projection_payload)? != request.projection_digest {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_digest_mismatch",
            "Session Kernel projection failed digest verification",
        ));
    }
    Ok(())
}

fn prior_events_continuation(
    next_event_index: usize,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
    frozen: &HostSessionPriorEventsV2,
) -> Result<String, HostV2StorageError> {
    let digest = canonical_sha256(&json!({
        "schemaVersion": "deepcode.host.session-prior-events-continuation.v2",
        "sessionId": session_id,
        "hostRunId": host_run_id,
        "runId": run_id,
        "sourceEventVersion": frozen.source_event_version,
        "sourceEventsDigest": frozen.source_events_digest,
        "snapshotDigest": frozen.snapshot_digest,
        "nextEventIndex": next_event_index,
    }))?;
    Ok(format!(
        "v2.{next_event_index}.{}",
        digest.strip_prefix("sha256:").unwrap_or(&digest)
    ))
}

fn decode_prior_events_continuation(
    continuation: Option<&str>,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
    frozen: &HostSessionPriorEventsV2,
) -> Result<usize, HostV2StorageError> {
    let Some(continuation) = continuation else {
        return Ok(0);
    };
    validate_bounded_identity(continuation, "continuation", 256)?;
    let mut fields = continuation.split('.');
    if fields.next() != Some("v2") {
        return Err(HostV2StorageError::invalid(
            "host_session_prior_events_continuation_invalid",
            "Prior Session event continuation is invalid",
        ));
    }
    let index = fields
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_session_prior_events_continuation_invalid",
                "Prior Session event continuation is invalid",
            )
        })?;
    if fields.next().is_none() || fields.next().is_some() {
        return Err(HostV2StorageError::invalid(
            "host_session_prior_events_continuation_invalid",
            "Prior Session event continuation is invalid",
        ));
    }
    if prior_events_continuation(index, session_id, host_run_id, run_id, frozen)? != continuation {
        return Err(HostV2StorageError::invalid(
            "host_session_prior_events_continuation_invalid",
            "Prior Session event continuation does not match the frozen Run prefix",
        ));
    }
    Ok(index)
}

pub(crate) fn read_session_kernel_v2_public_agent_events(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<Vec<Value>, HostV2StorageError> {
    let guard_path = public_projection_guard_path(sessions_dir, session_id)?;
    with_storage_path_lock(&guard_path, || {
        read_session_kernel_v2_public_agent_events_unlocked(sessions_dir, session_id)
    })
}

fn read_session_kernel_v2_public_agent_events_unlocked(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<Vec<Value>, HostV2StorageError> {
    let path = public_agent_event_path(sessions_dir, session_id)?;
    let mut events = Vec::new();
    let mut events_by_id = HashMap::new();
    for value in read_bounded_json_lines(&path)? {
        let record = decode_public_agent_event_record(value, session_id)?;
        let event_id = public_agent_event_id(&record.agent_event)?.to_string();
        if let Some(existing) = events_by_id.get(&event_id) {
            if existing != &record.agent_event {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_event_identity_conflict",
                    "Session public AgentEvent history has conflicting event content",
                ));
            }
            continue;
        }
        events_by_id.insert(event_id, record.agent_event.clone());
        events.push(record.agent_event);
    }
    Ok(events)
}

fn public_projection_guard_path(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<PathBuf, HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    Ok(sessions_dir
        .join(session_id)
        .join("kernel-v2")
        .join(".public-projection-v2.lock"))
}

fn public_agent_event_path(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<PathBuf, HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    Ok(sessions_dir
        .join(session_id)
        .join("kernel-v2")
        .join("public-agent-events.jsonl"))
}

fn public_timeline_path(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<PathBuf, HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    Ok(sessions_dir
        .join(session_id)
        .join("kernel-v2")
        .join("public-timelines.jsonl"))
}

fn read_public_timeline_records(
    path: &FsPath,
    session_id: &str,
) -> Result<Vec<HostSessionPublicTimelineRecordV2>, HostV2StorageError> {
    let mut records: Vec<HostSessionPublicTimelineRecordV2> = Vec::new();
    let mut projections = HashMap::new();
    let mut legacy_prefix: Option<Vec<Value>> = None;
    let mut latest_flat_was_unsupported = false;
    let mut work_segments_shape_seen = false;
    for value in read_bounded_json_lines(path)? {
        let record: HostSessionPublicTimelineRecordV2 =
            serde_json::from_value(value).map_err(|error| {
                HostV2StorageError::conflict(
                    "session_kernel_public_timeline_history_corrupt",
                    format!("decode Session public timeline record: {error}"),
                )
            })?;
        if record.schema_version != HOST_SESSION_PUBLIC_TIMELINE_V2_SCHEMA
            || canonical_sha256(&record.timeline)? != record.timeline_digest
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Session public timeline failed schema or digest validation",
            ));
        }
        reject_transport_capabilities(&record.timeline)?;
        let timeline_kind =
            crate::session_public_projection_v2::classify_shared_projection_timeline(
                &record.timeline,
            )
            .map_err(|message| {
                HostV2StorageError::conflict(
                    "session_kernel_public_timeline_history_corrupt",
                    message,
                )
            })?;
        match timeline_kind {
            crate::session_public_projection_v2::SharedProjectionTimelineKind::LegacyFlatV2 => {
                if work_segments_shape_seen {
                    return Err(HostV2StorageError::conflict(
                        "session_kernel_public_timeline_history_corrupt",
                        "Session public timeline cannot downgrade from work-segments to flat-v2",
                    ));
                }
                latest_flat_was_unsupported = !legacy_flat_projection_is_terminal(&record.timeline);
                legacy_prefix = if latest_flat_was_unsupported {
                    None
                } else {
                    Some(normalized_turns_from_settled_flat(&record.timeline)?)
                };
            }
            crate::session_public_projection_v2::SharedProjectionTimelineKind::NativeWorkSegmentsV1 => {
                if latest_flat_was_unsupported {
                    return Err(HostV2StorageError::conflict(
                        "UnsupportedHistorySchema",
                        "Active flat-v2 Session projection lacks ordered work segments and cannot be resumed",
                    ));
                }
                let compatible_prefix_len =
                    crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
                        &record.timeline,
                    )
                    .map_err(|message| {
                        HostV2StorageError::conflict(
                            "session_kernel_public_timeline_history_corrupt",
                            message,
                        )
                    })?;
                match legacy_prefix.as_deref() {
                    Some(prefix) => ensure_legacy_turn_prefix(
                        &record.timeline,
                        prefix,
                        compatible_prefix_len,
                    )?,
                    None if compatible_prefix_len > 0 => {
                        return Err(HostV2StorageError::conflict(
                            "session_kernel_public_timeline_history_corrupt",
                            "Session public timeline created legacy-compatible turns without a settled flat-v2 source",
                        ))
                    }
                    None => {}
                }
                work_segments_shape_seen = true;
            }
        }
        if record.timeline.get("sessionId").and_then(Value::as_str) != Some(session_id)
            || timeline_u64(&record.timeline, "revision")? != record.timeline_revision
            || timeline_u64(&record.timeline, "sourceEventVersion")? != record.source_event_version
            || timeline_u64(&record.timeline, "eventCount")? > record.source_event_version
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Session public timeline record has inconsistent identity or version",
            ));
        }
        if let Some(existing) = projections.get(&record.projection_id) {
            if existing != &record {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_timeline_identity_conflict",
                    "Session public timeline history has conflicting projection content",
                ));
            }
            continue;
        }
        if let Some(previous) = records.last() {
            if record.timeline_revision <= previous.timeline_revision
                || record.source_event_version <= previous.source_event_version
            {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_timeline_history_corrupt",
                    "Session public timeline history is not strictly monotonic",
                ));
            }
        }
        projections.insert(record.projection_id.clone(), record.clone());
        records.push(record);
    }
    Ok(records)
}

fn validate_preserved_legacy_prefix(
    records: &[HostSessionPublicTimelineRecordV2],
    incoming: &Value,
) -> Result<(), HostV2StorageError> {
    let compatible_prefix_len =
        crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
            incoming,
        )
        .map_err(|message| {
            HostV2StorageError::invalid("session_kernel_public_timeline_invalid", message)
        })?;
    let mut legacy_prefix = None;
    let mut latest_flat_was_unsupported = false;
    for record in records {
        match crate::session_public_projection_v2::classify_shared_projection_timeline(
            &record.timeline,
        )
        .map_err(|message| {
            HostV2StorageError::conflict("session_kernel_public_timeline_history_corrupt", message)
        })? {
            crate::session_public_projection_v2::SharedProjectionTimelineKind::LegacyFlatV2 => {
                latest_flat_was_unsupported = !legacy_flat_projection_is_terminal(&record.timeline);
                legacy_prefix = if latest_flat_was_unsupported {
                    None
                } else {
                    Some(normalized_turns_from_settled_flat(&record.timeline)?)
                };
            }
            crate::session_public_projection_v2::SharedProjectionTimelineKind::NativeWorkSegmentsV1 => {
                latest_flat_was_unsupported = false;
            }
        }
    }
    if latest_flat_was_unsupported {
        return Err(HostV2StorageError::conflict(
            "UnsupportedHistorySchema",
            "Active flat-v2 Session projection lacks ordered work segments and cannot be resumed",
        ));
    }
    match legacy_prefix.as_deref() {
        Some(prefix) => ensure_legacy_turn_prefix(incoming, prefix, compatible_prefix_len),
        None if compatible_prefix_len > 0 => Err(HostV2StorageError::invalid(
            "session_kernel_public_timeline_legacy_source_missing",
            "Session public timeline cannot create legacy-compatible turns without a settled flat-v2 source",
        )),
        None => Ok(()),
    }
}

fn normalized_turns_from_settled_flat(timeline: &Value) -> Result<Vec<Value>, HostV2StorageError> {
    let normalized = normalize_settled_legacy_flat_projection(timeline)?;
    normalized
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Settled flat-v2 Session projection does not contain turns",
            )
        })
}

fn ensure_legacy_turn_prefix(
    timeline: &Value,
    legacy_prefix: &[Value],
    compatible_prefix_len: usize,
) -> Result<(), HostV2StorageError> {
    let turns = timeline
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_public_timeline_invalid",
                "Session public timeline does not contain turns",
            )
        })?;
    if compatible_prefix_len > legacy_prefix.len()
        || turns.len() < legacy_prefix.len()
        || turns[..legacy_prefix.len()] != *legacy_prefix
    {
        return Err(HostV2StorageError::conflict(
            "session_kernel_public_timeline_legacy_prefix_changed",
            "Session public timeline changed the immutable settled flat-v2 turn prefix",
        ));
    }
    Ok(())
}

fn normalize_latest_public_timeline(timeline: &Value) -> Result<Value, HostV2StorageError> {
    match crate::session_public_projection_v2::classify_shared_projection_timeline(timeline)
        .map_err(|message| {
            HostV2StorageError::conflict("session_kernel_public_timeline_history_corrupt", message)
        })? {
        crate::session_public_projection_v2::SharedProjectionTimelineKind::NativeWorkSegmentsV1 => {
            Ok(timeline.clone())
        }
        crate::session_public_projection_v2::SharedProjectionTimelineKind::LegacyFlatV2 => {
            if !legacy_flat_projection_is_terminal(timeline) {
                return Err(HostV2StorageError::conflict(
                    "UnsupportedHistorySchema",
                    "Active flat-v2 Session projection lacks ordered work segments and cannot be resumed",
                ));
            }
            normalize_settled_legacy_flat_projection(timeline)
        }
    }
}

fn legacy_flat_projection_is_terminal(timeline: &Value) -> bool {
    let turns = timeline
        .get("turns")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let turns_are_terminal = turns.iter().all(|turn| {
        matches!(
            turn.get("status").and_then(Value::as_str),
            Some("completed" | "cancelled" | "failed")
        )
    });
    let run_is_terminal = timeline
        .get("runProjection")
        .and_then(Value::as_object)
        .map(|run| {
            run.get("phase").and_then(Value::as_str) == Some("settled")
                && matches!(
                    run.get("status").and_then(Value::as_str),
                    Some("succeeded" | "failed" | "cancelled")
                )
        });
    turns_are_terminal && run_is_terminal.unwrap_or(false)
}

fn normalize_settled_legacy_flat_projection(timeline: &Value) -> Result<Value, HostV2StorageError> {
    let mut normalized = timeline.clone();
    let root = normalized.as_object_mut().ok_or_else(|| {
        HostV2StorageError::conflict(
            "session_kernel_public_timeline_history_corrupt",
            "Legacy Session projection root is not an object",
        )
    })?;
    root.insert(
        "shapeVersion".to_string(),
        Value::String("deepcode.shared-conversation.work-segments.v1".to_string()),
    );
    if let Some(run) = root.get_mut("runProjection").and_then(Value::as_object_mut) {
        run.remove("waitReason");
        run.remove("activeInteractionId");
        run.insert("currentActivity".to_string(), Value::Null);
        run.insert("wait".to_string(), Value::Null);
    }
    let turns = root
        .get_mut("turns")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Legacy Session projection does not contain turns",
            )
        })?;
    for turn in turns {
        let turn = turn.as_object_mut().ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Legacy Session projection contains an invalid turn",
            )
        })?;
        let parts = turn
            .get("blocks")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_public_timeline_history_corrupt",
                    "Legacy Session projection turn does not contain blocks",
                )
            })?
            .iter()
            .map(|block| {
                let block_id = block.get("id").and_then(Value::as_str).ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "session_kernel_public_timeline_history_corrupt",
                        "Legacy Session projection contains a block without an identity",
                    )
                })?;
                Ok(json!({
                    "kind": "block",
                    "blockId": block_id,
                }))
            })
            .collect::<Result<Vec<_>, HostV2StorageError>>()?;
        turn.insert("workSegments".to_string(), Value::Array(Vec::new()));
        turn.insert("parts".to_string(), Value::Array(parts));
    }
    Ok(normalized)
}

fn public_timeline_record(
    request: &SessionKernelHostProjectionRequestV2,
) -> Result<HostSessionPublicTimelineRecordV2, HostV2StorageError> {
    let timeline_revision = timeline_u64(&request.timeline, "revision")?;
    let source_event_version = timeline_u64(&request.timeline, "sourceEventVersion")?;
    if timeline_u64(&request.timeline, "eventCount")? > source_event_version {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_timeline_version_mismatch",
            "Session public timeline eventCount exceeds sourceEventVersion",
        ));
    }
    Ok(HostSessionPublicTimelineRecordV2 {
        schema_version: HOST_SESSION_PUBLIC_TIMELINE_V2_SCHEMA.to_string(),
        projection_id: request.projection_id.clone(),
        projection_digest: request.projection_digest.clone(),
        timeline_revision,
        source_event_version,
        timeline_digest: canonical_sha256(&request.timeline)?,
        timeline: request.timeline.clone(),
    })
}

fn timeline_u64(timeline: &Value, field: &'static str) -> Result<u64, HostV2StorageError> {
    timeline.get(field).and_then(Value::as_u64).ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_public_timeline_invalid",
            format!("Session public timeline requires a safe integer {field}"),
        )
    })
}

fn decode_public_agent_event_record(
    value: Value,
    session_id: &str,
) -> Result<HostSessionPublicAgentEventRecordV2, HostV2StorageError> {
    let record: HostSessionPublicAgentEventRecordV2 =
        serde_json::from_value(value).map_err(|error| {
            HostV2StorageError::conflict(
                "session_kernel_public_event_history_corrupt",
                format!("decode Session public AgentEvent record: {error}"),
            )
        })?;
    if record.schema_version != HOST_SESSION_PUBLIC_AGENT_EVENT_V2_SCHEMA
        || canonical_sha256(&record.agent_event)? != record.agent_event_digest
    {
        return Err(HostV2StorageError::conflict(
            "session_kernel_public_event_history_corrupt",
            "Session public AgentEvent record failed schema or digest validation",
        ));
    }
    validate_public_agent_event(&record.agent_event, session_id, None).map_err(|error| {
        HostV2StorageError::conflict("session_kernel_public_event_history_corrupt", error.message)
    })?;
    Ok(record)
}

fn validate_public_agent_event(
    event: &Value,
    session_id: &str,
    expected: Option<(&str, &str)>,
) -> Result<(), HostV2StorageError> {
    reject_transport_capabilities(event)?;
    let object = event.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_public_event_invalid",
            "Session public AgentEvent must be an object",
        )
    })?;
    for field in ["id", "sessionId", "ts", "kind"] {
        let value = object.get(field).and_then(Value::as_str).ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_public_event_invalid",
                format!("Session public AgentEvent requires {field}"),
            )
        })?;
        validate_bounded_identity(value, field, 64 * 1024)?;
    }
    if object.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || !object.contains_key("payload")
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_event_identity_mismatch",
            "Session public AgentEvent does not match the Session or has no payload",
        ));
    }
    if object.get("kind").and_then(Value::as_str) == Some("user_msg") {
        let attachments = object
            .get("payload")
            .and_then(Value::as_object)
            .and_then(|payload| payload.get("attachments"))
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "session_kernel_public_event_attachment_invalid",
                    "Session v2 user event requires the exact nested attachment DTO",
                )
            })?;
        deepcode_kernel_abi::decode_agent_input_attachments_v2(attachments).map_err(|error| {
            HostV2StorageError::invalid(
                "session_kernel_public_event_attachment_invalid",
                format!(
                    "Session v2 user event has invalid attachments: {}",
                    error.code
                ),
            )
        })?;
    }
    if let Some((projection_id, recorded_at)) = expected {
        let expected_id = format!("kernel-v2:{projection_id}");
        if object.get("id").and_then(Value::as_str) != Some(expected_id.as_str())
            || object.get("ts").and_then(Value::as_str) != Some(recorded_at)
        {
            return Err(HostV2StorageError::invalid(
                "session_kernel_public_event_identity_mismatch",
                "Session public AgentEvent does not match the private projection identity",
            ));
        }
    } else if !object
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|value| value.starts_with("kernel-v2:"))
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_event_identity_mismatch",
            "Session public AgentEvent has an invalid v2 event identity",
        ));
    }
    Ok(())
}

fn public_agent_event_id(event: &Value) -> Result<&str, HostV2StorageError> {
    event.get("id").and_then(Value::as_str).ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_public_event_invalid",
            "Session public AgentEvent has no event id",
        )
    })
}

fn session_private_write_unavailable_response(
    state: &AppState,
    session_id: &str,
) -> Option<Response> {
    let gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.session_metadata_error.as_deref() {
        return Some(v2_error_response(
            StatusCode::CONFLICT,
            "unsupported_history_schema",
            error,
        ));
    }
    if let Err(response) = crate::verified_selectable_session(&gui, session_id) {
        let payload = response.0;
        let code = payload
            .error
            .as_deref()
            .unwrap_or("agent_session_unavailable");
        let message = payload
            .message
            .as_deref()
            .unwrap_or("Session private storage is unavailable");
        let status = if code == "agent_session_not_found" {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::CONFLICT
        };
        return Some(v2_error_response(status, code, message));
    }
    None
}

pub(crate) async fn session_kernel_v2_store_get(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session Kernel v2 persistence accepts only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let store = state.host_services.session_kernel_v2.clone();
    let read_session_id = session_id.clone();
    let read_run_id = run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        store.list(&read_session_id, &read_run_id, &capability)
    })
    .await
    {
        Ok(Ok(records)) => v2_success_response(
            StatusCode::OK,
            &SessionKernelPersistenceListReplyV2 {
                schema_version: SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA,
                session_id,
                run_id,
                records,
            },
        ),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_kernel_persistence_task_failed",
            "Session Kernel persistence read task failed",
        ),
    }
}

pub(crate) async fn session_kernel_v2_store_append(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<SessionKernelPersistenceAppendRequestV2>, JsonRejection>,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session Kernel v2 persistence accepts only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let Json(request) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return v2_error_response(
                rejection.status(),
                "session_kernel_persistence_request_invalid",
                "Session Kernel persistence request body is invalid",
            )
        }
    };
    let store = state.host_services.session_kernel_v2.clone();
    let write_session_id = session_id.clone();
    let write_run_id = run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        store.append(&write_session_id, &write_run_id, &capability, request)
    })
    .await
    {
        Ok(Ok(reply)) => v2_success_response(StatusCode::OK, &reply),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_kernel_persistence_task_failed",
            "Session Kernel persistence append task failed",
        ),
    }
}

pub(crate) async fn session_kernel_v2_store_record_get(
    State(state): State<AppState>,
    Path((session_id, run_id, record_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session Kernel v2 persistence accepts only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let store = state.host_services.session_kernel_v2.clone();
    let read_session_id = session_id.clone();
    let read_run_id = run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        store.get_record(&read_session_id, &read_run_id, &record_id, &capability)
    })
    .await
    {
        Ok(Ok(record)) => v2_success_response(StatusCode::OK, &record),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_kernel_persistence_task_failed",
            "Session Kernel persistence record read task failed",
        ),
    }
}

pub(crate) async fn session_kernel_v2_projection_append(
    State(state): State<AppState>,
    Path((session_id, host_run_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<SessionKernelHostProjectionRequestV2>, JsonRejection>,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_projection_origin_forbidden",
            "Session Kernel v2 projection accepts only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let Json(request) = match body {
        Ok(body) => body,
        Err(rejection) => {
            let code = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                "session_kernel_projection_limit_exceeded"
            } else {
                "session_kernel_projection_request_invalid"
            };
            return v2_error_response(
                rejection.status(),
                code,
                "Session Kernel projection request body is invalid",
            );
        }
    };
    let sink = state.host_services.projection_v2.clone();
    let write_session_id = session_id.clone();
    let write_host_run_id = host_run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        sink.publish(&write_session_id, &write_host_run_id, &capability, request)
    })
    .await
    {
        Ok(Ok(reply)) => v2_success_response(StatusCode::OK, &reply),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_kernel_projection_task_failed",
            "Session Kernel projection task failed",
        ),
    }
}

pub(crate) async fn session_kernel_v2_prior_events_page(
    State(state): State<AppState>,
    Path((session_id, host_run_id)): Path<(String, String)>,
    Query(query): Query<HostSessionPriorEventsPageQueryV2>,
    headers: HeaderMap,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "host_session_prior_events_origin_forbidden",
            "Prior Session events accept only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let active = match state
        .host_services
        .active_runs_v2
        .authorize_host_run_transport_binding(&session_id, &host_run_id, &capability)
    {
        Ok(active) => active,
        Err(error) => return storage_error_response(error),
    };
    let bootstrap = match state
        .host_services
        .kernel_operations_v2
        .get_bootstrap(&session_id, &host_run_id)
    {
        Ok(bootstrap) => bootstrap,
        Err(error) => return storage_error_response(error),
    };
    if bootstrap.run_id != active.run_id {
        return storage_error_response(HostV2StorageError::unauthorized(
            "host_run_transport_capability_invalid",
            "Host Run transport capability is invalid for this Session and Run",
        ));
    }
    let sink = state.host_services.projection_v2.clone();
    let read_session_id = session_id.clone();
    let read_host_run_id = host_run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        sink.prior_events_page(
            &read_session_id,
            &read_host_run_id,
            &bootstrap.run_id,
            &capability,
            &bootstrap.prior_session_events,
            query.continuation.as_deref(),
        )
    })
    .await
    {
        Ok(Ok(reply)) => v2_success_response(StatusCode::OK, &reply),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "host_session_prior_events_task_failed",
            "Prior Session event page read failed",
        ),
    }
}

fn storage_error_response(error: HostV2StorageError) -> Response {
    let status = match error.kind {
        HostV2StorageErrorKind::Invalid => StatusCode::BAD_REQUEST,
        HostV2StorageErrorKind::Unauthorized => StatusCode::UNAUTHORIZED,
        HostV2StorageErrorKind::Conflict => StatusCode::CONFLICT,
        HostV2StorageErrorKind::NotFound => StatusCode::NOT_FOUND,
        HostV2StorageErrorKind::Io => StatusCode::INTERNAL_SERVER_ERROR,
    };
    v2_error_response(status, error.code, &error.message)
}

fn run_transport_capability(headers: &HeaderMap) -> Result<RunCapabilityV2, HostV2StorageError> {
    let submitted = headers
        .get(RUN_TRANSPORT_CAPABILITY_HEADER)
        .ok_or_else(|| {
            HostV2StorageError::unauthorized(
                "host_run_transport_capability_required",
                "Host Run transport capability is required",
            )
        })?
        .to_str()
        .map_err(|_| {
            HostV2StorageError::unauthorized(
                "host_run_transport_capability_invalid",
                "Host Run transport capability header is invalid",
            )
        })?;
    RunCapabilityV2::new(submitted.to_string()).map_err(|_| {
        HostV2StorageError::unauthorized(
            "host_run_transport_capability_invalid",
            "Host Run transport capability header is invalid",
        )
    })
}

fn v2_success_response(status: StatusCode, data: &impl Serialize) -> Response {
    match serde_json::to_vec(&json!({ "ok": true, "data": data })) {
        Ok(body) => v2_json_response(status, body),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "host_v2_response_encode_failed",
            "Host v2 response encoding failed",
        ),
    }
}

fn v2_error_response(status: StatusCode, code: &str, message: &str) -> Response {
    let body = serde_json::to_vec(&json!({
        "ok": false,
        "error": {
            "code": code,
            "message": message
        }
    }))
    .unwrap_or_else(|_| b"{\"ok\":false,\"error\":{\"code\":\"host_v2_error\"}}".to_vec());
    v2_json_response(status, body)
}

fn v2_json_response(status: StatusCode, body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
#[path = "session_kernel_v2_store_dispatch_tests.rs"]
mod dispatch_tests;
