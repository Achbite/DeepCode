import { useEffect, useMemo, useState } from 'react';
import type {
  AgentConversationActivity,
  AgentTimelineTurn,
  ProjectionDelta,
} from '@deepcode/protocol';
import { isMainTimelineActivityShape } from '@deepcode/session-core';

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
      const last = items[items.length - 1];
      if (last && last.type === 'activity' && activityOperationKey(last.activity) === activityOperationKey(activity)) {
        // 合并连续的同操作生命周期事件，保留最新状态/标题，避免一次读取被拆成多块
        items[items.length - 1] = {
          ...last,
          key: `activity:${activity.activityId}`,
          runId: delta.runId ?? activity.runId,
          turnId: delta.turnId,
          seq: delta.seq ?? index,
          activity,
          delta,
        };
        continue;
      }
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

// P5-lite：判定规则统一抽至 @deepcode/session-core/timelineFilter，live 与 final 共用同一套规则，
// 消除两套独立过滤实现的漂移隐患。此处仅做 AgentConversationActivity 形状适配，规则本身在 session-core。
export function isMainTimelineActivity(activity: AgentConversationActivity): boolean {
  return isMainTimelineActivityShape({ kind: activity.kind, toolName: activity.toolName ?? undefined });
}

// 同一逻辑操作（同工具 + 同目标）的连续生命周期事件归并键，用于 live 去重合并。
function activityOperationKey(activity: AgentConversationActivity): string {
  const targets = (activity.targets ?? []).slice().sort().join('|');
  return `${activity.toolName ?? activity.kind}::${targets}`;
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
