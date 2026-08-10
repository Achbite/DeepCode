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
  CodeGrepInput,
  CodeGrepResult,
  GitStatusResult,
  GitDiffResult,
  AgentProjectListResult,
  AgentProjectResult,
  AgentSessionListResult,
  CreateAgentProjectRequest,
  CreateAgentSessionRequest,
  ListAgentSessionsRequest,
  RenameAgentSessionRequest,
  RebindAgentProjectRequest,
  UpdateAgentProjectRequest,
  UpdateAgentSessionRequest,
  ArchiveAgentSessionRequest,
  AgentSessionResult,
  AgentTimelineStreamEvent,
  AgentTimelineResult,
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
  KernelHostSkillCatalogResult,
  BrowserRuntimeStatusResult,
  OpenBrowserPreviewRequest,
  SetBrowserInspectModeRequest,
  KernelHostInspectionQuery,
  KernelHostInspectionResult,
  AgentRunGuidanceRequest,
  StartAgentRunRequest,
} from '@deepcode/protocol';
import { activeT } from '../i18n';
import { getHostAdmissionHeaders, getKernelApiBase } from './hostTarget';

const API_BASE = getKernelApiBase();

interface SendJsonOptions {
  signal?: AbortSignal;
}

export type {
  AgentInputAttachmentV2,
  AgentRunGuidanceRequest,
  AskAgentRunRequest,
  ResolveAgentRunDecisionRequest,
  StartAgentRunRequest,
} from '@deepcode/protocol';

function agentRunMutationPayload(request: StartAgentRunRequest): StartAgentRunRequest {
  if (request.op === 'ask') {
    return {
      op: 'ask',
      content: request.content,
      workspacePath: request.workspacePath,
      noWorkspace: request.noWorkspace,
      attachments: request.attachments,
      callerRequestId: request.callerRequestId,
    };
  }
  return {
    op: 'resolveDecision',
    decisionKind: request.decisionKind,
    decision: request.decision,
    guidance: request.guidance,
    runId: request.runId,
    targetId: request.targetId,
    callerRequestId: request.callerRequestId,
  };
}

export interface AgentRunStatus {
  runId: string;
  sessionId: string;
  profileId?: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  message?: string;
}

export interface AgentRunResult {
  run: AgentRunStatus;
  session: AgentSessionResult['session'];
  inputId?: string;
}

function endpointLabel(url: string): string {
  try {
    const parsed = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
    return parsed.pathname;
  } catch {
    return url;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field : null;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const field = value[key];
  return isRecord(field) ? field : null;
}

function extractErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = stringField(value, 'message') ?? stringField(value, 'error');
  if (direct) return direct;
  const error = objectField(value, 'error');
  return error
    ? stringField(error, 'message') ?? stringField(error, 'code')
    : null;
}

function redactHttpErrorBody(value: string): string {
  const lines = value.split(/\r?\n/).map((line) => {
    const lower = line.toLowerCase();
    return lower.includes('authorization') ||
      lower.includes('api_key') ||
      lower.includes('apikey') ||
      lower.includes('secret') ||
      lower.includes('password') ||
      lower.includes('token') ||
      lower.includes('bearer ')
      ? '[redacted-http-error-line]'
      : line;
  });
  return lines.join('\n').trim().slice(0, 800);
}

async function httpErrorMessage(response: Response, url: string): Promise<string> {
  const label = endpointLabel(url);
  const fallback = `HTTP ${response.status}: ${response.statusText} (${label})`;
  const raw = await response.text().catch(() => '');
  const preview = redactHttpErrorBody(raw);
  if (!preview) return fallback;

  try {
    const parsed = JSON.parse(raw) as unknown;
    const parsedMessage = extractErrorMessage(parsed);
    if (parsedMessage) return `${fallback} - ${parsedMessage}`;
  } catch {
    // 非 JSON 错误体直接使用安全摘要。
  }
  return `${fallback} - ${preview}`;
}

