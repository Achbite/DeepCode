import type { AgentEvent, AgentTimelineBlock, AgentTimelineResult, PermissionRequest } from '@deepcode/protocol';

export interface AgentComposerDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;

  effect?: AgentRequirementOptionEffectView;
}


export type AgentRequirementOptionEffectView =
  | { kind: 'continueWithAction' }
  | { kind: 'skipCurrentTask' }
  | { kind: 'replan'; reason?: string }
  | { kind: 'finishRun' };

export interface AgentComposerDecisionRequest {
  id?: string;
  reason?: string;
  summary?: string;
  allowsFreeform: boolean;
  options: AgentComposerDecisionOption[];
}

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
  const events = mergeDecisionEvents(input.events, timelineEvents(input.timeline));
  const active = findActiveTimelineInteraction(events, input.pendingPermission);
  if (!active) return null;
  return withResolvingState(active, events, input);
}

function withResolvingState(
  active: AgentComposerPendingDecision,
  events: AgentEvent[],
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
      decisionRequest: findRequirementDecisionRequest(events, active.runId, active.requirementId),
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

function findActiveTimelineInteraction(
  events: AgentEvent[],
  pendingPermission?: PermissionRequest | null
): AgentComposerPendingDecision | null {
  if (pendingPermission) {
    return {
      kind: 'permission',
      requestId: pendingPermission.id,
      title: pendingPermission.toolName,
      summary: pendingPermission.summary,
    };
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'plan_card' || event.kind === 'plan_review') {
      const pending = pendingPlanFromEvent(event, events);
      if (pending) return pending;
    }
    if (event.kind === 'review_summary') {
      const pending = pendingReviewFromEvent(event, events);
      if (pending) return pending;
    }
    if (event.kind === 'requirement_confirmation') {
      const pending = pendingRequirementFromEvent(event, events);
      if (pending) return pending;
    }
  }

  return null;
}

function pendingPlanFromEvent(
  event: AgentEvent,
  events: AgentEvent[]
): AgentComposerPendingDecision | null {
  const payload = asRecord(event.payload);
  if (!payload || payload.confirmable !== true) return null;
  const runId = stringField(payload, 'runId');
  const planId = stringField(payload, 'planId');
  if (!runId || !planId) return null;
  if (hasTerminalRunState(events, runId)) return null;
  if (hasTerminalPlanDecision(events, runId, planId)) return null;
  return {
    kind: 'plan',
    runId,
    planId,
    title: stringField(payload, 'title'),
    summary: stringField(payload, 'summary'),
  };
}

function pendingReviewFromEvent(
  event: AgentEvent,
  events: AgentEvent[]
): AgentComposerPendingDecision | null {
  const payload = asRecord(event.payload);
  if (!payload || payload.confirmable === false) return null;
  if (stringField(payload, 'status') !== 'waitingUserReview') return null;
  const runId = stringField(payload, 'runId');
  if (!runId) return null;
  const reviewId = stringField(payload, 'reviewId');
  const sourcePlanId = stringField(payload, 'sourcePlanId');
  if (hasTerminalRunState(events, runId)) return null;
  if (hasTerminalReviewDecision(events, runId, reviewId, sourcePlanId)) return null;
  return {
    kind: 'review',
    runId,
    title: stringField(payload, 'title'),
    summary: stringField(payload, 'summary'),
  };
}

function pendingRequirementFromEvent(
  event: AgentEvent,
  events: AgentEvent[]
): AgentComposerPendingDecision | null {
  const payload = asRecord(event.payload);
  if (!payload || payload.confirmable !== true) return null;
  if (stringField(payload, 'status') !== 'waitingUserConfirmation') return null;
  const runId = stringField(payload, 'runId');
  const requirementId = stringField(payload, 'requirementId');
  if (!runId || !requirementId) return null;
  if (hasTerminalRunState(events, runId)) return null;
  if (hasTerminalRequirementDecision(events, runId, requirementId)) return null;
  return {
    kind: 'requirement',
    runId,
    requirementId,
    title: stringField(payload, 'title'),
    summary: stringField(payload, 'summary'),
  };
}

