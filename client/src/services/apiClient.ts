/**
 * REST API 客户端
 *
 * 封装与后端的 HTTP 通信；DTO 全部来自共享 protocol 包。
 * 工作区模型升级版：所有文件 API 都接受可选 folderId；省略时由后端落到 folders[0]。
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
  PatchWorkspaceSettingsResult,
  BrowsePathResult,
  InitialLocations,
  GetUserSettingsResult,
  PatchUserSettingsResult,
  UserSettingValue,
  LlmProfilesResult,
  PatchLlmProfilesRequest,
  LlmProbeRequest,
  LlmProbeResult,
  LlmChatRequest,
  LlmChatResult,
  CodeSearchInput,
  CodeSearchResult,
  AgentMode,
  CreateAgentSessionRequest,
  AgentSessionResult,
  AppendAgentEventsRequest,
  ListToolsResult,
  PermissionEvaluationRequest,
  PermissionDecision,
  ToolExecutionRequest,
  ToolResult,
  ShellEnvironmentStatus,
  TerminalCapability,
  TerminalSession,
  TerminalEvent,
  TerminalSessionsResult,
  TerminalEventsResult,
  TerminalWarmupStatus,
  CreateTerminalSessionRequest,
  TerminalInputRequest,
  TerminalResizeRequest,
  AgentActionParseRequest,
  AgentActionParseResult,
  AgentFixtureRunRequest,
  AgentFixtureRunResult,
  PromptLayerResult,
  SkillReferenceResult,
} from '@deepcode/protocol';

const API_BASE = '/api';

/** 把任意异常转换为 ApiResponse 错误结构 */
function toErrorResponse(err: unknown): ApiResponse<never> {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('Failed to fetch')
  ) {
    return {
      ok: false,
      error: 'network_error',
      message: `网络不可达: ${message}`,
    };
  }
  return {
    ok: false,
    error: 'unknown_error',
    message,
  };
}

/** 通用 GET 包装 */
async function getJson<T>(url: string): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    return (await response.json()) as ApiResponse<T>;
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** 通用 JSON Body 请求 */
async function sendJson<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body: unknown
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    return (await response.json()) as ApiResponse<T>;
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ---- 健康检查 ----

export function getHealth(): Promise<ApiResponse<HealthStatus>> {
  return getJson<HealthStatus>(`${API_BASE}/health`);
}

// ---- 工作区 ----

export function getCurrentWorkspace(): Promise<ApiResponse<WorkspaceState>> {
  return getJson<WorkspaceState>(`${API_BASE}/workspaces/current`);
}

export function openWorkspace(
  path: string
): Promise<ApiResponse<OpenWorkspaceResult>> {
  return sendJson<OpenWorkspaceResult>(
    `${API_BASE}/workspaces/open`,
    'POST',
    { path }
  );
}

export function saveWorkspaceFile(
  request: SaveWorkspaceFileRequest
): Promise<ApiResponse<SaveWorkspaceFileResult>> {
  return sendJson<SaveWorkspaceFileResult>(
    `${API_BASE}/workspaces/save-file`,
    'POST',
    request
  );
}

export function patchWorkspaceSettings(
  settings: Record<string, unknown>
): Promise<ApiResponse<PatchWorkspaceSettingsResult>> {
  return sendJson<PatchWorkspaceSettingsResult>(
    `${API_BASE}/workspaces/current/settings`,
    'PATCH',
    { settings }
  );
}

// ---- 文件系统浏览（仅用于"Open Workspace"对话框）----

export function getInitialLocations(): Promise<ApiResponse<InitialLocations>> {
  return getJson<InitialLocations>(`${API_BASE}/fs/initial-locations`);
}

export function browsePath(
  absolutePath?: string
): Promise<ApiResponse<BrowsePathResult>> {
  const qs = buildQuery({ path: absolutePath });
  return getJson<BrowsePathResult>(`${API_BASE}/fs/browse${qs}`);
}

// ---- 文件 ----

/** 拼接 ?folderId=&path= 形态的查询串 */
function buildQuery(params: Record<string, string | undefined>): string {
  const segments: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    segments.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return segments.length === 0 ? '' : `?${segments.join('&')}`;
}

export function getFileTree(
  folderId?: string,
  relativePath?: string
): Promise<ApiResponse<FileTreeNode[]>> {
  const qs = buildQuery({ folderId, path: relativePath });
  return getJson<FileTreeNode[]>(`${API_BASE}/files/tree${qs}`);
}

