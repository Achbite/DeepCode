import type { AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type { UserGuidanceEvent } from '../../context/index.js';

export type AssistantProjectionLanguage = 'zh-CN' | 'en-US';

export interface AssistantDiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export interface AssistantProjectionBuilderPorts {
  visibleLanguageForRequest(userRequest: string): AssistantProjectionLanguage;
  guidanceRevisionTransitionMessage(language: AssistantProjectionLanguage): string;
}

export class AssistantProjectionBuilder {
  constructor(private readonly ports: AssistantProjectionBuilderPorts) {}

  answerEvent(
    sessionId: string,
    proposal: ProposalEnvelope,
    ts: string,
    id: string,
    metadata: Record<string, unknown> = {}
  ): AgentEvent {
    return {
      id,
      sessionId,
      ts,
      kind: 'assistant_msg',
      payload: {
        content: this.answerContent(proposal),
        channel: 'final',
        visibility: 'conversation',
        label: 'DeepCode',
        proposalId: proposal.proposalId,
        ...metadata,
      },
    };
  }

  answerNarrationEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent | null {
    const content = proposal.narration?.trim();
    if (!content) return null;
    return this.progressNarrationEvent(sessionId, proposal, content, ts, id);
  }

  proposalNarrationEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent | null {
    if (proposal.source !== 'llm') return null;
    if (proposal.kind === 'answer') return null;
    const content = proposal.narration?.trim();
    if (!content) return null;
    return this.progressNarrationEvent(sessionId, proposal, content, ts, id);
  }

  guidanceRevisionTransitionEvent(
    sessionId: string,
    runId: string,
    guidanceIds: string[],
    userRequest: string,
    ts: string,
    id: string
  ): AgentEvent {
    return {
      id,
      sessionId,
      ts,
      kind: 'assistant_msg',
      payload: {
        content: this.ports.guidanceRevisionTransitionMessage(this.ports.visibleLanguageForRequest(userRequest)),
        channel: 'progress',
        source: 'session',
        visibility: 'conversation',
        presentation: 'body',
        label: 'DeepCode',
        runId,
        guidanceIds,
      },
    };
  }

  guidanceRevisionDiagnosticEvent(sessionId: string, message: string, ts: string, id: string): AgentEvent {
    return {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message,
        status: 'error',
        channel: 'error',
        visibility: 'conversation',
        source: 'session',
      },
    };
  }

  guidanceRevisionOverlay(
    originalRequest: string,
    draftAnswer: ProposalEnvelope,
    guidance: UserGuidanceEvent[]
  ): string {
    return [
      'Terminal user guidance revision:',
      'A draft answer was generated but has not been shown to the user because new user guidance arrived before the final response was committed.',
      'Return a JSON ProposalEnvelope with kind="answer" only. Do not return resourceRequest, decisionRequest, actionBundle, or diagnostic.',
      'Include a short top-level narration sentence that naturally acknowledges the guidance merge before the final answer.',
      `Original user request:\n${this.clip(originalRequest, 1800)}`,
      `Unshown draft answer:\n${this.clip(this.answerContent(draftAnswer), 3200)}`,
      'Latest user guidance to apply:',
      ...guidance.map((item) => `- id=${item.id} ${this.clip(item.content, 800)}`),
    ].join('\n\n');
  }

  finalDiagnosticEvent(sessionId: string, content: string | AssistantDiagnosticInfo, ts: string, id: string): AgentEvent {
    const info: AssistantDiagnosticInfo = typeof content === 'string'
      ? { code: 'generic', fallback: content }
      : content;
    return {
      id,
      sessionId,
      ts,
      kind: 'assistant_msg',
      payload: {
        content: info.fallback,
        channel: 'final',
        visibility: 'conversation',
        label: 'DeepCode',
        diagnostic: true,
        diagnosticCode: info.code,
        ...(info.params ? { diagnosticParams: info.params } : {}),
      },
    };
  }

  thinkingEvent(
    sessionId: string,
    content: string,
    ts: string,
    id: string,
    message?: { messageKey: string; messageArgs?: Record<string, string> }
  ): AgentEvent {
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'session.provider_status',
        status: 'completed',
        summary: content,
        content,
        channel: 'progress',
        source: 'session',
        visibility: 'conversation',
        presentation: 'stageSummary',
        label: 'Session status',
        ...(message ? { messageKey: message.messageKey, messageArgs: message.messageArgs ?? {} } : {}),
      },
    };
  }

  reasoningEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent {
    return {
      id,
      sessionId,
      ts,
      kind: 'assistant_msg',
      payload: {
        content,
        channel: 'reasoning',
        source: 'provider',
        visibility: 'conversation',
        presentation: 'collapsible',
        reasoningTrace: true,
        label: 'Model reasoning',
      },
    };
  }

  answerContent(proposal: ProposalEnvelope): string {
    const payload = objectRecord(proposal.payload) ?? {};
    const answer = objectRecord(payload.answer) ?? payload;
    return typeof answer.content === 'string' ? answer.content : '';
  }

  private progressNarrationEvent(
    sessionId: string,
    proposal: ProposalEnvelope,
    content: string,
    ts: string,
    id: string
  ): AgentEvent {
    return {
      id,
      sessionId,
      ts,
      kind: 'assistant_msg',
      payload: {
        content,
        channel: 'progress',
        source: 'llm',
        visibility: 'conversation',
        presentation: 'body',
        label: 'DeepCode',
        proposalId: proposal.proposalId,
      },
    };
  }

  private clip(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max)}...`;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
