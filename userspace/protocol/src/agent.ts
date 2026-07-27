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
  | 'session_goal_fact'
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

export type SessionProviderAttemptKindV1 =
  | 'primary'
  | 'resume'
  | 'repair'
  | 'retry'
  | 'emptyRetry'
  | 'streamFallback'
  | 'review';

/**
 * Durable control metadata for one admitted physical Provider request.
 * Prompt messages and Provider reasoning are intentionally excluded.
 */
export interface SessionProviderAdmissionMetadataV1 {
  schemaVersion: 'deepcode.session.provider-admission-metadata.v1';
  requestId: string;
  parentRequestId?: string;
  turnAuthorityRef: string;
  attemptKind: SessionProviderAttemptKindV1;
  stage: string;
  languageRevision?: number;
  providerPayloadDigest: string;
  transportDigest: string;
}

export interface SessionProviderAdmissionProducerV1 {
  kind: 'providerAdmission';
  providerRequestId: string;
  proposalId?: string;
}

export interface SessionRuleProducerV1 {
  kind: 'sessionRule';
  ruleId: string;
  sourceEventRefs: string[];
}

export type SessionFactProducerV1 =
  | SessionProviderAdmissionProducerV1
  | SessionRuleProducerV1;

export type SessionKernelFactKindV1 =
  | 'plan_authorization.decision_recorded'
  | 'tool.execution_attempted'
  | 'tool.effect_observed'
  | 'tool.outcome_indeterminate'
  | 'tool.completed'
  | 'work_unit.completed'
  | 'work_unit.failed'
  | 'work_unit.blocked'
  | 'review.facts_produced'
  | 'review_gate.evaluated'
  | 'run.completed'
  | 'runtime.lifecycle_changed'
  | 'resource.cleanup_state_changed';

/**
 * Immutable reference to a typed Kernel fact. The referenced Kernel event,
 * rather than these denormalized identity fields, remains authoritative.
 */
export interface SessionKernelFactRefV1 {
  schemaVersion: 'deepcode.session.kernel-fact-ref.v1';
  kernelEventRef: string;
  kind: SessionKernelFactKindV1;
  runId: string;
  factId?: string;
  planActionId?: string;
  capabilityGrantId?: string;
  authorizationContractId?: string;
  operationId?: string;
  workUnitId?: string;
}

/**
 * Lineage is composed into applicable durable domain-event payloads. It is not
 * an optional envelope on every AgentEvent.
 */
export interface SessionFactLineageV1 {
  schemaVersion: 'deepcode.session.fact-lineage.v1';
  turnAuthorityRef: string;
  producer: SessionFactProducerV1;
  domainParentRefs: string[];
  kernelFactRefs: SessionKernelFactRefV1[];
}

export type SessionGoalLifecycleV1 =
  | 'draft'
  | 'awaitingPlanAcceptance'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SessionGoalRefV1 {
  goalId: string;
  goalRevision: number;
}

export interface SessionGoalCommandIdentityV1 {
  callerRequestId: string;
  requestDigest: string;
  hostRunId?: string;
}

export interface SessionGoalInteractionRefV1 {
  kind: 'requirement' | 'plan' | 'review' | 'permission' | 'scopeChange';
  interactionId: string;
  interactionRevision: string;
  targetId: string;
  runId: string;
}

export interface SessionTaskDefinitionV1 {
  taskId: string;
  title?: string;
  targets: string[];
  toolId?: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  failureCriteria: string[];
  required: true;
}

export type TaskLedgerOwnerV2 =
  | ({
      kind: 'goal';
      confirmedPlanRef: string;
    } & SessionGoalRefV1 & {
      planId: string;
    })
  | {
      kind: 'run';
      runId: string;
      planId: string;
    };

