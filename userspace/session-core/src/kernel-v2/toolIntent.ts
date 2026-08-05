import {
  decodeRawToolArgumentsV2,
  type RawToolArgumentsV2,
  type ToolContextBundleV2,
  type ToolIntentAuthorityV2,
  type ToolIntentV2,
} from '@deepcode/protocol';
import { assertProviderSafeToolContextV2, toolContextRefV2 } from './toolContext.js';

export interface ProviderNativeKernelToolCallV2 {
  source: 'providerNative';
  callId: string;
  toolId: string;
  arguments: unknown;
}

export type ProviderKernelToolSourceV2 =
  ProviderNativeKernelToolCallV2;

export interface SessionToolIntentBindingV2 {
  runId: string;
  controlEpoch: number;
  operationId: string;
  authority: ToolIntentAuthorityV2;
  idempotencyKey: string;
  toolContext: ToolContextBundleV2;
  deadline?: ToolIntentV2['deadline'];
}

/**
 * Converts only provider-native calls into ToolIntent. Natural-language or
 * JSON-shaped assistant text is never executable control data.
 */
export function normalizeProviderKernelToolIntentV2(
  source: ProviderKernelToolSourceV2,
  binding: SessionToolIntentBindingV2
): ToolIntentV2 {
  assertProviderSafeToolContextV2(binding.toolContext);
  const proposal = {
    toolId: requiredToolId(source.toolId),
    arguments: decodeProviderArguments(source.arguments),
  };
  const descriptor = binding.toolContext.tools.find(
    (tool) => tool.toolId === proposal.toolId
  );
  if (!descriptor || descriptor.availability !== 'ready') {
    throw new SessionToolIntentError(
      'session_tool_intent_unavailable',
      `Provider requested a tool outside the current ready ToolContext: ${proposal.toolId}.`
    );
  }
  if (!binding.runId || !binding.operationId || !binding.idempotencyKey) {
    throw new SessionToolIntentError(
      'session_tool_intent_binding_invalid',
      'Session ToolIntent identity binding is incomplete.'
    );
  }
  if (!Number.isSafeInteger(binding.controlEpoch) || binding.controlEpoch <= 0) {
    throw new SessionToolIntentError(
      'session_tool_intent_epoch_invalid',
      'Session ToolIntent control epoch must be a positive safe integer.'
    );
  }
  return {
    runId: binding.runId,
    expectedControlEpoch: binding.controlEpoch,
    operationId: binding.operationId,
    toolId: proposal.toolId,
    rawArguments: proposal.arguments,
    authority: binding.authority,
    idempotencyKey: binding.idempotencyKey,
    deadline: binding.deadline ?? {
      kind: 'contractDefault',
      data: {},
    },
    toolContextRef: toolContextRefV2(binding.toolContext),
  };
}

function decodeProviderArguments(value: unknown): RawToolArgumentsV2 {
  if (typeof value !== 'string') return decodeRawToolArgumentsV2(value);
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new SessionToolIntentError(
      'session_tool_intent_arguments_invalid_json',
      'Provider-native tool arguments are not valid JSON.'
    );
  }
  return decodeRawToolArgumentsV2(decoded);
}

function requiredToolId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(value)
  ) {
    throw new SessionToolIntentError(
      'session_tool_intent_tool_id_invalid',
      'ToolIntent toolId must be a lowercase namespaced identity.'
    );
  }
  return value;
}

export class SessionToolIntentError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionToolIntentError';
  }
}
