import React, { useMemo, useState } from 'react';
import type { AgentSession } from '@deepcode/protocol';

interface AgentSessionSelectorProps {
  session: AgentSession | null;
  sessions: AgentSession[];
  loading?: boolean;
  onNew: () => void;
  onActivate: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onArchive: (sessionId: string) => void;
}

function formatTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sessionTitle(session: AgentSession | null): string {
  return session?.title?.trim() || 'New Agent Session';
}

function isEmptySession(session: AgentSession): boolean {
  return (session.eventCount ?? 0) === 0;
}

const AgentSessionSelector: React.FC<AgentSessionSelectorProps> = ({
  session,
  sessions,
  loading,
  onNew,
  onActivate,
  onRename,
  onArchive,
}) => {
  const [open, setOpen] = useState(false);
  const activeSessions = useMemo(
    () => sessions.filter((item) => !item.archivedAt),
    [sessions]
  );
  const newDisabled = Boolean(loading || (session && isEmptySession(session)));
  const newTitle = session && isEmptySession(session)
    ? 'Current session is empty'
    : 'New Agent session';

  return (
    <div className="agent-session-bar">
      <button
        className="agent-session-bar__selector"
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="Switch Agent session"
      >
        <span className="agent-session-bar__eyebrow">Session</span>
        <span className="agent-session-bar__title">{sessionTitle(session)}</span>
        <span className="agent-session-bar__chevron">{open ? 'Hide' : 'Show'}</span>
      </button>
      <button
        className="agent-session-bar__new"
        type="button"
        disabled={newDisabled}
        onClick={onNew}
        title={newTitle}
      >
        +
      </button>

      {open && (
        <div className="agent-session-menu">
          <div className="agent-session-menu__header">
            <span>Current Workspace</span>
            <button type="button" onClick={onNew} disabled={newDisabled} title={newTitle}>New</button>
          </div>
          <div className="agent-session-menu__list">
            {activeSessions.length === 0 && (
              <div className="agent-session-menu__empty">No sessions yet.</div>
            )}
            {activeSessions.map((item) => (
              <div
                key={item.id}
                className={`agent-session-menu__item${item.id === session?.id ? ' agent-session-menu__item--active' : ''}`}
              >
                <button
                  type="button"
                  className="agent-session-menu__main"
                  onClick={() => {
                    setOpen(false);
                    onActivate(item.id);
                  }}
                >
                  <span className="agent-session-menu__title">{sessionTitle(item)}</span>
                  <span className="agent-session-menu__meta">
                    {formatTime(item.updatedAt)}
                    {item.lastSummary ? ` · ${item.lastSummary}` : ''}
                  </span>
                </button>
                <div className="agent-session-menu__actions">
                  <button
                    type="button"
                    onClick={() => {
                      const nextTitle = window.prompt('Rename Agent session', sessionTitle(item));
                      if (nextTitle !== null) onRename(item.id, nextTitle);
                    }}
                  >
                    Rename
                  </button>
                  {!isEmptySession(item) && (
                    <button
                      type="button"
                      onClick={() => onArchive(item.id)}
                    >
                      Del
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentSessionSelector;
