import type { ReviewFactsContext } from './reviewFacts.js';

export interface AnswerFactsContext {
  schemaVersion: 'deepcode.session.answer-facts-context.v1';
  source: 'kernelFactsAndSessionLedger';
  reviewFactsContext?: ReviewFactsContext;
  userGuidance?: string;
}

export function buildAnswerFactsContext(input: {
  reviewFactsContext?: ReviewFactsContext;
  userGuidance?: string;
}): AnswerFactsContext {
  return {
    schemaVersion: 'deepcode.session.answer-facts-context.v1',
    source: 'kernelFactsAndSessionLedger',
    reviewFactsContext: input.reviewFactsContext,
    userGuidance: input.userGuidance,
  };
}

