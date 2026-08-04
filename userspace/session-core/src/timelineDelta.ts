import type {
  AgentEvent,
  AgentTimelineBlock,
  AgentTimelineDelta,
  AgentTimelineDeliveryMode,
  AgentTimelineResult,
  AgentTimelineRootProjectionReplacements,
  AgentTimelineSnapshot,
  AgentTimelineTurn,
} from '@deepcode/protocol';
import {
  AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2,
  AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1,
} from '@deepcode/protocol';
import {
  assertSharedConversationProjectionV2,
  buildNarrativeTimelineProjection,
} from './projectionV2.js';

export class UnsupportedTimelineHistorySchemaError extends Error {
  readonly code = 'UnsupportedHistorySchema';

  constructor() {
    super('UnsupportedHistorySchema');
    this.name = 'UnsupportedTimelineHistorySchemaError';
  }
}

export class AgentTimelineRevisionGapError extends Error {
  readonly code = 'AgentTimelineRevisionGap';

  constructor(
    readonly expectedBaseRevision: number,
    readonly receivedBaseRevision: number
  ) {
    super(
      `Agent timeline delta base revision mismatch: expected `
      + `${expectedBaseRevision}, received ${receivedBaseRevision}.`
    );
    this.name = 'AgentTimelineRevisionGapError';
  }
}

export function isNativeWorkSegmentsTimelineSnapshot(
  snapshot: unknown
): snapshot is AgentTimelineSnapshot {
  if (!isRecord(snapshot)) return false;
  if (
    snapshot.schemaVersion
      !== AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2
    || snapshot.shapeVersion
      !== AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1
    || !Array.isArray(snapshot.turns)
  ) {
    return false;
  }
  return snapshot.turns.every((turn) =>
    isRecord(turn)
    && Array.isArray(turn.blocks)
    && Array.isArray(turn.workSegments)
    && Array.isArray(turn.parts)
  );
}

export function isLegacyFlatV2TimelineSnapshot(
  snapshot: unknown
): snapshot is Record<string, unknown> {
  return isRecord(snapshot)
    && snapshot.schemaVersion
      === AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2
    && snapshot.shapeVersion === undefined
    && Array.isArray(snapshot.turns)
    && snapshot.turns.every((turn) =>
      isRecord(turn)
      && Array.isArray(turn.blocks)
      && turn.workSegments === undefined
      && turn.parts === undefined
    );
}

export class CanonicalTimelineProjector {
  private auxiliaryEvents: AgentEvent[];
  private currentTimeline: AgentTimelineResult;

  constructor(
    private readonly sessionId: string,
    initialEvents: AgentEvent[],
    initialTimeline?: AgentTimelineSnapshot,
    initialAuxiliaryEvents: AgentEvent[] = []
  ) {
    this.auxiliaryEvents = deduplicateAuxiliaryEvents(initialAuxiliaryEvents);
    const normalizedInitial = initialTimeline?.sessionId === sessionId
      ? normalizeAgentTimelineSnapshot(initialTimeline).timeline
      : undefined;
    this.currentTimeline =
      normalizedInitial?.eventCount === initialEvents.length
      && normalizedInitial.sourceEventVersion === initialEvents.length
        ? normalizedInitial
        : buildNarrativeTimelineProjection({
            sessionId,
            events: initialEvents,
            auxiliaryEvents: this.auxiliaryEvents,
          });
  }

  rememberAuxiliaryEvents(events: readonly AgentEvent[]): void {
    if (events.length === 0) return;
    this.auxiliaryEvents = deduplicateAuxiliaryEvents([
      ...this.auxiliaryEvents,
      ...events,
    ]);
  }

  snapshot(): AgentTimelineResult {
    return this.currentTimeline;
  }
}

function deduplicateAuxiliaryEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.id.trim()) byId.set(event.id, event);
  }
  return [...byId.values()];
}

export interface NormalizedAgentTimelineSnapshot {
  timeline: AgentTimelineResult;
  compatibility: 'nativeWorkSegments' | 'legacySettledNeutral';
}

export function normalizeAgentTimelineSnapshot(
  snapshot: AgentTimelineSnapshot | unknown
): NormalizedAgentTimelineSnapshot {
  if (isLegacyFlatV2TimelineSnapshot(snapshot)) {
    const timeline = normalizeSettledLegacyFlatV2(snapshot);
    assertSharedConversationProjectionV2(timeline);
    return {
      timeline,
      compatibility: 'legacySettledNeutral',
    };
  }
  if (!isNativeWorkSegmentsTimelineSnapshot(snapshot)) {
    throw new Error('shared_conversation_projection_native_shape_required');
  }
  assertSharedConversationProjectionV2(snapshot);
  return {
    timeline: snapshot,
    compatibility: 'nativeWorkSegments',
  };
}

