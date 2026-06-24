import { useEffect, useMemo, useState } from 'react';
import type {
  AgentConversationActivity,
  AgentTimelineTurn,
  ProjectionDelta,
} from '@deepcode/protocol';

export type LiveDisplayTextKind = 'thinking' | 'assistant' | 'draft';

export interface LiveDisplayTextItem {
  type: 'text';
  key: string;
  textKind: LiveDisplayTextKind;
  runId?: string;
  turnId?: string;
  seqStart: number;
  seqEnd: number;
  bodyMarkdown: string;
  sealed: boolean;
  held: boolean;
  deltas: ProjectionDelta[];
}

export interface LiveDisplayActivityItem {
  type: 'activity';
  key: string;
  runId?: string;
  turnId?: string;
  seq: number;
  activity: AgentConversationActivity;
  delta: ProjectionDelta;
}

export type LiveDisplayItem = LiveDisplayTextItem | LiveDisplayActivityItem;

export interface BuildLiveDisplayItemsInput {
  sessionId: string;
  deltas: ProjectionDelta[];
  committedActivityIds?: Set<string>;
}

export interface LivePlaybackOptions {
  enabled?: boolean;
  holdMs?: number;
}

export interface LivePlaybackResult {
  visibleItems: LiveDisplayItem[];
  isHolding: boolean;
}

export function buildLiveDisplayItems(input: BuildLiveDisplayItemsInput): LiveDisplayItem[] {
  const committedActivityIds = input.committedActivityIds ?? new Set<string>();
  const active = input.deltas
    .filter((delta) => delta.sessionId === input.sessionId && delta.type !== 'committed')
    .filter((delta) => !isBranchProjectionDelta(delta))
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));

  const items: LiveDisplayItem[] = [];
  let textSegmentKind: LiveDisplayTextKind | null = null;
  let textSegmentStartKey = '';
  let textSegmentBody = '';
  let textSegmentDeltas: ProjectionDelta[] = [];
  let textSegmentSeqStart = 0;
  let textSegmentSeqEnd = 0;

  const resetTextSegment = () => {
    textSegmentKind = null;
    textSegmentStartKey = '';
    textSegmentBody = '';
    textSegmentDeltas = [];
    textSegmentSeqStart = 0;
    textSegmentSeqEnd = 0;
  };

  const flushTextSegment = () => {
    if (!textSegmentKind || !textSegmentBody.trim()) {
      resetTextSegment();
      return;
    }
    const firstDelta = textSegmentDeltas[0];
    items.push({
      type: 'text',
      key: `text:${textSegmentKind}:${firstDelta?.runId ?? 'run'}:${textSegmentStartKey}`,
      textKind: textSegmentKind,
      runId: firstDelta?.runId,
      turnId: firstDelta?.turnId,
      seqStart: textSegmentSeqStart,
      seqEnd: textSegmentSeqEnd,
      bodyMarkdown: textSegmentBody,
      sealed: false,
      held: false,
      deltas: textSegmentDeltas,
    });
    resetTextSegment();
  };

  const appendTextSegment = (kind: LiveDisplayTextKind, delta: ProjectionDelta, index: number) => {
    if (textSegmentKind && textSegmentKind !== kind) {
      flushTextSegment();
    }
    if (!textSegmentKind) {
      textSegmentKind = kind;
      textSegmentStartKey = activeDeltaSegmentKey(delta, index);
      textSegmentSeqStart = delta.seq ?? index;
    }
    textSegmentSeqEnd = delta.seq ?? index;
    textSegmentBody += delta.delta ?? '';
    textSegmentDeltas.push(delta);
  };

  for (let index = 0; index < active.length; index += 1) {
    const delta = active[index];
    const textKind = liveTextKind(delta);
    if (textKind && typeof delta.delta === 'string') {
      appendTextSegment(textKind, delta, index);
      continue;
    }

    const activity = delta.activity;
    if (activity && !committedActivityIds.has(activity.activityId) && isMainTimelineActivity(activity)) {
      flushTextSegment();
      items.push({
        type: 'activity',
        key: `activity:${activity.activityId}`,
        runId: delta.runId ?? activity.runId,
        turnId: delta.turnId,
        seq: delta.seq ?? index,
        activity,
        delta,
      });
    }
  }
  flushTextSegment();

  return markSealedTextItems(items);
}

