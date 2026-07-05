import type {
  AcceptedPlanAccessScope,
  AcceptedPlanExactOperationGrant,
  AcceptedImplementationPlanExecutionRoot,
} from '../../accepted-plan/types.js';

export interface PermissionBundleProjection {
  id: string;
  capability: string;
  resourceKind: string;
  resourcePath?: string;
  targets: string[];
  operationIds: string[];
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
  capability: string;
  actionId?: string;
  targetKind?: string;
  targetResourceKind?: 'file' | 'directory';
  recursive?: boolean;
  outsideWorkspace?: boolean;
}

export interface PlanReviewGrantPlanContext {
  planId: string;
  planReviewReport?: Record<string, unknown>;
}

export class PlanReviewGrantProjector {
  permissionBundlesFromReport(
    report: Record<string, unknown> | undefined
  ): PermissionBundleProjection[] {
    const direct = Array.isArray(report?.permissionBundles) ? report.permissionBundles : [];
    const contract = objectRecord(report?.executionContract);
    const contractBundles = Array.isArray(contract?.permissionBundles) ? contract.permissionBundles : [];
    const source = direct.length ? direct : contractBundles;
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
        resourcePath: stringValue(record.resourcePath),
        targets: stringArrayValue(record.targets),
        operationIds: stringArrayValue(record.operationIds),
        riskLevel: stringValue(record.riskLevel) ?? 'unknown',
        summary: stringValue(record.summary) ?? `Kernel requires ${capability}.`,
        expiresAfter: stringValue(record.expiresAfter),
      }];
    });
  }

  gateInterventionsFromReport(
    report: Record<string, unknown> | undefined
  ): GateInterventionProjection[] {
    const direct = Array.isArray(report?.interventions) ? report.interventions : [];
    const contract = objectRecord(report?.executionContract);
    const contractInterventions = Array.isArray(contract?.interventions) ? contract.interventions : [];
    const source = direct.length ? direct : contractInterventions;
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

  temporaryGrantsForPlan(plan: PlanReviewGrantPlanContext): Record<string, unknown>[] {
    const report = plan.planReviewReport ?? {};
    const bundles = this.permissionBundlesFromReport(report);
    const gaps = Array.isArray(report.permissionGaps)
      ? report.permissionGaps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const gapSet = new Set(gaps);
    const fileOperations = this.requiredFileOperationsFromReport(report);
    const accessScopes = this.requiredAccessScopesFromReport(report);
    const grants: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const operation of fileOperations) {
      const capability = operation.capability;
      if (!gapSet.has(capability)) continue;
      if (!this.planAcceptedAutoGrantCapability(capability)) continue;
      const targetPath = operation.targetResourceKind === 'directory'
        ? this.concreteDirectoryOperationTarget(operation.targetPath ?? operation.targetRefPath ?? '')
        : this.concreteFileOperationTarget(operation.targetPath ?? operation.targetRefPath ?? '');
      if (!targetPath) continue;
      const resourceKind = operation.targetResourceKind === 'directory'
        ? (operation.outsideWorkspace || isAbsolutePath(targetPath) ? 'externalDirectory' : 'workspaceDirectory')
        : (operation.outsideWorkspace || isAbsolutePath(targetPath) ? 'externalFile' : undefined);
      const key = `${capability}\0${resourceKind ?? 'default'}\0${targetPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push(this.temporaryGrant(plan, capability, targetPath, resourceKind));
    }
    for (const scope of accessScopes) {
      for (const capability of scope.capabilities) {
        if (!gapSet.has(capability)) continue;
        if (!this.planAcceptedAutoGrantCapability(capability)) continue;
        if (!accessScopeCapabilityAllowed(capability)) continue;
        const targetPath = normalizeAccessScopePath(scope.path);
        if (!targetPath) continue;
        const key = `${capability}\0workspaceModule\0${targetPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        grants.push(this.temporaryGrant(
          plan,
          capability,
          targetPath,
          scope.scopeKind === 'oneHopDependency' ? 'workspaceDependency' : 'workspaceModule'
        ));
      }
    }
    for (const bundle of bundles) {
      if (!this.planAcceptedAutoGrantCapability(bundle.capability)) continue;
      if (['fs.write', 'fs.patch', 'fs.delete', 'fs.rename'].includes(bundle.capability) && !bundle.resourcePath) {
        continue;
      }
      const key = `${bundle.capability}\0${bundle.resourceKind}\0${bundle.resourcePath ?? 'bundle'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push(this.temporaryGrantForPermissionBundle(plan, bundle));
    }
    return grants;
  }

  nonAcceptedPermissionGaps(
    report: Record<string, unknown>,
    acceptedCapabilities: Iterable<string>
  ): string[] {
    const gaps = Array.isArray(report.permissionGaps)
      ? report.permissionGaps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const accepted = new Set(acceptedCapabilities);
    return gaps.filter((capability) => !this.planAcceptedAutoGrantCapability(capability) && !accepted.has(capability));
  }

  requiredFileOperationsFromReport(report: Record<string, unknown> | undefined): RequiredFileOperationProjection[] {
    const operations = Array.isArray(report?.requiredFileOperations) ? report.requiredFileOperations : [];
    const output: RequiredFileOperationProjection[] = [];
    const seen = new Set<string>();
    for (const item of operations) {
      const record = objectRecord(item);
      if (!record) continue;
      const operation = stringValue(record.operation);
      const targetRefPath = fileTargetRefPath(record.targetRef);
      const rawTargetPath = stringValue(record.targetPath) ?? targetRefPath ?? '';
      const capability = stringValue(record.capability);
      const targetResourceKindValue = stringValue(record.targetResourceKind);
      const targetResourceKind = targetResourceKindValue === 'directory' || targetResourceKindValue === 'dir'
        ? 'directory'
        : 'file';
      const targetPath = targetResourceKind === 'directory'
        ? this.concreteDirectoryOperationTarget(rawTargetPath)
        : this.concreteFileOperationTarget(rawTargetPath);
      if (!operation || !targetPath || !capability) continue;
      const actionId = stringValue(record.actionId);
      const targetKind = stringValue(record.targetKind);
      const recursive = record.recursive === true;
      const outsideWorkspace = Boolean(record.outsideWorkspace) || isAbsolutePath(targetPath);
      const key = `${operation}\0${capability}\0${targetPath}\0${actionId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ operation, targetPath, targetRefPath, capability, actionId, targetKind, targetResourceKind, recursive, outsideWorkspace });
    }
    return output;
  }

  exactOperationGrantsFromPlanReviewReport(
    report: Record<string, unknown> | undefined,
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): AcceptedPlanExactOperationGrant[] {
    return this.normalizeAcceptedPlanExactOperationGrants(
      this.requiredFileOperationsFromReport(report).map((operation) => ({
        ...operation,
        source: 'kernelPlanReview' as const,
      })),
      executionRoot
    );
  }

  exactOperationGrantsFromImplementationPlan(
    plan: Record<string, unknown> | undefined,
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): AcceptedPlanExactOperationGrant[] {
    const grants: AcceptedPlanExactOperationGrant[] = [];
    const topLevelOperations = Array.isArray(plan?.fileOperations) ? plan.fileOperations : [];
    for (const operation of topLevelOperations) {
      const grant = this.exactOperationGrantFromRawOperation(operation, undefined, executionRoot);
      if (grant) grants.push(grant);
    }
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    for (const item of tasks) {
      const task = objectRecord(item);
      if (!task) continue;
      const sourceTaskId = stringValue(task.taskId) ?? stringValue(task.id);
      const taskCapability = stringValue(task.capability);
      const fileOperations = Array.isArray(task.fileOperations) ? task.fileOperations : [];
      for (const operation of fileOperations) {
        const grant = this.exactOperationGrantFromRawOperation(operation, {
          capability: taskCapability,
          sourceTaskId,
        }, executionRoot);
        if (grant) grants.push(grant);
      }
      if (taskCapability === 'fs.delete' || taskCapability === 'fs.rename') {
        for (const target of acceptedPlanTaskTargets(task)) {
          const grant = this.exactOperationGrantFromRawOperation({
            operation: taskCapability === 'fs.delete' ? 'delete' : 'rename',
            capability: taskCapability,
            targetPath: target,
          }, { capability: taskCapability, sourceTaskId }, executionRoot);
          if (grant) grants.push(grant);
        }
      }
    }
    return this.normalizeAcceptedPlanExactOperationGrants(grants, executionRoot);
  }

  normalizeAcceptedPlanExactOperationGrants(
    grants: AcceptedPlanExactOperationGrant[],
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): AcceptedPlanExactOperationGrant[] {
    const output: AcceptedPlanExactOperationGrant[] = [];
    const seen = new Set<string>();
    for (const grant of grants) {
      const targetPath = grant.targetResourceKind === 'directory'
        ? this.concreteDirectoryOperationTarget(this.normalizePlanTargetForExecutionRoot(grant.targetPath, executionRoot))
        : this.concreteFileOperationTarget(this.normalizePlanTargetForExecutionRoot(grant.targetPath, executionRoot));
      if (!grant.operation || !grant.capability || !targetPath) continue;
      if (!this.planAcceptedAutoGrantCapability(grant.capability)) continue;
      const key = `${grant.operation}\0${grant.capability}\0${targetPath}\0${grant.actionId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        ...grant,
        targetPath,
        targetResourceKind: grant.targetResourceKind ?? 'file',
        outsideWorkspace: Boolean(grant.outsideWorkspace) || isAbsolutePath(targetPath),
      });
    }
    return output;
  }

  requiredAccessScopesFromReport(report: Record<string, unknown> | undefined): AcceptedPlanAccessScope[] {
    const scopes = Array.isArray(report?.requiredAccessScopes) ? report.requiredAccessScopes : [];
    return this.normalizeAcceptedPlanAccessScopes(scopes, 'kernelPlanReview');
  }

  accessScopesFromImplementationPlan(plan: Record<string, unknown> | undefined): AcceptedPlanAccessScope[] {
    const scopes: unknown[] = [];
    if (Array.isArray(plan?.accessScopes)) scopes.push(...plan.accessScopes);
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    for (const item of tasks) {
      const task = objectRecord(item);
      if (!task) continue;
      if (Array.isArray(task.accessScopes)) scopes.push(...task.accessScopes.map((scope) => ({
        ...(objectRecord(scope) ?? {}),
        sourceTaskId: stringValue((objectRecord(scope) ?? {})?.sourceTaskId) ?? stringValue(task.taskId) ?? stringValue(task.id),
        capability: stringValue((objectRecord(scope) ?? {})?.capability) ?? stringValue(task.capability),
      })));
    }
    return this.normalizeAcceptedPlanAccessScopes(scopes, 'implementationPlan');
  }

  normalizeAcceptedPlanAccessScopes(
    scopes: unknown[],
    source: AcceptedPlanAccessScope['source']
  ): AcceptedPlanAccessScope[] {
    const output: AcceptedPlanAccessScope[] = [];
    const seen = new Set<string>();
    for (const item of scopes) {
      const record = objectRecord(item);
      if (!record) continue;
      const scopeKind = stringValue(record.scopeKind) ?? stringValue(record.kind) ?? 'workspaceModule';
      const rawPath = stringValue(record.path) ?? stringValue(record.targetPath);
      const path = rawPath ? normalizeAccessScopePath(rawPath) : undefined;
      if (!path) continue;
      const dependencyDepth = typeof record.dependencyDepth === 'number' ? record.dependencyDepth : (
        scopeKind === 'oneHopDependency' ? 1 : 0
      );
      if (dependencyDepth > 1) continue;
      const outsideWorkspace = Boolean(record.outsideWorkspace) || isAbsolutePath(path);
      if (outsideWorkspace) continue;
      const capabilities = stringArrayValue(record.capabilities)
        .concat(stringArrayValue(record.capability))
        .filter((capability) => accessScopeCapabilityAllowed(capability));
      const normalizedCapabilities = capabilities.length
        ? [...new Set(capabilities)]
        : ['fs.write', 'fs.patch'];
      const operations = stringArrayValue(record.operations).length
        ? stringArrayValue(record.operations)
        : accessScopeOperationsForCapabilities(normalizedCapabilities);
      const key = `${scopeKind}\0${path}\0${normalizedCapabilities.join(',')}\0${dependencyDepth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        scopeKind,
        path,
        capabilities: normalizedCapabilities,
        operations: [...new Set(operations)],
        reason: stringValue(record.reason),
        dependencyDepth,
        sourceTaskId: stringValue(record.sourceTaskId) ?? stringValue(record.taskId),
        outsideWorkspace: false,
        source,
      });
    }
    return output;
  }

  concreteFileOperationTarget(value: string): string | undefined {
    const normalized = normalizePlanScope(value);
    if (!normalized || normalized === '.' || normalized === './') return undefined;
    if (isAbsolutePath(normalized)) return concreteAbsoluteFileOperationTarget(normalized);
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
    if (normalized.includes('*')) return undefined;
    if (normalized.endsWith('/')) return undefined;
    return normalized;
  }

  concreteDirectoryOperationTarget(value: string): string | undefined {
    const normalized = normalizePlanScope(value).replace(/\/+$/, '');
    if (!normalized || normalized === '.' || normalized === './') return undefined;
    if (isAbsolutePath(normalized)) return concreteAbsoluteDirectoryOperationTarget(normalized);
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
    if (normalized.includes('*')) return undefined;
    return normalized;
  }

  planAcceptedAutoGrantCapability(capability: string): boolean {
    return ['fs.write', 'fs.patch', 'fs.delete', 'fs.rename'].includes(capability);
  }

  kernelExecutionContractId(report: Record<string, unknown> | undefined): string | undefined {
    const contract = objectRecord(report?.executionContract);
    return stringValue(contract?.id);
  }

  private temporaryGrantForPermissionBundle(
    plan: PlanReviewGrantPlanContext,
    bundle: PermissionBundleProjection
  ): Record<string, unknown> {
    return {
      id: `grant-${safeSegment(plan.planId)}-${safeSegment(bundle.id)}`,
      capability: bundle.capability,
      resourceKind: bundle.resourceKind,
      resourcePath: bundle.resourcePath,
      reason: `Plan ${plan.planId} accepted by user; Kernel-derived permission bundle ${bundle.id} is scoped to this batch contract and expires after review or terminal work unit.`,
      permissionBundle: {
        source: 'kernelExecutionContract',
        planId: plan.planId,
        contractId: this.kernelExecutionContractId(plan.planReviewReport),
        bundleId: bundle.id,
        capability: bundle.capability,
        targets: bundle.targets,
        operationIds: bundle.operationIds,
        expiresAfter: bundle.expiresAfter,
      },
    };
  }

  private exactOperationGrantFromRawOperation(
    value: unknown,
    fallback: { capability?: string; sourceTaskId?: string } | undefined,
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): AcceptedPlanExactOperationGrant | undefined {
    const record = objectRecord(value);
    if (!record) return undefined;
    const operation = stringValue(record.operation);
    const capability = stringValue(record.capability) ?? fallback?.capability;
    const rawTarget = stringValue(record.targetPath) ?? fileTargetRefPath(record.targetRef);
    const targetResourceKind = fileOperationTargetResourceKind(record, rawTarget);
    const targetPath = rawTarget
      ? targetResourceKind === 'directory'
        ? this.concreteDirectoryOperationTarget(this.normalizePlanTargetForExecutionRoot(rawTarget, executionRoot))
        : this.concreteFileOperationTarget(this.normalizePlanTargetForExecutionRoot(rawTarget, executionRoot))
      : undefined;
    if (!operation || !capability || !targetPath) return undefined;
    if (!this.planAcceptedAutoGrantCapability(capability)) return undefined;
    return {
      operation,
      targetPath,
      targetRefPath: fileTargetRefPath(record.targetRef),
      targetResourceKind,
      recursive: fileOperationRecursive(record, targetResourceKind, rawTarget),
      capability,
      actionId: stringValue(record.actionId),
      sourceTaskId: fallback?.sourceTaskId ?? stringValue(record.sourceTaskId) ?? stringValue(record.taskId),
      outsideWorkspace: Boolean(record.outsideWorkspace) || isAbsolutePath(targetPath),
      source: 'implementationPlan',
    };
  }

  private normalizePlanTargetForExecutionRoot(
    value: string,
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): string {
    const normalized = normalizePlanScope(value);
    const rootRef = executionRoot?.ref;
    if (!rootRef) return normalized;
    const root = comparablePath(rootRef);
    const candidate = comparablePath(value);
    if (isAbsolutePath(value) || isAbsolutePath(normalized)) {
      if (candidate === root) return '.';
      if (candidate.startsWith(`${root}/`)) return normalizePlanScope(candidate.slice(root.length + 1));
      return normalized;
    }
    const rootName = basename(rootRef);
    if (rootName && normalized === rootName) return '.';
    if (rootName && normalized.startsWith(`${rootName}/`)) {
      return normalizePlanScope(normalized.slice(rootName.length + 1));
    }
    return normalized;
  }

  private temporaryGrant(
    plan: PlanReviewGrantPlanContext,
    capability: string,
    resourcePath?: string,
    resourceKind?: string
  ): Record<string, unknown> {
    return {
      id: `grant-${safeSegment(plan.planId)}-${safeSegment(capability)}-${resourcePath ? safeSegment(resourcePath) : 'run'}`,
      capability,
      resourceKind: resourceKind ?? resourceKindForCapability(capability),
      resourcePath,
      reason: resourcePath
        ? `Plan ${plan.planId} accepted by user through Session DecisionResolver; Kernel-reviewed file operation grant is scoped to ${resourcePath} and expires when ReviewGate closes.`
        : `Plan ${plan.planId} accepted by user through Session DecisionResolver; capability grant is scoped to the current batch/run and expires when ReviewGate closes.`,
      permissionBundle: {
        source: 'kernelPlanReview',
        planId: plan.planId,
        capability,
        groupedBy: resourcePath ? 'fileOperation' : 'capability',
      },
    };
  }
}

