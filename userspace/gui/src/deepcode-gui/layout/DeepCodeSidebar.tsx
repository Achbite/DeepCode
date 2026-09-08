import React, { useEffect, useMemo, useState } from 'react';
import type {
  ConversationProject,
  ConversationSessionSummary,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { usesNativeWindowChrome } from '../../services/hostTarget';
import DeepCodeBrand from './DeepCodeBrand';
import DeepCodeShellIcon from './DeepCodeShellIcon';

interface DeepCodeSidebarProps {
  language: UiLanguage;
  projects: ConversationProject[];
  sessions: ConversationSessionSummary[];
  collapsedProjectIds: ReadonlySet<string>;
  activeSessionId: string | null;
  draftProjectId: string | null;
  busy: boolean;
  projectCreateMenuOpen: boolean;
  onCreatePrimarySession: () => void;
  onOpenProjectCreateMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onToggleProject: (projectId: string) => void;
  onCreateProjectSession: (project: ConversationProject) => void;
  onActivateSession: (session: ConversationSessionSummary) => void;
  onOpenProjectContextMenu: (
    event: React.MouseEvent<HTMLElement>,
    project: ConversationProject,
  ) => void;
  onOpenSessionContextMenu: (
    event: React.MouseEvent<HTMLElement>,
    session: ConversationSessionSummary,
  ) => void;
  onOpenSettings: () => void;
}

const DeepCodeSidebar: React.FC<DeepCodeSidebarProps> = ({
  language,
  projects,
  sessions,
  collapsedProjectIds,
  activeSessionId,
  draftProjectId,
  busy,
  projectCreateMenuOpen,
  onCreatePrimarySession,
  onOpenProjectCreateMenu,
  onToggleProject,
  onCreateProjectSession,
  onActivateSession,
  onOpenProjectContextMenu,
  onOpenSessionContextMenu,
  onOpenSettings,
}) => {
  const standalone = sessions.filter((session) => !session.projectId);
  const [commandPressed, setCommandPressed] = useState(false);
  const shortcutSessions = useMemo(() => [
    ...projects.flatMap((project) => (
      collapsedProjectIds.has(project.id)
        ? []
        : sessions.filter((session) => session.projectId === project.id)
    )),
    ...sessions.filter((session) => !session.projectId),
  ].slice(0, 9), [collapsedProjectIds, projects, sessions]);
  const shortcutBySessionId = useMemo(
    () => new Map(shortcutSessions.map((session, index) => [session.id, index + 1])),
    [shortcutSessions],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.metaKey) setCommandPressed(true);
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || busy) return;
      const match = /^Digit([1-9])$/u.exec(event.code);
      if (!match) return;
      const session = shortcutSessions[Number(match[1]) - 1];
      if (!session) return;
      event.preventDefault();
      onActivateSession(session);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || !event.metaKey) setCommandPressed(false);
    };
    const reset = () => setCommandPressed(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
    };
  }, [busy, onActivateSession, shortcutSessions]);

  return (
    <aside className="deepcode-gui-left-rail">
      {usesNativeWindowChrome() && (
        <div className="deepcode-gui-sidebar-brand">
          <DeepCodeBrand />
        </div>
      )}
      <div className="deepcode-gui-sidebar-actions">
        <button
          type="button"
          className="deepcode-gui-sidebar-action deepcode-gui-sidebar-action--primary"
          onClick={onCreatePrimarySession}
          disabled={busy}
        >
          <DeepCodeShellIcon name="compose" className="deepcode-gui-sidebar-icon" />
          <span>{t(language, 'deepcodeGui.nav.newChat')}</span>
        </button>
      </div>

      <section className="deepcode-gui-sidebar-section">
        <div className="deepcode-gui-sidebar-section__heading deepcode-gui-sidebar-section__heading--project">
          <div className="deepcode-gui-sidebar-section__label">
            {t(language, 'deepcodeGui.sidebar.project')}
          </div>
          <button
            type="button"
            className="deepcode-gui-sidebar-text-action deepcode-gui-sidebar-reveal-action"
            onClick={onOpenProjectCreateMenu}
            onPointerDown={(event) => event.stopPropagation()}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={projectCreateMenuOpen}
            aria-controls="deepcode-project-create-menu"
            aria-label={t(language, 'deepcodeGui.project.new')}
            title={t(language, 'deepcodeGui.project.new')}
          >
            <DeepCodeShellIcon name="plus" />
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="deepcode-gui-sidebar-empty">
            {t(language, 'deepcodeGui.project.empty')}
          </div>
        ) : (
          <div className="deepcode-gui-project-archive-list">
            {projects.map((project) => {
              const collapsed = collapsedProjectIds.has(project.id);
              const projectSessions = sessions.filter((session) => session.projectId === project.id);
              const current = draftProjectId === project.id
                || projectSessions.some((session) => session.id === activeSessionId);
              return (
                <div
                  key={project.id}
                  className={`deepcode-gui-project-archive-group${current ? ' deepcode-gui-project-archive-group--current' : ''}`}
                >
                  <div
                    className="deepcode-gui-project-archive-group__title"
                    onContextMenu={(event) => onOpenProjectContextMenu(event, project)}
                  >
                    <button
                      type="button"
                      className="deepcode-gui-project-archive-group__select"
                      onClick={() => onToggleProject(project.id)}
                      aria-expanded={!collapsed}
                      title={project.title}
                    >
                      <span className={`deepcode-gui-project-chevron${collapsed ? '' : ' deepcode-gui-project-chevron--expanded'}`}>
                        <DeepCodeShellIcon name="chevronRight" />
                      </span>
                      <DeepCodeShellIcon name="folder" className="deepcode-gui-sidebar-icon" />
                      <span>{project.title}</span>
                    </button>
                    <div className="deepcode-gui-project-archive-group__actions">
                      <button
                        type="button"
                        className="deepcode-gui-project-archive-group__compose"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCreateProjectSession(project);
                        }}
                        disabled={busy}
                        aria-label={t(language, 'deepcodeGui.project.newChat')}
                        title={t(language, 'deepcodeGui.project.newChat')}
                      >
                        <DeepCodeShellIcon name="compose" />
                      </button>
                      <button
                        type="button"
                        className="deepcode-gui-project-archive-group__menu"
                        onClick={(event) => onOpenProjectContextMenu(event, project)}
                        aria-label={t(language, 'deepcodeGui.project.actions')}
                        title={t(language, 'deepcodeGui.project.actions')}
                      >
                        <DeepCodeShellIcon name="more" />
                      </button>
                    </div>
                  </div>
                  {!collapsed && (
                    <div className="deepcode-gui-project-archive-group__sessions">
                      {projectSessions.length === 0 ? (
                        <div className="deepcode-gui-sidebar-empty deepcode-gui-sidebar-empty--nested">
                          {t(language, 'deepcodeGui.sidebar.noChats')}
                        </div>
                      ) : projectSessions.map((session) => {
                        const shortcut = shortcutBySessionId.get(session.id);
                        return (
                          <div
                            className={`deepcode-gui-session-row${session.id === activeSessionId ? ' deepcode-gui-session-row--active' : ''}`}
                            key={session.id}
                          >
                            <button
                              type="button"
                              className={session.id === activeSessionId ? 'active' : ''}
                              onClick={() => onActivateSession(session)}
                              onContextMenu={(event) => onOpenSessionContextMenu(event, session)}
                              disabled={busy}
                              title={session.title || session.id}
                              aria-keyshortcuts={shortcut ? `Meta+${shortcut}` : undefined}
                            >
                              <span>{sessionTitle(session, language)}</span>
                              {commandPressed && shortcut && <kbd>⌘{shortcut}</kbd>}
                            </button>
                            <button
                              type="button"
                              className="deepcode-gui-session-row__menu"
                              onClick={(event) => onOpenSessionContextMenu(event, session)}
                              aria-label={t(language, 'deepcodeGui.session.actions')}
                            >
                              <DeepCodeShellIcon name="more" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="deepcode-gui-sidebar-section__heading">
          <div className="deepcode-gui-sidebar-section__label deepcode-gui-sidebar-section__label--nested">
            {t(language, 'deepcodeGui.sidebar.chats')}
          </div>
          <button
            type="button"
            className="deepcode-gui-sidebar-new-chat"
            onClick={onCreatePrimarySession}
            disabled={busy}
            aria-label={t(language, 'deepcodeGui.nav.newChat')}
            title={t(language, 'deepcodeGui.nav.newChat')}
          >
            <DeepCodeShellIcon name="compose" />
          </button>
        </div>
        {standalone.length === 0 ? (
          <div className="deepcode-gui-sidebar-empty">
            {t(language, 'deepcodeGui.sidebar.noChats')}
          </div>
        ) : (
          <div className="deepcode-gui-session-list">
            {standalone.map((session) => {
              const shortcut = shortcutBySessionId.get(session.id);
              return (
                <div
                  className={`deepcode-gui-session-row${session.id === activeSessionId ? ' deepcode-gui-session-row--active' : ''}`}
                  key={session.id}
                >
                  <button
                    type="button"
                    className={session.id === activeSessionId ? 'active' : ''}
                    onClick={() => onActivateSession(session)}
                    onContextMenu={(event) => onOpenSessionContextMenu(event, session)}
                    disabled={busy}
                    title={session.title || session.id}
                    aria-keyshortcuts={shortcut ? `Meta+${shortcut}` : undefined}
                  >
                    <span>{sessionTitle(session, language)}</span>
                    {commandPressed && shortcut && <kbd>⌘{shortcut}</kbd>}
                  </button>
                  <button
                    type="button"
                    className="deepcode-gui-session-row__menu"
                    onClick={(event) => onOpenSessionContextMenu(event, session)}
                    aria-label={t(language, 'deepcodeGui.session.actions')}
                  >
                    <DeepCodeShellIcon name="more" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="deepcode-gui-sidebar-spacer" />
      <button type="button" className="deepcode-gui-sidebar-settings" onClick={onOpenSettings}>
        <span className="deepcode-gui-sidebar-settings__icon">
          <DeepCodeShellIcon name="settings" />
        </span>
        <span>{t(language, 'settings.title')}</span>
      </button>
    </aside>
  );
};

function sessionTitle(session: ConversationSessionSummary, language: UiLanguage): string {
  return session.title.trim() || t(language, 'agent.session.newTitle');
}

export default DeepCodeSidebar;
