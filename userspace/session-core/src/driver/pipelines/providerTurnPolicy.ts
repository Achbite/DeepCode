export interface ProviderTurnPolicyState {
  acceptedTaskPlan?: {
    toolIds?: string[];
  };
  currentTaskContext?: {
    toolIds?: string[];
  };
  stateContract?: {
    allowedProposals?: string[];
  };
  driverRequest?: {
    stateContract?: {
      allowedProposals?: string[];
    };
  };
}

export interface ProviderTurnPolicyOptions {
  sideEffectToolIds: ReadonlySet<string>;
}

export class ProviderTurnPolicy {
  constructor(private readonly options: ProviderTurnPolicyOptions) {}

  allowedProposals(kernelAllowed: string[], state: ProviderTurnPolicyState): string[] {
    const merged = new Set(kernelAllowed);
    if (state.acceptedTaskPlan) {
      merged.delete('taskPlan');
      for (const kind of ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']) merged.add(kind);
    } else {
      merged.add('taskPlan');
    }
    return [...merged];
  }

  shouldAttemptActionBundleCompactionRepair(state: ProviderTurnPolicyState): boolean {
    if (!state.acceptedTaskPlan && !state.currentTaskContext) return false;
    const allowed = state.stateContract?.allowedProposals ?? state.driverRequest?.stateContract?.allowedProposals ?? [];
    if (allowed.length && !allowed.includes('actionBundle')) return false;
    const toolIds = state.currentTaskContext?.toolIds ?? state.acceptedTaskPlan?.toolIds ?? [];
    return toolIds.some((toolId) => this.options.sideEffectToolIds.has(toolId));
  }
}
