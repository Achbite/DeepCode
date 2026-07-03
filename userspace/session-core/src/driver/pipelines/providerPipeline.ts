import type { LlmChatRequest } from '@deepcode/protocol';
import type { ProviderTurnContract } from '../runFrame.js';
import {
  ProviderEmptyProposalRetry,
  type ProviderEmptyProposalRetryOptions,
} from '../../provider/ProviderEmptyProposalRetry.js';

export {
  ProviderTraceArchive,
  type ProviderTraceArchiveRecord,
} from '../../provider/ProviderTraceArchive.js';
export {
  NativeToolCoordinator,
  NativeToolCoordinatorError,
  NativeToolTurnHandler,
  ProviderPartFrameParser,
  ProviderToolCallBuffer,
  stripProviderPartFrames,
  type NativeToolHandlingResult,
  type NativeToolReadLedgerEntry,
  type NativeToolReadSignature,
  type NativeToolCallProposal,
} from '../../provider/providerStreamParts.js';

export interface ProviderPipelineTurn {
  content: string;
  toolCalls: readonly unknown[];
}

export interface ProviderPipelineRunTurnInput<TState, TTurn extends ProviderPipelineTurn> {
  profileId?: string;
  state: TState;
  contract: ProviderTurnContract;
  stage: string;
  messages?: LlmChatRequest['messages'];
  options?: ProviderEmptyProposalRetryOptions;
  isEmptyResponseError(error: unknown): boolean;
  runTurn(
    profileId: string | undefined,
    state: TState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn>;
}

export class ProviderPipeline {
  constructor(private readonly emptyProposalRetry = new ProviderEmptyProposalRetry()) {}

  messages(contract: ProviderTurnContract): LlmChatRequest['messages'] {
    return [
      { role: 'system', content: contract.prompt.stablePrefix },
      { role: 'user', content: contract.prompt.dynamicSuffix },
    ];
  }

  runProposalOnly<TState, TTurn extends ProviderPipelineTurn>(
    input: ProviderPipelineRunTurnInput<TState, TTurn>
  ): Promise<TTurn> {
    return this.runWithRetry(input, {
      responseFormat: { type: 'json_object' },
      ...input.options,
    });
  }

  runWithNativeTools<TState, TTurn extends ProviderPipelineTurn>(
    input: ProviderPipelineRunTurnInput<TState, TTurn>
  ): Promise<TTurn> {
    return this.runWithRetry(input, {
      responseFormat: { type: 'json_object' },
      ...input.options,
    });
  }

  private runWithRetry<TState, TTurn extends ProviderPipelineTurn>(
    input: ProviderPipelineRunTurnInput<TState, TTurn>,
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn> {
    return this.emptyProposalRetry.runWithRetry({
      profileId: input.profileId,
      state: input.state,
      stage: input.stage,
      messages: input.messages ?? this.messages(input.contract),
      options,
      runTurn: input.runTurn,
      isEmptyResponseError: input.isEmptyResponseError,
    });
  }
}
