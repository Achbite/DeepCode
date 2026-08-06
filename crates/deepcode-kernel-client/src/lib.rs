use deepcode_kernel_abi::{
    is_valid_host_shell_capability_v2, HOST_SHELL_CAPABILITY_ENV_V2,
    HOST_SHELL_CAPABILITY_HEADER_V2,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fmt;
use std::time::Duration;
use thiserror::Error;

mod agent;
mod agent_projection;
mod bootstrap;
mod v2;

pub use agent::{
    terminal_workspace_scope, AgentInputAttachmentKindV2, AgentInputAttachmentScopeV2,
    AgentInputAttachmentV2, AgentRunCallerRequest, AgentRunGuidanceRequest, AgentRunResult,
    AgentRunStatus, AgentSessionListResult, AgentSessionResult, CreateAgentSessionRequest,
    ListAgentSessionsRequest, StartAgentRunRequest, TerminalWorkspaceScope,
};
pub use agent_projection::{
    reduce_agent_timeline_stream_event, AgentProjectionValidationError, AgentTimelineAttachment,
    AgentTimelineAttachmentKind, AgentTimelineAttachmentScope, AgentTimelineBlock,
    AgentTimelineBlockKind, AgentTimelineCheckpointKind, AgentTimelineCurrentActivity,
    AgentTimelineCurrentActivityCode, AgentTimelineDecisionRequest, AgentTimelineDecisionSource,
    AgentTimelineDeliveryMode, AgentTimelineDelta, AgentTimelineDisplayDensity,
    AgentTimelineDisplayHints, AgentTimelineDurability, AgentTimelineEntryRole,
    AgentTimelineEvidenceMode, AgentTimelineExecutionPhase, AgentTimelineInteractionKind,
    AgentTimelineInteractionOption, AgentTimelineInteractionProjection,
    AgentTimelineInteractionState, AgentTimelineInteractionView, AgentTimelineLanguage,
    AgentTimelineLanguageBinding, AgentTimelineLanguageBindingStatus, AgentTimelineLocalizedText,
    AgentTimelineNarrativeKind, AgentTimelineNullableCurrentActivity, AgentTimelineNullableWait,
    AgentTimelineNullableWorkAttention, AgentTimelinePendingInteraction,
    AgentTimelinePendingPermission, AgentTimelinePendingPlan, AgentTimelinePermissionRequestKind,
    AgentTimelinePermissionRequestView, AgentTimelineProjectionReplacement,
    AgentTimelineProvenance, AgentTimelineProvenanceAuthority, AgentTimelineProvenanceOrigin,
    AgentTimelineProviderPhase, AgentTimelineRiskLevel, AgentTimelineRootProjectionReplacements,
    AgentTimelineRunPhase, AgentTimelineRunProjection, AgentTimelineRunStatus,
    AgentTimelineSelectedDecision, AgentTimelineSnapshot, AgentTimelineStatus,
    AgentTimelineStreamEvent, AgentTimelineStreamReduction, AgentTimelineStructuredProjection,
    AgentTimelineStructuredProjectionItem, AgentTimelineStructuredProjectionKind,
    AgentTimelineStructuredProjectionSection, AgentTimelineTaskProjection,
    AgentTimelineTaskProjectionItem, AgentTimelineTaskSettlementKind, AgentTimelineTaskStatus,
    AgentTimelineTokenUsageProjection, AgentTimelineTokenUsageRequest,
    AgentTimelineTokenUsageTotals, AgentTimelineTurn, AgentTimelineTurnPart, AgentTimelineWait,
    AgentTimelineWaitKind, AgentTimelineWorkAttention, AgentTimelineWorkAttentionKind,
    AgentTimelineWorkAttentionStatus, AgentTimelineWorkOperation,
    AgentTimelineWorkOperationAttempt, AgentTimelineWorkOperationStatus, AgentTimelineWorkSegment,
    AgentTimelineWorkSegmentLifecycle, AgentTimelineWorkspaceProjection,
    AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2,
    AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1,
};

const AGENT_TIMELINE_SSE_BUFFER_LIMIT_BYTES: usize = 16 * 1024 * 1024;

pub struct AgentTimelineSseStream {
    response: reqwest::Response,
    buffer: Vec<u8>,
    pending: VecDeque<AgentTimelineStreamEvent>,
    ended: bool,
}

impl AgentTimelineSseStream {
    pub async fn next_event(&mut self) -> KernelClientResult<Option<AgentTimelineStreamEvent>> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            if self.ended {
                if self.buffer.iter().any(|byte| !byte.is_ascii_whitespace()) {
                    return Err(KernelClientError::Api(
                        "timeline SSE ended with an incomplete event".to_string(),
                    ));
                }
                return Ok(None);
            }
            match self.response.chunk().await? {
                Some(chunk) => {
                    self.buffer.extend_from_slice(&chunk);
                    self.consume_complete_events()?;
                    if self.buffer.len() > AGENT_TIMELINE_SSE_BUFFER_LIMIT_BYTES {
                        return Err(KernelClientError::Api(
                            "timeline SSE event exceeds the client buffer limit".to_string(),
                        ));
                    }
                }
                None => {
                    self.ended = true;
                }
            }
        }
    }

    fn consume_complete_events(&mut self) -> KernelClientResult<()> {
        while let Some((boundary, separator_len)) = sse_event_boundary(&self.buffer) {
            if boundary > AGENT_TIMELINE_SSE_BUFFER_LIMIT_BYTES {
                return Err(KernelClientError::Api(
                    "timeline SSE event exceeds the client buffer limit".to_string(),
                ));
            }
            let raw = self.buffer[..boundary].to_vec();
            self.buffer.drain(..boundary + separator_len);
            if let Some(event) = decode_timeline_sse_event(&raw)? {
                self.pending.push_back(event);
            }
        }
        Ok(())
    }
}
pub use bootstrap::{DaemonStatus, KernelBootstrap, KernelBootstrapGuard, KernelBootstrapOptions};
pub use v2::{
    KernelV2ClientError, KernelV2ClientResult, KernelV2HttpErrorCode, SessionKernelV2Client,
};

