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
  | 'user_guidance'
  | 'assistant_msg'
  | 'cache_telemetry'
  | 'requirement_confirmation'
  | 'requirement_decision'
  | 'plan_card'
  | 'plan_review'
  | 'review_summary'
  | 'tool_call'
  | 'tool_result'
  | 'permission_request'
  | 'permission_result'
  | 'session_run_state'
  | 'workflow_stage'
  | 'workflow_decision'
  | 'trace/requirement_decision_noop'
  | 'trace/plan_accept_noop'
  | 'trace/permission_accept_noop'
  | 'trace/review_accept_noop'
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
  workspaceScopeKey?: string;
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
  absolutePath?: string;
  folderId?: string;
  source: 'mention' | 'contextMenu' | 'browser' | 'userSelected';
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
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
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

export type AgentTimelineBlockKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'stage'
  | 'toolBatch'
  | 'permission'
  | 'plan'
  | 'review'
  | 'error'
  | 'turnActions';

export type AgentTimelineNarrativeKind =
  | 'user'
  | 'thinking'
  | 'assistantNarration'
  | 'assistantText'
  | 'operationEvidence'
  | 'requirement'
  | 'plan'
  | 'permission'
  | 'verification'
  | 'review'
  | 'diagnostic';

export type AgentTimelineStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed';

export type AgentConversationActivityKind =
  | 'providerThinking'
  | 'resourceSearch'
  | 'resourceRead'
  | 'editBatchQueued'
  | 'editFileStarted'
  | 'editFileCompleted'
  | 'editFileFailed'
  | 'toolExecution'
  | 'subagentBranch'
  | 'subagentMerge'
  | 'reviewCheckpoint'
  | 'diagnostic';

export interface AgentConversationActivity {
  activityId: string;
  kind: AgentConversationActivityKind;
  status: AgentTimelineStatus;
  title: string;
  summary: string;
  source: 'session' | 'kernel' | 'provider' | 'llm';
  runId?: string;
  planId?: string;
  branchId?: string;
  subAgentId?: string;
  mergeGroupId?: string;
  draftId?: string;
  targets?: string[];
  actionIds?: string[];
  workUnitIds?: string[];
  toolName?: string;
  itemCount?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface AgentTimelineDisplayHints {
  density?: 'normal' | 'compact' | 'debug';
  evidenceMode?: 'inline' | 'collapsed' | 'debugOnly';
  renderMode?: 'typewriter' | 'instant' | 'accelerated' | 'static';
  initialOpen?: boolean;
  collapseAfterComplete?: boolean;
  typewriterSpeed?: 'slow' | 'normal' | 'fast';
  replaceOnComplete?: boolean;
  checkpointKind?: 'turnStart' | 'llmProposal' | 'resourcePacket' | 'userGuidance' | 'permission' | 'review' | 'final' | 'diagnostic';
  showInTaskList?: boolean;
  taskListLabel?: string;
  taskListSummary?: string;
  // P4(B)：阶段标记。投影层按 plan_review.accepted 边界算一次：
  //   'explore' = plan 阶段探索性事件（plan_card accepted 之前的工具调用 / 思考等）
  //   'execute' = complete 阶段正式执行事件
  // 旧数据无此字段时回退为 undefined，两壳应按 undefined 等同正常显示。
  phase?: 'explore' | 'execute';
}

export interface AgentTimelineTaskProjectionItem {
  id: string;
  title: string;
  summary: string;
  status: AgentTimelineStatus;
  blockId: string;
  narrativeKind: AgentTimelineNarrativeKind;
}

export interface AgentTimelineTaskProjection {
  title: string;
  items: AgentTimelineTaskProjectionItem[];
}

export interface AgentTimelineTokenUsageTotals {
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cachedTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  providerCallCount: number;
  providers: string[];
}

export interface AgentTimelineTokenUsageRequest extends AgentTimelineTokenUsageTotals {
  requestId: string;
  turnId: string;
  userEventId: string;
  title: string;
  startedAt?: string;
  completedAt?: string;
  stages: string[];
}

export interface AgentTimelineTokenUsageProjection {
  totals: AgentTimelineTokenUsageTotals;
  requests: AgentTimelineTokenUsageRequest[];
}

export interface AgentTimelineBlock {
  id: string;
  kind: AgentTimelineBlockKind;
  narrativeKind?: AgentTimelineNarrativeKind;
  activity?: AgentConversationActivity;
  title: string;
  summary: string;
  status: AgentTimelineStatus;
  defaultCollapsed: boolean;
  bodyMarkdown?: string;
  displayHints?: AgentTimelineDisplayHints;
  evidenceRefs?: string[];
  rawEventRefs?: string[];
  taskProjectionRef?: string;
  events: AgentEvent[];
}

export interface AgentTimelineTurn {
  id: string;
  sessionId: string;
  status: AgentTimelineStatus;
  startedAt?: string;
  completedAt?: string;
  blocks: AgentTimelineBlock[];
}

export interface AgentTimelineResult {
  schemaVersion?: 'deepcode.session.timeline.v1';
  sessionId: string;
  generatedAt: string;
  turns: AgentTimelineTurn[];
  eventCount: number;
  taskProjection?: AgentTimelineTaskProjection;
  tokenUsageProjection?: AgentTimelineTokenUsageProjection;
  rawEventRefs?: string[];
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
  workspaceScopeKey?: string;
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

export interface ResolveAgentPlanRequest {
  decision: 'accept' | 'reject' | 'revise';
  guidance?: string;
}

export interface ResolveAgentReviewRequest {
  decision: 'accept' | 'reject' | 'revise';
  guidance?: string;
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
