import type { PanelSemanticSnapshot } from './browser.js';

export type AgentMode = 'readOnly' | 'plan' | 'askBeforeWrite';
export type AgentWorkflowMode = 'planFirst' | 'actOnRequest';
export type AgentWorkflowStage = 'plan' | 'check' | 'complete' | 'review';
export type AgentWorkflowPhase = AgentWorkflowStage | 'awaitingApproval' | 'done' | 'aborted';
export type AgentRunStatus = 'idle' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'aborted';
export type AgentRiskLevel = 'low' | 'medium' | 'high';
export type AgentWorkUnitScopeKind = 'file' | 'range' | 'docSection' | 'symbol';
export type AgentWorkUnitStatus = 'queued' | 'running' | 'waitingReview' | 'completed' | 'blocked' | 'cancelled';
export type AgentChangeOperationKind = 'write' | 'edit' | 'delete' | 'rename' | 'shellGeneratedChange';
export type AgentValidationKind = 'test' | 'lint' | 'typecheck' | 'format' | 'policy' | 'secretScan' | 'manualReview';
export type AgentTraceEventKind =
  | 'workflow.transition'
  | 'workflow.outcome'
  | 'llm.request'
  | 'llm.response'
  | 'tool.call'
  | 'tool.result'
  | 'permission.request'
  | 'permission.result'
  | 'changeset.created'
  | 'validation.result'
  | 'browser.element_selected'
  | 'browser.panel_snapshot_created'
  | 'browser.panel_snapshot_attached'
  | 'error';

export type AgentReplanReason =
  | 'invalid_plan'
  | 'missing_context'
  | 'tool_error'
  | 'test_failed'
  | 'plan_mismatch'
  | 'scope_changed'
  | 'unsafe_operation'
  | 'permission_required'
  | 'user_rejected_permission'
  | 'insufficient_evidence'
  | 'budget_exceeded';

export const AGENT_WORKFLOW_STAGES: AgentWorkflowStage[] = [
  'plan',
  'check',
  'complete',
  'review',
];

export interface AgentWorkflowStageConfig {
  profileId?: string;
}

export type AgentWorkflowConfig = Record<AgentWorkflowStage, AgentWorkflowStageConfig>;

export interface AgentObservationRef {
  id: string;
  kind:
    | 'file_read'
    | 'file_diff'
    | 'file_write'
    | 'shell_exit_code'
    | 'tool_result'
    | 'permission_decision'
    | 'user_message'
    | 'review_note'
    | 'error';
  summary: string;
  ok?: boolean;
  eventId?: string;
  toolCallId?: string;
  dataRef?: string;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  intent: string;
  expectedTool?: string;
  expectedFiles?: string[];
  riskLevel: AgentRiskLevel;
}

export interface AgentPlanArtifact {
  id: string;
  goal: string;
  assumptions: string[];
  steps: AgentPlanStep[];
  successCriteria: string[];
  allowedTools: string[];
  forbiddenActions: string[];
  evidenceRequired: string[];
}

export type AgentStageOutcome =
  | {
      kind: 'plan.proposed';
      plan: AgentPlanArtifact;
      confidence: number;
      summary?: string;
    }
  | {
      kind: 'plan.needs_user_input';
      question: string;
      blockingReason: string;
      summary?: string;
    }
  | {
      kind: 'check.accepted';
      planId: string;
      notes?: string[];
      summary?: string;
    }
  | {
      kind: 'check.rejected';
      planId?: string;
      reason: AgentReplanReason;
      evidence: AgentObservationRef[];
      summary?: string;
    }
  | {
      kind: 'complete.progress';
      completedStepIds: string[];
      observations: AgentObservationRef[];
      remainingStepIds: string[];
      summary?: string;
    }
  | {
      kind: 'complete.blocked';
      reason: AgentReplanReason;
      evidence: AgentObservationRef[];
      suggestedRepair?: string;
      summary?: string;
    }
  | {
      kind: 'complete.done';
      completedStepIds: string[];
      evidence: AgentObservationRef[];
      summary?: string;
    }
  | {
      kind: 'review.accepted';
      evidence: AgentObservationRef[];
      summary: string;
    }
  | {
      kind: 'review.rejected';
      reason: AgentReplanReason;
      evidence: AgentObservationRef[];
      summary?: string;
    }
  | {
      kind: 'permission.approved';
      permissionId: string;
      summary?: string;
    }
  | {
      kind: 'permission.rejected';
      permissionId: string;
      reason: AgentReplanReason;
      summary?: string;
    };