export function rebuildSharedConversationProjectionV2(
  sessionId: string,
  sourceEvents: AgentEvent[],
  staleSnapshot: AgentTimelineSnapshot,
  minimumRevision = (staleSnapshot.revision ?? 0) + 1
): AgentTimelineResult {
  assertSharedConversationProjectionV2(staleSnapshot);
  if (staleSnapshot.sessionId !== sessionId) {
    throw new Error('session_projection_repair_native_v2_required');
  }
  return {
    ...buildNarrativeTimelineProjection({
      sessionId,
      events: sourceEvents,
    }),
    revision: Math.max(sourceEvents.length, minimumRevision),
  };
}

export function createAgentTimelineDelta(
  current: AgentTimelineResult,
  next: AgentTimelineResult
): AgentTimelineDelta {
  assertNativeTimeline(current);
  assertNativeTimeline(next);
  if (current.sessionId !== next.sessionId) {
    throw new Error('timeline_delta_session_mismatch');
  }
  const legacyPrefixTurnCount = next.legacyPrefixTurnCount ?? 0;
  if (
    (current.legacyPrefixTurnCount ?? 0)
      !== legacyPrefixTurnCount
  ) {
    throw new Error('timeline_delta_legacy_prefix_changed');
  }
  for (let index = 0; index < legacyPrefixTurnCount; index += 1) {
    if (!jsonEqual(current.turns[index], next.turns[index])) {
      throw new Error('timeline_delta_legacy_prefix_changed');
    }
  }
  if (next.revision <= current.revision) {
    throw new Error('timeline_delta_revision_not_advancing');
  }
  if (
    next.sourceEventVersion <= current.sourceEventVersion
    || next.eventCount <= current.eventCount
  ) {
    throw new Error('timeline_delta_source_version_not_advancing');
  }

  const currentTurns = new Map(
    current.turns.map((turn) => [turn.id, turn])
  );
  const nextTurnIds = new Set(next.turns.map((turn) => turn.id));
  const turnReplacements = next.turns.filter((turn) => {
    const existing = currentTurns.get(turn.id);
    return !existing || !jsonEqual(existing, turn);
  });
  const removedTurnIds = current.turns
    .filter((turn) => !nextTurnIds.has(turn.id))
    .map((turn) => turn.id);

  return {
    schemaVersion: AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2,
    shapeVersion: AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1,
    legacyPrefixTurnCount,
    sessionId: next.sessionId,
    baseRevision: current.revision,
    revision: next.revision,
    sourceEventVersion: next.sourceEventVersion,
    generatedAt: next.generatedAt,
    eventCount: next.eventCount,
    turnReplacements,
    removedTurnIds,
    rootReplacements: changedRootProjections(current, next),
  };
}

export function applyAgentTimelineDelta(
  current: AgentTimelineResult,
  delta: AgentTimelineDelta
): AgentTimelineResult {
  assertNativeTimeline(current);
  assertTimelineDelta(delta);
  if (current.sessionId !== delta.sessionId) {
    throw new Error('timeline_delta_session_mismatch');
  }
  if (delta.baseRevision !== current.revision) {
    throw new AgentTimelineRevisionGapError(
      current.revision,
      delta.baseRevision
    );
  }
  const currentLegacyPrefixTurnCount =
    current.legacyPrefixTurnCount ?? 0;
  const deltaLegacyPrefixTurnCount =
    delta.legacyPrefixTurnCount ?? 0;
  if (
    currentLegacyPrefixTurnCount !== deltaLegacyPrefixTurnCount
  ) {
    throw new Error('timeline_delta_legacy_prefix_changed');
  }
  if (delta.revision <= delta.baseRevision) {
    throw new Error('timeline_delta_revision_not_advancing');
  }
  if (
    delta.sourceEventVersion <= current.sourceEventVersion
    || delta.eventCount <= current.eventCount
  ) {
    throw new Error('timeline_delta_source_version_not_advancing');
  }

  const removed = new Set(delta.removedTurnIds);
  const replacements = new Map(
    delta.turnReplacements.map((turn) => [turn.id, turn])
  );
  const legacyTurnIds = new Set(
    current.turns
      .slice(0, currentLegacyPrefixTurnCount)
      .map((turn) => turn.id)
  );
  if (
    [...legacyTurnIds].some((turnId) =>
      removed.has(turnId) || replacements.has(turnId)
    )
  ) {
    throw new Error('timeline_delta_legacy_prefix_changed');
  }
  for (const turnId of removed) {
    if (replacements.has(turnId)) {
      throw new Error('timeline_delta_turn_conflict');
    }
  }

  const legacyTurns = current.turns.slice(
    0,
    currentLegacyPrefixTurnCount
  );
  const turns: AgentTimelineTurn[] = [];
  const knownTurnIds = new Set<string>();
  for (const turn of current.turns.slice(currentLegacyPrefixTurnCount)) {
    if (removed.has(turn.id)) continue;
    const replacement = replacements.get(turn.id);
    turns.push(replacement ?? turn);
    knownTurnIds.add(turn.id);
  }
  for (const replacement of delta.turnReplacements) {
    if (!knownTurnIds.has(replacement.id)) {
      turns.push(replacement);
    }
  }
  turns.sort((left, right) =>
    (left.sequence ?? Number.MAX_SAFE_INTEGER)
      - (right.sequence ?? Number.MAX_SAFE_INTEGER)
  );

  const result: AgentTimelineResult = {
    ...current,
    schemaVersion: delta.schemaVersion,
    shapeVersion: delta.shapeVersion,
    legacyPrefixTurnCount: deltaLegacyPrefixTurnCount,
    revision: delta.revision,
    sourceEventVersion: delta.sourceEventVersion,
    generatedAt: delta.generatedAt,
    eventCount: delta.eventCount,
    turns: [...legacyTurns, ...turns],
  };
  applyRootProjectionReplacements(result, delta.rootReplacements);
  assertNativeTimeline(result);
  return result;
}

