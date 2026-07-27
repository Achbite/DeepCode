import type {
  AgentEvent,
  AgentTimelineBlock,
  AgentTimelineDeliveryMode,
  AgentTimelineDelta,
  AgentTimelineResult,
  AgentTimelineSnapshot,
  AgentTimelineStatus,
  LegacyAgentTimelineResultV1,
  ProjectionDelta,
} from '@deepcode/protocol';
import { canonicalJson } from './cache/canonicalizer.js';
import {
  assertSharedConversationProjectionV2,
  buildNarrativeTimelineProjection,
  buildTimelineProjectionWithLiveOverlay,
  isSharedConversationBlockV2,
  isSharedConversationProjectionV2,
} from './projection.js';

const TIMELINE_DELTA_SCHEMA_VERSION =
  'deepcode.shared-conversation-projection-delta.v2' as const;

export interface CanonicalTimelineCommitResult {
  timeline: AgentTimelineResult;
  deltas: AgentTimelineDelta[];
}

export interface PreparedCanonicalTimelineCommit extends CanonicalTimelineCommitResult {
  readonly baseRevision: number;
  readonly events: readonly AgentEvent[];
}

export interface AgentTimelineDeltaApplyResult {
  timeline: AgentTimelineResult;
  status: 'applied' | 'duplicate' | 'stale' | 'gap';
}

export class CanonicalTimelineProjector {
  private committedEvents: AgentEvent[];
  private auxiliaryEvents: AgentEvent[];
  private activeDeltas: ProjectionDelta[] = [];
  private currentTimeline: AgentTimelineResult;

  constructor(
    private readonly sessionId: string,
    initialEvents: AgentEvent[],
    initialTimeline?: AgentTimelineSnapshot,
    initialAuxiliaryEvents: AgentEvent[] = []
  ) {
    this.committedEvents = [...initialEvents];
    this.auxiliaryEvents = deduplicateAuxiliaryEvents(initialAuxiliaryEvents);
    const normalizedInitialTimeline = initialTimeline?.sessionId === sessionId
      ? normalizeAgentTimelineSnapshot(initialTimeline, initialEvents).timeline
      : undefined;
    const compatibleInitialTimeline = normalizedInitialTimeline?.eventCount === initialEvents.length &&
      normalizedInitialTimeline.sourceEventVersion === initialEvents.length
      ? normalizedInitialTimeline
      : undefined;
    this.currentTimeline = compatibleInitialTimeline
      ? compatibleInitialTimeline
        : stampTimeline(
          buildNarrativeTimelineProjection({
            sessionId,
            events: initialEvents,
            auxiliaryEvents: this.auxiliaryEvents,
          }),
          undefined,
          0
        );
  }

  rememberAuxiliaryEvents(events: readonly AgentEvent[]): void {
    if (events.length === 0) return;
    this.auxiliaryEvents = deduplicateAuxiliaryEvents([
      ...this.auxiliaryEvents,
      ...events,
    ]);
  }

  push(delta: ProjectionDelta): AgentTimelineDelta[] {
    if (delta.sessionId !== this.sessionId || delta.type === 'committed') return [];
    this.activeDeltas = mergeProjectionDelta(this.activeDeltas, delta);
    const nextSemantic = buildTimelineProjectionWithLiveOverlay({
      sessionId: this.sessionId,
      committedEvents: this.committedEvents,
      auxiliaryEvents: this.auxiliaryEvents,
      activeDeltas: this.activeDeltas,
    });
    const next = stampTimeline(nextSemantic, this.currentTimeline, (this.currentTimeline.revision ?? 0) + 1);
    const deltas = diffTimelines(this.currentTimeline, next, delta.runId ?? 'run', 'live');
    if (deltas.length > 0) this.currentTimeline = next;
    return deltas;
  }

  commit(events: AgentEvent[]): CanonicalTimelineCommitResult {
    return this.acceptPreparedCommit(this.prepareCommit(events));
  }

  prepareCommit(events: AgentEvent[]): PreparedCanonicalTimelineCommit {
    const previous = this.currentTimeline;
    const committed = stampTimeline(
      buildNarrativeTimelineProjection({
        sessionId: this.sessionId,
        events,
        auxiliaryEvents: this.auxiliaryEvents,
      }),
      previous,
      (previous.revision ?? 0) + 1
    );
    if (!preservesCommittedFinals(previous, committed)) {
      throw new Error('session_projection_final_committed_immutable');
    }
    const runId = latestRunId(events) ?? 'run';
    const deliveryModes = committedDeliveryModes(previous, committed);
    const deltas = [
      ...diffTimelines(previous, committed, runId, 'buffered'),
      timelineSyncedDelta(committed, runId, deliveryModes),
    ];
    return {
      timeline: committed,
      deltas,
      baseRevision: previous.revision ?? 0,
      events: [...events],
    };
  }

