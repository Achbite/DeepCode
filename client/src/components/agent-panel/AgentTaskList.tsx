import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentTraceEvent } from '@deepcode/protocol';
import MarkdownContent from './MarkdownContent';
import { compactDisplayText, sanitizeDisplayText } from './displayText';

interface AgentTaskView {
  id: string;
  title: string;
  status: 'waiting' | 'planned' | 'running' | 'completed' | 'error';
  commands: TaskCommandView[];
  hasToolActivity: boolean;
  hasMeaningfulOutput: boolean;
}

interface TaskCommandView {
  id: string;
  markdown: string;
}

interface AgentTaskState {
  tasks: AgentTaskView[];
  focusTaskId?: string;
}

const STAGE_LABELS: Record<string, string> = {
  plan: 'Plan',
  check: 'Check',
  complete: 'Complete',
  review: 'Review',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? sanitizeDisplayText(value) : undefined;
}

function numberField(payload: unknown, key: string): number | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

function asCommand(markdown: string, id?: string): TaskCommandView {
  return {
    id: id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    markdown: sanitizeDisplayText(markdown),
  };
}

function toolName(payload: unknown): string {
  if (!isRecord(payload)) return 'tool';
  const toolCall = isRecord(payload.toolCall) ? payload.toolCall : undefined;
  return (
    stringField(payload, 'toolName') ??
    stringField(payload, 'name') ??
    stringField(toolCall, 'name') ??
    'tool'
  );
}

function normalizeActionType(action: Record<string, unknown>): string {
  const raw =
    (typeof action.type === 'string' && action.type) ||
    (typeof action.action === 'string' && action.action) ||
    (typeof action.name === 'string' && action.name) ||
    'unknown';
  return sanitizeDisplayText(raw).trim();
}

function actionText(action: Record<string, unknown>): string {
  const type = normalizeActionType(action);
  const path = typeof action.path === 'string' ? sanitizeDisplayText(action.path) : undefined;
  const query = typeof action.query === 'string' ? sanitizeDisplayText(action.query) : undefined;
  const command = typeof action.command === 'string' ? sanitizeDisplayText(action.command) : undefined;
  const result = [
    typeof action.result === 'string' ? sanitizeDisplayText(action.result) : undefined,
    typeof action.content === 'string' ? sanitizeDisplayText(action.content) : undefined,
    typeof action.message === 'string' ? sanitizeDisplayText(action.message) : undefined,
  ].find((value): value is string => Boolean(value && value.trim()));

  if (type === 'final') return result ? result.trim() : '\u6700\u7ec8\u56de\u590d\u5df2\u51c6\u5907\u3002';
  if (type === 'fs.read') return `\u8bfb\u53d6\u6587\u4ef6 \`${path ?? '(missing path)'}\`\u3002`;
  if (type === 'fs.list') return `\u5217\u51fa\u76ee\u5f55 \`${path ?? '.'}\`\u3002`;
  if (type === 'code.search') return `\u641c\u7d22\u4ee3\u7801 \`${query ?? '(missing query)'}\`\u3002`;
  if (type === 'fs.diff') return `\u51c6\u5907\u6587\u4ef6\u5dee\u5f02 \`${path ?? '(missing path)'}\`\u3002`;
  if (type === 'fs.write') return `\u5199\u5165\u6587\u4ef6 \`${path ?? '(missing path)'}\`\u3002`;
  if (type === 'patch.plan') {
    const startLine = numberField(action, 'startLine');
    const endLine = numberField(action, 'endLine');
    const range = startLine && endLine ? ` \u7b2c ${startLine}-${endLine} \u884c` : '';
    return `\u89c4\u5212\u8865\u4e01 \`${path ?? '(missing path)'}\`${range}\u3002`;
  }
  if (type === 'shell.propose') return `\u5efa\u8bae\u547d\u4ee4\uff1a\`${command ?? '(missing command)'}\`\u3002`;
  if (type === 'shell.exec') return `\u6267\u884c\u547d\u4ee4\uff1a\`${command ?? '(missing command)'}\`\u3002`;
  return result ? result.trim() : `\u89e3\u6790\u5230\u52a8\u4f5c \`${type}\`\u3002`;
}
function parseActionObject(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.actions)) return value.actions.filter(isRecord);
  if (typeof value.action === 'string' || typeof value.type === 'string' || typeof value.name === 'string') {
    return [value];
  }
  return [];
}

