import type {
  AcceptedImplementationPlanContext,
  AcceptedPlanAccessScope,
  AcceptedPlanExactOperationGrant,
} from '../../accepted-plan/types.js';

export interface AcceptedPlanScopeCoveragePorts {
  taskTargets(task: Record<string, unknown>): string[];
}

export class AcceptedPlanScopeCoverage {
  constructor(private readonly ports: AcceptedPlanScopeCoveragePorts) {}

  scopeCoveredForCapability(
    scope: string,
    capability: string | undefined,
    accepted: AcceptedImplementationPlanContext
  ): boolean {
    const normalized = normalizePlanScope(scope);
    if (!normalized) return false;
    if (this.exactOperationGrantCoversTarget(normalized, capability, accepted)) return true;
    if ((capability === 'fs.delete' || capability === 'fs.rename') && this.taskTargetsCoverScope(normalized, accepted)) {
      return true;
    }
    if (capability === 'fs.delete' || capability === 'fs.rename') return false;
    const acceptedScopes = accepted.targetScopes
      .flatMap(expandPlanTargetTokens)
      .map(normalizePlanScope)
      .filter(Boolean);
    if (this.scopeCovered(normalized, acceptedScopes)) return true;
    return accepted.accessScopes.some((accessScope) => {
      if (accessScope.outsideWorkspace) return false;
      if (!this.accessScopeCapabilityMatches(accessScope, capability)) return false;
      return this.scopeCovers(accessScope.path, normalized);
    });
  }

  exactGrantCapabilityMatches(
    grant: AcceptedPlanExactOperationGrant,
    capability: string | undefined
  ): boolean {
    if (!capability) return false;
    if (grant.capability === capability) return true;
    if (grant.capability === 'fs.write' && capability === 'fs.patch') return true;
    if (capability === 'fs.write' && ['create', 'write'].includes(grant.operation)) return true;
    if (capability === 'fs.patch' && grant.operation === 'patch') return true;
    if (capability === 'fs.delete' && grant.operation === 'delete') return true;
    if (capability === 'fs.rename' && grant.operation === 'rename') return true;
    return false;
  }

  capabilitySetAllows(
    allowed: Set<string>,
    capability: string,
    direction: 'acceptedCoversAction' | 'actionCoversAccepted' = 'acceptedCoversAction'
  ): boolean {
    if (allowed.has(capability)) return true;
    return [...allowed].some((item) =>
      direction === 'acceptedCoversAction'
        ? this.capabilityCovers(item, capability)
        : this.capabilityCovers(capability, item)
    );
  }

  canonicalCapabilities(accepted: AcceptedImplementationPlanContext): Set<string> {
    const capabilities = [
      ...accepted.capabilities,
      ...accepted.tasks.map((task) => task.capability),
      ...accepted.exactOperationGrants.flatMap((grant) => [
        grant.capability,
        this.capabilityForOperation(grant.operation),
      ]),
      ...accepted.accessScopes.flatMap((scope) => [
        ...scope.capabilities,
        ...scope.operations.map((operation) => this.capabilityForOperation(operation)),
      ]),
    ];
    return new Set(capabilities
      .map((capability) => this.canonicalCapability(capability))
      .filter((capability): capability is string => Boolean(capability)));
  }

  capabilityForOperation(operation: string | undefined): string | undefined {
    if (!operation) return undefined;
    if (operation === 'read' || operation === 'list' || operation === 'search') return 'fs.read';
    if (operation === 'create' || operation === 'write' || operation === 'overwrite') return 'fs.write';
    if (operation === 'patch' || operation === 'replace') return 'fs.patch';
    if (operation === 'delete' || operation === 'remove') return 'fs.delete';
    if (operation === 'rename' || operation === 'move') return 'fs.rename';
    return undefined;
  }

  capabilityCovers(acceptedCapability: string, actionCapability: string): boolean {
    if (acceptedCapability === actionCapability) return true;
    if (acceptedCapability === 'fs.write' && actionCapability === 'fs.patch') return true;
    return false;
  }

  scopeCovers(accepted: string, candidate: string): boolean {
    if (!accepted || !candidate) return false;
    const acceptedNormalized = normalizePlanScopeIdentity(accepted);
    const candidateNormalized = normalizePlanScopeIdentity(candidate);
    if (acceptedNormalized === candidateNormalized) return true;
    if (isAbsolutePath(acceptedNormalized) || isAbsolutePath(candidateNormalized)) return false;
    const acceptedDir = acceptedNormalized.endsWith('/') ? acceptedNormalized : `${acceptedNormalized}/`;
    return candidateNormalized.startsWith(acceptedDir);
  }

  private autoExecutableCapability(capability: string): boolean {
    return [
      'fs.read',
      'fs.write',
      'fs.patch',
      'fs.delete',
      'process.exec',
      'network.egress',
      'git.read',
      'git.write',
      'git.push',
      'config.modify',
      'browser.control',
      'provider.egress',
    ].includes(capability);
  }

  private scopeCovered(scope: string, acceptedScopes: string[]): boolean {
    if (acceptedScopes.length === 0) return false;
    return acceptedScopes.some((accepted) => this.scopeCovers(accepted, scope));
  }

  private taskTargetsCoverScope(scope: string, accepted: AcceptedImplementationPlanContext): boolean {
    const normalized = normalizePlanScopeIdentity(scope);
    if (!normalized) return false;
    return accepted.tasks.some((task) =>
      this.ports.taskTargets(task as unknown as Record<string, unknown>)
        .flatMap(expandPlanTargetTokens)
        .map(normalizePlanScopeIdentity)
        .filter(Boolean)
        .some((target) =>
          this.scopeCovers(target, normalized) ||
          this.scopeCovers(normalized, target)
        )
    );
  }

  private exactOperationGrantCoversTarget(
    scope: string,
    capability: string | undefined,
    accepted: AcceptedImplementationPlanContext
  ): boolean {
    const normalized = normalizePlanScopeIdentity(scope);
    if (!normalized || !capability) return false;
    return accepted.exactOperationGrants.some((grant) => {
      if (!this.exactGrantCapabilityMatches(grant, capability)) return false;
      return normalizePlanScopeIdentity(grant.targetPath) === normalized;
    });
  }

  private canonicalCapability(capability: string | undefined): string | undefined {
    if (!capability) return undefined;
    if (this.autoExecutableCapability(capability)) return capability;
    return undefined;
  }

  private accessScopeCapabilityMatches(scope: AcceptedPlanAccessScope, capability: string | undefined): boolean {
    if (!capability) return false;
    if (scope.capabilities.some((item) => this.capabilityCovers(item, capability))) return true;
    if (capability === 'fs.write' && scope.operations.some((operation) => operation === 'create' || operation === 'write')) return true;
    if (capability === 'fs.patch' && scope.operations.includes('patch')) return true;
    return false;
  }
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizePlanScopeIdentity(value: string): string {
  return normalizePlanScope(value).replace(/\/+$/, '');
}

function expandPlanTargetTokens(target: string): string[] {
  if (!target || !target.trim()) return [];
  const candidates = target.match(/[A-Za-z0-9_.\-/]+/g) ?? [];
  const pathLike = candidates.filter((token) => token.includes('/') || /\.[A-Za-z0-9]+$/.test(token));
  return pathLike.length ? pathLike : [target.trim()];
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}
