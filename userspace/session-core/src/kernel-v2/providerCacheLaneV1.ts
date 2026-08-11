import type {
  LlmChatMessage,
  ProviderWireToolDefinition,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import type {
  SessionProviderTurnInputV2,
  SessionWorkAuthorityV3,
} from './types.js';
import type {
  SessionKernelProviderCachePredecessorV1,
} from './providerStreamV1.js';

export const SESSION_PROVIDER_ADMISSION_SIDECAR_V1_SCHEMA =
  'deepcode.session.provider-admission-sidecar.v1' as const;
export const SESSION_PROVIDER_CACHE_LANE_IDENTITY_V1_SCHEMA =
  'deepcode.session.provider-cache-lane-identity.v1' as const;
export const SESSION_PROVIDER_SEMANTIC_GUIDANCE_V1_SCHEMA =
  'deepcode.session.provider-semantic-guidance.v1' as const;

export type SessionProviderCacheLaneModeV1 =
  | 'bootstrap'
  | 'append'
  | 'reset'
  | 'exactReplay';

export type SessionProviderCacheLaneResetReasonV1 =
  | 'coldStart'
  | 'semanticLaneChanged'
  | 'providerProfileChanged'
  | 'modelChanged'
  | 'systemContractChanged'
  | 'toolSchemaChanged'
  | 'responseFormatChanged'
  | 'contextCompaction'
  | 'rewind'
  | 'daemonTraceUnavailable'
  | 'daemonTraceInvalid'
  | 'legacySessionColdStart'
  | 'manualReset';

export type SessionProviderTargetBindingV1 =
  | { kind: 'planning' }
  | {
      kind: 'contextRead';
      operationId: string;
      purpose: string;
      idempotencyKey: string;
      deadline?: unknown;
    }
  | {
      kind: 'planAction';
      planActionId: string;
    }
  | ({ kind: 'finalAnswer' } & {
      inputId: string;
      controlEpoch: number;
      workAuthority: SessionWorkAuthorityV3;
      reviewRevision: number;
      snapshotHighWater: number;
    });

export interface SessionProviderAdmissionSidecarV1 {
  schemaVersion: typeof SESSION_PROVIDER_ADMISSION_SIDECAR_V1_SCHEMA;
  sessionId: string;
  runId: string;
  providerTurnId: string;
  userTurnId: string;
  controlEpoch: number;
  purpose: 'primary' | 'continuation' | 'finalAnswer';
  targetKind: SessionProviderTurnInputV2['target']['kind'];
  targetBinding: SessionProviderTargetBindingV1;
  providerProfileRevisionDigest: string;
  currentInputDigest: string;
  contextAssemblyDigest: string;
  semanticMessagesDigest: string;
  toolSchemaDigest: string;
  responseFormatDigest: string;
  toolContextRef: {
    contextVersion: number;
    catalogDigest: string;
    contextDigest: string;
  };
  authority: {
    planRevision?: string;
    workAuthority?: SessionWorkAuthorityV3;
    reviewRevision?: number;
    snapshotHighWater?: number;
  };
  cacheLane: {
    laneId: string;
    laneRevision: number;
    mode: SessionProviderCacheLaneModeV1;
    stablePrefixDigest: string;
    predecessorRequestId?: string;
    predecessorExternalDigest?: string;
    resetReason?: SessionProviderCacheLaneResetReasonV1;
    supportingResetReasons?: SessionProviderCacheLaneResetReasonV1[];
  };
}

export interface BuildSessionProviderAdmissionSidecarV1Input {
  turn: SessionProviderTurnInputV2;
  semanticMessages: readonly LlmChatMessage[];
  fullContextMessages: readonly LlmChatMessage[];
  tools: readonly ProviderWireToolDefinition[];
  cacheLane: SessionProviderCacheLanePlanV1;
  responseFormat?: unknown;
}

export interface SessionProviderCacheMaterialV1 {
  stablePrefixDigest: string;
  toolSchemaDigest: string;
  responseFormatDigest: string;
}

export interface SessionProviderCacheLanePlanV1 {
  mode: SessionProviderCacheLaneModeV1;
  laneId: string;
  laneRevision: number;
  stablePrefixDigest: string;
  predecessorRequestId?: string;
  predecessorExternalDigest?: string;
  resetReason?: SessionProviderCacheLaneResetReasonV1;
  supportingResetReasons?: SessionProviderCacheLaneResetReasonV1[];
}

export interface PlanSessionProviderCacheLaneV1Input {
  turn: SessionProviderTurnInputV2;
  fullContextMessages: readonly LlmChatMessage[];
  tools: readonly ProviderWireToolDefinition[];
  predecessor?: SessionKernelProviderCachePredecessorV1;
  forcedResetReason?: SessionProviderCacheLaneResetReasonV1;
  responseFormat?: unknown;
}

export function planSessionProviderCacheLaneV1(
  input: PlanSessionProviderCacheLaneV1Input
): SessionProviderCacheLanePlanV1 {
  const material = sessionProviderCacheMaterialV1(
    input.fullContextMessages,
    input.tools,
    input.responseFormat
  );
  if (input.forcedResetReason) {
    const supportingResetReasons = input.predecessor?.status === 'available'
      ? incompatiblePredecessorReasonsV1(
          input.turn,
          material,
          input.predecessor
        ).filter((reason) => reason !== input.forcedResetReason)
      : [];
    return newCacheLaneV1(
      input.turn,
      material,
      'reset',
      input.forcedResetReason,
      input.predecessor?.status === 'available'
        ? input.predecessor.cacheLane.laneRevision + 1
        : 1,
      supportingResetReasons
    );
  }
  if (input.turn.exactReplayPredecessorId) {
    const predecessor = input.predecessor;
    if (
      predecessor?.status === 'available'
      && predecessor.providerTurnId
        === input.turn.exactReplayPredecessorId
      && predecessor.replayEligible
      && predecessor.terminalKind === 'failed'
      && incompatiblePredecessorReasonsV1(
        input.turn,
        material,
        predecessor
      ).length === 0
    ) {
      return {
        mode: 'exactReplay',
        laneId: predecessor.cacheLane.laneId,
        laneRevision: predecessor.cacheLane.laneRevision,
        stablePrefixDigest: material.stablePrefixDigest,
        predecessorRequestId: predecessor.providerTurnId,
        predecessorExternalDigest: predecessor.externalRequestDigest,
      };
    }
    return newCacheLaneV1(
      input.turn,
      material,
      'reset',
      predecessor?.status === 'unavailable'
        ? predecessor.reasonCode
        : 'daemonTraceInvalid',
      predecessor?.status === 'available'
        ? predecessor.cacheLane.laneRevision + 1
        : 1
    );
  }
  if (input.turn.purpose === 'primary') {
    return newCacheLaneV1(input.turn, material, 'bootstrap');
  }
  const predecessor = input.predecessor;
  if (!predecessor) {
    return newCacheLaneV1(
      input.turn,
      material,
      'reset',
      'semanticLaneChanged'
    );
  }
  if (predecessor.status === 'unavailable') {
    return newCacheLaneV1(
      input.turn,
      material,
      'reset',
      predecessor.reasonCode
    );
  }
  const resetReasons = incompatiblePredecessorReasonsV1(
    input.turn,
    material,
    predecessor
  );
  if (resetReasons.length > 0) {
    return newCacheLaneV1(
      input.turn,
      material,
      'reset',
      resetReasons[0],
      predecessor.cacheLane.laneRevision + 1,
      resetReasons.slice(1)
    );
  }
  return {
    mode: 'append',
    laneId: predecessor.cacheLane.laneId,
    laneRevision: predecessor.cacheLane.laneRevision,
    stablePrefixDigest: material.stablePrefixDigest,
    predecessorRequestId: predecessor.providerTurnId,
    predecessorExternalDigest: predecessor.externalRequestDigest,
  };
}

export function buildSessionProviderAdmissionSidecarV1(
  input: BuildSessionProviderAdmissionSidecarV1Input
): SessionProviderAdmissionSidecarV1 {
  const turn = input.turn;
  const currentInputSections = turn.contextAssembly.receipt
    .trimming.sections.filter(
      (section) => section.section === 'currentInput'
    );
  if (currentInputSections.length !== 1) {
    throw new Error(
      'Session Provider admission requires one currentInput receipt.'
    );
  }
  const material = sessionProviderCacheMaterialV1(
    input.fullContextMessages,
    input.tools,
    input.responseFormat
  );
  if (
    material.stablePrefixDigest
      !== input.cacheLane.stablePrefixDigest
  ) {
    throw new Error(
      'Session Provider cache plan conflicts with current request material.'
    );
  }
  return {
    schemaVersion: SESSION_PROVIDER_ADMISSION_SIDECAR_V1_SCHEMA,
    sessionId: turn.sessionMemory.sessionId,
    runId: turn.runId,
    providerTurnId: turn.providerTurnId,
    userTurnId: turn.currentInput.inputId,
    controlEpoch: turn.controlEpoch,
    purpose: turn.purpose,
    targetKind: turn.target.kind,
    targetBinding: cloneJson(turn.target),
    providerProfileRevisionDigest:
      turn.providerProfile.providerProfileRevisionDigest,
    currentInputDigest: currentInputSections[0]!.digest,
    contextAssemblyDigest: sha256Hash(
      canonicalJson(turn.contextAssembly.receipt)
    ),
    semanticMessagesDigest: sha256Hash(
      canonicalJson(input.semanticMessages)
    ),
    toolSchemaDigest: material.toolSchemaDigest,
    responseFormatDigest: material.responseFormatDigest,
    toolContextRef: cloneJson(turn.toolContext.contextRef),
    authority: {
      ...(turn.plan
        ? { planRevision: turn.plan.planRevision }
        : {}),
      ...(turn.target.kind === 'finalAnswer'
        ? {
            workAuthority: cloneJson(turn.target.workAuthority),
            reviewRevision: turn.target.reviewRevision,
            snapshotHighWater: turn.target.snapshotHighWater,
          }
        : {}),
    },
    cacheLane: cloneJson(input.cacheLane),
  };
}

export function sessionProviderSemanticMessagesV1(
  turn: SessionProviderTurnInputV2,
  cacheLane: SessionProviderCacheLanePlanV1
): LlmChatMessage[] {
  if (cacheLane.mode !== 'append') {
    return cloneJson(turn.contextAssembly.messages);
  }
  if (turn.guidance.length === 0) return [];
  return [{
    role: 'user',
    content: canonicalJson({
      schemaVersion: SESSION_PROVIDER_SEMANTIC_GUIDANCE_V1_SCHEMA,
      guidance: [...turn.guidance],
    }),
  }];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function sessionProviderCacheMaterialV1(
  fullContextMessages: readonly LlmChatMessage[],
  tools: readonly ProviderWireToolDefinition[],
  responseFormat?: unknown
): SessionProviderCacheMaterialV1 {
  const stableSystemMessages = fullContextMessages.filter(
    (message) => message.role === 'system'
  );
  const clonedTools = cloneJson(tools);
  const normalizedResponseFormat = responseFormat ?? null;
  const toolSchemaDigest = sha256Hash(canonicalJson(clonedTools));
  const responseFormatDigest = sha256Hash(
    canonicalJson(normalizedResponseFormat)
  );
  return {
    stablePrefixDigest: sha256Hash(canonicalJson({
      systemMessages: stableSystemMessages,
      tools: clonedTools,
      responseFormat: normalizedResponseFormat,
    })),
    toolSchemaDigest,
    responseFormatDigest,
  };
}

function newCacheLaneV1(
  turn: SessionProviderTurnInputV2,
  material: SessionProviderCacheMaterialV1,
  mode: 'bootstrap' | 'reset',
  resetReason?: SessionProviderCacheLaneResetReasonV1,
  laneRevision = 1,
  supportingResetReasons: SessionProviderCacheLaneResetReasonV1[] = []
): SessionProviderCacheLanePlanV1 {
  const laneIdentity = {
    schemaVersion: SESSION_PROVIDER_CACHE_LANE_IDENTITY_V1_SCHEMA,
    sessionId: turn.sessionMemory.sessionId,
    runId: turn.runId,
    userTurnId: turn.currentInput.inputId,
    bootstrapProviderTurnId: turn.providerTurnId,
    providerProfileRevisionDigest:
      turn.providerProfile.providerProfileRevisionDigest,
    targetKind: turn.target.kind,
    toolContextRef: turn.toolContext.contextRef,
    stablePrefixDigest: material.stablePrefixDigest,
    toolSchemaDigest: material.toolSchemaDigest,
    responseFormatDigest: material.responseFormatDigest,
    mode,
    ...(resetReason ? { resetReason } : {}),
    ...(supportingResetReasons.length > 0
      ? { supportingResetReasons: [...supportingResetReasons] }
      : {}),
  };
  return {
    mode,
    laneId: sha256Hash(canonicalJson(laneIdentity)),
    laneRevision,
    stablePrefixDigest: material.stablePrefixDigest,
    ...(resetReason ? { resetReason } : {}),
    ...(supportingResetReasons.length > 0
      ? { supportingResetReasons: [...supportingResetReasons] }
      : {}),
  };
}

function incompatiblePredecessorReasonsV1(
  turn: SessionProviderTurnInputV2,
  material: SessionProviderCacheMaterialV1,
  predecessor: Extract<
    SessionKernelProviderCachePredecessorV1,
    { status: 'available' }
  >
): SessionProviderCacheLaneResetReasonV1[] {
  const reasons: SessionProviderCacheLaneResetReasonV1[] = [];
  if (
    predecessor.providerProfileRevisionDigest
      !== turn.providerProfile.providerProfileRevisionDigest
  ) reasons.push('providerProfileChanged');
  if (predecessor.targetKind !== turn.target.kind) {
    reasons.push('semanticLaneChanged');
  }
  if (
    predecessor.targetBindingDigest
      !== sha256Hash(canonicalJson(turn.target))
    && !reasons.includes('semanticLaneChanged')
  ) reasons.push('semanticLaneChanged');
  if (predecessor.toolSchemaDigest !== material.toolSchemaDigest) {
    reasons.push('toolSchemaChanged');
  }
  if (
    predecessor.responseFormatDigest
      !== material.responseFormatDigest
  ) reasons.push('responseFormatChanged');
  if (
    canonicalJson(predecessor.toolContextRef)
      !== canonicalJson(turn.toolContext.contextRef)
    && !reasons.includes('toolSchemaChanged')
  ) reasons.push('toolSchemaChanged');
  if (
    predecessor.cacheLane.stablePrefixDigest
      !== material.stablePrefixDigest
  ) reasons.push('systemContractChanged');
  return reasons;
}
