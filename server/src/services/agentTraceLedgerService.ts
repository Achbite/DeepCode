import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentTraceEvent,
  AgentTraceEventFilter,
  AgentTraceEventKind,
  AgentWorkflowPhase,
  TraceLedgerSnapshot,
} from '@deepcode/protocol';
import { resolveDeepCodeConfigDir } from './appDataPath.js';

const TRACE_DIR = join(resolveDeepCodeConfigDir(), 'traces');
const traces = new Map<string, AgentTraceEvent[]>();
const loadedSessions = new Set<string>();

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureDir(): Promise<void> {
  await mkdir(TRACE_DIR, { recursive: true });
}

function tracePath(sessionId: string): string {
  return join(TRACE_DIR, `${sessionId}.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function booleanField(payload: unknown, key: string): boolean | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

function objectField(payload: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  return isRecord(payload[key]) ? payload[key] as Record<string, unknown> : undefined;
}

function latestTurnId(events: AgentEvent[], fallback: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payloadTurnId = stringField(events[index].payload, 'turnId');
    if (payloadTurnId) return payloadTurnId;
    if (events[index].kind === 'user_msg') return events[index].id;
  }
  return fallback;
}

function eventPhase(event: AgentEvent): AgentWorkflowPhase | undefined {
  const stage = stringField(event.payload, 'stage') ?? stringField(event.payload, 'phase');
  if (
    stage === 'plan' ||
    stage === 'check' ||
    stage === 'complete' ||
    stage === 'review' ||
    stage === 'awaitingApproval' ||
    stage === 'done' ||
    stage === 'aborted'
  ) {
    return stage;
  }
  return undefined;
}

function eventToolName(event: AgentEvent): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  const toolCall = objectField(event.payload, 'toolCall');
  return (
    stringField(event.payload, 'toolName') ??
    stringField(event.payload, 'name') ??
    stringField(toolCall, 'name')
  );
}

function eventCallId(event: AgentEvent): string | undefined {
  return stringField(event.payload, 'callId') ?? stringField(event.payload, 'id');
}

function eventCommand(event: AgentEvent): string | undefined {
  const args =
    objectField(event.payload, 'arguments') ??
    objectField(event.payload, 'input') ??
    objectField(event.payload, 'output') ??
    (isRecord(event.payload) ? event.payload : undefined);
  return stringField(args, 'command') ?? stringField(event.payload, 'command');
}

function eventSummary(event: AgentEvent): string {
  const payload = event.payload;
  if (event.kind === 'user_msg') {
    return stringField(payload, 'content') ?? 'User message received.';
  }
  if (event.kind === 'assistant_msg') {
    return stringField(payload, 'content') ?? 'Assistant response produced.';
  }
  if (event.kind === 'workflow_stage') {
    const stage = stringField(payload, 'stage') ?? 'workflow';
    const status = stringField(payload, 'status') ?? 'updated';
    return stringField(payload, 'summary') ?? `${stage} ${status}`;
  }
  if (event.kind === 'tool_call') {
    return eventCommand(event)
      ? `${eventToolName(event) ?? 'tool'}: ${eventCommand(event)}`
      : `${eventToolName(event) ?? 'tool'} requested.`;
  }
  if (event.kind === 'tool_result') {
    const ok = booleanField(payload, 'ok');
    return stringField(payload, 'error') ??
      `${eventToolName(event) ?? 'tool'} ${ok === false ? 'failed' : 'completed'}.`;
  }
  if (event.kind === 'permission_request') {
    return stringField(payload, 'summary') ?? `${eventToolName(event) ?? 'tool'} requires permission.`;
  }
  if (event.kind === 'permission_result') {
    return `${eventToolName(event) ?? 'permission'} ${stringField(payload, 'status') ?? 'resolved'}.`;
  }
  if (event.kind === 'error') {
    return stringField(payload, 'message') ?? 'Agent error.';
  }
  return event.kind;
}

function traceKindForEvent(event: AgentEvent): AgentTraceEventKind {
  if (event.kind === 'user_msg') return 'turn.started';
  if (event.kind === 'assistant_msg') {
    const channel = stringField(event.payload, 'channel');
    return channel === 'final' ? 'llm.completed' : 'llm.response';
  }
  if (event.kind === 'workflow_stage') {
    const status = stringField(event.payload, 'status');
    if (status === 'started') return 'stage.started';
    if (status === 'error') return 'stage.failed';
    return 'stage.completed';
  }
  if (event.kind === 'tool_call') return 'tool.requested';
  if (event.kind === 'tool_result') {
    const ok = booleanField(event.payload, 'ok');
    const status = stringField(event.payload, 'status');
    return ok === false || status === 'error' || status === 'blocked'
      ? 'tool.failed'
      : 'tool.completed';
  }
  if (event.kind === 'permission_request') return 'permission.requested';
  if (event.kind === 'permission_result') return 'permission.resolved';
  return 'error';
}

function traceEventFromAgentEvent(event: AgentEvent, turnId: string): AgentTraceEvent {
  const kind = traceKindForEvent(event);
  const ts = event.ts || nowIso();
  const failed = kind.endsWith('failed') || event.kind === 'error';
  return {
    id: `trace-${event.id}`,
    eventId: event.id,
    sessionId: event.sessionId,
    turnId,
    ts,
    timestamp: ts,
    kind,
    source: event.kind === 'user_msg' ? 'user' : 'agent',
    level: failed ? 'error' : 'info',
    phase: eventPhase(event),
    toolCallId: eventCallId(event),
    summary: eventSummary(event),
    payload: event.payload,
  };
}

function turnCompletedTraceEvent(sessionId: string, turnId: string): AgentTraceEvent {
  const ts = nowIso();
  return {
    id: `trace-${turnId}-completed`,
    eventId: turnId,
    sessionId,
    turnId,
    ts,
    timestamp: ts,
    kind: 'turn.completed',
    source: 'agent',
    level: 'info',
    summary: 'Agent turn completed.',
  };
}

function llmTraceForWorkflowStage(event: AgentEvent, turnId: string): AgentTraceEvent | null {
  if (event.kind !== 'workflow_stage') return null;
  const status = stringField(event.payload, 'status');
  if (status !== 'started' && status !== 'completed') return null;
  const base = traceEventFromAgentEvent(event, turnId);
  const requested = status === 'started';
  return {
    ...base,
    id: `${base.id}-${requested ? 'llm-requested' : 'llm-completed'}`,
    kind: requested ? 'llm.requested' : 'llm.completed',
    summary: requested
      ? `${stringField(event.payload, 'stage') ?? 'workflow'} LLM request started.`
      : `${stringField(event.payload, 'stage') ?? 'workflow'} LLM response completed.`,
  };
}

function filterEvents(
  events: AgentTraceEvent[],
  filter: AgentTraceEventFilter = {}
): AgentTraceEvent[] {
  let result = events;
  if (filter.afterEventId) {
    const index = result.findIndex((event) => event.id === filter.afterEventId || event.eventId === filter.afterEventId);
    result = index >= 0 ? result.slice(index + 1) : result;
  }
  if (filter.turnId) result = result.filter((event) => event.turnId === filter.turnId);
  if (filter.phase) result = result.filter((event) => event.phase === filter.phase);
  if (filter.kind) result = result.filter((event) => event.kind === filter.kind);
  if (filter.toolCallId) result = result.filter((event) => event.toolCallId === filter.toolCallId);
  if (filter.limit && filter.limit > 0) result = result.slice(-filter.limit);
  return result;
}

async function loadSessionTrace(sessionId: string): Promise<void> {
  if (loadedSessions.has(sessionId)) return;
  loadedSessions.add(sessionId);
  await ensureDir();
  try {
    const raw = await readFile(tracePath(sessionId), 'utf-8');
    const loaded: AgentTraceEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (parsed?.id && parsed?.sessionId) loaded.push(parsed as AgentTraceEvent);
    }
    traces.set(sessionId, loaded);
  } catch {
    traces.set(sessionId, traces.get(sessionId) ?? []);
  }
}

export async function appendTraceEvents(
  sessionId: string,
  nextEvents: AgentTraceEvent[]
): Promise<TraceLedgerSnapshot> {
  await loadSessionTrace(sessionId);
  const current = traces.get(sessionId) ?? [];
  const knownIds = new Set(current.map((event) => event.id));
  const fresh = nextEvents.filter((event) => !knownIds.has(event.id));
  if (fresh.length > 0) {
    current.push(...fresh);
    traces.set(sessionId, current);
    await ensureDir();
    await appendFile(tracePath(sessionId), fresh.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf-8');
  }
  return getTraceSnapshot(sessionId);
}

export async function appendAgentTraceFromEvents(
  sessionId: string,
  agentEvents: AgentEvent[]
): Promise<TraceLedgerSnapshot> {
  if (agentEvents.length === 0) return getTraceSnapshot(sessionId);
  let turnId = latestTurnId(agentEvents, agentEvents[0]?.id ?? `turn-${Date.now()}`);
  const traceEvents: AgentTraceEvent[] = [];
  let sawTurnStart = false;

  for (const event of agentEvents) {
    if (event.kind === 'user_msg') {
      turnId = event.id;
      sawTurnStart = true;
    } else {
      const payloadTurnId = stringField(event.payload, 'turnId');
      if (payloadTurnId) turnId = payloadTurnId;
    }
    traceEvents.push(traceEventFromAgentEvent(event, turnId));
    const llmTrace = llmTraceForWorkflowStage(event, turnId);
    if (llmTrace) traceEvents.push(llmTrace);
  }

  const sawFinal = agentEvents.some((event) =>
    event.kind === 'assistant_msg' && stringField(event.payload, 'channel') === 'final'
  );
  if (sawTurnStart && !agentEvents.some((event) => event.kind === 'workflow_stage' && stringField(event.payload, 'status') === 'started')) {
    traceEvents.push(turnCompletedTraceEvent(sessionId, turnId));
  } else if (sawTurnStart && agentEvents.some((event) => event.kind === 'assistant_msg' || event.kind === 'error')) {
    traceEvents.push(turnCompletedTraceEvent(sessionId, turnId));
  } else if (sawFinal) {
    traceEvents.push(turnCompletedTraceEvent(sessionId, turnId));
  }

  return appendTraceEvents(sessionId, traceEvents);
}

export async function getTraceSnapshot(
  sessionId: string,
  filter: AgentTraceEventFilter = {}
): Promise<TraceLedgerSnapshot> {
  await loadSessionTrace(sessionId);
  const all = traces.get(sessionId) ?? [];
  const events = filterEvents(all, filter);
  return {
    sessionId,
    events,
    eventCount: all.length,
    updatedAt: all[all.length - 1]?.ts ?? nowIso(),
  };
}
