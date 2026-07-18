import type {
  KernelArtifactDraftLedgerFrame,
  KernelAuditQueryFilter,
  KernelAuditQueryResult,
  KernelErrorEnvelope,
  KernelHostInspectionQuery,
  KernelHostInspectionResult,
  KernelHostSkillCatalogResult,
  KernelPermissionRequestEnvelope,
  KernelPlanAuthorizationDecision,
  KernelPlanAuthorizationReview,
  KernelProposalReviewReport,
  KernelResourceCleanupStateFact,
  KernelResourcePacket,
  KernelReviewGateEvaluation,
  KernelReviewFacts,
  KernelRuntimeLifecycleState,
  KernelToolEffectReceipt,
  KernelToolExecutionAttemptFact,
  KernelToolOutcomeIndeterminateFact,
  KernelWorkUnitDescriptor,
} from './kernel.js';
import type { KernelToolOperationKind } from './tools.js';

export interface KernelUserInputV1 {
  text: string;
  attachments: unknown[];
}

export interface KernelWorkspaceBindingV1 {
  workspaceId?: string;
  workspaceHash?: string;
  openPath?: string;
  activeFolderId?: string;
  folderHash?: string;
}

export interface KernelProposalEnvelopeV1 {
  schemaVersion: string;
  proposalId: string;
  runId: string;
  sessionId?: string;
  source: 'llm' | 'user' | 'system' | 'cache';
  kind: 'answer' | 'resourceRequest' | 'decisionRequest' | 'actionBundle' | 'diagnostic';
  payload: unknown;
  referencedResourcePacketRefs: string[];
  referencedEvidenceRefs: string[];
  parserDiagnostics?: unknown;
}

export interface KernelActionV1 {
  actionId: string;
  toolId: string;
  args: Record<string, unknown>;
  description: string;
  dependsOn: string[];
}

export interface KernelContentBlockV1 {
  blockId: string;
  targetPath: string;
  language?: string;
  operation: 'create' | 'createEmpty' | 'overwrite' | 'patch' | 'replaceBlock' | 'insertBefore' | 'insertAfter';
  contentLines: string[];
  allowEmptyContent: boolean;
}

export interface KernelActionBundleV1 {
  version: string;
  id: string;
  goal: string;
  requirementId?: string;
  actions: KernelActionV1[];
  continuationExpectations: Array<{ id: string; description: string; target: string[]; reason?: string; dependsOn: string[] }>;
  validationExpectations: Array<{ id: string; description: string }>;
  reviewExpectations: Array<{ id: string; description: string }>;
}

export interface KernelActionBatchV1 {
  planId: string;
  contractId: string;
  contractHash: string;
  actionBundle: KernelActionBundleV1;
  contentBlocks: KernelContentBlockV1[];
}

interface KernelCommandBaseV1 {
  requestId: string;
}

