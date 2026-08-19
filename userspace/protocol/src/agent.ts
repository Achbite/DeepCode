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
  | 'user_intervention'
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

/**
 * Daemon-issued identity for the exact conversation selected by a Host.
 *
 * Hosts must echo this value on every Run mutation. The revision is derived
 * from canonical Session ownership and workspace binding facts, so a stale
 * UI selection cannot be silently redirected to another Session or project.
 */
export interface AgentConversationTargetV1 {
  schemaVersion: 'deepcode.host.conversation-target.v1';
  targetId: string;
  targetRevision: string;
  sessionId: string;
  projectId?: string;
  workspaceScopeKey: string;
  workspaceBindingRef?: string;
  workspaceBindingIdentity?: string;
}

/**
 * Daemon-issued identity for a project draft before a Session exists.
 *
 * The revision binds the exact project record and workspace binding selected
 * by the user. Project first-input admission rejects a stale value instead of
 * silently redirecting the new Session to a different root.
 */
export interface AgentProjectConversationTargetV1 {
  schemaVersion: 'deepcode.host.project-conversation-target.v1';
  targetId: string;
  targetRevision: string;
  projectId: string;
  workspaceScopeKey: string;
  workspaceBindingRef?: string;
  workspaceBindingIdentity?: string;
}

export const HOST_CONVERSATION_DRAFT_TARGET_SCHEMA_V1 =
  'deepcode.host.conversation-draft-target.v1' as const;
export const HOST_COMPOSER_PROJECTION_SCHEMA_V1 =
  'deepcode.host.composer-projection.v1' as const;
export const HOST_COMPOSER_PROJECTION_STREAM_SCHEMA_V1 =
  'deepcode.host.composer-projection-stream.v1' as const;

/**
 * Daemon-issued identity for a public or Project draft before a Session exists.
 *
 * A Host must submit this value unchanged with the first user input. The
 * revision binds the current workspace or Project ownership facts so a stale
 * draft cannot create a Session in another navigation target.
 */
export type AgentConversationDraftTargetV1 =
  | {
      schemaVersion: typeof HOST_CONVERSATION_DRAFT_TARGET_SCHEMA_V1;
      kind: 'public';
      targetId: string;
      targetRevision: string;
      workspaceScopeKey: string;
      workspaceId?: string;
      workspaceHash?: string;
    }
  | {
      schemaVersion: typeof HOST_CONVERSATION_DRAFT_TARGET_SCHEMA_V1;
      kind: 'project';
      targetId: string;
      targetRevision: string;
      projectId: string;
      workspaceScopeKey: string;
      workspaceBindingRef?: string;
      workspaceBindingIdentity?: string;
    };

export interface AgentComposerProfileV1 {
  profileId: string;
  name: string;
  model: string;
  providerFlavor: 'openai' | 'deepseek' | 'zhipu';
  isDefault: boolean;
}

export type AgentComposerBlockReasonV1 =
  | 'activeRun'
  | 'pendingInteraction'
  | 'noEnabledProfile'
  | 'selectedProfileUnavailable';

export interface AgentComposerActiveRunV1 {
  hostRunId: string;
  runId: string;
  status: 'active' | 'retiring';
}

export interface AgentComposerProjectionV1 {
  schemaVersion: typeof HOST_COMPOSER_PROJECTION_SCHEMA_V1;
  revision: string;
  conversationTarget?: AgentConversationTargetV1;
  conversationDraftTarget?: AgentConversationDraftTargetV1;
  enabledProfiles: AgentComposerProfileV1[];
  defaultProfileId?: string;
  selectedProfileId?: string;
  selectionMutable: boolean;
  canSubmit: boolean;
  blockReason?: AgentComposerBlockReasonV1;
  activeRun?: AgentComposerActiveRunV1;
  pendingInteraction?: AgentTimelinePendingInteraction;
}

/**
 * Full-replacement companion stream for canonical Composer state.
 *
 * The Host owns admission and Run-retirement facts. Shells consume this
 * envelope instead of inferring Profile mutability from conversation text or
 * a locally observed terminal status.
 */
export interface AgentComposerProjectionStreamEventV1 {
  schemaVersion: typeof HOST_COMPOSER_PROJECTION_STREAM_SCHEMA_V1;
  type: 'snapshot' | 'updated';
  revision: string;
  projection: AgentComposerProjectionV1;
}

