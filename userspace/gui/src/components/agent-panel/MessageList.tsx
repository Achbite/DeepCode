import React from 'react';
import type { AgentDisplayPolicy, AgentEvent, AgentEventPresentation } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import MarkdownContent from './LazyMarkdownContent';
import ToolCallBubble from './ToolCallBubble';
import { compactDisplayText, sanitizeDisplayText } from './displayText';
import { submitAgentFeedback } from '../../services/runtimeAdapter';

interface MessageListProps {
  events: AgentEvent[];
  loading?: boolean;
  language: UiLanguage;
}

interface TraceGroup {
  id: string;
  events: AgentEvent[];
  running?: boolean;
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

const ASSISTANT_PREVIEW_TEXT_LIMIT = 180;
const ASSISTANT_COLLAPSE_TEXT_LIMIT = 260;
const ASSISTANT_COLLAPSE_LINE_LIMIT = 6;

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

function shouldCollapseAssistantMessage(event: AgentEvent, text: string): boolean {
  if (event.kind !== 'assistant_msg') return false;
  if (eventChannel(event) === 'final') return false;
  if (isRecord(event.payload) && event.payload.pending === true) return false;

  const presentation = eventPresentation(event);
  const channel = eventChannel(event);
  const eligible =
    presentation === 'collapsible' ||
    channel === 'progress' ||
    channel === 'observation';
  if (!eligible) return false;

  return text.length > ASSISTANT_COLLAPSE_TEXT_LIMIT ||
    text.split('\n').length > ASSISTANT_COLLAPSE_LINE_LIMIT;
}

function titleCase(value: string): string {
  if (!value) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

const STAGE_LABEL_KEYS: Record<string, string> = {
  plan: 'agent.stage.plan',
  check: 'agent.stage.check',
  complete: 'agent.stage.complete',
  review: 'agent.stage.review',
  workflow: 'agent.stage.workflow',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  started: 'agent.status.started',
  completed: 'agent.status.completed',
  error: 'agent.status.error',
  updated: 'agent.status.updated',
  done: 'agent.status.done',
  running: 'agent.status.running',
};

function localizedStage(value: string, language: UiLanguage): string {
  const key = STAGE_LABEL_KEYS[value];
  return key ? t(language, key) : titleCase(value);
}

function localizedStatus(value: string, language: UiLanguage): string {
  const key = STATUS_LABEL_KEYS[value];
  return key ? t(language, key) : value;
}

function stageLabel(payload: unknown, language: UiLanguage): string {
  const stage = stringField(payload, 'stage') ?? 'workflow';
  const status = stringField(payload, 'status') ?? 'updated';
  return t(language, 'agent.workflow.stageLabel', {
    stage: localizedStage(stage, language),
    status: localizedStatus(status, language),
  });
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
  return event.kind === 'workflow_stage' || event.kind === 'workflow_decision' || eventVisibility(event) === 'task';
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

function hasMatchingStageResult(events: AgentEvent[], source: AgentEvent): boolean {
  const stageRunId = eventStageRunId(source);
  const stage = eventStage(source);
  if (!stageRunId && !stage) return false;

  return events.some((event) => {
    if (event.kind !== 'workflow_stage') return false;
    const status = stageStatus(event.payload);
    if (status !== 'completed' && status !== 'error') return false;
    if (stageRunId) return eventStageRunId(event) === stageRunId;
    return eventStage(event) === stage;
  });
}

function traceGroupRunning(groupEvents: AgentEvent[], turnEvents: AgentEvent[], loading: boolean): boolean {
  if (!loading) return false;
  return groupEvents.some((event) => {
    const stageRunId = eventStageRunId(event);
    const stage = eventStage(event);
    if (!stageRunId && !stage) return false;
    return !hasMatchingStageResult(turnEvents, event);
  });
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
              running: traceGroupRunning(groupEvents, turnEvents, loading),
            },
          });
          continue;
        }

        if (isHiddenConversationEvent(turnEvent)) continue;
        if (
          finalAssistant &&
          turnEvent.kind === 'assistant_msg' &&
          eventChannel(turnEvent) === 'final' &&
          turnEvent.id !== finalAssistant.id
        ) {
          renderedEventIds.add(turnEvent.id);
          continue;
        }
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

