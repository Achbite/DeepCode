import type { ConversationProjectionCardKind } from '../projection.js';
import type { DynamicWorkflowInput, DynamicWorkflowPlan, SessionOrchestrationMicroPhase } from './types.js';

export function selectDynamicWorkflow(input: DynamicWorkflowInput): DynamicWorkflowPlan {
  const microPhases: SessionOrchestrationMicroPhase[] = [];
  const projectionCardKinds: ConversationProjectionCardKind[] = ['user_request'];
  const notes: string[] = [];

  if (input.needsMoreContext) {
    microPhases.push('resourceRequest', 'resourcePacket');
    projectionCardKinds.push('resource_request', 'resource_packet');
    notes.push('context is incomplete; ResourceRequest must resolve before ActionBundle execution planning');
  }

  if (input.requestKind === 'readOnlyAnswer' && input.isReadOnly && !input.requiresExecution) {
    microPhases.push('answer');
    projectionCardKinds.push('answer');
    return dynamicWorkflowPlan(input, microPhases, projectionCardKinds, false, false, false, notes);
  }

  microPhases.push('planDialogue');
  projectionCardKinds.push('plan_summary');

  if (!input.hasKernelPlanReview) {
    microPhases.unshift('requirementProbe');
    projectionCardKinds.push('check_review');
    notes.push('plan must remain draft until Kernel PlanReview and user plan confirmation');
  } else {
    microPhases.push('planReview');
    projectionCardKinds.push('check_review');
  }

  if (input.hasPermissionPrompt) {
    microPhases.push('permissionPrompt');
    projectionCardKinds.push('permission');
  }

  if (input.requestKind === 'repairLoop' || input.repairAttempt !== undefined) {
    microPhases.push('repairLoop');
    projectionCardKinds.push('repair');
  }

  if (input.requiresExecution || input.hasExecutionFacts) {
    microPhases.push('execution');
    projectionCardKinds.push('execution_progress');
  }

  if (input.hasReviewPacket || input.hasExecutionFacts) {
    microPhases.push('reviewRound');
    projectionCardKinds.push('review_summary');
  }

  return dynamicWorkflowPlan(input, microPhases, uniqueProjectionKinds(projectionCardKinds), true, true, true, notes);
}

function dynamicWorkflowPlan(
  input: DynamicWorkflowInput,
  microPhases: SessionOrchestrationMicroPhase[],
  projectionCardKinds: ConversationProjectionCardKind[],
  requiresPlanReview: boolean,
  requiresUserPlanConfirmation: boolean,
  usesKernelPermissionGate: boolean,
  notes: string[]
): DynamicWorkflowPlan {
  return {
    workflowId: input.workflowId,
    selectedKind: input.requestKind,
    workflowRef: input.workflowRef,
    profile: input.profile,
    stateMachineBoundary: 'kernelOwnedStateMachine',
    microPhases: [...microPhases],
    projectionCardKinds: [...projectionCardKinds],
    requiresPlanReview,
    requiresUserPlanConfirmation,
    usesKernelPermissionGate,
    notes: [...notes],
  };
}

function uniqueProjectionKinds(values: ConversationProjectionCardKind[]): ConversationProjectionCardKind[] {
  const seen = new Set<ConversationProjectionCardKind>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
