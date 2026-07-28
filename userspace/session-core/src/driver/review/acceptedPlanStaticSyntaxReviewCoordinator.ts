import type {
  AgentEvent,
  AgentEventKind,
  ConversationLanguage,
  ConversationLanguagePolicy,
  LlmChatRequest,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ResourcePacket } from '../../context/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ContextFrameBuilder, GeneratedArtifactEvidence } from '../context/index.js';
import { prepareProviderSideCallMessagesContextAdmission } from '../context/index.js';
import { effectiveConversationLanguage } from '../context/conversationLanguagePolicy.js';
import type { AcceptedTaskPlanContext } from '../execution/index.js';
import type {
  LlmTurnResult,
  SessionDriverProviderRuntimeState,
} from '../runFrame.js';
import type { ReviewAssembler } from './reviewAssembler.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';

const STATIC_SYNTAX_REVIEW_STAGE = 'accepted_plan.static_syntax_review';
const STATIC_SYNTAX_REVIEW_PROVIDER_STAGE = 'accepted_plan_static_syntax_review';

export interface AcceptedPlanStaticSyntaxReviewState extends SessionDriverProviderRuntimeState {
  sessionId: string;
  runId: string;
  userRequest: string;
  generatedArtifactEvidence: Map<string, GeneratedArtifactEvidence>;
  resourcePackets: ResourcePacket[];
  userAuthorityFrame?: {
    effectiveLanguage: ConversationLanguage;
    languagePolicy?: ConversationLanguagePolicy;
  };
}

export interface AcceptedPlanStaticSyntaxReviewInput<TState extends AcceptedPlanStaticSyntaxReviewState> {
  profileId?: string;
  state: TState;
  prompt: PromptEnvelope;
  accepted: AcceptedTaskPlanContext;
  batch: unknown;
  batchEvents: unknown[];
}

export interface AcceptedPlanStaticSyntaxReviewCoordinatorPorts<TState extends AcceptedPlanStaticSyntaxReviewState> {
  now(): string;
  createId(prefix: string): string;
  createError(code: string, message: string): Error;
  staticSyntaxReviewTimeoutMs?: number;
  emitProjectionDelta(state: TState, delta: ProjectionDelta): Promise<void>;
  runStaticSyntaxReview(input: {
    profileId?: string;
    state: TState;
    stage: typeof STATIC_SYNTAX_REVIEW_PROVIDER_STAGE;
    messages: LlmChatRequest['messages'];
    signal?: AbortSignal;
  }): Promise<LlmTurnResult>;
  recordStaticSyntaxReviewSemanticExchange(input: {
    state: TState;
    turn: LlmTurnResult;
    toolCall: NativeToolCallProposal;
    result: Record<string, unknown>;
    stage: typeof STATIC_SYNTAX_REVIEW_PROVIDER_STAGE;
  }): Promise<void>;
  recordStaticSyntaxReviewSemanticFailure(input: {
    state: TState;
    turn: LlmTurnResult;
    toolCall?: NativeToolCallProposal;
    error: unknown;
    stage: typeof STATIC_SYNTAX_REVIEW_PROVIDER_STAGE;
  }): Promise<void>;
  event(sessionId: string, kind: AgentEventKind, payload: Record<string, unknown>): AgentEvent;
  reviewAssembler: ReviewAssembler;
  contextFrameBuilder: ContextFrameBuilder;
}

export class AcceptedPlanStaticSyntaxReviewCoordinator<TState extends AcceptedPlanStaticSyntaxReviewState> {
  constructor(private readonly ports: AcceptedPlanStaticSyntaxReviewCoordinatorPorts<TState>) {}

