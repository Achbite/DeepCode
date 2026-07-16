import { stableHash } from '../../cache/canonicalizer.js';
import type { ResourceRequestDraft } from '../../protocol/types.js';
import type {
  ConversationResourceRoot,
  ResourcePacket,
  ResourcePacketItem,
} from '../../context/types.js';

export interface GeneratedArtifactEvidence {
  targetPath: string;
  content: string;
  contentHash: string;
  manifestEntryId: string;
  contentBlockId?: string;
  actionId?: string;
  workUnitId?: string;
}

export interface CompletedWorkUnitFacts {
  actionIds: Set<string>;
  targets: Set<string>;
}

export interface GeneratedArtifactEvidenceIndexPorts {
  normalizeRelativePath(value: string | undefined): string | undefined;
  comparablePath(value: string): string;
  batchActionRecords(batch: unknown): Record<string, unknown>[];
  actionToolId(action: { toolId?: unknown }): string;
  actionFileTargetPath(action: { args?: unknown }): string | undefined;
  completedWorkUnitFacts(events: unknown[]): CompletedWorkUnitFacts;
  completedActionMatches(actionId: string | undefined, targetPath: string, completed: CompletedWorkUnitFacts): boolean;
  codeBlockContent(block: Record<string, unknown>): string | undefined;
  resolveRelativePath(
    value: string,
    rootId: string | undefined,
    roots: ConversationResourceRoot[]
  ): string | undefined;
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
      if (!item.evidenceRefs?.includes('generatedArtifactEvidence')) continue;
      const targetPath = this.ports.normalizeRelativePath(item.path);
      const content = typeof item.promptContent === 'string' ? item.promptContent : undefined;
      if (!targetPath || !content) continue;
      evidence.set(this.ports.comparablePath(targetPath), {
        targetPath,
        content,
        contentHash: stableHash(content),
        manifestEntryId: item.manifestEntryId,
      });
    }
  }

  packetFromSuccessfulBatch(
    state: GeneratedArtifactEvidenceState,
    batch: Record<string, unknown>,
    events: unknown[],
    packetId: string
  ): ResourcePacket | undefined {
    const completed = this.ports.completedWorkUnitFacts(events);
    if (completed.actionIds.size === 0 && completed.targets.size === 0) return undefined;
    const contentBlocks = Array.isArray(batch.contentBlocks) ? batch.contentBlocks : [];
    const contentBlockById = new Map<string, Record<string, unknown>>();
    for (const block of contentBlocks) {
      const record = objectRecord(block);
      const id = stringValue(record?.blockId);
      if (record && id) contentBlockById.set(id, record);
    }
    const items: ResourcePacketItem[] = [];
    for (const action of this.ports.batchActionRecords(batch)) {
      const capability = this.ports.actionToolId(action);
      if (capability !== 'fs.write' && capability !== 'fs.create') continue;
      const actionId = stringValue(action.actionId);
      const args = objectRecord(action.args);
      const contentBlockId = stringValue(args?.contentBlockId);
      const block = contentBlockId ? contentBlockById.get(contentBlockId) : undefined;
      const targetPath = this.ports.normalizeRelativePath(
        this.ports.actionFileTargetPath(action) ??
        stringValue(block?.targetPath)
      );
      if (!targetPath || targetPath === '.') continue;
      if (!this.ports.completedActionMatches(actionId, targetPath, completed)) continue;
      const content = block ? this.ports.codeBlockContent(block) : undefined;
      if (typeof content !== 'string') continue;
      const manifestEntryId = `generated-${sanitizeId(targetPath)}`;
      const absolutePath = this.absolutePath(state, targetPath);
      const contentHash = stableHash(content);
      state.generatedArtifactEvidence.set(this.ports.comparablePath(targetPath), {
        targetPath,
        content,
        contentHash,
        manifestEntryId,
        contentBlockId,
        actionId,
      });
      items.push({
        requestItemId: `generated-${sanitizeId(actionId ?? targetPath)}`,
        manifestEntryId,
        readPolicy: 'autoRead',
        status: 'resolved',
        path: targetPath,
        ...(absolutePath ? { absolutePath } : {}),
        contentKind: 'fileText',
        contentSummary: `Generated artifact from completed Kernel work unit: ${targetPath}`,
        promptContent: content,
        originalBytes: utf8Bytes(content),
        returnedBytes: utf8Bytes(content),
        rangeComplete: true,
        evidenceRefs: ['generatedArtifactEvidence'],
      });
    }
    if (!items.length) return undefined;
    return {
      id: packetId,
      workspaceScopeKey: state.workspaceScopeKey,
      requestId: `${packetId}-request`,
      items,
    };
  }

  packetForRequest(
    state: GeneratedArtifactEvidenceState,
    request: ResourceRequestDraft,
    packetId: string
  ): { packet?: ResourcePacket; remaining: ResourceRequestDraft } {
    const remainingItems: ResourceRequestDraft['items'] = [];
    const items: ResourcePacketItem[] = [];
    for (const item of request.items ?? []) {
      const evidence = this.evidenceForRequestItem(state, item);
      if (!evidence) {
        remainingItems.push(item);
        continue;
      }
      const absolutePath = this.absolutePath(state, evidence.targetPath);
      items.push({
        requestItemId: item.id,
        manifestEntryId: evidence.manifestEntryId,
        readPolicy: 'autoRead',
        status: 'resolved',
        path: evidence.targetPath,
        ...(absolutePath ? { absolutePath } : {}),
        contentKind: 'fileText',
        contentSummary: `Run-local generated artifact evidence: ${evidence.targetPath}`,
        promptContent: evidence.content,
        originalBytes: utf8Bytes(evidence.content),
        returnedBytes: utf8Bytes(evidence.content),
        rangeComplete: true,
        evidenceRefs: ['generatedArtifactEvidence'],
      });
    }
    return {
      packet: items.length
        ? {
          id: packetId,
          workspaceScopeKey: state.workspaceScopeKey,
          requestId: request.id ?? `${packetId}-request`,
          items,
        }
        : undefined,
      remaining: {
        ...request,
        items: remainingItems,
      },
    };
  }

  private evidenceForRequestItem(
    state: GeneratedArtifactEvidenceState,
    item: ResourceRequestDraft['items'][number]
  ): GeneratedArtifactEvidence | undefined {
    if (item.kind === 'search' || item.query?.trim()) return undefined;
    const candidates = uniqueStrings([
      stringValue(item.path),
      stringValue(item.manifestEntryId),
    ]);
    for (const candidate of candidates) {
      const targetPath = this.ports.resolveRelativePath(candidate, item.rootId, state.conversationRoots)
        ?? this.ports.resolveRelativePath(candidate, undefined, state.conversationRoots)
        ?? this.ports.normalizeRelativePath(candidate);
      if (!targetPath || targetPath === '.') continue;
      const evidence = state.generatedArtifactEvidence.get(this.ports.comparablePath(targetPath));
      if (evidence) return evidence;
    }
    return undefined;
  }

  private absolutePath(state: GeneratedArtifactEvidenceState, targetPath: string): string | undefined {
    const root = state.conversationRoots.find((item) => item.primary) ?? state.conversationRoots[0];
    const base = root?.absolutePath ?? root?.displayPath;
    return base ? joinFsPath(base, targetPath) : undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'resource';
}

function joinFsPath(root: string, child: string): string {
  const cleanRoot = root.replace(/\/+$/g, '');
  const cleanChild = child.replace(/^\/+/g, '');
  return `${cleanRoot}/${cleanChild}`;
}
