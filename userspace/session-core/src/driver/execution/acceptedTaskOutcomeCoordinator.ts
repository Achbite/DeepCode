import type { AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import {
  appendTaskLocalCompactRecord,
  buildTaskLocalCompactRecord,
  type ContextAssemblyRecord,
  type ContextAssemblyTaskLocalCompactRecord,
} from '../../context/index.js';
import type { ResourcePacket, ResourcePacketItem } from '../../context/types.js';
import type {
  AcceptedPlanBatchProgress,
  AcceptedTaskPlanContext,
  CurrentTaskContext,
  TaskExecutionCursor,
} from '../../accepted-plan/types.js';
import type { SessionSemanticDirective } from '../../provider/SessionSemanticToolAdapter.js';
import type { SessionDriverTaskResourceProgress } from '../runFrame.js';

export interface PendingAcceptedTaskOutcomeReview {
  readonly taskId: string;
  readonly summary: string;
  readonly evidenceRefs: string[];
  readonly result: AgentSessionResult;
}

export interface AcceptedTaskOutcomeCoordinatorState {
  sessionId: string;
  runId: string;
  workspaceScopeKey: string;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  currentTaskContext?: CurrentTaskContext;
  taskExecutionCursor?: TaskExecutionCursor;
  resourcePackets: ResourcePacket[];
  resourceEvidenceRevision: number;
  resourceRequestProgressByTask: Map<string, SessionDriverTaskResourceProgress>;
  contextAssembly?: ContextAssemblyRecord;
  taskLocalCompactRecords?: ContextAssemblyTaskLocalCompactRecord[];
  pendingAcceptedTaskOutcomeReview?: PendingAcceptedTaskOutcomeReview;
}

export interface AcceptedTaskOutcomeCoordinatorPorts<State extends AcceptedTaskOutcomeCoordinatorState> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  recordModelTaskOutcome(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    taskId: string;
  }): {
    taskId: string;
    nextAcceptedPlan: AcceptedTaskPlanContext;
  };
  refreshRuntimeState(state: State): void;
  complete(acceptedPlan: AcceptedTaskPlanContext): boolean;
  taskOutcomeCheckpointEvent(input: {
    sessionId: string;
    runId: string;
    accepted: AcceptedTaskPlanContext;
    nextAccepted: AcceptedTaskPlanContext;
    taskId: string;
    summary: string;
    evidenceRefs: string[];
    acceptanceResults: Array<{
      criterionIndex: number;
      status: 'satisfied';
      evidenceRefs: string[];
    }>;
    evidenceRevision: number;
    progress: AcceptedPlanBatchProgress;
    contextCompactRecord?: ContextAssemblyTaskLocalCompactRecord;
    ts: string;
    id: string;
  }): AgentEvent;
  taskSavepointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    nextAccepted: AcceptedTaskPlanContext,
    progress: AcceptedPlanBatchProgress,
    kernelEvents: unknown[],
    cursor: TaskExecutionCursor | undefined,
    context: CurrentTaskContext | undefined,
    ts: string,
    id: string,
    contextCompactRecord?: ContextAssemblyTaskLocalCompactRecord
  ): AgentEvent;
}

export class AcceptedTaskOutcomeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AcceptedTaskOutcomeError';
  }
}

export class AcceptedTaskOutcomeCoordinator<State extends AcceptedTaskOutcomeCoordinatorState> {
  constructor(private readonly ports: AcceptedTaskOutcomeCoordinatorPorts<State>) {}

