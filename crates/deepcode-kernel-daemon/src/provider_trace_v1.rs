use crate::host_v2_storage::{
    append_json_line_durable, create_private_directory, sha256_path_component, sha256_prefixed,
    stable_json_sha256, sync_directory, validate_bounded_identity, validate_safe_session_identity,
    validate_sha256_digest, with_storage_path_lock, HostV2StorageError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const PROVIDER_TRACE_SCHEMA_V1: &str = "deepcode.session.provider-trace.v1";
pub(crate) const PROVIDER_TRACE_FLUSH_INTERVAL_V1: Duration = Duration::from_millis(250);
pub(crate) const PROVIDER_TRACE_FLUSH_BYTES_V1: usize = 16 * 1024;
pub(crate) const PROVIDER_TRACE_RAW_SOURCE_SOFT_LIMIT_V1: usize = 1024 * 1024;
pub(crate) const PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1: usize = 16 * 1024 * 1024;
pub(crate) const PROVIDER_TRACE_REQUEST_HARD_LIMIT_V1: usize = 16 * 1024 * 1024;
const PROVIDER_TRACE_EXPORT_CAPABILITY_LIMIT_V1: usize = 1024;
pub(crate) const PROVIDER_TRACE_EXPORT_DEADLINE_EXCEEDED_V1: &str = "export_deadline_exceeded";
// Verification has no aggregate archive-size threshold. A single record stays
// bounded by the 16 MiB source envelope, its worst-case JSON string escaping,
// and fixed trace-envelope headroom so an untrusted unterminated line cannot
// force unbounded memory growth.
const PROVIDER_TRACE_RECORD_JSON_EXPANSION_V1: usize = 6;
const PROVIDER_TRACE_RECORD_HEADROOM_V1: usize = 64 * 1024;
const PROVIDER_TRACE_RECORD_HARD_LIMIT_V1: usize = PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1
    * PROVIDER_TRACE_RECORD_JSON_EXPANSION_V1
    + PROVIDER_TRACE_RECORD_HEADROOM_V1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderTraceErrorV1 {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ProviderTraceErrorV1 {
    fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ProviderTraceErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProviderTraceErrorV1 {}

impl From<HostV2StorageError> for ProviderTraceErrorV1 {
    fn from(error: HostV2StorageError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderTraceIdentityV1 {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) user_turn_id: String,
    pub(crate) provider_turn_id: String,
    pub(crate) provider_kind: String,
    pub(crate) model: String,
    pub(crate) profile_id: String,
    pub(crate) profile_revision: String,
    pub(crate) control_epoch: u64,
    pub(crate) purpose: ProviderTracePurposeV1,
}

impl ProviderTraceIdentityV1 {
    fn validate(&self) -> Result<(), ProviderTraceErrorV1> {
        validate_safe_session_identity(&self.session_id)?;
        validate_bounded_identity(&self.run_id, "runId", 512)?;
        validate_bounded_identity(&self.user_turn_id, "userTurnId", 512)?;
        validate_bounded_identity(&self.provider_turn_id, "providerTurnId", 512)?;
        validate_bounded_identity(&self.provider_kind, "providerKind", 128)?;
        validate_bounded_identity(&self.model, "model", 512)?;
        validate_bounded_identity(&self.profile_id, "profileId", 512)?;
        validate_bounded_identity(&self.profile_revision, "profileRevision", 512)?;
        if self.control_epoch == 0 {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_control_epoch_invalid",
                "Provider trace controlEpoch must be greater than zero",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderTracePurposeV1 {
    Primary,
    Continuation,
    FinalAnswer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderTraceResponseBoundaryV1 {
    pub(crate) status_code: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) content_type: Option<String>,
}

impl ProviderTraceResponseBoundaryV1 {
    fn validate(&self) -> Result<(), ProviderTraceErrorV1> {
        if !(100..=599).contains(&self.status_code) {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_status_invalid",
                "Provider trace HTTP status must be between 100 and 599",
            ));
        }
        if let Some(content_type) = &self.content_type {
            validate_bounded_identity(content_type, "contentType", 1024)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderTraceTerminalKindV1 {
    Completed,
    Failed,
    Cancelled,
    LimitExceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderTraceTerminalV1 {
    pub(crate) kind: ProviderTraceTerminalKindV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason_code: Option<String>,
}

impl ProviderTraceTerminalV1 {
    fn validate(&self) -> Result<(), ProviderTraceErrorV1> {
        match self.kind {
            ProviderTraceTerminalKindV1::Completed => {
                if self.reason_code.is_some() {
                    return Err(ProviderTraceErrorV1::invalid(
                        "provider_trace_terminal_invalid",
                        "Completed Provider trace terminal cannot contain a reasonCode",
                    ));
                }
            }
            ProviderTraceTerminalKindV1::Failed
            | ProviderTraceTerminalKindV1::Cancelled
            | ProviderTraceTerminalKindV1::LimitExceeded => {
                let reason_code = self.reason_code.as_deref().ok_or_else(|| {
                    ProviderTraceErrorV1::invalid(
                        "provider_trace_terminal_invalid",
                        "Non-completed Provider trace terminal requires a reasonCode",
                    )
                })?;
                validate_bounded_identity(reason_code, "reasonCode", 256)?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProviderTraceRawAppendV1 {
    Archived {
        raw_source_bytes: usize,
    },
    LimitExceeded {
        raw_source_bytes: usize,
        soft_limit_bytes: usize,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderTraceArchiveCheckpointV1 {
    pub(crate) trace_id: String,
    pub(crate) archived_through_sequence: u64,
    pub(crate) archived_through_digest: String,
    pub(crate) raw_source_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderTraceMetadataV1 {
    pub(crate) schema_version: &'static str,
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) user_turn_id: String,
    pub(crate) provider_turn_id: String,
    pub(crate) provider_kind: String,
    pub(crate) model: String,
    pub(crate) profile_id: String,
    pub(crate) profile_revision: String,
    pub(crate) control_epoch: u64,
    pub(crate) purpose: ProviderTracePurposeV1,
    pub(crate) request_digest: String,
    pub(crate) record_count: u64,
    pub(crate) raw_source_bytes: usize,
    pub(crate) terminal_kind: ProviderTraceTerminalKindV1,
    pub(crate) terminal_digest: String,
    pub(crate) seal_digest: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderTraceCompletedTerminalRecoveryV1 {
    pub(crate) exact_request_body: Vec<u8>,
    pub(crate) reasoning: String,
    pub(crate) raw_upstream_envelopes: Vec<Vec<u8>>,
    pub(crate) native_completion: Value,
    pub(crate) reasoning_present: bool,
    pub(crate) reasoning_transport: String,
    pub(crate) reasoning_digest: String,
    pub(crate) response_digest: String,
    pub(crate) provider_result: Value,
    pub(crate) ordered_items: Vec<Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderTraceTerminalRecoveryV1 {
    pub(crate) metadata: ProviderTraceMetadataV1,
    pub(crate) reason_code: Option<String>,
    pub(crate) completed: Option<ProviderTraceCompletedTerminalRecoveryV1>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderTraceExportCapabilityV1 {
    pub(crate) schema_version: &'static str,
    pub(crate) capability: String,
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) provider_turn_id: String,
    pub(crate) trace_digest: String,
    pub(crate) request_id: String,
    pub(crate) payload_digest: String,
    pub(crate) expires_in_seconds: u64,
}

#[derive(Debug)]
pub(crate) struct ProviderTraceVerifiedExportV1 {
    pub(crate) metadata: ProviderTraceMetadataV1,
    pub(crate) file: File,
    pub(crate) byte_length: u64,
}

#[derive(Debug)]
pub(crate) struct ProviderTraceAuthorizedExportV1 {
    pub(crate) metadata: ProviderTraceMetadataV1,
    pub(crate) file: File,
    pub(crate) byte_length: u64,
    pub(crate) expires_at: Instant,
}

#[derive(Debug, Clone)]
struct ProviderTraceExportGrantV1 {
    session_id: String,
    run_id: String,
    provider_turn_id: String,
    trace_digest: String,
    request_id: String,
    payload_digest: String,
    expires_at: Instant,
}

#[derive(Clone)]
pub(crate) struct ProviderTraceStoreV1 {
    sessions_dir: Arc<PathBuf>,
    export_capabilities: Arc<std::sync::Mutex<HashMap<String, ProviderTraceExportGrantV1>>>,
}

impl ProviderTraceStoreV1 {
    pub(crate) fn new(sessions_dir: PathBuf) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            export_capabilities: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Durably archives the exact Provider request before the matching dispatch
    /// record is appended, or resumes the one crash-safe state that can exist
    /// between those two durable writes.
    ///
    /// The byte slice is the serialized HTTP body only. Transport headers and
    /// credentials have no field in this API and must stay in the HTTP client.
    /// Callers must already hold the coordinated Run/checkpoint dispatch fence;
    /// this method is the unique writer of the request record. An existing
    /// archive is accepted only when it is exactly one complete request record
    /// with the same identity and request bytes. It is never truncated,
    /// replaced, or reopened after any response or terminal activity.
    pub(crate) fn begin_or_reopen_exact_request_only_turn(
        &self,
        identity: ProviderTraceIdentityV1,
        exact_request_body: &[u8],
    ) -> Result<ProviderTraceWriterV1, ProviderTraceErrorV1> {
        identity.validate()?;
        if exact_request_body.is_empty() {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_request_empty",
                "Provider request body must not be empty",
            ));
        }
        if exact_request_body.len() > PROVIDER_TRACE_REQUEST_HARD_LIMIT_V1 {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_request_too_large",
                format!(
                    "Provider request is {} bytes; the hard limit is {} bytes",
                    exact_request_body.len(),
                    PROVIDER_TRACE_REQUEST_HARD_LIMIT_V1
                ),
            ));
        }

        let trace_directory = self
            .sessions_dir
            .join(&identity.session_id)
            .join("kernel-v2")
            .join("provider-traces");
        create_private_directory(&trace_directory)?;
        let trace_path = trace_directory.join(format!(
            "{}.jsonl",
            sha256_path_component(&identity.provider_turn_id)
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = match options.open(&trace_path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return reopen_exact_request_only_trace(&trace_path, identity, exact_request_body);
            }
            Err(error) => {
                return Err(ProviderTraceErrorV1::io(
                    "provider_trace_open_failed",
                    format!("Open Provider trace archive: {error}"),
                ));
            }
        };
        secure_trace_file(&trace_path)?;
        sync_directory(&trace_directory)?;

        let request_digest = sha256_prefixed(exact_request_body);
        let mut writer = ProviderTraceWriterV1 {
            identity,
            request_digest,
            writer: BufWriter::new(file),
            sequence: 0,
            last_digest: None,
            pending_bytes: 0,
            last_durable_flush: Instant::now(),
            raw_source_bytes: 0,
            raw_limit_exceeded: false,
            response_started: false,
            sealed: false,
            poisoned: false,
        };
        let request_payload = json!({
            "identity": writer.identity,
            "bodyEncoding": "base64",
            "bodyBase64": encode_base64(exact_request_body),
            "byteLength": exact_request_body.len(),
            "requestDigest": writer.request_digest,
        });
        writer.append_record("request", request_payload)?;
        writer.flush_durable()?;
        Ok(writer)
    }

    pub(crate) fn trace_path(
        &self,
        session_id: &str,
        provider_turn_id: &str,
    ) -> Result<PathBuf, ProviderTraceErrorV1> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(provider_turn_id, "providerTurnId", 512)?;
        Ok(self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join("provider-traces")
            .join(format!("{}.jsonl", sha256_path_component(provider_turn_id))))
    }

    pub(crate) fn list_verified_metadata(
        &self,
        session_id: &str,
    ) -> Result<Vec<ProviderTraceMetadataV1>, ProviderTraceErrorV1> {
        validate_safe_session_identity(session_id)?;
        let directory = self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join("provider-traces");
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let entries = fs::read_dir(&directory).map_err(|error| {
            ProviderTraceErrorV1::io(
                "provider_trace_list_failed",
                format!("List Provider trace directory: {error}"),
            )
        })?;
        let mut paths = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| {
                ProviderTraceErrorV1::io(
                    "provider_trace_list_failed",
                    format!("Read Provider trace directory entry: {error}"),
                )
            })?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                paths.push(path);
            }
        }
        paths.sort();
        let mut metadata = Vec::with_capacity(paths.len());
        for path in paths {
            match verify_provider_trace_path(&path) {
                Ok(export) => {
                    if export.metadata.session_id != session_id {
                        return Err(ProviderTraceErrorV1::invalid(
                            "provider_trace_identity_mismatch",
                            "Provider trace archive sessionId does not match its requested session",
                        ));
                    }
                    metadata.push(export.metadata);
                }
                Err(error) if error.code == "provider_trace_archive_unsealed" => continue,
                Err(error) => return Err(error),
            }
        }
        metadata.sort_by(|left, right| left.provider_turn_id.cmp(&right.provider_turn_id));
        Ok(metadata)
    }

    pub(crate) fn verified_export(
        &self,
        session_id: &str,
        provider_turn_id: &str,
    ) -> Result<ProviderTraceVerifiedExportV1, ProviderTraceErrorV1> {
        self.verified_export_until(session_id, provider_turn_id, None)
    }

    pub(crate) fn verified_terminal_recovery(
        &self,
        session_id: &str,
        provider_turn_id: &str,
    ) -> Result<ProviderTraceTerminalRecoveryV1, ProviderTraceErrorV1> {
        recover_verified_provider_trace_terminal(
            self.verified_export(session_id, provider_turn_id)?,
        )
    }

    fn verified_export_until(
        &self,
        session_id: &str,
        provider_turn_id: &str,
        deadline: Option<Instant>,
    ) -> Result<ProviderTraceVerifiedExportV1, ProviderTraceErrorV1> {
        let path = self.trace_path(session_id, provider_turn_id)?;
        let export = verify_provider_trace_path_until(&path, deadline)?;
        if export.metadata.session_id != session_id
            || export.metadata.provider_turn_id != provider_turn_id
        {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_identity_mismatch",
                "Provider trace archive identity does not match its requested path",
            ));
        }
        Ok(export)
    }

    pub(crate) fn mint_export_capability(
        &self,
        session_id: &str,
        run_id: &str,
        provider_turn_id: &str,
        expected_trace_digest: &str,
        request_id: &str,
    ) -> Result<ProviderTraceExportCapabilityV1, ProviderTraceErrorV1> {
        validate_bounded_identity(run_id, "runId", 512)?;
        validate_sha256_digest(expected_trace_digest, "traceDigest")?;
        validate_bounded_identity(request_id, "requestId", 512)?;
        let export = self.verified_export(session_id, provider_turn_id)?;
        let trace_digest = export.metadata.seal_digest.clone();
        if export.metadata.run_id != run_id || trace_digest != expected_trace_digest {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_identity_mismatch",
                "Provider trace archive does not match the expected runId and trace digest",
            ));
        }
        let payload_digest = stable_json_sha256(&json!({
            "schemaVersion": "deepcode.provider-trace-export-request.v1",
            "sessionId": session_id,
            "runId": run_id,
            "providerTurnId": provider_turn_id,
            "traceDigest": expected_trace_digest,
            "requestId": request_id,
        }))?;
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(|error| {
            ProviderTraceErrorV1::io(
                "provider_trace_capability_entropy_failed",
                format!("Generate Provider trace capability: {error}"),
            )
        })?;
        let capability = format!("provider-trace-v1.{}", lower_hex(&entropy));
        let grant = ProviderTraceExportGrantV1 {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            provider_turn_id: provider_turn_id.to_string(),
            trace_digest: trace_digest.clone(),
            request_id: request_id.to_string(),
            payload_digest: payload_digest.clone(),
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        {
            let mut grants = self.export_capabilities.lock().map_err(|_| {
                ProviderTraceErrorV1::io(
                    "provider_trace_capability_store_unavailable",
                    "Provider trace capability store is unavailable",
                )
            })?;
            let now = Instant::now();
            grants.retain(|_, grant| grant.expires_at > now);
            if grants.len() >= PROVIDER_TRACE_EXPORT_CAPABILITY_LIMIT_V1 {
                return Err(ProviderTraceErrorV1::invalid(
                    "provider_trace_capability_capacity_exceeded",
                    "Provider trace capability store reached its bounded capacity",
                ));
            }
            grants.insert(capability.clone(), grant);
        }
        if let Err(error) = self.record_audit(
            "mint",
            session_id,
            run_id,
            provider_turn_id,
            request_id,
            &payload_digest,
            &trace_digest,
            "succeeded",
        ) {
            if let Ok(mut grants) = self.export_capabilities.lock() {
                grants.remove(&capability);
            }
            return Err(error);
        }
        Ok(ProviderTraceExportCapabilityV1 {
            schema_version: "deepcode.provider-trace-export-capability.v1",
            capability,
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            provider_turn_id: provider_turn_id.to_string(),
            trace_digest,
            request_id: request_id.to_string(),
            payload_digest,
            expires_in_seconds: 60,
        })
    }

    pub(crate) fn export_with_capability(
        &self,
        capability: &str,
        session_id: &str,
        run_id: &str,
        provider_turn_id: &str,
        expected_trace_digest: &str,
        request_id: &str,
        payload_digest: &str,
    ) -> Result<ProviderTraceAuthorizedExportV1, ProviderTraceErrorV1> {
        validate_bounded_identity(run_id, "runId", 512)?;
        validate_sha256_digest(expected_trace_digest, "traceDigest")?;
        validate_bounded_identity(request_id, "requestId", 512)?;
        validate_sha256_digest(payload_digest, "payloadDigest")?;
        let grant = {
            let mut grants = self.export_capabilities.lock().map_err(|_| {
                ProviderTraceErrorV1::io(
                    "provider_trace_capability_store_unavailable",
                    "Provider trace capability store is unavailable",
                )
            })?;
            grants.retain(|_, grant| grant.expires_at > Instant::now());
            grants.get(capability).cloned().ok_or_else(|| {
                ProviderTraceErrorV1::invalid(
                    "provider_trace_capability_invalid",
                    "Provider trace export capability is invalid or expired",
                )
            })?
        };
        if grant.session_id != session_id
            || grant.run_id != run_id
            || grant.provider_turn_id != provider_turn_id
            || grant.trace_digest != expected_trace_digest
            || grant.request_id != request_id
            || grant.payload_digest != payload_digest
        {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_capability_conflict",
                "Provider trace capability is bound to a different request identity",
            ));
        }
        let export =
            self.verified_export_until(session_id, provider_turn_id, Some(grant.expires_at))?;
        if export.metadata.run_id != run_id
            || export.metadata.seal_digest != expected_trace_digest
            || export.metadata.seal_digest != grant.trace_digest
        {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_capability_stale",
                "Provider trace identity changed after export capability issuance",
            ));
        }
        if grant.expires_at <= Instant::now() {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_capability_invalid",
                "Provider trace export capability expired during validation",
            ));
        }
        Ok(ProviderTraceAuthorizedExportV1 {
            metadata: export.metadata,
            file: export.file,
            byte_length: export.byte_length,
            expires_at: grant.expires_at,
        })
    }

    pub(crate) fn record_export_outcome(
        &self,
        action: &str,
        session_id: &str,
        run_id: &str,
        provider_turn_id: &str,
        request_id: &str,
        payload_digest: &str,
        trace_digest: &str,
        result_code: &str,
    ) -> Result<(), ProviderTraceErrorV1> {
        self.record_audit(
            action,
            session_id,
            run_id,
            provider_turn_id,
            request_id,
            payload_digest,
            trace_digest,
            result_code,
        )
    }

    pub(crate) fn profile_revision_is_unavailable(
        &self,
        profile_id: &str,
        profile_revision: &str,
    ) -> Result<bool, ProviderTraceErrorV1> {
        validate_bounded_identity(profile_id, "profileId", 512)?;
        validate_sha256_digest(profile_revision, "profileRevision")?;
        let path = self.profile_availability_path();
        with_storage_path_lock(&path, || {
            if !path.exists() {
                return Ok(false);
            }
            let bytes = fs::read(&path).map_err(|error| {
                HostV2StorageError::io(
                    "provider_profile_availability_read_failed",
                    format!("Read Provider Profile availability records: {error}"),
                )
            })?;
            let mut unavailable = false;
            for line in bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
            {
                let value = serde_json::from_slice::<Value>(line).map_err(|error| {
                    HostV2StorageError::invalid(
                        "provider_profile_availability_decode_failed",
                        format!("Decode Provider Profile availability record: {error}"),
                    )
                })?;
                if value.get("profileId").and_then(Value::as_str) != Some(profile_id)
                    || value.get("profileRevision").and_then(Value::as_str)
                        != Some(profile_revision)
                {
                    continue;
                }
                unavailable = match value.get("state").and_then(Value::as_str) {
                    Some("unavailable") => true,
                    Some("available") => false,
                    _ => {
                        return Err(HostV2StorageError::invalid(
                            "provider_profile_availability_state_invalid",
                            "Provider Profile availability record has an invalid state",
                        ))
                    }
                };
            }
            Ok(unavailable)
        })
        .map_err(ProviderTraceErrorV1::from)
    }

    pub(crate) fn mark_profile_revision_unavailable(
        &self,
        profile_id: &str,
        profile_revision: &str,
        reason_code: &str,
    ) -> Result<(), ProviderTraceErrorV1> {
        self.append_profile_availability(profile_id, profile_revision, "unavailable", reason_code)
    }

    pub(crate) fn mark_profile_revision_available(
        &self,
        profile_id: &str,
        profile_revision: &str,
    ) -> Result<(), ProviderTraceErrorV1> {
        self.append_profile_availability(
            profile_id,
            profile_revision,
            "available",
            "user_profile_revision_saved",
        )
    }

    fn append_profile_availability(
        &self,
        profile_id: &str,
        profile_revision: &str,
        state: &str,
        reason_code: &str,
    ) -> Result<(), ProviderTraceErrorV1> {
        validate_bounded_identity(profile_id, "profileId", 512)?;
        validate_sha256_digest(profile_revision, "profileRevision")?;
        validate_bounded_identity(reason_code, "reasonCode", 256)?;
        let path = self.profile_availability_path();
        let record = json!({
            "schemaVersion": "deepcode.provider-profile-availability.v1",
            "recordedAt": now_millis_text(),
            "profileId": profile_id,
            "profileRevision": profile_revision,
            "state": state,
            "reasonCode": reason_code,
        });
        with_storage_path_lock(&path, || append_json_line_durable(&path, &record))?;
        Ok(())
    }

    fn profile_availability_path(&self) -> PathBuf {
        self.sessions_dir
            .join(".host-management-v2")
            .join("provider-profile-availability.jsonl")
    }

    fn record_audit(
        &self,
        action: &str,
        session_id: &str,
        run_id: &str,
        provider_turn_id: &str,
        request_id: &str,
        payload_digest: &str,
        trace_digest: &str,
        result_code: &str,
    ) -> Result<(), ProviderTraceErrorV1> {
        validate_bounded_identity(action, "action", 64)?;
        validate_bounded_identity(result_code, "resultCode", 128)?;
        let session_id = normalized_audit_session_id(session_id);
        let run_id = normalized_audit_identity(run_id, "run");
        let provider_turn_id = normalized_audit_identity(provider_turn_id, "provider-turn");
        let request_id = normalized_audit_identity(request_id, "request");
        let payload_digest = normalized_audit_digest(payload_digest);
        let trace_digest = normalized_audit_digest(trace_digest);
        let path = self
            .sessions_dir
            .join(".host-management-v2")
            .join("provider-trace-audit.jsonl");
        let record = json!({
            "schemaVersion": "deepcode.host.provider-trace-audit.v1",
            "recordedAt": now_millis_text(),
            "action": action,
            "sessionId": session_id,
            "runId": run_id,
            "providerTurnId": provider_turn_id,
            "requestId": request_id,
            "payloadDigest": payload_digest,
            "traceDigest": trace_digest,
            "resultCode": result_code,
        });
        with_storage_path_lock(&path, || append_json_line_durable(&path, &record))?;
        Ok(())
    }
}

fn normalized_audit_session_id(value: &str) -> String {
    if validate_safe_session_identity(value).is_ok() {
        value.to_string()
    } else {
        format!("invalid-{}", sha256_path_component(value))
    }
}

fn normalized_audit_identity(value: &str, label: &str) -> String {
    if validate_bounded_identity(value, "auditIdentity", 512).is_ok() {
        value.to_string()
    } else {
        format!("{label}-invalid-{}", sha256_path_component(value))
    }
}

fn normalized_audit_digest(value: &str) -> String {
    if validate_sha256_digest(value, "auditDigest").is_ok() {
        value.to_string()
    } else {
        sha256_prefixed(value.as_bytes())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderTraceTailKindV1 {
    Terminal,
    Seal,
    Other,
}

#[derive(Debug)]
struct ProviderTraceTailRecordV1 {
    kind: ProviderTraceTailKindV1,
    sequence: u64,
    digest: String,
    payload: Option<Value>,
}

fn reopen_exact_request_only_trace(
    path: &Path,
    expected_identity: ProviderTraceIdentityV1,
    exact_request_body: &[u8],
) -> Result<ProviderTraceWriterV1, ProviderTraceErrorV1> {
    let path_metadata = fs::symlink_metadata(path).map_err(|error| {
        ProviderTraceErrorV1::io(
            "provider_trace_open_failed",
            format!("Inspect existing Provider trace archive: {error}"),
        )
    })?;
    if !path_metadata.file_type().is_file() {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_request_only_invalid",
            "Existing Provider trace path is not a regular file",
        ));
    }

    let file = OpenOptions::new()
        .read(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            ProviderTraceErrorV1::io(
                "provider_trace_open_failed",
                format!("Open existing Provider trace archive: {error}"),
            )
        })?;
    let opened_metadata = file.metadata().map_err(|error| {
        ProviderTraceErrorV1::io(
            "provider_trace_read_failed",
            format!("Read existing Provider trace metadata: {error}"),
        )
    })?;
    validate_request_only_trace_file_identity(&path_metadata, &opened_metadata)?;

    let mut reader = BufReader::new(file);
    let mut line = read_bounded_provider_trace_line(&mut reader)?.ok_or_else(|| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_request_only_invalid",
            "Existing Provider trace archive is empty",
        )
    })?;
    let verified_byte_length = u64::try_from(line.len()).map_err(|_| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_archive_size_overflow",
            "Provider trace archive byte count overflowed",
        )
    })?;
    if read_bounded_provider_trace_line(&mut reader)?.is_some() {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_request_only_invalid",
            "Existing Provider trace contains records after its request",
        ));
    }
    debug_assert_eq!(line.last(), Some(&b'\n'));
    line.pop();
    if line.is_empty() {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_request_only_invalid",
            "Existing Provider trace request record is empty",
        ));
    }

    let mut record = serde_json::from_slice::<Value>(&line).map_err(|error| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_record_decode_failed",
            format!("Decode existing Provider trace request record: {error}"),
        )
    })?;
    let object = record.as_object_mut().ok_or_else(|| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_request_only_invalid",
            "Existing Provider trace request record must be an object",
        )
    })?;
    if !object_has_exact_keys(
        object,
        &[
            "schemaVersion",
            "traceId",
            "sequence",
            "previousDigest",
            "recordedAt",
            "recordKind",
            "payload",
            "digest",
        ],
    ) || object.get("schemaVersion").and_then(Value::as_str) != Some(PROVIDER_TRACE_SCHEMA_V1)
        || object.get("traceId").and_then(Value::as_str)
            != Some(expected_identity.provider_turn_id.as_str())
        || object.get("sequence").and_then(Value::as_u64) != Some(1)
        || object.get("previousDigest") != Some(&Value::Null)
        || object.get("recordKind").and_then(Value::as_str) != Some("request")
    {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_request_only_invalid",
            "Existing Provider trace is not exactly one canonical request record",
        ));
    }
    let recorded_at = object
        .get("recordedAt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if recorded_at.is_empty()
        || recorded_at.len() > 32
        || !recorded_at.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_request_only_invalid",
            "Existing Provider trace request has an invalid recordedAt",
        ));
    }
    let record_digest = object
        .remove("digest")
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_digest_missing",
                "Existing Provider trace request has no digest",
            )
        })?;
    validate_sha256_digest(&record_digest, "digest")?;
    if stable_json_sha256(&record)? != record_digest {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_digest_mismatch",
            "Existing Provider trace request digest verification failed",
        ));
    }

    let payload = record
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_request_only_invalid",
                "Existing Provider trace request payload is invalid",
            )
        })?;
    if !object_has_exact_keys(
        payload,
        &[
            "identity",
            "bodyEncoding",
            "bodyBase64",
            "byteLength",
            "requestDigest",
        ],
    ) {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_request_only_invalid",
            "Existing Provider trace request payload is not canonical",
        ));
    }
    let expected_identity_value = serde_json::to_value(&expected_identity).map_err(|error| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_identity_invalid",
            format!("Encode expected Provider trace identity: {error}"),
        )
    })?;
    if payload.get("identity") != Some(&expected_identity_value) {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_identity_mismatch",
            "Existing Provider trace request identity does not match the exact dispatch identity",
        ));
    }
    let archived_request_body = decode_trace_bytes(
        payload,
        "bodyEncoding",
        "bodyBase64",
        "byteLength",
        "requestDigest",
        PROVIDER_TRACE_REQUEST_HARD_LIMIT_V1,
        "provider_trace_request_invalid",
    )?;
    if archived_request_body.as_slice() != exact_request_body {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_request_replay_conflict",
            "Existing Provider trace request bytes differ from the exact outbound request",
        ));
    }
    let request_digest = payload
        .get("requestDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_request_digest_missing",
                "Existing Provider trace request has no requestDigest",
            )
        })?
        .to_string();
    if request_digest != sha256_prefixed(exact_request_body) {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_request_digest_mismatch",
            "Existing Provider trace requestDigest differs from the exact outbound request",
        ));
    }

    let verified_metadata = reader.get_ref().metadata().map_err(|error| {
        ProviderTraceErrorV1::io(
            "provider_trace_read_failed",
            format!("Re-read existing Provider trace metadata: {error}"),
        )
    })?;
    if verified_metadata.len() != verified_byte_length {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_archive_changed",
            "Existing Provider trace changed while its request was being verified",
        ));
    }
    let current_path_metadata = fs::symlink_metadata(path).map_err(|error| {
        ProviderTraceErrorV1::io(
            "provider_trace_read_failed",
            format!("Re-inspect existing Provider trace archive: {error}"),
        )
    })?;
    validate_request_only_trace_file_identity(&current_path_metadata, &verified_metadata)?;
    let file = reader.into_inner();

    Ok(ProviderTraceWriterV1 {
        identity: expected_identity,
        request_digest,
        writer: BufWriter::new(file),
        sequence: 1,
        last_digest: Some(record_digest),
        pending_bytes: 0,
        last_durable_flush: Instant::now(),
        raw_source_bytes: 0,
        raw_limit_exceeded: false,
        response_started: false,
        sealed: false,
        poisoned: false,
    })
}

