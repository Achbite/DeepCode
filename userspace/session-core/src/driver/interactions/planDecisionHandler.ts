import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
} from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../../context/index.js';
import type { ProjectWorkingDirectory } from '../../context/types.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedImplementationPlanExecutionRoot,
} from '../execution/index.js';
import type { InteractionOverlayContext, SessionTurnPhase } from '../pipelines/interactionOverlayCodec.js';
import type { PlanContext, PlanContextIndex } from '../proposal/planContextIndex.js';
import type { PlanProjectionBuilder } from '../projection/planProjectionBuilder.js';
import type { InterventionLevel, ReviewContinuationMode } from '../types.js';
import { decisionContinuationInput } from '../runContinuation.js';

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
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: PlanDecisionHandlerContinuationMode;
  interventionLevel?: PlanDecisionHandlerInterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
}

export interface PlanDecisionResumeInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  appendUserMessage: false;
  requirementConfirmationMode: 'off';
  reviewContinuationMode?: PlanDecisionHandlerContinuationMode;
  interventionLevel?: PlanDecisionHandlerInterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export interface RecoveredAcceptedPlanContext {
  plan: PlanContext;
  acceptedPlan: AcceptedImplementationPlanContext;
}

export type DriverInteractionRef =
  | { kind: 'review'; runId: string }
  | { kind: 'plan'; runId: string; planId: string }
  | { kind: 'requirement'; runId: string; requirementId: string };

export interface PlanDecisionHandlerPorts {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  resumeUserTurn(input: PlanDecisionResumeInput): Promise<AgentSessionResult>;
  executeAcceptedActionBundlePlan(
    input: PlanDecisionHandlerInput,
    plan: PlanContext,
    initialResult: AgentSessionResult,
    acceptedOverlay?: RecoveredAcceptedPlanContext
  ): Promise<AgentSessionResult>;
  activeDriverInteraction(events: AgentEvent[]): DriverInteractionRef | null;
  executionRootFromDecision(input: PlanDecisionHandlerInput, events: AgentEvent[]): AcceptedImplementationPlanExecutionRoot | undefined;
  buildAcceptedImplementationPlan(input: {
    plan: PlanContext;
    interventionLevel?: PlanDecisionHandlerInterventionLevel;
    executionRoot?: AcceptedImplementationPlanExecutionRoot;
  }): AcceptedImplementationPlanContext;
  recoverAcceptedPlanFromOverlay(
    input: PlanDecisionHandlerInput,
    events: AgentEvent[],
    overlay: InteractionOverlayContext | undefined
  ): RecoveredAcceptedPlanContext | undefined;
  planRevisionRequest(input: { plan: PlanContext; guidance?: string }): string;
  executionRequest(plan: PlanContext, acceptedPlan: AcceptedImplementationPlanContext, guidance?: string): string;
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

  async resolve(input: PlanDecisionHandlerInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    if (!this.activePlanMatches(input, events)) {
      return this.appendNoop(input);
    }

    const plan = this.ports.planIndex.findPlanCard(events, input.runId, input.targetId);
    if (!plan || this.ports.planIndex.alreadyResolved(events, plan)) {
      return this.appendNoop(input);
    }

    if (input.decision !== 'accept') {
      return this.resolveNonAccept(input, plan);
    }

    let result = await this.ports.append(input.sessionId, [
      this.ports.planProjection.planReviewDecisionEvent({
        sessionId: input.sessionId,
        plan,
        status: 'accepted',
        ts: this.ports.now(),
        id: this.ports.createId('plan-accepted'),
      }),
    ]);
    if (plan.implementationPlan) {
      const executionRoot = plan.executionRoot ?? this.ports.executionRootFromDecision(input, result.events);
      const acceptedPlan = this.ports.buildAcceptedImplementationPlan({
        plan,
        interventionLevel: input.interventionLevel,
        executionRoot,
      });
      return this.ports.resumeUserTurn(decisionContinuationInput(input, {
        content: this.ports.executionRequest(plan, acceptedPlan, input.guidance),
        attachments: acceptedPlan.executionRoot ? [acceptedPlan.executionRoot.attachment] : [],
        existingEvents: result.events,
        reviewContinuationMode: input.reviewContinuationMode,
        resumeResourcePackets: true,
        acceptedImplementationPlan: acceptedPlan,
        interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
      }));
    }
    const acceptedOverlay = this.ports.recoverAcceptedPlanFromOverlay(input, result.events, plan.interactionOverlay ?? input.interactionOverlay);
    return this.ports.executeAcceptedActionBundlePlan(input, plan, result, acceptedOverlay);
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
  ): Promise<AgentSessionResult> {
    const status = input.decision === 'revise' ? 'needsRevision' : 'rejected';
    let result = await this.ports.append(input.sessionId, [
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
      return this.ports.resumeUserTurn(decisionContinuationInput(input, {
        content: this.ports.planRevisionRequest({ plan, guidance: input.guidance }),
        attachments: [],
        existingEvents: result.events,
        reviewContinuationMode: input.reviewContinuationMode,
        interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
      }));
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
    return result;
  }
}
