import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import type {
  SessionProviderControlReceiptV2,
  SessionProviderControlSettlementV2,
  SessionProviderOutcomeRecordV2,
} from './types.js';

export const SESSION_PROVIDER_CONTROL_SETTLEMENT_V2_SCHEMA =
  'deepcode.session.provider-control-settlement.v2' as const;

type SettlementDraftV2 =
  SessionProviderControlSettlementV2 extends infer Settlement
    ? Settlement extends SessionProviderControlSettlementV2
      ? Omit<Settlement, 'schemaVersion' | 'settlementDigest'>
      : never
    : never;

export function sealSessionProviderControlSettlementV2(
  draft: SettlementDraftV2
): SessionProviderControlSettlementV2 {
  const settlement = {
    ...cloneJson(draft),
    schemaVersion: SESSION_PROVIDER_CONTROL_SETTLEMENT_V2_SCHEMA,
    settlementDigest: sha256Hash(canonicalJson({
      ...cloneJson(draft),
      schemaVersion: SESSION_PROVIDER_CONTROL_SETTLEMENT_V2_SCHEMA,
    })),
  } as SessionProviderControlSettlementV2;
  validateSessionProviderControlSettlementV2(settlement);
  return settlement;
}

export function validateSessionProviderControlSettlementV2(
  value: SessionProviderControlSettlementV2,
  expected?: {
    runId: string;
    inputId: string;
    controlEpoch: number;
  }
): void {
  if (
    value.schemaVersion !== SESSION_PROVIDER_CONTROL_SETTLEMENT_V2_SCHEMA
    || !value.runId.trim()
    || !value.inputId.trim()
    || !Number.isSafeInteger(value.controlEpoch)
    || value.controlEpoch < 1
    || !value.predecessorProviderTurnId.trim()
    || !Number.isFinite(Date.parse(value.recordedAt))
    || !/^sha256:[0-9a-f]{64}$/u.test(value.settlementDigest)
    || (expected !== undefined && (
      value.runId !== expected.runId
      || value.inputId !== expected.inputId
      || value.controlEpoch !== expected.controlEpoch
    ))
  ) {
    throw invalidSettlement();
  }
  const { settlementDigest: _settlementDigest, ...unsigned } = value;
  if (sha256Hash(canonicalJson(unsigned)) !== value.settlementDigest) {
    throw invalidSettlement();
  }
  validateControlReceiptV2(value.control);
  switch (value.kind) {
    case 'planEvidenceRefresh':
      if (
        value.nextTargetKind !== 'planning'
        || value.control.schemaVersion
          !== 'deepcode.session.plan-proposal.v5'
        || ![
          'session_kernel_provider_plan_evidence_stale',
          'session_kernel_provider_plan_resource_evidence_mismatch',
          'session_kernel_provider_plan_blocking_unknowns',
          'session_kernel_provider_plan_evidence_debt_unresolved',
        ].includes(value.refresh.errorCode)
        || !Number.isSafeInteger(value.refresh.snapshotHighWater)
        || value.refresh.snapshotHighWater < 0
        || typeof value.refresh.requiresCurrentRead !== 'boolean'
        || !digest(value.refresh.candidateScopeDigest)
        || !digest(value.refresh.factSetDigest)
        || !digest(value.refresh.evidenceDebtDigest)
        || !boundedIdentityList(value.refresh.staleFactRefs)
        || !boundedIdentityList(value.refresh.resourceRefs)
        || !boundedDigestList(value.refresh.readSubjectDigests)
        || !boundedIdentityList(value.refresh.blockingUnknownIds)
      ) throw invalidSettlement();
      return;
    case 'planPreviewRejected': {
      const rejectionKeys = value.preview.rejections.map((rejection) =>
        [
          rejection.planActionId,
          rejection.operationId,
          rejection.toolId,
        ].join('\u0000')
      );
      if (
        value.nextTargetKind !== 'planning'
        || value.control.schemaVersion
          !== 'deepcode.session.plan-proposal.v5'
        || !boundedIdentity(value.preview.planRevision)
        || value.preview.rejections.length < 1
        || value.preview.rejections.length > 128
        || new Set(rejectionKeys).size !== rejectionKeys.length
        || rejectionKeys.some((key, index) =>
          index > 0 && rejectionKeys[index - 1]! >= key
        )
        || value.preview.rejections.some((rejection) =>
          !boundedIdentity(rejection.planActionId)
          || !boundedIdentity(rejection.operationId)
          || !boundedIdentity(rejection.toolId)
          || ![
            'toolNotRegistered',
            'toolUnavailable',
            'invalidArguments',
            'requestedScopeInvalid',
            'settingsDenied',
            'staleToolContext',
            'staleControlEpoch',
          ].includes(rejection.reason)
          || !boundedGuidance(rejection.guidance)
        )
      ) throw invalidSettlement();
      return;
    }
    case 'planDecision': {
      const expectedTarget = value.decision.decision === 'accept'
        ? 'planAction'
        : value.decision.decision === 'revise'
          ? 'planning'
          : 'finalAnswer';
      if (
        value.nextTargetKind !== expectedTarget
        || value.control.schemaVersion
          !== 'deepcode.session.plan-proposal.v5'
        || !value.decision.planRevision.trim()
        || !Number.isFinite(Date.parse(value.decision.recordedAt))
        || value.decision.recordedAt !== value.recordedAt
        || (value.decision.decision === 'revise'
          && !value.decision.guidance?.trim())
        || (value.decision.decision !== 'revise'
          && value.decision.guidance !== undefined
          && !value.decision.guidance.trim())
      ) throw invalidSettlement();
      return;
    }
    case 'planActionComplete':
      if (
        !['planAction', 'finalAnswer'].includes(value.nextTargetKind)
        || value.control.schemaVersion
          !== 'deepcode.session.plan-action-complete.v2'
        || value.settlement.kind !== 'planActionComplete'
        || value.settlement.providerTurnId
          !== value.predecessorProviderTurnId
        || value.settlement.controlEpoch !== value.controlEpoch
        || value.settlement.controlCallId !== value.control.callId
        || value.settlement.controlArgumentsDigest
          !== value.control.argumentsDigest
        || value.settlement.recordedAt !== value.recordedAt
        || !value.settlement.planRevision.trim()
        || !value.settlement.planActionId.trim()
        || !Number.isSafeInteger(value.settlement.snapshotHighWater)
        || value.settlement.snapshotHighWater < 0
      ) throw invalidSettlement();
      return;
    case 'userInterventionDecision': {
      const expectedTarget = value.disposition === 'planAccepted'
        ? 'planAction'
        : value.disposition === 'guidanceReplan'
          ? 'planning'
          : value.disposition === 'researchRevision'
            ? 'interventionResearch'
            : 'none';
      if (
        value.nextTargetKind !== expectedTarget
        || value.control.schemaVersion
          !== 'deepcode.session.intervention-proposal.v1'
        || !value.decision.interactionId.trim()
        || !value.decision.interactionRevision.trim()
        || !digest(value.decision.candidateSetDigest)
        || !value.decision.callerRequestId.trim()
        || value.decision.recordedAt !== value.recordedAt
        || (value.disposition === 'planAccepted')
          !== Boolean(value.acceptedPlanRevision)
      ) throw invalidSettlement();
      return;
  }
}
}

