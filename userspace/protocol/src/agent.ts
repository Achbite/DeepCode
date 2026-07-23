import type { KernelEventV1 } from './kernelAbiV1.js';
export type AgentMode = 'readOnly' | 'plan' | 'askBeforeWrite';
export type AgentWorkflowMode = 'planFirst' | 'actOnRequest';
export type AgentWorkflowStage = 'plan' | 'check' | 'complete' | 'review';
export type AgentWorkflowPhase = AgentWorkflowStage | 'awaitingApproval' | 'done' | 'aborted';
export type AgentRunStatus = 'idle' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'aborted';
export type AgentRiskLevel = 'low' | 'medium' | 'high';
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
  | 'session_turn_authority'
  | 'session_language_decision'
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
  projectId?: string;
  workspaceBinding?: AgentWorkspaceBinding;
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
  kind: 'file' | 'directory';
  path: string;
  absolutePath?: string;
  resourceId?: string;
  folderId?: string;
  source: 'mention' | 'contextMenu' | 'userSelected';
  scope: 'message' | 'session';
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

export type AgentProjectKind = 'folder' | 'blank';
export type AgentProjectRootStatus = 'ready' | 'unbound' | 'unavailable';

export interface AgentProject {
  id: string;
  title: string;
  kind: AgentProjectKind;
  workspaceBinding?: AgentWorkspaceBinding;
  rootStatus: AgentProjectRootStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionRequest {
  id: string;
  requestKind?: 'runtimePermission' | 'scopeExpansion';
  permissionBundleId?: string;
  contractId?: string;
  affectedOperationIds?: string[];
  workUnitIds?: string[];
  toolId?: string;
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

export type SessionTurnAuthorityRelation = 'newTask' | 'interactionContinuation';

export type ConversationLanguage = 'zh-CN' | 'en-US';

export type ConversationLanguagePolicyStatus =
  | 'pending'
  | 'resolved'
  | 'fallback'
  | 'superseded';

export type ConversationLanguageDecisionSource =
  | 'modelSemanticDirective'
  | 'hostFallbackMissing'
  | 'hostFallbackInvalid'
  | 'supersededByLaterUserInput';

export interface ConversationLanguagePolicy {
  schemaVersion: 'deepcode.session.conversation-language-policy.v1';
  revision: number;
  sourceTurnId: string;
  sourceMessageIds: string[];
  hostLanguage: ConversationLanguage;
  status: ConversationLanguagePolicyStatus;
  language?: ConversationLanguage;
  decisionSource?: ConversationLanguageDecisionSource;
  sourceProviderRequestId?: string;
  sourceToolCallId?: string;
}

export interface SessionTurnAuthorityPayload {
  schemaVersion: 'deepcode.session.turn-authority.v2';
  sessionId: string;
  runId: string;
  turnId: string;
  taskId: string;
  sourceMessageIds: string[];
  sourceMessageHashes: string[];
  relation: SessionTurnAuthorityRelation;
  boundAtHookRef: string;
  languagePolicy: ConversationLanguagePolicy;
  promptEpochId?: string;
  previousTaskId?: string;
  authorityHash: string;
}

export interface SessionLanguageDecisionPayload {
  schemaVersion: 'deepcode.session.language-decision.v1';
  sessionId: string;
  runId: string;
  turnId: string;
  revision: number;
  status: Exclude<ConversationLanguagePolicyStatus, 'pending'>;
  responseLanguage?: ConversationLanguage;
  decisionSource: ConversationLanguageDecisionSource;
  sourceProviderRequestId?: string;
  sourceToolCallId?: string;
  decisionHash: string;
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
  draftId?: string;
  targets?: string[];
  actionIds?: string[];
  workUnitIds?: string[];
  toolName?: string;
  operation?: string;
  itemCount?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface AgentTimelineDisplayHints {
  density?: 'normal' | 'compact' | 'debug';
  evidenceMode?: 'inline' | 'collapsed' | 'debugOnly';
  collapseAfterComplete?: boolean;
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

export type AgentTimelineInteractionOptionEffect =
  | { kind: 'continueWithAction' }
  | { kind: 'skipCurrentTask' }
  | { kind: 'replan'; reason?: string }
  | { kind: 'finishRun' };

export interface AgentTimelineInteractionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  effect?: AgentTimelineInteractionOptionEffect;
}

export interface AgentTimelineDecisionRequest {
  id?: string;
  reason?: string;
  summary?: string;
  allowsFreeform: boolean;
  options: AgentTimelineInteractionOption[];
}

export type AgentTimelinePendingInteraction =
  | {
      kind: 'permission';
      requestId: string;
      request: PermissionRequest;
      blockId?: string;
      title?: string;
      summary?: string;
    }
  | { kind: 'review'; runId: string; blockId?: string; title?: string; summary?: string }
  | { kind: 'plan'; runId: string; planId: string; blockId?: string; title?: string; summary?: string }
  | {
      kind: 'requirement';
      runId: string;
      requirementId: string;
      blockId?: string;
      title?: string;
      summary?: string;
      decisionRequest?: AgentTimelineDecisionRequest;
    };

export interface AgentTimelineInteractionProjection {
  pending?: AgentTimelinePendingInteraction;
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

export interface AgentTimelineWorkspaceProjection {
  revision: number;
  changedTargets: string[];
}

export interface AgentTimelineStructuredProjectionItem {
  itemId: string;
  kind: string;
  text?: string;
  messageKey?: string;
  messageArgs?: Record<string, string>;
  status?: string;
  targetRefs?: string[];
  auditRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentTimelineStructuredProjectionSection {
  sectionId: string;
  titleKey: string;
  titleArgs?: Record<string, string>;
  emptyMessageKey?: string;
  items: AgentTimelineStructuredProjectionItem[];
}

export interface AgentTimelineStructuredProjection {
  kind: 'plan' | 'review';
  schemaVersion: string;
  title?: string;
  titleKey?: string;
  titleArgs?: Record<string, string>;
  summary?: string;
  summaryKey?: string;
  messageArgs?: Record<string, string>;
  sections: AgentTimelineStructuredProjectionSection[];
}

export type AgentTimelineDeliveryMode = 'live' | 'buffered' | 'replay';

export interface AgentTimelineBlock {
  id: string;
  sequence?: number;
  revision?: number;
  deliveryMode?: AgentTimelineDeliveryMode;
  kind: AgentTimelineBlockKind;
  narrativeKind?: AgentTimelineNarrativeKind;
  activity?: AgentConversationActivity;
  title: string;
  summary: string;
  status: AgentTimelineStatus;
  defaultCollapsed: boolean;
  bodyMarkdown?: string;
  structuredProjection?: AgentTimelineStructuredProjection;
  decisionRequest?: AgentTimelineDecisionRequest;
  attachments?: AgentContextAttachment[];
  feedbackRef?: {
    eventId: string;
    sessionId: string;
    kind: AgentEventKind;
  };
  displayHints?: AgentTimelineDisplayHints;
  evidenceRefs?: string[];
  rawEventRefs?: string[];
  taskProjectionRef?: string;
  events: AgentEvent[];
}

export interface AgentTimelineTurn {
  id: string;
  sequence?: number;
  sessionId: string;
  status: AgentTimelineStatus;
  startedAt?: string;
  completedAt?: string;
  blocks: AgentTimelineBlock[];
}

export interface AgentTimelineResult {
  schemaVersion?: 'deepcode.session.timeline.v1';
  sessionId: string;
  revision?: number;
  lastDeltaSeq?: number;
  generatedAt: string;
  turns: AgentTimelineTurn[];
  eventCount: number;
  taskProjection?: AgentTimelineTaskProjection;
  interactionProjection?: AgentTimelineInteractionProjection;
  tokenUsageProjection?: AgentTimelineTokenUsageProjection;
  workspaceProjection?: AgentTimelineWorkspaceProjection;
  rawEventRefs?: string[];
}

export interface AgentTimelineDeltaBase {
  schemaVersion: 'deepcode.session.timeline-delta.v1';
  op:
    | 'timeline.synced'
    | 'block.started'
    | 'block.updated'
    | 'text.append'
    | 'activity.upsert'
    | 'block.completed'
    | 'block.committed'
    | 'block.removed';
  sessionId: string;
  runId: string;
  turnId: string;
  turnSeq: number;
  blockId: string;
  blockSeq: number;
  revision: number;
  deltaSeq?: number;
  sourceEventRefs?: string[];
}

export interface AgentTimelineSyncedDelta extends AgentTimelineDeltaBase {
  op: 'timeline.synced';
  timeline: AgentTimelineResult;
  deliveryModes?: Record<string, AgentTimelineDeliveryMode>;
}

export interface AgentTimelineBlockStartedDelta extends AgentTimelineDeltaBase {
  op: 'block.started';
  block: AgentTimelineBlock;
  deliveryMode: AgentTimelineDeliveryMode;
}

export interface AgentTimelineBlockUpdatedDelta extends AgentTimelineDeltaBase {
  op: 'block.updated';
  block: AgentTimelineBlock;
}

export interface AgentTimelineTextAppendedDelta extends AgentTimelineDeltaBase {
  op: 'text.append';
  segmentId: string;
  offset: number;
  text: string;
  format: 'plain' | 'markdown';
  fullCharLength?: number;
  visibleCharLength?: number;
  truncated?: boolean;
  fullTextRef?: string;
}

export interface AgentTimelineActivityUpsertedDelta extends AgentTimelineDeltaBase {
  op: 'activity.upsert';
  activityId: string;
  activityRevision: number;
  activity: AgentConversationActivity;
}

export interface AgentTimelineBlockCompletedDelta extends AgentTimelineDeltaBase {
  op: 'block.completed';
  status: Extract<AgentTimelineStatus, 'completed' | 'waiting' | 'failed' | 'blocked'>;
  contentHash?: string;
}

export interface AgentTimelineBlockCommittedDelta extends AgentTimelineDeltaBase {
  op: 'block.committed';
  committedEventIds: string[];
  finalRevision: number;
  finalContentHash?: string;
  block: AgentTimelineBlock;
}

export interface AgentTimelineBlockRemovedDelta extends AgentTimelineDeltaBase {
  op: 'block.removed';
}

export type AgentTimelineDelta =
  | AgentTimelineSyncedDelta
  | AgentTimelineBlockStartedDelta
  | AgentTimelineBlockUpdatedDelta
  | AgentTimelineTextAppendedDelta
  | AgentTimelineActivityUpsertedDelta
  | AgentTimelineBlockCompletedDelta
  | AgentTimelineBlockCommittedDelta
  | AgentTimelineBlockRemovedDelta;

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
  kernelEvent?: KernelEventV1;
}

export interface CreateAgentSessionRequest {
  initialMode?: AgentMode;
  mode?: AgentMode;
  profileId?: string;
  projectId?: string;
  workspaceId?: string;
  workspaceHash?: string;
  title?: string;
}

export interface ListAgentSessionsRequest {
  projectId?: string;
  workspaceId?: string;
  workspaceHash?: string;
  includeArchived?: boolean;
  includeAllScopes?: boolean;
}

export interface AgentSessionListResult {
  sessions: AgentSession[];
  currentSessionId?: string;
  workspaceScopeKey?: string;
}

export interface RenameAgentSessionRequest {
  title: string;
}

export interface UpdateAgentSessionRequest {
  title?: string;
  projectId?: string | null;
  /** null resets the session to the current enabled default Profile. */
  profileId?: string | null;
}

export interface AgentProjectListResult {
  projects: AgentProject[];
}

export interface CreateAgentProjectRequest {
  title?: string;
  rootPath?: string;
}

export interface UpdateAgentProjectRequest {
  title: string;
}

export interface RebindAgentProjectRequest {
  rootPath: string;
}

export interface AgentProjectResult {
  project: AgentProject;
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
  timeline?: AgentTimelineResult;
}

export interface AgentSessionResult {
  session: AgentSession;
  events: AgentEvent[];
}