export function decodeAgentComposerProjectionV1(
  value: unknown,
  expected: { projectId?: string; sessionId?: string } = {}
): AgentComposerProjectionV1 {
  const projection = composerRecordV1(value, 'composer projection');
  composerExactKeysV1(projection, [
    'schemaVersion',
    'revision',
    'conversationTarget',
    'conversationDraftTarget',
    'enabledProfiles',
    'defaultProfileId',
    'selectedProfileId',
    'selectionMutable',
    'canSubmit',
    'blockReason',
    'activeRun',
    'pendingInteraction',
  ], 'composer projection');
  if (
    projection.schemaVersion !== HOST_COMPOSER_PROJECTION_SCHEMA_V1
    || !composerIdentityV1(projection.revision)
    || !Array.isArray(projection.enabledProfiles)
    || typeof projection.selectionMutable !== 'boolean'
    || typeof projection.canSubmit !== 'boolean'
  ) {
    throw new Error('agent_composer_projection_invalid');
  }
  const enabledProfiles = projection.enabledProfiles.map((value) => {
    const profile = composerRecordV1(value, 'composer profile');
    composerExactKeysV1(profile, [
      'profileId',
      'name',
      'model',
      'providerFlavor',
      'isDefault',
    ], 'composer profile');
    if (
      !composerIdentityV1(profile.profileId)
      || !composerIdentityV1(profile.name)
      || !composerIdentityV1(profile.model)
      || !['openai', 'deepseek', 'zhipu'].includes(
        String(profile.providerFlavor)
      )
      || typeof profile.isDefault !== 'boolean'
    ) throw new Error('agent_composer_profile_invalid');
    return profile as unknown as AgentComposerProfileV1;
  });
  const profileIds = enabledProfiles.map((profile) => profile.profileId);
  if (new Set(profileIds).size !== profileIds.length) {
    throw new Error('agent_composer_profile_duplicate');
  }
  const defaultProfileId = composerOptionalIdentityV1(
    projection.defaultProfileId,
    'defaultProfileId'
  );
  const selectedProfileId = composerOptionalIdentityV1(
    projection.selectedProfileId,
    'selectedProfileId'
  );
  if (
    (defaultProfileId !== undefined && !profileIds.includes(defaultProfileId))
    || (selectedProfileId !== undefined && !profileIds.includes(selectedProfileId))
    || enabledProfiles.filter((profile) => profile.isDefault).length > 1
    || enabledProfiles.some((profile) =>
      profile.isDefault !== (profile.profileId === defaultProfileId)
    )
  ) throw new Error('agent_composer_profile_binding_invalid');
  const conversationTarget = projection.conversationTarget === undefined
    ? undefined
    : decodeComposerConversationTargetV1(projection.conversationTarget);
  const conversationDraftTarget = projection.conversationDraftTarget === undefined
    ? undefined
    : decodeComposerDraftTargetV1(projection.conversationDraftTarget);
  if ((conversationTarget === undefined) === (conversationDraftTarget === undefined)) {
    throw new Error('agent_composer_target_ambiguous');
  }
  if (
    expected.sessionId !== undefined
    && (
      conversationTarget?.sessionId !== expected.sessionId
      || conversationDraftTarget !== undefined
    )
  ) throw new Error('agent_composer_session_target_mismatch');
  if (
    expected.projectId !== undefined
    && (
      conversationTarget?.projectId !== expected.projectId
      && (
        conversationDraftTarget?.kind !== 'project'
        || conversationDraftTarget.projectId !== expected.projectId
      )
    )
  ) throw new Error('agent_composer_project_target_mismatch');
  if (
    expected.sessionId === undefined
    && expected.projectId === undefined
    && conversationDraftTarget?.kind !== 'public'
  ) throw new Error('agent_composer_public_target_mismatch');
  const blockReason = composerOptionalEnumV1(
    projection.blockReason,
    ['activeRun', 'pendingInteraction', 'noEnabledProfile', 'selectedProfileUnavailable'],
    'blockReason'
  ) as AgentComposerBlockReasonV1 | undefined;
  const activeRun = projection.activeRun === undefined
    ? undefined
    : decodeComposerActiveRunV1(projection.activeRun);
  if (
    (blockReason === 'activeRun') !== (activeRun !== undefined)
    || projection.selectionMutable
      !== (activeRun === undefined && projection.pendingInteraction === undefined)
    || projection.canSubmit
      !== (selectedProfileId !== undefined && activeRun?.status !== 'retiring')
    || (projection.pendingInteraction !== undefined
      && typeof projection.pendingInteraction !== 'object')
  ) throw new Error('agent_composer_state_invalid');
  return {
    schemaVersion: HOST_COMPOSER_PROJECTION_SCHEMA_V1,
    revision: projection.revision as string,
    ...(conversationTarget ? { conversationTarget } : {}),
    ...(conversationDraftTarget ? { conversationDraftTarget } : {}),
    enabledProfiles,
    ...(defaultProfileId ? { defaultProfileId } : {}),
    ...(selectedProfileId ? { selectedProfileId } : {}),
    selectionMutable: projection.selectionMutable as boolean,
    canSubmit: projection.canSubmit as boolean,
    ...(blockReason ? { blockReason } : {}),
    ...(activeRun ? { activeRun } : {}),
    ...(projection.pendingInteraction === undefined
      ? {}
      : {
          pendingInteraction:
            projection.pendingInteraction as AgentTimelinePendingInteraction,
        }),
  };
}

