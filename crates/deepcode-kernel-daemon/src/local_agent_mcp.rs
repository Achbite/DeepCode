use deepcode_kernel_runtime::executors::KernelCancellationToken;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_MCP_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_MCP_TOOLS: usize = 256;
const MCP_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone)]
pub(crate) struct McpPluginDescriptor {
    pub(crate) id: String,
    pub(crate) uri: String,
    pub(crate) name: String,
    pub(crate) plugin_artifact_ref: String,
    pub(crate) plugin_instance_ref: String,
    pub(crate) capability_ref: String,
}

#[derive(Debug, Clone)]
pub(crate) struct McpRuntimeError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl McpRuntimeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct McpTool {
    pub(crate) public_name: String,
    pub(crate) remote_name: String,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
    pub(crate) target: String,
    pub(crate) plugin_uri: String,
    pub(crate) plugin_instance_ref: String,
    client: McpClient,
}

impl McpTool {
    pub(crate) fn call(
        &self,
        input: Value,
        cancellation: &KernelCancellationToken,
    ) -> Result<Value, McpRuntimeError> {
        self.client
            .call_tool(&self.remote_name, input, cancellation)
    }
}

#[derive(Clone)]
pub(crate) struct McpRuntime {
    tools: Arc<BTreeMap<String, McpTool>>,
    clients: Arc<Vec<McpClient>>,
    configuration_identity: Arc<Value>,
}

impl Default for McpRuntime {
    fn default() -> Self {
        Self {
            tools: Arc::new(BTreeMap::new()),
            clients: Arc::new(Vec::new()),
            configuration_identity: Arc::new(Value::Array(Vec::new())),
        }
    }
}

impl McpRuntime {
    pub(crate) fn from_selected_settings(
        settings: &Value,
        selected_server_ids: &BTreeSet<String>,
    ) -> Result<Self, McpRuntimeError> {
        if selected_server_ids.is_empty() {
            return Ok(Self::default());
        }
        let servers = configured_servers(settings)?;
        let available = servers
            .iter()
            .map(|server| server.id.as_str())
            .collect::<BTreeSet<_>>();
        if let Some(missing) = selected_server_ids
            .iter()
            .find(|server_id| !available.contains(server_id.as_str()))
        {
            return Err(McpRuntimeError::new(
                "plugin_selection_unavailable",
                format!("显式选择的 MCP 插件不可用：{missing}"),
            ));
        }
        Self::from_servers(
            servers
                .into_iter()
                .filter(|server| selected_server_ids.contains(&server.id))
                .collect(),
        )
    }

    fn from_servers(servers: Vec<McpServerSetting>) -> Result<Self, McpRuntimeError> {
        let mut servers_by_id = BTreeMap::new();
        for server in servers {
            validate_server(&server)?;
            let server_id = server.id.clone();
            if servers_by_id.insert(server_id.clone(), server).is_some() {
                return Err(McpRuntimeError::new(
                    "mcp_server_duplicate",
                    format!("MCP Server id 重复：{server_id}"),
                ));
            }
        }
        let configuration_identity = Value::Array(
            servers_by_id
                .values()
                .map(|server| {
                    json!({
                        "id": server.id,
                        "name": server.name,
                        "transport": server.transport,
                        "command": server.command,
                        "args": server.args,
                    })
                })
                .collect(),
        );
        let mut tools = BTreeMap::new();
        let mut clients = Vec::new();
        for (_, server) in servers_by_id {
            let client = McpClient::start(&server)?;
            let definitions = client.list_tools()?;
            for definition in definitions {
                let public_name = public_tool_name(&server.id, &definition.name)?;
                let tool = McpTool {
                    public_name: public_name.clone(),
                    remote_name: definition.name.clone(),
                    description: definition
                        .description
                        .unwrap_or_else(|| format!("MCP tool {}", definition.name)),
                    input_schema: definition.input_schema,
                    target: format!("{}: {}", server.name, definition.name),
                    plugin_uri: mcp_plugin_uri(&server.id),
                    plugin_instance_ref: format!("plugin-instance:mcp:{}", server.id),
                    client: client.clone(),
                };
                if tools.insert(public_name.clone(), tool).is_some() {
                    return Err(McpRuntimeError::new(
                        "mcp_tool_duplicate",
                        format!("MCP 工具名称重复：{public_name}"),
                    ));
                }
                if tools.len() > MAX_MCP_TOOLS {
                    return Err(McpRuntimeError::new(
                        "mcp_tool_limit_exceeded",
                        format!("MCP 工具数量超过首版上限 {MAX_MCP_TOOLS}"),
                    ));
                }
            }
            clients.push(client);
        }
        Ok(Self {
            tools: Arc::new(tools),
            clients: Arc::new(clients),
            configuration_identity: Arc::new(configuration_identity),
        })
    }

