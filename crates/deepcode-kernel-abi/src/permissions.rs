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
    pub capability: String,
    pub risk_level: String,
    pub summary: String,
    pub args_preview: Value,
}
