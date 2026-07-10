import type {
  AgentEvent,
  AgentSessionResult,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type {
  KernelEventStatusIndex,
  KernelReplyObservation,
} from '../execution/kernelEventStatusIndex.js';
import type { PermissionPipeline } from '../pipelines/permissionPipeline.js';
import type { PlanContextIndex } from '../proposal/planContextIndex.js';
import type { ReviewProjectionSummaryPlan } from '../projection/reviewProjectionBuilder.js';
import type { SessionTurnPhase } from '../pipelines/interactionOverlayCodec.js';
import { returnSessionResult, type SessionLoopControlResult } from '../runContinuation.js';

export interface PermissionDecisionHandlerPorts<
  Plan extends ReviewProjectionSummaryPlan = ReviewProjectionSummaryPlan
> {
  now(): string;
  createId(prefix: string): string;
  observeKernel(request: KernelCommandEnvelope): Promise<KernelReplyObservation>;
  appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult>;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  permissionPipeline: PermissionPipeline;
  kernelStatus: KernelEventStatusIndex;
  planIndex: PlanContextIndex;
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

  async resolve(input: PermissionDecisionHandlerInput): Promise<SessionLoopControlResult> {
    const events = input.existingEvents ?? [];
    const pending = this.ports.permissionPipeline.findPendingPermissionContext(events, input.targetId);
    if (!pending) {
      return returnSessionResult(await this.ports.append(input.sessionId, [
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
      ]));
    }

    const observed = await this.ports.observeKernel({
      command: {
        kind: 'permissionResolve',
        requestId: this.ports.createId('permission-resolve'),
        permissionId: pending.id,
        decision: input.decision === 'accept' ? 'accept' : 'reject',
      },
    });
    const decisionReply = observed.reply;
    let result = await this.ports.appendProjectedKernelEvents(input.sessionId, decisionReply);
    if (observed.kind === 'commandFailed') {
      return returnSessionResult(await this.ports.append(input.sessionId, [
        this.ports.progressProjection.traceEvent({
          sessionId: input.sessionId,
          kind: 'trace/permission_accept_noop',
          summary: 'Kernel could not resume the interrupted command after the permission decision.',
          ts: this.ports.now(),
          id: this.ports.createId('permission-resume-failed'),
          extra: {
            messageKey: 'session.driver.permissionDecision.resumeFailed',
            messageArgs: {},
            runId: pending.runId ?? input.runId,
            permissionId: pending.id,
            errorCode: observed.code,
            errorMessage: observed.message,
          },
        }),
      ]));
    }

    if (input.decision === 'reject') {
      const runId = pending.runId ?? input.runId ?? this.ports.kernelStatus.runId(decisionReply.events ?? []) ?? 'run-unknown';
      return returnSessionResult((await this.ports.append(input.sessionId, [
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
      ])) ?? result);
    }

    if (observed.kind === 'permissionInterrupted') {
        const runId = pending.runId ?? input.runId ?? this.ports.kernelStatus.runId(decisionReply.events ?? []) ?? 'run-unknown';
        const permissionId = observed.permissionId;
        return returnSessionResult((await this.ports.append(input.sessionId, [
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
        ])) ?? result);
    }
    if (observed.kind !== 'factsObserved' || !observed.readyForReview) {
      return returnSessionResult(result);
    }

    const runId = pending.runId ?? input.runId ?? this.ports.kernelStatus.runId(decisionReply.events ?? []);
    if (!runId) return returnSessionResult(result);
    const plan = this.ports.planIndex.findPlanCard(result.events, runId, pending.planId);
    if (!plan) return returnSessionResult(result);

    return {
      kind: 'assembleReview',
      request: {
        sessionId: input.sessionId,
        runId,
        planId: plan.planId,
        plan: plan as unknown as Plan,
        result,
        currentKernelEvents: decisionReply.events ?? [],
        requestIdPrefix: 'permission-review-facts-get',
      },
    };
  }
}