fn object_has_exact_keys(object: &serde_json::Map<String, Value>, expected_keys: &[&str]) -> bool {
    object.len() == expected_keys.len() && expected_keys.iter().all(|key| object.contains_key(*key))
}

fn validate_request_only_trace_file_identity(
    path_metadata: &fs::Metadata,
    opened_metadata: &fs::Metadata,
) -> Result<(), ProviderTraceErrorV1> {
    if !path_metadata.file_type().is_file()
        || !opened_metadata.is_file()
        || path_metadata.len() != opened_metadata.len()
    {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_archive_changed",
            "Existing Provider trace path does not identify the verified regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if opened_metadata.permissions().mode() & 0o077 != 0 {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_permissions_invalid",
                "Existing Provider trace permissions are broader than 0600",
            ));
        }
        if path_metadata.dev() != opened_metadata.dev()
            || path_metadata.ino() != opened_metadata.ino()
        {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_archive_changed",
                "Existing Provider trace path changed while it was being opened",
            ));
        }
    }
    Ok(())
}

fn verify_provider_trace_path(
    path: &Path,
) -> Result<ProviderTraceVerifiedExportV1, ProviderTraceErrorV1> {
    verify_provider_trace_path_until(path, None)
}

fn verify_provider_trace_path_until(
    path: &Path,
    deadline: Option<Instant>,
) -> Result<ProviderTraceVerifiedExportV1, ProviderTraceErrorV1> {
    ensure_provider_trace_export_deadline(deadline)?;
    let file = File::open(path).map_err(|error| {
        ProviderTraceErrorV1::io(
            "provider_trace_not_found",
            format!("Open Provider trace archive: {error}"),
        )
    })?;
    let file_metadata = file.metadata().map_err(|error| {
        ProviderTraceErrorV1::io(
            "provider_trace_not_found",
            format!("Read Provider trace metadata: {error}"),
        )
    })?;
    ensure_provider_trace_export_deadline(deadline)?;
    if !file_metadata.is_file() {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_archive_size_invalid",
            "Provider trace archive is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file_metadata.permissions().mode() & 0o077 != 0 {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_permissions_invalid",
                "Provider trace archive permissions are broader than 0600",
            ));
        }
    }

    let mut reader = BufReader::new(file);
    let mut verified_byte_length = 0u64;
    let mut previous_digest: Option<String> = None;
    let mut expected_sequence = 1u64;
    let mut trace_id: Option<String> = None;
    let mut request_identity: Option<ProviderTraceIdentityV1> = None;
    let mut request_digest: Option<String> = None;
    let mut verified_raw_source_bytes = 0usize;
    let mut penultimate_record: Option<ProviderTraceTailRecordV1> = None;
    let mut last_record: Option<ProviderTraceTailRecordV1> = None;

    loop {
        ensure_provider_trace_export_deadline(deadline)?;
        let line = read_bounded_provider_trace_line(&mut reader)?;
        ensure_provider_trace_export_deadline(deadline)?;
        let Some(mut line) = line else {
            break;
        };
        verified_byte_length = verified_byte_length
            .checked_add(u64::try_from(line.len()).map_err(|_| {
                ProviderTraceErrorV1::invalid(
                    "provider_trace_archive_size_overflow",
                    "Provider trace archive byte count overflowed",
                )
            })?)
            .ok_or_else(|| {
                ProviderTraceErrorV1::invalid(
                    "provider_trace_archive_size_overflow",
                    "Provider trace archive byte count overflowed",
                )
            })?;
        debug_assert_eq!(line.last(), Some(&b'\n'));
        line.pop();
        if line.is_empty() {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_record_invalid",
                "Provider trace archive contains an empty JSONL record",
            ));
        }

        let mut record = serde_json::from_slice::<Value>(&line).map_err(|error| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_record_decode_failed",
                format!("Decode Provider trace record: {error}"),
            )
        })?;
        let object = record.as_object_mut().ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_record_invalid",
                "Provider trace record must be an object",
            )
        })?;
        if object.get("schemaVersion").and_then(Value::as_str) != Some(PROVIDER_TRACE_SCHEMA_V1)
            || object.get("sequence").and_then(Value::as_u64) != Some(expected_sequence)
        {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_sequence_invalid",
                "Provider trace schema or sequence is invalid",
            ));
        }
        let current_trace_id = object
            .get("traceId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProviderTraceErrorV1::invalid(
                    "provider_trace_identity_invalid",
                    "Provider trace record has no traceId",
                )
            })?
            .to_string();
        if trace_id
            .as_deref()
            .is_some_and(|existing| existing != current_trace_id)
        {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_identity_mismatch",
                "Provider trace record changed traceId",
            ));
        }
        trace_id.get_or_insert(current_trace_id);
        match (&previous_digest, object.get("previousDigest")) {
            (None, Some(Value::Null)) => {}
            (Some(expected), Some(Value::String(actual))) if expected == actual => {}
            _ => {
                return Err(ProviderTraceErrorV1::invalid(
                    "provider_trace_hash_chain_invalid",
                    "Provider trace previousDigest chain is invalid",
                ))
            }
        }
        let digest = object
            .remove("digest")
            .and_then(|value| value.as_str().map(str::to_string))
            .ok_or_else(|| {
                ProviderTraceErrorV1::invalid(
                    "provider_trace_digest_missing",
                    "Provider trace record has no digest",
                )
            })?;
        let _ = object;
        let expected_digest = stable_json_sha256(&record)?;
        if digest != expected_digest {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_digest_mismatch",
                "Provider trace record digest verification failed",
            ));
        }

        let record_kind = record.get("recordKind").and_then(Value::as_str);
        if expected_sequence == 1 {
            if record_kind != Some("request") {
                return Err(ProviderTraceErrorV1::invalid(
                    "provider_trace_request_missing",
                    "Provider trace first record is not the request",
                ));
            }
            let payload = record
                .get("payload")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    ProviderTraceErrorV1::invalid(
                        "provider_trace_request_invalid",
                        "Provider trace request payload is invalid",
                    )
                })?;
            let exact_request_body = decode_trace_bytes(
                payload,
                "bodyEncoding",
                "bodyBase64",
                "byteLength",
                "requestDigest",
                PROVIDER_TRACE_REQUEST_HARD_LIMIT_V1,
                "provider_trace_request_invalid",
            )?;
            if exact_request_body.is_empty() {
                return Err(ProviderTraceErrorV1::invalid(
                    "provider_trace_request_invalid",
                    "Provider trace request body must not be empty",
                ));
            }
            let identity = payload.get("identity").cloned().ok_or_else(|| {
                ProviderTraceErrorV1::invalid(
                    "provider_trace_identity_missing",
                    "Provider trace request has no identity",
                )
            })?;
            let identity: ProviderTraceIdentityV1 =
                serde_json::from_value(identity).map_err(|error| {
                    ProviderTraceErrorV1::invalid(
                        "provider_trace_identity_invalid",
                        format!("Decode Provider trace identity: {error}"),
                    )
                })?;
            identity.validate()?;
            if trace_id.as_deref() != Some(identity.provider_turn_id.as_str()) {
                return Err(ProviderTraceErrorV1::invalid(
                    "provider_trace_identity_mismatch",
                    "Provider traceId does not match providerTurnId",
                ));
            }
            let digest = payload
                .get("requestDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProviderTraceErrorV1::invalid(
                        "provider_trace_request_digest_missing",
                        "Provider trace request has no requestDigest",
                    )
                })?
                .to_string();
            if sha256_prefixed(&exact_request_body) != digest {
                return Err(ProviderTraceErrorV1::invalid(
                    "provider_trace_request_digest_mismatch",
                    "Provider trace request bytes do not match requestDigest",
                ));
            }
            validate_sha256_digest(&digest, "requestDigest")?;
            request_identity = Some(identity);
            request_digest = Some(digest);
        }

        if record_kind == Some("rawUpstreamEnvelope") {
            let payload = record
                .get("payload")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    ProviderTraceErrorV1::invalid(
                        "provider_trace_raw_envelope_invalid",
                        "Provider trace raw upstream envelope payload is invalid",
                    )
                })?;
            let source = decode_trace_bytes(
                payload,
                "sourceEncoding",
                "sourceBase64",
                "sourceByteLength",
                "sourceDigest",
                PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1,
                "provider_trace_raw_envelope_invalid",
            )?;
            verified_raw_source_bytes = verified_raw_source_bytes
                .checked_add(source.len())
                .ok_or_else(|| {
                    ProviderTraceErrorV1::invalid(
                        "provider_trace_source_size_overflow",
                        "Provider trace raw source byte count overflowed",
                    )
                })?;
        }

        let tail_kind = match record_kind {
            Some("terminal") => ProviderTraceTailKindV1::Terminal,
            Some("seal") => ProviderTraceTailKindV1::Seal,
            _ => ProviderTraceTailKindV1::Other,
        };
        let payload = matches!(
            tail_kind,
            ProviderTraceTailKindV1::Terminal | ProviderTraceTailKindV1::Seal
        )
        .then(|| record.get("payload").cloned().unwrap_or(Value::Null));
        penultimate_record = last_record.take();
        last_record = Some(ProviderTraceTailRecordV1 {
            kind: tail_kind,
            sequence: expected_sequence,
            digest: digest.clone(),
            payload,
        });
        previous_digest = Some(digest);
        expected_sequence = expected_sequence.checked_add(1).ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_sequence_overflow",
                "Provider trace record sequence overflowed",
            )
        })?;
    }

    ensure_provider_trace_export_deadline(deadline)?;
    let seal = last_record.as_ref().ok_or_else(|| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_archive_unsealed",
            "Provider trace archive is still active or lacks a durable final record boundary",
        )
    })?;
    if seal.kind != ProviderTraceTailKindV1::Seal {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_archive_unsealed",
            "Provider trace archive has not been sealed",
        ));
    }
    let record_count = expected_sequence.saturating_sub(1);
    if record_count < 3 {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_archive_incomplete",
            "Provider trace archive lacks request or terminal records",
        ));
    }
    let terminal = penultimate_record.as_ref().ok_or_else(|| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_seal_missing",
            "Provider trace final records are not terminal and seal",
        )
    })?;
    if terminal.kind != ProviderTraceTailKindV1::Terminal {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_seal_missing",
            "Provider trace final records are not terminal and seal",
        ));
    }
    let identity = request_identity.ok_or_else(|| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_request_missing",
            "Provider trace first record is not the request",
        )
    })?;
    let request_digest = request_digest.ok_or_else(|| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_request_digest_missing",
            "Provider trace request has no requestDigest",
        )
    })?;
    let terminal_value: ProviderTraceTerminalV1 = serde_json::from_value(
        terminal.payload.clone().unwrap_or(Value::Null),
    )
    .map_err(|error| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_terminal_invalid",
            format!("Decode Provider trace terminal: {error}"),
        )
    })?;
    terminal_value.validate()?;
    let terminal_digest = terminal.digest.clone();
    let seal_payload = seal
        .payload
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_seal_invalid",
                "Provider trace seal payload is invalid",
            )
        })?;
    if seal_payload.get("terminalSequence").and_then(Value::as_u64) != Some(terminal.sequence)
        || seal_payload.get("terminalDigest").and_then(Value::as_str)
            != Some(terminal_digest.as_str())
        || seal_payload
            .get("recordCountBeforeSeal")
            .and_then(Value::as_u64)
            != Some(terminal.sequence)
    {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_seal_invalid",
            "Provider trace seal does not bind the terminal record",
        ));
    }
    if seal_payload.get("requestDigest").and_then(Value::as_str) != Some(request_digest.as_str()) {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_seal_invalid",
            "Provider trace seal does not bind the request digest",
        ));
    }
    let raw_source_bytes = seal_payload
        .get("rawSourceBytes")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_seal_invalid",
                "Provider trace seal has an invalid rawSourceBytes",
            )
        })?;
    let maximum_raw_source_bytes = PROVIDER_TRACE_RAW_SOURCE_SOFT_LIMIT_V1
        .checked_add(PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1)
        .expect("Provider trace limits fit usize");
    if verified_raw_source_bytes != raw_source_bytes
        || verified_raw_source_bytes > maximum_raw_source_bytes
    {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_raw_source_size_mismatch",
            "Provider trace seal rawSourceBytes does not match its decoded raw envelopes",
        ));
    }
    if (verified_raw_source_bytes > PROVIDER_TRACE_RAW_SOURCE_SOFT_LIMIT_V1)
        != (terminal_value.kind == ProviderTraceTerminalKindV1::LimitExceeded)
    {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_limit_terminal_invalid",
            "Provider trace terminal does not match its decoded raw source byte count",
        ));
    }

    let verified_metadata = reader.get_ref().metadata().map_err(|error| {
        ProviderTraceErrorV1::io(
            "provider_trace_read_failed",
            format!("Re-read Provider trace metadata: {error}"),
        )
    })?;
    ensure_provider_trace_export_deadline(deadline)?;
    if verified_metadata.len() != verified_byte_length {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_archive_changed",
            "Provider trace archive changed while it was being verified",
        ));
    }
    // A sealed writer cannot append again. Rewind and retain this exact file
    // descriptor so a path replacement cannot substitute export bytes after
    // the complete chain-and-seal verification above.
    reader.seek(SeekFrom::Start(0)).map_err(|error| {
        ProviderTraceErrorV1::io(
            "provider_trace_read_failed",
            format!("Rewind verified Provider trace archive: {error}"),
        )
    })?;
    ensure_provider_trace_export_deadline(deadline)?;
    let file = reader.into_inner();

    Ok(ProviderTraceVerifiedExportV1 {
        metadata: ProviderTraceMetadataV1 {
            schema_version: PROVIDER_TRACE_SCHEMA_V1,
            session_id: identity.session_id,
            run_id: identity.run_id,
            user_turn_id: identity.user_turn_id,
            provider_turn_id: identity.provider_turn_id,
            provider_kind: identity.provider_kind,
            model: identity.model,
            profile_id: identity.profile_id,
            profile_revision: identity.profile_revision,
            control_epoch: identity.control_epoch,
            purpose: identity.purpose,
            request_digest,
            record_count: seal.sequence,
            raw_source_bytes,
            terminal_kind: terminal_value.kind,
            terminal_digest,
            seal_digest: seal.digest.clone(),
        },
        file,
        byte_length: verified_byte_length,
    })
}

