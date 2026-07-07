import type { AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../protocol/types.js';
import type { RoutedProposal } from './proposal/proposalRouter.js';

export type RunEffect<State> =
  | {
    readonly kind: 'continuationEntered';
    readonly source: 'coordinatorResume';
  }
  | { readonly kind: 'initialized'; readonly state: State; readonly lastResult: AgentSessionResult }
  | { readonly kind: 'requirementDecisionRequired'; readonly result: AgentSessionResult }
  | {
    readonly kind: 'providerCycleReturned';
    readonly result: AgentSessionResult;
    readonly proposal?: ProposalEnvelope;
    readonly routed?: RoutedProposal;
  }
  | {
    readonly kind: 'resourceRequestContinue';
    readonly lastResult: AgentSessionResult;
    readonly proposal: ProposalEnvelope;
    readonly routed: RoutedProposal;
  }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'terminal'; readonly result: AgentSessionResult };
