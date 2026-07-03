import type { AgentEvent } from '@deepcode/protocol';

export interface PlanInteractionRef {
  kind: 'plan';
  runId: string;
  planId: string;
}

export interface PlanInteractionIndexPorts<TPlan> {
  planCardAwaitingDecision(payload: Record<string, unknown>): boolean;
  planReviewEventAwaitingDecision(payload: Record<string, unknown>): boolean;
  planContextFromEvent(event: AgentEvent, payload: Record<string, unknown>): TPlan | null;
  findPlanCard(events: AgentEvent[], runId: string, planId: string): TPlan | null;
  planAlreadyResolved(events: AgentEvent[], plan: TPlan): boolean;
}

export class PlanInteractionIndex<TPlan> {
  constructor(private readonly ports: PlanInteractionIndexPorts<TPlan>) {}

  findLatestActivePlanInteraction(events: AgentEvent[]): PlanInteractionRef | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.kind !== 'plan_review' && event.kind !== 'plan_card') continue;
      const payload = objectRecord(event.payload);
      if (!payload) continue;
      const waiting = event.kind === 'plan_card'
        ? this.ports.planCardAwaitingDecision(payload)
        : this.ports.planReviewEventAwaitingDecision(payload);
      const runId = stringValue(payload.runId);
      const planId = stringValue(payload.planId);
      if (!waiting || !runId || !planId) continue;
      const plan = event.kind === 'plan_card'
        ? this.ports.planContextFromEvent(event, payload)
        : this.ports.findPlanCard(events.slice(0, index + 1), runId, planId);
      if (!plan || this.ports.planAlreadyResolved(events, plan)) continue;
      return { kind: 'plan', runId, planId };
    }
    return null;
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
