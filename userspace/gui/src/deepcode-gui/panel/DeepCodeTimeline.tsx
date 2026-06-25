import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentConversationActivity,
  AgentContextAttachment,
  AgentEvent,
  AgentTimelineBlock,
  AgentTimelineResult,
  AgentTimelineTurn,
  ProjectionDelta,
} from '@deepcode/protocol';
import { buildNarrativeTimelineProjection, isInternalOrchestrationStage } from '@deepcode/session-core';
import { t, resolveDiagnosticText, type UiLanguage } from '../../i18n';
import { submitAgentFeedback } from '../../services/runtimeAdapter';
import MarkdownContent from '../../components/agent-panel/LazyMarkdownContent';
import ToolEvidenceDetails from '../../components/agent-panel/ToolEvidenceDetails';
import {
  buildLiveDisplayItems,
  flattenLiveDisplayDeltas,
  liveDisplayStatus,
  useLiveTimelinePlayback,
  type LiveDisplayItem,
} from '../../components/agent-panel/liveTimelinePlayback';
import { useSettingsStore } from '../../state/settingsStore';
import { formatToolEvidence } from '../../utils/toolEvidence';

interface DeepCodeTimelineProps {
  timeline: AgentTimelineResult | null;
  fallbackEvents: AgentEvent[];
  loading: boolean;
  language: UiLanguage;
  activeDeltas?: ProjectionDelta[];
  followLatestSignal?: number;
  scrollWatchElement?: HTMLElement | null;
  onTypewriterActiveChange?: (active: boolean) => void;
  onPlanResolve?: (
    runId: string,
    planId: string,
    decision: 'accept' | 'reject' | 'revise',
    guidance?: string
  ) => void;
}

type TypewriterSpeed = NonNullable<NonNullable<AgentTimelineBlock['displayHints']>['typewriterSpeed']>;
type TimelineFollowMode = 'following' | 'detached';

const DeepCodeTimeline: React.FC<DeepCodeTimelineProps> = ({
  timeline,
  fallbackEvents,
  loading,
  language,
  activeDeltas = [],
  followLatestSignal = 0,
  scrollWatchElement = null,
  onTypewriterActiveChange,
  onPlanResolve,
}) => {
  const fallbackTimeline = useMemo(
    () => buildNarrativeTimelineProjection({
      sessionId: fallbackEvents[0]?.sessionId ?? 'session',
      events: fallbackEvents,
    }),
    [fallbackEvents]
  );
  const view = useMemo(
    () => normalizeNarrativeTimeline(timeline ?? fallbackTimeline),
    [fallbackTimeline, timeline]
  );
  const coalescedActiveDeltas = useCoalescedProjectionDeltas(activeDeltas, 50);
  const committedActivityIds = useMemo(() => collectCommittedActivityIds(view), [view]);
  const liveDisplayItems = useMemo(
    () => buildLiveDisplayItems({
      sessionId: view.sessionId,
      deltas: coalescedActiveDeltas,
      committedActivityIds,
    }),
    [coalescedActiveDeltas, committedActivityIds, view.sessionId]
  );
  const livePlayback = useLiveTimelinePlayback(liveDisplayItems, {
    enabled: loading,
    holdMs: 1000,
  });
  const viewWithActive = useMemo(
    () => appendLiveDisplayTurn(view, livePlayback.visibleItems, language),
    [language, livePlayback.visibleItems, view]
  );
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineContentRef = useRef<HTMLDivElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const followModeRef = useRef<TimelineFollowMode>('following');
  const userDetachedFromLatestRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const suppressScrollEventsUntilRef = useRef(0);
  const liveScrollFrameRef = useRef<number | null>(null);
  const liveScrollTimeoutRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const scrollSignature = useMemo(
    () => timelineScrollSignature(viewWithActive, loading),
    [viewWithActive, loading]
  );
  const typewriterEnabled = useSettingsStore((s) =>
    Boolean(s.effectiveSettings['gui.typewriterAnimation'] ?? true)
  );
  const timelineDensity = useSettingsStore((s) =>
    String(s.effectiveSettings['gui.timelineDensity'] ?? 'normal')
  );
  const collapseCompletedThinking = useSettingsStore((s) =>
    Boolean(s.effectiveSettings['gui.collapseCompletedThinking'] ?? true)
  );
  const typewriterBlockIds = useTypewriterBlockIds(viewWithActive, loading && typewriterEnabled);
  const typewriterBlockLengths = useMemo(
    () => collectTypewriterBlockLengths(viewWithActive, typewriterBlockIds),
    [typewriterBlockIds, viewWithActive]
  );
  const typewriterBlockLengthSignature = useMemo(
    () => [...typewriterBlockLengths.entries()]
      .map(([blockId, textLength]) => `${blockId}:${textLength}`)
      .sort()
      .join('|'),
    [typewriterBlockLengths]
  );
  const [completedTypewriterBlockLengths, setCompletedTypewriterBlockLengths] = useState<Map<string, number>>(
    () => new Map()
  );
  const timelineDensityClass = timelineDensity === 'compact' ? ' deepcode-gui-timeline--compact' : '';
  const hasPendingTypewriter = useMemo(() => {
    for (const [blockId, textLength] of typewriterBlockLengths) {
      if ((completedTypewriterBlockLengths.get(blockId) ?? 0) < textLength) return true;
    }
    return false;
  }, [completedTypewriterBlockLengths, typewriterBlockLengths]);
  const hasPendingPlayback = hasPendingTypewriter || livePlayback.isHolding;

  useEffect(() => {
    setCompletedTypewriterBlockLengths((current) => {
      let changed = false;
      const next = new Map<string, number>();
      for (const [blockId, completedLength] of current) {
        if (typewriterBlockLengths.get(blockId) === completedLength) {
          next.set(blockId, completedLength);
        } else {
          changed = true;
        }
      }
      return changed || next.size !== current.size ? next : current;
    });
  }, [typewriterBlockLengthSignature, typewriterBlockLengths]);

  useEffect(() => {
    onTypewriterActiveChange?.(hasPendingPlayback);
  }, [hasPendingPlayback, onTypewriterActiveChange]);

  useEffect(() => () => {
    onTypewriterActiveChange?.(false);
  }, [onTypewriterActiveChange]);

  const markTypewriterComplete = useCallback((blockId: string, textLength: number) => {
    setCompletedTypewriterBlockLengths((current) => {
      if ((current.get(blockId) ?? 0) >= textLength) return current;
      const next = new Map(current);
      next.set(blockId, textLength);
      return next;
    });
  }, []);

  const setFollowMode = useCallback((mode: TimelineFollowMode) => {
    followModeRef.current = mode;
    if (mode === 'following') {
      userDetachedFromLatestRef.current = false;
      userScrollIntentRef.current = false;
    } else {
      userDetachedFromLatestRef.current = true;
      setShowJumpToLatest(true);
    }
  }, []);

  const resolveScrollContainer = useCallback(() => {
    const cached = scrollContainerRef.current;
    if (cached && document.contains(cached)) return cached;
    const container = findTimelineScrollContainer(timelineRef.current);
    scrollContainerRef.current = container;
    return container;
  }, []);

  const syncJumpToLatestVisibility = useCallback((container: HTMLElement | null) => {
    if (!container) return;
    const nextVisible = userDetachedFromLatestRef.current || !isAtScrollEnd(container);
    setShowJumpToLatest((visible) => visible === nextVisible ? visible : nextVisible);
  }, []);

  const scrollToTimelineEndNow = useCallback(() => {
    const container = resolveScrollContainer();
    if (!container) return;

    suppressScrollEventsUntilRef.current = window.performance.now() + 220;
    container.scrollTop = maxScrollTop(container);
    lastScrollTopRef.current = container.scrollTop;
    syncJumpToLatestVisibility(container);
  }, [resolveScrollContainer, syncJumpToLatestVisibility]);

  const scrollToTimelineEnd = useCallback((options?: { requireFollowing?: boolean }) => {
    const run = () => {
      if (options?.requireFollowing && followModeRef.current !== 'following') return;
      scrollToTimelineEndNow();
    };

    run();
    if (liveScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(liveScrollFrameRef.current);
    }
    liveScrollFrameRef.current = window.requestAnimationFrame(() => {
      liveScrollFrameRef.current = null;
      run();
      window.requestAnimationFrame(run);
    });
    if (liveScrollTimeoutRef.current !== null) {
      window.clearTimeout(liveScrollTimeoutRef.current);
    }
    liveScrollTimeoutRef.current = window.setTimeout(() => {
      liveScrollTimeoutRef.current = null;
      run();
    }, 80);
  }, [scrollToTimelineEndNow]);

  const enableFollowAndJumpToLatest = useCallback(() => {
    setFollowMode('following');
    scrollToTimelineEnd({ requireFollowing: true });
  }, [scrollToTimelineEnd, setFollowMode]);

  const scrollToTimelineEndIfFollowing = useCallback(() => {
    if (followModeRef.current !== 'following') return;
    scrollToTimelineEnd({ requireFollowing: true });
  }, [scrollToTimelineEnd]);

  useEffect(() => () => {
    if (liveScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(liveScrollFrameRef.current);
    }
    if (liveScrollTimeoutRef.current !== null) {
      window.clearTimeout(liveScrollTimeoutRef.current);
    }
  }, []);

  const detachFromLatestForUserScroll = useCallback(() => {
    userScrollIntentRef.current = true;
    setFollowMode('detached');
  }, [setFollowMode]);

  const markUserScrollIntent = useCallback((event?: Event) => {
    if (event instanceof WheelEvent) {
      if (event.deltaY < 0) {
        detachFromLatestForUserScroll();
      }
      return;
    }
    if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
      if (event.type === 'touchend' || event.type === 'touchcancel') {
        lastTouchYRef.current = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      if (event.type === 'touchstart') {
        lastTouchYRef.current = touch.clientY;
        return;
      }
      const previousY = lastTouchYRef.current;
      lastTouchYRef.current = touch.clientY;
      if (previousY !== null && touch.clientY > previousY + 2) {
        detachFromLatestForUserScroll();
      }
      return;
    }
    if (event instanceof KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return;
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        detachFromLatestForUserScroll();
      }
      return;
    }
    if (window.performance.now() < suppressScrollEventsUntilRef.current) return;
  }, [detachFromLatestForUserScroll]);

  useEffect(() => {
    const scrollContainer = resolveScrollContainer();
    if (!scrollContainer) return undefined;
    lastScrollTopRef.current = scrollContainer.scrollTop;

    const updateShouldFollow = () => {
      const currentScrollTop = scrollContainer.scrollTop;
      const scrollingDown = currentScrollTop > lastScrollTopRef.current + 2;
      lastScrollTopRef.current = currentScrollTop;
      if (window.performance.now() < suppressScrollEventsUntilRef.current) {
        syncJumpToLatestVisibility(scrollContainer);
        return;
      }
      if (scrollingDown && userDetachedFromLatestRef.current && isAtScrollEnd(scrollContainer)) {
        setFollowMode('following');
        scrollToTimelineEnd({ requireFollowing: true });
        return;
      }
      if (isNearScrollBottom(scrollContainer)) {
        syncJumpToLatestVisibility(scrollContainer);
        return;
      }
      if (userScrollIntentRef.current) {
        setFollowMode('detached');
      } else {
        syncJumpToLatestVisibility(scrollContainer);
      }
    };

    updateShouldFollow();
    scrollContainer.addEventListener('wheel', markUserScrollIntent, { passive: true });
    scrollContainer.addEventListener('touchstart', markUserScrollIntent, { passive: true });
    scrollContainer.addEventListener('touchmove', markUserScrollIntent, { passive: true });
    scrollContainer.addEventListener('touchend', markUserScrollIntent, { passive: true });
    scrollContainer.addEventListener('touchcancel', markUserScrollIntent, { passive: true });
    scrollContainer.addEventListener('keydown', markUserScrollIntent, { passive: true });
    scrollContainer.addEventListener('scroll', updateShouldFollow, { passive: true });
    return () => {
      scrollContainer.removeEventListener('wheel', markUserScrollIntent);
      scrollContainer.removeEventListener('touchstart', markUserScrollIntent);
      scrollContainer.removeEventListener('touchmove', markUserScrollIntent);
      scrollContainer.removeEventListener('touchend', markUserScrollIntent);
      scrollContainer.removeEventListener('touchcancel', markUserScrollIntent);
      scrollContainer.removeEventListener('keydown', markUserScrollIntent);
      scrollContainer.removeEventListener('scroll', updateShouldFollow);
    };
  }, [markUserScrollIntent, resolveScrollContainer, scrollToTimelineEnd, setFollowMode, syncJumpToLatestVisibility]);

  useLayoutEffect(() => {
    enableFollowAndJumpToLatest();
  }, [enableFollowAndJumpToLatest, viewWithActive.sessionId]);

  useLayoutEffect(() => {
    enableFollowAndJumpToLatest();
  }, [enableFollowAndJumpToLatest, followLatestSignal]);

  useLayoutEffect(() => {
    if (followModeRef.current !== 'following') return;
    scrollToTimelineEnd({ requireFollowing: true });
  }, [loading, scrollSignature, scrollToTimelineEnd]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const targets = [timelineContentRef.current, scrollWatchElement]
      .filter((target): target is HTMLElement => Boolean(target));
    const uniqueTargets = Array.from(new Set(targets));
    if (uniqueTargets.length === 0) return undefined;
    const observer = new ResizeObserver(() => {
      if (followModeRef.current === 'following') {
        scrollToTimelineEndIfFollowing();
      }
    });
    uniqueTargets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [scrollToTimelineEndIfFollowing, scrollWatchElement]);

  return (
    <div className={`deepcode-gui-timeline${timelineDensityClass}`} ref={timelineRef}>
      <div className="deepcode-gui-timeline__content" ref={timelineContentRef}>
        {viewWithActive.turns.length === 0 && !loading && (
          <div className="deepcode-gui-empty">
            <div className="deepcode-gui-empty__title">{t(language, 'deepcodeGui.status.ready')}</div>
          </div>
        )}
        {viewWithActive.turns.map((turn) => (
          <TurnCard
            key={turn.id}
            turn={turn}
            language={language}
            typewriterBlockIds={typewriterBlockIds}
            collapseCompletedThinking={collapseCompletedThinking}
            onLiveContentChange={scrollToTimelineEndIfFollowing}
            onTypewriterComplete={markTypewriterComplete}
            onPlanResolve={onPlanResolve}
          />
        ))}
        {loading && (
          <div className="deepcode-gui-live-indicator">
            <span className="deepcode-gui-live-indicator__dot" />
            {t(language, 'deepcodeGui.status.running')}
          </div>
        )}
        <div ref={timelineEndRef} className="deepcode-gui-timeline__end" aria-hidden="true" />
      </div>
      {showJumpToLatest && (
        <button
          type="button"
          className="deepcode-gui-timeline-jump-latest"
          aria-label={t(language, 'deepcodeGui.timeline.jumpLatest')}
          title={t(language, 'deepcodeGui.timeline.jumpLatest')}
          onClick={enableFollowAndJumpToLatest}
        >
          ↓
        </button>
      )}
    </div>
  );
};

