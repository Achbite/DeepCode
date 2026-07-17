import {
  decodeKernelEventV1,
  type KernelEventV1,
  type KernelReply,
} from '@deepcode/protocol';

export type KernelReplyObservation =
  | {
    kind: 'factsObserved';
    reply: KernelReply;
    events: KernelEventV1[];
    readyForReview: boolean;
    hasFailureOrBlocker: boolean;
  }
  | {
    kind: 'permissionInterrupted';
    reply: KernelReply;
    events: KernelEventV1[];
    permissionId?: string;
  }
  | {
    kind: 'commandFailed';
    reply: KernelReply;
    events: KernelEventV1[];
    code: string;
    message: string;
  };

export class KernelEventStatusIndex {
  observe(reply: KernelReply): KernelReplyObservation {
    const events = this.decodeEvents(reply.events ?? []);
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

  decodeEvents(events: readonly unknown[]): KernelEventV1[] {
    return events.map((event) => decodeKernelEventV1(event));
  }

  workUnitIds(events: KernelEventV1[]): string[] {
    const ids = new Set<string>();
    for (const event of events) {
      const workUnit = event.kind === 'work_unit.queued' ? event.workUnit : undefined;
      const id = 'workUnitId' in event ? event.workUnitId : workUnit?.id;
      if (id) ids.add(id);
    }
    return [...ids];
  }

  hasFailureOrBlocker(events: KernelEventV1[]): boolean {
    return events.some((event) => event.kind === 'work_unit.failed' || event.kind === 'work_unit.blocked');
  }

  hasPermissionRequest(events: KernelEventV1[]): boolean {
    return events.some((event) => event.kind === 'permission.requested');
  }

  actionBatchReadyForReview(events: KernelEventV1[]): boolean {
    return !this.hasPermissionRequest(events)
      && events.some((event) => event.kind === 'batch.review_ready');
  }

  reviewGateStatus(events: KernelEventV1[] | undefined): string | undefined {
    for (const event of [...(events ?? [])].reverse()) {
      if (event.kind !== 'review_gate.evaluated') continue;
      const result = objectRecord(event.result);
      const status = stringValue(result?.status);
      if (status) return status;
    }
    return undefined;
  }

  permissionId(events: KernelEventV1[]): string | undefined {
    for (const event of events) {
      if (event.kind === 'permission.requested') return event.request.id;
    }
    return undefined;
  }

  runId(events: KernelEventV1[]): string | undefined {
    for (const event of events) {
      if (event.runId) return event.runId;
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
