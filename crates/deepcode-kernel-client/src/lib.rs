use deepcode_kernel_abi::{
    KernelCommand, KernelCommandEnvelope, KernelEvent, KernelReply, RequestId,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[cfg(unix)]
use std::os::unix::process::CommandExt as UnixCommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt as WindowsCommandExt;

mod bootstrap;
mod session_bridge;

pub use bootstrap::{DaemonStatus, KernelBootstrap, KernelBootstrapGuard, KernelBootstrapOptions};
use session_bridge::run_session_host_bridge;
pub use session_bridge::{
    session_host_bridge_hint, session_host_bridge_path, terminal_host_language,
    ResolveSessionGoalInteractionRequest, SessionGoalCommandReceipt,
    StartSessionGoalRequest,
    terminal_workspace_scope, AgentRunResult, AgentRunStatus, AgentSessionListResult,
    AgentSessionResult, CreateAgentSessionRequest, ListAgentSessionsRequest,
    SessionHostBridgeRequest, SessionHostBridgeResult, StartAgentRunRequest,
    TerminalWorkspaceScope,
};

#[derive(Debug, Error)]
pub enum KernelClientError {
    #[error("daemon request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("daemon returned error: {0}")]
    Api(String),
    #[error("daemon response decode failed: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("daemon response is missing field: {0}")]
    MissingField(&'static str),
    #[error("session host bridge failed: {0}")]
    Bridge(String),
    #[error("kernel bootstrap failed: {0}")]
    Bootstrap(String),
}

pub type KernelClientResult<T> = Result<T, KernelClientError>;

#[derive(Clone, Debug)]
pub struct KernelClientConfig {
    pub base_url: String,
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
        }
    }
}

#[derive(Clone)]
pub struct HttpKernelClient {
    config: KernelClientConfig,
    http: reqwest::Client,
}

