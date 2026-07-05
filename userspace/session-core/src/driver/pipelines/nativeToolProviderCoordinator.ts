import type {
  LlmChatRequest,
  ProjectionDelta,
  ToolDefinition,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type {
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type { ProviderEmptyProposalRetryOptions } from '../../provider/ProviderEmptyProposalRetry.js';
import type { NativeToolCoordinatorState } from '../../provider/NativeToolCoordinator.js';
import type {
  NativeToolTurnHandlerState,
  NativeToolTurnResult,
} from '../../provider/NativeToolTurnHandler.js';
import type {
  NativeToolCallProposal,
  NativeToolReadLedgerEntry,
  NativeToolReadSignature,
} from '../../provider/providerStreamParts.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ProviderTurnContract } from '../runFrame.js';
import type { NativeToolRepairDuplicate } from './nativeToolRepairCoordinator.js';
import type { NativeToolRepairRunner } from './nativeToolRepairRunner.js';
import type { NativeToolHandlerPortsFactory } from './nativeToolHandlerPortsFactory.js';
import type { NativeToolProviderLoop } from './nativeToolProviderLoop.js';

export interface NativeToolProviderCoordinatorState
  extends NativeToolTurnHandlerState,
    NativeToolCoordinatorState {
  acceptedImplementationPlan?: unknown;
  implementationBatch: { batchIndex: number };
  nativeToolDuplicateRepairAttempted: boolean;
}

export interface NativeToolProviderCoordinatorDependencies<
  TState extends NativeToolProviderCoordinatorState,
  TTurn extends NativeToolTurnResult,
> {
  providerLoop: NativeToolProviderLoop<TState, PromptEnvelope, TTurn>;
  handlerPortsFactory: NativeToolHandlerPortsFactory<TState, PromptEnvelope, TTurn>;
  repairRunner: NativeToolRepairRunner;
  providerTools(state: TState): ToolDefinition[];
  readManifest(state: TState, toolCall: NativeToolCallProposal): ResourceManifest;
  resolveResource(state: TState, manifest: ResourceManifest): Promise<ResourcePacket>;
  runTurn(
    profileId: string | undefined,
    state: TState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn>;
  isEmptyResponseError(error: unknown): boolean;
  consumeGuidanceMessages(state: TState, stage: string): Promise<LlmChatRequest['messages']>;
  emitProjectionDelta(state: TState, delta: ProjectionDelta): Promise<void>;
  buildSideEffectRepairMessages(
    prompt: PromptEnvelope,
    state: TState,
    toolCall: NativeToolCallProposal,
    turn: TTurn,
    acceptedExecution: boolean
  ): LlmChatRequest['messages'];
  buildDuplicateRepairMessages(
    prompt: PromptEnvelope,
    state: TState,
    turn: TTurn,
    duplicates: NativeToolRepairDuplicate[],
    acceptedExecution: boolean
  ): LlmChatRequest['messages'];
  runRepair(profileId: string | undefined, state: TState, stage: string, messages: LlmChatRequest['messages']): Promise<string>;
  repairErrorMessage(error: unknown): string;
  createError(code: string, message: string): Error;
}

export interface NativeToolProviderCoordinatorInput<TState extends NativeToolProviderCoordinatorState> {
  profileId?: string;
  state: TState;
  prompt: PromptEnvelope;
  contract: ProviderTurnContract;
}

export class NativeToolProviderCoordinator<
  TState extends NativeToolProviderCoordinatorState,
  TTurn extends NativeToolTurnResult,
> {
  constructor(private readonly dependencies: NativeToolProviderCoordinatorDependencies<TState, TTurn>) {}

  async run(input: NativeToolProviderCoordinatorInput<TState>): Promise<string | ProposalEnvelope> {
    return this.dependencies.providerLoop.run({
      profileId: input.profileId,
      state: input.state,
      prompt: input.prompt,
      contract: input.contract,
      providerTools: this.providerTools(input.state),
      runTurn: (profileId, runState, retryStage, retryMessages, options) =>
        this.dependencies.runTurn(profileId, runState, retryStage, retryMessages, options),
      isEmptyResponseError: this.dependencies.isEmptyResponseError,
      consumeGuidanceMessages: (runState, stage) =>
        this.dependencies.consumeGuidanceMessages(runState, stage),
      handlerPorts: this.dependencies.handlerPortsFactory.create({
        prompt: input.prompt,
        repairSideEffect: (runState, repairPrompt, toolCall, turn) =>
          this.repairSideEffect(input.profileId, runState, repairPrompt, toolCall, turn),
        tryParseTurnProposal: (runState, turn) =>
          this.dependencies.repairRunner.parseTurnProposal(runState, turn),
        repairDuplicate: (runState, repairPrompt, turn, duplicates) =>
          this.repairDuplicate(input.profileId, runState, repairPrompt, turn, duplicates),
        resolveReadToolCall: (runState, toolCall) =>
          this.resolveReadToolCall(runState, toolCall),
      }),
    });
  }

  private providerTools(state: TState) {
    return this.dependencies.providerTools(state);
  }

  private resolveReadToolCall(state: TState, toolCall: NativeToolCallProposal): Promise<ResourcePacket> {
    const manifest = this.dependencies.readManifest(state, toolCall);
    return this.dependencies.resolveResource(state, manifest);
  }

  private async repairSideEffect(
    profileId: string | undefined,
    state: TState,
    prompt: PromptEnvelope,
    toolCall: NativeToolCallProposal,
    turn: TTurn
  ): Promise<ProposalEnvelope> {
    const acceptedExecution = this.acceptedExecution(state);
    const result = await this.dependencies.repairRunner.repairSideEffect({
      state,
      toolCall,
      turn,
      acceptedExecution,
      emitProjectionDelta: (runState, delta) => this.dependencies.emitProjectionDelta(runState, delta),
      buildRepairMessages: (repairToolCall, repairTurn, repairAcceptedExecution) =>
        this.dependencies.buildSideEffectRepairMessages(prompt, state, repairToolCall, repairTurn, repairAcceptedExecution),
      runRepair: (stage, messages) => this.dependencies.runRepair(profileId, state, stage, messages),
      repairErrorMessage: (error) => this.dependencies.repairErrorMessage(error),
    });
    if (result.kind === 'proposal') return result.proposal;
    if (result.kind === 'failed') throw this.dependencies.createError(result.code, result.message);
    const exhaustive: never = result;
    return exhaustive;
  }

  private async repairDuplicate(
    profileId: string | undefined,
    state: TState,
    prompt: PromptEnvelope,
    turn: TTurn,
    duplicates: Array<{ toolCall: NativeToolCallProposal; signature: NativeToolReadSignature; entry: NativeToolReadLedgerEntry }>
  ): Promise<ProposalEnvelope> {
    const acceptedExecution = this.acceptedExecution(state);
    const result = await this.dependencies.repairRunner.repairDuplicate({
      state,
      turn,
      duplicates,
      duplicateRepairAttempted: state.nativeToolDuplicateRepairAttempted,
      markDuplicateRepairAttempted: () => {
        state.nativeToolDuplicateRepairAttempted = true;
      },
      emitProjectionDelta: (runState, delta) => this.dependencies.emitProjectionDelta(runState, delta),
      buildRepairMessages: (repairTurn, repairDuplicates, repairAcceptedExecution) =>
        this.dependencies.buildDuplicateRepairMessages(prompt, state, repairTurn, repairDuplicates, repairAcceptedExecution),
      runRepair: (stage, messages) => this.dependencies.runRepair(profileId, state, stage, messages),
      repairErrorMessage: (error) => this.dependencies.repairErrorMessage(error),
      acceptedExecution,
    });
    if (result.kind === 'proposal') return result.proposal;
    if (result.kind === 'failed') throw this.dependencies.createError(result.code, result.message);
    const exhaustive: never = result;
    return exhaustive;
  }

  private acceptedExecution(state: TState): boolean {
    return Boolean(state.acceptedImplementationPlan) || state.implementationBatch.batchIndex > 1;
  }
}
