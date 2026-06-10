/**
 * Git panel placeholder.
 * Stage 7 will attach Git status / diff / git.tree data.
 */
import React, { useEffect, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { getGitStatus } from '../../services/runtimeAdapter';
import './gitPanel.css';

interface GitContextMenuState {
  x: number;
  y: number;
}

interface GitChangeItem {
  path: string;
  index: string;
  worktree: string;
  group: string;
  raw: string;
}

const RESERVED_ACTION_KEYS = [
  'git.openFile',
  'git.openChanges',
  'git.viewFileHistory',
  'git.revealInExplorer',
];

interface GitPanelPlaceholderProps {
  language: UiLanguage;
}

const GitPanelPlaceholder: React.FC<GitPanelPlaceholderProps> = ({ language }) => {
  const [contextMenu, setContextMenu] = useState<GitContextMenuState | null>(null);
  const [changes, setChanges] = useState<GitChangeItem[]>([]);
  const [root, setRoot] = useState<string>('');
  const [message, setMessage] = useState<string>('');

  const refresh = async () => {
    const response = await getGitStatus();
    if (response.ok && response.data) {
      setChanges(response.data.changes);
      setRoot(response.data.root);
      setMessage('');
    } else {
      setChanges([]);
      setRoot('');
      setMessage(response.message ?? response.error ?? t(language, 'git.statusUnavailable'));
    }
  };

  useEffect(() => {
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };

    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, []);

  const grouped = groupChanges(changes);

  return (
    <div
      className="git-panel-placeholder"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="git-panel-toolbar">
        <div>
          <strong>{t(language, 'workbench.sourceControl')}</strong>
          <span>{root || t(language, 'git.noRepository')}</span>
        </div>
        <button type="button" onClick={() => void refresh()} title={t(language, 'git.refresh')}>
          ↻
        </button>
      </div>

      {message ? (
        <div className="placeholder-content">
          {message}
          <div className="stage-hint">{t(language, 'git.stageHint')}</div>
        </div>
      ) : changes.length === 0 ? (
        <div className="placeholder-content">
          {t(language, 'git.clean')}
          <div className="stage-hint">{t(language, 'git.stageHint')}</div>
        </div>
      ) : (
        <div className="git-change-tree">
          {(['staged', 'changed', 'untracked'] as const).map((group) => (
            <section key={group} className="git-change-group">
              <header>
                <span>{t(language, `git.group.${group}`)}</span>
                <strong>{grouped[group].length}</strong>
              </header>
              {grouped[group].map((change) => (
                <button key={`${change.group}:${change.path}:${change.raw}`} type="button">
                  <span className="git-change-status">{change.index}{change.worktree}</span>
                  <span className="git-change-path">{change.path}</span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}

      {contextMenu && (
        <div
          className="git-panel-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="git-panel-context-menu__title">{t(language, 'workbench.sourceControl')}</div>
          {RESERVED_ACTION_KEYS.map((key) => (
            <button key={key} type="button" disabled title={t(language, 'git.reservedTitle')}>
              {t(language, key)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

function groupChanges(changes: GitChangeItem[]): Record<'staged' | 'changed' | 'untracked', GitChangeItem[]> {
  return {
    staged: changes.filter((change) => change.group === 'staged'),
    changed: changes.filter((change) => change.group === 'changed'),
    untracked: changes.filter((change) => change.group === 'untracked'),
  };
}

export default GitPanelPlaceholder;
