import type { LlmChatRequest } from '@deepcode/protocol';
import { canonicalJson, sha256Hash } from '../cache/canonicalizer.js';
import type {
  SessionKernelTransportPrivateAuthV2,
} from './SessionKernelPortV2.js';
import type {
  SessionProviderCompletionReceiptV1,
  SessionProviderStructuredOutputCallV1,
  SessionProviderStructuredOutputFailureV1,
  SessionProviderStructuredOutputRecoveryV1,
} from './types.js';
import type {
  SessionProviderCacheLaneResetReasonV1,
} from './providerCacheLaneV2.js';
import {
  SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
} from './types.js';

/**
 * Session-facing Provider stream boundary.
 *
 * Daemon-private reasoning and raw upstream envelopes are intentionally not
 * representable here. A response exists only after provider-native completion
 * and a durable trace seal arrive in one exact terminal receipt.
 */
export interface SessionKernelLlmStreamTextItemV2 {
  kind: 'text';
  phase: 'commentary' | 'final_answer' | 'unknown';
  text: string;
}

export interface SessionKernelLlmStreamToolItemV2 {
  kind: 'toolCall';
  index: number;
  callId: string;
  name: string;
  arguments: string;
}

interface SessionKernelLlmStreamToolPositionV2 {
  kind: 'toolQueueMarker';
  nativeIndex: number;
}

interface SessionKernelLlmStreamPendingTextItemV2
  extends SessionKernelLlmStreamTextItemV2 {
  /** One-based position in the eventual sealed ordered-items array. */
  textOrdinal: number;
  publicationStarted: boolean;
}

interface SessionKernelLlmPendingPublicTextBatchV2 {
  textOrdinal: number;
  providerPhase?: 'commentary' | 'final_answer';
  textDelta: string;
  utf8ByteLength: number;
  startedAtMonotonicMs: number;
}

type SessionKernelLlmStreamPendingItemV2 =
  | SessionKernelLlmStreamPendingTextItemV2
  | SessionKernelLlmStreamToolPositionV2;

export interface SessionKernelLlmPublicTextDeltaV2 {
  providerTurnId: string;
  streamSequence: number;
  textOrdinal: number;
  providerPhase?: 'commentary' | 'final_answer';
  textDelta: string;
}

export type SessionKernelLlmPublicTextObserverV2 = (
  delta: SessionKernelLlmPublicTextDeltaV2
) => Promise<void>;

export interface SessionKernelLlmPublicActivityV2 {
  providerTurnId: string;
  activitySequence: number;
  code: 'provider.reasoning' | 'provider.composing';
}

export type SessionKernelLlmPublicActivityObserverV2 = (
  activity: SessionKernelLlmPublicActivityV2
) => Promise<void>;

export interface SessionKernelLlmStreamResultV2 {
  requestId: string;
  items: Array<
    SessionKernelLlmStreamTextItemV2
    | SessionKernelLlmStreamToolItemV2
  >;
  usage?: Record<string, unknown>;
  providerProfileId: string;
  provider: string;
  model: string;
  completion: SessionProviderCompletionReceiptV1;
}

export type SessionKernelProviderCachePredecessorV2 =
  | {
      schemaVersion:
        'deepcode.session.provider-cache-predecessor.v2';
      status: 'available';
      sessionId: string;
      runId: string;
      userTurnId: string;
      providerTurnId: string;
      controlEpoch: number;
      terminalKind: 'completed' | 'failed';
      replayEligible: boolean;
      terminalReasonCode?: string;
      externalRequestDigest: string;
      externalRequestBytes: number;
      providerProfileRevisionDigest: string;
      providerProfileId: string;
      provider: string;
      model: string;
      targetKind:
        | 'planning'
        | 'contextRead'
        | 'planAction'
        | 'interventionResearch'
        | 'finalAnswer';
      targetBindingDigest: string;
      toolSchemaDigest: string;
      responseFormatDigest: string;
      toolContextRef: {
        contextVersion: number;
        catalogDigest: string;
        contextDigest: string;
      };
      cacheLane: {
        laneId: string;
        laneRevision: number;
        relationKind:
          | 'bootstrap'
          | 'sameTurnToolContinuation'
          | 'sameTurnSessionControlContinuation'
          | 'sameTurnStructuredRepair'
          | 'nextUserTurn'
          | 'exactReplay'
          | 'reset';
        stablePrefixDigest: string;
      };
    }
  | {
      schemaVersion:
        'deepcode.session.provider-cache-predecessor.v2';
      status: 'unavailable';
      providerTurnId: string;
      reasonCode: SessionProviderCacheLaneResetReasonV1;
    };

export interface SessionKernelLlmTransportV2 {
  inspectCachePredecessor(
    providerTurnId: string,
    profileId: string,
    currentProviderTurnId: string,
    signal: AbortSignal
  ): Promise<SessionKernelProviderCachePredecessorV2>;
  request(
    request: LlmChatRequest,
    signal: AbortSignal,
    publicTextObserver?: SessionKernelLlmPublicTextObserverV2,
    publicActivityObserver?: SessionKernelLlmPublicActivityObserverV2
  ): Promise<SessionKernelLlmStreamResultV2>;
}

const MAX_SSE_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const MAX_PUBLIC_TEXT_BATCH_BYTES = 16 * 1024;
const MAX_PUBLIC_TEXT_BATCH_DELAY_MS = 250;

function monotonicNowMs(): number {
  return globalThis.performance.now();
}

