use deepcode_kernel_abi::{
    is_valid_host_shell_token, HOST_SHELL_TOKEN_ENV, HOST_SHELL_TOKEN_HEADER,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::fmt;
use std::time::Duration;
use thiserror::Error;

mod bootstrap;
mod conversation;

use conversation::invalid_filesystem_references;

pub use bootstrap::{DaemonStatus, KernelBootstrap, KernelBootstrapGuard, KernelBootstrapOptions};
pub use conversation::{
    approval_response_command, cancel_command, directory_index_attach_command,
    directory_index_detach_command, focus_command, interaction_response_command,
    is_terminal_run_status, message_command, message_command_with_profile,
    message_command_with_profile_and_plugins, plan_cancel_command, plan_confirm_command,
    plan_revision_command, ActivityProjection, ApprovalProjection, ArtifactProjection,
    AssistantDraftBlockProjection, AssistantDraftProjection,
    AttachConversationDirectoryIndexRequest, CommandReply, ContextCompositionItem,
    ContextCompositionMessage, ContextCompositionMessageBlock,
    ContextCompositionPartitionProjection, ContextCompositionProjection, ContextCompositionTool,
    ContextUsageProjection, ConversationError, ConversationResourceReadRequest,
    ConversationResourceReadResult, CreateConversationSessionRequest, EffectPreview,
    ExecutionPlanStep, FilesystemReference, FilesystemReferencePathInput, InteractionOption,
    InteractionProjection, NarrativeProjection, PendingPlanProjection, PlanOperation,
    PlanProjection, PlanRef, PluginCatalogItem, PluginCatalogProjection, PluginSelectionInput,
    ProjectionMessage, ResolveConversationFilesystemReferencesRequest, RunProjection,
    SessionDisplayProjection, SessionProjection, SessionTimelineItem, TodoItem, TodoListProjection,
    TokenUsageProjection, TokenUsageRoundProjection, WorkspaceBindingDisplay,
    CONVERSATION_COMMAND_VERSION, SESSION_PROJECTION_VERSION,
};

#[derive(Debug, Error)]
pub enum KernelClientError {
    #[error("daemon request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("daemon returned error: {0}")]
    Api(String),
    #[error("daemon response decode failed: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("Host shell local connection token is required")]
    HostConnectionTokenMissing,
    #[error("Host shell local connection token has an invalid format")]
    HostConnectionTokenInvalid,
    #[error("daemon at {base_url} rejected the Host shell local connection token")]
    HostConnectionRejected { base_url: String },
    #[error("daemon at {base_url} is unavailable: {reason}")]
    DaemonUnavailable { base_url: String, reason: String },
    #[error("kernel bootstrap failed: {0}")]
    Bootstrap(String),
}

pub type KernelClientResult<T> = Result<T, KernelClientError>;

#[derive(Clone)]
struct HostShellToken(String);

impl fmt::Debug for HostShellToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostShellToken([REDACTED])")
    }
}

impl HostShellToken {
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
    host_shell_token: Option<HostShellToken>,
}

