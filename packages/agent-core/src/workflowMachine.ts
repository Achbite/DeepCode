import type {
  AgentObservationRef,
  AgentReplanReason,
  AgentStageOutcome,
  AgentWorkflowPhase,
  AgentWorkflowState,
  AgentWorkflowTransition,
} from '@deepcode/protocol';
import { nowIso } from './utils.js';

export interface InitialWorkflowStateOptions {
  phase?: AgentWorkflowPhase;
  maxIterations?: number;
}

export interface WorkflowTransitionResult {
  state: AgentWorkflowState;
  transition: AgentWorkflowTransition;
}

const REPLAN_REASONS = new Set<AgentReplanReason>([
  'invalid_plan',
  'missing_context',
  'tool_error',
  'test_failed',
  'plan_mismatch',
  'scope_changed',
  'user_rejected_permission',
  'insufficient_evidence',
]);

const REVIEW_REASONS = new Set<AgentReplanReason>([
  'unsafe_operation',
]);

export function initialWorkflowState(
  sessionId: string,
  options: InitialWorkflowStateOptions = {}
): AgentWorkflowState {
  return {
    sessionId,
    phase: options.phase ?? 'plan',
    status: 'running',
    iteration: 0,
    maxIterations: options.maxIterations ?? 3,
    observations: [],
  };
}

export function isWorkflowTerminal(state: AgentWorkflowState): boolean {
  return state.phase === 'done' || state.phase === 'aborted';
}

export function transitionWorkflowState(
  state: AgentWorkflowState,
  outcome: AgentStageOutcome
): WorkflowTransitionResult {
  if (isWorkflowTerminal(state)) {
    return buildResult(state, outcome, state.phase, {
      code: 'workflow_already_terminal',
      message: `Workflow is already ${state.phase}.`,
    });
  }

  const next = nextStateForOutcome(state, outcome);
  return buildResult(state, outcome, next.phase, next.lastError, next);
}

function nextStateForOutcome(
  state: AgentWorkflowState,
  outcome: AgentStageOutcome
): AgentWorkflowState {
  switch (state.phase) {
    case 'plan':
      return transitionFromPlan(state, outcome);
    case 'check':
      return transitionFromCheck(state, outcome);
    case 'complete':
      return transitionFromComplete(state, outcome);
    case 'awaitingApproval':
      return transitionFromAwaitingApproval(state, outcome);
    case 'review':
      return transitionFromReview(state, outcome);
    default:
      return abortForInvalidTransition(state, outcome);
  }
}

function transitionFromPlan(
  state: AgentWorkflowState,
  outcome: AgentStageOutcome
): AgentWorkflowState {
  if (outcome.kind === 'plan.proposed') {
    return {
      ...state,
      phase: 'check',
      status: 'running',
      currentPlan: outcome.plan,
      lastOutcomeKind: outcome.kind,
      lastError: undefined,
    };
  }

  if (outcome.kind === 'plan.needs_user_input') {
    return {
      ...state,
      phase: 'awaitingApproval',
      status: 'waiting',
      lastOutcomeKind: outcome.kind,
      lastError: {
        code: 'plan_needs_user_input',
        message: outcome.blockingReason,
      },
    };
  }

  return abortForInvalidTransition(state, outcome);
}

function transitionFromCheck(
  state: AgentWorkflowState,
  outcome: AgentStageOutcome
): AgentWorkflowState {
  if (outcome.kind === 'check.accepted') {
    return {
      ...state,
      phase: 'complete',
      status: 'running',
      lastOutcomeKind: outcome.kind,
      lastError: undefined,
    };
  }

  if (outcome.kind === 'check.rejected') {
    return replanOrAbort(state, outcome, outcome.reason, outcome.evidence);
  }

  return abortForInvalidTransition(state, outcome);
}

