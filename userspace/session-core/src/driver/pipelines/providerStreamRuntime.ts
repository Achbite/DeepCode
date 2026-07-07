import type {
  AgentConversationActivity,
  AgentStreamPartFrame,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatResult,
  LlmChatStreamEvent,
  ProjectionDelta,
} from '@deepcode/protocol';
import { ProviderPartFrameParser, type ProviderToolCallBuffer } from '../../provider/providerStreamParts.js';
import type { ProviderStreamCoordinator, ProviderStreamVisibleLanguage } from './providerStreamCoordinator.js';
import { SessionDriverActiveTurnRuntimeAccessor } from '../runFrame.js';

export interface ProviderStreamRuntimeActiveTurn {
  turnId: string;
  seq: number;
  stage: string;
  providerJsonStreamProgress?: Record<string, { receivedChars: number; lastEmittedChars: number }>;
  partFrameParser?: ProviderPartFrameParser;
}

export interface ProviderStreamRuntimeState {
  sessionId: string;
  runId: string;
  userRequest: string;
  activeTurn?: ProviderStreamRuntimeActiveTurn;
}

export interface ProviderReasoningDeltaBuffer {
  pending: string;
  lastFlushAt: number;
  itemId?: string;
}

export interface ProviderStreamRuntimeDependencies<TState extends ProviderStreamRuntimeState> {
  reasoningFlushChars: number;
  reasoningFlushMs: number;
  streamCoordinator: ProviderStreamCoordinator;
  visibleLanguageForRequest(userRequest: string): ProviderStreamVisibleLanguage;
  providerActivity(input: {
    runId: string;
    userRequest: string;
    stage: string;
    status: 'running' | 'completed';
  }): AgentConversationActivity;
  conversationActivity(input: AgentConversationActivity): AgentConversationActivity;
  emitProjectionDelta(state: TState, delta: Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>): Promise<void>;
  kernelCommand(request: KernelCommandEnvelope): Promise<KernelReply>;
  createId(prefix: string): string;
}

export class ProviderStreamRuntime<TState extends ProviderStreamRuntimeState> {
  constructor(private readonly dependencies: ProviderStreamRuntimeDependencies<TState>) {}

  createReasoningBuffer(): ProviderReasoningDeltaBuffer {
    return {
      pending: '',
      lastFlushAt: Date.now(),
      itemId: undefined,
    };
  }