export function decodeAgentComposerProjectionStreamEventV1(
  value: unknown,
  expected: { projectId?: string; sessionId?: string } = {}
): AgentComposerProjectionStreamEventV1 {
  const event = composerRecordV1(value, 'composer stream event');
  composerExactKeysV1(event, [
    'schemaVersion',
    'type',
    'revision',
    'projection',
  ], 'composer stream event');
  const projection = decodeAgentComposerProjectionV1(
    event.projection,
    expected
  );
  if (
    event.schemaVersion !== HOST_COMPOSER_PROJECTION_STREAM_SCHEMA_V1
    || (event.type !== 'snapshot' && event.type !== 'updated')
    || event.revision !== projection.revision
  ) throw new Error('agent_composer_projection_stream_invalid');
  return {
    schemaVersion: HOST_COMPOSER_PROJECTION_STREAM_SCHEMA_V1,
    type: event.type,
    revision: projection.revision,
    projection,
  };
}

function decodeComposerConversationTargetV1(
  value: unknown
): AgentConversationTargetV1 {
  const target = composerRecordV1(value, 'conversation target');
  composerExactKeysV1(target, [
    'schemaVersion', 'targetId', 'targetRevision', 'sessionId', 'projectId',
    'workspaceScopeKey', 'workspaceBindingRef', 'workspaceBindingIdentity',
  ], 'conversation target');
  if (
    target.schemaVersion !== 'deepcode.host.conversation-target.v1'
    || !composerIdentityV1(target.targetId)
    || !composerIdentityV1(target.targetRevision)
    || !composerIdentityV1(target.sessionId)
    || !composerIdentityV1(target.workspaceScopeKey)
  ) throw new Error('agent_composer_conversation_target_invalid');
  for (const optional of [
    'projectId', 'workspaceBindingRef', 'workspaceBindingIdentity',
  ] as const) composerOptionalIdentityV1(target[optional], optional);
  return target as unknown as AgentConversationTargetV1;
}

function decodeComposerDraftTargetV1(
  value: unknown
): AgentConversationDraftTargetV1 {
  const target = composerRecordV1(value, 'conversation draft target');
  composerExactKeysV1(target, [
    'schemaVersion', 'kind', 'targetId', 'targetRevision', 'projectId',
    'workspaceScopeKey', 'workspaceId', 'workspaceHash',
    'workspaceBindingRef', 'workspaceBindingIdentity',
  ], 'conversation draft target');
  if (
    target.schemaVersion !== HOST_CONVERSATION_DRAFT_TARGET_SCHEMA_V1
    || (target.kind !== 'public' && target.kind !== 'project')
    || !composerIdentityV1(target.targetId)
    || !composerIdentityV1(target.targetRevision)
    || !composerIdentityV1(target.workspaceScopeKey)
    || (target.kind === 'project' && !composerIdentityV1(target.projectId))
  ) throw new Error('agent_composer_draft_target_invalid');
  return target as unknown as AgentConversationDraftTargetV1;
}

