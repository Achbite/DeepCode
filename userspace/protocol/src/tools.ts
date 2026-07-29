/**
 * Host inspection DTOs. Agent-facing tool identity, schema, availability, and
 * context are defined exclusively by kernelAbiV2 ToolInventory/ToolContext.
 */
export interface CodeGrepInput {
  query: string;
  path?: string;
  strategy?: 'literal' | 'regex';
  include?: string[];
  exclude?: string[];
  contextLines?: number;
  maxResults?: number;
}

export interface GitDiffInput {
  path?: string;
  staged?: boolean;
}

/** Raw Provider function-call frame; Session maps name to v2 ToolId. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface CodeGrepMatch {
  path: string;
  line: number;
  preview: string;
  before?: Array<{ line: number; text: string }>;
  after?: Array<{ line: number; text: string }>;
}

export interface CodeGrepResult {
  folderId: string;
  query: string;
  path: string;
  strategy: 'literal' | 'regex';
  include: string[];
  exclude: string[];
  contextLines: number;
  maxResults: number;
  returnedMatches: number;
  truncated: boolean;
  visitedFiles: number;
  skippedFiles: number;
  skippedBinaryFiles: number;
  skippedExecutableFiles: number;
  matches: CodeGrepMatch[];
}

export interface GitChangeItem {
  path: string;
  index: string;
  worktree: string;
  group: 'staged' | 'changed' | 'untracked' | string;
  raw: string;
}

export interface GitStatusResult {
  root: string;
  changes: GitChangeItem[];
  raw: string;
}

export interface GitDiffResult {
  root: string;
  path?: string | null;
  staged: boolean;
  diff: string;
  truncated: boolean;
}
