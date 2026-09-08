import type {
  CommandJournalPort,
  CommandReply,
  ConversationCommand,
  KernelPort,
  PrepareRunRuntimeRequest,
  PreparedRunRuntime,
  PreparedToolDescriptor,
  PreparedToolPromptContribution,
  ProviderRuntimeSnapshot,
  NewSessionEvent,
  ProviderEvent,
  ProviderPort,
  ProviderRequest,
  ReleaseRunRuntimeRequest,
  ReleaseRunRuntimeResult,
  RunPreparationPort,
  RunRuntimeSnapshot,
  SelectedPluginSnapshot,
  SessionCreationInput,
  SessionEvent,
  StoredCommand,
  ToolCancelReply,
  ToolExecutionRecord,
  ToolExecutionReply,
  ToolExecutionRequest,
} from '@deepcode/protocol';
import {
  KERNEL_REPLY_VERSION,
  LOCAL_AGENT_PROTOCOL_VERSION,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_PLAN_PROGRESS,
} from '@deepcode/protocol';
import { createProviderToolAliases } from './providerToolCodec.js';
import { sessionControlToolDefinitions } from './sessionControls.js';
import {
  decodeRunPluginConfig,
  runtimeInstructions,
  type InstructionContribution,
} from './skillPlugins.js';
import {
  decodeToolPromptProviderSnapshots,
  prepareToolPromptContributions,
} from './toolPromptContributions.js';

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