function acceptedPlanTaskTargets(record: Record<string, unknown>): string[] {
  const rawTargets = [
    ...stringArrayValue(record.target),
    ...stringArrayValue(record.targets),
    ...stringArrayValue(record.targetPath),
    ...stringArrayValue(record.targetPaths),
    ...acceptedPlanTaskFileOperationTargets(record),
  ];
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const target of rawTargets.flatMap(expandAcceptedPlanTargetValue)) {
    const normalized = normalizePlanScope(target);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    targets.push(normalized);
  }
  return targets;
}

function acceptedPlanTaskFileOperationTargets(record: Record<string, unknown>): string[] {
  const operations = Array.isArray(record.fileOperations) ? record.fileOperations : [];
  const targets: string[] = [];
  for (const operation of operations) {
    const item = objectRecord(operation);
    if (!item) continue;
    const target = stringValue(item.targetPath)
      ?? stringValue(item.path)
      ?? fileTargetRefPath(item.targetRef);
    if (target) targets.push(target);
  }
  return targets;
}

function expandAcceptedPlanTargetValue(value: string): string[] {
  const normalized = normalizePlanScope(value);
  if (!normalized) return [];
  if (normalized.includes(',')) {
    const parts = normalized
      .split(',')
      .map((part) => normalizePlanScope(part))
      .filter(Boolean);
    if (parts.length > 1 && parts.every(acceptedPlanTargetListSegmentSafe)) return parts;
    const extracted = extractAcceptedPlanTargetTokens(normalized);
    return extracted.length ? extracted : [normalized];
  }
  const extracted = extractAcceptedPlanTargetTokens(normalized);
  return extracted.length ? extracted : [normalized];
}

