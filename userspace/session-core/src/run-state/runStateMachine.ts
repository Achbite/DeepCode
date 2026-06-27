import { taskLedgerAllSettled, type TaskLedgerSnapshot } from './taskLedger.js';
import type { DecisionEffect } from './decisionEffects.js';

export type RunStateMachineNext =
  | { kind: 'continueAcceptedPlan'; currentTaskId?: string }
  | { kind: 'waitForPlanReview' }
  | { kind: 'finishWithAnswer'; reason?: string }
  | { kind: 'cancel'; reason?: string }
  | { kind: 'reviewAcceptedPlan' };

export interface RunStateMachineInput {
  ledger?: TaskLedgerSnapshot;
  decisionEffect?: DecisionEffect;
  batchFailed?: boolean;
}

export function evaluateRunState(input: RunStateMachineInput): RunStateMachineNext {
  const effect = input.decisionEffect;
  if (effect?.kind === 'finishWithAnswer') {
    return { kind: 'finishWithAnswer', reason: effect.reason };
  }
  if (effect?.kind === 'cancel') {
    return { kind: 'cancel', reason: effect.reason };
  }
  if (effect?.kind === 'replan' || effect?.kind === 'revisePlan') {
    return { kind: 'waitForPlanReview' };
  }
  if (input.batchFailed) {
    return { kind: 'continueAcceptedPlan', currentTaskId: input.ledger?.currentTaskId };
  }
  if (input.ledger && taskLedgerAllSettled(input.ledger)) {
    return { kind: 'reviewAcceptedPlan' };
  }
  return { kind: 'continueAcceptedPlan', currentTaskId: input.ledger?.currentTaskId };
}

