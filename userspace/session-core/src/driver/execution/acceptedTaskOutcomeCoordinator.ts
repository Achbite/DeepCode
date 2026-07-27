import type { AgentSessionResult } from '@deepcode/protocol';
import type {
  AcceptedTaskPlanContext,
  CurrentTaskContext,
} from '../../accepted-plan/types.js';
import type { SessionSemanticDirective } from '../../provider/SessionSemanticToolAdapter.js';

export interface PendingAcceptedTaskOutcomeReview {
  readonly taskId: string;
  readonly evidenceRefs: string[];
  readonly result: AgentSessionResult;
}

export interface AcceptedTaskOutcomeCoordinatorState {
  sessionId: string;
  runId: string;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  currentTaskContext?: CurrentTaskContext;
  pendingAcceptedTaskOutcomeReview?: PendingAcceptedTaskOutcomeReview;
}

export class AcceptedTaskOutcomeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AcceptedTaskOutcomeError';
  }
}

/**
 * The semantic tool remains parseable for Provider compatibility, but it has
 * no settlement authority. TaskLedgerV2 is advanced only by exact Kernel
 * facts, explicit user decisions, or registered deterministic validators.
 */
export class AcceptedTaskOutcomeCoordinator<
  State extends AcceptedTaskOutcomeCoordinatorState,
> {
  constructor(_ports: unknown) {}

  async handle(input: {
    state: State;
    directive: Extract<SessionSemanticDirective, { kind: 'taskOutcome' }>;
  }): Promise<{ kind: 'providerResume'; toolResult: Record<string, unknown> }> {
    const taskId = input.state.currentTaskContext?.taskId;
    if (!input.state.acceptedTaskPlan || !taskId) {
      throw new AcceptedTaskOutcomeError(
        'accepted_task_outcome_unavailable',
        'session.submit_task_outcome requires one current accepted task.'
      );
    }
    return {
      kind: 'providerResume',
      toolResult: {
        status: 'rejected',
        code: 'accepted_task_outcome_non_authoritative',
        taskId,
        message:
          'Model task-outcome claims cannot settle TaskLedgerV2. Continue with an exact Kernel action, request an explicit user decision, or use a registered deterministic validator.',
      },
    };
  }
}
