import type {
  AgentEvent,
  AgentMode,
  AgentObservation,
  AgentSessionResult,
  AgentWorkflowConfig,
  AgentWorkflowStage,
  LlmChatMessage,
  PermissionRequest,
  ResolveAgentPermissionRequest,
  SendAgentMessageRequest,
  ToolCall,
  ToolResult,
} from '@deepcode/protocol';
import { AGENT_WORKFLOW_STAGES } from '@deepcode/protocol';
import { AgentActionParser, toToolCall } from '@deepcode/agent-core';
import { chatWithLlm } from '../../services/llmService.js';
import { getLlmProfiles } from '../../services/llmProfileService.js';
import { getAgentWorkflowConfig } from '../../services/agentWorkflowConfigService.js';
import {
  appendAgentEvents,
  getAgentSession,
  setAgentSessionAutoTitle,
} from '../../services/agentSessionStore.js';
import { ContextSourceRegistry } from '../context/contextSourceRegistry.js';
import { ContextBudgetPolicy } from '../context/contextBudgetPolicy.js';
import {
  evaluateAgentPermission,
  executeAgentTool,
  listAgentTools,
} from './toolService.js';

interface PendingPermission {
  sessionId: string;
  request: PermissionRequest;
  toolCall: ToolCall;
  mode: AgentMode;
}

type AgentOutputSegmentKind = 'reasoning' | 'say' | 'plan' | 'observe' | 'final';

interface AgentOutputSegment {
  kind: AgentOutputSegmentKind;
  content: string;
}

interface EventContext {
  turnId?: string;
  sequence?: number;
  stage?: AgentWorkflowStage;
  phase?: AgentWorkflowStage;
  stageRunId?: string;
  llmCallId?: string;
  batchId?: string;
  batchLabel?: string;
}

interface ToolBatchContext extends EventContext {
  batchId: string;
  batchLabel: string;
}

const parser = new AgentActionParser();
const contextRegistry = new ContextSourceRegistry();
const contextBudgetPolicy = new ContextBudgetPolicy();
const pendingPermissions = new Map<string, PendingPermission>();

const OUTPUT_ENVELOPE_PROMPT = [
  'Format user-visible Agent output as ordered logical sections when useful:',
  '<reasoning>brief visible reasoning or provider-independent planning notes</reasoning>',
  '<say>short progress message for the user</say>',
  '<plan>task steps or execution strategy</plan>',
  '<observe>judgement based on tool observations</observe>',
  '<final>final answer to the user</final>',
  'Use only the sections that match the current stage. Local operations must still be expressed as provider tool calls or ```deepcode-action JSON blocks. Do not put deepcode-action JSON inside <final>.',
].join('\n');

const STAGE_PROMPTS: Record<AgentWorkflowStage, string> = {
  plan: [
    'You are the planning stage of DeepCode Agent.',
    'Create a concise plan, name relevant files or searches, and do not request local writes or shell execution.',
    'Classify the user request as directExecution or needsUserConfirmation. Clear implementation, fix, test, commit, or save requests are usually directExecution unless the user explicitly asks for a plan only.',
    'If the request is needsUserConfirmation, make the next decision explicit and do not prepare write or shell actions.',
    'Prefer <plan> for the plan and <say> for short progress notes. If the request only needs a direct answer, use <final>.',
  ].join('\n'),
  check: [
    'You are the checking stage of DeepCode Agent.',
    'Review the plan, context, risks, and likely tool usage. Point out unsafe or unclear operations.',
    'Re-check whether the request can proceed directly or must wait for user confirmation. Sensitive, destructive, publishing, or high-risk Git operations must require explicit permission even when the user asked for execution.',
    'Treat local keyword detection only as a hint; the permission gate remains authoritative.',
    'Do not request local writes or shell execution.',
    'Use <observe> for the check result.',
  ].join('\n'),
  complete: [
    'You are the completion stage of DeepCode Agent.',
    'Use deepcode-action JSON blocks or tool calls when local reads, searches, patches, writes, or shell commands are needed.',
    'For directExecution requests, proceed with allowed read/search/diff steps and request permission only when the tool policy requires it.',
    'When the user asks to render or return Markdown, tables, formulas, or diagrams, return the actual Markdown content, not a description of what would be returned.',
    'Before tool actions, use <say> to tell the user what you are about to inspect or run. After observations, use <observe> to explain the result. Use <final> only for the final answer.',
    'Keep human-facing progress readable; raw deepcode-action blocks are for the runtime, not the final user-facing text.',
    'All local operations are subject to the permission gate.',
  ].join('\n'),
  review: [
    'You are the review stage of DeepCode Agent.',
    'Produce the final user-facing answer for the conversation. Keep it direct and avoid internal audit sections unless the user asked for a review.',
    'If the user requested Markdown, tables, formulas, or diagrams, include the actual renderable Markdown in the final answer.',
    'Use <final> for the final answer.',
    'Do not perform new local operations.',
  ].join('\n'),
};

