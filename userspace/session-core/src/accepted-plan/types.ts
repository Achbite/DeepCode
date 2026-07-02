import type { AgentContextAttachment } from '@deepcode/protocol';

export type ExecutionSliceRole = 'sourceCode' | 'infra' | 'script' | 'test' | 'docs' | 'config' | 'review';
export type AcceptedPlanInterventionLevel = 'low' | 'medium' | 'high';

export interface TaskExecutionCursor {
  cursorId: string;
  planId?: string;
  currentTaskId?: string;
  taskOrder: string[];
  pendingTaskIds: string[];
  completedTaskIds: string[];
  lastResourcePacketIds: string[];
  lastSavepointId?: string;
}

export interface CurrentTaskContext {
  goal: string;
  taskId?: string;
  nodeId?: string;
  taskTitle?: string;
  targets: string[];
  capabilities: string[];
  taskOrder: string[];
  pendingTaskIds: string[];
  dependsOn: string[];
  evidenceNeeds: string[];
  completedTaskIds: string[];
}

export interface AcceptedImplementationPlanTaskContext {
  taskId: string;
  title?: string;
  capability?: string;
  targets: string[];
  dependencies: string[];
  conflictKeys: string[];
  batchKind?: ExecutionSliceRole;
  role?: ExecutionSliceRole;
}

export interface AcceptedImplementationPlanExecutionRoot {
  attachment: AgentContextAttachment;
  ref: string;
  source: 'projectWorkingDirectory' | 'workspaceBinding' | 'recentAttachment';
}

export interface AcceptedPlanAccessScope {
  scopeKind: string;
  path: string;
  capabilities: string[];
  operations: string[];
  reason?: string;
  dependencyDepth?: number;
  sourceTaskId?: string;
  outsideWorkspace?: boolean;
  source: 'kernelPlanReview' | 'implementationPlan';
}

export interface AcceptedPlanExactOperationGrant {
  operation: string;
  targetPath: string;
  targetRefPath?: string;
  targetResourceKind?: 'file' | 'directory';
  recursive?: boolean;
  capability: string;
  actionId?: string;
  sourceTaskId?: string;
  outsideWorkspace?: boolean;
  source: 'kernelPlanReview' | 'implementationPlan';
}

export interface AcceptedImplementationPlanContext {
  planId: string;
  runId: string;
  title?: string;
  summary?: string;
  tasks: AcceptedImplementationPlanTaskContext[];
  capabilities: string[];
  targetScopes: string[];
  exactOperationGrants: AcceptedPlanExactOperationGrant[];
  accessScopes: AcceptedPlanAccessScope[];
  executionRoot?: AcceptedImplementationPlanExecutionRoot;
  interventionLevel?: AcceptedPlanInterventionLevel;
  batchIndex: number;
  completedTaskIds: string[];
  rawPlan: Record<string, unknown>;
}

export interface AcceptedPlanTargetScope {
  raw: string;
  normalized: string;
}

export interface AcceptedPlanBatchProgress {
  actionIds: string[];
  targetPaths: string[];
  workUnitIds: string[];
  newlyCompletedTaskIds: string[];
  completedTaskIds: string[];
  remainingTaskIds: string[];
}

export interface AcceptedPlanBatchValidationResult {
  ok: boolean;
  reasons: string[];
  issues?: AcceptedPlanBatchValidationIssue[];
}

export interface AcceptedPlanBatchValidationIssue {
  code:
    | 'missingActionBundle'
    | 'invalidTargetPath'
    | 'capabilityRequiresDecision'
    | 'capabilityOutOfScope'
    | 'missingTarget'
    | 'targetOutOfScope'
    | 'freshEvidenceMissing';
  message: string;
  targetPath?: string;
  capability?: string;
  actionId?: string;
  targetResourceKind?: 'file' | 'directory';
  recursive?: boolean;
}
