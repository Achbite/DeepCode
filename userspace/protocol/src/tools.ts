import type { AgentMode, AgentWorkspaceBinding } from './agent.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  riskLevel: 'low' | 'medium' | 'high';
  needsApproval: boolean;
  allowedModes: AgentMode[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface ToolExecutionRequest {
  mode: AgentMode;
  toolCall: ToolCall;
  workspaceBinding?: AgentWorkspaceBinding;
}

export interface PermissionEvaluationRequest {
  mode: AgentMode;
  toolCall: ToolCall;
  workspaceBinding?: AgentWorkspaceBinding;
}

export interface ListToolsResult {
  tools: ToolDefinition[];
}

export interface FsReadInput {
  path: string;
  folderId?: string;
}

export interface FsWriteInput {
  path: string;
  content: string;
  folderId?: string;
}

export interface FsListInput {
  path: string;
  folderId?: string;
  depth?: number;
}

export interface FsDiffInput {
  path: string;
  newContent: string;
  folderId?: string;
}

export interface CodeSearchInput {
  query: string;
  isRegex?: boolean;
  include?: string[];
  folderId?: string;
}

export interface ShellProposeInput {
  command: string;
  reason?: string;
}

export interface ShellExecInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  reason?: string;
}

export interface ShellExecResult {
  command: string;
  cwd: string;
  executed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  tempSessionId: string;
  cleanupStatus: 'terminated' | 'alreadyExited' | 'failed';
}

export interface CodeSearchMatch {
  folderId: string;
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface CodeSearchResult {
  matches: CodeSearchMatch[];
}
