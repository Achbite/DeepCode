import type {
  AgentEvent,
  AgentTimelineBlock,
  AgentTimelineBlockKind,
  AgentTimelineNarrativeKind,
  AgentTimelineResult,
  AgentTimelineStatus,
  KernelPlanReviewReport,
  PermissionRequest,
} from '@deepcode/protocol';
import type { AgentPlanParts } from './agent-plan/types.js';
import type { ResourcePacket, ResourceRequest } from './context/types.js';
import type { ReviewPacket } from './review/types.js';
import type { TranscriptMessageEntry } from './transcript.js';
import type { DynamicWorkflowPlan } from './workflow/types.js';

export interface PendingPermissionProjection {
  request: PermissionRequest;
}

export interface SessionProjectionCard {
  id: string;
  sessionId?: string;
  kind: 'progress' | 'tool' | 'stage' | 'permission' | 'review' | 'error';
  kernelEventRef?: string;
  title: string;
  detail?: string;
  createdAt: string;
}

export interface SessionProjection {
  messages: TranscriptMessageEntry[];
  cards: SessionProjectionCard[];
}

export const NARRATIVE_TIMELINE_SCHEMA_VERSION = 'deepcode.session.timeline.v1' as const;

export interface NarrativeTimelineProjectionInput {
  sessionId: string;
  events: AgentEvent[];
  generatedAt?: string;
}

export type ConversationProjectionCardKind =
  | 'user_request'
  | 'resource_request'
  | 'resource_packet'
  | 'plan_summary'
  | 'check_review'
  | 'permission'
  | 'execution_progress'
  | 'repair'
  | 'review_summary'
  | 'answer'
  | 'final_answer'
  | 'debug_raw';

export type ConversationProjectionVisibility = 'default' | 'collapsed' | 'debug';

export interface ConversationReasonSummary {
  title: '为什么这样做？';
  summary: string;
}

export interface ConversationPermissionFact {
  id: string;
  capability: string;
  resourceScope: string;
  decision: 'pending' | 'approved' | 'denied';
  summary?: string;
}

export interface ConversationExecutionFact {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  toolName?: string;
  modifiedFiles?: string[];
  validationResult?: string;
  error?: string;
}

export interface ConversationRepairFact {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'escalated';
  reason: string;
}

export interface ConversationProjectionCard {
  id: string;
  sessionId?: string;
  kind: ConversationProjectionCardKind;
  title: string;
  summary: string;
  status?: string;
  visibility: ConversationProjectionVisibility;
  facts: string[];
  collapsedReason?: ConversationReasonSummary;
  debugRefs: string[];
  createdAt: string;
}

export interface ConversationProjectionInput {
  sessionId?: string;
  workflowPlan?: DynamicWorkflowPlan;
  userRequest?: string;
  resourceRequests?: ResourceRequest[];
  resourcePackets?: ResourcePacket[];
  agentPlan?: AgentPlanParts;
  kernelPlanReview?: KernelPlanReviewReport;
  permissions?: ConversationPermissionFact[];
  execution?: ConversationExecutionFact[];
  repairs?: ConversationRepairFact[];
  reviewPacket?: ReviewPacket;
  answer?: string;
  finalAnswer?: string;
  reasonSummaries?: Partial<Record<ConversationProjectionCardKind, string>>;
  debugRefs?: string[];
  createdAt?: string;
}

export type ConversationExportMode = 'summary' | 'complete' | 'debug' | 'audit';

export class ProjectionEngine {
  projectKernelEvents(events: unknown[], sessionId?: string): SessionProjectionCard[] {
    return events.map((event, index) => {
      const value = event as Record<string, unknown>;
      const kind = typeof value.kind === 'string' ? value.kind : 'kernel.event';
      return {
        id: `${kind}-${index}`,
        sessionId,
        kind: this.cardKind(kind),
        kernelEventRef: this.eventRef(value, index),
        title: kind,
        detail: typeof value.summary === 'string' ? value.summary : undefined,
        createdAt: new Date().toISOString(),
      };
    });
  }

