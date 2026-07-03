import type {
  ResourcePacket,
  ResourcePacketItem,
} from '../../context/types.js';

export interface ResourceEvidenceIndexOptions {
  normalizeTarget?: (value: string) => string;
  clip?: (value: string, maxChars: number) => string;
}

export class ResourceEvidenceIndex {
  constructor(private readonly options: ResourceEvidenceIndexOptions = {}) {}

  mentionsAnyTarget(packets: ResourcePacket[], targets: string[]): boolean {
    if (!packets.length || !targets.length) return false;
    const normalizedTargets = this.normalizedTargets(targets);
    return this.resolvedItems(packets).some((item) => this.itemMatchesAnyTarget(item, normalizedTargets));
  }

  containsExactBlock(packets: ResourcePacket[], targets: string[], matchText: string): boolean {
    if (!packets.length) return false;
    const normalizedMatch = normalizeLineEndings(matchText);
    const normalizedTargets = this.normalizedTargets(targets);
    const candidateItems = this.resolvedItems(packets);
    const pathMatchedItems = normalizedTargets.length
      ? candidateItems.filter((item) => this.itemMatchesAnyTarget(item, normalizedTargets))
      : candidateItems;
    const items = pathMatchedItems.length ? pathMatchedItems : candidateItems;
    return items.some((item) => {
      const evidence = this.itemEvidenceText(item);
      if (!evidence) return false;
      return normalizeLineEndings(evidence).includes(normalizedMatch);
    });
  }

  existsForTarget(packets: ResourcePacket[], target: string): boolean {
    const normalized = this.normalize(target);
    return this.resolvedItems(packets).some((item) =>
      this.itemMatchesAnyTarget(item, [normalized]) && Boolean(this.itemEvidenceText(item))
    );
  }

  textForTarget(packets: ResourcePacket[], target: string): string | undefined {
    const normalized = this.normalize(target);
    for (const packet of [...packets].reverse()) {
      for (const item of [...packet.items].reverse()) {
        if (!isResolvedItem(item)) continue;
        if (!this.itemMatchesAnyTarget(item, [normalized])) continue;
        const text = this.itemEvidenceText(item);
        if (text) return text;
      }
    }
    return undefined;
  }

  relevantForTargets(packets: ResourcePacket[], targets: string[]): string[] {
    const normalizedTargets = this.normalizedTargets(targets);
    const items = this.resolvedItems(packets)
      .filter((item) => !normalizedTargets.length || this.itemMatchesAnyTarget(item, normalizedTargets));
    return items.slice(-6).map((item) => {
      const path = item.path ?? item.absolutePath ?? item.manifestEntryId;
      const kind = item.contentKind ?? 'resource';
      const body = this.itemEvidenceText(item);
      return [
        `ResourceEvidence kind=${kind}${path ? ` path=${path}` : ''}`,
        body ? this.clip(body, 2400) : item.contentSummary ?? 'no text evidence',
      ].join('\n');
    });
  }

  private resolvedItems(packets: ResourcePacket[]): ResourcePacketItem[] {
    return packets.flatMap((packet) => packet.items ?? []).filter(isResolvedItem);
  }

  private normalizedTargets(targets: string[]): string[] {
    return targets.map((target) => this.normalize(target)).filter(Boolean);
  }

  private itemMatchesAnyTarget(item: ResourcePacketItem, targets: string[]): boolean {
    const candidates = [
      item.path,
      item.absolutePath,
    ]
      .map((value) => typeof value === 'string' ? this.normalize(value) : '')
      .filter(Boolean);
    if (!candidates.length) return false;
    return targets.some((target) =>
      candidates.some((candidate) =>
        candidate === target ||
        candidate.endsWith(`/${target}`) ||
        target.endsWith(`/${candidate}`)
      )
    );
  }

  private itemEvidenceText(item: ResourcePacketItem): string {
    const parts = [
      item.promptContent,
      item.contentSummary,
      Array.isArray(item.matches) ? JSON.stringify(item.matches) : '',
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    return parts.join('\n');
  }

  private normalize(value: string): string {
    const normalizeTarget = this.options.normalizeTarget ?? normalizeResourcePathIdentity;
    return normalizeTarget(value);
  }

  private clip(value: string, maxChars: number): string {
    return this.options.clip ? this.options.clip(value, maxChars) : value.slice(0, maxChars);
  }
}

function isResolvedItem(item: ResourcePacketItem): boolean {
  return item.status === 'resolved' || item.status === 'provided';
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeResourcePathIdentity(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/\/+$/g, '');
}
