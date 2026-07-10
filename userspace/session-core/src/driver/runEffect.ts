import type { AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../protocol/types.js';
import type { PromptEnvelope } from '../prompt/types.js';
import type {
  AcceptedPlanReviewHandoffPlan,
  AcceptedPlanReviewHandoffRunInput,
} from './review/acceptedPlanReviewHandoffCoordinator.js';
import type { LoopDirective } from './proposal/proposalRouter.js';

export type RunEffect<State> =
  | { readonly kind: 'initialized'; readonly state: State; readonly lastResult: AgentSessionResult }
  | { readonly kind: 'requirementDecisionRequired'; readonly result: AgentSessionResult }
  | {
    readonly kind: 'providerDirectiveReady';
    readonly prompt: PromptEnvelope;
    readonly lastResult: AgentSessionResult;
    readonly proposal?: ProposalEnvelope;
    readonly directive: LoopDirective;
  }
  | {
    readonly kind: 'directiveReturned';
    readonly result: AgentSessionResult;
    readonly proposal?: ProposalEnvelope;
    readonly directive: LoopDirective;
  }
  | {
    readonly kind: 'directiveContinue';
    readonly lastResult: AgentSessionResult;
    readonly proposal?: ProposalEnvelope;
    readonly directive: LoopDirective;
  }
  | {
    readonly kind: 'reviewAssemblyRequired';
    readonly request: AcceptedPlanReviewHandoffRunInput<AcceptedPlanReviewHandoffPlan>;
    readonly proposal?: ProposalEnvelope;
    readonly directive: LoopDirective;
  }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'terminal'; readonly result: AgentSessionResult };
