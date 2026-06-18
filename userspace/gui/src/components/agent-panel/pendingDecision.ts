import type { AgentEvent, PermissionRequest } from '@deepcode/protocol';
import { findActiveSessionInteraction } from '../../state/sessionInteractions';

export interface AgentComposerDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

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

export function findPendingComposerDecision(input: {
  events: AgentEvent[];
  pendingPermission?: PermissionRequest | null;
  resolvingRequirement?: { runId: string; requirementId: string } | null;
  resolvingPlan?: { runId: string; planId: string } | null;
  resolvingReview?: { runId: string } | null;
  resolvingPermission?: { id: string } | null;
}): AgentComposerPendingDecision | null {
  const active = findActiveSessionInteraction({
    events: input.events,
    pendingPermission: input.pendingPermission,
  });
  if (!active) return null;
  if (active.kind === 'permission') {
    return {
      ...active,
      resolving: input.resolvingPermission?.id === active.requestId,
    };
  }
  if (active.kind === 'requirement') {
    return {
      ...active,
      decisionRequest: findRequirementDecisionRequest(input.events, active.runId, active.requirementId),
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}
