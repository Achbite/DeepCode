import type { AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { AcceptedImplementationPlanExecutionRoot } from '../../accepted-plan/types.js';
import type { InteractionOverlayContext } from '../pipelines/interactionOverlayCodec.js';

export interface PlanContext {
  sessionId: string;
  runId: string;
  planId: string;
  proposalId?: string;
  userPlan: string;
  actionBundle: Record<string, unknown>;
  codeBlocks: unknown[];
  commandBlocks: unknown[];
  expectedValidation: string;
  reviewGuide: string;
  planReviewReport?: Record<string, unknown>;
  implementationPlan?: Record<string, unknown>;
  interactionOverlay?: InteractionOverlayContext;
  executionRoot?: AcceptedImplementationPlanExecutionRoot;
}

export interface PlanContextIndexPorts {
  interactionOverlayFromPayload(payload: Record<string, unknown>): InteractionOverlayContext | undefined;
  executionRootFromPayload(payload: Record<string, unknown>): AcceptedImplementationPlanExecutionRoot | undefined;
}

export class PlanContextIndex {
  constructor(private readonly ports: PlanContextIndexPorts) {}

  findPlanCard(events: AgentEvent[], runId?: string, planId?: string): PlanContext | null {
    for (const event of [...events].reverse()) {
      if (event.kind !== 'plan_card') continue;
      const payload = objectRecord(event.payload);
      const candidate = payload ? this.contextFromEvent(event, payload) : null;
      if (!candidate) continue;
      if (runId && candidate.runId !== runId) continue;
      if (planId && !this.aliases(candidate).has(planId)) continue;
      return candidate;
    }
    return null;
  }

  latestExecutablePlan(events: AgentEvent[], previousRunId?: string): PlanContext | null {
    for (const event of [...events].reverse()) {
      if (event.kind !== 'plan_card') continue;
      const payload = objectRecord(event.payload);
      const candidate = payload ? this.contextFromEvent(event, payload) : null;
      if (!candidate) continue;
      if (previousRunId && candidate.runId === previousRunId) continue;
      if (this.alreadyResolved(events, candidate)) continue;
      return candidate;
    }
    return null;
  }

  contextFromEvent(event: AgentEvent, payload: Record<string, unknown>): PlanContext | null {
    const implementationPlan = objectRecord(payload.taskPlan) ?? objectRecord(payload.implementationPlan) ?? undefined;
    const actionBundle = objectRecord(payload.actionBundle) ?? (implementationPlan ? {
      id: stringValue(payload.planId) ?? stringValue(implementationPlan.id) ?? stringValue(payload.proposalId),
      version: '1',
      actions: [],
    } : undefined);
    if (!actionBundle) return null;
    const planId = stringValue(payload.planId)
      ?? stringValue(actionBundle.id)
      ?? stringValue(implementationPlan?.id)
      ?? stringValue(payload.proposalId);
    const runId = stringValue(payload.runId);
    if (!planId || !runId) return null;
    return {
      sessionId: event.sessionId,
      runId,
      planId,
      proposalId: stringValue(payload.proposalId),
      userPlan: stringValue(payload.content) ?? stringValue(payload.summary) ?? 'Agent plan',
      actionBundle: actionBundle as unknown as Record<string, unknown>,
      codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
      commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
      expectedValidation: stringValue(payload.expectedValidation) ?? '',
      reviewGuide: stringValue(payload.reviewGuide) ?? '',
      planReviewReport: objectRecord(payload.planReviewReport) ?? undefined,
      implementationPlan,
      interactionOverlay: this.ports.interactionOverlayFromPayload(payload),
      executionRoot: this.ports.executionRootFromPayload(payload),
    };
  }

  proposalEnvelope(plan: PlanContext): ProposalEnvelope {
    return {
      schemaVersion: 'deepcode.agent.protocol.v3',
      proposalId: plan.proposalId ?? plan.planId,
      runId: plan.runId,
      sessionId: plan.sessionId,
      source: 'system',
      kind: 'actionBundle',
      narration: plan.userPlan,
      payload: {
        userPlan: plan.userPlan,
        actionBundle: plan.actionBundle,
        codeBlocks: plan.codeBlocks,
        commandBlocks: plan.commandBlocks,
        expectedValidation: plan.expectedValidation,
        reviewGuide: plan.reviewGuide,
      },
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    };
  }

  aliases(plan: PlanContext): Set<string> {
    const aliases = new Set<string>([plan.planId]);
    if (plan.proposalId) aliases.add(plan.proposalId);
    const bundleId = stringValue(plan.actionBundle.id);
    if (bundleId) aliases.add(bundleId);
    const reportPlanId = stringValue(plan.planReviewReport?.planId);
    if (reportPlanId) aliases.add(reportPlanId);
    return aliases;
  }

  alreadyResolved(events: AgentEvent[], plan: PlanContext): boolean {
    const aliases = this.aliases(plan);
    return events.some((event, index) => {
      if (event.kind !== 'plan_review') return false;
      const payload = objectRecord(event.payload);
      if (!payload) return false;
      const status = stringValue(payload.status);
      if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
      const runId = stringValue(payload.runId);
      const planId = stringValue(payload.planId);
      if (runId !== plan.runId || (planId && !aliases.has(planId))) return false;
      if (status === 'rejected' || status === 'needsRevision') return true;
      return this.executionConsumed(events, plan, aliases, index);
    });
  }

  private executionConsumed(
    events: AgentEvent[],
    plan: PlanContext,
    aliases: Set<string>,
    acceptedIndex: number
  ): boolean {
    for (let index = acceptedIndex + 1; index < events.length; index += 1) {
      const event = events[index];
      const payload = objectRecord(event.payload) ?? {};
      const kernelEvent = objectRecord(payload.kernelEvent);
      const runId = stringValue(payload.runId) ?? stringValue(kernelEvent?.runId);
      if (runId && runId !== plan.runId) continue;
      const owner = objectRecord(payload.decisionOwner);
      const batch = objectRecord(kernelEvent?.batch);
      const planId = stringValue(payload.planId)
        ?? stringValue(owner?.planId)
        ?? stringValue(kernelEvent?.planId)
        ?? stringValue(batch?.planId);
      if (planId && !aliases.has(planId)) continue;

      if (event.kind === 'review_summary') return true;
      if (event.kind === 'permission_request') return true;
      if (event.kind === 'error') return true;

      if (event.kind === 'session_run_state') {
        const status = stringValue(payload.status);
        const reason = stringValue(payload.reason);
        if (status === 'failed' || status === 'cancelled' || status === 'completed') return true;
        if (reason === 'permission' || reason === 'review' || reason === 'work_unit_failed') return true;
        continue;
      }

      const stage = stringValue(payload.stage);
      if (stage === 'accepted_plan.action_batch_submit' || stage === 'accepted_plan.batch_failed') return true;

      const kernelKind = stringValue(kernelEvent?.kind) ?? stringValue(payload.kind);
      if (
        kernelKind === 'action_batch.accepted' ||
        kernelKind === 'permission.requested' ||
        kernelKind?.startsWith('work_unit.')
      ) {
        return true;
      }
    }
    return false;
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
