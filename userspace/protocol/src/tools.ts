/** UI 发起的只读 Host 检查 DTO；Agent 工具使用 localAgent.ts 中的 KernelPort。 */
import type { FileReadResult, FileTreeNode } from './files.js';
import type { BrowsePathResult } from './workspace.js';

export interface CodeGrepInput {
  query: string;
  path?: string;
  strategy?: 'literal' | 'regex';
  include?: string[];
  exclude?: string[];
  contextLines?: number;
  maxResults?: number;
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

/** Host 壳层检查接口，不参与 Agent Loop 或工具执行记录。 */
export type KernelHostInspectionQuery =
  | { kind: 'browse'; path?: string }
  | { kind: 'list'; folderId?: string; path: string; depth: number }
  | { kind: 'read'; folderId?: string; path: string }
  | {
      kind: 'grep';
      folderId?: string;
      query: string;
      path: string;
      include: string[];
      exclude: string[];
      strategy: 'literal' | 'regex';
      contextLines: number;
      maxResults: number;
    }
  | { kind: 'gitStatus' }
  | { kind: 'gitDiff'; path?: string; staged: boolean };

export type KernelHostInspectionOutput =
  | { kind: 'browse'; data: BrowsePathResult }
  | { kind: 'list'; data: FileTreeNode[] }
  | { kind: 'read'; data: FileReadResult }
  | { kind: 'grep'; data: CodeGrepResult }
  | { kind: 'gitStatus'; data: GitStatusResult }
  | { kind: 'gitDiff'; data: GitDiffResult };

export interface KernelHostInspectionResult {
  source: 'hostProjection';
  output: KernelHostInspectionOutput;
}