function decodeComposerActiveRunV1(value: unknown): AgentComposerActiveRunV1 {
  const run = composerRecordV1(value, 'composer active run');
  composerExactKeysV1(run, ['hostRunId', 'runId', 'status'], 'composer active run');
  if (
    !composerIdentityV1(run.hostRunId)
    || !composerIdentityV1(run.runId)
    || (run.status !== 'active' && run.status !== 'retiring')
  ) throw new Error('agent_composer_active_run_invalid');
  return run as unknown as AgentComposerActiveRunV1;
}

function composerRecordV1(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`agent_composer_${field.replaceAll(' ', '_')}_invalid`);
  }
  return value as Record<string, unknown>;
}

function composerExactKeysV1(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`agent_composer_${field.replaceAll(' ', '_')}_invalid`);
  }
}

function composerIdentityV1(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function composerOptionalIdentityV1(
  value: unknown,
  field: string
): string | undefined {
  if (value === undefined) return undefined;
  if (!composerIdentityV1(value)) throw new Error(`agent_composer_${field}_invalid`);
  return value;
}

function composerOptionalEnumV1(
  value: unknown,
  allowed: readonly string[],
  field: string
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`agent_composer_${field}_invalid`);
  }
  return value;
}

export const PRIVATE_ANALYSIS_PROJECTION_SCHEMA_V1 =
  'deepcode.session.private-analysis-projection.v1' as const;
export const PRIVATE_ANALYSIS_LEASE_SCHEMA_V1 =
  'deepcode.session.private-analysis-lease.v1' as const;
export const PRIVATE_ANALYSIS_LEASE_HEADER_V1 =
  'x-deepcode-private-analysis-lease' as const;

export interface PrivateAnalysisLeaseReceiptV1 {
  schemaVersion: typeof PRIVATE_ANALYSIS_LEASE_SCHEMA_V1;
  sessionId: string;
  capability: string;
  expiresInSeconds: number;
}

export interface PrivateAnalysisToolV1 {
  name: string;
  stage: string;
}

export interface PrivateAnalysisItemV1 {
  analysisId: string;
  requestId: string;
  providerTurnId: string;
  runId: string;
  userTurnId: string;
  boundary: 'primary' | 'continuation' | 'finalAnswer';
  startedAtUnixMs: string;
  completedAtUnixMs: string;
  status: 'completed' | 'failed' | 'cancelled' | 'limitExceeded';
  reasonCode?: string;
  reasoning: string;
  tools: PrivateAnalysisToolV1[];
}

export interface PrivateAnalysisProjectionV1 {
  schemaVersion: typeof PRIVATE_ANALYSIS_PROJECTION_SCHEMA_V1;
  sessionId: string;
  afterCursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  items: PrivateAnalysisItemV1[];
}

export interface PrivateAnalysisRevokeReceiptV1 {
  schemaVersion: typeof PRIVATE_ANALYSIS_LEASE_SCHEMA_V1;
  sessionId: string;
  revoked: boolean;
}

