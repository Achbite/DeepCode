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
  lastSummary?: string;
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

export type AgentTimelineBlockKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'stage'
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
  | 'cancelled'
  | 'failed';

export type AgentTimelineEntryRole =
  | 'userMessage'
  | 'agentUpdate'
  | 'activityGroup'
  | 'evidence'
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

export interface AgentTimelineRunProjection {
  runId: string;
  turnId?: string;
  taskId?: string;
  revision: number;
  status: AgentTimelineRunStatus;
  phase: AgentTimelineRunPhase;
  waitReason?: string;
  activeInteractionId?: string;
  languageBinding: AgentTimelineLanguageBinding;
}

export type AgentConversationActivityKind =
  | 'providerThinking'
  | 'resourceSearch'
  | 'resourceRead'
  | 'toolExecution'
  | 'reviewCheckpoint'
  | 'diagnostic';

export interface AgentConversationActivity {
  activityId: string;
  activityRevision?: number;
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
  checkpointKind?: 'turnStart' | 'llmProposal' | 'resourceFact' | 'userGuidance' | 'permission' | 'review' | 'final' | 'diagnostic';
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
  settlementKind?: 'sessionEvidenceSatisfied';
}

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

export interface AgentTimelineBlock {
  id: string;
  sequence?: number;
  revision?: number;
  deliveryMode?: AgentTimelineDeliveryMode;
  durability: AgentTimelineDurability;
  kind: AgentTimelineBlockKind;
  narrativeKind?: AgentTimelineNarrativeKind;
  entryRole: AgentTimelineEntryRole;
  activity?: AgentConversationActivity;
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
  schemaVersion: 'deepcode.shared-conversation-projection.v2';
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
  events: AgentEvent[];
}
