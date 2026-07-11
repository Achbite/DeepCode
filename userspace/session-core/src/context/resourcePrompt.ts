import { stableHash } from '../cache/canonicalizer.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ResourceBlockRetention,
  ResourceManifestEntry,
  ResourcePacket,
  ResourcePacketItem,
  ResourcePromptBlock,
  ResourcePromptContext,
} from './types.js';

const FULL_TEXT_CHAR_LIMIT = 6000;
const DYNAMIC_READ_FULL_TEXT_BUDGET_CHARS = 24000;
const SUMMARY_HEAD_CHARS = 720;
const SUMMARY_TAIL_CHARS = 220;
const DIRECTORY_TREE_SUMMARY_CHAR_LIMIT = 4000;
const DIRECTORY_TREE_COMPACT_ENTRY_LIMIT = 160;
const MANIFEST_ENTRY_LIMIT = 80;
const DEFAULT_MANIFEST_SUMMARY = 'auto-read resource approved by manifest policy';

export interface BuildResourcePromptContextInput {
  initialContext?: InitialContextPacket;
  conversationRoots?: ConversationResourceRoot[];
  resourcePackets?: ResourcePacket[];
  taskLocalCompaction?: {
    active: boolean;
    currentTaskTargets?: string[];
    currentTaskPacketIds?: string[];
  };
}

interface ResourcePromptBlockDraft {
  blockKey: string;
  packet: ResourcePacket;
  item: ResourcePacketItem;
  content: string;
  contentHash: string;
  displayRef: string;
}

export function buildResourcePromptContext(input: BuildResourcePromptContextInput): ResourcePromptContext {
  const manifestEntries = new Map<string, ResourceManifestEntry>();
  for (const entry of input.initialContext?.manifest.entries ?? []) {
    manifestEntries.set(entry.id, entry);
  }
  const resourcePackets = input.resourcePackets ?? [];
  const drafts: ResourcePromptBlockDraft[] = [];
  const orderedKeys: string[] = [];
  const blocksByKey = new Map<string, ResourcePromptBlock>();
  const currentTaskTargets = normalizedTargetSet(
    input.taskLocalCompaction?.currentTaskTargets ?? [],
    input.conversationRoots ?? []
  );

  for (let packetIndex = 0; packetIndex < resourcePackets.length; packetIndex += 1) {
    const packet = resourcePackets[packetIndex]!;
    for (let itemIndex = 0; itemIndex < packet.items.length; itemIndex += 1) {
      const item = packet.items[itemIndex]!;
      const entry = manifestEntries.get(item.manifestEntryId);
      const content = item.promptContent ?? item.contentSummary ?? '';
      const contentHash = stableHash(content);
      const displayRef = resourceDisplayRef(item, entry);
      const blockKey = stableHash([
        packet.workspaceScopeKey,
        displayRef,
        String(item.offsetBytes ?? 0),
        String(item.limitBytes ?? 'full'),
        contentHash,
      ].join('\n'));
      drafts.push({
        blockKey,
        packet,
        item,
        content,
        contentHash,
        displayRef,
      });
    }
  }

  const fullTextBlockKeys = selectFullTextResourceBlockKeys(drafts, {
    foldNonCurrentTaskBlocks: input.taskLocalCompaction?.active === true,
    currentTaskTargets,
    currentTaskPacketIds: new Set(input.taskLocalCompaction?.currentTaskPacketIds ?? []),
    conversationRoots: input.conversationRoots ?? [],
  });
  for (const draft of drafts) {
    const { blockKey, packet, item, content, contentHash, displayRef } = draft;
    const retention = chooseRetention(item, content, fullTextBlockKeys.has(blockKey));
    const summary = resourceSummary(item, content, retention);
    const block: ResourcePromptBlock = {
      blockKey,
      workspaceScopeKey: packet.workspaceScopeKey,
      manifestEntryId: item.manifestEntryId,
      displayRef,
      contentHash,
      retention,
      status: item.status,
      readPolicy: item.readPolicy,
      contentKind: item.contentKind,
      originalBytes: item.originalBytes,
      offsetBytes: item.offsetBytes,
      limitBytes: item.limitBytes,
      returnedBytes: item.returnedBytes,
      rangeComplete: item.rangeComplete,
      truncated: item.truncated,
      charLength: content.length,
      summaryCharLength: summary.length,
      fullTextCharLength: retention === 'full' ? content.length : 0,
      summary,
      handle: resourceHandle(item, displayRef),
      content: retention === 'full' ? content : undefined,
      volatileFieldStripped: hasVolatileResourceFields(packet, item),
      sourceKind: item.sourceKind,
    };
    if (!blocksByKey.has(blockKey)) orderedKeys.push(blockKey);
    blocksByKey.set(blockKey, block);
  }

  const resourceBlocks = orderedKeys
    .map((key) => blocksByKey.get(key))
    .filter((block): block is ResourcePromptBlock => Boolean(block));
  const renderedContext = renderResourcePromptContext(input, resourceBlocks);
  return {
    schemaVersion: 'deepcode.session.resource-prompt-context.v1',
    renderedContext,
    resourceBlocks,
    resourceFullTextCharCount: resourceBlocks.reduce((sum, block) => sum + block.fullTextCharLength, 0),
    resourceSummaryCharCount: resourceBlocks.reduce((sum, block) => (
      block.retention === 'full' ? sum : sum + block.summaryCharLength
    ), 0),
    strippedVolatileFieldCount: resourceBlocks.filter((block) => block.volatileFieldStripped).length,
    fullBlockCount: resourceBlocks.filter((block) => block.retention === 'full').length,
    summaryBlockCount: resourceBlocks.filter((block) => block.retention === 'summary').length,
    handleOnlyBlockCount: resourceBlocks.filter((block) => block.retention === 'handleOnly').length,
    deniedBlockCount: resourceBlocks.filter((block) => block.retention === 'denied').length,
    errorBlockCount: resourceBlocks.filter((block) => block.retention === 'error').length,
  };
}