fn recover_verified_provider_trace_terminal(
    export: ProviderTraceVerifiedExportV1,
) -> Result<ProviderTraceTerminalRecoveryV1, ProviderTraceErrorV1> {
    let ProviderTraceVerifiedExportV1 {
        metadata,
        file,
        byte_length: _,
    } = export;
    let mut reader = BufReader::new(file);
    let mut terminal: Option<ProviderTraceTerminalV1> = None;
    let mut completed: Option<ProviderTraceCompletedTerminalRecoveryV1> = None;
    let mut completed_sequence: Option<u64> = None;
    let mut exact_request_body: Option<Vec<u8>> = None;
    let mut reasoning = String::new();
    let mut raw_upstream_envelopes = Vec::new();
    let mut recovered_raw_source_bytes = 0usize;
    loop {
        let Some(mut line) = read_bounded_provider_trace_line(&mut reader)? else {
            break;
        };
        line.pop();
        let record = serde_json::from_slice::<Value>(&line).map_err(|error| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_record_decode_failed",
                format!("Decode verified Provider trace record: {error}"),
            )
        })?;
        match record.get("recordKind").and_then(Value::as_str) {
            Some("request") => {
                if exact_request_body.is_some() {
                    return Err(ProviderTraceErrorV1::invalid(
                        "provider_trace_recovery_invalid",
                        "Provider trace contains more than one request record",
                    ));
                }
                let payload = record
                    .get("payload")
                    .and_then(Value::as_object)
                    .ok_or_else(provider_trace_completed_recovery_invalid)?;
                exact_request_body = Some(decode_trace_bytes(
                    payload,
                    "bodyEncoding",
                    "bodyBase64",
                    "byteLength",
                    "requestDigest",
                    PROVIDER_TRACE_REQUEST_HARD_LIMIT_V1,
                    "provider_trace_recovery_invalid",
                )?);
            }
            Some("rawUpstreamEnvelope") => {
                let payload = record
                    .get("payload")
                    .and_then(Value::as_object)
                    .ok_or_else(provider_trace_completed_recovery_invalid)?;
                let envelope = decode_trace_bytes(
                    payload,
                    "sourceEncoding",
                    "sourceBase64",
                    "sourceByteLength",
                    "sourceDigest",
                    PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1,
                    "provider_trace_recovery_invalid",
                )?;
                recovered_raw_source_bytes = recovered_raw_source_bytes
                    .checked_add(envelope.len())
                    .ok_or_else(provider_trace_completed_recovery_invalid)?;
                raw_upstream_envelopes.push(envelope);
            }
            Some("normalizedEvent") => {
                let event = record
                    .get("payload")
                    .and_then(|payload| payload.get("event"))
                    .ok_or_else(|| {
                        ProviderTraceErrorV1::invalid(
                            "provider_trace_recovery_invalid",
                            "Provider trace normalized event is missing its event payload",
                        )
                    })?;
                reject_structured_trace_secrets(event)?;
                if event.get("type").and_then(Value::as_str) == Some("reasoning_delta") {
                    let content = event
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(provider_trace_completed_recovery_invalid)?;
                    reasoning.push_str(content);
                    continue;
                }
                if event.get("type").and_then(Value::as_str) != Some("validatedTerminal") {
                    continue;
                }
                if completed.is_some() {
                    return Err(ProviderTraceErrorV1::invalid(
                        "provider_trace_recovery_invalid",
                        "Provider trace contains more than one validated terminal event",
                    ));
                }
                let reasoning_present = event
                    .get("reasoningPresent")
                    .and_then(Value::as_bool)
                    .ok_or_else(provider_trace_completed_recovery_invalid)?;
                let reasoning_transport = event
                    .get("reasoningTransport")
                    .and_then(Value::as_str)
                    .ok_or_else(provider_trace_completed_recovery_invalid)?
                    .to_string();
                validate_bounded_identity(&reasoning_transport, "reasoningTransport", 128)?;
                let reasoning_digest = event
                    .get("reasoningDigest")
                    .and_then(Value::as_str)
                    .ok_or_else(provider_trace_completed_recovery_invalid)?
                    .to_string();
                validate_sha256_digest(&reasoning_digest, "reasoningDigest")?;
                let response_digest = event
                    .get("responseDigest")
                    .and_then(Value::as_str)
                    .ok_or_else(provider_trace_completed_recovery_invalid)?
                    .to_string();
                validate_sha256_digest(&response_digest, "responseDigest")?;
                let native_completion = event
                    .get("nativeCompletion")
                    .filter(|value| value.is_object())
                    .ok_or_else(provider_trace_completed_recovery_invalid)?
                    .clone();
                let provider_result = event
                    .get("providerResult")
                    .filter(|value| value.is_object())
                    .ok_or_else(provider_trace_completed_recovery_invalid)?
                    .clone();
                let ordered_items = event
                    .get("orderedItems")
                    .and_then(Value::as_array)
                    .ok_or_else(provider_trace_completed_recovery_invalid)?
                    .clone();
                let sequence = record
                    .get("sequence")
                    .and_then(Value::as_u64)
                    .ok_or_else(provider_trace_completed_recovery_invalid)?;
                completed = Some(ProviderTraceCompletedTerminalRecoveryV1 {
                    exact_request_body: Vec::new(),
                    reasoning: String::new(),
                    raw_upstream_envelopes: Vec::new(),
                    native_completion,
                    reasoning_present,
                    reasoning_transport,
                    reasoning_digest,
                    response_digest,
                    provider_result,
                    ordered_items,
                });
                completed_sequence = Some(sequence);
            }
            Some("terminal") => {
                if terminal.is_some() {
                    return Err(ProviderTraceErrorV1::invalid(
                        "provider_trace_recovery_invalid",
                        "Provider trace contains more than one terminal record",
                    ));
                }
                let value = record.get("payload").cloned().ok_or_else(|| {
                    ProviderTraceErrorV1::invalid(
                        "provider_trace_recovery_invalid",
                        "Provider trace terminal is missing its payload",
                    )
                })?;
                let decoded =
                    serde_json::from_value::<ProviderTraceTerminalV1>(value).map_err(|error| {
                        ProviderTraceErrorV1::invalid(
                            "provider_trace_recovery_invalid",
                            format!("Decode Provider trace terminal for recovery: {error}"),
                        )
                    })?;
                decoded.validate()?;
                terminal = Some(decoded);
            }
            _ => {}
        }
    }
    let terminal = terminal.ok_or_else(|| {
        ProviderTraceErrorV1::invalid(
            "provider_trace_recovery_invalid",
            "Provider trace recovery cannot find its verified terminal",
        )
    })?;
    if terminal.kind != metadata.terminal_kind {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_recovery_invalid",
            "Provider trace recovery terminal kind conflicts with verified metadata",
        ));
    }
    match terminal.kind {
        ProviderTraceTerminalKindV1::Completed => {
            let request_body = exact_request_body
                .take()
                .ok_or_else(provider_trace_completed_recovery_invalid)?;
            let completed_evidence = completed
                .as_mut()
                .ok_or_else(provider_trace_completed_recovery_invalid)?;
            if terminal.reason_code.is_some()
                || !completed_evidence.reasoning_present
                || completed_sequence.and_then(|sequence| sequence.checked_add(2))
                    != Some(metadata.record_count)
                || sha256_prefixed(&request_body) != metadata.request_digest
                || recovered_raw_source_bytes != metadata.raw_source_bytes
                || reasoning.trim().is_empty()
                || sha256_prefixed(reasoning.as_bytes()) != completed_evidence.reasoning_digest
            {
                return Err(provider_trace_completed_recovery_invalid());
            }
            completed_evidence.exact_request_body = request_body;
            completed_evidence.reasoning = reasoning;
            completed_evidence.raw_upstream_envelopes = raw_upstream_envelopes;
        }
        ProviderTraceTerminalKindV1::Failed
        | ProviderTraceTerminalKindV1::Cancelled
        | ProviderTraceTerminalKindV1::LimitExceeded => {
            if terminal.reason_code.is_none() {
                return Err(ProviderTraceErrorV1::invalid(
                    "provider_trace_recovery_invalid",
                    "Non-completed Provider trace terminal requires a reasonCode",
                ));
            }
            completed = None;
        }
    }
    Ok(ProviderTraceTerminalRecoveryV1 {
        metadata,
        reason_code: terminal.reason_code,
        completed,
    })
}

