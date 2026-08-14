import {
  decodeRawToolArgumentsV2,
  type CapabilityScopePreviewRecordV2,
  type KernelFactProjectionV2,
  type ToolIntentV2,
  type ToolContextBundleV2,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  createSessionKernelLineageStateV2,
  registerSessionOperationPlanActionLineageV2,
  registerSessionPlanActionLineageV2,
  type SessionKernelLineageStateV2,
} from './lineage.js';
import {
  createSessionToolContextStateV2,
  toolContextRefV2,
  type SessionToolContextStateV2,
  validateSessionToolContextStateV2,
} from './toolContext.js';
import {
  decodeUserAttachmentContextsV1,
  validateAgentInputAttachmentsV3,
} from './inputAttachmentsV2.js';
import {
  validateSessionContextMemoryV2,
  type SessionContextMemoryV2,
} from './sessionMemory.js';
import {
  abortSessionProviderToolCallQueueV2,
  isExactSessionProviderOutcomeRecordV2,
  validateSessionProviderToolCallQueueV2,
  type SessionProviderToolCallQueueV2,
} from './providerToolCallQueue.js';
import {
  SESSION_KERNEL_CHECKPOINT_V2_SCHEMA,
  SESSION_KERNEL_LOOP_V2_SCHEMA,
  type SessionActiveWaitV2,
  type SessionKernelFactBarrierV2,
  type SessionFinalAnswerStateV3,
  type SessionInterventionResearchV4,
  type SessionTerminalAnswerCandidateV1,
  type SessionOperationPlanActionBindingV2,
  type SessionKernelPublicRequestRecordV2,
  type SessionKernelReviewV2,
  type SessionRunCancellationV2,
  type SessionNaturalLanguagePlanV2,
  type SessionPlanConfirmationAuthorityV2,
  type SessionPlanConfirmationProjectionRefV2,
  type SessionPlanDecisionV2,
  type SessionProviderTurnRecordV2,
  type SessionProviderOutcomeRecordV2,
  type SessionProviderProfileBootstrapV2,
  type SessionPlanActionSettlementV2,
  type SessionReviewFactAccumulatorV2,
  type SessionUserInputRecordV2,
  type SessionUserInterventionDecisionV4,
  type SessionUserInterventionV4,
  type SessionWorkAuthorityV3,
} from './types.js';

const MAX_SESSION_INPUT_HISTORY_COUNT = 32;
const MAX_SESSION_INPUT_HISTORY_BYTES = 512 * 1024;
const MAX_SESSION_PROVIDER_OUTCOME_COUNT = 128;
const MAX_SESSION_PROVIDER_OUTCOME_BYTES = 256 * 1024;
const MAX_SESSION_PLAN_ACTIONS = 128;
const MAX_SESSION_PLAN_BYTES = 512 * 1024;
// One PlanAction drive admits at most 256 Provider calls. The per-Plan ceiling
// covers 256 actions at the default 32-call budget without allowing the
// theoretical 65,536-entry Cartesian worst case into every checkpoint.
const MAX_SESSION_OPERATIONS_PER_PLAN_ACTION = 256;
const MAX_SESSION_OPERATION_PLAN_BINDINGS = 8_192;

export interface SessionKernelLoopStateV2 {
  schemaVersion: typeof SESSION_KERNEL_LOOP_V2_SCHEMA;
  runId: string;
  workspaceBindingDigest: string;
  sessionMemory: SessionContextMemoryV2;
  providerProfile: SessionProviderProfileBootstrapV2;
  controlEpoch: number;
  currentInputId: string;
  inputs: SessionUserInputRecordV2[];
  inputHistoryOmittedCount: number;
  pendingEpochInput?: SessionUserInputRecordV2;
  projectedInputIds: string[];
  toolContext: SessionToolContextStateV2;
  workAuthority?: SessionWorkAuthorityV3;
  plan?: SessionNaturalLanguagePlanV2;
  planConfirmation?: SessionPlanConfirmationAuthorityV2;
  planDecision?: SessionPlanDecisionV2;
  interventionResearch?: SessionInterventionResearchV4;
  userIntervention?: SessionUserInterventionV4;
  userInterventionDecision?: SessionUserInterventionDecisionV4;
  projectedPlanRevision?: string;
  projectedPlanDecisionKey?: string;
  lineage: SessionKernelLineageStateV2;
  previews: Record<string, CapabilityScopePreviewRecordV2>;
  factsById: Record<string, KernelFactProjectionV2>;
  factHistoryOmittedCount: number;
  reviewFacts: SessionReviewFactAccumulatorV2;
  activeWait?: SessionActiveWaitV2;
  pendingGuidance: string[];
  providerTurn?: SessionProviderTurnRecordV2;
  providerToolCallQueue?: SessionProviderToolCallQueueV2;
  providerOutcomes: SessionProviderOutcomeRecordV2[];
  providerOutcomeHistoryOmittedCount: number;
  planActionSettlements: Record<string, SessionPlanActionSettlementV2>;
  operationPlanActionBindings: Record<
    string,
    SessionOperationPlanActionBindingV2
  >;
  factBarriers: Record<string, SessionKernelFactBarrierV2>;
  publicRequests: Partial<
    Record<
      SessionKernelPublicRequestRecordV2['lane'],
      SessionKernelPublicRequestRecordV2
    >
  >;
  /** Highest immutable Review revision ever allocated in this Run. */
  lastReviewRevision: number;
  review?: SessionKernelReviewV2;
  finalAnswer?: SessionFinalAnswerStateV3;
  terminalAnswerCandidate?: SessionTerminalAnswerCandidateV1;
  runCancellation?: SessionRunCancellationV2;
  kernelWakeHint: boolean;
  checkpointRevision: number;
}

interface SessionInterventionCandidateDigestOptionV4 {
  optionId: string;
  kind: 'executable' | 'guidanceOnly';
  title: string;
  description: string;
  tradeoffs: string[];
  recommended: boolean;
  candidatePlan?: SessionNaturalLanguagePlanV2;
}

export function sessionUserInterventionCandidateSetDigestV4(input: {
  researchId: string;
  evidenceProgressDigest: string;
  guidanceRevision: number;
  problemSummary: string;
  recommendation?: string;
  relevantFactRefs: string[];
  affectedPlanActionIds: string[];
  options: readonly SessionInterventionCandidateDigestOptionV4[];
}): string {
  return sha256Hash(canonicalJson({
    researchId: input.researchId,
    evidenceProgressDigest: input.evidenceProgressDigest,
    guidanceRevision: input.guidanceRevision,
    proposal: {
      problemSummary: input.problemSummary,
      ...(input.recommendation
        ? { recommendation: input.recommendation }
        : {}),
      relevantFactRefs: [...input.relevantFactRefs].sort(),
      affectedPlanActionIds: [...input.affectedPlanActionIds].sort(),
      options: input.options.map((option) => ({
        optionId: option.optionId,
        kind: option.kind,
        title: option.title,
        description: option.description,
        tradeoffs: [...option.tradeoffs],
        recommended: option.recommended,
        ...(option.candidatePlan
          ? {
              candidatePlan: {
                title: option.candidatePlan.title,
                objective: option.candidatePlan.objective,
                narrative: option.candidatePlan.narrative,
                evidence: option.candidatePlan.evidence,
                predecessorPlanRef:
                  option.candidatePlan.predecessorPlanRef,
                carriedSettlementRefs:
                  option.candidatePlan.carriedSettlementRefs,
                actions: option.candidatePlan.actions.map((action) => ({
                  toolId: action.manifest.toolId,
                  scopeIntent: action.manifest.scopeIntent,
                  deadline: action.deadline,
                })),
              },
            }
          : {}),
      })),
    },
  }));
}

export function sessionInterventionEvidenceProgressDigestV4(
  state: SessionKernelLoopStateV2,
  triggerCandidateSetDigest: string,
  plan: SessionNaturalLanguagePlanV2 | undefined = state.plan
): string {
  if (!plan) {
    throw new SessionKernelStateError(
      'session_kernel_intervention_plan_missing',
      'Intervention evidence progress requires the exact predecessor Plan.'
    );
  }
  const unsettledPlanActionIds = plan.actions
    .filter((action) =>
      !state.planActionSettlements[action.manifest.planActionId]
    )
    .map((action) => action.manifest.planActionId);
  return sha256Hash(canonicalJson({
    snapshotHighWater: state.lineage.cursor.snapshotHighWater,
    facts: Object.values(state.factsById)
      .sort((left, right) =>
        left.ledgerSequence - right.ledgerSequence
        || left.factId.localeCompare(right.factId)
      )
      .map((fact) => ({
        factId: fact.factId,
        ledgerSequence: fact.ledgerSequence,
        factKind: fact.factKind,
        resourceIds: fact.lineage.resourceIds,
        detailsDigest: sha256Hash(canonicalJson(fact.details)),
      })),
    planRevision: plan.planRevision,
    unsettledPlanActionIds,
    triggerCandidateSetDigest,
  }));
}

export interface SessionKernelCheckpointV2 {
  schemaVersion: typeof SESSION_KERNEL_CHECKPOINT_V2_SCHEMA;
  checkpointRevision: number;
  savedAt: string;
  state: SessionKernelLoopStateV2;
}

/**
 * RunOpen-owned material that is intentionally not copied into the compact
 * checkpoint wire. The persistence adapter uses it only to rebuild the full
 * in-memory Loop state after all immutable refs have been verified.
 */
export interface SessionKernelCheckpointRecoveryInputV3 {
  workspaceBindingDigest: string;
  sessionMemory: SessionContextMemoryV2;
  providerProfile: SessionProviderProfileBootstrapV2;
  toolContext: ToolContextBundleV2;
}

export interface SessionKernelInitialStateV2 {
  runId: string;
  workspaceBindingDigest: string;
  controlEpoch: number;
  initialInput: SessionUserInputRecordV2;
  toolContext: ToolContextBundleV2;
  sessionMemory: SessionContextMemoryV2;
  providerProfile: SessionProviderProfileBootstrapV2;
}

export function createSessionKernelLoopStateV2(
  initial: SessionKernelInitialStateV2
): SessionKernelLoopStateV2 {
  positiveEpoch(initial.controlEpoch);
  validateUserInput(initial.initialInput);
  validateSessionContextMemoryV2(initial.sessionMemory);
  validateProviderProfile(initial.providerProfile);
  return {
    schemaVersion: SESSION_KERNEL_LOOP_V2_SCHEMA,
    runId: requiredIdentity(initial.runId, 'runId'),
    workspaceBindingDigest: requiredIdentity(
      initial.workspaceBindingDigest,
      'workspaceBindingDigest'
    ),
    sessionMemory: cloneJson(initial.sessionMemory),
    providerProfile: cloneJson(initial.providerProfile),
    controlEpoch: initial.controlEpoch,
    currentInputId: initial.initialInput.inputId,
    inputs: [cloneJson(initial.initialInput)],
    inputHistoryOmittedCount: 0,
    projectedInputIds: [],
    toolContext: createSessionToolContextStateV2(initial.toolContext),
    lineage: createSessionKernelLineageStateV2(initial.runId),
    previews: {},
    factsById: {},
    factHistoryOmittedCount: 0,
    reviewFacts: createSessionReviewFactAccumulatorV2(
      initial.controlEpoch,
      0
    ),
    pendingGuidance: [],
    providerOutcomes: [],
    providerOutcomeHistoryOmittedCount: 0,
    planActionSettlements: {},
    operationPlanActionBindings: {},
    factBarriers: {},
    publicRequests: {},
    lastReviewRevision: 0,
    kernelWakeHint: false,
    checkpointRevision: 0,
  };
}

