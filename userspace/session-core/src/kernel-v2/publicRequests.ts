import type {
  CapabilityScopePreviewReplyV2,
  ControlEpochAdvancedReplyV2,
  InvocationCancelReplyV2,
  KernelFactProjectionPageV2,
  ToolContextGetReplyV2,
  ToolIntentSubmitReplyV2,
} from '@deepcode/protocol';
import {
  clearSessionCapabilityLeasesV2,
  recordSessionToolIntentSubmissionV2,
} from './lineage.js';
import { canonicalJson, sha256Hash } from '../cache/canonicalizer.js';
import type { SessionKernelLoopPortsV2 } from './ports.js';
import {
  reconcileSessionKernelFactsPageV2,
} from './reconcile.js';
import { buildSessionKernelReviewV2 } from './review.js';
import {
  SessionKernelPortError,
  type SessionKernelCapabilityPreviewRequestV2,
  type SessionKernelEpochAdvanceRequestV2,
  type SessionKernelFactsRequestV2,
  type SessionKernelInvocationCancelRequestV2,
  type SessionKernelToolIntentRequestV2,
} from './SessionKernelPortV2.js';
import type { SessionKernelLoopStateV2 } from './state.js';
import {
  checkpointSessionKernelStateV2,
  cloneSessionKernelLoopStateV2,
  createSessionReviewFactAccumulatorV2,
} from './state.js';
import {
  applySessionToolContextReplyV2,
  toolContextRefV2,
} from './toolContext.js';
import type {
  SessionKernelProjectionEventV2,
  SessionKernelPublicRequestIntentV2,
  SessionKernelPublicRequestLaneV2,
  SessionKernelPublicRequestRecordV2,
} from './types.js';
import {
  SESSION_KERNEL_FACT_KINDS_V2,
} from './factKinds.js';

export type SessionKernelPublicRequestOutcomeV2 =
  | { kind: 'toolContextGet'; reply: ToolContextGetReplyV2 }
  | { kind: 'capabilityPreview'; reply: CapabilityScopePreviewReplyV2 }
  | { kind: 'toolIntentSubmit'; reply: ToolIntentSubmitReplyV2 }
  | { kind: 'factsQuery'; reply: KernelFactProjectionPageV2 }
  | { kind: 'controlEpochAdvance'; reply: ControlEpochAdvancedReplyV2 }
  | { kind: 'invocationCancel'; reply: InvocationCancelReplyV2 };

export interface SessionKernelPublicRequestHostV2 {
  readState(): SessionKernelLoopStateV2;

  replaceState(state: SessionKernelLoopStateV2): void;

  saveCheckpoint(): Promise<void>;

  event(
    projectionId: string,
    kind: SessionKernelProjectionEventV2['kind'],
    data: unknown,
    recordedAt?: string
  ): SessionKernelProjectionEventV2;
}

interface SessionKernelTransportAttemptV2 {
  request: SessionKernelPublicRequestRecordV2;
  controller: AbortController;
  phase: 'preparing' | 'transport' | 'applying';
  superseded: boolean;
  preparingSettled: Promise<void>;
  resolvePreparing: () => void;
  transportSuperseded: Promise<void>;
  resolveTransportSuperseded: () => void;
  promise: Promise<SessionKernelPublicRequestOutcomeV2>;
}

/**
 * Durable request coordinator. At most one request is unresolved in each
 * lane, so a user-input control fence can overtake an effect request whose
 * transport outcome is unknown without changing that effect request's
 * identity or payload.
 */
export class SessionKernelPublicRequestsV2 {
  private readonly inFlight = new Map<
    SessionKernelPublicRequestLaneV2,
    SessionKernelTransportAttemptV2
  >();

  constructor(
    private readonly ports: SessionKernelLoopPortsV2,
    private readonly host: SessionKernelPublicRequestHostV2,
    private readonly retryDelayMs: number
  ) {}

  pending(
    lane: SessionKernelPublicRequestLaneV2
  ): SessionKernelPublicRequestRecordV2 | undefined {
    return this.host.readState().publicRequests[lane];
  }

  pendingRecords(): SessionKernelPublicRequestRecordV2[] {
    return Object.values(this.host.readState().publicRequests);
  }