  private cardKind(kind: string): SessionProjectionCard['kind'] {
    if (kind.includes('permission')) return 'permission';
    if (kind.includes('tool') || kind.includes('workspace') || kind.includes('skill')) return 'tool';
    if (kind.includes('stage') || kind.includes('workflow')) return 'stage';
    if (kind.includes('review')) return 'review';
    if (kind === 'error') return 'error';
    return 'progress';
  }

  private eventRef(event: Record<string, unknown>, index: number): string {
    const sequence = event.sequence;
    if (typeof sequence === 'number') return `kernel:${sequence}`;
    const requestId = event.requestId;
    if (typeof requestId === 'string') return `kernel:${requestId}`;
    return `kernel:event:${index}`;
  }
}

export function buildNarrativeTimelineProjection(input: NarrativeTimelineProjectionInput): AgentTimelineResult {
  const turns: AgentTimelineResult['turns'] = [];
  let currentTurn: AgentTimelineResult['turns'][number] | null = null;
  let syntheticTurnIndex = 0;

  input.events.forEach((event, index) => {
    if (event.kind === 'user_msg') {
      if (currentTurn) turns.push(finalizeNarrativeTurn(currentTurn));
      currentTurn = {
        id: `turn-${event.id || index}`,
        sessionId: input.sessionId,
        status: 'running',
        startedAt: event.ts,
        blocks: [narrativeBlockFromEvents([event], index)],
      };
      return;
    }

    if (!currentTurn) {
      syntheticTurnIndex += 1;
      currentTurn = {
        id: `turn-orphan-${syntheticTurnIndex}`,
        sessionId: input.sessionId,
        status: 'running',
        startedAt: event.ts,
        blocks: [],
      };
    }

    appendNarrativeBlock(currentTurn.blocks, event, index);
  });

  if (currentTurn) turns.push(finalizeNarrativeTurn(currentTurn));
  const rawEventRefs = input.events.map(eventRefForAgentEvent);
  const taskItems = turns.flatMap((turn) =>
    turn.blocks
      .filter((block) => block.displayHints?.showInTaskList)
      .map((block) => ({
        id: block.taskProjectionRef ?? `task-${block.id}`,
        title: block.displayHints?.taskListLabel ?? block.title,
        summary: block.displayHints?.taskListSummary ?? block.summary,
        status: block.status,
        blockId: block.id,
        narrativeKind: block.narrativeKind ?? narrativeKindForLegacyKind(block.kind),
      }))
  );

  return {
    schemaVersion: NARRATIVE_TIMELINE_SCHEMA_VERSION,
    sessionId: input.sessionId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    turns,
    eventCount: input.events.length,
    taskProjection: {
      title: 'Task projection',
      items: taskItems.slice(-8),
    },
    rawEventRefs,
  };
}

function appendNarrativeBlock(blocks: AgentTimelineBlock[], event: AgentEvent, index: number): void {
  const nextNarrativeKind = narrativeKindForEvent(event);
  const nextLegacyKind = legacyKindForNarrative(nextNarrativeKind);
  const groupable = nextNarrativeKind === 'operationEvidence' || nextNarrativeKind === 'thinking';
  const last = blocks[blocks.length - 1];
  if (groupable && last?.narrativeKind === nextNarrativeKind && last.status !== 'failed') {
    const events = [...last.events, event];
    blocks[blocks.length - 1] = narrativeBlockFromEvents(events, index, last.id, nextLegacyKind, nextNarrativeKind);
    return;
  }
  blocks.push(narrativeBlockFromEvents([event], index, undefined, nextLegacyKind, nextNarrativeKind));
}

function narrativeBlockFromEvents(
  events: AgentEvent[],
  index: number,
  existingId?: string,
  forcedKind?: AgentTimelineBlockKind,
  forcedNarrativeKind?: AgentTimelineNarrativeKind
): AgentTimelineBlock {
  const first = events[0];
  const narrativeKind = forcedNarrativeKind ?? narrativeKindForEvent(first);
  const legacyKind = forcedKind ?? legacyKindForNarrative(narrativeKind);
  const status = narrativeStatus(events);
  const title = narrativeTitle(events, narrativeKind);
  const summary = summarizeAgentEvents(events);
  return {
    id: existingId ?? `${narrativeKind}-${first.id || index}`,
    kind: legacyKind,
    narrativeKind,
    title,
    summary,
    status,
    defaultCollapsed: narrativeDefaultCollapsed(narrativeKind, status),
    bodyMarkdown: narrativeBody(events, narrativeKind),
    displayHints: narrativeDisplayHints(narrativeKind, title, summary),
    evidenceRefs: events.flatMap(eventEvidenceRefs),
    rawEventRefs: events.map(eventRefForAgentEvent),
    taskProjectionRef: shouldShowNarrativeInTaskList(narrativeKind) ? `task-${narrativeKind}-${first.id || index}` : undefined,
    events,
  };
}

