import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { AgentEvent } from '@deepcode/protocol';
import WindowControls from '../../components/window-controls/WindowControls';
import { normalizeUiLanguage, t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useUiStore } from '../../state/uiStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import CodexAgentPanel from '../panel/CodexAgentPanel';

interface CodexWorkbenchLayoutProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  lastHeartbeatAt?: string;
}

const WorkspaceOpenDialog = lazy(() => import('../../components/workspace-open-dialog/WorkspaceOpenDialog'));
const CodeWorkspaceChoiceDialog = lazy(() => import('../../components/code-workspace-choice-dialog/CodeWorkspaceChoiceDialog'));
const SettingsCenter = lazy(() => import('../../components/settings-center/SettingsCenter'));

interface CodexTaskItem {
  id: string;
  title: string;
  summary: string;
  status: string;
}

type CodexSidebarIconName = 'compose' | 'folder' | 'plus' | 'settings';

const CodexSidebarIcon: React.FC<{ name: CodexSidebarIconName; className?: string }> = ({
  name,
  className,
}) => {
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

function basename(path?: string | null): string {
  if (!path) return '';
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function statusLabel(language: UiLanguage, value: string): string {
  const translated = t(language, `deepcodeGui.status.${value}`);
  return translated.startsWith('deepcodeGui.status.') ? value : translated;
}

function displaySessionTitle(language: UiLanguage, title?: string): string {
  const value = title?.trim();
  if (!value || value === 'New Agent Session' || value === '新 Agent 会话') {
    return t(language, 'agent.session.newTitle');
  }
  return value;
}

function hasCustomSessionTitle(title?: string): boolean {
  const value = title?.trim();
  return Boolean(value && value !== 'New Agent Session' && value !== '新 Agent 会话');
}

function eventText(event: AgentEvent): string {
  if (typeof event.payload === 'string') return event.payload;
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return '';
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['summary', 'message', 'content', 'details', 'toolName', 'stage']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function taskTitle(language: UiLanguage, event: AgentEvent): string {
  if (event.kind === 'plan_card' || event.kind === 'plan_review') return t(language, 'deepcodeGui.tasks.plan');
  if (event.kind === 'review_summary') return t(language, 'deepcodeGui.tasks.review');
  if (event.kind === 'tool_call' || event.kind === 'tool_result') return t(language, 'deepcodeGui.tasks.tool');
  if (event.kind === 'permission_request' || event.kind === 'permission_result') return t(language, 'deepcodeGui.tasks.permission');
  if (event.kind === 'workflow_stage' || event.kind === 'workflow_decision') return t(language, 'deepcodeGui.tasks.workflow');
  if (event.kind === 'error') return t(language, 'deepcodeGui.tasks.error');
  return t(language, 'deepcodeGui.tasks.item');
}

function taskStatus(event: AgentEvent): string {
  if (event.kind === 'error') return 'failed';
  if (event.kind === 'permission_request' || event.kind === 'plan_review') return 'waiting';
  if (event.kind === 'tool_call' || event.kind === 'workflow_stage') return 'running';
  return 'completed';
}

function deriveTaskItems(events: AgentEvent[], language: UiLanguage, loading: boolean): CodexTaskItem[] {
  const taskEvents = events
    .filter((event) => event.kind !== 'user_msg' && event.kind !== 'assistant_msg')
    .slice(-8);

  const items = taskEvents.map((event) => ({
    id: event.id,
    title: taskTitle(language, event),
    summary: eventText(event) || event.kind,
    status: taskStatus(event),
  }));

  if (loading && items.length === 0) {
    return [
      {
        id: 'runtime-preparing',
        title: t(language, 'deepcodeGui.tasks.running'),
        summary: t(language, 'deepcodeGui.tasks.runningSummary'),
        status: 'running',
      },
    ];
  }

  return items;
}

const CodexWorkbenchLayout: React.FC<CodexWorkbenchLayoutProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  lastHeartbeatAt,
}) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualSessionIds, setManualSessionIds] = useState<Set<string>>(() => new Set());
  const workspace = useWorkspaceStore((s) => s.current);
  const activeFolderId = useWorkspaceStore((s) => s.activeFolderId);
  const workspaceLoading = useWorkspaceStore((s) => s.loading);
  const workspaceError = useWorkspaceStore((s) => s.lastError);
  const showWorkspaceOpenDialog = useUiStore((s) => s.showWorkspaceOpenDialog);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const activeSession = useAgentSessionStore((s) => s.session);
  const loadingSession = useAgentSessionStore((s) => s.loading);
  const events = useAgentSessionStore((s) => s.events);
  const createNewSession = useAgentSessionStore((s) => s.createNewSession);
  const activateSession = useAgentSessionStore((s) => s.activateSession);
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );

  useEffect(() => {
    if (typeof performance === 'undefined') return;
    performance.mark('deepcode-gui:workbench-ready');
  }, []);

  const activeFolder = useMemo(() => {
    if (!workspace || workspace.folders.length === 0) return null;
    return workspace.folders.find((folder) => folder.id === activeFolderId) ?? workspace.folders[0];
  }, [activeFolderId, workspace]);

  const workspaceName = basename(activeFolder?.absolutePath ?? workspace?.sourcePath)
    || t(language, 'deepcodeGui.workspace.none');
  const lastHeartbeatText = lastHeartbeatAt
    ? new Date(lastHeartbeatAt).toLocaleTimeString()
    : t(language, 'deepcodeGui.status.pending');
  const taskItems = useMemo(
    () => deriveTaskItems(events, language, loadingSession),
    [events, language, loadingSession]
  );
  const isHome = events.length === 0 && !loadingSession;
  const visibleSessions = useMemo(
    () => sessions.filter((item) =>
      (item.eventCount ?? 0) > 0 ||
      manualSessionIds.has(item.id) ||
      hasCustomSessionTitle(item.title) ||
      (item.id === activeSession?.id && events.length > 0)
    ),
    [activeSession?.id, events.length, manualSessionIds, sessions]
  );

  const handleCreateSession = async () => {
    await createNewSession();
    const nextSession = useAgentSessionStore.getState().session;
    if (nextSession?.id) {
      setManualSessionIds((current) => new Set(current).add(nextSession.id));
    }
  };

  return (
    <div className="codex-workbench">
      <header className="codex-titlebar" data-tauri-drag-region>
        <div className="codex-titlebar__brand">
          <span className="codex-titlebar__mark">DC</span>
          <span>DeepCode-GUI</span>
        </div>
        <div className="codex-titlebar__status">
          <span className={`codex-status-pill codex-status-pill--${apiStatus}`}>API {statusLabel(language, apiStatus)}</span>
        </div>
        <WindowControls language={language} />
      </header>

      <div className={`codex-shell ${isHome ? 'codex-shell--home' : ''}`}>
        <aside className="codex-left-rail">
          <div className="codex-sidebar-actions">
            <button
              type="button"
              className="codex-sidebar-action codex-sidebar-action--primary"
              onClick={() => void handleCreateSession()}
              disabled={loadingSession}
            >
              <CodexSidebarIcon name="compose" className="codex-sidebar-icon" />
              <span>{t(language, 'deepcodeGui.nav.newChat')}</span>
            </button>
          </div>

          <section className="codex-sidebar-section">
            <div className="codex-sidebar-section__label">{t(language, 'deepcodeGui.sidebar.project')}</div>
            <button
              type="button"
              className="codex-project-row"
              onClick={showWorkspaceOpenDialog}
              disabled={workspaceLoading}
              title={activeFolder?.absolutePath ?? workspace?.sourcePath ?? undefined}
            >
              <CodexSidebarIcon name="folder" className="codex-sidebar-icon" />
              <span className="codex-project-row__body">
                <span>{workspaceName}</span>
                <small>{workspaceLoading ? statusLabel(language, 'running') : t(language, 'deepcodeGui.workspace.open')}</small>
              </span>
            </button>
            {workspaceError && <div className="codex-sidebar-error">{workspaceError}</div>}

            <div className="codex-sidebar-section__heading">
              <div className="codex-sidebar-section__label codex-sidebar-section__label--nested">
                {t(language, 'deepcodeGui.sidebar.chats')}
              </div>
              <button
                type="button"
                className="codex-sidebar-new-chat"
                onClick={() => void handleCreateSession()}
                disabled={loadingSession}
                aria-label={t(language, 'deepcodeGui.nav.newChat')}
                title={t(language, 'deepcodeGui.nav.newChat')}
              >
                <CodexSidebarIcon name="plus" />
              </button>
            </div>
            {visibleSessions.length > 0 && (
              <div className="codex-session-list">
                {visibleSessions.slice(0, 8).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === activeSession?.id ? 'active' : ''}
                    onClick={() => void activateSession(item.id)}
                    disabled={loadingSession}
                    title={item.title || item.id}
                  >
                    <span>{displaySessionTitle(language, item.title)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <div className="codex-sidebar-spacer" />
          <button
            type="button"
            className="codex-sidebar-settings"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="codex-sidebar-settings__icon">
              <CodexSidebarIcon name="settings" />
            </span>
            <span>{t(language, 'settings.title')}</span>
          </button>
        </aside>

        <main className="codex-session-main">
          <CodexAgentPanel language={language} />
        </main>

        <aside className="codex-context-panel">
          <section className="codex-task-list-card">
            <div className="codex-task-list-card__title">{t(language, 'deepcodeGui.tasks.title')}</div>
            {taskItems.length === 0 ? (
              <div className="codex-task-list-card__empty">{t(language, 'deepcodeGui.tasks.empty')}</div>
            ) : (
              <div className="codex-task-list">
                {taskItems.map((item) => (
                  <div key={item.id} className={`codex-task-item codex-task-item--${item.status}`}>
                    <span className="codex-task-item__dot" />
                    <div>
                      <div className="codex-task-item__title">{item.title}</div>
                      <div className="codex-task-item__summary">{item.summary}</div>
                    </div>
                    <strong>{statusLabel(language, item.status)}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      <Suspense fallback={null}>
        {settingsOpen && (
          <div
            className="codex-settings-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={t(language, 'settings.title')}
            onMouseDown={() => setSettingsOpen(false)}
          >
            <section
              className="codex-settings-sheet"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="codex-settings-sheet__header">
                <div>
                  <h2>{t(language, 'settings.title')}</h2>
                  <span>{workspaceName}</span>
                </div>
                <button
                  type="button"
                  aria-label={t(language, 'deepcodeGui.settings.close')}
                  onClick={() => setSettingsOpen(false)}
                >
                  x
                </button>
              </header>
              <div className="codex-settings-sheet__runtime">
                <span>API {statusLabel(language, apiStatus)}</span>
                <span>WS {statusLabel(language, wsStatus)}</span>
                <span>{t(language, 'deepcodeGui.progress.heartbeat')} {lastHeartbeatText}</span>
                {serverVersion && <span>{serverVersion}</span>}
              </div>
              <div className="codex-settings-sheet__body">
                <SettingsCenter
                  apiStatus={apiStatus}
                  wsStatus={wsStatus}
                  serverVersion={serverVersion}
                />
              </div>
            </section>
          </div>
        )}
        <WorkspaceOpenDialog />
        <CodeWorkspaceChoiceDialog />
      </Suspense>
    </div>
  );
};

export default CodexWorkbenchLayout;
