import type {
  AgentConversationActivity,
  AgentStreamPartFrame,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatResult,
  LlmChatStreamEvent,
  ProjectionDelta,
  SessionSemanticDraftPayload,
} from '@deepcode/protocol';
import {
  ProviderPartFrameParser,
  type NativeToolCallProposal,
  type ProviderToolCallBuffer,
} from '../../provider/providerStreamParts.js';
import {
  decodeSessionSemanticDraft,
  isSessionSemanticDraftToolName,
  normalizeSessionSemanticDraftToolName,
  validateSessionSemanticDraftFinal,
  type DecodedSessionSemanticDraft,
  type SessionSemanticDraftDecodeFailure,
  type SessionSemanticDraftStreamRecord,
} from '../../provider/SessionSemanticDraftDecoder.js';
import type { ProviderStreamCoordinator, ProviderStreamVisibleLanguage } from './providerStreamCoordinator.js';
import { SessionDriverActiveTurnRuntimeAccessor } from '../runFrame.js';
import { VISIBLE_REASONING_MAX_CHARS, projectVisibleReasoning } from '../projection/index.js';
import { stableHash } from '../../cache/canonicalizer.js';

export interface ProviderStreamRuntimeActiveTurn {
  turnId: string;
  seq: number;
  stage: string;
  providerJsonStreamProgress?: Record<string, { receivedChars: number; lastEmittedChars: number }>;
  partFrameParser?: ProviderPartFrameParser;
  submittedPartFrames?: Record<string, true>;
  providerCallId?: string;
  semanticDrafts?: Record<string, SessionSemanticDraftStreamRecord>;
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
  receivedChars: number;
  visibleCharsEmitted: number;
  truncated: boolean;
}

export interface ProviderStreamRuntimeDependencies<TState extends ProviderStreamRuntimeState> {
  reasoningFlushChars: number;
  reasoningFlushMs: number;
  semanticDraftFlushChars?: number;
  semanticDraftFlushMs?: number;
  semanticDraftMaxChars?: number;
  visibleReasoningMaxChars?: number;
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

  beginProviderCall(state: TState, stage: string, providerCallId: string): void {
    const activeTurn = new SessionDriverActiveTurnRuntimeAccessor(state).ensure(
      stage,
      (prefix) => this.dependencies.createId(prefix)
    );
    activeTurn.providerCallId = providerCallId;
    activeTurn.semanticDrafts ??= {};
  }

  hasCurrentSemanticDraft(state: TState): boolean {
    return this.currentSemanticDrafts(state).some((record) => (
      Boolean(record.callId) &&
      isSessionSemanticDraftToolName(normalizeSessionSemanticDraftToolName(record.toolName)) &&
      !record.discarded
    ));
  }

