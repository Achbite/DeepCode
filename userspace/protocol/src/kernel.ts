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
  | 'prompt'
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

export type KernelPromptSourceKind =
  | 'kernelSafety'
  | 'bundledProfile'
  | 'userProfile'
  | 'workspaceRule'
  | 'codeStyle'
  | 'skillPack'
  | 'runGuidance'
  | 'externalConnector';

export type KernelPromptRole = 'system' | 'user' | 'assistant' | 'tool';

export interface KernelPromptFragment {
  id: string;
  kind: KernelPromptSourceKind;
  role: KernelPromptRole;
  content: string;
  path?: string;
  contentHash?: string;
  priority: number;
  trustLevel?: string;
}

export interface KernelPromptSourceRef {
  id: string;
  kind: KernelPromptSourceKind;
  path?: string;
  contentHash?: string;
  trustLevel?: string;
}

export interface KernelPromptMessage {
  role: KernelPromptRole;
  content: string;
}

export interface KernelPromptEnvelope {
  id: string;
  runId?: string;
  phase?: string;
  profileId?: string;
  templateLocale?: string;
  responseLanguage?: string;
  messages: KernelPromptMessage[];
  sourceRefs: KernelPromptSourceRef[];
  rulesApplied: KernelPromptSourceRef[];
  context: unknown;
  hash?: string;
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

export interface KernelLlmCallRequestedEvent {
  kind: 'llm.call_requested';
  runId: KernelRunId;
  sessionId?: KernelSessionId;
  phase: string;
  llmCallId: string;
  profileRef?: KernelProfileRef;
  requestEnvelope: unknown;
  sequence?: number;
}

export interface KernelLlmResponseSubmitCommand {
  kind: 'llmResponseSubmit';
  requestId: KernelRequestId;
  runId: KernelRunId;
  sessionId?: KernelSessionId;
  llmCallId: string;
  responseEnvelope: unknown;
}

export type KernelWorkflowTransportEvent = KernelLlmCallRequestedEvent;
export type KernelWorkflowTransportCommand = KernelLlmResponseSubmitCommand;

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

export type KernelPlanCommand =
  | {
      kind: 'planAccept';
      requestId: string;
      runId: string;
      planId: string;
    }
  | {
      kind: 'planReject';
      requestId: string;
      runId: string;
      planId: string;
      reason?: string;
    }
  | {
      kind: 'planRevise';
      requestId: string;
      runId: string;
      planId: string;
      guidance: string;
    }
  | {
      kind: 'permissionGrantTemporary';
      requestId: string;
      runId: string;
      grant: KernelTemporaryGrant;
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

export type KernelTempArtifactEvent =
  | {
      kind: 'tempArtifact.created' | 'tempArtifact.cleaned';
      runId: string;
      sessionId?: string;
      path: string;
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
