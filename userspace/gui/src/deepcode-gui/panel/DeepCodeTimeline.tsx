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
import { buildNarrativeTimelineProjection } from '@deepcode/session-core';
import { t, type UiLanguage } from '../../i18n';
import { submitAgentFeedback } from '../../services/runtimeAdapter';
import MarkdownContent from '../../components/agent-panel/LazyMarkdownContent';
import ToolEvidenceDetails from '../../components/agent-panel/ToolEvidenceDetails';
import { useSettingsStore } from '../../state/settingsStore';
import { formatToolEvidence } from '../../utils/toolEvidence';

interface DeepCodeTimelineProps {
  timeline: AgentTimelineResult | null;
  fallbackEvents: AgentEvent[];
  loading: boolean;
  language: UiLanguage;
  activeDeltas?: ProjectionDelta[];
  onPlanResolve?: (
    runId: string,
    planId: string,
    decision: 'accept' | 'reject' | 'revise',
    guidance?: string
  ) => void;
}

type TypewriterSpeed = NonNullable<NonNullable<AgentTimelineBlock['displayHints']>['typewriterSpeed']>;

const DeepCodeTimeline: React.FC<DeepCodeTimelineProps> = ({
  timeline,
  fallbackEvents,
  loading,
  language,
  activeDeltas = [],
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
  const viewWithActive = useMemo(
    () => appendActiveDeltaTurn(view, coalescedActiveDeltas, language),
    [coalescedActiveDeltas, language, view]
  );
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const shouldFollowRef = useRef(true);
  const previousLoadingRef = useRef(false);
  const suppressScrollEventsUntilRef = useRef(0);
  const liveScrollFrameRef = useRef<number | null>(null);
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
  const timelineDensityClass = timelineDensity === 'compact' ? ' deepcode-gui-timeline--compact' : '';

  const setShouldFollow = useCallback((shouldFollow: boolean) => {
    shouldFollowRef.current = shouldFollow;
    setShowJumpToLatest((visible) => {
      const nextVisible = !shouldFollow;
      return visible === nextVisible ? visible : nextVisible;
    });
  }, []);

  const resolveScrollContainer = useCallback(() => {
    const cached = scrollContainerRef.current;
    if (cached && document.contains(cached)) return cached;
    const container = findTimelineScrollContainer(timelineRef.current);
    scrollContainerRef.current = container;
    return container;
  }, []);

  const scrollToTimelineEnd = useCallback(() => {
    const container = resolveScrollContainer();
    if (!container) return;

    setShouldFollow(true);
    suppressScrollEventsUntilRef.current = window.performance.now() + 160;
    container.scrollTop = container.scrollHeight;
    timelineEndRef.current?.scrollIntoView({
      block: 'end',
      behavior: 'auto',
    });
    window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
      timelineEndRef.current?.scrollIntoView({
        block: 'end',
        behavior: 'auto',
      });
    });
  }, [resolveScrollContainer, setShouldFollow]);

  const scrollToTimelineEndIfFollowing = useCallback(() => {
    if (!shouldFollowRef.current || liveScrollFrameRef.current !== null) return;
    liveScrollFrameRef.current = window.requestAnimationFrame(() => {
      liveScrollFrameRef.current = null;
      if (shouldFollowRef.current) {
        scrollToTimelineEnd();
      }
    });
  }, [scrollToTimelineEnd]);

  useEffect(() => () => {
    if (liveScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(liveScrollFrameRef.current);
    }
  }, []);

  useEffect(() => {
    const scrollContainer = resolveScrollContainer();
    if (!scrollContainer) return undefined;

    const updateShouldFollow = () => {
      if (window.performance.now() < suppressScrollEventsUntilRef.current) return;
      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      const distanceFromBottom = maxScrollTop - scrollContainer.scrollTop;
      setShouldFollow(distanceFromBottom < 180);
    };

    updateShouldFollow();
    scrollContainer.addEventListener('scroll', updateShouldFollow, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', updateShouldFollow);
  }, [resolveScrollContainer, setShouldFollow]);

  useLayoutEffect(() => {
    const startedRunning = loading && !previousLoadingRef.current;
    previousLoadingRef.current = loading;
    if (startedRunning) setShouldFollow(true);
    if (!startedRunning && !shouldFollowRef.current) return;

    scrollToTimelineEnd();
  }, [loading, scrollSignature, scrollToTimelineEnd, setShouldFollow]);

  useEffect(() => {
    const target = timelineRef.current;
    if (!target || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (shouldFollowRef.current) {
        scrollToTimelineEnd();
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [scrollToTimelineEnd]);

  return (
    <div className={`deepcode-gui-timeline${timelineDensityClass}`} ref={timelineRef}>
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
          onPlanResolve={onPlanResolve}
        />
      ))}
      {loading && (
        <div className="deepcode-gui-live-indicator">
          <span className="deepcode-gui-live-indicator__dot" />
          {t(language, 'deepcodeGui.status.running')}
        </div>
      )}
      {showJumpToLatest && (
        <button
          type="button"
          className="deepcode-gui-timeline-jump-latest"
          aria-label="跳转到最新内容"
          title="跳转到最新内容"
          onClick={scrollToTimelineEnd}
        >
          ↓
        </button>
      )}
      <div ref={timelineEndRef} className="deepcode-gui-timeline__end" aria-hidden="true" />
    </div>
  );
};

