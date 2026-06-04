export type CapabilityTier = 'read' | 'write' | 'delete' | 'process' | 'network' | 'secret' | 'kernel' | 'unknown';

export interface PlanConfirmationPolicy {
  defaultRequiresUserConfirmation: boolean;
  autoConfirmEnabled: boolean;
  allowedCapabilityTiers: CapabilityTier[];
  deniedCapabilityTiers?: CapabilityTier[];
}

export interface PermissionAutoApprovalPolicy {
  autoApproveRead: boolean;
  autoApproveWrite: boolean;
  autoApproveDelete: boolean;
  autoApproveProcess: boolean;
  autoApproveNetwork: boolean;
  autoApproveSecret: boolean;
  autoApproveKernel: boolean;
  allowedResourceScopes?: string[];
}

export interface AutoConfirmDecision {
  decision: 'autoConfirmed' | 'requiresUserConfirmation' | 'denied';
  reason: string;
  requiredCapabilities: string[];
  capabilityTiers: CapabilityTier[];
  resourceScope: string[];
  permissionGaps: string[];
  deniedReasons: string[];
  matchedPolicy: string;
}

export interface PermissionAutoApprovalDecision {
  decision: 'autoApproved' | 'requiresUserConfirmation' | 'denied';
  reason: string;
  capability: string;
  capabilityTier: CapabilityTier;
  resourceScope: string;
  matchedPolicy: string;
}
