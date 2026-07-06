import type {
  AcceptedImplementationPlanContext,
  AcceptedPlanExactOperationGrant,
} from '../../accepted-plan/types.js';

export interface AcceptedPlanOperationTargetResolverPorts {
  normalizeTargetScope(value: string, accepted: AcceptedImplementationPlanContext): string;
  normalizePlanScope(value: string): string;
  concreteDirectoryOperationTarget(value: string): string | undefined;
  concreteFileOperationTarget(value: string): string | undefined;
  exactGrantCapabilityMatches(grant: AcceptedPlanExactOperationGrant, capability: string | undefined): boolean;
  actionEffectiveCapability(action: Record<string, unknown>): string;
  actionFileTargetPath(action: Record<string, unknown>): string | undefined;
}

export class AcceptedPlanOperationTargetResolver {
  constructor(private readonly ports: AcceptedPlanOperationTargetResolverPorts) {}

  concreteFileTarget(
    value: string,
    accepted?: AcceptedImplementationPlanContext
  ): string | undefined {
    const normalized = accepted ? this.ports.normalizeTargetScope(value, accepted) : this.ports.normalizePlanScope(value);
    return this.ports.concreteFileOperationTarget(normalized);
  }

  concreteDeleteTarget(
    value: string,
    accepted: AcceptedImplementationPlanContext | undefined,
    grant?: AcceptedPlanExactOperationGrant
  ): string | undefined {
    const normalized = accepted ? this.ports.normalizeTargetScope(value, accepted) : this.ports.normalizePlanScope(value);
    if (grant?.targetResourceKind === 'directory') {
      return this.ports.concreteDirectoryOperationTarget(normalized);
    }
    return this.ports.concreteFileOperationTarget(normalized)
      ?? this.ports.concreteDirectoryOperationTarget(normalized);
  }

  exactGrantForAction(
    action: Record<string, unknown>,
    accepted?: AcceptedImplementationPlanContext
  ): AcceptedPlanExactOperationGrant | undefined {
    if (!accepted) return undefined;
    const capability = this.ports.actionEffectiveCapability(action);
    const rawTarget = this.ports.actionFileTargetPath(action);
    if (!capability || !rawTarget) return undefined;
    const normalized = this.ports.normalizeTargetScope(rawTarget, accepted).replace(/\/+$/, '');
    return accepted.exactOperationGrants.find((grant) =>
      this.ports.exactGrantCapabilityMatches(grant, capability) &&
      this.ports.normalizePlanScope(grant.targetPath).replace(/\/+$/, '') === normalized
    );
  }
}
