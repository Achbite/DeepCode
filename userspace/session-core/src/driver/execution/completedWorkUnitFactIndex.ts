export interface CompletedWorkUnitFacts {
  actionIds: Set<string>;
  targets: Set<string>;
}

export interface CompletedWorkUnitFactIndexPorts {
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringValue(value: unknown): string | undefined;
  stringArrayValue(value: unknown): string[];
  kernelEventTargets(record: Record<string, unknown>): string[];
  normalizeRelativePath(value: string | undefined): string | undefined;
  comparablePath(value: string): string;
}

export class CompletedWorkUnitFactIndex {
  constructor(private readonly ports: CompletedWorkUnitFactIndexPorts) {}

  completedWorkUnitFacts(events: unknown[]): CompletedWorkUnitFacts {
    const actionIds = new Set<string>();
    const targets = new Set<string>();
    for (const event of events) {
      const record = this.ports.objectRecord(event);
      if (record?.kind !== 'work_unit.completed') continue;
      const workUnit = this.ports.objectRecord(record.workUnit);
      const output = this.ports.objectRecord(record.output);
      for (const value of [
        this.ports.stringValue(record.actionId),
        this.ports.stringValue(workUnit?.actionId),
        this.ports.stringValue(output?.actionId),
      ]) {
        if (value) actionIds.add(value);
      }
      for (const target of this.ports.kernelEventTargets(record)) {
        const normalized = this.ports.normalizeRelativePath(target) ?? target;
        if (normalized && normalized !== '.') targets.add(this.ports.comparablePath(normalized));
      }
    }
    return { actionIds, targets };
  }

  completedActionMatches(
    actionId: string | undefined,
    targetPath: string,
    completed: CompletedWorkUnitFacts
  ): boolean {
    if (actionId && completed.actionIds.has(actionId)) return true;
    return completed.targets.has(this.ports.comparablePath(targetPath));
  }

  codeBlockContent(block: Record<string, unknown>): string | undefined {
    if (typeof block.content === 'string') return block.content;
    const lines = this.ports.stringArrayValue(block.contentLines);
    return lines.length ? lines.join('\n') : undefined;
  }
}
