import type {
  SessionTaskDefinitionV1,
  TaskFailureV2,
  TaskLedgerEntryV2,
  TaskLedgerOwnerV2,
  TaskLedgerSnapshotV2,
  TaskSettlementV2,
} from '@deepcode/protocol';

export type TaskLedgerSnapshot = TaskLedgerSnapshotV2;
export type TaskLedgerEntry = TaskLedgerEntryV2;
export type TaskLedgerStatus = TaskLedgerEntryV2['status'];

export class TaskLedgerV2Error extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TaskLedgerV2Error';
  }
}

export function createTaskLedgerV2(input: {
  owner: TaskLedgerOwnerV2;
  tasks: readonly SessionTaskDefinitionV1[];
  sourceRefs: readonly string[];
}): TaskLedgerSnapshotV2 {
  validateOwner(input.owner);
  const definitions = normalizeDefinitions(input.tasks);
  const pendingEntries = definitions.map((task): TaskLedgerEntryV2 => ({
    ...task,
    status: 'pending',
  }));
  const activeTaskId = nextReadyTaskId(pendingEntries, new Set());
  if (definitions.length > 0 && !activeTaskId) {
    throw new TaskLedgerV2Error(
      'session_task_ledger_invalid',
      'Initial TaskLedgerV2 has no dependency-ready task.'
    );
  }
  return snapshot({
    owner: input.owner,
    revision: 1,
    entries: pendingEntries.map((task): TaskLedgerEntryV2 => ({
      ...task,
      status: task.taskId === activeTaskId ? 'active' : 'pending',
    })),
    sourceRefs: normalizedRefs(input.sourceRefs),
  });
}

export function settleTaskLedgerV2(input: {
  ledger: TaskLedgerSnapshotV2;
  taskId: string;
  settlement: TaskSettlementV2;
  sourceRefs: readonly string[];
}): TaskLedgerSnapshotV2 {
  const ledger = parseTaskLedgerV2(input.ledger);
  validateSettlement(input.settlement);
  const active = ledger.entries.find((entry) => entry.status === 'active');
  if (!active || active.taskId !== input.taskId) {
    throw new TaskLedgerV2Error(
      'session_task_ledger_transition_invalid',
      `Task ${input.taskId} is not the exact active TaskLedgerV2 entry.`
    );
  }
  const settled = new Set([
    ...ledger.settledTaskIds,
    input.taskId,
  ]);
  const nextTaskId = nextReadyTaskId(ledger.entries, settled);
  const entries = ledger.entries.map((entry): TaskLedgerEntryV2 => {
    if (entry.taskId === input.taskId) {
      return {
        ...definition(entry),
        status: 'settled',
        settlement: structuredClone(input.settlement),
      };
    }
    if (entry.status === 'pending' && entry.taskId === nextTaskId) {
      return { ...definition(entry), status: 'active' };
    }
    return structuredClone(entry);
  });
  return snapshot({
    owner: ledger.owner,
    revision: ledger.revision + 1,
    entries,
    sourceRefs: normalizedRefs([...ledger.sourceRefs, ...input.sourceRefs]),
  });
}

export function failTaskLedgerV2(input: {
  ledger: TaskLedgerSnapshotV2;
  taskId: string;
  failure: TaskFailureV2;
  sourceRefs: readonly string[];
}): TaskLedgerSnapshotV2 {
  const ledger = parseTaskLedgerV2(input.ledger);
  validateFailure(input.failure);
  const active = ledger.entries.find((entry) => entry.status === 'active');
  if (!active || active.taskId !== input.taskId) {
    throw new TaskLedgerV2Error(
      'session_task_ledger_transition_invalid',
      `Task ${input.taskId} is not the exact active TaskLedgerV2 entry.`
    );
  }
  return snapshot({
    owner: ledger.owner,
    revision: ledger.revision + 1,
    entries: ledger.entries.map((entry): TaskLedgerEntryV2 => (
      entry.taskId === input.taskId
        ? {
            ...definition(entry),
            status: 'failed',
            failure: structuredClone(input.failure),
          }
        : structuredClone(entry)
    )),
    sourceRefs: normalizedRefs([...ledger.sourceRefs, ...input.sourceRefs]),
  });
}