export interface AgentSession {
  id: string;
  title?: string;
  profileId?: string;
  projectId?: string;
  workspaceBinding?: AgentWorkspaceBinding;
  workspaceId?: string;
  workspaceHash?: string;
  workspaceScopeKey?: string;
  conversationTarget: AgentConversationTargetV1;
  archivedAt?: string;
  titleSource?: AgentSessionTitleSource;
  eventCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentHostCallerMutationErrorV2 {
  schemaVersion: 'deepcode.host.caller-mutation-error.v2';
  disposition: 'rejected' | 'pending' | 'indeterminate';
}

export interface AgentTimelineAttachment {
  readonly kind: 'file' | 'directory';
  readonly attachmentId: string;
  readonly resourceId: string;
  readonly displayName: string;
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
  conversationTarget: AgentProjectConversationTargetV1;
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
export const AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V2 =
  'deepcode.shared-conversation.work-segments.v2' as const;
export const AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V3 =
  'deepcode.shared-conversation-projection.v3' as const;
export const AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V3 =
  'deepcode.shared-conversation.work-segments.v3' as const;
export const AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V4 =
  'deepcode.shared-conversation-projection.v4' as const;
export const AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V4 =
  'deepcode.shared-conversation.work-segments.v4' as const;

export type AgentTimelineBlockKind =
  | 'user'
  | 'assistant'
  | 'permission'
  | 'plan'
  | 'userIntervention'
  | 'review'
  | 'error';

export type AgentTimelineNarrativeKind =
  | 'user'
  | 'assistantText'
  | 'plan'
  | 'permission'
  | 'userIntervention'
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

export interface AgentTimelineResourcePresentation {
  kind: 'workspacePath' | 'resourceLabel';
  label: string;
  workspaceRelativePath?: string;
  canonicalResourceRef?: string;
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

export type AgentTimelineCurrentActivitySource =
  | 'session'
  | 'provider'
  | 'resource'
  | 'kernel'
  | 'retry';

export type AgentTimelineCurrentActivityStatus = 'active';

export interface AgentTimelineCurrentActivity {
  activityId: string;
  revision: number;
  code: AgentTimelineCurrentActivityCode;
  source: AgentTimelineCurrentActivitySource;
  status: AgentTimelineCurrentActivityStatus;
  startedAt: string;
  updatedAt: string;
  message?: AgentTimelineLocalizedText;
  detailBlockId?: string;
  providerRequestId?: string;
}

export interface AgentTimelineWait {
  kind: 'user' | 'external' | 'paused';
  since: string;
  reasonCode: string;
  retryAt?: string;
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
  checkpointKind?: 'turnStart' | 'llmProposal' | 'resourceFact' | 'userGuidance' | 'permission' | 'userIntervention' | 'review' | 'final' | 'diagnostic';
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
  titleKey: string;
  titleArgs: Record<string, string>;
  summaryKey: string;
  messageArgs: Record<string, string>;
  targetRefs: string[];
  resourcePresentation: AgentTimelineResourcePresentation[];
  progress: AgentTimelineTaskProgress;
  outcome: AgentTimelineTaskOutcome | null;
  attention: AgentTimelineWorkAttention | null;
  blockId: string;
  narrativeKind: AgentTimelineNarrativeKind;
  settlementKind?: 'sessionEvidenceSatisfied';
}

export type AgentTimelineTaskProgress =
  | 'queued'
  | 'thinking'
  | 'completed';

export type AgentTimelineTaskOutcome =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'unexecuted'
  | 'cancelled'
  | 'indeterminate';

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

export interface AgentTimelineInterventionCandidateActionV4 {
  planActionId: string;
  operationId: string;
  toolId: string;
  summary: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  canonicalTargets: string[];
  scopeDelta: string[];
  previewId: string;
  previewDigest: string;
}

export interface AgentTimelineInterventionOptionV4
  extends AgentTimelineInteractionOption {
  kind: 'executable' | 'guidanceOnly';
  tradeoffs: string[];
  candidatePlanRevision?: string;
  candidatePlanDigest?: string;
  actions: AgentTimelineInterventionCandidateActionV4[];
}

export interface AgentTimelineUserInterventionViewV4 {
  schemaVersion: 'deepcode.session.user-intervention.v1';
  interactionId: string;
  interactionRevision: string;
  candidateSetDigest: string;
  problemSummary: string;
  recommendation?: string;
  relevantFacts: string[];
  affectedPlanActionIds: string[];
  options: AgentTimelineInterventionOptionV4[];
  allowsFreeform: true;
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
  kind: 'plan' | 'permission' | 'userIntervention';
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
    })
  | (AgentTimelineInteractionIdentity & {
      kind: 'userIntervention';
      runId: string;
      candidateSetDigest: string;
      intervention: AgentTimelineUserInterventionViewV4;
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
  resourcePresentation?: AgentTimelineResourcePresentation[];
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
  kind: 'plan' | 'userIntervention' | 'review';
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
export type AgentTimelineAnswerState =
  | 'streaming'
  | 'provisional'
  | 'committed'
  | 'stale'
  | 'rejected';

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
  answerState?: AgentTimelineAnswerState;
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

export interface AgentTimelineWorkOperationRetry {
  retryGroupId: string;
  predecessorOperationId: string;
  retryOrdinal: number;
}

export interface AgentTimelineWorkOperation {
  operationId: string;
  invocationId?: string;
  attempts?: AgentTimelineWorkOperationAttempt[];
  retry?: AgentTimelineWorkOperationRetry;
  toolId: string;
  displayName?: string;
  status: AgentTimelineWorkOperationStatus;
  canonicalAction?: string;
  resourcePresentation: AgentTimelineResourcePresentation[];
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
  activeOperationId?: string;
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
  schemaVersion: typeof AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V4;
  shapeVersion: typeof AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V4;
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
  tokenUsageProjection?: AgentTimelineTokenUsageProjection | null;
  workspaceProjection?: AgentTimelineWorkspaceProjection | null;
}

export interface ConversationTextAppendV4 {
  turnId: string;
  blockId: string;
  baseBlockRevision: number;
  blockRevision: number;
  textDelta: string;
  sourceEventRefs: string[];
}

export type AgentTimelineDeltaOperationV4 =
  | {
      kind: 'text.append';
      append: ConversationTextAppendV4;
    }
  | {
      kind: 'run.updated';
      runProjection: AgentTimelineRunProjection | null;
    };

export interface AgentTimelineDelta {
  schemaVersion: typeof AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V4;
  shapeVersion: typeof AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V4;
  sessionId: string;
  baseRevision: number;
  revision: number;
  sourceEventVersion: number;
  generatedAt: string;
  eventCount: number;
  turnReplacements: AgentTimelineTurn[];
  removedTurnIds: string[];
  operations: AgentTimelineDeltaOperationV4[];
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
 * A public handle for a Host-admitted user resource.
 *
 * Absolute Host paths and snapshot locations remain private to the Host. The
 * handle grants no direct filesystem access or tool authority: the Host reads
 * the exact user-selected resource and Session consumes its bounded snapshot
 * as authoritative user-provided context.
 */
export interface AgentInputAttachmentV3 {
  kind: 'file' | 'directory';
  attachmentId: string;
  resourceId: string;
  displayName: string;
  /**
   * message is consumed by one exact user-input request. session is inherited
   * by later inputs in the same Session until its Host grant is revoked.
   */
  scope: 'message' | 'session';
}

export interface CreateUserAttachmentGrantRequestV1 {
  absolutePath: string;
  scope: AgentInputAttachmentV3['scope'];
  callerRequestId: string;
}

export interface UserAttachmentGrantResultV1 {
  schemaVersion: 'deepcode.host.user-attachment-grant.v1';
  attachment: AgentInputAttachmentV3;
  snapshot: {
    fileCount: number;
    totalBytes: number;
  };
}

export interface AskAgentRunRequest {
  op: 'ask';
  content: string;
  workspacePath?: string;
  noWorkspace?: boolean;
  attachments?: AgentInputAttachmentV3[];
  conversationTarget: AgentConversationTargetV1;
  callerRequestId: string;
}

export interface ResolveAgentRunStandardDecisionRequest {
  op: 'resolveDecision';
  decisionKind: 'plan' | 'permission';
  decision: 'accept' | 'reject' | 'revise';
  guidance?: string;
  runId: string;
  targetId: string;
  conversationTarget: AgentConversationTargetV1;
  callerRequestId: string;
}

export interface ResolveAgentRunInterventionDecisionRequest {
  op: 'resolveDecision';
  decisionKind: 'userIntervention';
  decision: 'select' | 'revise' | 'reject';
  optionId?: string;
  guidance?: string;
  runId: string;
  targetId: string;
  interactionId: string;
  interactionRevision: string;
  candidateSetDigest: string;
  expectedProjectionCursor: number;
  conversationTarget: AgentConversationTargetV1;
  callerRequestId: string;
}

export type ResolveAgentRunDecisionRequest =
  | ResolveAgentRunStandardDecisionRequest
  | ResolveAgentRunInterventionDecisionRequest;

export type StartAgentRunRequest =
  | AskAgentRunRequest
  | ResolveAgentRunDecisionRequest;

export interface AgentRunGuidanceRequest {
  guidance: string;
  workspacePath?: string;
  noWorkspace?: boolean;
  attachments?: AgentInputAttachmentV3[];
  conversationTarget: AgentConversationTargetV1;
  callerRequestId: string;
}

export interface StartConversationDraftRunRequest {
  conversationDraftTarget: AgentConversationDraftTargetV1;
  profileId: string;
  content: string;
  attachments?: AgentInputAttachmentV3[];
  callerRequestId: string;
}

export interface CreateAgentSessionRequest {
  profileId?: string;
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
