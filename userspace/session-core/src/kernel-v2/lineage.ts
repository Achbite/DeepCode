import type {
  CapabilityLeaseRefV2,
  KernelFactProjectionV2,
  KernelFactProjectionPageV2,
  ScopeManifestV2,
  ToolIntentSubmitReplyV2,
  ToolIntentV2,
} from '@deepcode/protocol';

export const SESSION_KERNEL_LINEAGE_V2_SCHEMA =
  'deepcode.session.kernel-lineage.v2' as const;

export interface SessionKernelPlanActionLineageV2 {
  taskId: string;
  planRevision: string;
  planActionId: string;
  operationIds: string[];
}

export interface SessionKernelOperationLineageV2 {
  operationId: string;
  planActionId?: string;
  toolId?: string;
  leases: CapabilityLeaseRefV2[];
  invocationIds: string[];
  factIds: string[];
}

export interface SessionKernelInvocationLineageV2 {
  invocationId: string;
  operationId?: string;
  attemptIds: string[];
  factIds: string[];
  effectIds: string[];
  lastTerminalPhase?: string;
}

export interface SessionKernelFactIndexEntryV2 {
  factId: string;
  ledgerSequence: number;
  runSequence: number;
  domain: KernelFactProjectionV2['domain'];
  kind: string;
}

export interface SessionKernelLineageStateV2 {
  schemaVersion: typeof SESSION_KERNEL_LINEAGE_V2_SCHEMA;
  runId: string;
  taskPlanActions: Record<string, string[]>;
  planActions: Record<string, SessionKernelPlanActionLineageV2>;
  operations: Record<string, SessionKernelOperationLineageV2>;
  invocations: Record<string, SessionKernelInvocationLineageV2>;
  facts: Record<string, SessionKernelFactIndexEntryV2>;
  cursor: {
    afterLedgerSequence: number;
    hasMore: boolean;
    continuation?: string;
    snapshotHighWater: number;
  };
}

export interface SessionKernelFactsQueryV2 {
  runId: string;
  afterLedgerSequence: number;
  limit: number;
  continuation?: string;
}

export function createSessionKernelLineageStateV2(
  runId: string
): SessionKernelLineageStateV2 {
  if (!runId.trim()) {
    throw new SessionKernelLineageError(
      'session_kernel_lineage_run_missing',
      'Kernel lineage requires a run identity.'
    );
  }
  return {
    schemaVersion: SESSION_KERNEL_LINEAGE_V2_SCHEMA,
    runId,
    taskPlanActions: {},
    planActions: {},
    operations: {},
    invocations: {},
    facts: {},
    cursor: {
      afterLedgerSequence: 0,
      hasMore: false,
      snapshotHighWater: 0,
    },
  };
}

export function registerSessionPlanActionLineageV2(
  state: SessionKernelLineageStateV2,
  input: {
    taskId: string;
    manifest: ScopeManifestV2;
  }
): SessionKernelLineageStateV2 {
  const current = cloneLineageState(state);
  const existing = current.planActions[input.manifest.planActionId];
  if (
    existing
    && (
      existing.taskId !== input.taskId
      || existing.planRevision !== input.manifest.planRevision
    )
  ) {
    throw new SessionKernelLineageError(
      'session_kernel_plan_action_identity_conflict',
      `PlanAction ${input.manifest.planActionId} is already bound to another task or revision.`
    );
  }
  const planAction = existing ?? {
    taskId: requiredIdentity(input.taskId, 'taskId'),
    planRevision: requiredIdentity(input.manifest.planRevision, 'planRevision'),
    planActionId: requiredIdentity(input.manifest.planActionId, 'planActionId'),
    operationIds: [],
  };
  appendUnique(planAction.operationIds, input.manifest.operationId);
  current.planActions[planAction.planActionId] = planAction;
  const taskPlanActions = current.taskPlanActions[planAction.taskId] ?? [];
  appendUnique(taskPlanActions, planAction.planActionId);
  current.taskPlanActions[planAction.taskId] = taskPlanActions;
  const operation = current.operations[input.manifest.operationId]
    ?? emptyOperation(input.manifest.operationId);
  bindOperationPlanAction(operation, planAction.planActionId);
  bindOperationTool(operation, input.manifest.toolId);
  current.operations[operation.operationId] = operation;
  return current;
}

