import type { AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type { PlanProjectionState } from '../projection/planProjectionBuilder.js';

export interface ProviderPlanProposalState extends PlanProjectionState {
  runId: string;
  phase: string;
}

export interface ProviderPlanProposalHandlerPorts<State extends ProviderPlanProposalState> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  implementationPlanCardEvent(input: {
    state: State;
    proposal: ProposalEnvelope;
    ts: string;
    id: string;
  }): AgentEvent;
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'waiting_plan_review';
    reason: 'plan_review';
    decisionOwner: {
      kind: 'plan';
      runId: string;
      targetId: string;
      planId: string;
    };
    ts: string;
    id: string;
  }): AgentEvent;
}

export class ProviderPlanProposalHandler<State extends ProviderPlanProposalState> {
  constructor(private readonly ports: ProviderPlanProposalHandlerPorts<State>) {}

  handle(state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult> {
    const planId = planIdFromProposal(proposal);
    state.phase = 'waiting_plan_review';
    return this.ports.append(state.sessionId, [
      this.ports.implementationPlanCardEvent({
        state,
        proposal,
        ts: this.ports.now(),
        id: this.ports.createId('task-plan'),
      }),
      this.ports.sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_plan_review',
        reason: 'plan_review',
        decisionOwner: {
          kind: 'plan',
          runId: state.runId,
          targetId: planId,
          planId,
        },
        ts: this.ports.now(),
        id: this.ports.createId('session-run-waiting-plan'),
      }),
    ]);
  }
}

function planIdFromProposal(proposal: ProposalEnvelope): string {
  const payload = objectRecord(proposal.payload);
  return stringValue(payload?.id) ?? proposal.proposalId;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
