import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  AGENT_TIMELINE_READABLE_PLAN_SCHEMA_V2,
} from '@deepcode/protocol';
import type {
  AgentEvent,
  AgentEventChannel,
  AgentEventKind,
  AgentEventVisibility,
  AgentTimelineDelta,
  AgentTimelineResult,
} from '@deepcode/protocol';
import {
  CanonicalTimelineProjector,
  createProviderComposingTimelineDelta,
  normalizeAgentTimelineSnapshot,
} from '../timelineDelta.js';
import {
  appendProviderComposingProjectionV3,
} from '../projectionV2.js';
import type {
  SessionKernelHostProjectionSinkV2,
} from './SessionKernelHttpPersistenceV2.js';
import type {
  SessionKernelProjectionDeliveryOptionsV2,
  SessionKernelProjectionReceiptV2,
} from './ports.js';
import type {
  SessionKernelProjectionEventV2,
} from './types.js';
import type {
  SessionKernelTransportPrivateAuthV2,
} from './SessionKernelPortV2.js';
import type {
  SessionPriorEventsSourceV2,
} from './sessionMemory.js';
import {
  decodeSessionPriorAgentEventV2,
} from './sessionMemory.js';
import {
  boundedProviderUsageRecordV2,
} from './providerStreamV1.js';

export const SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA =
  'deepcode.session.kernel-host-projection-request.v2' as const;
export const SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA =
  'deepcode.session.kernel-host-projection-reply.v2' as const;
export const SESSION_KERNEL_PUBLIC_PROJECTION_V2_SCHEMA =
  'deepcode.session.kernel-public-projection.v2' as const;
export const HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA =
  'deepcode.host.session-prior-events-page.v2' as const;
const MAX_PROJECTION_REQUEST_UTF8_BYTES = 16 * 1024 * 1024;
const MAX_PRIOR_EVENTS_PAGE_COUNT = 128;
const MAX_PRIOR_EVENTS_PAGE_UTF8_BYTES = 1024 * 1024;
const MAX_PRIOR_EVENTS_SINGLE_EVENT_PAGE_UTF8_BYTES =
  8 * 1024 * 1024;
const DEFAULT_PROJECTION_DELIVERY_DEADLINE_MS = 15_000;

export interface SessionKernelPublicProjectionPayloadV2 {
  schemaVersion: typeof SESSION_KERNEL_PUBLIC_PROJECTION_V2_SCHEMA;
  projectionId: string;
  runId: string;
  projectionKind: SessionKernelProjectionEventV2['kind'];
  channel: AgentEventChannel;
  visibility: AgentEventVisibility;
  status?: string;
  summary?: string;
  [key: string]: unknown;
}

/**
 * Rust Host broker request body for:
 * POST /api/agent/sessions/:sessionId/runs/:hostRunId/kernel-v2/projections
 */
export interface SessionKernelHostProjectionRequestV2 {
  schemaVersion:
    typeof SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA;
  sessionId: string;
  hostRunId: string;
  projectionId: string;
  projectionDigest: string;
  event: SessionKernelProjectionEventV2;
  agentEvent: AgentEvent;
  timelineUpdate:
    | { kind: 'snapshot'; snapshot: AgentTimelineResult }
    | { kind: 'delta'; delta: AgentTimelineDelta };
}

/**
 * The Host applies projectionId+projectionDigest idempotently. A repeated
 * projectionId with different content must return HTTP 409.
 */
export interface SessionKernelHostProjectionReplyV2 {
  schemaVersion:
    typeof SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA;
  projectionId: string;
  projectionDigest: string;
  replayed: boolean;
}

interface HostSessionPriorEventsPageV2 {
  schemaVersion: typeof HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA;
  sessionId: string;
  hostRunId: string;
  runId: string;
  sourceEventVersion: number;
  sourceEventsDigest: string;
  snapshotDigest: string;
  startEventIndex: number;
  endEventIndexExclusive: number;
  eventCount: number;
  events: AgentEvent[];
  eventsDigest: string;
  nextContinuation: string | null;
  pageDigest: string;
}

interface PreparedHostProjectionV2 {
  projectionId: string;
  eventDigest: string;
  request: SessionKernelHostProjectionRequestV2;
  timeline: AgentTimelineResult;
}

export class HttpSessionKernelHostProjectionSinkV2
implements SessionKernelHostProjectionSinkV2 {
  private readonly endpoint: string;
  private readonly priorEventsEndpoint: string;
  private readonly priorTimelineEndpoint: string;
  readonly #runCapability: string;
  private fullPriorSessionEvents?: Promise<AgentEvent[]>;
  private frozenPriorTimeline?: Promise<AgentTimelineResult | undefined>;
  private currentTimeline?: AgentTimelineResult;
  private publicationTail: Promise<void> = Promise.resolve();
  private lastPublished?: {
    projectionId: string;
    eventDigest: string;
    request: SessionKernelHostProjectionRequestV2;
    timeline: AgentTimelineResult;
  };

  constructor(
    private readonly sessionId: string,
    private readonly hostRunId: string,
    private readonly runId: string,
    private readonly priorSessionEvents: SessionPriorEventsSourceV2,
    apiBase: string,
    privateAuth: SessionKernelTransportPrivateAuthV2,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    requiredIdentity(sessionId, 'sessionId');
    requiredIdentity(hostRunId, 'hostRunId');
    requiredIdentity(runId, 'runId');
    if (
      priorSessionEvents.sessionId !== sessionId
      || priorSessionEvents.selectedEventCount
        !== priorSessionEvents.events.length
      || priorSessionEvents.selectedEventCount
        + priorSessionEvents.omittedEventCount
        !== priorSessionEvents.sourceEventVersion
    ) {
      throw new SessionKernelProjectionTransportError(
        'session_kernel_projection_prefix_invalid',
        'Session projection prefix does not match the immutable Run bootstrap.'
      );
    }
    this.#runCapability = requiredIdentity(
      privateAuth.runCapability,
      'runCapability'
    );
    this.endpoint = [
      normalizeApiBase(apiBase),
      'api/agent/sessions',
      encodeURIComponent(sessionId),
      'runs',
      encodeURIComponent(hostRunId),
      'kernel-v2/projections',
    ].join('/');
    this.priorEventsEndpoint = [
      normalizeApiBase(apiBase),
      'api/agent/sessions',
      encodeURIComponent(sessionId),
      'runs',
      encodeURIComponent(hostRunId),
      'kernel-v2/prior-events',
    ].join('/');
    this.priorTimelineEndpoint = [
      normalizeApiBase(apiBase),
      'api/agent/sessions',
      encodeURIComponent(sessionId),
      'timeline',
    ].join('/');
  }

  async publish(
    event: SessionKernelProjectionEventV2,
    projectionHistory: () => Promise<SessionKernelProjectionEventV2[]>,
    options?: SessionKernelProjectionDeliveryOptionsV2
  ): Promise<SessionKernelProjectionReceiptV2> {
    const publication = this.publicationTail.then(() =>
      this.publishSerial(event, projectionHistory, options)
    );
    this.publicationTail = publication.then(
      () => undefined,
      () => undefined
    );
    return publication;
  }

  private async publishSerial(
    event: SessionKernelProjectionEventV2,
    projectionHistory: () => Promise<SessionKernelProjectionEventV2[]>,
    options?: SessionKernelProjectionDeliveryOptionsV2
  ): Promise<SessionKernelProjectionReceiptV2> {
    const delivery = projectionDeliveryAbortScope(options);
    try {
      const projectionId = requiredIdentity(
        event.projectionId,
        'projectionId'
      );
      const eventDigest = sha256Hash(canonicalJson(event));
      const replay = this.lastPublished?.projectionId === projectionId
        ? this.lastPublished
        : undefined;
      if (replay) {
        if (replay.eventDigest !== eventDigest) {
          throw new SessionKernelProjectionTransportError(
            'session_kernel_projection_identity_conflict',
            'Session projection identity was reused with different content.'
          );
        }
        const receipt = await this.sendProjectionRequest(
          replay.request,
          delivery.signal
        );
        this.currentTimeline = cloneJson(replay.timeline);
        return receipt;
      }
      const prepared = await this.prepareProjectionRequest(
        event,
        projectionHistory,
        delivery.signal
      );
      const receipt = await this.sendProjectionRequest(
        prepared.request,
        delivery.signal
      );
      this.commitPreparedProjection(prepared);
      return receipt;
    } finally {
      delivery.dispose();
    }
  }

  private async prepareProjectionRequest(
    event: SessionKernelProjectionEventV2,
    projectionHistory: () => Promise<SessionKernelProjectionEventV2[]>,
    signal: AbortSignal
  ): Promise<PreparedHostProjectionV2> {
    assertNoTransportCapabilities(event);
    const projectionId = requiredIdentity(
      event.projectionId,
      'projectionId'
    );
    const eventDigest = sha256Hash(canonicalJson(event));
    const agentEvent = sessionKernelAgentEventV2(
      this.sessionId,
      event
    );
    let timeline: AgentTimelineResult;
    let timelineUpdate:
      SessionKernelHostProjectionRequestV2['timelineUpdate'];
    if (event.kind === 'provider.composing' && this.currentTimeline) {
      timeline = appendProviderComposingProjectionV3(
        this.currentTimeline,
        agentEvent
      );
      timelineUpdate = {
        kind: 'delta',
        delta: createProviderComposingTimelineDelta(
          this.currentTimeline,
          timeline
        ),
      };
    } else {
      const currentRunProjectionHistory = await projectionHistory();
      const currentRunAgentEvents = currentRunProjectionHistory.map(
        (projection) =>
          sessionKernelAgentEventV2(this.sessionId, projection)
      );
      const [priorEvents, priorTimeline] = await Promise.all([
        this.priorEventsForProjection(signal),
        this.priorTimelineForProjection(signal),
      ]);
      const agentEvents = [
        ...priorEvents,
        ...currentRunAgentEvents,
      ];
      const sourceEventVersion =
        this.priorSessionEvents.sourceEventVersion
        + currentRunAgentEvents.length;
      if (!Number.isSafeInteger(sourceEventVersion)) {
        throw new SessionKernelProjectionTransportError(
          'session_kernel_projection_version_exhausted',
          'Session projection source-event version is exhausted.'
        );
      }
      const projected = priorTimeline
        ? appendCurrentRunProjection(
            priorTimeline,
            new CanonicalTimelineProjector(
              this.sessionId,
              currentRunAgentEvents
            ).snapshot(),
            sourceEventVersion,
            event.recordedAt
          )
        : new CanonicalTimelineProjector(
            this.sessionId,
            agentEvents
          ).snapshot();
      timeline = {
        ...projected,
        revision: sourceEventVersion,
        sourceEventVersion,
        generatedAt: event.recordedAt,
      };
      if (
        agentEvents.at(-1)?.id !== agentEvent.id
        || timeline.sessionId !== this.sessionId
        || timeline.eventCount !== agentEvents.length
        || timeline.sourceEventVersion !== sourceEventVersion
      ) {
        throw new SessionKernelProjectionTransportError(
          'session_kernel_timeline_snapshot_identity_mismatch',
          'Canonical timeline does not end at the current durable AgentEvent high-water.'
        );
      }
      timelineUpdate = { kind: 'snapshot', snapshot: timeline };
    }
    const projectionDigest = sha256Hash(canonicalJson({
      event,
      agentEvent,
      timeline,
    }));
    const request: SessionKernelHostProjectionRequestV2 = {
      schemaVersion:
        SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA,
      sessionId: this.sessionId,
      hostRunId: this.hostRunId,
      projectionId,
      projectionDigest,
      event: cloneJson(event),
      agentEvent,
      timelineUpdate,
    };
    assertNoTransportCapabilities(request);
    return {
      projectionId,
      eventDigest,
      request,
      timeline,
    };
  }

  private commitPreparedProjection(
    prepared: PreparedHostProjectionV2
  ): void {
    this.currentTimeline = cloneJson(prepared.timeline);
    this.lastPublished = {
      projectionId: prepared.projectionId,
      eventDigest: prepared.eventDigest,
      request: cloneJson(prepared.request),
      timeline: cloneJson(prepared.timeline),
    };
  }

  private async sendProjectionRequest(
    request: SessionKernelHostProjectionRequestV2,
    signal: AbortSignal
  ): Promise<SessionKernelProjectionReceiptV2> {
    const { projectionId, projectionDigest } = request;
    const encodedRequest = JSON.stringify(request);
    if (
      new TextEncoder().encode(encodedRequest).byteLength
        > MAX_PROJECTION_REQUEST_UTF8_BYTES
    ) {
      throw new SessionKernelProjectionTransportError(
        'session_kernel_projection_limit_exceeded',
        'Session v2 projection request exceeds the Host transport limit.'
      );
    }
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-deepcode-run-capability': this.#runCapability,
      },
      body: encodedRequest,
      signal,
    });
    if (!response.ok) {
      const failure = await projectionHttpFailure(
        response,
        projectionId
      );
      throw new SessionKernelProjectionTransportError(
        failure.code,
        failure.message,
        failure.retryable
      );
    }
    const rawReply: unknown = await response.json();
    let envelope: Record<string, unknown>;
    try {
      envelope = exactObject(rawReply, ['ok', 'data']);
    } catch {
      throw invalidProjectionReply(
        projectionReplyShapeDiagnostic(
          rawReply,
          projectionId,
          projectionDigest
        )
      );
    }
    if (envelope.ok !== true) {
      throw invalidProjectionReply(
        projectionReplyShapeDiagnostic(
          rawReply,
          projectionId,
          projectionDigest
        )
      );
    }
    let data: Record<string, unknown>;
    try {
      data = exactObject(
        envelope.data,
        [
          'schemaVersion',
          'projectionId',
          'projectionDigest',
          'replayed',
        ]
      );
    } catch {
      throw invalidProjectionReply(
        projectionReplyShapeDiagnostic(
          rawReply,
          projectionId,
          projectionDigest
        )
      );
    }
    if (
      data.schemaVersion
        !== SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA
      || data.projectionId !== projectionId
      || data.projectionDigest !== projectionDigest
      || typeof data.replayed !== 'boolean'
    ) {
      throw invalidProjectionReply(
        projectionReplyShapeDiagnostic(
          rawReply,
          projectionId,
          projectionDigest
        )
      );
    }
    return {
      projectionId,
      projectionDigest,
      delivered: true,
    };
  }

  private priorEventsForProjection(signal: AbortSignal): Promise<AgentEvent[]> {
    if (this.priorSessionEvents.omittedEventCount === 0) {
      return Promise.resolve(
        cloneJson(this.priorSessionEvents.events)
      );
    }
    if (!this.fullPriorSessionEvents) {
      const loading = this.fetchFrozenPriorEvents(signal);
      const recoverable = loading.catch((error: unknown) => {
        if (this.fullPriorSessionEvents === recoverable) {
          this.fullPriorSessionEvents = undefined;
        }
        throw error;
      });
      this.fullPriorSessionEvents = recoverable;
    }
    return this.fullPriorSessionEvents.then(cloneJson);
  }

  private priorTimelineForProjection(signal: AbortSignal):
  Promise<AgentTimelineResult | undefined> {
    if (this.priorSessionEvents.sourceEventVersion === 0) {
      return Promise.resolve(undefined);
    }
    if (!this.frozenPriorTimeline) {
      const loading = this.fetchFrozenPriorTimeline(signal);
      const recoverable = loading.catch((error: unknown) => {
        if (this.frozenPriorTimeline === recoverable) {
          this.frozenPriorTimeline = undefined;
        }
        throw error;
      });
      this.frozenPriorTimeline = recoverable;
    }
    return this.frozenPriorTimeline.then(cloneJson);
  }

  private async fetchFrozenPriorTimeline(signal: AbortSignal):
  Promise<AgentTimelineResult> {
    const response = await this.fetchImpl(this.priorTimelineEndpoint, {
      method: 'GET',
      headers: {
        'x-deepcode-run-id': this.runId,
        'x-deepcode-run-capability': this.#runCapability,
      },
      signal,
    });
    if (!response.ok) {
      throw new SessionKernelProjectionTransportError(
        'host_session_prior_timeline_http_failed',
        `Prior Session timeline read failed with HTTP ${response.status}.`
      );
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = exactObject(
        await response.json(),
        ['ok', 'data', 'error', 'message']
      );
    } catch {
      throw new SessionKernelProjectionTransportError(
        'host_session_prior_timeline_response_invalid',
        'Prior Session timeline returned an invalid Host response.'
      );
    }
    if (envelope.ok !== true) {
      const code = typeof envelope.error === 'string'
        ? envelope.error
        : undefined;
      throw new SessionKernelProjectionTransportError(
        code === 'UnsupportedHistorySchema'
          ? 'UnsupportedHistorySchema'
          : 'host_session_prior_timeline_unavailable',
        code === 'UnsupportedHistorySchema'
          ? 'Prior Session history uses an unsupported schema.'
          : 'Prior Session timeline is unavailable.'
      );
    }
    if (envelope.error !== null || envelope.message !== null) {
      throw new SessionKernelProjectionTransportError(
        'host_session_prior_timeline_response_invalid',
        'Successful prior Session timeline response contains an error.'
      );
    }
    let timeline: AgentTimelineResult;
    try {
      timeline = normalizeAgentTimelineSnapshot(envelope.data);
    } catch (error) {
      const code = objectRecord(error)?.code;
      throw new SessionKernelProjectionTransportError(
        code === 'UnsupportedHistorySchema'
          ? 'UnsupportedHistorySchema'
          : 'host_session_prior_timeline_invalid',
        code === 'UnsupportedHistorySchema'
          ? 'Prior Session history uses an unsupported schema.'
          : 'Prior Session timeline failed native projection validation.'
      );
    }
    if (
      timeline.sessionId !== this.sessionId
      || timeline.sourceEventVersion
        !== this.priorSessionEvents.sourceEventVersion
      || timeline.eventCount
        !== this.priorSessionEvents.sourceEventVersion
    ) {
      throw new SessionKernelProjectionTransportError(
        'host_session_prior_timeline_identity_mismatch',
        'Prior Session timeline does not match the frozen event prefix.'
      );
    }
    return timeline;
  }

  private async fetchFrozenPriorEvents(
    signal: AbortSignal
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    let continuation: string | null = null;
    do {
      const endpoint = continuation === null
        ? this.priorEventsEndpoint
        : `${this.priorEventsEndpoint}?continuation=${
          encodeURIComponent(continuation)
        }`;
      const response = await this.fetchImpl(endpoint, {
        method: 'GET',
        headers: {
          'x-deepcode-run-capability': this.#runCapability,
        },
        signal,
      });
      if (!response.ok) {
        const failure = await priorEventsHttpFailure(response);
        throw new SessionKernelProjectionTransportError(
          failure.code,
          failure.message
        );
      }
      const envelope = exactObject(
        await response.json(),
        ['ok', 'data']
      );
      if (envelope.ok !== true) {
        throw invalidPriorEventsReply();
      }
      const page = decodePriorEventsPage(
        envelope.data,
        this.sessionId,
        this.hostRunId,
        this.runId,
        this.priorSessionEvents,
        events.length
      );
      events.push(...page.events);
      continuation = page.nextContinuation;
      if (
        continuation !== null
        && events.length >= this.priorSessionEvents.sourceEventVersion
      ) {
        throw invalidPriorEventsReply();
      }
    } while (continuation !== null);
    if (
      events.length !== this.priorSessionEvents.sourceEventVersion
      || sha256Hash(canonicalJson(events))
        !== this.priorSessionEvents.sourceEventsDigest
    ) {
      throw invalidPriorEventsReply();
    }
    const suffix = events.slice(
      events.length - this.priorSessionEvents.selectedEventCount
    );
    if (
      sha256Hash(canonicalJson(suffix))
        !== this.priorSessionEvents.eventsDigest
      || canonicalJson(suffix)
        !== canonicalJson(this.priorSessionEvents.events)
    ) {
      throw invalidPriorEventsReply();
    }
    return events;
  }
}