  prepareRecoveredCommit(
    events: AgentEvent[],
    acknowledgedTimeline: AgentTimelineResult
  ): PreparedCanonicalTimelineCommit {
    assertSharedConversationProjectionV2(acknowledgedTimeline);
    if (
      acknowledgedTimeline.sessionId !== this.sessionId ||
      acknowledgedTimeline.eventCount !== events.length ||
      acknowledgedTimeline.sourceEventVersion !== events.length
    ) {
      throw new Error('session_projection_recovery_identity_mismatch');
    }
    const previous = this.currentTimeline;
    if (
      (acknowledgedTimeline.revision ?? 0) < (previous.revision ?? 0) ||
      (
        (acknowledgedTimeline.revision ?? 0) === (previous.revision ?? 0) &&
        canonicalJson(acknowledgedTimeline) !== canonicalJson(previous)
      )
    ) {
      throw new Error('session_projection_recovery_revision_stale');
    }
    if (!preservesCommittedFinals(previous, acknowledgedTimeline)) {
      throw new Error('session_projection_final_committed_immutable');
    }
    const runId = latestRunId(events) ?? 'run';
    const deliveryModes = committedDeliveryModes(previous, acknowledgedTimeline);
    return {
      timeline: acknowledgedTimeline,
      deltas: [
        ...diffTimelines(previous, acknowledgedTimeline, runId, 'buffered'),
        timelineSyncedDelta(acknowledgedTimeline, runId, deliveryModes),
      ],
      baseRevision: previous.revision ?? 0,
      events: [...events],
    };
  }

  acceptPreparedCommit(
    prepared: PreparedCanonicalTimelineCommit
  ): CanonicalTimelineCommitResult {
    if ((this.currentTimeline.revision ?? 0) !== prepared.baseRevision) {
      throw new Error('session_projection_commit_stale');
    }
    return this.acceptAcknowledgedCommit(prepared);
  }

  acceptAcknowledgedCommit(
    prepared: PreparedCanonicalTimelineCommit
  ): CanonicalTimelineCommitResult {
    this.committedEvents = [...prepared.events];
    this.activeDeltas = [];
    const committed = prepared.timeline;
    this.currentTimeline = committed;
    return { timeline: committed, deltas: prepared.deltas };
  }

  snapshot(): AgentTimelineResult {
    return this.currentTimeline;
  }
}

function deduplicateAuxiliaryEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of events) {
    if (!event.id.trim()) continue;
    byId.set(event.id, event);
  }
  return [...byId.values()];
}

export interface NormalizedAgentTimelineSnapshot {
  timeline: AgentTimelineResult;
  compatibility: 'nativeV2' | 'legacyV1ReadOnly';
}

export function normalizeAgentTimelineSnapshot(
  snapshot: AgentTimelineSnapshot,
  sourceEvents: AgentEvent[] = []
): NormalizedAgentTimelineSnapshot {
  if (snapshot.schemaVersion === 'deepcode.shared-conversation-projection.v2') {
    assertSharedConversationProjectionV2(snapshot);
    return { timeline: snapshot, compatibility: 'nativeV2' };
  }

  const rebuilt = sourceEvents.length > 0
    ? buildNarrativeTimelineProjection({
        sessionId: snapshot.sessionId,
        events: sourceEvents,
        generatedAt: snapshot.generatedAt,
      })
    : adaptLegacyTimelineV1(snapshot);
  const timeline: AgentTimelineResult = {
      ...rebuilt,
      revision: snapshot.revision ?? rebuilt.revision ?? 0,
      lastDeltaSeq: snapshot.lastDeltaSeq ?? rebuilt.lastDeltaSeq ?? 0,
      interactionProjection: undefined,
      turns: rebuilt.turns.map((turn) => ({
        ...turn,
        blocks: turn.blocks.map((block) => block.entryRole === 'interaction'
          ? {
              ...block,
              interaction: block.interaction
                ? { ...block.interaction, state: 'expired' }
                : undefined,
              confirmable: false,
            }
          : block),
      })),
  };
  assertSharedConversationProjectionV2(timeline);
  return { timeline, compatibility: 'legacyV1ReadOnly' };
}

/**
 * Rebuild a stale native v2 snapshot from the durable Session events while
 * preserving its acknowledged history and advancing its revision. This is a
 * recovery primitive, not a legacy migration path.
 */
export function rebuildSharedConversationProjectionV2(
  sessionId: string,
  sourceEvents: AgentEvent[],
  staleSnapshot: AgentTimelineSnapshot,
  minimumRevision = (staleSnapshot.revision ?? 0) + 1
): AgentTimelineResult {
  if (
    staleSnapshot.schemaVersion !== 'deepcode.shared-conversation-projection.v2' ||
    staleSnapshot.sessionId !== sessionId
  ) {
    throw new Error('session_projection_repair_native_v2_required');
  }
  assertSharedConversationProjectionV2(staleSnapshot);
  const rebuilt = stampTimeline(
    buildNarrativeTimelineProjection({
      sessionId,
      events: sourceEvents,
    }),
    staleSnapshot,
    Math.max((staleSnapshot.revision ?? 0) + 1, minimumRevision)
  );
  if (!preservesCommittedFinals(staleSnapshot, rebuilt)) {
    throw new Error('session_projection_final_committed_immutable');
  }
  assertSharedConversationProjectionV2(rebuilt);
  return rebuilt;
}

