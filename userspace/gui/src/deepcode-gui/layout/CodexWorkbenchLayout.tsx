import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentSession } from '@deepcode/protocol';
import { buildNarrativeTimelineProjection } from '@deepcode/session-core';
import WindowControls from '../../components/window-controls/WindowControls';
import { normalizeUiLanguage, t, type UiLanguage } from '../../i18n';
import { listAgentSessions } from '../../services/runtimeAdapter';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import { deriveTokenUsageStats, formatPercent, formatTokenCount } from '../../utils/tokenUsageStats';
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

interface CodexCacheHitSummary {
  label: string;
  title: string;
}

type CodexSidebarIconName = 'compose' | 'folder' | 'plus' | 'settings';

interface CodexProjectArchiveGroup {
  key: string;
  title: string;
  sessions: AgentSession[];
  projectId?: string;
}

interface CodexGuiProject {
  id: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface CodexSessionContextMenu {
  session: AgentSession;
  x: number;
  y: number;
}

interface CodexProjectContextMenu {
  project: CodexGuiProject;
  x: number;
  y: number;
}

interface CodexTextInputDialog {
  kind: 'project' | 'renameSession' | 'renameProject';
  title: string;
  label: string;
  value: string;
  session?: AgentSession;
  project?: CodexGuiProject;
}

interface PendingProjectSession {
  projectId: string;
  sessionId: string;
}

const CODEX_GUI_PROJECTS_STORAGE_KEY = 'deepcode-gui.projects.v1';

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

function readGuiProjects(): CodexGuiProject[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CODEX_GUI_PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CodexGuiProject[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Partial<CodexGuiProject>;
      if (!record.id || !record.title) return [];
      return [{
        id: String(record.id),
        title: String(record.title),
        sessionIds: Array.isArray(record.sessionIds)
          ? record.sessionIds.flatMap((id) => typeof id === 'string' ? [id] : [])
          : [],
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
      }];
    });
  } catch {
    return [];
  }
}

function writeGuiProjects(projects: CodexGuiProject[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CODEX_GUI_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // localStorage can be unavailable in restricted WebView modes; project grouping stays in memory.
  }
}

function deriveProjectArchiveGroups(
  sessions: AgentSession[],
  projects: CodexGuiProject[]
): CodexProjectArchiveGroup[] {
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
  if (event.kind === 'review_summary') {
    return `review:${runId ?? eventText(event)}`;
  }
  if (event.kind === 'error') {
    return `error:${eventText(event)}`;
  }
  return `${event.kind}:${event.id}`;
}

function deriveTaskItems(
  events: AgentEvent[],
  language: UiLanguage,
  loading: boolean,
  sessionId?: string
): CodexTaskItem[] {
  const projection = buildNarrativeTimelineProjection({
    sessionId: sessionId ?? events[0]?.sessionId ?? 'session',
    events,
  });
  const latestTurn = projection.turns[projection.turns.length - 1];
  const latestTaskBlockIds = new Set(
    latestTurn?.blocks
      .filter((block) => block.displayHints?.showInTaskList)
      .map((block) => block.id) ?? []
  );
  const projectedItems = (projection.taskProjection?.items ?? [])
    .filter((item) => latestTaskBlockIds.has(item.blockId));

  if (projectedItems.length > 0) {
    return projectedItems.slice(-6).map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      status: item.status,
    }));
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
  tokenUsageProjection?: ReturnType<typeof buildNarrativeTimelineProjection>['tokenUsageProjection'] | null
): CodexCacheHitSummary | null {
  const stats = deriveTokenUsageStats(events, tokenUsageProjection);
  const percent = formatPercent(stats.cacheHitRate);
  const label = language === 'zh-CN' ? `缓存 ${percent}` : `Cache ${percent}`;
  if (!stats.hasCacheData) {
    return {
      label,
      title: language === 'zh-CN'
        ? '当前对话流程尚未收到缓存命中统计'
        : 'No cache hit telemetry has been reported for this conversation flow yet',
    };
  }
  const title = language === 'zh-CN'
    ? `当前对话流程累计缓存命中 ${formatTokenCount(stats.promptCacheHitTokens)} tokens，未命中 ${formatTokenCount(stats.promptCacheMissTokens)} tokens`
    : `Current conversation flow cache hits ${formatTokenCount(stats.promptCacheHitTokens)} tokens, misses ${formatTokenCount(stats.promptCacheMissTokens)} tokens`;
  return { label, title };
}

