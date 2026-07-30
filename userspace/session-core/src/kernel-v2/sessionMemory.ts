import type {
  AgentEvent,
  AgentEventKind,
  AgentInputAttachmentV2,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  decodeAgentInputAttachmentsV2,
} from './inputAttachmentsV2.js';

export const SESSION_PRIOR_EVENTS_SOURCE_V2_SCHEMA =
  'deepcode.host.session-prior-events.v3' as const;
export const SESSION_CONTEXT_MEMORY_V2_SCHEMA =
  'deepcode.session.context-memory.v2' as const;

const PUBLIC_PROJECTION_V2_SCHEMA =
  'deepcode.session.kernel-public-projection.v2';
const DEFAULT_MAX_ENTRIES = 96;
const DEFAULT_MAX_UTF8_BYTES = 256 * 1024;
const MAX_SOURCE_EVENTS = 512;
const MAX_SOURCE_UTF8_BYTES = 2 * 1024 * 1024;

export interface SessionPriorEventsSourceV2 {
  schemaVersion: typeof SESSION_PRIOR_EVENTS_SOURCE_V2_SCHEMA;
  sessionId: string;
  sourceEventVersion: number;
  selectedEventCount: number;
  omittedEventCount: number;
  events: AgentEvent[];
  sourceEventsDigest: string;
  eventsDigest: string;
  snapshotDigest: string;
}

export interface SessionContextMemoryEntryV2 {
  sourceEventId: string;
  sourceRunId?: string;
  recordedAt: string;
  role: 'user' | 'assistant';
  text: string;
  attachments: AgentInputAttachmentV2[];
}

export interface SessionContextMemoryV2 {
  schemaVersion: typeof SESSION_CONTEXT_MEMORY_V2_SCHEMA;
  sessionId: string;
  sourceEventVersion: number;
  sourceEventCount: number;
  omittedEntryCount: number;
  truncated: boolean;
  entries: SessionContextMemoryEntryV2[];
  contextDigest: string;
}

export interface BuildSessionContextMemoryV2Input {
  source: SessionPriorEventsSourceV2;
  excludeRunId?: string;
  maxEntries?: number;
  maxUtf8Bytes?: number;
}

/**
 * Strictly decodes the immutable raw AgentEvent source frozen by Host before
 * RunOpen. Host does not interpret memory semantics; Session alone decides
 * which exact public v2 conversation events are prompt context.
 */
export function decodeSessionPriorEventsSourceV2(
  value: unknown
): SessionPriorEventsSourceV2 {
  const discriminator = (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  )
    ? (value as Record<string, unknown>).schemaVersion
    : undefined;
  if (discriminator !== SESSION_PRIOR_EVENTS_SOURCE_V2_SCHEMA) {
    throw invalidMemory(
      'unsupported_history_schema',
      'UnsupportedHistorySchema: prior Session events use an unsupported schema.'
    );
  }
  const record = exactObject(value, [
    'schemaVersion',
    'sessionId',
    'sourceEventVersion',
    'selectedEventCount',
    'omittedEventCount',
    'events',
    'sourceEventsDigest',
    'eventsDigest',
    'snapshotDigest',
  ]);
  const sessionId = identity(record.sessionId, 'sessionId');
  const sourceEventVersion = safeCount(
    record.sourceEventVersion,
    'sourceEventVersion'
  );
  const selectedEventCount = safeCount(
    record.selectedEventCount,
    'selectedEventCount'
  );
  const omittedEventCount = safeCount(
    record.omittedEventCount,
    'omittedEventCount'
  );
  if (
    !Array.isArray(record.events)
    || record.events.length !== selectedEventCount
    || selectedEventCount > MAX_SOURCE_EVENTS
    || selectedEventCount + omittedEventCount !== sourceEventVersion
  ) {
    throw invalidMemory(
      'session_prior_events_count_invalid',
      'Prior Session event counts do not describe the exact bounded source.'
    );
  }
  const events = record.events.map((event) =>
    decodeSessionPriorAgentEventV2(event, sessionId)
  );
  if (utf8Bytes(canonicalJson(events)) > MAX_SOURCE_UTF8_BYTES) {
    throw invalidMemory(
      'session_prior_events_too_large',
      'Prior Session event source exceeds the Session bound.'
    );
  }
  const eventsDigest = sha256Digest(
    record.eventsDigest,
    'eventsDigest'
  );
  if (eventsDigest !== sha256Hash(canonicalJson(events))) {
    throw invalidMemory(
      'session_prior_events_digest_mismatch',
      'Prior Session events failed exact digest verification.'
    );
  }
  const sourceEventsDigest = sha256Digest(
    record.sourceEventsDigest,
    'sourceEventsDigest'
  );
  if (
    omittedEventCount === 0
    && sourceEventsDigest !== eventsDigest
  ) {
    throw invalidMemory(
      'session_prior_events_source_digest_mismatch',
      'Complete prior Session events do not match their frozen source digest.'
    );
  }
  const withoutSnapshotDigest = {
    schemaVersion: SESSION_PRIOR_EVENTS_SOURCE_V2_SCHEMA,
    sessionId,
    sourceEventVersion,
    selectedEventCount,
    omittedEventCount,
    events,
    sourceEventsDigest,
    eventsDigest,
  };
  const snapshotDigest = sha256Digest(
    record.snapshotDigest,
    'snapshotDigest'
  );
  if (
    snapshotDigest
      !== sha256Hash(canonicalJson(withoutSnapshotDigest))
  ) {
    throw invalidMemory(
      'session_prior_events_snapshot_digest_mismatch',
      'Prior Session event snapshot failed exact digest verification.'
    );
  }
  return {
    ...withoutSnapshotDigest,
    snapshotDigest,
  };
}

