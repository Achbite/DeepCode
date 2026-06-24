import type { AgentEvent } from '@deepcode/protocol';
import type {
  MemoryCompressionMode,
  MemoryCandidateCreatedBy,
  MemoryCandidateStatus,
  MemoryItemAuthority,
  MemoryItemKind,
  MemoryItemScope,
  MemoryItemV4,
  MemoryRiskClass,
  ProjectMemoryMode,
  SessionMemoryDocument,
} from './memory.js';

type MemoryLane = 'project' | 'session' | 'evidence' | 'audit';

interface MemoryCandidate {
  lane: MemoryLane;
  scope: MemoryItemScope;
  kind: MemoryItemKind;
  authority: MemoryItemAuthority;
  content: string;
  event: AgentEvent;
  path?: string;
  ledgerRefs?: string[];
  auditRefs?: string[];
  compression?: MemoryItemV4['compression'];
  status?: MemoryCandidateStatus;
  riskClass?: MemoryRiskClass;
  confidence?: number;
  semanticKey?: string;
  createdBy?: MemoryCandidateCreatedBy;
  projectMemoryMode?: ProjectMemoryMode;
}

export function compileSessionMemoryDocument(
  events: AgentEvent[],
  options: { projectMemoryMode?: ProjectMemoryMode } = {}
): SessionMemoryDocument {
  const projectMemoryMode = options.projectMemoryMode ?? 'confirm';
  const candidates = compileMemoryCandidates(events);
  const projectCandidateItems = dedupeMemoryItems(
    candidates
      .filter((item) => item.lane === 'project')
      .map((item) => memoryItemFromCandidate(applyProjectCandidateGovernance(item, projectMemoryMode))),
    80
  );
  const projectMemoryItems = capMemoryItems(dedupeMemoryItems(
    projectCandidateItems.filter((item) => item.governance?.status === 'auto-promoted' || item.governance?.status === 'confirmed'),
    40
  ), 128_000);
  const pendingProjectMemoryCandidates = capMemoryItems(dedupeMemoryItems(
    projectCandidateItems.filter((item) => item.governance?.status === 'pending'),
    40
  ), 128_000);
  const sessionMemoryItems = capMemoryItems(dedupeMemoryItems(
    candidates
      .filter((item) => item.lane === 'session')
      .map(memoryItemFromCandidate),
    56
  ), 256_000);
  const evidenceContext = dedupeKeepLast(
    candidates
      .filter((item) => item.lane === 'evidence')
      .map((item) => item.content),
    16
  );
  const auditOnlyContext = dedupeKeepLast(
    candidates
      .filter((item) => item.lane === 'audit')
      .map((item) => item.content),
    12
  );
  const intentContext = dedupeKeepLast(
    candidates
      .filter((item) => item.lane === 'session' && (
        item.kind === 'intent' ||
        (item.kind === 'checkpoint' && !item.content.startsWith('Assistant final summary:'))
      ))
      .map((item) => item.content),
    12
  );
  const decisionContext = dedupeKeepLast(
    candidates
      .filter((item) => item.lane === 'session' && item.kind === 'decision')
      .map((item) => item.content),
    12
  );
  const guidanceContext = dedupeKeepLast(
    candidates
      .filter((item) => item.lane === 'session' && item.kind === 'decision' && item.authority === 'userDecision')
      .map((item) => item.content),
    8
  );
  const resourceContext = dedupeKeepLast(
    candidates
      .filter((item) => item.authority === 'resourcePacket')
      .map((item) => item.content),
    12
  );

  return {
    schemaVersion: '3',
    sourceEventCount: events.length,
    projectMemoryItems,
    sessionMemoryItems,
    pendingProjectMemoryCandidates,
    projectMemoryContext: projectMemoryItems.map(renderMemoryItemLine),
    sessionMemoryContext: sessionMemoryItems.map(renderMemoryItemLine),
    longTermContext: projectMemoryItems.map((item) => item.content),
    shortTermContext: sessionMemoryItems.map((item) => item.content),
    guidanceContext,
    intentContext,
    factContext: evidenceContext,
    decisionContext,
    resourceContext,
    archiveMetadata: {
      projectMemoryArchiveHash: memoryItemsHash(projectMemoryItems),
      sessionMemoryArchiveHash: memoryItemsHash(sessionMemoryItems),
      projectMemoryMode,
      expandedMemoryItemIds: [
        ...projectMemoryItems.map((item) => item.id),
        ...sessionMemoryItems.map((item) => item.id),
      ],
      pendingProjectMemoryCandidateIds: pendingProjectMemoryCandidates.map((item) => item.id),
      memoryDroppedReasonCounts: droppedReasonCounts(candidates),
      auditOnlyContext,
    },
  };
}

