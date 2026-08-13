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
  SessionProviderConversationHeadV1,
} from './sessionMemory.js';
import type {
  SessionKernelProviderCachePredecessorV2,
} from './providerStreamV1.js';

export const SESSION_PROVIDER_ADMISSION_SIDECAR_V2_SCHEMA =
  'deepcode.session.provider-admission-sidecar.v2' as const;
export const SESSION_PROVIDER_CACHE_LANE_IDENTITY_V2_SCHEMA =
  'deepcode.session.provider-cache-lane-identity.v2' as const;
export const SESSION_PROVIDER_SEMANTIC_GUIDANCE_V1_SCHEMA =
  'deepcode.session.provider-semantic-guidance.v1' as const;

export type SessionProviderCacheLaneModeV2 =
  | 'bootstrap'
  | 'append'
  | 'reset'
  | 'exactReplay';

export type SessionProviderCacheLaneRelationKindV2 =
  | 'bootstrap'
  | 'sameTurnToolContinuation'
  | 'sameTurnSessionControlContinuation'
  | 'nextUserTurn'
  | 'exactReplay'
  | 'reset';

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

export type SessionProviderTargetBindingV2 =
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
  | {
      kind: 'interventionResearch';
      researchId: string;
    }
  | ({ kind: 'finalAnswer' } & {
      inputId: string;
      controlEpoch: number;
      workAuthority: SessionWorkAuthorityV3;
      reviewRevision: number;
      snapshotHighWater: number;
    });

export interface SessionProviderAdmissionSidecarV2 {
  schemaVersion: typeof SESSION_PROVIDER_ADMISSION_SIDECAR_V2_SCHEMA;
  sessionId: string;
  runId: string;
  providerTurnId: string;
  userTurnId: string;
  controlEpoch: number;
  purpose: 'primary' | 'continuation' | 'finalAnswer';
  targetKind: SessionProviderTurnInputV2['target']['kind'];
  targetBinding: SessionProviderTargetBindingV2;
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
  providerConversationHead?: SessionProviderConversationHeadV1;
  /**
   * Session-owned canonical Kernel operation identities for the immediately
   * preceding Provider tool turn. They are private admission metadata: the
   * Daemon validates them against the parent trace and Kernel terminal facts,
   * and removes them before constructing the external Provider payload.
   */
  continuationOperationIds?: string[];
  /**
   * Exact settled disposition for every operation above. Successful outputs
   * are still loaded from authoritative Kernel facts by the Daemon. Negative
   * dispositions carry only bounded status metadata needed to close the
   * Provider assistant/tool message pair; raw arguments and tool output never
   * enter this private sidecar.
   */
  continuationOutcomes?: SessionProviderContinuationOutcomeV2[];
  cacheLane: {
    laneId: string;
    laneRevision: number;
    mode: SessionProviderCacheLaneModeV2;
    relationKind: SessionProviderCacheLaneRelationKindV2;
    stablePrefixDigest: string;
    predecessorRequestId?: string;
    predecessorExternalDigest?: string;
    resetReason?: SessionProviderCacheLaneResetReasonV1;
    supportingResetReasons?: SessionProviderCacheLaneResetReasonV1[];
  };
}

export interface SessionProviderContinuationOutcomeV2 {
  operationId: string;
  status: 'completed' | 'aborted' | 'unexecuted';
  terminalFactId?: string;
  terminalFactKind?: string;
  settlementReason?: string;
  rejection?: {
    reason: string;
    guidance: string;
    rejectionFactId: string;
  };
}

export interface BuildSessionProviderAdmissionSidecarV2Input {
  turn: SessionProviderTurnInputV2;
  semanticMessages: readonly LlmChatMessage[];
  fullContextMessages: readonly LlmChatMessage[];
  tools: readonly ProviderWireToolDefinition[];
  cacheLane: SessionProviderCacheLanePlanV2;
  responseFormat?: unknown;
}

export interface SessionProviderCacheMaterialV2 {
  stablePrefixDigest: string;
  toolSchemaDigest: string;
  responseFormatDigest: string;
}

export interface SessionProviderCacheLanePlanV2 {
  mode: SessionProviderCacheLaneModeV2;
  relationKind: SessionProviderCacheLaneRelationKindV2;
  laneId: string;
  laneRevision: number;
  stablePrefixDigest: string;
  predecessorRequestId?: string;
  predecessorExternalDigest?: string;
  resetReason?: SessionProviderCacheLaneResetReasonV1;
  supportingResetReasons?: SessionProviderCacheLaneResetReasonV1[];
}

