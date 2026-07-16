import { stableHash } from '../cache/canonicalizer.js';
import type {
  ConversationResourceRoot,
  ProjectBootstrapEntry,
  ProjectBootstrapSnapshot,
  ResourceManifest,
  ResourcePacket,
  ResourcePacketItem,
} from '../context/types.js';

const MAX_PROJECTED_ENTRIES = 160;
const MAX_PROJECTED_CHARS = 4096;

export function buildProjectBootstrapSnapshot(input: {
  manifest: ResourceManifest;
  roots: readonly ConversationResourceRoot[];
  packets: readonly ResourcePacket[];
}): ProjectBootstrapSnapshot | undefined {
  const root = input.roots.find((candidate) => candidate.primary)
    ?? (input.roots.length === 1 ? input.roots[0] : undefined);
  const cwd = root?.absolutePath ?? root?.displayPath;
  if (!root || !cwd) return undefined;
  const item = findBootstrapItem(input.manifest, input.packets, root.rootId);
  const rawNodes = item && Array.isArray((item as ResourcePacketItem & { nodes?: unknown[] }).nodes)
    ? (item as ResourcePacketItem & { nodes: unknown[] }).nodes
    : [];
  const entries: ProjectBootstrapEntry[] = [];
  let projectedChars = 0;
  for (const value of rawNodes.slice(0, MAX_PROJECTED_ENTRIES)) {
    const entry = bootstrapEntry(value);
    if (!entry) continue;
    const nextChars = JSON.stringify(entry).length;
    if (projectedChars + nextChars > MAX_PROJECTED_CHARS) break;
    projectedChars += nextChars;
    entries.push(entry);
  }
  const returnedCount = numericValue(item, 'returnedCount') ?? rawNodes.length;
  return {
    schemaVersion: 'deepcode.session.project-bootstrap.v1',
    cwd,
    rootId: root.rootId,
    workspaceScopeKey: input.manifest.workspaceScopeKey,
    workspaceBindingHash: input.manifest.workspaceBindingHash,
    rootStatus: input.manifest.projectRootStatus ?? 'ready',
    entries,
    returnedCount,
    truncated: item?.truncated === true || entries.length < returnedCount,
    listingHash: stableHash(JSON.stringify(rawNodes)),
  };
}

export function renderProjectBootstrapSnapshot(snapshot: ProjectBootstrapSnapshot | undefined): string {
  if (!snapshot) return '';
  return [
    'ProjectBootstrapSnapshot:',
    JSON.stringify(snapshot),
    'This is navigation metadata only. No file content has been read.',
  ].join('\n');
}

function findBootstrapItem(
  manifest: ResourceManifest,
  packets: readonly ResourcePacket[],
  rootId: string
): ResourcePacketItem | undefined {
  const bootstrapIds = new Set(manifest.entries
    .filter((entry) => entry.contextUse === 'workspaceBootstrap' && (entry.rootId === rootId || entry.id === rootId))
    .map((entry) => entry.id));
  for (const packet of [...packets].reverse()) {
    const item = packet.items.find((candidate) => (
      candidate.contentKind === 'directoryTree'
      && (candidate.rootId === rootId || bootstrapIds.has(candidate.manifestEntryId))
    ));
    if (item) return item;
  }
  return undefined;
}

function bootstrapEntry(value: unknown): ProjectBootstrapEntry | undefined {
  const node = objectRecord(value);
  const path = stringValue(node?.path);
  if (!node || !path) return undefined;
  const classification = objectRecord(node.fileClassification);
  const kindValue = stringValue(node.type);
  const kind = kindValue === 'file' || kindValue === 'directory' ? kindValue : 'other';
  const classificationKind = stringValue(classification?.kind);
  const executable = classification?.executable === true;
  const binary = classification?.binary === true;
  return {
    path,
    kind,
    sizeBytes: numericRecordValue(classification, 'sizeBytes'),
    readable: kind === 'directory' || classification?.readableText === true,
    classification: classificationKind
      ? `${classificationKind}${binary ? ':binary' : ''}${executable ? ':executable' : ''}`
      : kind,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numericValue(item: ResourcePacketItem | undefined, key: string): number | undefined {
  return numericRecordValue(item as unknown as Record<string, unknown> | undefined, key);
}

function numericRecordValue(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
