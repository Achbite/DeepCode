import type {
  KernelFactProjectionV2,
  ToolIntentRejectionReasonV2,
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
  type SessionProviderCompletionReceiptV1,
  type SessionProviderOutcomeRecordV2,
  type SessionProviderOrderedItemV2,
  type SessionProviderResultMetadataV2,
  type SessionProviderSettledToolCallV2,
  type SessionProviderToolRejectionV2,
  type SessionProviderToolCallReceiptV2,
  type SessionToolCorrectionV2,
  type SessionProviderTurnTargetV2,
} from './types.js';

const MAX_PROVIDER_TOOL_CALLS_PER_TURN = 32;
const MAX_PROVIDER_TOOL_CALL_QUEUE_BYTES = 4 * 1024 * 1024;

export function isExactSessionProviderOutcomeRecordV2(
  value: unknown,
  expectedProfileId: string
): value is SessionProviderOutcomeRecordV2 {
  try {
    validateExactSessionProviderOutcomeRecordV2(
      value,
      expectedProfileId
    );
    return true;
  } catch {
    return false;
  }
}

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
  rejection?: SessionProviderToolRejectionV2;
  correction?: SessionToolCorrectionV2;
}

export interface SessionProviderToolCallQueueV2 {
  providerTurnId: string;
  controlEpoch: number;
  target: SessionProviderTurnTargetV2;
  receipt: SessionProviderToolCallReceiptV2;
  providerResult: SessionProviderResultMetadataV2;
  orderedItems: SessionProviderOrderedItemV2[];
  completion: SessionProviderCompletionReceiptV1;
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

/**
 * Produces the public, execution-free view of the Provider response. Raw tool
 * arguments stay in the private queue/trace; the shared projection receives
 * only validated tool identity and ordered prose.
 */
export function publicSessionProviderOrderedItemsV2(
  items: readonly SessionProviderOrderedItemV2[]
): Array<Record<string, unknown>> {
  return items.map((item) =>
    item.kind === 'text'
      ? {
          kind: 'text',
          phase: item.phase,
          text: item.text,
        }
      : {
          kind: 'toolCall',
          ordinal: item.ordinal,
          callId: item.callId,
          toolName: item.toolName,
          toolId: item.toolId,
        }
  );
}

/**
 * Extends the safe ordered response with durable Session/Kernel identities so
 * a reducer can settle each existing operation in place. This deliberately
 * carries neither raw nor canonical arguments.
 */
export function publicSessionProviderToolCallQueueItemsV2(
  queue: SessionProviderToolCallQueueV2,
  mode: 'response' | 'settlement' = 'settlement'
): Array<Record<string, unknown>> {
  validateSessionProviderToolCallQueueV2(queue, {
    runId: queue.calls[0]?.intent.runId,
    controlEpoch: queue.controlEpoch,
  });
  return queue.orderedItems.map((item) => {
    if (item.kind === 'text') {
      return {
        kind: 'text',
        phase: item.phase,
        text: item.text,
      };
    }
    const call = queue.calls[item.ordinal - 1];
    const receipt = queue.receipt.calls[item.ordinal - 1];
    if (
      !call
      || !receipt
      || receipt.callId !== item.callId
      || receipt.toolId !== item.toolId
      || call.intent.toolId !== item.toolId
    ) {
      throw invalidQueue();
    }
    return {
      kind: 'toolCall',
      ordinal: item.ordinal,
      callId: item.callId,
      toolName: item.toolName,
      toolId: item.toolId,
      operationId: call.intent.operationId,
      ...(call.correction
        ? { retry: cloneJson(call.correction) }
        : {}),
      status: mode === 'response' ? 'pending' : call.status,
      ...(mode === 'settlement' && call.invocationId
        ? { invocationId: call.invocationId }
        : {}),
      ...(mode === 'settlement' && call.terminalFactId
        ? { terminalFactId: call.terminalFactId }
        : {}),
      ...(mode === 'settlement' && call.terminalFactKind
        ? { terminalFactKind: call.terminalFactKind }
        : {}),
      ...(mode === 'settlement' && call.settlementReason
        ? { settlementReason: call.settlementReason }
        : {}),
    };
  });
}

export function createSessionProviderToolCallQueueV2(input: {
  providerTurnId: string;
  controlEpoch: number;
  target: SessionProviderTurnTargetV2;
  receipt: SessionProviderToolCallReceiptV2;
  providerResult: SessionProviderResultMetadataV2;
  orderedItems: SessionProviderOrderedItemV2[];
  completion: SessionProviderCompletionReceiptV1;
  intents: ToolIntentV2[];
  correction?: SessionToolCorrectionV2;
}): SessionProviderToolCallQueueV2 {
  const queue: SessionProviderToolCallQueueV2 = {
    providerTurnId: input.providerTurnId,
    controlEpoch: input.controlEpoch,
    target: cloneJson(input.target),
    receipt: cloneJson(input.receipt),
    providerResult: cloneJson(input.providerResult),
    orderedItems: cloneJson(input.orderedItems),
    completion: cloneJson(input.completion),
    calls: input.intents.map((intent, index) => ({
      ordinal: index + 1,
      intent: cloneJson(intent),
      status: 'pending',
      ...(index === 0 && input.correction
        ? { correction: cloneJson(input.correction) }
        : {}),
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
    || !Array.isArray(queue.orderedItems)
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
  validateQueueOrderedProviderResponseV2(queue);
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
  let correctionCount = 0;
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
    if (item.correction) {
      correctionCount += 1;
      requiredIdentity(
        item.correction.retryGroupId,
        'correction.retryGroupId'
      );
      requiredIdentity(
        item.correction.predecessorOperationId,
        'correction.predecessorOperationId'
      );
      if (
        !Number.isSafeInteger(item.correction.retryOrdinal)
        || item.correction.retryOrdinal < 2
        || item.correction.predecessorOperationId
          === item.intent.operationId
      ) {
        throw invalidQueue();
      }
    }
    if (item.rejection) {
      validateProviderToolRejectionV2(item.rejection);
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
      || (
        item.rejection !== undefined
        && (
          item.status !== 'aborted'
          || item.settlementReason !== 'kernelRejected'
          || item.invocationId !== undefined
          || terminalIdentityComplete
        )
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
    || correctionCount > 1
    || queue.calls.some((item) =>
      item.correction !== undefined
      && operationIds.has(item.correction.predecessorOperationId)
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
      if (
        input.reply.data.reason !== 'runBusy'
        && input.reply.data.reason !== 'capacityExceeded'
        && input.reply.data.reason !== 'indeterminateRecoveryRequired'
      ) {
        item.rejection = {
          reason: input.reply.data.reason,
          guidance: input.reply.data.guidance,
          rejectionFactId: input.reply.data.rejectionFactId,
        };
      }
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

export function sessionToolCorrectionForNextTurnV2(input: {
  queue?: SessionProviderToolCallQueueV2;
  runId: string;
  controlEpoch: number;
  nextTarget: SessionProviderTurnTargetV2;
}): SessionToolCorrectionV2 | undefined {
  const queue = input.queue;
  if (
    !queue
    || queue.status !== 'aborted'
    || !queue.outcomeRecorded
    || queue.abortReason !== 'kernelRejected'
    || queue.controlEpoch !== input.controlEpoch
    || !correctionTargetsMatch(queue.target, input.nextTarget)
  ) {
    return undefined;
  }
  const predecessor = queue.calls.find((call) =>
    call.status === 'aborted' && call.rejection !== undefined
  );
  if (!predecessor) return undefined;
  const existing = predecessor.correction;
  return {
    retryGroupId: existing?.retryGroupId ?? `retry-group-${sha256Hash(
      canonicalJson({
        schemaVersion: 'deepcode.session.tool-retry-group.v1',
        runId: input.runId,
        controlEpoch: input.controlEpoch,
        initialOperationId: predecessor.intent.operationId,
      })
    ).replace(/^sha256:/u, '')}`,
    predecessorOperationId: predecessor.intent.operationId,
    retryOrdinal: (existing?.retryOrdinal ?? 1) + 1,
  };
}

export function settledSessionProviderToolCallsV2(
  queue: SessionProviderToolCallQueueV2
): SessionProviderSettledToolCallV2[] {
  if (queue.status === 'active' || !queue.settledAt) {
    throw invalidQueue();
  }
  validateSessionProviderToolCallQueueV2(queue, {
    runId: queue.calls[0]?.intent.runId,
    controlEpoch: queue.controlEpoch,
  });
  return queue.calls.map((call) => ({
    ordinal: call.ordinal,
    operationId: call.intent.operationId,
    toolId: call.intent.toolId,
    status: call.status as SessionProviderSettledToolCallV2['status'],
    ...(call.invocationId ? { invocationId: call.invocationId } : {}),
    ...(call.terminalFactId
      ? { terminalFactId: call.terminalFactId }
      : {}),
    ...(call.terminalFactKind
      ? { terminalFactKind: call.terminalFactKind }
      : {}),
    ...(call.settlementReason
      ? { settlementReason: call.settlementReason }
      : {}),
    ...(call.rejection
      ? { rejection: cloneJson(call.rejection) }
      : {}),
    ...(call.correction
      ? { correction: cloneJson(call.correction) }
      : {}),
  }));
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
      item.intent.operationId
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

function validateQueueOrderedProviderResponseV2(
  queue: SessionProviderToolCallQueueV2
): void {
  const completion = queue.completion;
  if (
    !completion
    || completion.schemaVersion
      !== 'deepcode.provider-stream-terminal.v1'
    || completion.reasoningPresent !== true
    || completion.trace?.sealed !== true
    || !Number.isSafeInteger(completion.trace.recordCount)
    || completion.trace.recordCount <= 0
    || completion.responseDigest !== queue.receipt.responseDigest
  ) {
    throw invalidQueue();
  }
  requiredDigest(completion.reasoningDigest, 'reasoningDigest');
  requiredDigest(completion.responseDigest, 'responseDigest');
  requiredDigest(completion.trace.sealDigest, 'trace.sealDigest');
  requiredDigest(
    completion.trace.terminalDigest,
    'trace.terminalDigest'
  );
  if (queue.orderedItems.length > 96) throw invalidQueue();
  const orderedCalls: Array<
    Extract<SessionProviderOrderedItemV2, { kind: 'toolCall' }>
  > = [];
  let finalStarted = false;
  for (const item of queue.orderedItems) {
    if (item.kind === 'text') {
      if (
        !item.text.trim()
        || jsonByteLength(item.text) > 1024 * 1024
        || (
          item.phase !== 'commentary'
          && item.phase !== 'final_answer'
          && item.phase !== 'unknown'
        )
        || (finalStarted && item.phase === 'commentary')
      ) {
        throw invalidQueue();
      }
      if (item.phase === 'final_answer') finalStarted = true;
      continue;
    }
    if (
      item.kind !== 'toolCall'
      || finalStarted
      || item.ordinal !== orderedCalls.length + 1
      || item.source !== 'providerNative'
    ) {
      throw invalidQueue();
    }
    requiredIdentity(item.callId, 'orderedItems.callId');
    requiredIdentity(item.toolName, 'orderedItems.toolName');
    requiredIdentity(item.toolId, 'orderedItems.toolId');
    orderedCalls.push(item);
  }
  if (!receiptMatchesSealedProviderItems(queue, orderedCalls)) {
    throw invalidQueue();
  }
  const providerNativeCalls = orderedCalls.length;
  const native = completion.nativeCompletion;
  const expectedReasoningTransport =
    native.providerKind === 'openaiCompatible'
      ? 'openaiPlaintext'
      : native.providerKind === 'anthropic'
        ? 'anthropicPlaintext'
        : native.providerKind === 'ollama'
          ? 'ollamaPlaintext'
          : undefined;
  if (
    completion.reasoningTransport !== expectedReasoningTransport
    || (
      native.providerKind === 'openaiCompatible'
      ? native.terminalSignal !== '[DONE]'
        || native.finishReason
          !== (providerNativeCalls > 0 ? 'tool_calls' : 'stop')
      : native.providerKind === 'anthropic'
        ? native.terminalSignal !== 'message_stop'
        : native.providerKind === 'ollama'
          ? native.terminalSignal !== 'done:true'
          : true
    )
  ) {
    throw invalidQueue();
  }
}

function receiptMatchesSealedProviderItems(
  queue: SessionProviderToolCallQueueV2,
  orderedCalls: Array<
    Extract<SessionProviderOrderedItemV2, { kind: 'toolCall' }>
  >
): boolean {
  return orderedCalls.length === queue.receipt.calls.length
    && orderedCalls.every((call, index) => {
      const receipt = queue.receipt.calls[index];
      return Boolean(receipt)
        && call.ordinal === receipt!.ordinal
        && call.callId === receipt!.callId
        && call.toolName === receipt!.toolName
        && call.toolId === receipt!.toolId
        && sha256Hash(canonicalJson(call.arguments))
          === receipt!.argumentsDigest;
    });
}

function validateExactSessionProviderOutcomeRecordV2(
  value: unknown,
  expectedProfileId: string
): void {
  const record = exactOutcomeObject(
    value,
    [
      'providerTurnId',
      'outputKind',
      'recordedAt',
      'providerResult',
    ],
    ['summary', 'toolCallReceipt', 'toolSettlement', 'toolCalls']
  );
  const providerTurnId = requiredIdentity(
    record.providerTurnId,
    'providerOutcome.providerTurnId'
  );
  const recordedAt = requiredInstant(
    record.recordedAt,
    'providerOutcome.recordedAt'
  );
  if (
    record.summary !== undefined
    && (
      typeof record.summary !== 'string'
      || new TextEncoder().encode(record.summary).byteLength > 8_192
    )
  ) {
    throw invalidQueue();
  }
  const providerResult = exactOutcomeObject(
    record.providerResult,
    ['providerProfileId', 'provider', 'model'],
    ['usage']
  );
  if (
    requiredIdentity(
      providerResult.providerProfileId,
      'providerOutcome.providerProfileId'
    ) !== expectedProfileId
  ) {
    throw invalidQueue();
  }
  requiredIdentity(providerResult.provider, 'providerOutcome.provider');
  requiredIdentity(providerResult.model, 'providerOutcome.model');
  if (
    providerResult.usage !== undefined
    && (
      !providerResult.usage
      || typeof providerResult.usage !== 'object'
      || Array.isArray(providerResult.usage)
      || jsonByteLength(providerResult.usage) > 64 * 1024
    )
  ) {
    throw invalidQueue();
  }

  if (record.outputKind === 'toolIntent') {
    const receipt = exactOutcomeObject(
      record.toolCallReceipt,
      [
        'schemaVersion',
        'providerTurnId',
        'responseDigest',
        'callCount',
        'calls',
        'recordedAt',
      ]
    );
    if (
      receipt.schemaVersion !== SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA
      || receipt.providerTurnId !== providerTurnId
      || !Number.isSafeInteger(receipt.callCount)
      || Number(receipt.callCount) <= 0
      || Number(receipt.callCount) > MAX_PROVIDER_TOOL_CALLS_PER_TURN
      || !Array.isArray(receipt.calls)
      || receipt.calls.length !== receipt.callCount
    ) {
      throw invalidQueue();
    }
    const receiptCalls = receipt.calls as unknown[];
    requiredDigest(
      receipt.responseDigest,
      'providerOutcome.responseDigest'
    );
    requiredInstant(
      receipt.recordedAt,
      'providerOutcome.receipt.recordedAt'
    );
    const callIds = new Set<string>();
    receiptCalls.forEach((candidate, index) => {
      const call = exactOutcomeObject(candidate, [
        'ordinal',
        'callId',
        'toolName',
        'toolId',
        'argumentsDigest',
      ]);
      const callId = requiredIdentity(
        call.callId,
        'providerOutcome.receipt.callId'
      );
      if (
        call.ordinal !== index + 1
        || callIds.has(callId)
      ) {
        throw invalidQueue();
      }
      callIds.add(callId);
      requiredIdentity(
        call.toolName,
        'providerOutcome.receipt.toolName'
      );
      requiredIdentity(
        call.toolId,
        'providerOutcome.receipt.toolId'
      );
      requiredDigest(
        call.argumentsDigest,
        'providerOutcome.receipt.argumentsDigest'
      );
    });
    const settlement = exactOutcomeObject(
      record.toolSettlement,
      ['status', 'settledAt']
    );
    if (
      (
        settlement.status !== 'completed'
        && settlement.status !== 'aborted'
      )
      || requiredInstant(
        settlement.settledAt,
        'providerOutcome.toolSettlement.settledAt'
      ) !== recordedAt
    ) {
      throw invalidQueue();
    }
    if (
      !Array.isArray(record.toolCalls)
      || record.toolCalls.length !== receipt.callCount
    ) {
      throw invalidQueue();
    }
    const operationIds = new Set<string>();
    let correctionCount = 0;
    record.toolCalls.forEach((candidate, index) => {
      const call = exactOutcomeObject(
        candidate,
        ['ordinal', 'operationId', 'toolId', 'status'],
        [
          'invocationId',
          'terminalFactId',
          'terminalFactKind',
          'settlementReason',
          'rejection',
          'correction',
        ]
      );
      const operationId = requiredIdentity(
        call.operationId,
        'providerOutcome.toolCalls.operationId'
      );
      if (
        call.ordinal !== index + 1
        || operationIds.has(operationId)
        || call.toolId !== (receiptCalls[index] as Record<string, unknown>).toolId
        || (
          call.status !== 'completed'
          && call.status !== 'aborted'
          && call.status !== 'unexecuted'
        )
      ) {
        throw invalidQueue();
      }
      operationIds.add(operationId);
      for (const field of [
        'invocationId',
        'terminalFactId',
        'terminalFactKind',
        'settlementReason',
      ] as const) {
        if (call[field] !== undefined) {
          requiredIdentity(
            call[field],
            `providerOutcome.toolCalls.${field}`
          );
        }
      }
      if (call.rejection !== undefined) {
        validateProviderToolRejectionV2(
          call.rejection as SessionProviderToolRejectionV2
        );
      }
      if (call.correction !== undefined) {
        correctionCount += 1;
        validateSessionToolCorrectionV2(
          call.correction as SessionToolCorrectionV2,
          operationId
        );
      }
    });
    if (
      correctionCount > 1
      || record.toolCalls.some((candidate) => {
        const correction = (candidate as Record<string, unknown>)
          .correction as SessionToolCorrectionV2 | undefined;
        return correction !== undefined
          && operationIds.has(correction.predecessorOperationId);
      })
    ) {
      throw invalidQueue();
    }
    return;
  }

  if (
    record.outputKind !== 'plan'
    && record.outputKind !== 'answer'
    && record.outputKind !== 'noTool'
    && record.outputKind !== 'planActionComplete'
  ) {
    throw invalidQueue();
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'toolCallReceipt')
    || Object.prototype.hasOwnProperty.call(record, 'toolSettlement')
    || Object.prototype.hasOwnProperty.call(record, 'toolCalls')
  ) {
    throw invalidQueue();
  }
}

function validateProviderToolRejectionV2(
  value: SessionProviderToolRejectionV2
): void {
  const record = exactOutcomeObject(
    value,
    ['reason', 'guidance', 'rejectionFactId']
  );
  const reasons: readonly ToolIntentRejectionReasonV2[] = [
    'toolNotRegistered',
    'toolUnavailable',
    'invalidArguments',
    'staleToolContext',
    'staleControlEpoch',
    'planActionRequired',
    'capabilityLeaseStale',
    'capabilityScopeMismatch',
    'settingsDenied',
  ];
  if (
    !reasons.includes(record.reason as ToolIntentRejectionReasonV2)
    || typeof record.guidance !== 'string'
    || !record.guidance.trim()
    || new TextEncoder().encode(record.guidance).byteLength > 64 * 1024
  ) {
    throw invalidQueue();
  }
  requiredIdentity(
    record.rejectionFactId,
    'rejection.rejectionFactId'
  );
}

function validateSessionToolCorrectionV2(
  value: SessionToolCorrectionV2,
  operationId: string
): void {
  const record = exactOutcomeObject(
    value,
    ['retryGroupId', 'predecessorOperationId', 'retryOrdinal']
  );
  requiredIdentity(record.retryGroupId, 'correction.retryGroupId');
  const predecessorOperationId = requiredIdentity(
    record.predecessorOperationId,
    'correction.predecessorOperationId'
  );
  if (
    predecessorOperationId === operationId
    || !Number.isSafeInteger(record.retryOrdinal)
    || Number(record.retryOrdinal) < 2
  ) {
    throw invalidQueue();
  }
}

function correctionTargetsMatch(
  previous: SessionProviderTurnTargetV2,
  next: SessionProviderTurnTargetV2
): boolean {
  if (previous.kind === 'finalAnswer' || next.kind === 'finalAnswer') {
    return false;
  }
  if (previous.kind === 'planAction' || next.kind === 'planAction') {
    return previous.kind === 'planAction'
      && next.kind === 'planAction'
      && previous.planActionId === next.planActionId;
  }
  return true;
}

function exactOutcomeObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidQueue();
  }
  const record = value as Record<string, unknown>;
  const permitted = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
    || Object.keys(record).some((key) => !permitted.has(key))
  ) {
    throw invalidQueue();
  }
  return record;
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
