export interface PermissionBundleProjection {
  id: string;
  capability: string;
  resourceKind: string;
  targets: string[];
  operationIds: string[];
  toolIds: string[];
  permissionMode: string;
  riskLevel: string;
  summary: string;
  expiresAfter?: string;
}

export interface GateInterventionProjection {
  id: string;
  interventionKind: string;
  status: string;
  summary: string;
  capability?: string;
  permissionBundleId?: string;
  options: string[];
}

export interface RequiredFileOperationProjection {
  operation: string;
  targetPath: string;
  targetRefPath?: string;
  toolId: string;
  actionId?: string;
  targetKind?: string;
  targetResourceKind?: 'file' | 'directory';
  recursive?: boolean;
  outsideWorkspace?: boolean;
}

export class PlanReviewGrantProjector {
  permissionBundlesFromReport(
    report: Record<string, unknown> | undefined
  ): PermissionBundleProjection[] {
    const contract = objectRecord(report?.executionContract);
    const source = Array.isArray(contract?.permissionBundles) ? contract.permissionBundles : [];
    return source.flatMap((item): PermissionBundleProjection[] => {
      const record = objectRecord(item);
      if (!record) return [];
      const id = stringValue(record.id);
      const capability = stringValue(record.capability);
      const resourceKind = stringValue(record.resourceKind);
      if (!id || !capability || !resourceKind) return [];
      return [{
        id,
        capability,
        resourceKind,
        targets: stringArrayValue(record.targets),
        operationIds: stringArrayValue(record.operationIds),
        toolIds: stringArrayValue(record.toolIds),
        permissionMode: stringValue(record.permissionMode) ?? 'ask',
        riskLevel: stringValue(record.risk) ?? 'unknown',
        summary: stringValue(record.summary) ?? `Kernel requires ${capability}.`,
        expiresAfter: stringValue(record.expiresAfter),
      }];
    });
  }

  gateInterventionsFromReport(
    report: Record<string, unknown> | undefined
  ): GateInterventionProjection[] {
    const contract = objectRecord(report?.executionContract);
    const source = Array.isArray(contract?.interventions) ? contract.interventions : [];
    return source.flatMap((item): GateInterventionProjection[] => {
      const record = objectRecord(item);
      if (!record) return [];
      const id = stringValue(record.id);
      const interventionKind = stringValue(record.interventionKind);
      const status = stringValue(record.status);
      const summary = stringValue(record.summary);
      if (!id || !interventionKind || !status || !summary) return [];
      return [{
        id,
        interventionKind,
        status,
        summary,
        capability: stringValue(record.capability),
        permissionBundleId: stringValue(record.permissionBundleId),
        options: stringArrayValue(record.options),
      }];
    });
  }

  requiredFileOperationsFromReport(
    report: Record<string, unknown> | undefined
  ): RequiredFileOperationProjection[] {
    const contract = objectRecord(report?.executionContract);
    const operations = Array.isArray(contract?.operations) ? contract.operations : [];
    return operations.flatMap((item): RequiredFileOperationProjection[] => {
      const record = objectRecord(item);
      const toolId = stringValue(record?.toolId);
      const args = objectRecord(record?.args);
      const targetPath = stringValue(args?.path);
      if (!record || !toolId || !targetPath || !toolId.startsWith('fs.')) return [];
      const targetResourceKindValue = stringValue(args?.targetResourceKind) ?? stringValue(args?.targetKind);
      return [{
        operation: toolId.slice(3),
        targetPath,
        targetRefPath: stringValue(args?.destinationPath),
        toolId,
        actionId: stringValue(record.sourceActionId) ?? stringValue(record.id),
        targetKind: stringValue(args?.targetKind),
        targetResourceKind: targetResourceKindValue === 'directory' || targetResourceKindValue === 'dir'
          ? 'directory'
          : 'file',
        recursive: args?.recursive === true,
        outsideWorkspace: record.outsideWorkspace === true,
      }];
    });
  }

  kernelExecutionContractId(report: Record<string, unknown> | undefined): string | undefined {
    return stringValue(objectRecord(report?.executionContract)?.id);
  }

  kernelExecutionContractHash(report: Record<string, unknown> | undefined): string | undefined {
    return stringValue(objectRecord(report?.executionContract)?.contractHash);
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
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => Boolean(item))
    : [];
}