function appendLiveDisplayTurn(
  view: AgentTimelineResult,
  items: LiveDisplayItem[],
  language: UiLanguage
): AgentTimelineResult {
  if (items.length === 0) return view;

  const deltas = flattenLiveDisplayDeltas(items);
  const runId = items.find((item) => item.runId)?.runId ?? 'active-run';
  const turnId = items.find((item) => item.turnId)?.turnId ?? `active-${runId}`;
  const status = liveDisplayStatus(items);
  const blocks = items
    .map((item) => item.type === 'activity'
      ? activityBlockFromActivity(item.activity, language, true)
      : textBlockFromLiveDisplayItem(item, runId, status, language))
    .filter((block): block is AgentTimelineBlock => Boolean(block));
  if (blocks.length === 0) return view;

  return {
    ...view,
    turns: [
      ...view.turns,
      {
        id: `active-${turnId}`,
        sessionId: view.sessionId,
        status,
        startedAt: deltas[0]?.payload && isRecord(deltas[0].payload)
          ? stringField(deltas[0].payload, 'startedAt')
          : undefined,
        blocks,
      },
    ],
  };
}

function textBlockFromLiveDisplayItem(
  item: Extract<LiveDisplayItem, { type: 'text' }>,
  runId: string,
  activeStatus: AgentTimelineTurn['status'],
  language: UiLanguage
): AgentTimelineBlock | null {
  if (!item.bodyMarkdown.trim()) return null;
  const segmentStatus = item.sealed ? 'completed' : activeStatus;
  const shouldType = !item.sealed;
  const sealedThinkingHeld = item.textKind === 'thinking' && item.sealed && item.held;

  if (item.textKind === 'thinking') {
    return {
      id: `active-thinking-${safeActiveBlockId(runId)}-${safeActiveBlockId(item.key)}`,
      kind: 'thinking',
      narrativeKind: 'thinking',
      title: t(language, 'deepcodeGui.timeline.thinking'),
      summary: t(language, 'deepcodeGui.timeline.reasoningStreaming'),
      status: segmentStatus,
      defaultCollapsed: sealedThinkingHeld,
      bodyMarkdown: item.bodyMarkdown,
      displayHints: shouldType
        ? {
            renderMode: 'typewriter',
            typewriterSpeed: 'slow',
            initialOpen: true,
            replaceOnComplete: true,
          }
        : {
            renderMode: 'instant',
            initialOpen: !sealedThinkingHeld,
            replaceOnComplete: true,
          },
      events: [],
    };
  }

  if (item.textKind === 'assistant') {
    return {
      id: `active-assistant-${safeActiveBlockId(runId)}-${safeActiveBlockId(item.key)}`,
      kind: 'assistant',
      narrativeKind: 'assistantText',
      title: 'DeepCode',
      summary: t(language, 'deepcodeGui.timeline.responding'),
      status: segmentStatus,
      defaultCollapsed: false,
      bodyMarkdown: item.bodyMarkdown,
      displayHints: shouldType
        ? {
            renderMode: 'typewriter',
            typewriterSpeed: 'normal',
            replaceOnComplete: true,
          }
        : {
            renderMode: 'instant',
            replaceOnComplete: true,
          },
      events: [],
    };
  }

  return {
    id: `active-draft-${safeActiveBlockId(runId)}-${safeActiveBlockId(item.key)}`,
    kind: 'stage',
    narrativeKind: 'operationEvidence',
    title: t(language, 'deepcodeGui.timeline.editDraft'),
    summary: t(language, 'deepcodeGui.timeline.editDraftStreaming'),
    status: segmentStatus,
    defaultCollapsed: false,
    bodyMarkdown: item.bodyMarkdown,
    displayHints: shouldType
      ? {
          renderMode: 'typewriter',
          typewriterSpeed: 'normal',
          replaceOnComplete: true,
        }
      : {
          renderMode: 'instant',
          replaceOnComplete: true,
        },
    events: [],
  };
}

