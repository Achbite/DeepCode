import React, { useEffect, useMemo, useState } from 'react';
import type {
  AgentEvent,
  AgentTimelineBlock,
  AgentTimelineResult,
  AgentTimelineTurn,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { submitAgentFeedback } from '../../services/runtimeAdapter';
import MarkdownContent from '../../components/agent-panel/LazyMarkdownContent';

interface CodexTimelineProps {
  timeline: AgentTimelineResult | null;
  fallbackEvents: AgentEvent[];
  loading: boolean;
  language: UiLanguage;
  onPlanResolve?: (
    runId: string,
    planId: string,
    decision: 'accept' | 'reject' | 'revise',
    guidance?: string
  ) => void;
}

const CodexTimeline: React.FC<CodexTimelineProps> = ({
  timeline,
  fallbackEvents,
  loading,
  language,
  onPlanResolve,
}) => {
  const fallbackTimeline = useMemo(
    () => localFallbackTimeline(fallbackEvents),
    [fallbackEvents]
  );
  const view = timeline ?? fallbackTimeline;

  return (
    <div className="codex-timeline">
      {view.turns.length === 0 && !loading && (
        <div className="codex-empty">
          <div className="codex-empty__title">{t(language, 'deepcodeGui.status.ready')}</div>
        </div>
      )}
      {view.turns.map((turn) => (
        <TurnCard key={turn.id} turn={turn} language={language} onPlanResolve={onPlanResolve} />
      ))}
      {loading && (
        <div className="codex-live-indicator">
          <span className="codex-live-indicator__dot" />
          {t(language, 'deepcodeGui.status.running')}
        </div>
      )}
    </div>
  );
};

const TurnCard: React.FC<{
  turn: AgentTimelineTurn;
  language: UiLanguage;
  onPlanResolve?: CodexTimelineProps['onPlanResolve'];
}> = ({ turn, language, onPlanResolve }) => {
  const startedAtLabel = formatTurnTime(turn.startedAt);
  const blocks = orderedTurnBlocks(turn.blocks);

  return (
    <section className={`codex-turn codex-turn--${turn.status}`}>
      <div className="codex-turn__rail" />
      <div className="codex-turn__body">
        <div className="codex-turn__meta">
          <span>{timelineStatusLabel(language, turn.status)}</span>
          {startedAtLabel && <span>{startedAtLabel}</span>}
        </div>
        {blocks.map((block) => (
          <TimelineBlock key={block.id} block={block} language={language} onPlanResolve={onPlanResolve} />
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
    <div className="codex-turn-actions" aria-label={t(language, 'agent.message.actions')}>
      <button
        type="button"
        className="codex-turn-actions__button"
        onClick={() => void copyTurn()}
        title={t(language, 'agent.message.copyAgentOutput')}
        aria-label={t(language, 'agent.message.copyAgentOutput')}
      >
        <CodexTurnActionIcon name="copy" />
      </button>
      <button
        type="button"
        className="codex-turn-actions__button"
        onClick={() => rateTurn('up')}
        disabled={!feedbackEvent}
        title={t(language, 'agent.message.feedbackUpTitle')}
        aria-label={t(language, 'agent.message.feedbackUpTitle')}
      >
        <CodexTurnActionIcon name="up" />
      </button>
      <button
        type="button"
        className="codex-turn-actions__button"
        onClick={() => rateTurn('down')}
        disabled={!feedbackEvent}
        title={t(language, 'agent.message.feedbackDownTitle')}
        aria-label={t(language, 'agent.message.feedbackDownTitle')}
      >
        <CodexTurnActionIcon name="down" />
      </button>
      {status !== 'idle' && (
        <span className={`codex-turn-actions__status codex-turn-actions__status--${status}`}>
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

const CodexTurnActionIcon: React.FC<{ name: 'copy' | 'up' | 'down' }> = ({ name }) => {
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

function orderedTurnBlocks(blocks: AgentTimelineBlock[]): AgentTimelineBlock[] {
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((left, right) => {
      const priorityDelta = timelineBlockPriority(left.block.kind) - timelineBlockPriority(right.block.kind);
      return priorityDelta || left.index - right.index;
    })
    .map((entry) => entry.block);
}

function timelineBlockPriority(kind: AgentTimelineBlock['kind']): number {
  switch (kind) {
    case 'user':
      return 0;
    case 'thinking':
      return 1;
    case 'stage':
      return 2;
    case 'toolBatch':
      return 3;
    case 'permission':
      return 4;
    case 'plan':
      return 5;
    case 'review':
      return 6;
    case 'error':
      return 7;
    case 'turnActions':
      return 8;
    case 'assistant':
      return 9;
    default:
      return 10;
  }
}

const TimelineBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
  onPlanResolve?: CodexTimelineProps['onPlanResolve'];
}> = ({ block, language, onPlanResolve }) => {
  if (block.kind === 'user') {
    return (
      <article className="codex-block codex-block--user">
        <div className="codex-block__label">{t(language, 'agent.message.user')}</div>
        <MarkdownContent content={block.bodyMarkdown ?? block.summary} />
      </article>
    );
  }

  if (block.kind === 'assistant') {
    return (
      <article className="codex-block codex-block--assistant">
        <div className="codex-block__label">DeepCode</div>
        <TypewriterMarkdown content={block.bodyMarkdown ?? block.summary} />
      </article>
    );
  }

  if (block.kind === 'plan') {
    return <PlanBlock block={block} language={language} onPlanResolve={onPlanResolve} />;
  }

  const open = !block.defaultCollapsed || block.status === 'running' || block.status === 'waiting';
  return (
    <details className={`codex-block codex-block--${block.kind}`} open={open}>
      <summary>
        <span className={`codex-block__status codex-block__status--${block.status}`} />
        <span className="codex-block__title">{block.title}</span>
        <span className="codex-block__summary">{block.summary}</span>
      </summary>
      <div className="codex-block__details">
        {block.bodyMarkdown && <MarkdownContent content={block.bodyMarkdown} />}
        <EventList events={block.events} />
      </div>
    </details>
  );
};

const PlanBlock: React.FC<{
  block: AgentTimelineBlock;
  language: UiLanguage;
  onPlanResolve?: CodexTimelineProps['onPlanResolve'];
}> = ({ block, language, onPlanResolve }) => {
  const [guidance, setGuidance] = useState('');
  const reviewEvent = block.events.find((event) => event.kind === 'plan_review');
  const payload = isRecord(reviewEvent?.payload) ? reviewEvent.payload : {};
  const runId = stringField(payload, 'runId');
  const planId = stringField(payload, 'planId');
  const status = stringField(payload, 'status') ?? block.status;
  const confirmable = payload.confirmable === true && Boolean(runId && planId);

  return (
    <article className={`codex-block codex-block--plan codex-block--${status}`}>
      <div className="codex-block__label">{block.title}</div>
      <MarkdownContent content={block.bodyMarkdown ?? block.summary} />
      <EventList events={block.events} compact />
      {confirmable && (
        <div className="codex-plan-actions">
          <textarea
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
            placeholder={t(language, 'deepcodeGui.plan.guidancePlaceholder')}
          />
          <div className="codex-plan-actions__buttons">
            <button type="button" onClick={() => onPlanResolve?.(runId!, planId!, 'accept')}>
              {t(language, 'deepcodeGui.plan.accept')}
            </button>
            <button
              type="button"
              onClick={() =>
                onPlanResolve?.(
                  runId!,
                  planId!,
                  guidance.trim() ? 'revise' : 'reject',
                  guidance.trim() || undefined
                )
              }
            >
              {guidance.trim()
                ? t(language, 'deepcodeGui.plan.sendRevision')
                : t(language, 'deepcodeGui.plan.reject')}
            </button>
          </div>
        </div>
      )}
    </article>
  );
};

const TypewriterMarkdown: React.FC<{ content: string }> = ({ content }) => {
  const [visible, setVisible] = useState('');

  useEffect(() => {
    setVisible('');
    if (!content) return;
    let index = 0;
    const id = window.setInterval(() => {
      index = Math.min(content.length, index + 4);
      setVisible(content.slice(0, index));
      if (index >= content.length) {
        window.clearInterval(id);
      }
    }, 12);
    return () => window.clearInterval(id);
  }, [content]);

  return <MarkdownContent content={visible || content} />;
};

const EventList: React.FC<{ events: AgentEvent[]; compact?: boolean }> = ({ events, compact }) => (
  <div className={`codex-event-list ${compact ? 'codex-event-list--compact' : ''}`}>
    {events.map((event) => (
      <div key={event.id} className="codex-event">
        <span className="codex-event__kind">{event.kind}</span>
        <span className="codex-event__text">{eventSummary(event)}</span>
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
              kind: event.kind === 'user_msg' ? 'user' : event.kind === 'assistant_msg' ? 'assistant' : 'stage',
              title: event.kind,
              summary: eventSummary(event),
              status: 'completed',
              defaultCollapsed: event.kind !== 'user_msg' && event.kind !== 'assistant_msg',
              bodyMarkdown: eventText(event),
              events: [event],
            })),
          },
        ],
  };
}

function eventSummary(event: AgentEvent): string {
  return eventText(event) || event.kind;
}

function eventText(event: AgentEvent): string {
  if (typeof event.payload === 'string') return event.payload;
  if (!isRecord(event.payload)) return '';
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
  const body = (block.bodyMarkdown ?? block.summary ?? '').trim();
  if (body) return [`${title}\n${body}`];
  const eventLines = block.events.map(eventSummary).filter(Boolean);
  return eventLines.length > 0 ? [`${title}\n${eventLines.join('\n')}`] : [];
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

export default CodexTimeline;
