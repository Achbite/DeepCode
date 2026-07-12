import type { LlmChatRequest } from '@deepcode/protocol';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import { renderProviderTurnUserPrompt } from '../context/providerTurnPromptRenderer.js';
import {
  ProviderEmptyProposalRetry,
  type ProviderEmptyProposalRetryOptions,
} from '../../provider/ProviderEmptyProposalRetry.js';

export { ProviderJsonModeCoordinator } from './providerJsonModeCoordinator.js';
export {
  NativeToolRepairCoordinator,
  type NativeToolRepairDuplicate,
  type NativeToolTurnProposalLike,
} from './nativeToolRepairCoordinator.js';
export { NativeToolRepairRunner } from './nativeToolRepairRunner.js';
export { NativeToolHandlerPortsFactory } from './nativeToolHandlerPortsFactory.js';
export { NativeToolProgressEventBuilder } from './nativeToolProgressEventBuilder.js';
export { NativeToolProviderLoop } from './nativeToolProviderLoop.js';
export { NativeToolProviderCoordinator } from './nativeToolProviderCoordinator.js';
export { NativeToolExposurePolicy } from './nativeToolExposurePolicy.js';
export { NativeToolProjectionBuilder } from './nativeToolProjectionBuilder.js';
export { NativeToolResultMessageBuilder } from './nativeToolResultMessageBuilder.js';
export { NativeToolResourceRecorder } from './nativeToolResourceRecorder.js';
export { NativeToolResumeMessageBuilder } from './nativeToolResumeMessageBuilder.js';
export { ProposalOnlyProviderRunner } from './proposalOnlyProviderRunner.js';
export { ProviderProposalCoordinator } from './providerProposalCoordinator.js';
export { ProviderStreamCoordinator } from './providerStreamCoordinator.js';
export { ProviderStreamRuntime, type ProviderReasoningDeltaBuffer } from './providerStreamRuntime.js';
export { ProviderTurnPolicy } from './providerTurnPolicy.js';
export { ProviderTurnRunner, type ProviderTurnResult } from './providerTurnRunner.js';
export { ProviderTraceRecorder } from './providerTraceRecorder.js';

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
  contract: DriverProviderTurnFrame;
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
  constructor(
    private readonly emptyProposalRetry = new ProviderEmptyProposalRetry()
  ) {}

  messages(contract: DriverProviderTurnFrame): LlmChatRequest['messages'] {
    // ContextAdmission owns the complete provider system prefix and its physical cache shape.
    return [
      { role: 'system', content: contract.prompt.stablePrefix },
      { role: 'user', content: this.renderUserPrompt(contract.prompt.dynamicSuffix, contract) },
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
    return this.runWithRetry(input, input.options ?? {});
  }

  private runWithRetry<TState, TTurn extends ProviderPipelineTurn>(
    input: ProviderPipelineRunTurnInput<TState, TTurn>,
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn> {
    return this.emptyProposalRetry.runWithRetry({
      profileId: input.profileId,
      state: input.state,
      stage: input.stage,
      messages: input.messages
        ? this.withContractFrame(input.messages, input.contract)
        : this.messages(input.contract),
      options,
      runTurn: input.runTurn,
      isEmptyResponseError: input.isEmptyResponseError,
    });
  }

  private withContractFrame(
    messages: LlmChatRequest['messages'],
    contract: DriverProviderTurnFrame
  ): LlmChatRequest['messages'] {
    if (!messages.length) return this.messages(contract);
    const lastIndex = messages.length - 1;
    const lastMessage = messages[lastIndex];
    if (lastMessage?.role === 'user' && typeof lastMessage.content === 'string' && lastMessage.content.includes('ProviderTurnContract:')) {
      return messages;
    }
    if (lastMessage?.role !== 'user' || typeof lastMessage.content !== 'string') {
      return [
        ...messages,
        { role: 'user', content: this.renderUserPrompt('', contract) },
      ];
    }
    return messages.map((message, index) => {
      if (index !== lastIndex) return message;
      return {
        ...message,
        content: this.renderUserPrompt(message.content, contract),
      };
    });
  }

  private renderUserPrompt(dynamicContent: string, contract: DriverProviderTurnFrame): string {
    return renderProviderTurnUserPrompt(dynamicContent, contract);
  }
}
