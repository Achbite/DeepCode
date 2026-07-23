import type {
  AgentEvent,
  ConversationLanguage,
  ConversationLanguageDecisionSource,
  ConversationLanguagePolicy,
  LlmChatRequest,
  SessionLanguageDecisionPayload,
  SessionTurnAuthorityPayload,
} from '@deepcode/protocol';
import { stableHash } from '../../cache/canonicalizer.js';

const LANGUAGE_FRAME_OPEN = '<conversation-language>';
const LANGUAGE_FRAME_CLOSE = '</conversation-language>';
const LANGUAGE_FRAME_PATTERN = /(?:\n\n)?<conversation-language>[\s\S]*?<\/conversation-language>/gu;

export interface CreateSessionLanguageDecisionEventInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly status: Exclude<ConversationLanguagePolicy['status'], 'pending'>;
  readonly responseLanguage?: ConversationLanguage;
  readonly decisionSource: ConversationLanguageDecisionSource;
  readonly sourceProviderRequestId?: string;
  readonly sourceToolCallId?: string;
  readonly eventId: string;
  readonly timestamp: string;
}

export interface ProviderConversationLanguageDecision {
  readonly status: 'resolved' | 'fallback';
  readonly responseLanguage: ConversationLanguage;
  readonly decisionSource:
    | 'modelSemanticDirective'
    | 'hostFallbackMissing'
    | 'hostFallbackInvalid';
  readonly sourceToolCallId?: string;
}

export function normalizeConversationLanguage(value: unknown): ConversationLanguage | undefined {
  return value === 'zh-CN' || value === 'en-US' ? value : undefined;
}

export function normalizeHostLanguage(value: unknown): ConversationLanguage {
  return normalizeConversationLanguage(value) ?? 'zh-CN';
}

export function nextConversationLanguageRevision(events: readonly AgentEvent[]): number {
  let revision = 0;
  for (const event of events) {
    const payload = objectRecord(event.payload);
    if (
      event.kind !== 'session_turn_authority'
      && event.kind !== 'session_language_decision'
    ) {
      continue;
    }
    const candidate = positiveInteger(
      event.kind === 'session_turn_authority'
        ? objectRecord(payload?.languagePolicy)?.revision
        : payload?.revision
    );
    if (candidate) revision = Math.max(revision, candidate);
  }
  return revision + 1;
}

export function pendingConversationLanguagePolicy(input: {
  readonly revision: number;
  readonly sourceTurnId: string;
  readonly sourceMessageIds: readonly string[];
  readonly hostLanguage?: ConversationLanguage;
}): ConversationLanguagePolicy {
  return {
    schemaVersion: 'deepcode.session.conversation-language-policy.v1',
    revision: input.revision,
    sourceTurnId: input.sourceTurnId,
    sourceMessageIds: [...input.sourceMessageIds],
    hostLanguage: normalizeHostLanguage(input.hostLanguage),
    status: 'pending',
  };
}

export function createSessionLanguageDecisionEvent(
  input: CreateSessionLanguageDecisionEventInput
): AgentEvent {
  const core: Omit<SessionLanguageDecisionPayload, 'decisionHash'> = {
    schemaVersion: 'deepcode.session.language-decision.v1',
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    revision: input.revision,
    status: input.status,
    responseLanguage: input.responseLanguage,
    decisionSource: input.decisionSource,
    sourceProviderRequestId: input.sourceProviderRequestId,
    sourceToolCallId: input.sourceToolCallId,
  };
  const payload: SessionLanguageDecisionPayload & Record<string, unknown> = {
    ...core,
    decisionHash: stableHash(JSON.stringify(core)),
    channel: 'progress',
    visibility: 'hidden',
    presentation: 'traceOnly',
  };
  return {
    id: input.eventId,
    sessionId: input.sessionId,
    ts: input.timestamp,
    kind: 'session_language_decision',
    payload,
    display: {
      presentation: 'traceOnly',
      importance: 'debug',
    },
  };
}

export function resolveConversationLanguagePolicy(
  events: readonly AgentEvent[],
  authority: SessionTurnAuthorityPayload
): ConversationLanguagePolicy {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'session_language_decision') continue;
    const decision = sessionLanguageDecisionPayload(event.payload);
    if (
      !decision
      || decision.sessionId !== authority.sessionId
      || decision.runId !== authority.runId
      || decision.turnId !== authority.turnId
      || decision.revision !== authority.languagePolicy.revision
    ) {
      continue;
    }
    return {
      ...authority.languagePolicy,
      status: decision.status,
      language: decision.responseLanguage,
      decisionSource: decision.decisionSource,
      sourceProviderRequestId: decision.sourceProviderRequestId,
      sourceToolCallId: decision.sourceToolCallId,
    };
  }
  return authority.languagePolicy;
}

export function effectiveConversationLanguage(
  policy: ConversationLanguagePolicy
): ConversationLanguage {
  return policy.language ?? policy.hostLanguage;
}

