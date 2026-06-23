use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub mod builtin;
pub mod catalog;
pub mod executor;
pub mod external;
pub mod file_content;
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

    pub fn with_builtin_tools() -> Self {
        Self::new(vec![
            builtin(
                "fs.read",
                "skill.fs.read.description",
                Capability::workspace_read(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["plan", "check", "complete", "review"],
                true,
            ),
            builtin(
                "fs.list",
                "skill.fs.list.description",
                Capability::workspace_list(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["plan", "check", "complete", "review"],
                true,
            ),
            builtin(
                "fs.diff",
                "skill.fs.diff.description",
                Capability::workspace_preview_diff(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["plan", "check", "complete", "review"],
                true,
            ),
            builtin(
                "code.search",
                "skill.code.search.description",
                Capability::workspace_search(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["plan", "check", "complete", "review"],
                true,
            ),
            builtin(
                "shell.propose",
                "skill.shell.propose.description",
                Capability::process_propose(),
                RiskLevel::Medium,
                vec![CapabilityEffect::RunsProcess],
                vec!["plan", "complete"],
                true,
            ),
            builtin(
                "fs.write",
                "skill.fs.write.description",
                Capability::workspace_write(),
                RiskLevel::High,
                vec![CapabilityEffect::WritesWorkspace],
                vec!["complete"],
                true,
            ),
            builtin(
                "fs.patch",
                "skill.fs.patch.description",
                Capability::workspace_write(),
                RiskLevel::High,
                vec![CapabilityEffect::WritesWorkspace],
                vec!["complete"],
                true,
            ),
            builtin(
                "fs.delete",
                "skill.fs.delete.description",
                Capability::workspace_delete(),
                RiskLevel::Critical,
                vec![CapabilityEffect::DeletesWorkspace],
                vec!["complete"],
                true,
            ),
            builtin(
                "web.search",
                "skill.web.search.description",
                Capability::network_egress(),
                RiskLevel::High,
                vec![CapabilityEffect::UsesNetwork],
                vec!["complete"],
                true,
            ),
            builtin(
                "web.fetch",
                "skill.web.fetch.description",
                Capability::network_egress(),
                RiskLevel::High,
                vec![CapabilityEffect::UsesNetwork],
                vec!["complete"],
                true,
            ),
            builtin(
                "git.status",
                "skill.git.status.description",
                Capability::git_read(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsGit],
                vec!["plan", "check", "complete", "review"],
                true,
            ),
            builtin(
                "git.diff",
                "skill.git.diff.description",
                Capability::git_read(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsGit],
                vec!["plan", "check", "complete", "review"],
                true,
            ),
            builtin(
                "git.stage",
                "skill.git.stage.description",
                Capability::git_write(),
                RiskLevel::High,
                vec![CapabilityEffect::ModifiesGit],
                vec!["complete"],
                true,
            ),
            builtin(
                "git.unstage",
                "skill.git.unstage.description",
                Capability::git_write(),
                RiskLevel::High,
                vec![CapabilityEffect::ModifiesGit],
                vec!["complete"],
                true,
            ),
            builtin(
                "git.commit",
                "skill.git.commit.description",
                Capability::git_write(),
                RiskLevel::High,
                vec![CapabilityEffect::ModifiesGit],
                vec!["complete"],
                true,
            ),
            builtin(
                "git.push",
                "skill.git.push.description",
                Capability::git_push(),
                RiskLevel::Critical,
                vec![CapabilityEffect::PushesGit],
                vec!["complete"],
                true,
            ),
            builtin(
                "browser.open",
                "skill.browser.open.description",
                Capability::browser_control(),
                RiskLevel::High,
                vec![CapabilityEffect::ControlsBrowser],
                vec!["complete"],
                true,
            ),
            builtin(
                "browser.reload",
                "skill.browser.reload.description",
                Capability::browser_control(),
                RiskLevel::High,
                vec![CapabilityEffect::ControlsBrowser],
                vec!["complete"],
                true,
            ),
            builtin(
                "browser.snapshot",
                "skill.browser.snapshot.description",
                Capability::browser_control(),
                RiskLevel::High,
                vec![CapabilityEffect::ControlsBrowser],
                vec!["complete"],
                true,
            ),
            builtin(
                "browser.inspect",
                "skill.browser.inspect.description",
                Capability::browser_control(),
                RiskLevel::High,
                vec![CapabilityEffect::ControlsBrowser],
                vec!["complete"],
                true,
            ),
            builtin(
                "browser.click",
                "skill.browser.click.description",
                Capability::browser_control(),
                RiskLevel::High,
                vec![CapabilityEffect::ControlsBrowser],
                vec!["complete"],
                true,
            ),
            builtin(
                "browser.type",
                "skill.browser.type.description",
                Capability::browser_control(),
                RiskLevel::High,
                vec![CapabilityEffect::ControlsBrowser],
                vec!["complete"],
                true,
            ),
            builtin(
                "browser.scroll",
                "skill.browser.scroll.description",
                Capability::browser_control(),
                RiskLevel::High,
                vec![CapabilityEffect::ControlsBrowser],
                vec!["complete"],
                true,
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

pub(crate) fn builtin(
    id: &str,
    description_key: &str,
    capability: Capability,
    risk_level: RiskLevel,
    effects: Vec<CapabilityEffect>,
    allowed_phases: Vec<&str>,
    model_visible: bool,
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
        model_visible,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_catalog_contains_expected_tools() {
        let registry = InMemorySkillRegistry::with_builtin_tools();
        assert!(registry.len() >= 23);
        let removed_shell_exec_id = ["shell", "exec"].join(".");
        assert!(registry.get(&removed_shell_exec_id).unwrap().is_none());
        assert!(registry.get("process.exec").unwrap().is_none());
        let write = registry.get("fs.write").unwrap().unwrap();
        assert_eq!(write.risk_level, RiskLevel::High);
        assert_eq!(
            write.primary_capability(),
            Some(Capability::workspace_write())
        );
        assert!(write.model_visible);

        let patch = registry.get("fs.patch").unwrap().unwrap();
        assert_eq!(
            patch.primary_capability(),
            Some(Capability::workspace_write())
        );
        assert!(patch.effects.contains(&CapabilityEffect::WritesWorkspace));

        let delete = registry.get("fs.delete").unwrap().unwrap();
        assert_eq!(delete.risk_level, RiskLevel::Critical);
        assert_eq!(
            delete.primary_capability(),
            Some(Capability::workspace_delete())
        );
        assert!(delete.model_visible);
        assert!(delete.effects.contains(&CapabilityEffect::DeletesWorkspace));

        let web_fetch = registry.get("web.fetch").unwrap().unwrap();
        assert_eq!(
            web_fetch.primary_capability(),
            Some(Capability::network_egress())
        );
        assert!(web_fetch.effects.contains(&CapabilityEffect::UsesNetwork));

        let git_status = registry.get("git.status").unwrap().unwrap();
        assert_eq!(
            git_status.primary_capability(),
            Some(Capability::git_read())
        );
        assert!(git_status.effects.contains(&CapabilityEffect::ReadsGit));

        let browser_click = registry.get("browser.click").unwrap().unwrap();
        assert_eq!(
            browser_click.primary_capability(),
            Some(Capability::browser_control())
        );
        assert!(browser_click
            .effects
            .contains(&CapabilityEffect::ControlsBrowser));
    }

    #[test]
    fn unknown_skill_fails_closed() {
        let registry = InMemorySkillRegistry::with_builtin_tools();
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
        let runtime = ExternalProcessSkillRuntime::new(ExternalProcessSkillSpec::python_inline(
            "print('skill-ok')",
        ));

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
        let mut spec =
            ExternalProcessSkillSpec::python_inline("import time; time.sleep(3); print('late')");
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
        let mut spec = ExternalProcessSkillSpec::python_inline("print('abcdef')");
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
            builtin(
                "test.echo",
                "skill.test.echo.description",
                Capability::workspace_read(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["complete"],
                false,
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
                    skill_id: "test.echo".to_string(),
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