export function parseTaskLedgerV2(value: unknown): TaskLedgerSnapshotV2 {
  const ledger = objectRecord(value);
  if (
    ledger?.schemaVersion !== 'deepcode.session.task-ledger.v2'
    || !positiveInteger(ledger.revision)
    || !Array.isArray(ledger.entries)
    || !identityList(ledger.taskOrder)
    || !identityList(ledger.settledTaskIds)
    || !identityList(ledger.failedTaskIds)
    || !identityList(ledger.pendingTaskIds)
    || !identityList(ledger.sourceRefs)
  ) {
    invalidLedger();
  }
  validateOwner(ledger.owner as TaskLedgerOwnerV2);
  const entries = ledger.entries.map(parseEntry);
  const rebuilt = snapshot({
    owner: structuredClone(ledger.owner as TaskLedgerOwnerV2),
    revision: ledger.revision as number,
    entries,
    sourceRefs: ledger.sourceRefs as string[],
  });
  if (
    canonical(rebuilt.taskOrder) !== canonical(ledger.taskOrder)
    || rebuilt.currentTaskId !== ledger.currentTaskId
    || canonical(rebuilt.settledTaskIds) !== canonical(ledger.settledTaskIds)
    || canonical(rebuilt.failedTaskIds) !== canonical(ledger.failedTaskIds)
    || canonical(rebuilt.pendingTaskIds) !== canonical(ledger.pendingTaskIds)
  ) {
    invalidLedger();
  }
  return rebuilt;
}

export function taskLedgerAllSettled(ledger: TaskLedgerSnapshotV2): boolean {
  const parsed = parseTaskLedgerV2(ledger);
  return parsed.entries.length > 0
    && parsed.entries.every((entry) => entry.status === 'settled');
}

export function activeTaskEntry(
  ledger: TaskLedgerSnapshotV2
): TaskLedgerEntryV2 | undefined {
  return parseTaskLedgerV2(ledger).entries.find(
    (entry) => entry.status === 'active'
  );
}

export function taskLedgerKernelCompletedTaskIds(
  ledger: TaskLedgerSnapshotV2
): string[] {
  return parseTaskLedgerV2(ledger).entries.flatMap((entry) => (
    entry.status === 'settled' && entry.settlement?.kind === 'kernelFacts'
      ? [entry.taskId]
      : []
  ));
}

export function taskLedgerUserSettledTaskIds(
  ledger: TaskLedgerSnapshotV2
): string[] {
  return parseTaskLedgerV2(ledger).entries.flatMap((entry) => (
    entry.status === 'settled' && entry.settlement?.kind === 'userDecision'
      ? [entry.taskId]
      : []
  ));
}

export function taskLedgerDeterministicallySettledTaskIds(
  ledger: TaskLedgerSnapshotV2
): string[] {
  return parseTaskLedgerV2(ledger).entries.flatMap((entry) => (
    entry.status === 'settled'
      && entry.settlement?.kind === 'deterministicCriterion'
      ? [entry.taskId]
      : []
  ));
}

function snapshot(input: {
  owner: TaskLedgerOwnerV2;
  revision: number;
  entries: TaskLedgerEntryV2[];
  sourceRefs: string[];
}): TaskLedgerSnapshotV2 {
  validateOwner(input.owner);
  if (!positiveInteger(input.revision)) invalidLedger();
  if (!input.entries.length) invalidLedger();
  const active = input.entries.filter((entry) => entry.status === 'active');
  if (active.length > 1) invalidLedger();
  const settled = new Set(
    input.entries
      .filter((entry) => entry.status === 'settled')
      .map((entry) => entry.taskId)
  );
  const failed = input.entries.some((entry) => entry.status === 'failed');
  const unfinished = input.entries.some(
    (entry) => entry.status === 'pending' || entry.status === 'active'
  );
  if (
    (!failed && unfinished && active.length !== 1)
    || active.some((entry) =>
      entry.dependencies.some((dependency) => !settled.has(dependency))
    )
  ) {
    invalidLedger();
  }
  const taskOrder = input.entries.map((entry) => entry.taskId);
  return {
    schemaVersion: 'deepcode.session.task-ledger.v2',
    owner: structuredClone(input.owner),
    revision: input.revision,
    taskOrder,
    currentTaskId: active[0]?.taskId,
    settledTaskIds: input.entries
      .filter((entry) => entry.status === 'settled')
      .map((entry) => entry.taskId),
    failedTaskIds: input.entries
      .filter((entry) => entry.status === 'failed')
      .map((entry) => entry.taskId),
    pendingTaskIds: input.entries
      .filter((entry) => entry.status === 'pending')
      .map((entry) => entry.taskId),
    entries: structuredClone(input.entries),
    sourceRefs: normalizedRefs(input.sourceRefs),
  };
}