function newEvent(
  sessionId: string,
  kind: AgentEvent['kind'],
  payload: unknown,
  display?: AgentEvent['display']
): AgentEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId,
    ts: new Date().toISOString(),
    kind,
    payload,
    ...(display ? { display } : {}),
  };
}

function withContext(payload: unknown, context: EventContext, extra: Record<string, unknown> = {}): unknown {
  if (isRecord(payload)) {
    return { ...payload, ...context, ...extra };
  }
  return { value: payload, ...context, ...extra };
}

function redactForDisplay(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[REDACTED]');
}

function stripDeepcodeActionBlocks(content: string): string {
  return content
    .replace(/```deepcode-action\s*[\s\S]*?```/g, '')
    .replace(/```json\s*\{\s*"action"\s*:\s*[\s\S]*?```/g, '')
    .trim();
}

function parseTaggedSegments(content: string, fallbackKind: AgentOutputSegmentKind): AgentOutputSegment[] {
  const segments: AgentOutputSegment[] = [];
  const usedRanges: Array<[number, number]> = [];
  const tagPattern = /<(reasoning|think|say|plan|observe|final)>\s*([\s\S]*?)\s*<\/\1>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(content)) !== null) {
    const rawKind = match[1].toLowerCase();
    const kind: AgentOutputSegmentKind = rawKind === 'think' ? 'reasoning' : rawKind as AgentOutputSegmentKind;
    const text = stripDeepcodeActionBlocks(match[2]).trim();
    if (text) segments.push({ kind, content: redactForDisplay(text) });
    usedRanges.push([match.index, match.index + match[0].length]);
  }

  let remainder = content;
  for (const [start, end] of [...usedRanges].reverse()) {
    remainder = `${remainder.slice(0, start)}\n${remainder.slice(end)}`;
  }
  const cleanRemainder = stripDeepcodeActionBlocks(remainder).trim();
  if (cleanRemainder) {
    segments.push({ kind: fallbackKind, content: redactForDisplay(cleanRemainder) });
  }

  return segments;
}

function segmentChannel(kind: AgentOutputSegmentKind): string {
  if (kind === 'reasoning') return 'reasoning';
  if (kind === 'observe') return 'observation';
  if (kind === 'final') return 'final';
  return 'progress';
}

function segmentLabel(kind: AgentOutputSegmentKind): string {
  if (kind === 'reasoning') return '思考中';
  if (kind === 'observe') return '检查结果';
  if (kind === 'final') return '最终回复';
  if (kind === 'plan') return '执行计划';
  return 'Agent';
}

function fallbackSegmentKind(stage: AgentWorkflowStage): AgentOutputSegmentKind {
  if (stage === 'review') return 'final';
  if (stage === 'check') return 'observe';
  if (stage === 'plan') return 'plan';
  return 'say';
}

function assistantSegmentEvent(
  sessionId: string,
  context: EventContext,
  segment: AgentOutputSegment
): AgentEvent {
  const presentation = segment.kind === 'reasoning' ? 'collapsible' : 'body';
  return newEvent(sessionId, 'assistant_msg', withContext({
    content: segment.content,
    label: segmentLabel(segment.kind),
  }, context, {
    channel: segmentChannel(segment.kind),
    visibility: segment.kind === 'reasoning' ? 'trace' : 'conversation',
  }), {
    presentation,
    defaultOpen: false,
    importance: segment.kind === 'final' ? 'primary' : 'secondary',
  });
}

