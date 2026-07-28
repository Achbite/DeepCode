export const KERNEL_ABI_V2_VERSION = 'deepcode.kernel.abi.v2' as const;
export const KERNEL_TOOL_REGISTRY_VERSION_V2 = 'deepcode.kernel.tools.v2' as const;
export const KERNEL_TOOL_INVENTORY_V2_FORMAT =
  'deepcode.kernel.tool-inventory.v2' as const;
export const KERNEL_TOOL_CONTEXT_V2_FORMAT =
  'deepcode.kernel.tool-context.v2' as const;

export type JsonPrimitiveV2 = string | number | boolean | null;
export type JsonValueV2 = JsonPrimitiveV2 | JsonObjectV2 | JsonValueV2[];
export interface JsonObjectV2 {
  [key: string]: JsonValueV2;
}

export type RunIdV2 = string;
export type ControlEpochV2 = number;
export type CommandRequestIdV2 = string;
export type OperationIdV2 = string;
export type PlanRevisionV2 = string;
export type PlanActionIdV2 = string;
export type ToolIdV2 = string;
export type RawToolArgumentsV2 = JsonObjectV2;
export type ToolCatalogDigestV2 = string;
export type ToolContextDigestV2 = string;
export type WorkspaceBindingDigestV2 = string;
export type CapabilityScopeDigestV2 = string;
export type CapabilityAuthorizationDigestV2 = string;
export type ToolContractDigestV2 = string;
export type CanonicalArgumentsDigestV2 = string;
export type FactIdV2 = string;
export type InvocationIdV2 = string;
export type AttemptIdV2 = string;
export type EffectIdV2 = string;

export type ToolAvailabilityV2 =
  | 'ready'
  | 'disabled'
  | 'revoked'
  | 'unavailable';
export type ToolRiskV2 = 'low' | 'medium' | 'high' | 'critical';
export type ToolEffectClassV2 = 'read' | 'mutation';
export type ToolEffectScopeV2 =
  | 'workspaceRead'
  | 'workspaceWrite'
  | 'repositoryRead'
  | 'repositoryIndexWrite'
  | 'repositoryHistoryWrite'
  | 'networkRead';

/**
 * Descriptors are Kernel-owned immutable data. Session transports the schema
 * and prompt fields but never derives canonical arguments or scope from them.
 */
export interface ToolDescriptorV2 {
  toolId: ToolIdV2;
  description: string;
  inputSchema: JsonObjectV2;
  promptTemplate: string;
  availability: ToolAvailabilityV2;
  effectClass: ToolEffectClassV2;
  effectScope: ToolEffectScopeV2;
  risk: ToolRiskV2;
  contractDigest: ToolContractDigestV2;
}

export interface ToolInventoryV2 {
  formatVersion: typeof KERNEL_TOOL_INVENTORY_V2_FORMAT;
  catalogVersion: typeof KERNEL_TOOL_REGISTRY_VERSION_V2;
  catalogDigest: ToolCatalogDigestV2;
  tools: ToolDescriptorV2[];
}

/**
 * Provider-safe projection. It must never contain a run capability, a
 * decision capability, a lease, a secret, or an absolute workspace root.
 */
export interface ToolContextBundleV2 {
  formatVersion: typeof KERNEL_TOOL_CONTEXT_V2_FORMAT;
  contextVersion: number;
  catalogDigest: ToolCatalogDigestV2;
  contextDigest: ToolContextDigestV2;
  fixedPrompt: string;
  tools: ToolDescriptorV2[];
}

export interface ToolContextRefV2 {
  contextVersion: number;
  catalogDigest: ToolCatalogDigestV2;
  contextDigest: ToolContextDigestV2;
}

export type DeadlineRequestV2 =
  | { kind: 'contractDefault'; data: Record<string, never> }
  | { kind: 'exactMilliseconds'; data: { value: number } };

export type RequestedResourceV2 =
  | {
      kind: 'workspacePath';
      data: { path: string; access: 'read' | 'write' };
    }
  | {
      kind: 'repository';
      data: { area: 'state' | 'index' | 'history' };
    }
  | {
      kind: 'networkUrl';
      data: { url: string };
    }
  | {
      kind: 'networkQuery';
      data: { query: string };
    }
  | {
      kind: 'exactInvocation';
      data: { invocationDigest: string };
    };

export interface CapabilityLeaseRefV2 {
  leaseId: string;
  version: number;
  scopeDigest: CapabilityScopeDigestV2;
}

export type ToolIntentAuthorityV2 =
  | {
      kind: 'planAction';
      data: {
        planRevision: PlanRevisionV2;
        planActionId: PlanActionIdV2;
        lease?: CapabilityLeaseRefV2;
      };
    }
  | {
      kind: 'contextRead';
      data: {
        purpose: string;
      };
    };

export interface RunOpenV2 {
  workspaceBindingRef: string;
  inputId: string;
  opaqueInputRef: string;
}

export interface RunOpenReplyV2 {
  runId: RunIdV2;
  controlEpoch: ControlEpochV2;
  workspaceBindingDigest: WorkspaceBindingDigestV2;
  toolContext: ToolContextBundleV2;
}

export interface ToolContextGetV2 {
  runId: RunIdV2;
  knownContext?: ToolContextRefV2;
}

export type ToolContextGetReplyV2 =
  | {
      kind: 'current';
      data: { contextRef: ToolContextRefV2 };
    }
  | {
      kind: 'updated';
      data: { toolContext: ToolContextBundleV2 };
    };

/**
 * Session-owned durable plan shape. The HTTP adapter flattens this structure
 * into CapabilityScopePreviewV2 without changing any requested resource.
 */
export interface ScopeManifestV2 {
  planRevision: PlanRevisionV2;
  planActionId: PlanActionIdV2;
  operationId: OperationIdV2;
  toolId: ToolIdV2;
  requestedResources: RequestedResourceV2[];
}