export function renderMemoryItemLine(item: MemoryItemV4): string {
  const freshness = [
    item.freshness.path ? `path=${item.freshness.path}` : '',
    item.freshness.contentHash ? `hash=${item.freshness.contentHash}` : '',
    item.freshness.lastVerifiedAt ? `lastVerifiedAt=${item.freshness.lastVerifiedAt}` : '',
  ].filter(Boolean).join(' ');
  const refs = [
    item.sourceRefs.eventIds.length ? `events=${item.sourceRefs.eventIds.join(',')}` : '',
    item.sourceRefs.ledgerRefs?.length ? `ledger=${item.sourceRefs.ledgerRefs.join(',')}` : '',
    item.sourceRefs.auditRefs?.length ? `audit=${item.sourceRefs.auditRefs.join(',')}` : '',
  ].filter(Boolean).join(' ');
  const compression = item.compression
    ? `compression=${item.compression.mode}${item.compression.reason ? ` reason=${item.compression.reason}` : ''}`
    : 'compression=raw';
  return [
    `MemoryItemV4 scope=${item.scope}`,
    `kind=${item.kind}`,
    `authority=${item.authority}`,
    freshness || 'freshness=none',
    `sourceRefs=${refs || 'synthetic:none'}`,
    compression,
    item.governance
      ? `governance=status=${item.governance.status} risk=${item.governance.riskClass} confidence=${item.governance.confidence} semanticKey=${item.governance.semanticKey}`
      : 'governance=none',
    `content=${item.content}`,
  ].join(' | ');
}