function appendCurrentRunProjection(
  history: AgentTimelineResult,
  current: AgentTimelineResult,
  sourceEventVersion: number,
  generatedAt: string
): AgentTimelineResult {
  const historyRun = history.runProjection;
  if (
    historyRun
    && (
      historyRun.phase !== 'settled'
      || (
        historyRun.status !== 'succeeded'
        && historyRun.status !== 'failed'
        && historyRun.status !== 'cancelled'
      )
    )
  ) {
    throw new SessionKernelProjectionTransportError(
      'UnsupportedHistorySchema',
      'Only settled prior Session history can be extended.'
    );
  }
  if (
    history.eventCount + current.eventCount !== sourceEventVersion
    || history.sourceEventVersion + current.sourceEventVersion
      !== sourceEventVersion
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_timeline_prefix_mismatch',
      'Current Run projection does not extend the frozen Session prefix.'
    );
  }
  const turnIds = new Set(history.turns.map((turn) => turn.id));
  if (current.turns.some((turn) => turnIds.has(turn.id))) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_timeline_turn_identity_conflict',
      'Current Run projection reuses a prior Session turn identity.'
    );
  }
  const tokenUsageProjection = mergeTimelineTokenUsage(
    history.tokenUsageProjection,
    current.tokenUsageProjection
  );
  const timeline: AgentTimelineResult = {
    schemaVersion: current.schemaVersion,
    shapeVersion: current.shapeVersion,
    sessionId: current.sessionId,
    revision: sourceEventVersion,
    sourceEventVersion,
    generatedAt,
    turns: [
      ...history.turns,
      ...current.turns.map((turn, sequence) => ({
        ...turn,
        sequence: history.turns.length + sequence,
      })),
    ],
    eventCount: sourceEventVersion,
    ...(current.taskProjection
      ? { taskProjection: current.taskProjection }
      : {}),
    ...(current.interactionProjection
      ? { interactionProjection: current.interactionProjection }
      : {}),
    ...(current.runProjection
      ? { runProjection: current.runProjection }
      : {}),
    ...(tokenUsageProjection ? { tokenUsageProjection } : {}),
    ...(current.workspaceProjection ?? history.workspaceProjection
      ? {
          workspaceProjection:
            current.workspaceProjection
            ?? history.workspaceProjection!,
        }
      : {}),
  };
  return normalizeAgentTimelineSnapshot(timeline);
}

function mergeTimelineTokenUsage(
  history: AgentTimelineResult['tokenUsageProjection'],
  current: AgentTimelineResult['tokenUsageProjection']
): AgentTimelineResult['tokenUsageProjection'] {
  const requests = [
    ...(history?.requests ?? []),
    ...(current?.requests ?? []),
  ];
  if (requests.length === 0) return undefined;
  const requestIds = new Set<string>();
  for (const request of requests) {
    if (requestIds.has(request.requestId)) {
      throw new SessionKernelProjectionTransportError(
        'session_kernel_timeline_usage_identity_conflict',
        'Provider usage request identity is not unique across Session history.'
      );
    }
    requestIds.add(request.requestId);
  }
  const numericFields = [
    'promptCacheHitTokens',
    'promptCacheMissTokens',
    'cachedTokens',
    'promptTokens',
    'completionTokens',
    'totalTokens',
  ] as const;
  const totals = Object.fromEntries(
    numericFields.map((field) => [
      field,
      requests.reduce((sum, request) => {
        const next = sum + request[field];
        if (!Number.isSafeInteger(next) || next < 0) {
          throw new SessionKernelProjectionTransportError(
            'session_kernel_timeline_usage_overflow',
            'Provider usage total exceeds the safe integer boundary.'
          );
        }
        return next;
      }, 0),
    ])
  ) as Pick<
    NonNullable<
      AgentTimelineResult['tokenUsageProjection']
    >['totals'],
    typeof numericFields[number]
  >;
  return {
    requests,
    totals: {
      ...totals,
      providerCallCount: requests.length,
      providers: [...new Set(
        requests.flatMap((request) => request.providers)
      )].sort(),
    },
  };
}

async function projectionHttpFailure(
  response: Response,
  projectionId: string
): Promise<{ code: string; message: string; retryable: boolean }> {
  const retryable = response.status === 408
    || response.status === 425
    || response.status === 429
    || response.status >= 500;
  try {
    const envelope = objectRecord(await response.json());
    const nestedError = objectRecord(envelope?.error);
    const code = nestedError?.code
      ?? (typeof envelope?.error === 'string'
        ? envelope.error
        : undefined);
    const message = nestedError?.message ?? envelope?.message;
    if (
      envelope?.ok === false
      && typeof code === 'string'
      && /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(code)
      && typeof message === 'string'
      && message.length > 0
      && new TextEncoder().encode(message).byteLength <= 8_192
    ) {
      return { code, message, retryable };
    }
  } catch {
    // Preserve a typed local transport failure for non-v2 Host responses.
  }
  return response.status === 409
    ? {
        code: 'session_kernel_projection_identity_conflict',
        message: `Projection ${projectionId} conflicts with Host content.`,
        retryable: false,
      }
    : {
        code: 'session_kernel_projection_http_failed',
        message:
          `Session v2 projection failed with HTTP ${response.status}.`,
        retryable,
      };
}

async function priorEventsHttpFailure(
  response: Response
): Promise<{ code: string; message: string }> {
  try {
    const envelope = objectRecord(await response.json());
    const error = objectRecord(envelope?.error);
    const code = error?.code;
    const message = error?.message;
    if (
      envelope?.ok === false
      && typeof code === 'string'
      && /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(code)
      && typeof message === 'string'
      && message.length > 0
      && new TextEncoder().encode(message).byteLength <= 8_192
    ) {
      return { code, message };
    }
  } catch {
    // Preserve a typed local transport failure when Host returned no JSON.
  }
  return {
    code: 'host_session_prior_events_http_failed',
    message:
      `Prior Session event read failed with HTTP ${response.status}.`,
  };
}

function decodePriorEventsPage(
  value: unknown,
  expectedSessionId: string,
  expectedHostRunId: string,
  expectedRunId: string,
  frozen: SessionPriorEventsSourceV2,
  expectedStartEventIndex: number
): HostSessionPriorEventsPageV2 {
  assertNoTransportCapabilities(value);
  const record = exactObject(value, [
    'schemaVersion',
    'sessionId',
    'hostRunId',
    'runId',
    'sourceEventVersion',
    'sourceEventsDigest',
    'snapshotDigest',
    'startEventIndex',
    'endEventIndexExclusive',
    'eventCount',
    'events',
    'eventsDigest',
    'nextContinuation',
    'pageDigest',
  ]);
  const sessionId = requiredIdentity(record.sessionId, 'sessionId');
  const hostRunId = requiredIdentity(record.hostRunId, 'hostRunId');
  const runId = requiredIdentity(record.runId, 'runId');
  const sourceEventVersion = projectionCount(
    record.sourceEventVersion
  );
  const sourceEventsDigest = projectionDigest(
    record.sourceEventsDigest
  );
  const snapshotDigest = projectionDigest(record.snapshotDigest);
  const startEventIndex = projectionCount(record.startEventIndex);
  const endEventIndexExclusive = projectionCount(
    record.endEventIndexExclusive
  );
  const eventCount = projectionCount(record.eventCount);
  if (
    record.schemaVersion !== HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA
    || sessionId !== expectedSessionId
    || hostRunId !== expectedHostRunId
    || runId !== expectedRunId
    || sourceEventVersion !== frozen.sourceEventVersion
    || sourceEventsDigest !== frozen.sourceEventsDigest
    || snapshotDigest !== frozen.snapshotDigest
    || startEventIndex !== expectedStartEventIndex
    || endEventIndexExclusive
      !== startEventIndex + eventCount
    || endEventIndexExclusive > sourceEventVersion
    || (
      startEventIndex < sourceEventVersion
      && eventCount === 0
    )
    || eventCount > MAX_PRIOR_EVENTS_PAGE_COUNT
    || !Array.isArray(record.events)
    || record.events.length !== eventCount
  ) {
    throw invalidPriorEventsReply();
  }
  const events = record.events.map((event) =>
    decodeSessionPriorAgentEventV2(event, expectedSessionId)
  );
  const encodedEventsBytes =
    new TextEncoder().encode(canonicalJson(events)).byteLength;
  if (
    encodedEventsBytes > MAX_PRIOR_EVENTS_PAGE_UTF8_BYTES
    && (
      eventCount !== 1
      || encodedEventsBytes
        > MAX_PRIOR_EVENTS_SINGLE_EVENT_PAGE_UTF8_BYTES
    )
  ) {
    throw invalidPriorEventsReply();
  }
  const eventsDigest = projectionDigest(record.eventsDigest);
  if (eventsDigest !== sha256Hash(canonicalJson(events))) {
    throw invalidPriorEventsReply();
  }
  const nextContinuation = record.nextContinuation === null
    ? null
    : requiredIdentity(
        record.nextContinuation,
        'nextContinuation'
      );
  if (
    (endEventIndexExclusive < sourceEventVersion)
      !== (nextContinuation !== null)
  ) {
    throw invalidPriorEventsReply();
  }
  const pageDigest = projectionDigest(record.pageDigest);
  const withoutPageDigest = {
    schemaVersion: HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA,
    sessionId,
    hostRunId,
    runId,
    sourceEventVersion,
    sourceEventsDigest,
    snapshotDigest,
    startEventIndex,
    endEventIndexExclusive,
    eventCount,
    events,
    eventsDigest,
    nextContinuation,
  };
  if (pageDigest !== sha256Hash(canonicalJson(withoutPageDigest))) {
    throw invalidPriorEventsReply();
  }
  return {
    ...withoutPageDigest,
    pageDigest,
  };
}

