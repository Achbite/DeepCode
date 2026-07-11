import type { AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { LoopDirective } from '../proposal/proposalRouter.js';
import type { NativeToolProviderResumeSignal } from './nativeToolProviderLoop.js';

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
  callProviderAndParse(
    input: Input,
    state: State,
    prompt: PromptEnvelope
  ): Promise<ProposalEnvelope | NativeToolProviderResumeSignal>;
  deterministicProposal?(state: State): ProposalEnvelope | undefined;
  admitDirective(proposal: ProposalEnvelope): LoopDirective;
  appendDriverFailure(state: State, error: unknown): Promise<AgentSessionResult | null | undefined>;
  appendProviderFailure(state: State, error: unknown): Promise<AgentSessionResult>;
}

export type ProviderTurnCycleResult =
  | { kind: 'failed'; result: AgentSessionResult }
  | {
    kind: 'directiveReady';
    prompt: PromptEnvelope;
    lastResult: AgentSessionResult;
    proposal?: ProposalEnvelope;
    directive: LoopDirective;
  };

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
    const deterministic = this.ports.deterministicProposal?.(state);
    if (deterministic) {
      return {
        kind: 'directiveReady',
        prompt,
        lastResult: providerContext.lastResult,
        proposal: deterministic,
        directive: this.ports.admitDirective(deterministic),
      };
    }
    state.phase = 'provider_proposing';
    let providerStep: ProposalEnvelope | NativeToolProviderResumeSignal;
    try {
      providerStep = await this.ports.callProviderAndParse(input.input, state, prompt);
    } catch (error) {
      const driverFailure = await this.ports.appendDriverFailure(state, error);
      if (driverFailure) return { kind: 'failed', result: driverFailure };
      return { kind: 'failed', result: await this.ports.appendProviderFailure(state, error) };
    }
    if (providerStep.kind === 'providerResume') {
      return {
        kind: 'directiveReady',
        prompt,
        lastResult: providerContext.lastResult,
        directive: { kind: 'providerResume' },
      };
    }
    return {
      kind: 'directiveReady',
      prompt,
      lastResult: providerContext.lastResult,
      proposal: providerStep,
      directive: this.ports.admitDirective(providerStep),
    };
  }
}