/**
 * Strictly decodes one public AgentEvent without applying the model-memory
 * source bound. The projection transport uses this for the run-bound frozen
 * prefix; prompt memory continues to use decodeSessionPriorEventsSourceV2.
 */
export function decodeSessionPriorAgentEventV2(
  value: unknown,
  expectedSessionId: string
): AgentEvent {
  return decodeSourceEvent(value, expectedSessionId);
}

/**
 * Builds untrusted model context from Session-owned public conversation facts
 * only. This value never carries authority, approval, effect, or execution
 * success semantics.
 */
export function buildSessionContextMemoryV2(
  input: BuildSessionContextMemoryV2Input
): SessionContextMemoryV2 {
  const source = decodeSessionPriorEventsSourceV2(input.source);
  const maxEntries = boundedPositiveInteger(
    input.maxEntries,
    DEFAULT_MAX_ENTRIES
  );
  const maxUtf8Bytes = boundedPositiveInteger(
    input.maxUtf8Bytes,
    DEFAULT_MAX_UTF8_BYTES
  );
  const candidates = source.events.flatMap(
    (event): SessionContextMemoryEntryV2[] => {
      const entry = memoryEntry(event, input.excludeRunId);
      return entry ? [entry] : [];
    }
  );
  const selected: SessionContextMemoryEntryV2[] = [];
  let selectedBytes = utf8Bytes('[]');
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (selected.length >= maxEntries) break;
    const candidate = candidates[index]!;
    const candidateBytes = utf8Bytes(canonicalJson(candidate));
    if (selectedBytes + candidateBytes > maxUtf8Bytes) break;
    selected.unshift(candidate);
    selectedBytes += candidateBytes;
  }
  const omittedEntryCount = candidates.length - selected.length;
  const withoutDigest = {
    schemaVersion: SESSION_CONTEXT_MEMORY_V2_SCHEMA,
    sessionId: source.sessionId,
    sourceEventVersion: source.sourceEventVersion,
    sourceEventCount: candidates.length,
    omittedEntryCount,
    truncated: omittedEntryCount > 0
      || source.omittedEventCount > 0,
    entries: selected,
  };
  return {
    ...withoutDigest,
    contextDigest: sha256Hash(canonicalJson(withoutDigest)),
  };
}