function collectCommittedActivityIds(view: AgentTimelineResult): Set<string> {
  const ids = new Set<string>();
  for (const turn of view.turns) {
    for (const block of turn.blocks) {
      const activityId = block.activity?.activityId;
      if (activityId) ids.add(activityId);
    }
  }
  return ids;
}

function activityBlockFromActivity(
  activity: AgentConversationActivity,
  language: UiLanguage,
  live: boolean
): AgentTimelineBlock {
  return {
    id: `${live ? 'active-' : ''}activity-${safeActiveBlockId(activity.activityId)}`,
    kind: activityBlockKind(activity),
    narrativeKind: activity.kind === 'diagnostic' ? 'diagnostic' : 'operationEvidence',
    activity,
    title: activity.title || activityKindLabel(language, activity.kind),
    summary: activity.summary,
    status: activity.status,
    defaultCollapsed: activity.status !== 'running' && activity.status !== 'waiting' && activity.status !== 'failed',
    bodyMarkdown: activityBodyMarkdown(activity, language),
    displayHints: {
      renderMode: 'instant',
      density: 'compact',
      evidenceMode: activity.status === 'failed' ? 'inline' : 'collapsed',
      replaceOnComplete: live,
    },
    events: [],
  };
}

function activityBlockKind(activity: AgentConversationActivity): AgentTimelineBlock['kind'] {
  if (activity.kind === 'diagnostic' || activity.status === 'failed') return 'error';
  if (activity.kind === 'reviewCheckpoint') return 'review';
  if (activity.kind === 'toolExecution') return 'toolBatch';
  return 'stage';
}

function activityKindLabel(language: UiLanguage, kind: AgentConversationActivity['kind']): string {
  return t(language, `deepcodeGui.activity.kind.${kind}`);
}

function activityBodyMarkdown(activity: AgentConversationActivity, language: UiLanguage): string {
  const rows: string[] = [];
  const summary = visibleActivitySummary(activity);
  if (summary) rows.push(summary);
  const targets = visibleActivityTargets(activity.targets ?? []);
  if (targets.length) {
    rows.push(`**${activityTargetsLabel(activity, language)}**: ${targets.join(', ')}`);
  }
  if (activity.toolName) {
    rows.push(`**${t(language, 'deepcodeGui.activity.tool')}**: ${displayToolName(activity.toolName)}`);
  }
  if (activity.errorCode || activity.errorMessage) {
    rows.push(`**${t(language, 'deepcodeGui.activity.error')}**: ${[activity.errorCode, activity.errorMessage].filter(Boolean).join(' - ')}`);
  }
  return rows.map((line) => `- ${line}`).join('\n');
}

function visibleActivitySummary(activity: AgentConversationActivity): string {
  const summary = (activity.summary ?? '').trim();
  if (!summary) return '';
  if (activity.kind === 'diagnostic' || activity.status === 'failed') {
    return summary;
  }
  return '';
}

function visibleActivityTargets(targets: string[]): string[] {
  const visible: string[] = [];
  for (const target of targets) {
    const normalized = target.trim();
    if (!normalized || isInternalDisplayToken(normalized)) continue;
    if (visible.includes(normalized)) continue;
    visible.push(normalized);
  }
  return visible;
}

function isInternalDisplayToken(value: string): boolean {
  return /^(native-call|attachment|work-unit|resource-request|resource-item|kernel-activity)[_-]/i.test(value) ||
    /^turn-[a-z_]+-/i.test(value);
}

function displayToolName(toolName: string): string {
  return toolName.replace(/__/g, '.').trim();
}

function activityTargetsLabel(activity: AgentConversationActivity, language: UiLanguage): string {
  if (activity.kind === 'resourceRead' || activity.kind === 'resourceSearch') {
    return t(language, 'deepcodeGui.activity.filesRead');
  }
  if (activity.kind === 'editBatchQueued' || activity.kind === 'editFileStarted' || activity.kind === 'editFileCompleted' || activity.kind === 'editFileFailed') {
    return t(language, 'deepcodeGui.activity.filesChanged');
  }
  return t(language, 'deepcodeGui.activity.targets');
}

function safeActiveBlockId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'branch';
}

function findTimelineScrollContainer(timelineElement: HTMLElement | null): HTMLElement | null {
  let element = timelineElement;
  let firstScrollableStyleElement: HTMLElement | null = null;

  while (element) {
    const style = window.getComputedStyle(element);
    const hasScrollableStyle = style.overflowY === 'auto'
      || style.overflowY === 'scroll'
      || style.overflowY === 'overlay';

    if (hasScrollableStyle && !firstScrollableStyleElement) {
      firstScrollableStyleElement = element;
    }
    if (hasScrollableStyle && element.scrollHeight > element.clientHeight + 1) {
      return element;
    }
    element = element.parentElement;
  }

  return firstScrollableStyleElement ?? timelineElement;
}

function maxScrollTop(container: HTMLElement): number {
  return Math.max(0, container.scrollHeight - container.clientHeight);
}

function isAtScrollEnd(container: HTMLElement, thresholdPx = 8): boolean {
  return maxScrollTop(container) - container.scrollTop <= thresholdPx;
}

function isNearScrollBottom(container: HTMLElement, thresholdPx = 140): boolean {
  return maxScrollTop(container) - container.scrollTop <= thresholdPx;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

function timelineScrollSignature(view: AgentTimelineResult, loading: boolean): string {
  const lastTurn = view.turns[view.turns.length - 1];
  if (!lastTurn) return `empty:${loading ? 'running' : 'idle'}`;
  const blockSignature = lastTurn.blocks
    .map((block) => {
      const eventCount = block.events?.length ?? 0;
      const bodyLength = block.bodyMarkdown?.length ?? 0;
      return `${block.id}:${block.kind}:${block.status}:${eventCount}:${bodyLength}`;
    })
    .join('|');
  return `${lastTurn.id}:${lastTurn.status}:${loading ? 'running' : 'idle'}:${blockSignature}`;
}

function useTypewriterBlockIds(
  view: AgentTimelineResult,
  loading: boolean
): Set<string> {
  const activeSessionIdRef = useRef<string | null>(null);
  const seenBlockIdsRef = useRef<Set<string>>(new Set());
  const typewriterBlockIdsRef = useRef<Set<string>>(new Set());
  const liveSessionIdRef = useRef<string | null>(null);

  return useMemo(() => {
    const sessionId = view.sessionId;
    const candidateIds = collectTypewriterBlockIds(view);

    if (activeSessionIdRef.current !== sessionId) {
      activeSessionIdRef.current = sessionId;
      seenBlockIdsRef.current = new Set(candidateIds);
      typewriterBlockIdsRef.current = new Set();
      liveSessionIdRef.current = loading ? sessionId : null;
      return new Set<string>();
    }

    if (loading) {
      liveSessionIdRef.current = sessionId;
    }
    const shouldAnimateNewAssistant = liveSessionIdRef.current === sessionId;
    for (const blockId of candidateIds) {
      if (seenBlockIdsRef.current.has(blockId)) continue;
      seenBlockIdsRef.current.add(blockId);
      if (shouldAnimateNewAssistant) {
        typewriterBlockIdsRef.current.add(blockId);
      }
    }

    return new Set(typewriterBlockIdsRef.current);
  }, [loading, view]);
}

function useCoalescedProjectionDeltas(deltas: ProjectionDelta[], delayMs: number): ProjectionDelta[] {
  const [coalesced, setCoalesced] = useState(deltas);
  const latestRef = useRef(deltas);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    latestRef.current = deltas;
    if (timerRef.current !== null) return undefined;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCoalesced(latestRef.current);
    }, delayMs);
    return undefined;
  }, [deltas, delayMs]);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return coalesced;
}

