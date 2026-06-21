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
const SUMMARY_HEAD_CHARS = 720;
const SUMMARY_TAIL_CHARS = 220;
const MANIFEST_ENTRY_LIMIT = 80;
const DEFAULT_MANIFEST_SUMMARY = 'auto-read resource approved by manifest policy';

export interface BuildResourcePromptContextInput {
  initialContext?: InitialContextPacket;
  conversationRoots?: ConversationResourceRoot[];
  resourcePackets?: ResourcePacket[];
}

export function buildResourcePromptContext(input: BuildResourcePromptContextInput): ResourcePromptContext {
  const manifestEntries = new Map<string, ResourceManifestEntry>();
  for (const entry of input.initialContext?.manifest.entries ?? []) {
    manifestEntries.set(entry.id, entry);
  }
  const resourcePackets = input.resourcePackets ?? [];
  const latestPacketIndex = resourcePackets.length - 1;
  const orderedKeys: string[] = [];
  const blocksByKey = new Map<string, ResourcePromptBlock>();

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
      const retention = chooseRetention(item, content, packetIndex === latestPacketIndex);
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

function chooseRetention(item: ResourcePacketItem, content: string, latestPacket: boolean): ResourceBlockRetention {
  if (item.status === 'denied' || item.status === 'needsUserApproval') return 'denied';
  if (item.status === 'error') return 'error';
  if (item.status === 'skipped') return 'handleOnly';
  if (!content.trim()) return 'handleOnly';
  if (item.contentKind === 'directoryTree' || item.contentKind === 'searchResults') return 'summary';
  if (latestPacket && !item.truncated && content.length <= FULL_TEXT_CHAR_LIMIT) return 'full';
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

function resourceSummary(item: ResourcePacketItem, content: string, retention: ResourceBlockRetention): string {
  if (retention === 'denied') return item.denialReason ?? 'Resource is not available without user approval.';
  if (retention === 'error') return item.denialReason ?? 'Resource read failed.';
  if (item.status === 'skipped') return item.skipMessage ?? item.contentSummary ?? 'Resource was skipped by Kernel content policy.';
  if (retention === 'handleOnly') return item.contentSummary ?? 'Resource handle only; request a focused range if full content is needed.';
  if (isInformativeSummary(item.contentSummary)) return item.contentSummary!.trim();
  const normalized = normalizeContent(content);
  if (normalized.length <= SUMMARY_HEAD_CHARS + SUMMARY_TAIL_CHARS + 40) {
    return normalized;
  }
  return [
    normalized.slice(0, SUMMARY_HEAD_CHARS),
    '[... resource summary clipped; request a focused range if more detail is needed ...]',
    normalized.slice(-SUMMARY_TAIL_CHARS),
  ].join('\n');
}

function isInformativeSummary(value: string | undefined): boolean {
  return Boolean(value?.trim()) && value!.trim() !== DEFAULT_MANIFEST_SUMMARY;
}

function renderResourcePromptContext(
  input: BuildResourcePromptContextInput,
  resourceBlocks: ResourcePromptBlock[]
): string {
  const lines: string[] = [
    'ResourceContext policy: resource content is rendered as stable blocks. Block keys are derived from workspace scope, resource path/ref, byte range, and content hash.',
    'Volatile run ids, packet ids, request ids, event ids, evidence refs, traces, and timestamps are excluded from provider-visible resource blocks.',
  ];

  if (input.conversationRoots?.length) {
    lines.push('Conversation roots:');
    for (const root of input.conversationRoots) {
      lines.push(`- rootId=${root.rootId} source=${root.source} path=${root.displayPath}${root.primary ? ' primary=true' : ''}`);
      lines.push(`  label=${root.label}`);
    }
    lines.push('ResourceRequest path rule: use {"rootId":"<rootId>","path":"<relative path>"} for files or directories under these roots, or {"kind":"search","rootId":"<rootId>","query":"literal text","include":["optional/path/filter"],"contextLines":2,"maxResults":50} for targeted search evidence before patching.');
    const primary = input.conversationRoots.find((root) => root.primary);
    if (primary) {
      lines.push(`Primary conversation workspace root: rootId=${primary.rootId} path=${primary.displayPath}`);
      lines.push('Write path rule: actionBundle targetPath/codeBlocks targetPath must be a concrete file path relative to the primary root. Do not include rootId, manifestEntryId, display path, basename, or absolute path prefixes in write targets.');
    }
  }

  if (input.initialContext) {
    lines.push(`InitialContextPacket: ${input.initialContext.id}`);
    lines.push(`ResourceManifest: ${input.initialContext.manifest.id} entries=${input.initialContext.manifest.entries.length}`);
    for (const entry of input.initialContext.manifest.entries.slice(0, MANIFEST_ENTRY_LIMIT)) {
      lines.push(`- manifestEntry id=${entry.id} kind=${entry.kind} ref=${entry.resourceRef} policy=${entry.readPolicy}`);
      lines.push(`  label=${entry.label}`);
      lines.push(`  reason=${entry.reason}`);
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
    lines.push(`- blockKey=${block.blockKey} ref=${block.displayRef} retention=${block.retention} status=${block.status} policy=${block.readPolicy}`);
    lines.push(`  manifestEntry=${block.manifestEntryId} contentHash=${block.contentHash} chars=${block.charLength} kind=${block.contentKind ?? 'unknown'}`);
    if (typeof block.originalBytes === 'number') lines.push(`  originalBytes=${block.originalBytes}`);
    if (block.truncated) lines.push('  truncated=true');
    if (typeof block.offsetBytes === 'number') lines.push(`  offsetBytes=${block.offsetBytes}`);
    if (typeof block.limitBytes === 'number') lines.push(`  limitBytes=${block.limitBytes}`);
    if (typeof block.returnedBytes === 'number') lines.push(`  returnedBytes=${block.returnedBytes}`);
    if (typeof block.rangeComplete === 'boolean') lines.push(`  rangeComplete=${block.rangeComplete}`);
    lines.push(`  handle=${block.handle}`);
    lines.push('  summary:');
    lines.push(indentBlock(block.summary));
    if (block.content) {
      lines.push('  content:');
      lines.push(indentBlock(fencedText(block.content)));
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
