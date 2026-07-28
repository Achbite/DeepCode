import type {
  AgentEvent,
  SessionGoalInteractionRefV1,
  TaskLedgerSnapshotV2,
} from '@deepcode/protocol';
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
import {
  parseTaskLedgerV2,
  readLegacyTaskLedgerV1,
  type AcceptedPlanPromptFrame,
} from '../../run-state/index.js';

export interface AcceptedPlanTaskRuntimeSnapshot {
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshotV2;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
}

export interface AcceptedPlanTaskRuntimeState {
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  resourcePackets: ResourcePacket[];
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshotV2;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
}

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

export type AcceptedPlanLedgerCommand =
  | {
      kind: 'recordKernelBatchProgress';
      acceptedPlan: AcceptedTaskPlanContext;
      proposal: ProposalEnvelope;
      kernelEvents: AgentEvent[];
    }
  | {
      kind: 'recordUserTaskSettlement';
      acceptedPlan: AcceptedTaskPlanContext;
      taskIds: string[];
      outcome: 'skipped' | 'acceptedIncomplete';
      interaction: SessionGoalInteractionRefV1;
      decisionEventRef: string;
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
      nextAcceptedPlan: AcceptedTaskPlanContext;
    }
  | {
      kind: 'userTaskSettlementRecorded';
      settledTaskIds: string[];
      nextAcceptedPlan: AcceptedTaskPlanContext;
    }
  | {
      kind: 'latestCheckpointRecovered';
      nextAcceptedPlan: AcceptedTaskPlanContext;
    };

export class AcceptedPlanTaskLedgerCoordinator {
  execute(command: AcceptedPlanLedgerCommand): AcceptedPlanLedgerEffect {
    if (command.kind === 'recordKernelBatchProgress') {
      const progress = new AcceptedPlanProgressAggregator().progress(
        command.acceptedPlan,
        command.proposal,
        command.kernelEvents
      );
      const dependencyFacts = progress.newlySettledTaskIds.flatMap((taskId) =>
        taskDependencyFactsFromKernelEvents(taskId, command.kernelEvents)
      );
      const nextAcceptedPlan = new AcceptedTaskRegistry(
        command.acceptedPlan
      ).withLedger(progress.taskLedger);
      if (!nextAcceptedPlan) {
        throw new Error(
          'session_task_ledger_transition_invalid: Kernel settlement did not produce an accepted plan.'
        );
      }
      const facts = new Map(
        [...command.acceptedPlan.dependencyFacts, ...dependencyFacts]
          .map((fact) => [fact.factRef, fact] as const)
      );
      return {
        kind: 'kernelBatchProgressRecorded',
        progress,
        nextAcceptedPlan: {
          ...nextAcceptedPlan,
          dependencyFacts: [...facts.values()],
        },
      };
    }
    if (command.kind === 'recordUserTaskSettlement') {
      let nextAcceptedPlan = command.acceptedPlan;
      const settledTaskIds: string[] = [];
      for (const taskId of command.taskIds) {
        const activeTaskId = nextAcceptedPlan.taskLedger.currentTaskId;
        if (taskId !== activeTaskId) {
          throw new Error(
            `session_task_ledger_transition_invalid: user decision task ${taskId} is not the exact active task ${activeTaskId ?? '<none>'}.`
          );
        }
        const next = new AcceptedTaskRegistry(nextAcceptedPlan).settle({
          taskId,
          settlement: {
            kind: 'userDecision',
            outcome: command.outcome,
            interaction: command.interaction,
            decisionEventRef: command.decisionEventRef,
          },
          sourceRefs: [command.decisionEventRef],
        });
        if (!next) {
          throw new Error(
            'session_task_ledger_transition_invalid: user settlement did not produce an accepted plan.'
          );
        }
        nextAcceptedPlan = next;
        settledTaskIds.push(taskId);
      }
      return {
        kind: 'userTaskSettlementRecorded',
        settledTaskIds,
        nextAcceptedPlan,
      };
    }
    return {
      kind: 'latestCheckpointRecovered',
      nextAcceptedPlan: this.withLatestCheckpoint(
        command.acceptedPlan,
        command.events
      ),
    };
  }

  recordKernelBatchProgress(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    proposal: ProposalEnvelope;
    kernelEvents: AgentEvent[];
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

  recordUserTaskSettlement(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    taskIds: string[];
    outcome: 'skipped' | 'acceptedIncomplete';
    interaction: SessionGoalInteractionRefV1;
    decisionEventRef: string;
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
    const currentTaskContext = this.currentTaskContext(
      input.acceptedPlan,
      taskExecutionCursor
    );
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
    acceptedPlan: AcceptedTaskPlanContext | undefined
  ): TaskLedgerSnapshotV2 | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).ledger();
  }

  promptFrame(
    acceptedPlan: AcceptedTaskPlanContext | undefined,
    taskLedger: TaskLedgerSnapshotV2 | undefined
  ): AcceptedPlanPromptFrame | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).promptFrame(taskLedger);
  }

  cursor(
    acceptedPlan: AcceptedTaskPlanContext | undefined,
    resourcePackets: ResourcePacket[],
    lastSavepointId?: string
  ): TaskExecutionCursor | undefined {
    return new AcceptedTaskRegistry(acceptedPlan).cursor(
      resourcePackets,
      lastSavepointId
    );
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
      `CurrentTaskContext: taskId=${context.taskId ?? 'none'}; targets=${context.targets.join(', ') || 'none'}; toolIds=${context.toolIds.join(', ') || 'none'}; settledTasks=${context.settledTaskIds.length}.`,
    ];
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

  private withLatestCheckpoint(
    acceptedPlan: AcceptedTaskPlanContext,
    events: AgentEvent[]
  ): AcceptedTaskPlanContext {
    for (const event of [...events].reverse()) {
      if (event.kind !== 'workflow_stage') continue;
      const payload = objectRecord(event.payload);
      if (!payload) continue;
      if (stringValue(payload.stage) !== 'accepted_plan.batch_checkpoint') continue;
      if (
        stringValue(payload.runId) !== acceptedPlan.runId
        || stringValue(payload.planId) !== acceptedPlan.planId
      ) {
        continue;
      }
      const taskLedger = objectRecord(payload.taskLedger);
      if (!taskLedger) return acceptedPlan;
      if (readLegacyTaskLedgerV1(taskLedger)) {
        throw new Error(
          'session_task_ledger_legacy_read_only: TaskLedgerV1 checkpoints may be viewed but not continued.'
        );
      }
      const parsed = parseTaskLedgerV2(taskLedger);
      const next = new AcceptedTaskRegistry(acceptedPlan).withLedger(parsed);
      if (!next) {
        throw new Error(
          'session_task_ledger_transition_invalid: checkpoint TaskLedgerV2 could not be restored.'
        );
      }
      return {
        ...next,
        dependencyFacts: taskDependencyFactArray(payload.dependencyFacts),
      };
    }
    return acceptedPlan;
  }
}

function taskDependencyFactArray(
  value: unknown
): AcceptedTaskPlanContext['dependencyFacts'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectRecord(item);
    const taskId = stringValue(record?.taskId);
    const factRef = stringValue(record?.factRef);
    const toolCallId = stringValue(record?.toolCallId);
    const workUnitId = stringValue(record?.workUnitId);
    const toolId = stringValue(record?.toolId);
    const path = stringValue(record?.path);
    if (!taskId || !factRef || !toolCallId || !workUnitId || !toolId || !path) {
      return [];
    }
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
      executable: typeof record?.executable === 'boolean'
        ? record.executable
        : undefined,
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

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    ? value
    : undefined;
}
