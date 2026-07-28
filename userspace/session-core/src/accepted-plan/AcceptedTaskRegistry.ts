import type {
  TaskFailureV2,
  TaskLedgerSnapshotV2,
  TaskSettlementV2,
} from '@deepcode/protocol';
import { stableHash } from '../cache/canonicalizer.js';
import type { ResourcePacket } from '../context/types.js';
import {
  activeTaskEntry,
  buildAcceptedPlanPromptFrame,
  failTaskLedgerV2,
  parseTaskLedgerV2,
  settleTaskLedgerV2,
  taskLedgerAllSettled,
  taskLedgerKernelCompletedTaskIds,
  type AcceptedPlanPromptFrame,
} from '../run-state/index.js';
import type {
  AcceptedTaskPlanContext,
  CurrentTaskContext,
  TaskExecutionCursor,
} from './types.js';

export class AcceptedTaskRegistry {
  constructor(private readonly acceptedPlan: AcceptedTaskPlanContext | undefined) {}

  ledger(): TaskLedgerSnapshotV2 | undefined {
    return this.acceptedPlan
      ? parseTaskLedgerV2(this.acceptedPlan.taskLedger)
      : undefined;
  }

  promptFrame(
    taskLedger?: TaskLedgerSnapshotV2
  ): AcceptedPlanPromptFrame | undefined {
    const acceptedPlan = this.acceptedPlan;
    const ledger = taskLedger ?? this.ledger();
    if (!acceptedPlan || !ledger) return undefined;
    return buildAcceptedPlanPromptFrame({
      planId: acceptedPlan.planId,
      runId: acceptedPlan.runId,
      title: acceptedPlan.title,
      summary: acceptedPlan.summary,
      taskLedger: ledger,
    });
  }

  cursor(
    resourcePackets: ResourcePacket[],
    lastSavepointId?: string
  ): TaskExecutionCursor | undefined {
    const acceptedPlan = this.acceptedPlan;
    const ledger = this.ledger();
    if (!acceptedPlan || !ledger) return undefined;
    const lastResourcePacketIds = resourcePackets
      .map((packet) => packet.id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .slice(-6);
    const cursorKey = [
      acceptedPlan.planId,
      ledger.revision,
      ledger.currentTaskId ?? 'none',
      ledger.settledTaskIds.join(','),
      lastResourcePacketIds.join(','),
      lastSavepointId ?? '',
    ].join('|');
    return {
      cursorId: `task-cursor-${stableHash(cursorKey).slice(0, 16)}`,
      planId: acceptedPlan.planId,
      currentTaskId: ledger.currentTaskId,
      taskOrder: ledger.taskOrder,
      pendingTaskIds: ledger.pendingTaskIds,
      settledTaskIds: ledger.settledTaskIds,
      kernelCompletedTaskIds: taskLedgerKernelCompletedTaskIds(ledger),
      lastResourcePacketIds,
      lastSavepointId,
    };
  }

  currentTaskContext(
    cursor: TaskExecutionCursor | undefined
  ): CurrentTaskContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    const ledger = this.ledger();
    if (!acceptedPlan || !cursor || !ledger) return undefined;
    const task = acceptedPlan.tasks.find(
      (item) => item.taskId === ledger.currentTaskId
    );
    if (!task) return undefined;
    const targets = [...new Set(
      task.targets.map(normalizeTaskContextPath).filter(Boolean)
    )];
    const toolIds = [task.toolId].filter(
      (item): item is string => Boolean(item?.trim())
    );
    const goalParts = [
      acceptedPlan.title ?? acceptedPlan.summary ?? acceptedPlan.planId,
      `task=${task.taskId}${task.title ? ` ${task.title}` : ''}`,
      targets.length ? `targets=${targets.join(', ')}` : '',
    ].filter(Boolean);
    return {
      goal: goalParts.join(' | '),
      taskId: task.taskId,
      nodeId: undefined,
      taskTitle: task.title,
      targets,
      toolIds,
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      failureCriteria: task.failureCriteria ?? [],
      taskOrder: cursor.taskOrder,
      pendingTaskIds: cursor.pendingTaskIds,
      dependsOn: task.dependencies,
      evidenceNeeds: [],
      settledTaskIds: cursor.settledTaskIds,
      kernelCompletedTaskIds: cursor.kernelCompletedTaskIds,
    };
  }

  settle(input: {
    taskId: string;
    settlement: TaskSettlementV2;
    sourceRefs: readonly string[];
  }): AcceptedTaskPlanContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    return this.withLedger(settleTaskLedgerV2({
      ledger: acceptedPlan.taskLedger,
      taskId: input.taskId,
      settlement: input.settlement,
      sourceRefs: input.sourceRefs,
    }));
  }

  fail(input: {
    taskId: string;
    failure: TaskFailureV2;
    sourceRefs: readonly string[];
  }): AcceptedTaskPlanContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    return this.withLedger(failTaskLedgerV2({
      ledger: acceptedPlan.taskLedger,
      taskId: input.taskId,
      failure: input.failure,
      sourceRefs: input.sourceRefs,
    }));
  }

  withLedger(taskLedger: TaskLedgerSnapshotV2): AcceptedTaskPlanContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    const ledger = parseTaskLedgerV2(taskLedger);
    if (
      ledger.owner.planId !== acceptedPlan.planId
      || (
        ledger.owner.kind === 'run'
        && ledger.owner.runId !== acceptedPlan.runId
      )
    ) {
      throw new Error(
        'session_task_ledger_owner_mismatch: accepted plan and TaskLedgerV2 owner disagree.'
      );
    }
    const activeIndex = ledger.currentTaskId
      ? ledger.taskOrder.indexOf(ledger.currentTaskId)
      : -1;
    return {
      ...acceptedPlan,
      taskLedger: ledger,
      batchIndex: activeIndex >= 0
        ? activeIndex + 1
        : acceptedPlan.tasks.length + 1,
    };
  }

  complete(): boolean {
    const ledger = this.ledger();
    return ledger ? taskLedgerAllSettled(ledger) : false;
  }

  activeTaskId(): string | undefined {
    const ledger = this.ledger();
    return ledger ? activeTaskEntry(ledger)?.taskId : undefined;
  }
}

function normalizeTaskContextPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}