export interface CapabilityScopePreviewV2 {
  runId: RunIdV2;
  expectedControlEpoch: ControlEpochV2;
  planRevision: PlanRevisionV2;
  planActionId: PlanActionIdV2;
  operationId: OperationIdV2;
  idempotencyKey: string;
  toolId: ToolIdV2;
  rawArguments: RawToolArgumentsV2;
  requestedResources: RequestedResourceV2[];
  deadline: DeadlineRequestV2;
  toolContextRef: ToolContextRefV2;
}

export type CapabilityScopeDispositionV2 =
  | 'autoIssuable'
  | 'requiresUserDecision';
export type CapabilityScopeRejectionReasonV2 =
  | 'toolNotRegistered'
  | 'toolUnavailable'
  | 'invalidArguments'
  | 'requestedScopeInvalid'
  | 'settingsDenied'
  | 'staleToolContext'
  | 'staleControlEpoch';

export interface CapabilityApprovalViewV2 {
  summary: string;
  canonicalTargets: string[];
  scopeDelta: string[];
  risk: ToolRiskV2;
  effectClass: ToolEffectClassV2;
  effectScope: ToolEffectScopeV2;
  effectiveDeadlineMs: number;
  scopeDigest: CapabilityScopeDigestV2;
}

/**
 * canonicalScope is intentionally opaque to Session. Only Kernel may create,
 * compare, or interpret it.
 */
export interface CapabilityScopePreviewRecordV2 {
  previewId: string;
  runId: RunIdV2;
  controlEpoch: ControlEpochV2;
  planRevision: PlanRevisionV2;
  planActionId: PlanActionIdV2;
  operationId: OperationIdV2;
  toolId: ToolIdV2;
  canonicalArgumentsDigest: CanonicalArgumentsDigestV2;
  canonicalScope: JsonObjectV2;
  scopeDigest: CapabilityScopeDigestV2;
  authorizationDigest: CapabilityAuthorizationDigestV2;
  toolContractDigest: ToolContractDigestV2;
  contextRef: ToolContextRefV2;
  effectClass: ToolEffectClassV2;
  effectScope: ToolEffectScopeV2;
  risk: ToolRiskV2;
  effectiveDeadlineMs: number;
  disposition: CapabilityScopeDispositionV2;
  approvalView: CapabilityApprovalViewV2;
}

export type CapabilityScopePreviewReplyV2 =
  | {
      kind: 'previewed';
      data: { preview: CapabilityScopePreviewRecordV2 };
    }
  | {
      kind: 'rejected';
      data: {
        toolId: ToolIdV2;
        reason: CapabilityScopeRejectionReasonV2;
        guidance: string;
      };
    };

/**
 * Provider calls normalize into this Session semantic record. Transport
 * authentication is never part of the command JSON.
 */
export interface ToolIntentV2 {
  runId: RunIdV2;
  expectedControlEpoch: ControlEpochV2;
  operationId: OperationIdV2;
  idempotencyKey: string;
  toolId: ToolIdV2;
  rawArguments: RawToolArgumentsV2;
  authority: ToolIntentAuthorityV2;
  deadline: DeadlineRequestV2;
  toolContextRef: ToolContextRefV2;
}

export type ToolIntentSubmitV2 = ToolIntentV2;

export type ToolIntentRejectionReasonV2 =
  | 'toolNotRegistered'
  | 'toolUnavailable'
  | 'invalidArguments'
  | 'staleToolContext'
  | 'staleControlEpoch'
  | 'planActionRequired'
  | 'capabilityLeaseStale'
  | 'capabilityScopeMismatch'
  | 'settingsDenied'
  | 'runBusy'
  | 'capacityExceeded'
  | 'indeterminateRecoveryRequired';

export type ToolIntentSubmitReplyV2 =
  | {
      kind: 'admitted';
      data: {
        runId: RunIdV2;
        operationId: OperationIdV2;
        acceptedControlEpoch: ControlEpochV2;
        lease?: CapabilityLeaseRefV2;
        invocationId: InvocationIdV2;
        attemptId: AttemptIdV2;
        effectiveDeadlineMs: number;
        admissionFactId: FactIdV2;
        admissionBatchHighWater: number;
      };
    }
  | {
      kind: 'awaitingCapability';
      data: {
        runId: RunIdV2;
        operationId: OperationIdV2;
        acceptedControlEpoch: ControlEpochV2;
        invocationId: InvocationIdV2;
        preview: CapabilityScopePreviewRecordV2;
        awaitingFactId: FactIdV2;
        awaitingBatchHighWater: number;
      };
    }
  | {
      kind: 'rejected';
      data: {
        runId: RunIdV2;
        operationId: OperationIdV2;
        currentControlEpoch: ControlEpochV2;
        reason: ToolIntentRejectionReasonV2;
        guidance: string;
        rejectionFactId: FactIdV2;
        rejectionBatchHighWater: number;
      };
    };

export type KernelFactDomainV2 =
  | 'control'
  | 'authorization'
  | 'invocation'
  | 'effect'
  | 'resource'
  | 'cleanup';

export interface KernelFactLineageV2 {
  runId: RunIdV2;
  controlEpoch?: ControlEpochV2;
  planActionIds: PlanActionIdV2[];
  operationId?: OperationIdV2;
  capabilityLeaseId?: string;
  invocationId?: InvocationIdV2;
  attemptId?: AttemptIdV2;
  effectId?: EffectIdV2;
  resourceIds: string[];
}

export interface KernelFactProjectionV2 {
  abiVersion: typeof KERNEL_ABI_V2_VERSION;
  factId: FactIdV2;
  ledgerSequence: number;
  runSequence: number;
  recordedAt: string;
  domain: KernelFactDomainV2;
  factKind: string;
  lineage: KernelFactLineageV2;
  details: JsonObjectV2;
}

export interface KernelFactsQueryScopedV2 {
  runId: RunIdV2;
  afterLedgerSequence: number;
  limit: number;
  continuation?: string;
}

