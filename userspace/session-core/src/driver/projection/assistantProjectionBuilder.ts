import type { AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
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

export interface AssistantDecisionEffectAnswerInput {
  sessionId: string;
  runId: string;
  proposalId: string;
  completedTasks: number;
  totalTasks: number;
  pendingTasks: number;
  reason?: string;
  guidance?: string;
  language: AssistantProjectionLanguage;
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

  decisionEffectAnswerProposal(input: AssistantDecisionEffectAnswerInput): ProposalEnvelope {
    const content = input.language === 'en-US'
      ? this.englishDecisionEffectAnswer(input)
      : this.chineseDecisionEffectAnswer(input);
    return {
      schemaVersion: 'deepcode.agent.protocol.v3',
      proposalId: input.proposalId,
      runId: input.runId,
      sessionId: input.sessionId,
      source: 'system',
      kind: 'answer',
      payload: {
        answer: {
          version: '1',
          format: 'markdown',
          content,
        },
      },
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    };
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

  private englishDecisionEffectAnswer(input: AssistantDecisionEffectAnswerInput): string {
    return [
      '## Current session stopped by user intervention',
      '',
      'The user asked Session to stop continuing execution and provide a summary. This summary is derived only from the Session ledger and Kernel facts; it does not claim tool execution that did not happen.',
      '',
      input.totalTasks ? `- Confirmed task count: ${input.totalTasks}` : '- No recoverable accepted-plan task ledger is available.',
      input.totalTasks ? `- Completed tasks: ${input.completedTasks}` : '',
      input.totalTasks ? `- Tasks not continued: ${input.pendingTasks}` : '',
      input.reason ? `- User intervention reason: ${input.reason}` : '',
      input.guidance?.trim() ? `- User guidance: ${input.guidance.trim()}` : '',
      '',
      'To continue later, generate or confirm a new Plan. Tasks not submitted to Kernel are not treated as completion facts.',
    ].filter(Boolean).join('\n');
  }

  private chineseDecisionEffectAnswer(input: AssistantDecisionEffectAnswerInput): string {
    return [
      '## 当前会话已按用户介入收口',
      '',
      '用户已要求停止继续执行并输出总结。以下内容只基于 Session ledger 与 Kernel facts 派生，不声明未发生的工具执行。',
      '',
      input.totalTasks ? `- 已确认任务总数：${input.totalTasks}` : '- 当前没有可恢复的 accepted plan 任务清单。',
      input.totalTasks ? `- 已完成任务：${input.completedTasks}` : '',
      input.totalTasks ? `- 未继续执行任务：${input.pendingTasks}` : '',
      input.reason ? `- 用户介入原因：${input.reason}` : '',
      input.guidance?.trim() ? `- 用户补充说明：${input.guidance.trim()}` : '',
      '',
      '后续如需继续，需要重新生成或确认新的 Plan；未提交 Kernel 的任务不会被视为完成事实。',
    ].filter(Boolean).join('\n');
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
