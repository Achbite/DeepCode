import type { AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import { AcceptedPlanProgressAggregator } from '../../accepted-plan/AcceptedPlanProgressAggregator.js';
import { AcceptedPlanScopeMatcher } from '../../accepted-plan/AcceptedPlanScopeMatcher.js';
import { AcceptedTaskRegistry } from '../../accepted-plan/AcceptedTaskRegistry.js';
import type {
  AcceptedPlanBatchProgress,
  AcceptedImplementationPlanContext,
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
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  resourcePackets: ResourcePacket[];
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshot;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
}

export interface AcceptedPlanTaskLedgerCoordinatorPorts {
  workUnitIdsFromKernelEvents(kernelEvents: unknown[]): string[];
  actionBatchHasFailureOrBlocker(kernelEvents: unknown[]): boolean;
}

export type AcceptedPlanLedgerCommand =
  | {
    kind: 'recordKernelBatchProgress';
    acceptedPlan: AcceptedImplementationPlanContext;
    proposal: ProposalEnvelope;
    kernelEvents: unknown[];
  }
  | {
    kind: 'recordModelTaskOutcome';
    acceptedPlan: AcceptedImplementationPlanContext;
    taskId: string;
  }
  | {
    kind: 'recoverLatestCheckpoint';
    acceptedPlan: AcceptedImplementationPlanContext;
    events: AgentEvent[];
  };

export type AcceptedPlanLedgerEffect =
  | {
    kind: 'kernelBatchProgressRecorded';
    progress: AcceptedPlanBatchProgress;
    completedTaskIds: string[];
    nextAcceptedPlan: AcceptedImplementationPlanContext;
  }
  | {
    kind: 'modelTaskOutcomeRecorded';
    taskId: string;
    nextAcceptedPlan: AcceptedImplementationPlanContext;
  }
  | {
    kind: 'latestCheckpointRecovered';
    nextAcceptedPlan: AcceptedImplementationPlanContext;
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
      return {
        kind: 'kernelBatchProgressRecorded',
        progress,
        completedTaskIds: progress.completedTaskIds,
        nextAcceptedPlan: this.afterBatch(command.acceptedPlan, progress.completedTaskIds),
      };
    }
    if (command.kind === 'recordModelTaskOutcome') {
      return {
        kind: 'modelTaskOutcomeRecorded',
        taskId: command.taskId,
        nextAcceptedPlan: this.afterTaskOutcome(command.acceptedPlan, command.taskId),
      };
    }
    return {
      kind: 'latestCheckpointRecovered',
      nextAcceptedPlan: this.withLatestCheckpoint(command.acceptedPlan, command.events),
    };
  }

  recordKernelBatchProgress(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
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
    acceptedPlan: AcceptedImplementationPlanContext;
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

  recoverLatestCheckpoint(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
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
    acceptedPlan?: AcceptedImplementationPlanContext;
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
    const snapshot = this.runtimeSnapshot({
      acceptedPlan: state.acceptedImplementationPlan,
      resourcePackets: state.resourcePackets,
      lastSavepointId: state.taskExecutionCursor?.lastSavepointId,
    });
    state.taskExecutionCursor = snapshot.taskExecutionCursor;
    state.currentTaskContext = snapshot.currentTaskContext;
    state.taskLedger = snapshot.taskLedger;
    state.acceptedPlanPromptFrame = snapshot.acceptedPlanPromptFrame;
  }

  ledger(
    acceptedPlan: AcceptedImplementationPlanContext | undefined,
    failedTaskId?: string,
    skippedTaskIds: string[] = [],
    acceptedIncompleteTaskIds: string[] = []
  ): TaskLedgerSnapshot | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).ledger(
      failedTaskId,
      skippedTaskIds,
      acceptedIncompleteTaskIds
    );
  }

  promptFrame(
    acceptedPlan: AcceptedImplementationPlanContext | undefined,
    taskLedger: TaskLedgerSnapshot | undefined
  ): AcceptedPlanPromptFrame | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).promptFrame(taskLedger);
  }

  cursor(
    acceptedPlan: AcceptedImplementationPlanContext | undefined,
    resourcePackets: ResourcePacket[],
    lastSavepointId?: string
  ): TaskExecutionCursor | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).cursor(resourcePackets, lastSavepointId);
  }

  currentTaskContext(
    acceptedPlan: AcceptedImplementationPlanContext | undefined,
    cursor: TaskExecutionCursor | undefined
  ): CurrentTaskContext | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).currentTaskContext(cursor);
  }

  memoryHints(context: CurrentTaskContext | undefined): string[] {
    if (!context) return [];
    return [
      'CurrentTaskGoal:',
      context.goal,
      `CurrentTaskContext: taskId=${context.taskId ?? 'none'}; targets=${context.targets.join(', ') || 'none'}; capabilities=${context.capabilities.join(', ') || 'none'}; completedTasks=${context.completedTaskIds.length}.`,
    ];
  }

  withCompleted(
    acceptedPlan: AcceptedImplementationPlanContext | undefined,
    completedTaskIds: string[]
  ): AcceptedImplementationPlanContext | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).withCompleted(completedTaskIds);
  }

  batchProgress(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
    proposal: ProposalEnvelope;
    kernelEvents: unknown[];
  }): AcceptedPlanBatchProgress {
    if (!this.ports) {
      throw new Error('AcceptedPlanTaskLedgerCoordinator batchProgress requires kernel event ports.');
    }
    return new AcceptedPlanProgressAggregator({
      scopeMatcher: new AcceptedPlanScopeMatcher(),
      workUnitIdsFromKernelEvents: this.ports.workUnitIdsFromKernelEvents,
      actionBatchHasFailureOrBlocker: this.ports.actionBatchHasFailureOrBlocker,
    }).progress(input.acceptedPlan, input.proposal, input.kernelEvents);
  }

  afterBatch(
    acceptedPlan: AcceptedImplementationPlanContext,
    completedTaskIds: string[]
  ): AcceptedImplementationPlanContext {
    return this.withCompleted(acceptedPlan, completedTaskIds) ?? acceptedPlan;
  }

  afterTaskOutcome(
    acceptedPlan: AcceptedImplementationPlanContext,
    taskId: string
  ): AcceptedImplementationPlanContext {
    return new AcceptedTaskRegistry(acceptedPlan).withModelJudgedSufficient(taskId) ?? acceptedPlan;
  }

  withLatestCheckpoint(
    acceptedPlan: AcceptedImplementationPlanContext,
    events: AgentEvent[]
  ): AcceptedImplementationPlanContext {
    for (const event of [...events].reverse()) {
      if (event.kind !== 'workflow_stage') continue;
      const payload = objectRecord(event.payload);
      if (!payload) continue;
      if (stringValue(payload.stage) !== 'accepted_plan.batch_checkpoint') continue;
      if (stringValue(payload.runId) !== acceptedPlan.runId || stringValue(payload.planId) !== acceptedPlan.planId) continue;
      const completedTaskIds = stringArrayValue(payload.completedTaskIds);
      const modelJudgedSufficientTaskIds = stringArrayValue(payload.modelJudgedSufficientTaskIds);
      let nextAccepted = acceptedPlan;
      if (completedTaskIds.length) nextAccepted = this.afterBatch(nextAccepted, completedTaskIds);
      for (const taskId of modelJudgedSufficientTaskIds) {
        nextAccepted = this.afterTaskOutcome(nextAccepted, taskId);
      }
      return nextAccepted;
    }
    return acceptedPlan;
  }

  complete(acceptedPlan: AcceptedImplementationPlanContext): boolean {
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
