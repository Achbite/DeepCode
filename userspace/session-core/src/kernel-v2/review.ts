import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import { sessionKernelFactsCaughtUpV2 } from './lineage.js';
import {
  sessionKernelFactBarriersPendingV2,
} from './factBarriers.js';
import {
  currentSessionWorkAuthorityV3,
  sameSessionWorkAuthorityV3,
  type SessionKernelLoopStateV2,
} from './state.js';
import {
  SESSION_KERNEL_REVIEW_PROJECTION_V2,
  type SessionFinalAnswerBindingV3,
  type SessionKernelReviewV2,
  SessionReviewFactCategoryAccumulatorV2,
  SessionReviewFactCoverageV2,
  SessionReviewPlannedActionV2,
  type SessionWorkAuthorityV3,
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
  if (
    state.kernelWakeHint
    || !sessionKernelFactsCaughtUpV2(state.lineage)
    || sessionKernelFactBarriersPendingV2(state)
    || (
      state.providerToolCallQueue
      && !state.providerToolCallQueue.outcomeRecorded
    )
  ) {
    throw new SessionKernelReviewError(
      'session_kernel_review_snapshot_incomplete',
      'Review requires a fully reconciled Kernel snapshot with every exact command fact observed.'
    );
  }
  const snapshotHighWater = state.lineage.cursor.snapshotHighWater;
  const workAuthority = currentSessionWorkAuthorityV3(state);
  const planActionSettlementDigest = sha256Hash(canonicalJson(
    {
      projectionVersion: SESSION_KERNEL_REVIEW_PROJECTION_V2,
      settlements: Object.values(state.planActionSettlements).sort(
        (left, right) =>
          left.planActionId.localeCompare(right.planActionId)
      ),
    }
  ));
  if (
    state.review
    && state.review.projectionVersion
      === SESSION_KERNEL_REVIEW_PROJECTION_V2
    && state.review.snapshotHighWater === snapshotHighWater
    && sameOptionalWorkAuthorityV3(
      state.review.workAuthority,
      workAuthority
    )
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
    projectionVersion: SESSION_KERNEL_REVIEW_PROJECTION_V2,
    revision: (state.review?.revision ?? 0) + 1,
    status: 'draft',
    ...(workAuthority
      ? { workAuthority: cloneJson(workAuthority) }
      : {}),
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
        state.planActionSettlements[action.planActionId]?.outcome
          !== 'completed'
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
  const workAuthority = currentSessionWorkAuthorityV3(state);
  if (
    !workAuthority
    || (
      workAuthority.kind === 'plan'
      && (
        state.planDecision?.planRevision
          !== workAuthority.planRevision
        || (
          state.planDecision.decision !== 'accept'
          && state.planDecision.decision !== 'reject'
        )
      )
    )
    || state.kernelWakeHint
    || !sessionKernelFactsCaughtUpV2(state.lineage)
    || state.activeWait
    || state.providerTurn?.status === 'active'
    || state.providerTurn?.status === 'awaitingTools'
    || state.providerToolCallQueue?.status === 'active'
    || (
      state.providerToolCallQueue
      && !state.providerToolCallQueue.outcomeRecorded
    )
    || Object.keys(state.publicRequests).length > 0
    || sessionKernelFactBarriersPendingV2(state)
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
  const review = draft.status === 'final'
    ? draft
    : {
    ...draft,
    revision: draft.revision + 1,
    status: 'final',
    finalizedAt,
  } as SessionKernelReviewV2;
  prepareSessionFinalAnswerV3(state, review);
  return review;
}

export function sessionFinalAnswerBindingV3(
  state: SessionKernelLoopStateV2,
  review: SessionKernelReviewV2
): SessionFinalAnswerBindingV3 {
  const workAuthority = currentSessionWorkAuthorityV3(state);
  if (
    review.status !== 'final'
    || !workAuthority
    || !review.workAuthority
    || !sameSessionWorkAuthorityV3(
      review.workAuthority,
      workAuthority
    )
    || (
      workAuthority.kind === 'plan'
      && review.planRevision !== workAuthority.planRevision
    )
    || (
      workAuthority.kind === 'contextRead'
      && review.planRevision !== undefined
    )
    || review.snapshotHighWater
      !== state.lineage.cursor.snapshotHighWater
  ) {
    throw new SessionKernelReviewError(
      'session_kernel_final_answer_review_binding_invalid',
      'Final answer requires the exact frozen current Review.'
    );
  }
  return {
    inputId: state.currentInputId,
    controlEpoch: state.controlEpoch,
    workAuthority: cloneJson(workAuthority),
    reviewRevision: review.revision,
    snapshotHighWater: review.snapshotHighWater,
  };
}

export function sameSessionFinalAnswerBindingV3(
  left: SessionFinalAnswerBindingV3,
  right: SessionFinalAnswerBindingV3
): boolean {
  return left.inputId === right.inputId
    && left.controlEpoch === right.controlEpoch
    && sameSessionWorkAuthorityV3(
      left.workAuthority,
      right.workAuthority
    )
    && left.reviewRevision === right.reviewRevision
    && left.snapshotHighWater === right.snapshotHighWater;
}

export function sameSessionFinalAnswerAuthorityV3(
  left: SessionFinalAnswerBindingV3,
  right: SessionFinalAnswerBindingV3
): boolean {
  return left.inputId === right.inputId
    && left.controlEpoch === right.controlEpoch
    && sameSessionWorkAuthorityV3(
      left.workAuthority,
      right.workAuthority
    );
}

function sameOptionalWorkAuthorityV3(
  left: SessionWorkAuthorityV3 | undefined,
  right: SessionWorkAuthorityV3 | undefined
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && sameSessionWorkAuthorityV3(left, right);
}

/**
 * A facts high-water advance invalidates the frozen Review binding. Keep that
 * invalidation in the same durable facts settlement that advances the cursor,
 * before a replacement Review is built or projected.
 */
export function staleSessionFinalAnswerForFactsDriftV3(
  state: SessionKernelLoopStateV2,
  observedAt: string
): boolean {
  const previous = state.finalAnswer;
  if (
    !previous
    || previous.status === 'stale'
    || previous.binding.snapshotHighWater
      === state.lineage.cursor.snapshotHighWater
  ) {
    return false;
  }
  state.finalAnswer = {
    status: 'stale',
    binding: cloneJson(previous.binding),
    physicalRequestCount: previous.physicalRequestCount,
    ...(previous.providerTurnId
      ? { providerTurnId: previous.providerTurnId }
      : {}),
    staleAt: observedAt,
    lastErrorCode: 'session_kernel_final_answer_binding_stale',
  };
  const providerTurn = state.providerTurn;
  if (
    previous.providerTurnId
    && providerTurn?.providerTurnId === previous.providerTurnId
    && (
      providerTurn.status === 'active'
      || providerTurn.status === 'completed'
      || providerTurn.status === 'aborted'
    )
  ) {
    providerTurn.status = 'stale';
  }
  return true;
}

function prepareSessionFinalAnswerV3(
  state: SessionKernelLoopStateV2,
  review: SessionKernelReviewV2
): void {
  const binding = sessionFinalAnswerBindingV3(state, review);
  const previous = state.finalAnswer;
  if (
    previous
    && sameSessionFinalAnswerBindingV3(previous.binding, binding)
    && previous.status !== 'stale'
  ) {
    return;
  }
  const physicalRequestCount = previous?.binding.inputId === binding.inputId
    ? previous.physicalRequestCount
    : 0;
  state.finalAnswer = physicalRequestCount >= 3
    ? {
        status: 'finalAnswerFailed',
        binding,
        physicalRequestCount,
        failedAt: review.finalizedAt ?? review.createdAt,
        lastErrorCode:
          previous?.lastErrorCode
          ?? 'session_kernel_final_answer_budget_exhausted',
      }
    : {
        status: 'pending',
        binding,
        physicalRequestCount,
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
