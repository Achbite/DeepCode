import type {
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../../context/index.js';
import type { ProjectWorkingDirectory } from '../../context/types.js';
import type {
  AcceptedTaskPlanContext,
  AcceptedTaskPlanExecutionRoot,
} from '../execution/index.js';
import type { InteractionOverlayContext, SessionTurnPhase } from '../pipelines/interactionOverlayCodec.js';
import type { PlanContext, PlanContextIndex } from '../proposal/planContextIndex.js';
import type { PlanProjectionBuilder } from '../projection/planProjectionBuilder.js';
import type { AutonomyMode, InterventionLevel, ReviewContinuationMode } from '../types.js';
import {
  decisionContinuationInput,
  returnSessionResult,
  type SessionLoopControlResult,
} from '../runContinuation.js';

export type PlanDecisionHandlerDecision = 'accept' | 'reject' | 'revise';
export type PlanDecisionHandlerContinuationMode = ReviewContinuationMode;
export type PlanDecisionHandlerInterventionLevel = InterventionLevel;

export interface PlanDecisionHandlerInput {
  sessionId: string;
  decision: PlanDecisionHandlerDecision;
  guidance?: string;
  runId?: string;
  targetId?: string;
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  projectId?: string;
  projectKind?: 'folder' | 'blank';
  projectRootStatus?: 'ready' | 'unbound' | 'unavailable';
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: PlanDecisionHandlerContinuationMode;
  interventionLevel?: PlanDecisionHandlerInterventionLevel;
  autonomyMode?: AutonomyMode;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
}

export interface RecoveredAcceptedPlanContext {
  plan: PlanContext;
  acceptedPlan: AcceptedTaskPlanContext;
}

export type DriverInteractionRef =
  | { kind: 'review'; runId: string }
  | { kind: 'plan'; runId: string; planId: string }
  | { kind: 'requirement'; runId: string; requirementId: string };

export interface PlanDecisionRunCommand {
  readonly kind: 'resolvePlanDecision';
  readonly input: PlanDecisionHandlerInput;
}

export type PlanDecisionRunEffect =
  | { readonly kind: 'planDecisionNoop'; readonly control: SessionLoopControlResult }
  | { readonly kind: 'planAcceptedForImplementation'; readonly control: SessionLoopControlResult }
  | { readonly kind: 'planAcceptedForActionBundle'; readonly control: SessionLoopControlResult }
  | { readonly kind: 'planRevisionRequested'; readonly control: SessionLoopControlResult }
  | { readonly kind: 'planRejected'; readonly control: SessionLoopControlResult };

export interface PlanDecisionHandlerPorts {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult | undefined>;
  diagnosticEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent;
  executeAcceptedActionBundlePlan(
    input: PlanDecisionHandlerInput,
    plan: PlanContext,
    initialResult: AgentSessionResult,
    acceptedOverlay?: RecoveredAcceptedPlanContext
  ): Promise<SessionLoopControlResult>;
  activeDriverInteraction(events: AgentEvent[]): DriverInteractionRef | null;
  executionRootFromDecision(input: PlanDecisionHandlerInput, events: AgentEvent[]): AcceptedTaskPlanExecutionRoot | undefined;
  buildAcceptedTaskPlan(input: {
    plan: PlanContext;
    interventionLevel?: PlanDecisionHandlerInterventionLevel;
    executionRoot?: AcceptedTaskPlanExecutionRoot;
  }): AcceptedTaskPlanContext;
  recoverAcceptedPlanFromOverlay(
    input: PlanDecisionHandlerInput,
    events: AgentEvent[],
    overlay: InteractionOverlayContext | undefined
  ): RecoveredAcceptedPlanContext | undefined;
  planRevisionRequest(input: { plan: PlanContext; guidance?: string }): string;
  executionRequest(plan: PlanContext, acceptedPlan: AcceptedTaskPlanContext, guidance?: string): string;
  planIndex: PlanContextIndex;
  planProjection: PlanProjectionBuilder;
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
      reason: 'plan_review';
      decisionOwner: {
        kind: 'plan';
        runId: string;
        targetId?: string;
        planId?: string;
      };
      interactionOverlay?: InteractionOverlayContext;
      ts: string;
      id: string;
    }): AgentEvent;
  };
}

