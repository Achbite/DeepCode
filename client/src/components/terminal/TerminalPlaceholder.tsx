import React, { useCallback, useEffect, useRef, useState } from 'react';
import './terminalPanel.css';

interface TerminalSession {
  id: string;
  name: string;
  shell: string;
  lines: string[];
}

interface TerminalContextMenu {
  x: number;
  y: number;
  sessionId: string;
}

interface TerminalDragState {
  id: string;
  startY: number;
  started: boolean;
}

interface TerminalPlaceholderProps {
  onMinimize: () => void;
}

const INITIAL_TERMINALS: TerminalSession[] = [
  {
    id: 'terminal-1',
    name: 'Terminal 1',
    shell: 'PowerShell',
    lines: [
      'DeepCode terminal surface',
      'Shell backend will attach here when node-pty is enabled.',
    ],
  },
];

const TerminalPlaceholder: React.FC<TerminalPlaceholderProps> = ({ onMinimize }) => {
  const [sessions, setSessions] = useState<TerminalSession[]>(INITIAL_TERMINALS);
  const [activeId, setActiveId] = useState(INITIAL_TERMINALS[0].id);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const dragStateRef = useRef<TerminalDragState | null>(null);

  const active = sessions.find((session) => session.id === activeId) ?? sessions[0];

  const moveSession = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setSessions((prev) => {
      const sourceIndex = prev.findIndex((session) => session.id === sourceId);
      const targetIndex = prev.findIndex((session) => session.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest('.terminal-panel__context-menu') ||
        target?.closest('[data-terminal-id]')
      ) {
        return;
      }
      setContextMenu(null);
    };
    const closeOnBlur = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
        setRenamingId(null);
      }
    };

    window.addEventListener('click', close);
    window.addEventListener('blur', closeOnBlur);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', closeOnBlur);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;
      if (!dragState.started && Math.abs(event.clientY - dragState.startY) < 4) return;
      dragState.started = true;
      setDraggedId(dragState.id);

      const target = (
        document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      )?.closest<HTMLElement>('[data-terminal-id]');
      const targetId = target?.dataset.terminalId;
      if (targetId && targetId !== dragState.id) {
        moveSession(dragState.id, targetId);
      }
    };

    const onMouseUp = () => {
      dragStateRef.current = null;
      setDraggedId(null);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [moveSession]);

  const createTerminal = () => {
    const nextIndex = sessions.length + 1;
    const next: TerminalSession = {
      id: `terminal-${Date.now()}`,
      name: `Terminal ${nextIndex}`,
      shell: 'PowerShell',
      lines: ['New terminal session ready.'],
    };
    setSessions((prev) => [...prev, next]);
    setActiveId(next.id);
  };

  const openContextMenu = (
    event: React.MouseEvent<HTMLDivElement>,
    sessionId: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveId(sessionId);
    setContextMenu({ x: event.clientX, y: event.clientY, sessionId });
  };

  const startRename = (session: TerminalSession) => {
    setRenamingId(session.id);
    setRenameValue(session.name);
    setContextMenu(null);
  };

  const submitRename = () => {
    if (!renamingId) return;
    const name = renameValue.trim();
    if (name) {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === renamingId ? { ...session, name } : session
        )
      );
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const restartSession = (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    setSessions((prev) =>
      prev.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              lines: [
                `${session?.name ?? 'Terminal'} restarted.`,
                'Shell backend will attach here when node-pty is enabled.',
              ],
            }
          : item
      )
    );
    setActiveId(sessionId);
    setContextMenu(null);
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__body">
        <div className="terminal-panel__screen">
          {active.lines.map((line, index) => (
            <div key={`${active.id}:${index}`}>{line}</div>
          ))}
          <div className="terminal-panel__prompt">
            <span>{active.shell}</span>
            <span className="terminal-panel__cursor">_</span>
          </div>
        </div>

        <aside className="terminal-panel__sidebar" aria-label="Terminal sessions">
          {/* 顶部工具栏：Apple 风格的 Flex 布局和 SVG 图标 */}
          <div className="terminal-panel__sidebar-header" aria-label="Terminal panel controls">
            <span className="terminal-panel__sidebar-title">TERMINAL</span>
            <div className="terminal-panel__sidebar-actions">
              <button
                className="terminal-panel__icon-btn"
                type="button"
                title="New terminal"
                aria-label="New terminal"
                onClick={createTerminal}
              >
                <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M8 3.5v9m-4.5-4.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
              <button
                className="terminal-panel__icon-btn"
                type="button"
                title="Minimize terminal"
                aria-label="Minimize terminal"
                onClick={onMinimize}
              >
                <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          </div>

          {/* 终端会话列表 */}
          <div className="terminal-panel__session-list">
            {sessions.map((session) => (
              <div
                key={session.id}
                data-terminal-id={session.id}
                className={`terminal-panel__session ${
                  session.id === active.id ? 'terminal-panel__session--active' : ''
                } ${draggedId === session.id ? 'terminal-panel__session--dragging' : ''}`}
                onMouseDown={(event) => {
                  if (event.button === 2) {
                    openContextMenu(event, session.id);
                    return;
                  }
                  if (event.button !== 0 || renamingId === session.id) return;
                  event.preventDefault();
                  dragStateRef.current = {
                    id: session.id,
                    startY: event.clientY,
                    started: false,
                  };
                }}
                onClick={() => setActiveId(session.id)}
                onContextMenu={(event) => openContextMenu(event, session.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setActiveId(session.id);
                  }
                }}
                role="button"
                tabIndex={0}
                title={session.name}
              >
                <div className="terminal-panel__session-icon">
                  <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 4.5l4 3.5-4 3.5m5.5 0h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div className="terminal-panel__session-content">
                  {renamingId === session.id ? (
                    <input
                      ref={renameInputRef}
                      className="terminal-panel__rename-input"
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          submitRename();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          setRenamingId(null);
                        }
                      }}
                      onBlur={submitRename}
                    />
                  ) : (
                    <span className="terminal-panel__session-name">{session.name}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {contextMenu && (
        <TerminalSessionMenu
          x={contextMenu.x}
          y={contextMenu.y}
          session={sessions.find((session) => session.id === contextMenu.sessionId)}
          onRename={startRename}
          onRestart={() => restartSession(contextMenu.sessionId)}
        />
      )}
    </div>
  );
};

interface TerminalSessionMenuProps {
  x: number;
  y: number;
  session?: TerminalSession;
  onRename: (session: TerminalSession) => void;
  onRestart: () => void;
}

const TerminalSessionMenu: React.FC<TerminalSessionMenuProps> = ({
  x,
  y,
  session,
  onRename,
  onRestart,
}) => {
  if (!session) return null;
  return (
    <div
      className="terminal-panel__context-menu"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="terminal-panel__context-title">{session.name}</div>
      <button type="button" onClick={() => onRename(session)}>
        Rename Terminal
      </button>
      <button type="button" onClick={onRestart}>
        Restart Terminal
      </button>
    </div>
  );
};

export default TerminalPlaceholder;
