import type { AgentEvent, PermissionRequest } from '@deepcode/protocol';

export type ActiveSessionInteraction =
  | {
      kind: 'permission';
      requestId: string;
      title?: string;
      summary?: string;
    }
  | {
      kind: 'review';
      runId: string;
      title?: string;
      summary?: string;
    }
  | {
      kind: 'plan';
      runId: string;
      planId: string;
      title?: string;
      summary?: string;
    }
  | {
      kind: 'requirement';
      runId: string;
      requirementId: string;
      title?: string;
      summary?: string;
    };

export function findActiveSessionInteraction(input: {
  events: AgentEvent[];
  pendingPermission?: PermissionRequest | null;
}): ActiveSessionInteraction | null {
  if (input.pendingPermission) {
    return {
      kind: 'permission',
      requestId: input.pendingPermission.id,
      title: input.pendingPermission.toolName,
      summary: input.pendingPermission.summary,
    };
  }

  const events = input.events;
  const resolvedPlans = collectResolvedPlanKeys(events);
  const resolvedPlanRuns = collectResolvedPlanRuns(events);
  const resolvedRequirements = collectResolvedRequirementKeys(events);
  const resolvedReviews = collectResolvedReviewKeys(events);
  const resolvedReviewRuns = collectResolvedReviewRuns(events);

  const review = findLatestActiveReview(events, resolvedReviews, resolvedReviewRuns);
  if (review) return review;
  const plan = findLatestActivePlan(events, resolvedPlans, resolvedPlanRuns);
  if (plan) return plan;
  return findLatestActiveRequirement(events, resolvedRequirements);
}

function findLatestActiveReview(
  events: AgentEvent[],
  resolvedReviews: Set<string>,
  resolvedReviewRuns: Set<string>
): ActiveSessionInteraction | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'review_summary') continue;
    const payload = asRecord(event.payload);
    if (!payload || stringField(payload, 'status') !== 'waitingUserReview') continue;
    if (hasLaterTerminalInteraction(events, index)) continue;
    const runId = stringField(payload, 'runId');
    const reviewId = stringField(payload, 'reviewId');
    const sourcePlanId = stringField(payload, 'sourcePlanId');
    const reviewKey = reviewDecisionKey(runId, reviewId, sourcePlanId);
    if (!runId || resolvedReviews.has(reviewKey) || resolvedReviewRuns.has(runId)) continue;
    return {
      kind: 'review',
      runId,
      title: stringField(payload, 'title'),
      summary: stringField(payload, 'summary'),
    };
  }
  return null;
}

function findLatestActivePlan(
  events: AgentEvent[],
  resolvedPlans: Set<string>,
  resolvedPlanRuns: Set<string>
): ActiveSessionInteraction | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'plan_review' && event.kind !== 'plan_card') continue;
    const payload = asRecord(event.payload);
    if (!payload) continue;
    if (hasLaterTerminalInteraction(events, index)) continue;
    const runId = stringField(payload, 'runId');
    const planId = stringField(payload, 'planId');
    const waiting = event.kind === 'plan_card'
      ? planCardAwaitingDecision(payload)
      : planReviewAwaitingDecision(payload);
    const planKey = planDecisionKey(runId, planId);
    if (!waiting || !runId || !planId || resolvedPlans.has(planKey) || resolvedPlanRuns.has(runId)) continue;
    return {
      kind: 'plan',
      runId,
      planId,
      title: stringField(payload, 'title'),
      summary: stringField(payload, 'summary'),
    };
  }
  return null;
}

function findLatestActiveRequirement(
  events: AgentEvent[],
  resolvedRequirements: Set<string>
): ActiveSessionInteraction | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'requirement_confirmation') continue;
    const payload = asRecord(event.payload);
    if (!payload) continue;
    if (hasLaterTerminalInteraction(events, index)) continue;
    const runId = stringField(payload, 'runId');
    const requirementId = stringField(payload, 'requirementId');
    const status = stringField(payload, 'status');
    const key = requirementDecisionKey(runId, requirementId);
    if (
      payload.confirmable === true &&
      status === 'waitingUserConfirmation' &&
      runId &&
      requirementId &&
      !resolvedRequirements.has(key)
    ) {
      return {
        kind: 'requirement',
        runId,
        requirementId,
        title: stringField(payload, 'title'),
        summary: stringField(payload, 'summary'),
      };
    }
  }
  return null;
}

function hasLaterTerminalInteraction(events: AgentEvent[], index: number): boolean {
  for (let nextIndex = index + 1; nextIndex < events.length; nextIndex += 1) {
    const event = events[nextIndex];
    const payload = asRecord(event.payload);
    if (!payload) continue;
    const status = stringField(payload, 'status');
    if (!isTerminalStatus(status)) continue;
    if (
      event.kind === 'requirement_decision' ||
      event.kind === 'plan_review' ||
      event.kind === 'review_summary'
    ) {
      return true;
    }
  }
  return false;
}

function collectResolvedRequirementKeys(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'requirement_decision') continue;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
    const key = requirementDecisionKey(stringField(payload, 'runId'), stringField(payload, 'requirementId'));
    if (key) resolved.add(key);
  }
  return resolved;
}

function collectResolvedReviewKeys(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'review_summary') continue;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
    const key = reviewDecisionKey(
      stringField(payload, 'runId'),
      stringField(payload, 'reviewId'),
      stringField(payload, 'sourcePlanId')
    );
    if (key) resolved.add(key);
  }
  return resolved;
}

function collectResolvedReviewRuns(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'review_summary') continue;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
    const runId = stringField(payload, 'runId');
    if (runId) resolved.add(runId);
  }
  return resolved;
}

function collectResolvedPlanKeys(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'plan_review') continue;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
    const key = planDecisionKey(stringField(payload, 'runId'), stringField(payload, 'planId'));
    if (key) resolved.add(key);
  }
  return resolved;
}

function collectResolvedPlanRuns(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'plan_review') continue;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
    const runId = stringField(payload, 'runId');
    if (runId) resolved.add(runId);
  }
  return resolved;
}

function isTerminalStatus(status?: string): boolean {
  return status === 'accepted' ||
    status === 'rejected' ||
    status === 'needsRevision' ||
    status === 'cancelled' ||
    status === 'failed';
}

function planCardAwaitingDecision(payload: Record<string, unknown>): boolean {
  if (payload.confirmable === false) return false;
  const status = stringField(payload, 'status');
  if (!status) return true;
  return planReviewStatusAwaitingUser(status);
}

function planReviewAwaitingDecision(payload: Record<string, unknown>): boolean {
  if (payload.confirmable === false) return false;
  return planReviewStatusAwaitingUser(stringField(payload, 'status'));
}

function planReviewStatusAwaitingUser(status?: string): boolean {
  return status === undefined ||
    status === 'awaitingUserApproval' ||
    status === 'awaitingTemporaryGrant' ||
    status === 'pending';
}

function planDecisionKey(runId?: string, planId?: string): string {
  return runId && planId ? `${runId}::${planId}` : '';
}

function requirementDecisionKey(runId?: string, requirementId?: string): string {
  return runId && requirementId ? `${runId}::${requirementId}` : '';
}

function reviewDecisionKey(runId?: string, reviewId?: string, sourcePlanId?: string): string {
  if (!runId) return '';
  return `${runId}::${reviewId || sourcePlanId || runId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}
