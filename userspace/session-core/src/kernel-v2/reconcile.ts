import type {
  KernelFactProjectionPageV2,
  KernelFactProjectionV2,
} from '@deepcode/protocol';
import {
  reduceSessionKernelFactsV2,
  sessionKernelFactsCaughtUpV2,
} from './lineage.js';
import {
  requireSessionToolContextRefreshV2,
} from './toolContext.js';
import {
  cloneSessionKernelLoopStateV2,
  type SessionKernelLoopStateV2,
} from './state.js';

const INVOCATION_TERMINAL_FACTS = new Set([
  'completed',
  'failedBeforeEffect',
  'cancelledBeforeEffect',
  'timedOutBeforeEffect',
  'failedAfterObservedEffect',
  'indeterminate',
]);

const CAPABILITY_ALLOWED_FACTS = new Set([
  'capabilityIssued',
  'expansionAllowed',
]);

const CAPABILITY_DENIED_FACTS = new Set([
  'capabilityDenied',
  'expansionDenied',
]);

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
  const known = new Set(Object.keys(state.factsById));
  let next = cloneSessionKernelLoopStateV2(state);
  next.lineage = reduceSessionKernelFactsV2(next.lineage, page);
  const newFacts = page.facts.filter((fact) => !known.has(fact.factId));
  for (const fact of newFacts) {
    next.factsById[fact.factId] = cloneFact(fact);
    recordTerminalLineage(next, fact);
    if (
      fact.domain === 'authorization'
      && fact.factKind === 'contextInvalidated'
    ) {
      next.toolContext = requireSessionToolContextRefreshV2(
        next.toolContext,
        'kernelFact'
      );
    }
  }
  next.kernelWakeHint = false;
  next = resolveActiveWait(next, newFacts);
  return {
    state: next,
    newFactIds: newFacts.map((fact) => fact.factId),
    waitChanged: previousWait !== JSON.stringify(next.activeWait),
    caughtUp: sessionKernelFactsCaughtUpV2(next.lineage),
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
      && INVOCATION_TERMINAL_FACTS.has(fact.factKind)
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
      fact.factKind === 'indeterminate'
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
      && INVOCATION_TERMINAL_FACTS.has(fact.factKind)
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
    || !INVOCATION_TERMINAL_FACTS.has(fact.factKind)
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
  const nestedFact = fact.details.fact;
  const nestedData =
    typeof nestedFact === 'object'
    && nestedFact !== null
    && !Array.isArray(nestedFact)
    && typeof nestedFact.data === 'object'
    && nestedFact.data !== null
    && !Array.isArray(nestedFact.data)
      ? nestedFact.data
      : undefined;
  const value = fact.details[field] ?? nestedData?.[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function cloneFact(fact: KernelFactProjectionV2): KernelFactProjectionV2 {
  return JSON.parse(JSON.stringify(fact)) as KernelFactProjectionV2;
}
