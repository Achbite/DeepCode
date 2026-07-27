import type {
  ProjectionDelta,
} from '@deepcode/protocol';
import type {
  NativeToolSemanticHandlingResult,
  NativeToolTurnHandlerPorts,
  NativeToolTurnHandlerState,
  NativeToolTurnResult,
} from '../../provider/NativeToolTurnHandler.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
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
  projectionBuilder: NativeToolProjectionBuilderLike;
  emitProjectionDelta(state: TState, delta: ProjectionDelta): Promise<void>;
  recordSemanticDirectiveAdmission?(
    state: TState,
    turn: NativeToolTurnResult,
    toolCall: NativeToolCallProposal
  ): Promise<void>;
  recordSemanticExchange?(
    state: TState,
    turn: NativeToolTurnResult,
    toolCall: NativeToolCallProposal,
    result: NativeToolSemanticHandlingResult
  ): Promise<void>;
  recordSemanticDirectiveTerminal?(
    state: TState,
    turn: NativeToolTurnResult,
    toolCall: NativeToolCallProposal,
    status: 'failed' | 'cancelled' | 'superseded' | 'postEffectPersistenceFailed',
    error: unknown
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
      recordSemanticDirectiveAdmission: (state, turn, toolCall) =>
        this.dependencies.recordSemanticDirectiveAdmission?.(state, turn, toolCall)
          ?? Promise.resolve(),
      semanticDirective: (state, toolCall) => input.semanticDirective(state, toolCall),
      recordSemanticDirectiveTerminal: (state, turn, toolCall, status, error) =>
        this.dependencies.recordSemanticDirectiveTerminal?.(
          state,
          turn,
          toolCall,
          status,
          error
        ) ?? Promise.resolve(),
      recordSemanticExchange: (state, turn, toolCall, result) =>
        this.dependencies.recordSemanticExchange?.(state, turn, toolCall, result) ?? Promise.resolve(),
    };
  }
}
