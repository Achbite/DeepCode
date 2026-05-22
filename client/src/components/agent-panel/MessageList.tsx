import React from 'react';
import type { AgentEvent } from '@deepcode/protocol';
import MarkdownContent from './MarkdownContent';
import ToolCallBubble from './ToolCallBubble';
import { sanitizeDisplayText } from './displayText';
import { submitAgentFeedback } from '../../services/runtimeAdapter';

interface MessageListProps {
  events: AgentEvent[];
  loading?: boolean;
}

interface TraceGroup {
  id: string;
  events: AgentEvent[];
}

type RenderItem =
  | { type: 'event'; event: AgentEvent; autoOpen?: boolean }
  | { type: 'trace'; group: TraceGroup }
  | { type: 'turnActions'; id: string; events: AgentEvent[]; targetEvent: AgentEvent };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function payloadText(payload: unknown): string {
  return sanitizeDisplayText(
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

function eventCallId(event: AgentEvent): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  return stringField(event.payload, 'callId') ?? stringField(event.payload, 'id');
}

function nestedRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return isRecord(payload[key]) ? payload[key] as Record<string, unknown> : undefined;
}

function eventToolName(event: AgentEvent): string {
  if (!isRecord(event.payload)) return 'tool';
  const toolCall = nestedRecord(event.payload, 'toolCall');
  return (
    stringField(event.payload, 'toolName') ??
    stringField(event.payload, 'name') ??
    (toolCall ? stringField(toolCall, 'name') : undefined) ??
    stringField(event.payload, 'actionType') ??
    'tool'
  );
}

function eventCommand(event: AgentEvent): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  const args =
    nestedRecord(event.payload, 'arguments') ??
    nestedRecord(event.payload, 'input') ??
    nestedRecord(event.payload, 'output') ??
    event.payload;
  return stringField(args, 'command') ?? stringField(event.payload, 'command');
}

function eventPath(event: AgentEvent): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  const args =
    nestedRecord(event.payload, 'arguments') ??
    nestedRecord(event.payload, 'input') ??
    nestedRecord(event.payload, 'output') ??
    event.payload;
  return stringField(args, 'path') ?? stringField(args, 'cwd') ?? stringField(event.payload, 'path');
}

function eventStatus(event: AgentEvent): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  if (typeof event.payload.ok === 'boolean') return event.payload.ok ? 'ok' : 'error';
  return stringField(event.payload, 'status') ?? stringField(event.payload, 'decision');
}

function eventOutput(event: AgentEvent): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  const output = nestedRecord(event.payload, 'output');
  const values = [
    output ? stringField(output, 'stdout') : undefined,
    output ? stringField(output, 'stderr') : undefined,
    stringField(event.payload, 'error'),
    stringField(event.payload, 'summary'),
    stringField(event.payload, 'message'),
  ].filter(Boolean);
  return values.length > 0 ? sanitizeDisplayText(values.join('\n')) : undefined;
}

function hasLaterResult(events: AgentEvent[], index: number): boolean {
  const later = events.slice(index + 1);
  const callId = eventCallId(events[index]);
  if (callId) {
    return later.some((event) => event.kind === 'tool_result' && eventCallId(event) === callId);
  }
  return later.some((event) => event.kind === 'tool_result');
}

function hasLaterPermissionResult(events: AgentEvent[], index: number): boolean {
  const later = events.slice(index + 1);
  const callId = eventCallId(events[index]);
  if (callId) {
    return later.some((event) => event.kind === 'permission_result' && eventCallId(event) === callId);
  }
  return later.some((event) => event.kind === 'permission_result');
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
  return event.kind === 'workflow_stage';
}

function isHiddenConversationEvent(event: AgentEvent): boolean {
  return isAgentThoughtEvent(event) || isExecutionProgressEvent(event);
}

function isTurnComplete(events: AgentEvent[]): boolean {
  return !events.some((event, index) => {
    if (event.kind === 'workflow_stage' && stageStatus(event.payload) === 'started') return true;
    if (event.kind === 'tool_call' && !hasLaterResult(events, index)) return true;
    if (event.kind === 'permission_request' && !hasLaterPermissionResult(events, index)) return true;
    return isRecord(event.payload) && event.payload.pending === true;
  });
}

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
  if (visible.length > 0) return visible[visible.length - 1];
  return pickFallbackAssistantEvent(thoughtEvents);
}

