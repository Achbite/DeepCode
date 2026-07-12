import type { AgentEvent, PermissionRequest } from '@deepcode/protocol';

export type InteractionLedgerOptionEffect =
  | { kind: 'continueWithAction' }
  | { kind: 'skipCurrentTask' }
  | { kind: 'replan'; reason?: string }
  | { kind: 'finishRun' };

export interface InteractionLedgerDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  effect?: InteractionLedgerOptionEffect;
}

export interface InteractionLedgerDecisionRequest {
  id?: string;
  reason?: string;
  summary?: string;
  allowsFreeform: boolean;
  options: InteractionLedgerDecisionOption[];
}

export type InteractionLedgerActiveInteraction =
  | {
      kind: 'permission';
      requestId: string;
      request: PermissionRequest;
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
      decisionRequest?: InteractionLedgerDecisionRequest;
    };

export function findActiveInteraction(input: {
  events: readonly AgentEvent[];
  pendingPermission?: PermissionRequest | null;
}): InteractionLedgerActiveInteraction | null {
  if (input.pendingPermission) {
    return {
      kind: 'permission',
      requestId: input.pendingPermission.id,
      request: input.pendingPermission,
      title: input.pendingPermission.toolName,
      summary: input.pendingPermission.summary,
    };
  }

  const events = [...input.events];
  const resolvedPlans = collectResolvedPlanKeys(events);
  const resolvedPlanRuns = collectResolvedPlanRuns(events);
  const resolvedRequirements = collectResolvedRequirementKeys(events);
  const resolvedReviews = collectResolvedReviewKeys(events);
  const resolvedReviewRuns = collectResolvedReviewRuns(events);

  return findLatestActiveReview(events, resolvedReviews, resolvedReviewRuns)
    ?? findLatestActivePlan(events, resolvedPlans, resolvedPlanRuns)
    ?? findLatestActiveRequirement(events, resolvedRequirements);
}

function findLatestActiveReview(
  events: AgentEvent[],
  resolvedReviews: Set<string>,
  resolvedReviewRuns: Set<string>
): InteractionLedgerActiveInteraction | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'review_summary') continue;
    const payload = asRecord(event.payload);
    if (!payload || stringField(payload, 'status') !== 'waitingUserReview') continue;
    const runId = stringField(payload, 'runId');
    const reviewId = stringField(payload, 'reviewId');
    const sourcePlanId = stringField(payload, 'sourcePlanId');
    const reviewKey = reviewDecisionKey(runId, reviewId, sourcePlanId);
    if (!runId || hasTerminalRunState(events, runId) || resolvedReviews.has(reviewKey) || resolvedReviewRuns.has(runId)) {
      continue;
    }
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
): InteractionLedgerActiveInteraction | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'plan_review' && event.kind !== 'plan_card') continue;
    const payload = asRecord(event.payload);
    if (!payload) continue;
    const runId = stringField(payload, 'runId');
    const planId = stringField(payload, 'planId');
    const waiting = event.kind === 'plan_card'
      ? planCardAwaitingDecision(payload)
      : planReviewAwaitingDecision(payload);
    const planKey = planDecisionKey(runId, planId);
    if (
      !waiting ||
      !runId ||
      !planId ||
      hasTerminalRunState(events, runId) ||
      resolvedPlans.has(planKey) ||
      resolvedPlanRuns.has(runId)
    ) {
      continue;
    }
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
): InteractionLedgerActiveInteraction | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'requirement_confirmation') continue;
    const payload = asRecord(event.payload);
    if (!payload) continue;
    const runId = stringField(payload, 'runId');
    const requirementId = stringField(payload, 'requirementId');
    const status = stringField(payload, 'status');
    const key = requirementDecisionKey(runId, requirementId);
    if (
      payload.confirmable === true &&
      status === 'waitingUserConfirmation' &&
      runId &&
      requirementId &&
      !hasTerminalRunState(events, runId) &&
      !resolvedRequirements.has(key)
    ) {
      return {
        kind: 'requirement',
        runId,
        requirementId,
        title: stringField(payload, 'title'),
        summary: stringField(payload, 'summary'),
        decisionRequest: decisionRequestFromPayload(payload),
      };
    }
  }
  return null;
}

function collectResolvedRequirementKeys(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind === 'session_run_state') {
      const payload = asRecord(event.payload);
      if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
      if (interactionOwnerKind(payload) !== 'requirement') continue;
      const key = requirementDecisionKey(
        stringField(payload, 'runId'),
        interactionOwnerId(payload, 'requirement')
      );
      if (key) resolved.add(key);
      continue;
    }
    if (event.kind !== 'requirement_decision') continue;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
    const key = requirementDecisionKey(stringField(payload, 'runId'), stringField(payload, 'requirementId'));
    if (key) resolved.add(key);
  }
  return resolved;
}

