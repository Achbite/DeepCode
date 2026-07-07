import { stableHash } from '../cache/canonicalizer.js';
import type { ResourcePacket } from '../context/types.js';
import {
  buildAcceptedPlanPromptFrame,
  buildTaskLedgerSnapshot,
  type AcceptedPlanPromptFrame,
  type TaskLedgerSnapshot,
} from '../run-state/index.js';
import type {
  AcceptedImplementationPlanContext,
  CurrentTaskContext,
  TaskExecutionCursor,
} from './types.js';

export class AcceptedTaskRegistry {
  constructor(private readonly acceptedPlan: AcceptedImplementationPlanContext | undefined) {}

  ledger(
    failedTaskId?: string,
    skippedTaskIds: string[] = [],
    acceptedIncompleteTaskIds: string[] = []
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
        capability: task.capability,
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
    const settledTasks = new Set([...acceptedPlan.completedTaskIds, ...modelJudgedSufficient]);
    const currentTask = acceptedPlan.tasks.find((task) => !settledTasks.has(task.taskId))
      ?? acceptedPlan.tasks[Math.max(0, acceptedPlan.batchIndex - 1)];
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
    const currentTaskGrants = acceptedPlan.exactOperationGrants.filter((grant) =>
      !grant.sourceTaskId || !task?.taskId || grant.sourceTaskId === task.taskId
    );
    const targets = [...new Set([
      ...(task?.targets ?? []),
      ...currentTaskGrants.map((grant) => grant.targetPath),
    ].map(normalizeTaskContextPath).filter(Boolean))];
    const capabilities = [...new Set([
      task?.capability,
      ...currentTaskGrants.map((grant) => grant.capability),
    ].filter((item): item is string => Boolean(item && item.trim())))];
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
      capabilities,
      taskOrder: cursor.taskOrder,
      pendingTaskIds: cursor.pendingTaskIds,
      dependsOn: [],
      evidenceNeeds: [],
      completedTaskIds: cursor.completedTaskIds,
      modelJudgedSufficientTaskIds: cursor.modelJudgedSufficientTaskIds,
    };
  }

  withCompleted(completedTaskIds: string[]): AcceptedImplementationPlanContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    const completed = new Set(completedTaskIds);
    const modelJudgedSufficient = new Set((acceptedPlan.modelJudgedSufficientTaskIds ?? []).filter((taskId) => !completed.has(taskId)));
    const settled = new Set([...completed, ...modelJudgedSufficient]);
    const nextIndex = acceptedPlan.tasks.findIndex((task) => !settled.has(task.taskId));
    return {
      ...acceptedPlan,
      completedTaskIds,
      modelJudgedSufficientTaskIds: [...modelJudgedSufficient],
      batchIndex: nextIndex >= 0 ? nextIndex + 1 : acceptedPlan.tasks.length + 1,
    };
  }

  withModelJudgedSufficient(taskId: string): AcceptedImplementationPlanContext | undefined {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return undefined;
    const completed = new Set(acceptedPlan.completedTaskIds);
    const modelJudgedSufficient = new Set(acceptedPlan.modelJudgedSufficientTaskIds ?? []);
    if (!completed.has(taskId)) modelJudgedSufficient.add(taskId);
    const settled = new Set([...completed, ...modelJudgedSufficient]);
    const nextIndex = acceptedPlan.tasks.findIndex((task) => !settled.has(task.taskId));
    return {
      ...acceptedPlan,
      modelJudgedSufficientTaskIds: [...modelJudgedSufficient],
      batchIndex: nextIndex >= 0 ? nextIndex + 1 : acceptedPlan.tasks.length + 1,
    };
  }

  complete(): boolean {
    const acceptedPlan = this.acceptedPlan;
    if (!acceptedPlan) return false;
    if (!acceptedPlan.tasks.length) return true;
    const settled = new Set([
      ...acceptedPlan.completedTaskIds,
      ...(acceptedPlan.modelJudgedSufficientTaskIds ?? []),
    ]);
    return acceptedPlan.tasks.every((task) => settled.has(task.taskId));
  }
}

function normalizeTaskContextPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}
