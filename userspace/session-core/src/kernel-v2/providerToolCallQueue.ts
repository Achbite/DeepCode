import type {
  KernelFactProjectionV2,
  ToolIntentSubmitReplyV2,
  ToolIntentV2,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  SESSION_KERNEL_FACT_KINDS_V2,
  SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2,
} from './factKinds.js';
import type { SessionKernelLoopStateV2 } from './state.js';
import {
  SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA,
  type SessionProviderResultMetadataV2,
  type SessionProviderToolCallReceiptV2,
  type SessionProviderTurnTargetV2,
} from './types.js';

const MAX_PROVIDER_TOOL_CALLS_PER_TURN = 32;
const MAX_PROVIDER_TOOL_CALL_QUEUE_BYTES = 4 * 1024 * 1024;

export type SessionProviderToolCallQueueItemStatusV2 =
  | 'pending'
  | 'submitting'
  | 'awaitingCapability'
  | 'awaitingInvocation'
  | 'completed'
  | 'aborted'
  | 'unexecuted';

export interface SessionProviderToolCallQueueItemV2 {
  ordinal: number;
  intent: ToolIntentV2;
  status: SessionProviderToolCallQueueItemStatusV2;
  requestId?: string;
  requestStartedAt?: string;
  invocationId?: string;
  terminalFactId?: string;
  terminalFactKind?: string;
  settlementReason?: string;
}

export interface SessionProviderToolCallQueueV2 {
  providerTurnId: string;
  controlEpoch: number;
  target: SessionProviderTurnTargetV2;
  receipt: SessionProviderToolCallReceiptV2;
  providerResult: SessionProviderResultMetadataV2;
  calls: SessionProviderToolCallQueueItemV2[];
  status: 'active' | 'completed' | 'aborted';
  outcomeRecorded: boolean;
  settledAt?: string;
  abortReason?: string;
}

export interface SessionProviderToolCallQueueReconcileResultV2 {
  changed: boolean;
  settlement?: 'completed' | 'aborted';
}

export function createSessionProviderToolCallQueueV2(input: {
  providerTurnId: string;
  controlEpoch: number;
  target: SessionProviderTurnTargetV2;
  receipt: SessionProviderToolCallReceiptV2;
  providerResult: SessionProviderResultMetadataV2;
  intents: ToolIntentV2[];
}): SessionProviderToolCallQueueV2 {
  const queue: SessionProviderToolCallQueueV2 = {
    providerTurnId: input.providerTurnId,
    controlEpoch: input.controlEpoch,
    target: cloneJson(input.target),
    receipt: cloneJson(input.receipt),
    providerResult: cloneJson(input.providerResult),
    calls: input.intents.map((intent, index) => ({
      ordinal: index + 1,
      intent: cloneJson(intent),
      status: 'pending',
    })),
    status: 'active',
    outcomeRecorded: false,
  };
  validateSessionProviderToolCallQueueV2(queue, {
    runId: input.intents[0]?.runId,
    controlEpoch: input.controlEpoch,
  });
  return queue;
}