export function reconcileTimelineSnapshot(
  current: AgentTimelineResult | null | undefined,
  incoming: AgentTimelineResult,
  deliveryModes: Record<string, AgentTimelineDeliveryMode> = {}
): AgentTimelineResult {
  if (current) {
    assertNativeTimeline(current);
    if (current.sessionId !== incoming.sessionId) {
      throw new Error('timeline_reconcile_session_mismatch');
    }
    if (
      incoming.revision < current.revision
      || incoming.sourceEventVersion < current.sourceEventVersion
      || incoming.eventCount < current.eventCount
    ) {
      throw new Error('timeline_reconcile_stale_snapshot');
    }
  }
  assertNativeTimeline(incoming);
  const existingById = new Map(
    (current?.turns ?? [])
      .flatMap((turn) => turn.blocks)
      .map((block) => [block.id, block])
  );
  const existingWorkSegmentsById = new Map(
    (current?.turns ?? [])
      .flatMap((turn) => turn.workSegments)
      .map((segment) => [segment.id, segment])
  );
  const reconciled: AgentTimelineResult = {
    ...incoming,
    turns: incoming.turns.map((turn, turnIndex) => ({
      ...turn,
      sequence: turn.sequence ?? turnIndex,
      blocks: turn.blocks.map((block, blockIndex) => {
        const existing = existingById.get(block.id);
        return {
          ...block,
          sequence: block.sequence ?? blockIndex,
          revision: Math.max(existing?.revision ?? 0, block.revision ?? 0),
          deliveryMode: deliveryModes[block.id]
            ?? (existing?.deliveryMode === 'live' ? 'replay' : existing?.deliveryMode)
            ?? block.deliveryMode
            ?? 'replay',
        };
      }),
      workSegments: turn.workSegments.map((segment, segmentIndex) => ({
        ...segment,
        sequence: segment.sequence ?? segmentIndex,
        revision: Math.max(
          existingWorkSegmentsById.get(segment.id)?.revision ?? 0,
          segment.revision
        ),
      })),
      parts: turn.parts.map((part) => ({ ...part })),
    })),
  };
  assertNativeTimeline(reconciled);
  return reconciled;
}

export function timelineAsReplay(
  timeline: AgentTimelineResult
): AgentTimelineResult {
  assertNativeTimeline(timeline);
  const replay: AgentTimelineResult = {
    ...timeline,
    turns: timeline.turns.map((turn, turnIndex) => ({
      ...turn,
      sequence: turn.sequence ?? turnIndex,
      blocks: turn.blocks.map((block, blockIndex) => ({
        ...block,
        sequence: block.sequence ?? blockIndex,
        deliveryMode: 'replay',
      })),
      workSegments: turn.workSegments.map((segment, segmentIndex) => ({
        ...segment,
        sequence: segment.sequence ?? segmentIndex,
      })),
      parts: turn.parts.map((part) => ({ ...part })),
    })),
  };
  assertNativeTimeline(replay);
  return replay;
}

