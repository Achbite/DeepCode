import type {
  ContextCompositionTool,
  JsonObject,
  ModelMessage,
  PreparedToolDescriptor,
  ProviderToolAlias,
  ProviderToolDefinition,
  RunRuntimeSnapshot,
  SessionEvent,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import { SESSION_CONTROL_PLAN_PUBLISH } from '@deepcode/protocol';
import { LoopFailure } from './loopFailure.js';

const PROVIDER_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CANONICAL_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const HASH_SUFFIX_LENGTH = 10;
export const CORE_TOOL_ORDER = [
  'fs.read',
  'fs.write',
  'fs.edit',
  'fs.delete',
  'bash',
  'web.search',
  'web.fetch',
  'session.read',
  'skill.read',
] as const;

export interface ProviderToolCodec {
  definitions: readonly ProviderToolDefinition[];
  kernelDefinitions: readonly ProviderToolDefinition[];
  controlDefinitions: readonly ProviderToolDefinition[];
  canonicalByWire: ReadonlyMap<string, string>;
  wireByCanonical: ReadonlyMap<string, string>;
  workspaceIdByHandle: ReadonlyMap<string, string>;
  workspaceHandleById: ReadonlyMap<string, string>;
  workspaceToolNames: ReadonlySet<string>;
  receiptTools: readonly ContextCompositionTool[];
}

interface ProviderMessageToolCodec {
  wireByCanonical: ReadonlyMap<string, string>;
  workspaceIdByHandle: ReadonlyMap<string, string>;
  workspaceHandleById: ReadonlyMap<string, string>;
  workspaceToolNames: ReadonlySet<string>;
}

export function createProviderToolAliases(
  canonicalNames: readonly string[],
): ProviderToolAlias[] {
  const names = [...new Set(canonicalNames)]
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const name of names) {
    if (!CANONICAL_TOOL_NAME_PATTERN.test(name)) {
      throw new LoopFailure('provider_tool_name_invalid', `Canonical 工具名称无效：${name}`);
    }
  }

  const baseGroups = new Map<string, string[]>();
  for (const name of names) {
    const base = readableWireBase(name);
    baseGroups.set(base, [...(baseGroups.get(base) ?? []), name]);
  }

  const seenWireNames = new Map<string, string>();
  return names.map((canonicalName) => {
    const base = readableWireBase(canonicalName);
    const collides = (baseGroups.get(base)?.length ?? 0) > 1;
    const needsSuffix = collides || base.length > 64;
    const wireName = needsSuffix
      ? `${base.slice(0, 64 - HASH_SUFFIX_LENGTH - 1)}_${shortNameHash(canonicalName)}`
      : base;
    if (!PROVIDER_TOOL_NAME_PATTERN.test(wireName)) {
      throw new LoopFailure(
        'provider_tool_alias_invalid',
        `Provider tool alias 无效：${canonicalName} -> ${wireName}`,
      );
    }
    const existing = seenWireNames.get(wireName);
    if (existing !== undefined) {
      throw new LoopFailure(
        'provider_tool_alias_conflict',
        `Provider tool alias 冲突：${existing} / ${canonicalName}`,
      );
    }
    seenWireNames.set(wireName, canonicalName);
    return { canonicalName, wireName };
  });
}

export function providerWireName(
  runtime: RunRuntimeSnapshot,
  canonicalName: string,
): string {
  const alias = runtime.providerToolAliases.find((candidate) => (
    candidate.canonicalName === canonicalName
  ));
  if (!alias) {
    throw new LoopFailure(
      'provider_tool_alias_missing',
      `当前 run 缺少 Provider tool alias：${canonicalName}`,
    );
  }
  return alias.wireName;
}

