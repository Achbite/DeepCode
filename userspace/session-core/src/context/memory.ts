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

function buildLegacySessionMemoryDocument(events: AgentEvent[]): SessionMemoryDocument {
  const intentContext: string[] = [];
  const factContext: string[] = [];
  const decisionContext: string[] = [];
  const resourceContext: string[] = [];
  const longTermContext: string[] = [];
  const shortTermContext: string[] = [];
  const guidanceContext: string[] = [];
  const consumedGuidanceIds = new Set<string>();

  for (const event of events.slice(-80)) {
    if (event.kind !== 'user_guidance') continue;
    const record = objectRecord(event.payload);
    if (!record || stringValue(record.status) !== 'consumed') continue;
    consumedGuidanceIds.add(stringValue(record.guidanceId) ?? event.id);
  }

  for (const event of events.slice(-40)) {
    const record = objectRecord(event.payload);
    if (!record) continue;

    if (event.kind === 'user_msg') {
      const content = stringValue(record.content);
      const attachments = Array.isArray(record.attachments)
        ? record.attachments
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
          .map((item) => `${String(item.kind ?? 'resource')}:${String(item.path ?? item.absolutePath ?? '')}`)
          .filter((item) => item.trim().length > 0)
        : [];
      if (content) {
        const text = `User request: ${clip(content, 300)}${attachments.length ? ` attachments=${attachments.join(', ')}` : ''}`;
        intentContext.push(text);
        longTermContext.push(text);
      }
      for (const attachment of attachments.slice(0, 8)) {
        const text = `Attached resource: ${clip(attachment, 240)}`;
        resourceContext.push(text);
        longTermContext.push(text);
      }
    }

    if (event.kind === 'user_guidance' && stringValue(record.status) !== 'consumed') {
      const guidanceId = stringValue(record.guidanceId) ?? event.id;
      if (consumedGuidanceIds.has(guidanceId)) continue;
      const guidance = stringValue(record.content) ?? stringValue(record.guidance) ?? stringValue(record.summary);
      if (guidance) {
        const text = `User guidance: ${clip(guidance, 360)}`;
        guidanceContext.push(text);
        shortTermContext.push(text);
      }
    }

    if (event.kind === 'requirement_confirmation') {
      const status = stringValue(record.status) ?? 'pending';
      const summary = stringValue(record.summary) ?? stringValue(record.content) ?? '';
      if (summary.trim()) {
        const text = `Requirement draft (${status}): ${clip(summary.trim(), 300)}`;
        intentContext.push(text);
        shortTermContext.push(text);
      }
    }

    if (event.kind === 'plan_card') {
      const summary = stringValue(record.summary) ?? stringValue(record.content) ?? '';
      if (summary.trim()) {
        const text = `Plan intent: ${clip(summary.trim(), 320)}`;
        intentContext.push(text);
        shortTermContext.push(text);
      }
      const actionBundle = objectRecord(record.actionBundle);
      const continuations = Array.isArray(actionBundle?.continuationExpectations)
        ? actionBundle.continuationExpectations
        : [];
      for (const continuation of continuations.slice(0, 4)) {
        const text = continuationSummary(continuation);
        if (text) {
          const item = `Continuation intent: ${clip(text, 240)}`;
          intentContext.push(item);
          shortTermContext.push(item);
        }
      }
    }

    if (event.kind === 'review_summary') {
      const status = stringValue(record.status) ?? 'unknown';
      const content = stringValue(record.content) ?? stringValue(record.summary) ?? '';
      if (content.trim()) {
        const text = `Review ${status}: ${clip(content.trim(), 360)}`;
        const target = status === 'waitingUserReview' ? intentContext : decisionContext;
        target.push(text);
        if (status === 'waitingUserReview') {
          shortTermContext.push(text);
        } else {
          longTermContext.push(text);
        }
      }
      const facts = Array.isArray(record.facts) ? record.facts.filter((item): item is string => typeof item === 'string') : [];
      for (const fact of facts.slice(0, 8)) {
        const text = `Review fact: ${clip(fact, 260)}`;
        factContext.push(text);
        longTermContext.push(text);
      }
      if (status === 'accepted' || status === 'needsRevision' || status === 'rejected') {
        const text = `Review decision: ${status}${content.trim() ? ` guidance=${clip(content.trim(), 240)}` : ''}`;
        decisionContext.push(text);
        longTermContext.push(text);
        if (status === 'needsRevision') guidanceContext.push(text);
      }
    }

    if (event.kind === 'requirement_decision' || event.kind === 'plan_review') {
      const status = stringValue(record.status) ?? stringValue(record.decision) ?? 'unknown';
      const summary = stringValue(record.summary) ?? stringValue(record.content) ?? '';
      const text = `${event.kind}: ${status}${summary.trim() ? ` ${clip(summary.trim(), 240)}` : ''}`;
      decisionContext.push(text);
      longTermContext.push(text);
      const guidance = stringValue(record.guidance);
      if (guidance) {
        const guidanceText = `User guidance: ${clip(guidance, 360)}`;
        guidanceContext.push(guidanceText);
        shortTermContext.push(guidanceText);
      }
    }

    if (event.kind === 'assistant_msg') {
      const channel = stringValue(record.channel) ?? '';
      if (channel && channel !== 'final') continue;
      const content = stringValue(record.content);
      if (content) {
        shortTermContext.push(`Assistant final summary: ${clip(content, 220)}`);
      }
    }

    if (event.kind === 'tool_result') {
      const toolName = stringValue(record.toolName) ?? 'tool';
      const summary = stringValue(record.summary) ?? '';
      if (summary.trim()) {
        const text = `Resource/tool fact ${toolName}: ${clip(summary.trim(), 260)}`;
        factContext.push(text);
        longTermContext.push(text);
      }
      const output = objectRecord(record.output);
      if (output) {
        const items = Array.isArray(output.items) ? output.items : [];
        for (const item of items.slice(0, 6)) {
          const resource = objectRecord(item);
          const path = stringValue(resource?.path) ?? stringValue(resource?.absolutePath) ?? stringValue(resource?.manifestEntryId);
          const kind = stringValue(resource?.contentKind) ?? stringValue(resource?.resolvedKind) ?? 'resource';
          if (path) {
            const fact = `ResourcePacket fact: ${kind} ${clip(path, 220)}`;
            factContext.push(fact);
            resourceContext.push(fact);
            longTermContext.push(fact);
          }
        }
      }
    }

    if (event.kind === 'workflow_stage') {
      const stage = stringValue(record.stage);
      if (stage === 'accepted_plan.task_savepoint') {
        const summary = stringValue(record.summary) ?? '';
        const taskId = stringValue(record.taskId);
        const nodeId = stringValue(record.nodeId);
        const nextReadyNodeIds = Array.isArray(record.nextReadyNodeIds)
          ? record.nextReadyNodeIds.filter((item): item is string => typeof item === 'string')
          : [];
        const text = [
          'Accepted task savepoint:',
          taskId ? `task=${taskId}` : '',
          nodeId ? `node=${nodeId}` : '',
          summary ? clip(summary, 260) : '',
          nextReadyNodeIds.length ? `nextReady=${nextReadyNodeIds.join(',')}` : '',
        ].filter(Boolean).join(' ');
        intentContext.push(text);
        shortTermContext.push(text);
      }
      const kernelEvent = objectRecord(record.kernelEvent);
      if (!kernelEvent) continue;
      const kind = stringValue(kernelEvent.kind);
      if (kind === 'tool.completed') {
        const ok = kernelEvent.ok === true;
        const output = objectRecord(kernelEvent.output);
        const path = stringValue(output?.path) ?? stringValue(output?.absolutePath);
        const validation = objectRecord(output?.validation);
        const validationKind = stringValue(validation?.kind);
        const origin = stringValue(output?.artifactOrigin);
        const text = `ToolCompleted fact: ok=${ok}${path ? ` path=${clip(path, 220)}` : ''}${validationKind ? ` validation=${validationKind}` : ''}${origin ? ` artifactOrigin=${origin}` : ''}`;
        factContext.push(text);
        longTermContext.push(text);
        if (origin === 'agentGenerated' && path) {
          resourceContext.push(`Agent-generated artifact fact: ${clip(path, 220)}`);
        }
      }
      if (kind === 'work_unit.completed' || kind === 'work_unit.failed' || kind === 'work_unit.blocked') {
        const workUnitId = stringValue(kernelEvent.workUnitId);
        const output = objectRecord(kernelEvent.output);
        const path = stringValue(output?.path) ?? stringValue(output?.absolutePath);
        const text = `WorkUnit fact: ${kind}${workUnitId ? ` id=${clip(workUnitId, 160)}` : ''}${path ? ` path=${clip(path, 220)}` : ''}`;
        factContext.push(text);
        longTermContext.push(text);
      }
    }
  }

  const projectMemoryItems = capMemoryItems(dedupeMemoryItems([
    ...longTermContext.map((content) => memoryItem('project', 'checkpoint', 'summary', content)),
    ...resourceContext.map((content) => memoryItem('project', 'resource', 'resourcePacket', content)),
    ...factContext.map((content) => memoryItem('project', 'fact', factAuthority(content), content)),
    ...decisionContext.map((content) => memoryItem('project', 'decision', 'userDecision', content)),
  ], 40), 128_000);
  const sessionMemoryItems = capMemoryItems(dedupeMemoryItems([
    ...shortTermContext.map((content) => memoryItem('session', 'checkpoint', 'summary', content)),
    ...intentContext.map((content) => memoryItem('session', 'intent', 'summary', content)),
    ...guidanceContext.map((content) => memoryItem('session', 'decision', 'userDecision', content)),
    ...decisionContext.map((content) => memoryItem('session', 'decision', 'userDecision', content)),
    ...factContext.slice(-8).map((content) => memoryItem('session', 'fact', factAuthority(content), content)),
  ], 48), 256_000);

  return {
    schemaVersion: '3',
    sourceEventCount: events.length,
    projectMemoryItems,
    sessionMemoryItems,
    pendingProjectMemoryCandidates: [],
    projectMemoryContext: projectMemoryItems.map(renderMemoryItemLine),
    sessionMemoryContext: sessionMemoryItems.map(renderMemoryItemLine),
    longTermContext: dedupeKeepLast(longTermContext, 18),
    shortTermContext: dedupeKeepLast(shortTermContext, 12),
    guidanceContext: dedupeKeepLast(guidanceContext, 10),
    intentContext: intentContext.slice(-10),
    factContext: factContext.slice(-14),
    decisionContext: decisionContext.slice(-10),
    resourceContext: resourceContext.slice(-12),
    archiveMetadata: {
      projectMemoryArchiveHash: memoryHash(JSON.stringify(projectMemoryItems.map((item) => item.id))),
      sessionMemoryArchiveHash: memoryHash(JSON.stringify(sessionMemoryItems.map((item) => item.id))),
      projectMemoryMode: 'confirm',
      expandedMemoryItemIds: [
        ...projectMemoryItems.map((item) => item.id),
        ...sessionMemoryItems.map((item) => item.id),
      ],
      pendingProjectMemoryCandidateIds: [],
      memoryDroppedReasonCounts: { retained: projectMemoryItems.length + sessionMemoryItems.length },
      auditOnlyContext: [],
    },
  };
}

