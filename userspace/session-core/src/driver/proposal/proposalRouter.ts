import type { AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type {
  AcceptedPlanReviewHandoffPlan,
  AcceptedPlanReviewHandoffRunInput,
} from '../review/acceptedPlanReviewHandoffCoordinator.js';

export interface ProposalRouterState {
  sessionId: string;
}

export type ProposalRouterResult =
  | { kind: 'return'; result: AgentSessionResult }
  | { kind: 'continue'; lastResult: AgentSessionResult }
  | {
    kind: 'assembleReview';
    request: AcceptedPlanReviewHandoffRunInput<AcceptedPlanReviewHandoffPlan>;
  };

export function normalizeProposalRouterResult(
  value: AgentSessionResult | ProposalRouterResult
): ProposalRouterResult {
  const kind = objectRecord(value)?.kind;
  if (kind === 'return' || kind === 'continue' || kind === 'assembleReview') {
    return value as ProposalRouterResult;
  }
  return { kind: 'return', result: value as AgentSessionResult };
}

export type ProposalRouterResourceResult = ProposalRouterResult;

export interface ProposalRouteExecutorPorts<Input, State extends ProposalRouterState> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  handleAnswer(input: Input, state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult>;
  handleDecisionRequest(input: Input, state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult>;
  handleDiagnostic(state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult>;
  handlePlan(state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult>;
  handleResourceRequest(input: {
    input: Input;
    state: State;
    prompt: PromptEnvelope;
    proposal: ProposalEnvelope;
    lastResult: AgentSessionResult;
  }): Promise<ProposalRouterResourceResult>;
  submitActionProposal(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<ProposalRouterResult>;
  submitNonExecutableProposal(
    state: State,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult>;
}

export type ProposalRouterPorts<Input, State extends ProposalRouterState> =
  ProposalRouteExecutorPorts<Input, State>;

export interface ProposalRouterInput<Input, State extends ProposalRouterState> {
  input: Input;
  state: State;
  prompt: PromptEnvelope;
  proposal: ProposalEnvelope;
  lastResult: AgentSessionResult;
  routed?: LoopDirective;
}

export type LoopDirective =
  | { kind: 'providerResume' }
  | { kind: 'answer'; proposal: ProposalEnvelope }
  | { kind: 'decisionRequest'; proposal: ProposalEnvelope }
  | { kind: 'diagnostic'; proposal: ProposalEnvelope }
  | { kind: 'plan'; proposal: ProposalEnvelope }
  | { kind: 'resourceRequest'; proposal: ProposalEnvelope }
  | { kind: 'action'; proposal: ProposalEnvelope }
  | { kind: 'nonExecutable'; proposal: ProposalEnvelope };

export type RoutedProposal = LoopDirective;

export function routeProposalKind(proposal: ProposalEnvelope): LoopDirective {
  if (proposal.kind === 'answer') return { kind: 'answer', proposal };
  if (proposal.kind === 'decisionRequest') return { kind: 'decisionRequest', proposal };
  if (proposal.kind === 'diagnostic') return { kind: 'diagnostic', proposal };
  if (proposal.kind === 'taskPlan') return { kind: 'plan', proposal };
  if (proposal.kind === 'resourceRequest') return { kind: 'resourceRequest', proposal };
  if (proposal.kind === 'actionBundle') return { kind: 'action', proposal };
  return { kind: 'nonExecutable', proposal };
}

export class ProposalRouter {
  planRoute(proposal: ProposalEnvelope): LoopDirective {
    return routeProposalKind(proposal);
  }

  route(proposal: ProposalEnvelope): LoopDirective {
    return this.planRoute(proposal);
  }
}

export class ProposalRouteExecutor<Input, State extends ProposalRouterState> {
  constructor(private readonly ports: ProposalRouteExecutorPorts<Input, State>) {}

  async execute(routerInput: ProposalRouterInput<Input, State>): Promise<ProposalRouterResult> {
    const { input, state, prompt, proposal } = routerInput;
    let lastResult = routerInput.lastResult;

    const routed = routerInput.routed ?? routeProposalKind(proposal);
    if (routed.kind === 'answer') {
      return { kind: 'return', result: await this.ports.handleAnswer(input, state, proposal) };
    }
    if (routed.kind === 'decisionRequest') {
      return { kind: 'return', result: await this.ports.handleDecisionRequest(input, state, proposal) };
    }
    if (routed.kind === 'diagnostic') {
      return { kind: 'return', result: await this.ports.handleDiagnostic(state, proposal) };
    }
    if (routed.kind === 'plan') {
      return { kind: 'return', result: await this.ports.handlePlan(state, proposal) };
    }
    if (routed.kind === 'resourceRequest') {
      const handled = await this.ports.handleResourceRequest({
        input,
        state,
        prompt,
        proposal,
        lastResult,
      });
      if (handled.kind !== 'continue') return handled;
      return { kind: 'continue', lastResult: handled.lastResult ?? lastResult };
    }
    if (routed.kind === 'action') {
      return this.ports.submitActionProposal(input, state, prompt, proposal, lastResult);
    }
    return {
      kind: 'return',
      result: await this.ports.submitNonExecutableProposal(state, proposal, lastResult),
    };
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