export function validateSessionContextMemoryV2(
  memory: SessionContextMemoryV2
): void {
  if (
    memory.schemaVersion !== SESSION_CONTEXT_MEMORY_V2_SCHEMA
    || !memory.sessionId
    || !Number.isSafeInteger(memory.sourceEventVersion)
    || memory.sourceEventVersion < 0
    || !Number.isSafeInteger(memory.sourceEventCount)
    || memory.sourceEventCount < 0
    || !Number.isSafeInteger(memory.omittedEntryCount)
    || memory.omittedEntryCount < 0
    || typeof memory.truncated !== 'boolean'
    || !Array.isArray(memory.entries)
    || memory.entries.length + memory.omittedEntryCount
      !== memory.sourceEventCount
  ) {
    throw invalidMemory(
      'session_context_memory_invalid',
      'Session context memory has an invalid exact v2 shape.'
    );
  }
  for (const entry of memory.entries) {
    const record = exactObject(
      entry,
      [
        'sourceEventId',
        'recordedAt',
        'role',
        'text',
        'attachments',
      ],
      ['sourceRunId']
    );
    identity(record.sourceEventId, 'sourceEventId');
    if (record.sourceRunId !== undefined) {
      identity(record.sourceRunId, 'sourceRunId');
    }
    const recordedAt = boundedText(
      record.recordedAt,
      'recordedAt',
      1024
    );
    if (
      !Number.isFinite(Date.parse(recordedAt))
      || (record.role !== 'user' && record.role !== 'assistant')
    ) {
      throw invalidMemory(
        'session_context_memory_entry_invalid',
        'Session context memory entry has invalid provenance.'
      );
    }
    boundedText(record.text, 'text', 1024 * 1024);
    if (!Array.isArray(record.attachments)) {
      throw invalidMemory(
        'session_context_memory_entry_invalid',
        'Session context memory attachments must be an array.'
      );
    }
    // Cross-Run memory never promotes historical message attachments.
    if (decodeAgentInputAttachmentsV2(record.attachments).length !== 0) {
      throw invalidMemory(
        'session_context_memory_attachment_forbidden',
        'Prior-session context memory cannot carry active attachments.'
      );
    }
  }
  const withoutDigest = {
    schemaVersion: SESSION_CONTEXT_MEMORY_V2_SCHEMA,
    sessionId: memory.sessionId,
    sourceEventVersion: memory.sourceEventVersion,
    sourceEventCount: memory.sourceEventCount,
    omittedEntryCount: memory.omittedEntryCount,
    truncated: memory.truncated,
    entries: memory.entries,
  };
  if (
    sha256Digest(memory.contextDigest, 'contextDigest')
      !== sha256Hash(canonicalJson(withoutDigest))
  ) {
    throw invalidMemory(
      'session_context_memory_digest_mismatch',
      'Session context memory failed exact digest verification.'
    );
  }
}

function decodeSourceEvent(
  value: unknown,
  sessionId: string
): AgentEvent {
  const record = exactObject(value, [
    'id',
    'sessionId',
    'ts',
    'kind',
    'payload',
  ]);
  const id = identity(record.id, 'event.id');
  if (!id.startsWith('kernel-v2:')) {
    throw invalidMemory(
      'session_prior_event_identity_invalid',
      'Prior Session event is not a public v2 event.'
    );
  }
  if (identity(record.sessionId, 'event.sessionId') !== sessionId) {
    throw invalidMemory(
      'session_prior_event_session_mismatch',
      'Prior Session event belongs to another Session.'
    );
  }
  const ts = boundedText(record.ts, 'event.ts', 1024);
  if (!Number.isFinite(Date.parse(ts))) {
    throw invalidMemory(
      'session_prior_event_time_invalid',
      'Prior Session event has an invalid timestamp.'
    );
  }
  const kind = eventKind(record.kind);
  if (kind === 'user_msg' || kind === 'assistant_msg') {
    decodeConversationPayload(record.payload, kind);
  }
  return {
    id,
    sessionId,
    ts,
    kind,
    payload: cloneJson(record.payload),
  };
}

