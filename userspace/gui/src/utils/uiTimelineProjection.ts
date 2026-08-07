import type {
  AgentTimelineResult,
  AgentTimelineTaskProgress,
} from '@deepcode/protocol';
import { emptyTimeline } from '@deepcode/session-core';

export interface UiProjectionTaskItem {
  id: string;
  titleKey: string;
  titleArgs: Record<string, string>;
  summaryKey: string;
  messageArgs: Record<string, string>;
  progress: AgentTimelineTaskProgress;
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
    titleKey: item.titleKey,
    titleArgs: { ...item.titleArgs },
    summaryKey: item.summaryKey,
    messageArgs: { ...item.messageArgs },
    progress: item.progress,
  }));
}
