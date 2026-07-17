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

export class ProviderTurnPolicy {
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
}