function selectFullTextResourceBlockKeys(
  drafts: ResourcePromptBlockDraft[],
  options: {
    foldNonCurrentTaskBlocks: boolean;
    currentTaskTargets: Set<string>;
    currentTaskPacketIds: Set<string>;
    conversationRoots: ConversationResourceRoot[];
  }
): Set<string> {
  const selected = new Set<string>();
  let used = 0;
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    const draft = drafts[index]!;
    if (selected.has(draft.blockKey) || !resourceBlockFullTextEligible(draft.item, draft.content)) continue;
    if (
      options.foldNonCurrentTaskBlocks &&
      !options.currentTaskPacketIds.has(draft.packet.id) &&
      !resourceBlockMatchesCurrentTask(draft, options.currentTaskTargets, options.conversationRoots)
    ) continue;
    const nextUsed = used + draft.content.length;
    if (nextUsed > DYNAMIC_READ_FULL_TEXT_BUDGET_CHARS) continue;
    selected.add(draft.blockKey);
    used = nextUsed;
  }
  return selected;
}

function resourceBlockMatchesCurrentTask(
  draft: ResourcePromptBlockDraft,
  currentTaskTargets: Set<string>,
  roots: ConversationResourceRoot[]
): boolean {
  if (currentTaskTargets.size === 0) return false;
  const refs = resourcePathIdentities(draft.displayRef, roots);
  if (!refs.length) return false;
  for (const ref of refs) {
    for (const target of currentTaskTargets) {
      if (ref === target || ref.startsWith(`${target}/`)) return true;
    }
  }
  return false;
}

function resourceBlockFullTextEligible(item: ResourcePacketItem, content: string): boolean {
  if (item.status === 'denied' || item.status === 'needsUserApproval') return false;
  if (item.status === 'error' || item.status === 'skipped') return false;
  if (!content.trim()) return false;
  if (item.contentKind === 'directoryTree' || item.contentKind === 'searchResults') return false;
  return !item.truncated && content.length <= FULL_TEXT_CHAR_LIMIT;
}

function chooseRetention(item: ResourcePacketItem, content: string, keepFullText: boolean): ResourceBlockRetention {
  if (item.status === 'denied' || item.status === 'needsUserApproval') return 'denied';
  if (item.status === 'error') return 'error';
  if (item.status === 'skipped') return 'handleOnly';
  if (!content.trim()) return 'handleOnly';
  if (item.contentKind === 'directoryTree' || item.contentKind === 'searchResults') return 'summary';
  if (keepFullText && !item.truncated && content.length <= FULL_TEXT_CHAR_LIMIT) return 'full';
  return 'summary';
}

