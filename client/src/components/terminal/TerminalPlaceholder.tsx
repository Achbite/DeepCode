import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalSession } from '@deepcode/protocol';
import {
  createTerminalSession,
  deleteTerminalSession,
  getTerminalEvents,
  listTerminalSessions,
  restartTerminalSession,
  sendTerminalInput,
  updateTerminalSession,
} from '../../services/apiClient';
import './terminalPanel.css';

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

const TerminalPlaceholder: React.FC<TerminalPlaceholderProps> = ({ onMinimize }) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [outputBySession, setOutputBySession] = useState<Record<string, string>>({});
  const [command, setCommand] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const dragStateRef = useRef<TerminalDragState | null>(null);
  const lastSequenceRef = useRef<Record<string, number>>({});
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeIdRef = useRef<string | null>(null);

  const active = sessions.find((session) => session.id === activeId) ?? sessions[0];
  const activeOutput = active ? outputBySession[active.id] ?? '' : '';

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const applySessions = useCallback(
    (nextSessions: TerminalSession[], preferredActiveId?: string) => {
      const sorted = [...nextSessions].sort((a, b) => a.order - b.order);
      const preferred = preferredActiveId
        ? sorted.find((session) => session.id === preferredActiveId)
        : undefined;
      const current = activeIdRef.current
        ? sorted.find((session) => session.id === activeIdRef.current)
        : undefined;

      sessionsRef.current = sorted;
      setSessions(sorted);
      setActiveId((preferred ?? current ?? sorted[0])?.id ?? null);
    },
    []
  );

  const refreshSessions = useCallback(async (preferredActiveId?: string) => {
    const result = await listTerminalSessions();
    if (!result.ok || !result.data) return;
    applySessions(result.data.sessions, preferredActiveId);
  }, [applySessions]);

  const createTerminal = useCallback(async () => {
    const currentSessions = sessionsRef.current;
    const result = await createTerminalSession({
      name: `Terminal ${currentSessions.length + 1}`,
    });
    if (!result.ok || !result.data) return;
    applySessions([...currentSessions, result.data], result.data.id);
    void refreshSessions(result.data.id);
  }, [applySessions, refreshSessions]);

  const closeTerminal = useCallback(async (sessionId: string) => {
    const currentSessions = sessionsRef.current;
    const closingIndex = currentSessions.findIndex((session) => session.id === sessionId);
    if (closingIndex < 0) return;

    const result = await deleteTerminalSession(sessionId);
    if (!result.ok) return;

    const nextSessions = currentSessions.filter((session) => session.id !== sessionId);
    const fallbackActive =
      nextSessions[Math.min(closingIndex, Math.max(0, nextSessions.length - 1))]?.id ??
      nextSessions[0]?.id;
    setOutputBySession((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    lastSequenceRef.current[sessionId] = 0;
    applySessions(nextSessions, fallbackActive);
    setContextMenu(null);
    setRenamingId(null);
    void refreshSessions(fallbackActive);
  }, [applySessions, refreshSessions]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listTerminalSessions();
      if (cancelled) return;
      if (result.ok && result.data && result.data.sessions.length > 0) {
        applySessions(result.data.sessions);
        return;
      }
      const created = await createTerminalSession({ name: 'Terminal 1' });
      if (!cancelled && created.ok && created.data) {
        applySessions([created.data], created.data.id);
        void refreshSessions(created.data.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySessions, refreshSessions]);

  useEffect(() => {
    if (!active?.id) return;
    const timer = window.setInterval(async () => {
      const after = lastSequenceRef.current[active.id] ?? 0;
      const result = await getTerminalEvents(active.id, after);
      if (!result.ok || !result.data || result.data.events.length === 0) return;
      const text = result.data.events
        .map((event) => {
          if (event.sequence > (lastSequenceRef.current[event.sessionId] ?? 0)) {
            lastSequenceRef.current[event.sessionId] = event.sequence;
          }
          if (event.type === 'exit') return `\n[process exited ${event.exitCode ?? ''}]\n`;
          if (event.type === 'error') return `\n[error] ${event.data ?? ''}\n`;
          if (event.type === 'status') return '';
          return event.data ?? '';
        })
        .join('');
      if (!text) return;
      setOutputBySession((prev) => ({
        ...prev,
        [active.id]: `${prev[active.id] ?? ''}${text}`,
      }));
      void refreshSessions();
    }, 600);
    return () => window.clearInterval(timer);
  }, [active?.id, refreshSessions]);

  const moveSession = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setSessions((prev) => {
      const sourceIndex = prev.findIndex((session) => session.id === sourceId);
      const targetIndex = prev.findIndex((session) => session.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      next.forEach((session, order) => {
        void updateTerminalSession(session.id, { order });
      });
      return next.map((session, order) => ({ ...session, order }));
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
        setRenamingId(null);
      }
      if (event.key === 'Delete' && renamingId === null) {
        const target = event.target as HTMLElement | null;
        const sessionElement = target?.closest<HTMLElement>('[data-terminal-id]');
        const sessionId = sessionElement?.dataset.terminalId;
        if (sessionId) {
          event.preventDefault();
          void closeTerminal(sessionId);
        }
      }
    };

    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeTerminal, renamingId]);

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

  const submitRename = async () => {
    if (!renamingId) return;
    const name = renameValue.trim();
    if (name) {
      const result = await updateTerminalSession(renamingId, { name });
      if (result.ok && result.data) {
        setSessions((prev) =>
          prev.map((session) => (session.id === renamingId ? result.data! : session))
        );
      }
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const restartSession = async (sessionId: string) => {
    const result = await restartTerminalSession(sessionId);
    if (result.ok && result.data) {
      setSessions((prev) =>
        prev.map((session) => (session.id === sessionId ? result.data! : session))
      );
      setActiveId(result.data.id);
      setOutputBySession((prev) => ({ ...prev, [result.data!.id]: '' }));
    }
    setContextMenu(null);
  };

  const submitCommand = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!active || command.trim() === '') return;
    const line = `${command}\n`;
    setOutputBySession((prev) => ({
      ...prev,
      [active.id]: `${prev[active.id] ?? ''}${active.shellKind} $ ${command}\n`,
    }));
    setCommand('');
    await sendTerminalInput(active.id, { data: line });
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__body">
        <div className="terminal-panel__screen">
          <pre className="terminal-panel__output">
            {activeOutput || 'DeepCode terminal surface\nCreate or select a terminal session.'}
          </pre>
          <form className="terminal-panel__prompt" onSubmit={submitCommand}>
            <span>{active?.shellKind ?? 'shell'}</span>
            <input
              className="terminal-panel__command-input"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              disabled={!active || active.status !== 'running'}
              aria-label="Terminal input"
            />
            <span className="terminal-panel__cursor">_</span>
          </form>
        </div>

        <aside className="terminal-panel__sidebar" aria-label="Terminal sessions">
          <div className="terminal-panel__sidebar-header" aria-label="Terminal panel controls">
            <span className="terminal-panel__sidebar-title">TERMINAL</span>
            <div className="terminal-panel__sidebar-actions">
              <button
                className="terminal-panel__icon-btn"
                type="button"
                title="New terminal"
                aria-label="New terminal"
                onClick={() => void createTerminal()}
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

          <div className="terminal-panel__session-list">
            {sessions.map((session) => (
              <div
                key={session.id}
                data-terminal-id={session.id}
                className={`terminal-panel__session ${
                  session.id === active?.id ? 'terminal-panel__session--active' : ''
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
                role="button"
                tabIndex={0}
                title={`${session.name} (${session.status})`}
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
                          void submitRename();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          setRenamingId(null);
                        }
                      }}
                      onBlur={() => void submitRename()}
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
          onRestart={() => void restartSession(contextMenu.sessionId)}
          onClose={() => void closeTerminal(contextMenu.sessionId)}
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
  onClose: () => void;
}

const TerminalSessionMenu: React.FC<TerminalSessionMenuProps> = ({
  x,
  y,
  session,
  onRename,
  onRestart,
  onClose,
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
      <button type="button" className="terminal-panel__context-danger" onClick={onClose}>
        Close Terminal
      </button>
    </div>
  );
};

export default TerminalPlaceholder;