export interface SkillScanItem {
  sourceKind: 'manifest' | 'skillMd' | string;
  manifestStatus: 'parsed' | 'inferred' | string;
  sourcePath: string;
  relativePath: string;
  skillId: string;
  version: string;
  title: string;
  description: string;
  entrypointKind: string;
  trustMode: string;
  workspaceAccess: string;
  requestedCapabilities: string[];
  effects: string[];
  envAllowlist: string[];
  modelVisible: boolean;
  requiresApproval: boolean;
  activationStatus: 'dormant' | 'registered';
  riskLevel: 'low' | 'medium' | 'high' | string;
}

export interface SkillMountScanResult {
  mountPath: string;
  scannedAt: string;
  skills: SkillScanItem[];
  warnings: string[];
}

export interface DefaultWorkspacePathResult {
  path: string | null;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === 'AbortError'
  ) || (
    err instanceof Error && err.name === 'AbortError'
  );
}

/** 把任意异常转换为 ApiResponse 错误结构 */
function toErrorResponse(err: unknown): ApiResponse<never> {
  if (isAbortError(err)) {
    return {
      ok: false,
      error: 'request_aborted',
      message: 'Request aborted.',
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('Failed to fetch')
  ) {
    return {
      ok: false,
      error: 'network_error',
      message: activeT('api.error.networkUnavailable', { message }),
    };
  }
  return {
    ok: false,
    error: 'unknown_error',
    message,
  };
}

/** 通用 GET 包装 */
async function getJson<T>(
  url: string,
  signal?: AbortSignal
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      headers: getHostAdmissionHeaders(),
      signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: await httpErrorMessage(response, url),
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
  body: unknown,
  options: SendJsonOptions = {}
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...getHostAdmissionHeaders(),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: await httpErrorMessage(response, url),
      };
    }
    return (await response.json()) as ApiResponse<T>;
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function sendReplayableHostMutation<T>(
  url: string,
  body: unknown
): Promise<ApiResponse<T>> {
  const response = await sendJson<T>(url, 'POST', body);
  if (response.error !== 'network_error') {
    return response;
  }
  return sendJson<T>(url, 'POST', body);
}

interface SseStreamEvent {
  event: string;
  data: unknown;
}

export class AgentTimelineStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTimelineStreamProtocolError';
  }
}

async function streamSse(
  url: string,
  eventNames: readonly string[],
  onEvent: (event: SseStreamEvent) => void,
  terminalEventNames: readonly string[] = [],
  signal?: AbortSignal
): Promise<void> {
  if (
    typeof EventSource !== 'undefined' &&
    Object.keys(getHostAdmissionHeaders()).length === 0
  ) {
    return streamSseWithEventSource(
      url,
      eventNames,
      onEvent,
      terminalEventNames,
      signal
    );
  }
  return streamSseWithFetch(url, onEvent, signal);
}