function normalizeDefinitions(
  tasks: readonly SessionTaskDefinitionV1[]
): SessionTaskDefinitionV1[] {
  if (!tasks.length) {
    throw new TaskLedgerV2Error(
      'session_task_ledger_invalid',
      'TaskLedgerV2 requires at least one task.'
    );
  }
  const definitions = tasks.map((task) => normalizeDefinition(task));
  const taskIds = definitions.map((task) => task.taskId);
  if (new Set(taskIds).size !== taskIds.length) invalidLedger();
  const known = new Set(taskIds);
  for (const task of definitions) {
    if (
      task.dependencies.includes(task.taskId)
      || task.dependencies.some((dependency) => !known.has(dependency))
    ) {
      invalidLedger();
    }
  }
  assertAcyclic(definitions);
  return definitions;
}

function normalizeDefinition(value: SessionTaskDefinitionV1): SessionTaskDefinitionV1 {
  const record = objectRecord(value);
  if (
    !record
    || !nonEmpty(record.taskId)
    || record.required !== true
    || !identityList(record.targets)
    || !identityList(record.dependencies)
    || !identityList(record.acceptanceCriteria)
    || !identityList(record.failureCriteria)
    || (record.title !== undefined && !nonEmpty(record.title))
    || (record.toolId !== undefined && !nonEmpty(record.toolId))
  ) {
    invalidLedger();
  }
  return {
    taskId: record.taskId as string,
    title: record.title as string | undefined,
    targets: [...(record.targets as string[])],
    toolId: record.toolId as string | undefined,
    dependencies: [...(record.dependencies as string[])],
    acceptanceCriteria: [...(record.acceptanceCriteria as string[])],
    failureCriteria: [...(record.failureCriteria as string[])],
    required: true,
  };
}

function parseEntry(value: unknown): TaskLedgerEntryV2 {
  const record = objectRecord(value);
  if (!record) invalidLedger();
  const definitionValue = normalizeDefinition(value as SessionTaskDefinitionV1);
  const status = record.status;
  if (
    status !== 'pending'
    && status !== 'active'
    && status !== 'settled'
    && status !== 'failed'
  ) {
    invalidLedger();
  }
  if (status === 'settled') {
    validateSettlement(record.settlement as TaskSettlementV2);
    if (record.failure !== undefined) invalidLedger();
    return {
      ...definitionValue,
      status,
      settlement: structuredClone(record.settlement as TaskSettlementV2),
    };
  }
  if (status === 'failed') {
    validateFailure(record.failure as TaskFailureV2);
    if (record.settlement !== undefined) invalidLedger();
    return {
      ...definitionValue,
      status,
      failure: structuredClone(record.failure as TaskFailureV2),
    };
  }
  if (record.settlement !== undefined || record.failure !== undefined) {
    invalidLedger();
  }
  return { ...definitionValue, status };
}

function definition(entry: TaskLedgerEntryV2): SessionTaskDefinitionV1 {
  return {
    taskId: entry.taskId,
    title: entry.title,
    targets: [...entry.targets],
    toolId: entry.toolId,
    dependencies: [...entry.dependencies],
    acceptanceCriteria: [...entry.acceptanceCriteria],
    failureCriteria: [...entry.failureCriteria],
    required: true,
  };
}

