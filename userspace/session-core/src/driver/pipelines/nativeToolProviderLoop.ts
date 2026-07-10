import type {
  LlmChatRequest,
  ToolDefinition,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { ProviderEmptyProposalRetryOptions } from '../../provider/ProviderEmptyProposalRetry.js';
import type {
  NativeToolHandlingResult,
  NativeToolTurnHandlerInput,
  NativeToolTurnHandlerPorts,
  NativeToolTurnHandlerState,
  NativeToolTurnResult,
} from '../../provider/NativeToolTurnHandler.js';
import type {
  ProviderPipelineRunTurnInput,
  ProviderPipelineTurn,
} from './providerPipeline.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';

export interface NativeToolProviderPipelineLike<
  TState extends NativeToolTurnHandlerState,
  TTurn extends ProviderPipelineTurn,
> {
  messages(contract: DriverProviderTurnFrame): LlmChatRequest['messages'];
  runWithNativeTools(input: ProviderPipelineRunTurnInput<TState, TTurn>): Promise<TTurn>;
}

export interface NativeToolProviderResumeSignal {
  readonly kind: 'providerResume';
}

export interface NativeToolProviderLoopState extends NativeToolTurnHandlerState {
  nativeToolResumeMessages?: LlmChatRequest['messages'];
  nativeToolResumeRound?: number;
}

export interface NativeToolProviderTurnHandlerLike<
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends NativeToolTurnResult,
> {
  handle(input: NativeToolTurnHandlerInput<TState, TPrompt, TTurn>): Promise<NativeToolHandlingResult>;
}

export interface NativeToolProviderResumeMessageBuilderLike<TTurn extends NativeToolTurnResult> {
  nextMessages(
    currentMessages: LlmChatRequest['messages'],
    turn: TTurn,
    toolMessages: LlmChatRequest['messages']
  ): LlmChatRequest['messages'];
}

export interface NativeToolProviderLoopDependencies<
  TState extends NativeToolProviderLoopState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  providerPipeline: NativeToolProviderPipelineLike<TState, TTurn>;
  turnHandler: NativeToolProviderTurnHandlerLike<TState, TPrompt, TTurn>;
  resumeMessageBuilder: NativeToolProviderResumeMessageBuilderLike<TTurn>;
}

export interface NativeToolProviderLoopInput<
  TState extends NativeToolProviderLoopState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  profileId?: string;
  state: TState;
  prompt: TPrompt;
  contract: DriverProviderTurnFrame;
  providerTools: ToolDefinition[];
  handlerPorts: NativeToolTurnHandlerPorts<TState, TPrompt, TTurn>;
  runTurn(
    profileId: string | undefined,
    state: TState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn>;
  isEmptyResponseError(error: unknown): boolean;
  consumeGuidanceMessages(state: TState, stage: string): Promise<LlmChatRequest['messages']>;
}

export class NativeToolProviderLoop<
  TState extends NativeToolProviderLoopState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  constructor(private readonly dependencies: NativeToolProviderLoopDependencies<TState, TPrompt, TTurn>) {}

  async run(
    input: NativeToolProviderLoopInput<TState, TPrompt, TTurn>
  ): Promise<string | ProposalEnvelope | NativeToolProviderResumeSignal> {
    const round = input.state.nativeToolResumeRound ?? 0;
    const currentMessages = input.state.nativeToolResumeMessages
      ?? this.dependencies.providerPipeline.messages(input.contract);
    const stage = round === 0 ? 'provider_call' : `provider_tool_resume_${round}`;
    const effectiveTurn = await this.dependencies.providerPipeline.runWithNativeTools({
      profileId: input.profileId,
      state: input.state,
      contract: input.contract,
      stage,
      messages: currentMessages,
      options: {
        tools: input.providerTools,
      },
      runTurn: input.runTurn,
      isEmptyResponseError: input.isEmptyResponseError,
    });
    if (effectiveTurn.toolCalls.length === 0) {
      input.state.nativeToolResumeMessages = undefined;
      input.state.nativeToolResumeRound = 0;
      return effectiveTurn.content;
    }

    const handled = await this.dependencies.turnHandler.handle({
      state: input.state,
      prompt: input.prompt,
      turn: effectiveTurn,
      round,
      ports: input.handlerPorts,
    });
    if (handled.kind === 'proposal') {
      input.state.nativeToolResumeMessages = undefined;
      input.state.nativeToolResumeRound = 0;
      return handled.proposal;
    }

    const nextMessages = this.dependencies.resumeMessageBuilder.nextMessages(
      currentMessages,
      effectiveTurn,
      handled.toolMessages
    );
    const guidanceMessages = await input.consumeGuidanceMessages(input.state, stage);
    nextMessages.push(...guidanceMessages);
    input.state.nativeToolResumeMessages = nextMessages;
    input.state.nativeToolResumeRound = round + 1;
    return { kind: 'providerResume' };
  }
}
