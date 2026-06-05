import type { ResourcePacket } from '../context/types.js';
import { stableHash } from '../cache/canonicalizer.js';
import type { AuthoritativeDocExcerpt } from './docProbe.js';
import type { SyntheticDialoguePacket } from './dialogue.js';

export interface MemoryHintRef {
  id: string;
  kind: 'projectRule' | 'userPreference' | 'designDecision' | 'knownPitfall' | 'contextHint' | string;
  contentHash: string;
  source: string;
}

export interface ContextSnapshot {
  id: string;
  workspaceScopeKey: string;
  currentUserOverlayHash: string;
  rulerHash: string;
  builtinSystemPromptHash: string;
  protocolContractHash: string;
  docExcerptHash: string;
  memoryHintHashes: string[];
  resourcePacketHashes: string[];
  syntheticDialoguePacketHash?: string;
  auditHash: string;
}

export function createContextSnapshot(input: {
  id: string;
  workspaceScopeKey: string;
  currentUserOverlay?: string;
  rulerHash: string;
  builtinSystemPromptHash: string;
  protocolContractHash: string;
  docExcerpts?: AuthoritativeDocExcerpt[];
  memoryHints?: MemoryHintRef[];
  resourcePackets?: ResourcePacket[];
  syntheticDialoguePacket?: SyntheticDialoguePacket;
  auditOnly?: Record<string, unknown>;
}): ContextSnapshot {
  const currentUserOverlayHash = stableHash(input.currentUserOverlay ?? '');
  const docExcerptHash = stableHash(JSON.stringify((input.docExcerpts ?? []).map((excerpt) => ({
    docKind: excerpt.docKind,
    path: excerpt.path,
    lineStart: excerpt.lineStart,
    lineEnd: excerpt.lineEnd,
    excerptHash: excerpt.excerptHash,
  }))));
  const memoryHintHashes = (input.memoryHints ?? []).map((hint) => hint.contentHash).sort();
  const resourcePacketHashes = (input.resourcePackets ?? []).map((packet) => stableHash(JSON.stringify({
    id: packet.id,
    workspaceScopeKey: packet.workspaceScopeKey,
    requestId: packet.requestId,
    items: packet.items.map((item) => ({
      manifestEntryId: item.manifestEntryId,
      status: item.status,
      evidenceRefs: item.evidenceRefs ?? [],
    })),
  }))).sort();
  const auditHash = stableHash(JSON.stringify({
    workspaceScopeKey: input.workspaceScopeKey,
    currentUserOverlayHash,
    rulerHash: input.rulerHash,
    builtinSystemPromptHash: input.builtinSystemPromptHash,
    protocolContractHash: input.protocolContractHash,
    docExcerptHash,
    memoryHintHashes,
    resourcePacketHashes,
    syntheticDialoguePacketHash: input.syntheticDialoguePacket?.packetHash,
    auditOnly: input.auditOnly ?? {},
  }));
  return {
    id: input.id,
    workspaceScopeKey: input.workspaceScopeKey,
    currentUserOverlayHash,
    rulerHash: input.rulerHash,
    builtinSystemPromptHash: input.builtinSystemPromptHash,
    protocolContractHash: input.protocolContractHash,
    docExcerptHash,
    memoryHintHashes,
    resourcePacketHashes,
    syntheticDialoguePacketHash: input.syntheticDialoguePacket?.packetHash,
    auditHash,
  };
}