export function restoreSessionKernelLoopStateV2(
  checkpoint: SessionKernelCheckpointV2,
  expected: {
    runId: string;
    workspaceBindingDigest: string;
    sessionMemory: SessionContextMemoryV2;
    providerProfile: SessionProviderProfileBootstrapV2;
  }
): SessionKernelLoopStateV2 {
  if (checkpoint.schemaVersion !== SESSION_KERNEL_CHECKPOINT_V2_SCHEMA) {
    throw new SessionKernelStateError(
      'session_kernel_checkpoint_schema_unsupported',
      'Session Kernel checkpoint schema is unsupported.'
    );
  }
  const state = cloneSessionKernelLoopStateV2(checkpoint.state);
  if (
    state.schemaVersion !== SESSION_KERNEL_LOOP_V2_SCHEMA
    || state.runId !== expected.runId
    || state.workspaceBindingDigest !== expected.workspaceBindingDigest
    || JSON.stringify(state.sessionMemory)
      !== JSON.stringify(expected.sessionMemory)
    || JSON.stringify(state.providerProfile)
      !== JSON.stringify(expected.providerProfile)
  ) {
    throw new SessionKernelStateError(
      'session_kernel_checkpoint_identity_mismatch',
      'Session Kernel checkpoint does not match the active Kernel run.'
    );
  }
  positiveEpoch(state.controlEpoch);
  validateSessionContextMemoryV2(state.sessionMemory);
  validateProviderProfile(state.providerProfile);
  validateSessionToolContextStateV2(state.toolContext);
  state.inputs.forEach(validateUserInput);
  currentSessionUserInputV2(state);
  state.inputHistoryOmittedCount = nonnegativeSafeInteger(
    state.inputHistoryOmittedCount ?? 0,
    'inputHistoryOmittedCount'
  );
  const boundedInputs = boundedInputHistory(
    state.inputs,
    state.currentInputId
  );
  state.inputs = boundedInputs.records;
  state.inputHistoryOmittedCount += boundedInputs.omittedCount;
  if (state.plan) {
    validatePlan(state.plan);
    if (state.plan.inputId !== state.currentInputId) {
      throw new SessionKernelStateError(
        'session_kernel_checkpoint_plan_input_mismatch',
        'Checkpoint Plan does not belong to the current user input.'
      );
    }
  }
  currentSessionPlanScopePreviewsV2(
    state,
    state.plan,
    { requireComplete: false }
  );
  if (state.planDecision) {
    validatePlanDecision(state.planDecision);
    if (state.planDecision.planRevision !== state.plan?.planRevision) {
      throw new SessionKernelStateError(
        'session_kernel_checkpoint_plan_decision_mismatch',
        'Checkpoint Plan decision does not bind the current Plan revision.'
      );
    }
  }
  if (state.planConfirmation) {
    validateSessionPlanConfirmationAuthorityV2(
      state.planConfirmation,
      state
    );
  }
  const interventionAcceptedPlan =
    state.userInterventionDecision?.decision === 'select'
    && state.planDecision?.decision === 'accept'
    && state.planDecision.planRevision === state.plan?.planRevision
    && state.userIntervention?.options.some((option) =>
      option.optionId === state.userInterventionDecision?.optionId
      && option.kind === 'executable'
      && option.candidatePlan?.planRevision === state.plan?.planRevision
    );
  if (
    state.planDecision
    && !state.planConfirmation
    && !interventionAcceptedPlan
  ) {
    throw new SessionKernelStateError(
      'session_kernel_checkpoint_plan_confirmation_missing',
      'A durable Plan decision requires its exact published confirmation authority.'
    );
  }
  validateUserInterventionStateV4(state);
  validateSessionWorkAuthorityV3(state.workAuthority, state);
  state.lastReviewRevision = nonnegativeSafeInteger(
    state.lastReviewRevision,
    'lastReviewRevision'
  );
  if (
    state.review
    && state.review.revision > state.lastReviewRevision
  ) {
    throw new SessionKernelStateError(
      'session_kernel_review_revision_invalid',
      'Current Review revision exceeds the Run-scoped durable Review sequence.'
    );
  }
  validateReviewWorkAuthorityV3(state.review, state);
  state.projectedInputIds = (state.projectedInputIds ?? [])
    .filter((inputId) =>
      state.inputs.some((input) => input.inputId === inputId)
    );
  state.providerOutcomes ??= [];
  if (
    state.providerOutcomes.some((outcome) =>
      !isExactSessionProviderOutcomeRecordV2(
        outcome,
        state.providerProfile.providerProfileId
      )
    )
    || new Set(
      state.providerOutcomes.map((outcome) => outcome.providerTurnId)
    ).size !== state.providerOutcomes.length
  ) {
    throw new SessionKernelStateError(
      'session_kernel_provider_outcome_invalid',
      'Provider outcome history is not exact durable v2 data.'
    );
  }
  state.providerOutcomeHistoryOmittedCount = nonnegativeSafeInteger(
    state.providerOutcomeHistoryOmittedCount ?? 0,
    'providerOutcomeHistoryOmittedCount'
  );
  const boundedOutcomes = boundedProviderOutcomeHistory(
    state.providerOutcomes
  );
  state.providerOutcomes = boundedOutcomes.records;
  state.providerOutcomeHistoryOmittedCount +=
    boundedOutcomes.omittedCount;
  state.planActionSettlements ??= {};
  if (state.providerTurn) {
    validateProviderTurnResponse(
      state.providerTurn,
      [...state.providerOutcomes].reverse().find((outcome) =>
        outcome.providerTurnId === state.providerTurn?.providerTurnId
      )
    );
  }
  if (state.finalAnswer) {
    validateFinalAnswerStateV3(state.finalAnswer, state);
  }
  if (state.terminalAnswerCandidate) {
    validateTerminalAnswerCandidateV1(
      state.terminalAnswerCandidate,
      state
    );
  }
  if (state.providerToolCallQueue) {
    validateSessionProviderToolCallQueueV2(
      state.providerToolCallQueue,
      {
        runId: state.runId,
        controlEpoch: state.controlEpoch,
      }
    );
  }
  if (
    state.providerToolCallQueue?.status === 'active'
    && (
      state.providerTurn?.providerTurnId
        !== state.providerToolCallQueue.providerTurnId
      || state.providerTurn.controlEpoch
        !== state.providerToolCallQueue.controlEpoch
      || canonicalJson(state.providerTurn.target)
        !== canonicalJson(state.providerToolCallQueue.target)
      || state.providerTurn.status !== 'awaitingTools'
      || JSON.stringify(state.providerTurn.response)
        !== JSON.stringify({
          items: state.providerToolCallQueue.orderedItems,
          completion: state.providerToolCallQueue.completion,
        })
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_provider_tool_call_queue_turn_mismatch',
      'Active Provider tool calls do not match the durable Provider turn.'
    );
  }
  if (
    state.providerToolCallQueue?.status === 'active'
    && state.providerTurn?.target.kind === 'planning'
  ) {
    const currentContextRef = toolContextRefV2(
      state.toolContext.bundle
    );
    const contextReadAuthority = state.workAuthority?.kind
      === 'contextRead'
      ? state.workAuthority
      : undefined;
    const readCalls = state.providerToolCallQueue.calls.filter(
      (call) => call.dispatchKind === 'read'
    );
    const mutationCalls = state.providerToolCallQueue.calls.filter(
      (call) => call.dispatchKind === 'mutation'
    );
    const planningQueueInvalid =
      state.providerToolCallQueue.target.kind !== 'planning'
      || (
        state.plan === undefined
        && readCalls.length > 0
        && !contextReadAuthority
      )
      || (
        state.plan !== undefined
        && (
          state.workAuthority?.kind !== 'plan'
          || state.workAuthority.planRevision
            !== state.plan.planRevision
        )
      )
      || readCalls.some((call) => {
        const intent = call.intent;
        if (!intent) return true;
        const descriptor = state.toolContext.bundle.tools.find(
          (tool) => tool.toolId === intent.toolId
        );
        return intent.authority.kind !== 'read'
          || canonicalJson(intent.toolContextRef)
            !== canonicalJson(currentContextRef)
          || descriptor?.availability !== 'ready'
          || descriptor.effectClass !== 'read'
          || (
            state.plan === undefined
            && !contextReadAuthority?.operationIds.includes(
              intent.operationId
            )
          );
      })
      || mutationCalls.some((call) => {
        const candidate = call.candidatePreview;
        const descriptor = candidate
          ? state.toolContext.bundle.tools.find(
              (tool) => tool.toolId === candidate.toolId
            )
          : undefined;
        return !candidate
          || canonicalJson(candidate.toolContextRef)
            !== canonicalJson(currentContextRef)
          || descriptor?.availability !== 'ready'
          || descriptor.effectClass === 'read'
          || call.status === 'submitting'
          || call.status === 'awaitingCapability'
          || call.status === 'awaitingInvocation'
          || call.status === 'completed';
      });
    if (planningQueueInvalid) {
      throw new SessionKernelStateError(
        'session_kernel_provider_tool_call_queue_turn_mismatch',
        'Active planning Provider calls require exact read authority or preview-only mutation discovery bound to the current ToolContext.'
      );
    }
  }
  if (
    state.providerTurn?.status === 'awaitingTools'
    && (
      state.providerToolCallQueue?.status !== 'active'
      || state.providerToolCallQueue.providerTurnId
        !== state.providerTurn.providerTurnId
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_provider_tool_call_turn_queue_missing',
      'Provider turn awaits tools without a matching durable queue.'
    );
  }
  validateOperationPlanActionBindings(
    state.operationPlanActionBindings,
    state
  );
  validateFactBarriers(state.factBarriers);
  if (state.runCancellation) {
    validateRunCancellation(state.runCancellation, state);
  }
  state.factHistoryOmittedCount = nonnegativeSafeInteger(
    state.factHistoryOmittedCount,
    'factHistoryOmittedCount'
  );
  if (
    !state.factsById
    || typeof state.factsById !== 'object'
    || Array.isArray(state.factsById)
    || Object.keys(state.factsById).length > 0
    || state.factHistoryOmittedCount !== 0
  ) {
    throw new SessionKernelStateError(
      'session_kernel_checkpoint_fact_projection_present',
      'Checkpoint must not persist replayable Kernel fact projection state.'
    );
  }
  validateReviewFactAccumulator(state.reviewFacts, state);
  for (const [planActionId, settlement] of Object.entries(
    state.planActionSettlements
  )) {
    validatePlanActionSettlement(settlement);
    if (
      settlement.planActionId !== planActionId
      || settlement.planRevision !== state.plan?.planRevision
      || settlement.controlEpoch !== state.controlEpoch
      || settlement.snapshotHighWater
        > state.lineage.cursor.snapshotHighWater
      || !state.plan?.actions.some(
        (action) =>
          action.manifest.planActionId === planActionId
      )
    ) {
      throw new SessionKernelStateError(
        'session_kernel_plan_action_settlement_mismatch',
        'PlanAction settlement does not bind the current persisted Plan.'
      );
    }
  }
  state.publicRequests ??= {};
  const completedFinalAnswerCandidate =
    state.finalAnswer?.status === 'requesting'
    && state.providerTurn?.purpose === 'finalAnswer'
    && state.providerTurn.providerTurnId
      === state.finalAnswer.providerTurnId
    && state.providerTurn.status === 'active'
    && Boolean(state.providerTurn.dispatchRef)
    && Boolean(state.providerTurn.terminalRef)
    && Boolean(state.providerTurn.response);
  if (
    state.finalAnswer?.status === 'requesting'
    && !completedFinalAnswerCandidate
  ) {
    state.finalAnswer = {
      ...state.finalAnswer,
      status: state.finalAnswer.physicalRequestCount >= 3
        ? 'finalAnswerFailed'
        : 'pending',
      ...(state.finalAnswer.physicalRequestCount >= 3
        ? {
            failedAt: state.providerTurn?.startedAt
              ?? state.finalAnswer.startedAt,
            lastErrorCode:
              'session_kernel_final_answer_recovery_budget_exhausted',
          }
        : {}),
    };
    delete state.finalAnswer.providerTurnId;
    delete state.finalAnswer.startedAt;
    validateFinalAnswerStateV3(state.finalAnswer, state);
  }
  const factReplayAfterLedgerSequence = nonnegativeSafeInteger(
    state.lineage.cursor.afterLedgerSequence,
    'lineage.cursor.afterLedgerSequence'
  );
  state.lineage = rebuildSessionKernelLineageV2(state);
  state.lineage.cursor.afterLedgerSequence =
    factReplayAfterLedgerSequence;
  return state;
}

export function recordSessionPlanV2(
  state: SessionKernelLoopStateV2,
  plan: SessionNaturalLanguagePlanV2
): SessionKernelLoopStateV2 {
  validatePlan(plan);
  if (plan.runId !== state.runId) {
    throw new SessionKernelStateError(
      'session_kernel_plan_run_mismatch',
      'The persisted Plan belongs to a different Kernel run.'
    );
  }
  if (plan.inputId !== state.currentInputId) {
    throw new SessionKernelStateError(
      'session_kernel_plan_input_mismatch',
      'The persisted Plan does not belong to the current user input.'
    );
  }
  if (state.plan && state.plan.planRevision !== plan.planRevision) {
    const expectedPredecessor = {
      planRevision: state.plan.planRevision,
      planDigest: sha256Hash(canonicalJson(state.plan)),
    };
    const expectedCarried = Object.values(state.planActionSettlements)
      .sort((left, right) =>
        left.planActionId.localeCompare(right.planActionId)
      )
      .map((settlement) => ({
        planRevision: settlement.planRevision,
        planActionId: settlement.planActionId,
        settlementDigest: sha256Hash(canonicalJson(settlement)),
        kernelFactRefs: Object.values(state.factsById)
          .filter((fact) =>
            fact.lineage.planActionIds.includes(settlement.planActionId)
          )
          .sort((left, right) =>
            left.ledgerSequence - right.ledgerSequence
            || left.factId.localeCompare(right.factId)
          )
          .map((fact) => fact.factId),
      }));
    if (
      canonicalJson(plan.predecessorPlanRef)
        !== canonicalJson(expectedPredecessor)
      || canonicalJson(plan.carriedSettlementRefs)
        !== canonicalJson(expectedCarried)
    ) {
      throw new SessionKernelStateError(
        'session_kernel_plan_revision_lineage_invalid',
        'A new Plan revision must bind its exact predecessor and every immutable settled action.'
      );
    }
  }
  let next = cloneSessionKernelLoopStateV2(state);
  if (next.plan?.planRevision !== plan.planRevision) {
    next.pendingGuidance = [];
    next.planActionSettlements = {};
    next.operationPlanActionBindings = {};
    next.previews = {};
    next.planDecision = undefined;
    next.planConfirmation = undefined;
    next.projectedPlanDecisionKey = undefined;
    next.lineage.taskPlanActions = {};
    next.lineage.planActions = {};
    next.lineage.operations = {};
    next.lineage.invocations = {};
    next.review = undefined;
    next.terminalAnswerCandidate = undefined;
    if (next.userInterventionDecision?.decision !== 'select') {
      next.interventionResearch = undefined;
      next.userIntervention = undefined;
      next.userInterventionDecision = undefined;
    }
    if (next.finalAnswer) {
      next.finalAnswer = {
        ...next.finalAnswer,
        status: 'stale',
        staleAt: plan.recordedAt,
      };
      delete next.finalAnswer.finalText;
      delete next.finalAnswer.committedAt;
      delete next.finalAnswer.commitKind;
    }
  }
  if (
    next.plan
    && next.plan.planRevision === plan.planRevision
    && JSON.stringify(next.plan) !== JSON.stringify(plan)
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_revision_conflict',
      `Plan revision ${plan.planRevision} already has different content.`
    );
  }
  for (const action of plan.actions) {
    next.lineage = registerSessionPlanActionLineageV2(next.lineage, {
      taskId: action.taskId,
      manifest: action.manifest,
    });
  }
  next.plan = cloneJson(plan);
  next.workAuthority = {
    kind: 'plan',
    planRevision: plan.planRevision,
  };
  return next;
}