function parseDeepcodeActionBlocks(content: string): {
  text: string;
  actions: Record<string, unknown>[];
} {
  const actions: Record<string, unknown>[] = [];
  let text = sanitizeDisplayText(content).replace(/```deepcode-action\s*([\s\S]*?)```/g, (_block, rawJson: string) => {
    try {
      actions.push(...parseActionObject(JSON.parse(rawJson.trim())));
    } catch {
      actions.push({ type: 'unknown', result: 'Agent returned an invalid deepcode-action block.' });
    }
    return '';
  }).trim();

  const unclosedBlockIndex = text.indexOf('```deepcode-action');
  if (unclosedBlockIndex >= 0) {
    const rawJson = text.slice(unclosedBlockIndex + '```deepcode-action'.length).trim();
    try {
      actions.push(...parseActionObject(JSON.parse(rawJson)));
    } catch {
      actions.push({ type: 'unknown', result: 'Agent prepared a structured action.' });
    }
    text = text.slice(0, unclosedBlockIndex).trim();
  }

  return { text, actions };
}

function humanizeAgentOutput(content: string): string {
  const parsed = parseDeepcodeActionBlocks(content);
  const actionLines = parsed.actions.map(actionText).filter((line) => line.trim().length > 0);

  if (parsed.text && actionLines.length > 0) {
    return `${parsed.text}\n\n${actionLines.map((line) => `- ${line}`).join('\n')}`;
  }
  if (actionLines.length > 0) return actionLines.join('\n\n');
  return parsed.text || compactDisplayText(content, 400);
}

function pushCommand(task: AgentTaskView, markdown: string, id?: string): void {
  const normalized = sanitizeDisplayText(markdown).trim();
  if (!normalized) return;
  task.commands.push(asCommand(normalized, id));
  task.hasMeaningfulOutput = true;
}

function latestTurnEvents(events: AgentEvent[]): AgentEvent[] {
  const lastUserIndex = events.reduce(
    (last, event, index) => (event.kind === 'user_msg' ? index : last),
    -1
  );
  return lastUserIndex >= 0 ? events.slice(lastUserIndex + 1) : events;
}

function tracePayload(trace: AgentTraceEvent): Record<string, unknown> {
  return isRecord(trace.payload) ? trace.payload : {};
}

function traceEvent(
  trace: AgentTraceEvent,
  kind: AgentEvent['kind'],
  payload: Record<string, unknown>
): AgentEvent {
  return {
    id: trace.eventId ?? trace.id,
    sessionId: trace.sessionId,
    ts: trace.timestamp ?? trace.ts,
    kind,
    payload,
  };
}

function traceEventsToAgentEvents(traceEvents: AgentTraceEvent[]): AgentEvent[] {
  return traceEvents.flatMap((trace) => {
    const payload = tracePayload(trace);
    const phase = trace.phase ?? stringField(payload, 'stage') ?? stringField(payload, 'phase');
    const profileId = stringField(payload, 'profileId');
    const summary = trace.summary ?? stringField(payload, 'summary') ?? stringField(payload, 'details');

    switch (trace.kind) {
      case 'turn.started':
        return [traceEvent(trace, 'user_msg', { ...payload, content: summary ?? stringField(payload, 'content') ?? '' })];
      case 'stage.started':
        return [traceEvent(trace, 'workflow_stage', { ...payload, stage: phase, status: 'started', profileId, summary })];
      case 'stage.completed':
        return [traceEvent(trace, 'workflow_stage', { ...payload, stage: phase, status: 'completed', profileId, summary })];
      case 'stage.failed':
        return [traceEvent(trace, 'workflow_stage', { ...payload, stage: phase, status: 'error', profileId, summary })];
      case 'tool.requested':
        return [traceEvent(trace, 'tool_call', payload)];
      case 'tool.completed':
      case 'tool.failed':
        return [traceEvent(trace, 'tool_result', payload)];
      case 'permission.requested':
        return [traceEvent(trace, 'permission_request', payload)];
      case 'permission.resolved':
        return [traceEvent(trace, 'permission_result', payload)];
      case 'error':
        return [traceEvent(trace, 'error', { ...payload, message: summary ?? stringField(payload, 'message') ?? 'Trace error' })];
      default:
        return [];
    }
  });
}

