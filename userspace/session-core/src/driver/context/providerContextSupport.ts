import type { ProviderRepairMessageState } from '../../prompt/ProviderRepairMessageBuilder.js';
import type {
  AcceptedTaskPlanContext,
  CurrentTaskContext,
  ImplementationBatchContext,
} from '../execution/index.js';
import { acceptedPlanSettledTaskIds } from '../../accepted-plan/types.js';

export interface ProviderContextSupportState {
  runId: string;
  userRequest: string;
  conversationRoots: unknown[];
  resourcePackets: unknown[];
  implementationBatch?: ImplementationBatchContext;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  currentTaskContext?: CurrentTaskContext;
}

export interface ProviderContextSupportPorts {
  acceptedContext(acceptedPlan: AcceptedTaskPlanContext | undefined): Record<string, unknown> | undefined;
}

export class ProviderContextSupport {
  constructor(private readonly ports: ProviderContextSupportPorts) {}

  implementationBatchHints(
    context: ImplementationBatchContext,
    acceptedPlan?: AcceptedTaskPlanContext
  ): string[] {
    const hints = [
      `ImplementationBatchStatus: nextBatchIndex=${context.batchIndex}`,
    ];
    if (acceptedPlan) {
      const settled = new Set(acceptedPlanSettledTaskIds(acceptedPlan));
      const currentTask = acceptedPlan.tasks.find((task) => !settled.has(task.taskId));
      const currentTaskOperations = this.currentTaskOperations(acceptedPlan);
      hints.push(
        `AcceptedTaskCursor: planId=${acceptedPlan.planId}; currentTask=${currentTask?.taskId ?? 'complete'}; settledTasks=${settled.size}/${acceptedPlan.tasks.length}; kernelCompletedTasks=${acceptedPlan.completedTaskIds.length}`,
        currentTask
          ? `CurrentAcceptedTask: taskId=${currentTask.taskId}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; toolId=${currentTask.toolId ?? 'none'}`
          : 'CurrentAcceptedTask: complete-or-unavailable',
        Array.isArray(currentTaskOperations) && currentTaskOperations.length
          ? `Accepted current task operations: ${JSON.stringify(currentTaskOperations)}.`
          : 'Accepted current task operations: none.',
        acceptedPlan.executionRoot
          ? `AcceptedPrimaryRoot: ${acceptedPlan.executionRoot.ref}`
          : 'AcceptedPrimaryRoot: none'
      );
    }
    if (context.recentPlanSummaries.length) {
      hints.push(`RecentBatchPlanSummaries: ${context.recentPlanSummaries.join(' | ')}`);
    }
    if (context.continuationSummaries.length) {
      hints.push(`ContinuationSummaries: ${context.continuationSummaries.join(' | ')}`);
    }
    return hints;
  }

  repairMessageState(state: ProviderContextSupportState): ProviderRepairMessageState {
    return {
      runId: state.runId,
      userRequest: state.userRequest,
      conversationRoots: state.conversationRoots,
      resourcePackets: state.resourcePackets,
      implementationBatch: state.implementationBatch,
      acceptedContext: this.ports.acceptedContext(state.acceptedTaskPlan),
      currentTaskContext: state.currentTaskContext
        ? {
          taskId: state.currentTaskContext.taskId,
          taskTitle: state.currentTaskContext.taskTitle,
          goal: state.currentTaskContext.goal,
          targets: state.currentTaskContext.targets,
          toolIds: state.currentTaskContext.toolIds,
        }
        : undefined,
      completedTaskCount: state.acceptedTaskPlan
        ? acceptedPlanSettledTaskIds(state.acceptedTaskPlan).length
        : 0,
    };
  }

  private currentTaskOperations(acceptedPlan: AcceptedTaskPlanContext): unknown[] | undefined {
    const operations = this.ports.acceptedContext(acceptedPlan)?.currentTaskOperations;
    return Array.isArray(operations) ? operations : undefined;
  }
}
