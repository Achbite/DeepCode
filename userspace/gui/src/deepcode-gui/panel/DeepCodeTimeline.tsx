import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentTimelineAttachment,
  AgentTimelineBlock,
  AgentTimelineCurrentActivity,
  AgentTimelineResult,
  AgentTimelineTurn,
  AgentTimelineWorkAttention,
  AgentTimelineWorkOperation,
  AgentTimelineWorkOperationStatus,
  AgentTimelineWorkSegment,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import MarkdownContent from '../../components/agent-panel/LazyMarkdownContent';
import ActivityIndicator from '../../components/agent-panel/ActivityIndicator';
import {
  AnswerSettlementStatus,
  isAnswerBusy,
  isAnswerCommitted,
  isAnswerPlaybackIncremental,
} from '../../components/agent-panel/AnswerSettlementStatus';
import {
  FinalFactReceipt,
  hasStructuredProjection,
  StructuredProjectionContent,
  structuredProjectionText,
} from '../../components/agent-panel/StructuredProjectionContent';
import { useSettingsStore } from '../../state/settingsStore';
import {
  bufferedTypewriterDelay,
  bufferedTypewriterNextIndex,
  type BufferedTypewriterSpeed,
} from '../../utils/typewriterBuffer';

interface DeepCodeTimelineProps {
  timeline: AgentTimelineResult;
  loading: boolean;
  language: UiLanguage;
  followLatestSignal?: number;
  scrollWatchElement?: HTMLElement | null;
  onTypewriterBlocksChange?: (blockIds: string[]) => void;
  onPlanResolve?: (
    runId: string,
    planId: string,
    decision: 'accept' | 'reject' | 'revise',
    guidance?: string
  ) => void;
}

type TypewriterSpeed = BufferedTypewriterSpeed;
type TimelineFollowMode = 'following' | 'detached';

