import type { ProposalEnvelope } from '../protocol/types.js';
import type {
  AcceptedTaskPlanContext,
  AcceptedTaskPlanTaskContext,
  AcceptedPlanBatchProgress,
} from './types.js';
import { acceptedPlanSettledTaskIds } from './types.js';

export interface AcceptedPlanProgressAggregatorPorts {
  workUnitIdsFromKernelEvents(kernelEvents: unknown[]): string[];
  actionBatchHasFailureOrBlocker(kernelEvents: unknown[]): boolean;
}

export class AcceptedPlanProgressAggregator {
  constructor(private readonly ports: AcceptedPlanProgressAggregatorPorts) {}

  progress(
    accepted: AcceptedTaskPlanContext,
    proposal: ProposalEnvelope,
    kernelEvents: unknown[]
  ): AcceptedPlanBatchProgress {
    const payload = objectRecord(proposal.payload);
    const actionBundle = objectRecord(payload?.actionBundle);
    const actions = Array.isArray(actionBundle?.actions) ? actionBundle.actions : [];
    const actionRecords = actions
      .map(objectRecord)
      .filter((action): action is Record<string, unknown> => Boolean(action));
    const actionIds = uniqueStrings(actionRecords.map((action) => stringValue(action.actionId)));
    const actionToolIds = new Set(uniqueStrings(actionRecords.map((action) => stringValue(action.toolId))));
    const targetPaths = uniqueStrings(actionRecords.flatMap(actionTargets));
    const workUnitIds = this.ports.workUnitIdsFromKernelEvents(kernelEvents);
    const modelJudgedSufficient = new Set(accepted.modelJudgedSufficientTaskIds ?? []);
    const priorSettled = new Set(acceptedPlanSettledTaskIds(accepted));
    const currentTask = accepted.tasks.find((task) => !priorSettled.has(task.taskId));
    const newlyCompleted = new Set<string>();
    if (
      currentTask &&
      !this.ports.actionBatchHasFailureOrBlocker(kernelEvents) &&
      taskCoveredByBatch(currentTask, targetPaths, actionToolIds)
    ) {
      newlyCompleted.add(currentTask.taskId);
    }

    const completedTaskIds = uniqueStrings([...accepted.completedTaskIds, ...newlyCompleted]);
    const settled = new Set([
      ...completedTaskIds,
      ...modelJudgedSufficient,
      ...(accepted.skippedTaskIds ?? []),
      ...(accepted.acceptedIncompleteTaskIds ?? []),
    ]);
    return {
      actionIds,
      targetPaths,
      workUnitIds,
      newlyCompletedTaskIds: [...newlyCompleted],
      completedTaskIds,
      remainingTaskIds: accepted.tasks
        .map((task) => task.taskId)
        .filter((taskId) => !settled.has(taskId)),
    };
  }
}

function taskCoveredByBatch(
  task: AcceptedTaskPlanTaskContext,
  targetPaths: string[],
  actionToolIds: Set<string>
): boolean {
  if (task.toolId && actionToolIds.size && !actionToolIds.has(task.toolId)) return false;
  if (!task.targets.length) return !task.toolId || actionToolIds.has(task.toolId);
  if (!targetPaths.length) return false;
  return task.targets.every((target) =>
    targetPaths.some((candidate) => pathsOverlap(target, candidate))
  );
}

function actionTargets(action: Record<string, unknown>): string[] {
  const args = objectRecord(action.args);
  return uniqueStrings([
    stringValue(args?.path),
    stringValue(args?.destinationPath),
  ].map(normalizeRelativePath));
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeRelativePath(left);
  const b = normalizeRelativePath(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
  return normalized || '.';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
