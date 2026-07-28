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
  type SessionProviderTurnRecordV2,
  type SessionUserInputRecordV2,
} from './types.js';

export interface SessionKernelLoopStateV2 {
  schemaVersion: typeof SESSION_KERNEL_LOOP_V2_SCHEMA;
  runId: string;
  workspaceBindingDigest: string;
  controlEpoch: number;
  currentInputId: string;
  inputs: SessionUserInputRecordV2[];
  pendingEpochInput?: SessionUserInputRecordV2;
  projectedInputIds: string[];
  toolContext: SessionToolContextStateV2;
  plan?: SessionNaturalLanguagePlanV2;
  projectedPlanRevision?: string;
  lineage: SessionKernelLineageStateV2;
  previews: Record<string, CapabilityScopePreviewRecordV2>;
  factsById: Record<string, KernelFactProjectionV2>;
  activeWait?: SessionActiveWaitV2;
  pendingGuidance: string[];
  providerTurn?: SessionProviderTurnRecordV2;
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
    projectedInputIds: [],
    toolContext: createSessionToolContextStateV2(initial.toolContext),
    lineage: createSessionKernelLineageStateV2(initial.runId),
    previews: {},
    factsById: {},
    pendingGuidance: [],
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
  if (state.plan) {
    validatePlan(state.plan);
    if (state.plan.inputId !== state.currentInputId) {
      throw new SessionKernelStateError(
        'session_kernel_checkpoint_plan_input_mismatch',
        'Checkpoint Plan does not belong to the current user input.'
      );
    }
  }
  state.projectedInputIds ??= [];
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
  next.pendingEpochInput = cloneJson(input);
  next.plan = undefined;
  next.projectedPlanRevision = undefined;
  next.previews = {};
  return next;
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
  return {
    schemaVersion: SESSION_KERNEL_CHECKPOINT_V2_SCHEMA,
    checkpointRevision: next.checkpointRevision,
    savedAt,
    state: next,
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

function validateUserInput(input: SessionUserInputRecordV2): void {
  requiredIdentity(input.inputId, 'inputId');
  requiredIdentity(input.opaqueInputRef, 'opaqueInputRef');
  requiredText(input.text, 'input.text');
  requiredText(input.recordedAt, 'input.recordedAt');
}

function positiveEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SessionKernelStateError(
      'session_kernel_state_epoch_invalid',
      'Session Kernel controlEpoch must be a positive safe integer.'
    );
  }
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
