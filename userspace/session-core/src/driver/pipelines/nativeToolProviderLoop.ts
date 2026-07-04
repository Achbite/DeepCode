import type {
  LlmChatRequest,
  ToolDefinition,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
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
import type { ProviderTurnContract } from '../runFrame.js';

export interface NativeToolProviderPipelineLike<
  TState extends NativeToolTurnHandlerState,
  TTurn extends ProviderPipelineTurn,
> {
  messages(contract: ProviderTurnContract): LlmChatRequest['messages'];
  runWithNativeTools(input: ProviderPipelineRunTurnInput<TState, TTurn>): Promise<TTurn>;
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
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  providerPipeline: NativeToolProviderPipelineLike<TState, TTurn>;
  turnHandler: NativeToolProviderTurnHandlerLike<TState, TPrompt, TTurn>;
  resumeMessageBuilder: NativeToolProviderResumeMessageBuilderLike<TTurn>;
}

export interface NativeToolProviderLoopInput<
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  profileId?: string;
  state: TState;
  prompt: TPrompt;
  contract: ProviderTurnContract;
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
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  constructor(private readonly dependencies: NativeToolProviderLoopDependencies<TState, TPrompt, TTurn>) {}

  async run(input: NativeToolProviderLoopInput<TState, TPrompt, TTurn>): Promise<string | ProposalEnvelope> {
    let currentMessages = this.dependencies.providerPipeline.messages(input.contract);
    for (let round = 0; ; round += 1) {
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
      if (effectiveTurn.toolCalls.length === 0) return effectiveTurn.content;

      const handled = await this.dependencies.turnHandler.handle({
        state: input.state,
        prompt: input.prompt,
        turn: effectiveTurn,
        round,
        ports: input.handlerPorts,
      });
      if (handled.kind === 'proposal') return handled.proposal;

      currentMessages = this.dependencies.resumeMessageBuilder.nextMessages(
        currentMessages,
        effectiveTurn,
        handled.toolMessages
      );
      const guidanceMessages = await input.consumeGuidanceMessages(input.state, stage);
      currentMessages.push(...guidanceMessages);
    }
  }
}
