import { stableHash } from '../cache/canonicalizer.js';
import type {
  ConversationResourceRoot,
  ResourceDelta,
  ResourceDeltaItem,
  ResourcePacket,
  ResourcePacketItem,
} from '../context/types.js';

export function buildResourceDelta(input: {
  requestId: string;
  workspaceScopeKey: string;
  packets: readonly ResourcePacket[];
  roots: readonly ConversationResourceRoot[];
}): ResourceDelta {
  const items = input.packets.flatMap((packet) => packet.items.map((item) => deltaItem(item, input.roots)));
  const rootIds = [...new Set(items.flatMap((item) => item.rootId ? [item.rootId] : []))];
  return {
    schemaVersion: 'deepcode.session.resource-delta.v1',
    requestId: input.requestId,
    workspaceScopeKey: input.workspaceScopeKey,
    ...(rootIds.length === 1 ? { rootId: rootIds[0] } : {}),
    items,
  };
}

function deltaItem(
  item: ResourcePacketItem,
  roots: readonly ConversationResourceRoot[]
): ResourceDeltaItem {
  const root = rootForItem(item, roots);
  const path = relativePath(item.absolutePath ?? item.path, root);
  const record = item as ResourcePacketItem & {
    sizeBytes?: number;
    metadataHash?: string;
    nodes?: Array<Record<string, unknown>>;
  };
  const content = item.contentKind === 'fileText' || item.contentKind === 'text'
    ? item.promptContent
    : undefined;
  const nodes = item.contentKind === 'directoryTree' && Array.isArray(record.nodes)
    ? record.nodes
    : undefined;
  const matches = item.contentKind === 'searchResults' ? item.matches : undefined;
  const hash = item.contentHash ?? record.metadataHash ?? stableHash(JSON.stringify({
    content,
    nodes,
    matches,
    status: item.status,
    path,
  }));
  return {
    requestItemId: item.requestItemId,
    rootId: item.rootId ?? root?.rootId,
    path,
    status: item.status,
    contentKind: item.contentKind,
    hash,
    sizeBytes: record.sizeBytes ?? item.originalBytes,
    truncated: item.truncated,
    content,
    summary: item.contentSummary ?? item.skipMessage ?? item.message,
    matches,
    nodes,
    reason: item.reason ?? item.denialReason ?? item.skipReason,
  };
}

function rootForItem(
  item: ResourcePacketItem,
  roots: readonly ConversationResourceRoot[]
): ConversationResourceRoot | undefined {
  if (item.rootId) return roots.find((root) => root.rootId === item.rootId);
  const value = normalizePath(item.absolutePath ?? item.path);
  if (!value) return roots.find((root) => root.primary) ?? (roots.length === 1 ? roots[0] : undefined);
  return [...roots]
    .sort((left, right) => rootPath(right).length - rootPath(left).length)
    .find((root) => value === rootPath(root) || value.startsWith(`${rootPath(root)}/`));
}

function relativePath(
  value: string | undefined,
  root: ConversationResourceRoot | undefined
): string | undefined {
  const normalized = normalizePath(value);
  if (!normalized) return undefined;
  const rootValue = root ? rootPath(root) : '';
  if (!rootValue) return normalized;
  if (normalized === rootValue) return '.';
  return normalized.startsWith(`${rootValue}/`)
    ? normalized.slice(rootValue.length + 1)
    : normalized;
}

function rootPath(root: ConversationResourceRoot): string {
  return normalizePath(root.absolutePath ?? root.displayPath) ?? '';
}

function normalizePath(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/u, '');
  return normalized || undefined;
}
