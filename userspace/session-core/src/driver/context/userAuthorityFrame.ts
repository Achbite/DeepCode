import type {
  AgentEvent,
  ConversationLanguage,
  ConversationLanguagePolicy,
  SessionTurnAuthorityPayload,
  SessionTurnAuthorityRelation,
} from '@deepcode/protocol';
import { stableHash } from '../../cache/canonicalizer.js';
import type { AutonomyMode } from '../../sessionModes.js';
import {
  effectiveConversationLanguage,
  normalizeHostLanguage,
  pendingConversationLanguagePolicy,
  resolveConversationLanguagePolicy,
} from './conversationLanguagePolicy.js';

export interface UserAuthorityMessage {
  readonly messageId: string;
  readonly content: string;
  readonly contentHash: string;
  readonly timestamp?: string;
  readonly sourceKind: 'userMessage' | 'userGuidance';
}

export interface UserAuthorityDecisionRef {
  readonly eventId: string;
  readonly kind: string;
  readonly targetId?: string;
  readonly decision?: string;
  readonly guidance?: string;
}

export interface UserAuthorityFrame {
  readonly rootMessage: UserAuthorityMessage;
  readonly explicitMessages: readonly UserAuthorityMessage[];
  readonly currentMessages: readonly UserAuthorityMessage[];
  /**
   * Exact durable event identity for `turnAuthority`.
   *
   * The authority payload hash proves the payload material, but it does not
   * identify which persisted event established the active turn. Session facts
   * must reference this event id rather than reselecting the latest authority.
   */
  readonly turnAuthorityRef: string;
  readonly turnAuthority: SessionTurnAuthorityPayload;
  readonly decisionRefs: readonly UserAuthorityDecisionRef[];
  readonly languagePolicy: ConversationLanguagePolicy;
  readonly effectiveLanguage: ConversationLanguage;
  readonly autonomyMode: AutonomyMode;
}

export interface SessionTurnAuthorityEventRef {
  readonly eventId: string;
  readonly eventIndex: number;
  readonly event: AgentEvent;
  readonly payload: SessionTurnAuthorityPayload;
}

export interface CreateSessionTurnAuthorityEventInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly messages: readonly Pick<UserAuthorityMessage, 'messageId' | 'content'>[];
  readonly relation: SessionTurnAuthorityRelation;
  readonly boundAtHookRef: string;
  readonly languageRevision: number;
  readonly hostLanguage?: ConversationLanguage;
  readonly promptEpochId?: string;
  readonly previousTaskId?: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export class UserAuthorityFrameError extends Error {
  constructor(
    readonly code:
      | 'session_turn_authority_unavailable'
      | 'session_turn_authority_invalid'
      | 'session_language_policy_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'UserAuthorityFrameError';
  }
}

export function createSessionTurnAuthorityEvent(input: CreateSessionTurnAuthorityEventInput): AgentEvent {
  if (input.messages.length === 0) {
    throw new UserAuthorityFrameError(
      'session_turn_authority_invalid',
      'Session turn authority requires at least one explicit user message.'
    );
  }
  if (!Number.isSafeInteger(input.languageRevision) || input.languageRevision < 1) {
    throw new UserAuthorityFrameError(
      'session_turn_authority_invalid',
      'Session turn authority requires a positive language revision.'
    );
  }
  const sourceMessageIds = input.messages.map((message) => message.messageId);
  const sourceMessageHashes = input.messages.map((message) => stableHash(message.content));
  const languagePolicy = pendingConversationLanguagePolicy({
    revision: input.languageRevision,
    sourceTurnId: input.turnId,
    sourceMessageIds,
    hostLanguage: normalizeHostLanguage(input.hostLanguage),
  });
  const authorityCore = {
    schemaVersion: 'deepcode.session.turn-authority.v2' as const,
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    taskId: input.taskId,
    sourceMessageIds,
    sourceMessageHashes,
    relation: input.relation,
    boundAtHookRef: input.boundAtHookRef,
    languagePolicy,
    promptEpochId: input.promptEpochId,
    previousTaskId: input.previousTaskId,
  };
  const payload: SessionTurnAuthorityPayload & Record<string, unknown> = {
    ...authorityCore,
    authorityHash: stableHash(JSON.stringify(authorityCore)),
    channel: 'progress',
    visibility: 'hidden',
    presentation: 'traceOnly',
  };
  return {
    id: input.eventId,
    sessionId: input.sessionId,
    ts: input.timestamp,
    kind: 'session_turn_authority',
    payload,
    display: {
      presentation: 'traceOnly',
      importance: 'debug',
    },
  };
}

