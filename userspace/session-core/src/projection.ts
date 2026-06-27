import type {
  AgentEvent,
  AgentConversationActivity,
  AgentEventChannel,
  AgentTimelineBlock,
  AgentTimelineBlockKind,
  AgentTimelineNarrativeKind,
  AgentTimelineResult,
  AgentTimelineStatus,
  AgentTimelineTokenUsageProjection,
  AgentTimelineTokenUsageRequest,
  AgentTimelineTokenUsageTotals,
  KernelPlanReviewReport,
  PermissionRequest,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { AgentPlanParts } from './agent-plan/types.js';
import type { ResourcePacket, ResourceRequest } from './context/types.js';
import type { ReviewPacket } from './review/types.js';
import { isInternalOrchestrationStage, isMainTimelineActivityShape } from './timelineFilter.js';
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

type NarrativeRenderMode = NonNullable<NonNullable<AgentTimelineBlock['displayHints']>['renderMode']>;

export interface NarrativeTimelineProjectionInput {
  sessionId: string;
  events: AgentEvent[];
  generatedAt?: string;
}

export interface TimelineProjectionWithLiveOverlayInput {
  sessionId: string;
  committedEvents: AgentEvent[];
  activeDeltas?: ProjectionDelta[];
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

  // P4(B)：预扫描 plan_review.accepted 的事件索引，作为 plan(explore) → execute 阶段分界。
  // 不依赖具体 planId，简单按"是否已出现任何 accepted 的 plan_review"判定。
  const acceptedReviewIndex = findFirstAcceptedReviewIndex(input.events);

  input.events.forEach((event, index) => {
    if (event.kind === 'cache_telemetry') {
      return;
    }
    if (isDebugTimelineEvent(event)) {
      return;
    }
    if (isProjectionTimelineHiddenEvent(event)) {
      return;
    }
    // 跳过空/纯代码围栏的 reasoning 事件，避免产生空"推理过程"块。
    if (event.kind === 'assistant_msg' && isBlankReasoningEvent(event)) {
      return;
    }

    const userInputEvent = userInputBubbleEvent(event, index);
    if (userInputEvent) {
      if (currentTurn) turns.push(finalizeNarrativeTurn(currentTurn));
      currentTurn = {
        id: `turn-${userInputEvent.id || index}`,
        sessionId: input.sessionId,
        status: 'running',
        startedAt: userInputEvent.ts,
        blocks: [narrativeBlockFromEvents([userInputEvent], index)],
      };
      if (isUserInputAuditOnlyEvent(event)) {
        return;
      }
    }

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

  // P4(B)：按 plan_review.accepted 边界给 displayHints 注入 phase。
  // 使用 block.rawEventRefs 推断最早事件索引（rawEventRefs 与事件顺序一致）。
  if (acceptedReviewIndex >= 0) {
    annotateBlocksWithPhase(turns, input.events, acceptedReviewIndex);
  }

  const rawEventRefs = input.events.map(eventRefForAgentEvent);
  const implementationTaskItems = input.events.flatMap((event, index) =>
    implementationPlanTaskProjectionItems(input.events, event, index)
  );

  return {
    schemaVersion: NARRATIVE_TIMELINE_SCHEMA_VERSION,
    sessionId: input.sessionId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    turns,
    eventCount: input.events.length,
    taskProjection: {
      title: 'Task projection',
      items: implementationTaskItems.slice(-8),
    },
    tokenUsageProjection: buildTokenUsageProjection(input.events),
    rawEventRefs,
  };
}

export function buildTimelineProjectionWithLiveOverlay(
  input: TimelineProjectionWithLiveOverlayInput
): AgentTimelineResult {
  const activeEvents = projectionDeltasToTransientEvents({
    sessionId: input.sessionId,
    committedEvents: input.committedEvents,
    activeDeltas: input.activeDeltas ?? [],
    generatedAt: input.generatedAt,
  });
  const projection = buildNarrativeTimelineProjection({
    sessionId: input.sessionId,
    events: [...input.committedEvents, ...activeEvents],
    generatedAt: input.generatedAt,
  });
  return annotateLiveOverlayBlocks(projection, activeEvents);
}

function projectionDeltasToTransientEvents(input: {
  sessionId: string;
  committedEvents: AgentEvent[];
  activeDeltas: ProjectionDelta[];
  generatedAt?: string;
}): AgentEvent[] {
  const committedActivityIds = new Set(
    input.committedEvents
      .map(eventActivityId)
      .filter((id): id is string => Boolean(id))
  );
  return input.activeDeltas
    .filter((delta) => delta.sessionId === input.sessionId)
    .filter((delta) => delta.type !== 'committed')
    .filter((delta) => !isBranchProjectionDelta(delta))
    .filter((delta) => !activeDeltaAlreadyCommitted(delta, committedActivityIds))
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
    .flatMap((delta) => projectionDeltaToTransientEvent(delta, input.generatedAt));
}

function projectionDeltaToTransientEvent(delta: ProjectionDelta, generatedAt?: string): AgentEvent[] {
  const id = liveOverlayEventId(delta);
  const ts = generatedAt ?? new Date().toISOString();
  const basePayload = {
    runId: delta.runId,
    turnId: delta.turnId,
    stage: delta.stage,
    status: projectionStatus(delta.status),
    summary: delta.summary,
    source: delta.source,
    activeOverlay: true,
  };

  const textKind = projectionDeltaTextChannel(delta);
  if (textKind && typeof delta.delta === 'string' && delta.delta.length > 0) {
    if (textKind === 'reasoning') {
      return [{
        id,
        sessionId: delta.sessionId,
        ts,
        kind: 'assistant_msg',
        payload: {
          ...basePayload,
          channel: 'reasoning',
          content: delta.delta,
          status: projectionStatus(delta.status) ?? 'running',
          source: 'provider',
          presentation: 'collapsible',
          visibility: 'conversation',
          reasoningTrace: true,
          activeOverlay: true,
          activity: delta.activity,
        },
        display: {
          presentation: 'collapsible',
          defaultOpen: true,
        },
      }];
    }
    return [{
      id,
      sessionId: delta.sessionId,
      ts,
      kind: 'assistant_msg',
      payload: {
        ...basePayload,
        channel: textKind,
        content: delta.delta,
        status: projectionStatus(delta.status) ?? 'running',
        presentation: 'body',
        visibility: 'conversation',
      },
      display: {
        presentation: 'body',
        defaultOpen: true,
      },
    }];
  }

  if (delta.type === 'error') {
    return [{
      id,
      sessionId: delta.sessionId,
      ts,
      kind: 'error',
      payload: {
        ...basePayload,
        content: delta.delta ?? delta.summary ?? 'Live projection error',
        message: delta.delta ?? delta.summary ?? 'Live projection error',
      },
    }];
  }

  const activity = delta.activity;
  if (activity) {
    const stage = delta.stage ?? activity.kind;
    const eventKind = liveActivityEventKind(delta);
    return [{
      id,
      sessionId: delta.sessionId,
      ts,
      kind: eventKind,
      payload: {
        ...basePayload,
        channel: liveActivityChannel(delta),
        stage,
        status: projectionStatus(delta.status) ?? activity.status,
        summary: delta.summary ?? activity.summary,
        toolName: activity.toolName,
        activity,
        payload: delta.payload,
        presentation: 'collapsible',
        visibility: 'conversation',
      },
      display: {
        presentation: 'collapsible',
        defaultOpen: activity.status === 'running' || activity.status === 'waiting' || activity.status === 'failed',
      },
    }];
  }

  return [];
}

function liveOverlayEventId(delta: ProjectionDelta): string {
  const textKind = projectionDeltaTextChannel(delta);
  if (textKind) {
    return [
      'live',
      delta.sessionId,
      delta.runId ?? 'run',
      delta.turnId ?? 'turn',
      'text',
      delta.type,
      delta.activity?.activityId ?? delta.itemId ?? delta.draftId ?? delta.stage ?? '',
      delta.channel ?? '',
    ].filter(Boolean).join(':');
  }
  return [
    'live',
    delta.sessionId,
    delta.runId ?? 'run',
    delta.turnId ?? 'turn',
    typeof delta.seq === 'number' ? String(delta.seq) : 'seq',
    delta.type,
    delta.itemId ?? delta.draftId ?? delta.activity?.activityId ?? '',
  ].filter(Boolean).join(':');
}

function projectionDeltaTextChannel(delta: ProjectionDelta): 'reasoning' | 'progress' | 'final' | null {
  if (delta.type === 'reasoning_delta') return 'reasoning';
  if (delta.type === 'part_delta' && delta.channel === 'reasoning') return 'reasoning';
  if (delta.type === 'assistant_delta') return delta.channel === 'progress' ? 'progress' : 'final';
  if (delta.type === 'draft_delta') return 'progress';
  if (delta.type === 'part_delta' && (delta.channel === 'draft' || !delta.channel)) return 'progress';
  return null;
}

function liveActivityEventKind(delta: ProjectionDelta): AgentEvent['kind'] {
  if (delta.type === 'resource_delta') return 'tool_result';
  if (delta.type === 'tool_call_delta') return 'tool_call';
  return 'workflow_stage';
}

function liveActivityChannel(delta: ProjectionDelta): AgentEventChannel {
  if (delta.channel === 'tool' || delta.type === 'tool_call_delta') return 'tool';
  if (delta.channel === 'resource' || delta.type === 'resource_delta') return 'tool';
  if (delta.channel === 'workunit' || delta.type === 'workunit_delta') return 'progress';
  if (delta.channel === 'reasoning') return 'reasoning';
  if (delta.channel === 'final') return 'final';
  return 'progress';
}

function projectionStatus(status: ProjectionDelta['status']): string | undefined {
  if (!status) return undefined;
  if (status === 'streaming') return 'running';
  if (status === 'draftReady') return 'completed';
  if (status === 'discarded' || status === 'skipped') return 'blocked';
  return status;
}

function isBranchProjectionDelta(delta: ProjectionDelta): boolean {
  return Boolean(delta.branchId || delta.subAgentId || delta.mergeGroupId);
}

function activeDeltaAlreadyCommitted(
  delta: ProjectionDelta,
  committedActivityIds: Set<string>
): boolean {
  const activityId = delta.activity?.activityId;
  if (activityId && committedActivityIds.has(activityId)) return true;
  return false;
}

function eventActivityId(event: AgentEvent): string | undefined {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const activity = isRecordPayload(payload.activity) ? payload.activity : undefined;
  return activity ? stringField(activity, 'activityId') : undefined;
}

function isProjectionTimelineHiddenEvent(event: AgentEvent): boolean {
  const activity = conversationActivityFromEvent(event);
  const activeOverlay = Boolean(isRecordPayload(event.payload) && event.payload.activeOverlay === true);
  if (activeOverlay && activity?.kind === 'providerThinking') {
    return false;
  }
  if (event.kind === 'workflow_stage' || event.kind === 'workflow_decision') {
    const payload = isRecordPayload(event.payload) ? event.payload : {};
    const stage = stringField(payload, 'stage');
    const kernelEvent = isRecordPayload(payload.kernelEvent) ? payload.kernelEvent : undefined;
    const kernelEventKind = kernelEvent ? stringField(kernelEvent, 'kind') : undefined;
    if (isInternalOrchestrationStage({ stage, kernelEventKind })) return true;
  }
  if (activity && !isMainTimelineActivityShape({ kind: activity.kind, toolName: activity.toolName })) {
    return true;
  }
  return false;
}

function conversationActivityFromEvent(event: AgentEvent): AgentConversationActivity | undefined {
  const payload = isRecordPayload(event.payload) ? event.payload : undefined;
  return payload ? activityFromValue(payload.activity) : undefined;
}

function userInputBubbleEvent(event: AgentEvent, index: number): AgentEvent | null {
  const content = userInputBubbleContent(event);
  if (!content) return null;
  return {
    id: `user-input-${event.id || index}`,
    sessionId: event.sessionId,
    ts: event.ts,
    kind: 'user_msg',
    payload: {
      content,
      source: 'user',
      sourceEventId: event.id,
      sourceEventKind: event.kind,
      presentation: 'body',
      visibility: 'conversation',
    },
    display: {
      presentation: 'body',
      defaultOpen: true,
    },
  };
}

function userInputBubbleContent(event: AgentEvent): string | undefined {
  if (!isRecordPayload(event.payload)) return undefined;
  if (event.kind === 'user_guidance') {
    return firstPayloadText(event.payload, ['content', 'guidance', 'text', 'message']);
  }
  if (event.kind === 'requirement_decision') {
    return firstPayloadText(event.payload, ['guidance', 'summary', 'message']) ??
      selectedOptionLabel(event.payload);
  }
  if (event.kind === 'plan_review') {
    const status = stringField(event.payload, 'status');
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return undefined;
    return firstPayloadText(event.payload, ['guidance', 'summary', 'message']);
  }
  return undefined;
}

function selectedOptionLabel(payload: Record<string, unknown>): string | undefined {
  const selectedOption = isRecordPayload(payload.selectedOption) ? payload.selectedOption : undefined;
  return selectedOption ? stringField(selectedOption, 'label') : undefined;
}

function firstPayloadText(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringField(payload, key);
    if (value) return value;
  }
  return undefined;
}

function isUserInputAuditOnlyEvent(event: AgentEvent): boolean {
  return event.kind === 'user_guidance' ||
    event.kind === 'requirement_decision' ||
    (event.kind === 'plan_review' && Boolean(userInputBubbleContent(event)));
}

function annotateLiveOverlayBlocks(
  projection: AgentTimelineResult,
  activeEvents: AgentEvent[]
): AgentTimelineResult {
  if (activeEvents.length === 0) return projection;
  const liveEventIds = new Set(activeEvents.map((event) => event.id));
  const liveEventIndex = new Map(activeEvents.map((event, index) => [event.id, index]));
  const lastLiveTextIndex = [...activeEvents].reverse().findIndex(isLiveTextEvent);
  const lastTextEvent = lastLiveTextIndex >= 0 ? activeEvents[activeEvents.length - 1 - lastLiveTextIndex] : null;
  const hasLiveAfterLastText = Boolean(lastTextEvent) &&
    activeEvents.some((event) => (liveEventIndex.get(event.id) ?? -1) > (liveEventIndex.get(lastTextEvent!.id) ?? -1));

  return {
    ...projection,
    turns: projection.turns.map((turn) => ({
      ...turn,
      status: turnContainsLiveEvent(turn, liveEventIds) && turn.status === 'completed' ? 'running' : turn.status,
      blocks: turn.blocks.map((block) => {
        const liveIds = block.events.map((event) => event.id).filter((id) => liveEventIds.has(id));
        if (liveIds.length === 0) return block;
        const containsLastText = Boolean(lastTextEvent && liveIds.includes(lastTextEvent.id));
        const textBlock = isTimelineTextBlock(block);
        const shouldStream = textBlock && containsLastText && !hasLiveAfterLastText;
        const shouldSeal = textBlock && !shouldStream && block.events.some(isLiveTextEvent);
        const renderMode: NarrativeRenderMode | undefined = shouldStream
          ? 'typewriter'
          : shouldSeal
            ? 'instant'
            : block.displayHints?.renderMode;
        return {
          ...block,
          status: shouldStream ? 'running' : block.status,
          defaultCollapsed: block.narrativeKind === 'thinking' && shouldSeal,
          displayHints: {
            ...(block.displayHints ?? {}),
            renderMode,
            initialOpen: shouldStream || block.displayHints?.initialOpen,
            replaceOnComplete: block.narrativeKind === 'thinking' ? true : block.displayHints?.replaceOnComplete,
          },
        };
      }),
    })),
  };
}

function isLiveTextEvent(event: AgentEvent): boolean {
  if (!event.id.startsWith('live:')) return false;
  if (event.kind !== 'assistant_msg') return false;
  const channel = stringValueFromPayload(event.payload, 'channel');
  return channel === 'reasoning' || channel === 'progress' || channel === 'final';
}

function isTimelineTextBlock(block: AgentTimelineBlock): boolean {
  return block.narrativeKind === 'thinking' ||
    block.narrativeKind === 'assistantNarration' ||
    block.narrativeKind === 'assistantText';
}

function turnContainsLiveEvent(turn: AgentTimelineResult['turns'][number], liveEventIds: Set<string>): boolean {
  return turn.blocks.some((block) => block.events.some((event) => liveEventIds.has(event.id)));
}

function implementationPlanTaskProjectionItems(
  events: AgentEvent[],
  event: AgentEvent,
  eventIndex: number
): NonNullable<AgentTimelineResult['taskProjection']>['items'] {
  if (event.kind !== 'plan_card' || !isRecordPayload(event.payload)) return [];
  const implementationPlan = event.payload.implementationPlan;
  if (!isRecordPayload(implementationPlan)) return [];
  const tasks = Array.isArray(implementationPlan.tasks) ? implementationPlan.tasks : [];
  const lifecycle = implementationPlanLifecycle(events, event, eventIndex);
  return tasks.flatMap((item, index) => {
    if (!isRecordPayload(item)) return [];
    const taskId = stringField(item, 'taskId') ?? stringField(item, 'id') ?? `task-${index + 1}`;
    const title = stringField(item, 'title') ?? taskId;
    const acceptance = stringArrayField(item, 'acceptanceCriteria');
    const failure = stringArrayField(item, 'failureCriteria');
    const scope = stringField(item, 'scope');
    const targets = stringArrayOrSingleField(item, 'target');
    const summary = [
      scope,
      acceptance.length ? `Acceptance: ${acceptance.join('; ')}` : '',
      failure.length ? `Stop/Replan: ${failure.join('; ')}` : '',
    ].filter(Boolean).join(' · ');
    return [{
      id: `implementation-plan-${event.id || eventIndex}-${taskId}`,
      title,
      summary: summary || stringField(implementationPlan, 'summary') || '',
      status: implementationTaskStatus(lifecycle, targets, taskId),
      blockId: `plan-${event.id || eventIndex}`,
      narrativeKind: 'plan' as const,
    }];
  });
}

interface ImplementationPlanLifecycle {
  accepted: boolean;
  needsRevision: boolean;
  rejected: boolean;
  completedPaths: string[];
  runningPaths: string[];
  failedPaths: string[];
  completedIds: string[];
  runningIds: string[];
  failedIds: string[];
}

function implementationPlanLifecycle(
  events: AgentEvent[],
  planEvent: AgentEvent,
  planEventIndex: number
): ImplementationPlanLifecycle {
  const planPayload = isRecordPayload(planEvent.payload) ? planEvent.payload : {};
  const planRunId = stringField(planPayload, 'runId');
  const planId = stringField(planPayload, 'planId');
  const lifecycle: ImplementationPlanLifecycle = {
    accepted: false,
    needsRevision: false,
    rejected: false,
    completedPaths: [],
    runningPaths: [],
    failedPaths: [],
    completedIds: [],
    runningIds: [],
    failedIds: [],
  };

  for (const later of events.slice(planEventIndex + 1)) {
    const payload = isRecordPayload(later.payload) ? later.payload : {};
    if (later.kind === 'plan_review' && samePlanDecision(payload, planRunId, planId)) {
      const status = stringField(payload, 'status');
      if (status === 'accepted') lifecycle.accepted = true;
      if (status === 'needsRevision') lifecycle.needsRevision = true;
      if (status === 'rejected' || status === 'failed' || status === 'cancelled') lifecycle.rejected = true;
    }
    if (!lifecycle.accepted) continue;

    const fact = implementationFactFromEvent(later);
    if (!fact) continue;
    if (fact.status === 'completed') {
      lifecycle.completedPaths.push(...fact.paths);
      lifecycle.completedIds.push(...fact.ids);
    } else if (fact.status === 'running' || fact.status === 'queued') {
      lifecycle.runningPaths.push(...fact.paths);
      lifecycle.runningIds.push(...fact.ids);
    } else if (fact.status === 'failed' || fact.status === 'blocked') {
      lifecycle.failedPaths.push(...fact.paths);
      lifecycle.failedIds.push(...fact.ids);
    }
  }

  lifecycle.completedPaths = [...new Set(lifecycle.completedPaths.map(normalizeTaskPath).filter(Boolean))];
  lifecycle.runningPaths = [...new Set(lifecycle.runningPaths.map(normalizeTaskPath).filter(Boolean))];
  lifecycle.failedPaths = [...new Set(lifecycle.failedPaths.map(normalizeTaskPath).filter(Boolean))];
  lifecycle.completedIds = [...new Set(lifecycle.completedIds.map(normalizeTaskId).filter(Boolean))];
  lifecycle.runningIds = [...new Set(lifecycle.runningIds.map(normalizeTaskId).filter(Boolean))];
  lifecycle.failedIds = [...new Set(lifecycle.failedIds.map(normalizeTaskId).filter(Boolean))];
  return lifecycle;
}

function implementationTaskStatus(
  lifecycle: ImplementationPlanLifecycle,
  targets: string[],
  taskId: string
): AgentTimelineStatus {
  if (lifecycle.rejected) return 'failed';
  if (lifecycle.needsRevision) return 'waiting';
  if (!lifecycle.accepted) return 'waiting';

  const normalizedTargets = targets.map(normalizeTaskPath).filter(Boolean);
  const normalizedTaskId = normalizeTaskId(taskId);
  if (normalizedTargets.length > 0) {
    if (normalizedTargets.some((target) => lifecycle.failedPaths.some((path) => pathMatchesTaskTarget(path, target)))) return 'failed';
    if (normalizedTargets.some((target) => lifecycle.runningPaths.some((path) => pathMatchesTaskTarget(path, target)))) return 'running';
    if (normalizedTargets.some((target) => lifecycle.completedPaths.some((path) => pathMatchesTaskTarget(path, target)))) return 'completed';
  }
  if (normalizedTaskId) {
    if (lifecycle.failedIds.some((id) => idMatchesTaskId(id, normalizedTaskId))) return 'failed';
    if (lifecycle.runningIds.some((id) => idMatchesTaskId(id, normalizedTaskId))) return 'running';
    if (lifecycle.completedIds.some((id) => idMatchesTaskId(id, normalizedTaskId))) return 'completed';
  }
  return 'queued';
}

function samePlanDecision(payload: Record<string, unknown>, planRunId?: string, planId?: string): boolean {
  const decisionRunId = stringField(payload, 'runId');
  const decisionPlanId = stringField(payload, 'planId');
  return (!planRunId || !decisionRunId || decisionRunId === planRunId) &&
    (!planId || !decisionPlanId || decisionPlanId === planId);
}

interface ImplementationFact {
  status: AgentTimelineStatus;
  paths: string[];
  ids: string[];
}

function implementationFactFromEvent(event: AgentEvent): ImplementationFact | null {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const kernelEvent = isRecordPayload(payload.kernelEvent) ? payload.kernelEvent : undefined;
  const kind = stringField(kernelEvent ?? {}, 'kind') ?? stringField(payload, 'stage');
  const status = implementationFactStatus(kind, stringField(payload, 'status'));
  if (!status) return null;
  return {
    status,
    paths: eventPathCandidates(payload),
    ids: eventIdCandidates(payload),
  };
}

function implementationFactStatus(kind: string | undefined, status: string | undefined): AgentTimelineStatus | null {
  if (kind === 'work_unit.queued') return 'queued';
  if (kind === 'work_unit.started') return 'running';
  if (kind === 'work_unit.completed' || kind === 'tool.completed') return 'completed';
  if (kind === 'work_unit.failed' || kind === 'tool.failed') return 'failed';
  if (kind === 'work_unit.blocked') return 'blocked';
  if (kind === 'work_unit') {
    if (status === 'queued') return 'queued';
    if (status === 'running' || status === 'started') return 'running';
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'blocked') return 'blocked';
  }
  return null;
}

function eventPathCandidates(payload: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const collect = (value: unknown): void => {
    if (!isRecordPayload(value)) return;
    for (const key of ['path', 'absolutePath', 'resourceScope', 'target']) {
      const field = value[key];
      if (typeof field === 'string' && field.trim()) candidates.push(field);
      if (Array.isArray(field)) {
        for (const item of field) {
          if (typeof item === 'string' && item.trim()) candidates.push(item);
        }
      }
    }
  };
  collect(payload);
  const kernelEvent = isRecordPayload(payload.kernelEvent) ? payload.kernelEvent : undefined;
  collect(kernelEvent);
  if (kernelEvent) collect(kernelEvent.output);
  if (kernelEvent) collect(kernelEvent.workUnit);
  const output = isRecordPayload(payload.output) ? payload.output : undefined;
  collect(output);
  const workUnit = isRecordPayload(payload.workUnit) ? payload.workUnit : undefined;
  collect(workUnit);
  return candidates;
}

function eventIdCandidates(payload: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const collect = (value: unknown): void => {
    if (!isRecordPayload(value)) return;
    for (const key of ['id', 'actionId', 'workUnitId', 'toolCallId']) {
      const field = value[key];
      if (typeof field === 'string' && field.trim()) candidates.push(field);
    }
  };
  collect(payload);
  const kernelEvent = isRecordPayload(payload.kernelEvent) ? payload.kernelEvent : undefined;
  collect(kernelEvent);
  if (kernelEvent) collect(kernelEvent.workUnit);
  const workUnit = isRecordPayload(payload.workUnit) ? payload.workUnit : undefined;
  collect(workUnit);
  return candidates;
}

function stringArrayOrSingleField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return [];
}

function normalizeTaskPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim();
}

function pathMatchesTaskTarget(path: string, target: string): boolean {
  if (!path || !target) return false;
  return path === target || path.endsWith(`/${target}`) || target.endsWith(`/${path}`);
}

function normalizeTaskId(id: string): string {
  return id.trim().toLowerCase();
}

function idMatchesTaskId(id: string, taskId: string): boolean {
  if (!id || !taskId) return false;
  return id === taskId || id.endsWith(`:${taskId}`) || id.endsWith(`/${taskId}`) || id.includes(taskId);
}

export function buildTokenUsageProjection(events: AgentEvent[]): AgentTimelineTokenUsageProjection {
  const requests: MutableTokenUsageRequest[] = [];
  let currentRequest: MutableTokenUsageRequest | null = null;

  events.forEach((event, index) => {
    if (event.kind === 'user_msg') {
      finalizeTokenUsageRequest(currentRequest, requests);
      currentRequest = createTokenUsageRequest(event, index, requests.length + 1);
      return;
    }

    if (event.kind !== 'cache_telemetry' || !isRecordPayload(event.payload)) return;
    if (!currentRequest) {
      currentRequest = createSyntheticTokenUsageRequest(event, index, requests.length + 1);
    }
    addTokenUsageTelemetry(currentRequest, event);
  });

  finalizeTokenUsageRequest(currentRequest, requests);

  const projectedRequests = requests.map(projectTokenUsageRequest);
  const totals = projectTokenUsageTotals(projectedRequests);
  return {
    totals,
    requests: projectedRequests,
  };
}

