import {
  decodeKernelEventV1,
  type AgentContextAttachment,
  type AgentEvent,
  type AgentConversationActivity,
  type AgentEventChannel,
  type AgentEventPresentation,
  type AgentEventVisibility,
  type AgentTimelineBlock,
  type AgentTimelineBlockKind,
  type AgentTimelineNarrativeKind,
  type AgentTimelinePermissionRequestView,
  type AgentTimelineResult,
  type AgentTimelineStatus,
  type AgentTimelineTokenUsageProjection,
  type AgentTimelineTokenUsageRequest,
  type AgentTimelineTokenUsageTotals,
  type KernelProposalReviewReport,
  type ProjectionDelta,
  type SessionKernelFactRefV1,
} from '@deepcode/protocol';
import type { ResourcePacket, ResourceRequest } from './context/types.js';
import type { ReviewPacket } from './review/types.js';
import {
  isExplicitlyHiddenTimelineEvent,
  isInternalOrchestrationStage,
  isMainTimelineActivityShape,
} from './timelineFilter.js';
import type { TranscriptMessageEntry } from './transcript.js';
import type { DynamicWorkflowPlan } from './workflow/types.js';
import {
  findActiveInteraction,
  type InteractionLedgerActiveInteraction,
} from './run-state/interactionLedger.js';
import { planInteractionAwaitsDecision } from './run-state/planInteractionState.js';
import {
  parseSessionTurnAuthorityPayload,
  sessionTurnAuthorities,
} from './driver/context/userAuthorityFrame.js';
import {
  kernelFactRefFromEvent,
  parseSessionFactLineage,
  sessionFactLineageDisposition,
} from './driver/authority/sessionFactLineage.js';
import {
  effectiveConversationLanguage,
  resolveConversationLanguagePolicy,
} from './driver/context/conversationLanguagePolicy.js';
import {
  localizedProjectionText,
  type ProjectionLanguageBinding,
} from './driver/projection/conversationPresentationLanguage.js';

