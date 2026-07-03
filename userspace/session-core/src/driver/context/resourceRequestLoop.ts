import type {
  AgentConversationActivity,
  AgentEvent,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type {
  ResourceManifest,
  ResourcePacket,
  ResourcePacketItem,
} from '../../context/types.js';
import type { ResourceRequestResolution } from '../../resources/ResourceRequestResolver.js';

export interface ResourceRequestLoopOptions {
  maxDerivedManifestEntries?: number;
}

export interface ResourceRequestLoopState {
  sessionId: string;
  runId: string;
}

export interface ResourceRequestLoopResolvePorts {
  kernelCommand(request: KernelCommandEnvelope): Promise<KernelReply>;
  createId(prefix: string): string;
}

export interface ResourceRequestDiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export class ResourceRequestLoop {
  constructor(private readonly options: ResourceRequestLoopOptions = {}) {}

  async resolvePacket(
    state: ResourceRequestLoopState,
    manifest: ResourceManifest,
    ports: ResourceRequestLoopResolvePorts
  ): Promise<ResourcePacket | undefined> {
    const reply = await ports.kernelCommand({
      command: {
        kind: 'resourceResolve',
        requestId: ports.createId('resource-resolve'),
        runId: state.runId,
        sessionId: state.sessionId,
        request: { manifest },
      },
    });
    return this.findPacket(reply.events);
  }

  resolutionDiagnostic(resolution: ResourceRequestResolution): ResourceRequestDiagnosticInfo {
    const unresolved = resolution.unresolved.join('; ');
    const ambiguous = resolution.ambiguous.join('; ');
    const roots = resolution.availableRoots.length
      ? resolution.availableRoots.map((root) => `${root.rootId} -> ${root.displayPath}`).join('\n')
      : '';
    const fallback = [
      'The requested resources could not be located in the current attachments or project directory; Session rejected the request.',
      unresolved ? `Unresolved: ${unresolved}` : '',
      ambiguous ? `Multiple candidate roots: ${ambiguous}` : '',
      'Available project/attachment roots:',
      roots || 'No available attachment or project directory.',
      'Please specify an explicit attachment, rootId, or relative path.',
    ].filter(Boolean).join('\n');
    return {
      code: 'resourceResolveFailed',
      fallback,
      params: { unresolved, ambiguous, roots },
    };
  }

  findPacket(events: unknown[]): ResourcePacket | undefined {
    for (const event of events) {
      const record = objectRecord(event);
      const payload = objectRecord(record?.payload);
      const packet = objectRecord(record?.packet) ?? objectRecord(payload?.output);
      if (!packet) continue;
      return resourcePacketFromRecord(packet, 'resource-packet');
    }
    return undefined;
  }

  recentPackets(events: unknown[], limit = 8): ResourcePacket[] {
    const packets: ResourcePacket[] = [];
    for (const event of [...events].reverse()) {
      const record = objectRecord(event);
      const payload = objectRecord(record?.payload);
      if (record?.kind !== 'tool_result' && !objectRecord(record?.packet)) continue;
      const packet = objectRecord(record?.packet) ?? objectRecord(payload?.output);
      if (!packet) continue;
      packets.push(resourcePacketFromRecord(packet, `resource-packet-${packets.length + 1}`));
      if (packets.length >= limit) break;
    }
    return packets.reverse();
  }

  packetEvent(sessionId: string, packet: ResourcePacket, ts: string, id: string): AgentEvent {
    const activity = this.packetActivity(packet, id);
    return {
      id,
      sessionId,
      ts,
      kind: 'tool_result',
      payload: {
        toolName: 'kernel.resourceResolve',
        status: packet.items.some((item) => item.status === 'error' || item.status === 'denied') ? 'error' : 'ok',
        summary: `Kernel resolved ${packet.items.length} resource item(s).`,
        output: packet,
        channel: 'tool',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity,
      },
    };
  }

  packetActivity(packet: ResourcePacket, activityId: string, runId?: string): AgentConversationActivity {
    const failed = packet.items.some((item) => item.status === 'error' || item.status === 'denied');
    const search = packet.items.some((item) => item.contentKind === 'searchResults');
    return conversationActivity({
      activityId,
      kind: search ? 'resourceSearch' : 'resourceRead',
      status: failed ? 'failed' : 'completed',
      title: search ? 'Search results resolved' : 'Resource context resolved',
      summary: `Kernel resolved ${packet.items.length} resource item(s).`,
      source: 'kernel',
      runId,
      targets: packet.items.flatMap((item) => [
        item.path,
        item.manifestEntryId,
      ]).filter((item): item is string => Boolean(item)),
      itemCount: packet.items.length,
    });
  }

  addDiscoveredManifestEntries(manifest: ResourceManifest, packet: ResourcePacket): void {
    const maxEntries = this.options.maxDerivedManifestEntries ?? 240;
    const existing = new Set(manifest.entries.map((entry) => entry.id));
    for (const item of packet.items) {
      if (manifest.entries.length >= maxEntries) return;
      if (item.contentKind !== 'directoryTree') continue;
      const raw = item as ResourcePacketItem & { nodes?: unknown; absolutePath?: string; path?: string };
      const root = typeof raw.absolutePath === 'string' ? raw.absolutePath : undefined;
      if (!root || !Array.isArray(raw.nodes)) continue;
      for (const node of flattenNodes(raw.nodes)) {
        if (manifest.entries.length >= maxEntries) return;
        const nodePath = typeof node.path === 'string' ? node.path : '';
        const nodeType = node.type === 'directory' ? 'directory' : node.type === 'file' ? 'file' : undefined;
        if (!nodePath || !nodeType) continue;
        const id = `${item.manifestEntryId}:${sanitizeId(nodePath)}`;
        if (existing.has(id)) continue;
        existing.add(id);
        manifest.entries.push({
          id,
          kind: nodeType,
          label: `${nodeType === 'directory' ? 'Directory' : 'File'} ${nodePath}`,
          resourceRef: joinFsPath(root, nodePath),
          readPolicy: 'autoRead',
          reason: `Discovered inside explicit directory attachment ${item.manifestEntryId}.`,
        });
      }
    }
  }
}

function resourcePacketFromRecord(packet: Record<string, unknown>, fallbackId: string): ResourcePacket {
  const items = Array.isArray(packet.items) ? packet.items : [];
  return {
    id: typeof packet.id === 'string' ? packet.id : fallbackId,
    workspaceScopeKey: typeof packet.workspaceScopeKey === 'string' ? packet.workspaceScopeKey : 'workspace',
    requestId: typeof packet.requestId === 'string' ? packet.requestId : 'resource-request',
    items: items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(resourcePacketItemFromKernel),
  };
}

function resourcePacketItemFromKernel(item: Record<string, unknown>): ResourcePacketItem {
  const status = item.status === 'resolved' || item.status === 'provided' || item.status === 'skipped'
    ? item.status
    : item.status === 'denied'
      ? 'denied'
      : item.status === 'needsUserApproval'
        ? 'needsUserApproval'
        : 'error';
  const nodes = Array.isArray(item.nodes) ? item.nodes : undefined;
  const content = typeof item.content === 'string'
    ? item.content
    : nodes
      ? JSON.stringify(nodes, null, 2)
      : undefined;
  const promptContent = content ?? (typeof item.promptContent === 'string' ? item.promptContent : undefined);
  return {
    ...(item as unknown as Record<string, unknown>),
    requestItemId: typeof item.requestItemId === 'string' ? item.requestItemId : 'item',
    manifestEntryId: typeof item.manifestEntryId === 'string' ? item.manifestEntryId : 'entry',
    readPolicy: 'autoRead',
    status,
    contentKind: typeof item.contentKind === 'string' ? item.contentKind as ResourcePacketItem['contentKind'] : undefined,
    contentSummary: typeof item.contentSummary === 'string' ? item.contentSummary : typeof item.message === 'string' ? item.message : undefined,
    promptContent,
    truncated: Boolean(item.truncated),
    originalBytes: typeof item.originalBytes === 'number'
      ? item.originalBytes
      : typeof item.sizeBytes === 'number'
        ? item.sizeBytes
        : undefined,
    offsetBytes: typeof item.offsetBytes === 'number' ? item.offsetBytes : undefined,
    limitBytes: typeof item.limitBytes === 'number' ? item.limitBytes : undefined,
    returnedBytes: typeof item.returnedBytes === 'number' ? item.returnedBytes : undefined,
    rangeComplete: typeof item.rangeComplete === 'boolean' ? item.rangeComplete : undefined,
    denialReason: typeof item.reason === 'string' ? item.reason : typeof item.message === 'string' ? item.message : undefined,
    skipReason: typeof item.skipReason === 'string' ? item.skipReason : undefined,
    skipMessage: typeof item.skipMessage === 'string' ? item.skipMessage : undefined,
    fileClassification: objectRecord(item.fileClassification) ?? undefined,
    evidenceRefs: Array.isArray(item.evidenceRefs)
      ? item.evidenceRefs.filter((value): value is string => typeof value === 'string')
      : [],
    sourceKind: 'kernelResource',
  };
}

function conversationActivity(input: AgentConversationActivity): AgentConversationActivity {
  return {
    ...input,
    targets: uniqueStrings(input.targets ?? []),
    actionIds: uniqueStrings(input.actionIds ?? []),
    workUnitIds: uniqueStrings(input.workUnitIds ?? []),
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function flattenNodes(nodes: unknown[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  const stack = nodes.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  while (stack.length) {
    const node = stack.shift()!;
    output.push(node);
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child && typeof child === 'object' && !Array.isArray(child)) stack.push(child as Record<string, unknown>);
      }
    }
  }
  return output;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'resource';
}

function joinFsPath(root: string, child: string): string {
  return `${root.replace(/\/+$/g, '')}/${child.replace(/^\/+/g, '')}`;
}
