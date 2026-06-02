use crate::{ConfigSnapshotRef, PermissionRequestEnvelope, RunId, SessionId, WorkspaceBinding};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelSnapshot {
    pub session_id: Option<SessionId>,
    pub run_id: Option<RunId>,
    pub workspace_binding: Option<WorkspaceBinding>,
    pub config_ref: Option<ConfigSnapshotRef>,
    pub workflow_phase: Option<String>,
    pub pending_stage: Option<String>,
    pub events: Vec<KernelEventSummary>,
    pub pending_permission: Option<PermissionRequestEnvelope>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelEventSummary {
    pub id: Option<String>,
    pub kind: String,
    pub sequence: Option<u64>,
    pub summary: Option<String>,
}