function toolBatchLabel(toolCalls: ToolCall[]): string {
  if (toolCalls.length === 0) return '执行工具';
  const names = toolCalls.map((call) => call.name);
  if (names.every((name) => name === 'fs.read' || name === 'fs.list')) return '读取文件中';
  if (names.every((name) => name === 'code.search')) return '检索代码中';
  if (names.every((name) => name.startsWith('shell.'))) return '执行命令';
  return '执行工具';
}

function observationEvent(sessionId: string, observation: AgentObservation): AgentEvent {
  if (observation.status === 'needsApproval' && observation.output) {
    const request = observation.output as PermissionRequest;
    return newEvent(sessionId, 'permission_request', request);
  }
  if (observation.status === 'error' || observation.status === 'blocked') {
    return newEvent(sessionId, 'tool_result', {
      callId: observation.actionId,
      toolName: observation.toolName,
      ok: false,
      status: observation.status,
      error: observation.error?.message ?? observation.summary,
    });
  }
  return newEvent(sessionId, 'tool_result', {
    callId: observation.actionId,
    toolName: observation.toolName,
    ok: true,
    status: observation.status,
    output: observation.output,
  });
}

async function resolveProfileId(request: SendAgentMessageRequest, session: AgentSessionResult): Promise<string | undefined> {
  if (request.profileId) return request.profileId;
  if (session.session.profileId) return session.session.profileId;
  const profiles = await getLlmProfiles();
  return profiles.defaultProfileId;
}

function hasConfiguredStage(config: AgentWorkflowConfig): boolean {
  return AGENT_WORKFLOW_STAGES.some((stage) => Boolean(config[stage]?.profileId));
}

async function resolveWorkflowConfig(
  request: SendAgentMessageRequest,
  session: AgentSessionResult
): Promise<AgentWorkflowConfig> {
  const stored = request.workflowConfig ?? (await getAgentWorkflowConfig()).config;
  if (hasConfiguredStage(stored)) return stored;

  const legacyProfileId = await resolveProfileId(request, session);
  return {
    plan: {},
    check: {},
    complete: legacyProfileId ? { profileId: legacyProfileId } : {},
    review: {},
  };
}