export type TaskSettlementV2 =
  | {
      kind: 'kernelFacts';
      outcome: 'completed';
      kernelFactRefs: SessionKernelFactRefV1[];
    }
  | {
      kind: 'userDecision';
      outcome: 'skipped' | 'acceptedIncomplete';
      interaction: SessionGoalInteractionRefV1;
      decisionEventRef: string;
    }
  | {
      kind: 'deterministicCriterion';
      outcome: 'completed';
      validatorId: string;
      validatorVersion: string;
      evidenceRefs: string[];
    };

export type TaskFailureV2 =
  | {
      kind: 'kernelFacts';
      reason: string;
      kernelFactRefs: SessionKernelFactRefV1[];
    }
  | {
      kind: 'sessionInvariant';
      reason: string;
      sourceRefs: string[];
    };

export interface TaskLedgerEntryV2 extends SessionTaskDefinitionV1 {
  status: 'pending' | 'active' | 'settled' | 'failed';
  settlement?: TaskSettlementV2;
  failure?: TaskFailureV2;
}

export interface TaskLedgerSnapshotV2 {
  schemaVersion: 'deepcode.session.task-ledger.v2';
  owner: TaskLedgerOwnerV2;
  revision: number;
  taskOrder: string[];
  currentTaskId?: string;
  settledTaskIds: string[];
  failedTaskIds: string[];
  pendingTaskIds: string[];
  entries: TaskLedgerEntryV2[];
  sourceRefs: string[];
}

export type GoalStepOutcomeV1 =
  | 'continue'
  | 'suspend'
  | 'complete'
  | 'fail';

export type SessionGoalActiveWaitKindV1 =
  | 'requirement'
  | 'plan'
  | 'review'
  | 'userDecision'
  | 'userAcceptance'
  | 'scopeChange'
  | 'replan'
  | 'budget'
  | 'persistence'
  | 'permission'
  | 'cleanup'
  | 'indeterminate'
  | 'checkpointRequired';

export interface SessionGoalActiveWaitV1 {
  schemaVersion: 'deepcode.session.active-wait.v1';
  waitId: string;
  kind: SessionGoalActiveWaitKindV1;
  source: 'session' | 'kernel';
  reason: string;
  resumable: boolean;
  createdAt: string;
  sourceRefs: string[];
}

export interface ExecutionBudgetCoreV1 {
  schemaVersion: 'deepcode.session.execution-budget-core.v1';
  steps: number;
  providerCalls: number;
  activeTimeMs: number;
  consecutiveRetryCount: number;
  lastStep: {
    callerRequestId: string;
    outcome: GoalStepOutcomeV1;
    reason: string;
    startedAt: string;
    completedAt: string;
  };
  sourceRefs: string[];
}

export interface SessionGoalAnalysisRecordRefV1 {
  schemaVersion: 'deepcode.session.analysis-record-ref.v1';
  recordId: string;
  analysisSeq: number;
  recordDigest: string;
  payloadDigest: string;
  providerRequestId: string;
  toolCallId: string;
  proposalId: string;
  proposalDigest: string;
}

export interface SessionGoalKernelEffectRefV1 {
  requestId: string;
  contractId: string;
  contractHash?: string;
  workUnitIds: string[];
  kernelFactRefs: string[];
}

export interface SessionGoalPendingEffectV1 {
  schemaVersion: 'deepcode.session.pending-effect.v1';
  effectId: string;
  kind: 'kernelAction';
  state: 'prepared' | 'dispatched' | 'observed';
  semanticRef: SessionGoalAnalysisRecordRefV1;
  runId: string;
  planId: string;
  taskId: string;
  actionIds: string[];
  kernel?: SessionGoalKernelEffectRefV1;
  sourceRefs: string[];
}

export interface GoalCheckpointV1 extends SessionGoalRefV1 {
  schemaVersion: 'deepcode.session.goal-checkpoint.v1';
  checkpointRef: string;
  sequence: number;
  sessionId: string;
  lifecycle: Exclude<
    SessionGoalLifecycleV1,
    'draft' | 'awaitingPlanAcceptance'
  >;
  taskLedgerRef: {
    factRef: string;
    revision: number;
    stateDigest: string;
  };
  activeWaitRef?: {
    factRef: string;
    waitId: string;
  };
  languageRef: {
    revision: number;
    status: ConversationLanguagePolicyStatus;
    sourceTurnId: string;
    turnAuthorityRef: string;
  };
  contextRefs: string[];
  pendingEffect?: SessionGoalPendingEffectV1;
  lastKernelFactRef?: string;
  sourceRefs: string[];
  createdAt: string;
  stateDigest: string;
}

