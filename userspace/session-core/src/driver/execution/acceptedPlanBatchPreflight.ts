import type { ResourcePacket } from '../../context/types.js';

export interface AcceptedPlanBatchPreflightPorts {
  batchActionRecords(batch: unknown): Record<string, unknown>[];
  actionEffectiveCapability(action: Record<string, unknown>): string;
  actionFileTargetPath(action: Record<string, unknown>): string | undefined;
  deleteActionTargetResourceKind(action: Record<string, unknown>): 'file' | 'directory' | undefined;
  deleteActionRecursive(action: Record<string, unknown>): boolean;
  normalizePlanScope(value: string): string;
  containsDirectoryPath(resourcePackets: ResourcePacket[], path: string): boolean;
}

export class AcceptedPlanBatchPreflight {
  constructor(private readonly ports: AcceptedPlanBatchPreflightPorts) {}

  audit(batch: Record<string, unknown>): Record<string, unknown> {
    return {
      actionCount: this.ports.batchActionRecords(batch).length,
      actions: this.ports.batchActionRecords(batch).map((action) => ({
        actionId: stringValue(action.actionId) ?? stringValue(action.id),
        toolId: stringValue(action.toolId),
        capability: this.ports.actionEffectiveCapability(action),
        kind: stringValue(action.kind),
        targetRef: objectRecord(action.targetRef) ?? stringValue(action.targetRef),
        targetPath: stringValue(action.targetPath),
        targetKind: stringValue(action.targetKind) ?? stringValue(action.targetResourceKind),
        recursive: action.recursive === true,
        resourceScope: stringArrayValue(action.resourceScope),
        sourceBlockId: stringValue(action.sourceBlockId),
        replacementBlockId: stringValue(action.replacementBlockId),
      })),
    };
  }

  deleteReasons(
    batch: Record<string, unknown>,
    resourcePackets: ResourcePacket[] = []
  ): string[] {
    const reasons: string[] = [];
    for (const [index, action] of this.ports.batchActionRecords(batch).entries()) {
      if (this.ports.actionEffectiveCapability(action) !== 'fs.delete') continue;
      const target = this.ports.actionFileTargetPath(action);
      const normalized = target ? this.ports.normalizePlanScope(target) : undefined;
      if (!normalized || normalized === '.' || normalized === './') {
        reasons.push(`actionBatch.actions[${index}] fs.delete is missing a concrete targetPath/resourceScope.`);
      } else {
        const targetResourceKind = this.ports.deleteActionTargetResourceKind(action);
        const normalizedDirectory = this.ports.normalizePlanScope(normalized).replace(/\/+$/, '');
        const resourcePacketSaysDirectory = this.ports.containsDirectoryPath(resourcePackets, normalizedDirectory);
        if ((normalized.endsWith('/') || resourcePacketSaysDirectory) && targetResourceKind !== 'directory') {
          reasons.push(`actionBatch.actions[${index}] fs.delete target ${normalizedDirectory} is a directory; directory deletion must explicitly set targetKind="directory".`);
        } else if (targetResourceKind === 'directory' && !this.ports.deleteActionRecursive(action)) {
          reasons.push(`actionBatch.actions[${index}] fs.delete directory target ${normalizedDirectory} must explicitly set recursive=true or use an empty-directory deletion semantic.`);
        }
      }
      if (stringValue(action.sourceBlockId) || stringValue(action.replacementBlockId)) {
        reasons.push(`actionBatch.actions[${index}] fs.delete must not reference a codeBlock.`);
      }
    }
    return [...new Set(reasons)];
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

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}