export function recordSessionPlanDecisionV2(
  state: SessionKernelLoopStateV2,
  decision: SessionPlanDecisionV2
): SessionKernelLoopStateV2 {
  validatePlanDecision(decision);
  if (!state.plan || state.plan.planRevision !== decision.planRevision) {
    throw new SessionKernelStateError(
      'session_kernel_plan_decision_revision_stale',
      `Plan decision ${decision.planRevision} does not bind the current Plan revision.`
    );
  }
  const next = cloneSessionKernelLoopStateV2(state);
  if (next.planDecision) {
    if (JSON.stringify(next.planDecision) !== JSON.stringify(decision)) {
      throw new SessionKernelStateError(
        'session_kernel_plan_decision_conflict',
        `Plan revision ${decision.planRevision} already has a different durable decision.`
      );
    }
    return next;
  }
  if (!currentSessionPlanConfirmationAuthorityV2(state)) {
    throw new SessionKernelStateError(
      'session_kernel_plan_confirmation_required',
      'A trusted Plan decision requires the exact durable confirmation authority.'
    );
  }
  next.planDecision = cloneJson(decision);
  next.projectedPlanDecisionKey = undefined;
  if (decision.decision === 'reject') {
    next.pendingGuidance = [];
  } else if (decision.decision === 'revise' && decision.guidance) {
    if (!next.pendingGuidance.includes(decision.guidance)) {
      next.pendingGuidance.push(decision.guidance);
    }
  }
  return next;
}

export function recordSessionPlanConfirmationAuthorityV2(
  state: SessionKernelLoopStateV2,
  authority: SessionPlanConfirmationAuthorityV2
): SessionKernelLoopStateV2 {
  validateSessionPlanConfirmationAuthorityV2(authority, state);
  const next = cloneSessionKernelLoopStateV2(state);
  if (
    next.planConfirmation
    && canonicalJson(next.planConfirmation) !== canonicalJson(authority)
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_confirmation_conflict',
      `Plan revision ${authority.planRevision} already has different confirmation authority.`
    );
  }
  next.planConfirmation = cloneJson(authority);
  return next;
}

export function buildSessionPlanConfirmationAuthorityV2(
  state: SessionKernelLoopStateV2,
  input: {
    providerTurnId: string;
    providerResponseDigest: string;
    recordedAt: string;
    commentaryProjection?: SessionPlanConfirmationProjectionRefV2;
    confirmationProjection: SessionPlanConfirmationProjectionRefV2;
  }
): SessionPlanConfirmationAuthorityV2 {
  const plan = state.plan;
  if (!plan) {
    throw new SessionKernelStateError(
      'session_kernel_plan_confirmation_plan_missing',
      'Plan confirmation authority requires the current persisted Plan.'
    );
  }
  const scopePreviews = currentSessionPlanScopePreviewsV2(state, plan);
  const authorityWithoutDigest = {
    planRevision: plan.planRevision,
    providerTurnId: requiredIdentity(
      input.providerTurnId,
      'providerTurnId'
    ),
    providerResponseDigest: requiredDigestV2(
      input.providerResponseDigest,
      'providerResponseDigest'
    ),
    controlEpoch: state.controlEpoch,
    toolContextRef: toolContextRefV2(state.toolContext.bundle),
    planDigest: sha256Hash(canonicalJson(plan)),
    scopePreviewsDigest: sha256Hash(canonicalJson(scopePreviews)),
    recordedAt: input.recordedAt,
    ...(input.commentaryProjection
      ? { commentaryProjection: cloneJson(input.commentaryProjection) }
      : {}),
    confirmationProjection: cloneJson(input.confirmationProjection),
  };
  const authority: SessionPlanConfirmationAuthorityV2 = {
    ...authorityWithoutDigest,
    authorityDigest: sha256Hash(canonicalJson(authorityWithoutDigest)),
  };
  validateSessionPlanConfirmationAuthorityV2(authority, state);
  return authority;
}

export function currentSessionPlanConfirmationAuthorityV2(
  state: SessionKernelLoopStateV2
): SessionPlanConfirmationAuthorityV2 | undefined {
  const authority = state.planConfirmation;
  if (!authority) return undefined;
  validateSessionPlanConfirmationAuthorityV2(authority, state);
  const plan = state.plan;
  if (
    !plan
    || state.toolContext.refreshRequired
    || authority.planRevision !== plan.planRevision
    || authority.controlEpoch !== state.controlEpoch
    || authority.planDigest !== sha256Hash(canonicalJson(plan))
    || authority.scopePreviewsDigest !== sha256Hash(canonicalJson(
      currentSessionPlanScopePreviewsV2(state, plan)
    ))
    || canonicalJson(authority.toolContextRef)
      !== canonicalJson(toolContextRefV2(state.toolContext.bundle))
  ) {
    return undefined;
  }
  return cloneJson(authority);
}

export function recordSessionUserInputV2(
  state: SessionKernelLoopStateV2,
  input: SessionUserInputRecordV2
): SessionKernelLoopStateV2 {
  validateUserInput(input);
  const next = cloneSessionKernelLoopStateV2(state);
  const existing = next.inputs.find((value) => value.inputId === input.inputId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(input)) {
    throw new SessionKernelStateError(
      'session_kernel_input_identity_conflict',
      `Input ${input.inputId} already has different content.`
    );
  }
  if (existing) {
    if (next.currentInputId !== input.inputId) {
      throw new SessionKernelStateError(
        'session_kernel_input_identity_reused',
        `Input ${input.inputId} cannot be reused as a later user turn.`
      );
    }
    return next;
  }
  next.inputs.push(cloneJson(input));
  next.currentInputId = input.inputId;
  const bounded = boundedInputHistory(
    next.inputs,
    next.currentInputId
  );
  next.inputs = bounded.records;
  next.inputHistoryOmittedCount += bounded.omittedCount;
  next.projectedInputIds = next.projectedInputIds.filter(
    (inputId) =>
      next.inputs.some((record) => record.inputId === inputId)
  );
  next.pendingEpochInput = cloneJson(input);
  abortSessionProviderToolCallQueueV2(
    next,
    'userInput',
    input.recordedAt
  );
  next.plan = undefined;
  next.workAuthority = undefined;
  next.planConfirmation = undefined;
  next.planDecision = undefined;
  next.interventionResearch = undefined;
  next.userIntervention = undefined;
  next.userInterventionDecision = undefined;
  next.projectedPlanRevision = undefined;
  next.projectedPlanDecisionKey = undefined;
  next.previews = {};
  next.planActionSettlements = {};
  next.operationPlanActionBindings = {};
  next.factsById = {};
  next.factHistoryOmittedCount = 0;
  next.reviewFacts = createSessionReviewFactAccumulatorV2(
    state.controlEpoch + 1,
    state.lineage.cursor.afterLedgerSequence
  );
  next.lineage.taskPlanActions = {};
  next.lineage.planActions = {};
  next.lineage.operations = {};
  next.lineage.invocations = {};
  next.review = undefined;
  next.finalAnswer = undefined;
  next.terminalAnswerCandidate = undefined;
  return next;
}

export function recordSessionProviderOutcomeV2(
  state: SessionKernelLoopStateV2,
  outcome: SessionProviderOutcomeRecordV2
): void {
  if (
    !isExactSessionProviderOutcomeRecordV2(
      outcome,
      state.providerProfile.providerProfileId
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_provider_outcome_invalid',
      'Provider outcome must be exact durable v2 data.'
    );
  }
  state.providerOutcomes.push(cloneJson(outcome));
  const bounded = boundedProviderOutcomeHistory(
    state.providerOutcomes
  );
  state.providerOutcomes = bounded.records;
  state.providerOutcomeHistoryOmittedCount +=
    bounded.omittedCount;
}

export function recordSessionTerminalAnswerCandidateV1(
  state: SessionKernelLoopStateV2,
  candidate: SessionTerminalAnswerCandidateV1
): void {
  validateTerminalAnswerCandidateV1(candidate, state);
  state.terminalAnswerCandidate = cloneJson(candidate);
}

export function recordSessionContextReadWorkAuthorityV3(
  state: SessionKernelLoopStateV2,
  intents: readonly ToolIntentV2[]
): void {
  if (intents.length === 0) {
    throw new SessionKernelStateError(
      'session_kernel_context_read_authority_empty',
      'Context-read work authority requires at least one normalized ToolIntent.'
    );
  }
  for (const intent of intents) {
    if (
      intent.runId !== state.runId
      || intent.expectedControlEpoch !== state.controlEpoch
      || intent.authority.kind !== 'read'
    ) {
      throw new SessionKernelStateError(
        'session_kernel_context_read_authority_mismatch',
        'Context-read work authority must bind exact current-run ToolIntents.'
      );
    }
    requiredIdentity(intent.operationId, 'intent.operationId');
  }
  if (state.plan) {
    validateSessionWorkAuthorityV3(state.workAuthority, state);
    return;
  }
  const previousAuthority = state.workAuthority?.kind === 'contextRead'
    ? state.workAuthority
    : undefined;
  if (
    state.workAuthority
    && state.workAuthority.kind !== 'contextRead'
  ) {
    throw new SessionKernelStateError(
      'session_kernel_context_read_authority_conflict',
      'Context-read work cannot replace a different current work authority.'
    );
  }
  const operationIds = [...new Set(
    intents.map((intent) => intent.operationId)
  )].sort();
  if (
    previousAuthority
    && canonicalJson(previousAuthority.operationIds)
      === canonicalJson(operationIds)
  ) {
    return;
  }
  const batchSequence = (previousAuthority?.batchSequence ?? 0) + 1;
  const predecessorDigest = previousAuthority?.digest ?? null;
  state.workAuthority = {
    kind: 'contextRead',
    batchSequence,
    predecessorDigest,
    operationIds,
    digest: sessionContextReadWorkAuthorityDigestV3({
      batchSequence,
      predecessorDigest,
      operationIds,
    }),
  };
}

export function currentSessionWorkAuthorityV3(
  state: SessionKernelLoopStateV2
): SessionWorkAuthorityV3 | undefined {
  validateSessionWorkAuthorityV3(state.workAuthority, state);
  return state.workAuthority
    ? cloneJson(state.workAuthority)
    : undefined;
}