function acceptedPlanTargetListSegmentSafe(value: string): boolean {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized === '/') return false;
  if (normalized.includes(',') || normalized.includes('*')) return false;
  if (normalized.startsWith('../') || normalized.includes('/../')) return false;
  if (/[\s()[\]{}<>（）【】]/.test(normalized)) return false;
  if (isAbsolutePath(normalized)) return normalized.replace(/\/+$/, '').length > 1;
  return true;
}

interface AcceptedPlanTargetToken {
  value: string;
  index: number;
}

function extractAcceptedPlanTargetTokens(target: string): string[] {
  const tokens = acceptedPlanPathTokens(target);
  if (!tokens.length) return [];
  const hasFreeformBoundary = /[,;:()[\]{}<>（）【】]/.test(target) ||
    Boolean(tokens[0]?.value.endsWith('/') && target.trim() !== tokens[0].value) ||
    (tokens.length > 1 && tokens[0]?.value.endsWith('/'));
  if (!hasFreeformBoundary) return [];
  const first = tokens[0];
  if (!first || first.index !== 0) return [];
  const normalizedFirst = normalizePlanScope(first.value);
  if (
    normalizedFirst.endsWith('/') &&
    tokens.slice(1).every((token) => !token.value.includes('/'))
  ) {
    return [normalizedFirst];
  }
  return uniqueStrings(tokens
    .map((token) => normalizePlanScope(token.value))
    .filter((token) => token && acceptedPlanTargetListSegmentSafe(token)));
}

