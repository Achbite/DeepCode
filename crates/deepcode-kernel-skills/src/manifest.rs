use crate::SkillTrustMode;
use deepcode_kernel_policy::{Capability, CapabilityEffect};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub schema_version: u32,
    pub skill_id: String,
    pub version: String,
    pub title: String,
    pub description: Option<String>,
    pub entrypoint: SkillEntrypoint,
    pub requested_capabilities: Vec<Capability>,
    pub effects: Vec<CapabilityEffect>,
    pub env_allowlist: Vec<String>,
    pub workspace_access: WorkspaceAccess,
    pub timeout_ms: u64,
    pub model_visible: bool,
    pub requested_trust_mode: SkillTrustMode,
}

impl SkillManifest {
    pub fn v1_runtime_enabled(&self) -> bool {
        self.requested_trust_mode.is_v1_runtime_enabled()
    }

    pub fn requires_approval(&self) -> bool {
        !self.requested_capabilities.is_empty()
            || !self.env_allowlist.is_empty()
            || self.workspace_access != WorkspaceAccess::None
            || self.requested_trust_mode != SkillTrustMode::Declarative
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntrypoint {
    pub kind: SkillEntrypointKind,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub script_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillEntrypointKind {
    Declarative,
    Script,
    ExternalProcess,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceAccess {
    None,
    ReadOnly,
    ReadWrite,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(trust_mode: SkillTrustMode) -> SkillManifest {
        SkillManifest {
            schema_version: 1,
            skill_id: "skill.test".to_string(),
            version: "1".to_string(),
            title: "Test Skill".to_string(),
            description: None,
            entrypoint: SkillEntrypoint {
                kind: SkillEntrypointKind::Script,
                command: Some("python3".to_string()),
                args: vec!["skill.py".to_string()],
                script_path: Some("skill.py".to_string()),
            },
            requested_capabilities: vec![Capability::workspace_read()],
            effects: vec![CapabilityEffect::ReadsWorkspace],
            env_allowlist: Vec::new(),
            workspace_access: WorkspaceAccess::ReadOnly,
            timeout_ms: 1_000,
            model_visible: false,
            requested_trust_mode: trust_mode,
        }
    }

    #[test]
    fn manifest_cannot_enable_direct_host_in_v1() {
        let manifest = manifest(SkillTrustMode::DirectHostScript);
        assert!(!manifest.v1_runtime_enabled());
        assert!(manifest.requires_approval());
    }

    #[test]
    fn declarative_manifest_without_effects_can_skip_approval() {
        let mut manifest = manifest(SkillTrustMode::Declarative);
        manifest.requested_capabilities.clear();
        manifest.effects.clear();
        manifest.workspace_access = WorkspaceAccess::None;
        assert!(manifest.v1_runtime_enabled());
        assert!(!manifest.requires_approval());
    }
}
