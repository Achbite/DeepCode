/**
 * 运行时适配层
 *
 * 统一前端 UI 对底层通信的调用方式：
 *   - Web 模式：调用 apiClient（HTTP → Node 后端）
 *   - Tauri 模式：调用 @tauri-apps/api invoke（Tauri Rust command）
 *
 * UI 组件和 Store 不直接知道底层走 HTTP 还是 Tauri invoke，
 * 只通过本模块暴露的同签名函数交互。
 */
import type {
  ApiResponse,
  HealthStatus,
  FileTreeNode,
  FileReadResult,
  FileWriteResult,
  CreateFolderResult,
  RenameEntryResult,
  WorkspaceState,
  OpenWorkspaceResult,
  SaveWorkspaceFileRequest,
  SaveWorkspaceFileResult,
  BrowsePathResult,
  InitialLocations,
  GetUserSettingsResult,
  PatchUserSettingsRequest,
  PatchUserSettingsResult,
  PatchWorkspaceSettingsResult,
  LlmProfilesResult,
  PatchLlmProfilesRequest,
  LlmProbeRequest,
  LlmProbeResult,
  LlmChatRequest,
  LlmChatResult,
  CodeSearchInput,
  CodeSearchResult,
  AgentMode,
  AgentSessionListResult,
  CreateAgentSessionRequest,
  ListAgentSessionsRequest,
  RenameAgentSessionRequest,
  ArchiveAgentSessionRequest,
  AgentSessionResult,
  AppendAgentEventsRequest,
  SendAgentMessageRequest,
  ResolveAgentPermissionRequest,
  AgentFeedbackRequest,
  AgentFeedbackResult,
  AgentTraceEvent,
  GetAgentEventSnapshotResult,
  GetAgentWorkflowConfigResult,
  PatchAgentWorkflowConfigRequest,
  ListToolsResult,
  PermissionEvaluationRequest,
  PermissionDecision,
  ToolExecutionRequest,
  ToolResult,
  CreateTerminalSessionRequest,
  TerminalCapability,
  TerminalEventsResult,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSessionsResult,
  TerminalWarmupStatus,
  BrowserRuntimeStatusResult,
  OpenBrowserPreviewRequest,
  SetBrowserInspectModeRequest,
  PanelSnapshotResult,
  AttachPanelSnapshotResult,
} from '@deepcode/protocol';

// ---- 运行时检测 ----

export type RuntimeType = 'web' | 'tauri';

/**
 * 检测当前运行时类型。
 *
 * Tauri v2 在 webview 启动时会注入两个全局：
 *   - window.isTauri          : 官方稳定 API，由 @tauri-apps/api/core 的 isTauri() 检测
 *   - window.__TAURI_INTERNALS__ : 内部 IPC 句柄，命名前缀带下划线属于实现细节
 *
 * 历史 bug：之前缓存第一次 getRuntimeType() 的结果，且只检查 __TAURI_INTERNALS__。
 * release 模式下 React 首次 useEffect 触发的时机可能早于 webview-init.js 注入这个内部字段，
 * 导致永久缓存为 'web'，所有 /api/* fetch 走出到 tauri.localhost/api/* 命中 ERR_CONNECTION_REFUSED 白屏。
 *
 * 修复：每次都重新读取（开销可忽略），同时优先用 window.isTauri 这个稳定字段。
 */
export function getRuntimeType(): RuntimeType {
  if (typeof window === 'undefined') return 'web';
  const w = window as any;
  const location = window.location;
  if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') {
    return 'tauri';
  }
  if (w.isTauri || w.__TAURI_INTERNALS__ || w.__TAURI__) return 'tauri';
  return 'web';
}

/** 运行时状态信息 */
export interface RuntimeStatus {
  runtime: RuntimeType;
  version: string;
  platform: string;
  arch?: string;
}

