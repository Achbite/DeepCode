import type {
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
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
  decisionContinuationInput,
  returnSessionResult,
  type SessionLoopControlResult,
} from '../runContinuation.js';
import type { InterventionLevel, ReviewContinuationMode } from '../types.js';

export type ReviewDecisionHandlerDecision = 'accept' | 'reject' | 'revise';
export type ReviewDecisionHandlerContinuationMode = ReviewContinuationMode;
export type ReviewDecisionHandlerInterventionLevel = InterventionLevel;

export interface ReviewDecisionHandlerInput {
  sessionId: string;
  decision: ReviewDecisionHandlerDecision;
  guidance?: string;
  runId?: string;
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: ReviewDecisionHandlerContinuationMode;
  interventionLevel?: ReviewDecisionHandlerInterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
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
  kernelAudit(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult>;
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
    const review = this.ports.reviewAssembler.findWaitingReview(events, input.runId, activeReview);
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
    return this.ports.append(input.sessionId, [
      this.ports.progressProjection.traceEvent({
        sessionId: input.sessionId,
        kind: 'trace/review_accept_noop',
        summary: 'Review request is already resolved or expired; no duplicate action was taken.',
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
    let result = await this.ports.append(input.sessionId, [
      this.ports.reviewDecisionProjection.event({
        sessionId: input.sessionId,
        review,
        status: 'rejected',
        content: input.guidance,
        continuationRequested: false,
        ts: this.ports.now(),
        id: this.ports.createId('review-rejected'),
      }),
    ]);
    const decisionReply = await this.ports.kernel({
      command: {
        kind: 'userDecisionSubmit',
        requestId: this.ports.createId('user-decision-review'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decisionId: this.ports.createId('decision-review'),
          decisionKind: 'review',
          targetId: review.reviewId,
          payload: {
            decision: input.decision,
            guidance: input.guidance,
            continuationRequested: false,
            revisionRequested: false,
            ignored: true,
          },
        },
      },
    });
    result = await this.ports.appendProjectedKernelEvents(input.sessionId, decisionReply);
    result = await this.ports.append(input.sessionId, [
      this.reviewRunStateEvent(input.sessionId, review, 'cancelled', 'cancelled', 'session-run-cancelled-review'),
    ]) ?? result;
    return { kind: 'reviewRejected', control: returnSessionResult(result) };
  }

  private async revise(
    input: ReviewDecisionHandlerInput,
    review: NonNullable<ReturnType<ReviewAssembler['findWaitingReview']>>
  ): Promise<ReviewDecisionRunEffect> {
    let result = await this.ports.append(input.sessionId, [
      this.ports.reviewDecisionProjection.event({
        sessionId: input.sessionId,
        review,
        status: 'needsRevision',
        content: input.guidance,
        continuationRequested: false,
        ts: this.ports.now(),
        id: this.ports.createId('review-revise'),
      }),
    ]);
    result = await this.recordRevisionAudit(input, review) ?? result;
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
    const terminalAcceptedPlan = this.ports.reviewAssembler.isTerminalAcceptedPlan(events, review);
    const continuationMode = input.reviewContinuationMode ?? 'auto';
    const closesCurrentReview = terminalAcceptedPlan || !review.continuations.length || continuationMode === 'off';
    const accepted = this.ports.reviewDecisionProjection.event({
      sessionId: input.sessionId,
      review,
      status: 'accepted',
      continuationRequested: false,
      terminalAcceptedPlan,
      ts: this.ports.now(),
      id: this.ports.createId('review-accepted'),
    });
    let result = await this.ports.append(input.sessionId, [accepted]);
    const decisionRequest: KernelCommandEnvelope = {
      command: {
        kind: 'userDecisionSubmit',
        requestId: this.ports.createId('user-decision-review'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decisionId: this.ports.createId('decision-review'),
          decisionKind: 'review',
          targetId: review.reviewId,
          payload: {
            decision: input.decision,
            guidance: input.guidance,
            continuationRequested: false,
            continuationRecorded: review.continuations.length > 0,
          },
        },
      },
    };
    const gateRequest: KernelCommandEnvelope = {
      command: {
        kind: 'reviewGateEvaluate',
        requestId: this.ports.createId('review-gate-evaluate'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decision: input.decision,
          guidance: input.guidance,
        },
      },
    };

    if (closesCurrentReview) {
      result = await this.appendTerminalReviewKernelAudit(input, result, decisionRequest);
      const gate = await this.appendTerminalReviewGate(input, result, gateRequest);
      result = gate.result;
      if (gate.status === 'accepted' || gate.status === 'unavailable') {
        result = await this.ports.append(input.sessionId, [
          this.reviewRunStateEvent(input.sessionId, review, 'completed', 'completed', 'session-run-completed-review'),
        ]) ?? result;
      }
      return { kind: 'reviewAccepted', control: returnSessionResult(result) };
    }

    const decisionReply = await this.ports.kernel(decisionRequest);
    result = await this.ports.appendProjectedKernelEvents(input.sessionId, decisionReply);
    const gateReply = await this.ports.kernel(gateRequest);
    result = await this.ports.appendProjectedKernelEvents(input.sessionId, gateReply) ?? result;

    if (continuationMode === 'ask') {
      result = await this.ports.append(input.sessionId, [
        this.ports.reviewDecisionProjection.continuationPromptEvent({
          sessionId: input.sessionId,
          review,
          continuations: this.ports.reviewAssembler.continuationSummaries(review),
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

  private async appendTerminalReviewKernelAudit(
    input: ReviewDecisionHandlerInput,
    fallback: AgentSessionResult,
    request: KernelCommandEnvelope
  ): Promise<AgentSessionResult> {
    try {
      const reply = await this.ports.kernel(request);
      return await this.ports.appendProjectedKernelEvents(input.sessionId, reply) ?? fallback;
    } catch {
      return this.appendTerminalKernelNoop(
        input,
        'reviewDecisionAuditUnavailable',
        'Kernel did not accept the terminal Review decision audit; Session keeps the accepted Review decision.'
      );
    }
  }

  private async appendTerminalReviewGate(
    input: ReviewDecisionHandlerInput,
    fallback: AgentSessionResult,
    request: KernelCommandEnvelope
  ): Promise<{ result: AgentSessionResult; status: 'accepted' | 'rejected' | 'unavailable' }> {
    try {
      const reply = await this.ports.kernel(request);
      const result = await this.ports.appendProjectedKernelEvents(input.sessionId, reply) ?? fallback;
      return {
        result,
        status: this.ports.kernelStatus.reviewGateStatus(reply.events) === 'accepted' ? 'accepted' : 'rejected',
      };
    } catch {
      return {
        result: await this.appendTerminalKernelNoop(
          input,
          'reviewGateUnavailable',
          'Kernel did not accept terminal ReviewGate evaluation; Session closes the terminal Review from the user decision.'
        ),
        status: 'unavailable',
      };
    }
  }

  private appendTerminalKernelNoop(
    input: ReviewDecisionHandlerInput,
    messageKey: string,
    summary: string
  ): Promise<AgentSessionResult> {
    return this.ports.append(input.sessionId, [
      this.ports.progressProjection.traceEvent({
        sessionId: input.sessionId,
        kind: 'trace/review_accept_noop',
        summary,
        ts: this.ports.now(),
        id: this.ports.createId('kernel-audit-noop'),
        extra: {
          messageKey: `session.driver.${messageKey}`,
          messageArgs: {},
          runId: input.runId,
          decision: input.decision,
        },
      }),
    ]);
  }

  private async recordRevisionAudit(
    input: ReviewDecisionHandlerInput,
    review: NonNullable<ReturnType<ReviewAssembler['findWaitingReview']>>
  ): Promise<AgentSessionResult> {
    const request: KernelCommandEnvelope = {
      command: {
        kind: 'userDecisionSubmit',
        requestId: this.ports.createId('user-decision-review'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decisionId: this.ports.createId('decision-review'),
          decisionKind: 'review',
          targetId: review.reviewId,
          payload: {
            decision: input.decision,
            guidance: input.guidance,
            continuationRequested: true,
            revisionRequested: true,
          },
        },
      },
    };
    try {
      const reply = await this.ports.kernelAudit(request);
      if (reply.ok) {
        return this.ports.appendProjectedKernelEvents(input.sessionId, reply);
      }
      return this.appendAuditNoop(input, reply.error?.code, reply.error?.message);
    } catch (error) {
      return this.appendAuditNoop(
        input,
        'kernel_audit_failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private appendAuditNoop(
    input: ReviewDecisionHandlerInput,
    errorCode?: string,
    errorMessage?: string
  ): Promise<AgentSessionResult> {
    return this.ports.append(input.sessionId, [
      this.ports.progressProjection.traceEvent({
        sessionId: input.sessionId,
        kind: 'trace/review_accept_noop',
        summary: 'Kernel did not accept the Review revision audit; Session will continue the revision flow from user guidance.',
        ts: this.ports.now(),
        id: this.ports.createId('kernel-audit-noop'),
        extra: {
          messageKey: 'session.driver.reviewDecision.auditFailed',
          messageArgs: {},
          errorCode: errorCode ?? 'kernel_audit_failed',
          errorMessage: errorMessage ?? 'Kernel audit command failed.',
        },
      }),
    ]);
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
