import type {
  AgentContextAttachment,
  AgentEvent,
  AgentMode,
  LlmChatMessage,
  PermissionRequest,
  ToolCall,
} from '@deepcode/protocol';
import { appendAgentEvents, getLlmProfiles, llmChat } from './runtimeAdapter';
import { buildAgentContextSnapshot } from './contextBuilder';
import { evaluatePermission } from './permissionGate';
import { executeToolCall } from './toolExecutors';
import { getAllowedTools } from './toolRegistry';

function newEvent(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId,
    ts: new Date().toISOString(),
    kind,
    payload,
  };
}

export interface AgentTurnResult {
  events: AgentEvent[];
  pending?: {
    request: PermissionRequest;
    toolCall: ToolCall;
  };
}

async function persist(sessionId: string, events: AgentEvent[]) {
  if (events.length === 0) return;
  await appendAgentEvents(sessionId, { events });
}

export async function runAgentTurn(input: {
  sessionId: string;
  content: string;
  attachments: AgentContextAttachment[];
  mode: AgentMode;
  profileId?: string;
}): Promise<AgentTurnResult> {
  const events: AgentEvent[] = [];
  const context = await buildAgentContextSnapshot(input.attachments);
  const profiles = await getLlmProfiles();
  const profileId =
    input.profileId ||
    (profiles.ok ? profiles.data?.defaultProfileId : undefined);

  if (!profileId) {
    events.push(newEvent(input.sessionId, 'assistant_msg', {
      content: '请先在 Settings -> LLM Providers 配置并保存一个默认模型 profile。',
    }));
    await persist(input.sessionId, events);
    return { events };
  }

  const messages: LlmChatMessage[] = [
    {
      role: 'system',
      content:
        'You are DeepCode Agent. Work only inside the current workspace. ' +
        'Use tools for file inspection. Do not claim to write files unless fs.write succeeds. ' +
        `Current mode: ${input.mode}.\n\n` +
        context.promptText,
    },
    { role: 'user', content: input.content },
  ];

  const response = await llmChat({
    profileId,
    messages,
    tools: getAllowedTools(input.mode),
    stream: false,
  });

  if (!response.ok || !response.data) {
    events.push(newEvent(input.sessionId, 'error', {
      message: response.message ?? 'LLM 调用失败',
    }));
    await persist(input.sessionId, events);
    return { events };
  }

  let assistantText = '';
  for (const chunk of response.data.chunks) {
    if (chunk.type === 'delta' && chunk.content) {
      assistantText += chunk.content;
    }
    if (chunk.type === 'tool_call' && chunk.toolCall) {
      const toolCall = chunk.toolCall;
      events.push(newEvent(input.sessionId, 'tool_call', toolCall));
      const decision = evaluatePermission(toolCall, input.mode);
      if (decision.action === 'deny') {
        events.push(newEvent(input.sessionId, 'tool_result', {
          callId: toolCall.id,
          ok: false,
          error: decision.reason,
        }));
        continue;
      }
      if (decision.action === 'ask' && decision.request) {
        if (toolCall.name === 'fs.write') {
          const args = toolCall.arguments as any;
          const diff = await executeToolCall({
            id: `${toolCall.id}-diff`,
            name: 'fs.diff',
            arguments: {
              path: args.path,
              folderId: args.folderId,
              newContent: args.content,
            },
          });
          if (diff.ok && (diff.output as any)?.unifiedDiff) {
            decision.request.diff = (diff.output as any).unifiedDiff;
          }
        }
        events.push(newEvent(input.sessionId, 'permission_request', decision.request));
        await persist(input.sessionId, events);
        return { events, pending: { request: decision.request, toolCall } };
      }
      const result = await executeToolCall(toolCall);
      events.push(newEvent(input.sessionId, 'tool_result', result));
    }
  }

  if (assistantText.trim()) {
    events.push(newEvent(input.sessionId, 'assistant_msg', {
      content: assistantText.trim(),
    }));
  }
  await persist(input.sessionId, events);
  return { events };
}

export async function resolvePendingTool(input: {
  sessionId: string;
  toolCall: ToolCall;
  accepted: boolean;
}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [
    newEvent(input.sessionId, 'permission_result', {
      callId: input.toolCall.id,
      decision: input.accepted ? 'accept' : 'reject',
    }),
  ];
  if (input.accepted) {
    const result = await executeToolCall(input.toolCall);
    events.push(newEvent(input.sessionId, 'tool_result', result));
    events.push(newEvent(input.sessionId, 'assistant_msg', {
      content: result.ok ? '已按你的确认执行写入。' : `执行失败：${result.error}`,
    }));
  } else {
    events.push(newEvent(input.sessionId, 'assistant_msg', {
      content: '已拒绝本次写入请求，文件未修改。',
    }));
  }
  await persist(input.sessionId, events);
  return events;
}