/** 获取运行时状态 */
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (getRuntimeType() === 'tauri') {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<RuntimeStatus>('get_runtime_status');
  }
  // Web fallback：尝试从 /api/health 获取版本信息
  try {
    const { getHealth } = await import('./apiClient');
    const health = await getHealth();
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

export async function minimizeAppWindow(): Promise<void> {
  if (getRuntimeType() === 'tauri') {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  }
}

export async function toggleMaximizeAppWindow(): Promise<void> {
  if (getRuntimeType() === 'tauri') {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().toggleMaximize();
  }
}

export async function closeAppWindow(): Promise<void> {
  if (getRuntimeType() === 'tauri') {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
    return;
  }
  window.close();
}

// ---- Tauri invoke helper ----

function stringifyUnknownError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    for (const key of ['message', 'error', 'Other', 'NotImplemented']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    try {
      return JSON.stringify(err);
    } catch {
      // Ignore JSON serialization failures and fall through.
    }
  }
  return String(err);
}

function parseTauriErrorPayload(err: unknown, fallback: string): Record<string, unknown> | null {
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    return err as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(fallback);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * 封装 Tauri invoke 调用，将 Rust Result<T, CommandError> 映射为 ApiResponse<T>。
 *
 * Rust CommandError 序列化后格式：
 *   - NotImplemented: { "NotImplemented": "..." }
 *   - UserCancelled:  "user_cancelled"
 *   - Other:          "错误信息"
 *
 * Tauri invoke 抛出异常时，error 字符串即为 CommandError 的序列化结果。
 */
async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<ApiResponse<T>> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const data = await invoke<T>(command, args);
    return { ok: true, data };
  } catch (err: any) {
    const errStr = stringifyUnknownError(err);

    // 尝试解析 JSON 格式的 CommandError
    const parsed = parseTauriErrorPayload(err, errStr);
    if (parsed) {
      if (typeof parsed.NotImplemented === 'string') {
        return {
          ok: false,
          error: 'not_implemented',
          message: parsed.NotImplemented,
        };
      }
      if (parsed.Other) {
        const message = stringifyUnknownError(parsed.Other);
        return {
          ok: false,
          error: message.includes('wsl_missing') ? 'wsl_missing' : 'tauri_error',
          message,
        };
      }
    }

    if (errStr === 'user_cancelled') {
      return {
        ok: false,
        error: 'user_cancelled',
        message: '用户取消了操作',
      };
    }

    if (errStr.includes('file_already_exists')) {
      return {
        ok: false,
        error: 'file_already_exists',
        message: errStr,
      };
    }

    if (errStr.includes('no_workspace')) {
      return {
        ok: false,
        error: 'no_workspace',
        message: errStr,
      };
    }

    if (errStr.includes('wsl_missing')) {
      return {
        ok: false,
        error: 'wsl_missing',
        message: errStr,
      };
    }

    return {
      ok: false,
      error: 'tauri_error',
      message: errStr,
    };
  }
}

// ---- 工作区 ----

export async function getCurrentWorkspace(): Promise<ApiResponse<WorkspaceState>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<WorkspaceState>('get_current_workspace');
  }
  const { getCurrentWorkspace: apiGetCurrentWorkspace } = await import('./apiClient');
  return apiGetCurrentWorkspace();
}

export async function openWorkspace(path: string): Promise<ApiResponse<OpenWorkspaceResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<OpenWorkspaceResult>('open_workspace', { path });
  }
  const { openWorkspace: apiOpenWorkspace } = await import('./apiClient');
  return apiOpenWorkspace(path);
}

export async function saveWorkspaceFile(
  request: SaveWorkspaceFileRequest
): Promise<ApiResponse<SaveWorkspaceFileResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<SaveWorkspaceFileResult>('save_workspace_file', {
      folderId: request.folderId,
      fileName: request.fileName,
    });
  }
  const { saveWorkspaceFile: apiSaveWorkspaceFile } = await import('./apiClient');
  return apiSaveWorkspaceFile(request);
}

export async function patchWorkspaceSettings(
  settings: Record<string, unknown>
): Promise<ApiResponse<PatchWorkspaceSettingsResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<PatchWorkspaceSettingsResult>('patch_workspace_settings', { settings });
  }
  const { patchWorkspaceSettings: apiPatchWorkspaceSettings } = await import('./apiClient');
  return apiPatchWorkspaceSettings(settings);
}

// ---- 文件系统浏览（用于 Open Workspace 对话框）----