fn provider_trace_completed_recovery_invalid() -> ProviderTraceErrorV1 {
    ProviderTraceErrorV1::invalid(
        "provider_trace_completed_recovery_invalid",
        "Completed Provider trace lacks deterministic safe terminal evidence",
    )
}

fn ensure_provider_trace_export_deadline(
    deadline: Option<Instant>,
) -> Result<(), ProviderTraceErrorV1> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(ProviderTraceErrorV1::invalid(
            PROVIDER_TRACE_EXPORT_DEADLINE_EXCEEDED_V1,
            "Provider trace export capability deadline elapsed during archive validation",
        ));
    }
    Ok(())
}

fn read_bounded_provider_trace_line(
    reader: &mut impl BufRead,
) -> Result<Option<Vec<u8>>, ProviderTraceErrorV1> {
    let read_limit = PROVIDER_TRACE_RECORD_HARD_LIMIT_V1
        .checked_add(2)
        .and_then(|value| u64::try_from(value).ok())
        .expect("Provider trace record limit fits u64");
    let mut line = Vec::with_capacity(PROVIDER_TRACE_FLUSH_BYTES_V1);
    let bytes_read = reader
        .take(read_limit)
        .read_until(b'\n', &mut line)
        .map_err(|error| {
            ProviderTraceErrorV1::io(
                "provider_trace_read_failed",
                format!("Read Provider trace archive: {error}"),
            )
        })?;
    if bytes_read == 0 {
        return Ok(None);
    }
    let has_record_boundary = line.last() == Some(&b'\n');
    let record_bytes = line.len().saturating_sub(usize::from(has_record_boundary));
    if record_bytes > PROVIDER_TRACE_RECORD_HARD_LIMIT_V1 {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_record_size_invalid",
            "Provider trace record exceeded its bounded verification size",
        ));
    }
    if !has_record_boundary {
        return Err(ProviderTraceErrorV1::invalid(
            "provider_trace_archive_unsealed",
            "Provider trace archive is still active or lacks a durable final record boundary",
        ));
    }
    Ok(Some(line))
}

