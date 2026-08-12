use crate::host_v2_storage::{
    append_json_line_durable, stable_json_sha256, validate_bounded_identity,
    validate_safe_session_identity, validate_sha256_digest, with_storage_path_lock,
    HostV2StorageError,
};
use crate::prelude::*;
use crate::*;
use std::io::{BufRead, BufReader};

pub(crate) const PROVIDER_CACHE_TELEMETRY_SCHEMA_V1: &str = "deepcode.provider-cache-telemetry.v1";
pub(crate) const PROVIDER_CACHE_TELEMETRY_PAGE_SCHEMA_V1: &str =
    "deepcode.provider-cache-telemetry-page.v1";
const PROVIDER_CACHE_TELEMETRY_RECORD_LIMIT_V1: usize = 64 * 1024;
const PROVIDER_CACHE_TELEMETRY_PAGE_LIMIT_V1: usize = 200;
const PROVIDER_CACHE_TELEMETRY_ARCHIVE_LIMIT_V1: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderCacheRelationV1 {
    NoBaseline,
    ExactAppend,
    ExactReplay,
    Reset,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderCacheUsageAvailabilityV1 {
    Reported,
    NotReported,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderContinuationStatusV1 {
    NotContinuation,
    Accepted,
    LocalContractRejected,
    ProviderRejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderCacheTerminalStatusV1 {
    Completed,
    Failed,
    Cancelled,
    PreflightRejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderCacheLaneTelemetryV1 {
    pub(crate) lane_id: String,
    pub(crate) lane_revision: u64,
    pub(crate) relation: ProviderCacheRelationV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) relation_kind: Option<SessionProviderCacheLaneRelationKindV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reset_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) supporting_reset_reasons: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) predecessor_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) predecessor_external_digest: Option<String>,
    pub(crate) stable_prefix_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) external_request_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) external_request_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) appended_suffix_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderCacheUsageTelemetryV1 {
    pub(crate) availability: ProviderCacheUsageAvailabilityV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) prompt_cache_hit_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider_reported_miss_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) uncached_suffix_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) completion_tokens: Option<u64>,
}

impl Default for ProviderCacheUsageTelemetryV1 {
    fn default() -> Self {
        Self {
            availability: ProviderCacheUsageAvailabilityV1::NotReported,
            prompt_cache_hit_tokens: None,
            provider_reported_miss_tokens: None,
            uncached_suffix_tokens: None,
            input_tokens: None,
            completion_tokens: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderCacheTimingTelemetryV1 {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) time_to_response_headers_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) time_to_first_upstream_byte_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) time_to_first_semantic_delta_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider_total_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderContinuationTelemetryV1 {
    pub(crate) status: ProviderContinuationStatusV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderCacheTelemetryV1 {
    pub(crate) schema_version: String,
    pub(crate) record_id: String,
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) provider_turn_id: String,
    pub(crate) request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent_request_id: Option<String>,
    pub(crate) provider_profile_id: String,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) attempt_kind: String,
    pub(crate) cache_lane: ProviderCacheLaneTelemetryV1,
    pub(crate) usage: ProviderCacheUsageTelemetryV1,
    pub(crate) timing: ProviderCacheTimingTelemetryV1,
    pub(crate) continuation: ProviderContinuationTelemetryV1,
    pub(crate) terminal_status: ProviderCacheTerminalStatusV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) trace_ref: Option<String>,
    pub(crate) recorded_at: String,
}

impl ProviderCacheTelemetryV1 {
    pub(crate) fn seal_record_id(mut self) -> Result<Self, HostV2StorageError> {
        self.record_id = self.expected_record_id()?;
        Ok(self)
    }

    fn expected_record_id(&self) -> Result<String, HostV2StorageError> {
        let mut identity = self.clone();
        identity.record_id.clear();
        let digest = stable_json_sha256(&serde_json::to_value(&identity).map_err(|error| {
            HostV2StorageError::invalid(
                "provider_cache_telemetry_encode_failed",
                format!("Encode Provider cache telemetry identity: {error}"),
            )
        })?)?;
        Ok(format!(
            "provider-cache:{}",
            digest.strip_prefix("sha256:").unwrap_or(digest.as_str())
        ))
    }

