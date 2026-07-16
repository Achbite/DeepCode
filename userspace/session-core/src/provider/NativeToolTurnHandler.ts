import type { ProposalEnvelope } from '../protocol/types.js';
import type { NativeToolCallProposal } from './providerStreamParts.js';

export interface NativeToolTurnResult {
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
  appendAssistantProgress(state: TState, narration: string): Promise<void>;
  emitCheckpoint(state: TState, round: number, toolCallCount: number): Promise<void>;
  semanticDirective(state: TState, toolCall: NativeToolCallProposal): Promise<NativeToolSemanticHandlingResult | null>;
  recordSemanticExchange(
    state: TState,
    toolCall: NativeToolCallProposal,
    result: NativeToolSemanticHandlingResult
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
    const narration = turn.content.trim();
    if (narration) {
      await ports.appendAssistantProgress(state, narration);
    } else {
      await ports.emitCheckpoint(state, round, turn.toolCalls.length);
    }
    if (turn.toolCalls.length !== 1) {
      throw new Error('Provider turn must emit exactly one registered Session semantic directive.');
    }
    const result = await ports.semanticDirective(state, turn.toolCalls[0]);
    if (!result) {
      throw new Error(`Provider emitted unsupported Session semantic tool ${turn.toolCalls[0].name}.`);
    }
    await ports.recordSemanticExchange(state, turn.toolCalls[0], result);
    return result.kind === 'proposal'
      ? { kind: 'proposal', proposal: result.proposal }
      : { kind: 'providerResume' };
  }
}
