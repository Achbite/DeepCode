import type {
  AgentInputAttachmentV2,
  LlmChatMessage,
  LlmReasoningTransport,
  CapabilityScopePreviewRecordV2,
  DeadlineRequestV2,
  InvocationCancelReplyV2,
  KernelFactProjectionV2,
  RawToolArgumentsV2,
  ScopeManifestV2,
  ToolContextBundleV2,
  ToolContextRefV2,
  ToolDescriptorV2,
  ToolIntentV2,
} from '@deepcode/protocol';
import type {
  SessionContextMemoryV2,
} from './sessionMemory.js';
import type {
  SessionKernelCapabilityPreviewRequestV2,
  SessionKernelEpochAdvanceRequestV2,
  SessionKernelFactsRequestV2,
  SessionKernelInvocationCancelRequestV2,
  SessionKernelToolIntentRequestV2,
} from './SessionKernelPortV2.js';
import type { ProviderKernelToolSourceV2 } from './toolIntent.js';

export const SESSION_KERNEL_LOOP_V2_SCHEMA =
  'deepcode.session.kernel-loop.v3' as const;
export const SESSION_KERNEL_CHECKPOINT_V2_SCHEMA =
  'deepcode.session.kernel-checkpoint.v3' as const;
export const SESSION_KERNEL_REVIEW_PROJECTION_V2 =
  'deepcode.session.kernel-review-projection.v2' as const;
export const SESSION_PROVIDER_PROFILE_BOOTSTRAP_V2_SCHEMA =
  'deepcode.host.provider-profile-bootstrap.v2' as const;
export const SESSION_PROVIDER_CONTEXT_RECEIPT_V2_SCHEMA =
  'deepcode.session.provider-context-receipt.v2' as const;
export const SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA =
  'deepcode.session.provider-tool-call-receipt.v2' as const;
export const SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA =
  'deepcode.provider-stream-terminal.v1' as const;
export const SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA =
  'deepcode.session.provider-turn-dispatch.v3' as const;
export const SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA =
  'deepcode.session.provider-turn-terminal.v3' as const;
export const SESSION_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA =
  'deepcode.session.tool-context-snapshot.v3' as const;

export type SessionWorkAuthorityV3 =
  | {
      kind: 'plan';
      planRevision: string;
    }
  | {
      kind: 'contextRead';
      operationIds: string[];
      digest: string;
    };

export interface SessionKernelPersistenceRecordRefV3 {
  recordId: string;
  recordDigest: string;
}

export interface SessionProviderAuthorityBindingV3 {
  runId: string;
  inputId: string;
  controlEpoch: number;
  currentInputDigest: string;
  planRevision?: string;
  reviewRevision?: number;
  snapshotHighWater?: number;
  providerProfileId: string;
  providerProfileRevisionDigest: string;
}

export interface SessionProviderTurnDispatchRecordV3 {
  ref: SessionKernelPersistenceRecordRefV3;
  recordedAt: string;
  data: {
    schemaVersion: typeof SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA;
    providerTurnId: string;
    purpose: 'primary' | 'continuation' | 'finalAnswer';
    authorityBinding: SessionProviderAuthorityBindingV3;
    requestDigest: string;
  };
}

export type SessionProviderTerminalOrderedItemV3 =
  | {
      kind: 'text';
      phase: 'commentary' | 'final_answer' | 'unknown';
      text: string;
    }
  | {
      kind: 'toolCall';
      index: number;
      callId: string;
      name: string;
      arguments: string;
    };

export interface SessionProviderTurnTerminalRecordV3 {
  ref: SessionKernelPersistenceRecordRefV3;
  recordedAt: string;
  data: {
    schemaVersion: typeof SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA;
    providerTurnId: string;
    dispatchRef: SessionKernelPersistenceRecordRefV3;
    authorityBinding: SessionProviderAuthorityBindingV3;
    terminalKind:
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'limitExceeded';
    reasonCode?: string;
    responseDigest?: string;
    completion?: SessionProviderCompletionReceiptV1;
    providerResult?: {
      providerProfileId: string;
      provider: string;
      model: string;
      usage?: Record<string, unknown>;
    };
    traceRef: {
      terminalDigest: string;
      sealDigest: string;
      recordCount: number;
    };
    orderedItems: SessionProviderTerminalOrderedItemV3[];
  };
}

