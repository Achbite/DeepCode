import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentTimelineResult } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import MarkdownContent from './LazyMarkdownContent';
import { sanitizeDisplayText } from './displayText';
import { latestPlanTaskItemsFromProjection } from '../../utils/uiTimelineProjection';

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

function asCommand(markdown: string, id?: string): TaskCommandView {
  return {
    id: id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    markdown: sanitizeDisplayText(markdown),
  };
}

function defaultTasks(loading: boolean, language: UiLanguage): AgentTaskView[] {
  return [
    {
      id: 'task-waiting',
      title: loading
        ? t(language, 'agent.task.preparing')
        : t(language, 'agent.task.waiting'),
      status: loading ? 'running' : 'waiting',
      commands: [],
      hasToolActivity: false,
      hasMeaningfulOutput: false,
    },
  ];
}

function compactTasks(tasks: AgentTaskView[]): AgentTaskView[] {
  return tasks;
}

function normalizeProjectionTaskStatus(status: string): AgentTaskView['status'] {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'waiting' || status === 'queued') return 'waiting';
  return 'planned';
}

function deriveTasks(projection: AgentTimelineResult, loading: boolean, language: UiLanguage): AgentTaskState {
  const projectedItems = latestPlanTaskItemsFromProjection(projection);
  if (projectedItems.length === 0) {
    const waiting = defaultTasks(loading, language);
    return {
      tasks: waiting,
      focusTaskId: waiting[0]?.id,
    };
  }

  const compacted = compactTasks(projectedItems.map((item) => ({
    id: item.id,
    title: item.title,
    status: normalizeProjectionTaskStatus(item.status),
    commands: item.summary ? [asCommand(item.summary, `${item.id}:summary`)] : [],
    hasToolActivity: false,
    hasMeaningfulOutput: Boolean(item.summary),
  })));
  const nextFocus =
    compacted.find((task) => task.status === 'running')?.id ??
    compacted.find((task) => task.status === 'waiting')?.id ??
    compacted[0]?.id;

  return {
    tasks: compacted,
    focusTaskId: nextFocus,
  };
}

function isDefaultWaitingState(state: AgentTaskState): boolean {
  return state.tasks.length === 1 && state.tasks[0]?.id === 'task-waiting';
}

function isUsableTaskState(state: AgentTaskState): boolean {
  return state.tasks.some((task) =>
    task.id !== 'task-waiting' &&
    (task.hasMeaningfulOutput || task.hasToolActivity || task.status === 'running' || task.status === 'completed' || task.status === 'error')
  );
}

interface AgentTaskListProps {
  projection: AgentTimelineResult;
  loading: boolean;
  language: UiLanguage;
}

const AgentTaskList: React.FC<AgentTaskListProps> = ({ projection, loading, language }) => {
  const projectedTaskState = useMemo(
    () => deriveTasks(projection, loading, language),
    [language, loading, projection]
  );
  const lastUsableTaskStateRef = useRef<AgentTaskState | null>(null);
  if (isUsableTaskState(projectedTaskState)) {
    lastUsableTaskStateRef.current = projectedTaskState;
  }
  const taskState = isDefaultWaitingState(projectedTaskState) && lastUsableTaskStateRef.current
    ? lastUsableTaskStateRef.current
    : projectedTaskState;
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
        <span>{t(language, 'agent.task.header')}</span>
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
                <span className="agent-task-item__chevron">
                  {expanded ? t(language, 'agent.ui.hide') : t(language, 'agent.ui.show')}
                </span>
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
                      <MarkdownContent content={t(language, 'agent.task.waitingStageEvents')} />
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