export function validateSessionProviderToolCallQueueV2(
  queue: SessionProviderToolCallQueueV2,
  expected: {
    runId?: string;
    controlEpoch: number;
  }
): void {
  if (
    !queue
    || typeof queue !== 'object'
    || Array.isArray(queue)
    || queue.receipt.schemaVersion
      !== SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA
    || queue.providerTurnId !== queue.receipt.providerTurnId
    || queue.controlEpoch > expected.controlEpoch
    || (
      queue.status === 'active'
      && queue.controlEpoch !== expected.controlEpoch
    )
    || !Number.isSafeInteger(queue.controlEpoch)
    || queue.controlEpoch <= 0
    || !Array.isArray(queue.calls)
    || queue.calls.length === 0
    || queue.calls.length > MAX_PROVIDER_TOOL_CALLS_PER_TURN
    || queue.receipt.callCount !== queue.calls.length
    || queue.receipt.calls.length !== queue.calls.length
    || (
      queue.status !== 'active'
      && queue.status !== 'completed'
      && queue.status !== 'aborted'
    )
    || typeof queue.outcomeRecorded !== 'boolean'
  ) {
    throw invalidQueue();
  }
  requiredIdentity(queue.providerTurnId, 'providerTurnId');
  requiredDigest(queue.receipt.responseDigest, 'responseDigest');
  requiredInstant(queue.receipt.recordedAt, 'receipt.recordedAt');
  if (queue.target.kind === 'planAction') {
    requiredIdentity(queue.target.planActionId, 'target.planActionId');
  } else if (queue.target.kind === 'contextRead') {
    requiredIdentity(queue.target.operationId, 'target.operationId');
    requiredIdentity(queue.target.idempotencyKey, 'target.idempotencyKey');
    if (
      !queue.target.purpose.trim()
      || new TextEncoder().encode(queue.target.purpose).byteLength > 1_024
    ) {
      throw invalidQueue();
    }
  } else if (queue.target.kind !== 'planning') {
    throw invalidQueue();
  }
  const callIds = new Set<string>();
  const operationIds = new Set<string>();
  const requestIds = new Set<string>();
  let firstUnsettled = -1;
  let planRevision: string | undefined;
  for (let index = 0; index < queue.calls.length; index += 1) {
    const item = queue.calls[index]!;
    const receipt = queue.receipt.calls[index]!;
    const authority = item.intent.authority;
    const targetAuthorityInvalid =
      queue.target.kind === 'planAction'
        ? authority.kind !== 'planAction'
          || authority.data.planActionId !== queue.target.planActionId
          || (
            planRevision !== undefined
            && authority.data.planRevision !== planRevision
          )
        : authority.kind !== 'contextRead'
          || (
            queue.target.kind === 'contextRead'
            && authority.data.purpose !== queue.target.purpose
          );
    if (
      queue.target.kind === 'planAction'
      && authority.kind === 'planAction'
      && planRevision === undefined
    ) {
      planRevision = authority.data.planRevision;
    }
    const carriesRequest =
      item.requestId !== undefined
      && item.requestStartedAt !== undefined;
    const terminalIdentityComplete =
      item.terminalFactId !== undefined
      && item.terminalFactKind !== undefined;
    const terminalIdentityPartial =
      (item.terminalFactId === undefined)
        !== (item.terminalFactKind === undefined);
    if (
      item.ordinal !== index + 1
      || receipt.ordinal !== item.ordinal
      || receipt.toolId !== item.intent.toolId
      || receipt.argumentsDigest
        !== sha256Hash(canonicalJson(item.intent.rawArguments))
      || item.intent.expectedControlEpoch !== queue.controlEpoch
      || (expected.runId !== undefined && item.intent.runId !== expected.runId)
      || targetAuthorityInvalid
      || ![
        'pending',
        'submitting',
        'awaitingCapability',
        'awaitingInvocation',
        'completed',
        'aborted',
        'unexecuted',
      ].includes(item.status)
    ) {
      throw invalidQueue();
    }
    requiredIdentity(receipt.callId, 'receipt.callId');
    requiredIdentity(receipt.toolName, 'receipt.toolName');
    requiredIdentity(receipt.toolId, 'receipt.toolId');
    requiredDigest(receipt.argumentsDigest, 'receipt.argumentsDigest');
    requiredIdentity(item.intent.operationId, 'intent.operationId');
    if (operationIds.has(item.intent.operationId)) throw invalidQueue();
    operationIds.add(item.intent.operationId);
    if ((item.requestId === undefined) !== (item.requestStartedAt === undefined)) {
      throw invalidQueue();
    }
    if (item.requestId) {
      requiredIdentity(item.requestId, 'requestId');
      if (requestIds.has(item.requestId)) throw invalidQueue();
      requestIds.add(item.requestId);
    }
    if (item.requestStartedAt) {
      requiredInstant(item.requestStartedAt, 'requestStartedAt');
    }
    if (item.invocationId) {
      requiredIdentity(item.invocationId, 'invocationId');
    }
    if (item.terminalFactId) {
      requiredIdentity(item.terminalFactId, 'terminalFactId');
    }
    if (item.terminalFactKind) {
      requiredIdentity(item.terminalFactKind, 'terminalFactKind');
    }
    if (item.settlementReason) {
      requiredIdentity(item.settlementReason, 'settlementReason');
    }
    if (
      item.status === 'pending'
      && (
        carriesRequest
        || item.invocationId !== undefined
        || item.terminalFactId !== undefined
        || item.terminalFactKind !== undefined
        || item.settlementReason !== undefined
      )
    ) {
      throw invalidQueue();
    }
    if (
      (
        item.status === 'submitting'
        || item.status === 'awaitingCapability'
        || item.status === 'awaitingInvocation'
        || item.status === 'completed'
        || item.status === 'aborted'
      )
      && !carriesRequest
    ) {
      throw invalidQueue();
    }
    if (
      (
        item.status === 'awaitingCapability'
        || item.status === 'awaitingInvocation'
        || item.status === 'completed'
      )
      && item.invocationId === undefined
    ) {
      throw invalidQueue();
    }
    if (
      (
        item.status === 'submitting'
        || item.status === 'unexecuted'
      )
      && item.invocationId !== undefined
    ) {
      throw invalidQueue();
    }
    if (
      item.status === 'unexecuted'
      && carriesRequest
    ) {
      throw invalidQueue();
    }
    if (
      terminalIdentityPartial
      || (
        item.status === 'completed'
        && !terminalIdentityComplete
      )
      || (
        terminalIdentityComplete
        && !SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2.has(
          item.terminalFactKind!
        )
      )
      || (
        item.status === 'completed'
        && item.terminalFactKind
          !== SESSION_KERNEL_FACT_KINDS_V2.invocation.completed
      )
      || (
        item.status === 'aborted'
        && terminalIdentityComplete
        && item.terminalFactKind
          === SESSION_KERNEL_FACT_KINDS_V2.invocation.completed
      )
      || (
        item.status !== 'completed'
        && item.status !== 'aborted'
        && terminalIdentityComplete
      )
      || (
        (item.status === 'aborted' || item.status === 'unexecuted')
          !== (item.settlementReason !== undefined)
      )
    ) {
      throw invalidQueue();
    }
    if (callIds.has(receipt.callId)) throw invalidQueue();
    callIds.add(receipt.callId);
    if (item.status !== 'completed' && firstUnsettled < 0) {
      firstUnsettled = index;
    }
    if (
      item.status === 'completed'
      && firstUnsettled >= 0
    ) {
      throw invalidQueue();
    }
  }
  if (
    (queue.status === 'completed'
      && queue.calls.some((item) => item.status !== 'completed'))
    || (
      queue.status === 'active'
      && (
        firstUnsettled < 0
        || ![
          'pending',
          'submitting',
          'awaitingCapability',
          'awaitingInvocation',
        ].includes(queue.calls[firstUnsettled]!.status)
        || queue.calls.some(
          (item, index) =>
            index > firstUnsettled
            && item.status !== 'pending'
        )
        || queue.calls.filter(
          (item) =>
            item.status === 'submitting'
            || item.status === 'awaitingCapability'
            || item.status === 'awaitingInvocation'
        ).length > 1
      )
    )
    || (
      queue.status === 'aborted'
      && (
        queue.calls.every((item) => item.status === 'completed')
        || queue.calls.some((item) =>
          item.status === 'pending'
          || item.status === 'submitting'
          || item.status === 'awaitingCapability'
          || item.status === 'awaitingInvocation'
        )
      )
    )
    || (queue.status === 'active' && queue.outcomeRecorded)
    || (
      queue.status === 'active'
      && (queue.settledAt !== undefined || queue.abortReason !== undefined)
    )
    || (
      queue.status === 'completed'
      && (queue.settledAt === undefined || queue.abortReason !== undefined)
    )
    || (
      queue.status === 'aborted'
      && (queue.settledAt === undefined || queue.abortReason === undefined)
    )
    || jsonByteLength(queue) > MAX_PROVIDER_TOOL_CALL_QUEUE_BYTES
  ) {
    throw invalidQueue();
  }
  if (queue.settledAt) requiredInstant(queue.settledAt, 'settledAt');
  if (queue.abortReason) requiredIdentity(queue.abortReason, 'abortReason');
}

