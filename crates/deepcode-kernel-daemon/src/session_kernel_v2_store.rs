use crate::host_run_broker_v2::HostActiveRunBrokerV2;
use crate::host_v2_storage::{
    append_json_line_durable, canonical_sha256, reject_transport_capabilities,
    sha256_path_component, validate_bounded_identity, validate_safe_session_identity,
    value_without_field, with_storage_path_lock, HostV2StorageError, HostV2StorageErrorKind,
};
use crate::kernel_v2_transport::RUN_TRANSPORT_CAPABILITY_HEADER;
use crate::prelude::*;
use crate::{trusted_private_storage_origin, AppState};
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
const SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA: &str =
    "deepcode.session.kernel-operation-result.v2";
const SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA: &str =
    "deepcode.session.kernel-host-projection-request.v2";
const SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA: &str =
    "deepcode.session.kernel-host-projection-reply.v2";
const HOST_SESSION_PUBLIC_AGENT_EVENT_V2_SCHEMA: &str =
    "deepcode.host.session-public-agent-event.v2";
const HOST_SESSION_PUBLIC_TIMELINE_V2_SCHEMA: &str = "deepcode.host.session-public-timeline.v2";
pub(crate) const SESSION_KERNEL_V2_BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const MAX_V2_STORE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_V2_STORE_RECORD_BYTES: usize = SESSION_KERNEL_V2_BODY_LIMIT_BYTES;
const MAX_V2_STORE_RECORDS: usize = 100_000;

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
}

impl SessionKernelProjectionSinkV2 {
    pub(crate) fn new(sessions_dir: PathBuf, active_runs: HostActiveRunBrokerV2) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            active_runs,
            projections: Arc::new(Mutex::new(HashMap::new())),
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
        let replayed = with_storage_path_lock(&path, || {
            let values = read_bounded_json_lines(&path)?;
            for value in values {
                let existing: SessionKernelHostProjectionRequestV2 = serde_json::from_value(value)
                    .map_err(|error| {
                        HostV2StorageError::conflict(
                            "session_kernel_projection_history_corrupt",
                            format!("decode Host projection record: {error}"),
                        )
                    })?;
                validate_projection_request(&existing, session_id, host_run_id).map_err(
                    |error| {
                        HostV2StorageError::conflict(
                            "session_kernel_projection_history_corrupt",
                            error.message,
                        )
                    },
                )?;
                if existing.projection_id == request.projection_id {
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
            }
            append_json_line_durable(
                &path,
                &serde_json::to_value(&request).map_err(|error| {
                    HostV2StorageError::invalid(
                        "session_kernel_projection_record_invalid",
                        format!("encode Host projection record: {error}"),
                    )
                })?,
            )?;
            Ok(false)
        })?;
        self.publish_public_projection(session_id, &request)?;
        self.remember_projection(session_id, host_run_id, &request)?;
        Ok(SessionKernelHostProjectionReplyV2 {
            schema_version: SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA,
            projection_id: request.projection_id,
            projection_digest: request.projection_digest,
            replayed,
        })
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

    fn publish_public_projection(
        &self,
        session_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
    ) -> Result<(), HostV2StorageError> {
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        with_storage_path_lock(&guard_path, || {
            self.preflight_public_projection(session_id, request)?;
            self.publish_agent_event_locked(session_id, request)?;
            self.publish_timeline_locked(session_id, request)
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
            Ok(read_public_timeline_records(&path, session_id)?
                .last()
                .map(|record| record.timeline.clone()))
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
    crate::validate_shared_projection_timeline(&request.timeline).map_err(|message| {
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

pub(crate) fn read_session_kernel_v2_public_agent_events(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<Vec<Value>, HostV2StorageError> {
    let guard_path = public_projection_guard_path(sessions_dir, session_id)?;
    with_storage_path_lock(&guard_path, || {
        read_session_kernel_v2_public_agent_events_unlocked(sessions_dir, session_id)
    })
}

pub(crate) fn merge_session_kernel_v2_public_agent_events(
    sessions_dir: &FsPath,
    session_id: &str,
    mut base_events: Vec<Value>,
) -> Result<Vec<Value>, HostV2StorageError> {
    let mut events_by_id = base_events
        .iter()
        .filter_map(|event| {
            event
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_string(), event.clone()))
        })
        .collect::<HashMap<_, _>>();
    for event in read_session_kernel_v2_public_agent_events(sessions_dir, session_id)? {
        let event_id = public_agent_event_id(&event)?.to_string();
        if let Some(existing) = events_by_id.get(&event_id) {
            if existing != &event {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_event_identity_conflict",
                    "Session AgentEvent sources have conflicting event content",
                ));
            }
            continue;
        }
        events_by_id.insert(event_id, event.clone());
        base_events.push(event);
    }
    Ok(base_events)
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
        crate::validate_shared_projection_timeline(&record.timeline).map_err(|message| {
            HostV2StorageError::conflict("session_kernel_public_timeline_history_corrupt", message)
        })?;
        if record.timeline.get("sessionId").and_then(Value::as_str) != Some(session_id)
            || timeline_u64(&record.timeline, "revision")? != record.timeline_revision
            || timeline_u64(&record.timeline, "sourceEventVersion")? != record.source_event_version
            || timeline_u64(&record.timeline, "eventCount")? != record.source_event_version
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

fn public_timeline_record(
    request: &SessionKernelHostProjectionRequestV2,
) -> Result<HostSessionPublicTimelineRecordV2, HostV2StorageError> {
    let timeline_revision = timeline_u64(&request.timeline, "revision")?;
    let source_event_version = timeline_u64(&request.timeline, "sourceEventVersion")?;
    if timeline_u64(&request.timeline, "eventCount")? != source_event_version {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_timeline_version_mismatch",
            "Session public timeline eventCount does not match sourceEventVersion",
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

pub(crate) async fn session_kernel_v2_store_get(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if !trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session Kernel v2 persistence accepts only trusted local clients",
        );
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let store = state.host_services.session_kernel_v2.clone();
    let read_session_id = session_id.clone();
    let read_run_id = run_id.clone();
    match tokio::task::spawn_blocking(move || {
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
    if !trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session Kernel v2 persistence accepts only trusted local clients",
        );
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
    if !trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session Kernel v2 persistence accepts only trusted local clients",
        );
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let store = state.host_services.session_kernel_v2.clone();
    let read_session_id = session_id.clone();
    let read_run_id = run_id.clone();
    match tokio::task::spawn_blocking(move || {
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
    if !trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_projection_origin_forbidden",
            "Session Kernel v2 projection accepts only trusted local clients",
        );
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
                "session_kernel_projection_request_invalid",
                "Session Kernel projection request body is invalid",
            )
        }
    };
    let sink = state.host_services.projection_v2.clone();
    let write_session_id = session_id.clone();
    let write_host_run_id = host_run_id.clone();
    match tokio::task::spawn_blocking(move || {
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
