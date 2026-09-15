import { MarkdownInline } from '../../components/local-agent/BufferedMarkdown';
import React from 'react';
import { ArtifactLinks } from '../../components/local-agent/ArtifactLinks';
import { requestWorkspacePreview } from '../../components/local-agent/readerState';
import type { SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface DeepCodeTaskPanelProps {
  language: UiLanguage;
  projection: SessionProjection | null;
}

const DeepCodeTaskPanel: React.FC<DeepCodeTaskPanelProps> = ({ language, projection }) => {
  // Each fixed delivery is immutable; its execution timestamp is the last
  // content change of that version. Keep all versions in this Session.
  const artifacts = [...(projection?.artifacts ?? [])].sort(
    (left, right) => artifactTimestamp(right.createdAt) - artifactTimestamp(left.createdAt),
  );
  const todos = projection?.todoList?.items ?? [];
  return (
    <aside className="deepcode-gui-context-panel">
      <section className="deepcode-gui-task-list-card">
        <div className="deepcode-gui-task-list-card__title">
          <span>{t(language, 'deepcodeGui.tasks.title')}</span>
          {projection?.todoList && (
            <small>
              {t(language, 'agent.plan.revision', {
                revision: projection.todoList.sourcePlanRevision,
              })}
            </small>
          )}
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
                  <div className="deepcode-gui-task-item__title"><MarkdownInline>{todo.label}</MarkdownInline></div>
                </div>
                <strong>{todoStatus(todo.status, language)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="deepcode-gui-task-list-card deepcode-gui-output-card">
        <div className="deepcode-gui-task-list-card__title">
          <span>{t(language, 'deepcodeGui.outputs.title')}</span>
        </div>
        {artifacts.length === 0 ? (
          <div className="deepcode-gui-task-list-card__empty">
            {t(language, 'deepcodeGui.outputs.empty')}
          </div>
        ) : <ArtifactLinks key={projection?.sessionId} artifacts={artifacts} onOpen={(workspaceId,path)=>requestWorkspacePreview(projection!.sessionId,workspaceId,path)} />}
      </section>
    </aside>
  );
};

function artifactTimestamp(value: string): number {
  return /^\d+$/u.test(value) ? Number(value) : Date.parse(value);
}

function todoStatus(status: 'pending' | 'inProgress' | 'completed', language: UiLanguage): string {
  return t(language, `deepcodeGui.tasks.status.${status}`);
}

export default DeepCodeTaskPanel;