/**
 * Session owns the semantic UI projection. Host persists and publishes this
 * AgentEvent unchanged; it must not infer Plan, permission, tool, or Review
 * meaning from the private kernel-v2 event.
 */
export function sessionKernelAgentEventV2(
  sessionId: string,
  event: SessionKernelProjectionEventV2
): AgentEvent {
  const data = currentProjectionData(event);
  const presentation = publicPresentation(event, data);
  return {
    id: `kernel-v2:${event.projectionId}`,
    sessionId,
    ts: event.recordedAt,
    kind: presentation.kind,
    payload: {
      schemaVersion: SESSION_KERNEL_PUBLIC_PROJECTION_V2_SCHEMA,
      projectionId: event.projectionId,
      runId: event.runId,
      projectionKind: event.kind,
      channel: presentation.channel,
      visibility: presentation.visibility,
      ...presentation.fields,
    } satisfies SessionKernelPublicProjectionPayloadV2,
  };
}

function publicPresentation(
  event: SessionKernelProjectionEventV2,
  data: Record<string, unknown> | undefined
): {
  kind: AgentEventKind;
  channel: AgentEventChannel;
  visibility: AgentEventVisibility;
  fields: Record<string, unknown>;
} {
  switch (event.kind) {
    case 'input.persisted':
      return {
        kind: 'user_msg',
        channel: 'user',
        visibility: 'conversation',
        fields: {
          content: textField(data, 'text') ?? '',
          inputId: textField(data, 'inputId'),
          attachments: Array.isArray(data?.attachments)
            ? cloneJson(data.attachments)
            : [],
          controlEpoch: data?.controlEpoch,
        },
      };
    case 'plan.persisted':
      return {
        kind: 'workflow_stage',
        channel: 'progress',
        visibility: 'trace',
        fields: {
          planRevision: textField(data, 'planRevision'),
          status: 'running',
          summary: 'Plan persisted; canonical scope confirmation is pending.',
        },
      };
    case 'plan.decided': {
      const decision = textField(data, 'decision');
      const status = decision === 'accept'
        ? 'accepted'
        : decision === 'reject'
          ? 'rejected'
          : 'needsRevision';
      return {
        kind: 'plan_review',
        channel: decision === 'accept' ? 'progress' : 'task',
        visibility: 'both',
        fields: {
          planId: textField(data, 'planRevision'),
          planRevision: textField(data, 'planRevision'),
          status,
          decision,
          guidance: textField(data, 'guidance'),
          confirmable: false,
          summary: decision === 'accept'
            ? 'Plan accepted for scoped execution.'
            : decision === 'reject'
              ? 'Plan rejected; planned actions remain unexecuted.'
              : 'Plan revision requested; guidance recorded.',
        },
      };
    }
    case 'plan.commentaryReleased': {
      const orderedItems = publicOrderedProviderItems(
        data?.orderedItems
      );
      if (
        orderedItems.length === 0
        || orderedItems.some((item) =>
          item.kind !== 'text' || item.phase !== 'commentary'
        )
      ) {
        throw new SessionKernelProjectionTransportError(
          'session_kernel_plan_commentary_invalid',
          'Released Plan commentary must contain only sealed commentary text.'
        );
      }
      return {
        kind: 'assistant_msg',
        channel: 'progress',
        visibility: 'conversation',
        fields: {
          status: 'completed',
          planRevision: textField(data, 'planRevision'),
          providerTurnId: textField(data, 'providerTurnId'),
          controlEpoch: data?.controlEpoch,
          orderedItems,
        },
      };
    }
    case 'plan.confirmationReady':
      return planConfirmationReadyPresentation(event, data);
    case 'scope.previewed':
      if (data?.kind === 'rejected') {
        return rejectedPlanScopePresentation(data);
      }
      return planScopePreviewPresentation(event, data);
    case 'capability.awaiting':
      return permissionRequestPresentation(data);
    case 'toolIntent.submitted':
      return {
        kind: 'tool_call',
        channel: 'tool',
        visibility: 'both',
        fields: {
          status: textField(data, 'replyKind') ?? 'submitted',
          operationId: textField(data, 'operationId'),
          invocationId: textField(data, 'invocationId'),
          requestId: textField(data, 'requestId'),
          toolId: textField(data, 'toolId'),
          replyReason: textField(data, 'replyReason'),
          controlEpoch: data?.expectedControlEpoch,
          authorityKind: textField(data, 'authorityKind'),
          planRevision: textField(data, 'planRevision'),
          planActionId: textField(data, 'planActionId'),
          summary: 'Kernel tool intent submitted.',
        },
      };
    case 'kernelFacts.reconciled':
      return {
        kind: 'tool_result',
        channel: 'observation',
        visibility: 'trace',
        fields: {
          status: 'reconciled',
          factIds: Array.isArray(data?.pageFactIds)
            ? cloneJson(data.pageFactIds)
            : [],
          operationFacts: Array.isArray(data?.operationFacts)
            ? cloneJson(data.operationFacts)
            : [],
          snapshotHighWater: data?.snapshotHighWater,
          summary: 'Canonical Kernel facts reconciled.',
        },
      };
    case 'authorization.decided': {
      const factKind = textField(data, 'factKind');
      const allowed = factKind === 'capabilityIssued'
        || factKind === 'expansionAllowed';
      const lease = objectRecord(data?.capabilityLease);
      const previewId = textField(data, 'previewId');
      return {
        kind: 'permission_result',
        channel: 'tool',
        visibility: 'conversation',
        fields: {
          id: previewId,
          permissionId: previewId,
          previewId,
          status: allowed ? 'allowed' : 'denied',
          decision: allowed ? 'allow' : 'deny',
          factId: textField(data, 'factId'),
          factKind,
          operationId: textField(data, 'operationId'),
          toolId: textField(data, 'toolId'),
          planActionIds: Array.isArray(data?.planActionIds)
            ? cloneJson(data.planActionIds)
            : [],
          leaseId: textField(lease, 'leaseId'),
          leaseVersion: lease?.version,
          scopeDigest: textField(lease, 'scopeDigest'),
          scopeDelta: data?.scopeDelta === undefined
            ? undefined
            : cloneJson(data.scopeDelta),
          guidance: textField(data, 'guidance'),
          details: data?.details === undefined
            ? undefined
            : cloneJson(data.details),
          summary: allowed
            ? 'Canonical Kernel scope authorization recorded.'
            : 'Canonical Kernel scope denial recorded.',
        },
      };
    }
    case 'review.revised':
      return {
        kind: 'review_summary',
        channel: 'final',
        visibility: 'both',
        fields: {
          reviewId: `kernel-v2-review:${String(data?.revision ?? 'unknown')}`,
          status: 'completed',
          revision: data?.revision,
          snapshotHighWater: data?.snapshotHighWater,
          summary: 'Review finalized from canonical Kernel facts.',
          review: cloneJson(event.data),
        },
      };
    case 'userIntervention.changed':
      return userInterventionPresentation(data);
    case 'planAction.completed':
      return {
        kind: 'workflow_stage',
        channel: 'task',
        visibility: 'both',
        fields: {
          status: 'completed',
          planRevision: textField(data, 'planRevision'),
          planActionId: textField(data, 'planActionId'),
          controlEpoch: data?.controlEpoch,
          providerTurnId: textField(data, 'providerTurnId'),
          outcome: textField(data, 'outcome'),
          snapshotHighWater: data?.snapshotHighWater,
          summary: 'Plan action settled by explicit Session control.',
        },
      };
    case 'provider.composing':
      return providerComposingPresentation(data);
    case 'provider.completed': {
      const result = objectRecord(data?.result);
      const outputKind = textField(data, 'outputKind');
      const providerTurnId = requiredIdentity(
        data?.providerTurnId,
        'providerTurnId'
      );
      const controlEpoch = positiveSafeInteger(
        data?.controlEpoch,
        'controlEpoch'
      );
      const decodedOrderedItems = publicOrderedProviderItems(
        data?.orderedItems
      );
      const orderedItems = outputKind === 'plan'
        || outputKind === 'planEvidenceRefresh'
        ? []
        : decodedOrderedItems;
      const terminalScope = publicTerminalScope(data);
      if (terminalScope === undefined) {
        throw new SessionKernelProjectionTransportError(
          'session_kernel_projection_terminal_scope_missing',
          'Session Provider completion requires an explicit terminal scope.'
        );
      }
      if (
        terminalScope === 'turn'
        && (outputKind !== 'answer' || result?.kind !== 'answer')
      ) {
        throw new SessionKernelProjectionTransportError(
          'session_kernel_projection_terminal_scope_conflict',
          'Only a Provider answer may terminate the public user turn.'
        );
      }
      if (terminalScope === 'providerTurn' && outputKind === undefined) {
        throw new SessionKernelProjectionTransportError(
          'session_kernel_projection_terminal_scope_conflict',
          'A Provider-turn completion requires an explicit output kind.'
        );
      }
      const terminalAnswer = result?.kind === 'answer'
        && terminalScope === 'turn';
      const answerState = textField(data, 'answerState');
      const terminalAnswerText = terminalAnswer
        ? exactTerminalAnswerText(result, decodedOrderedItems)
        : undefined;
      return {
        kind: terminalAnswer
          ? 'assistant_msg'
          : 'workflow_stage',
        channel: terminalAnswer
          ? 'final'
          : 'progress',
        visibility: 'conversation',
        fields: {
          status: 'completed',
          ...(orderedItems.length === 0 && terminalAnswer
            ? { content: terminalAnswerText }
            : {}),
          ...(orderedItems.length > 0 ? { orderedItems } : {}),
          ...(terminalScope ? { terminalScope } : {}),
          outputKind,
          ...(answerState ? { answerState } : {}),
          providerTurnId,
          controlEpoch,
          providerOutcome: publicProviderOutcome(data?.providerOutcome),
          ...(data?.reviewRevision === undefined
            ? {}
            : {
                reviewRevision: data.reviewRevision,
                snapshotHighWater: data.snapshotHighWater,
              }),
        },
      };
    }
    case 'provider.answerState':
      return {
        kind: 'workflow_stage',
        channel: 'progress',
        visibility: 'conversation',
        fields: {
          status: 'completed',
          providerTurnId: textField(data, 'providerTurnId'),
          controlEpoch: data?.controlEpoch,
          answerState: textField(data, 'answerState'),
          reasonCode: textField(data, 'reasonCode'),
        },
      };
    case 'provider.started': {
      const currentActivityCode = textField(
        data,
        'currentActivityCode'
      );
      const activitySequence = data?.activitySequence;
      if (
        (
          currentActivityCode !== undefined
          && currentActivityCode !== 'provider.reasoning'
          && currentActivityCode !== 'provider.composing'
        )
        || ((currentActivityCode === undefined)
          !== (activitySequence === undefined))
        || (
          activitySequence !== undefined
          && (
            !Number.isSafeInteger(activitySequence)
            || Number(activitySequence) <= 0
          )
        )
      ) {
        throw new SessionKernelProjectionTransportError(
          'session_kernel_provider_activity_invalid',
          'Provider activity projection is not exact safe metadata.'
        );
      }
      return {
        kind: 'workflow_stage',
        channel: 'progress',
        visibility: 'trace',
        fields: {
          status: 'running',
          providerTurnId: textField(data, 'providerTurnId'),
          controlEpoch: data?.controlEpoch,
          ...(currentActivityCode
            ? {
                currentActivityCode,
              }
            : {}),
          ...(activitySequence === undefined
            ? {}
            : { activitySequence }),
          contextAssembly: data?.contextAssembly === undefined
            ? undefined
            : cloneJson(data.contextAssembly),
          ...(currentActivityCode
            ? {}
            : { summary: 'Session provider turn started.' }),
        },
      };
    }
    case 'provider.stale':
      return {
        kind: 'workflow_stage',
        channel: 'progress',
        visibility: 'trace',
        fields: {
          status: 'cancelled',
          providerTurnId: textField(data, 'providerTurnId'),
          controlEpoch: data?.controlEpoch,
          summary: 'Session provider turn was superseded.',
        },
      };
    case 'run.cancelled':
      return {
        kind: 'session_run_state',
        channel: 'progress',
        visibility: 'conversation',
        fields: {
          status: 'cancelled',
          reason: 'userRequested',
          callerRequestId: textField(data, 'callerRequestId'),
          cancelOperationId: textField(data, 'cancelOperationId'),
          controlEpoch: data?.controlEpoch,
          facts: data?.facts === undefined
            ? undefined
            : cloneJson(data.facts),
          summary: 'Session Run was cancelled after canonical Kernel facts reconciled.',
        },
      };
    case 'wait.changed': {
      const wait = objectRecord(event.data);
      return {
        kind: 'session_run_state',
        channel: 'progress',
        visibility: 'conversation',
        fields: wait
          ? {
              status: 'waiting',
              reason: wait.kind,
              targetId: textField(wait, 'previewId')
                ?? textField(wait, 'invocationId')
                ?? textField(wait, 'operationId'),
              decisionKind: wait.kind === 'capability'
                ? 'permission'
                : undefined,
              summary: `Session is waiting for ${String(wait.kind)}.`,
            }
          : {
              status: 'completed',
              reason: 'waitCleared',
              summary: 'Session wait cleared.',
            },
      };
    }
    case 'diagnostic': {
      const stage = textField(data, 'stage');
      if (stage === 'provider.structuredRepair') {
        return {
          kind: 'workflow_stage',
          channel: 'progress',
          visibility: 'trace',
          fields: {
            status: 'recovering',
            code: textField(data, 'code'),
            providerTurnId: textField(data, 'providerTurnId'),
            currentActivityCode: 'session.validating',
            summary:
              'Validating Provider structured output before retry.',
          },
        };
      }
      if (stage === 'provider.toolCallQueue') {
        const orderedItems = publicOrderedProviderItems(
          data?.orderedItems
        );
        return {
          kind: 'workflow_stage',
          channel: 'progress',
          visibility: 'trace',
          fields: {
            status: textField(data, 'status') ?? 'blocked',
            code: textField(data, 'code')
              ?? 'session_kernel_provider_tool_calls_aborted',
            providerTurnId: textField(data, 'providerTurnId'),
            reason: textField(data, 'reason'),
            ...(orderedItems.length > 0 ? { orderedItems } : {}),
          },
        };
      }
      return {
        kind: 'error',
        channel: 'error',
        visibility: 'conversation',
        fields: {
          status: textField(data, 'status') ?? 'failed',
          code: textField(data, 'code') ?? 'session_kernel_diagnostic',
          providerTurnId: textField(data, 'providerTurnId'),
          terminalScope: publicTerminalScope(data),
          ...(data?.providerOutcome === undefined
            ? {}
            : {
                providerOutcome: publicProviderOutcome(
                  data.providerOutcome
                ),
              }),
          message: textField(data, 'message')
            ?? stage
            ?? 'Session Kernel diagnostic.',
        },
      };
    }
    default:
      throw unsupportedProjectionKind(event);
  }
}

