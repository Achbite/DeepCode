import type { EntryIntent, SessionDriverInput } from './types.js';

export function routeEntryIntent(input: SessionDriverInput): EntryIntent {
  if (input.repairRequested || input.driverRequest?.kind === 'needRepairProposal') {
    return 'repairLoop';
  }
  if (input.requestedResources || input.driverRequest?.kind === 'needResourcePacket') {
    return 'resourceDiscovery';
  }
  if (input.explicitDevelopmentTask) {
    return 'developmentTask';
  }
  const allowed = input.stateContract?.allowedProposals ?? input.driverRequest?.stateContract?.allowedProposals ?? [];
  if (allowed.includes('actionBundle') || allowed.includes('decisionRequest')) {
    return 'developmentTask';
  }
  return 'readOnlyAnswer';
}
