import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import type { NativeToolProviderResumeSignal } from './nativeToolProviderLoop.js';

export interface ProviderProposalCoordinatorInput {
  profileId?: string;
}

export interface ProviderProposalCoordinatorState {
  providerTurnFrame?: DriverProviderTurnFrame;
}

export interface ProviderProposalCoordinatorPorts<
  Input extends ProviderProposalCoordinatorInput,
  State extends ProviderProposalCoordinatorState,
> {
  providerResult(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    contract: DriverProviderTurnFrame
  ): Promise<ProposalEnvelope | NativeToolProviderResumeSignal>;
  createError(code: string, message: string): Error;
}

export class ProviderProposalCoordinator<
  Input extends ProviderProposalCoordinatorInput,
  State extends ProviderProposalCoordinatorState,
> {
  constructor(private readonly ports: ProviderProposalCoordinatorPorts<Input, State>) {}

  async callAndParseRequiredProposal(
    input: Input,
    state: State,
    prompt: PromptEnvelope
  ): Promise<ProposalEnvelope> {
    const result = await this.callAndParse(input, state, prompt);
    if (result.kind === 'providerResume') {
      throw this.ports.createError(
        'provider_resume_not_allowed',
        'This provider turn requires a structured proposal and cannot suspend for a semantic tool resume.'
      );
    }
    return result;
  }

  async callAndParse(
    input: Input,
    state: State,
    prompt: PromptEnvelope
  ): Promise<ProposalEnvelope | NativeToolProviderResumeSignal> {
    const contract = state.providerTurnFrame;
    if (!contract) {
      throw this.ports.createError(
        'provider_turn_contract_missing',
        'Provider turn contract is required before calling the provider.'
      );
    }
    return this.ports.providerResult(input, state, prompt, contract);
  }
}