  createReasoningBuffer(): ProviderReasoningDeltaBuffer {
    return {
      pending: '',
      lastFlushAt: Date.now(),
      itemId: this.dependencies.createId('reasoning-segment'),
      receivedChars: 0,
      visibleCharsEmitted: 0,
      truncated: false,
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
      if (!this.dependencies.streamCoordinator.exposesReasoningTrace(stage)) return;
      await this.bufferProviderReasoningDelta(state, stage, reasoningBuffer, chunk);
      return;
    }
    if (event.type === 'provider_tool_call_delta' && chunk) {
      // Preserve the provider's visible order: publish any buffered reasoning
      // before the following structured tool activity receives its sequence.
      await this.flushReasoningBuffer(state, stage, reasoningBuffer);
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
      await this.updateSemanticDraft(state, stage, chunk);
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
      await this.discardCurrentSemanticDrafts(state, stage, 'semantic_draft_provider_error');
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
    const projected = this.projectReasoningDelta(delta, buffer);
    if (!projected.content) return;
    buffer.visibleCharsEmitted += projected.content.length;
    buffer.truncated = buffer.truncated || projected.truncated;
    await this.dependencies.emitProjectionDelta(state, {
      type: 'reasoning_delta',
      stage,
      status: 'streaming',
      channel: 'reasoning',
      source: 'provider',
      itemId: buffer.itemId,
      delta: projected.content,
      activity: this.dependencies.providerActivity({ runId: state.runId, userRequest: state.userRequest, stage, status: 'running' }),
      payload: {
        presentation: 'reasoningTrace',
        streamMode: 'markdownBlocks',
        buffered: true,
        reasoningProjectionTruncated: buffer.truncated,
        reasoningProjectionFullCharLength: buffer.receivedChars,
        reasoningProjectionVisibleCharLength: buffer.visibleCharsEmitted,
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
    buffer.receivedChars += chunk.content.length;
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

  private projectReasoningDelta(delta: string, buffer: ProviderReasoningDeltaBuffer): { content: string; truncated: boolean } {
    const maxChars = this.dependencies.visibleReasoningMaxChars ?? VISIBLE_REASONING_MAX_CHARS;
    if (!Number.isFinite(maxChars) || maxChars <= 0) {
      return { content: delta, truncated: false };
    }
    const remaining = maxChars - buffer.visibleCharsEmitted;
    if (remaining <= 0) {
      return { content: '', truncated: true };
    }
    const projected = projectVisibleReasoning(delta, remaining);
    return {
      content: projected.content,
      truncated: projected.truncated,
    };
  }

  async flushCurrentSemanticDrafts(state: TState, stage: string): Promise<void> {
    for (const record of this.currentSemanticDrafts(state)) {
      await this.publishSemanticDraft(state, stage, record, true);
    }
  }

  async finalizeSemanticDrafts(
    state: TState,
    stage: string,
    toolCalls: NativeToolCallProposal[]
  ): Promise<SessionSemanticDraftDecodeFailure | undefined> {
    for (const toolCall of toolCalls) {
      if (!isSessionSemanticDraftToolName(toolCall.name)) continue;
      const record = this.semanticDraftForToolCall(state, toolCall);
      if (!record) continue;
      if (record.failed) {
        return {
          failureCode: record.failed,
          message: 'The semantic draft stream was already marked invalid.',
        };
      }
      const decoded = decodeSessionSemanticDraft(record.rawArguments, toolCall.name);
      if (!decoded.ok) {
        await this.failSemanticDraftRecord(state, stage, record, decoded.failure.failureCode);
        return decoded.failure;
      }
      record.latest = decoded.draft;
      await this.publishSemanticDraft(state, stage, record, true);
      const finalFailure = validateSessionSemanticDraftFinal(decoded.draft, toolCall.arguments);
      if (finalFailure) {
        await this.failSemanticDraftRecord(state, stage, record, finalFailure.failureCode);
        return finalFailure;
      }
    }
    return undefined;
  }

  async failSemanticDraft(
    state: TState,
    stage: string,
    callId: string | undefined,
    failureCode: string
  ): Promise<void> {
    const candidates = callId
      ? Object.values(this.semanticDrafts(state)).filter((record) => record.callId === callId)
      : this.currentSemanticDrafts(state);
    for (const record of candidates) {
      await this.failSemanticDraftRecord(state, stage, record, failureCode);
    }
  }

  async discardCurrentSemanticDrafts(
    state: TState,
    stage: string,
    failureCode: string
  ): Promise<void> {
    for (const record of this.currentSemanticDrafts(state)) {
      const toolName = normalizeSessionSemanticDraftToolName(record.toolName);
      if (!record.callId || !isSessionSemanticDraftToolName(toolName) || record.discarded) continue;
      record.discarded = failureCode;
      record.revision += 1;
      const payload = semanticDraftPayload(record, toolName, 'discarded', failureCode);
      await this.dependencies.emitProjectionDelta(state, {
        type: 'semantic_delta',
        stage,
        status: 'discarded',
        channel: 'final',
        source: 'session',
        itemId: record.callId,
        summary: 'Semantic draft discarded before commit.',
        payload,
      });
    }
  }

  private async updateSemanticDraft(
    state: TState,
    stage: string,
    chunk: LlmChatResult['chunks'][number]
  ): Promise<void> {
    const activeTurn = new SessionDriverActiveTurnRuntimeAccessor(state).ensure(
      stage,
      (prefix) => this.dependencies.createId(prefix)
    );
    const providerCallId = activeTurn.providerCallId;
    if (!providerCallId) return;
    activeTurn.semanticDrafts ??= {};
    const delta = chunk.toolCallDelta;
    const index = typeof delta?.index === 'number'
      ? delta.index
      : typeof chunk.index === 'number'
        ? chunk.index
        : 0;
    const key = `${providerCallId}:${index}`;
    const record = activeTurn.semanticDrafts[key] ?? {
      providerCallId,
      index,
      rawArguments: '',
      revision: 0,
      lastEmittedAt: Date.now(),
      lastEmittedVisibleChars: 0,
    };
    if (chunk.toolCall) {
      record.callId = chunk.toolCall.id || record.callId;
      record.toolName = chunk.toolCall.name || record.toolName;
      record.rawArguments = typeof chunk.toolCall.arguments === 'string'
        ? chunk.toolCall.arguments
        : JSON.stringify(chunk.toolCall.arguments ?? {});
    } else {
      record.callId = delta?.id ?? chunk.callId ?? record.callId;
      record.toolName = delta?.name ?? record.toolName;
      record.rawArguments += delta?.argumentsDelta ?? '';
    }
    activeTurn.semanticDrafts[key] = record;

    const toolName = normalizeSessionSemanticDraftToolName(record.toolName);
    if (!record.callId || !isSessionSemanticDraftToolName(toolName) || record.failed || record.discarded) return;
    const maxChars = this.dependencies.semanticDraftMaxChars ?? 512 * 1024;
    if (record.rawArguments.length > maxChars) {
      await this.failSemanticDraftRecord(state, stage, record, 'semantic_draft_too_large');
      return;
    }
    const decoded = decodeSessionSemanticDraft(record.rawArguments, toolName);
    if (!decoded.ok) {
      await this.failSemanticDraftRecord(state, stage, record, decoded.failure.failureCode);
      return;
    }
    if (record.emitted && !semanticDraftPreservesVisiblePrefix(record.emitted, decoded.draft)) {
      await this.failSemanticDraftRecord(state, stage, record, 'semantic_draft_non_monotonic');
      return;
    }
    record.latest = decoded.draft;
    await this.publishSemanticDraft(state, stage, record, false);
  }

  private async publishSemanticDraft(
    state: TState,
    stage: string,
    record: SessionSemanticDraftStreamRecord,
    force: boolean
  ): Promise<void> {
    const toolName = normalizeSessionSemanticDraftToolName(record.toolName);
    const draft = record.latest;
    if (!record.callId || !draft || !isSessionSemanticDraftToolName(toolName) || record.failed || record.discarded) return;
    if (draft.visibleCharLength === 0 && !record.emitted) return;
    const now = Date.now();
    const visibleDelta = draft.visibleCharLength - record.lastEmittedVisibleChars;
    const flushChars = this.dependencies.semanticDraftFlushChars ?? 768;
    const flushMs = this.dependencies.semanticDraftFlushMs ?? 120;
    const shouldEmit = force ||
      !record.emitted ||
      visibleDelta >= flushChars ||
      now - record.lastEmittedAt >= flushMs;
    if (!shouldEmit || (record.emitted && semanticDraftPayloadMatches(record.emitted, draft))) return;

    record.revision += 1;
    const payload = semanticDraftPayload(record, toolName, 'streaming');
    record.emitted = payload;
    record.lastEmittedAt = now;
    record.lastEmittedVisibleChars = draft.visibleCharLength;
    await this.dependencies.emitProjectionDelta(state, {
      type: 'semantic_delta',
      stage,
      status: 'streaming',
      channel: 'final',
      source: 'session',
      itemId: record.callId,
      summary: draft.kind === 'answer' ? 'Streaming semantic answer.' : 'Streaming semantic plan.',
      payload,
    });
  }

  private async failSemanticDraftRecord(
    state: TState,
    stage: string,
    record: SessionSemanticDraftStreamRecord,
    failureCode: string
  ): Promise<void> {
    if (record.failed || record.discarded) return;
    const toolName = normalizeSessionSemanticDraftToolName(record.toolName);
    if (!record.callId || !isSessionSemanticDraftToolName(toolName)) return;
    record.failed = failureCode;
    record.revision += 1;
    const payload = semanticDraftPayload(record, toolName, 'failed', failureCode);
    record.emitted = payload;
    await this.dependencies.emitProjectionDelta(state, {
      type: 'semantic_delta',
      stage,
      status: 'failed',
      channel: 'final',
      source: 'session',
      itemId: record.callId,
      summary: 'Semantic draft requires repair.',
      payload,
    });
  }

  private semanticDraftForToolCall(
    state: TState,
    toolCall: NativeToolCallProposal
  ): SessionSemanticDraftStreamRecord | undefined {
    return Object.values(this.semanticDrafts(state)).find((record) => (
      record.callId === toolCall.callId && record.index === toolCall.index
    )) ?? Object.values(this.semanticDrafts(state)).find((record) => record.callId === toolCall.callId);
  }

  private currentSemanticDrafts(state: TState): SessionSemanticDraftStreamRecord[] {
    const activeTurn = state.activeTurn;
    if (!activeTurn?.providerCallId) return [];
    return Object.values(activeTurn.semanticDrafts ?? {})
      .filter((record) => record.providerCallId === activeTurn.providerCallId);
  }

  private semanticDrafts(state: TState): Record<string, SessionSemanticDraftStreamRecord> {
    return state.activeTurn?.semanticDrafts ?? {};
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
    const activeTurn = new SessionDriverActiveTurnRuntimeAccessor(state).ensure(
      stage,
      (prefix) => this.dependencies.createId(prefix)
    );
    activeTurn.submittedPartFrames ??= {};
    const frameKey = `${enrichedFrame.frameId ?? enrichedFrame.draftId}:${stableHash(JSON.stringify(enrichedFrame))}`;
    if (activeTurn.submittedPartFrames[frameKey]) return;
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

    activeTurn.submittedPartFrames[frameKey] = true;
  }
}

function semanticDraftPayload(
  record: SessionSemanticDraftStreamRecord,
  toolName: 'session.submit_answer' | 'session.submit_plan',
  state: SessionSemanticDraftPayload['state'],
  failureCode?: string
): SessionSemanticDraftPayload {
  const draft = record.latest;
  const kind = toolName === 'session.submit_answer' ? 'answer' : 'plan';
  return {
    schemaVersion: 'deepcode.session.semantic-draft.v1',
    kind,
    toolName,
    callId: record.callId!,
    proposalId: `proposal-${record.callId}`,
    ...(kind === 'plan' ? { planId: `plan-${record.callId}` } : {}),
    revision: record.revision,
    state,
    ...(failureCode ? { failureCode } : {}),
    ...(kind === 'answer'
      ? { answer: { content: draft?.answer?.content ?? record.emitted?.answer?.content ?? '' } }
      : {
          plan: draft?.plan ?? record.emitted?.plan ?? {
            tasks: [],
            risks: [],
            reviewCheckpoints: [],
          },
        }),
  };
}

function semanticDraftPreservesVisiblePrefix(
  previous: SessionSemanticDraftPayload,
  next: DecodedSessionSemanticDraft
): boolean {
  if (previous.kind !== next.kind) return false;
  if (next.kind === 'answer') {
    return (next.answer?.content ?? '').startsWith(previous.answer?.content ?? '');
  }
  const before = previous.plan;
  const after = next.plan;
  if (!before || !after) return true;
  if (before.title && !after.title?.startsWith(before.title)) return false;
  if (before.summary && !after.summary?.startsWith(before.summary)) return false;
  return semanticArrayPrefix(before.tasks, after.tasks) &&
    semanticArrayPrefix(before.risks, after.risks) &&
    semanticArrayPrefix(before.reviewCheckpoints, after.reviewCheckpoints);
}

function semanticDraftPayloadMatches(
  previous: SessionSemanticDraftPayload,
  next: DecodedSessionSemanticDraft
): boolean {
  if (previous.kind !== next.kind) return false;
  return previous.kind === 'answer'
    ? previous.answer?.content === next.answer?.content
    : JSON.stringify(previous.plan) === JSON.stringify(next.plan);
}

function semanticArrayPrefix<T>(before: T[], after: T[]): boolean {
  if (before.length > after.length) return false;
  return before.every((item, index) => JSON.stringify(item) === JSON.stringify(after[index]));
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
