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
    pub program: Option<String>,
    #[serde(default)]
    pub argv: Vec<String>,
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