function findRequirementDecisionRequest(
  events: AgentEvent[],
  runId: string,
  requirementId: string
): AgentComposerDecisionRequest | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'requirement_confirmation') continue;
    const payload = asRecord(event.payload);
    if (!payload || stringField(payload, 'runId') !== runId || stringField(payload, 'requirementId') !== requirementId) continue;
    const decisionRequest = asRecord(payload.decisionRequest);
    if (!decisionRequest) return undefined;
    const options = Array.isArray(decisionRequest.options)
      ? decisionRequest.options.flatMap((item): AgentComposerDecisionOption[] => {
        const option = asRecord(item);
        if (!option) return [];
        const id = stringField(option, 'id') ?? stringField(option, 'label');
        const label = stringField(option, 'label') ?? id;
        if (!id || !label) return [];
        return [{
          id,
          label,
          description: stringField(option, 'description') ??
            stringField(option, 'impact') ??
            stringField(option, 'tradeoff'),
          recommended: option.recommended === true,
          effect: extractOptionEffect(option.effect),
        }];
      })
      : [];
    if (options.length < 2) return undefined;
    return {
      id: stringField(decisionRequest, 'id'),
      reason: stringField(decisionRequest, 'reason'),
      summary: stringField(decisionRequest, 'summary'),
      allowsFreeform: decisionRequest.allowsFreeform !== false,
      options,
    };
  }
  return undefined;
}

function timelineEvents(timeline: AgentTimelineResult): AgentEvent[] {
  return flattenBlocks(timeline).flatMap((block) => block.events);
}

function mergeDecisionEvents(
  rawEvents: readonly AgentEvent[] | undefined,
  projectedEvents: readonly AgentEvent[]
): AgentEvent[] {
  const byId = new Map<string, { event: AgentEvent; index: number }>();
  let index = 0;
  for (const event of rawEvents ?? []) {
    if (!byId.has(event.id)) byId.set(event.id, { event, index });
    index += 1;
  }
  for (const event of projectedEvents) {
    if (!byId.has(event.id)) byId.set(event.id, { event, index });
    index += 1;
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

function flattenBlocks(timeline: AgentTimelineResult): AgentTimelineBlock[] {
  return timeline.turns.flatMap((turn) => turn.blocks);
}

function hasTerminalPlanDecision(events: AgentEvent[], runId: string, planId: string): boolean {
  return events.some((event) => {
    if (event.kind !== 'plan_review') return false;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) return false;
    return stringField(payload, 'runId') === runId && stringField(payload, 'planId') === planId;
  });
}

function hasTerminalReviewDecision(
  events: AgentEvent[],
  runId: string,
  reviewId?: string,
  sourcePlanId?: string
): boolean {
  return events.some((event) => {
    if (event.kind !== 'review_summary') return false;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) return false;
    if (stringField(payload, 'runId') !== runId) return false;
    const candidateReviewId = stringField(payload, 'reviewId');
    const candidateSourcePlanId = stringField(payload, 'sourcePlanId');
    if (reviewId) return candidateReviewId === reviewId;
    if (sourcePlanId) return candidateSourcePlanId === sourcePlanId;
    return true;
  });
}

function hasTerminalRequirementDecision(events: AgentEvent[], runId: string, requirementId: string): boolean {
  return events.some((event) => {
    if (event.kind !== 'requirement_decision') return false;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) return false;
    return stringField(payload, 'runId') === runId && stringField(payload, 'requirementId') === requirementId;
  });
}

function hasTerminalRunState(events: AgentEvent[], runId: string): boolean {
  return events.some((event) => {
    if (event.kind !== 'session_run_state') return false;
    const payload = asRecord(event.payload);
    if (!payload || stringField(payload, 'runId') !== runId) return false;
    return isTerminalStatus(stringField(payload, 'status'));
  });
}

function isTerminalStatus(status?: string): boolean {
  return status === 'accepted' ||
    status === 'rejected' ||
    status === 'needsRevision' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'completed';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

function extractOptionEffect(value: unknown): AgentRequirementOptionEffectView | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = stringField(record, 'kind');
  if (!kind) return undefined;
  switch (kind) {
    case 'continueWithAction':
    case 'skipCurrentTask':
    case 'finishRun':
      return { kind } as AgentRequirementOptionEffectView;
    case 'replan': {
      const reason = stringField(record, 'reason');
      return reason ? { kind: 'replan', reason } : { kind: 'replan' };
    }
    default:
      return undefined;
  }
}
