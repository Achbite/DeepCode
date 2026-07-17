import { decodeKernelEventV1, type AgentEvent, type KernelToolCatalogSnapshot } from '@deepcode/protocol';
import type { DriverRequestRef, KernelStateContractRef } from '../types.js';

export interface RecoveredKernelContext {
  readonly runId?: string;
  readonly stateContract?: KernelStateContractRef;
  readonly driverRequest?: DriverRequestRef;
  readonly toolCatalogSnapshot?: KernelToolCatalogSnapshot;
}

export function recoverKernelContext(
  values: readonly unknown[],
  expectedRunId?: string,
  expectedSessionId?: string
): RecoveredKernelContext {
  let selectedRunId = expectedRunId;
  let stateContract: KernelStateContractRef | undefined;
  let driverRequest: DriverRequestRef | undefined;
  let toolCatalogSnapshot: KernelToolCatalogSnapshot | undefined;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const records = recognizedKernelRecords(values[index]);
    const eventRunId = records.map(recordRunId).find(Boolean);
    const eventSessionId = records.map(recordSessionId).find(Boolean);
    if (selectedRunId && eventRunId && eventRunId !== selectedRunId) continue;
    if (expectedSessionId && eventSessionId && eventSessionId !== expectedSessionId) continue;
    selectedRunId ??= eventRunId;

    for (const record of records) {
      const runId = recordRunId(record);
      const sessionId = recordSessionId(record);
      if (selectedRunId && runId && runId !== selectedRunId) continue;
      if (expectedSessionId && sessionId && sessionId !== expectedSessionId) continue;
      driverRequest ??= driverRequestFromRecord(record);
      stateContract ??= stateContractFromRecord(record)
        ?? stateContractFromRecord(driverRequestFromRecord(record));
      toolCatalogSnapshot ??= toolCatalogFromContract(stateContractFromRecord(record))
        ?? toolCatalogFromContract(stateContractFromRecord(driverRequestFromRecord(record)));
    }
    toolCatalogSnapshot ??= toolCatalogFromContract(stateContract);
    if (stateContract && driverRequest && toolCatalogSnapshot) break;
  }
  return {
    runId: selectedRunId,
    stateContract,
    driverRequest,
    toolCatalogSnapshot,
  };
}

export function latestEventRunId(events: readonly AgentEvent[], expectedSessionId?: string): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    for (const record of recognizedKernelRecords(events[index])) {
      const sessionId = recordSessionId(record);
      if (expectedSessionId && sessionId && sessionId !== expectedSessionId) continue;
      const runId = recordRunId(record);
      if (runId) return runId;
    }
  }
  return undefined;
}

function recognizedKernelRecords(value: unknown): Record<string, unknown>[] {
  const root = objectRecord(value);
  if (!root) return [];
  const payload = objectRecord(root.payload);
  const directKind = stringValue(root.kind);
  const candidate = objectRecord(payload?.kernelEvent)
    || (directKind?.includes('.') ? root : undefined)
    || (directKind === 'error' && objectRecord(root.error) ? root : undefined);
  if (!candidate) return [];
  try {
    return [decodeKernelEventV1(value) as unknown as Record<string, unknown>];
  } catch (error) {
    throw new Error(`kernel_abi_event_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function driverRequestFromRecord(value: unknown): DriverRequestRef | undefined {
  const record = objectRecord(value);
  const driverRequest = objectRecord(record?.driverRequest);
  return driverRequest as unknown as DriverRequestRef | undefined;
}

function stateContractFromRecord(value: unknown): KernelStateContractRef | undefined {
  const record = objectRecord(value);
  const stateContract = objectRecord(record?.stateContract);
  return stateContract as unknown as KernelStateContractRef | undefined;
}

function toolCatalogFromContract(value: unknown): KernelToolCatalogSnapshot | undefined {
  const contract = objectRecord(value);
  const snapshot = objectRecord(contract?.toolCatalogSnapshot);
  return snapshot as unknown as KernelToolCatalogSnapshot | undefined;
}

function recordRunId(record: Record<string, unknown>): string | undefined {
  return stringValue(record.runId)
    ?? stringValue(objectRecord(record.decisionOwner)?.runId)
    ?? stringValue(objectRecord(record.stateContract)?.runId)
    ?? stringValue(objectRecord(record.driverRequest)?.runId);
}

function recordSessionId(record: Record<string, unknown>): string | undefined {
  return stringValue(record.sessionId)
    ?? stringValue(objectRecord(record.decisionOwner)?.sessionId)
    ?? stringValue(objectRecord(record.stateContract)?.sessionId)
    ?? stringValue(objectRecord(record.driverRequest)?.sessionId);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
