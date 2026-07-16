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

export interface KernelHostInspectionResult {
  source: 'hostProjection';
  queryKind: KernelHostInspectionQuery['kind'];
  output: unknown;
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

export type KernelResourceScopeKind =
  | 'workspaceFile'
  | 'workspaceConfigAsset'
  | 'managedReference'
  | 'externalReadOnlyFile'
  | 'externalFile'
  | 'tempArtifact'
  | 'process'
  | 'git'
  | 'network'
  | 'secret'
  | 'kernel';

export interface KernelResourceScope {
  kind: KernelResourceScopeKind;
  path?: string;
  managedByKernel: boolean;
}

export interface KernelRiskBudget {
  maxToolCalls: number;
  maxFileWrites: number;
  maxProcessExec: number;
  allowDestructive: boolean;
}

export interface KernelTemporaryGrant {
  id: string;
  contractId: string;
  operationIds: string[];
  capability: string;
  resourceScope: KernelResourceScope;
  decision: 'allow' | 'ask' | 'deny';
  expiresAfterSequence?: number;
  reason?: string;
}

export type KernelEffectSurface =
  | 'workspace'
  | 'deepcodeConfig'
  | 'externalReadOnly'
  | 'systemPath'
  | 'process'
  | 'network'
  | 'secret'
  | 'kernel';

export type KernelBatchSize =
  | 'single'
  | { bounded: number }
  | 'unbounded';

export type KernelPersistence = 'ephemeral' | 'run' | 'session' | 'persistent';

export type KernelOutsideWorkspace =
  | 'forbidden'
  | 'readOnlyReference'
  | 'managedCopy'
  | 'writableOverride';

export type KernelHardFloor =
  | 'recursiveSystemDelete'
  | 'outsideWorkspaceWrite'
  | 'secretExposure'
  | 'kernelModifyWithoutMaintainer';

export interface KernelPermissionImpact {
  effectSurface: KernelEffectSurface;
  batchSize: KernelBatchSize;
  persistence: KernelPersistence;
  outsideWorkspace: KernelOutsideWorkspace;
  hardFloor?: KernelHardFloor;
}

export type KernelShellRuntimePreference =
  | 'linuxDefault'
  | 'wsl'
  | 'powerShell'
  | 'cmd'
  | 'bash'
  | 'zsh';

export interface KernelHostShellOverride {
  shell: KernelShellRuntimePreference;
  reason?: string;
  acknowledgedRisk: boolean;
}

export interface KernelExecutionEnvironmentPolicy {
  preferDocker: boolean;
  defaultShell: KernelShellRuntimePreference;
  allowHostShellOverride: boolean;
  hostShellOverride?: KernelHostShellOverride;
}

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
  command: unknown;
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
  events: unknown[];
  snapshot?: unknown;
  error?: KernelErrorEnvelope;
}

export interface KernelWorkUnitFact {
  kind: string;
  sequence?: number;
  workUnitId?: string;
  workUnit?: unknown;
  summary?: string;
  error?: unknown;
  reason?: unknown;
}

export interface KernelToolFactEnvelope {
  kind: string;
  sequence?: number;
  toolCallId?: string;
  toolId: string;
  factKind: string;
  untrustedEvidence: boolean;
  ok: boolean;
  output?: unknown;
  error?: unknown;
  source: 'operationalTool' | string;
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
  awaitingPermissions: unknown[];
  toolResults: KernelToolFactEnvelope[];
  gitFacts: KernelToolFactEnvelope[];
  writtenFiles: unknown[];
  createdFiles: unknown[];
  deletedFiles: unknown[];
  renamedFiles: unknown[];
  patchChangedRanges: unknown[];
  generatedArtifacts: unknown[];
  resourceEvents: unknown[];
  cleanupFailures: unknown[];
  pathNormalizationDiagnostics: unknown[];
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
  resourceKind: string;
  operationIds: string[];
  toolIds: string[];
  targets: string[];
  expiresAfter: string;
}

export interface KernelGateInterventionRequired {
  id: string;
  interventionKind: string;
  status: string;
  permissionBundleId?: string;
  summary: string;
  affectedOperationIds: string[];
}

export interface KernelExecutionOperation {
  id: string;
  title: string;
  toolId: string;
  args: Record<string, unknown>;
  argsHash: string;
  readSet: string[];
  writeSet: string[];
  conflictKeys: string[];
  executionMode: 'execute' | 'previewOnly' | 'blocked';
  cleanup: Record<string, unknown>;
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
  cleanupPolicy: string;
  expiresAfter: string;
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
  operationKind: string;
  contentMode: string;
  targets: string[];
  dependsOn: string[];
  fixedArgs: Record<string, unknown>;
  argsTemplate: Record<string, unknown>;
  targetKind?: string;
  recursive?: boolean;
  readSet: string[];
  writeSet: string[];
  conflictKeys: string[];
  executionMode: string;
  internal: boolean;
  parentOperationId?: string;
}