fn lower_hex(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(value.len() * 2);
    for byte in value {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_trace_bytes(
    payload: &serde_json::Map<String, Value>,
    encoding_field: &'static str,
    base64_field: &'static str,
    byte_length_field: &'static str,
    digest_field: &'static str,
    maximum_bytes: usize,
    error_code: &'static str,
) -> Result<Vec<u8>, ProviderTraceErrorV1> {
    if payload.get(encoding_field).and_then(Value::as_str) != Some("base64") {
        return Err(ProviderTraceErrorV1::invalid(
            error_code,
            format!("Provider trace {encoding_field} must be base64"),
        ));
    }
    let encoded = payload
        .get(base64_field)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                error_code,
                format!("Provider trace {base64_field} is missing"),
            )
        })?;
    let declared_length = payload
        .get(byte_length_field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value <= maximum_bytes)
        .ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                error_code,
                format!("Provider trace {byte_length_field} is invalid"),
            )
        })?;
    let maximum_encoded_bytes = maximum_bytes.div_ceil(3).checked_mul(4).ok_or_else(|| {
        ProviderTraceErrorV1::invalid(error_code, "Provider trace base64 size overflowed")
    })?;
    if encoded.len() > maximum_encoded_bytes {
        return Err(ProviderTraceErrorV1::invalid(
            error_code,
            format!("Provider trace {base64_field} exceeds its bounded size"),
        ));
    }
    let decoded = decode_base64_bounded(encoded, maximum_bytes).map_err(|message| {
        ProviderTraceErrorV1::invalid(
            error_code,
            format!("Decode Provider trace bytes: {message}"),
        )
    })?;
    if decoded.len() != declared_length {
        return Err(ProviderTraceErrorV1::invalid(
            error_code,
            format!("Provider trace {byte_length_field} does not match decoded bytes"),
        ));
    }
    let digest = payload
        .get(digest_field)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                error_code,
                format!("Provider trace {digest_field} is missing"),
            )
        })?;
    validate_sha256_digest(digest, digest_field)?;
    if sha256_prefixed(&decoded) != digest {
        return Err(ProviderTraceErrorV1::invalid(
            error_code,
            format!("Provider trace {digest_field} does not match decoded bytes"),
        ));
    }
    Ok(decoded)
}

