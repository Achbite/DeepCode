use crate::{RunId, SessionId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TASK_INTENT_SCHEMA_VERSION: &str = "deepcode.kernel.task-intent.v2";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIntentTask {
    pub task_id: String,
    pub tool_id: String,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIntentEnvelope {
    pub schema_version: String,
    pub plan_id: String,
    pub plan_hash: String,
    pub run_id: RunId,
    pub session_id: Option<SessionId>,
    pub workspace_binding_hash: Option<String>,
    pub catalog_version: String,
    pub catalog_hash: String,
    pub tasks: Vec<TaskIntentTask>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanAuthorizationStatus {
    Confirmable,
    NeedsRevision,
    Denied,
    Accepted,
    Rejected,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelPlanAuthorizationOperation {
    pub id: String,
    pub source_task_id: String,
    pub tool_id: String,
    pub operation_kind: String,
    pub content_mode: String,
    pub targets: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub fixed_args: Value,
    pub args_template: Value,
    pub target_kind: Option<String>,
    pub recursive: Option<bool>,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub conflict_keys: Vec<String>,
    pub execution_mode: String,
    pub internal: bool,
    pub parent_operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelPlanPermissionBundle {
    pub id: String,
    pub capability: String,
    pub permission_mode: String,
    pub risk: String,
    pub resource_kind: String,
    pub operation_ids: Vec<String>,
    pub tool_ids: Vec<String>,
    pub targets: Vec<String>,
    pub expires_after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelPlanGateIntervention {
    pub id: String,
    pub intervention_kind: String,
    pub status: String,
    pub permission_bundle_id: Option<String>,
    pub affected_operation_ids: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelPlanAuthorizationContract {
    pub id: String,
    pub plan_id: String,
    pub plan_hash: String,
    pub status: PlanAuthorizationStatus,
    pub workspace_binding_hash: Option<String>,
    pub catalog_version: String,
    pub catalog_hash: String,
    pub operation_set_hash: String,
    pub contract_hash: String,
    pub operations: Vec<KernelPlanAuthorizationOperation>,
    pub permission_bundles: Vec<KernelPlanPermissionBundle>,
    pub interventions: Vec<KernelPlanGateIntervention>,
    pub cleanup_policy: String,
    pub expires_after: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAuthorizationReview {
    pub plan_id: String,
    pub status: PlanAuthorizationStatus,
    pub diagnostics: Vec<String>,
    pub authorization_contract: KernelPlanAuthorizationContract,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanAuthorizationDecisionKind {
    Accept,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAuthorizationDecisionSubmit {
    pub decision_id: String,
    pub authorization_contract_id: String,
    pub plan_id: String,
    pub plan_hash: String,
    pub contract_hash: String,
    pub decision: PlanAuthorizationDecisionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanGrantLease {
    pub id: String,
    pub authorization_contract_id: String,
    pub run_id: RunId,
    pub session_id: SessionId,
    pub plan_id: String,
    pub plan_hash: String,
    pub contract_hash: String,
    pub workspace_binding_hash: Option<String>,
    pub catalog_version: String,
    pub permission_bundle_ids: Vec<String>,
    pub operation_ids: Vec<String>,
    pub active: bool,
}
