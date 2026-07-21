import type {
  AgentEvent,
  ProjectionDelta,
} from '@deepcode/protocol';
import type {
  NativeToolSemanticHandlingResult,
  NativeToolTurnHandlerPorts,
  NativeToolTurnHandlerState,
  NativeToolTurnResult,
} from '../../provider/NativeToolTurnHandler.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import {
  providerCommitEventsDeferred,
  queueProviderCommitEvents,
  type ProviderCommitBufferState,
} from './providerCommitBuffer.js';

export interface NativeToolProgressPayloadBuilderLike {
  assistantProgressPayload(input: { runId: string; content: string }): Record<string, unknown>;
}

export interface NativeToolProjectionBuilderLike {
  checkpointDelta(input: {
    sessionId: string;
    runId: string;
    nativeToolRound: number;
    toolCallCount: number;
    resourcePacketCount: number;
  }): ProjectionDelta;
}

export interface NativeToolHandlerPortsFactoryDependencies<
  TState extends NativeToolTurnHandlerState,
> {
  progressEventBuilder: NativeToolProgressPayloadBuilderLike;
  projectionBuilder: NativeToolProjectionBuilderLike;
  event(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent;
  append(sessionId: string, events: AgentEvent[]): Promise<unknown>;
  emitProjectionDelta(state: TState, delta: ProjectionDelta): Promise<void>;
  recordSemanticExchange?(
    state: TState,
    toolCall: NativeToolCallProposal,
    result: NativeToolSemanticHandlingResult
  ): Promise<void>;
}

export interface NativeToolHandlerPortsFactoryInput<
  TState extends NativeToolTurnHandlerState,
> {
  semanticDirective(state: TState, toolCall: NativeToolCallProposal): Promise<NativeToolSemanticHandlingResult | null>;
}

export class NativeToolHandlerPortsFactory<
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends NativeToolTurnResult,
> {
  constructor(private readonly dependencies: NativeToolHandlerPortsFactoryDependencies<TState>) {}

  create(input: NativeToolHandlerPortsFactoryInput<TState>): NativeToolTurnHandlerPorts<TState> {
    return {
      appendAssistantProgress: async (state, narration) => {
        const events = [
          this.dependencies.event(state.sessionId, 'assistant_msg', this.dependencies.progressEventBuilder.assistantProgressPayload({
            runId: state.runId,
            content: narration,
          })),
        ];
        const commitState = state as TState & ProviderCommitBufferState;
        if (providerCommitEventsDeferred(commitState)) {
          queueProviderCommitEvents(commitState, events);
          return;
        }
        await this.dependencies.append(state.sessionId, events);
      },
      emitCheckpoint: async (state, nativeToolRound, toolCallCount) => {
        const resourcePacketCount = Array.isArray((state as unknown as { resourcePackets?: unknown[] }).resourcePackets)
          ? (state as unknown as { resourcePackets: unknown[] }).resourcePackets.length
          : 0;
        await this.dependencies.emitProjectionDelta(state, this.dependencies.projectionBuilder.checkpointDelta({
          sessionId: state.sessionId,
          runId: state.runId,
          nativeToolRound,
          toolCallCount,
          resourcePacketCount,
        }));
      },
      semanticDirective: (state, toolCall) => input.semanticDirective(state, toolCall),
      recordSemanticExchange: (state, toolCall, result) =>
        this.dependencies.recordSemanticExchange?.(state, toolCall, result) ?? Promise.resolve(),
    };
  }
}
