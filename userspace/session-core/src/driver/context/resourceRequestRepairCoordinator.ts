import type { LlmChatRequest } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type {
  ProviderRepairMessageBuilder,
  ProviderRepairMessageState,
} from '../../prompt/ProviderRepairMessageBuilder.js';
import type { PromptEnvelope } from '../../prompt/types.js';

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
  repairState(state: State): ProviderRepairMessageState;
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
    const raw = await runInput.runRepair(
      'resource_request_repair',
      this.input.repairMessageBuilder.resourceRequestRepairMessages(
        runInput.prompt,
        this.input.repairState(runInput.state),
        runInput.proposal,
        runInput.resolutionDiagnostic
      )
    );
    try {
      return this.input.parseRepairedProposal({
        raw,
        state: runInput.state,
        allowedKinds: ['resourceRequest', 'decisionRequest', 'diagnostic'],
      });
    } catch (error) {
      throw this.input.createError(
        'agent_protocol_repair_failed',
        `Model resourceRequest output still could not be parsed after repair: ${this.input.parseError(error).message}`
      );
    }
  }
}