export interface PendingPermissionProjection {
  request: AgentTimelinePermissionRequestView;
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

export const NARRATIVE_TIMELINE_SCHEMA_VERSION =
  'deepcode.shared-conversation-projection.v2' as const;

type WorkingAgentTimelineBlock = AgentTimelineBlock & {
  events: AgentEvent[];
  sourceEventRefs: string[];
};

type WorkingAgentTimelineTurn = Omit<AgentTimelineResult['turns'][number], 'blocks'> & {
  blocks: WorkingAgentTimelineBlock[];
};

type WorkingAgentTimelineResult = Omit<AgentTimelineResult, 'turns'> & {
  turns: WorkingAgentTimelineTurn[];
};

interface ProjectionTurnAuthorityRef {
  readonly eventIndex: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
}

interface ProjectionTurnAuthorityIndex {
  readonly byEventId: ReadonlyMap<string, ProjectionTurnAuthorityRef | null>;
  readonly ambiguousTurnIds: ReadonlySet<string>;
}

export interface NarrativeTimelineProjectionInput {
  sessionId: string;
  events: AgentEvent[];
  /**
   * Observability records that may contribute to a read model without
   * becoming canonical Session domain events or advancing its event version.
   */
  auxiliaryEvents?: AgentEvent[];
  generatedAt?: string;
}

export interface TimelineProjectionWithLiveOverlayInput {
  sessionId: string;
  committedEvents: AgentEvent[];
  auxiliaryEvents?: AgentEvent[];
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
  kernelProposalReview?: KernelProposalReviewReport;
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
  return toSharedConversationProjectionV2(buildWorkingNarrativeTimelineProjection(input));
}

function buildWorkingNarrativeTimelineProjection(
  input: NarrativeTimelineProjectionInput
): WorkingAgentTimelineResult {
  const turns: WorkingAgentTimelineTurn[] = [];
  let currentTurn: WorkingAgentTimelineTurn | null = null;
  let currentTurnLanguage: ProjectionLanguageBinding = neutralProjectionLanguageBinding();
  let syntheticTurnIndex = 0;
  const authorityIndex = buildProjectionTurnAuthorityIndex(input.events);
  const exactTargetTurnIds = input.events.map((event, index) =>
    exactProjectionTurnIdForLineageEvent(
      event,
      index,
      authorityIndex
    )
  );
  const referencedExactTurnIds = new Set(
    exactTargetTurnIds.filter((turnId): turnId is string => Boolean(turnId))
  );
  const languageIndex = buildHistoricalProjectionLanguageIndex(input.events);
  const narrativeBlockBindings = new Map<string, ProjectionLanguageBinding>();
  const turnBlocksBySourceTurnId = new Map<string, WorkingAgentTimelineBlock[]>();

  // 不依赖具体 planId，简单按"是否已出现任何 accepted 的 plan_review"判定。
  const acceptedReviewIndex = findFirstAcceptedReviewIndex(input.events);

  input.events.forEach((event, index) => {
    const exactTargetTurnId = exactTargetTurnIds[index];
    if (event.kind === 'cache_telemetry') {
      return;
    }
    if (isExplicitlyHiddenTimelineEvent(event)) {
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
      const userBlockLanguage = languageIndex.snapshotBindingForEvent(event);
      currentTurnLanguage = languageIndex.settledBindingForEvent(event, userBlockLanguage);
      currentTurn = {
        id: userBlockLanguage.sourceTurnId ?? `turn-${userInputEvent.id || index}`,
        sessionId: input.sessionId,
        status: 'running',
        startedAt: userInputEvent.ts,
        blocks: [narrativeBlockFromEvents([userInputEvent], index, undefined, undefined, undefined, userBlockLanguage)],
      };
      if (currentTurnLanguage.sourceTurnId) {
        registerProjectionTurnBlocks(
          turnBlocksBySourceTurnId,
          currentTurnLanguage.sourceTurnId,
          currentTurn.blocks,
          referencedExactTurnIds
        );
      }
      if (isUserInputAuditOnlyEvent(event)) {
        if (event.kind !== 'user_guidance') {
          const exactTargetBlocks = exactTargetTurnId
            ? requiredProjectionTurnBlocks(
                turnBlocksBySourceTurnId,
                exactTargetTurnId,
                event
              )
            : undefined;
          appendInteractionSettlementToExistingBlock(
            turns,
            currentTurn,
            event,
            index,
            userBlockLanguage,
            exactTargetBlocks
          );
        }
        return;
      }
    }

    if (event.kind === 'user_msg') {
      if (currentTurn) turns.push(finalizeNarrativeTurn(currentTurn));
      const userBlockLanguage = languageIndex.snapshotBindingForEvent(event);
      currentTurnLanguage = languageIndex.settledBindingForEvent(event, userBlockLanguage);
      currentTurn = {
        id: userBlockLanguage.sourceTurnId ?? `turn-${event.id || index}`,
        sessionId: input.sessionId,
        status: 'running',
        startedAt: event.ts,
        blocks: [narrativeBlockFromEvents([event], index, undefined, undefined, undefined, userBlockLanguage)],
      };
      if (currentTurnLanguage.sourceTurnId) {
        registerProjectionTurnBlocks(
          turnBlocksBySourceTurnId,
          currentTurnLanguage.sourceTurnId,
          currentTurn.blocks,
          referencedExactTurnIds
        );
      }
      return;
    }

    if (!currentTurn && !exactTargetTurnId) {
      syntheticTurnIndex += 1;
      currentTurnLanguage = languageIndex.settledBindingForEvent(event);
      currentTurn = {
        id: `turn-orphan-${syntheticTurnIndex}`,
        sessionId: input.sessionId,
        status: 'running',
        startedAt: event.ts,
        blocks: [],
      };
    }

    const eventPresentationBinding = languageIndex.snapshotBindingForEvent(
      event,
      currentTurnLanguage
    );
    const eventPayload = isRecordPayload(event.payload) ? event.payload : {};
    const targetBlocks = exactTargetTurnId
      ? requiredProjectionTurnBlocks(
          turnBlocksBySourceTurnId,
          exactTargetTurnId,
          event
        )
      : eventPayload.activeOverlay === true
        && eventPresentationBinding.sourceTurnId
        ? turnBlocksBySourceTurnId.get(eventPresentationBinding.sourceTurnId)
          ?? currentTurn!.blocks
        : currentTurn!.blocks;
    appendNarrativeBlock(
      targetBlocks,
      event,
      index,
      eventPresentationBinding,
      narrativeBlockBindings
    );
  });

  if (currentTurn) turns.push(finalizeNarrativeTurn(currentTurn));
  coalesceNarrativeBlocks(turns);
  attachHiddenTerminalLineageProvenance(
    turns,
    input.events,
    exactTargetTurnIds
  );
  for (let index = 0; index < turns.length; index += 1) {
    turns[index] = finalizeNarrativeTurn(turns[index]);
  }

  // 使用私有 sourceEventRefs 推断最早事件索引（与事件顺序一致）。
  if (acceptedReviewIndex >= 0) {
    annotateBlocksWithPhase(turns, input.events, acceptedReviewIndex);
  }
  resolveTimelineInteractionBlocks(turns, input.events);
  applyTurnAuthorityStates(
    turns,
    input.events,
    exactTargetTurnIds
  );
  applyTurnSettlementAndExecutionEvidence(
    turns,
    input.events,
    exactTargetTurnIds,
    authorityIndex
  );
  stabilizeNarrativeBlockIds(turns);

  const blockIdsByEventId = timelineBlockIdsByEventId(turns);
  const implementationTaskItems = input.events.flatMap((event, index) =>
    taskPlanTaskProjectionItems(
      input.events,
      event,
      index,
      blockIdsByEventId.get(event.id),
      languageIndex.settledBindingForEvent(
        event,
        languageIndex.snapshotBindingForEvent(event)
      )
    )
  );
  const activeInteraction = findActiveInteraction({
    events: input.events,
    pendingPermission: findLatestPendingPermission(input.events)?.request,
  });
  if (activeInteraction) {
    const blockId = interactionBlockId(turns, activeInteraction);
    for (const block of turns.flatMap((turn) => turn.blocks)) {
      if (block.id !== blockId) continue;
      const decisionRequest = activeInteraction.kind === 'requirement'
        ? activeInteraction.decisionRequest
        : block.decisionRequest;
      block.decisionRequest = decisionRequest;
      block.confirmable = true;
      block.interaction = {
        kind: activeInteraction.kind,
        interactionId: activeInteraction.interactionId,
        interactionRevision: activeInteraction.interactionRevision,
        targetId: activeInteraction.targetId,
        runId: activeInteraction.kind === 'permission'
          ? undefined
          : activeInteraction.runId,
        state: 'open',
        decisionRequest,
      };
    }
  }

  return {
    schemaVersion: NARRATIVE_TIMELINE_SCHEMA_VERSION,
    sessionId: input.sessionId,
    revision: 0,
    sourceEventVersion: input.events.length,
    lastDeltaSeq: 0,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    turns,
    eventCount: input.events.length,
    taskProjection: {
      title: 'Task projection',
      items: implementationTaskItems.slice(-8),
    },
    interactionProjection: activeInteraction
      ? { pending: { ...activeInteraction, blockId: interactionBlockId(turns, activeInteraction) } }
      : undefined,
    tokenUsageProjection: buildTokenUsageProjection(
      orderedUsageProjectionEvents(input.events, input.auxiliaryEvents ?? [])
    ),
    workspaceProjection: buildWorkspaceProjection(input.events),
  };
}

function buildProjectionTurnAuthorityIndex(
  events: readonly AgentEvent[]
): ProjectionTurnAuthorityIndex {
  const eventIdOccurrences = new Map<string, number>();
  for (const event of events) {
    eventIdOccurrences.set(event.id, (eventIdOccurrences.get(event.id) ?? 0) + 1);
  }

  const byEventId = new Map<string, ProjectionTurnAuthorityRef | null>();
  const turnIdOccurrences = new Map<string, number>();
  events.forEach((event, eventIndex) => {
    if (event.kind !== 'session_turn_authority') return;
    const authority = parseSessionTurnAuthorityPayload(event.payload);
    if (!authority) return;
    turnIdOccurrences.set(
      authority.turnId,
      (turnIdOccurrences.get(authority.turnId) ?? 0) + 1
    );
    if ((eventIdOccurrences.get(event.id) ?? 0) !== 1 || byEventId.has(event.id)) {
      byEventId.set(event.id, null);
      return;
    }
    byEventId.set(event.id, {
      eventIndex,
      sessionId: authority.sessionId,
      runId: authority.runId,
      turnId: authority.turnId,
    });
  });

  return {
    byEventId,
    ambiguousTurnIds: new Set(
      [...turnIdOccurrences.entries()]
        .filter(([, count]) => count !== 1)
        .map(([turnId]) => turnId)
    ),
  };
}

function exactProjectionTurnIdForLineageEvent(
  event: AgentEvent,
  eventIndex: number,
  authorityIndex: ProjectionTurnAuthorityIndex
): string | undefined {
  const payload = isRecordPayload(event.payload) ? event.payload : undefined;
  if (payload?.lineage === undefined) return undefined;
  const lineage = parseSessionFactLineage(payload.lineage);
  if (!lineage) {
    throw new Error(
      `session_shared_projection_invalid: fact_lineage_contract:${event.id}`
    );
  }
  if (sessionFactLineageDisposition(event) !== 'persistentDomainFact') {
    throw new Error(
      `session_shared_projection_invalid: fact_lineage_disposition:${event.id}`
    );
  }
  const authority = authorityIndex.byEventId.get(lineage.turnAuthorityRef);
  if (authority === undefined) {
    throw new Error(
      `session_shared_projection_invalid: turn_authority_ref_unavailable:${event.id}:${lineage.turnAuthorityRef}`
    );
  }
  if (authority === null) {
    throw new Error(
      `session_shared_projection_invalid: turn_authority_ref_ambiguous:${event.id}:${lineage.turnAuthorityRef}`
    );
  }
  if (authority.eventIndex >= eventIndex) {
    throw new Error(
      `session_shared_projection_invalid: turn_authority_ref_not_earlier:${event.id}:${lineage.turnAuthorityRef}`
    );
  }
  if (authority.sessionId !== event.sessionId) {
    throw new Error(
      `session_shared_projection_invalid: turn_authority_session_mismatch:${event.id}:${lineage.turnAuthorityRef}`
    );
  }
  if (authorityIndex.ambiguousTurnIds.has(authority.turnId)) {
    throw new Error(
      `session_shared_projection_invalid: turn_authority_turn_ambiguous:${event.id}:${authority.turnId}`
    );
  }
  return authority.turnId;
}

function registerProjectionTurnBlocks(
  index: Map<string, WorkingAgentTimelineBlock[]>,
  turnId: string,
  blocks: WorkingAgentTimelineBlock[],
  referencedExactTurnIds: ReadonlySet<string>
): void {
  const existing = index.get(turnId);
  if (!existing || existing === blocks) {
    index.set(turnId, blocks);
    return;
  }
  if (referencedExactTurnIds.has(turnId)) {
    throw new Error(
      `session_shared_projection_invalid: turn_authority_block_ambiguous:${turnId}`
    );
  }
  index.set(turnId, blocks);
}

function requiredProjectionTurnBlocks(
  index: ReadonlyMap<string, WorkingAgentTimelineBlock[]>,
  turnId: string,
  event: AgentEvent
): WorkingAgentTimelineBlock[] {
  const blocks = index.get(turnId);
  if (!blocks) {
    throw new Error(
      `session_shared_projection_invalid: turn_authority_block_unavailable:${event.id}:${turnId}`
    );
  }
  return blocks;
}

function attachHiddenTerminalLineageProvenance(
  turns: WorkingAgentTimelineTurn[],
  events: readonly AgentEvent[],
  exactTargetTurnIds: readonly (string | undefined)[]
): void {
  events.forEach((event, eventIndex) => {
    const targetTurnId = exactTargetTurnIds[eventIndex];
    if (
      !targetTurnId
      || !isExplicitlyHiddenTimelineEvent(event)
      || !isTerminalSessionRunState(event)
    ) {
      return;
    }
    const matchingTurns = turns.filter((turn) => turn.id === targetTurnId);
    if (matchingTurns.length !== 1) {
      throw new Error(
        `session_shared_projection_invalid: turn_authority_block_unavailable:${event.id}:${targetTurnId}`
      );
    }
    const turn = matchingTurns[0]!;
    const carrier = terminalLineageProvenanceCarrier(
      turn.blocks,
      narrativeEventStatus(event)
    );
    if (carrier) {
      appendProjectionFactProvenance(carrier, event);
      return;
    }
    turn.blocks.push(minimalTerminalStatusBlock(event, eventIndex, turn.blocks));
  });
}

function isTerminalSessionRunState(event: AgentEvent): boolean {
  if (event.kind !== 'session_run_state') return false;
  const status = narrativeEventStatus(event);
  return status === 'waiting'
    || status === 'completed'
    || status === 'failed'
    || status === 'cancelled';
}

function terminalLineageProvenanceCarrier(
  blocks: readonly WorkingAgentTimelineBlock[],
  status: string | undefined
): WorkingAgentTimelineBlock | undefined {
  const roles = status === 'waiting'
    ? ['interaction', 'diagnostic'] as const
    : status === 'failed' || status === 'cancelled'
      ? ['diagnostic', 'interaction'] as const
      : ['diagnostic', 'interaction'] as const;
  for (const role of roles) {
    const carrier = [...blocks].reverse().find((block) => block.entryRole === role);
    if (carrier) return carrier;
  }
  return undefined;
}

function appendProjectionFactProvenance(
  block: WorkingAgentTimelineBlock,
  event: AgentEvent
): void {
  const ref = eventRefForAgentEvent(event);
  if (!block.sourceEventRefs.includes(ref)) block.sourceEventRefs.push(ref);
  const factRefs = block.provenance?.factRefs ?? [];
  if (!factRefs.includes(ref)) {
    block.provenance = {
      ...(block.provenance ?? {
        origin: 'session',
        authority: 'session',
        sourceEventRefs: [],
        evidenceRefs: [],
      }),
      factRefs: [...factRefs, ref],
    };
  }
}

function minimalTerminalStatusBlock(
  event: AgentEvent,
  eventIndex: number,
  existingBlocks: readonly WorkingAgentTimelineBlock[]
): WorkingAgentTimelineBlock {
  const fallback = existingBlocks[0]
    ? projectionBindingFromBlock(
        existingBlocks[0],
        neutralProjectionLanguageBinding()
      )
    : neutralProjectionLanguageBinding();
  const status = narrativeEventStatus(event);
  const copy = terminalStatusProjectionCopy(status, fallback.language);
  const block = narrativeBlockFromEvents(
    [event],
    eventIndex,
    undefined,
    'error',
    'diagnostic',
    fallback
  );
  block.title = copy.title;
  block.summary = copy.summary;
  block.status = status === 'failed'
    ? 'failed'
    : status === 'cancelled'
      ? 'cancelled'
      : status === 'waiting'
        ? 'waiting'
        : 'completed';
  block.defaultCollapsed = false;
  block.bodyMarkdown = undefined;
  block.feedbackRef = undefined;
  block.displayHints = narrativeDisplayHints('diagnostic', block.title, block.summary);
  return block;
}

function terminalStatusProjectionCopy(
  status: string | undefined,
  language: ProjectionLanguageBinding['language']
): { title: string; summary: string } {
  if (status === 'failed') {
    return {
      title: localizedProjectionText(language, {
        zh: '任务失败',
        en: 'Task failed',
        neutral: 'Task failed',
      }),
      summary: localizedProjectionText(language, {
        zh: '本次任务已失败，请查看同一轮中的诊断信息。',
        en: 'This task failed. Review the diagnostic information in this turn.',
        neutral: 'This task failed.',
      }),
    };
  }
  if (status === 'cancelled') {
    return {
      title: localizedProjectionText(language, {
        zh: '任务已取消',
        en: 'Task cancelled',
        neutral: 'Task cancelled',
      }),
      summary: localizedProjectionText(language, {
        zh: '本次任务已取消，没有继续执行。',
        en: 'This task was cancelled and did not continue.',
        neutral: 'This task was cancelled.',
      }),
    };
  }
  if (status === 'waiting') {
    return {
      title: localizedProjectionText(language, {
        zh: '任务已暂停',
        en: 'Task paused',
        neutral: 'Task paused',
      }),
      summary: localizedProjectionText(language, {
        zh: '本次任务正在等待继续条件。',
        en: 'This task is waiting for a continuation condition.',
        neutral: 'This task is waiting.',
      }),
    };
  }
  return {
    title: localizedProjectionText(language, {
      zh: '任务已完成',
      en: 'Task completed',
      neutral: 'Task completed',
    }),
    summary: localizedProjectionText(language, {
      zh: '本次任务已完成。',
      en: 'This task completed.',
      neutral: 'This task completed.',
    }),
  };
}

function toSharedConversationProjectionV2(
  projection: WorkingAgentTimelineResult
): AgentTimelineResult {
  const shared: AgentTimelineResult = {
    ...projection,
    schemaVersion: NARRATIVE_TIMELINE_SCHEMA_VERSION,
    turns: projection.turns.map((turn) => ({
      ...turn,
      blocks: turn.blocks.map((block) => {
        const {
          events: _privateEvents,
          sourceEventRefs,
          ...sharedBlock
        } = block;
        return {
          ...sharedBlock,
          provenance: {
            ...(sharedBlock.provenance ?? {
              origin: 'session',
              authority: 'session',
              factRefs: [],
              evidenceRefs: [],
            }),
            sourceEventRefs,
          },
        };
      }),
    })),
  };
  assertSharedConversationProjectionV2(shared);
  return shared;
}

export function assertSharedConversationProjectionV2(
  projection: AgentTimelineResult
): void {
  if (projection.schemaVersion !== NARRATIVE_TIMELINE_SCHEMA_VERSION) {
    throw new Error('session_shared_projection_invalid: schema_version');
  }
  if (
    !projectionNonemptyString(projection.sessionId) ||
    typeof projection.generatedAt !== 'string' ||
    !projectionNonnegativeInteger(projection.revision) ||
    !projectionNonnegativeInteger(projection.sourceEventVersion) ||
    !projectionNonnegativeInteger(projection.lastDeltaSeq) ||
    !projectionNonnegativeInteger(projection.eventCount) ||
    !Array.isArray(projection.turns)
  ) {
    throw new Error('session_shared_projection_invalid: root_contract');
  }
  assertProjectionKeys(projection, [
    'schemaVersion',
    'sessionId',
    'revision',
    'sourceEventVersion',
    'lastDeltaSeq',
    'generatedAt',
    'turns',
    'eventCount',
    'taskProjection',
    'interactionProjection',
    'runProjection',
    'tokenUsageProjection',
    'workspaceProjection',
  ], 'root');
  const turnIds = new Set<string>();
  const blockIds = new Set<string>();
  for (const turn of projection.turns) {
    assertProjectionKeys(turn, [
      'id',
      'sequence',
      'sessionId',
      'status',
      'startedAt',
      'completedAt',
      'settlement',
      'executionEvidence',
      'blocks',
    ], `turn:${turn.id}`);
    if (
      !projectionNonemptyString(turn.id) ||
      turn.sessionId !== projection.sessionId ||
      !timelineStatusValue(turn.status) ||
      (turn.sequence !== undefined && !projectionNonnegativeInteger(turn.sequence)) ||
      !optionalProjectionString(turn.startedAt) ||
      !optionalProjectionString(turn.completedAt) ||
      !Array.isArray(turn.blocks)
    ) {
      throw new Error(`session_shared_projection_invalid: turn_contract:${turn.id}`);
    }
    if (turnIds.has(turn.id)) {
      throw new Error(`session_shared_projection_invalid: duplicate_turn_id:${turn.id}`);
    }
    assertProjectedTurnSettlement(turn);
    assertProjectedTurnExecutionEvidence(turn);
    turnIds.add(turn.id);
    for (const block of turn.blocks) {
      if (blockIds.has(block.id)) {
        throw new Error(`session_shared_projection_invalid: duplicate_block_id:${block.id}`);
      }
      blockIds.add(block.id);
    }
  }
  const blocks = projection.turns.flatMap((turn) => turn.blocks);
  for (const block of blocks) {
    assertSharedConversationBlockV2(block);
  }
  if (projection.taskProjection !== undefined) {
    if (!isRecordPayload(projection.taskProjection)) {
      throw new Error('session_shared_projection_invalid: task_projection_contract');
    }
    assertProjectionKeys(projection.taskProjection, ['title', 'items'], 'task_projection');
    if (
      typeof projection.taskProjection.title !== 'string' ||
      !Array.isArray(projection.taskProjection.items)
    ) {
      throw new Error('session_shared_projection_invalid: task_projection_contract');
    }
    for (const item of projection.taskProjection.items) {
      assertProjectionKeys(item, [
        'id',
        'title',
        'summary',
        'status',
        'blockId',
        'narrativeKind',
        'settlementKind',
      ], `task_item:${item.id}`);
      if (
        typeof item.id !== 'string' ||
        typeof item.title !== 'string' ||
        typeof item.summary !== 'string' ||
        !timelineStatusValue(item.status) ||
        typeof item.blockId !== 'string' ||
        item.narrativeKind === undefined ||
        !matchesNarrativeKind(item.narrativeKind) ||
        item.narrativeKind === 'thinking' ||
        !matchesTaskSettlementKind(item.settlementKind)
      ) {
        throw new Error(`session_shared_projection_invalid: task_item_contract:${item.id}`);
      }
    }
  }
  if (projection.runProjection !== undefined) {
    if (!isRecordPayload(projection.runProjection)) {
      throw new Error('session_shared_projection_invalid: run_projection_contract');
    }
    assertProjectionKeys(projection.runProjection, [
      'runId',
      'turnId',
      'taskId',
      'revision',
      'status',
      'phase',
      'waitReason',
      'activeInteractionId',
      'languageBinding',
    ], 'run_projection');
    if (
      !projectionNonemptyString(projection.runProjection.runId) ||
      !optionalProjectionString(projection.runProjection.turnId) ||
      !optionalProjectionString(projection.runProjection.taskId) ||
      !projectionNonnegativeInteger(projection.runProjection.revision) ||
      !matchesRunStatus(projection.runProjection.status) ||
      !matchesRunPhase(projection.runProjection.phase) ||
      !optionalProjectionString(projection.runProjection.waitReason) ||
      !optionalProjectionString(projection.runProjection.activeInteractionId)
    ) {
      throw new Error('session_shared_projection_invalid: run_projection_contract');
    }
    assertLanguageBinding(projection.runProjection.languageBinding, 'run_projection');
  }
  if (projection.workspaceProjection !== undefined) {
    if (!isRecordPayload(projection.workspaceProjection)) {
      throw new Error('session_shared_projection_invalid: workspace_projection_contract');
    }
    assertProjectionKeys(
      projection.workspaceProjection,
      ['revision', 'changedTargets'],
      'workspace_projection'
    );
    if (
      !projectionNonnegativeInteger(projection.workspaceProjection.revision) ||
      !projectionStringArray(projection.workspaceProjection.changedTargets)
    ) {
      throw new Error('session_shared_projection_invalid: workspace_projection_contract');
    }
  }
  if (projection.tokenUsageProjection !== undefined) {
    if (!isRecordPayload(projection.tokenUsageProjection)) {
      throw new Error('session_shared_projection_invalid: usage_projection_contract');
    }
    assertProjectionKeys(projection.tokenUsageProjection, ['totals', 'requests'], 'usage_projection');
    if (!Array.isArray(projection.tokenUsageProjection.requests)) {
      throw new Error('session_shared_projection_invalid: usage_projection_contract');
    }
    assertUsageProjectionRecord(projection.tokenUsageProjection.totals, 'usage_totals');
    for (const request of projection.tokenUsageProjection.requests) {
      assertUsageProjectionRecord(request, `usage_request:${request.requestId}`, [
        'requestId',
        'turnId',
        'userEventId',
        'title',
        'startedAt',
        'completedAt',
        'stages',
      ]);
      if (
        typeof request.requestId !== 'string' ||
        typeof request.turnId !== 'string' ||
        typeof request.userEventId !== 'string' ||
        typeof request.title !== 'string' ||
        !optionalProjectionString(request.startedAt) ||
        !optionalProjectionString(request.completedAt) ||
        !projectionStringArray(request.stages)
      ) {
        throw new Error(`session_shared_projection_invalid: usage_request_contract:${request.requestId}`);
      }
    }
  }
  if (projection.interactionProjection !== undefined) {
    if (!isRecordPayload(projection.interactionProjection)) {
      throw new Error('session_shared_projection_invalid: interaction_projection_contract');
    }
    assertProjectionKeys(projection.interactionProjection, ['pending'], 'interaction_projection');
  }
  const pending = projection.interactionProjection?.pending;
  if (pending !== undefined) {
    if (!isRecordPayload(pending)) {
      throw new Error('session_shared_projection_invalid: pending_interaction_contract');
    }
    if (!matchesInteractionKind(pending.kind)) {
      throw new Error('session_shared_projection_invalid: pending_interaction_kind');
    }
    assertProjectionKeys(pending, pending.kind === 'permission'
      ? [
          'kind',
          'interactionId',
          'interactionRevision',
          'targetId',
          'requestId',
          'request',
          'blockId',
          'title',
          'summary',
        ]
      : [
          'kind',
          'interactionId',
          'interactionRevision',
          'targetId',
          'runId',
          pending.kind === 'plan'
            ? 'planId'
            : pending.kind === 'review'
              ? 'reviewId'
              : 'requirementId',
          'blockId',
          'title',
          'summary',
          ...(pending.kind === 'requirement' ? ['decisionRequest'] : []),
        ], 'pending_interaction');
    if (pending.kind === 'permission') {
      if (!isRecordPayload(pending.request)) {
        throw new Error('session_shared_projection_invalid: permission_request_contract');
      }
      assertProjectionKeys(pending.request, [
        'id',
        'runId',
        'requestKind',
        'permissionBundleId',
        'contractId',
        'affectedOperationIds',
        'workUnitIds',
        'toolId',
        'toolName',
        'riskLevel',
        'summary',
        'diff',
        'argumentsPreview',
      ], 'permission_request');
      if (
        !projectionNonemptyString(pending.request.id) ||
        !optionalProjectionString(pending.request.runId) ||
        (pending.request.requestKind !== undefined &&
          pending.request.requestKind !== 'runtimePermission' &&
          pending.request.requestKind !== 'scopeExpansion') ||
        !optionalProjectionString(pending.request.permissionBundleId) ||
        !optionalProjectionString(pending.request.contractId) ||
        !optionalProjectionString(pending.request.toolId) ||
        typeof pending.request.toolName !== 'string' ||
        typeof pending.request.summary !== 'string' ||
        !matchesPermissionRiskLevel(pending.request.riskLevel) ||
        !optionalProjectionString(pending.request.diff) ||
        (pending.request.argumentsPreview !== undefined &&
          typeof pending.request.argumentsPreview !== 'string') ||
        !optionalProjectionStringArray(pending.request.affectedOperationIds) ||
        !optionalProjectionStringArray(pending.request.workUnitIds)
      ) {
        throw new Error('session_shared_projection_invalid: permission_request_contract');
      }
    }
    if (pending.kind === 'requirement' && pending.decisionRequest !== undefined) {
      assertDecisionRequest(
        pending.decisionRequest,
        'pending_decision_request'
      );
    }
    if (
      !projectionNonemptyString(pending.interactionId) ||
      !projectionNonemptyString(pending.interactionRevision) ||
      !projectionNonemptyString(pending.targetId) ||
      !optionalProjectionString(pending.blockId) ||
      !optionalProjectionString(pending.title) ||
      !optionalProjectionString(pending.summary) ||
      (pending.kind !== 'permission' && !projectionNonemptyString(pending.runId)) ||
      (pending.kind === 'permission' && !projectionNonemptyString(pending.requestId)) ||
      (pending.kind === 'plan' && pending.planId !== pending.targetId) ||
      (pending.kind === 'review' &&
        (pending.reviewId !== pending.targetId || typeof pending.reviewId !== 'string')) ||
      (pending.kind === 'requirement' &&
        (pending.requirementId !== pending.targetId ||
          typeof pending.requirementId !== 'string'))
    ) {
      throw new Error('session_shared_projection_invalid: pending_interaction_contract');
    }
    const block = blocks.find((candidate) => candidate.id === pending.blockId);
    if (
      !block?.interaction ||
      block.interaction.interactionId !== pending.interactionId ||
      block.interaction.interactionRevision !== pending.interactionRevision ||
      block.interaction.targetId !== pending.targetId
    ) {
      throw new Error('session_shared_projection_invalid: pending_interaction_identity');
    }
  }
  if (containsForbiddenSharedProjectionKey(projection)) {
    throw new Error('session_shared_projection_invalid: private_payload');
  }
}

export function isSharedConversationProjectionV2(
  value: unknown
): value is AgentTimelineResult {
  if (!isRecordPayload(value) || !Array.isArray(value.turns)) return false;
  try {
    assertSharedConversationProjectionV2(value as unknown as AgentTimelineResult);
    return true;
  } catch {
    return false;
  }
}

export function isSharedConversationBlockV2(
  value: unknown
): value is AgentTimelineBlock {
  if (!isRecordPayload(value)) return false;
  try {
    assertSharedConversationBlockV2(value as unknown as AgentTimelineBlock);
    return true;
  } catch {
    return false;
  }
}

function assertSharedConversationBlockV2(block: AgentTimelineBlock): void {
  assertProjectionKeys(block, [
    'id',
    'sequence',
    'revision',
    'deliveryMode',
    'durability',
    'kind',
    'narrativeKind',
    'entryRole',
    'activity',
    'title',
    'summary',
    'status',
    'defaultCollapsed',
    'bodyMarkdown',
    'localizedContent',
    'structuredProjection',
    'decisionRequest',
    'interaction',
    'confirmable',
    'attachments',
    'feedbackRef',
    'displayHints',
    'evidenceRefs',
    'provenance',
    'languageBinding',
    'taskProjectionRef',
  ], `block:${block.id}`);
  if (
    !projectionNonemptyString(block.id) ||
    !matchesBlockKind(block.kind) ||
    !matchesNarrativeKind(block.narrativeKind) ||
    !matchesEntryRole(block.entryRole) ||
    !matchesDurability(block.durability) ||
    (block.sequence !== undefined && !projectionNonnegativeInteger(block.sequence)) ||
    (block.revision !== undefined && !projectionNonnegativeInteger(block.revision)) ||
    (block.deliveryMode !== undefined && !matchesDeliveryMode(block.deliveryMode)) ||
    typeof block.title !== 'string' ||
    typeof block.summary !== 'string' ||
    !timelineStatusValue(block.status) ||
    typeof block.defaultCollapsed !== 'boolean' ||
    (block.bodyMarkdown !== undefined && typeof block.bodyMarkdown !== 'string') ||
    !isRecordPayload(block.languageBinding) ||
    !isRecordPayload(block.provenance) ||
    (block.confirmable !== undefined && typeof block.confirmable !== 'boolean') ||
    !optionalProjectionStringArray(block.evidenceRefs) ||
    !optionalProjectionString(block.taskProjectionRef) ||
    (block.attachments !== undefined && !Array.isArray(block.attachments))
  ) {
    throw new Error(`session_shared_projection_invalid: block_contract:${block.id}`);
  }
  if (block.narrativeKind === 'thinking' || block.kind === 'thinking') {
    throw new Error(`session_shared_projection_invalid: reasoning_block:${block.id}`);
  }
  if (block.entryRole === 'finalAnswer' && block.durability !== 'committed') {
    throw new Error(`session_shared_projection_invalid: uncommitted_final:${block.id}`);
  }
  if (block.activity !== undefined) {
    if (!isRecordPayload(block.activity)) {
      throw new Error(`session_shared_projection_invalid: activity_contract:${block.id}`);
    }
    assertProjectionKeys(block.activity, [
      'activityId',
      'activityRevision',
      'kind',
      'status',
      'title',
      'summary',
      'source',
      'runId',
      'planId',
      'draftId',
      'targets',
      'actionIds',
      'workUnitIds',
      'resourcePacketIds',
      'toolName',
      'operation',
      'itemCount',
      'errorCode',
      'errorMessage',
    ], `activity:${block.activity.activityId}`);
    if (
      !projectionNonemptyString(block.activity.activityId) ||
      (block.activity.activityRevision !== undefined &&
        !projectionNonnegativeInteger(block.activity.activityRevision)) ||
      !matchesActivityKind(block.activity.kind) ||
      !timelineStatusValue(block.activity.status) ||
      typeof block.activity.title !== 'string' ||
      typeof block.activity.summary !== 'string' ||
      !matchesActivitySource(block.activity.source) ||
      !optionalProjectionString(block.activity.runId) ||
      !optionalProjectionString(block.activity.planId) ||
      !optionalProjectionString(block.activity.draftId) ||
      !optionalProjectionStringArray(block.activity.targets) ||
      !optionalProjectionStringArray(block.activity.actionIds) ||
      !optionalProjectionStringArray(block.activity.workUnitIds) ||
      !optionalProjectionStringArray(block.activity.resourcePacketIds) ||
      !optionalProjectionString(block.activity.toolName) ||
      !optionalProjectionString(block.activity.operation) ||
      (block.activity.itemCount !== undefined &&
        !projectionNonnegativeInteger(block.activity.itemCount)) ||
      !optionalProjectionString(block.activity.errorCode) ||
      !optionalProjectionString(block.activity.errorMessage)
    ) {
      throw new Error(`session_shared_projection_invalid: activity_contract:${block.id}`);
    }
  }
  if (block.localizedContent !== undefined) {
    if (!isRecordPayload(block.localizedContent)) {
      throw new Error(
        `session_shared_projection_invalid: localized_content_contract:${block.id}`
      );
    }
    assertProjectionKeys(
      block.localizedContent,
      ['text', 'messageKey', 'messageArgs'],
      `localized_content:${block.id}`
    );
    if (
      !optionalProjectionString(block.localizedContent.text) ||
      !optionalProjectionString(block.localizedContent.messageKey) ||
      !optionalProjectionStringRecord(block.localizedContent.messageArgs)
    ) {
      throw new Error(`session_shared_projection_invalid: localized_content_contract:${block.id}`);
    }
  }
  if (block.structuredProjection !== undefined) {
    if (!isRecordPayload(block.structuredProjection)) {
      throw new Error(
        `session_shared_projection_invalid: structured_projection_contract:${block.id}`
      );
    }
    assertProjectionKeys(block.structuredProjection, [
      'kind',
      'schemaVersion',
      'title',
      'titleKey',
      'titleArgs',
      'summary',
      'summaryKey',
      'messageArgs',
      'sections',
    ], `structured_projection:${block.id}`);
    if (
      (block.structuredProjection.kind !== 'plan' &&
        block.structuredProjection.kind !== 'review') ||
      typeof block.structuredProjection.schemaVersion !== 'string' ||
      !optionalProjectionString(block.structuredProjection.title) ||
      !optionalProjectionString(block.structuredProjection.titleKey) ||
      !optionalProjectionStringRecord(block.structuredProjection.titleArgs) ||
      !optionalProjectionString(block.structuredProjection.summary) ||
      !optionalProjectionString(block.structuredProjection.summaryKey) ||
      !optionalProjectionStringRecord(block.structuredProjection.messageArgs) ||
      !Array.isArray(block.structuredProjection.sections)
    ) {
      throw new Error(`session_shared_projection_invalid: structured_projection_contract:${block.id}`);
    }
  }
  if (block.decisionRequest !== undefined) {
    if (!isRecordPayload(block.decisionRequest)) {
      throw new Error(
        `session_shared_projection_invalid: decision_request_contract:${block.id}`
      );
    }
    assertDecisionRequest(block.decisionRequest, `decision_request:${block.id}`);
  }
  if (block.interaction !== undefined) {
    if (!isRecordPayload(block.interaction)) {
      throw new Error(`session_shared_projection_invalid: interaction_contract:${block.id}`);
    }
    assertProjectionKeys(block.interaction, [
      'kind',
      'interactionId',
      'interactionRevision',
      'targetId',
      'runId',
      'state',
      'decisionRequest',
      'selectedDecision',
    ], `interaction:${block.id}`);
    if (
      !matchesInteractionKind(block.interaction.kind) ||
      !projectionNonemptyString(block.interaction.interactionId) ||
      !projectionNonemptyString(block.interaction.interactionRevision) ||
      !projectionNonemptyString(block.interaction.targetId) ||
      !optionalProjectionString(block.interaction.runId) ||
      !matchesInteractionState(block.interaction.state)
    ) {
      throw new Error(`session_shared_projection_invalid: interaction_contract:${block.id}`);
    }
    if (block.interaction.decisionRequest !== undefined) {
      if (!isRecordPayload(block.interaction.decisionRequest)) {
        throw new Error(
          `session_shared_projection_invalid: interaction_decision_request_contract:${block.id}`
        );
      }
      assertDecisionRequest(
        block.interaction.decisionRequest,
        `interaction_decision_request:${block.id}`
      );
    }
    if (block.interaction.selectedDecision !== undefined) {
      if (!isRecordPayload(block.interaction.selectedDecision)) {
        throw new Error(
          `session_shared_projection_invalid: selected_decision_contract:${block.id}`
        );
      }
      assertProjectionKeys(
        block.interaction.selectedDecision,
        ['decision', 'source', 'decidedAt'],
        `selected_decision:${block.id}`
      );
      if (
        typeof block.interaction.selectedDecision.decision !== 'string' ||
        (block.interaction.selectedDecision.source !== 'button' &&
          block.interaction.selectedDecision.source !== 'freeText') ||
        !optionalProjectionString(block.interaction.selectedDecision.decidedAt)
      ) {
        throw new Error(`session_shared_projection_invalid: selected_decision_contract:${block.id}`);
      }
    }
  }
  for (const attachment of block.attachments ?? []) {
    assertProjectionKeys(attachment, [
      'kind',
      'path',
      'absolutePath',
      'resourceId',
      'folderId',
      'source',
      'scope',
    ], `attachment:${block.id}`);
    if (
      (attachment.kind !== 'file' && attachment.kind !== 'directory') ||
      typeof attachment.path !== 'string' ||
      !optionalProjectionString(attachment.absolutePath) ||
      !optionalProjectionString(attachment.resourceId) ||
      !optionalProjectionString(attachment.folderId) ||
      (attachment.source !== 'mention' &&
        attachment.source !== 'contextMenu' &&
        attachment.source !== 'userSelected') ||
      (attachment.scope !== 'message' && attachment.scope !== 'session')
    ) {
      throw new Error(`session_shared_projection_invalid: attachment_contract:${block.id}`);
    }
  }
  if (block.feedbackRef !== undefined) {
    if (!isRecordPayload(block.feedbackRef)) {
      throw new Error(
        `session_shared_projection_invalid: feedback_ref_contract:${block.id}`
      );
    }
    assertProjectionKeys(
      block.feedbackRef,
      ['eventId', 'sessionId', 'kind'],
      `feedback_ref:${block.id}`
    );
    if (
      typeof block.feedbackRef.eventId !== 'string' ||
      typeof block.feedbackRef.sessionId !== 'string' ||
      typeof block.feedbackRef.kind !== 'string'
    ) {
      throw new Error(`session_shared_projection_invalid: feedback_ref_contract:${block.id}`);
    }
  }
  if (block.displayHints !== undefined) {
    if (!isRecordPayload(block.displayHints)) {
      throw new Error(
        `session_shared_projection_invalid: display_hints_contract:${block.id}`
      );
    }
    assertProjectionKeys(block.displayHints, [
      'density',
      'evidenceMode',
      'collapseAfterComplete',
      'checkpointKind',
      'showInTaskList',
      'taskListLabel',
      'taskListSummary',
      'phase',
    ], `display_hints:${block.id}`);
    if (
      (block.displayHints.density !== undefined &&
        block.displayHints.density !== 'normal' &&
        block.displayHints.density !== 'compact' &&
        block.displayHints.density !== 'debug') ||
      (block.displayHints.evidenceMode !== undefined &&
        block.displayHints.evidenceMode !== 'inline' &&
        block.displayHints.evidenceMode !== 'collapsed' &&
        block.displayHints.evidenceMode !== 'debugOnly') ||
      (block.displayHints.collapseAfterComplete !== undefined &&
        typeof block.displayHints.collapseAfterComplete !== 'boolean') ||
      !matchesCheckpointKind(block.displayHints.checkpointKind) ||
      (block.displayHints.showInTaskList !== undefined &&
        typeof block.displayHints.showInTaskList !== 'boolean') ||
      !optionalProjectionString(block.displayHints.taskListLabel) ||
      !optionalProjectionString(block.displayHints.taskListSummary) ||
      (block.displayHints.phase !== undefined &&
        block.displayHints.phase !== 'explore' &&
        block.displayHints.phase !== 'execute')
    ) {
      throw new Error(`session_shared_projection_invalid: display_hints_contract:${block.id}`);
    }
  }
  assertProjectionKeys(block.provenance, [
    'origin',
    'authority',
    'sourceEventRefs',
    'factRefs',
    'evidenceRefs',
  ], `provenance:${block.id}`);
  if (
    !matchesProvenanceOrigin(block.provenance.origin) ||
    !matchesProvenanceAuthority(block.provenance.authority) ||
    !projectionStringArray(block.provenance.sourceEventRefs) ||
    !projectionStringArray(block.provenance.factRefs) ||
    !projectionStringArray(block.provenance.evidenceRefs)
  ) {
    throw new Error(`session_shared_projection_invalid: provenance_contract:${block.id}`);
  }
  assertLanguageBinding(block.languageBinding, `block:${block.id}`);
  const sections = block.structuredProjection?.sections ?? [];
  for (const section of sections) {
    assertProjectionKeys(section, [
      'sectionId',
      'titleKey',
      'titleArgs',
      'emptyMessageKey',
      'items',
    ], `structured_section:${section.sectionId}`);
    if (
      typeof section.sectionId !== 'string' ||
      typeof section.titleKey !== 'string' ||
      !optionalProjectionStringRecord(section.titleArgs) ||
      !optionalProjectionString(section.emptyMessageKey) ||
      !Array.isArray(section.items)
    ) {
      throw new Error(`session_shared_projection_invalid: structured_section_contract:${section.sectionId}`);
    }
    for (const item of section.items) {
      assertProjectionKeys(item, [
        'itemId',
        'kind',
        'text',
        'messageKey',
        'messageArgs',
        'status',
        'targetRefs',
        'auditRefs',
        'objective',
        'acceptanceCriteria',
        'failureConditions',
      ], `structured_item:${item.itemId}`);
      if (
        typeof item.itemId !== 'string' ||
        typeof item.kind !== 'string' ||
        !optionalProjectionString(item.text) ||
        !optionalProjectionString(item.messageKey) ||
        !optionalProjectionString(item.status) ||
        !optionalProjectionStringRecord(item.messageArgs) ||
        !optionalProjectionStringArray(item.targetRefs) ||
        !optionalProjectionStringArray(item.auditRefs) ||
        !optionalProjectionString(item.objective) ||
        !optionalProjectionStringArray(item.acceptanceCriteria) ||
        !optionalProjectionStringArray(item.failureConditions)
      ) {
        throw new Error(`session_shared_projection_invalid: structured_item_contract:${item.itemId}`);
      }
    }
  }
}

function assertDecisionRequest(
  request: unknown,
  label: string
): asserts request is NonNullable<AgentTimelineBlock['decisionRequest']> {
  assertProjectionKeys(
    request,
    ['id', 'reason', 'summary', 'allowsFreeform', 'options'],
    label
  );
  if (
    !optionalProjectionString(request.id) ||
    !optionalProjectionString(request.reason) ||
    !optionalProjectionString(request.summary) ||
    typeof request.allowsFreeform !== 'boolean' ||
    !Array.isArray(request.options)
  ) {
    throw new Error(`session_shared_projection_invalid: ${label}_contract`);
  }
  for (const option of request.options) {
    assertProjectionKeys(option, [
      'id',
      'label',
      'description',
      'recommended',
      'effect',
    ], `${label}_option:${option.id}`);
    if (
      typeof option.id !== 'string' ||
      typeof option.label !== 'string' ||
      !optionalProjectionString(option.description) ||
      (option.recommended !== undefined && typeof option.recommended !== 'boolean')
    ) {
      throw new Error(`session_shared_projection_invalid: ${label}_option_contract`);
    }
    if (option.effect !== undefined) {
      if (!isRecordPayload(option.effect)) {
        throw new Error(`session_shared_projection_invalid: ${label}_effect_contract`);
      }
      assertProjectionKeys(option.effect, ['kind', 'reason'], `${label}_effect:${option.id}`);
      if (
        !matchesInteractionOptionEffect(option.effect.kind) ||
        !optionalProjectionString(
          option.effect.kind === 'replan' ? option.effect.reason : undefined
        ) ||
        (option.effect.kind !== 'replan' && 'reason' in option.effect)
      ) {
        throw new Error(`session_shared_projection_invalid: ${label}_effect_contract`);
      }
    }
  }
}

function assertLanguageBinding(
  binding: AgentTimelineBlock['languageBinding'],
  label: string
): void {
  assertProjectionKeys(
    binding,
    ['language', 'revision', 'status', 'sourceTurnId'],
    `language_binding:${label}`
  );
  if (
    !matchesPresentationLanguage(binding.language) ||
    !matchesLanguageBindingStatus(binding.status) ||
    (binding.revision !== undefined && !projectionNonnegativeInteger(binding.revision)) ||
    !optionalProjectionString(binding.sourceTurnId)
  ) {
    throw new Error(`session_shared_projection_invalid: language_binding_contract:${label}`);
  }
}

function assertProjectedTurnSettlement(
  turn: AgentTimelineResult['turns'][number]
): void {
  const settlement = turn.settlement;
  if (settlement === undefined) return;
  assertProjectionKeys(settlement, [
    'schemaVersion',
    'status',
    'factRef',
    'turnAuthorityRef',
  ], `turn_settlement:${turn.id}`);
  if (
    settlement.schemaVersion !== 'deepcode.session.turn-settlement.v1'
    || (
      settlement.status !== 'waiting'
      && settlement.status !== 'completed'
      && settlement.status !== 'failed'
      && settlement.status !== 'cancelled'
    )
    || !projectionEventRef(settlement.factRef)
    || !projectionNonemptyString(settlement.turnAuthorityRef)
  ) {
    throw new Error(
      `session_shared_projection_invalid: turn_settlement_contract:${turn.id}`
    );
  }
}

function assertProjectedTurnExecutionEvidence(
  turn: AgentTimelineResult['turns'][number]
): void {
  const evidence = turn.executionEvidence;
  if (evidence === undefined) return;
  assertProjectionKeys(evidence, [
    'kind',
    'sourceFactRef',
    'taskClaims',
  ], `turn_execution_evidence:${turn.id}`);
  if (
    (evidence.kind !== 'notRequired' && evidence.kind !== 'kernelFactBacked')
    || !projectionEventRef(evidence.sourceFactRef)
    || !Array.isArray(evidence.taskClaims)
    || (evidence.kind === 'notRequired' && evidence.taskClaims.length !== 0)
    || (evidence.kind === 'kernelFactBacked' && evidence.taskClaims.length === 0)
  ) {
    throw new Error(
      `session_shared_projection_invalid: turn_execution_evidence_contract:${turn.id}`
    );
  }
  const taskIds: string[] = [];
  for (const claim of evidence.taskClaims) {
    assertProjectionKeys(claim, [
      'taskId',
      'workUnitIds',
      'factRefs',
    ], `turn_execution_claim:${turn.id}`);
    if (
      !projectionNonemptyString(claim.taskId)
      || !projectionSortedUniqueNonemptyStrings(claim.workUnitIds)
      || claim.workUnitIds.length === 0
      || !projectionSortedUniqueNonemptyStrings(claim.factRefs)
      || claim.factRefs.length === 0
      || !claim.factRefs.every(projectionEventRef)
    ) {
      throw new Error(
        `session_shared_projection_invalid: turn_execution_claim_contract:${turn.id}`
      );
    }
    taskIds.push(claim.taskId);
  }
  if (!projectionSortedUniqueNonemptyStrings(taskIds)) {
    throw new Error(
      `session_shared_projection_invalid: turn_execution_claim_order:${turn.id}`
    );
  }
}

function assertUsageProjectionRecord(
  value: unknown,
  label: string,
  extraKeys: readonly string[] = []
): void {
  if (!isRecordPayload(value)) {
    throw new Error(`session_shared_projection_invalid: ${label}_contract`);
  }
  assertProjectionKeys(value, [
    'promptCacheHitTokens',
    'promptCacheMissTokens',
    'cachedTokens',
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'cacheHitRate',
    'providerCallCount',
    'providers',
    ...extraKeys,
  ], label);
  for (const key of [
    'promptCacheHitTokens',
    'promptCacheMissTokens',
    'cachedTokens',
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'providerCallCount',
  ]) {
    if (!projectionNonnegativeInteger(value[key])) {
      throw new Error(`session_shared_projection_invalid: ${label}_contract`);
    }
  }
  const hitRate = value.cacheHitRate;
  if (
    hitRate !== null &&
    (typeof hitRate !== 'number' ||
      !Number.isFinite(hitRate) ||
      hitRate < 0 ||
      hitRate > 1)
  ) {
    throw new Error(`session_shared_projection_invalid: ${label}_contract`);
  }
  if (!projectionStringArray(value.providers)) {
    throw new Error(`session_shared_projection_invalid: ${label}_contract`);
  }
}

function optionalProjectionString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function projectionStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function projectionSortedUniqueNonemptyStrings(
  value: unknown
): value is string[] {
  return Array.isArray(value)
    && value.every(projectionNonemptyString)
    && new Set(value).size === value.length
    && value.every((item, index) => index === 0 || value[index - 1]! < item);
}

function projectionEventRef(value: unknown): value is string {
  return projectionNonemptyString(value) && value.startsWith('event:');
}

function optionalProjectionStringArray(value: unknown): boolean {
  return value === undefined || projectionStringArray(value);
}

function optionalProjectionStringRecord(value: unknown): boolean {
  return value === undefined ||
    (isRecordPayload(value) && Object.values(value).every((item) => typeof item === 'string'));
}

function projectionNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function projectionNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function matchesEntryRole(value: unknown): boolean {
  return value === 'userMessage' ||
    value === 'agentUpdate' ||
    value === 'activityGroup' ||
    value === 'evidence' ||
    value === 'interaction' ||
    value === 'finalAnswer' ||
    value === 'diagnostic';
}

function matchesBlockKind(value: unknown): boolean {
  return value === 'user' ||
    value === 'assistant' ||
    value === 'thinking' ||
    value === 'stage' ||
    value === 'toolBatch' ||
    value === 'permission' ||
    value === 'plan' ||
    value === 'review' ||
    value === 'error' ||
    value === 'turnActions';
}

function matchesNarrativeKind(value: unknown): boolean {
  return value === undefined ||
    value === 'user' ||
    value === 'thinking' ||
    value === 'assistantNarration' ||
    value === 'assistantText' ||
    value === 'operationEvidence' ||
    value === 'requirement' ||
    value === 'plan' ||
    value === 'permission' ||
    value === 'verification' ||
    value === 'review' ||
    value === 'diagnostic';
}

function matchesDurability(value: unknown): boolean {
  return value === 'live' || value === 'committed';
}

function matchesDeliveryMode(value: unknown): boolean {
  return value === 'live' || value === 'buffered' || value === 'replay';
}

function timelineStatusValue(value: unknown): boolean {
  return value === 'queued' ||
    value === 'running' ||
    value === 'waiting' ||
    value === 'blocked' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'failed';
}

function matchesInteractionKind(value: unknown): boolean {
  return value === 'requirement' ||
    value === 'plan' ||
    value === 'permission' ||
    value === 'review';
}

function matchesInteractionState(value: unknown): boolean {
  return value === 'open' ||
    value === 'submitting' ||
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'needsRevision' ||
    value === 'superseded' ||
    value === 'expired';
}

function matchesInteractionOptionEffect(value: unknown): boolean {
  return value === 'continueWithAction' ||
    value === 'skipCurrentTask' ||
    value === 'replan' ||
    value === 'finishRun';
}

function matchesTaskSettlementKind(value: unknown): boolean {
  return value === undefined ||
    value === 'kernelCompleted' ||
    value === 'sessionEvidenceSatisfied' ||
    value === 'userSkipped' ||
    value === 'userAcceptedIncomplete' ||
    value === 'failed';
}

function matchesRunStatus(value: unknown): boolean {
  return value === 'active' ||
    value === 'waitingUser' ||
    value === 'waitingExternal' ||
    value === 'paused' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled';
}

function matchesRunPhase(value: unknown): boolean {
  return value === 'preparing' ||
    value === 'processing' ||
    value === 'executing' ||
    value === 'validating' ||
    value === 'waiting' ||
    value === 'settled';
}

function matchesActivityKind(value: unknown): boolean {
  return value === 'resourceSearch' ||
    value === 'resourceRead' ||
    value === 'editBatchQueued' ||
    value === 'editFileStarted' ||
    value === 'editFileCompleted' ||
    value === 'editFileFailed' ||
    value === 'toolExecution' ||
    value === 'reviewCheckpoint' ||
    value === 'diagnostic';
}

function matchesActivitySource(value: unknown): boolean {
  return value === 'session' ||
    value === 'kernel' ||
    value === 'provider' ||
    value === 'llm';
}

function matchesProvenanceOrigin(value: unknown): boolean {
  return value === 'user' ||
    value === 'session' ||
    value === 'kernel' ||
    value === 'provider';
}

function matchesProvenanceAuthority(value: unknown): boolean {
  return value === 'user' || value === 'session' || value === 'kernel';
}

function matchesLanguageBindingStatus(value: unknown): boolean {
  return value === 'pending' ||
    value === 'resolved' ||
    value === 'fallback' ||
    value === 'superseded' ||
    value === 'unavailable';
}

function matchesCheckpointKind(value: unknown): boolean {
  return value === undefined ||
    value === 'turnStart' ||
    value === 'llmProposal' ||
    value === 'resourcePacket' ||
    value === 'userGuidance' ||
    value === 'permission' ||
    value === 'review' ||
    value === 'final' ||
    value === 'diagnostic';
}

function matchesPermissionRiskLevel(value: unknown): boolean {
  return value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'critical';
}

function matchesPresentationLanguage(value: unknown): boolean {
  return value === 'zh-CN' || value === 'en-US' || value === 'neutral';
}

function assertProjectionKeys(
  value: unknown,
  allowed: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!isRecordPayload(value)) {
    throw new Error(`session_shared_projection_invalid: ${label}_contract`);
  }
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) {
    throw new Error(`session_shared_projection_invalid: unexpected_${label}_field:${unexpected}`);
  }
}

function containsForbiddenSharedProjectionKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenSharedProjectionKey);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === 'events' ||
      key === 'rawEventRefs' ||
      key === 'metadata' ||
      key === 'payload' ||
      key === 'kernelEvent' ||
      key === 'developerDetails' ||
      key === 'reasoningContent' ||
      key === 'reasoning_content' ||
      key === 'rawProvider'
    ) {
      return true;
    }
    if (containsForbiddenSharedProjectionKey(nested)) return true;
  }
  return false;
}

function buildWorkspaceProjection(
  events: AgentEvent[]
): NonNullable<AgentTimelineResult['workspaceProjection']> {
  const changedTargets: string[] = [];
  let revision = 0;
  for (const event of events) {
    const activity = narrativeActivity([event]);
    if (!activity) continue;
    if (activity.operation !== 'write' && activity.operation !== 'patch' && activity.operation !== 'delete') {
      continue;
    }
    revision += 1;
    for (const target of activity.targets ?? []) {
      if (target && !changedTargets.includes(target)) changedTargets.push(target);
    }
  }
  return { revision, changedTargets };
}

function interactionBlockId(
  turns: WorkingAgentTimelineTurn[],
  active: InteractionLedgerActiveInteraction
): string | undefined {
  const blocks = turns.flatMap((turn) => turn.blocks);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.events.some((event) => eventMatchesInteraction(event, active))) return block.id;
  }
  return undefined;
}

