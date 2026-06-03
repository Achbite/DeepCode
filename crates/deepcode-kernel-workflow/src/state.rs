use crate::outcome::{ObservationRef, WorkflowError, WorkflowOutcomeKind};
use crate::phase::{WorkflowPhase, WorkflowRunStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    pub session_id: String,
    pub phase: WorkflowPhase,
    pub status: WorkflowRunStatus,
    pub iteration: u32,
    pub max_iterations: u32,
    pub current_plan_id: Option<String>,
    pub observations: Vec<ObservationRef>,
    pub pending_permission_id: Option<String>,
    pub last_outcome_kind: Option<WorkflowOutcomeKind>,
    pub last_error: Option<WorkflowError>,
}

impl WorkflowState {
    pub fn initial(session_id: impl Into<String>, max_iterations: u32) -> Self {
        Self {
            session_id: session_id.into(),
            phase: WorkflowPhase::Plan,
            status: WorkflowRunStatus::Running,
            iteration: 0,
            max_iterations,
            current_plan_id: None,
            observations: Vec::new(),
            pending_permission_id: None,
            last_outcome_kind: None,
            last_error: None,
        }
    }

    pub fn is_terminal(&self) -> bool {
        self.phase.is_terminal()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTransition {
    pub id: String,
    pub session_id: String,
    pub from: WorkflowPhase,
    pub to: WorkflowPhase,
    pub outcome_kind: WorkflowOutcomeKind,
    pub reason: Option<String>,
    pub iteration: u32,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTransitionResult {
    pub state: WorkflowState,
    pub transition: WorkflowTransition,
}
