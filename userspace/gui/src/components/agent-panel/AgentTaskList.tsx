import React, { useMemo } from 'react';
import type { AgentTimelineResult } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { latestAcceptedPlanTaskItemsFromProjection } from '../../utils/uiTimelineProjection';

interface AgentTaskView {
  id: string;
  title: string;
  progress: 'queued' | 'thinking' | 'completed';
}

interface AgentTaskState {
  tasks: AgentTaskView[];
  focusTaskId?: string;
}

function defaultTasks(loading: boolean, language: UiLanguage): AgentTaskView[] {
  return [
    {
      id: 'task-waiting',
      title: loading
        ? t(language, 'agent.task.preparing')
        : t(language, 'agent.task.waiting'),
      progress: loading ? 'thinking' : 'queued',
    },
  ];
}

function compactTasks(tasks: AgentTaskView[]): AgentTaskView[] {
  return tasks;
}

function deriveTasks(projection: AgentTimelineResult, loading: boolean, language: UiLanguage): AgentTaskState {
  const projectedItems = latestAcceptedPlanTaskItemsFromProjection(projection);
  if (projectedItems.length === 0) {
    const waiting = defaultTasks(loading, language);
    return {
      tasks: waiting,
      focusTaskId: waiting[0]?.id,
    };
  }

  const compacted = compactTasks(projectedItems.map((item) => ({
    id: item.id,
    title: t(language, item.titleKey, item.titleArgs),
    progress: item.progress,
  })));
  const nextFocus =
    compacted.find((task) => task.progress === 'thinking')?.id ??
    compacted.find((task) => task.progress === 'queued')?.id ??
    compacted[0]?.id;

  return {
    tasks: compacted,
    focusTaskId: nextFocus,
  };
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
  const tasks = projectedTaskState.tasks;

  return (
    <div className="agent-task-list">
      <div className="agent-task-list__header">
        <span>{t(language, 'agent.task.header')}</span>
      </div>
      <div className="agent-task-list__body">
        {tasks.map((task) => {
          return (
            <div
              key={task.id}
              className={`agent-task-item agent-task-item--${task.progress}`}
            >
              <div className="agent-task-item__summary">
                <span className="agent-task-item__dot" />
                <span className="agent-task-item__title">{task.title}</span>
                <span className="agent-task-item__progress">
                  {t(language, `deepcodeGui.tasks.progress.${task.progress}`)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AgentTaskList;
