import type { AgentEvent } from '@deepcode/protocol';
import { stableHash } from '../cache/canonicalizer.js';

export class ReviewFactsAggregator {
  static acceptedPlanKernelEvents(
    events: AgentEvent[],
    runId: string,
    planId: string | undefined,
    currentKernelEvents: unknown[]
  ): unknown[] {
    const output: unknown[] = [];
    const seen = new Set<string>();
    let startIndex = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.kind !== 'plan_review') continue;
      const payload = objectRecord(event.payload) ?? {};
      if (stringValue(payload.status) !== 'accepted') continue;
      const payloadRunId = stringValue(payload.runId);
      const payloadPlanId = stringValue(payload.planId);
      if (payloadRunId && payloadRunId !== runId) continue;
      if (planId && payloadPlanId && payloadPlanId !== planId) continue;
      startIndex = index;
      break;
    }
    const push = (event: unknown): void => {
      const record = objectRecord(event);
      if (!record) return;
      const eventPlanId = stringValue(record.planId)
        ?? stringValue(objectRecord(record.batch)?.planId)
        ?? stringValue(objectRecord(record.facts)?.planId);
      if (planId && eventPlanId && eventPlanId !== planId) return;
      const key = stableHash(JSON.stringify(record));
      if (seen.has(key)) return;
      seen.add(key);
      output.push(record);
    };
    for (const event of events.slice(startIndex)) {
      const payload = objectRecord(event.payload);
      const kernelEvent = objectRecord(payload?.kernelEvent);
      if (kernelEvent) push(kernelEvent);
    }
    for (const event of currentKernelEvents) push(event);
    return output;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
