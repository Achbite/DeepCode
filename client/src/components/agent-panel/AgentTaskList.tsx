import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '@deepcode/protocol';
import MarkdownContent from './MarkdownContent';

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
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function toolName(payload: unknown): string {
  return (
    stringField(payload, 'toolName') ??
    stringField(payload, 'name') ??
    stringField(payload, 'callId') ??
    'tool'
  );
}

function numberField(payload: unknown, key: string): number | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

function compact(value: string, limit = 140): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}...` : singleLine;
}

function asCommand(markdown: string, id?: string): TaskCommandView {
  return {
    id: id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    markdown,
  };
}

function normalizeActionType(action: Record<string, unknown>): string {
  const raw =
    (typeof action.type === 'string' && action.type) ||
    (typeof action.action === 'string' && action.action) ||
    (typeof action.name === 'string' && action.name) ||
    'unknown';
  return raw.trim();
}

function actionText(action: Record<string, unknown>): string {
  const type = normalizeActionType(action);
  const path = typeof action.path === 'string' ? action.path : undefined;
  const query = typeof action.query === 'string' ? action.query : undefined;
  const command = typeof action.command === 'string' ? action.command : undefined;
  const result =
    (typeof action.result === 'string' && action.result) ||
    (typeof action.content === 'string' && action.content) ||
    (typeof action.message === 'string' && action.message);

  if (type === 'final') {
    return result ? result.trim() : 'Final response prepared.';
  }
  if (type === 'fs.read') return `Read file \`${path ?? '(missing path)'}\`.`;
  if (type === 'fs.list') return `List directory \`${path ?? '.'}\`.`;
  if (type === 'code.search') return `Search code for \`${query ?? '(missing query)'}\`.`;
  if (type === 'fs.diff') return `Prepare diff for \`${path ?? '(missing path)'}\`.`;
  if (type === 'fs.write') return `Write file \`${path ?? '(missing path)'}\`.`;
  if (type === 'patch.plan') {
    const startLine = numberField(action, 'startLine');
    const endLine = numberField(action, 'endLine');
    const range = startLine && endLine ? ` lines ${startLine}-${endLine}` : '';
    return `Plan patch for \`${path ?? '(missing path)'}\`${range}.`;
  }
  if (type === 'shell.propose') return `Propose shell command: \`${command ?? '(missing command)'}\`.`;
  if (type === 'shell.exec') return `Execute shell command after approval: \`${command ?? '(missing command)'}\`.`;
  return result ? result.trim() : `Parsed action \`${type}\`.`;
}

function parseActionObject(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.actions)) {
    return value.actions.filter(isRecord);
  }
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
  let text = content.replace(/```deepcode-action\s*([\s\S]*?)```/g, (_block, rawJson: string) => {
    try {
      actions.push(...parseActionObject(JSON.parse(rawJson.trim())));
    } catch {
      actions.push({
        type: 'unknown',
        result: 'Agent returned an invalid deepcode-action block.',
      });
    }
    return '';
  }).trim();

  const unclosedBlockIndex = text.indexOf('```deepcode-action');
  if (unclosedBlockIndex >= 0) {
    const rawJson = text.slice(unclosedBlockIndex + '```deepcode-action'.length).trim();
    try {
      actions.push(...parseActionObject(JSON.parse(rawJson)));
    } catch {
      actions.push({
        type: 'unknown',
        result: 'Agent prepared a structured action.',
      });
    }
    text = text.slice(0, unclosedBlockIndex).trim();
  }

  return { text, actions };
}

function humanizeAgentOutput(content: string): string {
  const parsed = parseDeepcodeActionBlocks(content);
  const actionLines = parsed.actions
    .map(actionText)
    .filter((line) => line.trim().length > 0);

  if (parsed.text && actionLines.length > 0) {
    return `${parsed.text}\n\n${actionLines.map((line) => `- ${line}`).join('\n')}`;
  }
  if (actionLines.length > 0) {
    return actionLines.join('\n\n');
  }
  return parsed.text || compact(content, 400);
}

function pushCommand(task: AgentTaskView, markdown: string, id?: string): void {
  const normalized = markdown.trim();
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

function defaultTasks(): AgentTaskView[] {
  return [
    {
      id: 'task-waiting',
      title: '等待 Agent 生成任务规划',
      status: 'waiting',
      commands: [
        asCommand('任务开始后，这里显示 plan / check / complete / review 阶段。'),
        asCommand('文件读取、代码搜索、patch、shell 等动作会进入对应阶段。'),
      ],
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
      const profileId = stringField(event.payload, 'profileId');
      pushCommand(
        task,
        `**${status}**${profileId ? ` · \`${profileId}\`` : ''}${
          summary ? `\n\n${humanizeAgentOutput(summary)}` : ''
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
      pushCommand(task, `Tool call: \`${toolName(event.payload)}\``, event.id);
      continue;
    }

    if (event.kind === 'tool_result') {
      const task = ensureTask(tasks, 'complete');
      focusTaskId = task.id;
      const ok = isRecord(event.payload) && event.payload.ok === true;
      const error = stringField(event.payload, 'error');
      pushCommand(
        task,
        `Tool result: \`${toolName(event.payload)}\` · **${ok ? 'ok' : 'needs attention'}**${
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
      pushCommand(task, `Permission required: \`${toolName(event.payload)}\``, event.id);
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
    const waiting = defaultTasks();
    if (loading) {
      waiting[0].status = 'running';
      waiting[0].commands.unshift(asCommand('Agent 正在准备任务阶段...'));
    }
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
                    <div className="agent-task-command">等待阶段事件...</div>
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