function decodePreparedToolDescriptors(value: unknown): readonly PreparedToolDescriptor[] {
  if (!Array.isArray(value)) throw new Error('kernel_tool_catalog_invalid');
  const seenNames = new Set<string>();
  const seenBindings = new Set<string>();
  return Object.freeze(value.map((candidate): PreparedToolDescriptor => {
    const fields = [
      'toolBindingRef',
      'name',
      'description',
      'inputSchema',
      'possibleEffects',
      'availability',
      'origin',
    ];
    if (isRecord(candidate) && Object.hasOwn(candidate, 'pluginUri')) fields.push('pluginUri');
    if (
      !isExactRecord(candidate, fields)
      || !isNonEmptyText(candidate.toolBindingRef)
      || !isNonEmptyText(candidate.name)
      || !/^[A-Za-z0-9_.-]+$/u.test(candidate.name)
      || !isNonEmptyText(candidate.description)
      || !isRecord(candidate.inputSchema)
      || !Array.isArray(candidate.possibleEffects)
      || candidate.possibleEffects.some((effect) => ![
        'workspaceRead',
        'workspaceMutation',
        'process',
        'network',
        'external',
      ].includes(String(effect)))
      || new Set(candidate.possibleEffects.map(String)).size !== candidate.possibleEffects.length
      || candidate.availability !== 'callable' && candidate.availability !== 'blocked'
      || candidate.origin !== 'coreBuiltin' && candidate.origin !== 'extension'
      || (candidate.origin === 'coreBuiltin' && candidate.pluginUri !== undefined)
      || (candidate.origin === 'extension'
        && (!isNonEmptyText(candidate.pluginUri)
          || !/^plugin:\/\/[^@\s]+@[^@\s]+$/u.test(candidate.pluginUri)))
      || seenNames.has(candidate.name)
      || seenBindings.has(candidate.toolBindingRef)
    ) throw new Error('kernel_tool_catalog_invalid');
    seenNames.add(candidate.name);
    seenBindings.add(candidate.toolBindingRef);
    return Object.freeze({
      toolBindingRef: candidate.toolBindingRef,
      name: candidate.name,
      description: candidate.description,
      inputSchema: structuredClone(candidate.inputSchema),
      possibleEffects: [...candidate.possibleEffects] as PreparedToolDescriptor['possibleEffects'],
      availability: candidate.availability,
      origin: candidate.origin,
      ...(candidate.origin === 'extension'
        ? { pluginUri: candidate.pluginUri as PreparedToolDescriptor['pluginUri'] }
        : {}),
    });
  }).sort((left, right) => left.name.localeCompare(right.name, 'en')));
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

interface HttpRunPreparationPortOptions extends HttpPortOptions {
  stableCoreInstructions: readonly InstructionContribution[];
}

export class HttpRunPreparationPort extends LocalAgentHttpPort implements RunPreparationPort {
  readonly #stableCoreInstructions: readonly InstructionContribution[];

  constructor(options: HttpRunPreparationPortOptions) {
    super(options);
    this.#stableCoreInstructions = Object.freeze(options.stableCoreInstructions
      .map((instruction) => Object.freeze({ ...instruction })));
  }

  async prepare(request: PrepareRunRuntimeRequest): Promise<PreparedRunRuntime> {
    const value = await this.json('/api/local-agent/runtime/prepare-run', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!isExactRecord(value, [
      'schemaVersion',
      'type',
      'sessionId',
      'runId',
      'provider',
      'webSearch',
      'extensionGenerationRef',
      'kernelCatalogSnapshotRef',
      'tools',
      'toolPromptProviders',
      'pluginConfig',
      'selectedPlugins',
    ])) throw new Error('run_runtime_prepared_invalid');
    if (
      value.schemaVersion !== LOCAL_AGENT_PROTOCOL_VERSION
      || value.type !== 'run.runtime.prepared'
      || value.sessionId !== request.sessionId
      || value.runId !== request.runId
      || !isNonEmptyText(value.extensionGenerationRef)
      || !isNonEmptyText(value.kernelCatalogSnapshotRef)
    ) throw new Error('run_runtime_prepared_invalid');
    const releaseRequest = {
      sessionId: request.sessionId,
      runId: request.runId,
      kernelCatalogSnapshotRef: value.kernelCatalogSnapshotRef,
    };
    try {
      const provider = decodeProviderRuntime(value.provider);
      if (provider.reasoningEffortOverride !== request.reasoningEffortOverride) {
        throw new Error('run_runtime_reasoning_override_mismatch');
      }
      const pluginConfig = decodeRunPluginConfig(value.pluginConfig);
      if (pluginConfig.extensionGenerationRef !== value.extensionGenerationRef) {
        throw new Error('run_runtime_extension_identity_mismatch');
      }
      if (request.profileId !== undefined && provider.profileId !== request.profileId) {
        throw new Error('run_runtime_profile_identity_mismatch');
      }
      const tools = [...decodePreparedToolDescriptors(value.tools)];
      const webSearch = decodeWebSearchBinding(value.webSearch, provider, tools);
      const selectedPlugins = decodeSelectedPluginSnapshot(
        value.selectedPlugins,
        value.extensionGenerationRef,
        request,
      );
      const toolPromptProviders = decodeToolPromptProviderSnapshots(value.toolPromptProviders);
      const toolPromptContributions = prepareToolPromptContributions(
        toolPromptProviders,
        tools,
        selectedPlugins,
      );
      const providerToolAliases = createProviderToolAliases([
        ...tools
          .filter((tool) => tool.availability === 'callable')
          .map((tool) => tool.name),
        ...sessionControlToolDefinitions().map((tool) => tool.name),
      ]);
      const wireName = (canonicalName: string): string => {
        const alias = providerToolAliases.find((candidate) => (
          candidate.canonicalName === canonicalName
        ));
        if (!alias) throw new Error(`run_runtime_provider_tool_alias_missing:${canonicalName}`);
        return alias.wireName;
      };
      return {
        runtimeSnapshot: Object.freeze({
          runRuntimeSnapshotRef: `run-runtime:${request.sessionId}:${request.runId}`,
          extensionGenerationRef: value.extensionGenerationRef,
          kernelCatalogSnapshotRef: value.kernelCatalogSnapshotRef,
          provider,
          webSearch,
          instructions: [...runtimeInstructions(this.#stableCoreInstructions, pluginConfig, {
            interactionRequest: wireName(SESSION_CONTROL_INTERACTION_REQUEST),
            planPublish: wireName(SESSION_CONTROL_PLAN_PUBLISH),
            planProgress: wireName(SESSION_CONTROL_PLAN_PROGRESS),
          })],
          tools,
          toolPromptContributions: toolPromptContributions as PreparedToolPromptContribution[],
          providerToolAliases,
          selectedPlugins,
        }),
      };
    } catch (error) {
      try {
        await this.release(releaseRequest);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'run_runtime_prepare_rollback_failed');
      }
      throw error;
    }
  }

  async release(request: ReleaseRunRuntimeRequest): Promise<ReleaseRunRuntimeResult> {
    const released = decodeRunRuntimeReleased(await this.json('/api/local-agent/runtime/release-run', {
      method: 'POST',
      body: JSON.stringify(request),
    }), request);
    return Object.freeze({
      kernelCatalogSnapshotRef: released.kernelCatalogSnapshotRef,
      alreadyReleased: released.alreadyReleased,
    });
  }
}

