use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSource {
    Builtin,
    LocalPack { pack_id: String },
    ExternalProcess { command: String },
    ExternalConnector { connector_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillExecutorKind {
    Builtin,
    LocalPack,
    ExternalProcess,
    ExternalConnector,
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
    pub executor_kind: SkillExecutorKind,
}

impl SkillDescriptor {
    pub fn primary_capability(&self) -> Option<Capability> {
        self.required_capabilities.first().cloned()
    }

    pub fn is_external_connector(&self) -> bool {
        matches!(self.source, SkillSource::ExternalConnector { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInvocation {
    pub id: String,
    pub skill_id: String,
    pub phase: Option<String>,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResult {
    pub invocation_id: String,
    pub ok: bool,
    pub output: Value,
    pub error: Option<String>,
}

pub trait SkillRegistry {
    fn list(&self) -> KernelResult<Vec<SkillDescriptor>>;
    fn get(&self, skill_id: &str) -> KernelResult<Option<SkillDescriptor>>;
}

pub trait SkillRuntime {
    fn invoke(&self, invocation: SkillInvocation) -> KernelResult<SkillResult>;
}

#[derive(Debug, Clone, Default)]
pub struct InMemorySkillRegistry {
    descriptors: BTreeMap<String, SkillDescriptor>,
}

impl InMemorySkillRegistry {
    pub fn new(descriptors: Vec<SkillDescriptor>) -> Self {
        Self {
            descriptors: descriptors
                .into_iter()
                .map(|descriptor| (descriptor.id.clone(), descriptor))
                .collect(),
        }
    }

    pub fn with_builtin_tools() -> Self {
        Self::new(vec![
            builtin(
                "fs.read",
                "skill.fs.read.description",
                Capability::workspace_read(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["plan", "check", "complete", "review"],
            ),
            builtin(
                "fs.list",
                "skill.fs.list.description",
                Capability::workspace_list(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["plan", "check", "complete", "review"],
            ),
            builtin(
                "fs.diff",
                "skill.fs.diff.description",
                Capability::workspace_preview_diff(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["plan", "check", "complete", "review"],
            ),
            builtin(
                "code.search",
                "skill.code.search.description",
                Capability::workspace_search(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["plan", "check", "complete", "review"],
            ),
            builtin(
                "shell.propose",
                "skill.shell.propose.description",
                Capability::process_propose(),
                RiskLevel::Medium,
                vec![CapabilityEffect::RunsProcess],
                vec!["plan", "complete"],
            ),
            builtin(
                "fs.write",
                "skill.fs.write.description",
                Capability::workspace_write(),
                RiskLevel::High,
                vec![CapabilityEffect::WritesWorkspace],
                vec!["complete"],
            ),
            builtin(
                "shell.exec",
                "skill.shell.exec.description",
                Capability::process_exec(),
                RiskLevel::High,
                vec![CapabilityEffect::RunsProcess],
                vec!["complete"],
            ),
        ])
    }

    pub fn len(&self) -> usize {
        self.descriptors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.descriptors.is_empty()
    }
}

impl SkillRegistry for InMemorySkillRegistry {
    fn list(&self) -> KernelResult<Vec<SkillDescriptor>> {
        Ok(self.descriptors.values().cloned().collect())
    }

    fn get(&self, skill_id: &str) -> KernelResult<Option<SkillDescriptor>> {
        Ok(self.descriptors.get(skill_id).cloned())
    }
}

impl SkillRuntime for InMemorySkillRegistry {
    fn invoke(&self, invocation: SkillInvocation) -> KernelResult<SkillResult> {
        let descriptor = self.get(&invocation.skill_id)?.ok_or_else(|| {
            KernelError::PermissionDenied(format!("unknown skill {}", invocation.skill_id))
        })?;

        if descriptor.is_external_connector() {
            return Err(KernelError::PermissionDenied(
                "external connector skills require an adapter and policy gate".to_string(),
            ));
        }

        Err(KernelError::NotImplemented("skill.invoke"))
    }
}

fn builtin(
    id: &str,
    description_key: &str,
    capability: Capability,
    risk_level: RiskLevel,
    effects: Vec<CapabilityEffect>,
    allowed_phases: Vec<&str>,
) -> SkillDescriptor {
    SkillDescriptor {
        id: id.to_string(),
        version: "1".to_string(),
        title_key: Some(format!("skill.{id}.title")),
        description_key: Some(description_key.to_string()),
        input_schema: serde_json::json!({ "type": "object" }),
        output_schema: serde_json::json!({ "type": "object" }),
        required_capabilities: vec![capability],
        allowed_phases: allowed_phases.into_iter().map(str::to_string).collect(),
        risk_level,
        effects,
        source: SkillSource::Builtin,
        executor_kind: SkillExecutorKind::Builtin,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_catalog_contains_expected_tools() {
        let registry = InMemorySkillRegistry::with_builtin_tools();
        assert_eq!(registry.len(), 7);
        let write = registry.get("fs.write").unwrap().unwrap();
        assert_eq!(write.risk_level, RiskLevel::High);
        assert_eq!(
            write.primary_capability(),
            Some(Capability::workspace_write())
        );
    }

    #[test]
    fn unknown_skill_fails_closed() {
        let registry = InMemorySkillRegistry::with_builtin_tools();
        let error = registry
            .invoke(SkillInvocation {
                id: "invoke-1".to_string(),
                skill_id: "missing".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({}),
            })
            .unwrap_err();

        assert!(matches!(error, KernelError::PermissionDenied(_)));
    }

    #[test]
    fn external_connector_skill_is_descriptor_only_without_adapter() {
        let registry = InMemorySkillRegistry::new(vec![SkillDescriptor {
            id: "mcp.github.search".to_string(),
            version: "1".to_string(),
            title_key: None,
            description_key: None,
            input_schema: serde_json::json!({ "type": "object" }),
            output_schema: serde_json::json!({ "type": "object" }),
            required_capabilities: vec![Capability::network_egress()],
            allowed_phases: vec!["complete".to_string()],
            risk_level: RiskLevel::High,
            effects: vec![CapabilityEffect::UsesNetwork],
            source: SkillSource::ExternalConnector {
                connector_id: "mcp.github".to_string(),
            },
            executor_kind: SkillExecutorKind::ExternalConnector,
        }]);

        let descriptor = registry.get("mcp.github.search").unwrap().unwrap();
        assert!(descriptor.is_external_connector());
        let error = registry
            .invoke(SkillInvocation {
                id: "invoke-1".to_string(),
                skill_id: "mcp.github.search".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({}),
            })
            .unwrap_err();
        assert!(matches!(error, KernelError::PermissionDenied(_)));
    }
}