  async run(input: AcceptedPlanStaticSyntaxReviewInput<TState>): Promise<AgentEvent[]> {
    const { accepted, batch, batchEvents, prompt, state } = input;
    const activeLanguagePolicy = state.userAuthorityFrame?.languagePolicy;
    if (
      !activeLanguagePolicy
      || (activeLanguagePolicy.status !== 'resolved' && activeLanguagePolicy.status !== 'fallback')
    ) {
      throw this.ports.createError(
        'session_language_policy_unavailable',
        'Accepted-plan static review requires a settled ConversationLanguagePolicy before creating an isolated Provider side-call.'
      );
    }
    let presentationLanguage = visibleLanguage(state);
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
      summary: presentationLanguage === 'zh-CN'
        ? `Session 正在对 ${packet.files.length} 个生成代码文件执行 Review 前静态语法/API 检查。`
        : `Session is running pre-review static syntax/API checks for ${packet.files.length} generated code file(s).`,
      payload: {
        runId: state.runId,
        planId: accepted.planId,
        targetPaths: packet.files.map((file) => file.targetPath),
        summaryKey: 'session.driver.acceptedPlanStaticSyntaxReviewRunning',
        messageKey: 'session.driver.acceptedPlanStaticSyntaxReviewRunning',
        messageArgs: { fileCount: packet.files.length },
      },
    });

    const reviewPrompt = this.ports.reviewAssembler.staticSyntaxReviewPrompt({
      prompt,
      runId: state.runId,
      accepted,
      packet,
    });
    if (reviewPrompt.suppliedFileCount === 0) {
      const visibleMessage = presentationLanguage === 'zh-CN'
        ? 'Review 前静态语法/API 检查没有可在请求预算内安全提供的文件片段。'
        : 'Pre-review static syntax/API check had no file excerpt that could be supplied safely within the request budget.';
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
          presentationLanguage,
          summary: visibleMessage,
          summaryKey: 'session.driver.acceptedPlanStaticSyntaxReviewFailed',
          messageKey: 'session.driver.acceptedPlanStaticSyntaxReviewFailed',
          messageArgs: { message: visibleMessage },
          targetPaths: packet.files.map((file) => file.targetPath),
          sourceFileCount: reviewPrompt.sourceFileCount,
          suppliedFileCount: 0,
          omittedFileCount: reviewPrompt.omittedFileCount,
          issues: [{ severity: 'warning', message: visibleMessage }],
        }),
      ];
    }

    let parsed: Record<string, unknown>;
    try {
      const providerState = forkStaticSyntaxReviewState(state);
      const admission = prepareProviderSideCallMessagesContextAdmission({
        state: providerState,
        prompt,
        contextFrameBuilder: this.ports.contextFrameBuilder,
        contractId: this.ports.createId('static-syntax-review-contract'),
        turnMode: 'reviewAnswer',
        allowedKinds: ['staticSyntaxReview'],
        requiredKind: 'staticSyntaxReview',
        messages: reviewPrompt.messages,
        userRequest: state.userRequest,
        resourcePackets: state.resourcePackets,
        generatedArtifactCount: state.generatedArtifactEvidence.size,
        repairPolicy: 'diagnosticOnly',
        projectionVisibility: 'traceOnly',
        nextActionInstruction: 'Call session.submit_static_review exactly once for the provided generated files. Report bounded observations only; do not claim Kernel execution or validation facts.',
      });
      const timeoutMs = this.ports.staticSyntaxReviewTimeoutMs ?? 45_000;
      const turn = await withDeadline(
        (signal) => this.ports.runStaticSyntaxReview({
          profileId: input.profileId,
          state: providerState,
          stage: STATIC_SYNTAX_REVIEW_PROVIDER_STAGE,
          messages: admission.messages,
          signal,
        }),
        timeoutMs,
        () => this.ports.createError(
          'session_provider_deadline_exceeded',
          `Static syntax review Provider call exceeded its ${timeoutMs} ms deadline.`
        )
      );
      presentationLanguage = effectiveConversationLanguage(turn.sourceLanguagePolicy);
      if (turn.toolCalls.length !== 1 || turn.toolCalls[0]?.name !== 'session.submit_static_review') {
        const error = new Error(
          'Static review requires exactly one session.submit_static_review directive.'
        );
        await this.ports.recordStaticSyntaxReviewSemanticFailure({
          state: providerState,
          turn,
          toolCall: turn.toolCalls.length === 1 ? turn.toolCalls[0] : undefined,
          error,
          stage: STATIC_SYNTAX_REVIEW_PROVIDER_STAGE,
        });
        throw error;
      }
      const toolCall = turn.toolCalls[0];
      try {
        parsed = admitStaticSyntaxReviewDirective(
          toolCall.arguments,
          reviewPrompt.suppliedTargetPaths,
          presentationLanguage
        );
      } catch (error) {
        await this.ports.recordStaticSyntaxReviewSemanticFailure({
          state: providerState,
          turn,
          toolCall,
          error,
          stage: STATIC_SYNTAX_REVIEW_PROVIDER_STAGE,
        });
        throw error;
      }
      await this.ports.recordStaticSyntaxReviewSemanticExchange({
        state: providerState,
        turn,
        toolCall,
        result: parsed,
        stage: STATIC_SYNTAX_REVIEW_PROVIDER_STAGE,
      });
    } catch (error) {
      if (fatalStaticReviewError(error)) throw error;
      const visibleMessage = presentationLanguage === 'zh-CN'
        ? 'Review 前静态语法/API 检查未形成可解析结果。'
        : 'The pre-review static syntax/API check did not produce a parseable result.';
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
          presentationLanguage,
          summary: presentationLanguage === 'zh-CN'
            ? 'Review 前静态语法/API 检查结果无法解析；本次静态检查未形成有效结论。'
            : 'The pre-review static syntax/API check could not be parsed, so this check produced no valid conclusion.',
          summaryKey: 'session.driver.acceptedPlanStaticSyntaxReviewFailed',
          messageKey: 'session.driver.acceptedPlanStaticSyntaxReviewFailed',
          messageArgs: { message: visibleMessage },
          targetPaths: packet.files.map((file) => file.targetPath),
          issues: [{ severity: 'warning', message: visibleMessage }],
        }),
      ];
    }

    const issues = this.ports.reviewAssembler.normalizeStaticSyntaxIssues(parsed.issues);
    const status = issues.length ? 'blocked' : 'completed';
    const coverage = `${reviewPrompt.suppliedFileCount}/${reviewPrompt.sourceFileCount}`;
    const defaultSummary = issues.length
      ? presentationLanguage === 'zh-CN'
        ? `Review 前静态语法/API 检查在已提供的 ${coverage} 个文件片段中发现 ${issues.length} 个潜在问题。`
        : `Pre-review static syntax/API check found ${issues.length} potential issue(s) in excerpts supplied for ${coverage} file(s).`
      : presentationLanguage === 'zh-CN'
        ? `Review 前静态语法/API 检查在已提供的 ${coverage} 个文件片段中未发现明显问题。`
        : `Pre-review static syntax/API check found no obvious issue in excerpts supplied for ${coverage} file(s).`;
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
        presentationLanguage,
        source: 'sessionModelObservation',
        authoritative: false,
        summary: defaultSummary,
        summaryKey: issues.length
          ? 'session.driver.acceptedPlanStaticSyntaxReviewBlocked'
          : 'session.driver.acceptedPlanStaticSyntaxReviewCompleted',
        messageKey: issues.length
          ? 'session.driver.acceptedPlanStaticSyntaxReviewBlocked'
          : 'session.driver.acceptedPlanStaticSyntaxReviewCompleted',
        messageArgs: {
          issueCount: issues.length,
        },
        targetPaths: packet.files.map((file) => file.targetPath),
        sourceFileCount: reviewPrompt.sourceFileCount,
        suppliedFileCount: reviewPrompt.suppliedFileCount,
        omittedFileCount: reviewPrompt.omittedFileCount,
        issues,
      }),
    ];
  }
}

