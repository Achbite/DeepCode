import { stableHash } from '../cache/canonicalizer.js';
import type { ResourcePacket } from '../context/types.js';
import {
  buildAcceptedPlanPromptFrame,
  buildTaskLedgerSnapshot,
  type AcceptedPlanPromptFrame,
  type TaskLedgerSnapshot,
} from '../run-state/index.js';
import type {
  AcceptedTaskPlanContext,
  CurrentTaskContext,
  TaskExecutionCursor,
} from './types.js';
import { acceptedPlanSettledTaskIds } from './types.js';

export class AcceptedTaskRegistry {
  constructor(private readonly acceptedPlan: AcceptedTaskPlanContext | undefined) {}

  ledger(
    failedTaskId?: string,
    skippedTaskIds: string[] = this.acceptedPlan?.skippedTaskIds ?? [],
    acceptedIncompleteTaskIds: string[] = this.acceptedPlan?.acceptedIncompleteTaskIds ?? []
  ): TaskLedgerSnapshot | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    const completed = new Set(acceptedPlan.completedTaskIds);
    const modelJudgedSufficient = new Set(acceptedPlan.modelJudgedSufficientTaskIds ?? []);
    const currentTask = acceptedPlan.tasks.find((task) =>
      !completed.has(task.taskId) &&
      !modelJudgedSufficient.has(task.taskId) &&
      task.taskId !== failedTaskId &&
      !skippedTaskIds.includes(task.taskId) &&
      !acceptedIncompleteTaskIds.includes(task.taskId)
    );
    return buildTaskLedgerSnapshot({
      planId: acceptedPlan.planId,
      runId: acceptedPlan.runId,
      tasks: acceptedPlan.tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        targets: task.targets,
        toolId: task.toolId,
      })),
      completedTaskIds: acceptedPlan.completedTaskIds,
      modelJudgedSufficientTaskIds: acceptedPlan.modelJudgedSufficientTaskIds ?? [],
      failedTaskId,
      skippedTaskIds,
      acceptedIncompleteTaskIds,
      currentTaskId: currentTask?.taskId,
    });
  }

  promptFrame(taskLedger?: TaskLedgerSnapshot): AcceptedPlanPromptFrame | undefined {
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

  cursor(resourcePackets: ResourcePacket[], lastSavepointId?: string): TaskExecutionCursor | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    const ledger = this.ledger();
    const modelJudgedSufficient = new Set(acceptedPlan.modelJudgedSufficientTaskIds ?? []);
    const settledTasks = new Set(acceptedPlanSettledTaskIds(acceptedPlan));
    const currentTask = acceptedPlan.tasks.find((task) => !settledTasks.has(task.taskId));
    const lastResourcePacketIds = resourcePackets
      .map((packet) => packet.id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .slice(-6);
    const cursorKey = [
      acceptedPlan.planId,
      currentTask?.taskId ?? 'none',
      acceptedPlan.completedTaskIds.join(','),
      lastResourcePacketIds.join(','),
      lastSavepointId ?? '',
    ].join('|');
    return {
      cursorId: `task-cursor-${stableHash(cursorKey).slice(0, 16)}`,
      planId: acceptedPlan.planId,
      currentTaskId: currentTask?.taskId,
      taskOrder: ledger?.taskOrder ?? acceptedPlan.tasks.map((task) => task.taskId),
      pendingTaskIds: ledger?.pendingTaskIds ?? [],
      completedTaskIds: [...settledTasks],
      modelJudgedSufficientTaskIds: [...modelJudgedSufficient],
      lastResourcePacketIds,
      lastSavepointId,
    };
  }

  currentTaskContext(cursor: TaskExecutionCursor | undefined): CurrentTaskContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan || !cursor) return undefined;
    const task = acceptedPlan.tasks.find((item) => item.taskId === cursor.currentTaskId)
      ?? acceptedPlan.tasks.find((item) => !cursor.completedTaskIds.includes(item.taskId));
    if (!task) return undefined;
    const targets = [...new Set((task?.targets ?? []).map(normalizeTaskContextPath).filter(Boolean))];
    const toolIds = [task?.toolId].filter((item): item is string => Boolean(item && item.trim()));
    const goalParts = [
      acceptedPlan.title ?? acceptedPlan.summary ?? acceptedPlan.planId,
      task ? `task=${task.taskId}${task.title ? ` ${task.title}` : ''}` : '',
      targets.length ? `targets=${targets.join(', ')}` : '',
    ].filter(Boolean);
    return {
      goal: goalParts.join(' | '),
      taskId: task?.taskId,
      nodeId: undefined,
      taskTitle: task?.title,
      targets,
      toolIds,
      acceptanceCriteria: task?.acceptanceCriteria ?? [],
      failureCriteria: task?.failureCriteria ?? [],
      taskOrder: cursor.taskOrder,
      pendingTaskIds: cursor.pendingTaskIds,
      dependsOn: task?.dependencies ?? [],
      evidenceNeeds: [],
      completedTaskIds: cursor.completedTaskIds,
      modelJudgedSufficientTaskIds: cursor.modelJudgedSufficientTaskIds,
    };
  }

  withCompleted(completedTaskIds: string[]): AcceptedTaskPlanContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    const completed = new Set(completedTaskIds);
    const modelJudgedSufficient = new Set((acceptedPlan.modelJudgedSufficientTaskIds ?? []).filter((taskId) => !completed.has(taskId)));
    const skippedTaskIds = (acceptedPlan.skippedTaskIds ?? []).filter((taskId) => !completed.has(taskId));
    const acceptedIncompleteTaskIds = (acceptedPlan.acceptedIncompleteTaskIds ?? [])
      .filter((taskId) => !completed.has(taskId));
    const settled = new Set([
      ...completed,
      ...modelJudgedSufficient,
      ...skippedTaskIds,
      ...acceptedIncompleteTaskIds,
    ]);
    const nextIndex = acceptedPlan.tasks.findIndex((task) => !settled.has(task.taskId));
    return {
      ...acceptedPlan,
      completedTaskIds,
      modelJudgedSufficientTaskIds: [...modelJudgedSufficient],
      skippedTaskIds,
      acceptedIncompleteTaskIds,
      batchIndex: nextIndex >= 0 ? nextIndex + 1 : acceptedPlan.tasks.length + 1,
    };
  }

  withModelJudgedSufficient(taskId: string): AcceptedTaskPlanContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    const completed = new Set(acceptedPlan.completedTaskIds);
    const modelJudgedSufficient = new Set(acceptedPlan.modelJudgedSufficientTaskIds ?? []);
    const skippedTaskIds = (acceptedPlan.skippedTaskIds ?? []).filter(
      (candidate) => candidate !== taskId
    );
    const acceptedIncompleteTaskIds = (acceptedPlan.acceptedIncompleteTaskIds ?? [])
      .filter((candidate) => candidate !== taskId);
    if (!completed.has(taskId)) modelJudgedSufficient.add(taskId);
    const settled = new Set([
      ...completed,
      ...modelJudgedSufficient,
      ...skippedTaskIds,
      ...acceptedIncompleteTaskIds,
    ]);
    const nextIndex = acceptedPlan.tasks.findIndex((task) => !settled.has(task.taskId));
    return {
      ...acceptedPlan,
      modelJudgedSufficientTaskIds: [...modelJudgedSufficient],
      skippedTaskIds,
      acceptedIncompleteTaskIds,
      batchIndex: nextIndex >= 0 ? nextIndex + 1 : acceptedPlan.tasks.length + 1,
    };
  }

  withUserSettled(input: {
    skippedTaskIds?: string[];
    acceptedIncompleteTaskIds?: string[];
  }): AcceptedTaskPlanContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    const completed = new Set(acceptedPlan.completedTaskIds);
    const modelJudgedSufficient = new Set(acceptedPlan.modelJudgedSufficientTaskIds ?? []);
    const skipped = new Set(acceptedPlan.skippedTaskIds ?? []);
    const acceptedIncomplete = new Set(acceptedPlan.acceptedIncompleteTaskIds ?? []);
    for (const taskId of input.skippedTaskIds ?? []) {
      if (!completed.has(taskId) && !modelJudgedSufficient.has(taskId)) {
        acceptedIncomplete.delete(taskId);
        skipped.add(taskId);
      }
    }
    for (const taskId of input.acceptedIncompleteTaskIds ?? []) {
      if (!completed.has(taskId) && !modelJudgedSufficient.has(taskId)) {
        skipped.delete(taskId);
        acceptedIncomplete.add(taskId);
      }
    }
    const settled = new Set([
      ...completed,
      ...modelJudgedSufficient,
      ...skipped,
      ...acceptedIncomplete,
    ]);
    const nextIndex = acceptedPlan.tasks.findIndex((task) => !settled.has(task.taskId));
    return {
      ...acceptedPlan,
      skippedTaskIds: [...skipped],
      acceptedIncompleteTaskIds: [...acceptedIncomplete],
      batchIndex: nextIndex >= 0 ? nextIndex + 1 : acceptedPlan.tasks.length + 1,
    };
  }

  complete(): boolean {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return false;
    if (!acceptedPlan.tasks.length) return true;
    const settled = new Set(acceptedPlanSettledTaskIds(acceptedPlan));
    return acceptedPlan.tasks.every((task) => settled.has(task.taskId));
  }
}

function normalizeTaskContextPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}