async function executeOrAsk(
  sessionId: string,
  mode: AgentMode,
  toolCall: ToolCall,
  emit?: (events: AgentEvent[]) => Promise<void>,
  context: ToolBatchContext = {
    batchId: `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    batchLabel: '执行工具',
  }
): Promise<AgentEvent[]> {
  const withToolName = (result: ToolResult): ToolResult & { toolName: string; status: 'ok' | 'error' } => ({
    ...result,
    toolName: toolCall.name,
    status: result.ok ? 'ok' : 'error',
  });
  const events: AgentEvent[] = [newEvent(sessionId, 'tool_call', withContext(toolCall, context, {
    channel: 'tool',
    visibility: 'conversation',
    toolCall,
  }), {
    presentation: 'collapsible',
    defaultOpen: true,
    importance: 'secondary',
  })];
  if (emit) await emit(events);
  const decision = await evaluateAgentPermission({ mode, toolCall });
  if (decision.action === 'deny') {
    const resultEvent = newEvent(sessionId, 'tool_result', withContext({
      callId: toolCall.id,
      toolName: toolCall.name,
      ok: false,
      status: 'blocked',
      error: decision.reason,
    }, context, {
      channel: 'tool',
      visibility: 'conversation',
    }), {
      presentation: 'collapsible',
      defaultOpen: true,
      importance: 'secondary',
    });
    events.push(resultEvent);
    if (emit) await emit([resultEvent]);
    return events;
  }
  if (decision.action === 'ask' && decision.request) {
    pendingPermissions.set(decision.request.id, {
      sessionId,
      request: decision.request,
      toolCall,
      mode,
    });
    const permissionEvent = newEvent(sessionId, 'permission_request', withContext(decision.request, context, {
      channel: 'tool',
      visibility: 'conversation',
    }), {
      presentation: 'collapsible',
      defaultOpen: true,
      importance: 'secondary',
    });
    events.push(permissionEvent);
    if (emit) await emit([permissionEvent]);
    return events;
  }
  const result = await executeAgentTool({ mode, toolCall });
  const resultEvent = newEvent(sessionId, 'tool_result', withContext(withToolName(result), context, {
    channel: 'tool',
    visibility: 'conversation',
  }), {
    presentation: 'collapsible',
    defaultOpen: false,
    importance: 'secondary',
  });
  events.push(resultEvent);
  if (emit) await emit([resultEvent]);
  return events;
}

async function runParsedTextActions(
  sessionId: string,
  mode: AgentMode,
  content: string,
  emit?: (events: AgentEvent[]) => Promise<void>,
  context: EventContext = {}
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const add = async (event: AgentEvent) => {
    events.push(event);
    if (emit) await emit([event]);
  };
  const parse = parser.parse({ content, mode });
  const parsedToolCalls = parse.actions
    .filter((action) => action.status === 'parsed' && action.type !== 'final' && action.type !== 'patch.plan')
    .map((action) => toToolCall(action))
    .filter((toolCall): toolCall is ToolCall => Boolean(toolCall));
  const batchId = parsedToolCalls.length > 0
    ? `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`
    : undefined;
  const batchLabel = toolBatchLabel(parsedToolCalls);
  for (const action of parse.actions) {
    if (action.status !== 'parsed') {
      await add(newEvent(sessionId, 'error', {
        ...context,
        channel: 'error',
        visibility: 'conversation',
        message: action.errors?.[0]?.message ?? 'Invalid action',
        code: action.errors?.[0]?.code ?? 'invalid_action',
        action,
      }, {
        presentation: 'collapsible',
        defaultOpen: true,
        importance: 'secondary',
      }));
      continue;
    }
    if (action.type === 'final') {
      await add(newEvent(sessionId, 'assistant_msg', withContext(action.payload, context, {
        channel: 'final',
        visibility: 'conversation',
        label: '最终回复',
      }), {
        presentation: 'body',
        defaultOpen: true,
        importance: 'primary',
      }));
      continue;
    }
    if (action.type === 'patch.plan') {
      await add(newEvent(sessionId, 'tool_result', withContext({
        callId: action.id,
        toolName: 'patch.plan',
        ok: false,
        status: 'needsApproval',
        output: action.payload,
        error: 'patch_plan_needs_approval',
      }, {
        ...context,
        batchId: batchId ?? `batch-${action.id}`,
        batchLabel: '规划补丁',
      }, {
        channel: 'tool',
        visibility: 'conversation',
      }), {
        presentation: 'collapsible',
        defaultOpen: true,
        importance: 'secondary',
      }));
      continue;
    }
    const toolCall = toToolCall(action);
    if (!toolCall) continue;
    const toolEvents = await executeOrAsk(sessionId, mode, toolCall, emit, {
      ...context,
      batchId: batchId ?? `batch-${toolCall.id}`,
      batchLabel,
    });
    events.push(...toolEvents);
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function previewValue(value: unknown, limit = 900): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function toolNameFromEvent(event: AgentEvent): string {
  if (!isRecord(event.payload)) return 'tool';
  const toolCall = isRecord(event.payload.toolCall) ? event.payload.toolCall : undefined;
  return previewValue(event.payload.toolName ?? event.payload.name ?? toolCall?.name ?? 'tool', 120);
}

function toolObservationSummary(event: AgentEvent): string | null {
  if (!isRecord(event.payload)) return null;
  if (event.kind === 'tool_call') {
    const toolCall = isRecord(event.payload.toolCall) ? event.payload.toolCall : event.payload;
    const args = isRecord(toolCall.arguments) ? toolCall.arguments : {};
    return `- Tool requested: ${toolNameFromEvent(event)} ${previewValue(args, 420)}`;
  }
  if (event.kind === 'tool_result') {
    const status = typeof event.payload.ok === 'boolean'
      ? (event.payload.ok ? 'ok' : 'error')
      : previewValue(event.payload.status ?? 'done', 80);
    const output = event.payload.output ?? event.payload.error ?? event.payload.summary ?? event.payload.message;
    return `- Tool result: ${toolNameFromEvent(event)} status=${status} ${previewValue(output, 720)}`;
  }
  if (event.kind === 'permission_request') {
    return `- Permission requested: ${toolNameFromEvent(event)} ${previewValue(event.payload.summary ?? event.payload, 520)}`;
  }
  if (event.kind === 'permission_result') {
    return `- Permission result: ${previewValue(event.payload, 420)}`;
  }
  if (event.kind === 'error') {
    return `- Runtime error: ${previewValue(event.payload, 520)}`;
  }
  return null;
}

function appendObservationContext(stageOutputs: string[], stage: AgentWorkflowStage, events: AgentEvent[]): void {
  const summaries = events
    .map(toolObservationSummary)
    .filter((summary): summary is string => Boolean(summary));
  if (summaries.length === 0) return;
  stageOutputs.push(`[${stage} observations]\n${summaries.join('\n')}`);
}

function extractLlmText(result: Awaited<ReturnType<typeof chatWithLlm>>): string {
  const assistantContent = result.assistantMessage?.content?.trim();
  if (assistantContent) return assistantContent;
  return result.chunks
    .filter((chunk) => chunk.type === 'delta' && chunk.content)
    .map((chunk) => chunk.content)
    .join('')
    .trim();
}

function parseSessionTitleJson(raw: string): { title?: string; summary?: string } {
  const trimmed = raw.trim();
  const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as { title?: unknown; summary?: unknown };
    return {
      title: typeof parsed.title === 'string' ? parsed.title.trim() : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined,
    };
  } catch {
    return { title: trimmed.split(/\r?\n/)[0]?.trim() };
  }
}

function fallbackSessionTitle(content: string): string {
  return content.trim().replace(/\s+/g, ' ').slice(0, 48) || 'Agent Session';
}

async function maybeAutoTitleSession(
  latest: AgentSessionResult,
  profileId: string | undefined,
  userContent: string,
  finalContent: string
): Promise<AgentSessionResult> {
  if (!profileId) return latest;
  if (latest.session.titleSource === 'user' || latest.session.titleSource === 'auto') return latest;
  const source = [
    `User request:\n${userContent}`,
    `Assistant final answer:\n${finalContent}`,
  ].join('\n\n').slice(0, 6000);

  try {
    const result = await chatWithLlm({
      profileId,
      stream: false,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Generate a concise DeepCode Agent session title and summary.',
            'Return only valid JSON exactly like {"title":"...","summary":"..."}.',
            'The title should be 4-12 Chinese characters or a short technical phrase.',
            'Do not include markdown, quotes outside JSON, or private details.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Summarize this conversation as JSON:\n\n${source}`,
        },
      ],
    });
    const parsed = parseSessionTitleJson(extractLlmText(result));
    return setAgentSessionAutoTitle(
      latest.session.id,
      parsed.title || fallbackSessionTitle(userContent),
      parsed.summary || finalContent
    );
  } catch {
    return setAgentSessionAutoTitle(
      latest.session.id,
      fallbackSessionTitle(userContent),
      finalContent
    );
  }
}