export function sameSessionWorkAuthorityV3(
  left: SessionWorkAuthorityV3,
  right: SessionWorkAuthorityV3
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function sessionContextReadWorkAuthorityDigestV3(
  authority: {
    batchSequence: number;
    predecessorDigest: string | null;
    operationIds: readonly string[];
  }
): string {
  return sha256Hash(canonicalJson({
    kind: 'contextRead',
    batchSequence: authority.batchSequence,
    predecessorDigest: authority.predecessorDigest,
    operationIds: [...authority.operationIds],
  }));
}

export function validateSessionWorkAuthorityShapeV3(
  authority: SessionWorkAuthorityV3
): void {
  if (authority.kind === 'plan') {
    requiredIdentity(authority.planRevision, 'workAuthority.planRevision');
    return;
  }
  if (
    authority.kind !== 'contextRead'
    || !Number.isSafeInteger(authority.batchSequence)
    || authority.batchSequence < 1
    || (
      authority.batchSequence === 1
        ? authority.predecessorDigest !== null
        : !authority.predecessorDigest
    )
    || (
      authority.predecessorDigest !== null
      && !/^sha256:[0-9a-f]{64}$/u.test(
        authority.predecessorDigest
      )
    )
    || !Array.isArray(authority.operationIds)
    || authority.operationIds.length === 0
  ) {
    throw new SessionKernelStateError(
      'session_kernel_work_authority_invalid',
      'Session work authority has an invalid discriminator or operation set.'
    );
  }
  const normalized = [...new Set(authority.operationIds)].sort();
  if (
    normalized.length !== authority.operationIds.length
    || normalized.some((operationId, index) =>
      operationId !== authority.operationIds[index]
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_work_authority_invalid',
      'Context-read work authority operation identities must be unique and canonically ordered.'
    );
  }
  normalized.forEach((operationId) =>
    requiredIdentity(operationId, 'workAuthority.operationId')
  );
  if (
    authority.digest
      !== sessionContextReadWorkAuthorityDigestV3({
        batchSequence: authority.batchSequence,
        predecessorDigest: authority.predecessorDigest,
        operationIds: normalized,
      })
  ) {
    throw new SessionKernelStateError(
      'session_kernel_work_authority_digest_mismatch',
      'Context-read work authority digest does not match its current batch and predecessor chain.'
    );
  }
}

function validateSessionWorkAuthorityV3(
  authority: SessionWorkAuthorityV3 | undefined,
  state: SessionKernelLoopStateV2
): void {
  if (!authority) {
    if (state.plan) {
      throw new SessionKernelStateError(
        'session_kernel_work_authority_missing',
        'A current Plan requires explicit durable work authority.'
      );
    }
    return;
  }
  validateSessionWorkAuthorityShapeV3(authority);
  if (
    (authority.kind === 'plan'
      && authority.planRevision !== state.plan?.planRevision)
    || (authority.kind === 'contextRead' && state.plan !== undefined)
  ) {
    throw new SessionKernelStateError(
      'session_kernel_work_authority_stale',
      'Session work authority does not bind the current Plan state.'
    );
  }
}

export function sessionPlanActionV2(
  state: SessionKernelLoopStateV2,
  planActionId: string
) {
  const action = state.plan?.actions.find(
    (value) => value.manifest.planActionId === planActionId
  );
  if (!action) {
    throw new SessionKernelStateError(
      'session_kernel_plan_action_missing',
      `PlanAction ${planActionId} is not present in the persisted Plan.`
    );
  }
  return cloneJson(action);
}

export function currentSessionUserInputV2(
  state: SessionKernelLoopStateV2
): SessionUserInputRecordV2 {
  const input = state.inputs.find(
    (value) => value.inputId === state.currentInputId
  );
  if (!input) {
    throw new SessionKernelStateError(
      'session_kernel_current_input_missing',
      'The current Session user input is not present in durable Loop state.'
    );
  }
  return cloneJson(input);
}

export function recordSessionOperationPlanActionBindingV2(
  state: SessionKernelLoopStateV2,
  input: SessionOperationPlanActionBindingV2
): void {
  requiredIdentity(input.operationId, 'operationId');
  requiredIdentity(input.planActionId, 'planActionId');
  requiredIdentity(input.planRevision, 'planRevision');
  positiveEpoch(input.controlEpoch);
  const plan = state.plan;
  if (
    !plan ||
    input.controlEpoch !== state.controlEpoch
    || input.planRevision !== plan.planRevision
  ) {
    throw new SessionKernelStateError(
      'session_kernel_operation_plan_binding_stale',
      'Dynamic operation binding does not belong to the current Plan epoch and revision.'
    );
  }
  const action = plan.actions.find(
    (candidate) =>
      candidate.manifest.planActionId === input.planActionId
  );
  if (!action) {
    throw new SessionKernelStateError(
      'session_kernel_operation_plan_binding_missing',
      'Dynamic operation binding does not belong to the current Plan.'
    );
  }
  const manifestOwner = plan.actions.find(
    (candidate) =>
      candidate.manifest.operationId === input.operationId
  );
  if (
    manifestOwner
    && manifestOwner.manifest.planActionId !== input.planActionId
  ) {
    throw new SessionKernelStateError(
      'session_kernel_operation_plan_binding_conflict',
      'Dynamic operation identity conflicts with another current PlanAction.'
    );
  }
  const existing =
    state.operationPlanActionBindings[input.operationId];
  if (existing && JSON.stringify(existing) !== JSON.stringify(input)) {
    throw new SessionKernelStateError(
      'session_kernel_operation_plan_binding_conflict',
      `Operation ${input.operationId} is already bound to another current PlanAction.`
    );
  }
  if (!existing) {
    const bindings = Object.values(
      state.operationPlanActionBindings
    );
    if (
      bindings.length >= MAX_SESSION_OPERATION_PLAN_BINDINGS
      || bindings.filter(
        (binding) =>
          binding.planActionId === input.planActionId
      ).length >= MAX_SESSION_OPERATIONS_PER_PLAN_ACTION
    ) {
      throw new SessionKernelStateError(
        'session_kernel_operation_plan_binding_limit',
        'Current Plan operation bindings exceed the durable Session safety limit.'
      );
    }
  }
  state.operationPlanActionBindings[input.operationId] =
    cloneJson(input);
}

export function checkpointSessionKernelStateV2(
  state: SessionKernelLoopStateV2,
  savedAt: string
): SessionKernelCheckpointV2 {
  const next = cloneSessionKernelLoopStateV2(state);
  const consumedThroughLedgerSequence =
    next.lineage.cursor.afterLedgerSequence;
  next.checkpointRevision += 1;
  validateOperationPlanActionBindings(
    next.operationPlanActionBindings,
    next
  );
  if (next.providerToolCallQueue) {
    validateSessionProviderToolCallQueueV2(
      next.providerToolCallQueue,
      {
        runId: next.runId,
        controlEpoch: next.controlEpoch,
      }
    );
  }
  next.factsById = {};
  next.factHistoryOmittedCount = 0;
  next.reviewFacts = createSessionReviewFactAccumulatorV2(
    state.reviewFacts.controlEpoch,
    state.reviewFacts.coverageAfterLedgerSequence
  );
  next.lineage = rebuildSessionKernelLineageV2(next);
  // Compact checkpoints drop replayable fact bodies and lineage details, but
  // the wire cursor still records exactly how far the live state had consumed.
  // Recovery separately rewinds to the Review coverage boundary to rebuild the
  // dropped projection without weakening checkpoint authority evidence.
  next.lineage.cursor.afterLedgerSequence =
    consumedThroughLedgerSequence;
  for (const barrier of Object.values(next.factBarriers)) {
    barrier.observedFactIds = [];
  }
  return {
    schemaVersion: SESSION_KERNEL_CHECKPOINT_V2_SCHEMA,
    checkpointRevision: next.checkpointRevision,
    savedAt,
    state: next,
  };
}

/**
 * Drops only Session's replayable Kernel projection. Canonical facts remain
 * in Kernel and are queried again from sequence zero. Session-owned Plan,
 * requests, waits, and fact barriers remain durable.
 */
export function resetSessionKernelFactProjectionV2(
  state: SessionKernelLoopStateV2
): void {
  state.factsById = {};
  state.factHistoryOmittedCount = 0;
  state.reviewFacts = createSessionReviewFactAccumulatorV2(
    state.reviewFacts.controlEpoch,
    state.reviewFacts.coverageAfterLedgerSequence
  );
  state.lineage = rebuildSessionKernelLineageV2(state);
  for (const barrier of Object.values(state.factBarriers)) {
    barrier.observedFactIds = [];
  }
  state.review = undefined;
  state.terminalAnswerCandidate = undefined;
  if (state.finalAnswer) {
    state.finalAnswer = {
      ...state.finalAnswer,
      status: 'stale',
    };
    delete state.finalAnswer.finalText;
    delete state.finalAnswer.committedAt;
    delete state.finalAnswer.commitKind;
  }
  state.kernelWakeHint = true;
}

/**
 * Prepares a restored active-v3 state to rebuild its replayable Kernel
 * projection from the exact current-epoch ledger boundary. Frozen Review and
 * final-answer identities remain available so canonical replay can either
 * validate them at the same high-water or stale them when new facts exist.
 */
export function prepareSessionKernelFactReplayV3(
  state: SessionKernelLoopStateV2,
  input: {
    coverageAfterLedgerSequence: number;
    snapshotHighWater: number;
  }
): void {
  const coverageAfterLedgerSequence = nonnegativeSafeInteger(
    input.coverageAfterLedgerSequence,
    'coverageAfterLedgerSequence'
  );
  const snapshotHighWater = nonnegativeSafeInteger(
    input.snapshotHighWater,
    'snapshotHighWater'
  );
  state.factsById = {};
  state.factHistoryOmittedCount = 0;
  state.reviewFacts = createSessionReviewFactAccumulatorV2(
    state.pendingEpochInput
      ? state.controlEpoch + 1
      : state.controlEpoch,
    coverageAfterLedgerSequence
  );
  state.lineage = rebuildSessionKernelLineageV2(state);
  state.lineage.cursor.afterLedgerSequence =
    coverageAfterLedgerSequence;
  state.lineage.cursor.snapshotHighWater = snapshotHighWater;
  for (const barrier of Object.values(state.factBarriers)) {
    barrier.observedFactIds = [];
  }
  state.kernelWakeHint = true;
}

export function createSessionReviewFactAccumulatorV2(
  controlEpoch: number,
  coverageAfterLedgerSequence: number
): SessionReviewFactAccumulatorV2 {
  positiveEpoch(controlEpoch);
  nonnegativeSafeInteger(
    coverageAfterLedgerSequence,
    'coverageAfterLedgerSequence'
  );
  const category = () => ({
    totalCount: 0,
    samples: [],
  });
  return {
    controlEpoch,
    coverageAfterLedgerSequence,
    scopeExpansions: category(),
    actualEffects: category(),
    denied: category(),
    rejections: category(),
    cleanup: category(),
    indeterminate: category(),
    priorEpochLateFacts: category(),
    observedEffectPlanActions: {},
    authorizedOperationSequences: {},
    pendingCleanupByResource: {},
  };
}

function rebuildSessionKernelLineageV2(
  state: SessionKernelLoopStateV2
): SessionKernelLineageStateV2 {
  const snapshotHighWater = state.lineage.cursor.snapshotHighWater;
  let lineage = createSessionKernelLineageStateV2(state.runId);
  lineage.cursor.snapshotHighWater = snapshotHighWater;
  for (const action of state.plan?.actions ?? []) {
    lineage = registerSessionPlanActionLineageV2(
      lineage,
      {
        taskId: action.taskId,
        manifest: action.manifest,
      }
    );
  }
  for (
    const binding of Object.values(
      state.operationPlanActionBindings
    ).sort((left, right) =>
      left.operationId.localeCompare(right.operationId)
    )
  ) {
    const action = state.plan?.actions.find(
      (candidate) =>
        candidate.manifest.planActionId === binding.planActionId
    );
    if (!action) {
      throw new SessionKernelStateError(
        'session_kernel_operation_plan_binding_missing',
        'Persisted operation binding does not belong to the current Plan.'
      );
    }
    lineage = registerSessionOperationPlanActionLineageV2(
      lineage,
      {
        operationId: binding.operationId,
        planActionId: binding.planActionId,
        toolId: action.manifest.toolId,
      }
    );
  }
  return lineage;
}

function validateOperationPlanActionBindings(
  bindings: Record<string, SessionOperationPlanActionBindingV2>,
  state: SessionKernelLoopStateV2
): void {
  if (
    !bindings
    || typeof bindings !== 'object'
    || Array.isArray(bindings)
  ) {
    throw new SessionKernelStateError(
      'session_kernel_operation_plan_bindings_invalid',
      'Session operation-to-PlanAction bindings are invalid.'
    );
  }
  const plan = state.plan;
  const bindingEntries = Object.entries(bindings);
  if (bindingEntries.length > MAX_SESSION_OPERATION_PLAN_BINDINGS) {
    throw new SessionKernelStateError(
      'session_kernel_operation_plan_binding_limit',
      'Current Plan operation bindings exceed the durable Session safety limit.'
    );
  }
  if (!plan) {
    if (bindingEntries.length > 0) {
      throw new SessionKernelStateError(
        'session_kernel_operation_plan_bindings_invalid',
        'Operation bindings cannot exist without a current Plan.'
      );
    }
    return;
  }
  const perPlanActionCount = new Map<string, number>();
  for (const [operationId, binding] of bindingEntries) {
    if (
      !binding
      || binding.operationId !== operationId
      || binding.controlEpoch !== state.controlEpoch
      || binding.planRevision !== plan.planRevision
      || !plan.actions.some(
        (action) =>
          action.manifest.planActionId === binding.planActionId
      )
    ) {
      throw new SessionKernelStateError(
        'session_kernel_operation_plan_bindings_invalid',
        'Persisted operation binding is stale or does not match the current Plan.'
      );
    }
    const operationCount =
      (perPlanActionCount.get(binding.planActionId) ?? 0) + 1;
    if (operationCount > MAX_SESSION_OPERATIONS_PER_PLAN_ACTION) {
      throw new SessionKernelStateError(
        'session_kernel_operation_plan_binding_limit',
        'A PlanAction exceeds the durable Session operation-binding safety limit.'
      );
    }
    perPlanActionCount.set(binding.planActionId, operationCount);
    requiredIdentity(operationId, 'operationBinding.operationId');
    requiredIdentity(
      binding.planActionId,
      'operationBinding.planActionId'
    );
    requiredIdentity(
      binding.planRevision,
      'operationBinding.planRevision'
    );
    positiveEpoch(binding.controlEpoch);
    const manifestOwner = plan.actions.find(
      (action) =>
        action.manifest.operationId === operationId
    );
    if (
      manifestOwner
      && manifestOwner.manifest.planActionId
        !== binding.planActionId
    ) {
      throw new SessionKernelStateError(
        'session_kernel_operation_plan_bindings_invalid',
        'Persisted operation identity conflicts with another current PlanAction.'
      );
    }
  }
}

function validateReviewFactAccumulator(
  accumulator: SessionReviewFactAccumulatorV2,
  state: SessionKernelLoopStateV2
): void {
  const expectedEpoch = state.pendingEpochInput
    ? state.controlEpoch + 1
    : state.controlEpoch;
  if (
    !accumulator
    || typeof accumulator !== 'object'
    || Array.isArray(accumulator)
    || accumulator.controlEpoch !== expectedEpoch
  ) {
    throw new SessionKernelStateError(
      'session_kernel_review_facts_invalid',
      'Session Review fact accumulator does not match the active epoch boundary.'
    );
  }
  nonnegativeSafeInteger(
    accumulator.coverageAfterLedgerSequence,
    'reviewFacts.coverageAfterLedgerSequence'
  );
  const categories = [
    accumulator.scopeExpansions,
    accumulator.actualEffects,
    accumulator.denied,
    accumulator.rejections,
    accumulator.cleanup,
    accumulator.indeterminate,
    accumulator.priorEpochLateFacts,
  ];
  const evidenceMaps = [
    accumulator.observedEffectPlanActions,
    accumulator.authorizedOperationSequences,
    accumulator.pendingCleanupByResource,
  ];
  if (
    categories.some(
      (category) =>
        !category
        || typeof category !== 'object'
        || Array.isArray(category)
        || category.totalCount !== 0
        || !Array.isArray(category.samples)
        || category.samples.length !== 0
    )
    || evidenceMaps.some(
      (evidence) =>
        !evidence
        || typeof evidence !== 'object'
        || Array.isArray(evidence)
        || Object.keys(evidence).length !== 0
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_checkpoint_fact_projection_present',
      'Checkpoint must rebuild Review fact evidence from canonical Kernel facts.'
    );
  }
}

function validateFactBarriers(
  barriers: Record<string, SessionKernelFactBarrierV2>
): void {
  if (
    !barriers
    || typeof barriers !== 'object'
    || Array.isArray(barriers)
  ) {
    throw new SessionKernelStateError(
      'session_kernel_fact_barriers_invalid',
      'Session Kernel checkpoint fact barriers are invalid.'
    );
  }
  for (const [requestId, barrier] of Object.entries(barriers)) {
    requiredIdentity(requestId, 'factBarrier.requestId');
    if (
      !barrier
      || barrier.requestId !== requestId
      || (
        barrier.source !== 'toolIntentSubmit'
        && barrier.source !== 'controlEpochAdvance'
        && barrier.source !== 'invocationCancel'
      )
      || !Number.isSafeInteger(barrier.minimumHighWater)
      || barrier.minimumHighWater <= 0
      || !Array.isArray(barrier.requiredFactIds)
      || barrier.requiredFactIds.length === 0
      || !Array.isArray(barrier.observedFactIds)
      || barrier.observedFactIds.length !== 0
    ) {
      throw new SessionKernelStateError(
        'session_kernel_fact_barriers_invalid',
        'Session Kernel checkpoint fact barrier shape is invalid.'
      );
    }
    const required = new Set(
      barrier.requiredFactIds.map((factId) =>
        requiredIdentity(factId, 'factBarrier.requiredFactId')
      )
    );
    if (required.size !== barrier.requiredFactIds.length) {
      throw new SessionKernelStateError(
        'session_kernel_fact_barriers_invalid',
        'Session Kernel checkpoint fact barrier identities must be unique.'
      );
    }
  }
}

export function cloneSessionKernelLoopStateV2(
  state: SessionKernelLoopStateV2
): SessionKernelLoopStateV2 {
  return cloneJson(state);
}

function validatePlan(plan: SessionNaturalLanguagePlanV2): void {
  requiredIdentity(plan.runId, 'runId');
  requiredIdentity(plan.inputId, 'inputId');
  requiredIdentity(plan.planRevision, 'planRevision');
  requiredText(plan.title, 'plan.title');
  requiredText(plan.objective, 'plan.objective');
  requiredText(plan.narrative, 'plan.narrative');
  requiredText(plan.recordedAt, 'plan.recordedAt');
  validatePlanEvidenceV4(plan.evidence);
  if (plan.predecessorPlanRef) {
    requiredIdentity(
      plan.predecessorPlanRef.planRevision,
      'plan.predecessorPlanRef.planRevision'
    );
    requiredDigestV2(
      plan.predecessorPlanRef.planDigest,
      'plan.predecessorPlanRef.planDigest'
    );
  }
  if (!Array.isArray(plan.carriedSettlementRefs)) {
    throw new SessionKernelStateError(
      'session_kernel_plan_carried_settlements_invalid',
      'A persisted Plan must carry an explicit settlement reference list.'
    );
  }
  const carriedActionIds = new Set<string>();
  plan.carriedSettlementRefs.forEach((settlement) => {
    requiredIdentity(
      settlement.planRevision,
      'plan.carriedSettlement.planRevision'
    );
    requiredIdentity(
      settlement.planActionId,
      'plan.carriedSettlement.planActionId'
    );
    requiredDigestV2(
      settlement.settlementDigest,
      'plan.carriedSettlement.settlementDigest'
    );
    if (
      !Array.isArray(settlement.kernelFactRefs)
      || new Set(settlement.kernelFactRefs).size
        !== settlement.kernelFactRefs.length
      || carriedActionIds.has(settlement.planActionId)
    ) {
      throw new SessionKernelStateError(
        'session_kernel_plan_carried_settlements_invalid',
        'Carried Plan settlements must have unique action and fact identities.'
      );
    }
    carriedActionIds.add(settlement.planActionId);
    settlement.kernelFactRefs.forEach((factRef) =>
      requiredIdentity(factRef, 'plan.carriedSettlement.kernelFactRef')
    );
  });
  if (plan.actions.length === 0) {
    throw new SessionKernelStateError(
      'session_kernel_plan_actions_empty',
      'A persisted Plan must contain at least one structured PlanAction.'
    );
  }
  if (
    plan.actions.length > MAX_SESSION_PLAN_ACTIONS
    || jsonByteLength(plan) > MAX_SESSION_PLAN_BYTES
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_size_invalid',
      'A persisted Plan exceeds the bounded action or byte budget.'
    );
  }
  const actionIds = new Set<string>();
  const operationIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const action of plan.actions) {
    validatePlanActionScopeIntentV3(action);
    requiredIdentity(action.taskId, 'taskId');
    requiredIdentity(action.idempotencyKey, 'idempotencyKey');
    if (action.manifest.planRevision !== plan.planRevision) {
      throw new SessionKernelStateError(
        'session_kernel_plan_action_revision_mismatch',
        'Every ScopeManifest must bind the enclosing Plan revision.'
      );
    }
    if (
      actionIds.has(action.manifest.planActionId)
      || operationIds.has(action.manifest.operationId)
      || idempotencyKeys.has(action.idempotencyKey)
    ) {
      throw new SessionKernelStateError(
        'session_kernel_plan_action_identity_duplicate',
        'PlanAction, operation, and idempotency identities must be unique within a Plan.'
      );
    }
    actionIds.add(action.manifest.planActionId);
    operationIds.add(action.manifest.operationId);
    idempotencyKeys.add(action.idempotencyKey);
  }
}

