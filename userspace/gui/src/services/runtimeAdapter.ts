/**
 * GUI Host 到 Rust Kernel Web Host 的用户态调用层。
 *
 * 阶段 5.7 后不再维护 Tauri / Node 多后端分支。GUI 只作为 UI 层，
 * 通过 HTTP API 访问 Rust Kernel Web Host；跨 Host 共享的会话拼装
 * 逻辑放在 @deepcode/session-core。
 */
import type {
  AgentFeedbackRequest,
  AgentFeedbackResult,
  AgentActionParseRequest,
  AgentActionParseResult,
  AgentFixtureRunRequest,
  AgentFixtureRunResult,
  AgentMode,
  AgentSessionListResult,
  AgentSessionResult,
  AgentTraceEvent,
  ApiResponse,
  AppendAgentEventsRequest,
  ArchiveAgentSessionRequest,
  AttachPanelSnapshotResult,
  BrowsePathResult,
  BrowserRuntimeStatusResult,
  CodeSearchInput,
  CodeSearchResult,
  CreateAgentSessionRequest,
  CreateFolderResult,
  CreateTerminalSessionRequest,
  DeleteEntryResult,
  FileReadResult,
  FileTreeNode,
  FileWriteResult,
  GetAgentEventSnapshotResult,
  GetAgentWorkflowConfigResult,
  GetUserSettingsResult,
  HealthStatus,
  InitialLocations,
  ListAgentSessionsRequest,
  ListToolsResult,
  LlmChatRequest,
  LlmChatResult,
  LlmProbeRequest,
  LlmProbeResult,
  LlmProfilesResult,
  OpenBrowserPreviewRequest,
  OpenWorkspaceResult,
  PanelSnapshotResult,
  PatchAgentWorkflowConfigRequest,
  PatchLlmProfilesRequest,
  PatchUserSettingsRequest,
  PatchUserSettingsResult,
  PatchWorkspaceSettingsResult,
  PromptLayerResult,
  RenameAgentSessionRequest,
  RenameEntryResult,
  ResolveAgentPermissionRequest,
  SaveWorkspaceFileRequest,
  SaveWorkspaceFileResult,
  SendAgentMessageRequest,
  SetBrowserInspectModeRequest,
  ShellEnvironmentStatus,
  SkillReferenceResult,
  TerminalCapability,
  TerminalEventsResult,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSessionsResult,
  TerminalWarmupStatus,
  WorkspaceState,
} from '@deepcode/protocol';

import * as api from './apiClient';

export type RuntimeType = 'web';

