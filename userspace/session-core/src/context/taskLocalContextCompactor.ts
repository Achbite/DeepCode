import { stableHash } from '../cache/canonicalizer.js';
import type {
  ContextAssemblyRecord,
  ContextAssemblyTaskLocalCompactRecord,
  ContextAssemblyTaskLocalCompactSource,
  ContextAssemblyTaskLocalCompactStatus,
  ContextAssemblyTaskLocalFoldPlan,
} from './assembler.js';

export function buildTaskLocalCompactRecord(input: {
  contextAssembly?: ContextAssemblyRecord;
  source: ContextAssemblyTaskLocalCompactSource;
  status: ContextAssemblyTaskLocalCompactStatus;
  planId?: string;
  runId?: string;
  taskId?: string;
}): ContextAssemblyTaskLocalCompactRecord | undefined {
  const assembly = input.contextAssembly;
  if (!assembly?.taskLocalFoldPlan) return undefined;
  const plan = assembly.taskLocalFoldPlan;
  const draft = {
    schemaVersion: 'deepcode.session.context-task-compact.v1' as const,
    source: input.source,
    status: input.status,
    boundary: 'sessionContextMetadataOnly' as const,
    planId: input.planId,
    runId: input.runId,
    taskId: input.taskId,
    taskCursorId: plan.taskCursorId,
    lastTaskSavepointId: plan.lastTaskSavepointId,
    currentTaskGoalHash: plan.currentTaskGoalHash,
    currentTaskContextHash: plan.currentTaskContextHash,
    dynamicAppendLogHash: plan.dynamicAppendLogHash,
    taskLocalFoldPlanHash: assembly.taskLocalFoldPlanHash,
    foldableSegmentCount: plan.foldableSegmentCount,
    foldableRenderedCharLength: plan.foldableRenderedCharLength,
    retainedSegmentCount: plan.retainedSegmentCount,
    retainedRenderedCharLength: plan.retainedRenderedCharLength,
    retainedPolicies: retainedPolicies(plan),
    foldablePolicies: foldablePolicies(plan),
  };
  return {
    ...draft,
    compactHash: stableHash(JSON.stringify(draft)),
  };
}

export function appendTaskLocalCompactRecord(
  records: ContextAssemblyTaskLocalCompactRecord[] | undefined,
  record: ContextAssemblyTaskLocalCompactRecord | undefined,
  limit = 8
): ContextAssemblyTaskLocalCompactRecord[] {
  if (!record) return records ?? [];
  const next = [...(records ?? []).filter((item) => item.compactHash !== record.compactHash), record];
  return next.slice(-Math.max(1, limit));
}

function retainedPolicies(plan: ContextAssemblyTaskLocalFoldPlan): string[] {
  return plan.policySummaries
    .filter((summary) => summary.policy !== 'dropAfterTask')
    .map((summary) => summary.policy);
}

function foldablePolicies(plan: ContextAssemblyTaskLocalFoldPlan): string[] {
  return plan.policySummaries
    .filter((summary) => summary.policy === 'dropAfterTask')
    .map((summary) => summary.policy);
}

export function collectTaskLocalCompactRecords(
  events: readonly unknown[] | undefined,
  options?: { limit?: number; runId?: string; planId?: string }
): ContextAssemblyTaskLocalCompactRecord[] {
  const collected: ContextAssemblyTaskLocalCompactRecord[] = [];
  for (const event of events ?? []) {
    const payload = objectRecord(objectRecord(event)?.payload);
    const record = parseTaskLocalCompactRecord(payload?.contextCompactRecord);
    if (!record) continue;
    if (options?.runId && record.runId !== options.runId) continue;
    if (options?.planId && record.planId !== options.planId) continue;
    collected.push(record);
  }
  const limit = options?.limit ?? collected.length;
  return limit > 0 ? collected.slice(-limit) : [];
}

function parseTaskLocalCompactRecord(value: unknown): ContextAssemblyTaskLocalCompactRecord | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  if (record.schemaVersion !== 'deepcode.session.context-task-compact.v1') return undefined;
  if (record.boundary !== 'sessionContextMetadataOnly') return undefined;
  const source = stringValue(record.source);
  const status = stringValue(record.status);
  if (!isCompactSource(source) || !isCompactStatus(status)) return undefined;
  const dynamicAppendLogHash = stringValue(record.dynamicAppendLogHash);
  const taskLocalFoldPlanHash = stringValue(record.taskLocalFoldPlanHash);
  const compactHash = stringValue(record.compactHash);
  if (!dynamicAppendLogHash || !taskLocalFoldPlanHash || !compactHash) return undefined;
  return {
    schemaVersion: 'deepcode.session.context-task-compact.v1',
    source,
    status,
    boundary: 'sessionContextMetadataOnly',
    planId: stringValue(record.planId),
    runId: stringValue(record.runId),
    taskId: stringValue(record.taskId),
    taskCursorId: stringValue(record.taskCursorId),
    lastTaskSavepointId: stringValue(record.lastTaskSavepointId),
    currentTaskGoalHash: stringValue(record.currentTaskGoalHash),
    currentTaskContextHash: stringValue(record.currentTaskContextHash),
    dynamicAppendLogHash,
    taskLocalFoldPlanHash,
    foldableSegmentCount: numberValue(record.foldableSegmentCount),
    foldableRenderedCharLength: numberValue(record.foldableRenderedCharLength),
    retainedSegmentCount: numberValue(record.retainedSegmentCount),
    retainedRenderedCharLength: numberValue(record.retainedRenderedCharLength),
    retainedPolicies: stringArray(record.retainedPolicies),
    foldablePolicies: stringArray(record.foldablePolicies),
    compactHash,
  };
}

function isCompactSource(value: string | undefined): value is ContextAssemblyTaskLocalCompactSource {
  return value === 'kernelBatchCheckpoint';
}

function isCompactStatus(value: string | undefined): value is ContextAssemblyTaskLocalCompactStatus {
  return value === 'completedByKernelFacts';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
