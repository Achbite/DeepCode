import type { AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ProposalRouterResult, RoutedProposal } from '../proposal/proposalRouter.js';

export interface ProviderTurnCycleState {
  sessionId: string;
  phase: string;
}

export interface ProviderTurnCycleContextResult {
  prompt: PromptEnvelope;
  lastResult: AgentSessionResult;
}

export interface ProviderTurnCyclePorts<Input, State extends ProviderTurnCycleState> {
  refreshRuntimeState(state: State): void;
  prepareProviderContext(input: Input, state: State, lastResult: AgentSessionResult): Promise<ProviderTurnCycleContextResult>;
  callProviderAndParse(input: Input, state: State, prompt: PromptEnvelope): Promise<ProposalEnvelope>;
  routeProposal(proposal: ProposalEnvelope): RoutedProposal;
  executeRoutedProposal(input: {
    input: Input;
    state: State;
    prompt: PromptEnvelope;
    proposal: ProposalEnvelope;
    routed: RoutedProposal;
    lastResult: AgentSessionResult;
  }): Promise<ProposalRouterResult>;
  appendDriverFailure(state: State, error: unknown): Promise<AgentSessionResult | null | undefined>;
  appendProviderFailure(state: State, error: unknown): Promise<AgentSessionResult>;
}

export type ProviderTurnCycleResult =
  | { kind: 'return'; result: AgentSessionResult }
  | { kind: 'continue'; lastResult: AgentSessionResult; proposal: ProposalEnvelope };

export class ProviderTurnCycle<Input, State extends ProviderTurnCycleState> {
  constructor(private readonly ports: ProviderTurnCyclePorts<Input, State>) {}

  async run(input: {
    input: Input;
    state: State;
    lastResult: AgentSessionResult;
  }): Promise<ProviderTurnCycleResult> {
    const { state } = input;
    this.ports.refreshRuntimeState(state);
    const providerContext = await this.ports.prepareProviderContext(input.input, state, input.lastResult);
    const prompt = providerContext.prompt;
    state.phase = 'provider_proposing';
    let proposal: ProposalEnvelope;
    try {
      proposal = await this.ports.callProviderAndParse(input.input, state, prompt);
    } catch (error) {
      const driverFailure = await this.ports.appendDriverFailure(state, error);
      if (driverFailure) return { kind: 'return', result: driverFailure };
      return { kind: 'return', result: await this.ports.appendProviderFailure(state, error) };
    }
    const routedProposal = this.ports.routeProposal(proposal);
    const routed = await this.ports.executeRoutedProposal({
      input: input.input,
      state,
      prompt,
      proposal,
      routed: routedProposal,
      lastResult: providerContext.lastResult,
    });
    if (routed.kind === 'return') {
      return { kind: 'return', result: routed.result };
    }
    return {
      kind: 'continue',
      lastResult: routed.lastResult,
      proposal,
    };
  }
}