function resourceDisplayRef(item: ResourcePacketItem, entry: ResourceManifestEntry | undefined): string {
  return entry?.resourceRef
    ?? item.path
    ?? item.absolutePath
    ?? item.manifestEntryId;
}

function resourceHandle(item: ResourcePacketItem, displayRef: string): string {
  const range = [
    typeof item.offsetBytes === 'number' ? `offsetBytes=${item.offsetBytes}` : '',
    typeof item.limitBytes === 'number' ? `limitBytes=${item.limitBytes}` : '',
  ].filter(Boolean).join(' ');
  return range ? `${displayRef} ${range}` : displayRef;
}

function normalizedTargetSet(
  targets: string[],
  roots: ConversationResourceRoot[]
): Set<string> {
  return new Set(targets.flatMap((target) => resourcePathIdentities(target, roots)));
}

function normalizeResourcePathForMatch(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replace(/\/$/, '');
  return normalized || undefined;
}

function resourcePathIdentities(
  value: string | undefined,
  roots: ConversationResourceRoot[]
): string[] {
  const normalized = normalizeResourcePathForMatch(value);
  if (!normalized) return [];
  const identities = new Set([normalized]);
  for (const root of roots) {
    const rootPath = normalizeResourcePathForMatch(root.absolutePath ?? root.displayPath);
    if (!rootPath) continue;
    if (normalized === rootPath) identities.add('.');
    if (normalized.startsWith(`${rootPath}/`)) identities.add(normalized.slice(rootPath.length + 1));
  }
  return [...identities];
}

function resourceSummary(item: ResourcePacketItem, content: string, retention: ResourceBlockRetention): string {
  if (retention === 'denied') return item.denialReason ?? 'Resource is not available without user approval.';
  if (retention === 'error') return item.denialReason ?? 'Resource read failed.';
  if (item.status === 'skipped') return item.skipMessage ?? item.contentSummary ?? 'Resource was skipped by Kernel content policy.';
  if (retention === 'handleOnly') return item.contentSummary ?? 'Resource handle only; request a focused range if full content is needed.';
  const normalized = normalizeContent(content);
  if (item.contentKind === 'directoryTree') {
    if (!normalized) {
      return item.contentSummary ?? 'Directory inventory handle only; request a focused directory read if file listing is needed.';
    }
    const compact = compactDirectoryTreeSummary(normalized);
    if (compact) return compact;
    if (normalized.length <= DIRECTORY_TREE_SUMMARY_CHAR_LIMIT) return normalized;
    return [
      normalized.slice(0, DIRECTORY_TREE_SUMMARY_CHAR_LIMIT - SUMMARY_TAIL_CHARS),
      '[... directory inventory clipped; request a focused directory read only when omitted detail is required ...]',
      normalized.slice(-SUMMARY_TAIL_CHARS),
    ].join('\n');
  }
  if (isInformativeSummary(item.contentSummary)) return item.contentSummary!.trim();
  if (normalized.length <= SUMMARY_HEAD_CHARS + SUMMARY_TAIL_CHARS + 40) {
    return normalized;
  }
  return [
    normalized.slice(0, SUMMARY_HEAD_CHARS),
    '[... resource summary clipped; request a focused range if more detail is needed ...]',
    normalized.slice(-SUMMARY_TAIL_CHARS),
  ].join('\n');
}