export async function getInitialLocations(): Promise<ApiResponse<InitialLocations>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<InitialLocations>('get_initial_locations');
  }
  const { getInitialLocations: apiGetInitialLocations } = await import('./apiClient');
  return apiGetInitialLocations();
}

export async function browsePath(absolutePath?: string): Promise<ApiResponse<BrowsePathResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<BrowsePathResult>('browse_path', { path: absolutePath || '' });
  }
  const { browsePath: apiBrowsePath } = await import('./apiClient');
  return apiBrowsePath(absolutePath);
}

/**
 * 弹出原生目录选择对话框（Tauri 模式）或返回空结果（Web 模式）。
 * 返回用户选择的绝对路径。
 */
export async function pickWorkspacePath(): Promise<ApiResponse<string>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<string>('pick_workspace_directory');
  }
  // Web 模式不支持原生对话框
  return {
    ok: false,
    error: 'not_supported',
    message: 'Web 模式不支持原生目录选择，请使用浏览对话框',
  };
}

// ---- 文件 ----

export async function getFileTree(
  folderId?: string,
  relativePath?: string
): Promise<ApiResponse<FileTreeNode[]>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<FileTreeNode[]>('list_file_tree', { folderId: folderId ?? null });
  }
  const { getFileTree: apiGetFileTree } = await import('./apiClient');
  return apiGetFileTree(folderId, relativePath);
}

export async function readFile(
  filePath: string,
  folderId?: string
): Promise<ApiResponse<FileReadResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<FileReadResult>('read_text_file', {
      folderId: folderId ?? null,
      path: filePath,
    });
  }
  const { readFile: apiReadFile } = await import('./apiClient');
  return apiReadFile(filePath, folderId);
}

export async function writeFile(
  filePath: string,
  content: string,
  folderId?: string
): Promise<ApiResponse<FileWriteResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<FileWriteResult>('write_text_file', {
      folderId: folderId ?? null,
      path: filePath,
      content,
    });
  }
  const { writeFile: apiWriteFile } = await import('./apiClient');
  return apiWriteFile(filePath, content, folderId);
}

// ---- 新建文件 / 新建目录（阶段 4 / S4-1）----

export async function createFile(
  filePath: string,
  content?: string,
  folderId?: string
): Promise<ApiResponse<FileWriteResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<FileWriteResult>('create_file', {
      folderId: folderId ?? null,
      path: filePath,
      content: content ?? '',
    });
  }
  const { createFile: apiCreateFile } = await import('./apiClient');
  return apiCreateFile(filePath, content, folderId);
}

export async function createFolder(
  folderPath: string,
  folderId?: string
): Promise<ApiResponse<CreateFolderResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<CreateFolderResult>('create_folder', {
      folderId: folderId ?? null,
      path: folderPath,
    });
  }
  const { createFolder: apiCreateFolder } = await import('./apiClient');
  return apiCreateFolder(folderPath, folderId);
}

export async function renameEntry(
  oldPath: string,
  newPath: string,
  folderId?: string
): Promise<ApiResponse<RenameEntryResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<RenameEntryResult>('rename_entry', {
      folderId: folderId ?? null,
      oldPath,
      newPath,
    });
  }
  const { renameEntry: apiRenameEntry } = await import('./apiClient');
  return apiRenameEntry(oldPath, newPath, folderId);
}

// ---- Terminal runtime ----

export async function getTerminalCapabilities(): Promise<ApiResponse<TerminalCapability>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalCapability>('get_terminal_capabilities');
  }
  const { getTerminalCapabilities: apiGetTerminalCapabilities } = await import('./apiClient');
  return apiGetTerminalCapabilities();
}

export async function getTerminalWarmupStatus(): Promise<ApiResponse<TerminalWarmupStatus>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalWarmupStatus>('get_terminal_warmup_status');
  }
  const { getTerminalWarmupStatus: apiGetTerminalWarmupStatus } = await import('./apiClient');
  return apiGetTerminalWarmupStatus();
}

export async function warmupTerminalRuntime(): Promise<ApiResponse<TerminalWarmupStatus>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalWarmupStatus>('warmup_terminal_runtime');
  }
  const { warmupTerminalRuntime: apiWarmupTerminalRuntime } = await import('./apiClient');
  return apiWarmupTerminalRuntime();
}

