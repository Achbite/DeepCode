use crate::{PermissionResourceKind, ToolOperationKind, ToolRiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryGrantEnvelope {
    pub id: String,
    pub contract_id: String,
    pub operation_ids: Vec<String>,
    pub capability: String,
    pub resource_kind: PermissionResourceKind,
    pub resource_path: Option<String>,
    pub expires_after_sequence: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionDecisionKind {
    Accept,
    Reject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionRequestKind {
    RuntimePermission,
    ScopeExpansion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEnvelope {
    pub id: String,
    pub request_kind: PermissionRequestKind,
    #[serde(default)]
    pub permission_bundle_id: Option<String>,
    #[serde(default)]
    pub contract_id: Option<String>,
    #[serde(default)]
    pub affected_operation_ids: Vec<String>,
    #[serde(default)]
    pub work_unit_ids: Vec<String>,
    #[serde(default)]
    pub tool_id: Option<String>,
    pub capability: String,
    pub risk_level: ToolRiskLevel,
    pub summary: String,
    pub args_preview: Value,
}

pub const PENDING_OPERATION_CHECKPOINT_SCHEMA_VERSION: &str =
    "deepcode.kernel.pending-operation-checkpoint.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperationCheckpointItem {
    pub operation_id: String,
    pub work_unit_id: String,
    pub tool_call_id: String,
    pub tool_id: String,
    pub args_hash: String,
    #[serde(default)]
    pub read_set: Vec<String>,
    #[serde(default)]
    pub write_set: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperationCheckpoint {
    pub schema_version: String,
    pub permission_id: String,
    pub permission_bundle_id: Option<String>,
    pub contract_id: String,
    pub contract_hash: String,
    pub request_id: String,
    pub plan_id: String,
    pub items: Vec<PendingOperationCheckpointItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestedFact {
    pub request: PermissionRequestEnvelope,
    pub checkpoint: PendingOperationCheckpoint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResolutionFact {
    pub permission_id: String,
    pub decision: PermissionDecisionKind,
    pub reason: Option<String>,
    pub work_unit_context: PermissionWorkUnitContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionWorkUnitContextItem {
    pub action_id: Option<String>,
    pub plan_id: Option<String>,
    pub work_unit_id: Option<String>,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionWorkUnitContext {
    pub action_id: Option<String>,
    pub plan_id: Option<String>,
    pub permission_bundle_id: Option<String>,
    pub contract_id: Option<String>,
    pub affected_operation_ids: Vec<String>,
    pub work_unit_ids: Vec<String>,
    pub group_items: Vec<PermissionWorkUnitContextItem>,
    pub operation_kind: ToolOperationKind,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
}