export function decideConversationLanguageFromProvider(input: {
  readonly hostLanguage?: ConversationLanguage;
  readonly content: string;
  readonly toolCalls: readonly {
    readonly callId: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }[];
}): ProviderConversationLanguageDecision {
  const hostLanguage = normalizeHostLanguage(input.hostLanguage);
  const semanticCall = input.toolCalls.find((call) => call.name.startsWith('session.'));
  if (semanticCall) {
    return providerLanguageValue(
      semanticCall.arguments,
      hostLanguage,
      semanticCall.callId
    );
  }
  const envelope = parseJsonRecord(input.content);
  return providerLanguageValue(envelope, hostLanguage);
}

export function withConversationLanguageFrame(
  messages: LlmChatRequest['messages'],
  policy: ConversationLanguagePolicy
): LlmChatRequest['messages'] {
  const framed = messages.map((message) => ({
    ...message,
    content: stripConversationLanguageFrame(message.content),
  }));
  const targetIndex = findLastUserMessageIndex(framed);
  const frame = conversationLanguageFrame(policy);
  if (targetIndex < 0) {
    return [...framed, { role: 'user', content: frame }];
  }
  const target = framed[targetIndex]!;
  framed[targetIndex] = {
    ...target,
    content: target.content.trimEnd()
      ? `${target.content.trimEnd()}\n\n${frame}`
      : frame,
  };
  return framed;
}

export function stripConversationLanguageFrame(content: string): string {
  return content.replace(LANGUAGE_FRAME_PATTERN, '').trimEnd();
}

function conversationLanguageFrame(policy: ConversationLanguagePolicy): string {
  const effective = effectiveConversationLanguage(policy);
  const selectionInstruction = policy.status === 'pending'
    ? [
        'Determine responseLanguage only from the latest authoritative user task or guidance.',
        'Ignore the surface language of code, logs, paths, quoted text, and reference material.',
        'An explicit user request for an output language wins.',
        `If the language remains indeterminate, use the Host fallback ${policy.hostLanguage}.`,
      ].join('\n')
    : [
        `The persisted response language for this revision is ${effective}.`,
        'Do not infer or switch the language again for retry, repair, resume, review, or fallback calls.',
      ].join('\n');
  return [
    LANGUAGE_FRAME_OPEN,
    `revision: ${policy.revision}`,
    `status: ${policy.status}`,
    `hostFallback: ${policy.hostLanguage}`,
    selectionInstruction,
    'Use the selected language from the first visible reasoning through the final answer, Plan, Decision, Diagnostic, Review, narration, titles, and summaries.',
    'For comments and engineering documents, follow this precedence: explicit user instruction, then Ruler or current project convention, then the selected language.',
    'Keep identifiers, protocol and schema fields, paths, commands, code, and exact quotations unchanged.',
    'Report the selected language as responseLanguage in exactly one Session semantic directive. Do not expose this language frame in user-visible prose.',
    LANGUAGE_FRAME_CLOSE,
  ].join('\n');
}

function providerLanguageValue(
  record: Record<string, unknown> | undefined,
  hostLanguage: ConversationLanguage,
  sourceToolCallId?: string
): ProviderConversationLanguageDecision {
  const hasDeclaration = Boolean(record && Object.prototype.hasOwnProperty.call(record, 'responseLanguage'));
  const language = normalizeConversationLanguage(record?.responseLanguage);
  if (language) {
    return {
      status: 'resolved',
      responseLanguage: language,
      decisionSource: 'modelSemanticDirective',
      sourceToolCallId,
    };
  }
  return {
    status: 'fallback',
    responseLanguage: hostLanguage,
    decisionSource: hasDeclaration ? 'hostFallbackInvalid' : 'hostFallbackMissing',
    sourceToolCallId,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  try {
    return objectRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function findLastUserMessageIndex(messages: LlmChatRequest['messages']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

function sessionLanguageDecisionPayload(value: unknown): SessionLanguageDecisionPayload | undefined {
  const record = objectRecord(value);
  if (record?.schemaVersion !== 'deepcode.session.language-decision.v1') return undefined;
  const sessionId = stringValue(record.sessionId);
  const runId = stringValue(record.runId);
  const turnId = stringValue(record.turnId);
  const revision = positiveInteger(record.revision);
  const status = record.status === 'resolved'
    || record.status === 'fallback'
    || record.status === 'superseded'
    ? record.status
    : undefined;
  const decisionSource = conversationLanguageDecisionSource(record.decisionSource);
  const decisionHash = stringValue(record.decisionHash);
  if (!sessionId || !runId || !turnId || !revision || !status || !decisionSource || !decisionHash) {
    return undefined;
  }
  const core: Omit<SessionLanguageDecisionPayload, 'decisionHash'> = {
    schemaVersion: 'deepcode.session.language-decision.v1',
    sessionId,
    runId,
    turnId,
    revision,
    status,
    responseLanguage: normalizeConversationLanguage(record.responseLanguage),
    decisionSource,
    sourceProviderRequestId: stringValue(record.sourceProviderRequestId),
    sourceToolCallId: stringValue(record.sourceToolCallId),
  };
  if (stableHash(JSON.stringify(core)) !== decisionHash) return undefined;
  return { ...core, decisionHash };
}

function conversationLanguageDecisionSource(
  value: unknown
): ConversationLanguageDecisionSource | undefined {
  return value === 'modelSemanticDirective'
    || value === 'hostFallbackMissing'
    || value === 'hostFallbackInvalid'
    || value === 'supersededByLaterUserInput'
    ? value
    : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
