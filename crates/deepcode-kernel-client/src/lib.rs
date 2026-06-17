use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
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
        run_session_host_bridge(request)
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHostBridgeRequest {
    pub op: String,
    pub api_base: Option<String>,
    pub session_id: Option<String>,
    pub prompt: Option<String>,
    pub title: Option<String>,
    pub attachments: Vec<Value>,
    pub workspace_path: Option<String>,
    pub no_workspace: bool,
    pub profile_id: Option<String>,
    pub workflow: Option<String>,
    pub requirement_confirmation_mode: Option<String>,
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
            prompt: Some(prompt.into()),
            title: None,
            attachments: Vec::new(),
            workspace_path: None,
            no_workspace: false,
            profile_id: None,
            workflow: None,
            requirement_confirmation_mode: None,
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
            prompt: None,
            title: None,
            attachments: Vec::new(),
            workspace_path: None,
            no_workspace: false,
            profile_id: None,
            workflow: None,
            requirement_confirmation_mode: None,
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
) -> KernelClientResult<SessionHostBridgeResult> {
    let bridge = find_session_host_bridge().ok_or_else(|| {
        KernelClientError::Bridge(
            "cannot find userspace/session-core/dist/hostBridge.js; run `pnpm --filter @deepcode/session-core build` or set DEEPCODE_SESSION_BRIDGE".to_string(),
        )
    })?;
    let node = std::env::var("DEEPCODE_NODE").unwrap_or_else(|_| "node".to_string());
    let mut child = Command::new(node)
        .arg(&bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| KernelClientError::Bridge(format!("failed to start bridge: {error}")))?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| KernelClientError::Bridge("bridge stdin is unavailable".to_string()))?;
        let payload = serde_json::to_vec(&request)?;
        stdin.write_all(&payload).map_err(|error| {
            KernelClientError::Bridge(format!("failed to write bridge request: {error}"))
        })?;
    }
    let output = child.wait_with_output().map_err(|error| {
        KernelClientError::Bridge(format!("failed to read bridge output: {error}"))
    })?;
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

fn find_session_host_bridge() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DEEPCODE_SESSION_BRIDGE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
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
