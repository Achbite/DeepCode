import type {
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

export interface SessionUserInputRecordV2 {
  inputId: string;
  opaqueInputRef: string;
  text: string;
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
  plan?: SessionNaturalLanguagePlanV2;
  kernelFacts: SessionProviderKernelFactsProjectionV2;
  target: SessionProviderTurnTargetV2;
  guidance: string[];
  toolContext: {
    contextRef: ToolContextRefV2;
    fixedPrompt: string;
    tools: readonly ToolDescriptorV2[];
  };
  signal: AbortSignal;
}

export type SessionProviderTurnOutputV2 =
  | {
      kind: 'plan';
      plan: SessionNaturalLanguagePlanV2;
    }
  | {
      kind: 'toolIntent';
      source: ProviderKernelToolSourceV2;
    }
  | {
      kind: 'answer';
      text: string;
    }
  | {
      kind: 'noTool';
      guidance?: string;
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

export interface SessionProviderTurnRecordV2 {
  providerTurnId: string;
  controlEpoch: number;
  contextRef: ToolContextRefV2;
  factProjection: SessionProviderFactProjectionReceiptV2;
  startedAt: string;
  status: 'active' | 'cancelled' | 'completed' | 'stale' | 'failed';
  cancellationReason?: 'userInput' | 'superseded' | 'shutdown';
}

export interface SessionReviewFactRefV2 {
  factId: string;
  ledgerSequence: number;
  domain: KernelFactProjectionV2['domain'];
  factKind: string;
  operationId?: string;
  invocationId?: string;
  effectId?: string;
}

export interface SessionReviewPlannedActionV2 {
  taskId: string;
  planActionId: string;
  operationId: string;
  toolId: string;
}

export interface SessionKernelReviewV2 {
  revision: number;
  status: 'draft' | 'final';
  planRevision?: string;
  snapshotHighWater: number;
  planned: SessionReviewPlannedActionV2[];
  scopeExpansions: SessionReviewFactRefV2[];
  actualEffects: SessionReviewFactRefV2[];
  unexecuted: SessionReviewPlannedActionV2[];
  denied: SessionReviewFactRefV2[];
  cleanup: SessionReviewFactRefV2[];
  indeterminate: SessionReviewFactRefV2[];
  createdAt: string;
  finalizedAt?: string;
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
    | 'input.persisted'
    | 'scope.previewed'
    | 'provider.started'
    | 'provider.completed'
    | 'provider.stale'
    | 'toolIntent.submitted'
    | 'capability.awaiting'
    | 'kernelFacts.reconciled'
    | 'review.revised'
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
