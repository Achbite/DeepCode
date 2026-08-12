import type {
  AgentEvent,
  AgentTimelineBlock,
  AgentTimelineDelta,
  AgentTimelineDeltaOperationV3,
  AgentTimelineDeliveryMode,
  AgentTimelineResult,
  AgentTimelineRootProjectionReplacements,
  AgentTimelineSnapshot,
  AgentTimelineTurn,
  ConversationTextAppendV3,
} from '@deepcode/protocol';
import {
  AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V3,
  AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V3,
} from '@deepcode/protocol';
import {
  assertSharedConversationProjectionV3,
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
      !== AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V3
    || snapshot.shapeVersion
      !== AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V3
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
  assertSharedConversationProjectionV3(snapshot);
  return snapshot;
}

export function rebuildSharedConversationProjectionV3(
  sessionId: string,
  sourceEvents: AgentEvent[],
  staleSnapshot: AgentTimelineSnapshot,
  minimumRevision = (staleSnapshot.revision ?? 0) + 1
): AgentTimelineResult {
  assertSharedConversationProjectionV3(staleSnapshot);
  if (staleSnapshot.sessionId !== sessionId) {
    throw new Error('session_projection_repair_native_v3_required');
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
  const turnReplacements: AgentTimelineTurn[] = [];
  const operations: AgentTimelineDeltaOperationV3[] = [];
  for (const turn of next.turns) {
    const existing = currentTurns.get(turn.id);
    if (!existing) {
      turnReplacements.push(turn);
      continue;
    }
    if (jsonEqual(existing, turn)) continue;
    const append = exactTextAppendV3(existing, turn);
    if (append) {
      operations.push({ kind: 'text.append', append });
    } else {
      turnReplacements.push(turn);
    }
  }
  const removedTurnIds = current.turns
    .filter((turn) => !nextTurnIds.has(turn.id))
    .map((turn) => turn.id);
  if (!jsonEqual(current.runProjection, next.runProjection)) {
    operations.push({
      kind: 'run.updated',
      runProjection: next.runProjection ?? null,
    });
  }

  return {
    schemaVersion: AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V3,
    shapeVersion: AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V3,
    sessionId: next.sessionId,
    baseRevision: current.revision,
    revision: next.revision,
    sourceEventVersion: next.sourceEventVersion,
    generatedAt: next.generatedAt,
    eventCount: next.eventCount,
    turnReplacements,
    removedTurnIds,
    operations,
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
  let append: ConversationTextAppendV3 | undefined;
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
      append = exactTextAppendV3(before, after);
      if (!append) replacement = after;
    } else if (before !== after) {
      throw new Error('provider_composing_timeline_delta_cross_turn_change');
    }
  }
  if ((!replacement && !append) || current.runProjection === next.runProjection) {
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
    turnReplacements: replacement ? [replacement] : [],
    removedTurnIds: [],
    operations: [
      ...(append ? [{ kind: 'text.append' as const, append }] : []),
      { kind: 'run.updated', runProjection: next.runProjection ?? null },
    ],
    rootReplacements: {},
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
  const appendedTurnIds = new Set(
    delta.operations
      .filter((operation) => operation.kind === 'text.append')
      .map((operation) => operation.append.turnId)
  );
  for (const turnId of removed) {
    if (replacements.has(turnId)) {
      throw new Error('timeline_delta_turn_conflict');
    }
    if (appendedTurnIds.has(turnId)) {
      throw new Error('timeline_delta_text_append_removed_turn_conflict');
    }
  }
  for (const turnId of appendedTurnIds) {
    if (replacements.has(turnId)) {
      throw new Error('timeline_delta_text_append_replacement_conflict');
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
  for (const operation of delta.operations) {
    if (operation.kind !== 'text.append') continue;
    const turnIndex = turns.findIndex(
      (turn) => turn.id === operation.append.turnId
    );
    if (turnIndex < 0) {
      throw new Error('timeline_delta_text_append_turn_missing');
    }
    turns[turnIndex] = applyTextAppendV3(
      turns[turnIndex]!,
      operation.append
    );
  }

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
  for (const operation of delta.operations) {
    if (operation.kind !== 'run.updated') continue;
    if (operation.runProjection === null) {
      delete result.runProjection;
    } else {
      result.runProjection = operation.runProjection;
    }
  }
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
    schemaVersion: AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V3,
    shapeVersion: AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V3,
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
  assertSharedConversationProjectionV3(timeline);
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
    'operations',
    'rootReplacements',
  ];
  if (
    !isRecord(delta)
    || !hasExactKeys(delta, deltaKeys)
    || delta.schemaVersion
      !== AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V3
    || delta.shapeVersion
      !== AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V3
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
    || !Array.isArray(delta.operations)
    || !isRecord(delta.rootReplacements)
    || !hasOnlyKeys(delta.rootReplacements, [
      'taskProjection',
      'interactionProjection',
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
  let runUpdateCount = 0;
  const appendTargets = new Set<string>();
  for (const operation of delta.operations) {
    if (!isRecord(operation) || typeof operation.kind !== 'string') {
      throw new Error('invalid_timeline_delta_operation');
    }
    if (operation.kind === 'run.updated') {
      if (
        !hasExactKeys(operation, ['kind', 'runProjection'])
        || operation.runProjection === undefined
      ) {
        throw new Error('invalid_timeline_delta_run_update');
      }
      runUpdateCount += 1;
      if (runUpdateCount > 1) {
        throw new Error('timeline_delta_run_update_duplicate');
      }
      continue;
    }
    if (
      operation.kind !== 'text.append'
      || !hasExactKeys(operation, ['kind', 'append'])
      || !validTextAppendV3(operation.append)
    ) {
      throw new Error('invalid_timeline_delta_text_append');
    }
    const append = operation.append as unknown as ConversationTextAppendV3;
    const target = `${append.turnId}\u0000${append.blockId}`;
    if (appendTargets.has(target)) {
      throw new Error('timeline_delta_text_append_duplicate');
    }
    appendTargets.add(target);
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

function exactTextAppendV3(
  before: AgentTimelineTurn,
  after: AgentTimelineTurn
): ConversationTextAppendV3 | undefined {
  if (
    before.id !== after.id
    || before.blocks.length !== after.blocks.length
    || !jsonEqual(
      { ...before, blocks: [] },
      { ...after, blocks: [] }
    )
  ) {
    return undefined;
  }
  let append: ConversationTextAppendV3 | undefined;
  for (let index = 0; index < before.blocks.length; index += 1) {
    const previousBlock = before.blocks[index]!;
    const nextBlock = after.blocks[index]!;
    if (jsonEqual(previousBlock, nextBlock)) continue;
    if (append) return undefined;
    append = exactBlockTextAppendV3(before.id, previousBlock, nextBlock);
    if (!append) return undefined;
  }
  return append;
}

function exactBlockTextAppendV3(
  turnId: string,
  before: AgentTimelineBlock,
  after: AgentTimelineBlock
): ConversationTextAppendV3 | undefined {
  const baseRevision = before.revision ?? 0;
  const blockRevision = after.revision ?? 0;
  const beforeBody = before.bodyMarkdown ?? '';
  const afterBody = after.bodyMarkdown ?? '';
  const beforeRefs = before.provenance.sourceEventRefs;
  const afterRefs = after.provenance.sourceEventRefs;
  if (
    before.id !== after.id
    || before.kind !== 'assistant'
    || before.narrativeKind !== 'assistantText'
    || after.kind !== 'assistant'
    || after.narrativeKind !== 'assistantText'
    || baseRevision < 1
    || blockRevision !== baseRevision + 1
    || !afterBody.startsWith(beforeBody)
    || !after.summary.startsWith(before.summary)
    || afterBody.slice(beforeBody.length)
      !== after.summary.slice(before.summary.length)
    || afterBody.length === beforeBody.length
    || afterRefs.length <= beforeRefs.length
    || !beforeRefs.every((ref, index) => afterRefs[index] === ref)
    || new Set(afterRefs).size !== afterRefs.length
  ) {
    return undefined;
  }
  const sourceEventRefs = afterRefs.slice(beforeRefs.length);
  if (
    sourceEventRefs.length === 0
    || sourceEventRefs.some((ref) => !ref.trim())
  ) {
    return undefined;
  }
  const normalizedAfter: AgentTimelineBlock = {
    ...after,
    revision: before.revision,
    summary: before.summary,
    bodyMarkdown: before.bodyMarkdown,
    provenance: {
      ...after.provenance,
      sourceEventRefs: beforeRefs,
    },
  };
  if (!jsonEqual(before, normalizedAfter)) return undefined;
  return {
    turnId,
    blockId: after.id,
    baseBlockRevision: baseRevision,
    blockRevision,
    textDelta: afterBody.slice(beforeBody.length),
    sourceEventRefs,
  };
}

function validTextAppendV3(value: unknown): value is ConversationTextAppendV3 {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'turnId',
      'blockId',
      'baseBlockRevision',
      'blockRevision',
      'textDelta',
      'sourceEventRefs',
    ])
    || typeof value.turnId !== 'string'
    || value.turnId.length === 0
    || typeof value.blockId !== 'string'
    || value.blockId.length === 0
    || !isNonnegativeSafeInteger(value.baseBlockRevision)
    || value.baseBlockRevision < 1
    || !isNonnegativeSafeInteger(value.blockRevision)
    || value.blockRevision !== value.baseBlockRevision + 1
    || typeof value.textDelta !== 'string'
    || value.textDelta.length === 0
    || !Array.isArray(value.sourceEventRefs)
    || value.sourceEventRefs.length === 0
    || value.sourceEventRefs.some(
      (ref) => typeof ref !== 'string' || ref.length === 0
    )
    || new Set(value.sourceEventRefs).size !== value.sourceEventRefs.length
  ) {
    return false;
  }
  return true;
}

function applyTextAppendV3(
  turn: AgentTimelineTurn,
  append: ConversationTextAppendV3
): AgentTimelineTurn {
  if (turn.id !== append.turnId) {
    throw new Error('timeline_delta_text_append_turn_mismatch');
  }
  const blockIndex = turn.blocks.findIndex(
    (block) => block.id === append.blockId
  );
  if (blockIndex < 0) {
    throw new Error('timeline_delta_text_append_block_missing');
  }
  const block = turn.blocks[blockIndex]!;
  const blockRevision = block.revision ?? 0;
  const currentRefs = block.provenance.sourceEventRefs;
  if (
    block.kind !== 'assistant'
    || block.narrativeKind !== 'assistantText'
    || blockRevision !== append.baseBlockRevision
    || append.blockRevision !== append.baseBlockRevision + 1
    || append.sourceEventRefs.some((ref) => currentRefs.includes(ref))
  ) {
    throw new Error('timeline_delta_text_append_contract_invalid');
  }
  const blocks = [...turn.blocks];
  blocks[blockIndex] = {
    ...block,
    revision: append.blockRevision,
    summary: `${block.summary}${append.textDelta}`,
    bodyMarkdown: `${block.bodyMarkdown ?? ''}${append.textDelta}`,
    provenance: {
      ...block.provenance,
      sourceEventRefs: [...currentRefs, ...append.sourceEventRefs],
    },
  };
  return { ...turn, blocks };
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