  async handleEvent(input: {
    state: TState;
    stage: string;
    event: LlmChatStreamEvent;
    toolCallBuffer: ProviderToolCallBuffer;
    reasoningBuffer: ProviderReasoningDeltaBuffer;
  }): Promise<void> {
    const { state, stage, event, toolCallBuffer, reasoningBuffer } = input;
    const chunk = event.chunk;
    if (event.type === 'provider_delta' && chunk?.content) {
      const frames = this.consumeProviderPartFrames(state, stage, chunk.content);
      for (const frame of frames) {
        await this.submitProviderPartFrame(state, stage, frame);
      }
      if (this.dependencies.streamCoordinator.exposesAssistantDelta(stage)) {
        await this.dependencies.emitProjectionDelta(state, {
          type: 'assistant_delta',
          stage,
          status: 'streaming',
          channel: 'final',
          source: 'provider',
          itemId: chunk.callId,
          delta: chunk.content,
          payload: chunk.rawProvider,
        });
      } else if (this.dependencies.streamCoordinator.emitsJsonProgress(stage)) {
        await this.emitProviderJsonStreamProgress(state, stage, chunk.content);
      }
      return;
    }
    if (event.type === 'provider_reasoning_delta' && chunk?.content) {
      await this.bufferProviderReasoningDelta(state, stage, reasoningBuffer, chunk);
      return;
    }
    if (event.type === 'provider_tool_call_delta' && chunk) {
      const language = this.dependencies.visibleLanguageForRequest(state.userRequest);
      toolCallBuffer.addChunk(chunk);
      const summary = chunk.toolCallDelta?.name
        ? this.dependencies.streamCoordinator.toolCallPreparingSummary(chunk.toolCallDelta.name, language)
        : this.dependencies.streamCoordinator.toolCallStreamingSummary(language);
      await this.dependencies.emitProjectionDelta(state, {
        type: 'tool_call_delta',
        stage,
        status: 'streaming',
        channel: 'tool',
        source: 'provider',
        itemId: chunk.callId ?? String(chunk.index ?? 0),
        delta: chunk.toolCallDelta?.argumentsDelta,
        summary,
        activity: this.dependencies.conversationActivity({
          activityId: `provider-tool-${chunk.callId ?? chunk.index ?? 0}`,
          kind: 'toolExecution',
          status: 'running',
          title: 'Provider tool call',
          summary,
          source: 'provider',
          runId: state.runId,
          toolName: chunk.toolCallDelta?.name,
        }),
        payload: {
          index: chunk.index,
          callId: chunk.callId,
          finishReason: chunk.finishReason,
          toolCallDelta: chunk.toolCallDelta,
          rawProvider: chunk.rawProvider,
        },
      });
      return;
    }
    if (event.type === 'provider_usage') {
      await this.dependencies.emitProjectionDelta(state, {
        type: 'stage_delta',
        stage,
        status: 'running',
        channel: 'progress',
        source: 'provider',
        summary: this.dependencies.streamCoordinator.usageSummary(this.dependencies.visibleLanguageForRequest(state.userRequest)),
        payload: event.usage ?? chunk?.usage,
      });
      return;
    }
    if (event.type === 'provider_error') {
      const summary = event.error ?? chunk?.error ?? 'Provider stream error.';
      await this.dependencies.emitProjectionDelta(state, {
        type: 'error',
        stage,
        status: 'failed',
        channel: 'progress',
        source: 'provider',
        summary,
        activity: this.dependencies.conversationActivity({
          activityId: `provider-${stage}-stream-error`,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Provider stream error',
          summary,
          source: 'provider',
          runId: state.runId,
        }),
        payload: event.rawProvider ?? chunk?.rawProvider,
      });
    }
  }

  async flushReasoningBuffer(
    state: TState,
    stage: string,
    buffer: ProviderReasoningDeltaBuffer
  ): Promise<void> {
    if (!buffer.pending) return;
    const delta = buffer.pending;
    buffer.pending = '';
    buffer.lastFlushAt = Date.now();
    await this.dependencies.emitProjectionDelta(state, {
      type: 'reasoning_delta',
      stage,
      status: 'streaming',
      channel: 'reasoning',
      source: 'provider',
      itemId: buffer.itemId,
      delta,
      activity: this.dependencies.providerActivity({ runId: state.runId, userRequest: state.userRequest, stage, status: 'running' }),
      payload: {
        presentation: 'reasoningTrace',
        streamMode: 'markdownBlocks',
        buffered: true,
      },
    });
  }

  private async bufferProviderReasoningDelta(
    state: TState,
    stage: string,
    buffer: ProviderReasoningDeltaBuffer,
    chunk: LlmChatResult['chunks'][number]
  ): Promise<void> {
    if (typeof chunk.content !== 'string' || chunk.content.length === 0) return;
    buffer.pending += chunk.content;
    buffer.itemId = chunk.callId ?? buffer.itemId;
    const now = Date.now();
    if (
      buffer.pending.length < this.dependencies.reasoningFlushChars &&
      now - buffer.lastFlushAt < this.dependencies.reasoningFlushMs
    ) {
      return;
    }
    await this.flushReasoningBuffer(state, stage, buffer);
  }