export function emptyTimeline(sessionId = 'session'): AgentTimelineResult {
  return {
    schemaVersion: AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2,
    shapeVersion: AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1,
    legacyPrefixTurnCount: 0,
    sessionId,
    revision: 0,
    sourceEventVersion: 0,
    generatedAt: new Date(0).toISOString(),
    turns: [],
    eventCount: 0,
  };
}

function normalizeSettledLegacyFlatV2(
  snapshot: Record<string, unknown>
): AgentTimelineResult {
  if (!legacyFlatSnapshotIsSettled(snapshot)) {
    throw new UnsupportedTimelineHistorySchemaError();
  }
  const turns = (snapshot.turns as unknown[]).map((value) => {
    const turn = isRecord(value) ? value : {};
    const blocks = Array.isArray(turn.blocks)
      ? turn.blocks.map((block) => ({ ...block })) as AgentTimelineBlock[]
      : [];
    return {
      id: turn.id as string,
      ...(turn.sequence === undefined
        ? {}
        : { sequence: turn.sequence as number }),
      sessionId: turn.sessionId as string,
      status: turn.status as AgentTimelineTurn['status'],
      ...(turn.startedAt === undefined
        ? {}
        : { startedAt: turn.startedAt as string }),
      ...(turn.completedAt === undefined
        ? {}
        : { completedAt: turn.completedAt as string }),
      blocks,
      workSegments: [],
      parts: blocks.map((block) => ({
        kind: 'block' as const,
        blockId: block.id,
      })),
    };
  });
  const runProjection = normalizeLegacySettledRunProjection(
    snapshot.runProjection
  );
  const result: AgentTimelineResult = {
    schemaVersion: AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2,
    shapeVersion: AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1,
    legacyPrefixTurnCount: turns.length,
    sessionId: snapshot.sessionId as string,
    revision: snapshot.revision as number,
    sourceEventVersion: snapshot.sourceEventVersion as number,
    generatedAt: snapshot.generatedAt as string,
    turns,
    eventCount: snapshot.eventCount as number,
    ...(snapshot.taskProjection === undefined
      ? {}
      : {
          taskProjection:
            snapshot.taskProjection as AgentTimelineResult['taskProjection'],
        }),
    ...(snapshot.interactionProjection === undefined
      ? {}
      : {
          interactionProjection:
            snapshot.interactionProjection as AgentTimelineResult['interactionProjection'],
        }),
    ...(runProjection ? { runProjection } : {}),
    ...(snapshot.tokenUsageProjection === undefined
      ? {}
      : {
          tokenUsageProjection:
            snapshot.tokenUsageProjection as AgentTimelineResult['tokenUsageProjection'],
        }),
    ...(snapshot.workspaceProjection === undefined
      ? {}
      : {
          workspaceProjection:
            snapshot.workspaceProjection as AgentTimelineResult['workspaceProjection'],
        }),
  };
  return result;
}

function legacyFlatSnapshotIsSettled(
  snapshot: Record<string, unknown>
): boolean {
  const run = isRecord(snapshot.runProjection)
    ? snapshot.runProjection
    : undefined;
  const turns = Array.isArray(snapshot.turns)
    ? snapshot.turns
    : [];
  const turnsAreTerminal = turns.every((value) => {
    const turn = isRecord(value) ? value : undefined;
    return Boolean(
      turn
      && (
        turn.status === 'completed'
        || turn.status === 'cancelled'
        || turn.status === 'failed'
      )
    );
  });
  if (!turnsAreTerminal) return false;
  if (!run) return false;
  return run.phase === 'settled'
    && (
      run.status === 'succeeded'
      || run.status === 'failed'
      || run.status === 'cancelled'
    );
}

function normalizeLegacySettledRunProjection(
  value: unknown
): AgentTimelineResult['runProjection'] {
  const run = isRecord(value) ? value : undefined;
  if (!run) return undefined;
  return {
    runId: run.runId as string,
    ...(run.turnId === undefined
      ? {}
      : { turnId: run.turnId as string }),
    ...(run.taskId === undefined
      ? {}
      : { taskId: run.taskId as string }),
    revision: run.revision as number,
    status: run.status as NonNullable<
      AgentTimelineResult['runProjection']
    >['status'],
    phase: run.phase as NonNullable<
      AgentTimelineResult['runProjection']
    >['phase'],
    currentActivity: null,
    wait: null,
    languageBinding:
      run.languageBinding as NonNullable<
        AgentTimelineResult['runProjection']
      >['languageBinding'],
  };
}

