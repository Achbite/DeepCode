use serde::{Deserialize, Serialize};

pub const PRIVATE_ANALYSIS_PROJECTION_SCHEMA_V1: &str =
    "deepcode.session.private-analysis-projection.v1";
pub const PRIVATE_ANALYSIS_LEASE_SCHEMA_V1: &str = "deepcode.session.private-analysis-lease.v1";
pub const PRIVATE_ANALYSIS_LEASE_HEADER_V1: &str = "x-deepcode-private-analysis-lease";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateAnalysisLeaseRequestV1 {
    pub caller_request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateAnalysisLeaseReceiptV1 {
    pub schema_version: String,
    pub session_id: String,
    pub capability: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateAnalysisToolV1 {
    pub name: String,
    pub stage: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateAnalysisItemV1 {
    pub analysis_id: String,
    pub request_id: String,
    pub provider_turn_id: String,
    pub run_id: String,
    pub user_turn_id: String,
    pub boundary: PrivateAnalysisBoundaryV1,
    pub started_at_unix_ms: String,
    pub completed_at_unix_ms: String,
    pub status: PrivateAnalysisStatusV1,
    #[serde(default)]
    pub reason_code: Option<String>,
    #[serde(default)]
    pub reasoning: String,
    pub tools: Vec<PrivateAnalysisToolV1>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivateAnalysisBoundaryV1 {
    Primary,
    Continuation,
    FinalAnswer,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivateAnalysisStatusV1 {
    Completed,
    Failed,
    Cancelled,
    LimitExceeded,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateAnalysisProjectionV1 {
    pub schema_version: String,
    pub session_id: String,
    #[serde(default)]
    pub after_cursor: Option<String>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub items: Vec<PrivateAnalysisItemV1>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateAnalysisRevokeReceiptV1 {
    pub schema_version: String,
    pub session_id: String,
    pub revoked: bool,
}
