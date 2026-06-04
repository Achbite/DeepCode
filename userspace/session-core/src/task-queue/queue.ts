import type { KernelPlanReviewReport } from '@deepcode/protocol';
import type { ActionBundleDraft } from '../agent-plan/types.js';
import type { AutoConfirmDecision } from '../confirmation/types.js';
import type { ApprovedTaskQueue, DraftTask, DraftTaskQueue, RepairBudget } from './types.js';

export function createDraftTaskQueue(input: { queueId: string; actionBundle: ActionBundleDraft }): DraftTaskQueue {
  return {
    queueId: input.queueId,
    requirementId: input.actionBundle.requirementId,
    actionBundle: input.actionBundle,
    tasks: input.actionBundle.actions.map((action): DraftTask => ({
      id: action.id,
      title: action.title,
      capability: action.capability,
      resourceScope: action.resourceScope,
      conflictKeys: action.conflictKeys,
      canParallelize: action.canParallelize,
      sourceBlockId: action.sourceBlockId,
    })),
    status: 'draft',
  };
}

export function attachKernelPlanReview(queue: DraftTaskQueue, report: KernelPlanReviewReport): DraftTaskQueue {
  return {
    ...queue,
    status: 'kernelPreflighted',
    kernelPlanReview: report,
  };
}

export function createApprovedTaskQueue(input: {
  queue: DraftTaskQueue;
  planId: string;
  userConfirmed: boolean;
  autoConfirmDecision?: AutoConfirmDecision;
}): ApprovedTaskQueue {
  const autoConfirmed = input.autoConfirmDecision?.decision === 'autoConfirmed';
  if (!input.userConfirmed && !autoConfirmed) {
    throw new Error('ApprovedTaskQueue requires user confirmation or an auto-confirmed policy decision');
  }
  if (input.autoConfirmDecision?.decision === 'denied') {
    throw new Error(`ApprovedTaskQueue cannot use denied auto-confirm decision: ${input.autoConfirmDecision.reason}`);
  }
  if (!input.queue.kernelPlanReview) {
    throw new Error('ApprovedTaskQueue requires Kernel PlanReview report');
  }

  const repairPolicy = input.queue.actionBundle.repairPolicy;
  const repairBudget: RepairBudget = {
    maxRounds: repairPolicy?.maxRounds ?? 0,
    usedRounds: 0,
    allowedFiles: repairPolicy?.allowedFiles ?? [],
    forbidNewFilesAfterApproval: repairPolicy?.forbidNewFilesAfterApproval ?? true,
    forbidNewPermissionsAfterApproval: repairPolicy?.forbidNewPermissionsAfterApproval ?? true,
  };

  return {
    queueId: input.queue.queueId,
    requirementId: input.queue.requirementId,
    planId: input.planId,
    tasks: input.queue.tasks.map((task) => ({
      id: `approved-${task.id}`,
      draftTaskId: task.id,
      title: task.title,
      capability: task.capability,
      resourceScope: task.resourceScope,
    })),
    approvedScope: {
      capabilities: [...new Set(input.queue.tasks.map((task) => task.capability))].sort(),
      resourceScopes: [...new Set(input.queue.tasks.flatMap((task) => task.resourceScope))].sort(),
      codeBlockIds: [...new Set(input.queue.tasks.map((task) => task.sourceBlockId).filter((id): id is string => !!id))].sort(),
    },
    repairBudget,
  };
}