    pub(crate) fn tools(&self) -> impl Iterator<Item = &McpTool> {
        self.tools.values()
    }

    pub(crate) fn extension_identity(&self) -> Value {
        json!({
            "servers": self.configuration_identity.as_ref(),
            "tools": self.tools.values().map(|tool| json!({
                "publicName": tool.public_name,
                "remoteName": tool.remote_name,
                "description": tool.description,
                "inputSchema": tool.input_schema,
                "target": tool.target,
                "pluginUri": tool.plugin_uri,
            })).collect::<Vec<_>>(),
        })
    }

    pub(crate) fn shutdown(&self) -> Result<(), McpRuntimeError> {
        let mut first_error = None;
        for client in self.clients.iter() {
            if let Err(error) = client.shutdown() {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

pub(crate) fn configured_plugins(
    settings: &Value,
) -> Result<Vec<McpPluginDescriptor>, McpRuntimeError> {
    configured_servers(settings)?
        .into_iter()
        .map(|server| {
            let identity = json!({
                "id": server.id,
                "name": server.name,
                "transport": server.transport,
                "command": server.command,
                "args": server.args,
            });
            let encoded = serde_json::to_vec(&identity).map_err(|error| {
                McpRuntimeError::new(
                    "mcp_config_invalid",
                    format!("编码 MCP 插件身份失败：{error}"),
                )
            })?;
            Ok(McpPluginDescriptor {
                id: server.id.clone(),
                uri: mcp_plugin_uri(&server.id),
                name: server.name.clone(),
                plugin_artifact_ref: format!(
                    "plugin-artifact:{}",
                    deepcode_kernel_tools::hash_bytes(&encoded)
                ),
                plugin_instance_ref: format!("plugin-instance:mcp:{}", server.id),
                capability_ref: format!("mcp-server:{}", server.id),
            })
        })
        .collect()
}

fn mcp_plugin_uri(server_id: &str) -> String {
    let slug = server_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let slug = slug.trim_matches('-');
    format!(
        "plugin://{}@mcp",
        if slug.is_empty() { "plugin" } else { slug }
    )
}

fn configured_servers(settings: &Value) -> Result<Vec<McpServerSetting>, McpRuntimeError> {
    let encoded = settings
        .get("mcp.servers")
        .and_then(Value::as_str)
        .unwrap_or("[]");
    let servers: Vec<McpServerSetting> = serde_json::from_str(encoded).map_err(|error| {
        McpRuntimeError::new(
            "mcp_config_invalid",
            format!("解析 mcp.servers 失败：{error}"),
        )
    })?;
    let mut seen = BTreeSet::new();
    servers
        .into_iter()
        .filter(|server| server.enabled)
        .map(|server| {
            validate_server(&server)?;
            if !seen.insert(server.id.clone()) {
                return Err(McpRuntimeError::new(
                    "mcp_server_duplicate",
                    format!("MCP Server id 重复：{}", server.id),
                ));
            }
            Ok(server)
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerSetting {
    id: String,
    #[serde(default = "default_server_name")]
    name: String,
    #[serde(default = "default_transport")]
    transport: String,
    command: String,
    #[serde(default)]
    args: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteToolDefinition {
    name: String,
    description: Option<String>,
    #[serde(default = "default_input_schema")]
    input_schema: Value,
}

#[derive(Clone, Debug)]
struct McpClient {
    server_id: Arc<str>,
    process: Arc<Mutex<OwnedMcpProcess>>,
}

impl McpClient {
    fn start(server: &McpServerSetting) -> Result<Self, McpRuntimeError> {
        let args = split_args(&server.args)?;
        let mut command = Command::new(&server.command);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().map_err(|error| {
            McpRuntimeError::new(
                "mcp_server_spawn_failed",
                format!("启动 MCP Server {} 失败：{error}", server.id),
            )
        })?;
        let mut starting = ChildStartupGuard::new(child);
        let stdin = starting.child_mut().stdin.take().ok_or_else(|| {
            McpRuntimeError::new("mcp_server_pipe_failed", "MCP Server 缺少标准输入管道。")
        })?;
        let stdout = starting.child_mut().stdout.take().ok_or_else(|| {
            McpRuntimeError::new("mcp_server_pipe_failed", "MCP Server 缺少标准输出管道。")
        })?;
        let (sender, receiver) = mpsc::channel();
        let stdout_reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut frame = Vec::new();
                match reader.read_until(b'\n', &mut frame) {
                    Ok(0) => break,
                    Ok(_) => {
                        if sender.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });
        let stderr_reader = starting.child_mut().stderr.take().map(|mut stderr| {
            std::thread::spawn(move || {
                let mut buffer = [0_u8; 4096];
                while stderr.read(&mut buffer).is_ok_and(|read| read > 0) {}
            })
        });
        let child = starting.commit();
        let client = Self {
            server_id: Arc::from(server.id.as_str()),
            process: Arc::new(Mutex::new(OwnedMcpProcess {
                child,
                stdin: Some(BufWriter::new(stdin)),
                responses: receiver,
                stdout_reader: Some(stdout_reader),
                stderr_reader,
                next_id: 1,
                stopped: false,
            })),
        };
        client.request(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "DeepCode", "version": env!("CARGO_PKG_VERSION") },
            }),
            None,
        )?;
        client.notify("notifications/initialized", json!({}))?;
        Ok(client)
    }

    fn list_tools(&self) -> Result<Vec<RemoteToolDefinition>, McpRuntimeError> {
        let mut cursor: Option<String> = None;
        let mut tools = Vec::new();
        loop {
            let result = self.request(
                "tools/list",
                cursor
                    .as_ref()
                    .map_or_else(|| json!({}), |cursor| json!({ "cursor": cursor })),
                None,
            )?;
            let page = result.get("tools").cloned().ok_or_else(|| {
                McpRuntimeError::new("mcp_tools_invalid", "MCP tools/list 缺少 tools。")
            })?;
            let mut decoded: Vec<RemoteToolDefinition> =
                serde_json::from_value(page).map_err(|error| {
                    McpRuntimeError::new(
                        "mcp_tools_invalid",
                        format!("MCP tools/list 返回无效：{error}"),
                    )
                })?;
            if decoded
                .iter()
                .any(|tool| tool.name.is_empty() || !tool.input_schema.is_object())
            {
                return Err(McpRuntimeError::new(
                    "mcp_tools_invalid",
                    "MCP 工具名称或 inputSchema 无效。",
                ));
            }
            tools.append(&mut decoded);
            if tools.len() > MAX_MCP_TOOLS {
                return Err(McpRuntimeError::new(
                    "mcp_tool_limit_exceeded",
                    format!("MCP 工具数量超过首版上限 {MAX_MCP_TOOLS}"),
                ));
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                return Ok(tools);
            }
        }
    }

    fn call_tool(
        &self,
        name: &str,
        arguments: Value,
        cancellation: &KernelCancellationToken,
    ) -> Result<Value, McpRuntimeError> {
        let result = self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
            Some(cancellation),
        )?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            return Err(McpRuntimeError::new(
                "mcp_tool_failed",
                format!("MCP 工具 {name} 返回错误：{result}"),
            ));
        }
        Ok(result)
    }

    fn request(
        &self,
        method: &str,
        params: Value,
        cancellation: Option<&KernelCancellationToken>,
    ) -> Result<Value, McpRuntimeError> {
        let mut process = self.process.lock().map_err(|_| {
            McpRuntimeError::new("mcp_server_lock_failed", "MCP Server 状态锁已损坏。")
        })?;
        process.request(&self.server_id, method, params, cancellation)
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), McpRuntimeError> {
        let mut process = self.process.lock().map_err(|_| {
            McpRuntimeError::new("mcp_server_lock_failed", "MCP Server 状态锁已损坏。")
        })?;
        process.write_message(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn shutdown(&self) -> Result<(), McpRuntimeError> {
        let mut process = self.process.lock().map_err(|_| {
            McpRuntimeError::new("mcp_server_lock_failed", "MCP Server 状态锁已损坏。")
        })?;
        process.stop()
    }
}

struct ChildStartupGuard {
    child: Option<Child>,
}

impl ChildStartupGuard {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("starting child is present")
    }

    fn commit(mut self) -> Child {
        self.child.take().expect("starting child is present")
    }
}

impl Drop for ChildStartupGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct OwnedMcpProcess {
    child: Child,
    stdin: Option<BufWriter<ChildStdin>>,
    responses: Receiver<Result<Vec<u8>, String>>,
    stdout_reader: Option<JoinHandle<()>>,
    stderr_reader: Option<JoinHandle<()>>,
    next_id: u64,
    stopped: bool,
}

impl std::fmt::Debug for OwnedMcpProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("OwnedMcpProcess")
    }
}

impl OwnedMcpProcess {
    fn request(
        &mut self,
        server_id: &str,
        method: &str,
        params: Value,
        cancellation: Option<&KernelCancellationToken>,
    ) -> Result<Value, McpRuntimeError> {
        if self.stopped {
            return Err(McpRuntimeError::new(
                "mcp_server_stopped",
                format!("MCP Server {server_id} 已停止。"),
            ));
        }
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;
        let deadline = Instant::now() + MCP_RESPONSE_TIMEOUT;
        loop {
            if cancellation.is_some_and(KernelCancellationToken::is_cancelled) {
                self.stop()?;
                return Err(McpRuntimeError::new(
                    "mcp_tool_cancelled",
                    format!("MCP Server {server_id} request was cancelled and reclaimed."),
                ));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.stop()?;
                return Err(McpRuntimeError::new(
                    "mcp_server_timeout",
                    format!("MCP Server {server_id} 请求超时。"),
                ));
            }
            let frame = match self
                .responses
                .recv_timeout(remaining.min(MCP_CANCEL_POLL_INTERVAL))
            {
                Ok(Ok(frame)) => frame,
                Ok(Err(error)) => {
                    return Err(McpRuntimeError::new(
                        "mcp_server_read_failed",
                        format!("读取 MCP Server {server_id} 失败：{error}"),
                    ))
                }
                Err(RecvTimeoutError::Timeout) => {
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(McpRuntimeError::new(
                        "mcp_server_ended",
                        format!("MCP Server {server_id} 已退出。"),
                    ))
                }
            };
            let value = decode_frame(server_id, frame)?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(McpRuntimeError::new(
                    "mcp_request_failed",
                    format!("MCP Server {server_id} 拒绝 {method}：{error}"),
                ));
            }
            return value.get("result").cloned().ok_or_else(|| {
                McpRuntimeError::new(
                    "mcp_response_invalid",
                    format!("MCP Server {server_id} 回复缺少 result。"),
                )
            });
        }
    }

    fn write_message(&mut self, value: &Value) -> Result<(), McpRuntimeError> {
        if self.stopped {
            return Err(McpRuntimeError::new(
                "mcp_server_stopped",
                "MCP Server 已停止。",
            ));
        }
        let mut encoded = serde_json::to_vec(value).map_err(|error| {
            McpRuntimeError::new(
                "mcp_request_encode_failed",
                format!("编码 MCP 请求失败：{error}"),
            )
        })?;
        if encoded.len() > MAX_MCP_FRAME_BYTES {
            return Err(McpRuntimeError::new(
                "mcp_request_too_large",
                "MCP 请求超过本地 transport 上限。",
            ));
        }
        encoded.push(b'\n');
        let stdin = self.stdin.as_mut().ok_or_else(|| {
            McpRuntimeError::new("mcp_server_stopped", "MCP Server 输入已经关闭。")
        })?;
        stdin.write_all(&encoded).map_err(|error| {
            McpRuntimeError::new(
                "mcp_server_write_failed",
                format!("写入 MCP Server 失败：{error}"),
            )
        })?;
        stdin.flush().map_err(|error| {
            McpRuntimeError::new(
                "mcp_server_write_failed",
                format!("刷新 MCP Server 输入失败：{error}"),
            )
        })
    }

    fn stop(&mut self) -> Result<(), McpRuntimeError> {
        if self.stopped && self.stdout_reader.is_none() && self.stderr_reader.is_none() {
            return Ok(());
        }
        self.stdin.take();
        let mut first_error = None;
        if self.child.try_wait().ok().flatten().is_none() {
            if let Err(error) = self.child.kill() {
                first_error.get_or_insert_with(|| {
                    McpRuntimeError::new(
                        "mcp_server_stop_failed",
                        format!("停止 MCP Server 失败：{error}"),
                    )
                });
            }
        }
        if let Err(error) = self.child.wait() {
            first_error.get_or_insert_with(|| {
                McpRuntimeError::new(
                    "mcp_server_wait_failed",
                    format!("回收 MCP Server 失败：{error}"),
                )
            });
        }
        for (stream, reader) in [
            ("stdout", self.stdout_reader.take()),
            ("stderr", self.stderr_reader.take()),
        ] {
            if reader.is_some_and(|reader| reader.join().is_err()) {
                first_error.get_or_insert_with(|| {
                    McpRuntimeError::new(
                        "mcp_server_reader_join_failed",
                        format!("回收 MCP Server {stream} reader 失败。"),
                    )
                });
            }
        }
        self.stopped = true;
        first_error.map_or(Ok(()), Err)
    }
}

impl Drop for OwnedMcpProcess {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn validate_server(server: &McpServerSetting) -> Result<(), McpRuntimeError> {
    if server.id.is_empty() || server.id.len() > 80 || server.id.chars().any(char::is_control) {
        return Err(McpRuntimeError::new(
            "mcp_server_identity_invalid",
            "MCP Server id 无效。",
        ));
    }
    if server.transport != "stdio" {
        return Err(McpRuntimeError::new(
            "mcp_transport_unsupported",
            format!("首版本地 MCP 仅支持 stdio：{}", server.id),
        ));
    }
    if server.command.trim().is_empty() {
        return Err(McpRuntimeError::new(
            "mcp_server_command_missing",
            format!("MCP Server {} 缺少 command。", server.id),
        ));
    }
    Ok(())
}

fn decode_frame(server_id: &str, mut frame: Vec<u8>) -> Result<Value, McpRuntimeError> {
    if frame.len() > MAX_MCP_FRAME_BYTES + 1 || frame.last() != Some(&b'\n') {
        return Err(McpRuntimeError::new(
            "mcp_response_invalid",
            format!("MCP Server {server_id} 回复过大或未按行结束。"),
        ));
    }
    frame.pop();
    if frame.last() == Some(&b'\r') {
        frame.pop();
    }
    let value: Value = serde_json::from_slice(&frame).map_err(|error| {
        McpRuntimeError::new(
            "mcp_response_json_invalid",
            format!("MCP Server {server_id} 回复不是 JSON：{error}"),
        )
    })?;
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(McpRuntimeError::new(
            "mcp_response_invalid",
            format!("MCP Server {server_id} 回复缺少 JSON-RPC 版本。"),
        ));
    }
    Ok(value)
}

fn public_tool_name(server_id: &str, remote_name: &str) -> Result<String, McpRuntimeError> {
    let server = normalized_name(server_id);
    let remote = normalized_name(remote_name);
    let name = format!("mcp.{server}.{remote}");
    if remote.is_empty() || name.len() > 128 {
        return Err(McpRuntimeError::new(
            "mcp_tool_name_invalid",
            format!("MCP 工具名称无法映射：{remote_name}"),
        ));
    }
    Ok(name)
}

fn normalized_name(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                Some(character)
            } else if character == '/' || character.is_whitespace() {
                Some('_')
            } else {
                None
            }
        })
        .collect()
}

