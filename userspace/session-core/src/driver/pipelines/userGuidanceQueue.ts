import type {
  AgentEvent,
  AgentSessionResult,
  ConversationLanguage,
  LlmChatRequest,
  SessionTurnAuthorityPayload,
} from '@deepcode/protocol';
import type { UserGuidanceEvent } from '../../context/index.js';
import {
  createSessionTurnAuthorityEvent,
  latestSessionTurnAuthority,
} from '../context/userAuthorityFrame.js';
import {
  createSessionLanguageDecisionEvent,
  nextConversationLanguageRevision,
  normalizeConversationLanguage,
  normalizeHostLanguage,
  resolveConversationLanguagePolicy,
} from '../context/conversationLanguagePolicy.js';

export interface UserGuidanceQueueProviderResumeInput {
  sessionId: string;
  events: AgentEvent[];
  runId: string;
  taskId: string;
  stage: string;
  defaultHostLanguage?: ConversationLanguage;
  promptEpochId?: string;
  summary: string;
  now(): string;
  createId(prefix: string): string;
}

export interface UserGuidanceQueueProviderResume {
  guidance: UserGuidanceEvent[];
  events: AgentEvent[];
  messages: LlmChatRequest['messages'];
}

export interface UserGuidanceQueueConsumedInput {
  sessionId: string;
  events: AgentEvent[];
  consumedIds: string[];
  runId: string;
  appliedAtProviderStage: string;
  summary: string;
  now(): string;
  createId(prefix: string): string;
}

export interface UserGuidanceQueueAppendConsumedInput {
  sessionId: string;
  result: AgentSessionResult;
  consumedIds: string[];
  runId: string;
  appliedAtProviderStage: string;
  summary: string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  now(): string;
  createId(prefix: string): string;
}