function collectTypewriterBlockIds(view: AgentTimelineResult): string[] {
  return view.turns.flatMap((turn) =>
    turn.blocks
      .filter(shouldAnimateTimelineBlock)
      .filter((block) => visibleTypewriterMarkdown(block).length > 0)
      .map((block) => block.id)
  );
}

function collectTypewriterBlockLengths(
  view: AgentTimelineResult,
  blockIds: Set<string>
): Map<string, number> {
  const lengths = new Map<string, number>();
  for (const turn of view.turns) {
    for (const block of turn.blocks) {
      if (!blockIds.has(block.id)) continue;
      const textLength = visibleTypewriterMarkdown(block).length;
      if (textLength > 0) lengths.set(block.id, textLength);
    }
  }
  return lengths;
}

function shouldAnimateTimelineBlock(block: AgentTimelineBlock): boolean {
  return block.displayHints?.renderMode === 'typewriter' ||
    block.displayHints?.renderMode === 'accelerated' ||
    block.narrativeKind === 'assistantText' ||
    block.narrativeKind === 'requirement' ||
    block.kind === 'plan' ||
    block.kind === 'review' ||
    (!block.narrativeKind && block.kind === 'assistant');
}

function normalizeNarrativeTimeline(view: AgentTimelineResult): AgentTimelineResult {
  if (view.schemaVersion === 'deepcode.session.timeline.v1') return view;
  const events = view.turns.flatMap((turn) => turn.blocks.flatMap((block) => block.events));
  if (events.length === 0) return view;
  return buildNarrativeTimelineProjection({
    sessionId: view.sessionId,
    events,
    generatedAt: view.generatedAt,
  });
}

const TurnCard: React.FC<{
  turn: AgentTimelineTurn;
  language: UiLanguage;
  typewriterBlockIds: Set<string>;
  collapseCompletedThinking: boolean;
  onLiveContentChange: () => void;
  onTypewriterComplete: (blockId: string, textLength: number) => void;
  onPlanResolve?: DeepCodeTimelineProps['onPlanResolve'];
}> = ({ turn, language, typewriterBlockIds, collapseCompletedThinking, onLiveContentChange, onTypewriterComplete, onPlanResolve }) => {
  const startedAtLabel = formatTurnTime(turn.startedAt);
  const blocks = turn.blocks.filter(isVisibleTimelineBlock);
  if (blocks.length === 0) return null;

  return (
    <section className={`deepcode-gui-turn deepcode-gui-turn--${turn.status}`}>
      <div className="deepcode-gui-turn__rail" />
      <div className="deepcode-gui-turn__body">
        <div className="deepcode-gui-turn__meta">
          <span>{timelineStatusLabel(language, turn.status)}</span>
          {startedAtLabel && <span>{startedAtLabel}</span>}
        </div>
        {blocks.map((block) => (
          <TimelineBlock
            key={block.id}
            block={block}
            language={language}
            animateAssistant={typewriterBlockIds.has(block.id)}
            collapseCompletedThinking={collapseCompletedThinking}
            onLiveContentChange={onLiveContentChange}
            onTypewriterComplete={onTypewriterComplete}
            onPlanResolve={onPlanResolve}
          />
        ))}
        <TurnActionBar turn={turn} blocks={blocks} language={language} />
      </div>
    </section>
  );
};

const TurnActionBar: React.FC<{
  turn: AgentTimelineTurn;
  blocks: AgentTimelineBlock[];
  language: UiLanguage;
}> = ({ turn, blocks, language }) => {
  const [status, setStatus] = useState<'idle' | 'copied' | 'rated' | 'error'>('idle');
  const feedbackEvent = feedbackTargetEvent(blocks);

  if (!hasVisibleTurnContent(blocks)) return null;

  const copyTurn = async () => {
    const text = turnCopyText(turn, blocks, language);
    try {
      await copyText(text);
      setStatus('copied');
    } catch {
      setStatus('error');
    }
  };

  const rateTurn = (rating: 'up' | 'down') => {
    if (!feedbackEvent) return;
    window.dispatchEvent(new CustomEvent('deepcode:agent-feedback', {
      detail: {
        eventId: feedbackEvent.id,
        kind: feedbackEvent.kind,
        rating,
      },
    }));
    void submitAgentFeedback({
      eventId: feedbackEvent.id,
      sessionId: feedbackEvent.sessionId,
      kind: feedbackEvent.kind,
      rating,
    });
    setStatus('rated');
  };

  return (
    <div className="deepcode-gui-turn-actions" aria-label={t(language, 'agent.message.actions')}>
      <button
        type="button"
        className="deepcode-gui-turn-actions__button"
        onClick={() => void copyTurn()}
        title={t(language, 'agent.message.copyAgentOutput')}
        aria-label={t(language, 'agent.message.copyAgentOutput')}
      >
        <DeepCodeTurnActionIcon name="copy" />
      </button>
      <button
        type="button"
        className="deepcode-gui-turn-actions__button"
        onClick={() => rateTurn('up')}
        disabled={!feedbackEvent}
        title={t(language, 'agent.message.feedbackUpTitle')}
        aria-label={t(language, 'agent.message.feedbackUpTitle')}
      >
        <DeepCodeTurnActionIcon name="up" />
      </button>
      <button
        type="button"
        className="deepcode-gui-turn-actions__button"
        onClick={() => rateTurn('down')}
        disabled={!feedbackEvent}
        title={t(language, 'agent.message.feedbackDownTitle')}
        aria-label={t(language, 'agent.message.feedbackDownTitle')}
      >
        <DeepCodeTurnActionIcon name="down" />
      </button>
      {status !== 'idle' && (
        <span className={`deepcode-gui-turn-actions__status deepcode-gui-turn-actions__status--${status}`}>
          {status === 'copied'
            ? t(language, 'agent.message.copyDone', { label: t(language, 'agent.message.copyAgentOutput') })
            : status === 'rated'
              ? t(language, 'agent.message.feedbackGroup')
              : t(language, 'deepcodeGui.status.error')}
        </span>
      )}
    </div>
  );
};