export async function listTerminalSessions(): Promise<ApiResponse<TerminalSessionsResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalSessionsResult>('list_terminal_sessions');
  }
  const { listTerminalSessions: apiListTerminalSessions } = await import('./apiClient');
  return apiListTerminalSessions();
}

export async function createTerminalSession(
  request: CreateTerminalSessionRequest
): Promise<ApiResponse<TerminalSession>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalSession>('create_terminal_session', { request });
  }
  const { createTerminalSession: apiCreateTerminalSession } = await import('./apiClient');
  return apiCreateTerminalSession(request);
}

export async function sendTerminalInput(
  sessionId: string,
  request: TerminalInputRequest
): Promise<ApiResponse<TerminalSession>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalSession>('send_terminal_input', { sessionId, request });
  }
  const { sendTerminalInput: apiSendTerminalInput } = await import('./apiClient');
  return apiSendTerminalInput(sessionId, request);
}

export async function resizeTerminalSession(
  sessionId: string,
  request: TerminalResizeRequest
): Promise<ApiResponse<TerminalSession>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalSession>('resize_terminal_session', { sessionId, request });
  }
  const { resizeTerminalSession: apiResizeTerminalSession } = await import('./apiClient');
  return apiResizeTerminalSession(sessionId, request);
}

export async function updateTerminalSession(
  sessionId: string,
  request: Partial<Pick<TerminalSession, 'name' | 'order'>>
): Promise<ApiResponse<TerminalSession>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalSession>('update_terminal_session', { sessionId, request });
  }
  const { updateTerminalSession: apiUpdateTerminalSession } = await import('./apiClient');
  return apiUpdateTerminalSession(sessionId, request);
}

export async function restartTerminalSession(
  sessionId: string
): Promise<ApiResponse<TerminalSession>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalSession>('restart_terminal_session', { sessionId });
  }
  const { restartTerminalSession: apiRestartTerminalSession } = await import('./apiClient');
  return apiRestartTerminalSession(sessionId);
}

export async function deleteTerminalSession(
  sessionId: string
): Promise<ApiResponse<TerminalSession>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalSession>('delete_terminal_session', { sessionId });
  }
  const { deleteTerminalSession: apiDeleteTerminalSession } = await import('./apiClient');
  return apiDeleteTerminalSession(sessionId);
}

export async function getTerminalEvents(
  sessionId?: string,
  after?: number
): Promise<ApiResponse<TerminalEventsResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<TerminalEventsResult>('get_terminal_events', {
      sessionId: sessionId ?? null,
      after: after ?? 0,
    });
  }
  const { getTerminalEvents: apiGetTerminalEvents } = await import('./apiClient');
  return apiGetTerminalEvents(sessionId, after);
}

// ---- 用户设置（阶段 4 / S4-4）----

export async function getUserSettings(): Promise<ApiResponse<GetUserSettingsResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<GetUserSettingsResult>('get_user_settings');
  }
  const { getUserSettings: apiGetUserSettings } = await import('./apiClient');
  return apiGetUserSettings();
}

export async function patchUserSettings(
  patches: PatchUserSettingsRequest['patches']
): Promise<ApiResponse<PatchUserSettingsResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<PatchUserSettingsResult>('patch_user_settings', { patches });
  }
  const { patchUserSettings: apiPatchUserSettings } = await import('./apiClient');
  return apiPatchUserSettings(patches);
}

// ---- LLM profiles / chat（阶段 6 / S6-1）----

export async function getLlmProfiles(): Promise<ApiResponse<LlmProfilesResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<LlmProfilesResult>('get_llm_profiles');
  }
  const { getLlmProfiles: apiGetLlmProfiles } = await import('./apiClient');
  return apiGetLlmProfiles();
}

export async function patchLlmProfiles(
  request: PatchLlmProfilesRequest
): Promise<ApiResponse<LlmProfilesResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<LlmProfilesResult>('patch_llm_profiles', { request });
  }
  const { patchLlmProfiles: apiPatchLlmProfiles } = await import('./apiClient');
  return apiPatchLlmProfiles(request);
}