export interface KernelFactProjectionPageV2 {
  requestedAfterLedgerSequence: number;
  snapshotHighWater: number;
  facts: KernelFactProjectionV2[];
  hasMore: boolean;
  nextAfterLedgerSequence: number;
  nextContinuation?: string;
}

export type EpochPreconditionV2 =
  | { kind: 'noCurrentEpoch'; data: Record<string, never> }
  | { kind: 'exact'; data: { controlEpoch: ControlEpochV2 } };

export interface ControlEpochAdvanceV2 {
  runId: RunIdV2;
  precondition: EpochPreconditionV2;
  inputId: string;
  opaqueInputRef: string;
}

export type ControlCancellationReplyV2 =
  | { kind: 'none'; data: Record<string, never> }
  | {
      kind: 'requested' | 'alreadyRequested';
      data: {
        cancelRequestId: string;
        invocationId: InvocationIdV2;
        cancellationFactId: FactIdV2;
      };
    };

export interface ControlEpochAdvancedReplyV2 {
  runId: RunIdV2;
  acceptedControlEpoch: ControlEpochV2;
  epochFactId: FactIdV2;
  supersededGrantCount: number;
  cancellation: ControlCancellationReplyV2;
  commandBatchHighWater: number;
}

export type InvocationCancelTargetV2 =
  | { kind: 'currentForRun'; data: Record<string, never> }
  | { kind: 'exact'; data: { invocationId: InvocationIdV2 } };

export interface InvocationCancelV2 {
  runId: RunIdV2;
  expectedControlEpoch: ControlEpochV2;
  target: InvocationCancelTargetV2;
  reasonCode: 'userRequested' | 'epochSuperseded' | 'runTerminated';
  reason?: string;
}

export type InvocationCancelReplyV2 =
  | {
      kind: 'requested' | 'alreadyRequested';
      data: {
        cancelRequestId: string;
        invocationId: InvocationIdV2;
        factId: FactIdV2;
        ledgerSequence: number;
      };
    }
  | {
      kind: 'noActiveInvocation';
      data: { runId: RunIdV2; controlEpoch: ControlEpochV2 };
    }
  | {
      kind: 'alreadyTerminal';
      data: {
        invocationId: InvocationIdV2;
        terminalFactId: FactIdV2;
        terminalPhase:
          | 'attemptPrepared'
          | 'executing'
          | 'failedBeforeEffect'
          | 'cancelledBeforeEffect'
          | 'timedOutBeforeEffect'
          | 'completed'
          | 'failedAfterObservedEffect'
          | 'indeterminate';
      };
    };

export type KernelCommandV2 =
  | { kind: 'runOpen'; data: RunOpenV2 }
  | { kind: 'toolContextGet'; data: ToolContextGetV2 }
  | { kind: 'capabilityScopePreview'; data: CapabilityScopePreviewV2 }
  | { kind: 'toolIntentSubmit'; data: ToolIntentSubmitV2 }
  | { kind: 'kernelFactsQueryScoped'; data: KernelFactsQueryScopedV2 }
  | { kind: 'controlEpochAdvance'; data: ControlEpochAdvanceV2 }
  | { kind: 'invocationCancel'; data: InvocationCancelV2 };

export interface KernelCommandEnvelopeV2 {
  abiVersion: typeof KERNEL_ABI_V2_VERSION;
  requestId: CommandRequestIdV2;
  command: KernelCommandV2;
}

export interface KernelTaggedErrorV2 {
  kind: string;
  data: JsonObjectV2;
}

export type KernelReplyV2 =
  | { kind: 'runOpened'; data: RunOpenReplyV2 }
  | { kind: 'toolContext'; data: ToolContextGetReplyV2 }
  | { kind: 'capabilityScopePreviewed'; data: CapabilityScopePreviewReplyV2 }
  | { kind: 'toolIntentSubmission'; data: ToolIntentSubmitReplyV2 }
  | { kind: 'kernelFactsProjected'; data: KernelFactProjectionPageV2 }
  | { kind: 'controlEpochAdvanced'; data: ControlEpochAdvancedReplyV2 }
  | { kind: 'invocationCancelResult'; data: InvocationCancelReplyV2 }
  | { kind: 'error'; data: KernelTaggedErrorV2 };

export type KernelCommandResponseEnvelopeV2 =
  | {
      kind: 'correlated';
      data: {
        serverAbiVersion: typeof KERNEL_ABI_V2_VERSION;
        requestId: CommandRequestIdV2;
        handling: 'evaluated' | 'replayed';
        reply: KernelReplyV2;
      };
    }
  | {
      kind: 'uncorrelatedWireFailure';
      data: {
        serverAbiVersion: typeof KERNEL_ABI_V2_VERSION;
        error: KernelTaggedErrorV2;
      };
    };

export class KernelV2WireError extends Error {
  readonly code = 'kernel_v2_wire_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'KernelV2WireError';
  }
}

export function decodeKernelCommandResponseEnvelopeV2(
  value: unknown
): KernelCommandResponseEnvelopeV2 {
  const envelope = tagged(value, 'Kernel v2 response envelope');
  if (envelope.kind === 'uncorrelatedWireFailure') {
    const data = exactRecord(
      envelope.data,
      ['serverAbiVersion', 'error'],
      'uncorrelated wire failure'
    );
    requireAbi(data.serverAbiVersion);
    return {
      kind: 'uncorrelatedWireFailure',
      data: {
        serverAbiVersion: KERNEL_ABI_V2_VERSION,
        error: decodeTaggedError(data.error),
      },
    };
  }
  if (envelope.kind !== 'correlated') {
    throw new KernelV2WireError(
      `Unsupported Kernel response envelope kind ${envelope.kind}.`
    );
  }
  const data = exactRecord(
    envelope.data,
    ['serverAbiVersion', 'requestId', 'handling', 'reply'],
    'correlated response'
  );
  requireAbi(data.serverAbiVersion);
  return {
    kind: 'correlated',
    data: {
      serverAbiVersion: KERNEL_ABI_V2_VERSION,
      requestId: identity(data.requestId, 'requestId'),
      handling: oneOf(
        data.handling,
        ['evaluated', 'replayed'] as const,
        'handling'
      ),
      reply: decodeKernelReplyV2(data.reply),
    },
  };
}

