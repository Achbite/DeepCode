import type {
  CapabilityScopePreviewRecordV2,
  KernelFactProjectionV2,
  ToolContextBundleV2,
} from '@deepcode/protocol';
import {
  createSessionKernelLineageStateV2,
  registerSessionPlanActionLineageV2,
  type SessionKernelLineageStateV2,
} from './lineage.js';
import {
  createSessionToolContextStateV2,
  type SessionToolContextStateV2,
} from './toolContext.js';
import {
  SESSION_KERNEL_CHECKPOINT_V2_SCHEMA,
  SESSION_KERNEL_LOOP_V2_SCHEMA,
  type SessionActiveWaitV2,
  type SessionKernelPublicRequestRecordV2,
  type SessionKernelReviewV2,
  type SessionNaturalLanguagePlanV2,
  type SessionPlanDecisionV2,
  type SessionProviderTurnRecordV2,
  type SessionProviderOutcomeRecordV2,
  type SessionPlanActionSettlementV2,
  type SessionReviewFactAccumulatorV2,
  type SessionUserInputRecordV2,
} from './types.js';

const MAX_SESSION_INPUT_HISTORY_COUNT = 32;
const MAX_SESSION_INPUT_HISTORY_BYTES = 512 * 1024;
const MAX_SESSION_PROVIDER_OUTCOME_COUNT = 128;
const MAX_SESSION_PROVIDER_OUTCOME_BYTES = 256 * 1024;
const MAX_SESSION_PLAN_ACTIONS = 256;
const MAX_SESSION_PLAN_BYTES = 512 * 1024;

export interface SessionKernelLoopStateV2 {
  schemaVersion: typeof SESSION_KERNEL_LOOP_V2_SCHEMA;
  runId: string;
  workspaceBindingDigest: string;
  controlEpoch: number;
  currentInputId: string;
  inputs: SessionUserInputRecordV2[];
  inputHistoryOmittedCount: number;
  pendingEpochInput?: SessionUserInputRecordV2;
  projectedInputIds: string[];
  toolContext: SessionToolContextStateV2;
  plan?: SessionNaturalLanguagePlanV2;
  planDecision?: SessionPlanDecisionV2;
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
  providerOutcomes: SessionProviderOutcomeRecordV2[];
  providerOutcomeHistoryOmittedCount: number;
  planActionSettlements: Record<string, SessionPlanActionSettlementV2>;
  publicRequests: Partial<
    Record<
      SessionKernelPublicRequestRecordV2['lane'],
      SessionKernelPublicRequestRecordV2
    >
  >;
  review?: SessionKernelReviewV2;
  kernelWakeHint: boolean;
  checkpointRevision: number;
}

export interface SessionKernelCheckpointV2 {
  schemaVersion: typeof SESSION_KERNEL_CHECKPOINT_V2_SCHEMA;
  checkpointRevision: number;
  savedAt: string;
  state: SessionKernelLoopStateV2;
}

export interface SessionKernelInitialStateV2 {
  runId: string;
  workspaceBindingDigest: string;
  controlEpoch: number;
  initialInput: SessionUserInputRecordV2;
  toolContext: ToolContextBundleV2;
}

export function createSessionKernelLoopStateV2(
  initial: SessionKernelInitialStateV2
): SessionKernelLoopStateV2 {
  positiveEpoch(initial.controlEpoch);
  validateUserInput(initial.initialInput);
  return {
    schemaVersion: SESSION_KERNEL_LOOP_V2_SCHEMA,
    runId: requiredIdentity(initial.runId, 'runId'),
    workspaceBindingDigest: requiredIdentity(
      initial.workspaceBindingDigest,
      'workspaceBindingDigest'
    ),
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
    publicRequests: {},
    kernelWakeHint: false,
    checkpointRevision: 0,
  };
}

