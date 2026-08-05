export type AgentEventKind =
  | 'user_msg'
  | 'assistant_msg'
  | 'plan_card'
  | 'plan_review'
  | 'review_summary'
  | 'tool_call'
  | 'tool_result'
  | 'permission_request'
  | 'permission_result'
  | 'session_run_state'
  | 'workflow_stage'
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

export type AgentSessionTitleSource = 'pending' | 'auto' | 'user';

export interface AgentSession {
  id: string;
  title?: string;
  profileId?: string;
  projectId?: string;
  workspaceBinding?: AgentWorkspaceBinding;
  workspaceId?: string;
  workspaceHash?: string;
  workspaceScopeKey?: string;
  archivedAt?: string;
  titleSource?: AgentSessionTitleSource;
  eventCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTimelineAttachment {
  readonly kind: 'file' | 'directory';
  readonly path: string;
  readonly resourceId?: string;
  readonly folderId?: string;
  readonly scope: 'message' | 'session';
}

export interface AgentWorkspaceBinding {
  workspaceId?: string;
  workspaceHash?: string;
  openPath?: string;
  activeFolderId?: string;
  folderHash?: string;
  workspaceBindingRef?: string;
  workspaceBindingIdentity?: string;
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

export interface AgentEvent {
  id: string;
  sessionId: string;
  ts: string;
  kind: AgentEventKind;
  payload: unknown;
}

export type ConversationLanguage = 'zh-CN' | 'en-US';

export const AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2 =
  'deepcode.shared-conversation-projection.v2' as const;
export const AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1 =
  'deepcode.shared-conversation.work-segments.v1' as const;

export type AgentTimelineBlockKind =
  | 'user'
  | 'assistant'
  | 'permission'
  | 'plan'
  | 'review'
  | 'error';

export type AgentTimelineNarrativeKind =
  | 'user'
  | 'assistantText'
  | 'plan'
  | 'permission'
  | 'review'
  | 'diagnostic';

export type AgentTimelineStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type AgentTimelineEntryRole =
  | 'userMessage'
  | 'agentUpdate'
  | 'interaction'
  | 'finalAnswer'
  | 'diagnostic';

export type AgentTimelineDurability = 'live' | 'committed';

export type AgentTimelineLanguageBindingStatus =
  | 'pending'
  | 'resolved'
  | 'fallback'
  | 'superseded'
  | 'unavailable';

export interface AgentTimelineLanguageBinding {
  language: ConversationLanguage | 'neutral';
  revision?: number;
  status: AgentTimelineLanguageBindingStatus;
  sourceTurnId?: string;
}

export interface AgentTimelineProvenance {
  origin: 'user' | 'session' | 'kernel' | 'provider';
  authority: 'user' | 'session' | 'kernel';
  sourceEventRefs: string[];
  factRefs: string[];
  evidenceRefs: string[];
}

export interface AgentTimelineLocalizedText {
  text?: string;
  messageKey?: string;
  messageArgs?: Record<string, string>;
}

export type AgentTimelineRunStatus =
  | 'active'
  | 'waitingUser'
  | 'waitingExternal'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type AgentTimelineRunPhase =
  | 'preparing'
  | 'processing'
  | 'executing'
  | 'validating'
  | 'waiting'
  | 'settled';

export type AgentTimelineCurrentActivityCode =
  | 'session.admitting'
  | 'provider.awaitingFirstByte'
  | 'provider.reasoning'
  | 'provider.composing'
  | 'resource.resolving'
  | 'kernel.executing'
  | 'session.validating'
  | 'session.persisting'
  | 'retry.backoff';

export interface AgentTimelineCurrentActivity {
  code: AgentTimelineCurrentActivityCode;
  summary?: string;
  operationId?: string;
  workSegmentId?: string;
  updatedAt: string;
}

export interface AgentTimelineWait {
  kind: 'user' | 'external' | 'paused';
  reason?: string;
  interactionId?: string;
}

export interface AgentTimelineRunProjection {
  runId: string;
  turnId?: string;
  taskId?: string;
  revision: number;
  status: AgentTimelineRunStatus;
  phase: AgentTimelineRunPhase;
  currentActivity: AgentTimelineCurrentActivity | null;
  wait: AgentTimelineWait | null;
  languageBinding: AgentTimelineLanguageBinding;
}

export interface AgentTimelineDisplayHints {
  density?: 'normal' | 'compact' | 'debug';
  evidenceMode?: 'inline' | 'collapsed' | 'debugOnly';
  collapseAfterComplete?: boolean;
  checkpointKind?: 'turnStart' | 'llmProposal' | 'resourceFact' | 'userGuidance' | 'permission' | 'review' | 'final' | 'diagnostic';
  showInTaskList?: boolean;
  taskListLabel?: string;
  taskListSummary?: string;
  // P4(B)：阶段标记。投影层按 plan_review.accepted 边界算一次：
  //   'explore' = plan 阶段探索性事件（plan_card accepted 之前的工具调用）
  //   'execute' = complete 阶段正式执行事件
  phase?: 'explore' | 'execute';
}

export interface AgentTimelineTaskProjectionItem {
  id: string;
  title: string;
  summary: string;
  status: AgentTimelineTaskStatus;
  blockId: string;
  narrativeKind: AgentTimelineNarrativeKind;
  settlementKind?: 'sessionEvidenceSatisfied';
}

export type AgentTimelineTaskStatus =
  | 'planned'
  | 'previewing'
  | 'needsRevision'
  | 'awaitingApproval'
  | 'authorized'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unexecuted';

export interface AgentTimelineTaskProjection {
  title: string;
  items: AgentTimelineTaskProjectionItem[];
}

export interface AgentTimelineInteractionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AgentTimelineDecisionRequest {
  id?: string;
  reason?: string;
  summary?: string;
  allowsFreeform: boolean;
  options: AgentTimelineInteractionOption[];
}

export interface AgentTimelinePermissionRequestView {
  id: string;
  runId?: string;
  requestKind?: 'runtimePermission' | 'scopeExpansion';
  permissionBundleId?: string;
  contractId?: string;
  affectedOperationIds?: string[];
  toolId?: string;
  toolName: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  diff?: string;
  argumentsPreview?: string;
}

export type AgentTimelineInteractionState =
  | 'open'
  | 'submitting'
  | 'accepted'
  | 'rejected'
  | 'needsRevision'
  | 'superseded'
  | 'expired';

export interface AgentTimelineInteractionIdentity {
  interactionId: string;
  /**
   * Opaque durable token of the AgentEvent that opened this interaction.
   * It is intentionally not a projector counter or array position.
   */
  interactionRevision: string;
  targetId: string;
}

export interface AgentTimelineInteractionView extends AgentTimelineInteractionIdentity {
  kind: 'plan' | 'permission';
  runId?: string;
  state: AgentTimelineInteractionState;
  decisionRequest?: AgentTimelineDecisionRequest;
  selectedDecision?: {
    decision: string;
    source: 'button' | 'freeText';
    decidedAt?: string;
  };
}

export type AgentTimelinePendingInteraction =
  | (AgentTimelineInteractionIdentity & {
      kind: 'permission';
      requestId: string;
      request: AgentTimelinePermissionRequestView;
      blockId?: string;
      title?: string;
      summary?: string;
    })
  | (AgentTimelineInteractionIdentity & {
      kind: 'plan';
      runId: string;
      planId: string;
      blockId?: string;
      title?: string;
      summary?: string;
    });

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
  objective?: string;
  acceptanceCriteria?: string[];
  failureConditions?: string[];
}

export interface AgentTimelineStructuredProjectionSection {
  sectionId: string;
  titleKey: string;
  titleArgs?: Record<string, string>;
  emptyMessageKey?: string;
  items: AgentTimelineStructuredProjectionItem[];
}

export const AGENT_TIMELINE_READABLE_PLAN_SCHEMA_V2 =
  'deepcode.session.readable-plan.v2' as const;
export const AGENT_TIMELINE_READABLE_REVIEW_SCHEMA_V2 =
  'deepcode.session.readable-review.v2' as const;

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
export type AgentTimelineProviderPhase = 'commentary' | 'final_answer';

export interface AgentTimelineBlock {
  id: string;
  sequence?: number;
  revision?: number;
  deliveryMode?: AgentTimelineDeliveryMode;
  durability: AgentTimelineDurability;
  kind: AgentTimelineBlockKind;
  narrativeKind?: AgentTimelineNarrativeKind;
  entryRole: AgentTimelineEntryRole;
  providerPhase?: AgentTimelineProviderPhase;
  title: string;
  summary: string;
  status: AgentTimelineStatus;
  defaultCollapsed: boolean;
  bodyMarkdown?: string;
  localizedContent?: AgentTimelineLocalizedText;
  structuredProjection?: AgentTimelineStructuredProjection;
  decisionRequest?: AgentTimelineDecisionRequest;
  interaction?: AgentTimelineInteractionView;
  confirmable?: boolean;
  attachments?: AgentTimelineAttachment[];
  displayHints?: AgentTimelineDisplayHints;
  evidenceRefs?: string[];
  provenance: AgentTimelineProvenance;
  languageBinding: AgentTimelineLanguageBinding;
  taskProjectionRef?: string;
}

export type AgentTimelineWorkOperationStatus =
  | 'preparing'
  | 'queued'
  | 'running'
  | 'awaitingCapability'
  | 'completed'
  | 'denied'
  | 'failed'
  | 'failedAfterObservedEffect'
  | 'indeterminate'
  | 'cancelled'
  | 'stale'
  | 'unexecuted';

export interface AgentTimelineWorkOperationAttempt {
  attemptId: string;
  status?: AgentTimelineWorkOperationStatus;
  startedAt?: string;
  completedAt?: string;
}

export interface AgentTimelineWorkOperation {
  operationId: string;
  invocationId?: string;
  attempts?: AgentTimelineWorkOperationAttempt[];
  toolId: string;
  displayName?: string;
  status: AgentTimelineWorkOperationStatus;
  canonicalAction?: string;
  targets?: string[];
  effectSummary?: string;
  resourceRefs: string[];
  factRefs: string[];
  effectRefs: string[];
  startedAt?: string;
  completedAt?: string;
}

export interface AgentTimelineWorkAttention {
  kind:
    | 'capability'
    | 'denial'
    | 'failure'
    | 'observedEffectFailure'
    | 'indeterminate';
  status: 'unresolved' | 'resolved';
  summary: string;
  operationId?: string;
  factRefs: string[];
}

export interface AgentTimelineWorkSegment {
  id: string;
  revision: number;
  sequence: number;
  lifecycle: 'active' | 'completed' | 'cancelled' | 'failed';
  attention: AgentTimelineWorkAttention | null;
  operations: AgentTimelineWorkOperation[];
  startedAt?: string;
  completedAt?: string;
  provenance: AgentTimelineProvenance;
  factRefs: string[];
}

export type AgentTimelineTurnPart =
  | { kind: 'block'; blockId: string }
  | { kind: 'workSegment'; workSegmentId: string };

export interface AgentTimelineTurn {
  id: string;
  sequence?: number;
  sessionId: string;
  status: AgentTimelineStatus;
  startedAt?: string;
  completedAt?: string;
  blocks: AgentTimelineBlock[];
  workSegments: AgentTimelineWorkSegment[];
  parts: AgentTimelineTurnPart[];
}

export interface AgentTimelineResult {
  schemaVersion: typeof AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2;
  shapeVersion: typeof AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1;
  sessionId: string;
  revision: number;
  sourceEventVersion: number;
  generatedAt: string;
  turns: AgentTimelineTurn[];
  eventCount: number;
  taskProjection?: AgentTimelineTaskProjection;
  interactionProjection?: AgentTimelineInteractionProjection;
  runProjection?: AgentTimelineRunProjection;
  tokenUsageProjection?: AgentTimelineTokenUsageProjection;
  workspaceProjection?: AgentTimelineWorkspaceProjection;
}

export type AgentTimelineSnapshot = AgentTimelineResult;

export interface AgentTimelineRootProjectionReplacements {
  taskProjection?: AgentTimelineTaskProjection | null;
  interactionProjection?: AgentTimelineInteractionProjection | null;
  runProjection?: AgentTimelineRunProjection | null;
  tokenUsageProjection?: AgentTimelineTokenUsageProjection | null;
  workspaceProjection?: AgentTimelineWorkspaceProjection | null;
}

export interface AgentTimelineDelta {
  schemaVersion: typeof AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2;
  shapeVersion: typeof AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1;
  sessionId: string;
  baseRevision: number;
  revision: number;
  sourceEventVersion: number;
  generatedAt: string;
  eventCount: number;
  turnReplacements: AgentTimelineTurn[];
  removedTurnIds: string[];
  rootReplacements: AgentTimelineRootProjectionReplacements;
}

export type AgentTimelineStreamEvent =
  | {
      type: 'snapshot';
      sessionId: string;
      revision: number;
      snapshot: AgentTimelineSnapshot;
    }
  | {
      type: 'delta';
      sessionId: string;
      revision: number;
      delta: AgentTimelineDelta;
    };

/**
 * A model-visible, workspace-relative reference supplied with one user input.
 *
 * This is context only: it carries neither an absolute Host path nor any
 * capability. Reading the referenced resource still requires a Kernel
 * contextRead tool invocation.
 */
export interface AgentInputAttachmentV2 {
  kind: 'file' | 'directory';
  path: string;
  resourceId?: string;
  folderId?: string;
  scope: 'message' | 'session';
}

export interface AskAgentRunRequest {
  op: 'ask';
  content: string;
  workspacePath?: string;
  noWorkspace?: boolean;
  attachments?: AgentInputAttachmentV2[];
  callerRequestId: string;
}

export interface ResolveAgentRunDecisionRequest {
  op: 'resolveDecision';
  decisionKind: 'plan' | 'permission';
  decision: 'accept' | 'reject' | 'revise';
  guidance?: string;
  runId: string;
  targetId: string;
  callerRequestId: string;
}

export type StartAgentRunRequest =
  | AskAgentRunRequest
  | ResolveAgentRunDecisionRequest;

export interface AgentRunGuidanceRequest {
  guidance: string;
  attachments?: AgentInputAttachmentV2[];
  callerRequestId: string;
}

export interface CreateAgentSessionRequest {
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

export interface AgentSessionResult {
  session: AgentSession;
}