function validatePlanEvidenceV4(
  evidence: SessionNaturalLanguagePlanV2['evidence']
): void {
  if (
    !evidence
    || !Array.isArray(evidence.kernelFactRefs)
    || !Array.isArray(evidence.readResources)
    || !Array.isArray(evidence.blockingUnknowns)
    || !Array.isArray(evidence.nonBlockingUnknowns)
    || evidence.kernelFactRefs.length > 512
    || evidence.readResources.length > 512
    || evidence.blockingUnknowns.length > 128
    || evidence.nonBlockingUnknowns.length > 128
    || new Set(evidence.kernelFactRefs).size
      !== evidence.kernelFactRefs.length
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_evidence_invalid',
      'Persisted Plan evidence exceeds the closed v4 evidence contract.'
    );
  }
  requiredText(evidence.coverage, 'plan.evidence.coverage');
  evidence.kernelFactRefs.forEach((factRef) =>
    requiredIdentity(factRef, 'plan.evidence.kernelFactRef')
  );
  const resourceRefs = new Set<string>();
  evidence.readResources.forEach((resource) => {
    requiredIdentity(resource.resourceRef, 'plan.evidence.resourceRef');
    requiredDigestV2(resource.digest, 'plan.evidence.resourceDigest');
    requiredText(resource.summary, 'plan.evidence.resourceSummary');
    if (
      resourceRefs.has(resource.resourceRef)
      || !Array.isArray(resource.factRefs)
      || resource.factRefs.length === 0
      || new Set(resource.factRefs).size !== resource.factRefs.length
    ) {
      throw new SessionKernelStateError(
        'session_kernel_plan_evidence_invalid',
        'Plan read evidence must bind unique resources to non-empty unique fact references.'
      );
    }
    resourceRefs.add(resource.resourceRef);
    resource.factRefs.forEach((factRef) =>
      requiredIdentity(factRef, 'plan.evidence.resourceFactRef')
    );
  });
  const unknownIds = new Set<string>();
  for (const unknown of [
    ...evidence.blockingUnknowns,
    ...evidence.nonBlockingUnknowns,
  ]) {
    requiredIdentity(unknown.unknownId, 'plan.evidence.unknownId');
    requiredText(unknown.question, 'plan.evidence.unknownQuestion');
    requiredText(unknown.impact, 'plan.evidence.unknownImpact');
    if (!unknownIds.add(unknown.unknownId)) {
      throw new SessionKernelStateError(
        'session_kernel_plan_evidence_invalid',
        'Plan evidence unknown identities must be unique across both classes.'
      );
    }
  }
}

function validatePlanActionScopeIntentV3(
  action: SessionNaturalLanguagePlanV2['actions'][number]
): void {
  const actionRecord = stateRecord(action);
  const manifest = stateRecord(actionRecord?.manifest);
  const scopeIntent = stateRecord(manifest?.scopeIntent);
  const data = stateRecord(scopeIntent?.data);
  if (
    !actionRecord
    || !hasExactFields(actionRecord, [
      'taskId',
      'manifest',
      'idempotencyKey',
      'deadline',
    ])
    || !manifest
    || !hasExactFields(manifest, [
      'planRevision',
      'planActionId',
      'operationId',
      'toolId',
      'scopeIntent',
    ])
    || !scopeIntent
    || !hasExactFields(scopeIntent, ['kind', 'data'])
    || !data
  ) {
    throw invalidPlanScopeIntentV3();
  }
  if (scopeIntent.kind === 'exactInvocation') {
    if (!hasExactFields(data, ['rawArguments'])) {
      throw invalidPlanScopeIntentV3();
    }
    try {
      decodeRawToolArgumentsV2(data.rawArguments);
    } catch {
      throw invalidPlanScopeIntentV3();
    }
    return;
  }
  if (
    scopeIntent.kind !== 'resourceScope'
    || !hasExactFields(data, ['requestedResources'])
    || !Array.isArray(data.requestedResources)
    || data.requestedResources.length === 0
    || data.requestedResources.length > 256
  ) {
    throw invalidPlanScopeIntentV3();
  }
  data.requestedResources.forEach(validatePlanRequestedResourceV3);
}

function validatePlanRequestedResourceV3(value: unknown): void {
  const resource = stateRecord(value);
  const data = stateRecord(resource?.data);
  if (
    !resource
    || !hasExactFields(resource, ['kind', 'data'])
    || !data
  ) {
    throw invalidPlanScopeIntentV3();
  }
  const valid =
    resource.kind === 'workspacePath'
      ? hasExactFields(data, ['path', 'access'])
        && validPlanResourceTextV3(data.path)
        && (data.access === 'read' || data.access === 'write')
      : resource.kind === 'repository'
        ? hasExactFields(data, ['area'])
          && ['state', 'index', 'history'].includes(String(data.area))
        : resource.kind === 'networkUrl'
          ? hasExactFields(data, ['url'])
            && validPlanResourceTextV3(data.url)
          : resource.kind === 'networkQuery'
            ? hasExactFields(data, ['query'])
              && validPlanResourceTextV3(data.query)
            : false;
  if (!valid) throw invalidPlanScopeIntentV3();
}

function validPlanResourceTextV3(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && new TextEncoder().encode(value).byteLength <= 16 * 1024
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function invalidPlanScopeIntentV3(): SessionKernelStateError {
  return new SessionKernelStateError(
    'session_kernel_plan_scope_intent_invalid',
    'Persisted PlanActions must use the exact current ScopeIntent schema.'
  );
}

function validatePlanDecision(decision: SessionPlanDecisionV2): void {
  requiredIdentity(decision.planRevision, 'planRevision');
  if (
    decision.decision !== 'accept'
    && decision.decision !== 'reject'
    && decision.decision !== 'revise'
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_decision_invalid',
      'Plan decision must be accept, reject, or revise.'
    );
  }
  if (
    decision.decision !== 'accept'
    && !decision.guidance?.trim()
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_decision_guidance_required',
      'Reject and revise decisions require user guidance.'
    );
  }
  if (
    decision.guidance !== undefined
    && (
      new TextEncoder().encode(decision.guidance).byteLength
        > 64 * 1024
      || decision.guidance.trim() !== decision.guidance
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_decision_guidance_invalid',
      'Plan decision guidance must be trimmed and bounded.'
    );
  }
  const recordedAt = Date.parse(decision.recordedAt);
  if (
    !Number.isFinite(recordedAt)
    || new Date(recordedAt).toISOString() !== decision.recordedAt
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_decision_time_invalid',
      'Plan decision recordedAt must be an ISO-compatible instant.'
    );
  }
}