interface MutableTokenUsageRequest {
  requestId: string;
  turnId: string;
  userEventId: string;
  title: string;
  startedAt?: string;
  completedAt?: string;
  providers: Set<string>;
  stages: Set<string>;
  providerCallCount: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cachedTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function createTokenUsageRequest(event: AgentEvent, eventIndex: number, requestIndex: number): MutableTokenUsageRequest {
  const eventId = event.id || `event-${eventIndex}`;
  return {
    requestId: eventId,
    turnId: `turn-${eventId}`,
    userEventId: eventId,
    title: tokenUsageRequestTitle(event.payload, requestIndex),
    startedAt: event.ts,
    providers: new Set(),
    stages: new Set(),
    providerCallCount: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cachedTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function createSyntheticTokenUsageRequest(
  event: AgentEvent,
  eventIndex: number,
  requestIndex: number
): MutableTokenUsageRequest {
  const request = createTokenUsageRequest(event, eventIndex, requestIndex);
  request.requestId = `request-${requestIndex}`;
  request.turnId = `turn-orphan-${requestIndex}`;
  request.userEventId = '';
  request.title = `Request ${requestIndex}`;
  return request;
}

function addTokenUsageTelemetry(request: MutableTokenUsageRequest, event: AgentEvent): void {
  const payload = event.payload as Record<string, unknown>;
  request.providerCallCount += 1;
  const provider = stringField(payload, 'provider');
  const stage = stringField(payload, 'stage');
  if (provider) request.providers.add(provider);
  if (stage) request.stages.add(stage);
  request.promptCacheHitTokens += numberField(payload, 'promptCacheHitTokens') ?? 0;
  request.promptCacheMissTokens += numberField(payload, 'promptCacheMissTokens') ?? 0;
  request.cachedTokens += numberField(payload, 'cachedTokens') ?? 0;
  request.promptTokens += numberField(payload, 'promptTokens') ?? 0;
  request.completionTokens += numberField(payload, 'completionTokens') ?? 0;
  request.totalTokens += numberField(payload, 'totalTokens') ?? 0;
  request.completedAt = event.ts ?? request.completedAt;
}

function finalizeTokenUsageRequest(
  request: MutableTokenUsageRequest | null,
  requests: MutableTokenUsageRequest[]
): void {
  if (!request) return;
  const hasUsage =
    request.providerCallCount > 0 ||
    request.promptCacheHitTokens > 0 ||
    request.promptCacheMissTokens > 0 ||
    request.cachedTokens > 0 ||
    request.promptTokens > 0 ||
    request.completionTokens > 0 ||
    request.totalTokens > 0;
  if (hasUsage) requests.push(request);
}

function projectTokenUsageRequest(request: MutableTokenUsageRequest): AgentTimelineTokenUsageRequest {
  const promptTokens = request.promptTokens > 0
    ? request.promptTokens
    : request.promptCacheHitTokens + request.promptCacheMissTokens;
  const totalTokens = request.totalTokens > 0
    ? request.totalTokens
    : promptTokens + request.completionTokens;
  return {
    requestId: request.requestId,
    turnId: request.turnId,
    userEventId: request.userEventId,
    title: request.title,
    startedAt: request.startedAt,
    completedAt: request.completedAt,
    stages: Array.from(request.stages),
    promptCacheHitTokens: request.promptCacheHitTokens,
    promptCacheMissTokens: request.promptCacheMissTokens,
    cachedTokens: request.cachedTokens,
    promptTokens,
    completionTokens: request.completionTokens,
    totalTokens,
    cacheHitRate: tokenUsageCacheHitRate(request.promptCacheHitTokens, request.promptCacheMissTokens),
    providerCallCount: request.providerCallCount,
    providers: Array.from(request.providers),
  };
}

function projectTokenUsageTotals(requests: AgentTimelineTokenUsageRequest[]): AgentTimelineTokenUsageTotals {
  const promptCacheHitTokens = sumTokenUsageRequests(requests, 'promptCacheHitTokens');
  const promptCacheMissTokens = sumTokenUsageRequests(requests, 'promptCacheMissTokens');
  const cachedTokens = sumTokenUsageRequests(requests, 'cachedTokens');
  const promptTokens = sumTokenUsageRequests(requests, 'promptTokens');
  const completionTokens = sumTokenUsageRequests(requests, 'completionTokens');
  const totalTokens = sumTokenUsageRequests(requests, 'totalTokens');
  return {
    promptCacheHitTokens,
    promptCacheMissTokens,
    cachedTokens,
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitRate: tokenUsageCacheHitRate(promptCacheHitTokens, promptCacheMissTokens),
    providerCallCount: requests.reduce((total, request) => total + request.providerCallCount, 0),
    providers: Array.from(new Set(requests.flatMap((request) => request.providers))),
  };
}

type TokenUsageNumberField =
  | 'promptCacheHitTokens'
  | 'promptCacheMissTokens'
  | 'cachedTokens'
  | 'promptTokens'
  | 'completionTokens'
  | 'totalTokens';

function sumTokenUsageRequests(
  requests: AgentTimelineTokenUsageRequest[],
  field: TokenUsageNumberField
): number {
  return requests.reduce((total, request) => total + request[field], 0);
}

function tokenUsageCacheHitRate(hitTokens: number, missTokens: number): number | null {
  const denominator = hitTokens + missTokens;
  return denominator > 0 ? hitTokens / denominator : null;
}

function tokenUsageRequestTitle(payload: unknown, index: number): string {
  const text = isRecordPayload(payload)
    ? stringField(payload, 'content') ?? stringField(payload, 'message') ?? stringField(payload, 'summary')
    : typeof payload === 'string'
      ? payload
      : undefined;
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return `Request ${index}`;
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized;
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
  const activity = narrativeActivity(events);
  const status = activity?.status ?? narrativeStatus(events);
  const title = activity?.title ?? narrativeTitle(events, narrativeKind);
  const summary = activity?.summary ?? summarizeAgentEvents(events);
  const body = narrativeBody(events, narrativeKind);
  return {
    id: existingId ?? `${narrativeKind}-${first.id || index}`,
    kind: legacyKind,
    narrativeKind,
    activity,
    title,
    summary,
    status,
    defaultCollapsed: narrativeDefaultCollapsed(narrativeKind, status),
    bodyMarkdown: body,
    displayHints: narrativeDisplayHints(narrativeKind, status, title, summary, body),
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
  if (event.kind === 'user_guidance') return 'requirement';
  if (event.kind === 'requirement_confirmation' || event.kind === 'requirement_decision') return 'requirement';
  if (event.kind === 'plan_card' || event.kind === 'plan_review') return 'plan';
  if (event.kind === 'permission_request' || event.kind === 'permission_result') return 'permission';
  if (event.kind === 'review_summary') return 'review';
  if (event.kind === 'error') return 'diagnostic';
  if (event.kind === 'assistant_msg') {
    const channel = stringValueFromPayload(event.payload, 'channel');
    if (channel === 'reasoning') return 'thinking';
    if (channel === 'progress' && ['llm', 'session', 'provider'].includes(stringValueFromPayload(event.payload, 'source') ?? '')) {
      return 'assistantNarration';
    }
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
    case 'assistantNarration':
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
  if (events.some((event) => event.kind === 'user_guidance')) {
    return events.some((event) => stringValueFromPayload(event.payload, 'status') === 'consumed')
      ? 'completed'
      : 'queued';
  }
  if (events.some((event) => event.kind === 'permission_request') && !events.some((event) => event.kind === 'permission_result')) {
    return 'waiting';
  }
  if (events.some((event) => event.kind === 'session_run_state' && stringValueFromPayload(event.payload, 'status') === 'waiting')) {
    return 'waiting';
  }
  if (
    events.some((event) =>
      event.kind === 'requirement_confirmation' &&
      stringValueFromPayload(event.payload, 'status') === 'waitingUserConfirmation'
    ) &&
    !events.some((event) => event.kind === 'requirement_decision')
  ) {
    return 'waiting';
  }
  if (events.some((event) => event.kind === 'plan_card' && planCardEventAwaitingDecision(event))) {
    return 'waiting';
  }
  if (events.some((event) => event.kind === 'plan_review' && planReviewEventAwaitingDecision(event))) {
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
  if (first.kind === 'user_guidance') return 'User guidance';
  if (kind === 'assistantText') return 'DeepCode';
  if (kind === 'assistantNarration') return 'DeepCode';
  if (kind === 'thinking') return 'Thinking';
  if (kind === 'operationEvidence') return firstNonEmpty(events, ['summary', 'toolName', 'name', 'stage']) ?? 'Operation evidence';
  if (kind === 'requirement') return firstNonEmpty(events, ['title', 'summary']) ?? 'Requirement';
  if (kind === 'plan') return firstNonEmpty(events, ['title', 'summary']) ?? 'Plan';
  if (kind === 'permission') return firstNonEmpty(events, ['summary', 'toolName']) ?? 'Permission';
  if (kind === 'verification') return firstNonEmpty(events, ['summary']) ?? 'Verification';
  if (kind === 'review') return firstNonEmpty(events, ['title']) ?? 'Review';
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
  if (kind === 'thinking') {
    const reasoning = events.map(reasoningEventBody).join('').trim();
    return reasoning || undefined;
  }
  if (kind === 'review') {
    const text = trimReviewFooter(events.map(reviewEventBody).filter(Boolean).join('\n\n')).trim();
    return text || undefined;
  }
  const text = firstNonEmpty(events, ['content', 'message', 'summary', 'details']);
  return text?.trim() ? text : undefined;
}

function reasoningEventBody(event: AgentEvent): string {
  if (typeof event.payload === 'string') return event.payload;
  if (!isRecordPayload(event.payload)) return '';
  for (const key of ['content', 'message', 'details']) {
    const value = event.payload[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function reviewEventBody(event: AgentEvent): string {
  if (typeof event.payload === 'string') return event.payload;
  if (!isRecordPayload(event.payload)) return '';
  for (const key of ['content', 'message', 'details']) {
    const value = event.payload[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function trimReviewFooter(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const footerStart = lines.findIndex((line) =>
    /^#{2,6}\s*(后续意图|后续决策|决策边界)\s*$/.test(line.trim())
  );
  const visibleLines = footerStart >= 0 ? lines.slice(0, footerStart) : lines;
  return visibleLines.join('\n').trim();
}

function narrativeDefaultCollapsed(kind: AgentTimelineNarrativeKind, status: AgentTimelineStatus): boolean {
  if (status === 'running' || status === 'waiting') return false;
  if (kind === 'assistantNarration') return false;
  return kind === 'thinking' || kind === 'operationEvidence' || kind === 'permission';
}

function narrativeDisplayHints(
  kind: AgentTimelineNarrativeKind,
  status: AgentTimelineStatus,
  title: string,
  summary: string,
  body?: string
): AgentTimelineBlock['displayHints'] {
  const textLength = (body ?? summary ?? '').length;
  const renderMode = narrativeRenderMode(kind, status);
  return {
    density: kind === 'operationEvidence' ? 'compact' : 'normal',
    evidenceMode: kind === 'operationEvidence' ? 'collapsed' : 'inline',
    renderMode,
    initialOpen: status === 'running' || status === 'waiting' || kind === 'assistantNarration',
    collapseAfterComplete: kind === 'thinking' || kind === 'operationEvidence',
    typewriterSpeed: narrativeTypewriterSpeed(kind, renderMode, textLength),
    replaceOnComplete: kind === 'thinking',
    checkpointKind: narrativeCheckpointKind(kind),
    showInTaskList: shouldShowNarrativeInTaskList(kind),
    taskListLabel: title,
    taskListSummary: summary,
  };
}

function narrativeTypewriterSpeed(
  kind: AgentTimelineNarrativeKind,
  renderMode: NarrativeRenderMode,
  textLength: number
): NonNullable<NonNullable<AgentTimelineBlock['displayHints']>['typewriterSpeed']> | undefined {
  if (renderMode === 'accelerated') return 'fast';
  if (renderMode !== 'typewriter') return undefined;
  if (kind === 'thinking') return 'slow';
  if (kind === 'assistantText' && textLength > 1600) return 'fast';
  return 'normal';
}

function narrativeCheckpointKind(
  kind: AgentTimelineNarrativeKind
): NonNullable<NonNullable<AgentTimelineBlock['displayHints']>['checkpointKind']> | undefined {
  if (kind === 'user') return 'turnStart';
  if (kind === 'assistantNarration' || kind === 'thinking') return 'llmProposal';
  if (kind === 'assistantText') return 'final';
  if (kind === 'operationEvidence') return 'resourcePacket';
  if (kind === 'requirement') return 'userGuidance';
  if (kind === 'permission') return 'permission';
  if (kind === 'review') return 'review';
  if (kind === 'diagnostic') return 'diagnostic';
  return undefined;
}

function narrativeRenderMode(
  kind: AgentTimelineNarrativeKind,
  status: AgentTimelineStatus
): NarrativeRenderMode {
  if (kind === 'assistantNarration') return 'typewriter';
  if (kind === 'assistantText') return 'typewriter';
  if (kind === 'thinking') return status === 'running' || status === 'waiting' ? 'typewriter' : 'static';
  if (
    kind === 'plan' ||
    kind === 'review' ||
    kind === 'requirement' ||
    kind === 'permission' ||
    kind === 'diagnostic'
  ) return 'typewriter';
  return 'static';
}

function shouldShowNarrativeInTaskList(kind: AgentTimelineNarrativeKind): boolean {
  if (kind === 'assistantNarration') return false;
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

function narrativeActivity(events: AgentEvent[]): AgentConversationActivity | undefined {
  for (const event of [...events].reverse()) {
    const payload = isRecordPayload(event.payload) ? event.payload : undefined;
    const activity = payload ? activityFromValue(payload.activity) : undefined;
    if (activity) return activity;
  }
  return undefined;
}

function activityFromValue(value: unknown): AgentConversationActivity | undefined {
  if (!isRecordPayload(value)) return undefined;
  const kind = stringField(value, 'kind');
  const status = activityStatus(stringField(value, 'status'));
  const title = stringField(value, 'title');
  const summary = stringField(value, 'summary');
  const source = activitySource(stringField(value, 'source'));
  const activityId = stringField(value, 'activityId');
  if (!kind || !status || !title || !summary || !source || !activityId) return undefined;
  return {
    activityId,
    kind: kind as AgentConversationActivity['kind'],
    status,
    title,
    summary,
    source,
    runId: stringField(value, 'runId'),
    planId: stringField(value, 'planId'),
    branchId: stringField(value, 'branchId'),
    subAgentId: stringField(value, 'subAgentId'),
    mergeGroupId: stringField(value, 'mergeGroupId'),
    draftId: stringField(value, 'draftId'),
    targets: stringArrayField(value, 'targets'),
    actionIds: stringArrayField(value, 'actionIds'),
    workUnitIds: stringArrayField(value, 'workUnitIds'),
    toolName: stringField(value, 'toolName'),
    itemCount: numberField(value, 'itemCount'),
    errorCode: stringField(value, 'errorCode'),
    errorMessage: stringField(value, 'errorMessage'),
  };
}

function activityStatus(value: string | undefined): AgentTimelineStatus | undefined {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'waiting' ||
    value === 'blocked' ||
    value === 'completed' ||
    value === 'failed'
  ) return value;
  return undefined;
}

function activitySource(value: string | undefined): AgentConversationActivity['source'] | undefined {
  if (value === 'session' || value === 'kernel' || value === 'provider' || value === 'llm') return value;
  return undefined;
}

function stringValueFromPayload(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === 'boolean') return String(value);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isDebugTimelineEvent(event: AgentEvent): boolean {
  if (event.kind.startsWith('trace/')) return true;
  return stringValueFromPayload(event.payload, 'visibility') === 'debug';
}

// reasoning channel 的 assistant_msg 若正文为空或仅含空代码围栏，则视为空块，不进入时间线。
function isBlankReasoningEvent(event: AgentEvent): boolean {
  if (stringValueFromPayload(event.payload, 'channel') !== 'reasoning') return false;
  const body = reasoningEventBody(event);
  return body.replace(/```+/g, '').trim().length === 0;
}

// P4(B)：定位"plan accepted"边界——第一次 plan_review(status=accepted) 出现的事件索引。
// 在此索引之前的 operationEvidence / thinking 视为 explore 阶段，之后为 execute 阶段。
function findFirstAcceptedReviewIndex(events: AgentEvent[]): number {
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.kind !== 'plan_review') continue;
    if (stringValueFromPayload(event.payload, 'status') === 'accepted') return i;
  }
  return -1;
}

// P4(B)：按事件索引把 phase 写入 block.displayHints。
// 只对 thinking / operationEvidence / assistantNarration 等"过程性"块标注，
// 用户消息、plan/review/permission/requirement 等不标注（语义不需要分阶段）。
function annotateBlocksWithPhase(
  turns: AgentTimelineResult['turns'],
  events: AgentEvent[],
  acceptedIndex: number
): void {
  // 反查事件 id → 索引
  const idToIndex = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.id) idToIndex.set(event.id, index);
  });
  const phaseTargets = new Set<AgentTimelineNarrativeKind>([
    'thinking',
    'operationEvidence',
    'assistantNarration',
    'assistantText',
  ]);
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (!block.narrativeKind || !phaseTargets.has(block.narrativeKind)) continue;
      const firstEventId = block.events[0]?.id;
      if (!firstEventId) continue;
      const idx = idToIndex.get(firstEventId);
      if (idx === undefined) continue;
      const phase: 'explore' | 'execute' = idx < acceptedIndex ? 'explore' : 'execute';
      block.displayHints = { ...(block.displayHints ?? {}), phase };
    }
  }
}


function planCardEventAwaitingDecision(event: AgentEvent): boolean {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  if (payload.confirmable === false) return false;
  const status = stringField(payload, 'status');
  if (!status) return true;
  return planReviewStatusAwaitingUser(status);
}

function planReviewEventAwaitingDecision(event: AgentEvent): boolean {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  if (payload.confirmable === false) return false;
  return planReviewStatusAwaitingUser(stringField(payload, 'status'));
}

function planReviewStatusAwaitingUser(status?: string): boolean {
  return status === undefined ||
    status === 'awaitingUserApproval' ||
    status === 'awaitingTemporaryGrant' ||
    status === 'pending';
}

function isRecordPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim().length > 0 ? field : undefined;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (!Array.isArray(field)) return [];
  return field.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
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
  const resolved = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const resultId = permissionResultId(event);
    if (resultId) {
      resolved.add(resultId);
      continue;
    }
    if (event.kind === 'permission_request') {
      const request = event.payload as PermissionRequest;
      if (!resolved.has(request.id)) return { request };
      continue;
    }
    const request = permissionRequestFromKernelWorkflowStage(event);
    if (request && !resolved.has(request.id)) {
      return { request };
    }
  }
  return null;
}

function permissionResultId(event: AgentEvent): string | undefined {
  if (event.kind === 'permission_result') {
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : undefined;
    return typeof payload?.permissionId === 'string'
      ? payload.permissionId
      : typeof payload?.id === 'string'
        ? payload.id
        : undefined;
  }
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : undefined;
  const kernelEvent = payload?.kernelEvent && typeof payload.kernelEvent === 'object' && !Array.isArray(payload.kernelEvent)
    ? payload.kernelEvent as Record<string, unknown>
    : undefined;
  return kernelEvent?.kind === 'permission.resolved' && typeof kernelEvent.permissionId === 'string'
    ? kernelEvent.permissionId
    : undefined;
}

function permissionRequestFromKernelWorkflowStage(event: AgentEvent): PermissionRequest | null {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : undefined;
  const kernelEvent = payload?.kernelEvent && typeof payload.kernelEvent === 'object' && !Array.isArray(payload.kernelEvent)
    ? payload.kernelEvent as Record<string, unknown>
    : undefined;
  if (kernelEvent?.kind !== 'permission.requested') return null;
  const request = kernelEvent.request && typeof kernelEvent.request === 'object' && !Array.isArray(kernelEvent.request)
    ? kernelEvent.request as Record<string, unknown>
    : {};
  const id = typeof request.id === 'string'
    ? request.id
    : typeof kernelEvent.permissionId === 'string'
      ? kernelEvent.permissionId
      : typeof kernelEvent.toolCallId === 'string'
        ? kernelEvent.toolCallId
        : undefined;
  if (!id) return null;
  const capability = typeof request.capability === 'string'
    ? request.capability
    : typeof kernelEvent.capability === 'string'
      ? kernelEvent.capability
      : 'fs.write';
  return {
    id,
    toolName: typeof kernelEvent.toolName === 'string' ? kernelEvent.toolName : capability,
    riskLevel: request.riskLevel === 'low' || request.riskLevel === 'medium' || request.riskLevel === 'high' || request.riskLevel === 'critical'
      ? request.riskLevel
      : 'medium',
    summary: typeof request.summary === 'string'
      ? request.summary
      : typeof kernelEvent.summary === 'string'
        ? kernelEvent.summary
        : `Permission requested for ${capability}.`,
    argumentsPreview: request.argsPreview ?? kernelEvent.argsPreview ?? null,
    ...(typeof kernelEvent.runId === 'string' ? { runId: kernelEvent.runId } : {}),
    ...(typeof kernelEvent.planId === 'string' ? { planId: kernelEvent.planId } : {}),
  } as PermissionRequest;
}
