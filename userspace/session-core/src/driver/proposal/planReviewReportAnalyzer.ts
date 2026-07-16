export interface PlanReviewReportAnalyzerPorts {
  requiredFileOperationsFromReport(report: Record<string, unknown> | undefined): Array<{
    operation: string;
    targetPath: string;
    toolId: string;
  }>;
}

export class PlanReviewReportAnalyzer {
  constructor(private readonly ports: PlanReviewReportAnalyzerPorts) {}

  findReport(events: unknown[]): Record<string, unknown> | undefined {
    for (const event of events) {
      const record = objectRecord(event);
      if (record?.kind !== 'proposal.reviewed') continue;
      const report = objectRecord(record.report);
      if (report) return report;
    }
    return undefined;
  }

  needsRepair(report: Record<string, unknown>): boolean {
    return report.status === 'denied' && this.diagnostics(report).length > 0;
  }

  acceptedPlanNeedsRepair(report: Record<string, unknown>): boolean {
    return this.needsRepair(report);
  }

  denied(report: Record<string, unknown>): boolean {
    return report.status === 'denied';
  }

  diagnosticSummary(report: Record<string, unknown>): string {
    const diagnostics = this.diagnostics(report);
    return diagnostics.filter(Boolean).join('; ') || 'Plan review did not pass.';
  }

  diagnostics(report: Record<string, unknown>): string[] {
    const contract = objectRecord(report.executionContract);
    const interventions = Array.isArray(contract?.interventions) ? contract.interventions : [];
    return [
      ...stringArrayValue(report.diagnostics),
      ...interventions.flatMap((item) => {
        const record = objectRecord(item);
        return [stringValue(record?.summary)].filter((value): value is string => Boolean(value));
      }),
    ];
  }

  facts(report: Record<string, unknown> | undefined): string[] {
    if (!report) return [];
    const facts: string[] = [`status: ${stringValue(report.status) ?? 'unknown'}`];
    facts.push(...this.diagnostics(report).map((value) => `diagnostic: ${value}`));
    const contract = objectRecord(report.executionContract);
    const bundles = Array.isArray(contract?.permissionBundles) ? contract.permissionBundles : [];
    for (const item of bundles) {
      const bundle = objectRecord(item);
      const capability = stringValue(bundle?.capability);
      const targets = stringArrayValue(bundle?.targets);
      if (capability) facts.push(`permissionBundle: ${capability} -> ${targets.join(', ') || 'unscoped'}`);
    }
    for (const operation of this.ports.requiredFileOperationsFromReport(report)) {
      facts.push(`fileOperation: ${operation.operation} ${operation.targetPath} (${operation.toolId})`);
    }
    return facts;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}
