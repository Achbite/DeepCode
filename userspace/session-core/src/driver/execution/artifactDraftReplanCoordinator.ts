import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';

export interface AcceptedTaskReplanReason {
  readonly code: 'artifact_draft_budget_exceeded';
  readonly message: string;
  readonly previousPlanId?: string;
  readonly previousTaskId?: string;
}

export interface ArtifactDraftReplanState {
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  currentTaskContext?: { taskId?: string };
  taskExecutionCursor?: unknown;
  taskLedger?: unknown;
  acceptedPlanPromptFrame?: unknown;
  taskLocalCompactRecords?: unknown[];
  artifactDraftLease?: unknown;
  artifactChunkRepairAttempts?: Record<string, number>;
  semanticDirectiveRepairAttempts?: Record<string, number>;
  semanticDirectiveRepairAttempted?: boolean;
  semanticDirectiveErrorSummary?: string;
  pendingSemanticToolCalls?: Record<string, unknown>;
  interactionOverlay?: unknown;
  taskPlanReplanReason?: AcceptedTaskReplanReason;
}

export interface ArtifactDraftReplanCoordinatorPorts<State extends ArtifactDraftReplanState> {
  discard(state: State, reason: string): Promise<void>;
}

export class ArtifactDraftReplanCoordinator<State extends ArtifactDraftReplanState> {
  constructor(private readonly ports: ArtifactDraftReplanCoordinatorPorts<State>) {}

  async replan(state: State, message: string): Promise<AcceptedTaskReplanReason> {
    const reason: AcceptedTaskReplanReason = {
      code: 'artifact_draft_budget_exceeded',
      message,
      previousPlanId: state.acceptedTaskPlan?.planId,
      previousTaskId: state.currentTaskContext?.taskId,
    };

    await this.ports.discard(
      state,
      'Kernel draft budget exceeded; the accepted task must be replanned at task granularity.'
    );

    state.acceptedTaskPlan = undefined;
    state.currentTaskContext = undefined;
    state.taskExecutionCursor = undefined;
    state.taskLedger = undefined;
    state.acceptedPlanPromptFrame = undefined;
    state.taskLocalCompactRecords = undefined;
    state.interactionOverlay = undefined;
    state.artifactChunkRepairAttempts = {};
    state.semanticDirectiveRepairAttempts = {};
    state.semanticDirectiveRepairAttempted = false;
    state.semanticDirectiveErrorSummary = undefined;
    state.pendingSemanticToolCalls = {};
    state.taskPlanReplanReason = reason;
    return reason;
  }
}