  /**
   * User input supersedes local effect/query transport only. The durable
   * request identity and payload remain pending for an exact replay. Control
   * fences are never aborted or replaced with a new identity.
   */
  supersedeForUserInput(): Promise<void> {
    const barriers = [
      this.supersedeTransportAttempt('effect'),
      this.supersedeTransportAttempt('query'),
    ].filter(
      (barrier): barrier is Promise<void> => Boolean(barrier)
    );
    return Promise.all(barriers).then(() => undefined);
  }

  newRecord(
    intent: SessionKernelPublicRequestIntentV2
  ): SessionKernelPublicRequestRecordV2 {
    return {
      requestId: this.ports.ids.nextRequestId(),
      lane: sessionKernelPublicRequestLaneV2(intent),
      intent,
      startedAt: this.ports.clock.now(),
      attemptCount: 1,
    };
  }

  async replay(
    lane: SessionKernelPublicRequestLaneV2
  ): Promise<SessionKernelPublicRequestOutcomeV2 | undefined> {
    const request = this.pending(lane);
    return request ? this.execute(request) : undefined;
  }

  async execute(
    requested: SessionKernelPublicRequestRecordV2
  ): Promise<SessionKernelPublicRequestOutcomeV2> {
    assertRecordLane(requested);
    const active = this.inFlight.get(requested.lane);
    if (active) {
      if (
        !sameSessionKernelPublicRequestV2(active.request, requested)
      ) {
        throw new SessionKernelPublicRequestError(
          'session_kernel_public_request_lane_busy',
          `Kernel ${requested.lane} lane is executing another request.`
        );
      }
      return active.promise;
    }
    let resolvePreparing: () => void = () => {};
    const preparingSettled = new Promise<void>((resolve) => {
      resolvePreparing = resolve;
    });
    let resolveTransportSuperseded: () => void = () => {};
    const transportSuperseded = new Promise<void>((resolve) => {
      resolveTransportSuperseded = resolve;
    });
    const attempt: SessionKernelTransportAttemptV2 = {
      request: requested,
      controller: new AbortController(),
      phase: 'preparing',
      superseded: false,
      preparingSettled,
      resolvePreparing,
      transportSuperseded,
      resolveTransportSuperseded,
      promise: Promise.resolve(undefined as never),
    };
    attempt.promise = this.executeInLane(requested, attempt);
    this.inFlight.set(requested.lane, attempt);
    try {
      return await attempt.promise;
    } finally {
      const current = this.inFlight.get(requested.lane);
      if (current === attempt) {
        this.inFlight.delete(requested.lane);
      }
    }
  }

  private async executeInLane(
    requested: SessionKernelPublicRequestRecordV2,
    attempt: SessionKernelTransportAttemptV2
  ): Promise<SessionKernelPublicRequestOutcomeV2> {
    let record = requested;
    const existing = this.pending(requested.lane);
    if (existing) {
      if (!sameSessionKernelPublicRequestV2(existing, requested)) {
        throw new SessionKernelPublicRequestError(
          'session_kernel_public_request_lane_busy',
          `Kernel ${requested.lane} lane already has a different persisted request.`
        );
      }
      record = {
        ...existing,
        attemptCount: existing.attemptCount + 1,
      };
    }

    try {
      await this.ports.persistence.persistPublicRequest(record);
      this.host.readState().publicRequests[record.lane] = record;
      await this.host.saveCheckpoint();
    } finally {
      attempt.resolvePreparing();
    }
    if (attempt.superseded) {
      throw new SessionKernelTransportAttemptSupersededError(record);
    }

    let outcome: SessionKernelPublicRequestOutcomeV2;
    attempt.phase = 'transport';
    const dispatched = dispatchPublicRequest(
      this.ports,
      record,
      attempt.controller.signal
    ).then(
      (value) => ({
        kind: 'outcome' as const,
        value,
      }),
      (error: unknown) => ({
        kind: 'error' as const,
        error,
      })
    );
    const transport = await Promise.race([
      dispatched,
      attempt.transportSuperseded.then(() => ({
        kind: 'superseded' as const,
      })),
    ]);
    if (transport.kind === 'superseded') {
      throw new SessionKernelTransportAttemptSupersededError(record);
    }
    if (transport.kind === 'error') {
      const error = transport.error;
      if (attempt.superseded || attempt.controller.signal.aborted) {
        throw new SessionKernelTransportAttemptSupersededError(
          record,
          error
        );
      }
      if (isDeterministicSessionKernelPortFailureV2(error)) {
        attempt.phase = 'applying';
        await this.settleDeterministicFailure(record, error);
        throw error;
      }
      throw new SessionKernelTransportUnknownError(record, error);
    }
    outcome = transport.value;
    if (attempt.superseded) {
      throw new SessionKernelTransportAttemptSupersededError(record);
    }
    attempt.phase = 'applying';

    const previous = cloneSessionKernelLoopStateV2(
      this.host.readState()
    );
    let events: SessionKernelProjectionEventV2[];
    try {
      events = applyPublicRequestOutcome(
        this.host,
        record,
        outcome,
        this.ports.clock.now(),
        this.retryDelayMs
      );
      this.removePending(record);
      const checkpoint = checkpointSessionKernelStateV2(
        this.host.readState(),
        this.ports.clock.now()
      );
      await this.ports.persistence.settlePublicRequest(
        record,
        digestOutcome(outcome),
        checkpoint,
        events
      );
      this.host.readState().checkpointRevision =
        checkpoint.checkpointRevision;
    } catch (error) {
      this.host.replaceState(previous);
      throw error;
    }
    await this.flushProjectionOutbox();
    return outcome;
  }

