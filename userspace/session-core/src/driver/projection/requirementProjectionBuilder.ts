import type { AgentEvent } from '@deepcode/protocol';

export type RequirementDecisionKind = 'accept' | 'reject' | 'revise';
export type RequirementDecisionLanguage = 'zh-CN' | 'en-US';

export interface RequirementDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  effect?: unknown;
}

export interface RequirementProjectionBuilderPorts {
  visibleLanguageForRequest(userRequest: string): RequirementDecisionLanguage;
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

export class RequirementProjectionBuilder {
  constructor(private readonly ports: RequirementProjectionBuilderPorts) {}

  decisionEvent(input: RequirementDecisionEventInput): AgentEvent {
    const payload = objectRecord(input.event.payload) ?? {};
    const decisionRequest = objectRecord(payload.decisionRequest);
    const selectedOption = input.decision === 'accept'
      ? this.selectedDecisionOptionFromGuidance(decisionRequest, input.guidance)
      : undefined;
    const language = this.ports.visibleLanguageForRequest(stringValue(payload.originalUserRequest) ?? '');
    const summary = this.decisionSummary(input.decision, selectedOption, language);
    const overlayPayload = this.ports.interactionOverlayPayload(payload);
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'requirement_decision',
      payload: {
        title: 'Requirement decision',
        summary,
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
        description,
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
  ): string {
    if (language === 'en-US') {
      if (decision === 'accept' && selectedOption?.label) return `Selected option: ${selectedOption.label}`;
      if (decision === 'accept') return 'The user confirmed the requirement understanding.';
      if (decision === 'revise') return 'The user requested requirement revisions.';
      return 'The user rejected the current requirement understanding.';
    }
    if (decision === 'accept' && selectedOption?.label) return `已选择方案：${selectedOption.label}`;
    if (decision === 'accept') return '用户已确认需求理解。';
    if (decision === 'revise') return '用户要求修订需求理解。';
    return '用户拒绝当前需求理解。';
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
