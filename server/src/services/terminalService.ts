import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  CreateTerminalSessionRequest,
  ShellRuntimeKind,
  TerminalCapability,
  TerminalEvent,
  TerminalEventsResult,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSessionsResult,
  TerminalWarmupStatus,
} from '@deepcode/protocol';
import { getShellEnvironmentStatus } from './runtimeShellService.js';

interface TerminalSessionRecord {
  session: TerminalSession;
  child: ChildProcessWithoutNullStreams;
  events: TerminalEvent[];
  sequence: number;
}

const sessions = new Map<string, TerminalSessionRecord>();
let sessionCounter = 0;
let warmupStatus: TerminalWarmupStatus = {
  state: 'idle',
  defaultShell: getShellEnvironmentStatus().preferredShell,
  startedAt: null,
  completedAt: null,
  message: null,
  problems: [],
};

function now(): string {
  return new Date().toISOString();
}

function nextId(prefix: string): string {
  sessionCounter += 1;
  return `${prefix}-${Date.now()}-${sessionCounter}`;
}

function appendEvent(
  record: TerminalSessionRecord,
  type: TerminalEvent['type'],
  data?: string,
  exitCode?: number | null
): void {
  record.sequence += 1;
  const event: TerminalEvent = {
    id: `${record.session.id}-event-${record.sequence}`,
    sessionId: record.session.id,
    sequence: record.sequence,
    type,
    data,
    exitCode,
    timestamp: now(),
  };
  record.events.push(event);
  if (record.events.length > 1000) {
    record.events.splice(0, record.events.length - 1000);
  }
}

function shellCommand(kind: ShellRuntimeKind | undefined): {
  shellKind: ShellRuntimeKind;
  command: string;
  args: string[];
} {
  const detected = getShellEnvironmentStatus();
  const requested = kind ?? detected.preferredShell;

  if (requested === 'wsl') {
    return { shellKind: 'wsl', command: 'wsl.exe', args: [] };
  }
  if (requested === 'powershell') {
    return { shellKind: 'powershell', command: 'powershell.exe', args: ['-NoLogo'] };
  }
  if (requested === 'cmd') {
    return { shellKind: 'cmd', command: 'cmd.exe', args: [] };
  }
  if (requested === 'zsh') {
    return { shellKind: 'zsh', command: existsSync('/bin/zsh') ? '/bin/zsh' : 'zsh', args: [] };
  }
  return { shellKind: 'bash', command: existsSync('/bin/bash') ? '/bin/bash' : 'bash', args: [] };
}

function safeCwd(cwd?: string): string {
  if (!cwd || cwd.trim() === '') return process.cwd();
  const absolute = resolve(cwd);
  return existsSync(absolute) ? absolute : process.cwd();
}

export function getTerminalCapability(): TerminalCapability {
  const shell = getShellEnvironmentStatus();
  const shells: ShellRuntimeKind[] =
    shell.os === 'windows'
      ? shell.wsl?.installed
        ? ['wsl', 'powershell', 'cmd']
        : ['powershell', 'cmd']
      : ['bash', 'zsh'];

  return {
    defaultShell: shell.available ? shell.preferredShell : shells[0] ?? 'custom',
    shells,
    supportsPty: false,
    agentUsesUnixCommands: true,
    shell,
  };
}

export function getTerminalWarmupStatus(): TerminalWarmupStatus {
  return warmupStatus;
}

export function warmupTerminalRuntime(): TerminalWarmupStatus {
  if (warmupStatus.state === 'warming' || warmupStatus.state === 'ready') {
    return warmupStatus;
  }
  warmupStatus = {
    state: 'warming',
    defaultShell: getShellEnvironmentStatus().preferredShell,
    startedAt: now(),
    completedAt: null,
    message: 'warming terminal runtime',
    problems: [],
  };
  setTimeout(() => {
    const shell = getShellEnvironmentStatus();
    warmupStatus = {
      state: shell.available ? 'ready' : 'error',
      defaultShell: shell.preferredShell,
      startedAt: warmupStatus.startedAt,
      completedAt: now(),
      message: shell.available ? 'terminal runtime ready' : 'terminal runtime unavailable',
      problems: shell.problems,
    };
  }, 0);
  return warmupStatus;
}

export function listTerminalSessions(): TerminalSessionsResult {
  return {
    sessions: Array.from(sessions.values())
      .map((record) => record.session)
      .sort((a, b) => a.order - b.order),
  };
}