export function decodeToolInventoryV2(value: unknown): ToolInventoryV2 {
  const data = exactRecord(
    value,
    ['formatVersion', 'catalogVersion', 'catalogDigest', 'tools'],
    'ToolInventory'
  );
  if (data.formatVersion !== KERNEL_TOOL_INVENTORY_V2_FORMAT) {
    throw new KernelV2WireError('Unsupported ToolInventory formatVersion.');
  }
  if (data.catalogVersion !== KERNEL_TOOL_REGISTRY_VERSION_V2) {
    throw new KernelV2WireError('Unsupported Kernel tool registry version.');
  }
  const tools = decodeToolDescriptorList(data.tools, false);
  return {
    formatVersion: KERNEL_TOOL_INVENTORY_V2_FORMAT,
    catalogVersion: KERNEL_TOOL_REGISTRY_VERSION_V2,
    catalogDigest: digest(data.catalogDigest, 'catalogDigest'),
    tools,
  };
}

export function decodeToolContextBundleV2(value: unknown): ToolContextBundleV2 {
  const data = exactRecord(
    value,
    [
      'formatVersion',
      'contextVersion',
      'catalogDigest',
      'contextDigest',
      'fixedPrompt',
      'tools',
    ],
    'ToolContextBundle'
  );
  if (data.formatVersion !== KERNEL_TOOL_CONTEXT_V2_FORMAT) {
    throw new KernelV2WireError('Unsupported ToolContext formatVersion.');
  }
  return {
    formatVersion: KERNEL_TOOL_CONTEXT_V2_FORMAT,
    contextVersion: positiveInteger(data.contextVersion, 'contextVersion'),
    catalogDigest: digest(data.catalogDigest, 'catalogDigest'),
    contextDigest: digest(data.contextDigest, 'contextDigest'),
    fixedPrompt: text(data.fixedPrompt, 'fixedPrompt'),
    tools: decodeToolDescriptorList(data.tools, true),
  };
}

export function decodeRawToolArgumentsV2(value: unknown): RawToolArgumentsV2 {
  if (!isBoundedRawJson(value, 0) || Array.isArray(value) || value === null) {
    throw new KernelV2WireError(
      'rawArguments must be an object containing bounded finite JSON values.'
    );
  }
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > 1024 * 1024) {
    throw new KernelV2WireError('rawArguments exceeds the 1 MiB wire limit.');
  }
  return value as RawToolArgumentsV2;
}