function eventMatchesInteraction(event: AgentEvent, active: InteractionLedgerActiveInteraction): boolean {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  if (active.kind === 'permission') {
    if (event.kind !== 'permission_request') return false;
    return [
      stringField(payload, 'id'),
      stringField(payload, 'requestId'),
      stringField(payload, 'permissionId'),
    ]
      .includes(active.requestId);
  }
  if (active.kind === 'plan') {
    return (event.kind === 'plan_card' || event.kind === 'plan_review') &&
      stringField(payload, 'runId') === active.runId &&
      stringField(payload, 'planId') === active.planId;
  }
  if (active.kind === 'review') {
    return event.kind === 'review_summary' &&
      stringField(payload, 'runId') === active.runId &&
      stringField(payload, 'reviewId') === active.reviewId;
  }
  return event.kind === 'requirement_confirmation' &&
    stringField(payload, 'runId') === active.runId &&
    stringField(payload, 'requirementId') === active.requirementId;
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
  const projection = buildWorkingNarrativeTimelineProjection({
    sessionId: input.sessionId,
    events: [...input.committedEvents, ...activeEvents],
    auxiliaryEvents: input.auxiliaryEvents,
    generatedAt: input.generatedAt,
  });
  projection.runProjection = activeRunProjection(
    input.activeDeltas ?? [],
    projection.interactionProjection?.pending?.interactionId
  );
  return toSharedConversationProjectionV2(
    annotateLiveOverlayBlocks(projection, activeEvents)
  );
}

function projectionDeltasToTransientEvents(input: {
  sessionId: string;
  committedEvents: AgentEvent[];
  activeDeltas: ProjectionDelta[];
  generatedAt?: string;
}): AgentEvent[] {
  const committed = committedProjectionIndex(input.committedEvents);
  return coalesceLiveToolActivities(input.activeDeltas)
    .filter((delta) => delta.sessionId === input.sessionId)
    .filter((delta) => delta.type !== 'committed')
    .filter((delta) => delta.type !== 'active_turn')
    .filter((delta) => delta.activity?.kind !== 'providerThinking')
    .filter((delta) => !isExplicitlyHiddenProjectionDelta(delta))
    .filter((delta) => !activeDeltaAlreadyCommitted(delta, committed))
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
    .flatMap((delta) => projectionDeltaToTransientEvent(delta, input.generatedAt));
}

function activeRunProjection(
  deltas: ProjectionDelta[],
  activeInteractionId?: string
): AgentTimelineResult['runProjection'] {
  const active = deltas
    .filter((delta) => delta.type !== 'committed' && Boolean(delta.runId))
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  const latest = active[active.length - 1];
  if (!latest?.runId) return undefined;
  const payload = isRecordPayload(latest.payload) ? latest.payload : {};
  const language = stringField(payload, 'presentationLanguage');
  const languageStatus = stringField(payload, 'languageStatus');
  const phase = runPhaseForProjectionDelta(latest);
  const status = latest.status === 'failed'
    ? 'failed'
    : latest.status === 'cancelled'
      ? 'cancelled'
      : latest.status === 'waiting'
        ? activeInteractionId ? 'waitingUser' : 'waitingExternal'
        : 'active';
  return {
    runId: latest.runId,
    turnId: latest.turnId,
    taskId: stringField(payload, 'taskId'),
    revision: latest.seq ?? active.length,
    status,
    phase,
    waitReason: status === 'waitingUser' || status === 'waitingExternal'
      ? latest.summary ?? latest.stage
      : undefined,
    activeInteractionId,
    languageBinding: {
      language: language === 'zh-CN' || language === 'en-US' ? language : 'neutral',
      revision: positiveIntegerField(payload, 'languageRevision'),
      status: languageStatus === 'pending' ||
        languageStatus === 'resolved' ||
        languageStatus === 'fallback' ||
        languageStatus === 'superseded' ||
        languageStatus === 'unavailable'
        ? languageStatus
        : 'unavailable',
      sourceTurnId: stringField(payload, 'sourceTurnId'),
    },
  };
}

function runPhaseForProjectionDelta(
  delta: ProjectionDelta
): NonNullable<AgentTimelineResult['runProjection']>['phase'] {
  if (delta.status === 'waiting') return 'waiting';
  if (delta.type === 'resource_delta' ||
      delta.type === 'tool_call_delta' ||
      delta.type === 'workunit_delta') {
    return 'executing';
  }
  if (delta.type === 'semantic_delta' ||
      delta.type === 'committed' ||
      (delta.type === 'active_turn' && delta.status === 'completed')) {
    return 'validating';
  }
  if (delta.stage?.includes('review') || delta.stage?.includes('validation')) {
    return 'validating';
  }
  if (delta.stage?.includes('prepare') || delta.status === 'queued') return 'preparing';
  return 'processing';
}

function coalesceLiveToolActivities(deltas: ProjectionDelta[]): ProjectionDelta[] {
  const toolCallsByItem = new Map<string, ProjectionDelta>();
  const resolvedItems = new Set<string>();
  for (const delta of deltas) {
    const key = liveToolItemKey(delta);
    if (!key) continue;
    if (delta.type === 'tool_call_delta') toolCallsByItem.set(key, delta);
    if (delta.type === 'resource_delta') resolvedItems.add(key);
  }

  return deltas.flatMap((delta) => {
    const key = liveToolItemKey(delta);
    if (key && delta.type === 'tool_call_delta' && resolvedItems.has(key)) return [];
    if (!key || delta.type !== 'resource_delta' || !delta.activity) return [delta];
    const toolCall = toolCallsByItem.get(key);
    const toolName = delta.activity.toolName ?? toolCall?.activity?.toolName;
    return [{
      ...delta,
      activity: {
        ...delta.activity,
        activityId: toolCall?.activity?.activityId ?? delta.activity.activityId,
        toolName,
        operation: delta.activity.operation ?? operationFromLiveToolName(toolName),
      },
    }];
  });
}

function liveToolItemKey(delta: ProjectionDelta): string | undefined {
  if (!delta.itemId || !delta.runId) return undefined;
  if (delta.type !== 'tool_call_delta' && delta.type !== 'resource_delta') return undefined;
  return `${delta.sessionId}:${delta.runId}:${delta.itemId}`;
}

function operationFromLiveToolName(toolName: string | undefined): string | undefined {
  if (!toolName) return undefined;
  const operations: Record<string, string> = {
    'fs.read': 'read',
    fs__read: 'read',
    'fs.list': 'list',
    fs__list: 'list',
    'fs.diff': 'diff',
    fs__diff: 'diff',
    'code.grep': 'search',
    code__search: 'search',
    'fs.write': 'write',
    fs__write: 'write',
    'fs.edit': 'patch',
    fs__patch: 'patch',
    'fs.delete': 'delete',
    fs__delete: 'delete',
  };
  return operations[toolName];
}

function projectionDeltaToTransientEvent(delta: ProjectionDelta, generatedAt?: string): AgentEvent[] {
  const id = liveOverlayEventId(delta);
  const ts = generatedAt ?? new Date().toISOString();
  const deltaPayload = isRecordPayload(delta.payload) ? delta.payload : {};
  const basePayload = {
    runId: delta.runId,
    turnId: delta.turnId,
    stage: delta.stage,
    status: projectionStatus(delta.status),
    summary: delta.summary,
    source: delta.source,
    activeOverlay: true,
    presentationLanguage: stringField(deltaPayload, 'presentationLanguage'),
    languageRevision: positiveIntegerField(deltaPayload, 'languageRevision'),
    languageStatus: stringField(deltaPayload, 'languageStatus'),
    sourceTurnId: stringField(deltaPayload, 'sourceTurnId'),
  };

  if (delta.type === 'semantic_delta') {
    // Semantic drafts remain in the private analysis stream. A plan or final
    // answer enters Shared Projection only after semantic validation and the
    // durable Session append has acknowledged the corresponding fact.
    return [];
  }

  const textKind = projectionDeltaTextChannel(delta);
  if (textKind && typeof delta.delta === 'string' && delta.delta.length > 0) {
    if (textKind === 'final') {
      // A final answer is not projected from Provider streaming bytes. The
      // committed assistant fact is the only visible final-answer authority.
      return [];
    }
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
    const displayPolicy = projectionDeltaDisplayPolicy(delta);
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
        presentation: displayPolicy.presentation ?? 'collapsible',
        visibility: displayPolicy.visibility ?? 'conversation',
      },
      display: {
        presentation: displayPolicy.presentation ?? 'collapsible',
        defaultOpen: activity.status === 'running' || activity.status === 'waiting' || activity.status === 'failed',
      },
    }];
  }

  return [];
}

function isExplicitlyHiddenProjectionDelta(delta: ProjectionDelta): boolean {
  const policy = projectionDeltaDisplayPolicy(delta);
  return policy.visibility === 'hidden'
    || policy.presentation === 'traceOnly'
    || delta.channel === 'reasoning'
    || delta.type === 'reasoning_delta';
}

function projectionDeltaDisplayPolicy(delta: ProjectionDelta): {
  visibility?: AgentEventVisibility;
  presentation?: AgentEventPresentation;
} {
  const payload = isRecordPayload(delta.payload) ? delta.payload : {};
  const visibility = stringField(payload, 'visibility');
  const presentation = stringField(payload, 'presentation');
  return {
    visibility: isAgentEventVisibility(visibility) ? visibility : undefined,
    presentation: isAgentEventPresentation(presentation) ? presentation : undefined,
  };
}

function isAgentEventVisibility(value: string | undefined): value is AgentEventVisibility {
  return value === 'conversation'
    || value === 'task'
    || value === 'trace'
    || value === 'both'
    || value === 'hidden';
}