export function activeSessionProviderToolCallQueueV2(
  state: SessionKernelLoopStateV2
): SessionProviderToolCallQueueV2 | undefined {
  return state.providerToolCallQueue?.status === 'active'
    ? state.providerToolCallQueue
    : undefined;
}

export function markSessionProviderToolCallSubmittedV2(
  state: SessionKernelLoopStateV2,
  input: {
    requestId: string;
    reply: ToolIntentSubmitReplyV2;
  },
  recordedAt: string
): boolean {
  const queue = activeSessionProviderToolCallQueueV2(state);
  if (!queue) return false;
  const item = queue.calls.find(
    (candidate) => candidate.status === 'submitting'
  );
  if (!item || item.requestId !== input.requestId) throw invalidQueue();
  if (input.reply.data.operationId !== item.intent.operationId) {
    throw invalidQueue();
  }
  switch (input.reply.kind) {
    case 'admitted':
      item.status = 'awaitingInvocation';
      item.invocationId = input.reply.data.invocationId;
      return true;
    case 'awaitingCapability':
      item.status = 'awaitingCapability';
      item.invocationId = input.reply.data.invocationId;
      return true;
    case 'rejected':
      abortSessionProviderToolCallQueueV2(
        state,
        input.reply.data.reason === 'runBusy'
          || input.reply.data.reason === 'capacityExceeded'
          ? 'backpressure'
          : input.reply.data.reason === 'indeterminateRecoveryRequired'
            ? 'indeterminate'
            : 'kernelRejected',
        recordedAt,
        item.intent.operationId
      );
      return true;
    default:
      throw invalidQueue();
  }
}

