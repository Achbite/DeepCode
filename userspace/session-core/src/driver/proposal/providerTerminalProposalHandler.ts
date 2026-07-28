import type {
  AgentEvent,
  AgentSessionResult,
  ConversationLanguage,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';
import { finalSettlementEvidenceMetadata } from '../authority/finalSettlementEvidence.js';
import {
  queueProviderCommitEvents,
  takeProviderCommitEvents,
  type ProviderCommitBufferState,
} from '../pipelines/providerCommitBuffer.js';
import {
  conversationPresentationLanguageBinding,
  type ConversationPresentationLanguageState,
  type ProjectionLanguageBinding,
} from '../projection/index.js';

export interface ProviderTerminalProposalState
  extends ProviderCommitBufferState, ConversationPresentationLanguageState {
  sessionId: string;
  runId: string;
  phase: string;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  currentTaskContext?: { taskId?: string };
}

export interface ProviderTerminalProposalHandlerPorts<Input, State extends ProviderTerminalProposalState> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  reviseAnswer(input: Input, state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult | null>;
  answerEvent(
    sessionId: string,
    proposal: ProposalEnvelope,
    ts: string,
    id: string,
    metadata?: Record<string, unknown>
  ): AgentEvent;
  finalDiagnosticEvent(
    sessionId: string,
    summary: string,
    ts: string,
    id: string,
    presentationBinding: ProjectionLanguageBinding,
    metadata?: Record<string, unknown>
  ): AgentEvent;
  acceptedTaskDiagnosticFailureEvents(input: {
    sessionId: string;
    runId: string;
    planId: string;
    taskId: string;
    proposalId: string;
    severity: string;
    message: string;
    language?: ConversationLanguage;
    ts: string;
    id: string;
  }): AgentEvent[];
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'completed' | 'failed';
    status: 'completed' | 'failed';
    reason: 'session' | 'task_diagnostic';
    decisionOwner: {
      kind: 'session';
      runId: string;
      targetId?: string;
    };
    ts: string;
    id: string;
  }): AgentEvent;
}

export class ProviderTerminalProposalHandler<Input, State extends ProviderTerminalProposalState> {
  constructor(private readonly ports: ProviderTerminalProposalHandlerPorts<Input, State>) {}

  async handleAnswer(input: Input, state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult> {
    const revised = await this.ports.reviseAnswer(input, state, proposal);
    if (revised) return revised;
    state.phase = 'completed';
    const providerCommitEvents = takeProviderCommitEvents(state);
    const terminalEvents = [
      ...providerCommitEvents,
      this.ports.answerEvent(
        state.sessionId,
        proposal,
        this.ports.now(),
        this.ports.createId('answer'),
        finalSettlementEvidenceMetadata(state.acceptedTaskPlan)
      ),
      this.ports.sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'completed',
        status: 'completed',
        reason: 'session',
        decisionOwner: {
          kind: 'session',
          runId: state.runId,
        },
        ts: this.ports.now(),
        id: this.ports.createId('session-run-completed-answer'),
      }),
    ];
    try {
      return await this.ports.append(state.sessionId, terminalEvents);
    } catch (error) {
      if (!isSessionAppendHeadConflict(error)) throw error;
      queueProviderCommitEvents(state, providerCommitEvents);
      const revisedAfterConflict = await this.ports.reviseAnswer(input, state, proposal);
      if (revisedAfterConflict) return revisedAfterConflict;
      throw error;
    }
  }

  handleDiagnostic(state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult> {
    const taskId = state.currentTaskContext?.taskId;
    const planId = state.acceptedTaskPlan?.planId;
    if (taskId && planId) {
      state.phase = 'failed';
      const payload = objectRecord(proposal.payload) ?? {};
      return this.ports.append(state.sessionId, [
        ...takeProviderCommitEvents(state),
        ...this.ports.acceptedTaskDiagnosticFailureEvents({
        sessionId: state.sessionId,
        runId: state.runId,
        planId,
        taskId,
        proposalId: proposal.proposalId,
        severity: stringValue(payload.severity) ?? 'error',
        message: diagnosticSummary(proposal),
        language: proposal.responseLanguage,
        ts: this.ports.now(),
        id: this.ports.createId('accepted-task-diagnostic-failed'),
        }),
      ]);
    }
    state.phase = 'failed';
    const diagnosticId = this.ports.createId('diagnostic');
    return this.ports.append(state.sessionId, [
      ...takeProviderCommitEvents(state),
      this.ports.finalDiagnosticEvent(
        state.sessionId,
        diagnosticSummary(proposal),
        this.ports.now(),
        diagnosticId,
        conversationPresentationLanguageBinding(state),
        { proposalId: proposal.proposalId }
      ),
      this.ports.sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'failed',
        status: 'failed',
        reason: 'task_diagnostic',
        decisionOwner: {
          kind: 'session',
          runId: state.runId,
          targetId: diagnosticId,
        },
        ts: this.ports.now(),
        id: this.ports.createId('session-run-diagnostic-failed'),
      }),
    ]);
  }
}

function isSessionAppendHeadConflict(error: unknown): boolean {
  return objectRecord(error)?.code === 'session_append_head_conflict';
}

function diagnosticSummary(proposal: ProposalEnvelope): string {
  const diagnostic = objectRecord(proposal.payload) ?? {};
  return stringValue(diagnostic.summary)
    ?? stringValue(diagnostic.details)
    ?? (proposal.responseLanguage === 'zh-CN'
      ? '模型返回了诊断信息，但未生成计划或执行队列。'
      : 'The model returned diagnostic information without generating a plan or execution queue.');
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
