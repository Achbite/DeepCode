import type {
  AgentTimelinePendingInteraction,
  AgentTimelinePermissionRequestView,
  AgentTimelineResult,
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
    };

export function findPendingComposerDecisionFromProjection(input: {
  timeline: AgentTimelineResult;
  resolvingPlan?: { runId: string; planId: string } | null;
  resolvingPermission?: { id: string } | null;
}): AgentComposerPendingDecision | null {
  const active = input.timeline.interactionProjection?.pending;
  if (!active || (active.kind !== 'plan' && active.kind !== 'permission')) return null;
  return withResolvingState(active, input);
}

function withResolvingState(
  active: Extract<AgentTimelinePendingInteraction, { kind: 'plan' | 'permission' }>,
  input: {
    resolvingPlan?: { runId: string; planId: string } | null;
    resolvingPermission?: { id: string } | null;
  }
): AgentComposerPendingDecision {
  if (active.kind === 'permission') {
    return {
      ...active,
      resolving: input.resolvingPermission?.id === active.requestId,
    };
  }
  return {
    ...active,
    resolving: input.resolvingPlan?.runId === active.runId && input.resolvingPlan?.planId === active.planId,
  };
}