export function renderProjectMemoryHints(document: SessionMemoryDocument): string[] {
  return [
    'ProjectMemoryIndexDigest (project-scoped, 128k emergency soft cap):',
    'Boundary: shared project memory stores durable norms, user preferences, historical gotchas, long-term planning summaries, and cross-session decision indexes. It is not Kernel authority and must be refreshed from ResourcePacket/tool facts when code may have changed.',
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
  const lines = document.projectMemoryItems.map(compactMemoryBullet);
  return [
    'ProjectMemoryRecall (dynamic selected project memory; refresh file facts before modifying files):',
    lines.length
      ? `selectedProjectMemory:\n${capMemoryLines(lines, 16_000).map((item) => `- ${item}`).join('\n')}`
      : 'selectedProjectMemory: none',
  ];
}

function memoryItem(
  scope: MemoryItemScope,
  kind: MemoryItemKind,
  authority: MemoryItemAuthority,
  content: string
): MemoryItemV4 {
  const clipped = clip(content, scope === 'project' ? 520 : 640);
  const contentHash = memoryHash(clipped);
  return {
    id: `memory-v4:${scope}:${kind}:${authority}:${contentHash}`,
    scope,
    kind,
    authority,
    content: clipped,
    freshness: {
      path: pathFromMemoryContent(clipped),
      contentHash,
    },
    sourceRefs: {
      eventIds: [],
    },
    compression: {
      mode: content.length === clipped.length ? 'raw' : 'summary',
      reason: content.length === clipped.length ? 'within memory item budget' : 'clipped for memory soft cap rendering',
      originalCharCount: content.length,
    },
  };
}

function factAuthority(content: string): MemoryItemAuthority {
  if (content.startsWith('ToolCompleted fact') || content.startsWith('WorkUnit fact')) return 'kernelFact';
  if (content.startsWith('ResourcePacket fact') || content.startsWith('Agent-generated artifact fact')) return 'resourcePacket';
  return 'summary';
}

function renderMemoryItemLine(item: MemoryItemV4): string {
  const freshness = [
    item.freshness.path ? `path=${item.freshness.path}` : '',
    item.freshness.contentHash ? `hash=${item.freshness.contentHash}` : '',
  ].filter(Boolean).join(' ');
  const compression = item.compression
    ? `compression=${item.compression.mode}${item.compression.reason ? ` reason=${item.compression.reason}` : ''}`
    : 'compression=raw';
  return [
    `MemoryItemV4 scope=${item.scope}`,
    `kind=${item.kind}`,
    `authority=${item.authority}`,
    freshness || 'freshness=none',
    `sourceRefs=${item.sourceRefs.eventIds.length ? item.sourceRefs.eventIds.join(',') : 'none'}`,
    compression,
    item.governance
      ? `governance=status=${item.governance.status} risk=${item.governance.riskClass} confidence=${item.governance.confidence} semanticKey=${item.governance.semanticKey}`
      : 'governance=none',
    `content=${item.content}`,
  ].join(' | ');
}

function dedupeMemoryItems(values: MemoryItemV4[], maxItems: number): MemoryItemV4[] {
  const seen = new Set<string>();
  const result: MemoryItemV4[] = [];
  for (const value of [...values].reverse()) {
    const key = `${value.scope}:${value.kind}:${value.authority}:${value.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= maxItems) break;
  }
  return result.reverse();
}

function capMemoryItems(values: MemoryItemV4[], softTokenCap: number): MemoryItemV4[] {
  const maxChars = softTokenCap * 4;
  const result: MemoryItemV4[] = [];
  let total = 0;
  for (const value of values) {
    const rendered = renderMemoryItemLine(value);
    const nextLength = rendered.length + 3;
    if (total + nextLength > maxChars) break;
    result.push(value);
    total += nextLength;
  }
  return result;
}

function pathFromMemoryContent(content: string): string | undefined {
  const match = content.match(/(?:path=|attachments=|Attached resource: |ResourcePacket fact: [^ ]+ |Agent-generated artifact fact: )([^,;\s]+)/);
  const value = match?.[1]?.trim();
  if (!value || value.includes('://')) return undefined;
  return value;
}

function memoryHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function renderSessionScopedMemoryHints(document: SessionMemoryDocument): string[] {
  const lines = document.sessionMemoryItems.map(compactMemoryBullet);
  return [
    'SessionMemoryCompact (single-session, 256k emergency soft cap):',
    'Boundary: session memory stores the active task focus, accepted plan, user guidance, review decisions, and compressed local conversation summary. It must not crowd out current user input or EvidenceTail facts.',
    `archiveHash=${document.archiveMetadata?.sessionMemoryArchiveHash ?? 'none'}`,
    document.archiveMetadata?.expandedMemoryItemIds.length
      ? `selectedItemIds=${document.archiveMetadata.expandedMemoryItemIds.filter((id) => id.includes(':session:')).slice(0, 32).join(', ')}`
      : 'selectedItemIds=none',
    lines.length
      ? `selectedSessionMemory:\n${capMemoryLines(lines, 256_000).map((item) => `- ${item}`).join('\n')}`
      : 'selectedSessionMemory: none',
  ];
}

function compactMemoryBullet(item: MemoryItemV4): string {
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
    `content=${item.content}`,
  ].filter(Boolean).join(' | ');
}

export function renderSessionMemoryHints(document: SessionMemoryDocument): string[] {
  return [
    'Session short-term memory document:',
    'Boundary: intentContext is not evidence; factContext is the only generated-file evidence; decisionContext records user decisions and guidance; resourceContext records reusable attachment/resource facts.',
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
  const consumedIds = new Set<string>();
  for (const event of events.slice(-120)) {
    if (event.kind !== 'user_guidance') continue;
    const record = objectRecord(event.payload);
    if (!record || stringValue(record.status) !== 'consumed') continue;
    consumedIds.add(stringValue(record.guidanceId) ?? event.id);
  }
  for (const event of events.slice(-80)) {
    const record = objectRecord(event.payload);
    if (!record) continue;
    const eventRunId = stringValue(record.runId) ?? stringValue(record.targetRunId);
    if (runId && eventRunId && eventRunId !== runId) continue;
    if (event.kind === 'user_guidance') {
      const guidanceId = stringValue(record.guidanceId) ?? event.id;
      if (stringValue(record.status) === 'consumed' || consumedIds.has(guidanceId)) continue;
      const content = stringValue(record.content) ?? stringValue(record.guidance) ?? stringValue(record.summary);
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
  return dedupeGuidance(collected).slice(-8);
}

function continuationSummary(value: unknown): string | null {
  const record = objectRecord(value);
  if (!record) return null;
  const title = stringValue(record.title);
  const capability = stringValue(record.capability);
  const scope = Array.isArray(record.resourceScope)
    ? record.resourceScope.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ')
    : '';
  const text = [title, capability ? `capability=${capability}` : '', scope ? `scope=${scope}` : ''].filter(Boolean).join(' ');
  return text || null;
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

function dedupeKeepLast(values: string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of [...values].reverse()) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= maxItems) break;
  }
  return result.reverse();
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