function acceptedPlanPathTokens(value: string): AcceptedPlanTargetToken[] {
  const tokens: AcceptedPlanTargetToken[] = [];
  for (const match of value.matchAll(/[A-Za-z0-9_.\-/]+/g)) {
    const token = match[0];
    const index = match.index ?? -1;
    if (!token || index < 0) continue;
    if (token === '.' || token === '..') continue;
    if (!token.includes('/') && !/\.[A-Za-z0-9]+$/.test(token)) continue;
    tokens.push({ value: token, index });
  }
  return tokens;
}

function fileOperationTargetResourceKind(
  record: Record<string, unknown>,
  rawTarget: string | undefined
): 'file' | 'directory' {
  const value = stringValue(record.targetResourceKind) ?? stringValue(record.targetKind);
  if (value === 'directory' || value === 'dir') return 'directory';
  if (value === 'file') return 'file';
  return rawTarget?.trim().endsWith('/') ? 'directory' : 'file';
}

function fileOperationRecursive(
  record: Record<string, unknown>,
  targetResourceKind: 'file' | 'directory',
  rawTarget: string | undefined
): boolean {
  if (record.recursive === true) return true;
  return targetResourceKind === 'directory' && Boolean(rawTarget?.trim().endsWith('/'));
}

function normalizeAccessScopePath(value: string): string | undefined {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === './') return undefined;
  if (isAbsolutePath(normalized)) return undefined;
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  if (normalized.includes('*')) return undefined;
  return normalized;
}

