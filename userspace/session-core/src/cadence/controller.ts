import type { DialogueCadenceInput, DialogueCadenceResult } from './types.js';

export class DialogueCadenceController {
  decide(input: DialogueCadenceInput): DialogueCadenceResult {
    if (input.repairBudgetExhausted || input.hasPermissionGap || input.hasScopeExpansion) {
      return { decision: 'escalateToUser', reason: 'scope, permission, or repair budget requires user review' };
    }
    if (input.isHighRisk || input.touchesMultipleFiles || input.isAmbiguous) {
      return { decision: 'requirementProbe', reason: 'task needs explicit requirement confirmation' };
    }
    if (input.isReadOnly) {
      return { decision: 'fastPath', reason: 'read-only task can use fast path' };
    }
    return { decision: 'waitForUserPlanConfirmation', reason: 'write-capable task needs plan confirmation' };
  }
}
