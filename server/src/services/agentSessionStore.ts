import { mkdir, readFile, readdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentMode,
  AgentSession,
  AgentSessionListResult,
  AgentSessionResult,
  CreateAgentSessionRequest,
  ListAgentSessionsRequest,
} from '@deepcode/protocol';
import { resolveDeepCodeConfigDir } from './appDataPath.js';
import { appendAgentTraceFromEvents } from './agentTraceLedgerService.js';
import { atomicWriteJsonFile } from './persistentFileService.js';

interface SessionFileHeader {
  kind: 'session';
  session: AgentSession;
}

interface SessionIndexFile {
  sessions: AgentSession[];
  currentSessionId?: string;
  currentByWorkspace?: Record<string, string>;
}

const SESSIONS_DIR = join(resolveDeepCodeConfigDir(), 'sessions');
const SESSION_INDEX_PATH = join(SESSIONS_DIR, 'index.json');

const sessions = new Map<string, AgentSession>();
const events = new Map<string, AgentEvent[]>();
const currentByWorkspace = new Map<string, string>();
let currentSessionId: string | undefined;
let loaded = false;
let persistIndexQueue = Promise.resolve();

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTitle(title?: string): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed.slice(0, 120) : 'New Agent Session';
}

function workspaceKey(scope?: Pick<AgentSession, 'workspaceId' | 'workspaceHash'>): string {
  return scope?.workspaceHash || scope?.workspaceId || 'no-workspace';
}

function sessionMatchesScope(
  session: AgentSession,
  request?: ListAgentSessionsRequest
): boolean {
  if (!request?.workspaceHash && !request?.workspaceId) return true;
  return workspaceKey(session) === workspaceKey(request);
}

async function ensureDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

async function writeIndexSnapshot(): Promise<void> {
  const index: SessionIndexFile = {
    sessions: [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    currentSessionId,
    currentByWorkspace: Object.fromEntries(currentByWorkspace.entries()),
  };
  await atomicWriteJsonFile(SESSION_INDEX_PATH, index);
}

async function persistIndex(): Promise<void> {
  const queuedWrite = persistIndexQueue.then(writeIndexSnapshot, writeIndexSnapshot);
  persistIndexQueue = queuedWrite.catch(() => undefined);
  await queuedWrite;
}

async function loadIfNeeded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  await ensureDir();

  try {
    const raw = await readFile(SESSION_INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SessionIndexFile | AgentSession[];
    const loadedSessions = Array.isArray(parsed) ? parsed : parsed.sessions;
    for (const session of loadedSessions ?? []) {
      if (session?.id) sessions.set(session.id, session);
    }
    if (!Array.isArray(parsed)) {
      currentSessionId = parsed.currentSessionId;
      for (const [key, value] of Object.entries(parsed.currentByWorkspace ?? {})) {
        currentByWorkspace.set(key, value);
      }
    }
  } catch {
    // First run or old malformed index.
  }

  try {
    const files = await readdir(SESSIONS_DIR);
    for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
      const sessionId = file.replace(/\.jsonl$/, '');
      const raw = await readFile(join(SESSIONS_DIR, file), 'utf-8');
      const loadedEvents: AgentEvent[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.kind === 'session') {
          const header = parsed as SessionFileHeader;
          if (!sessions.has(header.session.id)) sessions.set(header.session.id, header.session);
        } else if (parsed.id && parsed.sessionId) {
          loadedEvents.push(parsed as AgentEvent);
        }
      }
      events.set(sessionId, loadedEvents);
    }
  } catch {
    // Ignore malformed old sessions.
  }
}

function summarizePayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return typeof payload === 'string' ? payload : undefined;
  const record = payload as Record<string, unknown>;
  const value = record.content ?? record.summary ?? record.message;
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 160) : undefined;
}

function updateSessionSummary(session: AgentSession, nextEvents: AgentEvent[]): void {
  for (let index = nextEvents.length - 1; index >= 0; index -= 1) {
    const event = nextEvents[index];
    if (event.kind !== 'user_msg' && event.kind !== 'assistant_msg') continue;
    const summary = summarizePayload(event.payload);
    if (!summary) continue;
    session.lastSummary = summary;
    return;
  }
}

function withEventCount(session: AgentSession): AgentSession {
  return {
    ...session,
    eventCount: events.get(session.id)?.length ?? 0,
  };
}

function selectCurrentSession(request?: ListAgentSessionsRequest): string | undefined {
  const key = workspaceKey(request);
  const scopedCurrent = currentByWorkspace.get(key);
  if (scopedCurrent) {
    const session = sessions.get(scopedCurrent);
    if (session && !session.archivedAt && sessionMatchesScope(session, request)) return scopedCurrent;
  }
  if (currentSessionId) {
    const session = sessions.get(currentSessionId);
    if (session && !session.archivedAt && sessionMatchesScope(session, request)) return currentSessionId;
  }
  return [...sessions.values()]
    .filter((session) => !session.archivedAt && sessionMatchesScope(session, request))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
}

