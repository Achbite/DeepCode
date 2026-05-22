export type HostOsKind = 'windows' | 'linux' | 'macos' | 'other';

export type ShellRuntimeKind =
  | 'wsl'
  | 'bash'
  | 'zsh'
  | 'powershell'
  | 'cmd'
  | 'custom';

export interface ShellProblem {
  code: string;
  message: string;
  fixHint?: string;
}

export interface WslDistroStatus {
  name: string;
  state: string;
  version: string;
}

export interface ShellEnvironmentStatus {
  os: HostOsKind;
  preferredShell: ShellRuntimeKind;
  available: boolean;
  command: string;
  args: string[];
  wsl?: {
    installed: boolean;
    defaultDistro?: string;
    distros: WslDistroStatus[];
    dockerAvailable?: boolean;
  };
  problems: ShellProblem[];
}

export interface TerminalCapability {
  defaultShell: ShellRuntimeKind;
  shells: ShellRuntimeKind[];
  supportsPty: boolean;
  agentUsesUnixCommands: boolean;
  shell: ShellEnvironmentStatus;
}

export interface TerminalSession {
  id: string;
  name: string;
  shellKind: ShellRuntimeKind;
  cwd: string;
  status: 'starting' | 'running' | 'exited' | 'failed';
  createdAt: string;
  updatedAt: string;
  order: number;
  exitCode?: number | null;
}

export interface TerminalEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: 'stdout' | 'stderr' | 'exit' | 'error' | 'status';
  data?: string;
  exitCode?: number | null;
  timestamp: string;
}

export interface CreateTerminalSessionRequest {
  name?: string;
  shellKind?: ShellRuntimeKind;
  cwd?: string;
}

export interface TerminalInputRequest {
  data: string;
}

export interface TerminalResizeRequest {
  cols: number;
  rows: number;
}

export interface TerminalSessionsResult {
  sessions: TerminalSession[];
}

export interface TerminalEventsResult {
  events: TerminalEvent[];
}

export interface TerminalProposedCommand {
  id: string;
  sessionId?: string;
  command: string;
  cwd?: string;
  reason: string;
  risk: 'low' | 'medium' | 'high' | 'blocked';
  requiresApproval: true;
  createdAt: string;
}
