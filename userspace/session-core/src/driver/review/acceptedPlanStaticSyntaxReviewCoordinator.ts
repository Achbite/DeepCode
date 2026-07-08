import type { AgentEvent, AgentEventKind, LlmChatRequest, ProjectionDelta } from '@deepcode/protocol';
import type { ResourcePacket } from '../../context/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { GeneratedArtifactEvidence } from '../context/index.js';
import type { AcceptedImplementationPlanContext } from '../execution/index.js';
import type { ReviewAssembler } from './reviewAssembler.js';

const STATIC_SYNTAX_REVIEW_STAGE = 'accepted_plan.static_syntax_review';
const STATIC_SYNTAX_REVIEW_PROVIDER_STAGE = 'accepted_plan_static_syntax_review';

export interface AcceptedPlanStaticSyntaxReviewState {
  sessionId: string;
  runId: string;
  generatedArtifactEvidence: Map<string, GeneratedArtifactEvidence>;
  resourcePackets: ResourcePacket[];
}

export interface AcceptedPlanStaticSyntaxReviewInput<TState extends AcceptedPlanStaticSyntaxReviewState> {
  profileId?: string;
  state: TState;
  prompt: PromptEnvelope;
  accepted: AcceptedImplementationPlanContext;
  batch: Record<string, unknown>;
  batchEvents: unknown[];
}

export interface AcceptedPlanStaticSyntaxReviewCoordinatorPorts<TState extends AcceptedPlanStaticSyntaxReviewState> {
  now(): string;
  createId(prefix: string): string;
  staticSyntaxReviewTimeoutMs?: number;
  emitProjectionDelta(state: TState, delta: ProjectionDelta): Promise<void>;
  runStaticSyntaxReview(input: {
    profileId?: string;
    state: TState;
    stage: typeof STATIC_SYNTAX_REVIEW_PROVIDER_STAGE;
    messages: LlmChatRequest['messages'];
  }): Promise<string>;
  event(sessionId: string, kind: AgentEventKind, payload: Record<string, unknown>): AgentEvent;
  reviewAssembler: ReviewAssembler;
}

export class AcceptedPlanStaticSyntaxReviewCoordinator<TState extends AcceptedPlanStaticSyntaxReviewState> {
  constructor(private readonly ports: AcceptedPlanStaticSyntaxReviewCoordinatorPorts<TState>) {}

  async run(input: AcceptedPlanStaticSyntaxReviewInput<TState>): Promise<AgentEvent[]> {
    const { accepted, batch, batchEvents, prompt, state } = input;
    const packet = this.ports.reviewAssembler.staticSyntaxReviewPacket({
      accepted,
      batch,
      batchEvents,
      generatedArtifactEvidence: state.generatedArtifactEvidence,
      resourcePackets: state.resourcePackets,
    });
    if (!packet.files.length) return [];

    await this.ports.emitProjectionDelta(state, {
      type: 'stage_delta',
      sessionId: state.sessionId,
      stage: STATIC_SYNTAX_REVIEW_STAGE,
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: `Session is running pre-review static syntax/API checks for ${packet.files.length} generated code file(s).`,
      payload: {
        runId: state.runId,
        planId: accepted.planId,
        targetPaths: packet.files.map((file) => file.targetPath),
        summaryKey: 'session.driver.acceptedPlanStaticSyntaxReviewRunning',
        messageKey: 'session.driver.acceptedPlanStaticSyntaxReviewRunning',
        messageArgs: { fileCount: packet.files.length },
      },
    });

    let parsed: Record<string, unknown>;
    try {
      const reviewPromise = this.ports.runStaticSyntaxReview({
        profileId: input.profileId,
        state,
        stage: STATIC_SYNTAX_REVIEW_PROVIDER_STAGE,
        messages: this.ports.reviewAssembler.staticSyntaxReviewMessages({
          prompt,
          runId: state.runId,
          accepted,
          packet,
        }),
      });
      const timeoutMs = this.ports.staticSyntaxReviewTimeoutMs ?? 45_000;
      const raw = timeoutMs > 0
        ? await withTimeout(reviewPromise, timeoutMs)
        : await reviewPromise;
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        this.ports.event(state.sessionId, 'workflow_stage', {
          kind: STATIC_SYNTAX_REVIEW_STAGE,
          stage: STATIC_SYNTAX_REVIEW_STAGE,
          status: 'failed',
          channel: 'progress',
          visibility: 'conversation',
          presentation: 'collapsible',
          runId: state.runId,
          planId: accepted.planId,
          summary: `Pre-review static syntax/API check could not be parsed: ${message}`,
          summaryKey: 'session.driver.acceptedPlanStaticSyntaxReviewFailed',
          messageKey: 'session.driver.acceptedPlanStaticSyntaxReviewFailed',
          messageArgs: { message },
          targetPaths: packet.files.map((file) => file.targetPath),
          issues: [{ severity: 'warning', message }],
        }),
      ];
    }

    const issues = this.ports.reviewAssembler.normalizeStaticSyntaxIssues(parsed.issues);
    const status = issues.length ? 'blocked' : 'completed';
    const defaultSummary = issues.length
      ? `Pre-review static syntax/API check found ${issues.length} potential issue(s).`
      : 'Pre-review static syntax/API check found no obvious syntax/API issue.';
    const summary = stringValue(parsed.summary) ?? defaultSummary;
    return [
      this.ports.event(state.sessionId, 'workflow_stage', {
        kind: STATIC_SYNTAX_REVIEW_STAGE,
        stage: STATIC_SYNTAX_REVIEW_STAGE,
        status,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        runId: state.runId,
        planId: accepted.planId,
        summary,
        summaryKey: issues.length
          ? 'session.driver.acceptedPlanStaticSyntaxReviewBlocked'
          : 'session.driver.acceptedPlanStaticSyntaxReviewCompleted',
        messageKey: issues.length
          ? 'session.driver.acceptedPlanStaticSyntaxReviewBlocked'
          : 'session.driver.acceptedPlanStaticSyntaxReviewCompleted',
        messageArgs: { issueCount: issues.length },
        targetPaths: packet.files.map((file) => file.targetPath),
        issues,
      }),
    ];
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`static syntax review timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
