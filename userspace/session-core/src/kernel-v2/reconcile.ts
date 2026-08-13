import type {
  KernelFactProjectionPageV2,
  KernelFactProjectionV2,
} from '@deepcode/protocol';
import {
  clearSessionCapabilityLeasesV2,
  invalidateSessionCapabilityLeaseV2,
  recordSessionCapabilityLeaseV2,
  reduceSessionKernelFactsV2,
  sessionKernelFactsCaughtUpV2,
} from './lineage.js';
import {
  SESSION_KERNEL_FACT_KINDS_V2,
  SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2,
  SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2,
} from './factKinds.js';
import {
  reconcileSessionKernelFactBarriersV2,
  sessionKernelFactBarriersPendingV2,
} from './factBarriers.js';
import {
  recordSessionToolContextInvalidationV2,
} from './toolContext.js';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  cloneSessionKernelLoopStateV2,
  type SessionKernelLoopStateV2,
} from './state.js';
import type {
  SessionReviewFactCategoryAccumulatorV2,
  SessionReviewFactRefV2,
} from './types.js';

const CAPABILITY_ALLOWED_FACTS = new Set<string>([
  SESSION_KERNEL_FACT_KINDS_V2.authorization.capabilityIssued,
  SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionAllowed,
]);

const CAPABILITY_LEASE_EVIDENCE_FACTS = new Set<string>([
  ...CAPABILITY_ALLOWED_FACTS,
  SESSION_KERNEL_FACT_KINDS_V2.invocation.admitted,
]);

const CAPABILITY_LEASE_INVALIDATION_FACTS = new Set<string>([
  SESSION_KERNEL_FACT_KINDS_V2.authorization.leaseRevoked,
  SESSION_KERNEL_FACT_KINDS_V2.authorization.leaseSuperseded,
]);

const CAPABILITY_DENIED_FACTS = new Set<string>([
  SESSION_KERNEL_FACT_KINDS_V2.authorization.capabilityDenied,
  SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionDenied,
]);

const SCOPE_EXPANSION_FACTS = new Set<string>([
  SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionAllowed,
  SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionDenied,
]);
const MAX_RECENT_FACT_COUNT = 256;
const MAX_RECENT_FACT_BYTES = 512 * 1024;
const MAX_RECENT_SINGLE_FACT_BYTES = 64 * 1024;
const MAX_REVIEW_FACT_SAMPLES_PER_CATEGORY = 16;
const MAX_REVIEW_FACT_DETAILS_BYTES = 4 * 1024;
const MAX_REVIEW_FACT_REF_BYTES = 16 * 1024;
const MAX_REVIEW_LINEAGE_IDS = 4;

export interface SessionKernelReconcileResultV2 {
  state: SessionKernelLoopStateV2;
  newFactIds: string[];
  waitChanged: boolean;
  caughtUp: boolean;
}

/**
 * Reduces canonical Kernel facts only. Notifications and submission replies
 * may wake this reducer, but neither can manufacture completion.
 */
