import type {
  ConversationLanguagePolicy,
  LlmChatMessage,
  LlmChatRequest,
  SessionProviderAdmissionMetadataV1,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../protocol/types.js';
import type { NativeToolCallProposal } from './providerStreamParts.js';

export interface NativeToolTurnResult {
  /**
   * Immutable control metadata derived from the exact physical request that
   * produced this semantic turn. Semantic admission must never recover this
   * identity from "latest request" state.
   */
  providerAdmission: SessionProviderAdmissionMetadataV1;
  providerRequestId?: string;
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

export interface NativeToolTurnHandlerState {
  sessionId: string;
  runId: string;
  userRequest: string;
}

export type NativeToolHandlingResult =
  | { kind: 'proposal'; proposal: ProposalEnvelope }
  | { kind: 'providerResume' };
export type NativeToolSemanticHandlingResult =
  | { kind: 'proposal'; proposal: ProposalEnvelope; toolResult: unknown }
  | { kind: 'providerResume'; toolResult: unknown };

export interface NativeToolTurnHandlerPorts<TState extends NativeToolTurnHandlerState> {
  emitCheckpoint(state: TState, round: number, toolCallCount: number): Promise<void>;
  semanticDirective(state: TState, toolCall: NativeToolCallProposal): Promise<NativeToolSemanticHandlingResult | null>;
  recordSemanticDirectiveAdmission(
    state: TState,
    turn: NativeToolTurnResult,
    toolCall: NativeToolCallProposal
  ): Promise<void>;
  recordSemanticExchange(
    state: TState,
    turn: NativeToolTurnResult,
    toolCall: NativeToolCallProposal,
    result: NativeToolSemanticHandlingResult
  ): Promise<void>;
  recordSemanticDirectiveTerminal(
    state: TState,
    turn: NativeToolTurnResult,
    toolCall: NativeToolCallProposal,
    status: 'failed' | 'cancelled' | 'superseded' | 'postEffectPersistenceFailed',
    error: unknown
  ): Promise<void>;
}

export interface NativeToolTurnHandlerInput<
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends NativeToolTurnResult,
> {
  state: TState;
  prompt: TPrompt;
  turn: TTurn;
  round: number;
  ports: NativeToolTurnHandlerPorts<TState>;
}

export class NativeToolTurnHandler {
  async handle<TState extends NativeToolTurnHandlerState, TPrompt, TTurn extends NativeToolTurnResult>(
    input: NativeToolTurnHandlerInput<TState, TPrompt, TTurn>
  ): Promise<NativeToolHandlingResult> {
    const { state, turn, round, ports } = input;
    if (turn.toolCalls.length !== 1) {
      throw new Error('Provider turn must emit exactly one registered Session semantic directive.');
    }
    const toolCall = turn.toolCalls[0];
    await ports.recordSemanticDirectiveAdmission(state, turn, toolCall);
    let result: NativeToolSemanticHandlingResult;
    try {
      const semanticResult = await ports.semanticDirective(state, toolCall);
      if (!semanticResult) {
        throw new Error(`Provider emitted unsupported Session semantic tool ${toolCall.name}.`);
      }
      result = semanticResult;
    } catch (error) {
      await ports.recordSemanticDirectiveTerminal(
        state,
        turn,
        toolCall,
        semanticTerminalStatus(error),
        error
      );
      throw error;
    }
    try {
      await ports.recordSemanticExchange(state, turn, toolCall, result);
    } catch (error) {
      try {
        await ports.recordSemanticDirectiveTerminal(
          state,
          turn,
          toolCall,
          'postEffectPersistenceFailed',
          error
        );
      } catch (terminalError) {
        throw new Error(
          [
            'Session semantic effect completed, but its durable continuation record failed.',
            `Original persistence error: ${errorText(error)}.`,
            `Terminal analysis append also failed: ${errorText(terminalError)}.`,
          ].join(' ')
        );
      }
      throw error;
    }
    if (result.kind === 'providerResume') {
      await ports.emitCheckpoint(state, round, turn.toolCalls.length);
    }
    return result.kind === 'proposal'
      ? { kind: 'proposal', proposal: result.proposal }
      : { kind: 'providerResume' };
  }
}

function semanticTerminalStatus(error: unknown): 'failed' | 'cancelled' {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return 'failed';
  return (error as { code?: unknown }).code === 'session_run_cancelled'
    ? 'cancelled'
    : 'failed';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
