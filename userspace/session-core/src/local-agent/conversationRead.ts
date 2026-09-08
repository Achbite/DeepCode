import type {
  CommandJournalPort, ConversationReadQuery, ConversationReadResult, JsonObject, SessionEvent,
} from '@deepcode/protocol';
import { recoverSession } from './reducer.js';

const encoder = new TextEncoder();
const MAX_PAGE_BYTES = 48 * 1024;

export function decodeConversationReadQuery(value: unknown): ConversationReadQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('conversation_read_invalid');
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => !['sessionId', 'view', 'before', 'limit', 'recordId', 'providerRequestId'].includes(key))
    || !identifier(query.sessionId)
    || (query.view !== undefined && (typeof query.view !== 'string' || !['summary', 'messages', 'tools', 'plans', 'context'].includes(query.view)))
    || (query.before !== undefined && (!Number.isSafeInteger(query.before) || Number(query.before) < 1))
    || (query.limit !== undefined && (!Number.isInteger(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 50))
    || (query.recordId !== undefined && (!identifier(query.recordId) || query.view !== 'tools'))
    || (query.providerRequestId !== undefined && (!identifier(query.providerRequestId) || query.view !== 'context'))) {
    throw new Error('conversation_read_invalid');
  }
  return query as unknown as ConversationReadQuery;
}

export async function readSessionEvents(journal: CommandJournalPort, sessionId: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of journal.read(sessionId)) events.push(event);
  if (!events.length) throw new Error('session_not_found');
  if (events[0].type !== 'session.created') throw new Error('session_creation_event_missing');
  return events;
}

export async function readConversation(journal: CommandJournalPort, input: ConversationReadQuery): Promise<ConversationReadResult> {
  const query = decodeConversationReadQuery(input);
  const events = await readSessionEvents(journal, query.sessionId);
  const state = recoverSession(query.sessionId, events);
  const view = query.view ?? 'summary';
  const result: ConversationReadResult = {
    sessionId: query.sessionId, revision: state.revision, view, items: [], nextBefore: null,
  };
  if (view === 'summary') {
    const lastUser = state.messages.findLast((message) => message.role === 'user');
    const lastAssistant = state.messages.findLast((message) => message.role === 'assistant');
    result.summary = {
      title: state.display.creationTitle,
      // These are persisted facts, including running/indeterminate. Do not infer
      // a terminal status from whether this reader has a live Actor.
      run: state.run ? {
        runId: state.run.runId, status: state.run.status,
        waitingReason: state.run.waitingReason ?? null,
      } : null,
      lastUserMessage: lastUser ? textExcerpt(lastUser.content, 4000) : null,
      lastAssistantMessage: lastAssistant ? textExcerpt(lastAssistant.content, 4000) : null,
      todo: state.todoList ? textExcerpt(JSON.stringify(state.todoList), 6000) : null,
      plans: state.plans.slice(-3).map((plan) => ({ planId: plan.planId, revision: plan.revision, title: plan.title, status: plan.status })),
      error: state.terminalError ? { code: state.terminalError.code, message: textExcerpt(state.terminalError.message, 2000) } : null,
      tokenUsage: { ...state.tokenUsage },
    };
  }
  const candidates = events.filter((event) => {
    if (event.sequence >= (query.before ?? Infinity)) return false;
    switch (view) {
      case 'summary': return event.type === 'tool.completed';
      case 'messages': return event.type === 'message.committed' || event.type === 'narrative.committed';
      case 'tools': return event.type === 'tool.completed'
        && (!query.recordId || event.payload.record.recordId === query.recordId);
      case 'plans': return event.type.startsWith('plan.') || event.type.startsWith('todo.');
      case 'context': return event.type === 'context.composed'
        && (!query.providerRequestId || event.payload.providerRequestId === query.providerRequestId);
    }
  }).reverse();
  if (query.recordId && !candidates.length) throw new Error('tool_record_not_found');
  if (query.providerRequestId && !candidates.length) throw new Error('context_composition_not_found');
  let size = encoder.encode(JSON.stringify(result)).byteLength;
  const limit = query.limit ?? (view === 'summary' ? 5 : 10);
  for (const event of candidates) {
    const item = readItem(event, view === 'summary', events);
    const itemBytes = encoder.encode(JSON.stringify(item)).byteLength;
    if (result.items.length >= limit || (result.items.length > 0 && size + itemBytes > MAX_PAGE_BYTES)) {
      result.nextBefore = Number(result.items.at(-1)!.sequence);
      break;
    }
    result.items.push(item);
    size += itemBytes;
  }
  // Pages cover newest events first; items within each page follow journal order.
  result.items.reverse();
  return result;
}

function readItem(event: SessionEvent, summary: boolean, events: readonly SessionEvent[]): JsonObject {
  const base = { sequence: event.sequence, eventId: event.eventId, type: event.type, runId: 'runId' in event ? event.runId ?? null : null };
  if (event.type === 'message.committed' || event.type === 'narrative.committed') {
    return { ...base, role: event.type === 'message.committed' ? event.payload.role : 'assistant', ...textExcerpt(event.payload.content, 12 * 1024) };
  }
  if (event.type === 'tool.completed') {
    const record = event.payload.record;
    return {
      ...base, recordId: record.recordId, toolName: record.toolName, outcome: record.outcome,
      input: textExcerpt(JSON.stringify(record.input), summary ? 600 : 4000),
      ...(summary ? {} : { output: textExcerpt(JSON.stringify('output' in record ? record.output : null), 12 * 1024) }),
      error: 'error' in record ? textExcerpt(JSON.stringify(record.error), 2000) : null,
    };
  }
  if (event.type === 'context.composed') {
    // Keep context structure and usage; native reasoning and instruction bodies
    // are not part of this product transcript view.
    const receipt = event.payload;
    const usage = events.find((candidate) => candidate.type === 'context.updated'
      && candidate.payload.providerRequestId === receipt.providerRequestId);
    return { ...base, providerRequestId: receipt.providerRequestId,
      data: textExcerpt(JSON.stringify(receipt), 20 * 1024),
      usage: usage ? textExcerpt(JSON.stringify(usage.payload), 4000) : null };
  }
  return { ...base, data: textExcerpt(JSON.stringify(event.payload), 12 * 1024) };
}

function textExcerpt(content: string, maxBytes: number): JsonObject {
  // Bound the serialized string, including JSON escaping, not only raw UTF-8.
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(JSON.stringify(content.slice(0, middle))).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && low < content.length && /[\uD800-\uDBFF]/u.test(content[low - 1])) low -= 1;
  return { content: content.slice(0, low), truncated: low < content.length, totalBytes: encoder.encode(content).byteLength };
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\s\u0000-\u001f]/u.test(value);
}