function userInterventionPresentation(
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const state = textField(data, 'state');
  const intervention = objectRecord(data?.intervention);
  if (!intervention) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_user_intervention_projection_invalid',
      'User intervention projection is missing its canonical card.'
    );
  }
  const interactionId = requiredIdentity(
    intervention.interactionId,
    'intervention.interactionId'
  );
  const interactionRevision = requiredIdentity(
    intervention.interactionRevision,
    'intervention.interactionRevision'
  );
  const candidateSetDigest = requiredIdentity(
    intervention.candidateSetDigest,
    'intervention.candidateSetDigest'
  );
  const runId = requiredIdentity(intervention.runId, 'intervention.runId');
  const problemSummary = boundedPublicText(
    intervention.problemSummary,
    'intervention.problemSummary'
  );
  const decision = objectRecord(data?.decision);
  const publicState = state === 'open'
    ? 'awaitingUserDecision'
    : state === 'accepted'
      ? 'accepted'
      : state === 'rejected'
        ? 'rejected'
        : 'needsRevision';
  return {
    kind: 'user_intervention',
    channel: 'task',
    visibility: 'both',
    fields: {
      status: publicState,
      decisionKind: 'userIntervention',
      interactionId,
      interactionRevision,
      candidateSetDigest,
      targetId: interactionId,
      blockId: `user-intervention:${runId}:${interactionId}`,
      title: 'User intervention required',
      summary: problemSummary,
      intervention: publicUserInterventionView(intervention),
      ...(decision
        ? {
            decision: textField(decision, 'decision'),
            selectedOptionId: textField(decision, 'optionId'),
            guidance: textField(decision, 'guidance'),
          }
        : {}),
      ...(textField(data, 'acceptedPlanRevision')
        ? { acceptedPlanRevision: textField(data, 'acceptedPlanRevision') }
        : {}),
    },
  };
}

function publicUserInterventionView(
  intervention: Record<string, unknown>
): Record<string, unknown> {
  const options = Array.isArray(intervention.options)
    ? intervention.options.map((value, index) => {
        const option = objectRecord(value);
        if (!option) {
          throw invalidPublicIntervention(`options[${index}]`);
        }
        const optionId = requiredIdentity(
          option.optionId,
          `intervention.options[${index}].optionId`
        );
        const kind = textField(option, 'kind');
        if (kind !== 'executable' && kind !== 'guidanceOnly') {
          throw invalidPublicIntervention(`options[${index}].kind`);
        }
        const candidatePlan = objectRecord(option.candidatePlan);
        const actions = Array.isArray(option.actions)
          ? option.actions.map((actionValue, actionIndex) => {
              const action = objectRecord(actionValue);
              const preview = objectRecord(action?.preview);
              const approval = objectRecord(preview?.approvalView);
              if (!action || !preview || !approval) {
                throw invalidPublicIntervention(
                  `options[${index}].actions[${actionIndex}]`
                );
              }
              return {
                planActionId: requiredIdentity(
                  action.planActionId,
                  'intervention.action.planActionId'
                ),
                operationId: requiredIdentity(
                  action.operationId,
                  'intervention.action.operationId'
                ),
                toolId: requiredIdentity(
                  action.toolId,
                  'intervention.action.toolId'
                ),
                summary: boundedPublicText(
                  action.summary,
                  'intervention.action.summary'
                ),
                riskLevel: interventionRisk(preview.risk),
                canonicalTargets: boundedPublicTextArray(
                  approval.canonicalTargets,
                  'intervention.action.canonicalTargets'
                ),
                scopeDelta: boundedPublicTextArray(
                  approval.scopeDelta,
                  'intervention.action.scopeDelta'
                ),
                previewId: requiredIdentity(
                  preview.previewId,
                  'intervention.action.previewId'
                ),
                previewDigest: sha256Hash(canonicalJson(preview)),
              };
            })
          : [];
        if (
          (kind === 'executable' && (!candidatePlan || actions.length === 0))
          || (kind === 'guidanceOnly' && (candidatePlan || actions.length > 0))
        ) {
          throw invalidPublicIntervention(`options[${index}].authority`);
        }
        return {
          id: optionId,
          label: boundedPublicText(
            option.title,
            `intervention.options[${index}].title`
          ),
          description: boundedPublicText(
            option.description,
            `intervention.options[${index}].description`
          ),
          recommended: option.recommended === true,
          kind,
          tradeoffs: boundedPublicTextArray(
            option.tradeoffs,
            `intervention.options[${index}].tradeoffs`
          ),
          ...(candidatePlan
            ? {
                candidatePlanRevision: requiredIdentity(
                  candidatePlan.planRevision,
                  'intervention.candidatePlan.planRevision'
                ),
                candidatePlanDigest: sha256Hash(canonicalJson(candidatePlan)),
              }
            : {}),
          actions,
        };
      })
    : [];
  if (options.length === 0) {
    throw invalidPublicIntervention('options');
  }
  return {
    schemaVersion: 'deepcode.session.user-intervention.v1',
    interactionId: requiredIdentity(
      intervention.interactionId,
      'intervention.interactionId'
    ),
    interactionRevision: requiredIdentity(
      intervention.interactionRevision,
      'intervention.interactionRevision'
    ),
    candidateSetDigest: requiredIdentity(
      intervention.candidateSetDigest,
      'intervention.candidateSetDigest'
    ),
    problemSummary: boundedPublicText(
      intervention.problemSummary,
      'intervention.problemSummary'
    ),
    ...(intervention.recommendation === undefined
      ? {}
      : {
          recommendation: boundedPublicText(
            intervention.recommendation,
            'intervention.recommendation'
          ),
        }),
    relevantFacts: boundedPublicTextArray(
      intervention.relevantFactRefs,
      'intervention.relevantFactRefs'
    ),
    affectedPlanActionIds: boundedPublicTextArray(
      intervention.affectedPlanActionIds,
      'intervention.affectedPlanActionIds'
    ),
    options,
    allowsFreeform: true,
  };
}

function interventionRisk(
  value: unknown
): 'low' | 'medium' | 'high' | 'critical' {
  if (
    value !== 'low'
    && value !== 'medium'
    && value !== 'high'
    && value !== 'critical'
  ) {
    throw invalidPublicIntervention('risk');
  }
  return value;
}

function boundedPublicText(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 64 * 1024
  ) {
    throw invalidPublicIntervention(field);
  }
  return value;
}

function boundedPublicTextArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw invalidPublicIntervention(field);
  }
  return value.map((item, index) =>
    boundedPublicText(item, `${field}[${index}]`)
  );
}

function invalidPublicIntervention(
  field: string
): SessionKernelProjectionTransportError {
  return new SessionKernelProjectionTransportError(
    'session_kernel_user_intervention_projection_invalid',
    `User intervention public field ${field} is invalid.`
  );
}

type CurrentProjectionFieldKind =
  | 'identity'
  | 'string'
  | 'array'
  | 'object'
  | 'positiveInteger'
  | 'nonNegativeInteger'
  | 'unknown';

type CurrentProjectionFieldSchema = Readonly<
  Record<string, CurrentProjectionFieldKind>
>;

const CURRENT_PLAN_FIELDS = {
  runId: 'identity',
  inputId: 'identity',
  controlEpoch: 'positiveInteger',
  planRevision: 'identity',
  title: 'string',
  objective: 'string',
  narrative: 'string',
  evidence: 'object',
  carriedSettlementRefs: 'array',
  actions: 'array',
  recordedAt: 'identity',
} as const satisfies CurrentProjectionFieldSchema;

const CURRENT_PLAN_OPTIONAL_FIELDS = {
  predecessorPlanRef: 'object',
} as const satisfies CurrentProjectionFieldSchema;

const CURRENT_SCOPE_PREVIEW_FIELDS = {
  previewId: 'identity',
  runId: 'identity',
  controlEpoch: 'positiveInteger',
  planRevision: 'identity',
  planActionId: 'identity',
  operationId: 'identity',
  toolId: 'identity',
  origin: 'object',
  authorizationBinding: 'object',
  canonicalScope: 'object',
  scopeDigest: 'identity',
  authorizationDigest: 'identity',
  toolContractDigest: 'identity',
  contextRef: 'object',
  effectClass: 'identity',
  effectScope: 'identity',
  risk: 'identity',
  effectiveDeadlineMs: 'positiveInteger',
  disposition: 'identity',
  approvalView: 'object',
} as const satisfies CurrentProjectionFieldSchema;

export function validateCurrentSessionKernelProjectionEventV2(
  event: SessionKernelProjectionEventV2
): void {
  currentProjectionData(event);
}

function currentProjectionData(
  event: SessionKernelProjectionEventV2
): Record<string, unknown> | undefined {
  switch (event.kind) {
    case 'input.persisted':
      return exactCurrentProjectionRecord(event, {
        inputId: 'identity',
        opaqueInputRef: 'identity',
        text: 'string',
        attachments: 'array',
        recordedAt: 'identity',
        controlEpoch: 'positiveInteger',
      });
    case 'plan.persisted': {
      const data = exactCurrentProjectionRecord(
        event,
        CURRENT_PLAN_FIELDS,
        CURRENT_PLAN_OPTIONAL_FIELDS
      );
      validateCurrentPlan(data);
      return data;
    }
    case 'plan.decided': {
      const data = exactCurrentProjectionRecord(
        event,
        {
          planRevision: 'identity',
          decision: 'string',
          recordedAt: 'identity',
        },
        { guidance: 'string' }
      );
      projectionEnum(data, 'decision', ['accept', 'reject', 'revise']);
      return data;
    }
    case 'plan.commentaryReleased': {
      const data = exactCurrentProjectionRecord(event, {
        planRevision: 'identity',
        providerTurnId: 'identity',
        controlEpoch: 'positiveInteger',
        orderedItems: 'array',
        recordedAt: 'identity',
      });
      const orderedItems = publicOrderedProviderItems(data.orderedItems);
      if (
        orderedItems.length === 0
        || orderedItems.some((item) =>
          item.kind !== 'text' || item.phase !== 'commentary'
        )
      ) {
        throw invalidCurrentProjectionData(
          event.kind,
          'orderedItems must contain only non-empty commentary text'
        );
      }
      return data;
    }
    case 'plan.confirmationReady': {
      const data = exactCurrentProjectionRecord(
        event,
        {
          planRevision: 'identity',
          providerTurnId: 'identity',
          plan: 'object',
          scopePreviews: 'array',
          recordedAt: 'identity',
        },
        { commentaryProjectionId: 'identity' }
      );
      const plan = projectionObject(data, 'plan');
      validateCurrentPlan(plan);
      const planRevision = textField(plan, 'planRevision');
      const previews = projectionArray(data, 'scopePreviews');
      previews.forEach((preview, index) =>
        validateCurrentScopePreview(
          preview,
          'scopePreviews[' + String(index) + ']'
        )
      );
      if (
        planRevision !== data.planRevision
        || !planScopePreviewsComplete(plan, previews.map((preview) =>
          projectionObject({ preview }, 'preview')
        ))
      ) {
        throw invalidCurrentProjectionData(
          event.kind,
          'Plan and canonical previews are not fully settled for confirmation'
        );
      }
      return data;
    }
    case 'scope.previewed':
      return currentScopePreviewProjectionData(event);
    case 'provider.started':
      return currentProviderStartedProjectionData(event);
    case 'provider.composing': {
      const data = exactCurrentProjectionRecord(
        event,
        {
          providerTurnId: 'identity',
          controlEpoch: 'positiveInteger',
          streamSequence: 'positiveInteger',
          textOrdinal: 'positiveInteger',
          textDelta: 'string',
        },
        { providerPhase: 'string' }
      );
      if (data.providerPhase !== undefined) {
        projectionEnum(data, 'providerPhase', [
          'commentary',
          'final_answer',
        ]);
      }
      return data;
    }
    case 'provider.completed':
      return currentProviderCompletedProjectionData(event);
    case 'provider.answerState': {
      const data = exactCurrentProjectionRecord(
        event,
        {
          providerTurnId: 'identity',
          controlEpoch: 'positiveInteger',
          answerState: 'string',
          reasonCode: 'identity',
        }
      );
      projectionEnum(data, 'answerState', ['stale', 'rejected']);
      return data;
    }
    case 'provider.stale':
      return exactCurrentProjectionRecord(
        event,
        { providerTurnId: 'identity' },
        { controlEpoch: 'positiveInteger' }
      );
    case 'toolIntent.submitted':
      return currentToolIntentProjectionData(event);
    case 'capability.awaiting': {
      const data = exactCurrentProjectionRecord(event, {
        operationId: 'identity',
        invocationId: 'identity',
        preview: 'object',
      });
      validateCurrentScopePreview(
        data.preview,
        'capability.awaiting.preview'
      );
      return data;
    }
    case 'kernelFacts.reconciled':
      return exactCurrentProjectionRecord(event, {
        requestId: 'identity',
        pageFactIds: 'array',
        pageFactCount: 'nonNegativeInteger',
        operationFacts: 'array',
        nextAfterLedgerSequence: 'nonNegativeInteger',
        snapshotHighWater: 'nonNegativeInteger',
      });
    case 'authorization.decided': {
      const data = exactCurrentProjectionRecord(
        event,
        {
          factId: 'identity',
          factKind: 'string',
          controlEpoch: 'positiveInteger',
          planActionIds: 'array',
          operationId: 'identity',
          resourceIds: 'array',
          details: 'object',
        },
        {
          previewId: 'identity',
          toolId: 'identity',
          capabilityLease: 'object',
          guidance: 'string',
          scopeDelta: 'unknown',
        }
      );
      projectionEnum(data, 'factKind', [
        'capabilityIssued',
        'capabilityDenied',
        'expansionAllowed',
        'expansionDenied',
      ]);
      return data;
    }
    case 'review.revised': {
      const data = exactCurrentProjectionRecord(
        event,
        {
          projectionVersion: 'identity',
          revision: 'positiveInteger',
          status: 'string',
          planActionSettlementDigest: 'identity',
          snapshotHighWater: 'nonNegativeInteger',
          planned: 'array',
          scopeExpansions: 'array',
          actualEffects: 'array',
          unexecuted: 'array',
          denied: 'array',
          rejections: 'array',
          completions: 'array',
          cleanup: 'array',
          indeterminate: 'array',
          priorEpochLateFacts: 'array',
          factCoverage: 'object',
          factsQuery: 'object',
          pendingCleanupCount: 'nonNegativeInteger',
          createdAt: 'identity',
        },
        {
          workAuthority: 'object',
          planRevision: 'identity',
          planDecision: 'object',
          plan: 'object',
          finalizedAt: 'identity',
        }
      );
      projectionEnum(data, 'status', ['final']);
      return data;
    }
    case 'planAction.completed': {
      const data = exactCurrentProjectionRecord(event, {
        kind: 'string',
        planRevision: 'identity',
        planActionId: 'identity',
        controlEpoch: 'positiveInteger',
        outcome: 'string',
        providerTurnId: 'identity',
        controlCallId: 'identity',
        controlArgumentsDigest: 'identity',
        snapshotHighWater: 'nonNegativeInteger',
        recordedAt: 'identity',
      });
      projectionEnum(data, 'kind', ['planActionComplete']);
      projectionEnum(data, 'outcome', [
        'completed',
        'no_op',
        'blocked',
        'skipped',
        'unexecuted',
      ]);
      return data;
    }
    case 'userIntervention.changed':
      return currentUserInterventionProjectionData(event);
    case 'run.cancelled':
      return exactCurrentProjectionRecord(event, {
        callerRequestId: 'identity',
        callerRequestDigest: 'identity',
        cancelOperationId: 'identity',
        controlEpoch: 'positiveInteger',
        cancellation: 'object',
        facts: 'object',
      });
    case 'wait.changed':
      return currentWaitProjectionData(event);
    case 'diagnostic':
      return currentDiagnosticProjectionData(event);
    default:
      throw unsupportedProjectionKind(event);
  }
}

