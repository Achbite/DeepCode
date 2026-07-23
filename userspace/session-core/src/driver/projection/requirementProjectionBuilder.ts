import type { AgentContextAttachment, AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { RequirementRecord } from '../../requirement/types.js';

export type RequirementDecisionKind = 'accept' | 'reject' | 'revise';
export type RequirementDecisionLanguage = 'zh-CN' | 'en-US';

export interface RequirementDecisionOption {
  id: string;
  label: string;
  labelKey?: string;
  description?: string;
  descriptionKey?: string;
  messageArgs?: Record<string, string>;
  recommended?: boolean;
  effect?: unknown;
}

export interface RequirementProjectionBuilderPorts {
  interactionOverlayPayload(payload: Record<string, unknown>): Record<string, unknown>;
}

export interface RequirementDecisionEventInput {
  sessionId: string;
  event: AgentEvent;
  decision: RequirementDecisionKind;
  guidance?: string;
  ts: string;
  id: string;
}

interface RequirementLocalizedSummary {
  text: string;
  key: string;
  args: Record<string, string>;
}

export interface RequirementConfirmationEventInput {
  sessionId: string;
  runId: string;
  requirement: RequirementRecord;
  proposal: ProposalEnvelope;
  originalUserRequest: string;
  attachments: AgentContextAttachment[];
  executionRootPayload?: Record<string, unknown>;
  interactionOverlayPayload?: Record<string, unknown>;
  ts: string;
  id: string;
}

export class RequirementProjectionBuilder {
  constructor(private readonly ports: RequirementProjectionBuilderPorts) {}

  confirmationEvent(input: RequirementConfirmationEventInput): AgentEvent {
    const decisionRequest = objectRecord(input.proposal.payload);
    const language = input.proposal.responseLanguage ?? 'zh-CN';
    const content = decisionRequest && this.isDecisionRequestPayload(decisionRequest)
      ? this.renderDecisionRequestMarkdown(decisionRequest, language)
      : this.renderRequirementConfirmationMarkdown(input.requirement);
    const summary = this.decisionRequestSummary(decisionRequest) ?? this.requirementSummary(input.requirement);
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'requirement_confirmation',
      payload: {
        title: '用户介入请求',
        titleKey: 'session.driver.requirementConfirmation.title',
        summary,
        content,
        status: 'waitingUserConfirmation',
        confirmable: true,
        runId: input.runId,
        requirementId: input.requirement.requirementId,
        requirement: input.requirement,
        decisionRequest: input.proposal.payload,
        proposalId: input.proposal.proposalId,
        responseLanguage: language,
        originalUserRequest: input.originalUserRequest,
        attachments: input.attachments,
        executionRoot: input.executionRootPayload,
        ...(input.interactionOverlayPayload ?? {}),
        channel: 'action',
        visibility: 'conversation',
        presentation: 'body',
      },
    };
  }

  decisionEvent(input: RequirementDecisionEventInput): AgentEvent {
    const payload = objectRecord(input.event.payload) ?? {};
    const decisionRequest = objectRecord(payload.decisionRequest);
    const selectedOption = input.decision === 'accept'
      ? this.selectedDecisionOptionFromGuidance(decisionRequest, input.guidance)
      : undefined;
    const language = conversationLanguage(payload.responseLanguage) ?? 'zh-CN';
    const summary = this.decisionSummary(input.decision, selectedOption, language);
    const overlayPayload = this.ports.interactionOverlayPayload(payload);
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'requirement_decision',
      payload: {
        title: 'Requirement decision',
        titleKey: 'session.driver.requirementDecision.title',
        summary: summary.text,
        summaryKey: summary.key,
        messageKey: summary.key,
        messageArgs: summary.args,
        status: input.decision === 'accept' ? 'accepted' : input.decision === 'revise' ? 'needsRevision' : 'rejected',
        runId: stringValue(payload.runId),
        requirementId: stringValue(payload.requirementId),
        decision: input.decision,
        guidance: input.guidance,
        selectedOption,
        ...overlayPayload,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'body',
      },
    };
  }

  isDecisionRequestPayload(value: Record<string, unknown> | undefined): boolean {
    return this.decisionRequestOptions(value).length >= 2;
  }

  decisionRequestSummary(value: Record<string, unknown> | undefined): string | undefined {
    if (!value) return undefined;
    return stringValue(value.summary)
      ?? stringValue(value.question)
      ?? stringValue(value.reason)
      ?? stringValue(value.goal);
  }

  decisionRequestOptions(value: Record<string, unknown> | undefined): RequirementDecisionOption[] {
    if (!Array.isArray(value?.options)) return [];
    return value.options.flatMap((item): RequirementDecisionOption[] => {
      const record = objectRecord(item);
      if (!record) return [];
      const id = stringValue(record.id) ?? stringValue(record.label);
      const label = stringValue(record.label) ?? id;
      if (!id || !label) return [];
      const description = stringValue(record.description)
        ?? stringValue(record.impact)
        ?? stringValue(record.tradeoff);
      return [{
        id,
        label,
        labelKey: stringValue(record.labelKey),
        description,
        descriptionKey: stringValue(record.descriptionKey),
        messageArgs: stringRecordValue(record.messageArgs),
        recommended: record.recommended === true,
        effect: record.effect,
      }];
    });
  }

  selectedDecisionOptionFromGuidance(
    decisionRequest: Record<string, unknown> | undefined,
    guidance: string | undefined
  ): RequirementDecisionOption | undefined {
    const options = this.decisionRequestOptions(decisionRequest);
    if (!options.length) return undefined;
    const selectedId = guidance?.match(/^- id:\s*(.+)$/m)?.[1]?.trim();
    const selectedLabel = guidance?.match(/^- label:\s*(.+)$/m)?.[1]?.trim();
    return (selectedId ? options.find((option) => option.id === selectedId) : undefined)
      ?? (selectedLabel ? options.find((option) => option.label === selectedLabel) : undefined)
      ?? options.find((option) => option.recommended)
      ?? options[0];
  }

  private decisionSummary(
    decision: RequirementDecisionKind,
    selectedOption: RequirementDecisionOption | undefined,
    language: RequirementDecisionLanguage
  ): RequirementLocalizedSummary {
    if (language === 'en-US') {
      if (decision === 'accept' && selectedOption?.label) {
        return {
          text: `Selected option: ${selectedOption.label}`,
          key: 'session.driver.requirementDecision.selectedOption',
          args: { label: selectedOption.label },
        };
      }
      if (decision === 'accept') {
        return {
          text: 'The user confirmed the requirement understanding.',
          key: 'session.driver.requirementDecision.accepted',
          args: {},
        };
      }
      if (decision === 'revise') {
        return {
          text: 'The user requested requirement revisions.',
          key: 'session.driver.requirementDecision.needsRevision',
          args: {},
        };
      }
      return {
        text: 'The user rejected the current requirement understanding.',
        key: 'session.driver.requirementDecision.rejected',
        args: {},
      };
    }
    if (decision === 'accept' && selectedOption?.label) {
      return {
        text: `已选择方案：${selectedOption.label}`,
        key: 'session.driver.requirementDecision.selectedOption',
        args: { label: selectedOption.label },
      };
    }
    if (decision === 'accept') {
      return {
        text: '用户已确认需求理解。',
        key: 'session.driver.requirementDecision.accepted',
        args: {},
      };
    }
    if (decision === 'revise') {
      return {
        text: '用户要求修订需求理解。',
        key: 'session.driver.requirementDecision.needsRevision',
        args: {},
      };
    }
    return {
      text: '用户拒绝当前需求理解。',
      key: 'session.driver.requirementDecision.rejected',
      args: {},
    };
  }

  private renderRequirementConfirmationMarkdown(requirement: RequirementRecord): string {
    const checklist = requirement.checklist;
    const sections = [
      ['目标', checklist?.goal ? [checklist.goal] : []],
      ['范围', checklist?.explicitTasks ?? []],
      ['非目标', checklist?.outOfScope ?? []],
      ['约束', checklist?.inferredTasks ?? []],
      ['风险点', checklist?.riskNotes ?? []],
      ['验收标准', checklist?.acceptanceCriteriaCandidates ?? []],
      ['仍不明确的问题', checklist?.clarificationQuestions ?? []],
    ] as const;
    return sections
      .map(([heading, items]) => {
        const body = items.length
          ? items.map((item) => `- ${item}`).join('\n')
          : '- 暂无。';
        return `## ${heading}\n${body}`;
      })
      .join('\n\n');
  }

  private renderDecisionRequestMarkdown(
    decisionRequest: Record<string, unknown>,
    language: RequirementDecisionLanguage
  ): string {
    const options = this.decisionRequestOptions(decisionRequest);
    const summary = this.decisionRequestSummary(decisionRequest);
    const labels = language === 'en-US'
      ? {
        heading: 'Decision needed',
        options: 'Options',
        recommended: 'recommended',
        supplement: 'Supplemental input',
        supplementText: 'Use the input box to choose an option or add constraints before continuing.',
      }
      : {
        heading: '需要确认的选择',
        options: '可选方案',
        recommended: '推荐',
        supplement: '补充信息',
        supplementText: '可在输入框选择方案编号，或补充约束后再继续。',
      };
    const lines = [`## ${labels.heading}`];
    if (summary) lines.push('', summary);
    lines.push('', `## ${labels.options}`, '');
    options.forEach((option, index) => {
      const recommended = option.recommended ? `（${labels.recommended}）` : '';
      lines.push(`${index + 1}. ${option.label}${recommended}`);
      if (option.description) lines.push(`   ${option.description}`);
    });
    lines.push('', `## ${labels.supplement}`, '', labels.supplementText);
    return lines.join('\n');
  }

  private requirementSummary(requirement: RequirementRecord): string {
    return requirement.checklist?.goal || requirement.initialUserRequest;
  }
}

function conversationLanguage(value: unknown): RequirementDecisionLanguage | undefined {
  return value === 'zh-CN' || value === 'en-US' ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}
