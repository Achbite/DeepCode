import type {
  LlmChatChunk,
  LlmChatRequest,
  LlmChatResult,
  LlmProbeResult,
  LlmProviderProfile,
} from '@deepcode/protocol';
import { getLlmProfileById } from './llmProfileService.js';
import { getLlmSecret } from './secretStore.js';

function normalizeOpenAiBaseUrl(profile: LlmProviderProfile): string {
  const base = profile.baseUrl?.replace(/\/+$/, '') || 'https://api.openai.com/v1';
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

function toOpenAiMessages(messages: LlmChatRequest['messages']) {
  return messages.map((message) => ({
    role: message.role === 'tool' ? 'tool' : message.role,
    content: message.content,
    tool_call_id: message.toolCallId,
  }));
}

function toOpenAiTools(tools: LlmChatRequest['tools']) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name.replace(/[^\w.-]/g, '_'),
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

async function loadProfileAndSecret(profileId: string): Promise<{
  profile: LlmProviderProfile;
  apiKey: string;
}> {
  const profile = await getLlmProfileById(profileId);
  if (!profile) {
    throw new Error(`LLM profile 不存在: ${profileId}`);
  }
  if (!profile.enabled) {
    throw new Error(`LLM profile 已禁用: ${profile.name}`);
  }
  const apiKey = await getLlmSecret(profile.secretRef);
  if (!apiKey && profile.kind !== 'ollama') {
    throw new Error(`LLM profile 未配置 API key: ${profile.name}`);
  }
  return { profile, apiKey: apiKey ?? '' };
}

async function callOpenAiCompatible(
  profile: LlmProviderProfile,
  apiKey: string,
  request: LlmChatRequest
): Promise<LlmChatResult> {
  const response = await fetch(normalizeOpenAiBaseUrl(profile), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: profile.model,
      messages: toOpenAiMessages(request.messages),
      tools: toOpenAiTools(request.tools),
      temperature: profile.temperature,
      max_tokens: profile.maxTokens,
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const json: any = await response.json();
  const choice = json.choices?.[0]?.message;
  const chunks: LlmChatChunk[] = [];
  if (choice?.content) {
    chunks.push({ type: 'delta', content: String(choice.content) });
  }
  for (const toolCall of choice?.tool_calls ?? []) {
    chunks.push({
      type: 'tool_call',
      toolCall: {
        id: String(toolCall.id),
        name: String(toolCall.function?.name ?? ''),
        arguments: safeJsonParse(toolCall.function?.arguments ?? '{}'),
      },
    });
  }
  chunks.push({ type: 'done' });
  return { chunks };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function probeLlmProfile(profileId: string): Promise<LlmProbeResult> {
  const started = Date.now();
  try {
    const { profile, apiKey } = await loadProfileAndSecret(profileId);
    if (profile.kind === 'ollama') {
      return {
        ok: true,
        provider: profile.kind,
        model: profile.model,
        latencyMs: Date.now() - started,
      };
    }

    await callOpenAiCompatible(profile, apiKey, {
      profileId,
      stream: false,
      messages: [
        { role: 'system', content: 'You are a health check endpoint.' },
        { role: 'user', content: 'Reply with ok.' },
      ],
    });

    return {
      ok: true,
      provider: profile.kind,
      model: profile.model,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'openaiCompatible',
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function chatWithLlm(request: LlmChatRequest): Promise<LlmChatResult> {
  const { profile, apiKey } = await loadProfileAndSecret(request.profileId);
  if (profile.kind === 'anthropic' || profile.kind === 'codex') {
    throw new Error(`${profile.kind} adapter 尚未实现；请使用 OpenAI-compatible 或 Ollama`);
  }
  return callOpenAiCompatible(profile, apiKey, request);
}
