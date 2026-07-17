import type { AgentMode, AgentWorkspaceBinding } from './agent.js';

export type IsolationLevel = 'none' | 'supervised' | 'osSandbox';
export type SandboxSupportState = 'unavailable' | 'contractOnly' | 'experimental' | 'enforced';
export type IsolationFallbackPolicy = 'deny';

export type KernelToolFamily =
  | 'workspace'
  | 'document'
  | 'git'
  | 'process'
  | 'network'
  | 'browser'
  | 'provider';
export type KernelToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type KernelToolPermissionMode = 'allow' | 'ask' | 'deny';
export type KernelToolExecutionMode = 'execute' | 'previewOnly' | 'blocked';
export type KernelPathScopePolicy = 'none' | 'workspaceReadScope' | 'workspacePathScopedGrant';
export type KernelPlanTargetMode = 'perTarget' | 'sourceDestination' | 'aggregate';
export type KernelPlanTargetSource =
  | 'none'
  | 'path'
  | 'pathOrCurrentDirectory'
  | 'sourceDestination'
  | 'gitWorkspace'
  | 'gitIndex'
  | 'gitRemote'
  | 'networkUrl'
  | 'networkQuery';
export type KernelTargetExistence = 'any' | 'mustExist' | 'mustNotExist';
export type KernelToolTargetKind = 'file' | 'directory';
export type KernelToolContentMode = 'none' | 'contentBlock' | 'replacementBlock';
export type KernelToolOperationKind =
  | 'fsRead'
  | 'fsList'
  | 'fsGlob'
  | 'fsDiff'
  | 'fsCreate'
  | 'fsWrite'
  | 'fsEdit'
  | 'fsRename'
  | 'fsDelete'
  | 'fsEnsureDirectory'
  | 'codeGrep'
  | 'documentRead'
  | 'gitStatus'
  | 'gitDiff'
  | 'gitStage'
  | 'gitUnstage'
  | 'gitCommit'
  | 'gitPush'
  | 'processExec'
  | 'webSearch'
  | 'webFetch'
  | 'browserOpen'
  | 'browserReload'
  | 'browserSnapshot'
  | 'browserInspect'
  | 'browserClick'
  | 'browserType'
  | 'browserScroll'
  | 'providerCall';

export interface IsolationContract {
  minimumLevel: IsolationLevel;
  supportState: SandboxSupportState;
  backendRequirement?: string;
  profileRef?: string;
  fallback: IsolationFallbackPolicy;
  outputTrust: 'toolFact' | 'untrustedEvidence';
}

export interface SandboxCapabilitySnapshot {
  schemaVersion: string;
  backend: string;
  supportState: SandboxSupportState;
  executablePathRef?: string;
  backendVersion?: string;
  platform: string;
  features: string[];
  probeStatus: string;
  probeDiagnostics: string[];
  observedAt: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  needsApproval: boolean;
  allowedModes: AgentMode[];
  capability?: string;
  family?: 'workspace' | 'document' | 'git' | 'process' | 'network' | 'browser' | 'provider' | string;
  operationKind?: string;
  permissionMode?: 'allow' | 'ask' | 'deny' | string;
  pathScopePolicy?: string;
  executionMode?: 'execute' | 'previewOnly' | 'blocked' | string;
  isolation?: IsolationContract;
  readOnly?: boolean;
  catalogVersion?: string;
  catalogHash?: string;
}

export interface KernelToolCatalogTool {
  toolId: string;
  capability: string;
  family: KernelToolFamily;
  operationKind: KernelToolOperationKind;
  providerSchema: object;
  planningSchema: object;
  providerVisible?: boolean;
  forbiddenFields?: string[];
  risk: KernelToolRiskLevel;
  permissionMode: KernelToolPermissionMode;
  permissionSummary?: string;
  pathScopePolicy: KernelPathScopePolicy;
  planTargetMode: KernelPlanTargetMode;
  planTargetSource: KernelPlanTargetSource;
  executionMode: KernelToolExecutionMode;
  isolation: IsolationContract;
  hardDenyRules?: string[];
  needsWorkspace: boolean;
  readOnly: boolean;
  usageConstraints: ToolUsageConstraints;
}

export interface ToolUsageConstraints {
  targetExistence: KernelTargetExistence;
  sourceExistence?: KernelTargetExistence;
  destinationExistence?: KernelTargetExistence;
  targetKinds?: KernelToolTargetKind[];
  contentMode: KernelToolContentMode;
  directoryRecursiveRequired?: boolean;
}

export interface KernelToolCatalogSnapshot {
  catalogVersion: string;
  catalogHash: string;
  tools: KernelToolCatalogTool[];
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
  catalogVersion: string;
  catalogHash: string;
  toolCatalog: KernelToolCatalogSnapshot;
}

export interface FsReadInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface FsContentInput {
  path: string;
  contentBlockId: string;
}

export interface FsDeleteInput {
  path: string;
  targetKind?: 'file' | 'directory';
  recursive?: boolean;
}

export interface FsListInput {
  path: string;
  depth?: number;
  includeHidden?: boolean;
}

export interface FsDiffInput {
  path: string;
  contentBlockId: string;
}

export interface FsGlobInput {
  pattern: string;
  path?: string;
  maxResults?: number;
}

export interface FsEditInput {
  path: string;
  replacementBlockId: string;
  patchSpec: Record<string, unknown>;
}

export interface FsRenameInput {
  path: string;
  destinationPath: string;
}

export interface CodeGrepInput {
  query: string;
  path?: string;
  strategy?: 'literal' | 'regex';
  include?: string[];
  exclude?: string[];
  contextLines?: number;
  maxResults?: number;
}

export interface WebSearchInput {
  query: string;
  limit?: number;
}

export interface WebFetchInput {
  url: string;
  maxBytes?: number;
}

export interface GitDiffInput {
  path?: string;
  staged?: boolean;
}

export interface GitPathInput {
  path?: string;
  paths?: string[];
}

export interface GitCommitInput {
  message: string;
}

export interface BrowserOpenInput {
  url: string;
}

export interface BrowserSnapshotInput {
  selector?: string;
}

export interface BrowserInspectInput {
  inspectState?: string;
}

export interface BrowserSelectorInput {
  selector: string;
}

export interface BrowserTypeInput extends BrowserSelectorInput {
  text: string;
}

export interface BrowserScrollInput {
  deltaY?: number;
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