fn decode_base64_bounded(encoded: &str, maximum_bytes: usize) -> Result<Vec<u8>, &'static str> {
    if encoded.len() % 4 != 0 {
        return Err("base64 length is not a multiple of four");
    }
    let estimated_length = encoded
        .len()
        .checked_div(4)
        .and_then(|chunks| chunks.checked_mul(3))
        .ok_or("base64 decoded length overflowed")?;
    if estimated_length > maximum_bytes.saturating_add(2) {
        return Err("base64 decoded length exceeds its limit");
    }
    let mut output = Vec::with_capacity(estimated_length.min(maximum_bytes));
    let chunks = encoded.as_bytes().chunks_exact(4);
    let chunk_count = chunks.len();
    for (index, chunk) in chunks.enumerate() {
        let last = index + 1 == chunk_count;
        let first = decode_base64_digit(chunk[0]).ok_or("base64 contains an invalid digit")?;
        let second = decode_base64_digit(chunk[1]).ok_or("base64 contains an invalid digit")?;
        let third_padding = chunk[2] == b'=';
        let fourth_padding = chunk[3] == b'=';
        if third_padding && !fourth_padding {
            return Err("base64 padding is invalid");
        }
        if (third_padding || fourth_padding) && !last {
            return Err("base64 padding appears before the final quartet");
        }
        let third = if third_padding {
            0
        } else {
            decode_base64_digit(chunk[2]).ok_or("base64 contains an invalid digit")?
        };
        let fourth = if fourth_padding {
            0
        } else {
            decode_base64_digit(chunk[3]).ok_or("base64 contains an invalid digit")?
        };
        if third_padding && second & 0x0f != 0 {
            return Err("base64 has non-canonical trailing bits");
        }
        if fourth_padding && !third_padding && third & 0x03 != 0 {
            return Err("base64 has non-canonical trailing bits");
        }
        let additional = 1 + usize::from(!third_padding) + usize::from(!fourth_padding);
        if output.len().saturating_add(additional) > maximum_bytes {
            return Err("base64 decoded length exceeds its limit");
        }
        output.push((first << 2) | (second >> 4));
        if !third_padding {
            output.push((second << 4) | (third >> 2));
        }
        if !fourth_padding {
            output.push((third << 6) | fourth);
        }
    }
    Ok(output)
}

