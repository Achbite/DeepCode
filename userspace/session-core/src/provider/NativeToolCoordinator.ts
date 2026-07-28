import type {
  KernelToolCatalogSnapshot,
  KernelToolCatalogTool,
  LlmChatResult,
  ToolCall,
  ToolDefinition,
} from '@deepcode/protocol';
import { stableHash } from '../cache/canonicalizer.js';
import type {
  ConversationResourceRoot,
  ResourceManifest,
  ResourceManifestEntry,
  ResourcePacket,
} from '../context/types.js';
import { ResourceRequestResolver } from '../resources/index.js';
import type { NativeToolCallProposal } from './providerStreamParts.js';

export interface NativeToolReadSignature {
  key: string;
  toolName: string;
  path: string;
  rootId?: string;
  offsetBytes?: number;
  limitBytes?: number;
}

export interface NativeToolReadLedgerEntry {
  signature: NativeToolReadSignature;
  packet: ResourcePacket;
  contentHash: string;
  repeatCount: number;
}

interface NativeToolStateContract {
  allowedProposals?: string[];
  toolCatalogSnapshot?: KernelToolCatalogSnapshot;
}

interface NativeToolDriverRequest {
  stateContract?: NativeToolStateContract;
}

export interface NativeToolCoordinatorState {
  stateContract?: NativeToolStateContract;
  driverRequest?: NativeToolDriverRequest;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
}

interface NativeToolCallBuffer {
  toToolCalls(): NativeToolCallProposal[];
}

const PROVIDER_RESERVED_CONTROL_TOKEN = '<｜end▁of▁thinking｜>';

export class NativeToolCoordinatorError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'NativeToolCoordinatorError';
  }
}

export class NativeToolCoordinator {
  collectCalls(
    result: LlmChatResult,
    buffer: NativeToolCallBuffer
  ): NativeToolCallProposal[] {
    const output = new Map<string, NativeToolCallProposal>();
    const add = (toolCall: ToolCall, index: number) => {
      const callId = toolCall.id || `tool-call-${index}`;
      output.set(callId, {
        callId,
        index,
        name: this.normalizeToolName(toolCall.name),
        arguments: this.normalizeArguments(toolCall.arguments, toolCall.name),
        rawArguments: typeof toolCall.arguments === 'string' ? toolCall.arguments : undefined,
      });
    };
    result.assistantMessage?.toolCalls?.forEach(add);
    result.chunks.forEach((chunk, index) => {
      if (chunk.toolCall) add(chunk.toolCall, typeof chunk.index === 'number' ? chunk.index : index);
    });
    for (const toolCall of buffer.toToolCalls()) {
      output.set(toolCall.callId, toolCall);
    }
    return [...output.values()].sort((left, right) => left.index - right.index);
  }

