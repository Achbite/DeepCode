import type { LlmChatRequest } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type {
  ProviderRepairMessageBuilder,
  ProviderRepairMessageState,
} from '../../prompt/ProviderRepairMessageBuilder.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ContextFrameBuilder } from './contextFrameBuilder.js';
import { prepareProviderSideCallMessagesContextAdmission } from './providerSideCallContextAdmission.js';

export interface ResourceRequestRepairCoordinatorState {
  sessionId: string;
  runId: string;
  userRequest: string;
}

export interface ResourceRequestRepairParseError {
  code: string;
  message: string;
}

export interface ResourceRequestRepairCoordinatorInput<State extends ResourceRequestRepairCoordinatorState> {
  repairMessageBuilder: ProviderRepairMessageBuilder;
  contextFrameBuilder: ContextFrameBuilder;
  repairState(state: State): ProviderRepairMessageState;
  createId(prefix: string): string;
  parseError(error: unknown): ResourceRequestRepairParseError;
  createError(code: string, message: string): Error;
  parseRepairedProposal(input: {
    raw: string;
    state: State;
    allowedKinds: string[];
  }): ProposalEnvelope;
}

export interface ResourceRequestRepairRunInput<State extends ResourceRequestRepairCoordinatorState> {
  state: State;
  prompt: PromptEnvelope;
  proposal: ProposalEnvelope;
  resolutionDiagnostic: string;
  runRepair(stage: string, messages: LlmChatRequest['messages']): Promise<string>;
}

export class ResourceRequestRepairCoordinator<
  State extends ResourceRequestRepairCoordinatorState = ResourceRequestRepairCoordinatorState
> {
  constructor(private readonly input: ResourceRequestRepairCoordinatorInput<State>) {}

  async repair(runInput: ResourceRequestRepairRunInput<State>): Promise<ProposalEnvelope> {
    const allowedKinds = ['resourceRequest', 'decisionRequest', 'diagnostic'];
    const messages = this.input.repairMessageBuilder.resourceRequestRepairMessages(
      runInput.prompt,
      this.input.repairState(runInput.state),
      runInput.proposal,
      runInput.resolutionDiagnostic
    );
    const admission = prepareProviderSideCallMessagesContextAdmission({
      state: runInput.state,
      prompt: runInput.prompt,
      contextFrameBuilder: this.input.contextFrameBuilder,
      contractId: this.input.createId('provider-turn-contract-resource-request-repair'),
      turnMode: 'protocolRepair',
      allowedKinds,
      messages,
      repairPolicy: 'sameKindOnly',
      projectionVisibility: 'developerOnly',
      nextActionInstruction: `Repair the resourceRequest proposal only. Return one of: ${allowedKinds.join(', ')}.`,
    });
    const raw = await runInput.runRepair('resource_request_repair', admission.messages);
    try {
      return this.input.parseRepairedProposal({
        raw,
        state: runInput.state,
        allowedKinds,
      });
    } catch (error) {
      throw this.input.createError(
        'agent_protocol_repair_failed',
        `Model resourceRequest output still could not be parsed after repair: ${this.input.parseError(error).message}`
      );
    }
  }
}
