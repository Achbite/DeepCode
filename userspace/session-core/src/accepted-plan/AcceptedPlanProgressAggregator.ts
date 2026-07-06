import type { ProposalEnvelope } from '../protocol/types.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedImplementationPlanTaskContext,
  AcceptedPlanBatchProgress,
} from './types.js';
import type { AcceptedPlanScopeMatcher } from './AcceptedPlanScopeMatcher.js';

interface AcceptedPlanProgressActionBundle {
  actions?: unknown[];
}

export interface AcceptedPlanProgressAggregatorPorts {
  scopeMatcher: AcceptedPlanScopeMatcher;
  workUnitIdsFromKernelEvents(kernelEvents: unknown[]): string[];
  actionBatchHasFailureOrBlocker(kernelEvents: unknown[]): boolean;
}

export class AcceptedPlanProgressAggregator {
  constructor(private readonly ports: AcceptedPlanProgressAggregatorPorts) {}

  progress(
    accepted: AcceptedImplementationPlanContext,
    proposal: ProposalEnvelope,
    kernelEvents: unknown[]
  ): AcceptedPlanBatchProgress {
    const matcher = this.ports.scopeMatcher;
    const actionBundle = matcher.readActionBundle(proposal) as AcceptedPlanProgressActionBundle | undefined;
    const actions = actionBundle?.actions ?? [];
    const actionIds = actions
      .map((action) => {
        const record = matcher.objectRecord(action) ?? {};
        return matcher.stringValue(record.actionId)
          ?? matcher.stringValue(record.id)
          ?? matcher.stringValue(record.title);
      })
      .filter((item): item is string => Boolean(item));
    const actionCapabilities = new Set(actions
      .map((action) => matcher.actionEffectiveCapability(action as { capability?: unknown; toolId?: unknown }))
      .filter((item): item is string => Boolean(item)));
    const targetPaths = [...new Set(matcher.proposalTargetScopes(proposal, accepted)
      .map((target) => target.normalized)
      .filter((target) => target && target !== '.' && target !== '..'))];
    const workUnitIds = this.ports.workUnitIdsFromKernelEvents(kernelEvents);
    const priorCompleted = new Set(accepted.completedTaskIds);
    const coveredTaskIds = new Set<string>();
    for (const task of accepted.tasks) {
      if (!priorCompleted.has(task.taskId) && this.taskCoveredByBatch(task, targetPaths, actionCapabilities)) {
        coveredTaskIds.add(task.taskId);
      }
    }
    const newlyCompleted = new Set<string>();
    for (const task of accepted.tasks) {
      if (priorCompleted.has(task.taskId)) continue;
      if (!coveredTaskIds.has(task.taskId)) break;
      newlyCompleted.add(task.taskId);
    }
    if (!newlyCompleted.size && !this.ports.actionBatchHasFailureOrBlocker(kernelEvents)) {
      const currentTask = accepted.tasks[Math.max(0, accepted.batchIndex - 1)];
      if (currentTask && !priorCompleted.has(currentTask.taskId)) {
        newlyCompleted.add(currentTask.taskId);
      }
    }
    const completedTaskIds = [...new Set([...accepted.completedTaskIds, ...newlyCompleted])];
    const completed = new Set(completedTaskIds);
    const remainingTaskIds = accepted.tasks
      .map((task) => task.taskId)
      .filter((taskId) => !completed.has(taskId));
    return {
      actionIds: [...new Set(actionIds)],
      targetPaths,
      workUnitIds,
      newlyCompletedTaskIds: [...newlyCompleted],
      completedTaskIds,
      remainingTaskIds,
    };
  }

  private taskCoveredByBatch(
    task: AcceptedImplementationPlanTaskContext,
    targetPaths: string[],
    actionCapabilities: Set<string>
  ): boolean {
    const matcher = this.ports.scopeMatcher;
    if (
      task.capability &&
      actionCapabilities.size &&
      !matcher.capabilitySetAllows(actionCapabilities, task.capability, 'actionCoversAccepted')
    ) {
      return false;
    }
    if (!task.targets.length) {
      return !task.capability || matcher.capabilitySetAllows(actionCapabilities, task.capability, 'actionCoversAccepted');
    }
    if (!targetPaths.length) return false;
    return task.targets.every((taskTarget) =>
      matcher.expandTargetTokens(taskTarget)
        .map((target) => matcher.normalizeScopeIdentity(target))
        .filter(Boolean)
        .some((normalizedTaskTarget) =>
          targetPaths.some((targetPath) => matcher.scopesOverlap(normalizedTaskTarget, targetPath))
        )
    );
  }
}
