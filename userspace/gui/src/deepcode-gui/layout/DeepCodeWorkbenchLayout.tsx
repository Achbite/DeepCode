import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentComposerProjectionV1,
  AgentSession,
  AgentTimelineResult,
  BrowseEntry,
  BrowsePathResult,
  InitialLocation,
} from '@deepcode/protocol';
import { createWorkspaceScopeKey } from '@deepcode/session-core';
import { normalizeUiLanguage, t, type UiLanguage } from '../../i18n';
import {
  browsePath,
  createAgentProject,
  deleteAgentProject,
  getInitialLocations,
  listAgentProjects,
  listAgentSessions,
  rebindAgentProject,
  streamAgentComposer,
  updateAgentProject,
  updateAgentSession,
} from '../../services/runtimeAdapter';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import { deriveTokenUsageStats, formatPercent, formatTokenCount } from '../../utils/tokenUsageStats';
import {
  latestAcceptedPlanTaskItemsFromProjection,
  timelineOrEmpty,
} from '../../utils/uiTimelineProjection';
import AgentMemoryViewer from '../../components/agent-memory/AgentMemoryViewer';
import DeepCodeConversationShell from './DeepCodeConversationShell';
import DeepCodeSidebar, {
  DeepCodeSidebarIcon,
  deriveProjectArchiveGroups,
} from './DeepCodeSidebar';
import DeepCodeTaskPanel from './DeepCodeTaskPanel';
import type { DeepCodeTaskItem } from './DeepCodeTaskPanel';
import DeepCodeTitlebar from './DeepCodeTitlebar';
import type { DeepCodeCacheHitSummary } from './DeepCodeTitlebar';
import {
  displaySessionTitle,
  shouldShowSidebarSession,
  statusLabel,
} from './DeepCodeShellText';
import '../../components/workspace-open-dialog/workspaceOpenDialog.css';

interface DeepCodeWorkbenchLayoutProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  lastHeartbeatAt?: string;
  kernelStartBusy?: boolean;
  kernelStartMessage?: string | null;
  onRetryKernelStart?: () => void | Promise<void>;
}

const WorkspaceOpenDialog = lazy(() => import('../../components/workspace-open-dialog/WorkspaceOpenDialog'));
const CodeWorkspaceChoiceDialog = lazy(() => import('../../components/code-workspace-choice-dialog/CodeWorkspaceChoiceDialog'));
const SettingsCenter = lazy(() => import('../../components/settings-center/SettingsCenter'));

type DeepCodeGuiProject = import('@deepcode/protocol').AgentProject;

interface DeepCodeSessionContextMenu {
  session: AgentSession;
  x: number;
  y: number;
}

interface DeepCodeProjectContextMenu {
  project: DeepCodeGuiProject;
  x: number;
  y: number;
}

interface DeepCodeProjectCreateMenu {
  x: number;
  y: number;
}

interface DeepCodeTextInputDialog {
  kind: 'project' | 'renameSession' | 'renameProject';
  title: string;
  label: string;
  value: string;
  projectFolderPath?: string;
  session?: AgentSession;
  project?: DeepCodeGuiProject;
}

function basename(path?: string | null): string {
  if (!path) return '';
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
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
  document.body.removeChild(textarea);
}

