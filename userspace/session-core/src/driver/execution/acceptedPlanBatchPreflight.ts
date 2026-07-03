import type { ResourcePacket } from '../../context/types.js';

export interface AcceptedPlanBatchPreflightPorts {
  batchActionRecords(batch: unknown): Record<string, unknown>[];
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringValue(value: unknown): string | undefined;
  stringArrayValue(value: unknown): string[];
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
        actionId: this.ports.stringValue(action.actionId) ?? this.ports.stringValue(action.id),
        toolId: this.ports.stringValue(action.toolId),
        capability: this.ports.actionEffectiveCapability(action),
        kind: this.ports.stringValue(action.kind),
        targetRef: this.ports.objectRecord(action.targetRef) ?? this.ports.stringValue(action.targetRef),
        targetPath: this.ports.stringValue(action.targetPath),
        targetKind: this.ports.stringValue(action.targetKind) ?? this.ports.stringValue(action.targetResourceKind),
        recursive: action.recursive === true,
        resourceScope: this.ports.stringArrayValue(action.resourceScope),
        sourceBlockId: this.ports.stringValue(action.sourceBlockId),
        replacementBlockId: this.ports.stringValue(action.replacementBlockId),
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
      if (this.ports.stringValue(action.sourceBlockId) || this.ports.stringValue(action.replacementBlockId)) {
        reasons.push(`actionBatch.actions[${index}] fs.delete must not reference a codeBlock.`);
      }
    }
    return [...new Set(reasons)];
  }
}
