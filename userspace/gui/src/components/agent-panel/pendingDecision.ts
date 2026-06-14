import type { AgentEvent, PermissionRequest } from '@deepcode/protocol';

export type AgentComposerPendingDecision =
  | {
      kind: 'requirement';
      runId: string;
      requirementId: string;
      title?: string;
      summary?: string;
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

export function findPendingComposerDecision(input: {
  events: AgentEvent[];
  pendingPermission?: PermissionRequest | null;
  resolvingRequirement?: { runId: string; requirementId: string } | null;
  resolvingPlan?: { runId: string; planId: string } | null;
  resolvingReview?: { runId: string } | null;
  resolvingPermission?: { id: string } | null;
}): AgentComposerPendingDecision | null {
  if (input.pendingPermission) {
    return {
      kind: 'permission',
      requestId: input.pendingPermission.id,
      title: input.pendingPermission.toolName,
      summary: input.pendingPermission.summary,
      resolving: input.resolvingPermission?.id === input.pendingPermission.id,
    };
  }

  const resolvedPlans = collectResolvedPlanKeys(input.events);
  const resolvedRuns = collectResolvedPlanRuns(input.events);
  const resolvedRequirements = collectResolvedRequirementKeys(input.events);
  const resolvedReviews = collectResolvedReviewKeys(input.events);
  const resolvedReviewRuns = collectResolvedReviewRuns(input.events);

  for (const event of [...input.events].reverse()) {
    const payload = asRecord(event.payload);
    if (!payload) continue;
    if (event.kind === 'requirement_confirmation') {
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
          resolving: input.resolvingRequirement?.runId === runId &&
            input.resolvingRequirement?.requirementId === requirementId,
        };
      }
    }
    if (event.kind === 'review_summary') {
      const runId = stringField(payload, 'runId');
      const reviewId = stringField(payload, 'reviewId');
      const sourcePlanId = stringField(payload, 'sourcePlanId');
      const status = stringField(payload, 'status');
      const reviewKey = reviewDecisionKey(runId, reviewId, sourcePlanId);
      if (
        payload.confirmable === true &&
        status === 'waitingUserReview' &&
        runId &&
        !resolvedReviews.has(reviewKey) &&
        !resolvedReviewRuns.has(runId)
      ) {
        return {
          kind: 'review',
          runId,
          title: stringField(payload, 'title'),
          summary: stringField(payload, 'summary'),
          resolving: input.resolvingReview?.runId === runId,
        };
      }
    }
    if (event.kind === 'plan_review') {
      const runId = stringField(payload, 'runId');
      const planId = stringField(payload, 'planId');
      const status = stringField(payload, 'status');
      const planKey = planDecisionKey(runId, planId);
      if (
        payload.confirmable === true &&
        (status === 'awaitingUserApproval' || status === 'awaitingTemporaryGrant' || status === 'pending') &&
        runId &&
        planId &&
        !resolvedPlans.has(planKey) &&
        !resolvedRuns.has(runId)
      ) {
        return {
          kind: 'plan',
          runId,
          planId,
          title: stringField(payload, 'title'),
          summary: stringField(payload, 'summary'),
          resolving: input.resolvingPlan?.runId === runId && input.resolvingPlan?.planId === planId,
        };
      }
    }
  }
  return null;
}

function collectResolvedRequirementKeys(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'requirement_decision') continue;
    const payload = asRecord(event.payload);
    if (!payload) continue;
    const status = stringField(payload, 'status');
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') continue;
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
    if (!payload) continue;
    const status = stringField(payload, 'status');
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') continue;
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
    if (!payload) continue;
    const status = stringField(payload, 'status');
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') continue;
    const runId = stringField(payload, 'runId');
    const reviewId = stringField(payload, 'reviewId');
    const sourcePlanId = stringField(payload, 'sourcePlanId');
    if (runId && !reviewId && !sourcePlanId) resolved.add(runId);
  }
  return resolved;
}

function collectResolvedPlanKeys(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'plan_review') continue;
    const payload = asRecord(event.payload);
    if (!payload) continue;
    const status = stringField(payload, 'status');
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') continue;
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
    if (!payload) continue;
    const status = stringField(payload, 'status');
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') continue;
    const runId = stringField(payload, 'runId');
    const planId = stringField(payload, 'planId');
    if (runId && !planId) resolved.add(runId);
  }
  return resolved;
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
