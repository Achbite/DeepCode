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
    pub connector_id: String,
    pub tool_id: String,
    pub internal_skill_id: String,
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

pub fn model_visible_mcp_tools(
    connector: &McpConnectorDescriptor,
    bindings: &[McpToolBinding],
    effective_capabilities: &[Capability],
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

fn capabilities_cover(available: &[Capability], required: &[Capability]) -> bool {
    required
        .iter()
        .all(|capability| available.contains(capability))
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
            resources: Vec::new(),
            prompts: Vec::new(),
            risk_level: RiskLevel::High,
            default_model_visible: true,
        }
    }

    fn binding(risk_acknowledged: bool) -> McpToolBinding {
        McpToolBinding {
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
}
