import type {
  LlmChatChunk,
  LlmChatMessage,
  LlmChatRequest,
  LlmChatResult,
  LlmProviderProfile,
  ToolCall,
  ToolDefinition,
} from '@deepcode/protocol';
import { createHash } from 'node:crypto';

interface ToolNameMap {
  toProvider: Map<string, string>;
  fromProvider: Map<string, string>;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function createToolNameMap(tools: ToolDefinition[] | undefined): ToolNameMap {
  const toProvider = new Map<string, string>();
  const fromProvider = new Map<string, string>();
  const used = new Set<string>();

  for (const tool of tools ?? []) {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
    let providerName = base;
    let suffix = 2;
    while (used.has(providerName)) {
      providerName = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(providerName);
    toProvider.set(tool.name, providerName);
    fromProvider.set(providerName, tool.name);
  }

  return { toProvider, fromProvider };
}

function normalizeOpenAiBaseUrl(profile: LlmProviderProfile): string {
  const base = profile.baseUrl?.replace(/\/+$/, '') || 'https://api.openai.com/v1';
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

function normalizeAnthropicBaseUrl(profile: LlmProviderProfile): string {
  const base = profile.baseUrl?.replace(/\/+$/, '') || 'https://api.anthropic.com';
  if (base.endsWith('/v1/messages')) return base;
  return `${base}/v1/messages`;
}

function normalizeOllamaBaseUrl(profile: LlmProviderProfile): string {
  const base = profile.baseUrl?.replace(/\/+$/, '') || 'http://127.0.0.1:11434';
  if (base.endsWith('/api/chat')) return base;
  return `${base}/api/chat`;
}

function providerUserId(request: LlmChatRequest): string {
  const raw = request.providerUserId?.trim() ||
    process.env.DEEPCODE_PROVIDER_USER_ID?.trim() ||
    process.env.DEEPCODE_USER_ID?.trim() ||
    'local';
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return `dc_${digest}`;
}

function isDeepSeekProfile(profile: LlmProviderProfile): boolean {
  return Boolean(profile.baseUrl?.includes('api.deepseek.com')) ||
    profile.model.startsWith('deepseek-');
}

function positiveIntegerTokenLimit(value: number | undefined): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) return undefined;
  if (value > 0xffffffff) return undefined;
  return value;
}

function outputTokenLimit(profile: LlmProviderProfile): number | undefined {
  return positiveIntegerTokenLimit(profile.maxOutputTokens) ??
    positiveIntegerTokenLimit(profile.maxTokens);
}

function shouldSendSamplingParameters(profile: LlmProviderProfile): boolean {
  return !(isDeepSeekProfile(profile) && profile.thinking === 'enabled');
}

function toProviderToolCalls(toolCalls: ToolCall[] | undefined, names: ToolNameMap) {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    type: 'function',
    function: {
      name: names.toProvider.get(toolCall.name) ?? toolCall.name,
      arguments: JSON.stringify(toolCall.arguments ?? {}),
    },
  }));
}

function toOpenAiMessages(messages: LlmChatRequest['messages'], names: ToolNameMap) {
  return messages.map((message) => {
    const next: Record<string, unknown> = {
      role: message.role === 'tool' ? 'tool' : message.role,
      content: message.content,
    };
    if (message.toolCallId) next.tool_call_id = message.toolCallId;
    if (message.reasoningContent) next.reasoning_content = message.reasoningContent;
    const toolCalls = toProviderToolCalls(message.toolCalls, names);
    if (message.role === 'assistant' && toolCalls) next.tool_calls = toolCalls;
    return next;
  });
}

function toOpenAiTools(tools: ToolDefinition[] | undefined, names: ToolNameMap) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: names.toProvider.get(tool.name) ?? tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function toAnthropicTools(tools: ToolDefinition[] | undefined, names: ToolNameMap) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: names.toProvider.get(tool.name) ?? tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function splitAnthropicMessages(messages: LlmChatRequest['messages']) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const chatMessages = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    }));
  return { system, chatMessages };
}

function collectOpenAiReasoning(choice: any): string[] {
  const fields = [
    choice?.reasoning_content,
    choice?.reasoning,
    choice?.thinking,
    choice?.thoughts,
  ];
  const result: string[] = [];

  for (const field of fields) {
    if (!field) continue;
    if (typeof field === 'string') {
      result.push(field);
      continue;
    }
    if (Array.isArray(field)) {
      const text = field
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part?.text) return String(part.text);
          if (part?.content) return String(part.content);
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (text) result.push(text);
      continue;
    }
    result.push(JSON.stringify(field));
  }

  return result;
}

function parseOpenAiToolCalls(choice: any, names?: ToolNameMap): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  for (const toolCall of choice?.tool_calls ?? []) {
    toolCalls.push({
      id: String(toolCall.id),
      name: names?.fromProvider.get(String(toolCall.function?.name ?? '')) ??
        String(toolCall.function?.name ?? ''),
      arguments: safeJsonParse(toolCall.function?.arguments ?? '{}'),
    });
  }
  return toolCalls;
}

