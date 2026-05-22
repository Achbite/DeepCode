import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import type {
  HostOsKind,
  ShellEnvironmentStatus,
  ShellRuntimeKind,
  WslDistroStatus,
} from '@deepcode/protocol';

function hostOs(): HostOsKind {
  const value = platform();
  if (value === 'win32') return 'windows';
  if (value === 'darwin') return 'macos';
  if (value === 'linux') return 'linux';
  return 'other';
}

function commandWorks(command: string, args: string[] = []): boolean {
  try {
    execFileSync(command, args, {
      stdio: 'ignore',
      timeout: 2500,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function readCommand(command: string, args: string[] = []): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 3500,
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

function parseWslList(raw: string): WslDistroStatus[] {
  return raw
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter((line) => line && !/^NAME\s+STATE\s+VERSION/i.test(line))
    .map((line) => {
      const parts = line.split(/\s{2,}|\t+/).filter(Boolean);
      return {
        name: parts[0] ?? line,
        state: parts[1] ?? 'Unknown',
        version: parts[2] ?? 'Unknown',
      };
    });
}

function detectWindowsShell(): ShellEnvironmentStatus {
  const wslInstalled = commandWorks('wsl.exe', ['--status']);
  const distros = wslInstalled ? parseWslList(readCommand('wsl.exe', ['-l', '-v'])) : [];
  const defaultDistro = distros[0]?.name;
  const dockerAvailable = wslInstalled
    ? commandWorks('wsl.exe', ['bash', '-lc', 'command -v docker >/dev/null 2>&1'])
    : false;

  if (wslInstalled) {
    return {
      os: 'windows',
      preferredShell: 'wsl',
      available: true,
      command: 'wsl.exe',
      args: ['bash', '-lc'],
      wsl: {
        installed: true,
        defaultDistro,
        distros,
        dockerAvailable,
      },
      problems: dockerAvailable
        ? []
        : [
            {
              code: 'docker_not_found_in_wsl',
              message: 'WSL is available, but Docker was not detected inside WSL.',
              fixHint:
                'Enable Docker Desktop WSL integration or install Docker Engine inside the default WSL distro.',
            },
          ],
    };
  }

  return {
    os: 'windows',
    preferredShell: 'wsl',
    available: false,
    command: 'wsl.exe',
    args: ['bash', '-lc'],
    wsl: {
      installed: false,
      distros: [],
      dockerAvailable: false,
    },
    problems: [
      {
        code: 'wsl_not_installed',
        message: 'WSL is required for Agent-generated Unix command execution on Windows.',
        fixHint:
          'Run `wsl --install`, install Ubuntu or Debian, then configure Docker Desktop WSL integration.',
      },
    ],
  };
}

function detectUnixShell(os: HostOsKind): ShellEnvironmentStatus {
  const shell = process.env.SHELL ?? '';
  const preferred: ShellRuntimeKind = shell.includes('zsh') ? 'zsh' : 'bash';
  const command =
    shell && existsSync(shell)
      ? shell
      : existsSync('/bin/bash')
        ? '/bin/bash'
        : existsSync('/bin/zsh')
          ? '/bin/zsh'
          : 'sh';

  return {
    os,
    preferredShell: command.includes('zsh') ? 'zsh' : 'bash',
    available: true,
    command,
    args: [],
    problems: [],
  };
}

export function getShellEnvironmentStatus(): ShellEnvironmentStatus {
  const os = hostOs();
  if (os === 'windows') return detectWindowsShell();
  if (os === 'linux' || os === 'macos') return detectUnixShell(os);
  return {
    os,
    preferredShell: 'custom',
    available: false,
    command: '',
    args: [],
    problems: [
      {
        code: 'unsupported_os',
        message: `Unsupported host platform: ${platform()}`,
      },
    ],
  };
}
