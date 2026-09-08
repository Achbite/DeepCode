import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type {
  ConversationProject,
  ConversationSessionSummary,
  SessionProjection,
} from '@deepcode/protocol';
import { normalizeUiLanguage, t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { inputCacheMetric } from '../../utils/providerUsage';
import DeepCodeConversationShell from './DeepCodeConversationShell';
import DeepCodeSidebar from './DeepCodeSidebar';
import DeepCodeTaskPanel from './DeepCodeTaskPanel';
import DeepCodeTitlebar from './DeepCodeTitlebar';
import DeepCodeShellIcon from './DeepCodeShellIcon';
import ProjectFolderDialog from './ProjectFolderDialog';
import '../styles/deepcodeShell.css';

interface DeepCodeWorkbenchLayoutProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  lastHeartbeatAt?: string;
  kernelStartBusy?: boolean;
  kernelStartMessage?: string | null;
  onRetryKernelStart?: () => void | Promise<void>;
}

const SettingsCenter = lazy(
  () => import('../../components/settings-center/SettingsCenter'),
);

type PositionedMenu<T> = { value: T; x: number; y: number };
type FolderAction =
  | { kind: 'create' }
  | {
      kind: 'bind';
      project: ConversationProject;
      startAfterBinding: boolean;
      reopenManager: boolean;
    };
type TextDialog =
  | { kind: 'createProject'; title: string; value: string }
  | { kind: 'renameProject'; title: string; value: string; project: ConversationProject }
  | { kind: 'renameSession'; title: string; value: string; session: ConversationSessionSummary };
type ManagedWorkspace = { workspaceId: string; displayName: string; canonicalRoot: string };

