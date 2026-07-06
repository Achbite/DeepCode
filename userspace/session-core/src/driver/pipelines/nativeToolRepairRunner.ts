import type { LlmChatRequest, ProjectionDelta } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import type {
  NativeToolRepairCoordinator,
  NativeToolRepairDuplicate,
  NativeToolTurnProposalLike,
} from './nativeToolRepairCoordinator.js';

export interface NativeToolRepairRunnerState {
  sessionId: string;
  runId: string;
}

export type NativeToolRepairRunnerResult =
  | { kind: 'proposal'; proposal: ProposalEnvelope }
  | { kind: 'failed'; code: string; message: string };

export interface NativeToolRepairRunnerDependencies {
  repairCoordinator: NativeToolRepairCoordinator;
}

export interface NativeToolSideEffectRepairInput<TState extends NativeToolRepairRunnerState, TTurn extends NativeToolTurnProposalLike> {
  state: TState;
  toolCall: NativeToolCallProposal;
  turn: TTurn;
  acceptedExecution: boolean;
  emitProjectionDelta(state: TState, delta: ProjectionDelta): Promise<void>;
  buildRepairMessages(toolCall: NativeToolCallProposal, turn: TTurn, acceptedExecution: boolean): LlmChatRequest['messages'];
  runRepair(stage: string, messages: LlmChatRequest['messages']): Promise<string>;
  repairErrorMessage(error: unknown): string;
}

export interface NativeToolDuplicateRepairInput<TState extends NativeToolRepairRunnerState, TTurn extends NativeToolTurnProposalLike> {
  state: TState;
  turn: TTurn;
  duplicates: NativeToolRepairDuplicate[];
  duplicateRepairAttempted: boolean;
  markDuplicateRepairAttempted(): void;
  emitProjectionDelta(state: TState, delta: ProjectionDelta): Promise<void>;
  buildRepairMessages(turn: TTurn, duplicates: NativeToolRepairDuplicate[], acceptedExecution: boolean): LlmChatRequest['messages'];
  runRepair(stage: string, messages: LlmChatRequest['messages']): Promise<string>;
  repairErrorMessage(error: unknown): string;
  acceptedExecution: boolean;
}

export class NativeToolRepairRunner {
  constructor(private readonly dependencies: NativeToolRepairRunnerDependencies) {}

  async repairSideEffect<TState extends NativeToolRepairRunnerState, TTurn extends NativeToolTurnProposalLike>(
    input: NativeToolSideEffectRepairInput<TState, TTurn>
  ): Promise<NativeToolRepairRunnerResult> {
    await input.emitProjectionDelta(input.state, this.dependencies.repairCoordinator.sideEffectBlockedDelta({
      sessionId: input.state.sessionId,
      runId: input.state.runId,
      toolCall: input.toolCall,
    }));
    const raw = await input.runRepair(
      'native_tool_side_effect_repair',
      input.buildRepairMessages(input.toolCall, input.turn, input.acceptedExecution)
    );
    try {
      return {
        kind: 'proposal',
        proposal: this.dependencies.repairCoordinator.parseSideEffectRepair({
          raw,
          runId: input.state.runId,
          sessionId: input.state.sessionId,
          acceptedExecution: input.acceptedExecution,
        }),
      };
    } catch (error) {
      return {
        kind: 'failed',
        code: 'native_tool_side_effect_repair_failed',
        message: `Provider requested side-effect native tool ${input.toolCall.name}; repair failed: ${input.repairErrorMessage(error)}`,
      };
    }
  }

  parseTurnProposal<TState extends NativeToolRepairRunnerState, TTurn extends NativeToolTurnProposalLike>(
    state: TState,
    turn: TTurn
  ): ProposalEnvelope | null {
    return this.dependencies.repairCoordinator.parseTurnProposal({
      turn,
      runId: state.runId,
      sessionId: state.sessionId,
    });
  }

  async repairDuplicate<TState extends NativeToolRepairRunnerState, TTurn extends NativeToolTurnProposalLike>(
    input: NativeToolDuplicateRepairInput<TState, TTurn>
  ): Promise<NativeToolRepairRunnerResult> {
    if (input.duplicateRepairAttempted) {
      const failure = this.dependencies.repairCoordinator.duplicateLoopError(input.duplicates);
      return { kind: 'failed', code: failure.code, message: failure.message };
    }
    input.markDuplicateRepairAttempted();
    await input.emitProjectionDelta(input.state, this.dependencies.repairCoordinator.duplicateRepairDelta({
      sessionId: input.state.sessionId,
      runId: input.state.runId,
      duplicates: input.duplicates,
    }));
    const raw = await input.runRepair(
      'native_tool_duplicate_repair',
      input.buildRepairMessages(input.turn, input.duplicates, input.acceptedExecution)
    );
    try {
      return {
        kind: 'proposal',
        proposal: this.dependencies.repairCoordinator.parseDuplicateRepair({
          raw,
          runId: input.state.runId,
          sessionId: input.state.sessionId,
        }),
      };
    } catch (error) {
      return {
        kind: 'failed',
        code: 'native_tool_duplicate_repair_failed',
        message: `Provider repeated read-only native tools and duplicate-loop repair did not return a valid Agent Protocol v3 proposal: ${input.repairErrorMessage(error)}`,
      };
    }
  }
}
