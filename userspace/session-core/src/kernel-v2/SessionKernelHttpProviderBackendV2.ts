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
  sessionPlanningResponseContractReminderV2,
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
  SessionProviderTurnTerminalRecordV3,
  SessionProviderTurnInputV2,
} from './types.js';
import {
  boundedProviderUsageRecordV2,
  SessionKernelProviderTransportError,
} from './providerStreamV1.js';
import {
  isExactSessionProviderOutcomeRecordV2,
} from './providerToolCallQueue.js';
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

export const SESSION_PROVIDER_PLANNING_RESULT_V2_SCHEMA =
  'deepcode.session.planning-result.v2' as const;

export type SessionProviderPlanningResultV2 =
  | {
      kind: 'answer';
      text: string;
    }
  | {
      kind: 'plan';
      plan: SessionProviderPlanDraftV2;
    };

export type SessionKernelProviderDecodeInputV2 = Pick<
  SessionProviderTurnInputV2,
  'providerTurnId' | 'target' | 'plan' | 'toolContext'
>;

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
    const parentRequestId = providerContinuationParentIdV2(
      input,
      this.profileId
    );
    const request: LlmChatRequest = {
      requestId: input.providerTurnId,
      ...(parentRequestId ? { parentRequestId } : {}),
      profileId: this.profileId,
      stream: true,
      messages: cloneJson(input.contextAssembly.messages),
      ...(input.target.kind === 'planning'
        && input.providerProfile.reasoningTransport === 'openaiPlaintext'
        ? { responseFormat: { type: 'json_object' as const } }
        : {}),
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
    const response = await this.transport.request(
      request,
      input.signal,
      input.target.kind === 'planning'
        ? undefined
        : input.publicTextObserver
    );
    return decodeSessionKernelLlmStreamResultV2(
      input,
      response,
      this.profileId
    );
  }
}

function providerContinuationParentIdV2(
  input: SessionProviderTurnInputV2,
  expectedProfileId: string
): string | undefined {
  if (input.purpose !== 'continuation') return undefined;
  const previous = input.providerOutcomes.at(-1);
  if (
    input.providerProfile.providerProfileId !== expectedProfileId
    || !isExactSessionProviderOutcomeRecordV2(
      previous,
      expectedProfileId
    )
    || previous.outputKind !== 'toolIntent'
    || previous.toolSettlement.status !== 'completed'
    || previous.providerResult.providerProfileId
      !== input.providerProfile.providerProfileId
    || previous.toolCallReceipt.providerTurnId
      !== previous.providerTurnId
    || previous.toolCallReceipt.callCount <= 0
  ) {
    return undefined;
  }
  return previous.providerTurnId;
}

/**
 * Pure sealed-response decoder shared by the live transport and deterministic
 * recovery. It performs the same ToolContext name mapping and semantic text,
 * Plan, and tool classification without issuing a Provider request.
 */
export function decodeSessionKernelLlmStreamResultV2(
  input: SessionKernelProviderDecodeInputV2,
  response: SessionKernelLlmStreamResultV2,
  expectedProfileId: string
): SessionKernelProviderBackendOutputV2 {
    if (response.requestId !== input.providerTurnId) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_identity_mismatch',
        'Provider response identity does not match the persisted turn.'
      );
    }
    const providerResult = providerResultMetadataV2(
      response,
      expectedProfileId
    );
    const exposed = input.target.kind === 'finalAnswer'
      ? []
      : providerCallableToolsV2(input);
    const encodedNames = new Map(
      exposed.map((tool) => [
        providerWireToolNameV2(tool.toolId),
        tool.toolId,
      ])
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
    if (input.target.kind === 'planning') {
      const planningResult = decodeProviderPlanningResultEnvelopeV2(
        textItems.map((item) => item.text).join('')
      );
      if (planningResult.kind === 'plan') {
        return {
          kind: 'plan',
          plan: planningResult.plan,
          items: [],
          completion: response.completion,
          providerResult,
          responseDigest,
        };
      }
      return {
        kind: 'text',
        text: planningResult.text,
        items: [{
          kind: 'text',
          phase: textItems.some(
            (item) => item.phase === 'final_answer'
          )
            ? 'final_answer'
            : 'unknown',
          text: planningResult.text,
        }],
        completion: response.completion,
        providerResult,
        responseDigest,
      };
    }
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
    return {
      kind: 'text',
      text,
      items: decodedItems,
      completion: response.completion,
      providerResult,
      responseDigest,
    };
}

/**
 * Rehydrates one daemon-written completed terminal into the exact live stream
 * result shape, then routes it through the shared sealed-response decoder.
 */
