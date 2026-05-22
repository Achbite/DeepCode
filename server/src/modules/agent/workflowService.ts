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
} from '../../services/agentSessionStore.js';
import { ContextSourceRegistry } from '../context/contextSourceRegistry.js';
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

const parser = new AgentActionParser();
const contextRegistry = new ContextSourceRegistry();
const pendingPermissions = new Map<string, PendingPermission>();

const STAGE_PROMPTS: Record<AgentWorkflowStage, string> = {
  plan: [
    'You are the planning stage of DeepCode Agent.',
    'Create a concise plan, name relevant files or searches, and do not request local writes or shell execution.',
    'Classify the user request as directExecution or needsUserConfirmation. Clear implementation, fix, test, commit, or save requests are usually directExecution unless the user explicitly asks for a plan only.',
    'If the request is needsUserConfirmation, make the next decision explicit and do not prepare write or shell actions.',
    'Use normal prose unless a final response is sufficient.',
  ].join('\n'),
  check: [
    'You are the checking stage of DeepCode Agent.',
    'Review the plan, context, risks, and likely tool usage. Point out unsafe or unclear operations.',
    'Re-check whether the request can proceed directly or must wait for user confirmation. Sensitive, destructive, publishing, or high-risk Git operations must require explicit permission even when the user asked for execution.',
    'Treat local keyword detection only as a hint; the permission gate remains authoritative.',
    'Do not request local writes or shell execution.',
  ].join('\n'),
  complete: [
    'You are the completion stage of DeepCode Agent.',
    'Use deepcode-action JSON blocks or tool calls when local reads, searches, patches, writes, or shell commands are needed.',
    'For directExecution requests, proceed with allowed read/search/diff steps and request permission only when the tool policy requires it.',
    'Keep human-facing progress readable; raw deepcode-action blocks are for the runtime, not the final user-facing text.',
    'All local operations are subject to the permission gate.',
  ].join('\n'),
  review: [
    'You are the review stage of DeepCode Agent.',
    'Summarize what happened, observations, remaining risks, and next steps. Do not perform new local operations.',
  ].join('\n'),
};

function newEvent(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId,
    ts: new Date().toISOString(),
    kind,
    payload,
  };
}

