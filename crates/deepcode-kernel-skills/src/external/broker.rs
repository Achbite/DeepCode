use crate::external::supervisor::{
    CwdScope, NetworkPolicy, ProcessExecutionPolicy, ProcessInvocation,
};
use crate::{SkillEntrypointKind, SkillManifest, SkillTrustMode};
use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_policy::Capability;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokeredScriptRequest {
    pub request_id: String,
    pub invocation_id: String,
    pub capability: Capability,
    pub method: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokeredScriptResponse {
    pub request_id: String,
    pub ok: bool,
    pub output: Option<Value>,
    pub error: Option<String>,
}

pub trait ScriptBroker {
    fn dispatch(&self, request: BrokeredScriptRequest) -> BrokeredScriptResponse;
}

pub trait KernelBrokerAdapter {
    fn dispatch_authorized(
        &self,
        request: BrokeredScriptRequest,
        authorization: BrokerAuthorization,
    ) -> BrokeredScriptResponse;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerAuthorization {
    pub method: String,
    pub capability: Capability,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerRequestDecision {
    pub request_id: String,
    pub invocation_id: String,
    pub method: String,
    pub capability: Capability,
    pub authorized: bool,
    pub error: Option<String>,
}

impl BrokerRequestDecision {
    pub fn audit_projection(&self) -> Value {
        serde_json::json!({
            "requestId": self.request_id,
            "invocationId": self.invocation_id,
            "method": self.method,
            "capability": self.capability.0,
            "authorized": self.authorized,
            "error": self.error
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct ScriptBrokerPolicy {
    approved_capabilities: Vec<Capability>,
}

impl ScriptBrokerPolicy {
    pub fn new(approved_capabilities: Vec<Capability>) -> Self {
        Self {
            approved_capabilities,
        }
    }

    pub fn authorize(
        &self,
        request: &BrokeredScriptRequest,
    ) -> Result<BrokerAuthorization, String> {
        let expected = capability_for_broker_method(&request.method)
            .ok_or_else(|| format!("unsupported broker method {}", request.method))?;
        if request.capability != expected {
            return Err(format!(
                "broker request capability mismatch: method {} requires {} but request asked for {}",
                request.method, expected.0, request.capability.0
            ));
        }
        if !self.approved_capabilities.contains(&expected) {
            return Err(format!(
                "broker request requires unapproved capability {}",
                expected.0
            ));
        }
        Ok(BrokerAuthorization {
            method: request.method.clone(),
            capability: expected,
        })
    }

    pub fn evaluate(&self, request: &BrokeredScriptRequest) -> BrokerRequestDecision {
        match self.authorize(request) {
            Ok(_) => BrokerRequestDecision {
                request_id: request.request_id.clone(),
                invocation_id: request.invocation_id.clone(),
                method: request.method.clone(),
                capability: request.capability.clone(),
                authorized: true,
                error: None,
            },
            Err(error) => BrokerRequestDecision {
                request_id: request.request_id.clone(),
                invocation_id: request.invocation_id.clone(),
                method: request.method.clone(),
                capability: request.capability.clone(),
                authorized: false,
                error: Some(error),
            },
        }
    }
}

pub fn capability_for_broker_method(method: &str) -> Option<Capability> {
    match method {
        "kernel.fs.read" => Some(Capability::workspace_read()),
        "kernel.fs.write" => Some(Capability::workspace_write()),
        "kernel.code.search" => Some(Capability::workspace_search()),
        "kernel.network.fetch" => Some(Capability::network_egress()),
        "kernel.secret.read" => Some(Capability::secret_read()),
        "kernel.shell.exec" => Some(Capability::process_exec()),
        "kernel.context.attach" => Some(Capability::workspace_read()),
        "kernel.temp.create" => Some(Capability::workspace_create()),
        _ => None,
    }
}

pub fn brokered_script_process_invocation(
    manifest: &SkillManifest,
    invocation_id: impl Into<String>,
    run_id: Option<String>,
    session_id: Option<String>,
    skill_root: &Path,
    stdin_payload: Option<String>,
    env: Vec<(String, String)>,
) -> KernelResult<ProcessInvocation> {
    if manifest.requested_trust_mode != SkillTrustMode::BrokeredScript {
        return Err(KernelError::PermissionDenied(
            "only BrokeredScript skills can create brokered script process invocations".to_string(),
        ));
    }
    if manifest.entrypoint.kind != SkillEntrypointKind::Script
        && manifest.entrypoint.kind != SkillEntrypointKind::ExternalProcess
    {
        return Err(KernelError::InvalidCommand(
            "brokered script skill requires a script or external process entrypoint".to_string(),
        ));
    }
    let command = manifest.entrypoint.command.clone().ok_or_else(|| {
        KernelError::InvalidCommand("brokered script entrypoint command is required".to_string())
    })?;
    let mut process_command = vec![command];
    process_command.extend(manifest.entrypoint.args.clone());
    let skill_root = skill_root.to_string_lossy().replace('\\', "/");
    Ok(ProcessInvocation {
        invocation_id: invocation_id.into(),
        run_id,
        session_id,
        skill_id: Some(manifest.skill_id.clone()),
        connector_id: None,
        command: process_command,
        cwd: Some(skill_root.clone()),
        env,
        stdin_payload,
        policy: ProcessExecutionPolicy {
            timeout_ms: manifest.timeout_ms,
            max_stdout_bytes: manifest
                .limits
                .as_ref()
                .and_then(|limits| limits.stdout_limit_bytes)
                .unwrap_or(16 * 1024),
            max_stderr_bytes: manifest
                .limits
                .as_ref()
                .and_then(|limits| limits.stderr_limit_bytes)
                .unwrap_or(16 * 1024),
            env_allowlist: manifest.env_allowlist.clone(),
            cwd_scope: CwdScope::Fixed { path: skill_root },
            network_policy: NetworkPolicy::Deny,
        },
    })
}

#[derive(Debug, Default)]
pub struct DisabledScriptBroker;

impl ScriptBroker for DisabledScriptBroker {
    fn dispatch(&self, request: BrokeredScriptRequest) -> BrokeredScriptResponse {
        BrokeredScriptResponse {
            request_id: request.request_id,
            ok: false,
            output: None,
            error: Some("script broker has no runtime adapter attached".to_string()),
        }
    }
}

#[derive(Debug)]
pub struct PolicyScriptBroker<A> {
    policy: ScriptBrokerPolicy,
    adapter: A,
}

impl<A> PolicyScriptBroker<A> {
    pub fn new(policy: ScriptBrokerPolicy, adapter: A) -> Self {
        Self { policy, adapter }
    }
}

impl<A> ScriptBroker for PolicyScriptBroker<A>
where
    A: KernelBrokerAdapter,
{
    fn dispatch(&self, request: BrokeredScriptRequest) -> BrokeredScriptResponse {
        let authorization = match self.policy.authorize(&request) {
            Ok(authorization) => authorization,
            Err(error) => {
                return BrokeredScriptResponse {
                    request_id: request.request_id,
                    ok: false,
                    output: None,
                    error: Some(error),
                };
            }
        };
        self.adapter.dispatch_authorized(request, authorization)
    }
}

#[derive(Debug, Default)]
pub struct MissingKernelBrokerAdapter;

impl KernelBrokerAdapter for MissingKernelBrokerAdapter {
    fn dispatch_authorized(
        &self,
        request: BrokeredScriptRequest,
        _authorization: BrokerAuthorization,
    ) -> BrokeredScriptResponse {
        BrokeredScriptResponse {
            request_id: request.request_id,
            ok: false,
            output: None,
            error: Some("kernel broker adapter is not attached".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_broker_fails_closed() {
        let broker = DisabledScriptBroker;
        let response = broker.dispatch(BrokeredScriptRequest {
            request_id: "broker-1".to_string(),
            invocation_id: "invoke-1".to_string(),
            capability: Capability::workspace_read(),
            method: "kernel.fs.read".to_string(),
            arguments: serde_json::json!({ "path": "README.md" }),
        });

        assert!(!response.ok);
        assert_eq!(response.request_id, "broker-1");
        assert!(response.error.unwrap().contains("no runtime adapter"));
    }

    #[test]
    fn broker_policy_authorizes_only_declared_methods_and_capabilities() {
        let policy = ScriptBrokerPolicy::new(vec![Capability::workspace_read()]);
        let request = BrokeredScriptRequest {
            request_id: "broker-1".to_string(),
            invocation_id: "invoke-1".to_string(),
            capability: Capability::workspace_read(),
            method: "kernel.fs.read".to_string(),
            arguments: serde_json::json!({ "path": "README.md" }),
        };

        let authorization = policy.authorize(&request).unwrap();
        assert_eq!(authorization.capability, Capability::workspace_read());

        let mut write_request = request.clone();
        write_request.method = "kernel.fs.write".to_string();
        write_request.capability = Capability::workspace_write();
        let error = policy.authorize(&write_request).unwrap_err();
        assert!(error.contains("unapproved capability"));
    }

    #[test]
    fn broker_policy_rejects_capability_mismatch() {
        let policy = ScriptBrokerPolicy::new(vec![Capability::workspace_read()]);
        let request = BrokeredScriptRequest {
            request_id: "broker-1".to_string(),
            invocation_id: "invoke-1".to_string(),
            capability: Capability::workspace_write(),
            method: "kernel.fs.read".to_string(),
            arguments: serde_json::json!({ "path": "README.md" }),
        };

        let error = policy.authorize(&request).unwrap_err();
        assert!(error.contains("capability mismatch"));
    }

    #[test]
    fn broker_policy_produces_redacted_audit_projection() {
        let policy = ScriptBrokerPolicy::new(vec![Capability::workspace_read()]);
        let request = BrokeredScriptRequest {
            request_id: "broker-1".to_string(),
            invocation_id: "invoke-1".to_string(),
            capability: Capability::workspace_read(),
            method: "kernel.fs.read".to_string(),
            arguments: serde_json::json!({ "path": "secret.txt" }),
        };

        let decision = policy.evaluate(&request);
        assert!(decision.authorized);
        let audit = decision.audit_projection();
        assert_eq!(audit["method"], "kernel.fs.read");
        assert_eq!(audit["capability"], "fs.read");
        assert!(audit.get("arguments").is_none());
    }

    #[test]
    fn policy_script_broker_requires_policy_before_adapter() {
        let broker = PolicyScriptBroker::new(
            ScriptBrokerPolicy::new(vec![Capability::workspace_read()]),
            MissingKernelBrokerAdapter,
        );
        let response = broker.dispatch(BrokeredScriptRequest {
            request_id: "broker-1".to_string(),
            invocation_id: "invoke-1".to_string(),
            capability: Capability::workspace_write(),
            method: "kernel.fs.write".to_string(),
            arguments: serde_json::json!({ "path": "out.txt", "content": "x" }),
        });

        assert!(!response.ok);
        assert!(response.error.unwrap().contains("unapproved capability"));
    }

    #[test]
    fn brokered_script_process_invocation_requires_brokered_trust_mode() {
        let mut manifest = SkillManifest {
            schema_version: 1,
            skill_id: "skill.test".to_string(),
            version: "1".to_string(),
            title: "Test".to_string(),
            description: None,
            kind: crate::SkillManifestKind::BrokeredScript,
            entrypoint: crate::SkillEntrypoint {
                kind: SkillEntrypointKind::Script,
                command: Some("python3".to_string()),
                args: vec!["skill.py".to_string()],
                script_path: Some("skill.py".to_string()),
            },
            requested_capabilities: vec![Capability::workspace_read()],
            effects: Vec::new(),
            env_allowlist: Vec::new(),
            workspace_access: crate::WorkspaceAccess::ReadOnly,
            timeout_ms: 1_000,
            requested_model_visible: false,
            requested_trust_mode: SkillTrustMode::Declarative,
            source_scope: crate::SkillSourceScope::Local,
            provenance: None,
            invocation_policy: crate::InvocationPolicy::AskBeforeUse,
            output_policy: crate::SkillOutputPolicy::TempOnly,
            runtime: None,
            resources: Vec::new(),
            limits: None,
            risk: None,
        };
        let error = brokered_script_process_invocation(
            &manifest,
            "invoke-1",
            Some("run-1".to_string()),
            Some("session-1".to_string()),
            Path::new("/workspace/skill"),
            None,
            Vec::new(),
        )
        .unwrap_err();
        assert!(matches!(error, KernelError::PermissionDenied(_)));

        manifest.requested_trust_mode = SkillTrustMode::BrokeredScript;
        let invocation = brokered_script_process_invocation(
            &manifest,
            "invoke-1",
            Some("run-1".to_string()),
            Some("session-1".to_string()),
            Path::new("/workspace/skill"),
            Some("{}".to_string()),
            Vec::new(),
        )
        .unwrap();
        assert_eq!(invocation.run_id.as_deref(), Some("run-1"));
        assert_eq!(invocation.session_id.as_deref(), Some("session-1"));
        assert_eq!(invocation.command, vec!["python3", "skill.py"]);
        assert_eq!(invocation.policy.network_policy, NetworkPolicy::Deny);
    }
}