function workflowCopyText(events: AgentEvent[], language: UiLanguage): string {
  const blocks = events.map((event) => {
    if (event.kind === 'user_msg') {
      return `${t(language, 'agent.copy.user')}\n${payloadText(event.payload)}`;
    }
    if (event.kind === 'assistant_msg') {
      const stage = eventStage(event);
      const channel = eventChannel(event);
      const label =
        channel === 'reasoning'
          ? `${t(language, 'agent.copy.thinking')}${stage ? ` (${localizedStage(stage, language)})` : ''}`
          : channel === 'observation'
            ? `${t(language, 'agent.copy.observation')}${stage ? ` (${localizedStage(stage, language)})` : ''}`
            : `${stage && channel !== 'final' ? `Agent (${localizedStage(stage, language)})` : 'Agent'}`;
      return `${label}\n${payloadText(event.payload)}`;
    }
    if (event.kind === 'workflow_stage') {
      const stage = stringField(event.payload, 'stage') ?? 'workflow';
      const status = stageStatus(event.payload);
      const profile = stringField(event.payload, 'profileId');
      return `${t(language, 'agent.copy.stage')} ${localizedStage(stage, language)} - ${localizedStatus(status, language)}${profile ? ` - ${profile}` : ''}`;
    }
    if (event.kind === 'workflow_decision') {
      const stage = stringField(event.payload, 'stage') ?? 'workflow';
      const status = stageStatus(event.payload);
      const profile = stringField(event.payload, 'profileId');
      return `${t(language, 'agent.copy.stage')} ${localizedStage(stage, language)} - ${localizedStatus(status, language)}${profile ? ` - ${profile}` : ''}`;
    }
    if (event.kind === 'tool_call') {
      return [
        `${t(language, 'agent.copy.toolCall')} - ${eventToolName(event)}`,
        eventCommand(event) ? `command: ${eventCommand(event)}` : undefined,
        eventPath(event) ? `path: ${eventPath(event)}` : undefined,
      ].filter(Boolean).join('\n');
    }
    if (event.kind === 'tool_result') {
      return [
        `${t(language, 'agent.copy.toolResult')} - ${eventToolName(event)} - ${localizedStatus(eventStatus(event) ?? 'done', language)}`,
        eventOutput(event),
      ].filter(Boolean).join('\n');
    }
    if (event.kind === 'permission_request') {
      return [
        `${t(language, 'agent.copy.permissionRequest')} - ${eventToolName(event)}`,
        stringField(event.payload, 'summary') ?? eventCommand(event) ?? eventPath(event),
      ].filter(Boolean).join('\n');
    }
    if (event.kind === 'permission_result') {
      return `${t(language, 'agent.copy.permissionResult')} - ${eventStatus(event) ?? 'resolved'}`;
    }
    if (event.kind === 'error') {
      return `${t(language, 'agent.copy.error')}\n${payloadText(event.payload)}`;
    }
    return `${event.kind}\n${payloadText(event.payload)}`;
  });

  return blocks.filter(Boolean).join('\n\n---\n\n');
}

function thoughtTraceTitle(events: AgentEvent[], language: UiLanguage, running = false): string {
  const stages = Array.from(
    new Set(events.map((event) => eventStage(event)).filter((stage): stage is string => Boolean(stage)))
  );
  const stageText = stages.length > 0
    ? ` - ${stages.map((stage) => localizedStage(stage, language)).join(' / ')}`
    : '';
  const prefix = running ? t(language, 'agent.trace.thinking') : t(language, 'agent.trace.title');
  const countSuffix = t(language, 'agent.trace.count', { count: events.length });
  return `${prefix}${stageText} - ${countSuffix}`;
}

function renderWorkflowStage(event: AgentEvent, language: UiLanguage) {
  const status = stageStatus(event.payload);
  const profileId = stringField(event.payload, 'profileId');
  const summary = stringField(event.payload, 'summary');
  const details = stringField(event.payload, 'details') ?? summary;
  return (
    <div key={event.id} className={`agent-stage-event agent-stage-event--${status}`}>
      <div className="agent-stage-event__header">
        {status === 'started' && <span className="agent-spinner" />}
        <span>{stageLabel(event.payload, language)}</span>
        {profileId && <span className="agent-stage-event__profile">{profileId}</span>}
      </div>
      {details && (
        <details className="agent-stage-event__details">
          <summary>{summary
            ? t(language, 'agent.workflow.summary')
            : t(language, 'agent.workflow.details')}
          </summary>
          <MarkdownContent content={details} />
        </details>
      )}
    </div>
  );
}