function defaultTasks(loading: boolean): AgentTaskView[] {
  return [
    {
      id: 'task-waiting',
      title: loading ? '\u0041gent \u6b63\u5728\u51c6\u5907\u4efb\u52a1' : '\u7b49\u5f85 Agent \u4efb\u52a1',
      status: loading ? 'running' : 'waiting',
      commands: [],
      hasToolActivity: false,
      hasMeaningfulOutput: false,
    },
  ];
}


function ensureTask(tasks: Map<string, AgentTaskView>, stage: string): AgentTaskView {
  const id = `stage-${stage}`;
  const current = tasks.get(id);
  if (current) return current;
  const next: AgentTaskView = {
    id,
    title: `${STAGE_LABELS[stage] ?? stage} stage`,
    status: 'planned',
    commands: [],
    hasToolActivity: false,
    hasMeaningfulOutput: false,
  };
  tasks.set(id, next);
  return next;
}

function hasToolActivity(events: AgentEvent[]): boolean {
  return events.some((event) =>
    event.kind === 'tool_call' ||
    event.kind === 'tool_result' ||
    event.kind === 'permission_request' ||
    event.kind === 'permission_result'
  );
}

function shouldShowWorkflowSummary(stage: string, status: string, toolActivity: boolean): boolean {
  if (status === 'started' || status === 'error') return true;
  if (!toolActivity) return stage === 'complete' || stage === 'review';
  return stage === 'complete';
}

function compactTasks(tasks: AgentTaskView[]): AgentTaskView[] {
  return tasks;
}

function deriveTasks(events: AgentEvent[], loading: boolean): AgentTaskState {
  const turnEvents = latestTurnEvents(events);
  const toolActivity = hasToolActivity(turnEvents);
  const tasks = new Map<string, AgentTaskView>();
  let focusTaskId: string | undefined;

  for (const event of turnEvents) {
    if (event.kind === 'workflow_stage') {
      const stage = stringField(event.payload, 'stage') ?? 'workflow';
      const status = stringField(event.payload, 'status') ?? 'updated';
      const task = ensureTask(tasks, stage);
      focusTaskId = task.id;
      if (status === 'started') task.status = 'running';
      if (status === 'completed') task.status = 'completed';
      if (status === 'error') task.status = 'error';

      const summary = stringField(event.payload, 'summary');
      const details = stringField(event.payload, 'details');
      const profileId = stringField(event.payload, 'profileId');
      if (shouldShowWorkflowSummary(stage, status, toolActivity)) {
        const detailText = details ?? summary;
        pushCommand(
          task,
          `**${status}**${profileId ? ` · \`${profileId}\`` : ''}${
            detailText ? `\n\n${humanizeAgentOutput(detailText)}` : ''
          }`,
          event.id
        );
      }
      continue;
    }

    if (event.kind === 'assistant_msg') {
      const stage = stringField(event.payload, 'stage');
      if (!stage) continue;
      if (toolActivity && stage !== 'complete') continue;
      const task = ensureTask(tasks, stage);
      focusTaskId = task.id;
      pushCommand(
        task,
        humanizeAgentOutput(stringField(event.payload, 'content') ?? 'Assistant stage output'),
        event.id
      );
      continue;
    }

    if (event.kind === 'tool_call') {
      const task = ensureTask(tasks, 'complete');
      focusTaskId = task.id;
      task.hasToolActivity = true;
      task.status = task.status === 'planned' ? 'running' : task.status;
      pushCommand(task, `调用工具：\`${toolName(event.payload)}\``, event.id);
      continue;
    }

    if (event.kind === 'tool_result') {
      const task = ensureTask(tasks, 'complete');
      focusTaskId = task.id;
      task.hasToolActivity = true;
      const ok = isRecord(event.payload) && event.payload.ok === true;
      const error = stringField(event.payload, 'error');
      pushCommand(
        task,
        `工具结果：\`${toolName(event.payload)}\` · **${ok ? 'ok' : 'needs attention'}**${
          error ? `\n\n${error}` : ''
        }`,
        event.id
      );
      continue;
    }

    if (event.kind === 'permission_request') {
      const task = ensureTask(tasks, 'complete');
      focusTaskId = task.id;
      task.hasToolActivity = true;
      task.status = 'running';
      pushCommand(task, `需要确认：\`${toolName(event.payload)}\``, event.id);
      continue;
    }

    if (event.kind === 'permission_result') {
      const task = ensureTask(tasks, 'complete');
      focusTaskId = task.id;
      task.hasToolActivity = true;
      pushCommand(task, `确认结果：\`${toolName(event.payload)}\``, event.id);
      continue;
    }

    if (event.kind === 'error') {
      const stage = stringField(event.payload, 'stage') ?? 'complete';
      const task = ensureTask(tasks, stage);
      focusTaskId = task.id;
      task.status = 'error';
      pushCommand(task, stringField(event.payload, 'message') ?? 'Stage error', event.id);
    }
  }

  const result = Array.from(tasks.values());
  if (result.length === 0) {
    const waiting = defaultTasks(loading);
    return {
      tasks: waiting,
      focusTaskId: waiting[0]?.id,
    };
  }

  const compacted = compactTasks(result);
  const nextFocus =
    compacted.find((task) => task.id === focusTaskId)?.id ??
    compacted.find((task) => task.status === 'running')?.id ??
    compacted[0]?.id;

  return {
    tasks: compacted,
    focusTaskId: nextFocus,
  };
}