export interface SessionGoalFactBaseV1 extends SessionGoalRefV1 {
  schemaVersion: 'deepcode.session.goal-fact.v1';
  lifecycle: SessionGoalLifecycleV1;
  objective: string;
  sourceRefs: string[];
  command: SessionGoalCommandIdentityV1;
  lineage: SessionFactLineageV1;
}

export type SessionGoalFactPayloadV1 =
  | (SessionGoalFactBaseV1 & {
      factKind: 'draftCreated';
      lifecycle: 'draft';
      planRevision: 0;
      sourceRunId: string;
      predecessorGoalRef?: SessionGoalRefV1;
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'planAwaitingAcceptance';
      lifecycle: 'awaitingPlanAcceptance';
      planId: string;
      planRevision: number;
      sourceRunId: string;
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'planRevisionRequested';
      lifecycle: 'awaitingPlanAcceptance';
      planId: string;
      planRevision: number;
      sourceRunId: string;
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'activated';
      lifecycle: 'running';
      planId: string;
      planRevision: number;
      confirmedPlanRef: string;
      authorizationFactRef: string;
      sourceRunId: string;
      taskSnapshot: SessionTaskDefinitionV1[];
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'suspended';
      lifecycle: 'suspended';
      waitRef: string;
      sourceRunId: string;
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'resumed';
      lifecycle: 'running';
      checkpointRef: string;
      sourceRunId: string;
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'completed' | 'failed' | 'cancelled';
      lifecycle: 'completed' | 'failed' | 'cancelled';
      sourceRunId: string;
      terminalReason: string;
      checkpointRef?: string;
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'taskLedger';
      lifecycle: 'running' | 'suspended';
      taskLedger: TaskLedgerSnapshotV2;
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'activeWait';
      lifecycle: 'suspended';
      activeWait: SessionGoalActiveWaitV1;
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'checkpoint';
      lifecycle: 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
      checkpoint: GoalCheckpointV1;
    })
  | (SessionGoalFactBaseV1 & {
      factKind: 'budgetUsage';
      lifecycle: 'running' | 'suspended';
      executionBudget: ExecutionBudgetCoreV1;
    });

export type SessionGoalSlotExpectationV1 =
  | {
      state: 'empty';
    }
  | ({
      state: 'active';
      lifecycle: Exclude<
        SessionGoalLifecycleV1,
        'completed' | 'failed' | 'cancelled'
      >;
    } & SessionGoalRefV1);

export type SessionGoalSlotSnapshotV1 =
  | {
      capability: 'goalSlotV1';
      state: 'empty';
      lastTerminalGoalRef?: SessionGoalRefV1 & {
        lifecycle: 'completed' | 'failed' | 'cancelled';
        factRef: string;
      };
    }
  | ({
      capability: 'goalSlotV1';
      state: 'active';
      lifecycle: Exclude<
        SessionGoalLifecycleV1,
        'completed' | 'failed' | 'cancelled'
      >;
      factRef: string;
    } & SessionGoalRefV1);

export type SessionGoalEffectV1 =
  | ({
      kind: 'open';
      lifecycle: 'draft';
      factRef: string;
    } & SessionGoalRefV1)
  | ({
      kind: 'transition';
      fromLifecycle: Exclude<
        SessionGoalLifecycleV1,
        'completed' | 'failed' | 'cancelled'
      >;
      toLifecycle: Exclude<
        SessionGoalLifecycleV1,
        'completed' | 'failed' | 'cancelled'
      >;
      factRef: string;
    } & SessionGoalRefV1)
  | ({
      kind: 'release';
      lifecycle: 'completed' | 'failed' | 'cancelled';
      factRef: string;
    } & SessionGoalRefV1);