const DeepCodeTurnActionIcon: React.FC<{ name: 'copy' | 'up' | 'down' }> = ({ name }) => {
  const common = {
    width: 17,
    height: 17,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (name === 'copy') {
    return (
      <svg {...common}>
        <rect x="9" y="9" width="10" height="10" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
      </svg>
    );
  }

  if (name === 'up') {
    return (
      <svg {...common}>
        <path d="M7 11v10" />
        <path d="M15 6.5 14 11h5.1a2 2 0 0 1 1.9 2.5l-1.6 6A2 2 0 0 1 17.5 21H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h1.6L12 3.2a1.5 1.5 0 0 1 3 0v3.3z" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path d="M7 13V3" />
      <path d="M15 17.5 14 13h5.1a2 2 0 0 0 1.9-2.5l-1.6-6A2 2 0 0 0 17.5 3H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1.6L12 20.8a1.5 1.5 0 0 0 3 0v-3.3z" />
    </svg>
  );
};

const DeepCodeAttachmentChips: React.FC<{
  attachments: AgentContextAttachment[];
  language: UiLanguage;
}> = ({ attachments, language }) => {
  if (attachments.length === 0) return null;
  return (
    <div className="agent-message-attachments" aria-label={t(language, 'agent.message.attachments')}>
      {attachments.map((attachment, index) => (
        <span
          key={`${attachment.scope}:${attachment.folderId ?? ''}:${attachment.path}:${index}`}
          className={`agent-message-attachment agent-message-attachment--${attachment.scope}`}
          title={attachment.absolutePath ?? attachment.path}
        >
          <span className="agent-message-attachment__kind">
            {attachmentKindLabel(attachment, language)}
          </span>
          <span className="agent-message-attachment__path">
            {attachmentDisplayPath(attachment)}
          </span>
        </span>
      ))}
    </div>
  );
};

const TimelineBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
  animateAssistant?: boolean;
  collapseCompletedThinking?: boolean;
  onLiveContentChange: () => void;
  onTypewriterComplete: (blockId: string, textLength: number) => void;
  onPlanResolve?: DeepCodeTimelineProps['onPlanResolve'];
}> = ({ block, language, animateAssistant = false, collapseCompletedThinking = true, onLiveContentChange, onTypewriterComplete, onPlanResolve }) => {
  if (!isVisibleTimelineBlock(block)) return null;
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  if (block.kind === 'user') {
    const attachments = blockAttachments(block);
    return (
      <article className={`deepcode-gui-block deepcode-gui-block--user${narrativeClass}${densityClass}${phaseClassName(block)}`}>
        <div className="deepcode-gui-block__label">{t(language, 'agent.message.user')}</div>
        <DeepCodeAttachmentChips attachments={attachments} language={language} />
        <MarkdownContent content={block.bodyMarkdown ?? block.summary} />
      </article>
    );
  }

  if (block.narrativeKind === 'assistantNarration') {
    return (
      <article className={`deepcode-gui-assistant-narration${narrativeClass}${densityClass}${phaseClassName(block)}`}>
        <TypewriterMarkdown
          content={visibleTypewriterMarkdown(block, language)}
          animate={animateAssistant}
          speed={block.displayHints?.typewriterSpeed}
          onVisibleContentChange={onLiveContentChange}
          onAnimationComplete={() => onTypewriterComplete(block.id, visibleTypewriterMarkdown(block, language).length)}
        />
      </article>
    );
  }

  if (block.kind === 'assistant') {
    const requirementOptions = block.narrativeKind === 'requirement'
      ? extractRequirementOptionsFromBlock(block)
      : [];
    return (
      <article className={`deepcode-gui-assistant-text${narrativeClass}${densityClass}${phaseClassName(block)}`}>
        <TypewriterMarkdown
          content={visibleTypewriterMarkdown(block, language)}
          animate={animateAssistant}
          speed={block.displayHints?.typewriterSpeed}
          onVisibleContentChange={onLiveContentChange}
          onAnimationComplete={() => onTypewriterComplete(block.id, visibleTypewriterMarkdown(block, language).length)}
        />
        {requirementOptions.length > 0 && <DeepCodeRequirementOptionsList options={requirementOptions} language={language} />}
      </article>
    );
  }

  if (block.kind === 'plan') {
    return (
      <PlanBlock
        block={block}
        language={language}
        animate={animateAssistant}
        onLiveContentChange={onLiveContentChange}
        onTypewriterComplete={onTypewriterComplete}
        onPlanResolve={onPlanResolve}
      />
    );
  }

  if (block.kind === 'thinking' || block.narrativeKind === 'thinking') {
    return (
      <ThinkingBlock
        block={block}
        language={language}
        animate={animateAssistant}
        collapseCompletedThinking={collapseCompletedThinking}
        onLiveContentChange={onLiveContentChange}
        onTypewriterComplete={onTypewriterComplete}
      />
    );
  }

  if (block.activity) {
    return <ActivityBlock block={block} language={language} />;
  }

  if (block.kind === 'review' || block.narrativeKind === 'review') {
    return (
      <ReviewBlock
        block={block}
        language={language}
        animate={animateAssistant}
        onLiveContentChange={onLiveContentChange}
        onTypewriterComplete={onTypewriterComplete}
      />
    );
  }

  if (block.narrativeKind === 'operationEvidence' || block.narrativeKind === 'verification') {
    return <OperationEvidenceBlock block={block} language={language} />;
  }

  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting';
  const detailEvents = visibleFallbackDetailEvents(block);
  return (
    <details className={`deepcode-gui-block deepcode-gui-block--${block.kind}${narrativeClass}${densityClass}${phaseClassName(block)}`} open={open}>
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${block.status}`} />
        <span className="deepcode-gui-block__title">{localizedTimelineText(language, block.title)}</span>
      </summary>
      <div className="deepcode-gui-block__details">
        {block.bodyMarkdown && (
          <TypewriterMarkdown
            content={block.bodyMarkdown}
            animate={animateAssistant && shouldAnimateTimelineBlock(block)}
            speed={block.displayHints?.typewriterSpeed}
            onVisibleContentChange={onLiveContentChange}
            onAnimationComplete={() => onTypewriterComplete(block.id, visibleTypewriterMarkdown(block).length)}
          />
        )}
        {detailEvents.length > 0 && <EventList events={detailEvents} language={language} />}
      </div>
    </details>
  );
};

const ActivityBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
}> = ({ block, language }) => {
  const activity = block.activity;
  if (!activity) return null;
  const evidence = formatToolEvidence(block.events, language, {
    fallbackTitle: activity.title || block.title,
  });
  const hasEvidence = evidence.items.length > 0;
  const title = localizedTimelineText(
    language,
    hasEvidence ? evidence.title : activity.title || block.title || activityKindLabel(language, activity.kind)
  );
  const open = !block.defaultCollapsed || activity.status === 'running' || activity.status === 'waiting' || activity.status === 'failed';
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  const markdown = hasEvidence ? '' : block.bodyMarkdown;

  return (
    <details
      className={`deepcode-gui-block deepcode-gui-block--activity deepcode-gui-block--activity-${activity.kind} deepcode-gui-block--${block.kind}${narrativeClass}${densityClass}${phaseClassName(block)}`}
      open={open}
    >
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${activity.status}`} />
        <span className="deepcode-gui-block__title">{title}</span>
      </summary>
      <div className="deepcode-gui-block__details deepcode-gui-activity">
        <div className="deepcode-gui-activity__head">
          <span className={`deepcode-gui-activity__kind deepcode-gui-activity__kind--${activity.kind}`}>
            {activityKindLabel(language, activity.kind)}
          </span>
          <span className={`deepcode-gui-activity__status deepcode-gui-activity__status--${activity.status}`}>
            {timelineStatusLabel(language, activity.status)}
          </span>
        </div>
        {markdown && <MarkdownContent content={markdown} />}
        {hasEvidence && <ToolEvidenceDetails evidence={evidence} language={language} />}
      </div>
    </details>
  );
};

const ReviewBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
  animate: boolean;
  onLiveContentChange: () => void;
  onTypewriterComplete: (blockId: string, textLength: number) => void;
}> = ({ block, language, animate, onLiveContentChange, onTypewriterComplete }) => {
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting' || block.status === 'blocked';
  const markdown = reviewBlockMarkdown(block);

  return (
    <details className={`deepcode-gui-block deepcode-gui-block--review${narrativeClass}${densityClass}${phaseClassName(block)}`} open={open}>
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${block.status}`} />
        <span className="deepcode-gui-block__title">
          {localizedTimelineText(language, block.title || t(language, 'deepcodeGui.tasks.review'))}
        </span>
      </summary>
      <div className="deepcode-gui-block__details">
        {markdown && (
          <TypewriterMarkdown
            content={markdown}
            animate={animate && shouldAnimateTimelineBlock(block)}
            speed={block.displayHints?.typewriterSpeed}
            onVisibleContentChange={onLiveContentChange}
            onAnimationComplete={() => onTypewriterComplete(block.id, visibleTypewriterMarkdown(block).length)}
          />
        )}
        <DeepCodeGitReviewDiffDetails gitReview={gitReviewFromBlock(block)} language={language} />
      </div>
    </details>
  );
};

const OperationEvidenceBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
}> = ({ block, language }) => {
  const events = visibleOperationEvidenceEvents(block.events);
  if (block.events.length > 0 && events.length === 0 && !block.activity) return null;
  const evidence = formatToolEvidence(events, language, {
    fallbackTitle: block.title,
  });
  const title = localizedTimelineText(language, evidence.title);
  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting';
  const status = evidence.status === 'completed' ? block.status : evidence.status;
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  const markdown = evidence.items.length > 0 ? '' : block.bodyMarkdown;

  return (
    <details
      className={`deepcode-gui-block deepcode-gui-block--${block.kind}${narrativeClass}${densityClass}${phaseClassName(block)}`}
      open={open}
    >
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${status}`} />
        <span className="deepcode-gui-block__title">{title}</span>
      </summary>
      <div className="deepcode-gui-block__details">
        {markdown && <MarkdownContent content={markdown} />}
        <ToolEvidenceDetails evidence={evidence} language={language} />
      </div>
    </details>
  );
};

