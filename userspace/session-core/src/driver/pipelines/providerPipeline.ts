import type { LlmChatRequest } from '@deepcode/protocol';
import type {
  ProviderContextFrame,
  ProviderTurnContract,
  ToolIntentTemplate,
} from '../runFrame.js';
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
export { NativeToolProjectionBuilder } from './nativeToolProjectionBuilder.js';
export { NativeToolResultMessageBuilder } from './nativeToolResultMessageBuilder.js';
export { NativeToolResourceRecorder } from './nativeToolResourceRecorder.js';
export { NativeToolResumeMessageBuilder } from './nativeToolResumeMessageBuilder.js';
export { ProposalOnlyProviderRunner } from './proposalOnlyProviderRunner.js';
export { ProviderProposalCoordinator } from './providerProposalCoordinator.js';
export { ProviderStreamCoordinator } from './providerStreamCoordinator.js';
export { ProviderStreamRuntime, type ProviderReasoningDeltaBuffer } from './providerStreamRuntime.js';
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
    contract: ProviderTurnContract
  ): LlmChatRequest['messages'] {
    if (!messages.length) return this.messages(contract);
    const lastIndex = messages.length - 1;
    const lastMessage = messages[lastIndex];
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

  private renderUserPrompt(dynamicContent: string, contract: ProviderTurnContract): string {
    return [
      dynamicContent,
      'ProviderTurnContract:',
      fencedJson({
        schemaVersion: contract.schemaVersion,
        contractId: contract.contractId,
        turnMode: contract.turnMode,
        allowedKinds: contract.allowedKinds,
        ...(contract.requiredKind ? { requiredKind: contract.requiredKind } : {}),
        repairPolicy: contract.repairPolicy,
        projectionVisibility: contract.projectionVisibility,
        frames: contract.frames.map(renderFrame),
        toolIntentTemplates: contract.toolIntentTemplates.map(renderToolIntentTemplate),
        nextActionInstruction: contract.nextActionInstruction.summary ?? '',
      }),
      [
        'Provider turn instruction:',
        contract.nextActionInstruction.summary ?? '',
      ].join('\n'),
    ].filter((part) => part.trim()).join('\n\n');
  }
}

function renderFrame(frame: ProviderContextFrame): Record<string, unknown> {
  return {
    kind: frame.kind,
    source: frame.source,
    trust: frame.trust,
    ...(frame.scope ? { scope: frame.scope } : {}),
    use: frame.use,
    ...(frame.summary ? { summary: frame.summary } : {}),
    ...(frame.refs?.length ? { refs: frame.refs } : {}),
    ...(frame.data ? { data: frame.data } : {}),
  };
}

function renderToolIntentTemplate(template: ToolIntentTemplate): Record<string, unknown> {
  return {
    intentId: template.intentId,
    label: template.label,
    operation: template.operation,
    targets: template.targets,
    ...(template.evidencePolicy ? { evidencePolicy: template.evidencePolicy } : {}),
  };
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
