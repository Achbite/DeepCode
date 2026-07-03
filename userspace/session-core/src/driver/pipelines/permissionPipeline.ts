import type { AgentEvent } from '@deepcode/protocol';

export interface PendingPermissionContext {
  id: string;
  runId?: string;
  planId?: string;
}

export class PermissionPipeline {
  findPendingPermissionContext(events: AgentEvent[], permissionId?: string): PendingPermissionContext | null {
    const resolved = new Set<string>();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const result = this.permissionResultContext(event);
      if (result?.id) {
        resolved.add(result.id);
        continue;
      }
      const request = this.permissionRequestContext(event);
      if (!request?.id) continue;
      if (permissionId && request.id !== permissionId) continue;
      if (resolved.has(request.id)) continue;
      return request;
    }
    return null;
  }

  private permissionResultContext(event: AgentEvent): PendingPermissionContext | null {
    if (event.kind === 'permission_result') {
      const payload = objectRecord(event.payload);
      const id = stringValue(payload?.permissionId) ?? stringValue(payload?.id);
      return id ? { id, runId: stringValue(payload?.runId) } : null;
    }
    const payload = objectRecord(event.payload);
    const kernelEvent = objectRecord(payload?.kernelEvent);
    if (kernelEvent?.kind === 'permission.resolved') {
      const id = stringValue(kernelEvent.permissionId);
      return id ? { id, runId: stringValue(kernelEvent.runId) } : null;
    }
    return null;
  }

  private permissionRequestContext(event: AgentEvent): PendingPermissionContext | null {
    if (event.kind === 'permission_request') {
      const payload = objectRecord(event.payload);
      const id = stringValue(payload?.id);
      return id ? {
        id,
        runId: stringValue(payload?.runId),
        planId: stringValue(payload?.planId),
      } : null;
    }
    const payload = objectRecord(event.payload);
    const kernelEvent = objectRecord(payload?.kernelEvent);
    if (kernelEvent?.kind !== 'permission.requested') return null;
    const request = objectRecord(kernelEvent.request);
    const id = stringValue(request?.id) ?? stringValue(kernelEvent.permissionId) ?? stringValue(kernelEvent.toolCallId);
    return id ? {
      id,
      runId: stringValue(kernelEvent.runId),
      planId: stringValue(kernelEvent.planId),
    } : null;
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