function validateUserInterventionStateV4(
  state: SessionKernelLoopStateV2
): void {
  const research = state.interventionResearch;
  const intervention = state.userIntervention;
  const decision = state.userInterventionDecision;
  if (!research && (intervention || decision)) {
    throw invalidInterventionStateV4(
      'An intervention card or decision requires its durable research state.'
    );
  }
  if (!research) return;
  const plan = state.plan;
  const selectedCandidatePlan = decision?.decision === 'select'
    ? intervention?.options.find(
        (option) => option.optionId === decision.optionId
      )?.candidatePlan
    : undefined;
  const researchPlanBindingValid = selectedCandidatePlan
    ? plan?.planRevision === selectedCandidatePlan.planRevision
      && canonicalJson(selectedCandidatePlan.predecessorPlanRef)
        === canonicalJson(research.predecessorPlanRef)
    : plan !== undefined
      && research.predecessorPlanRef.planRevision === plan.planRevision
      && research.predecessorPlanRef.planDigest
        === sha256Hash(canonicalJson(plan));
  if (
    research.schemaVersion
      !== 'deepcode.session.intervention-research.v1'
    || research.runId !== state.runId
    || research.inputId !== state.currentInputId
    || research.controlEpoch !== state.controlEpoch
    || !plan
    || !researchPlanBindingValid
    || !Array.isArray(research.triggerCandidates)
    || research.triggerCandidates.length === 0
    || !Number.isSafeInteger(research.guidanceRevision)
    || research.guidanceRevision < 1
  ) {
    throw invalidInterventionStateV4(
      'Intervention research does not bind the exact current Plan authority.'
    );
  }
  requiredIdentity(research.researchId, 'interventionResearch.researchId');
  requiredIdentity(
    research.triggerProviderTurnId,
    'interventionResearch.triggerProviderTurnId'
  );
  requiredDigestV2(
    research.evidenceProgressDigest,
    'interventionResearch.evidenceProgressDigest'
  );
  if (research.previousEvidenceProgressDigest) {
    requiredDigestV2(
      research.previousEvidenceProgressDigest,
      'interventionResearch.previousEvidenceProgressDigest'
    );
  }
  if (research.lastCandidateSetDigest) {
    requiredDigestV2(
      research.lastCandidateSetDigest,
      'interventionResearch.lastCandidateSetDigest'
    );
  }
  requiredInstantV4(research.startedAt, 'interventionResearch.startedAt');
  requiredInstantV4(research.updatedAt, 'interventionResearch.updatedAt');
  const discoveryIds = new Set<string>();
  const operationIds = new Set<string>();
  research.triggerCandidates.forEach((candidate) => {
    requiredIdentity(candidate.discoveryId, 'intervention.discoveryId');
    requiredIdentity(candidate.operationId, 'intervention.operationId');
    requiredIdentity(candidate.toolId, 'intervention.toolId');
    requiredDigestV2(
      candidate.argumentsDigest,
      'intervention.argumentsDigest'
    );
    if (
      !discoveryIds.add(candidate.discoveryId)
      || !operationIds.add(candidate.operationId)
      || (
        candidate.classification !== 'planned'
        && candidate.classification !== 'outOfPlan'
      )
      || (candidate.preview !== undefined) === (candidate.rejection !== undefined)
    ) {
      throw invalidInterventionStateV4(
        'Intervention discovery candidates must be unique and terminally previewed or rejected.'
      );
    }
    if (candidate.preview) {
      const preview = candidate.preview;
      if (
        preview.runId !== state.runId
        || preview.controlEpoch !== state.controlEpoch
        || preview.operationId !== candidate.operationId
        || preview.toolId !== candidate.toolId
        || preview.origin.kind !== 'planDiscovery'
        || preview.origin.data.discoveryId !== candidate.discoveryId
      ) {
        throw invalidInterventionStateV4(
          'Intervention discovery preview lost its exact Kernel origin binding.'
        );
      }
      validateInterventionPreviewDigestsV4(preview);
    } else {
      requiredIdentity(
        candidate.rejection!.reason,
        'intervention.rejection.reason'
      );
      requiredText(
        candidate.rejection!.guidance,
        'intervention.rejection.guidance'
      );
    }
  });
  const expectedTriggerDigest = sha256Hash(canonicalJson(
    research.triggerCandidates.map((candidate) => ({
      discoveryId: candidate.discoveryId,
      operationId: candidate.operationId,
      toolId: candidate.toolId,
      argumentsDigest: candidate.argumentsDigest,
      classification: candidate.classification,
      previewId: candidate.preview?.previewId,
      scopeDigest: candidate.preview?.scopeDigest,
      rejection: candidate.rejection,
    }))
  ));
  if (research.triggerCandidateSetDigest !== expectedTriggerDigest) {
    throw invalidInterventionStateV4(
      'Intervention discovery candidate digest does not match its facts.'
    );
  }
  if (
    !intervention
    && !selectedCandidatePlan
    && research.evidenceProgressDigest
      !== sessionInterventionEvidenceProgressDigestV4(
        state,
        research.triggerCandidateSetDigest,
        plan
      )
  ) {
    throw invalidInterventionStateV4(
      'Intervention evidence progress does not match the current canonical facts and unsettled Plan suffix.'
    );
  }
  if (!intervention) {
    if (
      state.activeWait?.kind === 'userIntervention'
      || (decision && decision.decision !== 'revise')
    ) {
      throw invalidInterventionStateV4(
        'A user-intervention wait or decision cannot outlive its card.'
      );
    }
    if (decision) {
      if (
        decision.interactionId
          !== `user-intervention-${research.researchId}`
        || !decision.interactionRevision.trim()
        || decision.candidateSetDigest !== research.lastCandidateSetDigest
        || !decision.guidance?.trim()
        || !decision.callerRequestId.trim()
      ) {
        throw invalidInterventionStateV4(
          'Intervention revision guidance lost its exact prior card identity.'
        );
      }
      requiredInstantV4(
        decision.recordedAt,
        'intervention.decision.recordedAt'
      );
    }
    return;
  }
  if (
    intervention.schemaVersion !== 'deepcode.session.user-intervention.v1'
    || intervention.runId !== state.runId
    || intervention.inputId !== state.currentInputId
    || intervention.controlEpoch !== state.controlEpoch
    || intervention.interactionId
      !== `user-intervention-${research.researchId}`
    || intervention.evidenceProgressDigest
      !== research.evidenceProgressDigest
    || !Array.isArray(intervention.options)
    || intervention.options.length < 1
    || intervention.options.length > 16
    || (
      state.activeWait !== undefined
      && (
        state.activeWait.kind !== 'userIntervention'
        || state.activeWait.interactionId !== intervention.interactionId
        || state.activeWait.interactionRevision
          !== intervention.interactionRevision
        || state.activeWait.candidateSetDigest
          !== intervention.candidateSetDigest
      )
    )
    || (!decision && state.activeWait?.kind !== 'userIntervention')
  ) {
    throw invalidInterventionStateV4(
      'The user-intervention card and ActiveWait are not one exact authority.'
    );
  }
  requiredText(intervention.problemSummary, 'intervention.problemSummary');
  if (intervention.recommendation) {
    requiredText(intervention.recommendation, 'intervention.recommendation');
  }
  requiredDigestV2(
    intervention.candidateSetDigest,
    'intervention.candidateSetDigest'
  );
  if (
    intervention.interactionRevision
      !== `intervention-revision-${
        intervention.candidateSetDigest.slice('sha256:'.length)
      }`
    || research.lastCandidateSetDigest !== intervention.candidateSetDigest
  ) {
    throw invalidInterventionStateV4(
      'The intervention revision is not derived from the current candidate set.'
    );
  }
  const factRefs = uniqueIdentityListV4(
    intervention.relevantFactRefs,
    'intervention.relevantFactRef'
  );
  const affectedActionIds = uniqueIdentityListV4(
    intervention.affectedPlanActionIds,
    'intervention.affectedPlanActionId'
  );
  const currentUnsettled = new Set(
    plan.actions
      .filter((action) =>
        !state.planActionSettlements[action.manifest.planActionId]
      )
      .map((action) => action.manifest.planActionId)
  );
  if (affectedActionIds.some((actionId) => !currentUnsettled.has(actionId))) {
    throw invalidInterventionStateV4(
      'The intervention card references a settled or non-current action.'
    );
  }
  const optionIds = new Set<string>();
  const proposalOptions = intervention.options.map((option) => {
    requiredIdentity(option.optionId, 'intervention.optionId');
    requiredText(option.title, 'intervention.option.title');
    requiredText(option.description, 'intervention.option.description');
    if (
      !optionIds.add(option.optionId)
      || !Array.isArray(option.tradeoffs)
      || option.tradeoffs.length < 1
      || option.tradeoffs.length > 32
      || typeof option.recommended !== 'boolean'
      || (option.kind === 'executable') !== Boolean(option.candidatePlan)
      || (option.kind === 'executable') !== (option.actions.length > 0)
    ) {
      throw invalidInterventionStateV4(
        'Intervention options must be unique executable or guidance-only records.'
      );
    }
    option.tradeoffs.forEach((tradeoff) =>
      requiredText(tradeoff, 'intervention.option.tradeoff')
    );
    if (option.candidatePlan) {
      validatePlan(option.candidatePlan);
      if (
        option.candidatePlan.runId !== state.runId
        || option.candidatePlan.inputId !== state.currentInputId
        || option.candidatePlan.predecessorPlanRef?.planRevision
          !== research.predecessorPlanRef.planRevision
        || option.candidatePlan.predecessorPlanRef?.planDigest
          !== research.predecessorPlanRef.planDigest
        || option.actions.length !== option.candidatePlan.actions.length
      ) {
        throw invalidInterventionStateV4(
          'Executable intervention option lost its predecessor Plan binding.'
        );
      }
      option.actions.forEach((candidateAction, index) => {
        const action = option.candidatePlan!.actions[index]!;
        const preview = candidateAction.preview;
        if (
          candidateAction.planActionId !== action.manifest.planActionId
          || candidateAction.operationId !== action.manifest.operationId
          || candidateAction.toolId !== action.manifest.toolId
          || preview.runId !== state.runId
          || preview.controlEpoch !== state.controlEpoch
          || preview.planRevision !== option.candidatePlan!.planRevision
          || preview.planActionId !== candidateAction.planActionId
          || preview.operationId !== candidateAction.operationId
          || preview.toolId !== candidateAction.toolId
          || preview.origin.kind !== 'interventionCandidate'
          || preview.origin.data.interactionId
            !== intervention.interactionId
          || preview.origin.data.interactionRevision
            !== intervention.interactionRevision
          || preview.origin.data.candidateSetDigest
            !== intervention.candidateSetDigest
          || preview.origin.data.optionId !== option.optionId
        ) {
          throw invalidInterventionStateV4(
            'Executable option preview does not bind its exact final candidate identity.'
          );
        }
        validateInterventionPreviewDigestsV4(preview);
      });
    }
    const { actions: _actions, candidatePlan, ...presentation } = option;
    return {
      ...presentation,
      ...(candidatePlan ? { candidatePlan } : {}),
    };
  });
  const expectedCandidateSetDigest =
    sessionUserInterventionCandidateSetDigestV4({
      researchId: research.researchId,
      evidenceProgressDigest: research.evidenceProgressDigest,
      guidanceRevision: research.guidanceRevision,
      problemSummary: intervention.problemSummary,
      ...(intervention.recommendation
        ? { recommendation: intervention.recommendation }
        : {}),
      relevantFactRefs: factRefs,
      affectedPlanActionIds: affectedActionIds,
      options: proposalOptions,
    });
  if (expectedCandidateSetDigest !== intervention.candidateSetDigest) {
    throw invalidInterventionStateV4(
      'The intervention candidate-set digest does not match its exact options.'
    );
  }
  if (decision) {
    requiredIdentity(decision.callerRequestId, 'intervention.callerRequestId');
    requiredInstantV4(decision.recordedAt, 'intervention.decision.recordedAt');
    if (
      decision.interactionId !== intervention.interactionId
      || decision.interactionRevision !== intervention.interactionRevision
      || decision.candidateSetDigest !== intervention.candidateSetDigest
      || !['select', 'revise', 'reject'].includes(decision.decision)
      || (decision.decision === 'select') !== Boolean(decision.optionId)
      || (decision.decision === 'revise') !== Boolean(decision.guidance)
      || (
        decision.optionId !== undefined
        && !optionIds.has(decision.optionId)
      )
    ) {
      throw invalidInterventionStateV4(
        'The intervention decision does not bind the exact active card.'
      );
    }
  }
}

function validateInterventionPreviewDigestsV4(
  preview: import('@deepcode/protocol').CapabilityScopePreviewRecordV2
): void {
  requiredIdentity(preview.previewId, 'intervention.previewId');
  requiredDigestV2(preview.scopeDigest, 'intervention.preview.scopeDigest');
  requiredDigestV2(
    preview.authorizationDigest,
    'intervention.preview.authorizationDigest'
  );
  requiredDigestV2(
    preview.toolContractDigest,
    'intervention.preview.toolContractDigest'
  );
  requiredDigestV2(
    preview.contextRef.catalogDigest,
    'intervention.preview.catalogDigest'
  );
  requiredDigestV2(
    preview.contextRef.contextDigest,
    'intervention.preview.contextDigest'
  );
}

function uniqueIdentityListV4(values: string[], field: string): string[] {
  if (!Array.isArray(values) || new Set(values).size !== values.length) {
    throw invalidInterventionStateV4(
      `${field} values must form one unique identity list.`
    );
  }
  values.forEach((value) => requiredIdentity(value, field));
  return values;
}

function requiredInstantV4(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw invalidInterventionStateV4(`${field} must be one ISO instant.`);
  }
}

function invalidInterventionStateV4(message: string): SessionKernelStateError {
  return new SessionKernelStateError(
    'session_kernel_user_intervention_state_invalid',
    message
  );
}

function validateSessionPlanConfirmationAuthorityV2(
  authority: SessionPlanConfirmationAuthorityV2,
  state: SessionKernelLoopStateV2
): void {
  requiredIdentity(authority.planRevision, 'planConfirmation.planRevision');
  requiredIdentity(
    authority.providerTurnId,
    'planConfirmation.providerTurnId'
  );
  requiredDigestV2(
    authority.providerResponseDigest,
    'planConfirmation.providerResponseDigest'
  );
  positiveEpoch(authority.controlEpoch);
  if (
    !Number.isSafeInteger(authority.toolContextRef.contextVersion)
    || authority.toolContextRef.contextVersion < 1
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_confirmation_context_invalid',
      'Plan confirmation ToolContext version must be a positive safe integer.'
    );
  }
  requiredDigestV2(
    authority.toolContextRef.catalogDigest,
    'planConfirmation.catalogDigest'
  );
  requiredDigestV2(
    authority.toolContextRef.contextDigest,
    'planConfirmation.contextDigest'
  );
  requiredDigestV2(authority.planDigest, 'planConfirmation.planDigest');
  requiredDigestV2(
    authority.scopePreviewsDigest,
    'planConfirmation.scopePreviewsDigest'
  );
  requiredDigestV2(
    authority.authorityDigest,
    'planConfirmation.authorityDigest'
  );
  const recordedAt = Date.parse(authority.recordedAt);
  if (
    !Number.isFinite(recordedAt)
    || new Date(recordedAt).toISOString() !== authority.recordedAt
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_confirmation_time_invalid',
      'Plan confirmation recordedAt must be an ISO-compatible instant.'
    );
  }
  const expectedPrefix = [
    'run',
    state.runId,
    'plan',
    authority.planRevision,
  ].join(':');
  validatePlanConfirmationProjectionRefV2(
    authority.confirmationProjection,
    `${expectedPrefix}:confirmation-ready`,
    'confirmationProjection'
  );
  if (authority.commentaryProjection) {
    validatePlanConfirmationProjectionRefV2(
      authority.commentaryProjection,
      `${expectedPrefix}:commentary-ready`,
      'commentaryProjection'
    );
  }
  const {
    authorityDigest: _authorityDigest,
    ...authorityWithoutDigest
  } = authority;
  if (
    authority.authorityDigest
      !== sha256Hash(canonicalJson(authorityWithoutDigest))
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_confirmation_digest_mismatch',
      'Plan confirmation authority digest does not match its exact binding.'
    );
  }
}