type TauriCoreApi = {
  invoke?: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

declare global {
  interface Window {
    __TAURI__?: {
      core?: TauriCoreApi;
    };
  }
}

export const APP_CLOSE_REQUEST_EVENT = 'deepcode:app-close-request';

export interface RuntimeStatus {
  runtime: RuntimeType;
  version: string;
  platform: string;
  arch?: string;
}

export function getRuntimeType(): RuntimeType {
  return 'web';
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  try {
    const health = await api.getHealth();
    return {
      runtime: 'web',
      version: health.ok && health.data ? health.data.version : 'unknown',
      platform: navigator.platform,
    };
  } catch {
    return {
      runtime: 'web',
      version: 'unknown',
      platform: navigator.platform,
    };
  }
}

type WindowCommandName = 'minimize' | 'toggleMaximize' | 'close';

const TAURI_WINDOW_COMMANDS: Record<WindowCommandName, string> = {
  minimize: 'deepcode_window_minimize',
  toggleMaximize: 'deepcode_window_toggle_maximize',
  close: 'deepcode_window_close',
};

function getTauriInvoke(): TauriCoreApi['invoke'] | null {
  return window.__TAURI__?.core?.invoke ?? null;
}

function warnWindowCommand(commandName: string, err: unknown): void {
  console.warn(`[window] ${commandName} failed.`, err);
}

async function runWindowCommand(
  commandName: WindowCommandName,
  fallback?: () => void | Promise<void>
): Promise<void> {
  const invoke = getTauriInvoke();
  if (invoke) {
    try {
      await invoke(TAURI_WINDOW_COMMANDS[commandName]);
    } catch (err) {
      warnWindowCommand(commandName, err);
    }
    return;
  }

  if (!fallback) return;
  try {
    await fallback();
  } catch (err) {
    warnWindowCommand(commandName, err);
  }
}

export async function minimizeAppWindow(): Promise<void> {
  await runWindowCommand('minimize');
}

export async function toggleMaximizeAppWindow(): Promise<void> {
  await runWindowCommand('toggleMaximize');
}

export function requestCloseAppWindow(): void {
  window.dispatchEvent(new CustomEvent(APP_CLOSE_REQUEST_EVENT));
}

export async function closeAppWindow(): Promise<void> {
  await runWindowCommand('close', () => {
    window.close();
  });
}

export function getHealth(): Promise<ApiResponse<HealthStatus>> {
  return api.getHealth();
}

export function getCurrentWorkspace(): Promise<ApiResponse<WorkspaceState>> {
  return api.getCurrentWorkspace();
}

export function openWorkspace(path: string): Promise<ApiResponse<OpenWorkspaceResult>> {
  return api.openWorkspace(path);
}

export function saveWorkspaceFile(
  request: SaveWorkspaceFileRequest
): Promise<ApiResponse<SaveWorkspaceFileResult>> {
  return api.saveWorkspaceFile(request);
}

export function patchWorkspaceSettings(
  settings: Record<string, unknown>
): Promise<ApiResponse<PatchWorkspaceSettingsResult>> {
  return api.patchWorkspaceSettings(settings);
}

export function getInitialLocations(): Promise<ApiResponse<InitialLocations>> {
  return api.getInitialLocations();
}

export function browsePath(absolutePath?: string): Promise<ApiResponse<BrowsePathResult>> {
  return api.browsePath(absolutePath);
}

export function scanSkillMount(
  path: string
): Promise<ApiResponse<api.SkillMountScanResult>> {
  return api.scanSkillMount(path);
}

export async function pickWorkspacePath(): Promise<ApiResponse<string>> {
  return {
    ok: false,
    error: 'not_supported',
    message: '当前统一 GUI Host 通过 Rust Kernel Web Host 访问工作区，请使用浏览对话框选择路径。',
  };
}

export function getFileTree(
  folderId?: string,
  relativePath?: string
): Promise<ApiResponse<FileTreeNode[]>> {
  return api.getFileTree(folderId, relativePath);
}

export function readFile(
  filePath: string,
  folderId?: string
): Promise<ApiResponse<FileReadResult>> {
  return api.readFile(filePath, folderId);
}

export function writeFile(
  filePath: string,
  content: string,
  folderId?: string
): Promise<ApiResponse<FileWriteResult>> {
  return api.writeFile(filePath, content, folderId);
}

export function createFile(
  filePath: string,
  content?: string,
  folderId?: string
): Promise<ApiResponse<FileWriteResult>> {
  return api.createFile(filePath, content, folderId);
}

export function createFolder(
  folderPath: string,
  folderId?: string
): Promise<ApiResponse<CreateFolderResult>> {
  return api.createFolder(folderPath, folderId);
}

export function renameEntry(
  oldPath: string,
  newPath: string,
  folderId?: string
): Promise<ApiResponse<RenameEntryResult>> {
  return api.renameEntry(oldPath, newPath, folderId);
}

export function deleteEntry(
  filePath: string,
  folderId?: string
): Promise<ApiResponse<DeleteEntryResult>> {
  return api.deleteEntry(filePath, folderId);
}

export function getShellEnvironment(): Promise<ApiResponse<ShellEnvironmentStatus>> {
  return api.getShellEnvironment();
}

export function getTerminalCapabilities(): Promise<ApiResponse<TerminalCapability>> {
  return api.getTerminalCapabilities();
}

export function getTerminalWarmupStatus(): Promise<ApiResponse<TerminalWarmupStatus>> {
  return api.getTerminalWarmupStatus();
}

export function warmupTerminalRuntime(): Promise<ApiResponse<TerminalWarmupStatus>> {
  return api.warmupTerminalRuntime();
}

export function listTerminalSessions(): Promise<ApiResponse<TerminalSessionsResult>> {
  return api.listTerminalSessions();
}

export function createTerminalSession(
  request: CreateTerminalSessionRequest
): Promise<ApiResponse<TerminalSession>> {
  return api.createTerminalSession(request);
}

export function sendTerminalInput(
  sessionId: string,
  request: TerminalInputRequest
): Promise<ApiResponse<TerminalSession>> {
  return api.sendTerminalInput(sessionId, request);
}

export function resizeTerminalSession(
  sessionId: string,
  request: TerminalResizeRequest
): Promise<ApiResponse<TerminalSession>> {
  return api.resizeTerminalSession(sessionId, request);
}

export function updateTerminalSession(
  sessionId: string,
  request: Partial<Pick<TerminalSession, 'name' | 'order'>>
): Promise<ApiResponse<TerminalSession>> {
  return api.updateTerminalSession(sessionId, request);
}

export function restartTerminalSession(
  sessionId: string
): Promise<ApiResponse<TerminalSession>> {
  return api.restartTerminalSession(sessionId);
}

export function deleteTerminalSession(
  sessionId: string
): Promise<ApiResponse<TerminalSession>> {
  return api.deleteTerminalSession(sessionId);
}

export function getTerminalEvents(
  sessionId?: string,
  after?: number
): Promise<ApiResponse<TerminalEventsResult>> {
  return api.getTerminalEvents(sessionId, after);
}

export function getUserSettings(): Promise<ApiResponse<GetUserSettingsResult>> {
  return api.getUserSettings();
}

export function patchUserSettings(
  patches: PatchUserSettingsRequest['patches']
): Promise<ApiResponse<PatchUserSettingsResult>> {
  return api.patchUserSettings(patches);
}

export function getLlmProfiles(): Promise<ApiResponse<LlmProfilesResult>> {
  return api.getLlmProfiles();
}

export function patchLlmProfiles(
  request: PatchLlmProfilesRequest
): Promise<ApiResponse<LlmProfilesResult>> {
  return api.patchLlmProfiles(request);
}

export function probeLlmProfile(
  request: LlmProbeRequest
): Promise<ApiResponse<LlmProbeResult>> {
  return api.probeLlmProfile(request);
}

export function llmChat(request: LlmChatRequest): Promise<ApiResponse<LlmChatResult>> {
  return api.llmChat(request);
}

export function codeSearch(request: CodeSearchInput): Promise<ApiResponse<CodeSearchResult>> {
  return api.codeSearch(request);
}

export function createAgentSession(
  request: CreateAgentSessionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return api.createAgentSession(request);
}

export function listAgentSessions(
  request: ListAgentSessionsRequest = {}
): Promise<ApiResponse<AgentSessionListResult>> {
  return api.listAgentSessions(request);
}

export function getCurrentAgentSession(
  request: ListAgentSessionsRequest = {}
): Promise<ApiResponse<AgentSessionResult | null>> {
  return api.getCurrentAgentSession(request);
}

export function activateAgentSession(
  sessionId: string
): Promise<ApiResponse<AgentSessionResult>> {
  return api.activateAgentSession(sessionId);
}

export function renameAgentSession(
  sessionId: string,
  request: RenameAgentSessionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return api.renameAgentSession(sessionId, request);
}

export function archiveAgentSession(
  sessionId: string,
  request: ArchiveAgentSessionRequest = { archived: true }
): Promise<ApiResponse<AgentSessionListResult>> {
  return api.archiveAgentSession(sessionId, request);
}

export function appendAgentEvents(
  sessionId: string,
  request: AppendAgentEventsRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return api.appendAgentEvents(sessionId, request);
}

export function sendAgentMessage(
  sessionId: string,
  request: SendAgentMessageRequest,
  signal?: AbortSignal
): Promise<ApiResponse<AgentSessionResult>> {
  return api.sendAgentMessage(sessionId, request, signal);
}

export function cancelAgentRun(sessionId: string): Promise<ApiResponse<AgentSessionResult>> {
  return api.cancelAgentRun(sessionId);
}

export function getAgentEventSnapshot(
  sessionId: string
): Promise<ApiResponse<GetAgentEventSnapshotResult>> {
  return api.getAgentEventSnapshot(sessionId);
}

const agentEventSubscriptions = new Map<string, number>();

export function subscribeAgentEvents(
  sessionId: string,
  onEvent: (event: AgentTraceEvent) => void,
  intervalMs = 1200
): string {
  let lastTraceId: string | undefined;
  let stopped = false;
  const subscriptionId = `agent-events-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const poll = async () => {
    if (stopped) return;
    const snapshot = await getAgentEventSnapshot(sessionId);
    if (!snapshot.ok || !snapshot.data) return;
    const events = snapshot.data.trace.events;
    const startIndex = lastTraceId
      ? events.findIndex((event) => event.id === lastTraceId) + 1
      : 0;
    const nextEvents = events.slice(Math.max(0, startIndex));
    for (const event of nextEvents) onEvent(event);
    if (events.length > 0) lastTraceId = events[events.length - 1].id;
  };

  void poll();
  const handle = window.setInterval(() => {
    void poll();
  }, intervalMs);
  agentEventSubscriptions.set(subscriptionId, handle);
  return subscriptionId;
}

export function unsubscribeAgentEvents(subscriptionId: string): void {
  const handle = agentEventSubscriptions.get(subscriptionId);
  if (handle !== undefined) {
    window.clearInterval(handle);
    agentEventSubscriptions.delete(subscriptionId);
  }
}

export async function ackAgentEvent(eventId: string): Promise<ApiResponse<{ accepted: boolean; eventId: string }>> {
  return {
    ok: true,
    data: {
      accepted: true,
      eventId,
    },
  };
}

export function resolveAgentPermission(
  permissionId: string,
  request: ResolveAgentPermissionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return api.resolveAgentPermission(permissionId, request);
}

export function submitAgentFeedback(
  request: AgentFeedbackRequest
): Promise<ApiResponse<AgentFeedbackResult>> {
  return api.submitAgentFeedback(request);
}

export function getAgentWorkflowConfig(): Promise<ApiResponse<GetAgentWorkflowConfigResult>> {
  return api.getAgentWorkflowConfig();
}

export function patchAgentWorkflowConfig(
  request: PatchAgentWorkflowConfigRequest
): Promise<ApiResponse<GetAgentWorkflowConfigResult>> {
  return api.patchAgentWorkflowConfig(request);
}

export function listAgentTools(mode?: AgentMode): Promise<ApiResponse<ListToolsResult>> {
  return api.listAgentTools(mode);
}

export function parseAgentActions(
  request: AgentActionParseRequest
): Promise<ApiResponse<AgentActionParseResult>> {
  return api.parseAgentActions(request);
}

export function runAgentFixture(
  request: AgentFixtureRunRequest
): Promise<ApiResponse<AgentFixtureRunResult>> {
  return api.runAgentFixture(request);
}

export function getAgentPromptLayers(): Promise<ApiResponse<PromptLayerResult>> {
  return api.getAgentPromptLayers();
}

export function getAgentSkills(): Promise<ApiResponse<SkillReferenceResult>> {
  return api.getAgentSkills();
}

export function getBrowserRuntimeStatus(): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return api.getBrowserRuntimeStatus();
}

export function openBrowserPreview(
  request: OpenBrowserPreviewRequest
): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return api.openBrowserPreview(request);
}

export function reloadBrowserPreview(): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return api.reloadBrowserPreview();
}

export function setBrowserInspectMode(
  request: SetBrowserInspectModeRequest
): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return api.setBrowserInspectMode(request);
}

export function getSelectedPanelSnapshot(): Promise<ApiResponse<PanelSnapshotResult>> {
  return api.getSelectedPanelSnapshot();
}

export function attachPanelSnapshotToAgent(): Promise<ApiResponse<AttachPanelSnapshotResult>> {
  return api.attachPanelSnapshotToAgent();
}
