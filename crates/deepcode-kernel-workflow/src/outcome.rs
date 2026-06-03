use crate::phase::ReplanReason;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowOutcomeKind {
    #[serde(rename = "plan.proposed")]
    PlanProposed,
    #[serde(rename = "plan.needs_user_input")]
    PlanNeedsUserInput,
    #[serde(rename = "check.accepted")]
    CheckAccepted,
    #[serde(rename = "check.rejected")]
    CheckRejected,
    #[serde(rename = "complete.progress")]
    CompleteProgress,
    #[serde(rename = "complete.done")]
    CompleteDone,
    #[serde(rename = "complete.blocked")]
    CompleteBlocked,
    #[serde(rename = "permission.approved")]
    PermissionApproved,
    #[serde(rename = "permission.rejected")]
    PermissionRejected,
    #[serde(rename = "review.accepted")]
    ReviewAccepted,
    #[serde(rename = "review.rejected")]
    ReviewRejected,
}

impl WorkflowOutcomeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PlanProposed => "plan.proposed",
            Self::PlanNeedsUserInput => "plan.needs_user_input",
            Self::CheckAccepted => "check.accepted",
            Self::CheckRejected => "check.rejected",
            Self::CompleteProgress => "complete.progress",
            Self::CompleteDone => "complete.done",
            Self::CompleteBlocked => "complete.blocked",
            Self::PermissionApproved => "permission.approved",
            Self::PermissionRejected => "permission.rejected",
            Self::ReviewAccepted => "review.accepted",
            Self::ReviewRejected => "review.rejected",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationRef {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub ok: Option<bool>,
    pub event_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub data_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowOutcome {
    pub kind: WorkflowOutcomeKind,
    pub summary: Option<String>,
    pub reason: Option<ReplanReason>,
    pub evidence: Vec<ObservationRef>,
    pub observations: Vec<ObservationRef>,
    pub plan_id: Option<String>,
    pub permission_id: Option<String>,
    pub suggested_repair: Option<String>,
    pub payload: Value,
}

impl WorkflowOutcome {
    pub fn new(kind: WorkflowOutcomeKind) -> Self {
        Self {
            kind,
            summary: None,
            reason: None,
            evidence: Vec::new(),
            observations: Vec::new(),
            plan_id: None,
            permission_id: None,
            suggested_repair: None,
            payload: Value::Null,
        }
    }

    pub fn with_reason(mut self, reason: ReplanReason) -> Self {
        self.reason = Some(reason);
        self
    }

    pub fn with_evidence(mut self, evidence: Vec<ObservationRef>) -> Self {
        self.evidence = evidence;
        self
    }

    pub fn with_observations(mut self, observations: Vec<ObservationRef>) -> Self {
        self.observations = observations;
        self
    }

    pub fn with_permission_id(mut self, permission_id: impl Into<String>) -> Self {
        self.permission_id = Some(permission_id.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowError {
    pub code: String,
    pub message: String,
}
