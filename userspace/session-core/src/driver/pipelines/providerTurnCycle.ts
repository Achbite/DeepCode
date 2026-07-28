import type { AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { LoopDirective } from '../proposal/proposalRouter.js';
import type { NativeToolProviderResumeSignal } from './nativeToolProviderLoop.js';
import type {
  AcceptedPlanReviewHandoffPlan,
  AcceptedPlanReviewHandoffRunInput,
} from '../review/acceptedPlanReviewHandoffCoordinator.js';

export interface ProviderTurnCycleState {
  sessionId: string;
  phase: string;
}

export interface ProviderTurnCycleContextResult {
  prompt: PromptEnvelope;
  lastResult: AgentSessionResult;
}

export interface ProviderTurnCyclePorts<Input, State extends ProviderTurnCycleState> {
  refreshRuntimeState(state: State): void;
  prepareProviderContext(input: Input, state: State, lastResult: AgentSessionResult): Promise<ProviderTurnCycleContextResult>;
  appendProviderRunningState?(state: State): Promise<unknown>;
  callProviderAndParse(
    input: Input,
    state: State,
    prompt: PromptEnvelope
  ): Promise<ProposalEnvelope | NativeToolProviderResumeSignal>;
  deterministicProposal?(state: State): ProposalEnvelope | undefined;
  takePendingReview?(
    state: State,
    lastResult: AgentSessionResult
  ): AcceptedPlanReviewHandoffRunInput<AcceptedPlanReviewHandoffPlan> | undefined;
  admitDirective(proposal: ProposalEnvelope): LoopDirective;
  retryableProviderFailure?(
    input: Input,
    state: State,
    error: unknown
  ): boolean;
  appendDriverFailure(state: State, error: unknown): Promise<AgentSessionResult | null | undefined>;
  appendProviderFailure(state: State, error: unknown): Promise<AgentSessionResult>;
}

export type ProviderTurnCycleResult =
  | { kind: 'failed'; result: AgentSessionResult }
  | { kind: 'retryExhausted'; lastResult: AgentSessionResult; error: unknown }
  | {
    kind: 'reviewRequired';
    request: AcceptedPlanReviewHandoffRunInput<AcceptedPlanReviewHandoffPlan>;
  }
  | {
    kind: 'directiveReady';
    prompt: PromptEnvelope;
    lastResult: AgentSessionResult;
    proposal?: ProposalEnvelope;
    directive: LoopDirective;
  };

export class ProviderTurnCycle<Input, State extends ProviderTurnCycleState> {
  constructor(private readonly ports: ProviderTurnCyclePorts<Input, State>) {}

  async run(input: {
    input: Input;
    state: State;
    lastResult: AgentSessionResult;
  }): Promise<ProviderTurnCycleResult> {
    const { state } = input;
    this.ports.refreshRuntimeState(state);
    const pendingReview = this.ports.takePendingReview?.(state, input.lastResult);
    if (pendingReview) return { kind: 'reviewRequired', request: pendingReview };
    let providerContext: ProviderTurnCycleContextResult;
    try {
      providerContext = await this.ports.prepareProviderContext(input.input, state, input.lastResult);
    } catch (error) {
      const driverFailure = await this.ports.appendDriverFailure(state, error);
      if (driverFailure) return { kind: 'failed', result: driverFailure };
      throw error;
    }
    const prompt = providerContext.prompt;
    const deterministic = this.ports.deterministicProposal?.(state);
    if (deterministic) {
      return {
        kind: 'directiveReady',
        prompt,
        lastResult: providerContext.lastResult,
        proposal: deterministic,
        directive: this.ports.admitDirective(deterministic),
      };
    }
    const enteringProvider = state.phase !== 'provider_proposing';
    state.phase = 'provider_proposing';
    if (enteringProvider) await this.ports.appendProviderRunningState?.(state);
    let providerStep: ProposalEnvelope | NativeToolProviderResumeSignal;
    let retryCount = 0;
    for (;;) {
      try {
        providerStep = await this.ports.callProviderAndParse(input.input, state, prompt);
        break;
      } catch (error) {
        const retryable = this.ports.retryableProviderFailure?.(
          input.input,
          state,
          error
        ) === true;
        if (retryable && retryCount < 3) {
          retryCount += 1;
          continue;
        }
        if (retryable) {
          return {
            kind: 'retryExhausted',
            lastResult: providerContext.lastResult,
            error,
          };
        }
        const driverFailure = await this.ports.appendDriverFailure(state, error);
        if (driverFailure) return { kind: 'failed', result: driverFailure };
        return { kind: 'failed', result: await this.ports.appendProviderFailure(state, error) };
      }
    }
    if (providerStep.kind === 'providerResume') {
      return {
        kind: 'directiveReady',
        prompt,
        lastResult: providerContext.lastResult,
        directive: { kind: 'providerResume' },
      };
    }
    return {
      kind: 'directiveReady',
      prompt,
      lastResult: providerContext.lastResult,
      proposal: providerStep,
      directive: this.ports.admitDirective(providerStep),
    };
  }
}
