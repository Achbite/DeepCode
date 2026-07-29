import type {
  AgentEvent,
  AgentTimelineDeliveryMode,
  AgentTimelineResult,
  AgentTimelineSnapshot,
} from '@deepcode/protocol';
import {
  assertSharedConversationProjectionV2,
  buildNarrativeTimelineProjection,
} from './projectionV2.js';

export class CanonicalTimelineProjector {
  private auxiliaryEvents: AgentEvent[];
  private currentTimeline: AgentTimelineResult;

  constructor(
    private readonly sessionId: string,
    initialEvents: AgentEvent[],
    initialTimeline?: AgentTimelineSnapshot,
    initialAuxiliaryEvents: AgentEvent[] = []
  ) {
    this.auxiliaryEvents = deduplicateAuxiliaryEvents(initialAuxiliaryEvents);
    const normalizedInitial = initialTimeline?.sessionId === sessionId
      ? normalizeAgentTimelineSnapshot(initialTimeline).timeline
      : undefined;
    this.currentTimeline =
      normalizedInitial?.eventCount === initialEvents.length
      && normalizedInitial.sourceEventVersion === initialEvents.length
        ? normalizedInitial
        : buildNarrativeTimelineProjection({
            sessionId,
            events: initialEvents,
            auxiliaryEvents: this.auxiliaryEvents,
          });
  }

  rememberAuxiliaryEvents(events: readonly AgentEvent[]): void {
    if (events.length === 0) return;
    this.auxiliaryEvents = deduplicateAuxiliaryEvents([
      ...this.auxiliaryEvents,
      ...events,
    ]);
  }

  snapshot(): AgentTimelineResult {
    return this.currentTimeline;
  }
}

function deduplicateAuxiliaryEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.id.trim()) byId.set(event.id, event);
  }
  return [...byId.values()];
}

export interface NormalizedAgentTimelineSnapshot {
  timeline: AgentTimelineResult;
  compatibility: 'nativeV2';
}

export function normalizeAgentTimelineSnapshot(
  snapshot: AgentTimelineSnapshot
): NormalizedAgentTimelineSnapshot {
  assertSharedConversationProjectionV2(snapshot);
  return { timeline: snapshot, compatibility: 'nativeV2' };
}

export function rebuildSharedConversationProjectionV2(
  sessionId: string,
  sourceEvents: AgentEvent[],
  staleSnapshot: AgentTimelineSnapshot,
  minimumRevision = (staleSnapshot.revision ?? 0) + 1
): AgentTimelineResult {
  assertSharedConversationProjectionV2(staleSnapshot);
  if (staleSnapshot.sessionId !== sessionId) {
    throw new Error('session_projection_repair_native_v2_required');
  }
  return {
    ...buildNarrativeTimelineProjection({
      sessionId,
      events: sourceEvents,
    }),
    revision: Math.max(sourceEvents.length, minimumRevision),
  };
}

export function reconcileTimelineSnapshot(
  current: AgentTimelineResult | null | undefined,
  incoming: AgentTimelineResult,
  deliveryModes: Record<string, AgentTimelineDeliveryMode> = {}
): AgentTimelineResult {
  const existingById = new Map(
    (current?.turns ?? [])
      .flatMap((turn) => turn.blocks)
      .map((block) => [block.id, block])
  );
  return {
    ...incoming,
    revision: Math.max(current?.revision ?? 0, incoming.revision ?? 0),
    turns: incoming.turns.map((turn, turnIndex) => ({
      ...turn,
      sequence: turn.sequence ?? turnIndex,
      blocks: turn.blocks.map((block, blockIndex) => {
        const existing = existingById.get(block.id);
        return {
          ...block,
          sequence: block.sequence ?? blockIndex,
          revision: Math.max(existing?.revision ?? 0, block.revision ?? 0),
          deliveryMode: deliveryModes[block.id]
            ?? (existing?.deliveryMode === 'live' ? 'replay' : existing?.deliveryMode)
            ?? block.deliveryMode
            ?? 'replay',
        };
      }),
    })),
  };
}

export function timelineAsReplay(
  timeline: AgentTimelineResult
): AgentTimelineResult {
  return {
    ...timeline,
    turns: timeline.turns.map((turn, turnIndex) => ({
      ...turn,
      sequence: turn.sequence ?? turnIndex,
      blocks: turn.blocks.map((block, blockIndex) => ({
        ...block,
        sequence: block.sequence ?? blockIndex,
        deliveryMode: 'replay',
      })),
    })),
  };
}

export function emptyTimeline(sessionId = 'session'): AgentTimelineResult {
  return {
    schemaVersion: 'deepcode.shared-conversation-projection.v2',
    sessionId,
    revision: 0,
    sourceEventVersion: 0,
    generatedAt: new Date(0).toISOString(),
    turns: [],
    eventCount: 0,
  };
}
