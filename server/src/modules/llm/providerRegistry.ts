import type {
  LlmChatChunk,
  LlmChatRequest,
  LlmChatResult,
  LlmProviderProfile,
  ToolDefinition,
} from '@deepcode/protocol';

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

function toOpenAiMessages(messages: LlmChatRequest['messages']) {
  return messages.map((message) => ({
    role: message.role === 'tool' ? 'tool' : message.role,
    content: message.content,
    tool_call_id: message.toolCallId,
  }));
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

function parseOpenAiChoice(choice: any, names?: ToolNameMap): LlmChatResult {
  const chunks: LlmChatChunk[] = [];
  if (choice?.content) {
    chunks.push({ type: 'delta', content: String(choice.content) });
  }
  for (const toolCall of choice?.tool_calls ?? []) {
    chunks.push({
      type: 'tool_call',
      toolCall: {
        id: String(toolCall.id),
        name: names?.fromProvider.get(String(toolCall.function?.name ?? '')) ??
          String(toolCall.function?.name ?? ''),
        arguments: safeJsonParse(toolCall.function?.arguments ?? '{}'),
      },
    });
  }
  chunks.push({ type: 'done' });
  return { chunks };
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
        messages: toOpenAiMessages(request.messages),
        tools: toOpenAiTools(request.tools, toolNames),
        temperature: profile.temperature,
        max_tokens: profile.maxTokens,
        stream: false,
        ...providerOptions,
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
        max_tokens: profile.maxTokens ?? 4096,
        temperature: profile.temperature,
        system: system || undefined,
        messages: chatMessages,
        tools: toAnthropicTools(request.tools, toolNames),
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
          num_predict: profile.maxTokens,
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
