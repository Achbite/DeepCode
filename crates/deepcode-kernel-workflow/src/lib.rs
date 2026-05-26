use deepcode_kernel_abi::KernelResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPhase(pub String);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOutcome {
    pub kind: String,
    pub summary: Option<String>,
    pub evidence: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTransition {
    pub id: String,
    pub from: WorkflowPhase,
    pub to: WorkflowPhase,
    pub reason: Option<String>,
}

pub trait WorkflowMachine {
    fn transition(
        &self,
        current: WorkflowPhase,
        outcome: WorkflowOutcome,
    ) -> KernelResult<WorkflowTransition>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkUnitScopeKind {
    File,
    Directory,
    Range,
    DocSection,
    Symbol,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitOwner {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnit {
    pub id: String,
    pub run_id: String,
    pub scope_kind: WorkUnitScopeKind,
    pub path: String,
    pub owner: Option<WorkUnitOwner>,
    pub change_set_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub id: String,
    pub run_id: String,
    pub touched_files: Vec<String>,
    pub source_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub id: String,
    pub ok: bool,
    pub kind: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGateResult {
    pub id: String,
    pub status: String,
    pub summary: String,
    pub evidence: Vec<Value>,
}
