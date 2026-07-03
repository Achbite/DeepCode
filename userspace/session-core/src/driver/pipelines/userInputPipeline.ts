import type { AgentEvent } from '@deepcode/protocol';

export interface RequirementActiveInteractionRef {
  kind: 'requirement';
  runId: string;
  requirementId: string;
}

export interface RequirementInteractionCandidateRef {
  kind: string;
  runId?: string;
  requirementId?: string;
}

export class UserInputPipeline {
  findLatestActiveRequirementInteraction(events: AgentEvent[]): RequirementActiveInteractionRef | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.kind !== 'requirement_confirmation') continue;
      const payload = objectRecord(event.payload);
      if (!payload || payload.confirmable !== true) continue;
      if (this.hasLaterTerminalInteraction(events, index)) continue;
      const runId = stringValue(payload.runId);
      const requirementId = stringValue(payload.requirementId);
      if (!runId || !requirementId || stringValue(payload.status) !== 'waitingUserConfirmation') continue;
      if (this.requirementAlreadyResolved(events, runId, requirementId)) continue;
      return { kind: 'requirement', runId, requirementId };
    }
    return null;
  }

  findRequirementConfirmation(
    events: AgentEvent[],
    runId?: string,
    requirementId?: string,
    active?: RequirementInteractionCandidateRef | null
  ): AgentEvent | null {
    let direct: AgentEvent | undefined;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.kind !== 'requirement_confirmation') continue;
      const payload = objectRecord(event.payload);
      if (!payload || payload.confirmable !== true) continue;
      const candidateRunId = stringValue(payload.runId);
      const candidateRequirementId = stringValue(payload.requirementId);
      if (runId && candidateRunId !== runId) continue;
      if (requirementId && candidateRequirementId !== requirementId) continue;
      if (!candidateRunId || !candidateRequirementId) continue;
      if (stringValue(payload.status) !== 'waitingUserConfirmation') continue;
      if (this.hasLaterTerminalInteraction(events, index)) continue;
      if (this.requirementAlreadyResolved(events, candidateRunId, candidateRequirementId)) continue;
      direct = event;
      break;
    }
    if (direct) return direct;

    if (
      !active ||
      active.kind !== 'requirement' ||
      (runId && active.runId !== runId) ||
      (requirementId && active.requirementId !== requirementId)
    ) {
      return null;
    }
    return [...events].reverse().find((event) => {
      if (event.kind !== 'requirement_confirmation') return false;
      const payload = objectRecord(event.payload);
      if (!payload || payload.confirmable !== true) return false;
      if (runId && stringValue(payload.runId) !== runId) return false;
      if (requirementId && stringValue(payload.requirementId) !== requirementId) return false;
      return stringValue(payload.status) === 'waitingUserConfirmation';
    }) ?? null;
  }

  private hasLaterTerminalInteraction(events: AgentEvent[], index: number): boolean {
    for (let nextIndex = index + 1; nextIndex < events.length; nextIndex += 1) {
      const event = events[nextIndex];
      if (
        event.kind !== 'requirement_decision' &&
        event.kind !== 'plan_review' &&
        event.kind !== 'review_summary'
      ) {
        continue;
      }
      const payload = objectRecord(event.payload);
      const status = stringValue(payload?.status);
      if (status === 'accepted' || status === 'rejected' || status === 'needsRevision') return true;
    }
    return false;
  }

  private requirementAlreadyResolved(events: AgentEvent[], runId: string, requirementId: string): boolean {
    return events.some((event) => {
      if (event.kind !== 'requirement_decision') return false;
      const payload = objectRecord(event.payload);
      if (!payload) return false;
      const status = stringValue(payload.status);
      if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
      return stringValue(payload.runId) === runId && stringValue(payload.requirementId) === requirementId;
    });
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
