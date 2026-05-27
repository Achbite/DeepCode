/**
 * Git panel placeholder.
 * Stage 7 will attach Git status / diff / git.tree data.
 */
import React, { useEffect, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import './gitPanel.css';

interface GitContextMenuState {
  x: number;
  y: number;
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

  return (
    <div
      className="git-panel-placeholder"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="placeholder-content">
        {t(language, 'git.placeholder')}
        <div className="stage-hint">{t(language, 'git.stageHint')}</div>
      </div>

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

export default GitPanelPlaceholder;
