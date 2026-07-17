import { stableHash } from '../../cache/canonicalizer.js';
import { decodeKernelEventV1 } from '@deepcode/protocol';
import type { ResourceRequestDraft } from '../../protocol/types.js';
import type {
  ConversationResourceRoot,
  ResourcePacket,
} from '../../context/types.js';

export interface GeneratedArtifactEvidence {
  targetPath: string;
  content?: string;
  contentHash: string;
  manifestEntryId: string;
  toolCallId?: string;
  sizeBytes?: number;
  contentBlockId?: string;
  actionId?: string;
  workUnitId?: string;
}

export interface GeneratedArtifactEvidenceIndexPorts {
  normalizeRelativePath(value: string | undefined): string | undefined;
  comparablePath(value: string): string;
}

export interface GeneratedArtifactEvidenceState {
  workspaceScopeKey: string;
  conversationRoots: ConversationResourceRoot[];
  generatedArtifactEvidence: Map<string, GeneratedArtifactEvidence>;
}

export class GeneratedArtifactEvidenceIndex {
  constructor(private readonly ports: GeneratedArtifactEvidenceIndexPorts) {}

  fromPackets(packets: ResourcePacket[]): Map<string, GeneratedArtifactEvidence> {
    const evidence = new Map<string, GeneratedArtifactEvidence>();
    for (const packet of packets) {
      this.indexPacket(evidence, packet);
    }
    return evidence;
  }

  indexPacket(evidence: Map<string, GeneratedArtifactEvidence>, packet: ResourcePacket): void {
    for (const item of packet.items) {
      const targetPath = this.ports.normalizeRelativePath(item.path);
      const content = typeof item.promptContent === 'string' ? item.promptContent : undefined;
      if (!targetPath || !content) continue;
      const key = this.ports.comparablePath(targetPath);
      const existing = evidence.get(key);
      if (!existing && !item.evidenceRefs?.includes('generatedArtifactEvidence')) continue;
      evidence.set(key, {
        ...existing,
        targetPath,
        content,
        contentHash: item.contentHash ?? existing?.contentHash ?? stableHash(content),
        manifestEntryId: existing?.manifestEntryId ?? item.manifestEntryId,
      });
    }
  }

  packetFromSuccessfulBatch(
    state: GeneratedArtifactEvidenceState,
    _batch: unknown,
    events: unknown[],
    _packetId: string
  ): ResourcePacket | undefined {
    for (const toolFact of generatedToolFacts(events)) {
      const targetPath = this.ports.normalizeRelativePath(toolFact.path);
      if (!targetPath || targetPath === '.') continue;
      const manifestEntryId = `generated-${sanitizeId(targetPath)}`;
      state.generatedArtifactEvidence.set(this.ports.comparablePath(targetPath), {
        targetPath,
        contentHash: toolFact.contentHash,
        manifestEntryId,
        toolCallId: toolFact.toolCallId,
        sizeBytes: toolFact.sizeBytes,
        actionId: toolFact.actionId,
        workUnitId: toolFact.workUnitId,
      });
    }
    return undefined;
  }

  packetForRequest(
    _state: GeneratedArtifactEvidenceState,
    request: ResourceRequestDraft,
    _packetId: string
  ): { packet?: ResourcePacket; remaining: ResourceRequestDraft } {
    return {
      remaining: request,
    };
  }
}

interface GeneratedToolFact {
  toolCallId: string;
  actionId?: string;
  workUnitId: string;
  path: string;
  contentHash: string;
  sizeBytes: number;
}

function generatedToolFacts(events: unknown[]): GeneratedToolFact[] {
  return events.flatMap((event): GeneratedToolFact[] => {
    let decoded;
    try {
      decoded = decodeKernelEventV1(event);
    } catch {
      return [];
    }
    if (decoded.kind !== 'tool.completed' || !decoded.fact.ok) return [];
    if (decoded.fact.toolId !== 'fs.create' && decoded.fact.toolId !== 'fs.write') return [];
    const output = objectRecord(decoded.fact.output);
    const context = objectRecord(output?.kernelContext);
    const path = stringValue(output?.path) ?? stringValue(output?.normalizedTargetPath);
    const contentHash = stringValue(output?.contentHash);
    const sizeBytes = nonNegativeInteger(output?.sizeBytes) ?? nonNegativeInteger(output?.contentBytes);
    const workUnitId = stringValue(output?.workUnitId) ?? stringValue(context?.workUnitId);
    if (!path || !contentHash || sizeBytes === undefined || !workUnitId) return [];
    return [{
      toolCallId: decoded.fact.toolCallId,
      actionId: stringValue(context?.actionId),
      workUnitId,
      path,
      contentHash,
      sizeBytes,
    }];
  });
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'resource';
}
