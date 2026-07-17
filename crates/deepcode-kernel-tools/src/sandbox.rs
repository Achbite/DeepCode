use crate::SandboxSupportState;
use serde::{Deserialize, Serialize};

pub const SANDBOX_CAPABILITY_SCHEMA_VERSION: &str = "deepcode.kernel.sandbox-capability.v1";
pub const SANDBOX_SPEC_SCHEMA_VERSION: &str = "deepcode.kernel.sandbox-spec.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCapabilitySnapshot {
    pub schema_version: String,
    pub backend: String,
    pub support_state: SandboxSupportState,
    pub executable_path_ref: Option<String>,
    pub backend_version: Option<String>,
    pub platform: String,
    #[serde(default)]
    pub features: Vec<String>,
    pub probe_status: String,
    #[serde(default)]
    pub probe_diagnostics: Vec<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSandboxSpec {
    pub schema_version: String,
    pub run_id: String,
    pub contract_id: String,
    pub operation_id: String,
    pub work_unit_id: String,
    pub tool_id: String,
    pub executable: String,
    #[serde(default)]
    pub argv: Vec<String>,
    pub cwd_resource_ref: String,
    #[serde(default)]
    pub requested_read_refs: Vec<String>,
    #[serde(default)]
    pub writable_scratch_refs: Vec<String>,
    #[serde(default)]
    pub denied_resource_refs: Vec<String>,
    pub network_mode: String,
    #[serde(default)]
    pub env_allowlist: Vec<String>,
    pub timeout_ms: u64,
    pub output_limit_bytes: u64,
    pub cleanup_contract_ref: String,
    #[serde(default)]
    pub permission_bundle_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedSandboxPlan {
    pub schema_version: String,
    pub plan_id: String,
    pub plan_hash: String,
    pub run_id: String,
    pub contract_id: String,
    pub operation_id: String,
    pub work_unit_id: String,
    pub tool_id: String,
    pub executable: String,
    #[serde(default)]
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub read_only_mounts: Vec<String>,
    #[serde(default)]
    pub writable_scratch: Vec<String>,
    #[serde(default)]
    pub denied_roots: Vec<String>,
    pub network_mode: String,
    #[serde(default)]
    pub env_allowlist: Vec<String>,
    pub timeout_ms: u64,
    pub output_limit_bytes: u64,
    pub cleanup_contract_ref: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_contracts_use_stable_camel_case_shapes() {
        let candidate = CandidateSandboxSpec {
            schema_version: SANDBOX_SPEC_SCHEMA_VERSION.to_string(),
            run_id: "run-generic".to_string(),
            contract_id: "contract-generic".to_string(),
            operation_id: "operation-generic".to_string(),
            work_unit_id: "work-unit-generic".to_string(),
            tool_id: "process.exec".to_string(),
            executable: "/usr/bin/printf".to_string(),
            argv: vec!["printf".to_string(), "%s".to_string(), "ok".to_string()],
            cwd_resource_ref: "resource-root".to_string(),
            requested_read_refs: vec!["resource-root/source".to_string()],
            writable_scratch_refs: vec!["scratch-root".to_string()],
            denied_resource_refs: vec!["host-home".to_string()],
            network_mode: "deny".to_string(),
            env_allowlist: vec!["PATH".to_string()],
            timeout_ms: 1_000,
            output_limit_bytes: 4_096,
            cleanup_contract_ref: "cleanup-process".to_string(),
            permission_bundle_ids: vec!["permission-bundle".to_string()],
        };

        let value = serde_json::to_value(&candidate).expect("candidate serializes");
        assert_eq!(value["schemaVersion"], SANDBOX_SPEC_SCHEMA_VERSION);
        assert_eq!(value["cwdResourceRef"], "resource-root");
        assert_eq!(value["networkMode"], "deny");
        assert!(value.get("command").is_none());
        assert_eq!(
            serde_json::from_value::<CandidateSandboxSpec>(value).expect("candidate deserializes"),
            candidate
        );
    }

    #[test]
    fn sealed_plan_keeps_identity_and_resource_scope_explicit() {
        let plan = SealedSandboxPlan {
            schema_version: SANDBOX_SPEC_SCHEMA_VERSION.to_string(),
            plan_id: "sandbox-plan".to_string(),
            plan_hash: "sha256:generic".to_string(),
            run_id: "run-generic".to_string(),
            contract_id: "contract-generic".to_string(),
            operation_id: "operation-generic".to_string(),
            work_unit_id: "work-unit-generic".to_string(),
            tool_id: "process.exec".to_string(),
            executable: "/usr/bin/printf".to_string(),
            argv: vec!["printf".to_string(), "ok".to_string()],
            cwd: "/workspace".to_string(),
            read_only_mounts: vec!["/workspace".to_string()],
            writable_scratch: vec!["/tmp/work-unit".to_string()],
            denied_roots: vec!["/home".to_string()],
            network_mode: "deny".to_string(),
            env_allowlist: vec!["PATH".to_string()],
            timeout_ms: 1_000,
            output_limit_bytes: 4_096,
            cleanup_contract_ref: "cleanup-process".to_string(),
        };

        let value = serde_json::to_value(&plan).expect("sealed plan serializes");
        assert_eq!(value["planHash"], "sha256:generic");
        assert_eq!(value["readOnlyMounts"][0], "/workspace");
        assert_eq!(
            serde_json::from_value::<SealedSandboxPlan>(value).expect("plan deserializes"),
            plan
        );
    }
}