export function buildUserAuthorityFrame(
  events: readonly AgentEvent[],
  fallback: { messageId: string; content: string; timestamp?: string },
  autonomyMode: AutonomyMode = 'strict',
  options: { runId?: string } = {}
): UserAuthorityFrame {
  const explicitMessages = collectExplicitUserMessages(events);
  const fallbackMessage = authorityMessage({
    messageId: fallback.messageId,
    content: fallback.content,
    timestamp: fallback.timestamp,
    sourceKind: 'userMessage',
  });
  const effectiveMessages = explicitMessages.length ? explicitMessages : [fallbackMessage];
  const persisted = latestSessionTurnAuthorityEvent(events, options.runId);
  if (!persisted) {
    if (hasLegacySessionTurnAuthority(events, options.runId)) {
      throw new UserAuthorityFrameError(
        'session_language_policy_unavailable',
        `Session run ${options.runId ?? 'unknown'} uses turn authority v1 and cannot continue without ConversationLanguagePolicy v1.`
      );
    }
    throw new UserAuthorityFrameError(
      'session_turn_authority_unavailable',
      `Session run ${options.runId ?? 'unknown'} has no persisted CurrentTurnAuthority binding.`
    );
  }
  const turnAuthority = persisted.payload;
  const currentMessages = resolveCurrentMessages(effectiveMessages, turnAuthority);
  if (currentMessages.length !== turnAuthority.sourceMessageIds.length) {
    throw new UserAuthorityFrameError(
      'session_turn_authority_invalid',
      `Session turn ${turnAuthority.turnId} does not resolve every bound user message.`
    );
  }
  for (let index = 0; index < currentMessages.length; index += 1) {
    if (currentMessages[index]?.contentHash !== turnAuthority.sourceMessageHashes[index]) {
      throw new UserAuthorityFrameError(
        'session_turn_authority_invalid',
        `Session turn ${turnAuthority.turnId} user message hash does not match its persisted binding.`
      );
    }
  }
  const languagePolicy = resolveConversationLanguagePolicy(events, turnAuthority);
  return {
    rootMessage: effectiveMessages[0] ?? fallbackMessage,
    explicitMessages: effectiveMessages,
    currentMessages,
    turnAuthorityRef: persisted.eventId,
    turnAuthority,
    decisionRefs: collectDecisionRefs(events),
    languagePolicy,
    effectiveLanguage: effectiveConversationLanguage(languagePolicy),
    autonomyMode,
  };
}

export function latestExplicitUserContent(frame: UserAuthorityFrame): string {
  return frame.currentMessages.map((message) => message.content).join('\n\n')
    || frame.rootMessage.content;
}

export function latestSessionTurnAuthority(
  events: readonly AgentEvent[],
  runId?: string
): SessionTurnAuthorityPayload | undefined {
  return latestSessionTurnAuthorityEvent(events, runId)?.payload;
}

export function latestSessionTurnAuthorityEvent(
  events: readonly AgentEvent[],
  runId?: string
): SessionTurnAuthorityEventRef | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'session_turn_authority') continue;
    const payload = parseSessionTurnAuthorityPayload(event.payload);
    if (!payload || (runId && payload.runId !== runId)) continue;
    return {
      eventId: event.id,
      eventIndex: index,
      event,
      payload,
    };
  }
  return undefined;
}

export function sessionTurnAuthorityEventByRef(
  events: readonly AgentEvent[],
  eventId: string
): SessionTurnAuthorityEventRef | undefined {
  const normalizedRef = eventId.trim();
  if (!normalizedRef) return undefined;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.id !== normalizedRef || event.kind !== 'session_turn_authority') continue;
    const payload = parseSessionTurnAuthorityPayload(event.payload);
    if (!payload) return undefined;
    return {
      eventId: event.id,
      eventIndex: index,
      event,
      payload,
    };
  }
  return undefined;
}

export function sessionTurnAuthorities(
  events: readonly AgentEvent[],
  runId?: string
): SessionTurnAuthorityPayload[] {
  return events.flatMap((event): SessionTurnAuthorityPayload[] => {
    if (event.kind !== 'session_turn_authority') return [];
    const payload = parseSessionTurnAuthorityPayload(event.payload);
    if (!payload || (runId && payload.runId !== runId)) return [];
    return [payload];
  });
}

export function hasLegacySessionTurnAuthority(
  events: readonly AgentEvent[],
  runId?: string
): boolean {
  return events.some((event) => {
    if (event.kind !== 'session_turn_authority') return false;
    const payload = objectRecord(event.payload);
    return payload?.schemaVersion === 'deepcode.session.turn-authority.v1'
      && (!runId || stringValue(payload.runId) === runId);
  });
}

