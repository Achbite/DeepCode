import type { KernelFactProjectionV2 } from '@deepcode/protocol';
import { canonicalJson } from '../cache/canonicalizer.js';
import type { SessionKernelLoopStateV2 } from './state.js';
import type {
  SessionProviderKernelFactsProjectionV2,
  SessionProviderTurnTargetV2,
} from './types.js';
import {
  SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2,
} from './factKinds.js';

export const SESSION_PROVIDER_FACTS_MAX_COUNT_V2 = 64;
export const SESSION_PROVIDER_FACTS_MAX_UTF8_BYTES_V2 = 64 * 1024;

const TARGET_HEAD_FACT_COUNT = 16;
const ACTIVE_WAIT_HEAD_FACT_COUNT = 8;
/**
 * Builds a deterministic, bounded projection for model context only. Kernel
 * remains the canonical fact store; Session retains only a recent fact window
 * plus compact reducers and exact high-water lineage.
 */
export function projectSessionProviderFactsV2(
  state: SessionKernelLoopStateV2,
  target: SessionProviderTurnTargetV2
): SessionProviderKernelFactsProjectionV2 {
  const canonicalFacts = Object.values(state.factsById)
    .sort(compareFactsAscending);
  const newestFirst = [...canonicalFacts].sort(compareFactsDescending);
  const targetMatcher = factMatcherForTarget(state, target);
  const activeWaitMatcher = factMatcherForActiveWait(state);
  const candidates: KernelFactProjectionV2[] = [];
  const candidateIds = new Set<string>();
  const append = (fact: KernelFactProjectionV2): void => {
    if (candidateIds.has(fact.factId)) return;
    candidateIds.add(fact.factId);
    candidates.push(fact);
  };

  newestFirst
    .filter(targetMatcher)
    .slice(0, TARGET_HEAD_FACT_COUNT)
    .forEach(append);
  newestFirst
    .filter(activeWaitMatcher)
    .slice(0, ACTIVE_WAIT_HEAD_FACT_COUNT)
    .forEach(append);

  for (const bucket of IMPORTANT_FACT_BUCKETS) {
    const latest = newestFirst.find(bucket.matches);
    if (latest) append(latest);
  }

  newestFirst.filter(targetMatcher).forEach(append);
  newestFirst.filter(activeWaitMatcher).forEach(append);
  newestFirst.filter(isImportantProviderFact).forEach(append);
  newestFirst.forEach(append);

  const selected: KernelFactProjectionV2[] = [];
  for (const candidate of candidates) {
    if (selected.length >= SESSION_PROVIDER_FACTS_MAX_COUNT_V2) break;
    const cloned = cloneFact(candidate);
    const trialFacts = [...selected, cloned].sort(compareFactsAscending);
    const trial = {
      snapshotHighWater: state.lineage.cursor.snapshotHighWater,
      omittedCount:
        state.factHistoryOmittedCount
        + canonicalFacts.length
        - trialFacts.length,
      facts: trialFacts,
    };
    if (
      utf8Bytes(canonicalJson(trial))
      <= SESSION_PROVIDER_FACTS_MAX_UTF8_BYTES_V2
    ) {
      selected.push(cloned);
    }
  }

  const facts = selected.sort(compareFactsAscending);
  return {
    snapshotHighWater: state.lineage.cursor.snapshotHighWater,
    omittedCount:
      state.factHistoryOmittedCount
      + canonicalFacts.length
      - facts.length,
    facts,
  };
}

const IMPORTANT_FACT_BUCKETS: ReadonlyArray<{
  matches: (fact: KernelFactProjectionV2) => boolean;
}> = [
  { matches: (fact) => fact.domain === 'control' },
  { matches: (fact) => fact.domain === 'authorization' },
  {
    matches: (fact) =>
      fact.domain === 'invocation'
      && SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2.has(
        fact.factKind
      ),
  },
  { matches: (fact) => fact.domain === 'effect' },
  { matches: (fact) => fact.domain === 'cleanup' },
];

function isImportantProviderFact(
  fact: KernelFactProjectionV2
): boolean {
  return IMPORTANT_FACT_BUCKETS.some((bucket) => bucket.matches(fact));
}

function factMatcherForTarget(
  state: SessionKernelLoopStateV2,
  target: SessionProviderTurnTargetV2
): (fact: KernelFactProjectionV2) => boolean {
  if (target.kind === 'planning') return () => false;
  if (target.kind === 'finalAnswer') return () => true;
  if (target.kind === 'contextRead') {
    return (fact) => fact.lineage.operationId === target.operationId;
  }
  const planActionId = target.planActionId;
  const operationIds = new Set(
    state.lineage.planActions[planActionId]?.operationIds ?? []
  );
  return (fact) =>
    fact.lineage.planActionIds.includes(planActionId)
    || (
      Boolean(fact.lineage.operationId)
      && operationIds.has(fact.lineage.operationId!)
    );
}

function factMatcherForActiveWait(
  state: SessionKernelLoopStateV2
): (fact: KernelFactProjectionV2) => boolean {
  const wait = state.activeWait;
  if (!wait) return () => false;
  return (fact) =>
    fact.lineage.operationId === wait.operationId
    || (
      'invocationId' in wait
      && Boolean(wait.invocationId)
      && fact.lineage.invocationId === wait.invocationId
    );
}

function compareFactsAscending(
  left: KernelFactProjectionV2,
  right: KernelFactProjectionV2
): number {
  return left.ledgerSequence - right.ledgerSequence
    || left.factId.localeCompare(right.factId);
}

function compareFactsDescending(
  left: KernelFactProjectionV2,
  right: KernelFactProjectionV2
): number {
  return right.ledgerSequence - left.ledgerSequence
    || left.factId.localeCompare(right.factId);
}

function cloneFact(
  fact: KernelFactProjectionV2
): KernelFactProjectionV2 {
  return JSON.parse(JSON.stringify(fact)) as KernelFactProjectionV2;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
