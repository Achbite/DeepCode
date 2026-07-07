import type { AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../protocol/types.js';

export type RunEffect<State> =
  | {
    readonly kind: 'continuationEntered';
    readonly source: 'coordinatorResume';
  }
  | { readonly kind: 'initialized'; readonly state: State; readonly lastResult: AgentSessionResult }
  | { readonly kind: 'requirementDecisionRequired'; readonly result: AgentSessionResult }
  | { readonly kind: 'providerCycleReturned'; readonly result: AgentSessionResult }
  | {
    readonly kind: 'resourceRequestContinue';
    readonly lastResult: AgentSessionResult;
    readonly proposal: ProposalEnvelope;
  }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'terminal'; readonly result: AgentSessionResult };
