import type {
  KernelToolCatalogSnapshot,
  KernelToolCatalogTool,
  ToolCall,
  ToolDefinition,
} from '@deepcode/protocol';
import { listDefaultAgentTools } from '@deepcode/protocol';
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
  capabilityProjection?: string[];
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

export class NativeToolCoordinator {
  callToProtocol(toolCall: NativeToolCallProposal): ToolCall {
    return {
      id: toolCall.callId,
      name: toolCall.name,
      arguments: toolCall.arguments,
    };
  }

  capabilityCatalogSummary(state: NativeToolCoordinatorState): string {
    const snapshot = this.toolCatalogSnapshot(state);
    if (snapshot?.tools?.length) {
      const lines = snapshot.tools
        .slice()
        .sort((left, right) => left.toolId.localeCompare(right.toolId))
        .map((tool) => {
          const kind = tool.operationKind ? ` kind=${tool.operationKind}` : '';
          return `- ${tool.toolId}: capability=${tool.capability}${kind} risk=${tool.risk} permission=${tool.permissionMode} pathScope=${tool.pathScopePolicy}`;
        });
      return [
        `KernelToolCatalog ${snapshot.catalogVersion} hash=${snapshot.catalogHash}`,
        ...lines,
        'Use Kernel capabilities in actionBundle. Executor tool names are runtime facts, not permission grants.',
      ].join('\n');
    }
    const capabilities = state.stateContract?.capabilityProjection
      ?? state.driverRequest?.stateContract?.capabilityProjection
      ?? [];
    return capabilities.join('\n');
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
      return listDefaultAgentTools('askBeforeWrite').filter((tool) => names.has(tool.name));
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
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
