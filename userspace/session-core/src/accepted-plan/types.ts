import type { AgentContextAttachment } from '@deepcode/protocol';
import type { InterventionLevel } from '../sessionModes.js';

export type ExecutionSliceRole = 'sourceCode' | 'infra' | 'script' | 'test' | 'docs' | 'config' | 'review';
export type AcceptedPlanInterventionLevel = InterventionLevel;

export interface TaskExecutionCursor {
  cursorId: string;
  planId?: string;
  currentTaskId?: string;
  taskOrder: string[];
  pendingTaskIds: string[];
  completedTaskIds: string[];
  modelJudgedSufficientTaskIds?: string[];
  lastResourcePacketIds: string[];
  lastSavepointId?: string;
}

export interface CurrentTaskContext {
  goal: string;
  taskId?: string;
  nodeId?: string;
  taskTitle?: string;
  targets: string[];
  toolIds: string[];
  acceptanceCriteria?: string[];
  failureCriteria?: string[];
  taskOrder: string[];
  pendingTaskIds: string[];
  dependsOn: string[];
  evidenceNeeds: string[];
  completedTaskIds: string[];
  modelJudgedSufficientTaskIds?: string[];
}

export interface AcceptedTaskPlanTaskContext {
  taskId: string;
  title?: string;
  toolId?: string;
  targets: string[];
  acceptanceCriteria?: string[];
  failureCriteria?: string[];
  dependencies: string[];
  planningArgs: Record<string, unknown>;
  conflictKeys: string[];
  batchKind?: ExecutionSliceRole;
}

export interface TaskDependencyFactRecord {
  taskId: string;
  factRef: string;
  toolCallId: string;
  workUnitId: string;
  toolId: string;
  path: string;
  operation?: string;
  contentHash?: string;
  sizeBytes?: number;
  mode?: number;
  executable?: boolean;
}

export interface AcceptedPlanAuthorizationOperation {
  operationId: string;
  sourceTaskId: string;
  toolId: string;
  operationKind: string;
  contentMode: string;
  targets: string[];
  dependsOn: string[];
  fixedArgs: Record<string, unknown>;
  argsTemplate: Record<string, unknown>;
  targetResourceKind?: 'file' | 'directory';
  recursive?: boolean;
  internal: boolean;
}

export interface AcceptedTaskPlanExecutionRoot {
  attachment: AgentContextAttachment;
  ref: string;
  source: 'projectWorkingDirectory' | 'workspaceBinding' | 'recentAttachment';
}

export interface AcceptedTaskPlanContext {
  planId: string;
  planHash?: string;
  authorizationContractId?: string;
  authorizationContractHash?: string;
  runId: string;
  title?: string;
  summary?: string;
  tasks: AcceptedTaskPlanTaskContext[];
  authorizationOperations: AcceptedPlanAuthorizationOperation[];
  toolIds: string[];
  targetScopes: string[];
  executionRoot?: AcceptedTaskPlanExecutionRoot;
  interventionLevel?: AcceptedPlanInterventionLevel;
  batchIndex: number;
  completedTaskIds: string[];
  modelJudgedSufficientTaskIds?: string[];
  dependencyFacts: TaskDependencyFactRecord[];
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
  modelJudgedSufficientTaskIds?: string[];
  newlyModelJudgedSufficientTaskIds?: string[];
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
    | 'taskBindingMismatch'
    | 'draftBindingMismatch'
    | 'protocolShapeInvalid';
  message: string;
  targetPath?: string;
  capability?: string;
  actionId?: string;
  targetResourceKind?: 'file' | 'directory';
  recursive?: boolean;
}