export function createTerminalSession(
  input: CreateTerminalSessionRequest = {}
): TerminalSession {
  const commandSpec = shellCommand(input.shellKind);
  const id = nextId('term');
  const createdAt = now();
  const cwd = safeCwd(input.cwd);
  const session: TerminalSession = {
    id,
    name: input.name?.trim() || `Terminal ${sessions.size + 1}`,
    shellKind: commandSpec.shellKind,
    cwd,
    status: 'starting',
    createdAt,
    updatedAt: createdAt,
    order: sessions.size,
    exitCode: null,
  };

  const child = spawn(commandSpec.command, commandSpec.args, {
    cwd,
    env: process.env,
    windowsHide: true,
  });

  const record: TerminalSessionRecord = {
    session,
    child,
    events: [],
    sequence: 0,
  };
  sessions.set(id, record);

  child.stdout.on('data', (chunk: Buffer) => {
    appendEvent(record, 'stdout', chunk.toString('utf8'));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    appendEvent(record, 'stderr', chunk.toString('utf8'));
  });
  child.on('spawn', () => {
    record.session.status = 'running';
    record.session.updatedAt = now();
    appendEvent(record, 'ready', 'ready');
    appendEvent(record, 'status', 'running');
  });
  child.on('error', (err) => {
    record.session.status = 'error';
    record.session.updatedAt = now();
    appendEvent(record, 'error', err.message);
  });
  child.on('exit', (code) => {
    record.session.status = 'exited';
    record.session.exitCode = code;
    record.session.updatedAt = now();
    appendEvent(record, 'exit', undefined, code);
  });

  return session;
}

export function writeTerminalInput(
  sessionId: string,
  input: TerminalInputRequest
): TerminalSession {
  const record = sessions.get(sessionId);
  if (!record) throw new Error(`terminal_session_not_found: ${sessionId}`);
  if (record.session.status !== 'running') {
    throw new Error(`terminal_session_not_running: ${sessionId}`);
  }
  record.child.stdin.write(input.data);
  record.session.updatedAt = now();
  return record.session;
}

export function resizeTerminalSession(
  sessionId: string,
  _input: TerminalResizeRequest
): TerminalSession {
  const record = sessions.get(sessionId);
  if (!record) throw new Error(`terminal_session_not_found: ${sessionId}`);
  record.session.updatedAt = now();
  appendEvent(record, 'status', 'resize accepted');
  return record.session;
}

export function updateTerminalSession(
  sessionId: string,
  input: Partial<Pick<TerminalSession, 'name' | 'order'>>
): TerminalSession {
  const record = sessions.get(sessionId);
  if (!record) throw new Error(`terminal_session_not_found: ${sessionId}`);
  if (typeof input.name === 'string' && input.name.trim()) {
    record.session.name = input.name.trim();
  }
  if (typeof input.order === 'number' && Number.isFinite(input.order)) {
    record.session.order = input.order;
  }
  record.session.updatedAt = now();
  return record.session;
}

export function restartTerminalSession(sessionId: string): TerminalSession {
  const record = sessions.get(sessionId);
  if (!record) throw new Error(`terminal_session_not_found: ${sessionId}`);
  const { name, shellKind, cwd } = record.session;
  deleteTerminalSession(sessionId);
  return createTerminalSession({ name, shellKind, cwd });
}

export function deleteTerminalSession(sessionId: string): TerminalSession {
  const record = sessions.get(sessionId);
  if (!record) throw new Error(`terminal_session_not_found: ${sessionId}`);
  if (record.session.status === 'running' || record.session.status === 'starting') {
    record.child.kill();
  }
  sessions.delete(sessionId);
  record.session.status = 'exited';
  record.session.updatedAt = now();
  return record.session;
}

export function getTerminalEvents(sessionId?: string, after?: number): TerminalEventsResult {
  const minSequence = Number.isFinite(after) ? Number(after) : 0;
  const records = sessionId
    ? [sessions.get(sessionId)].filter((item): item is TerminalSessionRecord => Boolean(item))
    : Array.from(sessions.values());
  return {
    events: records.flatMap((record) =>
      record.events.filter((event) => event.sequence > minSequence)
    ),
  };
}

process.once('exit', () => {
  for (const record of sessions.values()) {
    if (record.session.status === 'running' || record.session.status === 'starting') {
      record.child.kill();
    }
  }
});
