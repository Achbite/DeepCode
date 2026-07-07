import type { AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';

export interface ProposalRouterState {
  sessionId: string;
}

export type ProposalRouterResult =
  | { kind: 'return'; result: AgentSessionResult }
  | { kind: 'continue'; lastResult: AgentSessionResult };

export interface ProposalRouterResourceResult {
  kind: 'return' | 'continue';
  result?: AgentSessionResult;
  lastResult?: AgentSessionResult;
}

export interface ProposalRouteExecutorPorts<Input, State extends ProposalRouterState> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  proposalNarrationEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent | null;
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
  ): Promise<AgentSessionResult>;
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
  routed?: RoutedProposal;
}

export type RoutedProposal =
  | { kind: 'answer'; proposal: ProposalEnvelope }
  | { kind: 'decisionRequest'; proposal: ProposalEnvelope }
  | { kind: 'diagnostic'; proposal: ProposalEnvelope }
  | { kind: 'plan'; proposal: ProposalEnvelope }
  | { kind: 'resourceRequest'; proposal: ProposalEnvelope }
  | { kind: 'action'; proposal: ProposalEnvelope }
  | { kind: 'nonExecutable'; proposal: ProposalEnvelope };

export function routeProposalKind(proposal: ProposalEnvelope): RoutedProposal {
  if (proposal.kind === 'answer') return { kind: 'answer', proposal };
  if (proposal.kind === 'decisionRequest') return { kind: 'decisionRequest', proposal };
  if (proposal.kind === 'diagnostic') return { kind: 'diagnostic', proposal };
  if (proposal.kind === 'taskPlan' || proposal.kind === 'implementationPlan') return { kind: 'plan', proposal };
  if (proposal.kind === 'resourceRequest') return { kind: 'resourceRequest', proposal };
  if (proposal.kind === 'actionBundle' || proposal.kind === 'taskOutcome') return { kind: 'action', proposal };
  return { kind: 'nonExecutable', proposal };
}

export class ProposalRouter {
  planRoute(proposal: ProposalEnvelope): RoutedProposal {
    return routeProposalKind(proposal);
  }

  route(proposal: ProposalEnvelope): RoutedProposal {
    return this.planRoute(proposal);
  }
}

export class ProposalRouteExecutor<Input, State extends ProposalRouterState> {
  constructor(private readonly ports: ProposalRouteExecutorPorts<Input, State>) {}

  async execute(routerInput: ProposalRouterInput<Input, State>): Promise<ProposalRouterResult> {
    const { input, state, prompt, proposal } = routerInput;
    let lastResult = routerInput.lastResult;
    const narration = this.ports.proposalNarrationEvent(
      state.sessionId,
      proposal,
      this.ports.now(),
      this.ports.createId('progress-model-narration')
    );
    if (narration) {
      lastResult = await this.ports.append(state.sessionId, [narration]);
    }

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
      if (handled.kind === 'return' && handled.result) return { kind: 'return', result: handled.result };
      return { kind: 'continue', lastResult: handled.lastResult ?? lastResult };
    }
    if (routed.kind === 'action') {
      return {
        kind: 'return',
        result: await this.ports.submitActionProposal(input, state, prompt, proposal, lastResult),
      };
    }
    return {
      kind: 'return',
      result: await this.ports.submitNonExecutableProposal(state, proposal, lastResult),
    };
  }
}