function streamSseWithEventSource(
  url: string,
  eventNames: readonly string[],
  onEvent: (event: SseStreamEvent) => void,
  terminalEventNames: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const source = new EventSource(url);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      source.close();
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish();
    const handleMessage = (eventName: string, event: Event) => {
      const message = event as MessageEvent<string>;
      if (typeof message.data !== 'string' || !message.data.trim()) {
        if (eventName === 'error') {
          finish(new Error(`Agent stream disconnected (${endpointLabel(url)})`));
        }
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(message.data) as unknown;
      } catch {
        data = {
          code: 'invalid_sse_payload',
          message: 'Agent stream returned invalid JSON payload.',
        };
        eventName = 'error';
      }
      try {
        onEvent({ event: eventName, data });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (terminalEventNames.includes(eventName)) finish();
    };

    for (const eventName of new Set([...eventNames, 'error'])) {
      source.addEventListener(eventName, (event) => handleMessage(eventName, event));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function streamSseWithFetch(
  url: string,
  onEvent: (event: SseStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/event-stream',
      ...getHostAdmissionHeaders(),
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(await httpErrorMessage(response, url));
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`Streaming response has no body (${endpointLabel(url)})`);
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const consumed = consumeSseEvents(buffer);
    buffer = consumed.remaining;
    for (const event of consumed.items) onEvent(event);
  }
  buffer += decoder.decode();
  const consumed = consumeSseEvents(`${buffer}\n\n`);
  for (const event of consumed.items) onEvent(event);
}

function consumeSseEvents(buffer: string): { items: SseStreamEvent[]; remaining: string } {
  const items: SseStreamEvent[] = [];
  let remaining = buffer;
  for (;;) {
    const boundary = remaining.search(/\r?\n\r?\n/);
    if (boundary < 0) break;
    const raw = remaining.slice(0, boundary);
    const separator = remaining.slice(boundary).match(/^\r?\n\r?\n/);
    remaining = remaining.slice(boundary + (separator?.[0].length ?? 2));
    const event = parseSseEvent(raw);
    if (event) items.push(event);
  }
  return { items, remaining };
}

function parseSseEvent(raw: string): SseStreamEvent | null {
  if (!raw.trim()) return null;
  let eventName = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    if (field === 'event') eventName = value;
    if (field === 'data') data.push(value);
  }
  const payload = data.join('\n').trim();
  if (!payload) return null;
  try {
    return { event: eventName, data: JSON.parse(payload) as unknown };
  } catch {
    return {
      event: 'error',
      data: {
        code: 'invalid_sse_payload',
        message: 'Agent timeline stream returned invalid JSON payload.',
      },
    };
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

export function getDefaultWorkspacePath(): Promise<ApiResponse<DefaultWorkspacePathResult>> {
  return getJson<DefaultWorkspacePathResult>(`${API_BASE}/workspaces/default-path`);
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

export function scanSkillMount(
  path: string
): Promise<ApiResponse<SkillMountScanResult>> {
  return sendJson<SkillMountScanResult>(
    `${API_BASE}/host/skills/scan-mount`,
    'POST',
    { path }
  );
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

async function inspectHost<T>(query: KernelHostInspectionQuery): Promise<ApiResponse<T>> {
  const response = await sendJson<KernelHostInspectionResult>(
    `${API_BASE}/host/inspect`,
    'POST',
    query
  );
  const output = response.data?.output;
  if (!output) return { ...response, data: undefined };
  if (output.kind !== query.kind) {
    return {
      ok: false,
      error: 'host_inspection_contract_mismatch',
      message: `Host inspection returned ${output.kind} for ${query.kind}.`,
    };
  }
  return { ...response, data: output.data as T };
}

export function getFileTree(
  folderId?: string,
  relativePath?: string
): Promise<ApiResponse<FileTreeNode[]>> {
  return inspectHost<FileTreeNode[]>({
    kind: 'list',
    folderId,
    path: relativePath || '.',
    depth: 2,
  });
}

export function readFile(
  filePath: string,
  folderId?: string
): Promise<ApiResponse<FileReadResult>> {
  return inspectHost<FileReadResult>({ kind: 'read', folderId, path: filePath });
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

export function codeSearch(
  request: CodeGrepInput
): Promise<ApiResponse<CodeGrepResult>> {
  return inspectHost<CodeGrepResult>({
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

export function createAgentSession(
  request: CreateAgentSessionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return sendJson<AgentSessionResult>(
    `${API_BASE}/agent/sessions`,
    'POST',
    request
  );
}

export function listAgentSessions(
  request: ListAgentSessionsRequest = {}
): Promise<ApiResponse<AgentSessionListResult>> {
  const qs = buildQuery({
    projectId: request.projectId,
    workspaceId: request.workspaceId,
    workspaceHash: request.workspaceHash,
    includeArchived: request.includeArchived ? 'true' : undefined,
    includeAllScopes: request.includeAllScopes ? 'true' : undefined,
  });
  return getJson<AgentSessionListResult>(`${API_BASE}/agent/sessions${qs}`);
}

export function getCurrentAgentSession(
  request: ListAgentSessionsRequest = {}
): Promise<ApiResponse<AgentSessionResult | null>> {
  const qs = buildQuery({
    projectId: request.projectId,
    workspaceId: request.workspaceId,
    workspaceHash: request.workspaceHash,
  });
  return getJson<AgentSessionResult | null>(`${API_BASE}/agent/sessions/current${qs}`);
}

export function activateAgentSession(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse<AgentSessionResult>> {
  return sendJson<AgentSessionResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/activate`,
    'POST',
    {},
    { signal }
  );
}

export function renameAgentSession(
  sessionId: string,
  request: RenameAgentSessionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return sendJson<AgentSessionResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}`,
    'PATCH',
    request
  );
}

export function updateAgentSession(
  sessionId: string,
  request: UpdateAgentSessionRequest
): Promise<ApiResponse<AgentSessionResult>> {
  return sendJson<AgentSessionResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}`,
    'PATCH',
    request
  );
}

export function listAgentProjects(): Promise<ApiResponse<AgentProjectListResult>> {
  return getJson<AgentProjectListResult>(`${API_BASE}/agent/projects`);
}

export function createAgentProject(
  request: CreateAgentProjectRequest
): Promise<ApiResponse<AgentProjectResult>> {
  return sendJson<AgentProjectResult>(`${API_BASE}/agent/projects`, 'POST', request);
}

export function updateAgentProject(
  projectId: string,
  request: UpdateAgentProjectRequest
): Promise<ApiResponse<AgentProjectResult>> {
  return sendJson<AgentProjectResult>(
    `${API_BASE}/agent/projects/${encodeURIComponent(projectId)}`,
    'PATCH',
    request
  );
}

export function rebindAgentProject(
  projectId: string,
  request: RebindAgentProjectRequest
): Promise<ApiResponse<AgentProjectResult>> {
  return sendJson<AgentProjectResult>(
    `${API_BASE}/agent/projects/${encodeURIComponent(projectId)}/rebind`,
    'POST',
    request
  );
}

export function deleteAgentProject(
  projectId: string
): Promise<ApiResponse<AgentProjectListResult>> {
  return sendJson<AgentProjectListResult>(
    `${API_BASE}/agent/projects/${encodeURIComponent(projectId)}`,
    'DELETE',
    {}
  );
}

export function archiveAgentSession(
  sessionId: string,
  request: ArchiveAgentSessionRequest = { archived: true }
): Promise<ApiResponse<AgentSessionListResult>> {
  return sendJson<AgentSessionListResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/archive`,
    'POST',
    request
  );
}

export async function deleteAgentSession(
  sessionId: string
): Promise<ApiResponse<AgentSessionListResult>> {
  const result = await sendJson<AgentSessionListResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}`,
    'DELETE',
    {}
  );
  if (!result.ok && result.error === 'http_error' && result.message?.includes('405')) {
    return archiveAgentSession(sessionId, { archived: true });
  }
  return result;
}

export function getAgentTimeline(
  sessionId: string,
  signal?: AbortSignal
): Promise<ApiResponse<AgentTimelineResult>> {
  return getJson<AgentTimelineResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/timeline`,
    signal
  );
}

export function streamAgentTimeline(
  sessionId: string,
  onEvent: (event: AgentTimelineStreamEvent) => void,
  cursor?: { afterRevision?: number },
  signal?: AbortSignal
): Promise<void> {
  const qs = buildQuery({
    afterRevision: cursor?.afterRevision === undefined
      ? undefined
      : String(cursor.afterRevision),
  });
  return streamSse(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/timeline/stream${qs}`,
    ['snapshot', 'delta'],
    (event) => {
      if (event.event === 'error') {
        const detail = isRecord(event.data)
          ? stringField(event.data, 'message') ?? stringField(event.data, 'code')
          : null;
        if (isRecord(event.data) && event.data.code === 'invalid_sse_payload') {
          throw new AgentTimelineStreamProtocolError(
            detail ?? 'Agent timeline stream returned invalid JSON.'
          );
        }
        throw new Error(detail ?? 'Agent timeline stream disconnected');
      }
      if (
        (event.event !== 'snapshot' && event.event !== 'delta')
        || !isRecord(event.data)
        || event.data.type !== event.event
      ) {
        throw new AgentTimelineStreamProtocolError(
          'Agent timeline stream returned an invalid event envelope.'
        );
      }
      onEvent(event.data as unknown as AgentTimelineStreamEvent);
    },
    [],
    signal
  );
}

export function startAgentRun(
  sessionId: string,
  request: StartAgentRunRequest
): Promise<ApiResponse<AgentRunResult>> {
  return sendReplayableHostMutation<AgentRunResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/runs`,
    agentRunMutationPayload(request)
  );
}

export function getAgentRun(
  sessionId: string,
  runId: string,
  signal?: AbortSignal
): Promise<ApiResponse<AgentRunResult>> {
  return getJson<AgentRunResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
    signal
  );
}

export function cancelAgentRunById(
  sessionId: string,
  runId: string,
  callerRequestId: string
): Promise<ApiResponse<AgentRunResult>> {
  return sendReplayableHostMutation<AgentRunResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { callerRequestId }
  );
}

export function submitAgentRunGuidance(
  sessionId: string,
  runId: string,
  request: AgentRunGuidanceRequest
): Promise<ApiResponse<AgentRunResult>> {
  return sendReplayableHostMutation<AgentRunResult>(
    `${API_BASE}/agent/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/guidance`,
    {
      guidance: request.guidance,
      workspacePath: request.workspacePath,
      noWorkspace: request.noWorkspace,
      attachments: request.attachments,
      callerRequestId: request.callerRequestId,
    }
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

export function getHostSkills(): Promise<ApiResponse<KernelHostSkillCatalogResult>> {
  return getJson<KernelHostSkillCatalogResult>(`${API_BASE}/host/skills`);
}

export function getGitStatus(): Promise<ApiResponse<GitStatusResult>> {
  return inspectHost<GitStatusResult>({ kind: 'gitStatus' });
}

export function getGitDiff(path?: string, staged?: boolean): Promise<ApiResponse<GitDiffResult>> {
  return inspectHost<GitDiffResult>({ kind: 'gitDiff', path, staged: staged ?? false });
}

export function getBrowserRuntimeStatus(): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return getJson<BrowserRuntimeStatusResult>(`${API_BASE}/browser/runtime-status`);
}

export function openBrowserPreview(
  request: OpenBrowserPreviewRequest
): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return sendJson<BrowserRuntimeStatusResult>(`${API_BASE}/browser/open`, 'POST', request);
}

export function reloadBrowserPreview(): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return sendJson<BrowserRuntimeStatusResult>(`${API_BASE}/browser/reload`, 'POST', {});
}

export function setBrowserInspectMode(
  request: SetBrowserInspectModeRequest
): Promise<ApiResponse<BrowserRuntimeStatusResult>> {
  return sendJson<BrowserRuntimeStatusResult>(
    `${API_BASE}/browser/inspect-mode`,
    'POST',
    request
  );
}

// 重新导出共享 DTO
export type {
  FileTreeNode,
  FileReadResult,
  WorkspaceState,
  OpenWorkspaceResult,
  BrowsePathResult,
  InitialLocations,
  TerminalSession,
  TerminalEvent,
  TerminalCapability,
  TerminalWarmupStatus,
  ShellEnvironmentStatus,
  BrowserRuntimeStatusResult,
};