export function prepareSessionProviderToolCallSubmissionV2(
  state: SessionKernelLoopStateV2,
  input: {
    operationId: string;
    requestId: string;
    requestStartedAt: string;
  }
): void {
  const queue = activeSessionProviderToolCallQueueV2(state);
  const item = queue?.calls.find((candidate) =>
    candidate.status !== 'completed'
  );
  if (
    !queue
    || !item
    || item.status !== 'pending'
    || item.intent.operationId !== input.operationId
  ) {
    throw invalidQueue();
  }
  requiredIdentity(input.requestId, 'requestId');
  requiredInstant(input.requestStartedAt, 'requestStartedAt');
  if (queue.calls.some((candidate) =>
    candidate.requestId === input.requestId
  )) {
    throw invalidQueue();
  }
  item.status = 'submitting';
  item.requestId = input.requestId;
  item.requestStartedAt = input.requestStartedAt;
  try {
    validateSessionProviderToolCallQueueV2(queue, {
      runId: item.intent.runId,
      controlEpoch: state.controlEpoch,
    });
  } catch (error) {
    item.status = 'pending';
    delete item.requestId;
    delete item.requestStartedAt;
    throw error;
  }
}

export function reconcileSessionProviderToolCallQueueV2(
  state: SessionKernelLoopStateV2,
  recordedAt: string,
  observedFacts: readonly KernelFactProjectionV2[] = []
): SessionProviderToolCallQueueReconcileResultV2 {
  const queue = activeSessionProviderToolCallQueueV2(state);
  if (!queue) return { changed: false };
  if (queue.controlEpoch !== state.controlEpoch) {
    abortSessionProviderToolCallQueueV2(
      state,
      'controlEpochSuperseded',
      recordedAt
    );
    return { changed: true, settlement: 'aborted' };
  }
  const item = queue.calls.find((candidate) =>
    candidate.status !== 'completed'
  );
  if (!item) {
    completeQueue(state, queue, recordedAt);
    return { changed: true, settlement: 'completed' };
  }
  const wait = state.activeWait;
  if (
    wait?.operationId === item.intent.operationId
    && wait.kind === 'manualRecovery'
  ) {
    abortSessionProviderToolCallQueueV2(
      state,
      'indeterminate',
      recordedAt,
      item.intent.operationId
    );
    return { changed: true, settlement: 'aborted' };
  }
  if (
    wait?.operationId === item.intent.operationId
    && (
      wait.kind === 'capability'
      || wait.kind === 'invocation'
    )
  ) {
    const nextStatus = wait.kind === 'capability'
      ? 'awaitingCapability'
      : 'awaitingInvocation';
    const changed = item.status !== nextStatus
      || item.invocationId !== wait.invocationId;
    item.status = nextStatus;
    item.invocationId = wait.invocationId;
    return { changed };
  }
  const related = mergedOrderedFacts(state, observedFacts).filter((fact) =>
    fact.lineage.operationId === item.intent.operationId
    || (
      item.invocationId !== undefined
      && fact.lineage.invocationId === item.invocationId
    )
  );
  const terminal = related.findLast((fact) =>
    fact.domain === 'invocation'
    && SESSION_KERNEL_INVOCATION_TERMINAL_FACT_KINDS_V2.has(
      fact.factKind
    )
  );
  if (terminal) {
    const terminalInvocationId = terminal.lineage.invocationId;
    if (
      terminal.lineage.operationId !== item.intent.operationId
      || !terminalInvocationId
      || (
        item.invocationId !== undefined
        && item.invocationId !== terminalInvocationId
      )
    ) {
      throw invalidQueue();
    }
    item.invocationId = terminalInvocationId;
    item.terminalFactId = terminal.factId;
    item.terminalFactKind = terminal.factKind;
    if (
      terminal.factKind
        === SESSION_KERNEL_FACT_KINDS_V2.invocation.completed
    ) {
      item.status = 'completed';
      if (queue.calls.every((candidate) => candidate.status === 'completed')) {
        completeQueue(state, queue, recordedAt);
        return { changed: true, settlement: 'completed' };
      }
      return { changed: true };
    }
    const reason = terminalReason(terminal);
    abortSessionProviderToolCallQueueV2(
      state,
      reason,
      recordedAt,
      item.intent.operationId,
      terminal
    );
    return { changed: true, settlement: 'aborted' };
  }
  const denied = related.findLast((fact) =>
    fact.domain === 'authorization'
    && (
      fact.factKind
        === SESSION_KERNEL_FACT_KINDS_V2.authorization.capabilityDenied
      || fact.factKind
        === SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionDenied
    )
  );
  if (denied && !wait) {
    abortSessionProviderToolCallQueueV2(
      state,
      'capabilityDenied',
      recordedAt,
      item.intent.operationId,
      denied
    );
    return { changed: true, settlement: 'aborted' };
  }
  return { changed: false };
}