function currentUserInterventionProjectionData(
  event: SessionKernelProjectionEventV2
): Record<string, unknown> {
  const tagged = objectRecord(event.data);
  const state = textField(tagged, 'state');
  const data = state === 'open'
    ? exactCurrentProjectionRecord(event, {
        state: 'string',
        wait: 'object',
        intervention: 'object',
      })
    : state === 'accepted'
      ? exactCurrentProjectionRecord(event, {
          state: 'string',
          intervention: 'object',
          decision: 'object',
          acceptedPlanRevision: 'identity',
        })
      : exactCurrentProjectionRecord(event, {
          state: 'string',
          intervention: 'object',
          decision: 'object',
        });
  projectionEnum(data, 'state', [
    'open',
    'accepted',
    'needsRevision',
    'guidanceReplan',
    'rejected',
  ]);
  const intervention = projectionObject(data, 'intervention');
  for (const field of [
    'runId',
    'inputId',
    'interactionId',
    'interactionRevision',
    'candidateSetDigest',
    'evidenceProgressDigest',
    'recordedAt',
  ]) {
    requiredIdentity(intervention[field], `intervention.${field}`);
  }
  if (
    intervention.schemaVersion !== 'deepcode.session.user-intervention.v1'
    || typeof intervention.problemSummary !== 'string'
    || !intervention.problemSummary.trim()
    || !Number.isSafeInteger(intervention.controlEpoch)
    || Number(intervention.controlEpoch) <= 0
    || !Array.isArray(intervention.relevantFactRefs)
    || !Array.isArray(intervention.affectedPlanActionIds)
    || !Array.isArray(intervention.options)
    || intervention.options.length === 0
  ) {
    throw invalidCurrentProjectionData(
      event.kind,
      'user intervention payload is incomplete'
    );
  }
  if (state === 'open') {
    const wait = projectionObject(data, 'wait');
    if (
      wait.kind !== 'userIntervention'
      || wait.interactionId !== intervention.interactionId
      || wait.interactionRevision !== intervention.interactionRevision
      || wait.candidateSetDigest !== intervention.candidateSetDigest
    ) {
      throw invalidCurrentProjectionData(
        event.kind,
        'user intervention wait does not match the card identity'
      );
    }
  } else {
    const decision = projectionObject(data, 'decision');
    if (
      decision.interactionId !== intervention.interactionId
      || decision.interactionRevision !== intervention.interactionRevision
      || decision.candidateSetDigest !== intervention.candidateSetDigest
    ) {
      throw invalidCurrentProjectionData(
        event.kind,
        'user intervention decision does not match the card identity'
      );
    }
  }
  return data;
}

function currentScopePreviewProjectionData(
  event: SessionKernelProjectionEventV2
): Record<string, unknown> {
  const data = exactCurrentProjectionRecord(event, {
    kind: 'string',
    data: 'object',
    plan: 'object',
    scopePreviews: 'array',
    planRevision: 'identity',
    planActionId: 'identity',
    operationId: 'identity',
  });
  validateCurrentPlan(projectionObject(data, 'plan'));
  projectionArray(data, 'scopePreviews').forEach((preview, index) =>
    validateCurrentScopePreview(
      preview,
      'scopePreviews[' + String(index) + ']'
    )
  );
  const reply = projectionObject(data, 'data');
  if (
    projectionEnum(data, 'kind', ['previewed', 'rejected'])
      === 'previewed'
  ) {
    const previewed = exactCurrentProjectionValue(
      reply,
      'scope.previewed.data',
      { preview: 'object' }
    );
    validateCurrentScopePreview(
      previewed.preview,
      'scope.previewed.data.preview'
    );
  } else {
    const rejected = exactCurrentProjectionValue(
      reply,
      'scope.previewed.data',
      {
        planActionId: 'identity',
        operationId: 'identity',
        toolId: 'identity',
        reason: 'identity',
        guidance: 'string',
      }
    );
    projectionEnum(rejected, 'reason', [
      'toolNotRegistered',
      'toolUnavailable',
      'invalidArguments',
      'requestedScopeInvalid',
      'settingsDenied',
      'staleToolContext',
      'staleControlEpoch',
    ]);
  }
  return data;
}

function currentProviderStartedProjectionData(
  event: SessionKernelProjectionEventV2
): Record<string, unknown> {
  const raw = objectRecord(event.data);
  if (
    raw
    && Object.prototype.hasOwnProperty.call(
      raw,
      'currentActivityCode'
    )
  ) {
    const data = exactCurrentProjectionRecord(event, {
      providerTurnId: 'identity',
      controlEpoch: 'positiveInteger',
      activitySequence: 'positiveInteger',
      currentActivityCode: 'string',
    });
    projectionEnum(data, 'currentActivityCode', [
      'provider.reasoning',
      'provider.composing',
    ]);
    return data;
  }
  return exactCurrentProjectionRecord(event, {
    providerTurnId: 'identity',
    controlEpoch: 'positiveInteger',
    contextRef: 'object',
    factProjection: 'object',
    contextAssembly: 'object',
  });
}

function currentProviderCompletedProjectionData(
  event: SessionKernelProjectionEventV2
): Record<string, unknown> {
  const data = exactCurrentProjectionRecord(
    event,
    {
      providerTurnId: 'identity',
      controlEpoch: 'positiveInteger',
      outputKind: 'string',
      terminalScope: 'string',
      orderedItems: 'array',
      providerOutcome: 'object',
    },
    {
      status: 'string',
      result: 'object',
      toolCallReceipt: 'object',
      reviewRevision: 'positiveInteger',
      snapshotHighWater: 'nonNegativeInteger',
      candidateSourceEventRefs: 'array',
      answerState: 'string',
    }
  );
  projectionEnum(data, 'outputKind', [
    'plan',
    'answer',
    'noTool',
    'toolIntent',
    'planEvidenceRefresh',
    'planActionComplete',
    'intervention',
  ]);
  projectionEnum(data, 'terminalScope', ['turn', 'providerTurn']);
  if (data.answerState !== undefined) {
    projectionEnum(data, 'answerState', ['provisional', 'committed']);
    if (
      data.outputKind !== 'answer'
      || (
        data.answerState === 'provisional'
          ? data.terminalScope !== 'providerTurn'
          : data.terminalScope !== 'turn'
      )
    ) {
      throw invalidCurrentProjectionData(
        event.kind,
        'answer state does not match Provider answer settlement'
      );
    }
  }
  if (data.status !== undefined) {
    projectionEnum(data, 'status', ['responseAccepted']);
  }
  const responseAccepted = data.status === 'responseAccepted';
  const hasResult = Object.prototype.hasOwnProperty.call(data, 'result');
  if (responseAccepted === hasResult) {
    throw invalidCurrentProjectionData(
      event.kind,
      'result does not match the current Provider completion variant'
    );
  }
  const hasReviewRevision = Object.prototype.hasOwnProperty.call(
    data,
    'reviewRevision'
  );
  const hasSnapshotHighWater = Object.prototype.hasOwnProperty.call(
    data,
    'snapshotHighWater'
  );
  if (
    hasReviewRevision !== hasSnapshotHighWater
    || (hasReviewRevision && (
      data.outputKind !== 'answer'
      || data.terminalScope !== 'turn'
    ))
  ) {
    throw invalidCurrentProjectionData(
      event.kind,
      'final Review binding does not match a terminal Provider answer'
    );
  }
  if (data.candidateSourceEventRefs !== undefined) {
    const sourceRefs = (data.candidateSourceEventRefs as unknown[])
      .map((sourceRef) => requiredIdentity(
        sourceRef,
        'candidateSourceEventRef'
      ));
    if (
      sourceRefs.length === 0
      || new Set(sourceRefs).size !== sourceRefs.length
      || data.outputKind !== 'answer'
      || data.terminalScope !== 'turn'
      || !hasReviewRevision
    ) {
      throw invalidCurrentProjectionData(
        event.kind,
        'candidate source refs do not bind a terminal reviewed answer'
      );
    }
  }
  return data;
}

function currentToolIntentProjectionData(
  event: SessionKernelProjectionEventV2
): Record<string, unknown> {
  const data = exactCurrentProjectionRecord(
    event,
    {
      requestId: 'identity',
      operationId: 'identity',
      toolId: 'identity',
      expectedControlEpoch: 'positiveInteger',
      authorityKind: 'string',
      replyKind: 'string',
    },
    {
      planRevision: 'identity',
      planActionId: 'identity',
      invocationId: 'identity',
      replyReason: 'identity',
    }
  );
  const authorityKind = projectionEnum(data, 'authorityKind', [
    'planAction',
    'read',
  ]);
  const replyKind = projectionEnum(data, 'replyKind', [
    'admitted',
    'awaitingCapability',
    'rejected',
  ]);
  const hasPlanRevision = data.planRevision !== undefined;
  const hasPlanActionId = data.planActionId !== undefined;
  if (
    hasPlanRevision !== hasPlanActionId
    || (authorityKind === 'planAction') !== hasPlanRevision
  ) {
    throw invalidCurrentProjectionData(
      event.kind,
      'PlanAction authority binding is incomplete'
    );
  }
  const hasInvocation = data.invocationId !== undefined;
  const hasRejection = data.replyReason !== undefined;
  if (
    (replyKind === 'rejected' && (!hasRejection || hasInvocation))
    || (replyKind !== 'rejected' && (!hasInvocation || hasRejection))
  ) {
    throw invalidCurrentProjectionData(
      event.kind,
      'Kernel ToolIntent reply fields conflict with replyKind'
    );
  }
  return data;
}

function currentWaitProjectionData(
  event: SessionKernelProjectionEventV2
): Record<string, unknown> | undefined {
  if (event.data === null) return undefined;
  const kind = objectRecord(event.data)?.kind;
  switch (kind) {
    case 'capability': {
      const data = exactCurrentProjectionRecord(
        event,
        {
          kind: 'string',
          operationId: 'identity',
          invocationId: 'identity',
          previewId: 'identity',
          sinceHighWater: 'nonNegativeInteger',
        },
        {
          decisionHint: 'string',
          denialGuidance: 'string',
        }
      );
      if (data.decisionHint !== undefined) {
        projectionEnum(data, 'decisionHint', ['allow', 'deny']);
      }
      return data;
    }
    case 'invocation':
      return exactCurrentProjectionRecord(event, {
        kind: 'string',
        operationId: 'identity',
        invocationId: 'identity',
        sinceHighWater: 'nonNegativeInteger',
      });
    case 'backpressure': {
      const data = exactCurrentProjectionRecord(event, {
        kind: 'string',
        operationId: 'identity',
        reason: 'string',
        retryAt: 'identity',
        guidance: 'string',
      });
      projectionEnum(data, 'reason', ['runBusy', 'capacityExceeded']);
      return data;
    }
    case 'manualRecovery': {
      const data = exactCurrentProjectionRecord(
        event,
        {
          kind: 'string',
          operationId: 'identity',
          reason: 'string',
          factIds: 'array',
        },
        { invocationId: 'identity' }
      );
      projectionEnum(data, 'reason', ['indeterminate']);
      return data;
    }
    default:
      throw invalidCurrentProjectionData(
        event.kind,
        'wait kind is not current'
      );
  }
}

