use crate::external::supervisor::{
    CwdScope, NetworkPolicy, ProcessExecutionPolicy, ProcessInvocation,
};
use crate::SkillInvocation;
use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_policy::{Capability, RiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectorDescriptor {
    pub connector_id: String,
    pub version: String,
    pub title: String,
    pub tools: Vec<McpToolDescriptor>,
    pub resources: Vec<McpResourceDescriptor>,
    pub prompts: Vec<McpPromptDescriptor>,
    pub risk_level: RiskLevel,
    pub default_model_visible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectorManifest {
    pub schema_version: u32,
    pub connector_id: String,
    pub version: String,
    pub server: McpServerIdentity,
    pub transport: McpTransportDeclaration,
    pub auth: McpAuthDeclaration,
    pub descriptor_snapshot_hash: Option<String>,
    pub risk_level: RiskLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerIdentity {
    pub name: String,
    pub vendor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTransportDeclaration {
    pub kind: String,
    pub command: Option<String>,
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthDeclaration {
    pub kind: String,
    pub secret_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDescriptor {
    pub id: String,
    pub title: String,
    pub input_schema: Value,
    pub required_capabilities: Vec<Capability>,
    pub risk_level: RiskLevel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceDescriptor {
    pub id: String,
    pub title: String,
    pub kind: McpDescriptorKind,
    pub required_capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptDescriptor {
    pub id: String,
    pub title: String,
    pub required_capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpDescriptorKind {
    Tool,
    Resource,
    Prompt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolBinding {
    pub binding_id: Option<String>,
    pub connector_id: String,
    pub tool_id: String,
    pub internal_skill_id: String,
    pub approved_capabilities: Vec<Capability>,
    pub risk_acknowledged: bool,
    pub revision_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceBinding {
    pub binding_id: Option<String>,
    pub connector_id: String,
    pub resource_id: String,
    pub internal_context_source_id: String,
    pub approved_capabilities: Vec<Capability>,
    pub risk_acknowledged: bool,
    pub revision_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptBinding {
    pub binding_id: Option<String>,
    pub connector_id: String,
    pub prompt_id: String,
    pub internal_prompt_source_id: String,
    pub approved_capabilities: Vec<Capability>,
    pub risk_acknowledged: bool,
    pub revision_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRiskAcknowledgment {
    pub connector_id: String,
    pub descriptor_id: String,
    pub acknowledged_by: String,
    pub acknowledged_at: String,
    pub risk_level: RiskLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRiskAcknowledgmentRecord {
    pub connector_id: String,
    pub binding_id: Option<String>,
    pub revision_hash: Option<String>,
    pub acknowledged_by: Option<String>,
    pub acknowledged_at: Option<String>,
    pub decision: String,
    pub risk_level: RiskLevel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolProjection {
    pub connector_id: String,
    pub tool_id: String,
    pub internal_skill_id: String,
    pub title: String,
    pub required_capabilities: Vec<Capability>,
    pub risk_level: RiskLevel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceProjection {
    pub connector_id: String,
    pub resource_id: String,
    pub internal_context_source_id: String,
    pub title: String,
    pub required_capabilities: Vec<Capability>,
    pub risk_level: RiskLevel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptProjection {
    pub connector_id: String,
    pub prompt_id: String,
    pub internal_prompt_source_id: String,
    pub title: String,
    pub required_capabilities: Vec<Capability>,
    pub risk_level: RiskLevel,
}

pub fn mcp_tool_projection_to_skill_invocation(
    projection: &McpToolProjection,
    invocation_id: impl Into<String>,
    run_id: Option<String>,
    session_id: Option<String>,
    input: Value,
) -> SkillInvocation {
    SkillInvocation {
        id: invocation_id.into(),
        run_id,
        session_id,
        skill_id: projection.internal_skill_id.clone(),
        phase: None,
        input: serde_json::json!({
            "connectorId": projection.connector_id,
            "toolId": projection.tool_id,
            "mcpInput": input,
        }),
    }
}

pub fn mcp_tool_process_invocation(
    manifest: &McpConnectorManifest,
    projection: &McpToolProjection,
    invocation_id: impl Into<String>,
    run_id: Option<String>,
    session_id: Option<String>,
    input: Value,
) -> KernelResult<ProcessInvocation> {
    if manifest.connector_id != projection.connector_id {
        return Err(KernelError::InvalidCommand(
            "MCP projection connector does not match connector manifest".to_string(),
        ));
    }
    if manifest.transport.kind != "stdio" && manifest.transport.kind != "process" {
        return Err(KernelError::PermissionDenied(format!(
            "MCP transport {} is descriptor-only or unsupported by the stage 13 process adapter",
            manifest.transport.kind
        )));
    }
    let command = manifest
        .transport
        .command
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand("MCP process transport command is required".to_string())
        })?;
    let command = command
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let stdin_payload = mcp_stdio_tool_call_payload(projection, input)?;
    Ok(ProcessInvocation {
        invocation_id: invocation_id.into(),
        run_id,
        session_id,
        skill_id: Some(projection.internal_skill_id.clone()),
        connector_id: Some(projection.connector_id.clone()),
        command,
        cwd: None,
        env: Vec::new(),
        stdin_payload: Some(stdin_payload),
        policy: ProcessExecutionPolicy {
            timeout_ms: 3_000,
            max_stdout_bytes: 16 * 1024,
            max_stderr_bytes: 16 * 1024,
            env_allowlist: Vec::new(),
            cwd_scope: CwdScope::ProcessDefault,
            network_policy: NetworkPolicy::Deny,
        },
    })
}

pub fn mcp_stdio_tool_call_payload(
    projection: &McpToolProjection,
    input: Value,
) -> KernelResult<String> {
    let initialize = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "clientInfo": {
                "name": "deepcode-kernel",
                "version": "0.5.1"
            },
            "capabilities": {}
        }
    });
    let tool_call = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": projection.tool_id,
            "arguments": input
        }
    });
    Ok(format!("{initialize}\n{tool_call}\n"))
}

pub fn parse_mcp_stdio_tool_result(stdout: &str) -> KernelResult<Value> {
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let value = serde_json::from_str::<Value>(line)
            .map_err(|error| KernelError::Other(format!("decode MCP stdio response: {error}")))?;
        if value.get("id").and_then(Value::as_u64) != Some(2) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(KernelError::Other(format!("MCP tool call failed: {error}")));
        }
        return value.get("result").cloned().ok_or_else(|| {
            KernelError::Other("MCP stdio tool response is missing result".to_string())
        });
    }
    Err(KernelError::Other(
        "MCP stdio tool response was not found".to_string(),
    ))
}

pub fn model_visible_mcp_tools(
    connector: &McpConnectorDescriptor,
    bindings: &[McpToolBinding],
    effective_capabilities: &[Capability],
) -> Vec<McpToolProjection> {
    model_visible_mcp_tools_for_revision(connector, bindings, effective_capabilities, None)
}

pub fn model_visible_mcp_tools_for_revision(
    connector: &McpConnectorDescriptor,
    bindings: &[McpToolBinding],
    effective_capabilities: &[Capability],
    expected_revision_hash: Option<&str>,
) -> Vec<McpToolProjection> {
    if !connector.default_model_visible {
        return Vec::new();
    }
    connector
        .tools
        .iter()
        .filter_map(|tool| {
            let binding = bindings.iter().find(|binding| {
                binding.connector_id == connector.connector_id && binding.tool_id == tool.id
            })?;
            if !binding.risk_acknowledged {
                return None;
            }
            if !revision_matches(binding.revision_hash.as_deref(), expected_revision_hash) {
                return None;
            }
            if !capabilities_cover(&binding.approved_capabilities, &tool.required_capabilities) {
                return None;
            }
            if !capabilities_cover(effective_capabilities, &tool.required_capabilities) {
                return None;
            }
            Some(McpToolProjection {
                connector_id: connector.connector_id.clone(),
                tool_id: tool.id.clone(),
                internal_skill_id: binding.internal_skill_id.clone(),
                title: tool.title.clone(),
                required_capabilities: tool.required_capabilities.clone(),
                risk_level: tool.risk_level.clone(),
            })
        })
        .collect()
}

pub fn model_visible_mcp_resources(
    connector: &McpConnectorDescriptor,
    bindings: &[McpResourceBinding],
    effective_capabilities: &[Capability],
) -> Vec<McpResourceProjection> {
    model_visible_mcp_resources_for_revision(connector, bindings, effective_capabilities, None)
}

pub fn model_visible_mcp_resources_for_revision(
    connector: &McpConnectorDescriptor,
    bindings: &[McpResourceBinding],
    effective_capabilities: &[Capability],
    expected_revision_hash: Option<&str>,
) -> Vec<McpResourceProjection> {
    if !connector.default_model_visible {
        return Vec::new();
    }
    connector
        .resources
        .iter()
        .filter_map(|resource| {
            let binding = bindings.iter().find(|binding| {
                binding.connector_id == connector.connector_id && binding.resource_id == resource.id
            })?;
            if !binding.risk_acknowledged {
                return None;
            }
            if !revision_matches(binding.revision_hash.as_deref(), expected_revision_hash) {
                return None;
            }
            if !capabilities_cover(
                &binding.approved_capabilities,
                &resource.required_capabilities,
            ) || !capabilities_cover(effective_capabilities, &resource.required_capabilities)
            {
                return None;
            }
            Some(McpResourceProjection {
                connector_id: connector.connector_id.clone(),
                resource_id: resource.id.clone(),
                internal_context_source_id: binding.internal_context_source_id.clone(),
                title: resource.title.clone(),
                required_capabilities: resource.required_capabilities.clone(),
                risk_level: connector.risk_level.clone(),
            })
        })
        .collect()
}

pub fn model_visible_mcp_prompts(
    connector: &McpConnectorDescriptor,
    bindings: &[McpPromptBinding],
    effective_capabilities: &[Capability],
) -> Vec<McpPromptProjection> {
    model_visible_mcp_prompts_for_revision(connector, bindings, effective_capabilities, None)
}

pub fn model_visible_mcp_prompts_for_revision(
    connector: &McpConnectorDescriptor,
    bindings: &[McpPromptBinding],
    effective_capabilities: &[Capability],
    expected_revision_hash: Option<&str>,
) -> Vec<McpPromptProjection> {
    if !connector.default_model_visible {
        return Vec::new();
    }
    connector
        .prompts
        .iter()
        .filter_map(|prompt| {
            let binding = bindings.iter().find(|binding| {
                binding.connector_id == connector.connector_id && binding.prompt_id == prompt.id
            })?;
            if !binding.risk_acknowledged {
                return None;
            }
            if !revision_matches(binding.revision_hash.as_deref(), expected_revision_hash) {
                return None;
            }
            if !capabilities_cover(
                &binding.approved_capabilities,
                &prompt.required_capabilities,
            ) || !capabilities_cover(effective_capabilities, &prompt.required_capabilities)
            {
                return None;
            }
            Some(McpPromptProjection {
                connector_id: connector.connector_id.clone(),
                prompt_id: prompt.id.clone(),
                internal_prompt_source_id: binding.internal_prompt_source_id.clone(),
                title: prompt.title.clone(),
                required_capabilities: prompt.required_capabilities.clone(),
                risk_level: connector.risk_level.clone(),
            })
        })
        .collect()
}

fn capabilities_cover(available: &[Capability], required: &[Capability]) -> bool {
    required
        .iter()
        .all(|capability| available.contains(capability))
}

fn revision_matches(actual: Option<&str>, expected: Option<&str>) -> bool {
    match expected {
        Some(expected) => actual == Some(expected),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connector() -> McpConnectorDescriptor {
        McpConnectorDescriptor {
            connector_id: "mcp.github".to_string(),
            version: "1".to_string(),
            title: "GitHub".to_string(),
            tools: vec![McpToolDescriptor {
                id: "repo.search".to_string(),
                title: "Search repository".to_string(),
                input_schema: serde_json::json!({ "type": "object" }),
                required_capabilities: vec![Capability::network_egress()],
                risk_level: RiskLevel::High,
            }],
            resources: vec![McpResourceDescriptor {
                id: "repo.file".to_string(),
                title: "Repository file".to_string(),
                kind: McpDescriptorKind::Resource,
                required_capabilities: vec![Capability::workspace_read()],
            }],
            prompts: vec![McpPromptDescriptor {
                id: "review.prompt".to_string(),
                title: "Review prompt".to_string(),
                required_capabilities: vec![Capability::network_egress()],
            }],
            risk_level: RiskLevel::High,
            default_model_visible: true,
        }
    }

    fn binding(risk_acknowledged: bool) -> McpToolBinding {
        McpToolBinding {
            binding_id: Some("binding-tool".to_string()),
            connector_id: "mcp.github".to_string(),
            tool_id: "repo.search".to_string(),
            internal_skill_id: "mcp.github.repo.search".to_string(),
            approved_capabilities: vec![Capability::network_egress()],
            risk_acknowledged,
            revision_hash: Some("sha256:abc".to_string()),
        }
    }

    #[test]
    fn mcp_tools_are_default_deny_without_binding() {
        assert!(
            model_visible_mcp_tools(&connector(), &[], &[Capability::network_egress()]).is_empty()
        );
    }

    #[test]
    fn mcp_tools_require_risk_acknowledgment_and_effective_capability() {
        assert!(model_visible_mcp_tools(
            &connector(),
            &[binding(false)],
            &[Capability::network_egress()]
        )
        .is_empty());

        let visible = model_visible_mcp_tools(
            &connector(),
            &[binding(true)],
            &[Capability::network_egress()],
        );
        assert_eq!(visible.len(), 1);

        assert!(model_visible_mcp_tools(&connector(), &[binding(true)], &[]).is_empty());
    }

    #[test]
    fn mcp_binding_revision_mismatch_hides_projection() {
        let connector = connector();
        assert!(model_visible_mcp_tools_for_revision(
            &connector,
            &[binding(true)],
            &[Capability::network_egress()],
            Some("sha256:new")
        )
        .is_empty());

        assert_eq!(
            model_visible_mcp_tools_for_revision(
                &connector,
                &[binding(true)],
                &[Capability::network_egress()],
                Some("sha256:abc")
            )
            .len(),
            1
        );
    }

    #[test]
    fn mcp_tool_projection_maps_to_internal_skill_invocation() {
        let projection = model_visible_mcp_tools(
            &connector(),
            &[binding(true)],
            &[Capability::network_egress()],
        )
        .pop()
        .expect("tool projection");
        let invocation = mcp_tool_projection_to_skill_invocation(
            &projection,
            "invoke-1",
            Some("run-1".to_string()),
            Some("session-1".to_string()),
            serde_json::json!({ "query": "DeepCode" }),
        );

        assert_eq!(invocation.id, "invoke-1");
        assert_eq!(invocation.run_id.as_deref(), Some("run-1"));
        assert_eq!(invocation.session_id.as_deref(), Some("session-1"));
        assert_eq!(invocation.skill_id, "mcp.github.repo.search");
        assert_eq!(invocation.input["connectorId"], "mcp.github");
        assert_eq!(invocation.input["toolId"], "repo.search");
        assert_eq!(invocation.input["mcpInput"]["query"], "DeepCode");
    }

    #[test]
    fn mcp_process_invocation_fails_closed_for_descriptor_only_transport() {
        let manifest = McpConnectorManifest {
            schema_version: 1,
            connector_id: "mcp.github".to_string(),
            version: "1".to_string(),
            server: McpServerIdentity {
                name: "GitHub".to_string(),
                vendor: None,
            },
            transport: McpTransportDeclaration {
                kind: "descriptorOnly".to_string(),
                command: None,
                endpoint: None,
            },
            auth: McpAuthDeclaration {
                kind: "none".to_string(),
                secret_ref: None,
            },
            descriptor_snapshot_hash: Some("sha256:abc".to_string()),
            risk_level: RiskLevel::High,
        };
        let projection = model_visible_mcp_tools(
            &connector(),
            &[binding(true)],
            &[Capability::network_egress()],
        )
        .pop()
        .expect("tool projection");
        let error = mcp_tool_process_invocation(
            &manifest,
            &projection,
            "invoke-mcp",
            Some("run-1".to_string()),
            Some("session-1".to_string()),
            serde_json::json!({ "query": "DeepCode" }),
        )
        .unwrap_err();
        assert!(matches!(error, KernelError::PermissionDenied(_)));
    }

    #[test]
    fn mcp_process_invocation_uses_projection_and_stdio_command() {
        let manifest = McpConnectorManifest {
            schema_version: 1,
            connector_id: "mcp.github".to_string(),
            version: "1".to_string(),
            server: McpServerIdentity {
                name: "GitHub".to_string(),
                vendor: None,
            },
            transport: McpTransportDeclaration {
                kind: "stdio".to_string(),
                command: Some("python3 fixture_server.py".to_string()),
                endpoint: None,
            },
            auth: McpAuthDeclaration {
                kind: "none".to_string(),
                secret_ref: None,
            },
            descriptor_snapshot_hash: Some("sha256:abc".to_string()),
            risk_level: RiskLevel::High,
        };
        let projection = model_visible_mcp_tools(
            &connector(),
            &[binding(true)],
            &[Capability::network_egress()],
        )
        .pop()
        .expect("tool projection");
        let invocation = mcp_tool_process_invocation(
            &manifest,
            &projection,
            "invoke-mcp",
            Some("run-1".to_string()),
            Some("session-1".to_string()),
            serde_json::json!({ "query": "DeepCode" }),
        )
        .unwrap();
        assert_eq!(invocation.command, vec!["python3", "fixture_server.py"]);
        assert_eq!(invocation.run_id.as_deref(), Some("run-1"));
        assert_eq!(invocation.session_id.as_deref(), Some("session-1"));
        assert_eq!(invocation.connector_id.as_deref(), Some("mcp.github"));
        assert!(invocation.stdin_payload.unwrap().contains("repo.search"));
        assert_eq!(invocation.policy.network_policy, NetworkPolicy::Deny);
    }

    #[test]
    fn mcp_resources_and_prompts_are_default_deny_until_bound_and_acknowledged() {
        let connector = connector();
        let resource_binding = McpResourceBinding {
            binding_id: Some("binding-resource".to_string()),
            connector_id: "mcp.github".to_string(),
            resource_id: "repo.file".to_string(),
            internal_context_source_id: "ctx.repo.file".to_string(),
            approved_capabilities: vec![Capability::workspace_read()],
            risk_acknowledged: true,
            revision_hash: Some("sha256:resource".to_string()),
        };
        let prompt_binding = McpPromptBinding {
            binding_id: Some("binding-prompt".to_string()),
            connector_id: "mcp.github".to_string(),
            prompt_id: "review.prompt".to_string(),
            internal_prompt_source_id: "prompt.review".to_string(),
            approved_capabilities: vec![Capability::network_egress()],
            risk_acknowledged: true,
            revision_hash: Some("sha256:prompt".to_string()),
        };

        assert!(
            model_visible_mcp_resources(&connector, &[], &[Capability::workspace_read()])
                .is_empty()
        );
        assert!(
            model_visible_mcp_prompts(&connector, &[], &[Capability::network_egress()]).is_empty()
        );

        assert_eq!(
            model_visible_mcp_resources(
                &connector,
                &[resource_binding],
                &[Capability::workspace_read()]
            )
            .len(),
            1
        );
        assert_eq!(
            model_visible_mcp_prompts(
                &connector,
                &[prompt_binding],
                &[Capability::network_egress()]
            )
            .len(),
            1
        );
    }
}
