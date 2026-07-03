import type { AgentEvent } from '@deepcode/protocol';

export interface ImplementationBatchContext {
  batchIndex: number;
  recentPlanSummaries: string[];
  continuationSummaries: string[];
}

export interface ImplementationBatchContextBuilderPorts {
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringArrayValue(value: unknown): string[];
  concreteFileOperationTarget(value: string): string | undefined;
  clip(value: string, max: number): string;
}

export class ImplementationBatchContextBuilder {
  constructor(private readonly ports: ImplementationBatchContextBuilderPorts) {}

  build(events: AgentEvent[]): ImplementationBatchContext {
    const recentPlanSummaries: string[] = [];
    const continuationSummaries: string[] = [];
    let planCount = 0;
    for (const event of events.slice(-48)) {
      if (event.kind !== 'plan_card') continue;
      const payload = this.ports.objectRecord(event.payload);
      if (!payload) continue;
      planCount += 1;
      const summary = typeof payload.summary === 'string'
        ? payload.summary
        : typeof payload.content === 'string'
          ? payload.content
          : '';
      if (summary.trim()) recentPlanSummaries.push(this.ports.clip(summary.trim(), 240));
      const actionBundle = this.ports.objectRecord(payload.actionBundle);
      const continuations = this.concreteContinuationExpectations(actionBundle?.continuationExpectations);
      for (const continuation of continuations) {
        const record = this.ports.objectRecord(continuation);
        const title = typeof record?.title === 'string' ? record.title.trim() : '';
        const scope = Array.isArray(record?.resourceScope)
          ? record.resourceScope.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ')
          : '';
        const text = [title, scope ? `scope=${scope}` : ''].filter(Boolean).join(' ');
        if (text) continuationSummaries.push(this.ports.clip(text, 240));
      }
    }
    return {
      batchIndex: planCount + 1,
      recentPlanSummaries: recentPlanSummaries.slice(-3),
      continuationSummaries: continuationSummaries.slice(-6),
    };
  }

  concreteContinuationExpectations(value: unknown): unknown[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => this.continuationHasConcreteScope(item));
  }

  private continuationHasConcreteScope(item: unknown): boolean {
    const record = this.ports.objectRecord(item);
    if (!record) return false;
    const scopes = [
      ...this.ports.stringArrayValue(record.targetPath),
      ...this.ports.stringArrayValue(record.resourceScope),
    ];
    return scopes.some((scope) => Boolean(this.ports.concreteFileOperationTarget(scope)));
  }
}
