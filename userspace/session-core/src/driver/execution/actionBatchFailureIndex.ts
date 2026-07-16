export interface ActionBatchFailureDetail {
  status: 'failed' | 'blocked';
  workUnitId?: string;
  actionId?: string;
  message?: string;
  code?: string;
  kernelCode?: string;
  classification?: string;
  writeSet: string[];
}

export class ActionBatchFailureIndex {
  details(kernelEvents: unknown[], _batch?: Record<string, unknown>): ActionBatchFailureDetail[] {
    const workUnits = new Map<string, { actionId?: string; writeSet: string[] }>();
    const details: ActionBatchFailureDetail[] = [];
    for (const event of kernelEvents) {
      const record = objectRecord(event);
      if (!record) continue;
      if (record.kind === 'work_unit.queued' || record.kind === 'work_unit.started') {
        const workUnit = objectRecord(record.workUnit);
        const id = stringValue(workUnit?.id) ?? stringValue(record.workUnitId);
        if (!id) continue;
        const prior = workUnits.get(id);
        const workUnitWriteSet = stringArrayValue(workUnit?.writeSet);
        workUnits.set(id, {
          actionId: stringValue(workUnit?.actionId) ?? stringValue(record.actionId) ?? prior?.actionId,
          writeSet: workUnitWriteSet.length ? workUnitWriteSet : prior?.writeSet ?? [],
        });
        continue;
      }
      if (record.kind !== 'work_unit.failed' && record.kind !== 'work_unit.blocked') continue;
      const status = record.kind === 'work_unit.failed' ? 'failed' : 'blocked';
      const workUnitId = stringValue(record.workUnitId) ?? stringValue(objectRecord(record.workUnit)?.id);
      const indexed = workUnitId ? workUnits.get(workUnitId) : undefined;
      const error = objectRecord(record.error);
      const message = stringValue(record.message) ?? stringValue(error?.message) ?? stringValue(record.reason);
      const actionId = stringValue(record.actionId) ?? indexed?.actionId;
      const eventWriteSet = stringArrayValue(record.writeSet);
      const writeSet = eventWriteSet.length ? eventWriteSet : indexed?.writeSet ?? [];
      const kernelCode = stringValue(record.code) ?? stringValue(error?.code);
      const classification = typedFailureClassification(record, error);
      details.push({
        status,
        workUnitId,
        actionId,
        message,
        code: classification ?? kernelCode,
        kernelCode,
        classification,
        writeSet,
      });
    }
    return details;
  }

  summary(detail: ActionBatchFailureDetail): string {
    const parts = [
      detail.workUnitId ? `workUnit=${detail.workUnitId}` : undefined,
      detail.actionId ? `action=${detail.actionId}` : undefined,
      detail.code ? `code=${detail.code}` : undefined,
      detail.kernelCode && detail.kernelCode !== detail.code ? `kernelCode=${detail.kernelCode}` : undefined,
      detail.message,
      detail.writeSet.length ? `writeSet=${detail.writeSet.join(',')}` : undefined,
    ].filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(' ') : detail.status;
  }
}

function typedFailureClassification(
  record: Record<string, unknown>,
  error: Record<string, unknown> | undefined
): string | undefined {
  const details = objectRecord(objectRecord(error?.args)?.details)
    ?? objectRecord(record.details);
  return stringValue(record.classification)
    ?? stringValue(error?.classification)
    ?? stringValue(details?.classification);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}
