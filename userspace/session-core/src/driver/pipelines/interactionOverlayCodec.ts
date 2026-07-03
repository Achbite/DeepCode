import type { AgentEvent } from '@deepcode/protocol';

export type SessionTurnPhase =
  | 'context_reading'
  | 'provider_proposing'
  | 'waiting_requirement_confirmation'
  | 'waiting_plan_review'
  | 'waiting_permission'
  | 'executing_accepted_plan'
  | 'executing'
  | 'waiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface InteractionOverlayContext {
  parentRunId: string;
  parentPhase: SessionTurnPhase;
  interactionRunId: string;
  interactionId: string;
  sourceInteractionId?: string;
  resumedFromDecisionId?: string;
  acceptedPlanId?: string;
  acceptedPlanRunId?: string;
  acceptedCurrentTaskId?: string;
  acceptedCompletedTaskIds?: string[];
}

export class InteractionOverlayCodec {
  fromRequirementDecision(confirmation: AgentEvent, decision: AgentEvent): InteractionOverlayContext | undefined {
    const confirmationPayload = objectRecord(confirmation.payload) ?? {};
    const overlay = this.fromPayload(confirmationPayload);
    if (!overlay) return undefined;
    return {
      ...overlay,
      resumedFromDecisionId: decision.id,
    };
  }

  fromPayload(payload: Record<string, unknown> | undefined): InteractionOverlayContext | undefined {
    if (!payload || payload.interactionOverlay !== true) return undefined;
    const parentRunId = stringValue(payload.parentRunId);
    const parentPhase = this.sessionTurnPhaseValue(payload.parentPhase);
    const interactionRunId = stringValue(payload.interactionRunId) ?? stringValue(payload.runId);
    const interactionId = stringValue(payload.interactionId)
      ?? stringValue(payload.requirementId)
      ?? stringValue(payload.targetId);
    if (!parentRunId || !parentPhase || !interactionRunId || !interactionId) return undefined;
    return {
      parentRunId,
      parentPhase,
      interactionRunId,
      interactionId,
      sourceInteractionId: stringValue(payload.sourceInteractionId) ?? interactionId,
      resumedFromDecisionId: stringValue(payload.resumedFromDecisionId),
      acceptedPlanId: stringValue(payload.acceptedPlanId),
      acceptedPlanRunId: stringValue(payload.acceptedPlanRunId),
      acceptedCurrentTaskId: stringValue(payload.acceptedCurrentTaskId),
      acceptedCompletedTaskIds: stringArrayValue(payload.acceptedCompletedTaskIds),
    };
  }

  toPayload(overlay: InteractionOverlayContext | undefined): Record<string, unknown> {
    if (!overlay) return {};
    return {
      interactionOverlay: true,
      parentRunId: overlay.parentRunId,
      parentPhase: overlay.parentPhase,
      interactionRunId: overlay.interactionRunId,
      interactionId: overlay.interactionId,
      sourceInteractionId: overlay.sourceInteractionId ?? overlay.interactionId,
      resumedFromDecisionId: overlay.resumedFromDecisionId,
      acceptedPlanId: overlay.acceptedPlanId,
      acceptedPlanRunId: overlay.acceptedPlanRunId,
      acceptedCurrentTaskId: overlay.acceptedCurrentTaskId,
      acceptedCompletedTaskIds: overlay.acceptedCompletedTaskIds,
    };
  }

  private sessionTurnPhaseValue(value: unknown): SessionTurnPhase | undefined {
    const phase = stringValue(value);
    if (
      phase === 'context_reading' ||
      phase === 'provider_proposing' ||
      phase === 'waiting_requirement_confirmation' ||
      phase === 'waiting_plan_review' ||
      phase === 'waiting_permission' ||
      phase === 'executing_accepted_plan' ||
      phase === 'executing' ||
      phase === 'waiting_review' ||
      phase === 'completed' ||
      phase === 'failed' ||
      phase === 'cancelled'
    ) {
      return phase;
    }
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}