export class PlanDecisionHandler {
  constructor(private readonly ports: PlanDecisionHandlerPorts) {}

  async resolve(input: PlanDecisionHandlerInput): Promise<SessionLoopControlResult> {
    const effect = await this.execute({ kind: 'resolvePlanDecision', input });
    return effect.control;
  }

  private async execute(command: PlanDecisionRunCommand): Promise<PlanDecisionRunEffect> {
    const input = command.input;
    const events = input.existingEvents ?? [];
    if (!this.activePlanMatches(input, events)) {
      return { kind: 'planDecisionNoop', control: returnSessionResult(await this.appendNoop(input)) };
    }

    const plan = this.ports.planIndex.findPlanCard(events, input.runId, input.targetId);
    if (!plan || this.ports.planIndex.alreadyResolved(events, plan)) {
      return { kind: 'planDecisionNoop', control: returnSessionResult(await this.appendNoop(input)) };
    }

    if (input.decision !== 'accept') {
      return this.resolveNonAccept(input, plan);
    }

    return this.acceptPlan(input, plan);
  }

  private async acceptPlan(
    input: PlanDecisionHandlerInput,
    plan: PlanContext
  ): Promise<PlanDecisionRunEffect> {
    let result: AgentSessionResult | undefined;
    if (plan.taskPlan) {
      result = await this.recordPlanAuthorizationDecision(input, plan, 'accept');
      if (!result) {
        return {
          kind: 'planDecisionNoop',
          control: returnSessionResult(await this.appendAuthorizationFailure(input, plan)),
        };
      }
    }
    result = await this.ports.append(input.sessionId, [
      this.ports.planProjection.planReviewDecisionEvent({
        sessionId: input.sessionId,
        plan,
        status: 'accepted',
        ts: this.ports.now(),
        id: this.ports.createId('plan-accepted'),
      }),
    ]);
    if (plan.taskPlan) {
      const executionRoot = plan.executionRoot ?? this.ports.executionRootFromDecision(input, result.events);
      const acceptedPlan = this.ports.buildAcceptedTaskPlan({
        plan,
        interventionLevel: input.interventionLevel,
        executionRoot,
      });
      return {
        kind: 'planAcceptedForImplementation',
        control: {
          kind: 'resume',
          input: decisionContinuationInput(input, {
            content: this.ports.executionRequest(plan, acceptedPlan, input.guidance),
            attachments: acceptedPlan.executionRoot ? [acceptedPlan.executionRoot.attachment] : [],
            existingEvents: result.events,
            reviewContinuationMode: input.reviewContinuationMode,
            resumeResourcePackets: true,
            acceptedTaskPlan: acceptedPlan,
            interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          }),
        },
      };
    }
    const acceptedOverlay = this.ports.recoverAcceptedPlanFromOverlay(input, result.events, plan.interactionOverlay ?? input.interactionOverlay);
    const control = await this.ports.executeAcceptedActionBundlePlan(input, plan, result, acceptedOverlay);
    return { kind: 'planAcceptedForActionBundle', control };
  }

  private activePlanMatches(input: PlanDecisionHandlerInput, events: AgentEvent[]): boolean {
    const active = this.ports.activeDriverInteraction(events);
    return active?.kind === 'plan' &&
      active.runId === input.runId &&
      (!input.targetId ||
        active.planId === input.targetId ||
        Boolean(this.ports.planIndex.findPlanCard(events, input.runId, input.targetId)));
  }

