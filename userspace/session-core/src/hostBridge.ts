import type {
  AgentContextAttachment,
  AgentSessionResult,
  AgentTimelineResult,
  AgentWorkspaceBinding,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
} from '@deepcode/protocol';
import { SessionDriverLoop, type SessionDecisionResolverInput } from './driver/sessionDriverLoop.js';
import { SessionStorageClient } from './storageClient.js';
import type { ProjectWorkingDirectory } from './context/types.js';

declare const process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdin: AsyncIterable<unknown>;
  stdout: { write(value: string): void };
  stderr: { write(value: string): void };
};

interface HostBridgeRequest {
  op: 'ask' | 'resolveDecision';
  apiBase?: string;
  sessionId?: string;
  prompt?: string;
  attachments?: AgentContextAttachment[];
  workspacePath?: string;
  noWorkspace?: boolean;
  profileId?: string;
  workflow?: 'planFirst' | 'actOnRequest';
  requirementConfirmationMode?: 'off' | 'auto' | 'always';
  reviewContinuationMode?: 'auto' | 'ask' | 'off';
  title?: string;
  decisionKind?: SessionDecisionResolverInput['kind'];
  decision?: 'accept' | 'reject' | 'revise';
  guidance?: string;
  runId?: string;
  targetId?: string;
}

interface HostBridgeResult {
  ok: boolean;
  sessionId?: string;
  session?: unknown;
  events?: unknown[];
  timeline?: AgentTimelineResult;
  finalText?: string;
  message?: string;
  error?: string;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const request = JSON.parse(raw || '{}') as HostBridgeRequest;
  const result = request.op === 'resolveDecision'
    ? await resolveDecision(request)
    : await runAsk(request);
  writeJson(result);
}

async function runAsk(request: HostBridgeRequest): Promise<HostBridgeResult> {
  const content = request.prompt?.trim();
  if (!content) throw new Error('prompt is required');

  const apiBase = normalizeApiBase(request.apiBase);
  const binding = request.noWorkspace ? undefined : workspaceBindingFromPath(request.workspacePath);
  const projectWorkingDirectory = request.noWorkspace ? undefined : projectWorkingDirectoryFromPath(request.workspacePath);
  const scope = binding ? { workspaceId: binding.workspaceId, workspaceHash: binding.workspaceHash } : {};
  const sessionResult = request.sessionId
    ? await activateSession(apiBase, request.sessionId)
    : await currentOrCreateSession(apiBase, scope, request.title ?? content);

  const sessionId = sessionResult.session.id;
  const existingEvents = sessionResult.events ?? [];
  const driver = createDriver(apiBase);
  const result = await driver.runUserTurn({
    sessionId,
    content,
    attachments: request.attachments ?? [],
    existingEvents,
    workspaceBinding: binding,
    projectWorkingDirectory,
    profileId: request.profileId,
    workflow: request.workflow,
    requirementConfirmationMode: request.requirementConfirmationMode,
    reviewContinuationMode: request.reviewContinuationMode,
  });
  const timeline = await readTimeline(apiBase, result.session.id);
  return {
    ok: true,
    sessionId: result.session.id,
    session: result.session,
    events: result.events,
    timeline,
    finalText: extractFinalText(timeline),
  };
}

async function resolveDecision(request: HostBridgeRequest): Promise<HostBridgeResult> {
  if (!request.sessionId) throw new Error('sessionId is required');
  if (!request.decisionKind) throw new Error('decisionKind is required');
  if (!request.decision) throw new Error('decision is required');

  const apiBase = normalizeApiBase(request.apiBase);
  const current = await getAgentSession(apiBase, request.sessionId);
  const binding = request.noWorkspace ? undefined : workspaceBindingFromPath(request.workspacePath);
  const projectWorkingDirectory = request.noWorkspace ? undefined : projectWorkingDirectoryFromPath(request.workspacePath);
  const driver = createDriver(apiBase);
  const result = await driver.resolveDecision({
    sessionId: request.sessionId,
    kind: request.decisionKind,
    decision: request.decision,
    guidance: request.guidance,
    runId: request.runId,
    targetId: request.targetId,
    existingEvents: current.events,
    workspaceBinding: binding,
    projectWorkingDirectory,
    profileId: request.profileId,
    workflow: request.workflow,
    reviewContinuationMode: request.reviewContinuationMode,
  });
  const timeline = await readTimeline(apiBase, result.session.id);
  return {
    ok: true,
    sessionId: result.session.id,
    session: result.session,
    events: result.events,
    timeline,
    finalText: extractFinalText(timeline),
  };
}

