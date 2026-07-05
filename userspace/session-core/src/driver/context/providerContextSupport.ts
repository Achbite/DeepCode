import type { ProviderRepairMessageState } from '../../prompt/ProviderRepairMessageBuilder.js';
import type {
  AcceptedImplementationPlanContext,
  CurrentTaskContext,
  ImplementationBatchContext,
} from '../execution/index.js';

export interface ProviderContextSupportState {
  runId: string;
  userRequest: string;
  conversationRoots: unknown[];
  resourcePackets: unknown[];
  implementationBatch?: ImplementationBatchContext;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  currentTaskContext?: CurrentTaskContext;
}

export interface ProviderContextSupportPorts {
  currentTaskOperations(acceptedPlan: AcceptedImplementationPlanContext): unknown[] | undefined;
  acceptedContext(acceptedPlan: AcceptedImplementationPlanContext | undefined): Record<string, unknown> | undefined;
}

export class ProviderContextSupport {
  constructor(private readonly ports: ProviderContextSupportPorts) {}

  implementationBatchHints(
    context: ImplementationBatchContext,
    acceptedPlan?: AcceptedImplementationPlanContext
  ): string[] {
    const hints = [
      `Implementation batch context: nextBatchIndex=${context.batchIndex}. Generate only the next reviewable batch when proposing side-effect actions.`,
      'Context boundary: plan cards and continuation expectations are intent only; they are not evidence that files exist or were modified.',
      'Authoritative generated-file facts come only from ResourcePacket contents, ToolCompleted(ok=true), or WorkUnitCompleted facts.',
    ];
    if (acceptedPlan) {
      const currentTask = acceptedPlan.tasks.find((task) => !acceptedPlan.completedTaskIds.includes(task.taskId));
      const currentTaskOperations = this.ports.currentTaskOperations(acceptedPlan);
      hints.push(
        `Accepted taskPlan active: planId=${acceptedPlan.planId}; currentTask=${currentTask?.taskId ?? 'complete'}; completedTasks=${acceptedPlan.completedTaskIds.length}/${acceptedPlan.tasks.length}. Automatic execution is allowed only for the current task when targets and capabilities stay inside the accepted plan.`,
        currentTask
          ? `Current accepted taskPlan task: taskId=${currentTask.taskId}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; capability=${currentTask.capability ?? 'none'}.`
          : 'Current accepted taskPlan task is complete or unavailable; return diagnostic or review-ready summary rather than expanding scope.',
        Array.isArray(currentTaskOperations) && currentTaskOperations.length
          ? `Accepted current task operations: ${JSON.stringify(currentTaskOperations)}.`
          : 'Accepted current task operations: none.',
        'Exact file operations such as fs.delete/fs.rename are authorized by exact operation grants, not by provider-declared scope fields.',
        acceptedPlan.executionRoot
          ? `Accepted taskPlan primary root: ${acceptedPlan.executionRoot.ref}. Workspace actionBundle targetPath/codeBlock paths must be relative to this root and must not include the root directory name. Absolute paths are allowed only for outside-workspace targets already reviewed in the accepted plan.`
          : 'Accepted taskPlan primary root is not explicit; use relative target paths from the authorized workspace root unless the accepted plan explicitly contains outside-workspace absolute file targets.',
        'Do not ask the user to reconfirm routine implementation batches already covered by the accepted taskPlan. If new targets, capabilities, or material technical choices are needed during accepted execution, return decisionRequest instead of an out-of-scope actionBundle.'
      );
    }
    if (context.recentPlanSummaries.length) {
      hints.push(`Recent implementation batch plans (intent only, not execution facts): ${context.recentPlanSummaries.join(' | ')}`);
    }
    if (context.continuationSummaries.length) {
      hints.push(`Pending continuation expectations (intent only, not files already created): ${context.continuationSummaries.join(' | ')}`);
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
      acceptedContext: this.ports.acceptedContext(state.acceptedImplementationPlan),
      currentTaskContext: state.currentTaskContext
        ? {
          taskId: state.currentTaskContext.taskId,
          taskTitle: state.currentTaskContext.taskTitle,
          goal: state.currentTaskContext.goal,
          targets: state.currentTaskContext.targets,
          capabilities: state.currentTaskContext.capabilities,
        }
        : undefined,
      completedTaskCount: state.acceptedImplementationPlan?.completedTaskIds.length ?? 0,
    };
  }
}
