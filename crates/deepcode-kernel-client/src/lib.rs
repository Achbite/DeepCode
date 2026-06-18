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
use std::time::{Duration, Instant};
use thiserror::Error;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

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
        decode_api_data(value)
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
    ) -> KernelClientResult<AgentRunResult> {
        let value = self
            .http
            .post(self.url(&format!(
                "/api/agent/sessions/{session_id}/runs/{run_id}/guidance"
            )))
            .json(&json!({
                "guidance": guidance.into(),
                "attachments": attachments,
            }))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_api_data(value)
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

#[derive(Debug, Clone)]
pub struct KernelBootstrapOptions {
    pub api: Option<String>,
    pub auto_start: bool,
}

impl KernelBootstrapOptions {
    pub fn new(api: Option<String>) -> Self {
        Self {
            api,
            auto_start: true,
        }
    }

    pub fn auto_start(mut self, auto_start: bool) -> Self {
        self.auto_start = auto_start;
        self
    }
}

pub struct KernelBootstrap {
    client: HttpKernelClient,
    _guard: KernelBootstrapGuard,
}

impl KernelBootstrap {
    pub async fn connect(options: KernelBootstrapOptions) -> KernelClientResult<Self> {
        let config = options
            .api
            .map(KernelClientConfig::new)
            .unwrap_or_else(KernelClientConfig::from_env);
        let client = HttpKernelClient::new(config);
        if probe_kernel_health(&client).await {
            return Ok(Self {
                client,
                _guard: KernelBootstrapGuard::external(),
            });
        }

        if !kernel_auto_start_enabled(options.auto_start) {
            return Ok(Self {
                client,
                _guard: KernelBootstrapGuard::external(),
            });
        }

        if !is_local_kernel_url(client.base_url()) {
            return Ok(Self {
                client,
                _guard: KernelBootstrapGuard::external(),
            });
        }

        let (host, port) = parse_kernel_host_port(client.base_url()).ok_or_else(|| {
            KernelClientError::Bootstrap(format!(
                "cannot resolve local host/port from {}",
                client.base_url()
            ))
        })?;
        let Some(_start_lock) = acquire_kernel_start_lock(&host, &port)? else {
            for _ in 0..80 {
                if probe_kernel_health(&client).await {
                    return Ok(Self {
                        client,
                        _guard: KernelBootstrapGuard::external(),
                    });
                }
                std::thread::sleep(Duration::from_millis(75));
            }
            return Err(KernelClientError::Bootstrap(format!(
                "kernel start is already in progress for {} but did not become healthy",
                client.base_url()
            )));
        };
        if probe_kernel_health(&client).await {
            return Ok(Self {
                client,
                _guard: KernelBootstrapGuard::external(),
            });
        }
        let kernel_bin = find_kernel_binary().ok_or_else(|| {
            KernelClientError::Bootstrap(
                "cannot find deepcode-kernel or deepcode-kernel-daemon; set DEEPCODE_KERNEL_BIN"
                    .to_string(),
            )
        })?;
        let mut child = spawn_kernel_binary(&kernel_bin, &host, &port)?;

        for _ in 0..80 {
            if probe_kernel_health(&client).await {
                return Ok(Self {
                    client,
                    _guard: KernelBootstrapGuard::owned(child),
                });
            }
            std::thread::sleep(Duration::from_millis(75));
        }

        let _ = child.kill();
        let _ = child.wait();
        Err(KernelClientError::Bootstrap(format!(
            "kernel did not become healthy at {}",
            client.base_url()
        )))
    }

    pub fn client(&self) -> &HttpKernelClient {
        &self.client
    }
}

pub struct KernelBootstrapGuard {
    child: Option<Child>,
}

impl KernelBootstrapGuard {
    fn external() -> Self {
        Self { child: None }
    }

    fn owned(child: Child) -> Self {
        Self { child: Some(child) }
    }
}

impl Drop for KernelBootstrapGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub service: String,
    pub ok: bool,
    pub raw: Value,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentSessionsRequest {
    pub workspace_id: Option<String>,
    pub workspace_hash: Option<String>,
    pub include_archived: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentSessionRequest {
    pub initial_mode: Option<String>,
    pub mode: Option<String>,
    pub profile_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_hash: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionListResult {
    pub sessions: Vec<Value>,
    pub current_session_id: Option<String>,
    pub workspace_scope_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionResult {
    pub session: Value,
    pub events: Vec<Value>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentRunRequest {
    pub op: Option<String>,
    pub content: Option<String>,
    pub prompt: Option<String>,
    pub attachments: Option<Vec<Value>>,
    pub workspace_path: Option<String>,
    pub no_workspace: Option<bool>,
    pub profile_id: Option<String>,
    pub workflow: Option<String>,
    pub requirement_confirmation_mode: Option<String>,
    pub review_continuation_mode: Option<String>,
    pub intervention_level: Option<String>,
    pub title: Option<String>,
    pub decision_kind: Option<String>,
    pub decision: Option<String>,
    pub guidance: Option<String>,
    pub run_id: Option<String>,
    pub target_id: Option<String>,
}

impl StartAgentRunRequest {
    pub fn ask(content: impl Into<String>) -> Self {
        Self {
            op: Some("ask".to_string()),
            content: Some(content.into()),
            ..Self::default()
        }
    }

    pub fn resolve_decision(kind: impl Into<String>, decision: impl Into<String>) -> Self {
        Self {
            op: Some("resolveDecision".to_string()),
            decision_kind: Some(kind.into()),
            decision: Some(decision.into()),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunStatus {
    pub run_id: String,
    pub session_id: String,
    pub status: String,
    pub started_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub message: Option<String>,
    pub final_text: Option<String>,
}

impl AgentRunStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "completed" | "failed" | "cancelled" | "waiting"
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResult {
    pub run: AgentRunStatus,
    pub session: Value,
    pub events: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct TerminalWorkspaceScope {
    pub workspace_id: String,
    pub workspace_hash: String,
    pub normalized_path: String,
}

pub fn terminal_workspace_scope(path: Option<&str>) -> Option<TerminalWorkspaceScope> {
    let normalized_path = normalize_terminal_workspace_path(path?)?;
    Some(TerminalWorkspaceScope {
        workspace_id: "terminal".to_string(),
        workspace_hash: simple_workspace_hash(&normalized_path),
        normalized_path,
    })
}

pub fn session_host_bridge_path() -> Option<PathBuf> {
    find_session_host_bridge()
}

pub fn session_host_bridge_hint() -> &'static str {
    "run `pnpm --filter @deepcode/session-core build`, set DEEPCODE_SESSION_BRIDGE, set DEEPCODE_NODE, or use a packaged distribution that includes session-core/dist/hostBridge.js, node_modules/@deepcode/protocol, and node/bin/node"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHostBridgeRequest {
    pub op: String,
    pub api_base: Option<String>,
    pub session_id: Option<String>,
    pub host_run_id: Option<String>,
    pub prompt: Option<String>,
    pub title: Option<String>,
    pub attachments: Vec<Value>,
    pub workspace_path: Option<String>,
    pub no_workspace: bool,
    pub profile_id: Option<String>,
    pub workflow: Option<String>,
    pub requirement_confirmation_mode: Option<String>,
    pub review_continuation_mode: Option<String>,
    pub intervention_level: Option<String>,
    pub decision_kind: Option<String>,
    pub decision: Option<String>,
    pub guidance: Option<String>,
    pub run_id: Option<String>,
    pub target_id: Option<String>,
}

impl SessionHostBridgeRequest {
    pub fn ask(prompt: impl Into<String>) -> Self {
        Self {
            op: "ask".to_string(),
            api_base: None,
            session_id: None,
            host_run_id: None,
            prompt: Some(prompt.into()),
            title: None,
            attachments: Vec::new(),
            workspace_path: None,
            no_workspace: false,
            profile_id: None,
            workflow: None,
            requirement_confirmation_mode: None,
            review_continuation_mode: None,
            intervention_level: None,
            decision_kind: None,
            decision: None,
            guidance: None,
            run_id: None,
            target_id: None,
        }
    }

    pub fn resolve_decision(kind: impl Into<String>, decision: impl Into<String>) -> Self {
        Self {
            op: "resolveDecision".to_string(),
            api_base: None,
            session_id: None,
            host_run_id: None,
            prompt: None,
            title: None,
            attachments: Vec::new(),
            workspace_path: None,
            no_workspace: false,
            profile_id: None,
            workflow: None,
            requirement_confirmation_mode: None,
            review_continuation_mode: None,
            intervention_level: None,
            decision_kind: Some(kind.into()),
            decision: Some(decision.into()),
            guidance: None,
            run_id: None,
            target_id: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHostBridgeResult {
    pub ok: bool,
    pub session_id: Option<String>,
    pub session: Option<Value>,
    pub events: Option<Vec<Value>>,
    pub timeline: Option<Value>,
    pub final_text: Option<String>,
    pub message: Option<String>,
    pub error: Option<String>,
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

fn decode_api_data<T: DeserializeOwned>(value: Value) -> KernelClientResult<T> {
    Ok(serde_json::from_value(api_data(value)?)?)
}

fn run_session_host_bridge(
    request: SessionHostBridgeRequest,
    cancel_requested: Option<Arc<AtomicBool>>,
) -> KernelClientResult<SessionHostBridgeResult> {
    let bridge = find_session_host_bridge().ok_or_else(|| {
        KernelClientError::Bridge(format!(
            "cannot find session host bridge; {}",
            session_host_bridge_hint()
        ))
    })?;
    let node = find_session_host_node(&bridge);
    let mut child = Command::new(&node)
        .arg(&bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            KernelClientError::Bridge(format!(
                "failed to start Node runtime `{}` for bridge `{}`: {error}; {}",
                node.display(),
                bridge.display(),
                session_host_bridge_hint()
            ))
        })?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| KernelClientError::Bridge("bridge stdin is unavailable".to_string()))?;
        let payload = serde_json::to_vec(&request)?;
        stdin.write_all(&payload).map_err(|error| {
            KernelClientError::Bridge(format!("failed to write bridge request: {error}"))
        })?;
    }
    let output = wait_for_bridge_output(child, cancel_requested)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let result: SessionHostBridgeResult = serde_json::from_str(stdout.trim()).map_err(|error| {
        KernelClientError::Bridge(format!(
            "bridge returned invalid JSON: {error}; stdout={}; stderr={}",
            stdout.trim(),
            stderr.trim()
        ))
    })?;
    if !output.status.success() || !result.ok {
        return Err(KernelClientError::Bridge(
            result
                .message
                .or(result.error)
                .unwrap_or_else(|| stderr.trim().to_string())
                .if_empty("bridge failed"),
        ));
    }
    Ok(result)
}

fn wait_for_bridge_output(
    mut child: Child,
    cancel_requested: Option<Arc<AtomicBool>>,
) -> KernelClientResult<Output> {
    let started_at = Instant::now();
    let timeout = session_host_bridge_timeout();
    loop {
        if cancel_requested
            .as_ref()
            .is_some_and(|cancelled| cancelled.load(Ordering::SeqCst))
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(KernelClientError::Bridge(
                "bridge cancelled by TUI stop request".to_string(),
            ));
        }
        if let Some(limit) = timeout {
            if started_at.elapsed() >= limit {
                let _ = child.kill();
                let _ = child.wait();
                return Err(KernelClientError::Bridge(format!(
                    "bridge timed out after {} ms; set DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS=0 to disable the hard timeout",
                    limit.as_millis()
                )));
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                return child.wait_with_output().map_err(|error| {
                    KernelClientError::Bridge(format!("failed to read bridge output: {error}"))
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(KernelClientError::Bridge(format!(
                    "failed to wait for bridge output: {error}"
                )));
            }
        }
    }
}

fn session_host_bridge_timeout() -> Option<Duration> {
    const DEFAULT_TIMEOUT_MS: u64 = 600_000;
    let millis = std::env::var("DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    if millis == 0 {
        None
    } else {
        Some(Duration::from_millis(millis))
    }
}

fn find_session_host_bridge() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DEEPCODE_SESSION_BRIDGE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        if let Some(path) = find_bridge_from_root(&root) {
            return Some(path);
        }
    }
    None
}

fn find_bridge_from_root(root: &Path) -> Option<PathBuf> {
    for ancestor in root.ancestors() {
        let packaged_dist = ancestor.join("session-core/dist/hostBridge.js");
        if packaged_dist.is_file() {
            return Some(packaged_dist);
        }
        let packaged = ancestor.join("session-core/hostBridge.js");
        if packaged.is_file() {
            return Some(packaged);
        }
        let candidate = ancestor.join("userspace/session-core/dist/hostBridge.js");
        if candidate.is_file() {
            return Some(candidate);
        }
        let nested = ancestor.join("DeepCode/userspace/session-core/dist/hostBridge.js");
        if nested.is_file() {
            return Some(nested);
        }
    }
    None
}

fn find_session_host_node(bridge: &Path) -> PathBuf {
    if let Ok(path) = std::env::var("DEEPCODE_NODE") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }

    let mut roots = Vec::new();
    if let Some(parent) = bridge.parent() {
        roots.push(parent.to_path_buf());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }

    for root in roots {
        if let Some(node) = find_node_from_root(&root) {
            return node;
        }
    }

    PathBuf::from(node_executable_name())
}

fn find_node_from_root(root: &Path) -> Option<PathBuf> {
    for ancestor in root.ancestors() {
        let packaged = ancestor.join("node/bin").join(node_executable_name());
        if packaged.is_file() {
            return Some(packaged);
        }
        let bin = ancestor.join("bin").join(node_executable_name());
        if bin.is_file() {
            return Some(bin);
        }
    }
    None
}

fn node_executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn normalize_terminal_workspace_path(path: &str) -> Option<String> {
    let normalized = path.trim().replace('\\', "/");
    let normalized = normalized.trim_end_matches('/').to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn simple_workspace_hash(value: &str) -> String {
    let mut hash = 2166136261u32;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16777619);
    }
    format!("ws-{hash:x}")
}

async fn probe_kernel_health(client: &HttpKernelClient) -> bool {
    if !probe_kernel_tcp(client.base_url()) {
        return false;
    }
    matches!(client.health().await, Ok(status) if status.ok)
}

fn probe_kernel_tcp(base_url: &str) -> bool {
    let Some((host, port)) = parse_kernel_host_port(base_url) else {
        return false;
    };
    let Ok(port) = port.parse::<u16>() else {
        return false;
    };
    let Ok(addrs) = (host.as_str(), port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|addr| connect_socket(addr, Duration::from_millis(180)).is_ok())
}

fn connect_socket(addr: SocketAddr, timeout: Duration) -> std::io::Result<TcpStream> {
    TcpStream::connect_timeout(&addr, timeout)
}

fn kernel_auto_start_enabled(default_enabled: bool) -> bool {
    match std::env::var("DEEPCODE_KERNEL_AUTO_START") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "no" | "off")
        }
        Err(_) => default_enabled,
    }
}

fn parse_kernel_host_port(base_url: &str) -> Option<(String, String)> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed.split_once("://")?;
    let authority = rest.split('/').next()?.split('@').next_back()?;
    if authority.is_empty() {
        return None;
    }
    if let Some(after_bracket) = authority.strip_prefix('[') {
        let (host, tail) = after_bracket.split_once(']')?;
        let port = tail
            .strip_prefix(':')
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| default_port_for_scheme(scheme).to_string());
        return Some((host.to_string(), port));
    }
    let (host, port) = authority
        .rsplit_once(':')
        .map(|(host, port)| (host.to_string(), port.to_string()))
        .unwrap_or_else(|| {
            (
                authority.to_string(),
                default_port_for_scheme(scheme).to_string(),
            )
        });
    Some((host, port))
}

fn default_port_for_scheme(scheme: &str) -> &'static str {
    if scheme.eq_ignore_ascii_case("https") {
        "443"
    } else {
        "80"
    }
}

fn is_local_kernel_url(base_url: &str) -> bool {
    let Some((host, _)) = parse_kernel_host_port(base_url) else {
        return false;
    };
    matches!(
        host.trim_matches(|ch| ch == '[' || ch == ']')
            .to_ascii_lowercase()
            .as_str(),
        "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"
    )
}

fn find_kernel_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("DEEPCODE_KERNEL_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
            if cfg!(target_os = "macos") {
                if let Some(contents) = parent.parent() {
                    roots.push(contents.join("MacOS"));
                    roots.push(contents.join("Resources"));
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }

    for root in &roots {
        for candidate in kernel_binary_candidates(root) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    for root in roots {
        for ancestor in root.ancestors() {
            for profile in ["debug", "release"] {
                for name in kernel_binary_names() {
                    let direct = ancestor.join("target").join(profile).join(name);
                    if direct.is_file() {
                        return Some(direct);
                    }
                    let nested = ancestor
                        .join("DeepCode")
                        .join("target")
                        .join(profile)
                        .join(name);
                    if nested.is_file() {
                        return Some(nested);
                    }
                }
            }
        }
    }
    None
}

fn kernel_binary_candidates(root: &Path) -> Vec<PathBuf> {
    kernel_binary_names()
        .into_iter()
        .map(|name| root.join(name))
        .collect()
}

fn kernel_binary_names() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["deepcode-kernel.exe", "deepcode-kernel-daemon.exe"]
    } else {
        vec!["deepcode-kernel", "deepcode-kernel-daemon"]
    }
}

fn spawn_kernel_binary(kernel_bin: &Path, host: &str, port: &str) -> KernelClientResult<Child> {
    let kernel_dir = kernel_bin
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let log_file = open_kernel_log_file(&kernel_dir)?;
    let stderr = log_file.try_clone().map_err(|error| {
        KernelClientError::Bootstrap(format!("failed to clone kernel log handle: {error}"))
    })?;
    let mut command = Command::new(kernel_bin);
    command
        .current_dir(&kernel_dir)
        .env("DEEPCODE_HOST", host)
        .env("DEEPCODE_PORT", port)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    command.spawn().map_err(|error| {
        KernelClientError::Bootstrap(format!("failed to start {}: {error}", kernel_bin.display()))
    })
}

struct KernelStartLock {
    path: PathBuf,
}

impl Drop for KernelStartLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn acquire_kernel_start_lock(host: &str, port: &str) -> KernelClientResult<Option<KernelStartLock>> {
    let path = std::env::temp_dir().join(format!(
        "deepcode-kernel-start-{}-{}.lock",
        sanitize_lock_component(host),
        sanitize_lock_component(port)
    ));
    match create_kernel_start_lock_file(&path) {
        Ok(()) => Ok(Some(KernelStartLock { path })),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            if kernel_start_lock_is_stale(&path) {
                let _ = std::fs::remove_file(&path);
                return match create_kernel_start_lock_file(&path) {
                    Ok(()) => Ok(Some(KernelStartLock { path })),
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(None),
                    Err(error) => Err(KernelClientError::Bootstrap(format!(
                        "failed to create kernel start lock {}: {error}",
                        path.display()
                    ))),
                };
            }
            Ok(None)
        }
        Err(error) => Err(KernelClientError::Bootstrap(format!(
            "failed to create kernel start lock {}: {error}",
            path.display()
        ))),
    }
}

fn create_kernel_start_lock_file(path: &Path) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    writeln!(file, "pid={}", std::process::id())?;
    Ok(())
}

fn kernel_start_lock_is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .map(|age| age > Duration::from_secs(30))
        .unwrap_or(false)
}

fn sanitize_lock_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn open_kernel_log_file(kernel_dir: &Path) -> KernelClientResult<File> {
    let log_dir = std::env::var_os("DEEPCODE_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| kernel_dir.join("logs"));
    match open_log_in_dir(&log_dir) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            open_log_in_dir(&std::env::temp_dir().join("deepcode")).map_err(|fallback_error| {
                KernelClientError::Bootstrap(format!(
                    "failed to open kernel log at {}: {error}; fallback failed: {fallback_error}",
                    log_dir.display()
                ))
            })
        }
        Err(error) => Err(KernelClientError::Bootstrap(format!(
            "failed to open kernel log at {}: {error}",
            log_dir.display()
        ))),
    }
}

fn open_log_in_dir(log_dir: &Path) -> std::io::Result<File> {
    std::fs::create_dir_all(log_dir)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("deepcode-kernel.log"))
}

trait StringFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl StringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
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
}