export type KernelCommandV1 =
  | (KernelCommandBaseV1 & { kind: 'healthCheck' })
  | (KernelCommandBaseV1 & { kind: 'snapshotGet'; sessionId?: string })
  | (KernelCommandBaseV1 & {
      kind: 'runCreate';
      sessionId?: string;
      input: KernelUserInputV1;
      workspaceBinding?: KernelWorkspaceBindingV1;
      profileRef?: { id: string; kind?: string; hash?: string };
      runOverrides?: unknown;
    })
  | (KernelCommandBaseV1 & { kind: 'stateContractGet'; runId?: string; sessionId?: string })
  | (KernelCommandBaseV1 & { kind: 'proposalSubmit'; runId: string; sessionId?: string; proposal: KernelProposalEnvelopeV1 })
  | (KernelCommandBaseV1 & { kind: 'planAuthorizationSubmit'; runId: string; sessionId?: string; intent: import('./kernel.js').KernelTaskIntentEnvelope })
  | (KernelCommandBaseV1 & { kind: 'planAuthorizationDecisionSubmit'; runId: string; sessionId?: string; decision: KernelPlanAuthorizationDecision })
  | (KernelCommandBaseV1 & { kind: 'resourceResolve'; runId: string; sessionId?: string; request: { manifest: unknown } })
  | (KernelCommandBaseV1 & { kind: 'draftLedgerSubmit'; runId: string; sessionId?: string; frame: KernelArtifactDraftLedgerFrame })
  | (KernelCommandBaseV1 & { kind: 'actionBatchSubmit'; runId: string; sessionId?: string; batch: KernelActionBatchV1 })
  | (KernelCommandBaseV1 & { kind: 'reviewFactsGet'; runId: string; sessionId?: string })
  | (KernelCommandBaseV1 & { kind: 'reviewGateEvaluate'; runId: string; sessionId?: string; decision: { decision: 'accept' | 'revise' | 'reject'; guidance?: string } })
  | (KernelCommandBaseV1 & { kind: 'runCancel'; runId: string })
  | (KernelCommandBaseV1 & { kind: 'runResume'; sessionId: string })
  | (KernelCommandBaseV1 & { kind: 'runCleanupRetry'; runId: string })
  | (KernelCommandBaseV1 & { kind: 'hostWorkspaceBindingResolve'; path: string })
  | (KernelCommandBaseV1 & { kind: 'hostWorkspaceOpen'; path: string })
  | (KernelCommandBaseV1 & { kind: 'hostWorkspaceCurrent' })
  | (KernelCommandBaseV1 & { kind: 'hostWorkspaceSave'; fileName?: string })
  | (KernelCommandBaseV1 & { kind: 'hostResourceQuery'; query: KernelHostInspectionQuery })
  | (KernelCommandBaseV1 & { kind: 'hostSkillDiscover' })
  | (KernelCommandBaseV1 & { kind: 'permissionResolve'; permissionId: string; decision: 'accept' | 'reject' })
  | (KernelCommandBaseV1 & { kind: 'hostSkillTrustDecisionSubmit'; skillId: string; decision: Record<string, unknown> })
  | (KernelCommandBaseV1 & { kind: 'hostMcpRiskDecisionSubmit'; connectorId: string; bindingId?: string; decision: Record<string, unknown> })
  | (KernelCommandBaseV1 & { kind: 'auditVerify'; scope: unknown })
  | (KernelCommandBaseV1 & { kind: 'auditQuery'; filter: KernelAuditQueryFilter });

export interface KernelToolCompletionFact {
  toolCallId: string;
  toolId: string;
  operationKind: KernelToolOperationKind;
  ok: boolean;
  output: unknown | null;
  error: KernelErrorEnvelope | null;
}

export interface KernelToolRequestFact {
  toolCallId: string;
  toolId: string;
  operationKind: KernelToolOperationKind;
  argsPreview: unknown;
}

interface KernelEventBaseV1 {
  requestId?: string;
  runId?: string;
  sessionId?: string;
  sequence?: number;
}