function observationEvent(sessionId: string, observation: AgentObservation): AgentEvent {
  if (observation.status === 'needsApproval' && observation.output) {
    const request = observation.output as PermissionRequest;
    return newEvent(sessionId, 'permission_request', request);
  }
  if (observation.status === 'error' || observation.status === 'blocked') {
    return newEvent(sessionId, 'tool_result', {
      callId: observation.actionId,
      ok: false,
      error: observation.error?.message ?? observation.summary,
    });
  }
  return newEvent(sessionId, 'tool_result', {
    callId: observation.actionId,
    ok: true,
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
  toolCall: ToolCall
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [newEvent(sessionId, 'tool_call', toolCall)];
  const decision = await evaluateAgentPermission({ mode, toolCall });
  if (decision.action === 'deny') {
    events.push(newEvent(sessionId, 'tool_result', {
      callId: toolCall.id,
      ok: false,
      error: decision.reason,
    }));
    return events;
  }
  if (decision.action === 'ask' && decision.request) {
    pendingPermissions.set(decision.request.id, {
      sessionId,
      request: decision.request,
      toolCall,
      mode,
    });
    events.push(newEvent(sessionId, 'permission_request', decision.request));
    return events;
  }
  const result = await executeAgentTool({ mode, toolCall });
  events.push(newEvent(sessionId, 'tool_result', result));
  return events;
}

async function runParsedTextActions(
  sessionId: string,
  mode: AgentMode,
  content: string
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const parse = parser.parse({ content, mode });
  for (const action of parse.actions) {
    if (action.status !== 'parsed') {
      events.push(newEvent(sessionId, 'error', {
        message: action.errors?.[0]?.message ?? 'Invalid action',
        action,
      }));
      continue;
    }
    if (action.type === 'final') {
      events.push(newEvent(sessionId, 'assistant_msg', action.payload));
      continue;
    }
    if (action.type === 'patch.plan') {
      events.push(newEvent(sessionId, 'tool_result', {
        callId: action.id,
        ok: false,
        status: 'needsApproval',
        output: action.payload,
        error: 'patch_plan_needs_approval',
      }));
      continue;
    }
    const toolCall = toToolCall(action);
    if (!toolCall) continue;
    events.push(...(await executeOrAsk(sessionId, mode, toolCall)));
  }
  return events;
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
  const events: AgentEvent[] = [
    newEvent(sessionId, 'user_msg', {
      content: request.content,
      attachments: request.attachments ?? [],
    }),
  ];

  const workflowConfig = await resolveWorkflowConfig(request, current);
  if (!hasConfiguredStage(workflowConfig)) {
    events.push(newEvent(sessionId, 'assistant_msg', {
      content: 'Please configure a valid LLM provider profile and assign it to at least one Agent workflow stage.',
    }));
    return appendAgentEvents(sessionId, events);
  }

  const promptText = await contextRegistry.buildPromptText(request.attachments ?? []);
  const stageOutputs: string[] = [];
  const workflow = request.workflow ?? 'planFirst';

  for (const stage of AGENT_WORKFLOW_STAGES) {
    const profileId = workflowConfig[stage]?.profileId;
    if (!profileId) continue;

    events.push(newEvent(sessionId, 'workflow_stage', {
      stage,
      profileId,
      status: 'started',
    }));

    const priorOutput = stageOutputs.length > 0
      ? `\n\nPrevious workflow stage output:\n${stageOutputs.join('\n\n')}`
      : '';
    const messages: LlmChatMessage[] = [
      {
        role: 'system',
        content: [
          promptText,
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
    try {
      const response = await chatWithLlm({
        profileId,
        messages,
        tools: stage === 'complete' ? listAgentTools(mode).tools : undefined,
        stream: false,
      });

      for (const chunk of response.chunks) {
        if (chunk.type === 'delta' && chunk.content) {
          assistantText += chunk.content;
        }
        if (stage === 'complete' && chunk.type === 'tool_call' && chunk.toolCall) {
          events.push(...(await executeOrAsk(sessionId, mode, chunk.toolCall)));
        }
        if (chunk.type === 'error') {
          events.push(newEvent(sessionId, 'error', {
            stage,
            message: chunk.error ?? 'LLM stream error',
          }));
        }
      }

      const trimmed = assistantText.trim();
      if (trimmed) {
        stageOutputs.push(`[${stage}] ${trimmed}`);
        if (stage !== 'review') {
          events.push(newEvent(sessionId, 'assistant_msg', { stage, content: trimmed }));
        }
        if (stage === 'complete') {
          events.push(...(await runParsedTextActions(sessionId, mode, trimmed)));
        }
      }

      events.push(newEvent(sessionId, 'workflow_stage', {
        stage,
        profileId,
        status: 'completed',
        summary: trimmed ? trimmed.slice(0, 240) : 'No textual output.',
        details: stage === 'review' && trimmed ? trimmed : undefined,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      events.push(newEvent(sessionId, 'workflow_stage', {
        stage,
        profileId,
        status: 'error',
        summary: message,
      }));
      events.push(newEvent(sessionId, 'error', { stage, message }));
    }
  }

  return appendAgentEvents(sessionId, events);
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
    }),
  ];

  if (request.decision === 'accept') {
    const result: ToolResult = await executeAgentTool({
      mode: pending.mode,
      toolCall: pending.toolCall,
      approved: true,
    });
    events.push(newEvent(pending.sessionId, 'tool_result', result));
  } else {
    events.push(newEvent(pending.sessionId, 'tool_result', {
      callId: pending.toolCall.id,
      ok: false,
      error: 'permission_rejected',
    }));
  }

  return appendAgentEvents(pending.sessionId, events);
}