function assertNativeTimeline(
  timeline: AgentTimelineResult
): void {
  if (isLegacyFlatV2TimelineSnapshot(timeline)) {
    throw new UnsupportedTimelineHistorySchemaError();
  }
  if (!isNativeWorkSegmentsTimelineSnapshot(timeline)) {
    throw new Error('shared_conversation_projection_native_shape_required');
  }
  assertSharedConversationProjectionV2(timeline);
}

function assertTimelineDelta(delta: AgentTimelineDelta): void {
  if (
    !isRecord(delta)
    || delta.schemaVersion
      !== AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2
    || delta.shapeVersion
      !== AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1
    || (
      delta.legacyPrefixTurnCount !== undefined
      && (
        !Number.isSafeInteger(delta.legacyPrefixTurnCount)
        || delta.legacyPrefixTurnCount < 0
      )
    )
    || typeof delta.sessionId !== 'string'
    || !Number.isSafeInteger(delta.baseRevision)
    || !Number.isSafeInteger(delta.revision)
    || !Number.isSafeInteger(delta.sourceEventVersion)
    || typeof delta.generatedAt !== 'string'
    || !Number.isSafeInteger(delta.eventCount)
    || !Array.isArray(delta.turnReplacements)
    || !Array.isArray(delta.removedTurnIds)
    || !isRecord(delta.rootReplacements)
  ) {
    throw new Error('invalid_timeline_delta');
  }
  const replacementIds = new Set<string>();
  for (const turn of delta.turnReplacements) {
    if (
      !isRecord(turn)
      || typeof turn.id !== 'string'
      || replacementIds.has(turn.id)
    ) {
      throw new Error('invalid_timeline_delta_turn_replacement');
    }
    replacementIds.add(turn.id);
  }
  const removedIds = new Set<string>();
  for (const turnId of delta.removedTurnIds) {
    if (
      typeof turnId !== 'string'
      || removedIds.has(turnId)
    ) {
      throw new Error('invalid_timeline_delta_removed_turn');
    }
    removedIds.add(turnId);
  }
}

function changedRootProjections(
  current: AgentTimelineResult,
  next: AgentTimelineResult
): AgentTimelineRootProjectionReplacements {
  const replacements: AgentTimelineRootProjectionReplacements = {};
  if (!jsonEqual(current.taskProjection, next.taskProjection)) {
    replacements.taskProjection = next.taskProjection ?? null;
  }
  if (
    !jsonEqual(
      current.interactionProjection,
      next.interactionProjection
    )
  ) {
    replacements.interactionProjection =
      next.interactionProjection ?? null;
  }
  if (!jsonEqual(current.runProjection, next.runProjection)) {
    replacements.runProjection = next.runProjection ?? null;
  }
  if (
    !jsonEqual(
      current.tokenUsageProjection,
      next.tokenUsageProjection
    )
  ) {
    replacements.tokenUsageProjection =
      next.tokenUsageProjection ?? null;
  }
  if (
    !jsonEqual(
      current.workspaceProjection,
      next.workspaceProjection
    )
  ) {
    replacements.workspaceProjection =
      next.workspaceProjection ?? null;
  }
  return replacements;
}

function applyRootProjectionReplacements(
  timeline: AgentTimelineResult,
  replacements: AgentTimelineRootProjectionReplacements
): void {
  if (hasOwn(replacements, 'taskProjection')) {
    if (replacements.taskProjection === null) {
      delete timeline.taskProjection;
    } else if (replacements.taskProjection !== undefined) {
      timeline.taskProjection = replacements.taskProjection;
    }
  }
  if (hasOwn(replacements, 'interactionProjection')) {
    if (replacements.interactionProjection === null) {
      delete timeline.interactionProjection;
    } else if (replacements.interactionProjection !== undefined) {
      timeline.interactionProjection =
        replacements.interactionProjection;
    }
  }
  if (hasOwn(replacements, 'runProjection')) {
    if (replacements.runProjection === null) {
      delete timeline.runProjection;
    } else if (replacements.runProjection !== undefined) {
      timeline.runProjection = replacements.runProjection;
    }
  }
  if (hasOwn(replacements, 'tokenUsageProjection')) {
    if (replacements.tokenUsageProjection === null) {
      delete timeline.tokenUsageProjection;
    } else if (replacements.tokenUsageProjection !== undefined) {
      timeline.tokenUsageProjection =
        replacements.tokenUsageProjection;
    }
  }
  if (hasOwn(replacements, 'workspaceProjection')) {
    if (replacements.workspaceProjection === null) {
      delete timeline.workspaceProjection;
    } else if (replacements.workspaceProjection !== undefined) {
      timeline.workspaceProjection =
        replacements.workspaceProjection;
    }
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}
