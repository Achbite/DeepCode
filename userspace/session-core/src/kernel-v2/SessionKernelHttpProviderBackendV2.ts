import type {
  DeadlineRequestV2,
  LlmChatRequest,
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
  SessionKernelProviderOrderedItemV2,
  SessionProviderPlanActionDraftV2,
  SessionProviderPlanDraftV2,
} from './SessionKernelProviderAdapterV2.js';
import type {
  SessionProviderResultMetadataV2,
  SessionProviderTurnInputV2,
} from './types.js';
import {
  boundedProviderUsageRecordV2,
  SessionKernelProviderTransportError,
} from './providerStreamV1.js';
import type {
  SessionKernelLlmStreamResultV2,
  SessionKernelLlmStreamToolItemV2,
  SessionKernelLlmTransportV2,
} from './providerStreamV1.js';

export {
  HttpSessionKernelLlmTransportV2,
  SessionKernelProviderTransportError,
} from './providerStreamV1.js';
export type {
  SessionKernelLlmTransportV2,
} from './providerStreamV1.js';

export const SESSION_PROVIDER_PLAN_DRAFT_V2_SCHEMA =
  'deepcode.session.plan-draft.v2' as const;

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
    const purpose = input.purpose;
    const exposed = purpose === 'finalAnswer'
      ? []
      : providerCallableToolsV2(input);
    const encodedNames = new Map(
      exposed.map((tool) => [
        providerWireToolNameV2(tool.toolId),
        tool.toolId,
      ])
    );
    const request: LlmChatRequest = {
      requestId: input.providerTurnId,
      profileId: this.profileId,
      stream: true,
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
            reasoningTransport:
              input.providerProfile.reasoningTransport,
            memoryContextDigest:
              input.contextAssembly.receipt.memory.contextDigest,
            contextAssemblyDigest: sha256Hash(
              canonicalJson(input.contextAssembly.receipt)
            ),
            userTurnId: input.currentInput.inputId,
            controlEpoch: input.controlEpoch,
            purpose,
          },
        },
      },
    };
    const response = await this.transport.request(request, input.signal);
    if (response.requestId !== input.providerTurnId) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_identity_mismatch',
        'Provider response identity does not match the persisted turn.'
      );
    }
    const providerResult = providerResultMetadataV2(
      response,
      this.profileId
    );
    const streamCalls = response.items.filter(
      (item): item is SessionKernelLlmStreamToolItemV2 =>
        item.kind === 'toolCall'
    );
    if (streamCalls.length > 32) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_tool_call_count_exceeded',
        'One Provider turn may return at most 32 ordered Kernel tool calls.'
      );
    }
    let toolOrdinal = 0;
    const decodedItems: SessionKernelProviderOrderedItemV2[] =
      response.items.map((item) => {
        if (item.kind === 'text') {
          return {
            kind: 'text',
            phase: item.phase,
            text: item.text,
          };
        }
        const toolId = encodedNames.get(item.name);
        if (!toolId) {
          throw new SessionKernelProviderTransportError(
            'session_kernel_provider_tool_name_unknown',
            'Provider returned a tool name outside the current encoded ToolContext.'
          );
        }
        toolOrdinal += 1;
        return {
          kind: 'toolCall',
          source: 'providerNative',
          ordinal: toolOrdinal,
          callId: requiredIdentity(item.callId, 'callId'),
          toolName: requiredIdentity(item.name, 'toolName'),
          toolId,
          arguments: decodeProviderNativeArguments(item.arguments),
        };
      });
    const decodedCalls = decodedItems.filter(
      (item): item is Extract<
        SessionKernelProviderOrderedItemV2,
        { kind: 'toolCall' }
      > => item.kind === 'toolCall'
    );
    const responseDigest = response.completion.responseDigest;
    if (decodedCalls.length > 0) {
      return {
        kind: 'nativeToolCalls',
        calls: decodedCalls,
        items: decodedItems,
        completion: response.completion,
        providerResult,
        responseDigest,
      };
    }
    const textItems = decodedItems.filter(
      (item): item is Extract<
        SessionKernelProviderOrderedItemV2,
        { kind: 'text' }
      > => item.kind === 'text'
    );
    const firstFinalIndex = textItems.findIndex(
      (item) => item.phase === 'final_answer'
    );
    const lastCommentaryIndex = textItems.findLastIndex(
      (item) => item.phase === 'commentary'
    );
    const finalItems = firstFinalIndex >= 0
      ? textItems.slice(firstFinalIndex)
      : textItems
        .slice(lastCommentaryIndex + 1)
        .filter((item) => item.phase === 'unknown');
    if (textItems.length > 0 && finalItems.length === 0) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_final_answer_missing',
        'Provider response ended after commentary without final or unphased answer text.'
      );
    }
    const text = finalItems.map((item) => item.text).join('');
    if (!text.trim()) {
      return {
        kind: 'noTool',
        items: decodedItems,
        completion: response.completion,
        providerResult,
        responseDigest,
      };
    }
    if (input.target.kind === 'planning') {
      const plan = decodeProviderPlanDraftFrame(text);
      if (plan) {
        return {
          kind: 'plan',
          plan,
          items: decodedItems,
          completion: response.completion,
          providerResult,
          responseDigest,
        };
      }
    }
    return {
      kind: 'text',
      text,
      items: decodedItems,
      completion: response.completion,
      providerResult,
      responseDigest,
    };
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
    || input.contextAssembly.receipt.providerProfile
      .reasoningTransport
      !== input.providerProfile.reasoningTransport
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
  result: SessionKernelLlmStreamResultV2,
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
    : boundedProviderUsageRecordV2(result.usage);
  return {
    providerProfileId: expectedProfileId,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  };
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
