import type {
  CodeGrepResult,
  GitDiffResult,
  GitStatusResult,
  KernelToolContentMode,
  KernelToolExecutionMode,
  KernelToolOperationKind,
  KernelToolTargetKind,
} from './tools.js';
import type { FileReadResult, FileTreeNode } from './files.js';
import type { BrowsePathResult } from './workspace.js';
import type { KernelCommandV1, KernelEventV1 } from './kernelAbiV1.js';

export type KernelPermissionResourceKind =
  | 'workspacePath'
  | 'gitWorkspace'
  | 'process'
  | 'networkTarget'
  | 'browserState'
  | 'providerProfile'
  | 'runtimePermission';
export type KernelContractExpiry =
  | 'notRequired'
  | 'runBatchUntilReview'
  | 'planReviewOrRunTerminal'
  | 'reviewGateOrRunTerminal'
  | 'reviewGateReplanCancelOrRunTerminal'
  | 'immediate';
export type KernelContractCleanupPolicy = 'none' | 'perOperationCleanupContract' | 'planGrantLease';
export type KernelGateInterventionKind = 'permission' | 'policy';
export type KernelGateInterventionStatus = 'pending' | 'satisfiedByPlanAuthorization';
export type KernelToolFactKind =
  | 'fileText'
  | 'directoryTree'
  | 'fileMatches'
  | 'diffPreview'
  | 'searchResults'
  | 'fileCreate'
  | 'fileWrite'
  | 'filePatch'
  | 'fileRename'
  | 'fileDelete'
  | 'documentText'
  | 'directoryEnsure'
  | 'gitStatus'
  | 'gitDiff'
  | 'gitIndexMutation'
  | 'gitCommit'
  | 'gitPush'
  | 'processResult'
  | 'webSearchEvidence'
  | 'webFetchEvidence'
  | 'providerCall'
  | 'browserEvidence';

export interface KernelFileTargetRef {
  kind: 'workspaceRelative' | 'rootRelative' | 'absolutePath';
  path: string;
  rootId?: string;
}

export interface KernelFileChangedRange {
  startByte?: number;
  endByte?: number;
  replacementBytes?: number;
  startLine?: number;
  endLine?: number;
  oldStartLine?: number;
  oldEndLine?: number;
  newStartLine?: number;
  newEndLine?: number;
}

export type KernelConfigSourceKind =
  | 'kernelDefault'
  | 'bundled'
  | 'system'
  | 'user'
  | 'workspace'
  | 'profile'
  | 'session'
  | 'runOverride'
  | 'externalConnector';

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

export type KernelConfigScope =
  | 'global'
  | 'user'
  | 'workspace'
  | 'profile'
  | 'session'
  | 'run';

export type KernelConfigTrustLevel =
  | 'kernel'
  | 'trusted'
  | 'user'
  | 'workspace'
  | 'untrusted';

export type KernelConfigDomain =
  | 'app'
  | 'editor'
  | 'files'
  | 'terminal'
  | 'agent'
  | 'workflow'
  | 'policy'
  | 'skills'
  | 'ruler'
  | 'style'
  | 'i18n'
  | 'provider'
  | 'session'
  | 'validation'
  | 'host'
  | 'externalConnector';

export interface KernelConfigSource {
  id: string;
  kind: KernelConfigSourceKind;
  scope: KernelConfigScope;
  path?: string;
  trustLevel: KernelConfigTrustLevel;
  schemaVersion: string;
  contentHash?: string;
}

export interface KernelConfigSourceRef {
  id: string;
  kind: KernelConfigSourceKind | string;
  path?: string;
  trustLevel?: KernelConfigTrustLevel | string;
}

export interface KernelConfigLayer {
  source: KernelConfigSource;
  domain?: KernelConfigDomain;
  values: unknown;
}

export interface KernelConfigSnapshotProjection {
  snapshotId: string;
  schemaVersion: string;
  sourceRefs: KernelConfigSourceRef[];
  effective: unknown;
  hash?: string;
  createdAt?: string;
}

export interface KernelLocalePack {
  locale: string;
  name: string;
  fallback: string[];
  namespaces: Record<string, Record<string, string>>;
  schemaVersion: string;
  hash?: string;
}

export interface KernelLocaleMessage {
  locale: string;
  key: string;
  args: unknown;
  text: string;
  fallbackUsed?: string;
  missing: boolean;
}

export type KernelAutonomyLevel =
  | 'safe'
  | 'developer'
  | 'trusted'
  | 'expert'
  | 'maintainerRoot';

