import type {
  AgentTimelineDecisionRequest,
  AgentTimelineInteractionOption,
  AgentTimelineInteractionOptionEffect,
  AgentTimelinePendingInteraction,
  AgentTimelineResult,
} from '@deepcode/protocol';

export type AgentComposerDecisionOption = AgentTimelineInteractionOption;
export type AgentRequirementOptionEffectView = AgentTimelineInteractionOptionEffect;
export type AgentComposerDecisionRequest = AgentTimelineDecisionRequest;

export type AgentComposerPendingDecision =
  | {
      kind: 'requirement';
      runId: string;
      requirementId: string;
      blockId?: string;
      title?: string;
      summary?: string;
      decisionRequest?: AgentComposerDecisionRequest;
      resolving?: boolean;
    }
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
      kind: 'review';
      runId: string;
      blockId?: string;
      title?: string;
      summary?: string;
      resolving?: boolean;
    }
  | {
      kind: 'permission';
      requestId: string;
      blockId?: string;
      title?: string;
      summary?: string;
      resolving?: boolean;
    };

export function findPendingComposerDecisionFromProjection(input: {
  timeline: AgentTimelineResult;
  resolvingRequirement?: { runId: string; requirementId: string } | null;
  resolvingPlan?: { runId: string; planId: string } | null;
  resolvingReview?: { runId: string } | null;
  resolvingPermission?: { id: string } | null;
}): AgentComposerPendingDecision | null {
  const active = input.timeline.interactionProjection?.pending;
  if (!active) return null;
  return withResolvingState(active, input);
}

function withResolvingState(
  active: AgentTimelinePendingInteraction,
  input: {
    resolvingRequirement?: { runId: string; requirementId: string } | null;
    resolvingPlan?: { runId: string; planId: string } | null;
    resolvingReview?: { runId: string } | null;
    resolvingPermission?: { id: string } | null;
  }
): AgentComposerPendingDecision {
  if (active.kind === 'permission') {
    return {
      ...active,
      resolving: input.resolvingPermission?.id === active.requestId,
    };
  }
  if (active.kind === 'requirement') {
    return {
      ...active,
      resolving: input.resolvingRequirement?.runId === active.runId &&
        input.resolvingRequirement?.requirementId === active.requirementId,
    };
  }
  if (active.kind === 'plan') {
    return {
      ...active,
      resolving: input.resolvingPlan?.runId === active.runId && input.resolvingPlan?.planId === active.planId,
    };
  }
  return {
    ...active,
    resolving: input.resolvingReview?.runId === active.runId,
  };
}
