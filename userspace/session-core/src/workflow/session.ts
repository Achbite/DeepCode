import type { KernelPlanReviewReport } from '@deepcode/protocol';
import type { ActionBundleDraft } from '../agent-plan/types.js';
import { decidePlanConfirmation } from '../confirmation/policy.js';
import type { AutoConfirmDecision, PlanConfirmationPolicy } from '../confirmation/types.js';
import type { ReviewPacket } from '../review/types.js';
import { attachKernelPlanReview, createApprovedTaskQueue, createDraftTaskQueue } from '../task-queue/queue.js';
import type { ApprovedTaskQueue, DraftTaskQueue } from '../task-queue/types.js';
import { selectDynamicWorkflow } from './orchestrator.js';
import type { DynamicWorkflowInput, DynamicWorkflowPlan } from './types.js';

export interface DynamicWorkflowSessionInput extends DynamicWorkflowInput {
  sessionId: string;
  requirementId: string;
  actionBundle?: ActionBundleDraft;
  kernelPlanReview?: KernelPlanReviewReport;
  planConfirmationPolicy?: Partial<PlanConfirmationPolicy>;
  userConfirmedPlan?: boolean;
  reviewPacket?: ReviewPacket;
}

export interface DynamicWorkflowSession {
  sessionId: string;
  requirementId: string;
  workflowPlan: DynamicWorkflowPlan;
  draftQueue?: DraftTaskQueue;
  approvedQueue?: ApprovedTaskQueue;
  autoConfirmDecision?: AutoConfirmDecision;
  reviewPacket?: ReviewPacket;
}

export function buildDynamicWorkflowSession(input: DynamicWorkflowSessionInput): DynamicWorkflowSession {
  const workflowPlan = selectDynamicWorkflow(input);
  const draftQueue = input.actionBundle
    ? createDraftTaskQueue({ queueId: `${input.requirementId}:draft`, actionBundle: input.actionBundle })
    : undefined;
  const preflighted =
    draftQueue && input.kernelPlanReview ? attachKernelPlanReview(draftQueue, input.kernelPlanReview) : draftQueue;
  const autoConfirmDecision =
    input.actionBundle && input.kernelPlanReview
      ? decidePlanConfirmation({
          actionBundle: input.actionBundle,
          kernelPlanReview: input.kernelPlanReview,
          policy: input.planConfirmationPolicy,
        })
      : undefined;
  const canFreeze =
    !!preflighted?.kernelPlanReview && (input.userConfirmedPlan === true || autoConfirmDecision?.decision === 'autoConfirmed');
  const approvedQueue = canFreeze
    ? createApprovedTaskQueue({
        queue: preflighted,
        planId: input.actionBundle?.id ?? `${input.requirementId}:plan`,
        userConfirmed: input.userConfirmedPlan === true,
        autoConfirmDecision,
      })
    : undefined;

  return {
    sessionId: input.sessionId,
    requirementId: input.requirementId,
    workflowPlan,
    draftQueue: preflighted,
    approvedQueue,
    autoConfirmDecision,
    reviewPacket: input.reviewPacket,
  };
}