export interface KernelRequestId {
  value: string;
}

export interface KernelRunId {
  value: string;
}

export interface KernelSessionId {
  value: string;
}

export interface KernelProfileRef {
  id: string;
  kind?: string;
  hash?: string;
}

export interface KernelCommandEnvelope {
  requestId?: string;
  command: KernelCommandV1;
  idempotencyKey?: string;
  expectedSnapshotSeq?: number;
}

export type KernelDraftLedgerEventKind =
  | 'draft.open'
  | 'draft.chunk'
  | 'draft.file_completed'
  | 'draft.batch_completed'
  | 'draft.discarded'
  | 'draft.committed';

interface KernelArtifactDraftFrameBase {
  schemaVersion: 'deepcode.agent.artifact-draft.v1';
  draftId: string;
  frameId: string;
  runId: string;
  sessionId: string;
  taskId: string;
  sequence: number;
  contentHash: string;
  expectedSlotIds: string[];
}

export type KernelArtifactEditMatch =
  | {
      kind: 'exactBlock';
      targetLines: string[];
    }
  | {
      kind: 'contextBlock';
      beforeLines: string[];
      targetLines: string[];
      afterLines: string[];
    }
  | {
      kind: 'lineRange';
      startLine: number;
      endLine: number;
      expectedFileHash?: string;
      expectedBeforeLines?: string[];
      expectedBeforeText?: string;
    };

export interface KernelArtifactDraftChunkFrame extends KernelArtifactDraftFrameBase {
  partKind: 'artifactChunk';
  slotId: string;
  contentLines: string[];
  finalChunk: boolean;
  editMatch?: KernelArtifactEditMatch;
}

export interface KernelArtifactDraftBatchDoneFrame extends KernelArtifactDraftFrameBase {
  partKind: 'batchDone';
  metadata: { summary: string };
}

export interface KernelArtifactDraftDiagnosticFrame extends KernelArtifactDraftFrameBase {
  partKind: 'diagnostic';
  metadata: { reason: string };
}

export type KernelArtifactDraftLedgerFrame =
  | KernelArtifactDraftChunkFrame
  | KernelArtifactDraftBatchDoneFrame
  | KernelArtifactDraftDiagnosticFrame;

export type KernelDraftLedgerFrame = KernelArtifactDraftLedgerFrame;

export interface KernelDraftLedgerSubmitCommand {
  kind: 'draftLedgerSubmit';
  requestId: string;
  runId: string;
  sessionId?: string;
  frame: KernelDraftLedgerFrame;
}

export interface KernelErrorEnvelope {
  code: string;
  message: string;
  messageKey?: string;
  args?: unknown;
}

export interface KernelReply {
  ok: boolean;
  events: KernelEventV1[];
  snapshot?: unknown;
  error?: KernelErrorEnvelope;
}

export type KernelResourcePacketStatus =
  | 'provided'
  | 'resolved'
  | 'notFound'
  | 'skipped'
  | 'needsUserApproval'
  | 'denied'
  | 'error';

export type KernelResourcePacketResolvedKind = 'file' | 'directory' | 'other' | 'search';

export type KernelResourcePacketContentKind =
  | 'directoryTree'
  | 'fileText'
  | 'fileSkipped'
  | 'searchResults'
  | 'metadata'
  | 'summary'
  | 'text'
  | 'json';

export interface KernelResourcePacketItem {
  requestItemId: string;
  manifestEntryId: string;
  status: KernelResourcePacketStatus;
  readPolicy: string;
  sourceKind: string;
  resolvedKind?: KernelResourcePacketResolvedKind;
  path?: string;
  absolutePath?: string;
  contentKind?: KernelResourcePacketContentKind;
  rootId?: string;
  content?: string;
  promptContent?: string;
  contentHash?: string;
  metadataHash?: string;
  sizeBytes?: number;
  originalBytes?: number;
  offsetBytes?: number;
  limitBytes?: number;
  returnedBytes?: number;
  returnedCount?: number;
  returnedMatches?: number;
  directoryDepth?: number;
  contextLines?: number;
  maxResults?: number;
  visitedFiles?: number;
  skippedFiles?: number;
  skippedBinaryFiles?: number;
  skippedExecutableFiles?: number;
  truncated?: boolean;
  rangeComplete?: boolean;
  query?: string;
  strategy?: string;
  include?: string[];
  exclude?: string[];
  nodes?: unknown[];
  matches?: unknown[];
  fileClassification?: unknown;
  contentSummary?: string;
  evidenceRef?: string;
  evidenceRefs?: string[];
  reason?: string;
  message?: string;
  skipReason?: string;
  skipMessage?: string;
}

