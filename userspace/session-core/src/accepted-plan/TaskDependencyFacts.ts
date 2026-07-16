import { stableHash } from '../cache/canonicalizer.js';
import type { TaskDependencyFactRecord } from './types.js';

export function taskDependencyFactsFromKernelEvents(
  taskId: string,
  kernelEvents: readonly unknown[]
): TaskDependencyFactRecord[] {
  const records = kernelEvents.flatMap(recognizedKernelRecords);
  const completedWorkUnits = new Set(
    records
      .filter((record) => eventKind(record) === 'work_unit.completed')
      .map((record) => stringValue(record.workUnitId))
      .filter((value): value is string => Boolean(value))
  );
  const facts: TaskDependencyFactRecord[] = [];
  for (const record of records) {
    if (eventKind(record) !== 'tool.completed' || record.ok !== true) continue;
    const output = objectRecord(record.output);
    const kernelContext = objectRecord(output?.kernelContext);
    const workUnitId = stringValue(kernelContext?.workUnitId);
    if (!output || !workUnitId || !completedWorkUnits.has(workUnitId)) continue;
    const toolCallId = stringValue(record.toolCallId);
    const toolId = stringValue(record.toolName);
    const path = stringValue(output.path) ?? stringValue(output.normalizedTargetPath);
    if (!toolCallId || !toolId || !path) continue;
    const contentHash = stringValue(output.contentHash)
      ?? stringValue(output.newContentHash)
      ?? stringValue(objectRecord(output.validation)?.contentHash);
    const sizeBytes = integerValue(output.sizeBytes)
      ?? integerValue(output.contentBytes)
      ?? integerValue(output.newContentBytes)
      ?? integerValue(objectRecord(output.validation)?.contentBytes);
    const mode = integerValue(output.mode);
    const executable = typeof output.executable === 'boolean' ? output.executable : undefined;
    const factPayload = {
      taskId,
      toolCallId,
      workUnitId,
      toolId,
      path,
      operation: stringValue(output.operation),
      contentHash,
      sizeBytes,
      mode,
      executable,
    };
    facts.push({
      ...factPayload,
      factRef: `task-dependency:${stableHash(JSON.stringify(factPayload))}`,
    });
  }
  return deduplicateFacts(facts);
}

export function dependencyFactsForTask(
  facts: readonly TaskDependencyFactRecord[],
  dependencyTaskIds: readonly string[]
): TaskDependencyFactRecord[] {
  const dependencies = new Set(dependencyTaskIds);
  return facts.filter((fact) => dependencies.has(fact.taskId));
}

function recognizedKernelRecords(value: unknown): Record<string, unknown>[] {
  const root = objectRecord(value);
  if (!root) return [];
  const payload = objectRecord(root.payload);
  return uniqueRecords([
    root,
    payload,
    objectRecord(root.kernelEvent),
    objectRecord(payload?.kernelEvent),
  ]);
}

function eventKind(record: Record<string, unknown>): string | undefined {
  return stringValue(record.kind) ?? stringValue(record.eventKind);
}

function uniqueRecords(
  records: Array<Record<string, unknown> | undefined>
): Record<string, unknown>[] {
  const seen = new Set<Record<string, unknown>>();
  return records.filter((record): record is Record<string, unknown> => {
    if (!record || seen.has(record)) return false;
    seen.add(record);
    return true;
  });
}

function deduplicateFacts(facts: TaskDependencyFactRecord[]): TaskDependencyFactRecord[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    if (seen.has(fact.factRef)) return false;
    seen.add(fact.factRef);
    return true;
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