function waitForComposerReconnect(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface DeepCodeProjectFolderDialogProps {
  language: UiLanguage;
  onCancel: () => void;
  onSelect: (absolutePath: string) => void;
}

const DeepCodeProjectFolderDialog: React.FC<DeepCodeProjectFolderDialogProps> = ({
  language,
  onCancel,
  onSelect,
}) => {
  const [locations, setLocations] = useState<InitialLocation[]>([]);
  const [browseResult, setBrowseResult] = useState<BrowsePathResult | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<BrowseEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const navigateTo = async (absolutePath: string): Promise<void> => {
    setLoading(true);
    setError(null);
    setSelectedEntry(null);
    const result = await browsePath(absolutePath);
    if (result.ok && result.data) {
      setBrowseResult(result.data);
      setAddressInput(result.data.absolutePath);
    } else {
      setError(result.message ?? t(language, 'workspaceDialog.error.browse'));
    }
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const init = await getInitialLocations();
      if (cancelled) return;
      if (init.ok && init.data) {
        setLocations(init.data.locations);
        const first = init.data.locations[0];
        if (first) {
          await navigateTo(first.absolutePath);
        } else {
          setLoading(false);
        }
        return;
      }
      setError(init.message ?? t(language, 'workspaceDialog.error.initialLocations'));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const visibleEntries = useMemo<BrowseEntry[]>(() => {
    if (!browseResult) return [];
    return showHidden
      ? browseResult.entries
      : browseResult.entries.filter((entry) => !entry.hidden);
  }, [browseResult, showHidden]);

  const selectedPath =
    selectedEntry?.type === 'directory'
      ? selectedEntry.absolutePath
      : browseResult?.absolutePath ?? '';
  const folderButtonLabel = selectedEntry?.type === 'directory'
    ? t(language, 'workspaceDialog.openSelectedFolder')
    : t(language, 'workspaceDialog.openCurrentFolder');

  const handleAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && addressInput.trim()) {
      void navigateTo(addressInput.trim());
    }
  };

  const handleEntryDoubleClick = (entry: BrowseEntry) => {
    if (entry.type === 'directory') {
      void navigateTo(entry.absolutePath);
    }
  };

  return (
    <div className="ws-open-dialog__backdrop" onClick={onCancel}>
      <div
        className="ws-open-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t(language, 'deepcodeGui.project.folderDialogTitle')}
      >
        <div className="ws-open-dialog__header">
          <span>{t(language, 'deepcodeGui.project.folderDialogTitle')}</span>
          <button
            className="ws-open-dialog__close"
            onClick={onCancel}
            title={t(language, 'window.close')}
            type="button"
          >
            x
          </button>
        </div>

        <div className="ws-open-dialog__addressbar">
          <button
            className="ws-open-dialog__btn"
            disabled={!browseResult?.parentPath}
            onClick={() => browseResult?.parentPath && void navigateTo(browseResult.parentPath)}
            title={t(language, 'workspaceDialog.parent')}
            type="button"
          >
            {t(language, 'workspaceDialog.up')}
          </button>
          <input
            className="ws-open-dialog__address"
            value={addressInput}
            placeholder={t(language, 'workspaceDialog.addressPlaceholder')}
            onChange={(event) => setAddressInput(event.target.value)}
            onKeyDown={handleAddressKeyDown}
          />
          <button
            className="ws-open-dialog__btn"
            onClick={() => addressInput.trim() && void navigateTo(addressInput.trim())}
            type="button"
          >
            {t(language, 'workspaceDialog.go')}
          </button>
          <label className="ws-open-dialog__toggle" title={t(language, 'workspaceDialog.hiddenTitle')}>
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            <span>{t(language, 'workspaceDialog.hidden')}</span>
          </label>
        </div>

        <div className="ws-open-dialog__body">
          <aside className="ws-open-dialog__sidebar">
            <div className="ws-open-dialog__sidebar-title">
              {t(language, 'workspaceDialog.quickLocations')}
            </div>
            {locations.map((location) => (
              <button
                key={`${location.kind}::${location.absolutePath}`}
                className="ws-open-dialog__sidebar-item"
                onClick={() => void navigateTo(location.absolutePath)}
                title={location.absolutePath}
                type="button"
              >
                <span className="ws-open-dialog__sidebar-icon">
                  {location.kind === 'home' ? 'HOME' : location.kind === 'drive' ? 'DISK' : 'WS'}
                </span>
                <span>{location.label}</span>
              </button>
            ))}
          </aside>

          <main className="ws-open-dialog__main">
            {loading && (
              <div className="ws-open-dialog__placeholder">
                {t(language, 'workspaceDialog.loading')}
              </div>
            )}
            {error && <div className="ws-open-dialog__error">{error}</div>}
            {!loading && !error && visibleEntries.length === 0 && (
              <div className="ws-open-dialog__placeholder">
                {t(language, 'workspaceDialog.empty')}
              </div>
            )}
            {!loading && !error && visibleEntries.length > 0 && (
              <ul className="ws-open-dialog__entries">
                {visibleEntries.map((entry) => {
                  const isSelected = selectedEntry?.absolutePath === entry.absolutePath;
                  return (
                    <li
                      key={entry.absolutePath}
                      className={
                        'ws-open-dialog__entry' +
                        (isSelected ? ' ws-open-dialog__entry--selected' : '') +
                        (entry.isCodeWorkspace ? ' ws-open-dialog__entry--code-workspace' : '')
                      }
                      onClick={() => setSelectedEntry(entry)}
                      onDoubleClick={() => handleEntryDoubleClick(entry)}
                      title={entry.absolutePath}
                    >
                      <span className="ws-open-dialog__entry-icon">
                        {entry.type === 'directory'
                          ? 'DIR'
                          : entry.isCodeWorkspace
                            ? 'WS'
                            : 'FILE'}
                      </span>
                      <span className="ws-open-dialog__entry-name">{entry.name}</span>
                      {entry.isCodeWorkspace && (
                        <span className="ws-open-dialog__entry-tag">
                          {t(language, 'workspaceDialog.workspaceTag')}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </main>
        </div>

        <div className="ws-open-dialog__footer">
          <div className="ws-open-dialog__footer-info">
            {selectedPath && (
              <span>
                {t(language, 'workspaceDialog.selected')} <strong>{selectedPath}</strong>
              </span>
            )}
          </div>
          <div className="ws-open-dialog__footer-actions">
            <button className="ws-open-dialog__btn" onClick={onCancel} type="button">
              {t(language, 'workspaceDialog.cancel')}
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--primary"
              disabled={!selectedPath}
              onClick={() => selectedPath && onSelect(selectedPath)}
              type="button"
            >
              {folderButtonLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function dedupeTaskItems(items: DeepCodeTaskItem[]): DeepCodeTaskItem[] {
  const byKey = new Map<string, DeepCodeTaskItem>();
  for (const item of items) {
    const key = JSON.stringify([item.id, item.targetRefs]);
    byKey.set(key, item);
  }
  return Array.from(byKey.values());
}

function deriveTaskItems(
  language: UiLanguage,
  projection: AgentTimelineResult
): DeepCodeTaskItem[] {
  const projectedItems = latestAcceptedPlanTaskItemsFromProjection(projection);

  if (projectedItems.length > 0) {
    return dedupeTaskItems(
      projectedItems.map((item) => ({
        id: item.id,
        blockId: item.blockId,
        title: t(language, item.titleKey, item.titleArgs),
        summary: t(language, item.summaryKey, item.messageArgs),
        progress: item.progress,
        outcome: item.outcome,
        targetRefs: [...item.targetRefs],
        resourcePresentation: item.resourcePresentation.map((resource) => ({ ...resource })),
      }))
    ).slice(-6);
  }

  return [];
}

function deriveCacheHitSummary(
  language: UiLanguage,
  tokenUsageProjection?: AgentTimelineResult['tokenUsageProjection'] | null
): DeepCodeCacheHitSummary | null {
  const stats = deriveTokenUsageStats(tokenUsageProjection);
  const percent = formatPercent(stats.cacheHitRate);
  const label = t(language, 'deepcodeGui.cache.label', { percent });
  if (!stats.hasCacheData) {
    return {
      label,
      title: t(language, 'deepcodeGui.cache.noTelemetryTitle'),
    };
  }
  const title = t(language, 'deepcodeGui.cache.telemetryTitle', {
    hitTokens: formatTokenCount(stats.promptCacheHitTokens),
    missTokens: formatTokenCount(stats.promptCacheMissTokens),
  });
  return { label, title };
}

const DeepCodeWorkbenchLayout: React.FC<DeepCodeWorkbenchLayoutProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  lastHeartbeatAt,
  kernelStartBusy = false,
  kernelStartMessage,
  onRetryKernelStart,
}) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [knownSessions, setKnownSessions] = useState<AgentSession[]>([]);
  const [projectRecords, setProjectRecords] = useState<DeepCodeGuiProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [draftActive, setDraftActive] = useState(true);
  const [draftTargetProjectId, setDraftTargetProjectId] = useState<string | null>(null);
  const [draftSubmissionScopeId, setDraftSubmissionScopeId] = useState<string>(
    () => `conversation-draft:${globalThis.crypto.randomUUID()}`
  );
  const [composerProjection, setComposerProjection] = useState<AgentComposerProjectionV1 | null>(null);
  const [composerLoading, setComposerLoading] = useState(true);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerStreamEpoch, setComposerStreamEpoch] = useState(0);
  const [draftProfileId, setDraftProfileId] = useState<string | undefined>();
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const [sessionMenu, setSessionMenu] = useState<DeepCodeSessionContextMenu | null>(null);
  const [projectMenu, setProjectMenu] = useState<DeepCodeProjectContextMenu | null>(null);
  const [projectCreateMenu, setProjectCreateMenu] = useState<DeepCodeProjectCreateMenu | null>(null);
  const [projectFolderDialogOpen, setProjectFolderDialogOpen] = useState(false);
  const [rebindProjectId, setRebindProjectId] = useState<string | null>(null);
  const [textDialog, setTextDialog] = useState<DeepCodeTextInputDialog | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryRefreshing, setMemoryRefreshing] = useState(false);
  const [sidebarPendingAction, setSidebarPendingAction] = useState<string | null>(null);
  const lastWorkspaceScopeKeyRef = useRef<string | null>(null);
  const sidebarPendingActionRef = useRef<string | null>(null);
  const workspace = useWorkspaceStore((s) => s.current);
  const activeFolderId = useWorkspaceStore((s) => s.activeFolderId);
  const activeSession = useAgentSessionStore((s) => s.session);
  const timeline = useAgentSessionStore((s) => s.timeline);
  const enterDraft = useAgentSessionStore((s) => s.enterDraft);
  const sendDraftMessage = useAgentSessionStore((s) => s.sendDraftMessage);
  const captureSubmissionTarget = useAgentSessionStore((s) => s.captureSubmissionTarget);
  const activateSession = useAgentSessionStore((s) => s.activateSession);
  const selectProfile = useAgentSessionStore((s) => s.selectProfile);
  const profileSelectionBusy = useAgentSessionStore((s) => s.profileSelectionBusy);
  const renameSession = useAgentSessionStore((s) => s.renameSession);
  const deleteSession = useAgentSessionStore((s) => s.deleteSession);
  const refreshActiveSessionContext = useAgentSessionStore((s) => s.refreshActiveSessionContext);
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );

  useEffect(() => {
    if (typeof performance === 'undefined') return;
    performance.mark('deepcode-gui:workbench-ready');
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (apiStatus !== 'connected') {
      return () => {
        cancelled = true;
      };
    }
    const loadKnownSessions = async () => {
      const [sessionResult, projectResult] = await Promise.all([
        listAgentSessions({ includeArchived: true, includeAllScopes: true }),
        listAgentProjects(),
      ]);
      if (cancelled) return;
      if (sessionResult.ok && sessionResult.data) {
        setKnownSessions(sessionResult.data.sessions);
      }
      if (projectResult.ok && projectResult.data) {
        setProjectRecords(projectResult.data.projects);
      }
    };
    void loadKnownSessions();
    return () => {
      cancelled = true;
    };
  }, [activeSession?.id, apiStatus]);

  useEffect(() => {
    if (!sessionMenu && !projectMenu && !projectCreateMenu) return undefined;
    const close = () => {
      setSessionMenu(null);
      setProjectMenu(null);
      setProjectCreateMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sessionMenu, projectMenu, projectCreateMenu]);

  const activeFolder = useMemo(() => {
    if (!workspace || workspace.folders.length === 0) return null;
    return workspace.folders.find((folder) => folder.id === activeFolderId) ?? workspace.folders[0];
  }, [activeFolderId, workspace]);

  const workspacePath = activeFolder?.absolutePath ?? workspace?.sourcePath;
  const workspaceName = workspacePath === '/'
    ? t(language, 'deepcodeGui.workspace.systemRoot')
    : basename(workspacePath) || t(language, 'deepcodeGui.workspace.none');
  const lastHeartbeatText = lastHeartbeatAt
    ? new Date(lastHeartbeatAt).toLocaleTimeString()
    : t(language, 'deepcodeGui.status.pending');
  const workspaceScopeKey = createWorkspaceScopeKey(workspace);
  const composerQuery = useMemo(() => {
    if (draftActive) {
      return draftTargetProjectId ? { projectId: draftTargetProjectId } : {};
    }
    if (!activeSession?.id) return null;
    return {
      sessionId: activeSession.id,
      ...(activeSession.projectId ? { projectId: activeSession.projectId } : {}),
    };
  }, [activeSession?.id, activeSession?.projectId, draftActive, draftTargetProjectId]);

  const restartComposerStream = useCallback(() => {
    setComposerStreamEpoch((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (apiStatus !== 'connected' || !composerQuery) {
      setComposerProjection(null);
      setComposerError(null);
      setComposerLoading(false);
      return () => controller.abort();
    }
    setComposerProjection(null);
    setComposerError(null);
    setComposerLoading(true);
    let reconnectDelayMs = 250;
    const consume = async () => {
      while (!controller.signal.aborted) {
        try {
          await streamAgentComposer(
            composerQuery,
            (event) => {
              if (controller.signal.aborted) return;
              const projection = event.projection;
              setComposerProjection(projection);
              setComposerError(null);
              setDraftProfileId((current) => {
                if (!draftActive) return projection.selectedProfileId;
                if (
                  current
                  && projection.enabledProfiles.some((profile) => profile.profileId === current)
                ) {
                  return current;
                }
                return projection.selectedProfileId ?? projection.defaultProfileId;
              });
              setComposerLoading(false);
              reconnectDelayMs = 250;
            },
            controller.signal
          );
          if (controller.signal.aborted) return;
          throw new Error('Composer projection stream ended before the shell was closed.');
        } catch (error) {
          if (controller.signal.aborted) return;
          // A disconnected companion stream no longer owns a current
          // replacement projection. Keep composer mutations fail-closed until
          // the next authoritative snapshot arrives.
          setComposerProjection(null);
          setComposerError(error instanceof Error ? error.message : String(error));
          setComposerLoading(true);
          await waitForComposerReconnect(controller.signal, reconnectDelayMs);
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000);
        }
      }
    };
    void consume();
    return () => controller.abort();
  }, [apiStatus, composerQuery, composerStreamEpoch, draftActive, workspaceScopeKey]);

  useEffect(() => {
    const previous = lastWorkspaceScopeKeyRef.current;
    lastWorkspaceScopeKeyRef.current = workspaceScopeKey;
    if (previous === null || previous === workspaceScopeKey) return;
    enterDraft();
    setActiveProjectId(null);
    setDraftActive(true);
    setDraftTargetProjectId(null);
    setDraftProfileId(undefined);
    setDraftSubmissionScopeId(`conversation-draft:${globalThis.crypto.randomUUID()}`);
  }, [enterDraft, workspaceScopeKey]);

  const liveTimelineProjection = draftActive
    ? timelineOrEmpty(null, 'conversation-draft')
    : timelineOrEmpty(timeline, activeSession?.id);
  const agentReady = apiStatus === 'connected';
  const taskItems = useMemo(() => {
    return deriveTaskItems(language, liveTimelineProjection);
  }, [language, liveTimelineProjection]);
  const cacheHitSummary = useMemo(
    () => deriveCacheHitSummary(language, liveTimelineProjection.tokenUsageProjection),
    [language, liveTimelineProjection.tokenUsageProjection]
  );
  const activeProject = useMemo(
    () => projectRecords.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projectRecords]
  );
  const draftProject = useMemo(
    () => projectRecords.find((project) => project.id === draftTargetProjectId) ?? null,
    [draftTargetProjectId, projectRecords]
  );
  const assignedProjectSessionIds = useMemo(() => {
    return new Set(
      knownSessions
        .filter((session) => Boolean(session.projectId))
        .map((session) => session.id)
    );
  }, [knownSessions]);
  const displaySessions = useMemo(() => {
    const byId = new Map<string, AgentSession>();
    for (const session of knownSessions) byId.set(session.id, session);
    if (activeSession?.id) {
      byId.set(activeSession.id, {
        ...byId.get(activeSession.id),
        ...activeSession,
        eventCount: Math.max(activeSession.eventCount ?? 0, timeline?.eventCount ?? 0),
      });
    }
    return Array.from(byId.values());
  }, [activeSession, knownSessions, timeline?.eventCount]);
  const activeSessionRunning = Boolean(
    timeline?.runProjection
    && ['active', 'waitingUser', 'waitingExternal', 'paused'].includes(
      timeline.runProjection.status
    )
  );
  const highlightedSessionId = draftActive ? null : activeSession?.id ?? null;
  const isHome = draftActive
    || ((timeline?.turns.length ?? 0) === 0 && !activeSessionRunning);
  const visibleSessions = useMemo(
    () => displaySessions.filter((item) => {
      if (item.archivedAt) return false;
      if (assignedProjectSessionIds.has(item.id)) return false;
      const currentWithEvents = item.id === activeSession?.id && (timeline?.turns.length ?? 0) > 0;
      return shouldShowSidebarSession(item) || currentWithEvents;
    }),
    [activeSession?.id, assignedProjectSessionIds, displaySessions, timeline?.turns.length]
  );
  const projectArchiveGroups = useMemo(
    () => deriveProjectArchiveGroups(displaySessions, projectRecords),
    [displaySessions, projectRecords]
  );
  const collapsedProjectIdSet = useMemo(
    () => new Set(collapsedProjectIds),
    [collapsedProjectIds]
  );

  const moveSessionToProject = async (projectId: string, sessionId: string): Promise<boolean> => {
    const result = await updateAgentSession(sessionId, { projectId });
    if (!result.ok || !result.data) return false;
    upsertKnownSession(result.data.session);
    if (activeSession?.id === sessionId) {
      return activateSession(sessionId);
    }
    return true;
  };

  const upsertKnownSession = (session: AgentSession) => {
    setKnownSessions((current) => [
      session,
      ...current.filter((item) => item.id !== session.id),
    ]);
  };

  const handleCreateSession = async (projectId?: string | null) => {
    const targetProjectId = projectId ?? null;
    enterDraft();
    setActiveProjectId(null);
    setDraftActive(true);
    setDraftTargetProjectId(targetProjectId);
    setDraftProfileId(undefined);
    setComposerProjection(null);
    setComposerError(null);
    setDraftSubmissionScopeId(`conversation-draft:${globalThis.crypto.randomUUID()}`);
  };

  const runSidebarAction = async (key: string, action: () => Promise<void> | void) => {
    if (sidebarPendingActionRef.current === key) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
    sidebarPendingActionRef.current = key;
    setSidebarPendingAction(key);
    try {
      await action();
    } finally {
      if (sidebarPendingActionRef.current === key) {
        sidebarPendingActionRef.current = null;
        setSidebarPendingAction(null);
      }
    }
  };

  const toggleProjectExpanded = (projectId: string) => {
    setCollapsedProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId]
    );
  };

  const prepareConversationSession = async () => {
    if (draftActive) return false;
    return captureSubmissionTarget() ?? false;
  };

  const submitDraftMessage = async (content: string, profileId?: string) => {
    const target = composerProjection?.conversationDraftTarget;
    if (!draftActive || !target || !profileId) return false;
    const admittedSession = await sendDraftMessage(target, content, profileId);
    if (!admittedSession) return false;
    upsertKnownSession(admittedSession);
    const nextSession = useAgentSessionStore.getState().session;
    if (nextSession?.id !== admittedSession.id) return true;
    setActiveProjectId(nextSession.projectId ?? null);
    setDraftActive(false);
    setDraftTargetProjectId(null);
    setDraftProfileId(nextSession.profileId);
    setComposerProjection(null);
    return true;
  };

  const commitDraftSession = async () => {
    const state = useAgentSessionStore.getState();
    const updatedSession = state.session;
    if (updatedSession) {
      upsertKnownSession(updatedSession);
    }
  };

  const handleProfileChange = async (profileId: string) => {
    if (draftActive) {
      if (composerProjection?.enabledProfiles.some((profile) => profile.profileId === profileId)) {
        setDraftProfileId(profileId);
      }
      return;
    }
    if (!activeSession?.id || !composerProjection?.selectionMutable) return;
    await selectProfile(profileId);
  };

  const openProjectCreateMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 230;
    const height = 96;
    setSessionMenu(null);
    setProjectMenu(null);
    const x = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const y = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8));
    setProjectCreateMenu({
      x,
      y,
    });
  };

  const handleCreateBlankProject = () => {
    setProjectCreateMenu(null);
    const defaultName = t(language, 'deepcodeGui.project.defaultName');
    setTextDialog({
      kind: 'project',
      title: t(language, 'deepcodeGui.project.newBlank'),
      label: t(language, 'deepcodeGui.project.namePrompt'),
      value: defaultName,
    });
  };

  const handleCreateProjectFromFolder = () => {
    setProjectCreateMenu(null);
    setRebindProjectId(null);
    setProjectFolderDialogOpen(true);
  };

  const commitProjectName = async (title: string, projectFolderPath?: string) => {
    if (!title) return;
    const result = await createAgentProject({ title, rootPath: projectFolderPath });
    if (!result.ok || !result.data) return;
    const project = result.data.project;
    setProjectRecords((current) => [project, ...current.filter((item) => item.id !== project.id)]);
    setActiveProjectId(null);
    enterDraft();
    setDraftActive(true);
    setDraftTargetProjectId(project.id);
    setDraftProfileId(undefined);
    setComposerProjection(null);
    setDraftSubmissionScopeId(`conversation-draft:${globalThis.crypto.randomUUID()}`);
  };

  const commitProjectFolderPath = async (projectFolderPath: string) => {
    setProjectFolderDialogOpen(false);
    if (rebindProjectId) {
      const projectId = rebindProjectId;
      setRebindProjectId(null);
      const result = await rebindAgentProject(projectId, { rootPath: projectFolderPath });
      if (result.ok && result.data) {
        setProjectRecords((current) => current.map((project) =>
          project.id === projectId ? result.data!.project : project
        ));
      }
      return;
    }
    const defaultName = basename(projectFolderPath) || t(language, 'deepcodeGui.project.defaultName');
    await commitProjectName(defaultName, projectFolderPath);
  };

  const handleRebindProject = (project: DeepCodeGuiProject) => {
    setProjectMenu(null);
    setRebindProjectId(project.id);
    setProjectFolderDialogOpen(true);
  };

  const openSessionContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    session: AgentSession
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 190;
    const height = projectRecords.length > 0 ? Math.min(350, 202 + projectRecords.length * 32) : 168;
    setSessionMenu({
      session,
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
    });
  };

  const openProjectContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    project: DeepCodeGuiProject
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 190;
    const height = 148;
    setProjectMenu({
      project,
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
    });
  };

  const handleRenameSession = (session: AgentSession) => {
    setSessionMenu(null);
    setTextDialog({
      kind: 'renameSession',
      title: t(language, 'agent.session.rename'),
      label: t(language, 'agent.session.titleLabel'),
      value: displaySessionTitle(language, session.title),
      session,
    });
  };

  const handleRenameProject = (project: DeepCodeGuiProject) => {
    setProjectMenu(null);
    setTextDialog({
      kind: 'renameProject',
      title: t(language, 'deepcodeGui.project.rename'),
      label: t(language, 'deepcodeGui.project.namePrompt'),
      value: project.title,
      project,
    });
  };

  const commitSessionRename = async (session: AgentSession, nextTitle: string) => {
    if (!nextTitle) return;
    await renameSession(session.id, nextTitle);
    setKnownSessions((current) => current.map((item) =>
      item.id === session.id ? { ...item, title: nextTitle } : item
    ));
  };

  const commitProjectRename = async (project: DeepCodeGuiProject, nextTitle: string) => {
    if (!nextTitle) return;
    const result = await updateAgentProject(project.id, { title: nextTitle });
    if (result.ok && result.data) {
      setProjectRecords((current) => current.map((item) =>
        item.id === project.id ? result.data!.project : item
      ));
    }
  };

  const handleTextDialogSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!textDialog) return;
    const value = textDialog.value.trim();
    if (!value) return;
    setTextDialog(null);
    if (textDialog.kind === 'project') {
      await commitProjectName(value, textDialog.projectFolderPath);
      return;
    }
    if (textDialog.kind === 'renameProject' && textDialog.project) {
      await commitProjectRename(textDialog.project, value);
      return;
    }
    if (textDialog.kind === 'renameSession' && textDialog.session) {
      await commitSessionRename(textDialog.session, value);
    }
  };

  const handleDeleteSession = async (session: AgentSession) => {
    setSessionMenu(null);
    const deleted = await deleteSession(session.id);
    if (!deleted) return;
    setKnownSessions((current) => current.filter((item) => item.id !== session.id));
    if (activeSession?.id === session.id) {
      const canonicalSession = useAgentSessionStore.getState().session;
      setActiveProjectId(canonicalSession?.projectId ?? null);
      setDraftActive(!canonicalSession);
      setDraftTargetProjectId(null);
      setDraftProfileId(canonicalSession?.profileId);
      setComposerProjection(null);
      setDraftSubmissionScopeId(`conversation-draft:${globalThis.crypto.randomUUID()}`);
    }
  };

  const handleCopySessionId = async (session: AgentSession) => {
    setSessionMenu(null);
    await copyText(session.id);
  };

  const handleMoveSessionToProject = async (session: AgentSession, projectId: string) => {
    setSessionMenu(null);
    const moved = await moveSessionToProject(projectId, session.id);
    if (moved && useAgentSessionStore.getState().session?.id === session.id) {
      setActiveProjectId(projectId);
      setDraftActive(false);
      setDraftTargetProjectId(null);
    }
  };

  const handleDeleteProject = async (project: DeepCodeGuiProject) => {
    setProjectMenu(null);
    const result = await deleteAgentProject(project.id);
    if (!result.ok || !result.data) return;
    setProjectRecords(result.data.projects);
    const refreshedSessions = await listAgentSessions({
      includeArchived: true,
      includeAllScopes: true,
    });
    if (refreshedSessions.ok && refreshedSessions.data) {
      setKnownSessions(refreshedSessions.data.sessions);
      if (activeSession?.projectId === project.id) {
        await activateSession(activeSession.id);
      }
    }
    setCollapsedProjectIds((current) => current.filter((id) => id !== project.id));
    if (activeProjectId === project.id) setActiveProjectId(null);
    if (draftTargetProjectId === project.id) {
      setDraftActive(true);
      setDraftTargetProjectId(null);
      setDraftProfileId(undefined);
      setDraftSubmissionScopeId(`conversation-draft:${globalThis.crypto.randomUUID()}`);
    }
  };

  const composerSubmissionScopeId = draftActive
    ? draftSubmissionScopeId
    : activeSession?.id ?? null;

  return (
    <div className="deepcode-gui-workbench">
      <DeepCodeTitlebar
        language={language}
        apiStatus={apiStatus}
        agentReady={agentReady}
        cacheHitSummary={cacheHitSummary}
        kernelStartBusy={kernelStartBusy}
        kernelStartMessage={kernelStartMessage}
        onRetryKernelStart={onRetryKernelStart}
      />

      <div className={`deepcode-gui-shell ${isHome ? 'deepcode-gui-shell--home' : ''}`}>
        <DeepCodeSidebar
          language={language}
          projectArchiveGroups={projectArchiveGroups}
          projectRecords={projectRecords}
          visibleSessions={visibleSessions}
          collapsedProjectIds={collapsedProjectIdSet}
          activeProjectId={activeProjectId}
          draftTargetProjectId={draftTargetProjectId}
          highlightedSessionId={highlightedSessionId}
          pendingAction={sidebarPendingAction}
          projectCreateMenuOpen={Boolean(projectCreateMenu)}
          onCreatePrimarySession={() => {
            void runSidebarAction('create:normal:primary', () => handleCreateSession(null));
          }}
          onOpenProjectCreateMenu={openProjectCreateMenu}
          onToggleProject={toggleProjectExpanded}
          onCreateProjectSession={(projectId, actionKey) => {
            void runSidebarAction(actionKey, () => handleCreateSession(projectId));
          }}
          onActivateSession={(session, projectId, actionKey) => {
            void runSidebarAction(actionKey, async () => {
              setComposerProjection(null);
              const activated = await activateSession(session.id);
              if (!activated) return;
              const canonicalSession = useAgentSessionStore.getState().session;
              setActiveProjectId(canonicalSession?.projectId ?? projectId);
              setDraftActive(false);
              setDraftTargetProjectId(null);
              setDraftProfileId(session.profileId);
            });
          }}
          onOpenProjectContextMenu={openProjectContextMenu}
          onOpenSessionContextMenu={openSessionContextMenu}
          onCreateUnboundSession={() => {
            void runSidebarAction('create:normal:nested', () => handleCreateSession(null));
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <DeepCodeConversationShell
          language={language}
          timeline={liveTimelineProjection}
          composer={composerProjection}
          composerLoading={composerLoading}
          composerError={composerError}
          selectedProfileId={draftActive
            ? draftProfileId
            : composerProjection?.selectedProfileId}
          profileSelectionBusy={profileSelectionBusy}
          forceHome={draftActive}
          projectTitle={draftProject?.title ?? activeProject?.title ?? null}
          submissionScopeId={composerSubmissionScopeId}
          onBeforeSend={prepareConversationSession}
          onDraftSend={draftActive ? submitDraftMessage : undefined}
          onProfileChange={handleProfileChange}
          onComposerRetry={restartComposerStream}
          onAfterSend={commitDraftSession}
        />

        <DeepCodeTaskPanel language={language} items={taskItems} />
      </div>

      {projectCreateMenu && (
        <div
          className="deepcode-gui-project-create-menu"
          style={{ left: projectCreateMenu.x, top: projectCreateMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <button type="button" role="menuitem" onClick={handleCreateBlankProject}>
            <DeepCodeSidebarIcon name="folderPlus" />
            <span>{t(language, 'deepcodeGui.project.newBlank')}</span>
          </button>
          <button type="button" role="menuitem" onClick={handleCreateProjectFromFolder}>
            <DeepCodeSidebarIcon name="folder" />
            <span>{t(language, 'deepcodeGui.project.fromFolder')}</span>
          </button>
        </div>
      )}

      {sessionMenu && (
        <div
          className="deepcode-gui-session-context-menu"
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <div className="deepcode-gui-session-context-menu__title">
            {displaySessionTitle(language, sessionMenu.session.title)}
          </div>
          <button
            type="button"
            role="menuitem"
            disabled={activeSession?.id !== sessionMenu.session.id}
            title={activeSession?.id === sessionMenu.session.id
              ? t(language, 'memoryV2.open')
              : t(language, 'memoryV2.currentOnly')}
            onClick={() => {
              setSessionMenu(null);
              setMemoryOpen(true);
            }}
          >
            {t(language, 'memoryV2.open')}
          </button>
          <button type="button" role="menuitem" onClick={() => handleRenameSession(sessionMenu.session)}>
            {t(language, 'agent.session.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="deepcode-gui-session-context-menu__danger"
            onClick={() => void handleDeleteSession(sessionMenu.session)}
          >
            {t(language, 'agent.session.delete')}
          </button>
          {projectRecords.length > 0 && (
            <div className="deepcode-gui-session-context-menu__section">
              <div className="deepcode-gui-session-context-menu__section-title">
                {t(language, 'deepcodeGui.session.addToProject')}
              </div>
              {projectRecords.slice(0, 8).map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="menuitem"
                  onClick={() => void handleMoveSessionToProject(sessionMenu.session, project.id)}
                >
                  {project.title}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCopySessionId(sessionMenu.session)}
          >
            {t(language, 'deepcodeGui.session.copyId')}
          </button>
        </div>
      )}

      {projectMenu && (
        <div
          className="deepcode-gui-session-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <div className="deepcode-gui-session-context-menu__title">
            {projectMenu.project.title}
          </div>
          <button type="button" role="menuitem" onClick={() => handleRenameProject(projectMenu.project)}>
            {t(language, 'deepcodeGui.project.rename')}
          </button>
          <button type="button" role="menuitem" onClick={() => handleRebindProject(projectMenu.project)}>
            {t(language, 'deepcodeGui.project.rebind')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="deepcode-gui-session-context-menu__danger"
            onClick={() => handleDeleteProject(projectMenu.project)}
          >
            {t(language, 'deepcodeGui.project.delete')}
          </button>
        </div>
      )}

      {memoryOpen && (
        <div
          className="agent-memory-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t(language, 'memoryV2.title')}
          onMouseDown={() => setMemoryOpen(false)}
        >
          <div className="agent-memory-sheet" onMouseDown={(event) => event.stopPropagation()}>
            <AgentMemoryViewer
              language={language}
              timeline={timeline}
              sessionId={activeSession?.id}
              refreshing={memoryRefreshing}
              onRefresh={async () => {
                setMemoryRefreshing(true);
                try {
                  await refreshActiveSessionContext();
                } finally {
                  setMemoryRefreshing(false);
                }
              }}
              onClose={() => setMemoryOpen(false)}
            />
          </div>
        </div>
      )}

      {textDialog && (
        <div
          className="deepcode-gui-text-dialog-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={textDialog.title}
          onMouseDown={() => setTextDialog(null)}
        >
          <form
            className="deepcode-gui-text-dialog"
            onSubmit={(event) => void handleTextDialogSubmit(event)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{textDialog.title}</h2>
              <button
                type="button"
                aria-label={t(language, 'agent.session.cancel')}
                onClick={() => setTextDialog(null)}
              >
                x
              </button>
            </header>
            <label>
              <span>{textDialog.label}</span>
              <input
                autoFocus
                value={textDialog.value}
                onChange={(event) => setTextDialog((current) =>
                  current ? { ...current, value: event.target.value } : current
                )}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setTextDialog(null);
                  }
                }}
              />
            </label>
            <footer>
              <button type="button" onClick={() => setTextDialog(null)}>
                {t(language, 'agent.session.cancel')}
              </button>
              <button type="submit" disabled={!textDialog.value.trim()}>
                {t(language, 'agent.session.save')}
              </button>
            </footer>
          </form>
        </div>
      )}

      {projectFolderDialogOpen && (
        <DeepCodeProjectFolderDialog
          language={language}
          onCancel={() => {
            setProjectFolderDialogOpen(false);
            setRebindProjectId(null);
          }}
          onSelect={(path) => void commitProjectFolderPath(path)}
        />
      )}

      <Suspense fallback={null}>
        {settingsOpen && (
          <div
            className="deepcode-gui-settings-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={t(language, 'settings.title')}
            onMouseDown={() => setSettingsOpen(false)}
          >
            <section
              className="deepcode-gui-settings-sheet"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="deepcode-gui-settings-sheet__header">
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
              <div className="deepcode-gui-settings-sheet__runtime">
                <span>API {statusLabel(language, apiStatus)}</span>
                <span>Agent {statusLabel(language, agentReady ? 'ready' : 'checking')}</span>
                <span>WS {statusLabel(language, wsStatus)}</span>
                <span>{t(language, 'deepcodeGui.progress.heartbeat')} {lastHeartbeatText}</span>
                {serverVersion && <span>{serverVersion}</span>}
              </div>
              <div className="deepcode-gui-settings-sheet__body">
                <SettingsCenter
                  apiStatus={apiStatus}
                  wsStatus={wsStatus}
                  serverVersion={serverVersion}
                  tokenUsageProjection={liveTimelineProjection.tokenUsageProjection}
                  surface="gui"
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

export default DeepCodeWorkbenchLayout;
