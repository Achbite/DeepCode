import type { KernelPlanCommand, KernelPlanContract } from '@deepcode/protocol';
import type { ActionBundleDraft } from './types.js';

export function compileActionBundleToPlanContract(bundle: ActionBundleDraft): KernelPlanContract {
  const requiredCapabilities = uniqueSorted(bundle.actions.map((action) => action.capability));
  const scope = uniqueSorted(bundle.actions.flatMap((action) => action.resourceScope));
  return {
    id: bundle.id,
    goal: bundle.goal,
    scope: scope.length > 0 ? scope : ['workspace'],
    forbiddenActions: [],
    requiredCapabilities,
    completionCriteria: bundle.validationExpectations.map((expectation) => ({
      id: expectation.id,
      description: expectation.description,
      evidenceRequired: ['validation_result'],
      validationKind: expectation.command ? 'command' : undefined,
    })),
    riskLevel: riskLevelForCapabilities(requiredCapabilities),
    requiresUserApproval: requiredCapabilities.some((capability) => highRiskCapability(capability)),
  };
}

export function createPlanContractSubmitCommand(input: {
  requestId: string;
  runId?: string;
  sessionId?: string;
  bundle: ActionBundleDraft;
}): KernelPlanCommand {
  return {
    kind: 'planContractSubmit',
    requestId: input.requestId,
    runId: input.runId,
    sessionId: input.sessionId,
    contract: compileActionBundleToPlanContract(input.bundle),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function riskLevelForCapabilities(capabilities: string[]): KernelPlanContract['riskLevel'] {
  if (capabilities.some((capability) => capability === 'secret.read' || capability === 'kernel.modify')) {
    return 'critical';
  }
  if (capabilities.some((capability) => capability === 'process.exec' || capability === 'network.egress')) {
    return 'high';
  }
  if (
    capabilities.some((capability) =>
      ['workspace.write', 'workspace.create', 'workspace.delete', 'workspace.rename', 'git.write'].includes(capability)
    )
  ) {
    return 'medium';
  }
  return 'low';
}

function highRiskCapability(capability: string): boolean {
  return [
    'workspace.write',
    'workspace.create',
    'workspace.delete',
    'workspace.rename',
    'git.write',
    'process.exec',
    'network.egress',
    'secret.read',
    'kernel.modify',
  ].includes(capability);
}
