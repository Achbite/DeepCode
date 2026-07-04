import type {
  AgentEvent,
  AgentSessionResult,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type { KernelEventStatusIndex } from '../execution/kernelEventStatusIndex.js';
import type { PermissionPipeline } from '../pipelines/permissionPipeline.js';
import type { PlanContextIndex } from '../proposal/planContextIndex.js';
import type { ReviewProjectionSummaryPlan } from '../projection/reviewProjectionBuilder.js';
import type { SessionTurnPhase } from '../pipelines/interactionOverlayCodec.js';

export interface PermissionDecisionHandlerPorts<
  Plan extends ReviewProjectionSummaryPlan = ReviewProjectionSummaryPlan
> {
  now(): string;
  createId(prefix: string): string;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult>;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  permissionPipeline: PermissionPipeline;
  kernelStatus: KernelEventStatusIndex;
  planIndex: PlanContextIndex;
  reviewProjection: {
    summaryEvent(input: {
      sessionId: string;
      plan: Plan;
      kernelEvents: unknown[];
      ts: string;
      id: string;
    }): AgentEvent;
  };
  progressProjection: {
    traceEvent(input: {
      sessionId: string;
      kind: AgentEvent['kind'];
      summary: string;
      extra: Record<string, unknown>;
      ts: string;
      id: string;
    }): AgentEvent;
    sessionRunStateEvent(input: {
      sessionId: string;
      runId: string;
      phase: SessionTurnPhase;
      status?: 'waiting' | 'running' | 'completed' | 'cancelled' | 'failed';
      reason: 'permission' | 'review';
      decisionOwner: {
        kind: 'permission' | 'review';
        runId: string;
        targetId?: string;
        permissionId?: string;
        reviewId?: string;
        planId?: string;
      };
      ts: string;
      id: string;
    }): AgentEvent;
  };
}

export interface PermissionDecisionHandlerInput {
  sessionId: string;
  decision: 'accept' | 'reject' | 'revise';
  runId?: string;
  targetId?: string;
  existingEvents?: AgentEvent[];
}

export class PermissionDecisionHandler<
  Plan extends ReviewProjectionSummaryPlan = ReviewProjectionSummaryPlan
> {
  constructor(private readonly ports: PermissionDecisionHandlerPorts<Plan>) {}

  async resolve(input: PermissionDecisionHandlerInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const pending = this.ports.permissionPipeline.findPendingPermissionContext(events, input.targetId);
    if (!pending) {
      return this.ports.append(input.sessionId, [
        this.ports.progressProjection.traceEvent({
          sessionId: input.sessionId,
          kind: 'trace/permission_accept_noop',
          summary: 'Permission request is already resolved or expired; no duplicate action was taken.',
          ts: this.ports.now(),
          id: this.ports.createId('permission-noop'),
          extra: {
            messageKey: 'session.driver.permissionDecision.noop',
            messageArgs: {},
            runId: input.runId,
            permissionId: input.targetId,
            decision: input.decision,
          },
        }),
      ]);
    }

    const decisionReply = await this.ports.kernel({
      command: {
        kind: 'permissionResolve',
        requestId: this.ports.createId('permission-resolve'),
        permissionId: pending.id,
        decision: input.decision === 'accept' ? 'accept' : 'reject',
      },
    });
    let result = await this.ports.appendProjectedKernelEvents(input.sessionId, decisionReply);

    if (input.decision === 'reject') {
      const runId = pending.runId ?? input.runId ?? this.ports.kernelStatus.runId(decisionReply.events ?? []) ?? 'run-unknown';
      return (await this.ports.append(input.sessionId, [
        this.ports.progressProjection.sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'cancelled',
          status: 'cancelled',
          reason: 'permission',
          decisionOwner: {
            kind: 'permission',
            runId,
            targetId: pending.id,
            permissionId: pending.id,
            planId: pending.planId,
          },
          ts: this.ports.now(),
          id: this.ports.createId('session-run-cancelled-permission'),
        }),
      ])) ?? result;
    }

    if (!this.ports.kernelStatus.actionBatchReadyForReview(decisionReply.events ?? [])) {
      if (this.ports.kernelStatus.hasPermissionRequest(decisionReply.events ?? [])) {
        const runId = pending.runId ?? input.runId ?? this.ports.kernelStatus.runId(decisionReply.events ?? []) ?? 'run-unknown';
        const permissionId = this.ports.kernelStatus.permissionId(decisionReply.events ?? []);
        return (await this.ports.append(input.sessionId, [
          this.ports.progressProjection.sessionRunStateEvent({
            sessionId: input.sessionId,
            runId,
            phase: 'waiting_permission',
            reason: 'permission',
            decisionOwner: {
              kind: 'permission',
              runId,
              targetId: permissionId,
              permissionId,
              planId: pending.planId,
            },
            ts: this.ports.now(),
            id: this.ports.createId('session-run-waiting-permission'),
          }),
        ])) ?? result;
      }
      return result;
    }

    const runId = pending.runId ?? input.runId ?? this.ports.kernelStatus.runId(decisionReply.events ?? []);
    if (!runId) return result;
    const plan = this.ports.planIndex.findPlanCard(result.events, runId, pending.planId);
    if (!plan) return result;

    const factsReply = await this.ports.kernel({
      command: {
        kind: 'reviewFactsGet',
        requestId: this.ports.createId('review-facts-get'),
        runId,
        sessionId: input.sessionId,
      },
    });
    result = await this.ports.appendProjectedKernelEvents(input.sessionId, factsReply);

    const review = this.ports.reviewProjection.summaryEvent({
      sessionId: input.sessionId,
      plan: plan as unknown as Plan,
      kernelEvents: [...(decisionReply.events ?? []), ...(factsReply.events ?? [])],
      ts: this.ports.now(),
      id: this.ports.createId('review-summary'),
    });
    const reviewPayload = objectRecord(review.payload) ?? {};
    return (await this.ports.append(input.sessionId, [
      review,
      this.ports.progressProjection.sessionRunStateEvent({
        sessionId: input.sessionId,
        runId,
        phase: 'waiting_review',
        reason: 'review',
        decisionOwner: {
          kind: 'review',
          runId,
          targetId: stringValue(reviewPayload.reviewId) ?? runId,
          reviewId: stringValue(reviewPayload.reviewId) ?? runId,
          planId: plan.planId,
        },
        ts: this.ports.now(),
        id: this.ports.createId('session-run-waiting-review'),
      }),
    ])) ?? result;
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
