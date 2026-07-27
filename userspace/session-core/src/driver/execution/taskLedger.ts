import type { AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import { AcceptedPlanProgressAggregator } from '../../accepted-plan/AcceptedPlanProgressAggregator.js';
import { AcceptedTaskRegistry } from '../../accepted-plan/AcceptedTaskRegistry.js';
import { taskDependencyFactsFromKernelEvents } from '../../accepted-plan/TaskDependencyFacts.js';
import type {
  AcceptedPlanBatchProgress,
  AcceptedTaskPlanContext,
  CurrentTaskContext,
  TaskExecutionCursor,
} from '../../accepted-plan/types.js';
import type { ResourcePacket } from '../../context/types.js';
import type {
  AcceptedPlanPromptFrame,
  TaskLedgerSnapshot,
} from '../../run-state/index.js';

export interface AcceptedPlanTaskRuntimeSnapshot {
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshot;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
}

export interface AcceptedPlanTaskRuntimeState {
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  resourcePackets: ResourcePacket[];
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshot;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
}

// The accepted-plan runtime fields are a single snapshot boundary for task projection and provider context.
export class AcceptedPlanTaskRuntimeAccessor {
  constructor(private readonly state: AcceptedPlanTaskRuntimeState) {}

  snapshotInput(): {
    acceptedPlan?: AcceptedTaskPlanContext;
    resourcePackets: ResourcePacket[];
    lastSavepointId?: string;
  } {
    return {
      acceptedPlan: this.state.acceptedTaskPlan,
      resourcePackets: this.state.resourcePackets,
      lastSavepointId: this.state.taskExecutionCursor?.lastSavepointId,
    };
  }

  apply(snapshot: AcceptedPlanTaskRuntimeSnapshot): void {
    this.state.taskExecutionCursor = snapshot.taskExecutionCursor;
    this.state.currentTaskContext = snapshot.currentTaskContext;
    this.state.taskLedger = snapshot.taskLedger;
    this.state.acceptedPlanPromptFrame = snapshot.acceptedPlanPromptFrame;
  }
}

export interface AcceptedPlanTaskLedgerCoordinatorPorts {
  workUnitIdsFromKernelEvents(kernelEvents: unknown[]): string[];
  actionBatchHasFailureOrBlocker(kernelEvents: unknown[]): boolean;
}

export type AcceptedPlanLedgerCommand =
  | {
    kind: 'recordKernelBatchProgress';
    acceptedPlan: AcceptedTaskPlanContext;
    proposal: ProposalEnvelope;
    kernelEvents: unknown[];
  }
  | {
    kind: 'recordModelTaskOutcome';
    acceptedPlan: AcceptedTaskPlanContext;
    taskId: string;
  }
  | {
    kind: 'recordTaskCompletion';
    acceptedPlan: AcceptedTaskPlanContext;
    completedTaskIds: string[];
  }
  | {
    kind: 'recordUserTaskSettlement';
    acceptedPlan: AcceptedTaskPlanContext;
    skippedTaskIds?: string[];
    acceptedIncompleteTaskIds?: string[];
  }
  | {
    kind: 'recoverLatestCheckpoint';
    acceptedPlan: AcceptedTaskPlanContext;
    events: AgentEvent[];
  };

export type AcceptedPlanLedgerEffect =
  | {
    kind: 'kernelBatchProgressRecorded';
    progress: AcceptedPlanBatchProgress;
    completedTaskIds: string[];
    nextAcceptedPlan: AcceptedTaskPlanContext;
  }
  | {
    kind: 'modelTaskOutcomeRecorded';
    taskId: string;
    nextAcceptedPlan: AcceptedTaskPlanContext;
  }
  | {
    kind: 'taskCompletionRecorded';
    completedTaskIds: string[];
    nextAcceptedPlan: AcceptedTaskPlanContext;
  }
  | {
    kind: 'userTaskSettlementRecorded';
    skippedTaskIds: string[];
    acceptedIncompleteTaskIds: string[];
    nextAcceptedPlan: AcceptedTaskPlanContext;
  }
  | {
    kind: 'latestCheckpointRecovered';
    nextAcceptedPlan: AcceptedTaskPlanContext;
  };

export class AcceptedPlanTaskLedgerCoordinator {
  constructor(private readonly ports?: AcceptedPlanTaskLedgerCoordinatorPorts) {}

  // Accepted-plan ledger mutations are command effects so projections and cursors share one state transition owner.
  execute(command: AcceptedPlanLedgerCommand): AcceptedPlanLedgerEffect {
    if (command.kind === 'recordKernelBatchProgress') {
      const progress = this.batchProgress({
        acceptedPlan: command.acceptedPlan,
        proposal: command.proposal,
        kernelEvents: command.kernelEvents,
      });
      const newDependencyFacts = progress.newlyCompletedTaskIds.flatMap((taskId) =>
        taskDependencyFactsFromKernelEvents(taskId, command.kernelEvents)
      );
      return {
        kind: 'kernelBatchProgressRecorded',
        progress,
        completedTaskIds: progress.completedTaskIds,
        nextAcceptedPlan: this.afterBatch(
          command.acceptedPlan,
          progress.completedTaskIds,
          newDependencyFacts
        ),
      };
    }
    if (command.kind === 'recordModelTaskOutcome') {
      return {
        kind: 'modelTaskOutcomeRecorded',
        taskId: command.taskId,
        nextAcceptedPlan: this.afterTaskOutcome(command.acceptedPlan, command.taskId),
      };
    }
    if (command.kind === 'recordTaskCompletion') {
      return {
        kind: 'taskCompletionRecorded',
        completedTaskIds: command.completedTaskIds,
        nextAcceptedPlan: this.afterBatch(command.acceptedPlan, command.completedTaskIds),
      };
    }
    if (command.kind === 'recordUserTaskSettlement') {
      return {
        kind: 'userTaskSettlementRecorded',
        skippedTaskIds: command.skippedTaskIds ?? [],
        acceptedIncompleteTaskIds: command.acceptedIncompleteTaskIds ?? [],
        nextAcceptedPlan: new AcceptedTaskRegistry(command.acceptedPlan).withUserSettled({
          skippedTaskIds: command.skippedTaskIds,
          acceptedIncompleteTaskIds: command.acceptedIncompleteTaskIds,
        }) ?? command.acceptedPlan,
      };
    }
    return {
      kind: 'latestCheckpointRecovered',
      nextAcceptedPlan: this.withLatestCheckpoint(command.acceptedPlan, command.events),
    };
  }

  recordKernelBatchProgress(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    proposal: ProposalEnvelope;
    kernelEvents: unknown[];
  }): Extract<AcceptedPlanLedgerEffect, { kind: 'kernelBatchProgressRecorded' }> {
    const effect = this.execute({
      kind: 'recordKernelBatchProgress',
      ...input,
    });
    if (effect.kind !== 'kernelBatchProgressRecorded') {
      throw new Error(`Unexpected accepted-plan ledger effect: ${effect.kind}`);
    }
    return effect;
  }

  recordModelTaskOutcome(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    taskId: string;
  }): Extract<AcceptedPlanLedgerEffect, { kind: 'modelTaskOutcomeRecorded' }> {
    const effect = this.execute({
      kind: 'recordModelTaskOutcome',
      ...input,
    });
    if (effect.kind !== 'modelTaskOutcomeRecorded') {
      throw new Error(`Unexpected accepted-plan ledger effect: ${effect.kind}`);
    }
    return effect;
  }

  recordTaskCompletion(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    completedTaskIds: string[];
  }): Extract<AcceptedPlanLedgerEffect, { kind: 'taskCompletionRecorded' }> {
    const effect = this.execute({
      kind: 'recordTaskCompletion',
      ...input,
    });
    if (effect.kind !== 'taskCompletionRecorded') {
      throw new Error(`Unexpected accepted-plan ledger effect: ${effect.kind}`);
    }
    return effect;
  }

  recordUserTaskSettlement(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    skippedTaskIds?: string[];
    acceptedIncompleteTaskIds?: string[];
  }): Extract<AcceptedPlanLedgerEffect, { kind: 'userTaskSettlementRecorded' }> {
    const effect = this.execute({
      kind: 'recordUserTaskSettlement',
      ...input,
    });
    if (effect.kind !== 'userTaskSettlementRecorded') {
      throw new Error(`Unexpected accepted-plan ledger effect: ${effect.kind}`);
    }
    return effect;
  }

  recoverLatestCheckpoint(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    events: AgentEvent[];
  }): Extract<AcceptedPlanLedgerEffect, { kind: 'latestCheckpointRecovered' }> {
    const effect = this.execute({
      kind: 'recoverLatestCheckpoint',
      ...input,
    });
    if (effect.kind !== 'latestCheckpointRecovered') {
      throw new Error(`Unexpected accepted-plan ledger effect: ${effect.kind}`);
    }
    return effect;
  }

  runtimeSnapshot(input: {
    acceptedPlan?: AcceptedTaskPlanContext;
    resourcePackets: ResourcePacket[];
    lastSavepointId?: string;
  }): AcceptedPlanTaskRuntimeSnapshot {
    const taskExecutionCursor = this.cursor(
      input.acceptedPlan,
      input.resourcePackets,
      input.lastSavepointId
    );
    const currentTaskContext = this.currentTaskContext(input.acceptedPlan, taskExecutionCursor);
    const taskLedger = this.ledger(input.acceptedPlan);
    return {
      taskExecutionCursor,
      currentTaskContext,
      taskLedger,
      acceptedPlanPromptFrame: this.promptFrame(input.acceptedPlan, taskLedger),
    };
  }

  refreshRuntimeState(state: AcceptedPlanTaskRuntimeState): void {
    const runtime = new AcceptedPlanTaskRuntimeAccessor(state);
    runtime.apply(this.runtimeSnapshot(runtime.snapshotInput()));
  }

  ledger(
    acceptedPlan: AcceptedTaskPlanContext | undefined,
    failedTaskId?: string,
    skippedTaskIds?: string[],
    acceptedIncompleteTaskIds?: string[]
  ): TaskLedgerSnapshot | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).ledger(
      failedTaskId,
      skippedTaskIds ?? acceptedPlan?.skippedTaskIds ?? [],
      acceptedIncompleteTaskIds ?? acceptedPlan?.acceptedIncompleteTaskIds ?? []
    );
  }

  promptFrame(
    acceptedPlan: AcceptedTaskPlanContext | undefined,
    taskLedger: TaskLedgerSnapshot | undefined
  ): AcceptedPlanPromptFrame | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).promptFrame(taskLedger);
  }

  cursor(
    acceptedPlan: AcceptedTaskPlanContext | undefined,
    resourcePackets: ResourcePacket[],
    lastSavepointId?: string
  ): TaskExecutionCursor | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).cursor(resourcePackets, lastSavepointId);
  }

  currentTaskContext(
    acceptedPlan: AcceptedTaskPlanContext | undefined,
    cursor: TaskExecutionCursor | undefined
  ): CurrentTaskContext | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).currentTaskContext(cursor);
  }

  memoryHints(context: CurrentTaskContext | undefined): string[] {
    if (!context) return [];
    return [
      'CurrentTaskGoal:',
      context.goal,
      `CurrentTaskContext: taskId=${context.taskId ?? 'none'}; targets=${context.targets.join(', ') || 'none'}; toolIds=${context.toolIds.join(', ') || 'none'}; completedTasks=${context.completedTaskIds.length}.`,
    ];
  }

  withCompleted(
    acceptedPlan: AcceptedTaskPlanContext | undefined,
    completedTaskIds: string[]
  ): AcceptedTaskPlanContext | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).withCompleted(completedTaskIds);
  }

  batchProgress(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    proposal: ProposalEnvelope;
    kernelEvents: unknown[];
  }): AcceptedPlanBatchProgress {
    if (!this.ports) {
      throw new Error('AcceptedPlanTaskLedgerCoordinator batchProgress requires kernel event ports.');
    }
    return new AcceptedPlanProgressAggregator({
      workUnitIdsFromKernelEvents: this.ports.workUnitIdsFromKernelEvents,
      actionBatchHasFailureOrBlocker: this.ports.actionBatchHasFailureOrBlocker,
    }).progress(input.acceptedPlan, input.proposal, input.kernelEvents);
  }

  afterBatch(
    acceptedPlan: AcceptedTaskPlanContext,
    completedTaskIds: string[],
    dependencyFacts: AcceptedTaskPlanContext['dependencyFacts'] = []
  ): AcceptedTaskPlanContext {
    const completed = this.withCompleted(acceptedPlan, completedTaskIds) ?? acceptedPlan;
    const facts = new Map(
      [...(acceptedPlan.dependencyFacts ?? []), ...dependencyFacts]
        .map((fact) => [fact.factRef, fact] as const)
    );
    return { ...completed, dependencyFacts: [...facts.values()] };
  }

  afterTaskOutcome(
    acceptedPlan: AcceptedTaskPlanContext,
    taskId: string
  ): AcceptedTaskPlanContext {
    return new AcceptedTaskRegistry(acceptedPlan).withModelJudgedSufficient(taskId) ?? acceptedPlan;
  }

  withLatestCheckpoint(
    acceptedPlan: AcceptedTaskPlanContext,
    events: AgentEvent[]
  ): AcceptedTaskPlanContext {
    for (const event of [...events].reverse()) {
      if (event.kind !== 'workflow_stage') continue;
      const payload = objectRecord(event.payload);
      if (!payload) continue;
      if (stringValue(payload.stage) !== 'accepted_plan.batch_checkpoint') continue;
      if (stringValue(payload.runId) !== acceptedPlan.runId || stringValue(payload.planId) !== acceptedPlan.planId) continue;
      const taskLedger = objectRecord(payload.taskLedger);
      const skippedTaskIds = stringArrayValue(payload.skippedTaskIds).length
        ? stringArrayValue(payload.skippedTaskIds)
        : stringArrayValue(taskLedger?.skippedTaskIds);
      const acceptedIncompleteTaskIds = stringArrayValue(payload.acceptedIncompleteTaskIds).length
        ? stringArrayValue(payload.acceptedIncompleteTaskIds)
        : stringArrayValue(taskLedger?.acceptedIncompleteTaskIds);
      const userSettledTaskIds = new Set([
        ...skippedTaskIds,
        ...acceptedIncompleteTaskIds,
      ]);
      // Older requirement checkpoints placed user-settled tasks in
      // completedTaskIds as a cursor shortcut. Recover their explicit
      // authority category instead of upgrading them to Kernel completion.
      const completedTaskIds = stringArrayValue(payload.completedTaskIds)
        .filter((taskId) => !userSettledTaskIds.has(taskId));
      const modelJudgedSufficientTaskIds = stringArrayValue(payload.modelJudgedSufficientTaskIds)
        .filter((taskId) => !userSettledTaskIds.has(taskId));
      const dependencyFacts = taskDependencyFactArray(payload.dependencyFacts);
      let nextAccepted = acceptedPlan;
      if (completedTaskIds.length) {
        nextAccepted = this.afterBatch(nextAccepted, completedTaskIds, dependencyFacts);
      }
      for (const taskId of modelJudgedSufficientTaskIds) {
        nextAccepted = this.afterTaskOutcome(nextAccepted, taskId);
      }
      if (skippedTaskIds.length || acceptedIncompleteTaskIds.length) {
        nextAccepted = new AcceptedTaskRegistry(nextAccepted).withUserSettled({
          skippedTaskIds,
          acceptedIncompleteTaskIds,
        }) ?? nextAccepted;
      }
      return nextAccepted;
    }
    return acceptedPlan;
  }

  complete(acceptedPlan: AcceptedTaskPlanContext): boolean {
    return new AcceptedTaskRegistry(acceptedPlan).complete();
  }

  lastSavepointId(events: AgentEvent[]): string | undefined {
    for (const event of [...events].reverse()) {
      if (event.kind !== 'workflow_stage') continue;
      const payload = objectRecord(event.payload);
      if (stringValue(payload?.stage) !== 'accepted_plan.task_savepoint') continue;
      return event.id;
    }
    return undefined;
  }
}

function taskDependencyFactArray(value: unknown): AcceptedTaskPlanContext['dependencyFacts'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectRecord(item);
    const taskId = stringValue(record?.taskId);
    const factRef = stringValue(record?.factRef);
    const toolCallId = stringValue(record?.toolCallId);
    const workUnitId = stringValue(record?.workUnitId);
    const toolId = stringValue(record?.toolId);
    const path = stringValue(record?.path);
    if (!taskId || !factRef || !toolCallId || !workUnitId || !toolId || !path) return [];
    return [{
      taskId,
      factRef,
      toolCallId,
      workUnitId,
      toolId,
      path,
      operation: stringValue(record?.operation),
      contentHash: stringValue(record?.contentHash),
      sizeBytes: integerValue(record?.sizeBytes),
      mode: integerValue(record?.mode),
      executable: typeof record?.executable === 'boolean' ? record.executable : undefined,
    }];
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
