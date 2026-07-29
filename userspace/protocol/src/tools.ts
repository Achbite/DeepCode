/**
 * Host inspection DTOs. Agent-facing tool identity, schema, availability, and
 * context are defined exclusively by kernelAbiV2 ToolInventory/ToolContext.
 */
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

/**
 * Host-only inspection contract. These queries are never exposed as Kernel
 * agent tools and cannot create a capability lease or an execution fact.
 */
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

export type KernelHostSkillRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type KernelHostSkillEffect =
  | 'readsWorkspace'
  | 'writesWorkspace'
  | 'createsWorkspace'
  | 'deletesWorkspace'
  | 'readsGit'
  | 'runsProcess'
  | 'usesNetwork'
  | 'readsSecret'
  | 'modifiesGit'
  | 'pushesGit'
  | 'controlsBrowser'
  | 'modifiesKernel'
  | 'modifiesConfig';

export type KernelHostSkillSource =
  | { kind: 'localPack'; packId: string }
  | { kind: 'externalProcess'; program: string; argv: string[] }
  | { kind: 'externalConnector'; connectorId: string };

export interface KernelHostSkillDescriptor {
  id: string;
  version: string;
  titleKey?: string;
  descriptionKey?: string;
  inputSchema: unknown;
  outputSchema: unknown;
  requiredCapabilities: string[];
  allowedPhases: string[];
  riskLevel: KernelHostSkillRiskLevel;
  effects: KernelHostSkillEffect[];
  source: KernelHostSkillSource;
  adapterKind: 'declarative' | 'externalProcess' | 'mcp';
  activationStatus: 'dormant' | 'registered';
  requestedModelVisible: boolean;
}

export interface KernelHostSkillCatalogResult {
  source: 'hostManagement';
  skills: KernelHostSkillDescriptor[];
}