export function restoreSessionKernelLoopStateV2(
  checkpoint: SessionKernelCheckpointV2,
  expected: {
    runId: string;
    workspaceBindingDigest: string;
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
  ) {
    throw new SessionKernelStateError(
      'session_kernel_checkpoint_identity_mismatch',
      'Session Kernel checkpoint does not match the active Kernel run.'
    );
  }
  positiveEpoch(state.controlEpoch);
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
  if (state.planDecision) {
    validatePlanDecision(state.planDecision);
    if (state.planDecision.planRevision !== state.plan?.planRevision) {
      throw new SessionKernelStateError(
        'session_kernel_checkpoint_plan_decision_mismatch',
        'Checkpoint Plan decision does not bind the current Plan revision.'
      );
    }
  }
  state.projectedInputIds = (state.projectedInputIds ?? [])
    .filter((inputId) =>
      state.inputs.some((input) => input.inputId === inputId)
    );
  state.providerOutcomes ??= [];
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
  state.factHistoryOmittedCount = nonnegativeSafeInteger(
    state.factHistoryOmittedCount ?? 0,
    'factHistoryOmittedCount'
  );
  state.reviewFacts ??= createSessionReviewFactAccumulatorV2(
    state.controlEpoch,
    0
  );
  for (const [planActionId, settlement] of Object.entries(
    state.planActionSettlements
  )) {
    validatePlanActionSettlement(settlement);
    if (
      settlement.planActionId !== planActionId
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
  if (state.providerTurn?.status === 'active') {
    state.providerTurn = {
      ...state.providerTurn,
      status: 'stale',
      cancellationReason: 'shutdown',
    };
  }
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
  let next = cloneSessionKernelLoopStateV2(state);
  if (next.plan?.planRevision !== plan.planRevision) {
    next.planActionSettlements = {};
    next.previews = {};
    next.planDecision = undefined;
    next.projectedPlanDecisionKey = undefined;
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
  if (
    next.planDecision
    && JSON.stringify(next.planDecision) !== JSON.stringify(decision)
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_decision_conflict',
      `Plan revision ${decision.planRevision} already has a different durable decision.`
    );
  }
  next.planDecision = cloneJson(decision);
  next.projectedPlanDecisionKey = undefined;
  if (decision.decision !== 'accept' && decision.guidance) {
    if (!next.pendingGuidance.includes(decision.guidance)) {
      next.pendingGuidance.push(decision.guidance);
    }
  }
  return next;
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
  next.plan = undefined;
  next.planDecision = undefined;
  next.projectedPlanRevision = undefined;
  next.projectedPlanDecisionKey = undefined;
  next.previews = {};
  next.planActionSettlements = {};
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
  return next;
}

export function recordSessionProviderOutcomeV2(
  state: SessionKernelLoopStateV2,
  outcome: SessionProviderOutcomeRecordV2
): void {
  state.providerOutcomes.push(cloneJson(outcome));
  const bounded = boundedProviderOutcomeHistory(
    state.providerOutcomes
  );
  state.providerOutcomes = bounded.records;
  state.providerOutcomeHistoryOmittedCount +=
    bounded.omittedCount;
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

export function checkpointSessionKernelStateV2(
  state: SessionKernelLoopStateV2,
  savedAt: string
): SessionKernelCheckpointV2 {
  const next = cloneSessionKernelLoopStateV2(state);
  next.checkpointRevision += 1;
  next.factsById = {};
  next.factHistoryOmittedCount = 0;
  next.reviewFacts = createSessionReviewFactAccumulatorV2(
    state.reviewFacts.controlEpoch,
    state.reviewFacts.coverageAfterLedgerSequence
  );
  next.lineage = createSessionKernelLineageStateV2(next.runId);
  for (const action of next.plan?.actions ?? []) {
    next.lineage = registerSessionPlanActionLineageV2(
      next.lineage,
      {
        taskId: action.taskId,
        manifest: action.manifest,
      }
    );
  }
  return {
    schemaVersion: SESSION_KERNEL_CHECKPOINT_V2_SCHEMA,
    checkpointRevision: next.checkpointRevision,
    savedAt,
    state: next,
  };
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
    authorizedOperationSequences: {},
    pendingCleanupByResource: {},
  };
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

function validateUserInput(input: SessionUserInputRecordV2): void {
  requiredIdentity(input.inputId, 'inputId');
  requiredIdentity(input.opaqueInputRef, 'opaqueInputRef');
  requiredText(input.text, 'input.text');
  requiredText(input.recordedAt, 'input.recordedAt');
}

function validatePlanActionSettlement(
  settlement: SessionPlanActionSettlementV2
): void {
  requiredIdentity(settlement.planActionId, 'planActionId');
  requiredText(settlement.recordedAt, 'settlement.recordedAt');
  if (settlement.kind === 'skipped') {
    requiredText(settlement.reason, 'settlement.reason');
    return;
  }
  if (
    settlement.completionKind !== 'answer'
    && settlement.completionKind !== 'noTool'
  ) {
    throw new SessionKernelStateError(
      'session_kernel_plan_action_completion_invalid',
      'PlanAction completion kind must be answer or noTool.'
    );
  }
  requiredIdentity(
    settlement.providerTurnId,
    'settlement.providerTurnId'
  );
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

function requiredText(value: string, field: string): void {
  if (!value.trim() || new TextEncoder().encode(value).byteLength > 64 * 1024) {
    throw new SessionKernelStateError(
      'session_kernel_state_text_invalid',
      `${field} must contain 1..=65536 UTF-8 bytes.`
    );
  }
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
