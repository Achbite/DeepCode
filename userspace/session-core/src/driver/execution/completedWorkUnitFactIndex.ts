import { decodeKernelEventV1 } from '@deepcode/protocol';

export interface CompletedWorkUnitFacts {
  actionIds: Set<string>;
  targets: Set<string>;
}

export interface CompletedWorkUnitFactIndexPorts {
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
      const decoded = decodeKernelEventV1(event);
      if (decoded.kind !== 'work_unit.completed') continue;
      const record = decoded as unknown as Record<string, unknown>;
      const output = objectRecord(decoded.output);
      for (const value of [
        stringValue(output?.actionId),
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
    const lines = stringArrayValue(block.contentLines);
    return lines.length ? lines.join('\n') : undefined;
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