function compileMemoryCandidates(events: AgentEvent[]): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  for (const event of events.slice(-160)) {
    const record = objectRecord(event.payload);
    if (!record) continue;
    if (event.kind === 'user_msg') {
      const content = stringValue(record.content);
      const attachments = arrayRecords(record.attachments)
        .map((item) => `${String(item.kind ?? 'resource')}:${String(item.path ?? item.absolutePath ?? '')}`)
        .filter((item) => item.trim().length > 0);
      if (content) {
        candidates.push({
          lane: 'session',
          scope: 'session',
          kind: 'intent',
          authority: 'summary',
          content: `Current user request: ${clip(content, 320)}`,
          event,
          compression: compressionFor(content, 320),
        });
      }
      for (const attachment of attachments.slice(0, 8)) {
        candidates.push({
          lane: 'project',
          scope: 'project',
          kind: 'resource',
          authority: 'resourcePacket',
          content: `Project resource handle: ${clip(attachment, 240)}`,
          event,
          path: pathFromText(attachment),
        });
      }
      continue;
    }

    if (event.kind === 'plan_card') {
      const summary = stringValue(record.summary) ?? stringValue(record.title) ?? stringValue(record.content);
      if (summary) {
        candidates.push({
          lane: 'session',
          scope: 'session',
          kind: 'intent',
          authority: 'summary',
          content: `Plan checkpoint: ${clip(summary, 360)}`,
          event,
          compression: compressionFor(summary, 360),
        });
      }
      for (const continuation of arrayRecords(objectRecord(record.actionBundle)?.continuationExpectations).slice(0, 4)) {
        const text = compactContinuation(continuation);
        if (!text) continue;
        candidates.push({
          lane: 'session',
          scope: 'session',
          kind: 'intent',
          authority: 'summary',
          content: `Continuation intent: ${clip(text, 260)}`,
          event,
          compression: compressionFor(text, 260),
        });
      }
      continue;
    }

    if (event.kind === 'requirement_confirmation') {
      const status = stringValue(record.status) ?? 'pending';
      const summary = stringValue(record.summary) ?? stringValue(record.content);
      if (summary) {
        candidates.push({
          lane: 'session',
          scope: 'session',
          kind: 'checkpoint',
          authority: 'summary',
          content: `Requirement ${status}: ${clip(summary, 300)}`,
          event,
          compression: compressionFor(summary, 300),
        });
      }
      continue;
    }

    if (event.kind === 'requirement_decision' || event.kind === 'plan_review') {
      const status = stringValue(record.status) ?? stringValue(record.decision) ?? 'unknown';
      const guidance = stringValue(record.guidance);
      const summary = stringValue(record.summary) ?? stringValue(record.content);
      candidates.push({
        lane: 'session',
        scope: 'session',
        kind: 'decision',
        authority: 'userDecision',
        content: `${event.kind}: ${status}${summary ? ` ${clip(summary, 220)}` : ''}${guidance ? ` guidance=${clip(guidance, 220)}` : ''}`,
        event,
        compression: compressionFor(`${summary ?? ''}${guidance ?? ''}`, 440),
      });
      continue;
    }

    if (event.kind === 'review_summary') {
      const status = stringValue(record.status) ?? 'unknown';
      const factCounts = objectRecord(record.factCounts);
      const summary = [
        `Review ${status}`,
        typeof factCounts?.workUnitsCompleted === 'number' ? `completed=${factCounts.workUnitsCompleted}` : '',
        typeof factCounts?.workUnitsFailed === 'number' ? `failed=${factCounts.workUnitsFailed}` : '',
        typeof factCounts?.workUnitsBlocked === 'number' ? `blocked=${factCounts.workUnitsBlocked}` : '',
        typeof factCounts?.toolResults === 'number' ? `toolFacts=${factCounts.toolResults}` : '',
      ].filter(Boolean).join(' ');
      candidates.push({
        lane: 'session',
        scope: 'session',
        kind: status === 'waitingUserReview' ? 'checkpoint' : 'decision',
        authority: status === 'waitingUserReview' ? 'summary' : 'userDecision',
        content: summary,
        event,
      });
      candidates.push({
        lane: 'audit',
        scope: 'session',
        kind: 'fact',
        authority: 'kernelFact',
        content: `Review raw facts retained in audit only: event=${event.id}`,
        event,
        auditRefs: [event.id],
        compression: { mode: 'handleOnly', reason: 'raw review facts are audit-only' },
      });
      continue;
    }

    if (event.kind === 'assistant_msg') {
      const channel = stringValue(record.channel) ?? '';
      if (channel && channel !== 'final') continue;
      const content = stringValue(record.content);
      if (!content) continue;
      candidates.push({
        lane: 'session',
        scope: 'session',
        kind: 'checkpoint',
        authority: 'summary',
        content: `Assistant final summary: ${clip(content, 220)}`,
        event,
        compression: compressionFor(content, 220),
      });
      continue;
    }

    if (event.kind === 'tool_result') {
      compileToolResultCandidates(event, record, candidates);
      continue;
    }

    if (event.kind === 'workflow_stage') {
      compileWorkflowStageCandidates(event, record, candidates);
    }
  }
  return candidates;
}

function compileToolResultCandidates(
  event: AgentEvent,
  record: Record<string, unknown>,
  candidates: MemoryCandidate[]
): void {
  const toolName = stringValue(record.toolName) ?? 'tool';
  const summary = stringValue(record.summary);
  if (summary) {
    candidates.push({
      lane: 'evidence',
      scope: 'session',
      kind: 'fact',
      authority: 'summary',
      content: `Tool result summary: ${toolName} ${clip(summary, 260)}`,
      event,
      compression: compressionFor(summary, 260),
    });
  }
  for (const item of arrayRecords(objectRecord(record.output)?.items).slice(0, 8)) {
    const path = stringValue(item.path) ?? stringValue(item.absolutePath) ?? stringValue(item.manifestEntryId);
    const kind = stringValue(item.contentKind) ?? stringValue(item.resolvedKind) ?? 'resource';
    if (!path) continue;
    const content = `ResourcePacket handle: ${kind} ${clip(path, 220)}`;
    candidates.push({
      lane: 'project',
      scope: 'project',
      kind: 'resource',
      authority: 'resourcePacket',
      content,
      event,
      path,
    });
    candidates.push({
      lane: 'evidence',
      scope: 'session',
      kind: 'fact',
      authority: 'resourcePacket',
      content,
      event,
      path,
    });
  }
}

