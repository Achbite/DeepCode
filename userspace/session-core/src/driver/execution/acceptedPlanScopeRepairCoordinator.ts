import type { LlmChatRequest } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type {
  ProviderRepairMessageBuilder,
  ProviderRepairMessageState,
} from '../../prompt/ProviderRepairMessageBuilder.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { AcceptedPlanBatchValidationResult } from '../../accepted-plan/types.js';

export interface AcceptedPlanScopeRepairCoordinatorState {
  sessionId: string;
  runId: string;
  userRequest: string;
}

export interface AcceptedPlanScopeRepairParseError {
  code: string;
  message: string;
}

export interface AcceptedPlanScopeRepairCoordinatorInput<State extends AcceptedPlanScopeRepairCoordinatorState> {
  repairMessageBuilder: ProviderRepairMessageBuilder;
  repairState(state: State): ProviderRepairMessageState;
  parseError(error: unknown): AcceptedPlanScopeRepairParseError;
  createError(code: string, message: string): Error;
  parseRepairedProposal(input: {
    raw: string;
    state: State;
    allowedKinds: string[];
  }): ProposalEnvelope;
}

export interface AcceptedPlanScopeRepairRunInput<State extends AcceptedPlanScopeRepairCoordinatorState> {
  state: State;
  prompt: PromptEnvelope;
  proposal: ProposalEnvelope;
  validation: AcceptedPlanBatchValidationResult;
  runRepair(stage: string, messages: LlmChatRequest['messages']): Promise<string>;
}

export class AcceptedPlanScopeRepairCoordinator<
  State extends AcceptedPlanScopeRepairCoordinatorState = AcceptedPlanScopeRepairCoordinatorState
> {
  constructor(private readonly input: AcceptedPlanScopeRepairCoordinatorInput<State>) {}

  async repair(runInput: AcceptedPlanScopeRepairRunInput<State>): Promise<ProposalEnvelope> {
    const raw = await runInput.runRepair(
      'accepted_plan_scope_repair',
      this.input.repairMessageBuilder.acceptedPlanScopeRepairMessages(
        runInput.prompt,
        this.input.repairState(runInput.state),
        runInput.proposal,
        runInput.validation.reasons
      )
    );
    try {
      return this.input.parseRepairedProposal({
        raw,
        state: runInput.state,
        allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
      });
    } catch (error) {
      throw this.input.createError(
        'accepted_plan_scope_repair_failed',
        `Accepted-plan scope repair output still could not be parsed after repair: ${this.input.parseError(error).message}`
      );
    }
  }
}
