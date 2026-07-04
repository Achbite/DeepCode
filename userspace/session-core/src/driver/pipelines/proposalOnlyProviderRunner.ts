import type {
  LlmChatRequest,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type { ProviderEmptyProposalRetryOptions } from '../../provider/ProviderEmptyProposalRetry.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import type {
  ProviderPipelineRunTurnInput,
  ProviderPipelineTurn,
} from './providerPipeline.js';
import type { ProviderTurnContract } from '../runFrame.js';

export interface ProposalOnlyProviderState {
  sessionId: string;
  runId: string;
}

export interface ProposalOnlyProviderTurn extends ProviderPipelineTurn {
  toolCalls: NativeToolCallProposal[];
}

export interface ProposalOnlyProviderPipelineLike<
  TState extends ProposalOnlyProviderState,
  TTurn extends ProposalOnlyProviderTurn,
> {
  runProposalOnly(input: ProviderPipelineRunTurnInput<TState, TTurn>): Promise<TTurn>;
}

export interface ProposalOnlyToolViolationCoordinatorLike {
  proposalOnlyToolViolationDelta(input: {
    sessionId: string;
    runId: string;
    stage: string;
    acceptedPlanId?: string;
    toolCall: NativeToolCallProposal;
  }): ProjectionDelta;
  parseProposalOnlyRepair(input: {
    raw: string;
    runId: string;
    sessionId: string;
  }): ProposalEnvelope;
}

export type ProposalOnlyProviderRunnerResult =
  | { kind: 'content'; content: string }
  | { kind: 'proposal'; proposal: ProposalEnvelope }
  | { kind: 'repairFailed'; toolCall: NativeToolCallProposal; message: string };

export interface ProposalOnlyProviderRunnerDependencies<
  TState extends ProposalOnlyProviderState,
  TTurn extends ProposalOnlyProviderTurn,
> {
  providerPipeline: ProposalOnlyProviderPipelineLike<TState, TTurn>;
  repairCoordinator: ProposalOnlyToolViolationCoordinatorLike;
}

export interface ProposalOnlyProviderRunnerInput<
  TState extends ProposalOnlyProviderState,
  TTurn extends ProposalOnlyProviderTurn,
> {
  profileId?: string;
  state: TState;
  contract: ProviderTurnContract;
  stage: string;
  messages?: LlmChatRequest['messages'];
  acceptedPlanId?: string;
  runTurn(
    profileId: string | undefined,
    state: TState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn>;
  isEmptyResponseError(error: unknown): boolean;
  emitProjectionDelta(state: TState, delta: ProjectionDelta): Promise<void>;
  buildRepairMessages(toolCall: NativeToolCallProposal, turn: TTurn): LlmChatRequest['messages'];
  runRepair(stage: string, messages: LlmChatRequest['messages']): Promise<string>;
  repairErrorMessage(error: unknown): string;
}

export class ProposalOnlyProviderRunner<
  TState extends ProposalOnlyProviderState,
  TTurn extends ProposalOnlyProviderTurn,
> {
  constructor(private readonly dependencies: ProposalOnlyProviderRunnerDependencies<TState, TTurn>) {}

  async run(input: ProposalOnlyProviderRunnerInput<TState, TTurn>): Promise<ProposalOnlyProviderRunnerResult> {
    const effectiveTurn = await this.dependencies.providerPipeline.runProposalOnly({
      profileId: input.profileId,
      state: input.state,
      contract: input.contract,
      stage: input.stage,
      messages: input.messages,
      runTurn: input.runTurn,
      isEmptyResponseError: input.isEmptyResponseError,
    });
    if (effectiveTurn.toolCalls.length === 0) {
      return { kind: 'content', content: effectiveTurn.content };
    }

    const firstToolCall = effectiveTurn.toolCalls[0];
    if (!firstToolCall) {
      return { kind: 'content', content: effectiveTurn.content };
    }
    await input.emitProjectionDelta(input.state, this.dependencies.repairCoordinator.proposalOnlyToolViolationDelta({
      sessionId: input.state.sessionId,
      runId: input.state.runId,
      stage: input.stage,
      acceptedPlanId: input.acceptedPlanId,
      toolCall: firstToolCall,
    }));
    const repairedRaw = await input.runRepair(
      `${input.stage}_tool_violation_repair`,
      input.buildRepairMessages(firstToolCall, effectiveTurn)
    );
    try {
      return {
        kind: 'proposal',
        proposal: this.dependencies.repairCoordinator.parseProposalOnlyRepair({
          raw: repairedRaw,
          runId: input.state.runId,
          sessionId: input.state.sessionId,
        }),
      };
    } catch (error) {
      return {
        kind: 'repairFailed',
        toolCall: firstToolCall,
        message: input.repairErrorMessage(error),
      };
    }
  }
}
