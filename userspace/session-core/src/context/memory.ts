import type { AgentEvent } from '@deepcode/protocol';

export interface SessionMemoryDocument {
  schemaVersion: '3';
  sourceEventCount: number;
  projectMemoryContext: string[];
  sessionMemoryContext: string[];
  longTermContext: string[];
  shortTermContext: string[];
  guidanceContext: string[];
  intentContext: string[];
  factContext: string[];
  decisionContext: string[];
  resourceContext: string[];
}

export interface UserGuidanceEvent {
  id: string;
  ts?: string;
  content: string;
  source: 'user' | 'decision' | 'review' | 'system';
  checkpointKind: 'llmProposal' | 'resourcePacket' | 'permission' | 'review' | 'nextProviderCall';
}

export function buildSessionMemoryDocument(events: AgentEvent[]): SessionMemoryDocument {
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

  return {
    schemaVersion: '3',
    sourceEventCount: events.length,
    projectMemoryContext: capMemoryLines(dedupeKeepLast([
      ...longTermContext,
      ...resourceContext.map((item) => `Project resource index: ${item}`),
      ...factContext.map((item) => `Project fact index: ${item}`),
      ...decisionContext.map((item) => `Cross-session decision index: ${item}`),
    ], 40), 128_000),
    sessionMemoryContext: capMemoryLines(dedupeKeepLast([
      ...shortTermContext,
      ...intentContext.map((item) => `Session intent: ${item}`),
      ...guidanceContext.map((item) => `Session guidance: ${item}`),
      ...decisionContext.map((item) => `Session decision: ${item}`),
    ], 48), 256_000),
    longTermContext: dedupeKeepLast(longTermContext, 18),
    shortTermContext: dedupeKeepLast(shortTermContext, 12),
    guidanceContext: dedupeKeepLast(guidanceContext, 10),
    intentContext: intentContext.slice(-10),
    factContext: factContext.slice(-14),
    decisionContext: decisionContext.slice(-10),
    resourceContext: resourceContext.slice(-12),
  };
}

export function renderProjectMemoryHints(document: SessionMemoryDocument): string[] {
  const lines = document.projectMemoryContext.length
    ? document.projectMemoryContext
    : [
      ...document.longTermContext,
      ...document.resourceContext.map((item) => `Project resource index: ${item}`),
      ...document.factContext.map((item) => `Project fact index: ${item}`),
      ...document.decisionContext.map((item) => `Cross-session decision index: ${item}`),
    ];
  return [
    'ProjectMemory document (project-scoped, 128k soft cap):',
    'Boundary: shared project memory stores durable norms, user preferences, historical gotchas, long-term planning summaries, and cross-session decision indexes. It is not Kernel authority and must be refreshed from ResourcePacket/tool facts when code may have changed.',
    lines.length
      ? `projectMemoryContext:\n${capMemoryLines(lines, 128_000).map((item) => `- ${item}`).join('\n')}`
      : 'projectMemoryContext: none',
  ];
}

export function renderSessionScopedMemoryHints(document: SessionMemoryDocument): string[] {
  const lines = document.sessionMemoryContext.length
    ? document.sessionMemoryContext
    : [
      ...document.shortTermContext,
      ...document.intentContext.map((item) => `Session intent: ${item}`),
      ...document.guidanceContext.map((item) => `Session guidance: ${item}`),
      ...document.decisionContext.map((item) => `Session decision: ${item}`),
    ];
  return [
    'SessionMemory document (single-session, 256k soft cap):',
    'Boundary: session memory stores the active task focus, accepted plan, user guidance, review decisions, and compressed local conversation summary. It must not crowd out current user input or EvidenceTail facts.',
    lines.length
      ? `sessionMemoryContext:\n${capMemoryLines(lines, 256_000).map((item) => `- ${item}`).join('\n')}`
      : 'sessionMemoryContext: none',
  ];
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