  async handle(input: {
    state: State;
    directive: Extract<SessionSemanticDirective, { kind: 'taskOutcome' }>;
  }): Promise<{ kind: 'providerResume'; toolResult: Record<string, unknown> }> {
    const { state, directive } = input;
    const accepted = state.acceptedTaskPlan;
    const current = state.currentTaskContext;
    const taskId = current?.taskId;
    if (!accepted || !current || !taskId) {
      throw new AcceptedTaskOutcomeError(
        'accepted_task_outcome_unavailable',
        'session.submit_task_outcome requires one current accepted task.'
      );
    }
    if (
      accepted.completedTaskIds.includes(taskId)
      || (accepted.modelJudgedSufficientTaskIds ?? []).includes(taskId)
    ) {
      throw new AcceptedTaskOutcomeError(
        'accepted_task_outcome_stale',
        `Accepted task ${taskId} is already settled.`
      );
    }

    const evidence = taskEvidenceIndex(state, taskId);
    validateTaskOutcome({
      directive,
      acceptanceCriteria: current.acceptanceCriteria ?? [],
      evidence,
    });

    const effect = this.ports.recordModelTaskOutcome({ acceptedPlan: accepted, taskId });
    const nextAccepted = effect.nextAcceptedPlan;
    state.acceptedTaskPlan = nextAccepted;
    this.ports.refreshRuntimeState(state);

    const remainingTaskIds = nextAccepted.tasks
      .map((task) => task.taskId)
      .filter((candidate) => (
        !nextAccepted.completedTaskIds.includes(candidate)
        && !(nextAccepted.modelJudgedSufficientTaskIds ?? []).includes(candidate)
      ));
    const progress: AcceptedPlanBatchProgress = {
      actionIds: [],
      targetPaths: current.targets,
      workUnitIds: [],
      newlyCompletedTaskIds: [],
      completedTaskIds: nextAccepted.completedTaskIds,
      modelJudgedSufficientTaskIds: nextAccepted.modelJudgedSufficientTaskIds ?? [],
      newlyModelJudgedSufficientTaskIds: [taskId],
      remainingTaskIds,
    };
    const contextCompactRecord = buildTaskLocalCompactRecord({
      contextAssembly: state.contextAssembly,
      source: 'modelTaskOutcome',
      status: 'modelJudgedSufficient',
      planId: accepted.planId,
      runId: state.runId,
      taskId,
    });
    state.taskLocalCompactRecords = appendTaskLocalCompactRecord(
      state.taskLocalCompactRecords,
      contextCompactRecord
    );
    const savepointId = this.ports.createId('accepted-plan-task-outcome-savepoint');
    const result = await this.ports.append(state.sessionId, [
      this.ports.taskOutcomeCheckpointEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        accepted,
        nextAccepted,
        taskId,
        summary: directive.summary,
        evidenceRefs: directive.evidenceRefs,
        acceptanceResults: directive.acceptanceResults,
        evidenceRevision: state.resourceEvidenceRevision,
        progress,
        contextCompactRecord,
        ts: this.ports.now(),
        id: this.ports.createId('accepted-plan-task-outcome'),
      }),
      this.ports.taskSavepointEvent(
        state.sessionId,
        state.runId,
        accepted,
        nextAccepted,
        progress,
        [],
        state.taskExecutionCursor,
        state.currentTaskContext,
        this.ports.now(),
        savepointId,
        contextCompactRecord
      ),
    ]);
    if (state.taskExecutionCursor) state.taskExecutionCursor.lastSavepointId = savepointId;

    const planComplete = this.ports.complete(nextAccepted);
    if (planComplete) {
      state.pendingAcceptedTaskOutcomeReview = {
        taskId,
        summary: directive.summary,
        evidenceRefs: directive.evidenceRefs,
        result,
      };
    }
    return {
      kind: 'providerResume',
      toolResult: {
        status: 'accepted',
        outcome: directive.outcome,
        taskId,
        modelJudgedSufficient: true,
        planComplete,
        nextTaskId: state.currentTaskContext?.taskId,
        evidenceRevision: state.resourceEvidenceRevision,
      },
    };
  }
}

interface TaskEvidenceIndex {
  readonly allowedRefs: Set<string>;
  readonly packetIds: string[];
}