export interface AgentWorkflowState {
  sessionId: string;
  phase: AgentWorkflowPhase;
  status: AgentRunStatus;
  iteration: number;
  maxIterations: number;
  currentPlan?: AgentPlanArtifact;
  observations: AgentObservationRef[];
  pendingPermissionId?: string;
  lastOutcomeKind?: AgentStageOutcome['kind'];
  lastError?: {
    code: string;
    message: string;
  };
}

export interface AgentWorkflowTransition {
  id: string;
  sessionId: string;
  from: AgentWorkflowPhase;
  to: AgentWorkflowPhase;
  outcomeKind: AgentStageOutcome['kind'];
  reason?: AgentReplanReason | string;
  iteration: number;
  createdAt: string;
}

export interface AgentTraceEvent {
  id: string;
  sessionId: string;
  ts: string;
  kind: AgentTraceEventKind;
  phase?: AgentWorkflowPhase;
  eventId?: string;
  toolCallId?: string;
  workUnitId?: string;
  summary: string;
  payload?: unknown;
}

export interface AgentWorkUnitScope {
  kind: AgentWorkUnitScopeKind;
  path: string;
  startLine?: number;
  endLine?: number;
  symbolName?: string;
}

export interface AgentWorkUnit {
  id: string;
  runId: string;
  title: string;
  status: AgentWorkUnitStatus;
  scope: AgentWorkUnitScope;
  owner?: string;
  planStepId?: string;
  dependsOn?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentChangeOperation {
  id: string;
  toolCallId?: string;
  workUnitId?: string;
  kind: AgentChangeOperationKind;
  filePath: string;
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
}

export interface AgentChangeSet {
  id: string;
  runId: string;
  baseSha?: string;
  operations: AgentChangeOperation[];
  touchedFiles: string[];
  diffSummary: string;
  diffStats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AgentValidationResult {
  id: string;
  runId: string;
  kind: AgentValidationKind;
  command?: string;
  exitCode?: number;
  passed: boolean;
  summary: string;
  evidenceRefs: string[];
  createdAt: string;
}

export interface GetAgentWorkflowConfigResult {
  config: AgentWorkflowConfig;
  storePath?: string;
  initialized: boolean;
}

export interface PatchAgentWorkflowConfigRequest {
  config: Partial<Record<AgentWorkflowStage, AgentWorkflowStageConfig | null>>;
}

export type AgentEventKind =
  | 'user_msg'
  | 'assistant_msg'
  | 'tool_call'
  | 'tool_result'
  | 'permission_request'
  | 'permission_result'
  | 'workflow_stage'
  | 'error';

export interface AgentSession {
  id: string;
  title?: string;
  mode: AgentMode;
  profileId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentContextAttachment {
  kind: 'file' | 'directory' | 'panelSnapshot';
  path: string;
  folderId?: string;
  source: 'mention' | 'contextMenu' | 'browser';
  scope: 'message' | 'session';
  snapshot?: PanelSemanticSnapshot;
}

export interface AgentContextSnapshot {
  attachments: AgentContextAttachment[];
  promptText: string;
  truncated: boolean;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  diff?: string;
  argumentsPreview: unknown;
}

export interface PermissionDecision {
  action: 'allow' | 'ask' | 'deny';
  reason: string;
  request?: PermissionRequest;
}

export interface AgentEvent {
  id: string;
  sessionId: string;
  ts: string;
  kind: AgentEventKind;
  payload: unknown;
}

export interface CreateAgentSessionRequest {
  initialMode?: AgentMode;
  profileId?: string;
}

export interface SendAgentMessageRequest {
  content: string;
  attachments?: AgentContextAttachment[];
  mode?: AgentMode;
  workflow?: AgentWorkflowMode;
  workflowConfig?: AgentWorkflowConfig;
  profileId?: string;
}

export interface ResolveAgentPermissionRequest {
  decision: 'accept' | 'reject';
}

export type AgentFeedbackRating = 'up' | 'down';

export interface AgentFeedbackRequest {
  eventId: string;
  sessionId?: string;
  kind?: AgentEventKind;
  rating: AgentFeedbackRating;
  note?: string;
}

export interface AgentFeedbackResult {
  accepted: boolean;
  message: string;
}

export interface AppendAgentEventsRequest {
  events: AgentEvent[];
}

export interface AgentSessionResult {
  session: AgentSession;
  events: AgentEvent[];
}