export function isJsonObjectV2(value: unknown): value is JsonObjectV2 {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function decodeKernelReplyV2(value: unknown): KernelReplyV2 {
  const reply = tagged(value, 'Kernel v2 reply');
  switch (reply.kind) {
    case 'runOpened':
      return { kind: reply.kind, data: decodeRunOpenReplyV2(reply.data) };
    case 'toolContext':
      return { kind: reply.kind, data: decodeToolContextReply(reply.data) };
    case 'capabilityScopePreviewed':
      return {
        kind: reply.kind,
        data: decodeCapabilityScopePreviewReply(reply.data),
      };
    case 'toolIntentSubmission':
      return { kind: reply.kind, data: decodeToolIntentReply(reply.data) };
    case 'kernelFactsProjected':
      return { kind: reply.kind, data: decodeFactPage(reply.data) };
    case 'controlEpochAdvanced':
      return {
        kind: reply.kind,
        data: decodeControlEpochAdvanced(reply.data),
      };
    case 'invocationCancelResult':
      return {
        kind: reply.kind,
        data: decodeInvocationCancelReply(reply.data),
      };
    case 'error':
      return { kind: reply.kind, data: decodeTaggedError(reply.data) };
    default:
      throw new KernelV2WireError(
        `Unsupported Kernel reply kind ${reply.kind}.`
      );
  }
}

export function decodeRunOpenReplyV2(value: unknown): RunOpenReplyV2 {
  const data = exactRecord(
    value,
    [
      'runId',
      'controlEpoch',
      'workspaceBindingDigest',
      'toolContext',
    ],
    'RunOpen reply'
  );
  return {
    runId: identity(data.runId, 'runId'),
    controlEpoch: positiveInteger(data.controlEpoch, 'controlEpoch'),
    workspaceBindingDigest: digest(
      data.workspaceBindingDigest,
      'workspaceBindingDigest'
    ),
    toolContext: decodeToolContextBundleV2(data.toolContext),
  };
}

function decodeToolContextReply(value: unknown): ToolContextGetReplyV2 {
  const reply = tagged(value, 'ToolContext reply');
  if (reply.kind === 'current') {
    const data = exactRecord(reply.data, ['contextRef'], 'current ToolContext');
    return {
      kind: reply.kind,
      data: { contextRef: decodeContextRef(data.contextRef) },
    };
  }
  if (reply.kind === 'updated') {
    const data = exactRecord(reply.data, ['toolContext'], 'updated ToolContext');
    return {
      kind: reply.kind,
      data: { toolContext: decodeToolContextBundleV2(data.toolContext) },
    };
  }
  throw new KernelV2WireError(`Unsupported ToolContext reply ${reply.kind}.`);
}

function decodeCapabilityScopePreviewReply(
  value: unknown
): CapabilityScopePreviewReplyV2 {
  const reply = tagged(value, 'CapabilityScopePreview reply');
  if (reply.kind === 'previewed') {
    const data = exactRecord(reply.data, ['preview'], 'previewed scope');
    return {
      kind: reply.kind,
      data: { preview: decodeScopePreviewRecord(data.preview) },
    };
  }
  if (reply.kind === 'rejected') {
    const data = exactRecord(
      reply.data,
      ['toolId', 'reason', 'guidance'],
      'rejected scope preview'
    );
    return {
      kind: reply.kind,
      data: {
        toolId: toolId(data.toolId),
        reason: oneOf(
          data.reason,
          [
            'toolNotRegistered',
            'toolUnavailable',
            'invalidArguments',
            'requestedScopeInvalid',
            'settingsDenied',
            'staleToolContext',
            'staleControlEpoch',
          ] as const,
          'scope preview rejection reason'
        ),
        guidance: text(data.guidance, 'scope preview guidance'),
      },
    };
  }
  throw new KernelV2WireError(
    `Unsupported CapabilityScopePreview reply ${reply.kind}.`
  );
}

function decodeToolIntentReply(value: unknown): ToolIntentSubmitReplyV2 {
  const reply = tagged(value, 'ToolIntent reply');
  if (reply.kind === 'admitted') {
    const data = exactRecord(
      reply.data,
      [
        'runId',
        'operationId',
        'acceptedControlEpoch',
        'lease',
        'invocationId',
        'attemptId',
        'effectiveDeadlineMs',
        'admissionFactId',
        'admissionBatchHighWater',
      ],
      'admitted ToolIntent',
      ['lease']
    );
    return {
      kind: reply.kind,
      data: {
        runId: identity(data.runId, 'runId'),
        operationId: identity(data.operationId, 'operationId'),
        acceptedControlEpoch: positiveInteger(
          data.acceptedControlEpoch,
          'acceptedControlEpoch'
        ),
        ...(data.lease != null
          ? { lease: decodeLeaseRef(data.lease) }
          : {}),
        invocationId: identity(data.invocationId, 'invocationId'),
        attemptId: identity(data.attemptId, 'attemptId'),
        effectiveDeadlineMs: positiveInteger(
          data.effectiveDeadlineMs,
          'effectiveDeadlineMs'
        ),
        admissionFactId: identity(data.admissionFactId, 'admissionFactId'),
        admissionBatchHighWater: nonNegativeInteger(
          data.admissionBatchHighWater,
          'admissionBatchHighWater'
        ),
      },
    };
  }
  if (reply.kind === 'awaitingCapability') {
    const data = exactRecord(
      reply.data,
      [
        'runId',
        'operationId',
        'acceptedControlEpoch',
        'invocationId',
        'preview',
        'awaitingFactId',
        'awaitingBatchHighWater',
      ],
      'awaiting-capability ToolIntent'
    );
    return {
      kind: reply.kind,
      data: {
        runId: identity(data.runId, 'runId'),
        operationId: identity(data.operationId, 'operationId'),
        acceptedControlEpoch: positiveInteger(
          data.acceptedControlEpoch,
          'acceptedControlEpoch'
        ),
        invocationId: identity(data.invocationId, 'invocationId'),
        preview: decodeScopePreviewRecord(data.preview),
        awaitingFactId: identity(data.awaitingFactId, 'awaitingFactId'),
        awaitingBatchHighWater: nonNegativeInteger(
          data.awaitingBatchHighWater,
          'awaitingBatchHighWater'
        ),
      },
    };
  }
  if (reply.kind === 'rejected') {
    const data = exactRecord(
      reply.data,
      [
        'runId',
        'operationId',
        'currentControlEpoch',
        'reason',
        'guidance',
        'rejectionFactId',
        'rejectionBatchHighWater',
      ],
      'rejected ToolIntent'
    );
    return {
      kind: reply.kind,
      data: {
        runId: identity(data.runId, 'runId'),
        operationId: identity(data.operationId, 'operationId'),
        currentControlEpoch: positiveInteger(
          data.currentControlEpoch,
          'currentControlEpoch'
        ),
        reason: oneOf(
          data.reason,
          [
            'toolNotRegistered',
            'toolUnavailable',
            'invalidArguments',
            'staleToolContext',
            'staleControlEpoch',
            'planActionRequired',
            'capabilityLeaseStale',
            'capabilityScopeMismatch',
            'settingsDenied',
            'runBusy',
            'capacityExceeded',
            'indeterminateRecoveryRequired',
          ] as const,
          'ToolIntent rejection reason'
        ),
        guidance: text(data.guidance, 'ToolIntent rejection guidance'),
        rejectionFactId: identity(data.rejectionFactId, 'rejectionFactId'),
        rejectionBatchHighWater: nonNegativeInteger(
          data.rejectionBatchHighWater,
          'rejectionBatchHighWater'
        ),
      },
    };
  }
  throw new KernelV2WireError(`Unsupported ToolIntent reply ${reply.kind}.`);
}

function decodeScopePreviewRecord(value: unknown): CapabilityScopePreviewRecordV2 {
  const data = exactRecord(
    value,
    [
      'previewId',
      'runId',
      'controlEpoch',
      'planRevision',
      'planActionId',
      'operationId',
      'toolId',
      'canonicalArgumentsDigest',
      'canonicalScope',
      'scopeDigest',
      'authorizationDigest',
      'toolContractDigest',
      'contextRef',
      'effectClass',
      'effectScope',
      'risk',
      'effectiveDeadlineMs',
      'disposition',
      'approvalView',
    ],
    'CapabilityScopePreview record'
  );
  const preview: CapabilityScopePreviewRecordV2 = {
    previewId: identity(data.previewId, 'previewId'),
    runId: identity(data.runId, 'runId'),
    controlEpoch: positiveInteger(data.controlEpoch, 'controlEpoch'),
    planRevision: identity(data.planRevision, 'planRevision'),
    planActionId: identity(data.planActionId, 'planActionId'),
    operationId: identity(data.operationId, 'operationId'),
    toolId: toolId(data.toolId),
    canonicalArgumentsDigest: digest(
      data.canonicalArgumentsDigest,
      'canonicalArgumentsDigest'
    ),
    canonicalScope: jsonObject(data.canonicalScope, 'canonicalScope'),
    scopeDigest: digest(data.scopeDigest, 'scopeDigest'),
    authorizationDigest: digest(
      data.authorizationDigest,
      'authorizationDigest'
    ),
    toolContractDigest: digest(data.toolContractDigest, 'toolContractDigest'),
    contextRef: decodeContextRef(data.contextRef),
    effectClass: oneOf(
      data.effectClass,
      ['read', 'mutation'] as const,
      'effectClass'
    ),
    effectScope: decodeEffectScope(data.effectScope),
    risk: decodeRisk(data.risk),
    effectiveDeadlineMs: positiveInteger(
      data.effectiveDeadlineMs,
      'effectiveDeadlineMs'
    ),
    disposition: oneOf(
      data.disposition,
      ['autoIssuable', 'requiresUserDecision'] as const,
      'scope disposition'
    ),
    approvalView: decodeApprovalView(data.approvalView),
  };
  if (
    preview.approvalView.scopeDigest !== preview.scopeDigest
    || preview.approvalView.risk !== preview.risk
    || preview.approvalView.effectClass !== preview.effectClass
    || preview.approvalView.effectScope !== preview.effectScope
    || preview.approvalView.effectiveDeadlineMs !== preview.effectiveDeadlineMs
  ) {
    throw new KernelV2WireError(
      'Capability approvalView does not describe its exact preview.'
    );
  }
  return preview;
}

function decodeApprovalView(value: unknown): CapabilityApprovalViewV2 {
  const data = exactRecord(
    value,
    [
      'summary',
      'canonicalTargets',
      'scopeDelta',
      'risk',
      'effectClass',
      'effectScope',
      'effectiveDeadlineMs',
      'scopeDigest',
    ],
    'Capability approvalView'
  );
  return {
    summary: text(data.summary, 'approval summary'),
    canonicalTargets: stringArray(data.canonicalTargets, 'canonicalTargets'),
    scopeDelta: stringArray(data.scopeDelta, 'scopeDelta'),
    risk: decodeRisk(data.risk),
    effectClass: oneOf(
      data.effectClass,
      ['read', 'mutation'] as const,
      'approval effectClass'
    ),
    effectScope: decodeEffectScope(data.effectScope),
    effectiveDeadlineMs: positiveInteger(
      data.effectiveDeadlineMs,
      'approval effectiveDeadlineMs'
    ),
    scopeDigest: digest(data.scopeDigest, 'approval scopeDigest'),
  };
}

function decodeFactPage(value: unknown): KernelFactProjectionPageV2 {
  const data = exactRecord(
    value,
    [
      'requestedAfterLedgerSequence',
      'snapshotHighWater',
      'facts',
      'hasMore',
      'nextAfterLedgerSequence',
      'nextContinuation',
    ],
    'Kernel fact projection page',
    ['nextContinuation']
  );
  const requestedAfterLedgerSequence = nonNegativeInteger(
    data.requestedAfterLedgerSequence,
    'requestedAfterLedgerSequence'
  );
  const snapshotHighWater = nonNegativeInteger(
    data.snapshotHighWater,
    'snapshotHighWater'
  );
  if (requestedAfterLedgerSequence > snapshotHighWater) {
    throw new KernelV2WireError(
      'Kernel facts request cursor must not exceed snapshotHighWater.'
    );
  }
  const facts = array(data.facts, 'facts').map(decodeFact);
  let previous = requestedAfterLedgerSequence;
  for (const fact of facts) {
    if (
      fact.ledgerSequence <= previous
      || fact.ledgerSequence > snapshotHighWater
    ) {
      throw new KernelV2WireError(
        'Kernel facts must be strictly ordered within the page high-water.'
      );
    }
    previous = fact.ledgerSequence;
  }
  const nextAfterLedgerSequence = nonNegativeInteger(
    data.nextAfterLedgerSequence,
    'nextAfterLedgerSequence'
  );
  const hasMore = boolean(data.hasMore, 'hasMore');
  const nextContinuation = data.nextContinuation == null
    ? undefined
    : identity(data.nextContinuation, 'nextContinuation');
  if (hasMore !== Boolean(nextContinuation)) {
    throw new KernelV2WireError(
      'Kernel facts continuation must be present exactly when hasMore is true.'
    );
  }
  if (
    hasMore
    && (
      facts.length === 0
      || nextAfterLedgerSequence !== facts[facts.length - 1]!.ledgerSequence
      || nextAfterLedgerSequence >= snapshotHighWater
    )
  ) {
    throw new KernelV2WireError(
      'A continued Kernel facts page must advance to its final returned sequence.'
    );
  }
  if (!hasMore && nextAfterLedgerSequence !== snapshotHighWater) {
    throw new KernelV2WireError(
      'Caught-up Kernel facts cursor must equal snapshotHighWater.'
    );
  }
  return {
    requestedAfterLedgerSequence,
    snapshotHighWater,
    facts,
    hasMore,
    nextAfterLedgerSequence,
    ...(nextContinuation ? { nextContinuation } : {}),
  };
}

function decodeFact(value: unknown): KernelFactProjectionV2 {
  const data = exactRecord(
    value,
    [
      'abiVersion',
      'factId',
      'ledgerSequence',
      'runSequence',
      'recordedAt',
      'domain',
      'factKind',
      'lineage',
      'details',
    ],
    'Kernel fact projection'
  );
  requireAbi(data.abiVersion);
  const details = jsonObject(data.details, 'fact details');
  if (Object.prototype.hasOwnProperty.call(details, 'domain')) {
    throw new KernelV2WireError(
      'Kernel fact details must not repeat the top-level domain.'
    );
  }
  return {
    abiVersion: KERNEL_ABI_V2_VERSION,
    factId: identity(data.factId, 'factId'),
    ledgerSequence: positiveInteger(data.ledgerSequence, 'ledgerSequence'),
    runSequence: positiveInteger(data.runSequence, 'runSequence'),
    recordedAt: text(data.recordedAt, 'recordedAt'),
    domain: oneOf(
      data.domain,
      [
        'control',
        'authorization',
        'invocation',
        'effect',
        'resource',
        'cleanup',
      ] as const,
      'fact domain'
    ),
    factKind: text(data.factKind, 'factKind'),
    lineage: decodeFactLineage(data.lineage),
    details,
  };
}

function decodeFactLineage(value: unknown): KernelFactLineageV2 {
  const data = exactRecord(
    value,
    [
      'runId',
      'controlEpoch',
      'planActionIds',
      'operationId',
      'capabilityLeaseId',
      'invocationId',
      'attemptId',
      'effectId',
      'resourceIds',
    ],
    'Kernel fact lineage',
    [
      'controlEpoch',
      'operationId',
      'capabilityLeaseId',
      'invocationId',
      'attemptId',
      'effectId',
    ]
  );
  const planActionIds = stringArray(data.planActionIds, 'planActionIds');
  const resourceIds = stringArray(data.resourceIds, 'resourceIds');
  assertStrictlySorted(planActionIds, 'planActionIds');
  assertStrictlySorted(resourceIds, 'resourceIds');
  return {
    runId: identity(data.runId, 'lineage.runId'),
    ...(data.controlEpoch != null
      ? { controlEpoch: positiveInteger(data.controlEpoch, 'lineage.controlEpoch') }
      : {}),
    planActionIds,
    ...optionalIdentities(data, [
      'operationId',
      'capabilityLeaseId',
      'invocationId',
      'attemptId',
      'effectId',
    ]),
    resourceIds,
  };
}

function decodeControlEpochAdvanced(
  value: unknown
): ControlEpochAdvancedReplyV2 {
  const data = exactRecord(
    value,
    [
      'runId',
      'acceptedControlEpoch',
      'epochFactId',
      'supersededGrantCount',
      'cancellation',
      'commandBatchHighWater',
    ],
    'ControlEpochAdvanced reply'
  );
  return {
    runId: identity(data.runId, 'runId'),
    acceptedControlEpoch: positiveInteger(
      data.acceptedControlEpoch,
      'acceptedControlEpoch'
    ),
    epochFactId: identity(data.epochFactId, 'epochFactId'),
    supersededGrantCount: nonNegativeInteger(
      data.supersededGrantCount,
      'supersededGrantCount'
    ),
    cancellation: decodeControlCancellation(data.cancellation),
    commandBatchHighWater: nonNegativeInteger(
      data.commandBatchHighWater,
      'commandBatchHighWater'
    ),
  };
}

function decodeControlCancellation(value: unknown): ControlCancellationReplyV2 {
  const reply = tagged(value, 'control cancellation');
  if (reply.kind === 'none') {
    exactRecord(reply.data, [], 'empty control cancellation');
    return { kind: reply.kind, data: {} };
  }
  if (reply.kind === 'requested' || reply.kind === 'alreadyRequested') {
    const data = exactRecord(
      reply.data,
      ['cancelRequestId', 'invocationId', 'cancellationFactId'],
      'control cancellation request'
    );
    return {
      kind: reply.kind,
      data: {
        cancelRequestId: identity(data.cancelRequestId, 'cancelRequestId'),
        invocationId: identity(data.invocationId, 'invocationId'),
        cancellationFactId: identity(
          data.cancellationFactId,
          'cancellationFactId'
        ),
      },
    };
  }
  throw new KernelV2WireError(
    `Unsupported control cancellation kind ${reply.kind}.`
  );
}

function decodeInvocationCancelReply(value: unknown): InvocationCancelReplyV2 {
  const reply = tagged(value, 'InvocationCancel reply');
  if (reply.kind === 'requested' || reply.kind === 'alreadyRequested') {
    const data = exactRecord(
      reply.data,
      ['cancelRequestId', 'invocationId', 'factId', 'ledgerSequence'],
      'invocation cancellation request'
    );
    return {
      kind: reply.kind,
      data: {
        cancelRequestId: identity(data.cancelRequestId, 'cancelRequestId'),
        invocationId: identity(data.invocationId, 'invocationId'),
        factId: identity(data.factId, 'factId'),
        ledgerSequence: positiveInteger(
          data.ledgerSequence,
          'ledgerSequence'
        ),
      },
    };
  }
  if (reply.kind === 'noActiveInvocation') {
    const data = exactRecord(
      reply.data,
      ['runId', 'controlEpoch'],
      'no-active-invocation reply'
    );
    return {
      kind: reply.kind,
      data: {
        runId: identity(data.runId, 'runId'),
        controlEpoch: positiveInteger(data.controlEpoch, 'controlEpoch'),
      },
    };
  }
  if (reply.kind === 'alreadyTerminal') {
    const data = exactRecord(
      reply.data,
      ['invocationId', 'terminalFactId', 'terminalPhase'],
      'already-terminal invocation reply'
    );
    return {
      kind: reply.kind,
      data: {
        invocationId: identity(data.invocationId, 'invocationId'),
        terminalFactId: identity(data.terminalFactId, 'terminalFactId'),
        terminalPhase: oneOf(
          data.terminalPhase,
          [
            'attemptPrepared',
            'executing',
            'failedBeforeEffect',
            'cancelledBeforeEffect',
            'timedOutBeforeEffect',
            'completed',
            'failedAfterObservedEffect',
            'indeterminate',
          ] as const,
          'terminalPhase'
        ),
      },
    };
  }
  throw new KernelV2WireError(
    `Unsupported InvocationCancel reply ${reply.kind}.`
  );
}

function decodeToolDescriptorList(
  value: unknown,
  readyOnly: boolean
): ToolDescriptorV2[] {
  const tools = array(value, 'tools').map(decodeToolDescriptor);
  let previous = '';
  for (const tool of tools) {
    if (tool.toolId <= previous) {
      throw new KernelV2WireError(
        'Kernel tool descriptors must be strictly sorted by unique toolId.'
      );
    }
    if (readyOnly && tool.availability !== 'ready') {
      throw new KernelV2WireError(
        'Provider ToolContext may contain only ready tools.'
      );
    }
    previous = tool.toolId;
  }
  return tools;
}

function decodeToolDescriptor(value: unknown): ToolDescriptorV2 {
  const data = exactRecord(
    value,
    [
      'toolId',
      'description',
      'inputSchema',
      'promptTemplate',
      'availability',
      'effectClass',
      'effectScope',
      'risk',
      'contractDigest',
    ],
    'ToolDescriptor'
  );
  return {
    toolId: toolId(data.toolId),
    description: text(data.description, 'tool description'),
    inputSchema: jsonObject(data.inputSchema, 'tool inputSchema'),
    promptTemplate: text(data.promptTemplate, 'tool promptTemplate'),
    availability: oneOf(
      data.availability,
      ['ready', 'disabled', 'revoked', 'unavailable'] as const,
      'tool availability'
    ),
    effectClass: oneOf(
      data.effectClass,
      ['read', 'mutation'] as const,
      'tool effectClass'
    ),
    effectScope: decodeEffectScope(data.effectScope),
    risk: decodeRisk(data.risk),
    contractDigest: digest(data.contractDigest, 'tool contractDigest'),
  };
}

function decodeContextRef(value: unknown): ToolContextRefV2 {
  const data = exactRecord(
    value,
    ['contextVersion', 'catalogDigest', 'contextDigest'],
    'ToolContext reference'
  );
  return {
    contextVersion: positiveInteger(data.contextVersion, 'contextVersion'),
    catalogDigest: digest(data.catalogDigest, 'catalogDigest'),
    contextDigest: digest(data.contextDigest, 'contextDigest'),
  };
}

function decodeLeaseRef(value: unknown): CapabilityLeaseRefV2 {
  const data = exactRecord(
    value,
    ['leaseId', 'version', 'scopeDigest'],
    'capability lease'
  );
  return {
    leaseId: identity(data.leaseId, 'leaseId'),
    version: positiveInteger(data.version, 'lease version'),
    scopeDigest: digest(data.scopeDigest, 'lease scopeDigest'),
  };
}

function decodeTaggedError(value: unknown): KernelTaggedErrorV2 {
  const error = tagged(value, 'Kernel error');
  return {
    kind: error.kind,
    data: jsonObject(error.data, 'Kernel error data'),
  };
}

function decodeRisk(value: unknown): ToolRiskV2 {
  return oneOf(
    value,
    ['low', 'medium', 'high', 'critical'] as const,
    'tool risk'
  );
}

function decodeEffectScope(value: unknown): ToolEffectScopeV2 {
  return oneOf(
    value,
    [
      'workspaceRead',
      'workspaceWrite',
      'repositoryRead',
      'repositoryIndexWrite',
      'repositoryHistoryWrite',
      'networkRead',
    ] as const,
    'tool effectScope'
  );
}

function optionalIdentities(
  data: Record<string, unknown>,
  keys: readonly string[]
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of keys) {
    if (data[key] != null) {
      output[key] = identity(data[key], `lineage.${key}`);
    }
  }
  return output;
}