export class HttpSessionKernelLlmTransportV2
implements SessionKernelLlmTransportV2 {
  readonly #runCapability: string;

  constructor(
    private readonly apiBase: string,
    privateAuth: SessionKernelTransportPrivateAuthV2,
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.#runCapability = privateAuth.runCapability;
  }

  async inspectCachePredecessor(
    providerTurnId: string,
    profileId: string,
    currentProviderTurnId: string,
    signal: AbortSignal
  ): Promise<SessionKernelProviderCachePredecessorV2> {
    let response: Response;
    try {
      const url = new URL(
        `${normalizeApiBase(this.apiBase)}/api/llm/cache/predecessors/${encodeURIComponent(providerTurnId)}`
      );
      url.searchParams.set('profileId', profileId);
      url.searchParams.set(
        'currentProviderTurnId',
        currentProviderTurnId
      );
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'x-deepcode-run-capability': this.#runCapability,
          'x-deepcode-session-id': this.sessionId,
          'x-deepcode-run-id': this.runId,
        },
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_cancelled',
          'Provider cache predecessor inspection was cancelled.'
        );
      }
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_transport_failed',
        safeProviderTransportMessage(
          error,
          'Provider cache predecessor inspection failed before receiving an HTTP response.'
        )
      );
    }
    if (!response.ok) {
      await cancelBody(response.body);
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_http_failed',
        `Provider cache predecessor inspection failed with HTTP ${response.status}.`,
        response.status
      );
    }
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_cache_predecessor_invalid',
        'Provider cache predecessor response is not valid JSON.'
      );
    }
    return decodeProviderCachePredecessorV2(
      payload,
      providerTurnId
    );
  }

  async request(
    request: LlmChatRequest,
    signal: AbortSignal,
    publicTextObserver?: SessionKernelLlmPublicTextObserverV2,
    publicActivityObserver?: SessionKernelLlmPublicActivityObserverV2
  ): Promise<SessionKernelLlmStreamResultV2> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${normalizeApiBase(this.apiBase)}/api/llm/chat/stream`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-deepcode-run-capability': this.#runCapability,
            'x-deepcode-session-id': this.sessionId,
            'x-deepcode-run-id': this.runId,
          },
          body: JSON.stringify(request),
          signal,
        }
      );
    } catch (error) {
      if (signal.aborted) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_cancelled',
          'Provider stream was cancelled before a terminal receipt.'
        );
      }
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_transport_failed',
        safeProviderTransportMessage(
          error,
          'Provider transport failed before receiving an HTTP response.'
        )
      );
    }
    if (!response.ok) {
      await cancelBody(response.body);
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_http_failed',
        `Provider transport failed with HTTP ${response.status}.`,
        response.status
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^text\/event-stream(?:;|$)/iu.test(contentType)) {
      await cancelBody(response.body);
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_content_type_invalid',
        'Provider stream did not return text/event-stream.'
      );
    }
    if (!response.body) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_stream_missing',
        'Provider stream response has no readable body.'
      );
    }
    return await consumeProviderSseV1(
      response.body,
      request.requestId,
      signal,
      publicTextObserver,
      publicActivityObserver
    );
  }
}

export async function consumeProviderSseV1(
  body: ReadableStream<Uint8Array>,
  expectedRequestId: string,
  signal: AbortSignal,
  publicTextObserver?: SessionKernelLlmPublicTextObserverV2,
  publicActivityObserver?: SessionKernelLlmPublicActivityObserverV2
): Promise<SessionKernelLlmStreamResultV2> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = body.getReader();
  let streamExhausted = false;
  let buffer = '';
  let metadata:
    | {
        providerProfileId: string;
        provider: string;
        model: string;
      }
    | undefined;
  let usage: Record<string, unknown> | undefined;
  let completion: SessionProviderCompletionReceiptV1 | undefined;
  let sealedItems: SessionKernelLlmStreamResultV2['items'] | undefined;
  let totalTextBytes = 0;
  let finalStarted = false;
  let publicStreamSequence = 0;
  let publicActivitySequence = 0;
  let publicComposingObserved = false;
  let pendingPublicTextBatch:
    | SessionKernelLlmPendingPublicTextBatchV2
    | undefined;
  let publicTextFlushTimer:
    | ReturnType<typeof setTimeout>
    | undefined;
  let publicTextPublicationTail = Promise.resolve();
  let publicTextPublicationFailed = false;
  let publicTextPublicationFailure: unknown;
  const pendingItems: SessionKernelLlmStreamPendingItemV2[] = [];
  const toolItems = new Map<number, SessionKernelLlmStreamToolItemV2>();

  const clearPublicTextFlushTimer = (): void => {
    if (publicTextFlushTimer === undefined) return;
    clearTimeout(publicTextFlushTimer);
    publicTextFlushTimer = undefined;
  };

  const publishPublicActivity = async (
    code: SessionKernelLlmPublicActivityV2['code']
  ): Promise<void> => {
    if (!publicActivityObserver) return;
    publicActivitySequence += 1;
    await publicActivityObserver({
      providerTurnId: expectedRequestId,
      activitySequence: publicActivitySequence,
      code,
    });
  };

  const enqueuePublicTextPublication = (
    batch: SessionKernelLlmPendingPublicTextBatchV2
  ): void => {
    const observer = publicTextObserver;
    if (!observer || !batch.textDelta) return;
    publicStreamSequence += 1;
    const delta: SessionKernelLlmPublicTextDeltaV2 = {
      providerTurnId: expectedRequestId,
      streamSequence: publicStreamSequence,
      textOrdinal: batch.textOrdinal,
      ...(batch.providerPhase
        ? { providerPhase: batch.providerPhase }
        : {}),
      textDelta: batch.textDelta,
    };
    publicTextPublicationTail = publicTextPublicationTail.then(
      async () => {
        if (publicTextPublicationFailed) return;
        try {
          await observer(delta);
        } catch (error) {
          publicTextPublicationFailed = true;
          publicTextPublicationFailure = error;
          void reader.cancel().catch(() => {
            // The projection failure remains authoritative.
          });
        }
      }
    );
  };

  const enqueuePendingPublicText = (): void => {
    clearPublicTextFlushTimer();
    const batch = pendingPublicTextBatch;
    pendingPublicTextBatch = undefined;
    if (batch) enqueuePublicTextPublication(batch);
  };

  const schedulePublicTextFlush = (): void => {
    if (
      publicTextFlushTimer !== undefined
      || !pendingPublicTextBatch
    ) {
      return;
    }
    const elapsed = monotonicNowMs()
      - pendingPublicTextBatch.startedAtMonotonicMs;
    const remaining = Math.max(
      1,
      Math.ceil(MAX_PUBLIC_TEXT_BATCH_DELAY_MS - elapsed)
    );
    publicTextFlushTimer = setTimeout(() => {
      publicTextFlushTimer = undefined;
      const batch = pendingPublicTextBatch;
      if (!batch) return;
      if (
        monotonicNowMs() - batch.startedAtMonotonicMs
          < MAX_PUBLIC_TEXT_BATCH_DELAY_MS
      ) {
        schedulePublicTextFlush();
        return;
      }
      pendingPublicTextBatch = undefined;
      enqueuePublicTextPublication(batch);
    }, remaining);
  };

  const flushPublicTextIfDue = async (): Promise<void> => {
    const batch = pendingPublicTextBatch;
    if (
      !batch
      || monotonicNowMs() - batch.startedAtMonotonicMs
        < MAX_PUBLIC_TEXT_BATCH_DELAY_MS
    ) {
      return;
    }
    await flushPendingPublicText();
  };

  const awaitPublicTextPublications = async (): Promise<void> => {
    await publicTextPublicationTail;
    if (publicTextPublicationFailed) {
      throw publicTextPublicationFailure;
    }
  };

  const flushPendingPublicText = async (): Promise<void> => {
    enqueuePendingPublicText();
    await awaitPublicTextPublications();
  };

  const publishPublicTextImmediately = async (
    item: SessionKernelLlmStreamPendingTextItemV2,
    textDelta: string
  ): Promise<void> => {
    enqueuePublicTextPublication({
      textOrdinal: item.textOrdinal,
      ...(item.phase === 'unknown'
        ? {}
        : { providerPhase: item.phase }),
      textDelta,
      utf8ByteLength: utf8Bytes(textDelta),
      startedAtMonotonicMs: monotonicNowMs(),
    });
    await awaitPublicTextPublications();
  };

  const bufferPublicText = async (
    item: SessionKernelLlmStreamPendingTextItemV2,
    textDelta: string
  ): Promise<void> => {
    const providerPhase = item.phase === 'unknown'
      ? undefined
      : item.phase;
    let remaining = textDelta;
    while (remaining) {
      if (
        pendingPublicTextBatch
        && (
          pendingPublicTextBatch.textOrdinal !== item.textOrdinal
          || pendingPublicTextBatch.providerPhase !== providerPhase
        )
      ) {
        await flushPendingPublicText();
      }
      if (!pendingPublicTextBatch) {
        pendingPublicTextBatch = {
          textOrdinal: item.textOrdinal,
          providerPhase,
          textDelta: '',
          utf8ByteLength: 0,
          startedAtMonotonicMs: monotonicNowMs(),
        };
        schedulePublicTextFlush();
      }
      const available = MAX_PUBLIC_TEXT_BATCH_BYTES
        - pendingPublicTextBatch.utf8ByteLength;
      const prefixLength = utf8PrefixLength(remaining, available);
      if (prefixLength === 0) {
        await flushPendingPublicText();
        continue;
      }
      const prefix = remaining.slice(0, prefixLength);
      pendingPublicTextBatch.textDelta += prefix;
      pendingPublicTextBatch.utf8ByteLength += utf8Bytes(prefix);
      remaining = remaining.slice(prefixLength);
      if (
        pendingPublicTextBatch.utf8ByteLength
          >= MAX_PUBLIC_TEXT_BATCH_BYTES
      ) {
        await flushPendingPublicText();
      }
    }
  };

  const publishSafeText = async (
    item: SessionKernelLlmStreamPendingTextItemV2,
    content: string
  ): Promise<void> => {
    if (
      !publicTextObserver
      || !content
    ) {
      return;
    }
    let textDelta = content;
    if (!item.publicationStarted) {
      if (!publicComposingObserved) {
        await publishPublicActivity('provider.composing');
        publicComposingObserved = true;
      }
      item.publicationStarted = true;
      const prefixLength = utf8PrefixLength(
        textDelta,
        MAX_PUBLIC_TEXT_BATCH_BYTES
      );
      await publishPublicTextImmediately(
        item,
        textDelta.slice(0, prefixLength)
      );
      textDelta = textDelta.slice(prefixLength);
    }
    if (textDelta) await bufferPublicText(item, textDelta);
  };

  const accept = async (frame: string): Promise<void> => {
    await flushPublicTextIfDue();
    const event = decodeSseFrame(frame, expectedRequestId);
    if (completion) {
      throw protocolViolation(
        'Provider emitted data after its sealed terminal receipt.'
      );
    }
    switch (event.name) {
      case 'provider_metadata': {
        if (metadata) {
          throw protocolViolation(
            'Provider stream emitted duplicate response metadata.'
          );
        }
        exactKeys(event.data, [
          'type',
          'requestId',
          'providerProfileId',
          'provider',
          'model',
        ]);
        metadata = {
          providerProfileId: identity(
            event.data.providerProfileId,
            'providerProfileId',
            1024
          ),
          provider: identity(event.data.provider, 'provider', 1024),
          model: identity(event.data.model, 'model', 1024),
        };
        await publishPublicActivity('provider.reasoning');
        return;
      }
      case 'provider_delta':
      case 'provider_commentary_delta':
      case 'provider_final_delta': {
        requireMetadata(metadata);
        exactKeys(event.data, ['type', 'requestId', 'chunk']);
        const chunk = record(event.data.chunk, 'chunk');
        exactKeys(
          chunk,
          ['type', 'content'],
          ['index', 'providerPhase']
        );
        if (chunk.type !== 'delta') {
          throw protocolViolation(
            'Provider text event has an invalid chunk type.'
          );
        }
        const content = text(
          chunk.content,
          'chunk.content',
          MAX_TEXT_BYTES
        );
        const phase = textPhase(event.name, chunk.providerPhase);
        if (finalStarted && phase === 'commentary') {
          throw protocolViolation(
            'Provider emitted commentary after final answer output began.'
          );
        }
        if (phase === 'final_answer') {
          if (toolItems.size > 0) {
            throw protocolViolation(
              'Provider final answer cannot share a response with tool calls.'
            );
          }
          finalStarted = true;
        }
        totalTextBytes += utf8Bytes(content);
        if (totalTextBytes > MAX_TEXT_BYTES) {
          throw new SessionKernelProviderTransportError(
            'session_kernel_provider_text_limit_exceeded',
            'Provider normalized text exceeded the one-turn limit.'
          );
        }
        const previous = pendingItems.at(-1);
        let pendingText: SessionKernelLlmStreamPendingTextItemV2;
        if (
          previous?.kind === 'text'
          && previous.phase === phase
        ) {
          previous.text += content;
          pendingText = previous;
        } else {
          await flushPendingPublicText();
          pendingText = {
            kind: 'text',
            phase,
            text: content,
            textOrdinal: pendingItems.length + 1,
            publicationStarted: false,
          };
          pendingItems.push(pendingText);
        }
        await publishSafeText(pendingText, content);
        return;
      }
      case 'provider_tool_call_delta': {
        await flushPendingPublicText();
        requireMetadata(metadata);
        if (finalStarted) {
          throw protocolViolation(
            'Provider tool calls cannot appear after final answer output began.'
          );
        }
        exactKeys(event.data, ['type', 'requestId', 'chunk']);
        const chunk = record(event.data.chunk, 'chunk');
        exactKeys(
          chunk,
          ['type', 'toolCallDelta'],
          ['index', 'callId']
        );
        if (chunk.type !== 'tool_call') {
          throw protocolViolation(
            'Provider tool-call event has an invalid chunk type.'
          );
        }
        const delta = record(
          chunk.toolCallDelta,
          'chunk.toolCallDelta'
        );
        exactKeys(
          delta,
          [],
          ['id', 'index', 'name', 'argumentsDelta']
        );
        const index = nativeToolIndex(delta.index ?? chunk.index);
        let item = toolItems.get(index);
        if (!item) {
          if (toolItems.size >= 32) {
            throw new SessionKernelProviderTransportError(
              'session_kernel_provider_tool_call_count_exceeded',
              'One Provider turn may return at most 32 ordered Kernel tool calls.'
            );
          }
          item = {
            kind: 'toolCall',
            index,
            callId: '',
            name: '',
            arguments: '',
          };
          pendingItems.push({
            kind: 'toolQueueMarker',
            nativeIndex: index,
          });
          toolItems.set(index, item);
        }
        const callId = optionalText(
          delta.id ?? chunk.callId,
          'toolCallDelta.id',
          1024
        );
        const name = optionalText(
          delta.name,
          'toolCallDelta.name',
          1024
        );
        if (callId) {
          if (item.callId && item.callId !== callId) {
            throw protocolViolation(
              'Provider changed a tool-call identity during streaming.'
            );
          }
          item.callId = callId;
        }
        if (name) {
          if (item.name && item.name !== name) {
            throw protocolViolation(
              'Provider changed a tool-call name during streaming.'
            );
          }
          item.name = name;
        }
        const argumentsDelta = optionalText(
          delta.argumentsDelta,
          'toolCallDelta.argumentsDelta',
          MAX_TOOL_ARGUMENT_BYTES,
          true
        ) ?? '';
        item.arguments += argumentsDelta;
        if (utf8Bytes(item.arguments) > MAX_TOOL_ARGUMENT_BYTES) {
          throw new SessionKernelProviderTransportError(
            'session_kernel_provider_tool_arguments_limit_exceeded',
            'Provider tool-call arguments exceeded the one-call limit.'
          );
        }
        return;
      }
      case 'provider_usage':
        requireMetadata(metadata);
        exactKeys(event.data, ['type', 'requestId', 'usage']);
        usage = boundedProviderUsageRecordV2(event.data.usage);
        return;
      case 'provider_terminal':
        requireMetadata(metadata);
        exactKeys(event.data, ['type', 'requestId', 'receipt']);
        {
          await flushPendingPublicText();
          const decodedCompletion = decodeCompletionReceipt(
            event.data.receipt
          );
          sealedItems = materializeCompletedItems(
            pendingItems,
            toolItems,
            decodedCompletion
          );
          completion = decodedCompletion;
        }
        return;
      case 'provider_error':
        await flushPendingPublicText();
        exactKeys(
          event.data,
          ['type', 'requestId', 'error'],
          ['message', 'structuredFailure']
        );
        const providerErrorCode = identity(
          event.data.error,
          'error',
          256
        );
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,255}$/u.test(
          providerErrorCode
        )) {
          throw protocolViolation(
            'Provider stream error code is not a stable identity.'
          );
        }
        throw new SessionKernelProviderTransportError(
          providerErrorCode,
          providerPublicErrorMessage(providerErrorCode),
          undefined,
          event.data.structuredFailure === undefined
            ? undefined
            : decodeStructuredOutputFailureV1(
                event.data.structuredFailure
              ),
          usage
        );
      case 'provider_reasoning_delta':
        throw protocolViolation(
          'Provider reasoning text is private Daemon trace data and cannot enter the Session stream.'
        );
      case 'provider_done':
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_terminal_receipt_missing',
          'Legacy provider_done is not a sealed native completion receipt.'
        );
      default:
        throw protocolViolation(
          `Unsupported Provider stream event: ${event.name}.`
        );
    }
  };

  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) {
        streamExhausted = true;
        buffer += finishUtf8(decoder);
        await flushPendingPublicText();
        if (buffer.trim()) {
          throw new SessionKernelProviderTransportError(
            'session_kernel_provider_stream_truncated',
            'Provider stream ended with an incomplete SSE frame.'
          );
        }
        if (!completion || !metadata || !sealedItems) {
          throw new SessionKernelProviderTransportError(
            'session_kernel_provider_terminal_receipt_missing',
            'Provider stream reached EOF without a sealed native completion receipt.'
          );
        }
        return {
          requestId: expectedRequestId,
          items: sealedItems,
          ...(usage ? { usage } : {}),
          ...metadata,
          completion,
        };
      }
      if (!(chunk.value instanceof Uint8Array)) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_stream_chunk_invalid',
          'Provider stream returned a non-binary chunk.'
        );
      }
      try {
        buffer += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_stream_utf8_invalid',
          'Provider stream contains invalid UTF-8.'
        );
      }
      while (true) {
        const boundary = nextBoundary(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        if (frame.trim()) await accept(frame);
      }
      if (utf8Bytes(buffer) > MAX_SSE_FRAME_BYTES) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_sse_frame_limit_exceeded',
          'Provider SSE frame exceeded the 16 MiB hard limit.'
        );
      }
    }
  } catch (error) {
    try {
      await flushPendingPublicText();
    } catch (publicationError) {
      throw publicationError;
    }
    throw error;
  } finally {
    clearPublicTextFlushTimer();
    if (!streamExhausted) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original transport/protocol error.
      }
    }
    reader.releaseLock();
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error) {
    if (signal.aborted) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_cancelled',
        'Provider stream was cancelled before a terminal receipt.'
      );
    }
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_stream_read_failed',
      safeProviderTransportMessage(
        error,
        'Provider stream failed before a terminal receipt.'
      )
    );
  }
}

function finishUtf8(decoder: TextDecoder): string {
  try {
    return decoder.decode();
  } catch {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_stream_utf8_invalid',
      'Provider stream ended with invalid UTF-8.'
    );
  }
}

function decodeSseFrame(
  frame: string,
  expectedRequestId: string
): { name: string; data: Record<string, unknown> } {
  let name: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/u)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ')
      ? rawValue.slice(1)
      : rawValue;
    if (field === 'event') {
      if (name !== undefined || !value) {
        throw protocolViolation(
          'Provider SSE frame has an invalid event field.'
        );
      }
      name = value;
    } else if (field === 'data') {
      dataLines.push(value);
    } else {
      throw protocolViolation(
        `Provider SSE field is not permitted: ${field}.`
      );
    }
  }
  if (!name || dataLines.length === 0) {
    throw protocolViolation(
      'Provider SSE frame must contain event and data fields.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n')) as unknown;
  } catch {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_sse_json_invalid',
      'Provider SSE data is not valid JSON.'
    );
  }
  const data = record(parsed, 'event.data');
  rejectPrivateFields(data);
  if (data.type !== name) {
    throw protocolViolation(
      'Provider SSE event name does not match data.type.'
    );
  }
  if (data.requestId !== expectedRequestId) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_identity_mismatch',
      'Provider stream event identity does not match the persisted turn.'
    );
  }
  return { name, data };
}

function decodeCompletionReceipt(
  value: unknown
): SessionProviderCompletionReceiptV1 {
  const receipt = record(value, 'receipt');
  exactKeys(receipt, [
    'schemaVersion',
    'nativeCompletion',
    'reasoningPresent',
    'reasoningTransport',
    'reasoningDigest',
    'responseDigest',
    'trace',
  ], ['structuredOutputRecovery']);
  if (
    receipt.schemaVersion
      !== SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA
    || receipt.reasoningPresent !== true
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_completion_receipt_invalid',
      'Provider terminal receipt is not a reasoning-complete v1 receipt.'
    );
  }
  const native = record(receipt.nativeCompletion, 'nativeCompletion');
  let nativeCompletion:
    SessionProviderCompletionReceiptV1['nativeCompletion'];
  switch (native.providerKind) {
    case 'openaiCompatible':
      exactKeys(native, [
        'providerKind',
        'terminalSignal',
        'finishReason',
      ]);
      if (
        native.terminalSignal !== '[DONE]'
        || (
          native.finishReason !== 'stop'
          && native.finishReason !== 'tool_calls'
        )
      ) {
        throw protocolViolation(
          'OpenAI-compatible native completion is invalid.'
        );
      }
      nativeCompletion = {
        providerKind: native.providerKind,
        terminalSignal: native.terminalSignal,
        finishReason: native.finishReason,
      };
      break;
    case 'anthropic':
      exactKeys(native, ['providerKind', 'terminalSignal']);
      if (native.terminalSignal !== 'message_stop') {
        throw protocolViolation(
          'Anthropic native completion is invalid.'
        );
      }
      nativeCompletion = {
        providerKind: native.providerKind,
        terminalSignal: native.terminalSignal,
      };
      break;
    case 'ollama':
      exactKeys(native, ['providerKind', 'terminalSignal']);
      if (native.terminalSignal !== 'done:true') {
        throw protocolViolation(
          'Ollama native completion is invalid.'
        );
      }
      nativeCompletion = {
        providerKind: native.providerKind,
        terminalSignal: native.terminalSignal,
      };
      break;
    default:
      throw protocolViolation(
        'Provider native completion kind is unsupported.'
      );
  }
  const trace = record(receipt.trace, 'trace');
  exactKeys(trace, [
    'sealed',
    'sealDigest',
    'terminalDigest',
    'recordCount',
  ]);
  if (
    trace.sealed !== true
    || !Number.isSafeInteger(trace.recordCount)
    || Number(trace.recordCount) <= 0
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_trace_seal_invalid',
      'Provider terminal receipt does not bind a durable sealed trace.'
    );
  }
  const reasoningTransport = identity(
    receipt.reasoningTransport,
    'reasoningTransport',
    256
  );
  if (
    reasoningTransport !== 'openaiPlaintext'
    && reasoningTransport !== 'anthropicPlaintext'
    && reasoningTransport !== 'ollamaPlaintext'
  ) {
    throw protocolViolation(
      'Provider reasoningTransport is unsupported.'
    );
  }
  const expectedReasoningTransport =
    nativeCompletion.providerKind === 'openaiCompatible'
      ? 'openaiPlaintext'
      : nativeCompletion.providerKind === 'anthropic'
        ? 'anthropicPlaintext'
        : 'ollamaPlaintext';
  if (reasoningTransport !== expectedReasoningTransport) {
    throw protocolViolation(
      'Provider reasoningTransport conflicts with native completion kind.'
    );
  }
  const structuredOutputRecovery = receipt.structuredOutputRecovery
    === undefined
    ? undefined
    : decodeStructuredOutputRecoveryV1(
        receipt.structuredOutputRecovery
      );
  return {
    schemaVersion: SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
    nativeCompletion,
    reasoningPresent: true,
    reasoningTransport,
    reasoningDigest: digest(
      receipt.reasoningDigest,
      'reasoningDigest'
    ),
    responseDigest: digest(
      receipt.responseDigest,
      'responseDigest'
    ),
    trace: {
      sealed: true,
      sealDigest: digest(trace.sealDigest, 'trace.sealDigest'),
      terminalDigest: digest(
        trace.terminalDigest,
        'trace.terminalDigest'
      ),
      recordCount: Number(trace.recordCount),
    },
    ...(structuredOutputRecovery
      ? { structuredOutputRecovery }
      : {}),
  };
}

export function decodeStructuredOutputRecoveryV1(
  value: unknown
): SessionProviderStructuredOutputRecoveryV1 {
  const recordValue = record(value, 'structuredOutputRecovery');
  exactKeys(recordValue, [
    'schemaVersion',
    'disposition',
    'errorCode',
    'failureDigest',
    'calls',
  ]);
  if (
    recordValue.schemaVersion
      !== 'deepcode.provider.structured-output-recovery.v1'
    || recordValue.disposition !== 'normalizedProposalControl'
    || recordValue.errorCode
      !== 'provider_tool_call_arguments_invalid'
  ) {
    throw protocolViolation(
      'Provider structured-output recovery identity is invalid.'
    );
  }
  const calls = decodeStructuredOutputCallsV1(
    recordValue.calls,
    true
  );
  const failureDigest = digest(
    recordValue.failureDigest,
    'structuredOutputRecovery.failureDigest'
  );
  assertStructuredOutputFailureDigestV1(calls, failureDigest);
  return {
    schemaVersion: recordValue.schemaVersion,
    disposition: recordValue.disposition,
    errorCode: recordValue.errorCode,
    failureDigest,
    calls,
  };
}

export function decodeStructuredOutputFailureV1(
  value: unknown
): SessionProviderStructuredOutputFailureV1 {
  const recordValue = record(value, 'structuredFailure');
  exactKeys(recordValue, [
    'schemaVersion',
    'disposition',
    'errorCode',
    'failureDigest',
    'nativeCompletion',
    'calls',
  ]);
  if (
    recordValue.schemaVersion
      !== 'deepcode.provider.structured-output-failure.v1'
    || recordValue.disposition !== 'repairableNoMutation'
    || recordValue.errorCode
      !== 'provider_tool_call_arguments_invalid'
  ) {
    throw protocolViolation(
      'Provider structured-output failure identity is invalid.'
    );
  }
  const calls = decodeStructuredOutputCallsV1(
    recordValue.calls,
    false
  );
  const failureDigest = digest(
    recordValue.failureDigest,
    'structuredFailure.failureDigest'
  );
  assertStructuredOutputFailureDigestV1(calls, failureDigest);
  return {
    schemaVersion: recordValue.schemaVersion,
    disposition: recordValue.disposition,
    errorCode: recordValue.errorCode,
    failureDigest,
    nativeCompletion: decodeStructuredNativeCompletionV1(
      recordValue.nativeCompletion
    ),
    calls,
  };
}

function decodeStructuredOutputCallsV1(
  value: unknown,
  normalized: boolean
): SessionProviderStructuredOutputCallV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw protocolViolation(
      'Provider structured-output call evidence is invalid.'
    );
  }
  const indexes = new Set<number>();
  const callIds = new Set<string>();
  return value.map((candidate, ordinal) => {
    const call = record(candidate, `structuredOutput.calls[${ordinal}]`);
    exactKeys(
      call,
      ['index', 'callId', 'toolName', 'originalArgumentsDigest'],
      normalized
        ? ['normalizedArgumentsDigest', 'appendedSuffix']
        : []
    );
    const index = call.index;
    if (
      !Number.isSafeInteger(index)
      || Number(index) < 0
      || Number(index) >= 32
      || indexes.has(Number(index))
    ) {
      throw protocolViolation(
        'Provider structured-output call index is invalid.'
      );
    }
    indexes.add(Number(index));
    const callId = identity(call.callId, 'structuredOutput.callId', 1024);
    if (callIds.has(callId)) {
      throw protocolViolation(
        'Provider structured-output call identities must be unique.'
      );
    }
    callIds.add(callId);
    const toolName = identity(
      call.toolName,
      'structuredOutput.toolName',
      1024
    );
    const originalArgumentsDigest = digest(
      call.originalArgumentsDigest,
      'structuredOutput.originalArgumentsDigest'
    );
    if (!normalized) {
      return {
        index: Number(index),
        callId,
        toolName,
        originalArgumentsDigest,
      };
    }
    if (
      toolName !== 'deepcode_session_plan_propose_v5'
      && toolName !== 'deepcode_session_intervention_propose_v1'
    ) {
      throw protocolViolation(
        'Only Session proposal controls may be deterministically normalized.'
      );
    }
    const appendedSuffix = text(
      call.appendedSuffix,
      'structuredOutput.appendedSuffix',
      32
    );
    if (
      !appendedSuffix
      || !/^[}\]]+$/u.test(appendedSuffix)
    ) {
      throw protocolViolation(
        'Provider structured-output normalization suffix is invalid.'
      );
    }
    return {
      index: Number(index),
      callId,
      toolName,
      originalArgumentsDigest,
      normalizedArgumentsDigest: digest(
        call.normalizedArgumentsDigest,
        'structuredOutput.normalizedArgumentsDigest'
      ),
      appendedSuffix,
    };
  });
}

function assertStructuredOutputFailureDigestV1(
  calls: readonly SessionProviderStructuredOutputCallV1[],
  failureDigest: string
): void {
  const expected = sha256Hash(canonicalJson({
    errorCode: 'provider_tool_call_arguments_invalid',
    calls: calls.map((call) => ({
      index: call.index,
      toolName: call.toolName,
      originalArgumentsDigest: call.originalArgumentsDigest,
    })),
  }));
  if (expected !== failureDigest) {
    throw protocolViolation(
      'Provider structured-output failure digest is invalid.'
    );
  }
}

function decodeStructuredNativeCompletionV1(
  value: unknown
): SessionProviderStructuredOutputFailureV1['nativeCompletion'] {
  const native = record(value, 'structuredFailure.nativeCompletion');
  switch (native.providerKind) {
    case 'openaiCompatible':
      exactKeys(native, [
        'providerKind',
        'terminalSignal',
        'finishReason',
      ]);
      if (
        native.terminalSignal !== '[DONE]'
        || (
          native.finishReason !== 'stop'
          && native.finishReason !== 'tool_calls'
        )
      ) throw protocolViolation('Structured failure native completion is invalid.');
      return {
        providerKind: native.providerKind,
        terminalSignal: native.terminalSignal,
        finishReason: native.finishReason,
      };
    case 'anthropic':
      exactKeys(native, ['providerKind', 'terminalSignal']);
      if (native.terminalSignal !== 'message_stop') {
        throw protocolViolation('Structured failure native completion is invalid.');
      }
      return {
        providerKind: native.providerKind,
        terminalSignal: native.terminalSignal,
      };
    case 'ollama':
      exactKeys(native, ['providerKind', 'terminalSignal']);
      if (native.terminalSignal !== 'done:true') {
        throw protocolViolation('Structured failure native completion is invalid.');
      }
      return {
        providerKind: native.providerKind,
        terminalSignal: native.terminalSignal,
      };
    default:
      throw protocolViolation('Structured failure native completion is invalid.');
  }
}

function applyStructuredOutputRecoveryV1(
  toolItems: Map<number, SessionKernelLlmStreamToolItemV2>,
  recovery: SessionProviderStructuredOutputRecoveryV1 | undefined
): void {
  if (!recovery) return;
  for (const call of recovery.calls) {
    const item = toolItems.get(call.index);
    if (
      !item
      || item.callId !== call.callId
      || item.name !== call.toolName
      || sha256Hash(item.arguments) !== call.originalArgumentsDigest
      || !call.appendedSuffix
      || !call.normalizedArgumentsDigest
    ) {
      throw protocolViolation(
        'Provider structured-output recovery does not bind the streamed call.'
      );
    }
    const normalized = `${item.arguments}${call.appendedSuffix}`;
    if (sha256Hash(normalized) !== call.normalizedArgumentsDigest) {
      throw protocolViolation(
        'Provider structured-output recovery digest is invalid.'
      );
    }
    try {
      JSON.parse(normalized);
    } catch {
      throw protocolViolation(
        'Provider structured-output recovery did not produce valid JSON.'
      );
    }
    item.arguments = normalized;
  }
}

function materializeCompletedItems(
  pendingItems: SessionKernelLlmStreamPendingItemV2[],
  toolItems: Map<number, SessionKernelLlmStreamToolItemV2>,
  completion: SessionProviderCompletionReceiptV1
): SessionKernelLlmStreamResultV2['items'] {
  applyStructuredOutputRecoveryV1(
    toolItems,
    completion.structuredOutputRecovery
  );
  const callIds = new Set<string>();
  for (const item of toolItems.values()) {
    identity(item.callId, 'toolCall.id', 1024);
    identity(item.name, 'toolCall.name', 1024);
    if (callIds.has(item.callId)) {
      throw protocolViolation(
        'Provider tool-call identities must be unique within one response.'
      );
    }
    callIds.add(item.callId);
    try {
      JSON.parse(item.arguments || '{}');
    } catch {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_tool_arguments_invalid',
        'Provider-native tool arguments are not valid JSON.'
      );
    }
  }
  const hasFinal = pendingItems.some(
    (item) => item.kind === 'text'
      && item.phase === 'final_answer'
  );
  if (hasFinal && toolItems.size > 0) {
    throw protocolViolation(
      'Provider final answer cannot share a response with tool calls.'
    );
  }
  const native = completion.nativeCompletion;
  if (
    native.providerKind === 'openaiCompatible'
    && (
      (toolItems.size > 0 && native.finishReason !== 'tool_calls')
      || (toolItems.size === 0 && native.finishReason !== 'stop')
    )
  ) {
    throw protocolViolation(
      'OpenAI-compatible finish_reason conflicts with the completed response.'
    );
  }
  const toolOrdinals = completedToolOrdinals(
    pendingItems,
    toolItems,
    completion.nativeCompletion.providerKind
  );
  const materialized: SessionKernelLlmStreamResultV2['items'] = [];
  for (const item of pendingItems) {
    if (item.kind === 'toolQueueMarker') {
      const tool = toolItems.get(item.nativeIndex);
      const ordinal = toolOrdinals.get(item.nativeIndex);
      if (!tool || ordinal === undefined) {
        throw protocolViolation(
          'Provider tool-call position does not match the sealed response.'
        );
      }
      materialized.push({ ...tool, index: ordinal });
    } else {
      materialized.push({
        kind: 'text',
        phase: item.phase,
        text: item.text,
      });
    }
  }
  return materialized;
}

function completedToolOrdinals(
  pendingItems: SessionKernelLlmStreamPendingItemV2[],
  toolItems: Map<number, SessionKernelLlmStreamToolItemV2>,
  providerKind:
    SessionProviderCompletionReceiptV1['nativeCompletion']['providerKind']
): Map<number, number> {
  // OpenAI/Ollama indexes are tool ordinals. Anthropic indexes address all
  // content blocks, so non-tool blocks may create gaps between tool indexes.
  // In both cases first occurrence fixes the public semantic position.
  const nativeIndexes = pendingItems.flatMap((item) =>
    item.kind === 'toolQueueMarker' ? [item.nativeIndex] : []
  );
  if (
    nativeIndexes.length !== toolItems.size
    || new Set(nativeIndexes).size !== nativeIndexes.length
    || nativeIndexes.some((index) => !toolItems.has(index))
  ) {
    throw protocolViolation(
      'Provider tool-call positions do not match the sealed response.'
    );
  }

  if (
    providerKind === 'openaiCompatible'
    || providerKind === 'ollama'
  ) {
    for (const [ordinal, nativeIndex] of nativeIndexes.entries()) {
      if (nativeIndex !== ordinal) {
        throw protocolViolation(
          'Provider-native tool ordinals must first appear continuously from zero.'
        );
      }
    }
  } else {
    for (let ordinal = 1; ordinal < nativeIndexes.length; ordinal += 1) {
      if (nativeIndexes[ordinal] <= nativeIndexes[ordinal - 1]) {
        throw protocolViolation(
          'Anthropic tool content-block indexes must first appear in native order.'
        );
      }
    }
  }

  return new Map(
    nativeIndexes.map((nativeIndex, ordinal) => [nativeIndex, ordinal])
  );
}

function textPhase(
  eventName: string,
  declared: unknown
): 'commentary' | 'final_answer' | 'unknown' {
  if (
    declared !== undefined
    && declared !== 'commentary'
    && declared !== 'final_answer'
  ) {
    throw protocolViolation(
      'Provider text delta has an invalid providerPhase.'
    );
  }
  const eventPhase = eventName === 'provider_commentary_delta'
    ? 'commentary'
    : eventName === 'provider_final_delta'
      ? 'final_answer'
      : undefined;
  if (
    eventPhase !== undefined
    && declared !== undefined
    && eventPhase !== declared
  ) {
    throw protocolViolation(
      'Provider text event conflicts with its declared providerPhase.'
    );
  }
  return eventPhase ?? declared ?? 'unknown';
}

function nextBoundary(
  buffer: string
): { index: number; length: number } | undefined {
  return [
    { value: '\r\n\r\n', length: 4 },
    { value: '\n\n', length: 2 },
    { value: '\r\r', length: 2 },
  ]
    .map((candidate) => ({
      index: buffer.indexOf(candidate.value),
      length: candidate.length,
    }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => left.index - right.index)[0];
}

function requireMetadata(
  metadata: unknown
): asserts metadata is {
  providerProfileId: string;
  provider: string;
  model: string;
} {
  if (!metadata) {
    throw protocolViolation(
      'Provider response data arrived before response metadata.'
    );
  }
}

function rejectPrivateFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectPrivateFields(item);
    return;
  }
  const candidate = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
  if (!candidate) return;
  for (const [key, nested] of Object.entries(candidate)) {
    const normalized = key.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
    if (
      normalized === 'rawprovider'
      || normalized === 'reasoning'
      || normalized === 'reasoningcontent'
      || normalized === 'thinking'
      || normalized === 'analysis'
      || normalized === 'chainofthought'
    ) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_private_field_forbidden',
        'Provider stream exposed private reasoning or raw Provider data.'
      );
    }
    rejectPrivateFields(nested);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const permitted = new Set([...required, ...optional]);
  if (
    required.some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key)
    )
    || Object.keys(value).some((key) => !permitted.has(key))
  ) {
    throw protocolViolation(
      'Provider stream event has an unexpected field set.'
    );
  }
}

function record(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolViolation(
      `Provider stream ${field} must be an object.`
    );
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  field: string,
  limit: number
): string {
  const decoded = optionalText(value, field, limit, true);
  if (decoded === undefined || decoded.length === 0) {
    throw protocolViolation(
      `Provider stream ${field} must be a nonempty string.`
    );
  }
  return decoded;
}

function optionalText(
  value: unknown,
  field: string,
  limit: number,
  allowControls = false
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string'
    || utf8Bytes(value) > limit
    || (!allowControls && /[\u0000-\u001f\u007f-\u009f]/u.test(value))
  ) {
    throw protocolViolation(
      `Provider stream ${field} is invalid.`
    );
  }
  return value;
}

function identity(
  value: unknown,
  field: string,
  limit: number
): string {
  const decoded = text(value, field, limit);
  if (decoded.trim() !== decoded) {
    throw protocolViolation(
      `Provider stream ${field} is not a canonical identity.`
    );
  }
  return decoded;
}

function digest(value: unknown, field: string): string {
  const decoded = identity(value, field, 128);
  if (!/^sha256:[0-9a-f]{64}$/u.test(decoded)) {
    throw protocolViolation(
      `Provider stream ${field} is not a canonical digest.`
    );
  }
  return decoded;
}

function nativeToolIndex(value: unknown): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < 0
  ) {
    throw protocolViolation(
      'Provider tool-call native index must be a nonnegative safe integer.'
    );
  }
  return Number(value);
}

function decodeProviderCachePredecessorV2(
  value: unknown,
  expectedProviderTurnId: string
): SessionKernelProviderCachePredecessorV2 {
  const envelope = record(value, 'cachePredecessorEnvelope');
  exactKeys(envelope, ['ok', 'data', 'error', 'message']);
  if (envelope.ok !== true) {
    const code = typeof envelope.error === 'string'
      ? envelope.error
      : 'session_kernel_provider_cache_predecessor_failed';
    throw new SessionKernelProviderTransportError(
      code,
      'Provider cache predecessor inspection was rejected.'
    );
  }
  const data = record(envelope.data, 'cachePredecessor');
  const schemaVersion = identity(
    data.schemaVersion,
    'cachePredecessor.schemaVersion',
    128
  );
  if (
    schemaVersion
      !== 'deepcode.session.provider-cache-predecessor.v2'
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_cache_predecessor_invalid',
      'Provider cache predecessor schema is unsupported.'
    );
  }
  const providerTurnId = identity(
    data.providerTurnId,
    'cachePredecessor.providerTurnId',
    512
  );
  if (providerTurnId !== expectedProviderTurnId) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_cache_predecessor_invalid',
      'Provider cache predecessor identity does not match the request.'
    );
  }
  if (data.status === 'unavailable') {
    exactKeys(data, [
      'schemaVersion',
      'status',
      'providerTurnId',
      'reasonCode',
    ]);
    const reasonCode = identity(
      data.reasonCode,
      'cachePredecessor.reasonCode',
      128
    );
    if (!isCacheLaneResetReasonV1(reasonCode)) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_cache_predecessor_invalid',
        'Provider cache predecessor reset reason is unsupported.'
      );
    }
    return {
      schemaVersion,
      status: 'unavailable',
      providerTurnId,
      reasonCode,
    };
  }
  if (data.status !== 'available') {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_cache_predecessor_invalid',
      'Provider cache predecessor status is unsupported.'
    );
  }
  exactKeys(data, [
    'schemaVersion',
    'status',
    'sessionId',
    'runId',
    'userTurnId',
    'providerTurnId',
    'controlEpoch',
    'terminalKind',
    'replayEligible',
    'terminalReasonCode',
    'externalRequestDigest',
    'externalRequestBytes',
    'providerProfileRevisionDigest',
    'providerProfileId',
    'provider',
    'model',
    'targetKind',
    'targetBindingDigest',
    'toolSchemaDigest',
    'responseFormatDigest',
    'toolContextRef',
    'cacheLane',
  ]);
  const externalRequestBytes = positiveSafeInteger(
    data.externalRequestBytes,
    'cachePredecessor.externalRequestBytes'
  );
  const targetKind = identity(
    data.targetKind,
    'cachePredecessor.targetKind',
    64
  );
  if (
    targetKind !== 'planning'
    && targetKind !== 'contextRead'
    && targetKind !== 'planAction'
    && targetKind !== 'interventionResearch'
    && targetKind !== 'finalAnswer'
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_cache_predecessor_invalid',
      'Provider cache predecessor target kind is unsupported.'
    );
  }
  const terminalKind = identity(
    data.terminalKind,
    'cachePredecessor.terminalKind',
    32
  );
  if (terminalKind !== 'completed' && terminalKind !== 'failed') {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_cache_predecessor_invalid',
      'Provider cache predecessor terminal kind is unsupported.'
    );
  }
  if (typeof data.replayEligible !== 'boolean') {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_cache_predecessor_invalid',
      'Provider cache predecessor replay eligibility is invalid.'
    );
  }
  const terminalReasonCode = data.terminalReasonCode === null
    ? undefined
    : identity(
        data.terminalReasonCode,
        'cachePredecessor.terminalReasonCode',
        256
      );
  if (
    data.replayEligible
      !== (
        terminalKind === 'failed'
        && terminalReasonCode === 'provider_retryable_no_mutation'
      )
    || (terminalKind === 'completed' && terminalReasonCode !== undefined)
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_cache_predecessor_invalid',
      'Provider cache predecessor replay evidence is inconsistent.'
    );
  }
  const toolContextRef = record(
    data.toolContextRef,
    'cachePredecessor.toolContextRef'
  );
  exactKeys(toolContextRef, [
    'contextVersion',
    'catalogDigest',
    'contextDigest',
  ]);
  const cacheLane = record(
    data.cacheLane,
    'cachePredecessor.cacheLane'
  );
  exactKeys(cacheLane, [
    'laneId',
    'laneRevision',
    'relationKind',
    'stablePrefixDigest',
  ]);
  const relationKind = identity(
    cacheLane.relationKind,
    'cachePredecessor.cacheLane.relationKind',
    64
  );
  if (![
    'bootstrap',
    'sameTurnToolContinuation',
    'sameTurnSessionControlContinuation',
    'sameTurnStructuredRepair',
    'nextUserTurn',
    'exactReplay',
    'reset',
  ].includes(relationKind)) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_cache_predecessor_invalid',
      'Provider cache predecessor relation kind is unsupported.'
    );
  }
  return {
    schemaVersion,
    status: 'available',
    sessionId: identity(
      data.sessionId,
      'cachePredecessor.sessionId',
      512
    ),
    runId: identity(data.runId, 'cachePredecessor.runId', 512),
    userTurnId: identity(
      data.userTurnId,
      'cachePredecessor.userTurnId',
      512
    ),
    providerTurnId,
    controlEpoch: positiveSafeInteger(
      data.controlEpoch,
      'cachePredecessor.controlEpoch'
    ),
    terminalKind,
    replayEligible: data.replayEligible,
    ...(terminalReasonCode ? { terminalReasonCode } : {}),
    externalRequestDigest: digest(
      data.externalRequestDigest,
      'cachePredecessor.externalRequestDigest'
    ),
    externalRequestBytes,
    providerProfileRevisionDigest: digest(
      data.providerProfileRevisionDigest,
      'cachePredecessor.providerProfileRevisionDigest'
    ),
    providerProfileId: identity(
      data.providerProfileId,
      'cachePredecessor.providerProfileId',
      512
    ),
    provider: identity(
      data.provider,
      'cachePredecessor.provider',
      512
    ),
    model: identity(data.model, 'cachePredecessor.model', 512),
    targetKind,
    targetBindingDigest: digest(
      data.targetBindingDigest,
      'cachePredecessor.targetBindingDigest'
    ),
    toolSchemaDigest: digest(
      data.toolSchemaDigest,
      'cachePredecessor.toolSchemaDigest'
    ),
    responseFormatDigest: digest(
      data.responseFormatDigest,
      'cachePredecessor.responseFormatDigest'
    ),
    toolContextRef: {
      contextVersion: positiveSafeInteger(
        toolContextRef.contextVersion,
        'cachePredecessor.toolContextRef.contextVersion'
      ),
      catalogDigest: digest(
        toolContextRef.catalogDigest,
        'cachePredecessor.toolContextRef.catalogDigest'
      ),
      contextDigest: digest(
        toolContextRef.contextDigest,
        'cachePredecessor.toolContextRef.contextDigest'
      ),
    },
    cacheLane: {
      laneId: digest(
        cacheLane.laneId,
        'cachePredecessor.cacheLane.laneId'
      ),
      laneRevision: positiveSafeInteger(
        cacheLane.laneRevision,
        'cachePredecessor.cacheLane.laneRevision'
      ),
      relationKind: relationKind as
        | 'bootstrap'
        | 'sameTurnToolContinuation'
        | 'sameTurnSessionControlContinuation'
        | 'sameTurnStructuredRepair'
        | 'nextUserTurn'
        | 'exactReplay'
        | 'reset',
      stablePrefixDigest: digest(
        cacheLane.stablePrefixDigest,
        'cachePredecessor.cacheLane.stablePrefixDigest'
      ),
    },
  };
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_cache_predecessor_invalid',
      `Provider cache predecessor ${field} is invalid.`
    );
  }
  return Number(value);
}

function isCacheLaneResetReasonV1(
  value: string
): value is SessionProviderCacheLaneResetReasonV1 {
  return [
    'coldStart',
    'semanticLaneChanged',
    'providerProfileChanged',
    'modelChanged',
    'systemContractChanged',
    'toolSchemaChanged',
    'responseFormatChanged',
    'contextCompaction',
    'rewind',
    'daemonTraceUnavailable',
    'daemonTraceInvalid',
    'legacySessionColdStart',
    'manualReset',
  ].includes(value);
}

function providerPublicErrorMessage(code: string): string {
  switch (code) {
    case 'ProviderProfileMissingApiKey':
      return 'Selected Provider Profile has no configured API key.';
    case 'provider_reasoning_missing':
      return 'Provider response did not contain the required plaintext reasoning.';
    case 'provider_final_answer_tool_call_forbidden':
      return 'Provider returned a tool call during a no-tools finalAnswer turn.';
    case 'provider_trace_envelope_too_large':
    case 'provider_error_body_too_large':
      return 'Provider response exceeded the per-envelope structural size limit.';
    case 'provider_retryable_no_mutation':
      return 'Provider transport ended before a validated response was committed.';
    default:
      return 'Provider stream failed before a validated terminal receipt.';
  }
}

function protocolViolation(
  message: string
): SessionKernelProviderTransportError {
  return new SessionKernelProviderTransportError(
    'session_kernel_provider_protocol_violation',
    message
  );
}

export function boundedProviderUsageRecordV2(
  value: unknown
): Record<string, unknown> {
  const maximum = 1_000_000_000_000;
  const usage = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  let visited = 0;
  const sanitize = (
    candidate: Record<string, unknown>,
    depth: number
  ): Record<string, unknown> => {
    if (depth > 4) return {};
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(candidate).sort()) {
      visited += 1;
      if (
        visited > 256
        || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(key)
      ) {
        continue;
      }
      if (
        typeof nested === 'number'
        && Number.isSafeInteger(nested)
        && nested >= 0
        && nested <= maximum
      ) {
        output[key] = nested;
      } else if (
        nested
        && typeof nested === 'object'
        && !Array.isArray(nested)
      ) {
        output[key] = sanitize(
          nested as Record<string, unknown>,
          depth + 1
        );
      }
    }
    return output;
  };
  const sanitized = sanitize(usage, 0);
  return utf8Bytes(canonicalJson(sanitized)) <= 64 * 1024
    ? sanitized
    : {};
}

export function safeProviderTransportMessage(
  error: unknown,
  fallback: string
): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return fallback;
  }
  const message = error.message.trim().slice(0, 4096);
  return /authorization|api[-_ ]?key|cookie|token|secret/iu.test(message)
    ? fallback
    : message;
}

function normalizeApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidApiBase();
  }
  const authority = value
    .split('://')[1]
    ?.split('/')[0] ?? '';
  const hostname = url.hostname.startsWith('[')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const loopback = hostname === '::1'
    || (
      hostname.split('.').length === 4
      && hostname.split('.').every(
        (part) =>
          /^\d{1,3}$/u.test(part)
          && Number(part) >= 0
          && Number(part) <= 255
      )
      && Number(hostname.split('.')[0]) === 127
    );
  if (
    value.trim() !== value
    || url.protocol !== 'http:'
    || !loopback
    || authority.includes('@')
    || url.username
    || url.password
    || url.search
    || url.hash
    || !['', '/'].includes(url.pathname)
  ) {
    throw invalidApiBase();
  }
  return url.origin;
}

function invalidApiBase(): SessionKernelProviderTransportError {
  return new SessionKernelProviderTransportError(
    'session_kernel_provider_api_base_invalid',
    'Provider transport requires an absolute loopback HTTP origin.'
  );
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null
): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // The HTTP/status error remains authoritative.
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utf8PrefixLength(value: string, maximumBytes: number): number {
  let prefixLength = 0;
  let byteLength = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    const scalarBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (byteLength + scalarBytes > maximumBytes) break;
    byteLength += scalarBytes;
    prefixLength += scalar.length;
  }
  return prefixLength;
}

export class SessionKernelProviderTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus?: number,
    readonly structuredFailure?: SessionProviderStructuredOutputFailureV1,
    readonly providerUsage?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SessionKernelProviderTransportError';
  }
}
