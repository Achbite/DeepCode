import type {
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  ConversationLanguage,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../../context/index.js';
import type { ProjectWorkingDirectory } from '../../context/types.js';
import type { KernelEventStatusIndex } from '../execution/kernelEventStatusIndex.js';
import type { SessionTurnPhase } from '../pipelines/interactionOverlayCodec.js';
import type { ReviewAssembler } from '../review/reviewAssembler.js';
import type { ReviewDecisionProjectionBuilder } from '../review/reviewDecisionProjection.js';
import {
  conversationPresentationLanguageBindingFromEvents,
  conversationPresentationLanguageFromEvents,
  localizedProjectionText,
  type ConversationPresentationLanguage,
} from '../projection/conversationPresentationLanguage.js';
import {
  decisionContinuationInput,
  returnSessionResult,
  type SessionLoopControlResult,
} from '../runContinuation.js';
import type { AutonomyMode, InterventionLevel, ReviewContinuationMode } from '../types.js';

export type ReviewDecisionHandlerDecision = 'accept' | 'reject' | 'revise';
export type ReviewDecisionHandlerContinuationMode = ReviewContinuationMode;
export type ReviewDecisionHandlerInterventionLevel = InterventionLevel;

export interface ReviewDecisionHandlerInput {
  sessionId: string;
  hostRunId?: string;
  decision: ReviewDecisionHandlerDecision;
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
  reviewContinuationMode?: ReviewDecisionHandlerContinuationMode;
  interventionLevel?: ReviewDecisionHandlerInterventionLevel;
  autonomyMode?: AutonomyMode;
  projectMemoryMode?: ProjectMemoryMode;
  hostLanguage?: ConversationLanguage;
}

export interface ReviewDecisionRunCommand {
  readonly kind: 'resolveReviewDecision';
  readonly input: ReviewDecisionHandlerInput;
}

export type ReviewDecisionRunEffect =
  | { readonly kind: 'reviewDecisionNoop'; readonly control: SessionLoopControlResult }
  | { readonly kind: 'reviewRejected'; readonly control: SessionLoopControlResult }
  | { readonly kind: 'reviewRevisionRequested'; readonly control: SessionLoopControlResult }
  | { readonly kind: 'reviewAccepted'; readonly control: SessionLoopControlResult }
  | { readonly kind: 'reviewContinuationChoiceRequired'; readonly control: SessionLoopControlResult }
  | { readonly kind: 'reviewContinuationStarted'; readonly control: SessionLoopControlResult };

export interface ReviewDecisionHandlerPorts {
  now(): string;
  createId(prefix: string): string;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(
    sessionId: string,
    reply: KernelReply,
    language: ConversationPresentationLanguage
  ): Promise<AgentSessionResult>;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  reviewAssembler: ReviewAssembler;
  reviewDecisionProjection: ReviewDecisionProjectionBuilder;
  kernelStatus: KernelEventStatusIndex;
  progressProjection: {
    traceEvent(input: {
      sessionId: string;
      kind: AgentEvent['kind'];
      summary: string;
      extra: Record<string, unknown>;
      language?: ConversationPresentationLanguage;
      ts: string;
      id: string;
    }): AgentEvent;
    sessionRunStateEvent(input: {
      sessionId: string;
      runId: string;
      phase: SessionTurnPhase;
      status?: 'waiting' | 'running' | 'completed' | 'cancelled' | 'failed';
      reason: 'review';
      decisionOwner: {
        kind: 'review';
        runId: string;
        targetId?: string;
        reviewId?: string;
        planId?: string;
      };
      ts: string;
      id: string;
    }): AgentEvent;
  };
}

export class ReviewDecisionHandler {
  constructor(private readonly ports: ReviewDecisionHandlerPorts) {}

  async resolve(input: ReviewDecisionHandlerInput): Promise<SessionLoopControlResult> {
    const effect = await this.execute({ kind: 'resolveReviewDecision', input });
    return effect.control;
  }

  private async execute(command: ReviewDecisionRunCommand): Promise<ReviewDecisionRunEffect> {
    const input = command.input;
    const events = input.existingEvents ?? [];
    const activeReview = this.ports.reviewAssembler.findLatestActiveReviewInteraction(events);
    const admittedReviewId = input.targetId
      ?? (
        input.runId
        && activeReview?.runId === input.runId
          ? activeReview.reviewId
          : undefined
      );
    const review = this.ports.reviewAssembler.findWaitingReview(
      events,
      input.runId,
      activeReview,
      admittedReviewId
    );
    if (!review || this.ports.reviewAssembler.reviewAlreadyResolved(events, review)) {
      return { kind: 'reviewDecisionNoop', control: returnSessionResult(await this.appendNoop(input)) };
    }

    if (input.decision === 'reject') {
      return this.reject(input, review);
    }
    if (input.decision !== 'accept') {
      return this.revise(input, review);
    }
    return this.accept(input, events, review);
  }

  private appendNoop(input: ReviewDecisionHandlerInput): Promise<AgentSessionResult> {
    const binding = conversationPresentationLanguageBindingFromEvents(
      input.existingEvents ?? [],
      input.runId
    );
    return this.ports.append(input.sessionId, [
      this.ports.progressProjection.traceEvent({
        sessionId: input.sessionId,
        kind: 'trace/review_accept_noop',
        summary: localizedProjectionText(binding.language, {
          zh: '复核请求已解决或过期，未重复执行。',
          en: 'Review request is already resolved or expired; no duplicate action was taken.',
          neutral: 'review_decision=noop',
        }),
        language: binding.language,
        ts: this.ports.now(),
        id: this.ports.createId('review-noop'),
        extra: {
          messageKey: 'session.driver.reviewDecision.noop',
          messageArgs: {},
          runId: input.runId,
          decision: input.decision,
        },
      }),
    ]);
  }

  private async reject(
    input: ReviewDecisionHandlerInput,
    review: NonNullable<ReturnType<ReviewAssembler['findWaitingReview']>>
  ): Promise<ReviewDecisionRunEffect> {
    const presentationBinding = conversationPresentationLanguageBindingFromEvents(
      input.existingEvents ?? [],
      review.runId
    );
    const gate = await this.appendTerminalReviewGate(
      input,
      this.reviewGateRequest(input, review, 'reject'),
      review.runId
    );
    if (gate.status === 'unavailable') {
      return {
        kind: 'reviewDecisionNoop',
        control: returnSessionResult(gate.result),
      };
    }
    let result = await this.ports.append(input.sessionId, [
      this.ports.reviewDecisionProjection.event({
        sessionId: input.sessionId,
        review,
        status: 'rejected',
        content: input.guidance,
        presentationBinding,
        continuationRequested: false,
        ts: this.ports.now(),
        id: this.ports.createId('review-rejected'),
      }),
    ]);
    result = await this.ports.append(input.sessionId, [
      this.reviewRunStateEvent(input.sessionId, review, 'cancelled', 'cancelled', 'session-run-cancelled-review'),
    ]) ?? result;
    return { kind: 'reviewRejected', control: returnSessionResult(result) };
  }

  private async revise(
    input: ReviewDecisionHandlerInput,
    review: NonNullable<ReturnType<ReviewAssembler['findWaitingReview']>>
  ): Promise<ReviewDecisionRunEffect> {
    const presentationBinding = conversationPresentationLanguageBindingFromEvents(
      input.existingEvents ?? [],
      review.runId
    );
    const gate = await this.appendTerminalReviewGate(
      input,
      this.reviewGateRequest(input, review, 'revise'),
      review.runId
    );
    if (gate.status === 'unavailable') {
      return {
        kind: 'reviewDecisionNoop',
        control: returnSessionResult(gate.result),
      };
    }
    const result = await this.ports.append(input.sessionId, [
      this.ports.reviewDecisionProjection.event({
        sessionId: input.sessionId,
        review,
        status: 'needsRevision',
        content: input.guidance,
        presentationBinding,
        continuationRequested: false,
        ts: this.ports.now(),
        id: this.ports.createId('review-revise'),
      }),
    ]);
    return {
      kind: 'reviewRevisionRequested',
      control: {
        kind: 'resume',
        input: decisionContinuationInput(input, {
          content: this.ports.reviewAssembler.revisionRequest(review, input.guidance),
          attachments: [],
          existingEvents: result.events,
        }),
      },
    };
  }

  private async accept(
    input: ReviewDecisionHandlerInput,
    events: AgentEvent[],
    review: NonNullable<ReturnType<ReviewAssembler['findWaitingReview']>>
  ): Promise<ReviewDecisionRunEffect> {
    const presentationBinding = conversationPresentationLanguageBindingFromEvents(
      input.existingEvents ?? [],
      review.runId
    );
    const terminalAcceptedPlan = this.ports.reviewAssembler.isTerminalAcceptedPlan(events, review);
    const continuationMode = input.reviewContinuationMode ?? 'auto';
    const closesCurrentReview = terminalAcceptedPlan || !review.continuations.length || continuationMode === 'off';
    const accepted = this.ports.reviewDecisionProjection.event({
      sessionId: input.sessionId,
      review,
      status: 'accepted',
      continuationRequested: false,
      terminalAcceptedPlan,
      presentationBinding,
      ts: this.ports.now(),
      id: this.ports.createId('review-accepted'),
    });
    const gateRequest = this.reviewGateRequest(input, review, 'accept');
    const gate = await this.appendTerminalReviewGate(input, gateRequest, review.runId);
    if (gate.status === 'unavailable') {
      return {
        kind: 'reviewDecisionNoop',
        control: returnSessionResult(gate.result),
      };
    }
    if (gate.status === 'needsReplan') {
      const result = await this.ports.append(input.sessionId, [
        this.ports.reviewDecisionProjection.event({
          sessionId: input.sessionId,
          review,
          status: 'needsRevision',
          content: input.guidance,
          presentationBinding,
          continuationRequested: false,
          ts: this.ports.now(),
          id: this.ports.createId('review-accept-needs-replan'),
        }),
      ]);
      return {
        kind: 'reviewRevisionRequested',
        control: {
          kind: 'resume',
          input: decisionContinuationInput(input, {
            content: this.ports.reviewAssembler.revisionRequest(review, input.guidance),
            attachments: [],
            existingEvents: result.events,
          }),
        },
      };
    }
    let result = await this.ports.append(input.sessionId, [accepted]);

    if (closesCurrentReview) {
      if (gate.status === 'accepted') {
        result = await this.ports.append(input.sessionId, [
          this.reviewRunStateEvent(input.sessionId, review, 'completed', 'completed', 'session-run-completed-review'),
        ]) ?? result;
      }
      return { kind: 'reviewAccepted', control: returnSessionResult(result) };
    }

    if (continuationMode === 'ask') {
      result = await this.ports.append(input.sessionId, [
        this.ports.reviewDecisionProjection.continuationPromptEvent({
          sessionId: input.sessionId,
          review,
          continuations: this.ports.reviewAssembler.continuationSummaries(review),
          presentationBinding,
          ts: this.ports.now(),
          id: this.ports.createId('review-continuation-choice'),
        }),
      ]) ?? result;
      return { kind: 'reviewContinuationChoiceRequired', control: returnSessionResult(result) };
    }
    return {
      kind: 'reviewContinuationStarted',
      control: {
        kind: 'resume',
        input: decisionContinuationInput(input, {
          content: this.ports.reviewAssembler.continuationRequest(review),
          attachments: [],
          existingEvents: result.events,
          reviewContinuationMode: continuationMode,
        }),
      },
    };
  }

  private async appendTerminalReviewGate(
    input: ReviewDecisionHandlerInput,
    request: KernelCommandEnvelope,
    effectiveRunId: string
  ): Promise<{ result: AgentSessionResult; status: 'accepted' | 'needsReplan' | 'aborted' | 'unavailable' }> {
    try {
      const reply = await this.ports.kernel(request);
      const result = await this.ports.appendProjectedKernelEvents(
        input.sessionId,
        reply,
        conversationPresentationLanguageFromEvents(input.existingEvents ?? [], effectiveRunId)
      );
      if (!reply.ok) {
        return {
          result: await this.appendTerminalKernelNoop(
            input,
            'reviewGateUnavailable',
            'Kernel rejected ReviewGate evaluation; Session keeps the run open and does not infer a terminal result.',
            reply.error?.code,
            effectiveRunId
          ),
          status: 'unavailable',
        };
      }
      const evaluation = this.ports.kernelStatus.reviewGateEvaluation(reply.events);
      const status = normalizeReviewGateStatus(evaluation?.result.status);
      if (status === 'unavailable') {
        return {
          result: await this.appendTerminalKernelNoop(
            input,
            'reviewGateResultUnavailable',
            'Kernel returned no typed ReviewGate result; Session keeps the run open and does not infer a terminal result.',
            'kernel_review_gate_result_unavailable',
            effectiveRunId
          ),
          status,
        };
      }
      const expectedRequestId = request.command.requestId;
      if (
        evaluation?.requestId !== expectedRequestId
        || evaluation.runId !== effectiveRunId
        || evaluation.result.runId !== effectiveRunId
        || evaluation.result.decision.decision !== input.decision
        || !reviewGateStatusMatchesDecision(status, input.decision)
      ) {
        return {
          result: await this.appendTerminalKernelNoop(
            input,
            'reviewGateResultMismatch',
            'Kernel returned a ReviewGate result that does not match the active run and user decision; Session keeps the review open.',
            'kernel_review_gate_result_mismatch',
            effectiveRunId
          ),
          status: 'unavailable',
        };
      }
      return {
        result,
        status,
      };
    } catch (error) {
      return {
        result: await this.appendTerminalKernelNoop(
          input,
          'reviewGateUnavailable',
          'Kernel did not accept ReviewGate evaluation; Session keeps the run open and does not infer a terminal result.',
          structuredErrorCode(error),
          effectiveRunId
        ),
        status: 'unavailable',
      };
    }
  }

  private appendTerminalKernelNoop(
    input: ReviewDecisionHandlerInput,
    messageKey: string,
    summary: string,
    errorCode?: string,
    effectiveRunId?: string
  ): Promise<AgentSessionResult> {
    const binding = conversationPresentationLanguageBindingFromEvents(
      input.existingEvents ?? [],
      effectiveRunId ?? input.runId
    );
    return this.ports.append(input.sessionId, [
      this.ports.progressProjection.traceEvent({
        sessionId: input.sessionId,
        kind: 'trace/review_accept_noop',
        summary: localizedProjectionText(binding.language, {
          zh: 'Kernel 未能提供有效的 ReviewGate 结果；Session 保持运行开启且不推断终态。',
          en: summary,
          neutral: `review_gate=${messageKey}`,
        }),
        language: binding.language,
        ts: this.ports.now(),
        id: this.ports.createId('kernel-audit-noop'),
        extra: {
          messageKey: `session.driver.${messageKey}`,
          messageArgs: {},
          runId: effectiveRunId ?? input.runId,
          decision: input.decision,
          errorCode,
        },
      }),
    ]);
  }

  private reviewGateRequest(
    input: ReviewDecisionHandlerInput,
    review: NonNullable<ReturnType<ReviewAssembler['findWaitingReview']>>,
    decision: ReviewDecisionHandlerDecision
  ): KernelCommandEnvelope {
    return {
      command: {
        kind: 'reviewGateEvaluate',
        requestId: this.ports.createId('review-gate-evaluate'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: { decision, guidance: input.guidance },
      },
    };
  }

  private reviewRunStateEvent(
    sessionId: string,
    review: NonNullable<ReturnType<ReviewAssembler['findWaitingReview']>>,
    phase: 'cancelled' | 'completed',
    status: 'cancelled' | 'completed',
    idPrefix: string
  ): AgentEvent {
    return this.ports.progressProjection.sessionRunStateEvent({
      sessionId,
      runId: review.runId,
      phase,
      status,
      reason: 'review',
      decisionOwner: {
        kind: 'review',
        runId: review.runId,
        targetId: review.reviewId,
        reviewId: review.reviewId,
        planId: review.sourcePlanId,
      },
      ts: this.ports.now(),
      id: this.ports.createId(idPrefix),
    });
  }
}

function normalizeReviewGateStatus(
  value: string | undefined
): 'accepted' | 'needsReplan' | 'aborted' | 'unavailable' {
  if (value === 'accepted' || value === 'needsReplan' || value === 'aborted') {
    return value;
  }
  return 'unavailable';
}

function reviewGateStatusMatchesDecision(
  status: Exclude<ReturnType<typeof normalizeReviewGateStatus>, 'unavailable'>,
  decision: ReviewDecisionHandlerDecision
): boolean {
  if (decision === 'reject') return status === 'aborted';
  if (decision === 'revise') return status === 'needsReplan';
  return status === 'accepted' || status === 'needsReplan';
}

function structuredErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}
