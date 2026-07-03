import type {
  AgentEvent,
  LlmChatRequest,
} from '@deepcode/protocol';
import type { UserGuidanceEvent } from '../../context/index.js';

export interface UserGuidanceQueueProviderResumeInput {
  sessionId: string;
  events: AgentEvent[];
  runId: string;
  stage: string;
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

export class UserGuidanceQueue {
  collectQueued(events: AgentEvent[], runId?: string): UserGuidanceEvent[] {
    const consumedIds = new Set<string>();
    for (const event of events.slice(-120)) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload || stringValue(payload.status) !== 'consumed') continue;
      consumedIds.add(stringValue(payload.guidanceId) ?? event.id);
    }

    const collected: UserGuidanceEvent[] = [];
    const seen = new Set<string>();
    for (const event of events.slice(-80)) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload || stringValue(payload.status) === 'consumed') continue;
      const eventRunId = stringValue(payload.targetRunId) ?? stringValue(payload.runId);
      if (runId && eventRunId && eventRunId !== runId) continue;
      const guidanceId = stringValue(payload.guidanceId) ?? event.id;
      if (consumedIds.has(guidanceId) || seen.has(guidanceId)) continue;
      const content = stringValue(payload.content) ?? stringValue(payload.guidance) ?? stringValue(payload.summary);
      if (!content) continue;
      seen.add(guidanceId);
      collected.push({
        id: guidanceId,
        ts: event.ts,
        content: clip(content, 600),
        source: 'user',
        checkpointKind: 'nextProviderCall',
      });
    }
    return collected.slice(-8);
  }

  providerResume(input: UserGuidanceQueueProviderResumeInput): UserGuidanceQueueProviderResume {
    const guidance = this.collectQueued(input.events, input.runId);
    if (guidance.length === 0) {
      return { guidance, events: [], messages: [] };
    }
    return {
      guidance,
      events: this.consumedEvents({
        sessionId: input.sessionId,
        events: input.events,
        consumedIds: guidance.map((item) => item.id),
        runId: input.runId,
        appliedAtProviderStage: input.stage,
        summary: input.summary,
        now: input.now,
        createId: input.createId,
      }),
      messages: [{
        role: 'user',
        content: [
          'User guidance received before the provider resume. Apply it to the next response or tool decision without starting a parallel run:',
          ...guidance.map((item) => `- ${item.id}: ${clip(item.content, 1200)}`),
        ].join('\n'),
      }],
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
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
