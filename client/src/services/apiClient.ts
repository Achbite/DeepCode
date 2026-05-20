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
  WorkspaceState,
  OpenWorkspaceResult,
  PatchWorkspaceSettingsResult,
  BrowsePathResult,
  InitialLocations,
  GetUserSettingsResult,
  PatchUserSettingsResult,
  UserSettingValue,
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
  method: 'POST' | 'PATCH' | 'PUT',
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

// 重新导出共享 DTO
export type {
  FileTreeNode,
  FileReadResult,
  FileWriteResult,
  CreateFolderResult,
  WorkspaceState,
  OpenWorkspaceResult,
  BrowsePathResult,
  InitialLocations,
};