export function controlReceiptForProviderOutcomeV2(
  outcome: SessionProviderOutcomeRecordV2
): SessionProviderControlReceiptV2 | undefined {
  return outcome.outputKind === 'plan'
    || outcome.outputKind === 'planEvidenceRefresh'
    || outcome.outputKind === 'planActionComplete'
    || outcome.outputKind === 'intervention'
    ? cloneJson(outcome.control)
    : undefined;
}

export function settlementMatchesProviderOutcomeV2(
  settlement: SessionProviderControlSettlementV2,
  outcome: SessionProviderOutcomeRecordV2 | undefined
): boolean {
  const control = outcome
    ? controlReceiptForProviderOutcomeV2(outcome)
    : undefined;
  return Boolean(
    outcome
    && control
    && outcome.providerTurnId === settlement.predecessorProviderTurnId
    && canonicalJson(control) === canonicalJson(settlement.control)
  );
}

function validateControlReceiptV2(
  control: SessionProviderControlReceiptV2
): void {
  const expectedTool = control.schemaVersion
    === 'deepcode.session.plan-proposal.v5'
    ? 'deepcode_session_plan_propose_v5'
    : control.schemaVersion
        === 'deepcode.session.plan-action-complete.v2'
      ? 'deepcode_session_plan_action_complete_v2'
      : control.schemaVersion
          === 'deepcode.session.intervention-proposal.v1'
        ? 'deepcode_session_intervention_propose_v1'
        : undefined;
  if (
    !expectedTool
    || control.toolName !== expectedTool
    || !control.callId.trim()
    || !digest(control.argumentsDigest)
  ) throw invalidSettlement();
}

function boundedIdentityList(values: readonly string[]): boolean {
  return values.length <= 128
    && new Set(values).size === values.length
    && values.every((value, index) =>
      value.trim().length > 0
      && new TextEncoder().encode(value).byteLength <= 4_096
      && (index === 0 || values[index - 1]! < value)
    );
}

function boundedIdentity(value: string): boolean {
  return value.trim().length > 0
    && new TextEncoder().encode(value).byteLength <= 4_096;
}

function boundedGuidance(value: string): boolean {
  return value.trim().length > 0
    && new TextEncoder().encode(value).byteLength <= 65_536;
}

function boundedDigestList(values: readonly string[]): boolean {
  return values.length <= 128
    && new Set(values).size === values.length
    && values.every((value, index) =>
      digest(value) && (index === 0 || values[index - 1]! < value)
    );
}

function digest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function invalidSettlement(): Error {
  return new Error(
    'Session Provider control settlement is not exact durable v2 data.'
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
