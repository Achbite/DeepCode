import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentConversationActivity,
  AgentContextAttachment,
  AgentEvent,
  AgentSession,
  AgentTimelineResult,
  BrowseEntry,
  BrowsePathResult,
  InitialLocation,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { SessionMemorySnapshot } from '@deepcode/session-core';
import WindowControls from '../../components/window-controls/WindowControls';
import { normalizeUiLanguage, t, type UiLanguage } from '../../i18n';
import {
  browsePath,
  getAgentSessionMemorySnapshot,
  getInitialLocations,
  listAgentSessions,
} from '../../services/runtimeAdapter';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import { deriveTokenUsageStats, formatPercent, formatTokenCount } from '../../utils/tokenUsageStats';
import { buildUiTimelineProjection, latestPlanTaskItemsFromProjection } from '../../utils/uiTimelineProjection';
import AgentMemoryViewer from '../../components/agent-memory/AgentMemoryViewer';
import DeepCodeAgentPanel from '../panel/DeepCodeAgentPanel';
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

interface DeepCodeTaskItem {
  id: string;
  title: string;
  summary: string;
  status: string;
}

interface DeepCodeSubAgentWorkItem {
  id: string;
  title: string;
  summary: string;
  status: string;
  branchId?: string;
  subAgentId?: string;
  mergeGroupId?: string;
  targets: string[];
  error?: string;
  thinkingPreview?: string;
  progressSummary?: string;
}

interface DeepCodeCacheHitSummary {
  label: string;
  title: string;
}

type DeepCodeSidebarIconName = 'compose' | 'folder' | 'folderPlus' | 'plus' | 'settings';

interface DeepCodeProjectArchiveGroup {
  key: string;
  title: string;
  sessions: AgentSession[];
  projectId?: string;
}

interface DeepCodeGuiProject {
  id: string;
  title: string;
  sessionIds: string[];
  workspaceFolderPath?: string;
  defaultSessionDirectoryPath?: string;
  fixedContextAttachments?: AgentContextAttachment[];
  createdAt: string;
  updatedAt: string;
}

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