function compactDirectoryTreeSummary(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  const entries: string[] = [];
  let observed = 0;
  const visit = (node: unknown): void => {
    if (observed >= DIRECTORY_TREE_COMPACT_ENTRY_LIMIT || !node || typeof node !== 'object' || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    observed += 1;
    if (entries.length < DIRECTORY_TREE_COMPACT_ENTRY_LIMIT) {
      entries.push(compactDirectoryTreeNode(record));
    }
    const children = Array.isArray(record.children) ? record.children : [];
    for (const child of children) visit(child);
  };
  for (const root of roots) visit(root);
  if (!observed && !entries.length) return undefined;
  const lines = [
    'Directory inventory summary (Kernel observed):',
    ...entries,
  ];
  if (observed >= DIRECTORY_TREE_COMPACT_ENTRY_LIMIT) {
    lines.push(`- additional entries omitted after limit=${DIRECTORY_TREE_COMPACT_ENTRY_LIMIT}; request a focused directory read if omitted detail is required.`);
  }
  return lines.join('\n');
}

function compactDirectoryTreeNode(record: Record<string, unknown>): string {
  const type = typeof record.type === 'string' ? record.type : 'entry';
  const path = typeof record.path === 'string'
    ? record.path
    : typeof record.name === 'string'
      ? record.name
      : '<unknown>';
  if (type === 'directory') return `- dir ${path}`;
  const classification = record.fileClassification && typeof record.fileClassification === 'object' && !Array.isArray(record.fileClassification)
    ? record.fileClassification as Record<string, unknown>
    : {};
  const attrs = [
    typeof classification.kind === 'string' ? `kind=${classification.kind}` : '',
    typeof classification.extension === 'string' ? `ext=${classification.extension}` : '',
    typeof classification.sizeBytes === 'number' ? `bytes=${classification.sizeBytes}` : '',
    typeof classification.readableText === 'boolean' ? `readableText=${classification.readableText}` : '',
    typeof classification.executable === 'boolean' ? `executable=${classification.executable}` : '',
    typeof classification.binary === 'boolean' ? `binary=${classification.binary}` : '',
  ].filter(Boolean).join(' ');
  return attrs ? `- file ${path} ${attrs}` : `- ${type} ${path}`;
}

function isInformativeSummary(value: string | undefined): boolean {
  return Boolean(value?.trim()) && value!.trim() !== DEFAULT_MANIFEST_SUMMARY;
}

function renderResourcePromptContext(
  input: BuildResourcePromptContextInput,
  resourceBlocks: ResourcePromptBlock[]
): string {
  const lines: string[] = [
    'ResourceEvidence contains Kernel-observed read facts. Block keys are stable handles derived from scope, path, range, and content hash.',
  ];

  if (input.conversationRoots?.length) {
    lines.push('Conversation roots:');
    for (const root of input.conversationRoots) {
      lines.push(`- rootId=${root.rootId} path=${root.displayPath}${root.primary ? ' primary=true' : ''}`);
    }
    lines.push('For more facts, call session.request_resources with rootId plus a relative path, range, or search query. Do not request an already sufficient block again.');
  }

  if (input.initialContext) {
    lines.push(`ResourceManifest entries=${input.initialContext.manifest.entries.length}`);
    for (const entry of input.initialContext.manifest.entries.slice(0, MANIFEST_ENTRY_LIMIT)) {
      lines.push(`- manifestEntry id=${entry.id} kind=${entry.kind} ref=${entry.resourceRef} policy=${entry.readPolicy}`);
    }
    if (input.initialContext.manifest.entries.length > MANIFEST_ENTRY_LIMIT) {
      lines.push(`- manifestEntry list truncated: ${input.initialContext.manifest.entries.length - MANIFEST_ENTRY_LIMIT} additional entries omitted`);
    }
  }

  if (!resourceBlocks.length) {
    lines.push('ResourceBlocks: none');
    return lines.join('\n');
  }

  lines.push(`ResourceBlocks: ${resourceBlocks.length}`);
  for (const block of resourceBlocks) {
    const range = [
      typeof block.offsetBytes === 'number' ? `offset=${block.offsetBytes}` : '',
      typeof block.returnedBytes === 'number' ? `bytes=${block.returnedBytes}` : '',
      block.truncated ? 'truncated=true' : '',
    ].filter(Boolean).join(' ');
    lines.push(`- blockKey=${block.blockKey} handle=${block.handle} retention=${block.retention} status=${block.status} hash=${block.contentHash} kind=${block.contentKind ?? 'unknown'}${range ? ` ${range}` : ''}`);
    if (block.content) {
      lines.push('  content:');
      lines.push(indentBlock(fencedText(block.content)));
    } else {
      lines.push('  summary:');
      lines.push(indentBlock(block.summary));
    }
  }

  if (resourceBlocks.some((block) => block.truncated || block.retention !== 'full')) {
    lines.push('Resource reread hint: if a summary or truncated block is insufficient, request a focused segment with rootId+path plus offsetBytes/limitBytes instead of rereading every prior resource.');
  }
  return lines.join('\n');
}

function hasVolatileResourceFields(packet: ResourcePacket, item: ResourcePacketItem): boolean {
  return Boolean(packet.id || packet.requestId || item.requestItemId || item.evidenceRefs?.length);
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function indentBlock(content: string): string {
  return content
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function fencedText(content: string): string {
  return `\`\`\`text\n${content}\n\`\`\``;
}