function isAgentEventPresentation(value: string | undefined): value is AgentEventPresentation {
  return value === 'body'
    || value === 'collapsible'
    || value === 'stageSummary'
    || value === 'traceOnly';
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

function activeDeltaAlreadyCommitted(
  delta: ProjectionDelta,
  committed: CommittedProjectionIndex
): boolean {
  if (delta.committedEventIds?.some((id) => committed.eventIds.has(id))) return true;
  const activityId = delta.activity?.activityId;
  if (activityId && committed.activityIds.has(activityId)) return true;
  if (projectionIdentityKeysForDelta(delta).some((key) => committed.projectionKeys.has(key))) return true;
  const textIdentity = textProjectionIdentityForDelta(delta);
  if (textIdentity && committed.textIdentities.has(textIdentity)) return true;
  return false;
}

interface CommittedProjectionIndex {
  eventIds: Set<string>;
  activityIds: Set<string>;
  projectionKeys: Set<string>;
  textIdentities: Set<string>;
}

function committedProjectionIndex(events: AgentEvent[]): CommittedProjectionIndex {
  return {
    eventIds: new Set(events.map((event) => event.id).filter(Boolean)),
    activityIds: new Set(events.map(eventActivityId).filter((id): id is string => Boolean(id))),
    projectionKeys: new Set(events.flatMap(projectionIdentityKeysForEvent)),
    textIdentities: new Set(
      events
        .map(textProjectionIdentityForEvent)
        .filter((identity): identity is string => Boolean(identity))
    ),
  };
}

function projectionIdentityKeysForEvent(event: AgentEvent): string[] {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const output = isRecordPayload(payload.output) ? payload.output : {};
  const keys: string[] = [];
  const packetId = stringField(output, 'id');
  if (packetId) keys.push(`packet:${packetId}`);
  if (Array.isArray(output.items)) {
    for (const item of output.items) {
      if (!isRecordPayload(item)) continue;
      const callId = stringField(item, 'manifestEntryId');
      if (callId) keys.push(`call:${callId}`);
    }
  }
  return keys;
}

function projectionIdentityKeysForDelta(delta: ProjectionDelta): string[] {
  const payload = isRecordPayload(delta.payload) ? delta.payload : {};
  const keys: string[] = [];
  const packetId = stringField(payload, 'packetId');
  const callId = stringField(payload, 'callId') ?? delta.itemId?.trim();
  if (packetId) keys.push(`packet:${packetId}`);
  if (callId) keys.push(`call:${callId}`);
  return keys;
}

function textProjectionIdentityForEvent(event: AgentEvent): string | undefined {
  if (event.kind !== 'assistant_msg') return undefined;
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const channel = stringField(payload, 'channel');
  const runId = stringField(payload, 'runId');
  if (channel === 'reasoning') return `reasoning:${runId ?? ''}`;
  if (channel === 'final' || channel === 'progress') return `assistant:${runId ?? ''}`;
  return undefined;
}

function textProjectionIdentityForDelta(delta: ProjectionDelta): string | undefined {
  if (delta.type === 'reasoning_delta') return `reasoning:${delta.runId ?? ''}`;
  if (delta.type === 'assistant_delta') return `assistant:${delta.runId ?? ''}`;
  return undefined;
}

function eventActivityId(event: AgentEvent): string | undefined {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const activity = isRecordPayload(payload.activity) ? payload.activity : undefined;
  return activity ? stringField(activity, 'activityId') : undefined;
}

function isProjectionTimelineHiddenEvent(event: AgentEvent): boolean {
  const activity = conversationActivityFromEvent(event);
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const stage = stringField(payload, 'stage');
  const isSessionProviderStatus = event.kind === 'workflow_stage'
    && stage === 'session.provider_status'
    && activity?.kind === 'providerThinking'
    && stringField(payload, 'channel') === 'progress';
  if (isSessionProviderStatus) return true;
  if (event.kind === 'workflow_stage' || event.kind === 'workflow_decision') {
    const kernelEventKind = kernelEventFromPayload(payload)?.kind;
    if (isInternalOrchestrationStage({ stage, kernelEventKind })) return true;
    if (!activity) return true;
  }
  if (
    activity
    && !isMainTimelineActivityShape({ kind: activity.kind, toolName: activity.toolName })
  ) {
    return true;
  }
  return false;
}

function conversationActivityFromEvent(event: AgentEvent): AgentConversationActivity | undefined {
  const payload = isRecordPayload(event.payload) ? event.payload : undefined;
  return payload ? activityFromValue(payload.activity) : undefined;
}

interface HistoricalProjectionLanguageIndex {
  snapshotBindingForEvent(
    event: AgentEvent,
    fallback?: ProjectionLanguageBinding
  ): ProjectionLanguageBinding;
  settledBindingForEvent(
    event: AgentEvent,
    fallback?: ProjectionLanguageBinding
  ): ProjectionLanguageBinding;
}

function buildHistoricalProjectionLanguageIndex(
  events: readonly AgentEvent[]
): HistoricalProjectionLanguageIndex {
  interface IndexedBinding {
    tupleKey: string;
    binding: ProjectionLanguageBinding;
  }
  const byTuple = new Map<string, ProjectionLanguageBinding>();
  const byRunSourceMessage = new Map<string, IndexedBinding | null>();
  const bySourceMessage = new Map<string, IndexedBinding | null>();
  for (const authority of sessionTurnAuthorities(events)) {
    const tupleKey = projectionAuthorityTupleKey(
      authority.sessionId,
      authority.runId,
      authority.turnId,
      authority.languagePolicy.revision
    );
    const policy = resolveConversationLanguagePolicy(events, authority);
    const binding = normalizedProjectionLanguageBinding({
      language: policy.status === 'resolved' || policy.status === 'fallback'
        ? effectiveConversationLanguage(policy)
        : undefined,
      status: policy.status,
      revision: policy.revision,
      sourceTurnId: authority.turnId,
    });
    byTuple.set(tupleKey, binding);
    const indexed = { tupleKey, binding };
    for (const messageId of authority.sourceMessageIds) {
      indexProjectionSourceBinding(
        byRunSourceMessage,
        `${authority.runId}\u0000${messageId}`,
        indexed
      );
      indexProjectionSourceBinding(bySourceMessage, messageId, indexed);
    }
  }

  const sourceBinding = (event: AgentEvent): ProjectionLanguageBinding | undefined => {
    const payload = isRecordPayload(event.payload) ? event.payload : {};
    const messageId = event.kind === 'user_guidance'
      ? stringField(payload, 'guidanceId') ?? event.id
      : event.id;
    const runId = stringField(payload, 'ownerRunId')
      ?? stringField(payload, 'targetRunId')
      ?? stringField(payload, 'runId');
    if (runId) {
      const indexed = byRunSourceMessage.get(`${runId}\u0000${messageId}`);
      if (indexed === null) return neutralProjectionLanguageBinding();
      if (indexed) return indexed.binding;
    }
    const indexed = bySourceMessage.get(messageId);
    return indexed === null ? neutralProjectionLanguageBinding() : indexed?.binding;
  };

  const tupleBinding = (event: AgentEvent): ProjectionLanguageBinding | undefined => {
    if (!isRecordPayload(event.payload)) return undefined;
    const payload = event.payload;
    const sessionId = stringField(payload, 'sessionId') ?? event.sessionId;
    const runId = stringField(payload, 'runId')
      ?? stringField(payload, 'ownerRunId')
      ?? stringField(payload, 'targetRunId');
    const turnId = stringField(payload, 'sourceTurnId');
    const revision = positiveIntegerField(payload, 'languageRevision');
    if (!sessionId || !runId || !turnId || !revision) return undefined;
    return byTuple.get(projectionAuthorityTupleKey(sessionId, runId, turnId, revision));
  };

  return {
    snapshotBindingForEvent(event, fallback = neutralProjectionLanguageBinding()) {
      const local = projectionLanguageBindingFromEvent(event);
      if (local) return local;
      return sourceBinding(event) ?? fallback;
    },
    settledBindingForEvent(event, fallback = neutralProjectionLanguageBinding()) {
      return tupleBinding(event) ?? sourceBinding(event) ?? fallback;
    },
  };
}

function projectionLanguageBindingFromEvent(
  event: AgentEvent
): ProjectionLanguageBinding | undefined {
  if (!isRecordPayload(event.payload)) return undefined;
  const payload = event.payload;
  const explicitLanguage = stringField(payload, 'presentationLanguage');
  const providerLanguage = (
    event.kind === 'plan_card'
    || event.kind === 'requirement_confirmation'
    || event.kind === 'assistant_msg'
  )
    ? stringField(payload, 'responseLanguage')
    : undefined;
  const rawStatus = stringField(payload, 'languageStatus');
  if (!explicitLanguage && !providerLanguage && !rawStatus) return undefined;
  return normalizedProjectionLanguageBinding({
    language: explicitLanguage ?? providerLanguage,
    status: rawStatus,
    revision: positiveIntegerField(payload, 'languageRevision'),
    sourceTurnId: stringField(payload, 'sourceTurnId'),
  });
}

function normalizedProjectionLanguageBinding(input: {
  language?: string;
  status?: string;
  revision?: number;
  sourceTurnId?: string;
}): ProjectionLanguageBinding {
  const validStatus = input.status === 'pending'
    || input.status === 'resolved'
    || input.status === 'fallback'
    || input.status === 'superseded'
    || input.status === 'unavailable'
    ? input.status
    : undefined;
  if (
    validStatus === 'pending'
    || validStatus === 'superseded'
    || validStatus === 'unavailable'
  ) {
    return {
      language: 'neutral',
      revision: input.revision,
      status: validStatus,
      sourceTurnId: input.sourceTurnId,
    };
  }
  if (
    (validStatus === 'resolved' || validStatus === 'fallback')
    && (input.language === 'zh-CN' || input.language === 'en-US')
  ) {
    return {
      language: input.language,
      revision: input.revision,
      status: validStatus,
      sourceTurnId: input.sourceTurnId,
    };
  }
  if (
    input.status === undefined
    && (input.language === 'zh-CN' || input.language === 'en-US')
  ) {
    return {
      language: input.language,
      revision: input.revision,
      status: 'resolved',
      sourceTurnId: input.sourceTurnId,
    };
  }
  return {
    language: 'neutral',
    revision: input.revision,
    status: 'unavailable',
    sourceTurnId: input.sourceTurnId,
  };
}

function projectionAuthorityTupleKey(
  sessionId: string,
  runId: string,
  turnId: string,
  revision: number
): string {
  return `${sessionId}\u0000${runId}\u0000${turnId}\u0000${revision}`;
}

function indexProjectionSourceBinding(
  index: Map<string, { tupleKey: string; binding: ProjectionLanguageBinding } | null>,
  key: string,
  value: { tupleKey: string; binding: ProjectionLanguageBinding }
): void {
  const existing = index.get(key);
  if (existing === undefined || existing?.tupleKey === value.tupleKey) {
    index.set(key, value);
    return;
  }
  index.set(key, null);
}

function neutralProjectionLanguageBinding(): ProjectionLanguageBinding {
  return {
    language: 'neutral',
    status: 'unavailable',
  };
}

function userInputBubbleEvent(event: AgentEvent, index: number): AgentEvent | null {
  const content = userInputBubbleContent(event);
  if (!content) return null;
  const contentKey = userInputBubbleContentKey(event);
  const contentArgs = userInputBubbleContentArgs(event);
  const sourcePayload = isRecordPayload(event.payload) ? event.payload : {};
  return {
    id: `user-input-${event.id || index}`,
    sessionId: event.sessionId,
    ts: event.ts,
    kind: 'user_msg',
    payload: {
      content,
      ...(contentKey ? { contentKey } : {}),
      ...(contentArgs ? { contentArgs } : {}),
      source: 'user',
      sourceEventId: event.id,
      sourceEventKind: event.kind,
      ...(stringField(sourcePayload, 'presentationLanguage')
        ? { presentationLanguage: stringField(sourcePayload, 'presentationLanguage') }
        : {}),
      ...(numberField(sourcePayload, 'languageRevision') !== undefined
        ? { languageRevision: numberField(sourcePayload, 'languageRevision') }
        : {}),
      ...(stringField(sourcePayload, 'languageStatus')
        ? { languageStatus: stringField(sourcePayload, 'languageStatus') }
        : {}),
      ...(stringField(sourcePayload, 'sourceTurnId')
        ? { sourceTurnId: stringField(sourcePayload, 'sourceTurnId') }
        : {}),
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
    return firstPayloadText(event.payload, ['guidance', 'userGuidance']);
  }
  if (event.kind === 'plan_review') {
    const status = stringField(event.payload, 'status');
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return undefined;
    return firstPayloadText(event.payload, ['guidance', 'userGuidance']);
  }
  if (event.kind === 'review_summary') {
    const status = stringField(event.payload, 'status');
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return undefined;
    if (stringField(event.payload, 'contentKey')) return undefined;
    return firstPayloadText(event.payload, ['guidance', 'userGuidance', 'content']);
  }
  return undefined;
}

function userInputBubbleContentKey(event: AgentEvent): string | undefined {
  if (!isRecordPayload(event.payload)) return undefined;
  return stringField(event.payload, 'contentKey') ??
    stringField(event.payload, 'messageKey') ??
    stringField(event.payload, 'summaryKey');
}

function userInputBubbleContentArgs(event: AgentEvent): Record<string, string> | undefined {
  if (!isRecordPayload(event.payload)) return undefined;
  const args = recordStringValues(event.payload.contentArgs) ??
    recordStringValues(event.payload.messageArgs) ??
    recordStringValues(event.payload.summaryArgs);
  return args && Object.keys(args).length > 0 ? args : undefined;
}

function recordStringValues(value: unknown): Record<string, string> | undefined {
  if (!isRecordPayload(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) result[key] = String(item);
  }
  return result;
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
    ((event.kind === 'plan_review' || event.kind === 'review_summary') && Boolean(userInputBubbleContent(event)));
}

function annotateLiveOverlayBlocks(
  projection: WorkingAgentTimelineResult,
  activeEvents: AgentEvent[]
): WorkingAgentTimelineResult {
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
        return {
          ...block,
          status: shouldStream ? 'running' : shouldSeal ? 'completed' : block.status,
          defaultCollapsed: shouldStream || shouldSeal ? false : block.defaultCollapsed,
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

function isTimelineTextBlock(block: WorkingAgentTimelineBlock): boolean {
  return block.narrativeKind === 'thinking' ||
    block.narrativeKind === 'assistantNarration' ||
    block.narrativeKind === 'assistantText';
}

function turnContainsLiveEvent(
  turn: WorkingAgentTimelineTurn,
  liveEventIds: Set<string>
): boolean {
  return turn.blocks.some((block) => block.events.some((event) => liveEventIds.has(event.id)));
}

function taskPlanTaskProjectionItems(
  events: AgentEvent[],
  event: AgentEvent,
  eventIndex: number,
  projectedBlockId: string | undefined,
  presentationBinding: ProjectionLanguageBinding
): NonNullable<AgentTimelineResult['taskProjection']>['items'] {
  if (event.kind !== 'plan_card' || !isRecordPayload(event.payload)) return [];
  const taskPlan = event.payload.taskPlan;
  if (!isRecordPayload(taskPlan)) return [];
  const tasks = Array.isArray(taskPlan.tasks) ? taskPlan.tasks : [];
  const planRunId = stringField(event.payload, 'runId');
  const planId = stringField(event.payload, 'planId');
  const lifecycle = taskPlanLifecycle(events, event, eventIndex);
  const taskLedger = latestAcceptedPlanTaskLedger(events.slice(eventIndex + 1), planRunId, planId);
  return tasks.flatMap((item, index) => {
    if (!isRecordPayload(item)) return [];
    const taskId = stringField(item, 'taskId') ?? stringField(item, 'id') ?? `task-${index + 1}`;
    const title = stringField(item, 'title') ?? taskId;
    const acceptance = stringArrayField(item, 'acceptanceCriteria');
    const failure = stringArrayField(item, 'failureCriteria');
    const scope = stringField(item, 'scope');
    const targets = [
      ...stringArrayOrSingleField(item, 'target'),
      ...stringArrayOrSingleField(item, 'targets'),
    ];
    const ledgerProjection = implementationTaskProjectionFromLedger(taskLedger, taskId);
    const factStatus = implementationTaskStatus(lifecycle, targets, taskId);
    const status = mergeImplementationTaskStatus(ledgerProjection?.status, factStatus);
    const settlementKind = factStatus === 'completed'
      ? 'completedByKernelFacts'
      : ledgerProjection?.settlementKind;
    const summary = [
      implementationTaskSettlementSummary(settlementKind, presentationBinding),
      scope,
      acceptance.length ? `Acceptance: ${acceptance.join('; ')}` : '',
      failure.length ? `Stop/Replan: ${failure.join('; ')}` : '',
    ].filter(Boolean).join(' · ');
    return [{
      id: `implementation-plan-${event.id || eventIndex}-${taskId}`,
      title,
      summary: summary || stringField(taskPlan, 'summary') || '',
      status,
      blockId: projectedBlockId ?? `plan-${event.id || eventIndex}`,
      narrativeKind: 'plan' as const,
      settlementKind: sharedTaskSettlementKind(settlementKind, status),
    }];
  });
}

function sharedTaskSettlementKind(
  settlementKind: ImplementationTaskSettlementKind | undefined,
  status: AgentTimelineStatus
): NonNullable<
  NonNullable<AgentTimelineResult['taskProjection']>['items'][number]['settlementKind']
> | undefined {
  if (status === 'failed') return 'failed';
  if (settlementKind === 'completedByKernelFacts') return 'kernelCompleted';
  if (settlementKind === 'modelJudgedSufficient') return 'sessionEvidenceSatisfied';
  if (settlementKind === 'skippedByUser') return 'userSkipped';
  if (settlementKind === 'acceptedIncompleteByUser') return 'userAcceptedIncomplete';
  return undefined;
}

function latestAcceptedPlanTaskLedger(
  events: AgentEvent[],
  planRunId?: string,
  planId?: string
): Record<string, unknown> | undefined {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'workflow_stage') continue;
    const payload = isRecordPayload(event.payload) ? event.payload : {};
    if (stringField(payload, 'stage') !== 'accepted_plan.batch_checkpoint') continue;
    if (!samePlanDecision(payload, planRunId, planId)) continue;
    const ledger = isRecordPayload(payload.taskLedger) ? payload.taskLedger : undefined;
    if (ledger) return ledger;
  }
  return undefined;
}

type ImplementationTaskSettlementKind =
  | 'completedByKernelFacts'
  | 'modelJudgedSufficient'
  | 'skippedByUser'
  | 'acceptedIncompleteByUser';

function implementationTaskProjectionFromLedger(
  ledger: Record<string, unknown> | undefined,
  taskId: string
): {
  status: AgentTimelineStatus;
  settlementKind?: ImplementationTaskSettlementKind;
} | undefined {
  if (!ledger) return undefined;
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const normalizedTaskId = normalizeTaskId(taskId);
  for (const entry of entries) {
    if (!isRecordPayload(entry)) continue;
    const entryTaskId = normalizeTaskId(stringField(entry, 'taskId') ?? '');
    if (!entryTaskId || entryTaskId !== normalizedTaskId) continue;
    const status = stringField(entry, 'status');
    if (
      status === 'completedByKernelFacts'
      || status === 'modelJudgedSufficient'
      || status === 'skippedByUser'
      || status === 'acceptedIncompleteByUser'
    ) {
      return { status: 'completed', settlementKind: status };
    }
    if (status === 'failed') return { status: 'failed' };
    if (status === 'inProgress') return { status: 'running' };
    return { status: 'queued' };
  }
  return undefined;
}

function implementationTaskSettlementSummary(
  settlementKind: ImplementationTaskSettlementKind | undefined,
  binding: ProjectionLanguageBinding
): string {
  if (settlementKind === 'completedByKernelFacts') {
    return localizedProjectionText(binding.language, {
      zh: 'Kernel 事实已确认完成',
      en: 'Completed by Kernel facts',
      neutral: 'settlement=kernelFactsCompleted',
    });
  }
  if (settlementKind === 'modelJudgedSufficient') {
    return localizedProjectionText(binding.language, {
      zh: 'Session 已评估现有证据足够；没有对应的 Kernel 变更完成事实',
      en: 'Session assessed the evidence as sufficient; no corresponding Kernel mutation-completion fact exists',
      neutral: 'settlement=sessionEvidenceAssessed kernelMutationCompleted=false',
    });
  }
  if (settlementKind === 'skippedByUser') {
    return localizedProjectionText(binding.language, {
      zh: '用户已跳过此任务',
      en: 'Skipped by the user',
      neutral: 'settlement=userSkipped',
    });
  }
  if (settlementKind === 'acceptedIncompleteByUser') {
    return localizedProjectionText(binding.language, {
      zh: '用户已接受此任务保持未完成',
      en: 'Accepted as incomplete by the user',
      neutral: 'settlement=userAcceptedIncomplete',
    });
  }
  return '';
}

function mergeImplementationTaskStatus(
  ledgerStatus: AgentTimelineStatus | undefined,
  factStatus: AgentTimelineStatus
): AgentTimelineStatus {
  // Kernel facts can advance a stale checkpoint ledger; terminal ledger states still remain authoritative.
  if (!ledgerStatus) return factStatus;
  if (ledgerStatus === 'failed' || factStatus === 'failed' || factStatus === 'blocked') return 'failed';
  if (ledgerStatus === 'completed' || factStatus === 'completed') return 'completed';
  if (ledgerStatus === 'running' || factStatus === 'running') return 'running';
  return ledgerStatus;
}

interface TaskPlanLifecycle {
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

function taskPlanLifecycle(
  events: AgentEvent[],
  planEvent: AgentEvent,
  planEventIndex: number
): TaskPlanLifecycle {
  const planPayload = isRecordPayload(planEvent.payload) ? planEvent.payload : {};
  const planRunId = stringField(planPayload, 'runId');
  const planId = stringField(planPayload, 'planId');
  const lifecycle: TaskPlanLifecycle = {
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
  lifecycle: TaskPlanLifecycle,
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
  const owner = isRecordPayload(payload.decisionOwner) ? payload.decisionOwner : undefined;
  const ownerKind = stringField(payload, 'decisionKind') ?? (owner ? stringField(owner, 'kind') : undefined);
  const ownerPlanId = ownerKind === 'plan'
    ? stringField(payload, 'targetId') ?? (owner ? stringField(owner, 'targetId') : undefined)
    : undefined;
  const decisionPlanId = stringField(payload, 'planId') ??
    stringField(payload, 'sourcePlanId') ??
    stringField(payload, 'targetId') ??
    (owner ? stringField(owner, 'planId') : undefined) ??
    ownerPlanId;
  if (planId && decisionPlanId) return decisionPlanId === planId;
  return !planRunId || !decisionRunId || decisionRunId === planRunId;
}

interface ImplementationFact {
  status: AgentTimelineStatus;
  paths: string[];
  ids: string[];
}

function implementationFactFromEvent(event: AgentEvent): ImplementationFact | null {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const kind = kernelEventFromPayload(payload)?.kind ?? stringField(payload, 'stage');
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
    for (const key of ['path', 'absolutePath', 'normalizedTargetPath', 'resourceScope', 'target', 'targets', 'targetPath', 'writeSet', 'deleteSet']) {
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
  collect(payload.activity);
  const kernelEvent = kernelEventFromPayload(payload);
  const kernelRecord = kernelEvent as unknown as Record<string, unknown> | undefined;
  collect(kernelRecord);
  if (kernelEvent?.kind === 'tool.completed') {
    collect(kernelEvent.fact.output);
  } else if (kernelEvent?.kind === 'tool.requested') {
    collect(kernelEvent.fact.argsPreview);
  } else if (kernelRecord && 'output' in kernelRecord) {
    collect(kernelRecord.output);
  }
  if (kernelEvent?.kind === 'work_unit.queued') collect(kernelEvent.workUnit);
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
  collect(payload.activity);
  const kernelEvent = kernelEventFromPayload(payload);
  const kernelRecord = kernelEvent as unknown as Record<string, unknown> | undefined;
  collect(kernelRecord);
  if (kernelEvent?.kind === 'tool.completed' || kernelEvent?.kind === 'tool.requested') {
    collect(kernelEvent.fact);
  }
  if (kernelEvent?.kind === 'work_unit.queued') collect(kernelEvent.workUnit);
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
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim();
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

function pathMatchesTaskTarget(path: string, target: string): boolean {
  const normalizedPath = normalizeTaskPath(path);
  const normalizedTarget = normalizeTaskPath(target);
  if (!normalizedPath || !normalizedTarget) return false;
  return normalizedPath === normalizedTarget ||
    normalizedPath.endsWith(`/${normalizedTarget}`) ||
    normalizedTarget.endsWith(`/${normalizedPath}`);
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

function orderedUsageProjectionEvents(
  domainEvents: readonly AgentEvent[],
  auxiliaryEvents: readonly AgentEvent[]
): AgentEvent[] {
  return [...domainEvents, ...auxiliaryEvents]
    .map((event, index) => ({
      event,
      index,
      timestamp: Date.parse(event.ts),
    }))
    .sort((left, right) => {
      const leftTimestamp = Number.isFinite(left.timestamp)
        ? left.timestamp
        : Number.MAX_SAFE_INTEGER;
      const rightTimestamp = Number.isFinite(right.timestamp)
        ? right.timestamp
        : Number.MAX_SAFE_INTEGER;
      return leftTimestamp - rightTimestamp || left.index - right.index;
    })
    .map(({ event }) => event);
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

function appendInteractionSettlementToExistingBlock(
  turns: WorkingAgentTimelineTurn[],
  currentTurn: WorkingAgentTimelineTurn,
  event: AgentEvent,
  index: number,
  fallbackBinding: ProjectionLanguageBinding,
  exactTargetBlocks?: WorkingAgentTimelineBlock[]
): void {
  const candidate = narrativeBlockFromEvents(
    [event],
    index,
    undefined,
    undefined,
    undefined,
    fallbackBinding
  );
  const identity = semanticNarrativeBlockIdentity(candidate);
  if (exactTargetBlocks) {
    if (
      identity
      && mergeInteractionSettlementIntoBlocks(
        exactTargetBlocks,
        identity,
        event,
        index,
        fallbackBinding
      )
    ) {
      return;
    }
    exactTargetBlocks.push(candidate);
    return;
  }
  if (identity) {
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const blocks = turns[turnIndex].blocks;
      if (
        mergeInteractionSettlementIntoBlocks(
          blocks,
          identity,
          event,
          index,
          fallbackBinding
        )
      ) return;
    }
  }
  currentTurn.blocks.push(candidate);
}

function mergeInteractionSettlementIntoBlocks(
  blocks: WorkingAgentTimelineBlock[],
  identity: string,
  event: AgentEvent,
  index: number,
  fallbackBinding: ProjectionLanguageBinding
): boolean {
  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = blocks[blockIndex];
    if (semanticNarrativeBlockIdentity(block) !== identity) continue;
    blocks[blockIndex] = narrativeBlockFromEvents(
      [...block.events, event],
      index,
      block.id,
      block.kind,
      block.narrativeKind,
      projectionBindingFromBlock(block, fallbackBinding)
    );
    return true;
  }
  return false;
}

function coalesceNarrativeBlocks(turns: WorkingAgentTimelineTurn[]): void {
  for (const turn of turns) {
    const coalesced: WorkingAgentTimelineBlock[] = [];
    const indexByIdentity = new Map<string, number>();
    for (const block of turn.blocks) {
      const identity = semanticNarrativeBlockIdentity(block);
      const canCoalesce = block.entryRole === 'interaction' ||
        block.entryRole === 'activityGroup' ||
        block.entryRole === 'evidence';
      const existingIndex = identity && canCoalesce
        ? indexByIdentity.get(identity)
        : undefined;
      if (existingIndex === undefined) {
        if (identity && canCoalesce) indexByIdentity.set(identity, coalesced.length);
        coalesced.push(block);
        continue;
      }
      const existing = coalesced[existingIndex];
      coalesced[existingIndex] = narrativeBlockFromEvents(
        [...existing.events, ...block.events],
        existingIndex,
        existing.id,
        existing.kind,
        existing.narrativeKind,
        projectionBindingFromBlock(existing, neutralProjectionLanguageBinding())
      );
    }
    turn.blocks = coalesced;
  }
}

function projectionBindingFromBlock(
  block: WorkingAgentTimelineBlock,
  fallback: ProjectionLanguageBinding
): ProjectionLanguageBinding {
  return block.languageBinding
    ? {
        language: block.languageBinding.language,
        revision: block.languageBinding.revision,
        status: block.languageBinding.status,
        sourceTurnId: block.languageBinding.sourceTurnId,
      }
    : fallback;
}

function appendNarrativeBlock(
  blocks: WorkingAgentTimelineBlock[],
  event: AgentEvent,
  index: number,
  presentationBinding: ProjectionLanguageBinding,
  blockBindings: Map<string, ProjectionLanguageBinding>
): void {
  const nextNarrativeKind = narrativeKindForEvent(event);
  const nextLegacyKind = legacyKindForNarrative(nextNarrativeKind);
  const last = blocks[blocks.length - 1];
  const lastBinding = last ? blockBindings.get(last.id) : undefined;
  if (
    last
    && lastBinding
    && sameProjectionLanguageBinding(lastBinding, presentationBinding)
    && canGroupNarrativeEvent(last, event, nextNarrativeKind)
  ) {
    const events = [...last.events, event];
    const grouped = narrativeBlockFromEvents(
      events,
      index,
      last.id,
      nextLegacyKind,
      nextNarrativeKind,
      presentationBinding
    );
    blocks[blocks.length - 1] = grouped;
    blockBindings.delete(last.id);
    blockBindings.set(grouped.id, presentationBinding);
    return;
  }
  const block = narrativeBlockFromEvents(
    [event],
    index,
    undefined,
    nextLegacyKind,
    nextNarrativeKind,
    presentationBinding
  );
  blocks.push(block);
  blockBindings.set(block.id, presentationBinding);
}

function sameProjectionLanguageBinding(
  left: ProjectionLanguageBinding,
  right: ProjectionLanguageBinding
): boolean {
  return left.language === right.language
    && left.revision === right.revision
    && left.status === right.status
    && left.sourceTurnId === right.sourceTurnId;
}

function canGroupNarrativeEvent(
  last: WorkingAgentTimelineBlock,
  event: AgentEvent,
  nextNarrativeKind: AgentTimelineNarrativeKind
): boolean {
  if (last.narrativeKind !== nextNarrativeKind || last.status === 'failed') return false;
  // Each provider call is a distinct reasoning item. Streaming chunks for one
  // call are already coalesced before they enter the narrative projection.
  if (nextNarrativeKind === 'thinking') return false;
  if (nextNarrativeKind === 'review') {
    const lastReviewKey = reviewNarrativeGroupKey(last.events);
    const nextReviewKey = reviewNarrativeGroupKey([event]);
    return Boolean(lastReviewKey && nextReviewKey && lastReviewKey === nextReviewKey);
  }
  if (nextNarrativeKind !== 'operationEvidence') return false;

  const lastActivityKey = narrativeActivityGroupKey(last.events);
  const nextActivityKey = narrativeActivityGroupKey([event]);
  if (lastActivityKey || nextActivityKey) {
    return Boolean(lastActivityKey && nextActivityKey && lastActivityKey === nextActivityKey);
  }
  return narrativeStageGroupKey(last.events[last.events.length - 1]) === narrativeStageGroupKey(event);
}

function reviewNarrativeGroupKey(events: AgentEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind !== 'review_summary' || !isRecordPayload(event.payload)) continue;
    const runId = stringField(event.payload, 'runId');
    const reviewId = stringField(event.payload, 'reviewId') ?? stringField(event.payload, 'sourcePlanId');
    if (runId && reviewId) return `${runId}:${reviewId}`;
  }
  return undefined;
}

function narrativeActivityGroupKey(events: AgentEvent[]): string | undefined {
  const activity = narrativeActivity(events);
  if (!activity) return undefined;
  const runId = activity.runId ??
    events.flatMap((event) => {
      const payload = isRecordPayload(event.payload) ? event.payload : {};
      return [stringField(payload, 'runId')];
    }).find((value): value is string => Boolean(value)) ??
    'run';
  const actionId = activity.actionIds?.[0];
  if (actionId) return `${runId}:action:${actionId}`;
  const workUnitId = activity.workUnitIds?.[0];
  if (workUnitId) return `${runId}:work-unit:${workUnitId}`;
  return `${runId}:activity:${activity.activityId}`;
}

function narrativeStageGroupKey(event: AgentEvent | undefined): string | undefined {
  if (!event) return undefined;
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const stage = stringField(payload, 'stage');
  const channel = stringField(payload, 'channel');
  return stage || channel ? `${event.kind}:${stage ?? ''}:${channel ?? ''}` : event.kind;
}

function narrativeBlockFromEvents(
  events: AgentEvent[],
  index: number,
  existingId?: string,
  forcedKind?: AgentTimelineBlockKind,
  forcedNarrativeKind?: AgentTimelineNarrativeKind,
  presentationBinding: ProjectionLanguageBinding = neutralProjectionLanguageBinding()
): WorkingAgentTimelineBlock {
  const first = events[0];
  const narrativeKind = forcedNarrativeKind ?? narrativeKindForEvent(first);
  const legacyKind = forcedKind ?? legacyKindForNarrative(narrativeKind);
  const activity = narrativeActivity(events);
  const status = activity?.status ?? narrativeStatus(events);
  const title = activity?.title ?? narrativeTitle(events, narrativeKind, presentationBinding);
  const summary = activity?.summary ?? summarizeAgentEvents(events, presentationBinding);
  const body = narrativeBody(events, narrativeKind);
  const structuredProjection = narrativeStructuredProjection(events, narrativeKind);
  const attachments = narrativeAttachments(events);
  const feedbackEvent = [...events].reverse().find((event) => event.kind !== 'user_msg');
  const evidenceRefs = events.flatMap(eventEvidenceRefs);
  const entryRole = timelineEntryRole(narrativeKind);
  return {
    id: existingId ?? `${narrativeKind}-${first.id || index}`,
    kind: legacyKind,
    narrativeKind,
    entryRole,
    durability: events.some((event) => event.id.startsWith('live:'))
      ? 'live'
      : 'committed',
    activity,
    title,
    summary,
    status,
    defaultCollapsed: narrativeDefaultCollapsed(narrativeKind, status),
    bodyMarkdown: body,
    localizedContent: localizedTimelineContent(events, narrativeKind),
    structuredProjection,
    decisionRequest: undefined,
    interaction: interactionViewFromEvents(events, narrativeKind),
    confirmable: events.some((event) =>
      isRecordPayload(event.payload) && event.payload.confirmable === true
    ),
    attachments,
    feedbackRef: feedbackEvent
      ? { eventId: feedbackEvent.id, sessionId: feedbackEvent.sessionId, kind: feedbackEvent.kind }
      : undefined,
    displayHints: narrativeDisplayHints(narrativeKind, title, summary),
    evidenceRefs,
    provenance: narrativeProvenance(events, entryRole, evidenceRefs),
    languageBinding: {
      language: presentationBinding.language,
      revision: presentationBinding.revision,
      status: presentationBinding.status,
      sourceTurnId: presentationBinding.sourceTurnId,
    },
    sourceEventRefs: events.map(eventRefForAgentEvent),
    taskProjectionRef: shouldShowNarrativeInTaskList(narrativeKind) ? `task-${narrativeKind}-${first.id || index}` : undefined,
    events,
  };
}

function interactionViewFromEvents(
  events: AgentEvent[],
  kind: AgentTimelineNarrativeKind
): AgentTimelineBlock['interaction'] {
  const interactionKind = kind === 'requirement' ||
    kind === 'plan' ||
    kind === 'permission' ||
    kind === 'review'
    ? kind
    : undefined;
  if (!interactionKind) return undefined;
  const openingEvent = events.find((event) => {
    const payload = isRecordPayload(event.payload) ? event.payload : {};
    if (interactionKind === 'requirement') {
      return event.kind === 'requirement_confirmation' && payload.confirmable === true;
    }
    if (interactionKind === 'plan') {
      return (event.kind === 'plan_card' || event.kind === 'plan_review') &&
        planInteractionAwaitsDecision(payload);
    }
    if (interactionKind === 'permission') return event.kind === 'permission_request';
    return event.kind === 'review_summary' &&
      stringField(payload, 'status') === 'waitingUserReview';
  });
  if (!openingEvent || !isRecordPayload(openingEvent.payload)) return undefined;
  const openingPayload = openingEvent.payload;
  const runId = stringField(openingPayload, 'runId');
  const targetId = interactionKind === 'requirement'
    ? stringField(openingPayload, 'requirementId')
    : interactionKind === 'plan'
      ? stringField(openingPayload, 'planId')
      : interactionKind === 'permission'
        ? stringField(openingPayload, 'id') ??
          stringField(openingPayload, 'requestId') ??
          stringField(openingPayload, 'permissionId')
        : stringField(openingPayload, 'reviewId');
  if (!targetId) return undefined;
  const settlement = [...events].reverse().find((event) => {
    if (event.id === openingEvent.id || !isRecordPayload(event.payload)) return false;
    return decisionStatusResolved(stringField(event.payload, 'status')) ||
      event.kind === 'permission_result';
  });
  const settlementPayload = settlement && isRecordPayload(settlement.payload)
    ? settlement.payload
    : undefined;
  const state = interactionStateFromSettlement(settlementPayload);
  const decision = settlementPayload
    ? stringField(settlementPayload, 'decision') ??
      stringField(settlementPayload, 'status')
    : undefined;
  const freeText = settlementPayload
    ? Boolean(
        firstPayloadText(settlementPayload, ['guidance', 'userGuidance']) ||
        (!stringField(settlementPayload, 'contentKey') &&
          firstPayloadText(settlementPayload, ['content']))
      )
    : false;
  return {
    kind: interactionKind,
    interactionId: `interaction:${interactionKind}:${runId ?? 'session'}:${targetId}`,
    interactionRevision: openingEvent.id,
    targetId,
    runId,
    state,
    selectedDecision: decision
      ? {
          decision,
          source: freeText ? 'freeText' : 'button',
          decidedAt: settlement?.ts,
        }
      : undefined,
  };
}

function interactionStateFromSettlement(
  payload: Record<string, unknown> | undefined
): NonNullable<AgentTimelineBlock['interaction']>['state'] {
  if (!payload) return 'open';
  const status = stringField(payload, 'status');
  if (status === 'accepted' || status === 'completed') return 'accepted';
  if (status === 'rejected' || status === 'cancelled') return 'rejected';
  if (status === 'needsRevision') return 'needsRevision';
  return 'accepted';
}

function timelineEntryRole(
  kind: AgentTimelineNarrativeKind
): NonNullable<AgentTimelineBlock['entryRole']> {
  switch (kind) {
    case 'user': return 'userMessage';
    case 'assistantNarration': return 'agentUpdate';
    case 'operationEvidence': return 'activityGroup';
    case 'verification': return 'evidence';
    case 'requirement':
    case 'plan':
    case 'permission':
    case 'review':
      return 'interaction';
    case 'assistantText': return 'finalAnswer';
    case 'diagnostic':
    case 'thinking':
      return 'diagnostic';
  }
}

function localizedTimelineContent(
  events: AgentEvent[],
  kind: AgentTimelineNarrativeKind
): AgentTimelineBlock['localizedContent'] {
  if (kind !== 'user') return undefined;
  const event = events.find((candidate) => candidate.kind === 'user_msg');
  if (!event || !isRecordPayload(event.payload)) return undefined;
  const text = firstPayloadText(event.payload, ['content', 'message', 'text']);
  const messageKey = stringField(event.payload, 'contentKey') ??
    stringField(event.payload, 'messageKey');
  const messageArgs = recordStringValues(event.payload.contentArgs) ??
    recordStringValues(event.payload.messageArgs);
  return text || messageKey
    ? { text, messageKey, messageArgs }
    : undefined;
}

function narrativeProvenance(
  events: AgentEvent[],
  entryRole: NonNullable<AgentTimelineBlock['entryRole']>,
  evidenceRefs: string[]
): NonNullable<AgentTimelineBlock['provenance']> {
  const sources = events.flatMap((event) => {
    const payload = isRecordPayload(event.payload) ? event.payload : {};
    return [stringField(payload, 'source')];
  }).filter((value): value is string => Boolean(value));
  const origin = entryRole === 'userMessage'
    ? 'user'
    : sources.includes('kernel') || entryRole === 'evidence'
      ? 'kernel'
      : sources.includes('provider') || sources.includes('llm') ||
          entryRole === 'finalAnswer' || entryRole === 'agentUpdate'
        ? 'provider'
        : 'session';
  const authority = entryRole === 'userMessage'
    ? 'user'
    : origin === 'kernel'
      ? 'kernel'
      : 'session';
  const factRefs = events
    .filter((event) => !event.id.startsWith('live:'))
    .map(eventRefForAgentEvent);
  return {
    origin,
    authority,
    sourceEventRefs: [],
    factRefs,
    evidenceRefs,
  };
}

function narrativeAttachments(events: AgentEvent[]): AgentContextAttachment[] | undefined {
  const attachments = events.flatMap((event) => {
    if (!isRecordPayload(event.payload) || !Array.isArray(event.payload.attachments)) return [];
    return event.payload.attachments.filter(isAgentContextAttachment);
  });
  return attachments.length > 0 ? attachments : undefined;
}

function isAgentContextAttachment(value: unknown): value is AgentContextAttachment {
  if (!isRecordPayload(value)) return false;
  return typeof value.path === 'string' &&
    (value.scope === 'session' || value.scope === 'message') &&
    (value.kind === 'file' || value.kind === 'directory') &&
    (value.source === 'mention' || value.source === 'contextMenu' || value.source === 'userSelected');
}

function narrativeStructuredProjection(
  events: AgentEvent[],
  kind: AgentTimelineNarrativeKind
): AgentTimelineBlock['structuredProjection'] {
  if (kind !== 'plan' && kind !== 'review') return undefined;
  const field = kind === 'plan' ? 'readablePlan' : 'readableReview';
  for (const event of [...events].reverse()) {
    const payload = isRecordPayload(event.payload) ? event.payload : undefined;
    const readable = payload && isRecordPayload(payload[field]) ? payload[field] : undefined;
    if (!readable || !Array.isArray(readable.sections)) continue;
    const schemaVersion = stringField(readable, 'schemaVersion');
    if (!schemaVersion) continue;
    return {
      kind,
      schemaVersion,
      title: stringField(readable, 'title'),
      titleKey: stringField(readable, 'titleKey'),
      titleArgs: recordStringValues(readable.titleArgs),
      summary: stringField(readable, 'summary'),
      summaryKey: stringField(readable, 'summaryKey'),
      messageArgs: recordStringValues(readable.messageArgs),
      sections: readable.sections.flatMap((section) => {
        if (!isRecordPayload(section)) return [];
        const sectionId = stringField(section, 'sectionId');
        const titleKey = stringField(section, 'titleKey');
        if (!sectionId || !titleKey || !Array.isArray(section.items)) return [];
        return [{
          sectionId,
          titleKey,
          titleArgs: recordStringValues(section.titleArgs),
          emptyMessageKey: stringField(section, 'emptyMessageKey'),
          items: section.items.flatMap((item) => {
            if (!isRecordPayload(item)) return [];
            const itemId = stringField(item, 'itemId');
            const itemKind = stringField(item, 'kind');
            if (!itemId || !itemKind) return [];
            return [{
              itemId,
              kind: itemKind,
              text: stringField(item, 'text'),
              messageKey: stringField(item, 'messageKey'),
              messageArgs: recordStringValues(item.messageArgs),
              status: stringField(item, 'status'),
              targetRefs: stringArrayField(item, 'targetRefs'),
              auditRefs: stringArrayField(item, 'auditRefs'),
              objective: isRecordPayload(item.metadata)
                ? stringField(item.metadata, 'objective')
                : undefined,
              acceptanceCriteria: isRecordPayload(item.metadata)
                ? stringArrayField(item.metadata, 'acceptance')
                : undefined,
              failureConditions: isRecordPayload(item.metadata)
                ? stringArrayField(item.metadata, 'failure')
                : undefined,
            }];
          }),
        }];
      }),
    };
  }
  return undefined;
}

function finalizeNarrativeTurn(turn: WorkingAgentTimelineTurn): WorkingAgentTimelineTurn {
  const hasFailure = turn.blocks.some((block) => block.status === 'failed');
  const hasBlocked = turn.blocks.some((block) => block.status === 'blocked');
  const hasWaiting = turn.blocks.some((block) => block.status === 'waiting');
  const hasRunning = turn.blocks.some((block) => block.status === 'running');
  const hasAssistant = turn.blocks.some((block) => block.narrativeKind === 'assistantText');
  const status: AgentTimelineStatus = hasFailure
    ? 'failed'
    : hasBlocked
      ? 'blocked'
      : hasWaiting
        ? 'waiting'
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

function applyTurnAuthorityStates(
  turns: WorkingAgentTimelineTurn[],
  events: AgentEvent[],
  exactTargetTurnIds: readonly (string | undefined)[]
): void {
  const latestExactRunStateByTurnId = new Map<string, AgentEvent>();
  events.forEach((event, index) => {
    const turnId = exactTargetTurnIds[index];
    if (turnId && event.kind === 'session_run_state') {
      latestExactRunStateByTurnId.set(turnId, event);
    }
  });
  const authorities = events.flatMap((event, index) => {
    if (event.kind !== 'session_turn_authority' || !isRecordPayload(event.payload)) return [];
    const runId = stringField(event.payload, 'runId');
    const sourceMessageIds = stringArrayField(event.payload, 'sourceMessageIds');
    if (!runId || sourceMessageIds.length === 0) return [];
    return [{ index, runId, sourceMessageIds: new Set(sourceMessageIds) }];
  });
  if (authorities.length === 0) return;

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    if (turn.status !== 'completed') continue;
    const exactRunState = latestExactRunStateByTurnId.get(turn.id);
    if (exactRunState) {
      applyProjectedRunState(turns, turnIndex, exactRunState, events);
      continue;
    }
    const sourceMessageIds = new Set(turn.blocks.flatMap((block) => block.events.flatMap((event) => {
      if (event.kind !== 'user_msg') return [];
      const payload = isRecordPayload(event.payload) ? event.payload : {};
      return [event.id, stringField(payload, 'sourceEventId')].filter((value): value is string => Boolean(value));
    })));
    if (sourceMessageIds.size === 0) continue;
    const authority = [...authorities].reverse().find((candidate) =>
      [...sourceMessageIds].some((messageId) => candidate.sourceMessageIds.has(messageId))
    );
    if (!authority) continue;
    let latestRunState: AgentEvent | undefined;
    for (let eventIndex = events.length - 1; eventIndex >= authority.index; eventIndex -= 1) {
      const candidate = events[eventIndex];
      if (
        exactTargetTurnIds[eventIndex] !== undefined
        || candidate?.kind !== 'session_run_state'
        || !isRecordPayload(candidate.payload)
        || stringField(candidate.payload, 'runId') !== authority.runId
      ) {
        continue;
      }
      latestRunState = candidate;
      break;
    }
    applyProjectedRunState(turns, turnIndex, latestRunState, events);
  }
}

type ProjectedTurnSettlement =
  NonNullable<AgentTimelineResult['turns'][number]['settlement']>;
type ProjectedTurnExecutionEvidence =
  NonNullable<AgentTimelineResult['turns'][number]['executionEvidence']>;
type ProjectedTurnTaskClaim =
  ProjectedTurnExecutionEvidence['taskClaims'][number];

interface ProjectionFinalKernelEffectClaim {
  readonly taskId: string;
  readonly operationIds: string[];
  readonly workUnitIds: string[];
}

function applyTurnSettlementAndExecutionEvidence(
  turns: WorkingAgentTimelineTurn[],
  events: readonly AgentEvent[],
  exactTargetTurnIds: readonly (string | undefined)[],
  authorityIndex: ProjectionTurnAuthorityIndex
): void {
  const settlementByTurnId = new Map<string, {
    event: AgentEvent;
    turnAuthorityRef: string;
  }>();
  const executionEvidenceFactByTurnId = new Map<string, {
    event: AgentEvent;
    eventIndex: number;
    turnAuthorityRef: string;
  }>();

  events.forEach((event, eventIndex) => {
    const turnId = exactTargetTurnIds[eventIndex];
    if (!turnId) return;
    const payload = isRecordPayload(event.payload) ? event.payload : undefined;
    const lineage = parseSessionFactLineage(payload?.lineage);
    if (!lineage) {
      throw new Error(
        `session_shared_projection_invalid: fact_lineage_contract:${event.id}`
      );
    }
    if (isTerminalSessionRunState(event)) {
      settlementByTurnId.set(turnId, {
        event,
        turnAuthorityRef: lineage.turnAuthorityRef,
      });
    }
    if (
      isFinalAssistantExecutionEvidenceCandidate(event, payload)
      || isWaitingReviewExecutionEvidenceCandidate(event, payload)
    ) {
      executionEvidenceFactByTurnId.set(turnId, {
        event,
        eventIndex,
        turnAuthorityRef: lineage.turnAuthorityRef,
      });
    }
  });

  for (const turn of turns) {
    const settlement = settlementByTurnId.get(turn.id);
    if (settlement) {
      const status = projectedTurnSettlementStatus(settlement.event);
      if (!status) {
        throw new Error(
          `session_shared_projection_invalid: turn_settlement_status:${settlement.event.id}`
        );
      }
      turn.settlement = {
        schemaVersion: 'deepcode.session.turn-settlement.v1',
        status,
        factRef: eventRefForAgentEvent(settlement.event),
        turnAuthorityRef: settlement.turnAuthorityRef,
      };
    }

    const evidenceFact = executionEvidenceFactByTurnId.get(turn.id);
    if (!evidenceFact) continue;
    const evidence = projectedTurnExecutionEvidence(
      events,
      evidenceFact.eventIndex,
      evidenceFact.event,
      evidenceFact.turnAuthorityRef,
      authorityIndex
    );
    if (evidence) turn.executionEvidence = evidence;
  }
}

function isFinalAssistantExecutionEvidenceCandidate(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): boolean {
  return event.kind === 'assistant_msg'
    && stringField(payload ?? {}, 'channel') === 'final';
}

function isWaitingReviewExecutionEvidenceCandidate(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): boolean {
  return event.kind === 'review_summary'
    && stringField(payload ?? {}, 'status') === 'waitingUserReview'
    && (
      payload?.requiresKernelFacts !== undefined
      || payload?.kernelEffectClaims !== undefined
    );
}

function projectedTurnSettlementStatus(
  event: AgentEvent
): ProjectedTurnSettlement['status'] | undefined {
  const status = narrativeEventStatus(event);
  return status === 'waiting'
    || status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    ? status
    : undefined;
}

function projectedTurnExecutionEvidence(
  events: readonly AgentEvent[],
  eventIndex: number,
  event: AgentEvent,
  turnAuthorityRef: string,
  authorityIndex: ProjectionTurnAuthorityIndex
): ProjectedTurnExecutionEvidence | undefined {
  const payload = isRecordPayload(event.payload) ? event.payload : undefined;
  const lineage = parseSessionFactLineage(payload?.lineage);
  if (!payload || !lineage || lineage.turnAuthorityRef !== turnAuthorityRef) {
    throw new Error(
      `session_shared_projection_invalid: execution_evidence_lineage:${event.id}`
    );
  }
  if (payload.requiresKernelFacts === undefined) {
    if (event.kind === 'review_summary') {
      throw new Error(
        `session_shared_projection_invalid: review_execution_evidence_requirement:${event.id}`
      );
    }
    return undefined;
  }
  if (typeof payload.requiresKernelFacts !== 'boolean') {
    throw new Error(
      `session_shared_projection_invalid: execution_evidence_requirement:${event.id}`
    );
  }
  if (
    event.kind === 'review_summary'
    && payload.requiresKernelFacts !== true
  ) {
    throw new Error(
      `session_shared_projection_invalid: review_execution_evidence_requirement:${event.id}`
    );
  }

  const claims = projectionFinalKernelEffectClaims(
    payload.kernelEffectClaims,
    event.id
  );
  if (payload.requiresKernelFacts === false) {
    if (claims.length > 0 || lineage.kernelFactRefs.length > 0) {
      throw new Error(
        `session_shared_projection_invalid: execution_evidence_unclaimed:${event.id}`
      );
    }
    return {
      kind: 'notRequired',
      sourceFactRef: eventRefForAgentEvent(event),
      taskClaims: [],
    };
  }

  const authority = authorityIndex.byEventId.get(turnAuthorityRef);
  if (!authority) {
    throw new Error(
      `session_shared_projection_invalid: execution_evidence_authority:${event.id}:${turnAuthorityRef}`
    );
  }
  if (
    claims.length === 0
    || claims.some((claim) => claim.workUnitIds.length === 0)
    || lineage.kernelFactRefs.length === 0
  ) {
    throw new Error(
      `session_shared_projection_invalid: execution_evidence_incomplete:${event.id}`
    );
  }
  const payloadRunId = stringField(payload, 'runId');
  if (payloadRunId !== undefined && payloadRunId !== authority.runId) {
    throw new Error(
      `session_shared_projection_invalid: execution_evidence_run:${event.id}`
    );
  }

  const refsByTaskId = new Map<string, SessionKernelFactRefV1[]>(
    claims.map((claim) => [claim.taskId, []])
  );
  const seenKernelEventRefs = new Set<string>();
  for (const ref of lineage.kernelFactRefs) {
    if (
      seenKernelEventRefs.has(ref.kernelEventRef)
      || ref.runId !== authority.runId
      || !projectionTerminalOrEffectKernelFactKind(ref.kind)
    ) {
      throw new Error(
        `session_shared_projection_invalid: execution_evidence_kernel_ref:${event.id}:${ref.kernelEventRef}`
      );
    }
    seenKernelEventRefs.add(ref.kernelEventRef);

    const sourceIndexes = events.flatMap((candidate, candidateIndex) =>
      candidate.id === ref.kernelEventRef ? [candidateIndex] : []
    );
    if (
      sourceIndexes.length !== 1
      || sourceIndexes[0]! >= eventIndex
    ) {
      throw new Error(
        `session_shared_projection_invalid: execution_evidence_kernel_source:${event.id}:${ref.kernelEventRef}`
      );
    }
    let authoritativeRef: SessionKernelFactRefV1;
    try {
      authoritativeRef = kernelFactRefFromEvent({
        event: events[sourceIndexes[0]!]!,
        boundRunId: ref.runId,
      });
    } catch {
      throw new Error(
        `session_shared_projection_invalid: execution_evidence_kernel_source:${event.id}:${ref.kernelEventRef}`
      );
    }
    if (
      authoritativeRef.kind !== ref.kind
      || authoritativeRef.runId !== ref.runId
      || !projectionKernelFactRefFieldsMatch(ref, authoritativeRef)
    ) {
      throw new Error(
        `session_shared_projection_invalid: execution_evidence_kernel_identity:${event.id}:${ref.kernelEventRef}`
      );
    }

    const matchingClaims = claims.filter((claim) => (
      (ref.workUnitId !== undefined && claim.workUnitIds.includes(ref.workUnitId))
      || (ref.operationId !== undefined && claim.operationIds.includes(ref.operationId))
    ));
    if (matchingClaims.length !== 1) {
      throw new Error(
        `session_shared_projection_invalid: execution_evidence_kernel_claim:${event.id}:${ref.kernelEventRef}`
      );
    }
    refsByTaskId.get(matchingClaims[0]!.taskId)!.push(ref);
  }

  const taskClaims: ProjectedTurnTaskClaim[] = claims
    .map((claim) => {
      const refs = refsByTaskId.get(claim.taskId) ?? [];
      const missingWorkUnit = claim.workUnitIds.find((workUnitId) =>
        !refs.some((ref) => ref.workUnitId === workUnitId)
      );
      const missingOperation = claim.operationIds.find((operationId) =>
        !refs.some((ref) => ref.operationId === operationId)
      );
      if (refs.length === 0 || missingWorkUnit || missingOperation) {
        throw new Error(
          `session_shared_projection_invalid: execution_evidence_claim_incomplete:${event.id}:${claim.taskId}`
        );
      }
      return {
        taskId: claim.taskId,
        workUnitIds: [...claim.workUnitIds].sort(),
        factRefs: refs
          .map((ref) => `event:${ref.kernelEventRef}`)
          .sort(),
      };
    })
    .sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0);

  return {
    kind: 'kernelFactBacked',
    sourceFactRef: eventRefForAgentEvent(event),
    taskClaims,
  };
}

function projectionFinalKernelEffectClaims(
  value: unknown,
  eventId: string
): ProjectionFinalKernelEffectClaim[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `session_shared_projection_invalid: execution_evidence_claims:${eventId}`
    );
  }
  const taskIds = new Set<string>();
  const operationIds = new Set<string>();
  const workUnitIds = new Set<string>();
  return value.map((item) => {
    if (!isRecordPayload(item)) {
      throw new Error(
        `session_shared_projection_invalid: execution_evidence_claims:${eventId}`
      );
    }
    const taskId = projectionIdentity(item.taskId);
    const claimOperationIds = projectionIdentityArray(item.operationIds);
    const claimWorkUnitIds = projectionIdentityArray(item.workUnitIds);
    if (
      !taskId
      || !claimOperationIds
      || !claimWorkUnitIds
      || (claimOperationIds.length === 0 && claimWorkUnitIds.length === 0)
      || taskIds.has(taskId)
      || claimOperationIds.some((operationId) => operationIds.has(operationId))
      || claimWorkUnitIds.some((workUnitId) => workUnitIds.has(workUnitId))
    ) {
      throw new Error(
        `session_shared_projection_invalid: execution_evidence_claims:${eventId}`
      );
    }
    taskIds.add(taskId);
    claimOperationIds.forEach((operationId) => operationIds.add(operationId));
    claimWorkUnitIds.forEach((workUnitId) => workUnitIds.add(workUnitId));
    return {
      taskId,
      operationIds: claimOperationIds,
      workUnitIds: claimWorkUnitIds,
    };
  });
}

function projectionIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    ? value
    : undefined;
}

function projectionIdentityArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const identities = value.map(projectionIdentity);
  if (identities.some((identity) => identity === undefined)) return undefined;
  const normalized = identities as string[];
  return new Set(normalized).size === normalized.length
    ? normalized
    : undefined;
}

function projectionTerminalOrEffectKernelFactKind(
  kind: SessionKernelFactRefV1['kind']
): boolean {
  return kind === 'tool.effect_observed'
    || kind === 'tool.completed'
    || kind === 'work_unit.completed'
    || kind === 'review.facts_produced'
    || kind === 'review_gate.evaluated'
    || kind === 'run.completed'
    || kind === 'resource.cleanup_state_changed';
}

function projectionKernelFactRefFieldsMatch(
  ref: SessionKernelFactRefV1,
  authoritative: SessionKernelFactRefV1
): boolean {
  return ([
    'factId',
    'planActionId',
    'capabilityGrantId',
    'authorizationContractId',
    'operationId',
    'workUnitId',
  ] as const).every((field) =>
    ref[field] === undefined || ref[field] === authoritative[field]
  );
}

function applyProjectedRunState(
  turns: WorkingAgentTimelineTurn[],
  turnIndex: number,
  latestRunState: AgentEvent | undefined,
  events: AgentEvent[]
): void {
  const turn = turns[turnIndex]!;
  const runStatus = latestRunState ? narrativeEventStatus(latestRunState) : undefined;
  if (runStatus === 'failed') {
    turns[turnIndex] = {
      ...turn,
      status: 'failed',
      completedAt: latestRunState?.ts ?? turn.completedAt,
    };
    return;
  }
  if (runStatus === 'cancelled') {
    turns[turnIndex] = {
      ...turn,
      status: 'cancelled',
      completedAt: latestRunState?.ts ?? turn.completedAt,
    };
    return;
  }
  if (runStatus === 'completed') return;
  if (
    runStatus === 'waiting'
    && latestRunState
    && !runStateInteractionResolved(latestRunState, events)
  ) {
    turns[turnIndex] = {
      ...turn,
      status: 'waiting',
      completedAt: undefined,
    };
    return;
  }
  const hasFinalAssistant = turn.blocks.some((block) =>
    block.narrativeKind === 'assistantText'
  );
  if (!runStatus && hasFinalAssistant) return;
  turns[turnIndex] = {
    ...turn,
    status: 'running',
    completedAt: undefined,
  };
}