function admitStaticSyntaxReviewDirective(
  value: Record<string, unknown>,
  targetPaths: readonly string[],
  language: ConversationLanguage
): Record<string, unknown> {
  assertExactKeys(
    value,
    ['summary', 'issues', 'responseLanguage'],
    'session.submit_static_review'
  );
  const summary = stringValue(value.summary);
  if (!summary) {
    throw new Error('session.submit_static_review.summary must be a non-empty string.');
  }
  if (!Array.isArray(value.issues)) {
    throw new Error('session.submit_static_review.issues must be an array.');
  }
  const allowedTargets = new Set(targetPaths);
  const admittedIssues = value.issues.map((item, index) => {
    const record = objectRecord(item);
    if (!record) {
      throw new Error(`session.submit_static_review.issues[${index}] must be an object.`);
    }
    assertExactKeys(
      record,
      ['targetRef', 'severity', 'message', 'line'],
      `session.submit_static_review.issues[${index}]`
    );
    const targetRef = stringValue(record.targetRef);
    if (!targetRef || !allowedTargets.has(targetRef)) {
      throw new Error(
        `session.submit_static_review.issues[${index}].targetRef must match a reviewed file.`
      );
    }
    const severity = stringValue(record.severity);
    if (severity !== 'info' && severity !== 'warning' && severity !== 'error') {
      throw new Error(
        `session.submit_static_review.issues[${index}].severity must be info, warning, or error.`
      );
    }
    const message = stringValue(record.message);
    if (!message) {
      throw new Error(
        `session.submit_static_review.issues[${index}].message must be a non-empty string.`
      );
    }
    const line = positiveInteger(record.line);
    if (record.line !== undefined && !line) {
      throw new Error(
        `session.submit_static_review.issues[${index}].line must be a positive integer.`
      );
    }
    return {
      targetRef,
      severity,
      message,
      ...(line ? { line } : {}),
    };
  });
  if (value.responseLanguage !== language) {
    throw new Error(
      `session.submit_static_review.responseLanguage must equal the settled conversation language ${language}.`
    );
  }
  return {
    summary,
    issues: admittedIssues,
    responseLanguage: language,
  };
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${path} contains unsupported field(s): ${unexpected.join(', ')}.`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function visibleLanguage(state: AcceptedPlanStaticSyntaxReviewState): ConversationLanguage {
  return state.userAuthorityFrame?.effectiveLanguage ?? 'en-US';
}

async function withDeadline<T>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number,
  deadlineError: () => Error
): Promise<T> {
  if (timeoutMs <= 0) return run(undefined);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const operation = run(controller.signal);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const error = deadlineError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (expired) void operation.catch(() => undefined);
  }
}

function forkStaticSyntaxReviewState<
  TState extends AcceptedPlanStaticSyntaxReviewState,
>(state: TState): TState {
  const providerState = state as TState & {
    activeTurn?: unknown;
    activeProviderContinuation?: unknown;
    pendingProviderRetry?: unknown;
    lastProviderResponseRequestId?: string;
    pendingProviderCommitEvents?: AgentEvent[];
    providerCommitDeferred?: boolean;
    providerRequestCacheHistory?: Record<string, unknown>;
    semanticDirectiveErrorSummary?: string;
    taskPlanReplanReason?: unknown;
  };
  return {
    ...providerState,
    providerTurnFrame: undefined,
    modelContextBundle: undefined,
    activeTurn: undefined,
    activeProviderContinuation: undefined,
    pendingProviderRetry: undefined,
    lastProviderResponseRequestId: undefined,
    pendingProviderCommitEvents: [],
    providerCommitDeferred: false,
    providerRequestCacheHistory: providerState.providerRequestCacheHistory
      ? { ...providerState.providerRequestCacheHistory }
      : undefined,
    semanticDirectiveErrorSummary: undefined,
    taskPlanReplanReason: undefined,
  };
}

function fatalStaticReviewError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'session_run_cancelled'
    || code === 'session_analysis_timeline_unavailable'
    || code === 'session_analysis_timeline_write_failed'
    || code === 'session_task_prompt_epoch_incompatible'
    || code === 'session_language_policy_unavailable'
    || code === 'session_language_frame_invalid'
    || code === 'session_language_response_mismatch'
    || code === 'session_provider_continuation_invalid'
    || code === 'session_provider_continuation_context_exhausted'
    || code === 'provider_request_identity_missing'
    || code === 'provider_request_identity_mismatch'
    || code === 'provider_thinking_continuation_invalid';
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}
