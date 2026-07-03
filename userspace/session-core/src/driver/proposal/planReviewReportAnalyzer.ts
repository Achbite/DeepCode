export interface PlanReviewReportAnalyzerPorts {
  requiredFileOperationsFromReport(report: Record<string, unknown> | undefined): Array<{
    operation: string;
    targetPath: string;
    capability: string;
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
    if (
      report.status === 'denied' &&
      this.diagnosticSummary(report).includes('actionBundle payload failed Kernel schema validation')
    ) {
      return true;
    }
    if (report.status !== 'needsRevision') return false;
    const repairableCodes = new Set(['completion_evidence_required']);
    const findings = Array.isArray(report.findings) ? report.findings : [];
    return findings.some((finding) => {
      const record = objectRecord(finding);
      return typeof record?.code === 'string' && repairableCodes.has(record.code);
    });
  }

  acceptedPlanNeedsRepair(report: Record<string, unknown>): boolean {
    if (this.needsRepair(report)) return true;
    if (report.status !== 'needsRevision') return false;
    const diagnostics = this.diagnostics(report).join('\n').toLowerCase();
    if (!diagnostics) return false;
    return (
      (diagnostics.includes('access scope') || diagnostics.includes('accessscope')) &&
      (
        diagnostics.includes('workspace root') ||
        diagnostics.includes('root scope') ||
        diagnostics.includes('path="."') ||
        diagnostics.includes('path .') ||
        diagnostics.includes('must not be the workspace root')
      )
    );
  }

  denied(report: Record<string, unknown>): boolean {
    return report.status === 'denied' || report.status === 'interfaceOnly';
  }

  statusAwaitingUser(status: string | undefined): boolean {
    return status === 'awaitingUserApproval' ||
      status === 'awaitingTemporaryGrant' ||
      status === 'pending' ||
      status === undefined;
  }

  diagnosticSummary(report: Record<string, unknown>): string {
    const diagnostics = this.diagnostics(report);
    return diagnostics.filter(Boolean).join('; ') || 'Plan review did not pass.';
  }

  diagnostics(report: Record<string, unknown>): string[] {
    const denied = Array.isArray(report.deniedReasons)
      ? report.deniedReasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const blocked = Array.isArray(report.blockedReasons)
      ? report.blockedReasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const summary = typeof report.kernelGeneratedPermissionSummary === 'string' ? report.kernelGeneratedPermissionSummary : '';
    const findings = Array.isArray(report.findings)
      ? report.findings.flatMap((finding) => {
        const record = objectRecord(finding);
        return [
          stringValue(record?.code),
          stringValue(record?.message),
          stringValue(record?.summary),
          stringValue(record?.description),
        ].filter((item): item is string => Boolean(item));
      })
      : [];
    return [...denied, ...blocked, ...findings, summary].filter(Boolean);
  }

  facts(report: Record<string, unknown> | undefined): string[] {
    if (!report) return [];
    const facts: string[] = [];
    const summary = typeof report.kernelGeneratedPermissionSummary === 'string' ? report.kernelGeneratedPermissionSummary : '';
    if (summary) facts.push(summary);
    for (const key of ['blockedReasons', 'deniedReasons', 'permissionGaps', 'hardFloorHits'] as const) {
      const values = Array.isArray(report[key]) ? report[key] : [];
      for (const value of values) {
        if (typeof value === 'string' && value.trim()) facts.push(`${key}: ${value}`);
      }
    }
    const findings = Array.isArray(report.findings) ? report.findings : [];
    for (const finding of findings) {
      const record = objectRecord(finding);
      const code = typeof record?.code === 'string' ? record.code : '';
      const message = typeof record?.message === 'string' ? record.message : '';
      if (code || message) facts.push(`finding: ${[code, message].filter(Boolean).join(' - ')}`);
    }
    for (const operation of this.ports.requiredFileOperationsFromReport(report)) {
      facts.push(`fileOperation: ${operation.operation} ${operation.targetPath} (${operation.capability})`);
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
