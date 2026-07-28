import {
  decodeRawToolArgumentsV2,
  type RawToolArgumentsV2,
  type ToolContextBundleV2,
  type ToolIntentAuthorityV2,
  type ToolIntentV2,
} from '@deepcode/protocol';
import { assertProviderSafeToolContextV2, toolContextRefV2 } from './toolContext.js';

export const SESSION_TOOL_INTENT_TEXT_FRAME_V2 =
  'deepcode.session.tool-intent-frame.v2' as const;

export interface ProviderNativeKernelToolCallV2 {
  source: 'providerNative';
  callId: string;
  toolId: string;
  arguments: unknown;
}

export interface ProviderTextKernelToolFrameV2 {
  source: 'textFrame';
  frame: string;
}

export type ProviderKernelToolSourceV2 =
  | ProviderNativeKernelToolCallV2
  | ProviderTextKernelToolFrameV2;

export interface SessionToolIntentBindingV2 {
  runId: string;
  controlEpoch: number;
  operationId: string;
  authority: ToolIntentAuthorityV2;
  idempotencyKey: string;
  toolContext: ToolContextBundleV2;
  deadline?: ToolIntentV2['deadline'];
}

interface DecodedProviderToolIntentFrameV2 {
  schemaVersion: typeof SESSION_TOOL_INTENT_TEXT_FRAME_V2;
  kind: 'toolIntent';
  toolId: string;
  arguments: RawToolArgumentsV2;
}

/**
 * Converts only provider-native calls or an exact standalone structured frame
 * into ToolIntent. It never scans narration for JSON, tags, names, or paths.
 */
export function normalizeProviderKernelToolIntentV2(
  source: ProviderKernelToolSourceV2,
  binding: SessionToolIntentBindingV2
): ToolIntentV2 {
  assertProviderSafeToolContextV2(binding.toolContext);
  const proposal = source.source === 'providerNative'
    ? {
        toolId: requiredToolId(source.toolId),
        arguments: decodeProviderArguments(source.arguments),
      }
    : decodeProviderToolIntentTextFrameV2(source.frame);
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

/**
 * Text-frame support is deliberately all-or-nothing JSON. Markdown fences,
 * leading narration, trailing narration, and embedded objects are rejected.
 */
export function decodeProviderToolIntentTextFrameV2(
  rawFrame: string
): DecodedProviderToolIntentFrameV2 {
  const trimmed = rawFrame.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new SessionToolIntentError(
      'session_tool_intent_text_not_structured',
      'A text ToolIntent must be a standalone JSON frame.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SessionToolIntentError(
      'session_tool_intent_text_invalid_json',
      'The standalone text ToolIntent is not valid JSON.'
    );
  }
  const frame = exactObject(
    parsed,
    ['schemaVersion', 'kind', 'toolId', 'arguments'],
    'text ToolIntent frame'
  );
  if (frame.schemaVersion !== SESSION_TOOL_INTENT_TEXT_FRAME_V2) {
    throw new SessionToolIntentError(
      'session_tool_intent_text_version_unsupported',
      'The text ToolIntent frame version is unsupported.'
    );
  }
  if (frame.kind !== 'toolIntent') {
    throw new SessionToolIntentError(
      'session_tool_intent_text_kind_invalid',
      'The text ToolIntent frame kind must be toolIntent.'
    );
  }
  return {
    schemaVersion: SESSION_TOOL_INTENT_TEXT_FRAME_V2,
    kind: 'toolIntent',
    toolId: requiredToolId(frame.toolId),
    arguments: decodeRawToolArgumentsV2(frame.arguments),
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

function exactObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionToolIntentError(
      'session_tool_intent_frame_invalid',
      `${label} must be an object.`
    );
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter(
    (key) => !allowedKeys.includes(key)
  );
  const missing = allowedKeys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key)
  );
  if (unexpected.length > 0 || missing.length > 0) {
    throw new SessionToolIntentError(
      'session_tool_intent_frame_invalid',
      `${label} has an invalid field set.`
    );
  }
  return record;
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