function adaptLegacyTimelineV1(snapshot: LegacyAgentTimelineResultV1): AgentTimelineResult {
  return {
    schemaVersion: 'deepcode.shared-conversation-projection.v2',
    sessionId: snapshot.sessionId,
    revision: snapshot.revision ?? 0,
    sourceEventVersion: snapshot.eventCount,
    lastDeltaSeq: snapshot.lastDeltaSeq ?? 0,
    generatedAt: snapshot.generatedAt,
    eventCount: snapshot.eventCount,
    turns: snapshot.turns.map((turn) => ({
      id: turn.id,
      sequence: turn.sequence,
      sessionId: snapshot.sessionId,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      blocks: turn.blocks.flatMap((block) => {
        const legacyEvents = Array.isArray(block.events) ? block.events : [];
        if (
          block.kind === 'thinking' ||
          block.narrativeKind === 'thinking' ||
          legacyEvents.some(isLegacyRawReasoningEvent)
        ) {
          return [];
        }
        const entryRole = block.entryRole ?? legacyEntryRole(block.narrativeKind);
        const sourceEventRefs = legacyEvents.map((event) => `event:${event.id}`);
        return [{
          id: block.id,
          sequence: block.sequence,
          revision: block.revision,
          deliveryMode: 'replay' as const,
          kind: block.kind,
          narrativeKind: block.narrativeKind,
          entryRole,
          durability: 'committed' as const,
          title: block.title,
          summary: block.summary,
          status: block.status,
          defaultCollapsed: block.defaultCollapsed,
          bodyMarkdown: block.bodyMarkdown,
          localizedContent: block.localizedContent
            ? {
                text: block.localizedContent.text,
                messageKey: block.localizedContent.messageKey,
                messageArgs: block.localizedContent.messageArgs,
              }
            : undefined,
          evidenceRefs: block.evidenceRefs,
          languageBinding: block.languageBinding ?? {
            language: 'neutral' as const,
            status: 'unavailable' as const,
          },
          provenance: {
            origin: block.provenance?.origin ?? legacyBlockOrigin(entryRole),
            authority: block.provenance?.authority ?? legacyBlockAuthority(entryRole),
            sourceEventRefs,
            factRefs: block.provenance?.factRefs ?? [],
            evidenceRefs: block.provenance?.evidenceRefs ?? block.evidenceRefs ?? [],
          },
          confirmable: false,
          taskProjectionRef: block.taskProjectionRef,
        } satisfies AgentTimelineBlock];
      }),
    })),
  };
}

function legacyEntryRole(
  narrativeKind: AgentTimelineBlock['narrativeKind']
): NonNullable<AgentTimelineBlock['entryRole']> {
  switch (narrativeKind) {
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
    default: return 'diagnostic';
  }
}

function legacyBlockOrigin(
  entryRole: NonNullable<AgentTimelineBlock['entryRole']>
): NonNullable<AgentTimelineBlock['provenance']>['origin'] {
  if (entryRole === 'userMessage') return 'user';
  if (entryRole === 'activityGroup' || entryRole === 'evidence') return 'kernel';
  return 'session';
}

function legacyBlockAuthority(
  entryRole: NonNullable<AgentTimelineBlock['entryRole']>
): NonNullable<AgentTimelineBlock['provenance']>['authority'] {
  if (entryRole === 'userMessage') return 'user';
  if (entryRole === 'activityGroup' || entryRole === 'evidence') return 'kernel';
  return 'session';
}

function isLegacyRawReasoningEvent(event: AgentEvent): boolean {
  const eventKind = event.kind as string;
  if (eventKind === 'reasoning_delta' || eventKind === 'provider_reasoning_delta') {
    return true;
  }
  if (!isRecord(event.payload)) return false;
  return event.payload.channel === 'reasoning'
    || event.payload.channel === 'thinking'
    || event.payload.reasoningTrace === true;
}