export async function listAgentSessions(
  request: ListAgentSessionsRequest = {}
): Promise<AgentSessionListResult> {
  await loadIfNeeded();
  const list = [...sessions.values()]
    .filter((session) => (request.includeArchived ? true : !session.archivedAt))
    .filter((session) => sessionMatchesScope(session, request))
    .map(withEventCount)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    sessions: list,
    currentSessionId: selectCurrentSession(request),
  };
}

export async function createAgentSession(
  request: CreateAgentSessionRequest = {}
): Promise<AgentSessionResult> {
  await loadIfNeeded();
  const ts = nowIso();
  const mode: AgentMode = request.initialMode ?? request.mode ?? 'plan';
  const session: AgentSession = {
    id: `as-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: normalizeTitle(request.title),
    titleSource: request.title?.trim() ? 'user' : 'pending',
    mode,
    profileId: request.profileId,
    workspaceId: request.workspaceId,
    workspaceHash: request.workspaceHash,
    createdAt: ts,
    updatedAt: ts,
  };
  sessions.set(session.id, session);
  events.set(session.id, []);
  currentSessionId = session.id;
  currentByWorkspace.set(workspaceKey(session), session.id);
  await ensureDir();
  await appendFile(
    sessionPath(session.id),
    `${JSON.stringify({ kind: 'session', session })}\n`,
    'utf-8'
  );
  await persistIndex();
  return { session: withEventCount(session), events: [] };
}

export async function activateAgentSession(sessionId: string): Promise<AgentSessionResult> {
  await loadIfNeeded();
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Agent session not found: ${sessionId}`);
  if (session.archivedAt) throw new Error(`Agent session is archived: ${sessionId}`);
  currentSessionId = session.id;
  currentByWorkspace.set(workspaceKey(session), session.id);
  await persistIndex();
  return { session: withEventCount(session), events: events.get(sessionId) ?? [] };
}

export async function renameAgentSession(
  sessionId: string,
  title: string
): Promise<AgentSessionResult> {
  await loadIfNeeded();
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Agent session not found: ${sessionId}`);
  session.title = normalizeTitle(title);
  session.titleSource = 'user';
  session.updatedAt = nowIso();
  sessions.set(sessionId, session);
  await persistIndex();
  return { session: withEventCount(session), events: events.get(sessionId) ?? [] };
}

export async function setAgentSessionAutoTitle(
  sessionId: string,
  title: string,
  summary?: string
): Promise<AgentSessionResult> {
  await loadIfNeeded();
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Agent session not found: ${sessionId}`);
  if (session.titleSource === 'user') {
    return { session: withEventCount(session), events: events.get(sessionId) ?? [] };
  }
  session.title = normalizeTitle(title);
  session.titleSource = 'auto';
  if (summary?.trim()) session.lastSummary = summary.trim().replace(/\s+/g, ' ').slice(0, 160);
  session.updatedAt = nowIso();
  sessions.set(sessionId, session);
  await persistIndex();
  return { session: withEventCount(session), events: events.get(sessionId) ?? [] };
}

export async function archiveAgentSession(
  sessionId: string,
  archived = true
): Promise<AgentSessionListResult> {
  await loadIfNeeded();
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Agent session not found: ${sessionId}`);
  session.archivedAt = archived ? nowIso() : undefined;
  session.updatedAt = nowIso();
  sessions.set(sessionId, session);
  if (currentSessionId === sessionId) currentSessionId = undefined;
  const key = workspaceKey(session);
  if (currentByWorkspace.get(key) === sessionId) currentByWorkspace.delete(key);
  await persistIndex();
  return listAgentSessions({
    workspaceId: session.workspaceId,
    workspaceHash: session.workspaceHash,
    includeArchived: false,
  });
}

export async function appendAgentEvents(
  sessionId: string,
  nextEvents: AgentEvent[]
): Promise<AgentSessionResult> {
  await loadIfNeeded();
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Agent session not found: ${sessionId}`);
  }
  const current = events.get(sessionId) ?? [];
  current.push(...nextEvents);
  events.set(sessionId, current);
  updateSessionSummary(session, nextEvents);
  session.updatedAt = nowIso();
  sessions.set(sessionId, session);
  currentSessionId = sessionId;
  currentByWorkspace.set(workspaceKey(session), sessionId);
  if (nextEvents.length > 0) {
    await appendFile(
      sessionPath(sessionId),
      nextEvents.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf-8'
    );
    await appendAgentTraceFromEvents(sessionId, nextEvents);
  }
  await persistIndex();
  return { session: withEventCount(session), events: current };
}

export async function getAgentSession(
  sessionId?: string,
  request: ListAgentSessionsRequest = {}
): Promise<AgentSessionResult | null> {
  await loadIfNeeded();
  const targetId = sessionId ?? selectCurrentSession(request);
  if (!targetId) return null;
  const session = sessions.get(targetId);
  if (!session || session.archivedAt) return null;
  currentSessionId = session.id;
  currentByWorkspace.set(workspaceKey(session), session.id);
  await persistIndex();
  return { session: withEventCount(session), events: events.get(targetId) ?? [] };
}