function currentDiagnosticProjectionData(
  event: SessionKernelProjectionEventV2
): Record<string, unknown> {
  const stage = objectRecord(event.data)?.stage;
  let data: Record<string, unknown>;
  switch (stage) {
    case 'provider.toolCallQueue':
      data = exactCurrentProjectionRecord(event, {
        providerTurnId: 'identity',
        status: 'string',
        code: 'identity',
        stage: 'string',
        reason: 'string',
        orderedItems: 'array',
        unexecutedOrdinals: 'array',
        toolCallReceipt: 'object',
      });
      projectionEnum(data, 'status', ['blocked']);
      break;
    case 'provider.finalAnswer':
      data = exactCurrentProjectionRecord(
        event,
        {
          stage: 'string',
          status: 'string',
          terminalScope: 'string',
          code: 'identity',
          message: 'string',
          physicalRequestCount: 'positiveInteger',
          controlEpoch: 'positiveInteger',
          reviewRevision: 'positiveInteger',
          snapshotHighWater: 'nonNegativeInteger',
        },
        {
          providerTurnId: 'identity',
          providerOutcome: 'object',
        }
      );
      projectionEnum(data, 'status', ['failed']);
      projectionEnum(data, 'terminalScope', ['turn']);
      break;
    case 'provider.requestTurn':
    case 'provider.outputValidation':
      data = exactCurrentProjectionRecord(
        event,
        {
          providerTurnId: 'identity',
          status: 'string',
          terminalScope: 'string',
          code: 'identity',
          message: 'string',
          stage: 'string',
        },
        { providerOutcome: 'object' }
      );
      projectionEnum(data, 'status', ['failed']);
      projectionEnum(data, 'terminalScope', ['turn']);
      break;
    case 'provider.structuredRepair':
      data = exactCurrentProjectionRecord(
        event,
        {
          providerTurnId: 'identity',
          status: 'string',
          code: 'identity',
          stage: 'string',
          currentActivityCode: 'string',
        }
      );
      projectionEnum(data, 'status', ['recovering']);
      projectionEnum(data, 'currentActivityCode', [
        'session.validating',
      ]);
      break;
    case 'provider.structuredRepairNoProgress':
      data = exactCurrentProjectionRecord(
        event,
        {
          providerTurnId: 'identity',
          status: 'string',
          terminalScope: 'string',
          code: 'identity',
          message: 'string',
          stage: 'string',
        }
      );
      projectionEnum(data, 'status', ['failed']);
      projectionEnum(data, 'terminalScope', ['turn']);
      break;
    case 'provider.outputAdmission':
      data = exactCurrentProjectionRecord(event, {
        providerTurnId: 'identity',
        code: 'identity',
        message: 'string',
        stage: 'string',
        providerOutcome: 'object',
      });
      break;
    default:
      throw invalidCurrentProjectionData(
        event.kind,
        'diagnostic stage is not current'
      );
  }
  projectionEnum(data, 'stage', [stage]);
  return data;
}

function validateCurrentPlan(data: Record<string, unknown>): void {
  const plan = exactCurrentProjectionValue(
    data,
    'plan',
    CURRENT_PLAN_FIELDS,
    CURRENT_PLAN_OPTIONAL_FIELDS
  );
  for (const field of ['title', 'objective', 'narrative'] as const) {
    if (!(plan[field] as string).trim()) {
      throw invalidCurrentProjectionData(
        'plan',
        field + ' must be non-empty'
      );
    }
  }
  validateCurrentPlanEvidence(
    projectionObject(plan, 'evidence'),
    plan.runId as string,
    plan.controlEpoch as number
  );
  if (plan.predecessorPlanRef !== undefined) {
    const predecessor = exactCurrentProjectionValue(
      plan.predecessorPlanRef,
      'plan.predecessorPlanRef',
      {
        planRevision: 'identity',
        planDigest: 'identity',
      }
    );
    currentProjectionDigest(
      predecessor.planDigest,
      'plan.predecessorPlanRef.planDigest'
    );
  }
  const carriedActionIds = new Set<string>();
  projectionArray(plan, 'carriedSettlementRefs').forEach(
    (value, index) => {
      const settlement = exactCurrentProjectionValue(
        value,
        `plan.carriedSettlementRefs[${String(index)}]`,
        {
          planRevision: 'identity',
          planActionId: 'identity',
          settlementDigest: 'identity',
          kernelFactRefs: 'array',
        }
      );
      currentProjectionDigest(
        settlement.settlementDigest,
        `plan.carriedSettlementRefs[${String(index)}].settlementDigest`
      );
      const planActionId = settlement.planActionId as string;
      if (carriedActionIds.has(planActionId)) {
        throw invalidCurrentProjectionData(
          'plan.carriedSettlementRefs',
          'PlanAction identities must be unique'
        );
      }
      carriedActionIds.add(planActionId);
      validateCurrentIdentityArray(
        projectionArray(settlement, 'kernelFactRefs'),
        `plan.carriedSettlementRefs[${String(index)}].kernelFactRefs`,
        false
      );
    }
  );
  const actions = projectionArray(plan, 'actions');
  if (actions.length === 0 || actions.length > 128) {
    throw invalidCurrentProjectionData(
      'plan.actions',
      'Plan must contain 1..=128 current mutation actions'
    );
  }
  actions.forEach((value, index) => {
    const action = exactCurrentProjectionValue(
      value,
      `plan.actions[${String(index)}]`,
      {
        taskId: 'identity',
        manifest: 'object',
        idempotencyKey: 'identity',
        deadline: 'object',
      }
    );
    const manifest = exactCurrentProjectionValue(
      action.manifest,
      `plan.actions[${String(index)}].manifest`,
      {
        planRevision: 'identity',
        planActionId: 'identity',
        operationId: 'identity',
        toolId: 'identity',
        scopeIntent: 'object',
      }
    );
    const scopeIntent = exactCurrentProjectionValue(
      manifest.scopeIntent,
      `plan.actions[${String(index)}].manifest.scopeIntent`,
      { kind: 'string', data: 'object' }
    );
    if (
      projectionEnum(scopeIntent, 'kind', [
        'resourceScope',
        'exactInvocation',
      ]) === 'exactInvocation'
    ) {
      exactCurrentProjectionValue(
        scopeIntent.data,
        `plan.actions[${String(index)}].manifest.scopeIntent.data`,
        { rawArguments: 'object' }
      );
    } else {
      exactCurrentProjectionValue(
        scopeIntent.data,
        `plan.actions[${String(index)}].manifest.scopeIntent.data`,
        { requestedResources: 'array' }
      );
    }
  });
}

function validateCurrentPlanEvidence(
  evidence: Record<string, unknown>,
  runId: string,
  controlEpoch: number
): void {
  const current = exactCurrentProjectionValue(
    evidence,
    'plan.evidence',
    {
      kernelFactRefs: 'array',
      readResources: 'array',
      historicalRebinds: 'array',
      blockingUnknowns: 'array',
      nonBlockingUnknowns: 'array',
      coverage: 'string',
    }
  );
  if (!(current.coverage as string).trim()) {
    throw invalidCurrentProjectionData(
      'plan.evidence.coverage',
      'coverage must be non-empty'
    );
  }
  const kernelFactRefs = projectionArray(current, 'kernelFactRefs');
  if (kernelFactRefs.length > 512) {
    throw invalidCurrentProjectionData(
      'plan.evidence.kernelFactRefs',
      'Kernel fact ref list exceeds the current object bound'
    );
  }
  validateCurrentIdentityArray(
    kernelFactRefs,
    'plan.evidence.kernelFactRefs',
    false
  );

  const readResources = projectionArray(current, 'readResources');
  if (readResources.length > 512) {
    throw invalidCurrentProjectionData(
      'plan.evidence.readResources',
      'read evidence exceeds the current object bound'
    );
  }
  const resourceRefs = new Set<string>();
  const resourceEvidence = new Map<string, {
    digest: string;
    factRefs: string[];
  }>();
  readResources.forEach((value, index) => {
    const resource = exactCurrentProjectionValue(
      value,
      `plan.evidence.readResources[${String(index)}]`,
      {
        resourceRef: 'identity',
        digest: 'identity',
        summary: 'string',
        factRefs: 'array',
      }
    );
    const resourceRef = resource.resourceRef as string;
    if (
      resourceRefs.has(resourceRef)
      || !(resource.summary as string).trim()
    ) {
      throw invalidCurrentProjectionData(
        'plan.evidence.readResources',
        'resource refs must be unique and summaries must be non-empty'
      );
    }
    resourceRefs.add(resourceRef);
    currentProjectionDigest(
      resource.digest,
      `plan.evidence.readResources[${String(index)}].digest`
    );
    validateCurrentIdentityArray(
      projectionArray(resource, 'factRefs'),
      `plan.evidence.readResources[${String(index)}].factRefs`,
      true
    );
    resourceEvidence.set(resourceRef, {
      digest: resource.digest as string,
      factRefs: projectionArray(resource, 'factRefs') as string[],
    });
  });

  const historicalRebinds = projectionArray(
    current,
    'historicalRebinds'
  );
  if (historicalRebinds.length > 512) {
    throw invalidCurrentProjectionData(
      'plan.evidence.historicalRebinds',
      'historical evidence rebinds exceed the current object bound'
    );
  }
  const rebindIds = new Set<string>();
  historicalRebinds.forEach((value, index) => {
    const rebind = exactCurrentProjectionValue(
      value,
      `plan.evidence.historicalRebinds[${String(index)}]`,
      {
        rebindId: 'identity',
        sourceEventId: 'identity',
        sourceEventDigest: 'identity',
        sourceEventVersion: 'positiveInteger',
        sourceRunId: 'identity',
        sourceFactId: 'identity',
        sourceControlEpoch: 'positiveInteger',
        sourceOperationId: 'identity',
        sourceToolId: 'identity',
        subjectDigest: 'identity',
        sourceEvidenceDigest: 'identity',
        sourceCandidateDigest: 'identity',
        currentRunId: 'identity',
        currentControlEpoch: 'positiveInteger',
        currentFactRef: 'identity',
        currentEvidenceDigest: 'identity',
        resourceRef: 'identity',
        contentRelation: 'string',
      }
    );
    for (const digestField of [
      'sourceEventDigest',
      'subjectDigest',
      'sourceEvidenceDigest',
      'sourceCandidateDigest',
      'currentEvidenceDigest',
    ] as const) {
      currentProjectionDigest(
        rebind[digestField],
        `plan.evidence.historicalRebinds[${String(index)}].${digestField}`
      );
    }
    const resource = resourceEvidence.get(rebind.resourceRef as string);
    if (
      !rebindIds.add(rebind.rebindId as string)
      || rebind.sourceRunId === runId
      || rebind.currentRunId !== runId
      || rebind.currentControlEpoch !== controlEpoch
      || (
        rebind.contentRelation !== 'sameDigest'
        && rebind.contentRelation !== 'changedDigest'
      )
      || !resource
      || resource.digest !== rebind.currentEvidenceDigest
      || !resource.factRefs.includes(rebind.currentFactRef as string)
    ) {
      throw invalidCurrentProjectionData(
        'plan.evidence.historicalRebinds',
        'historical rebind must reference exact current read evidence'
      );
    }
  });

  const blocking = projectionArray(current, 'blockingUnknowns');
  const nonBlocking = projectionArray(current, 'nonBlockingUnknowns');
  if (blocking.length > 128 || nonBlocking.length > 128) {
    throw invalidCurrentProjectionData(
      'plan.evidence.unknowns',
      'unknown list exceeds the current object bound'
    );
  }
  const unknownIds = new Set<string>();
  [...blocking, ...nonBlocking].forEach((value, index) => {
    const unknown = exactCurrentProjectionValue(
      value,
      `plan.evidence.unknowns[${String(index)}]`,
      {
        unknownId: 'identity',
        question: 'string',
        impact: 'string',
      }
    );
    const unknownId = unknown.unknownId as string;
    if (
      unknownIds.has(unknownId)
      || !(unknown.question as string).trim()
      || !(unknown.impact as string).trim()
    ) {
      throw invalidCurrentProjectionData(
        'plan.evidence.unknowns',
        'unknown identities must be unique and text must be non-empty'
      );
    }
    unknownIds.add(unknownId);
  });
}

function validateCurrentIdentityArray(
  values: unknown[],
  field: string,
  requireNonEmpty: boolean
): void {
  if (requireNonEmpty && values.length === 0) {
    throw invalidCurrentProjectionData(
      field,
      'identity list must be non-empty'
    );
  }
  const identities = new Set<string>();
  values.forEach((value) => {
    if (!currentProjectionIdentity(value) || identities.has(value as string)) {
      throw invalidCurrentProjectionData(
        field,
        'identities must be current and unique'
      );
    }
    identities.add(value as string);
  });
}

function currentProjectionDigest(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(value)
  ) {
    throw invalidCurrentProjectionData(field, 'digest is invalid');
  }
  return value;
}

function validateCurrentScopePreview(value: unknown, field: string): void {
  const preview = exactCurrentProjectionValue(
    value,
    field,
    CURRENT_SCOPE_PREVIEW_FIELDS
  );
  const origin = exactCurrentProjectionValue(
    preview.origin,
    `${field}.origin`,
    { kind: 'string', data: 'object' }
  );
  switch (projectionEnum(origin, 'kind', [
    'plan',
    'planDiscovery',
    'interventionCandidate',
  ])) {
    case 'plan':
      exactCurrentProjectionValue(
        origin.data,
        `${field}.origin.data`,
        {}
      );
      break;
    case 'planDiscovery':
      exactCurrentProjectionValue(
        origin.data,
        `${field}.origin.data`,
        { discoveryId: 'identity' }
      );
      break;
    case 'interventionCandidate': {
      const data = exactCurrentProjectionValue(
        origin.data,
        `${field}.origin.data`,
        {
          interactionId: 'identity',
          interactionRevision: 'identity',
          candidateSetDigest: 'identity',
          optionId: 'identity',
        }
      );
      currentProjectionDigest(
        data.candidateSetDigest,
        `${field}.origin.data.candidateSetDigest`
      );
      break;
    }
  }
  projectionEnum(preview, 'effectClass', ['read', 'mutation']);
  projectionEnum(preview, 'effectScope', [
    'workspaceRead',
    'workspaceWrite',
    'repositoryRead',
    'repositoryIndexWrite',
    'repositoryHistoryWrite',
    'networkRead',
  ]);
  projectionEnum(preview, 'risk', [
    'low',
    'medium',
    'high',
    'critical',
  ]);
  projectionEnum(preview, 'disposition', [
    'autoIssuable',
    'requiresUserDecision',
  ]);
  const authorizationBinding = exactCurrentProjectionValue(
    preview.authorizationBinding,
    `${field}.authorizationBinding`,
    { kind: 'string', data: 'object' }
  );
  if (
    projectionEnum(authorizationBinding, 'kind', [
      'resourceScope',
      'exactInvocation',
    ]) === 'resourceScope'
  ) {
    exactCurrentProjectionValue(
      authorizationBinding.data,
      `${field}.authorizationBinding.data`,
      {}
    );
  } else {
    exactCurrentProjectionValue(
      authorizationBinding.data,
      `${field}.authorizationBinding.data`,
      { invocationDigest: 'identity' }
    );
  }
}