export async function probeLlmProfile(
  request: LlmProbeRequest
): Promise<ApiResponse<LlmProbeResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<LlmProbeResult>('probe_llm_profile', { request });
  }
  const { probeLlmProfile: apiProbeLlmProfile } = await import('./apiClient');
  return apiProbeLlmProfile(request);
}

export async function llmChat(
  request: LlmChatRequest
): Promise<ApiResponse<LlmChatResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<LlmChatResult>('llm_chat', { request });
  }
  const { llmChat: apiLlmChat } = await import('./apiClient');
  return apiLlmChat(request);
}

export async function codeSearch(
  request: CodeSearchInput
): Promise<ApiResponse<CodeSearchResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<CodeSearchResult>('code_search', { request });
  }
  const { codeSearch: apiCodeSearch } = await import('./apiClient');
  return apiCodeSearch(request);
}

export async function createAgentSession(
  request: CreateAgentSessionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentSessionResult>('create_agent_session', { request });
  }
  const { createAgentSession: apiCreateAgentSession } = await import('./apiClient');
  return apiCreateAgentSession(request);
}

export async function listAgentSessions(
  request: ListAgentSessionsRequest = {}
): Promise<ApiResponse<AgentSessionListResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentSessionListResult>('list_agent_sessions', { request });
  }
  const { listAgentSessions: apiListAgentSessions } = await import('./apiClient');
  return apiListAgentSessions(request);
}

export async function getCurrentAgentSession(
  request: ListAgentSessionsRequest = {}
): Promise<ApiResponse<AgentSessionResult | null>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentSessionResult | null>('get_current_agent_session', { request });
  }
  const { getCurrentAgentSession: apiGetCurrentAgentSession } = await import('./apiClient');
  return apiGetCurrentAgentSession(request);
}

export async function activateAgentSession(
  sessionId: string
): Promise<ApiResponse<AgentSessionResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentSessionResult>('activate_agent_session', { sessionId });
  }
  const { activateAgentSession: apiActivateAgentSession } = await import('./apiClient');
  return apiActivateAgentSession(sessionId);
}

export async function renameAgentSession(
  sessionId: string,
  request: RenameAgentSessionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentSessionResult>('rename_agent_session', { sessionId, request });
  }
  const { renameAgentSession: apiRenameAgentSession } = await import('./apiClient');
  return apiRenameAgentSession(sessionId, request);
}

export async function archiveAgentSession(
  sessionId: string,
  request: ArchiveAgentSessionRequest = { archived: true }
): Promise<ApiResponse<AgentSessionListResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentSessionListResult>('archive_agent_session', { sessionId, request });
  }
  const { archiveAgentSession: apiArchiveAgentSession } = await import('./apiClient');
  return apiArchiveAgentSession(sessionId, request);
}

export async function appendAgentEvents(
  sessionId: string,
  request: AppendAgentEventsRequest
): Promise<ApiResponse<AgentSessionResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentSessionResult>('append_agent_events', { sessionId, request });
  }
  const { appendAgentEvents: apiAppendAgentEvents } = await import('./apiClient');
  return apiAppendAgentEvents(sessionId, request);
}

export async function sendAgentMessage(
  sessionId: string,
  request: SendAgentMessageRequest
): Promise<ApiResponse<AgentSessionResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentSessionResult>('send_agent_message', { sessionId, request });
  }
  const { sendAgentMessage: apiSendAgentMessage } = await import('./apiClient');
  return apiSendAgentMessage(sessionId, request);
}

export async function getAgentEventSnapshot(
  sessionId: string
): Promise<ApiResponse<GetAgentEventSnapshotResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<GetAgentEventSnapshotResult>('get_agent_event_snapshot', { sessionId });
  }
  const { getAgentEventSnapshot: apiGetAgentEventSnapshot } = await import('./apiClient');
  return apiGetAgentEventSnapshot(sessionId);
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
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<{ accepted: boolean; eventId: string }>('ack_agent_event', { eventId });
  }
  return {
    ok: true,
    data: {
      accepted: true,
      eventId,
    },
  };
}

export async function resolveAgentPermission(
  permissionId: string,
  request: ResolveAgentPermissionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentSessionResult>('resolve_agent_permission', { permissionId, request });
  }
  const { resolveAgentPermission: apiResolveAgentPermission } = await import('./apiClient');
  return apiResolveAgentPermission(permissionId, request);
}

