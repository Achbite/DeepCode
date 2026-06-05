import type { ResourceManifest, ResourcePacket, ResourcePacketItem, ResourceReadPolicy, ResourceRequest } from './types.js';

export function createResourcePacket(input: {
  packetId: string;
  request: ResourceRequest;
  manifest: ResourceManifest;
  kernelEvidence?: Record<string, { contentSummary?: string; evidenceRefs?: string[] }>;
}): ResourcePacket {
  const entriesById = new Map(input.manifest.entries.map((entry) => [entry.id, entry]));
  const items: ResourcePacketItem[] = [];
  const seen = new Set<string>();

  for (const requestItem of input.request.items.slice(0, input.manifest.budget.maxEntries)) {
    if (seen.has(requestItem.manifestEntryId)) continue;
    seen.add(requestItem.manifestEntryId);
    const entry = entriesById.get(requestItem.manifestEntryId);
    if (!entry) {
      items.push({
        requestItemId: requestItem.id,
        manifestEntryId: requestItem.manifestEntryId,
        readPolicy: 'denyRead',
        status: 'denied',
        denialReason: 'resource is not listed in ResourceManifest',
      });
      continue;
    }

    items.push(resourcePacketItem(requestItem.id, entry.id, entry.readPolicy, input.kernelEvidence?.[entry.id]));
  }

  return {
    id: input.packetId,
    workspaceScopeKey: input.manifest.workspaceScopeKey,
    requestId: input.request.id,
    items,
  };
}

function resourcePacketItem(
  requestItemId: string,
  manifestEntryId: string,
  readPolicy: ResourceReadPolicy,
  evidence?: { contentSummary?: string; evidenceRefs?: string[] }
): ResourcePacketItem {
  if (readPolicy === 'autoRead') {
    return {
      requestItemId,
      manifestEntryId,
      readPolicy,
      status: 'provided',
      contentSummary: evidence?.contentSummary ?? 'auto-read resource approved by manifest policy',
      evidenceRefs: evidence?.evidenceRefs ?? [],
      sourceKind: evidence ? 'kernelResource' : 'manifestOnly',
    };
  }
  if (readPolicy === 'askRead') {
    return {
      requestItemId,
      manifestEntryId,
      readPolicy,
      status: 'needsUserApproval',
      denialReason: 'resource requires user approval before read',
      sourceKind: 'manifestOnly',
    };
  }
  return {
    requestItemId,
    manifestEntryId,
    readPolicy,
    status: 'denied',
    denialReason: 'resource is denied by manifest policy',
    sourceKind: 'manifestOnly',
  };
}