export function createProviderToolCodec(
  runtimeTools: readonly PreparedToolDescriptor[],
  controls: readonly ProviderToolDefinition[],
  aliases: readonly ProviderToolAlias[],
  workspaceBindings: readonly WorkspaceBindingDisplay[],
): ProviderToolCodec {
  const workspaceToolNames = new Set(runtimeTools
    .filter(isWorkspaceScopedTool)
    .map((tool) => tool.name));
  const callableKernel = runtimeTools.filter((tool) => tool.availability === 'callable');
  const byName = new Map(callableKernel.map((tool) => [tool.name, tool]));
  const core = CORE_TOOL_ORDER.flatMap((name) => {
    const tool = byName.get(name);
    if (!tool) return [];
    if (tool.origin !== 'coreBuiltin') {
      throw new LoopFailure('core_tool_origin_invalid', `基础工具来源无效：${name}`);
    }
    return [freezeProviderToolDefinition(tool, workspaceToolNames.has(tool.name))];
  });
  const plugin = callableKernel
    .filter((tool) => !CORE_TOOL_ORDER.includes(tool.name as typeof CORE_TOOL_ORDER[number]))
    .map((tool) => {
      if (tool.origin !== 'extension' || !tool.pluginUri) {
        throw new LoopFailure('plugin_tool_origin_invalid', `插件工具来源无效：${tool.name}`);
      }
      return tool;
    })
    .sort((left, right) => (
      left.pluginUri!.localeCompare(right.pluginUri!, 'en')
      || left.name.localeCompare(right.name, 'en')
    ))
    .map((tool) => freezeProviderToolDefinition(tool, workspaceToolNames.has(tool.name)));
  const kernel = [...core, ...plugin];
  const control = controls
    .map((tool) => freezeProviderToolDefinition(tool))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const workspaceIdByHandle = new Map<string, string>();
  const workspaceHandleById = new Map<string, string>();
  workspaceBindings.forEach((binding, index) => {
    const handle = index === 0 ? 'primary' : `workspace${index + 1}`;
    workspaceIdByHandle.set(handle, binding.workspaceId);
    workspaceHandleById.set(binding.workspaceId, handle);
  });
  const canonical = [...core, ...control, ...plugin];
  const callableNames = new Set<string>();
  for (const tool of canonical) {
    if (callableNames.has(tool.name)) {
      throw new LoopFailure('provider_tool_name_conflict', `Provider 工具名称冲突：${tool.name}`);
    }
    callableNames.add(tool.name);
  }

  const canonicalByWire = new Map<string, string>();
  const wireByCanonical = new Map<string, string>();
  for (const alias of aliases) {
    if (
      !CANONICAL_TOOL_NAME_PATTERN.test(alias.canonicalName)
      || !PROVIDER_TOOL_NAME_PATTERN.test(alias.wireName)
      || wireByCanonical.has(alias.canonicalName)
      || canonicalByWire.has(alias.wireName)
    ) {
      throw new LoopFailure(
        'provider_tool_alias_snapshot_invalid',
        'Run 固定的 Provider tool alias 映射无效。',
      );
    }
    wireByCanonical.set(alias.canonicalName, alias.wireName);
    if (callableNames.has(alias.canonicalName)) {
      canonicalByWire.set(alias.wireName, alias.canonicalName);
    }
  }
  for (const name of callableNames) {
    if (!wireByCanonical.has(name)) {
      throw new LoopFailure(
        'provider_tool_alias_missing',
        `当前 run 固定的 Provider tool alias 映射缺少：${name}`,
      );
    }
  }

  const encoded = new Map<string, ProviderToolDefinition>();
  for (const tool of canonical) {
    encoded.set(tool.name, Object.freeze({
      ...tool,
      name: wireByCanonical.get(tool.name)!,
    }));
  }
  const encodedFor = (tools: readonly ProviderToolDefinition[]) => Object.freeze(
    tools.map((tool) => encoded.get(tool.name)!),
  );
  const receiptTools = Object.freeze(canonical.map((tool): ContextCompositionTool => {
    const wireName = wireByCanonical.get(tool.name)!;
    const runtimeTool = byName.get(tool.name);
    return Object.freeze({
      itemId: tool.name,
      label: wireName,
      canonicalName: tool.name,
      wireName,
      origin: runtimeTool?.origin ?? 'sessionControl',
      availability: runtimeTool?.availability ?? 'callable',
      ...(runtimeTool?.pluginUri ? { pluginUri: runtimeTool.pluginUri } : {}),
    });
  }));
  return Object.freeze({
    definitions: encodedFor(canonical),
    kernelDefinitions: encodedFor(kernel),
    controlDefinitions: encodedFor(control),
    canonicalByWire,
    wireByCanonical,
    workspaceIdByHandle,
    workspaceHandleById,
    workspaceToolNames,
    receiptTools,
  });
}

