import type { AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';

export interface ProviderTerminalProposalState {
  sessionId: string;
  runId: string;
  phase: string;
  acceptedTaskPlan?: { planId: string };
  currentTaskContext?: { taskId?: string };
}

export interface ProviderTerminalProposalHandlerPorts<Input, State extends ProviderTerminalProposalState> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  reviseAnswer(input: Input, state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult | null>;
  answerEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent;
  finalDiagnosticEvent(sessionId: string, summary: string, ts: string, id: string): AgentEvent;
  acceptedTaskDiagnosticFailureEvents(input: {
    sessionId: string;
    runId: string;
    planId: string;
    taskId: string;
    severity: string;
    message: string;
    ts: string;
    id: string;
  }): AgentEvent[];
}

export class ProviderTerminalProposalHandler<Input, State extends ProviderTerminalProposalState> {
  constructor(private readonly ports: ProviderTerminalProposalHandlerPorts<Input, State>) {}

  async handleAnswer(input: Input, state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult> {
    const revised = await this.ports.reviseAnswer(input, state, proposal);
    if (revised) return revised;
    return this.ports.append(state.sessionId, [
      this.ports.answerEvent(
        state.sessionId,
        proposal,
        this.ports.now(),
        this.ports.createId('answer')
      ),
    ]);
  }

  handleDiagnostic(state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult> {
    const taskId = state.currentTaskContext?.taskId;
    const planId = state.acceptedTaskPlan?.planId;
    if (taskId && planId) {
      state.phase = 'failed';
      const payload = objectRecord(proposal.payload) ?? {};
      return this.ports.append(state.sessionId, this.ports.acceptedTaskDiagnosticFailureEvents({
        sessionId: state.sessionId,
        runId: state.runId,
        planId,
        taskId,
        severity: stringValue(payload.severity) ?? 'error',
        message: diagnosticSummary(proposal),
        ts: this.ports.now(),
        id: this.ports.createId('accepted-task-diagnostic-failed'),
      }));
    }
    return this.ports.append(state.sessionId, [
      this.ports.finalDiagnosticEvent(
        state.sessionId,
        diagnosticSummary(proposal),
        this.ports.now(),
        this.ports.createId('diagnostic')
      ),
    ]);
  }
}

function diagnosticSummary(proposal: ProposalEnvelope): string {
  const diagnostic = objectRecord(proposal.payload) ?? {};
  return stringValue(diagnostic.summary)
    ?? stringValue(diagnostic.details)
    ?? 'The model returned diagnostic information without generating a plan or execution queue.';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