const CodexWorkbenchLayout: React.FC<CodexWorkbenchLayoutProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  lastHeartbeatAt,
}) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [knownSessions, setKnownSessions] = useState<AgentSession[]>([]);
  const [projectRecords, setProjectRecords] = useState<CodexGuiProject[]>(() => readGuiProjects());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const [sessionMenu, setSessionMenu] = useState<CodexSessionContextMenu | null>(null);
  const [projectMenu, setProjectMenu] = useState<CodexProjectContextMenu | null>(null);
  const [textDialog, setTextDialog] = useState<CodexTextInputDialog | null>(null);
  const pendingProjectSendRef = useRef<PendingProjectSession | null>(null);
  const workspace = useWorkspaceStore((s) => s.current);
  const activeFolderId = useWorkspaceStore((s) => s.activeFolderId);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const activeSession = useAgentSessionStore((s) => s.session);
  const loadingSession = useAgentSessionStore((s) => s.loading);
  const runningSessionIds = useAgentSessionStore((s) => s.runningSessionIds);
  const events = useAgentSessionStore((s) => s.events);
  const createNewSession = useAgentSessionStore((s) => s.createNewSession);
  const activateSession = useAgentSessionStore((s) => s.activateSession);
  const renameSession = useAgentSessionStore((s) => s.renameSession);
  const deleteSession = useAgentSessionStore((s) => s.deleteSession);
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
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
    if (!sessionMenu && !projectMenu) return undefined;
    const close = () => {
      setSessionMenu(null);
      setProjectMenu(null);
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
  }, [sessionMenu, projectMenu]);

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
  const taskItems = useMemo(
    () => deriveTaskItems(
      events,
      language,
      Boolean(activeSession?.id && runningSessionIds.includes(activeSession.id)),
      activeSession?.id
    ),
    [activeSession?.id, events, language, runningSessionIds]
  );
  const timelineProjection = useMemo(
    () => buildNarrativeTimelineProjection({
      sessionId: activeSession?.id ?? events[0]?.sessionId ?? 'session',
      events,
    }),
    [activeSession?.id, events]
  );
  const cacheHitSummary = useMemo(
    () => deriveCacheHitSummary(events, language, timelineProjection.tokenUsageProjection),
    [events, language, timelineProjection.tokenUsageProjection]
  );
  const activeProject = useMemo(
    () => projectRecords.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projectRecords]
  );
  const draftProject = useMemo(
    () => projectRecords.find((project) => project.id === draftProjectId) ?? null,
    [draftProjectId, projectRecords]
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
  const activeSessionRunning = Boolean(activeSession?.id && runningSessionIds.includes(activeSession.id));
  const projectDraftActive = Boolean(draftProjectId);
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
    const targetProjectId = projectId === undefined ? activeProjectId : projectId;
    setActiveProjectId(targetProjectId ?? null);
    setDraftProjectId(targetProjectId ?? null);
    if (targetProjectId) return;
    const nextSession = await createNewSession();
    if (nextSession?.id) {
      upsertKnownSession(nextSession);
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
    if (!draftProjectId) return true;
    const targetProjectId = draftProjectId;
    pendingProjectSendRef.current = null;
    setActiveProjectId(targetProjectId);
    setDraftProjectId(null);
    const nextSession = await createNewSession({ reuseEmpty: false });
    if (!nextSession?.id) {
      setDraftProjectId(targetProjectId);
      return false;
    }
    pendingProjectSendRef.current = {
      projectId: targetProjectId,
      sessionId: nextSession.id,
    };
    moveSessionToProject(targetProjectId, nextSession.id);
    upsertKnownSession(nextSession);
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

  const handleCreateProject = () => {
    const defaultName = t(language, 'deepcodeGui.project.defaultName');
    setTextDialog({
      kind: 'project',
      title: t(language, 'deepcodeGui.project.new'),
      label: t(language, 'deepcodeGui.project.namePrompt'),
      value: defaultName,
    });
  };

  const commitProjectName = async (title: string) => {
    if (!title) return;
    const now = new Date().toISOString();
    const project: CodexGuiProject = {
      id: `project-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      title,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    setProjectRecords((current) => [project, ...current]);
    setActiveProjectId(project.id);
    setDraftProjectId(project.id);
  };

  const openSessionContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    session: AgentSession
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 190;
    const height = projectRecords.length > 0 ? Math.min(320, 170 + projectRecords.length * 32) : 136;
    setSessionMenu({
      session,
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
    });
  };

  const openProjectContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    project: CodexGuiProject
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 190;
    const height = 112;
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

  const handleRenameProject = (project: CodexGuiProject) => {
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

  const commitProjectRename = (project: CodexGuiProject, nextTitle: string) => {
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
      await commitProjectName(value);
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

  const handleMoveSessionToProject = (session: AgentSession, projectId: string) => {
    setSessionMenu(null);
    moveSessionToProject(projectId, session.id);
    setActiveProjectId(projectId);
    setDraftProjectId(null);
  };

  const handleDeleteProject = (project: CodexGuiProject) => {
    setProjectMenu(null);
    setProjectRecords((current) => current.filter((item) => item.id !== project.id));
    setCollapsedProjectIds((current) => current.filter((id) => id !== project.id));
    if (activeProjectId === project.id) setActiveProjectId(null);
    if (draftProjectId === project.id) setDraftProjectId(null);
  };

  return (
    <div className="codex-workbench">
      <header className="codex-titlebar" data-tauri-drag-region>
        <div className="codex-titlebar__brand">
          <span className="codex-titlebar__mark">DC</span>
          <span>DeepCode-GUI</span>
        </div>
        <div className="codex-titlebar__status">
          {cacheHitSummary && (
            <span className="codex-status-pill codex-status-pill--cache" title={cacheHitSummary.title}>
              {cacheHitSummary.label}
            </span>
          )}
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
              onClick={() => void handleCreateSession(null)}
              disabled={loadingSession}
            >
              <CodexSidebarIcon name="compose" className="codex-sidebar-icon" />
              <span>{t(language, 'deepcodeGui.nav.newChat')}</span>
            </button>
          </div>

          <section className="codex-sidebar-section">
            <div className="codex-sidebar-section__heading codex-sidebar-section__heading--project">
              <div className="codex-sidebar-section__label">{t(language, 'deepcodeGui.sidebar.project')}</div>
              <button
                type="button"
                className="codex-sidebar-text-action"
                onClick={() => void handleCreateProject()}
                disabled={loadingSession}
              >
                {t(language, 'deepcodeGui.project.new')}
              </button>
            </div>
            {projectArchiveGroups.length === 0 ? (
              <div className="codex-sidebar-empty">{t(language, 'deepcodeGui.project.empty')}</div>
            ) : (
              <div className="codex-project-archive-list">
                {projectArchiveGroups.slice(0, 6).map((group, groupIndex) => {
                  const projectRecord = group.projectId
                    ? projectRecords.find((project) => project.id === group.projectId) ?? null
                    : null;
                  const projectCollapsed = Boolean(
                    group.projectId && collapsedProjectIdSet.has(group.projectId)
                  );
                  return (
                    <div
                      key={group.key}
                      className="codex-project-archive-group"
                    >
                      <div
                        className="codex-project-archive-group__title"
                        onContextMenu={(event) => {
                          if (projectRecord) openProjectContextMenu(event, projectRecord);
                        }}
                      >
                      <button
                        type="button"
                        className="codex-project-archive-group__select"
                        onClick={() => group.projectId && toggleProjectExpanded(group.projectId)}
                        onContextMenu={(event) => {
                          if (projectRecord) openProjectContextMenu(event, projectRecord);
                        }}
                        disabled={!group.projectId}
                        aria-expanded={!projectCollapsed}
                      >
                        <CodexSidebarIcon name="folder" className="codex-sidebar-icon" />
                        <span>{group.title}</span>
                      </button>
                      {group.projectId && (
                        <div className="codex-project-archive-group__actions" aria-hidden={false}>
                          <button
                            type="button"
                            className="codex-project-archive-group__compose"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleCreateSession(group.projectId);
                            }}
                            disabled={loadingSession}
                            aria-label={t(language, 'deepcodeGui.project.newChat')}
                            title={t(language, 'deepcodeGui.project.newChat')}
                          >
                            <CodexSidebarIcon name="compose" />
                          </button>
                        </div>
                      )}
                      </div>
                      {!projectCollapsed && (
                        <div className="codex-project-archive-group__sessions">
                          {group.sessions.slice(0, 4).map((item, itemIndex) => {
                            const shortcutIndex = groupIndex + itemIndex + 1;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                className={item.id === highlightedSessionId ? 'active' : ''}
                                onClick={() => {
                                  setActiveProjectId(group.projectId ?? null);
                                  setDraftProjectId(null);
                                  void activateSession(item.id);
                                }}
                                onContextMenu={(event) => openSessionContextMenu(event, item)}
                                disabled={loadingSession}
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

            <div className="codex-sidebar-section__heading">
              <div className="codex-sidebar-section__label codex-sidebar-section__label--nested">
                {t(language, 'deepcodeGui.sidebar.chats')}
              </div>
              <button
                type="button"
                className="codex-sidebar-new-chat"
                onClick={() => void handleCreateSession(null)}
                disabled={loadingSession}
                aria-label={t(language, 'deepcodeGui.nav.newChat')}
                title={t(language, 'deepcodeGui.nav.newChat')}
              >
                <CodexSidebarIcon name="compose" />
              </button>
            </div>
            {visibleSessions.length > 0 && (
              <div className="codex-session-list">
                {visibleSessions.slice(0, 8).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === highlightedSessionId ? 'active' : ''}
                    onClick={() => {
                      setActiveProjectId(null);
                      setDraftProjectId(null);
                      void activateSession(item.id);
                    }}
                    onContextMenu={(event) => openSessionContextMenu(event, item)}
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
          <CodexAgentPanel
            language={language}
            forceHome={projectDraftActive}
            homeProjectTitle={draftProject?.title ?? activeProject?.title ?? null}
            onBeforeSend={prepareProjectDraftSession}
            onAfterSend={commitDraftProjectSession}
          />
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

      {sessionMenu && (
        <div
          className="codex-session-context-menu"
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <div className="codex-session-context-menu__title">
            {displaySessionTitle(language, sessionMenu.session.title)}
          </div>
          <button type="button" role="menuitem" onClick={() => handleRenameSession(sessionMenu.session)}>
            {t(language, 'agent.session.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="codex-session-context-menu__danger"
            onClick={() => void handleDeleteSession(sessionMenu.session)}
          >
            {t(language, 'agent.session.delete')}
          </button>
          {projectRecords.length > 0 && (
            <div className="codex-session-context-menu__section">
              <div className="codex-session-context-menu__section-title">
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
          className="codex-session-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <div className="codex-session-context-menu__title">
            {projectMenu.project.title}
          </div>
          <button type="button" role="menuitem" onClick={() => handleRenameProject(projectMenu.project)}>
            {t(language, 'deepcodeGui.project.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="codex-session-context-menu__danger"
            onClick={() => handleDeleteProject(projectMenu.project)}
          >
            {t(language, 'deepcodeGui.project.delete')}
          </button>
        </div>
      )}

      {textDialog && (
        <div
          className="codex-text-dialog-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={textDialog.title}
          onMouseDown={() => setTextDialog(null)}
        >
          <form
            className="codex-text-dialog"
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
                  events={events}
                  tokenUsageProjection={timelineProjection.tokenUsageProjection}
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

export default CodexWorkbenchLayout;