const DeepCodeGitReviewDiffDetails: React.FC<{ gitReview: unknown; language: UiLanguage }> = ({ gitReview, language }) => {
  if (!isRecord(gitReview)) return null;
  if (gitReview.available === false) {
    return null;
  }
  const files = Array.isArray(gitReview.files) ? gitReview.files.filter(isRecord) : [];
  const diffBlocks = Array.isArray(gitReview.diffBlocks) ? gitReview.diffBlocks.filter(isRecord) : [];
  if (!files.length && !diffBlocks.length) return null;
  return (
    <div className="deepcode-gui-git-review">
      {files.length > 0 && (
        <div className="deepcode-gui-git-review__files">
          {files.slice(0, 12).map((file, index) => {
            const path = stringField(file, 'path') ?? `file-${index + 1}`;
            return <code key={`${path}-${index}`}>{path}</code>;
          })}
          {files.length > 12 && <span>{t(language, 'common.moreFiles', { count: files.length - 12 })}</span>}
        </div>
      )}
      {diffBlocks.map((block, index) => {
        const title = stringField(block, 'title') ?? `Diff ${index + 1}`;
        const diff = stringField(block, 'diff') ?? '';
        const truncated = block.truncated === true;
        return (
          <details key={`${title}-${index}`} className="deepcode-gui-git-review__diff">
            <summary>
              {title}
              {truncated ? t(language, 'common.truncatedSuffix') : ''}
            </summary>
            <pre><code>{diff}</code></pre>
          </details>
        );
      })}
    </div>
  );
};

const ThinkingBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
  animate?: boolean;
  collapseCompletedThinking?: boolean;
  onLiveContentChange?: () => void;
  onTypewriterComplete: (blockId: string, textLength: number) => void;
}> = ({ block, language, animate = false, collapseCompletedThinking = true, onLiveContentChange = () => undefined, onTypewriterComplete }) => {
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  const markdown = thinkingMarkdown(block);
  const running = block.status === 'running' || block.status === 'waiting';
  // 空"推理过程"块不渲染（避免空壳卡片）。
  if (!markdown && !running) return null;
  // 超长 reasoning（执行阶段完整 CoT 可达上万字符）默认折叠，避免一次性大段平铺。
  const longContent = markdown.length > 1600;
  const completedThinkingOpen = block.status === 'completed' && !collapseCompletedThinking;
  const open = completedThinkingOpen ||
    (block.displayHints?.initialOpen ?? (longContent ? false : (!block.defaultCollapsed || running)));

  return (
    <details className={`deepcode-gui-block deepcode-gui-block--thinking${narrativeClass}${densityClass}${phaseClassName(block)}`} open={open}>
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${block.status}`} />
        <span className="deepcode-gui-block__title">{t(language, 'deepcodeGui.timeline.thinking')}</span>
      </summary>
      <div className="deepcode-gui-block__details deepcode-gui-block__details--thinking">
        {markdown && (
          <TypewriterMarkdown
            content={markdown}
            animate={animate}
            speed={block.displayHints?.typewriterSpeed}
            onVisibleContentChange={onLiveContentChange}
            onAnimationComplete={() => onTypewriterComplete(block.id, visibleTypewriterMarkdown(block).length)}
          />
        )}
      </div>
    </details>
  );
};

const PlanBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
  animate: boolean;
  onLiveContentChange: () => void;
  onTypewriterComplete: (blockId: string, textLength: number) => void;
  onPlanResolve?: DeepCodeTimelineProps['onPlanResolve'];
}> = ({ block, language, animate, onLiveContentChange, onTypewriterComplete, onPlanResolve }) => {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const reviewEvent = block.events.find((event) => event.kind === 'plan_review');
  const payload = isRecord(reviewEvent?.payload) ? reviewEvent.payload : {};
  const runId = stringField(payload, 'runId');
  const planId = stringField(payload, 'planId');
  const status = stringField(payload, 'status') ?? block.status;
  const confirmable = payload.confirmable === true && Boolean(runId && planId);
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting';
  const markdown = planBlockMarkdown(block);
  const copyPlan = async () => {
    try {
      await copyText(markdown);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  };

  return (
    <details
      className={`deepcode-gui-block deepcode-gui-block--plan deepcode-gui-block--${status}${narrativeClass}${densityClass}${phaseClassName(block)}`}
      open={open}
    >
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${block.status}`} />
        <span className="deepcode-gui-block__title">{block.title}</span>
        <button
          type="button"
          className={`deepcode-gui-plan-copy deepcode-gui-plan-copy--${copyStatus}`}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void copyPlan();
          }}
          title={t(language, 'deepcodeGui.plan.copyMarkdown')}
          aria-label={t(language, 'deepcodeGui.plan.copyMarkdown')}
        >
          <DeepCodeTurnActionIcon name="copy" />
        </button>
      </summary>
      <div className="deepcode-gui-block__details">
        {block.bodyMarkdown && (
          <TypewriterMarkdown
            content={block.bodyMarkdown}
            animate={animate && shouldAnimateTimelineBlock(block)}
            speed={block.displayHints?.typewriterSpeed}
            onVisibleContentChange={onLiveContentChange}
            onAnimationComplete={() => onTypewriterComplete(block.id, visibleTypewriterMarkdown(block).length)}
          />
        )}
        {confirmable && (
          <div className="deepcode-gui-plan-actions deepcode-gui-plan-actions--composer">
            {t(language, 'deepcodeGui.plan.useComposer')}
          </div>
        )}
      </div>
    </details>
  );
};

const TypewriterMarkdown: React.FC<{
  content: string;
  animate: boolean;
  speed?: TypewriterSpeed;
  onVisibleContentChange: () => void;
  onAnimationComplete?: () => void;
}> = ({ content, animate, speed = 'normal', onVisibleContentChange, onAnimationComplete }) => {
  const [visible, setVisible] = useState(() => (animate ? '' : content));
  const visibleRef = useRef(visible);
  const onAnimationCompleteRef = useRef(onAnimationComplete);
  const renderedContent = animate ? visible : content;

  useLayoutEffect(() => {
    onVisibleContentChange();
  }, [onVisibleContentChange, renderedContent]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    onAnimationCompleteRef.current = onAnimationComplete;
  }, [onAnimationComplete]);

  useEffect(() => {
    if (!animate) {
      setVisible(content);
      onAnimationCompleteRef.current?.();
      return undefined;
    }
    const startIndex = content.startsWith(visibleRef.current) ? visibleRef.current.length : 0;
    setVisible(content.slice(0, startIndex));
    if (!content || startIndex >= content.length) {
      onAnimationCompleteRef.current?.();
      return undefined;
    }
    let index = startIndex;
    const step = speed === 'fast' ? 12 : speed === 'slow' ? 2 : 4;
    const delayMs = speed === 'fast' ? 8 : speed === 'slow' ? 20 : 12;
    const id = window.setInterval(() => {
      index = Math.min(content.length, index + step);
      setVisible(content.slice(0, index));
      window.requestAnimationFrame(onVisibleContentChange);
      if (index >= content.length) {
        window.clearInterval(id);
        onAnimationCompleteRef.current?.();
      }
    }, delayMs);
    return () => window.clearInterval(id);
  }, [animate, content]);

  return <MarkdownContent content={renderedContent} />;
};

const EventList: React.FC<{ events: AgentEvent[]; compact?: boolean; language: UiLanguage }> = ({ events, compact, language }) => (
  <div className={`deepcode-gui-event-list ${compact ? 'deepcode-gui-event-list--compact' : ''}`}>
    {events.map((event) => (
      <div key={event.id} className="deepcode-gui-event">
        <span className="deepcode-gui-event__kind">{localizedEventKind(language, event.kind)}</span>
        <span className="deepcode-gui-event__text">{localizedEventSummary(language, event)}</span>
      </div>
    ))}
  </div>
);

function localFallbackTimeline(events: AgentEvent[]): AgentTimelineResult {
  return {
    sessionId: events[0]?.sessionId ?? 'session',
    generatedAt: new Date().toISOString(),
    eventCount: events.length,
    turns: events.length === 0
      ? []
      : [
          {
            id: 'local-fallback-turn',
            sessionId: events[0]?.sessionId ?? 'session',
            status: 'running',
            blocks: events.map((event) => ({
            id: event.id,
            kind: fallbackBlockKind(event),
              title: fallbackBlockTitle(event),
              summary: eventSummary(event),
              status: fallbackBlockStatus(event),
              defaultCollapsed: event.kind !== 'user_msg' && event.kind !== 'assistant_msg',
              bodyMarkdown: eventText(event),
              events: [event],
            })),
          },
        ],
  };
}