function collectExplicitUserMessages(events: readonly AgentEvent[]): UserAuthorityMessage[] {
  const messages: UserAuthorityMessage[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'user_msg' && event.kind !== 'user_guidance') continue;
    const payload = objectRecord(event.payload);
    if (event.kind === 'user_guidance' && stringValue(payload?.status) === 'consumed') continue;
    const content = stringContent(payload?.content) ?? stringContent(payload?.guidance);
    const messageId = event.kind === 'user_guidance'
      ? stringValue(payload?.guidanceId) ?? event.id
      : event.id;
    if (content === undefined || seen.has(messageId)) continue;
    seen.add(messageId);
    messages.push(authorityMessage({
      messageId,
      content,
      timestamp: event.ts,
      sourceKind: event.kind === 'user_guidance' ? 'userGuidance' : 'userMessage',
    }));
  }
  return messages;
}

function resolveCurrentMessages(
  messages: readonly UserAuthorityMessage[],
  authority: SessionTurnAuthorityPayload
): UserAuthorityMessage[] {
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  return authority.sourceMessageIds.flatMap((messageId) => {
    const message = byId.get(messageId);
    return message ? [message] : [];
  });
}

export function parseSessionTurnAuthorityPayload(
  value: unknown
): SessionTurnAuthorityPayload | undefined {
  const record = objectRecord(value);
  if (record?.schemaVersion !== 'deepcode.session.turn-authority.v2') return undefined;
  const sessionId = stringValue(record.sessionId);
  const runId = stringValue(record.runId);
  const turnId = stringValue(record.turnId);
  const taskId = stringValue(record.taskId);
  const relation = record.relation === 'newTask' || record.relation === 'interactionContinuation'
    ? record.relation
    : undefined;
  const sourceMessageIds = stringArray(record.sourceMessageIds);
  const sourceMessageHashes = stringArray(record.sourceMessageHashes);
  const boundAtHookRef = stringValue(record.boundAtHookRef);
  const languagePolicy = conversationLanguagePolicy(record.languagePolicy);
  const authorityHash = stringValue(record.authorityHash);
  if (
    !sessionId || !runId || !turnId || !taskId || !relation || !boundAtHookRef || !languagePolicy || !authorityHash
    || sourceMessageIds.length === 0 || sourceMessageIds.length !== sourceMessageHashes.length
    || languagePolicy.sourceTurnId !== turnId
    || !sameStringArray(languagePolicy.sourceMessageIds, sourceMessageIds)
  ) {
    return undefined;
  }
  const core: Omit<SessionTurnAuthorityPayload, 'authorityHash'> = {
    schemaVersion: 'deepcode.session.turn-authority.v2' as const,
    sessionId,
    runId,
    turnId,
    taskId,
    sourceMessageIds,
    sourceMessageHashes,
    relation,
    boundAtHookRef,
    languagePolicy,
    promptEpochId: stringValue(record.promptEpochId),
    previousTaskId: stringValue(record.previousTaskId),
  };
  if (stableHash(JSON.stringify(core)) !== authorityHash) return undefined;
  return { ...core, authorityHash };
}

function authorityMessage(input: Omit<UserAuthorityMessage, 'contentHash'>): UserAuthorityMessage {
  return { ...input, contentHash: stableHash(input.content) };
}

function collectDecisionRefs(events: readonly AgentEvent[]): UserAuthorityDecisionRef[] {
  return events.flatMap((event): UserAuthorityDecisionRef[] => {
    if (!isDecisionEvent(event.kind)) return [];
    const payload = objectRecord(event.payload);
    return [{
      eventId: event.id,
      kind: event.kind,
      targetId: stringValue(payload?.targetId)
        ?? stringValue(payload?.requirementId)
        ?? stringValue(payload?.planId)
        ?? stringValue(payload?.reviewId)
        ?? stringValue(payload?.permissionId),
      decision: stringValue(payload?.decision) ?? stringValue(payload?.status),
      guidance: stringValue(payload?.guidance) ?? stringValue(payload?.content),
    }];
  });
}

function isDecisionEvent(kind: AgentEvent['kind']): boolean {
  return kind === 'requirement_decision'
    || kind === 'plan_review'
    || kind === 'review_summary'
    || kind === 'permission_result';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringContent(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function conversationLanguagePolicy(value: unknown): ConversationLanguagePolicy | undefined {
  const record = objectRecord(value);
  if (record?.schemaVersion !== 'deepcode.session.conversation-language-policy.v1') return undefined;
  const revision = positiveInteger(record.revision);
  const sourceTurnId = stringValue(record.sourceTurnId);
  const sourceMessageIds = stringArray(record.sourceMessageIds);
  const hostLanguage = record.hostLanguage === 'zh-CN' || record.hostLanguage === 'en-US'
    ? record.hostLanguage
    : undefined;
  if (
    !revision
    || !sourceTurnId
    || sourceMessageIds.length === 0
    || !hostLanguage
    || record.status !== 'pending'
  ) {
    return undefined;
  }
  return {
    schemaVersion: 'deepcode.session.conversation-language-policy.v1',
    revision,
    sourceTurnId,
    sourceMessageIds,
    hostLanguage,
    status: 'pending',
  };
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