export interface KernelResourcePacket {
  id: string;
  requestId: string;
  workspaceScopeKey: string;
  manifestId: string;
  items: KernelResourcePacketItem[];
  evidenceRefs: string[];
  summary: string;
}

export type KernelWorkUnitStatus = 'queued' | 'started' | 'completed' | 'failed' | 'blocked';

export interface KernelCompiledToolSummary {
  toolId: string;
  operationKind: KernelToolOperationKind;
  path?: string;
  targetKind?: KernelToolTargetKind;
  recursive?: boolean;
  query?: string;
  argsPreview: unknown;
}

export interface KernelWorkUnitDescriptor {
  id: string;
  planId: string;
  actionId: string;
  title: string;
  toolId: string;
  operationKind: KernelToolOperationKind;
  capability: string;
  targetRef?: KernelFileTargetRef;
  readSet: string[];
  writeSet: string[];
  conflictKeys: string[];
  executionMode: KernelToolExecutionMode;
  status: KernelWorkUnitStatus;
  compiledTool?: KernelCompiledToolSummary;
}

export interface KernelWorkUnitFact {
  status: KernelWorkUnitStatus;
  sequence?: number;
  workUnitId: string;
  descriptor?: KernelWorkUnitDescriptor;
  summary?: string;
  output?: unknown;
  error?: KernelErrorEnvelope;
  reason?: string;
}

export interface KernelToolFactEnvelope {
  sequence?: number;
  toolCallId: string;
  toolId: string;
  operationKind: KernelToolOperationKind;
  factKind: KernelToolFactKind;
  untrustedEvidence: boolean;
  ok: boolean;
  output?: unknown;
  error?: KernelErrorEnvelope;
  source: 'operationalTool' | 'hostProjection' | 'contextRead';
}

export interface KernelPermissionRequestEnvelope {
  id: string;
  requestKind: 'runtimePermission' | 'scopeExpansion';
  permissionBundleId?: string;
  contractId?: string;
  affectedOperationIds: string[];
  workUnitIds: string[];
  toolId?: string;
  capability: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  argsPreview: unknown;
}

export type KernelFileChangeKind = 'create' | 'write' | 'edit' | 'delete' | 'rename';
export type KernelArtifactOrigin = 'agentGenerated' | 'userProvided' | 'externalEvidence';

export interface KernelPathNormalizationFact {
  originalPath: string;
  normalizedTargetPath: string;
  rootSource?: string;
  strippedPathPrefixes: string[];
  duplicateRootPathDetected: boolean;
}

export interface KernelFileChangeFact {
  toolCallId: string;
  toolId: string;
  operationKind: KernelToolOperationKind;
  changeKind: KernelFileChangeKind;
  path?: string;
  absolutePath?: string;
  from?: string;
  to?: string;
  contentHash?: string;
  oldContentHash?: string;
  newContentHash?: string;
  changedRanges: KernelFileChangedRange[];
  artifactOrigin?: KernelArtifactOrigin;
  pathNormalization?: KernelPathNormalizationFact;
}

export interface KernelGeneratedArtifactFact {
  toolCallId: string;
  toolId: string;
  operationKind: KernelToolOperationKind;
  path?: string;
  absolutePath?: string;
  planId?: string;
  workUnitId?: string;
  contentHash?: string;
  origin: KernelArtifactOrigin;
}

export type KernelResourceKind =
  | 'permissionGrant'
  | 'workspaceReadLease'
  | 'externalResourceLease'
  | 'terminalSession'
  | 'tempArtifact'
  | 'artifact'
  | 'redirectOutput'
  | 'cacheFile'
  | 'processHandle'
  | 'gitHandle'
  | 'browserHandle'
  | 'networkHandle';

export type KernelResourceState =
  | 'active'
  | 'cleanupPending'
  | 'cleanupFailed'
  | 'released';

export type KernelCleanupState = 'idle' | 'pending' | 'failed' | 'completed';
export type KernelCleanupScope = 'batch' | 'plan' | 'run';

export interface KernelCleanupCheckpoint {
  runId: string;
  scope: KernelCleanupScope;
  trigger: string;
  resourceIds: string[];
  intendedLifecycle: KernelRuntimeLifecycleState;
  intendedRunStatus?: 'running' | 'completed' | 'failed' | 'cancelled';
  reviewDecision?: {
    decision: 'accept' | 'revise' | 'reject';
    guidance?: string;
  };
  attempt: number;
}