#[derive(Debug, Error)]
pub enum KernelClientError {
    #[error("daemon request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("daemon returned error: {0}")]
    Api(String),
    #[error("daemon returned error: {code}: {message}")]
    HostCallerMutation {
        code: String,
        message: String,
        disposition: Option<HostCallerMutationDispositionV2>,
    },
    #[error("daemon response decode failed: {0}")]
    Decode(#[from] serde_json::Error),
    #[error(
        "Host shell admission capability is required through the v2 environment or KernelBootstrapOptions"
    )]
    HostAdmissionCapabilityMissing,
    #[error("Host shell admission capability does not use the required v2 format")]
    HostAdmissionCapabilityInvalid,
    #[error("daemon at {base_url} rejected the Host shell admission capability")]
    HostAdmissionRejected { base_url: String },
    #[error("daemon at {base_url} is unavailable: {reason}")]
    DaemonUnavailable { base_url: String, reason: String },
    #[error("kernel bootstrap failed: {0}")]
    Bootstrap(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostCallerMutationDispositionV2 {
    Rejected,
    Pending,
    Indeterminate,
}

pub type KernelClientResult<T> = Result<T, KernelClientError>;

#[derive(Clone)]
struct HostShellCapabilityV2(String);

impl fmt::Debug for HostShellCapabilityV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostShellCapabilityV2([REDACTED])")
    }
}

impl HostShellCapabilityV2 {
    fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    fn expose_to_transport(&self) -> &str {
        &self.0
    }
}

#[derive(Clone)]
pub struct KernelClientConfig {
    pub base_url: String,
    host_shell_capability: Option<HostShellCapabilityV2>,
}

