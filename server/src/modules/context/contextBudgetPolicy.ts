import type { LlmProviderProfile } from '@deepcode/protocol';

export interface ContextBudgetSnapshot {
  usedTokens: number;
  limitTokens: number;
  reservedOutputTokens: number;
  truncated: boolean;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
const DEFAULT_OUTPUT_RESERVE_TOKENS = 4096;

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export class ContextBudgetPolicy {
  evaluate(input: string, profile?: LlmProviderProfile): ContextBudgetSnapshot {
    const limitTokens = profile?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const reservedOutputTokens = Math.min(
      profile?.maxOutputTokens ?? profile?.maxTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS,
      Math.floor(limitTokens * 0.5)
    );
    const usableInputTokens = Math.max(1024, limitTokens - reservedOutputTokens);
    const usedTokens = estimateTokens(input);

    return {
      usedTokens,
      limitTokens,
      reservedOutputTokens,
      truncated: usedTokens > usableInputTokens,
    };
  }
}