function renderError(event: AgentEvent, language: UiLanguage) {
  const message = payloadText(event.payload);
  return (
    <div key={event.id} className="agent-error-card">
      <div className="agent-message__meta">{t(language, 'agent.error.title')}</div>
      <div className="agent-message__body agent-message__body--plain">{message}</div>
      {isRecord(event.payload) && (
        <details className="agent-raw-details">
          <summary>{t(language, 'agent.error.raw')}</summary>
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function renderTraceEvent(event: AgentEvent, language: UiLanguage) {
  if (event.kind === 'workflow_stage' || event.kind === 'workflow_decision') return renderWorkflowStage(event, language);
  if (event.kind === 'assistant_msg') {
    const stage = eventStage(event) ?? 'thought';
    return (
      <div key={event.id} className="agent-trace-output">
        <div className="agent-message__meta">
          {t(language, 'agent.trace.output', { stage: localizedStage(stage, language) })}
        </div>
        <MarkdownContent content={payloadText(event.payload)} />
      </div>
    );
  }
  if (event.kind === 'error') return renderError(event, language);
  return <ToolCallBubble key={event.id} event={event} language={language} />;
}

function TraceGroupCard({ group, language }: { group: TraceGroup; language: UiLanguage }) {
  const [expanded, setExpanded] = React.useState(Boolean(group.running));
  const wasRunningRef = React.useRef(Boolean(group.running));

  React.useEffect(() => {
    if (group.running) {
      setExpanded(true);
      wasRunningRef.current = true;
      return;
    }
    if (wasRunningRef.current) {
      setExpanded(false);
      wasRunningRef.current = false;
    }
  }, [group.running]);

  return (
    <div className={`agent-thinking-trace ${group.running ? 'agent-thinking-trace--running' : ''}`}>
      <button
        type="button"
        className="agent-thinking-trace__summary"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="agent-thinking-trace__left">
          <span className="agent-thinking-trace__dot" />
          <span className="agent-thinking-trace__title">{thoughtTraceTitle(group.events, language, group.running)}</span>
        </span>
        <span className="agent-thinking-trace__hint">
          {expanded ? t(language, 'agent.ui.hide') : t(language, 'agent.ui.show')}
        </span>
      </button>
      {expanded && (
        <div className="agent-thinking-trace__body">
          {group.events.map((event) => renderTraceEvent(event, language))}
        </div>
      )}
    </div>
  );
}

function renderToolBatch(group: ToolBatchGroup, language: UiLanguage) {
  const hasError = group.events.some((event) => eventStatus(event) === 'error');
  const allDone = group.events.some((event) => event.kind === 'tool_result' || event.kind === 'permission_result');
  const status = hasError ? 'error' : allDone ? 'done' : 'running';
  const open = group.autoOpen || group.events.some((event) => eventDefaultOpen(event) === true && status !== 'done');
  return (
    <details key={group.id} className="agent-tool-batch" open={open}>
      <summary>
        <span className="agent-tool-batch__label">{group.label}</span>
        <span className={`agent-tool-batch__status agent-tool-batch__status--${status}`}>
          {localizedStatus(status, language)}
        </span>
      </summary>
      <div className="agent-tool-batch__body">
        {group.events.map((event, index) => (
          <ToolCallBubble
            key={`${event.id}-${index}`}
            event={event}
            language={language}
            autoOpen={eventDefaultOpen(event) ?? group.autoOpen}
          />
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

async function copyMessage(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (err) {
    console.warn('Clipboard API write failed, falling back to legacy copy.', err);
  }

  try {
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
  } catch (err) {
    console.warn('Fallback copy failed.', err);
  }
}

function TurnActions({
  events,
  targetEvent,
  language,
}: {
  events: AgentEvent[];
  targetEvent: AgentEvent;
  language: UiLanguage;
}) {
  const text = workflowCopyText(events, language);
  return (
    <div className="agent-turn-actions" aria-label={t(language, 'agent.message.actions')}>
      <button type="button" title={t(language, 'agent.message.copyWorkflowTitle')} onClick={() => { void copyMessage(text); }}>
        {t(language, 'agent.message.copyWorkflow')}
      </button>
      <button type="button" title={t(language, 'agent.message.feedbackUpTitle')} onClick={() => feedback(targetEvent, 'up')}>
        {t(language, 'agent.message.feedbackUp')}
      </button>
      <button type="button" title={t(language, 'agent.message.feedbackDownTitle')} onClick={() => feedback(targetEvent, 'down')}>
        {t(language, 'agent.message.feedbackDown')}
      </button>
    </div>
  );
}

function renderMessage(event: AgentEvent, language: UiLanguage, autoOpen = false) {
  if (event.kind === 'workflow_stage' || event.kind === 'workflow_decision') return renderWorkflowStage(event, language);
  if (event.kind === 'error') return renderError(event, language);
  if (
    event.kind === 'tool_call' ||
    event.kind === 'tool_result' ||
    event.kind === 'permission_request' ||
    event.kind === 'permission_result'
  ) {
    return <ToolCallBubble key={event.id} event={event} language={language} autoOpen={autoOpen} />;
  }

  const label = stringField(event.payload, 'label');
  const speaker = event.kind === 'user_msg' ? t(language, 'agent.message.user') : (label ?? 'Agent');
  const pending = isRecord(event.payload) && event.payload.pending === true;
  const text = payloadText(event.payload);
  const renderMarkdown = event.kind === 'assistant_msg' || event.kind === 'user_msg';
  const shouldCollapse = shouldCollapseAssistantMessage(event, text);

  if (shouldCollapse) {
    return (
      <details key={event.id} className="agent-message agent-message--assistant_msg agent-message--collapsible">
        <summary className="agent-message-preview">
          <span className="agent-message-preview__top">
            <span className="agent-message-preview__meta">{speaker}</span>
            <span className="agent-message-preview__toggle">
              <span className="agent-message-preview__toggle-open">
                {t(language, 'agent.message.expand')}
              </span>
              <span className="agent-message-preview__toggle-close">
                {t(language, 'agent.message.collapse')}
              </span>
            </span>
          </span>
          <span className="agent-message-preview__summary">
            {compactDisplayText(text, ASSISTANT_PREVIEW_TEXT_LIMIT)}
          </span>
        </summary>
        <div className="agent-message__body agent-message__body--markdown agent-message__body--expanded">
          <MarkdownContent content={text} />
        </div>
      </details>
    );
  }

  return (
    <div key={event.id} className={`agent-message agent-message--${event.kind}`}>
      <div className="agent-message__meta">
        {speaker}
        {pending && (
          <span className="agent-message__stage">
            {t(language, 'agent.message.sending')}
          </span>
        )}
      </div>
      <div className={`agent-message__body ${renderMarkdown ? 'agent-message__body--markdown' : 'agent-message__body--plain'}`}>
        {renderMarkdown ? <MarkdownContent content={text} /> : text}
      </div>
    </div>
  );
}

const MessageList: React.FC<MessageListProps> = ({ events, loading = false, language }) => (
  <div className="agent-message-list">
    {events.length === 0 && !loading && (
      <div className="agent-empty-state">
        <div className="agent-empty-state__title">
          {t(language, 'agent.message.readyTitle')}
        </div>
        <div className="agent-empty-state__subtle">
          {t(language, 'agent.message.readyBody')}
        </div>
      </div>
    )}

    {createRenderItems(events, loading).map((item) => {
      if (item.type === 'trace') return <TraceGroupCard key={item.group.id} group={item.group} language={language} />;
      if (item.type === 'toolBatch') return renderToolBatch(item.group, language);
      if (item.type === 'turnActions') {
        return (
          <TurnActions
            key={item.id}
            events={item.events}
            targetEvent={item.targetEvent}
            language={language}
          />
        );
      }
      return renderMessage(item.event, language, item.autoOpen);
    })}

    {loading && (
      <div className="agent-thinking">
        <span className="agent-spinner" />
        <span>{t(language, 'agent.message.thinking')}</span>
      </div>
    )}
  </div>
);

export default MessageList;
