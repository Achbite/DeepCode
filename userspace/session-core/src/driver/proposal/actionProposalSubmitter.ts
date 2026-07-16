import type {
  AgentEvent,
  AgentSessionResult,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import {
  normalizeProposalRouterResult,
  type ProposalRouterResult,
} from './proposalRouter.js';

export interface ActionProposalSubmitterInput {
  profileId?: string;
}

export interface ActionProposalSubmitterState {
  sessionId: string;
  acceptedTaskPlan?: unknown;
}

export interface ActionProposalSubmitterDiagnostic {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export interface ActionProposalSubmitterPorts<
  Input extends ActionProposalSubmitterInput,
  State extends ActionProposalSubmitterState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  readActionBundle(proposal: ProposalEnvelope): unknown;
  submitAcceptedPlanActionProposal(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | ProposalRouterResult>;
  finalDiagnosticEvent(
    sessionId: string,
    content: string | ActionProposalSubmitterDiagnostic,
    ts: string,
    id: string
  ): AgentEvent;
  diagnostic(code: string, fallback: string, params?: Record<string, string | number>): ActionProposalSubmitterDiagnostic;
}

export class ActionProposalSubmitter<
  Input extends ActionProposalSubmitterInput,
  State extends ActionProposalSubmitterState,
> {
  constructor(private readonly ports: ActionProposalSubmitterPorts<Input, State>) {}

  async submit(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<ProposalRouterResult> {
    const executable = Boolean(this.ports.readActionBundle(proposal));
    if (state.acceptedTaskPlan && executable) {
      return normalizeProposalRouterResult(
        await this.ports.submitAcceptedPlanActionProposal(input, state, prompt, proposal, fallback)
      );
    }
    return {
      kind: 'return',
      result: await this.failClosed(
        state,
        'providerActionOutsideAcceptedTask',
        'Provider action directives are valid only for the active accepted task contract.'
      ),
    };
  }

  submitNonExecutable(
    state: State,
    _proposal: ProposalEnvelope,
    _fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    return this.failClosed(
      state,
      'unsupportedProviderDirective',
      'The provider returned a directive that is not registered for the current Session profile.'
    );
  }

  private failClosed(state: State, code: string, fallback: string): Promise<AgentSessionResult> {
    return this.ports.append(state.sessionId, [
      this.ports.finalDiagnosticEvent(
        state.sessionId,
        this.ports.diagnostic(code, fallback),
        this.ports.now(),
        this.ports.createId('provider-directive-rejected')
      ),
    ]);
  }
}