/**
 * Records only Kernel-issued opaque lease references. Session does not copy or
 * derive the canonical scope that produced the lease.
 */
export function recordSessionCapabilityLeaseV2(
  state: SessionKernelLineageStateV2,
  input: {
    operationId: string;
    planActionId: string;
    lease: CapabilityLeaseRefV2;
  }
): SessionKernelLineageStateV2 {
  const current = cloneLineageState(state);
  const operation = current.operations[input.operationId]
    ?? emptyOperation(input.operationId);
  bindOperationPlanAction(operation, input.planActionId);
  const existing = operation.leases.find(
    (lease) => lease.leaseId === input.lease.leaseId
      && lease.version === input.lease.version
  );
  if (existing && existing.scopeDigest !== input.lease.scopeDigest) {
    throw new SessionKernelLineageError(
      'session_kernel_lease_identity_conflict',
      `Lease ${input.lease.leaseId} version ${input.lease.version} changed scope digest.`
    );
  }
  if (!existing) operation.leases.push({ ...input.lease });
  operation.leases.sort(
    (left, right) => left.version - right.version
      || left.leaseId.localeCompare(right.leaseId)
  );
  current.operations[operation.operationId] = operation;
  return current;
}

export function clearSessionCapabilityLeasesV2(
  state: SessionKernelLineageStateV2,
  planActionId?: string
): SessionKernelLineageStateV2 {
  const current = cloneLineageState(state);
  for (const operation of Object.values(current.operations)) {
    if (
      planActionId !== undefined
      && operation.planActionId !== planActionId
    ) {
      continue;
    }
    operation.leases = [];
  }
  return current;
}

export function recordSessionToolIntentSubmissionV2(
  state: SessionKernelLineageStateV2,
  intent: ToolIntentV2,
  reply: ToolIntentSubmitReplyV2
): SessionKernelLineageStateV2 {
  if (intent.runId !== state.runId) {
    throw runMismatch(state.runId, intent.runId);
  }
  let current = cloneLineageState(state);
  const operation = current.operations[intent.operationId]
    ?? emptyOperation(intent.operationId);
  bindOperationTool(operation, intent.toolId);
  if (intent.authority.kind === 'planAction') {
    const planActionId = intent.authority.data.planActionId;
    bindOperationPlanAction(operation, planActionId);
    const planAction = current.planActions[planActionId];
    if (!planAction) {
      throw new SessionKernelLineageError(
        'session_kernel_plan_action_lineage_missing',
        `PlanAction ${planActionId} is not present in Session lineage.`
      );
    }
    appendUnique(planAction.operationIds, intent.operationId);
  }
  current.operations[intent.operationId] = operation;
  if (intent.authority.kind === 'planAction' && intent.authority.data.lease) {
    current = recordSessionCapabilityLeaseV2(current, {
      operationId: intent.operationId,
      planActionId: intent.authority.data.planActionId,
      lease: intent.authority.data.lease,
    });
  }
  const recordedOperation = current.operations[intent.operationId]!;
  if (reply.kind === 'admitted' && reply.data.lease) {
    const planActionId = intent.authority.kind === 'planAction'
      ? intent.authority.data.planActionId
      : undefined;
    if (planActionId) {
      current = recordSessionCapabilityLeaseV2(current, {
        operationId: intent.operationId,
        planActionId,
        lease: reply.data.lease,
      });
    }
  }
  const invocationId = reply.kind === 'admitted'
    || reply.kind === 'awaitingCapability'
    ? reply.data.invocationId
    : undefined;
  if (invocationId) {
    const latestOperation = current.operations[intent.operationId] ?? recordedOperation;
    appendUnique(latestOperation.invocationIds, invocationId);
    const invocation = current.invocations[invocationId]
      ?? emptyInvocation(invocationId);
    bindInvocationOperation(invocation, intent.operationId);
    if (reply.kind === 'admitted') {
      appendUnique(invocation.attemptIds, reply.data.attemptId);
    }
    current.invocations[invocationId] = invocation;
  }
  return current;
}

