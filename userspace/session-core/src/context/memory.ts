import type { AgentEvent } from '@deepcode/protocol';
import {
  buildMemoryArchiveDescriptor,
  buildMemoryArchiveSidecar,
  renderMemoryArchiveMarkdown,
  type MemoryArchiveDescriptor,
  type MemoryArchiveSidecar,
} from './memoryArchive.js';
import { compileSessionMemoryDocument } from './memoryCompiler.js';

export type MemoryItemScope = 'project' | 'session';
export type MemoryItemKind = 'fact' | 'intent' | 'decision' | 'resource' | 'habit' | 'risk' | 'checkpoint';
export type MemoryItemAuthority = 'kernelFact' | 'resourcePacket' | 'userDecision' | 'userRuler' | 'summary';
export type MemoryCompressionMode = 'raw' | 'summary' | 'handleOnly';
export type ProjectMemoryMode = 'confirm' | 'auto';
export type MemoryCandidateStatus = 'pending' | 'auto-promoted' | 'confirmed' | 'rejected' | 'deprecated' | 'superseded';
export type MemoryRiskClass = 'low' | 'medium' | 'high';
export type MemoryCandidateCreatedBy = 'rule' | 'llmCompression' | 'user';

export interface MemoryItemV4 {
  id: string;
  scope: MemoryItemScope;
  kind: MemoryItemKind;
  authority: MemoryItemAuthority;
  content: string;
  freshness: {
    workspaceScopeKey?: string;
    path?: string;
    range?: { offsetBytes?: number; limitBytes?: number };
    symbol?: string;
    query?: string;
    sourceHash?: string;
    contentHash?: string;
    lastVerifiedAt?: string;
    staleAfter?: string;
  };
  sourceRefs: {
    eventIds: string[];
    resourcePacketIds?: string[];
    resourceBlockKeys?: string[];
    ledgerRefs?: string[];
    auditRefs?: string[];
  };
  compression?: {
    mode: MemoryCompressionMode;
    reason?: string;
    originalCharCount?: number;
  };
  governance?: {
    status: MemoryCandidateStatus;
    riskClass: MemoryRiskClass;
    confidence: number;
    semanticKey: string;
    createdBy: MemoryCandidateCreatedBy;
    projectMemoryMode?: ProjectMemoryMode;
    promotionReason?: string;
    updatedAt?: string;
  };
}

export interface SessionMemoryDocument {
  schemaVersion: '3';
  sourceEventCount: number;
  projectMemoryItems: MemoryItemV4[];
  sessionMemoryItems: MemoryItemV4[];
  pendingProjectMemoryCandidates: MemoryItemV4[];
  projectMemoryContext: string[];
  sessionMemoryContext: string[];
  longTermContext: string[];
  shortTermContext: string[];
  guidanceContext: string[];
  intentContext: string[];
  factContext: string[];
  decisionContext: string[];
  resourceContext: string[];
  archiveMetadata?: {
    projectMemoryArchiveHash: string;
    sessionMemoryArchiveHash: string;
    projectMemoryMode: ProjectMemoryMode;
    expandedMemoryItemIds: string[];
    pendingProjectMemoryCandidateIds: string[];
    memoryDroppedReasonCounts: Record<string, number>;
    auditOnlyContext: string[];
  };
}

export interface SessionMemorySnapshot {
  schemaVersion: 'deepcode.session.memory-snapshot.v1';
  sessionId?: string;
  generatedAt: string;
  sourceEventCount: number;
  softCaps: {
    projectMemoryTokens: 128000;
    sessionMemoryTokens: 256000;
  };
  projectMemoryItems: MemoryItemV4[];
  sessionMemoryItems: MemoryItemV4[];
  pendingProjectMemoryCandidates: MemoryItemV4[];
  metadata: {
    projectItemCount: number;
    sessionItemCount: number;
    pendingProjectCandidateCount: number;
    projectMemoryMode: ProjectMemoryMode;
    compressionModes: MemoryCompressionMode[];
    freshnessMode: 'compiledFromSessionEvents';
    archiveDescriptor: MemoryArchiveDescriptor;
    archiveSidecar: MemoryArchiveSidecar;
    projectMarkdownPreview: string;
    sessionMarkdownPreview: string;
  };
}