function fallbackBlockKind(event: AgentEvent): AgentTimelineBlock['kind'] {
  if (event.kind === 'user_msg') return 'user';
  if (event.kind === 'user_guidance') return 'stage';
  if (event.kind === 'plan_card' || event.kind === 'plan_review') return 'plan';
  if (event.kind === 'review_summary') return 'review';
  if (event.kind === 'error') return 'error';
  if (event.kind === 'assistant_msg') {
    const payload = isRecord(event.payload) ? event.payload : {};
    if (payload.channel === 'reasoning') return 'thinking';
    if (payload.channel === 'final') return 'assistant';
    return 'stage';
  }
  return 'stage';
}

function fallbackBlockTitle(event: AgentEvent): string {
  if (event.kind === 'user_guidance') return 'User guidance';
  return event.kind;
}

function fallbackBlockStatus(event: AgentEvent): AgentTimelineBlock['status'] {
  if (event.kind === 'user_guidance') {
    const payload = isRecord(event.payload) ? event.payload : {};
    return stringField(payload, 'status') === 'consumed' ? 'completed' : 'queued';
  }
  return 'completed';
}

function eventSummary(event: AgentEvent): string {
  return eventText(event) || event.kind;
}

function localizedEventKind(language: UiLanguage, kind: string): string {
  if (language !== 'zh-CN') return kind;
  if (kind === 'workflow_stage') return t(language, 'deepcodeGui.timeline.workflowStage');
  if (kind === 'workflow_decision') return t(language, 'deepcodeGui.timeline.workflowDecision');
  if (kind === 'plan_card') return t(language, 'deepcodeGui.tasks.plan');
  if (kind === 'plan_review') return t(language, 'deepcodeGui.tasks.plan');
  if (kind === 'tool_call') return t(language, 'deepcodeGui.tasks.tool');
  if (kind === 'tool_result') return t(language, 'deepcodeGui.tasks.tool');
  if (kind === 'permission_request' || kind === 'permission_result') return t(language, 'deepcodeGui.tasks.permission');
  if (kind === 'requirement_confirmation' || kind === 'requirement_decision') return t(language, 'deepcodeGui.tasks.requirement');
  return kind;
}

function localizedEventSummary(language: UiLanguage, event: AgentEvent): string {
  return localizedTimelineText(language, eventSummary(event));
}

function localizedTimelineText(language: UiLanguage, text: string): string {
  if (!text) return '';
  if (language !== 'zh-CN') return text;
  const replacements: Array<[string, string]> = [
    ['Requirement decision', t(language, 'deepcodeGui.timeline.requirementDecision')],
    ['Requirement confirmation', t(language, 'deepcodeGui.timeline.requirementConfirmation')],
    ['Kernel state contract entered.', t(language, 'deepcodeGui.timeline.kernelStateEntered')],
    ['Session DriverRequest produced by Kernel.', t(language, 'deepcodeGui.timeline.driverRequestProduced')],
    ['Resource context resolved', t(language, 'deepcodeGui.timeline.resourceContextResolved')],
    ['Provider Call', t(language, 'deepcodeGui.timeline.providerCall')],
    ['Provider Tool Resume', t(language, 'deepcodeGui.timeline.providerToolResume')],
    ['Operation evidence', t(language, 'deepcodeGui.timeline.operationEvidence')],
    ['Thinking', t(language, 'deepcodeGui.timeline.thinking')],
    ['User guidance', t(language, 'deepcodeGui.tasks.guidance')],
  ];
  let result = text;
  for (const [source, target] of replacements) {
    result = result.split(source).join(target);
  }
  return result;
}

function visibleFallbackDetailEvents(block: AgentTimelineBlock): AgentEvent[] {
  if ((block.bodyMarkdown ?? '').trim()) return [];
  return block.events.filter((event) => !isRedundantFallbackEvent(event) && !isInternalKernelCheckpointEvent(event));
}

function isRedundantFallbackEvent(event: AgentEvent): boolean {
  return event.kind === 'requirement_confirmation' || event.kind === 'requirement_decision';
}

function visibleOperationEvidenceEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => !isInternalKernelCheckpointEvent(event));
}

function isVisibleTimelineBlock(block: AgentTimelineBlock): boolean {
  if (block.narrativeKind !== 'operationEvidence' && block.kind !== 'stage') return true;
  if (block.events.length === 0) return true;
  return !block.events.every(isInternalKernelCheckpointEvent);
}

// P5-lite：规则统一抽至 @deepcode/session-core/timelineFilter，与 live 路径共用。
// 此处仅做 AgentEvent → {stage, kernelEventKind} 形状适配。
function isInternalKernelCheckpointEvent(event: AgentEvent): boolean {
  if (event.kind !== 'workflow_stage') return false;
  if (!isRecord(event.payload)) return false;
  const stage = stringField(event.payload, 'stage');
  const kernelEvent = isRecord(event.payload.kernelEvent) ? event.payload.kernelEvent : null;
  const kernelEventKind = kernelEvent ? stringField(kernelEvent, 'kind') : undefined;
  return isInternalOrchestrationStage({ stage, kernelEventKind });
}

function planBlockMarkdown(block: AgentTimelineBlock): string {
  const body = (block.bodyMarkdown ?? block.summary ?? '').trim();
  const title = block.title.trim();
  if (!title || body.startsWith('#')) return body;
  return [`# ${title}`, body].filter(Boolean).join('\n\n');
}

function reviewBlockMarkdown(block: AgentTimelineBlock): string {
  const body = (block.bodyMarkdown ?? '').trim();
  if (!body) return '';
  const summary = (block.summary ?? '').trim();
  if (summary && body === summary) return '';
  return trimReviewFooter(body);
}

function trimReviewFooter(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const footerStart = lines.findIndex((line) =>
    /^#{2,6}\s*(后续意图|后续决策|决策边界)\s*$/.test(line.trim())
  );
  const visibleLines = footerStart >= 0 ? lines.slice(0, footerStart) : lines;
  return visibleLines.join('\n').trim();
}

function thinkingMarkdown(block: AgentTimelineBlock): string {
  const body = (block.bodyMarkdown ?? '').trim();
  if (body) return stripProviderLifecyclePrefix(body);
  const eventText = block.events
    .map(thinkingEventText)
    .filter(Boolean)
    .join('');
  return stripProviderLifecyclePrefix(eventText).trim();
}

function thinkingEventText(event: AgentEvent): string {
  if (event.kind !== 'assistant_msg') return '';
  if (typeof event.payload === 'string') return event.payload.trim();
  if (!isRecord(event.payload)) return '';
  const channel = stringField(event.payload, 'channel');
  if (channel && channel !== 'reasoning' && channel !== 'thinking' && channel !== 'thought') {
    return '';
  }
  return stripProviderLifecyclePrefix(
    stringField(event.payload, 'content') ??
    stringField(event.payload, 'message') ??
    stringField(event.payload, 'details') ??
    ''
  ).trim();
}

function stripProviderLifecyclePrefix(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*Provider\s+Call\s*[:：]\s*(?:请求模型生成结构化回复[。.]?\s*)?/i, '')
      .replace(/^\s*Provider\s+Tool\s+Resume(?:\s+\d+)?\s*[:：]\s*(?:请求模型生成结构化回复[。.]?\s*)?/i, ''))
    .join('\n')
    .trim();
}

function eventText(event: AgentEvent): string {
  if (typeof event.payload === 'string') return event.payload;
  if (!isRecord(event.payload)) return '';
  if (event.kind === 'review_summary') {
    const body = (
      stringField(event.payload, 'content') ??
      stringField(event.payload, 'message') ??
      stringField(event.payload, 'details') ??
      ''
    );
    return trimReviewFooter(body);
  }
  return (
    stringField(event.payload, 'summary') ??
    stringField(event.payload, 'content') ??
    stringField(event.payload, 'message') ??
    stringField(event.payload, 'toolName') ??
    ''
  );
}

function hasVisibleTurnContent(blocks: AgentTimelineBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'turnActions') return false;
    return Boolean((block.bodyMarkdown ?? block.summary ?? '').trim() || block.events.length > 0);
  });
}

function feedbackTargetEvent(blocks: AgentTimelineBlock[]): AgentEvent | null {
  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = blocks[blockIndex];
    if (block.kind !== 'assistant') continue;
    for (let eventIndex = block.events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = block.events[eventIndex];
      if (event.kind === 'assistant_msg') return event;
    }
  }

  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = blocks[blockIndex];
    for (let eventIndex = block.events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = block.events[eventIndex];
      if (event.kind !== 'user_msg') return event;
    }
  }
  return null;
}

function turnCopyText(
  turn: AgentTimelineTurn,
  blocks: AgentTimelineBlock[],
  language: UiLanguage
): string {
  const parts = [
    `${t(language, 'deepcodeGui.sidebar.chats')} ${turn.id}`,
    ...blocks.flatMap((block) => blockCopyText(block, language)),
  ].filter((part) => part.trim().length > 0);
  return parts.join('\n\n');
}

