import React from 'react';
import type { AgentProject, AgentSession } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { displaySessionTitle, shouldShowSidebarSession } from './DeepCodeShellText';

type DeepCodeSidebarIconName = 'compose' | 'folder' | 'folderPlus' | 'plus' | 'settings';

export interface DeepCodeProjectArchiveGroup {
  key: string;
  title: string;
  sessions: AgentSession[];
  projectId?: string;
}

export function deriveProjectArchiveGroups(
  sessions: AgentSession[],
  projects: AgentProject[]
): DeepCodeProjectArchiveGroup[] {
  return projects.map((project) => ({
    key: project.id,
    title: project.title,
    sessions: sessions
      .filter((session) => session.projectId === project.id)
      .filter(shouldShowSidebarSession)
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)),
    projectId: project.id,
  }));
}

export const DeepCodeSidebarIcon: React.FC<{
  name: DeepCodeSidebarIconName;
  className?: string;
}> = ({ name, className }) => {
  const common = {
    className,
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (name === 'compose') {
    return (
      <svg {...common}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
      </svg>
    );
  }
  if (name === 'folder') {
    return (
      <svg {...common}>
        <path d="M3 6.8A2.8 2.8 0 0 1 5.8 4h4.1l2 2H18a3 3 0 0 1 3 3v7.2A2.8 2.8 0 0 1 18.2 19H5.8A2.8 2.8 0 0 1 3 16.2V6.8z" />
      </svg>
    );
  }
  if (name === 'folderPlus') {
    return (
      <svg {...common}>
        <path d="M3 6.8A2.8 2.8 0 0 1 5.8 4h4.1l2 2H18a3 3 0 0 1 3 3v7.2A2.8 2.8 0 0 1 18.2 19H5.8A2.8 2.8 0 0 1 3 16.2V6.8z" />
        <path d="M16 11v5" />
        <path d="M13.5 13.5h5" />
      </svg>
    );
  }
  if (name === 'plus') {
    return (
      <svg {...common}>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z" />
      <path d="M4.9 14.2a7.8 7.8 0 0 1 0-4.4l-1.7-1.3 2-3.4 2.1.9a8 8 0 0 1 3.8-2.2L11.4 1h4l.3 2.8A8 8 0 0 1 19.5 6l2.1-.9 2 3.4-1.7 1.3a7.8 7.8 0 0 1 0 4.4l1.7 1.3-2 3.4-2.1-.9a8 8 0 0 1-3.8 2.2l-.3 2.8h-4l-.3-2.8A8 8 0 0 1 7.3 18l-2.1.9-2-3.4 1.7-1.3z" />
    </svg>
  );
};

interface DeepCodeSidebarProps {
  language: UiLanguage;
  projectArchiveGroups: DeepCodeProjectArchiveGroup[];
  projectRecords: AgentProject[];
  visibleSessions: AgentSession[];
  collapsedProjectIds: ReadonlySet<string>;
  activeProjectId: string | null;
  draftTargetProjectId: string | null;
  highlightedSessionId: string | null;
  pendingAction: string | null;
  projectCreateMenuOpen: boolean;
  onCreatePrimarySession: () => void;
  onOpenProjectCreateMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onToggleProject: (projectId: string) => void;
  onCreateProjectSession: (projectId: string, actionKey: string) => void;
  onActivateSession: (session: AgentSession, projectId: string | null, actionKey: string) => void;
  onOpenProjectContextMenu: (event: React.MouseEvent<HTMLElement>, project: AgentProject) => void;
  onOpenSessionContextMenu: (event: React.MouseEvent<HTMLElement>, session: AgentSession) => void;
  onCreateUnboundSession: () => void;
  onOpenSettings: () => void;
}

const DeepCodeSidebar: React.FC<DeepCodeSidebarProps> = ({
  language,
  projectArchiveGroups,
  projectRecords,
  visibleSessions,
  collapsedProjectIds,
  activeProjectId,
  draftTargetProjectId,
  highlightedSessionId,
  pendingAction,
  projectCreateMenuOpen,
  onCreatePrimarySession,
  onOpenProjectCreateMenu,
  onToggleProject,
  onCreateProjectSession,
  onActivateSession,
  onOpenProjectContextMenu,
  onOpenSessionContextMenu,
  onCreateUnboundSession,
  onOpenSettings,
}) => (
  <aside className="deepcode-gui-left-rail">
    <div className="deepcode-gui-sidebar-actions">
      <button
        type="button"
        className="deepcode-gui-sidebar-action deepcode-gui-sidebar-action--primary"
        onClick={onCreatePrimarySession}
        disabled={pendingAction === 'create:normal:primary'}
      >
        <DeepCodeSidebarIcon name="compose" className="deepcode-gui-sidebar-icon" />
        <span>{t(language, 'deepcodeGui.nav.newChat')}</span>
      </button>
    </div>

    <section className="deepcode-gui-sidebar-section">
      <div className="deepcode-gui-sidebar-section__heading deepcode-gui-sidebar-section__heading--project">
        <div className="deepcode-gui-sidebar-section__label">{t(language, 'deepcodeGui.sidebar.project')}</div>
        <button
          type="button"
          className="deepcode-gui-sidebar-text-action"
          onClick={onOpenProjectCreateMenu}
          aria-haspopup="menu"
          aria-expanded={projectCreateMenuOpen}
        >
          {t(language, 'deepcodeGui.project.new')}
        </button>
      </div>
      {projectArchiveGroups.length === 0 ? (
        <div className="deepcode-gui-sidebar-empty">{t(language, 'deepcodeGui.project.empty')}</div>
      ) : (
        <div className="deepcode-gui-project-archive-list">
          {projectArchiveGroups.slice(0, 6).map((group, groupIndex) => {
            const projectRecord = group.projectId
              ? projectRecords.find((project) => project.id === group.projectId) ?? null
              : null;
            const projectCollapsed = Boolean(group.projectId && collapsedProjectIds.has(group.projectId));
            const projectIsCurrent = Boolean(
              group.projectId
              && (group.projectId === activeProjectId || group.projectId === draftTargetProjectId)
            );
            const createActionKey = group.projectId ? `create:project:${group.projectId}` : '';
            return (
              <div
                key={group.key}
                className={`deepcode-gui-project-archive-group${projectIsCurrent ? ' deepcode-gui-project-archive-group--current' : ''}`}
              >
                <div
                  className="deepcode-gui-project-archive-group__title"
                  onContextMenu={(event) => {
                    if (projectRecord) onOpenProjectContextMenu(event, projectRecord);
                  }}
                >
                  <button
                    type="button"
                    className="deepcode-gui-project-archive-group__select"
                    onClick={() => group.projectId && onToggleProject(group.projectId)}
                    onContextMenu={(event) => {
                      if (projectRecord) onOpenProjectContextMenu(event, projectRecord);
                    }}
                    disabled={!group.projectId}
                    aria-expanded={!projectCollapsed}
                    title={group.title}
                  >
                    <DeepCodeSidebarIcon name="folder" className="deepcode-gui-sidebar-icon" />
                    <span>{group.title}</span>
                  </button>
                  {group.projectId && (
                    <div className="deepcode-gui-project-archive-group__actions">
                      <button
                        type="button"
                        className="deepcode-gui-project-archive-group__compose"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCreateProjectSession(group.projectId!, createActionKey);
                        }}
                        disabled={pendingAction === createActionKey}
                        aria-label={t(language, 'deepcodeGui.project.newChat')}
                        title={t(language, 'deepcodeGui.project.newChat')}
                      >
                        <DeepCodeSidebarIcon name="compose" />
                      </button>
                    </div>
                  )}
                </div>
                {!projectCollapsed && (
                  <div className="deepcode-gui-project-archive-group__sessions">
                    {group.sessions.slice(0, 4).map((session, itemIndex) => {
                      const shortcutIndex = groupIndex + itemIndex + 1;
                      const actionKey = `activate:project:${session.id}`;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          className={session.id === highlightedSessionId ? 'active' : ''}
                          onClick={() => onActivateSession(session, group.projectId ?? null, actionKey)}
                          onContextMenu={(event) => onOpenSessionContextMenu(event, session)}
                          disabled={pendingAction === actionKey}
                          title={session.title || session.id}
                        >
                          <span>{displaySessionTitle(language, session.title)}</span>
                          {shortcutIndex <= 9 && <kbd>⌘{shortcutIndex}</kbd>}
                        </button>
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
          onClick={onCreateUnboundSession}
          disabled={pendingAction === 'create:normal:nested'}
          aria-label={t(language, 'deepcodeGui.nav.newChat')}
          title={t(language, 'deepcodeGui.nav.newChat')}
        >
          <DeepCodeSidebarIcon name="compose" />
        </button>
      </div>
      {visibleSessions.length > 0 && (
        <div className="deepcode-gui-session-list">
          {visibleSessions.slice(0, 8).map((session) => {
            const actionKey = `activate:chat:${session.id}`;
            return (
              <button
                key={session.id}
                type="button"
                className={session.id === highlightedSessionId ? 'active' : ''}
                onClick={() => onActivateSession(session, null, actionKey)}
                onContextMenu={(event) => onOpenSessionContextMenu(event, session)}
                disabled={pendingAction === actionKey}
                title={session.title || session.id}
              >
                <span>{displaySessionTitle(language, session.title)}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>

    <div className="deepcode-gui-sidebar-spacer" />
    <button type="button" className="deepcode-gui-sidebar-settings" onClick={onOpenSettings}>
      <span className="deepcode-gui-sidebar-settings__icon">
        <DeepCodeSidebarIcon name="settings" />
      </span>
      <span>{t(language, 'settings.title')}</span>
    </button>
  </aside>
);

export default DeepCodeSidebar;
