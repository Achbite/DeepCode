import React from 'react';
import type { SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface DeepCodeTaskPanelProps {
  language: UiLanguage;
  projection: SessionProjection | null;
}

const DeepCodeTaskPanel: React.FC<DeepCodeTaskPanelProps> = ({ language, projection }) => {
  const artifacts = projection?.artifacts ?? [];
  const todos = projection?.todoList?.items ?? [];
  return (
    <aside className="deepcode-gui-context-panel">
      <section className="deepcode-gui-task-list-card">
        <div className="deepcode-gui-task-list-card__title">
          {t(language, 'deepcodeGui.tasks.title')}
        </div>
        {todos.length === 0 ? (
          <div className="deepcode-gui-task-list-card__empty">
            {t(language, 'deepcodeGui.tasks.empty')}
          </div>
        ) : (
          <div className="deepcode-gui-task-list">
            {todos.map((todo) => (
              <div
                className={`deepcode-gui-task-item deepcode-gui-task-item--${todo.status === 'inProgress' ? 'active' : todo.status}`}
                key={todo.todoId}
              >
                <span className="deepcode-gui-task-item__dot" aria-hidden="true" />
                <div>
                  <div className="deepcode-gui-task-item__title">{todo.label}</div>
                </div>
                <strong>{todoStatus(todo.status, language)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="deepcode-gui-task-list-card deepcode-gui-output-card">
        <div className="deepcode-gui-task-list-card__title">
          {t(language, 'deepcodeGui.outputs.title')}
        </div>
        {artifacts.length === 0 ? (
          <div className="deepcode-gui-task-list-card__empty">
            {t(language, 'deepcodeGui.outputs.empty')}
          </div>
        ) : artifacts.map((artifact) => (
          <div
            className="deepcode-gui-output-item"
            key={artifact.artifactId}
            title={artifact.logicalPath ?? artifact.uri ?? ''}
          >
            <strong>{artifact.label}</strong>
            <span>{artifact.logicalPath ?? artifact.uri ?? ''}</span>
          </div>
        ))}
      </section>
    </aside>
  );
};

function todoStatus(status: 'pending' | 'inProgress' | 'completed', language: UiLanguage): string {
  return t(language, `deepcodeGui.tasks.status.${status}`);
}

export default DeepCodeTaskPanel;