function stabilizeNarrativeBlockIds(turns: WorkingAgentTimelineTurn[]): void {
  for (const turn of turns) {
    const occurrences = new Map<string, number>();
    for (const block of turn.blocks) {
      const narrativeKind = block.narrativeKind ?? narrativeKindForLegacyKind(block.kind);
      const semanticIdentity = semanticNarrativeBlockIdentity(block);
      const base = semanticIdentity ?? `flow:${turn.id}:${narrativeKind}`;
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      block.id = semanticIdentity ? base : `${base}:${occurrence}`;
      if (block.taskProjectionRef) block.taskProjectionRef = `task:${block.id}`;
    }
  }
}

function semanticNarrativeBlockIdentity(block: WorkingAgentTimelineBlock): string | undefined {
  if (block.narrativeKind === 'user') {
    const projectedUserEvent = block.events.find((event) => event.kind === 'user_msg');
    const payload = projectedUserEvent && isRecordPayload(projectedUserEvent.payload)
      ? projectedUserEvent.payload
      : undefined;
    const sourceEventId = payload ? stringField(payload, 'sourceEventId') : undefined;
    if (sourceEventId) return `timeline:user-input:${sourceEventId}`;
  }

  const activityKey = narrativeActivityGroupKey(block.events);
  if (activityKey) return `timeline:${activityKey}`;

  const planCard = block.events.find((event) => event.kind === 'plan_card');
  if (planCard) {
    const payload = isRecordPayload(planCard.payload) ? planCard.payload : {};
    const runId = stringField(payload, 'runId') ?? 'run';
    const planId = stringField(payload, 'planId');
    if (planId) return `timeline:plan:${runId}:${planId}`;
  }
  const planDecision = block.events.find((event) => event.kind === 'plan_review');
  if (planDecision) {
    const payload = isRecordPayload(planDecision.payload) ? planDecision.payload : {};
    const runId = stringField(payload, 'runId') ?? 'run';
    const planId = stringField(payload, 'planId');
    if (planId) {
      return `timeline:plan-decision:${runId}:${planId}:${planDecision.id}`;
    }
  }

  for (const event of block.events) {
    const payload = isRecordPayload(event.payload) ? event.payload : {};
    const runId = stringField(payload, 'runId') ?? 'run';
    if (event.kind === 'review_summary') {
      const reviewId = stringField(payload, 'reviewId') ?? stringField(payload, 'sourcePlanId');
      if (reviewId) return `timeline:review:${runId}:${reviewId}`;
    }
    if (event.kind === 'requirement_confirmation' || event.kind === 'requirement_decision') {
      const requirementId = stringField(payload, 'requirementId');
      if (requirementId) return `timeline:requirement:${runId}:${requirementId}`;
    }
    if (event.kind === 'permission_request' || event.kind === 'permission_result') {
      const permissionId = stringField(payload, 'permissionId') ??
        stringField(payload, 'requestId') ??
        stringField(payload, 'id');
      if (permissionId) return `timeline:permission:${runId}:${permissionId}`;
    }
    if (event.kind === 'assistant_msg') {
      const proposalId = stringField(payload, 'proposalId');
      const channel = stringField(payload, 'channel');
      if (
        block.entryRole === 'finalAnswer' &&
        channel === 'final' &&
        event.id &&
        !event.id.startsWith('live:')
      ) {
        return `timeline:final:${event.id}`;
      }
      if (proposalId && channel) return `timeline:proposal:${proposalId}:${channel}`;
    }
  }
  return undefined;
}

function timelineBlockIdsByEventId(turns: WorkingAgentTimelineTurn[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const turn of turns) {
    for (const block of turn.blocks) {
      for (const event of block.events) result.set(event.id, block.id);
    }
  }
  return result;
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
    if (isRecordPayload(event.payload) && event.payload.diagnostic === true) return 'diagnostic';
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
  if (events.some((event) => event.kind === 'error' || narrativeEventStatus(event) === 'failed')) {
    return 'failed';
  }
  if (events.some((event) => event.kind === 'user_guidance')) {
    return events.some((event) => narrativeEventStatus(event) === 'consumed')
      ? 'completed'
      : 'queued';
  }
  if (events.some((event) => event.kind === 'permission_request') && !events.some((event) => event.kind === 'permission_result')) {
    return 'waiting';
  }
  if (events.some((event) => event.kind === 'session_run_state' && narrativeEventStatus(event) === 'waiting')) {
    return 'waiting';
  }
  if (
    events.some((event) =>
      event.kind === 'requirement_confirmation' &&
      narrativeEventStatus(event) === 'waitingUserConfirmation'
    ) &&
    !events.some((event) => event.kind === 'requirement_decision')
  ) {
    return 'waiting';
  }
  if (events.some((event) => planEventAwaitingDecision(event, events))) {
    return 'waiting';
  }
  if (events.some((event) => event.kind === 'tool_call' || narrativeEventStatus(event) === 'running')) {
    const hasCompletion = events.some((event) =>
      event.kind === 'tool_result' ||
      ['completed', 'done', 'ok', 'succeeded'].includes(narrativeEventStatus(event) ?? '')
    );
    if (!hasCompletion) return 'running';
  }
  return 'completed';
}

function narrativeEventStatus(event: AgentEvent): string | undefined {
  if (!isRecordPayload(event.payload)) return undefined;
  const kernelStatus = kernelEventTimelineStatus(event.payload);
  if (kernelStatus) return kernelStatus;
  return stringValueFromPayload(event.payload, 'status');
}

function kernelEventTimelineStatus(payload: Record<string, unknown>): AgentTimelineStatus | 'consumed' | undefined {
  const kind = kernelEventFromPayload(payload)?.kind;
  if (!kind) return undefined;
  if (
    kind === 'review_gate.evaluated' ||
    kind === 'review.facts_produced' ||
    kind === 'work_unit.completed' ||
    kind === 'tool.completed' ||
    kind === 'permission.resolved'
  ) return 'completed';
  if (kind === 'work_unit.failed') return 'failed';
  if (kind === 'work_unit.blocked') return 'blocked';
  if (kind === 'work_unit.started' || kind === 'work_unit.queued' || kind === 'tool.requested') return 'running';
  return undefined;
}

