export interface ProviderTurnPolicyState {
  acceptedImplementationPlan?: unknown;
  currentTaskContext?: unknown;
  stateContract?: {
    allowedProposals?: string[];
    capabilityProjection?: string[];
  };
  driverRequest?: {
    stateContract?: {
      allowedProposals?: string[];
      capabilityProjection?: string[];
    };
  };
}

export interface ProviderTurnPolicyOptions {
  sideEffectCapabilities: ReadonlySet<string>;
}

export class ProviderTurnPolicy {
  constructor(private readonly options: ProviderTurnPolicyOptions) {}

  allowedProposals(kernelAllowed: string[], state: ProviderTurnPolicyState): string[] {
    const merged = new Set(kernelAllowed);
    if (state.acceptedImplementationPlan) {
      merged.delete('taskPlan');
      merged.delete('implementationPlan');
      for (const kind of ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic']) merged.add(kind);
    } else {
      merged.add('taskPlan');
    }
    return [...merged];
  }

  shouldAttemptActionBundleCompactionRepair(state: ProviderTurnPolicyState): boolean {
    if (!state.acceptedImplementationPlan && !state.currentTaskContext) return false;
    const allowed = state.stateContract?.allowedProposals ?? state.driverRequest?.stateContract?.allowedProposals ?? [];
    if (allowed.length && !allowed.includes('actionBundle')) return false;
    const capabilities = state.stateContract?.capabilityProjection ?? state.driverRequest?.stateContract?.capabilityProjection ?? [];
    return capabilities.some((capability) => this.options.sideEffectCapabilities.has(capability));
  }
}
