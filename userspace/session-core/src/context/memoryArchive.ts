import type { MemoryItemV4, SessionMemoryDocument } from './memory.js';

export interface MemoryArchiveDescriptor {
  schemaVersion: 'deepcode.session.memory-archive.v1';
  workspaceScopeKey?: string;
  sessionId?: string;
  displayProjectName: string;
  displaySessionName: string;
  safeProjectName: string;
  safeSessionName: string;
  logicalProjectPath: string;
  logicalSessionPath: string;
  sidecarProjectPath: string;
  sidecarSessionPath: string;
  projectMemoryArchiveHash: string;
  sessionMemoryArchiveHash: string;
}

export interface MemoryArchiveSidecar {
  schemaVersion: 'deepcode.session.memory-archive-sidecar.v1';
  descriptor: MemoryArchiveDescriptor;
  projectMemoryItems: MemoryItemV4[];
  sessionMemoryItems: MemoryItemV4[];
  metadata: {
    projectItemCount: number;
    sessionItemCount: number;
    sourceEventCount: number;
    compressionModes: string[];
    generatedFrom: 'sessionEvents';
  };
}

export function buildMemoryArchiveDescriptor(input: {
  document: SessionMemoryDocument;
  workspaceScopeKey?: string;
  sessionId?: string;
  displayProjectName?: string;
  displaySessionName?: string;
}): MemoryArchiveDescriptor {
  const displayProjectName = displayName(input.displayProjectName, input.workspaceScopeKey, 'project');
  const displaySessionName = displayName(input.displaySessionName, input.sessionId, 'session');
  const safeProjectName = sanitizeArchiveName(displayProjectName);
  const safeSessionName = sanitizeArchiveName(displaySessionName);
  const projectHash = input.document.archiveMetadata?.projectMemoryArchiveHash ?? memoryItemsHash(input.document.projectMemoryItems);
  const sessionHash = input.document.archiveMetadata?.sessionMemoryArchiveHash ?? memoryItemsHash(input.document.sessionMemoryItems);
  return {
    schemaVersion: 'deepcode.session.memory-archive.v1',
    workspaceScopeKey: input.workspaceScopeKey,
    sessionId: input.sessionId,
    displayProjectName,
    displaySessionName,
    safeProjectName,
    safeSessionName,
    logicalProjectPath: `${safeProjectName}/project.md`,
    logicalSessionPath: `${safeProjectName}/${safeSessionName}.md`,
    sidecarProjectPath: `${safeProjectName}/project.memory.json`,
    sidecarSessionPath: `${safeProjectName}/${safeSessionName}.memory.json`,
    projectMemoryArchiveHash: projectHash,
    sessionMemoryArchiveHash: sessionHash,
  };
}

export function buildMemoryArchiveSidecar(
  document: SessionMemoryDocument,
  descriptor: MemoryArchiveDescriptor
): MemoryArchiveSidecar {
  const compressionModes = new Set<string>();
  for (const item of [...document.projectMemoryItems, ...document.sessionMemoryItems]) {
    compressionModes.add(item.compression?.mode ?? 'raw');
  }
  return {
    schemaVersion: 'deepcode.session.memory-archive-sidecar.v1',
    descriptor,
    projectMemoryItems: document.projectMemoryItems,
    sessionMemoryItems: document.sessionMemoryItems,
    metadata: {
      projectItemCount: document.projectMemoryItems.length,
      sessionItemCount: document.sessionMemoryItems.length,
      sourceEventCount: document.sourceEventCount,
      compressionModes: [...compressionModes],
      generatedFrom: 'sessionEvents',
    },
  };
}

export function renderMemoryArchiveMarkdown(input: {
  descriptor: MemoryArchiveDescriptor;
  document: SessionMemoryDocument;
  scope: 'project' | 'session';
}): string {
  const items = input.scope === 'project'
    ? input.document.projectMemoryItems
    : input.document.sessionMemoryItems;
  const title = input.scope === 'project'
    ? `# ${input.descriptor.displayProjectName} Project Memory`
    : `# ${input.descriptor.displaySessionName} Session Memory`;
  const lines = [
    title,
    '',
    `Archive hash: ${input.scope === 'project' ? input.descriptor.projectMemoryArchiveHash : input.descriptor.sessionMemoryArchiveHash}`,
    '',
    'This file is a read-only memory projection generated from structured session events and Kernel facts. It is not a Kernel fact source.',
    '',
  ];
  if (!items.length) {
    lines.push('- No memory items selected.');
    return lines.join('\n');
  }
  for (const item of items) {
    lines.push(`## ${item.kind} / ${item.authority}`);
    lines.push('');
    lines.push(item.content);
    lines.push('');
    lines.push(`- id: ${item.id}`);
    lines.push(`- freshness: ${item.freshness.path ? `path=${item.freshness.path} ` : ''}${item.freshness.contentHash ?? 'none'}`);
    lines.push(`- sourceRefs: ${item.sourceRefs.eventIds.length ? item.sourceRefs.eventIds.join(', ') : 'synthetic:none'}`);
    lines.push(`- compression: ${item.compression?.mode ?? 'raw'}`);
    lines.push('');
  }
  return lines.join('\n');
}

function displayName(value: string | undefined, fallback: string | undefined, prefix: string): string {
  const selected = value?.trim() || fallback?.trim() || prefix;
  return selected.length > 80 ? `${selected.slice(0, 77)}...` : selected;
}

function sanitizeArchiveName(value: string): string {
  const safe = value
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return safe || 'memory';
}

function memoryItemsHash(items: MemoryItemV4[]): string {
  return stableHash(JSON.stringify(items.map((item) => ({
    id: item.id,
    content: item.content,
    sourceRefs: item.sourceRefs,
  }))));
}

function stableHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