export type KernelEventV1 =
  | (KernelEventBaseV1 & { kind: 'host.status'; status: 'starting' | 'ready' | 'degraded' | 'error'; detail?: string; messageKey?: string; args?: unknown })
  | (KernelEventBaseV1 & { kind: 'snapshot.ready'; requestId: string; snapshot: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'host.inspection_completed'; requestId: string; result: KernelHostInspectionResult })
  | (KernelEventBaseV1 & { kind: 'host.workspace_completed'; requestId: string; result: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'state.entered'; runId: string; stateContract: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'driver.request_produced'; runId: string; driverRequest: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'proposal.accepted'; runId: string; proposal: KernelProposalEnvelopeV1 })
  | (KernelEventBaseV1 & { kind: 'proposal.reviewed'; runId: string; proposalId: string; report: KernelProposalReviewReport })
  | (KernelEventBaseV1 & { kind: 'plan_authorization.reviewed'; runId: string; planId: string; review: KernelPlanAuthorizationReview })
  | (KernelEventBaseV1 & { kind: 'plan_authorization.decision_recorded'; runId: string; authorizationContractId: string; decision: 'accept' | 'reject'; leaseId?: string })
  | (KernelEventBaseV1 & { kind: 'proposal.rejected'; runId: string; proposalId?: string; reason: string; diagnostics?: unknown })
  | (KernelEventBaseV1 & { kind: 'resource.packet_produced'; packet: KernelResourcePacket })
  | (KernelEventBaseV1 & { kind: 'draft.open' | 'draft.chunk' | 'draft.file_completed' | 'draft.batch_completed' | 'draft.discarded' | 'draft.committed'; runId: string; draft: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'action_batch.accepted'; runId: string; batch: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'work_unit.queued'; runId: string; workUnit: KernelWorkUnitDescriptor })
  | (KernelEventBaseV1 & { kind: 'work_unit.started'; runId: string; workUnitId: string })
  | (KernelEventBaseV1 & { kind: 'work_unit.completed'; runId: string; workUnitId: string; output?: unknown })
  | (KernelEventBaseV1 & { kind: 'work_unit.failed'; runId: string; workUnitId: string; error: KernelErrorEnvelope })
  | (KernelEventBaseV1 & { kind: 'work_unit.blocked'; runId: string; workUnitId: string; reason: string })
  | (KernelEventBaseV1 & { kind: 'batch.review_ready'; runId: string; contractId: string })
  | (KernelEventBaseV1 & { kind: 'review.facts_produced'; runId: string; facts: KernelReviewFacts })
  | (KernelEventBaseV1 & { kind: 'review_gate.evaluated'; runId: string; result: KernelReviewGateEvaluation })
  | (KernelEventBaseV1 & { kind: 'run.completed'; runId: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; summary?: string })
  | (KernelEventBaseV1 & { kind: 'runtime.lifecycle_changed'; runId: string; previousState?: KernelRuntimeLifecycleState; currentState: KernelRuntimeLifecycleState; reason?: string })
  | (KernelEventBaseV1 & { kind: 'resource.cleanup_state_changed'; runId: string; fact: KernelResourceCleanupStateFact })
  | (KernelEventBaseV1 & { kind: 'message.appended'; turnId?: string; role: 'user' | 'agent' | 'system' | 'tool'; channel?: string; content?: string; messageKey?: string; args?: unknown })
  | (KernelEventBaseV1 & { kind: 'llm.provider_error'; runId: string; phase: string; llmCallId: string; diagnostic: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'tool.requested'; turnId?: string; fact: KernelToolRequestFact })
  | (KernelEventBaseV1 & { kind: 'tool.execution_attempted'; runId: string; fact: KernelToolExecutionAttemptFact })
  | (KernelEventBaseV1 & { kind: 'tool.effect_observed'; runId: string; fact: KernelToolEffectReceipt })
  | (KernelEventBaseV1 & { kind: 'tool.outcome_indeterminate'; runId: string; fact: KernelToolOutcomeIndeterminateFact })
  | (KernelEventBaseV1 & { kind: 'tool.completed'; turnId?: string; fact: KernelToolCompletionFact })
  | (KernelEventBaseV1 & { kind: 'permission.requested'; sessionId: string; request: KernelPermissionRequestEnvelope })
  | (KernelEventBaseV1 & { kind: 'permission.resolved'; permissionId: string; decision: 'accept' | 'reject'; reason?: string })
  | (KernelEventBaseV1 & { kind: 'autonomy.transitioned'; fromLevel?: string; toLevel: string; capabilitySet: string[]; reason?: string })
  | (KernelEventBaseV1 & { kind: 'config.snapshot.attached'; snapshotRef: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'runtime.resumed'; runId: string; checkpointId: string; lifecycleState: KernelRuntimeLifecycleState })
  | (KernelEventBaseV1 & { kind: 'host.skills_discovered'; requestId: string; result: KernelHostSkillCatalogResult })
  | (KernelEventBaseV1 & { kind: 'host.skill_trust_decision_recorded'; requestId: string; record: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'host.mcp_risk_decision_recorded'; requestId: string; record: Record<string, unknown> })
  | (KernelEventBaseV1 & { kind: 'audit.verify_started'; scope: unknown })
  | (KernelEventBaseV1 & { kind: 'audit.verify_completed'; ok: boolean; report: unknown })
  | (KernelEventBaseV1 & { kind: 'audit.query_completed'; result: KernelAuditQueryResult })
  | (KernelEventBaseV1 & { kind: 'audit.degraded_entered'; reason: string })
  | (KernelEventBaseV1 & { kind: 'audit.degraded_exited'; reason?: string })
  | (KernelEventBaseV1 & { kind: 'audit.segment_rotated'; segmentId: string; seal: unknown })
  | (KernelEventBaseV1 & { kind: 'error'; error: KernelErrorEnvelope; messageKey?: string; args?: unknown });

