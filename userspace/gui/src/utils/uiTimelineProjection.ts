import type {
  AgentTimelineBlock,
  AgentTimelineResourcePresentation,
  AgentTimelineResult,
  AgentTimelineTaskOutcome,
  AgentTimelineTaskProgress,
} from '@deepcode/protocol';
import { emptyTimeline } from '@deepcode/session-core';

export interface UiProjectionTaskItem {
  id: string;
  blockId: string;
  titleKey: string;
  titleArgs: Record<string, string>;
  summaryKey: string;
  messageArgs: Record<string, string>;
  progress: AgentTimelineTaskProgress;
  outcome: AgentTimelineTaskOutcome | null;
  targetRefs: string[];
  resourcePresentation: AgentTimelineResourcePresentation[];
}

export function timelineOrEmpty(
  timeline: AgentTimelineResult | null | undefined,
  sessionId?: string
): AgentTimelineResult {
  return timeline ?? emptyTimeline(sessionId);
}

export function latestAcceptedPlanTaskItemsFromProjection(
  view: AgentTimelineResult
): UiProjectionTaskItem[] {
  const runId = view.runProjection?.runId;
  if (!runId) return [];

  let latestPlanBlock: AgentTimelineBlock | null = null;
  for (const turn of view.turns) {
    for (const block of turn.blocks) {
      if (
        block.interaction?.kind === 'plan'
        && block.interaction.runId === runId
        && (block.kind === 'plan' || block.narrativeKind === 'plan')
      ) {
        latestPlanBlock = block;
      }
    }
  }

  if (latestPlanBlock?.interaction?.state !== 'accepted') return [];
  const latestPlanBlockId = latestPlanBlock.id;

  const projectedItems = (view.taskProjection?.items ?? []).filter((item) =>
    item.narrativeKind === 'plan'
    && item.blockId === latestPlanBlockId
  );

  return projectedItems.map((item) => ({
    id: item.id,
    blockId: item.blockId,
    titleKey: item.titleKey,
    titleArgs: { ...item.titleArgs },
    summaryKey: item.summaryKey,
    messageArgs: { ...item.messageArgs },
    progress: item.progress,
    outcome: item.outcome,
    targetRefs: [...item.targetRefs],
    resourcePresentation: item.resourcePresentation.map((resource) => ({ ...resource })),
  }));
}