function memoryEntry(
  event: AgentEvent,
  excludeRunId?: string
): SessionContextMemoryEntryV2 | undefined {
  if (event.kind !== 'user_msg' && event.kind !== 'assistant_msg') {
    return undefined;
  }
  const payload = decodeConversationPayload(event.payload, event.kind);
  if (excludeRunId && payload.runId === excludeRunId) {
    return undefined;
  }
  const text = boundedText(payload.content, 'content', 1024 * 1024);
  if (!text.trim()) return undefined;
  return {
    sourceEventId: event.id,
    sourceRunId: payload.runId,
    recordedAt: event.ts,
    role: event.kind === 'user_msg' ? 'user' : 'assistant',
    text,
    // Historical message attachments are not an active Session resource set.
    // Decode them strictly to reject malformed history, but never promote them
    // across Runs without an independent durable attachment snapshot/tombstone
    // contract.
    attachments: [],
  };
}

function decodeConversationPayload(
  value: unknown,
  kind: 'user_msg' | 'assistant_msg'
): {
  runId: string;
  content: unknown;
  attachments: unknown;
} {
  const common = [
    'schemaVersion',
    'projectionId',
    'runId',
    'projectionKind',
    'channel',
    'visibility',
    'content',
    'controlEpoch',
  ];
  const record = exactObject(
    value,
    kind === 'user_msg'
      ? [...common, 'inputId', 'attachments']
      : [
          ...common,
          'status',
          'outputKind',
          'providerTurnId',
          'providerOutcome',
        ],
    kind === 'user_msg'
      ? []
      : ['status', 'providerOutcome']
  );
  if (
    record.schemaVersion !== PUBLIC_PROJECTION_V2_SCHEMA
    || (
      kind === 'user_msg'
        ? record.projectionKind !== 'input.persisted'
        : record.projectionKind !== 'provider.completed'
    )
  ) {
    throw invalidMemory(
      'session_prior_event_projection_schema_unsupported',
      'Prior conversation event is not the exact public v2 projection.'
    );
  }
  if (kind === 'user_msg') {
    decodeAgentInputAttachmentsV2(record.attachments);
  }
  return {
    runId: identity(record.runId, 'payload.runId'),
    content: record.content,
    attachments: kind === 'user_msg'
      ? record.attachments
      : [],
  };
}

function eventKind(value: unknown): AgentEventKind {
  const kinds = new Set<AgentEventKind>([
    'user_msg',
    'assistant_msg',
    'plan_card',
    'plan_review',
    'review_summary',
    'tool_call',
    'tool_result',
    'permission_request',
    'permission_result',
    'session_run_state',
    'workflow_stage',
    'error',
  ]);
  if (typeof value !== 'string' || !kinds.has(value as AgentEventKind)) {
    throw invalidMemory(
      'session_prior_event_kind_invalid',
      'Prior Session event kind is not part of the v2 public protocol.'
    );
  }
  return value as AgentEventKind;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidMemory(
      'session_prior_event_shape_invalid',
      'Prior Session memory material must be an exact object.'
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw invalidMemory(
      'session_prior_event_shape_invalid',
      'Prior Session memory material contains missing or unsupported fields.'
    );
  }
  return record;
}

function identity(value: unknown, field: string): string {
  return boundedText(value, field, 64 * 1024, true);
}

function boundedText(
  value: unknown,
  field: string,
  maximumBytes: number,
  requireTrimmed = false
): string {
  if (
    typeof value !== 'string'
    || !value
    || utf8Bytes(value) > maximumBytes
    || value.includes('\0')
    || (requireTrimmed && value.trim() !== value)
  ) {
    throw invalidMemory(
      'session_prior_event_text_invalid',
      `${field} must be bounded text.`
    );
  }
  return value;
}

function safeCount(value: unknown, field: string): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < 0
    || Number(value) > 1_000_000_000
  ) {
    throw invalidMemory(
      'session_prior_event_count_invalid',
      `${field} must be a non-negative safe integer.`
    );
  }
  return Number(value);
}

function sha256Digest(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(value)
  ) {
    throw invalidMemory(
      'session_prior_event_digest_invalid',
      `${field} must be a canonical SHA-256 digest.`
    );
  }
  return value;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number
): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function invalidMemory(
  code: string,
  message: string
): SessionMemoryErrorV2 {
  return new SessionMemoryErrorV2(code, message);
}

export class SessionMemoryErrorV2 extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionMemoryErrorV2';
  }
}
