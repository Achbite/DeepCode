use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub mod builtin;
pub mod executor;
pub mod external;
pub mod trust_record;

pub use executor::{SkillExecutionContext, SkillExecutor, SkillExecutorRegistry};
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProcessSkillSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env_allowlist: Vec<String>,
    pub timeout_ms: u64,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
}

impl ExternalProcessSkillSpec {
    pub fn python_inline(code: impl Into<String>) -> Self {
        Self {
            command: "python3".to_string(),
            args: vec!["-c".to_string(), code.into()],
            cwd: None,
            env_allowlist: Vec::new(),
            timeout_ms: 3_000,
            stdout_limit_bytes: 16 * 1024,
            stderr_limit_bytes: 16 * 1024,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExternalProcessSkillRuntime {
    spec: ExternalProcessSkillSpec,
}

impl ExternalProcessSkillRuntime {
    pub fn new(spec: ExternalProcessSkillSpec) -> Self {
        Self { spec }
    }
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
                "fs.delete",
                "skill.fs.delete.description",
                Capability::workspace_delete(),
                RiskLevel::Critical,
                vec![CapabilityEffect::DeletesWorkspace],
                vec!["complete"],
                false,
            ),
            builtin(
                "shell.exec",
                "skill.shell.exec.description",
                Capability::process_exec(),
                RiskLevel::High,
                vec![CapabilityEffect::RunsProcess],
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

impl SkillRuntime for ExternalProcessSkillRuntime {
    fn invoke(&self, invocation: SkillInvocation) -> KernelResult<SkillResult> {
        let mut args = self.spec.args.clone();
        if let Some(extra_args) = invocation.input.get("args").and_then(Value::as_array) {
            for arg in extra_args {
                let value = arg.as_str().ok_or_else(|| {
                    KernelError::InvalidCommand(
                        "external process skill args must be strings".to_string(),
                    )
                })?;
                args.push(value.to_string());
            }
        }

        let mut command = Command::new(&self.spec.command);
        command.args(args);
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.env_clear();
        for key in &self.spec.env_allowlist {
            if let Ok(value) = std::env::var(key) {
                command.env(key, value);
            }
        }
        if let Some(cwd) = &self.spec.cwd {
            command.current_dir(cwd);
        }

        let mut child = command.spawn().map_err(|error| {
            KernelError::Other(format!(
                "spawn external skill {}: {error}",
                self.spec.command
            ))
        })?;
        let deadline = Instant::now() + Duration::from_millis(self.spec.timeout_ms.max(1));
        let mut timed_out = false;

        loop {
            if child
                .try_wait()
                .map_err(|error| KernelError::Other(format!("poll external skill: {error}")))?
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                child
                    .kill()
                    .map_err(|error| KernelError::Other(format!("kill external skill: {error}")))?;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        let output = child.wait_with_output().map_err(|error| {
            KernelError::Other(format!("collect external skill output: {error}"))
        })?;
        let stdout = truncate_utf8(&output.stdout, self.spec.stdout_limit_bytes);
        let stderr = truncate_utf8(&output.stderr, self.spec.stderr_limit_bytes);
        let exit_code = output.status.code();
        let ok = output.status.success() && !timed_out;

        Ok(SkillResult {
            invocation_id: invocation.id,
            ok,
            output: serde_json::json!({
                "exitCode": exit_code,
                "timedOut": timed_out,
                "stdout": stdout,
                "stderr": stderr,
                "stdoutTruncated": output.stdout.len() > self.spec.stdout_limit_bytes,
                "stderrTruncated": output.stderr.len() > self.spec.stderr_limit_bytes
            }),
            error: (!ok).then(|| {
                if timed_out {
                    "external process skill timed out".to_string()
                } else {
                    format!("external process skill exited with {exit_code:?}")
                }
            }),
        })
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

fn truncate_utf8(bytes: &[u8], limit: usize) -> String {
    let limit = limit.min(bytes.len());
    String::from_utf8_lossy(&bytes[..limit]).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_catalog_contains_expected_tools() {
        let registry = InMemorySkillRegistry::with_builtin_tools();
        assert_eq!(registry.len(), 8);
        let write = registry.get("fs.write").unwrap().unwrap();
        assert_eq!(write.risk_level, RiskLevel::High);
        assert_eq!(
            write.primary_capability(),
            Some(Capability::workspace_write())
        );
        assert!(write.model_visible);

        let delete = registry.get("fs.delete").unwrap().unwrap();
        assert_eq!(delete.risk_level, RiskLevel::Critical);
        assert_eq!(
            delete.primary_capability(),
            Some(Capability::workspace_delete())
        );
        assert!(!delete.model_visible);
        assert!(delete.effects.contains(&CapabilityEffect::DeletesWorkspace));
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
            model_visible: false,
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

    #[test]
    fn external_process_skill_runs_python_under_kernel_control() {
        let runtime = ExternalProcessSkillRuntime::new(ExternalProcessSkillSpec::python_inline(
            "print('skill-ok')",
        ));

        let result = runtime
            .invoke(SkillInvocation {
                id: "invoke-python".to_string(),
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