function finalizeNarrativeTurn(turn: AgentTimelineResult['turns'][number]): AgentTimelineResult['turns'][number] {
  const hasFailure = turn.blocks.some((block) => block.status === 'failed');
  const hasWaiting = turn.blocks.some((block) => block.status === 'waiting' || block.status === 'blocked');
  const hasRunning = turn.blocks.some((block) => block.status === 'running');
  const hasAssistant = turn.blocks.some((block) => block.narrativeKind === 'assistantText');
  const status: AgentTimelineStatus = hasFailure
    ? 'failed'
    : hasWaiting
      ? 'blocked'
      : hasRunning && !hasAssistant
        ? 'running'
        : 'completed';
  return {
    ...turn,
    status,
    completedAt: status === 'completed' || status === 'failed'
      ? [...turn.blocks].reverse().flatMap((block) => [...block.events].reverse()).find((event) => event.ts)?.ts
      : turn.completedAt,
  };
}

function narrativeKindForEvent(event: AgentEvent): AgentTimelineNarrativeKind {
  if (event.kind === 'user_msg') return 'user';
  if (event.kind === 'requirement_confirmation' || event.kind === 'requirement_decision') return 'requirement';
  if (event.kind === 'plan_card' || event.kind === 'plan_review') return 'plan';
  if (event.kind === 'permission_request' || event.kind === 'permission_result') return 'permission';
  if (event.kind === 'review_summary') return 'review';
  if (event.kind === 'error') return 'diagnostic';
  if (event.kind === 'assistant_msg') {
    const channel = stringValueFromPayload(event.payload, 'channel');
    if (channel === 'reasoning') return 'thinking';
    if (channel === 'final') return 'assistantText';
    return 'operationEvidence';
  }
  if (event.kind === 'tool_call' || event.kind === 'tool_result') return 'operationEvidence';
  if (event.kind === 'workflow_stage' || event.kind === 'workflow_decision') return 'operationEvidence';
  return 'operationEvidence';
}

function legacyKindForNarrative(kind: AgentTimelineNarrativeKind): AgentTimelineBlockKind {
  switch (kind) {
    case 'user':
      return 'user';
    case 'assistantText':
      return 'assistant';
    case 'thinking':
      return 'thinking';
    case 'plan':
      return 'plan';
    case 'permission':
      return 'permission';
    case 'review':
      return 'review';
    case 'diagnostic':
      return 'error';
    case 'operationEvidence':
    case 'requirement':
    case 'verification':
      return 'stage';
    default:
      return 'stage';
  }
}

function narrativeKindForLegacyKind(kind: AgentTimelineBlockKind): AgentTimelineNarrativeKind {
  switch (kind) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistantText';
    case 'thinking':
      return 'thinking';
    case 'plan':
      return 'plan';
    case 'permission':
      return 'permission';
    case 'review':
      return 'review';
    case 'error':
      return 'diagnostic';
    default:
      return 'operationEvidence';
  }
}

function narrativeStatus(events: AgentEvent[]): AgentTimelineStatus {
  if (events.some((event) => event.kind === 'error' || stringValueFromPayload(event.payload, 'status') === 'error')) {
    return 'failed';
  }
  if (events.some((event) => event.kind === 'permission_request') && !events.some((event) => event.kind === 'permission_result')) {
    return 'waiting';
  }
  if (events.some((event) => event.kind === 'plan_review' && stringValueFromPayload(event.payload, 'confirmable') !== 'false')) {
    return 'waiting';
  }
  if (events.some((event) => event.kind === 'tool_call' || stringValueFromPayload(event.payload, 'status') === 'running')) {
    const hasCompletion = events.some((event) =>
      event.kind === 'tool_result' ||
      ['completed', 'done', 'ok', 'succeeded'].includes(stringValueFromPayload(event.payload, 'status') ?? '')
    );
    if (!hasCompletion) return 'running';
  }
  return 'completed';
}

