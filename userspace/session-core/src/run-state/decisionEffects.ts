export type DecisionEffect =
  | { kind: 'continue' }
  | { kind: 'revisePlan'; reason?: string }
  | { kind: 'replan'; reason?: string }
  | { kind: 'skipTask'; taskId?: string }
  | { kind: 'markAcceptedIncomplete'; taskIds?: string[]; reason?: string }
  | { kind: 'finishWithAnswer'; reason?: string }
  | { kind: 'cancel'; reason?: string };

export type LegacyRequirementEffect =
  | { kind: 'continueWithAction' }
  | { kind: 'skipCurrentTask' }
  | { kind: 'replan'; reason?: string }
  | { kind: 'finishRun' }
  | { kind: 'finishWithAnswer'; reason?: string }
  | { kind: 'markAcceptedIncomplete'; taskIds?: string[]; reason?: string }
  | { kind: 'cancel'; reason?: string };

export function normalizeDecisionEffect(effect: LegacyRequirementEffect | undefined): DecisionEffect {
  if (!effect) return { kind: 'continue' };
  if (effect.kind === 'continueWithAction') return { kind: 'continue' };
  if (effect.kind === 'skipCurrentTask') return { kind: 'skipTask' };
  if (effect.kind === 'finishRun') return { kind: 'cancel', reason: 'finishRun compatibility effect' };
  return effect;
}

export function decisionEffectTerminatesWithAnswer(effect: DecisionEffect): boolean {
  return effect.kind === 'finishWithAnswer';
}
