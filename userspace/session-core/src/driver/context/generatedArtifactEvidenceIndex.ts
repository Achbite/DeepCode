import { stableHash } from '../../cache/canonicalizer.js';
import type { ResourceRequestDraft } from '../../agent-plan/types.js';
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
  sourceBlockId?: string;
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
  utf8Bytes(value: string): number;
  sanitizeId(value: string): string;
  joinFsPath(root: string, child: string): string;
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringValue(value: unknown): string | undefined;
  uniqueStrings(values: Array<string | undefined>): string[];
  batchActionRecords(batch: unknown): Record<string, unknown>[];
  actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string;
  actionFileTargetPath(action: {
    targetRef?: unknown;
    targetPath?: unknown;
    resourceScope?: unknown;
    args?: unknown;
  }): string | undefined;
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
    const codeBlocks = Array.isArray(batch.codeBlocks) ? batch.codeBlocks : [];
    const codeBlockById = new Map<string, Record<string, unknown>>();
    for (const block of codeBlocks) {
      const record = this.ports.objectRecord(block);
      const id = this.ports.stringValue(record?.id) ?? this.ports.stringValue(record?.blockId);
      if (record && id) codeBlockById.set(id, record);
    }
    const items: ResourcePacketItem[] = [];
    for (const action of this.ports.batchActionRecords(batch)) {
      const capability = this.ports.actionEffectiveCapability(action);
      if (capability !== 'fs.write' && capability !== 'fs.create') continue;
      const actionId = this.ports.stringValue(action.actionId) ?? this.ports.stringValue(action.id);
      const args = this.ports.objectRecord(action.args) ?? this.ports.objectRecord(action.toolArgs);
      const sourceBlockId = this.ports.stringValue(action.sourceBlockId) ?? this.ports.stringValue(args?.sourceBlockId);
      const block = sourceBlockId ? codeBlockById.get(sourceBlockId) : undefined;
      const targetPath = this.ports.normalizeRelativePath(
        this.ports.actionFileTargetPath(action) ??
        this.ports.stringValue(block?.targetPath) ??
        this.ports.stringValue(block?.path)
      );
      if (!targetPath || targetPath === '.') continue;
      if (!this.ports.completedActionMatches(actionId, targetPath, completed)) continue;
      const content = block ? this.ports.codeBlockContent(block) : undefined;
      if (typeof content !== 'string') continue;
      const manifestEntryId = `generated-${this.ports.sanitizeId(targetPath)}`;
      const absolutePath = this.absolutePath(state, targetPath);
      const contentHash = stableHash(content);
      state.generatedArtifactEvidence.set(this.ports.comparablePath(targetPath), {
        targetPath,
        content,
        contentHash,
        manifestEntryId,
        sourceBlockId,
        actionId,
      });
      items.push({
        requestItemId: `generated-${this.ports.sanitizeId(actionId ?? targetPath)}`,
        manifestEntryId,
        readPolicy: 'autoRead',
        status: 'resolved',
        path: targetPath,
        ...(absolutePath ? { absolutePath } : {}),
        contentKind: 'fileText',
        contentSummary: `Generated artifact from completed Kernel work unit: ${targetPath}`,
        promptContent: content,
        originalBytes: this.ports.utf8Bytes(content),
        returnedBytes: this.ports.utf8Bytes(content),
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
        originalBytes: this.ports.utf8Bytes(evidence.content),
        returnedBytes: this.ports.utf8Bytes(evidence.content),
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
    const candidates = this.ports.uniqueStrings([
      this.ports.stringValue(item.path),
      this.ports.stringValue(item.manifestEntryId),
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
    return base ? this.ports.joinFsPath(base, targetPath) : undefined;
  }
}
