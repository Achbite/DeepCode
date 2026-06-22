export type ActionKind =
  | 'read'
  | 'list'
  | 'search'
  | 'diff'
  | 'create'
  | 'write'
  | 'patch'
  | 'replaceBlock'
  | 'insertBefore'
  | 'insertAfter'
  | 'delete'
  | 'rename'
  | 'command'
  | 'validation'
  | 'review'
  | 'repair'
  | 'status'
  | 'stage'
  | 'unstage'
  | 'commit'
  | 'push';

export interface CodeBlockDraft {
  id: string;
  path: string;
  content: string;
  language?: string;
  operation?:
    | 'create'
    | 'createEmpty'
    | 'overwrite'
    | 'patch'
    | 'replaceBlock'
    | 'insertBefore'
    | 'insertAfter'
    | 'delete'
    | 'rename';
  allowEmptyContent?: boolean;
  permissionLabels?: string[];
}

export interface PlannedActionDraft {
  id: string;
  title: string;
  capability: string;
  kind?: ActionKind;
  targetRef?: {
    kind: 'workspaceRelative' | 'rootRelative' | 'absolutePath' | string;
    path: string;
    rootId?: string;
  };
  resourceScope: string[];
  canParallelize: boolean;
  conflictKeys: string[];
  purpose?: string;
  sourceBlockId?: string;
  replacementBlockId?: string;
  targetPath?: string;
  targetKind?: 'file' | 'directory' | string;
  recursive?: boolean;
  patchSpec?: Record<string, unknown>;
  toolArgs?: Record<string, unknown>;
  permissionLabels?: string[];
  dependsOn?: string[];
  accessScopes?: AccessScopeDraft[];
}

export interface FileOperationDraft {
  operation: 'write' | 'create' | 'patch' | 'delete' | 'rename' | string;
  capability: string;
  targetRef?: {
    kind: 'workspaceRelative' | 'rootRelative' | 'absolutePath' | string;
    path: string;
    rootId?: string;
  };
  targetPath?: string;
  targetKind?: 'file' | 'directory' | string;
  recursive?: boolean;
  reason?: string;
}

export interface AccessScopeDraft {
  scopeKind: 'workspaceModule' | 'oneHopDependency' | string;
  path: string;
  capability?: string;
  capabilities?: string[];
  operations?: string[];
  reason?: string;
  dependencyDepth?: number;
  sourceTaskId?: string;
}

export interface CommandBlockDraft {
  commandId: string;
  capability: 'process.exec';
  cwd?: string;
  argv: string[];
  timeoutMs?: number;
  envPolicy?: 'inheritSafe' | 'explicitOnly' | 'empty';
  expectedOutput?: string;
  permissionLabels?: string[];
}

export interface ValidationExpectationDraft {
  id: string;
  description: string;
  command?: string;
}

export interface ReviewExpectationDraft {
  id: string;
  description: string;
}

export interface RepairPolicyDraft {
  maxRounds: number;
  allowedFiles: string[];
  forbidNewFilesAfterApproval: boolean;
  forbidNewPermissionsAfterApproval: boolean;
}

export interface ActionBundleDraft {
  version: '1';
  id: string;
  goal: string;
  requirementId?: string;
  actions: PlannedActionDraft[];
  commandBlocks?: CommandBlockDraft[];
  continuationExpectations?: PlannedActionDraft[];
  validationExpectations: ValidationExpectationDraft[];
  reviewExpectations: ReviewExpectationDraft[];
  repairPolicy?: RepairPolicyDraft;
  accessScopes?: AccessScopeDraft[];
}

export interface ExpectedValidation {
  content: string;
  expectations: ValidationExpectationDraft[];
}

export interface ReviewGuide {
  content: string;
  expectations: ReviewExpectationDraft[];
}

export interface ResourceRequestDraftItem {
  id: string;
  kind?: 'file' | 'directory' | 'resource' | 'search';
  manifestEntryId?: string;
  path?: string;
  rootId?: string;
  query?: string;
  include?: string[];
  contextLines?: number;
  maxResults?: number;
  offsetBytes?: number;
  limitBytes?: number;
  reason: string;
}

export interface ResourceRequestDraft {
  version: '1';
  id: string;
  reason: string;
  items: ResourceRequestDraftItem[];
}

export interface AnswerDraft {
  format: 'markdown';
  version: '1';
  content: string;
}

export interface DecisionRequestOptionDraft {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface DecisionRequestDraft {
  version: '1';
  id: string;
  reason: string;
  summary: string;
  options: DecisionRequestOptionDraft[];
  allowsFreeform: boolean;
}

export interface DiagnosticDraft {
  version: '1';
  id: string;
  severity: 'info' | 'warning' | 'error';
  summary: string;
  details?: string;
}

export interface ImplementationPlanTaskDraft {
  taskId: string;
  title: string;
  target: string[];
  scope: string;
  dependencies: string[];
  hardDependencies?: string[];
  softOrderAfter?: string[];
  conflictKeys?: string[];
  canDraftInParallel?: boolean;
  role?: 'sourceCode' | 'infra' | 'script' | 'test' | 'docs' | 'config' | 'review';
  capability: string;
  fileOperations?: FileOperationDraft[];
  accessScopes?: AccessScopeDraft[];
  acceptanceCriteria: string[];
  failureCriteria: string[];
}

export interface ImplementationPlanDraft {
  version: '1';
  id: string;
  title: string;
  summary: string;
  tasks: ImplementationPlanTaskDraft[];
  risks: string[];
  reviewCheckpoints: string[];
}

export interface AgentPlanParts {
  userPlan: string;
  actionBundle: ActionBundleDraft;
  codeBlocks: CodeBlockDraft[];
  expectedValidation: ExpectedValidation;
  reviewGuide: ReviewGuide;
}

export type AgentPlanOutput =
  | {
      kind: 'answer';
      answer: AnswerDraft;
    }
  | {
      kind: 'actionPlan';
      parts: AgentPlanParts;
    }
  | {
      kind: 'resourceRequest';
      userPlan?: string;
      resourceRequest: ResourceRequestDraft;
    };

export interface AgentPlanParseFailure {
  code: string;
  message: string;
}

export type ProposalEnvelopeSource = 'llm' | 'user' | 'system' | 'cache';

export type ProposalEnvelopeKind =
  | 'answer'
  | 'resourceRequest'
  | 'decisionRequest'
  | 'implementationPlan'
  | 'actionBundle'
  | 'diagnostic';

export interface ProposalEnvelope {
  schemaVersion: 'deepcode.agent.protocol.v3';
  proposalId: string;
  runId: string;
  sessionId?: string;
  source: ProposalEnvelopeSource;
  kind: ProposalEnvelopeKind;
  narration?: string;
  payload: unknown;
  referencedResourcePacketRefs: string[];
  referencedEvidenceRefs: string[];
  parserDiagnostics?: unknown;
}

export class AgentPlanParseError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentPlanParseError';
  }
}
