import type { ResourceRequestDraft } from '../protocol/types.js';
import type {
  ConversationResourceRoot,
  ResourceManifest,
  ResourceManifestEntry,
} from '../context/types.js';

export interface ResourceRequestResolution {
  manifest: ResourceManifest;
  unresolved: string[];
  ambiguous: string[];
  availableRoots: ConversationResourceRoot[];
}

export type SynthesizedManifestEntryResult =
  | { kind: 'entry'; entry: ResourceManifestEntry }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unresolved'; reason: string };

type ResolvedRequestPath =
  | { kind: 'resolved'; root: ConversationResourceRoot; relativePath: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unresolved'; reason: string };

export class ResourceRequestResolver {
  resolve(
    manifest: ResourceManifest,
    request: ResourceRequestDraft,
    roots: ConversationResourceRoot[]
  ): ResourceRequestResolution {
    const entries: ResourceManifestEntry[] = [];
    const seen = new Set<string>();
    const unresolved: string[] = [];
    const ambiguous: string[] = [];

    const pushEntry = (entry: ResourceManifestEntry, item?: ResourceRequestDraft['items'][number]) => {
      const ranged = item ? this.entryWithRange(entry, item) : entry;
      if (seen.has(ranged.id)) return;
      seen.add(ranged.id);
      entries.push(ranged);
    };

    for (const item of request.items ?? []) {
      const searchQuery = item.query?.trim();
      if (item.kind === 'search' || searchQuery) {
        const synthesized = this.synthesizeEntryForSearch(roots, item);
        if (synthesized.kind === 'entry') {
          manifest.entries.push(synthesized.entry);
          pushEntry(synthesized.entry, item);
          continue;
        }
        if (synthesized.kind === 'ambiguous') {
          ambiguous.push(`${item.id} (${synthesized.reason})`);
          continue;
        }
        unresolved.push(`${item.id} (${synthesized.reason})`);
        continue;
      }

      const exactId = item.manifestEntryId?.trim();
      if (exactId) {
        const exact = manifest.entries.find((entry) => entry.id === exactId);
        if (exact) {
          pushEntry(exact, item);
          continue;
        }
      }

      const pathCandidate = item.path?.trim() || item.manifestEntryId?.trim();
      if (!pathCandidate) {
        unresolved.push(item.id);
        continue;
      }

      const existing = this.findExistingEntryByPath(manifest, pathCandidate, roots);
      if (existing) {
        pushEntry(existing, item);
        continue;
      }

      const synthesized = this.synthesizeEntryForPath(
        manifest,
        roots,
        item.id,
        pathCandidate,
        item.rootId,
        item.reason
      );
      if (synthesized.kind === 'entry') {
        const entry = this.entryWithRange(synthesized.entry, item);
        manifest.entries.push(synthesized.entry);
        pushEntry(entry);
        continue;
      }
      if (synthesized.kind === 'ambiguous') {
        ambiguous.push(`${pathCandidate} (${synthesized.reason})`);
        continue;
      }
      unresolved.push(`${pathCandidate} (${synthesized.reason})`);
    }

    return {
      manifest: {
        ...manifest,
        id: `${manifest.id}-request-${sanitizeId(request.id ?? 'resource-request')}`,
        entries,
      },
      unresolved,
      ambiguous,
      availableRoots: roots,
    };
  }

  synthesizeEntryForPath(
    manifest: ResourceManifest,
    roots: ConversationResourceRoot[],
    itemId: string,
    requestedPath: string,
    rootId: string | undefined,
    reason: string
  ): SynthesizedManifestEntryResult {
    const resolved = this.resolvePath(requestedPath, rootId, roots);
    if (resolved.kind !== 'resolved') return resolved;
    const resourceRef = resolved.relativePath || '.';
    const existing = manifest.entries.find((entry) => (
      entry.rootId === resolved.root.rootId
      && comparablePath(entry.resourceRef) === comparablePath(resourceRef)
    ));
    if (existing) return { kind: 'entry', entry: existing };
    const entry: ResourceManifestEntry = {
      id: `path-${sanitizeId(resolved.root.rootId)}-${sanitizeId(resolved.relativePath || itemId)}`,
      kind: 'resource',
      label: `Resource ${resolved.root.displayPath}/${resolved.relativePath}`,
      resourceRef,
      readPolicy: 'autoRead',
      reason: reason || `Requested path under conversation root ${resolved.root.rootId}.`,
      rootId: resolved.root.rootId,
      resourceId: resolved.root.resourceId,
      contextUse: 'resourceEvidence',
    };
    return { kind: 'entry', entry };
  }

  resolveRelativePath(
    requestedPath: string,
    rootId: string | undefined,
    roots: ConversationResourceRoot[]
  ): string | undefined {
    const resolved = this.resolvePath(requestedPath, rootId, roots);
    return resolved.kind === 'resolved' ? resolved.relativePath : undefined;
  }

  private entryWithRange(
    entry: ResourceManifestEntry,
    item: ResourceRequestDraft['items'][number]
  ): ResourceManifestEntry {
    const offsetBytes = normalizedNonNegativeInteger(item.offsetBytes);
    const limitBytes = normalizedPositiveInteger(item.limitBytes);
    const focusedEntry: ResourceManifestEntry = {
      ...entry,
      id: `${entry.id}:request:${sanitizeId(item.id)}`,
      contextUse: 'resourceEvidence',
      readMode: 'content',
      directoryOptions: undefined,
    };
    if (typeof offsetBytes !== 'number' && typeof limitBytes !== 'number') return focusedEntry;
    const rangeId = [
      focusedEntry.id,
      'range',
      typeof offsetBytes === 'number' ? offsetBytes : 0,
      typeof limitBytes === 'number' ? limitBytes : 'default',
    ].join(':');
    return {
      ...focusedEntry,
      id: rangeId,
      ...(typeof offsetBytes === 'number' ? { offsetBytes } : {}),
      ...(typeof limitBytes === 'number' ? { limitBytes } : {}),
      reason: `${entry.reason} Range request: offsetBytes=${offsetBytes ?? 0}, limitBytes=${limitBytes ?? 'default'}.`,
    };
  }

  private findExistingEntryByPath(
    manifest: ResourceManifest,
    requestedPath: string,
    roots: ConversationResourceRoot[]
  ): ResourceManifestEntry | undefined {
    const exact = manifest.entries.find((entry) => comparablePath(entry.resourceRef) === comparablePath(requestedPath));
    if (exact) return exact;
    const resolved = this.resolvePath(requestedPath, undefined, roots);
    if (resolved.kind !== 'resolved') return undefined;
    const ref = resolved.relativePath || '.';
    return manifest.entries.find((entry) => (
      entry.rootId === resolved.root.rootId
      && comparablePath(entry.resourceRef) === comparablePath(ref)
    ));
  }

  private synthesizeEntryForSearch(
    roots: ConversationResourceRoot[],
    item: ResourceRequestDraft['items'][number]
  ): SynthesizedManifestEntryResult {
    const query = item.query?.trim();
    if (!query) return { kind: 'unresolved', reason: 'search request requires query' };
    const root = this.searchRootForRequest(item.rootId, roots);
    if (root.kind !== 'resolved') return root;
    const include = stringArrayValue(item.include);
    const contextLines = normalizedNonNegativeInteger(item.contextLines);
    const maxResults = normalizedPositiveInteger(item.maxResults);
    const resourceRef = '.';
    return {
      kind: 'entry',
      entry: {
        id: `search-${sanitizeId(root.root.rootId)}-${sanitizeId(item.id)}`,
        kind: 'search',
        label: `Search ${query}`,
        resourceRef,
        readPolicy: 'autoRead',
        reason: item.reason || `Search under conversation root ${root.root.rootId}.`,
        rootId: root.root.rootId,
        resourceId: root.root.resourceId,
        contextUse: 'resourceEvidence',
        query,
        ...(include.length ? { include } : {}),
        ...(typeof contextLines === 'number' ? { contextLines } : {}),
        ...(typeof maxResults === 'number' ? { maxResults } : {}),
      },
    };
  }

  private searchRootForRequest(
    rootId: string | undefined,
    roots: ConversationResourceRoot[]
  ): { kind: 'resolved'; root: ConversationResourceRoot } | { kind: 'ambiguous'; reason: string } | { kind: 'unresolved'; reason: string } {
    if (!roots.length) return { kind: 'unresolved', reason: 'no available conversation root' };
    if (rootId) {
      const root = roots.find((item) => item.rootId === rootId);
      if (!root) return { kind: 'unresolved', reason: `unknown rootId ${rootId}` };
      return { kind: 'resolved', root };
    }
    const primary = roots.find((item) => item.primary);
    if (primary) return { kind: 'resolved', root: primary };
    if (roots.length === 1) return { kind: 'resolved', root: roots[0]! };
    return { kind: 'ambiguous', reason: 'search request must include rootId when multiple roots are available' };
  }

  private resolvePath(
    requestedPath: string,
    rootId: string | undefined,
    roots: ConversationResourceRoot[]
  ): ResolvedRequestPath {
    const trimmed = requestedPath.trim();
    if (!trimmed) return { kind: 'unresolved', reason: 'empty path' };
    if (!roots.length) return { kind: 'unresolved', reason: 'no available conversation root' };

    if (rootId) {
      const root = roots.find((item) => item.rootId === rootId);
      if (!root) return { kind: 'unresolved', reason: `unknown rootId ${rootId}` };
      const relativePath = relativePathForRoot(trimmed, root, true);
      if (!relativePath) return { kind: 'unresolved', reason: `path is outside root ${rootId}` };
      return { kind: 'resolved', root, relativePath };
    }

    if (isAbsolutePath(trimmed)) {
      const matches = roots
        .map((root) => ({ root, relativePath: relativePathForRoot(trimmed, root, true) }))
        .filter((item): item is { root: ConversationResourceRoot; relativePath: string } => Boolean(item.relativePath))
        .sort((left, right) => comparablePath(right.root.absolutePath ?? right.root.displayPath).length - comparablePath(left.root.absolutePath ?? left.root.displayPath).length);
      if (matches.length === 0) return { kind: 'unresolved', reason: 'absolute path is outside explicit attachments and project roots' };
      return { kind: 'resolved', root: matches[0].root, relativePath: matches[0].relativePath };
    }

    const explicitMatches = roots
      .map((root) => ({ root, relativePath: relativePathForRoot(trimmed, root, false) }))
      .filter((item): item is { root: ConversationResourceRoot; relativePath: string } => Boolean(item.relativePath));
    if (explicitMatches.length > 0) {
      explicitMatches.sort((left, right) => right.root.displayPath.length - left.root.displayPath.length);
      return { kind: 'resolved', root: explicitMatches[0].root, relativePath: explicitMatches[0].relativePath };
    }

    const relativePath = normalizeRelativePath(trimmed);
    if (!relativePath) return { kind: 'unresolved', reason: 'path traversal or empty relative path is not allowed' };
    const sorted = [...roots].sort((left, right) => rootPriority(left) - rootPriority(right));
    const bestPriority = rootPriority(sorted[0]);
    const candidates = sorted.filter((root) => rootPriority(root) === bestPriority);
    if (candidates.length === 1) {
      return { kind: 'resolved', root: candidates[0], relativePath };
    }
    return {
      kind: 'ambiguous',
      reason: `multiple roots at the same priority: ${candidates.map((root) => root.rootId).join(', ')}`,
    };
  }
}

function relativePathForRoot(
  requestedPath: string,
  root: ConversationResourceRoot,
  allowPlainRelative: boolean
): string | undefined {
  const normalized = normalizeSlashes(requestedPath);
  const rootKeys = [
    root.rootId,
    root.displayPath,
    root.absolutePath,
    basename(root.displayPath),
    root.absolutePath ? basename(root.absolutePath) : undefined,
  ].filter((item): item is string => Boolean(item && item.trim()));

  for (const key of rootKeys) {
    const normalizedKey = normalizeSlashes(key).replace(/\/+$/g, '');
    if (!normalizedKey) continue;
    if (normalized === normalizedKey) return '.';
    if (normalized.startsWith(`${normalizedKey}/`)) {
      return normalizeRelativePath(normalized.slice(normalizedKey.length + 1));
    }
  }

  if (isAbsolutePath(normalized)) {
    const rootPath = root.absolutePath ? normalizeSlashes(root.absolutePath).replace(/\/+$/g, '') : undefined;
    if (!rootPath) return undefined;
    if (normalized === rootPath) return '.';
    if (!normalized.startsWith(`${rootPath}/`)) return undefined;
    return normalizeRelativePath(normalized.slice(rootPath.length + 1));
  }

  return allowPlainRelative ? normalizeRelativePath(normalized) : undefined;
}

function normalizedNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

function normalizedPositiveInteger(value: unknown): number | undefined {
  const integer = normalizedNonNegativeInteger(value);
  return typeof integer === 'number' && integer > 0 ? integer : undefined;
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeSlashes(value).replace(/^\.\/+/, '').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return undefined;
    parts.push(part);
  }
  return parts.join('/') || '.';
}

function normalizeSlashes(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function comparablePath(value: string): string {
  return normalizeSlashes(value).replace(/\/+$/g, '');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}

function basename(value: string): string {
  const normalized = normalizeSlashes(value).replace(/\/+$/g, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function rootPriority(root: ConversationResourceRoot): number {
  if (root.primary) return -1;
  if (root.source === 'currentAttachment') return 0;
  if (root.source === 'sessionAttachment') return 1;
  if (root.source === 'projectWorkingDirectory') return 2;
  if (root.source === 'recentAttachment') return 3;
  return 4;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'resource';
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
