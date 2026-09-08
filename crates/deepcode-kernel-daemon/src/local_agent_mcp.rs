use crate::local_agent_first_party_plugins::{
    self, FirstPartyPluginDescriptor, FirstPartyToolBinding, FirstPartyToolDescriptor,
    FirstPartyToolEffect,
};
use deepcode_kernel_runtime::executors::{KernelCancellationToken, KernelToolExecutionContext};
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
    pub(crate) uri: String,
    pub(crate) name: String,
    pub(crate) short_description: String,
    pub(crate) activation_media_types: Vec<String>,
    pub(crate) plugin_artifact_ref: String,
    pub(crate) provider_ref: String,
    pub(crate) capability_refs: Vec<String>,
    pub(crate) capability_summary: String,
    pub(crate) tool_prompt_provider: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum McpToolEffectScope {
    WorkspaceRead,
    Network,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum McpToolBindingRequirement {
    None,
    WorkspacePath { argument: String },
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
    pub(crate) provider_ref: String,
    pub(crate) contribution_ref: String,
    pub(crate) effect_scope: McpToolEffectScope,
    pub(crate) binding_requirement: McpToolBindingRequirement,
    client: McpClient,
}

#[derive(Debug)]
pub(crate) struct McpToolCallResult {
    pub(crate) output: Value,
    pub(crate) failure: Option<McpToolCallFailure>,
}

#[derive(Debug)]
pub(crate) struct McpToolCallFailure {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl McpTool {
    pub(crate) fn call(
        &self,
        input: Value,
        context: &KernelToolExecutionContext,
    ) -> Result<McpToolCallResult, McpRuntimeError> {
        let metadata = match &self.binding_requirement {
            McpToolBindingRequirement::None => None,
            McpToolBindingRequirement::WorkspacePath { .. } => {
                let workspace_id = context.workspace_id.as_deref().ok_or_else(|| {
                    McpRuntimeError::new(
                        "mcp_workspace_binding_missing",
                        "First-party workspace tool 缺少 prepared workspace identity。",
                    )
                })?;
                Some(json!({
                    "deepcode": {
                        "workspaceId": workspace_id,
                        "resolvedWorkspaceTargets": context.private_resolved_targets,
                    }
                }))
            }
        };
        self.client
            .call_tool(&self.remote_name, input, metadata, &context.cancellation)
    }

    pub(crate) fn logical_targets(&self, input: &Value) -> Result<Vec<String>, McpRuntimeError> {
        match &self.binding_requirement {
            McpToolBindingRequirement::None => Ok(Vec::new()),
            McpToolBindingRequirement::WorkspacePath { argument } => {
                let target = input
                    .get(argument)
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        McpRuntimeError::new(
                            "mcp_workspace_target_invalid",
                            format!("Workspace tool requires logical path field {argument}."),
                        )
                    })?;
                Ok(vec![target.to_string()])
            }
        }
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
        selected_plugin_instances: &BTreeMap<String, String>,
    ) -> Result<Self, McpRuntimeError> {
        if selected_plugin_instances.is_empty() {
            return Ok(Self::default());
        }
        let servers = available_server_sources(settings)?;
        let available = servers
            .iter()
            .map(|server| server.descriptor.uri.as_str())
            .collect::<BTreeSet<_>>();
        if let Some(missing) = selected_plugin_instances
            .keys()
            .find(|uri| !available.contains(uri.as_str()))
        {
            return Err(McpRuntimeError::new(
                "plugin_selection_unavailable",
                format!("显式选择的 MCP-backed 插件不可用：{missing}"),
            ));
        }
        Self::from_servers(
            servers
                .into_iter()
                .filter(|server| selected_plugin_instances.contains_key(&server.descriptor.uri))
                .collect(),
            selected_plugin_instances,
        )
    }

    fn from_servers(
        servers: Vec<McpServerSource>,
        selected_plugin_instances: &BTreeMap<String, String>,
    ) -> Result<Self, McpRuntimeError> {
        let mut servers_by_id = BTreeMap::new();
        for server in servers {
            validate_server(&server.setting)?;
            let server_id = server.setting.id.clone();
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
                        "id": server.setting.id,
                        "uri": server.descriptor.uri,
                        "pluginArtifactRef": server.descriptor.plugin_artifact_ref,
                        "name": server.setting.name,
                        "transport": server.setting.transport,
                        "command": server.setting.command,
                        "args": server.setting.args,
                    })
                })
                .collect(),
        );
        let mut tools = BTreeMap::new();
        let mut clients = Vec::new();
        for (_, server) in servers_by_id {
            let client = McpClient::start(&server.setting)?;
            let definitions = client.list_tools()?;
            validate_first_party_tool_set(&server, &definitions)?;
            let plugin_instance_ref = selected_plugin_instances
                .get(&server.descriptor.uri)
                .expect("selected server has a plugin instance")
                .clone();
            for definition in definitions {
                let contract = tool_contract(&server, &definition)?;
                let public_name = contract.public_name;
                let tool = McpTool {
                    public_name: public_name.clone(),
                    remote_name: definition.name.clone(),
                    description: contract.description,
                    input_schema: contract.input_schema,
                    target: contract
                        .logical_target
                        .unwrap_or_else(|| format!("{}: {}", server.setting.name, definition.name)),
                    plugin_uri: server.descriptor.uri.clone(),
                    plugin_instance_ref: plugin_instance_ref.clone(),
                    provider_ref: contract.provider_ref,
                    contribution_ref: contract.contribution_ref,
                    effect_scope: contract.effect_scope,
                    binding_requirement: contract.binding_requirement,
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
                "providerRef": tool.provider_ref,
                "contributionRef": tool.contribution_ref,
                "effectScope": mcp_effect_scope_name(tool.effect_scope),
                "bindingRequirement": mcp_binding_identity(&tool.binding_requirement),
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

pub(crate) fn available_plugins(
    settings: &Value,
) -> Result<Vec<McpPluginDescriptor>, McpRuntimeError> {
    Ok(available_server_sources(settings)?
        .into_iter()
        .map(|server| server.descriptor)
        .collect())
}

#[derive(Clone)]
struct McpServerSource {
    setting: McpServerSetting,
    descriptor: McpPluginDescriptor,
    contract: McpServerContract,
}

#[derive(Clone)]
enum McpServerContract {
    External,
    FirstParty(Vec<FirstPartyToolDescriptor>),
}

struct McpToolContract {
    public_name: String,
    description: String,
    input_schema: Value,
    provider_ref: String,
    contribution_ref: String,
    effect_scope: McpToolEffectScope,
    logical_target: Option<String>,
    binding_requirement: McpToolBindingRequirement,
}

fn available_server_sources(settings: &Value) -> Result<Vec<McpServerSource>, McpRuntimeError> {
    let mut sources = configured_servers(settings)?
        .into_iter()
        .map(external_server_source)
        .collect::<Result<Vec<_>, _>>()?;
    let provider_binary = local_agent_first_party_plugins::provider_binary()
        .map_err(|message| McpRuntimeError::new("first_party_provider_unavailable", message))?;
    let provider_binary = provider_binary.to_str().ok_or_else(|| {
        McpRuntimeError::new(
            "first_party_provider_unavailable",
            "First-party provider 路径不是 UTF-8。",
        )
    })?;
    for descriptor in local_agent_first_party_plugins::descriptors()
        .map_err(|message| McpRuntimeError::new("first_party_manifest_invalid", message))?
    {
        sources.push(first_party_server_source(descriptor, provider_binary));
    }
    let mut ids = BTreeSet::new();
    let mut uris = BTreeSet::new();
    for source in &sources {
        if !ids.insert(source.setting.id.clone()) {
            return Err(McpRuntimeError::new(
                "mcp_server_duplicate",
                format!("MCP Server id 重复：{}", source.setting.id),
            ));
        }
        if !uris.insert(source.descriptor.uri.clone()) {
            return Err(McpRuntimeError::new(
                "plugin_uri_duplicate",
                format!("MCP-backed plugin URI 重复：{}", source.descriptor.uri),
            ));
        }
    }
    Ok(sources)
}

fn external_server_source(setting: McpServerSetting) -> Result<McpServerSource, McpRuntimeError> {
    let identity = json!({
        "id": setting.id,
        "name": setting.name,
        "transport": setting.transport,
        "command": setting.command,
        "args": setting.args,
    });
    let encoded = serde_json::to_vec(&identity).map_err(|error| {
        McpRuntimeError::new(
            "mcp_config_invalid",
            format!("编码 MCP 插件身份失败：{error}"),
        )
    })?;
    let descriptor = McpPluginDescriptor {
        uri: mcp_plugin_uri(&setting.id),
        name: setting.name.clone(),
        short_description: format!("MCP service {}", setting.name),
        activation_media_types: Vec::new(),
        plugin_artifact_ref: format!(
            "plugin-artifact:{}",
            deepcode_kernel_tools::hash_bytes(&encoded)
        ),
        provider_ref: "tool-provider:mcp".to_string(),
        capability_refs: vec![format!("mcp-server:{}", setting.id)],
        capability_summary: "The selected MCP service is active for this run. Its callable tools are supplied separately by the current tool catalog.".to_string(),
        tool_prompt_provider: None,
    };
    Ok(McpServerSource {
        setting,
        descriptor,
        contract: McpServerContract::External,
    })
}

fn first_party_server_source(
    plugin: FirstPartyPluginDescriptor,
    provider_binary: &str,
) -> McpServerSource {
    let FirstPartyPluginDescriptor {
        id,
        uri,
        display_name,
        short_description,
        activation_media_types,
        provider_ref,
        plugin_artifact_ref,
        capability_refs,
        capability_summary,
        tools,
    } = plugin;
    let prompt_contributions = tools
        .iter()
        .map(|tool| {
            json!({
                "contributionRef": tool.prompt_contribution.contribution_ref,
                "canonicalToolName": tool.canonical_name,
                "promptSnippet": tool.prompt_contribution.prompt_snippet,
                "usageGuidelines": tool.prompt_contribution.usage_guidelines,
            })
        })
        .collect::<Vec<_>>();
    let descriptor = McpPluginDescriptor {
        uri: uri.clone(),
        name: display_name.clone(),
        short_description,
        activation_media_types,
        plugin_artifact_ref,
        provider_ref,
        capability_refs,
        capability_summary,
        tool_prompt_provider: Some(json!({
            "providerRef": format!("tool-prompt-provider:first-party:{id}"),
            "origin": "extension",
            "pluginUri": uri,
            "contributions": prompt_contributions,
        })),
    };
    McpServerSource {
        setting: McpServerSetting {
            id: format!("first-party.{id}"),
            name: display_name,
            transport: "stdio".to_string(),
            command: provider_binary.to_string(),
            args: format!("--plugin {id}"),
            enabled: true,
        },
        descriptor,
        contract: McpServerContract::FirstParty(tools),
    }
}

fn validate_first_party_tool_set(
    server: &McpServerSource,
    definitions: &[RemoteToolDefinition],
) -> Result<(), McpRuntimeError> {
    let McpServerContract::FirstParty(expected) = &server.contract else {
        return Ok(());
    };
    if definitions.len() != expected.len() {
        return Err(McpRuntimeError::new(
            "first_party_descriptor_mismatch",
            format!(
                "First-party provider {} tool 数量与 manifest 不一致。",
                server.descriptor.uri
            ),
        ));
    }
    for tool in expected {
        let definition = definitions
            .iter()
            .find(|definition| definition.name == tool.remote_name)
            .ok_or_else(|| {
                McpRuntimeError::new(
                    "first_party_descriptor_mismatch",
                    format!("First-party provider 缺少工具：{}", tool.remote_name),
                )
            })?;
        if definition.description.as_deref() != Some(tool.description.as_str())
            || definition.input_schema != tool.input_schema
        {
            return Err(McpRuntimeError::new(
                "first_party_descriptor_mismatch",
                format!(
                    "First-party provider 工具 schema/description 与 manifest 不一致：{}",
                    tool.remote_name
                ),
            ));
        }
    }
    Ok(())
}

fn tool_contract(
    server: &McpServerSource,
    definition: &RemoteToolDefinition,
) -> Result<McpToolContract, McpRuntimeError> {
    match &server.contract {
        McpServerContract::External => Ok(McpToolContract {
            public_name: public_tool_name(&server.setting.id, &definition.name)?,
            description: definition
                .description
                .clone()
                .unwrap_or_else(|| format!("MCP tool {}", definition.name)),
            input_schema: definition.input_schema.clone(),
            provider_ref: "tool-provider:mcp".to_string(),
            contribution_ref: format!(
                "tool-contribution:mcp:{}",
                public_tool_name(&server.setting.id, &definition.name)?
            ),
            effect_scope: McpToolEffectScope::External,
            logical_target: None,
            binding_requirement: McpToolBindingRequirement::None,
        }),
        McpServerContract::FirstParty(tools) => {
            let tool = tools
                .iter()
                .find(|tool| tool.remote_name == definition.name)
                .expect("validated first-party tool set");
            Ok(McpToolContract {
                public_name: tool.canonical_name.clone(),
                description: tool.description.clone(),
                input_schema: tool.input_schema.clone(),
                provider_ref: server.descriptor.provider_ref.clone(),
                contribution_ref: tool.tool_contribution_ref.clone(),
                effect_scope: match tool.effect {
                    FirstPartyToolEffect::NetworkRead => McpToolEffectScope::Network,
                    FirstPartyToolEffect::WorkspaceRead => McpToolEffectScope::WorkspaceRead,
                },
                logical_target: tool.logical_target.clone(),
                binding_requirement: match &tool.binding {
                    FirstPartyToolBinding::None => McpToolBindingRequirement::None,
                    FirstPartyToolBinding::WorkspacePath { argument } => {
                        McpToolBindingRequirement::WorkspacePath {
                            argument: argument.clone(),
                        }
                    }
                },
            })
        }
    }
}

fn mcp_effect_scope_name(scope: McpToolEffectScope) -> &'static str {
    match scope {
        McpToolEffectScope::WorkspaceRead => "workspaceRead",
        McpToolEffectScope::Network => "network",
        McpToolEffectScope::External => "external",
    }
}

fn mcp_binding_identity(binding: &McpToolBindingRequirement) -> Value {
    match binding {
        McpToolBindingRequirement::None => json!({ "kind": "none" }),
        McpToolBindingRequirement::WorkspacePath { argument } => {
            json!({ "kind": "workspacePath", "argument": argument })
        }
    }
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

#[derive(Debug, Clone, Deserialize)]
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
        metadata: Option<Value>,
        cancellation: &KernelCancellationToken,
    ) -> Result<McpToolCallResult, McpRuntimeError> {
        let mut params = json!({ "name": name, "arguments": arguments });
        if let Some(metadata) = metadata {
            params["_meta"] = metadata;
        }
        let result = self.request("tools/call", params, Some(cancellation))?;
        decode_tool_call_result(name, result)
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

fn decode_tool_call_result(
    name: &str,
    output: Value,
) -> Result<McpToolCallResult, McpRuntimeError> {
    let is_error = match output.get("isError") {
        None => false,
        Some(value) => value.as_bool().ok_or_else(|| {
            McpRuntimeError::new(
                "mcp_response_invalid",
                format!("MCP 工具 {name} 的 isError 不是布尔值。"),
            )
        })?,
    };
    let failure = is_error.then(|| {
        let provider_error = output
            .pointer("/structuredContent/error")
            .and_then(Value::as_object);
        McpToolCallFailure {
            code: provider_error
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .filter(|code| !code.is_empty())
                .unwrap_or("mcp_tool_failed")
                .to_string(),
            message: provider_error
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .filter(|message| !message.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("MCP 工具 {name} 返回错误：{output}")),
        }
    });
    Ok(McpToolCallResult { output, failure })
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
            &BTreeMap::from([(
                mcp_plugin_uri("fixture.mcp.text-tools"),
                "plugin-instance:test:text-tools".to_string(),
            )]),
        )
        .expect("start selected MCP runtime");
        let tool = runtime
            .tools()
            .find(|tool| tool.public_name == "mcp.fixture.mcp.text-tools.text.reverse")
            .expect("mapped tool");
        let result = tool
            .call(
                json!({ "text": "DeepCode" }),
                &KernelToolExecutionContext {
                    output_directory: None,
                    workspace_root: None,
                    workspace_id: None,
                    private_resolved_targets: Vec::new(),
                    cancellation: KernelCancellationToken::default(),
                },
            )
            .expect("call tool");
        assert!(result.failure.is_none());
        assert_eq!(
            result.output.pointer("/content/0/text"),
            Some(&json!("edoCpeeD"))
        );
        runtime.shutdown().expect("shutdown MCP runtime");
    }

    #[test]
    fn structured_tool_failure_preserves_provider_error() {
        let result = decode_tool_call_result(
            "read",
            json!({
                "content": [{ "type": "text", "text": "failure" }],
                "structuredContent": {
                    "error": {
                        "code": "pdf_extract_failed",
                        "message": "invalid PDF"
                    }
                },
                "isError": true
            }),
        )
        .expect("valid MCP tool failure");
        let failure = result.failure.expect("provider failure");
        assert_eq!(failure.code, "pdf_extract_failed");
        assert_eq!(failure.message, "invalid PDF");
        assert_eq!(result.output["isError"], true);
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
            &BTreeMap::from([(
                mcp_plugin_uri("fixture.mcp.cancelled"),
                "plugin-instance:test:cancelled".to_string(),
            )]),
        )
        .expect("start selected MCP runtime");
        let tool = runtime.tools().next().expect("mapped tool");
        let cancellation = KernelCancellationToken::default();
        cancellation.cancel();
        let context = KernelToolExecutionContext {
            output_directory: None,
            workspace_root: None,
            workspace_id: None,
            private_resolved_targets: Vec::new(),
            cancellation,
        };

        let error = tool
            .call(json!({ "text": "DeepCode" }), &context)
            .expect_err("cancelled MCP call must fail after process cleanup");
        assert_eq!(error.code, "mcp_tool_cancelled");
        runtime
            .shutdown()
            .expect("cancelled runtime is already reclaimed");
    }
}
