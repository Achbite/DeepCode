import type {
  AgentEvent,
  AgentSessionResult,
  LlmChatRequest,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { ProviderEmptyProposalRetryOptions } from '../../provider/ProviderEmptyProposalRetry.js';
import type { NativeToolTurnResult } from '../../provider/NativeToolTurnHandler.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import type {
  NativeToolProviderCoordinator,
  NativeToolProviderCoordinatorState,
} from './nativeToolProviderCoordinator.js';
import type { NativeToolProviderResumeSignal } from './nativeToolProviderLoop.js';
import type {
  ProposalOnlyProviderRunner,
  ProposalOnlyProviderTurn,
} from './proposalOnlyProviderRunner.js';
import type {
  ProviderTurnRunner,
  ProviderTurnRunnerPorts,
  ProviderTurnRunnerState,
} from './providerTurnRunner.js';

export interface ProviderRuntimeGuidanceResume {
  events: AgentEvent[];
  messages: LlmChatRequest['messages'];
}

export interface ProviderRuntimeBridgePorts<State> extends ProviderTurnRunnerPorts {
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  emitProjectionDelta(state: State, delta: ProjectionDelta): Promise<void>;
  consumeGuidanceMessages(state: State, stage: string): Promise<LlmChatRequest['messages']>;
  acceptedPlanId(state: State): string | undefined;
  buildProposalOnlyRepairMessages(input: {
    prompt: PromptEnvelope;
    state: State;
    toolCall: NativeToolCallProposal;
    turn: ProposalOnlyProviderTurn;
  }): LlmChatRequest['messages'];
  repairErrorMessage(error: unknown): string;
  createError(code: string, message: string): Error;
  isEmptyResponseError(error: unknown): boolean;
}

export interface ProviderRuntimeBridgeDependencies<
  State extends ProviderTurnRunnerState & NativeToolProviderCoordinatorState,
  Turn extends ProposalOnlyProviderTurn & NativeToolTurnResult,
> {
  nativeToolProviderCoordinator: NativeToolProviderCoordinator<State, Turn>;
  proposalOnlyProviderRunner: ProposalOnlyProviderRunner<State, Turn>;
  providerTurnRunner: ProviderTurnRunner<State>;
}

export class ProviderRuntimeBridge<
  State extends ProviderTurnRunnerState & NativeToolProviderCoordinatorState,
  Turn extends ProposalOnlyProviderTurn & NativeToolTurnResult,
> {
  constructor(
    private readonly dependencies: ProviderRuntimeBridgeDependencies<State, Turn>,
    private readonly ports: ProviderRuntimeBridgePorts<State>
  ) {}

  runWithNativeTools(input: {
    profileId?: string;
    state: State;
    prompt: PromptEnvelope;
    contract: DriverProviderTurnFrame;
  }): Promise<string | ProposalEnvelope | NativeToolProviderResumeSignal> {
    return this.dependencies.nativeToolProviderCoordinator.run(input);
  }

  async runProposalOnly(input: {
    profileId?: string;
    state: State;
    prompt: PromptEnvelope;
    contract: DriverProviderTurnFrame;
    stage: string;
    messages?: LlmChatRequest['messages'];
  }): Promise<string | ProposalEnvelope> {
    const result = await this.dependencies.proposalOnlyProviderRunner.run({
      profileId: input.profileId,
      state: input.state,
      contract: input.contract,
      stage: input.stage,
      messages: input.messages,
      runTurn: (profileId, runState, retryStage, retryMessages, options) =>
        this.llmTurn(profileId, runState, retryStage, retryMessages, options),
      isEmptyResponseError: (error) => this.ports.isEmptyResponseError(error),
      acceptedPlanId: this.ports.acceptedPlanId(input.state),
      emitProjectionDelta: (state, delta) => this.ports.emitProjectionDelta(state, delta),
      buildRepairMessages: (toolCall, turn) =>
        this.ports.buildProposalOnlyRepairMessages({
          prompt: input.prompt,
          state: input.state,
          toolCall,
          turn,
        }),
      runRepair: (repairStage, repairMessages) =>
        this.llm(input.profileId, input.state, repairStage, repairMessages),
      repairErrorMessage: (error) => this.ports.repairErrorMessage(error),
    });
    if (result.kind === 'content') return result.content;
    if (result.kind === 'proposal') return result.proposal;
    if (result.kind === 'repairFailed') {
      throw this.ports.createError(
        'accepted_plan_provider_tool_violation',
        `Complete-stage provider requested native tool ${result.toolCall.name}; proposal-only repair failed: ${result.message}`
      );
    }
    const exhaustive: never = result;
    return exhaustive;
  }

  async llm(
    profileId: string | undefined,
    state: State,
    stage: string,
    messages: LlmChatRequest['messages']
  ): Promise<string> {
    const turn = await this.llmTurn(profileId, state, stage, messages, {
      responseFormat: { type: 'json_object' },
    });
    if (!turn.content.trim()) {
      throw this.ports.createError('llm_empty_response', 'LLM provider returned an empty response.');
    }
    return turn.content;
  }

  llmTurn(
    profileId: string | undefined,
    state: State,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: Pick<LlmChatRequest, 'responseFormat' | 'tools'> = {}
  ): Promise<Turn> {
    return this.dependencies.providerTurnRunner.run({
      profileId,
      state,
      stage,
      messages,
      options,
      ports: this.ports,
    }) as unknown as Promise<Turn>;
  }

  consumeGuidanceMessages(state: State, stage: string): Promise<LlmChatRequest['messages']> {
    return this.ports.consumeGuidanceMessages(state, stage);
  }
}
