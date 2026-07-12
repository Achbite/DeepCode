import type { LlmChatRequest } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type {
  ProviderRepairMessageBuilder,
  ProviderRepairMessageState,
} from '../../prompt/ProviderRepairMessageBuilder.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ContextFrameBuilder } from '../context/contextFrameBuilder.js';
import { prepareProviderSideCallMessagesContextAdmission } from '../context/providerSideCallContextAdmission.js';

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
  contextFrameBuilder: ContextFrameBuilder;
  repairState(state: State): ProviderRepairMessageState;
  createId(prefix: string): string;
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
    const allowedKinds = ['taskPlan', 'resourceRequest', 'decisionRequest', 'diagnostic'];
    const messages = this.input.repairMessageBuilder.actionBundleAdmissionRepairMessages(
      runInput.prompt,
      this.input.repairState(runInput.state),
      runInput.proposal,
      runInput.reasons
    );
    const admission = prepareProviderSideCallMessagesContextAdmission({
      state: runInput.state,
      prompt: runInput.prompt,
      contextFrameBuilder: this.input.contextFrameBuilder,
      contractId: this.input.createId('provider-turn-contract-action-bundle-admission-repair'),
      turnMode: 'protocolRepair',
      allowedKinds,
      messages,
      repairPolicy: 'sameKindOnly',
      projectionVisibility: 'developerOnly',
      nextActionInstruction: `Repair actionBundle admission without executing work. Return one of: ${allowedKinds.join(', ')}.`,
    });
    const raw = await runInput.runRepair('action_bundle_admission_repair', admission.messages);
    try {
      return this.input.parseRepairedProposal({
        raw,
        state: runInput.state,
        allowedKinds,
      });
    } catch (error) {
      throw this.input.createError(
        'action_bundle_admission_repair_failed',
        this.input.parseError(error).message
      );
    }
  }
}
