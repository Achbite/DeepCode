use crate::contract::{PlanContract, PlanRiskLevel};
use crate::outcome::{ObservationRef, WorkflowOutcome, WorkflowOutcomeKind};
use crate::phase::ReplanReason;
use crate::phase::WorkflowPhase;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseWorkflowDescriptor {
    pub id: String,
    pub version: String,
    pub phases: Vec<WorkflowPhaseDescriptor>,
    pub transitions: Vec<PhaseWorkflowTransitionDescriptor>,
    pub max_iterations: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPhaseDescriptor {
    pub id: String,
    pub phase: WorkflowPhase,
    pub allowed_capabilities: Vec<String>,
    pub evidence_required: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseWorkflowTransitionDescriptor {
    pub from: WorkflowPhase,
    pub to: WorkflowPhase,
    pub condition: TransitionCondition,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionCondition {
    PlanAccepted,
    PlanRejected,
    PermissionGranted,
    PermissionDenied,
    ValidationPassed,
    ValidationFailed,
    ReviewAccepted,
    ReviewRejected,
    BudgetExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanAcceptanceStatus {
    AutoAccepted,
    AwaitingPlanApproval,
    AwaitingTemporaryGrant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEvaluation {
    pub status: PlanAcceptanceStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WorkflowController {
    high_risk_capabilities: Vec<String>,
}

impl Default for WorkflowController {
    fn default() -> Self {
        Self {
            high_risk_capabilities: vec![
                "fs.write".to_string(),
                "fs.delete".to_string(),
                "process.exec".to_string(),
                "network.egress".to_string(),
                "secret.read".to_string(),
                "config.modify".to_string(),
                "kernel.modify".to_string(),
            ],
        }
    }
}

impl WorkflowController {
    pub fn evaluate_plan_contract(&self, plan: &PlanContract) -> PlanEvaluation {
        if plan.completion_criteria.is_empty()
            || plan
                .completion_criteria
                .iter()
                .any(|criteria| criteria.evidence_required.is_empty())
        {
            return PlanEvaluation {
                status: PlanAcceptanceStatus::AwaitingPlanApproval,
                reason: Some("completion criteria require explicit evidence".to_string()),
            };
        }

        if plan.requires_user_approval || plan.risk_level != PlanRiskLevel::Low {
            return PlanEvaluation {
                status: if self.requires_temporary_grant(plan) {
                    PlanAcceptanceStatus::AwaitingTemporaryGrant
                } else {
                    PlanAcceptanceStatus::AwaitingPlanApproval
                },
                reason: Some("plan requires user approval or temporary grant".to_string()),
            };
        }

        if self.requires_temporary_grant(plan) {
            return PlanEvaluation {
                status: PlanAcceptanceStatus::AwaitingTemporaryGrant,
                reason: Some("plan requests high risk capabilities".to_string()),
            };
        }

        PlanEvaluation {
            status: PlanAcceptanceStatus::AutoAccepted,
            reason: None,
        }
    }

    pub fn validation_outcome(
        &self,
        passed: bool,
        evidence: Vec<ObservationRef>,
    ) -> WorkflowOutcome {
        if passed {
            WorkflowOutcome::new(WorkflowOutcomeKind::CompleteDone).with_evidence(evidence)
        } else {
            WorkflowOutcome::new(WorkflowOutcomeKind::CompleteBlocked)
                .with_reason(ReplanReason::TestFailed)
                .with_evidence(evidence)
        }
    }

    fn requires_temporary_grant(&self, plan: &PlanContract) -> bool {
        plan.required_capabilities
            .iter()
            .any(|capability| self.high_risk_capabilities.contains(capability))
    }
}