interface AgentTaskListProps {
  events: AgentEvent[];
  traceEvents?: AgentTraceEvent[];
  loading: boolean;
}

const AgentTaskList: React.FC<AgentTaskListProps> = ({ events, traceEvents = [], loading }) => {
  const taskEvents = useMemo(
    () => (traceEvents.length > 0 ? traceEventsToAgentEvents(traceEvents) : events),
    [events, traceEvents]
  );
  const taskState = useMemo(() => deriveTasks(taskEvents, loading), [taskEvents, loading]);
  const tasks = taskState.tasks;
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const lastAutoFocusIdRef = useRef<string | null>(null);

  useEffect(() => {
    const nextFocusId = taskState.focusTaskId ?? null;
    if (nextFocusId && nextFocusId !== lastAutoFocusIdRef.current) {
      lastAutoFocusIdRef.current = nextFocusId;
      setExpandedTaskId(nextFocusId);
    }
  }, [taskState.focusTaskId]);

  return (
    <div className="agent-task-list">
      <div className="agent-task-list__header">
        <span>Agent Task</span>
      </div>
      <div className="agent-task-list__body">
        {tasks.map((task) => {
          const expanded = expandedTaskId === task.id;
          return (
            <div
              key={task.id}
              className={`agent-task-item agent-task-item--${task.status} ${
                expanded ? 'agent-task-item--expanded' : ''
              }`}
            >
              <button
                className="agent-task-item__summary"
                onClick={() => setExpandedTaskId(expanded ? null : task.id)}
                type="button"
              >
                <span className="agent-task-item__dot" />
                <span className="agent-task-item__title">{task.title}</span>
                <span className="agent-task-item__chevron">{expanded ? 'Hide' : 'Show'}</span>
              </button>
              {expanded && (
                <div className="agent-task-item__commands">
                  {task.commands.length > 0 ? (
                    task.commands.map((command, index) => (
                      <div key={`${task.id}:${index}`} className="agent-task-command">
                        <MarkdownContent content={command.markdown} />
                      </div>
                    ))
                  ) : (
                    <div className="agent-task-command">
                      <MarkdownContent content="等待阶段事件。" />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AgentTaskList;