export function isAgentTimelineDelta(value: unknown): value is AgentTimelineDelta {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== TIMELINE_DELTA_SCHEMA_VERSION ||
    typeof value.op !== 'string'
  ) {
    return false;
  }
  if (
    !nonemptyString(value.sessionId) ||
    !nonemptyString(value.runId)
  ) {
    return false;
  }
  if (
    !nonemptyString(value.turnId) ||
    !projectionNonnegativeInteger(value.turnSeq)
  ) {
    return false;
  }
  if (
    !nonemptyString(value.blockId) ||
    !projectionNonnegativeInteger(value.blockSeq)
  ) {
    return false;
  }
  if (
    !projectionNonnegativeInteger(value.revision) ||
    (value.deltaSeq !== undefined && !projectionNonnegativeInteger(value.deltaSeq)) ||
    (value.sourceEventRefs !== undefined && !stringArray(value.sourceEventRefs)) ||
    containsPrivateDeltaPayload(value)
  ) {
    return false;
  }
  switch (value.op) {
    case 'timeline.synced':
      return hasOnlyDeltaKeys(value, ['timeline', 'deliveryModes']) &&
        isSharedConversationProjectionV2(value.timeline) &&
        value.timeline.sessionId === value.sessionId &&
        value.timeline.revision === value.revision &&
        (value.deliveryModes === undefined || isDeliveryModeRecord(value.deliveryModes));
    case 'block.started':
      return hasOnlyDeltaKeys(value, ['block', 'deliveryMode']) &&
        isSharedConversationBlockV2(value.block) &&
        value.block.id === value.blockId &&
        value.block.sequence === value.blockSeq &&
        value.block.revision === value.revision &&
        value.block.entryRole !== 'finalAnswer' &&
        matchesDeliveryMode(value.deliveryMode);
    case 'block.updated':
      return hasOnlyDeltaKeys(value, ['block']) &&
        isSharedConversationBlockV2(value.block) &&
        value.block.entryRole !== 'finalAnswer' &&
        value.block.id === value.blockId &&
        value.block.sequence === value.blockSeq &&
        value.block.revision === value.revision;
    case 'text.append':
      return hasOnlyDeltaKeys(value, [
        'segmentId',
        'offset',
        'text',
        'format',
        'fullCharLength',
        'visibleCharLength',
        'truncated',
        'fullTextRef',
        ]) &&
        typeof value.segmentId === 'string' &&
        projectionNonnegativeInteger(value.offset) &&
        typeof value.text === 'string' &&
        (value.format === 'plain' || value.format === 'markdown') &&
        (value.fullCharLength === undefined ||
          projectionNonnegativeInteger(value.fullCharLength)) &&
        (value.visibleCharLength === undefined ||
          projectionNonnegativeInteger(value.visibleCharLength)) &&
        (value.truncated === undefined || typeof value.truncated === 'boolean') &&
        (value.fullTextRef === undefined || typeof value.fullTextRef === 'string');
    case 'activity.upsert':
      return hasOnlyDeltaKeys(value, [
        'activityId',
        'activityRevision',
        'activity',
      ]) &&
        nonemptyString(value.activityId) &&
        projectionNonnegativeInteger(value.activityRevision) &&
        isSharedConversationActivity(value.activity) &&
        value.activity.activityId === value.activityId;
    case 'block.completed':
      return hasOnlyDeltaKeys(value, ['status', 'contentHash']) &&
        matchesCompletedDeltaStatus(value.status) &&
        (value.contentHash === undefined || typeof value.contentHash === 'string');
    case 'block.committed':
      return hasOnlyDeltaKeys(value, [
        'committedEventIds',
        'finalRevision',
        'finalContentHash',
        'block',
      ]) &&
        stringArray(value.committedEventIds) &&
        value.committedEventIds.length > 0 &&
        value.committedEventIds.every(Boolean) &&
        projectionNonnegativeInteger(value.finalRevision) &&
        (value.finalContentHash === undefined || typeof value.finalContentHash === 'string') &&
        isSharedConversationBlockV2(value.block) &&
        value.block.id === value.blockId &&
        value.block.sequence === value.blockSeq &&
        value.block.revision === value.revision &&
        value.block.revision === value.finalRevision &&
        value.block.entryRole !== 'finalAnswer' &&
        value.block.durability === 'committed';
    case 'block.removed':
      return hasOnlyDeltaKeys(value, []);
    default:
      return false;
  }
}

export function applyAgentTimelineDelta(
  current: AgentTimelineResult | null | undefined,
  delta: AgentTimelineDelta
): AgentTimelineDeltaApplyResult {
  const base = current ?? emptyTimeline(delta.sessionId);
  if (!isAgentTimelineDelta(delta)) {
    return { timeline: base, status: 'gap' };
  }
  if (base.sessionId !== delta.sessionId) {
    return { timeline: base, status: 'stale' };
  }

  if (delta.op === 'timeline.synced') {
    if ((base.revision ?? 0) > (delta.timeline.revision ?? delta.revision)) {
      return { timeline: base, status: 'stale' };
    }
    if (!preservesCommittedFinals(base, delta.timeline)) {
      return { timeline: base, status: 'gap' };
    }
    return {
      timeline: reconcileTimelineSnapshot(base, delta.timeline, delta.deliveryModes, delta.deltaSeq),
      status: 'applied',
    };
  }

  if (delta.op === 'block.started') {
    const existing = findBlock(base, delta.blockId);
    if (existing && (existing.revision ?? 0) >= delta.revision) {
      return { timeline: withLastDeltaSeq(base, delta.deltaSeq), status: 'duplicate' };
    }
    const block = {
      ...delta.block,
      id: delta.blockId,
      sequence: delta.blockSeq,
      revision: delta.revision,
      deliveryMode: delta.deliveryMode,
    };
    return {
      timeline: upsertBlock(base, delta, block),
      status: 'applied',
    };
  }

  const existing = findBlock(base, delta.blockId);
  if (!existing) return { timeline: base, status: 'gap' };
  if ((existing.revision ?? 0) > delta.revision) {
    return { timeline: withLastDeltaSeq(base, delta.deltaSeq), status: 'stale' };
  }
  if (existing.entryRole === 'finalAnswer') {
    return { timeline: base, status: 'gap' };
  }

  if (delta.op === 'text.append') {
    const content = existing.bodyMarkdown ?? '';
    if (delta.offset > content.length) return { timeline: base, status: 'gap' };
    const alreadyPresent = content.slice(delta.offset, delta.offset + delta.text.length) === delta.text;
    if (alreadyPresent) {
      return { timeline: withLastDeltaSeq(base, delta.deltaSeq), status: 'duplicate' };
    }
    if (delta.offset !== content.length) return { timeline: base, status: 'gap' };
    return {
      timeline: updateBlock(base, delta, {
        ...existing,
        bodyMarkdown: `${content}${delta.text}`,
        revision: delta.revision,
      }),
      status: 'applied',
    };
  }

  if (delta.op === 'block.updated') {
    return {
      timeline: updateBlock(base, delta, preserveDeliveryMode(existing, delta.block, delta.revision)),
      status: 'applied',
    };
  }

  if (delta.op === 'activity.upsert') {
    return {
      timeline: updateBlock(base, delta, {
        ...existing,
        activity: delta.activity,
        title: delta.activity.title,
        summary: delta.activity.summary,
        status: delta.activity.status,
        revision: delta.revision,
      }),
      status: 'applied',
    };
  }

  if (delta.op === 'block.completed') {
    return {
      timeline: updateBlock(base, delta, {
        ...existing,
        status: delta.status,
        revision: delta.revision,
      }),
      status: 'applied',
    };
  }

  if (delta.op === 'block.committed') {
    if ((existing.revision ?? 0) > delta.finalRevision) {
      return { timeline: withLastDeltaSeq(base, delta.deltaSeq), status: 'stale' };
    }
    return {
      timeline: updateBlock(
        base,
        delta,
        settleCommittedDeliveryMode(existing, delta.block, delta.finalRevision)
      ),
      status: 'applied',
    };
  }

  return {
    timeline: removeBlock(base, delta),
    status: 'applied',
  };
}

function containsPrivateDeltaPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateDeltaPayload);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    key === 'events' ||
    key === 'rawEventRefs' ||
    key === 'metadata' ||
    key === 'payload' ||
    key === 'kernelEvent' ||
    key === 'developerDetails' ||
    key === 'reasoningContent' ||
    key === 'reasoning_content' ||
    key === 'rawProvider' ||
    containsPrivateDeltaPayload(nested)
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function projectionNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function matchesDeliveryMode(value: unknown): value is AgentTimelineDeliveryMode {
  return value === 'live' || value === 'buffered' || value === 'replay';
}

function isDeliveryModeRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(matchesDeliveryMode);
}

function matchesCompletedDeltaStatus(value: unknown): boolean {
  return value === 'completed' ||
    value === 'waiting' ||
    value === 'failed' ||
    value === 'blocked' ||
    value === 'cancelled';
}

function isSharedConversationActivity(
  value: unknown
): value is NonNullable<AgentTimelineBlock['activity']> {
  if (!isRecord(value)) return false;
  const allowed = new Set([
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
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return nonemptyString(value.activityId) &&
    (value.activityRevision === undefined ||
      projectionNonnegativeInteger(value.activityRevision)) &&
    matchesActivityKind(value.kind) &&
    matchesTimelineStatus(value.status) &&
    typeof value.title === 'string' &&
    typeof value.summary === 'string' &&
    matchesActivitySource(value.source) &&
    optionalString(value.runId) &&
    optionalString(value.planId) &&
    optionalString(value.draftId) &&
    (value.targets === undefined || stringArray(value.targets)) &&
    (value.actionIds === undefined || stringArray(value.actionIds)) &&
    (value.workUnitIds === undefined || stringArray(value.workUnitIds)) &&
    (value.resourcePacketIds === undefined || stringArray(value.resourcePacketIds)) &&
    optionalString(value.toolName) &&
    optionalString(value.operation) &&
    (value.itemCount === undefined || projectionNonnegativeInteger(value.itemCount)) &&
    optionalString(value.errorCode) &&
    optionalString(value.errorMessage);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function matchesTimelineStatus(value: unknown): boolean {
  return value === 'queued' ||
    value === 'running' ||
    value === 'waiting' ||
    value === 'blocked' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'failed';
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

export function reconcileTimelineSnapshot(
  current: AgentTimelineResult | null | undefined,
  incoming: AgentTimelineResult,
  deliveryModes: Record<string, AgentTimelineDeliveryMode> = {},
  lastDeltaSeq?: number
): AgentTimelineResult {
  const existingById = new Map(
    (current?.turns ?? []).flatMap((turn) => turn.blocks).map((block) => [block.id, block])
  );
  return {
    ...incoming,
    revision: Math.max(current?.revision ?? 0, incoming.revision ?? 0),
    lastDeltaSeq: lastDeltaSeq ?? current?.lastDeltaSeq ?? incoming.lastDeltaSeq,
    turns: incoming.turns.map((turn, turnIndex) => ({
      ...turn,
      sequence: turn.sequence ?? turnIndex,
      blocks: turn.blocks.map((block, blockIndex) => {
        const existing = existingById.get(block.id);
        return {
          ...block,
          sequence: block.sequence ?? blockIndex,
          revision: Math.max(existing?.revision ?? 0, block.revision ?? 0),
          deliveryMode: deliveryModes[block.id] ??
            (existing?.deliveryMode === 'live' ? 'replay' : existing?.deliveryMode) ??
            block.deliveryMode ??
            'replay',
        };
      }),
    })),
  };
}

export function timelineAsReplay(timeline: AgentTimelineResult): AgentTimelineResult {
  return {
    ...timeline,
    turns: timeline.turns.map((turn, turnIndex) => ({
      ...turn,
      sequence: turn.sequence ?? turnIndex,
      blocks: turn.blocks.map((block, blockIndex) => ({
        ...block,
        sequence: block.sequence ?? blockIndex,
        deliveryMode: 'replay',
      })),
    })),
  };
}

export function emptyTimeline(sessionId = 'session'): AgentTimelineResult {
  return {
    schemaVersion: 'deepcode.shared-conversation-projection.v2',
    sessionId,
    revision: 0,
    sourceEventVersion: 0,
    lastDeltaSeq: 0,
    generatedAt: new Date(0).toISOString(),
    turns: [],
    eventCount: 0,
  };
}

function diffTimelines(
  previous: AgentTimelineResult,
  next: AgentTimelineResult,
  runId: string,
  newBlockMode: AgentTimelineDeliveryMode
): AgentTimelineDelta[] {
  const previousBlocks = timelineBlockIndex(previous);
  const nextBlocks = timelineBlockIndex(next);
  const deltas: AgentTimelineDelta[] = [];

  for (const entry of nextBlocks.values()) {
    const prior = previousBlocks.get(entry.block.id);
    const base = deltaBase(next, runId, entry);
    if (!prior) {
      if (entry.block.entryRole === 'finalAnswer') continue;
      deltas.push({
        ...base,
        op: 'block.started',
        block: entry.block,
        deliveryMode: newBlockMode,
      });
      continue;
    }
    if (
      prior.block.entryRole === 'finalAnswer' &&
      prior.block.durability === 'committed'
    ) {
      continue;
    }
    if (blockSemanticSignature(prior.block) === blockSemanticSignature(entry.block)) continue;

    const priorBody = prior.block.bodyMarkdown ?? '';
    const nextBody = entry.block.bodyMarkdown ?? '';
    const commitsLiveBlock = isLiveBlock(prior.block) && !isLiveBlock(entry.block);
    if (commitsLiveBlock) {
      deltas.push({
        ...base,
        op: 'block.committed',
        committedEventIds: committedEventIds(entry.block),
        finalRevision: entry.block.revision ?? base.revision,
        finalContentHash: hashText(nextBody),
        block: entry.block,
      });
      continue;
    }
    if (nextBody.startsWith(priorBody) && nextBody.length > priorBody.length) {
      deltas.push({
        ...base,
        op: 'text.append',
        segmentId: `${entry.block.id}:body`,
        offset: priorBody.length,
        text: nextBody.slice(priorBody.length),
        format: 'markdown',
        fullCharLength: nextBody.length,
        visibleCharLength: nextBody.length,
      });
      if (blockMetadataSignature(prior.block) !== blockMetadataSignature(entry.block)) {
        deltas.push({ ...base, op: 'block.updated', block: entry.block });
      }
    } else if (activitySignature(prior.block) !== activitySignature(entry.block) && entry.block.activity) {
      deltas.push({
        ...base,
        op: 'activity.upsert',
        activityId: entry.block.activity.activityId,
        activityRevision: entry.block.revision ?? base.revision,
        activity: entry.block.activity,
      });
      if (blockMetadataSignature(prior.block) !== blockMetadataSignature(entry.block)) {
        deltas.push({ ...base, op: 'block.updated', block: entry.block });
      }
    } else {
      deltas.push({ ...base, op: 'block.updated', block: entry.block });
    }

    if (prior.block.status !== entry.block.status && isCompletedStatus(entry.block.status)) {
      deltas.push({
        ...base,
        op: 'block.completed',
        status: entry.block.status,
        contentHash: hashText(nextBody),
      });
    }
  }

  for (const entry of previousBlocks.values()) {
    if (nextBlocks.has(entry.block.id)) continue;
    if (
      entry.block.entryRole === 'finalAnswer' &&
      entry.block.durability === 'committed'
    ) {
      continue;
    }
    deltas.push({
      ...deltaBase(next, runId, entry),
      op: 'block.removed',
      revision: (entry.block.revision ?? 0) + 1,
    });
  }

  return deltas;
}

function hasOnlyDeltaKeys(
  value: Record<string, unknown>,
  operationKeys: readonly string[]
): boolean {
  const allowed = new Set([
    'schemaVersion',
    'op',
    'sessionId',
    'runId',
    'turnId',
    'turnSeq',
    'blockId',
    'blockSeq',
    'revision',
    'deltaSeq',
    'sourceEventRefs',
    'hostRunId',
    'receivedAt',
    ...operationKeys,
  ]);
  return Object.keys(value).every((key) => allowed.has(key)) &&
    (value.hostRunId === undefined || typeof value.hostRunId === 'string') &&
    (value.receivedAt === undefined || typeof value.receivedAt === 'string');
}

function preservesCommittedFinals(
  current: AgentTimelineResult,
  incoming: AgentTimelineResult
): boolean {
  const incomingById = new Map(
    incoming.turns.flatMap((turn) =>
      turn.blocks.map((block) => [block.id, { turnId: turn.id, block }] as const)
    )
  );
  return current.turns.every((turn) =>
    turn.blocks
      .filter((block) =>
        block.entryRole === 'finalAnswer' && block.durability === 'committed'
      )
      .every((block) => {
        const candidate = incomingById.get(block.id);
        return candidate !== undefined &&
          candidate.turnId === turn.id &&
          candidate.block.entryRole === 'finalAnswer' &&
          candidate.block.durability === 'committed' &&
          committedFinalContractSignature(candidate.block) ===
            committedFinalContractSignature(block);
      })
  );
}

function timelineSyncedDelta(
  timeline: AgentTimelineResult,
  runId: string,
  deliveryModes: Record<string, AgentTimelineDeliveryMode>
): AgentTimelineDelta {
  return {
    schemaVersion: TIMELINE_DELTA_SCHEMA_VERSION,
    op: 'timeline.synced',
    sessionId: timeline.sessionId,
    runId,
    turnId: 'timeline',
    turnSeq: 0,
    blockId: 'timeline',
    blockSeq: 0,
    revision: timeline.revision ?? 0,
    timeline,
    deliveryModes,
  };
}

function stampTimeline(
  timeline: AgentTimelineResult,
  previous: AgentTimelineResult | undefined,
  revision: number
): AgentTimelineResult {
  const previousBlocks = new Map(
    (previous?.turns ?? []).flatMap((turn) => turn.blocks).map((block) => [block.id, block])
  );
  return {
    ...timeline,
    revision,
    lastDeltaSeq: previous?.lastDeltaSeq ?? 0,
    turns: timeline.turns.map((turn, turnIndex) => ({
      ...turn,
      sequence: turnIndex,
      blocks: turn.blocks.map((block, blockIndex) => {
        const prior = previousBlocks.get(block.id);
        const changed = !prior || blockSemanticSignature(prior) !== blockSemanticSignature(block);
        return {
          ...block,
          sequence: blockIndex,
          revision: changed ? (prior?.revision ?? 0) + 1 : prior?.revision ?? 1,
          deliveryMode: 'replay',
        };
      }),
    })),
  };
}

function committedDeliveryModes(
  previous: AgentTimelineResult,
  committed: AgentTimelineResult
): Record<string, AgentTimelineDeliveryMode> {
  const previousBlocks = new Map(
    previous.turns.flatMap((turn) => turn.blocks).map((block) => [block.id, block])
  );
  const result: Record<string, AgentTimelineDeliveryMode> = {};
  for (const block of committed.turns.flatMap((turn) => turn.blocks)) {
    const prior = previousBlocks.get(block.id);
    if (prior) continue;
    result[block.id] = shouldLocallyAnimate(block) ? 'buffered' : 'replay';
  }
  return result;
}

function shouldLocallyAnimate(block: AgentTimelineBlock): boolean {
  const kind = block.narrativeKind;
  return kind === 'thinking' ||
    kind === 'assistantNarration' ||
    kind === 'assistantText' ||
    kind === 'requirement' ||
    kind === 'plan' ||
    kind === 'review';
}

function deltaBase(
  timeline: AgentTimelineResult,
  runId: string,
  entry: TimelineBlockEntry
): Omit<AgentTimelineDelta, 'op'> {
  return {
    schemaVersion: TIMELINE_DELTA_SCHEMA_VERSION,
    sessionId: timeline.sessionId,
    runId,
    turnId: entry.turnId,
    turnSeq: entry.turnSeq,
    blockId: entry.block.id,
    blockSeq: entry.blockSeq,
    revision: entry.block.revision ?? timeline.revision ?? 0,
    sourceEventRefs: entry.block.provenance?.sourceEventRefs,
  } as Omit<AgentTimelineDelta, 'op'>;
}

interface TimelineBlockEntry {
  turnId: string;
  turnSeq: number;
  blockSeq: number;
  block: AgentTimelineBlock;
}

function timelineBlockIndex(timeline: AgentTimelineResult): Map<string, TimelineBlockEntry> {
  const result = new Map<string, TimelineBlockEntry>();
  timeline.turns.forEach((turn, turnIndex) => {
    turn.blocks.forEach((block, blockIndex) => {
      result.set(block.id, {
        turnId: turn.id,
        turnSeq: turn.sequence ?? turnIndex,
        blockSeq: block.sequence ?? blockIndex,
        block,
      });
    });
  });
  return result;
}

function mergeProjectionDelta(existing: ProjectionDelta[], incoming: ProjectionDelta): ProjectionDelta[] {
  const key = projectionDeltaKey(incoming);
  const index = existing.findIndex((delta) => projectionDeltaKey(delta) === key);
  if (index < 0) return [...existing, incoming].sort(compareProjectionDelta);
  const current = existing[index];
  const next = [...existing];
  next[index] = isTextProjectionDelta(incoming)
    ? {
        ...current,
        ...incoming,
        seq: current.seq ?? incoming.seq,
        delta: `${current.delta ?? ''}${incoming.delta ?? ''}`,
      }
    : {
        ...current,
        ...incoming,
        seq: current.seq ?? incoming.seq,
        activity: current.activity && incoming.activity
          ? { ...current.activity, ...incoming.activity }
          : incoming.activity ?? current.activity,
      };
  return next.sort(compareProjectionDelta);
}

function projectionDeltaKey(delta: ProjectionDelta): string {
  const identity = delta.activity?.activityId ?? delta.itemId ?? delta.draftId ?? delta.stage ?? delta.type;
  const payload = isRecord(delta.payload) ? delta.payload : {};
  const sourceTurnId = typeof payload.sourceTurnId === 'string' ? payload.sourceTurnId : '';
  const languageRevision = typeof payload.languageRevision === 'number'
    ? String(payload.languageRevision)
    : '';
  return [
    delta.runId ?? 'run',
    delta.turnId ?? 'turn',
    sourceTurnId,
    languageRevision,
    delta.type,
    delta.channel ?? '',
    identity,
  ].join(':');
}

function isTextProjectionDelta(delta: ProjectionDelta): boolean {
  return delta.type === 'assistant_delta' ||
    delta.type === 'reasoning_delta' ||
    delta.type === 'draft_delta' ||
    delta.type === 'part_delta';
}

function compareProjectionDelta(left: ProjectionDelta, right: ProjectionDelta): number {
  return (left.seq ?? 0) - (right.seq ?? 0);
}

function upsertBlock(
  timeline: AgentTimelineResult,
  delta: AgentTimelineDelta,
  block: AgentTimelineBlock
): AgentTimelineResult {
  const turns = timeline.turns.map((turn) => ({ ...turn, blocks: [...turn.blocks] }));
  let turn = turns.find((candidate) => candidate.id === delta.turnId);
  if (!turn) {
    turn = {
      id: delta.turnId,
      sequence: delta.turnSeq,
      sessionId: delta.sessionId,
      status: 'running',
      blocks: [],
    };
    turns.push(turn);
  }
  const index = turn.blocks.findIndex((candidate) => candidate.id === block.id);
  if (index >= 0) turn.blocks[index] = block;
  else turn.blocks.push(block);
  turn.blocks.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  turns.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  return {
    ...timeline,
    revision: Math.max(timeline.revision ?? 0, delta.revision),
    lastDeltaSeq: delta.deltaSeq ?? timeline.lastDeltaSeq,
    generatedAt: new Date().toISOString(),
    turns,
  };
}

function updateBlock(
  timeline: AgentTimelineResult,
  delta: AgentTimelineDelta,
  block: AgentTimelineBlock
): AgentTimelineResult {
  return upsertBlock(timeline, delta, block);
}

function removeBlock(timeline: AgentTimelineResult, delta: AgentTimelineDelta): AgentTimelineResult {
  return {
    ...timeline,
    revision: Math.max(timeline.revision ?? 0, delta.revision),
    lastDeltaSeq: delta.deltaSeq ?? timeline.lastDeltaSeq,
    turns: timeline.turns
      .map((turn) => ({
        ...turn,
        blocks: turn.blocks.filter((block) => block.id !== delta.blockId),
      }))
      .filter((turn) => turn.blocks.length > 0),
  };
}

function findBlock(timeline: AgentTimelineResult, blockId: string): AgentTimelineBlock | undefined {
  return timeline.turns.flatMap((turn) => turn.blocks).find((block) => block.id === blockId);
}

function preserveDeliveryMode(
  existing: AgentTimelineBlock,
  incoming: AgentTimelineBlock,
  revision: number
): AgentTimelineBlock {
  return {
    ...incoming,
    revision,
    deliveryMode: existing.deliveryMode ?? incoming.deliveryMode ?? 'replay',
  };
}

function settleCommittedDeliveryMode(
  existing: AgentTimelineBlock,
  incoming: AgentTimelineBlock,
  revision: number
): AgentTimelineBlock {
  return {
    ...incoming,
    revision,
    deliveryMode: existing.deliveryMode === 'live'
      ? 'replay'
      : existing.deliveryMode ?? incoming.deliveryMode ?? 'replay',
  };
}

function withLastDeltaSeq(timeline: AgentTimelineResult, deltaSeq?: number): AgentTimelineResult {
  return deltaSeq === undefined ? timeline : { ...timeline, lastDeltaSeq: deltaSeq };
}

function blockSemanticSignature(block: AgentTimelineBlock): string {
  return canonicalJson({
    kind: block.kind,
    narrativeKind: block.narrativeKind,
    activity: block.activity,
    title: block.title,
    summary: block.summary,
    status: block.status,
    defaultCollapsed: block.defaultCollapsed,
    bodyMarkdown: block.bodyMarkdown,
    entryRole: block.entryRole,
    durability: block.durability,
    structuredProjection: block.structuredProjection,
    decisionRequest: block.decisionRequest,
    interaction: block.interaction,
    localizedContent: block.localizedContent,
    languageBinding: block.languageBinding,
    provenance: block.provenance,
    attachments: block.attachments,
    evidenceRefs: block.evidenceRefs,
    taskProjectionRef: block.taskProjectionRef,
  });
}

function committedFinalContractSignature(block: AgentTimelineBlock): string {
  return canonicalJson({
    ...block,
    // Delivery mode is local presentation state. Canonicalize it so a buffered
    // first delivery and the durable replay snapshot share one immutable contract.
    deliveryMode: 'replay',
  });
}

function blockMetadataSignature(block: AgentTimelineBlock): string {
  return canonicalJson({
    title: block.title,
    summary: block.summary,
    status: block.status,
    structuredProjection: block.structuredProjection,
    decisionRequest: block.decisionRequest,
    interaction: block.interaction,
    localizedContent: block.localizedContent,
    languageBinding: block.languageBinding,
    provenance: block.provenance,
  });
}

function activitySignature(block: AgentTimelineBlock): string {
  return canonicalJson(block.activity ?? null);
}

function isLiveBlock(block: AgentTimelineBlock): boolean {
  return block.durability === 'live' ||
    (block.provenance?.sourceEventRefs ?? []).some((ref) => ref.startsWith('event:live:'));
}

function committedEventIds(block: AgentTimelineBlock): string[] {
  return (block.provenance?.sourceEventRefs ?? [])
    .filter((ref) => ref.startsWith('event:'))
    .map((ref) => ref.slice('event:'.length))
    .filter((id) => !id.startsWith('live:'));
}

function isCompletedStatus(
  status: AgentTimelineStatus
): status is Extract<AgentTimelineStatus, 'completed' | 'waiting' | 'failed' | 'blocked' | 'cancelled'> {
  return status === 'completed' ||
    status === 'waiting' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'cancelled';
}

function latestRunId(events: AgentEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (!isRecord(event.payload)) continue;
    const runId = event.payload.runId;
    if (typeof runId === 'string' && runId) return runId;
  }
  return undefined;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
