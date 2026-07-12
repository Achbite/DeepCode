import type { AgentEvent } from '@deepcode/protocol';

export type ReviewDecisionProjectionStatus = 'accepted' | 'needsRevision' | 'rejected';

export interface ReviewDecisionProjectionContext {
  runId: string;
  reviewId: string;
  sourcePlanId?: string;
  continuations: unknown[];
}

export interface ReviewDecisionProjectionInput {
  sessionId: string;
  review: ReviewDecisionProjectionContext;
  status: ReviewDecisionProjectionStatus;
  content?: string;
  continuationRequested: boolean;
  terminalAcceptedPlan?: boolean;
  ts: string;
  id: string;
}

export interface ReviewContinuationDecisionPromptInput {
  sessionId: string;
  review: ReviewDecisionProjectionContext;
  continuations: string[];
  ts: string;
  id: string;
}

export class ReviewDecisionProjectionBuilder {
  event(input: ReviewDecisionProjectionInput): AgentEvent {
    const summary = this.summaryDescriptor(input.status);
    const userContent = input.content?.trim();
    const messageArgs = {
      continuationCount: String(input.review.continuations.length),
      terminalAcceptedPlan: input.terminalAcceptedPlan ? 'true' : 'false',
    };
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'review_summary',
      payload: {
        title: 'Review',
        titleKey: 'review.decision.title',
        summary: summary.fallback,
        summaryKey: summary.key,
        messageKey: summary.key,
        messageArgs,
        ...(userContent
          ? { content: userContent }
          : { contentKey: this.defaultContentKey(input.status), contentArgs: messageArgs }),
        status: input.status,
        runId: input.review.runId,
        reviewId: input.review.reviewId,
        sourcePlanId: input.review.sourcePlanId,
        decisionOwner: {
          kind: 'review',
          runId: input.review.runId,
          targetId: input.review.reviewId,
          reviewId: input.review.reviewId,
          planId: input.review.sourcePlanId,
        },
        confirmable: false,
        continuationRequested: input.continuationRequested,
        continuationCount: input.review.continuations.length,
        continuations: input.review.continuations,
        channel: input.status === 'accepted' ? 'progress' : 'final',
        visibility: 'conversation',
        presentation: 'body',
      },
    };
  }

  continuationPromptEvent(input: ReviewContinuationDecisionPromptInput): AgentEvent {
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'assistant_msg',
      payload: {
        title: 'Continuation confirmation',
        titleKey: 'review.continuationDecision.title',
        messageKey: 'review.continuationDecision.summary',
        messageArgs: { continuationCount: String(input.continuations.length) },
        contentKey: 'review.continuationDecision.content',
        contentArgs: { continuationCount: String(input.continuations.length) },
        continuations: input.continuations,
        runId: input.review.runId,
        reviewId: input.review.reviewId,
        sourcePlanId: input.review.sourcePlanId,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'body',
      },
    };
  }

  private summaryDescriptor(status: ReviewDecisionProjectionStatus): { key: string; fallback: string } {
    if (status === 'accepted') {
      return {
        key: 'review.decision.accepted.summary',
        fallback: 'The user accepted the Review; this batch is closed.',
      };
    }
    if (status === 'rejected') {
      return {
        key: 'review.decision.rejected.summary',
        fallback: 'The user ignored the Review; this run has been cancelled.',
      };
    }
    return {
      key: 'review.decision.needsRevision.summary',
      fallback: 'The user requested additional work or changes.',
    };
  }

  private defaultContentKey(status: ReviewDecisionProjectionStatus): string {
    if (status === 'accepted') return 'review.decision.accepted.content';
    if (status === 'rejected') return 'review.decision.rejected.content';
    return 'review.decision.needsRevision.content';
  }
}