function createRenderItems(events: AgentEvent[], loading: boolean): RenderItem[] {
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

      if (visibleAssistant) {
        items.push({ type: 'event', event: visibleAssistant });
      }

      for (const turnEvent of turnEvents) {
        if (visibleAssistantId && turnEvent.id === visibleAssistantId) continue;
        if (isHiddenConversationEvent(turnEvent)) continue;
        items.push({
          type: 'event',
          event: turnEvent,
          autoOpen: turnEvent.kind === 'tool_call' && !hasLaterResult(turnEvents, turnEvents.indexOf(turnEvent)),
        });
      }

      if (visibleAssistant && !loading && isTurnComplete(turnEvents)) {
        items.push({
          type: 'turnActions',
          id: `turn-actions-${event.id}`,
          events: [event, ...turnEvents],
          targetEvent: visibleAssistant,
        });
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

function workflowCopyText(events: AgentEvent[]): string {
  const blocks = events.map((event) => {
    if (event.kind === 'user_msg') return `User\n${payloadText(event.payload)}`;
    if (event.kind === 'assistant_msg') {
      const stage = eventStage(event);
      return `${stage ? `Agent (${stage})` : 'Agent'}\n${payloadText(event.payload)}`;
    }
    if (event.kind === 'workflow_stage') {
      const stage = stringField(event.payload, 'stage') ?? 'workflow';
      const status = stageStatus(event.payload);
      const profile = stringField(event.payload, 'profileId');
      const summary = stringField(event.payload, 'summary') ?? stringField(event.payload, 'details');
      return [`Stage ${stage} - ${status}${profile ? ` - ${profile}` : ''}`, summary].filter(Boolean).join('\n');
    }
    if (event.kind === 'tool_call') {
      return [
        `Tool call - ${eventToolName(event)}`,
        eventCommand(event) ? `command: ${eventCommand(event)}` : undefined,
        eventPath(event) ? `path: ${eventPath(event)}` : undefined,
      ].filter(Boolean).join('\n');
    }
    if (event.kind === 'tool_result') {
      return [
        `Tool result - ${eventToolName(event)} - ${eventStatus(event) ?? 'done'}`,
        eventOutput(event),
      ].filter(Boolean).join('\n');
    }
    if (event.kind === 'permission_request') {
      return [
        `Permission request - ${eventToolName(event)}`,
        stringField(event.payload, 'summary') ?? eventCommand(event) ?? eventPath(event),
      ].filter(Boolean).join('\n');
    }
    if (event.kind === 'permission_result') {
      return `Permission result - ${eventStatus(event) ?? 'resolved'}`;
    }
    if (event.kind === 'error') return `Error\n${payloadText(event.payload)}`;
    return `${event.kind}\n${payloadText(event.payload)}`;
  });

  return blocks.filter(Boolean).join('\n\n---\n\n');
}

function thoughtTraceTitle(events: AgentEvent[]): string {
  const stages = Array.from(
    new Set(events.map((event) => eventStage(event)).filter((stage): stage is string => Boolean(stage)))
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
    <div key={event.id} className={`agent-stage-event agent-stage-event--${status}`}>
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
  if (event.kind === 'workflow_stage') return renderWorkflowStage(event);
  if (event.kind === 'assistant_msg') {
    const stage = eventStage(event) ?? 'thought';
    return (
      <div key={event.id} className="agent-trace-output">
        <div className="agent-message__meta">{titleCase(stage)} output</div>
        <MarkdownContent content={payloadText(event.payload)} />
      </div>
    );
  }
  if (event.kind === 'error') return renderError(event);
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

function feedback(event: AgentEvent, rating: 'up' | 'down'): void {
  window.dispatchEvent(new CustomEvent('deepcode:agent-feedback', {
    detail: {
      eventId: event.id,
      kind: event.kind,
      rating,
    },
  }));
  void submitAgentFeedback({
    eventId: event.id,
    sessionId: event.sessionId,
    kind: event.kind,
    rating,
  });
}

function copyMessage(text: string): void {
  void navigator.clipboard?.writeText(text);
}

function TurnActions({ events, targetEvent }: { events: AgentEvent[]; targetEvent: AgentEvent }) {
  const text = workflowCopyText(events);
  return (
    <div className="agent-turn-actions" aria-label="Agent workflow actions">
      <button type="button" title="Copy workflow output" onClick={() => copyMessage(text)}>Copy workflow</button>
      <button type="button" title="Good response" onClick={() => feedback(targetEvent, 'up')}>Up</button>
      <button type="button" title="Bad response" onClick={() => feedback(targetEvent, 'down')}>Down</button>
    </div>
  );
}

function renderMessage(event: AgentEvent, autoOpen = false) {
  if (event.kind === 'workflow_stage') return renderWorkflowStage(event);
  if (event.kind === 'error') return renderError(event);
  if (
    event.kind === 'tool_call' ||
    event.kind === 'tool_result' ||
    event.kind === 'permission_request' ||
    event.kind === 'permission_result'
  ) {
    return <ToolCallBubble key={event.id} event={event} autoOpen={autoOpen} />;
  }

  const speaker = event.kind === 'user_msg' ? 'You' : 'Agent';
  const pending = isRecord(event.payload) && event.payload.pending === true;
  const text = payloadText(event.payload);
  const renderMarkdown = event.kind === 'assistant_msg' || event.kind === 'user_msg';
  return (
    <div key={event.id} className={`agent-message agent-message--${event.kind}`}>
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

    {createRenderItems(events, loading).map((item) => {
      if (item.type === 'trace') return renderTraceGroup(item.group);
      if (item.type === 'turnActions') {
        return <TurnActions key={item.id} events={item.events} targetEvent={item.targetEvent} />;
      }
      return renderMessage(item.event, item.autoOpen);
    })}

    {loading && (
      <div className="agent-thinking">
        <span className="agent-spinner" />
        <span>Agent is thinking...</span>
      </div>
    )}
  </div>
);

export default MessageList;