export async function sendAgentMessage(
  sessionId: string,
  request: SendAgentMessageRequest
): Promise<AgentSessionResult> {
  const current = await getAgentSession(sessionId);
  if (!current) {
    throw new Error(`Agent session not found: ${sessionId}`);
  }
  const mode = request.mode ?? current.session.mode;
  let latest: AgentSessionResult = current;
  let sequence = 0;
  let turnId = '';
  const emit = async (nextEvents: AgentEvent[]) => {
    if (nextEvents.length === 0) return;
    const decorated = nextEvents.map((event) => ({
      ...event,
      payload: withContext(event.payload, {
        turnId,
        sequence: sequence += 1,
      }),
    }));
    latest = await appendAgentEvents(sessionId, decorated);
  };

  const userEvent = newEvent(sessionId, 'user_msg', {
    content: request.content,
    attachments: request.attachments ?? [],
    channel: 'user',
    visibility: 'conversation',
  });
  turnId = userEvent.id;
  await emit([userEvent]);

  const workflowConfig = await resolveWorkflowConfig(request, current);
  if (!hasConfiguredStage(workflowConfig)) {
    await emit([newEvent(sessionId, 'assistant_msg', {
      content: 'Please configure a valid LLM provider profile and assign it to at least one Agent workflow stage.',
      channel: 'final',
      visibility: 'conversation',
      label: 'Agent',
    })]);
    return latest;
  }

  const promptText = await contextRegistry.buildPromptText(request.attachments ?? []);
  const profileCatalog = await getLlmProfiles();
  const profilesById = new Map(profileCatalog.profiles.map((profile) => [profile.id, profile]));
  const stageOutputs: string[] = [];
  const workflow = request.workflow ?? 'planFirst';
  let emittedFinal = false;
  let lastUserVisibleText = '';
  let lastUsedProfileId: string | undefined;

  for (const stage of AGENT_WORKFLOW_STAGES) {
    const profileId = workflowConfig[stage]?.profileId;
    if (!profileId) continue;
    lastUsedProfileId = profileId;
    const profile = profilesById.get(profileId);
    const stageRunId = `stage-${stage}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const llmCallId = `llm-${stage}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const baseContext: EventContext = {
      turnId,
      stage,
      phase: stage,
      stageRunId,
      llmCallId,
    };

    const priorOutput = stageOutputs.length > 0
      ? `\n\nPrevious workflow stage output:\n${stageOutputs.join('\n\n')}`
      : '';
    const contextBudget = contextBudgetPolicy.evaluate(
      [promptText, request.content, priorOutput].join('\n\n'),
      profile
    );

    await emit([newEvent(sessionId, 'workflow_stage', {
      stage,
      phase: stage,
      stageRunId,
      llmCallId,
      profileId,
      status: 'started',
      contextBudget,
      channel: 'task',
      visibility: 'task',
    })]);

    const messages: LlmChatMessage[] = [
      {
        role: 'system',
        content: [
          promptText,
          OUTPUT_ENVELOPE_PROMPT,
          STAGE_PROMPTS[stage],
          `Current permission mode: ${mode}.`,
          `Default workflow behavior: ${workflow}.`,
          'Natural language alone must never trigger local operations; only explicit tool calls or deepcode-action blocks may do so.',
        ].join('\n\n'),
      },
      {
        role: 'user',
        content: `${request.content}${priorOutput}`,
      },
    ];

    let assistantText = '';
    let reasoningText = '';
    const stageToolCalls: ToolCall[] = [];
    try {
      const response = await chatWithLlm({
        profileId,
        messages,
        tools: stage === 'complete' ? listAgentTools(mode).tools : undefined,
        stream: false,
      });

      for (const chunk of response.chunks) {
        if (chunk.type === 'reasoning_delta' && chunk.content) {
          reasoningText += chunk.content;
        }
        if (chunk.type === 'delta' && chunk.content) {
          assistantText += chunk.content;
        }
        if (stage === 'complete' && chunk.type === 'tool_call' && chunk.toolCall) {
          stageToolCalls.push(chunk.toolCall);
        }
        if (chunk.type === 'error') {
          await emit([newEvent(sessionId, 'error', {
            stage,
            phase: stage,
            stageRunId,
            llmCallId,
            channel: 'error',
            visibility: 'conversation',
            code: 'llm_stream_error',
            message: chunk.error ?? 'LLM stream error',
          })]);
        }
      }

      const trimmed = assistantText.trim();
      const observationEvents: AgentEvent[] = [];
      if (reasoningText.trim()) {
        await emit([assistantSegmentEvent(sessionId, baseContext, {
          kind: 'reasoning',
          content: reasoningText.trim(),
        })]);
      }
      if (trimmed) {
        stageOutputs.push(`[${stage}] ${trimmed}`);
        const segments = parseTaggedSegments(trimmed, fallbackSegmentKind(stage));
        for (const segment of segments) {
          await emit([assistantSegmentEvent(sessionId, baseContext, segment)]);
          if (segment.kind === 'final') emittedFinal = true;
          if (segment.kind !== 'reasoning') lastUserVisibleText = segment.content;
        }
      } else if (stage === 'complete' && stageToolCalls.length > 0) {
        await emit([assistantSegmentEvent(sessionId, baseContext, {
          kind: 'say',
          content: '\u6211\u4f1a\u5148\u6309\u5f53\u524d\u4efb\u52a1\u8c03\u7528\u5de5\u5177\u83b7\u53d6\u4e8b\u5b9e\uff0c\u518d\u6839\u636e\u7ed3\u679c\u7ee7\u7eed\u5224\u65ad\u3002',
        })]);
      }

      if (stage === 'complete') {
        const batchId = stageToolCalls.length > 0
          ? `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`
          : undefined;
        const batchLabel = toolBatchLabel(stageToolCalls);
        for (const toolCall of stageToolCalls) {
          const toolEvents = await executeOrAsk(sessionId, mode, toolCall, emit, {
            ...baseContext,
            batchId: batchId ?? `batch-${toolCall.id}`,
            batchLabel,
          });
          observationEvents.push(...toolEvents);
        }
      }

      if (trimmed) {
        if (stage === 'complete') {
          const parsedEvents = await runParsedTextActions(sessionId, mode, trimmed, emit, baseContext);
          observationEvents.push(...parsedEvents);
        }
      }

      appendObservationContext(stageOutputs, stage, observationEvents);
      if (observationEvents.length > 0) {
        const summaries = observationEvents
          .map(toolObservationSummary)
          .filter((summary): summary is string => Boolean(summary))
          .slice(0, 8);
        const observationSummary = '\u5df2\u7ecf\u83b7\u53d6\u5de5\u5177\u7ed3\u679c\uff0c\u7ee7\u7eed\u6839\u636e\u7ed3\u679c\u5224\u65ad\u3002';
        await emit([assistantSegmentEvent(sessionId, baseContext, {
          kind: 'observe',
          content: summaries.length > 0
            ? `${observationSummary}\n\n${summaries.join('\n')}`
            : observationSummary,
        })]);
        lastUserVisibleText = observationSummary;
      }

      await emit([newEvent(sessionId, 'workflow_stage', {
        stage,
        phase: stage,
        stageRunId,
        llmCallId,
        profileId,
        status: 'completed',
        summary: trimmed ? trimmed.slice(0, 240) : 'No textual output.',
        channel: 'task',
        visibility: 'task',
      })]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emit([newEvent(sessionId, 'workflow_stage', {
        stage,
        phase: stage,
        stageRunId,
        llmCallId,
        profileId,
        status: 'error',
        summary: message,
        channel: 'task',
        visibility: 'task',
      })]);
      await emit([newEvent(sessionId, 'error', {
        ...baseContext,
        channel: 'error',
        visibility: 'conversation',
        code: 'llm_stage_error',
        message,
      })]);
    }
  }

  if (!emittedFinal && lastUserVisibleText.trim()) {
    await emit([assistantSegmentEvent(sessionId, {
      turnId,
      stage: 'review',
      phase: 'review',
      stageRunId: `stage-final-${Date.now()}`,
      llmCallId: `llm-final-${Date.now()}`,
    }, {
      kind: 'final',
      content: lastUserVisibleText.trim(),
    })]);
  }

  if (lastUserVisibleText.trim()) {
    latest = await maybeAutoTitleSession(
      latest,
      lastUsedProfileId,
      request.content,
      lastUserVisibleText.trim()
    );
  }

  return latest;
}

export async function resolveAgentPermission(
  permissionId: string,
  request: ResolveAgentPermissionRequest
): Promise<AgentSessionResult> {
  const pending = pendingPermissions.get(permissionId);
  if (!pending) {
    throw new Error(`Agent permission not found: ${permissionId}`);
  }
  pendingPermissions.delete(permissionId);

  const events: AgentEvent[] = [
    newEvent(pending.sessionId, 'permission_result', {
      permissionId,
      decision: request.decision,
      toolName: pending.toolCall.name,
      status: request.decision === 'accept' ? 'accepted' : 'rejected',
    }),
  ];

  if (request.decision === 'accept') {
    const result: ToolResult = await executeAgentTool({
      mode: pending.mode,
      toolCall: pending.toolCall,
      approved: true,
    });
    events.push(newEvent(pending.sessionId, 'tool_result', {
      ...result,
      toolName: pending.toolCall.name,
    }));
  } else {
    events.push(newEvent(pending.sessionId, 'tool_result', {
      callId: pending.toolCall.id,
      toolName: pending.toolCall.name,
      ok: false,
      status: 'error',
      error: 'permission_rejected',
    }));
  }

  return appendAgentEvents(pending.sessionId, events);
}