interface DeepCodeMemoryPanel {
  kind: 'project' | 'session';
  title: string;
  subtitle?: string;
  sessionIds: string[];
  snapshots: SessionMemorySnapshot[];
  loading: boolean;
  error?: string | null;
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

interface PendingProjectSession {
  projectId: string;
  sessionId: string;
}

const DEEPCODE_GUI_PROJECTS_STORAGE_KEY = 'deepcode-gui.projects.v1';
const EMPTY_AGENT_EVENTS: AgentEvent[] = [];
const EMPTY_PROJECTION_DELTAS: ProjectionDelta[] = [];

const DeepCodeSidebarIcon: React.FC<{ name: DeepCodeSidebarIconName; className?: string }> = ({
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

function basename(path?: string | null): string {
  if (!path) return '';
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function statusLabel(language: UiLanguage, value: string): string {
  const translated = t(language, `deepcodeGui.status.${value}`);
  return translated.startsWith('deepcodeGui.status.') ? value : translated;
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

function shouldShowSidebarSession(session: AgentSession): boolean {
  return (session.eventCount ?? 0) > 0 || hasCustomSessionTitle(session.title);
}

function projectDirectoryAttachment(absolutePath: string): AgentContextAttachment {
  return {
    kind: 'directory',
    path: '.',
    absolutePath,
    source: 'userSelected',
    scope: 'session',
  };
}

function projectFixedContextAttachments(project: DeepCodeGuiProject | null | undefined): AgentContextAttachment[] {
  if (!project) return [];
  if (project.fixedContextAttachments?.length) return project.fixedContextAttachments;
  return project.defaultSessionDirectoryPath
    ? [projectDirectoryAttachment(project.defaultSessionDirectoryPath)]
    : [];
}

function readProjectFixedContextAttachments(value: unknown): AgentContextAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentContextAttachment[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Partial<AgentContextAttachment>;
    if (record.kind !== 'directory' && record.kind !== 'file' && record.kind !== 'panelSnapshot') return [];
    if (typeof record.path !== 'string') return [];
    if (record.source !== 'mention' && record.source !== 'contextMenu' && record.source !== 'browser' && record.source !== 'userSelected') return [];
    if (record.scope !== 'message' && record.scope !== 'session') return [];
    const attachment: AgentContextAttachment = {
      kind: record.kind,
      path: record.path,
      source: record.source,
      scope: record.scope,
    };
    if (typeof record.absolutePath === 'string') attachment.absolutePath = record.absolutePath;
    if (typeof record.folderId === 'string') attachment.folderId = record.folderId;
    if (record.snapshot) attachment.snapshot = record.snapshot;
    return [attachment];
  });
}

function readGuiProjects(): DeepCodeGuiProject[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(DEEPCODE_GUI_PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): DeepCodeGuiProject[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Partial<DeepCodeGuiProject>;
      if (!record.id || !record.title) return [];
      const workspaceFolderPath = typeof record.workspaceFolderPath === 'string'
        ? record.workspaceFolderPath
        : undefined;
      const defaultSessionDirectoryPath = typeof record.defaultSessionDirectoryPath === 'string'
        ? record.defaultSessionDirectoryPath
        : workspaceFolderPath;
      const storedAttachments = readProjectFixedContextAttachments(record.fixedContextAttachments);
      const fixedContextAttachments = storedAttachments.length > 0
        ? storedAttachments
        : defaultSessionDirectoryPath
          ? [projectDirectoryAttachment(defaultSessionDirectoryPath)]
          : undefined;
      const project: DeepCodeGuiProject = {
        id: String(record.id),
        title: String(record.title),
        sessionIds: Array.isArray(record.sessionIds)
          ? record.sessionIds.flatMap((id) => typeof id === 'string' ? [id] : [])
          : [],
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
      };
      if (workspaceFolderPath) project.workspaceFolderPath = workspaceFolderPath;
      if (defaultSessionDirectoryPath) project.defaultSessionDirectoryPath = defaultSessionDirectoryPath;
      if (fixedContextAttachments) project.fixedContextAttachments = fixedContextAttachments;
      return [project];
    });
  } catch {
    return [];
  }
}

function writeGuiProjects(projects: DeepCodeGuiProject[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEEPCODE_GUI_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // localStorage can be unavailable in restricted WebView modes; project grouping stays in memory.
  }
}

function deriveProjectArchiveGroups(
  sessions: AgentSession[],
  projects: DeepCodeGuiProject[]
): DeepCodeProjectArchiveGroup[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  return projects.map((project) => {
    const projectSessions = project.sessionIds
      .flatMap((sessionId) => {
        const session = sessionById.get(sessionId);
        return session ? [session] : [];
      })
      .filter(shouldShowSidebarSession)
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    return {
      key: project.id,
      title: project.title,
      sessions: projectSessions,
      projectId: project.id,
    };
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
  if (event.kind === 'user_guidance') return t(language, 'deepcodeGui.tasks.guidance');
  if (event.kind === 'requirement_confirmation' || event.kind === 'requirement_decision') {
    return t(language, 'deepcodeGui.tasks.requirement');
  }
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
  if (event.kind === 'user_guidance') {
    return stringField(event.payload, 'status') === 'consumed' ? 'completed' : 'queued';
  }
  if (event.kind === 'requirement_confirmation') {
    return stringField(event.payload, 'status') === 'waitingUserConfirmation' ? 'waiting' : 'completed';
  }
  if (event.kind === 'requirement_decision') {
    const status = stringField(event.payload, 'status');
    if (status === 'rejected') return 'failed';
    if (status === 'needsRevision') return 'waiting';
    return 'completed';
  }
  if (event.kind === 'permission_request' || event.kind === 'plan_card' || event.kind === 'plan_review') return 'waiting';
  if (event.kind === 'tool_call' || event.kind === 'workflow_stage') return 'running';
  return 'completed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
}

function latestTurnEvents(events: AgentEvent[]): AgentEvent[] {
  const lastUserIndex = events.reduce(
    (last, event, index) => (event.kind === 'user_msg' ? index : last),
    -1
  );
  return lastUserIndex >= 0 ? events.slice(lastUserIndex + 1) : events;
}

function taskDedupKey(event: AgentEvent): string {
  const stage = stringField(event.payload, 'stage') ?? stringField(event.payload, 'phase');
  const runId = stringField(event.payload, 'runId');
  const planId = stringField(event.payload, 'planId');
  const callId = stringField(event.payload, 'callId') ?? stringField(event.payload, 'toolCallId');
  const requestId = stringField(event.payload, 'requestId') ?? stringField(event.payload, 'permissionId');
  const toolName = stringField(event.payload, 'toolName') ?? stringField(event.payload, 'tool');

  if (event.kind === 'workflow_stage' || event.kind === 'workflow_decision') {
    return `workflow:${stage ?? 'workflow'}:${runId ?? ''}`;
  }
  if (event.kind === 'tool_call' || event.kind === 'tool_result') {
    return `tool:${callId ?? toolName ?? eventText(event)}`;
  }
  if (event.kind === 'permission_request' || event.kind === 'permission_result') {
    return `permission:${requestId ?? toolName ?? eventText(event)}`;
  }
  if (event.kind === 'plan_card' || event.kind === 'plan_review') {
    return `plan:${planId ?? runId ?? eventText(event)}`;
  }
  if (event.kind === 'requirement_confirmation' || event.kind === 'requirement_decision') {
    const requirementId = stringField(event.payload, 'requirementId');
    return `requirement:${requirementId ?? runId ?? eventText(event)}`;
  }
  if (event.kind === 'review_summary') {
    return `review:${runId ?? eventText(event)}`;
  }
  if (event.kind === 'user_guidance') {
    const guidanceId = stringField(event.payload, 'guidanceId');
    const targetRunId = stringField(event.payload, 'targetRunId');
    return `guidance:${guidanceId ?? targetRunId ?? runId ?? event.id}`;
  }
  if (event.kind === 'error') {
    return `error:${eventText(event)}`;
  }
  return `${event.kind}:${event.id}`;
}

function dedupeTaskItems(items: DeepCodeTaskItem[]): DeepCodeTaskItem[] {
  const byKey = new Map<string, DeepCodeTaskItem>();
  for (const item of items) {
    const key = `${item.title.trim()}::${item.summary.trim() || item.id}`;
    byKey.set(key, item);
  }
  return Array.from(byKey.values());
}

function deriveTaskItems(
  projection: AgentTimelineResult,
  language: UiLanguage,
  loading: boolean,
  fallbackItems: DeepCodeTaskItem[] = []
): DeepCodeTaskItem[] {
  const projectedItems = latestPlanTaskItemsFromProjection(projection);

  if (projectedItems.length > 0) {
    return dedupeTaskItems(
      projectedItems.map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        status: item.status,
      }))
    ).slice(-6);
  }