export function providerWorkspaceBindings(
  bindings: readonly WorkspaceBindingDisplay[],
): Array<{ handle: string; displayName: string }> {
  return bindings.map((binding, index) => ({
    handle: index === 0 ? 'primary' : `workspace${index + 1}`,
    displayName: binding.displayName,
  }));
}

export function decodeProviderToolInput(
  codec: ProviderToolCodec,
  canonicalName: string,
  input: JsonObject,
): JsonObject {
  const decoded = structuredClone(input);
  if (codec.workspaceToolNames.has(canonicalName)) {
    return decodeWorkspaceHandle(codec, decoded);
  }
  if (canonicalName === SESSION_CONTROL_PLAN_PUBLISH) {
    const manifest = decoded.mutationManifest;
    if (!Array.isArray(manifest)) return decoded;
    decoded.mutationManifest = manifest.map((operation) => {
      if (!isRecord(operation)) return operation;
      return decodeWorkspaceHandle(codec, structuredClone(operation));
    });
  }
  return decoded;
}

export function encodeProviderMessage(
  message: ModelMessage,
  codec: ProviderToolCodec,
  journalCodecsByCallId: ReadonlyMap<string, ProviderMessageToolCodec> = new Map(),
): ModelMessage {
  const encoded = cloneModelMessage(message);
  if (!encoded.toolCalls) return encoded;
  encoded.toolCalls = encoded.toolCalls.map((call) => {
    const callCodec = journalCodecsByCallId.get(call.callId) ?? codec;
    const wire = callCodec.wireByCanonical.get(call.name);
    if (!wire) {
      throw new LoopFailure(
        'provider_tool_continuation_unknown',
        `工具调用缺少所属 run 的固定 Provider alias：${call.name}`,
      );
    }
    return {
      ...call,
      name: wire,
      input: typeof call.input === 'string' ? call.input : encodeProviderToolInput(callCodec, call.name, call.input),
    };
  });
  return encoded;
}

/** Reconstructs each journal call with the immutable alias and workspace handles of its owner run. */
export function providerMessageCodecsByCallId(
  events: readonly SessionEvent[],
): ReadonlyMap<string, ProviderMessageToolCodec> {
  const codecsByRunId = new Map<string, ProviderMessageToolCodec>();
  for (const event of events) {
    if (event.type !== 'run.started') continue;
    const wireByCanonical = new Map(event.payload.runtimeSnapshot.providerToolAliases.map((alias) => (
      [alias.canonicalName, alias.wireName]
    )));
    const workspaceIdByHandle = new Map<string, string>();
    const workspaceHandleById = new Map<string, string>();
    event.payload.workspaceBindings.forEach((binding, index) => {
      const handle = index === 0 ? 'primary' : `workspace${index + 1}`;
      workspaceIdByHandle.set(handle, binding.workspaceId);
      workspaceHandleById.set(binding.workspaceId, handle);
    });
    codecsByRunId.set(event.runId, {
      wireByCanonical,
      workspaceIdByHandle,
      workspaceHandleById,
      workspaceToolNames: new Set(event.payload.runtimeSnapshot.tools
        .filter(isWorkspaceScopedTool)
        .map((tool) => tool.name)),
    });
  }

  const result = new Map<string, ProviderMessageToolCodec>();
  for (const event of events) {
    const callIds = event.type === 'provider.turn.settled' && event.payload.outcome === 'completed'
      ? (event.payload.toolCallInputs ?? []).map((call) => call.callId)
      : 'callId' in event && event.callId ? [event.callId] : [];
    if (!callIds.length || !('runId' in event) || !event.runId) continue;
    const ownerCodec = codecsByRunId.get(event.runId);
    if (!ownerCodec) {
      throw new LoopFailure(
        'provider_tool_call_runtime_missing',
        `工具调用缺少所属 run runtime snapshot：${event.runId}`,
      );
    }
    for (const callId of callIds) {
      const existing = result.get(callId);
      if (existing && existing !== ownerCodec) {
        throw new LoopFailure(
          'provider_tool_call_runtime_conflict',
          `LogicalCallId 关联了多个 run runtime snapshot：${callId}`,
        );
      }
      result.set(callId, ownerCodec);
    }
  }
  return result;
}

