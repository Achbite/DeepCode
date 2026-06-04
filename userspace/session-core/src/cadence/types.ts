export type DialogueCadenceDecision =
  | 'fastPath'
  | 'requirementProbe'
  | 'waitForUserPlanConfirmation'
  | 'submitKernelPlanReview'
  | 'continueCurrentRequirement'
  | 'moveToBacklog'
  | 'escalateToUser';

export interface DialogueCadenceInput {
  isReadOnly: boolean;
  isHighRisk: boolean;
  touchesMultipleFiles: boolean;
  isAmbiguous: boolean;
  hasScopeExpansion: boolean;
  hasPermissionGap: boolean;
  repairBudgetExhausted: boolean;
}

export interface DialogueCadenceResult {
  decision: DialogueCadenceDecision;
  reason: string;
}