function requireAbi(value: unknown): void {
  if (value !== KERNEL_ABI_V2_VERSION) {
    throw new KernelV2WireError(
      `Unsupported Kernel ABI version ${String(value)}.`
    );
  }
}

function tagged(
  value: unknown,
  field: string
): { kind: string; data: unknown } {
  const record = exactRecord(value, ['kind', 'data'], field);
  return { kind: identity(record.kind, `${field}.kind`), data: record.data };
}

function toolId(value: unknown): string {
  const output = identity(value, 'toolId');
  if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(output)) {
    throw new KernelV2WireError('toolId must be a lowercase namespaced identity.');
  }
  return output;
}

function digest(value: unknown, field: string): string {
  const output = text(value, field);
  if (!/^sha256:[0-9a-f]{64}$/.test(output)) {
    throw new KernelV2WireError(
      `${field} must be a lowercase sha256 digest.`
    );
  }
  return output;
}

function identity(value: unknown, field: string): string {
  const output = text(value, field);
  if (
    new TextEncoder().encode(output).byteLength > 512
    || output.trim() !== output
    || /[\u0000-\u001f\u007f-\u009f]/u.test(output)
  ) {
    throw new KernelV2WireError(`${field} is not a valid compact identity.`);
  }
  return output;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KernelV2WireError(`${field} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const output = nonNegativeInteger(value, field);
  if (output === 0) {
    throw new KernelV2WireError(`${field} must be greater than zero.`);
  }
  return output;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new KernelV2WireError(`${field} must be a boolean.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new KernelV2WireError(
      `${field} must be a non-negative safe integer.`
    );
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  return array(value, field).map((item) => text(item, `${field} item`));
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new KernelV2WireError(`${field} must be an array.`);
  }
  return value;
}

