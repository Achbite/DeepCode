import type {
  LlmChatRequest,
  ToolDefinition,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { ProviderEmptyProposalRetryOptions } from '../../provider/ProviderEmptyProposalRetry.js';
import type {
  NativeToolTurnHandlerInput,
  NativeToolTurnHandlerPorts,
  NativeToolTurnHandlerState,
  NativeToolTurnResult,
} from '../../provider/NativeToolTurnHandler.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import type {
  ProviderPipelineRunTurnInput,
  ProviderPipelineTurn,
} from './providerPipeline.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import { SessionSemanticDirectiveError } from '../../provider/SessionSemanticToolAdapter.js';

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
  semanticDirectiveRepairAttempted?: boolean;
  semanticDirectiveErrorSummary?: string;
}

export interface NativeToolProviderTurnHandlerLike<
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends NativeToolTurnResult,
> {
  handle(input: NativeToolTurnHandlerInput<TState, TPrompt, TTurn>): Promise<{ kind: 'proposal'; proposal: ProposalEnvelope }>;
}

export interface NativeToolProviderLoopDependencies<
  TState extends NativeToolProviderLoopState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  providerPipeline: NativeToolProviderPipelineLike<TState, TTurn>;
  turnHandler: NativeToolProviderTurnHandlerLike<TState, TPrompt, TTurn>;
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
  handlerPorts: NativeToolTurnHandlerPorts<TState>;
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

export class NativeToolProviderLoop<
  TState extends NativeToolProviderLoopState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  constructor(private readonly dependencies: NativeToolProviderLoopDependencies<TState, TPrompt, TTurn>) {}

  async run(
    input: NativeToolProviderLoopInput<TState, TPrompt, TTurn>
  ): Promise<ProposalEnvelope | NativeToolProviderResumeSignal> {
    let effectiveTurn: TTurn;
    try {
      effectiveTurn = await this.dependencies.providerPipeline.runWithNativeTools({
        profileId: input.profileId,
        state: input.state,
        contract: input.contract,
        stage: 'provider_call',
        messages: this.dependencies.providerPipeline.messages(input.contract),
        options: { tools: input.providerTools },
        runTurn: input.runTurn,
        isEmptyResponseError: input.isEmptyResponseError,
      });
    } catch (error) {
      const directiveError = input.semanticDirectiveError(error);
      if (!directiveError) throw error;
      return this.scheduleSameProfileRetry(input.state, [
        `code=${directiveError.code}`,
        `fieldErrors=${directiveError.message}`,
      ]);
    }
    const toolCalls = effectiveTurn.toolCalls as NativeToolCallProposal[];
    const registeredNames = new Set(input.providerTools.map((tool) => tool.name));
    const unregistered = toolCalls.find((toolCall) => !registeredNames.has(toolCall.name));
    if (unregistered) {
      throw new Error(`Provider emitted unregistered Session semantic tool ${unregistered.name}.`);
    }
    if (toolCalls.length === 0) {
      throw new Error('Provider did not emit a required Session semantic directive.');
    }

    try {
      const handled = await this.dependencies.turnHandler.handle({
        state: input.state,
        prompt: input.prompt,
        turn: effectiveTurn,
        round: 0,
        ports: input.handlerPorts,
      });
      input.state.semanticDirectiveRepairAttempted = false;
      input.state.semanticDirectiveErrorSummary = undefined;
      return handled.proposal;
    } catch (error) {
      if (!(error instanceof SessionSemanticDirectiveError)) throw error;
      return this.scheduleSameProfileRetry(input.state, [
        `code=${error.code}`,
        `tool=${error.toolName}`,
        `callId=${error.callId}`,
        `argumentsHash=${error.argumentsHash}`,
        `fieldErrors=${error.message}`,
      ]);
    }
  }

  private scheduleSameProfileRetry(
    state: TState,
    details: string[]
  ): NativeToolProviderResumeSignal {
    if (state.semanticDirectiveRepairAttempted) {
      throw new Error(`Session semantic directive remained invalid after one same-profile retry: ${details.join('; ')}`);
    }
    state.semanticDirectiveRepairAttempted = true;
    state.semanticDirectiveErrorSummary = [
      ...details,
      'requiredAction=Call exactly one registered semantic tool with valid JSON arguments matching its schema and the current task contract.',
    ].join('; ');
    return { kind: 'providerResume' };
  }
}
