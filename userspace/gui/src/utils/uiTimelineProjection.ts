import type {
  AgentEvent,
  AgentTimelineResult,
  ProjectionDelta,
} from '@deepcode/protocol';
import {
  buildNarrativeTimelineProjection,
  buildTimelineProjectionWithLiveOverlay,
} from '@deepcode/session-core';

interface BuildUiTimelineProjectionInput {
  sessionId?: string;
  events?: AgentEvent[];
  activeDeltas?: ProjectionDelta[];
  timeline?: AgentTimelineResult | null;
  generatedAt?: string;
}

export interface UiProjectionTaskItem {
  id: string;
  title: string;
  summary: string;
  status: string;
}

export function timelineEventsFromProjection(view?: AgentTimelineResult | null): AgentEvent[] {
  if (!view) return [];
  const byId = new Map<string, AgentEvent>();
  for (const turn of view.turns) {
    for (const block of turn.blocks) {
      for (const event of block.events) {
        if (!byId.has(event.id)) byId.set(event.id, event);
      }
    }
  }
  return [...byId.values()];
}

export function mergeAgentEventsById(...sources: Array<readonly AgentEvent[] | undefined | null>): AgentEvent[] {
  const byId = new Map<string, { event: AgentEvent; index: number }>();
  let index = 0;
  for (const source of sources) {
    for (const event of source ?? []) {
      if (!byId.has(event.id)) byId.set(event.id, { event, index });
      index += 1;
    }
  }
  return [...byId.values()]
    .sort((left, right) => {
      const leftTime = Date.parse(left.event.ts);
      const rightTime = Date.parse(right.event.ts);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.event);
}

export function buildUiTimelineProjection(input: BuildUiTimelineProjectionInput): AgentTimelineResult {
  const timelineEvents = timelineEventsFromProjection(input.timeline);
  const committedEvents = mergeAgentEventsById(input.events, timelineEvents);
  const sessionId = input.sessionId ??
    input.timeline?.sessionId ??
    committedEvents[0]?.sessionId ??
    'session';
  const generatedAt = input.generatedAt ?? input.timeline?.generatedAt;
  const activeDeltas = input.activeDeltas ?? [];

  if (activeDeltas.length > 0) {
    return buildTimelineProjectionWithLiveOverlay({
      sessionId,
      committedEvents,
      activeDeltas,
      generatedAt,
    });
  }

  if (committedEvents.length > 0) {
    return buildNarrativeTimelineProjection({
      sessionId,
      events: committedEvents,
      generatedAt,
    });
  }

  return input.timeline ?? buildNarrativeTimelineProjection({
    sessionId,
    events: [],
    generatedAt,
  });
}

export function latestPlanTaskItemsFromProjection(view: AgentTimelineResult): UiProjectionTaskItem[] {
  const planItems = (view.taskProjection?.items ?? [])
    .filter((item) => item.narrativeKind === 'plan');
  const latestPlanBlockId = planItems.length > 0 ? planItems[planItems.length - 1]?.blockId : null;
  const projectedItems = latestPlanBlockId
    ? planItems.filter((item) => item.blockId === latestPlanBlockId)
    : [];

  return projectedItems.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    status: item.status,
  }));
}
