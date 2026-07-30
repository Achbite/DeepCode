import type {
  ApiResponse,
  DeadlineRequestV2,
  LlmChatRequest,
  LlmChatResult,
  RawToolArgumentsV2,
  RequestedResourceV2,
  ProviderWireToolDefinition,
} from '@deepcode/protocol';
import { decodeRawToolArgumentsV2 } from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  providerCallableToolsV2,
  providerWireToolNameV2,
} from './providerContext.js';
import type {
  SessionKernelProviderBackendOutputV2,
  SessionKernelProviderBackendV2,
  SessionProviderPlanActionDraftV2,
  SessionProviderPlanDraftV2,
} from './SessionKernelProviderAdapterV2.js';
import type {
  SessionKernelTransportPrivateAuthV2,
} from './SessionKernelPortV2.js';
import type {
  SessionProviderResultMetadataV2,
  SessionProviderTurnInputV2,
} from './types.js';

export const SESSION_PROVIDER_PLAN_DRAFT_V2_SCHEMA =
  'deepcode.session.plan-draft.v2' as const;

export interface SessionKernelLlmTransportV2 {
  request(
    request: LlmChatRequest,
    signal: AbortSignal
  ): Promise<ApiResponse<LlmChatResult>>;
}

export class HttpSessionKernelLlmTransportV2
implements SessionKernelLlmTransportV2 {
  readonly #runCapability: string;

  constructor(
    private readonly apiBase: string,
    privateAuth: SessionKernelTransportPrivateAuthV2,
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.#runCapability = privateAuth.runCapability;
  }

  async request(
    request: LlmChatRequest,
    signal: AbortSignal
  ): Promise<ApiResponse<LlmChatResult>> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${normalizeApiBase(this.apiBase)}/api/llm/chat`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-deepcode-run-capability': this.#runCapability,
            'x-deepcode-session-id': this.sessionId,
            'x-deepcode-run-id': this.runId,
          },
          body: JSON.stringify(request),
          signal,
        }
      );
    } catch {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_transport_failed',
        'Provider transport failed before receiving an HTTP response.'
      );
    }
    if (!response.ok) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_http_failed',
        `Provider transport failed with HTTP ${response.status}.`
      );
    }
    try {
      return await response.json() as ApiResponse<LlmChatResult>;
    } catch {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_response_decode_failed',
        'Provider transport returned an invalid JSON response.'
      );
    }
  }
}

/**
 * Provider-specific wire adapter. Kernel ToolIds are reversibly encoded only
 * in the provider function-name field; descriptions and JSON Schemas are
 * transported unchanged.
 */
export class HttpSessionKernelProviderBackendV2
implements SessionKernelProviderBackendV2 {
  constructor(
    private readonly transport: SessionKernelLlmTransportV2,
    private readonly profileId: string
  ) {}

  async requestTurn(
    input: SessionProviderTurnInputV2
  ): Promise<SessionKernelProviderBackendOutputV2> {
    assertProviderToolContextBindingV2(input);
    const exposed = providerCallableToolsV2(input);
    const encodedNames = new Map(
      exposed.map((tool) => [
        providerWireToolNameV2(tool.toolId),
        tool.toolId,
      ])
    );
    const request: LlmChatRequest = {
      requestId: input.providerTurnId,
      profileId: this.profileId,
      messages: cloneJson(input.contextAssembly.messages),
      tools: exposed.map((tool): ProviderWireToolDefinition => ({
        name: providerWireToolNameV2(tool.toolId),
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      providerOptions: {
        deepcode: {
          sessionKernelV2: {
            contextVersion: input.toolContext.contextRef.contextVersion,
            catalogDigest: input.toolContext.contextRef.catalogDigest,
            contextDigest: input.toolContext.contextRef.contextDigest,
            factsSnapshotHighWater:
              input.kernelFacts.snapshotHighWater,
            factsOmittedCount: input.kernelFacts.omittedCount,
            providerProfileRevisionDigest:
              input.providerProfile.providerProfileRevisionDigest,
            memoryContextDigest:
              input.contextAssembly.receipt.memory.contextDigest,
            contextAssemblyDigest: sha256Hash(
              canonicalJson(input.contextAssembly.receipt)
            ),
          },
        },
      },
    };
    const response = await this.transport.request(request, input.signal);
    if (!response.ok || !response.data) {
      throw new SessionKernelProviderTransportError(
        response.error ?? 'session_kernel_provider_failed',
        response.message ?? 'Provider request failed.'
      );
    }
    if (
      response.data.requestId
      && response.data.requestId !== input.providerTurnId
    ) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_identity_mismatch',
        'Provider response identity does not match the persisted turn.'
      );
    }
    const assistant = response.data.assistantMessage;
    if (!assistant || assistant.role !== 'assistant') {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_response_missing',
        'Provider response has no assistant message.'
      );
    }
    const calls = assistant.toolCalls ?? [];
    const providerResult = providerResultMetadataV2(
      response.data,
      this.profileId
    );
    const responseDigest = sha256Hash(canonicalJson(response.data));
    if (calls.length > 32) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_tool_call_count_exceeded',
        'One Provider turn may return at most 32 ordered Kernel tool calls.'
      );
    }
    if (calls.length > 0) {
      const decodedCalls = calls.map((call) => {
        const toolId = encodedNames.get(call.name);
        if (!toolId) {
          throw new SessionKernelProviderTransportError(
            'session_kernel_provider_tool_name_unknown',
            'Provider returned a tool name outside the current encoded ToolContext.'
          );
        }
        return {
          callId: requiredIdentity(call.id, 'callId'),
          toolName: requiredIdentity(call.name, 'toolName'),
          toolId,
          arguments: decodeProviderNativeArguments(call.arguments),
        };
      });
      return {
        kind: 'nativeToolCalls',
        calls: decodedCalls,
        providerResult,
        responseDigest,
      };
    }
    const text = assistant.content ?? '';
    if (!text.trim()) {
      return { kind: 'noTool', providerResult, responseDigest };
    }
    if (input.target.kind === 'planning') {
      const plan = decodeProviderPlanDraftFrame(text);
      if (plan) {
        return { kind: 'plan', plan, providerResult, responseDigest };
      }
    }
    return { kind: 'text', text, providerResult, responseDigest };
  }
}

function decodeProviderNativeArguments(
  value: unknown
): RawToolArgumentsV2 {
  if (typeof value !== 'string') return decodeRawToolArgumentsV2(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_tool_arguments_invalid',
      'Provider-native tool arguments are not valid JSON.'
    );
  }
  return decodeRawToolArgumentsV2(parsed);
}

function assertProviderToolContextBindingV2(
  input: SessionProviderTurnInputV2
): void {
  const bundle = input.toolContext.bundle;
  const contextRef = input.toolContext.contextRef;
  if (
    input.toolContext.fixedPrompt !== bundle.fixedPrompt
    || canonicalJson(input.toolContext.tools)
      !== canonicalJson(bundle.tools)
    || contextRef.contextVersion !== bundle.contextVersion
    || contextRef.catalogDigest !== bundle.catalogDigest
    || contextRef.contextDigest !== bundle.contextDigest
    || bundle.tools.some((tool) => tool.availability !== 'ready')
    || input.contextAssembly.messages.length !== 7
    || input.contextAssembly.messages[0]?.role !== 'system'
    || input.contextAssembly.messages[0]?.content
      !== bundle.fixedPrompt
    || input.contextAssembly.receipt.providerProfile
      .providerProfileId
      !== input.providerProfile.providerProfileId
    || input.contextAssembly.receipt.providerProfile
      .providerProfileRevisionDigest
      !== input.providerProfile.providerProfileRevisionDigest
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_tool_context_binding_invalid',
      'Provider ToolContext binding differs from the immutable Kernel bundle.'
    );
  }
}

function decodeProviderPlanDraftFrame(
  text: string
): SessionProviderPlanDraftV2 | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  const record = objectRecord(value);
  if (record?.schemaVersion !== SESSION_PROVIDER_PLAN_DRAFT_V2_SCHEMA) {
    return undefined;
  }
  exactKeys(record, [
    'schemaVersion',
    'title',
    'objective',
    'narrative',
    'actions',
  ]);
  if (!Array.isArray(record.actions)) {
    throw invalidPlanFrame();
  }
  return {
    title: requiredText(record.title, 'title'),
    objective: requiredText(record.objective, 'objective'),
    narrative: requiredText(record.narrative, 'narrative'),
    actions: record.actions.map(decodePlanAction),
  };
}

function decodePlanAction(
  value: unknown
): SessionProviderPlanActionDraftV2 {
  const record = objectRecord(value);
  if (!record) throw invalidPlanFrame();
  exactKeys(
    record,
    [
      'toolId',
      'requestedResources',
      'previewArguments',
      'deadline',
    ],
    ['deadline']
  );
  if (!Array.isArray(record.requestedResources)) {
    throw invalidPlanFrame();
  }
  return {
    toolId: requiredIdentity(record.toolId, 'toolId'),
    requestedResources:
      record.requestedResources.map(decodeRequestedResource),
    previewArguments:
      decodeRawToolArgumentsV2(record.previewArguments),
    ...(record.deadline !== undefined
      ? { deadline: decodeDeadline(record.deadline) }
      : {}),
  };
}

function decodeRequestedResource(value: unknown): RequestedResourceV2 {
  const tagged = objectRecord(value);
  if (!tagged) throw invalidPlanFrame();
  exactKeys(tagged, ['kind', 'data']);
  const data = objectRecord(tagged.data);
  if (!data) throw invalidPlanFrame();
  switch (tagged.kind) {
    case 'workspacePath':
      exactKeys(data, ['path', 'access']);
      if (data.access !== 'read' && data.access !== 'write') {
        throw invalidPlanFrame();
      }
      return {
        kind: tagged.kind,
        data: {
          path: requiredText(data.path, 'path'),
          access: data.access,
        },
      };
    case 'repository':
      exactKeys(data, ['area']);
      if (
        data.area !== 'state'
        && data.area !== 'index'
        && data.area !== 'history'
      ) {
        throw invalidPlanFrame();
      }
      return { kind: tagged.kind, data: { area: data.area } };
    case 'networkUrl':
      exactKeys(data, ['url']);
      return {
        kind: tagged.kind,
        data: { url: requiredText(data.url, 'url') },
      };
    case 'networkQuery':
      exactKeys(data, ['query']);
      return {
        kind: tagged.kind,
        data: { query: requiredText(data.query, 'query') },
      };
    case 'exactInvocation':
      exactKeys(data, ['invocationDigest']);
      return {
        kind: tagged.kind,
        data: {
          invocationDigest: requiredIdentity(
            data.invocationDigest,
            'invocationDigest'
          ),
        },
      };
    default:
      throw invalidPlanFrame();
  }
}

function decodeDeadline(value: unknown): DeadlineRequestV2 {
  const tagged = objectRecord(value);
  if (!tagged) throw invalidPlanFrame();
  exactKeys(tagged, ['kind', 'data']);
  const data = objectRecord(tagged.data);
  if (!data) throw invalidPlanFrame();
  if (tagged.kind === 'contractDefault') {
    exactKeys(data, []);
    return { kind: tagged.kind, data: {} };
  }
  if (
    tagged.kind === 'exactMilliseconds'
    && Number.isSafeInteger(data.value)
    && Number(data.value) > 0
  ) {
    exactKeys(data, ['value']);
    return {
      kind: tagged.kind,
      data: { value: Number(data.value) },
    };
  }
  throw invalidPlanFrame();
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const permitted = new Set([...required, ...optional]);
  if (
    required.some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key)
    )
    || Object.keys(record).some((key) => !permitted.has(key))
  ) {
    throw invalidPlanFrame();
  }
}

function providerResultMetadataV2(
  result: LlmChatResult,
  expectedProfileId: string
): SessionProviderResultMetadataV2 {
  if (
    result.providerProfileId !== undefined
    && result.providerProfileId !== expectedProfileId
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_profile_result_mismatch',
      'Provider result profile does not match the immutable Run bootstrap.'
    );
  }
  const provider = optionalMetadataIdentity(
    result.provider,
    'provider'
  );
  const model = optionalMetadataIdentity(result.model, 'model');
  const usage = result.usage === undefined
    ? undefined
    : boundedUsageRecord(result.usage);
  return {
    providerProfileId: expectedProfileId,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  };
}

function boundedUsageRecord(
  value: unknown
): Record<string, unknown> {
  const maximumUsageCounter = 1_000_000_000_000;
  const usage = objectRecord(value);
  if (!usage) return {};
  let visited = 0;
  const sanitize = (
    candidate: Record<string, unknown>,
    depth: number
  ): Record<string, unknown> => {
    if (depth > 4) return {};
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(candidate).sort()) {
      visited += 1;
      if (
        visited > 256
        || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(key)
      ) {
        continue;
      }
      if (
        typeof nested === 'number'
        && Number.isSafeInteger(nested)
        && nested >= 0
        && nested <= maximumUsageCounter
      ) {
        sanitized[key] = nested;
      } else {
        const child = objectRecord(nested);
        if (child) sanitized[key] = sanitize(child, depth + 1);
      }
    }
    return sanitized;
  };
  const sanitized = sanitize(usage, 0);
  if (
    new TextEncoder().encode(canonicalJson(sanitized)).byteLength
      > 64 * 1024
  ) {
    return {};
  }
  return sanitized;
}

function optionalMetadataIdentity(
  value: unknown,
  _field: string
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 1024
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function objectRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredIdentity(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (
    text.trim() !== text
    || /[\u0000-\u001f\u007f-\u009f]/u.test(text)
  ) {
    throw invalidPlanFrame();
  }
  return text;
}

function requiredText(value: unknown, _field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || new TextEncoder().encode(value).byteLength > 64 * 1024
  ) {
    throw invalidPlanFrame();
  }
  return value;
}

function invalidPlanFrame(): SessionKernelProviderTransportError {
  return new SessionKernelProviderTransportError(
    'session_kernel_provider_plan_frame_invalid',
    'Provider plan frame is invalid.'
  );
}

function normalizeApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidApiBase();
  }
  const authority = value
    .split('://')[1]
    ?.split('/')[0] ?? '';
  const hostname = url.hostname.startsWith('[')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const loopback = hostname === '::1'
    || (
      hostname.split('.').length === 4
      && hostname.split('.').every(
        (part) =>
          /^\d{1,3}$/u.test(part)
          && Number(part) >= 0
          && Number(part) <= 255
      )
      && Number(hostname.split('.')[0]) === 127
    );
  if (
    value.trim() !== value
    || url.protocol !== 'http:'
    || !loopback
    || authority.includes('@')
    || url.username
    || url.password
    || url.search
    || url.hash
    || !['', '/'].includes(url.pathname)
  ) {
    throw invalidApiBase();
  }
  return url.origin;
}

function invalidApiBase(): SessionKernelProviderTransportError {
  return new SessionKernelProviderTransportError(
    'session_kernel_provider_api_base_invalid',
    'Provider transport requires an absolute loopback HTTP origin.'
  );
}

export class SessionKernelProviderTransportError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelProviderTransportError';
  }
}