  private supersedeTransportAttempt(
    lane: 'effect' | 'query'
  ): Promise<void> | undefined {
    const attempt = this.inFlight.get(lane);
    if (!attempt) return undefined;
    if (attempt.phase === 'preparing') {
      attempt.superseded = true;
      attempt.controller.abort('userInput');
      return attempt.preparingSettled.then(() => {
        attempt.resolveTransportSuperseded();
        this.detachSupersededAttempt(lane, attempt);
      });
    }
    if (attempt.phase === 'transport') {
      attempt.superseded = true;
      attempt.controller.abort('userInput');
      attempt.resolveTransportSuperseded();
      this.detachSupersededAttempt(lane, attempt);
      return Promise.resolve();
    }
    return attempt.promise.then(
      () => undefined,
      () => undefined
    );
  }

  private detachSupersededAttempt(
    lane: 'effect' | 'query',
    attempt: SessionKernelTransportAttemptV2
  ): void {
    if (
      attempt.superseded
      && attempt.phase !== 'applying'
      && this.inFlight.get(lane) === attempt
    ) {
      this.inFlight.delete(lane);
    }
  }

  private async settleDeterministicFailure(
    record: SessionKernelPublicRequestRecordV2,
    error: SessionKernelPortError
  ): Promise<void> {
    const previous = cloneSessionKernelLoopStateV2(
      this.host.readState()
    );
    try {
      this.removePending(record);
      const checkpoint = checkpointSessionKernelStateV2(
        this.host.readState(),
        this.ports.clock.now()
      );
      await this.ports.persistence.settlePublicRequest(
        record,
        digestOutcome({
          kind: 'deterministicFailure',
          code: error.code,
          disposition: error.disposition,
        }),
        checkpoint,
        []
      );
      this.host.replaceState(checkpoint.state);
    } catch (settlementError) {
      this.host.replaceState(previous);
      throw settlementError;
    }
  }

  private removePending(
    record: SessionKernelPublicRequestRecordV2
  ): void {
    const current = this.pending(record.lane);
    if (current?.requestId === record.requestId) {
      delete this.host.readState().publicRequests[record.lane];
    }
  }

  private async flushProjectionOutbox(): Promise<void> {
    try {
      await this.ports.projection.flushPending(
        this.host.readState().runId
      );
    } catch {
      // Settlement owns the durable outbox. Recovery retries delivery only;
      // projection transport failure must not redispatch the Kernel request.
    }
  }
}

export function sessionKernelPublicRequestLaneV2(
  intent: SessionKernelPublicRequestIntentV2
): SessionKernelPublicRequestLaneV2 {
  switch (intent.kind) {
    case 'controlEpochAdvance':
    case 'invocationCancel':
      return 'control';
    case 'toolIntentSubmit':
      return 'effect';
    case 'toolContextGet':
    case 'capabilityPreview':
    case 'factsQuery':
      return 'query';
  }
}

export function expectSessionKernelPublicRequestOutcomeV2<
  K extends SessionKernelPublicRequestOutcomeV2['kind'],
>(
  outcome: SessionKernelPublicRequestOutcomeV2,
  kind: K
): Extract<SessionKernelPublicRequestOutcomeV2, { kind: K }> {
  if (outcome.kind !== kind) {
    throw new SessionKernelPublicRequestError(
      'session_kernel_public_outcome_unexpected',
      `Expected ${kind}, received ${outcome.kind}.`
    );
  }
  return outcome as Extract<
    SessionKernelPublicRequestOutcomeV2,
    { kind: K }
  >;
}

