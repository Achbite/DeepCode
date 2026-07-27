import type {
  AgentConversationActivity,
  AgentEvent,
  ApiResponse,
  ConversationLanguagePolicy,
  LlmChatMessage,
  LlmChatRequest,
  LlmChatResult,
  LlmChatStreamEvent,
  ProjectionDelta,
  SessionProviderAdmissionMetadataV1,
} from '@deepcode/protocol';
import type { ContextAssemblyRecord, PromptCachePlan } from '../../context/index.js';
import { canonicalJson, stableHash } from '../../cache/canonicalizer.js';
import type { UserAuthorityFrame } from '../context/userAuthorityFrame.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import type { ProviderTraceRecorderPorts } from './providerTraceRecorder.js';
import {
  JSON_OBJECT_MODE_INSTRUCTION,
  type ProviderJsonModeCoordinator,
} from './providerJsonModeCoordinator.js';
import type {
  ProviderProgressLanguage,
  ProviderStreamCoordinator,
  ProviderStreamVisibleLanguage,
} from './providerStreamCoordinator.js';
import type { ProviderStreamRuntime, ProviderStreamRuntimeState } from './providerStreamRuntime.js';
import type { ProviderTraceRecorder } from './providerTraceRecorder.js';
import type { HookInput, HookResult } from '../hooks/index.js';
import {
  providerAnalysisTimelineAckViolation,
  providerErrorAnalysisEvent,
  providerRequestAnalysisEvent,
  providerResponseAnalysisEvent,
  providerStreamAnalysisEvents,
  type ProviderAnalysisTimelineEvent,
  type ProviderAnalysisTimelinePorts,
} from '../../provider/ProviderAnalysisTimeline.js';
import { buildProviderTurnSnapshot } from '../context/providerTurnSnapshot.js';
import { ProviderToolCallBuffer, stripProviderPartFrames, type NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import {
  promptLedgerBudget,
  promptLedgerEpoch,
  promptLedgerWireRequest,
  type PromptLedgerState,
  type PromptLedgerWireRecord,
  type ProviderRequestCacheHistoryEntry,
} from '../../prompt/promptLedger.js';
import { deferProviderCommitEvents, queueProviderCommitEvents } from './providerCommitBuffer.js';
import {
  admitProviderRequest,
  admittedProviderRequestSnapshot,
  providerAdmissionMetadata,
  providerAttemptKindForStage,
  type AdmittedProviderRequest,
  type PendingProviderRetryAdmission,
} from './admittedProviderRequest.js';
import {
  conversationLanguageFrameAdmissionViolation,
  effectiveConversationLanguage,
  withConversationLanguageFrame,
} from '../context/conversationLanguagePolicy.js';
import {
  normalizeProviderContinuationMessages,
  freezeProviderContinuationTransportControls,
  providerContinuationBaseMessagesDigest,
  providerContinuationSemanticEgressViolation,
  type ActiveProviderContinuation,
} from './providerContinuationMessages.js';
import {
  registerPendingProviderAdmission,
  SessionFactLineageError,
  type PendingProviderAdmissionRegistryState,
} from '../authority/sessionFactLineage.js';

const ANALYSIS_STREAM_BATCH_MAX_EVENTS = 128;

export interface ProviderTurnRunnerState
  extends ProviderStreamRuntimeState, PendingProviderAdmissionRegistryState {
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  providerTurnFrame?: DriverProviderTurnFrame;
  providerRequestCacheHistory?: Record<string, ProviderRequestCacheHistoryEntry>;
  promptLedger?: PromptLedgerState;
  userAuthorityFrame?: UserAuthorityFrame;
  activeProviderContinuation?: ActiveProviderContinuation;
  semanticDirectiveErrorSummary?: string;
  taskPlanReplanReason?: unknown;
  pendingProviderRetry?: PendingProviderRetryAdmission;
  lastProviderResponseRequestId?: string;
  pendingProviderCommitEvents?: AgentEvent[];
  providerCommitDeferred?: boolean;
}

export interface ProviderTurnResult {
  result: LlmChatResult;
  providerAdmission: SessionProviderAdmissionMetadataV1;
  providerRequestId: string;
  providerParentRequestId?: string;
  continuationBaseMessages: LlmChatRequest['messages'];
  continuationBaseMessagesDigest: string;
  sourceLanguagePolicy: ConversationLanguagePolicy;
  assistantMessage?: LlmChatMessage;
  providerProfileId?: string;
  provider?: string;
  model?: string;
  content: string;
  reasoning: string;
  toolCalls: NativeToolCallProposal[];
}

export interface ProviderTurnRunnerPorts<
  TState extends ProviderTurnRunnerState = ProviderTurnRunnerState,
>
  extends ProviderTraceRecorderPorts,
    ProviderAnalysisTimelinePorts {
  analysisTimelineRequired?: boolean;
  providerResponseIdentityRequired?: boolean;
  wireLedgerRequired?: boolean;
  registerProviderAdmission?: (
    sessionId: string,
    metadata: SessionProviderAdmissionMetadataV1
  ) => void | Promise<void>;
  llmChat(
    request: LlmChatRequest,
    signal?: AbortSignal
  ): Promise<ApiResponse<LlmChatResult>>;
  llmChatStream?: (
    request: LlmChatRequest,
    onEvent: (event: LlmChatStreamEvent) => void | Promise<void>,
    onEvents?: (events: readonly LlmChatStreamEvent[]) => void | Promise<void>,
    signal?: AbortSignal
  ) => Promise<ApiResponse<LlmChatResult>>;
  consumeGuidanceMessages?(
    state: TState,
    stage: string
  ): Promise<LlmChatRequest['messages']>;
  appendEvents(sessionId: string, events: AgentEvent[]): Promise<unknown>;
  appendWireLedger?: (sessionId: string, entries: PromptLedgerWireRecord[]) => Promise<void>;
  appendCacheTelemetry?: (sessionId: string, entry: Record<string, unknown>) => Promise<void>;
}

export interface ProviderTurnRunnerDependencies<TState extends ProviderTurnRunnerState> {
  jsonModeCoordinator: ProviderJsonModeCoordinator;
  streamCoordinator: ProviderStreamCoordinator;
  streamRuntime: ProviderStreamRuntime<TState>;
  traceRecorder: ProviderTraceRecorder;
  visibleLanguage(state: TState): ProviderStreamVisibleLanguage;
  admitLanguageDecision?(state: TState, input: {
    requestId: string;
    content: string;
    toolCalls: readonly NativeToolCallProposal[];
  }): Promise<void>;
  providerActivity(input: {
    runId: string;
    userRequest: string;
    stage: string;
    status: 'running' | 'completed';
    language: ProviderProgressLanguage;
  }): AgentConversationActivity;
  emitProjectionDelta(state: TState, delta: Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>): Promise<void>;
  cacheTelemetryEvent(input: {
    sessionId: string;
    profileId?: string;
    provider?: string;
    model?: string;
    stage: string;
    usage?: Record<string, unknown>;
    promptSegmentDigests: Array<Record<string, unknown>>;
    stablePrefixHash?: string;
    dynamicSuffixHash?: string;
    finalUserPromptHash?: string;
    finalUserPromptCharLength?: number;
    cacheHash?: string;
    promptLedgerEpochScopeKey?: string;
    promptLedgerTaskTemplateHash?: string;
    ts: string;
    id: string;
  }): AgentEvent | null | undefined;
  createToolCallBuffer(): ProviderToolCallBuffer;
  collectToolCalls(result: LlmChatResult, buffer: ProviderToolCallBuffer): NativeToolCallProposal[];
  nativeToolError(error: unknown): { code: string; message: string } | undefined;
  runHook?(input: HookInput): Promise<HookResult[]>;
  createError(code: string, message: string): Error;
  now(): string;
  createId(prefix: string): string;
}

export class ProviderTurnRunner<TState extends ProviderTurnRunnerState> {
  constructor(private readonly dependencies: ProviderTurnRunnerDependencies<TState>) {}

  async run(input: {
    profileId?: string;
    state: TState;
    stage: string;
    messages: LlmChatRequest['messages'];
    options?: Pick<LlmChatRequest, 'responseFormat' | 'tools'>;
    abortSignal?: AbortSignal;
    consumeGuidance?: boolean;
    stream?: boolean;
    ports: ProviderTurnRunnerPorts<TState>;
  }): Promise<ProviderTurnResult> {
    const options = input.options ?? {};
    const { state, stage, ports } = input;
    const useStreaming = input.stream !== false && Boolean(ports.llmChatStream);
    assertProviderCallActive(input.abortSignal, this.dependencies.createError);
    state.lastProviderResponseRequestId = undefined;
    const admittedGuidance = input.consumeGuidance === false
      ? []
      : await ports.consumeGuidanceMessages?.(state, stage) ?? [];
    assertProviderCallActive(input.abortSignal, this.dependencies.createError);
    const jsonModeMessages = this.dependencies.jsonModeCoordinator.ensureMessages(
      admittedGuidance.length
        ? [...input.messages, ...admittedGuidance]
        : input.messages,
      options.responseFormat
    );
    const userAuthorityFrame = state.userAuthorityFrame;
    const languagePolicy = userAuthorityFrame?.languagePolicy;
    if (!languagePolicy) {
      throw this.dependencies.createError(
        'session_language_policy_unavailable',
        'Provider admission requires a persisted ConversationLanguagePolicy.'
      );
    }
    const stageAttemptKind = providerAttemptKindForStage(stage);
    const pendingRetry = state.pendingProviderRetry;
    if (
      pendingRetry?.attemptKind === 'emptyRetry'
      && stageAttemptKind !== 'emptyRetry'
    ) {
      throw this.dependencies.createError(
        'session_provider_continuation_invalid',
        `Pending empty Provider retry cannot be admitted at stage ${stage}.`
      );
    }
    let activeContinuation = state.activeProviderContinuation;
    const freshFromFacts = Boolean(
      activeContinuation
      && (
        activeContinuation.sourceLanguagePolicy.revision !== languagePolicy.revision
        || stageAttemptKind === 'repair'
        || stageAttemptKind === 'review'
        || pendingRetry?.rebaseFromFacts
        || state.semanticDirectiveErrorSummary
        || state.taskPlanReplanReason
      )
    );
    if (freshFromFacts) {
      state.activeProviderContinuation = undefined;
      activeContinuation = undefined;
    }
    if (
      activeContinuation
      && activeContinuation.sourceLanguagePolicy.revision === languagePolicy.revision
      && activeContinuation.sourceLanguagePolicy.status === 'pending'
      && languagePolicy.status !== 'pending'
    ) {
      if (languagePolicy.status === 'superseded') {
        throw this.dependencies.createError(
          'session_provider_continuation_invalid',
          `Active Provider continuation language revision ${languagePolicy.revision} was superseded without a new authority revision.`
        );
      }
      activeContinuation = {
        ...activeContinuation,
        sourceLanguagePolicy: cloneLanguagePolicy(languagePolicy),
      };
      state.activeProviderContinuation = activeContinuation;
    }
    if (
      activeContinuation
      && activeContinuation.sourceLanguagePolicy.revision === languagePolicy.revision
      && activeContinuation.sourceLanguagePolicy.status !== 'pending'
      && (
        languagePolicy.status === 'pending'
        || activeContinuation.sourceLanguagePolicy.language !== languagePolicy.language
      )
    ) {
      throw this.dependencies.createError(
        'session_provider_continuation_invalid',
        `Active Provider continuation language decision for revision ${languagePolicy.revision} no longer matches the persisted policy.`
      );
    }
    if (activeContinuation) {
      const continuationIdentity = [
        ['sessionId', activeContinuation.sessionId, state.sessionId],
        ['runId', activeContinuation.runId, state.runId],
        ['turnId', activeContinuation.turnId, userAuthorityFrame.turnAuthority.turnId],
        ['taskId', activeContinuation.taskId, userAuthorityFrame.turnAuthority.taskId],
        [
          'turnAuthorityRef',
          activeContinuation.turnAuthorityRef,
          userAuthorityFrame.turnAuthorityRef,
        ],
        [
          'promptLedgerEpochId',
          activeContinuation.promptLedgerEpochId,
          state.providerTurnFrame?.promptLedgerEpochId,
        ],
      ] as const;
      for (const [name, previous, current] of continuationIdentity) {
        if (!current?.trim() || previous !== current) {
          throw this.dependencies.createError(
            'session_provider_continuation_invalid',
            `Active Provider continuation ${name} ${previous} does not match current ${current ?? 'missing'}.`
          );
        }
      }
    }
    if (activeContinuation && activeContinuation.exchanges.length === 0) {
      throw this.dependencies.createError(
        'session_provider_continuation_invalid',
        'Active Provider continuation has no semantic exchanges.'
      );
    }
    const activeContinuationLatestRevision = activeContinuation?.exchanges.reduce(
      (latest, exchange) => Math.max(latest, exchange.languageRevision),
      0
    );
    if (
      activeContinuationLatestRevision
      && activeContinuationLatestRevision !== languagePolicy.revision
    ) {
      throw this.dependencies.createError(
        'session_provider_continuation_invalid',
        `Active Provider continuation language revision ${activeContinuationLatestRevision} does not match ${languagePolicy.revision}.`
      );
    }
    if (
      activeContinuation?.semanticProfileId
      && state.providerTurnFrame?.snapshot?.semanticProfileId
      && activeContinuation.semanticProfileId
        !== state.providerTurnFrame.snapshot.semanticProfileId
    ) {
      throw this.dependencies.createError(
        'session_provider_continuation_invalid',
        `Active Provider continuation semantic profile ${activeContinuation.semanticProfileId} does not match ${state.providerTurnFrame.snapshot.semanticProfileId}.`
      );
    }
    for (const [name, previous, current] of [
      ['providerProfileId', activeContinuation?.providerProfileId, input.profileId],
      ['toolSchemaHash', activeContinuation?.toolSchemaHash, state.providerTurnFrame?.snapshot?.toolSchemaHash],
      ['responseFormatHash', activeContinuation?.responseFormatHash, state.providerTurnFrame?.snapshot?.responseFormatHash],
    ] as const) {
      if (previous && current && previous !== current) {
        throw this.dependencies.createError(
          'session_provider_continuation_invalid',
          `Active Provider continuation ${name} ${previous} does not match current ${current}.`
        );
      }
    }
    const activeProviderIdentity = activeContinuation
      ? exactActiveProviderIdentity(
          activeContinuation,
          input.profileId,
          ports.providerResponseIdentityRequired === true,
          this.dependencies.createError
        )
      : undefined;
    const effectiveProviderProfileId = activeProviderIdentity?.profileId ?? input.profileId;
    const attemptKind = pendingRetry?.attemptKind
      ?? (activeContinuation ? 'resume' : stageAttemptKind);
    if (activeContinuation) {
      activeContinuation = freezeProviderContinuationTransportControls(
        activeContinuation,
        attemptKind
      );
      state.activeProviderContinuation = activeContinuation;
    }
    const continuation = normalizeProviderContinuationMessages(
      jsonModeMessages,
      activeContinuation,
      attemptKind
    );
    if (continuation.violation) {
      throw this.dependencies.createError(
        'session_provider_continuation_invalid',
        `Provider admission rejected: ${continuation.violation}.`
      );
    }
    const admittedLanguagePolicy = activeContinuation?.sourceLanguagePolicy ?? languagePolicy;
    const authoritativeInput = userAuthorityFrame.currentMessages.at(-1)?.content
      ?? userAuthorityFrame.rootMessage.content;
    const admittedMessages = withConversationLanguageFrame(
      continuation.messages,
      admittedLanguagePolicy,
      authoritativeInput
    );
    const languageFrameViolation = conversationLanguageFrameAdmissionViolation(
      admittedMessages,
      admittedLanguagePolicy,
      authoritativeInput
    );
    if (languageFrameViolation) {
      throw this.dependencies.createError(
        'session_language_frame_invalid',
        `Provider admission rejected: ${languageFrameViolation}.`
      );
    }
    const budgetPlan = state.contextAssembly?.budgetPlan;
    if (budgetPlan) {
      const finalBudget = promptLedgerBudget(
        admittedMessages,
        budgetPlan.contextWindowTokens,
        budgetPlan.maxOutputTokens
      );
      if (finalBudget.estimatedInputTokens > finalBudget.availableInputTokens) {
        throw this.dependencies.createError(
          activeContinuation
            ? 'session_provider_continuation_context_exhausted'
            : 'provider_request_input_budget_exceeded',
          `Final Provider input requires an estimated ${finalBudget.estimatedInputTokens} tokens but only ${finalBudget.availableInputTokens} are available.`
        );
      }
    }
    const providerCallHookTrace = await this.runProviderCallHook(state);
    const primaryRequestId = this.dependencies.createId(`provider-request-${stage}`);
    const semanticContinuationParentRequestId = activeContinuation?.exchanges.at(-1)?.sourceRequestId;
    const transportParentRequestId = pendingRetry?.parentRequestId
      ?? semanticContinuationParentRequestId;
    const primaryAdmitted = admitProviderRequest({
      requestId: primaryRequestId,
      parentRequestId: transportParentRequestId,
      turnAuthorityRef: userAuthorityFrame.turnAuthorityRef,
      attemptKind,
      stage,
      languageRevision: languagePolicy.revision,
      transportRequest: {
        requestId: primaryRequestId,
        parentRequestId: transportParentRequestId,
        profileId: effectiveProviderProfileId,
        messages: admittedMessages,
        responseFormat: options.responseFormat,
        tools: options.tools,
        stream: useStreaming,
        providerOptions: {
          deepcode: {
            cachePlan: state.cachePlan,
            ...(activeProviderIdentity
              ? { expectedProviderIdentity: activeProviderIdentity }
              : {}),
          },
        },
      },
    });
    const primaryProviderAdmission = providerAdmissionMetadata(primaryAdmitted);
    await this.registerProviderAdmission(
      state,
      ports,
      primaryProviderAdmission
    );
    state.pendingProviderRetry = undefined;
    let effectiveAdmitted = primaryAdmitted;
    let effectiveProviderAdmission = primaryProviderAdmission;
    let cacheTopology = providerRequestCacheTopology(state, primaryAdmitted);
    await this.appendAnalysis(state, ports, [
      providerRequestAnalysisEvent({
        state,
        admitted: primaryAdmitted,
        recordId: this.dependencies.createId(`analysis-${stage}-request`),
        createdAt: this.dependencies.now(),
      }),
    ]);
    await this.dependencies.traceRecorder.append(state, `${stage}.request`, {
      admittedRequest: admittedProviderRequestSnapshot(primaryAdmitted),
      profileId: primaryAdmitted.transportRequest.profileId,
      semanticProfileId: state.providerTurnFrame?.snapshot?.semanticProfileId,
      messages: continuation.restorationMessages,
      messageMaterialScope: 'restorationBase',
      exactAdmittedMessagesAvailable: false,
      cachePlan: state.cachePlan,
      contextAssembly: state.contextAssembly,
      providerTurnSnapshot: state.providerTurnFrame?.snapshot,
      hookTrace: state.providerTurnFrame?.hookTrace ?? providerCallHookTrace,
      responseFormat: primaryAdmitted.transportRequest.responseFormat,
      tools: primaryAdmitted.transportRequest.tools,
      cacheTopology,
      responseFormatAudit: this.dependencies.jsonModeCoordinator.audit(input.messages, options.responseFormat),
    }, ports);
    const visibleLanguage: ProviderProgressLanguage = admittedLanguagePolicy.status === 'pending'
      ? 'neutral'
      : this.dependencies.visibleLanguage(state);
    const runningActivity = this.dependencies.providerActivity({
      runId: state.runId,
      userRequest: state.userRequest,
      stage,
      status: 'running',
      language: visibleLanguage,
    });
    const exposeProviderProgress = stage === 'provider_call';
    await this.dependencies.emitProjectionDelta(state, {
      type: 'active_turn',
      stage: 'session.provider_status',
      status: useStreaming ? 'streaming' : 'running',
      channel: 'progress',
      source: 'session',
      summary: runningActivity.summary,
      activity: runningActivity,
      payload: {
        providerStage: stage,
        visibility: exposeProviderProgress ? 'task' : 'hidden',
        presentation: exposeProviderProgress ? 'stageSummary' : 'traceOnly',
        providerRequestId: primaryAdmitted.requestId,
        rawReasoningVisible: false,
      },
    });
    this.dependencies.streamRuntime.beginProviderCall(state, stage, primaryAdmitted.requestId);
    await this.appendWireRequest(
      state,
      primaryAdmitted,
      continuation.restorationMessages,
      ports
    );
    const toolCallBuffer = this.dependencies.createToolCallBuffer();
    let nextProviderSeq = 0;
    let result: ApiResponse<LlmChatResult>;
    const consumeStreamEvents = async (
      events: readonly LlmChatStreamEvent[]
    ): Promise<void> => {
      if (events.length === 0) return;
      for (
        let offset = 0;
        offset < events.length;
        offset += ANALYSIS_STREAM_BATCH_MAX_EVENTS
      ) {
        const batch = events.slice(
          offset,
          offset + ANALYSIS_STREAM_BATCH_MAX_EVENTS
        );
        const createdAt = this.dependencies.now();
        await this.appendAnalysis(
          state,
          ports,
          providerStreamAnalysisEvents({
            state,
            admitted: primaryAdmitted,
            events: batch.map((event) => ({
              observedAt: this.dependencies.now(),
              event,
            })),
            startProviderSeq: nextProviderSeq,
            completion: batch.at(-1)?.type === 'provider_done' ? 'complete' : 'partial',
            recordId: this.dependencies.createId(`analysis-${stage}-stream`),
            createdAt,
            })
        );
        assertProviderCallActive(input.abortSignal, this.dependencies.createError);
        nextProviderSeq += batch.length;
      }
      for (const event of events) {
        assertProviderCallActive(input.abortSignal, this.dependencies.createError);
        await this.dependencies.streamRuntime.handleEvent({
          state,
          stage,
          event,
          toolCallBuffer,
        });
      }
    };
    try {
      result = useStreaming
        ? await ports.llmChatStream!(
          primaryAdmitted.transportRequest,
          (event) => consumeStreamEvents([event]),
          consumeStreamEvents,
          input.abortSignal
        )
        : await ports.llmChat(primaryAdmitted.transportRequest, input.abortSignal);
    } catch (error) {
      const detail = providerThrownError(error);
      await this.appendAnalysis(state, ports, [
        providerErrorAnalysisEvent({
          state,
          admitted: primaryAdmitted,
          error: detail.error,
          message: detail.message,
          recordId: this.dependencies.createId(`analysis-${stage}-error`),
          createdAt: this.dependencies.now(),
        }),
      ]);
      await this.dependencies.streamRuntime.discardCurrentSemanticDrafts(
        state,
        stage,
        'semantic_draft_provider_transport_failed'
      );
      throw error;
    }
    const abortedAfterProviderResult = providerCallAbortError(
      input.abortSignal,
      this.dependencies.createError
    );
    if (abortedAfterProviderResult) {
      const detail = providerThrownError(abortedAfterProviderResult);
      await this.appendAnalysis(state, ports, [
        ...(result.data
          ? [providerResponseAnalysisEvent({
              state,
              admitted: effectiveAdmitted,
              result: result.data,
              disposition: 'rejectedBeforeSemanticAdmission' as const,
              recordId: this.dependencies.createId(`analysis-${stage}-response-deadline-rejected`),
              createdAt: this.dependencies.now(),
            })]
          : []),
        providerErrorAnalysisEvent({
          state,
          admitted: effectiveAdmitted,
          error: detail.error,
          message: detail.message,
          recordId: this.dependencies.createId(`analysis-${stage}-deadline`),
          createdAt: this.dependencies.now(),
        }),
      ]);
      await this.dependencies.streamRuntime.discardCurrentSemanticDrafts(
        state,
        stage,
        'semantic_draft_provider_aborted'
      );
      throw abortedAfterProviderResult;
    }
    if (useStreaming && (!result.ok || !result.data)) {
      await this.appendAnalysis(state, ports, [
        providerErrorAnalysisEvent({
          state,
          admitted: primaryAdmitted,
          error: result.error,
          message: result.message,
          recordId: this.dependencies.createId(`analysis-${stage}-error`),
          createdAt: this.dependencies.now(),
        }),
      ]);
      if (result.error === 'session_run_cancelled') {
        await this.dependencies.streamRuntime.discardCurrentSemanticDrafts(
          state,
          stage,
          'semantic_draft_cancelled'
        );
        throw this.dependencies.createError(
          'session_run_cancelled',
          result.message ?? 'Session run cancelled by user.'
        );
      }
      if (isProviderCallAbortCode(result.error)) {
        throw this.dependencies.createError(
          result.error ?? 'session_provider_call_aborted',
          result.message ?? 'Session Provider call was aborted before semantic admission.'
        );
      }
      if (isProviderRequestIdentityError(result.error)) {
        throw this.dependencies.createError(
          result.error ?? 'provider_request_identity_invalid',
          result.message ?? 'Provider request identity validation failed.'
        );
      }
      if (
        result.error === 'session_analysis_timeline_unavailable'
        || result.error === 'session_analysis_timeline_write_failed'
      ) {
        throw this.dependencies.createError(
          result.error,
          result.message ?? 'Provider analysis timeline persistence failed.'
        );
      }
      if (result.error === 'provider_thinking_continuation_invalid') {
        throw this.dependencies.createError(
          result.error,
          result.message ?? 'Provider thinking continuation validation failed.'
        );
      }
      await this.dependencies.streamRuntime.discardCurrentSemanticDrafts(
        state,
        stage,
        'semantic_draft_stream_fallback'
      );
      const fallbackRequestId = this.dependencies.createId(`provider-request-${stage}-stream-fallback`);
      const fallbackAdmitted = admitProviderRequest({
        requestId: fallbackRequestId,
        parentRequestId: primaryAdmitted.requestId,
        turnAuthorityRef: primaryAdmitted.turnAuthorityRef,
        attemptKind: 'streamFallback',
        stage: `${stage}.streamFallback`,
        languageRevision: languagePolicy.revision,
        transportRequest: {
          ...primaryAdmitted.transportRequest,
          requestId: fallbackRequestId,
          parentRequestId: primaryAdmitted.requestId,
          stream: false,
        },
      });
      const fallbackProviderAdmission = providerAdmissionMetadata(fallbackAdmitted);
      await this.registerProviderAdmission(
        state,
        ports,
        fallbackProviderAdmission
      );
      effectiveAdmitted = fallbackAdmitted;
      effectiveProviderAdmission = fallbackProviderAdmission;
      cacheTopology = providerRequestCacheTopology(state, fallbackAdmitted);
      this.dependencies.streamRuntime.beginProviderCall(state, stage, fallbackAdmitted.requestId);
      await this.appendAnalysis(state, ports, [
        providerRequestAnalysisEvent({
          state,
          admitted: fallbackAdmitted,
          recordId: this.dependencies.createId(`analysis-${stage}-stream-fallback-request`),
          createdAt: this.dependencies.now(),
        }),
      ]);
      await this.dependencies.traceRecorder.append(state, `${stage}.stream_fallback.request`, {
        reason: result.message ?? result.error ?? 'streaming provider request failed',
        admittedRequest: admittedProviderRequestSnapshot(fallbackAdmitted),
        profileId: fallbackAdmitted.transportRequest.profileId,
        semanticProfileId: state.providerTurnFrame?.snapshot?.semanticProfileId,
        messages: continuation.restorationMessages,
        messageMaterialScope: 'restorationBase',
        exactAdmittedMessagesAvailable: false,
        responseFormat: fallbackAdmitted.transportRequest.responseFormat,
        tools: fallbackAdmitted.transportRequest.tools,
      }, ports);
      await this.appendWireRequest(
        state,
        fallbackAdmitted,
        continuation.restorationMessages,
        ports
      );
      try {
        assertProviderCallActive(input.abortSignal, this.dependencies.createError);
        result = await ports.llmChat(
          fallbackAdmitted.transportRequest,
          input.abortSignal
        );
        assertProviderCallActive(input.abortSignal, this.dependencies.createError);
      } catch (error) {
        const detail = providerThrownError(error);
        await this.appendAnalysis(state, ports, [
          providerErrorAnalysisEvent({
            state,
            admitted: fallbackAdmitted,
            error: detail.error,
            message: detail.message,
            recordId: this.dependencies.createId(`analysis-${stage}-stream-fallback-error`),
            createdAt: this.dependencies.now(),
          }),
        ]);
        throw error;
      }
    }
    if (!result.ok || !result.data) {
      await this.appendAnalysis(state, ports, [
        providerErrorAnalysisEvent({
          state,
          admitted: effectiveAdmitted,
          error: result.error,
          message: result.message,
          recordId: this.dependencies.createId(`analysis-${stage}-error`),
          createdAt: this.dependencies.now(),
        }),
      ]);
      if (result.error === 'session_run_cancelled' || isProviderCallAbortCode(result.error)) {
        throw this.dependencies.createError(
          result.error ?? 'session_provider_call_aborted',
          result.message ?? 'Session Provider call stopped before semantic admission.'
        );
      }
      if (isProviderRequestIdentityError(result.error)) {
        throw this.dependencies.createError(
          result.error ?? 'provider_profile_identity_invalid',
          result.message ?? 'Provider identity validation failed before semantic admission.'
        );
      }
      throw this.dependencies.createError(
        'llm_chat_failed',
        result.message ?? result.error ?? 'LLM provider request failed.'
      );
    }
    let providerResult: LlmChatResult;
    assertProviderCallActive(input.abortSignal, this.dependencies.createError);
    try {
      providerResult = normalizeProviderResponseIdentity(
        result.data,
        effectiveAdmitted,
        ports.providerResponseIdentityRequired === true,
        this.dependencies.createError
      );
    } catch (error) {
      const detail = providerThrownError(error);
      await this.appendAnalysis(state, ports, [
        providerResponseAnalysisEvent({
          state,
          admitted: effectiveAdmitted,
          result: result.data,
          disposition: 'rejectedBeforeSemanticAdmission',
          recordId: this.dependencies.createId(`analysis-${stage}-response-rejected-raw`),
          createdAt: this.dependencies.now(),
        }),
        providerErrorAnalysisEvent({
          state,
          admitted: effectiveAdmitted,
          error: detail.error,
          message: detail.message,
          recordId: this.dependencies.createId(`analysis-${stage}-response-rejected`),
          createdAt: this.dependencies.now(),
        }),
      ]);
      throw error;
    }
    await this.appendAnalysis(state, ports, [
      providerResponseAnalysisEvent({
        state,
        admitted: effectiveAdmitted,
        result: providerResult,
        recordId: this.dependencies.createId(`analysis-${stage}-response`),
        createdAt: this.dependencies.now(),
      }),
    ]);
    commitProviderRequestCacheHistory(state, effectiveAdmitted);
    assertProviderCallActive(input.abortSignal, this.dependencies.createError);
    state.lastProviderResponseRequestId = effectiveAdmitted.requestId;
    const usage = objectRecord(providerResult.usage);
    const requestCacheFacts = admittedProviderCacheFacts(effectiveAdmitted, state);
    const cacheEvent = this.dependencies.cacheTelemetryEvent({
      sessionId: state.sessionId,
      profileId: providerResult.providerProfileId
        ?? effectiveAdmitted.transportRequest.profileId,
      provider: providerResult.provider ?? state.contextAssembly?.provider,
      model: providerResult.model ?? state.contextAssembly?.model,
      stage: effectiveAdmitted.stage,
      usage,
      promptSegmentDigests: [
        ...(state.contextAssembly?.segments.map((segment): Record<string, unknown> => ({
          id: segment.id,
          name: segment.name,
          cacheClass: segment.cacheClass,
          stablePrefix: segment.stablePrefix,
          auditOnly: true,
          source: 'contextAssemblyCandidate',
          sourceAuditOnly: segment.auditOnly,
          contentHash: segment.contentHash,
          charLength: segment.charLength,
        })) ?? []),
        ...requestCacheFacts.segments.map((segment): Record<string, unknown> => ({
          ...segment,
          source: 'admittedProviderRequest',
          auditOnly: false,
        })),
        {
          id: 'provider-request-topology',
          name: 'providerRequestTopology',
          cacheClass: 'providerRequest',
          stablePrefix: false,
          auditOnly: true,
          source: 'admittedProviderRequest',
          ...cacheTopology,
        },
      ],
      stablePrefixHash: requestCacheFacts.stablePrefixHash,
      dynamicSuffixHash: requestCacheFacts.dynamicSuffixHash,
      finalUserPromptHash: requestCacheFacts.finalUserPromptHash,
      finalUserPromptCharLength: requestCacheFacts.finalUserPromptCharLength,
      cacheHash: effectiveAdmitted.providerPayloadDigest,
      promptLedgerEpochScopeKey: state.providerTurnFrame?.promptLedgerEpochScopeKey,
      promptLedgerTaskTemplateHash: state.providerTurnFrame?.promptLedgerTaskTemplateHash,
      ts: this.dependencies.now(),
      id: this.dependencies.createId(`cache-${stage}`),
    });
    const providerCommitEvents: AgentEvent[] = cacheEvent ? [cacheEvent] : [];
    if (cacheEvent) {
      await ports.appendCacheTelemetry?.(state.sessionId, {
        schemaVersion: 'deepcode.session.cache-telemetry.v1',
        recordId: cacheEvent.id,
        requestId: effectiveAdmitted.requestId,
        parentRequestId: effectiveAdmitted.parentRequestId,
        attemptKind: effectiveAdmitted.attemptKind,
        languageRevision: effectiveAdmitted.languageRevision,
        providerPayloadDigest: effectiveAdmitted.providerPayloadDigest,
        transportDigest: effectiveAdmitted.transportDigest,
        digestMaterialScope: 'sessionAdmitted',
        exactExternalWireBody: false,
        stablePrefixHash: requestCacheFacts.stablePrefixHash,
        dynamicSuffixHash: requestCacheFacts.dynamicSuffixHash,
        finalUserPromptHash: requestCacheFacts.finalUserPromptHash,
        finalUserPromptCharLength: requestCacheFacts.finalUserPromptCharLength,
        sessionId: state.sessionId,
        runId: state.runId,
        providerProfileId: providerResult.providerProfileId
          ?? effectiveAdmitted.transportRequest.profileId,
        provider: providerResult.provider ?? state.contextAssembly?.provider,
        model: providerResult.model ?? state.contextAssembly?.model,
        stage: effectiveAdmitted.stage,
        timestamp: cacheEvent.ts,
        rawUsage: usage,
        normalizedUsage: objectRecord(cacheEvent.payload)?.normalizedUsage,
        promptSegmentDigests: objectRecord(cacheEvent.payload)?.promptSegmentDigests,
        cacheShape: cacheTopology,
        cacheShapeReason: state.providerTurnFrame?.promptLedgerCacheShapeReason,
        promptLedgerEpochId: state.providerTurnFrame?.promptLedgerEpochId,
        promptLedgerEpochScopeKey: state.providerTurnFrame?.promptLedgerEpochScopeKey,
        promptLedgerTaskTemplateHash: state.providerTurnFrame?.promptLedgerTaskTemplateHash,
        turnId: state.userAuthorityFrame?.turnAuthority.turnId,
        taskId: state.userAuthorityFrame?.turnAuthority.taskId,
        sourceMessageHashes: state.userAuthorityFrame?.turnAuthority.sourceMessageHashes,
        authorityHash: state.userAuthorityFrame?.turnAuthority.authorityHash,
      }).catch(() => undefined);
    }
    await this.dependencies.traceRecorder.append(state, `${effectiveAdmitted.stage}.response`, {
      ...providerResult,
      parentRequestId: effectiveAdmitted.parentRequestId,
      attemptKind: effectiveAdmitted.attemptKind,
    }, ports);
    const reasoning = collectReasoning(providerResult);
    const completedActivity = this.dependencies.providerActivity({
      runId: state.runId,
      userRequest: state.userRequest,
      stage,
      status: 'completed',
      language: admittedLanguagePolicy.status === 'pending'
        ? 'neutral'
        : this.dependencies.visibleLanguage(state),
    });
    await this.dependencies.emitProjectionDelta(state, {
      type: 'active_turn',
      stage: 'session.provider_status',
      status: 'completed',
      channel: 'progress',
      source: 'session',
      summary: completedActivity.summary,
      activity: completedActivity,
      payload: {
        providerStage: stage,
        visibility: exposeProviderProgress ? 'task' : 'hidden',
        presentation: exposeProviderProgress ? 'stageSummary' : 'traceOnly',
        providerRequestId: effectiveAdmitted.requestId,
        rawReasoningVisible: false,
      },
    });
    const content = stripProviderPartFrames(providerResult.assistantMessage?.content
      ?? providerResult.chunks
        .filter((chunk) => chunk.type === 'delta' && typeof chunk.content === 'string')
        .map((chunk) => chunk.content)
        .join(''));
    let toolCalls: NativeToolCallProposal[];
    try {
      toolCalls = this.dependencies.collectToolCalls(providerResult, toolCallBuffer);
    } catch (error) {
      const nativeToolError = this.dependencies.nativeToolError(error);
      if (nativeToolError) {
        if (this.dependencies.streamRuntime.hasCurrentSemanticDraft(state)) {
          deferProviderCommitEvents(state);
          queueProviderCommitEvents(state, providerCommitEvents);
          await this.dependencies.streamRuntime.failSemanticDraft(
            state,
            stage,
            undefined,
            nativeToolError.code
          );
        } else if (providerCommitEvents.length > 0) {
          await ports.appendEvents(state.sessionId, providerCommitEvents);
        }
        throw this.dependencies.createError(nativeToolError.code, nativeToolError.message);
      }
      if (providerCommitEvents.length > 0) await ports.appendEvents(state.sessionId, providerCommitEvents);
      throw error;
    }
    const continuationControlLeak = providerContinuationSemanticEgressViolation(
      toolCalls,
      continuation.transportControls
    );
    if (continuationControlLeak) {
      if (this.dependencies.streamRuntime.hasCurrentSemanticDraft(state)) {
        deferProviderCommitEvents(state);
        queueProviderCommitEvents(state, providerCommitEvents);
        await this.dependencies.streamRuntime.failSemanticDraft(
          state,
          stage,
          toolCalls[0]?.callId,
          'provider_continuation_control_leak'
        );
      } else if (providerCommitEvents.length > 0) {
        await ports.appendEvents(state.sessionId, providerCommitEvents);
      }
      throw this.dependencies.createError(
        'provider_continuation_control_leak',
        `Provider semantic response was rejected before admission: ${continuationControlLeak}.`
      );
    }
    assertProviderCallActive(input.abortSignal, this.dependencies.createError);
    const registeredProviderToolNames = new Set(
      (effectiveAdmitted.transportRequest.tools ?? []).map((tool) => tool.name)
    );
    const languageDecisionAdmissible = registeredProviderToolNames.size === 0
      || (
        toolCalls.length === 1
        && registeredProviderToolNames.has(toolCalls[0]!.name)
      );
    if (languageDecisionAdmissible) {
      await this.dependencies.admitLanguageDecision?.(state, {
        requestId: effectiveAdmitted.requestId,
        content,
        toolCalls,
      });
    }
    const settledLanguagePolicy = state.userAuthorityFrame?.languagePolicy;
    if (
      settledLanguagePolicy
      && settledLanguagePolicy.revision !== admittedLanguagePolicy.revision
    ) {
      throw this.dependencies.createError(
        'session_provider_continuation_invalid',
        `Provider response language revision ${settledLanguagePolicy.revision} does not match admitted revision ${admittedLanguagePolicy.revision}.`
      );
    }
    if (settledLanguagePolicy?.status === 'superseded') {
      throw this.dependencies.createError(
        'session_provider_continuation_invalid',
        `Provider response language revision ${settledLanguagePolicy.revision} was superseded before semantic admission completed.`
      );
    }
    const continuationLanguagePolicy = settledLanguagePolicy
      ?? admittedLanguagePolicy;
    assertProviderCallActive(input.abortSignal, this.dependencies.createError);
    const semanticFailure = await this.dependencies.streamRuntime.finalizeSemanticDrafts(
      state,
      stage,
      toolCalls
    );
    if (semanticFailure) {
      deferProviderCommitEvents(state);
      queueProviderCommitEvents(state, providerCommitEvents);
      throw this.dependencies.createError(
        'native_tool_arguments_invalid',
        `${semanticFailure.failureCode}: ${semanticFailure.message}`
      );
    }
    if (languageDecisionAdmissible) {
      const responseLanguage = effectiveConversationLanguage(continuationLanguagePolicy);
      toolCalls = toolCalls.map((toolCall) => ({
        ...toolCall,
        arguments: {
          ...toolCall.arguments,
          responseLanguage,
        },
      }));
    }
    const deferProviderCommit = this.dependencies.streamRuntime.hasCurrentSemanticDraft(state) &&
      toolCalls.some((toolCall) => (
        toolCall.name === 'session.submit_answer' || toolCall.name === 'session.submit_plan'
      ));
    if (deferProviderCommit) {
      deferProviderCommitEvents(state);
      queueProviderCommitEvents(state, providerCommitEvents);
    } else if (providerCommitEvents.length > 0) {
      await ports.appendEvents(state.sessionId, providerCommitEvents);
    }
    if (!content.trim() && toolCalls.length === 0) {
      state.pendingProviderRetry = {
        attemptKind: 'emptyRetry',
        parentRequestId: effectiveAdmitted.requestId,
        reasonCode: 'llm_empty_response',
        rebaseFromFacts: false,
      };
      throw this.dependencies.createError('llm_empty_response', 'LLM provider returned an empty response.');
    }
    assertProviderCallActive(input.abortSignal, this.dependencies.createError);
    return {
      result: providerResult,
      providerAdmission: effectiveProviderAdmission,
      providerRequestId: effectiveAdmitted.requestId,
      // A stream fallback is a new physical request whose transport parent is
      // the failed stream request. The semantic continuation parent remains
      // the last successful request in the active tool chain.
      providerParentRequestId: semanticContinuationParentRequestId,
      continuationBaseMessages: activeContinuation
        ? activeContinuation.baseMessages.map(cloneLlmMessage)
        : continuation.restorationMessages.map(cloneLlmMessage),
      continuationBaseMessagesDigest: activeContinuation
        ? activeContinuation.baseMessagesDigest
        : providerContinuationBaseMessagesDigest(continuation.restorationMessages),
      sourceLanguagePolicy: cloneLanguagePolicy(continuationLanguagePolicy),
      assistantMessage: providerResult.assistantMessage
        ? cloneLlmMessage(providerResult.assistantMessage)
        : undefined,
      providerProfileId: providerResult.providerProfileId,
      provider: providerResult.provider,
      model: providerResult.model,
      content,
      reasoning,
      toolCalls,
    };
  }

  private async runProviderCallHook(state: TState): Promise<HookResult[]> {
    const frame = state.providerTurnFrame;
    if (!frame) return [];
    const snapshot = frame.snapshot ?? buildProviderTurnSnapshot(frame);
    const results = await this.dependencies.runHook?.({
      point: 'providerCall.before',
      sessionId: frame.sessionId,
      runId: frame.runId,
      contractId: frame.contractId,
      turnMode: frame.turnMode,
      allowedKinds: frame.allowedKinds,
      snapshot,
    }) ?? [];
    if (!frame.snapshot || results.length) {
      state.providerTurnFrame = {
        ...frame,
        snapshot,
        hookTrace: [
          ...(frame.hookTrace ?? []),
          ...results,
        ],
      };
    }
    return results;
  }

  private async registerProviderAdmission(
    state: TState,
    ports: ProviderTurnRunnerPorts<TState>,
    metadata: SessionProviderAdmissionMetadataV1
  ): Promise<void> {
    try {
      registerPendingProviderAdmission(state, metadata);
      await ports.registerProviderAdmission?.(state.sessionId, metadata);
    } catch (error) {
      if (error instanceof SessionFactLineageError) {
        throw this.dependencies.createError(error.code, error.message);
      }
      throw this.dependencies.createError(
        'session_provider_admission_write_failed',
        `Provider admission metadata could not be registered before transport: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async appendAnalysis(
    state: TState,
    ports: ProviderTurnRunnerPorts<TState>,
    entries: ProviderAnalysisTimelineEvent[]
  ): Promise<void> {
    if (!entries.length) return;
    if (!ports.appendAnalysisTimeline) {
      if (ports.analysisTimelineRequired) {
        throw this.dependencies.createError(
          'session_analysis_timeline_unavailable',
          'Provider admission requires the full analysis timeline storage port.'
        );
      }
      return;
    }
    try {
      const result = await ports.appendAnalysisTimeline(state.sessionId, entries);
      if (ports.analysisTimelineRequired) {
        const violation = providerAnalysisTimelineAckViolation(entries, result);
        if (violation) throw new Error(violation);
      }
    } catch (error) {
      throw this.dependencies.createError(
        'session_analysis_timeline_write_failed',
        `Provider analysis timeline append failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async appendWireRequest(
    state: TState,
    admitted: AdmittedProviderRequest,
    restorationMessages: LlmChatRequest['messages'],
    ports: ProviderTurnRunnerPorts<TState>
  ): Promise<void> {
    if (!state.promptLedger || !state.providerTurnFrame?.promptLedgerEpochId) return;
    const epoch = promptLedgerEpoch(state.promptLedger, state.providerTurnFrame.promptLedgerEpochId);
    if (!epoch) return;
    if (!ports.appendWireLedger) {
      if (ports.wireLedgerRequired) {
        throw this.dependencies.createError(
          'session_wire_ledger_unavailable',
          'Provider admission requires the durable wire ledger storage port.'
        );
      }
      return;
    }
    try {
      await ports.appendWireLedger(state.sessionId, [promptLedgerWireRequest({
      recordId: admitted.requestId,
      parentRequestId: admitted.parentRequestId,
      attemptKind: admitted.attemptKind,
      languageRevision: admitted.languageRevision,
      sessionId: state.sessionId,
      runId: state.runId,
      profileId: admitted.transportRequest.profileId ?? epoch.profileId,
      semanticProfileId: state.providerTurnFrame.snapshot?.semanticProfileId,
      epoch,
      messages: restorationMessages,
      timestamp: this.dependencies.now(),
      schemaHash: state.providerTurnFrame.snapshot?.toolSchemaHash,
      responseFormatHash: state.providerTurnFrame.snapshot?.responseFormatHash,
      providerPayloadDigest: admitted.providerPayloadDigest,
      transportDigest: admitted.transportDigest,
      digestMaterialScope: 'sessionAdmitted',
      messageMaterialScope: 'restorationBase',
      exactExternalWireBody: false,
      stream: admitted.transportRequest.stream === true,
      turnAuthority: state.userAuthorityFrame?.turnAuthority,
      promptSegmentDigests: admittedProviderCacheFacts(admitted, state).segments.map((segment) => ({
        id: segment.id,
        contentHash: segment.contentHash,
      })),
      })]);
    } catch (error) {
      throw this.dependencies.createError(
        'session_wire_ledger_write_failed',
        `Provider request baseline could not be persisted before transport: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

function stableMessageDigest(messages: LlmChatRequest['messages']): string {
  return providerContinuationBaseMessagesDigest(messages);
}

function cloneLanguagePolicy(
  policy: ConversationLanguagePolicy
): ConversationLanguagePolicy {
  return {
    ...policy,
    sourceMessageIds: [...policy.sourceMessageIds],
  };
}

function cloneLlmMessage(message: LlmChatMessage): LlmChatMessage {
  return {
    ...message,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((toolCall) => ({
            ...toolCall,
            arguments: cloneValue(toolCall.arguments),
          })),
        }
      : {}),
  };
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function collectReasoning(result: LlmChatResult): string {
  const chunks = result.chunks
    .filter((chunk) => chunk.type === 'reasoning_delta' && typeof chunk.content === 'string')
    .map((chunk) => chunk.content)
    .join('');
  return result.assistantMessage?.reasoningContent ?? chunks;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function providerThrownError(error: unknown): { error: string; message: string } {
  if (error instanceof Error) {
    const code = objectRecord(error)?.code;
    return {
      error: typeof code === 'string' && code.trim()
        ? code.trim()
        : error.name || 'Error',
      message: error.message || String(error),
    };
  }
  return {
    error: 'Error',
    message: String(error),
  };
}

function assertProviderCallActive(
  signal: AbortSignal | undefined,
  createError: (code: string, message: string) => Error
): void {
  const error = providerCallAbortError(signal, createError);
  if (error) throw error;
}

function providerCallAbortError(
  signal: AbortSignal | undefined,
  createError: (code: string, message: string) => Error
): Error | undefined {
  if (!signal?.aborted) return undefined;
  const reason = signal.reason;
  const record = objectRecord(reason);
  const code = typeof record?.code === 'string' && record.code.trim()
    ? record.code.trim()
    : 'session_provider_call_aborted';
  const message = reason instanceof Error && reason.message.trim()
    ? reason.message
    : 'Session Provider call was aborted before semantic admission.';
  return createError(code, message);
}

function isProviderCallAbortCode(code: string | undefined): boolean {
  return code === 'session_provider_deadline_exceeded'
    || code === 'session_provider_call_aborted';
}

function normalizeProviderResponseIdentity(
  result: LlmChatResult,
  admitted: AdmittedProviderRequest,
  required: boolean,
  createError: (code: string, message: string) => Error
): LlmChatResult {
  if (!result.requestId?.trim()) {
    if (required) {
      throw createError(
        'provider_request_identity_missing',
        `Provider response omitted requestId for ${admitted.requestId}.`
      );
    }
    return {
      ...result,
      requestId: admitted.requestId,
    };
  }
  if (result.requestId !== admitted.requestId) {
    throw createError(
      'provider_request_identity_mismatch',
      `Provider response requestId ${result.requestId} does not match ${admitted.requestId}.`
    );
  }
  return result;
}

function isProviderRequestIdentityError(code: string | undefined): boolean {
  return code === 'provider_request_identity_missing'
    || code === 'provider_request_identity_mismatch'
    || code === 'provider_request_identity_invalid'
    || code === 'provider_profile_identity_invalid';
}

function exactActiveProviderIdentity(
  active: ActiveProviderContinuation,
  requestedProfileId: string | undefined,
  required: boolean,
  createError: (code: string, message: string) => Error
): { profileId: string; provider: string; model: string } | undefined {
  const profileId = active.providerProfileId?.trim();
  const provider = active.provider?.trim();
  const model = active.model?.trim();
  if (!profileId || !provider || !model) {
    if (!required) return undefined;
    throw createError(
      'session_provider_continuation_invalid',
      'Active Provider continuation has no complete provider profile, provider, and model identity.'
    );
  }
  const requested = requestedProfileId?.trim();
  if (requested && requested !== profileId) {
    throw createError(
      'session_provider_continuation_invalid',
      `Active Provider continuation profile ${profileId} does not match requested profile ${requested}.`
    );
  }
  return { profileId, provider, model };
}

export function providerRequestCacheTopology(
  state: ProviderTurnRunnerState,
  admitted: AdmittedProviderRequest
): Record<string, unknown> {
  const transportProfileId = admitted.transportRequest.profileId;
  const profileId = transportProfileId ?? `unresolved:${admitted.requestId}`;
  const facts = admittedProviderCacheFacts(admitted, state);
  const messages = admitted.transportRequest.messages;
  const options = {
    responseFormat: admitted.transportRequest.responseFormat,
    tools: admitted.transportRequest.tools,
  };
  const requestText = providerRequestText(messages, options);
  const currentSegments = facts.segments.map((segment) => ({
    id: segment.id,
    contentHash: segment.contentHash,
  }));
  const history = state.providerRequestCacheHistory ?? {};
  const previous = history[profileId];
  const previousRequestText = previous?.exactMaterialAvailable === false
    ? undefined
    : previous?.requestText;
  const longestCommonPrefixCharLength = previousRequestText
    ? commonPrefixLength(previousRequestText, requestText)
    : undefined;
  const changedSegmentIds = previous?.exactMaterialAvailable === false
    ? undefined
    : previous
    ? changedSegments(previous.segments, currentSegments)
    : currentSegments.map((segment) => segment.id);
  return {
    requestId: admitted.requestId,
    languageRevision: admitted.languageRevision,
    transportProfileId,
    semanticProfileId: state.providerTurnFrame?.snapshot?.semanticProfileId,
    materialScope: 'sessionAdmitted',
    exactExternalWireBody: false,
    systemHash: facts.systemHash,
    toolSchemaHash: facts.toolSchemaHash,
    responseFormatHash: facts.responseFormatHash,
    messageShapeHash: facts.messageShapeHash,
    messagesDigest: facts.messagesDigest,
    cacheMaterialDigest: facts.cacheMaterialDigest,
    requestCharLength: requestText.length,
    longestCommonPrefixCharLength,
    longestCommonPrefixRatio: longestCommonPrefixCharLength !== undefined && requestText.length > 0
      ? longestCommonPrefixCharLength / requestText.length
      : undefined,
    comparisonStatus: previousRequestText
      ? 'exact'
      : previous?.exactMaterialAvailable === false
        ? previous.exactMaterialRedactionReason === 'privateReasoning'
          ? 'privateReasoningRedactedHistory'
          : 'restoredRedactedHistory'
        : !transportProfileId
          ? 'unresolvedTransportProfile'
        : 'noBaseline',
    baselineDisposition: previous?.disposition,
    changedSegmentIds,
  };
}

function commitProviderRequestCacheHistory(
  state: ProviderTurnRunnerState,
  admitted: AdmittedProviderRequest
): void {
  const profileId = admitted.transportRequest.profileId?.trim();
  if (!profileId) return;
  const facts = admittedProviderCacheFacts(admitted, state);
  const history = state.providerRequestCacheHistory ?? {};
  const privateReasoning = admitted.transportRequest.messages.some(
    (message) => message.reasoningContent !== undefined
  );
  history[profileId] = {
    requestText: privateReasoning
      ? undefined
      : providerRequestText(admitted.transportRequest.messages, {
        responseFormat: admitted.transportRequest.responseFormat,
        tools: admitted.transportRequest.tools,
      }),
    toolSchemaHash: facts.toolSchemaHash,
    responseFormatHash: facts.responseFormatHash,
    exactMaterialAvailable: !privateReasoning,
    exactMaterialRedactionReason: privateReasoning ? 'privateReasoning' : undefined,
    disposition: 'providerObserved',
    segments: facts.segments.map((segment) => ({
      id: segment.id,
      contentHash: segment.contentHash,
    })),
  };
  state.providerRequestCacheHistory = history;
}

interface AdmittedProviderCacheFacts {
  readonly cacheMaterialDigest: string;
  readonly messagesDigest: string;
  readonly systemHash: string;
  readonly toolSchemaHash: string;
  readonly responseFormatHash: string;
  readonly messageShapeHash: string;
  readonly stablePrefixHash: string;
  readonly dynamicSuffixHash: string;
  readonly finalUserPromptHash?: string;
  readonly finalUserPromptCharLength?: number;
  readonly segments: Array<{
    id: string;
    name: string;
    cacheClass: string;
    stablePrefix: boolean;
    contentHash: string;
    charLength: number;
  }>;
}

function admittedProviderCacheFacts(
  admitted: AdmittedProviderRequest,
  state: ProviderTurnRunnerState
): AdmittedProviderCacheFacts {
  const request = admitted.transportRequest;
  const systemMessages = request.messages.filter((message) => message.role === 'system');
  const stableSystemContent = state.providerTurnFrame?.prompt.stablePrefix;
  let physicalPrefixOpen = true;
  const messageCacheClasses = request.messages.map((message, index) => {
    const stableSystem = message.role === 'system' && (
      message.content === stableSystemContent
      || (
        index === 0
        && message.content === JSON_OBJECT_MODE_INSTRUCTION
        && request.responseFormat?.type === 'json_object'
      )
    );
    const stablePrefix = physicalPrefixOpen && stableSystem;
    if (!stablePrefix) physicalPrefixOpen = false;
    return { stableSystem, stablePrefix };
  });
  const stablePrefixMessages = request.messages.filter(
    (_message, index) => messageCacheClasses[index]?.stablePrefix
  );
  const dynamicMessages = request.messages.filter(
    (_message, index) => !messageCacheClasses[index]?.stablePrefix
  );
  const finalUser = [...request.messages].reverse().find((message) => message.role === 'user');
  const tools = providerVisibleTools(request.tools);
  const responseFormat = request.responseFormat ?? null;
  const cacheMaterial = providerRequestText(request.messages, {
    tools: request.tools,
    responseFormat: request.responseFormat,
  });
  const segments = request.messages.map((message, index) => {
    const messageClass = messageCacheClasses[index]!;
    const material = canonicalJson({
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      toolCalls: message.toolCalls ?? [],
      toolCallId: message.toolCallId,
    });
    return {
      id: `provider-message-${index}`,
      name: `providerMessage.${message.role}.${index}`,
      cacheClass: messageClass.stableSystem ? 'stableSystem' : 'dynamicMessage',
      stablePrefix: messageClass.stablePrefix,
      contentHash: stableHash(material),
      charLength: material.length,
    };
  });
  const toolsMaterial = canonicalJson(tools);
  const responseFormatMaterial = canonicalJson(responseFormat);
  segments.push({
    id: 'provider-tools',
    name: 'providerTools',
    cacheClass: 'stableTools',
    stablePrefix: true,
    contentHash: stableHash(toolsMaterial),
    charLength: toolsMaterial.length,
  });
  segments.push({
    id: 'provider-response-format',
    name: 'providerResponseFormat',
    cacheClass: 'stableResponseFormat',
    stablePrefix: true,
    contentHash: stableHash(responseFormatMaterial),
    charLength: responseFormatMaterial.length,
  });
  return {
    cacheMaterialDigest: stableHash(cacheMaterial),
    messagesDigest: stableMessageDigest(request.messages),
    systemHash: stableHash(canonicalJson(systemMessages)),
    toolSchemaHash: stableHash(toolsMaterial),
    responseFormatHash: stableHash(responseFormatMaterial),
    messageShapeHash: stableHash(JSON.stringify(request.messages.map((message) => ({
      role: message.role,
      hasReasoningContent: message.reasoningContent !== undefined,
      toolCallCount: message.toolCalls?.length ?? 0,
      hasToolCallId: message.toolCallId !== undefined,
    })))),
    stablePrefixHash: stableHash(canonicalJson({
      profileId: request.profileId ?? null,
      messages: stablePrefixMessages,
      tools,
      responseFormat,
    })),
    dynamicSuffixHash: stableHash(canonicalJson(dynamicMessages)),
    finalUserPromptHash: finalUser ? stableHash(finalUser.content) : undefined,
    finalUserPromptCharLength: finalUser?.content.length,
    segments,
  };
}

function providerRequestText(
  messages: LlmChatRequest['messages'],
  options: Pick<LlmChatRequest, 'responseFormat' | 'tools'>
): string {
  return canonicalJson({
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      toolCalls: message.toolCalls ?? [],
      toolCallId: message.toolCallId,
    })),
    tools: providerVisibleTools(options.tools),
    responseFormat: options.responseFormat ?? null,
  });
}

function providerVisibleTools(
  tools: LlmChatRequest['tools']
): Array<{ name: string; description: string; inputSchema: unknown }> {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

function changedSegments(
  previous: Array<{ id: string; contentHash: string }>,
  current: Array<{ id: string; contentHash: string }>
): string[] {
  const previousIndex = new Map(previous.map((entry) => [entry.id, entry.contentHash] as const));
  const currentIndex = new Map(current.map((entry) => [entry.id, entry.contentHash] as const));
  return [...new Set([...previousIndex.keys(), ...currentIndex.keys()])]
    .filter((id) => previousIndex.get(id) !== currentIndex.get(id))
    .sort();
}