export function decodeCompletedProviderTerminalV3(
  input: SessionKernelProviderDecodeInputV2,
  terminal: SessionProviderTurnTerminalRecordV3,
  expectedProfileId: string
): SessionKernelProviderBackendOutputV2 {
  const data = terminal.data;
  if (
    data.terminalKind !== 'completed'
    || data.providerTurnId !== input.providerTurnId
    || !data.completion
    || !data.providerResult
    || !data.responseDigest
    || data.completion.responseDigest !== data.responseDigest
    || data.completion.trace.terminalDigest
      !== data.traceRef.terminalDigest
    || data.completion.trace.sealDigest !== data.traceRef.sealDigest
    || data.completion.trace.recordCount !== data.traceRef.recordCount
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_terminal_evidence_invalid',
      'Completed Provider terminal cannot be reconstructed as one sealed response.'
    );
  }
  return decodeSessionKernelLlmStreamResultV2(
    input,
    {
      requestId: data.providerTurnId,
      items: cloneJson(data.orderedItems),
      ...(data.providerResult.usage
        ? { usage: cloneJson(data.providerResult.usage) }
        : {}),
      providerProfileId: data.providerResult.providerProfileId,
      provider: data.providerResult.provider,
      model: data.providerResult.model,
      completion: cloneJson(data.completion),
    },
    expectedProfileId
  );
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
  const planningTarget = input.target.kind === 'planning';
  if (
    input.toolContext.fixedPrompt !== bundle.fixedPrompt
    || canonicalJson(input.toolContext.tools)
      !== canonicalJson(bundle.tools)
    || contextRef.contextVersion !== bundle.contextVersion
    || contextRef.catalogDigest !== bundle.catalogDigest
    || contextRef.contextDigest !== bundle.contextDigest
    || bundle.tools.some((tool) => tool.availability !== 'ready')
    || input.contextAssembly.messages.length !== (planningTarget ? 9 : 8)
    || input.contextAssembly.messages[0]?.role !== 'system'
    || input.contextAssembly.messages[0]?.content
      !== bundle.fixedPrompt
    || (
      planningTarget
      && (
        input.contextAssembly.messages.at(-1)?.role !== 'system'
        || input.contextAssembly.messages.at(-1)?.content
          !== sessionPlanningResponseContractReminderV2()
      )
    )
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

export function decodeProviderPlanningResultEnvelopeV2(
  text: string
): SessionProviderPlanningResultV2 {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw invalidPlanningResult();
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    throw invalidPlanningResult();
  }
  const record = objectRecord(value);
  if (
    record?.schemaVersion
      !== SESSION_PROVIDER_PLANNING_RESULT_V2_SCHEMA
  ) {
    throw invalidPlanningResult();
  }
  if (record.kind === 'answer') {
    exactKeys(record, ['schemaVersion', 'kind', 'text']);
    const answer = requiredText(record.text, 'text');
    if (!answer.trim()) throw invalidPlanningResult();
    return { kind: 'answer', text: answer };
  }
  if (record.kind !== 'plan') {
    throw invalidPlanningResult();
  }
  exactKeys(record, ['schemaVersion', 'kind', 'plan']);
  return {
    kind: 'plan',
    plan: decodeProviderPlanDraft(record.plan),
  };
}

function decodeProviderPlanDraft(
  value: unknown
): SessionProviderPlanDraftV2 {
  const record = objectRecord(value);
  if (!record) throw invalidPlanningResult();
  exactKeys(
    record,
    ['title', 'objective', 'narrative', 'actions']
  );
  if (!Array.isArray(record.actions)) {
    throw invalidPlanningResult();
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
  if (!record) throw invalidPlanningResult();
  exactKeys(
    record,
    [
      'toolId',
      'requestedResources',
      'previewArguments',
    ],
    ['deadline']
  );
  if (!Array.isArray(record.requestedResources)) {
    throw invalidPlanningResult();
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
  if (!tagged) throw invalidPlanningResult();
  exactKeys(tagged, ['kind', 'data']);
  const data = objectRecord(tagged.data);
  if (!data) throw invalidPlanningResult();
  switch (tagged.kind) {
    case 'workspacePath':
      exactKeys(data, ['path', 'access']);
      if (data.access !== 'read' && data.access !== 'write') {
        throw invalidPlanningResult();
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
        throw invalidPlanningResult();
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
      throw invalidPlanningResult();
  }
}

function decodeDeadline(value: unknown): DeadlineRequestV2 {
  const tagged = objectRecord(value);
  if (!tagged) throw invalidPlanningResult();
  exactKeys(tagged, ['kind', 'data']);
  const data = objectRecord(tagged.data);
  if (!data) throw invalidPlanningResult();
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
  throw invalidPlanningResult();
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
    throw invalidPlanningResult();
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
  const provider = requiredMetadataIdentity(
    result.provider,
    'provider'
  );
  const model = requiredMetadataIdentity(result.model, 'model');
  const usage = result.usage === undefined
    ? undefined
    : boundedProviderUsageRecordV2(result.usage);
  return {
    providerProfileId: expectedProfileId,
    provider,
    model,
    ...(usage ? { usage } : {}),
  };
}

function requiredMetadataIdentity(
  value: unknown,
  field: string
): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 1024
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_result_metadata_invalid',
      `Provider result ${field} is missing or invalid.`
    );
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
    throw invalidPlanningResult();
  }
  return text;
}

function requiredText(value: unknown, _field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || new TextEncoder().encode(value).byteLength > 64 * 1024
  ) {
    throw invalidPlanningResult();
  }
  return value;
}

function invalidPlanningResult(): SessionKernelProviderTransportError {
  return new SessionKernelProviderTransportError(
    'session_kernel_provider_planning_result_invalid',
    'Planning response must be one exact deepcode.session.planning-result.v2 envelope.'
  );
}