  if (fallbackItems.length > 0) {
    return fallbackItems;
  }

  if (loading) {
    return [
      {
        id: 'runtime-preparing',
        title: t(language, 'deepcodeGui.tasks.running'),
        summary: t(language, 'deepcodeGui.tasks.runningSummary'),
        status: 'running',
      },
    ];
  }

  return [];
}

function deriveCacheHitSummary(
  events: AgentEvent[],
  language: UiLanguage,
  tokenUsageProjection?: AgentTimelineResult['tokenUsageProjection'] | null
): DeepCodeCacheHitSummary | null {
  const stats = deriveTokenUsageStats(events, tokenUsageProjection);
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

function isSubAgentActivity(activity: AgentConversationActivity): boolean {
  return activity.kind === 'subagentBranch' || activity.kind === 'subagentMerge';
}

function subAgentWorkItemFromActivity(activity: AgentConversationActivity): DeepCodeSubAgentWorkItem {
  return {
    id: activity.activityId,
    title: activity.title,
    summary: activity.summary,
    status: activity.status,
    branchId: activity.branchId,
    subAgentId: activity.subAgentId,
    mergeGroupId: activity.mergeGroupId,
    targets: activity.targets ?? [],
    error: [activity.errorCode, activity.errorMessage].filter(Boolean).join(' - ') || undefined,
  };
}

function subAgentDeltaKey(delta: ProjectionDelta): string | null {
  return delta.branchId ?? delta.subAgentId ?? delta.mergeGroupId ?? null;
}

function safeSubAgentWorkId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'branch';
}

function subAgentDeltaStatus(delta: ProjectionDelta): string {
  if (delta.status === 'failed' || delta.type === 'error') return 'failed';
  if (delta.status === 'completed') return 'completed';
  if (delta.status === 'waiting' || delta.status === 'skipped' || delta.status === 'discarded') return 'blocked';
  if (delta.status === 'queued') return 'queued';
  return 'running';
}

function findSubAgentWorkItem(
  byId: Map<string, DeepCodeSubAgentWorkItem>,
  delta: ProjectionDelta
): DeepCodeSubAgentWorkItem | null {
  for (const item of byId.values()) {
    if (delta.branchId && item.branchId === delta.branchId) return item;
    if (delta.subAgentId && item.subAgentId === delta.subAgentId) return item;
    if (delta.mergeGroupId && item.mergeGroupId === delta.mergeGroupId) return item;
  }
  return null;
}

function mergeSubAgentDelta(
  byId: Map<string, DeepCodeSubAgentWorkItem>,
  delta: ProjectionDelta,
  language: UiLanguage
): void {
  const key = subAgentDeltaKey(delta);
  if (!key) return;
  const existing = findSubAgentWorkItem(byId, delta);
  const item = existing ?? {
    id: `active-subagent-${safeSubAgentWorkId(key)}`,
    title: t(language, 'deepcodeGui.subagents.branchFallback'),
    summary: delta.summary ?? t(language, 'deepcodeGui.subagents.streaming'),
    status: subAgentDeltaStatus(delta),
    branchId: delta.branchId,
    subAgentId: delta.subAgentId,
    mergeGroupId: delta.mergeGroupId,
    targets: delta.targetPath ? [delta.targetPath] : [],
  };
  item.status = subAgentDeltaStatus(delta);
  if (delta.summary) item.progressSummary = delta.summary;
  if (delta.targetPath && !item.targets.includes(delta.targetPath)) {
    item.targets = [...item.targets, delta.targetPath];
  }
  if (delta.type === 'reasoning_delta' && typeof delta.delta === 'string') {
    const next = `${item.thinkingPreview ?? ''}${delta.delta}`;
    item.thinkingPreview = next.length > 360 ? next.slice(-360) : next;
  } else if ((delta.type === 'assistant_delta' || delta.type === 'draft_delta' || delta.type === 'part_delta') && typeof delta.delta === 'string') {
    const next = `${item.progressSummary ?? ''}${delta.delta}`;
    item.progressSummary = next.length > 240 ? next.slice(-240) : next;
  }
  byId.set(item.id, item);
}