function collectResolvedPlanKeys(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind === 'session_run_state') {
      const payload = asRecord(event.payload);
      if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
      if (interactionOwnerKind(payload) !== 'plan') continue;
      const key = planDecisionKey(
        stringField(payload, 'runId'),
        interactionOwnerId(payload, 'plan')
      );
      if (key) resolved.add(key);
      continue;
    }
    if (event.kind !== 'plan_review' && event.kind !== 'review_summary') continue;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
    const runId = stringField(payload, 'runId');
    const planId = stringField(payload, 'planId') ??
      stringField(payload, 'sourcePlanId') ??
      stringField(payload, 'targetId');
    const key = planDecisionKey(runId, planId);
    if (key) resolved.add(key);
  }
  return resolved;
}

function collectResolvedPlanRuns(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'plan_review' && event.kind !== 'review_summary') continue;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
    const runId = stringField(payload, 'runId');
    if (runId) resolved.add(runId);
  }
  return resolved;
}

function collectResolvedReviewKeys(events: AgentEvent[]): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.kind === 'session_run_state') {
      const payload = asRecord(event.payload);
      if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
      if (interactionOwnerKind(payload) !== 'review') continue;
      const key = reviewDecisionKey(
        stringField(payload, 'runId'),
        interactionOwnerId(payload, 'review'),
        stringField(payload, 'sourcePlanId')
      );
      if (key) resolved.add(key);
      continue;
    }
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
    if (event.kind === 'session_run_state') {
      const payload = asRecord(event.payload);
      if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
      if (interactionOwnerKind(payload) === 'review') {
        const runId = stringField(payload, 'runId');
        if (runId) resolved.add(runId);
      }
      continue;
    }
    if (event.kind !== 'review_summary') continue;
    const payload = asRecord(event.payload);
    if (!payload || !isTerminalStatus(stringField(payload, 'status'))) continue;
    const runId = stringField(payload, 'runId');
    if (runId) resolved.add(runId);
  }
  return resolved;
}

function hasTerminalRunState(events: AgentEvent[], runId: string): boolean {
  return events.some((event) => {
    if (event.kind !== 'session_run_state') return false;
    const payload = asRecord(event.payload);
    if (!payload || stringField(payload, 'runId') !== runId) return false;
    return isTerminalStatus(stringField(payload, 'status'));
  });
}

function decisionRequestFromPayload(payload: Record<string, unknown>): InteractionLedgerDecisionRequest | undefined {
  const decisionRequest = asRecord(payload.decisionRequest);
  if (!decisionRequest) return undefined;
  const options = Array.isArray(decisionRequest.options)
    ? decisionRequest.options.flatMap((item): InteractionLedgerDecisionOption[] => {
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
        effect: optionEffect(option.effect),
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

function optionEffect(value: unknown): InteractionLedgerOptionEffect | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = stringField(record, 'kind');
  switch (kind) {
    case 'continueWithAction':
    case 'skipCurrentTask':
    case 'finishRun':
      return { kind };
    case 'replan':
      return { kind, reason: stringField(record, 'reason') };
    default:
      return undefined;
  }
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

function isTerminalStatus(status?: string): boolean {
  return status === 'accepted' ||
    status === 'rejected' ||
    status === 'needsRevision' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'completed';
}

function planDecisionKey(runId?: string, planId?: string): string {
  if (planId) return `plan:${planId}`;
  return runId ? `run:${runId}` : '';
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
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

function interactionOwnerKind(payload: Record<string, unknown>): string | undefined {
  const owner = asRecord(payload.decisionOwner);
  return stringField(payload, 'decisionKind') ?? (owner ? stringField(owner, 'kind') : undefined);
}

function interactionOwnerId(payload: Record<string, unknown>, kind: 'plan' | 'requirement' | 'review'): string | undefined {
  const owner = asRecord(payload.decisionOwner);
  if (kind === 'plan') {
    return stringField(payload, 'planId') ??
      stringField(payload, 'sourcePlanId') ??
      (owner ? stringField(owner, 'planId') : undefined) ??
      stringField(payload, 'targetId') ??
      (owner ? stringField(owner, 'targetId') : undefined);
  }
  if (kind === 'requirement') {
    return stringField(payload, 'requirementId') ??
      (owner ? stringField(owner, 'requirementId') : undefined) ??
      stringField(payload, 'targetId') ??
      (owner ? stringField(owner, 'targetId') : undefined);
  }
  return stringField(payload, 'reviewId') ??
    (owner ? stringField(owner, 'reviewId') : undefined) ??
    stringField(payload, 'targetId') ??
    (owner ? stringField(owner, 'targetId') : undefined);
}
