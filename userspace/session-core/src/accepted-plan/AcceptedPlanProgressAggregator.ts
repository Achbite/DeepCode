import type { ProposalEnvelope } from '../agent-plan/types.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedImplementationPlanTaskContext,
  AcceptedPlanBatchProgress,
  AcceptedPlanTargetScope,
} from './types.js';

interface AcceptedPlanProgressActionBundle {
  actions?: unknown[];
}

export interface AcceptedPlanProgressAggregatorPorts {
  readActionBundle(proposal: ProposalEnvelope): AcceptedPlanProgressActionBundle | undefined;
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringValue(value: unknown): string | undefined;
  actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string;
  proposalTargetScopes(
    proposal: ProposalEnvelope,
    accepted: AcceptedImplementationPlanContext
  ): AcceptedPlanTargetScope[];
  workUnitIdsFromKernelEvents(kernelEvents: unknown[]): string[];
  taskCoveredByBatch(
    task: AcceptedImplementationPlanTaskContext,
    targetPaths: string[],
    actionCapabilities: Set<string>
  ): boolean;
  actionBatchHasFailureOrBlocker(kernelEvents: unknown[]): boolean;
}

export class AcceptedPlanProgressAggregator {
  constructor(private readonly ports: AcceptedPlanProgressAggregatorPorts) {}

  progress(
    accepted: AcceptedImplementationPlanContext,
    proposal: ProposalEnvelope,
    kernelEvents: unknown[]
  ): AcceptedPlanBatchProgress {
    const actionBundle = this.ports.readActionBundle(proposal);
    const actions = actionBundle?.actions ?? [];
    const actionIds = actions
      .map((action) => {
        const record = this.ports.objectRecord(action) ?? {};
        return this.ports.stringValue(record.actionId)
          ?? this.ports.stringValue(record.id)
          ?? this.ports.stringValue(record.title);
      })
      .filter((item): item is string => Boolean(item));
    const actionCapabilities = new Set(actions
      .map((action) => this.ports.actionEffectiveCapability(action as { capability?: unknown; toolId?: unknown }))
      .filter((item): item is string => Boolean(item)));
    const targetPaths = [...new Set(this.ports.proposalTargetScopes(proposal, accepted)
      .map((target) => target.normalized)
      .filter((target) => target && target !== '.' && target !== '..'))];
    const workUnitIds = this.ports.workUnitIdsFromKernelEvents(kernelEvents);
    const priorCompleted = new Set(accepted.completedTaskIds);
    const coveredTaskIds = new Set<string>();
    for (const task of accepted.tasks) {
      if (!priorCompleted.has(task.taskId) && this.ports.taskCoveredByBatch(task, targetPaths, actionCapabilities)) {
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
}