function resolveTimelineInteractionBlocks(
  turns: WorkingAgentTimelineTurn[],
  events: AgentEvent[]
): void {
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    for (const block of turn.blocks) {
      if (block.status !== 'waiting' && block.status !== 'blocked') continue;
      const resolved = block.events.some((event) => {
        if (event.kind === 'plan_card' || event.kind === 'plan_review') return planInteractionResolved(event, events);
        if (event.kind === 'review_summary') return reviewInteractionResolved(event, events);
        if (event.kind === 'requirement_confirmation') return requirementInteractionResolved(event, events);
        if (event.kind === 'session_run_state') return runStateInteractionResolved(event, events);
        return false;
      });
      if (!resolved) continue;
      block.status = 'completed';
      block.defaultCollapsed = narrativeDefaultCollapsed(block.narrativeKind ?? 'operationEvidence', 'completed');
    }
    turns[turnIndex] = finalizeNarrativeTurn(turn);
  }
}

function runStateInteractionResolved(event: AgentEvent, events: AgentEvent[]): boolean {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  if (stringField(payload, 'status') !== 'waiting') return false;
  const ownerKind = runStateInteractionOwnerKind(payload);
  if (ownerKind !== 'plan' && ownerKind !== 'review' && ownerKind !== 'requirement') return false;
  const activeInteraction = findActiveInteraction({ events });
  if (!activeInteraction) return true;
  return !sameRunStateInteractionOwner(activeInteraction, payload, ownerKind);
}

function sameRunStateInteractionOwner(
  activeInteraction: InteractionLedgerActiveInteraction,
  payload: Record<string, unknown>,
  ownerKind: 'plan' | 'review' | 'requirement'
): boolean {
  const owner = isRecordPayload(payload.decisionOwner) ? payload.decisionOwner : {};
  const runId = stringField(payload, 'runId') ?? stringField(owner, 'runId');
  if (ownerKind === 'plan') {
    if (activeInteraction.kind !== 'plan') return false;
    if (runId && activeInteraction.runId !== runId) return false;
    const planId = runStateInteractionOwnerId(payload, owner, 'plan');
    if (planId && activeInteraction.planId !== planId) return false;
    return Boolean(runId || planId);
  }
  if (ownerKind === 'requirement') {
    if (activeInteraction.kind !== 'requirement') return false;
    if (runId && activeInteraction.runId !== runId) return false;
    const requirementId = runStateInteractionOwnerId(payload, owner, 'requirement');
    if (requirementId && activeInteraction.requirementId !== requirementId) return false;
    return Boolean(runId || requirementId);
  }
  if (activeInteraction.kind !== 'review') return false;
  if (runId && activeInteraction.runId !== runId) return false;
  const reviewId = runStateInteractionOwnerId(payload, owner, 'review');
  return Boolean(runId || reviewId);
}

function runStateInteractionOwnerKind(payload: Record<string, unknown>): string | undefined {
  const owner = isRecordPayload(payload.decisionOwner) ? payload.decisionOwner : undefined;
  return stringField(payload, 'decisionKind') ?? (owner ? stringField(owner, 'kind') : undefined);
}

function runStateInteractionOwnerId(
  payload: Record<string, unknown>,
  owner: Record<string, unknown>,
  ownerKind: 'plan' | 'review' | 'requirement'
): string | undefined {
  if (ownerKind === 'plan') {
    return stringField(payload, 'planId') ??
      stringField(payload, 'sourcePlanId') ??
      stringField(payload, 'targetId') ??
      stringField(owner, 'planId') ??
      stringField(owner, 'targetId');
  }
  if (ownerKind === 'requirement') {
    return stringField(payload, 'requirementId') ??
      stringField(payload, 'targetId') ??
      stringField(owner, 'requirementId') ??
      stringField(owner, 'targetId');
  }
  return stringField(payload, 'reviewId') ??
    stringField(payload, 'targetId') ??
    stringField(owner, 'reviewId') ??
    stringField(owner, 'targetId');
}

function planInteractionResolved(event: AgentEvent, events: AgentEvent[]): boolean {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const runId = stringField(payload, 'runId');
  const planId = stringField(payload, 'planId');
  if (!runId || !planId) return false;
  return events.some((candidate) => {
    const candidatePayload = isRecordPayload(candidate.payload) ? candidate.payload : {};
    if (!decisionStatusResolved(stringField(candidatePayload, 'status'))) return false;
    if (candidate.kind === 'plan_review' || candidate.kind === 'review_summary') {
      return samePlanDecision(candidatePayload, runId, planId);
    }
    if (candidate.kind !== 'session_run_state') return false;
    return samePlanDecision(candidatePayload, runId, planId) &&
      runStatusResolved(stringField(candidatePayload, 'status'));
  });
}

function planEventAwaitingDecision(event: AgentEvent, events: AgentEvent[]): boolean {
  const awaiting = (event.kind === 'plan_card' || event.kind === 'plan_review') &&
    planInteractionAwaitsDecision(isRecordPayload(event.payload) ? event.payload : {});
  return awaiting && !planInteractionResolved(event, events);
}

function reviewInteractionResolved(event: AgentEvent, events: AgentEvent[]): boolean {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  if (stringField(payload, 'status') !== 'waitingUserReview') return false;
  const runId = stringField(payload, 'runId');
  const reviewId = stringField(payload, 'reviewId');
  const sourcePlanId = stringField(payload, 'sourcePlanId');
  if (!runId) return false;
  return events.some((candidate) => {
    const candidatePayload = isRecordPayload(candidate.payload) ? candidate.payload : {};
    if (candidate.kind === 'review_summary') {
      if (!decisionStatusResolved(stringField(candidatePayload, 'status'))) return false;
      if (stringField(candidatePayload, 'runId') !== runId) return false;
      const candidateReviewId = stringField(candidatePayload, 'reviewId');
      const candidateSourcePlanId = stringField(candidatePayload, 'sourcePlanId');
      if (reviewId) return candidateReviewId === reviewId;
      if (sourcePlanId) return candidateSourcePlanId === sourcePlanId;
      return true;
    }
    if (candidate.kind !== 'session_run_state') return false;
    if (stringField(candidatePayload, 'runId') !== runId) return false;
    return runStatusResolved(stringField(candidatePayload, 'status'));
  });
}

function requirementInteractionResolved(event: AgentEvent, events: AgentEvent[]): boolean {
  const payload = isRecordPayload(event.payload) ? event.payload : {};
  const runId = stringField(payload, 'runId');
  const requirementId = stringField(payload, 'requirementId');
  if (!runId || !requirementId) return false;
  return events.some((candidate) => {
    if (candidate.kind !== 'requirement_decision') return false;
    const candidatePayload = isRecordPayload(candidate.payload) ? candidate.payload : {};
    if (!decisionStatusResolved(stringField(candidatePayload, 'status'))) return false;
    return stringField(candidatePayload, 'runId') === runId &&
      stringField(candidatePayload, 'requirementId') === requirementId;
  });
}

function decisionStatusResolved(status?: string): boolean {
  return status === 'accepted' ||
    status === 'rejected' ||
    status === 'needsRevision' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'completed';
}

function runStatusResolved(status?: string): boolean {
  return status === 'completed' ||
    status === 'cancelled' ||
    status === 'failed';
}

function narrativeTitle(
  events: AgentEvent[],
  kind: AgentTimelineNarrativeKind,
  binding: ProjectionLanguageBinding
): string {
  const first = events[0];
  const language = binding.language;
  if (kind === 'user') {
    return localizedProjectionText(language, {
      zh: '用户',
      en: 'User',
      neutral: 'User',
    });
  }
  if (first.kind === 'user_guidance') {
    return localizedProjectionText(language, {
      zh: '用户补充',
      en: 'User guidance',
      neutral: 'User guidance',
    });
  }
  if (kind === 'assistantText') return 'DeepCode';
  if (kind === 'assistantNarration') return 'DeepCode';
  if (kind === 'thinking') {
    return localizedProjectionText(language, {
      zh: '分析',
      en: 'Analysis',
      neutral: 'Analysis',
    });
  }
  if (kind === 'operationEvidence') {
    return firstNonEmpty(events, ['summary', 'toolName', 'name', 'stage'])
      ?? localizedProjectionText(language, {
        zh: '操作证据',
        en: 'Operation evidence',
        neutral: 'Operation evidence',
      });
  }
  if (kind === 'requirement') {
    return firstNonEmpty(events, ['title', 'summary'])
      ?? localizedProjectionText(language, {
        zh: '需求',
        en: 'Requirement',
        neutral: 'Requirement',
      });
  }
  if (kind === 'plan') {
    return firstNonEmpty(events, ['title', 'summary'])
      ?? localizedProjectionText(language, {
        zh: '计划',
        en: 'Plan',
        neutral: 'Plan',
      });
  }
  if (kind === 'permission') {
    return firstNonEmpty(events, ['summary', 'toolName'])
      ?? localizedProjectionText(language, {
        zh: '权限',
        en: 'Permission',
        neutral: 'Permission',
      });
  }
  if (kind === 'verification') {
    return firstNonEmpty(events, ['summary'])
      ?? localizedProjectionText(language, {
        zh: '验证',
        en: 'Verification',
        neutral: 'Verification',
      });
  }
  if (kind === 'review') {
    return firstNonEmpty(events, ['title'])
      ?? localizedProjectionText(language, {
        zh: '复核',
        en: 'Review',
        neutral: 'Review',
      });
  }
  return firstNonEmpty([first], ['summary', 'message', 'details'])
    ?? localizedProjectionText(language, {
      zh: '诊断',
      en: 'Diagnostic',
      neutral: 'Diagnostic',
    });
}

function summarizeAgentEvents(
  events: AgentEvent[],
  binding: ProjectionLanguageBinding
): string {
  const summaries = events
    .map((event) => firstNonEmpty([event], ['summary', 'message', 'content', 'details', 'toolName', 'name', 'stage']))
    .filter((value): value is string => Boolean(value));
  if (summaries.length === 0) {
    return localizedProjectionText(binding.language, {
      zh: `${events.length} 个事件`,
      en: `${events.length} event${events.length === 1 ? '' : 's'}`,
      neutral: `eventCount=${events.length}`,
    });
  }
  if (summaries.length === 1) return trimProjectionText(summaries[0], 180);
  return trimProjectionText(summaries.join(' / '), 220);
}

function narrativeBody(events: AgentEvent[], kind: AgentTimelineNarrativeKind): string | undefined {
  if (kind === 'operationEvidence') return undefined;
  if (kind === 'plan') return undefined;
  if (kind === 'review') {
    if (narrativeStructuredProjection(events, kind)) return undefined;
    const text = events.map(reviewEventBody).find((value) => value.trim().length > 0);
    return text?.trim() || undefined;
  }
  if (kind === 'thinking') {
    const reasoning = events.map(reasoningEventBody).join('').trim();
    return reasoning || undefined;
  }
  if (kind === 'diagnostic') {
    const text = firstNonEmpty(events, ['userMessage', 'message', 'summary']);
    return text?.trim() ? text : undefined;
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

function narrativeDefaultCollapsed(kind: AgentTimelineNarrativeKind, status: AgentTimelineStatus): boolean {
  if (status === 'running' || status === 'waiting') return false;
  if (kind === 'assistantNarration') return false;
  return kind === 'thinking' ||
    kind === 'operationEvidence' ||
    kind === 'permission' ||
    (kind === 'plan' && status === 'completed');
}

function narrativeDisplayHints(
  kind: AgentTimelineNarrativeKind,
  title: string,
  summary: string
): AgentTimelineBlock['displayHints'] {
  return {
    density: kind === 'operationEvidence' ? 'compact' : 'normal',
    evidenceMode: kind === 'operationEvidence' ? 'collapsed' : 'inline',
    collapseAfterComplete: kind === 'thinking' || kind === 'operationEvidence',
    checkpointKind: narrativeCheckpointKind(kind),
    showInTaskList: shouldShowNarrativeInTaskList(kind),
    taskListLabel: title,
    taskListSummary: summary,
  };
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
  const activities: AgentConversationActivity[] = [];
  for (const event of events) {
    const payload = isRecordPayload(event.payload) ? event.payload : undefined;
    const activity = payload ? activityFromValue(payload.activity) : undefined;
    if (activity) activities.push(activity);
  }
  const latest = activities[activities.length - 1];
  if (!latest) return undefined;
  const matching = activities.filter((activity) => activity.activityId === latest.activityId);
  const resourcePacketIds: string[] = [];
  let resourceItemCount = 0;
  let hasResourceItemCount = false;
  for (const activity of matching) {
    const newPacketIds = (activity.resourcePacketIds ?? [])
      .filter((packetId) => !resourcePacketIds.includes(packetId));
    if (newPacketIds.length > 0) {
      resourcePacketIds.push(...newPacketIds);
      if (activity.itemCount !== undefined) {
        resourceItemCount += activity.itemCount;
        hasResourceItemCount = true;
      }
    }
  }
  return {
    ...latest,
    activityRevision: Math.max(
      ...matching.map((activity) => activity.activityRevision ?? 0)
    ) || undefined,
    runId: latest.runId ?? matching.find((activity) => activity.runId)?.runId,
    planId: latest.planId ?? matching.find((activity) => activity.planId)?.planId,
    draftId: latest.draftId ?? matching.find((activity) => activity.draftId)?.draftId,
    targets: uniqueActivityStrings(matching.flatMap((activity) => activity.targets ?? [])),
    actionIds: uniqueActivityStrings(matching.flatMap((activity) => activity.actionIds ?? [])),
    workUnitIds: uniqueActivityStrings(matching.flatMap((activity) => activity.workUnitIds ?? [])),
    resourcePacketIds,
    toolName: latest.toolName ?? matching.find((activity) => activity.toolName)?.toolName,
    operation: latest.operation ?? matching.find((activity) => activity.operation)?.operation,
    itemCount: hasResourceItemCount ? resourceItemCount : latest.itemCount,
  };
}

function uniqueActivityStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
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
    activityRevision: numberField(value, 'activityRevision'),
    kind: kind as AgentConversationActivity['kind'],
    status,
    title,
    summary,
    source,
    runId: stringField(value, 'runId'),
    planId: stringField(value, 'planId'),
    draftId: stringField(value, 'draftId'),
    targets: stringArrayField(value, 'targets'),
    actionIds: stringArrayField(value, 'actionIds'),
    workUnitIds: stringArrayField(value, 'workUnitIds'),
    resourcePacketIds: stringArrayField(value, 'resourcePacketIds'),
    toolName: stringField(value, 'toolName'),
    operation: stringField(value, 'operation'),
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
    value === 'cancelled' ||
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

// reasoning channel 的 assistant_msg 若正文为空或仅含空代码围栏，则视为空块，不进入时间线。
function isBlankReasoningEvent(event: AgentEvent): boolean {
  if (stringValueFromPayload(event.payload, 'channel') !== 'reasoning') return false;
  const body = reasoningEventBody(event);
  return body.replace(/```+/g, '').trim().length === 0;
}

// 在此索引之前的 operationEvidence / thinking 视为 explore 阶段，之后为 execute 阶段。
function findFirstAcceptedReviewIndex(events: AgentEvent[]): number {
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.kind !== 'plan_review') continue;
    if (stringValueFromPayload(event.payload, 'status') === 'accepted') return i;
  }
  return -1;
}

function annotateBlocksWithPhase(
  turns: WorkingAgentTimelineTurn[],
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
      if (block.entryRole === 'finalAnswer' && block.durability === 'committed') continue;
      const firstEventId = block.events[0]?.id;
      if (!firstEventId) continue;
      const idx = idToIndex.get(firstEventId);
      if (idx === undefined) continue;
      const phase: 'explore' | 'execute' = idx < acceptedIndex ? 'explore' : 'execute';
      block.displayHints = { ...(block.displayHints ?? {}), phase };
    }
  }
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

function positiveIntegerField(
  value: Record<string, unknown>,
  key: string
): number | undefined {
  const field = numberField(value, key);
  return field !== undefined && Number.isSafeInteger(field) && field > 0
    ? field
    : undefined;
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

  if (input.kernelProposalReview) {
    const report = input.kernelProposalReview;
    const permissionBundles = report?.executionContract.permissionBundles ?? [];
    const interventions = report?.executionContract.interventions ?? [];
    const reportSummary = interventions[0]?.summary
      ?? report?.diagnostics[0]
      ?? (report ? `Kernel execution contract status=${report.status}.` : undefined);
    cards.push(
      conversationCard(input, createdAt, {
        kind: 'check_review',
        title: '计划确认',
        summary:
          reportSummary ??
          '等待 Kernel ProposalReview 和用户计划确认；权限只作为预览，真实授权在执行前触发。',
        status: report?.status,
        facts: report
          ? [
              `状态：${report.status}`,
              `所需权限：${report.requiredPermissions.join(', ') || '无'}`,
              `权限组：${permissionBundles.map((bundle) => bundle.capability).join(', ') || '无'}`,
              `门禁介入：${interventions.map((item) => item.summary).join(', ') || '无'}`,
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
      const request = safePermissionRequestView(event.payload);
      if (request && !resolved.has(request.id)) return { request };
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
  const payload = isRecordPayload(event.payload) ? event.payload : undefined;
  const kernelEvent = payload ? kernelEventFromPayload(payload) : undefined;
  return kernelEvent?.kind === 'permission.resolved'
    ? kernelEvent.permissionId
    : undefined;
}

function permissionRequestFromKernelWorkflowStage(
  event: AgentEvent
): AgentTimelinePermissionRequestView | null {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : undefined;
  if (!payload?.kernelEvent) return null;
  const kernelEvent = decodeKernelEventV1(event);
  if (kernelEvent.kind !== 'permission.requested') return null;
  const request = kernelEvent.request;
  return safePermissionRequestView({
    id: request.id,
    runId: kernelEvent.runId,
    requestKind: request.requestKind,
    permissionBundleId: request.permissionBundleId,
    contractId: request.contractId,
    affectedOperationIds: request.affectedOperationIds,
    workUnitIds: request.workUnitIds,
    toolId: request.toolId,
    toolName: request.toolId ?? request.capability,
    riskLevel: request.riskLevel,
    summary: request.summary,
    argumentsPreview: request.argsPreview,
  });
}

function kernelEventFromPayload(payload: Record<string, unknown>) {
  if (!isRecordPayload(payload.kernelEvent)) return undefined;
  return decodeKernelEventV1({ payload });
}

function safePermissionRequestView(value: unknown): AgentTimelinePermissionRequestView | null {
  if (!isRecordPayload(value)) return null;
  const id = stringField(value, 'id');
  const toolName = stringField(value, 'toolName');
  const riskLevel = stringField(value, 'riskLevel');
  const summary = stringField(value, 'summary');
  if (!id || !toolName || !summary || !permissionRiskLevel(riskLevel)) return null;
  const requestKind = stringField(value, 'requestKind');
  const argumentsPreview = stringField(value, 'argumentsPreview');
  return {
    id,
    runId: stringField(value, 'runId'),
    requestKind: requestKind === 'runtimePermission' || requestKind === 'scopeExpansion'
      ? requestKind
      : undefined,
    permissionBundleId: stringField(value, 'permissionBundleId'),
    contractId: stringField(value, 'contractId'),
    affectedOperationIds: stringArrayField(value, 'affectedOperationIds'),
    workUnitIds: stringArrayField(value, 'workUnitIds'),
    toolId: stringField(value, 'toolId'),
    toolName,
    riskLevel,
    summary,
    diff: stringField(value, 'diff'),
    argumentsPreview: argumentsPreview?.slice(0, 2_000),
  };
}

function permissionRiskLevel(
  value: string | undefined
): value is AgentTimelinePermissionRequestView['riskLevel'] {
  return value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'critical';
}
