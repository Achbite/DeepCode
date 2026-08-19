import type {
  AgentEvent,
  AgentEventKind,
  AgentInputAttachmentV3,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  decodeAgentInputAttachmentsV3,
} from './inputAttachmentsV2.js';
import {
  SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2,
} from './factKinds.js';

export const SESSION_PRIOR_EVENTS_SOURCE_V2_SCHEMA =
  'deepcode.host.session-prior-events.v3' as const;
export const SESSION_CONTEXT_MEMORY_V3_SCHEMA =
  'deepcode.session.context-memory.v3' as const;
export const SESSION_PROVIDER_CONVERSATION_HEAD_V1_SCHEMA =
  'deepcode.session.provider-conversation-head.v1' as const;

const PUBLIC_PROJECTION_V2_SCHEMA =
  'deepcode.session.kernel-public-projection.v2';
const DEFAULT_MAX_ENTRIES = 96;
const DEFAULT_MAX_UTF8_BYTES = 256 * 1024;
const MAX_HISTORICAL_READ_CANDIDATES = 256;
const MAX_HISTORICAL_READ_CANDIDATE_BYTES = 128 * 1024;
const MAX_HISTORICAL_READ_RESOURCE_REFS = 64;
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
  attachments: AgentInputAttachmentV3[];
}

export interface SessionHistoricalReadCandidateV1 {
  sourceEventId: string;
  sourceEventDigest: string;
  sourceEventVersion: number;
  sourceRunId: string;
  sourceFactId: string;
  sourceControlEpoch: number;
  sourceOperationId: string;
  toolId: string;
  resourceRefs: string[];
  subjectDigest: string;
  sourceEvidenceDigest: string;
  candidateDigest: string;
}

export interface SessionProviderConversationHeadV1 {
  schemaVersion: typeof SESSION_PROVIDER_CONVERSATION_HEAD_V1_SCHEMA;
  sessionId: string;
  runId: string;
  userTurnId: string;
  providerTurnId: string;
  controlEpoch: number;
  sourceEventId: string;
  sourceEventVersion: number;
  sourceEventDigest: string;
  providerProfileId: string;
  provider: string;
  model: string;
  answerDigest: string;
  headDigest: string;
}

export interface SessionContextMemoryV3 {
  schemaVersion: typeof SESSION_CONTEXT_MEMORY_V3_SCHEMA;
  sessionId: string;
  sourceEventVersion: number;
  sourceEventCount: number;
  omittedEntryCount: number;
  truncated: boolean;
  entries: SessionContextMemoryEntryV2[];
  historicalReadCandidateCount: number;
  omittedHistoricalReadCandidateCount: number;
  historicalReadCandidates: SessionHistoricalReadCandidateV1[];
  providerConversationHead?: SessionProviderConversationHeadV1;
  contextDigest: string;
}

