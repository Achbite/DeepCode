export type DecisionEffect =
  | { kind: 'continue' }
  | { kind: 'revisePlan'; reason?: string }
  | { kind: 'replan'; reason?: string }
  | { kind: 'skipTask'; taskId?: string }
  | { kind: 'continueCurrentTask'; taskId?: string }
  | {
    kind: 'expandCurrentTaskScope';
    taskId?: string;
    targetPath?: string;
    targetResourceKind?: 'file' | 'directory';
    recursive?: boolean;
    reason?: string;
  }
  | { kind: 'confirmOperationGrant'; taskId?: string; reason?: string }
  | { kind: 'answerReviewQuestion'; reason?: string }
  | { kind: 'markAcceptedIncomplete'; taskIds?: string[]; reason?: string }
  | { kind: 'finishWithAnswer'; reason?: string }
  | { kind: 'cancel'; reason?: string };

export type LegacyRequirementEffect =
  | { kind: 'continueWithAction' }
  | { kind: 'skipCurrentTask' }
  | { kind: 'continueCurrentTask'; taskId?: string }
  | {
    kind: 'expandCurrentTaskScope';
    taskId?: string;
    targetPath?: string;
    targetResourceKind?: 'file' | 'directory';
    recursive?: boolean;
    reason?: string;
  }
  | { kind: 'confirmOperationGrant'; taskId?: string; reason?: string }
  | { kind: 'answerReviewQuestion'; reason?: string }
  | { kind: 'replan'; reason?: string }
  | { kind: 'finishRun' }
  | { kind: 'finishWithAnswer'; reason?: string }
  | { kind: 'markAcceptedIncomplete'; taskIds?: string[]; reason?: string }
  | { kind: 'cancel'; reason?: string };

export function normalizeDecisionEffect(effect: LegacyRequirementEffect | undefined): DecisionEffect {
  if (!effect) return { kind: 'continue' };
  if (effect.kind === 'continueWithAction') return { kind: 'continue' };
  if (effect.kind === 'continueCurrentTask') return effect;
  if (effect.kind === 'expandCurrentTaskScope') return effect;
  if (effect.kind === 'confirmOperationGrant') return effect;
  if (effect.kind === 'answerReviewQuestion') return effect;
  if (effect.kind === 'skipCurrentTask') return { kind: 'skipTask' };
  if (effect.kind === 'finishRun') return { kind: 'cancel', reason: 'finishRun compatibility effect' };
  return effect;
}

export function decisionEffectTerminatesWithAnswer(effect: DecisionEffect): boolean {
  return effect.kind === 'finishWithAnswer';
}
