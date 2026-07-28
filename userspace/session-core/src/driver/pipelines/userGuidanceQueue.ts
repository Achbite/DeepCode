import type {
  AgentEvent,
  AgentSessionResult,
  ConversationLanguage,
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
import { SessionDriverLoopError } from '../runtimeSupport.js';

export interface UserGuidanceQueueProviderResumeInput {
  sessionId: string;
  events: AgentEvent[];
  runId: string;
  hostRunId?: string;
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
}

export interface UserGuidanceQueueConsumedInput {
  sessionId: string;
  events: AgentEvent[];
  consumedIds: string[];
  runId: string;
  hostRunId?: string;
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
  hostRunId?: string;
  appliedAtProviderStage: string;
  summary: string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  now(): string;
  createId(prefix: string): string;
}

export class UserGuidanceQueue {
  collectQueued(
    events: AgentEvent[],
    runId: string,
    hostRunId?: string
  ): CollectedUserGuidanceEvent[] {
    const consumedIdentities = new Set<string>();
    for (const event of events) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload || stringValue(payload.status) !== 'consumed') continue;
      const ownerRunId = guidanceOwnerRunId(payload);
      if (!guidanceRunMatches(ownerRunId, runId, hostRunId)) continue;
      const guidanceId = stringValue(payload.guidanceId) ?? event.id;
      consumedIdentities.add(guidanceIdentity(
        canonicalGuidanceRunId(ownerRunId, runId, hostRunId),
        guidanceId
      ));
    }

    const collected: CollectedUserGuidanceEvent[] = [];
    const seen = new Map<string, GuidanceAuthorityIdentity>();
    for (const event of events) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload || stringValue(payload.status) === 'consumed') continue;
      const eventRunId = guidanceOwnerRunId(payload);
      if (!guidanceRunMatches(eventRunId, runId, hostRunId)) continue;
      const guidanceId = stringValue(payload.guidanceId) ?? event.id;
      const ownerRunId = canonicalGuidanceRunId(eventRunId, runId, hostRunId);
      const identity = guidanceIdentity(ownerRunId, guidanceId);
      if (consumedIdentities.has(identity)) continue;
      const content = stringContent(payload.content)
        ?? stringContent(payload.guidance)
        ?? stringContent(payload.summary);
      if (!content?.trim()) continue;
      const authorityIdentity: GuidanceAuthorityIdentity = {
        guidanceId,
        ownerRunId,
        content,
        hostLanguage: normalizeConversationLanguage(payload.hostLanguage),
        targetInteractionKind: stringValue(payload.targetInteractionKind),
      };
      const existing = seen.get(identity);
      if (existing) {
        if (!sameGuidanceAuthority(existing, authorityIdentity)) {
          throw new SessionDriverLoopError(
            'session_user_guidance_invalid',
            `User guidance ${guidanceId} has conflicting authority records for run ${ownerRunId ?? 'unbound'}.`
          );
        }
        continue;
      }
      seen.set(identity, authorityIdentity);
      collected.push({
        id: guidanceId,
        ts: event.ts,
        content,
        source: 'user',
        checkpointKind: 'nextProviderCall',
        hostLanguage: normalizeConversationLanguage(payload.hostLanguage),
      });
    }
    return collected;
  }

  providerResume(input: UserGuidanceQueueProviderResumeInput): UserGuidanceQueueProviderResume {
    const guidance = this.collectQueued(input.events, input.runId, input.hostRunId);
    if (guidance.length === 0) {
      return { guidance, events: [] };
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
      return { guidance: [], events: [] };
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
          hostRunId: input.hostRunId,
          appliedAtProviderStage: input.stage,
          summary: input.summary,
          now: input.now,
          createId: input.createId,
        }),
      ],
    };
  }

  consumedEvents(input: UserGuidanceQueueConsumedInput): AgentEvent[] {
    if (input.consumedIds.length === 0) return [];

    const alreadyConsumed = new Set<string>();
    const queuedGuidance = new Map<string, {
      event: AgentEvent;
      authority: GuidanceAuthorityIdentity;
    }>();
    for (const event of input.events) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload) continue;
      const guidanceId = stringValue(payload.guidanceId) ?? event.id;
      const ownerRunId = guidanceOwnerRunId(payload);
      if (!guidanceRunMatches(ownerRunId, input.runId, input.hostRunId)) continue;
      if (stringValue(payload.status) === 'consumed') {
        alreadyConsumed.add(guidanceId);
      } else {
        const content = stringContent(payload.content)
          ?? stringContent(payload.guidance)
          ?? stringContent(payload.summary);
        if (!content?.trim()) continue;
        const authority: GuidanceAuthorityIdentity = {
          guidanceId,
          ownerRunId: canonicalGuidanceRunId(
            ownerRunId,
            input.runId,
            input.hostRunId
          ),
          content,
          hostLanguage: normalizeConversationLanguage(payload.hostLanguage),
          targetInteractionKind: stringValue(payload.targetInteractionKind),
        };
        const existing = queuedGuidance.get(guidanceId);
        if (existing && !sameGuidanceAuthority(existing.authority, authority)) {
          throw new SessionDriverLoopError(
            'session_user_guidance_invalid',
            `User guidance ${guidanceId} has conflicting authority records for run ${ownerRunId}.`
          );
        }
        if (!existing) queuedGuidance.set(guidanceId, { event, authority });
      }
    }

    const events: AgentEvent[] = [];
    const emitted = new Set<string>();
    for (const guidanceId of input.consumedIds) {
      if (alreadyConsumed.has(guidanceId) || emitted.has(guidanceId)) continue;
      const source = queuedGuidance.get(guidanceId)?.event;
      if (!source) continue;
      emitted.add(guidanceId);
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
          visibility: 'hidden',
          presentation: 'traceOnly',
        },
        display: {
          presentation: 'traceOnly',
          importance: 'debug',
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
      hostRunId: input.hostRunId,
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

interface GuidanceAuthorityIdentity {
  guidanceId: string;
  ownerRunId?: string;
  content: string;
  hostLanguage?: ConversationLanguage;
  targetInteractionKind?: string;
}

function guidanceOwnerRunId(payload: Record<string, unknown>): string | undefined {
  return stringValue(payload.targetRunId) ?? stringValue(payload.runId);
}

function guidanceIdentity(ownerRunId: string | undefined, guidanceId: string): string {
  return `${ownerRunId ?? 'unbound'}\u0000${guidanceId}`;
}

function canonicalGuidanceRunId(
  ownerRunId: string | undefined,
  sessionRunId: string,
  hostRunId: string | undefined
): string | undefined {
  return guidanceRunMatches(ownerRunId, sessionRunId, hostRunId)
    ? sessionRunId
    : ownerRunId;
}

function guidanceRunMatches(
  ownerRunId: string | undefined,
  sessionRunId: string,
  hostRunId: string | undefined
): boolean {
  return ownerRunId === sessionRunId
    || (Boolean(hostRunId) && ownerRunId === hostRunId);
}

function sameGuidanceAuthority(
  left: GuidanceAuthorityIdentity,
  right: GuidanceAuthorityIdentity
): boolean {
  return left.guidanceId === right.guidanceId
    && left.ownerRunId === right.ownerRunId
    && left.content === right.content
    && left.hostLanguage === right.hostLanguage
    && left.targetInteractionKind === right.targetInteractionKind;
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