function decodeProviderRuntime(value: unknown): ProviderRuntimeSnapshot {
  if (
    !isExactRecord(value, [
      'providerRuntimeRef',
      'profileId',
      'contextWindowTokens',
      'maxOutputTokens',
      'apiSurface',
      'hostedWebSearch',
    ], ['reasoningEffort', 'reasoningEffortOverride', 'thinking'])
    || !isNonEmptyText(value.providerRuntimeRef)
    || !isNonEmptyText(value.profileId)
    || !isPositiveSafeInteger(value.contextWindowTokens)
    || !isPositiveSafeInteger(value.maxOutputTokens)
    || value.maxOutputTokens >= value.contextWindowTokens
    || !['chatCompletions', 'responses', 'anthropicMessages', 'ollamaChat']
      .includes(String(value.apiSurface))
    || value.hostedWebSearch !== 'none' && value.hostedWebSearch !== 'web_search'
    || value.hostedWebSearch === 'web_search' && value.apiSurface !== 'responses'
    || [value.reasoningEffort, value.reasoningEffortOverride].some((effort) => effort !== undefined && !['low', 'medium', 'high', 'max'].includes(String(effort)))
    || value.thinking !== undefined && !['enabled', 'disabled'].includes(String(value.thinking))
    || value.reasoningEffortOverride !== undefined && (value.reasoningEffort !== value.reasoningEffortOverride || value.thinking === 'disabled')
  ) throw new Error('provider_runtime_snapshot_invalid');
  return Object.freeze({
    providerRuntimeRef: value.providerRuntimeRef,
    profileId: value.profileId,
    contextWindowTokens: value.contextWindowTokens,
    maxOutputTokens: value.maxOutputTokens,
    apiSurface: value.apiSurface as ProviderRuntimeSnapshot['apiSurface'],
    hostedWebSearch: value.hostedWebSearch as ProviderRuntimeSnapshot['hostedWebSearch'],
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort as ProviderRuntimeSnapshot['reasoningEffort'] } : {}),
    ...(value.reasoningEffortOverride ? { reasoningEffortOverride: value.reasoningEffortOverride as ProviderRuntimeSnapshot['reasoningEffortOverride'] } : {}),
    ...(value.thinking ? { thinking: value.thinking as ProviderRuntimeSnapshot['thinking'] } : {}),
  });
}

function decodeWebSearchBinding(
  value: unknown,
  provider: ProviderRuntimeSnapshot,
  tools: readonly PreparedToolDescriptor[],
): RunRuntimeSnapshot['webSearch'] {
  const kernelSearchCallable = tools.some((tool) => (
    tool.name === 'web.search' && tool.availability === 'callable'
  ));
  if (
    isExactRecord(value, ['owner', 'providerToolType'])
    && value.owner === 'providerHosted'
    && value.providerToolType === 'web_search'
    && provider.apiSurface === 'responses'
    && provider.hostedWebSearch === 'web_search'
    && !kernelSearchCallable
  ) return Object.freeze({ owner: 'providerHosted', providerToolType: 'web_search' });
  if (
    isExactRecord(value, ['owner', 'toolName'])
    && value.owner === 'kernelAdapter'
    && value.toolName === 'web.search'
    && kernelSearchCallable
  ) return Object.freeze({ owner: 'kernelAdapter', toolName: 'web.search' });
  if (
    isExactRecord(value, ['owner'])
    && value.owner === 'unavailable'
    && !kernelSearchCallable
  ) return Object.freeze({ owner: 'unavailable' });
  throw new Error('run_runtime_web_search_binding_invalid');
}

