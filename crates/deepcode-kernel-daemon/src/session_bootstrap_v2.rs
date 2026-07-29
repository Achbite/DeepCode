use crate::host_v2_storage::{
    canonical_json_bytes, canonical_sha256, reject_transport_capabilities,
    validate_bounded_identity, validate_safe_session_identity, validate_sha256_digest,
    HostV2StorageError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const PRIOR_EVENTS_SCHEMA_V2: &str = "deepcode.host.session-prior-events.v2";
const PROVIDER_PROFILE_SCHEMA_V2: &str = "deepcode.host.provider-profile-bootstrap.v2";
const MAX_PRIOR_EVENTS_V2: usize = 512;
const MAX_PRIOR_EVENTS_BYTES_V2: usize = 2 * 1024 * 1024;
const MAX_PROVIDER_TOKENS_V2: u64 = 1_000_000_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostSessionPriorEventsV2 {
    pub(crate) schema_version: String,
    pub(crate) session_id: String,
    pub(crate) source_event_version: u64,
    pub(crate) selected_event_count: u64,
    pub(crate) omitted_event_count: u64,
    pub(crate) events: Vec<Value>,
    pub(crate) events_digest: String,
    pub(crate) snapshot_digest: String,
}

impl HostSessionPriorEventsV2 {
    pub(crate) fn bounded(
        session_id: &str,
        source_events: Vec<Value>,
    ) -> Result<Self, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        let source_event_version = u64::try_from(source_events.len()).map_err(|_| {
            HostV2StorageError::invalid(
                "host_session_prior_events_count_invalid",
                "Prior Session event count is not representable",
            )
        })?;
        let mut selected = Vec::new();
        for event in source_events.into_iter().rev() {
            if selected.len() >= MAX_PRIOR_EVENTS_V2 {
                break;
            }
            reject_transport_capabilities(&event)?;
            let candidate = std::iter::once(&event)
                .chain(selected.iter())
                .cloned()
                .collect::<Vec<_>>();
            if canonical_json_bytes(&Value::Array(candidate))?.len() > MAX_PRIOR_EVENTS_BYTES_V2 {
                break;
            }
            selected.insert(0, event);
        }
        let selected_event_count = u64::try_from(selected.len()).map_err(|_| {
            HostV2StorageError::invalid(
                "host_session_prior_events_count_invalid",
                "Selected prior Session event count is not representable",
            )
        })?;
        let omitted_event_count = source_event_version
            .checked_sub(selected_event_count)
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "host_session_prior_events_count_invalid",
                    "Prior Session event bounds are inconsistent",
                )
            })?;
        let events_value = Value::Array(selected.clone());
        let events_digest = canonical_sha256(&events_value)?;
        let snapshot_digest = canonical_sha256(&json!({
            "schemaVersion": PRIOR_EVENTS_SCHEMA_V2,
            "sessionId": session_id,
            "sourceEventVersion": source_event_version,
            "selectedEventCount": selected_event_count,
            "omittedEventCount": omitted_event_count,
            "events": events_value,
            "eventsDigest": events_digest,
        }))?;
        let snapshot = Self {
            schema_version: PRIOR_EVENTS_SCHEMA_V2.to_string(),
            session_id: session_id.to_string(),
            source_event_version,
            selected_event_count,
            omitted_event_count,
            events: selected,
            events_digest,
            snapshot_digest,
        };
        snapshot.validate(session_id)?;
        Ok(snapshot)
    }

    pub(crate) fn validate(&self, expected_session_id: &str) -> Result<(), HostV2StorageError> {
        if self.schema_version != PRIOR_EVENTS_SCHEMA_V2 || self.session_id != expected_session_id {
            return Err(HostV2StorageError::invalid(
                "host_session_prior_events_schema_unsupported",
                "Prior Session events are not the exact run-bound v2 snapshot",
            ));
        }
        validate_safe_session_identity(&self.session_id)?;
        validate_sha256_digest(&self.events_digest, "eventsDigest")?;
        validate_sha256_digest(&self.snapshot_digest, "snapshotDigest")?;
        let events_value = Value::Array(self.events.clone());
        if self.events.len() > MAX_PRIOR_EVENTS_V2
            || canonical_json_bytes(&events_value)?.len() > MAX_PRIOR_EVENTS_BYTES_V2
            || u64::try_from(self.events.len()).ok() != Some(self.selected_event_count)
            || self
                .selected_event_count
                .checked_add(self.omitted_event_count)
                != Some(self.source_event_version)
            || canonical_sha256(&events_value)? != self.events_digest
        {
            return Err(HostV2StorageError::invalid(
                "host_session_prior_events_invalid",
                "Prior Session event snapshot failed its bounded content checks",
            ));
        }
        for event in &self.events {
            reject_transport_capabilities(event)?;
            let event_session_id =
                event
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        HostV2StorageError::invalid(
                            "host_session_prior_event_invalid",
                            "Prior Session AgentEvent has no Session identity",
                        )
                    })?;
            if event_session_id != self.session_id {
                return Err(HostV2StorageError::invalid(
                    "host_session_prior_event_invalid",
                    "Prior Session AgentEvent belongs to another Session",
                ));
            }
        }
        let expected_snapshot_digest = canonical_sha256(&json!({
            "schemaVersion": PRIOR_EVENTS_SCHEMA_V2,
            "sessionId": self.session_id,
            "sourceEventVersion": self.source_event_version,
            "selectedEventCount": self.selected_event_count,
            "omittedEventCount": self.omitted_event_count,
            "events": events_value,
            "eventsDigest": self.events_digest,
        }))?;
        if expected_snapshot_digest != self.snapshot_digest {
            return Err(HostV2StorageError::invalid(
                "host_session_prior_events_digest_mismatch",
                "Prior Session event snapshot failed exact digest verification",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostProviderProfileBootstrapV2 {
    pub(crate) schema_version: String,
    pub(crate) provider_profile_id: String,
    pub(crate) provider_profile_revision_digest: String,
    pub(crate) context_window_tokens: u64,
    pub(crate) max_output_tokens: u64,
}

impl HostProviderProfileBootstrapV2 {
    pub(crate) fn new(
        provider_profile_id: String,
        provider_profile_revision_digest: String,
        context_window_tokens: u64,
        max_output_tokens: u64,
    ) -> Result<Self, HostV2StorageError> {
        let bootstrap = Self {
            schema_version: PROVIDER_PROFILE_SCHEMA_V2.to_string(),
            provider_profile_id,
            provider_profile_revision_digest,
            context_window_tokens,
            max_output_tokens,
        };
        bootstrap.validate()?;
        Ok(bootstrap)
    }

    pub(crate) fn validate(&self) -> Result<(), HostV2StorageError> {
        if self.schema_version != PROVIDER_PROFILE_SCHEMA_V2 {
            return Err(HostV2StorageError::invalid(
                "host_provider_profile_bootstrap_schema_unsupported",
                "Provider profile bootstrap schema is unsupported",
            ));
        }
        validate_bounded_identity(&self.provider_profile_id, "providerProfileId", 512)?;
        validate_sha256_digest(
            &self.provider_profile_revision_digest,
            "providerProfileRevisionDigest",
        )?;
        if self.context_window_tokens == 0
            || self.context_window_tokens > MAX_PROVIDER_TOKENS_V2
            || self.max_output_tokens == 0
            || self.max_output_tokens > MAX_PROVIDER_TOKENS_V2
            || self.max_output_tokens >= self.context_window_tokens
        {
            return Err(HostV2StorageError::invalid(
                "host_provider_profile_context_budget_invalid",
                "Provider context and output token limits must be positive, bounded, and leave input capacity",
            ));
        }
        Ok(())
    }
}
