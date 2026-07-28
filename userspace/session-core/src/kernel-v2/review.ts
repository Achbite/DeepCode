import type { KernelFactProjectionV2 } from '@deepcode/protocol';
import { sessionKernelFactsCaughtUpV2 } from './lineage.js';
import {
  operationTerminalFactsV2,
  orderedFacts,
} from './reconcile.js';
import type { SessionKernelLoopStateV2 } from './state.js';
import type {
  SessionKernelReviewV2,
  SessionReviewFactRefV2,
  SessionReviewPlannedActionV2,
} from './types.js';
import {
  SESSION_KERNEL_FACT_KINDS_V2,
  SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2,
} from './factKinds.js';

const SCOPE_EXPANSION_FACTS = new Set<string>([
  SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionAllowed,
  SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionDenied,
]);

const DENIAL_FACTS = new Set<string>([
  SESSION_KERNEL_FACT_KINDS_V2.authorization.capabilityDenied,
  SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionDenied,
]);

/**
 * Review is a Session projection over a complete Kernel snapshot. A later
 * high-water or Plan revision creates a new review revision; old review
 * records are never rewritten in place.
 */
export function buildSessionKernelReviewV2(
  state: SessionKernelLoopStateV2,
  createdAt: string
): SessionKernelReviewV2 {
  if (!sessionKernelFactsCaughtUpV2(state.lineage)) {
    throw new SessionKernelReviewError(
      'session_kernel_review_snapshot_incomplete',
      'Review requires a fully reconciled Kernel snapshot.'
    );
  }
  const snapshotHighWater = state.lineage.cursor.snapshotHighWater;
  if (
    state.review
    && state.review.snapshotHighWater === snapshotHighWater
    && state.review.planRevision === state.plan?.planRevision
  ) {
    return cloneReview(state.review);
  }
  const facts = orderedFacts(state);
  const planned = plannedActions(state);
  return {
    revision: (state.review?.revision ?? 0) + 1,
    status: 'draft',
    ...(state.plan?.planRevision
      ? { planRevision: state.plan.planRevision }
      : {}),
    ...(state.plan
      ? {
          plan: {
            title: state.plan.title,
            objective: state.plan.objective,
            narrative: state.plan.narrative,
            recordedAt: state.plan.recordedAt,
          },
        }
      : {}),
    snapshotHighWater,
    planned,
    scopeExpansions: selectFacts(
      facts,
      (fact) => isScopeExpansionFact(fact, facts)
    ),
    actualEffects: selectFacts(
      facts,
      (fact) =>
        fact.domain === 'effect'
        && SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2.has(
          fact.factKind
        )
    ),
    unexecuted: planned.filter(
      (action) =>
        planActionInvocationCount(state, action.planActionId) === 0
        && !state.planActionSettlements[action.planActionId]
    ),
    denied: selectFacts(
      facts,
      (fact) =>
        fact.domain === 'authorization'
        && DENIAL_FACTS.has(fact.factKind)
    ),
    rejections: selectFacts(
      facts,
      (fact) =>
        fact.factKind
          === SESSION_KERNEL_FACT_KINDS_V2.invocation.rejected
        || (
          fact.domain === 'authorization'
          && DENIAL_FACTS.has(fact.factKind)
        )
    ),
    skipped: Object.values(state.planActionSettlements)
      .sort((left, right) =>
        left.recordedAt.localeCompare(right.recordedAt)
        || left.planActionId.localeCompare(right.planActionId)
      ),
    cleanup: selectFacts(facts, (fact) => fact.domain === 'cleanup'),
    indeterminate: selectFacts(
      facts,
      (fact) =>
        fact.factKind
        === SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate
    ),
    createdAt,
  };
}

function isScopeExpansionFact(
  fact: KernelFactProjectionV2,
  facts: KernelFactProjectionV2[]
): boolean {
  if (fact.domain !== 'authorization') return false;
  if (SCOPE_EXPANSION_FACTS.has(fact.factKind)) return true;
  if (
    fact.factKind
      !== SESSION_KERNEL_FACT_KINDS_V2.authorization.scopePreviewed
    || !fact.lineage.operationId
  ) {
    return false;
  }
  return facts.some(
    (candidate) =>
      candidate.ledgerSequence < fact.ledgerSequence
      && candidate.domain === 'authorization'
      && candidate.lineage.operationId === fact.lineage.operationId
      && (
        candidate.factKind
          === SESSION_KERNEL_FACT_KINDS_V2.authorization.capabilityIssued
        || candidate.factKind
          === SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionAllowed
      )
  );
}

/**
 * Caught-up means only that the current facts snapshot is complete. Final
 * Review additionally requires every planned operation to be canonically
 * terminal or denied, no active orchestration/request state, no
 * indeterminate outcome, and settled cleanup facts.
 */
