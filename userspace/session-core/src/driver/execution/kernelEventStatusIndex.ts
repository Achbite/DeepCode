export class KernelEventStatusIndex {
  workUnitIds(events: unknown[]): string[] {
    const ids = new Set<string>();
    for (const event of events) {
      const record = objectRecord(event);
      if (!record) continue;
      const workUnit = objectRecord(record.workUnit);
      const id = stringValue(record.workUnitId) ?? stringValue(workUnit?.id);
      if (id) ids.add(id);
    }
    return [...ids];
  }

  hasFailureOrBlocker(events: unknown[]): boolean {
    return events.some((event) => {
      const record = objectRecord(event);
      return record?.kind === 'work_unit.failed' ||
        record?.kind === 'work_unit.blocked' ||
        (record?.kind === 'stage.changed' && ['blocked', 'failed'].includes(stringValue(record.phase) ?? ''));
    });
  }

  hasPermissionRequest(events: unknown[]): boolean {
    return events.some((event) => objectRecord(event)?.kind === 'permission.requested');
  }

  permissionId(events: unknown[]): string | undefined {
    for (const event of events) {
      const record = objectRecord(event);
      if (record?.kind !== 'permission.requested') continue;
      const request = objectRecord(record.request);
      const id = stringValue(request?.id) ?? stringValue(record.permissionId) ?? stringValue(record.toolCallId);
      if (id) return id;
    }
    return undefined;
  }

  runId(events: unknown[]): string | undefined {
    for (const event of events) {
      const record = objectRecord(event);
      const runId = stringValue(record?.runId);
      if (runId) return runId;
    }
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
