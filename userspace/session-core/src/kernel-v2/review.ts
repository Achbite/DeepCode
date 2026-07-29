import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import { sessionKernelFactsCaughtUpV2 } from './lineage.js';
import type { SessionKernelLoopStateV2 } from './state.js';
import type {
  SessionKernelReviewV2,
  SessionReviewFactCategoryAccumulatorV2,
  SessionReviewFactCoverageV2,
  SessionReviewPlannedActionV2,
} from './types.js';

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
  const planActionSettlementDigest = sha256Hash(canonicalJson(
    Object.values(state.planActionSettlements).sort(
      (left, right) =>
        left.planActionId.localeCompare(right.planActionId)
    )
  ));
  if (
    state.review
    && state.review.snapshotHighWater === snapshotHighWater
    && state.review.planRevision === state.plan?.planRevision
    && JSON.stringify(state.review.planDecision)
      === JSON.stringify(state.planDecision)
    && state.review.planActionSettlementDigest
      === planActionSettlementDigest
  ) {
    return cloneReview(state.review);
  }
  const planned = plannedActions(state);
  const reviewFacts = state.reviewFacts;
  return {
    revision: (state.review?.revision ?? 0) + 1,
    status: 'draft',
    ...(state.plan?.planRevision
      ? { planRevision: state.plan.planRevision }
      : {}),
    ...(state.planDecision
      ? { planDecision: cloneJson(state.planDecision) }
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
    planActionSettlementDigest,
    snapshotHighWater,
    planned,
    scopeExpansions: cloneJson(reviewFacts.scopeExpansions.samples),
    actualEffects: cloneJson(reviewFacts.actualEffects.samples),
    unexecuted: planned.filter(
      (action) =>
        !sessionKernelPlanActionSettledV2(
          state,
          action.planActionId
        )
    ),
    denied: cloneJson(reviewFacts.denied.samples),
    rejections: cloneJson(reviewFacts.rejections.samples),
    completions: Object.values(state.planActionSettlements)
      .sort((left, right) =>
        left.recordedAt.localeCompare(right.recordedAt)
        || left.planActionId.localeCompare(right.planActionId)
      ),
    cleanup: cloneJson(reviewFacts.cleanup.samples),
    indeterminate: cloneJson(reviewFacts.indeterminate.samples),
    priorEpochLateFacts: cloneJson(
      reviewFacts.priorEpochLateFacts.samples
    ),
    factCoverage: {
      scopeExpansions: factCoverage(
        reviewFacts.scopeExpansions
      ),
      actualEffects: factCoverage(reviewFacts.actualEffects),
      denied: factCoverage(reviewFacts.denied),
      rejections: factCoverage(reviewFacts.rejections),
      cleanup: factCoverage(reviewFacts.cleanup),
      indeterminate: factCoverage(reviewFacts.indeterminate),
      priorEpochLateFacts: factCoverage(
        reviewFacts.priorEpochLateFacts
      ),
    },
    factsQuery: {
      runId: state.runId,
      controlEpoch: reviewFacts.controlEpoch,
      afterLedgerSequence:
        reviewFacts.coverageAfterLedgerSequence,
      snapshotHighWater,
    },
    pendingCleanupCount: Object.keys(
      reviewFacts.pendingCleanupByResource
    ).length,
    createdAt,
  };
}

/**
 * Caught-up means only that the current facts snapshot is complete. Final
 * Review additionally requires no active orchestration/request state, no
 * indeterminate outcome, and settled cleanup facts. Unsettled PlanActions are
 * represented as unexecuted review items rather than synthetic settlements.
 */
export function canFinalizeSessionKernelReviewV2(
  state: SessionKernelLoopStateV2
): boolean {
  if (
    !state.plan
    || state.planDecision?.planRevision !== state.plan.planRevision
    || state.planDecision.decision !== 'accept'
    || !sessionKernelFactsCaughtUpV2(state.lineage)
    || state.activeWait
    || state.providerTurn?.status === 'active'
    || Object.keys(state.publicRequests).length > 0
    || state.pendingGuidance.length > 0
  ) {
    return false;
  }
  if (state.reviewFacts.indeterminate.totalCount > 0) {
    return false;
  }
  return Object.keys(
    state.reviewFacts.pendingCleanupByResource
  ).length === 0;
}

export function sessionKernelPlanActionSettledV2(
  state: SessionKernelLoopStateV2,
  planActionId: string
): boolean {
  return Boolean(state.planActionSettlements[planActionId]);
}

export function finalizeSessionKernelReviewV2(
  state: SessionKernelLoopStateV2,
  finalizedAt: string
): SessionKernelReviewV2 {
  if (!canFinalizeSessionKernelReviewV2(state)) {
    throw new SessionKernelReviewError(
      'session_kernel_review_not_finalizable',
      'Review cannot be finalized while active state, cleanup, or indeterminate outcomes remain unresolved.'
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

function factCoverage(
  category: SessionReviewFactCategoryAccumulatorV2
): SessionReviewFactCoverageV2 {
  return {
    totalCount: category.totalCount,
    retainedCount: category.samples.length,
    omittedCount:
      category.totalCount - category.samples.length,
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
