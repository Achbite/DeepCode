import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';

export const FINAL_KERNEL_EFFECT_TASK_IDS_STAGING_FIELD =
  'kernelEffectTaskIdsPendingMaterialization';

export class FinalSettlementEvidenceError extends Error {
  readonly code = 'session_kernel_effect_claim_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'FinalSettlementEvidenceError';
  }
}

/**
 * Carry only the Session-owned task identities to canonical append admission.
 * Admission resolves them against earlier immutable batch/task checkpoints,
 * binds their exact Kernel work-unit terminal facts, and removes this staging
 * field before persistence. Tasks settled from read-only Session evidence are
 * intentionally absent because they are not Kernel execution claims.
 */
export function finalSettlementEvidenceMetadata(
  acceptedPlan: AcceptedTaskPlanContext | undefined
): Record<string, unknown> {
  const completedTaskIds = [...new Set(acceptedPlan?.completedTaskIds ?? [])];
  if (completedTaskIds.some((taskId) => !taskId.trim())) {
    throw new FinalSettlementEvidenceError(
      'Kernel-completed task identities must be non-empty before final settlement.'
    );
  }
  return { [FINAL_KERNEL_EFFECT_TASK_IDS_STAGING_FIELD]: completedTaskIds };
}
