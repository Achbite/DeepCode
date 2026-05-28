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
export type AgentReviewGateStatus = 'accepted' | 'needsReplan' | 'needsUserReview' | 'aborted';
export type AgentTraceEventKind =
  | 'turn.started'
  | 'turn.completed'
  | 'stage.started'
  | 'stage.completed'
  | 'stage.failed'
  | 'context.budget'
  | 'llm.requested'
  | 'llm.completed'
  | 'tool.requested'
  | 'tool.completed'
  | 'tool.failed'
  | 'permission.requested'
  | 'permission.resolved'
  | 'shell.output'
  | 'file.changed'
  | 'user.guidance'
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
export type AgentTraceEventLevel = 'debug' | 'info' | 'warn' | 'error';
export type AgentTraceEventSource = 'web' | 'native' | 'agent' | 'runtime' | 'user';

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

export type AgentOutcomeKind = AgentStageOutcome['kind'];

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
  eventId?: string;
  sessionId: string;
  turnId?: string;
  ts: string;
  timestamp?: string;
  kind: AgentTraceEventKind;
  source?: AgentTraceEventSource;
  level?: AgentTraceEventLevel;
  phase?: AgentWorkflowPhase;
  toolCallId?: string;
  workUnitId?: string;
  summary: string;
  payload?: unknown;
}

export interface AgentTraceEventFilter {
  turnId?: string;
  phase?: AgentWorkflowPhase;
  kind?: AgentTraceEventKind;
  toolCallId?: string;
  afterEventId?: string;
  limit?: number;
}

export interface TraceLedgerSnapshot {
  sessionId: string;
  events: AgentTraceEvent[];
  eventCount: number;
  updatedAt: string;
}

export interface GetAgentEventSnapshotResult {
  sessionId: string;
  trace: TraceLedgerSnapshot;
}

export interface AckAgentEventRequest {
  eventId: string;
}

export interface AckAgentEventResult {
  accepted: boolean;
  eventId: string;
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

export interface AgentWorkQueueSnapshot {
  runId: string;
  units: AgentWorkUnit[];
  activeOwners: Record<string, string>;
  blockedUnits: AgentWorkUnit[];
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

export interface AgentReviewGateResult {
  id: string;
  runId: string;
  status: AgentReviewGateStatus;
  summary: string;
  satisfiedCriteria: string[];
  missingCriteria: string[];
  evidenceRefs: string[];
  changeSetId?: string;
  validationResultIds: string[];
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
  | 'workflow_decision'
  | 'error';

export type AgentEventChannel =
  | 'user'
  | 'reasoning'
  | 'progress'
  | 'action'
  | 'tool'
  | 'observation'
  | 'final'
  | 'task'
  | 'error';

export type AgentEventVisibility =
  | 'conversation'
  | 'task'
  | 'trace'
  | 'both'
  | 'hidden';

export type AgentDisplayDensity = 'compact' | 'balanced' | 'verbose';
export type AgentSessionTitleSource = 'pending' | 'auto' | 'user';

export type AgentEventPresentation =
  | 'body'
  | 'collapsible'
  | 'stageSummary'
  | 'traceOnly';

export interface AgentEventDisplayHint {
  presentation?: AgentEventPresentation;
  defaultOpen?: boolean;
  importance?: 'primary' | 'secondary' | 'debug';
}

export interface AgentDisplayPolicy {
  density: AgentDisplayDensity;
  defaultOpenByChannel?: Partial<Record<AgentEventChannel, boolean>>;
  presentationByChannel?: Partial<Record<AgentEventChannel, AgentEventPresentation>>;
}

export interface AgentSession {
  id: string;
  title?: string;
  mode: AgentMode;
  profileId?: string;
  workspaceId?: string;
  workspaceHash?: string;
  archivedAt?: string;
  lastSummary?: string;
  titleSource?: AgentSessionTitleSource;
  eventCount?: number;
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

export interface AgentWorkspaceBinding {
  workspaceId?: string;
  workspaceHash?: string;
  openPath?: string;
  activeFolderId?: string;
  folderHash?: string;
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
  display?: AgentEventDisplayHint;
}

/**
 * 工作流类事件（workflow_decision / workflow_stage 与 RunCompleted 投影）的 payload 根字段契约。
 *
 * 阶段 7/8 review 修复（F4 残留横线根因之一）：Host 投影必须把 stage/status/summary/details
 * 提升到 payload 根字段，让 GUI MessageList 在折叠卡标题渲染、空容器过滤时能直接读取，
 * 不再因 payload 只塞 decision 子对象而出现"空标题"折叠卡。
 *
 * 本 mixin 仅作类型守卫与文档契约；AgentEvent.payload 类型保持 unknown 不变，
 * 避免破坏既有不带这些字段的事件（如 user_msg / tool_call）。
 */
export interface WorkflowPayloadFields {
  stage?: string;
  phase?: string;
  status?: string;
  summary?: string;
  details?: string;
  channel?: AgentEventChannel;
  visibility?: AgentEventVisibility;
  presentation?: AgentEventPresentation;
  decision?: unknown;
  kernelEvent?: unknown;
}

export interface CreateAgentSessionRequest {
  initialMode?: AgentMode;
  mode?: AgentMode;
  profileId?: string;
  workspaceId?: string;
  workspaceHash?: string;
  title?: string;
}

export interface ListAgentSessionsRequest {
  workspaceId?: string;
  workspaceHash?: string;
  includeArchived?: boolean;
}

export interface AgentSessionListResult {
  sessions: AgentSession[];
  currentSessionId?: string;
}

export interface RenameAgentSessionRequest {
  title: string;
}

export interface ArchiveAgentSessionRequest {
  archived?: boolean;
}

export interface SendAgentMessageRequest {
  content: string;
  attachments?: AgentContextAttachment[];
  workspaceBinding?: AgentWorkspaceBinding;
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
