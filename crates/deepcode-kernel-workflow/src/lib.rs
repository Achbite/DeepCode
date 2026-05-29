use deepcode_kernel_abi::{KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod decision_engine;
pub mod plan_review_engine;

pub use decision_engine::{DecisionEngine, RunDecisionState, WorkflowEvidence};
pub use plan_review_engine::{
    DefaultPlanReviewEngine, PlanReviewEngine, PlanReviewFinding, PlanReviewReport,
    PlanReviewStatus,
};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowPhase {
    Plan,
    Check,
    Complete,
    AwaitingApproval,
    Review,
    Done,
    Aborted,
}

impl WorkflowPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Check => "check",
            Self::Complete => "complete",
            Self::AwaitingApproval => "awaitingApproval",
            Self::Review => "review",
            Self::Done => "done",
            Self::Aborted => "aborted",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Aborted)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowRunStatus {
    Running,
    Waiting,
    Succeeded,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplanReason {
    InvalidPlan,
    MissingContext,
    ToolError,
    TestFailed,
    PlanMismatch,
    ScopeChanged,
    UnsafeOperation,
    PermissionRequired,
    UserRejectedPermission,
    InsufficientEvidence,
    BudgetExceeded,
}

impl ReplanReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InvalidPlan => "invalid_plan",
            Self::MissingContext => "missing_context",
            Self::ToolError => "tool_error",
            Self::TestFailed => "test_failed",
            Self::PlanMismatch => "plan_mismatch",
            Self::ScopeChanged => "scope_changed",
            Self::UnsafeOperation => "unsafe_operation",
            Self::PermissionRequired => "permission_required",
            Self::UserRejectedPermission => "user_rejected_permission",
            Self::InsufficientEvidence => "insufficient_evidence",
            Self::BudgetExceeded => "budget_exceeded",
        }
    }

    fn returns_to_plan(&self) -> bool {
        matches!(
            self,
            Self::InvalidPlan
                | Self::MissingContext
                | Self::ToolError
                | Self::TestFailed
                | Self::PlanMismatch
                | Self::ScopeChanged
                | Self::UserRejectedPermission
                | Self::InsufficientEvidence
        )
    }

    fn enters_review(&self) -> bool {
        matches!(self, Self::UnsafeOperation)
    }
}

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanRiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionCriteria {
    pub id: String,
    pub description: String,
    pub evidence_required: Vec<String>,
    pub validation_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPolicy {
    pub require_evidence: bool,
    pub require_validation_success: bool,
}

impl Default for ReviewPolicy {
    fn default() -> Self {
        Self {
            require_evidence: true,
            require_validation_success: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanContract {
    pub id: String,
    pub goal: String,
    pub scope: Vec<String>,
    pub forbidden_actions: Vec<String>,
    pub required_capabilities: Vec<String>,
    pub completion_criteria: Vec<CompletionCriteria>,
    pub risk_level: PlanRiskLevel,
    pub requires_user_approval: bool,
    pub review_policy: ReviewPolicy,
}

impl PlanContract {
    pub fn low_risk_direct(id: impl Into<String>, goal: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            goal: goal.into(),
            scope: vec!["workspace".to_string()],
            forbidden_actions: Vec::new(),
            required_capabilities: vec!["workspace.read".to_string()],
            completion_criteria: vec![CompletionCriteria {
                id: "criteria-evidence".to_string(),
                description: "At least one evidence reference is produced.".to_string(),
                evidence_required: vec!["observation".to_string()],
                validation_kind: None,
            }],
            risk_level: PlanRiskLevel::Low,
            requires_user_approval: false,
            review_policy: ReviewPolicy::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDescriptor {
    pub id: String,
    pub version: String,
    pub phases: Vec<WorkflowPhaseDescriptor>,
    pub transitions: Vec<WorkflowTransitionDescriptor>,
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
pub struct WorkflowTransitionDescriptor {
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
                "workspace.write".to_string(),
                "workspace.delete".to_string(),
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
    evidence: Vec<ObservationRef>,
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

    fn obs(id: &str) -> ObservationRef {
        ObservationRef {
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