function validateOwner(value: TaskLedgerOwnerV2): void {
  const owner = objectRecord(value);
  if (
    !owner
    || !nonEmpty(owner.kind)
    || !nonEmpty(owner.planId)
    || (
      owner.kind === 'goal'
      && (
        !nonEmpty(owner.goalId)
        || !positiveInteger(owner.goalRevision)
        || !nonEmpty(owner.confirmedPlanRef)
      )
    )
    || (
      owner.kind === 'run'
      && !nonEmpty(owner.runId)
    )
    || (owner.kind !== 'goal' && owner.kind !== 'run')
  ) {
    invalidLedger();
  }
}

function validateSettlement(value: TaskSettlementV2): void {
  const settlement = objectRecord(value);
  if (settlement?.kind === 'kernelFacts') {
    if (
      settlement.outcome !== 'completed'
      || !Array.isArray(settlement.kernelFactRefs)
      || settlement.kernelFactRefs.length === 0
      || settlement.kernelFactRefs.some((ref) => !validKernelFactRef(ref))
    ) {
      invalidLedger();
    }
    return;
  }
  if (settlement?.kind === 'userDecision') {
    const interaction = objectRecord(settlement.interaction);
    if (
      (settlement.outcome !== 'skipped'
        && settlement.outcome !== 'acceptedIncomplete')
      || !nonEmpty(settlement.decisionEventRef)
      || !interaction
      || !nonEmpty(interaction.kind)
      || !nonEmpty(interaction.interactionId)
      || !nonEmpty(interaction.interactionRevision)
      || !nonEmpty(interaction.targetId)
      || !nonEmpty(interaction.runId)
    ) {
      invalidLedger();
    }
    return;
  }
  if (
    settlement?.kind !== 'deterministicCriterion'
    || settlement.outcome !== 'completed'
    || !nonEmpty(settlement.validatorId)
    || !nonEmpty(settlement.validatorVersion)
    || !identityList(settlement.evidenceRefs)
    || settlement.evidenceRefs.length === 0
  ) {
    invalidLedger();
  }
}

function validateFailure(value: TaskFailureV2): void {
  const failure = objectRecord(value);
  if (failure?.kind === 'kernelFacts') {
    if (
      !nonEmpty(failure.reason)
      || !Array.isArray(failure.kernelFactRefs)
      || failure.kernelFactRefs.length === 0
      || failure.kernelFactRefs.some((ref) => !validKernelFactRef(ref))
    ) {
      invalidLedger();
    }
    return;
  }
  if (
    failure?.kind !== 'sessionInvariant'
    || !nonEmpty(failure.reason)
    || !identityList(failure.sourceRefs)
    || failure.sourceRefs.length === 0
  ) {
    invalidLedger();
  }
}

function validKernelFactRef(value: unknown): boolean {
  const ref = objectRecord(value);
  return Boolean(
    ref
    && ref.schemaVersion === 'deepcode.session.kernel-fact-ref.v1'
    && nonEmpty(ref.kernelEventRef)
    && nonEmpty(ref.kind)
    && nonEmpty(ref.runId)
  );
}

function nextReadyTaskId(
  entries: readonly Pick<TaskLedgerEntryV2, 'taskId' | 'dependencies' | 'status'>[],
  settled: Set<string>
): string | undefined {
  return entries.find((entry) => (
    entry.status === 'pending'
    && entry.dependencies.every((dependency) => settled.has(dependency))
  ))?.taskId;
}

function assertAcyclic(tasks: readonly SessionTaskDefinitionV1[]): void {
  const dependencies = new Map(
    tasks.map((task) => [task.taskId, task.dependencies] as const)
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) invalidLedger();
    visiting.add(taskId);
    for (const dependency of dependencies.get(taskId) ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId);
}

function normalizedRefs(values: readonly string[]): string[] {
  const refs = [...new Set(values)];
  if (!refs.length || !identityList(refs)) invalidLedger();
  return refs;
}

function invalidLedger(): never {
  throw new TaskLedgerV2Error(
    'session_task_ledger_invalid',
    'TaskLedgerV2 does not satisfy its closed schema or transition invariants.'
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function identityList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(nonEmpty)
    && new Set(value).size === value.length;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}
