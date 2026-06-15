import type { AgentEvent } from '@deepcode/protocol';

export interface SessionMemoryDocument {
  schemaVersion: '1';
  sourceEventCount: number;
  intentContext: string[];
  factContext: string[];
  decisionContext: string[];
  resourceContext: string[];
}

export function buildSessionMemoryDocument(events: AgentEvent[]): SessionMemoryDocument {
  const intentContext: string[] = [];
  const factContext: string[] = [];
  const decisionContext: string[] = [];
  const resourceContext: string[] = [];

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
      if (content) intentContext.push(`User request: ${clip(content, 300)}${attachments.length ? ` attachments=${attachments.join(', ')}` : ''}`);
      for (const attachment of attachments.slice(0, 8)) resourceContext.push(`Attached resource: ${clip(attachment, 240)}`);
    }

    if (event.kind === 'requirement_confirmation') {
      const status = stringValue(record.status) ?? 'pending';
      const summary = stringValue(record.summary) ?? stringValue(record.content) ?? '';
      if (summary.trim()) intentContext.push(`Requirement draft (${status}): ${clip(summary.trim(), 300)}`);
    }

    if (event.kind === 'plan_card') {
      const summary = stringValue(record.summary) ?? stringValue(record.content) ?? '';
      if (summary.trim()) intentContext.push(`Plan intent: ${clip(summary.trim(), 320)}`);
      const actionBundle = objectRecord(record.actionBundle);
      const continuations = Array.isArray(actionBundle?.continuationExpectations)
        ? actionBundle.continuationExpectations
        : [];
      for (const continuation of continuations.slice(0, 4)) {
        const text = continuationSummary(continuation);
        if (text) intentContext.push(`Continuation intent: ${clip(text, 240)}`);
      }
    }

    if (event.kind === 'review_summary') {
      const status = stringValue(record.status) ?? 'unknown';
      const content = stringValue(record.content) ?? stringValue(record.summary) ?? '';
      if (content.trim()) {
        const target = status === 'waitingUserReview' ? intentContext : decisionContext;
        target.push(`Review ${status}: ${clip(content.trim(), 360)}`);
      }
      const facts = Array.isArray(record.facts) ? record.facts.filter((item): item is string => typeof item === 'string') : [];
      for (const fact of facts.slice(0, 8)) factContext.push(`Review fact: ${clip(fact, 260)}`);
      if (status === 'accepted' || status === 'needsRevision' || status === 'rejected') {
        decisionContext.push(`Review decision: ${status}${content.trim() ? ` guidance=${clip(content.trim(), 240)}` : ''}`);
      }
    }

    if (event.kind === 'requirement_decision' || event.kind === 'plan_review') {
      const status = stringValue(record.status) ?? stringValue(record.decision) ?? 'unknown';
      const summary = stringValue(record.summary) ?? stringValue(record.content) ?? '';
      decisionContext.push(`${event.kind}: ${status}${summary.trim() ? ` ${clip(summary.trim(), 240)}` : ''}`);
    }

    if (event.kind === 'assistant_msg') {
      const channel = stringValue(record.channel) ?? '';
      if (channel && channel !== 'final') continue;
      const content = stringValue(record.content);
      if (content) intentContext.push(`Assistant final: ${clip(content, 260)}`);
    }

    if (event.kind === 'tool_result') {
      const toolName = stringValue(record.toolName) ?? 'tool';
      const summary = stringValue(record.summary) ?? '';
      if (summary.trim()) factContext.push(`Resource/tool fact ${toolName}: ${clip(summary.trim(), 260)}`);
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
        factContext.push(`ToolCompleted fact: ok=${ok}${path ? ` path=${clip(path, 220)}` : ''}${validationKind ? ` validation=${validationKind}` : ''}`);
      }
      if (kind === 'work_unit.completed' || kind === 'work_unit.failed' || kind === 'work_unit.blocked') {
        const workUnitId = stringValue(kernelEvent.workUnitId);
        const output = objectRecord(kernelEvent.output);
        const path = stringValue(output?.path) ?? stringValue(output?.absolutePath);
        factContext.push(`WorkUnit fact: ${kind}${workUnitId ? ` id=${clip(workUnitId, 160)}` : ''}${path ? ` path=${clip(path, 220)}` : ''}`);
      }
    }
  }

  return {
    schemaVersion: '1',
    sourceEventCount: events.length,
    intentContext: intentContext.slice(-10),
    factContext: factContext.slice(-14),
    decisionContext: decisionContext.slice(-10),
    resourceContext: resourceContext.slice(-12),
  };
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