  private appendNoop(input: PlanDecisionHandlerInput): Promise<AgentSessionResult> {
    return this.ports.append(input.sessionId, [
      this.ports.progressProjection.traceEvent({
        sessionId: input.sessionId,
        kind: 'trace/plan_accept_noop',
        summary: 'Plan review request is already resolved or expired; no duplicate action was taken.',
        ts: this.ports.now(),
        id: this.ports.createId('plan-noop'),
        extra: {
          messageKey: 'session.driver.planDecision.noop',
          messageArgs: {},
          runId: input.runId,
          planId: input.targetId,
          decision: input.decision,
          visibility: 'debug',
        },
      }),
    ]);
  }

  private async resolveNonAccept(
    input: PlanDecisionHandlerInput,
    plan: PlanContext
  ): Promise<PlanDecisionRunEffect> {
    const status = input.decision === 'revise' ? 'needsRevision' : 'rejected';
    let result: AgentSessionResult | undefined;
    if (plan.taskPlan) {
      result = await this.recordPlanAuthorizationDecision(input, plan, 'reject');
      if (!result) {
        return {
          kind: 'planDecisionNoop',
          control: returnSessionResult(await this.appendAuthorizationFailure(input, plan)),
        };
      }
    }
    result = await this.ports.append(input.sessionId, [
      this.ports.planProjection.planReviewDecisionEvent({
        sessionId: input.sessionId,
        plan,
        status,
        summary: input.guidance,
        ts: this.ports.now(),
        id: this.ports.createId('plan-decision'),
      }),
    ]);
    if (input.decision === 'revise') {
      return {
        kind: 'planRevisionRequested',
        control: {
          kind: 'resume',
          input: decisionContinuationInput(input, {
            content: this.ports.planRevisionRequest({ plan, guidance: input.guidance }),
            attachments: [],
            existingEvents: result.events,
            reviewContinuationMode: input.reviewContinuationMode,
            interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          }),
        },
      };
    }

    if (input.decision === 'reject') {
      result = await this.ports.append(input.sessionId, [
        this.ports.progressProjection.sessionRunStateEvent({
          sessionId: input.sessionId,
          runId: plan.runId,
          phase: 'cancelled',
          status: 'cancelled',
          reason: 'plan_review',
          decisionOwner: {
            kind: 'plan',
            runId: plan.runId,
            targetId: plan.planId,
            planId: plan.planId,
          },
          interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          ts: this.ports.now(),
          id: this.ports.createId('session-run-cancelled-plan'),
        }),
      ]) ?? result;
    }
    return { kind: 'planRejected', control: returnSessionResult(result) };
  }

  private async recordPlanAuthorizationDecision(
    input: PlanDecisionHandlerInput,
    plan: PlanContext,
    decision: 'accept' | 'reject'
  ): Promise<AgentSessionResult | undefined> {
    if (!plan.authorizationContractId || !plan.authorizationContractHash || !plan.planHash) {
      return undefined;
    }
    const reply = await this.ports.kernel({
      command: {
        kind: 'planAuthorizationDecisionSubmit',
        requestId: this.ports.createId('plan-authorization-decision'),
        runId: plan.runId,
        sessionId: input.sessionId,
        decision: {
          decisionId: this.ports.createId('plan-authorization-user-decision'),
          authorizationContractId: plan.authorizationContractId,
          planId: plan.planId,
          planHash: plan.planHash,
          contractHash: plan.authorizationContractHash,
          decision,
        },
      },
    });
    const result = await this.ports.appendProjectedKernelEvents(input.sessionId, reply);
    return reply.ok ? result : undefined;
  }

  private appendAuthorizationFailure(
    input: PlanDecisionHandlerInput,
    plan: PlanContext
  ): Promise<AgentSessionResult> {
    return this.ports.append(input.sessionId, [
      this.ports.diagnosticEvent(
        input.sessionId,
        'Kernel plan authorization decision failed or the plan authorization contract is unavailable; execution was not started.',
        this.ports.now(),
        this.ports.createId('plan-authorization-decision-failed')
      ),
    ]);
  }
}