export interface BuildSessionContextMemoryV3Input {
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
export function buildSessionContextMemoryV3(
  input: BuildSessionContextMemoryV3Input
): SessionContextMemoryV3 {
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
  const allHistoricalReadCandidates = source.events.flatMap(
    (event, index) => historicalReadCandidatesV1(
      event,
      source.omittedEventCount + index + 1,
      input.excludeRunId
    )
  );
  const historicalReadCandidates: SessionHistoricalReadCandidateV1[] = [];
  let historicalReadCandidateBytes = utf8Bytes('[]');
  for (
    let index = allHistoricalReadCandidates.length - 1;
    index >= 0;
    index -= 1
  ) {
    if (
      historicalReadCandidates.length
        >= MAX_HISTORICAL_READ_CANDIDATES
    ) break;
    const candidate = allHistoricalReadCandidates[index]!;
    const candidateBytes = utf8Bytes(canonicalJson(candidate));
    if (
      historicalReadCandidateBytes + candidateBytes
        > MAX_HISTORICAL_READ_CANDIDATE_BYTES
    ) break;
    historicalReadCandidates.unshift(candidate);
    historicalReadCandidateBytes += candidateBytes;
  }
  const omittedHistoricalReadCandidateCount =
    allHistoricalReadCandidates.length - historicalReadCandidates.length;
  const providerConversationHead = buildProviderConversationHeadV1(
    source,
    input.excludeRunId
  );
  const withoutDigest = {
    schemaVersion: SESSION_CONTEXT_MEMORY_V3_SCHEMA,
    sessionId: source.sessionId,
    sourceEventVersion: source.sourceEventVersion,
    sourceEventCount: candidates.length,
    omittedEntryCount,
    truncated: omittedEntryCount > 0
      || source.omittedEventCount > 0,
    entries: selected,
    historicalReadCandidateCount: allHistoricalReadCandidates.length,
    omittedHistoricalReadCandidateCount,
    historicalReadCandidates,
    ...(providerConversationHead
      ? { providerConversationHead }
      : {}),
  };
  return {
    ...withoutDigest,
    contextDigest: sha256Hash(canonicalJson(withoutDigest)),
  };
}

export function validateSessionContextMemoryV3(
  memory: SessionContextMemoryV3
): void {
  if (
    memory.schemaVersion !== SESSION_CONTEXT_MEMORY_V3_SCHEMA
    || !memory.sessionId
    || !Number.isSafeInteger(memory.sourceEventVersion)
    || memory.sourceEventVersion < 0
    || !Number.isSafeInteger(memory.sourceEventCount)
    || memory.sourceEventCount < 0
    || !Number.isSafeInteger(memory.omittedEntryCount)
    || memory.omittedEntryCount < 0
    || typeof memory.truncated !== 'boolean'
    || !Array.isArray(memory.entries)
    || !Number.isSafeInteger(memory.historicalReadCandidateCount)
    || memory.historicalReadCandidateCount < 0
    || !Number.isSafeInteger(memory.omittedHistoricalReadCandidateCount)
    || memory.omittedHistoricalReadCandidateCount < 0
    || !Array.isArray(memory.historicalReadCandidates)
    || memory.historicalReadCandidates.length
      + memory.omittedHistoricalReadCandidateCount
      !== memory.historicalReadCandidateCount
    || memory.historicalReadCandidates.length
      > MAX_HISTORICAL_READ_CANDIDATES
    || memory.entries.length + memory.omittedEntryCount
      !== memory.sourceEventCount
  ) {
    throw invalidMemory(
      'session_context_memory_invalid',
      'Session context memory has an invalid exact v3 shape.'
    );
  }
  if (memory.providerConversationHead !== undefined) {
    validateProviderConversationHeadV1(
      memory.providerConversationHead,
      memory.sessionId,
      memory.sourceEventVersion
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
    if (decodeAgentInputAttachmentsV3(record.attachments).length !== 0) {
      throw invalidMemory(
        'session_context_memory_attachment_forbidden',
        'Prior-session context memory cannot carry active attachments.'
      );
    }
  }
  memory.historicalReadCandidates.forEach(
    validateHistoricalReadCandidateV1
  );
  const withoutDigest = {
    schemaVersion: SESSION_CONTEXT_MEMORY_V3_SCHEMA,
    sessionId: memory.sessionId,
    sourceEventVersion: memory.sourceEventVersion,
    sourceEventCount: memory.sourceEventCount,
    omittedEntryCount: memory.omittedEntryCount,
    truncated: memory.truncated,
    entries: memory.entries,
    historicalReadCandidateCount:
      memory.historicalReadCandidateCount,
    omittedHistoricalReadCandidateCount:
      memory.omittedHistoricalReadCandidateCount,
    historicalReadCandidates: memory.historicalReadCandidates,
    ...(memory.providerConversationHead
      ? {
          providerConversationHead:
            memory.providerConversationHead,
        }
      : {}),
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

function buildProviderConversationHeadV1(
  source: SessionPriorEventsSourceV2,
  excludeRunId?: string
): SessionProviderConversationHeadV1 | undefined {
  for (let index = source.events.length - 1; index >= 0; index -= 1) {
    const event = source.events[index]!;
    if (event.kind !== 'assistant_msg') continue;
    const payload = decodeConversationPayload(
      event.payload,
      'assistant_msg'
    );
    if (
      payload.projectionKind !== 'provider.completed'
      || (excludeRunId && payload.runId === excludeRunId)
    ) continue;
    const record = event.payload as Record<string, unknown>;
    if (
      record.answerState !== undefined
      && record.answerState !== 'committed'
    ) continue;
    const providerOutcome = exactObject(
      record.providerOutcome,
      ['providerProfileId', 'provider', 'model'],
      ['usage']
    );
    const input = precedingRunInputV1(
      source.events,
      index,
      payload.runId
    );
    if (!input) continue;
    const withoutDigest = {
      schemaVersion: SESSION_PROVIDER_CONVERSATION_HEAD_V1_SCHEMA,
      sessionId: source.sessionId,
      runId: payload.runId,
      userTurnId: input.inputId,
      providerTurnId: identity(
        record.providerTurnId,
        'providerTurnId'
      ),
      controlEpoch: safePositiveCount(
        record.controlEpoch,
        'controlEpoch'
      ),
      sourceEventId: event.id,
      sourceEventVersion: source.omittedEventCount + index + 1,
      sourceEventDigest: sha256Hash(canonicalJson(event)),
      providerProfileId: identity(
        providerOutcome.providerProfileId,
        'providerProfileId'
      ),
      provider: identity(providerOutcome.provider, 'provider'),
      model: identity(providerOutcome.model, 'model'),
      answerDigest: sha256Hash(
        providerCompletedMemoryText(record)
      ),
    };
    return {
      ...withoutDigest,
      headDigest: sha256Hash(canonicalJson(withoutDigest)),
    };
  }
  return undefined;
}

function precedingRunInputV1(
  events: readonly AgentEvent[],
  beforeIndex: number,
  runId: string
): { inputId: string } | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== 'user_msg') continue;
    const payload = decodeConversationPayload(event.payload, 'user_msg');
    if (payload.runId !== runId) continue;
    return {
      inputId: identity(
        (event.payload as Record<string, unknown>).inputId,
        'inputId'
      ),
    };
  }
  return undefined;
}

function validateProviderConversationHeadV1(
  head: SessionProviderConversationHeadV1,
  expectedSessionId: string,
  maximumSourceVersion: number
): void {
  const record = exactObject(head, [
    'schemaVersion',
    'sessionId',
    'runId',
    'userTurnId',
    'providerTurnId',
    'controlEpoch',
    'sourceEventId',
    'sourceEventVersion',
    'sourceEventDigest',
    'providerProfileId',
    'provider',
    'model',
    'answerDigest',
    'headDigest',
  ]);
  if (
    record.schemaVersion
      !== SESSION_PROVIDER_CONVERSATION_HEAD_V1_SCHEMA
    || identity(record.sessionId, 'head.sessionId')
      !== expectedSessionId
  ) {
    throw invalidMemory(
      'session_provider_conversation_head_invalid',
      'Provider conversation head has an invalid schema or Session identity.'
    );
  }
  for (const field of [
    'runId',
    'userTurnId',
    'providerTurnId',
    'sourceEventId',
    'providerProfileId',
    'provider',
    'model',
  ] as const) identity(record[field], `head.${field}`);
  const controlEpoch = safePositiveCount(
    record.controlEpoch,
    'head.controlEpoch'
  );
  const sourceEventVersion = safePositiveCount(
    record.sourceEventVersion,
    'head.sourceEventVersion'
  );
  if (
    controlEpoch <= 0
    || sourceEventVersion > maximumSourceVersion
  ) {
    throw invalidMemory(
      'session_provider_conversation_head_invalid',
      'Provider conversation head exceeds its frozen source bounds.'
    );
  }
  for (const field of [
    'sourceEventDigest',
    'answerDigest',
    'headDigest',
  ] as const) sha256Digest(record[field], `head.${field}`);
  const withoutDigest = {
    schemaVersion: SESSION_PROVIDER_CONVERSATION_HEAD_V1_SCHEMA,
    sessionId: record.sessionId,
    runId: record.runId,
    userTurnId: record.userTurnId,
    providerTurnId: record.providerTurnId,
    controlEpoch,
    sourceEventId: record.sourceEventId,
    sourceEventVersion,
    sourceEventDigest: record.sourceEventDigest,
    providerProfileId: record.providerProfileId,
    provider: record.provider,
    model: record.model,
    answerDigest: record.answerDigest,
  };
  if (
    record.headDigest !== sha256Hash(canonicalJson(withoutDigest))
  ) {
    throw invalidMemory(
      'session_provider_conversation_head_digest_mismatch',
      'Provider conversation head failed exact digest verification.'
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

function historicalReadCandidatesV1(
  event: AgentEvent,
  sourceEventVersion: number,
  excludeRunId?: string
): SessionHistoricalReadCandidateV1[] {
  if (
    event.kind !== 'tool_result'
    || !event.payload
    || typeof event.payload !== 'object'
    || Array.isArray(event.payload)
  ) return [];
  const payload = event.payload as Record<string, unknown>;
  if (
    payload.schemaVersion !== PUBLIC_PROJECTION_V2_SCHEMA
    || payload.projectionKind !== 'kernelFacts.reconciled'
    || typeof payload.runId !== 'string'
    || !payload.runId
    || payload.runId === excludeRunId
    || !Array.isArray(payload.operationFacts)
    || !Number.isSafeInteger(sourceEventVersion)
    || sourceEventVersion <= 0
  ) return [];
  const sourceRunId = payload.runId as string;
  const sourceEventDigest = sha256Hash(canonicalJson(event));
  return payload.operationFacts.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [];
    }
    const fact = value as Record<string, unknown>;
    const readEvidence = fact.readEvidence;
    if (
      !readEvidence
      || typeof readEvidence !== 'object'
      || Array.isArray(readEvidence)
    ) return [];
    const read = readEvidence as Record<string, unknown>;
    const resourceRefs = Array.isArray(read.resourceRefs)
      ? [...new Set(read.resourceRefs.filter(
          (resourceRef): resourceRef is string =>
            typeof resourceRef === 'string' && resourceRef.length > 0
        ))].sort()
      : [];
    const subjectDigest = typeof read.subjectDigest === 'string'
      ? read.subjectDigest
      : undefined;
    if (
      fact.domain !== 'effect'
      || typeof fact.factKind !== 'string'
      || !SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2.has(fact.factKind)
      || read.authorityKind !== 'read'
      || typeof fact.factId !== 'string'
      || !fact.factId
      || typeof fact.operationId !== 'string'
      || !fact.operationId
      || typeof fact.toolId !== 'string'
      || !fact.toolId
      || read.toolId !== fact.toolId
      || !subjectDigest
      || !/^sha256:[0-9a-f]{64}$/u.test(subjectDigest)
      || !Number.isSafeInteger(read.controlEpoch)
      || Number(read.controlEpoch) <= 0
      || typeof read.evidenceDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(read.evidenceDigest)
      || resourceRefs.length === 0
      || resourceRefs.length > MAX_HISTORICAL_READ_RESOURCE_REFS
    ) return [];
    const withoutDigest = {
      sourceEventId: event.id,
      sourceEventDigest,
      sourceEventVersion,
      sourceRunId,
      sourceFactId: fact.factId,
      sourceControlEpoch: Number(read.controlEpoch),
      sourceOperationId: fact.operationId,
      toolId: fact.toolId,
      resourceRefs,
      subjectDigest,
      sourceEvidenceDigest: read.evidenceDigest,
    };
    return [{
      ...withoutDigest,
      candidateDigest: sha256Hash(canonicalJson(withoutDigest)),
    }];
  });
}

function validateHistoricalReadCandidateV1(
  value: SessionHistoricalReadCandidateV1
): void {
  const record = exactObject(value, [
    'sourceEventId',
    'sourceEventDigest',
    'sourceEventVersion',
    'sourceRunId',
    'sourceFactId',
    'sourceControlEpoch',
    'sourceOperationId',
    'toolId',
    'resourceRefs',
    'subjectDigest',
    'sourceEvidenceDigest',
    'candidateDigest',
  ]);
  identity(record.sourceEventId, 'historicalRead.sourceEventId');
  identity(record.sourceRunId, 'historicalRead.sourceRunId');
  identity(record.sourceFactId, 'historicalRead.sourceFactId');
  identity(record.sourceOperationId, 'historicalRead.sourceOperationId');
  identity(record.toolId, 'historicalRead.toolId');
  sha256Digest(
    record.sourceEventDigest,
    'historicalRead.sourceEventDigest'
  );
  sha256Digest(
    record.subjectDigest,
    'historicalRead.subjectDigest'
  );
  sha256Digest(
    record.sourceEvidenceDigest,
    'historicalRead.sourceEvidenceDigest'
  );
  const candidateDigest = sha256Digest(
    record.candidateDigest,
    'historicalRead.candidateDigest'
  );
  const sourceEventVersion = safePositiveCount(
    record.sourceEventVersion,
    'historicalRead.sourceEventVersion'
  );
  const sourceControlEpoch = safePositiveCount(
    record.sourceControlEpoch,
    'historicalRead.sourceControlEpoch'
  );
  if (
    !Array.isArray(record.resourceRefs)
    || record.resourceRefs.length === 0
    || record.resourceRefs.length > MAX_HISTORICAL_READ_RESOURCE_REFS
  ) {
    throw invalidMemory(
      'session_context_memory_historical_read_invalid',
      'Historical read candidate must bind a bounded resource set.'
    );
  }
  const resourceRefs = record.resourceRefs.map((resourceRef) =>
    identity(resourceRef, 'historicalRead.resourceRef')
  );
  if (
    new Set(resourceRefs).size !== resourceRefs.length
    || resourceRefs.some((resourceRef, index) =>
      index > 0 && resourceRefs[index - 1]! >= resourceRef
    )
  ) {
    throw invalidMemory(
      'session_context_memory_historical_read_invalid',
      'Historical read candidate resource identities must be sorted and unique.'
    );
  }
  const withoutDigest = {
    sourceEventId: record.sourceEventId,
    sourceEventDigest: record.sourceEventDigest,
    sourceEventVersion,
    sourceRunId: record.sourceRunId,
    sourceFactId: record.sourceFactId,
    sourceControlEpoch,
    sourceOperationId: record.sourceOperationId,
    toolId: record.toolId,
    resourceRefs,
    subjectDigest: record.subjectDigest,
    sourceEvidenceDigest: record.sourceEvidenceDigest,
  };
  if (candidateDigest !== sha256Hash(canonicalJson(withoutDigest))) {
    throw invalidMemory(
      'session_context_memory_historical_read_digest_mismatch',
      'Historical read candidate failed exact digest verification.'
    );
  }
}

function memoryEntry(
  event: AgentEvent,
  excludeRunId?: string
): SessionContextMemoryEntryV2 | undefined {
  if (event.kind !== 'user_msg' && event.kind !== 'assistant_msg') {
    return undefined;
  }
  const payload = decodeConversationPayload(event.payload, event.kind);
  if (payload.projectionKind === 'provider.composing') {
    return undefined;
  }
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
  projectionKind: 'input.persisted' | 'provider.composing' | 'provider.completed';
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
    'controlEpoch',
  ];
  const projectionKind = (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
  )
    ? (value as Record<string, unknown>).projectionKind
    : undefined;
  const record = exactObject(
    value,
    kind === 'user_msg'
      ? [...common, 'content', 'inputId', 'attachments']
      : projectionKind === 'provider.composing'
        ? [
            ...common,
            'content',
            'status',
            'providerTurnId',
            'streamSequence',
            'textOrdinal',
          ]
        : [
            ...common,
            'status',
            'outputKind',
            'providerTurnId',
            'terminalScope',
            'orderedItems',
            'providerOutcome',
          ],
    kind === 'assistant_msg'
      && projectionKind === 'provider.composing'
      ? ['providerPhase']
      : kind === 'user_msg'
        ? []
        : [
            'status',
            'providerOutcome',
            'reviewRevision',
            'snapshotHighWater',
            'answerState',
          ]
  );
  if (
    record.schemaVersion !== PUBLIC_PROJECTION_V2_SCHEMA
    || (
      kind === 'user_msg'
        ? record.projectionKind !== 'input.persisted'
        : record.projectionKind !== 'provider.composing'
          && record.projectionKind !== 'provider.completed'
    )
  ) {
    throw invalidMemory(
      'session_prior_event_projection_schema_unsupported',
      'Prior conversation event is not the exact public v2 projection.'
    );
  }
  if (kind === 'user_msg') {
    decodeAgentInputAttachmentsV3(record.attachments);
  } else if (record.projectionKind === 'provider.composing') {
    const composingText = boundedText(
      record.content,
      'provider.composing.content',
      1024 * 1024
    );
    if (
      record.channel !== 'progress'
      || record.visibility !== 'conversation'
      || record.status !== 'running'
      || !Number.isSafeInteger(record.controlEpoch)
      || Number(record.controlEpoch) <= 0
      || !Number.isSafeInteger(record.streamSequence)
      || Number(record.streamSequence) <= 0
      || !Number.isSafeInteger(record.textOrdinal)
      || Number(record.textOrdinal) <= 0
      || (
        record.providerPhase !== undefined
        && record.providerPhase !== 'commentary'
        && record.providerPhase !== 'final_answer'
      )
      || composingText.length === 0
    ) {
      throw invalidMemory(
        'session_prior_event_projection_schema_unsupported',
        'Prior Provider composing event is not an exact safe text delta.'
      );
    }
    identity(record.providerTurnId, 'providerTurnId');
  } else {
    const hasReviewRevision = record.reviewRevision !== undefined;
    const hasSnapshotHighWater =
      record.snapshotHighWater !== undefined;
    if (
      hasReviewRevision !== hasSnapshotHighWater
      || (
        hasReviewRevision
        && (
          !Number.isSafeInteger(record.reviewRevision)
          || Number(record.reviewRevision) <= 0
          || !Number.isSafeInteger(record.snapshotHighWater)
          || Number(record.snapshotHighWater) < 0
        )
      )
    ) {
      throw invalidMemory(
        'session_prior_event_projection_schema_unsupported',
        'Prior final answer has an invalid Review fact binding.'
      );
    }
    if (
      record.answerState !== undefined
      && record.answerState !== 'committed'
    ) {
      throw invalidMemory(
        'session_prior_event_projection_schema_unsupported',
        'Prior final answer has a non-committed answer state.'
      );
    }
  }
  return {
    runId: identity(record.runId, 'payload.runId'),
    projectionKind: record.projectionKind as
      | 'input.persisted'
      | 'provider.composing'
      | 'provider.completed',
    content: record.projectionKind === 'provider.completed'
      ? providerCompletedMemoryText(record)
      : record.content,
    attachments: kind === 'user_msg'
      ? record.attachments
      : [],
  };
}

