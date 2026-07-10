import { useEffect, useMemo, useRef, useState } from 'react';
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
  generatedAt?: string;
}

export interface UiProjectionTaskItem {
  id: string;
  title: string;
  summary: string;
  status: string;
}

export function buildUiTimelineProjection(input: BuildUiTimelineProjectionInput): AgentTimelineResult {
  const committedEvents = input.events ?? [];
  const sessionId = input.sessionId ??
    committedEvents[0]?.sessionId ??
    'session';
  const generatedAt = input.generatedAt;
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

  return buildNarrativeTimelineProjection({
    sessionId,
    events: [],
    generatedAt,
  });
}

export function useUiTimelineProjection(input: BuildUiTimelineProjectionInput): AgentTimelineResult {
  const activeDeltas = useAnimationFrameProjectionDeltas(input.sessionId, input.activeDeltas ?? []);
  return useMemo(
    () => buildUiTimelineProjection({ ...input, activeDeltas }),
    [activeDeltas, input.events, input.generatedAt, input.sessionId]
  );
}

function useAnimationFrameProjectionDeltas(
  sessionId: string | undefined,
  deltas: ProjectionDelta[]
): ProjectionDelta[] {
  const [coalesced, setCoalesced] = useState<{ sessionId?: string; deltas: ProjectionDelta[] }>(() => ({
    sessionId,
    deltas,
  }));
  const latestRef = useRef({ sessionId, deltas });
  const frameRef = useRef<number | null>(null);
  latestRef.current = { sessionId, deltas };

  useEffect(() => {
    if (frameRef.current !== null) return undefined;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setCoalesced(latestRef.current);
    });
    return undefined;
  }, [deltas, sessionId]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  return coalesced.sessionId === sessionId ? coalesced.deltas : deltas;
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
