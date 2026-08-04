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
  AgentTimelineResult,
} from '@deepcode/protocol';
import {
  CanonicalTimelineProjector,
  normalizeAgentTimelineSnapshot,
} from '../timelineDelta.js';
import type {
  SessionKernelHostProjectionSinkV2,
} from './SessionKernelHttpPersistenceV2.js';
import type {
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
  timeline: AgentTimelineResult;
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

export class HttpSessionKernelHostProjectionSinkV2
implements SessionKernelHostProjectionSinkV2 {
  private readonly endpoint: string;
  private readonly priorEventsEndpoint: string;
  private readonly priorTimelineEndpoint: string;
  readonly #runCapability: string;
  private fullPriorSessionEvents?: Promise<AgentEvent[]>;
  private frozenPriorTimeline?: Promise<AgentTimelineResult | undefined>;

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
    projectionHistory: SessionKernelProjectionEventV2[]
  ): Promise<SessionKernelProjectionReceiptV2> {
    assertNoTransportCapabilities(event);
    const projectionId = requiredIdentity(
      event.projectionId,
      'projectionId'
    );
    const agentEvent = sessionKernelAgentEventV2(
      this.sessionId,
      event
    );
    const currentRunAgentEvents = projectionHistory.map(
      (projection) =>
        sessionKernelAgentEventV2(this.sessionId, projection)
    );
    const [priorEvents, priorTimeline] = await Promise.all([
      this.priorEventsForProjection(),
      this.priorTimelineForProjection(),
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
    const timeline: AgentTimelineResult = {
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
      timeline,
    };
    assertNoTransportCapabilities(request);
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
    });
    if (!response.ok) {
      const failure = await projectionHttpFailure(
        response,
        projectionId
      );
      throw new SessionKernelProjectionTransportError(
        failure.code,
        failure.message
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

  private priorEventsForProjection(): Promise<AgentEvent[]> {
    if (this.priorSessionEvents.omittedEventCount === 0) {
      return Promise.resolve(
        cloneJson(this.priorSessionEvents.events)
      );
    }
    if (!this.fullPriorSessionEvents) {
      const loading = this.fetchFrozenPriorEvents();
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

  private priorTimelineForProjection():
  Promise<AgentTimelineResult | undefined> {
    if (this.priorSessionEvents.sourceEventVersion === 0) {
      return Promise.resolve(undefined);
    }
    if (!this.frozenPriorTimeline) {
      const loading = this.fetchFrozenPriorTimeline();
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

  private async fetchFrozenPriorTimeline():
  Promise<AgentTimelineResult> {
    const response = await this.fetchImpl(this.priorTimelineEndpoint, {
      method: 'GET',
      headers: {
        'x-deepcode-run-id': this.runId,
        'x-deepcode-run-capability': this.#runCapability,
      },
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
          ? 'Prior active flat-v2 history cannot be resumed.'
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
      timeline = normalizeAgentTimelineSnapshot(envelope.data).timeline;
    } catch (error) {
      const code = objectRecord(error)?.code;
      throw new SessionKernelProjectionTransportError(
        code === 'UnsupportedHistorySchema'
          ? 'UnsupportedHistorySchema'
          : 'host_session_prior_timeline_invalid',
        code === 'UnsupportedHistorySchema'
          ? 'Prior active flat-v2 history cannot be resumed.'
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

  private async fetchFrozenPriorEvents(): Promise<AgentEvent[]> {
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
    legacyPrefixTurnCount:
      history.legacyPrefixTurnCount ?? 0,
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
  return normalizeAgentTimelineSnapshot(timeline).timeline;
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
): Promise<{ code: string; message: string }> {
  try {
    const envelope = objectRecord(await response.json());
    const error = objectRecord(envelope?.error);
    const code = error?.code;
    const message = error?.message;
    if (
      envelope?.ok === false
      && typeof code === 'string'
      && /^[a-z][a-z0-9_]{0,127}$/u.test(code)
      && typeof message === 'string'
      && message.length > 0
      && new TextEncoder().encode(message).byteLength <= 8_192
    ) {
      return { code, message };
    }
  } catch {
    // Preserve a typed local transport failure when Host returned no JSON.
  }
  return response.status === 409
    ? {
        code: 'session_kernel_projection_identity_conflict',
        message: `Projection ${projectionId} conflicts with Host content.`,
      }
    : {
        code: 'session_kernel_projection_http_failed',
        message:
          `Session v2 projection failed with HTTP ${response.status}.`,
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
      && /^[a-z][a-z0-9_]{0,127}$/u.test(code)
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
  const data = objectRecord(event.data);
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
        kind: 'plan_card',
        channel: 'task',
        visibility: 'both',
        fields: {
          planId: textField(data, 'planRevision'),
          planRevision: textField(data, 'planRevision'),
          title: textField(data, 'title') ?? 'Plan',
          summary: textField(data, 'objective')
            ?? textField(data, 'narrative')
            ?? 'Plan is ready for review.',
          userPlan: textField(data, 'narrative'),
          status: 'running',
          confirmable: false,
          tasks: Array.isArray(data?.actions)
            ? cloneJson(data.actions)
            : [],
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
              ? 'Plan rejected; replanning guidance recorded.'
              : 'Plan revision requested; guidance recorded.',
        },
      };
    }
    case 'scope.previewed':
      if (data?.kind === 'rejected') {
        return rejectedPlanScopePresentation(data);
      }
      return planScopePreviewPresentation(event, data);
    case 'capability.awaiting':
      return permissionRequestPresentation(event, data);
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
          status: data?.status === 'final'
            ? 'completed'
            : 'waitingUserReview',
          revision: data?.revision,
          snapshotHighWater: data?.snapshotHighWater,
          summary: data?.status === 'final'
            ? 'Review finalized from canonical Kernel facts.'
            : 'Review updated from canonical Kernel facts.',
          review: cloneJson(event.data),
        },
      };
    case 'planAction.completed':
      return {
        kind: 'workflow_stage',
        channel: 'task',
        visibility: 'both',
        fields: {
          status: 'completed',
          planActionId: textField(data, 'planActionId'),
          providerTurnId: textField(data, 'providerTurnId'),
          completionKind: textField(data, 'completionKind'),
          summary: 'Plan action completed by the Session provider loop.',
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
        ? decodedOrderedItems.filter(
            (item) =>
              item.kind === 'text'
              && item.phase === 'commentary'
          )
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
          providerTurnId,
          controlEpoch,
          providerOutcome: publicProviderOutcome(data?.providerOutcome),
        },
      };
    }
    case 'provider.started':
      return {
        kind: 'workflow_stage',
        channel: 'progress',
        visibility: 'trace',
        fields: {
          status: 'running',
          providerTurnId: textField(data, 'providerTurnId'),
          controlEpoch: data?.controlEpoch,
          contextAssembly: data?.contextAssembly === undefined
            ? undefined
            : cloneJson(data.contextAssembly),
          summary: 'Session provider turn started.',
        },
      };
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
          message: textField(data, 'message')
            ?? stage
            ?? 'Session Kernel diagnostic.',
        },
      };
    }
    default:
      return {
        kind: 'workflow_stage',
        channel: 'progress',
        visibility: 'trace',
        fields: {
          status: event.kind,
          summary: `Session projection ${event.kind}.`,
        },
      };
  }
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
  event: SessionKernelProjectionEventV2,
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const plan = objectRecord(data?.plan);
  const previews = scopePreviewRecords(data);
  const currentPreview = objectRecord(objectRecord(data?.data)?.preview);
  const planRevision = textField(plan, 'planRevision')
    ?? textField(currentPreview, 'planRevision')
    ?? textField(data, 'planRevision');
  const planId = planRevision ?? event.projectionId;
  const title = textField(plan, 'title') ?? 'Plan';
  const objective = textField(plan, 'objective')
    ?? textField(plan, 'narrative')
    ?? 'Plan is ready for review.';
  const confirmable = planScopePreviewsComplete(plan, previews);
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
      status: confirmable ? 'awaitingUserApproval' : 'running',
      confirmable,
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
    return {
      taskId,
      title: toolId,
      objective: operationId
        ? `operationId=${operationId}`
        : undefined,
      targets: requestedResourceRefs(manifest),
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
          targetRefs: task.targets,
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
    text: `${toolId}: ${summary} [risk=${risk}; effect=${effectClass}/${effectScope}; scopeDigest=${scopeDigest}]`,
    status: textField(preview, 'disposition'),
    targetRefs: stringArrayField(approval, 'canonicalTargets'),
    auditRefs: [
      previewId,
      scopeDigest,
      textField(preview, 'authorizationDigest'),
    ].filter((value): value is string => Boolean(value)),
    metadata: {
      objective: [
        `planActionId=${textField(preview, 'planActionId') ?? 'unknown'}`,
        `operationId=${textField(preview, 'operationId') ?? 'unknown'}`,
        `authorizationDigest=${
          textField(preview, 'authorizationDigest') ?? 'unknown'
        }`,
      ].join('; '),
      acceptance: stringArrayField(approval, 'scopeDelta'),
      failure: [],
    },
  };
}

function requestedResourceRefs(
  manifest: Record<string, unknown> | undefined
): string[] {
  if (!Array.isArray(manifest?.requestedResources)) return [];
  return manifest.requestedResources.flatMap((value) => {
    const resource = objectRecord(value);
    const kind = textField(resource, 'kind');
    const details = objectRecord(resource?.data);
    const target = textField(details, 'path')
      ?? textField(details, 'url')
      ?? textField(details, 'query')
      ?? textField(details, 'invocationDigest')
      ?? textField(details, 'area');
    if (kind && target) return [`${kind}:${target}`];
    return kind ? [kind] : [];
  });
}

function permissionRequestPresentation(
  event: SessionKernelProjectionEventV2,
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const preview = objectRecord(data?.preview)
    ?? objectRecord(objectRecord(data?.data)?.preview);
  const operationId = textField(data, 'operationId')
    ?? textField(preview, 'operationId');
  const previewId = textField(preview, 'previewId')
    ?? event.projectionId;
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
      'status',
      'invocationId',
      'terminalFactId',
      'terminalFactKind',
      'settlementReason',
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
    return {
      kind: 'toolCall',
      ordinal,
      callId: requiredIdentity(item.callId, 'callId'),
      toolName: requiredIdentity(item.toolName, 'toolName'),
      toolId: requiredIdentity(item.toolId, 'toolId'),
      ...(item.operationId === undefined
        ? {}
        : {
            operationId: requiredIdentity(
              item.operationId,
              'operationId'
            ),
          }),
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

export class SessionKernelProjectionTransportError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelProjectionTransportError';
  }
}
