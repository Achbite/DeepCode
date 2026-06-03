use crate::outcome::{WorkflowError, WorkflowOutcome, WorkflowOutcomeKind};
use crate::phase::{ReplanReason, WorkflowPhase, WorkflowRunStatus};
use crate::state::{WorkflowState, WorkflowTransition, WorkflowTransitionResult};
use deepcode_kernel_abi::{KernelError, KernelResult};

pub trait WorkflowMachine {
    fn initial_state(&self, session_id: &str, max_iterations: Option<u32>) -> WorkflowState;
    fn transition(
        &self,
        state: WorkflowState,
        outcome: WorkflowOutcome,
    ) -> KernelResult<WorkflowTransitionResult>;
}

#[derive(Debug, Clone)]
pub struct BuiltinWorkflowMachine {
    default_max_iterations: u32,
}

impl Default for BuiltinWorkflowMachine {
    fn default() -> Self {
        Self {
            default_max_iterations: 3,
        }
    }
}

impl BuiltinWorkflowMachine {
    pub fn new(default_max_iterations: u32) -> Self {
        Self {
            default_max_iterations,
        }
    }
}

impl WorkflowMachine for BuiltinWorkflowMachine {
    fn initial_state(&self, session_id: &str, max_iterations: Option<u32>) -> WorkflowState {
        WorkflowState::initial(
            session_id.to_string(),
            max_iterations.unwrap_or(self.default_max_iterations),
        )
    }

    fn transition(
        &self,
        state: WorkflowState,
        outcome: WorkflowOutcome,
    ) -> KernelResult<WorkflowTransitionResult> {
        if state.session_id.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "workflow session_id is required".to_string(),
            ));
        }

        let previous = state.clone();
        let next = if state.is_terminal() {
            terminal_noop(state, &outcome)
        } else {
            next_state_for_outcome(state, &outcome)
        };

        Ok(build_transition(previous, next, outcome))
    }
}

fn next_state_for_outcome(state: WorkflowState, outcome: &WorkflowOutcome) -> WorkflowState {
    match state.phase {
        WorkflowPhase::Plan => transition_from_plan(state, outcome),
        WorkflowPhase::Check => transition_from_check(state, outcome),
        WorkflowPhase::Complete => transition_from_complete(state, outcome),
        WorkflowPhase::AwaitingApproval => transition_from_awaiting_approval(state, outcome),
        WorkflowPhase::Review => transition_from_review(state, outcome),
        WorkflowPhase::Done | WorkflowPhase::Aborted => terminal_noop(state, outcome),
    }
}

fn transition_from_plan(mut state: WorkflowState, outcome: &WorkflowOutcome) -> WorkflowState {
    match outcome.kind {
        WorkflowOutcomeKind::PlanProposed => {
            state.phase = WorkflowPhase::Check;
            state.status = WorkflowRunStatus::Running;
            state.current_plan_id = outcome.plan_id.clone();
            clear_last_error(&mut state, outcome);
            state
        }
        WorkflowOutcomeKind::PlanNeedsUserInput => {
            state.phase = WorkflowPhase::AwaitingApproval;
            state.status = WorkflowRunStatus::Waiting;
            set_last_error(
                &mut state,
                outcome,
                "plan_needs_user_input",
                outcome.summary.clone(),
            );
            state
        }
        _ => abort_for_invalid_transition(state, outcome),
    }
}

fn transition_from_check(state: WorkflowState, outcome: &WorkflowOutcome) -> WorkflowState {
    match outcome.kind {
        WorkflowOutcomeKind::CheckAccepted => {
            let mut next = state;
            next.phase = WorkflowPhase::Complete;
            next.status = WorkflowRunStatus::Running;
            clear_last_error(&mut next, outcome);
            next
        }
        WorkflowOutcomeKind::CheckRejected => replan_or_abort(
            state,
            outcome,
            outcome.reason.clone(),
            outcome.evidence.clone(),
        ),
        _ => abort_for_invalid_transition(state, outcome),
    }
}