function validatePlanConfirmationProjectionRefV2(
  projection: SessionPlanConfirmationProjectionRefV2,
  expectedProjectionId: string,
  field: string
): void {
  if (projection.projectionId !== expectedProjectionId) {
    throw new SessionKernelStateError(
      'session_kernel_plan_confirmation_projection_mismatch',
      `${field} does not bind the exact current Plan projection identity.`
    );
  }
  requiredDigestV2(
    projection.projectionDigest,
    `planConfirmation.${field}.projectionDigest`
  );
}

export function currentSessionPlanScopePreviewsV2(
  state: SessionKernelLoopStateV2,
  plan: SessionNaturalLanguagePlanV2 | undefined = state.plan,
  options: { requireComplete?: boolean } = {}
): CapabilityScopePreviewRecordV2[] {
  const requireComplete = options.requireComplete ?? true;
  const persistedPreviewOperations = Object.keys(state.previews);
  if (!plan) {
    if (persistedPreviewOperations.length !== 0) {
      throw new SessionKernelStateError(
        'session_kernel_plan_confirmation_preview_mismatch',
        'Canonical scope previews cannot exist without a current Plan.'
      );
    }
    return [];
  }
  const contextRef = toolContextRefV2(state.toolContext.bundle);
  const actionsByOperationId = new Map(
    plan.actions.map((action) => [
      action.manifest.operationId,
      action,
    ] as const)
  );
  for (const operationId of persistedPreviewOperations) {
    const action = actionsByOperationId.get(operationId);
    const preview = state.previews[operationId];
    if (
      !action
      || !preview
      || preview.runId !== state.runId
      || preview.controlEpoch !== state.controlEpoch
      || preview.planRevision !== plan.planRevision
      || preview.planActionId !== action.manifest.planActionId
      || preview.operationId !== operationId
      || preview.toolId !== action.manifest.toolId
      || canonicalJson(preview.contextRef) !== canonicalJson(contextRef)
    ) {
      throw new SessionKernelStateError(
        'session_kernel_plan_confirmation_preview_mismatch',
        'Canonical scope previews must bind one exact current PlanAction, Run, epoch, tool, and ToolContext.'
      );
    }
  }
  return plan.actions.flatMap((action) => {
    const preview = state.previews[action.manifest.operationId];
    if (!preview) {
      if (!requireComplete) return [];
      throw new SessionKernelStateError(
        'session_kernel_plan_confirmation_preview_mismatch',
        'Plan confirmation authority requires every exact current canonical preview.'
      );
    }
    return [cloneJson(preview)];
  });
}

function validateUserInput(input: SessionUserInputRecordV2): void {
  requiredIdentity(input.inputId, 'inputId');
  requiredIdentity(input.opaqueInputRef, 'opaqueInputRef');
  requiredText(input.text, 'input.text');
  validateAgentInputAttachmentsV3(input.attachments);
  decodeUserAttachmentContextsV1(
    input.attachmentContexts,
    input.attachments
  );
  requiredText(input.recordedAt, 'input.recordedAt');
}

function validatePlanActionSettlement(
  settlement: SessionPlanActionSettlementV2
): void {
  requiredIdentity(settlement.planRevision, 'planRevision');
  requiredIdentity(settlement.planActionId, 'planActionId');
  positiveEpoch(settlement.controlEpoch);
  requiredText(settlement.recordedAt, 'settlement.recordedAt');
  if (settlement.kind !== 'planActionComplete') {
    throw new SessionKernelStateError(
      'session_kernel_plan_action_settlement_kind_invalid',
      'PlanAction settlements only record the explicit Session PlanActionComplete control.'
    );
  }
  if (
    settlement.outcome !== 'completed'
    && settlement.outcome !== 'no_op'
    && settlement.outcome !== 'blocked'
    && settlement.outcome !== 'skipped'
    && settlement.outcome !== 'unexecuted'
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_action_completion_invalid',
      'PlanActionComplete has an unsupported explicit outcome.'
    );
  }
  requiredIdentity(
    settlement.providerTurnId,
    'settlement.providerTurnId'
  );
  requiredIdentity(
    settlement.controlCallId,
    'settlement.controlCallId'
  );
  requiredDigestV2(
    settlement.controlArgumentsDigest,
    'settlement.controlArgumentsDigest'
  );
  if (
    !Number.isSafeInteger(settlement.snapshotHighWater)
    || settlement.snapshotHighWater < 0
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_action_snapshot_high_water_invalid',
      'PlanActionComplete snapshotHighWater must be a non-negative safe integer.'
    );
  }
}

function positiveEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SessionKernelStateError(
      'session_kernel_state_epoch_invalid',
      'Session Kernel controlEpoch must be a positive safe integer.'
    );
  }
}

function nonnegativeSafeInteger(
  value: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionKernelStateError(
      'session_kernel_state_counter_invalid',
      `${field} must be a non-negative safe integer.`
    );
  }
  return value;
}

function requiredIdentity(value: string, field: string): string {
  if (!value.trim()) {
    throw new SessionKernelStateError(
      'session_kernel_state_identity_missing',
      `${field} must not be empty.`
    );
  }
  return value;
}

function requiredDigestV2(value: string, field: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new SessionKernelStateError(
      'session_kernel_state_digest_invalid',
      `${field} must be an exact lowercase SHA-256 digest.`
    );
  }
  return value;
}

function requiredText(value: string, field: string): void {
  if (!value.trim() || new TextEncoder().encode(value).byteLength > 64 * 1024) {
    throw new SessionKernelStateError(
      'session_kernel_state_text_invalid',
      `${field} must contain 1..=65536 UTF-8 bytes.`
    );
  }
}

function validateProviderProfile(
  profile: SessionProviderProfileBootstrapV2
): void {
  if (
    profile.schemaVersion
      !== 'deepcode.host.provider-profile-bootstrap.v2'
    || !profile.providerProfileId?.trim()
    || !/^sha256:[0-9a-f]{64}$/u.test(
      profile.providerProfileRevisionDigest
    )
    || (
      profile.reasoningTransport !== 'openaiPlaintext'
      && profile.reasoningTransport !== 'anthropicPlaintext'
      && profile.reasoningTransport !== 'ollamaPlaintext'
    )
    || !Number.isSafeInteger(profile.contextWindowTokens)
    || profile.contextWindowTokens <= 0
    || profile.contextWindowTokens > 1_000_000_000
    || !Number.isSafeInteger(profile.maxOutputTokens)
    || profile.maxOutputTokens <= 0
    || profile.maxOutputTokens >= profile.contextWindowTokens
  ) {
    throw new SessionKernelStateError(
      'session_kernel_provider_profile_invalid',
      'Session provider profile bootstrap is not exact v2.'
    );
  }
}

function validateProviderTurnResponse(
  turn: SessionProviderTurnRecordV2,
  outcome?: SessionProviderOutcomeRecordV2
): void {
  const statusIsValid = [
    'active',
    'awaitingTools',
    'cancelled',
    'completed',
    'aborted',
    'stale',
    'failed',
  ].includes(turn.status);
  if (
    !turn.providerTurnId.trim()
    || !Number.isSafeInteger(turn.controlEpoch)
    || turn.controlEpoch < 1
    || !['primary', 'continuation', 'finalAnswer'].includes(turn.purpose)
    || (turn.purpose === 'finalAnswer')
      !== (turn.target.kind === 'finalAnswer')
    || (
      turn.planRevision !== undefined
      && !turn.planRevision.trim()
    )
    || (turn.terminalRef !== undefined && turn.dispatchRef === undefined)
    || !statusIsValid
  ) {
    throw new SessionKernelStateError(
      'session_kernel_provider_reservation_invalid',
      'Provider reservation has an invalid purpose, target, epoch, or durable ref chain.'
    );
  }
  const response = turn.response;
  if (!response) {
    if (
      turn.status === 'awaitingTools'
      || turn.status === 'completed'
      || turn.status === 'aborted'
    ) {
      throw new SessionKernelStateError(
        'session_kernel_provider_response_missing',
        'Settled Provider turn has no durable ordered response receipt.'
      );
    }
    return;
  }
  if (!turn.dispatchRef || !turn.terminalRef) {
    throw new SessionKernelStateError(
      'session_kernel_provider_response_evidence_missing',
      'A reconstructed Provider response requires exact dispatch and terminal refs.'
    );
  }
  const completion = response.completion;
  if (
    !Array.isArray(response.items)
    || response.items.length > 96
    || completion.schemaVersion
      !== 'deepcode.provider-stream-terminal.v1'
    || completion.reasoningPresent !== true
    || completion.reasoningTransport
      !== turn.contextAssembly.providerProfile.reasoningTransport
    || completion.trace?.sealed !== true
    || !Number.isSafeInteger(completion.trace.recordCount)
    || completion.trace.recordCount <= 0
    || !/^sha256:[0-9a-f]{64}$/u.test(
      completion.reasoningDigest
    )
    || !/^sha256:[0-9a-f]{64}$/u.test(
      completion.responseDigest
    )
    || !/^sha256:[0-9a-f]{64}$/u.test(
      completion.trace.sealDigest
    )
    || !/^sha256:[0-9a-f]{64}$/u.test(
      completion.trace.terminalDigest
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_provider_response_invalid',
      'Provider turn durable ordered response receipt is invalid.'
    );
  }
  let finalStarted = false;
  let toolOrdinal = 0;
  let providerNativeToolCount = 0;
  for (const item of response.items) {
    if (item.kind === 'text') {
      if (
        !item.text.trim()
        || new TextEncoder().encode(item.text).byteLength
          > 1024 * 1024
        || (
          item.phase !== 'commentary'
          && item.phase !== 'final_answer'
          && item.phase !== 'unknown'
        )
        || (finalStarted && item.phase === 'commentary')
      ) {
        throw new SessionKernelStateError(
          'session_kernel_provider_response_invalid',
          'Provider turn ordered text item is invalid.'
        );
      }
      if (item.phase === 'final_answer') finalStarted = true;
      continue;
    }
    toolOrdinal += 1;
    if (
      item.kind !== 'toolCall'
      || finalStarted
      || item.ordinal !== toolOrdinal
      || item.source !== 'providerNative'
      || !item.callId.trim()
      || !item.toolName.trim()
      || !item.toolId.trim()
    ) {
      throw new SessionKernelStateError(
        'session_kernel_provider_response_invalid',
        'Provider turn ordered tool item is invalid.'
      );
    }
    providerNativeToolCount += 1;
  }
  const native = completion.nativeCompletion;
  const settledSessionControl = outcome?.outputKind === 'plan'
    || outcome?.outputKind === 'planActionComplete'
    || outcome?.outputKind === 'intervention';
  const pendingSessionControl = turn.status === 'active'
    && (
      turn.target.kind === 'planning'
      || turn.target.kind === 'planAction'
      || turn.target.kind === 'interventionResearch'
    );
  const sessionControlToolCount = settledSessionControl
    || pendingSessionControl
    ? 1
    : 0;
  const planningInvalid = (
    turn.target.kind === 'planning'
    && response.items.some((item) =>
      item.kind === 'text' && item.phase !== 'commentary'
    )
  );
  const nativeCompletionInvalid = native.providerKind === 'openaiCompatible'
      ? native.terminalSignal !== '[DONE]'
        || (
          providerNativeToolCount + sessionControlToolCount > 0
            ? native.finishReason !== 'tool_calls'
            : native.finishReason !== 'stop'
        )
        || completion.reasoningTransport !== 'openaiPlaintext'
      : native.providerKind === 'anthropic'
        ? native.terminalSignal !== 'message_stop'
          || completion.reasoningTransport !== 'anthropicPlaintext'
        : native.providerKind === 'ollama'
          ? native.terminalSignal !== 'done:true'
            || completion.reasoningTransport !== 'ollamaPlaintext'
          : true;
  if (planningInvalid || nativeCompletionInvalid) {
    throw new SessionKernelStateError(
      'session_kernel_provider_response_invalid',
      'Provider turn native completion conflicts with ordered response.'
    );
  }
}

