import type { AgentContextAttachment, AgentEvent } from '@deepcode/protocol';
import { AcceptedPlanExecutionRootResolver } from '../../accepted-plan/AcceptedPlanExecutionRootResolver.js';
import type { RequirementChecklist, RequirementRecord } from '../../requirement/types.js';

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

  requirementRecordFromEvent(event: AgentEvent, status: RequirementRecord['status']): RequirementRecord | undefined {
    const payload = objectRecord(event.payload);
    const raw = objectRecord(payload?.requirement);
    const decisionRequest = objectRecord(payload?.decisionRequest);
    if (!raw) {
      const requirementId = stringValue(payload?.requirementId) ?? stringValue(decisionRequest?.id) ?? event.id;
      const initialUserRequest = stringValue(payload?.initialUserRequest)
        ?? stringValue(payload?.originalUserRequest)
        ?? stringValue(payload?.content)
        ?? '';
      const goal = stringValue(decisionRequest?.summary)
        ?? stringValue(decisionRequest?.question)
        ?? stringValue(decisionRequest?.reason)
        ?? stringValue(payload?.summary)
        ?? initialUserRequest;
      return {
        requirementId,
        sessionId: event.sessionId,
        initialUserRequest,
        checklist: {
          goal,
          explicitTasks: [],
          inferredTasks: [],
          outOfScope: [],
          affectedAreaCandidates: [],
          resourceRequests: [],
          acceptanceCriteriaCandidates: [],
          clarificationQuestions: [],
          riskNotes: [],
        },
        status,
        createdAt: event.ts,
        updatedAt: new Date().toISOString(),
      };
    }
    const checklist = objectRecord(raw.checklist);
    return {
      requirementId: stringValue(raw.requirementId) ?? stringValue(payload?.requirementId) ?? event.id,
      sessionId: stringValue(raw.sessionId) ?? event.sessionId,
      initialUserRequest: stringValue(raw.initialUserRequest)
        ?? stringValue(payload?.initialUserRequest)
        ?? stringValue(payload?.originalUserRequest)
        ?? '',
      checklist: checklist ? {
        goal: stringValue(checklist.goal) ?? '',
        explicitTasks: stringArray(checklist.explicitTasks),
        inferredTasks: stringArray(checklist.inferredTasks),
        outOfScope: stringArray(checklist.outOfScope),
        affectedAreaCandidates: stringArray(checklist.affectedAreaCandidates),
        resourceRequests: stringArray(checklist.resourceRequests),
        acceptanceCriteriaCandidates: stringArray(checklist.acceptanceCriteriaCandidates),
        clarificationQuestions: stringArray(checklist.clarificationQuestions),
        riskNotes: stringArray(checklist.riskNotes),
      } satisfies RequirementChecklist : undefined,
      status,
      createdAt: stringValue(raw.createdAt) ?? event.ts,
      updatedAt: new Date().toISOString(),
    };
  }

  requirementOriginalRequest(event: AgentEvent): string {
    const payload = objectRecord(event.payload);
    return stringValue(payload?.originalUserRequest)
      ?? this.requirementRecordFromEvent(event, 'confirmed')?.initialUserRequest
      ?? '';
  }

  requirementDecisionResumeRequest(
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    decision: 'accept' | 'reject' | 'revise',
    guidance?: string
  ): string {
    const originalRequest = this.requirementOriginalRequest(confirmation);
    if (decision === 'revise') {
      return [
        originalRequest,
        '',
        guidance?.trim()
          ? `User revision guidance for the previous intervention request (verbatim):\n${guidance.trim()}`
          : 'The user asked to revise the current intervention request.',
        '',
        'Write user-visible proposal fields in the current user request language; keep protocol keys, toolIds, paths, and evidence refs unchanged.',
      ].join('\n');
    }
    if (decision !== 'accept') return originalRequest;
    const payload = objectRecord(decisionEvent.payload);
    const selectedOption = objectRecord(payload?.selectedOption);
    const lines = [
      originalRequest,
      '',
      'The user has resolved the previous decisionRequest. Continue the parent flow from that selected decision.',
      'Do not repeat the same decisionRequest unless a new independent decision point appears later.',
      'Write user-visible proposal fields in the current user request language; keep protocol keys, toolIds, paths, and evidence refs unchanged.',
    ];
    const id = stringValue(selectedOption?.id);
    const label = stringValue(selectedOption?.label);
    const description = stringValue(selectedOption?.description);
    if (id || label || description) {
      lines.push('', 'Selected option:');
      if (id) lines.push(`- id: ${id}`);
      if (label) lines.push(`- label: ${label}`);
      if (description) lines.push(`- description: ${description}`);
    }
    if (guidance?.trim()) {
      lines.push('', 'Additional user guidance (verbatim):', guidance.trim());
    }
    return lines.join('\n');
  }

  acceptedPlanExecutionRequirementResumeRequest(
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    decision: 'accept' | 'reject' | 'revise',
    guidance?: string
  ): string {
    return [
      this.requirementDecisionResumeRequest(confirmation, decisionEvent, decision, guidance),
      '',
      'Accepted-plan continuation rule:',
      '- This decision belongs to the current accepted implementationPlan execution checkpoint.',
      '- Continue the same accepted taskPlan and current task cursor.',
      '- Do not create a new standalone plan or final Review unless all accepted tasks are complete.',
      '- If returning actionBundle, keep targets and capabilities inside the accepted plan scope.',
    ].join('\n');
  }

  requirementAttachments(event: AgentEvent): AgentContextAttachment[] {
    return AcceptedPlanExecutionRootResolver.attachmentsFromEvent(event);
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