function jsonObject(value: unknown, field: string): JsonObjectV2 {
  if (!isJsonObjectV2(value)) {
    throw new KernelV2WireError(`${field} must be a finite JSON object.`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelV2WireError(`${field} must be an object.`);
  }
  const output = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const optionalKeys = new Set(optional);
  const unexpected = Object.keys(output).filter((key) => !allowed.has(key));
  const missing = keys.filter(
    (key) => !optionalKeys.has(key)
      && !Object.prototype.hasOwnProperty.call(output, key)
  );
  if (unexpected.length > 0 || missing.length > 0) {
    throw new KernelV2WireError(`${field} has an invalid field set.`);
  }
  return output;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new KernelV2WireError(
      `${field} must be one of ${allowed.join(', ')}.`
    );
  }
  return value as T[number];
}

function assertStrictlySorted(values: readonly string[], field: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      throw new KernelV2WireError(
        `${field} must be strictly sorted and unique.`
      );
    }
  }
}

function isJsonValue(value: unknown): value is JsonValueV2 {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObjectV2(value);
}

function isBoundedRawJson(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isBoundedRawJson(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).every(
    ([key, item]) => key.length <= 1024
      && !/[\u0000-\u001f\u007f]/.test(key)
      && isBoundedRawJson(item, depth + 1)
  );
}