function narrativeTitle(events: AgentEvent[], kind: AgentTimelineNarrativeKind): string {
  const first = events[0];
  if (kind === 'user') return 'User';
  if (kind === 'assistantText') return 'DeepCode';
  if (kind === 'thinking') return 'Thinking';
  if (kind === 'operationEvidence') return firstNonEmpty(events, ['summary', 'toolName', 'name', 'stage']) ?? 'Operation evidence';
  if (kind === 'requirement') return firstNonEmpty(events, ['title', 'summary']) ?? 'Requirement';
  if (kind === 'plan') return firstNonEmpty(events, ['title', 'summary']) ?? 'Plan';
  if (kind === 'permission') return firstNonEmpty(events, ['summary', 'toolName']) ?? 'Permission';
  if (kind === 'verification') return firstNonEmpty(events, ['summary']) ?? 'Verification';
  if (kind === 'review') return firstNonEmpty(events, ['title', 'summary']) ?? 'Review';
  return firstNonEmpty([first], ['summary', 'message', 'details']) ?? 'Diagnostic';
}

function summarizeAgentEvents(events: AgentEvent[]): string {
  const summaries = events
    .map((event) => firstNonEmpty([event], ['summary', 'message', 'content', 'details', 'toolName', 'name', 'stage']))
    .filter((value): value is string => Boolean(value));
  if (summaries.length === 0) return `${events.length} event${events.length === 1 ? '' : 's'}`;
  if (summaries.length === 1) return trimProjectionText(summaries[0], 180);
  return trimProjectionText(summaries.join(' / '), 220);
}

function narrativeBody(events: AgentEvent[], kind: AgentTimelineNarrativeKind): string | undefined {
  if (kind === 'operationEvidence') return undefined;
  const text = firstNonEmpty(events, ['content', 'message', 'summary', 'details']);
  return text?.trim() ? text : undefined;
}

function narrativeDefaultCollapsed(kind: AgentTimelineNarrativeKind, status: AgentTimelineStatus): boolean {
  if (status === 'running' || status === 'waiting') return false;
  return kind === 'thinking' || kind === 'operationEvidence' || kind === 'permission';
}

function narrativeDisplayHints(
  kind: AgentTimelineNarrativeKind,
  title: string,
  summary: string
): AgentTimelineBlock['displayHints'] {
  return {
    density: kind === 'operationEvidence' ? 'compact' : 'normal',
    evidenceMode: kind === 'operationEvidence' ? 'collapsed' : 'inline',
    showInTaskList: shouldShowNarrativeInTaskList(kind),
    taskListLabel: title,
    taskListSummary: summary,
  };
}

function shouldShowNarrativeInTaskList(kind: AgentTimelineNarrativeKind): boolean {
  return kind === 'operationEvidence' ||
    kind === 'requirement' ||
    kind === 'plan' ||
    kind === 'permission' ||
    kind === 'verification' ||
    kind === 'review' ||
    kind === 'diagnostic';
}

function firstNonEmpty(events: AgentEvent[], keys: string[]): string | undefined {
  for (const event of events) {
    for (const key of keys) {
      const value = stringValueFromPayload(event.payload, key);
      if (value) return value;
    }
  }
  return undefined;
}

function stringValueFromPayload(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === 'boolean') return String(value);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function eventEvidenceRefs(event: AgentEvent): string[] {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return [];
  const payload = event.payload as Record<string, unknown>;
  const refs = payload.evidenceRefs;
  if (Array.isArray(refs)) return refs.flatMap((ref) => typeof ref === 'string' ? [ref] : []);
  const auditRefs = payload.auditRefs;
  if (Array.isArray(auditRefs)) return auditRefs.flatMap((ref) => typeof ref === 'string' ? [ref] : []);
  return [];
}

function eventRefForAgentEvent(event: AgentEvent): string {
  return `event:${event.id}`;
}

function trimProjectionText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

