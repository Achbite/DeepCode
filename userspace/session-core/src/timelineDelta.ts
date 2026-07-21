import type {
  AgentEvent,
  AgentTimelineBlock,
  AgentTimelineDeliveryMode,
  AgentTimelineDelta,
  AgentTimelineResult,
  AgentTimelineStatus,
  ProjectionDelta,
} from '@deepcode/protocol';
import {
  buildNarrativeTimelineProjection,
  buildTimelineProjectionWithLiveOverlay,
} from './projection.js';

const TIMELINE_DELTA_SCHEMA_VERSION = 'deepcode.session.timeline-delta.v1' as const;

export interface CanonicalTimelineCommitResult {
  timeline: AgentTimelineResult;
  deltas: AgentTimelineDelta[];
}

export interface AgentTimelineDeltaApplyResult {
  timeline: AgentTimelineResult;
  status: 'applied' | 'duplicate' | 'stale' | 'gap';
}

export class CanonicalTimelineProjector {
  private committedEvents: AgentEvent[];
  private activeDeltas: ProjectionDelta[] = [];
  private currentTimeline: AgentTimelineResult;

  constructor(
    private readonly sessionId: string,
    initialEvents: AgentEvent[],
    initialTimeline?: AgentTimelineResult
  ) {
    this.committedEvents = [...initialEvents];
    this.currentTimeline =
      initialTimeline?.schemaVersion === 'deepcode.session.timeline.v1' &&
      initialTimeline.sessionId === sessionId
        ? initialTimeline
        : stampTimeline(
            buildNarrativeTimelineProjection({ sessionId, events: initialEvents }),
            undefined,
            0
          );
  }

  push(delta: ProjectionDelta): AgentTimelineDelta[] {
    if (delta.sessionId !== this.sessionId || delta.type === 'committed') return [];
    this.activeDeltas = mergeProjectionDelta(this.activeDeltas, delta);
    const nextSemantic = buildTimelineProjectionWithLiveOverlay({
      sessionId: this.sessionId,
      committedEvents: this.committedEvents,
      activeDeltas: this.activeDeltas,
    });
    const next = stampTimeline(nextSemantic, this.currentTimeline, (this.currentTimeline.revision ?? 0) + 1);
    const deltas = diffTimelines(this.currentTimeline, next, delta.runId ?? 'run', 'live');
    if (deltas.length > 0) this.currentTimeline = next;
    return deltas;
  }

  commit(events: AgentEvent[]): CanonicalTimelineCommitResult {
    const previous = this.currentTimeline;
    this.committedEvents = [...events];
    this.activeDeltas = [];
    const committed = stampTimeline(
      buildNarrativeTimelineProjection({ sessionId: this.sessionId, events }),
      previous,
      (previous.revision ?? 0) + 1
    );
    const runId = latestRunId(events) ?? 'run';
    const deliveryModes = committedDeliveryModes(previous, committed);
    const deltas = [
      ...diffTimelines(previous, committed, runId, 'buffered'),
      timelineSyncedDelta(committed, runId, deliveryModes),
    ];
    this.currentTimeline = committed;
    return { timeline: committed, deltas };
  }

  snapshot(): AgentTimelineResult {
    return this.currentTimeline;
  }
}

export function isAgentTimelineDelta(value: unknown): value is AgentTimelineDelta {
  if (!isRecord(value)) return false;
  return value.schemaVersion === TIMELINE_DELTA_SCHEMA_VERSION &&
    typeof value.op === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.turnId === 'string' &&
    typeof value.turnSeq === 'number' &&
    typeof value.blockId === 'string' &&
    typeof value.blockSeq === 'number' &&
    typeof value.revision === 'number';
}

export function applyAgentTimelineDelta(
  current: AgentTimelineResult | null | undefined,
  delta: AgentTimelineDelta
): AgentTimelineDeltaApplyResult {
  const base = current ?? emptyTimeline(delta.sessionId);
  if (base.sessionId !== delta.sessionId) {
    return { timeline: base, status: 'stale' };
  }

  if (delta.op === 'timeline.synced') {
    if ((base.revision ?? 0) > (delta.timeline.revision ?? delta.revision)) {
      return { timeline: base, status: 'stale' };
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
    schemaVersion: 'deepcode.session.timeline.v1',
    sessionId,
    revision: 0,
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
      deltas.push({
        ...base,
        op: 'block.started',
        block: entry.block,
        deliveryMode: newBlockMode,
      });
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
    deltas.push({
      ...deltaBase(next, runId, entry),
      op: 'block.removed',
      revision: (entry.block.revision ?? 0) + 1,
    });
  }

  return deltas;
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
    sourceEventRefs: entry.block.rawEventRefs,
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
  return [delta.runId ?? 'run', delta.turnId ?? 'turn', delta.type, delta.channel ?? '', identity].join(':');
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
  return JSON.stringify({
    kind: block.kind,
    narrativeKind: block.narrativeKind,
    activity: block.activity,
    title: block.title,
    summary: block.summary,
    status: block.status,
    defaultCollapsed: block.defaultCollapsed,
    bodyMarkdown: block.bodyMarkdown,
    structuredProjection: block.structuredProjection,
    decisionRequest: block.decisionRequest,
    attachments: block.attachments,
    evidenceRefs: block.evidenceRefs,
    rawEventRefs: block.rawEventRefs,
    taskProjectionRef: block.taskProjectionRef,
  });
}

function blockMetadataSignature(block: AgentTimelineBlock): string {
  return JSON.stringify({
    title: block.title,
    summary: block.summary,
    status: block.status,
    structuredProjection: block.structuredProjection,
    decisionRequest: block.decisionRequest,
    rawEventRefs: block.rawEventRefs,
  });
}

function activitySignature(block: AgentTimelineBlock): string {
  return JSON.stringify(block.activity ?? null);
}

function isLiveBlock(block: AgentTimelineBlock): boolean {
  return (block.rawEventRefs ?? []).some((ref) => ref.startsWith('event:live:'));
}

function committedEventIds(block: AgentTimelineBlock): string[] {
  return (block.rawEventRefs ?? [])
    .filter((ref) => ref.startsWith('event:'))
    .map((ref) => ref.slice('event:'.length))
    .filter((id) => !id.startsWith('live:'));
}

function isCompletedStatus(
  status: AgentTimelineStatus
): status is Extract<AgentTimelineStatus, 'completed' | 'waiting' | 'failed' | 'blocked'> {
  return status === 'completed' || status === 'waiting' || status === 'failed' || status === 'blocked';
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
