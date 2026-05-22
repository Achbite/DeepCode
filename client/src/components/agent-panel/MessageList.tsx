import React from 'react';
import type { AgentEvent } from '@deepcode/protocol';
import MarkdownContent from './MarkdownContent';
import ToolCallBubble from './ToolCallBubble';

interface MessageListProps {
  events: AgentEvent[];
  loading?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function payloadText(payload: unknown): string {
  return (
    stringField(payload, 'content') ??
    stringField(payload, 'message') ??
    stringField(payload, 'summary') ??
    (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) ?? 'No details')
  );
}

function titleCase(value: string): string {
  if (!value) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function stageLabel(payload: unknown): string {
  const stage = stringField(payload, 'stage') ?? 'workflow';
  const status = stringField(payload, 'status') ?? 'updated';
  return `${titleCase(stage)} ${status}`;
}

function stageStatus(payload: unknown): string {
  return stringField(payload, 'status') ?? 'updated';
}

function eventStage(event: AgentEvent): string | undefined {
  return stringField(event.payload, 'stage');
}

function isAgentThoughtEvent(event: AgentEvent): boolean {
  if (event.kind === 'assistant_msg') {
    const stage = eventStage(event);
    return Boolean(stage && stage !== 'complete');
  }
  if (event.kind === 'workflow_stage') {
    const details = stringField(event.payload, 'details');
    return Boolean(details);
  }
  if (event.kind === 'error') {
    return Boolean(eventStage(event));
  }
  return false;
}

function isExecutionProgressEvent(event: AgentEvent): boolean {
  return (
    event.kind === 'workflow_stage' ||
    event.kind === 'tool_call' ||
    event.kind === 'tool_result' ||
    event.kind === 'permission_result'
  );
}

interface TraceGroup {
  id: string;
  events: AgentEvent[];
}

type RenderItem =
  | { type: 'event'; event: AgentEvent }
  | { type: 'trace'; group: TraceGroup };

function pickFallbackAssistantEvent(events: AgentEvent[]): AgentEvent | null {
  const candidates = events.filter((event) => {
    if (event.kind !== 'assistant_msg') return false;
    const stage = eventStage(event);
    return stage === 'check' || stage === 'plan' || stage === 'review';
  });
  const preferred =
    candidates.find((event) => eventStage(event) === 'check') ??
    candidates.find((event) => eventStage(event) === 'plan') ??
    candidates.find((event) => eventStage(event) === 'review');
  if (!preferred) return null;

  return {
    ...preferred,
    id: `fallback-${preferred.id}`,
    payload: {
      content: payloadText(preferred.payload),
      sourceStage: eventStage(preferred),
    },
  };
}

function pickVisibleAssistantEvent(events: AgentEvent[], thoughtEvents: AgentEvent[]): AgentEvent | null {
  const visible = events.filter((event) => {
    if (event.kind !== 'assistant_msg') return false;
    const stage = eventStage(event);
    return !stage || stage === 'complete';
  });
  if (visible.length > 0) {
    return visible[visible.length - 1];
  }
  return pickFallbackAssistantEvent(thoughtEvents);
}

function isHiddenConversationEvent(event: AgentEvent): boolean {
  return isAgentThoughtEvent(event) || isExecutionProgressEvent(event);
}

function createRenderItems(events: AgentEvent[]): RenderItem[] {
  const items: RenderItem[] = [];
  let index = 0;

  while (index < events.length) {
    const event = events[index];

    if (event.kind === 'user_msg') {
      items.push({ type: 'event', event });
      index += 1;

      const turnEvents: AgentEvent[] = [];
      while (index < events.length && events[index].kind !== 'user_msg') {
        turnEvents.push(events[index]);
        index += 1;
      }

      const thoughtEvents = turnEvents.filter(isAgentThoughtEvent);
      const visibleAssistant = pickVisibleAssistantEvent(turnEvents, thoughtEvents);
      const visibleAssistantId = visibleAssistant?.id;

      if (thoughtEvents.length > 0) {
        const group: TraceGroup = {
          id: `thought-${event.id}-${thoughtEvents[thoughtEvents.length - 1].id}`,
          events: thoughtEvents,
        };
        items.push({ type: 'trace', group });
      }

      for (const turnEvent of turnEvents) {
        if (visibleAssistantId && turnEvent.id === visibleAssistantId) continue;
        if (isHiddenConversationEvent(turnEvent)) continue;
        items.push({ type: 'event', event: turnEvent });
      }

      if (visibleAssistant) {
        items.push({ type: 'event', event: visibleAssistant });
      }
      continue;
    }

    if (isHiddenConversationEvent(event)) {
      index += 1;
      continue;
    }

    items.push({ type: 'event', event });
    index += 1;
  }

  return items;
}

function thoughtTraceTitle(events: AgentEvent[]): string {
  const stages = Array.from(
    new Set(
      events
        .map((event) => eventStage(event))
        .filter((stage): stage is string => Boolean(stage))
    )
  );
  const active = events.some(
    (event) => event.kind === 'workflow_stage' && stageStatus(event.payload) === 'started'
  );
  const stageText = stages.length > 0 ? ` - ${stages.join(' / ')}` : '';
  return `${active ? 'Agent is thinking' : 'Agent thought'}${stageText} - ${events.length} items`;
}

function renderWorkflowStage(event: AgentEvent) {
  const status = stageStatus(event.payload);
  const profileId = stringField(event.payload, 'profileId');
  const summary = stringField(event.payload, 'summary');
  const details = stringField(event.payload, 'details') ?? summary;
  return (
    <div
      key={event.id}
      className={`agent-stage-event agent-stage-event--${status}`}
    >
      <div className="agent-stage-event__header">
        {status === 'started' && <span className="agent-spinner" />}
        <span>{stageLabel(event.payload)}</span>
        {profileId && <span className="agent-stage-event__profile">{profileId}</span>}
      </div>
      {details && (
        <details className="agent-stage-event__details">
          <summary>{summary ? 'Stage summary' : 'Stage details'}</summary>
          <MarkdownContent content={details} />
        </details>
      )}
    </div>
  );
}

function renderError(event: AgentEvent) {
  const message = payloadText(event.payload);
  return (
    <div key={event.id} className="agent-error-card">
      <div className="agent-message__meta">Error</div>
      <div className="agent-message__body agent-message__body--plain">{message}</div>
      {isRecord(event.payload) && (
        <details className="agent-raw-details">
          <summary>Raw error</summary>
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function renderTraceEvent(event: AgentEvent) {
  if (event.kind === 'workflow_stage') {
    return renderWorkflowStage(event);
  }
  if (event.kind === 'assistant_msg') {
    const stage = eventStage(event) ?? 'thought';
    return (
      <div key={event.id} className="agent-trace-output">
        <div className="agent-message__meta">{titleCase(stage)} output</div>
        <MarkdownContent content={payloadText(event.payload)} />
      </div>
    );
  }
  if (event.kind === 'error') {
    return renderError(event);
  }
  return <ToolCallBubble key={event.id} event={event} />;
}

function renderTraceGroup(group: TraceGroup) {
  return (
    <details key={group.id} className="agent-thinking-trace">
      <summary>
        <span className="agent-thinking-trace__left">
          <span className="agent-thinking-trace__icon">&gt;</span>
          <span className="agent-thinking-trace__title">{thoughtTraceTitle(group.events)}</span>
        </span>
        <span className="agent-thinking-trace__hint">Inspect</span>
      </summary>
      <div className="agent-thinking-trace__body">
        {group.events.map(renderTraceEvent)}
      </div>
    </details>
  );
}

function renderMessage(event: AgentEvent) {
  if (event.kind === 'workflow_stage') {
    return renderWorkflowStage(event);
  }
  if (event.kind === 'error') {
    return renderError(event);
  }
  if (
    event.kind === 'tool_call' ||
    event.kind === 'tool_result' ||
    event.kind === 'permission_request' ||
    event.kind === 'permission_result'
  ) {
    return <ToolCallBubble key={event.id} event={event} />;
  }

  const speaker = event.kind === 'user_msg' ? 'You' : 'Agent';
  const pending = isRecord(event.payload) && event.payload.pending === true;
  const text = payloadText(event.payload);
  const renderMarkdown = event.kind === 'assistant_msg';
  return (
    <div
      key={event.id}
      className={`agent-message agent-message--${event.kind}`}
    >
      <div className="agent-message__meta">
        {speaker}
        {pending && <span className="agent-message__stage">Sending...</span>}
      </div>
      <div className={`agent-message__body ${renderMarkdown ? 'agent-message__body--markdown' : 'agent-message__body--plain'}`}>
        {renderMarkdown ? <MarkdownContent content={text} /> : text}
      </div>
    </div>
  );
}

const MessageList: React.FC<MessageListProps> = ({ events, loading = false }) => (
  <div className="agent-message-list">
    {events.length === 0 && !loading && (
      <div className="agent-empty-state">
        <div className="agent-empty-state__title">Agent Ready</div>
        <div className="agent-empty-state__subtle">
          Add files with @ or Explorer right click, then ask for a focused edit.
        </div>
      </div>
    )}

    {createRenderItems(events).map((item) =>
      item.type === 'trace' ? renderTraceGroup(item.group) : renderMessage(item.event)
    )}

    {loading && (
      <div className="agent-thinking">
        <span className="agent-spinner" />
        <span>Agent is thinking...</span>
      </div>
    )}
  </div>
);

export default MessageList;