function taskEvidenceIndex(
  state: AcceptedTaskOutcomeCoordinatorState,
  taskId: string
): TaskEvidenceIndex {
  const packetIds = state.resourceRequestProgressByTask.get(taskId)?.packetIds ?? [];
  const packets = state.resourcePackets.filter((packet) => (
    packetIds.includes(packet.id)
    && packet.workspaceScopeKey === state.workspaceScopeKey
  ));
  const allowedRefs = new Set<string>();
  for (const packet of packets) {
    const validItems = packet.items.filter(validEvidenceItem);
    if (validItems.length > 0 && validItems.length === packet.items.length) {
      allowedRefs.add(packet.id);
    }
    for (const item of validItems) {
      allowedRefs.add(item.requestItemId);
      allowedRefs.add(item.manifestEntryId);
      if (item.contentHash) allowedRefs.add(item.contentHash);
      allowedRefs.add(`${packet.id}:${item.requestItemId}`);
    }
  }
  return { allowedRefs, packetIds: packets.map((packet) => packet.id) };
}

function validEvidenceItem(item: ResourcePacketItem): boolean {
  return (item.status === 'provided' || item.status === 'resolved')
    && item.truncated !== true
    && item.rangeComplete !== false;
}

function validateTaskOutcome(input: {
  directive: Extract<SessionSemanticDirective, { kind: 'taskOutcome' }>;
  acceptanceCriteria: string[];
  evidence: TaskEvidenceIndex;
}): void {
  const { directive, acceptanceCriteria, evidence } = input;
  if (!acceptanceCriteria.length) {
    throw new AcceptedTaskOutcomeError(
      'accepted_task_outcome_missing_acceptance_criteria',
      'alreadySatisfied requires explicit acceptance criteria on the current accepted task.'
    );
  }
  if (!evidence.packetIds.length || !evidence.allowedRefs.size) {
    throw new AcceptedTaskOutcomeError(
      'accepted_task_outcome_evidence_unavailable',
      'alreadySatisfied requires fresh, non-truncated ResourcePacket evidence resolved for the current task.'
    );
  }
  assertEvidenceRefs(directive.evidenceRefs, evidence.allowedRefs, 'session.submit_task_outcome.evidenceRefs');
  if (directive.acceptanceResults.length !== acceptanceCriteria.length) {
    throw new AcceptedTaskOutcomeError(
      'accepted_task_outcome_incomplete',
      `alreadySatisfied requires exactly ${acceptanceCriteria.length} acceptance result(s).`
    );
  }
  const seen = new Set<number>();
  const declaredRefs = new Set(directive.evidenceRefs);
  for (const result of directive.acceptanceResults) {
    if (result.criterionIndex > acceptanceCriteria.length || seen.has(result.criterionIndex)) {
      throw new AcceptedTaskOutcomeError(
        'accepted_task_outcome_incomplete',
        `Acceptance result index ${result.criterionIndex} is duplicate or outside the current task criteria.`
      );
    }
    seen.add(result.criterionIndex);
    assertEvidenceRefs(
      result.evidenceRefs,
      evidence.allowedRefs,
      `session.submit_task_outcome.acceptanceResults[${result.criterionIndex}]`
    );
    const undeclared = result.evidenceRefs.filter((ref) => !declaredRefs.has(ref));
    if (undeclared.length) {
      throw new AcceptedTaskOutcomeError(
        'accepted_task_outcome_evidence_invalid',
        `Acceptance result ${result.criterionIndex} references evidence absent from the top-level evidenceRefs.`
      );
    }
  }
}

function assertEvidenceRefs(refs: string[], allowed: Set<string>, field: string): void {
  if (!refs.length) {
    throw new AcceptedTaskOutcomeError(
      'accepted_task_outcome_evidence_invalid',
      `${field} must contain at least one fresh task-scoped evidence reference.`
    );
  }
  const invalid = refs.filter((ref) => !allowed.has(ref));
  if (invalid.length) {
    throw new AcceptedTaskOutcomeError(
      'accepted_task_outcome_evidence_invalid',
      `${field} contains unavailable, stale, or truncated evidence references: ${invalid.join(', ')}.`
    );
  }
}