export function sameSessionKernelPublicRequestV2(
  left: SessionKernelPublicRequestRecordV2,
  right: SessionKernelPublicRequestRecordV2
): boolean {
  return left.requestId === right.requestId
    && left.lane === right.lane
    && JSON.stringify(left.intent) === JSON.stringify(right.intent);
}

async function dispatchPublicRequest(
  ports: SessionKernelLoopPortsV2,
  record: SessionKernelPublicRequestRecordV2,
  signal: AbortSignal
): Promise<SessionKernelPublicRequestOutcomeV2> {
  const requestId = record.requestId;
  switch (record.intent.kind) {
    case 'toolContextGet':
      return {
        kind: record.intent.kind,
        reply: await ports.kernel.getToolContext({
          requestId,
          signal,
          ...record.intent.payload,
        }),
      };
    case 'capabilityPreview':
      return {
        kind: record.intent.kind,
        reply: await ports.kernel.previewCapability({
          requestId,
          signal,
          ...record.intent.payload,
        } satisfies SessionKernelCapabilityPreviewRequestV2),
      };
    case 'toolIntentSubmit':
      return {
        kind: record.intent.kind,
        reply: await ports.kernel.submitToolIntent({
          requestId,
          signal,
          ...record.intent.payload,
        } satisfies SessionKernelToolIntentRequestV2),
      };
    case 'factsQuery':
      return {
        kind: record.intent.kind,
        reply: await ports.kernel.queryFacts({
          requestId,
          signal,
          ...record.intent.payload,
        } satisfies SessionKernelFactsRequestV2),
      };
    case 'controlEpochAdvance':
      return {
        kind: record.intent.kind,
        reply: await ports.kernel.advanceControlEpoch({
          requestId,
          signal,
          ...record.intent.payload,
        } satisfies SessionKernelEpochAdvanceRequestV2),
      };
    case 'invocationCancel':
      return {
        kind: record.intent.kind,
        reply: await ports.kernel.cancelInvocation({
          requestId,
          signal,
          ...record.intent.payload,
        } satisfies SessionKernelInvocationCancelRequestV2),
      };
  }
}

