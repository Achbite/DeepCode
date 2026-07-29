/**
 * GUI Host 到 Rust Kernel Web Host 的用户态调用层。
 *
 * 阶段 5.7 后不再维护 Tauri / Node 多后端分支。GUI 只作为 UI 层，
 * 通过 HTTP API 访问 Rust Kernel Web Host；跨 Host 共享的会话拼装
 * 由 daemon shared Session Runtime 承载，GUI 不直接编排 provider / Kernel loop。
 */
import type {
  AgentProjectListResult,
  AgentProjectResult,
  AgentSessionListResult,
  AgentSessionResult,
  ApiResponse,
  ArchiveAgentSessionRequest,
  BrowsePathResult,
  BrowserRuntimeStatusResult,
  CodeGrepInput,
  CodeGrepResult,
  CreateAgentProjectRequest,
  CreateAgentSessionRequest,
  CreateTerminalSessionRequest,
  FileReadResult,
  FileTreeNode,
  GetUserSettingsResult,
  GitDiffResult,
  GitStatusResult,
  HealthStatus,
  InitialLocations,
  ListAgentSessionsRequest,
  LlmProbeRequest,
  LlmProbeResult,
  LlmProfilesResult,
  OpenBrowserPreviewRequest,
  OpenWorkspaceResult,
  PatchLlmProfilesRequest,
  PatchUserSettingsRequest,
  PatchUserSettingsResult,
  PatchWorkspaceSettingsResult,
  RenameAgentSessionRequest,
  RebindAgentProjectRequest,
  SaveWorkspaceFileRequest,
  SaveWorkspaceFileResult,
  SetBrowserInspectModeRequest,
  ShellEnvironmentStatus,
  KernelHostSkillCatalogResult,
  TerminalCapability,
  TerminalEventsResult,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSessionsResult,
  TerminalWarmupStatus,
  UpdateAgentProjectRequest,
  UpdateAgentSessionRequest,
  WorkspaceState,
} from '@deepcode/protocol';
import * as api from './apiClient';
import { activeT } from '../i18n';

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

export interface KernelStartResult {
  started: boolean;
  blocked: boolean;
  message: string;
}

export function healthVersion(health?: HealthStatus): string {
  return health?.version || health?.buildCommit || 'unknown';
}

export function getRuntimeType(): RuntimeType {
  return 'web';
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  try {
    const health = await api.getHealth();
    return {
      runtime: 'web',
      version: health.ok ? healthVersion(health.data) : 'unknown',
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

export async function startKernelAfterPermission(): Promise<ApiResponse<KernelStartResult>> {
  const invoke = getTauriInvoke();
  if (!invoke) {
    return {
      ok: false,
      error: 'kernel_start_unavailable',
      message: 'Kernel retry is only available in the desktop shell.',
    };
  }
  try {
    const result = await invoke<KernelStartResult>('deepcode_start_kernel_after_permission');
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: 'kernel_start_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getDefaultWorkspacePath(): Promise<ApiResponse<string | null>> {
  if (document.documentElement.dataset.product !== 'deepcode-gui') {
    return { ok: true, data: null };
  }
  const invoke = getTauriInvoke();
  if (!invoke) {
    const result = await api.getDefaultWorkspacePath();
    if (result.ok && result.data) {
      return { ok: true, data: result.data.path };
    }
    return { ok: true, data: null };
  }
  try {
    const path = await invoke<string | null>('deepcode_default_workspace_path');
    return { ok: true, data: path ?? null };
  } catch (err) {
    return {
      ok: false,
      error: 'default_workspace_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
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
    message: activeT('runtime.workspacePickerUnsupported'),
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

export function codeSearch(request: CodeGrepInput): Promise<ApiResponse<CodeGrepResult>> {
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

export function updateAgentSession(
  sessionId: string,
  request: UpdateAgentSessionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return api.updateAgentSession(sessionId, request);
}

export function listAgentProjects(): Promise<ApiResponse<AgentProjectListResult>> {
  return api.listAgentProjects();
}

export function createAgentProject(
  request: CreateAgentProjectRequest
): Promise<ApiResponse<AgentProjectResult>> {
  return api.createAgentProject(request);
}

export function updateAgentProject(
  projectId: string,
  request: UpdateAgentProjectRequest
): Promise<ApiResponse<AgentProjectResult>> {
  return api.updateAgentProject(projectId, request);
}

export function rebindAgentProject(
  projectId: string,
  request: RebindAgentProjectRequest
): Promise<ApiResponse<AgentProjectResult>> {
  return api.rebindAgentProject(projectId, request);
}

export function deleteAgentProject(
  projectId: string
): Promise<ApiResponse<AgentProjectListResult>> {
  return api.deleteAgentProject(projectId);
}

export function archiveAgentSession(
  sessionId: string,
  request: ArchiveAgentSessionRequest = { archived: true }
): Promise<ApiResponse<AgentSessionListResult>> {
  return api.archiveAgentSession(sessionId, request);
}

export function deleteAgentSession(
  sessionId: string
): Promise<ApiResponse<AgentSessionListResult>> {
  return api.deleteAgentSession(sessionId);
}

export function getAgentSession(sessionId: string): Promise<ApiResponse<AgentSessionResult>> {
  return api.getAgentSession(sessionId);
}

export function getAgentTimeline(sessionId: string) {
  return api.getAgentTimeline(sessionId);
}

export function startAgentRun(
  sessionId: string,
  request: api.StartAgentRunRequest
): Promise<ApiResponse<api.AgentRunResult>> {
  return api.startAgentRun(sessionId, request);
}

export function getAgentRun(
  sessionId: string,
  runId: string
): Promise<ApiResponse<api.AgentRunResult>> {
  return api.getAgentRun(sessionId, runId);
}

export function streamAgentRun(
  sessionId: string,
  runId: string,
  onEvent: (event: api.AgentRunStreamEvent) => void,
  cursor?: { sinceEventCount?: number },
  signal?: AbortSignal
): Promise<void> {
  return api.streamAgentRun(sessionId, runId, onEvent, cursor, signal);
}

export function cancelAgentRunById(
  sessionId: string,
  runId: string,
  callerRequestId: string
): Promise<ApiResponse<api.AgentRunResult>> {
  return api.cancelAgentRunById(sessionId, runId, callerRequestId);
}

export function submitAgentRunGuidance(
  sessionId: string,
  runId: string,
  request: api.AgentRunGuidanceRequest
): Promise<ApiResponse<api.AgentRunResult>> {
  return api.submitAgentRunGuidance(sessionId, runId, request);
}

export function getHostSkills(): Promise<ApiResponse<KernelHostSkillCatalogResult>> {
  return api.getHostSkills();
}

export function getGitStatus(): Promise<ApiResponse<GitStatusResult>> {
  return api.getGitStatus();
}

export function getGitDiff(
  path?: string,
  staged?: boolean
): Promise<ApiResponse<GitDiffResult>> {
  return api.getGitDiff(path, staged);
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
