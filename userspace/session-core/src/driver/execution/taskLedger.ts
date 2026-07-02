import type { AgentEvent } from '@deepcode/protocol';
import { AcceptedTaskRegistry } from '../../accepted-plan/AcceptedTaskRegistry.js';
import type {
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

export class AcceptedPlanTaskLedgerCoordinator {
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
