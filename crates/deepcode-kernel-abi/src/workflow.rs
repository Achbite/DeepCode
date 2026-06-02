use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowDecisionAction {
    Continue,
    AwaitPermission,
    Replan,
    Review,
    Done,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowDecisionReason {
    EventAccepted,
    AwaitingPermission,
    PermissionRejected,
    PendingCriticalSteps,
    CompletionCriteriaSatisfied,
    AnswerObligationsSatisfied,
    ToolFailed,
    KernelUnableToDecide,
    FailClosed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnswerObligationId {
    Identity,
    ToolComponentSummary,
    TempFileLifecycleResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnswerObligationStatus {
    Pending,
    Satisfied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerObligation {
    pub id: AnswerObligationId,
    pub description: String,
    pub status: AnswerObligationStatus,
    pub satisfied_by_event: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDecision {
    pub action: WorkflowDecisionAction,
    pub reason: WorkflowDecisionReason,
    pub phase: Option<String>,
    pub pending_steps: Vec<String>,
    pub answer_obligations: Vec<AnswerObligation>,
    pub summary: Option<String>,
    pub fail_closed: bool,
}