    fn validate(&self, expected_session_id: Option<&str>) -> Result<(), HostV2StorageError> {
        if self.schema_version != PROVIDER_CACHE_TELEMETRY_SCHEMA_V1 {
            return Err(HostV2StorageError::invalid(
                "provider_cache_telemetry_schema_invalid",
                "Provider cache telemetry schema is unsupported",
            ));
        }
        validate_safe_session_identity(&self.session_id)?;
        if expected_session_id.is_some_and(|expected| expected != self.session_id) {
            return Err(HostV2StorageError::invalid(
                "provider_cache_telemetry_session_mismatch",
                "Provider cache telemetry belongs to another Session",
            ));
        }
        for (value, field, limit) in [
            (self.record_id.as_str(), "recordId", 512),
            (self.run_id.as_str(), "runId", 512),
            (self.provider_turn_id.as_str(), "providerTurnId", 512),
            (self.request_id.as_str(), "requestId", 512),
            (self.provider_profile_id.as_str(), "providerProfileId", 512),
            (self.provider.as_str(), "provider", 128),
            (self.model.as_str(), "model", 512),
            (self.attempt_kind.as_str(), "attemptKind", 64),
            (self.cache_lane.lane_id.as_str(), "laneId", 512),
            (self.recorded_at.as_str(), "recordedAt", 128),
        ] {
            validate_bounded_identity(value, field, limit)?;
        }
        if let Some(parent) = &self.parent_request_id {
            validate_bounded_identity(parent, "parentRequestId", 512)?;
        }
        if let Some(parent) = &self.cache_lane.predecessor_request_id {
            validate_bounded_identity(parent, "predecessorRequestId", 512)?;
        }
        if self.cache_lane.lane_revision == 0 {
            return Err(HostV2StorageError::invalid(
                "provider_cache_telemetry_lane_invalid",
                "Provider cache lane revision must be positive",
            ));
        }
        validate_sha256_digest(&self.cache_lane.stable_prefix_digest, "stablePrefixDigest")?;
        if let Some(digest) = &self.cache_lane.external_request_digest {
            validate_sha256_digest(digest, "externalRequestDigest")?;
        }
        if let Some(digest) = &self.cache_lane.predecessor_external_digest {
            validate_sha256_digest(digest, "predecessorExternalDigest")?;
        }
        if let Some(trace_ref) = &self.trace_ref {
            validate_sha256_digest(trace_ref, "traceRef")?;
        }
        if let Some(reason) = &self.cache_lane.reset_reason {
            validate_bounded_identity(reason, "resetReason", 128)?;
        }
        if self.cache_lane.supporting_reset_reasons.len() > 15 {
            return Err(HostV2StorageError::invalid(
                "provider_cache_telemetry_reset_reasons_invalid",
                "Provider cache telemetry has too many supporting reset reasons",
            ));
        }
        let mut unique_supporting = self.cache_lane.supporting_reset_reasons.clone();
        for reason in &unique_supporting {
            validate_bounded_identity(reason, "supportingResetReason", 128)?;
            if Some(reason) == self.cache_lane.reset_reason.as_ref() {
                return Err(HostV2StorageError::invalid(
                    "provider_cache_telemetry_reset_reasons_invalid",
                    "Provider cache telemetry repeats its primary reset reason",
                ));
            }
        }
        unique_supporting.sort();
        unique_supporting.dedup();
        if unique_supporting.len() != self.cache_lane.supporting_reset_reasons.len() {
            return Err(HostV2StorageError::invalid(
                "provider_cache_telemetry_reset_reasons_invalid",
                "Provider cache telemetry supporting reset reasons are not unique",
            ));
        }
        if let Some(code) = &self.continuation.error_code {
            validate_bounded_identity(code, "errorCode", 256)?;
        }
        if self.record_id != self.expected_record_id()? {
            return Err(HostV2StorageError::conflict(
                "provider_cache_telemetry_record_digest_invalid",
                "Provider cache telemetry record digest does not match its content",
            ));
        }
        let encoded = serde_json::to_vec(self).map_err(|error| {
            HostV2StorageError::invalid(
                "provider_cache_telemetry_encode_failed",
                format!("Encode Provider cache telemetry: {error}"),
            )
        })?;
        if encoded.len() > PROVIDER_CACHE_TELEMETRY_RECORD_LIMIT_V1 {
            return Err(HostV2StorageError::invalid(
                "provider_cache_telemetry_record_too_large",
                "Provider cache telemetry exceeds its bounded record size",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
struct ProviderCacheTelemetryHealthV1 {
    sessions: HashMap<String, ProviderCacheTelemetrySessionHealthV1>,
}

#[derive(Debug, Default)]
struct ProviderCacheTelemetrySessionHealthV1 {
    write_failures: u64,
    last_error_code: Option<String>,
}

#[derive(Clone)]
pub(crate) struct ProviderCacheTelemetryStoreV1 {
    sessions_dir: Arc<PathBuf>,
    health: Arc<std::sync::Mutex<ProviderCacheTelemetryHealthV1>>,
}

impl ProviderCacheTelemetryStoreV1 {
    pub(crate) fn new(sessions_dir: PathBuf) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            health: Arc::new(std::sync::Mutex::new(
                ProviderCacheTelemetryHealthV1::default(),
            )),
        }
    }

    pub(crate) fn record(
        &self,
        record: &ProviderCacheTelemetryV1,
    ) -> Result<(), HostV2StorageError> {
        record.validate(Some(&record.session_id))?;
        let session_directory = self.sessions_dir.join(&record.session_id);
        if !session_directory.is_dir() {
            return Ok(());
        }
        let path = self.archive_path(&record.session_id)?;
        let value = serde_json::to_value(record).map_err(|error| {
            HostV2StorageError::invalid(
                "provider_cache_telemetry_encode_failed",
                format!("Encode Provider cache telemetry: {error}"),
            )
        })?;
        let result = with_storage_path_lock(&path, || append_json_line_durable(&path, &value));
        if let Err(error) = &result {
            self.note_failure(&record.session_id, error.code);
        }
        result
    }

    pub(crate) fn note_failure(&self, session_id: &str, code: &str) {
        let mut health = match self.health.lock() {
            Ok(health) => health,
            Err(poisoned) => poisoned.into_inner(),
        };
        let session = health.sessions.entry(session_id.to_string()).or_default();
        session.write_failures = session.write_failures.saturating_add(1);
        session.last_error_code = Some(code.chars().take(256).collect());
    }

    fn read_page(
        &self,
        session_id: &str,
        after: u64,
        limit: usize,
    ) -> Result<Value, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        let limit = limit.clamp(1, PROVIDER_CACHE_TELEMETRY_PAGE_LIMIT_V1);
        let path = self.archive_path(session_id)?;
        let mut records = Vec::new();
        let mut gaps = Vec::new();
        let mut next_cursor = after;
        if path.exists() {
            let metadata = fs::metadata(&path).map_err(|error| {
                HostV2StorageError::io(
                    "provider_cache_telemetry_read_failed",
                    format!("Inspect Provider cache telemetry archive: {error}"),
                )
            })?;
            if metadata.len() > PROVIDER_CACHE_TELEMETRY_ARCHIVE_LIMIT_V1 {
                return Err(HostV2StorageError::conflict(
                    "provider_cache_telemetry_archive_too_large",
                    "Provider cache telemetry archive exceeds its bounded read size",
                ));
            }
            let file = fs::File::open(&path).map_err(|error| {
                HostV2StorageError::io(
                    "provider_cache_telemetry_read_failed",
                    format!("Open Provider cache telemetry archive: {error}"),
                )
            })?;
            let mut reader = BufReader::new(file);
            let mut ordinal = 0_u64;
            loop {
                let mut line = Vec::new();
                let read = reader
                    .by_ref()
                    .take((PROVIDER_CACHE_TELEMETRY_RECORD_LIMIT_V1 + 1) as u64)
                    .read_until(b'\n', &mut line)
                    .map_err(|error| {
                        HostV2StorageError::io(
                            "provider_cache_telemetry_read_failed",
                            format!("Read Provider cache telemetry archive: {error}"),
                        )
                    })?;
                if read == 0 {
                    break;
                }
                ordinal = ordinal.saturating_add(1);
                if !line.ends_with(b"\n") {
                    gaps.push(json!({
                        "cursor": ordinal.to_string(),
                        "reasonCode": "recordTruncatedOrTooLarge",
                    }));
                    next_cursor = ordinal;
                    break;
                }
                if ordinal <= after {
                    continue;
                }
                next_cursor = ordinal;
                line.pop();
                match serde_json::from_slice::<ProviderCacheTelemetryV1>(&line) {
                    Ok(record) if record.validate(Some(session_id)).is_ok() => {
                        records.push(record);
                    }
                    _ => gaps.push(json!({
                        "cursor": ordinal.to_string(),
                        "reasonCode": "recordInvalid",
                    })),
                }
                if records.len() + gaps.len() >= limit {
                    break;
                }
            }
        }
        let health = match self.health.lock() {
            Ok(health) => health,
            Err(poisoned) => poisoned.into_inner(),
        };
        let session_health = health.sessions.get(session_id);
        let write_failures = session_health.map_or(0, |session| session.write_failures);
        let last_error_code = session_health.and_then(|session| session.last_error_code.clone());
        let degraded = !gaps.is_empty() || write_failures > 0;
        Ok(json!({
            "schemaVersion": PROVIDER_CACHE_TELEMETRY_PAGE_SCHEMA_V1,
            "sessionId": session_id,
            "records": records,
            "nextCursor": next_cursor.to_string(),
            "gaps": gaps,
            "archiveHealth": if degraded { "degraded" } else { "healthy" },
            "writeFailureCount": write_failures,
            "lastWriteErrorCode": last_error_code,
        }))
    }

    fn archive_path(&self, session_id: &str) -> Result<PathBuf, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        Ok(self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join("diagnostics")
            .join("provider-cache-telemetry.jsonl"))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderCacheTelemetryPageQueryV1 {
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

pub(crate) async fn provider_cache_telemetry_page(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<ProviderCacheTelemetryPageQueryV1>,
) -> Response {
    let after = match query.after.as_deref().unwrap_or("0").parse::<u64>() {
        Ok(value) => value,
        Err(_) => {
            return provider_cache_telemetry_error(
                StatusCode::BAD_REQUEST,
                "provider_cache_telemetry_cursor_invalid",
                "Provider cache telemetry cursor must be an unsigned integer",
            )
        }
    };
    let limit = query.limit.unwrap_or(100);
    if limit == 0 || limit > PROVIDER_CACHE_TELEMETRY_PAGE_LIMIT_V1 {
        return provider_cache_telemetry_error(
            StatusCode::BAD_REQUEST,
            "provider_cache_telemetry_limit_invalid",
            "Provider cache telemetry limit must be between 1 and 200",
        );
    }
    let io_guard = session_private_io_lock(&session_id).read_owned().await;
    {
        let gui = state.gui.lock().expect("gui state lock");
        let session = gui
            .sessions
            .iter()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id.as_str()));
        if session.is_none_or(session_is_deletion_tombstone) {
            return provider_cache_telemetry_error(
                StatusCode::CONFLICT,
                "agent_session_deletion_in_progress",
                "Session cache telemetry is unavailable because deletion is pending or complete",
            );
        }
    }
    let store = state.provider_cache_telemetry_v1.clone();
    let read_session_id = session_id.clone();
    let page = tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        store.read_page(&read_session_id, after, limit)
    })
    .await;
    match page {
        Ok(Ok(page)) => provider_cache_telemetry_json(
            StatusCode::OK,
            json!({
                "ok": true,
                "data": page,
                "error": null,
                "message": null,
            }),
        ),
        Ok(Err(error)) => provider_cache_telemetry_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            error.code,
            &error.message,
        ),
        Err(_) => provider_cache_telemetry_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "provider_cache_telemetry_task_failed",
            "Provider cache telemetry read task failed",
        ),
    }
}

fn provider_cache_telemetry_error(status: StatusCode, code: &str, message: &str) -> Response {
    provider_cache_telemetry_json(
        status,
        json!({
            "ok": false,
            "data": null,
            "error": code,
            "message": message,
        }),
    )
}

fn provider_cache_telemetry_json(status: StatusCode, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(axum::body::Body::from(
            serde_json::to_vec(&value).unwrap_or_default(),
        ))
        .unwrap_or_else(|_| Response::new(axum::body::Body::empty()))
}
