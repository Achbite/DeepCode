import type {
  ApiResponse,
  BrowsePathResult,
  BrowserRuntimeStatusResult,
  CodeGrepInput,
  CodeGrepResult,
  CreateTerminalSessionRequest,
  FileReadResult,
  FileTreeNode,
  GetUserSettingsResult,
  GitDiffResult,
  GitStatusResult,
  HealthStatus,
  InitialLocations,
  KernelHostInspectionQuery,
  KernelHostInspectionResult,
  LlmProbeRequest,
  LlmProbeResult,
  LlmProfilesResult,
  OpenBrowserPreviewRequest,
  OpenWorkspaceResult,
  PatchLlmProfilesRequest,
  PatchUserSettingsResult,
  PatchWorkspaceSettingsResult,
  SaveWorkspaceFileRequest,
  SaveWorkspaceFileResult,
  SetBrowserInspectModeRequest,
  ShellEnvironmentStatus,
  TerminalCapability,
  TerminalEventsResult,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSessionsResult,
  TerminalWarmupStatus,
  UserSettingValue,
  WorkspaceState,
} from '@deepcode/protocol';
import { activeT } from '../i18n';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';

const API_BASE = getKernelApiBase();

export interface DefaultWorkspacePathResult {
  path: string | null;
}

interface SendJsonOptions {
  signal?: AbortSignal;
}

function endpointLabel(url: string): string {
  try {
    return new URL(
      url,
      typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
    ).pathname;
  } catch {
    return url;
  }
}

async function httpErrorMessage(response: Response, url: string): Promise<string> {
  const fallback = `HTTP ${response.status}: ${response.statusText} (${endpointLabel(url)})`;
  const body = await response.text().catch(() => '');
  if (!body.trim()) return fallback;
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const message = typeof value.message === 'string'
      ? value.message
      : typeof value.error === 'string'
        ? value.error
        : null;
    return message ? `${fallback} - ${message}` : fallback;
  } catch {
    return fallback;
  }
}

function errorResponse(error: unknown): ApiResponse<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { ok: false, error: 'aborted', message };
  }
  if (error instanceof TypeError) {
    return {
      ok: false,
      error: 'network_error',
      message: activeT('api.error.networkUnavailable', { message }),
    };
  }
  return { ok: false, error: 'request_failed', message };
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      headers: getHostConnectionHeaders(),
      signal,
    });
    if (!response.ok) {
      return { ok: false, error: 'http_error', message: await httpErrorMessage(response, url) };
    }
    return await response.json() as ApiResponse<T>;
  } catch (error) {
    return errorResponse(error);
  }
}

async function sendJson<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  options: SendJsonOptions = {},
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...getHostConnectionHeaders(),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      return { ok: false, error: 'http_error', message: await httpErrorMessage(response, url) };
    }
    return await response.json() as ApiResponse<T>;
  } catch (error) {
    return errorResponse(error);
  }
}