fn decode_base64_digit(value: u8) -> Option<u8> {
    match value {
        b'A'..=b'Z' => Some(value - b'A'),
        b'a'..=b'z' => Some(value - b'a' + 26),
        b'0'..=b'9' => Some(value - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub(crate) struct ProviderTraceWriterV1 {
    identity: ProviderTraceIdentityV1,
    request_digest: String,
    writer: BufWriter<File>,
    sequence: u64,
    last_digest: Option<String>,
    pending_bytes: usize,
    last_durable_flush: Instant,
    raw_source_bytes: usize,
    raw_limit_exceeded: bool,
    response_started: bool,
    sealed: bool,
    poisoned: bool,
}

impl ProviderTraceWriterV1 {
    pub(crate) fn response_boundary(
        &mut self,
        boundary: ProviderTraceResponseBoundaryV1,
    ) -> Result<ProviderTraceArchiveCheckpointV1, ProviderTraceErrorV1> {
        self.ensure_writable()?;
        boundary.validate()?;
        if self.response_started {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_response_already_started",
                "Provider response boundary may be recorded only once",
            ));
        }
        self.response_started = true;
        self.append_record(
            "responseBoundary",
            serde_json::to_value(boundary).map_err(|error| {
                ProviderTraceErrorV1::invalid(
                    "provider_trace_encode_failed",
                    format!("Encode Provider response boundary: {error}"),
                )
            })?,
        )?;
        self.flush_durable()
    }

    /// Archives one complete upstream envelope without interpreting its body.
    ///
    /// The soft-limit result is returned only after the crossing envelope has
    /// been fully appended and durably flushed.
    pub(crate) fn append_raw_upstream_envelope(
        &mut self,
        exact_source_bytes: &[u8],
    ) -> Result<ProviderTraceRawAppendV1, ProviderTraceErrorV1> {
        self.ensure_response_writable()?;
        if exact_source_bytes.len() > PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1 {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_envelope_too_large",
                format!(
                    "Provider envelope is {} bytes; the hard limit is {} bytes",
                    exact_source_bytes.len(),
                    PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1
                ),
            ));
        }

        let next_raw_source_bytes = self
            .raw_source_bytes
            .checked_add(exact_source_bytes.len())
            .ok_or_else(|| {
                ProviderTraceErrorV1::invalid(
                    "provider_trace_source_size_overflow",
                    "Provider trace raw source byte count overflowed",
                )
            })?;
        let payload = json!({
            "sourceEncoding": "base64",
            "sourceBase64": encode_base64(exact_source_bytes),
            "sourceByteLength": exact_source_bytes.len(),
            "sourceDigest": sha256_prefixed(exact_source_bytes),
        });
        self.append_record("rawUpstreamEnvelope", payload)?;
        self.raw_source_bytes = next_raw_source_bytes;

        if self.raw_source_bytes > PROVIDER_TRACE_RAW_SOURCE_SOFT_LIMIT_V1 {
            self.raw_limit_exceeded = true;
            self.flush_durable()?;
            return Ok(ProviderTraceRawAppendV1::LimitExceeded {
                raw_source_bytes: self.raw_source_bytes,
                soft_limit_bytes: PROVIDER_TRACE_RAW_SOURCE_SOFT_LIMIT_V1,
            });
        }
        self.flush_if_policy_due(Instant::now())?;
        Ok(ProviderTraceRawAppendV1::Archived {
            raw_source_bytes: self.raw_source_bytes,
        })
    }

    pub(crate) fn append_normalized_event(
        &mut self,
        event: Value,
    ) -> Result<(), ProviderTraceErrorV1> {
        self.ensure_response_writable()?;
        reject_structured_trace_secrets(&event)?;
        self.append_record("normalizedEvent", json!({ "event": event }))?;
        self.flush_if_policy_due(Instant::now())?;
        Ok(())
    }

    pub(crate) fn flush_if_due(
        &mut self,
        now: Instant,
    ) -> Result<Option<ProviderTraceArchiveCheckpointV1>, ProviderTraceErrorV1> {
        self.ensure_writable()?;
        if self.pending_bytes == 0
            || now.duration_since(self.last_durable_flush) < PROVIDER_TRACE_FLUSH_INTERVAL_V1
        {
            return Ok(None);
        }
        self.flush_durable().map(Some)
    }

    pub(crate) fn next_flush_deadline(&self) -> Option<Instant> {
        (self.pending_bytes > 0).then(|| self.last_durable_flush + PROVIDER_TRACE_FLUSH_INTERVAL_V1)
    }

    pub(crate) fn archive_before_publication<T>(
        &mut self,
        publication: impl FnOnce(&ProviderTraceArchiveCheckpointV1) -> T,
    ) -> Result<T, ProviderTraceErrorV1> {
        self.ensure_response_writable()?;
        let checkpoint = self.flush_durable()?;
        Ok(publication(&checkpoint))
    }

    pub(crate) fn finish(
        &mut self,
        terminal: ProviderTraceTerminalV1,
    ) -> Result<ProviderTraceMetadataV1, ProviderTraceErrorV1> {
        self.ensure_writable()?;
        terminal.validate()?;
        if self.raw_limit_exceeded && terminal.kind != ProviderTraceTerminalKindV1::LimitExceeded {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_limit_terminal_required",
                "A Provider trace that crossed the raw source limit must terminate as limitExceeded",
            ));
        }
        if !self.raw_limit_exceeded && terminal.kind == ProviderTraceTerminalKindV1::LimitExceeded {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_limit_terminal_invalid",
                "limitExceeded terminal requires an archived envelope that crossed the soft limit",
            ));
        }

        let terminal_kind = terminal.kind;
        self.append_record(
            "terminal",
            serde_json::to_value(&terminal).map_err(|error| {
                ProviderTraceErrorV1::invalid(
                    "provider_trace_encode_failed",
                    format!("Encode Provider trace terminal: {error}"),
                )
            })?,
        )?;
        let terminal_checkpoint = self.flush_durable()?;
        let terminal_digest = terminal_checkpoint.archived_through_digest.clone();
        let terminal_sequence = terminal_checkpoint.archived_through_sequence;

        self.append_record(
            "seal",
            json!({
                "terminalSequence": terminal_sequence,
                "terminalDigest": terminal_digest,
                "recordCountBeforeSeal": terminal_sequence,
                "rawSourceBytes": self.raw_source_bytes,
                "requestDigest": self.request_digest,
            }),
        )?;
        let seal_checkpoint = self.flush_durable()?;
        self.sealed = true;

        Ok(ProviderTraceMetadataV1 {
            schema_version: PROVIDER_TRACE_SCHEMA_V1,
            session_id: self.identity.session_id.clone(),
            run_id: self.identity.run_id.clone(),
            user_turn_id: self.identity.user_turn_id.clone(),
            provider_turn_id: self.identity.provider_turn_id.clone(),
            provider_kind: self.identity.provider_kind.clone(),
            model: self.identity.model.clone(),
            profile_id: self.identity.profile_id.clone(),
            profile_revision: self.identity.profile_revision.clone(),
            control_epoch: self.identity.control_epoch,
            purpose: self.identity.purpose,
            request_digest: self.request_digest.clone(),
            record_count: seal_checkpoint.archived_through_sequence,
            raw_source_bytes: self.raw_source_bytes,
            terminal_kind,
            terminal_digest,
            seal_digest: seal_checkpoint.archived_through_digest,
        })
    }

    fn ensure_writable(&self) -> Result<(), ProviderTraceErrorV1> {
        if self.poisoned {
            return Err(ProviderTraceErrorV1::io(
                "provider_trace_writer_poisoned",
                "Provider trace writer cannot continue after an archive failure",
            ));
        }
        if self.sealed {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_already_sealed",
                "Provider trace is already sealed",
            ));
        }
        Ok(())
    }

    fn ensure_response_writable(&self) -> Result<(), ProviderTraceErrorV1> {
        self.ensure_writable()?;
        if !self.response_started {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_response_not_started",
                "Provider response boundary must be archived before response events",
            ));
        }
        if self.raw_limit_exceeded {
            return Err(ProviderTraceErrorV1::invalid(
                "provider_trace_limit_exceeded",
                "Provider trace crossed the raw source soft limit and cannot publish or append more response data",
            ));
        }
        Ok(())
    }

    fn append_record(
        &mut self,
        record_kind: &'static str,
        payload: Value,
    ) -> Result<(), ProviderTraceErrorV1> {
        self.ensure_writable()?;
        let sequence = self.sequence.checked_add(1).ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_sequence_overflow",
                "Provider trace sequence overflowed",
            )
        })?;
        let mut record = json!({
            "schemaVersion": PROVIDER_TRACE_SCHEMA_V1,
            "traceId": self.identity.provider_turn_id,
            "sequence": sequence,
            "previousDigest": self.last_digest,
            "recordedAt": now_millis_text(),
            "recordKind": record_kind,
            "payload": payload,
        });
        let digest = stable_json_sha256(&record)?;
        let record_object = record.as_object_mut().ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_encode_failed",
                "Provider trace record envelope is not an object",
            )
        })?;
        record_object.insert("digest".to_string(), json!(digest));
        let mut encoded = serde_json::to_vec(&record).map_err(|error| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_encode_failed",
                format!("Encode Provider trace record: {error}"),
            )
        })?;
        encoded.push(b'\n');

        if let Err(error) = self.writer.write_all(&encoded) {
            self.poisoned = true;
            return Err(ProviderTraceErrorV1::io(
                "provider_trace_write_failed",
                format!("Write Provider trace record: {error}"),
            ));
        }
        self.sequence = sequence;
        self.last_digest = record
            .get("digest")
            .and_then(Value::as_str)
            .map(str::to_string);
        self.pending_bytes = self.pending_bytes.saturating_add(encoded.len());
        Ok(())
    }

    fn flush_if_policy_due(&mut self, now: Instant) -> Result<(), ProviderTraceErrorV1> {
        if self.pending_bytes >= PROVIDER_TRACE_FLUSH_BYTES_V1
            || now.duration_since(self.last_durable_flush) >= PROVIDER_TRACE_FLUSH_INTERVAL_V1
        {
            self.flush_durable()?;
        }
        Ok(())
    }

    fn flush_durable(&mut self) -> Result<ProviderTraceArchiveCheckpointV1, ProviderTraceErrorV1> {
        self.ensure_writable()?;
        if let Err(error) = self
            .writer
            .flush()
            .and_then(|_| self.writer.get_ref().sync_all())
        {
            self.poisoned = true;
            return Err(ProviderTraceErrorV1::io(
                "provider_trace_flush_failed",
                format!("Durably flush Provider trace archive: {error}"),
            ));
        }
        self.pending_bytes = 0;
        self.last_durable_flush = Instant::now();
        let digest = self.last_digest.clone().ok_or_else(|| {
            ProviderTraceErrorV1::invalid(
                "provider_trace_checkpoint_missing",
                "Provider trace has no archived record",
            )
        })?;
        Ok(ProviderTraceArchiveCheckpointV1 {
            trace_id: self.identity.provider_turn_id.clone(),
            archived_through_sequence: self.sequence,
            archived_through_digest: digest,
            raw_source_bytes: self.raw_source_bytes,
        })
    }
}

