import type {
  CodeGrepResult,
  GitDiffResult,
  GitStatusResult,
} from './tools.js';
import type { FileReadResult, FileTreeNode } from './files.js';
import type { BrowsePathResult } from './workspace.js';

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
