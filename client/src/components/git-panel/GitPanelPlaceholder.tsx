/**
 * Git panel placeholder.
 * Stage 7 will attach Git status / diff / git.tree data.
 */
import React, { useEffect, useState } from 'react';
import './gitPanel.css';

interface GitContextMenuState {
  x: number;
  y: number;
}

const RESERVED_ACTIONS = [
  'Open File',
  'Open Changes',
  'View File History',
  'Reveal in Explorer',
];

const GitPanelPlaceholder: React.FC = () => {
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
        GitPanelPlaceholder
        <div className="stage-hint">(Stage 7: Git status / diff / git.tree)</div>
      </div>

      {contextMenu && (
        <div
          className="git-panel-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="git-panel-context-menu__title">Source Control</div>
          {RESERVED_ACTIONS.map((action) => (
            <button key={action} type="button" disabled title="Reserved for Git integration">
              {action}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default GitPanelPlaceholder;