function providerCompletedMemoryText(
  record: Record<string, unknown>
): string {
  if (
    record.channel !== 'final'
    || record.visibility !== 'conversation'
    || record.status !== 'completed'
    || record.outputKind !== 'answer'
    || record.terminalScope !== 'turn'
    || !Number.isSafeInteger(record.controlEpoch)
    || Number(record.controlEpoch) <= 0
  ) {
    throw invalidMemory(
      'session_prior_event_projection_schema_unsupported',
      'Prior Provider completion is not an exact committed final answer.'
    );
  }
  identity(record.providerTurnId, 'providerTurnId');
  const outcome = exactObject(
    record.providerOutcome,
    ['providerProfileId', 'provider', 'model'],
    ['usage']
  );
  identity(outcome.providerProfileId, 'providerProfileId');
  identity(outcome.provider, 'provider');
  identity(outcome.model, 'model');
  if (
    outcome.usage !== undefined
    && (
      !outcome.usage
      || typeof outcome.usage !== 'object'
      || Array.isArray(outcome.usage)
    )
  ) {
    throw invalidMemory(
      'session_prior_event_projection_schema_unsupported',
      'Prior Provider completion has invalid public usage metadata.'
    );
  }
  if (
    !Array.isArray(record.orderedItems)
    || record.orderedItems.length === 0
    || record.orderedItems.length > 96
  ) {
    throw invalidMemory(
      'session_prior_event_projection_schema_unsupported',
      'Prior Provider completion has no bounded ordered text response.'
    );
  }
  const items = record.orderedItems.map((value, index) => {
    const item = exactObject(
      value,
      ['kind', 'phase', 'text', 'textOrdinal']
    );
    if (
      item.kind !== 'text'
      || (
        item.phase !== 'commentary'
        && item.phase !== 'final_answer'
        && item.phase !== 'unknown'
      )
      || item.textOrdinal !== index + 1
    ) {
      throw invalidMemory(
        'session_prior_event_projection_schema_unsupported',
        'Prior Provider completion contains invalid ordered text.'
      );
    }
    return {
      phase: item.phase as 'commentary' | 'final_answer' | 'unknown',
      text: boundedText(item.text, 'orderedItems.text', 1024 * 1024),
    };
  });
  const firstFinalIndex = items.findIndex(
    (item) => item.phase === 'final_answer'
  );
  const lastCommentaryIndex = items.findLastIndex(
    (item) => item.phase === 'commentary'
  );
  const finalItems = firstFinalIndex >= 0
    ? items.slice(firstFinalIndex)
    : items
      .slice(lastCommentaryIndex + 1)
      .filter((item) => item.phase === 'unknown');
  if (
    finalItems.some((item) => item.phase === 'commentary')
  ) {
    throw invalidMemory(
      'session_prior_event_projection_schema_unsupported',
      'Prior Provider completion violates the final-answer phase order.'
    );
  }
  const text = finalItems.map((item) => item.text).join('');
  if (!text.trim() || utf8Bytes(text) > 1024 * 1024) {
    throw invalidMemory(
      'session_prior_event_projection_schema_unsupported',
      'Prior Provider completion has no bounded final answer text.'
    );
  }
  return text;
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
    'user_intervention',
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

function safePositiveCount(value: unknown, field: string): number {
  const count = safeCount(value, field);
  if (count === 0) {
    throw invalidMemory(
      'session_prior_event_count_invalid',
      `${field} must be a positive safe integer.`
    );
  }
  return count;
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