function exactCurrentProjectionRecord(
  event: SessionKernelProjectionEventV2,
  required: CurrentProjectionFieldSchema,
  optional: CurrentProjectionFieldSchema = {}
): Record<string, unknown> {
  return exactCurrentProjectionValue(
    event.data,
    event.kind,
    required,
    optional
  );
}

function exactCurrentProjectionValue(
  value: unknown,
  field: string,
  required: CurrentProjectionFieldSchema,
  optional: CurrentProjectionFieldSchema = {}
): Record<string, unknown> {
  const record = objectRecord(value);
  const permitted = new Set([
    ...Object.keys(required),
    ...Object.keys(optional),
  ]);
  if (
    !record
    || Object.keys(record).some((key) => !permitted.has(key))
    || Object.keys(required).some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(record, key)
        || record[key] === undefined
    )
  ) {
    throw invalidCurrentProjectionData(
      field,
      'record fields are not exact'
    );
  }
  for (const [key, kind] of Object.entries({
    ...required,
    ...optional,
  })) {
    if (record[key] !== undefined) {
      validateCurrentProjectionField(record[key], key, kind);
    }
  }
  return record;
}

function validateCurrentProjectionField(
  value: unknown,
  field: string,
  kind: CurrentProjectionFieldKind
): void {
  const invalid =
    (kind === 'identity' && !currentProjectionIdentity(value))
    || (kind === 'string' && typeof value !== 'string')
    || (kind === 'array' && !Array.isArray(value))
    || (kind === 'object' && objectRecord(value) === undefined)
    || (
      kind === 'positiveInteger'
      && (
        typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value <= 0
      )
    )
    || (
      kind === 'nonNegativeInteger'
      && (
        typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < 0
      )
    );
  if (invalid) {
    throw invalidCurrentProjectionData(
      field,
      kind + ' field is invalid'
    );
  }
}

function currentProjectionIdentity(value: unknown): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && new TextEncoder().encode(value).byteLength <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function projectionArray(
  data: Record<string, unknown>,
  field: string
): unknown[] {
  const value = data[field];
  if (!Array.isArray(value)) {
    throw invalidCurrentProjectionData(field, 'array field is invalid');
  }
  return value;
}

function projectionObject(
  data: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  const value = objectRecord(data[field]);
  if (!value) {
    throw invalidCurrentProjectionData(field, 'object field is invalid');
  }
  return value;
}

function projectionEnum<const T extends string>(
  data: Record<string, unknown>,
  field: string,
  values: readonly T[]
): T {
  const value = data[field];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw invalidCurrentProjectionData(field, 'enum field is invalid');
  }
  return value as T;
}

function invalidCurrentProjectionData(
  kind: string,
  reason: string
): SessionKernelProjectionTransportError {
  return new SessionKernelProjectionTransportError(
    'session_kernel_projection_data_invalid',
    'Session ' + kind
      + ' projection is not exact current v4 data: ' + reason + '.'
  );
}

function unsupportedProjectionKind(
  event: { kind: unknown }
): SessionKernelProjectionTransportError {
  return new SessionKernelProjectionTransportError(
    'UnsupportedHistorySchema',
    'Session projection kind ' + String(event.kind)
      + ' is not current v4.'
  );
}
function providerComposingPresentation(
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const permitted = new Set([
    'providerTurnId',
    'controlEpoch',
    'streamSequence',
    'textOrdinal',
    'providerPhase',
    'textDelta',
  ]);
  const providerTurnId = requiredIdentity(
    data?.providerTurnId,
    'providerTurnId'
  );
  const controlEpoch = data?.controlEpoch;
  const streamSequence = data?.streamSequence;
  const textOrdinal = data?.textOrdinal;
  const providerPhase = textField(data, 'providerPhase');
  const textDelta = data?.textDelta;
  if (
    !data
    || Object.keys(data).some((key) => !permitted.has(key))
    || !Number.isSafeInteger(controlEpoch)
    || Number(controlEpoch) <= 0
    || !Number.isSafeInteger(streamSequence)
    || Number(streamSequence) <= 0
    || !Number.isSafeInteger(textOrdinal)
    || Number(textOrdinal) <= 0
    || (
      providerPhase !== undefined
      && providerPhase !== 'commentary'
      && providerPhase !== 'final_answer'
    )
    || typeof textDelta !== 'string'
    || textDelta.length === 0
    || new TextEncoder().encode(textDelta).byteLength > 1024 * 1024
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_provider_composing_invalid',
      'Provider composing projection is not an exact safe text delta.'
    );
  }
  return {
    kind: 'assistant_msg',
    channel: 'progress',
    visibility: 'conversation',
    fields: {
      status: 'running',
      providerTurnId,
      controlEpoch,
      streamSequence,
      textOrdinal,
      ...(providerPhase ? { providerPhase } : {}),
      content: textDelta,
    },
  };
}

function planScopePreviewPresentation(
  _event: SessionKernelProjectionEventV2,
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const currentPreview = objectRecord(objectRecord(data?.data)?.preview);
  const planRevision = textField(currentPreview, 'planRevision')
    ?? textField(data, 'planRevision');
  return {
    kind: 'workflow_stage',
    channel: 'progress',
    visibility: 'trace',
    fields: {
      planRevision,
      planActionId: textField(currentPreview, 'planActionId')
        ?? textField(data, 'planActionId'),
      operationId: textField(currentPreview, 'operationId')
        ?? textField(data, 'operationId'),
      toolId: textField(currentPreview, 'toolId'),
      status: 'running',
      summary: 'Canonical scope preview recorded.',
    },
  };
}

function planConfirmationReadyPresentation(
  event: SessionKernelProjectionEventV2,
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const privatePlan = objectRecord(data?.plan);
  const plan = privatePlan
    ? publicPlanForPresentationV3(privatePlan)
    : undefined;
  const previews = scopePreviewRecords(data);
  const planRevision = textField(plan, 'planRevision')
    ?? textField(data, 'planRevision');
  const planId = planRevision ?? event.projectionId;
  const title = textField(plan, 'title') ?? 'Plan';
  const objective = textField(plan, 'objective')
    ?? textField(plan, 'narrative')
    ?? 'Plan is ready for review.';
  if (!planScopePreviewsComplete(plan, previews)) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_plan_confirmation_incomplete',
      'Plan confirmation requires one canonical scope preview for every PlanAction.'
    );
  }
  return {
    kind: 'plan_card',
    channel: 'task',
    visibility: 'both',
    fields: {
      planId,
      planRevision,
      title,
      summary: objective,
      userPlan: textField(plan, 'narrative'),
      status: 'awaitingUserApproval',
      confirmable: true,
      tasks: planTasksWithScopePreviews(plan, previews),
      scopePreviews: cloneJson(previews),
      scopeApprovalView: {
        planRevision,
        previews: previews.map((preview) => ({
          previewId: textField(preview, 'previewId'),
          planActionId: textField(preview, 'planActionId'),
          operationId: textField(preview, 'operationId'),
          toolId: textField(preview, 'toolId'),
          authorizationDigest:
            textField(preview, 'authorizationDigest'),
          approvalView: preview.approvalView === undefined
            ? undefined
            : cloneJson(preview.approvalView),
        })),
      },
      readablePlan: readablePlanScopeApproval(
        plan,
        planId,
        title,
        objective,
        previews
      ),
    },
  };
}

/**
 * Exact invocation arguments remain Session-private. Public Plan tasks retain
 * only the scope-intent discriminator so Shells never receive raw arguments.
 */
function publicPlanForPresentationV3(
  plan: Record<string, unknown>
): Record<string, unknown> {
  const publicPlan = cloneJson(plan);
  if (!Array.isArray(publicPlan.actions)) return publicPlan;
  publicPlan.actions = publicPlan.actions.map((value) => {
    const action = objectRecord(value);
    const manifest = objectRecord(action?.manifest);
    const scopeIntent = objectRecord(manifest?.scopeIntent);
    if (!action || !manifest || scopeIntent?.kind !== 'exactInvocation') {
      return cloneJson(value);
    }
    return {
      ...cloneJson(action),
      manifest: {
        ...cloneJson(manifest),
        scopeIntent: {
          kind: 'exactInvocation',
          data: {},
        },
      },
    };
  });
  return publicPlan;
}

function planScopePreviewsComplete(
  plan: Record<string, unknown> | undefined,
  previews: Record<string, unknown>[]
): boolean {
  if (!Array.isArray(plan?.actions) || plan.actions.length === 0) {
    return false;
  }
  const planRevision = textField(plan, 'planRevision');
  if (!planRevision) return false;
  return plan.actions.every((value) => {
    const action = objectRecord(value);
    const manifest = objectRecord(action?.manifest);
    const planActionId = textField(manifest, 'planActionId');
    const operationId = textField(manifest, 'operationId');
    const toolId = textField(manifest, 'toolId');
    if (!planActionId || !operationId || !toolId) return false;
    return previews.some((preview) => {
      const approvalView = objectRecord(preview.approvalView);
      const scopeDigest = textField(preview, 'scopeDigest');
      return textField(preview, 'previewId') !== undefined
        && textField(preview, 'planRevision') === planRevision
        && textField(preview, 'planActionId') === planActionId
        && textField(preview, 'operationId') === operationId
        && textField(preview, 'toolId') === toolId
        && scopeDigest !== undefined
        && textField(preview, 'authorizationDigest') !== undefined
        && textField(approvalView, 'scopeDigest') === scopeDigest;
    });
  });
}

function rejectedPlanScopePresentation(
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const plan = objectRecord(data?.plan);
  const planRevision = textField(plan, 'planRevision')
    ?? textField(data, 'planRevision');
  const guidance = nestedText(data, ['data', 'guidance']);
  return {
    kind: 'plan_review',
    channel: 'task',
    visibility: 'both',
    fields: {
      planId: planRevision,
      planRevision,
      status: 'needsRevision',
      decision: 'revise',
      confirmable: false,
      guidance,
      operationId: textField(data, 'operationId'),
      planActionId: textField(data, 'planActionId'),
      summary: guidance
        ?? 'Kernel rejected a planned scope; replanning is required.',
    },
  };
}

function scopePreviewRecords(
  data: Record<string, unknown> | undefined
): Record<string, unknown>[] {
  const previews = Array.isArray(data?.scopePreviews)
    ? data.scopePreviews.flatMap((value) => {
        const preview = objectRecord(value);
        return preview ? [preview] : [];
      })
    : [];
  const current = objectRecord(objectRecord(data?.data)?.preview);
  if (
    current
    && !previews.some(
      (preview) =>
        textField(preview, 'previewId') === textField(current, 'previewId')
    )
  ) {
    previews.push(current);
  }
  return previews;
}

function planTasksWithScopePreviews(
  plan: Record<string, unknown> | undefined,
  previews: Record<string, unknown>[]
): unknown[] {
  if (!Array.isArray(plan?.actions)) return [];
  return plan.actions.map((value) => {
    const action = objectRecord(value);
    if (!action) return cloneJson(value);
    const manifest = objectRecord(action.manifest);
    const operationId = textField(manifest, 'operationId');
    const preview = previews.find(
      (candidate) =>
        textField(candidate, 'operationId') === operationId
    );
    return preview
      ? {
          ...cloneJson(action),
          scopePreview: cloneJson(preview),
          approvalView: preview.approvalView === undefined
            ? undefined
            : cloneJson(preview.approvalView),
        }
      : cloneJson(action);
  });
}

function readablePlanScopeApproval(
  plan: Record<string, unknown> | undefined,
  planId: string,
  title: string,
  objective: string,
  previews: Record<string, unknown>[]
): Record<string, unknown> {
  const actions = Array.isArray(plan?.actions)
    ? plan.actions.flatMap((value) => {
        const action = objectRecord(value);
        return action ? [action] : [];
      })
    : [];
  const readableTasks = actions.map((action, index) => {
    const manifest = objectRecord(action.manifest);
    const taskId = textField(action, 'taskId')
      ?? textField(manifest, 'planActionId')
      ?? `plan-action-${index + 1}`;
    const toolId = textField(manifest, 'toolId') ?? 'kernel.tool';
    const operationId = textField(manifest, 'operationId');
    const preview = previews.find((candidate) =>
      textField(candidate, 'operationId') === operationId
    );
    return {
      taskId,
      title: toolId,
      objective: operationId
        ? `operationId=${operationId}`
        : undefined,
      resourcePresentation: previewResourcePresentation(preview),
      acceptance: [],
      failure: [],
      intentKind: toolId,
    };
  });
  return {
    schemaVersion: AGENT_TIMELINE_READABLE_PLAN_SCHEMA_V2,
    titleKey: 'session.projection.plan.title',
    title,
    summary: objective,
    sourceRefs: {
      planRevision: planId,
    },
    tasks: readableTasks,
    sections: [
      {
        sectionId: 'summary',
        titleKey: 'session.projection.plan.section.summary',
        items: [{
          itemId: 'summary',
          kind: 'text',
          text: textField(plan, 'narrative') ?? objective,
        }],
      },
      {
        sectionId: 'tasks',
        titleKey: 'session.projection.plan.section.tasks',
        emptyMessageKey: 'session.projection.plan.empty.tasks',
        items: readableTasks.map((task) => ({
          itemId: task.taskId,
          kind: 'task',
          text: task.title,
          resourcePresentation: task.resourcePresentation,
          metadata: {
            objective: task.objective,
            acceptance: task.acceptance,
            failure: task.failure,
          },
        })),
      },
      {
        sectionId: 'scopeApproval',
        titleKey:
          'session.projection.plan.section.permissionBundles',
        emptyMessageKey:
          'session.projection.plan.empty.permissionBundles',
        items: previews.map(scopeApprovalProjectionItem),
      },
    ],
  };
}

function previewResourcePresentation(
  preview: Record<string, unknown> | undefined
): Record<string, unknown>[] {
  const approvalView = objectRecord(preview?.approvalView);
  if (!Array.isArray(approvalView?.resourcePresentation)) return [];
  return approvalView.resourcePresentation.flatMap((value) => {
    const resource = objectRecord(value);
    return resource ? [cloneJson(resource)] : [];
  });
}

