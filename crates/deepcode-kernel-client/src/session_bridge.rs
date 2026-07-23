use super::*;

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
    pub sub_agent_mode: Option<String>,
    pub sub_agent_max_parallel: Option<u64>,
    pub title: Option<String>,
    pub decision_kind: Option<String>,
    pub decision: Option<String>,
    pub guidance: Option<String>,
    pub run_id: Option<String>,
    pub target_id: Option<String>,
    pub host_language: Option<String>,
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
    pub profile_id: Option<String>,
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

pub fn terminal_host_language() -> String {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });
    match locale {
        Some(value) if value.to_ascii_lowercase().starts_with("zh") => "zh-CN".to_string(),
        Some(_) => "en-US".to_string(),
        None => "zh-CN".to_string(),
    }
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
    pub sub_agent_mode: Option<String>,
    pub sub_agent_max_parallel: Option<u64>,
    pub decision_kind: Option<String>,
    pub decision: Option<String>,
    pub guidance: Option<String>,
    pub run_id: Option<String>,
    pub target_id: Option<String>,
    pub host_language: Option<String>,
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
            sub_agent_mode: None,
            sub_agent_max_parallel: None,
            decision_kind: None,
            decision: None,
            guidance: None,
            run_id: None,
            target_id: None,
            host_language: None,
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
            sub_agent_mode: None,
            sub_agent_max_parallel: None,
            decision_kind: Some(kind.into()),
            decision: Some(decision.into()),
            guidance: None,
            run_id: None,
            target_id: None,
            host_language: None,
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

pub(super) fn run_session_host_bridge(
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
        let message = result
            .message
            .or(result.error)
            .unwrap_or_else(|| stderr.trim().to_string());
        return Err(KernelClientError::Bridge(if message.trim().is_empty() {
            "bridge failed".to_string()
        } else {
            message
        }));
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
