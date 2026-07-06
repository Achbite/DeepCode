import type { AgentConversationActivity } from '@deepcode/protocol';
import type { ActionBundleDraft, ProposalEnvelope } from '../../protocol/types.js';
import type { AcceptedImplementationPlanContext } from '../execution/index.js';

export type DriverActivityLanguage = 'zh-CN' | 'en-US';

export interface DriverActivityBuilderPorts {
  providerStageSummary(stage: string, part: 'request' | 'response', language: DriverActivityLanguage): string;
  visibleLanguageForRequest(userRequest: string): DriverActivityLanguage;
  actionFileTargetPath(action: { targetRef?: unknown; targetPath?: unknown; resourceScope?: unknown; args?: unknown }): string | undefined;
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
  }): AgentConversationActivity {
    return this.conversationActivity({
      activityId: `provider-${input.stage}`,
      kind: 'providerThinking',
      status: input.status,
      title: input.status === 'running' ? 'Provider call running' : 'Provider call completed',
      summary: this.ports.providerStageSummary(
        input.stage,
        input.status === 'running' ? 'request' : 'response',
        this.ports.visibleLanguageForRequest(input.userRequest)
      ),
      source: 'provider',
      runId: input.runId,
    });
  }

  acceptedPlanBatchActivity(input: {
    accepted: AcceptedImplementationPlanContext;
    batch: unknown;
    status: 'running' | 'completed';
  }): AgentConversationActivity {
    const actions = this.batchActionRecords(input.batch);
    return this.conversationActivity({
      activityId: `accepted-plan-batch-${input.accepted.planId}-${input.accepted.batchIndex}-${input.status}`,
      kind: 'editBatchQueued',
      status: input.status,
      title: input.status === 'running' ? 'Submitting accepted-plan batch' : 'Accepted-plan batch submitted',
      summary: this.acceptedPlanBatchActivitySummary(input.batch),
      source: 'session',
      runId: input.accepted.runId,
      planId: input.accepted.planId,
      targets: actions.flatMap((action) => this.actionTargetCandidates(action)),
      actionIds: actions.flatMap((action) => stringValue(action.actionId) ?? stringValue(action.id) ?? []),
      itemCount: actions.length,
    });
  }

  acceptedPlanBatchActivitySummary(batch: unknown): string {
    const actions = this.batchActionRecords(batch);
    const targetCount = uniqueStrings(actions.flatMap((action) => this.actionTargetCandidates(action))).length;
    return `Session is submitting ${actions.length} accepted-plan action(s) for ${targetCount} target(s).`;
  }

  batchActionRecords(batch: unknown): Record<string, unknown>[] {
    const record = objectRecord(batch);
    const nested = objectRecord(record?.actionBundle);
    const actions = Array.isArray(record?.actions)
      ? record.actions
      : Array.isArray(nested?.actions)
        ? nested.actions
        : [];
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
      codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
      commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
    };
  }

  private actionTargetCandidates(action: Record<string, unknown>): string[] {
    return uniqueStrings([
      this.ports.actionFileTargetPath(action),
      stringValue(action.targetPath),
      ...stringArrayValue(action.resourceScope),
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