export function useLiveTimelinePlayback(
  items: LiveDisplayItem[],
  options: LivePlaybackOptions = {}
): LivePlaybackResult {
  const enabled = options.enabled ?? true;
  const holdMs = options.holdMs ?? 1000;
  const itemKeySignature = useMemo(() => items.map((item) => item.key).join('|'), [items]);
  const [heldTextKeys, setHeldTextKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const currentKeys = new Set(items.map((item) => item.key));
    setHeldTextKeys((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of current) {
        if (currentKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed || next.size !== current.size ? next : current;
    });
  }, [itemKeySignature, items]);

  const blockingTextKey = useMemo(() => {
    if (!enabled) return null;
    for (let index = 0; index < items.length - 1; index += 1) {
      const item = items[index];
      if (item.type === 'text' && item.sealed && !heldTextKeys.has(item.key)) {
        return item.key;
      }
    }
    return null;
  }, [enabled, heldTextKeys, items]);

  useEffect(() => {
    if (!enabled || !blockingTextKey) return undefined;
    const timer = window.setTimeout(() => {
      setHeldTextKeys((current) => {
        if (current.has(blockingTextKey)) return current;
        const next = new Set(current);
        next.add(blockingTextKey);
        return next;
      });
    }, holdMs);
    return () => window.clearTimeout(timer);
  }, [blockingTextKey, enabled, holdMs]);

  const visibleItems = useMemo(() => {
    if (!enabled) {
      return items.map((item) => markItemHeld(item, true));
    }

    const visible: LiveDisplayItem[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.type !== 'text') {
        visible.push(item);
        continue;
      }

      const held = !item.sealed || heldTextKeys.has(item.key);
      visible.push(markItemHeld(item, held));
      if (item.sealed && !held && index < items.length - 1) {
        break;
      }
    }
    return visible;
  }, [enabled, heldTextKeys, items]);

  return {
    visibleItems,
    isHolding: Boolean(blockingTextKey),
  };
}

export function flattenLiveDisplayDeltas(items: LiveDisplayItem[]): ProjectionDelta[] {
  return items.flatMap((item) => item.type === 'text' ? item.deltas : [item.delta]);
}

export function liveDisplayStatus(items: LiveDisplayItem[]): AgentTimelineTurn['status'] {
  const deltas = flattenLiveDisplayDeltas(items);
  if (deltas.some((delta) => delta.status === 'failed' || delta.type === 'error')) return 'failed';
  const latest = deltas[deltas.length - 1];
  if (latest?.status === 'waiting') return 'waiting';
  return 'running';
}

export function isBranchProjectionDelta(delta: ProjectionDelta): boolean {
  return Boolean(delta.branchId || delta.subAgentId || delta.mergeGroupId);
}

export function isMainTimelineActivity(activity: AgentConversationActivity): boolean {
  return activity.kind !== 'providerThinking'
    && activity.kind !== 'subagentBranch'
    && activity.kind !== 'subagentMerge';
}

function liveTextKind(delta: ProjectionDelta): LiveDisplayTextKind | null {
  if (delta.type === 'part_delta' && delta.channel === 'reasoning') return 'thinking';
  if (delta.type === 'reasoning_delta') return 'thinking';
  if (delta.type === 'assistant_delta') return 'assistant';
  if (
    (delta.type === 'draft_delta' || delta.type === 'part_delta') &&
    (delta.channel === 'draft' || !delta.channel)
  ) {
    return 'draft';
  }
  return null;
}

function markSealedTextItems(items: LiveDisplayItem[]): LiveDisplayItem[] {
  return items.map((item, index) => {
    if (item.type !== 'text') return item;
    return {
      ...item,
      sealed: index < items.length - 1,
    };
  });
}

function markItemHeld(item: LiveDisplayItem, held: boolean): LiveDisplayItem {
  if (item.type !== 'text') return item;
  if (item.held === held) return item;
  return {
    ...item,
    held,
  };
}

function activeDeltaSegmentKey(delta: ProjectionDelta, index: number): string {
  const seqKey = typeof delta.seq === 'number' ? String(delta.seq) : `idx-${index}`;
  return safeDisplayKey(seqKey);
}

function safeDisplayKey(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'item';
}
