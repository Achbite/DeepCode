import { mkdir, readFile, readdir, rename, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentMode,
  AgentSession,
  AgentSessionResult,
} from '@deepcode/protocol';
import { resolveDeepCodeConfigDir } from './appDataPath.js';

interface SessionFileHeader {
  kind: 'session';
  session: AgentSession;
}

const SESSIONS_DIR = join(resolveDeepCodeConfigDir(), 'sessions');
const SESSION_INDEX_PATH = join(SESSIONS_DIR, 'index.json');

const sessions = new Map<string, AgentSession>();
const events = new Map<string, AgentEvent[]>();
let loaded = false;

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

async function persistIndex(): Promise<void> {
  await ensureDir();
  const tmp = `${SESSION_INDEX_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify([...sessions.values()], null, 2), 'utf-8');
  await rename(tmp, SESSION_INDEX_PATH);
}

async function loadIfNeeded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  await ensureDir();
  try {
    const raw = await readFile(SESSION_INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const session of parsed) {
        if (session?.id) sessions.set(session.id, session);
      }
    }
  } catch {
    // First run.
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
          sessions.set(header.session.id, header.session);
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

export async function createAgentSession(
  initialMode: AgentMode = 'plan',
  profileId?: string
): Promise<AgentSessionResult> {
  await loadIfNeeded();
  const ts = nowIso();
  const session: AgentSession = {
    id: `as-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: 'New Agent Session',
    mode: initialMode,
    profileId,
    createdAt: ts,
    updatedAt: ts,
  };
  sessions.set(session.id, session);
  events.set(session.id, []);
  await ensureDir();
  await appendFile(
    sessionPath(session.id),
    `${JSON.stringify({ kind: 'session', session })}\n`,
    'utf-8'
  );
  await persistIndex();
  return { session, events: [] };
}

export async function appendAgentEvents(
  sessionId: string,
  nextEvents: AgentEvent[]
): Promise<AgentSessionResult> {
  await loadIfNeeded();
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Agent session 不存在: ${sessionId}`);
  }
  const current = events.get(sessionId) ?? [];
  current.push(...nextEvents);
  events.set(sessionId, current);
  session.updatedAt = nowIso();
  sessions.set(sessionId, session);
  if (nextEvents.length > 0) {
    await appendFile(
      sessionPath(sessionId),
      nextEvents.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf-8'
    );
  }
  await persistIndex();
  return { session, events: current };
}

export async function getAgentSession(sessionId?: string): Promise<AgentSessionResult | null> {
  await loadIfNeeded();
  const targetId = sessionId ?? [...sessions.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )[0]?.id;
  if (!targetId) return null;
  const session = sessions.get(targetId);
  if (!session) return null;
  return { session, events: events.get(targetId) ?? [] };
}