function transitionFromComplete(
  state: AgentWorkflowState,
  outcome: AgentStageOutcome
): AgentWorkflowState {
  if (outcome.kind === 'complete.progress') {
    return {
      ...state,
      phase: 'complete',
      status: 'running',
      observations: [...state.observations, ...outcome.observations],
      lastOutcomeKind: outcome.kind,
      lastError: undefined,
    };
  }

  if (outcome.kind === 'complete.done') {
    return {
      ...state,
      phase: 'review',
      status: 'running',
      observations: [...state.observations, ...outcome.evidence],
      lastOutcomeKind: outcome.kind,
      lastError: undefined,
    };
  }

  if (outcome.kind === 'complete.blocked') {
    if (outcome.reason === 'permission_required') {
      return {
        ...state,
        phase: 'awaitingApproval',
        status: 'waiting',
        observations: [...state.observations, ...outcome.evidence],
        lastOutcomeKind: outcome.kind,
        lastError: {
          code: outcome.reason,
          message: outcome.suggestedRepair ?? outcome.reason,
        },
      };
    }

    if (REPLAN_REASONS.has(outcome.reason)) {
      return replanOrAbort(state, outcome, outcome.reason, outcome.evidence);
    }

    if (REVIEW_REASONS.has(outcome.reason)) {
      return {
        ...state,
        phase: 'review',
        status: 'running',
        observations: [...state.observations, ...outcome.evidence],
        lastOutcomeKind: outcome.kind,
        lastError: {
          code: outcome.reason,
          message: outcome.suggestedRepair ?? outcome.reason,
        },
      };
    }
  }

  return abortForInvalidTransition(state, outcome);
}

function transitionFromAwaitingApproval(
  state: AgentWorkflowState,
  outcome: AgentStageOutcome
): AgentWorkflowState {
  if (outcome.kind === 'permission.approved') {
    return {
      ...state,
      phase: 'complete',
      status: 'running',
      pendingPermissionId: undefined,
      lastOutcomeKind: outcome.kind,
      lastError: undefined,
    };
  }

  if (outcome.kind === 'permission.rejected') {
    return replanOrAbort(state, outcome, outcome.reason);
  }

  return abortForInvalidTransition(state, outcome);
}

function transitionFromReview(
  state: AgentWorkflowState,
  outcome: AgentStageOutcome
): AgentWorkflowState {
  if (outcome.kind === 'review.accepted') {
    return {
      ...state,
      phase: 'done',
      status: 'succeeded',
      observations: [...state.observations, ...outcome.evidence],
      lastOutcomeKind: outcome.kind,
      lastError: undefined,
    };
  }

  if (outcome.kind === 'review.rejected') {
    return replanOrAbort(state, outcome, outcome.reason, outcome.evidence);
  }

  return abortForInvalidTransition(state, outcome);
}

function replanOrAbort(
  state: AgentWorkflowState,
  outcome: AgentStageOutcome,
  reason: AgentReplanReason,
  evidence: AgentObservationRef[] = []
): AgentWorkflowState {
  if (state.iteration + 1 > state.maxIterations) {
    return {
      ...state,
      phase: 'aborted',
      status: 'aborted',
      observations: [...state.observations, ...evidence],
      lastOutcomeKind: outcome.kind,
      lastError: {
        code: 'workflow_budget_exceeded',
        message: `Workflow iteration budget exceeded after ${state.maxIterations} retries.`,
      },
    };
  }

  return {
    ...state,
    phase: 'plan',
    status: 'running',
    iteration: state.iteration + 1,
    observations: [...state.observations, ...evidence],
    lastOutcomeKind: outcome.kind,
    lastError: {
      code: reason,
      message: reason,
    },
  };
}

function abortForInvalidTransition(
  state: AgentWorkflowState,
  outcome: AgentStageOutcome
): AgentWorkflowState {
  return {
    ...state,
    phase: 'aborted',
    status: 'failed',
    lastOutcomeKind: outcome.kind,
    lastError: {
      code: 'invalid_workflow_transition',
      message: `Invalid outcome ${outcome.kind} for phase ${state.phase}.`,
    },
  };
}

function buildResult(
  previous: AgentWorkflowState,
  outcome: AgentStageOutcome,
  to: AgentWorkflowPhase,
  error?: AgentWorkflowState['lastError'],
  next?: AgentWorkflowState
): WorkflowTransitionResult {
  const createdAt = nowIso();
  const state = next ?? {
    ...previous,
    lastOutcomeKind: outcome.kind,
    lastError: error,
  };

  return {
    state,
    transition: {
      id: `transition-${previous.sessionId}-${createdAt}`,
      sessionId: previous.sessionId,
      from: previous.phase,
      to,
      outcomeKind: outcome.kind,
      reason: error?.code,
      iteration: state.iteration,
      createdAt,
    },
  };
}
