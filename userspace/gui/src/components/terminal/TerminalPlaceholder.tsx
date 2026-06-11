import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalSession } from '@deepcode/protocol';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  createTerminalSession,
  deleteTerminalSession,
  getTerminalEvents,
  listTerminalSessions,
  restartTerminalSession,
  resizeTerminalSession,
  sendTerminalInput,
  updateTerminalSession,
} from '../../services/runtimeAdapter';
import { t, type UiLanguage } from '../../i18n';
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
  language: UiLanguage;
  onMinimize: () => void;
}

const TerminalPlaceholder: React.FC<TerminalPlaceholderProps> = ({ language, onMinimize }) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [outputBySession, setOutputBySession] = useState<Record<string, string>>({});
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const dragStateRef = useRef<TerminalDragState | null>(null);
  const lastSequenceRef = useRef<Record<string, number>>({});
  const seenEventKeysRef = useRef<Set<string>>(new Set());
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalSessionIdRef = useRef<string | null>(null);
  const outputBySessionRef = useRef<Record<string, string>>({});
  const lastTerminalSizeRef = useRef<Record<string, string>>({});

  const active = sessions.find((session) => session.id === activeId) ?? sessions[0];

  const describeFailure = useCallback(
    (result: { error?: string; message?: string }) =>
      result.message || result.error || t(language, 'terminal.error.requestFailed'),
    [language]
  );

  const defaultPendingShell = (): TerminalSession['shellKind'] =>
    navigator.platform.toLowerCase().includes('win') ? 'wsl' : 'bash';

  const defaultOutput = () => {
    if (!active) {
      return t(language, 'terminal.output.empty');
    }
    if (active.status === 'starting') {
      return t(language, 'terminal.output.starting', { shell: active.shellKind.toUpperCase() });
    }
    if (active.status === 'error') {
      return t(language, 'terminal.output.failed', { name: active.name });
    }
    if (active.status === 'exited') {
      return t(language, 'terminal.output.exited', { name: active.name });
    }
    return t(language, 'terminal.output.empty');
  };

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    outputBySessionRef.current = outputBySession;
  }, [outputBySession]);

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
    if (!result.ok || !result.data) {
      setTerminalError(describeFailure(result));
      return;
    }
    setTerminalError(null);
    applySessions(result.data.sessions, preferredActiveId);
  }, [applySessions, describeFailure]);

  const clearSeenEventsForSession = useCallback((sessionId: string) => {
    for (const key of Array.from(seenEventKeysRef.current)) {
      if (key.startsWith(`${sessionId}:`)) {
        seenEventKeysRef.current.delete(key);
      }
    }
  }, []);

  const createTerminal = useCallback(async () => {
    const currentSessions = sessionsRef.current;
    const now = new Date().toISOString();
    const terminalName = t(language, 'terminal.defaultName', { index: currentSessions.length + 1 });
    const pending: TerminalSession = {
      id: `pending-${Date.now()}`,
      name: terminalName,
      shellKind: defaultPendingShell(),
      cwd: '',
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      order: currentSessions.length,
      exitCode: null,
    };
    applySessions([...currentSessions, pending], pending.id);
    const result = await createTerminalSession({
      name: terminalName,
    });
    if (!result.ok || !result.data) {
      setTerminalError(describeFailure(result));
      applySessions(currentSessions, activeIdRef.current ?? undefined);
      return;
    }
    setTerminalError(null);
    applySessions([...currentSessions, result.data], result.data.id);
    void refreshSessions(result.data.id);
  }, [applySessions, describeFailure, refreshSessions, language]);

  const closeTerminal = useCallback(async (sessionId: string) => {
    const currentSessions = sessionsRef.current;
    const closingIndex = currentSessions.findIndex((session) => session.id === sessionId);
    if (closingIndex < 0) return;

    const result = await deleteTerminalSession(sessionId);
    if (!result.ok) {
      setTerminalError(describeFailure(result));
      return;
    }
    setTerminalError(null);

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
    clearSeenEventsForSession(sessionId);
    applySessions(nextSessions, fallbackActive);
    setContextMenu(null);
    setRenamingId(null);
    void refreshSessions(fallbackActive);
  }, [applySessions, refreshSessions, describeFailure, clearSeenEventsForSession]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listTerminalSessions();
      if (cancelled) return;
      if (result.ok && result.data && result.data.sessions.length > 0) {
        setTerminalError(null);
        applySessions(result.data.sessions);
      } else if (!result.ok) {
        setTerminalError(describeFailure(result));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySessions, refreshSessions, describeFailure]);

  useEffect(() => {
    if (!active?.id) return;
    const timer = window.setInterval(async () => {
      const after = lastSequenceRef.current[active.id] ?? 0;
      const result = await getTerminalEvents(active.id, after);
      if (!result.ok || !result.data) {
        setTerminalError(describeFailure(result));
        return;
      }
      if (result.data.events.length === 0) return;
      setTerminalError(null);
      const text = result.data.events
        .map((event) => {
          if (event.sequence > (lastSequenceRef.current[event.sessionId] ?? 0)) {
            lastSequenceRef.current[event.sessionId] = event.sequence;
          }
          const eventKey = `${event.sessionId}:${event.sequence}`;
          if (seenEventKeysRef.current.has(eventKey)) return '';
          seenEventKeysRef.current.add(eventKey);
          if (event.type === 'exit') return `\n[process exited ${event.exitCode ?? ''}]\n`;
          if (event.type === 'error') return `\n[error] ${event.data ?? ''}\n`;
          if (event.type === 'ready') return '';
          if (event.type === 'status') return '';
          return event.data ?? '';
        })
        .join('');
      if (!text) return;
      setOutputBySession((prev) => ({
        ...prev,
        [active.id]: `${prev[active.id] ?? ''}${text}`,
      }));
      if (terminalSessionIdRef.current === active.id) {
        xtermRef.current?.write(text);
      }
      void refreshSessions();
    }, 600);
    return () => window.clearInterval(timer);
  }, [active?.id, describeFailure, refreshSessions]);

  useEffect(() => {
    if (!active?.id || !terminalHostRef.current) {
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      terminalSessionIdRef.current = null;
      return;
    }
    const sessionId = active.id;
    const terminal = new XTerm({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'block',
      disableStdin: active.status !== 'running',
      fontFamily: '"Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#050506',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    terminal.write(outputBySessionRef.current[sessionId] ?? '');
    terminalSessionIdRef.current = sessionId;
    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const inputDisposable = terminal.onData((data) => {
      if (activeIdRef.current !== sessionId) return;
      void sendTerminalInput(sessionId, { data }).then((result) => {
        if (!result.ok) {
          setTerminalError(describeFailure(result));
        } else {
          setTerminalError(null);
        }
      });
    });

    let frame = 0;
    const resize = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch (error) {
          console.warn('Terminal fit failed.', error);
          return;
        }
        const key = `${terminal.cols}x${terminal.rows}`;
        if (lastTerminalSizeRef.current[sessionId] === key) return;
        lastTerminalSizeRef.current[sessionId] = key;
        void resizeTerminalSession(sessionId, { cols: terminal.cols, rows: terminal.rows });
      });
    };
    resize();
    terminal.focus();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => resize());
    if (observer) observer.observe(terminalHostRef.current);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      inputDisposable.dispose();
      terminal.dispose();
      if (terminalSessionIdRef.current === sessionId) {
        terminalSessionIdRef.current = null;
        xtermRef.current = null;
        fitAddonRef.current = null;
      }
    };
  }, [active?.id, active?.status, describeFailure]);

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
        setTerminalError(null);
        setSessions((prev) =>
          prev.map((session) => (session.id === renamingId ? result.data! : session))
        );
      } else if (!result.ok) {
        setTerminalError(describeFailure(result));
      }
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const restartSession = async (sessionId: string) => {
    const result = await restartTerminalSession(sessionId);
    if (result.ok && result.data) {
      setTerminalError(null);
      setSessions((prev) =>
        prev.map((session) => (session.id === sessionId ? result.data! : session))
      );
      setActiveId(result.data.id);
      clearSeenEventsForSession(result.data.id);
      if (terminalSessionIdRef.current === result.data.id) {
        xtermRef.current?.clear();
      }
      setOutputBySession((prev) => ({ ...prev, [result.data!.id]: '' }));
    } else if (!result.ok) {
      setTerminalError(describeFailure(result));
    }
    setContextMenu(null);
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__body">
        <div className="terminal-panel__screen" ref={screenRef}>
          {terminalError && (
            <div className="terminal-panel__error" role="status">
              {terminalError}
            </div>
          )}
          {!active && <div className="terminal-panel__empty">{defaultOutput()}</div>}
          {active?.status === 'starting' && (
            <div className="terminal-panel__empty terminal-panel__empty--overlay">
              {defaultOutput()}
            </div>
          )}
          <div className="terminal-panel__xterm" ref={terminalHostRef} />
        </div>

        <aside className="terminal-panel__sidebar" aria-label={t(language, 'terminal.sessions')}>
          <div className="terminal-panel__sidebar-header" aria-label={t(language, 'terminal.controls')}>
            <span className="terminal-panel__sidebar-title">{t(language, 'terminal.title')}</span>
            <div className="terminal-panel__sidebar-actions">
              <button
                className="terminal-panel__icon-btn"
                type="button"
                title={t(language, 'terminal.new')}
                aria-label={t(language, 'terminal.new')}
                onClick={() => void createTerminal()}
              >
                <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M8 3.5v9m-4.5-4.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
              <button
                className="terminal-panel__icon-btn"
                type="button"
                title={t(language, 'terminal.minimize')}
                aria-label={t(language, 'terminal.minimize')}
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
                  {session.status !== 'running' && (
                    <span className="terminal-panel__session-status">{session.status}</span>
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
          language={language}
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
  language: UiLanguage;
}

const TerminalSessionMenu: React.FC<TerminalSessionMenuProps> = ({
  x,
  y,
  session,
  onRename,
  onRestart,
  onClose,
  language,
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
        {t(language, 'terminal.rename')}
      </button>
      <button type="button" onClick={onRestart}>
        {t(language, 'terminal.restart')}
      </button>
      <button type="button" className="terminal-panel__context-danger" onClick={onClose}>
        {t(language, 'terminal.close')}
      </button>
    </div>
  );
};

export default TerminalPlaceholder;