export function reconcileSessionKernelFactsPageV2(
  state: SessionKernelLoopStateV2,
  page: KernelFactProjectionPageV2
): SessionKernelReconcileResultV2 {
  const previousWait = JSON.stringify(state.activeWait);
  let next = cloneSessionKernelLoopStateV2(state);
  next.lineage = reduceSessionKernelFactsV2(
    next.lineage,
    page,
    next.controlEpoch
  );
  const newFacts = page.facts;
  for (const fact of newFacts) {
    const recent = compactRecentFact(fact);
    if (recent) {
      next.factsById[fact.factId] = recent;
    } else {
      next.factHistoryOmittedCount += 1;
    }
    recordReviewFact(next, fact);
    recordTerminalLineage(next, fact);
    if (
      fact.domain === 'authorization'
      && fact.factKind
        === SESSION_KERNEL_FACT_KINDS_V2.authorization.contextInvalidated
    ) {
      const previousExpectedContextRef =
        next.toolContext.expectedContextRef;
      const previousRefreshRequired =
        next.toolContext.refreshRequired;
      const updatedToolContext = recordSessionToolContextInvalidationV2(
        next.toolContext,
        fact.details
      );
      const invalidationAdvanced =
        updatedToolContext.refreshRequired
        && (
          !previousRefreshRequired
          || !previousExpectedContextRef
          || !updatedToolContext.expectedContextRef
          || previousExpectedContextRef.contextVersion
            !== updatedToolContext.expectedContextRef.contextVersion
          || previousExpectedContextRef.catalogDigest
            !== updatedToolContext.expectedContextRef.catalogDigest
          || previousExpectedContextRef.contextDigest
            !== updatedToolContext.expectedContextRef.contextDigest
        );
      next.toolContext = updatedToolContext;
      if (invalidationAdvanced) {
        next.lineage = clearSessionCapabilityLeasesV2(next.lineage);
        next.previews = {};
      }
    }
    if (
      fact.domain === 'authorization'
      && CAPABILITY_LEASE_INVALIDATION_FACTS.has(fact.factKind)
      && fact.lineage.capabilityLease
      && fact.lineage.operationId
      && fact.lineage.planActionIds.length === 1
      && fact.lineage.controlEpoch === next.controlEpoch
      && factPlanRevision(fact) === next.plan?.planRevision
      && factOperationBelongsToCurrentPlanAction(
        next,
        fact.lineage.operationId,
        fact.lineage.planActionIds[0]!
      )
    ) {
      next.lineage = invalidateSessionCapabilityLeaseV2(
        next.lineage,
        {
          planActionId: fact.lineage.planActionIds[0]!,
          lease: fact.lineage.capabilityLease,
        }
      );
    }
    if (
      (
        fact.domain === 'authorization'
        || fact.domain === 'invocation'
      )
      && CAPABILITY_LEASE_EVIDENCE_FACTS.has(fact.factKind)
      && fact.lineage.capabilityLease
      && fact.lineage.operationId
      && fact.lineage.planActionIds.length === 1
      && fact.lineage.controlEpoch === next.controlEpoch
      && next.lineage.planActions[
        fact.lineage.planActionIds[0]!
      ]
      && factPlanRevision(fact) === next.plan?.planRevision
      && factOperationBelongsToCurrentPlanAction(
        next,
        fact.lineage.operationId,
        fact.lineage.planActionIds[0]!
      )
    ) {
      next.lineage = recordSessionCapabilityLeaseV2(next.lineage, {
        operationId: fact.lineage.operationId,
        planActionId: fact.lineage.planActionIds[0]!,
        lease: fact.lineage.capabilityLease,
      });
    }
  }
  reconcileSessionKernelFactBarriersV2(next, newFacts);
  boundRecentFacts(next);
  const lineageCaughtUp =
    sessionKernelFactsCaughtUpV2(next.lineage);
  const factBarriersPending =
    sessionKernelFactBarriersPendingV2(next);
  next.kernelWakeHint =
    !lineageCaughtUp || factBarriersPending;
  next = resolveActiveWait(next, newFacts);
  return {
    state: next,
    newFactIds: newFacts.map((fact) => fact.factId),
    waitChanged: previousWait !== JSON.stringify(next.activeWait),
    caughtUp: lineageCaughtUp && !factBarriersPending,
  };
}

export function operationTerminalFactsV2(
  state: SessionKernelLoopStateV2,
  operationId: string
): KernelFactProjectionV2[] {
  return orderedFacts(state).filter(
    (fact) =>
      fact.domain === 'invocation'
      && fact.lineage.operationId === operationId
      && SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2.has(
        fact.factKind
      )
  );
}

export function operationEffectFactsV2(
  state: SessionKernelLoopStateV2,
  operationId: string
): KernelFactProjectionV2[] {
  return orderedFacts(state).filter(
    (fact) =>
      fact.domain === 'effect'
      && fact.lineage.operationId === operationId
  );
}

export function orderedFacts(
  state: SessionKernelLoopStateV2
): KernelFactProjectionV2[] {
  return Object.values(state.factsById).sort(
    (left, right) =>
      left.ledgerSequence - right.ledgerSequence
      || left.factId.localeCompare(right.factId)
  );
}