function compileWorkflowStageCandidates(
  event: AgentEvent,
  record: Record<string, unknown>,
  candidates: MemoryCandidate[]
): void {
  const stage = stringValue(record.stage);
  if (stage === 'accepted_plan.task_savepoint') {
    const summary = stringValue(record.summary);
    const taskId = stringValue(record.taskId);
    const nodeId = stringValue(record.nodeId);
    const nextReadyNodeIds = Array.isArray(record.nextReadyNodeIds)
      ? record.nextReadyNodeIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const content = [
      'Accepted task savepoint:',
      taskId ? `task=${taskId}` : '',
      nodeId ? `node=${nodeId}` : '',
      summary ? clip(summary, 260) : '',
      nextReadyNodeIds.length ? `nextReady=${nextReadyNodeIds.join(',')}` : '',
    ].filter(Boolean).join(' ');
    candidates.push({
      lane: 'session',
      scope: 'session',
      kind: 'checkpoint',
      authority: 'summary',
      content,
      event,
      compression: compressionFor(summary ?? content, 260),
    });
  }

  const kernelEvent = objectRecord(record.kernelEvent);
  if (!kernelEvent) return;
  const kind = stringValue(kernelEvent.kind);
  if (kind === 'tool.completed') {
    const ok = kernelEvent.ok === true;
    const output = objectRecord(kernelEvent.output);
    const path = stringValue(output?.path) ?? stringValue(output?.absolutePath);
    const actionId = stringValue(output?.actionId);
    candidates.push({
      lane: 'evidence',
      scope: 'session',
      kind: 'fact',
      authority: 'kernelFact',
      content: `Tool fact: ${stringValue(kernelEvent.toolName) ?? 'tool'} status=${ok ? 'ok' : 'error'}${path ? ` path=${clip(path, 220)}` : ''}${actionId ? ` action=${actionId}` : ''}`,
      event,
      path,
      ledgerRefs: [stringValue(kernelEvent.toolCallId) ?? event.id],
    });
    return;
  }
  if (kind === 'work_unit.completed' || kind === 'work_unit.failed' || kind === 'work_unit.blocked') {
    const output = objectRecord(kernelEvent.output);
    const path = stringValue(output?.path) ?? stringValue(output?.absolutePath);
    const workUnitId = stringValue(kernelEvent.workUnitId);
    candidates.push({
      lane: 'evidence',
      scope: 'session',
      kind: 'fact',
      authority: 'kernelFact',
      content: `WorkUnit fact: ${kind}${workUnitId ? ` id=${clip(workUnitId, 160)}` : ''}${path ? ` path=${clip(path, 220)}` : ''}`,
      event,
      path,
      ledgerRefs: workUnitId ? [workUnitId] : [event.id],
    });
  }
}

function memoryItemFromCandidate(candidate: MemoryCandidate): MemoryItemV4 {
  const clipped = clip(candidate.content, candidate.scope === 'project' ? 420 : 520);
  const contentHash = memoryHash(clipped);
  return {
    id: `memory-v4:${candidate.scope}:${candidate.kind}:${candidate.authority}:${contentHash}`,
    scope: candidate.scope,
    kind: candidate.kind,
    authority: candidate.authority,
    content: clipped,
    freshness: {
      path: candidate.path ?? pathFromText(clipped),
      contentHash,
      lastVerifiedAt: candidate.event.ts,
    },
    sourceRefs: {
      eventIds: [candidate.event.id],
      ledgerRefs: candidate.ledgerRefs,
      auditRefs: candidate.auditRefs,
    },
    compression: candidate.compression ?? compressionFor(candidate.content, clipped.length),
    governance: {
      status: candidate.status ?? (candidate.scope === 'project' ? 'pending' : 'confirmed'),
      riskClass: candidate.riskClass ?? riskClassForCandidate(candidate),
      confidence: candidate.confidence ?? confidenceForCandidate(candidate),
      semanticKey: candidate.semanticKey ?? semanticKeyForCandidate(candidate),
      createdBy: candidate.createdBy ?? 'rule',
      projectMemoryMode: candidate.scope === 'project' ? candidate.projectMemoryMode : undefined,
      promotionReason: candidate.status === 'auto-promoted'
        ? 'project memory auto mode promoted a low-risk non-permission candidate'
        : undefined,
      updatedAt: candidate.event.ts,
    },
  };
}

