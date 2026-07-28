import {
  decodeRawToolArgumentsV2,
  type CapabilityLeaseRefV2,
  type DeadlineRequestV2,
  type RawToolArgumentsV2,
  type RequestedResourceV2,
  type ScopeManifestV2,
  type ToolContextRefV2,
  type ToolIntentAuthorityV2,
} from '@deepcode/protocol';

export interface SessionPlanActionScopeInputV2 {
  planRevision: string;
  planActionId: string;
  operationId: string;
  toolId: string;
  requestedResources: RequestedResourceV2[];
}

export interface SessionCapabilityScopePreviewV2 {
  runId: string;
  expectedControlEpoch: number;
  manifest: ScopeManifestV2;
  rawArguments: RawToolArgumentsV2;
  idempotencyKey: string;
  deadline: DeadlineRequestV2;
  toolContextRef: ToolContextRefV2;
}

/**
 * Session preserves the confirmed PlanAction structure, but deliberately does
 * not normalize paths, symlinks, repository state, network targets, or scope.
 */
export function createScopeManifestV2(
  input: SessionPlanActionScopeInputV2
): ScopeManifestV2 {
  if (
    input.requestedResources.length === 0
    || input.requestedResources.length > 256
  ) {
    throw new SessionKernelAuthorityError(
      'session_kernel_authority_resources_invalid',
      'ScopeManifest requestedResources must contain 1..=256 entries.'
    );
  }
  return {
    planRevision: identity(input.planRevision, 'planRevision'),
    planActionId: identity(input.planActionId, 'planActionId'),
    operationId: identity(input.operationId, 'operationId'),
    toolId: namespacedToolId(input.toolId),
    requestedResources: input.requestedResources.map(cloneRequestedResource),
  };
}

export function createCapabilityScopePreviewV2(input: {
  runId: string;
  controlEpoch: number;
  manifest: ScopeManifestV2;
  rawArguments: unknown;
  idempotencyKey: string;
  toolContext: ToolContextRefV2;
  deadline?: DeadlineRequestV2;
}): SessionCapabilityScopePreviewV2 {
  if (!Number.isSafeInteger(input.controlEpoch) || input.controlEpoch <= 0) {
    throw new SessionKernelAuthorityError(
      'session_kernel_authority_epoch_invalid',
      'Capability preview requires a positive control epoch.'
    );
  }
  return {
    runId: identity(input.runId, 'runId'),
    expectedControlEpoch: input.controlEpoch,
    manifest: input.manifest,
    rawArguments: decodeRawToolArgumentsV2(input.rawArguments),
    idempotencyKey: requiredText(input.idempotencyKey, 'idempotencyKey'),
    deadline: input.deadline ?? {
      kind: 'contractDefault',
      data: {},
    },
    toolContextRef: { ...input.toolContext },
  };
}

export function planActionAuthorityV2(input: {
  planRevision: string;
  planActionId: string;
  lease?: CapabilityLeaseRefV2;
}): ToolIntentAuthorityV2 {
  if (
    input.lease
    && (
      !Number.isSafeInteger(input.lease.version)
      || input.lease.version <= 0
    )
  ) {
    throw new SessionKernelAuthorityError(
      'session_kernel_authority_lease_version_invalid',
      'Capability lease version must be a positive safe integer.'
    );
  }
  return {
    kind: 'planAction',
    data: {
      planRevision: identity(input.planRevision, 'planRevision'),
      planActionId: identity(input.planActionId, 'planActionId'),
      ...(input.lease ? { lease: { ...input.lease } } : {}),
    },
  };
}

export function contextReadAuthorityV2(purpose: string): ToolIntentAuthorityV2 {
  if (!purpose.trim() || purpose.length > 1024) {
    throw new SessionKernelAuthorityError(
      'session_kernel_authority_context_purpose_invalid',
      'contextRead purpose must contain 1..=1024 characters.'
    );
  }
  return {
    kind: 'contextRead',
    data: { purpose },
  };
}

export function rawToolArgumentsV2(value: unknown): RawToolArgumentsV2 {
  return decodeRawToolArgumentsV2(value);
}

function identity(value: string, field: string): string {
  if (
    !value
    || new TextEncoder().encode(value).byteLength > 512
    || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new SessionKernelAuthorityError(
      'session_kernel_authority_identity_invalid',
      `${field} must be a bounded identity without surrounding whitespace or control characters.`
    );
  }
  return value;
}

function namespacedToolId(value: string): string {
  if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(value)) {
    throw new SessionKernelAuthorityError(
      'session_kernel_authority_tool_id_invalid',
      'toolId must be a lowercase namespaced identity.'
    );
  }
  return value;
}

function requiredText(value: string, field: string): string {
  if (!value.length || value.length > 16 * 1024) {
    throw new SessionKernelAuthorityError(
      'session_kernel_authority_text_invalid',
      `${field} must contain 1..=16384 characters.`
    );
  }
  return value;
}

function cloneRequestedResource(
  resource: RequestedResourceV2
): RequestedResourceV2 {
  switch (resource.kind) {
    case 'workspacePath':
      return { kind: resource.kind, data: { ...resource.data } };
    case 'repository':
      return { kind: resource.kind, data: { ...resource.data } };
    case 'networkUrl':
      return { kind: resource.kind, data: { ...resource.data } };
    case 'networkQuery':
      return { kind: resource.kind, data: { ...resource.data } };
    case 'exactInvocation':
      return { kind: resource.kind, data: { ...resource.data } };
  }
}

export class SessionKernelAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelAuthorityError';
  }
}
