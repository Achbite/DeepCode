import type {
  AgentSessionResult,
  LlmChatRequest,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type {
  AcceptedImplementationPlanContext,
  CurrentTaskContext,
  TaskExecutionCursor,
} from '../../accepted-plan/types.js';
import type { ContextAssemblyRecord } from '../../context/index.js';
import type { ResourcePacket } from '../../context/types.js';
import {
  ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS,
  type AcceptedPlanResourceResumePromptBuilder,
} from '../../prompt/AcceptedPlanResourceResumePromptBuilder.js';
import type {
  ProviderRepairMessageBuilder,
  ProviderRepairMessageState,
} from '../../prompt/ProviderRepairMessageBuilder.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import type { ContextFrameBuilder } from './contextFrameBuilder.js';
import { prepareProviderSideCallContextAdmission } from './providerSideCallContextAdmission.js';

export interface AcceptedPlanResourceResumeCoordinatorState {
  sessionId: string;
  runId: string;
  userRequest: string;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  contextAssembly?: ContextAssemblyRecord;
  resourcePackets: ResourcePacket[];
  generatedArtifactEvidence: { size: number };
  providerTurnFrame?: DriverProviderTurnFrame;
}

export interface AcceptedPlanResourceResumeParseError {
  code: string;
  message: string;
}

export interface AcceptedPlanResourceResumeCoordinatorInput<State extends AcceptedPlanResourceResumeCoordinatorState> {
  promptBuilder: AcceptedPlanResourceResumePromptBuilder;
  contextFrameBuilder: ContextFrameBuilder;
  repairMessageBuilder: ProviderRepairMessageBuilder;
  repairState(state: State): ProviderRepairMessageState;
  createId(prefix: string): string;
  parseError(error: unknown): AcceptedPlanResourceResumeParseError;
  createError(code: string, message: string): Error;
  appendRepairNotice(state: State, message: string): Promise<AgentSessionResult | undefined>;
  parseProviderProposal(input: {
    raw: string;
    state: State;
  }): ProposalEnvelope;
  parseRepairedProviderProposal(input: {
    raw: string;
    state: State;
    allowedKinds: string[];
  }): ProposalEnvelope;
}

export interface AcceptedPlanResourceResumeRunInput<State extends AcceptedPlanResourceResumeCoordinatorState> {
  state: State;
  prompt: PromptEnvelope;
  userRequest: string;
  requestProposal: ProposalEnvelope;
  packet: ResourcePacket;
  callProposalOnly(input: {
    state: State;
    prompt: PromptEnvelope;
    contract: DriverProviderTurnFrame;
    stage: string;
    messages: LlmChatRequest['messages'];
  }): Promise<string | ProposalEnvelope>;
  runRepair(stage: string, messages: LlmChatRequest['messages']): Promise<string>;
}

export class AcceptedPlanResourceResumeCoordinator<
  State extends AcceptedPlanResourceResumeCoordinatorState = AcceptedPlanResourceResumeCoordinatorState
> {
  constructor(private readonly input: AcceptedPlanResourceResumeCoordinatorInput<State>) {}

  async run(runInput: AcceptedPlanResourceResumeRunInput<State>): Promise<ProposalEnvelope> {
    const admission = this.contextAdmission(runInput);
    const providerResult = await runInput.callProposalOnly({
      state: runInput.state,
      prompt: admission.prompt,
      contract: admission.contract,
      stage: 'accepted_plan_resource_resume',
      messages: admission.messages,
    });
    if (typeof providerResult !== 'string') return providerResult;

    try {
      return this.input.parseProviderProposal({
        raw: providerResult,
        state: runInput.state,
      });
    } catch (error) {
      const parseError = this.input.parseError(error);
      await this.input.appendRepairNotice(
        runInput.state,
        `Accepted-plan resource resume output requires Agent Protocol v3 repair: ${parseError.message}`
      );
      const repairedRaw = await runInput.runRepair(
        'accepted_plan_resource_resume_repair',
        this.input.repairMessageBuilder.repairMessages(
          runInput.prompt,
          this.input.repairState(runInput.state),
          providerResult,
          parseError
        )
      );
      try {
        return this.input.parseRepairedProviderProposal({
          raw: repairedRaw,
          state: runInput.state,
          allowedKinds: [...ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS],
        });
      } catch (repairError) {
        throw this.input.createError(
          'accepted_plan_resource_resume_repair_failed',
          `Accepted-plan resource resume output still could not be parsed after repair: ${this.input.parseError(repairError).message}`
        );
      }
    }
  }

  private contextAdmission(runInput: AcceptedPlanResourceResumeRunInput<State>): {
    prompt: PromptEnvelope;
    contract: DriverProviderTurnFrame;
    messages: LlmChatRequest['messages'];
  } {
    const dynamicContent = this.input.promptBuilder.render({
      repairState: this.input.repairState(runInput.state),
      acceptedPlan: runInput.state.acceptedImplementationPlan,
      cursor: runInput.state.taskExecutionCursor,
      currentTask: runInput.state.currentTaskContext,
      requestProposal: runInput.requestProposal,
      packet: runInput.packet,
    });
    const admission = prepareProviderSideCallContextAdmission({
      state: runInput.state,
      prompt: runInput.prompt,
      contextFrameBuilder: this.input.contextFrameBuilder,
      contractId: this.input.createId('provider-turn-contract-resource-resume'),
      turnMode: 'resourceResume',
      allowedKinds: [...ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS],
      dynamicContent,
      contextAssembly: runInput.state.contextAssembly,
      userRequest: runInput.userRequest,
      currentTaskContext: runInput.state.currentTaskContext,
      resourcePackets: runInput.state.resourcePackets,
      generatedArtifactCount: runInput.state.generatedArtifactEvidence.size,
      repairPolicy: 'diagnosticOnly',
      nextActionInstruction: `Use the newly resolved ResourcePacket for the current accepted task. Return one of: ${ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS.join(', ')}.`,
    });
    return {
      prompt: admission.prompt,
      contract: admission.contract,
      messages: admission.messages,
    };
  }
}