function resolveActiveWait(
  state: SessionKernelLoopStateV2,
  facts: KernelFactProjectionV2[]
): SessionKernelLoopStateV2 {
  let next = state;
  const indeterminate = facts.filter(
    (fact) =>
      fact.factKind
        === SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate
      && Boolean(fact.lineage.operationId)
  );
  if (indeterminate.length > 0) {
    const last = indeterminate[indeterminate.length - 1]!;
    next.activeWait = {
      kind: 'manualRecovery',
      operationId: last.lineage.operationId!,
      ...(last.lineage.invocationId
        ? { invocationId: last.lineage.invocationId }
        : {}),
      reason: 'indeterminate',
      factIds: indeterminate.map((fact) => fact.factId),
    };
    return next;
  }

  const wait = next.activeWait;
  if (
    !wait
    || wait.kind === 'backpressure'
    || wait.kind === 'manualRecovery'
    || wait.kind === 'userIntervention'
  ) {
    return next;
  }
  const related = facts.filter(
    (fact) =>
      fact.lineage.operationId === wait.operationId
      || fact.lineage.invocationId === wait.invocationId
  );
  const terminal = related.find(
    (fact) =>
      fact.domain === 'invocation'
      && fact.lineage.invocationId === wait.invocationId
      && SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2.has(
        fact.factKind
      )
  );
  if (terminal) {
    next.activeWait = undefined;
    return next;
  }

  if (wait.kind === 'capability') {
    const denied = related.find(
      (fact) =>
        fact.domain === 'authorization'
        && CAPABILITY_DENIED_FACTS.has(fact.factKind)
    );
    if (denied) {
      const guidance = wait.denialGuidance
        ?? detailText(denied, 'guidance')
        ?? 'The requested capability was denied. Replan within the approved scope.';
      if (!next.pendingGuidance.includes(guidance)) {
        next.pendingGuidance.push(guidance);
      }
      next.activeWait = undefined;
      return next;
    }
    const allowed = related.find(
      (fact) =>
        fact.domain === 'authorization'
        && CAPABILITY_ALLOWED_FACTS.has(fact.factKind)
    );
    if (allowed) {
      next.activeWait = {
        kind: 'invocation',
        operationId: wait.operationId,
        invocationId: wait.invocationId,
        sinceHighWater: Math.max(
          wait.sinceHighWater,
          allowed.ledgerSequence
        ),
      };
    }
  }
  return next;
}

function recordTerminalLineage(
  state: SessionKernelLoopStateV2,
  fact: KernelFactProjectionV2
): void {
  if (
    fact.domain !== 'invocation'
    || !fact.lineage.invocationId
    || !SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2.has(
      fact.factKind
    )
  ) {
    return;
  }
  const invocation = state.lineage.invocations[fact.lineage.invocationId];
  if (invocation) invocation.lastTerminalPhase = fact.factKind;
}

