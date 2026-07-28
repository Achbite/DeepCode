import type {
  AgentEvent,
  AgentSessionResult,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type { InteractionOverlayContext, SessionTurnPhase } from '../pipelines/interactionOverlayCodec.js';
import type { ReviewProjectionSummaryPlan } from '../projection/reviewProjectionBuilder.js';
import type {
  ConversationPresentationLanguage,
  ProjectionLanguageBinding,
} from '../projection/conversationPresentationLanguage.js';

export interface AcceptedPlanReviewHandoffPlan extends ReviewProjectionSummaryPlan {
  interactionOverlay?: InteractionOverlayContext;
}

export interface AcceptedPlanReviewHandoffCoordinatorInput<
  Plan extends AcceptedPlanReviewHandoffPlan
> {
  now(): string;
  createId(prefix: string): string;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(
    sessionId: string,
    reply: KernelReply,
    language: ConversationPresentationLanguage
  ): Promise<AgentSessionResult | undefined>;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult | undefined>;
  assertKernelReplyOk(reply: KernelReply, code: string, fallback: string): void;
  acceptedPlanKernelEvents(
    events: AgentEvent[],
    runId: string,
    planId: string | undefined,
    currentKernelEvents: unknown[]
  ): unknown[];
  reviewProjection: {
    summaryEvent(input: {
      sessionId: string;
      plan: Plan;
      kernelEvents: unknown[];
      events?: AgentEvent[];
      presentationBinding: ProjectionLanguageBinding;
      ts: string;
      id: string;
    }): AgentEvent;
  };
  progressProjection: {
    sessionRunStateEvent(input: {
      sessionId: string;
      runId: string;
      phase: SessionTurnPhase;
      reason: 'review';
      decisionOwner: {
        kind: 'review';
        runId: string;
        targetId: string;
        reviewId: string;
        planId?: string;
      };
      interactionOverlay?: InteractionOverlayContext;
      ts: string;
      id: string;
    }): AgentEvent;
  };
}

export interface AcceptedPlanReviewHandoffRunInput<
  Plan extends AcceptedPlanReviewHandoffPlan
> {
  sessionId: string;
  runId: string;
  planId?: string;
  plan: Plan;
  result: AgentSessionResult;
  currentKernelEvents: unknown[];
  requestIdPrefix: string;
  presentationBinding: ProjectionLanguageBinding;
  interactionOverlay?: InteractionOverlayContext;
  assertFactsReplyOk?: {
    code: string;
    fallback: string;
  };
}

export class AcceptedPlanReviewHandoffCoordinator<
  Plan extends AcceptedPlanReviewHandoffPlan = AcceptedPlanReviewHandoffPlan
> {
  constructor(private readonly input: AcceptedPlanReviewHandoffCoordinatorInput<Plan>) {}

  async handoff(runInput: AcceptedPlanReviewHandoffRunInput<Plan>): Promise<AgentSessionResult> {
    const factsReply = await this.input.kernel({
      command: {
        kind: 'reviewFactsGet',
        requestId: this.input.createId(runInput.requestIdPrefix),
        runId: runInput.runId,
        sessionId: runInput.sessionId,
      },
    });
    if (runInput.assertFactsReplyOk) {
      this.input.assertKernelReplyOk(
        factsReply,
        runInput.assertFactsReplyOk.code,
        runInput.assertFactsReplyOk.fallback
      );
    }
    const result = await this.input.appendProjectedKernelEvents(
      runInput.sessionId,
      factsReply,
      runInput.presentationBinding.language
    ) ?? runInput.result;
    const reviewKernelEvents = this.input.acceptedPlanKernelEvents(
      result.events,
      runInput.runId,
      runInput.planId,
      [...runInput.currentKernelEvents, ...(factsReply.events ?? [])]
    );
    const review = this.input.reviewProjection.summaryEvent({
      sessionId: runInput.sessionId,
      plan: runInput.plan,
      kernelEvents: reviewKernelEvents,
      events: result.events,
      presentationBinding: runInput.presentationBinding,
      ts: this.input.now(),
      id: this.input.createId('review-summary'),
    });
    const reviewPayload = objectRecord(review.payload) ?? {};
    const reviewId = stringValue(reviewPayload.reviewId) ?? runInput.runId;
    return (await this.input.append(runInput.sessionId, [
      review,
      this.input.progressProjection.sessionRunStateEvent({
        sessionId: runInput.sessionId,
        runId: runInput.runId,
        phase: 'waiting_review',
        reason: 'review',
        decisionOwner: {
          kind: 'review',
          runId: runInput.runId,
          targetId: reviewId,
          reviewId,
          planId: runInput.planId,
        },
        interactionOverlay: runInput.interactionOverlay,
        ts: this.input.now(),
        id: this.input.createId('session-run-waiting-review'),
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
