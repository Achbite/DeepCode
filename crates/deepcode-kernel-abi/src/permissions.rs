use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryGrantEnvelope {
    pub id: String,
    pub capability: String,
    pub resource_kind: String,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEnvelope {
    pub id: String,
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
    pub risk_level: String,
    pub summary: String,
    pub args_preview: Value,
}
