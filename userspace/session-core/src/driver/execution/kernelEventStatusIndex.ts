import type { KernelReply } from '@deepcode/protocol';

export type KernelReplyObservation =
  | {
    kind: 'factsObserved';
    reply: KernelReply;
    events: unknown[];
    readyForReview: boolean;
    hasFailureOrBlocker: boolean;
  }
  | {
    kind: 'permissionInterrupted';
    reply: KernelReply;
    events: unknown[];
    permissionId?: string;
  }
  | {
    kind: 'commandFailed';
    reply: KernelReply;
    events: unknown[];
    code: string;
    message: string;
  };

export class KernelEventStatusIndex {
  observe(reply: KernelReply): KernelReplyObservation {
    const events = reply.events ?? [];
    if (this.hasPermissionRequest(events)) {
      return {
        kind: 'permissionInterrupted',
        reply,
        events,
        permissionId: this.permissionId(events),
      };
    }
    if (!reply.ok) {
      return {
        kind: 'commandFailed',
        reply,
        events,
        code: reply.error?.code ?? 'kernel_command_failed',
        message: reply.error?.message ?? 'Kernel command failed.',
      };
    }
    return {
      kind: 'factsObserved',
      reply,
      events,
      readyForReview: this.actionBatchReadyForReview(events),
      hasFailureOrBlocker: this.hasFailureOrBlocker(events),
    };
  }

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

  actionBatchReadyForReview(events: unknown[]): boolean {
    if (this.hasPermissionRequest(events)) {
      return false;
    }
    if (events.some((event) => {
      const record = objectRecord(event);
      return record?.kind === 'stage.changed' && stringValue(record.phase) === 'review';
    })) {
      return true;
    }
    const queued = new Set<string>();
    const terminal = new Set<string>();
    for (const event of events) {
      const record = objectRecord(event);
      if (record?.kind === 'work_unit.queued') {
        const workUnit = objectRecord(record.workUnit);
        const id = stringValue(workUnit?.id);
        if (id) queued.add(id);
      } else if (
        record?.kind === 'work_unit.completed' ||
        record?.kind === 'work_unit.failed' ||
        record?.kind === 'work_unit.blocked'
      ) {
        const id = stringValue(record.workUnitId);
        if (id) terminal.add(id);
      }
    }
    return queued.size > 0 && [...queued].every((id) => terminal.has(id));
  }

  reviewGateStatus(events: unknown[] | undefined): string | undefined {
    for (const event of [...(events ?? [])].reverse()) {
      const record = objectRecord(event);
      if (stringValue(record?.kind) !== 'review_gate.evaluated') continue;
      const result = objectRecord(record?.result);
      const status = stringValue(result?.status);
      if (status) return status;
    }
    return undefined;
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