function applyPublicRequestOutcome(
  host: SessionKernelPublicRequestHostV2,
  record: SessionKernelPublicRequestRecordV2,
  outcome: SessionKernelPublicRequestOutcomeV2,
  now: string,
  retryDelayMs: number
): SessionKernelProjectionEventV2[] {
  if (record.intent.kind !== outcome.kind) {
    throw new SessionKernelPublicRequestError(
      'session_kernel_public_outcome_kind_mismatch',
      'Kernel public request outcome does not match its persisted intent.'
    );
  }
  const state = host.readState();
  const events: SessionKernelProjectionEventV2[] = [];
  switch (outcome.kind) {
    case 'toolContextGet': {
      const previous = state.toolContext;
      const next = applySessionToolContextReplyV2(
        state.toolContext,
        outcome.reply
      );
      if (
        previous.refreshRequired
        || JSON.stringify(toolContextRefV2(previous.bundle))
          !== JSON.stringify(toolContextRefV2(next.bundle))
      ) {
        state.previews = {};
      }
      state.toolContext = next;
      break;
    }
    case 'capabilityPreview':
      if (record.intent.kind !== 'capabilityPreview') {
        throw new SessionKernelPublicRequestError(
          'session_kernel_public_outcome_kind_mismatch',
          'Capability preview outcome lost its persisted request correlation.'
        );
      }
      if (
        outcome.reply.kind === 'previewed'
        && record.intent.payload.expectedControlEpoch
          === state.controlEpoch
      ) {
        state.previews[outcome.reply.data.preview.operationId] =
          outcome.reply.data.preview;
      } else if (
        outcome.reply.kind === 'rejected'
        && record.intent.payload.expectedControlEpoch
          === state.controlEpoch
      ) {
        appendUniqueGuidance(state.pendingGuidance, outcome.reply.data.guidance);
      }
      break;
    case 'toolIntentSubmit':
      applyToolIntentReply(
        host,
        state,
        record,
        outcome.reply,
        now,
        retryDelayMs,
        events
      );
      break;
    case 'factsQuery': {
      const result = reconcileSessionKernelFactsPageV2(state, outcome.reply);
      host.replaceState(result.state);
      if (result.caughtUp) {
        result.state.review = buildSessionKernelReviewV2(result.state, now);
      }
      events.push(host.event(
        `${record.requestId}:facts`,
        'kernelFacts.reconciled',
        {
          requestId: record.requestId,
          pageFactIds: outcome.reply.facts.map((fact) => fact.factId),
          pageFactCount: outcome.reply.facts.length,
          nextAfterLedgerSequence:
            outcome.reply.nextAfterLedgerSequence,
          snapshotHighWater: outcome.reply.snapshotHighWater,
        },
        record.startedAt
      ));
      const authorizationDecisionKinds = new Set<string>([
        SESSION_KERNEL_FACT_KINDS_V2.authorization.capabilityIssued,
        SESSION_KERNEL_FACT_KINDS_V2.authorization.capabilityDenied,
        SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionAllowed,
        SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionDenied,
      ]);
      const newFactIds = new Set(result.newFactIds);
      for (const fact of outcome.reply.facts) {
        if (
          !newFactIds.has(fact.factId)
          || fact.domain !== 'authorization'
          || !authorizationDecisionKinds.has(fact.factKind)
        ) {
          continue;
        }
        events.push(host.event(
          `authorization:${fact.factId}`,
          'authorization.decided',
          {
            factId: fact.factId,
            factKind: fact.factKind,
            controlEpoch: fact.lineage.controlEpoch,
            planActionIds: fact.lineage.planActionIds,
            operationId: fact.lineage.operationId,
            capabilityLease: fact.lineage.capabilityLease,
            resourceIds: fact.lineage.resourceIds,
            guidance: typeof fact.details.guidance === 'string'
              ? fact.details.guidance
              : undefined,
            scopeDelta: fact.details.scopeDelta,
            details: fact.details,
          },
          fact.recordedAt
        ));
      }
      if (result.state.review) {
        events.push(host.event(
          `${record.requestId}:review:${result.state.review.revision}`,
          'review.revised',
          result.state.review,
          record.startedAt
        ));
      }
      events.push(host.event(
        `${record.requestId}:wait`,
        'wait.changed',
        result.state.activeWait,
        record.startedAt
      ));
      break;
    }
    case 'controlEpochAdvance':
      if (record.intent.kind !== 'controlEpochAdvance') {
        throw new SessionKernelPublicRequestError(
          'session_kernel_public_outcome_kind_mismatch',
          'Control epoch outcome lost its persisted request correlation.'
        );
      }
      state.controlEpoch = outcome.reply.acceptedControlEpoch;
      if (
        state.reviewFacts.controlEpoch
          !== outcome.reply.acceptedControlEpoch
      ) {
        state.reviewFacts = createSessionReviewFactAccumulatorV2(
          outcome.reply.acceptedControlEpoch,
          state.reviewFacts.coverageAfterLedgerSequence
        );
      }
      state.previews = {};
      if (
        state.pendingEpochInput?.inputId
          === record.intent.payload.inputId
      ) {
        state.pendingEpochInput = undefined;
      }
      if (state.activeWait?.kind !== 'manualRecovery') {
        state.activeWait = undefined;
      }
      break;
    case 'invocationCancel':
      break;
  }
  return events;
}

