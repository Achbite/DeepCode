import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ShellExecInput, ShellExecResult, ShellRuntimeKind } from '@deepcode/protocol';
import { getShellEnvironmentStatus } from '../../services/runtimeShellService.js';
import { resolveFolder } from '../../services/workspaceService.js';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 30000;
const OUTPUT_LIMIT = 64 * 1024;
const SHELL_ENCODING_PREAMBLE = [
  'export LANG="${LANG:-C.UTF-8}"',
  'export LC_ALL="${LC_ALL:-C.UTF-8}"',
  'export PYTHONIOENCODING="utf-8"',
].join('; ');

let tempShellCounter = 0;

function nextTempSessionId(): string {
  tempShellCounter += 1;
  return `agent-shell-${Date.now()}-${tempShellCounter}`;
}

function normalizeTimeout(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(Math.floor(raw), MAX_TIMEOUT_MS));
}

function shellCommand(command: string): {
  shellKind: ShellRuntimeKind;
  command: string;
  args: string[];
} {
  const normalizedCommand = `${SHELL_ENCODING_PREAMBLE}\n${command}`;
  const shell = getShellEnvironmentStatus();
  if (shell.os === 'windows') {
    if (!shell.wsl?.installed) {
      throw new Error('wsl_missing: Windows Agent shell execution requires WSL. Install WSL and configure Docker before running Agent shell tools.');
    }
    return {
      shellKind: 'wsl',
      command: 'wsl.exe',
      args: ['--', 'bash', '-lc', normalizedCommand],
    };
  }
  const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  return {
    shellKind: 'bash',
    command: bash,
    args: ['-lc', normalizedCommand],
  };
}

function safeCwd(cwd?: string): string {
  const folder = resolveFolder();
  const root = folder.absolutePath;
  if (!cwd || cwd.trim() === '') return root;
  const absolute = resolve(root, cwd);
  const normalizedRoot = resolve(root);
  if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}\\`) && !absolute.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`path_traversal_blocked: cwd must stay inside workspace: ${cwd}`);
  }
  return existsSync(absolute) ? absolute : root;
}

function appendBounded(current: string, next: string): { value: string; truncated: boolean } {
  const combined = current + next;
  if (combined.length <= OUTPUT_LIMIT) return { value: combined, truncated: false };
  return {
    value: combined.slice(0, OUTPUT_LIMIT),
    truncated: true,
  };
}

export async function executeAgentShellCommand(input: ShellExecInput): Promise<ShellExecResult> {
  const tempSessionId = nextTempSessionId();
  const cwd = safeCwd(input.cwd);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const spec = shellCommand(input.command);
  const startedAt = Date.now();

  let stdout = '';
  let stderr = '';
  let truncated = false;
  let cleanupStatus: ShellExecResult['cleanupStatus'] = 'alreadyExited';

  return new Promise<ShellExecResult>((resolvePromise) => {
    let settled = false;
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: process.env,
      windowsHide: true,
    });

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        const appended = appendBounded(stderr, error);
        stderr = appended.value;
        truncated = truncated || appended.truncated;
      }
      resolvePromise({
        command: input.command,
        cwd,
        executed: true,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        truncated,
        tempSessionId,
        cleanupStatus,
      });
    };

    const timer = setTimeout(() => {
      cleanupStatus = 'terminated';
      try {
        child.kill();
      } catch {
        cleanupStatus = 'failed';
      }
      finish(null, `\nCommand timed out after ${timeoutMs}ms.`);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk.toString('utf8'));
      stdout = appended.value;
      truncated = truncated || appended.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk.toString('utf8'));
      stderr = appended.value;
      truncated = truncated || appended.truncated;
    });
    child.on('error', (err) => {
      cleanupStatus = 'failed';
      finish(null, err.message);
    });
    child.on('exit', (code) => {
      cleanupStatus = 'alreadyExited';
      finish(code);
    });
  });
}
