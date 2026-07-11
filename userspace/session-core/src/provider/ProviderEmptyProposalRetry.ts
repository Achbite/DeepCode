import type { LlmChatRequest } from '@deepcode/protocol';

export interface ProviderEmptyProposalCandidate {
  content: string;
  toolCalls: readonly unknown[];
}

export type ProviderEmptyProposalRetryOptions = Pick<LlmChatRequest, 'responseFormat' | 'tools'>;

export interface ProviderEmptyProposalRetryInput<TState, TTurn extends ProviderEmptyProposalCandidate> {
  turn: TTurn;
  profileId?: string;
  state: TState;
  stage: string;
  messages: LlmChatRequest['messages'];
  options: ProviderEmptyProposalRetryOptions;
  runTurn(
    profileId: string | undefined,
    state: TState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn>;
}

export interface ProviderEmptyProposalRunInput<TState, TTurn extends ProviderEmptyProposalCandidate> {
  profileId?: string;
  state: TState;
  stage: string;
  messages: LlmChatRequest['messages'];
  options: ProviderEmptyProposalRetryOptions;
  isEmptyResponseError(error: unknown): boolean;
  runTurn(
    profileId: string | undefined,
    state: TState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: ProviderEmptyProposalRetryOptions
  ): Promise<TTurn>;
}

export class ProviderEmptyProposalRetry {
  shouldRetry(turn: ProviderEmptyProposalCandidate): boolean {
    return turn.toolCalls.length === 0 && !turn.content.trim();
  }

  retryMessage(semanticTools = false): LlmChatRequest['messages'][number] {
    return {
      role: 'user',
      content: semanticTools
        ? [
          'The previous provider turn returned no Session semantic directive.',
          'Use the already supplied authority, current task, and ResourceEvidence.',
          'Call exactly one registered Session semantic tool now.',
          'Do not explain the empty response or claim execution facts.',
        ].join('\n')
        : [
          'The previous provider turn returned no JSON proposal.',
          'Use the already supplied user request, confirmed decisions, ResourcePacket/tool facts, and current task context.',
          'Return exactly one valid Agent Protocol v3 JSON proposal now.',
          'Do not explain the empty response. Do not restate protocol rules. Do not claim execution facts, permissions, validation, or task completion.',
        ].join('\n'),
    };
  }

  async maybeRetry<TState, TTurn extends ProviderEmptyProposalCandidate>(
    input: ProviderEmptyProposalRetryInput<TState, TTurn>
  ): Promise<TTurn> {
    if (!this.shouldRetry(input.turn)) return input.turn;
    return this.retry(input);
  }

  async runWithRetry<TState, TTurn extends ProviderEmptyProposalCandidate>(
    input: ProviderEmptyProposalRunInput<TState, TTurn>
  ): Promise<TTurn> {
    let turn: TTurn;
    try {
      turn = await input.runTurn(
        input.profileId,
        input.state,
        input.stage,
        input.messages,
        input.options
      );
    } catch (error) {
      if (!input.isEmptyResponseError(error)) throw error;
      return this.retry(input);
    }
    return this.maybeRetry({
      ...input,
      turn,
    });
  }

  private retry<TState, TTurn extends ProviderEmptyProposalCandidate>(
    input: Omit<ProviderEmptyProposalRetryInput<TState, TTurn>, 'turn'>
  ): Promise<TTurn> {
    return input.runTurn(
      input.profileId,
      input.state,
      `${input.stage}_empty_retry`,
      [
        ...input.messages,
        this.retryMessage(Boolean(input.options.tools?.length)),
      ],
      input.options
    );
  }
}