impl HttpKernelClient {
    pub fn new(config: KernelClientConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    pub async fn kernel_command(&self, command: KernelCommand) -> KernelClientResult<KernelReply> {
        self.kernel_command_envelope(KernelCommandEnvelope::new(command))
            .await
    }

    pub async fn kernel_command_envelope(
        &self,
        envelope: KernelCommandEnvelope,
    ) -> KernelClientResult<KernelReply> {
        let reply = self
            .http
            .post(self.url("/api/kernel/commands"))
            .json(&envelope)
            .send()
            .await?
            .error_for_status()?
            .json::<KernelReply>()
            .await?;
        if !reply.ok {
            let message = reply
                .error
                .as_ref()
                .map(|error| error.message.as_str())
                .unwrap_or("Kernel command failed");
            return Err(KernelClientError::Api(message.to_owned()));
        }
        Ok(reply)
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

    pub async fn append_agent_events(
        &self,
        session_id: &str,
        events: Vec<Value>,
    ) -> KernelClientResult<AgentSessionResult> {
        let value = self
            .http
            .post(self.url(&format!("/api/agent/sessions/{session_id}/events")))
            .json(&json!({ "events": events }))
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

    pub async fn start_session_goal(
        &self,
        session_id: &str,
        request: StartSessionGoalRequest,
    ) -> KernelClientResult<SessionGoalCommandReceipt> {
        let value = self
            .http
            .post(self.url(&format!("/api/agent/sessions/{session_id}/goals")))
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data_with_code(value)
    }

    pub async fn current_session_goal(
        &self,
        session_id: &str,
    ) -> KernelClientResult<SessionGoalCommandReceipt> {
        let value = self
            .http
            .get(self.url(&format!(
                "/api/agent/sessions/{session_id}/goals/current"
            )))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data_with_code(value)
    }

    pub async fn get_session_goal(
        &self,
        session_id: &str,
        goal_id: &str,
    ) -> KernelClientResult<SessionGoalCommandReceipt> {
        let value = self
            .http
            .get(self.url(&format!(
                "/api/agent/sessions/{session_id}/goals/{goal_id}"
            )))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data_with_code(value)
    }

    pub async fn resolve_session_goal_interaction(
        &self,
        session_id: &str,
        goal_id: &str,
        interaction_id: &str,
        request: ResolveSessionGoalInteractionRequest,
    ) -> KernelClientResult<SessionGoalCommandReceipt> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/agent/sessions/{session_id}/goals/{goal_id}/interactions/{interaction_id}/resolve"
            )))
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data_with_code(value)
    }

    pub async fn advance_session_goal(
        &self,
        session_id: &str,
        goal_id: &str,
        request: Value,
    ) -> KernelClientResult<Value> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/agent/sessions/{session_id}/goals/{goal_id}/advance"
            )))
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        api_data(value)
    }

    pub async fn resume_session_goal(
        &self,
        session_id: &str,
        goal_id: &str,
        request: Value,
    ) -> KernelClientResult<Value> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/agent/sessions/{session_id}/goals/{goal_id}/resume"
            )))
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        api_data(value)
    }

    pub async fn cancel_session_goal(
        &self,
        session_id: &str,
        goal_id: &str,
        request: Value,
    ) -> KernelClientResult<Value> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/agent/sessions/{session_id}/goals/{goal_id}/cancel"
            )))
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        api_data(value)
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
    ) -> KernelClientResult<AgentRunResult> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/agent/sessions/{session_id}/runs/{run_id}/cancel"
            )))
            .json(&json!({}))
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
        guidance: impl Into<String>,
        attachments: Vec<Value>,
        host_language: Option<String>,
    ) -> KernelClientResult<AgentRunResult> {
        let observed_session = self.get_agent_session(session_id).await?;
        let (base_head, turn_authority_ref) = observed_session.guidance_observation(run_id)?;
        let value = self
            .http
            .post(self.url(&format!(
                "/api/agent/sessions/{session_id}/runs/{run_id}/guidance"
            )))
            .json(&json!({
                "guidance": guidance.into(),
                "attachments": attachments,
                "hostLanguage": host_language,
                "baseHead": base_head,
                "turnAuthorityRef": turn_authority_ref,
            }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data_with_code(value)
    }

    pub async fn cancel_agent_run(
        &self,
        session_id: &str,
    ) -> KernelClientResult<AgentSessionResult> {
        let value = self
            .http
            .post(self.url(&format!("/api/agent/sessions/{session_id}/cancel")))
            .json(&json!({}))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
    }

    pub async fn resolve_permission(
        &self,
        permission_id: &str,
        decision: PermissionDecision,
    ) -> KernelClientResult<Value> {
        let response = self
            .http
            .post(self.url(&format!("/api/agent/permissions/{permission_id}/resolve")))
            .json(&json!({
                "decision": decision.as_str(),
                "approved": matches!(decision, PermissionDecision::Allow),
            }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        api_data(response)
    }

    pub fn run_session_host_bridge(
        &self,
        mut request: SessionHostBridgeRequest,
    ) -> KernelClientResult<SessionHostBridgeResult> {
        request.api_base = Some(self.config.base_url.clone());
        run_session_host_bridge(request, None)
    }

    pub fn run_session_host_bridge_with_cancel(
        &self,
        mut request: SessionHostBridgeRequest,
        cancel_requested: Arc<AtomicBool>,
    ) -> KernelClientResult<SessionHostBridgeResult> {
        request.api_base = Some(self.config.base_url.clone());
        run_session_host_bridge(request, Some(cancel_requested))
    }

    pub async fn audit_verify(&self) -> KernelClientResult<AuditVerifyResult> {
        let request_id = RequestId(format!(
            "client-audit-verify-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let command = KernelCommand::AuditVerify {
            request_id,
            scope: json!({ "kind": "all" }),
        };
        decode_audit_verify(self.kernel_command(command).await?)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.config.base_url, path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditVerifyResult {
    pub status: String,
    pub degraded: bool,
    pub message: String,
}

#[derive(Debug, Clone, Copy)]
pub enum PermissionDecision {
    Allow,
    Deny,
}

impl PermissionDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionDecision::Allow => "allow",
            PermissionDecision::Deny => "deny",
        }
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

fn decode_audit_verify(reply: KernelReply) -> KernelClientResult<AuditVerifyResult> {
    for event in reply.events {
        let KernelEvent::AuditVerifyCompleted { ok, report, .. } = event else {
            continue;
        };
        let message = report
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(if ok {
                "audit chain verified"
            } else {
                "audit chain verification failed"
            })
            .to_string();
        return Ok(AuditVerifyResult {
            status: if ok { "verified" } else { "failed" }.to_string(),
            degraded: report
                .get("degraded")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            message,
        });
    }
    Err(KernelClientError::MissingField(
        "events[].audit.verify_completed",
    ))
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
    fn decodes_real_audit_verify_event() {
        let result = decode_audit_verify(KernelReply {
            ok: true,
            events: vec![KernelEvent::AuditVerifyCompleted {
                request_id: Some(RequestId("req-audit".to_string())),
                ok: true,
                report: json!({
                    "degraded": true,
                    "message": "audit chain verified"
                }),
                sequence: None,
            }],
            snapshot: None,
            error: None,
        })
        .expect("decode audit verification result");

        assert_eq!(result.status, "verified");
        assert!(result.degraded);
        assert_eq!(result.message, "audit chain verified");
    }
}
