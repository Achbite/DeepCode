import type {
  LlmChatRequest,
  ToolDefinition,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { ProviderEmptyProposalRetryOptions } from '../../provider/ProviderEmptyProposalRetry.js';
import type {
  NativeToolTurnHandlerInput,
  NativeToolTurnHandlerPorts,
  NativeToolTurnHandlerState,
  NativeToolTurnResult,
  NativeToolHandlingResult,
} from '../../provider/NativeToolTurnHandler.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import type {
  ProviderPipelineRunTurnInput,
  ProviderPipelineTurn,
} from './providerPipeline.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import { SessionSemanticDirectiveError } from '../../provider/SessionSemanticToolAdapter.js';
import type { AcceptedTaskReplanReason } from '../execution/artifactDraftReplanCoordinator.js';

export interface NativeToolProviderPipelineLike<
  TState extends NativeToolTurnHandlerState,
  TTurn extends ProviderPipelineTurn,
> {
  messages(contract: DriverProviderTurnFrame): LlmChatRequest['messages'];
  runWithNativeTools(input: ProviderPipelineRunTurnInput<TState, TTurn>): Promise<TTurn>;
}

export interface NativeToolProviderResumeSignal {
  readonly kind: 'providerResume';
}

export interface NativeToolProviderLoopState extends NativeToolTurnHandlerState {
  semanticDirectiveRepairAttempted?: boolean;
  semanticDirectiveErrorSummary?: string;
  artifactChunkRepairAttempts?: Record<string, number>;
  semanticDirectiveRepairAttempts?: Record<string, number>;
  resourceEvidenceRevision?: number;
  taskPlanReplanReason?: AcceptedTaskReplanReason;
}

export interface NativeToolProviderTurnHandlerLike<
  TState extends NativeToolTurnHandlerState,
  TPrompt,
  TTurn extends NativeToolTurnResult,
> {
  handle(input: NativeToolTurnHandlerInput<TState, TPrompt, TTurn>): Promise<NativeToolHandlingResult>;
}

export interface NativeToolProviderLoopDependencies<
  TState extends NativeToolProviderLoopState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  providerPipeline: NativeToolProviderPipelineLike<TState, TTurn>;
  turnHandler: NativeToolProviderTurnHandlerLike<TState, TPrompt, TTurn>;
}

export interface NativeToolProviderLoopInput<
  TState extends NativeToolProviderLoopState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  profileId?: string;
  state: TState;
  prompt: TPrompt;
  contract: DriverProviderTurnFrame;
  providerTools: ToolDefinition[];
  handlerPorts: NativeToolTurnHandlerPorts<TState>;
  runTurn(
    profileId: string | undefined,
    state: TState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn>;
  isEmptyResponseError(error: unknown): boolean;
  semanticDirectiveError(error: unknown): { code: string; message: string } | undefined;
  onArtifactDraftBudgetExceeded(state: TState, error: SessionSemanticDirectiveError): Promise<void>;
  createError?(code: string, message: string): Error;
}

export class NativeToolProviderLoop<
  TState extends NativeToolProviderLoopState,
  TPrompt,
  TTurn extends ProviderPipelineTurn & NativeToolTurnResult,