export async function submitAgentFeedback(
  request: AgentFeedbackRequest
): Promise<ApiResponse<AgentFeedbackResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AgentFeedbackResult>('submit_agent_feedback', { request });
  }
  const { submitAgentFeedback: apiSubmitAgentFeedback } = await import('./apiClient');
  return apiSubmitAgentFeedback(request);
}

export async function getAgentWorkflowConfig(): Promise<ApiResponse<GetAgentWorkflowConfigResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<GetAgentWorkflowConfigResult>('get_agent_workflow_config');
  }
  const { getAgentWorkflowConfig: apiGetAgentWorkflowConfig } = await import('./apiClient');
  return apiGetAgentWorkflowConfig();
}

export async function patchAgentWorkflowConfig(
  request: PatchAgentWorkflowConfigRequest
): Promise<ApiResponse<GetAgentWorkflowConfigResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<GetAgentWorkflowConfigResult>('patch_agent_workflow_config', { request });
  }
  const { patchAgentWorkflowConfig: apiPatchAgentWorkflowConfig } = await import('./apiClient');
  return apiPatchAgentWorkflowConfig(request);
}

export async function listAgentTools(
  mode?: AgentMode
): Promise<ApiResponse<ListToolsResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<ListToolsResult>('list_agent_tools', { mode });
  }
  const { listAgentTools: apiListAgentTools } = await import('./apiClient');
  return apiListAgentTools(mode);
}

export async function evaluateAgentPermission(
  request: PermissionEvaluationRequest
): Promise<ApiResponse<PermissionDecision>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<PermissionDecision>('evaluate_agent_permission', { request });
  }
  const { evaluateAgentPermission: apiEvaluateAgentPermission } = await import('./apiClient');
  return apiEvaluateAgentPermission(request);
}

export async function executeAgentTool(
  request: ToolExecutionRequest
): Promise<ApiResponse<ToolResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<ToolResult>('execute_agent_tool', { request });
  }
  const { executeAgentTool: apiExecuteAgentTool } = await import('./apiClient');
  return apiExecuteAgentTool(request);
}

// ---- Internal browser skeleton ----

export async function getBrowserRuntimeStatus(): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<BrowserRuntimeStatusResult>('get_browser_runtime_status');
  }
  const { getBrowserRuntimeStatus: apiGetBrowserRuntimeStatus } = await import('./apiClient');
  return apiGetBrowserRuntimeStatus();
}

export async function openBrowserPreview(
  request: OpenBrowserPreviewRequest
): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<BrowserRuntimeStatusResult>('open_browser_preview', { request });
  }
  const { openBrowserPreview: apiOpenBrowserPreview } = await import('./apiClient');
  return apiOpenBrowserPreview(request);
}

export async function reloadBrowserPreview(): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<BrowserRuntimeStatusResult>('reload_browser_preview');
  }
  const { reloadBrowserPreview: apiReloadBrowserPreview } = await import('./apiClient');
  return apiReloadBrowserPreview();
}

export async function setBrowserInspectMode(
  request: SetBrowserInspectModeRequest
): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<BrowserRuntimeStatusResult>('set_browser_inspect_mode', { request });
  }
  const { setBrowserInspectMode: apiSetBrowserInspectMode } = await import('./apiClient');
  return apiSetBrowserInspectMode(request);
}

export async function getSelectedPanelSnapshot(): Promise<ApiResponse<PanelSnapshotResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<PanelSnapshotResult>('get_selected_panel_snapshot');
  }
  const { getSelectedPanelSnapshot: apiGetSelectedPanelSnapshot } = await import('./apiClient');
  return apiGetSelectedPanelSnapshot();
}

export async function attachPanelSnapshotToAgent(): Promise<ApiResponse<AttachPanelSnapshotResult>> {
  if (getRuntimeType() === 'tauri') {
    return tauriInvoke<AttachPanelSnapshotResult>('attach_panel_snapshot_to_agent');
  }
  const { attachPanelSnapshotToAgent: apiAttachPanelSnapshotToAgent } = await import('./apiClient');
  return apiAttachPanelSnapshotToAgent();
}
