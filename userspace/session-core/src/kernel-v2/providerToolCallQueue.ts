import type {
  CapabilityScopePreviewBatchReplyV2,
  CapabilityScopePreviewRecordV2,
  CapabilityScopeRejectionReasonV2,
  DeadlineRequestV2,
  KernelFactProjectionV2,
  RawToolArgumentsV2,
  ToolContextRefV2,
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
  type SessionProviderTurnOutputV2,
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
  | 'previewing'
  | 'submitting'
  | 'awaitingCapability'
  | 'awaitingInvocation'
  | 'completed'
  | 'aborted'
  | 'unexecuted';

export interface SessionProviderMutationCandidatePreviewV4 {
  runId: string;
  controlEpoch: number;
  discoveryId: string;
  planRevision: string;
  planActionId: string;
  operationId: string;
  idempotencyKey: string;
  toolId: string;
  rawArguments: RawToolArgumentsV2;
  deadline: DeadlineRequestV2;
  toolContextRef: ToolContextRefV2;
  preview?: CapabilityScopePreviewRecordV2;
  rejection?: {
    reason: CapabilityScopeRejectionReasonV2;
    guidance: string;
  };
  classification?: 'planned' | 'outOfPlan';
}

export interface SessionProviderToolCallQueueItemV2 {
  ordinal: number;
  dispatchKind: 'read' | 'mutation';
  intent?: ToolIntentV2;
  candidatePreview?: SessionProviderMutationCandidatePreviewV4;
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
  mutationDisposition:
    | 'notRequired'
    | 'classifying'
    | 'planned'
    | 'initialPlanDiscovery'
    | 'userIntervention';
  status: 'active' | 'completed' | 'aborted';
  outcomeRecorded: boolean;
  settledAt?: string;
  abortReason?: string;
}

export interface SessionProviderToolCallQueueReconcileResultV2 {
  changed: boolean;
  settlement?: 'completed' | 'aborted';
}

export type SessionProviderToolCallQueueWorkV4 =
  | {
      kind: 'preview';
      item: SessionProviderToolCallQueueItemV2;
      candidate: SessionProviderMutationCandidatePreviewV4;
    }
  | {
      kind: 'intent';
      item: SessionProviderToolCallQueueItemV2;
      intent: ToolIntentV2;
    };

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
    runId: queueRunId(queue),
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
      || queueItemToolId(call) !== item.toolId
    ) {
      throw invalidQueue();
    }
    return {
      kind: 'toolCall',
      ordinal: item.ordinal,
      callId: item.callId,
      toolName: item.toolName,
      toolId: item.toolId,
      operationId: queueItemOperationId(call),
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
      ...(mode === 'settlement' && call.candidatePreview?.preview
        ? { previewId: call.candidatePreview.preview.previewId }
        : {}),
    };
  });
}

export type SessionProviderQueuedCallInputV4 =
  | {
      dispatchKind: 'read';
      intent: ToolIntentV2;
      candidatePreview?: never;
    }
  | {
      dispatchKind: 'mutation';
      intent?: ToolIntentV2;
      candidatePreview: SessionProviderMutationCandidatePreviewV4;
    };