function detailText(
  fact: KernelFactProjectionV2,
  field: string
): string | undefined {
  const value = fact.details[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function cloneFact(fact: KernelFactProjectionV2): KernelFactProjectionV2 {
  return JSON.parse(JSON.stringify(fact)) as KernelFactProjectionV2;
}

function compactRecentFact(
  fact: KernelFactProjectionV2
): KernelFactProjectionV2 | undefined {
  const cloned = cloneFact(fact);
  const details = canonicalJson(cloned.details);
  const detailBytes = utf8Bytes(details);
  if (detailBytes > MAX_REVIEW_FACT_DETAILS_BYTES) {
    cloned.details = {
      detailsOmitted: true,
      detailsDigest: sha256Hash(details),
      detailsByteLength: detailBytes,
    };
  }
  return utf8Bytes(canonicalJson(cloned))
      <= MAX_RECENT_SINGLE_FACT_BYTES
    ? cloned
    : undefined;
}

function boundRecentFacts(
  state: SessionKernelLoopStateV2
): void {
  const ordered = Object.values(state.factsById).sort(
    (left, right) =>
      right.ledgerSequence - left.ledgerSequence
      || left.factId.localeCompare(right.factId)
  );
  const retained: KernelFactProjectionV2[] = [];
  let bytes = 0;
  for (const fact of ordered) {
    if (retained.length >= MAX_RECENT_FACT_COUNT) break;
    const factBytes = utf8Bytes(canonicalJson(fact));
    if (bytes + factBytes > MAX_RECENT_FACT_BYTES) {
      continue;
    }
    retained.push(fact);
    bytes += factBytes;
  }
  const retainedIds = new Set(
    retained.map((fact) => fact.factId)
  );
  state.factHistoryOmittedCount +=
    ordered.length - retained.length;
  state.factsById = Object.fromEntries(
    Object.entries(state.factsById)
      .filter(([factId]) => retainedIds.has(factId))
  );
}

function recordReviewFact(
  state: SessionKernelLoopStateV2,
  fact: KernelFactProjectionV2
): void {
  if (
    fact.ledgerSequence
      <= state.reviewFacts.coverageAfterLedgerSequence
  ) {
    return;
  }
  if (
    fact.lineage.controlEpoch
      !== state.reviewFacts.controlEpoch
  ) {
    recordPriorEpochLateFact(state, fact);
    return;
  }
  const operationId = fact.lineage.operationId;
  const priorAuthorizationSequence = operationId
    ? state.reviewFacts.authorizedOperationSequences[operationId]
    : undefined;
  const isScopeExpansion =
    fact.domain === 'authorization'
    && (
      SCOPE_EXPANSION_FACTS.has(fact.factKind)
      || (
        fact.factKind
          === SESSION_KERNEL_FACT_KINDS_V2.authorization.scopePreviewed
        && priorAuthorizationSequence !== undefined
        && priorAuthorizationSequence < fact.ledgerSequence
      )
    );
  if (isScopeExpansion) {
    appendReviewSample(
      state.reviewFacts.scopeExpansions,
      fact
    );
  }
  if (
    fact.domain === 'authorization'
    && CAPABILITY_ALLOWED_FACTS.has(fact.factKind)
    && operationId
  ) {
    state.reviewFacts.authorizedOperationSequences[operationId] =
      fact.ledgerSequence;
  }
  if (
    fact.domain === 'effect'
    && SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2.has(
      fact.factKind
    )
  ) {
    appendReviewSample(state.reviewFacts.actualEffects, fact);
    const planRevision = factPlanRevision(fact);
    if (planRevision) {
      const observedForRevision =
        state.reviewFacts.observedEffectPlanActions[planRevision]
        ?? {};
      for (const planActionId of fact.lineage.planActionIds) {
        observedForRevision[planActionId] = {
          factId: fact.factId,
          ledgerSequence: fact.ledgerSequence,
          ...(fact.lineage.effectId
            ? { effectId: fact.lineage.effectId }
            : {}),
        };
      }
      state.reviewFacts.observedEffectPlanActions[planRevision] =
        observedForRevision;
    }
  }
  if (
    fact.domain === 'authorization'
    && CAPABILITY_DENIED_FACTS.has(fact.factKind)
  ) {
    appendReviewSample(state.reviewFacts.denied, fact);
  } else if (isRejectedToolIntentCommandFact(fact)) {
    const sessionPlanActionId = operationId
      ? state.operationPlanActionBindings[operationId]
        ?.planActionId
      : undefined;
    appendReviewSample(
      state.reviewFacts.rejections,
      fact,
      sessionPlanActionId
    );
  }
  if (fact.domain === 'cleanup') {
    appendReviewSample(state.reviewFacts.cleanup, fact);
    updatePendingCleanup(state, fact);
  }
  if (
    fact.domain === 'invocation'
    && fact.factKind
      === SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate
  ) {
    appendReviewSample(state.reviewFacts.indeterminate, fact);
  }
}

function recordPriorEpochLateFact(
  state: SessionKernelLoopStateV2,
  fact: KernelFactProjectionV2
): void {
  const observedEffect =
    fact.domain === 'effect'
    && SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2.has(
      fact.factKind
    );
  const cleanup = fact.domain === 'cleanup';
  const indeterminate =
    fact.domain === 'invocation'
    && fact.factKind
      === SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate;
  const failedAfterEffect =
    fact.domain === 'invocation'
    && fact.factKind
      === SESSION_KERNEL_FACT_KINDS_V2.invocation
        .failedAfterObservedEffect;
  if (
    !observedEffect
    && !cleanup
    && !indeterminate
    && !failedAfterEffect
  ) {
    return;
  }
  appendReviewSample(
    state.reviewFacts.priorEpochLateFacts,
    fact
  );
  if (observedEffect) {
    appendReviewSample(state.reviewFacts.actualEffects, fact);
  }
  if (cleanup) {
    appendReviewSample(state.reviewFacts.cleanup, fact);
    updatePendingCleanup(state, fact);
  }
  if (indeterminate) {
    appendReviewSample(state.reviewFacts.indeterminate, fact);
  }
}

function isRejectedToolIntentCommandFact(
  fact: KernelFactProjectionV2
): boolean {
  if (
    fact.domain !== 'control'
    || fact.factKind
      !== SESSION_KERNEL_FACT_KINDS_V2.control.commandRecorded
  ) {
    return false;
  }
  const result = fact.details.result;
  if (!isJsonRecord(result) || result.kind !== 'toolIntentSubmission') {
    return false;
  }
  const resultData = result.data;
  if (!isJsonRecord(resultData)) return false;
  const reply = resultData.reply;
  return isJsonRecord(reply) && reply.kind === 'rejected';
}

function isJsonRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function factPlanRevision(
  fact: KernelFactProjectionV2
): string | undefined {
  const identity = fact.details.identity;
  if (!isJsonRecord(identity)) return undefined;
  if (typeof identity.planRevision === 'string') {
    return identity.planRevision;
  }
  const authority = identity.authority;
  if (!isJsonRecord(authority) || authority.kind !== 'planAction') {
    return undefined;
  }
  const data = authority.data;
  return isJsonRecord(data) && typeof data.planRevision === 'string'
    ? data.planRevision
    : undefined;
}

function factOperationBelongsToCurrentPlanAction(
  state: SessionKernelLoopStateV2,
  operationId: string,
  planActionId: string
): boolean {
  const binding = state.operationPlanActionBindings[operationId];
  if (binding) {
    return binding.controlEpoch === state.controlEpoch
      && binding.planRevision === state.plan?.planRevision
      && binding.planActionId === planActionId;
  }
  const factDerivedOperation = state.lineage.operations[operationId];
  const currentPlanAction = state.lineage.planActions[planActionId];
  if (
    factDerivedOperation?.planActionId === planActionId
    && currentPlanAction?.planRevision === state.plan?.planRevision
  ) {
    return true;
  }
  return state.plan?.actions.some(
    (action) =>
      action.manifest.operationId === operationId
      && action.manifest.planActionId === planActionId
  ) ?? false;
}

function appendReviewSample(
  category: SessionReviewFactCategoryAccumulatorV2,
  fact: KernelFactProjectionV2,
  sessionPlanActionId?: string
): void {
  category.totalCount += 1;
  const reference = toReviewFactRef(
    fact,
    sessionPlanActionId
  );
  if (
    category.samples.length
      < MAX_REVIEW_FACT_SAMPLES_PER_CATEGORY
  ) {
    category.samples.push(reference);
    return;
  }
  category.samples.splice(4, 1);
  category.samples.push(reference);
}

function updatePendingCleanup(
  state: SessionKernelLoopStateV2,
  fact: KernelFactProjectionV2
): void {
  const resourceIds = fact.lineage.resourceIds.length > 0
    ? fact.lineage.resourceIds
    : ['unscoped'];
  for (const resourceId of resourceIds) {
    const resourceKey = sha256Hash(
      canonicalJson({ resourceId })
    );
    if (
      fact.factKind
        === SESSION_KERNEL_FACT_KINDS_V2.cleanup.completed
    ) {
      delete state.reviewFacts.pendingCleanupByResource[
        resourceKey
      ];
      continue;
    }
    state.reviewFacts.pendingCleanupByResource[resourceKey] = {
      factId: fact.factId,
      ledgerSequence: fact.ledgerSequence,
      factKind: fact.factKind,
    };
  }
}

function toReviewFactRef(
  fact: KernelFactProjectionV2,
  sessionPlanActionId?: string
): SessionReviewFactRefV2 {
  const originalDetails = canonicalJson(fact.details);
  const originalFact = canonicalJson(fact);
  const detailBytes = utf8Bytes(originalDetails);
  const compactDetails = detailBytes
      <= MAX_REVIEW_FACT_DETAILS_BYTES
    ? cloneFact(fact).details
    : {
        detailsOmitted: true,
        detailsDigest: sha256Hash(originalDetails),
        detailsByteLength: detailBytes,
      };
  let reference: SessionReviewFactRefV2 = {
    factId: fact.factId,
    ledgerSequence: fact.ledgerSequence,
    domain: fact.domain,
    factKind: fact.factKind,
    ...(fact.lineage.controlEpoch !== undefined
      ? { controlEpoch: fact.lineage.controlEpoch }
      : {}),
    planActionIds: [
      ...fact.lineage.planActionIds.slice(
        0,
        MAX_REVIEW_LINEAGE_IDS
      ),
    ],
    ...(sessionPlanActionId
      ? { sessionPlanActionId }
      : {}),
    resourceIds: [
      ...fact.lineage.resourceIds.slice(
        0,
        MAX_REVIEW_LINEAGE_IDS
      ),
    ],
    ...(fact.lineage.operationId
      ? { operationId: fact.lineage.operationId }
      : {}),
    ...(fact.lineage.invocationId
      ? { invocationId: fact.lineage.invocationId }
      : {}),
    ...(fact.lineage.effectId
      ? { effectId: fact.lineage.effectId }
      : {}),
    details: {
      ...compactDetails,
      planActionIdCount: fact.lineage.planActionIds.length,
      resourceIdCount: fact.lineage.resourceIds.length,
    },
  };
  if (
    utf8Bytes(canonicalJson(reference))
      > MAX_REVIEW_FACT_REF_BYTES
  ) {
    reference = {
      ...reference,
      planActionIds: [],
      resourceIds: [],
      details: {
        factSummaryOmitted: true,
        factDigest: sha256Hash(originalFact),
        factByteLength: utf8Bytes(originalFact),
        planActionIdCount: fact.lineage.planActionIds.length,
        resourceIdCount: fact.lineage.resourceIds.length,
      },
    };
  }
  if (
    utf8Bytes(canonicalJson(reference))
      > MAX_REVIEW_FACT_REF_BYTES
  ) {
    throw new Error(
      'session_kernel_review_fact_reference_oversized'
    );
  }
  return reference;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