fn transition_from_complete(mut state: WorkflowState, outcome: &WorkflowOutcome) -> WorkflowState {
    match outcome.kind {
        WorkflowOutcomeKind::CompleteProgress => {
            state.phase = WorkflowPhase::Complete;
            state.status = WorkflowRunStatus::Running;
            state.observations.extend(outcome.observations.clone());
            clear_last_error(&mut state, outcome);
            state
        }
        WorkflowOutcomeKind::CompleteDone => {
            state.phase = WorkflowPhase::Review;
            state.status = WorkflowRunStatus::Running;
            state.observations.extend(outcome.evidence.clone());
            clear_last_error(&mut state, outcome);
            state
        }
        WorkflowOutcomeKind::CompleteBlocked => {
            let reason = outcome
                .reason
                .clone()
                .unwrap_or(ReplanReason::InsufficientEvidence);
            state.observations.extend(outcome.evidence.clone());
            if reason == ReplanReason::PermissionRequired {
                state.phase = WorkflowPhase::AwaitingApproval;
                state.status = WorkflowRunStatus::Waiting;
                state.pending_permission_id = outcome.permission_id.clone();
                set_last_error(
                    &mut state,
                    outcome,
                    reason.as_str(),
                    outcome.suggested_repair.clone(),
                );
                return state;
            }
            if reason.returns_to_plan() {
                return replan_or_abort(state, outcome, Some(reason), Vec::new());
            }
            if reason.enters_review() {
                state.phase = WorkflowPhase::Review;
                state.status = WorkflowRunStatus::Running;
                set_last_error(
                    &mut state,
                    outcome,
                    reason.as_str(),
                    outcome.suggested_repair.clone(),
                );
                return state;
            }
            abort_for_invalid_transition(state, outcome)
        }
        _ => abort_for_invalid_transition(state, outcome),
    }
}

fn transition_from_awaiting_approval(
    mut state: WorkflowState,
    outcome: &WorkflowOutcome,
) -> WorkflowState {
    match outcome.kind {
        WorkflowOutcomeKind::PermissionApproved => {
            state.phase = WorkflowPhase::Complete;
            state.status = WorkflowRunStatus::Running;
            state.pending_permission_id = None;
            clear_last_error(&mut state, outcome);
            state
        }
        WorkflowOutcomeKind::PermissionRejected => replan_or_abort(
            state,
            outcome,
            Some(
                outcome
                    .reason
                    .clone()
                    .unwrap_or(ReplanReason::UserRejectedPermission),
            ),
            Vec::new(),
        ),
        _ => abort_for_invalid_transition(state, outcome),
    }
}

fn transition_from_review(mut state: WorkflowState, outcome: &WorkflowOutcome) -> WorkflowState {
    match outcome.kind {
        WorkflowOutcomeKind::ReviewAccepted => {
            state.phase = WorkflowPhase::Done;
            state.status = WorkflowRunStatus::Succeeded;
            state.observations.extend(outcome.evidence.clone());
            clear_last_error(&mut state, outcome);
            state
        }
        WorkflowOutcomeKind::ReviewRejected => replan_or_abort(
            state,
            outcome,
            outcome.reason.clone(),
            outcome.evidence.clone(),
        ),
        _ => abort_for_invalid_transition(state, outcome),
    }
}

fn terminal_noop(mut state: WorkflowState, outcome: &WorkflowOutcome) -> WorkflowState {
    state.last_outcome_kind = Some(outcome.kind.clone());
    state.last_error = Some(WorkflowError {
        code: "workflow_already_terminal".to_string(),
        message: format!("Workflow is already {}.", state.phase.as_str()),
    });
    state
}

fn replan_or_abort(
    mut state: WorkflowState,
    outcome: &WorkflowOutcome,
    reason: Option<ReplanReason>,
    evidence: Vec<crate::ObservationRef>,
) -> WorkflowState {
    let reason = reason.unwrap_or(ReplanReason::InsufficientEvidence);
    state.observations.extend(evidence);
    if state.iteration + 1 > state.max_iterations {
        state.phase = WorkflowPhase::Aborted;
        state.status = WorkflowRunStatus::Aborted;
        state.last_outcome_kind = Some(outcome.kind.clone());
        state.last_error = Some(WorkflowError {
            code: "workflow_budget_exceeded".to_string(),
            message: format!(
                "Workflow iteration budget exceeded after {} retries.",
                state.max_iterations
            ),
        });
        return state;
    }

    state.phase = WorkflowPhase::Plan;
    state.status = WorkflowRunStatus::Running;
    state.iteration += 1;
    state.pending_permission_id = None;
    state.last_outcome_kind = Some(outcome.kind.clone());
    state.last_error = Some(WorkflowError {
        code: reason.as_str().to_string(),
        message: reason.as_str().to_string(),
    });
    state
}

fn abort_for_invalid_transition(
    mut state: WorkflowState,
    outcome: &WorkflowOutcome,
) -> WorkflowState {
    let previous_phase = state.phase.clone();
    state.phase = WorkflowPhase::Aborted;
    state.status = WorkflowRunStatus::Failed;
    state.last_outcome_kind = Some(outcome.kind.clone());
    state.last_error = Some(WorkflowError {
        code: "invalid_workflow_transition".to_string(),
        message: format!(
            "Invalid outcome {} for phase {}.",
            outcome.kind.as_str(),
            previous_phase.as_str()
        ),
    });
    state
}