function applyToolIntentReply(
  host: SessionKernelPublicRequestHostV2,
  state: SessionKernelLoopStateV2,
  record: SessionKernelPublicRequestRecordV2,
  reply: ToolIntentSubmitReplyV2,
  now: string,
  retryDelayMs: number,
  events: SessionKernelProjectionEventV2[]
): void {
  if (record.intent.kind !== 'toolIntentSubmit') return;
  const intent = record.intent.payload.intent;
  state.lineage = recordSessionToolIntentSubmissionV2(
    state.lineage,
    intent,
    reply
  );
  events.push(host.event(
    `${record.requestId}:intent`,
    'toolIntent.submitted',
    {
      requestId: record.requestId,
      operationId: intent.operationId,
      replyKind: reply.kind,
    },
    record.startedAt
  ));

  const stillCurrentEpoch =
    intent.expectedControlEpoch === state.controlEpoch;
  if (
    reply.kind === 'rejected'
    && reply.data.reason === 'capabilityLeaseStale'
    && intent.authority.kind === 'planAction'
  ) {
    state.lineage = clearSessionCapabilityLeasesV2(
      state.lineage,
      intent.authority.data.planActionId
    );
  }
  if (reply.kind === 'admitted' && stillCurrentEpoch) {
    state.activeWait = {
      kind: 'invocation',
      operationId: reply.data.operationId,
      invocationId: reply.data.invocationId,
      sinceHighWater: reply.data.admissionBatchHighWater,
    };
  } else if (reply.kind === 'awaitingCapability' && stillCurrentEpoch) {
    state.activeWait = {
      kind: 'capability',
      operationId: reply.data.operationId,
      invocationId: reply.data.invocationId,
      previewId: reply.data.preview.previewId,
      sinceHighWater: reply.data.awaitingBatchHighWater,
    };
    events.push(host.event(
      `${record.requestId}:capability`,
      'capability.awaiting',
      {
        operationId: reply.data.operationId,
        invocationId: reply.data.invocationId,
        preview: reply.data.preview,
      },
      record.startedAt
    ));
  } else if (
    reply.kind === 'rejected'
    && (
      reply.data.reason === 'runBusy'
      || reply.data.reason === 'capacityExceeded'
    )
    && stillCurrentEpoch
  ) {
    state.activeWait = {
      kind: 'backpressure',
      operationId: reply.data.operationId,
      reason: reply.data.reason,
      retryAt: addMilliseconds(now, retryDelayMs),
      guidance: reply.data.guidance,
    };
  } else if (
    reply.kind === 'rejected'
    && reply.data.reason === 'indeterminateRecoveryRequired'
  ) {
    const invocationId =
      state.lineage.operations[intent.operationId]
        ?.latestInvocationId;
    state.activeWait = {
      kind: 'manualRecovery',
      operationId: reply.data.operationId,
      ...(invocationId ? { invocationId } : {}),
      reason: 'indeterminate',
      factIds: [reply.data.rejectionFactId],
    };
  } else if (reply.kind === 'rejected' && stillCurrentEpoch) {
    state.activeWait = undefined;
    appendUniqueGuidance(state.pendingGuidance, reply.data.guidance);
  }
  events.push(host.event(
    `${record.requestId}:wait`,
    'wait.changed',
    state.activeWait,
    record.startedAt
  ));
}

function assertRecordLane(record: SessionKernelPublicRequestRecordV2): void {
  if (record.lane !== sessionKernelPublicRequestLaneV2(record.intent)) {
    throw new SessionKernelPublicRequestError(
      'session_kernel_public_request_lane_mismatch',
      'Persisted Kernel request lane does not match its intent kind.'
    );
  }
}

function isDeterministicSessionKernelPortFailureV2(
  error: unknown
): error is SessionKernelPortError {
  return error instanceof SessionKernelPortError
    && error.disposition === 'deterministic';
}

function appendUniqueGuidance(values: string[], guidance: string): void {
  if (guidance.trim() && !values.includes(guidance)) values.push(guidance);
}

function addMilliseconds(instant: string, milliseconds: number): string {
  const value = Date.parse(instant);
  if (!Number.isFinite(value) || milliseconds < 0) {
    throw new SessionKernelPublicRequestError(
      'session_kernel_clock_invalid',
      'Clock returned an invalid instant or retry delay.'
    );
  }
  return new Date(value + milliseconds).toISOString();
}

function digestOutcome(value: unknown): string {
  return sha256Hash(canonicalJson(value));
}

export class SessionKernelTransportUnknownError extends Error {
  readonly code = 'session_kernel_transport_outcome_unknown';

  constructor(
    readonly request: SessionKernelPublicRequestRecordV2,
    readonly cause: unknown
  ) {
    super(
      `Kernel request ${request.requestId} has an unknown transport outcome; replay the same persisted identity and intent.`
    );
    this.name = 'SessionKernelTransportUnknownError';
  }
}

export class SessionKernelTransportAttemptSupersededError extends Error {
  readonly code = 'session_kernel_transport_attempt_superseded';

  constructor(
    readonly request: SessionKernelPublicRequestRecordV2,
    readonly cause?: unknown
  ) {
    super(
      `Local transport for Kernel request ${request.requestId} was superseded; replay the same persisted identity and intent.`
    );
    this.name = 'SessionKernelTransportAttemptSupersededError';
  }
}

export class SessionKernelPublicRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelPublicRequestError';
  }
}
