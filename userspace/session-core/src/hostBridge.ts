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
  LlmChatStreamEvent,
  ProjectionDelta,
  ToolCall,
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
  stdout: { write(value: string, callback?: () => void): boolean };
  stderr: { write(value: string): void };
  exit(code?: number): never;
};

interface HostBridgeRequest {
  op: 'ask' | 'resolveDecision';
  apiBase?: string;
  sessionId?: string;
  hostRunId?: string;
  prompt?: string;
  attachments?: AgentContextAttachment[];
  workspacePath?: string;
  noWorkspace?: boolean;
  profileId?: string;
  workflow?: 'planFirst' | 'actOnRequest';
  requirementConfirmationMode?: 'off' | 'auto' | 'always';
  reviewContinuationMode?: 'auto' | 'ask' | 'off';
  interventionLevel?: 'low' | 'medium' | 'high';
  subAgentMode?: 'auto' | 'off';
  subAgentMaxParallel?: number;
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
  runStatus?: 'waiting' | 'completed' | 'failed' | string;
  decisionKind?: string;
  targetId?: string;
  terminalReason?: string;
  message?: string;
  error?: string;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const request = JSON.parse(raw || '{}') as HostBridgeRequest;
  const result = request.op === 'resolveDecision'
    ? await resolveDecision(request)
    : await runAsk(request);
  await writeJson(result);
  process.exit(0);
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
  const driver = createDriver(apiBase, request.hostRunId);
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
    interventionLevel: request.interventionLevel,
    subAgentMode: request.subAgentMode,
    subAgentMaxParallel: request.subAgentMaxParallel,
  });
  const timeline = await readTimeline(apiBase, result.session.id);
  const finalText = extractFinalText(timeline);
  const lifecycle = inferHostRunLifecycle(result.events, finalText);
  return {
    ok: true,
    sessionId: result.session.id,
    session: result.session,
    events: result.events,
    timeline,
    finalText,
    ...lifecycle,
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
  const driver = createDriver(apiBase, request.hostRunId);
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
    interventionLevel: request.interventionLevel,
    subAgentMode: request.subAgentMode,
    subAgentMaxParallel: request.subAgentMaxParallel,
  });
  const timeline = await readTimeline(apiBase, result.session.id);
  const finalText = extractFinalText(timeline);
  const lifecycle = inferHostRunLifecycle(result.events, finalText);
  return {
    ok: true,
    sessionId: result.session.id,
    session: result.session,
    events: result.events,
    timeline,
    finalText,
    ...lifecycle,
  };
}

