import React, { useMemo, useState } from 'react';
import type { AgentSession } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface AgentSessionSelectorProps {
  session: AgentSession | null;
  sessions: AgentSession[];
  language: UiLanguage;
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

function sessionTitle(session: AgentSession | null, language: UiLanguage): string {
  return session?.title?.trim() || t(language, 'agent.session.newTitle');
}

function isEmptySession(session: AgentSession): boolean {
  return (session.eventCount ?? 0) === 0;
}

const AgentSessionSelector: React.FC<AgentSessionSelectorProps> = ({
  session,
  sessions,
  language,
  loading,
  onNew,
  onActivate,
  onRename,
  onArchive,
}) => {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const activeSessions = useMemo(
    () => sessions.filter((item) => !item.archivedAt),
    [sessions]
  );
  const newDisabled = Boolean(loading || (session && isEmptySession(session)));
  const newTitle = session && isEmptySession(session)
    ? t(language, 'agent.session.emptyCurrent')
    : t(language, 'agent.session.new');

  const startRename = (item: AgentSession) => {
    setRenamingId(item.id);
    setRenameValue(sessionTitle(item, language));
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const commitRename = (sessionId: string) => {
    const nextTitle = renameValue.trim();
    if (nextTitle) onRename(sessionId, nextTitle);
    cancelRename();
  };

  return (
    <div className="agent-session-bar">
      <button
        className="agent-session-bar__selector"
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={t(language, 'agent.session.switch')}
      >
        <span className="agent-session-bar__eyebrow">
          {t(language, 'agent.session.eyebrow')}
        </span>
        <span className="agent-session-bar__title">{sessionTitle(session, language)}</span>
        <span className="agent-session-bar__chevron">
          {open ? t(language, 'agent.ui.hide') : t(language, 'agent.ui.show')}
        </span>
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
            <span>{t(language, 'agent.session.currentWorkspace')}</span>
            <button type="button" onClick={onNew} disabled={newDisabled} title={newTitle}>
              {t(language, 'agent.session.newButton')}
            </button>
          </div>
          <div className="agent-session-menu__list">
            {activeSessions.length === 0 && (
              <div className="agent-session-menu__empty">
                {t(language, 'agent.session.none')}
              </div>
            )}
            {activeSessions.map((item) => {
              const isRenaming = renamingId === item.id;
              return (
                <div
                  key={item.id}
                  className={`agent-session-menu__item${item.id === session?.id ? ' agent-session-menu__item--active' : ''}`}
                >
                  {isRenaming ? (
                    <div className="agent-session-menu__rename">
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRename(item.id);
                          if (event.key === 'Escape') cancelRename();
                        }}
                        aria-label={t(language, 'agent.session.titleLabel')}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="agent-session-menu__main"
                      onClick={() => {
                        setOpen(false);
                        onActivate(item.id);
                      }}
                    >
                      <span className="agent-session-menu__title">
                        {sessionTitle(item, language)}
                      </span>
                      <span className="agent-session-menu__meta">
                        {formatTime(item.updatedAt)}
                        {item.lastSummary ? ` - ${item.lastSummary}` : ''}
                      </span>
                    </button>
                  )}
                  <div className="agent-session-menu__actions">
                    {isRenaming ? (
                      <>
                        <button type="button" onClick={() => commitRename(item.id)}>
                          {t(language, 'agent.session.save')}
                        </button>
                        <button type="button" onClick={cancelRename}>
                          {t(language, 'agent.session.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => startRename(item)}>
                          {t(language, 'agent.session.rename')}
                        </button>
                        {!isEmptySession(item) && (
                          <button type="button" onClick={() => onArchive(item.id)}>
                            {t(language, 'agent.session.delete')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentSessionSelector;
