import { MarkdownInline } from '../../components/local-agent/BufferedMarkdown';
import React from 'react';
import { useDisplayedConversation } from '../../components/local-agent/ConversationDisplayProvider';
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
  const display = useDisplayedConversation();
  const [showAllArtifacts, setShowAllArtifacts] = React.useState(false);
  const outputListId = React.useId();
  React.useEffect(() => { setShowAllArtifacts(false); }, [projection?.sessionId]);
  const artifacts = [...display.artifacts].sort(
    (left, right) => artifactTimestamp(right.createdAt) - artifactTimestamp(left.createdAt),
  );
  const todos = projection?.todoList?.items ?? [];
  const todoRun = projection?.todoList && projection.tokenUsageHistory.find(run => run.runId === projection.todoList!.runId);
  const remaining = todos.filter(todo => todo.status !== 'completed').length;
  const ended = Boolean(todoRun?.outcome);
  return (
    <aside className="deepcode-gui-context-panel">
      <section className="deepcode-gui-task-list-card">
        <div className="deepcode-gui-task-list-card__title">
          <span>{t(language, 'deepcodeGui.tasks.title')}</span>
        </div>
        {todos.length === 0 ? (
          <div className="deepcode-gui-task-list-card__empty">
            {t(language, 'deepcodeGui.tasks.empty')}
          </div>
        ) : (
          <div className="deepcode-gui-task-list">
            {todos.map((todo, index) => (
              <div
                className={`deepcode-gui-task-item deepcode-gui-task-item--${todo.status === 'inProgress' ? 'active' : todo.status}`}
                key={index}
              >
                <span className="deepcode-gui-task-item__dot" aria-hidden="true" />
                <div>
                  <div className="deepcode-gui-task-item__title"><MarkdownInline>{todo.text}</MarkdownInline></div>
                </div>
                <strong>{todoStatus(todo.status, language)}</strong>
              </div>
            ))}
          </div>
        )}
        {ended && remaining > 0 && <small className="deepcode-gui-task-list-card__note">
          {t(language, 'deepcodeGui.tasks.endedRemaining', { count: remaining })}
        </small>}
      </section>

      <section className="deepcode-gui-task-list-card deepcode-gui-output-card">
        <div className="deepcode-gui-task-list-card__title">
          <span>{t(language, 'deepcodeGui.outputs.title')}</span>
        </div>
        {artifacts.length === 0 ? (
          <div className="deepcode-gui-task-list-card__empty">
            {t(language, 'deepcodeGui.outputs.empty')}
          </div>
        ) : <>
          <div id={outputListId} className="deepcode-gui-output-list">
            <ArtifactLinks key={projection?.sessionId} artifacts={showAllArtifacts ? artifacts : artifacts.slice(0, 3)} onOpen={(workspaceId,path)=>requestWorkspacePreview(projection!.sessionId,workspaceId,path)} />
          </div>
          {artifacts.length > 3 && <button type="button" className="deepcode-gui-output-more" aria-expanded={showAllArtifacts} aria-controls={outputListId} onClick={() => setShowAllArtifacts((value) => !value)}>
            {t(language, showAllArtifacts ? 'deepcodeGui.outputs.showLess' : 'deepcodeGui.outputs.showAll', { count: artifacts.length })}
          </button>}
        </>}
      </section>
    </aside>
  );
};

function artifactTimestamp(value: string): number {
  return /^\d+$/u.test(value) ? Number(value) : Date.parse(value);
}

function todoStatus(status: 'pending' | 'inProgress' | 'completed' | 'blocked', language: UiLanguage): string {
  return t(language, `deepcodeGui.tasks.status.${status}`);
}

export default DeepCodeTaskPanel;