function createDriver(apiBase: string, hostRunId?: string): SessionDriverLoop {
  const transcriptClient = new SessionStorageClient(apiBase);
  return new SessionDriverLoop({
    kernelCommand: (request) => kernelCommand(apiBase, request),
    llmChat: (request) => llmChat(apiBase, request),
    llmChatStream: (request, onEvent) => llmChatStream(apiBase, request, onEvent),
    onProjectionDelta: hostRunId
      ? (delta) => postProjectionDelta(apiBase, hostRunId, delta)
      : undefined,
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

async function llmChatStream(
  apiBase: string,
  request: LlmChatRequest,
  onEvent: (event: LlmChatStreamEvent) => void | Promise<void>
): Promise<ApiResponse<LlmChatResult>> {
  try {
    const response = await fetch(`${apiBase}/api/llm/chat/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...request, stream: true }),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    if (!response.body) {
      return {
        ok: false,
        error: 'stream_unavailable',
        message: 'LLM stream response body is unavailable.',
      };
    }

    const chunks: LlmChatResult['chunks'] = [];
    let usage: Record<string, unknown> | undefined;
    let errorMessage: string | undefined;
    const parser = new SseClientParser();
    const decoder = new TextDecoder();
    const consume = async (event: LlmChatStreamEvent) => {
      if (event.chunk) chunks.push(event.chunk);
      if (event.usage) usage = event.usage;
      if (event.chunk?.usage) usage = event.chunk.usage;
      if (event.type === 'provider_error') {
        errorMessage = event.error ?? event.chunk?.error ?? 'Provider stream error.';
      }
      await onEvent(event);
    };

    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const event of parser.push(text)) {
        await consume(event);
      }
    }
    const tail = decoder.decode();
    for (const event of parser.push(tail)) {
      await consume(event);
    }
    for (const event of parser.finish()) {
      await consume(event);
    }

    if (errorMessage) {
      return {
        ok: false,
        error: 'provider_stream_error',
        message: errorMessage,
      };
    }
    return {
      ok: true,
      data: buildStreamResult(chunks, usage),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postProjectionDelta(apiBase: string, hostRunId: string, delta: ProjectionDelta): Promise<void> {
  await postJson<ApiResponse<unknown>>(
    `${apiBase}/api/agent/sessions/${encodeURIComponent(delta.sessionId)}/runs/${encodeURIComponent(hostRunId)}/deltas`,
    delta
  );
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

class SseClientParser {
  private buffer = '';

  push(text: string): LlmChatStreamEvent[] {
    if (!text) return [];
    this.buffer += text;
    const events: LlmChatStreamEvent[] = [];
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) break;
      const raw = this.buffer.slice(0, boundary);
      const separator = this.buffer.slice(boundary).match(/^\r?\n\r?\n/);
      this.buffer = this.buffer.slice(boundary + (separator?.[0].length ?? 2));
      const event = parseSseClientEvent(raw);
      if (event) events.push(event);
    }
    return events;
  }

  finish(): LlmChatStreamEvent[] {
    const text = this.buffer.trim();
    this.buffer = '';
    const event = parseSseClientEvent(text);
    return event ? [event] : [];
  }
}

function parseSseClientEvent(raw: string): LlmChatStreamEvent | null {
  if (!raw.trim()) return null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    if (field === 'data') data.push(value);
  }
  const payload = data.join('\n').trim();
  if (!payload || payload === '[DONE]') {
    return { type: 'provider_done', chunk: { type: 'done' } };
  }
  try {
    return JSON.parse(payload) as LlmChatStreamEvent;
  } catch (error) {
    return {
      type: 'provider_error',
      error: `Invalid LLM stream event JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function buildStreamResult(
  chunks: LlmChatResult['chunks'],
  usage: Record<string, unknown> | undefined
): LlmChatResult {
  const content = chunks
    .filter((chunk) => chunk.type === 'delta' && typeof chunk.content === 'string')
    .map((chunk) => chunk.content)
    .join('');
  const reasoningContent = chunks
    .filter((chunk) => chunk.type === 'reasoning_delta' && typeof chunk.content === 'string')
    .map((chunk) => chunk.content)
    .join('');
  const toolCalls = collectStreamToolCalls(chunks);
  return {
    chunks,
    usage,
    assistantMessage: {
      role: 'assistant',
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    },
  };
}

function collectStreamToolCalls(chunks: LlmChatResult['chunks']): ToolCall[] {
  const byIndex = new Map<number, { id?: string; name?: string; argumentsText: string }>();
  const ready: ToolCall[] = [];
  for (const chunk of chunks) {
    if (chunk.type === 'tool_call' && chunk.toolCall) {
      ready.push(chunk.toolCall);
      continue;
    }
    if (chunk.type !== 'tool_call' || !chunk.toolCallDelta) continue;
    const index = chunk.toolCallDelta.index ?? chunk.index ?? 0;
    const current = byIndex.get(index) ?? { argumentsText: '' };
    current.id = chunk.toolCallDelta.id ?? chunk.callId ?? current.id;
    current.name = chunk.toolCallDelta.name ?? current.name;
    current.argumentsText += chunk.toolCallDelta.argumentsDelta ?? '';
    byIndex.set(index, current);
  }
  for (const [index, item] of byIndex.entries()) {
    if (!item.name) continue;
    ready.push({
      id: item.id ?? `tool-call-${index + 1}`,
      name: item.name,
      arguments: parseToolArguments(item.argumentsText),
    });
  }
  return ready;
}

function parseToolArguments(raw: string): unknown {
  const text = raw.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw };
  }
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

function inferHostRunLifecycle(
  events: unknown[],
  finalText: string
): Pick<HostBridgeResult, 'runStatus' | 'decisionKind' | 'targetId' | 'terminalReason'> {
  const consumedOwners = collectConsumedInteractionOwners(events);
  for (const event of [...events].reverse()) {
    const record = objectRecord(event);
    const kind = stringField(record, 'kind');
    const payload = objectRecord(record?.payload);
    if (!kind || !payload) continue;

    if (kind === 'error') {
      return {
        runStatus: 'failed',
        terminalReason: stringField(payload, 'message') ?? stringField(payload, 'summary') ?? 'session run failed',
      };
    }

    if (kind === 'session_run_state') {
      const status = stringField(payload, 'status');
      if (status === 'completed') {
        return {
          runStatus: 'completed',
          terminalReason: stringField(payload, 'summary') ?? 'Session run is completed.',
        };
      }
      if (status === 'cancelled') {
        return {
          runStatus: 'cancelled',
          terminalReason: stringField(payload, 'summary') ?? 'Session run is cancelled.',
        };
      }
      if (status === 'running') {
        return {
          runStatus: 'failed',
          terminalReason: stringField(payload, 'summary') ??
            `Session bridge returned before ${stringField(payload, 'reason') ?? 'running'} reached a terminal checkpoint.`,
        };
      }
      if (status === 'waiting') {
        const owner = objectRecord(payload.decisionOwner);
        if (waitingOwnerWasConsumed('session_run_state', payload, consumedOwners)) {
          continue;
        }
        return {
          runStatus: 'waiting',
          decisionKind: stringField(payload, 'decisionKind') ?? stringField(owner, 'kind'),
          targetId: stringField(payload, 'targetId') ?? stringField(owner, 'targetId'),
          terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for user input.',
        };
      }
    }

    if (kind === 'permission_request') {
      return {
        runStatus: 'waiting',
        decisionKind: 'permission',
        targetId: stringField(payload, 'id') ?? stringField(payload, 'permissionId'),
        terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for a permission decision.',
      };
    }

    if (kind === 'review_summary' && stringField(payload, 'status') === 'waitingUserReview') {
      return {
        runStatus: 'waiting',
        decisionKind: 'review',
        targetId: stringField(payload, 'reviewId') ?? stringField(payload, 'runId'),
        terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for user review.',
      };
    }

    if (kind === 'requirement_confirmation' && stringField(payload, 'status') === 'waitingUserConfirmation') {
      if (waitingOwnerWasConsumed(kind, payload, consumedOwners)) {
        continue;
      }
      return {
        runStatus: 'waiting',
        decisionKind: 'requirement',
        targetId: stringField(payload, 'requirementId'),
        terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for requirement confirmation.',
      };
    }

    if (kind === 'plan_card' && planCardAwaitingDecision(payload)) {
      if (waitingOwnerWasConsumed(kind, payload, consumedOwners)) {
        continue;
      }
      return {
        runStatus: 'waiting',
        decisionKind: 'plan',
        targetId: stringField(payload, 'planId'),
        terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for plan review.',
      };
    }
  }

  return {
    runStatus: finalText ? 'completed' : 'completed',
    terminalReason: finalText ? 'final_answer' : 'session_run_returned',
  };
}

interface ConsumedInteractionOwners {
  readonly plans: Set<string>;
  readonly requirements: Set<string>;
  readonly reviews: Set<string>;
  readonly permissions: Set<string>;
}

function collectConsumedInteractionOwners(events: unknown[]): ConsumedInteractionOwners {
  const consumed: ConsumedInteractionOwners = {
    plans: new Set<string>(),
    requirements: new Set<string>(),
    reviews: new Set<string>(),
    permissions: new Set<string>(),
  };
  for (const event of events) {
    const record = objectRecord(event);
    const kind = stringField(record, 'kind');
    const payload = objectRecord(record?.payload);
    if (!kind || !payload) continue;

    if (kind === 'requirement_decision') {
      addStrings(consumed.requirements,
        stringField(payload, 'requirementId'),
        stringField(payload, 'interactionId'),
        stringField(payload, 'sourceInteractionId'),
        stringField(payload, 'targetId'));
      continue;
    }

    if (kind === 'plan_review') {
      const status = stringField(payload, 'status')?.toLowerCase();
      if (status === 'accepted' || status === 'rejected' || status === 'needsrevision') {
        addStrings(consumed.plans,
          stringField(payload, 'planId'),
          stringField(payload, 'interactionId'),
          stringField(payload, 'sourceInteractionId'),
          stringField(payload, 'targetId'));
      }
      continue;
    }

    if (kind === 'review_summary') {
      const status = stringField(payload, 'status')?.toLowerCase();
      if (status && status !== 'waitinguserreview' && status !== 'pending') {
        addStrings(consumed.reviews,
          stringField(payload, 'reviewId'),
          stringField(payload, 'interactionId'),
          stringField(payload, 'sourceInteractionId'),
          stringField(payload, 'targetId'));
      }
      continue;
    }

    if (kind === 'permission_decision') {
      addStrings(consumed.permissions,
        stringField(payload, 'permissionId'),
        stringField(payload, 'interactionId'),
        stringField(payload, 'sourceInteractionId'),
        stringField(payload, 'targetId'));
      continue;
    }

    if (kind === 'session_run_state') {
      const status = stringField(payload, 'status');
      const reason = stringField(payload, 'reason');
      if (status === 'running' && reason === 'accepted_plan_execution') {
        const owner = objectRecord(payload.decisionOwner);
        addStrings(consumed.plans,
          stringField(payload, 'planId'),
          stringField(payload, 'targetId'),
          stringField(owner, 'targetId'),
          stringField(owner, 'planId'));
      }
    }
  }
  return consumed;
}

function waitingOwnerWasConsumed(
  kind: string,
  payload: Record<string, unknown>,
  consumed: ConsumedInteractionOwners
): boolean {
  if (kind === 'plan_card') {
    return hasAny(consumed.plans,
      stringField(payload, 'planId'),
      stringField(payload, 'targetId'),
      stringField(payload, 'interactionId'),
      stringField(payload, 'sourceInteractionId'));
  }
  if (kind === 'requirement_confirmation') {
    return hasAny(consumed.requirements,
      stringField(payload, 'requirementId'),
      stringField(payload, 'targetId'),
      stringField(payload, 'interactionId'),
      stringField(payload, 'sourceInteractionId'));
  }
  if (kind === 'session_run_state') {
    const owner = objectRecord(payload.decisionOwner);
    const decisionKind = stringField(payload, 'decisionKind') ?? stringField(owner, 'kind');
    const targetId = stringField(payload, 'targetId') ?? stringField(owner, 'targetId');
    if (decisionKind === 'plan') {
      return hasAny(consumed.plans, targetId, stringField(payload, 'planId'), stringField(owner, 'planId'));
    }
    if (decisionKind === 'requirement') {
      return hasAny(consumed.requirements, targetId, stringField(payload, 'requirementId'), stringField(owner, 'requirementId'));
    }
    if (decisionKind === 'review') {
      return hasAny(consumed.reviews, targetId, stringField(payload, 'reviewId'), stringField(owner, 'reviewId'));
    }
    if (decisionKind === 'permission') {
      return hasAny(consumed.permissions, targetId, stringField(payload, 'permissionId'), stringField(owner, 'permissionId'));
    }
  }
  return false;
}

function addStrings(target: Set<string>, ...values: Array<string | undefined>): void {
  for (const value of values) {
    if (value) target.add(value);
  }
}

function hasAny(target: Set<string>, ...values: Array<string | undefined>): boolean {
  return values.some((value) => Boolean(value && target.has(value)));
}

function planCardAwaitingDecision(payload: Record<string, unknown>): boolean {
  if (payload.confirmable === false) return false;
  const status = stringField(payload, 'status');
  if (!status) return true;
  return status === 'awaitingUserApproval' ||
    status === 'awaitingTemporaryGrant' ||
    status === 'pending';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }
  return raw;
}

function writeJson(result: HostBridgeResult): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, resolve);
  });
}

main().catch((error: unknown) => {
  void writeJson({
    ok: false,
    error: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  }).finally(() => {
    process.exit(1);
  });
});
