use deepcode_kernel_abi::KernelResult;
use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub mod hash;
pub mod manifest;
pub mod mcp;
pub mod mount;
pub mod plugin;
pub mod risk;
pub mod scanner;
pub mod trust_record;

pub use manifest::{
    InvocationPolicy, SkillEntrypoint, SkillEntrypointKind, SkillLimitDeclaration, SkillManifest,
    SkillManifestKind, SkillOutputPolicy, SkillProvenance, SkillRiskDeclaration,
    SkillRuntimeDeclaration, SkillSourceScope, WorkspaceAccess,
};
pub use mcp::{
    McpAuthDeclaration, McpConnectorDescriptor, McpConnectorManifest, McpDescriptorKind,
    McpPromptBinding, McpPromptDescriptor, McpPromptProjection, McpResourceBinding,
    McpResourceDescriptor, McpResourceProjection, McpRiskAcknowledgment,
    McpRiskAcknowledgmentRecord, McpServerIdentity, McpToolBinding, McpToolDescriptor,
    McpToolProjection, McpTransportDeclaration,
};
pub use mount::{scan_skill_mount, SkillMountEntry, SkillMountScanError, SkillMountScanResult};
pub use plugin::{
    PluginBundleContents, PluginBundleManifest, PluginBundlePolicy, PluginRiskSummary,
};
pub use risk::{RiskFindingKind, SkillRiskFinding, SkillRiskReport};
pub use trust_record::{SkillTrustMode, SkillTrustRecord};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSource {
    LocalPack { pack_id: String },
    ExternalProcess { program: String, argv: Vec<String> },
    ExternalConnector { connector_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillAdapterKind {
    Declarative,
    ExternalProcess,
    Mcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillActivationStatus {
    Dormant,
    Registered,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptor {
    pub id: String,
    pub version: String,
    pub title_key: Option<String>,
    pub description_key: Option<String>,
    pub input_schema: Value,
    pub output_schema: Value,
    pub required_capabilities: Vec<Capability>,
    pub allowed_phases: Vec<String>,
    pub risk_level: RiskLevel,
    pub effects: Vec<CapabilityEffect>,
    pub source: SkillSource,
    pub adapter_kind: SkillAdapterKind,
    pub activation_status: SkillActivationStatus,
    pub requested_model_visible: bool,
}

impl SkillDescriptor {
    pub fn is_registered(&self) -> bool {
        self.activation_status == SkillActivationStatus::Registered
    }
}

pub trait UserSkillRegistry {
    fn list(&self) -> KernelResult<Vec<SkillDescriptor>>;
    fn get(&self, skill_id: &str) -> KernelResult<Option<SkillDescriptor>>;
}

#[derive(Debug, Clone, Default)]
pub struct InMemoryUserSkillRegistry {
    descriptors: BTreeMap<String, SkillDescriptor>,
}

impl InMemoryUserSkillRegistry {
    pub fn new(descriptors: Vec<SkillDescriptor>) -> Self {
        Self {
            descriptors: descriptors
                .into_iter()
                .map(|descriptor| (descriptor.id.clone(), descriptor))
                .collect(),
        }
    }

    pub fn len(&self) -> usize {
        self.descriptors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.descriptors.is_empty()
    }
}

impl UserSkillRegistry for InMemoryUserSkillRegistry {
    fn list(&self) -> KernelResult<Vec<SkillDescriptor>> {
        Ok(self.descriptors.values().cloned().collect())
    }

    fn get(&self, skill_id: &str) -> KernelResult<Option<SkillDescriptor>> {
        Ok(self.descriptors.get(skill_id).cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dormant_skill_is_not_registered_as_executable() {
        let descriptor = SkillDescriptor {
            id: "example.read-only".to_string(),
            version: "1".to_string(),
            title_key: None,
            description_key: None,
            input_schema: serde_json::json!({ "type": "object" }),
            output_schema: serde_json::json!({ "type": "object" }),
            required_capabilities: Vec::new(),
            allowed_phases: vec!["plan".to_string()],
            risk_level: RiskLevel::Low,
            effects: Vec::new(),
            source: SkillSource::LocalPack {
                pack_id: "example".to_string(),
            },
            adapter_kind: SkillAdapterKind::Declarative,
            activation_status: SkillActivationStatus::Dormant,
            requested_model_visible: true,
        };
        let registry = InMemoryUserSkillRegistry::new(vec![descriptor]);
        let descriptor = registry.get("example.read-only").unwrap().unwrap();
        assert!(!descriptor.is_registered());
    }
}
