import type {
  AgentConversationActivity,
  AgentEvent,
  ApiResponse,
  LlmChatRequest,
  LlmChatResult,
  LlmChatStreamEvent,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ContextAssemblyRecord, PromptCachePlan } from '../../context/index.js';
import type { UserAuthorityFrame } from '../context/userAuthorityFrame.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import type { ProviderTraceRecorderPorts } from './providerTraceRecorder.js';
import type { ProviderJsonModeCoordinator } from './providerJsonModeCoordinator.js';
import type { ProviderStreamCoordinator, ProviderStreamVisibleLanguage } from './providerStreamCoordinator.js';
import type { ProviderStreamRuntime, ProviderStreamRuntimeState } from './providerStreamRuntime.js';
import type { ProviderTraceRecorder } from './providerTraceRecorder.js';
import type { HookInput, HookResult } from '../hooks/index.js';
import { buildProviderTurnSnapshot } from '../context/providerTurnSnapshot.js';
import { ProviderToolCallBuffer, stripProviderPartFrames, type NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import {
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
  providerAttemptKindForStage,
  type AdmittedProviderRequest,
} from './admittedProviderRequest.js';

export interface ProviderTurnRunnerState extends ProviderStreamRuntimeState {
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  providerTurnFrame?: DriverProviderTurnFrame;
  providerRequestCacheHistory?: Record<string, ProviderRequestCacheHistoryEntry>;
  promptLedger?: PromptLedgerState;
  userAuthorityFrame?: UserAuthorityFrame;
  pendingProviderCommitEvents?: AgentEvent[];
  providerCommitDeferred?: boolean;
}

export interface ProviderTurnResult {
  result: LlmChatResult;
  content: string;
  reasoning: string;
  toolCalls: NativeToolCallProposal[];
}

export interface ProviderTurnRunnerPorts extends ProviderTraceRecorderPorts {
  llmChat(request: LlmChatRequest): Promise<ApiResponse<LlmChatResult>>;
  llmChatStream?: (
    request: LlmChatRequest,
    onEvent: (event: LlmChatStreamEvent) => void | Promise<void>
  ) => Promise<ApiResponse<LlmChatResult>>;
  appendEvents(sessionId: string, events: AgentEvent[]): Promise<unknown>;
  appendWireLedger?: (sessionId: string, entries: PromptLedgerWireRecord[]) => Promise<void>;
  appendCacheTelemetry?: (sessionId: string, entry: Record<string, unknown>) => Promise<void>;
}

export interface ProviderTurnRunnerDependencies<TState extends ProviderTurnRunnerState> {
  jsonModeCoordinator: ProviderJsonModeCoordinator;
  streamCoordinator: ProviderStreamCoordinator;
  streamRuntime: ProviderStreamRuntime<TState>;
  traceRecorder: ProviderTraceRecorder;
  visibleLanguageForRequest(userRequest: string): ProviderStreamVisibleLanguage;
  providerActivity(input: {
    runId: string;
    userRequest: string;
    stage: string;
    status: 'running' | 'completed';
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
  reasoningEvent(sessionId: string, reasoning: string, ts: string, id: string): AgentEvent;
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
    ports: ProviderTurnRunnerPorts;
  }): Promise<ProviderTurnResult> {
    const options = input.options ?? {};
    const { state, stage, ports } = input;
    const jsonModeMessages = this.dependencies.jsonModeCoordinator.ensureMessages(input.messages, options.responseFormat);
    const providerCallHookTrace = await this.runProviderCallHook(state);
    const primaryRequestId = this.dependencies.createId(`provider-request-${stage}`);
    const primaryAdmitted = admitProviderRequest({
      requestId: primaryRequestId,
      attemptKind: providerAttemptKindForStage(stage),
      stage,
      transportRequest: {
        requestId: primaryRequestId,
        profileId: input.profileId,
        messages: jsonModeMessages,
        responseFormat: options.responseFormat,
        tools: options.tools,
        stream: Boolean(ports.llmChatStream),
        providerOptions: {
          deepcode: {
            cachePlan: state.cachePlan,
          },
        },
      },
    });
    let effectiveAdmitted = primaryAdmitted;
    const cacheTopology = providerRequestCacheTopology(
      state,
      primaryAdmitted.transportRequest.messages,
      requestOptions(primaryAdmitted)
    );
    await this.dependencies.traceRecorder.append(state, `${stage}.request`, {
      admittedRequest: admittedProviderRequestSnapshot(primaryAdmitted),
      profileId: primaryAdmitted.transportRequest.profileId,
      semanticProfileId: state.providerTurnFrame?.snapshot?.semanticProfileId,
      messages: primaryAdmitted.transportRequest.messages,
      cachePlan: state.cachePlan,
      contextAssembly: state.contextAssembly,
      providerTurnSnapshot: state.providerTurnFrame?.snapshot,
      hookTrace: [
        ...(state.providerTurnFrame?.hookTrace ?? []),
        ...providerCallHookTrace,
      ],
      responseFormat: primaryAdmitted.transportRequest.responseFormat,
      tools: primaryAdmitted.transportRequest.tools,
      cacheTopology,
      responseFormatAudit: this.dependencies.jsonModeCoordinator.audit(input.messages, options.responseFormat),
    }, ports);
    await this.dependencies.emitProjectionDelta(state, {
      type: 'active_turn',
      stage,
      status: ports.llmChatStream ? 'streaming' : 'running',
      channel: 'progress',
      source: 'session',
      summary: this.dependencies.streamCoordinator.stageSummary(stage, 'request', this.dependencies.visibleLanguageForRequest(state.userRequest)),
      activity: this.dependencies.providerActivity({ runId: state.runId, userRequest: state.userRequest, stage, status: 'running' }),
    });
    this.dependencies.streamRuntime.beginProviderCall(state, stage, primaryAdmitted.requestId);
    await this.appendWireRequest(state, primaryAdmitted, ports);
    const toolCallBuffer = this.dependencies.createToolCallBuffer();
    const reasoningBuffer = this.dependencies.streamRuntime.createReasoningBuffer();
    let result = ports.llmChatStream
      ? await ports.llmChatStream(primaryAdmitted.transportRequest, async (event) => {
        await this.dependencies.streamRuntime.handleEvent({
          state,
          stage,
          event,
          toolCallBuffer,
          reasoningBuffer,
        });
      })
      : await ports.llmChat(primaryAdmitted.transportRequest);
    await this.dependencies.streamRuntime.flushReasoningBuffer(state, stage, reasoningBuffer);
    if (ports.llmChatStream && (!result.ok || !result.data)) {
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
      if (isProviderRequestIdentityError(result.error)) {
        throw this.dependencies.createError(
          result.error ?? 'provider_request_identity_invalid',
          result.message ?? 'Provider request identity validation failed.'
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
        attemptKind: 'streamFallback',
        stage: `${stage}.streamFallback`,
        transportRequest: {
          ...primaryAdmitted.transportRequest,
          requestId: fallbackRequestId,
          parentRequestId: primaryAdmitted.requestId,
          stream: false,
        },
      });
      effectiveAdmitted = fallbackAdmitted;
      this.dependencies.streamRuntime.beginProviderCall(state, stage, fallbackAdmitted.requestId);
      await this.dependencies.traceRecorder.append(state, `${stage}.stream_fallback.request`, {
        reason: result.message ?? result.error ?? 'streaming provider request failed',
        admittedRequest: admittedProviderRequestSnapshot(fallbackAdmitted),
        request: fallbackAdmitted.transportRequest,
      }, ports);
      await this.appendWireRequest(state, fallbackAdmitted, ports);
      result = await ports.llmChat(fallbackAdmitted.transportRequest);
    }
    if (!result.ok || !result.data) {
      await this.dependencies.emitProjectionDelta(state, {
        type: 'error',
        stage,
        status: 'failed',
        channel: 'progress',
        source: 'provider',
        summary: result.message ?? result.error ?? 'LLM provider request failed.',
      });
      throw this.dependencies.createError(
        'llm_chat_failed',
        result.message ?? result.error ?? 'LLM provider request failed.'
      );
    }
    ensureProviderResponseIdentity(result.data, effectiveAdmitted, this.dependencies.createError);
    const usage = objectRecord(result.data.usage);
    const cacheEvent = this.dependencies.cacheTelemetryEvent({
      sessionId: state.sessionId,
      profileId: result.data.providerProfileId ?? input.profileId,
      provider: result.data.provider ?? state.contextAssembly?.provider,
      model: result.data.model ?? state.contextAssembly?.model,
      stage,
      usage,
      promptSegmentDigests: [
        ...(state.contextAssembly?.segments.map((segment): Record<string, unknown> => ({
          id: segment.id,
          name: segment.name,
          cacheClass: segment.cacheClass,
          stablePrefix: segment.stablePrefix,
          auditOnly: segment.auditOnly,
          contentHash: segment.contentHash,
          charLength: segment.charLength,
        })) ?? []),
        {
          id: 'provider-request-topology',
          name: 'providerRequestTopology',
          cacheClass: 'providerRequest',
          stablePrefix: false,
          auditOnly: true,
          ...cacheTopology,
        },
      ],
      // Request telemetry hashes the rendered provider frame, not the provider-scoped assembly cache key.
      stablePrefixHash: state.providerTurnFrame?.snapshot?.stablePrefixHash,
      dynamicSuffixHash: state.providerTurnFrame?.snapshot?.dynamicSuffixHash,
      finalUserPromptHash: state.providerTurnFrame?.snapshot?.finalUserPromptHash,
      finalUserPromptCharLength: state.providerTurnFrame?.snapshot?.finalUserPromptCharLength,
      cacheHash: state.contextAssembly?.cacheHash,
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
        providerPayloadDigest: effectiveAdmitted.providerPayloadDigest,
        transportDigest: effectiveAdmitted.transportDigest,
        sessionId: state.sessionId,
        runId: state.runId,
        providerProfileId: result.data.providerProfileId ?? input.profileId,
        provider: result.data.provider ?? state.contextAssembly?.provider,
        model: result.data.model ?? state.contextAssembly?.model,
        stage,
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
    await this.dependencies.traceRecorder.append(state, `${stage}.response`, result.data, ports);
    const reasoning = collectReasoning(result.data);
    if (reasoning.trim() && this.dependencies.streamCoordinator.exposesReasoningTrace(stage)) {
      providerCommitEvents.push(
        this.dependencies.reasoningEvent(state.sessionId, reasoning, this.dependencies.now(), this.dependencies.createId(`reasoning-${stage}`)),
      );
    }
    await this.dependencies.emitProjectionDelta(state, {
      type: 'active_turn',
      stage,
      status: 'completed',
      channel: 'progress',
      source: 'provider',
      summary: this.dependencies.streamCoordinator.stageSummary(stage, 'response', this.dependencies.visibleLanguageForRequest(state.userRequest)),
      activity: this.dependencies.providerActivity({ runId: state.runId, userRequest: state.userRequest, stage, status: 'completed' }),
    });
    const content = stripProviderPartFrames(result.data.assistantMessage?.content
      ?? result.data.chunks
        .filter((chunk) => chunk.type === 'delta' && typeof chunk.content === 'string')
        .map((chunk) => chunk.content)
        .join(''));
    let toolCalls: NativeToolCallProposal[];
    try {
      toolCalls = this.dependencies.collectToolCalls(result.data, toolCallBuffer);
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
      throw this.dependencies.createError('llm_empty_response', 'LLM provider returned an empty response.');
    }
    return {
      result: result.data,
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

  private async appendWireRequest(
    state: TState,
    admitted: AdmittedProviderRequest,
    ports: ProviderTurnRunnerPorts
  ): Promise<void> {
    if (!state.promptLedger || !state.providerTurnFrame?.promptLedgerEpochId) return;
    const epoch = promptLedgerEpoch(state.promptLedger, state.providerTurnFrame.promptLedgerEpochId);
    if (!epoch) return;
    await ports.appendWireLedger?.(state.sessionId, [promptLedgerWireRequest({
      recordId: admitted.requestId,
      parentRequestId: admitted.parentRequestId,
      attemptKind: admitted.attemptKind,
      sessionId: state.sessionId,
      runId: state.runId,
      profileId: admitted.transportRequest.profileId ?? epoch.profileId,
      semanticProfileId: state.providerTurnFrame.snapshot?.semanticProfileId,
      epoch,
      messages: admitted.transportRequest.messages,
      timestamp: this.dependencies.now(),
      schemaHash: state.providerTurnFrame.snapshot?.toolSchemaHash,
      responseFormatHash: state.providerTurnFrame.snapshot?.responseFormatHash,
      providerPayloadDigest: admitted.providerPayloadDigest,
      transportDigest: admitted.transportDigest,
      stream: admitted.transportRequest.stream === true,
      turnAuthority: state.userAuthorityFrame?.turnAuthority,
      promptSegmentDigests: state.contextAssembly?.segments.map((segment) => ({
        id: segment.id,
        contentHash: segment.contentHash,
      })),
    })]).catch(() => undefined);
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

function requestOptions(
  admitted: AdmittedProviderRequest
): Pick<LlmChatRequest, 'responseFormat' | 'tools'> {
  return {
    responseFormat: admitted.transportRequest.responseFormat,
    tools: admitted.transportRequest.tools,
  };
}

function ensureProviderResponseIdentity(
  result: LlmChatResult,
  admitted: AdmittedProviderRequest,
  createError: (code: string, message: string) => Error
): void {
  if (!result.requestId?.trim()) {
    throw createError(
      'provider_request_identity_missing',
      `Provider response omitted requestId for ${admitted.requestId}.`
    );
  }
  if (result.requestId !== admitted.requestId) {
    throw createError(
      'provider_request_identity_mismatch',
      `Provider response requestId ${result.requestId} does not match ${admitted.requestId}.`
    );
  }
}

function isProviderRequestIdentityError(code: string | undefined): boolean {
  return code === 'provider_request_identity_missing'
    || code === 'provider_request_identity_mismatch'
    || code === 'provider_request_identity_invalid';
}

export function providerRequestCacheTopology(
  state: ProviderTurnRunnerState,
  messages: LlmChatRequest['messages'],
  options: Pick<LlmChatRequest, 'responseFormat' | 'tools'>
): Record<string, unknown> {
  const profileId = state.providerTurnFrame?.snapshot?.semanticProfileId ?? 'unknown';
  const requestText = providerRequestText(messages, options);
  const currentSegments = (
    state.providerTurnFrame?.snapshot?.segments
    ?? state.contextAssembly?.segments
    ?? []
  ).map((segment) => ({
    id: segment.id,
    contentHash: segment.contentHash,
  }));
  const history = state.providerRequestCacheHistory ?? {};
  const previous = history[profileId];
  const previousRequestText = previous?.requestText
    ?? comparablePreviousRequestText(previous, state, options);
  const longestCommonPrefixCharLength = previousRequestText
    ? commonPrefixLength(previousRequestText, requestText)
    : 0;
  const changedSegmentIds = previous
    ? changedSegments(previous.segments, currentSegments)
    : currentSegments.map((segment) => segment.id);
  history[profileId] = {
    requestText,
    messages: messages.map((message) => JSON.parse(JSON.stringify(message)) as LlmChatRequest['messages'][number]),
    toolSchemaHash: state.providerTurnFrame?.snapshot?.toolSchemaHash,
    responseFormatHash: state.providerTurnFrame?.snapshot?.responseFormatHash,
    segments: currentSegments,
  };
  state.providerRequestCacheHistory = history;
  return {
    semanticProfileId: profileId,
    systemHash: state.providerTurnFrame?.snapshot?.systemHash,
    toolSchemaHash: state.providerTurnFrame?.snapshot?.toolSchemaHash,
    responseFormatHash: state.providerTurnFrame?.snapshot?.responseFormatHash,
    messageShapeHash: state.providerTurnFrame?.snapshot?.messageShapeHash,
    requestCharLength: requestText.length,
    longestCommonPrefixCharLength,
    longestCommonPrefixRatio: previousRequestText && requestText.length > 0
      ? longestCommonPrefixCharLength / requestText.length
      : 0,
    changedSegmentIds,
  };
}

function providerRequestText(
  messages: LlmChatRequest['messages'],
  options: Pick<LlmChatRequest, 'responseFormat' | 'tools'>
): string {
  return JSON.stringify({
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls ?? [],
      toolCallId: message.toolCallId,
    })),
    tools: options.tools?.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })) ?? [],
    responseFormat: options.responseFormat ?? null,
  });
}

function comparablePreviousRequestText(
  previous: ProviderRequestCacheHistoryEntry | undefined,
  state: ProviderTurnRunnerState,
  options: Pick<LlmChatRequest, 'responseFormat' | 'tools'>
): string | undefined {
  if (!previous?.messages?.length) return undefined;
  const snapshot = state.providerTurnFrame?.snapshot;
  if (previous.toolSchemaHash && previous.toolSchemaHash !== snapshot?.toolSchemaHash) return undefined;
  if (previous.responseFormatHash && previous.responseFormatHash !== snapshot?.responseFormatHash) return undefined;
  return providerRequestText(previous.messages, options);
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