export function abortSessionProviderToolCallQueueV2(
  state: SessionKernelLoopStateV2,
  reason: string,
  recordedAt: string,
  currentOperationId?: string,
  terminalFact?: KernelFactProjectionV2
): boolean {
  const queue = activeSessionProviderToolCallQueueV2(state);
  if (!queue) return false;
  requiredIdentity(reason, 'abortReason');
  requiredInstant(recordedAt, 'recordedAt');
  const inferredCurrentOperationId = currentOperationId
    ?? queue.calls.find((item) =>
      item.status === 'submitting'
      || item.status === 'awaitingCapability'
      || item.status === 'awaitingInvocation'
    )?.intent.operationId;
  if (
    currentOperationId
    && !queue.calls.some((item) =>
      item.status !== 'completed'
      && item.intent.operationId === currentOperationId
    )
  ) {
    throw invalidQueue();
  }
  for (const item of queue.calls) {
    if (item.status === 'completed') continue;
    if (
      inferredCurrentOperationId
      && item.intent.operationId === inferredCurrentOperationId
    ) {
      item.status = 'aborted';
      item.settlementReason = reason;
      if (terminalFact) {
        item.terminalFactId = terminalFact.factId;
        item.terminalFactKind = terminalFact.factKind;
      }
    } else {
      item.status = 'unexecuted';
      item.settlementReason = reason;
    }
  }
  queue.status = 'aborted';
  queue.abortReason = reason;
  queue.settledAt = recordedAt;
  const turn = state.providerTurn;
  if (turn?.providerTurnId === queue.providerTurnId) {
    turn.status = reason === 'userInput' || reason === 'runCancelled'
      ? 'cancelled'
      : 'aborted';
    if (reason === 'userInput') turn.cancellationReason = 'userInput';
    if (reason === 'runCancelled') {
      turn.cancellationReason = 'runCancelled';
    }
  }
  return true;
}