export interface BuildSessionMemorySnapshotOptions {
  sessionId?: string;
  generatedAt?: string;
  workspaceScopeKey?: string;
  displayProjectName?: string;
  displaySessionName?: string;
  projectMemoryMode?: ProjectMemoryMode;
}

export interface UserGuidanceEvent {
  id: string;
  ts?: string;
  content: string;
  source: 'user' | 'decision' | 'review' | 'system';
  checkpointKind: 'llmProposal' | 'resourcePacket' | 'permission' | 'review' | 'nextProviderCall';
}

export interface SessionMemoryRenderOptions {
  taskLocalCompaction?: {
    active: boolean;
    compactRecordCount: number;
    latestCompactHash?: string;
  };
}

export function buildSessionMemorySnapshot(
  events: AgentEvent[],
  options: BuildSessionMemorySnapshotOptions = {}
): SessionMemorySnapshot {
  const document = buildSessionMemoryDocument(events, {
    projectMemoryMode: options.projectMemoryMode,
  });
  const compressionModes = new Set<MemoryCompressionMode>();
  for (const item of [
    ...document.projectMemoryItems,
    ...document.sessionMemoryItems,
    ...document.pendingProjectMemoryCandidates,
  ]) {
    compressionModes.add(item.compression?.mode ?? 'raw');
  }
  const archiveDescriptor = buildMemoryArchiveDescriptor({
    document,
    workspaceScopeKey: options.workspaceScopeKey,
    sessionId: options.sessionId,
    displayProjectName: options.displayProjectName,
    displaySessionName: options.displaySessionName,
  });
  const archiveSidecar = buildMemoryArchiveSidecar(document, archiveDescriptor);
  return {
    schemaVersion: 'deepcode.session.memory-snapshot.v1',
    sessionId: options.sessionId,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceEventCount: document.sourceEventCount,
    softCaps: {
      projectMemoryTokens: 128000,
      sessionMemoryTokens: 256000,
    },
    projectMemoryItems: document.projectMemoryItems,
    sessionMemoryItems: document.sessionMemoryItems,
    pendingProjectMemoryCandidates: document.pendingProjectMemoryCandidates,
    metadata: {
      projectItemCount: document.projectMemoryItems.length,
      sessionItemCount: document.sessionMemoryItems.length,
      pendingProjectCandidateCount: document.pendingProjectMemoryCandidates.length,
      projectMemoryMode: document.archiveMetadata?.projectMemoryMode ?? 'confirm',
      compressionModes: [...compressionModes],
      freshnessMode: 'compiledFromSessionEvents',
      archiveDescriptor,
      archiveSidecar,
      projectMarkdownPreview: renderMemoryArchiveMarkdown({ descriptor: archiveDescriptor, document, scope: 'project' }),
      sessionMarkdownPreview: renderMemoryArchiveMarkdown({ descriptor: archiveDescriptor, document, scope: 'session' }),
    },
  };
}

export function buildSessionMemoryDocument(
  events: AgentEvent[],
  options: { projectMemoryMode?: ProjectMemoryMode } = {}
): SessionMemoryDocument {
  return compileSessionMemoryDocument(events, options);
}

export function renderProjectMemoryHints(document: SessionMemoryDocument): string[] {
  if (!document.projectMemoryItems.length && !document.archiveMetadata?.pendingProjectMemoryCandidateIds.length) return [];
  return [
    'ProjectMemoryIndexDigest (project-scoped, 128k emergency soft cap):',
    `mode=${document.archiveMetadata?.projectMemoryMode ?? 'confirm'}`,
    `archiveHash=${document.archiveMetadata?.projectMemoryArchiveHash ?? 'none'}`,
    document.archiveMetadata?.expandedMemoryItemIds.length
      ? `selectedItemIds=${document.archiveMetadata.expandedMemoryItemIds.filter((id) => id.includes(':project:')).slice(0, 24).join(', ')}`
      : 'selectedItemIds=none',
    document.archiveMetadata?.pendingProjectMemoryCandidateIds.length
      ? `pendingCandidateIds=${document.archiveMetadata.pendingProjectMemoryCandidateIds.slice(0, 24).join(', ')}`
      : 'pendingCandidateIds=none',
    document.archiveMetadata?.memoryDroppedReasonCounts
      ? `dropReasons=${JSON.stringify(document.archiveMetadata.memoryDroppedReasonCounts)}`
      : 'dropReasons=none',
  ];
}

