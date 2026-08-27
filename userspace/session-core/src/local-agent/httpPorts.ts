import type {
  CommandJournalPort,
  CommandReply,
  ConversationCommand,
  KernelPort,
  NewSessionEvent,
  ProviderEvent,
  ProviderPort,
  ProviderRequest,
  SessionCreationInput,
  SessionEvent,
  StoredCommand,
  ToolCancelReply,
  ToolDescriptor,
  ToolExecutionRecord,
  ToolExecutionReply,
  ToolExecutionRequest,
} from '@deepcode/protocol';

interface HttpPortOptions {
  apiBase: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
}

class LocalAgentHttpPort {
  readonly apiBase: string;
  readonly serviceToken: string;
  readonly fetchImpl: typeof fetch;

  constructor(options: HttpPortOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/u, '');
    this.serviceToken = options.serviceToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        'x-deepcode-session-service-token': this.serviceToken,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    });
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new Error(`local_agent_http_json_invalid:${response.status}`);
    }
    if (!isRecord(envelope) || typeof envelope.ok !== 'boolean') {
      throw new Error('local_agent_http_envelope_invalid');
    }
    if (!response.ok || !envelope.ok) {
      const code = typeof envelope.error === 'string' ? envelope.error : 'local_agent_http_failed';
      const message = typeof envelope.message === 'string' ? envelope.message : code;
      throw new Error(`${code}:${message}`);
    }
    return envelope.data as T;
  }
}

export class HttpCommandJournal extends LocalAgentHttpPort implements CommandJournalPort {
  async createSession(input: SessionCreationInput): Promise<SessionEvent> {
    return await this.json('/api/local-agent/journal/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.json(`/api/local-agent/journal/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  async append(event: NewSessionEvent): Promise<SessionEvent> {
    return await this.json('/api/local-agent/journal/events', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  async appendBatch(events: readonly NewSessionEvent[]): Promise<SessionEvent[]> {
    return await this.json('/api/local-agent/journal/events/batch', {
      method: 'POST',
      body: JSON.stringify({ events }),
    });
  }

  async *read(sessionId: string, afterSequence = 0): AsyncIterable<SessionEvent> {
    const events = await this.json<SessionEvent[]>(
      `/api/local-agent/journal/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSequence}`,
    );
    for (const event of events) yield event;
  }

  async readCommand(sessionId: string, commandId: string): Promise<StoredCommand | null> {
    return await this.json(
      `/api/local-agent/journal/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}`,
    );
  }

  async commitCommand(
    command: ConversationCommand,
    events: readonly NewSessionEvent[],
    reply: Omit<CommandReply, 'revision'>,
  ): Promise<CommandReply> {
    return await this.json('/api/local-agent/journal/commands', {
      method: 'POST',
      body: JSON.stringify({ command, events, reply }),
    });
  }
}

export class HttpKernelPort extends LocalAgentHttpPort implements KernelPort {
  async listTools(): Promise<readonly ToolDescriptor[]> {
    return await this.json('/api/local-agent/kernel/tools');
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionReply> {
    return await this.json('/api/local-agent/kernel/execute', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async cancel(callId: string, attemptId: string): Promise<ToolCancelReply> {
    return await this.json('/api/local-agent/kernel/cancel', {
      method: 'POST',
      body: JSON.stringify({ callId, attemptId }),
    });
  }

  async readRecord(callId: string): Promise<ToolExecutionRecord | null> {
    return await this.json(
      `/api/local-agent/kernel/records/${encodeURIComponent(callId)}`,
    );
  }
}

export class HttpProviderPort extends LocalAgentHttpPort implements ProviderPort {
  async *stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const response = await this.fetchImpl(`${this.apiBase}/api/local-agent/provider/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-deepcode-session-service-token': this.serviceToken,
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`provider_http_failed:${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('text/event-stream')) {
      await response.body.cancel();
      throw new Error('provider_content_type_invalid');
    }
    yield* decodeProviderEvents(response.body, request.requestId, signal);
  }
}

async function* decodeProviderEvents(
  body: ReadableStream<Uint8Array>,
  requestId: string,
  signal: AbortSignal,
): AsyncIterable<ProviderEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let exhausted = false;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error('provider_cancelled');
      const chunk = await reader.read();
      if (chunk.done) {
        exhausted = true;
        buffer += decoder.decode();
        if (buffer.trim()) throw new Error('provider_sse_truncated');
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const boundary = buffer.search(/\r?\n\r?\n/u);
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        const match = buffer.slice(boundary).match(/^\r?\n\r?\n/u);
        buffer = buffer.slice(boundary + (match?.[0].length ?? 2));
        if (!frame.trim()) continue;
        const event = decodeProviderFrame(frame);
        if (event.requestId !== requestId) throw new Error('provider_request_identity_mismatch');
        yield event;
      }
    }
  } finally {
    if (!exhausted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function decodeProviderFrame(frame: string): ProviderEvent {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) throw new Error('provider_sse_data_missing');
  const value = JSON.parse(data) as unknown;
  if (!isExactRecord(value, ['schemaVersion', 'requestId', 'type', 'data'])) {
    throw new Error('provider_event_invalid');
  }
  if (
    value.schemaVersion !== 'deepcode.provider-event.v2'
    || !isNonEmptyText(value.requestId)
    || !isRecord(value.data)
  ) throw new Error('provider_event_invalid');
  switch (value.type) {
    case 'text.delta':
      if (!isExactRecord(value.data, ['text']) || typeof value.data.text !== 'string') {
        throw new Error('provider_event_invalid');
      }
      break;
    case 'assistant.message':
      {
        const fields = Object.hasOwn(value.data, 'reasoningContent')
          ? ['messageId', 'content', 'reasoningContent']
          : ['messageId', 'content'];
      if (
        !isExactRecord(value.data, fields)
        || !isNonEmptyText(value.data.messageId)
        || typeof value.data.content !== 'string'
        || value.data.reasoningContent !== undefined
          && !isNonEmptyText(value.data.reasoningContent)
      ) throw new Error('provider_event_invalid');
      break;
      }
    case 'tool.call':
      if (
        !isExactRecord(value.data, ['callId', 'name', 'input'])
        || !isNonEmptyText(value.data.callId)
        || !isNonEmptyText(value.data.name)
        || !isRecord(value.data.input)
      ) throw new Error('provider_event_invalid');
      break;
    case 'completed':
      break;
    case 'failed':
      if (
        !isExactRecord(value.data, ['code', 'message'])
        || !isNonEmptyText(value.data.code)
        || !isNonEmptyText(value.data.message)
      ) throw new Error('provider_event_invalid');
      break;
    default:
      throw new Error('provider_event_invalid');
  }
  return value as unknown as ProviderEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}