export interface KernelTemporaryGrantEnvelope {
  id: string;
  contractId: string;
  operationIds: string[];
  capability: string;
  resourceKind: KernelPermissionResourceKind;
  resourcePath?: string;
  expiresAfterSequence?: number;
  reason?: string;
}

export type KernelResourceMetadata =
  | { kind: 'planAuthorizationGrant'; lease: KernelPlanGrantLease }
  | {
      kind: 'temporaryPermissionGrant';
      grantKind: 'planExecution' | 'runtimePermission';
      grant: KernelTemporaryGrantEnvelope;
    }
  | {
      kind: 'workspaceReadLease';
      workspaceId?: string;
      workspaceHash?: string;
      openPath: string;
    }
  | { kind: 'externalResourceLease'; lease: { resourceId: string; rootId: string; canonicalPath: string; targetKind: 'file' | 'directory' } }
  | { kind: 'tempArtifact'; path: string; absolutePath?: string; sourceTool: string; toolCallId: string }
  | { kind: 'terminalSession'; terminalId: string; cwd: string; shellKind: string };

export interface KernelResource {
  resourceId: string;
  logicalKey: string;
  idempotencyKey: string;
  kind: KernelResourceKind;
  owner: {
    kind: 'userSession' | 'agentRun' | 'kernelInternal';
    sessionId?: string;
    runId?: string;
  };
  sessionId?: string;
  runId?: string;
  scope: 'run' | 'session' | 'persistent';
  state: KernelResourceState;
  cleanupPolicy: 'onBatchReviewReady' | 'onRunEnd' | 'onSessionEnd' | 'onRuntimeDrop' | 'manual';
  createdAt?: string;
  releasedAt?: string;
  metadata: KernelResourceMetadata;
}

export interface KernelResourceCleanupStateFact {
  runId: string;
  scope: KernelCleanupScope;
  state: KernelCleanupState;
  resourceId?: string;
  resourceState?: KernelResourceState;
  attempt: number;
  error?: string;
}

export interface KernelResourceLifecycleFact {
  kind: 'acquiredBatch' | 'released' | 'cleanupFailed';
  sequence?: number;
  resources: KernelResource[];
  reason?: string;
  released?: boolean;
  error?: string;
}

export interface KernelCleanupFailureFact {
  sequence?: number;
  resourceId: string;
  resourceKind?: KernelResourceKind;
  reason?: string;
  error: string;
}

export interface KernelPathNormalizationDiagnostic {
  toolCallId: string;
  toolId: string;
  path?: string;
  absolutePath?: string;
  normalization: KernelPathNormalizationFact;
}

export interface KernelToolExecutionAttemptFact {
  attemptId: string;
  toolCallId: string;
  toolId: string;
  operationKind: KernelToolOperationKind;
  argsHash: string;
  contractId: string;
  workUnitId: string;
}

export type KernelToolEffectOutcome = 'none' | 'observed' | 'indeterminate';

export interface KernelToolEffectReceipt {
  attemptId: string;
  outcome: KernelToolEffectOutcome;
  affectedResources: string[];
  validation?: unknown;
  cleanupRefs: string[];
}

export interface KernelToolOutcomeIndeterminateFact {
  attempt: KernelToolExecutionAttemptFact;
  receipt: KernelToolEffectReceipt;
  reason: string;
}

export interface KernelReviewFacts {
  factsRef: string;
  runId: string;
  eventCount: number;
  workUnits: KernelWorkUnitFact[];
  queuedWorkUnits: KernelWorkUnitFact[];
  startedWorkUnits: KernelWorkUnitFact[];
  completedWorkUnits: KernelWorkUnitFact[];
  failedWorkUnits: KernelWorkUnitFact[];
  blockedWorkUnits: KernelWorkUnitFact[];
  awaitingPermissions: KernelPermissionRequestEnvelope[];
  toolResults: KernelToolFactEnvelope[];
  gitFacts: KernelToolFactEnvelope[];
  writtenFiles: KernelFileChangeFact[];
  createdFiles: KernelFileChangeFact[];
  deletedFiles: KernelFileChangeFact[];
  renamedFiles: KernelFileChangeFact[];
  patchChangedRanges: KernelFileChangeFact[];
  generatedArtifacts: KernelGeneratedArtifactFact[];
  resourceEvents: KernelResourceLifecycleFact[];
  cleanupFailures: KernelCleanupFailureFact[];
  indeterminateToolOutcomes: KernelToolOutcomeIndeterminateFact[];
  pathNormalizationDiagnostics: KernelPathNormalizationDiagnostic[];
  batchReviewReady: boolean;
}

