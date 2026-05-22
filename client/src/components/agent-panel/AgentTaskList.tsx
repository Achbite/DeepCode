import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '@deepcode/protocol';
import MarkdownContent from './MarkdownContent';
import { compactDisplayText, sanitizeDisplayText } from './displayText';

interface AgentTaskView {
  id: string;
  title: string;
  status: 'waiting' | 'planned' | 'running' | 'completed' | 'error';
  commands: TaskCommandView[];
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
  const result =
    (typeof action.result === 'string' && sanitizeDisplayText(action.result)) ||
    (typeof action.content === 'string' && sanitizeDisplayText(action.content)) ||
    (typeof action.message === 'string' && sanitizeDisplayText(action.message));

  if (type === 'final') return result ? result.trim() : 'Final response prepared.';
  if (type === 'fs.read') return `读取文件 \`${path ?? '(missing path)'}\`。`;
  if (type === 'fs.list') return `列出目录 \`${path ?? '.'}\`。`;
  if (type === 'code.search') return `搜索代码 \`${query ?? '(missing query)'}\`。`;
  if (type === 'fs.diff') return `准备文件差异 \`${path ?? '(missing path)'}\`。`;
  if (type === 'fs.write') return `写入文件 \`${path ?? '(missing path)'}\`。`;
  if (type === 'patch.plan') {
    const startLine = numberField(action, 'startLine');
    const endLine = numberField(action, 'endLine');
    const range = startLine && endLine ? ` 第 ${startLine}-${endLine} 行` : '';
    return `规划补丁 \`${path ?? '(missing path)'}\`${range}。`;
  }
  if (type === 'shell.propose') return `建议命令：\`${command ?? '(missing command)'}\`。`;
  if (type === 'shell.exec') return `审批后执行命令：\`${command ?? '(missing command)'}\`。`;
  return result ? result.trim() : `解析到动作 \`${type}\`。`;
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
}

function latestTurnEvents(events: AgentEvent[]): AgentEvent[] {
  const lastUserIndex = events.reduce(
    (last, event, index) => (event.kind === 'user_msg' ? index : last),
    -1
  );
  return lastUserIndex >= 0 ? events.slice(lastUserIndex + 1) : events;
}

function defaultTasks(loading: boolean): AgentTaskView[] {
  return [
    {
      id: 'task-waiting',
      title: loading ? 'Agent 正在准备任务' : '等待 Agent 任务',
      status: loading ? 'running' : 'waiting',
      commands: [],
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
  };
  tasks.set(id, next);
  return next;
}

function deriveTasks(events: AgentEvent[], loading: boolean): AgentTaskState {
  const turnEvents = latestTurnEvents(events);
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
      pushCommand(
        task,
        `**${status}**${profileId ? ` · \`${profileId}\`` : ''}${
          details ?? summary ? `\n\n${humanizeAgentOutput(details ?? summary ?? '')}` : ''
        }`,
        event.id
      );
      continue;
    }

    if (event.kind === 'assistant_msg') {
      const stage = stringField(event.payload, 'stage');
      if (!stage) continue;
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
      task.status = task.status === 'planned' ? 'running' : task.status;
      pushCommand(task, `调用工具：\`${toolName(event.payload)}\``, event.id);
      continue;
    }

    if (event.kind === 'tool_result') {
      const task = ensureTask(tasks, 'complete');
      focusTaskId = task.id;
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
      task.status = 'running';
      pushCommand(task, `需要确认：\`${toolName(event.payload)}\``, event.id);
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
  return {
    tasks: result,
    focusTaskId: focusTaskId ?? result.find((task) => task.status === 'running')?.id ?? result[0]?.id,
  };
}

interface AgentTaskListProps {
  events: AgentEvent[];
  loading: boolean;
}

const AgentTaskList: React.FC<AgentTaskListProps> = ({ events, loading }) => {
  const taskState = useMemo(() => deriveTasks(events, loading), [events, loading]);
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