export function readFile(
  filePath: string,
  folderId?: string
): Promise<ApiResponse<FileReadResult>> {
  const qs = buildQuery({ folderId, path: filePath });
  return getJson<FileReadResult>(`${API_BASE}/files/read${qs}`);
}

export function writeFile(
  filePath: string,
  content: string,
  folderId?: string
): Promise<ApiResponse<FileWriteResult>> {
  return sendJson<FileWriteResult>(
    `${API_BASE}/files/write`,
    'POST',
    { folderId, path: filePath, content }
  );
}

export function createFile(
  filePath: string,
  content?: string,
  folderId?: string
): Promise<ApiResponse<FileWriteResult>> {
  return sendJson<FileWriteResult>(
    `${API_BASE}/files/create`,
    'POST',
    { folderId, path: filePath, content: content ?? '' }
  );
}

export function createFolder(
  folderPath: string,
  folderId?: string
): Promise<ApiResponse<CreateFolderResult>> {
  return sendJson<CreateFolderResult>(
    `${API_BASE}/folders/create`,
    'POST',
    { folderId, path: folderPath }
  );
}

export function renameEntry(
  oldPath: string,
  newPath: string,
  folderId?: string
): Promise<ApiResponse<RenameEntryResult>> {
  return sendJson<RenameEntryResult>(
    `${API_BASE}/files/rename`,
    'POST',
    { folderId, oldPath, newPath }
  );
}

// ---- 用户设置（阶段 4 / S4-4）----

export function getUserSettings(): Promise<ApiResponse<GetUserSettingsResult>> {
  return getJson<GetUserSettingsResult>(`${API_BASE}/user-settings`);
}

export function patchUserSettings(
  patches: Record<string, UserSettingValue>
): Promise<ApiResponse<PatchUserSettingsResult>> {
  return sendJson<PatchUserSettingsResult>(
    `${API_BASE}/user-settings`,
    'PATCH',
    { patches }
  );
}

// ---- LLM profiles / chat（阶段 6 / S6-1）----

export function getLlmProfiles(): Promise<ApiResponse<LlmProfilesResult>> {
  return getJson<LlmProfilesResult>(`${API_BASE}/llm/profiles`);
}

export function patchLlmProfiles(
  request: PatchLlmProfilesRequest
): Promise<ApiResponse<LlmProfilesResult>> {
  return sendJson<LlmProfilesResult>(
    `${API_BASE}/llm/profiles`,
    'PATCH',
    request
  );
}

export function probeLlmProfile(
  request: LlmProbeRequest
): Promise<ApiResponse<LlmProbeResult>> {
  return sendJson<LlmProbeResult>(
    `${API_BASE}/llm/probe`,
    'POST',
    request
  );
}

export function llmChat(
  request: LlmChatRequest
): Promise<ApiResponse<LlmChatResult>> {
  return sendJson<LlmChatResult>(
    `${API_BASE}/llm/chat`,
    'POST',
    request
  );
}

export function codeSearch(
  request: CodeSearchInput
): Promise<ApiResponse<CodeSearchResult>> {
  return sendJson<CodeSearchResult>(
    `${API_BASE}/code/search`,
    'POST',
    request
  );
}

export function createAgentSession(
  request: CreateAgentSessionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return sendJson<AgentSessionResult>(
    `${API_BASE}/agent/sessions`,
    'POST',
    request
  );
}

export function getCurrentAgentSession(): Promise<ApiResponse<AgentSessionResult | null>> {
  return getJson<AgentSessionResult | null>(`${API_BASE}/agent/sessions/current`);
}