export function buildConversationProjection(input: ConversationProjectionInput): ConversationProjectionCard[] {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const cards: ConversationProjectionCard[] = [];

  if (input.userRequest?.trim()) {
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'user_request',
        title: '用户请求',
        summary: input.userRequest.trim(),
        facts: [],
      })
    );
  }

  for (const request of input.resourceRequests ?? []) {
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'resource_request',
        title: 'ResourceRequest',
        summary: `请求补充 ${request.items.length} 项只读上下文。`,
        status: 'pending',
        facts: request.items.map((item) => `${item.manifestEntryId ?? item.path ?? item.id}：${item.reason}`),
      })
    );
  }

  for (const packet of input.resourcePackets ?? []) {
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'resource_packet',
        title: 'ResourcePacket',
        summary: `返回 ${packet.items.length} 项资源请求结果。`,
        status: packet.items.some((item) => item.status === 'denied')
          ? 'denied'
          : packet.items.some((item) => item.status === 'needsUserApproval')
            ? 'needsUserApproval'
            : 'provided',
        facts: packet.items.map((item) => `${item.manifestEntryId}:${item.status}`),
      })
    );
  }

  if (input.agentPlan) {
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'plan_summary',
        title: 'Plan',
        summary: firstLine(input.agentPlan.userPlan),
        facts: [
          `任务数：${input.agentPlan.actionBundle.actions.length}`,
          `验证候选：${input.agentPlan.expectedValidation.expectations.length}`,
          `Review 建议：${input.agentPlan.reviewGuide.expectations.length}`,
        ],
      })
    );
  }

  if (input.kernelPlanReview || input.agentPlan) {
    const report = input.kernelPlanReview;
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'check_review',
        title: '计划确认',
        summary:
          report?.kernelGeneratedPermissionSummary ??
          '等待 Kernel PlanReview 和用户计划确认；权限只作为预览，真实授权在执行前触发。',
        status: report?.status,
        facts: report
          ? [
              `状态：${report.status}`,
              `所需能力：${report.requiredCapabilities.join(', ') || '无'}`,
              `权限缺口：${(report.permissionGaps ?? []).join(', ') || '无'}`,
              `拒绝原因：${(report.deniedReasons ?? report.blockedReasons).join(', ') || '无'}`,
            ]
          : ['用户尚未确认计划，不能生成 ApprovedTaskQueue。'],
      })
    );
  }

  for (const permission of input.permissions ?? []) {
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'permission',
        title: 'Permission',
        summary: permission.summary ?? `${permission.capability} -> ${permission.resourceScope}`,
        status: permission.decision,
        facts: [
          `能力：${permission.capability}`,
          `资源：${permission.resourceScope}`,
          `用户决策：${permission.decision}`,
        ],
      })
    );
  }

  if ((input.execution ?? []).length > 0) {
    const execution = input.execution ?? [];
    const succeeded = execution.filter((item) => item.status === 'succeeded').length;
    const failed = execution.filter((item) => item.status === 'failed').length;
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'execution_progress',
        title: 'Execution',
        summary: `工具进度：${succeeded} 成功，${failed} 失败。`,
        status: failed > 0 ? 'failed' : 'succeeded',
        facts: execution.map((item) => {
          const mark = item.status === 'succeeded' ? 'OK' : item.status === 'failed' ? 'FAIL' : 'PENDING';
          const suffix = item.toolName ? ` (${item.toolName})` : '';
          return `${mark} ${item.title}${suffix}`;
        }),
      })
    );
  }

  for (const repair of input.repairs ?? []) {
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'repair',
        title: 'Repair',
        summary: repair.title,
        status: repair.status,
        facts: [`原因：${repair.reason}`],
      })
    );
  }

  if (input.reviewPacket) {
    const facts = input.reviewPacket.kernelFacts;
    const finalSummary = input.reviewPacket.llmGuidance.finalSummary || input.reviewPacket.llmGuidance.summary;
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'review_summary',
        title: 'Review',
        summary: finalSummary,
        status: input.reviewPacket.status,
        facts: [
          `状态：${input.reviewPacket.status}`,
          `修改文件：${facts.modifiedFiles.join(', ') || '无'}`,
          `新增文件：${facts.createdFiles.join(', ') || '无'}`,
          `删除文件：${facts.deletedFiles.join(', ') || '无'}`,
          `执行命令：${facts.commandsExecuted.join(', ') || '无'}`,
          `权限使用：${facts.permissionDecisions.map((item) => `${item.capability}:${item.decision}`).join(', ') || '无'}`,
          `工具结果：${facts.toolResults.map((item) => `${item.title}:${item.status}`).join(', ') || '无'}`,
          `验证结果：${facts.validationResults.map((item) => `${item.description}:${item.status}`).join(', ') || '无'}`,
          `审计引用：${facts.auditRefs.join(', ') || '无'}`,
          `用户审查建议：${input.reviewPacket.llmGuidance.suggestedReviewChecks.join('；') || '无'}`,
        ],
      })
    );
  } else if ((input.execution ?? []).length > 0) {
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'review_summary',
        title: 'Review',
        summary: '等待 LLM 自检与 Kernel facts 合并生成 ReviewPacket；最终验收仍由用户完成。',
        status: 'pending',
        facts: [
          'Review pending：执行阶段已有工具事实，但尚未形成 ReviewPacket。',
          '不能停留在 Execution 卡；需要继续组装 Review 自检与 Kernel facts。',
        ],
      })
    );
  } else if (input.answer?.trim()) {
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'answer',
        title: 'Answer',
        summary: input.answer.trim(),
        facts: ['只读 / 纯问答动态 workflow 回答；不包含执行事实。'],
      })
    );
  } else if (input.finalAnswer?.trim()) {
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'final_answer',
        title: 'Final',
        summary: input.finalAnswer.trim(),
        facts: ['纯问答或无 ReviewPacket 的 fast path 最终回答。'],
      })
    );
  }

  return orderConversationCards(cards, input.workflowPlan?.projectionCardKinds);
}

