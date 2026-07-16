import type {
  AgentEvent,
  SessionTurnAuthorityPayload,
  SessionTurnAuthorityRelation,
} from '@deepcode/protocol';
import { stableHash } from '../../cache/canonicalizer.js';
import type { AutonomyMode } from '../../sessionModes.js';
import type { VisibleLanguage } from '../runtimeSupport.js';

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
  readonly turnAuthority: SessionTurnAuthorityPayload;
  readonly decisionRefs: readonly UserAuthorityDecisionRef[];
  readonly outputLanguage: VisibleLanguage;
  readonly autonomyMode: AutonomyMode;
}

export interface CreateSessionTurnAuthorityEventInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly messages: readonly Pick<UserAuthorityMessage, 'messageId' | 'content'>[];
  readonly relation: SessionTurnAuthorityRelation;
  readonly boundAtHookRef: string;
  readonly outputLanguage: VisibleLanguage;
  readonly promptEpochId?: string;
  readonly previousTaskId?: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export class UserAuthorityFrameError extends Error {
  constructor(
    readonly code: 'session_turn_authority_unavailable' | 'session_turn_authority_invalid',
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
  const sourceMessageIds = input.messages.map((message) => message.messageId);
  const sourceMessageHashes = input.messages.map((message) => stableHash(message.content));
  const authorityCore = {
    schemaVersion: 'deepcode.session.turn-authority.v1' as const,
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    taskId: input.taskId,
    sourceMessageIds,
    sourceMessageHashes,
    relation: input.relation,
    boundAtHookRef: input.boundAtHookRef,
    outputLanguage: input.outputLanguage,
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
  visibleLanguageForRequest: (content: string) => VisibleLanguage,
  autonomyMode: AutonomyMode = 'strict',
  options: { runId?: string; requirePersistedAuthority?: boolean } = {}
): UserAuthorityFrame {
  const explicitMessages = collectExplicitUserMessages(events);
  const fallbackMessage = authorityMessage({
    messageId: fallback.messageId,
    content: fallback.content,
    timestamp: fallback.timestamp,
    sourceKind: 'userMessage',
  });
  const effectiveMessages = explicitMessages.length ? explicitMessages : [fallbackMessage];
  const persisted = latestSessionTurnAuthority(events, options.runId);
  if (!persisted && options.requirePersistedAuthority) {
    throw new UserAuthorityFrameError(
      'session_turn_authority_unavailable',
      `Session run ${options.runId ?? 'unknown'} has no persisted CurrentTurnAuthority binding.`
    );
  }
  const turnAuthority = persisted ?? syntheticAuthority(
    effectiveMessages.at(-1) ?? fallbackMessage,
    options.runId,
    visibleLanguageForRequest
  );
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
  const outputLanguage = visibleLanguage(turnAuthority.outputLanguage)
    ?? visibleLanguageForRequest(currentMessages.map((message) => message.content).join('\n\n'));
  return {
    rootMessage: effectiveMessages[0] ?? fallbackMessage,
    explicitMessages: effectiveMessages,
    currentMessages,
    turnAuthority,
    decisionRefs: collectDecisionRefs(events),
    outputLanguage,
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
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'session_turn_authority') continue;
    const payload = sessionTurnAuthorityPayload(event.payload);
    if (!payload || (runId && payload.runId !== runId)) continue;
    return payload;
  }
  return undefined;
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

function sessionTurnAuthorityPayload(value: unknown): SessionTurnAuthorityPayload | undefined {
  const record = objectRecord(value);
  if (record?.schemaVersion !== 'deepcode.session.turn-authority.v1') return undefined;
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
  const outputLanguage = stringValue(record.outputLanguage);
  const authorityHash = stringValue(record.authorityHash);
  if (
    !sessionId || !runId || !turnId || !taskId || !relation || !boundAtHookRef || !outputLanguage || !authorityHash
    || sourceMessageIds.length === 0 || sourceMessageIds.length !== sourceMessageHashes.length
  ) {
    return undefined;
  }
  const core: Omit<SessionTurnAuthorityPayload, 'authorityHash'> = {
    schemaVersion: 'deepcode.session.turn-authority.v1' as const,
    sessionId,
    runId,
    turnId,
    taskId,
    sourceMessageIds,
    sourceMessageHashes,
    relation,
    boundAtHookRef,
    outputLanguage,
    promptEpochId: stringValue(record.promptEpochId),
    previousTaskId: stringValue(record.previousTaskId),
  };
  if (stableHash(JSON.stringify(core)) !== authorityHash) return undefined;
  return { ...core, authorityHash };
}

function syntheticAuthority(
  message: UserAuthorityMessage,
  runId: string | undefined,
  visibleLanguageForRequest: (content: string) => VisibleLanguage
): SessionTurnAuthorityPayload {
  const core = {
    schemaVersion: 'deepcode.session.turn-authority.v1' as const,
    sessionId: 'session-unbound',
    runId: runId ?? 'run-unbound',
    turnId: 'turn-unbound',
    taskId: 'task-unbound',
    sourceMessageIds: [message.messageId],
    sourceMessageHashes: [message.contentHash],
    relation: 'newTask' as const,
    boundAtHookRef: 'legacy-fallback',
    outputLanguage: visibleLanguageForRequest(message.content),
    promptEpochId: undefined,
    previousTaskId: undefined,
  };
  return { ...core, authorityHash: stableHash(JSON.stringify(core)) };
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

function visibleLanguage(value: string): VisibleLanguage | undefined {
  return value === 'zh-CN' || value === 'en-US' ? value : undefined;
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
