import { stableHash } from '../cache/canonicalizer.js';
import type { TaskDependencyFactRecord } from './types.js';
import { decodeKernelEventV1, isKernelEventKindV1, type KernelEventV1 } from '@deepcode/protocol';

export function taskDependencyFactsFromKernelEvents(
  taskId: string,
  kernelEvents: readonly unknown[]
): TaskDependencyFactRecord[] {
  const records = kernelEvents.flatMap(kernelEventsFromValue);
  const completedWorkUnits = new Set(
    records
      .filter((record): record is Extract<KernelEventV1, { kind: 'work_unit.completed' }> => record.kind === 'work_unit.completed')
      .map((record) => record.workUnitId)
      .filter((value): value is string => Boolean(value))
  );
  const facts: TaskDependencyFactRecord[] = [];
  for (const record of records) {
    if (record.kind !== 'tool.completed' || record.fact.ok !== true) continue;
    const output = objectRecord(record.fact.output);
    const kernelContext = objectRecord(output?.kernelContext);
    const workUnitId = stringValue(kernelContext?.workUnitId);
    if (!output || !workUnitId || !completedWorkUnits.has(workUnitId)) continue;
    const toolCallId = record.fact.toolCallId;
    const toolId = record.fact.toolId;
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

function kernelEventsFromValue(value: unknown): KernelEventV1[] {
  if (!hasKernelEventCandidate(value)) return [];
  try {
    return [decodeKernelEventV1(value)];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`kernel_abi_event_invalid: ${message}`);
  }
}

function hasKernelEventCandidate(value: unknown): boolean {
  const root = objectRecord(value);
  if (!root) return false;
  const payload = objectRecord(root.payload);
  if (objectRecord(payload?.kernelEvent)) return true;
  const kind = stringValue(root.kind);
  return isKernelEventKindV1(kind);
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