export type GoalProjectionAvailabilityV1<T> =
  | {
      status: 'notAvailable';
    }
  | {
      status: 'available';
      value: T;
    };

export interface GoalProjectionV1 extends SessionGoalRefV1 {
  schemaVersion: 'deepcode.session.goal-projection.v1';
  sessionId: string;
  lifecycle: SessionGoalLifecycleV1;
  objective: string;
  predecessorGoalRef?: SessionGoalRefV1;
  sourceDomainHead: SessionDomainHeadV1;
  conversationRef: {
    revision: number;
    sourceEventVersion: number;
  };
  pendingInteraction?: SessionGoalInteractionRefV1;
  task: GoalProjectionAvailabilityV1<{
    currentTaskId?: string;
    settled: number;
    total: number;
  }>;
  activeWait: GoalProjectionAvailabilityV1<SessionGoalActiveWaitV1 | null>;
  checkpoint: GoalProjectionAvailabilityV1<{
    sequence: number;
    checkpointRef: string;
  }>;
  executionBudget: GoalProjectionAvailabilityV1<ExecutionBudgetCoreV1>;
  terminal?: {
    status: 'completed' | 'failed' | 'cancelled';
    factRef: string;
    reason: string;
  };
  factRefs: string[];
  sourceRefs: string[];
}

