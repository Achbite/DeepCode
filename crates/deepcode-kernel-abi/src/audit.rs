use crate::{RunId, SessionId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQueryFilter {
    #[serde(default)]
    pub run_id: Option<RunId>,
    #[serde(default)]
    pub session_id: Option<SessionId>,
    #[serde(default)]
    pub contract_id: Option<String>,
    #[serde(default)]
    pub tool_id: Option<String>,
    #[serde(default)]
    pub after_sequence: Option<u64>,
    #[serde(default)]
    pub before_sequence: Option<u64>,
    #[serde(default = "default_audit_query_limit")]
    pub limit: u32,
}

fn default_audit_query_limit() -> u32 {
    100
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventFact {
    pub id: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub kind: String,
    pub sequence: Option<u64>,
    pub payload: Value,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQueryResult {
    pub filter: AuditQueryFilter,
    pub events: Vec<AuditEventFact>,
    pub truncated: bool,
    pub returned: usize,
}
