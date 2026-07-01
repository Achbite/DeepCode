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
  runId: string;
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

export interface KernelDraftLedgerFrame {
  schemaVersion: 'deepcode.agent.stream.part.v1';
  partKind: string;
  draftId?: string;
  frameId?: string;
  runId?: string;
  targetPath?: string;
  capability?: string;
  chunk?: string;
  contentHash?: string;
  sequence?: number;
  metadata?: Record<string, unknown>;
}

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

export interface KernelCompletionCriteria {
  id: string;
  description: string;
  evidenceRequired: string[];
  validationKind?: string;
}

export interface KernelPlanContract {
  id: string;
  goal: string;
  scope: string[];
  forbiddenActions: string[];
  requiredCapabilities: string[];
  completionCriteria: KernelCompletionCriteria[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresUserApproval: boolean;
}

export type KernelProposalContract = KernelPlanContract;

export type KernelPlanReviewStatus =
  | 'autoAccepted'
  | 'awaitingUserApproval'
  | 'awaitingTemporaryGrant'
  | 'denied'
  | 'needsRevision'
  | 'interfaceOnly';

export type KernelProposalReviewStatus = KernelPlanReviewStatus;

export interface KernelFileTargetRef {
  kind: 'workspaceRelative' | 'rootRelative' | 'absolutePath' | string;
  path: string;
  rootId?: string;
}

export interface KernelRequiredFileOperation {
  operation: 'write' | 'create' | 'delete' | 'rename' | string;
  targetPath: string;
  capability: string;
  actionId?: string;
  targetRef?: KernelFileTargetRef;
  targetKind?: 'workspaceRelative' | 'rootRelative' | 'absolutePath' | string;
  outsideWorkspace?: boolean;
}

export interface KernelPermissionBundle {
  id: string;
  capability: string;
  resourceKind: string;
  resourcePath?: string;
  targets?: string[];
  operationIds?: string[];
  riskLevel: string;
  summary: string;
  grantMode: string;
  expiresAfter: string;
}

export interface KernelGateInterventionRequired {
  id: string;
  interventionKind: string;
  status: string;
  capability?: string;
  permissionBundleId?: string;
  summary: string;
  options?: string[];
}

export interface KernelExecutionOperation {
  id: string;
  title: string;
  operation: string;
  capability: string;
  targetPath: string;
  targetRef?: KernelFileTargetRef;
  targetKind: 'workspaceRelative' | 'rootRelative' | 'absolutePath' | string;
  outsideWorkspace: boolean;
}

export interface KernelExecutionContract {
  id: string;
  planId: string;
  status: KernelPlanReviewStatus | string;
  source: string;
  userApprovalRequired: boolean;
  operations?: KernelExecutionOperation[];
  permissionBundles?: KernelPermissionBundle[];
  interventions?: KernelGateInterventionRequired[];
  diagnostics?: string[];
}

export interface KernelPlanReviewReport {
  planId: string;
  status: KernelPlanReviewStatus;
  requiredCapabilities: string[];
  requiredPermissions: string[];
  permissionGaps?: string[];
  requiredFileOperations?: KernelRequiredFileOperation[];
  permissionBundles?: KernelPermissionBundle[];
  interventions?: KernelGateInterventionRequired[];
  executionContract?: KernelExecutionContract;
  hardFloorHits: string[];
  deniedReasons?: string[];
  blockedReasons: string[];
  findings: unknown[];
  kernelGeneratedPermissionSummary?: string;
}

export type KernelProposalReviewReport = KernelPlanReviewReport;

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

export type KernelPlanCommand =
  | {
      kind: 'skillInvoke';
      requestId: string;
      runId?: string;
      sessionId?: string;
      skillId: string;
      input: unknown;
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
    }
  | {
      kind: 'permissionGrantTemporary';
      requestId: string;
      runId: string;
      grant: KernelTemporaryGrant;
    }
  | {
      kind: 'artifactRegister';
      requestId: string;
      runId: string;
      sessionId?: string;
      artifact: unknown;
    };

export type KernelWorkflowCheckpointEvent =
  | {
      kind: 'workflow.checkpointed';
      runId: string;
      sessionId?: string;
      checkpointId: string;
      phase: string;
      sequence?: number;
    }
  | {
      kind: 'workflow.resumed';
      runId: string;
      sessionId?: string;
      checkpointId: string;
      phase: string;
      sequence?: number;
    };

export type KernelPlanReviewEvent = {
  kind: 'proposal.reviewed';
  requestId?: string;
  runId?: string;
  sessionId?: string;
  proposalId?: string;
  report: unknown;
  sequence?: number;
};

export type KernelProposalReviewEvent = KernelPlanReviewEvent;

export type KernelArtifactRegisteredEvent = {
  kind: 'artifact.registered';
  requestId?: string;
  runId: string;
  sessionId?: string;
  artifact: unknown;
  evidenceRef: string;
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