fn split_args(value: &str) -> Result<Vec<String>, McpRuntimeError> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            } else {
                current.push(character);
            }
            continue;
        }
        if character.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped || quote.is_some() {
        return Err(McpRuntimeError::new(
            "mcp_server_args_invalid",
            "MCP Server args 中的引号或转义未闭合。",
        ));
    }
    if !current.is_empty() {
        args.push(current);
    }
    Ok(args)
}

fn default_input_schema() -> Value {
    json!({ "type": "object" })
}

fn default_server_name() -> String {
    "MCP Server".to_string()
}

fn default_transport() -> String {
    "stdio".to_string()
}

const fn enabled_by_default() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdio_server_contributes_and_executes_tool() {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/skill-mcp-smoke/mcp/mcp-text-tools/server.py")
            .canonicalize()
            .expect("fixture server");
        let settings = json!({
            "mcp.autoLoad": true,
            "mcp.servers": serde_json::to_string(&json!([{
                "id": "fixture.mcp.text-tools",
                "name": "Fixture MCP Text Tools",
                "transport": "stdio",
                "command": "python3",
                "args": script.to_string_lossy(),
                "enabled": true,
            }])).expect("settings"),
        });
        let runtime = McpRuntime::from_selected_settings(
            &settings,
            &BTreeSet::from(["fixture.mcp.text-tools".to_string()]),
        )
        .expect("start selected MCP runtime");
        let tool = runtime
            .tools()
            .find(|tool| tool.public_name == "mcp.fixture.mcp.text-tools.text.reverse")
            .expect("mapped tool");
        let result = tool
            .call(
                json!({ "text": "DeepCode" }),
                &KernelCancellationToken::default(),
            )
            .expect("call tool");
        assert_eq!(result.pointer("/content/0/text"), Some(&json!("edoCpeeD")));
        runtime.shutdown().expect("shutdown MCP runtime");
    }

    #[test]
    fn cancelled_tool_call_stops_and_reclaims_the_stdio_server() {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/skill-mcp-smoke/mcp/mcp-text-tools/server.py")
            .canonicalize()
            .expect("fixture server");
        let settings = json!({
            "mcp.autoLoad": true,
            "mcp.servers": serde_json::to_string(&json!([{
                "id": "fixture.mcp.cancelled",
                "name": "Fixture MCP Cancellation",
                "transport": "stdio",
                "command": "python3",
                "args": script.to_string_lossy(),
                "enabled": true,
            }])).expect("settings"),
        });
        let runtime = McpRuntime::from_selected_settings(
            &settings,
            &BTreeSet::from(["fixture.mcp.cancelled".to_string()]),
        )
        .expect("start selected MCP runtime");
        let tool = runtime.tools().next().expect("mapped tool");
        let cancellation = KernelCancellationToken::default();
        cancellation.cancel();

        let error = tool
            .call(json!({ "text": "DeepCode" }), &cancellation)
            .expect_err("cancelled MCP call must fail after process cleanup");
        assert_eq!(error.code, "mcp_tool_cancelled");
        runtime
            .shutdown()
            .expect("cancelled runtime is already reclaimed");
    }
}
