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
    #[serde(default)]
    pub kind: SkillManifestKind,
    pub entrypoint: SkillEntrypoint,
    pub requested_capabilities: Vec<Capability>,
    pub effects: Vec<CapabilityEffect>,
    pub env_allowlist: Vec<String>,
    pub workspace_access: WorkspaceAccess,
    pub timeout_ms: u64,
    #[serde(default, alias = "modelVisible")]
    pub requested_model_visible: bool,
    pub requested_trust_mode: SkillTrustMode,
    #[serde(default)]
    pub source_scope: SkillSourceScope,
    #[serde(default)]
    pub provenance: Option<SkillProvenance>,
    #[serde(default)]
    pub invocation_policy: InvocationPolicy,
    #[serde(default)]
    pub output_policy: SkillOutputPolicy,
    #[serde(default)]
    pub runtime: Option<SkillRuntimeDeclaration>,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub limits: Option<SkillLimitDeclaration>,
    #[serde(default)]
    pub risk: Option<SkillRiskDeclaration>,
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
            || self.invocation_policy.requires_user_decision()
    }

    pub fn effective_invocation_policy(&self) -> InvocationPolicy {
        match self.requested_trust_mode {
            SkillTrustMode::DirectHostScript => InvocationPolicy::Disabled,
            SkillTrustMode::BrokeredScript
                if self.invocation_policy == InvocationPolicy::ImplicitAllowed =>
            {
                InvocationPolicy::AskBeforeUse
            }
            _ => self.invocation_policy.clone(),
        }
    }

    pub fn effective_output_policy(&self) -> SkillOutputPolicy {
        if self.requested_trust_mode.requires_kernel_broker()
            && self.output_policy == SkillOutputPolicy::WorkspaceDirect
        {
            SkillOutputPolicy::TempOnly
        } else {
            self.output_policy.clone()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillManifestKind {
    Text,
    Declarative,
    BrokeredScript,
    DirectHostScript,
    WorkflowFragment,
}

impl Default for SkillManifestKind {
    fn default() -> Self {
        Self::Declarative
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSourceScope {
    Local,
    Workspace,
    Plugin,
    External,
}

impl Default for SkillSourceScope {
    fn default() -> Self {
        Self::Local
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProvenance {
    pub source: String,
    pub revision_hash: Option<String>,
    pub publisher: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvocationPolicy {
    ImplicitAllowed,
    AskBeforeUse,
    ManualOnly,
    Disabled,
}

impl InvocationPolicy {
    pub fn requires_user_decision(&self) -> bool {
        matches!(self, Self::AskBeforeUse | Self::ManualOnly | Self::Disabled)
    }
}

impl Default for InvocationPolicy {
    fn default() -> Self {
        Self::ImplicitAllowed
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillOutputPolicy {
    TextOnly,
    TempOnly,
    WorkspaceDirect,
}

impl Default for SkillOutputPolicy {
    fn default() -> Self {
        Self::TextOnly
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRuntimeDeclaration {
    pub runtime: String,
    pub adapter: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLimitDeclaration {
    pub timeout_ms: Option<u64>,
    pub stdout_limit_bytes: Option<usize>,
    pub stderr_limit_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRiskDeclaration {
    pub summary: Option<String>,
    pub declared_level: Option<String>,
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
            kind: SkillManifestKind::BrokeredScript,
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
            requested_model_visible: false,
            requested_trust_mode: trust_mode,
            source_scope: SkillSourceScope::Local,
            provenance: None,
            invocation_policy: InvocationPolicy::AskBeforeUse,
            output_policy: SkillOutputPolicy::TempOnly,
            runtime: None,
            resources: Vec::new(),
            limits: None,
            risk: None,
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
        manifest.kind = SkillManifestKind::Text;
        manifest.requested_capabilities.clear();
        manifest.effects.clear();
        manifest.workspace_access = WorkspaceAccess::None;
        manifest.invocation_policy = InvocationPolicy::ImplicitAllowed;
        manifest.output_policy = SkillOutputPolicy::TextOnly;
        assert!(manifest.v1_runtime_enabled());
        assert!(!manifest.requires_approval());
    }

    #[test]
    fn brokered_script_defaults_to_ask_and_temp_output() {
        let mut manifest = manifest(SkillTrustMode::BrokeredScript);
        manifest.invocation_policy = InvocationPolicy::ImplicitAllowed;
        manifest.output_policy = SkillOutputPolicy::WorkspaceDirect;

        assert_eq!(
            manifest.effective_invocation_policy(),
            InvocationPolicy::AskBeforeUse
        );
        assert_eq!(
            manifest.effective_output_policy(),
            SkillOutputPolicy::TempOnly
        );
    }
}
