import type {
  AgentConversationActivity,
  AgentEvent,
} from '@deepcode/protocol';
import type {
  ResourcePacket,
  ResourcePacketItem,
} from '../../context/types.js';

export class ResourceRequestLoop {
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
