import React, { useEffect, useMemo, useState } from 'react';
import type {
  AgentEvent,
  AgentTimelineBlock,
  AgentTimelineResult,
  AgentTimelineTurn,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
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

  return (
    <section className={`codex-turn codex-turn--${turn.status}`}>
      <div className="codex-turn__rail" />
      <div className="codex-turn__body">
        <div className="codex-turn__meta">
          <span>{timelineStatusLabel(language, turn.status)}</span>
          {startedAtLabel && <span>{startedAtLabel}</span>}
        </div>
        {turn.blocks.map((block) => (
          <TimelineBlock key={block.id} block={block} language={language} onPlanResolve={onPlanResolve} />
        ))}
      </div>
    </section>
  );
};

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