function decodeSelectedPluginSnapshot(
  value: unknown,
  extensionGenerationRef: string,
  request: PrepareRunRuntimeRequest,
): SelectedPluginSnapshot {
  if (
    !isExactRecord(value, ['catalogRevision', 'plugins'])
    || !isNonEmptyText(value.catalogRevision)
    || !Array.isArray(value.plugins)
    || value.plugins.length > 16
  ) throw new Error('selected_plugin_snapshot_invalid');
  const seen = new Set<string>();
  const plugins = value.plugins.map((plugin) => {
    if (
      !isExactRecord(plugin, [
        'uri',
        'pluginArtifactRef',
        'pluginInstanceRef',
        'extensionGenerationRef',
        'capabilityRefs',
      ])
      || typeof plugin.uri !== 'string'
      || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(plugin.uri)
      || seen.has(plugin.uri)
      || !isNonEmptyText(plugin.pluginArtifactRef)
      || !isNonEmptyText(plugin.pluginInstanceRef)
      || plugin.extensionGenerationRef !== extensionGenerationRef
      || !Array.isArray(plugin.capabilityRefs)
      || plugin.capabilityRefs.some((capability) => !isNonEmptyText(capability))
    ) throw new Error('selected_plugin_snapshot_invalid');
    seen.add(plugin.uri);
    return {
      uri: plugin.uri as SelectedPluginSnapshot['plugins'][number]['uri'],
      pluginArtifactRef: plugin.pluginArtifactRef,
      pluginInstanceRef: plugin.pluginInstanceRef,
      extensionGenerationRef,
      capabilityRefs: [...plugin.capabilityRefs] as string[],
    };
  });
  const requested = request.pluginSelections ?? [];
  if (
    requested.length > 0
    && (
      value.catalogRevision !== request.pluginCatalogRevision
      || requested.length !== plugins.length
      || requested.some((selection) => !seen.has(selection.uri))
    )
  ) throw new Error('selected_plugin_snapshot_identity_mismatch');
  return {
    catalogRevision: value.catalogRevision,
    plugins,
  };
}

function decodeRunRuntimeReleased(
  value: unknown,
  request: ReleaseRunRuntimeRequest,
): ReleaseRunRuntimeResult {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'type',
      'sessionId',
      'runId',
      'kernelCatalogSnapshotRef',
      'released',
      'alreadyReleased',
    ])
    || value.schemaVersion !== KERNEL_REPLY_VERSION
    || value.type !== 'tool.catalog.released'
    || value.sessionId !== request.sessionId
    || value.runId !== request.runId
    || value.kernelCatalogSnapshotRef !== request.kernelCatalogSnapshotRef
    || value.released !== true
    || typeof value.alreadyReleased !== 'boolean'
  ) throw new Error('kernel_tool_catalog_released_invalid');
  return Object.freeze({
    kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
    alreadyReleased: value.alreadyReleased,
  });
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
    value.schemaVersion !== 'deepcode.provider-event'
    || !isNonEmptyText(value.requestId)
    || !isRecord(value.data)
  ) throw new Error('provider_event_invalid');
  switch (value.type) {
    case 'text.delta':
    case 'reasoning.delta':
      {
        const fields = ['text'];
        if (Object.hasOwn(value.data, 'outputIndex')) fields.push('outputIndex');
        if (
          !isExactRecord(value.data, fields)
          || typeof value.data.text !== 'string'
          || value.data.outputIndex !== undefined
            && (!Number.isSafeInteger(value.data.outputIndex) || Number(value.data.outputIndex) < 0)
        ) {
          throw new Error('provider_event_invalid');
        }
      }
      break;
    case 'output.item.completed':
      if (
        !isExactRecord(value.data, ['outputIndex', 'item'])
        || !Number.isSafeInteger(value.data.outputIndex)
        || Number(value.data.outputIndex) < 0
        || !isRecord(value.data.item)
        || !['message', 'reasoning', 'function_call', 'web_search_call']
          .includes(String(value.data.item.type))
      ) throw new Error('provider_event_invalid');
      break;
    case 'assistant.message':
      {
        const fields = ['messageId', 'content'];
        if (Object.hasOwn(value.data, 'reasoningContent')) fields.push('reasoningContent');
        if (Object.hasOwn(value.data, 'reasoningSignature')) fields.push('reasoningSignature');
      if (
        !isExactRecord(value.data, fields)
        || !isNonEmptyText(value.data.messageId)
        || typeof value.data.content !== 'string'
        || value.data.reasoningContent !== undefined
          && !isNonEmptyText(value.data.reasoningContent)
        || value.data.reasoningSignature !== undefined
          && !isNonEmptyText(value.data.reasoningSignature)
        || value.data.reasoningSignature !== undefined
          && value.data.reasoningContent === undefined
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
    case 'hosted.web-search.completed':
      if (
        !isExactRecord(value.data, ['item'])
        || !isRecord(value.data.item)
        || value.data.item.type !== 'web_search_call'
        || !isNonEmptyText(value.data.item.id)
        || value.data.item.status !== 'completed'
          && value.data.item.status !== 'failed'
        || !isRecord(value.data.item.action)
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

function isExactRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return isRecord(value)
    && keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