export function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(canonicalJsonValue));
  if (!isRecord(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, canonicalJsonValue(value[key])]),
  ));
}

function readableWireBase(canonical: string): string {
  return canonical.replace(/[.-]/gu, '_');
}

function shortNameHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul((left ^ code) >>> 0, 0x01000193) >>> 0;
    right = Math.imul((right ^ code ^ index) >>> 0, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`
    .slice(0, HASH_SUFFIX_LENGTH);
}

function freezeProviderToolDefinition(
  tool: Pick<ProviderToolDefinition, 'name' | 'description' | 'inputSchema'>,
  workspaceScoped = false,
): ProviderToolDefinition {
  const inputSchema = workspaceScoped
    ? providerWorkspaceSchema(tool.name, tool.inputSchema)
    : tool.inputSchema;
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: canonicalJsonValue(inputSchema) as Record<string, unknown>,
  });
}

function providerWorkspaceSchema(toolName: string, schema: JsonObject): JsonObject {
  const copy = structuredClone(schema);
  if (
    copy.type !== 'object'
    || !isRecord(copy.properties)
    || !Array.isArray(copy.required)
    || 'workspace' in copy.properties
    || 'workspaceId' in copy.properties
  ) {
    throw new LoopFailure(
      'provider_workspace_schema_invalid',
      `Workspace 工具 schema 无法加入逻辑 handle：${toolName}`,
    );
  }
  copy.properties.workspace = {
    type: 'string',
    minLength: 1,
    description: 'Logical workspace handle from the current Session binding list, such as primary.',
  };
  copy.required = [...copy.required, 'workspace'];
  return copy;
}

function decodeWorkspaceHandle(
  codec: ProviderToolCodec,
  input: JsonObject,
): JsonObject {
  if ('workspaceId' in input) {
    throw new LoopFailure(
      'provider_workspace_identity_forbidden',
      'Provider 工具输入不能直接携带 canonical workspaceId。',
    );
  }
  const handle = input.workspace;
  if (typeof handle !== 'string' || !handle) {
    throw new LoopFailure(
      'provider_workspace_handle_required',
      'Workspace 工具必须携带当前 Session 的逻辑 workspace handle。',
    );
  }
  const workspaceId = codec.workspaceIdByHandle.get(handle);
  if (!workspaceId) {
    throw new LoopFailure(
      'provider_workspace_handle_not_bound',
      `逻辑 workspace handle 不属于当前 run：${handle}`,
    );
  }
  delete input.workspace;
  input.workspaceId = workspaceId;
  return input;
}

function encodeProviderToolInput(
  codec: ProviderMessageToolCodec,
  canonicalName: string,
  input: JsonObject,
): JsonObject {
  const encoded = structuredClone(input);
  if (codec.workspaceToolNames.has(canonicalName)) {
    return encodeWorkspaceIdentity(codec, encoded);
  }
  if (canonicalName === SESSION_CONTROL_PLAN_PUBLISH) {
    const manifest = encoded.mutationManifest;
    if (!Array.isArray(manifest)) return encoded;
    encoded.mutationManifest = manifest.map((operation) => {
      if (!isRecord(operation)) return operation;
      return encodeWorkspaceIdentity(codec, structuredClone(operation));
    });
  }
  return encoded;
}

function encodeWorkspaceIdentity(
  codec: ProviderMessageToolCodec,
  input: JsonObject,
): JsonObject {
  const workspaceId = input.workspaceId;
  if (typeof workspaceId !== 'string') return input;
  delete input.workspaceId;
  input.workspace = codec.workspaceHandleById.get(workspaceId) ?? 'unavailable';
  return input;
}

function isWorkspaceScopedTool(tool: PreparedToolDescriptor): boolean {
  return tool.possibleEffects.some((effect) => (
    effect === 'workspaceRead'
    || effect === 'workspaceMutation'
    || effect === 'process'
  ));
}

function cloneModelMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            input: structuredClone(call.input),
          })),
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