export function appendAgentEvents(
  sessionId: string,
  request: AppendAgentEventsRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return sendJson<AgentSessionResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/events`,
    'POST',
    request
  );
}

export function listAgentTools(
  mode?: AgentMode
): Promise<ApiResponse<ListToolsResult>> {
  const qs = buildQuery({ mode });
  return getJson<ListToolsResult>(`${API_BASE}/agent/tools${qs}`);
}

export function evaluateAgentPermission(
  request: PermissionEvaluationRequest
): Promise<ApiResponse<PermissionDecision>> {
  return sendJson<PermissionDecision>(
    `${API_BASE}/agent/permissions/evaluate`,
    'POST',
    request
  );
}

export function executeAgentTool(
  request: ToolExecutionRequest
): Promise<ApiResponse<ToolResult>> {
  return sendJson<ToolResult>(
    `${API_BASE}/agent/tools/execute`,
    'POST',
    request
  );
}

export function getShellEnvironment(): Promise<ApiResponse<ShellEnvironmentStatus>> {
  return getJson<ShellEnvironmentStatus>(`${API_BASE}/runtime/shell`);
}

export function getTerminalCapabilities(): Promise<ApiResponse<TerminalCapability>> {
  return getJson<TerminalCapability>(`${API_BASE}/terminal/capabilities`);
}

export function getTerminalWarmupStatus(): Promise<ApiResponse<TerminalWarmupStatus>> {
  return getJson<TerminalWarmupStatus>(`${API_BASE}/terminal/warmup`);
}

export function warmupTerminalRuntime(): Promise<ApiResponse<TerminalWarmupStatus>> {
  return sendJson<TerminalWarmupStatus>(`${API_BASE}/terminal/warmup`, 'POST', {});
}

export function listTerminalSessions(): Promise<ApiResponse<TerminalSessionsResult>> {
  return getJson<TerminalSessionsResult>(`${API_BASE}/terminal/sessions`);
}

export function createTerminalSession(
  request: CreateTerminalSessionRequest
): Promise<ApiResponse<TerminalSession>> {
  return sendJson<TerminalSession>(
    `${API_BASE}/terminal/sessions`,
    'POST',
    request
  );
}

export function sendTerminalInput(
  sessionId: string,
  request: TerminalInputRequest
): Promise<ApiResponse<TerminalSession>> {
  return sendJson<TerminalSession>(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}/input`,
    'POST',
    request
  );
}

export function resizeTerminalSession(
  sessionId: string,
  request: TerminalResizeRequest
): Promise<ApiResponse<TerminalSession>> {
  return sendJson<TerminalSession>(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}/resize`,
    'POST',
    request
  );
}

export function updateTerminalSession(
  sessionId: string,
  request: Partial<Pick<TerminalSession, 'name' | 'order'>>
): Promise<ApiResponse<TerminalSession>> {
  return sendJson<TerminalSession>(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}`,
    'PATCH',
    request
  );
}

export function restartTerminalSession(
  sessionId: string
): Promise<ApiResponse<TerminalSession>> {
  return sendJson<TerminalSession>(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}/restart`,
    'POST',
    {}
  );
}

export function deleteTerminalSession(
  sessionId: string
): Promise<ApiResponse<TerminalSession>> {
  return sendJson<TerminalSession>(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}`,
    'DELETE',
    {}
  );
}

export function getTerminalEvents(
  sessionId?: string,
  after?: number
): Promise<ApiResponse<TerminalEventsResult>> {
  const qs = buildQuery({
    sessionId,
    after: after === undefined ? undefined : String(after),
  });
  return getJson<TerminalEventsResult>(`${API_BASE}/terminal/events${qs}`);
}

export function parseAgentActions(
  request: AgentActionParseRequest
): Promise<ApiResponse<AgentActionParseResult>> {
  return sendJson<AgentActionParseResult>(
    `${API_BASE}/agent/parse-actions`,
    'POST',
    request
  );
}

export function runAgentFixture(
  request: AgentFixtureRunRequest
): Promise<ApiResponse<AgentFixtureRunResult>> {
  return sendJson<AgentFixtureRunResult>(
    `${API_BASE}/agent/fixtures/run`,
    'POST',
    request
  );
}

export function getAgentPromptLayers(): Promise<ApiResponse<PromptLayerResult>> {
  return getJson<PromptLayerResult>(`${API_BASE}/agent/prompt-layers`);
}

export function getAgentSkills(): Promise<ApiResponse<SkillReferenceResult>> {
  return getJson<SkillReferenceResult>(`${API_BASE}/agent/skills`);
}

// 重新导出共享 DTO
export type {
  FileTreeNode,
  FileReadResult,
  FileWriteResult,
  CreateFolderResult,
  RenameEntryResult,
  WorkspaceState,
  OpenWorkspaceResult,
  BrowsePathResult,
  InitialLocations,
  TerminalSession,
  TerminalEvent,
  TerminalCapability,
  TerminalWarmupStatus,
  ShellEnvironmentStatus,
};