export interface SessionGoalCommandReceiptV1 {
  schemaVersion: 'deepcode.session.goal-command-receipt.v1';
  sessionId: string;
  operation:
    | 'start'
    | 'resolveInteraction'
    | 'advance'
    | 'resume'
    | 'cancel'
    | 'read';
  callerRequestId?: string;
  requestDigest?: string;
  idempotent: boolean;
  goalId?: string;
  goalRevision?: number;
  sourceDomainHead: SessionDomainHeadV1;
  projection: GoalProjectionV1 | null;
  hostRunId?: string;
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
  | 'editBatchQueued'
  | 'editFileStarted'
  | 'editFileCompleted'
  | 'editFileFailed'
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
  workUnitIds?: string[];
  resourcePacketIds?: string[];
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
  settlementKind?:
    | 'kernelCompleted'
    | 'sessionEvidenceSatisfied'
    | 'userSkipped'
    | 'userAcceptedIncomplete'
    | 'failed';
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

export interface AgentTimelinePermissionRequestView {
  id: string;
  runId?: string;
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
  kind: 'requirement' | 'plan' | 'permission' | 'review';
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
      kind: 'review';
      runId: string;
      reviewId: string;
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
      kind: 'requirement';
      runId: string;
      requirementId: string;
      blockId?: string;
      title?: string;
      summary?: string;
      decisionRequest?: AgentTimelineDecisionRequest;
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
  attachments?: AgentContextAttachment[];
  feedbackRef?: {
    eventId: string;
    sessionId: string;
    kind: AgentEventKind;
  };
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
  settlement?: {
    schemaVersion: 'deepcode.session.turn-settlement.v1';
    status: 'waiting' | 'completed' | 'failed' | 'cancelled';
    factRef: string;
    turnAuthorityRef: string;
  };
  executionEvidence?: {
    kind: 'notRequired' | 'kernelFactBacked';
    sourceFactRef: string;
    taskClaims: Array<{
      taskId: string;
      workUnitIds: string[];
      factRefs: string[];
    }>;
  };
  blocks: AgentTimelineBlock[];
}

export interface AgentTimelineResult {
  schemaVersion: 'deepcode.shared-conversation-projection.v2';
  sessionId: string;
  revision: number;
  sourceEventVersion: number;
  lastDeltaSeq: number;
  generatedAt: string;
  turns: AgentTimelineTurn[];
  eventCount: number;
  taskProjection?: AgentTimelineTaskProjection;
  interactionProjection?: AgentTimelineInteractionProjection;
  runProjection?: AgentTimelineRunProjection;
  tokenUsageProjection?: AgentTimelineTokenUsageProjection;
  workspaceProjection?: AgentTimelineWorkspaceProjection;
}

/**
 * Read-only compatibility shape for snapshots produced before Shared
 * Projection v2. Hosts must normalize this shape before rendering and must not
 * submit decisions from legacy blocks because they have no durable interaction
 * revision token.
 */
export interface LegacyAgentTimelineBlockV1
  extends Omit<
    AgentTimelineBlock,
    'durability' | 'entryRole' | 'provenance' | 'languageBinding'
  > {
  durability?: AgentTimelineDurability;
  entryRole?: AgentTimelineEntryRole;
  provenance?: AgentTimelineProvenance;
  languageBinding?: AgentTimelineLanguageBinding;
  events: AgentEvent[];
}

export interface LegacyAgentTimelineTurnV1 extends Omit<AgentTimelineTurn, 'blocks'> {
  blocks: LegacyAgentTimelineBlockV1[];
}

export interface LegacyAgentTimelineResultV1
  extends Omit<
    AgentTimelineResult,
    'schemaVersion' | 'turns' | 'runProjection' | 'revision' | 'sourceEventVersion' | 'lastDeltaSeq'
  > {
  schemaVersion: 'deepcode.session.timeline.v1';
  revision?: number;
  sourceEventVersion?: number;
  lastDeltaSeq?: number;
  turns: LegacyAgentTimelineTurnV1[];
}

export type AgentTimelineSnapshot = AgentTimelineResult | LegacyAgentTimelineResultV1;

export interface AgentTimelineDeltaBase {
  schemaVersion: 'deepcode.shared-conversation-projection-delta.v2';
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
  status: Extract<AgentTimelineStatus, 'completed' | 'waiting' | 'failed' | 'blocked' | 'cancelled'>;
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

export interface SubmitAgentRunGuidanceRequest {
  guidance: string;
  attachments?: AgentContextAttachment[];
  hostLanguage?: ConversationLanguage;
  baseHead: SessionDomainHeadV1;
  turnAuthorityRef: string;
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

export interface SessionDomainHeadV1 {
  schemaVersion: 'deepcode.session.domain-head.v1';
  headRevision: number;
  eventVersion: number;
  headDigest: string;
}

export type SessionDomainStorageFormatV1 =
  | 'domainBatchV1'
  | 'legacyRawEventsV1'
  | 'mixed'
  | 'invalid';

export type SessionAppendReadOnlyReasonV1 =
  | 'legacyFormat'
  | 'mixedFormat'
  | 'invalidRecord'
  | 'recoveryRequired';

export type SessionAppendWriteabilityV1 =
  | {
      schemaVersion: 'deepcode.session.append-writeability.v1';
      status: 'writable';
      format: 'domainBatchV1';
    }
  | {
      schemaVersion: 'deepcode.session.append-writeability.v1';
      status: 'readOnly';
      format: SessionDomainStorageFormatV1;
      reason: SessionAppendReadOnlyReasonV1;
    };

export type SessionRunFenceStateV1 = 'open' | 'closing' | 'closed';

export type SessionRunFenceExpectationV1 =
  | {
      state: 'open';
      revision: number;
    }
  | {
      state: 'closing' | 'closed';
      revision: number;
      ownerBatchId: string;
    };

export type SessionRunFenceSnapshotV1 =
  | {
      runId: string;
      state: 'open';
      revision: number;
    }
  | {
      runId: string;
      state: 'closing' | 'closed';
      revision: number;
      ownerBatchId: string;
    };

export interface SessionInteractionIdentityV1 {
  interactionId: string;
  interactionRevision: string;
  targetId: string;
}

export type SessionInteractionExpectationV1 =
  | {
      state: 'open';
    }
  | {
      state: 'claimed';
      claimBatchId: string;
    };

export type SessionInteractionFenceSnapshotV1 =
  SessionInteractionIdentityV1 & SessionInteractionExpectationV1;

export interface SessionDomainStateSnapshotV1 {
  schemaVersion: 'deepcode.session.domain-state-snapshot.v1';
  head: SessionDomainHeadV1;
  runFences: SessionRunFenceSnapshotV1[];
  interactionFences: SessionInteractionFenceSnapshotV1[];
  /**
   * Current writers always return this capability. It remains optional in the
   * structural type so read-only v1 fixtures and legacy snapshots can be
   * decoded and then rejected by Goal admission rather than failing JSON
   * decoding before a diagnostic can be produced.
   */
  goalSlot?: SessionGoalSlotSnapshotV1;
}

export type SessionAppendPreconditionV1 =
  | {
      kind: 'runFence';
      runId: string;
      expected: SessionRunFenceExpectationV1;
    }
  | {
      kind: 'turnAuthority';
      eventId: string;
    }
  | {
      kind: 'goalSlot';
      expected: SessionGoalSlotExpectationV1;
    }
  | ({
      kind: 'interaction';
      expected: SessionInteractionExpectationV1;
    } & SessionInteractionIdentityV1);

export type SessionAppendEventTransitionV1 =
  | {
      kind: 'append';
      intent: 'openRun';
      runId: string;
    }
  | {
      kind: 'append';
      intent: 'bootstrapRun';
      runId: string;
      bootstrapAdmissionId: string;
      turnAuthorityRef: string;
    }
  | {
      kind: 'append';
      intent: 'bootstrapGoalRun';
      runId: string;
      bootstrapAdmissionId: string;
      turnAuthorityRef: string;
    }
  | {
      kind: 'append';
      intent: 'domainFacts';
      runId: string;
      turnAuthorityRef: string;
    }
  | {
      kind: 'append';
      intent: 'guidance';
      runId: string;
      turnAuthorityRef: string;
    }
  | ({
      kind: 'append';
      intent: 'interactionSettlement';
      runId: string;
      claimBatchId: string;
    } & SessionInteractionIdentityV1)
  | ({
      kind: 'append';
      intent: 'releaseInteractionClaim';
      runId: string;
      claimBatchId: string;
    } & SessionInteractionIdentityV1);

export type SessionInteractionEffectV1 =
  | ({
      kind: 'open';
    } & SessionInteractionIdentityV1)
  | ({
      kind: 'settle';
      claimBatchId: string;
    } & SessionInteractionIdentityV1)
  | ({
      kind: 'release';
      claimBatchId: string;
    } & SessionInteractionIdentityV1);

export type SessionClaimTransitionV1 = {
  kind: 'claim';
  claimantRunId: string;
  decisionRequestId: string;
} & SessionInteractionIdentityV1;

export type SessionCloseTerminalTransitionV1 = {
  kind: 'close';
  phase: 'terminal';
  runId: string;
  interactionEffect?: SessionInteractionEffectV1;
} & (
  | {
      status: 'cancelled';
      parentCloseBatchId: string;
    }
  | {
      status: 'completed' | 'failed' | 'waiting';
      parentCloseBatchId?: never;
    }
);

export type SessionCloseTransitionV1 =
  | {
      kind: 'close';
      phase: 'request';
      runId: string;
      status: 'cancelRequested';
      interactionEffect?: SessionInteractionEffectV1;
    }
  | SessionCloseTerminalTransitionV1;

export type SessionAppendTransitionV1 =
  | (SessionAppendEventTransitionV1 & {
      goalEffect?: SessionGoalEffectV1;
    })
  | (SessionClaimTransitionV1 & {
      goalEffect?: SessionGoalEffectV1;
    })
  | (SessionCloseTransitionV1 & {
      goalEffect?: SessionGoalEffectV1;
    });

export interface SessionAppendCommandV1 {
  schemaVersion: 'deepcode.session.append-command.v1';
  batchId: string;
  baseHead: SessionDomainHeadV1;
  preconditions: SessionAppendPreconditionV1[];
  transition: SessionAppendTransitionV1;
  events: AgentEvent[];
  timeline?: AgentTimelineResult;
  providerAdmissions: SessionProviderAdmissionMetadataV1[];
  /**
   * One-use transport capability for a new bootstrapRun. It is validated by
   * the Daemon but excluded from the durable batch record and every digest.
   */
  bootstrapToken?: string;
}

export interface SessionProjectionCommitAckV1 {
  schemaVersion: 'deepcode.session.projection-commit-ack.v1';
  revision: number;
  sourceEventVersion: number;
  projectionDigest: string;
}

export interface SessionAppendReceiptV1 {
  schemaVersion: 'deepcode.session.append-receipt.v1';
  sessionId: string;
  batchId: string;
  serverDigest: string;
  baseHead: SessionDomainHeadV1;
  resultState: SessionDomainStateSnapshotV1;
  idempotent: boolean;
  projectionAck?: SessionProjectionCommitAckV1;
  committedAt: string;
}

export type AppendAgentEventsRequest = SessionAppendCommandV1;

export type SessionAppendErrorCodeV1 =
  | 'session_append_legacy_read_only'
  | 'session_append_batch_conflict'
  | 'session_append_head_conflict'
  | 'session_append_precondition_failed'
  | 'session_append_transition_invalid'
  | 'session_append_lineage_invalid'
  | 'session_append_recovery_required';

interface SessionAppendErrorDetailsBaseV1 {
  schemaVersion: 'deepcode.session.append-error-details.v1';
  code: SessionAppendErrorCodeV1;
  sessionId: string;
  reason: string;
}

export type SessionAppendErrorDetailsV1 =
  | (SessionAppendErrorDetailsBaseV1 & {
      code: 'session_append_legacy_read_only';
      writeability: SessionAppendWriteabilityV1;
    })
  | (SessionAppendErrorDetailsBaseV1 & {
      code: 'session_append_batch_conflict';
      batchId: string;
      existingBatchDigest: string;
      submittedBatchDigest: string;
      currentHead: SessionDomainHeadV1;
    })
  | (SessionAppendErrorDetailsBaseV1 & {
      code: 'session_append_head_conflict';
      batchId: string;
      expectedHead: SessionDomainHeadV1;
      currentHead: SessionDomainHeadV1;
    })
  | (SessionAppendErrorDetailsBaseV1 & {
      code: 'session_append_precondition_failed';
      batchId: string;
      currentHead: SessionDomainHeadV1;
      preconditionIndex: number;
      failedPrecondition: SessionAppendPreconditionV1;
    })
  | (SessionAppendErrorDetailsBaseV1 & {
      code: 'session_append_transition_invalid';
      batchId: string;
      currentHead: SessionDomainHeadV1;
      transition: SessionAppendTransitionV1;
    })
  | (SessionAppendErrorDetailsBaseV1 & {
      code: 'session_append_lineage_invalid';
      batchId: string;
      currentHead: SessionDomainHeadV1;
      eventId?: string;
    })
  | (SessionAppendErrorDetailsBaseV1 & {
      code: 'session_append_recovery_required';
      currentHead?: SessionDomainHeadV1;
      writeability: SessionAppendWriteabilityV1;
    });

interface AgentSessionResultBase {
  session: AgentSession;
  events: AgentEvent[];
}

export type AgentSessionResult = AgentSessionResultBase &
  (
    | {
        appendWriteability: Extract<
          SessionAppendWriteabilityV1,
          { status: 'writable'; format: 'domainBatchV1' }
        >;
        domainState: SessionDomainStateSnapshotV1;
        appendReceipt?: SessionAppendReceiptV1;
      }
    | {
        appendWriteability: {
          schemaVersion: 'deepcode.session.append-writeability.v1';
          status: 'readOnly';
          format: 'legacyRawEventsV1';
          reason: 'legacyFormat';
        };
        domainState?: never;
        appendReceipt?: never;
      }
  );