function queryString(values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

async function inspectHost<T>(query: KernelHostInspectionQuery): Promise<ApiResponse<T>> {
  const response = await sendJson<KernelHostInspectionResult>(
    `${API_BASE}/host/inspect`,
    'POST',
    query,
  );
  const output = response.data?.output;
  if (!output) return { ...response, data: undefined };
  if (output.kind !== query.kind) {
    return {
      ok: false,
      error: 'host_inspection_kind_mismatch',
      message: `Host 返回了 ${output.kind}，但请求的是 ${query.kind}。`,
    };
  }
  return { ...response, data: output.data as T };
}

export function getHealth(): Promise<ApiResponse<HealthStatus>> {
  return getJson(`${API_BASE}/health`);
}

export function getCurrentWorkspace(): Promise<ApiResponse<WorkspaceState>> {
  return getJson(`${API_BASE}/workspaces/current`);
}

export function getDefaultWorkspacePath(): Promise<ApiResponse<DefaultWorkspacePathResult>> {
  return getJson(`${API_BASE}/workspaces/default-path`);
}

export function openWorkspace(path: string): Promise<ApiResponse<OpenWorkspaceResult>> {
  return sendJson(`${API_BASE}/workspaces/open`, 'POST', { path });
}

export function saveWorkspaceFile(
  request: SaveWorkspaceFileRequest,
): Promise<ApiResponse<SaveWorkspaceFileResult>> {
  return sendJson(`${API_BASE}/workspaces/save-file`, 'POST', request);
}

export function patchWorkspaceSettings(
  settings: Record<string, unknown>,
): Promise<ApiResponse<PatchWorkspaceSettingsResult>> {
  return sendJson(`${API_BASE}/workspaces/current/settings`, 'PATCH', { settings });
}

export function getInitialLocations(): Promise<ApiResponse<InitialLocations>> {
  return getJson(`${API_BASE}/fs/initial-locations`);
}

export function browsePath(absolutePath?: string): Promise<ApiResponse<BrowsePathResult>> {
  return getJson(`${API_BASE}/fs/browse${queryString({ path: absolutePath })}`);
}

export function getFileTree(
  folderId?: string,
  relativePath?: string,
): Promise<ApiResponse<FileTreeNode[]>> {
  return inspectHost({ kind: 'list', folderId, path: relativePath || '.', depth: 2 });
}

export function readFile(
  filePath: string,
  folderId?: string,
): Promise<ApiResponse<FileReadResult>> {
  return inspectHost({ kind: 'read', folderId, path: filePath });
}

export function codeSearch(request: CodeGrepInput): Promise<ApiResponse<CodeGrepResult>> {
  return inspectHost({
    kind: 'grep',
    query: request.query,
    path: request.path || '.',
    include: request.include ?? [],
    exclude: request.exclude ?? [],
    strategy: request.strategy ?? 'literal',
    contextLines: request.contextLines ?? 0,
    maxResults: request.maxResults ?? 200,
  });
}

export function getGitStatus(): Promise<ApiResponse<GitStatusResult>> {
  return inspectHost({ kind: 'gitStatus' });
}

export function getGitDiff(
  path?: string,
  staged = false,
): Promise<ApiResponse<GitDiffResult>> {
  return inspectHost({ kind: 'gitDiff', path, staged });
}

export function getUserSettings(): Promise<ApiResponse<GetUserSettingsResult>> {
  return getJson(`${API_BASE}/user-settings`);
}

export function patchUserSettings(
  patches: Record<string, UserSettingValue>,
): Promise<ApiResponse<PatchUserSettingsResult>> {
  return sendJson(`${API_BASE}/user-settings`, 'PATCH', { patches });
}

export function getLlmProfiles(): Promise<ApiResponse<LlmProfilesResult>> {
  return getJson(`${API_BASE}/llm/profiles`);
}

export function patchLlmProfiles(
  request: PatchLlmProfilesRequest,
): Promise<ApiResponse<LlmProfilesResult>> {
  return sendJson(`${API_BASE}/llm/profiles`, 'PATCH', request);
}

export function probeLlmProfile(
  request: LlmProbeRequest,
): Promise<ApiResponse<LlmProbeResult>> {
  return sendJson(`${API_BASE}/llm/probe`, 'POST', request);
}

export function getShellEnvironment(): Promise<ApiResponse<ShellEnvironmentStatus>> {
  return getJson(`${API_BASE}/runtime/shell`);
}

export function getTerminalCapabilities(): Promise<ApiResponse<TerminalCapability>> {
  return getJson(`${API_BASE}/terminal/capabilities`);
}

export function getTerminalWarmupStatus(): Promise<ApiResponse<TerminalWarmupStatus>> {
  return getJson(`${API_BASE}/terminal/warmup`);
}

export function warmupTerminalRuntime(): Promise<ApiResponse<TerminalWarmupStatus>> {
  return sendJson(`${API_BASE}/terminal/warmup`, 'POST', {});
}

export function listTerminalSessions(): Promise<ApiResponse<TerminalSessionsResult>> {
  return getJson(`${API_BASE}/terminal/sessions`);
}

export function createTerminalSession(
  request: CreateTerminalSessionRequest,
): Promise<ApiResponse<TerminalSession>> {
  return sendJson(`${API_BASE}/terminal/sessions`, 'POST', request);
}

export function sendTerminalInput(
  sessionId: string,
  request: TerminalInputRequest,
): Promise<ApiResponse<TerminalSession>> {
  return sendJson(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}/input`,
    'POST',
    request,
  );
}

export function resizeTerminalSession(
  sessionId: string,
  request: TerminalResizeRequest,
): Promise<ApiResponse<TerminalSession>> {
  return sendJson(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}/resize`,
    'POST',
    request,
  );
}

export function updateTerminalSession(
  sessionId: string,
  request: Partial<Pick<TerminalSession, 'name' | 'order'>>,
): Promise<ApiResponse<TerminalSession>> {
  return sendJson(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}`,
    'PATCH',
    request,
  );
}

export function restartTerminalSession(
  sessionId: string,
): Promise<ApiResponse<TerminalSession>> {
  return sendJson(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}/restart`,
    'POST',
    {},
  );
}

export function deleteTerminalSession(
  sessionId: string,
): Promise<ApiResponse<TerminalSession>> {
  return sendJson(
    `${API_BASE}/terminal/sessions/${encodeURIComponent(sessionId)}`,
    'DELETE',
    {},
  );
}

export function getTerminalEvents(
  sessionId?: string,
  after?: number,
): Promise<ApiResponse<TerminalEventsResult>> {
  return getJson(`${API_BASE}/terminal/events${queryString({
    sessionId,
    after: after === undefined ? undefined : String(after),
  })}`);
}

export function getBrowserRuntimeStatus(): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return getJson(`${API_BASE}/browser/runtime-status`);
}

export function openBrowserPreview(
  request: OpenBrowserPreviewRequest,
): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return sendJson(`${API_BASE}/browser/open`, 'POST', request);
}

export function reloadBrowserPreview(): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return sendJson(`${API_BASE}/browser/reload`, 'POST', {});
}

export function setBrowserInspectMode(
  request: SetBrowserInspectModeRequest,
): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return sendJson(`${API_BASE}/browser/inspect-mode`, 'POST', request);
}