function applyProjectCandidateGovernance(
  candidate: MemoryCandidate,
  projectMemoryMode: ProjectMemoryMode
): MemoryCandidate {
  const riskClass = candidate.riskClass ?? riskClassForCandidate(candidate);
  const status: MemoryCandidateStatus = projectMemoryMode === 'auto' && isAutoPromotableProjectCandidate(candidate, riskClass)
    ? 'auto-promoted'
    : 'pending';
  return {
    ...candidate,
    status,
    riskClass,
    confidence: candidate.confidence ?? confidenceForCandidate(candidate),
    semanticKey: candidate.semanticKey ?? semanticKeyForCandidate(candidate),
    createdBy: candidate.createdBy ?? 'rule',
    projectMemoryMode,
  };
}

function isAutoPromotableProjectCandidate(candidate: MemoryCandidate, riskClass: MemoryRiskClass): boolean {
  if (riskClass !== 'low') return false;
  if (candidate.authority === 'kernelFact' || candidate.kind === 'fact') return false;
  if (candidate.content.match(/\b(delete|permission|grant|git push|network|secret|token|external path)\b/i)) return false;
  return candidate.kind === 'resource' || candidate.kind === 'habit' || candidate.kind === 'risk';
}

function riskClassForCandidate(candidate: MemoryCandidate): MemoryRiskClass {
  if (candidate.authority === 'kernelFact' || candidate.kind === 'fact') return 'high';
  if (candidate.kind === 'decision' || candidate.kind === 'risk') return 'medium';
  return 'low';
}

function confidenceForCandidate(candidate: MemoryCandidate): number {
  if (candidate.authority === 'userDecision' || candidate.authority === 'userRuler') return 0.9;
  if (candidate.authority === 'resourcePacket') return 0.78;
  if (candidate.authority === 'kernelFact') return 0.95;
  return 0.65;
}

function semanticKeyForCandidate(candidate: MemoryCandidate): string {
  const basis = [
    candidate.scope,
    candidate.kind,
    candidate.authority,
    candidate.path ?? '',
    candidate.content.toLowerCase().replace(/\s+/g, ' ').trim(),
  ].join('\n');
  return `semantic:${memoryHash(basis)}`;
}

function compactContinuation(record: Record<string, unknown>): string | null {
  const title = stringValue(record.title) ?? stringValue(record.description);
  const operation = stringValue(record.operation) ?? stringValue(record.capability);
  const path = stringValue(record.targetPath) ?? stringValue(record.path);
  const text = [title, operation ? `operation=${operation}` : '', path ? `path=${path}` : ''].filter(Boolean).join(' ');
  return text || null;
}

function droppedReasonCounts(candidates: MemoryCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    const reason = candidate.lane === 'audit'
      ? 'audit_only'
      : candidate.lane === 'evidence'
        ? 'evidence_tail'
        : candidate.lane === 'project'
          ? 'project_candidate'
          : 'retained';
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
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

function compressionFor(content: string, maxChars: number): MemoryItemV4['compression'] {
  return {
    mode: content.length <= maxChars ? 'summary' : 'handleOnly',
    reason: content.length <= maxChars
      ? 'compiled summary from structured event'
      : 'raw payload excluded; compact summary retained',
    originalCharCount: content.length,
  };
}

function memoryItemsHash(items: MemoryItemV4[]): string {
  return memoryHash(JSON.stringify(items.map((item) => ({
    id: item.id,
    content: item.content,
    sourceRefs: item.sourceRefs,
  }))));
}

function pathFromText(content: string): string | undefined {
  const match = content.match(/(?:path=|Project resource handle: [^:]+:|ResourcePacket handle: [^ ]+ |Tool fact: [^ ]+ status=[^ ]+ path=|WorkUnit fact: [^ ]+ id=[^ ]+ path=)([^,;\s]+)/);
  const value = match?.[1]?.trim();
  if (!value || value.includes('://')) return undefined;
  return value;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
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

function memoryHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