function validateFinalAnswerStateV3(
  finalAnswer: SessionFinalAnswerStateV3,
  state: SessionKernelLoopStateV2
): void {
  const binding = finalAnswer.binding;
  requiredIdentity(binding.inputId, 'finalAnswer.binding.inputId');
  validateSessionWorkAuthorityShapeV3(binding.workAuthority);
  positiveEpoch(binding.controlEpoch);
  if (
    !Number.isSafeInteger(binding.reviewRevision)
    || binding.reviewRevision < 1
    || !Number.isSafeInteger(binding.snapshotHighWater)
    || binding.snapshotHighWater < 0
    || !Number.isSafeInteger(finalAnswer.physicalRequestCount)
    || finalAnswer.physicalRequestCount < 0
    || finalAnswer.physicalRequestCount > 3
    || ![
      'pending',
      'requesting',
      'stale',
      'committed',
      'finalAnswerFailed',
    ].includes(finalAnswer.status)
  ) {
    throw new SessionKernelStateError(
      'session_kernel_final_answer_state_invalid',
      'Final-answer control state has an invalid binding, status, or physical request count.'
    );
  }
  if (binding.inputId !== state.currentInputId) {
    throw new SessionKernelStateError(
      'session_kernel_final_answer_authority_invalid',
      'Final-answer control state does not bind the current user input.'
    );
  }
  if (finalAnswer.status !== 'stale') {
    if (
      binding.controlEpoch !== state.controlEpoch
      || !state.workAuthority
      || !sameSessionWorkAuthorityV3(
        binding.workAuthority,
        state.workAuthority
      )
      || state.review?.status !== 'final'
      || state.review.revision !== binding.reviewRevision
      || state.review.snapshotHighWater !== binding.snapshotHighWater
      || !state.review.workAuthority
      || !sameSessionWorkAuthorityV3(
        state.review.workAuthority,
        binding.workAuthority
      )
      || state.lineage.cursor.snapshotHighWater
        !== binding.snapshotHighWater
    ) {
      throw new SessionKernelStateError(
        'session_kernel_final_answer_review_binding_invalid',
        'Live final-answer control state does not bind the frozen current Review.'
      );
    }
  }
  if (finalAnswer.providerTurnId !== undefined) {
    requiredIdentity(
      finalAnswer.providerTurnId,
      'finalAnswer.providerTurnId'
    );
  }
  for (const [field, value] of [
    ['startedAt', finalAnswer.startedAt],
    ['staleAt', finalAnswer.staleAt],
    ['committedAt', finalAnswer.committedAt],
    ['failedAt', finalAnswer.failedAt],
  ] as const) {
    if (value !== undefined) requiredText(value, `finalAnswer.${field}`);
  }
  if (finalAnswer.lastErrorCode !== undefined) {
    requiredIdentity(
      finalAnswer.lastErrorCode,
      'finalAnswer.lastErrorCode'
    );
  }
  const invalidStatusShape =
    (
      finalAnswer.status !== 'committed'
      && finalAnswer.commitKind !== undefined
    )
    || (
      finalAnswer.commitKind !== undefined
      && finalAnswer.commitKind !== 'candidatePromotion'
      && finalAnswer.commitKind !== 'finalSynthesis'
    )
    || (
      finalAnswer.status === 'pending'
        ? finalAnswer.physicalRequestCount >= 3
          || finalAnswer.providerTurnId !== undefined
          || finalAnswer.finalText !== undefined
        : finalAnswer.status === 'requesting'
          ? !finalAnswer.providerTurnId
            || !finalAnswer.startedAt
            || finalAnswer.finalText !== undefined
          : finalAnswer.status === 'stale'
            ? finalAnswer.finalText !== undefined
            : finalAnswer.status === 'committed'
              ? !finalAnswer.providerTurnId
                || !finalAnswer.committedAt
                || !finalAnswer.finalText?.trim()
                || (
                  finalAnswer.commitKind === 'candidatePromotion'
                    ? finalAnswer.physicalRequestCount !== 0
                    : finalAnswer.commitKind === 'finalSynthesis'
                      ? finalAnswer.physicalRequestCount < 1
                      : true
                )
              : !finalAnswer.failedAt
                || !finalAnswer.lastErrorCode
                || finalAnswer.finalText !== undefined
    );
  if (invalidStatusShape) {
    throw new SessionKernelStateError(
      'session_kernel_final_answer_state_invalid',
      'Final-answer control fields conflict with its durable status.'
    );
  }
  if (
    finalAnswer.finalText !== undefined
    && new TextEncoder().encode(finalAnswer.finalText).byteLength
      > 1024 * 1024
  ) {
    throw new SessionKernelStateError(
      'session_kernel_final_answer_text_invalid',
      'Committed final-answer text exceeds the durable size boundary.'
    );
  }
}

function validateTerminalAnswerCandidateV1(
  candidate: SessionTerminalAnswerCandidateV1,
  state: SessionKernelLoopStateV2
): void {
  if (
    candidate.schemaVersion
      !== 'deepcode.session.terminal-answer-candidate.v1'
    || candidate.inputId !== state.currentInputId
    || candidate.controlEpoch !== state.controlEpoch
    || candidate.languageRevision !== candidate.controlEpoch
    || !Number.isSafeInteger(candidate.snapshotHighWater)
    || candidate.snapshotHighWater < 0
    || candidate.snapshotHighWater
      > state.lineage.cursor.snapshotHighWater
    || !candidate.text.trim()
    || new TextEncoder().encode(candidate.text).byteLength
      > 1024 * 1024
    || candidate.textDigest !== sha256Hash(candidate.text)
    || !Array.isArray(candidate.sourceEventRefs)
    || candidate.sourceEventRefs.length === 0
    || new Set(candidate.sourceEventRefs).size
      !== candidate.sourceEventRefs.length
    || candidate.sourceEventRefs.some((ref) => !ref.trim())
    || !state.providerOutcomes.some((outcome) =>
      outcome.providerTurnId === candidate.providerTurnId
      && outcome.outputKind === 'answer'
      && outcome.recordedAt === candidate.recordedAt
      && outcome.summary === candidate.text.slice(0, 8_192)
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_terminal_answer_candidate_invalid',
      'Terminal answer candidate does not bind exact durable Provider and Session authority.'
    );
  }
  requiredIdentity(candidate.providerTurnId, 'terminalAnswerCandidate.providerTurnId');
  requiredText(candidate.recordedAt, 'terminalAnswerCandidate.recordedAt');
  validateSessionWorkAuthorityShapeV3(candidate.workAuthority);
  if (
    !state.workAuthority
    || !sameSessionWorkAuthorityV3(
      candidate.workAuthority,
      state.workAuthority
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_terminal_answer_candidate_authority_invalid',
      'Terminal answer candidate belongs to a different work authority.'
    );
  }
}

function validateReviewWorkAuthorityV3(
  review: SessionKernelReviewV2 | undefined,
  state: SessionKernelLoopStateV2
): void {
  if (!review) return;
  if (!review.workAuthority) {
    if (review.status === 'final') {
      throw new SessionKernelStateError(
        'session_kernel_review_work_authority_missing',
        'A final Review requires explicit durable work authority.'
      );
    }
    return;
  }
  validateSessionWorkAuthorityShapeV3(review.workAuthority);
  if (
    !state.workAuthority
    || !sameSessionWorkAuthorityV3(
      review.workAuthority,
      state.workAuthority
    )
    || (
      review.workAuthority.kind === 'plan'
      && review.planRevision !== review.workAuthority.planRevision
    )
    || (
      review.workAuthority.kind === 'contextRead'
      && review.planRevision !== undefined
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_review_work_authority_stale',
      'Review work authority does not bind the current Session work identity.'
    );
  }
}

function validateRunCancellation(
  cancellation: SessionRunCancellationV2,
  state: SessionKernelLoopStateV2
): void {
  requiredIdentity(cancellation.callerRequestId, 'callerRequestId');
  requiredIdentity(cancellation.cancelOperationId, 'cancelOperationId');
  requiredText(cancellation.requestedAt, 'requestedAt');
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(cancellation.callerRequestDigest)
    || ![
      'requested',
      'kernelSettled',
      'factsReconciled',
      'projected',
    ].includes(cancellation.status)
  ) {
    throw new SessionKernelStateError(
      'session_kernel_run_cancellation_invalid',
      'Session Run cancellation identity or status is invalid.'
    );
  }
  if (cancellation.invocationCancelRequestId) {
    requiredIdentity(
      cancellation.invocationCancelRequestId,
      'invocationCancelRequestId'
    );
  }
  if (
    cancellation.status !== 'requested'
    && (
      !cancellation.invocationCancelRequestId
      || !cancellation.cancellation
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_run_cancellation_invalid',
      'Settled Session Run cancellation has no Kernel reply.'
    );
  }
  if (cancellation.cancellation) {
    validateInvocationCancelReply(cancellation.cancellation, state);
  }
  if (
    cancellation.status === 'requested'
    && (
      cancellation.cancellation
      || cancellation.facts
      || cancellation.cancelledAt
      || cancellation.projection
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_run_cancellation_invalid',
      'Requested Session Run cancellation cannot carry settled evidence.'
    );
  }
  if (
    cancellation.status === 'kernelSettled'
    && (
      cancellation.facts
      || cancellation.cancelledAt
      || cancellation.projection
    )
  ) {
    throw new SessionKernelStateError(
      'session_kernel_run_cancellation_invalid',
      'Kernel-settled Session Run cancellation cannot carry unreconciled facts or projection evidence.'
    );
  }
  if (
    cancellation.status === 'factsReconciled'
    || cancellation.status === 'projected'
  ) {
    const facts = cancellation.facts;
    if (
      !facts
      || !Number.isSafeInteger(facts.afterLedgerSequence)
      || facts.afterLedgerSequence < 0
      || !Number.isSafeInteger(facts.snapshotHighWater)
      || facts.snapshotHighWater < 0
      || facts.afterLedgerSequence < facts.snapshotHighWater
      || !Number.isSafeInteger(facts.runSequenceHighWater)
      || facts.runSequenceHighWater < 0
      || facts.caughtUp !== true
      || facts.pendingFactBarrierCount !== 0
      || !cancellation.cancelledAt
    ) {
      throw new SessionKernelStateError(
        'session_kernel_run_cancellation_invalid',
        'Session Run cancellation facts proof is invalid.'
      );
    }
    requiredText(cancellation.cancelledAt, 'cancelledAt');
  }
  if (cancellation.status === 'projected') {
    if (
      !cancellation.projection
      || !/^sha256:[0-9a-f]{64}$/u.test(
        cancellation.projection.projectionDigest
      )
    ) {
      throw new SessionKernelStateError(
        'session_kernel_run_cancellation_invalid',
        'Projected Session Run cancellation has no delivery receipt.'
      );
    }
    requiredIdentity(
      cancellation.projection.projectionId,
      'projectionId'
    );
    if (
      cancellation.projection.projectionId
        !== `run:${state.runId}:cancel:${cancellation.cancelOperationId}:settled`
    ) {
      throw new SessionKernelStateError(
        'session_kernel_run_cancellation_invalid',
        'Projected Session Run cancellation has a non-deterministic projection identity.'
      );
    }
  } else if (cancellation.projection) {
    throw new SessionKernelStateError(
      'session_kernel_run_cancellation_invalid',
      'Unprojected Session Run cancellation cannot carry a delivery receipt.'
    );
  }
}

function validateInvocationCancelReply(
  value: unknown,
  state: SessionKernelLoopStateV2
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRunCancellationReply();
  }
  const reply = value as Record<string, unknown>;
  if (!hasExactFields(reply, ['kind', 'data'])) {
    throw invalidRunCancellationReply();
  }
  const data = reply.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidRunCancellationReply();
  }
  const fields = data as Record<string, unknown>;
  if (reply.kind === 'requested' || reply.kind === 'alreadyRequested') {
    if (
      !hasExactFields(fields, [
        'cancelRequestId',
        'invocationId',
        'factId',
        'ledgerSequence',
      ])
      || typeof fields.cancelRequestId !== 'string'
      || typeof fields.invocationId !== 'string'
      || typeof fields.factId !== 'string'
      || !Number.isSafeInteger(fields.ledgerSequence)
      || Number(fields.ledgerSequence) < 1
    ) {
      throw invalidRunCancellationReply();
    }
    requiredIdentity(fields.cancelRequestId, 'cancelRequestId');
    requiredIdentity(fields.invocationId, 'invocationId');
    requiredIdentity(fields.factId, 'factId');
    return;
  }
  if (reply.kind === 'noActiveInvocation') {
    if (
      !hasExactFields(fields, ['runId', 'controlEpoch'])
      || fields.runId !== state.runId
      || fields.controlEpoch !== state.controlEpoch
    ) {
      throw invalidRunCancellationReply();
    }
    return;
  }
  if (reply.kind === 'alreadyTerminal') {
    const terminalPhases = new Set([
      'attemptPrepared',
      'executing',
      'failedBeforeEffect',
      'cancelledBeforeEffect',
      'timedOutBeforeEffect',
      'completed',
      'failedAfterObservedEffect',
      'indeterminate',
    ]);
    if (
      !hasExactFields(fields, [
        'invocationId',
        'terminalFactId',
        'terminalPhase',
      ])
      || typeof fields.invocationId !== 'string'
      || typeof fields.terminalFactId !== 'string'
      || typeof fields.terminalPhase !== 'string'
      || !terminalPhases.has(fields.terminalPhase)
    ) {
      throw invalidRunCancellationReply();
    }
    requiredIdentity(fields.invocationId, 'invocationId');
    requiredIdentity(fields.terminalFactId, 'terminalFactId');
    return;
  }
  throw invalidRunCancellationReply();
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: string[]
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function stateRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function invalidRunCancellationReply(): SessionKernelStateError {
  return new SessionKernelStateError(
    'session_kernel_run_cancellation_invalid',
    'Kernel cancellation reply is not exact durable v2 data.'
  );
}

function boundedInputHistory(
  records: SessionUserInputRecordV2[],
  currentInputId: string
): {
  records: SessionUserInputRecordV2[];
  omittedCount: number;
} {
  if (records.length === 0) {
    return { records: [], omittedCount: 0 };
  }
  const pinnedIds = new Set([
    records[0]!.inputId,
    currentInputId,
  ]);
  const selected = new Set<string>();
  let bytes = 0;
  for (const record of records) {
    if (!pinnedIds.has(record.inputId)) continue;
    selected.add(record.inputId);
    bytes += jsonByteLength(record);
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (selected.has(record.inputId)) continue;
    const recordBytes = jsonByteLength(record);
    if (
      selected.size >= MAX_SESSION_INPUT_HISTORY_COUNT
      || bytes + recordBytes > MAX_SESSION_INPUT_HISTORY_BYTES
    ) {
      continue;
    }
    selected.add(record.inputId);
    bytes += recordBytes;
  }
  const bounded = records
    .filter((record) => selected.has(record.inputId))
    .map(cloneJson);
  return {
    records: bounded,
    omittedCount: records.length - bounded.length,
  };
}

function boundedProviderOutcomeHistory(
  records: SessionProviderOutcomeRecordV2[]
): {
  records: SessionProviderOutcomeRecordV2[];
  omittedCount: number;
} {
  const bounded: SessionProviderOutcomeRecordV2[] = [];
  let bytes = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    const recordBytes = jsonByteLength(record);
    if (
      bounded.length >= MAX_SESSION_PROVIDER_OUTCOME_COUNT
      || (
        bounded.length > 0
        && bytes + recordBytes > MAX_SESSION_PROVIDER_OUTCOME_BYTES
      )
    ) {
      continue;
    }
    bounded.push(cloneJson(record));
    bytes += recordBytes;
  }
  bounded.reverse();
  return {
    records: bounded,
    omittedCount: records.length - bounded.length,
  };
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SessionKernelStateError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelStateError';
  }
}