function accessScopeCapabilityAllowed(capability: string): boolean {
  return ['fs.write', 'fs.patch'].includes(capability);
}

function accessScopeOperationsForCapabilities(capabilities: string[]): string[] {
  const operations: string[] = [];
  if (capabilities.includes('fs.write')) operations.push('create', 'write');
  if (capabilities.includes('fs.patch')) operations.push('patch');
  return operations.length ? operations : ['write', 'patch'];
}

function concreteAbsoluteFileOperationTarget(value: string): string | undefined {
  const normalized = normalizeSlashes(value);
  if (!isAbsolutePath(normalized)) return undefined;
  if (!normalized || normalized === '/' || /^[a-zA-Z]:\/?$/.test(normalized)) return undefined;
  if (normalized.includes('*')) return undefined;
  if (normalized.includes('/../') || normalized.endsWith('/..')) return undefined;
  if (normalized.endsWith('/')) return undefined;
  const base = basename(normalized);
  if (!base || base === '.' || base === '..') return undefined;
  return normalized;
}

function concreteAbsoluteDirectoryOperationTarget(value: string): string | undefined {
  const normalized = normalizeSlashes(value).replace(/\/+$/, '');
  if (!isAbsolutePath(normalized)) return undefined;
  if (!normalized || normalized === '/' || /^[a-zA-Z]:\/?$/.test(normalized)) return undefined;
  if (normalized.includes('*')) return undefined;
  if (normalized.includes('/../') || normalized.endsWith('/..')) return undefined;
  const base = basename(normalized);
  if (!base || base === '.' || base === '..') return undefined;
  return normalized;
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function isAbsolutePath(value: string): boolean {
  return /^\/|^[a-zA-Z]:[\\/]/.test(value);
}

function comparablePath(value: string): string {
  return normalizeSlashes(value).replace(/\/+$/g, '').toLowerCase();
}

function basename(value: string): string {
  const normalized = normalizeSlashes(value).replace(/\/+$/g, '');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function resourceKindForCapability(capability: string): string {
  if (['fs.write', 'fs.patch', 'fs.delete', 'fs.rename'].includes(capability)) return 'workspaceFile';
  if (capability === 'git.write' || capability === 'git.push') return 'git';
  if (capability === 'config.modify') return 'config';
  if (capability === 'process.exec') return 'process';
  if (capability === 'network.egress') return 'network';
  if (capability === 'browser.control') return 'browser';
  if (capability === 'secret.read') return 'secret';
  return 'capability';
}

function fileTargetRefPath(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  const record = objectRecord(value);
  return stringValue(record?.path) ?? stringValue(record?.targetPath);
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'item';
}