export function markSessionProviderToolCallQueueOutcomeRecordedV2(
  state: SessionKernelLoopStateV2
): void {
  const queue = state.providerToolCallQueue;
  if (!queue || queue.status === 'active') throw invalidQueue();
  queue.outcomeRecorded = true;
}

function completeQueue(
  state: SessionKernelLoopStateV2,
  queue: SessionProviderToolCallQueueV2,
  recordedAt: string
): void {
  queue.status = 'completed';
  queue.settledAt = recordedAt;
  const turn = state.providerTurn;
  if (turn?.providerTurnId === queue.providerTurnId) {
    turn.status = 'completed';
  }
}

function terminalReason(fact: KernelFactProjectionV2): string {
  switch (fact.factKind) {
    case SESSION_KERNEL_FACT_KINDS_V2.invocation.failedBeforeEffect:
      return 'toolFailedBeforeEffect';
    case SESSION_KERNEL_FACT_KINDS_V2.invocation.cancelledBeforeEffect:
      return 'toolCancelledBeforeEffect';
    case SESSION_KERNEL_FACT_KINDS_V2.invocation.timedOutBeforeEffect:
      return 'toolTimedOutBeforeEffect';
    case SESSION_KERNEL_FACT_KINDS_V2.invocation.failedAfterObservedEffect:
      return 'toolFailedAfterObservedEffect';
    case SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate:
      return 'indeterminate';
    default:
      return 'toolTerminalFailure';
  }
}

function mergedOrderedFacts(
  state: SessionKernelLoopStateV2,
  observedFacts: readonly KernelFactProjectionV2[]
): KernelFactProjectionV2[] {
  const factsById = new Map<string, KernelFactProjectionV2>();
  for (const fact of Object.values(state.factsById)) {
    factsById.set(fact.factId, fact);
  }
  for (const fact of observedFacts) {
    factsById.set(fact.factId, fact);
  }
  return [...factsById.values()].sort(
    (left, right) =>
      left.ledgerSequence - right.ledgerSequence
      || left.factId.localeCompare(right.factId)
  );
}

function requiredIdentity(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 64 * 1024
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new SessionProviderToolCallQueueError(
      'session_provider_tool_call_queue_identity_invalid',
      `${field} is invalid.`
    );
  }
  return value;
}

function requiredDigest(value: unknown, field: string): string {
  const digest = requiredIdentity(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw invalidQueue();
  return digest;
}

function requiredInstant(value: unknown, field: string): string {
  const instant = requiredIdentity(value, field);
  if (
    !Number.isFinite(Date.parse(instant))
    || new Date(Date.parse(instant)).toISOString() !== instant
  ) {
    throw invalidQueue();
  }
  return instant;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function invalidQueue(): SessionProviderToolCallQueueError {
  return new SessionProviderToolCallQueueError(
    'session_provider_tool_call_queue_invalid',
    'Session Provider tool-call queue is invalid.'
  );
}

export class SessionProviderToolCallQueueError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionProviderToolCallQueueError';
  }
}