export interface KernelPlanPermissionBundle {
  id: string;
  capability: string;
  permissionMode: string;
  risk: string;
  resourceKind: string;
  operationIds: string[];
  toolIds: string[];
  targets: string[];
  expiresAfter: string;
}

export interface KernelPlanGateIntervention {
  id: string;
  interventionKind: string;
  status: string;
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
  cleanupPolicy: string;
  expiresAfter: string;
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

export type KernelPlanReviewStatus =
  | KernelProposalReviewStatus
  | 'awaitingTemporaryGrant'
  | 'needsRevision'
  | 'interfaceOnly';

export interface KernelFileTargetRef {
  kind: 'workspaceRelative' | 'rootRelative' | 'absolutePath' | string;
  path: string;
  rootId?: string;
}

export interface KernelRequiredFileOperation {
  operation: 'write' | 'create' | 'delete' | 'rename' | string;
  targetPath: string;
  toolId?: string;
  capability: string;
  actionId?: string;
  targetRef?: KernelFileTargetRef;
  targetKind?: 'workspaceRelative' | 'rootRelative' | 'absolutePath' | string;
  outsideWorkspace?: boolean;
}

/**
 * Compatibility projection for Session data that carries the earlier
 * plan-review fields. Protocol v4 runtime events use
 * KernelProposalReviewReport instead.
 */
export interface KernelPlanReviewReport {
  [key: string]: unknown;
  planId: string;
  status: KernelPlanReviewStatus;
  requiredCapabilities: string[];
  requiredPermissions: string[];
  permissionGaps?: string[];
  requiredFileOperations?: KernelRequiredFileOperation[];
  permissionBundles?: KernelPermissionBundle[];
  interventions?: KernelGateInterventionRequired[];
  executionContract?: KernelExecutionContract | Record<string, unknown>;
  hardFloorHits: string[];
  deniedReasons?: string[];
  blockedReasons: string[];
  findings: unknown[];
  kernelGeneratedPermissionSummary?: string;
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

export type KernelProposalCommand =
  | {
      kind: 'planAuthorizationSubmit';
      requestId: string;
      runId: string;
      sessionId?: string;
      intent: KernelTaskIntentEnvelope;
    }
  | {
      kind: 'planAuthorizationDecisionSubmit';
      requestId: string;
      runId: string;
      sessionId?: string;
      decision: KernelPlanAuthorizationDecision;
    }
  | {
      kind: 'skillTrustApprove';
      requestId: string;
      skillId: string;
      decision: unknown;
    }
  | {
      kind: 'mcpRiskAcknowledgmentSubmit';
      requestId: string;
      connectorId: string;
      bindingId?: string;
      acknowledgment: unknown;
    };

export type KernelRuntimeLifecycleState =
  | 'created'
  | 'ready'
  | 'executing'
  | 'awaitingPermission'
  | 'reviewReady'
  | 'terminal';

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

export type KernelSkillTrustEvent =
  | {
      kind: 'skill.trust_requested';
      requestId?: string;
      skillId: string;
      hash?: string;
      request: unknown;
      sequence?: number;
    }
  | {
      kind: 'skill.trust_granted';
      requestId?: string;
      skillId: string;
      trustRecord: unknown;
      sequence?: number;
    };

export type KernelMcpRiskAcknowledgmentEvent = {
  kind: 'mcp.risk_acknowledgment_required';
  requestId?: string;
  connectorId: string;
  bindingId?: string;
  riskReport: unknown;
  sequence?: number;
};

export type KernelTempArtifactEvent =
  | {
      kind: 'tempArtifact.created' | 'tempArtifact.cleaned';
      runId: string;
      sessionId?: string;
      path: string;
      sequence?: number;
    }
  | {
      kind: 'tempArtifact.lease_granted';
      runId: string;
      sessionId?: string;
      leaseId: string;
      artifactId: string;
      scope: 'run' | 'session' | 'persistent';
      required: boolean;
      sequence?: number;
    }
  | {
      kind: 'tempArtifact.lease_released';
      runId: string;
      sessionId?: string;
      leaseId: string;
      artifactId: string;
      cleanupOk: boolean;
      sequence?: number;
    }
  | {
      kind: 'tempArtifact.lease_promoted';
      runId: string;
      sessionId?: string;
      leaseId: string;
      artifactId: string;
      fromScope: 'run' | 'session' | 'persistent';
      toScope: 'run' | 'session' | 'persistent';
      sequence?: number;
    }
  | {
      kind: 'tempCleanup.failed';
      runId: string;
      sessionId?: string;
      path: string;
      error: { code: string; message: string };
      sequence?: number;
    };