export interface KernelAuditQueryFilter {
  runId?: string;
  sessionId?: string;
  contractId?: string;
  toolId?: string;
  afterSequence?: number;
  beforeSequence?: number;
  limit: number;
}

export interface KernelAuditEventFact {
  id: string;
  runId?: string;
  sessionId?: string;
  kind: string;
  sequence?: number;
  payload: unknown;
  createdAt?: string;
}

export interface KernelAuditQueryResult {
  filter: KernelAuditQueryFilter;
  events: KernelAuditEventFact[];
  truncated: boolean;
  returned: number;
}

export interface KernelCompletionCriteria {
  id: string;
  description: string;
  evidenceRequired: string[];
  validationKind?: string;
}

export type KernelProposalReviewStatus =
  | 'autoAccepted'
  | 'authorizedByPlan'
  | 'awaitingUserApproval'
  | 'denied';

export interface KernelPermissionBundle {
  id: string;
  capability: string;
  permissionMode: 'allow' | 'ask' | 'deny';
  risk: 'low' | 'medium' | 'high' | 'critical';
  resourceKind: KernelPermissionResourceKind;
  operationIds: string[];
  toolIds: string[];
  targets: string[];
  expiresAfter: KernelContractExpiry;
}

export interface KernelGateInterventionRequired {
  id: string;
  interventionKind: KernelGateInterventionKind;
  status: KernelGateInterventionStatus;
  permissionBundleId?: string;
  summary: string;
  affectedOperationIds: string[];
}

export interface KernelExecutionOperation {
  id: string;
  title: string;
  dependsOn: string[];
  toolId: string;
  operationKind: KernelToolOperationKind;
  args: Record<string, unknown>;
  argsHash: string;
  readSet: string[];
  writeSet: string[];
  conflictKeys: string[];
  executionMode: KernelToolExecutionMode;
  cleanup: KernelCleanupContract;
}

export interface KernelCleanupContract {
  leasePolicy: 'none' | 'sandboxLease' | 'providerStream' | 'batchTemporaryFile';
  terminateProcessTree: boolean;
  removeScratch: boolean;
  revokeBrokerGrant: boolean;
  deadlineMs: number;
  failurePolicy: 'recordFailure' | 'blockReviewAcceptance';
}

export interface KernelExecutionContract {
  id: string;
  proposalId: string;
  status: KernelProposalReviewStatus;
  authorizationContractId?: string;
  catalogVersion: string;
  catalogHash: string;
  operationSetHash: string;
  contractHash: string;
  operations: KernelExecutionOperation[];
  permissionBundles: KernelPermissionBundle[];
  interventions: KernelGateInterventionRequired[];
  cleanupPolicy: KernelContractCleanupPolicy;
  expiresAfter: KernelContractExpiry;
}

export interface KernelTaskIntentTask {
  taskId: string;
  toolId: string;
  targets: string[];
  dependsOn: string[];
  args: Record<string, unknown>;
}

export interface KernelTaskIntentEnvelope {
  schemaVersion: 'deepcode.kernel.task-intent.v2';
  planId: string;
  planHash: string;
  runId: string;
  sessionId?: string;
  workspaceBindingHash?: string;
  catalogVersion: string;
  catalogHash: string;
  tasks: KernelTaskIntentTask[];
}

export type KernelPlanAuthorizationStatus =
  | 'confirmable'
  | 'needsRevision'
  | 'denied'
  | 'accepted'
  | 'rejected'
  | 'expired';

export interface KernelPlanAuthorizationOperation {
  id: string;
  sourceTaskId: string;
  toolId: string;
  operationKind: KernelToolOperationKind;
  contentMode: KernelToolContentMode;
  targets: string[];
  dependsOn: string[];
  fixedArgs: Record<string, unknown>;
  argsTemplate: Record<string, unknown>;
  targetKind?: KernelToolTargetKind;
  recursive?: boolean;
  readSet: string[];
  writeSet: string[];
  conflictKeys: string[];
  executionMode: KernelToolExecutionMode;
  internal: boolean;
  parentOperationId?: string;
}

export interface KernelPlanPermissionBundle {
  id: string;
  capability: string;
  permissionMode: 'allow' | 'ask' | 'deny';
  risk: 'low' | 'medium' | 'high' | 'critical';
  resourceKind: KernelPermissionResourceKind;
  operationIds: string[];
  toolIds: string[];
  targets: string[];
  expiresAfter: KernelContractExpiry;
}

