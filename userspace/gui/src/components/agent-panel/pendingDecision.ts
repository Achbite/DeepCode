import type { AgentEvent, AgentTimelineResult, PermissionRequest } from '@deepcode/protocol';
import {
  findActiveInteraction,
  interactionEventsFromTimeline,
  mergeInteractionEventsById,
  type InteractionLedgerActiveInteraction,
  type InteractionLedgerDecisionOption,
  type InteractionLedgerDecisionRequest,
  type InteractionLedgerOptionEffect,
} from '@deepcode/session-core';

export type AgentComposerDecisionOption = InteractionLedgerDecisionOption;
export type AgentRequirementOptionEffectView = InteractionLedgerOptionEffect;
export type AgentComposerDecisionRequest = InteractionLedgerDecisionRequest;

export type AgentComposerPendingDecision =
  | {
      kind: 'requirement';
      runId: string;
      requirementId: string;
      title?: string;
      summary?: string;
      decisionRequest?: AgentComposerDecisionRequest;
      resolving?: boolean;
    }
  | {
      kind: 'plan';
      runId: string;
      planId: string;
      title?: string;
      summary?: string;
      resolving?: boolean;
    }
  | {
      kind: 'review';
      runId: string;
      title?: string;
      summary?: string;
      resolving?: boolean;
    }
  | {
      kind: 'permission';
      requestId: string;
      title?: string;
      summary?: string;
      resolving?: boolean;
    };

export function findPendingComposerDecisionFromProjection(input: {
  timeline: AgentTimelineResult;
  events?: readonly AgentEvent[];
  pendingPermission?: PermissionRequest | null;
  resolvingRequirement?: { runId: string; requirementId: string } | null;
  resolvingPlan?: { runId: string; planId: string } | null;
  resolvingReview?: { runId: string } | null;
  resolvingPermission?: { id: string } | null;
}): AgentComposerPendingDecision | null {
  const events = mergeInteractionEventsById(input.events, interactionEventsFromTimeline(input.timeline));
  const active = findActiveInteraction({
    events,
    pendingPermission: input.pendingPermission,
  });
  if (!active) return null;
  return withResolvingState(active, input);
}

function withResolvingState(
  active: InteractionLedgerActiveInteraction,
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
