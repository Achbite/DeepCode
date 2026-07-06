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
import type { ProviderTraceRecorderPorts } from './providerTraceRecorder.js';
import type { ProviderJsonModeCoordinator } from './providerJsonModeCoordinator.js';
import type { ProviderStreamCoordinator, ProviderStreamVisibleLanguage } from './providerStreamCoordinator.js';
import type { ProviderStreamRuntime, ProviderStreamRuntimeState } from './providerStreamRuntime.js';
import type { ProviderTraceRecorder } from './providerTraceRecorder.js';
import { ProviderToolCallBuffer, stripProviderPartFrames, type NativeToolCallProposal } from '../../provider/providerStreamParts.js';

export interface ProviderTurnRunnerState extends ProviderStreamRuntimeState {
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
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
    cacheHash?: string;
    ts: string;
    id: string;
  }): AgentEvent | null | undefined;
  reasoningEvent(sessionId: string, reasoning: string, ts: string, id: string): AgentEvent;
  createToolCallBuffer(): ProviderToolCallBuffer;
  collectToolCalls(result: LlmChatResult, buffer: ProviderToolCallBuffer): NativeToolCallProposal[];
  nativeToolError(error: unknown): { code: string; message: string } | undefined;
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
    await this.dependencies.traceRecorder.append(state, `${stage}.request`, {
      profileId: input.profileId,
      messages: jsonModeMessages,
      cachePlan: state.cachePlan,
      contextAssembly: state.contextAssembly,
      responseFormat: options.responseFormat,
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
    const request: LlmChatRequest = {
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
    };
    const toolCallBuffer = this.dependencies.createToolCallBuffer();
    const reasoningBuffer = this.dependencies.streamRuntime.createReasoningBuffer();
    let result = ports.llmChatStream
      ? await ports.llmChatStream(request, async (event) => {
        await this.dependencies.streamRuntime.handleEvent({
          state,
          stage,
          event,
          toolCallBuffer,
          reasoningBuffer,
        });
      })
      : await ports.llmChat(request);
    await this.dependencies.streamRuntime.flushReasoningBuffer(state, stage, reasoningBuffer);
    if (ports.llmChatStream && (!result.ok || !result.data)) {
      const fallbackRequest: LlmChatRequest = { ...request, stream: false };
      await this.dependencies.traceRecorder.append(state, `${stage}.stream_fallback.request`, {
        reason: result.message ?? result.error ?? 'streaming provider request failed',
        request: fallbackRequest,
      }, ports);
      result = await ports.llmChat(fallbackRequest);
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
    const usage = objectRecord(result.data.usage);
    const cacheEvent = this.dependencies.cacheTelemetryEvent({
      sessionId: state.sessionId,
      profileId: input.profileId,
      provider: state.contextAssembly?.provider,
      model: state.contextAssembly?.model,
      stage,
      usage,
      promptSegmentDigests: state.contextAssembly?.segments.map((segment) => ({
        id: segment.id,
        name: segment.name,
        cacheClass: segment.cacheClass,
        stablePrefix: segment.stablePrefix,
        auditOnly: segment.auditOnly,
        contentHash: segment.contentHash,
        charLength: segment.charLength,
      })) ?? [],
      stablePrefixHash: state.contextAssembly?.stablePrefixHash,
      dynamicSuffixHash: state.contextAssembly?.dynamicSuffixHash,
      cacheHash: state.contextAssembly?.cacheHash,
      ts: this.dependencies.now(),
      id: this.dependencies.createId(`cache-${stage}`),
    });
    if (cacheEvent) {
      await ports.appendEvents(state.sessionId, [cacheEvent]);
    }
    await this.dependencies.traceRecorder.append(state, `${stage}.response`, result.data, ports);
    const reasoning = collectReasoning(result.data);
    if (reasoning.trim()) {
      await ports.appendEvents(state.sessionId, [
        this.dependencies.reasoningEvent(state.sessionId, reasoning, this.dependencies.now(), this.dependencies.createId(`reasoning-${stage}`)),
      ]);
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
        throw this.dependencies.createError(nativeToolError.code, nativeToolError.message);
      }
      throw error;
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