impl fmt::Debug for KernelClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KernelClientConfig")
            .field("base_url", &self.base_url)
            .field(
                "host_shell_token",
                &self.host_shell_token.as_ref().map(|_| "[REDACTED]"),
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
            host_shell_token: std::env::var(HOST_SHELL_TOKEN_ENV)
                .ok()
                .map(HostShellToken::new),
        }
    }

    pub fn with_host_shell_token(mut self, token: impl Into<String>) -> Self {
        self.host_shell_token = Some(HostShellToken::new(token));
        self
    }

    pub(crate) fn has_host_shell_token(&self) -> bool {
        self.host_shell_token.is_some()
    }

    pub(crate) fn validate_host_shell_token(&self) -> KernelClientResult<()> {
        if self
            .host_shell_token
            .as_ref()
            .is_some_and(|token| !is_valid_host_shell_token(token.expose_to_transport()))
        {
            return Err(KernelClientError::HostConnectionTokenInvalid);
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
        config.validate_host_shell_token()?;
        let token = config
            .host_shell_token
            .as_ref()
            .ok_or(KernelClientError::HostConnectionTokenMissing)?;
        let mut token_header = HeaderValue::from_str(token.expose_to_transport())
            .map_err(|_| KernelClientError::HostConnectionTokenInvalid)?;
        token_header.set_sensitive(true);
        let mut default_headers = HeaderMap::new();
        default_headers.insert(
            HeaderName::from_static(HOST_SHELL_TOKEN_HEADER),
            token_header,
        );
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .default_headers(default_headers)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        config.host_shell_token = None;
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

    pub async fn create_conversation_session(
        &self,
        request: &CreateConversationSessionRequest,
    ) -> KernelClientResult<SessionProjection> {
        let value = self
            .http
            .post(self.url("/api/conversation/sessions"))
            .json(request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_projection(value)
    }

    pub async fn conversation_plugin_catalog(&self) -> KernelClientResult<PluginCatalogProjection> {
        let value = self
            .http
            .get(self.url("/api/conversation/plugins"))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let catalog: PluginCatalogProjection = decode_api_data(value)?;
        catalog
            .validate()
            .map_err(|message| KernelClientError::Api(message))?;
        Ok(catalog)
    }

    pub async fn submit_conversation_command(
        &self,
        session_id: &str,
        command: &Value,
    ) -> KernelClientResult<CommandReply> {
        let value = self
            .http
            .post(self.url(&format!("/api/conversation/sessions/{session_id}/commands")))
            .json(command)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn conversation_projection(
        &self,
        session_id: &str,
    ) -> KernelClientResult<SessionProjection> {
        let value = self
            .http
            .get(self.url(&format!(
                "/api/conversation/sessions/{session_id}/projection"
            )))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_projection(value)
    }

    pub async fn conversation_resource_read(
        &self,
        session_id: &str,
        workspace_id: &str,
        logical_path: &str,
    ) -> KernelClientResult<ConversationResourceReadResult> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/conversation/sessions/{session_id}/resources/read"
            )))
            .json(&ConversationResourceReadRequest {
                workspace_id,
                logical_path,
            })
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let result: ConversationResourceReadResult = decode_api_data(value)?;
        if result.workspace_id != workspace_id || result.logical_path != logical_path {
            return Err(KernelClientError::Api(
                "conversation resource identity mismatch".to_string(),
            ));
        }
        Ok(result)
    }

    pub async fn attach_conversation_directory_index(
        &self,
        session_id: &str,
        path: &str,
    ) -> KernelClientResult<SessionProjection> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/conversation/sessions/{session_id}/directory-indexes"
            )))
            .json(&AttachConversationDirectoryIndexRequest { path })
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_projection(value)
    }

    pub async fn resolve_conversation_filesystem_references(
        &self,
        session_id: &str,
        references: Vec<FilesystemReferencePathInput>,
    ) -> KernelClientResult<Vec<FilesystemReference>> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/conversation/sessions/{session_id}/filesystem-references/resolve"
            )))
            .json(&ResolveConversationFilesystemReferencesRequest { references })
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let references: Vec<FilesystemReference> = decode_api_data(value)?;
        if invalid_filesystem_references(&references) {
            return Err(KernelClientError::Api(
                "conversation filesystem references are invalid".to_string(),
            ));
        }
        Ok(references)
    }

    pub async fn detach_conversation_directory_index(
        &self,
        session_id: &str,
        workspace_id: &str,
    ) -> KernelClientResult<SessionProjection> {
        let value = self
            .http
            .delete(self.url(&format!(
                "/api/conversation/sessions/{session_id}/directory-indexes/{workspace_id}"
            )))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_projection(value)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.config.base_url, path)
    }
}

fn decode_projection(value: Value) -> KernelClientResult<SessionProjection> {
    let projection: SessionProjection = decode_api_data(value)?;
    projection.validate().map_err(KernelClientError::Api)?;
    Ok(projection)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_base_url_slash() {
        let config = KernelClientConfig::new("http://127.0.0.1:31245/");
        assert_eq!(config.base_url, "http://127.0.0.1:31245");
    }

    #[test]
    fn host_shell_token_debug_output_is_redacted() {
        let token = format!("dchost_{}", "a".repeat(64));
        let config =
            KernelClientConfig::new("http://127.0.0.1:31245").with_host_shell_token(token.clone());
        let debug = format!("{config:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains(&token));
    }

    #[test]
    fn host_shell_token_is_required_and_validated() {
        let missing = KernelClientConfig {
            base_url: "http://127.0.0.1:31245".to_owned(),
            host_shell_token: None,
        };
        assert!(matches!(
            HttpKernelClient::new(missing),
            Err(KernelClientError::HostConnectionTokenMissing)
        ));

        let invalid = KernelClientConfig {
            base_url: "http://127.0.0.1:31245".to_owned(),
            host_shell_token: Some(HostShellToken::new("short")),
        };
        assert!(matches!(
            HttpKernelClient::new(invalid),
            Err(KernelClientError::HostConnectionTokenInvalid)
        ));
    }
}