export function canFinalizeSessionKernelReviewV2(
  state: SessionKernelLoopStateV2
): boolean {
  if (
    !state.plan
    || !sessionKernelFactsCaughtUpV2(state.lineage)
    || state.activeWait
    || state.providerTurn?.status === 'active'
    || Object.keys(state.publicRequests).length > 0
    || state.pendingGuidance.length > 0
  ) {
    return false;
  }
  const facts = orderedFacts(state);
  if (
    facts.some(
      (fact) =>
        fact.factKind
          === SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate
    )
  ) {
    return false;
  }
  const deniedOperations = new Set(
    facts
      .filter(
        (fact) =>
          fact.domain === 'authorization'
          && DENIAL_FACTS.has(fact.factKind)
          && fact.lineage.operationId
      )
      .map((fact) => fact.lineage.operationId!)
  );
  const everyOperationSettled = state.plan.actions.every((action) => {
    if (state.planActionSettlements[action.manifest.planActionId]) {
      return true;
    }
    const operationIds =
      planActionOperationIds(
        state,
        action.manifest.planActionId
      );
    const invokedOperationIds = operationIds.filter(
      (operationId) =>
        (state.lineage.operations[operationId]?.invocationIds.length
          ?? 0) > 0
    );
    if (invokedOperationIds.length === 0) {
      return operationIds.some(
        (operationId) => deniedOperations.has(operationId)
      );
    }
    return invokedOperationIds.every(
      (operationId) =>
        operationTerminalFactsV2(state, operationId).length > 0
        || deniedOperations.has(operationId)
    );
  });
  return everyOperationSettled && cleanupSettled(facts);
}

export function finalizeSessionKernelReviewV2(
  state: SessionKernelLoopStateV2,
  finalizedAt: string
): SessionKernelReviewV2 {
  if (!canFinalizeSessionKernelReviewV2(state)) {
    throw new SessionKernelReviewError(
      'session_kernel_review_not_finalizable',
      'Review cannot be finalized while planned work, active state, cleanup, or indeterminate outcomes remain unresolved.'
    );
  }
  const draft = buildSessionKernelReviewV2(state, finalizedAt);
  return {
    ...draft,
    status: 'final',
    finalizedAt,
  };
}

function plannedActions(
  state: SessionKernelLoopStateV2
): SessionReviewPlannedActionV2[] {
  return (state.plan?.actions ?? []).map((action) => ({
    taskId: action.taskId,
    planActionId: action.manifest.planActionId,
    operationId: action.manifest.operationId,
    toolId: action.manifest.toolId,
  }));
}

function planActionOperationIds(
  state: SessionKernelLoopStateV2,
  planActionId: string
): string[] {
  return [
    ...(state.lineage.planActions[planActionId]?.operationIds ?? []),
  ];
}

function planActionInvocationCount(
  state: SessionKernelLoopStateV2,
  planActionId: string
): number {
  return planActionOperationIds(state, planActionId).reduce(
    (count, operationId) =>
      count
      + (
        state.lineage.operations[operationId]?.invocationIds.length
        ?? 0
      ),
    0
  );
}

function cleanupSettled(facts: KernelFactProjectionV2[]): boolean {
  const cleanupFacts = facts.filter((fact) => fact.domain === 'cleanup');
  if (cleanupFacts.length === 0) return true;
  const latestByResource = new Map<string, KernelFactProjectionV2>();
  for (const fact of cleanupFacts) {
    const resourceIds = fact.lineage.resourceIds.length > 0
      ? fact.lineage.resourceIds
      : [`fact:${fact.factId}`];
    for (const resourceId of resourceIds) {
      const previous = latestByResource.get(resourceId);
      if (!previous || previous.ledgerSequence < fact.ledgerSequence) {
        latestByResource.set(resourceId, fact);
      }
    }
  }
  return [...latestByResource.values()].every(
    (fact) =>
      fact.factKind
        === SESSION_KERNEL_FACT_KINDS_V2.cleanup.completed
  );
}

function selectFacts(
  facts: KernelFactProjectionV2[],
  predicate: (fact: KernelFactProjectionV2) => boolean
): SessionReviewFactRefV2[] {
  return facts.filter(predicate).map(toFactRef);
}

function toFactRef(fact: KernelFactProjectionV2): SessionReviewFactRefV2 {
  return {
    factId: fact.factId,
    ledgerSequence: fact.ledgerSequence,
    domain: fact.domain,
    factKind: fact.factKind,
    ...(fact.lineage.controlEpoch !== undefined
      ? { controlEpoch: fact.lineage.controlEpoch }
      : {}),
    planActionIds: [...fact.lineage.planActionIds],
    resourceIds: [...fact.lineage.resourceIds],
    ...(fact.lineage.operationId
      ? { operationId: fact.lineage.operationId }
      : {}),
    ...(fact.lineage.invocationId
      ? { invocationId: fact.lineage.invocationId }
      : {}),
    ...(fact.lineage.effectId ? { effectId: fact.lineage.effectId } : {}),
    details: cloneJson(fact.details),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneReview(review: SessionKernelReviewV2): SessionKernelReviewV2 {
  return JSON.parse(JSON.stringify(review)) as SessionKernelReviewV2;
}

export class SessionKernelReviewError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelReviewError';
  }
}
