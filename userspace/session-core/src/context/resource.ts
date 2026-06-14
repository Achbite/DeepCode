import type { ResourceManifest, ResourcePacket, ResourcePacketItem, ResourceReadPolicy, ResourceRequest } from './types.js';

type KernelResourceEvidence = {
  contentKind?: ResourcePacketItem['contentKind'];
  contentSummary?: string;
  promptContent?: string;
  truncated?: boolean;
  originalBytes?: number;
  evidenceRefs?: string[];
};

export function createResourcePacket(input: {
  packetId: string;
  request: ResourceRequest;
  manifest: ResourceManifest;
  kernelEvidence?: Record<string, KernelResourceEvidence>;
}): ResourcePacket {
  const entriesById = new Map(input.manifest.entries.map((entry) => [entry.id, entry]));
  const items: ResourcePacketItem[] = [];
  const seen = new Set<string>();

  for (const requestItem of input.request.items.slice(0, input.manifest.budget.maxEntries)) {
    const manifestEntryId = requestItem.manifestEntryId;
    const requestKey = manifestEntryId ?? requestItem.path ?? requestItem.id;
    if (seen.has(requestKey)) continue;
    seen.add(requestKey);
    const entry = manifestEntryId ? entriesById.get(manifestEntryId) : undefined;
    if (!entry) {
      items.push({
        requestItemId: requestItem.id,
        manifestEntryId: manifestEntryId ?? requestKey,
        readPolicy: 'denyRead',
        status: 'denied',
        denialReason: manifestEntryId
          ? 'resource is not listed in ResourceManifest'
          : 'path-based resource requests must be resolved by Session before packet creation',
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
  evidence?: KernelResourceEvidence
): ResourcePacketItem {
  if (readPolicy === 'autoRead') {
    return {
      requestItemId,
      manifestEntryId,
      readPolicy,
      status: 'provided',
      contentKind: evidence?.contentKind,
      contentSummary: evidence?.contentSummary ?? 'auto-read resource approved by manifest policy',
      promptContent: evidence?.promptContent,
      truncated: evidence?.truncated,
      originalBytes: evidence?.originalBytes,
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
