import type {
  LlmChatRequest,
  ToolDefinition,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { ProviderEmptyProposalRetryOptions } from '../../provider/ProviderEmptyProposalRetry.js';
import type {
  NativeToolTurnHandlerState,
  NativeToolTurnResult,
} from '../../provider/NativeToolTurnHandler.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import type { NativeToolHandlerPortsFactory } from './nativeToolHandlerPortsFactory.js';
import type {
  NativeToolProviderLoop,
  NativeToolProviderLoopState,
  NativeToolProviderResumeSignal,
} from './nativeToolProviderLoop.js';

export interface NativeToolProviderCoordinatorState
  extends NativeToolTurnHandlerState,
    NativeToolProviderLoopState {}

export interface NativeToolProviderCoordinatorDependencies<
  TState extends NativeToolProviderCoordinatorState,
  TTurn extends NativeToolTurnResult,
> {
  providerLoop: NativeToolProviderLoop<TState, PromptEnvelope, TTurn>;
  handlerPortsFactory: NativeToolHandlerPortsFactory<TState, PromptEnvelope, TTurn>;
  providerTools(state: TState): ToolDefinition[];
  semanticProposal(state: TState, toolCall: NativeToolCallProposal): ProposalEnvelope | null;
  runTurn(
    profileId: string | undefined,
    state: TState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn>;
  isEmptyResponseError(error: unknown): boolean;
  semanticDirectiveError(error: unknown): { code: string; message: string } | undefined;
}

export interface NativeToolProviderCoordinatorInput<TState extends NativeToolProviderCoordinatorState> {
  profileId?: string;
  state: TState;
  prompt: PromptEnvelope;
  contract: DriverProviderTurnFrame;
}

export class NativeToolProviderCoordinator<
  TState extends NativeToolProviderCoordinatorState,
  TTurn extends NativeToolTurnResult,
> {
  constructor(private readonly dependencies: NativeToolProviderCoordinatorDependencies<TState, TTurn>) {}

  run(
    input: NativeToolProviderCoordinatorInput<TState>
  ): Promise<ProposalEnvelope | NativeToolProviderResumeSignal> {
    return this.dependencies.providerLoop.run({
      profileId: input.profileId,
      state: input.state,
      prompt: input.prompt,
      contract: input.contract,
      providerTools: this.dependencies.providerTools(input.state),
      handlerPorts: this.dependencies.handlerPortsFactory.create({
        semanticProposal: (state, toolCall) => this.dependencies.semanticProposal(state, toolCall),
      }),
      runTurn: (profileId, state, stage, messages, options) =>
        this.dependencies.runTurn(profileId, state, stage, messages, options),
      isEmptyResponseError: this.dependencies.isEmptyResponseError,
      semanticDirectiveError: this.dependencies.semanticDirectiveError,
    });
  }
}