impl Drop for ProviderTraceWriterV1 {
    fn drop(&mut self) {
        if self.sealed || self.poisoned {
            return;
        }
        let terminal = ProviderTraceTerminalV1 {
            kind: if self.raw_limit_exceeded {
                ProviderTraceTerminalKindV1::LimitExceeded
            } else {
                ProviderTraceTerminalKindV1::Cancelled
            },
            reason_code: Some(if self.raw_limit_exceeded {
                "provider_trace_raw_limit_exceeded".to_string()
            } else {
                "provider_stream_consumer_cancelled".to_string()
            }),
        };
        let _ = self.append_record(
            "terminal",
            serde_json::to_value(&terminal).unwrap_or_else(|_| {
                json!({
                    "kind": "cancelled",
                    "reasonCode": "provider_trace_drop_encode_failed",
                })
            }),
        );
        let terminal_checkpoint = self.flush_durable();
        if let Ok(terminal_checkpoint) = terminal_checkpoint {
            let _ = self.append_record(
                "seal",
                json!({
                    "terminalSequence": terminal_checkpoint.archived_through_sequence,
                    "terminalDigest": terminal_checkpoint.archived_through_digest,
                    "recordCountBeforeSeal": terminal_checkpoint.archived_through_sequence,
                    "rawSourceBytes": self.raw_source_bytes,
                    "requestDigest": self.request_digest,
                }),
            );
            if self.flush_durable().is_ok() {
                self.sealed = true;
            }
        }
    }
}

fn reject_structured_trace_secrets(value: &Value) -> Result<(), ProviderTraceErrorV1> {
    match value {
        Value::Array(values) => {
            for value in values {
                reject_structured_trace_secrets(value)?;
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                let normalized = key
                    .bytes()
                    .filter(u8::is_ascii_alphanumeric)
                    .map(|byte| byte.to_ascii_lowercase())
                    .collect::<Vec<_>>();
                if matches!(
                    normalized.as_slice(),
                    b"authorization"
                        | b"authorizationheader"
                        | b"cookie"
                        | b"setcookie"
                        | b"apikey"
                        | b"xapikey"
                        | b"capability"
                        | b"runcapability"
                        | b"decisioncapability"
                        | b"lease"
                        | b"leaseid"
                        | b"leaseversion"
                        | b"capabilitylease"
                        | b"capabilityleaseid"
                        | b"secret"
                        | b"secretref"
                        | b"clientsecret"
                        | b"accesstoken"
                        | b"refreshtoken"
                        | b"bearertoken"
                        | b"password"
                ) {
                    return Err(ProviderTraceErrorV1::invalid(
                        "provider_trace_secret_forbidden",
                        "Structured Provider trace events cannot contain transport secrets, capabilities, or leases",
                    ));
                }
                reject_structured_trace_secrets(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn now_millis_text() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
        .to_string()
}

fn secure_trace_file(_path: &Path) -> Result<(), ProviderTraceErrorV1> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            ProviderTraceErrorV1::io(
                "provider_trace_permissions_failed",
                format!("Secure Provider trace file: {error}"),
            )
        })?;
    }
    Ok(())
}

fn encode_base64(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or_default();
        let third = chunk.get(2).copied().unwrap_or_default();
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 0b11) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(ALPHABET[(((second & 0b1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(ALPHABET[(third & 0b11_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}
