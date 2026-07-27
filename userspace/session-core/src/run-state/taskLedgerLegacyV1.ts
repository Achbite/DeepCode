export type LegacyTaskLedgerStatusV1 =
  | 'pending'
  | 'inProgress'
  | 'completedByKernelFacts'
  | 'modelJudgedSufficient'
  | 'failed'
  | 'skippedByUser'
  | 'acceptedIncompleteByUser';

export interface LegacyTaskLedgerEntryV1 {
  taskId: string;
  title?: string;
  targets: string[];
  toolId?: string;
  status: LegacyTaskLedgerStatusV1;
}

export interface LegacyTaskLedgerSnapshotV1 {
  schemaVersion: 'deepcode.session.task-ledger.v1';
  planId: string;
  runId: string;
  taskOrder: string[];
  currentTaskId?: string;
  completedTaskIds: string[];
  modelJudgedSufficientTaskIds: string[];
  failedTaskId?: string;
  skippedTaskIds: string[];
  acceptedIncompleteTaskIds: string[];
  pendingTaskIds: string[];
  entries: LegacyTaskLedgerEntryV1[];
}

export function readLegacyTaskLedgerV1(
  value: unknown
): LegacyTaskLedgerSnapshotV1 | undefined {
  const record = objectRecord(value);
  if (
    record?.schemaVersion !== 'deepcode.session.task-ledger.v1'
    || !nonEmpty(record.planId)
    || !nonEmpty(record.runId)
    || !identityList(record.taskOrder)
    || !identityList(record.completedTaskIds)
    || !identityList(record.modelJudgedSufficientTaskIds)
    || !identityList(record.skippedTaskIds)
    || !identityList(record.acceptedIncompleteTaskIds)
    || !identityList(record.pendingTaskIds)
    || !Array.isArray(record.entries)
  ) {
    return undefined;
  }
  const entries = record.entries.flatMap((value): LegacyTaskLedgerEntryV1[] => {
    const entry = objectRecord(value);
    const taskId = nonEmpty(entry?.taskId) ? entry.taskId : undefined;
    const status = legacyStatus(entry?.status);
    if (!taskId || !status || !identityList(entry?.targets)) return [];
    return [{
      taskId,
      title: nonEmpty(entry?.title) ? entry.title : undefined,
      targets: entry.targets as string[],
      toolId: nonEmpty(entry?.toolId) ? entry.toolId : undefined,
      status,
    }];
  });
  if (entries.length !== record.entries.length) return undefined;
  return {
    schemaVersion: 'deepcode.session.task-ledger.v1',
    planId: record.planId,
    runId: record.runId,
    taskOrder: record.taskOrder,
    currentTaskId: nonEmpty(record.currentTaskId)
      ? record.currentTaskId
      : undefined,
    completedTaskIds: record.completedTaskIds,
    modelJudgedSufficientTaskIds: record.modelJudgedSufficientTaskIds,
    failedTaskId: nonEmpty(record.failedTaskId)
      ? record.failedTaskId
      : undefined,
    skippedTaskIds: record.skippedTaskIds,
    acceptedIncompleteTaskIds: record.acceptedIncompleteTaskIds,
    pendingTaskIds: record.pendingTaskIds,
    entries,
  };
}

export function legacyTaskLedgerEntryV1(
  value: unknown,
  taskId: string
): LegacyTaskLedgerEntryV1 | undefined {
  return readLegacyTaskLedgerV1(value)?.entries.find(
    (entry) => entry.taskId === taskId
  );
}

function legacyStatus(value: unknown): LegacyTaskLedgerStatusV1 | undefined {
  return value === 'pending'
    || value === 'inProgress'
    || value === 'completedByKernelFacts'
    || value === 'modelJudgedSufficient'
    || value === 'failed'
    || value === 'skippedByUser'
    || value === 'acceptedIncompleteByUser'
    ? value
    : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function identityList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(nonEmpty)
    && new Set(value).size === value.length;
}