const DeepCodeTimeline: React.FC<DeepCodeTimelineProps> = ({
  timeline,
  loading,
  language,
  followLatestSignal = 0,
  scrollWatchElement = null,
  onTypewriterBlocksChange,
  onPlanResolve,
}) => {
  const view = timeline;
  const currentActivity = view.runProjection?.currentActivity ?? null;
  const waitingForUser = view.runProjection?.status === 'waitingUser'
    || view.runProjection?.wait?.kind === 'user';
  const typewriterEnabled = useSettingsStore((s) =>
    Boolean(s.effectiveSettings['gui.typewriterAnimation'] ?? true)
  );
  const viewWithActive = view;
  const assistantPlayback = useAssistantPlayback(viewWithActive, typewriterEnabled);
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
  const timelineDensity = useSettingsStore((s) =>
    String(s.effectiveSettings['gui.timelineDensity'] ?? 'normal')
  );
  const typewriterBlockLengths = assistantPlayback.targetLengths;
  const completedTypewriterBlockLengths = assistantPlayback.visibleLengths;
  const animatingBlockIds = assistantPlayback.animatingBlockIds;
  const playbackVisibleBlockIds = usePlaybackVisibleBlockIds(
    viewWithActive,
    animatingBlockIds,
    completedTypewriterBlockLengths,
    typewriterBlockLengths
  );
  const actionBarTurnId = useMemo(() => {
    const runStatus = viewWithActive.runProjection?.status;
    const sharedRunSettled = runStatus === undefined
      || runStatus === 'succeeded'
      || runStatus === 'failed'
      || runStatus === 'cancelled';
    if (!sharedRunSettled || loading || viewWithActive.interactionProjection?.pending) {
      return undefined;
    }
    for (const turn of [...viewWithActive.turns].reverse()) {
      if (turn.status !== 'completed' && turn.status !== 'failed') continue;
      const visibleBlocks = turn.blocks.filter(isVisibleTimelineBlock);
      if (!visibleBlocks.some(isActionableAgentOutputBlock)) continue;
      if (visibleBlocks.some((block) => !playbackVisibleBlockIds.has(block.id) || animatingBlockIds.has(block.id))) {
        continue;
      }
      return turn.id;
    }
    return undefined;
  }, [animatingBlockIds, loading, playbackVisibleBlockIds, viewWithActive]);
  const timelineDensityClass = timelineDensity === 'compact' ? ' deepcode-gui-timeline--compact' : '';
  useEffect(() => {
    onTypewriterBlocksChange?.([...animatingBlockIds]);
  }, [animatingBlockIds, onTypewriterBlocksChange]);

  useEffect(() => () => {
    onTypewriterBlocksChange?.([]);
  }, [onTypewriterBlocksChange]);

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
        {viewWithActive.turns.map((turn, turnIndex) => (
          <TurnCard
            key={turn.id}
            turn={turn}
            currentActivity={currentActivity}
            language={language}
            transportPending={loading && turnIndex === viewWithActive.turns.length - 1}
            showActions={turn.id === actionBarTurnId}
            playbackVisibleBlockIds={playbackVisibleBlockIds}
            playbackTextLengths={assistantPlayback.visibleLengths}
            animatingBlockIds={animatingBlockIds}
            onLiveContentChange={scrollToTimelineEndIfFollowing}
            onPlanResolve={onPlanResolve}
          />
        ))}
        {!waitingForUser && (currentActivity || loading) && (
          <CurrentActivityLine
            activity={currentActivity}
            language={language}
          />
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

function flattenTimelineBlocks(view: AgentTimelineResult): AgentTimelineBlock[] {
  return view.turns.flatMap((turn) => turn.blocks);
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
      const sourceCount = block.provenance.sourceEventRefs.length;
      const bodyLength = block.bodyMarkdown?.length ?? 0;
      return `${block.id}:${block.kind}:${block.status}:${sourceCount}:${bodyLength}`;
    })
    .join('|');
  const workSignature = lastTurn.workSegments
    .map((segment) => `${segment.id}:${segment.revision}:${segment.lifecycle}:${segment.operations.length}`)
    .join('|');
  const activity = view.runProjection?.currentActivity;
  const activitySignature = activity
    ? `${activity.activityId}:${activity.revision}:${activity.updatedAt}`
    : 'none';
  return `${lastTurn.id}:${lastTurn.status}:${loading ? 'running' : 'idle'}:${blockSignature}:${workSignature}:${activitySignature}`;
}

interface AssistantPlaybackState {
  visibleLengths: Map<string, number>;
  targetLengths: Map<string, number>;
  animatingBlockIds: Set<string>;
}

function useAssistantPlayback(
  view: AgentTimelineResult,
  enabled: boolean
): AssistantPlaybackState {
  const targets = useMemo(() => new Map(
    flattenTimelineBlocks(view)
      .filter(isAssistantPlaybackBlock)
      .map((block) => [
        block.id,
        {
          content: assistantPlaybackText(block),
          deliveryMode: block.deliveryMode,
          answerState: block.answerState,
          revision: block.revision ?? 0,
        },
      ])
  ), [view]);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const sessionIdRef = useRef(view.sessionId);
  const previousContentRef = useRef(new Map(
    [...targets].map(([blockId, target]) => [blockId, target.content])
  ));
  const enrolledRef = useRef(new Set<string>());
  const visibleLengthsRef = useRef(new Map(
    [...targets].map(([blockId, target]) => [blockId, target.content.length])
  ));
  const [visibleLengths, setVisibleLengths] = useState<Map<string, number>>(
    () => new Map([...targets].map(([blockId, target]) => [
      blockId,
      target.content.length,
    ]))
  );
  const playbackSignature = useMemo(
    () => [...targets]
      .map(([blockId, target]) =>
        `${blockId}:${target.revision}:${target.deliveryMode ?? 'replay'}:${target.answerState ?? 'legacy'}:${target.content.length}`
      )
      .join('|'),
    [targets]
  );

  useLayoutEffect(() => {
    if (sessionIdRef.current !== view.sessionId) {
      sessionIdRef.current = view.sessionId;
      enrolledRef.current = new Set();
      previousContentRef.current = new Map(
        [...targets].map(([blockId, target]) => [blockId, target.content])
      );
      const next = new Map(
        [...targets].map(([blockId, target]) => [blockId, target.content.length])
      );
      visibleLengthsRef.current = next;
      setVisibleLengths(next);
      return;
    }

    const enrolled = new Set(enrolledRef.current);
    const previousContent = previousContentRef.current;
    const next = new Map<string, number>();
    for (const [blockId, target] of targets) {
      const previous = previousContent.get(blockId);
      const currentVisible = visibleLengthsRef.current.get(blockId);
      if (previous === undefined) {
        if (
          enabled
          && isAnswerPlaybackIncremental(target.deliveryMode, target.answerState)
        ) {
          enrolled.add(blockId);
          next.set(blockId, 0);
        } else {
          next.set(blockId, target.content.length);
        }
        continue;
      }
      if (!isAnswerPlaybackIncremental(target.deliveryMode, target.answerState)) {
        enrolled.delete(blockId);
        next.set(blockId, target.content.length);
        continue;
      }
      if (!target.content.startsWith(previous) || !enabled) {
        enrolled.delete(blockId);
        next.set(blockId, target.content.length);
        continue;
      }
      if (
        target.content.length > previous.length
        && isAnswerPlaybackIncremental(target.deliveryMode, target.answerState)
      ) {
        enrolled.add(blockId);
      }
      next.set(
        blockId,
        enrolled.has(blockId)
          ? Math.min(currentVisible ?? previous.length, target.content.length)
          : target.content.length
      );
    }
    enrolledRef.current = new Set(
      [...enrolled].filter((blockId) => targets.has(blockId))
    );
    previousContentRef.current = new Map(
      [...targets].map(([blockId, target]) => [blockId, target.content])
    );
    visibleLengthsRef.current = next;
    setVisibleLengths((current) => mapNumbersEqual(current, next) ? current : next);
  }, [enabled, playbackSignature, targets, view.sessionId]);

  useEffect(() => {
    let timer: number | null = null;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const active = [...targetsRef.current].find(([blockId, target]) =>
        enrolledRef.current.has(blockId)
        && (visibleLengthsRef.current.get(blockId) ?? 0) < target.content.length
      );
      if (!active) return;
      const [blockId, target] = active;
      const currentIndex = visibleLengthsRef.current.get(blockId) ?? 0;
      const nextIndex = bufferedTypewriterNextIndex(target.content, currentIndex, 'normal');
      const next = new Map(visibleLengthsRef.current);
      next.set(blockId, nextIndex);
      if (nextIndex >= target.content.length) enrolledRef.current.delete(blockId);
      visibleLengthsRef.current = next;
      setVisibleLengths(next);
      timer = window.setTimeout(tick, bufferedTypewriterDelay('normal'));
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled, playbackSignature]);

  const targetLengths = useMemo(
    () => new Map(
      [...targets].map(([blockId, target]) => [blockId, target.content.length])
    ),
    [targets]
  );
  const animatingBlockIds = useMemo(
    () => new Set(
      [...targetLengths]
        .filter(([blockId, targetLength]) =>
          (visibleLengths.get(blockId) ?? targetLength) < targetLength
        )
        .map(([blockId]) => blockId)
    ),
    [targetLengths, visibleLengths]
  );
  return { visibleLengths, targetLengths, animatingBlockIds };
}

function isAssistantPlaybackBlock(block: AgentTimelineBlock): boolean {
  return block.kind === 'assistant'
    && (block.narrativeKind === 'assistantText' || block.narrativeKind === undefined)
    && assistantPlaybackText(block).length > 0;
}

function assistantPlaybackText(block: AgentTimelineBlock): string {
  return block.bodyMarkdown ?? block.summary ?? '';
}

function mapNumbersEqual(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function usePlaybackVisibleBlockIds(
  view: AgentTimelineResult,
  animatingBlockIds: Set<string>,
  completedLengths: Map<string, number>,
  currentLengths: Map<string, number>
): Set<string> {
  const cursorRef = useRef({ sessionId: '', visibleBlockIds: new Set<string>() });
  return useMemo(() => {
    const blocks = flattenTimelineBlocks(view).filter(isVisibleTimelineBlock);
    if (cursorRef.current.sessionId !== view.sessionId) {
      cursorRef.current = { sessionId: view.sessionId, visibleBlockIds: new Set() };
    }

    const availableBlockIds = new Set(blocks.map((block) => block.id));
    const visibleBlockIds = new Set(
      [...cursorRef.current.visibleBlockIds].filter((blockId) => availableBlockIds.has(blockId))
    );
    for (const block of blocks) {
      visibleBlockIds.add(block.id);
      if (!animatingBlockIds.has(block.id)) continue;
      const currentLength = currentLengths.get(block.id) ?? 0;
      const completedLength = completedLengths.get(block.id) ?? 0;
      if (completedLength < currentLength) break;
    }

    cursorRef.current.visibleBlockIds = visibleBlockIds;
    return new Set(visibleBlockIds);
  }, [animatingBlockIds, completedLengths, currentLengths, view]);
}

const TurnCard: React.FC<{
  turn: AgentTimelineTurn;
  currentActivity: AgentTimelineCurrentActivity | null;
  language: UiLanguage;
  transportPending: boolean;
  showActions: boolean;
  playbackVisibleBlockIds: Set<string>;
  playbackTextLengths: Map<string, number>;
  animatingBlockIds: Set<string>;
  onLiveContentChange: () => void;
  onPlanResolve?: DeepCodeTimelineProps['onPlanResolve'];
}> = ({ turn, currentActivity, language, transportPending, showActions, playbackVisibleBlockIds, playbackTextLengths, animatingBlockIds, onLiveContentChange, onPlanResolve }) => {
  const startedAtLabel = formatTurnTime(turn.startedAt);
  const visibleBlocks = turn.blocks.filter(isVisibleTimelineBlock);
  const blocks = visibleBlocks.filter((block) => playbackVisibleBlockIds.has(block.id));
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const workSegmentsById = new Map(
    turn.workSegments.map((segment) => [segment.id, segment])
  );
  type RenderedTurnPart =
    | { kind: 'block'; block: AgentTimelineBlock }
    | { kind: 'workSegment'; workSegment: AgentTimelineWorkSegment };
  const orderedParts = turn.parts.flatMap<RenderedTurnPart>((part) => {
    if (part.kind === 'block') {
      const block = blocksById.get(part.blockId);
      return block ? [{ kind: 'block' as const, block }] : [];
    }
    const workSegment = workSegmentsById.get(part.workSegmentId);
    return workSegment
      ? [{ kind: 'workSegment' as const, workSegment }]
      : [];
  });
  if (orderedParts.length === 0) return null;
  const actionsReady = showActions &&
    !transportPending &&
    blocks.length === visibleBlocks.length &&
    visibleBlocks.every((block) => !animatingBlockIds.has(block.id));

  return (
    <section className={`deepcode-gui-turn deepcode-gui-turn--${turn.status}`}>
      <div className="deepcode-gui-turn__rail" />
      <div className="deepcode-gui-turn__body">
        <div className="deepcode-gui-turn__meta">
          <span>{timelineStatusLabel(language, turn.status)}</span>
          {startedAtLabel && <span>{startedAtLabel}</span>}
        </div>
        {orderedParts.map((part) => part.kind === 'block' ? (
          <TimelineBlock
            key={part.block.id}
            block={part.block}
            language={language}
            visibleTextLength={playbackTextLengths.get(part.block.id)}
            interactionsEnabled={
              !transportPending &&
              turn.status !== 'running' &&
              !animatingBlockIds.has(part.block.id) &&
              !actionsReady
            }
            onLiveContentChange={onLiveContentChange}
            onPlanResolve={onPlanResolve}
          />
        ) : (
          <WorkSegment
            key={part.workSegment.id}
            segment={part.workSegment}
            currentActivity={currentActivity}
            language={language}
          />
        ))}
        {actionsReady && <TurnActionBar blocks={blocks} language={language} />}
      </div>
    </section>
  );
};

const CurrentActivityLine: React.FC<{
  activity: AgentTimelineCurrentActivity | null;
  language: UiLanguage;
}> = ({ activity, language }) => (
  <div className="deepcode-gui-current-activity" role="status" aria-live="polite">
    <ActivityIndicator
      activityKey={activity
        ? `${activity.activityId}:${activity.revision}`
        : 'transport-pending'}
      label={currentActivityLabel(activity, language)}
      variant={activity?.code === 'retry.backoff' ? 'retry' : 'default'}
    />
  </div>
);

const WorkSegment: React.FC<{
  segment: AgentTimelineWorkSegment;
  currentActivity: AgentTimelineCurrentActivity | null;
  language: UiLanguage;
}> = ({ segment, currentActivity, language }) => {
  const forceOpen = segment.attention?.status === 'unresolved';
  const [open, setOpen] = useState(forceOpen);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <details
      className={`deepcode-gui-work-segment deepcode-gui-work-segment--${segment.lifecycle}`}
      open={open}
      onToggle={(event) => {
        const requestedOpen = event.currentTarget.open;
        if (forceOpen) {
          event.currentTarget.open = true;
          setOpen(true);
          return;
        }
        setOpen(requestedOpen);
      }}
    >
      <summary>
        <span className={`deepcode-gui-work-segment__status deepcode-gui-work-segment__status--${segment.lifecycle}`} />
        <span className="deepcode-gui-work-segment__summary">
          {workSegmentSummary(segment, currentActivity, language)}
        </span>
        {segment.attention && (
          <span className={`deepcode-gui-work-segment__attention deepcode-gui-work-segment__attention--${segment.attention.status}`}>
            {segment.attention.status === 'unresolved'
              ? (language === 'zh-CN' ? '需要处理' : 'Needs attention')
              : (language === 'zh-CN' ? '已处理' : 'Resolved')}
          </span>
        )}
      </summary>
      <div className="deepcode-gui-work-segment__details">
        {segment.attention && (
          <div className={`deepcode-gui-work-segment__attention-summary deepcode-gui-work-segment__attention-summary--${segment.attention.status}`}>
            {workAttentionLabel(segment.attention, language)}
          </div>
        )}
        <ol className="deepcode-gui-work-segment__operations">
          {segment.operations.map((operation) => (
            <WorkOperation
              key={operation.operationId}
              operation={operation}
              language={language}
            />
          ))}
        </ol>
      </div>
    </details>
  );
};

const WorkOperation: React.FC<{
  operation: AgentTimelineWorkOperation;
  language: UiLanguage;
}> = ({ operation, language }) => {
  const title = operation.displayName?.trim()
    || operation.canonicalAction?.trim()
    || operation.toolId;
  return (
    <li className={`deepcode-gui-work-operation deepcode-gui-work-operation--${operation.status}`}>
      <div className="deepcode-gui-work-operation__head">
        <span className={`deepcode-gui-work-operation__status deepcode-gui-work-operation__status--${operation.status}`} />
        <span className="deepcode-gui-work-operation__title">{title}</span>
        <span className="deepcode-gui-work-operation__state">
          {workOperationStatusLabel(operation.status, language)}
        </span>
      </div>
      {operation.retry && (
        <div
          className="deepcode-gui-work-operation__retry"
          title={operation.retry.predecessorOperationId}
        >
          {language === 'zh-CN'
            ? `第 ${operation.retry.retryOrdinal} 次尝试 · 纠正前序操作`
            : `Attempt ${operation.retry.retryOrdinal} · corrects prior operation`}
        </div>
      )}
      {operation.resourcePresentation.length > 0 && (
        <div className="deepcode-gui-work-operation__targets">
          {operation.resourcePresentation.map((target) => target.label).join(' · ')}
        </div>
      )}
      {operation.effectSummary && (
        <div className="deepcode-gui-work-operation__effect">
          {t(language, 'agent.work.effectObserved')}
        </div>
      )}
      {operation.attempts && operation.attempts.length > 0 && (
        <div className="deepcode-gui-work-operation__attempts">
          {operation.attempts.map((attempt) => (
            <span key={attempt.attemptId} title={attempt.attemptId}>
              {workOperationStatusLabel(attempt.status ?? operation.status, language)}
            </span>
          ))}
        </div>
      )}
    </li>
  );
};

function currentActivityLabel(
  activity: AgentTimelineCurrentActivity | null,
  language: UiLanguage
): string {
  if (!activity) return t(language, 'deepcodeGui.status.running');
  const labels: Record<string, readonly [string, string]> = {
    'session.admitting': ['正在接收请求', 'Admitting request'],
    'provider.awaitingFirstByte': ['正在等待模型响应', 'Waiting for model response'],
    'provider.reasoning': ['模型正在思考', 'Model is reasoning'],
    'provider.composing': ['正在组织回复', 'Composing response'],
    'resource.resolving': ['正在解析资源', 'Resolving resources'],
    'kernel.executing': ['正在执行工具', 'Executing tools'],
    'session.validating': ['正在校验结果', 'Validating result'],
    'session.persisting': ['正在保存会话', 'Saving session'],
    'retry.backoff': ['正在等待重试', 'Waiting to retry'],
  };
  const known = labels[String(activity.code)];
  if (!known) {
    return t(language, 'agent.activity.working');
  }
  return t(language, `agent.activity.${activity.code}`);
}

function workAttentionLabel(
  attention: AgentTimelineWorkAttention,
  language: UiLanguage
): string {
  return t(language, `agent.work.attention.${attention.kind}`);
}

function workSegmentSummary(
  segment: AgentTimelineWorkSegment,
  currentActivity: AgentTimelineCurrentActivity | null,
  language: UiLanguage
): string {
  const count = segment.operations.length;
  const currentOperation = currentWorkOperation(segment, currentActivity);
  if (segment.lifecycle === 'active' && currentOperation) {
    const action = activeOperationActionLabel(currentOperation, language);
    const targets = currentOperation.resourcePresentation
      .map((target) => target.label.trim())
      .filter(Boolean)
      .join(' · ');
    return targets ? `${action} ${targets}` : action;
  }
  const labels: Record<AgentTimelineWorkSegment['lifecycle'], readonly [string, string]> = {
    active: ['正在处理', 'Working'],
    completed: ['已完成', 'Completed'],
    cancelled: ['已取消', 'Cancelled'],
    failed: ['失败', 'Failed'],
  };
  const label = labels[segment.lifecycle];
  const state = language === 'zh-CN' ? label[0] : label[1];
  if (language === 'zh-CN') return `${state} · ${count} 项`;
  return `${state} · ${count} ${count === 1 ? 'operation' : 'operations'}`;
}

function currentWorkOperation(
  segment: AgentTimelineWorkSegment,
  _currentActivity: AgentTimelineCurrentActivity | null
): AgentTimelineWorkOperation | undefined {
  if (segment.activeOperationId) {
    return segment.operations.find((operation) =>
      operation.operationId === segment.activeOperationId
    );
  }
  return undefined;
}

function activeOperationActionLabel(
  operation: AgentTimelineWorkOperation,
  language: UiLanguage
): string {
  const labels: Record<string, readonly [string, string, string]> = {
    'fs.list': ['查看', 'Inspecting', 'inspect'],
    'fs.glob': ['搜索', 'Searching', 'search'],
    'fs.read': ['读取', 'Reading', 'read'],
    'fs.diff': ['比较', 'Comparing', 'compare'],
    'fs.create': ['创建', 'Creating', 'create'],
    'fs.write': ['写入', 'Writing', 'write'],
    'fs.edit': ['修改', 'Editing', 'edit'],
    'fs.delete': ['删除', 'Deleting', 'delete'],
    'fs.ensure_directory': ['创建目录', 'Creating a directory', 'create a directory'],
    'code.grep': ['搜索', 'Searching', 'search'],
    'document.read': ['读取', 'Reading', 'read'],
    'web.search': ['搜索网页', 'Searching the web', 'search the web'],
    'web.fetch': ['读取网页', 'Reading a web page', 'read a web page'],
  };
  const label = labels[operation.toolId];
  const name = operation.displayName?.trim()
    || operation.canonicalAction?.trim()
    || operation.toolId;
  const action = language === 'zh-CN'
    ? label?.[0] ?? `执行 ${name}`
    : operation.status === 'running'
      ? label?.[1] ?? `Running ${name}`
      : label?.[2] ?? `run ${name}`;
  if (operation.status === 'running') {
    return language === 'zh-CN' ? `正在${action}` : action;
  }
  if (operation.status === 'preparing') {
    return t(language, 'agent.work.action.preparing', { action });
  }
  if (operation.status === 'queued') {
    return t(language, 'agent.work.action.queued', { action });
  }
  if (operation.status === 'awaitingCapability') {
    return t(language, 'agent.work.action.awaitingCapability', { action });
  }
  return `${workOperationStatusLabel(operation.status, language)} · ${name}`;
}

function workOperationStatusLabel(
  status: AgentTimelineWorkOperationStatus,
  language: UiLanguage
): string {
  const labels: Record<AgentTimelineWorkOperationStatus, readonly [string, string]> = {
    preparing: ['准备中', 'Preparing'],
    queued: ['已排队', 'Queued'],
    running: ['执行中', 'Running'],
    awaitingCapability: ['等待授权', 'Awaiting permission'],
    completed: ['已完成', 'Completed'],
    denied: ['已拒绝', 'Denied'],
    failed: ['失败', 'Failed'],
    failedAfterObservedEffect: ['执行后失败', 'Failed after effect'],
    indeterminate: ['状态不确定', 'Indeterminate'],
    cancelled: ['已取消', 'Cancelled'],
    stale: ['已失效', 'Stale'],
    unexecuted: ['未执行', 'Not executed'],
  };
  const label = labels[status];
  return language === 'zh-CN' ? label[0] : label[1];
}

const TurnActionBar: React.FC<{
  blocks: AgentTimelineBlock[];
  language: UiLanguage;
}> = ({ blocks, language }) => {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const actionBlocks = blocks.filter(isActionableAgentOutputBlock);

  if (actionBlocks.length === 0) return null;

  const copyTurn = async () => {
    const text = turnCopyText(actionBlocks, language);
    try {
      await copyText(text);
      setStatus('copied');
    } catch {
      setStatus('error');
    }
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
        <DeepCodeTurnActionIcon />
      </button>
      {status !== 'idle' && (
        <span className={`deepcode-gui-turn-actions__status deepcode-gui-turn-actions__status--${status}`}>
          {status === 'copied'
            ? t(language, 'agent.message.copyDone', { label: t(language, 'agent.message.copyAgentOutput') })
            : t(language, 'deepcodeGui.status.error')}
        </span>
      )}
    </div>
  );
};

const DeepCodeTurnActionIcon: React.FC<{ name?: 'copy' }> = () => {
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

  return (
    <svg {...common}>
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </svg>
  );
};

const DeepCodeAttachmentChips: React.FC<{
  attachments: AgentTimelineAttachment[];
  language: UiLanguage;
}> = ({ attachments, language }) => {
  if (attachments.length === 0) return null;
  return (
    <div className="agent-message-attachments" aria-label={t(language, 'agent.message.attachments')}>
      {attachments.map((attachment) => (
        <span
          key={`${attachment.scope}:${attachment.attachmentId}`}
          className={`agent-message-attachment agent-message-attachment--${attachment.scope}`}
          title={attachment.displayName}
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
  visibleTextLength?: number;
  interactionsEnabled: boolean;
  onLiveContentChange: () => void;
  onPlanResolve?: DeepCodeTimelineProps['onPlanResolve'];
}> = ({ block, language, visibleTextLength, interactionsEnabled, onLiveContentChange, onPlanResolve }) => {
  if (!isVisibleTimelineBlock(block)) return null;
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';

  if (block.kind === 'user') {
    const attachments = blockAttachments(block);
    const content = localizedUserBlockContent(block, language);
    return (
      <article className={`deepcode-gui-block deepcode-gui-block--user${narrativeClass}${densityClass}${phaseClassName(block)}`}>
        <div className="deepcode-gui-block__label">{t(language, 'agent.message.user')}</div>
        <DeepCodeAttachmentChips attachments={attachments} language={language} />
        <MarkdownContent content={content} />
      </article>
    );
  }

  if (block.kind === 'assistant') {
    const content = visibleTypewriterMarkdown(block, language);
    const playbackComplete = visibleTextLength === undefined
      || visibleTextLength >= content.length;
    const answerStateClass = block.answerState
      ? ` deepcode-gui-assistant-text--${block.answerState}`
      : '';
    return (
      <article
        className={`deepcode-gui-assistant-text${answerStateClass}${narrativeClass}${densityClass}${phaseClassName(block)}`}
        data-answer-state={block.answerState}
        aria-busy={isAnswerBusy(block.answerState)}
      >
        <AssistantPlaybackMarkdown
          content={content}
          visibleTextLength={visibleTextLength}
          streaming={
            isAnswerPlaybackIncremental(block.deliveryMode, block.answerState)
            || !playbackComplete
          }
          onVisibleContentChange={onLiveContentChange}
        />
        <AnswerSettlementStatus
          answerState={block.answerState}
          language={language}
        />
        {playbackComplete
          && block.durability === 'committed'
          && isAnswerCommitted(block.answerState)
          && (
          <FinalFactReceipt
            projection={block.structuredProjection}
            language={language}
          />
        )}
      </article>
    );
  }

  if (block.kind === 'plan') {
    return (
      <PlanBlock
        block={block}
        language={language}
        animate={false}
        showActions={interactionsEnabled}
        onLiveContentChange={onLiveContentChange}
        onTypewriterComplete={() => undefined}
        onPlanResolve={onPlanResolve}
      />
    );
  }

  if (block.kind === 'review' || block.narrativeKind === 'review') {
    return (
      <ReviewBlock
        block={block}
        language={language}
        animate={false}
        showActions={interactionsEnabled}
        onLiveContentChange={onLiveContentChange}
        onTypewriterComplete={() => undefined}
      />
    );
  }

  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting';
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
            animate={false}
            streaming={block.deliveryMode === 'live'}
            speed="normal"
            onVisibleContentChange={onLiveContentChange}
          />
        )}
      </div>
    </details>
  );
};

const AssistantPlaybackMarkdown: React.FC<{
  content: string;
  visibleTextLength?: number;
  streaming: boolean;
  onVisibleContentChange: () => void;
}> = ({ content, visibleTextLength, streaming, onVisibleContentChange }) => {
  const visibleLength = visibleTextLength === undefined
    ? content.length
    : Math.max(0, Math.min(visibleTextLength, content.length));
  const renderedContent = content.slice(0, visibleLength);
  useLayoutEffect(() => {
    onVisibleContentChange();
  }, [onVisibleContentChange, renderedContent]);
  return streaming
    ? <BufferedMarkdownStream content={renderedContent} streaming />
    : <MarkdownContent content={renderedContent} />;
};

const ReviewBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
  animate: boolean;
  showActions: boolean;
  onLiveContentChange: () => void;
  onTypewriterComplete: (blockId: string, textLength: number) => void;
}> = ({ block, language, animate, showActions, onLiveContentChange, onTypewriterComplete }) => {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting' || block.status === 'blocked';
  const markdown = reviewBlockMarkdown(block, language);
  const copyReview = async () => {
    try {
      await copyText(markdown);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  };

  return (
    <details className={`deepcode-gui-block deepcode-gui-block--review${narrativeClass}${densityClass}${phaseClassName(block)}`} open={open}>
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${block.status}`} />
        <span className="deepcode-gui-block__title">
          {localizedTimelineText(language, block.title || t(language, 'deepcodeGui.tasks.review'))}
        </span>
        {showActions && <button
          type="button"
          className={`deepcode-gui-plan-copy deepcode-gui-plan-copy--${copyStatus}`}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void copyReview();
          }}
          title={t(language, 'deepcodeGui.review.copyStructured')}
          aria-label={t(language, 'deepcodeGui.review.copyStructured')}
        >
          <DeepCodeTurnActionIcon name="copy" />
        </button>}
      </summary>
      <div className="deepcode-gui-block__details">
        {hasStructuredProjection(block.structuredProjection, 'review') ? (
          <StructuredProjectionTypewriter
            projection={block.structuredProjection}
            language={language}
            animate={animate}
            speed="normal"
            onVisibleContentChange={onLiveContentChange}
            onAnimationComplete={() => onTypewriterComplete(block.id, markdown.length)}
          />
        ) : markdown ? (
          <TypewriterMarkdown
            content={markdown}
            animate={animate}
            streaming={block.deliveryMode === 'live'}
            speed="normal"
            onVisibleContentChange={onLiveContentChange}
            onAnimationComplete={() => onTypewriterComplete(block.id, markdown.length)}
          />
        ) : (
          <div className="deepcode-gui-block__empty">
            {t(language, 'session.projection.unsupportedLegacy')}
          </div>
        )}
      </div>
    </details>
  );
};

const BufferedMarkdownStream: React.FC<{
  content: string;
  streaming: boolean;
}> = ({ content, streaming }) => {
  const blocks = useMemo(() => segmentStreamingMarkdown(content, streaming), [content, streaming]);
  return (
    <div className="deepcode-gui-markdown-stream">
      {blocks.map((block, index) => (
        <MemoizedMarkdownStreamBlock
          key={`markdown-block-${index}`}
          content={block.content}
          sealed={block.sealed}
        />
      ))}
    </div>
  );
};

const MemoizedMarkdownStreamBlock = React.memo(
  ({ content, sealed }: { content: string; sealed: boolean }) => (
    <div className={`deepcode-gui-markdown-stream__block${sealed ? ' deepcode-gui-markdown-stream__block--sealed' : ' deepcode-gui-markdown-stream__block--tail'}`}>
      <MarkdownContent content={content} />
    </div>
  ),
  (prev, next) => prev.content === next.content && prev.sealed === next.sealed
);

function segmentStreamingMarkdown(content: string, streaming: boolean): Array<{ content: string; sealed: boolean }> {
  if (!content) return [];
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [content];
  const blocks: Array<{ content: string; sealed: boolean }> = [];
  let current = '';
  let inFence: string | null = null;

  const pushCurrent = (sealed: boolean) => {
    if (!current) return;
    blocks.push({ content: current, sealed });
    current = '';
  };

  for (const line of lines) {
    current += line;
    const trimmed = line.trim();
    const fence = markdownFenceMarker(trimmed);
    if (fence) {
      if (!inFence) {
        inFence = fence;
      } else if (trimmed.startsWith(inFence)) {
        inFence = null;
      }
    }
    if (!inFence && trimmed === '') {
      pushCurrent(true);
    }
  }

  if (current) {
    pushCurrent(!streaming);
  }
  return blocks;
}

function markdownFenceMarker(trimmedLine: string): string | null {
  if (trimmedLine.startsWith('```')) return '```';
  if (trimmedLine.startsWith('~~~')) return '~~~';
  return null;
}

const PlanBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
  animate: boolean;
  showActions: boolean;
  onLiveContentChange: () => void;
  onTypewriterComplete: (blockId: string, textLength: number) => void;
  onPlanResolve?: DeepCodeTimelineProps['onPlanResolve'];
}> = ({ block, language, animate, showActions, onLiveContentChange, onTypewriterComplete, onPlanResolve }) => {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const status = block.status;
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting';
  const markdown = planBlockMarkdown(block, language);
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
        {showActions && planBlockAuthorized(block) && <button
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
          title={t(language, 'deepcodeGui.plan.copyStructured')}
          aria-label={t(language, 'deepcodeGui.plan.copyStructured')}
        >
          <DeepCodeTurnActionIcon name="copy" />
        </button>}
      </summary>
      <div className="deepcode-gui-block__details">
        {hasStructuredProjection(block.structuredProjection, 'plan') ? (
          <StructuredProjectionTypewriter
            projection={block.structuredProjection}
            language={language}
            animate={animate}
            speed="normal"
            onVisibleContentChange={onLiveContentChange}
            onAnimationComplete={() => onTypewriterComplete(block.id, markdown.length)}
          />
        ) : (
          <div className="deepcode-gui-block__empty">
            {t(language, 'session.projection.unsupportedLegacy')}
          </div>
        )}
      </div>
    </details>
  );
};

const StructuredProjectionTypewriter: React.FC<{
  projection: AgentTimelineBlock['structuredProjection'];
  language: UiLanguage;
  animate: boolean;
  speed?: TypewriterSpeed;
  onVisibleContentChange: () => void;
  onAnimationComplete: () => void;
}> = ({
  projection,
  language,
  animate,
  speed = 'normal',
  onVisibleContentChange,
  onAnimationComplete,
}) => {
  const text = structuredProjectionText(projection, language);
  const totalLength = text.length;
  const shouldAnimate = animate && totalLength > 0;
  const [visibleCharacters, setVisibleCharacters] = useState(() => (shouldAnimate ? 0 : totalLength));
  const visibleRef = useRef(visibleCharacters);
  const latestTextRef = useRef(text);
  const frameRef = useRef<number | null>(null);
  const completedRef = useRef(false);
  const onAnimationCompleteRef = useRef(onAnimationComplete);
  const onVisibleContentChangeRef = useRef(onVisibleContentChange);
  const renderedCharacters = shouldAnimate ? visibleCharacters : totalLength;

  useEffect(() => {
    visibleRef.current = visibleCharacters;
  }, [visibleCharacters]);

  useEffect(() => {
    onAnimationCompleteRef.current = onAnimationComplete;
  }, [onAnimationComplete]);

  useEffect(() => {
    onVisibleContentChangeRef.current = onVisibleContentChange;
  }, [onVisibleContentChange]);

  useLayoutEffect(() => {
    onVisibleContentChangeRef.current();
  }, [renderedCharacters]);

  useEffect(() => {
    latestTextRef.current = text;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    if (!shouldAnimate || totalLength <= 0) {
      visibleRef.current = totalLength;
      setVisibleCharacters(totalLength);
      if (!completedRef.current) {
        completedRef.current = true;
        onAnimationCompleteRef.current();
      }
      return undefined;
    }

    let index = Math.min(visibleRef.current, totalLength);
    visibleRef.current = index;
    setVisibleCharacters(index);
    if (index >= totalLength) {
      if (!completedRef.current) {
        completedRef.current = true;
        onAnimationCompleteRef.current();
      }
      return undefined;
    }
    completedRef.current = false;

    let lastAdvanceAt = 0;
    const tick = (timestamp: number) => {
      if (lastAdvanceAt > 0 && timestamp - lastAdvanceAt < bufferedTypewriterDelay(speed)) {
        frameRef.current = window.requestAnimationFrame(tick);
        return;
      }
      lastAdvanceAt = timestamp;
      const latestText = latestTextRef.current;
      index = bufferedTypewriterNextIndex(latestText, index, speed);
      visibleRef.current = index;
      setVisibleCharacters(index);
      if (index >= latestText.length) {
        if (!completedRef.current) {
          completedRef.current = true;
          onAnimationCompleteRef.current();
        }
        return;
      }
      frameRef.current = window.requestAnimationFrame(tick);
    };

    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [shouldAnimate, speed, text, totalLength]);

  return (
    <StructuredProjectionContent
      projection={projection}
      language={language}
      visibleCharacters={shouldAnimate ? visibleCharacters : undefined}
    />
  );
};

const TypewriterMarkdown: React.FC<{
  content: string;
  animate: boolean;
  streaming?: boolean;
  speed?: TypewriterSpeed;
  onVisibleContentChange: () => void;
  onAnimationComplete?: () => void;
}> = ({ content, animate, streaming = false, speed = 'normal', onVisibleContentChange, onAnimationComplete }) => {
  const shouldAnimate = animate && content.length > 0;
  const [visible, setVisible] = useState(() => (shouldAnimate ? '' : content));
  const visibleRef = useRef(visible);
  const latestRef = useRef(content);
  const frameRef = useRef<number | null>(null);
  const onAnimationCompleteRef = useRef(onAnimationComplete);
  const onVisibleContentChangeRef = useRef(onVisibleContentChange);
  const renderedContent = shouldAnimate ? visible : content;

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
    onVisibleContentChangeRef.current = onVisibleContentChange;
  }, [onVisibleContentChange]);

  useEffect(() => {
    latestRef.current = content;
    const clearFrame = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const commitVisible = (next: string) => {
      visibleRef.current = next;
      setVisible(next);
    };

    if (!shouldAnimate) {
      clearFrame();
      commitVisible(content);
      onAnimationCompleteRef.current?.();
      return undefined;
    }

    if (!content.startsWith(visibleRef.current)) {
      commitVisible(content);
      onAnimationCompleteRef.current?.();
      return undefined;
    }

    let lastAdvanceAt = 0;
    const tick = (timestamp: number) => {
      frameRef.current = null;
      const latest = latestRef.current;
      const current = visibleRef.current;
      if (!latest.startsWith(current)) {
        commitVisible(latest);
        onAnimationCompleteRef.current?.();
        return;
      }
      const backlog = latest.length - current.length;
      if (backlog <= 0) {
        onAnimationCompleteRef.current?.();
        return;
      }
      if (lastAdvanceAt > 0 && timestamp - lastAdvanceAt < bufferedTypewriterDelay(speed)) {
        frameRef.current = window.requestAnimationFrame(tick);
        return;
      }
      lastAdvanceAt = timestamp;
      const nextIndex = bufferedTypewriterNextIndex(latest, current.length, speed);
      commitVisible(latest.slice(0, nextIndex));
      frameRef.current = window.requestAnimationFrame(tick);
    };

    if (frameRef.current === null) {
      frameRef.current = window.requestAnimationFrame(tick);
    }
    return clearFrame;
  }, [shouldAnimate, content, speed]);

  return shouldAnimate || streaming
    ? <BufferedMarkdownStream content={renderedContent} streaming={shouldAnimate || streaming} />
    : <MarkdownContent content={renderedContent} />;
};

function localizedUserBlockContent(block: AgentTimelineBlock, language: UiLanguage): string {
  const contentKey = stringValue(block.localizedContent?.messageKey);
  if (contentKey) {
    const localized = t(language, contentKey, block.localizedContent?.messageArgs);
    if (localized !== contentKey) return localized;
  }
  return localizedTimelineText(
    language,
    block.localizedContent?.text ?? block.bodyMarkdown ?? block.summary ?? ''
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function localizedTimelineText(language: UiLanguage, text: string): string {
  void language;
  return text;
}

function isVisibleTimelineBlock(_block: AgentTimelineBlock): boolean {
  return true;
}

function planBlockMarkdown(block: AgentTimelineBlock, language: UiLanguage): string {
  return structuredProjectionText(block.structuredProjection, language);
}

function planBlockAuthorized(block: AgentTimelineBlock): boolean {
  return block.confirmable === true;
}

function reviewBlockMarkdown(block: AgentTimelineBlock, language: UiLanguage = 'zh-CN'): string {
  return structuredProjectionText(block.structuredProjection, language) || block.bodyMarkdown || block.summary;
}

function isActionableAgentOutputBlock(block: AgentTimelineBlock): boolean {
  if (block.kind === 'review' || block.narrativeKind === 'review') return true;
  if (block.kind === 'assistant' && !isAnswerCommitted(block.answerState)) return false;
  if (block.narrativeKind) return block.narrativeKind === 'assistantText';
  return block.kind === 'assistant';
}

function turnCopyText(
  blocks: AgentTimelineBlock[],
  language: UiLanguage
): string {
  const parts = blocks.flatMap((block) => blockCopyText(block, language))
    .filter((part) => part.trim().length > 0);
  return parts.join('\n\n');
}

function blockCopyText(block: AgentTimelineBlock, language: UiLanguage): string[] {
  const title = blockCopyTitle(block, language);
  const body = blockCopyBody(block, language);
  const attachmentText = block.kind === 'user'
    ? attachmentCopyText(blockAttachments(block), language)
    : '';
  if (body) return [[`${title}\n${body}`, attachmentText].filter(Boolean).join('\n\n')];
  if (block.kind === 'review' || block.narrativeKind === 'review') {
    return attachmentText ? [attachmentText] : [];
  }
  return attachmentText ? [attachmentText] : [];
}

function blockCopyBody(block: AgentTimelineBlock, language: UiLanguage): string {
  if (block.kind === 'review' || block.narrativeKind === 'review') {
    return reviewBlockMarkdown(block, language);
  }
  return (block.bodyMarkdown ?? block.summary ?? '').trim();
}

function visibleTypewriterMarkdown(block: AgentTimelineBlock, language?: UiLanguage): string {
  if (block.kind === 'assistant') {
    return localizedTimelineText(language ?? 'zh-CN', assistantPlaybackText(block));
  }
  if (block.kind === 'plan' || block.narrativeKind === 'plan') return planBlockMarkdown(block, language ?? 'zh-CN');
  if (block.kind === 'review' || block.narrativeKind === 'review') return reviewBlockMarkdown(block, language ?? 'zh-CN');
  return localizedTimelineText(language ?? 'zh-CN', (block.bodyMarkdown ?? block.summary ?? '').trim());
}

function blockCopyTitle(block: AgentTimelineBlock, language: UiLanguage): string {
  if (block.kind === 'user') return t(language, 'agent.copy.user');
  if (block.kind === 'assistant') return 'DeepCode';
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

function phaseClassName(block: AgentTimelineBlock): string {
  const phase = block.displayHints?.phase;
  return phase ? ` deepcode-gui-block--phase-${phase}` : '';
}

function blockAttachments(block: AgentTimelineBlock): AgentTimelineAttachment[] {
  if (block.kind !== 'user') return [];
  return block.attachments ?? [];
}

function attachmentKindLabel(attachment: AgentTimelineAttachment, language: UiLanguage): string {
  if (attachment.kind === 'directory') return t(language, 'agent.composer.dir');
  return t(language, 'agent.composer.file');
}

function attachmentDisplayPath(attachment: AgentTimelineAttachment): string {
  return attachment.displayName;
}

function attachmentCopyText(attachments: AgentTimelineAttachment[], language: UiLanguage): string {
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
