import React from 'react';
import type { AgentDisplayPolicy, AgentEvent, AgentEventPresentation } from '@deepcode/protocol';
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

interface ToolBatchGroup {
  id: string;
  label: string;
  events: AgentEvent[];
  autoOpen?: boolean;
}

const DEFAULT_AGENT_DISPLAY_POLICY: AgentDisplayPolicy = {
  density: 'balanced',
  presentationByChannel: {
    user: 'body',
    progress: 'body',
    observation: 'body',
    final: 'body',
    reasoning: 'collapsible',
    action: 'collapsible',
    tool: 'collapsible',
    task: 'stageSummary',
    error: 'collapsible',
  },
  defaultOpenByChannel: {
    user: true,
    progress: true,
    observation: true,
    final: true,
    reasoning: false,
    action: false,
    tool: false,
    task: false,
    error: true,
  },
};

type RenderItem =
  | { type: 'event'; event: AgentEvent; autoOpen?: boolean }
  | { type: 'trace'; group: TraceGroup }
  | { type: 'toolBatch'; group: ToolBatchGroup }
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

function eventChannel(event: AgentEvent): string | undefined {
  return stringField(event.payload, 'channel');
}

function eventVisibility(event: AgentEvent): string | undefined {
  return stringField(event.payload, 'visibility');
}

function eventPresentation(event: AgentEvent): AgentEventPresentation | undefined {
  if (event.display?.presentation) return event.display.presentation;
  const channel = eventChannel(event);
  if (!channel) return undefined;
  return DEFAULT_AGENT_DISPLAY_POLICY.presentationByChannel?.[channel as keyof NonNullable<AgentDisplayPolicy['presentationByChannel']>];
}

function eventDefaultOpen(event: AgentEvent): boolean | undefined {
  if (typeof event.display?.defaultOpen === 'boolean') return event.display.defaultOpen;
  const channel = eventChannel(event);
  if (!channel) return undefined;
  return DEFAULT_AGENT_DISPLAY_POLICY.defaultOpenByChannel?.[channel as keyof NonNullable<AgentDisplayPolicy['defaultOpenByChannel']>];
}

function eventBatchId(event: AgentEvent): string | undefined {
  return stringField(event.payload, 'batchId');
}

function eventBatchLabel(event: AgentEvent): string {
  return stringField(event.payload, 'batchLabel') ?? '执行工具';
}

