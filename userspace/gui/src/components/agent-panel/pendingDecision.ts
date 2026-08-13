import type {
  AgentTimelinePendingInteraction,
  AgentTimelinePermissionRequestView,
  AgentTimelineResult,
  AgentTimelineUserInterventionViewV4,
} from '@deepcode/protocol';

export type AgentComposerPendingDecision =
  | {
      kind: 'plan';
      runId: string;
      planId: string;
      blockId?: string;
      title?: string;
      summary?: string;
      resolving?: boolean;
    }
  | {
      kind: 'permission';
      requestId: string;
      request: AgentTimelinePermissionRequestView;
      blockId?: string;
      title?: string;
      summary?: string;
      resolving?: boolean;
    }
  | {
      kind: 'userIntervention';
      interactionId: string;
      interactionRevision: string;
      candidateSetDigest: string;
      projectionCursor: number;
      runId: string;
      targetId: string;
      intervention: AgentTimelineUserInterventionViewV4;
      blockId?: string;
      title?: string;
      summary?: string;
      resolving?: boolean;
    };

export function findPendingComposerDecisionFromProjection(input: {
  timeline: AgentTimelineResult;
  resolvingPlan?: { runId: string; planId: string } | null;
  resolvingPermission?: { id: string } | null;
  resolvingIntervention?: { interactionId: string } | null;
}): AgentComposerPendingDecision | null {
  const active = input.timeline.interactionProjection?.pending;
  if (!active) return null;
  return withResolvingState(active, input);
}

function withResolvingState(
  active: AgentTimelinePendingInteraction,
  input: {
    timeline: AgentTimelineResult;
    resolvingPlan?: { runId: string; planId: string } | null;
    resolvingPermission?: { id: string } | null;
    resolvingIntervention?: { interactionId: string } | null;
  }
): AgentComposerPendingDecision {
  if (active.kind === 'permission') {
    return {
      ...active,
      resolving: input.resolvingPermission?.id === active.requestId,
    };
  }
  if (active.kind === 'userIntervention') {
    return {
      ...active,
      projectionCursor: input.timeline.revision,
      resolving: input.resolvingIntervention?.interactionId === active.interactionId,
    };
  }
  return {
    ...active,
    resolving: input.resolvingPlan?.runId === active.runId && input.resolvingPlan?.planId === active.planId,
  };
}