export interface KernelPlanGateIntervention {
  id: string;
  interventionKind: KernelGateInterventionKind;
  status: KernelGateInterventionStatus;
  permissionBundleId?: string;
  affectedOperationIds: string[];
  summary: string;
}

export interface KernelPlanAuthorizationContract {
  id: string;
  planId: string;
  planHash: string;
  status: KernelPlanAuthorizationStatus;
  workspaceBindingHash?: string;
  catalogVersion: string;
  catalogHash: string;
  operationSetHash: string;
  contractHash: string;
  operations: KernelPlanAuthorizationOperation[];
  permissionBundles: KernelPlanPermissionBundle[];
  interventions: KernelPlanGateIntervention[];
  cleanupPolicy: KernelContractCleanupPolicy;
  expiresAfter: KernelContractExpiry;
}

export interface KernelPlanAuthorizationReview {
  planId: string;
  status: KernelPlanAuthorizationStatus;
  diagnostics: string[];
  authorizationContract: KernelPlanAuthorizationContract;
}

export interface KernelPlanAuthorizationDecision {
  decisionId: string;
  authorizationContractId: string;
  planId: string;
  planHash: string;
  contractHash: string;
  decision: 'accept' | 'reject';
}

export interface KernelPlanGrantLease {
  id: string;
  authorizationContractId: string;
  runId: string;
  sessionId: string;
  planId: string;
  planHash: string;
  contractHash: string;
  workspaceBindingHash?: string;
  catalogVersion: string;
  permissionBundleIds: string[];
  operationIds: string[];
  active: boolean;
}

export interface KernelProposalReviewReport {
  proposalId: string;
  status: KernelProposalReviewStatus;
  requiredPermissions: string[];
  diagnostics: string[];
  executionContract: KernelExecutionContract;
}

export type KernelSkillTrustMode = 'declarative' | 'brokeredScript' | 'directHostScript';

export interface KernelSkillTrustRecord {
  skillId: string;
  scriptHash?: string;
  approvedCapabilities: string[];
  approvedAt?: string;
  approvedBy?: string;
  trustMode: KernelSkillTrustMode;
  ledgerEventRef?: string;
  expiresAt?: string;
}

export type KernelRuntimeLifecycleState =
  | 'created'
  | 'ready'
  | 'executing'
  | 'awaitingPermission'
  | 'reviewReady'
  | 'terminating'
  | 'terminal';

export type KernelReviewGateStatus =
  | 'accepted'
  | 'needsReplan'
  | 'aborted'
  | 'cleanupFailed';

export interface KernelReviewGateEvaluation {
  id: string;
  runId: string;
  status: KernelReviewGateStatus;
  decision: {
    decision: 'accept' | 'revise' | 'reject';
    guidance?: string;
  };
  failedWorkUnitCount: number;
  blockedWorkUnitCount: number;
  cleanupFailureCount: number;
  revokedTemporaryGrantCount: number;
  releasedResourceCount: number;
  removedTempFileCount: number;
  cleanupFailures: string[];
  summary: string;
  factsRef: string;
}

export type KernelRuntimeLifecycleEvent =
  | {
      kind: 'runtime.lifecycle_changed';
      requestId?: string;
      runId: string;
      sessionId?: string;
      previousState?: KernelRuntimeLifecycleState;
      currentState: KernelRuntimeLifecycleState;
      reason?: string;
      sequence?: number;
    }
  | {
      kind: 'runtime.resumed';
      runId: string;
      sessionId?: string;
      checkpointId: string;
      lifecycleState: KernelRuntimeLifecycleState;
      sequence?: number;
    };

export type KernelProposalReviewEvent = {
  kind: 'proposal.reviewed';
  requestId?: string;
  runId?: string;
  sessionId?: string;
  proposalId?: string;
  report: unknown;
  sequence?: number;
};

export type KernelPlanAuthorizationEvent =
  | {
      kind: 'plan_authorization.reviewed';
      requestId?: string;
      runId: string;
      sessionId?: string;
      planId: string;
      review: KernelPlanAuthorizationReview;
      sequence?: number;
    }
  | {
      kind: 'plan_authorization.decision_recorded';
      requestId?: string;
      runId: string;
      sessionId?: string;
      authorizationContractId: string;
      decision: 'accept' | 'reject';
      leaseId?: string;
      sequence?: number;
    };