  parseArguments(raw: string, toolName: string): Record<string, unknown> {
    const text = raw.trim();
    if (!text) return {};
    this.assertNoReservedProviderControl(text, toolName);
    try {
      const parsed = JSON.parse(text) as unknown;
      return this.normalizeArguments(parsed, toolName);
    } catch (error) {
      if (error instanceof NativeToolCoordinatorError) throw error;
      throw new NativeToolCoordinatorError(
        'native_tool_arguments_invalid',
        `Provider-native tool call ${toolName} returned invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  normalizeArguments(value: unknown, toolName: string): Record<string, unknown> {
    if (typeof value === 'string') return this.parseArguments(value, toolName);
    this.assertNoReservedProviderControl(value, toolName);
    const record = objectRecord(value);
    if (!record) {
      throw new NativeToolCoordinatorError(
        'native_tool_arguments_invalid',
        `Provider-native tool call ${toolName} arguments must be a JSON object.`
      );
    }
    return record;
  }

  private assertNoReservedProviderControl(value: unknown, toolName: string): void {
    if (!containsReservedProviderControl(value)) return;
    throw new NativeToolCoordinatorError(
      'provider_reserved_token_invalid',
      `Provider-native tool call ${toolName} contains a reserved Provider control token. The arguments were preserved unchanged and rejected before semantic admission.`
    );
  }

  normalizeToolName(name: string): string {
    return name.replace(/__/g, '.');
  }

  callToProtocol(toolCall: NativeToolCallProposal): ToolCall {
    return {
      id: toolCall.callId,
      name: toolCall.name,
      arguments: toolCall.arguments,
    };
  }

  toolCatalogSummary(state: NativeToolCoordinatorState): string {
    const snapshot = this.toolCatalogSnapshot(state);
    if (snapshot?.tools?.length) {
      const lines = snapshot.tools
        .filter((tool) => tool.providerVisible !== false || tool.executionMode !== 'execute')
        .slice()
        .sort((left, right) => left.toolId.localeCompare(right.toolId))
        .map((tool) => {
          const kind = tool.operationKind ? ` kind=${tool.operationKind}` : '';
          const executionSummary = tool.executionMode === 'execute'
            ? 'executable after Kernel admission and gate evaluation'
            : 'not executable in this catalog version';
          const providerCallable = tool.providerVisible !== false && tool.executionMode === 'execute';
          return [
            `- toolId=${tool.toolId}${kind}`,
            `executionMode=${tool.executionMode} (${executionSummary})`,
            `providerCallable=${providerCallable}`,
            `permissionMode=${tool.permissionMode}`,
            `risk=${tool.risk}`,
            `pathScope=${tool.pathScopePolicy}`,
            `targetExistence=${tool.usageConstraints.targetExistence}`,
            `targetKinds=${tool.usageConstraints.targetKinds?.join(',') || 'any'}`,
            `contentMode=${tool.usageConstraints.contentMode}`,
            `planningArgsSchema=${JSON.stringify(tool.planningSchema ?? {})}`,
            tool.usageConstraints.directoryRecursiveRequired ? 'directoryRecursiveRequired=true' : '',
            tool.permissionSummary ? `permissionSummary=${oneLine(tool.permissionSummary)}` : '',
            tool.hardDenyRules?.length ? `hardDenyRules=${tool.hardDenyRules.map(oneLine).join(' | ')}` : '',
          ].filter(Boolean).join('; ');
        });
      return [
        `KernelToolCatalog ${snapshot.catalogVersion} hash=${snapshot.catalogHash}`,
        ...lines,
        'Planning rule: use only toolIds listed above. Never infer aliases or availability from memory.',
        'Every taskPlan task must include args. Use {} when planningArgsSchema has no properties.',
        'providerCallable=false or executionMode=blocked/previewOnly means the tool is known but unavailable for executable actions.',
        'Kernel derives capability, risk, permission, resource sets, and execution facts from the selected tool contract and typed args.',
      ].join('\n');
    }
    return [
      'KernelToolCatalog unavailable.',
      'Do not invent toolIds or infer tools from capability names, memory, examples, or prior sessions.',
      'Use the registered Session diagnostic directive to report that planning cannot safely continue.',
    ].join('\n');
  }

  providerTools(state: NativeToolCoordinatorState): ToolDefinition[] {
    const allowed = state.stateContract?.allowedProposals
      ?? state.driverRequest?.stateContract?.allowedProposals
      ?? [];
    const allowResources = allowed.length === 0 || allowed.includes('resourceRequest') || allowed.includes('answer');
    const names = new Set<string>();
    if (allowResources) {
      names.add('fs.read');
      names.add('fs.list');
    }
    if (names.size === 0) return [];
    return this.catalogProviderTools(state, names);
  }

  canResolveReadOnly(toolCall: NativeToolCallProposal): boolean {
    return toolCall.name === 'fs.read' || toolCall.name === 'fs.list';
  }

  readSignature(toolCall: NativeToolCallProposal): NativeToolReadSignature {
    const path = stringValue(toolCall.arguments.path)
      ?? stringValue(toolCall.arguments.resourceRef)
      ?? '.';
    const rootId = stringValue(toolCall.arguments.rootId);
    const offsetBytes = normalizedNonNegativeInteger(toolCall.arguments.offsetBytes);
    const limitBytes = normalizedPositiveInteger(toolCall.arguments.limitBytes);
    const key = stableHash(JSON.stringify({
      toolName: toolCall.name,
      rootId: rootId ?? '',
      path,
      offsetBytes: typeof offsetBytes === 'number' ? offsetBytes : null,
      limitBytes: typeof limitBytes === 'number' ? limitBytes : null,
    }));
    return {
      key,
      toolName: toolCall.name,
      path,
      ...(rootId ? { rootId } : {}),
      ...(typeof offsetBytes === 'number' ? { offsetBytes } : {}),
      ...(typeof limitBytes === 'number' ? { limitBytes } : {}),
    };
  }

  readManifest(state: NativeToolCoordinatorState, toolCall: NativeToolCallProposal): ResourceManifest {
    const requestedPath = stringValue(toolCall.arguments.path)
      ?? stringValue(toolCall.arguments.resourceRef)
      ?? '.';
    const itemId = `native-${sanitizeId(toolCall.callId)}`;
    const kind: ResourceManifestEntry['kind'] = toolCall.name === 'fs.list' ? 'directory' : 'file';
    const synthesized = new ResourceRequestResolver().synthesizeEntryForPath(
      state.manifest,
      state.conversationRoots,
      itemId,
      requestedPath,
      stringValue(toolCall.arguments.rootId),
      `Provider-native ${toolCall.name} request normalized by Session.`
    );
    const baseEntry: ResourceManifestEntry = synthesized.kind === 'entry'
      ? { ...synthesized.entry, kind }
      : {
          id: itemId,
          kind,
          label: `${toolCall.name} ${requestedPath}`,
          resourceRef: requestedPath,
          readPolicy: 'autoRead',
          reason: `Provider-native ${toolCall.name} request normalized by Session.`,
        };
    const offsetBytes = normalizedNonNegativeInteger(toolCall.arguments.offsetBytes);
    const limitBytes = normalizedPositiveInteger(toolCall.arguments.limitBytes);
    const entry: ResourceManifestEntry = {
      ...baseEntry,
      id: itemId,
      ...(typeof offsetBytes === 'number' ? { offsetBytes } : {}),
      ...(typeof limitBytes === 'number' ? { limitBytes } : {}),
    };
    return {
      ...state.manifest,
      id: `${state.manifest.id}-${itemId}`,
      entries: [entry],
    };
  }

  packetContentHash(packet: ResourcePacket): string {
    return stableHash(JSON.stringify(packet.items.map((item) => ({
      status: item.status,
      path: item.path,
      absolutePath: item.absolutePath,
      contentKind: item.contentKind,
      promptContent: item.promptContent,
      contentSummary: item.contentSummary,
      truncated: item.truncated,
      originalBytes: item.originalBytes,
      returnedBytes: item.returnedBytes,
      matches: item.matches,
    }))));
  }

  resultFromPacket(
    toolCall: NativeToolCallProposal,
    packet: ResourcePacket
  ): Record<string, unknown> {
    return {
      callId: toolCall.callId,
      toolName: toolCall.name,
      ok: packet.items.every((item) => item.status !== 'error' && item.status !== 'denied'),
      packetId: packet.id,
      items: packet.items.map((item) => ({
        manifestEntryId: item.manifestEntryId,
        status: item.status,
        path: item.path,
        absolutePath: item.absolutePath,
        contentKind: item.contentKind,
        contentSummary: item.contentSummary,
        content: item.promptContent ? clip(item.promptContent, 9000) : undefined,
        truncated: item.truncated,
        originalBytes: item.originalBytes,
        returnedBytes: item.returnedBytes,
        denialReason: item.denialReason,
      })),
    };
  }

  duplicateResult(
    toolCall: NativeToolCallProposal,
    entry: NativeToolReadLedgerEntry
  ): Record<string, unknown> {
    return {
      ...this.resultFromPacket(toolCall, entry.packet),
      duplicate: true,
      duplicateOfPacketId: entry.packet.id,
      duplicateContentHash: entry.contentHash,
      duplicateCount: entry.repeatCount,
      message: 'This exact read-only native tool target/range was already resolved in this provider checkpoint. Use the returned ResourcePacket facts and output a valid proposal instead of calling the same read tool again.',
    };
  }

  private toolCatalogSnapshot(state: NativeToolCoordinatorState): KernelToolCatalogSnapshot | undefined {
    return state.stateContract?.toolCatalogSnapshot ?? state.driverRequest?.stateContract?.toolCatalogSnapshot;
  }

  private catalogProviderTools(state: NativeToolCoordinatorState, names: Set<string>): ToolDefinition[] {
    const snapshot = this.toolCatalogSnapshot(state);
    if (!snapshot?.tools?.length) {
      return [];
    }
    return snapshot.tools
      .filter((tool) => names.has(tool.toolId))
      .filter((tool) => tool.executionMode === 'execute')
      .map((tool) => this.providerToolDefinition(tool, snapshot));
  }

  private providerToolDefinition(
    tool: KernelToolCatalogTool,
    snapshot: KernelToolCatalogSnapshot
  ): ToolDefinition {
    return {
      name: tool.toolId,
      description: `Kernel tool ${tool.toolId} (${tool.capability}).`,
      inputSchema: tool.providerSchema,
      riskLevel: tool.risk === 'critical' ? 'critical' : tool.risk === 'high' ? 'high' : tool.risk === 'medium' ? 'medium' : 'low',
      needsApproval: tool.permissionMode !== 'allow',
      allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
      capability: tool.capability,
      family: tool.family,
      operationKind: tool.operationKind,
      permissionMode: tool.permissionMode,
      pathScopePolicy: tool.pathScopePolicy,
      executionMode: tool.executionMode,
      readOnly: tool.readOnly,
      catalogVersion: snapshot.catalogVersion,
      catalogHash: snapshot.catalogHash,
    };
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function containsReservedProviderControl(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(PROVIDER_RESERVED_CONTROL_TOKEN);
  if (Array.isArray(value)) return value.some(containsReservedProviderControl);
  const record = objectRecord(value);
  return record
    ? Object.entries(record).some(([key, item]) => (
      key.includes(PROVIDER_RESERVED_CONTROL_TOKEN)
      || containsReservedProviderControl(item)
    ))
    : false;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

function normalizedPositiveInteger(value: unknown): number | undefined {
  const integer = normalizedNonNegativeInteger(value);
  return typeof integer === 'number' && integer > 0 ? integer : undefined;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'resource';
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}... [truncated]`;
}
