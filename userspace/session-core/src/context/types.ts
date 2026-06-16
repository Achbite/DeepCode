export interface StablePrefixRef {
  hash: string;
  templateVersion: string;
  schemaVersion: string;
}

export interface DynamicSuffixRef {
  hash: string;
  requirementId?: string;
  reviewRoundId?: string;
  contextSnapshotId?: string;
}

export type ResourceReadPolicy = 'autoRead' | 'askRead' | 'denyRead';

export type ResourceManifestEntryKind = 'file' | 'directory' | 'resource' | 'symbol' | 'search' | 'checkpoint' | 'index' | 'ruler';

export interface ResourceManifestEntry {
  id: string;
  kind: ResourceManifestEntryKind;
  label: string;
  resourceRef: string;
  readPolicy: ResourceReadPolicy;
  reason: string;
  offsetBytes?: number;
  limitBytes?: number;
}

export interface ResourceManifestBudget {
  maxEntries: number;
  maxBytes: number;
}

export interface ResourceManifest {
  id: string;
  workspaceScopeKey: string;
  workspaceId?: string;
  entries: ResourceManifestEntry[];
  budget: ResourceManifestBudget;
  defaultDenyPatterns: string[];
}

export interface ProjectWorkingDirectory {
  rootId: string;
  label: string;
  displayPath: string;
  absolutePath?: string;
  source: 'currentAttachment' | 'projectWorkingDirectory' | 'recentAttachment' | 'sessionAttachment' | 'workspaceBinding';
}

export interface ConversationResourceRoot extends ProjectWorkingDirectory {
  kind: 'directory';
}

export interface InitialContextPacket {
  id: string;
  workspaceScopeKey: string;
  fileTreeSummary?: string;
  projectIndexSummary?: string;
  readmeSummary?: string;
  entrypointSummary?: string;
  checkpointSummary?: string;
  rulerSummary?: string;
  workflowCapabilitySummary?: string;
  manifest: ResourceManifest;
}

export interface ResourceRequestItem {
  id: string;
  manifestEntryId?: string;
  path?: string;
  rootId?: string;
  offsetBytes?: number;
  limitBytes?: number;
  reason: string;
}

export interface ResourceRequest {
  id: string;
  items: ResourceRequestItem[];
}

export interface ResourcePacketItem {
  requestItemId: string;
  manifestEntryId: string;
  readPolicy: ResourceReadPolicy;
  status: 'provided' | 'resolved' | 'needsUserApproval' | 'denied' | 'error';
  contentKind?: 'directoryTree' | 'fileText' | 'searchResults' | 'summary' | 'text' | 'json';
  contentSummary?: string;
  promptContent?: string;
  truncated?: boolean;
  originalBytes?: number;
  offsetBytes?: number;
  limitBytes?: number;
  returnedBytes?: number;
  rangeComplete?: boolean;
  denialReason?: string;
  evidenceRefs?: string[];
  sourceKind?: 'kernelResource' | 'manifestOnly';
}

export interface ResourcePacket {
  id: string;
  workspaceScopeKey: string;
  requestId: string;
  items: ResourcePacketItem[];
}

export interface ProtocolContractBlock {
  protocolContractHash: string;
  workflowStateContract: string;
  outputSchemaSummary: string;
  resourceRequestSchemaSummary: string;
  actionBundleSchemaSummary: string;
  failClosedRules: string[];
  capabilityProjectionSchema: string;
  workflowProjectionSchema: string;
}

export interface BuiltinSystemPromptBlock {
  builtinSystemPromptHash: string;
  version: string;
  content: string;
  editable: false;
}

export interface RulerBlock {
  rulerHash: string;
  constraintSummaries: string[];
  ignoredClauseCount: number;
  canGrantPermission: false;
  canOverrideProtocolContract: false;
  canOverrideSystemPrompt: false;
}

export interface CurrentUserOverlayBlock {
  overlayHash: string;
  content: string;
}

export interface AuthoritativeDocExcerptBlock {
  docExcerptHash: string;
  excerpts: Array<{
    docKind: 'humanProjectPlan' | 'humanStageWorkbench';
    path: string;
    lineStart: number;
    lineEnd: number;
    heading?: string;
    excerptHash: string;
  }>;
}

export interface MemoryHintBlock {
  memoryHintHashes: string[];
  summaries: string[];
}

export interface ResourceContextBlock {
  initialContextId?: string;
  resourcePacketHashes: string[];
  resourcePacketSummaries: string[];
}

export interface AuditOnlyContextBlock {
  runId?: string;
  sessionId?: string;
  traceId?: string;
  projectionCardIds?: string[];
  ledgerRefs?: string[];
  auditRefs?: string[];
}

export interface PromptEnvelopeParts {
  protocolContract: ProtocolContractBlock;
  builtinSystemPrompt: BuiltinSystemPromptBlock;
  rulerContext?: RulerBlock;
  currentUserOverlay?: CurrentUserOverlayBlock;
  authoritativeDocExcerpts?: AuthoritativeDocExcerptBlock;
  memoryHints?: MemoryHintBlock;
  resourceContext?: ResourceContextBlock;
  auditOnlyContext?: AuditOnlyContextBlock;
}
