import type { LlmChatRequest } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type {
  ProviderRepairMessageBuilder,
  ProviderRepairMessageState,
} from '../../prompt/ProviderRepairMessageBuilder.js';
import type { PromptEnvelope } from '../../prompt/types.js';

export interface ActionBundleAdmissionRepairCoordinatorState {
  sessionId: string;
  runId: string;
  userRequest: string;
}

export interface ActionBundleAdmissionRepairParseError {
  code: string;
  message: string;
}

export interface ActionBundleAdmissionRepairCoordinatorInput<State extends ActionBundleAdmissionRepairCoordinatorState> {
  repairMessageBuilder: ProviderRepairMessageBuilder;
  repairState(state: State): ProviderRepairMessageState;
  parseError(error: unknown): ActionBundleAdmissionRepairParseError;
  createError(code: string, message: string): Error;
  parseRepairedProposal(input: {
    raw: string;
    state: State;
    allowedKinds: string[];
  }): ProposalEnvelope;
}

export interface ActionBundleAdmissionRepairRunInput<State extends ActionBundleAdmissionRepairCoordinatorState> {
  state: State;
  prompt: PromptEnvelope;
  proposal: ProposalEnvelope;
  reasons: string[];
  runRepair(stage: string, messages: LlmChatRequest['messages']): Promise<string>;
}

export class ActionBundleAdmissionRepairCoordinator<
  State extends ActionBundleAdmissionRepairCoordinatorState = ActionBundleAdmissionRepairCoordinatorState
> {
  constructor(private readonly input: ActionBundleAdmissionRepairCoordinatorInput<State>) {}

  async repair(runInput: ActionBundleAdmissionRepairRunInput<State>): Promise<ProposalEnvelope> {
    const raw = await runInput.runRepair(
      'action_bundle_admission_repair',
      this.input.repairMessageBuilder.actionBundleAdmissionRepairMessages(
        runInput.prompt,
        this.input.repairState(runInput.state),
        runInput.proposal,
        runInput.reasons
      )
    );
    try {
      return this.input.parseRepairedProposal({
        raw,
        state: runInput.state,
        allowedKinds: ['taskPlan', 'resourceRequest', 'decisionRequest', 'diagnostic'],
      });
    } catch (error) {
      throw this.input.createError(
        'action_bundle_admission_repair_failed',
        this.input.parseError(error).message
      );
    }
  }
}