const DeepCodeWorkbenchLayout: React.FC<DeepCodeWorkbenchLayoutProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  kernelStartBusy = false,
  kernelStartMessage,
  onRetryKernelStart,
}) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const navigationDensity = effectiveSettings['gui.navigationDensity'] === 'compact'
    ? 'compact'
    : 'comfortable';
  const showContextRail = effectiveSettings['gui.showContextRail'] !== false;
  const projection = useLocalAgentStore((state) => state.projection);
  const profiles = useLocalAgentStore((state) => state.profiles);
  const activeSessionId = useLocalAgentStore((state) => state.sessionId);
  const draftProjectId = useLocalAgentStore((state) => state.draftProjectId);
  const catalog = useLocalAgentStore((state) => state.catalog);
  const loading = useLocalAgentStore((state) => state.loading);
  const submitting = useLocalAgentStore((state) => state.submitting);
  const catalogBusy = useLocalAgentStore((state) => state.catalogBusy);
  const startNewSession = useLocalAgentStore((state) => state.startNewSession);
  const activateSession = useLocalAgentStore((state) => state.activateSession);
  const createProject = useLocalAgentStore((state) => state.createProject);
  const updateProject = useLocalAgentStore((state) => state.updateProject);
  const addProjectWorkspace = useLocalAgentStore((state) => state.addProjectWorkspace);
  const removeProjectWorkspace = useLocalAgentStore((state) => state.removeProjectWorkspace);
  const getProjectWorkspacePaths = useLocalAgentStore((state) => state.getProjectWorkspacePaths);
  const deleteProject = useLocalAgentStore((state) => state.deleteProject);
  const updateSession = useLocalAgentStore((state) => state.updateSession);
  const deleteSession = useLocalAgentStore((state) => state.deleteSession);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const [projectCreateMenu, setProjectCreateMenu] = useState<{ x: number; y: number } | null>(null);
  const [projectMenu, setProjectMenu] = useState<PositionedMenu<ConversationProject> | null>(null);
  const [sessionMenu, setSessionMenu] = useState<PositionedMenu<ConversationSessionSummary> | null>(null);
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null);
  const [textDialog, setTextDialog] = useState<TextDialog | null>(null);
  const [deleteSessionCandidate, setDeleteSessionCandidate] = useState<ConversationSessionSummary | null>(null);
  const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
  const [workspaceManager, setWorkspaceManager] = useState<{
    project: ConversationProject;
    records: ManagedWorkspace[];
    loading: boolean;
    error: string | null;
  } | null>(null);
  const busy = loading || submitting || catalogBusy;
  const collapsedSet = useMemo(() => new Set(collapsedProjectIds), [collapsedProjectIds]);

  useEffect(() => {
    if (!projectCreateMenu && !projectMenu && !sessionMenu) return;
    const close = () => {
      setProjectCreateMenu(null);
      setProjectMenu(null);
      setSessionMenu(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [projectCreateMenu, projectMenu, sessionMenu]);

  const createPrimarySession = () => {
    startNewSession(null);
  };

  const createProjectSession = (project: ConversationProject) => {
    startNewSession(project.id);
  };

  const openProjectCreateMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setSessionMenu(null);
    setProjectMenu(null);
    setProjectCreateMenu((current) => current ? null : ({
      x: Math.max(8, Math.min(rect.right - 218, window.innerWidth - 226)),
      y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 110)),
    }));
  };

  const openProjectMenu = (
    event: React.MouseEvent<HTMLElement>,
    project: ConversationProject,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setProjectCreateMenu(null);
    setSessionMenu(null);
    setProjectMenu(positioned(event, project, 204, 160));
  };

  const openSessionMenu = (
    event: React.MouseEvent<HTMLElement>,
    session: ConversationSessionSummary,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setProjectCreateMenu(null);
    setProjectMenu(null);
    const height = 166 + Math.min(catalog.projects.length, 6) * 32;
    setSessionMenu(positioned(event, session, 218, height));
  };

  const submitTextDialog = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!textDialog) return;
    const value = textDialog.value.trim();
    if (!value) return;
    const dialog = textDialog;
    setTextDialog(null);
    if (dialog.kind === 'createProject') {
      await createProject(value);
    } else if (dialog.kind === 'renameProject') {
      await updateProject(dialog.project.id, { title: value });
    } else {
      await updateSession(dialog.session.id, { title: value });
    }
  };

  const selectProjectFolder = async (folderPath: string) => {
    const action = folderAction;
    setFolderAction(null);
    if (!action) return;
    if (action.kind === 'create') {
      const title = basename(folderPath) || t(language, 'deepcodeGui.project.defaultName');
      const existingIds = new Set(
        useLocalAgentStore.getState().catalog.projects.map((project) => project.id),
      );
      await createProject(title, [folderPath]);
      const created = useLocalAgentStore.getState().catalog.projects.find((project) => (
        !existingIds.has(project.id)
      ));
      if (created) startNewSession(created.id);
      return;
    }
    await addProjectWorkspace(action.project.id, folderPath);
    if (action.reopenManager) await openWorkspaceManager(action.project);
    if (action.startAfterBinding) startNewSession(action.project.id);
  };

  const openWorkspaceManager = async (project: ConversationProject) => {
    setProjectMenu(null);
    setWorkspaceManager({ project, records: [], loading: true, error: null });
    try {
      const records = await getProjectWorkspacePaths(project.id);
      setWorkspaceManager((current) => current?.project.id === project.id
        ? { ...current, records, loading: false }
        : current);
    } catch (error) {
      setWorkspaceManager((current) => current?.project.id === project.id
        ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error) }
        : current);
    }
  };

  const removeManagedWorkspace = async (workspaceId: string) => {
    if (!workspaceManager) return;
    const project = workspaceManager.project;
    setWorkspaceManager({ ...workspaceManager, loading: true, error: null });
    try {
      await removeProjectWorkspace(project.id, workspaceId);
      await openWorkspaceManager(project);
    } catch (error) {
      setWorkspaceManager((current) => current?.project.id === project.id
        ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error) }
        : current);
    }
  };

  const requestDeleteSession = (session: ConversationSessionSummary) => {
    setSessionMenu(null);
    setDeleteSessionError(null);
    setDeleteSessionCandidate(session);
  };

  const confirmDeleteSession = async () => {
    if (!deleteSessionCandidate) return;
    setDeleteSessionError(null);
    try {
      await deleteSession(deleteSessionCandidate.id);
      setDeleteSessionCandidate(null);
    } catch (error) {
      setDeleteSessionError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmDeleteProject = async (project: ConversationProject) => {
    setProjectMenu(null);
    const confirmed = window.confirm(
      t(language, 'deepcodeGui.project.deleteConfirm', { title: project.title }),
    );
    if (confirmed) await deleteProject(project.id);
  };

  return (
    <div className="deepcode-gui-workbench">
      <DeepCodeTitlebar
        language={language}
        apiStatus={apiStatus}
        agentReady={apiStatus === 'connected' && profiles.length > 0}
        cacheHitSummary={cacheHitSummary(projection, language)}
        kernelStartBusy={kernelStartBusy}
        kernelStartMessage={kernelStartMessage}
        onRetryKernelStart={onRetryKernelStart}
      />

      <div
        className={`deepcode-gui-shell${showContextRail ? '' : ' deepcode-gui-shell--no-context'}`}
        data-navigation-density={navigationDensity}
      >
        <DeepCodeSidebar
          language={language}
          projects={catalog.projects}
          sessions={catalog.sessions}
          collapsedProjectIds={collapsedSet}
          activeSessionId={activeSessionId}
          draftProjectId={draftProjectId}
          busy={busy}
          projectCreateMenuOpen={Boolean(projectCreateMenu)}
          onCreatePrimarySession={createPrimarySession}
          onOpenProjectCreateMenu={openProjectCreateMenu}
          onToggleProject={(projectId) => setCollapsedProjectIds((current) => (
            current.includes(projectId)
              ? current.filter((id) => id !== projectId)
              : [...current, projectId]
          ))}
          onCreateProjectSession={createProjectSession}
          onActivateSession={(session) => void activateSession(session.id)}
          onOpenProjectContextMenu={openProjectMenu}
          onOpenSessionContextMenu={openSessionMenu}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <DeepCodeConversationShell />
        {showContextRail && <DeepCodeTaskPanel language={language} projection={projection} />}
      </div>

      {projectCreateMenu && (
        <div
          id="deepcode-project-create-menu"
          className="deepcode-gui-project-create-menu"
          style={{ left: projectCreateMenu.x, top: projectCreateMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectCreateMenu(null);
              setTextDialog({
                kind: 'createProject',
                title: t(language, 'deepcodeGui.project.newBlank'),
                value: t(language, 'deepcodeGui.project.defaultName'),
              });
            }}
          >
            <span className="deepcode-gui-menu-icon">＋</span>
            <span>{t(language, 'deepcodeGui.project.newBlank')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectCreateMenu(null);
              setFolderAction({ kind: 'create' });
            }}
          >
            <DeepCodeShellIcon name="folder" />
            <span>{t(language, 'deepcodeGui.project.fromFolder')}</span>
          </button>
        </div>
      )}

      {sessionMenu && (
        <div
          className="deepcode-gui-session-context-menu"
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="deepcode-gui-session-context-menu__title">
            {sessionMenu.value.title || t(language, 'agent.session.newTitle')}
          </div>
          <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSessionMenu(null);
                  setTextDialog({
                    kind: 'renameSession',
                    title: t(language, 'agent.session.rename'),
                    value: sessionMenu.value.title || t(language, 'agent.session.newTitle'),
                    session: sessionMenu.value,
                  });
                }}
              >
                {t(language, 'agent.session.rename')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="deepcode-gui-session-context-menu__danger"
                onClick={() => requestDeleteSession(sessionMenu.value)}
              >
                {t(language, 'agent.session.delete')}
              </button>
              {catalog.projects.length > 0 && (
                <div className="deepcode-gui-session-context-menu__section">
                  <div className="deepcode-gui-session-context-menu__section-title">
                    {t(language, 'deepcodeGui.session.addToProject')}
                  </div>
                  {catalog.projects.slice(0, 6).map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      role="menuitem"
                      disabled={sessionMenu.value.projectId === project.id}
                      onClick={() => {
                        const session = sessionMenu.value;
                        setSessionMenu(null);
                        void updateSession(session.id, { projectId: project.id });
                      }}
                    >
                      {project.title}
                    </button>
                  ))}
                </div>
              )}
              {sessionMenu.value.projectId && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const session = sessionMenu.value;
                    setSessionMenu(null);
                    void updateSession(session.id, { projectId: null });
                  }}
                >
                  {t(language, 'deepcodeGui.session.removeFromProject')}
                </button>
              )}
          </>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const id = sessionMenu.value.id;
              setSessionMenu(null);
              void copyText(id);
            }}
          >
            {t(language, 'deepcodeGui.session.copyId')}
          </button>
        </div>
      )}

      {projectMenu && (
        <div
          className="deepcode-gui-session-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="deepcode-gui-session-context-menu__title">{projectMenu.value.title}</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setProjectMenu(null);
              setTextDialog({
                kind: 'renameProject',
                title: t(language, 'deepcodeGui.project.rename'),
                value: projectMenu.value.title,
                project: projectMenu.value,
              });
            }}
          >
            {t(language, 'deepcodeGui.project.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const project = projectMenu.value;
              void openWorkspaceManager(project);
            }}
          >
            {t(language, 'deepcodeGui.project.manageWorkspaces')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="deepcode-gui-session-context-menu__danger"
            onClick={() => void confirmDeleteProject(projectMenu.value)}
          >
            {t(language, 'deepcodeGui.project.delete')}
          </button>
        </div>
      )}

      {textDialog && (
        <div className="deepcode-gui-text-dialog-backdrop" onMouseDown={() => setTextDialog(null)}>
          <form
            className="deepcode-gui-text-dialog"
            onSubmit={(event) => void submitTextDialog(event)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{textDialog.title}</h2>
              <button
                type="button"
                aria-label={t(language, 'window.close')}
                onClick={() => setTextDialog(null)}
              >×</button>
            </header>
            <label>
              <span>{t(language, 'deepcodeGui.nameLabel')}</span>
              <input
                autoFocus
                value={textDialog.value}
                maxLength={120}
                onChange={(event) => setTextDialog({ ...textDialog, value: event.target.value })}
              />
            </label>
            <footer>
              <button type="button" onClick={() => setTextDialog(null)}>
                {t(language, 'agent.session.cancel')}
              </button>
              <button type="submit" disabled={!textDialog.value.trim() || catalogBusy}>
                {t(language, 'agent.session.save')}
              </button>
            </footer>
          </form>
        </div>
      )}

      {deleteSessionCandidate && (
        <div
          className="deepcode-gui-text-dialog-backdrop"
          onMouseDown={() => {
            if (!catalogBusy) setDeleteSessionCandidate(null);
          }}
        >
          <div
            className="deepcode-gui-text-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deepcode-delete-session-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2 id="deepcode-delete-session-title">{t(language, 'agent.session.delete')}</h2>
              <button
                type="button"
                aria-label={t(language, 'agent.session.cancel')}
                disabled={catalogBusy}
                onClick={() => setDeleteSessionCandidate(null)}
              >
                ×
              </button>
            </header>
            <p className="deepcode-gui-text-dialog__message">
              {t(language, 'deepcodeGui.session.deleteConfirm', {
                title: deleteSessionCandidate.title || t(language, 'agent.session.newTitle'),
              })}
            </p>
            {deleteSessionError && (
              <p className="deepcode-gui-text-dialog__error" role="alert">
                {deleteSessionError}
              </p>
            )}
            <footer>
              <button
                type="button"
                disabled={catalogBusy}
                onClick={() => setDeleteSessionCandidate(null)}
              >
                {t(language, 'agent.session.cancel')}
              </button>
              <button
                type="button"
                className="deepcode-gui-text-dialog__danger"
                disabled={catalogBusy}
                onClick={() => void confirmDeleteSession()}
              >
                {t(language, 'agent.session.delete')}
              </button>
            </footer>
          </div>
        </div>
      )}

      {folderAction && (
        <ProjectFolderDialog
          language={language}
          onCancel={() => setFolderAction(null)}
          onSelect={(path) => void selectProjectFolder(path)}
        />
      )}

      {workspaceManager && (
        <div
          className="deepcode-gui-text-dialog-backdrop"
          onMouseDown={() => !workspaceManager.loading && setWorkspaceManager(null)}
        >
          <div
            className="deepcode-gui-text-dialog deepcode-gui-workspace-manager"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{t(language, 'deepcodeGui.project.workspacesTitle')}</h2>
              <button
                type="button"
                aria-label={t(language, 'window.close')}
                disabled={workspaceManager.loading}
                onClick={() => setWorkspaceManager(null)}
              >×</button>
            </header>
            <p className="deepcode-gui-text-dialog__message">
              {t(language, 'deepcodeGui.project.workspaceTemplateHint')}
            </p>
            <div className="deepcode-gui-workspace-manager__list">
              {!workspaceManager.loading && workspaceManager.records.length === 0 && (
                <div className="deepcode-gui-workspace-manager__empty">
                  {t(language, 'deepcodeGui.project.noWorkspaces')}
                </div>
              )}
              {workspaceManager.records.map((record) => (
                <div className="deepcode-gui-workspace-manager__row" key={record.workspaceId}>
                  <span>
                    <strong>{record.displayName}</strong>
                    <small>{record.canonicalRoot}</small>
                  </span>
                  <button
                    type="button"
                    disabled={workspaceManager.loading}
                    onClick={() => void removeManagedWorkspace(record.workspaceId)}
                  >
                    {t(language, 'settings.common.remove')}
                  </button>
                </div>
              ))}
            </div>
            {workspaceManager.error && (
              <p className="deepcode-gui-text-dialog__error" role="alert">{workspaceManager.error}</p>
            )}
            <footer>
              <button type="button" onClick={() => setWorkspaceManager(null)}>
                {t(language, 'deepcodeGui.common.done')}
              </button>
              <button
                type="button"
                disabled={workspaceManager.loading}
                onClick={() => {
                  const project = workspaceManager.project;
                  setWorkspaceManager(null);
                  setFolderAction({
                    kind: 'bind',
                    project,
                    startAfterBinding: false,
                    reopenManager: true,
                  });
                }}
              >
                {t(language, 'deepcodeGui.project.addFolder')}
              </button>
            </footer>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div
          className="deepcode-local-agent-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t(language, 'settings.title')}
          onMouseDown={() => setSettingsOpen(false)}
        >
          <div
            className="deepcode-local-agent-settings"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="deepcode-local-agent-settings__close"
              onClick={() => setSettingsOpen(false)}
            >
              {t(language, 'deepcodeGui.settings.close')}
            </button>
            <Suspense fallback={null}>
              <SettingsCenter
                apiStatus={apiStatus}
                wsStatus={wsStatus}
                serverVersion={serverVersion}
                surface="gui"
              />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
};

function cacheHitSummary(
  projection: SessionProjection | null,
  language: UiLanguage,
): { label: string; title: string } {
  const usage = projection?.tokenUsage;
  const cache = inputCacheMetric(usage);
  const running = projection?.run?.status === 'running';
  if (cache) {
    const percent = `${formatCachePercent(cache.hitPercent)}%`;
    return {
      label: t(language, 'deepcodeGui.cache.summary', { value: percent }),
      title: t(language, 'deepcodeGui.cache.calculatedTitle', {
        input: cache.inputTokens.toLocaleString(language),
        hit: cache.hitTokens.toLocaleString(language),
        miss: cache.missTokens.toLocaleString(language),
      }) + (!cache.complete ? ` ${t(language, 'deepcodeGui.cache.partialTitle', {
        reported: cache.reportedCallCount,
        calls: cache.providerCallCount,
      })}` : '') + (running ? ` ${t(language, 'deepcodeGui.cache.updatingTitle')}` : ''),
    };
  }
  if (running) {
    return {
      label: t(language, 'deepcodeGui.cache.pendingSummary'),
      title: t(language, 'deepcodeGui.cache.pendingTitle'),
    };
  }
  if (!usage?.providerCallCount) {
    return {
      label: t(language, 'deepcodeGui.cache.emptySummary'),
      title: t(language, 'deepcodeGui.cache.emptyTitle'),
    };
  }
  return {
    label: t(language, 'deepcodeGui.cache.unavailableSummary'),
    title: t(language, 'deepcodeGui.cache.unavailableTitle', {
      calls: usage.providerCallCount.toLocaleString(language),
    }),
  };
}

function formatCachePercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function positioned<T>(
  event: React.MouseEvent<HTMLElement>,
  value: T,
  width: number,
  height: number,
): PositionedMenu<T> {
  const rect = event.currentTarget.getBoundingClientRect();
  const rawX = event.clientX || rect.right;
  const rawY = event.clientY || rect.bottom;
  return {
    value,
    x: Math.max(8, Math.min(rawX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(rawY, window.innerHeight - height - 8)),
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export default DeepCodeWorkbenchLayout;