function previewResourcePresentationRefs(
  preview: Record<string, unknown> | undefined
): string[] {
  const approvalView = objectRecord(preview?.approvalView);
  if (!Array.isArray(approvalView?.resourcePresentation)) return [];
  return approvalView.resourcePresentation.flatMap((value) => {
    const resource = objectRecord(value);
    const canonicalResourceRef = textField(
      resource,
      'canonicalResourceRef'
    );
    return canonicalResourceRef ? [canonicalResourceRef] : [];
  });
}

function scopeApprovalProjectionItem(
  preview: Record<string, unknown>
): Record<string, unknown> {
  const approval = objectRecord(preview.approvalView);
  const previewId = textField(preview, 'previewId') ?? 'scope-preview';
  const toolId = textField(preview, 'toolId') ?? 'kernel.tool';
  const risk = textField(approval, 'risk')
    ?? textField(preview, 'risk')
    ?? 'unknown';
  const effectClass = textField(approval, 'effectClass')
    ?? textField(preview, 'effectClass')
    ?? 'unknown';
  const effectScope = textField(approval, 'effectScope')
    ?? textField(preview, 'effectScope')
    ?? 'unknown';
  const scopeDigest = textField(approval, 'scopeDigest')
    ?? textField(preview, 'scopeDigest')
    ?? 'unknown';
  const summary = textField(approval, 'summary')
    ?? 'Canonical Kernel scope';
  return {
    itemId: previewId,
    kind: 'permission',
    messageKey: 'session.projection.plan.item.scopeApproval',
    messageArgs: {
      toolId,
      summary,
      risk,
      effectClass,
      effectScope,
    },
    status: textField(preview, 'disposition'),
    targetRefs: previewResourcePresentationRefs(preview),
    resourcePresentation: previewResourcePresentation(preview),
    auditRefs: [
      previewId,
      scopeDigest,
      textField(preview, 'authorizationDigest'),
    ].filter((value): value is string => Boolean(value)),
    metadata: {
      acceptance: stringArrayField(approval, 'scopeDelta'),
      failure: [],
    },
  };
}

function permissionRequestPresentation(
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const preview = projectionObject(data ?? {}, 'preview');
  const operationId = requiredIdentity(
    data?.operationId,
    'operationId'
  );
  const previewId = requiredIdentity(preview.previewId, 'previewId');
  return {
    kind: 'permission_request',
    channel: 'tool',
    visibility: 'conversation',
    fields: {
      id: previewId,
      permissionId: previewId,
      requestKind: 'scopeExpansion',
      operationId,
      invocationId: textField(data, 'invocationId'),
      affectedOperationIds: operationId ? [operationId] : [],
      toolId: textField(preview, 'toolId'),
      toolName: textField(preview, 'toolId') ?? 'kernel.tool',
      riskLevel: textField(preview, 'risk') ?? 'medium',
      summary: 'Review the exact canonical Kernel scope.',
      argumentsPreview: preview ? cloneJson(preview) : null,
      preview: preview ? cloneJson(preview) : undefined,
      status: 'awaitingUserDecision',
    },
  };
}

function publicOrderedProviderItems(
  value: unknown
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  if (value.length > 96) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_provider_items_invalid',
      'Provider projection contains too many ordered items.'
    );
  }
  return value.map((entry, index) => {
    const item = objectRecord(entry);
    if (item?.kind === 'text') {
      const permitted = new Set(['kind', 'phase', 'text']);
      const phase = textField(item, 'phase');
      const text = textField(item, 'text');
      if (
        Object.keys(item).some((key) => !permitted.has(key))
        ||
        !text
        || (
          phase !== 'commentary'
          && phase !== 'final_answer'
          && phase !== 'unknown'
        )
      ) {
        throw new SessionKernelProjectionTransportError(
          'session_kernel_projection_provider_items_invalid',
          `Provider text item ${index + 1} is invalid.`
        );
      }
      return {
        kind: 'text',
        phase,
        text,
        textOrdinal: index + 1,
      };
    }
    if (item?.kind !== 'toolCall') {
      throw new SessionKernelProjectionTransportError(
        'session_kernel_projection_provider_items_invalid',
        `Provider ordered item ${index + 1} is invalid.`
      );
    }
    const permitted = new Set([
      'kind',
      'ordinal',
      'callId',
      'toolName',
      'toolId',
      'operationId',
      'previewId',
      'status',
      'invocationId',
      'terminalFactId',
      'terminalFactKind',
      'settlementReason',
      'retry',
    ]);
    const ordinal = item.ordinal;
    const status = textField(item, 'status');
    if (
      Object.keys(item).some((key) => !permitted.has(key))
      || !Number.isSafeInteger(ordinal)
      || Number(ordinal) <= 0
      || (
        status !== undefined
        && status !== 'pending'
        && status !== 'submitting'
        && status !== 'awaitingCapability'
        && status !== 'awaitingInvocation'
        && status !== 'completed'
        && status !== 'aborted'
        && status !== 'unexecuted'
      )
    ) {
      throw new SessionKernelProjectionTransportError(
        'session_kernel_projection_provider_items_invalid',
        `Provider tool item ${index + 1} is invalid.`
      );
    }
    const operationId = item.operationId === undefined
      ? undefined
      : requiredIdentity(item.operationId, 'operationId');
    const retry = publicToolRetry(item.retry, operationId, index);
    return {
      kind: 'toolCall',
      ordinal,
      callId: requiredIdentity(item.callId, 'callId'),
      toolName: requiredIdentity(item.toolName, 'toolName'),
      toolId: requiredIdentity(item.toolId, 'toolId'),
      ...(operationId ? { operationId } : {}),
      ...(item.previewId === undefined
        ? {}
        : {
            previewId: requiredIdentity(
              item.previewId,
              'previewId'
            ),
          }),
      ...(retry ? { retry } : {}),
      ...(status ? { status } : {}),
      ...(item.invocationId === undefined
        ? {}
        : {
            invocationId: requiredIdentity(
              item.invocationId,
              'invocationId'
            ),
          }),
      ...(item.terminalFactId === undefined
        ? {}
        : {
            terminalFactId: requiredIdentity(
              item.terminalFactId,
              'terminalFactId'
            ),
          }),
      ...(item.terminalFactKind === undefined
        ? {}
        : {
            terminalFactKind: requiredIdentity(
              item.terminalFactKind,
              'terminalFactKind'
            ),
          }),
      ...(item.settlementReason === undefined
        ? {}
        : {
            settlementReason: requiredIdentity(
              item.settlementReason,
              'settlementReason'
            ),
          }),
    };
  });
}

function publicToolRetry(
  value: unknown,
  operationId: string | undefined,
  itemIndex: number
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const retry = objectRecord(value);
  const permitted = new Set([
    'retryGroupId',
    'predecessorOperationId',
    'retryOrdinal',
  ]);
  const retryOrdinal = retry?.retryOrdinal;
  if (
    !retry
    || Object.keys(retry).length !== permitted.size
    || Object.keys(retry).some((key) => !permitted.has(key))
    || !operationId
    || !Number.isSafeInteger(retryOrdinal)
    || Number(retryOrdinal) < 2
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_provider_items_invalid',
      `Provider tool item ${itemIndex + 1} has an invalid retry relation.`
    );
  }
  const retryGroupId = requiredIdentity(
    retry.retryGroupId,
    'retryGroupId'
  );
  const predecessorOperationId = requiredIdentity(
    retry.predecessorOperationId,
    'predecessorOperationId'
  );
  if (predecessorOperationId === operationId) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_provider_items_invalid',
      `Provider tool item ${itemIndex + 1} cannot retry itself.`
    );
  }
  return {
    retryGroupId,
    predecessorOperationId,
    retryOrdinal,
  };
}

function exactTerminalAnswerText(
  result: Record<string, unknown> | undefined,
  orderedItems: Array<Record<string, unknown>>
): string {
  if (
    !result
    || Object.keys(result).length !== 2
    || !Object.prototype.hasOwnProperty.call(result, 'kind')
    || !Object.prototype.hasOwnProperty.call(result, 'text')
    || result.kind !== 'answer'
    || typeof result.text !== 'string'
    || !result.text.trim()
    || new TextEncoder().encode(result.text).byteLength > 1024 * 1024
    || orderedItems.length === 0
    || orderedItems.some((item) => item.kind !== 'text')
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_terminal_answer_invalid',
      'A terminal Provider answer requires one exact non-empty sealed text response.'
    );
  }
  const textItems = orderedItems as Array<{
    kind: 'text';
    phase: 'commentary' | 'final_answer' | 'unknown';
    text: string;
  }>;
  const firstFinalIndex = textItems.findIndex(
    (item) => item.phase === 'final_answer'
  );
  const lastCommentaryIndex = textItems.findLastIndex(
    (item) => item.phase === 'commentary'
  );
  const finalItems = firstFinalIndex >= 0
    ? textItems.slice(firstFinalIndex)
    : textItems
      .slice(lastCommentaryIndex + 1)
      .filter((item) => item.phase === 'unknown');
  const sealedText = finalItems.map((item) => item.text).join('');
  if (!sealedText.trim() || sealedText !== result.text) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_terminal_answer_mismatch',
      'The public terminal answer differs from the sealed ordered Provider text.'
    );
  }
  return sealedText;
}

function publicProviderOutcome(
  value: unknown
): Record<string, unknown> {
  const outcome = objectRecord(value);
  const permitted = new Set([
    'providerProfileId',
    'provider',
    'model',
    'usage',
  ]);
  if (
    !outcome
    || Object.keys(outcome).some((key) => !permitted.has(key))
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_provider_outcome_invalid',
      'Provider outcome is not an exact safe public metadata record.'
    );
  }
  const providerProfileId = requiredIdentity(
    outcome.providerProfileId,
    'providerProfileId'
  );
  const provider = requiredIdentity(outcome.provider, 'provider');
  const model = requiredIdentity(outcome.model, 'model');
  if (
    outcome.usage !== undefined
    && !objectRecord(outcome.usage)
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_provider_outcome_invalid',
      'Provider usage is not a bounded public counter record.'
    );
  }
  const usage = outcome.usage === undefined
    ? undefined
    : boundedProviderUsageRecordV2(outcome.usage);
  if (
    usage !== undefined
    && canonicalJson(usage) !== canonicalJson(outcome.usage)
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_provider_outcome_invalid',
      'Provider usage is not an exact bounded public counter record.'
    );
  }
  return {
    providerProfileId,
    provider,
    model,
    ...(usage ? { usage } : {}),
  };
}

function publicTerminalScope(
  data: Record<string, unknown> | undefined
): 'turn' | 'providerTurn' | undefined {
  const value = textField(data, 'terminalScope');
  if (
    value !== undefined
    && value !== 'turn'
    && value !== 'providerTurn'
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_terminal_scope_invalid',
      'Session projection terminal scope is invalid.'
    );
  }
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_count_invalid',
      `${field} is not a positive safe integer.`
    );
  }
  return value;
}

function nestedText(
  value: Record<string, unknown> | undefined,
  path: string[]
): string | undefined {
  let current: unknown = value;
  for (const key of path) current = objectRecord(current)?.[key];
  return typeof current === 'string' ? current : undefined;
}

function textField(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function stringArrayField(
  value: Record<string, unknown> | undefined,
  key: string
): string[] {
  const candidate = value?.[key];
  return Array.isArray(candidate)
    ? candidate.filter(
        (item): item is string => typeof item === 'string'
      )
    : [];
}

function objectRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProjectionReply();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidProjectionReply();
  }
  return record;
}

function projectionCount(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw invalidPriorEventsReply();
  }
  return value;
}

function projectionDigest(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(value)
  ) {
    throw invalidPriorEventsReply();
  }
  return value;
}

function requiredIdentity(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 512
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_identity_invalid',
      `${field} is not a valid bounded identity.`
    );
  }
  return value;
}

function assertNoTransportCapabilities(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertNoTransportCapabilities);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'runCapability' || key === 'decisionCapability') {
      throw new SessionKernelProjectionTransportError(
        'session_kernel_projection_secret_forbidden',
        'Transport capabilities cannot enter Session projection.'
      );
    }
    assertNoTransportCapabilities(nested);
  }
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

function invalidApiBase(): SessionKernelProjectionTransportError {
  return new SessionKernelProjectionTransportError(
    'session_kernel_projection_api_base_invalid',
    'Session v2 projection requires an absolute loopback HTTP origin.'
  );
}

function projectionReplyShapeDiagnostic(
  value: unknown,
  projectionId: string,
  projectionDigestValue: string
): string {
  const root = objectRecord(value);
  const data = objectRecord(root?.data);
  return JSON.stringify({
    rootKeys: root ? Object.keys(root).sort() : [],
    dataKeys: data ? Object.keys(data).sort() : [],
    ok: root?.ok === true,
    schemaMatches:
      data?.schemaVersion
      === SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA,
    projectionIdMatches: data?.projectionId === projectionId,
    projectionDigestMatches:
      data?.projectionDigest === projectionDigestValue,
    replayedIsBoolean: typeof data?.replayed === 'boolean',
  });
}

function invalidProjectionReply(
  diagnostic?: string
): SessionKernelProjectionTransportError {
  return new SessionKernelProjectionTransportError(
    'session_kernel_projection_response_invalid',
    diagnostic
      ? `Host returned an invalid Session v2 projection acknowledgement: ${diagnostic}`
      : 'Host returned an invalid Session v2 projection acknowledgement.'
  );
}

function invalidPriorEventsReply(): SessionKernelProjectionTransportError {
  return new SessionKernelProjectionTransportError(
    'host_session_prior_events_response_invalid',
    'Host returned an invalid run-bound prior Session event page.'
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectionDeliveryAbortScope(
  options: SessionKernelProjectionDeliveryOptionsV2 | undefined
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const external = options?.signal;
  const deadlineMs = options?.deadlineMs
    ?? DEFAULT_PROJECTION_DELIVERY_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_deadline_invalid',
      'Session projection delivery deadline must be a positive integer.'
    );
  }
  const abortFromExternal = (): void => {
    controller.abort(
      external?.reason
      ?? new SessionKernelProjectionTransportError(
        'session_kernel_projection_delivery_cancelled',
        'Session projection delivery was cancelled.'
      )
    );
  };
  if (external?.aborted) {
    abortFromExternal();
  } else {
    external?.addEventListener('abort', abortFromExternal, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new SessionKernelProjectionTransportError(
        'session_kernel_projection_delivery_timeout',
        `Session projection delivery exceeded ${deadlineMs}ms.`,
        true
      )
    );
  }, deadlineMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', abortFromExternal);
    },
  };
}

export class SessionKernelProjectionTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'SessionKernelProjectionTransportError';
  }
}