function createDriver(apiBase: string): SessionDriverLoop {
  const transcriptClient = new SessionStorageClient(apiBase);
  return new SessionDriverLoop({
    kernelCommand: (request) => kernelCommand(apiBase, request),
    llmChat: (request) => llmChat(apiBase, request),
    appendTranscript: (sessionId, entry) => transcriptClient.appendTranscript(sessionId, entry),
    appendEvents: async (sessionId, events) => {
      const response = await postJson<ApiResponse<AgentSessionResult>>(
        `${apiBase}/api/agent/sessions/${encodeURIComponent(sessionId)}/events`,
        { events }
      );
      if (!response.ok || !response.data) {
        throw new Error(response.message ?? response.error ?? 'append agent events failed');
      }
      return response.data;
    },
  });
}

async function currentOrCreateSession(
  apiBase: string,
  scope: { workspaceId?: string; workspaceHash?: string },
  title: string
): Promise<AgentSessionResult> {
  const current = await getJson<ApiResponse<AgentSessionResult | null>>(
    `${apiBase}/api/agent/sessions/current${query(scope)}`
  );
  if (current.ok && current.data) return current.data;
  const created = await postJson<ApiResponse<AgentSessionResult>>(`${apiBase}/api/agent/sessions`, {
    initialMode: 'plan',
    title,
    ...scope,
  });
  if (!created.ok || !created.data) {
    throw new Error(created.message ?? created.error ?? 'create agent session failed');
  }
  return created.data;
}

async function activateSession(apiBase: string, sessionId: string): Promise<AgentSessionResult> {
  const response = await postJson<ApiResponse<AgentSessionResult>>(
    `${apiBase}/api/agent/sessions/${encodeURIComponent(sessionId)}/activate`,
    {}
  );
  if (!response.ok || !response.data) {
    throw new Error(response.message ?? response.error ?? `activate session failed: ${sessionId}`);
  }
  return response.data;
}

async function getAgentSession(apiBase: string, sessionId: string): Promise<AgentSessionResult> {
  const response = await getJson<ApiResponse<AgentSessionResult>>(
    `${apiBase}/api/agent/sessions/${encodeURIComponent(sessionId)}/events`
  );
  if (!response.ok || !response.data) {
    throw new Error(response.message ?? response.error ?? `read session failed: ${sessionId}`);
  }
  return response.data;
}

async function readTimeline(apiBase: string, sessionId: string): Promise<AgentTimelineResult> {
  const response = await getJson<ApiResponse<AgentTimelineResult>>(
    `${apiBase}/api/agent/sessions/${encodeURIComponent(sessionId)}/timeline`
  );
  if (!response.ok || !response.data) {
    throw new Error(response.message ?? response.error ?? `read timeline failed: ${sessionId}`);
  }
  return response.data;
}

async function kernelCommand(apiBase: string, request: KernelCommandEnvelope): Promise<KernelReply> {
  return postJson<KernelReply>(`${apiBase}/api/kernel/commands`, request);
}

async function llmChat(apiBase: string, request: LlmChatRequest): Promise<ApiResponse<LlmChatResult>> {
  return postJson<ApiResponse<LlmChatResult>>(`${apiBase}/api/llm/chat`, request);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return await response.json() as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return await response.json() as T;
}

function workspaceBindingFromPath(path: string | undefined): AgentWorkspaceBinding | undefined {
  const normalized = normalizePath(path);
  if (!normalized) return undefined;
  const hash = simpleWorkspaceHash(normalized);
  return {
    workspaceId: 'terminal',
    workspaceHash: hash,
    openPath: normalized,
    activeFolderId: 'wf-0',
    folderHash: hash,
  };
}

function projectWorkingDirectoryFromPath(path: string | undefined): ProjectWorkingDirectory | undefined {
  const normalized = normalizePath(path);
  if (!normalized) return undefined;
  return {
    rootId: `terminal-root-${simpleWorkspaceHash(normalized)}`,
    label: `Terminal workspace ${normalized}`,
    displayPath: normalized,
    absolutePath: normalized,
    source: 'projectWorkingDirectory',
  };
}

function normalizePath(path: string | undefined): string | undefined {
  const value = path?.trim();
  if (!value) return undefined;
  return value.replace(/\\/g, '/').replace(/\/+$/g, '') || value;
}

function normalizeApiBase(apiBase: string | undefined): string {
  const value = apiBase?.trim()
    || process.env.DEEPCODE_API_URL
    || `http://${process.env.DEEPCODE_HOST ?? '127.0.0.1'}:${process.env.DEEPCODE_PORT ?? '31245'}`;
  return value.replace(/\/+$/g, '');
}

function simpleWorkspaceHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ws-${(hash >>> 0).toString(16)}`;
}

function query(values: Record<string, string | undefined>): string {
  const parts = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? '')}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function extractFinalText(timeline: AgentTimelineResult): string {
  for (const turn of [...timeline.turns].reverse()) {
    for (const block of [...turn.blocks].reverse()) {
      if (block.narrativeKind === 'assistantText' || block.kind === 'assistant') {
        const text = (block.bodyMarkdown || block.summary || '').trim();
        if (text) return text;
      }
    }
  }
  return '';
}

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }
  return raw;
}

function writeJson(result: HostBridgeResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  writeJson({
    ok: false,
    error: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