export class KernelAbiEventDecodeError extends Error {
  readonly code = 'kernel_abi_event_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'KernelAbiEventDecodeError';
  }
}

const KERNEL_EVENT_KINDS = new Set<KernelEventV1['kind']>([
  'host.status', 'snapshot.ready', 'host.inspection_completed', 'host.workspace_completed',
  'state.entered', 'driver.request_produced', 'proposal.accepted', 'proposal.reviewed',
  'plan_authorization.reviewed', 'plan_authorization.decision_recorded', 'proposal.rejected',
  'resource.packet_produced', 'draft.open', 'draft.chunk', 'draft.file_completed',
  'draft.batch_completed', 'draft.discarded', 'draft.committed', 'action_batch.accepted',
  'work_unit.queued', 'work_unit.started', 'work_unit.completed', 'work_unit.failed',
  'work_unit.blocked', 'batch.review_ready', 'review.facts_produced', 'review_gate.evaluated',
  'run.completed', 'runtime.lifecycle_changed', 'resource.cleanup_state_changed', 'message.appended',
  'llm.provider_error', 'tool.requested', 'tool.execution_attempted', 'tool.effect_observed',
  'tool.outcome_indeterminate', 'tool.completed', 'permission.requested', 'permission.resolved',
  'autonomy.transitioned', 'config.snapshot.attached', 'runtime.resumed', 'host.skills_discovered',
  'host.skill_trust_decision_recorded', 'host.mcp_risk_decision_recorded', 'audit.verify_started',
  'audit.verify_completed', 'audit.query_completed', 'audit.degraded_entered',
  'audit.degraded_exited', 'audit.segment_rotated', 'error',
]);

export function decodeKernelEventV1(value: unknown): KernelEventV1 {
  const root = objectRecord(value);
  const envelopePayload = objectRecord(root?.payload);
  const candidate = isKernelEventKindV1(root?.kind)
    ? root
    : objectRecord(envelopePayload?.kernelEvent);
  if (!candidate || !isKernelEventKindV1(candidate.kind)) {
    throw new KernelAbiEventDecodeError('Value is neither a direct Kernel ABI v1 event nor a payload.kernelEvent envelope.');
  }
  validateCriticalEventShape(candidate);
  return candidate as unknown as KernelEventV1;
}