function eventStageRunId(event: AgentEvent): string | undefined {
  return stringField(event.payload, 'stageRunId');
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

function isAgentThoughtEvent(event: AgentEvent): boolean {
  const presentation = eventPresentation(event);
  if (presentation === 'body') return false;
  if (presentation === 'traceOnly' || (presentation === 'collapsible' && eventChannel(event) === 'reasoning')) return true;
  if (eventChannel(event) === 'reasoning') return true;
  if (event.kind === 'error') {
    return Boolean(eventStage(event));
  }
  return false;
}

function isExecutionProgressEvent(event: AgentEvent): boolean {
  const presentation = eventPresentation(event);
  if (presentation === 'body') return false;
  if (presentation === 'stageSummary' || presentation === 'traceOnly') return true;
  return event.kind === 'workflow_stage' || eventVisibility(event) === 'task';
}

function isHiddenConversationEvent(event: AgentEvent): boolean {
  return isAgentThoughtEvent(event) || isExecutionProgressEvent(event);
}

function isToolTimelineEvent(event: AgentEvent): boolean {
  return (
    event.kind === 'tool_call' ||
    event.kind === 'tool_result' ||
    event.kind === 'permission_request' ||
    event.kind === 'permission_result'
  );
}

function isTurnComplete(events: AgentEvent[]): boolean {
  return !events.some((event, index) => {
    if (event.kind === 'workflow_stage' && stageStatus(event.payload) === 'started') {
      const stageRunId = eventStageRunId(event);
      const stage = eventStage(event);
      const later = events.slice(index + 1);
      const resolved = later.some((next) => {
        if (next.kind !== 'workflow_stage') return false;
        const status = stageStatus(next.payload);
        if (status !== 'completed' && status !== 'error') return false;
        if (stageRunId) return eventStageRunId(next) === stageRunId;
        return eventStage(next) === stage;
      });
      return !resolved;
    }
    return isRecord(event.payload) && event.payload.pending === true;
  });
}

function pickVisibleAssistantEvent(events: AgentEvent[]): AgentEvent | null {
  const explicitFinal = events.filter((event) =>
    event.kind === 'assistant_msg' && eventChannel(event) === 'final'
  );
  if (explicitFinal.length > 0) return explicitFinal[explicitFinal.length - 1];

  return null;
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

      const finalAssistant = pickVisibleAssistantEvent(turnEvents);
      const renderedEventIds = new Set<string>();

      for (let turnIndex = 0; turnIndex < turnEvents.length; turnIndex += 1) {
        const turnEvent = turnEvents[turnIndex];
        if (isAgentThoughtEvent(turnEvent)) {
          const groupEvents: AgentEvent[] = [];
          while (turnIndex < turnEvents.length && isAgentThoughtEvent(turnEvents[turnIndex])) {
            groupEvents.push(turnEvents[turnIndex]);
            renderedEventIds.add(turnEvents[turnIndex].id);
            turnIndex += 1;
          }
          turnIndex -= 1;
          items.push({
            type: 'trace',
            group: {
              id: `trace-${event.id}-${groupEvents[0]?.id}`,
              events: groupEvents,
            },
          });
          continue;
        }

        if (isHiddenConversationEvent(turnEvent)) continue;
        if (finalAssistant && turnEvent.id === finalAssistant.id) {
          continue;
        }

        if (isToolTimelineEvent(turnEvent)) {
          const batchEvents: AgentEvent[] = [];
          const batchId = eventBatchId(turnEvent);
          while (
            turnIndex < turnEvents.length &&
            isToolTimelineEvent(turnEvents[turnIndex]) &&
            (batchId ? eventBatchId(turnEvents[turnIndex]) === batchId : !eventBatchId(turnEvents[turnIndex]))
          ) {
            batchEvents.push(turnEvents[turnIndex]);
            renderedEventIds.add(turnEvents[turnIndex].id);
            turnIndex += 1;
          }
          turnIndex -= 1;
          items.push({
            type: 'toolBatch',
            group: {
              id: `tool-batch-${event.id}-${batchId ?? batchEvents[0]?.id}`,
              label: eventBatchLabel(turnEvent),
              events: batchEvents,
              autoOpen: batchEvents.some((batchEvent, batchEventIndex) =>
                batchEvent.kind === 'tool_call' && !hasLaterResult(batchEvents, batchEventIndex)
              ),
            },
          });
          continue;
        }

        renderedEventIds.add(turnEvent.id);
        items.push({
          type: 'event',
          event: turnEvent,
          autoOpen: eventDefaultOpen(turnEvent) ?? (turnEvent.kind === 'tool_call' && !hasLaterResult(turnEvents, turnEvents.indexOf(turnEvent))),
        });
      }

      if (finalAssistant && !renderedEventIds.has(finalAssistant.id)) {
        items.push({ type: 'event', event: finalAssistant });
      }

      if (finalAssistant && !loading && isTurnComplete(turnEvents)) {
        items.push({
          type: 'turnActions',
          id: `turn-actions-${event.id}`,
          events: [event, ...turnEvents],
          targetEvent: finalAssistant,
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
  return `${active ? '思考中' : '思考过程'}${stageText} - ${events.length} 条`;
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
        <span className="agent-thinking-trace__hint">Details</span>
      </summary>
      <div className="agent-thinking-trace__body">
        {group.events.map(renderTraceEvent)}
      </div>
    </details>
  );
}

function renderToolBatch(group: ToolBatchGroup) {
  const hasError = group.events.some((event) => eventStatus(event) === 'error');
  const allDone = group.events.some((event) => event.kind === 'tool_result' || event.kind === 'permission_result');
  const status = hasError ? 'error' : allDone ? 'done' : 'running';
  const open = group.autoOpen || group.events.some((event) => eventDefaultOpen(event) === true && status !== 'done');
  return (
    <details key={group.id} className="agent-tool-batch" open={open}>
      <summary>
        <span className="agent-tool-batch__label">{group.label}</span>
        <span className={`agent-tool-batch__status agent-tool-batch__status--${status}`}>{status}</span>
      </summary>
      <div className="agent-tool-batch__body">
        {group.events.map((event, index) => (
          <ToolCallBubble key={`${event.id}-${index}`} event={event} autoOpen={eventDefaultOpen(event) ?? group.autoOpen} />
        ))}
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

  const label = stringField(event.payload, 'label');
  const speaker = event.kind === 'user_msg' ? 'You' : (label ?? 'Agent');
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
      if (item.type === 'toolBatch') return renderToolBatch(item.group);
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