function parseOpenAiChoice(choice: any, names?: ToolNameMap): LlmChatResult {
  const chunks: LlmChatChunk[] = [];
  for (const reasoning of collectOpenAiReasoning(choice)) {
    chunks.push({ type: 'reasoning_delta', content: reasoning });
  }
  if (choice?.content) {
    chunks.push({ type: 'delta', content: String(choice.content) });
  }
  const toolCalls = parseOpenAiToolCalls(choice, names);
  for (const toolCall of toolCalls) {
    chunks.push({
      type: 'tool_call',
      toolCall,
    });
  }
  chunks.push({ type: 'done' });
  const assistantMessage: LlmChatMessage = {
    role: 'assistant',
    content: String(choice?.content ?? ''),
    reasoningContent: collectOpenAiReasoning(choice).join('\n') || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
  return { chunks, assistantMessage };
}

export class LlmProviderRegistry {
  async chat(
    profile: LlmProviderProfile,
    apiKey: string,
    request: LlmChatRequest
  ): Promise<LlmChatResult> {
    if (profile.kind === 'anthropic') {
      return this.callAnthropic(profile, apiKey, request);
    }
    if (profile.kind === 'ollama') {
      return this.callOllama(profile, request);
    }
    return this.callOpenAiCompatible(profile, apiKey, request);
  }

  private async callOpenAiCompatible(
    profile: LlmProviderProfile,
    apiKey: string,
    request: LlmChatRequest
  ): Promise<LlmChatResult> {
    const toolNames = createToolNameMap(request.tools);
    const providerOptions =
      profile.thinking || profile.reasoningEffort
        ? {
            ...(profile.thinking ? { thinking: { type: profile.thinking } } : {}),
            ...(profile.reasoningEffort ? { reasoning_effort: profile.reasoningEffort } : {}),
          }
        : {};

    const response = await fetch(normalizeOpenAiBaseUrl(profile), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: profile.model,
        messages: toOpenAiMessages(request.messages, toolNames),
        tools: toOpenAiTools(request.tools, toolNames),
        ...(shouldSendSamplingParameters(profile) ? { temperature: profile.temperature } : {}),
        max_tokens: outputTokenLimit(profile),
        stream: false,
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
        ...(isDeepSeekProfile(profile) ? { user_id: providerUserId(request) } : {}),
        ...providerOptions,
        ...(request.providerOptions ?? {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const json: any = await response.json();
    return parseOpenAiChoice(json.choices?.[0]?.message, toolNames);
  }

  private async callAnthropic(
    profile: LlmProviderProfile,
    apiKey: string,
    request: LlmChatRequest
  ): Promise<LlmChatResult> {
    const toolNames = createToolNameMap(request.tools);
    const { system, chatMessages } = splitAnthropicMessages(request.messages);
    const response = await fetch(normalizeAnthropicBaseUrl(profile), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: profile.model,
        max_tokens: outputTokenLimit(profile) ?? 4096,
        ...(shouldSendSamplingParameters(profile) ? { temperature: profile.temperature } : {}),
        system: system || undefined,
        messages: chatMessages,
        tools: toAnthropicTools(request.tools, toolNames),
        ...(isDeepSeekProfile(profile) ? { metadata: { user_id: providerUserId(request) } } : {}),
        ...(isDeepSeekProfile(profile) && profile.thinking ? { thinking: { type: profile.thinking } } : {}),
        ...(isDeepSeekProfile(profile) && profile.reasoningEffort ? { output_config: { effort: profile.reasoningEffort } } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const json: any = await response.json();
    const chunks: LlmChatChunk[] = [];
    for (const part of json.content ?? []) {
      if (part?.type === 'text' && part.text) {
        chunks.push({ type: 'delta', content: String(part.text) });
      }
      if (part?.type === 'tool_use') {
        chunks.push({
          type: 'tool_call',
          toolCall: {
            id: String(part.id),
            name: toolNames.fromProvider.get(String(part.name)) ?? String(part.name),
            arguments: part.input ?? {},
          },
        });
      }
    }
    chunks.push({ type: 'done' });
    return { chunks };
  }

  private async callOllama(
    profile: LlmProviderProfile,
    request: LlmChatRequest
  ): Promise<LlmChatResult> {
    const toolNames = createToolNameMap(request.tools);
    const response = await fetch(normalizeOllamaBaseUrl(profile), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: profile.model,
        messages: request.messages.map((message) => ({
          role: message.role === 'tool' ? 'user' : message.role,
          content: message.content,
        })),
        tools: toOpenAiTools(request.tools, toolNames),
        stream: false,
        options: {
          temperature: profile.temperature,
          num_predict: outputTokenLimit(profile),
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const json: any = await response.json();
    return parseOpenAiChoice(json.message, toolNames);
  }
}
