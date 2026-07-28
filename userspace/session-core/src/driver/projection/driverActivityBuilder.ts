import type { AgentConversationActivity } from '@deepcode/protocol';
import type { ActionBundleDraft, ProposalEnvelope } from '../../protocol/types.js';
import type { AcceptedTaskPlanContext } from '../execution/index.js';
import {
  localizedProjectionText,
  type ConversationPresentationLanguage,
} from './conversationPresentationLanguage.js';

export type DriverActivityLanguage = 'zh-CN' | 'en-US' | 'neutral';

export interface DriverActivityBuilderPorts {
  providerStageSummary(stage: string, part: 'request' | 'response', language: DriverActivityLanguage): string;
  actionFileTargetPath(action: { args?: unknown }): string | undefined;
}

export class DriverActivityBuilder {
  constructor(private readonly ports: DriverActivityBuilderPorts) {}

  conversationActivity(input: AgentConversationActivity): AgentConversationActivity {
    return {
      ...input,
      targets: uniqueStrings(input.targets ?? []),
      actionIds: uniqueStrings(input.actionIds ?? []),
      workUnitIds: uniqueStrings(input.workUnitIds ?? []),
    };
  }

  providerActivity(input: {
    runId: string;
    userRequest: string;
    stage: string;
    status: 'running' | 'completed';
    language: DriverActivityLanguage;
  }): AgentConversationActivity {
    const title = input.language === 'neutral'
      ? input.status === 'running' ? 'LLM …' : 'LLM ✓'
      : input.language === 'zh-CN'
        ? input.status === 'running' ? '模型处理中' : '模型处理完成'
        : input.status === 'running' ? 'Model processing' : 'Model processing completed';
    return this.conversationActivity({
      activityId: `provider-${input.stage}`,
      kind: 'providerThinking',
      status: input.status,
      title,
      summary: this.ports.providerStageSummary(
        input.stage,
        input.status === 'running' ? 'request' : 'response',
        input.language
      ),
      source: 'provider',
      runId: input.runId,
    });
  }

  acceptedPlanBatchActivity(input: {
    accepted: AcceptedTaskPlanContext;
    batch: unknown;
    status: 'running' | 'completed';
    language: ConversationPresentationLanguage;
  }): AgentConversationActivity {
    const actions = this.batchActionRecords(input.batch);
    const title = input.status === 'running'
      ? localizedProjectionText(input.language, {
        zh: '正在提交已确认计划批次',
        en: 'Submitting accepted-plan batch',
        neutral: 'ActionBatch …',
      })
      : localizedProjectionText(input.language, {
        zh: '已确认计划批次已提交',
        en: 'Accepted-plan batch submitted',
        neutral: 'ActionBatch ✓',
      });
    return this.conversationActivity({
      activityId: `accepted-plan-batch-${input.accepted.planId}-${input.accepted.batchIndex}-${input.status}`,
      kind: 'editBatchQueued',
      status: input.status,
      title,
      summary: this.acceptedPlanBatchActivitySummary(input.batch, input.language),
      source: 'session',
      runId: input.accepted.runId,
      planId: input.accepted.planId,
      targets: actions.flatMap((action) => this.actionTargetCandidates(action)),
      actionIds: actions.flatMap((action) => stringValue(action.actionId) ?? []),
      itemCount: actions.length,
    });
  }

  acceptedPlanBatchActivitySummary(
    batch: unknown,
    language: ConversationPresentationLanguage
  ): string {
    const actions = this.batchActionRecords(batch);
    const targetCount = uniqueStrings(actions.flatMap((action) => this.actionTargetCandidates(action))).length;
    return localizedProjectionText(language, {
      zh: `Session 正在为 ${targetCount} 个目标提交 ${actions.length} 个已确认计划操作。`,
      en: `Session is submitting ${actions.length} accepted-plan action(s) for ${targetCount} target(s).`,
      neutral: `ActionBatch actions=${actions.length} targets=${targetCount}`,
    });
  }

  batchActionRecords(batch: unknown): Record<string, unknown>[] {
    const record = objectRecord(batch);
    const nested = objectRecord(record?.actionBundle);
    const actions = Array.isArray(nested?.actions) ? nested.actions : [];
    return actions.flatMap((item) => objectRecord(item) ? [objectRecord(item) as Record<string, unknown>] : []);
  }

  uniqueStrings(values: Array<string | undefined>): string[] {
    return uniqueStrings(values);
  }

  readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined {
    const payload = objectRecord(proposal.payload);
    return objectRecord(payload?.actionBundle) as unknown as ActionBundleDraft | undefined;
  }

  proposalActionBundleAdmissionBatch(proposal: ProposalEnvelope): Record<string, unknown> {
    const payload = objectRecord(proposal.payload) ?? {};
    const actionBundle = objectRecord(payload.actionBundle) ?? {};
    return {
      planId: stringValue(actionBundle.id) ?? proposal.proposalId,
      actionBundle,
      contentBlocks: Array.isArray(payload.contentBlocks) ? payload.contentBlocks : [],
    };
  }

  private actionTargetCandidates(action: Record<string, unknown>): string[] {
    return uniqueStrings([
      this.ports.actionFileTargetPath(action),
    ]);
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

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}