export function exportConversationProjection(cards: ConversationProjectionCard[], mode: ConversationExportMode): string {
  const selected = cards.filter((card) => {
    if (mode === 'debug') return true;
    if (mode === 'audit') return card.kind === 'permission' || card.kind === 'execution_progress' || card.kind === 'review_summary';
    return card.visibility === 'default';
  });

  return selected
    .map((card) => {
      const lines = [`## ${card.title}`, card.summary];
      if (card.facts.length > 0) {
        lines.push('', ...card.facts.map((fact) => `- ${fact}`));
      }
      if (mode === 'complete' && card.collapsedReason) {
        lines.push('', `### ${card.collapsedReason.title}`, card.collapsedReason.summary);
      }
      if (mode === 'debug' && card.debugRefs.length > 0) {
        lines.push('', '### Debug refs', ...card.debugRefs.map((ref) => `- ${ref}`));
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function conversationCard(
  input: ConversationProjectionInput,
  createdAt: string,
  value: Omit<ConversationProjectionCard, 'id' | 'sessionId' | 'visibility' | 'collapsedReason' | 'debugRefs' | 'createdAt'>
): ConversationProjectionCard {
  return {
    ...value,
    id: `${value.kind}-${value.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'card'}`,
    sessionId: input.sessionId,
    visibility: 'default',
    collapsedReason: reasonSummary(input, value.kind),
    debugRefs: input.debugRefs ?? [],
    createdAt,
  };
}

function reasonSummary(
  input: ConversationProjectionInput,
  kind: ConversationProjectionCardKind
): ConversationReasonSummary | undefined {
  const summary = input.reasonSummaries?.[kind];
  if (!summary?.trim()) return undefined;
  return {
    title: '为什么这样做？',
    summary: summary.trim(),
  };
}

function firstLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
}

function orderConversationCards(
  cards: ConversationProjectionCard[],
  order?: ConversationProjectionCardKind[]
): ConversationProjectionCard[] {
  if (!order || order.length === 0) return cards;
  const orderIndex = new Map(order.map((kind, index) => [kind, index]));
  return cards
    .map((card, index) => ({ card, index }))
    .sort((left, right) => {
      const leftOrder = orderIndex.get(left.card.kind) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = orderIndex.get(right.card.kind) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.index - right.index;
    })
    .map((entry) => entry.card);
}

export function findLatestPendingPermission(events: AgentEvent[]): PendingPermissionProjection | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'permission_result') return null;
    if (event.kind === 'permission_request') {
      return { request: event.payload as PermissionRequest };
    }
  }
  return null;
}