impl fmt::Debug for KernelClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KernelClientConfig")
            .field("base_url", &self.base_url)
            .field(
                "host_shell_capability",
                &self.host_shell_capability.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl KernelClientConfig {
    pub fn from_env() -> Self {
        if let Ok(base_url) = std::env::var("DEEPCODE_API_URL") {
            return Self::new(base_url);
        }
        let host = std::env::var("DEEPCODE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("DEEPCODE_PORT").unwrap_or_else(|_| "31245".to_string());
        Self::new(format!("http://{host}:{port}"))
    }

    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            host_shell_capability: std::env::var(HOST_SHELL_CAPABILITY_ENV_V2)
                .ok()
                .map(HostShellCapabilityV2::new),
        }
    }

    pub fn with_host_shell_capability(mut self, capability: impl Into<String>) -> Self {
        self.host_shell_capability = Some(HostShellCapabilityV2::new(capability));
        self
    }

    pub(crate) fn has_host_shell_capability(&self) -> bool {
        self.host_shell_capability.is_some()
    }

    pub(crate) fn validate_host_shell_capability(&self) -> KernelClientResult<()> {
        if self
            .host_shell_capability
            .as_ref()
            .is_some_and(|capability| {
                !is_valid_host_shell_capability_v2(capability.expose_to_transport())
            })
        {
            return Err(KernelClientError::HostAdmissionCapabilityInvalid);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct HttpKernelClient {
    config: KernelClientConfig,
    http: reqwest::Client,
    stream_http: reqwest::Client,
}

impl HttpKernelClient {
    pub fn new(mut config: KernelClientConfig) -> KernelClientResult<Self> {
        config.validate_host_shell_capability()?;
        let capability = config
            .host_shell_capability
            .as_ref()
            .ok_or(KernelClientError::HostAdmissionCapabilityMissing)?;
        let mut capability_header = HeaderValue::from_str(capability.expose_to_transport())
            .map_err(|_| KernelClientError::HostAdmissionCapabilityInvalid)?;
        capability_header.set_sensitive(true);
        let mut default_headers = HeaderMap::new();
        default_headers.insert(
            HeaderName::from_static(HOST_SHELL_CAPABILITY_HEADER_V2),
            capability_header,
        );
        let stream_http = reqwest::Client::builder()
            .default_headers(default_headers.clone())
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .default_headers(default_headers)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        config.host_shell_capability = None;
        Ok(Self {
            config,
            http,
            stream_http,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    pub async fn health(&self) -> KernelClientResult<DaemonStatus> {
        let value = self
            .http
            .get(self.url("/api/health"))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let data = api_data(value)?;
        Ok(DaemonStatus {
            service: data
                .get("service")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            ok: data.get("ok").and_then(Value::as_bool).unwrap_or(true),
            raw: data,
        })
    }

    pub async fn daemon_status(&self) -> KernelClientResult<DaemonStatus> {
        self.health().await
    }

    pub async fn agent_timeline_v2(
        &self,
        session_id: &str,
    ) -> KernelClientResult<AgentTimelineSnapshot> {
        self.agent_timeline_v2_optional(session_id)
            .await?
            .ok_or_else(|| {
                KernelClientError::Api("Session v2 public timeline is not available".to_string())
            })
    }

    pub async fn agent_timeline_v2_optional(
        &self,
        session_id: &str,
    ) -> KernelClientResult<Option<AgentTimelineSnapshot>> {
        let value = self
            .http
            .get(self.url(&format!("/api/agent/sessions/{session_id}/timeline")))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        if value.get("ok").and_then(Value::as_bool) == Some(false)
            && value.get("error").and_then(Value::as_str) == Some("agent_timeline_unavailable")
        {
            return Ok(None);
        }
        let value = api_data(value)?;
        agent_projection::reject_private_projection_fields(&value)
            .map_err(|error| KernelClientError::Api(error.to_string()))?;
        let timeline = serde_json::from_value::<AgentTimelineSnapshot>(value)?;
        timeline
            .validate()
            .map_err(|error| KernelClientError::Api(error.to_string()))?;
        Ok(Some(timeline))
    }

    pub async fn agent_timeline_stream_v2(
        &self,
        session_id: &str,
        after_revision: Option<u64>,
    ) -> KernelClientResult<AgentTimelineSseStream> {
        let response = self
            .stream_http
            .get(self.url(&format!("/api/agent/sessions/{session_id}/timeline/stream")))
            .query(
                &after_revision
                    .map(|revision| [("afterRevision", revision)])
                    .unwrap_or_default(),
            )
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await?
            .error_for_status()?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !content_type
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
        {
            return Err(KernelClientError::Api(
                "timeline stream did not return text/event-stream".to_string(),
            ));
        }
        Ok(AgentTimelineSseStream {
            response,
            buffer: Vec::new(),
            pending: VecDeque::new(),
            ended: false,
        })
    }

    pub async fn list_agent_sessions(
        &self,
        request: ListAgentSessionsRequest,
    ) -> KernelClientResult<AgentSessionListResult> {
        let value = self
            .http
            .get(self.url("/api/agent/sessions"))
            .query(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn current_agent_session(
        &self,
        request: ListAgentSessionsRequest,
    ) -> KernelClientResult<Option<AgentSessionResult>> {
        let value = self
            .http
            .get(self.url("/api/agent/sessions/current"))
            .query(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let data = api_data(value)?;
        if data.is_null() {
            Ok(None)
        } else {
            Ok(Some(serde_json::from_value(data)?))
        }
    }

    pub async fn create_agent_session(
        &self,
        request: CreateAgentSessionRequest,
    ) -> KernelClientResult<AgentSessionResult> {
        let value = self
            .http
            .post(self.url("/api/agent/sessions"))
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn activate_agent_session(
        &self,
        session_id: &str,
    ) -> KernelClientResult<AgentSessionResult> {
        let value = self
            .http
            .post(self.url(&format!("/api/agent/sessions/{session_id}/activate")))
            .json(&json!({}))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn rename_agent_session(
        &self,
        session_id: &str,
        title: impl Into<String>,
    ) -> KernelClientResult<AgentSessionResult> {
        let value = self
            .http
            .patch(self.url(&format!("/api/agent/sessions/{session_id}")))
            .json(&json!({ "title": title.into() }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn update_agent_session_profile(
        &self,
        session_id: &str,
        profile_id: Option<&str>,
    ) -> KernelClientResult<AgentSessionResult> {
        let value = self
            .http
            .patch(self.url(&format!("/api/agent/sessions/{session_id}")))
            .json(&json!({ "profileId": profile_id }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data_with_code(value)
    }

    pub async fn archive_agent_session(
        &self,
        session_id: &str,
        archived: bool,
    ) -> KernelClientResult<AgentSessionListResult> {
        let value = self
            .http
            .post(self.url(&format!("/api/agent/sessions/{session_id}/archive")))
            .json(&json!({ "archived": archived }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn delete_agent_session(
        &self,
        session_id: &str,
    ) -> KernelClientResult<AgentSessionListResult> {
        let value = self
            .http
            .delete(self.url(&format!("/api/agent/sessions/{session_id}")))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn get_agent_session(
        &self,
        session_id: &str,
    ) -> KernelClientResult<AgentSessionResult> {
        let value = self
            .http
            .get(self.url(&format!("/api/agent/sessions/{session_id}")))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn start_agent_run(
        &self,
        session_id: &str,
        request: StartAgentRunRequest,
    ) -> KernelClientResult<AgentRunResult> {
        request.validate()?;
        let value = self
            .http
            .post(self.url(&format!("/api/agent/sessions/{session_id}/runs")))
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data_with_code(value)
    }

    pub async fn get_agent_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> KernelClientResult<AgentRunResult> {
        let value = self
            .http
            .get(self.url(&format!("/api/agent/sessions/{session_id}/runs/{run_id}")))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn active_agent_run(
        &self,
        session_id: &str,
    ) -> KernelClientResult<Option<AgentRunResult>> {
        let value = self
            .http
            .get(self.url(&format!("/api/agent/sessions/{session_id}/active-run")))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn cancel_agent_run_by_id(
        &self,
        session_id: &str,
        run_id: &str,
        request: AgentRunCallerRequest,
    ) -> KernelClientResult<AgentRunResult> {
        request.validate()?;
        let value = self
            .http
            .post(self.url(&format!(
                "/api/agent/sessions/{session_id}/runs/{run_id}/cancel"
            )))
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn submit_agent_run_guidance(
        &self,
        session_id: &str,
        run_id: &str,
        request: AgentRunGuidanceRequest,
    ) -> KernelClientResult<AgentRunResult> {
        request.validate()?;
        let value = self
            .http
            .post(self.url(&format!(
                "/api/agent/sessions/{session_id}/runs/{run_id}/guidance"
            )))
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data_with_code(value)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.config.base_url, path)
    }
}

fn api_data(value: Value) -> KernelClientResult<Value> {
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let message = value
            .get("message")
            .or_else(|| value.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("unknown daemon error");
        return Err(KernelClientError::Api(message.to_string()));
    }
    Ok(value.get("data").cloned().unwrap_or(value))
}

fn decode_api_data<T: DeserializeOwned>(value: Value) -> KernelClientResult<T> {
    Ok(serde_json::from_value(api_data(value)?)?)
}

fn decode_api_data_with_code<T: DeserializeOwned>(value: Value) -> KernelClientResult<T> {
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let code = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("daemon_error");
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown daemon error");
        let disposition = match (
            value.pointer("/data/schemaVersion").and_then(Value::as_str),
            value.pointer("/data/disposition").and_then(Value::as_str),
        ) {
            (Some("deepcode.host.caller-mutation-error.v2"), Some("rejected")) => {
                Some(HostCallerMutationDispositionV2::Rejected)
            }
            (Some("deepcode.host.caller-mutation-error.v2"), Some("pending")) => {
                Some(HostCallerMutationDispositionV2::Pending)
            }
            (Some("deepcode.host.caller-mutation-error.v2"), Some("indeterminate")) => {
                Some(HostCallerMutationDispositionV2::Indeterminate)
            }
            _ => None,
        };
        return Err(KernelClientError::HostCallerMutation {
            code: code.to_string(),
            message: message.to_string(),
            disposition,
        });
    }
    decode_api_data(value)
}

fn sse_event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(boundary), None) | (None, Some(boundary)) => Some(boundary),
        (None, None) => None,
    }
}

fn decode_timeline_sse_event(raw: &[u8]) -> KernelClientResult<Option<AgentTimelineStreamEvent>> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| KernelClientError::Api("timeline SSE event is not valid UTF-8".to_string()))?;
    let mut event_name = None;
    let mut data = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = line
            .split_once(':')
            .map(|(field, value)| (field, value.strip_prefix(' ').unwrap_or(value)))
            .unwrap_or((line, ""));
        match field {
            "event" => event_name = Some(value),
            "data" => data.push(value),
            _ => {}
        }
    }
    if data.is_empty() {
        return Ok(None);
    }
    let event_name = event_name.ok_or_else(|| {
        KernelClientError::Api("timeline SSE event has no explicit type".to_string())
    })?;
    if !matches!(event_name, "snapshot" | "delta") {
        return Err(KernelClientError::Api(format!(
            "timeline SSE returned unsupported event type {event_name}"
        )));
    }
    let event = serde_json::from_str::<AgentTimelineStreamEvent>(&data.join("\n"))?;
    event
        .validate()
        .map_err(|error| KernelClientError::Api(error.to_string()))?;
    match (&event, event_name) {
        (AgentTimelineStreamEvent::Snapshot { .. }, "snapshot")
        | (AgentTimelineStreamEvent::Delta { .. }, "delta") => Ok(Some(event)),
        _ => Err(KernelClientError::Api(
            "timeline SSE event name does not match its typed envelope".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_base_url_slash() {
        let config = KernelClientConfig::new("http://127.0.0.1:31245/");
        assert_eq!(config.base_url, "http://127.0.0.1:31245");
    }

    #[test]
    fn host_shell_capability_debug_output_is_redacted() {
        let capability = format!("dchostv2_{}", "a".repeat(64));
        let config = KernelClientConfig::new("http://127.0.0.1:31245")
            .with_host_shell_capability(capability.clone());
        let debug = format!("{config:?}");

        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains(&capability));
    }

    #[test]
    fn host_shell_capability_is_required_and_validated() {
        let missing = KernelClientConfig {
            base_url: "http://127.0.0.1:31245".to_owned(),
            host_shell_capability: None,
        };
        assert!(matches!(
            HttpKernelClient::new(missing),
            Err(KernelClientError::HostAdmissionCapabilityMissing)
        ));

        let invalid = KernelClientConfig {
            base_url: "http://127.0.0.1:31245".to_owned(),
            host_shell_capability: Some(HostShellCapabilityV2::new("short")),
        };
        assert!(matches!(
            HttpKernelClient::new(invalid),
            Err(KernelClientError::HostAdmissionCapabilityInvalid)
        ));
    }

    #[test]
    fn session_kernel_v2_client_rejects_non_loopback_origins() {
        let run_capability =
            deepcode_kernel_abi::RunCapabilityV2::new("run-capability-secret-0001")
                .expect("valid run capability");

        assert!(matches!(
            SessionKernelV2Client::new(
                KernelClientConfig::new("https://example.com"),
                run_capability
            ),
            Err(KernelV2ClientError::InvalidBaseUrl)
        ));
    }
}
