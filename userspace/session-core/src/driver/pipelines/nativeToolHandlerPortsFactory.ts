import type {
  AgentEvent,
  LlmChatRequest,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { ResourcePacket } from '../../context/types.js';
import type {
  NativeToolReadLedgerEntry,
  NativeToolReadSignature,
} from '../../provider/NativeToolCoordinator.js';
import type {
  NativeToolTurnHandlerPorts,
  NativeToolTurnHandlerState,
  NativeToolTurnResult,
} from '../../provider/NativeToolTurnHandler.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import type { ProviderStreamVisibleLanguage } from './providerStreamCoordinator.js';

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
  duplicateReadDelta(input: {
    sessionId: string;
    runId: string;
    toolCall: NativeToolCallProposal;
    existing: NativeToolReadLedgerEntry;
  }): ProjectionDelta;
  toolCallRunningDelta(input: {
    sessionId: string;
    runId: string;
    language: ProviderStreamVisibleLanguage;
    toolCall: NativeToolCallProposal;
    nativeToolRound: number;
  }): ProjectionDelta;
  resourceResolvedDelta(input: {
    sessionId: string;
    runId: string;
    language: ProviderStreamVisibleLanguage;
    toolCall: NativeToolCallProposal;
    packet: ResourcePacket;
    nativeToolRound: number;
    resourcePacketCount: number;
  }): ProjectionDelta;
}

export interface NativeToolResultMessageBuilderLike {
  duplicateToolMessage(toolCall: NativeToolCallProposal, existing: NativeToolReadLedgerEntry): LlmChatRequest['messages'][number];
  packetToolMessage(toolCall: NativeToolCallProposal, packet: ResourcePacket): LlmChatRequest['messages'][number];
}

export interface NativeToolResourceRecorderLike {
  recordResolvedPacket(
    state: NativeToolTurnHandlerState,
    signature: NativeToolReadSignature,
    packet: ResourcePacket,
    identity: { ts: string; id: string }
  ): AgentEvent;
}

export interface NativeToolHandlerPortsFactoryDependencies<
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends NativeToolTurnResult,
> {
  progressEventBuilder: NativeToolProgressPayloadBuilderLike;
  projectionBuilder: NativeToolProjectionBuilderLike;
  resultMessageBuilder: NativeToolResultMessageBuilderLike;
  resourceRecorder: NativeToolResourceRecorderLike;
  visibleLanguage(userRequest: string): ProviderStreamVisibleLanguage;
  event(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent;
  append(sessionId: string, events: AgentEvent[]): Promise<unknown>;
  emitProjectionDelta(state: TState, delta: ProjectionDelta): Promise<void>;
  now(): string;
  createId(prefix: string): string;
}

export interface NativeToolHandlerPortsFactoryInput<
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends NativeToolTurnResult,
> {
  prompt: TPrompt;
  repairSideEffect(state: TState, prompt: TPrompt, toolCall: NativeToolCallProposal, turn: TTurn): Promise<ProposalEnvelope>;
  tryParseTurnProposal(state: TState, turn: TTurn): ProposalEnvelope | null;
  repairDuplicate(
    state: TState,
    prompt: TPrompt,
    turn: TTurn,
    duplicates: Array<{ toolCall: NativeToolCallProposal; signature: NativeToolReadSignature; entry: NativeToolReadLedgerEntry }>
  ): Promise<ProposalEnvelope>;
  resolveReadToolCall(state: TState, toolCall: NativeToolCallProposal): Promise<ResourcePacket>;
}

export class NativeToolHandlerPortsFactory<
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends NativeToolTurnResult,
> {
  constructor(private readonly dependencies: NativeToolHandlerPortsFactoryDependencies<TState, TPrompt, TTurn>) {}

  create(input: NativeToolHandlerPortsFactoryInput<TState, TPrompt, TTurn>): NativeToolTurnHandlerPorts<TState, TPrompt, TTurn> {
    return {
      appendAssistantProgress: async (state, narration) => {
        await this.dependencies.append(state.sessionId, [
          this.dependencies.event(state.sessionId, 'assistant_msg', this.dependencies.progressEventBuilder.assistantProgressPayload({
            runId: state.runId,
            content: narration,
          })),
        ]);
      },
      emitCheckpoint: async (state, nativeToolRound, toolCallCount) => {
        await this.dependencies.emitProjectionDelta(state, this.dependencies.projectionBuilder.checkpointDelta({
          sessionId: state.sessionId,
          runId: state.runId,
          nativeToolRound,
          toolCallCount,
          resourcePacketCount: state.resourcePackets.length,
        }));
      },
      repairSideEffect: (state, _prompt, toolCall, turn) =>
        input.repairSideEffect(state, input.prompt, toolCall, turn),
      tryParseTurnProposal: (state, turn) =>
        input.tryParseTurnProposal(state, turn),
      repairDuplicate: (state, _prompt, turn, duplicates) =>
        input.repairDuplicate(state, input.prompt, turn, duplicates),
      emitDuplicateRead: async (state, toolCall, existing) => {
        await this.dependencies.emitProjectionDelta(state, this.dependencies.projectionBuilder.duplicateReadDelta({
          sessionId: state.sessionId,
          runId: state.runId,
          toolCall,
          existing,
        }));
      },
      duplicateToolMessage: (toolCall, existing) =>
        this.dependencies.resultMessageBuilder.duplicateToolMessage(toolCall, existing),
      emitToolCallRunning: async (state, toolCall, nativeToolRound) => {
        const language = this.dependencies.visibleLanguage(state.userRequest);
        await this.dependencies.emitProjectionDelta(state, this.dependencies.projectionBuilder.toolCallRunningDelta({
          sessionId: state.sessionId,
          runId: state.runId,
          language,
          toolCall,
          nativeToolRound,
        }));
      },
      resolveReadToolCall: (state, toolCall) =>
        input.resolveReadToolCall(state, toolCall),
      recordResolvedPacket: async (state, signature, packet) => {
        const packetEvent = this.dependencies.resourceRecorder.recordResolvedPacket(state, signature, packet, {
          ts: this.dependencies.now(),
          id: this.dependencies.createId('native-resource-context'),
        });
        await this.dependencies.append(state.sessionId, [packetEvent]);
      },
      emitResourceResolved: async (state, toolCall, packet, nativeToolRound) => {
        const language = this.dependencies.visibleLanguage(state.userRequest);
        await this.dependencies.emitProjectionDelta(state, this.dependencies.projectionBuilder.resourceResolvedDelta({
          sessionId: state.sessionId,
          runId: state.runId,
          language,
          toolCall,
          packet,
          nativeToolRound,
          resourcePacketCount: state.resourcePackets.length,
        }));
      },
      packetToolMessage: (toolCall, packet) =>
        this.dependencies.resultMessageBuilder.packetToolMessage(toolCall, packet),
    };
  }
}
