import type { KernelFactProjectionV2 } from '@deepcode/protocol';
import {
  resetSessionKernelFactProjectionV2,
  type SessionKernelLoopStateV2,
} from './state.js';
import type {
  SessionKernelFactBarrierV2,
} from './types.js';

export interface RegisterSessionKernelFactBarrierV2 {
  requestId: string;
  source: SessionKernelFactBarrierV2['source'];
  minimumHighWater: number;
  requiredFactIds: string[];
}

/**
 * Binds a public command reply to the exact canonical facts it promises.
 * If Session already advanced beyond the promised high-water without retaining
 * those identities, its replayable projection is rebuilt from Kernel sequence
 * zero rather than treating the reply as execution truth.
 */
export function registerSessionKernelFactBarrierV2(
  state: SessionKernelLoopStateV2,
  input: RegisterSessionKernelFactBarrierV2
): void {
  const requestId = identity(input.requestId, 'requestId');
  if (
    !Number.isSafeInteger(input.minimumHighWater)
    || input.minimumHighWater <= 0
  ) {
    throw new SessionKernelFactBarrierError(
      'session_kernel_fact_barrier_high_water_invalid',
      'Kernel fact barrier high-water must be a positive safe integer.'
    );
  }
  const requiredFactIds = uniqueIdentities(
    input.requiredFactIds,
    'requiredFactId'
  );
  if (requiredFactIds.length === 0) {
    throw new SessionKernelFactBarrierError(
      'session_kernel_fact_barrier_empty',
      'Kernel fact barrier requires at least one exact fact identity.'
    );
  }
  const existing = state.factBarriers[requestId];
  if (
    existing
    && (
      existing.source !== input.source
      || existing.minimumHighWater !== input.minimumHighWater
      || JSON.stringify(existing.requiredFactIds)
        !== JSON.stringify(requiredFactIds)
    )
  ) {
    throw new SessionKernelFactBarrierError(
      'session_kernel_fact_barrier_identity_conflict',
      `Kernel request ${requestId} changed its durable fact barrier.`
    );
  }

  let observed = new Set(existing?.observedFactIds ?? []);
  for (const factId of requiredFactIds) {
    const fact = state.factsById[factId];
    if (!fact) continue;
    assertFactWithinBarrier(fact, input.minimumHighWater);
    observed.add(factId);
  }
  if (
    state.lineage.cursor.afterLedgerSequence
      >= input.minimumHighWater
    && observed.size !== requiredFactIds.length
  ) {
    resetSessionKernelFactProjectionV2(state);
    observed = new Set<string>();
  }

  state.factBarriers[requestId] = {
    requestId,
    source: input.source,
    minimumHighWater: input.minimumHighWater,
    requiredFactIds,
    observedFactIds: [...observed],
  };
  settleSatisfiedBarrier(state, requestId);
  if (state.factBarriers[requestId]) {
    state.kernelWakeHint = true;
  }
}

export function reconcileSessionKernelFactBarriersV2(
  state: SessionKernelLoopStateV2,
  facts: readonly KernelFactProjectionV2[]
): void {
  for (const [requestId, barrier] of Object.entries(
    state.factBarriers
  )) {
    const observed = new Set(barrier.observedFactIds);
    const required = new Set(barrier.requiredFactIds);
    for (const fact of facts) {
      if (!required.has(fact.factId)) continue;
      assertFactWithinBarrier(fact, barrier.minimumHighWater);
      observed.add(fact.factId);
    }
    barrier.observedFactIds = [...observed];
    settleSatisfiedBarrier(state, requestId);
    const pending = state.factBarriers[requestId];
    if (
      pending
      && state.lineage.cursor.afterLedgerSequence
        >= pending.minimumHighWater
    ) {
      throw new SessionKernelFactBarrierError(
        'session_kernel_fact_barrier_evidence_missing',
        `Kernel facts reached ${pending.minimumHighWater} without the exact facts promised by request ${requestId}.`
      );
    }
  }
  if (sessionKernelFactBarriersPendingV2(state)) {
    state.kernelWakeHint = true;
  }
}

export function sessionKernelFactBarriersPendingV2(
  state: SessionKernelLoopStateV2
): boolean {
  return Object.keys(state.factBarriers).length > 0;
}

function settleSatisfiedBarrier(
  state: SessionKernelLoopStateV2,
  requestId: string
): void {
  const barrier = state.factBarriers[requestId];
  if (
    !barrier
    || state.lineage.cursor.afterLedgerSequence
      < barrier.minimumHighWater
  ) {
    return;
  }
  const observed = new Set(barrier.observedFactIds);
  if (
    barrier.requiredFactIds.every((factId) =>
      observed.has(factId)
    )
  ) {
    delete state.factBarriers[requestId];
  }
}

function assertFactWithinBarrier(
  fact: KernelFactProjectionV2,
  minimumHighWater: number
): void {
  if (fact.ledgerSequence > minimumHighWater) {
    throw new SessionKernelFactBarrierError(
      'session_kernel_fact_barrier_sequence_conflict',
      `Kernel fact ${fact.factId} appears after its promised reply high-water.`
    );
  }
}

function uniqueIdentities(
  values: string[],
  field: string
): string[] {
  const unique = new Set(
    values.map((value) => identity(value, field))
  );
  if (unique.size !== values.length) {
    throw new SessionKernelFactBarrierError(
      'session_kernel_fact_barrier_identity_duplicate',
      'Kernel fact barrier identities must be unique.'
    );
  }
  return [...unique];
}

function identity(value: string, field: string): string {
  if (!value?.trim()) {
    throw new SessionKernelFactBarrierError(
      'session_kernel_fact_barrier_identity_invalid',
      `${field} must not be empty.`
    );
  }
  return value;
}

export class SessionKernelFactBarrierError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelFactBarrierError';
  }
}