  private async emitProviderJsonStreamProgress(
    state: TState,
    stage: string,
    content: string
  ): Promise<void> {
    const activeTurn = new SessionDriverActiveTurnRuntimeAccessor(state).ensure(
      stage,
      (prefix) => this.dependencies.createId(prefix)
    );
    activeTurn.providerJsonStreamProgress ??= {};
    const progress = activeTurn.providerJsonStreamProgress[stage] ?? {
      receivedChars: 0,
      lastEmittedChars: 0,
    };
    progress.receivedChars += content.length;
    activeTurn.providerJsonStreamProgress[stage] = progress;

    const shouldEmit = progress.lastEmittedChars === 0 ||
      progress.receivedChars - progress.lastEmittedChars >= 1_500;
    if (!shouldEmit) return;
    progress.lastEmittedChars = progress.receivedChars;
    const language = this.dependencies.visibleLanguageForRequest(state.userRequest);
    const summary = this.dependencies.streamCoordinator.jsonProgressSummary(language, progress.receivedChars);
    await this.dependencies.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage,
      status: 'streaming',
      channel: 'progress',
      source: 'session',
      itemId: `${stage}-provider-json-progress`,
      summary,
      activity: this.dependencies.providerActivity({ runId: state.runId, userRequest: state.userRequest, stage, status: 'running' }),
      payload: {
        stage,
        receivedChars: progress.receivedChars,
        rawJsonHidden: true,
        reason: 'proposal_json_stream_hidden_from_assistant',
      },
    });
  }

  private consumeProviderPartFrames(
    state: TState,
    stage: string,
    content: string
  ): AgentStreamPartFrame[] {
    const activeTurn = new SessionDriverActiveTurnRuntimeAccessor(state).ensure(
      stage,
      (prefix) => this.dependencies.createId(prefix)
    );
    activeTurn.partFrameParser ??= new ProviderPartFrameParser();
    return activeTurn.partFrameParser.push(content);
  }

  private async submitProviderPartFrame(
    state: TState,
    stage: string,
    frame: AgentStreamPartFrame
  ): Promise<void> {
    const enrichedFrame = {
      ...frame,
      draftId: frame.draftId,
      targetPath: frame.targetPath,
    };
    await this.dependencies.emitProjectionDelta(state, {
      type: 'part_delta',
      stage,
      status: 'streaming',
      channel: enrichedFrame.partKind === 'thinkingDelta' ? 'reasoning' : 'draft',
      source: 'session',
      itemId: enrichedFrame.frameId ?? enrichedFrame.draftId,
      draftId: enrichedFrame.draftId,
      targetPath: enrichedFrame.targetPath,
      delta: enrichedFrame.chunk,
      summary: enrichedFrame.summary ?? `Provider stream part: ${enrichedFrame.partKind}`,
      payload: enrichedFrame,
    });

    const reply = await this.dependencies.kernelCommand({
      requestId: this.dependencies.createId('draft-ledger-submit'),
      command: {
        kind: 'draftLedgerSubmit',
        requestId: this.dependencies.createId('draft-ledger'),
        runId: state.runId,
        sessionId: state.sessionId,
        frame: {
          ...enrichedFrame,
          runId: enrichedFrame.runId ?? state.runId,
        },
      },
    });
    if (!reply.ok) {
      await this.dependencies.emitProjectionDelta(state, {
        type: 'error',
        stage,
        status: 'failed',
        channel: 'draft',
        source: 'kernel',
        itemId: enrichedFrame.frameId ?? enrichedFrame.draftId,
        draftId: enrichedFrame.draftId,
        targetPath: enrichedFrame.targetPath,
        summary: reply.error?.message ?? 'Kernel draft ledger rejected provider stream part.',
        payload: reply.error,
      });
      return;
    }
    for (const event of reply.events) {
      const record = objectRecord(event);
      await this.dependencies.emitProjectionDelta(state, {
        type: 'draft_delta',
        stage,
        status: 'streaming',
        channel: 'draft',
        source: 'kernel',
        itemId: stringValue(record?.draftId) ?? enrichedFrame.draftId,
        draftId: stringValue(record?.draftId) ?? enrichedFrame.draftId,
        targetPath: enrichedFrame.targetPath,
        summary: stringValue(record?.summary) ?? stringValue(objectRecord(record?.draft)?.summary),
        payload: event,
      });
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