export function renderProjectMemoryRecallHints(document: SessionMemoryDocument): string[] {
  const lines = document.projectMemoryItems.map((item) => compactMemoryBullet(item));
  if (!lines.length) return [];
  return [
    'ProjectMemoryRecall (dynamic selected project memory):',
    lines.length
      ? `selectedProjectMemory:\n${capMemoryLines(lines, 16_000).map((item) => `- ${item}`).join('\n')}`
      : 'selectedProjectMemory: none',
  ];
}

function memoryHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function renderSessionScopedMemoryHints(
  document: SessionMemoryDocument,
  options: SessionMemoryRenderOptions = {}
): string[] {
  const taskLocalCompaction = options.taskLocalCompaction;
  const foldTaskLocalContent = taskLocalCompaction?.active === true;
  const lines = document.sessionMemoryItems.map((item) => compactMemoryBullet(item, {
    foldTaskLocalContent,
  }));
  if (!lines.length && !taskLocalCompaction?.active) return [];
  return [
    'SessionMemoryCompact (single-session, 256k emergency soft cap):',
    `archiveHash=${document.archiveMetadata?.sessionMemoryArchiveHash ?? 'none'}`,
    taskLocalCompaction?.active
      ? [
        'taskLocalCompaction=active',
        `compactRecordCount=${taskLocalCompaction.compactRecordCount}`,
        `latestCompactHash=${taskLocalCompaction.latestCompactHash ?? 'none'}`,
        'contentPolicy=foldPreviousTaskNonDecisionContent',
      ].join(' ')
      : 'taskLocalCompaction=inactive',
    document.archiveMetadata?.expandedMemoryItemIds.length
      ? `selectedItemIds=${document.archiveMetadata.expandedMemoryItemIds.filter((id) => id.includes(':session:')).slice(0, 32).join(', ')}`
      : 'selectedItemIds=none',
    lines.length
      ? `selectedSessionMemory:\n${capMemoryLines(lines, 256_000).map((item) => `- ${item}`).join('\n')}`
      : 'selectedSessionMemory: none',
  ];
}

function compactMemoryBullet(
  item: MemoryItemV4,
  options: { foldTaskLocalContent?: boolean } = {}
): string {
  const sourceRefs = [
    item.sourceRefs.eventIds.length ? `events=${item.sourceRefs.eventIds.join(',')}` : '',
    item.sourceRefs.ledgerRefs?.length ? `ledger=${item.sourceRefs.ledgerRefs.join(',')}` : '',
    item.sourceRefs.auditRefs?.length ? `audit=${item.sourceRefs.auditRefs.join(',')}` : '',
  ].filter(Boolean).join(' ');
  const freshness = [
    item.freshness.path ? `path=${item.freshness.path}` : '',
    item.freshness.contentHash ? `hash=${item.freshness.contentHash}` : '',
  ].filter(Boolean).join(' ');
  return [
    `id=${item.id}`,
    `kind=${item.kind}`,
    `authority=${item.authority}`,
    item.governance ? `status=${item.governance.status}` : '',
    item.governance ? `risk=${item.governance.riskClass}` : '',
    freshness || 'freshness=none',
    `sourceRefs=${sourceRefs || 'synthetic:none'}`,
    memoryItemContentField(item, options),
  ].filter(Boolean).join(' | ');
}

function memoryItemContentField(
  item: MemoryItemV4,
  options: { foldTaskLocalContent?: boolean }
): string {
  if (!options.foldTaskLocalContent || !isTaskLocalFoldableMemoryItem(item)) {
    return `content=${item.content}`;
  }
  const contentHash = item.freshness.contentHash ?? memoryHash(item.content);
  const originalChars = item.compression?.originalCharCount ?? item.content.length;
  return [
    'contentFolded=true',
    `contentHash=${contentHash}`,
    `originalChars=${originalChars}`,
  ].join(' ');
}

function isTaskLocalFoldableMemoryItem(item: MemoryItemV4): boolean {
  // Explicit user decisions stay verbatim; previous task intent/checkpoint text may be represented by hashes after compaction.
  if (item.authority === 'userDecision') return false;
  return item.kind === 'intent' || item.kind === 'checkpoint' || item.kind === 'fact';
}

