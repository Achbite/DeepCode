use deepcode_kernel_abi::{
    is_valid_host_shell_capability_v2, HOST_SHELL_CAPABILITY_ENV_V2,
    HOST_SHELL_CAPABILITY_HEADER_V2,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
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
    AgentConversationActivity, AgentConversationActivityKind, AgentConversationActivitySource,
    AgentProjectionValidationError, AgentTimelineAttachment, AgentTimelineAttachmentKind,
    AgentTimelineAttachmentScope, AgentTimelineBlock, AgentTimelineBlockKind,
    AgentTimelineCheckpointKind, AgentTimelineCurrentActivity, AgentTimelineCurrentActivityCode,
    AgentTimelineDecisionRequest, AgentTimelineDecisionSource, AgentTimelineDeliveryMode,
    AgentTimelineDelta, AgentTimelineDisplayDensity, AgentTimelineDisplayHints,
    AgentTimelineDurability, AgentTimelineEntryRole, AgentTimelineEvidenceMode,
    AgentTimelineExecutionPhase, AgentTimelineInteractionKind, AgentTimelineInteractionOption,
    AgentTimelineInteractionProjection, AgentTimelineInteractionState,
    AgentTimelineInteractionView, AgentTimelineLanguage, AgentTimelineLanguageBinding,
    AgentTimelineLanguageBindingStatus, AgentTimelineLocalizedText, AgentTimelineNarrativeKind,
    AgentTimelineNullableCurrentActivity, AgentTimelineNullableWait,
    AgentTimelineNullableWorkAttention, AgentTimelinePendingInteraction,
    AgentTimelinePendingPermission, AgentTimelinePendingPlan, AgentTimelinePermissionRequestKind,
    AgentTimelinePermissionRequestView, AgentTimelineProjectionReplacement,
    AgentTimelineProvenance, AgentTimelineProvenanceAuthority, AgentTimelineProvenanceOrigin,
    AgentTimelineProviderPhase, AgentTimelineRiskLevel, AgentTimelineRootProjectionReplacements,
    AgentTimelineRunPhase, AgentTimelineRunProjection, AgentTimelineRunStatus,
    AgentTimelineSelectedDecision, AgentTimelineSnapshot, AgentTimelineStatus,
    AgentTimelineStreamEvent, AgentTimelineStructuredProjection,
    AgentTimelineStructuredProjectionItem, AgentTimelineStructuredProjectionKind,
    AgentTimelineStructuredProjectionSection, AgentTimelineTaskProjection,
    AgentTimelineTaskProjectionItem, AgentTimelineTaskSettlementKind,
    AgentTimelineTokenUsageProjection, AgentTimelineTokenUsageRequest,
    AgentTimelineTokenUsageTotals, AgentTimelineTurn, AgentTimelineTurnPart, AgentTimelineWait,
    AgentTimelineWaitKind, AgentTimelineWorkAttention, AgentTimelineWorkAttentionKind,
    AgentTimelineWorkAttentionStatus, AgentTimelineWorkOperation,
    AgentTimelineWorkOperationAttempt, AgentTimelineWorkOperationStatus, AgentTimelineWorkSegment,
    AgentTimelineWorkSegmentLifecycle, AgentTimelineWorkspaceProjection,
    AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2,
    AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1,
};
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
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .default_headers(default_headers)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        config.host_shell_capability = None;
        Ok(Self { config, http })
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

    pub async fn agent_timeline(&self, session_id: &str) -> KernelClientResult<Value> {
        let value = self
            .http
            .get(self.url(&format!("/api/agent/sessions/{session_id}/timeline")))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        api_data(value)
    }

    pub async fn agent_timeline_v2(
        &self,
        session_id: &str,
    ) -> KernelClientResult<AgentTimelineSnapshot> {
        let value = self
            .http
            .get(self.url(&format!("/api/agent/sessions/{session_id}/timeline")))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let value = api_data(value)?;
        agent_projection::reject_private_projection_fields(&value)
            .map_err(|error| KernelClientError::Api(error.to_string()))?;
        let timeline = serde_json::from_value::<AgentTimelineSnapshot>(value)?;
        timeline
            .validate()
            .map_err(|error| KernelClientError::Api(error.to_string()))?;
        Ok(timeline)
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
            .get(self.url(&format!("/api/agent/sessions/{session_id}/events")))
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
        return Err(KernelClientError::Api(format!("{code}: {message}")));
    }
    decode_api_data(value)
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
