import { decodeKernelEventV1, type AgentEvent } from '@deepcode/protocol';

export interface PendingPermissionContext {
  id: string;
  runId?: string;
  contractId?: string;
  requestKind?: 'runtimePermission' | 'scopeExpansion';
}

export class PermissionPipeline {
  findPendingPermissionContext(
    events: AgentEvent[],
    permissionId?: string,
    runId?: string
  ): PendingPermissionContext | null {
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
      if (runId && request.runId !== runId) continue;
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
    if (payload?.kernelEvent) {
      const kernelEvent = decodeKernelEventV1(event);
      if (kernelEvent.kind === 'permission.resolved') {
        return { id: kernelEvent.permissionId, runId: kernelEvent.runId };
      }
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
        contractId: stringValue(payload?.contractId),
        requestKind: permissionRequestKind(payload?.requestKind),
      } : null;
    }
    const payload = objectRecord(event.payload);
    if (!payload?.kernelEvent) return null;
    const kernelEvent = decodeKernelEventV1(event);
    if (kernelEvent.kind !== 'permission.requested') return null;
    return {
      id: kernelEvent.request.id,
      runId: kernelEvent.runId,
      contractId: kernelEvent.request.contractId,
      requestKind: kernelEvent.request.requestKind,
    };
  }
}

function permissionRequestKind(value: unknown): PendingPermissionContext['requestKind'] {
  return value === 'runtimePermission' || value === 'scopeExpansion' ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