export interface PlanSessionProviderCacheLaneV2Input {
  turn: SessionProviderTurnInputV2;
  fullContextMessages: readonly LlmChatMessage[];
  tools: readonly ProviderWireToolDefinition[];
  predecessor?: SessionKernelProviderCachePredecessorV2;
  forcedResetReason?: SessionProviderCacheLaneResetReasonV1;
  responseFormat?: unknown;
}

export function planSessionProviderCacheLaneV2(
  input: PlanSessionProviderCacheLaneV2Input
): SessionProviderCacheLanePlanV2 {
  const material = sessionProviderCacheMaterialV2(
    input.fullContextMessages,
    input.tools,
    input.responseFormat
  );
  if (input.forcedResetReason) {
    const supportingResetReasons = input.predecessor?.status === 'available'
      ? incompatiblePredecessorReasonsV2(
          input.turn,
          material,
          input.predecessor
        ).filter((reason) => reason !== input.forcedResetReason)
      : [];
    return newCacheLaneV2(
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
      && incompatiblePredecessorReasonsV2(
        input.turn,
        material,
        predecessor
      ).length === 0
    ) {
      return {
        mode: 'exactReplay',
        relationKind: 'exactReplay',
        laneId: predecessor.cacheLane.laneId,
        laneRevision: predecessor.cacheLane.laneRevision,
        stablePrefixDigest: material.stablePrefixDigest,
        predecessorRequestId: predecessor.providerTurnId,
        predecessorExternalDigest: predecessor.externalRequestDigest,
      };
    }
    return newCacheLaneV2(
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
  const conversationHead =
    input.turn.sessionMemory.providerConversationHead;
  const predecessor = input.predecessor;
  if (input.turn.purpose === 'primary' && !conversationHead) {
    return newCacheLaneV2(input.turn, material, 'bootstrap');
  }
  if (!predecessor) {
    return newCacheLaneV2(
      input.turn,
      material,
      'reset',
      input.turn.purpose === 'primary'
        ? 'daemonTraceUnavailable'
        : 'semanticLaneChanged'
    );
  }
  if (predecessor.status === 'unavailable') {
    return newCacheLaneV2(
      input.turn,
      material,
      'reset',
      predecessor.reasonCode
    );
  }
  const resetReasons = incompatiblePredecessorReasonsV2(
    input.turn,
    material,
    predecessor
  );
  if (
    input.turn.purpose === 'primary'
    && conversationHead
    && !providerConversationHeadMatchesPredecessorV2(
      conversationHead,
      predecessor
    )
  ) {
    resetReasons.unshift('daemonTraceInvalid');
  }
  if (resetReasons.length > 0) {
    return newCacheLaneV2(
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
    relationKind: input.turn.purpose === 'primary'
      ? 'nextUserTurn'
      : sessionProviderSameTurnRelationV2(
          input.turn,
          predecessor.providerTurnId
        ),
    laneId: predecessor.cacheLane.laneId,
    laneRevision: predecessor.cacheLane.laneRevision,
    stablePrefixDigest: material.stablePrefixDigest,
    predecessorRequestId: predecessor.providerTurnId,
    predecessorExternalDigest: predecessor.externalRequestDigest,
  };
}

export function buildSessionProviderAdmissionSidecarV2(
  input: BuildSessionProviderAdmissionSidecarV2Input
): SessionProviderAdmissionSidecarV2 {
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
  const material = sessionProviderCacheMaterialV2(
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
  const continuation =
    sessionProviderContinuationOutcomesV2(
      turn,
      input.cacheLane
    );
  return {
    schemaVersion: SESSION_PROVIDER_ADMISSION_SIDECAR_V2_SCHEMA,
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
    ...(input.cacheLane.relationKind === 'nextUserTurn'
      && turn.sessionMemory.providerConversationHead
      ? {
          providerConversationHead: cloneJson(
            turn.sessionMemory.providerConversationHead
          ),
        }
      : {}),
    ...(continuation
      ? {
          continuationOperationIds: continuation.map(
            (outcome) => outcome.operationId
          ),
          continuationOutcomes: continuation,
        }
      : {}),
    cacheLane: cloneJson(input.cacheLane),
  };
}

function sessionProviderContinuationOutcomesV2(
  turn: SessionProviderTurnInputV2,
  cacheLane: SessionProviderCacheLanePlanV2
): SessionProviderContinuationOutcomeV2[] | undefined {
  if (
    cacheLane.mode !== 'append'
    || cacheLane.relationKind !== 'sameTurnToolContinuation'
  ) return undefined;
  const predecessorId = cacheLane.predecessorRequestId;
  const predecessor = turn.providerOutcomes.at(-1);
  if (
    turn.purpose !== 'continuation'
    || !predecessorId
    || !predecessor
    || predecessor.providerTurnId !== predecessorId
    || predecessor.outputKind !== 'toolIntent'
    || predecessor.toolCalls.length
      !== predecessor.toolCallReceipt.callCount
    || predecessor.toolCalls.some((call, index) =>
      call.ordinal !== index + 1
    )
    || (
      predecessor.toolSettlement.status === 'completed'
      && predecessor.toolCalls.some((call) => call.status !== 'completed')
    )
    || (
      predecessor.toolSettlement.status === 'aborted'
      && predecessor.toolCalls.every((call) => call.status === 'completed')
    )
  ) {
    throw new Error(
      'Session Provider append continuation requires one exact settled predecessor tool outcome.'
    );
  }
  const operationIds = predecessor.toolCalls.map((call) => call.operationId);
  if (
    operationIds.length === 0
    || operationIds.length > 32
    || new Set(operationIds).size !== operationIds.length
  ) {
    throw new Error(
      'Session Provider append continuation operation identities are invalid.'
    );
  }
  return predecessor.toolCalls.map((call) => ({
    operationId: call.operationId,
    status: call.status,
    ...(call.terminalFactId
      ? { terminalFactId: call.terminalFactId }
      : {}),
    ...(call.terminalFactKind
      ? { terminalFactKind: call.terminalFactKind }
      : {}),
    ...(call.settlementReason
      ? { settlementReason: call.settlementReason }
      : {}),
    ...(call.rejection
      ? { rejection: cloneJson(call.rejection) }
      : {}),
  }));
}

export function sessionProviderSemanticMessagesV2(
  turn: SessionProviderTurnInputV2,
  cacheLane: SessionProviderCacheLanePlanV2,
  predecessor: SessionKernelProviderCachePredecessorV2 | undefined
): LlmChatMessage[] {
  if (cacheLane.mode !== 'append') {
    return cloneJson(turn.contextAssembly.messages);
  }
  if (cacheLane.relationKind === 'nextUserTurn') {
    const finalMessage = turn.contextAssembly.messages.at(-1);
    if (!finalMessage || finalMessage.role !== 'user') {
      throw new Error(
        'Next-user-turn append requires the authoritative dynamic user frame at the request tail.'
      );
    }
    return [cloneJson(finalMessage)];
  }
  if (
    cacheLane.relationKind
      === 'sameTurnSessionControlContinuation'
  ) {
    return sessionControlTransitionMessagesV1(turn);
  }
  if (cacheLane.relationKind !== 'sameTurnToolContinuation') {
    throw new Error(
      'Provider append relation is unsupported for semantic message assembly.'
    );
  }
  if (predecessor?.status !== 'available') {
    throw new Error(
      'Provider tool continuation requires its exact available predecessor binding.'
    );
  }
  const targetBindingChanged = predecessor.targetBindingDigest
    !== sha256Hash(canonicalJson(turn.target));
  if (!targetBindingChanged && turn.guidance.length === 0) return [];
  const finalMessage = turn.contextAssembly.messages.at(-1);
  if (
    !finalMessage
    || finalMessage.role !== 'user'
    || jsonMessageSchemaV1(finalMessage.content)
      !== 'deepcode.session.provider-turn-frame.v1'
  ) {
    throw new Error(
      'Provider tool continuation target transition requires the authoritative dynamic user frame at the request tail.'
    );
  }
  return [cloneJson(finalMessage)];
}

function sessionProviderSameTurnRelationV2(
  turn: SessionProviderTurnInputV2,
  predecessorProviderTurnId: string
): Extract<
  SessionProviderCacheLaneRelationKindV2,
  | 'sameTurnToolContinuation'
  | 'sameTurnSessionControlContinuation'
> {
  const predecessor = turn.providerOutcomes.at(-1);
  if (
    !predecessor
    || predecessor.providerTurnId !== predecessorProviderTurnId
  ) {
    throw new Error(
      'Session Provider append requires the exact latest durable predecessor outcome.'
    );
  }
  if (predecessor.outputKind === 'toolIntent') {
    return 'sameTurnToolContinuation';
  }
  if (
    predecessor.outputKind === 'plan'
    || predecessor.outputKind === 'planActionComplete'
    || predecessor.outputKind === 'intervention'
  ) {
    return 'sameTurnSessionControlContinuation';
  }
  throw new Error(
    'Session Provider append predecessor is neither a settled Kernel tool turn nor a settled Session control turn.'
  );
}

function sessionControlTransitionMessagesV1(
  turn: SessionProviderTurnInputV2
): LlmChatMessage[] {
  if (turn.purpose !== 'continuation') {
    throw new Error(
      'Session control continuation must remain in the current authoritative user turn.'
    );
  }
  const planMessages = turn.contextAssembly.messages.filter((message) =>
    message.role === 'user'
    && jsonMessageSchemaV1(message.content)
      === 'deepcode.session.provider-plan-decision.v3'
  );
  const turnMessages = turn.contextAssembly.messages.filter((message) =>
    message.role === 'user'
    && jsonMessageSchemaV1(message.content)
      === 'deepcode.session.provider-turn-frame.v1'
  );
  if (planMessages.length !== 1 || turnMessages.length !== 1) {
    throw new Error(
      'Session control continuation requires one current Plan view and one authoritative turn frame.'
    );
  }
  return [
    cloneJson(planMessages[0]!),
    cloneJson(turnMessages[0]!),
  ];
}

function jsonMessageSchemaV1(content: string): string | undefined {
  try {
    const decoded = JSON.parse(content) as unknown;
    if (
      !decoded
      || typeof decoded !== 'object'
      || Array.isArray(decoded)
    ) return undefined;
    const schemaVersion = (decoded as Record<string, unknown>)
      .schemaVersion;
    return typeof schemaVersion === 'string'
      ? schemaVersion
      : undefined;
  } catch {
    return undefined;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function sessionProviderCacheMaterialV2(
  fullContextMessages: readonly LlmChatMessage[],
  tools: readonly ProviderWireToolDefinition[],
  responseFormat?: unknown
): SessionProviderCacheMaterialV2 {
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

function newCacheLaneV2(
  turn: SessionProviderTurnInputV2,
  material: SessionProviderCacheMaterialV2,
  mode: 'bootstrap' | 'reset',
  resetReason?: SessionProviderCacheLaneResetReasonV1,
  laneRevision = 1,
  supportingResetReasons: SessionProviderCacheLaneResetReasonV1[] = []
): SessionProviderCacheLanePlanV2 {
  const laneIdentity = {
    schemaVersion: SESSION_PROVIDER_CACHE_LANE_IDENTITY_V2_SCHEMA,
    sessionId: turn.sessionMemory.sessionId,
    runId: turn.runId,
    userTurnId: turn.currentInput.inputId,
    bootstrapProviderTurnId: turn.providerTurnId,
    providerProfileRevisionDigest:
      turn.providerProfile.providerProfileRevisionDigest,
    catalogDigest: turn.toolContext.contextRef.catalogDigest,
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
    relationKind: mode === 'bootstrap' ? 'bootstrap' : 'reset',
    laneId: sha256Hash(canonicalJson(laneIdentity)),
    laneRevision,
    stablePrefixDigest: material.stablePrefixDigest,
    ...(resetReason ? { resetReason } : {}),
    ...(supportingResetReasons.length > 0
      ? { supportingResetReasons: [...supportingResetReasons] }
      : {}),
  };
}

function incompatiblePredecessorReasonsV2(
  turn: SessionProviderTurnInputV2,
  material: SessionProviderCacheMaterialV2,
  predecessor: Extract<
    SessionKernelProviderCachePredecessorV2,
    { status: 'available' }
  >
): SessionProviderCacheLaneResetReasonV1[] {
  const reasons: SessionProviderCacheLaneResetReasonV1[] = [];
  if (
    predecessor.providerProfileRevisionDigest
      !== turn.providerProfile.providerProfileRevisionDigest
  ) reasons.push('providerProfileChanged');
  if (predecessor.toolSchemaDigest !== material.toolSchemaDigest) {
    reasons.push('toolSchemaChanged');
  }
  if (
    predecessor.responseFormatDigest
      !== material.responseFormatDigest
  ) reasons.push('responseFormatChanged');
  if (
    predecessor.toolContextRef.catalogDigest
      !== turn.toolContext.contextRef.catalogDigest
    && !reasons.includes('toolSchemaChanged')
  ) reasons.push('toolSchemaChanged');
  if (
    predecessor.cacheLane.stablePrefixDigest
      !== material.stablePrefixDigest
  ) reasons.push('systemContractChanged');
  return reasons;
}

function providerConversationHeadMatchesPredecessorV2(
  head: SessionProviderConversationHeadV1,
  predecessor: Extract<
    SessionKernelProviderCachePredecessorV2,
    { status: 'available' }
  >
): boolean {
  return predecessor.sessionId === head.sessionId
    && predecessor.runId === head.runId
    && predecessor.userTurnId === head.userTurnId
    && predecessor.providerTurnId === head.providerTurnId
    && predecessor.controlEpoch === head.controlEpoch
    && predecessor.providerProfileId === head.providerProfileId
    && predecessor.provider === head.provider
    && predecessor.model === head.model;
}