export function reduceSessionKernelFactsV2(
  state: SessionKernelLineageStateV2,
  page: KernelFactProjectionPageV2
): SessionKernelLineageStateV2 {
  if (page.requestedAfterLedgerSequence !== state.cursor.afterLedgerSequence) {
    throw new SessionKernelLineageError(
      'session_kernel_fact_cursor_mismatch',
      'Kernel facts page does not continue the current Session cursor.'
    );
  }
  if (
    state.cursor.continuation
    && page.snapshotHighWater !== state.cursor.snapshotHighWater
  ) {
    throw new SessionKernelLineageError(
      'session_kernel_fact_snapshot_mismatch',
      'A continued Kernel facts page changed its snapshot high-water.'
    );
  }
  let current = cloneLineageState(state);
  for (const fact of page.facts) {
    const existing = current.facts[fact.factId];
    if (existing) {
      if (
        existing.ledgerSequence !== fact.ledgerSequence
        || existing.runSequence !== fact.runSequence
        || existing.domain !== fact.domain
        || existing.kind !== fact.factKind
      ) {
        throw new SessionKernelLineageError(
          'session_kernel_fact_identity_conflict',
          `Kernel fact ${fact.factId} changed immutable envelope fields.`
        );
      }
      continue;
    }
    current.facts[fact.factId] = {
      factId: fact.factId,
      ledgerSequence: fact.ledgerSequence,
      runSequence: fact.runSequence,
      domain: fact.domain,
      kind: fact.factKind,
    };
    current = reduceFactLineage(current, fact);
  }
  current.cursor = {
    afterLedgerSequence: Math.max(
      current.cursor.afterLedgerSequence,
      page.nextAfterLedgerSequence
    ),
    hasMore: page.hasMore,
    ...(page.nextContinuation
      ? { continuation: page.nextContinuation }
      : {}),
    snapshotHighWater: Math.max(
      current.cursor.snapshotHighWater,
      page.snapshotHighWater
    ),
  };
  return current;
}

export function nextSessionKernelFactsQueryV2(
  state: SessionKernelLineageStateV2,
  limit = 256
): SessionKernelFactsQueryV2 {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new SessionKernelLineageError(
      'session_kernel_fact_limit_invalid',
      'Kernel facts query limit must be between 1 and 1000.'
    );
  }
  return {
    runId: state.runId,
    afterLedgerSequence: state.cursor.afterLedgerSequence,
    limit,
    ...(state.cursor.continuation
      ? { continuation: state.cursor.continuation }
      : {}),
  };
}

export function sessionKernelFactsCaughtUpV2(
  state: SessionKernelLineageStateV2
): boolean {
  return !state.cursor.hasMore
    && state.cursor.afterLedgerSequence >= state.cursor.snapshotHighWater;
}

function reduceFactLineage(
  state: SessionKernelLineageStateV2,
  fact: KernelFactProjectionV2
): SessionKernelLineageStateV2 {
  if (fact.lineage.runId !== state.runId) {
    throw runMismatch(state.runId, fact.lineage.runId);
  }
  const operationId = fact.lineage.operationId;
  if (operationId) {
    const operation = state.operations[operationId] ?? emptyOperation(operationId);
    if (fact.lineage.planActionIds.length === 1) {
      bindOperationPlanAction(operation, fact.lineage.planActionIds[0]!);
    }
    appendUnique(operation.factIds, fact.factId);
    if (fact.lineage.invocationId) {
      appendUnique(operation.invocationIds, fact.lineage.invocationId);
    }
    state.operations[operationId] = operation;
  }
  if (fact.lineage.invocationId) {
    const invocation = state.invocations[fact.lineage.invocationId]
      ?? emptyInvocation(fact.lineage.invocationId);
    if (operationId) bindInvocationOperation(invocation, operationId);
    if (fact.lineage.attemptId) {
      appendUnique(invocation.attemptIds, fact.lineage.attemptId);
    }
    if (fact.lineage.effectId) {
      appendUnique(invocation.effectIds, fact.lineage.effectId);
    }
    appendUnique(invocation.factIds, fact.factId);
    state.invocations[invocation.invocationId] = invocation;
  }
  return state;
}