function validateCriticalEventShape(event: Record<string, unknown>): void {
  if (event.kind === 'tool.completed') {
    rejectFlatToolFactFields(event);
    const fact = objectRecord(event.fact);
    if (!fact || !nonEmptyString(fact.toolCallId) || !nonEmptyString(fact.toolId) || !nonEmptyString(fact.operationKind) || typeof fact.ok !== 'boolean' || !('output' in fact) || !('error' in fact)) {
      throw new KernelAbiEventDecodeError('tool.completed must contain a typed KernelToolCompletionFact.');
    }
  } else if (event.kind === 'tool.requested') {
    rejectFlatToolFactFields(event);
    const fact = objectRecord(event.fact);
    if (!fact || !nonEmptyString(fact.toolCallId) || !nonEmptyString(fact.toolId) || !nonEmptyString(fact.operationKind)) {
      throw new KernelAbiEventDecodeError('tool.requested must contain a typed KernelToolRequestFact.');
    }
  } else if (event.kind === 'tool.execution_attempted') {
    const fact = objectRecord(event.fact);
    if (!fact || !nonEmptyString(fact.attemptId) || !nonEmptyString(fact.toolCallId) || !nonEmptyString(fact.toolId) || !nonEmptyString(fact.operationKind) || !nonEmptyString(fact.argsHash) || !nonEmptyString(fact.contractId) || !nonEmptyString(fact.workUnitId)) {
      throw new KernelAbiEventDecodeError('tool.execution_attempted must contain a typed KernelToolExecutionAttemptFact.');
    }
  } else if (event.kind === 'tool.effect_observed') {
    validateToolEffectReceipt(event.fact, 'tool.effect_observed');
  } else if (event.kind === 'tool.outcome_indeterminate') {
    const fact = objectRecord(event.fact);
    if (!fact || !objectRecord(fact.attempt) || !nonEmptyString(fact.reason)) {
      throw new KernelAbiEventDecodeError('tool.outcome_indeterminate must contain a typed KernelToolOutcomeIndeterminateFact.');
    }
    validateToolEffectReceipt(fact.receipt, 'tool.outcome_indeterminate');
  } else if (event.kind === 'resource.cleanup_state_changed') {
    const fact = objectRecord(event.fact);
    if (!fact || !nonEmptyString(fact.runId) || !['batch', 'plan', 'run'].includes(String(fact.scope)) || !['idle', 'pending', 'failed', 'completed'].includes(String(fact.state)) || typeof fact.attempt !== 'number') {
      throw new KernelAbiEventDecodeError('resource.cleanup_state_changed must contain a typed KernelResourceCleanupStateFact.');
    }
  } else if (event.kind === 'permission.requested') {
    const request = objectRecord(event.request);
    if (!request || !nonEmptyString(request.id) || !['runtimePermission', 'scopeExpansion'].includes(String(request.requestKind)) || !nonEmptyString(request.capability) || !nonEmptyString(request.riskLevel)) {
      throw new KernelAbiEventDecodeError('permission.requested must contain a typed permission request envelope.');
    }
  } else if (event.kind === 'resource.packet_produced') {
    const packet = objectRecord(event.packet);
    if (!packet || !nonEmptyString(packet.id) || !Array.isArray(packet.items)) {
      throw new KernelAbiEventDecodeError('resource.packet_produced must contain a typed ResourcePacket.');
    }
  } else if (typeof event.kind === 'string' && event.kind.startsWith('work_unit.')) {
    const descriptor = objectRecord(event.workUnit);
    if (!nonEmptyString(event.workUnitId) && !nonEmptyString(descriptor?.id)) {
      throw new KernelAbiEventDecodeError(`${event.kind} must identify its WorkUnit.`);
    }
  }
}

function validateToolEffectReceipt(value: unknown, eventKind: string): void {
  const fact = objectRecord(value);
  if (!fact || !nonEmptyString(fact.attemptId) || !['none', 'observed', 'indeterminate'].includes(String(fact.outcome)) || !Array.isArray(fact.affectedResources) || !Array.isArray(fact.cleanupRefs)) {
    throw new KernelAbiEventDecodeError(`${eventKind} must contain a typed KernelToolEffectReceipt.`);
  }
}

function rejectFlatToolFactFields(event: Record<string, unknown>): void {
  const legacyFields = ['toolCallId', 'toolName', 'toolId', 'operationKind', 'ok', 'output', 'error']
    .filter((field) => field in event);
  if (legacyFields.length > 0) {
    throw new KernelAbiEventDecodeError(`Tool events must nest facts under fact; flat fields are invalid: ${legacyFields.join(', ')}.`);
  }
}

export function isKernelEventKindV1(value: unknown): value is KernelEventV1['kind'] {
  return typeof value === 'string' && KERNEL_EVENT_KINDS.has(value as KernelEventV1['kind']);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