export interface SessionToolContextSnapshotRecordV3 {
  ref: SessionKernelPersistenceRecordRefV3;
  recordedAt: string;
  data: {
    schemaVersion: typeof SESSION_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA;
    runId: string;
    contextRef: ToolContextRefV2;
    toolContext: ToolContextBundleV2;
  };
}

export interface SessionProviderTurnDurableEvidenceV3 {
  dispatch?: SessionProviderTurnDispatchRecordV3;
  terminal?: SessionProviderTurnTerminalRecordV3;
}

export type SessionProviderNativeCompletionV1 =
  | {
      providerKind: 'openaiCompatible';
      terminalSignal: '[DONE]';
      finishReason: 'stop' | 'tool_calls';
    }
  | {
      providerKind: 'anthropic';
      terminalSignal: 'message_stop';
    }
  | {
      providerKind: 'ollama';
      terminalSignal: 'done:true';
    };

/**
 * Safe terminal evidence produced only after the Daemon has observed the
 * provider-native completion marker and durably sealed the private trace.
 * It deliberately carries no reasoning text, raw provider envelope, secret,
 * capability, or lease.
 */
export interface SessionProviderCompletionReceiptV1 {
  schemaVersion: typeof SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA;
  nativeCompletion: SessionProviderNativeCompletionV1;
  reasoningPresent: true;
  reasoningTransport:
    | 'openaiPlaintext'
    | 'anthropicPlaintext'
    | 'ollamaPlaintext';
  reasoningDigest: string;
  responseDigest: string;
  trace: {
    sealed: true;
    sealDigest: string;
    terminalDigest: string;
    recordCount: number;
  };
}

export type SessionProviderOrderedItemV2 =
  | {
      kind: 'text';
      phase: 'commentary' | 'final_answer' | 'unknown';
      text: string;
    }
  | {
      kind: 'toolCall';
      source: 'providerNative';
      ordinal: number;
      callId: string;
      toolName: string;
      toolId: string;
      arguments: RawToolArgumentsV2;
    };

