import type {
  AgentInputAttachmentV2,
  LlmChatMessage,
  CapabilityScopePreviewRecordV2,
  DeadlineRequestV2,
  KernelFactProjectionV2,
  RawToolArgumentsV2,
  ScopeManifestV2,
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
  'deepcode.session.kernel-loop.v2' as const;
export const SESSION_KERNEL_CHECKPOINT_V2_SCHEMA =
  'deepcode.session.kernel-checkpoint.v2' as const;
export const SESSION_KERNEL_REVIEW_PROJECTION_V2 =
  'deepcode.session.kernel-review-projection.v2' as const;
export const SESSION_PROVIDER_PROFILE_BOOTSTRAP_V2_SCHEMA =
  'deepcode.host.provider-profile-bootstrap.v2' as const;
export const SESSION_PROVIDER_CONTEXT_RECEIPT_V2_SCHEMA =
  'deepcode.session.provider-context-receipt.v2' as const;

export interface SessionProviderProfileBootstrapV2 {
  schemaVersion: typeof SESSION_PROVIDER_PROFILE_BOOTSTRAP_V2_SCHEMA;
  providerProfileId: string;
  providerProfileRevisionDigest: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export type SessionProviderContextSectionV2 =
  | 'kernelFixedPrompt'
  | 'sessionContract'
  | 'currentInput'
  | 'priorSessionMemory'
  | 'planDecision'
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
  providerProfileId?: string;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown>;
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
    };

export interface SessionProviderTurnRequestV2 {
  reason:
    | 'planExecution'
    | 'userInput'
    | 'capabilityDenied'
    | 'retryGuidance'
    | 'recovery';
  target: SessionProviderTurnTargetV2;
  guidance?: string[];
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
  signal: AbortSignal;
}

export interface SessionProviderOutcomeRecordV2 {
  providerTurnId: string;
  outputKind: SessionProviderTurnOutputV2['kind'];
  recordedAt: string;
  summary?: string;
  providerResult: SessionProviderResultMetadataV2;
}

export type SessionProviderTurnOutputV2 =
  | {
      kind: 'plan';
      plan: SessionNaturalLanguagePlanV2;
      providerResult: SessionProviderResultMetadataV2;
    }
  | {
      kind: 'toolIntent';
      source: ProviderKernelToolSourceV2;
      providerResult: SessionProviderResultMetadataV2;
    }
  | {
      kind: 'answer';
      text: string;
      providerResult: SessionProviderResultMetadataV2;
    }
  | {
      kind: 'noTool';
      guidance?: string;
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
  controlEpoch: number;
  contextRef: ToolContextRefV2;
  factProjection: SessionProviderFactProjectionReceiptV2;
  contextAssembly: SessionProviderContextReceiptV2;
  startedAt: string;
  status: 'active' | 'cancelled' | 'completed' | 'stale' | 'failed';
  cancellationReason?: 'userInput' | 'superseded' | 'shutdown';
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
    | 'input.persisted'
    | 'scope.previewed'
    | 'provider.started'
    | 'provider.completed'
    | 'provider.stale'
    | 'toolIntent.submitted'
    | 'capability.awaiting'
    | 'kernelFacts.reconciled'
    | 'authorization.decided'
    | 'review.revised'
    | 'planAction.completed'
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
  | { kind: 'staleProviderResult'; providerTurnId: string };
