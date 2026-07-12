import type { AgentTimelineResult } from '@deepcode/protocol';
import { emptyTimeline } from '@deepcode/session-core';

export interface UiProjectionTaskItem {
  id: string;
  title: string;
  summary: string;
  status: string;
}

export function timelineOrEmpty(
  timeline: AgentTimelineResult | null | undefined,
  sessionId?: string
): AgentTimelineResult {
  return timeline ?? emptyTimeline(sessionId);
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