export interface SessionProviderProfileBootstrapV2 {
  schemaVersion: typeof SESSION_PROVIDER_PROFILE_BOOTSTRAP_V2_SCHEMA;
  providerProfileId: string;
  providerProfileRevisionDigest: string;
  reasoningTransport: LlmReasoningTransport;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export type SessionProviderContextSectionV2 =
  | 'kernelFixedPrompt'
  | 'sessionContract'
  | 'currentInput'
  | 'priorSessionMemory'
  | 'planDecision'
  | 'review'
  | 'providerOutcomes'
  | 'canonicalFacts';

export interface SessionProviderContextSectionReceiptV2 {
  section: SessionProviderContextSectionV2;
  estimatedTokens: number;
  originalCount: number;
  selectedCount: number;
  omittedCount: number;
  digest: string;
}

export interface SessionProviderContextReceiptV2 {
  schemaVersion: typeof SESSION_PROVIDER_CONTEXT_RECEIPT_V2_SCHEMA;
  providerProfile: {
    providerProfileId: string;
    providerProfileRevisionDigest: string;
    reasoningTransport: LlmReasoningTransport;
    contextWindowTokens: number;
    maxOutputTokens: number;
  };
  inputTokenBudget: number;
  estimatedInputTokens: number;
  memory: SessionContextMemoryV2;
  trimming: {
    strategy: 'utf8-bytes-upper-bound.v2';
    sections: SessionProviderContextSectionReceiptV2[];
  };
}

export interface SessionProviderContextAssemblyV2 {
  messages: LlmChatMessage[];
  receipt: SessionProviderContextReceiptV2;
}

export interface SessionProviderResultMetadataV2 {
  providerProfileId: string;
  provider: string;
  model: string;
  usage?: Record<string, unknown>;
}

export interface SessionProviderToolCallReceiptItemV2 {
  ordinal: number;
  callId: string;
  toolName: string;
  toolId: string;
  argumentsDigest: string;
}

/**
 * Safe durable evidence for one Provider response. Raw response text and tool
 * arguments deliberately remain outside this receipt.
 */
export interface SessionProviderToolCallReceiptV2 {
  schemaVersion: typeof SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA;
  providerTurnId: string;
  responseDigest: string;
  callCount: number;
  calls: SessionProviderToolCallReceiptItemV2[];
  recordedAt: string;
}

export interface SessionPlanActionV2 {
  taskId: string;
  manifest: ScopeManifestV2;
  previewArguments: RawToolArgumentsV2;
  idempotencyKey: string;
  deadline: DeadlineRequestV2;
}

/**
 * Plan prose remains Session-owned. ScopeManifest is the structured,
 * persistable boundary used later for Kernel preview and ToolIntent binding.
 */
export interface SessionNaturalLanguagePlanV2 {
  runId: string;
  inputId: string;
  planRevision: string;
  title: string;
  objective: string;
  narrative: string;
  actions: SessionPlanActionV2[];
  recordedAt: string;
}

export interface SessionPlanDecisionV2 {
  planRevision: string;
  decision: 'accept' | 'reject' | 'revise';
  guidance?: string;
  recordedAt: string;
}

export interface SessionPlanConfirmationProjectionRefV2 {
  projectionId: string;
  projectionDigest: string;
}

/**
 * Durable Session authority proving that the exact current Plan, canonical
 * previews, sealed Provider response, and public confirmation boundary were
 * committed together before a trusted user decision was admitted.
 */
export interface SessionPlanConfirmationAuthorityV2 {
  planRevision: string;
  providerTurnId: string;
  providerResponseDigest: string;
  controlEpoch: number;
  toolContextRef: ToolContextRefV2;
  planDigest: string;
  scopePreviewsDigest: string;
  authorityDigest: string;
  recordedAt: string;
  commentaryProjection?: SessionPlanConfirmationProjectionRefV2;
  confirmationProjection: SessionPlanConfirmationProjectionRefV2;
}

export interface SessionUserInputRecordV2 {
  inputId: string;
  opaqueInputRef: string;
  text: string;
  attachments: AgentInputAttachmentV2[];
  recordedAt: string;
}

export type SessionProviderTurnTargetV2 =
  | {
      kind: 'planning';
    }
  | {
      kind: 'planAction';
      planActionId: string;
    }
  | {
      kind: 'contextRead';
      operationId: string;
      purpose: string;
      idempotencyKey: string;
      deadline?: DeadlineRequestV2;
    }
  | ({
      kind: 'finalAnswer';
    } & SessionFinalAnswerBindingV3);

export interface SessionFinalAnswerBindingV3 {
  inputId: string;
  controlEpoch: number;
  workAuthority: SessionWorkAuthorityV3;
  reviewRevision: number;
  snapshotHighWater: number;
}

export interface SessionFinalAnswerStateV3 {
  status:
    | 'pending'
    | 'requesting'
    | 'stale'
    | 'committed'
    | 'finalAnswerFailed';
  binding: SessionFinalAnswerBindingV3;
  physicalRequestCount: number;
  providerTurnId?: string;
  startedAt?: string;
  staleAt?: string;
  committedAt?: string;
  failedAt?: string;
  finalText?: string;
  lastErrorCode?: string;
}

export interface SessionProviderTurnRequestV2 {
  reason:
    | 'planExecution'
    | 'userInput'
    | 'capabilityDenied'
    | 'retryGuidance'
    | 'recovery'
    | 'finalAnswer';
  target: SessionProviderTurnTargetV2;
  guidance?: string[];
  /**
   * Remaining Kernel tool-call admissions for this PlanAction drive. This is
   * Session control state and is never included in Provider context.
   */
  remainingToolCallBudget?: number;
}

/**
 * Bounded Session projection for one Provider turn. Canonical Kernel facts
 * remain complete in Session state; omission here only limits model context.
 */
export interface SessionProviderKernelFactsProjectionV2 {
  snapshotHighWater: number;
  omittedCount: number;
  facts: readonly KernelFactProjectionV2[];
}

export interface SessionProviderFactProjectionReceiptV2 {
  snapshotHighWater: number;
  omittedCount: number;
  factIds: string[];
}

export interface SessionProviderTurnInputV2 {
  providerTurnId: string;
  purpose: 'primary' | 'continuation' | 'finalAnswer';
  runId: string;
  controlEpoch: number;
  currentInput: SessionUserInputRecordV2;
  conversationInputs: readonly SessionUserInputRecordV2[];
  conversationInputOmittedCount: number;
  providerOutcomes: readonly SessionProviderOutcomeRecordV2[];
  providerOutcomeOmittedCount: number;
  sessionMemory: SessionContextMemoryV2;
  providerProfile: SessionProviderProfileBootstrapV2;
  plan?: SessionNaturalLanguagePlanV2;
  planDecision?: SessionPlanDecisionV2;
  review?: SessionKernelReviewV2;
  kernelFacts: SessionProviderKernelFactsProjectionV2;
  target: SessionProviderTurnTargetV2;
  guidance: string[];
  toolContext: {
    bundle: import('@deepcode/protocol').ToolContextBundleV2;
    contextRef: ToolContextRefV2;
    fixedPrompt: string;
    tools: readonly ToolDescriptorV2[];
  };
  contextAssembly: SessionProviderContextAssemblyV2;
  /**
   * Ephemeral safe-publication hook for Provider text deltas. The callback is
   * transport-only state and must never be persisted in a checkpoint, trace,
   * or Provider request.
   */
  publicTextObserver?: (delta: {
    providerTurnId: string;
    streamSequence: number;
    textOrdinal: number;
    providerPhase?: 'commentary';
    textDelta: string;
  }) => Promise<void>;
  /**
   * Ephemeral metadata-only hook for replaceable Provider activity. It never
   * carries reasoning text, raw upstream envelopes, or Provider arguments.
   */
  publicActivityObserver?: (activity: {
    providerTurnId: string;
    activitySequence: number;
    code: 'provider.reasoning' | 'provider.composing';
  }) => Promise<void>;
  signal: AbortSignal;
}

interface SessionProviderOutcomeRecordBaseV2 {
  providerTurnId: string;
  recordedAt: string;
  summary?: string;
  providerResult: SessionProviderResultMetadataV2;
}

/**
 * Session-owned relation between distinct tool operations. This relation is
 * descriptive only: it neither reuses Kernel invocation/attempt identity nor
 * grants authority.
 */
export interface SessionToolCorrectionV2 {
  retryGroupId: string;
  predecessorOperationId: string;
  retryOrdinal: number;
}

export interface SessionProviderToolRejectionV2 {
  reason: import('@deepcode/protocol').ToolIntentRejectionReasonV2;
  guidance: string;
  rejectionFactId: string;
}

/**
 * Safe, settled call identity retained with a Provider outcome. Raw arguments
 * remain only in the private queue/trace and are never copied here.
 */
export interface SessionProviderSettledToolCallV2 {
  ordinal: number;
  operationId: string;
  toolId: string;
  status: 'completed' | 'aborted' | 'unexecuted';
  invocationId?: string;
  terminalFactId?: string;
  terminalFactKind?: string;
  settlementReason?: string;
  rejection?: SessionProviderToolRejectionV2;
  correction?: SessionToolCorrectionV2;
}

export interface SessionProviderToolSettlementV2 {
  status: 'completed' | 'aborted';
  settledAt: string;
}

export type SessionProviderOutcomeRecordV2 =
  | (SessionProviderOutcomeRecordBaseV2 & {
      outputKind: 'toolIntent';
      toolCallReceipt: SessionProviderToolCallReceiptV2;
      toolSettlement: SessionProviderToolSettlementV2;
      toolCalls: SessionProviderSettledToolCallV2[];
    })
  | (SessionProviderOutcomeRecordBaseV2 & {
      outputKind: Exclude<
        SessionProviderTurnOutputV2['kind'],
        'toolIntent'
      >;
      toolCallReceipt?: never;
      toolSettlement?: never;
    });

export type SessionProviderTurnOutputV2 = (
  | {
      kind: 'plan';
      plan: SessionNaturalLanguagePlanV2;
    }
  | {
      kind: 'toolIntent';
      sources: ProviderKernelToolSourceV2[];
      receipt: SessionProviderToolCallReceiptV2;
    }
  | {
      kind: 'answer';
      text: string;
    }
  | {
      kind: 'noTool';
      guidance?: string;
      repair?: {
        kind: 'toolArguments';
        toolId: string;
        callOrdinal: number;
      };
    }
) & {
  items: SessionProviderOrderedItemV2[];
  completion: SessionProviderCompletionReceiptV1;
  providerResult: SessionProviderResultMetadataV2;
};

export type SessionActiveWaitV2 =
  | {
      kind: 'capability';
      operationId: string;
      invocationId: string;
      previewId: string;
      sinceHighWater: number;
      decisionHint?: 'allow' | 'deny';
      denialGuidance?: string;
    }
  | {
      kind: 'invocation';
      operationId: string;
      invocationId: string;
      sinceHighWater: number;
    }
  | {
      kind: 'backpressure';
      operationId: string;
      reason: 'runBusy' | 'capacityExceeded';
      retryAt: string;
      guidance: string;
    }
  | {
      kind: 'manualRecovery';
      operationId: string;
      invocationId?: string;
      reason: 'indeterminate';
      factIds: string[];
    };

type ContextRequestPayloadV2 = {
  knownContext?: ToolContextRefV2;
};
type PreviewRequestPayloadV2 = Omit<
  SessionKernelCapabilityPreviewRequestV2,
  'requestId' | 'signal'
>;
type IntentRequestPayloadV2 = Omit<
  SessionKernelToolIntentRequestV2,
  'requestId' | 'signal'
>;
type FactsRequestPayloadV2 = Omit<
  SessionKernelFactsRequestV2,
  'requestId' | 'signal'
>;
type EpochRequestPayloadV2 = Omit<
  SessionKernelEpochAdvanceRequestV2,
  'requestId' | 'signal'
>;
type CancelRequestPayloadV2 = Omit<
  SessionKernelInvocationCancelRequestV2,
  'requestId' | 'signal'
>;

export type SessionKernelPublicRequestIntentV2 =
  | { kind: 'toolContextGet'; payload: ContextRequestPayloadV2 }
  | { kind: 'capabilityPreview'; payload: PreviewRequestPayloadV2 }
  | { kind: 'toolIntentSubmit'; payload: IntentRequestPayloadV2 }
  | { kind: 'factsQuery'; payload: FactsRequestPayloadV2 }
  | { kind: 'controlEpochAdvance'; payload: EpochRequestPayloadV2 }
  | { kind: 'invocationCancel'; payload: CancelRequestPayloadV2 };

export type SessionKernelPublicRequestLaneV2 =
  | 'control'
  | 'effect'
  | 'query';

export interface SessionKernelPublicRequestRecordV2 {
  requestId: string;
  lane: SessionKernelPublicRequestLaneV2;
  intent: SessionKernelPublicRequestIntentV2;
  startedAt: string;
  attemptCount: number;
}

export interface SessionKernelFactBarrierV2 {
  requestId: string;
  source:
    | 'toolIntentSubmit'
    | 'controlEpochAdvance'
    | 'invocationCancel';
  minimumHighWater: number;
  requiredFactIds: string[];
  observedFactIds: string[];
}

export interface SessionOperationPlanActionBindingV2 {
  operationId: string;
  planActionId: string;
  planRevision: string;
  controlEpoch: number;
}

export interface SessionProviderTurnRecordV2 {
  providerTurnId: string;
  purpose: 'primary' | 'continuation' | 'finalAnswer';
  target: SessionProviderTurnTargetV2;
  /** Plan revision present in the Provider request context, if any. */
  planRevision?: string;
  /**
   * Exact remaining admission budget captured before dispatch. It is required
   * only for a PlanAction turn so a sealed multi-call response can be
   * deterministically admitted after Session restart.
   */
  remainingToolCallBudget?: number;
  /**
   * Durable Session-only candidate captured before the prior settled queue is
   * released. If this turn returns tools, only its first operation may consume
   * the relation.
   */
  correction?: SessionToolCorrectionV2;
  controlEpoch: number;
  contextRef: ToolContextRefV2;
  factProjection: SessionProviderFactProjectionReceiptV2;
  contextAssembly: SessionProviderContextReceiptV2;
  startedAt: string;
  status:
    | 'active'
    | 'awaitingTools'
    | 'cancelled'
    | 'completed'
    | 'aborted'
    | 'stale'
    | 'failed';
  cancellationReason?:
    | 'userInput'
    | 'runCancelled'
    | 'superseded'
    | 'shutdown';
  dispatchRef?: SessionKernelPersistenceRecordRefV3;
  terminalRef?: SessionKernelPersistenceRecordRefV3;
  response?: {
    items: SessionProviderOrderedItemV2[];
    completion: SessionProviderCompletionReceiptV1;
  };
}

export interface SessionRunCancellationV2 {
  callerRequestId: string;
  callerRequestDigest: string;
  cancelOperationId: string;
  requestedAt: string;
  status:
    | 'requested'
    | 'kernelSettled'
    | 'factsReconciled'
    | 'projected';
  invocationCancelRequestId?: string;
  cancellation?: InvocationCancelReplyV2;
  facts?: {
    afterLedgerSequence: number;
    snapshotHighWater: number;
    runSequenceHighWater: number;
    caughtUp: true;
    pendingFactBarrierCount: 0;
  };
  cancelledAt?: string;
  projection?: {
    projectionId: string;
    projectionDigest: string;
  };
}

export interface SessionReviewFactRefV2 {
  factId: string;
  ledgerSequence: number;
  domain: KernelFactProjectionV2['domain'];
  factKind: string;
  controlEpoch?: number;
  planActionIds: string[];
  sessionPlanActionId?: string;
  resourceIds: string[];
  operationId?: string;
  invocationId?: string;
  effectId?: string;
  details: KernelFactProjectionV2['details'];
}

export interface SessionReviewFactCategoryAccumulatorV2 {
  totalCount: number;
  samples: SessionReviewFactRefV2[];
}

export interface SessionReviewFactAccumulatorV2 {
  controlEpoch: number;
  coverageAfterLedgerSequence: number;
  scopeExpansions: SessionReviewFactCategoryAccumulatorV2;
  actualEffects: SessionReviewFactCategoryAccumulatorV2;
  denied: SessionReviewFactCategoryAccumulatorV2;
  rejections: SessionReviewFactCategoryAccumulatorV2;
  cleanup: SessionReviewFactCategoryAccumulatorV2;
  indeterminate: SessionReviewFactCategoryAccumulatorV2;
  priorEpochLateFacts: SessionReviewFactCategoryAccumulatorV2;
  observedEffectPlanActions: Record<
    string,
    Record<
      string,
      {
        factId: string;
        ledgerSequence: number;
        effectId?: string;
      }
    >
  >;
  authorizedOperationSequences: Record<string, number>;
  pendingCleanupByResource: Record<
    string,
    {
      factId: string;
      ledgerSequence: number;
      factKind: string;
    }
  >;
}

export interface SessionReviewPlannedActionV2 {
  taskId: string;
  planActionId: string;
  operationId: string;
  toolId: string;
}

export interface SessionKernelReviewV2 {
  projectionVersion: typeof SESSION_KERNEL_REVIEW_PROJECTION_V2;
  revision: number;
  status: 'draft' | 'final';
  workAuthority?: SessionWorkAuthorityV3;
  planRevision?: string;
  planDecision?: SessionPlanDecisionV2;
  plan?: {
    title: string;
    objective: string;
    narrative: string;
    recordedAt: string;
  };
  planActionSettlementDigest: string;
  snapshotHighWater: number;
  planned: SessionReviewPlannedActionV2[];
  scopeExpansions: SessionReviewFactRefV2[];
  actualEffects: SessionReviewFactRefV2[];
  unexecuted: SessionReviewPlannedActionV2[];
  denied: SessionReviewFactRefV2[];
  rejections: SessionReviewFactRefV2[];
  completions: SessionPlanActionSettlementV2[];
  cleanup: SessionReviewFactRefV2[];
  indeterminate: SessionReviewFactRefV2[];
  priorEpochLateFacts: SessionReviewFactRefV2[];
  factCoverage: {
    scopeExpansions: SessionReviewFactCoverageV2;
    actualEffects: SessionReviewFactCoverageV2;
    denied: SessionReviewFactCoverageV2;
    rejections: SessionReviewFactCoverageV2;
    cleanup: SessionReviewFactCoverageV2;
    indeterminate: SessionReviewFactCoverageV2;
    priorEpochLateFacts: SessionReviewFactCoverageV2;
  };
  factsQuery: {
    runId: string;
    controlEpoch: number;
    afterLedgerSequence: number;
    snapshotHighWater: number;
  };
  pendingCleanupCount: number;
  createdAt: string;
  finalizedAt?: string;
}

export interface SessionReviewFactCoverageV2 {
  totalCount: number;
  retainedCount: number;
  omittedCount: number;
}

export interface SessionPlanActionSettlementV2 {
  kind: 'completed';
  planActionId: string;
  completionKind: 'answer' | 'noTool';
  providerTurnId: string;
  recordedAt: string;
}

export interface SessionKernelProjectionEventV2 {
  /**
   * Projection sinks must apply this identity idempotently. The Loop can
   * replay a persisted Kernel request after losing its transport outcome.
   */
  projectionId: string;
  runId: string;
  recordedAt: string;
  kind:
    | 'plan.persisted'
    | 'plan.decided'
    | 'plan.commentaryReleased'
    | 'plan.confirmationReady'
    | 'input.persisted'
    | 'scope.previewed'
    | 'provider.started'
    | 'provider.composing'
    | 'provider.completed'
    | 'provider.stale'
    | 'toolIntent.submitted'
    | 'capability.awaiting'
    | 'kernelFacts.reconciled'
    | 'authorization.decided'
    | 'review.revised'
    | 'planAction.completed'
    | 'run.cancelled'
    | 'wait.changed'
    | 'diagnostic';
  data: unknown;
}

export type SessionKernelLoopResultV2 =
  | { kind: 'plan'; plan: SessionNaturalLanguagePlanV2 }
  | { kind: 'answer'; text: string }
  | { kind: 'noTool'; guidance?: string }
  | {
      kind: 'admitted';
      operationId: string;
      invocationId: string;
    }
  | {
      kind: 'awaitingCapability';
      operationId: string;
      invocationId: string;
      preview: CapabilityScopePreviewRecordV2;
    }
  | {
      kind: 'retryScheduled';
      operationId: string;
      retryAt: string;
    }
  | {
      kind: 'rejected';
      operationId: string;
      guidance: string;
    }
  | {
      kind: 'manualRecovery';
      operationId: string;
      invocationId?: string;
    }
  | {
      kind: 'finalAnswerFailed';
      errorCode: string;
      physicalRequestCount: number;
    }
  | { kind: 'staleProviderResult'; providerTurnId: string };
