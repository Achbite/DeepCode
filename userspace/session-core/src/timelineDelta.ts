import type {
  AgentEvent,
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
      ? normalizeAgentTimelineSnapshot(initialTimeline)
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

export function normalizeAgentTimelineSnapshot(
  snapshot: AgentTimelineSnapshot | unknown
): AgentTimelineResult {
  if (!isNativeWorkSegmentsTimelineSnapshot(snapshot)) {
    throw new UnsupportedTimelineHistorySchemaError();
  }
  assertSharedConversationProjectionV2(snapshot);
  return snapshot;
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

export function createProviderComposingTimelineDelta(
  current: AgentTimelineResult,
  next: AgentTimelineResult
): AgentTimelineDelta {
  assertNativeTimeline(current);
  assertNativeTimeline(next);
  const turnId = next.runProjection?.turnId;
  if (
    current.sessionId !== next.sessionId
    || !turnId
    || current.runProjection?.runId !== next.runProjection?.runId
    || next.revision !== current.revision + 1
    || next.sourceEventVersion !== current.sourceEventVersion + 1
    || next.eventCount !== current.eventCount + 1
    || current.turns.length !== next.turns.length
    || current.taskProjection !== next.taskProjection
    || current.interactionProjection !== next.interactionProjection
    || current.tokenUsageProjection !== next.tokenUsageProjection
    || current.workspaceProjection !== next.workspaceProjection
  ) {
    throw new Error('provider_composing_timeline_delta_invalid');
  }
  let replacement: AgentTimelineTurn | undefined;
  for (let index = 0; index < current.turns.length; index += 1) {
    const before = current.turns[index]!;
    const after = next.turns[index]!;
    if (before.id !== after.id || before.sequence !== after.sequence) {
      throw new Error('provider_composing_timeline_delta_turn_order_changed');
    }
    if (after.id === turnId) {
      if (before === after) {
        throw new Error('provider_composing_timeline_delta_turn_unchanged');
      }
      replacement = after;
    } else if (before !== after) {
      throw new Error('provider_composing_timeline_delta_cross_turn_change');
    }
  }
  if (!replacement || current.runProjection === next.runProjection) {
    throw new Error('provider_composing_timeline_delta_missing_change');
  }
  return {
    schemaVersion: next.schemaVersion,
    shapeVersion: next.shapeVersion,
    sessionId: next.sessionId,
    baseRevision: current.revision,
    revision: next.revision,
    sourceEventVersion: next.sourceEventVersion,
    generatedAt: next.generatedAt,
    eventCount: next.eventCount,
    turnReplacements: [replacement],
    removedTurnIds: [],
    rootReplacements: {
      runProjection: next.runProjection,
    },
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
  for (const turnId of removed) {
    if (replacements.has(turnId)) {
      throw new Error('timeline_delta_turn_conflict');
    }
  }

  const turns: AgentTimelineTurn[] = [];
  const knownTurnIds = new Set<string>();
  for (const turn of current.turns) {
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
    revision: delta.revision,
    sourceEventVersion: delta.sourceEventVersion,
    generatedAt: delta.generatedAt,
    eventCount: delta.eventCount,
    turns,
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
    sessionId,
    revision: 0,
    sourceEventVersion: 0,
    generatedAt: new Date(0).toISOString(),
    turns: [],
    eventCount: 0,
  };
}

function assertNativeTimeline(
  timeline: AgentTimelineResult
): void {
  if (!isNativeWorkSegmentsTimelineSnapshot(timeline)) {
    throw new Error('shared_conversation_projection_native_shape_required');
  }
  assertSharedConversationProjectionV2(timeline);
}

function assertTimelineDelta(delta: AgentTimelineDelta): void {
  const deltaKeys = [
    'schemaVersion',
    'shapeVersion',
    'sessionId',
    'baseRevision',
    'revision',
    'sourceEventVersion',
    'generatedAt',
    'eventCount',
    'turnReplacements',
    'removedTurnIds',
    'rootReplacements',
  ];
  if (
    !isRecord(delta)
    || !hasExactKeys(delta, deltaKeys)
    || delta.schemaVersion
      !== AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2
    || delta.shapeVersion
      !== AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1
    || typeof delta.sessionId !== 'string'
    || delta.sessionId.length === 0
    || !isNonnegativeSafeInteger(delta.baseRevision)
    || !isNonnegativeSafeInteger(delta.revision)
    || !isNonnegativeSafeInteger(delta.sourceEventVersion)
    || typeof delta.generatedAt !== 'string'
    || delta.generatedAt.length === 0
    || !isNonnegativeSafeInteger(delta.eventCount)
    || !Array.isArray(delta.turnReplacements)
    || !Array.isArray(delta.removedTurnIds)
    || !isRecord(delta.rootReplacements)
    || !hasOnlyKeys(delta.rootReplacements, [
      'taskProjection',
      'interactionProjection',
      'runProjection',
      'tokenUsageProjection',
      'workspaceProjection',
    ])
  ) {
    throw new Error('invalid_timeline_delta');
  }
  const replacementIds = new Set<string>();
  for (const turn of delta.turnReplacements) {
    if (
      !isRecord(turn)
      || typeof turn.id !== 'string'
      || turn.id.length === 0
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
      || turnId.length === 0
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

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).length === keys.length
    && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}