> {
  constructor(private readonly dependencies: NativeToolProviderLoopDependencies<TState, TPrompt, TTurn>) {}

  async run(
    input: NativeToolProviderLoopInput<TState, TPrompt, TTurn>
  ): Promise<ProposalEnvelope | NativeToolProviderResumeSignal> {
    let effectiveTurn: TTurn;
    try {
      effectiveTurn = await this.dependencies.providerPipeline.runWithNativeTools({
        profileId: input.profileId,
        state: input.state,
        contract: input.contract,
        stage: 'provider_call',
        messages: this.dependencies.providerPipeline.messages(input.contract),
        options: { tools: input.providerTools },
        runTurn: input.runTurn,
        isEmptyResponseError: input.isEmptyResponseError,
      });
    } catch (error) {
      const directiveError = input.semanticDirectiveError(error);
      if (!directiveError) throw error;
      return this.scheduleSameProfileRetry(input, [
        `code=${directiveError.code}`,
        `fieldErrors=${directiveError.message}`,
      ], directiveError.code, directiveError.code);
    }
    const toolCalls = effectiveTurn.toolCalls as NativeToolCallProposal[];
    const registeredNames = new Set(input.providerTools.map((tool) => tool.name));
    const unregistered = toolCalls.find((toolCall) => !registeredNames.has(toolCall.name));
    if (unregistered) {
      return this.scheduleSameProfileRetry(input, [
        'code=native_tool_arguments_invalid',
        `tool=${unregistered.name}`,
        'fieldErrors=Provider emitted an unregistered Session semantic tool.',
      ], `semantic:unregistered:${unregistered.name}:evidence-${input.state.resourceEvidenceRevision ?? 0}`, 'native_tool_arguments_invalid');
    }
    if (toolCalls.length === 0) {
      return this.scheduleSameProfileRetry(input, [
        'code=native_tool_arguments_invalid',
        'fieldErrors=Provider did not emit a required Session semantic directive.',
      ], `semantic:missing:evidence-${input.state.resourceEvidenceRevision ?? 0}`, 'native_tool_arguments_invalid');
    }

    try {
      const handled = await this.dependencies.turnHandler.handle({
        state: input.state,
        prompt: input.prompt,
        turn: effectiveTurn,
        round: 0,
        ports: input.handlerPorts,
      });
      input.state.semanticDirectiveRepairAttempted = false;
      input.state.semanticDirectiveErrorSummary = undefined;
      if (handled.kind === 'proposal' && handled.proposal.kind === 'taskPlan') {
        input.state.taskPlanReplanReason = undefined;
      }
      const successfulRepairKey = semanticRepairKey(toolCalls[0], input.state.resourceEvidenceRevision ?? 0);
      if (successfulRepairKey) {
        if (isArtifactDirective(toolCalls[0]?.name)) {
          clearArtifactRepairAttempts(
            input.state.artifactChunkRepairAttempts,
            toolCalls[0],
            input.state.resourceEvidenceRevision ?? 0
          );
        } else {
          delete input.state.semanticDirectiveRepairAttempts?.[successfulRepairKey];
        }
      }
      return handled.kind === 'proposal' ? handled.proposal : { kind: 'providerResume' };
    } catch (error) {
      if (!(error instanceof SessionSemanticDirectiveError)) throw error;
      if (error.causeCode === 'artifact_draft_budget_exceeded') {
        await input.onArtifactDraftBudgetExceeded(input.state, error);
        return { kind: 'providerResume' };
      }
      return this.scheduleSameProfileRetry(input, [
        `code=${error.code}`,
        `causeCode=${error.causeCode}`,
        `tool=${error.toolName}`,
        `callId=${error.callId}`,
        `argumentsHash=${error.argumentsHash}`,
        `fieldErrors=${error.message}`,
      ], repairKeyForError(error, input.state.resourceEvidenceRevision ?? 0), error.code);
    }
  }

  private scheduleSameProfileRetry(
    input: NativeToolProviderLoopInput<TState, TPrompt, TTurn>,
    details: string[],
    repairKey: string,
    errorCode: string
  ): NativeToolProviderResumeSignal {
    const state = input.state;
    const artifact = isArtifactRepairKey(repairKey);
    const attemptsByKey = artifact
      ? (state.artifactChunkRepairAttempts ??= {})
      : (state.semanticDirectiveRepairAttempts ??= {});
    const attempts = attemptsByKey[repairKey] ?? 0;
    if (attempts >= 1) {
      const message = `Session semantic directive remained invalid after one same-profile retry: ${details.join('; ')}`;
      throw input.createError?.(errorCode, message) ?? new Error(`${errorCode}: ${message}`);
    }
    attemptsByKey[repairKey] = attempts + 1;
    state.semanticDirectiveRepairAttempted = true;
    state.semanticDirectiveErrorSummary = [
      ...details,
      'requiredAction=Call exactly one registered semantic tool with valid JSON arguments matching its schema and the current task contract.',
    ].join('; ');
    return { kind: 'providerResume' };
  }
}

function semanticRepairKey(toolCall: NativeToolCallProposal | undefined, evidenceRevision: number): string | undefined {
  if (!toolCall) return undefined;
  const slotId = typeof toolCall.arguments.slotId === 'string' && toolCall.arguments.slotId.trim()
    ? toolCall.arguments.slotId.trim()
    : undefined;
  return isArtifactDirective(toolCall.name)
    ? `artifact:${toolCall.name}:${slotId ?? 'finalize'}:evidence-${evidenceRevision}`
    : `semantic:${toolCall.name}:evidence-${evidenceRevision}`;
}

function repairKeyForError(error: SessionSemanticDirectiveError, evidenceRevision: number): string {
  if (isArtifactDirective(error.toolName)) {
    return `artifact:${error.repairKey}:${error.causeCode}:evidence-${evidenceRevision}`;
  }
  return `semantic:${error.toolName}:${error.causeCode}:evidence-${evidenceRevision}`;
}

function clearArtifactRepairAttempts(
  attempts: Record<string, number> | undefined,
  toolCall: NativeToolCallProposal,
  evidenceRevision: number
): void {
  if (!attempts) return;
  const slotId = typeof toolCall.arguments.slotId === 'string' && toolCall.arguments.slotId.trim()
    ? toolCall.arguments.slotId.trim()
    : 'finalize';
  const prefix = `artifact:${toolCall.name}:${slotId}:`;
  const suffix = `:evidence-${evidenceRevision}`;
  for (const key of Object.keys(attempts)) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) delete attempts[key];
  }
}

function isArtifactDirective(toolName: string | undefined): boolean {
  return toolName === 'session.append_artifact_chunk' || toolName === 'session.finalize_task_artifacts';
}

function isArtifactRepairKey(repairKey: string): boolean {
  return repairKey.startsWith('artifact:');
}