function deriveSubAgentWorkItems(
  projection: AgentTimelineResult,
  activeDeltas: ProjectionDelta[],
  language: UiLanguage,
  sessionId?: string
): DeepCodeSubAgentWorkItem[] {
  const byId = new Map<string, DeepCodeSubAgentWorkItem>();
  for (const turn of projection.turns) {
    for (const block of turn.blocks) {
      const activity = block.activity;
      if (activity && isSubAgentActivity(activity)) {
        byId.set(activity.activityId, subAgentWorkItemFromActivity(activity));
      }
    }
  }
  for (const delta of activeDeltas) {
    if (delta.type === 'committed') continue;
    if (sessionId && delta.sessionId !== sessionId) continue;
    const activity = delta.activity;
    if (activity && isSubAgentActivity(activity)) {
      byId.set(activity.activityId, subAgentWorkItemFromActivity(activity));
      continue;
    }
    mergeSubAgentDelta(byId, delta, language);
  }
  return [...byId.values()].slice(-8);
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
  const [projectRecords, setProjectRecords] = useState<DeepCodeGuiProject[]>(() => readGuiProjects());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [draftTargetProjectId, setDraftTargetProjectId] = useState<string | null>(null);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const [sessionMenu, setSessionMenu] = useState<DeepCodeSessionContextMenu | null>(null);
  const [projectMenu, setProjectMenu] = useState<DeepCodeProjectContextMenu | null>(null);
  const [projectCreateMenu, setProjectCreateMenu] = useState<DeepCodeProjectCreateMenu | null>(null);
  const [projectFolderDialogOpen, setProjectFolderDialogOpen] = useState(false);
  const [textDialog, setTextDialog] = useState<DeepCodeTextInputDialog | null>(null);
  const [memoryPanel, setMemoryPanel] = useState<DeepCodeMemoryPanel | null>(null);
  const [sidebarPendingAction, setSidebarPendingAction] = useState<string | null>(null);
  const pendingProjectSendRef = useRef<PendingProjectSession | null>(null);
  const sidebarPendingActionRef = useRef<string | null>(null);
  const lastPlanTaskItemsRef = useRef<{ sessionId: string | null; items: DeepCodeTaskItem[] }>({
    sessionId: null,
    items: [],
  });
  const workspace = useWorkspaceStore((s) => s.current);
  const activeFolderId = useWorkspaceStore((s) => s.activeFolderId);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const activeSession = useAgentSessionStore((s) => s.session);
  const loadingSession = useAgentSessionStore((s) => s.loading);
  const runningSessionIds = useAgentSessionStore((s) => s.runningSessionIds);
  const events = useAgentSessionStore((s) => s.events);
  const activeDeltas = useAgentSessionStore((s) => s.activeDeltas);
  const createNewSession = useAgentSessionStore((s) => s.createNewSession);
  const activateSession = useAgentSessionStore((s) => s.activateSession);
  const renameSession = useAgentSessionStore((s) => s.renameSession);
  const deleteSession = useAgentSessionStore((s) => s.deleteSession);
  const setFixedContextAttachments = useAgentSessionStore((s) => s.setFixedContextAttachments);
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const projectMemoryMode = useSettingsStore((s) =>
    s.effectiveSettings['agent.memory.projectMode'] === 'auto' ? 'auto' : 'confirm'
  );

  useEffect(() => {
    if (typeof performance === 'undefined') return;
    performance.mark('deepcode-gui:workbench-ready');
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadKnownSessions = async () => {
      const result = await listAgentSessions({ includeArchived: true });
      if (cancelled) return;
      if (result.ok && result.data) {
        setKnownSessions(result.data.sessions);
      }
    };
    void loadKnownSessions();
    const interval = window.setInterval(() => void loadKnownSessions(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessions.length, activeSession?.id]);

  useEffect(() => {
    writeGuiProjects(projectRecords);
  }, [projectRecords]);

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
  const projectDraftActive = Boolean(draftTargetProjectId);
  const projectionEvents = projectDraftActive ? EMPTY_AGENT_EVENTS : events;
  const liveTimelineProjection = useMemo(
    () => buildUiTimelineProjection({
      sessionId: projectDraftActive ? 'project-draft' : activeSession?.id ?? projectionEvents[0]?.sessionId ?? 'session',
      events: projectionEvents,
      activeDeltas: projectDraftActive ? [] : activeDeltas,
    }),
    [activeDeltas, activeSession?.id, projectDraftActive, projectionEvents]
  );
  const taskItems = useMemo(() => {
    const taskSessionId = projectDraftActive ? null : activeSession?.id ?? null;
    const fallbackItems = lastPlanTaskItemsRef.current.sessionId === taskSessionId
      ? lastPlanTaskItemsRef.current.items
      : [];
    const items = deriveTaskItems(
      liveTimelineProjection,
      language,
      !projectDraftActive && Boolean(activeSession?.id && runningSessionIds.includes(activeSession.id)),
      fallbackItems
    );
    if (items.length > 0 && items.some((item) => item.id !== 'runtime-preparing')) {
      lastPlanTaskItemsRef.current = { sessionId: taskSessionId, items };
    }
    if (items.length === 0 && lastPlanTaskItemsRef.current.sessionId !== taskSessionId) {
      lastPlanTaskItemsRef.current = { sessionId: taskSessionId, items: [] };
    }
    return items;
  }, [activeSession?.id, liveTimelineProjection, language, projectDraftActive, runningSessionIds]);
  const subAgentWorkItems = useMemo(
    () => projectDraftActive
      ? []
      : deriveSubAgentWorkItems(liveTimelineProjection, EMPTY_PROJECTION_DELTAS, language, activeSession?.id),
    [activeSession?.id, language, liveTimelineProjection, projectDraftActive]
  );
  const cacheHitSummary = useMemo(
    () => deriveCacheHitSummary(projectionEvents, language, liveTimelineProjection.tokenUsageProjection),
    [projectionEvents, language, liveTimelineProjection.tokenUsageProjection]
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
    const ids = new Set<string>();
    for (const project of projectRecords) {
      for (const sessionId of project.sessionIds) ids.add(sessionId);
    }
    return ids;
  }, [projectRecords]);
  const displaySessions = useMemo(() => {
    const byId = new Map<string, AgentSession>();
    for (const session of knownSessions) byId.set(session.id, session);
    for (const session of sessions) byId.set(session.id, session);
    if (activeSession?.id) {
      byId.set(activeSession.id, {
        ...byId.get(activeSession.id),
        ...activeSession,
        eventCount: Math.max(activeSession.eventCount ?? 0, events.length),
      });
    }
    return Array.from(byId.values());
  }, [activeSession, events.length, knownSessions, sessions]);
  const displaySessionById = useMemo(
    () => new Map(displaySessions.map((session) => [session.id, session])),
    [displaySessions]
  );
  const memorySessionLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const session of displaySessions) {
      labels[session.id] = displaySessionTitle(language, session.title);
    }
    return labels;
  }, [displaySessions, language]);
  const activeSessionRunning = Boolean(activeSession?.id && runningSessionIds.includes(activeSession.id));
  const highlightedSessionId = projectDraftActive ? null : activeSession?.id ?? null;
  const isHome = projectDraftActive
    || (events.length === 0 && !loadingSession && !activeSessionRunning);
  const visibleSessions = useMemo(
    () => displaySessions.filter((item) => {
      if (item.archivedAt) return false;
      if (assignedProjectSessionIds.has(item.id)) return false;
      const currentWithEvents = item.id === activeSession?.id && events.length > 0;
      return shouldShowSidebarSession(item) || currentWithEvents;
    }),
    [activeSession?.id, assignedProjectSessionIds, displaySessions, events.length]
  );
  const projectArchiveGroups = useMemo(
    () => deriveProjectArchiveGroups(displaySessions, projectRecords),
    [displaySessions, projectRecords]
  );
  const collapsedProjectIdSet = useMemo(
    () => new Set(collapsedProjectIds),
    [collapsedProjectIds]
  );

  useEffect(() => {
    setFixedContextAttachments(projectFixedContextAttachments(draftProject ?? activeProject));
  }, [activeProject, draftProject, setFixedContextAttachments]);

  const moveSessionToProject = (projectId: string, sessionId: string) => {
    const now = new Date().toISOString();
    setProjectRecords((current) => current.map((project) => {
      const nextSessionIds = project.sessionIds.filter((id) => id !== sessionId);
      if (project.id !== projectId) {
        return nextSessionIds.length === project.sessionIds.length
          ? project
          : { ...project, sessionIds: nextSessionIds, updatedAt: now };
      }
      return {
        ...project,
        sessionIds: [sessionId, ...nextSessionIds],
        updatedAt: now,
      };
    }));
  };

  const upsertKnownSession = (session: AgentSession) => {
    setKnownSessions((current) => [
      session,
      ...current.filter((item) => item.id !== session.id),
    ]);
  };

  const handleCreateSession = async (projectId?: string | null) => {
    const targetProjectId = projectId ?? null;
    pendingProjectSendRef.current = null;
    const targetProject = targetProjectId
      ? projectRecords.find((project) => project.id === targetProjectId) ?? null
      : null;
    setFixedContextAttachments(projectFixedContextAttachments(targetProject));
    setActiveProjectId(null);
    setDraftTargetProjectId(targetProjectId);
    if (targetProjectId) {
      return;
    }
    const nextSession = await createNewSession({ reuseEmpty: false });
    if (nextSession?.id) {
      upsertKnownSession(nextSession);
    }
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

  const prepareProjectDraftSession = async () => {
    if (!draftTargetProjectId) return true;
    const targetProjectId = draftTargetProjectId;
    const targetProject = projectRecords.find((project) => project.id === targetProjectId) ?? null;
    setFixedContextAttachments(projectFixedContextAttachments(targetProject));
    pendingProjectSendRef.current = null;
    const nextSession = await createNewSession({ reuseEmpty: false });
    if (!nextSession?.id) {
      return false;
    }
    pendingProjectSendRef.current = {
      projectId: targetProjectId,
      sessionId: nextSession.id,
    };
    moveSessionToProject(targetProjectId, nextSession.id);
    upsertKnownSession(nextSession);
    setActiveProjectId(targetProjectId);
    setDraftTargetProjectId(null);
    return true;
  };

  const commitDraftProjectSession = async () => {
    const pending = pendingProjectSendRef.current;
    if (!pending) return;
    pendingProjectSendRef.current = null;
    const state = useAgentSessionStore.getState();
    const updatedSession = state.session?.id === pending.sessionId
      ? state.session
      : state.sessions.find((item) => item.id === pending.sessionId);
    moveSessionToProject(pending.projectId, pending.sessionId);
    if (updatedSession) {
      upsertKnownSession(updatedSession);
    }
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
    setProjectFolderDialogOpen(true);
  };

  const commitProjectName = async (title: string, projectFolderPath?: string) => {
    if (!title) return;
    const now = new Date().toISOString();
    const project: DeepCodeGuiProject = {
      id: `project-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      title,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    if (projectFolderPath) {
      project.workspaceFolderPath = projectFolderPath;
      project.defaultSessionDirectoryPath = projectFolderPath;
      project.fixedContextAttachments = [projectDirectoryAttachment(projectFolderPath)];
    }
    setProjectRecords((current) => [project, ...current]);
    setActiveProjectId(null);
    setDraftTargetProjectId(project.id);
  };

  const commitProjectFolderPath = (projectFolderPath: string) => {
    setProjectFolderDialogOpen(false);
    const defaultName = basename(projectFolderPath) || t(language, 'deepcodeGui.project.defaultName');
    void commitProjectName(defaultName, projectFolderPath);
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

  const commitProjectRename = (project: DeepCodeGuiProject, nextTitle: string) => {
    if (!nextTitle) return;
    const now = new Date().toISOString();
    setProjectRecords((current) => current.map((item) =>
      item.id === project.id ? { ...item, title: nextTitle, updatedAt: now } : item
    ));
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
      commitProjectRename(textDialog.project, value);
      return;
    }
    if (textDialog.kind === 'renameSession' && textDialog.session) {
      await commitSessionRename(textDialog.session, value);
    }
  };

  const handleDeleteSession = async (session: AgentSession) => {
    setSessionMenu(null);
    await deleteSession(session.id);
    setKnownSessions((current) => current.filter((item) => item.id !== session.id));
    setProjectRecords((current) => current.map((project) => ({
      ...project,
      sessionIds: project.sessionIds.filter((id) => id !== session.id),
    })));
  };

  const handleCopySessionId = async (session: AgentSession) => {
    setSessionMenu(null);
    await copyText(session.id);
  };

  const loadMemoryPanelSnapshots = async (
    basePanel: Omit<DeepCodeMemoryPanel, 'snapshots' | 'loading' | 'error'>
  ) => {
    setMemoryPanel({
      ...basePanel,
      snapshots: [],
      loading: true,
      error: null,
    });
    const snapshots: SessionMemorySnapshot[] = [];
    let error: string | null = null;
    for (const sessionId of basePanel.sessionIds) {
      const result = await getAgentSessionMemorySnapshot(sessionId, { projectMemoryMode });
      if (result.ok && result.data) {
        snapshots.push(result.data);
      } else {
        error = result.message ?? result.error ?? t(language, 'memory.loadFailed');
      }
    }
    setMemoryPanel({
      ...basePanel,
      snapshots,
      loading: false,
      error,
    });
  };

  const handleOpenSessionMemory = (session: AgentSession) => {
    setSessionMenu(null);
    void loadMemoryPanelSnapshots({
      kind: 'session',
      title: t(language, 'memory.sessionMemory'),
      subtitle: displaySessionTitle(language, session.title),
      sessionIds: [session.id],
    });
  };

  const handleOpenProjectMemory = (project: DeepCodeGuiProject) => {
    setProjectMenu(null);
    const sessionIds = project.sessionIds.filter((sessionId) => displaySessionById.has(sessionId));
    void loadMemoryPanelSnapshots({
      kind: 'project',
      title: t(language, 'memory.projectMemory'),
      subtitle: project.title,
      sessionIds,
    });
  };

  const handleMoveSessionToProject = (session: AgentSession, projectId: string) => {
    setSessionMenu(null);
    moveSessionToProject(projectId, session.id);
    if (activeSession?.id === session.id) {
      setActiveProjectId(projectId);
    }
    setDraftTargetProjectId(null);
  };

  const handleDeleteProject = (project: DeepCodeGuiProject) => {
    setProjectMenu(null);
    setProjectRecords((current) => current.filter((item) => item.id !== project.id));
    setCollapsedProjectIds((current) => current.filter((id) => id !== project.id));
    if (activeProjectId === project.id) setActiveProjectId(null);
    if (draftTargetProjectId === project.id) setDraftTargetProjectId(null);
  };

  return (
    <div className="deepcode-gui-workbench">
      <header className="deepcode-gui-titlebar" data-tauri-drag-region>
        <div className="deepcode-gui-titlebar__brand">
          <span className="deepcode-gui-titlebar__mark">DC</span>
          <span>DeepCode-GUI</span>
        </div>
        <div className="deepcode-gui-titlebar__status">
          {cacheHitSummary && (
            <span className="deepcode-gui-status-pill deepcode-gui-status-pill--cache" title={cacheHitSummary.title}>
              {cacheHitSummary.label}
            </span>
          )}
          {apiStatus !== 'connected' && onRetryKernelStart && (
            <button
              type="button"
              className="deepcode-gui-status-pill deepcode-gui-status-pill--button"
              title={kernelStartMessage ?? undefined}
              disabled={kernelStartBusy}
              onClick={() => void onRetryKernelStart()}
            >
              {kernelStartBusy
                ? t(language, 'deepcodeGui.statusAction.starting')
                : t(language, 'deepcodeGui.statusAction.retry')}
            </button>
          )}
          <span className={`deepcode-gui-status-pill deepcode-gui-status-pill--${apiStatus}`}>API {statusLabel(language, apiStatus)}</span>
        </div>
        <WindowControls language={language} />
      </header>

      <div className={`deepcode-gui-shell ${isHome ? 'deepcode-gui-shell--home' : ''}`}>
        <aside className="deepcode-gui-left-rail">
          <div className="deepcode-gui-sidebar-actions">
            <button
              type="button"
              className="deepcode-gui-sidebar-action deepcode-gui-sidebar-action--primary"
              onClick={() => void runSidebarAction('create:normal:primary', () => handleCreateSession(null))}
              disabled={sidebarPendingAction === 'create:normal:primary'}
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
                onClick={openProjectCreateMenu}
                aria-haspopup="menu"
                aria-expanded={Boolean(projectCreateMenu)}
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
                  const projectCollapsed = Boolean(
                    group.projectId && collapsedProjectIdSet.has(group.projectId)
                  );
                  const projectIsCurrent = Boolean(
                    group.projectId
                    && (group.projectId === activeProjectId || group.projectId === draftTargetProjectId)
                  );
                  const projectCreateActionKey = group.projectId ? `create:project:${group.projectId}` : '';
                  return (
                    <div
                      key={group.key}
                      className={`deepcode-gui-project-archive-group${projectIsCurrent ? ' deepcode-gui-project-archive-group--current' : ''}`}
                    >
                      <div
                        className="deepcode-gui-project-archive-group__title"
                        onContextMenu={(event) => {
                          if (projectRecord) openProjectContextMenu(event, projectRecord);
                        }}
                      >
                      <button
                        type="button"
                        className="deepcode-gui-project-archive-group__select"
                        onClick={() => group.projectId && toggleProjectExpanded(group.projectId)}
                        onContextMenu={(event) => {
                          if (projectRecord) openProjectContextMenu(event, projectRecord);
                        }}
                        disabled={!group.projectId}
                        aria-expanded={!projectCollapsed}
                        title={projectRecord?.workspaceFolderPath ?? group.title}
                      >
                        <DeepCodeSidebarIcon name="folder" className="deepcode-gui-sidebar-icon" />
                        <span>{group.title}</span>
                      </button>
                      {group.projectId && (
                        <div className="deepcode-gui-project-archive-group__actions" aria-hidden={false}>
                          <button
                            type="button"
                            className="deepcode-gui-project-archive-group__compose"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!group.projectId) return;
                              void runSidebarAction(projectCreateActionKey, () => handleCreateSession(group.projectId));
                            }}
                            disabled={Boolean(projectCreateActionKey && sidebarPendingAction === projectCreateActionKey)}
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
                          {group.sessions.slice(0, 4).map((item, itemIndex) => {
                            const shortcutIndex = groupIndex + itemIndex + 1;
                            const activateActionKey = `activate:project:${item.id}`;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                className={item.id === highlightedSessionId ? 'active' : ''}
                                onClick={() => {
                                  void runSidebarAction(activateActionKey, async () => {
                                    pendingProjectSendRef.current = null;
                                    setActiveProjectId(group.projectId ?? null);
                                    setDraftTargetProjectId(null);
                                    setFixedContextAttachments(projectFixedContextAttachments(projectRecord));
                                    await activateSession(item.id);
                                  });
                                }}
                                onContextMenu={(event) => openSessionContextMenu(event, item)}
                                disabled={sidebarPendingAction === activateActionKey}
                                title={item.title || item.id}
                              >
                                <span>{displaySessionTitle(language, item.title)}</span>
                                {shortcutIndex <= 9 && (
                                  <kbd>⌘{shortcutIndex}</kbd>
                                )}
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
                onClick={() => void runSidebarAction('create:normal:nested', () => handleCreateSession(null))}
                disabled={sidebarPendingAction === 'create:normal:nested'}
                aria-label={t(language, 'deepcodeGui.nav.newChat')}
                title={t(language, 'deepcodeGui.nav.newChat')}
              >
                <DeepCodeSidebarIcon name="compose" />
              </button>
            </div>
            {visibleSessions.length > 0 && (
              <div className="deepcode-gui-session-list">
                {visibleSessions.slice(0, 8).map((item) => (
                  (() => {
                    const activateActionKey = `activate:chat:${item.id}`;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={item.id === highlightedSessionId ? 'active' : ''}
                        onClick={() => {
                          void runSidebarAction(activateActionKey, async () => {
                            pendingProjectSendRef.current = null;
                            setActiveProjectId(null);
                            setDraftTargetProjectId(null);
                            setFixedContextAttachments([]);
                            await activateSession(item.id);
                          });
                        }}
                        onContextMenu={(event) => openSessionContextMenu(event, item)}
                        disabled={sidebarPendingAction === activateActionKey}
                        title={item.title || item.id}
                      >
                        <span>{displaySessionTitle(language, item.title)}</span>
                      </button>
                    );
                  })()
                ))}
              </div>
            )}
          </section>

          <div className="deepcode-gui-sidebar-spacer" />
          <button
            type="button"
            className="deepcode-gui-sidebar-settings"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="deepcode-gui-sidebar-settings__icon">
              <DeepCodeSidebarIcon name="settings" />
            </span>
            <span>{t(language, 'settings.title')}</span>
          </button>
        </aside>

        <main className="deepcode-gui-session-main">
          <DeepCodeAgentPanel
            language={language}
            forceHome={projectDraftActive}
            homeProjectTitle={draftProject?.title ?? activeProject?.title ?? null}
            suppressPendingDecision={projectDraftActive}
            onBeforeSend={prepareProjectDraftSession}
            onAfterSend={commitDraftProjectSession}
          />
        </main>

        <aside className="deepcode-gui-context-panel">
          <section className="deepcode-gui-task-list-card">
            <div className="deepcode-gui-task-list-card__title">{t(language, 'deepcodeGui.tasks.title')}</div>
            {taskItems.length === 0 ? (
              <div className="deepcode-gui-task-list-card__empty">{t(language, 'deepcodeGui.tasks.empty')}</div>
            ) : (
              <div className="deepcode-gui-task-list">
                {taskItems.map((item) => (
                  <div key={item.id} className={`deepcode-gui-task-item deepcode-gui-task-item--${item.status}`}>
                    <span className="deepcode-gui-task-item__dot" />
                    <div>
                      <div className="deepcode-gui-task-item__title">{item.title}</div>
                      <div className="deepcode-gui-task-item__summary">{item.summary}</div>
                    </div>
                    <strong>{statusLabel(language, item.status)}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>

          {subAgentWorkItems.length > 0 && (
            <section className="deepcode-gui-subagent-work-card">
              <div className="deepcode-gui-subagent-work-card__title">
                {t(language, 'deepcodeGui.subagents.title')}
              </div>
              <div className="deepcode-gui-subagent-work-list">
                {subAgentWorkItems.map((item) => (
                    <div
                      key={item.id}
                      className={`deepcode-gui-subagent-work-item deepcode-gui-subagent-work-item--${item.status}`}
                    >
                      <span className="deepcode-gui-subagent-work-item__dot" />
                      <div className="deepcode-gui-subagent-work-item__body">
                        <div className="deepcode-gui-subagent-work-item__topline">
                          <span className="deepcode-gui-subagent-work-item__title">{item.title}</span>
                          <strong>{statusLabel(language, item.status)}</strong>
                        </div>
                        {item.summary && (
                          <div className="deepcode-gui-subagent-work-item__summary">{item.summary}</div>
                        )}
                        {item.progressSummary && item.progressSummary !== item.summary && (
                          <div className="deepcode-gui-subagent-work-item__summary">{item.progressSummary}</div>
                        )}
                        {item.thinkingPreview && (
                          <div className="deepcode-gui-subagent-work-item__thinking">
                            <strong>{t(language, 'deepcodeGui.subagents.reasoning')}</strong>
                            <span>{item.thinkingPreview}</span>
                          </div>
                        )}
                        {item.error && (
                          <div className="deepcode-gui-subagent-work-item__error">{item.error}</div>
                        )}
                      </div>
                    </div>
                ))}
              </div>
            </section>
          )}
        </aside>
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
          <button type="button" role="menuitem" onClick={() => handleOpenSessionMemory(sessionMenu.session)}>
            {t(language, 'memory.openSessionMemory')}
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
                  onClick={() => handleMoveSessionToProject(sessionMenu.session, project.id)}
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
          <button type="button" role="menuitem" onClick={() => handleOpenProjectMemory(projectMenu.project)}>
            {t(language, 'memory.openProjectMemory')}
          </button>
          <button type="button" role="menuitem" onClick={() => handleRenameProject(projectMenu.project)}>
            {t(language, 'deepcodeGui.project.rename')}
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
          onCancel={() => setProjectFolderDialogOpen(false)}
          onSelect={commitProjectFolderPath}
        />
      )}

      {memoryPanel && (
        <div
          className="deepcode-gui-memory-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={memoryPanel.title}
          onMouseDown={() => setMemoryPanel(null)}
        >
          <section
            className="deepcode-gui-memory-sheet"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <AgentMemoryViewer
              language={language}
              title={memoryPanel.title}
              subtitle={memoryPanel.subtitle}
              snapshots={memoryPanel.snapshots}
              defaultScope={memoryPanel.kind === 'session' ? 'session' : 'project'}
              loading={memoryPanel.loading}
              error={memoryPanel.error}
              sessionLabels={memorySessionLabels}
              onRefresh={() => void loadMemoryPanelSnapshots({
                kind: memoryPanel.kind,
                title: memoryPanel.title,
                subtitle: memoryPanel.subtitle,
                sessionIds: memoryPanel.sessionIds,
              })}
              onClose={() => setMemoryPanel(null)}
            />
          </section>
        </div>
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
                <span>WS {statusLabel(language, wsStatus)}</span>
                <span>{t(language, 'deepcodeGui.progress.heartbeat')} {lastHeartbeatText}</span>
                {serverVersion && <span>{serverVersion}</span>}
              </div>
              <div className="deepcode-gui-settings-sheet__body">
                <SettingsCenter
                  apiStatus={apiStatus}
                  wsStatus={wsStatus}
                  serverVersion={serverVersion}
                  events={events}
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