export function renderSessionMemoryHints(document: SessionMemoryDocument): string[] {
  return [
    'Session short-term memory document:',
    document.intentContext.length
      ? `intentContext:\n${document.intentContext.map((item) => `- ${item}`).join('\n')}`
      : 'intentContext: none',
    document.factContext.length
      ? `factContext:\n${document.factContext.map((item) => `- ${item}`).join('\n')}`
      : 'factContext: none',
    document.decisionContext.length
      ? `decisionContext:\n${document.decisionContext.map((item) => `- ${item}`).join('\n')}`
      : 'decisionContext: none',
    document.resourceContext.length
      ? `resourceContext:\n${document.resourceContext.map((item) => `- ${item}`).join('\n')}`
      : 'resourceContext: none',
  ];
}

export function renderStableSessionMemoryHints(document: SessionMemoryDocument): string[] {
  return renderProjectMemoryHints(document);
}

export function renderDynamicSessionMemoryHints(document: SessionMemoryDocument): string[] {
  return renderSessionScopedMemoryHints(document);
}

export function collectUserGuidanceEvents(events: AgentEvent[], runId?: string): UserGuidanceEvent[] {
  const collected: UserGuidanceEvent[] = [];
  const consumedAuthorities = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'user_guidance') continue;
    const record = objectRecord(event.payload);
    if (!record || stringValue(record.status) !== 'consumed') continue;
    const eventRunId = stringValue(record.runId) ?? stringValue(record.targetRunId) ?? '';
    consumedAuthorities.add(
      `${eventRunId}:${stringValue(record.guidanceId) ?? event.id}`
    );
  }
  for (const event of events) {
    const record = objectRecord(event.payload);
    if (!record) continue;
    const eventRunId = stringValue(record.runId) ?? stringValue(record.targetRunId);
    if (runId && eventRunId && eventRunId !== runId) continue;
    if (event.kind === 'user_guidance') {
      const guidanceId = stringValue(record.guidanceId) ?? event.id;
      const authorityKey = `${eventRunId ?? ''}:${guidanceId}`;
      if (
        stringValue(record.status) === 'consumed'
        || consumedAuthorities.has(authorityKey)
      ) continue;
      const content = stringValue(record.content) ?? stringValue(record.guidance) ?? stringValue(record.summary);
      if (content) {
        collected.push({
          id: guidanceId,
          ts: event.ts,
          content: clip(content, 600),
          source: 'user',
          checkpointKind: 'nextProviderCall',
        });
      }
    }
    if (event.kind === 'requirement_decision' || event.kind === 'plan_review') {
      const guidance = stringValue(record.guidance);
      if (guidance) {
        collected.push({
          id: event.id,
          ts: event.ts,
          content: clip(guidance, 600),
          source: 'decision',
          checkpointKind: event.kind === 'plan_review' ? 'permission' : 'llmProposal',
        });
      }
    }
    if (event.kind === 'review_summary' && stringValue(record.status) === 'needsRevision') {
      const content = stringValue(record.content) ?? stringValue(record.summary);
      if (content) {
        collected.push({
          id: event.id,
          ts: event.ts,
          content: clip(content, 600),
          source: 'review',
          checkpointKind: 'review',
        });
      }
    }
    if (event.kind === 'workflow_stage') {
      const traceKind = stringValue(record.traceKind);
      const kernelEvent = objectRecord(record.kernelEvent);
      const kernelTraceKind = stringValue(kernelEvent?.traceKind);
      if (traceKind === 'user.guidance' || kernelTraceKind === 'user.guidance') {
        const content = stringValue(record.content)
          ?? stringValue(record.summary)
          ?? stringValue(kernelEvent?.content)
          ?? stringValue(kernelEvent?.summary);
        if (content) {
          collected.push({
            id: event.id,
            ts: event.ts,
            content: clip(content, 600),
            source: 'user',
            checkpointKind: 'nextProviderCall',
          });
        }
      }
    }
  }
  return dedupeGuidance(collected);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function capMemoryLines(values: string[], softTokenCap: number): string[] {
  const maxChars = softTokenCap * 4;
  const result: string[] = [];
  let total = 0;
  for (const value of values) {
    const nextLength = value.length + 3;
    if (total + nextLength > maxChars) break;
    result.push(value);
    total += nextLength;
  }
  return result;
}

function dedupeGuidance(values: UserGuidanceEvent[]): UserGuidanceEvent[] {
  const seen = new Set<string>();
  const result: UserGuidanceEvent[] = [];
  for (const value of [...values].reverse()) {
    const key = `${value.source}:${value.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.reverse();
}
