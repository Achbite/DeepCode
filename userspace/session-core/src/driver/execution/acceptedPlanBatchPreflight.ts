export interface AcceptedPlanBatchPreflightPorts {
  batchActionRecords(batch: unknown): Record<string, unknown>[];
}

export class AcceptedPlanBatchPreflight {
  constructor(private readonly ports: AcceptedPlanBatchPreflightPorts) {}

  audit(batch: unknown): Record<string, unknown> {
    return {
      actionCount: this.ports.batchActionRecords(batch).length,
      actions: this.ports.batchActionRecords(batch).map((action) => {
        const args = objectRecord(action.args) ?? {};
        return {
          actionId: stringValue(action.actionId),
          toolId: stringValue(action.toolId),
          targetPath: stringValue(args.path),
          targetKind: stringValue(args.targetKind),
          recursive: args.recursive === true,
          contentBlockId: stringValue(args.contentBlockId),
          replacementBlockId: stringValue(args.replacementBlockId),
        };
      }),
    };
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