export class UserGuidanceQueue {
  collectQueued(events: AgentEvent[], runId?: string): CollectedUserGuidanceEvent[] {
    const consumedIds = new Set<string>();
    for (const event of events.slice(-120)) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload || stringValue(payload.status) !== 'consumed') continue;
      consumedIds.add(stringValue(payload.guidanceId) ?? event.id);
    }

    const collected: CollectedUserGuidanceEvent[] = [];
    const seen = new Set<string>();
    for (const event of events.slice(-80)) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload || stringValue(payload.status) === 'consumed') continue;
      const eventRunId = stringValue(payload.targetRunId) ?? stringValue(payload.runId);
      if (runId && eventRunId && eventRunId !== runId) continue;
      const guidanceId = stringValue(payload.guidanceId) ?? event.id;
      if (consumedIds.has(guidanceId) || seen.has(guidanceId)) continue;
      const content = stringContent(payload.content)
        ?? stringContent(payload.guidance)
        ?? stringContent(payload.summary);
      if (!content?.trim()) continue;
      seen.add(guidanceId);
      collected.push({
        id: guidanceId,
        ts: event.ts,
        content,
        source: 'user',
        checkpointKind: 'nextProviderCall',
        hostLanguage: normalizeConversationLanguage(payload.hostLanguage),
      });
    }
    return collected.slice(-8);
  }

  providerResume(input: UserGuidanceQueueProviderResumeInput): UserGuidanceQueueProviderResume {
    const guidance = this.collectQueued(input.events, input.runId);
    if (guidance.length === 0) {
      return { guidance, events: [], messages: [] };
    }
    const authorityEvents: AgentEvent[] = [];
    let revision = nextConversationLanguageRevision(input.events);
    let authority: SessionTurnAuthorityPayload | undefined;
    const previousAuthority = latestSessionTurnAuthority(input.events, input.runId);
    if (
      previousAuthority
      && resolveConversationLanguagePolicy(input.events, previousAuthority).status === 'pending'
    ) {
      authorityEvents.push(createSessionLanguageDecisionEvent({
        sessionId: previousAuthority.sessionId,
        runId: previousAuthority.runId,
        turnId: previousAuthority.turnId,
        revision: previousAuthority.languagePolicy.revision,
        status: 'superseded',
        decisionSource: 'supersededByLaterUserInput',
        eventId: input.createId('session-language-superseded'),
        timestamp: input.now(),
      }));
    }
    for (let index = 0; index < guidance.length; index += 1) {
      const item = guidance[index] as CollectedUserGuidanceEvent;
      const turnId = input.createId('session-turn');
      const authorityEvent = createSessionTurnAuthorityEvent({
        sessionId: input.sessionId,
        runId: input.runId,
        turnId,
        taskId: input.taskId,
        messages: [{ messageId: item.id, content: item.content }],
        relation: 'interactionContinuation',
        boundAtHookRef: `provider.${input.stage}`,
        languageRevision: revision,
        hostLanguage: item.hostLanguage ?? normalizeHostLanguage(input.defaultHostLanguage),
        promptEpochId: input.promptEpochId,
        eventId: input.createId('session-turn-authority'),
        timestamp: input.now(),
      });
      authorityEvents.push(authorityEvent);
      authority = authorityEvent.payload as SessionTurnAuthorityPayload;
      if (index < guidance.length - 1) {
        authorityEvents.push(createSessionLanguageDecisionEvent({
          sessionId: input.sessionId,
          runId: input.runId,
          turnId,
          revision,
          status: 'superseded',
          decisionSource: 'supersededByLaterUserInput',
          eventId: input.createId('session-language-superseded'),
          timestamp: input.now(),
        }));
      }
      revision += 1;
    }
    if (!authority) {
      return { guidance: [], events: [], messages: [] };
    }
    return {
      guidance,
      events: [
        ...authorityEvents,
        ...this.consumedEvents({
          sessionId: input.sessionId,
          events: input.events,
          consumedIds: guidance.map((item) => item.id),
          runId: input.runId,
          appliedAtProviderStage: input.stage,
          summary: input.summary,
          now: input.now,
          createId: input.createId,
        }),
      ],
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            kind: 'CurrentTurnAuthority',
            turnId: authority.turnId,
            taskId: authority.taskId,
            relation: authority.relation,
            sourceMessageIds: authority.sourceMessageIds,
            sourceMessageHashes: authority.sourceMessageHashes,
            languagePolicy: authority.languagePolicy,
            authorityHash: authority.authorityHash,
          }),
        },
        ...guidance.map((item) => ({ role: 'user' as const, content: item.content })),
      ],
    };
  }

  consumedEvents(input: UserGuidanceQueueConsumedInput): AgentEvent[] {
    if (input.consumedIds.length === 0) return [];

    const alreadyConsumed = new Set<string>();
    const queuedGuidance = new Map<string, AgentEvent>();
    for (const event of input.events) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload) continue;
      const guidanceId = stringValue(payload.guidanceId) ?? event.id;
      if (stringValue(payload.status) === 'consumed') {
        alreadyConsumed.add(guidanceId);
      } else {
        queuedGuidance.set(guidanceId, event);
      }
    }

    const events: AgentEvent[] = [];
    for (const guidanceId of input.consumedIds) {
      if (alreadyConsumed.has(guidanceId)) continue;
      const source = queuedGuidance.get(guidanceId);
      if (!source) continue;
      const payload = objectRecord(source.payload) ?? {};
      events.push({
        id: input.createId('user-guidance-consumed'),
        sessionId: input.sessionId,
        ts: input.now(),
        kind: 'user_guidance',
        payload: {
          title: 'User guidance',
          summary: input.summary,
          status: 'consumed',
          guidanceId,
          targetRunId: stringValue(payload.targetRunId) ?? stringValue(payload.runId) ?? input.runId,
          targetInteractionKind: stringValue(payload.targetInteractionKind) ?? 'runningRunGuidance',
          effectiveCheckpoint: 'nextProviderCall',
          checkpointKind: 'userGuidance',
          appliedAtProviderStage: input.appliedAtProviderStage,
          source: 'session',
          channel: 'progress',
          visibility: 'conversation',
          presentation: 'body',
        },
      });
    }
    return events;
  }

  async appendConsumed(input: UserGuidanceQueueAppendConsumedInput): Promise<AgentSessionResult> {
    const events = this.consumedEvents({
      sessionId: input.sessionId,
      events: input.result.events,
      consumedIds: input.consumedIds,
      runId: input.runId,
      appliedAtProviderStage: input.appliedAtProviderStage,
      summary: input.summary,
      now: input.now,
      createId: input.createId,
    });
    return events.length > 0 ? input.append(input.sessionId, events) : input.result;
  }
}

interface CollectedUserGuidanceEvent extends UserGuidanceEvent {
  hostLanguage?: ConversationLanguage;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringContent(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
