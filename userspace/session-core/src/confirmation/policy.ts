import type { KernelPlanReviewReport } from '@deepcode/protocol';
import type { ActionBundleDraft } from '../agent-plan/types.js';
import type {
  AutoConfirmDecision,
  CapabilityTier,
  PermissionAutoApprovalDecision,
  PermissionAutoApprovalPolicy,
  PlanConfirmationPolicy,
} from './types.js';

export const DEFAULT_PLAN_CONFIRMATION_POLICY: PlanConfirmationPolicy = {
  defaultRequiresUserConfirmation: true,
  autoConfirmEnabled: false,
  allowedCapabilityTiers: ['read'],
  deniedCapabilityTiers: ['secret', 'kernel'],
};

export const DEFAULT_PERMISSION_AUTO_APPROVAL_POLICY: PermissionAutoApprovalPolicy = {
  autoApproveRead: false,
  autoApproveWrite: false,
  autoApproveDelete: false,
  autoApproveProcess: false,
  autoApproveNetwork: false,
  autoApproveSecret: false,
  autoApproveKernel: false,
};

export function capabilityTier(capability: string): CapabilityTier {
  if (capability === 'workspace.read' || capability === 'code.search' || capability.endsWith('.read')) return 'read';
  if (capability === 'workspace.delete' || capability.endsWith('.delete')) return 'delete';
  if (capability === 'process.exec' || capability === 'shell.exec') return 'process';
  if (capability === 'network.egress' || capability.startsWith('network.')) return 'network';
  if (capability === 'secret.read' || capability.startsWith('secret.')) return 'secret';
  if (capability === 'kernel.modify' || capability.startsWith('kernel.')) return 'kernel';
  if (
    capability === 'workspace.write' ||
    capability === 'workspace.create' ||
    capability === 'workspace.rename' ||
    capability.endsWith('.write') ||
    capability.endsWith('.create') ||
    capability.endsWith('.rename')
  ) {
    return 'write';
  }
  return 'unknown';
}

export function decidePlanConfirmation(input: {
  actionBundle: ActionBundleDraft;
  kernelPlanReview?: KernelPlanReviewReport;
  policy?: Partial<PlanConfirmationPolicy>;
}): AutoConfirmDecision {
  const policy = { ...DEFAULT_PLAN_CONFIRMATION_POLICY, ...input.policy };
  const requiredCapabilities = uniqueSorted(input.actionBundle.actions.map((action) => action.capability));
  const resourceScope = uniqueSorted(input.actionBundle.actions.flatMap((action) => action.resourceScope));
  const capabilityTiers = uniqueSorted(requiredCapabilities.map(capabilityTier)) as CapabilityTier[];
  const deniedReasons = [
    ...(input.kernelPlanReview?.deniedReasons ?? []),
    ...(input.kernelPlanReview?.hardFloorHits ?? []).map((hit) => `hard_floor:${hit}`),
  ];
  const permissionGaps = input.kernelPlanReview?.permissionGaps ?? [];

  if (deniedReasons.length > 0 || capabilityTiers.some((tier) => policy.deniedCapabilityTiers?.includes(tier))) {
    return {
      decision: 'denied',
      reason: 'Kernel PlanReview or capability tier denied the plan',
      requiredCapabilities,
      capabilityTiers,
      resourceScope,
      permissionGaps,
      deniedReasons,
      matchedPolicy: 'plan-confirmation:deny',
    };
  }

  if (!policy.autoConfirmEnabled) {
    return {
      decision: 'requiresUserConfirmation',
      reason: 'formal plan requires user confirmation by default',
      requiredCapabilities,
      capabilityTiers,
      resourceScope,
      permissionGaps,
      deniedReasons,
      matchedPolicy: 'plan-confirmation:default',
    };
  }

  const unsupportedTier = capabilityTiers.find((tier) => !policy.allowedCapabilityTiers.includes(tier));
  if (unsupportedTier) {
    return {
      decision: 'requiresUserConfirmation',
      reason: `capability tier ${unsupportedTier} is not enabled for auto confirmation`,
      requiredCapabilities,
      capabilityTiers,
      resourceScope,
      permissionGaps,
      deniedReasons,
      matchedPolicy: 'plan-confirmation:tier',
    };
  }

  if (permissionGaps.length > 0) {
    return {
      decision: 'requiresUserConfirmation',
      reason: 'Kernel PlanReview produced permission gaps',
      requiredCapabilities,
      capabilityTiers,
      resourceScope,
      permissionGaps,
      deniedReasons,
      matchedPolicy: 'plan-confirmation:permission-gap',
    };
  }

  return {
    decision: 'autoConfirmed',
    reason: 'user enabled auto confirmation for all required capability tiers',
    requiredCapabilities,
    capabilityTiers,
    resourceScope,
    permissionGaps,
    deniedReasons,
    matchedPolicy: 'plan-confirmation:auto',
  };
}

export function decidePermissionAutoApproval(input: {
  capability: string;
  resourceScope: string;
  policy?: Partial<PermissionAutoApprovalPolicy>;
}): PermissionAutoApprovalDecision {
  const policy = { ...DEFAULT_PERMISSION_AUTO_APPROVAL_POLICY, ...input.policy };
  const tier = capabilityTier(input.capability);
  if (tier === 'secret' || tier === 'kernel') {
    return permissionDecision('denied', input, tier, `${tier} capabilities cannot be auto approved by Session policy`, 'permission:auto-deny');
  }
  if (policy.allowedResourceScopes && !policy.allowedResourceScopes.includes(input.resourceScope)) {
    return permissionDecision('requiresUserConfirmation', input, tier, 'resource scope is outside auto approval allowlist', 'permission:scope');
  }
  const allowed =
    (tier === 'read' && policy.autoApproveRead) ||
    (tier === 'write' && policy.autoApproveWrite) ||
    (tier === 'delete' && policy.autoApproveDelete) ||
    (tier === 'process' && policy.autoApproveProcess) ||
    (tier === 'network' && policy.autoApproveNetwork);
  if (!allowed) {
    return permissionDecision('requiresUserConfirmation', input, tier, `${tier} auto approval is not enabled`, 'permission:tier');
  }
  return permissionDecision('autoApproved', input, tier, `${tier} auto approval is enabled`, 'permission:auto');
}

function permissionDecision(
  decision: PermissionAutoApprovalDecision['decision'],
  input: { capability: string; resourceScope: string },
  capabilityTierValue: CapabilityTier,
  reason: string,
  matchedPolicy: string
): PermissionAutoApprovalDecision {
  return {
    decision,
    reason,
    capability: input.capability,
    capabilityTier: capabilityTierValue,
    resourceScope: input.resourceScope,
    matchedPolicy,
  };
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}