export function createSessionProviderToolCallQueueV2(input: {
  providerTurnId: string;
  controlEpoch: number;
  target: SessionProviderTurnTargetV2;
  receipt: SessionProviderToolCallReceiptV2;
  providerResult: SessionProviderResultMetadataV2;
  orderedItems: SessionProviderOrderedItemV2[];
  completion: SessionProviderCompletionReceiptV1;
  calls: SessionProviderQueuedCallInputV4[];
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
    calls: input.calls.map((call, index) => ({
      ordinal: index + 1,
      dispatchKind: call.dispatchKind,
      ...(call.intent ? { intent: cloneJson(call.intent) } : {}),
      ...(call.candidatePreview
        ? { candidatePreview: cloneJson(call.candidatePreview) }
        : {}),
      status: 'pending',
      ...(index === 0 && input.correction
        ? { correction: cloneJson(input.correction) }
        : {}),
    })),
    mutationDisposition: input.calls.some(
      (call) => call.dispatchKind === 'mutation'
    ) ? 'classifying' : 'notRequired',
    status: 'active',
    outcomeRecorded: false,
  };
  validateSessionProviderToolCallQueueV2(queue, {
    runId: queueRunId(queue),
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
  } else if (queue.target.kind === 'interventionResearch') {
    requiredIdentity(queue.target.researchId, 'target.researchId');
  } else if (queue.target.kind !== 'planning') {
    throw invalidQueue();
  }
  const callIds = new Set<string>();
  const operationIds = new Set<string>();
  const requestIds = new Set<string>();
  let correctionCount = 0;
  let planRevision: string | undefined;
  for (let index = 0; index < queue.calls.length; index += 1) {
    const item = queue.calls[index]!;
    const receipt = queue.receipt.calls[index]!;
    const intent = item.intent;
    const candidate = item.candidatePreview;
    const operationId = queueItemOperationId(item);
    const toolId = queueItemToolId(item);
    const rawArguments = queueItemRawArguments(item);
    const authority = intent?.authority;
    const targetAuthorityInvalid = intent
      ? authority?.kind === 'planAction'
        ? queue.target.kind !== 'planAction'
          || authority.data.planActionId !== queue.target.planActionId
          || (
            planRevision !== undefined
            && authority.data.planRevision !== planRevision
          )
        : authority?.kind !== 'read'
          || (
            queue.target.kind === 'contextRead'
            && authority.data.purpose !== queue.target.purpose
          )
      : false;
    if (
      queue.target.kind === 'planAction'
      && authority?.kind === 'planAction'
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
      || receipt.toolId !== toolId
      || receipt.argumentsDigest
        !== sha256Hash(canonicalJson(rawArguments))
      || (intent && intent.expectedControlEpoch !== queue.controlEpoch)
      || (candidate && candidate.controlEpoch !== queue.controlEpoch)
      || (
        expected.runId !== undefined
        && queueItemRunId(item) !== expected.runId
      )
      || targetAuthorityInvalid
      || (
        item.dispatchKind === 'read'
        && (!intent || candidate || authority?.kind !== 'read')
      )
      || (
        item.dispatchKind === 'mutation'
        && !candidate
      )
      || (
        candidate
        && (
          candidate.operationId !== operationId
          || candidate.toolId !== toolId
          || candidate.runId !== queueItemRunId(item)
          || canonicalJson(candidate.toolContextRef)
            !== canonicalJson(intent?.toolContextRef ?? candidate.toolContextRef)
          || (intent && (
            intent.operationId !== candidate.operationId
            || intent.toolId !== candidate.toolId
            || canonicalJson(intent.rawArguments)
              !== canonicalJson(candidate.rawArguments)
            || intent.idempotencyKey !== candidate.idempotencyKey
          ))
        )
      )
      || ![
        'pending',
        'previewing',
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
    requiredIdentity(operationId, 'operationId');
    if (operationIds.has(operationId)) throw invalidQueue();
    operationIds.add(operationId);
    if (candidate) validateMutationCandidatePreviewV4(candidate);
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
          === operationId
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
        item.status === 'previewing'
        || item.status === 'submitting'
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
        item.status === 'previewing'
        || item.status === 'submitting'
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
    if (
      item.status === 'previewing'
      && (!candidate || candidate.preview || candidate.rejection)
    ) {
      throw invalidQueue();
    }
    if (
      item.status !== 'previewing'
      && candidate
      && Boolean(candidate.preview) === Boolean(candidate.rejection)
      && candidate.classification !== undefined
    ) {
      throw invalidQueue();
    }
    if (callIds.has(receipt.callId)) throw invalidQueue();
    callIds.add(receipt.callId);
  }
  const activeCallCount = queue.calls.filter((item) =>
    item.status === 'previewing'
    || item.status === 'submitting'
    || item.status === 'awaitingCapability'
    || item.status === 'awaitingInvocation'
  ).length;
  const terminal = (item: SessionProviderToolCallQueueItemV2) =>
    item.status === 'completed'
    || item.status === 'aborted'
    || item.status === 'unexecuted';
  const mutationCalls = queue.calls.filter(
    (item) => item.dispatchKind === 'mutation'
  );
  const dispositionInvalid =
    (mutationCalls.length === 0
      && queue.mutationDisposition !== 'notRequired')
    || (mutationCalls.length > 0
      && queue.mutationDisposition === 'notRequired')
    || (queue.mutationDisposition === 'classifying'
      && mutationCalls.every((item) =>
        item.candidatePreview?.classification !== undefined
      ))
    || (queue.mutationDisposition === 'planned'
      && mutationCalls.some((item) =>
        item.candidatePreview?.classification !== 'planned'
        || !item.intent
      ))
    || (
      (
        queue.mutationDisposition === 'initialPlanDiscovery'
        || queue.mutationDisposition === 'userIntervention'
      )
      && mutationCalls.some((item) =>
        item.candidatePreview?.classification === undefined
        || item.status !== 'unexecuted'
      )
    );
  if (
    (queue.status === 'completed'
      && queue.calls.some((item) => item.status !== 'completed'))
    || (
      queue.status === 'active'
      && (
        queue.calls.every(terminal)
        || activeCallCount > 1
      )
    )
    || (
      queue.status === 'aborted'
      && (
        queue.calls.every((item) => item.status === 'completed')
        || queue.calls.some((item) =>
          item.status === 'pending'
          || item.status === 'previewing'
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
    || dispositionInvalid
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

export function nextSessionProviderToolCallQueueWorkV4(
  state: SessionKernelLoopStateV2
): SessionProviderToolCallQueueWorkV4 | undefined {
  const queue = activeSessionProviderToolCallQueueV2(state);
  if (!queue) return undefined;
  const inFlight = queue.calls.find((item) =>
    item.status === 'previewing'
    || item.status === 'submitting'
    || item.status === 'awaitingCapability'
    || item.status === 'awaitingInvocation'
  );
  if (inFlight) {
    if (inFlight.status === 'previewing') {
      const candidate = inFlight.candidatePreview;
      if (!candidate) throw invalidQueue();
      return { kind: 'preview', item: inFlight, candidate };
    }
    if (inFlight.status === 'submitting') {
      return {
        kind: 'intent',
        item: inFlight,
        intent: executableQueueItemIntent(inFlight),
      };
    }
    return undefined;
  }
  if (queue.mutationDisposition === 'classifying') {
    const candidateItem = queue.calls.find((item) =>
      item.dispatchKind === 'mutation'
      && item.status === 'pending'
      && item.candidatePreview?.preview === undefined
      && item.candidatePreview?.rejection === undefined
    );
    if (candidateItem) {
      const candidate = candidateItem.candidatePreview;
      if (!candidate) throw invalidQueue();
      return { kind: 'preview', item: candidateItem, candidate };
    }
    return undefined;
  }
  const intentItem = queue.calls.find((item) =>
    item.status === 'pending'
    && item.intent !== undefined
    && (
      item.dispatchKind === 'read'
      || queue.mutationDisposition === 'planned'
    )
  );
  return intentItem
    ? {
        kind: 'intent',
        item: intentItem,
        intent: executableQueueItemIntent(intentItem),
      }
    : undefined;
}

export function prepareSessionProviderMutationPreviewV4(
  state: SessionKernelLoopStateV2,
  input: {
    operationId: string;
    requestId: string;
    requestStartedAt: string;
  }
): void {
  const queue = activeSessionProviderToolCallQueueV2(state);
  const work = nextSessionProviderToolCallQueueWorkV4(state);
  if (
    !queue
    || !work
    || work.kind !== 'preview'
    || work.item.status !== 'pending'
    || work.candidate.operationId !== input.operationId
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
  work.item.status = 'previewing';
  work.item.requestId = input.requestId;
  work.item.requestStartedAt = input.requestStartedAt;
  try {
    validateSessionProviderToolCallQueueV2(queue, {
      runId: work.candidate.runId,
      controlEpoch: state.controlEpoch,
    });
  } catch (error) {
    work.item.status = 'pending';
    delete work.item.requestId;
    delete work.item.requestStartedAt;
    throw error;
  }
}

export function markSessionProviderMutationPreviewedV4(
  state: SessionKernelLoopStateV2,
  input: {
    requestId: string;
    reply: CapabilityScopePreviewBatchReplyV2;
  }
): boolean {
  const queue = activeSessionProviderToolCallQueueV2(state);
  const item = queue?.calls.find((candidate) =>
    candidate.status === 'previewing'
  );
  if (!queue || !item || item.requestId !== input.requestId) {
    return false;
  }
  const candidate = item.candidatePreview;
  if (
    !candidate
    || input.reply.runId !== candidate.runId
    || input.reply.acceptedControlEpoch !== candidate.controlEpoch
    || input.reply.planRevision !== candidate.planRevision
    || input.reply.results.length !== 1
  ) {
    throw invalidQueue();
  }
  const result = input.reply.results[0]!;
  const resultIdentity = result.kind === 'previewed'
    ? result.data.preview
    : result.data;
  if (
    resultIdentity.operationId !== candidate.operationId
    || resultIdentity.planActionId !== candidate.planActionId
    || resultIdentity.toolId !== candidate.toolId
  ) {
    throw invalidQueue();
  }
  if (result.kind === 'previewed') {
    candidate.preview = cloneJson(result.data.preview);
  } else if (result.kind === 'rejected') {
    candidate.rejection = {
      reason: result.data.reason,
      guidance: result.data.guidance,
    };
  } else {
    throw invalidQueue();
  }
  item.status = 'pending';
  delete item.requestId;
  delete item.requestStartedAt;
  validateSessionProviderToolCallQueueV2(queue, {
    runId: candidate.runId,
    controlEpoch: state.controlEpoch,
  });
  return true;
}

export function finalizeSessionProviderMutationClassificationV4(
  state: SessionKernelLoopStateV2,
  recordedAt: string
): boolean {
  const queue = activeSessionProviderToolCallQueueV2(state);
  if (!queue || queue.mutationDisposition !== 'classifying') return false;
  const mutationItems = queue.calls.filter(
    (item) => item.dispatchKind === 'mutation'
  );
  if (
    mutationItems.length === 0
    || mutationItems.some((item) => {
      const candidate = item.candidatePreview;
      return !candidate
        || (candidate.preview === undefined && candidate.rejection === undefined);
    })
  ) {
    return false;
  }

  const currentPlan = state.plan;
  const targetPlanActionId = queue.target.kind === 'planAction'
    ? queue.target.planActionId
    : undefined;
  const currentAction = targetPlanActionId
    ? currentPlan?.actions.find(
        (action) => action.manifest.planActionId === targetPlanActionId
      )
    : undefined;
  for (const item of mutationItems) {
    const candidate = item.candidatePreview!;
    const currentPreview = currentAction
      ? state.previews[currentAction.manifest.operationId]
      : undefined;
    candidate.classification = item.intent
      && currentPlan
      && currentAction
      && currentPreview
      && item.intent.authority.kind === 'planAction'
      && item.intent.authority.data.planRevision === currentPlan.planRevision
      && item.intent.authority.data.planActionId
        === currentAction.manifest.planActionId
      && candidate.preview
      && previewMatchesApprovedPlanAction(
        candidate.preview,
        currentPreview,
        candidate
      )
      ? 'planned'
      : 'outOfPlan';
  }

  const allPlanned = mutationItems.every(
    (item) => item.candidatePreview?.classification === 'planned'
      && item.intent !== undefined
  );
  if (allPlanned) {
    queue.mutationDisposition = 'planned';
  } else {
    queue.mutationDisposition = currentPlan
      ? 'userIntervention'
      : 'initialPlanDiscovery';
    for (const item of mutationItems) {
      item.status = 'unexecuted';
      item.settlementReason = item.candidatePreview?.classification === 'planned'
        ? 'deferredForIntervention'
        : 'candidatePreviewed';
    }
  }
  settleQueueFromTerminals(state, queue, recordedAt);
  validateSessionProviderToolCallQueueV2(queue, {
    runId: state.runId,
    controlEpoch: state.controlEpoch,
  });
  return true;
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
  const intent = executableQueueItemIntent(item);
  if (input.reply.data.operationId !== intent.operationId) {
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
        intent.operationId
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
        initialOperationId: queueItemOperationId(predecessor),
      })
    ).replace(/^sha256:/u, '')}`,
    predecessorOperationId: queueItemOperationId(predecessor),
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
    runId: queueRunId(queue),
    controlEpoch: queue.controlEpoch,
  });
  return queue.calls.map((call) => ({
    ordinal: call.ordinal,
    operationId: queueItemOperationId(call),
    toolId: queueItemToolId(call),
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

/**
 * Closes every Provider-native tool call when Session rejects the complete
 * batch before Kernel admission (for example schema repair or PlanAction
 * ownership repair). The synthetic operation identities are Session-only and
 * never grant capability; they exist solely to preserve the native
 * assistant(tool_calls) -> tool(result) continuation topology.
 */
export function repairedSessionProviderOutcomeV2(
  providerTurnId: string,
  output: Extract<
    SessionProviderTurnOutputV2,
    { kind: 'noTool' }
  >,
  recordedAt: string
): SessionProviderOutcomeRecordV2 {
  const calls = output.items.filter(
    (item): item is Extract<
      SessionProviderOrderedItemV2,
      { kind: 'toolCall' }
    > => item.kind === 'toolCall'
  );
  if (calls.length === 0 || calls.length > MAX_PROVIDER_TOOL_CALLS_PER_TURN) {
    throw invalidQueue();
  }
  if (!output.repair) throw invalidQueue();
  const settlementReason = output.repair.kind === 'toolArguments'
    ? 'sessionToolArgumentsInvalid'
    : 'sessionPlanActionOwnershipMismatch';
  const receipt: SessionProviderToolCallReceiptV2 = {
    schemaVersion: SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA,
    providerTurnId,
    responseDigest: output.completion.responseDigest,
    callCount: calls.length,
    calls: calls.map((call, index) => ({
      ordinal: index + 1,
      callId: call.callId,
      toolName: call.toolName,
      toolId: call.toolId,
      argumentsDigest: sha256Hash(canonicalJson(call.arguments)),
    })),
    recordedAt,
  };
  return {
    providerTurnId,
    outputKind: 'toolIntent',
    recordedAt,
    ...(output.guidance ? { summary: output.guidance.slice(0, 8_192) } : {}),
    toolCallReceipt: receipt,
    toolSettlement: {
      status: 'aborted',
      settledAt: recordedAt,
    },
    toolCalls: calls.map((call, index) => ({
      ordinal: index + 1,
      operationId: `provider-repair-${sha256Hash(canonicalJson({
        schemaVersion: 'deepcode.session.provider-repair-operation.v1',
        providerTurnId,
        callId: call.callId,
        ordinal: index + 1,
        toolId: call.toolId,
      })).slice('sha256:'.length)}`,
      toolId: call.toolId,
      status: 'unexecuted',
      settlementReason,
    })),
    providerResult: cloneJson(output.providerResult),
  };
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
  const work = nextSessionProviderToolCallQueueWorkV4(state);
  const item = work?.kind === 'intent' ? work.item : undefined;
  if (
    !queue
    || !item
    || item.status !== 'pending'
    || executableQueueItemIntent(item).operationId !== input.operationId
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
      runId: executableQueueItemIntent(item).runId,
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
    candidate.status === 'submitting'
    || candidate.status === 'awaitingCapability'
    || candidate.status === 'awaitingInvocation'
  );
  if (!item) {
    const settlement = settleQueueFromTerminals(state, queue, recordedAt);
    return settlement
      ? { changed: true, settlement }
      : { changed: false };
  }
  const wait = state.activeWait;
  if (
    wait?.kind === 'manualRecovery'
    && wait.operationId === queueItemOperationId(item)
  ) {
    abortSessionProviderToolCallQueueV2(
      state,
      'indeterminate',
      recordedAt,
      queueItemOperationId(item)
    );
    return { changed: true, settlement: 'aborted' };
  }
  if (
    (wait?.kind === 'capability' || wait?.kind === 'invocation')
    && wait.operationId === queueItemOperationId(item)
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
    fact.lineage.operationId === queueItemOperationId(item)
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
      terminal.lineage.operationId !== queueItemOperationId(item)
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
      const settlement = settleQueueFromTerminals(state, queue, recordedAt);
      return settlement
        ? { changed: true, settlement }
        : { changed: true };
    }
    const reason = terminalReason(terminal);
    abortSessionProviderToolCallQueueV2(
      state,
      reason,
      recordedAt,
      queueItemOperationId(item),
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
      queueItemOperationId(item)
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
  const currentItem = queue.calls.find((item) =>
      item.status === 'submitting'
      || item.status === 'awaitingCapability'
      || item.status === 'awaitingInvocation'
    );
  const inferredCurrentOperationId = currentOperationId
    ?? (currentItem ? queueItemOperationId(currentItem) : undefined);
  if (
    currentOperationId
    && !queue.calls.some((item) =>
      item.status !== 'completed'
      && queueItemOperationId(item) === currentOperationId
    )
  ) {
    throw invalidQueue();
  }
  for (const item of queue.calls) {
    if (item.status === 'completed') continue;
    if (
      inferredCurrentOperationId
      && queueItemOperationId(item) === inferredCurrentOperationId
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

function settleQueueFromTerminals(
  state: SessionKernelLoopStateV2,
  queue: SessionProviderToolCallQueueV2,
  recordedAt: string
): 'completed' | 'aborted' | undefined {
  if (queue.status !== 'active') return undefined;
  const terminal = (item: SessionProviderToolCallQueueItemV2) =>
    item.status === 'completed'
    || item.status === 'aborted'
    || item.status === 'unexecuted';
  if (!queue.calls.every(terminal)) return undefined;
  if (queue.calls.every((item) => item.status === 'completed')) {
    completeQueue(state, queue, recordedAt);
    return 'completed';
  }
  queue.status = 'aborted';
  queue.abortReason = queue.mutationDisposition === 'initialPlanDiscovery'
    ? 'planDiscovery'
    : queue.mutationDisposition === 'userIntervention'
      ? 'userIntervention'
      : queue.calls.find((item) => item.settlementReason)?.settlementReason
        ?? 'toolTerminalFailure';
  queue.settledAt = recordedAt;
  const turn = state.providerTurn;
  if (turn?.providerTurnId === queue.providerTurnId) {
    turn.status = 'aborted';
  }
  return 'aborted';
}

function queueItemOperationId(
  item: SessionProviderToolCallQueueItemV2
): string {
  const value = item.intent?.operationId
    ?? item.candidatePreview?.operationId;
  return requiredIdentity(value, 'operationId');
}

function queueItemToolId(
  item: SessionProviderToolCallQueueItemV2
): string {
  const value = item.intent?.toolId ?? item.candidatePreview?.toolId;
  return requiredIdentity(value, 'toolId');
}

function queueItemRunId(
  item: SessionProviderToolCallQueueItemV2
): string {
  const value = item.intent?.runId ?? item.candidatePreview?.runId;
  return requiredIdentity(value, 'runId');
}

function queueItemRawArguments(
  item: SessionProviderToolCallQueueItemV2
): RawToolArgumentsV2 {
  const value = item.intent?.rawArguments
    ?? item.candidatePreview?.rawArguments;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidQueue();
  }
  return value;
}

function queueRunId(queue: SessionProviderToolCallQueueV2): string {
  const runIds = new Set(queue.calls.map(queueItemRunId));
  if (runIds.size !== 1) throw invalidQueue();
  return runIds.values().next().value!;
}

function executableQueueItemIntent(
  item: SessionProviderToolCallQueueItemV2
): ToolIntentV2 {
  if (!item.intent) throw invalidQueue();
  return item.intent;
}

function validateMutationCandidatePreviewV4(
  candidate: SessionProviderMutationCandidatePreviewV4
): void {
  requiredIdentity(candidate.runId, 'candidate.runId');
  if (!Number.isSafeInteger(candidate.controlEpoch) || candidate.controlEpoch <= 0) {
    throw invalidQueue();
  }
  requiredIdentity(candidate.discoveryId, 'candidate.discoveryId');
  requiredIdentity(candidate.planRevision, 'candidate.planRevision');
  requiredIdentity(candidate.planActionId, 'candidate.planActionId');
  requiredIdentity(candidate.operationId, 'candidate.operationId');
  requiredIdentity(candidate.idempotencyKey, 'candidate.idempotencyKey');
  requiredIdentity(candidate.toolId, 'candidate.toolId');
  if (
    !candidate.rawArguments
    || typeof candidate.rawArguments !== 'object'
    || Array.isArray(candidate.rawArguments)
    || !candidate.deadline
    || typeof candidate.deadline !== 'object'
    || Array.isArray(candidate.deadline)
    || !candidate.toolContextRef
    || typeof candidate.toolContextRef !== 'object'
    || Array.isArray(candidate.toolContextRef)
    || (candidate.preview !== undefined && candidate.rejection !== undefined)
    || (
      candidate.classification !== undefined
      && candidate.preview === undefined
      && candidate.rejection === undefined
    )
    || (
      candidate.classification !== undefined
      && candidate.classification !== 'planned'
      && candidate.classification !== 'outOfPlan'
    )
  ) {
    throw invalidQueue();
  }
  if (candidate.rejection) {
    requiredIdentity(candidate.rejection.reason, 'candidate.rejection.reason');
    if (!candidate.rejection.guidance.trim()) throw invalidQueue();
  }
  const preview = candidate.preview;
  if (!preview) return;
  if (
    preview.runId !== candidate.runId
    || preview.controlEpoch !== candidate.controlEpoch
    || preview.planRevision !== candidate.planRevision
    || preview.planActionId !== candidate.planActionId
    || preview.operationId !== candidate.operationId
    || preview.toolId !== candidate.toolId
    || preview.origin.kind !== 'planDiscovery'
    || preview.origin.data.discoveryId !== candidate.discoveryId
    || canonicalJson(preview.contextRef)
      !== canonicalJson(candidate.toolContextRef)
  ) {
    throw invalidQueue();
  }
  requiredIdentity(preview.previewId, 'candidate.preview.previewId');
  requiredDigest(preview.scopeDigest, 'candidate.preview.scopeDigest');
  requiredDigest(
    preview.authorizationDigest,
    'candidate.preview.authorizationDigest'
  );
  requiredDigest(
    preview.toolContractDigest,
    'candidate.preview.toolContractDigest'
  );
}

function previewMatchesApprovedPlanAction(
  discovery: CapabilityScopePreviewRecordV2,
  approved: CapabilityScopePreviewRecordV2,
  candidate: SessionProviderMutationCandidatePreviewV4
): boolean {
  return discovery.runId === approved.runId
    && discovery.controlEpoch === approved.controlEpoch
    && discovery.toolId === approved.toolId
    && candidate.toolId === approved.toolId
    && canonicalJson(discovery.contextRef) === canonicalJson(approved.contextRef)
    && canonicalJson(discovery.authorizationBinding)
      === canonicalJson(approved.authorizationBinding)
    && canonicalJson(discovery.canonicalScope)
      === canonicalJson(approved.canonicalScope)
    && discovery.scopeDigest === approved.scopeDigest
    && discovery.authorizationDigest === approved.authorizationDigest
    && discovery.toolContractDigest === approved.toolContractDigest
    && discovery.effectClass === approved.effectClass
    && discovery.effectScope === approved.effectScope
    && discovery.risk === approved.risk
    && discovery.effectiveDeadlineMs === approved.effectiveDeadlineMs
    && discovery.disposition === approved.disposition;
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
    && record.outputKind !== 'intervention'
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
  if (
    previous.kind === 'interventionResearch'
    || next.kind === 'interventionResearch'
  ) {
    return previous.kind === 'interventionResearch'
      && next.kind === 'interventionResearch'
      && previous.researchId === next.researchId;
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
