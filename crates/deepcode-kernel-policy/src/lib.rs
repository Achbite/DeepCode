use deepcode_kernel_abi::KernelResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityEffect {
    ReadsWorkspace,
    WritesWorkspace,
    RunsProcess,
    UsesNetwork,
    ReadsSecret,
    ModifiesGit,
    ModifiesKernel,
    ModifiesConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicyDecisionKind {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyProfile {
    pub id: String,
    pub capabilities: Vec<Capability>,
    pub default_decision: PolicyDecisionKind,
    pub rules: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub capability: Capability,
    pub risk_level: RiskLevel,
    pub summary: String,
    pub args_preview: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub decision: PolicyDecisionKind,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub request_id: String,
    pub decision: PolicyDecisionKind,
    pub reason: Option<String>,
}

pub trait PermissionGate {
    fn evaluate(
        &self,
        profile: &PolicyProfile,
        request: &PermissionRequest,
    ) -> KernelResult<PolicyDecision>;
}
