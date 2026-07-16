use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitFact {
    pub kind: String,
    pub sequence: Option<u64>,
    pub work_unit_id: Option<String>,
    pub work_unit: Option<Value>,
    pub summary: Option<String>,
    pub error: Option<Value>,
    pub reason: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFactEnvelope {
    pub kind: String,
    pub sequence: Option<u64>,
    pub tool_call_id: Option<String>,
    pub tool_id: String,
    pub fact_kind: String,
    pub untrusted_evidence: bool,
    pub ok: bool,
    pub output: Option<Value>,
    pub error: Option<Value>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFacts {
    pub facts_ref: String,
    pub run_id: String,
    pub event_count: usize,
    pub work_units: Vec<WorkUnitFact>,
    pub queued_work_units: Vec<WorkUnitFact>,
    pub started_work_units: Vec<WorkUnitFact>,
    pub completed_work_units: Vec<WorkUnitFact>,
    pub failed_work_units: Vec<WorkUnitFact>,
    pub blocked_work_units: Vec<WorkUnitFact>,
    pub awaiting_permissions: Vec<Value>,
    pub tool_results: Vec<ToolFactEnvelope>,
    pub git_facts: Vec<ToolFactEnvelope>,
    pub written_files: Vec<Value>,
    pub created_files: Vec<Value>,
    pub deleted_files: Vec<Value>,
    pub renamed_files: Vec<Value>,
    pub patch_changed_ranges: Vec<Value>,
    pub generated_artifacts: Vec<Value>,
    pub resource_events: Vec<Value>,
    pub cleanup_failures: Vec<Value>,
    pub path_normalization_diagnostics: Vec<Value>,
    pub batch_review_ready: bool,
}
