use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel};
use deepcode_kernel_tools::{
    KernelToolTemplate, OperationExecutionMode, ToolFamily, ToolRiskLevel,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub mod catalog;
pub mod executor;
pub mod external;
pub mod hash;
pub mod manifest;
pub mod mcp;
pub mod plugin;
pub mod risk;
pub mod scanner;
pub mod trust_record;

pub use catalog::model_visible_skill_descriptors;
pub use executor::{SkillExecutionContext, SkillExecutor, SkillExecutorRegistry};
pub use external::broker::{
    brokered_script_process_invocation, capability_for_broker_method, BrokerRequestDecision,
    BrokeredScriptRequest, BrokeredScriptResponse, KernelBrokerAdapter, MissingKernelBrokerAdapter,
    PolicyScriptBroker, ScriptBroker, ScriptBrokerPolicy,
};
pub use external::supervisor::{
    CircuitBreakerPolicy, CwdScope, ExternalProcessSkillRuntime, ExternalProcessSkillSpec,
    NetworkPolicy, ProcessCircuitBreaker, ProcessExecutionPolicy, ProcessExecutionResult,
    ProcessInvocation, ProcessLifecycleEvent, ProcessLifecycleEventKind, ProcessSupervisor,
};
pub use manifest::{
    InvocationPolicy, SkillEntrypoint, SkillEntrypointKind, SkillLimitDeclaration, SkillManifest,
    SkillManifestKind, SkillOutputPolicy, SkillProvenance, SkillRiskDeclaration,
    SkillRuntimeDeclaration, SkillSourceScope, WorkspaceAccess,
};
pub use mcp::{
    mcp_stdio_tool_call_payload, mcp_tool_process_invocation,
    mcp_tool_projection_to_skill_invocation, model_visible_mcp_prompts,
    model_visible_mcp_prompts_for_revision, model_visible_mcp_resources,
    model_visible_mcp_resources_for_revision, model_visible_mcp_tools,
    model_visible_mcp_tools_for_revision, parse_mcp_stdio_tool_result, McpAuthDeclaration,
    McpConnectorDescriptor, McpConnectorManifest, McpDescriptorKind, McpPromptBinding,
    McpPromptDescriptor, McpPromptProjection, McpResourceBinding, McpResourceDescriptor,
    McpResourceProjection, McpRiskAcknowledgment, McpRiskAcknowledgmentRecord, McpServerIdentity,
    McpToolBinding, McpToolDescriptor, McpToolProjection, McpTransportDeclaration,
};
pub use plugin::{
    PluginBundleContents, PluginBundleManifest, PluginBundlePolicy, PluginRiskSummary,
};
pub use risk::{RiskFindingKind, SkillRiskFinding, SkillRiskReport};
pub use trust_record::{SkillTrustMode, SkillTrustRecord};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSource {
    Builtin,
    LocalPack { pack_id: String },
    ExternalProcess { program: String },
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
    pub model_visible: bool,
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
    pub run_id: Option<String>,
    pub session_id: Option<String>,
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

pub fn skill_descriptor_from_template(template: KernelToolTemplate) -> SkillDescriptor {
    let risk_level = match template.permission.risk {
        ToolRiskLevel::Low => RiskLevel::Low,
        ToolRiskLevel::Medium => RiskLevel::Medium,
        ToolRiskLevel::High => RiskLevel::High,
        ToolRiskLevel::Critical => RiskLevel::Critical,
    };
    let effects = match template.family {
        ToolFamily::Workspace | ToolFamily::Document if template.resource.read_only => {
            vec![CapabilityEffect::ReadsWorkspace]
        }
        ToolFamily::Workspace if template.tool_id == "fs.delete" => {
            vec![CapabilityEffect::DeletesWorkspace]
        }
        ToolFamily::Workspace => vec![CapabilityEffect::WritesWorkspace],
        ToolFamily::Git if template.resource.read_only => vec![CapabilityEffect::ReadsGit],
        ToolFamily::Git if template.tool_id == "git.push" => vec![CapabilityEffect::PushesGit],
        ToolFamily::Git => vec![CapabilityEffect::ModifiesGit],
        ToolFamily::Process => vec![CapabilityEffect::RunsProcess],
        ToolFamily::Network | ToolFamily::Provider => vec![CapabilityEffect::UsesNetwork],
        ToolFamily::Browser => vec![CapabilityEffect::ControlsBrowser],
        ToolFamily::Document => vec![CapabilityEffect::ReadsWorkspace],
    };
    let model_visible = template.execution.execution_mode != OperationExecutionMode::Blocked
        && template.tool_id != "fs.ensure_directory";
    SkillDescriptor {
        id: template.tool_id.to_string(),
        version: "1".to_string(),
        title_key: Some(format!("skill.{}.title", template.tool_id)),
        description_key: Some(format!("skill.{}.description", template.tool_id)),
        input_schema: template.input.schema,
        output_schema: serde_json::json!({ "type": "object" }),
        required_capabilities: vec![Capability::new(template.permission.capability)],
        allowed_phases: if template.resource.read_only {
            vec!["plan", "check", "complete", "review"]
        } else {
            vec!["complete"]
        }
        .into_iter()
        .map(str::to_string)
        .collect(),
        risk_level,
        effects,
        source: SkillSource::Builtin,
        executor_kind: SkillExecutorKind::Builtin,
        model_visible,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_skill_fails_closed() {
        let registry = InMemorySkillRegistry::default();
        let error = registry
            .invoke(SkillInvocation {
                id: "invoke-1".to_string(),
                run_id: None,
                session_id: None,
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
            model_visible: false,
        }]);

        let descriptor = registry.get("mcp.github.search").unwrap().unwrap();
        assert!(descriptor.is_external_connector());
        let error = registry
            .invoke(SkillInvocation {
                id: "invoke-1".to_string(),
                run_id: None,
                session_id: None,
                skill_id: "mcp.github.search".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({}),
            })
            .unwrap_err();
        assert!(matches!(error, KernelError::PermissionDenied(_)));
    }

    #[test]
    fn external_process_skill_runs_python_under_kernel_control() {
        let runtime = ExternalProcessSkillRuntime::new(
            ExternalProcessSkillSpec::test_python_inline("print('skill-ok')"),
        );

        let result = runtime
            .invoke(SkillInvocation {
                id: "invoke-python".to_string(),
                run_id: Some("run-1".to_string()),
                session_id: Some("session-1".to_string()),
                skill_id: "external.python.echo".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({}),
            })
            .unwrap();

        assert!(result.ok);
        assert_eq!(result.output["exitCode"], 0);
        assert_eq!(result.output["stdout"], "skill-ok\n");
    }

    #[test]
    fn external_process_skill_times_out_and_reports_exit_context() {
        let mut spec = ExternalProcessSkillSpec::test_python_inline(
            "import time; time.sleep(3); print('late')",
        );
        spec.timeout_ms = 50;
        let runtime = ExternalProcessSkillRuntime::new(spec);

        let result = runtime
            .invoke(SkillInvocation {
                id: "invoke-timeout".to_string(),
                run_id: Some("run-1".to_string()),
                session_id: Some("session-1".to_string()),
                skill_id: "external.python.timeout".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({}),
            })
            .unwrap();

        assert!(!result.ok);
        assert_eq!(result.output["timedOut"], true);
        assert!(result.error.unwrap().contains("timed out"));
    }

    #[test]
    fn external_process_skill_applies_output_limits() {
        let mut spec = ExternalProcessSkillSpec::test_python_inline("print('abcdef')");
        spec.stdout_limit_bytes = 3;
        let runtime = ExternalProcessSkillRuntime::new(spec);

        let result = runtime
            .invoke(SkillInvocation {
                id: "invoke-limit".to_string(),
                run_id: Some("run-1".to_string()),
                session_id: Some("session-1".to_string()),
                skill_id: "external.python.limit".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({}),
            })
            .unwrap();

        assert!(result.ok);
        assert_eq!(result.output["stdout"], "abc");
        assert_eq!(result.output["stdoutTruncated"], true);
    }

    #[derive(Debug)]
    struct EchoExecutor;

    impl SkillExecutor for EchoExecutor {
        fn descriptor(&self) -> SkillDescriptor {
            skill_descriptor_from_template(
                deepcode_kernel_tools::KernelToolRegistry::default()
                    .template("fs.read")
                    .unwrap(),
            )
        }

        fn invoke(
            &self,
            invocation: SkillInvocation,
            _context: SkillExecutionContext,
        ) -> KernelResult<SkillResult> {
            Ok(SkillResult {
                invocation_id: invocation.id,
                ok: true,
                output: invocation.input,
                error: None,
            })
        }
    }

    #[test]
    fn skill_executor_registry_fails_closed_for_direct_host_mode() {
        let mut registry = SkillExecutorRegistry::new();
        registry.register(Box::new(EchoExecutor));

        let error = registry
            .invoke(
                SkillInvocation {
                    id: "invoke-direct".to_string(),
                    run_id: Some("run-1".to_string()),
                    session_id: Some("session-1".to_string()),
                    skill_id: "fs.read".to_string(),
                    phase: Some("complete".to_string()),
                    input: serde_json::json!({}),
                },
                SkillExecutionContext {
                    run_id: Some("run-1".to_string()),
                    session_id: Some("session-1".to_string()),
                    trust_mode: SkillTrustMode::DirectHostScript,
                    approved_capabilities: Vec::new(),
                    workspace_root: None,
                },
            )
            .unwrap_err();

        assert!(matches!(error, KernelError::PermissionDenied(_)));
    }
}
