use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum KernelClientError {
    #[error("daemon request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("daemon returned error: {0}")]
    Api(String),
    #[error("daemon response is missing field: {0}")]
    MissingField(&'static str),
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
            http: reqwest::Client::new(),
        }
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

    pub async fn audit_verify(&self) -> KernelClientResult<AuditVerifyResult> {
        Ok(AuditVerifyResult {
            status: "not-wired".to_string(),
            degraded: false,
            message: "audit verify API is reserved for stage 10 daemon wiring".to_string(),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.config.base_url, path)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub service: String,
    pub ok: bool,
    pub raw: Value,
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

#[derive(Debug, Clone)]
pub struct AuditVerifyResult {
    pub status: String,
    pub degraded: bool,
    pub message: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_base_url_slash() {
        let config = KernelClientConfig::new("http://127.0.0.1:31245/");
        assert_eq!(config.base_url, "http://127.0.0.1:31245");
    }
}
