export type TaskLedgerStatus =
  | 'pending'
  | 'inProgress'
  | 'completedByKernelFacts'
  | 'failed'
  | 'skippedByUser'
  | 'acceptedIncompleteByUser';

export interface TaskLedgerTaskInput {
  taskId: string;
  title?: string;
  targets?: string[];
  capability?: string;
}

export interface TaskLedgerInput {
  planId: string;
  runId: string;
  tasks: TaskLedgerTaskInput[];
  completedTaskIds?: string[];
  failedTaskId?: string;
  skippedTaskIds?: string[];
  acceptedIncompleteTaskIds?: string[];
  currentTaskId?: string;
}

export interface TaskLedgerEntry {
  taskId: string;
  title?: string;
  targets: string[];
  capability?: string;
  status: TaskLedgerStatus;
}

export interface TaskLedgerSnapshot {
  schemaVersion: 'deepcode.session.task-ledger.v1';
  planId: string;
  runId: string;
  taskOrder: string[];
  currentTaskId?: string;
  completedTaskIds: string[];
  failedTaskId?: string;
  skippedTaskIds: string[];
  acceptedIncompleteTaskIds: string[];
  pendingTaskIds: string[];
  entries: TaskLedgerEntry[];
}

export function buildTaskLedgerSnapshot(input: TaskLedgerInput): TaskLedgerSnapshot {
  const completed = new Set(input.completedTaskIds ?? []);
  const skipped = new Set(input.skippedTaskIds ?? []);
  const acceptedIncomplete = new Set(input.acceptedIncompleteTaskIds ?? []);
  const taskOrder = input.tasks.map((task) => task.taskId);
  const currentTaskId = input.currentTaskId ?? input.tasks.find((task) =>
    !completed.has(task.taskId) &&
    !skipped.has(task.taskId) &&
    !acceptedIncomplete.has(task.taskId) &&
    task.taskId !== input.failedTaskId
  )?.taskId;
  const entries = input.tasks.map((task): TaskLedgerEntry => {
    let status: TaskLedgerStatus = 'pending';
    if (task.taskId === input.failedTaskId) status = 'failed';
    else if (completed.has(task.taskId)) status = 'completedByKernelFacts';
    else if (skipped.has(task.taskId)) status = 'skippedByUser';
    else if (acceptedIncomplete.has(task.taskId)) status = 'acceptedIncompleteByUser';
    else if (task.taskId === currentTaskId) status = 'inProgress';
    return {
      taskId: task.taskId,
      title: task.title,
      targets: [...new Set(task.targets ?? [])],
      capability: task.capability,
      status,
    };
  });
  const closed = new Set([
    ...[...completed],
    ...[...skipped],
    ...[...acceptedIncomplete],
    ...(input.failedTaskId ? [input.failedTaskId] : []),
  ]);
  return {
    schemaVersion: 'deepcode.session.task-ledger.v1',
    planId: input.planId,
    runId: input.runId,
    taskOrder,
    currentTaskId,
    completedTaskIds: taskOrder.filter((taskId) => completed.has(taskId)),
    failedTaskId: input.failedTaskId,
    skippedTaskIds: taskOrder.filter((taskId) => skipped.has(taskId)),
    acceptedIncompleteTaskIds: taskOrder.filter((taskId) => acceptedIncomplete.has(taskId)),
    pendingTaskIds: taskOrder.filter((taskId) => !closed.has(taskId) && taskId !== currentTaskId),
    entries,
  };
}

export function taskLedgerAllSettled(ledger: TaskLedgerSnapshot): boolean {
  return ledger.entries.every((entry) =>
    entry.status === 'completedByKernelFacts' ||
    entry.status === 'skippedByUser' ||
    entry.status === 'acceptedIncompleteByUser'
  );
}