function emptyOperation(operationId: string): SessionKernelOperationLineageV2 {
  return {
    operationId: requiredIdentity(operationId, 'operationId'),
    leases: [],
    invocationIds: [],
    factIds: [],
  };
}

function emptyInvocation(invocationId: string): SessionKernelInvocationLineageV2 {
  return {
    invocationId: requiredIdentity(invocationId, 'invocationId'),
    attemptIds: [],
    factIds: [],
    effectIds: [],
  };
}

function bindOperationPlanAction(
  operation: SessionKernelOperationLineageV2,
  planActionId: string
): void {
  const identity = requiredIdentity(planActionId, 'planActionId');
  if (operation.planActionId && operation.planActionId !== identity) {
    throw new SessionKernelLineageError(
      'session_kernel_operation_plan_action_conflict',
      `Operation ${operation.operationId} is already bound to another PlanAction.`
    );
  }
  operation.planActionId = identity;
}

function bindOperationTool(
  operation: SessionKernelOperationLineageV2,
  toolId: string
): void {
  const identity = requiredIdentity(toolId, 'toolId');
  if (operation.toolId && operation.toolId !== identity) {
    throw new SessionKernelLineageError(
      'session_kernel_operation_tool_conflict',
      `Operation ${operation.operationId} is already bound to another tool.`
    );
  }
  operation.toolId = identity;
}

function bindInvocationOperation(
  invocation: SessionKernelInvocationLineageV2,
  operationId: string
): void {
  const identity = requiredIdentity(operationId, 'operationId');
  if (invocation.operationId && invocation.operationId !== identity) {
    throw new SessionKernelLineageError(
      'session_kernel_invocation_operation_conflict',
      `Invocation ${invocation.invocationId} is already bound to another operation.`
    );
  }
  invocation.operationId = identity;
}

function appendUnique(values: string[], value: string): void {
  const identity = requiredIdentity(value, 'lineage identity');
  if (!values.includes(identity)) values.push(identity);
}

function requiredIdentity(value: string, field: string): string {
  if (!value.trim()) {
    throw new SessionKernelLineageError(
      'session_kernel_lineage_identity_missing',
      `${field} must not be empty.`
    );
  }
  return value;
}

function runMismatch(expected: string, actual: string): SessionKernelLineageError {
  return new SessionKernelLineageError(
    'session_kernel_lineage_run_mismatch',
    `Kernel lineage expected run ${expected}, received ${actual}.`
  );
}

function cloneLineageState(
  state: SessionKernelLineageStateV2
): SessionKernelLineageStateV2 {
  return {
    ...state,
    taskPlanActions: Object.fromEntries(
      Object.entries(state.taskPlanActions)
        .map(([key, values]) => [key, [...values]])
    ),
    planActions: Object.fromEntries(
      Object.entries(state.planActions)
        .map(([key, value]) => [
          key,
          { ...value, operationIds: [...value.operationIds] },
        ])
    ),
    operations: Object.fromEntries(
      Object.entries(state.operations)
        .map(([key, value]) => [
          key,
          {
            ...value,
            leases: value.leases.map((lease) => ({ ...lease })),
            invocationIds: [...value.invocationIds],
            factIds: [...value.factIds],
          },
        ])
    ),
    invocations: Object.fromEntries(
      Object.entries(state.invocations)
        .map(([key, value]) => [
          key,
          {
            ...value,
            attemptIds: [...value.attemptIds],
            factIds: [...value.factIds],
            effectIds: [...value.effectIds],
          },
        ])
    ),
    facts: Object.fromEntries(
      Object.entries(state.facts)
        .map(([key, value]) => [key, { ...value }])
    ),
    cursor: { ...state.cursor },
  };
}

export class SessionKernelLineageError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelLineageError';
  }
}
