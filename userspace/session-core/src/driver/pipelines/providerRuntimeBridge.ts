import type {
  LlmChatRequest,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { ProviderEmptyProposalRetryOptions } from '../../provider/ProviderEmptyProposalRetry.js';
import type { NativeToolTurnResult } from '../../provider/NativeToolTurnHandler.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import type {
  NativeToolProviderCoordinator,
  NativeToolProviderCoordinatorState,
} from './nativeToolProviderCoordinator.js';
import type { NativeToolProviderResumeSignal } from './nativeToolProviderLoop.js';
import type {
  ProviderTurnRunner,
  ProviderTurnRunnerPorts,
  ProviderTurnRunnerState,
} from './providerTurnRunner.js';

export interface ProviderRuntimeCallControl {
  readonly abortSignal?: AbortSignal;
  readonly consumeGuidance?: boolean;
  readonly stream?: boolean;
}

export interface ProviderRuntimeBridgePorts<State extends ProviderTurnRunnerState>
  extends ProviderTurnRunnerPorts<State> {
  createError(code: string, message: string): Error;
}

export interface ProviderRuntimeBridgeDependencies<
  State extends ProviderTurnRunnerState & NativeToolProviderCoordinatorState,
  Turn extends NativeToolTurnResult,
> {
  nativeToolProviderCoordinator: NativeToolProviderCoordinator<State, Turn>;
  providerTurnRunner: ProviderTurnRunner<State>;
}

export class ProviderRuntimeBridge<
  State extends ProviderTurnRunnerState & NativeToolProviderCoordinatorState,
  Turn extends NativeToolTurnResult,
> {
  constructor(
    private readonly dependencies: ProviderRuntimeBridgeDependencies<State, Turn>,
    private readonly ports: ProviderRuntimeBridgePorts<State>
  ) {}

  runWithNativeTools(input: {
    profileId?: string;
    stage?: string;
    state: State;
    prompt: PromptEnvelope;
    contract: DriverProviderTurnFrame;
  }): Promise<ProposalEnvelope | NativeToolProviderResumeSignal> {
    return this.dependencies.nativeToolProviderCoordinator.run(input);
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
    options: Pick<LlmChatRequest, 'responseFormat' | 'tools'> = {},
    control: ProviderRuntimeCallControl = {}
  ): Promise<Turn> {
    return this.dependencies.providerTurnRunner.run({
      profileId,
      state,
      stage,
      messages,
      options,
      abortSignal: control.abortSignal,
      consumeGuidance: control.consumeGuidance,
      stream: control.stream,
      ports: this.ports,
    }) as unknown as Promise<Turn>;
  }

  consumeGuidanceMessages(state: State, stage: string): Promise<LlmChatRequest['messages']> {
    return this.ports.consumeGuidanceMessages?.(state, stage) ?? Promise.resolve([]);
  }
}