function appendActiveDeltaTurn(
  view: AgentTimelineResult,
  deltas: ProjectionDelta[],
  language: UiLanguage
): AgentTimelineResult {
  const active = deltas
    .filter((delta) => delta.sessionId === view.sessionId && delta.type !== 'committed')
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  if (active.length === 0) return view;

  const runId = active.find((delta) => delta.runId)?.runId ?? 'active-run';
  const turnId = active.find((delta) => delta.turnId)?.turnId ?? `active-${runId}`;
  const status = activeTimelineStatus(active);
  const parentDeltas = active.filter((delta) => !isBranchDelta(delta));
  const committedActivityIds = collectCommittedActivityIds(view);
  const activeActivities = groupedActiveActivities(active, committedActivityIds);
  const reasoningMarkdown = parentDeltas
    .filter((delta) => delta.type === 'reasoning_delta' && typeof delta.delta === 'string')
    .map((delta) => delta.delta)
    .join('');
  const assistantMarkdown = parentDeltas
    .filter((delta) => delta.type === 'assistant_delta' && typeof delta.delta === 'string')
    .map((delta) => delta.delta)
    .join('');
  const progressLines = active
    .filter((delta) => delta.type !== 'reasoning_delta')
    .filter((delta) => !delta.activity)
    .filter((delta) => !isBranchDelta(delta))
    .filter((delta) => !parentTextDelta(delta))
    .map((delta) => activeDeltaProgressLine(delta))
    .filter((line): line is string => Boolean(line))
    .slice(-32);

  const blocks: AgentTimelineBlock[] = [];
  if (reasoningMarkdown.trim()) {
    blocks.push({
      id: `active-thinking-${runId}`,
      kind: 'thinking',
      narrativeKind: 'thinking',
      title: t(language, 'deepcodeGui.timeline.thinking'),
      summary: language === 'zh-CN' ? 'Provider 正在输出 reasoning。' : 'Provider reasoning is streaming.',
      status,
      defaultCollapsed: false,
      bodyMarkdown: reasoningMarkdown,
      displayHints: {
        renderMode: 'typewriter',
        typewriterSpeed: 'slow',
        initialOpen: true,
        replaceOnComplete: true,
      },
      events: [],
    });
  }
  if (assistantMarkdown.trim()) {
    blocks.push({
      id: `active-assistant-${runId}`,
      kind: 'assistant',
      narrativeKind: 'assistantText',
      title: 'DeepCode',
      summary: language === 'zh-CN' ? 'DeepCode 正在回复。' : 'DeepCode is responding.',
      status,
      defaultCollapsed: false,
      bodyMarkdown: assistantMarkdown,
      displayHints: {
        renderMode: 'typewriter',
        typewriterSpeed: 'normal',
        replaceOnComplete: true,
      },
      events: [],
    });
  }
  for (const activity of activeActivities) {
    blocks.push(activityBlockFromActivity(activity, language, true));
  }
  if (progressLines.length > 0) {
    blocks.push({
      id: `active-progress-${runId}`,
      kind: 'stage',
      narrativeKind: 'operationEvidence',
      title: language === 'zh-CN' ? '实时进度' : 'Live Progress',
      summary: progressLines[progressLines.length - 1],
      status,
      defaultCollapsed: false,
      bodyMarkdown: progressLines.map((line) => `- ${line}`).join('\n'),
      displayHints: {
        renderMode: 'instant',
        density: 'compact',
        evidenceMode: 'collapsed',
        replaceOnComplete: true,
      },
      events: [],
    });
  }
  if (blocks.length === 0) return view;

  return {
    ...view,
    turns: [
      ...view.turns,
      {
        id: `active-${turnId}`,
        sessionId: view.sessionId,
        status,
        startedAt: active[0]?.payload && isRecord(active[0].payload)
          ? stringField(active[0].payload, 'startedAt')
          : undefined,
        blocks,
      },
    ],
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

function groupedActiveActivities(
  deltas: ProjectionDelta[],
  committedActivityIds: Set<string>
): AgentConversationActivity[] {
  const byId = new Map<string, AgentConversationActivity>();
  for (const delta of deltas) {
    const activity = delta.activity;
    if (!activity || committedActivityIds.has(activity.activityId)) continue;
    if (!isMainTimelineActivity(activity)) continue;
    byId.set(activity.activityId, activity);
  }
  return [...byId.values()];
}

function isMainTimelineActivity(activity: AgentConversationActivity): boolean {
  return activity.kind !== 'providerThinking'
    && activity.kind !== 'subagentBranch'
    && activity.kind !== 'subagentMerge';
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
  const summary = (activity.summary ?? '').trim();
  if (summary) rows.push(summary);
  if (activity.targets?.length) {
    rows.push(`${t(language, 'deepcodeGui.activity.targets')}: ${activity.targets.join(', ')}`);
  }
  if (activity.toolName) {
    rows.push(`${t(language, 'deepcodeGui.activity.tool')}: ${activity.toolName}`);
  }
  if (activity.actionIds?.length) {
    rows.push(`${t(language, 'deepcodeGui.activity.actions')}: ${activity.actionIds.join(', ')}`);
  }
  if (activity.workUnitIds?.length) {
    rows.push(`${t(language, 'deepcodeGui.activity.workUnits')}: ${activity.workUnitIds.join(', ')}`);
  }
  if (activity.errorCode || activity.errorMessage) {
    rows.push(`${t(language, 'deepcodeGui.activity.error')}: ${[activity.errorCode, activity.errorMessage].filter(Boolean).join(' - ')}`);
  }
  return rows.map((line) => `- ${line}`).join('\n');
}

function isBranchDelta(delta: ProjectionDelta): boolean {
  return Boolean(delta.branchId || delta.subAgentId);
}

function parentTextDelta(delta: ProjectionDelta): boolean {
  return !isBranchDelta(delta) && (delta.type === 'reasoning_delta' || delta.type === 'assistant_delta');
}

function safeActiveBlockId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'branch';
}

function activeTimelineStatus(deltas: ProjectionDelta[]): AgentTimelineTurn['status'] {
  if (deltas.some((delta) => delta.status === 'failed' || delta.type === 'error')) return 'failed';
  const latest = deltas[deltas.length - 1];
  if (latest?.status === 'waiting') return 'waiting';
  return 'running';
}

function activeDeltaProgressLine(delta: ProjectionDelta): string | null {
  const summary = (delta.summary ?? '').trim();
  const label = activeDeltaLabel(delta);
  const branch = delta.branchId ? ` ${delta.branchId}` : '';
  const target = delta.targetPath ? ` ${delta.targetPath}` : '';
  if (summary) return `${label}${branch}${target}: ${summary}`;
  if (delta.type === 'assistant_delta' && isBranchDelta(delta)) {
    return `${label}${branch}${target}: sub-agent draft is streaming`;
  }
  if (delta.type === 'part_delta' || delta.type === 'draft_delta') {
    return `${label}${branch}${target}`;
  }
  if (delta.type === 'tool_call_delta' || delta.type === 'resource_delta' || delta.type === 'workunit_delta') {
    return `${label}${branch}${target}`;
  }
  return null;
}

function activeDeltaLabel(delta: ProjectionDelta): string {
  if (delta.type === 'part_delta') return 'part';
  if (delta.type === 'draft_delta') return 'draft';
  if (delta.type === 'resource_delta') return 'resource';
  if (delta.type === 'workunit_delta') return 'workunit';
  if (delta.type === 'tool_call_delta') return 'tool';
  if (delta.type === 'assistant_delta') return 'assistant';
  if (delta.type === 'stage_delta') return delta.stage ?? 'stage';
  if (delta.type === 'active_turn') return delta.stage ?? 'run';
  if (delta.type === 'error') return 'error';
  return delta.type;
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
      .filter((block) =>
        block.displayHints?.renderMode === 'typewriter' ||
        block.displayHints?.renderMode === 'accelerated' ||
        block.narrativeKind === 'assistantText' ||
        (!block.narrativeKind && block.kind === 'assistant')
      )
      .filter((block) => (block.bodyMarkdown ?? block.summary ?? '').trim().length > 0)
      .map((block) => block.id)
  );
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
  onPlanResolve?: DeepCodeTimelineProps['onPlanResolve'];
}> = ({ turn, language, typewriterBlockIds, collapseCompletedThinking, onLiveContentChange, onPlanResolve }) => {
  const startedAtLabel = formatTurnTime(turn.startedAt);
  const blocks = turn.blocks;

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
  onPlanResolve?: DeepCodeTimelineProps['onPlanResolve'];
}> = ({ block, language, animateAssistant = false, collapseCompletedThinking = true, onLiveContentChange, onPlanResolve }) => {
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  if (block.kind === 'user') {
    const attachments = blockAttachments(block);
    return (
      <article className={`deepcode-gui-block deepcode-gui-block--user${narrativeClass}${densityClass}`}>
        <div className="deepcode-gui-block__label">{t(language, 'agent.message.user')}</div>
        <DeepCodeAttachmentChips attachments={attachments} language={language} />
        <MarkdownContent content={block.bodyMarkdown ?? block.summary} />
      </article>
    );
  }

  if (block.narrativeKind === 'assistantNarration') {
    return (
      <article className={`deepcode-gui-assistant-narration${narrativeClass}${densityClass}`}>
        <TypewriterMarkdown
          content={block.bodyMarkdown ?? block.summary}
          animate={animateAssistant}
          speed={block.displayHints?.typewriterSpeed}
          onVisibleContentChange={onLiveContentChange}
        />
      </article>
    );
  }

  if (block.kind === 'assistant') {
    return (
      <article className={`deepcode-gui-assistant-text${narrativeClass}${densityClass}`}>
        <TypewriterMarkdown
          content={block.bodyMarkdown ?? block.summary}
          animate={animateAssistant}
          speed={block.displayHints?.typewriterSpeed}
          onVisibleContentChange={onLiveContentChange}
        />
      </article>
    );
  }

  if (block.kind === 'plan') {
    return <PlanBlock block={block} language={language} onPlanResolve={onPlanResolve} />;
  }

  if (block.kind === 'thinking' || block.narrativeKind === 'thinking') {
    return (
      <ThinkingBlock
        block={block}
        language={language}
        animate={animateAssistant}
        collapseCompletedThinking={collapseCompletedThinking}
        onLiveContentChange={onLiveContentChange}
      />
    );
  }

  if (block.activity) {
    return <ActivityBlock block={block} language={language} />;
  }

  if (block.narrativeKind === 'operationEvidence' || block.narrativeKind === 'verification') {
    return <OperationEvidenceBlock block={block} language={language} />;
  }

  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting';
  return (
    <details className={`deepcode-gui-block deepcode-gui-block--${block.kind}${narrativeClass}${densityClass}`} open={open}>
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${block.status}`} />
        <span className="deepcode-gui-block__title">{localizedTimelineText(language, block.title)}</span>
        <span className="deepcode-gui-block__summary">{localizedTimelineText(language, block.summary)}</span>
      </summary>
      <div className="deepcode-gui-block__details">
        {block.bodyMarkdown && <MarkdownContent content={block.bodyMarkdown} />}
        {block.narrativeKind === 'review' && (
          <DeepCodeGitReviewDiffDetails gitReview={gitReviewFromBlock(block)} language={language} />
        )}
        <EventList events={block.events} language={language} />
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
  const title = localizedTimelineText(language, activity.title || block.title || activityKindLabel(language, activity.kind));
  const summary = localizedTimelineText(language, activity.summary || block.summary || '');
  const open = !block.defaultCollapsed || activity.status === 'running' || activity.status === 'waiting' || activity.status === 'failed';
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  const meta = activityMetaItems(activity, language);

  return (
    <details
      className={`deepcode-gui-block deepcode-gui-block--activity deepcode-gui-block--activity-${activity.kind} deepcode-gui-block--${block.kind}${narrativeClass}${densityClass}`}
      open={open}
    >
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${activity.status}`} />
        <span className="deepcode-gui-block__title">{title}</span>
        {summary && <span className="deepcode-gui-block__summary">{summary}</span>}
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
        {block.bodyMarkdown && <MarkdownContent content={block.bodyMarkdown} />}
        {meta.length > 0 && (
          <div className="deepcode-gui-activity__meta">
            {meta.map((item) => (
              <span key={`${item.label}:${item.value}`} className="deepcode-gui-activity__chip" title={item.value}>
                <strong>{item.label}</strong>
                <span>{item.value}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </details>
  );
};

function activityMetaItems(
  activity: AgentConversationActivity,
  language: UiLanguage
): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [];
  if (activity.toolName) items.push({ label: t(language, 'deepcodeGui.activity.tool'), value: activity.toolName });
  if (activity.targets?.length) {
    items.push({ label: t(language, 'deepcodeGui.activity.targets'), value: activity.targets.join(', ') });
  }
  if (activity.actionIds?.length) {
    items.push({ label: t(language, 'deepcodeGui.activity.actions'), value: activity.actionIds.join(', ') });
  }
  if (activity.workUnitIds?.length) {
    items.push({ label: t(language, 'deepcodeGui.activity.workUnits'), value: activity.workUnitIds.join(', ') });
  }
  if (activity.errorCode || activity.errorMessage) {
    items.push({
      label: t(language, 'deepcodeGui.activity.error'),
      value: [activity.errorCode, activity.errorMessage].filter(Boolean).join(' - '),
    });
  }
  return items;
}

const OperationEvidenceBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
}> = ({ block, language }) => {
  const evidence = formatToolEvidence(block.events, language, {
    fallbackTitle: block.title,
    fallbackSummary: block.summary,
  });
  const title = localizedTimelineText(language, evidence.title);
  const summary = localizedTimelineText(language, evidence.summary ?? '');
  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting';
  const status = evidence.status === 'completed' ? block.status : evidence.status;
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';

  return (
    <details
      className={`deepcode-gui-block deepcode-gui-block--${block.kind}${narrativeClass}${densityClass}`}
      open={open}
    >
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${status}`} />
        <span className="deepcode-gui-block__title">{title}</span>
        {summary && <span className="deepcode-gui-block__summary">{summary}</span>}
      </summary>
      <div className="deepcode-gui-block__details">
        {block.bodyMarkdown && <MarkdownContent content={block.bodyMarkdown} />}
        <ToolEvidenceDetails evidence={evidence} language={language} />
        {evidence.items.length === 0 && <EventList events={block.events} language={language} />}
      </div>
    </details>
  );
};

const DeepCodeGitReviewDiffDetails: React.FC<{ gitReview: unknown; language: UiLanguage }> = ({ gitReview, language }) => {
  if (!isRecord(gitReview)) return null;
  if (gitReview.available === false) {
    const reason = stringField(gitReview, 'reason') ?? 'Git review unavailable';
    return <div className="deepcode-gui-git-review__summary">{reason}</div>;
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
          {files.length > 12 && <span>{language === 'zh-CN' ? `另有 ${files.length - 12} 个文件` : `${files.length - 12} more files`}</span>}
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
              {truncated ? (language === 'zh-CN' ? '（已截断）' : ' (truncated)') : ''}
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
}> = ({ block, language, animate = false, collapseCompletedThinking = true, onLiveContentChange = () => undefined }) => {
  const narrativeClass = block.narrativeKind ? ` deepcode-gui-block--narrative-${block.narrativeKind}` : '';
  const densityClass = block.displayHints?.density ? ` deepcode-gui-block--density-${block.displayHints.density}` : '';
  const completedThinkingOpen = block.status === 'completed' && !collapseCompletedThinking;
  const open = completedThinkingOpen || (block.displayHints?.initialOpen ?? (!block.defaultCollapsed || block.status === 'running' || block.status === 'waiting'));
  const markdown = thinkingMarkdown(block);
  const summary = compactThinkingSummary(markdown);

  return (
    <details className={`deepcode-gui-block deepcode-gui-block--thinking${narrativeClass}${densityClass}`} open={open}>
      <summary>
        <span className={`deepcode-gui-block__status deepcode-gui-block__status--${block.status}`} />
        <span className="deepcode-gui-block__title">{localizedTimelineText(language, block.title)}</span>
        {summary && <span className="deepcode-gui-block__summary">{summary}</span>}
      </summary>
      <div className="deepcode-gui-block__details deepcode-gui-block__details--thinking">
        <TypewriterMarkdown
          content={markdown}
          animate={animate}
          speed={block.displayHints?.typewriterSpeed}
          onVisibleContentChange={onLiveContentChange}
        />
      </div>
    </details>
  );
};

const PlanBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
  onPlanResolve?: DeepCodeTimelineProps['onPlanResolve'];
}> = ({ block, language, onPlanResolve }) => {
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
      className={`deepcode-gui-block deepcode-gui-block--plan deepcode-gui-block--${status}${narrativeClass}${densityClass}`}
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
        <MarkdownContent content={block.bodyMarkdown ?? block.summary} />
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
}> = ({ content, animate, speed = 'normal', onVisibleContentChange }) => {
  const [visible, setVisible] = useState(() => (animate ? '' : content));
  const visibleRef = useRef(visible);
  const renderedContent = animate ? visible : content;

  useLayoutEffect(() => {
    onVisibleContentChange();
  }, [onVisibleContentChange, renderedContent]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    if (!animate) {
      setVisible(content);
      return undefined;
    }
    const startIndex = content.startsWith(visibleRef.current) ? visibleRef.current.length : 0;
    setVisible(content.slice(0, startIndex));
    if (!content) return;
    let index = startIndex;
    const step = speed === 'fast' ? 12 : speed === 'slow' ? 2 : 4;
    const delayMs = speed === 'fast' ? 8 : speed === 'slow' ? 20 : 12;
    const id = window.setInterval(() => {
      index = Math.min(content.length, index + step);
      setVisible(content.slice(0, index));
      window.requestAnimationFrame(onVisibleContentChange);
      if (index >= content.length) {
        window.clearInterval(id);
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
    ['Kernel state contract entered.', t(language, 'deepcodeGui.timeline.kernelStateEntered')],
    ['Session DriverRequest produced by Kernel.', t(language, 'deepcodeGui.timeline.driverRequestProduced')],
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

function planBlockMarkdown(block: AgentTimelineBlock): string {
  const body = (block.bodyMarkdown ?? block.summary ?? '').trim();
  const title = block.title.trim();
  if (!title || body.startsWith('#')) return body;
  return [`# ${title}`, body].filter(Boolean).join('\n\n');
}

function thinkingMarkdown(block: AgentTimelineBlock): string {
  for (let index = block.events.length - 1; index >= 0; index -= 1) {
    const text = thinkingEventText(block.events[index]);
    if (text) return text;
  }
  return (block.bodyMarkdown ?? block.summary ?? '').trim();
}

function compactThinkingSummary(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= 120) return text;
  return `${text.slice(0, 120).trimEnd()}...`;
}

function thinkingEventText(event: AgentEvent): string {
  if (event.kind !== 'assistant_msg') return '';
  if (typeof event.payload === 'string') return event.payload.trim();
  if (!isRecord(event.payload)) return '';
  const channel = stringField(event.payload, 'channel');
  if (channel && channel !== 'reasoning' && channel !== 'thinking' && channel !== 'thought') {
    return '';
  }
  return (
    stringField(event.payload, 'content') ??
    stringField(event.payload, 'message') ??
    stringField(event.payload, 'details') ??
    stringField(event.payload, 'summary') ??
    ''
  ).trim();
}

function eventText(event: AgentEvent): string {
  if (typeof event.payload === 'string') return event.payload;
  if (!isRecord(event.payload)) return '';
  if (event.kind === 'review_summary') {
    return (
      stringField(event.payload, 'content') ??
      stringField(event.payload, 'summary') ??
      stringField(event.payload, 'message') ??
      ''
    );
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
  const body = (block.bodyMarkdown ?? block.summary ?? activityBody).trim();
  const attachmentText = block.kind === 'user'
    ? attachmentCopyText(blockAttachments(block), language)
    : '';
  if (body) return [[`${title}\n${body}`, attachmentText].filter(Boolean).join('\n\n')];
  const eventLines = block.events.map(eventSummary).filter(Boolean);
  if (eventLines.length > 0) {
    return [[`${title}\n${eventLines.join('\n')}`, attachmentText].filter(Boolean).join('\n\n')];
  }
  return attachmentText ? [attachmentText] : [];
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