function blockCopyText(block: AgentTimelineBlock, language: UiLanguage): string[] {
  if (block.kind === 'turnActions') return [];
  const title = blockCopyTitle(block, language);
  const activityBody = block.activity ? activityBodyMarkdown(block.activity, language) : '';
  const body = blockCopyBody(block, activityBody);
  const attachmentText = block.kind === 'user'
    ? attachmentCopyText(blockAttachments(block), language)
    : '';
  if (body) return [[`${title}\n${body}`, attachmentText].filter(Boolean).join('\n\n')];
  if (block.kind === 'review' || block.narrativeKind === 'review') {
    return attachmentText ? [attachmentText] : [];
  }
  const eventLines = block.events.map(eventSummary).filter(Boolean);
  if (eventLines.length > 0) {
    return [[`${title}\n${eventLines.join('\n')}`, attachmentText].filter(Boolean).join('\n\n')];
  }
  return attachmentText ? [attachmentText] : [];
}

function blockCopyBody(block: AgentTimelineBlock, activityBody: string): string {
  if (block.kind === 'review' || block.narrativeKind === 'review') {
    return reviewBlockMarkdown(block);
  }
  if (block.kind === 'thinking' || block.narrativeKind === 'thinking') {
    return thinkingMarkdown(block);
  }
  if (block.activity) {
    return (block.bodyMarkdown ?? activityBody).trim();
  }
  return (block.bodyMarkdown ?? block.summary ?? activityBody).trim();
}

function visibleTypewriterMarkdown(block: AgentTimelineBlock, language?: UiLanguage): string {
  if (block.kind === 'review' || block.narrativeKind === 'review') return reviewBlockMarkdown(block);
  if (block.kind === 'thinking' || block.narrativeKind === 'thinking') return thinkingMarkdown(block);
  if (block.activity) return block.bodyMarkdown ?? '';
  // diagnostic 事件本地化：源事件携带 diagnosticCode 时按 i18n 翻译
  if (language && block.events.length > 0) {
    const payload = isRecord(block.events[0].payload) ? block.events[0].payload : undefined;
    if (payload && payload.diagnostic === true) {
      const translated = resolveDiagnosticText(payload as Record<string, unknown>, language);
      if (translated) return translated;
    }
  }
  return (block.bodyMarkdown ?? block.summary ?? '').trim();
}

function blockCopyTitle(block: AgentTimelineBlock, language: UiLanguage): string {
  if (block.kind === 'user') return t(language, 'agent.copy.user');
  if (block.kind === 'assistant') return 'DeepCode';
  if (block.kind === 'thinking') return t(language, 'agent.copy.thinking');
  if (block.kind === 'error') return t(language, 'agent.copy.error');
  return block.title || block.kind;
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall back to execCommand below for packaged WebView edge cases.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

// R4 DeepCodeTimeline 壳：从 requirement_confirmation block 提取 options 与 effect，
// 在卡片中显式渲染"选择后副作用"，与 agent-panel 壳保持一致。
interface DeepCodeRequirementOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  effect?: { kind: string; taskIds?: string[]; reason?: string };
}

function extractRequirementOptionsFromBlock(block: AgentTimelineBlock): DeepCodeRequirementOption[] {
  for (const event of block.events) {
    if (event.kind !== 'requirement_confirmation') continue;
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (!payload) continue;
    const decisionRequest = isRecord(payload.decisionRequest) ? payload.decisionRequest : undefined;
    if (!decisionRequest || !Array.isArray(decisionRequest.options)) continue;
    return decisionRequest.options.flatMap((item): DeepCodeRequirementOption[] => {
      if (!isRecord(item)) return [];
      const id = stringField(item, 'id');
      const label = stringField(item, 'label');
      if (!id || !label) return [];
      const effectRecord = isRecord(item.effect) ? item.effect : undefined;
      const effectKind = effectRecord ? stringField(effectRecord, 'kind') : undefined;
      let effect: DeepCodeRequirementOption['effect'];
      if (effectKind) {
        effect = { kind: effectKind };
        if (effectKind === 'markTasksCompleted' && Array.isArray(effectRecord?.taskIds)) {
          effect.taskIds = effectRecord.taskIds.filter((v): v is string => typeof v === 'string' && v.length > 0);
        } else if (effectKind === 'replan') {
          const reason = effectRecord ? stringField(effectRecord, 'reason') : undefined;
          if (reason) effect.reason = reason;
        }
      }
      return [{
        id,
        label,
        description: stringField(item, 'description'),
        recommended: item.recommended === true,
        effect,
      }];
    });
  }
  return [];
}

function formatDeepCodeOptionEffect(effect: DeepCodeRequirementOption['effect'], language: UiLanguage): string | undefined {
  if (!effect) return undefined;
  const key = `requirement.optionEffect.${effect.kind}`;
  if (effect.kind === 'markTasksCompleted' && Array.isArray(effect.taskIds) && effect.taskIds.length > 0) {
    return t(language, key, { taskIds: effect.taskIds.join(', ') });
  }
  const translated = t(language, key);
  return translated === key ? undefined : translated;
}

const DeepCodeRequirementOptionsList: React.FC<{
  options: DeepCodeRequirementOption[];
  language: UiLanguage;
}> = ({ options, language }) => {
  return (
    <ul className="deepcode-gui-requirement-options" aria-label={t(language, 'requirement.optionsTitle')}>
      {options.map((option) => {
        const effectText = formatDeepCodeOptionEffect(option.effect, language);
        return (
          <li key={option.id} className="deepcode-gui-requirement-option">
            <div className="deepcode-gui-requirement-option__head">
              <span className="deepcode-gui-requirement-option__label">{option.label}</span>
              {option.recommended && (
                <span className="deepcode-gui-requirement-option__badge">{t(language, 'requirement.optionRecommended')}</span>
              )}
            </div>
            {option.description && (
              <div className="deepcode-gui-requirement-option__desc">{option.description}</div>
            )}
            {effectText && (
              <div className="deepcode-gui-requirement-option__effect">
                <span className="deepcode-gui-requirement-option__effect-label">
                  {t(language, 'requirement.optionEffectLabel')}：
                </span>
                {effectText}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};

// P4(B)：返回 block 的 phase 视觉 className 片段（用于 plan 探索 vs complete 执行的视觉分区）。
function phaseClassName(block: AgentTimelineBlock): string {
  const phase = block.displayHints?.phase;
  return phase ? ` deepcode-gui-block--phase-${phase}` : '';
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function gitReviewFromBlock(block: AgentTimelineBlock): unknown {
  for (const event of block.events ?? []) {
    if (event.kind !== 'review_summary' || !isRecord(event.payload)) continue;
    if (event.payload.gitReview) return event.payload.gitReview;
    const reviewFacts = event.payload.reviewFacts;
    if (isRecord(reviewFacts) && reviewFacts.gitReview) return reviewFacts.gitReview;
  }
  return undefined;
}

function payloadAttachments(payload: unknown): AgentContextAttachment[] {
  if (!isRecord(payload) || !Array.isArray(payload.attachments)) return [];
  return payload.attachments.filter((item): item is AgentContextAttachment =>
    isRecord(item) &&
    typeof item.path === 'string' &&
    (item.kind === 'file' || item.kind === 'directory' || item.kind === 'panelSnapshot') &&
    (item.scope === 'message' || item.scope === 'session')
  );
}

function blockAttachments(block: AgentTimelineBlock): AgentContextAttachment[] {
  if (block.kind !== 'user') return [];
  return block.events.flatMap((event) => payloadAttachments(event.payload));
}

function attachmentKindLabel(attachment: AgentContextAttachment, language: UiLanguage): string {
  if (attachment.kind === 'directory') return t(language, 'agent.composer.dir');
  if (attachment.kind === 'panelSnapshot') return t(language, 'agent.composer.panel');
  return t(language, 'agent.composer.file');
}

function attachmentDisplayPath(attachment: AgentContextAttachment): string {
  return attachment.path || attachment.absolutePath || '.';
}

function attachmentCopyText(attachments: AgentContextAttachment[], language: UiLanguage): string {
  if (attachments.length === 0) return '';
  return [
    t(language, 'agent.message.attachments'),
    ...attachments.map((attachment) =>
      `- ${attachmentKindLabel(attachment, language)} ${attachmentDisplayPath(attachment)} (${attachment.scope})`
    ),
  ].join('\n');
}

function timelineStatusLabel(language: UiLanguage, status: string): string {
  const translated = t(language, `deepcodeGui.status.${status}`);
  return translated.startsWith('deepcodeGui.status.') ? status : translated;
}

function formatTurnTime(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString();
}

export default DeepCodeTimeline;
