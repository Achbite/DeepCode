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
import { canonicalJson } from '../cache/canonicalizer.js';
import { assembleContext } from '../context/assembler.js';
import {
  promptEnvelopeProviderMessages,
} from '../prompt/builder.js';
import type {
  SessionKernelProviderBackendOutputV2,
  SessionKernelProviderBackendV2,
  SessionProviderPlanActionDraftV2,
  SessionProviderPlanDraftV2,
} from './SessionKernelProviderAdapterV2.js';
import type { SessionProviderTurnInputV2 } from './types.js';

export const SESSION_PROVIDER_PLAN_DRAFT_V2_SCHEMA =
  'deepcode.session.plan-draft.v2' as const;
const SESSION_PROVIDER_TURN_INPUT_V2_SCHEMA =
  'deepcode.session.provider-turn-input.v2' as const;

export interface SessionKernelLlmTransportV2 {
  request(
    request: LlmChatRequest,
    signal: AbortSignal
  ): Promise<ApiResponse<LlmChatResult>>;
}

export class HttpSessionKernelLlmTransportV2
implements SessionKernelLlmTransportV2 {
  constructor(
    private readonly apiBase: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async request(
    request: LlmChatRequest,
    signal: AbortSignal
  ): Promise<ApiResponse<LlmChatResult>> {
    const response = await this.fetchImpl(
      `${normalizeApiBase(this.apiBase)}/api/llm/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      }
    );
    if (!response.ok) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_http_failed',
        `Provider transport failed with HTTP ${response.status}.`
      );
    }
    return await response.json() as ApiResponse<LlmChatResult>;
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
    private readonly profileId?: string
  ) {}

  async requestTurn(
    input: SessionProviderTurnInputV2
  ): Promise<SessionKernelProviderBackendOutputV2> {
    const exposed = callableTools(input);
    const encodedNames = new Map(
      exposed.map((tool) => [encodeProviderToolId(tool.toolId), tool.toolId])
    );
    const request: LlmChatRequest = {
      requestId: input.providerTurnId,
      ...(this.profileId ? { profileId: this.profileId } : {}),
      messages: promptEnvelopeProviderMessages(
        assembleContext({
          workflowState: `kernel-v2:${input.target.kind}`,
          allowedProposals: providerAllowedProposals(input),
          kernelToolContext: input.toolContext.bundle,
          userRequest: input.currentInput.text,
          extraMemoryHints: [
            canonicalJson({
              conversationInputs: input.conversationInputs,
              providerOutcomes: input.providerOutcomes,
            }),
          ],
          currentTaskGoal: input.plan?.objective,
          currentTaskContext: providerTurnFrame(input),
          profile: {
            provider: this.profileId ?? 'host-selected',
            model: 'host-selected',
          },
          contextAssemblyId: input.providerTurnId,
        }).prompt
      ),
      tools: exposed.map((tool): ProviderWireToolDefinition => ({
        name: encodeProviderToolId(tool.toolId),
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
    if (calls.length > 1) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_multiple_calls',
        'One Provider turn may submit at most one Kernel tool call.'
      );
    }
    if (calls.length === 1) {
      const call = calls[0]!;
      const toolId = encodedNames.get(call.name);
      if (!toolId) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_tool_name_unknown',
          'Provider returned a tool name outside the current encoded ToolContext.'
        );
      }
      return {
        kind: 'nativeToolCall',
        callId: requiredIdentity(call.id, 'callId'),
        toolId,
        arguments: call.arguments,
      };
    }
    const text = assistant.content ?? '';
    if (!text.trim()) return { kind: 'noTool' };
    if (input.target.kind === 'planning') {
      const plan = decodeProviderPlanDraftFrame(text);
      if (plan) return { kind: 'plan', plan };
    }
    return { kind: 'text', text };
  }
}

function providerAllowedProposals(
  input: SessionProviderTurnInputV2
): string[] {
  if (input.target.kind === 'planning') {
    return ['plan', 'contextRead', 'answer', 'noTool'];
  }
  return ['toolIntent', 'answer', 'noTool'];
}

function providerTurnFrame(
  input: SessionProviderTurnInputV2
): Record<string, unknown> {
  return {
    schemaVersion: SESSION_PROVIDER_TURN_INPUT_V2_SCHEMA,
    providerTurnId: input.providerTurnId,
    runId: input.runId,
    controlEpoch: input.controlEpoch,
    toolContextRef: input.toolContext.contextRef,
    currentInput: input.currentInput,
    ...(input.plan ? { plan: input.plan } : {}),
    ...(input.planDecision
      ? { planDecision: input.planDecision }
      : {}),
    target: input.target,
    guidance: input.guidance,
    kernelFacts: input.kernelFacts,
    outputContract:
      input.target.kind === 'planning'
        ? {
            planSchemaVersion:
              SESSION_PROVIDER_PLAN_DRAFT_V2_SCHEMA,
            rule:
              'Return either one exact plan-draft JSON object, one exposed read-only native tool call for more context, or ordinary text. Never invent authority identities.',
          }
        : {
            rule:
              'Return at most one exposed native tool call, one exact standalone ToolIntent text frame, ordinary text, or no tool.',
          },
  };
}

function callableTools(input: SessionProviderTurnInputV2) {
  if (input.target.kind === 'planAction') {
    const planActionId = input.target.planActionId;
    const toolId = input.plan?.actions.find(
      (action) =>
        action.manifest.planActionId === planActionId
    )?.manifest.toolId;
    return input.toolContext.tools.filter(
      (tool) => tool.toolId === toolId
    );
  }
  return input.toolContext.tools.filter(
    (tool) => tool.effectClass === 'read'
  );
}

function encodeProviderToolId(toolId: string): string {
  const bytes = new TextEncoder().encode(toolId);
  return `dcv2_${[...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
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

function objectRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