fn clear_last_error(state: &mut WorkflowState, outcome: &WorkflowOutcome) {
    state.last_outcome_kind = Some(outcome.kind.clone());
    state.last_error = None;
}

fn set_last_error(
    state: &mut WorkflowState,
    outcome: &WorkflowOutcome,
    code: &str,
    message: Option<String>,
) {
    state.last_outcome_kind = Some(outcome.kind.clone());
    state.last_error = Some(WorkflowError {
        code: code.to_string(),
        message: message.unwrap_or_else(|| code.to_string()),
    });
}

fn build_transition(
    previous: WorkflowState,
    next: WorkflowState,
    outcome: WorkflowOutcome,
) -> WorkflowTransitionResult {
    let reason = next.last_error.as_ref().map(|error| error.code.clone());
    let transition = WorkflowTransition {
        id: format!(
            "transition-{}-{}-{}-{}",
            previous.session_id,
            previous.iteration,
            previous.phase.as_str(),
            outcome.kind.as_str()
        ),
        session_id: previous.session_id,
        from: previous.phase,
        to: next.phase.clone(),
        outcome_kind: outcome.kind,
        reason,
        iteration: next.iteration,
        created_at: None,
    };
    WorkflowTransitionResult {
        state: next,
        transition,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        PlanAcceptanceStatus, PlanContract, PlanRiskLevel, WorkflowController, WorkflowOutcome,
    };

    fn obs(id: &str) -> crate::ObservationRef {
        crate::ObservationRef {
            id: id.to_string(),
            kind: "tool_result".to_string(),
            summary: "ok".to_string(),
            ok: Some(true),
            event_id: None,
            tool_call_id: None,
            data_ref: None,
        }
    }

    #[test]
    fn workflow_happy_path_reaches_done() {
        let machine = BuiltinWorkflowMachine::default();
        let mut state = machine.initial_state("session-1", Some(3));

        state = machine
            .transition(
                state,
                WorkflowOutcome::new(WorkflowOutcomeKind::PlanProposed),
            )
            .unwrap()
            .state;
        assert_eq!(state.phase, WorkflowPhase::Check);

        state = machine
            .transition(
                state,
                WorkflowOutcome::new(WorkflowOutcomeKind::CheckAccepted),
            )
            .unwrap()
            .state;
        assert_eq!(state.phase, WorkflowPhase::Complete);

        state = machine
            .transition(
                state,
                WorkflowOutcome::new(WorkflowOutcomeKind::CompleteDone)
                    .with_evidence(vec![obs("e1")]),
            )
            .unwrap()
            .state;
        assert_eq!(state.phase, WorkflowPhase::Review);

        state = machine
            .transition(
                state,
                WorkflowOutcome::new(WorkflowOutcomeKind::ReviewAccepted)
                    .with_evidence(vec![obs("e2")]),
            )
            .unwrap()
            .state;
        assert_eq!(state.phase, WorkflowPhase::Done);
        assert_eq!(state.status, WorkflowRunStatus::Succeeded);
    }

    #[test]
    fn low_risk_plan_contract_auto_accepts() {
        let controller = WorkflowController::default();
        let plan = PlanContract::low_risk_direct("plan-1", "read workspace root");
        let evaluation = controller.evaluate_plan_contract(&plan);

        assert_eq!(evaluation.status, PlanAcceptanceStatus::AutoAccepted);
    }

    #[test]
    fn high_risk_plan_waits_for_temporary_grant() {
        let controller = WorkflowController::default();
        let plan = PlanContract {
            required_capabilities: vec!["workspace.write".to_string()],
            risk_level: PlanRiskLevel::High,
            ..PlanContract::low_risk_direct("plan-2", "modify workspace")
        };
        let evaluation = controller.evaluate_plan_contract(&plan);

        assert_eq!(
            evaluation.status,
            PlanAcceptanceStatus::AwaitingTemporaryGrant
        );
    }

    #[test]
    fn missing_completion_evidence_waits_for_plan_approval() {
        let controller = WorkflowController::default();
        let mut plan = PlanContract::low_risk_direct("plan-3", "ambiguous task");
        plan.completion_criteria[0].evidence_required.clear();
        let evaluation = controller.evaluate_plan_contract(&plan);

        assert_eq!(
            evaluation.status,
            PlanAcceptanceStatus::AwaitingPlanApproval
        );
    }

    #[test]
    fn validation_failed_outcome_replans_from_complete() {
        let controller = WorkflowController::default();
        let machine = BuiltinWorkflowMachine::default();
        let state = WorkflowState {
            phase: WorkflowPhase::Complete,
            ..machine.initial_state("session-1", Some(3))
        };
        let result = machine
            .transition(
                state,
                controller.validation_outcome(false, vec![obs("test")]),
            )
            .unwrap();

        assert_eq!(result.state.phase, WorkflowPhase::Plan);
        assert_eq!(result.state.iteration, 1);
    }

    #[test]
    fn complete_blocked_test_failed_replans() {
        let machine = BuiltinWorkflowMachine::default();
        let state = WorkflowState {
            phase: WorkflowPhase::Complete,
            ..machine.initial_state("session-1", Some(3))
        };
        let result = machine
            .transition(
                state,
                WorkflowOutcome::new(WorkflowOutcomeKind::CompleteBlocked)
                    .with_reason(ReplanReason::TestFailed)
                    .with_evidence(vec![obs("test")]),
            )
            .unwrap();

        assert_eq!(result.state.phase, WorkflowPhase::Plan);
        assert_eq!(result.state.iteration, 1);
        assert_eq!(
            result.state.last_error.as_ref().unwrap().code,
            "test_failed"
        );
    }

    #[test]
    fn permission_required_waits_and_approval_returns_to_complete() {
        let machine = BuiltinWorkflowMachine::default();
        let state = WorkflowState {
            phase: WorkflowPhase::Complete,
            ..machine.initial_state("session-1", Some(3))
        };
        let waiting = machine
            .transition(
                state,
                WorkflowOutcome::new(WorkflowOutcomeKind::CompleteBlocked)
                    .with_reason(ReplanReason::PermissionRequired)
                    .with_permission_id("perm-1"),
            )
            .unwrap()
            .state;

        assert_eq!(waiting.phase, WorkflowPhase::AwaitingApproval);
        assert_eq!(waiting.status, WorkflowRunStatus::Waiting);
        assert_eq!(waiting.pending_permission_id.as_deref(), Some("perm-1"));

        let approved = machine
            .transition(
                waiting,
                WorkflowOutcome::new(WorkflowOutcomeKind::PermissionApproved)
                    .with_permission_id("perm-1"),
            )
            .unwrap()
            .state;

        assert_eq!(approved.phase, WorkflowPhase::Complete);
        assert_eq!(approved.pending_permission_id, None);
    }

    #[test]
    fn invalid_transition_aborts() {
        let machine = BuiltinWorkflowMachine::default();
        let state = machine.initial_state("session-1", Some(3));
        let result = machine
            .transition(
                state,
                WorkflowOutcome::new(WorkflowOutcomeKind::CompleteDone),
            )
            .unwrap();

        assert_eq!(result.state.phase, WorkflowPhase::Aborted);
        assert_eq!(result.state.status, WorkflowRunStatus::Failed);
        assert_eq!(
            result.state.last_error.as_ref().unwrap().code,
            "invalid_workflow_transition"
        );
    }

    #[test]
    fn terminal_state_does_not_move() {
        let machine = BuiltinWorkflowMachine::default();
        let state = WorkflowState {
            phase: WorkflowPhase::Done,
            status: WorkflowRunStatus::Succeeded,
            ..machine.initial_state("session-1", Some(3))
        };
        let result = machine
            .transition(
                state,
                WorkflowOutcome::new(WorkflowOutcomeKind::ReviewRejected)
                    .with_reason(ReplanReason::MissingContext),
            )
            .unwrap();

        assert_eq!(result.state.phase, WorkflowPhase::Done);
        assert_eq!(
            result.state.last_error.as_ref().unwrap().code,
            "workflow_already_terminal"
        );
    }

    #[test]
    fn replan_budget_exceeded_aborts() {
        let machine = BuiltinWorkflowMachine::default();
        let state = WorkflowState {
            phase: WorkflowPhase::Review,
            iteration: 1,
            max_iterations: 1,
            ..machine.initial_state("session-1", Some(1))
        };
        let result = machine
            .transition(
                state,
                WorkflowOutcome::new(WorkflowOutcomeKind::ReviewRejected)
                    .with_reason(ReplanReason::MissingContext),
            )
            .unwrap();

        assert_eq!(result.state.phase, WorkflowPhase::Aborted);
        assert_eq!(result.state.status, WorkflowRunStatus::Aborted);
        assert_eq!(
            result.state.last_error.as_ref().unwrap().code,
            "workflow_budget_exceeded"
        );
    }
}
