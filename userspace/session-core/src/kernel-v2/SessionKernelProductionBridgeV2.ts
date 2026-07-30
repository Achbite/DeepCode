import type {
  CapabilityScopePreviewReplyV2,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import type {
  SessionKernelTransportPrivateAuthV2,
} from './SessionKernelPortV2.js';
import {
  HttpKernelCommandTransportV2,
} from './SessionKernelPortV2.js';
import {
  decodeSessionKernelPrefetchedRunDescriptorV2,
  PrefetchedSessionKernelHostRunAdapterV2,
  type SessionKernelPrefetchedRunDescriptorV2,
} from './PrefetchedSessionKernelHostRunAdapterV2.js';
import {
  DurableSessionKernelProjectionV2,
  HttpSessionKernelAppendOnlyRecordStoreV2,
  SESSION_KERNEL_PERSISTENCE_V2_SCHEMA,
  SessionKernelAppendOnlyPersistenceV2,
} from './SessionKernelHttpPersistenceV2.js';
import {
  HttpSessionKernelHostProjectionSinkV2,
} from './SessionKernelHttpProjectionV2.js';
import {
  HttpSessionKernelLlmTransportV2,
  HttpSessionKernelProviderBackendV2,
  SessionKernelProviderTransportError,
} from './SessionKernelHttpProviderBackendV2.js';
import {
  SessionKernelProviderAdapterError,
  StrictSessionKernelProviderAdapterV2,
} from './SessionKernelProviderAdapterV2.js';
import {
  SessionKernelHostRunnerV2,
  type SessionPlanActionDriveStepV2,
} from './SessionKernelHostRunnerV2.js';
import {
  canFinalizeSessionKernelReviewV2,
  sessionKernelPlanActionSettledV2,
} from './review.js';
import {
  sessionKernelFactsCaughtUpV2,
} from './lineage.js';
import {
  sessionKernelFactBarriersPendingV2,
} from './factBarriers.js';
import {
  decodeAgentInputAttachmentsV2,
} from './inputAttachmentsV2.js';
import {
  buildSessionContextMemoryV2,
  decodeSessionPriorEventsSourceV2,
  type SessionPriorEventsSourceV2,
} from './sessionMemory.js';
import type {
  SessionKernelClockPortV2,
  SessionKernelIdFactoryPortV2,
} from './ports.js';
import type { SessionKernelLoopStateV2 } from './state.js';
import type {
  SessionActiveWaitV2,
  SessionKernelLoopResultV2,
  SessionKernelReviewV2,
  SessionPlanDecisionV2,
  SessionProviderProfileBootstrapV2,
  SessionUserInputRecordV2,
} from './types.js';
import {
  SESSION_PROVIDER_PROFILE_BOOTSTRAP_V2_SCHEMA,
} from './types.js';

export const SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA =
  'deepcode.session.kernel-production-request.v2' as const;
export const SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA =
  'deepcode.session.kernel-production-response.v2' as const;
export const SESSION_KERNEL_PRODUCTION_REQUEST_FRAME_V2_SCHEMA =
  'deepcode.session.kernel-production-request-frame.v2' as const;
export const SESSION_KERNEL_PRODUCTION_RESPONSE_FRAME_V2_SCHEMA =
  'deepcode.session.kernel-production-response-frame.v2' as const;

export const SESSION_KERNEL_PRODUCTION_MAX_FRAME_BYTES =
  4 * 1024 * 1024;
const SESSION_KERNEL_PRODUCTION_MAX_STORED_RESULT_BYTES =
  9 * 1024 * 1024;
const MAX_LIVE_OPERATION_RECEIPTS = 256;
const MAX_LIVE_OPERATION_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_OPERATION_TOMBSTONES = 4_096;
const UNHASHABLE_REQUEST_DIGEST =
  'sha256:unhashable-production-request';

export interface SessionKernelProductionInitialTurnV2 {
  kind: 'initialTurn';
  data: {
    guidance: string[];
  };
}

export interface SessionKernelProductionResumePlanActionV2 {
  kind: 'resumePlanAction';
  data: {
    planActionId: string;
    expectedPlanRevision: string;
    providerCallBudget: number;
    guidance: string[];
  };
}

export interface SessionKernelProductionUserInputV2 {
  kind: 'userInput';
  data: {
    input: SessionUserInputRecordV2;
    guidance: string[];
  };
}

export interface SessionKernelProductionReplanV2 {
  kind: 'replan';
  data: {
    expectedPlanRevision: string;
    guidance: string[];
  };
}

export interface SessionKernelProductionResumePlanningV2 {
  kind: 'resumePlanning';
  data: {
    guidance: string[];
  };
}

export interface SessionKernelProductionResumeAfterBackpressureV2 {
  kind: 'resumeAfterBackpressure';
  data: {
    operationId: string;
    retryAt: string;
    planActionId?: string;
    expectedPlanRevision?: string;
    guidance: string[];
  };
}

export interface SessionKernelProductionPreviewPlanActionV2 {
  kind: 'previewPlanAction';
  data: {
    planActionId: string;
    expectedPlanRevision: string;
  };
}

export interface SessionKernelProductionDecidePlanV2 {
  kind: 'decidePlan';
  data: {
    planRevision: string;
    decision: SessionPlanDecisionV2['decision'];
    guidance?: string;
  };
}

export interface SessionKernelProductionObserveCapabilityDecisionV2 {
  kind: 'observeCapabilityDecision';
  data: {
    decision: 'allow' | 'deny';
    guidance: string;
    previewId: string;
    operationId: string;
    invocationId: string;
    planActionId?: string;
    expectedPlanRevision?: string;
  };
}

export interface SessionKernelProductionReconcileWakeV2 {
  kind: 'reconcileWake';
  data: {
    waitKind: 'capability' | 'invocation';
    operationId: string;
    invocationId: string;
    previewId?: string;
    planActionId?: string;
    expectedPlanRevision?: string;
    guidance: string[];
  };
}

export interface SessionKernelProductionReconcileFactsV2 {
  kind: 'reconcileFacts';
  data: {
    observedHighWater: number;
  };
}

export interface SessionKernelProductionFinalizeReviewV2 {
  kind: 'finalizeReview';
  data: {
    expectedPlanRevision: string;
  };
}

export type SessionKernelProductionOperationV2 =
  | SessionKernelProductionInitialTurnV2
  | SessionKernelProductionResumePlanActionV2
  | SessionKernelProductionUserInputV2
  | SessionKernelProductionReplanV2
  | SessionKernelProductionResumePlanningV2
  | SessionKernelProductionResumeAfterBackpressureV2
  | SessionKernelProductionPreviewPlanActionV2
  | SessionKernelProductionDecidePlanV2
  | SessionKernelProductionObserveCapabilityDecisionV2
  | SessionKernelProductionReconcileWakeV2
  | SessionKernelProductionReconcileFactsV2
  | SessionKernelProductionFinalizeReviewV2;

/**
 * Exact safe JSON sent by the Rust Host over stdin. The run capability is
 * intentionally absent and must be supplied through the inherited private
 * process seam.
 */
export interface SessionKernelProductionRequestV2 {
  schemaVersion: typeof SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA;
  sessionId: string;
  hostRunId: string;
  runId: string;
  historySchema: typeof SESSION_KERNEL_PERSISTENCE_V2_SCHEMA;
  providerProfile: SessionProviderProfileBootstrapV2;
  priorSessionEvents: SessionPriorEventsSourceV2;
  prefetchedRun: SessionKernelPrefetchedRunDescriptorV2;
  initialInput: SessionUserInputRecordV2;
  operation: SessionKernelProductionOperationV2;
}

export interface SessionKernelProductionStateSummaryV2 {
  controlEpoch: number;
  currentInputId: string;
  planRevision?: string;
  planDecision?: SessionPlanDecisionV2;
  planConfirmation: {
    status:
      | 'none'
      | 'pending'
      | 'accepted'
      | 'rejected'
      | 'revisionRequested';
    planRevision?: string;
  };
  activeWait?: SessionActiveWaitV2;
  factsAfterLedgerSequence: number;
  factsSnapshotHighWater: number;
  factsRunSequenceHighWater: number;
  pendingRequestLanes: Array<'control' | 'effect' | 'query'>;
  reviewRevision?: number;
}

export type SessionKernelProductionOutcomeV2 =
  | {
      kind: 'initialTurnResult';
      result: SessionKernelLoopResultV2;
    }
  | {
      kind: 'userInputResult';
      result: SessionKernelLoopResultV2;
    }
  | {
      kind: 'userInputSuperseded';
      inputId: string;
    }
  | {
      kind: 'ordinaryOperationSuperseded';
      errorCode?: string;
    }
  | {
      kind: 'replanResult';
      result: SessionKernelLoopResultV2;
    }
  | {
      kind: 'resumePlanningResult';
      result?: SessionKernelLoopResultV2;
    }
  | {
      kind: 'backpressureResumeResult';
      result: SessionKernelLoopResultV2;
    }
  | {
      kind: 'resumePlanActionStep';
      step: SessionPlanActionDriveStepV2;
    }
  | {
      kind: 'planActionPreview';
      preview: CapabilityScopePreviewReplyV2;
    }
  | {
      kind: 'planDecisionRecorded';
      decision: SessionPlanDecisionV2;
    }
  | {
      kind: 'capabilityDecisionObserved';
      decision: 'allow' | 'deny';
      result?: SessionKernelLoopResultV2;
    }
  | {
      kind: 'factsReconciled';
      result?: SessionKernelLoopResultV2;
    }
  | {
      kind: 'reviewFinalized';
      review: SessionKernelReviewV2;
    };

export interface SessionKernelProductionStoredResultV2 {
  kind: 'resultStored';
  resultRef: string;
  originalOutcomeKind: SessionKernelProductionOutcomeV2['kind'];
  storage: 'sessionPersistenceRecord';
  recordId: string;
  recordDigest: string;
  resultDigest: string;
  readPath: string;
}

export type SessionKernelProductionContinuationV2 =
  | {
      kind: 'awaitingUserPlanConfirmation';
      planRevision: string;
    }
  | {
      kind: 'awaitingUserScopeDecision';
      previewId: string;
      disposition: 'autoIssuable' | 'requiresUserDecision';
      planActionId?: string;
      expectedPlanRevision?: string;
    }
  | {
      kind: 'awaitingKernelWake';
      waitKind: 'capabilityDecisionFact' | 'invocation';
      operationId: string;
      invocationId: string;
      planActionId?: string;
      expectedPlanRevision?: string;
    }
  | {
      kind: 'awaitingBackpressureDeadline';
      operationId: string;
      retryAt: string;
      planActionId?: string;
      expectedPlanRevision?: string;
    }
  | {
      kind: 'awaitingKernelFacts';
      observedHighWater: number;
    }
  | {
      kind: 'manualRecoveryRequired';
      operationId: string;
      invocationId?: string;
      planActionId?: string;
      expectedPlanRevision?: string;
    }
  | {
      kind: 'replanRequired';
      guidance: string[];
      expectedPlanRevision?: string;
    }
  | {
      kind: 'readyToResumePlanning';
      guidance: string[];
    }
  | {
      kind: 'readyToDrivePlanAction';
      planActionId: string;
      expectedPlanRevision: string;
    }
  | {
      kind: 'readyToPreviewPlanAction';
      planActionId: string;
      expectedPlanRevision: string;
    }
  | {
      kind: 'readyToFinalizeReview';
      expectedPlanRevision: string;
    }
  | {
      kind: 'recoveryRequired';
      pendingRequestLanes: Array<'control' | 'effect' | 'query'>;
    }
  | {
      kind: 'providerTurnSuperseded';
      operationGeneration: number;
      providerTurnId?: string;
    }
  | {
      kind: 'userInputSuperseded';
      inputId: string;
    }
  | {
      kind: 'providerBudgetExhausted';
      providerCallBudget: number;
      completedProviderCalls: number;
      planActionId: string;
      expectedPlanRevision: string;
    }
  | {
      kind: 'terminalProviderAnswer';
    }
  | {
      kind: 'terminalProviderStop';
    }
  | {
      kind: 'terminalReview';
      reviewRevision: number;
      snapshotHighWater: number;
    };

export interface SessionKernelProductionSuccessV2 {
  schemaVersion: typeof SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA;
  ok: true;
  sessionId: string;
  hostRunId: string;
  runId: string;
  operationGeneration: number;
  authorityGeneration: number;
  operationKind: SessionKernelProductionOperationV2['kind'];
  causalState: {
    controlEpoch: number;
    currentInputId: string;
    planRevision?: string;
  };
  state: SessionKernelProductionStateSummaryV2;
  outcome:
    | SessionKernelProductionOutcomeV2
    | SessionKernelProductionStoredResultV2;
  continuation: SessionKernelProductionContinuationV2;
}

export interface SessionKernelProductionFailureV2 {
  schemaVersion: typeof SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA;
  ok: false;
  error: {
    code: string;
    disposition:
      | 'correctRequest'
      | 'retrySameRequest'
      | 'queryFacts'
      | 'doNotRetry';
    commit: 'none' | 'committed' | 'unknown';
    effect: 'none' | 'possible' | 'observed';
    pendingRequestLanes: Array<'control' | 'effect' | 'query'>;
  };
}

export type SessionKernelProductionResponseV2 =
  | SessionKernelProductionSuccessV2
  | SessionKernelProductionFailureV2;

interface SessionKernelFailureBoundaryV2 {
  disposition:
    SessionKernelProductionFailureV2['error']['disposition'];
  commit: SessionKernelProductionFailureV2['error']['commit'];
  effect: SessionKernelProductionFailureV2['error']['effect'];
  pendingRequestLanes: Array<'control' | 'effect' | 'query'>;
}

export interface SessionKernelProductionRequestFrameV2 {
  schemaVersion:
    typeof SESSION_KERNEL_PRODUCTION_REQUEST_FRAME_V2_SCHEMA;
  operationRequestId: string;
  request: SessionKernelProductionRequestV2;
}

export interface SessionKernelProductionResponseFrameV2 {
  schemaVersion:
    typeof SESSION_KERNEL_PRODUCTION_RESPONSE_FRAME_V2_SCHEMA;
  operationRequestId: string;
  response: SessionKernelProductionResponseV2;
}

export interface SessionKernelProductionSettledFrameV2 {
  frame: SessionKernelProductionResponseFrameV2;
  encodedLine: string;
  byteLength: number;
}

interface SessionKernelProductionActorReceiptV2 {
  requestDigest: string;
  response: Promise<SessionKernelProductionSettledFrameV2>;
  settledByteLength: number;
  lastAccess: number;
}

interface SessionKernelProductionActiveOperationV2 {
  token: symbol;
  controller: AbortController;
  superseded: boolean;
  supersededProviderTurnId?: string;
}

interface SessionKernelProductionOperationContextV2 {
  operationGeneration: number;
  authorityGeneration: number;
  causalState: SessionKernelLoopStateV2;
  superseded: boolean;
  supersededProviderTurnId?: string;
}

/**
 * Strict v2 composition over semantic Kernel, persistence, Provider, and
 * projection ports. No compatibility or fallback path exists here.
 */
export class SessionKernelProductionActorV2 {
  private bootstrapDigest?: string;
  private runner?: Promise<SessionKernelHostRunnerV2>;
  private activeRunner?: SessionKernelHostRunnerV2;
  private ordinaryTail: Promise<void> = Promise.resolve();
  private inputTransitionTail: Promise<void> = Promise.resolve();
  private userInputDrain: Promise<void> = Promise.resolve();
  private activeOrdinary?: SessionKernelProductionActiveOperationV2;
  private operationSequence = 0;
  private authorityGeneration = 0;
  private accessSequence = 0;
  private liveReceiptBytes = 0;
  private readonly receipts = new Map<
    string,
    SessionKernelProductionActorReceiptV2
  >();
  // The Host SQLite operation journal is the durable replay/conflict source.
  // This private actor keeps only a bounded hot duplicate-detection window.
  private readonly tombstones = new Map<string, string>();

  constructor(
    private readonly privateAuth: SessionKernelTransportPrivateAuthV2,
    private readonly trustedApiBase: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  submitFrame(
    value: unknown
  ): Promise<SessionKernelProductionSettledFrameV2> {
    let frame: {
      operationRequestId: string;
      request: unknown;
    };
    try {
      frame = decodeProductionRequestFrameEnvelope(value);
    } catch (error) {
      const operationRequestId =
        correlatedOperationRequestId(value);
      if (!operationRequestId) throw error;
      return this.submitCorrelatedFailure(
        operationRequestId,
        safeRequestDigest(value),
        error,
        failureBoundary('correctRequest', 'none', 'none')
      );
    }
    const digest = safeRequestDigest(frame.request);
    const existing = this.receipts.get(frame.operationRequestId);
    if (existing) {
      existing.lastAccess = ++this.accessSequence;
      if (existing.requestDigest !== digest) {
        return Promise.resolve(settleResponseFrame(
          frame.operationRequestId,
          sessionKernelProductionFailureV2(
            new SessionKernelProductionBridgeError(
              'session_kernel_production_operation_request_conflict'
            ),
            failureBoundary('doNotRetry', 'none', 'none')
          )
        ));
      }
      return existing.response;
    }
    const tombstoneDigest = this.tombstones.get(
      frame.operationRequestId
    );
    if (tombstoneDigest) {
      return Promise.resolve(settleResponseFrame(
        frame.operationRequestId,
        sessionKernelProductionFailureV2(
          new SessionKernelProductionBridgeError(
            tombstoneDigest === digest
              ? 'session_kernel_production_operation_receipt_evicted'
              : 'session_kernel_production_operation_request_conflict'
          ),
          failureBoundary(
            tombstoneDigest === digest
              ? 'queryFacts'
              : 'doNotRetry',
            tombstoneDigest === digest ? 'unknown' : 'none',
            tombstoneDigest === digest ? 'possible' : 'none'
          )
        )
      ));
    }
    if (!this.liveReceiptAdmissionAvailable()) {
      return Promise.resolve(settleResponseFrame(
        frame.operationRequestId,
        sessionKernelProductionFailureV2(
          new SessionKernelProductionBridgeError(
            'session_kernel_production_operation_receipts_busy'
          ),
          failureBoundary('retrySameRequest', 'none', 'none')
        )
      ));
    }
    let request: SessionKernelProductionRequestV2;
    try {
      request = decodeSessionKernelProductionRequestV2(frame.request);
    } catch (error) {
      return this.storeReceipt(
        frame.operationRequestId,
        digest,
        Promise.resolve(settleResponseFrame(
          frame.operationRequestId,
          sessionKernelProductionFailureV2(
            error,
            failureBoundary('correctRequest', 'none', 'none')
          )
        ))
      );
    }
    try {
      this.requireActorIdentity(request);
    } catch (error) {
      return this.storeReceipt(
        frame.operationRequestId,
        digest,
        Promise.resolve(settleResponseFrame(
          frame.operationRequestId,
          sessionKernelProductionFailureV2(
            error,
            failureBoundary('correctRequest', 'none', 'none')
          )
        ))
      );
    }
    const operationGeneration = ++this.operationSequence;
    const authorityGeneration =
      this.authorityGeneration;
    let execution: Promise<SessionKernelProductionSuccessV2>;
    try {
      execution = this.schedule(request, {
        operationGeneration,
        authorityGeneration,
      });
    } catch (error) {
      execution = Promise.reject(error);
    }
    const response = execution
      .then((result) =>
        settleResponseFrameDurably(
          frame.operationRequestId,
          result,
          this.activeRunner
        )
      )
      .catch((error: unknown) =>
        settleResponseFrame(
          frame.operationRequestId,
          sessionKernelProductionFailureV2(
            error,
            failureBoundaryFromError(
              error,
              this.runnerSnapshot()
            )
          )
        )
      );
    return this.storeReceipt(
      frame.operationRequestId,
      digest,
      response
    );
  }

  private schedule(
    request: SessionKernelProductionRequestV2,
    generation: {
      operationGeneration: number;
      authorityGeneration: number;
    }
  ): Promise<SessionKernelProductionSuccessV2> {
    const runner = this.runnerFor(request);
    if (request.operation.kind === 'userInput') {
      return this.scheduleUserInput(
        runner,
        {
          ...request,
          operation: request.operation,
        },
        generation
      );
    }

    const admissionState = this.activeRunner
      ? Promise.resolve(this.activeRunner.snapshot())
      : runner.then((activeRunner) => activeRunner.snapshot());
    const predecessor = this.ordinaryTail;
    const execution = predecessor.then(async () => {
      await this.userInputDrain;
      const activeRunner = await runner;
      if (
        generation.authorityGeneration
          !== this.authorityGeneration
      ) {
        const causalState = await admissionState;
        return buildProductionSuccess(
          activeRunner,
          request,
          {
            operationGeneration:
              generation.operationGeneration,
            authorityGeneration:
              generation.authorityGeneration,
            causalState,
            superseded: true,
          },
          {
            kind: 'ordinaryOperationSuperseded',
            errorCode:
              'session_kernel_production_operation_authority_superseded',
          }
        );
      }
      const token = Symbol('productionOperation');
      const active: SessionKernelProductionActiveOperationV2 = {
        token,
        controller: new AbortController(),
        superseded: false,
      };
      this.activeOrdinary = active;
      const context: SessionKernelProductionOperationContextV2 = {
        operationGeneration: generation.operationGeneration,
        authorityGeneration: generation.authorityGeneration,
        causalState: activeRunner.snapshot(),
        superseded: false,
      };
      try {
        try {
          return await executeProductionRequestWithRunner(
            activeRunner,
            request,
            context,
            active.controller.signal,
            () => ({
              superseded: active.superseded,
              providerTurnId:
                active.supersededProviderTurnId,
            })
          );
        } catch (error) {
          if (!active.superseded) throw error;
          return buildProductionSuccess(
            activeRunner,
            request,
            {
              ...context,
              superseded: true,
              ...(active.supersededProviderTurnId
                ? {
                    supersededProviderTurnId:
                      active.supersededProviderTurnId,
                  }
                : {}),
            },
            {
              kind: 'ordinaryOperationSuperseded',
              errorCode: safeProductionErrorCode(error),
            }
          );
        }
      } finally {
        if (this.activeOrdinary?.token === token) {
          this.activeOrdinary = undefined;
        }
      }
    });
    this.ordinaryTail = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }

  private scheduleUserInput(
    runner: Promise<SessionKernelHostRunnerV2>,
    request: SessionKernelProductionRequestV2 & {
      operation: SessionKernelProductionUserInputV2;
    },
    generation: {
      operationGeneration: number;
      authorityGeneration: number;
    }
  ): Promise<SessionKernelProductionSuccessV2> {
    const predecessor = this.inputTransitionTail;
    const transition = predecessor.then(async () => {
      const activeRunner = await runner;
      const fenceGeneration =
        await activeRunner.persistUserInputBeforeFence(
          request.operation.data.input
        );
      const authorityGeneration = ++this.authorityGeneration;
      this.markActiveOrdinarySuperseded();
      this.ordinaryTail = Promise.resolve();
      await activeRunner.applyFencedUserInput(
        request.operation.data.input,
        fenceGeneration
      );
      return {
        activeRunner,
        fenceGeneration,
        authorityGeneration,
        causalState: activeRunner.snapshot(),
      };
    });
    this.inputTransitionTail = transition.then(
      () => undefined,
      () => undefined
    );
    const execution = transition.then(async (input) => {
      const context: SessionKernelProductionOperationContextV2 = {
        operationGeneration: generation.operationGeneration,
        authorityGeneration: input.authorityGeneration,
        causalState: input.causalState,
        superseded: false,
      };
      if (
        !input.activeRunner.isUserInputFenceCurrent(
          input.fenceGeneration
        )
      ) {
        return buildProductionSuccess(
          input.activeRunner,
          request,
          context,
          {
            kind: 'userInputSuperseded',
            inputId: request.operation.data.input.inputId,
          }
        );
      }
      const result =
        await input.activeRunner.runUserInputProviderTurn(
          request.operation.data.guidance
        );
      return buildProductionSuccess(
        input.activeRunner,
        request,
        context,
        {
          kind: 'userInputResult',
          result,
        }
      );
    });
    this.userInputDrain = transition.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }

  private markActiveOrdinarySuperseded(): void {
    const active = this.activeOrdinary;
    const turn = this.runnerSnapshot()?.providerTurn;
    if (!active) {
      return;
    }
    active.superseded = true;
    active.controller.abort('userInput');
    if (turn?.status === 'active') {
      active.supersededProviderTurnId = turn.providerTurnId;
    }
  }

  private runnerSnapshot(): SessionKernelLoopStateV2 | undefined {
    return this.activeRunner?.snapshot();
  }

  private requireActorIdentity(
    request: SessionKernelProductionRequestV2
  ): void {
    const digest = sha256Hash(
      productionBootstrapFingerprint(request)
    );
    if (
      this.bootstrapDigest !== undefined
      && this.bootstrapDigest !== digest
    ) {
      throw new SessionKernelProductionBridgeError(
        'session_kernel_production_actor_identity_mismatch'
      );
    }
  }

  private runnerFor(
    request: SessionKernelProductionRequestV2
  ): Promise<SessionKernelHostRunnerV2> {
    const digest = sha256Hash(
      productionBootstrapFingerprint(request)
    );
    if (!this.runner) {
      this.bootstrapDigest = digest;
      const creating = createProductionRunner(
        request,
        this.privateAuth,
        this.trustedApiBase,
        this.fetchImpl
      ).then((runner) => {
        this.activeRunner = runner;
        return runner;
      });
      const recoverable = creating.catch((error: unknown) => {
        if (this.runner === recoverable) {
          this.runner = undefined;
          this.activeRunner = undefined;
          this.bootstrapDigest = undefined;
        }
        throw error;
      });
      this.runner = recoverable;
      return recoverable;
    }
    if (this.bootstrapDigest !== digest) {
      throw new SessionKernelProductionBridgeError(
        'session_kernel_production_actor_identity_mismatch'
      );
    }
    return this.runner;
  }

  private submitCorrelatedFailure(
    operationRequestId: string,
    digest: string,
    error: unknown,
    boundary: SessionKernelFailureBoundaryV2
  ): Promise<SessionKernelProductionSettledFrameV2> {
    const existing = this.receipts.get(operationRequestId);
    if (existing) {
      existing.lastAccess = ++this.accessSequence;
      return existing.requestDigest === digest
        ? existing.response
        : Promise.resolve(settleResponseFrame(
            operationRequestId,
            sessionKernelProductionFailureV2(
              new SessionKernelProductionBridgeError(
                'session_kernel_production_operation_request_conflict'
              ),
              failureBoundary('doNotRetry', 'none', 'none')
            )
          ));
    }
    const tombstoneDigest = this.tombstones.get(operationRequestId);
    if (tombstoneDigest) {
      return Promise.resolve(settleResponseFrame(
        operationRequestId,
        sessionKernelProductionFailureV2(
          new SessionKernelProductionBridgeError(
            tombstoneDigest === digest
              ? 'session_kernel_production_operation_receipt_evicted'
              : 'session_kernel_production_operation_request_conflict'
          ),
          failureBoundary(
            tombstoneDigest === digest
              ? 'queryFacts'
              : 'doNotRetry',
            tombstoneDigest === digest ? 'unknown' : 'none',
            tombstoneDigest === digest ? 'possible' : 'none'
          )
        )
      ));
    }
    if (!this.liveReceiptAdmissionAvailable()) {
      return Promise.resolve(settleResponseFrame(
        operationRequestId,
        sessionKernelProductionFailureV2(
          new SessionKernelProductionBridgeError(
            'session_kernel_production_operation_receipts_busy'
          ),
          failureBoundary('retrySameRequest', 'none', 'none')
        )
      ));
    }
    return this.storeReceipt(
      operationRequestId,
      digest,
      Promise.resolve(settleResponseFrame(
        operationRequestId,
        sessionKernelProductionFailureV2(error, boundary)
      ))
    );
  }

  private storeReceipt(
    operationRequestId: string,
    digest: string,
    response: Promise<SessionKernelProductionSettledFrameV2>
  ): Promise<SessionKernelProductionSettledFrameV2> {
    const receipt: SessionKernelProductionActorReceiptV2 = {
      requestDigest: digest,
      response,
      settledByteLength: 0,
      lastAccess: ++this.accessSequence,
    };
    this.receipts.set(operationRequestId, receipt);
    void response.then((settled) => {
      if (this.receipts.get(operationRequestId) !== receipt) return;
      receipt.settledByteLength = settled.byteLength;
      this.liveReceiptBytes += settled.byteLength;
      this.enforceReceiptBudget();
    });
    this.enforceReceiptBudget();
    return response;
  }

  private enforceReceiptBudget(): void {
    while (
      this.receipts.size > MAX_LIVE_OPERATION_RECEIPTS
      || this.liveReceiptBytes > MAX_LIVE_OPERATION_RECEIPT_BYTES
    ) {
      const candidate = [...this.receipts.entries()]
        .filter(([, receipt]) => receipt.settledByteLength > 0)
        .sort(
          (left, right) =>
            left[1].lastAccess - right[1].lastAccess
        )[0];
      if (!candidate) return;
      const [operationRequestId, receipt] = candidate;
      this.receipts.delete(operationRequestId);
      this.liveReceiptBytes -= receipt.settledByteLength;
      this.tombstones.set(
        operationRequestId,
        receipt.requestDigest
      );
      while (this.tombstones.size > MAX_OPERATION_TOMBSTONES) {
        const oldest = this.tombstones.keys().next().value;
        if (typeof oldest !== 'string') break;
        this.tombstones.delete(oldest);
      }
    }
  }

  private liveReceiptAdmissionAvailable(): boolean {
    return this.receipts.size < MAX_LIVE_OPERATION_RECEIPTS
      || [...this.receipts.values()].some(
        (receipt) => receipt.settledByteLength > 0
      );
  }
}

async function createProductionRunner(
  request: SessionKernelProductionRequestV2,
  privateAuth: SessionKernelTransportPrivateAuthV2,
  trustedApiBase: string,
  fetchImpl: typeof fetch
): Promise<SessionKernelHostRunnerV2> {
  const transport = new HttpKernelCommandTransportV2({
    baseUrl: trustedApiBase,
    fetch: fetchImpl,
  });
  const runAdapter = new PrefetchedSessionKernelHostRunAdapterV2(
    request.prefetchedRun,
    privateAuth,
    transport
  );
  const recordStore = new HttpSessionKernelAppendOnlyRecordStoreV2(
    request.sessionId,
    request.runId,
    trustedApiBase,
    privateAuth,
    fetchImpl
  );
  const persistence = new SessionKernelAppendOnlyPersistenceV2(
    request.sessionId,
    request.runId,
    request.historySchema,
    recordStore
  );
  const projection = new DurableSessionKernelProjectionV2(
    persistence,
    new HttpSessionKernelHostProjectionSinkV2(
      request.sessionId,
      request.hostRunId,
      request.runId,
      request.priorSessionEvents,
      trustedApiBase,
      privateAuth,
      fetchImpl
    )
  );
  const clock = new SystemSessionKernelClockV2();
  const provider = new StrictSessionKernelProviderAdapterV2(
    new HttpSessionKernelProviderBackendV2(
      new HttpSessionKernelLlmTransportV2(
        trustedApiBase,
        privateAuth,
        request.sessionId,
        request.runId,
        fetchImpl
      ),
      request.providerProfile.providerProfileId
    ),
    clock
  );

  await projection.flushPending(request.runId);
  const runner = await SessionKernelHostRunnerV2.open(
    {
      workspaceBindingRef:
        request.prefetchedRun.workspaceBindingRef,
      initialInput: request.initialInput,
      sessionMemory: buildSessionContextMemoryV2({
        source: request.priorSessionEvents,
        excludeRunId: request.runId,
      }),
      providerProfile: request.providerProfile,
    },
    {
      runs: runAdapter,
      persistence,
      provider,
      projection,
      clock,
      ids: new RandomSessionKernelIdFactoryV2(),
    }
  );
  return runner;
}

async function executeProductionRequestWithRunner(
  runner: SessionKernelHostRunnerV2,
  request: SessionKernelProductionRequestV2,
  context: SessionKernelProductionOperationContextV2,
  signal: AbortSignal,
  supersededState: () => {
    superseded: boolean;
    providerTurnId?: string;
  }
): Promise<SessionKernelProductionSuccessV2> {
  const outcome = await executeProductionOperation(
    runner,
    request.operation,
    signal
  );
  const superseded = supersededState();
  return buildProductionSuccess(
    runner,
    request,
    {
      ...context,
      superseded: superseded.superseded,
      ...(superseded.providerTurnId
        ? {
            supersededProviderTurnId:
              superseded.providerTurnId,
          }
        : {}),
    },
    outcome
  );
}

function buildProductionSuccess(
  runner: SessionKernelHostRunnerV2,
  request: SessionKernelProductionRequestV2,
  context: SessionKernelProductionOperationContextV2,
  outcome: SessionKernelProductionOutcomeV2
): SessionKernelProductionSuccessV2 {
  const supersededProviderTurnId =
    context.supersededProviderTurnId
    ?? outcomeSupersededProviderTurnId(outcome);
  const responseIsSuperseded =
    context.superseded
    || Boolean(supersededProviderTurnId)
    || outcome.kind === 'ordinaryOperationSuperseded'
    || outcome.kind === 'userInputSuperseded';
  const state = responseIsSuperseded
    ? context.causalState
    : runner.snapshot();
  const response: SessionKernelProductionSuccessV2 = {
    schemaVersion: SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA,
    ok: true,
    sessionId: request.sessionId,
    hostRunId: request.hostRunId,
    runId: request.runId,
    operationGeneration: context.operationGeneration,
    authorityGeneration: context.authorityGeneration,
    operationKind: request.operation.kind,
    causalState: causalStateSummary(context.causalState),
    state: summarizeState(state),
    outcome,
    continuation: productionContinuation(
      state,
      context.causalState,
      request.operation,
      outcome,
      context
    ),
  };
  assertNoTransportCapabilities(response);
  return response;
}

async function executeProductionOperation(
  runner: SessionKernelHostRunnerV2,
  operation: SessionKernelProductionOperationV2,
  signal?: AbortSignal
): Promise<SessionKernelProductionOutcomeV2> {
  switch (operation.kind) {
    case 'initialTurn':
      return {
        kind: 'initialTurnResult',
        result: await runner.runInitialTurn(
          operation.data.guidance
        ),
      };
    case 'userInput':
      throw new SessionKernelProductionBridgeError(
        'session_kernel_production_user_input_actor_lane_required'
      );
    case 'replan':
      return {
        kind: 'replanResult',
        result: await runner.replan(operation.data),
      };
    case 'resumePlanning': {
      const result = await runner.resumePlanning(
        operation.data.guidance
      );
      return {
        kind: 'resumePlanningResult',
        ...(result ? { result } : {}),
      };
    }
    case 'resumeAfterBackpressure':
      return {
        kind: 'backpressureResumeResult',
        result: await runner.resumeAfterBackpressure(
          operation.data,
          signal
        ),
      };
    case 'resumePlanAction':
      requireProductionPlanRevision(
        runner.snapshot(),
        operation.data.expectedPlanRevision
      );
      return {
        kind: 'resumePlanActionStep',
        step: await runner.drivePlanActionStep(
          operation.data.planActionId,
          operation.data.expectedPlanRevision,
          {
            providerCallBudget:
              operation.data.providerCallBudget,
            guidance: operation.data.guidance,
          }
        ),
      };
    case 'previewPlanAction':
      requireProductionPlanRevision(
        runner.snapshot(),
        operation.data.expectedPlanRevision
      );
      return {
        kind: 'planActionPreview',
        preview: await runner.previewPlanAction(
          operation.data.planActionId,
          operation.data.expectedPlanRevision
        ),
      };
    case 'decidePlan':
      return {
        kind: 'planDecisionRecorded',
        decision: await runner.decidePlan(operation.data),
      };
    case 'observeCapabilityDecision': {
      const state = runner.snapshot();
      requireExactCapabilityWait(
        state,
        operation.data
      );
      const result = await runner.observeCapabilityDecision({
        decision: operation.data.decision,
        previewId: operation.data.previewId,
        operationId: operation.data.operationId,
        invocationId: operation.data.invocationId,
        ...(operation.data.planActionId
          ? { planActionId: operation.data.planActionId }
          : {}),
        ...(operation.data.expectedPlanRevision
          ? {
              expectedPlanRevision:
                operation.data.expectedPlanRevision,
            }
          : {}),
        ...(operation.data.decision === 'deny'
          ? {
              guidance: operation.data.guidance,
              replanAfterDeny: true,
            }
          : {}),
      });
      return {
        kind: 'capabilityDecisionObserved',
        decision: operation.data.decision,
        ...(result ? { result } : {}),
      };
    }
    case 'reconcileWake': {
      const state = runner.snapshot();
      requireExactWake(state, operation.data);
      const planningContextRead =
        !planActionForOperation(
          state,
          operation.data.operationId
        );
      if (planningContextRead) {
        const result =
          await runner.resumePlanningAfterContextRead(
            operation.data,
            operation.data.guidance
          );
        return {
          kind: 'factsReconciled',
          ...(result ? { result } : {}),
        };
      }
      await runner.notifyKernelWakeHint(operation.data);
      return { kind: 'factsReconciled' };
    }
    case 'reconcileFacts':
      await runner.reconcileFactsAfter(
        operation.data.observedHighWater
      );
      return { kind: 'factsReconciled' };
    case 'finalizeReview':
      requireProductionPlanRevision(
        runner.snapshot(),
        operation.data.expectedPlanRevision
      );
      return {
        kind: 'reviewFinalized',
        review: await runner.finalizeReview(
          operation.data.expectedPlanRevision
        ),
      };
  }
}

export function decodeSessionKernelProductionRequestFrameV2(
  value: unknown
): SessionKernelProductionRequestFrameV2 {
  const envelope = decodeProductionRequestFrameEnvelope(value);
  return {
    schemaVersion: SESSION_KERNEL_PRODUCTION_REQUEST_FRAME_V2_SCHEMA,
    operationRequestId: envelope.operationRequestId,
    request: decodeSessionKernelProductionRequestV2(envelope.request),
  };
}

function decodeProductionRequestFrameEnvelope(
  value: unknown
): {
  operationRequestId: string;
  request: unknown;
} {
  const record = exactObject(
    value,
    ['schemaVersion', 'operationRequestId', 'request']
  );
  if (
    record.schemaVersion
      !== SESSION_KERNEL_PRODUCTION_REQUEST_FRAME_V2_SCHEMA
  ) {
    throw invalidProductionRequest(
      'session_kernel_production_frame_schema_unsupported'
    );
  }
  return {
    operationRequestId: identity(
      record.operationRequestId,
      'operationRequestId'
    ),
    request: record.request,
  };
}

export function decodeSessionKernelProductionRequestV2(
  value: unknown
): SessionKernelProductionRequestV2 {
  const record = exactObject(
    value,
    [
      'schemaVersion',
      'sessionId',
      'hostRunId',
      'runId',
      'historySchema',
      'providerProfile',
      'priorSessionEvents',
      'prefetchedRun',
      'initialInput',
      'operation',
    ]
  );
  if (
    record.schemaVersion !== SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA
    || record.historySchema !== SESSION_KERNEL_PERSISTENCE_V2_SCHEMA
  ) {
    throw invalidProductionRequest(
      'session_kernel_production_schema_unsupported'
    );
  }
  const prefetchedRun =
    decodeSessionKernelPrefetchedRunDescriptorV2(
      record.prefetchedRun
    );
  const sessionId = identity(record.sessionId, 'sessionId');
  const hostRunId = identity(record.hostRunId, 'hostRunId');
  const runId = identity(record.runId, 'runId');
  const initialInput = decodeInitialInput(record.initialInput);
  const providerProfile = decodeProviderProfileBootstrapV2(
    record.providerProfile
  );
  const priorSessionEvents = decodeSessionPriorEventsSourceV2(
    record.priorSessionEvents
  );
  if (
    prefetchedRun.runOpenReply.runId !== runId
    || prefetchedRun.inputId !== initialInput.inputId
    || prefetchedRun.opaqueInputRef !== initialInput.opaqueInputRef
    || priorSessionEvents.sessionId !== sessionId
  ) {
    throw invalidProductionRequest(
      'session_kernel_production_run_identity_mismatch'
    );
  }
  assertNoTransportCapabilities(record);
  return {
    schemaVersion: SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA,
    sessionId,
    hostRunId,
    runId,
    historySchema: SESSION_KERNEL_PERSISTENCE_V2_SCHEMA,
    providerProfile,
    priorSessionEvents,
    prefetchedRun,
    initialInput,
    operation: decodeOperation(record.operation),
  };
}

function decodeProviderProfileBootstrapV2(
  value: unknown
): SessionProviderProfileBootstrapV2 {
  const record = exactObject(value, [
    'schemaVersion',
    'providerProfileId',
    'providerProfileRevisionDigest',
    'contextWindowTokens',
    'maxOutputTokens',
  ]);
  if (
    record.schemaVersion !== SESSION_PROVIDER_PROFILE_BOOTSTRAP_V2_SCHEMA
  ) {
    throw invalidProductionRequest(
      'session_kernel_provider_profile_schema_unsupported'
    );
  }
  const contextWindowTokens = positiveTokenLimit(
    record.contextWindowTokens,
    'contextWindowTokens'
  );
  const maxOutputTokens = positiveTokenLimit(
    record.maxOutputTokens,
    'maxOutputTokens'
  );
  if (maxOutputTokens >= contextWindowTokens) {
    throw invalidProductionRequest(
      'session_kernel_provider_profile_budget_invalid'
    );
  }
  return {
    schemaVersion: SESSION_PROVIDER_PROFILE_BOOTSTRAP_V2_SCHEMA,
    providerProfileId: identity(
      record.providerProfileId,
      'providerProfileId'
    ),
    providerProfileRevisionDigest: sha256Digest(
      record.providerProfileRevisionDigest,
      'providerProfileRevisionDigest'
    ),
    contextWindowTokens,
    maxOutputTokens,
  };
}

export function sessionKernelProductionFailureV2(
  error: unknown,
  boundary: SessionKernelFailureBoundaryV2 =
    failureBoundary('queryFacts', 'unknown', 'possible')
): SessionKernelProductionFailureV2 {
  const code = safeProductionErrorCode(error);
  return {
    schemaVersion: SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA,
    ok: false,
    error: {
      code,
      disposition: boundary.disposition,
      commit: boundary.commit,
      effect: boundary.effect,
      pendingRequestLanes: [...boundary.pendingRequestLanes],
    },
  };
}

function safeProductionErrorCode(error: unknown): string {
  const candidate =
    error && typeof error === 'object' && !Array.isArray(error)
      ? error as { code?: unknown }
      : undefined;
  const code = typeof candidate?.code === 'string'
    && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(candidate.code)
      ? candidate.code
      : 'session_kernel_production_failed';
  return code;
}

function decodeInitialInput(value: unknown): SessionUserInputRecordV2 {
  const record = exactObject(
    value,
    [
      'inputId',
      'opaqueInputRef',
      'text',
      'attachments',
      'recordedAt',
    ]
  );
  const recordedAt = boundedText(
    record.recordedAt,
    'recordedAt',
    1024
  );
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw invalidProductionRequest(
      'session_kernel_production_recorded_at_invalid'
    );
  }
  return {
    inputId: identity(record.inputId, 'inputId'),
    opaqueInputRef: boundedText(
      record.opaqueInputRef,
      'opaqueInputRef',
      64 * 1024
    ),
    text: boundedText(record.text, 'text', 1024 * 1024),
    attachments: decodeAgentInputAttachmentsV2(record.attachments),
    recordedAt,
  };
}

function decodeOperation(
  value: unknown
): SessionKernelProductionOperationV2 {
  const tagged = exactObject(value, ['kind', 'data']);
  const data = tagged.data;
  if (tagged.kind === 'initialTurn') {
    const body = exactObject(data, ['guidance']);
    return {
      kind: tagged.kind,
      data: { guidance: decodeGuidance(body.guidance) },
    };
  }
  if (tagged.kind === 'userInput') {
    const body = exactObject(data, ['input', 'guidance']);
    return {
      kind: tagged.kind,
      data: {
        input: decodeInitialInput(body.input),
        guidance: decodeGuidance(body.guidance),
      },
    };
  }
  if (tagged.kind === 'resumePlanAction') {
    const body = exactObject(
      data,
      [
        'planActionId',
        'expectedPlanRevision',
        'providerCallBudget',
        'guidance',
      ]
    );
    if (
      !Number.isSafeInteger(body.providerCallBudget)
      || Number(body.providerCallBudget) < 1
      || Number(body.providerCallBudget) > 256
    ) {
      throw invalidProductionRequest(
        'session_kernel_production_resume_options_invalid'
      );
    }
    return {
      kind: tagged.kind,
      data: {
        planActionId: identity(
          body.planActionId,
          'planActionId'
        ),
        expectedPlanRevision: identity(
          body.expectedPlanRevision,
          'expectedPlanRevision'
        ),
        providerCallBudget: Number(body.providerCallBudget),
        guidance: decodeGuidance(body.guidance),
      },
    };
  }
  if (tagged.kind === 'replan') {
    const body = exactObject(
      data,
      ['expectedPlanRevision', 'guidance']
    );
    return {
      kind: tagged.kind,
      data: {
        expectedPlanRevision: identity(
          body.expectedPlanRevision,
          'expectedPlanRevision'
        ),
        guidance: decodeGuidance(body.guidance),
      },
    };
  }
  if (tagged.kind === 'resumePlanning') {
    const body = exactObject(data, ['guidance']);
    return {
      kind: tagged.kind,
      data: {
        guidance: decodeGuidance(body.guidance),
      },
    };
  }
  if (tagged.kind === 'resumeAfterBackpressure') {
    const body = exactObject(
      data,
      [
        'operationId',
        'retryAt',
        'guidance',
      ],
      ['planActionId', 'expectedPlanRevision']
    );
    const retryAt = boundedText(body.retryAt, 'retryAt', 1024);
    if (!Number.isFinite(Date.parse(retryAt))) {
      throw invalidProductionRequest(
        'session_kernel_production_retry_at_invalid'
      );
    }
    return {
      kind: tagged.kind,
      data: {
        operationId: identity(body.operationId, 'operationId'),
        retryAt,
        guidance: decodeGuidance(body.guidance),
        ...decodeOptionalPlanActionBinding(body),
      },
    };
  }
  if (tagged.kind === 'previewPlanAction') {
    const body = exactObject(
      data,
      ['planActionId', 'expectedPlanRevision']
    );
    return {
      kind: tagged.kind,
      data: {
        planActionId: identity(
          body.planActionId,
          'planActionId'
        ),
        expectedPlanRevision: identity(
          body.expectedPlanRevision,
          'expectedPlanRevision'
        ),
      },
    };
  }
  if (tagged.kind === 'decidePlan') {
    const body = exactObject(
      data,
      ['planRevision', 'decision'],
      ['guidance']
    );
    if (
      body.decision !== 'accept'
      && body.decision !== 'reject'
      && body.decision !== 'revise'
    ) {
      throw invalidProductionRequest(
        'session_kernel_production_plan_decision_invalid'
      );
    }
    const guidance = body.guidance === undefined
      ? undefined
      : optionalText(body.guidance, 'guidance', 64 * 1024);
    if (
      (guidance !== undefined && guidance.trim() !== guidance)
      || (
        body.decision !== 'accept'
        && !guidance?.trim()
      )
    ) {
      throw invalidProductionRequest(
        'session_kernel_production_plan_guidance_invalid'
      );
    }
    return {
      kind: tagged.kind,
      data: {
        planRevision: identity(body.planRevision, 'planRevision'),
        decision: body.decision,
        ...(guidance !== undefined ? { guidance } : {}),
      },
    };
  }
  if (tagged.kind === 'observeCapabilityDecision') {
    const body = exactObject(
      data,
      [
        'decision',
        'guidance',
        'previewId',
        'operationId',
        'invocationId',
      ],
      ['planActionId', 'expectedPlanRevision']
    );
    if (body.decision !== 'allow' && body.decision !== 'deny') {
      throw invalidProductionRequest(
        'session_kernel_production_decision_invalid'
      );
    }
    const guidance = optionalText(
      body.guidance,
      'guidance',
      64 * 1024
    );
    if (body.decision === 'deny' && !guidance.trim()) {
      throw invalidProductionRequest(
        'session_kernel_production_denial_guidance_missing'
      );
    }
    return {
      kind: tagged.kind,
      data: {
        decision: body.decision,
        guidance,
        previewId: identity(body.previewId, 'previewId'),
        operationId: identity(body.operationId, 'operationId'),
        invocationId: identity(
          body.invocationId,
          'invocationId'
        ),
        ...decodeOptionalPlanActionBinding(body),
      },
    };
  }
  if (tagged.kind === 'reconcileWake') {
    const body = exactObject(
      data,
      [
        'waitKind',
        'operationId',
        'invocationId',
        'guidance',
      ],
      [
        'previewId',
        'planActionId',
        'expectedPlanRevision',
      ]
    );
    if (
      body.waitKind !== 'capability'
      && body.waitKind !== 'invocation'
    ) {
      throw invalidProductionRequest(
        'session_kernel_production_wake_kind_invalid'
      );
    }
    if (
      body.waitKind === 'capability'
      && body.previewId === undefined
    ) {
      throw invalidProductionRequest(
        'session_kernel_production_wake_preview_missing'
      );
    }
    if (
      body.waitKind === 'invocation'
      && body.previewId !== undefined
    ) {
      throw invalidProductionRequest(
        'session_kernel_production_wake_preview_unexpected'
      );
    }
    return {
      kind: tagged.kind,
      data: {
        waitKind: body.waitKind,
        operationId: identity(body.operationId, 'operationId'),
        invocationId: identity(
          body.invocationId,
          'invocationId'
        ),
        ...(body.previewId !== undefined
          ? {
              previewId: identity(
                body.previewId,
                'previewId'
              ),
            }
          : {}),
        ...decodeOptionalPlanActionBinding(body),
        guidance: decodeGuidance(body.guidance),
      },
    };
  }
  if (tagged.kind === 'reconcileFacts') {
    const body = exactObject(data, ['observedHighWater']);
    if (
      !Number.isSafeInteger(body.observedHighWater)
      || Number(body.observedHighWater) < 0
    ) {
      throw invalidProductionRequest(
        'session_kernel_production_facts_high_water_invalid'
      );
    }
    return {
      kind: tagged.kind,
      data: {
        observedHighWater: Number(body.observedHighWater),
      },
    };
  }
  if (tagged.kind === 'finalizeReview') {
    const body = exactObject(data, ['expectedPlanRevision']);
    return {
      kind: tagged.kind,
      data: {
        expectedPlanRevision: identity(
          body.expectedPlanRevision,
          'expectedPlanRevision'
        ),
      },
    };
  }
  throw invalidProductionRequest(
    'session_kernel_production_operation_unsupported'
  );
}

function decodeGuidance(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw invalidProductionRequest(
      'session_kernel_production_guidance_invalid'
    );
  }
  return value.map((entry) =>
    boundedText(entry, 'guidance', 64 * 1024)
  );
}

function decodeOptionalPlanActionBinding(
  record: Record<string, unknown>
): {
  planActionId?: string;
  expectedPlanRevision?: string;
} {
  const hasPlanAction = record.planActionId !== undefined;
  const hasRevision = record.expectedPlanRevision !== undefined;
  if (hasPlanAction !== hasRevision) {
    throw invalidProductionRequest(
      'session_kernel_production_plan_action_binding_incomplete'
    );
  }
  return hasPlanAction
    ? {
        planActionId: identity(
          record.planActionId,
          'planActionId'
        ),
        expectedPlanRevision: identity(
          record.expectedPlanRevision,
          'expectedPlanRevision'
        ),
      }
    : {};
}

function summarizeState(
  state: SessionKernelLoopStateV2
): SessionKernelProductionStateSummaryV2 {
  return {
    controlEpoch: state.controlEpoch,
    currentInputId: state.currentInputId,
    ...(state.plan
      ? { planRevision: state.plan.planRevision }
      : {}),
    ...(state.planDecision
      ? { planDecision: cloneJson(state.planDecision) }
      : {}),
    planConfirmation: summarizePlanConfirmation(state),
    ...(state.activeWait
      ? { activeWait: cloneJson(state.activeWait) }
      : {}),
    factsAfterLedgerSequence:
      state.lineage.cursor.afterLedgerSequence,
    factsSnapshotHighWater:
      state.lineage.cursor.snapshotHighWater,
    factsRunSequenceHighWater: state.lineage.factCount,
    pendingRequestLanes: (
      Object.keys(state.publicRequests) as Array<
        'control' | 'effect' | 'query'
      >
    ).sort(),
    ...(state.review
      ? { reviewRevision: state.review.revision }
      : {}),
  };
}

function productionContinuation(
  state: SessionKernelLoopStateV2,
  previousState: SessionKernelLoopStateV2,
  operation: SessionKernelProductionOperationV2,
  outcome: SessionKernelProductionOutcomeV2,
  context: SessionKernelProductionOperationContextV2
): SessionKernelProductionContinuationV2 {
  const staleProviderTurnId = context.supersededProviderTurnId
    ?? outcomeSupersededProviderTurnId(outcome);
  if (
    context.superseded
    || staleProviderTurnId
    || outcome.kind === 'ordinaryOperationSuperseded'
  ) {
    return {
      kind: 'providerTurnSuperseded',
      operationGeneration: context.operationGeneration,
      ...(staleProviderTurnId
        ? { providerTurnId: staleProviderTurnId }
        : {}),
    };
  }
  if (outcome.kind === 'userInputSuperseded') {
    return {
      kind: 'userInputSuperseded',
      inputId: outcome.inputId,
    };
  }
  const planAction = planActionContinuationContext(
    state,
    previousState,
    operation
  );
  const pendingRequestLanes = (
    Object.keys(state.publicRequests) as Array<
      'control' | 'effect' | 'query'
    >
  ).sort();
  if (pendingRequestLanes.length > 0) {
    return {
      kind: 'recoveryRequired',
      pendingRequestLanes,
    };
  }
  const waitContinuation = state.activeWait
    ? continuationForWait(state, state.activeWait, planAction)
    : undefined;
  if (waitContinuation) return waitContinuation;
  if (!sessionKernelFactsAreReady(state)) {
    return awaitingKernelFacts(state);
  }
  if (state.pendingGuidance.length > 0) {
    return state.plan
      ? {
          kind: 'replanRequired',
          guidance: [...state.pendingGuidance],
          expectedPlanRevision: state.plan.planRevision,
        }
      : readyToResumePlanning(state.pendingGuidance);
  }
  if (
    outcome.kind === 'replanResult'
    && outcome.result.kind !== 'plan'
  ) {
    return continuationForLoopResult(
      outcome.result,
      state,
      planAction
    );
  }
  if (
    state.plan
    && (
      state.planDecision?.planRevision !== state.plan.planRevision
      || state.planDecision.decision !== 'accept'
    )
  ) {
    const unpreviewed = firstUnpreviewedPlanAction(state);
    if (unpreviewed) {
      return readyToPreviewPlanAction(unpreviewed);
    }
    return {
      kind: 'awaitingUserPlanConfirmation',
      planRevision: state.plan.planRevision,
    };
  }
  if (
    state.plan
    && state.planDecision?.planRevision === state.plan.planRevision
    && state.planDecision.decision === 'accept'
    && (
      (
        outcome.kind === 'initialTurnResult'
        || outcome.kind === 'userInputResult'
        || outcome.kind === 'replanResult'
      )
      && outcome.result.kind === 'plan'
    )
  ) {
    return readyForPlanAction(state, planAction);
  }
  switch (outcome.kind) {
    case 'initialTurnResult':
    case 'userInputResult':
    case 'replanResult':
    case 'backpressureResumeResult':
      return continuationForLoopResult(
        outcome.result,
        state,
        planAction
      );
    case 'resumePlanningResult':
      return outcome.result
        ? continuationForLoopResult(
            outcome.result,
            state,
            planAction
          )
        : readyToResumePlanning();
    case 'resumePlanActionStep':
      return continuationForDriveStep(
        outcome.step,
        state,
        planAction
      );
    case 'planActionPreview':
      if (outcome.preview.kind === 'rejected') {
        return {
          kind: 'replanRequired',
          guidance: [outcome.preview.data.guidance],
          ...planRevisionField(state),
        };
      }
      {
        const unpreviewed = firstUnpreviewedPlanAction(state);
        if (unpreviewed) {
          return readyToPreviewPlanAction(unpreviewed);
        }
        if (
          state.planDecision?.planRevision
            !== state.plan?.planRevision
          || state.planDecision?.decision !== 'accept'
        ) {
          return {
            kind: 'awaitingUserPlanConfirmation',
            planRevision: requiredCurrentPlanRevision(state),
          };
        }
        return readyForPlanAction(state, planAction);
      }
    case 'planDecisionRecorded':
      return outcome.decision.decision === 'accept'
        ? readyForPlanAction(state, planAction)
        : {
            kind: 'replanRequired',
            guidance: outcome.decision.guidance
              ? [outcome.decision.guidance]
              : [],
            ...planRevisionField(state),
          };
    case 'capabilityDecisionObserved':
      return outcome.result
        ? continuationForLoopResult(
            outcome.result,
            state,
            planAction
          )
        : readyToDriveOrFinalize(state, planAction);
    case 'factsReconciled':
      return outcome.result
        ? continuationForLoopResult(
            outcome.result,
            state,
            planAction
          )
        : readyToDriveOrFinalize(state, planAction);
    case 'reviewFinalized':
      return {
        kind: 'terminalReview',
        reviewRevision: outcome.review.revision,
        snapshotHighWater: outcome.review.snapshotHighWater,
      };
  }
}

function summarizePlanConfirmation(
  state: SessionKernelLoopStateV2
): SessionKernelProductionStateSummaryV2['planConfirmation'] {
  if (!state.plan) return { status: 'none' };
  if (
    !state.planDecision
    || state.planDecision.planRevision !== state.plan.planRevision
  ) {
    return {
      status: 'pending',
      planRevision: state.plan.planRevision,
    };
  }
  return {
    status: state.planDecision.decision === 'accept'
      ? 'accepted'
      : state.planDecision.decision === 'reject'
        ? 'rejected'
        : 'revisionRequested',
    planRevision: state.plan.planRevision,
  };
}

function continuationForWait(
  state: SessionKernelLoopStateV2,
  wait: SessionActiveWaitV2,
  fallbackPlanAction?: PlanActionContinuationContextV2
): SessionKernelProductionContinuationV2 {
  const planAction = planActionForOperation(
    state,
    wait.operationId
  ) ?? fallbackPlanAction;
  switch (wait.kind) {
    case 'capability': {
      if (wait.decisionHint) {
        return {
          kind: 'awaitingKernelWake',
          waitKind: 'capabilityDecisionFact',
          operationId: wait.operationId,
          invocationId: wait.invocationId,
          ...planActionFields(planAction),
        };
      }
      const preview = Object.values(state.previews).find(
        (candidate) => candidate.previewId === wait.previewId
      );
      return {
        kind: 'awaitingUserScopeDecision',
        previewId: wait.previewId,
        disposition:
          preview?.disposition ?? 'requiresUserDecision',
        ...planActionFields(planAction),
      };
    }
    case 'invocation':
      return {
        kind: 'awaitingKernelWake',
        waitKind: 'invocation',
        operationId: wait.operationId,
        invocationId: wait.invocationId,
        ...planActionFields(planAction),
      };
    case 'backpressure':
      return {
        kind: 'awaitingBackpressureDeadline',
        operationId: wait.operationId,
        retryAt: wait.retryAt,
        ...planActionFields(planAction),
      };
    case 'manualRecovery':
      return {
        kind: 'manualRecoveryRequired',
        operationId: wait.operationId,
        ...(wait.invocationId
          ? { invocationId: wait.invocationId }
          : {}),
        ...planActionFields(planAction),
      };
  }
}

function continuationForLoopResult(
  result: SessionKernelLoopResultV2,
  state: SessionKernelLoopStateV2,
  planAction?: PlanActionContinuationContextV2
): SessionKernelProductionContinuationV2 {
  switch (result.kind) {
    case 'plan':
      return {
        kind: 'awaitingUserPlanConfirmation',
        planRevision: result.plan.planRevision,
      };
    case 'answer':
      return { kind: 'terminalProviderAnswer' };
    case 'noTool':
      return { kind: 'terminalProviderStop' };
    case 'admitted':
      {
        const context =
          planActionForOperation(state, result.operationId)
          ?? planAction;
        return context
          ? readyForPlanAction(state, context)
          : readyToResumePlanning();
      }
    case 'awaitingCapability':
      return {
        kind: 'awaitingUserScopeDecision',
        previewId: result.preview.previewId,
        disposition: result.preview.disposition,
        ...planActionFields(
          planActionForOperation(state, result.operationId)
            ?? planAction
        ),
      };
    case 'retryScheduled':
      return {
        kind: 'awaitingBackpressureDeadline',
        operationId: result.operationId,
        retryAt: result.retryAt,
        ...planActionFields(
          planActionForOperation(state, result.operationId)
            ?? planAction
        ),
      };
    case 'rejected':
      return (
        planActionForOperation(state, result.operationId)
        ?? planAction
      )
        ? {
            kind: 'replanRequired',
            guidance: [result.guidance],
            ...planRevisionField(state),
          }
        : readyToResumePlanning([result.guidance]);
    case 'manualRecovery':
      return {
        kind: 'manualRecoveryRequired',
        operationId: result.operationId,
        ...(result.invocationId
          ? { invocationId: result.invocationId }
          : {}),
        ...planActionFields(
          planActionForOperation(state, result.operationId)
            ?? planAction
        ),
      };
    case 'staleProviderResult':
      throw new SessionKernelProductionBridgeError(
        'session_kernel_production_stale_continuation_unbound'
      );
  }
}

function continuationForDriveStep(
  step: SessionPlanActionDriveStepV2,
  state: SessionKernelLoopStateV2,
  planAction?: PlanActionContinuationContextV2
): SessionKernelProductionContinuationV2 {
  switch (step.kind) {
    case 'providerResult':
      return readyToDriveOrFinalize(state, planAction);
    case 'waiting':
      return continuationForStandaloneWait(
        step.wait,
        state,
        planAction
      );
    case 'replanRequired':
      return {
        kind: 'replanRequired',
        guidance: [...step.guidance],
        ...planRevisionField(state),
      };
    case 'budgetExhausted':
      return {
        kind: 'providerBudgetExhausted',
        providerCallBudget: step.providerCallBudget,
        completedProviderCalls: step.completedProviderCalls,
        ...requiredPlanActionFields(planAction),
      };
    case 'interrupted':
      throw new SessionKernelProductionBridgeError(
        'session_kernel_production_stale_continuation_unbound'
      );
  }
}

function continuationForStandaloneWait(
  wait: SessionActiveWaitV2,
  state: SessionKernelLoopStateV2,
  fallbackPlanAction?: PlanActionContinuationContextV2
): SessionKernelProductionContinuationV2 {
  const planAction = planActionForOperation(
    state,
    wait.operationId
  ) ?? fallbackPlanAction;
  if (wait.kind === 'capability') {
    return wait.decisionHint
      ? {
          kind: 'awaitingKernelWake',
          waitKind: 'capabilityDecisionFact',
          operationId: wait.operationId,
          invocationId: wait.invocationId,
          ...planActionFields(planAction),
        }
      : {
          kind: 'awaitingUserScopeDecision',
          previewId: wait.previewId,
          disposition: 'requiresUserDecision',
          ...planActionFields(planAction),
        };
  }
  if (wait.kind === 'invocation') {
    return {
      kind: 'awaitingKernelWake',
      waitKind: 'invocation',
      operationId: wait.operationId,
      invocationId: wait.invocationId,
      ...planActionFields(planAction),
    };
  }
  if (wait.kind === 'backpressure') {
    return {
      kind: 'awaitingBackpressureDeadline',
      operationId: wait.operationId,
      retryAt: wait.retryAt,
      ...planActionFields(planAction),
    };
  }
  return {
    kind: 'manualRecoveryRequired',
    operationId: wait.operationId,
    ...(wait.invocationId
      ? { invocationId: wait.invocationId }
      : {}),
    ...planActionFields(planAction),
  };
}

interface PlanActionContinuationContextV2 {
  planActionId: string;
  expectedPlanRevision: string;
}

function outcomeSupersededProviderTurnId(
  outcome: SessionKernelProductionOutcomeV2
): string | undefined {
  if (
    outcome.kind === 'initialTurnResult'
    || outcome.kind === 'userInputResult'
    || outcome.kind === 'replanResult'
    || outcome.kind === 'backpressureResumeResult'
  ) {
    return outcome.result.kind === 'staleProviderResult'
      ? outcome.result.providerTurnId
      : undefined;
  }
  if (outcome.kind === 'resumePlanningResult') {
    return outcome.result?.kind === 'staleProviderResult'
      ? outcome.result.providerTurnId
      : undefined;
  }
  if (outcome.kind === 'resumePlanActionStep') {
    return outcome.step.kind === 'interrupted'
      ? outcome.step.result.providerTurnId
      : undefined;
  }
  if (
    outcome.kind === 'capabilityDecisionObserved'
    || outcome.kind === 'factsReconciled'
  ) {
    return outcome.result?.kind === 'staleProviderResult'
      ? outcome.result.providerTurnId
      : undefined;
  }
  return undefined;
}

function planActionContinuationContext(
  state: SessionKernelLoopStateV2,
  previousState: SessionKernelLoopStateV2,
  operation: SessionKernelProductionOperationV2
): PlanActionContinuationContextV2 | undefined {
  const operationPlanActionId =
    operation.kind === 'resumePlanAction'
    || operation.kind === 'previewPlanAction'
      ? operation.data.planActionId
      : operation.kind === 'resumeAfterBackpressure'
        ? operation.data.planActionId
        : undefined;
  if (operationPlanActionId) {
    const current = planActionById(
      state,
      operationPlanActionId
    );
    if (
      current
      && !sessionKernelPlanActionSettledV2(
        state,
        current.planActionId
      )
    ) {
      return current;
    }
  }
  const currentWait = state.activeWait
    ? planActionForOperation(state, state.activeWait.operationId)
    : undefined;
  if (currentWait) return currentWait;
  const previousWait = previousState.activeWait
    ? planActionForOperation(
        previousState,
        previousState.activeWait.operationId
      )
    : undefined;
  if (previousWait) {
    const current = planActionById(state, previousWait.planActionId);
    if (
      current
      && !sessionKernelPlanActionSettledV2(
        state,
        current.planActionId
      )
    ) {
      return current;
    }
  }
  const firstUnsettled = state.plan?.actions.find(
    (action) =>
      !sessionKernelPlanActionSettledV2(
        state,
        action.manifest.planActionId
      )
  );
  return firstUnsettled
    ? planActionById(
        state,
        firstUnsettled.manifest.planActionId
      )
    : undefined;
}

function planActionForOperation(
  state: SessionKernelLoopStateV2,
  operationId: string
): PlanActionContinuationContextV2 | undefined {
  const planActionId =
    state.lineage.operations[operationId]?.planActionId;
  return planActionId
    ? planActionById(state, planActionId)
    : undefined;
}

function planActionById(
  state: SessionKernelLoopStateV2,
  planActionId: string
): PlanActionContinuationContextV2 | undefined {
  const plan = state.plan;
  const action = plan?.actions.find(
    (candidate) =>
      candidate.manifest.planActionId === planActionId
  );
  if (
    !plan
    || !action
    || action.manifest.planRevision !== plan.planRevision
  ) {
    return undefined;
  }
  return {
    planActionId,
    expectedPlanRevision: plan.planRevision,
  };
}

function readyToDrivePlanAction(
  context: PlanActionContinuationContextV2 | undefined
): Extract<
  SessionKernelProductionContinuationV2,
  { kind: 'readyToDrivePlanAction' }
> {
  return {
    kind: 'readyToDrivePlanAction',
    ...requiredPlanActionFields(context),
  };
}

function readyToPreviewPlanAction(
  context: PlanActionContinuationContextV2
): Extract<
  SessionKernelProductionContinuationV2,
  { kind: 'readyToPreviewPlanAction' }
> {
  return {
    kind: 'readyToPreviewPlanAction',
    ...context,
  };
}

function readyForPlanAction(
  state: SessionKernelLoopStateV2,
  context: PlanActionContinuationContextV2 | undefined
): Extract<
  SessionKernelProductionContinuationV2,
  {
    kind:
      | 'readyToDrivePlanAction'
      | 'readyToPreviewPlanAction'
      | 'awaitingUserScopeDecision'
      | 'readyToFinalizeReview'
      | 'awaitingKernelFacts';
  }
> {
  if (!sessionKernelFactsAreReady(state)) {
    return awaitingKernelFacts(state);
  }
  if (!context) return readyToDriveOrFinalize(state, context);
  const action = state.plan?.actions.find(
    (candidate) =>
      candidate.manifest.planActionId === context.planActionId
  );
  if (!action) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_plan_action_continuation_missing'
    );
  }
  const preview = state.previews[action.manifest.operationId];
  if (!preview) return readyToPreviewPlanAction(context);
  if (
    preview.disposition === 'requiresUserDecision'
    && !planActionHasLease(state, context.planActionId)
  ) {
    return {
      kind: 'awaitingUserScopeDecision',
      previewId: preview.previewId,
      disposition: preview.disposition,
      ...context,
    };
  }
  return readyToDrivePlanAction(context);
}

function firstUnpreviewedPlanAction(
  state: SessionKernelLoopStateV2
): PlanActionContinuationContextV2 | undefined {
  const action = state.plan?.actions.find(
    (candidate) =>
      !state.previews[candidate.manifest.operationId]
  );
  return action
    ? {
        planActionId: action.manifest.planActionId,
        expectedPlanRevision:
          action.manifest.planRevision,
      }
    : undefined;
}

function planActionHasLease(
  state: SessionKernelLoopStateV2,
  planActionId: string
): boolean {
  return (
    state.lineage.planActions[planActionId]?.operationIds ?? []
  ).some(
    (operationId) =>
      (state.lineage.operations[operationId]?.leases.length ?? 0) > 0
  );
}

function readyToResumePlanning(
  guidance: string[] = []
): Extract<
  SessionKernelProductionContinuationV2,
  { kind: 'readyToResumePlanning' }
> {
  return {
    kind: 'readyToResumePlanning',
    guidance: [...guidance],
  };
}

function readyToDriveOrFinalize(
  state: SessionKernelLoopStateV2,
  context: PlanActionContinuationContextV2 | undefined
): Extract<
  SessionKernelProductionContinuationV2,
  {
    kind:
      | 'readyToDrivePlanAction'
      | 'readyToPreviewPlanAction'
      | 'awaitingUserScopeDecision'
      | 'readyToFinalizeReview'
      | 'awaitingKernelFacts';
  }
> {
  if (!sessionKernelFactsAreReady(state)) {
    return awaitingKernelFacts(state);
  }
  const plan = state.plan;
  const everyPlanActionSettled = plan?.actions.every((action) =>
    sessionKernelPlanActionSettledV2(
      state,
      action.manifest.planActionId
    )
  ) ?? false;
  if (
    plan
    && everyPlanActionSettled
    && canFinalizeSessionKernelReviewV2(state)
  ) {
    return {
      kind: 'readyToFinalizeReview',
      expectedPlanRevision: plan.planRevision,
    };
  }
  if (context) return readyForPlanAction(state, context);
  if (plan && everyPlanActionSettled) {
    return {
      kind: 'awaitingKernelFacts',
      observedHighWater:
        state.lineage.cursor.snapshotHighWater,
    };
  }
  throw new SessionKernelProductionBridgeError(
    'session_kernel_production_plan_action_continuation_missing'
  );
}

function sessionKernelFactsAreReady(
  state: SessionKernelLoopStateV2
): boolean {
  return !state.kernelWakeHint
    && sessionKernelFactsCaughtUpV2(state.lineage)
    && !sessionKernelFactBarriersPendingV2(state);
}

function awaitingKernelFacts(
  state: SessionKernelLoopStateV2
): Extract<
  SessionKernelProductionContinuationV2,
  { kind: 'awaitingKernelFacts' }
> {
  return {
    kind: 'awaitingKernelFacts',
    observedHighWater:
      state.lineage.cursor.snapshotHighWater,
  };
}

function planActionFields(
  context: PlanActionContinuationContextV2 | undefined
): Partial<PlanActionContinuationContextV2> {
  return context
    ? {
        planActionId: context.planActionId,
        expectedPlanRevision: context.expectedPlanRevision,
      }
    : {};
}

function requiredPlanActionFields(
  context: PlanActionContinuationContextV2 | undefined
): PlanActionContinuationContextV2 {
  if (!context) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_plan_action_continuation_missing'
    );
  }
  return {
    planActionId: context.planActionId,
    expectedPlanRevision: context.expectedPlanRevision,
  };
}

function planRevisionField(
  state: SessionKernelLoopStateV2
): { expectedPlanRevision?: string } {
  return state.plan
    ? { expectedPlanRevision: state.plan.planRevision }
    : {};
}

function requiredCurrentPlanRevision(
  state: SessionKernelLoopStateV2
): string {
  if (!state.plan) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_plan_revision_missing'
    );
  }
  return state.plan.planRevision;
}

class SystemSessionKernelClockV2
implements SessionKernelClockPortV2 {
  now(): string {
    return new Date().toISOString();
  }

  async waitUntil(
    instant: string,
    signal?: AbortSignal
  ): Promise<void> {
    const target = Date.parse(instant);
    if (!Number.isFinite(target)) {
      throw new SessionKernelProductionBridgeError(
        'session_kernel_clock_instant_invalid'
      );
    }
    while (target > Date.now()) {
      await wait(
        Math.min(target - Date.now(), 2_147_483_647),
        signal
      );
    }
  }
}

class RandomSessionKernelIdFactoryV2
implements SessionKernelIdFactoryPortV2 {
  private readonly processNonce = globalThis.crypto.randomUUID();
  private requestSequence = 0;
  private providerSequence = 0;

  nextRequestId(): string {
    this.requestSequence += 1;
    return [
      'session-kernel-request',
      this.processNonce,
      String(this.requestSequence),
    ].join(':');
  }

  nextProviderTurnId(): string {
    this.providerSequence += 1;
    return [
      'session-provider-turn',
      this.processNonce,
      String(this.providerSequence),
    ].join(':');
  }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new SessionKernelProductionBridgeError(
        'session_kernel_clock_wait_aborted'
      );
}

function settleResponseFrame(
  operationRequestId: string,
  response: SessionKernelProductionResponseV2
): SessionKernelProductionSettledFrameV2 {
  const frame: SessionKernelProductionResponseFrameV2 = {
    schemaVersion:
      SESSION_KERNEL_PRODUCTION_RESPONSE_FRAME_V2_SCHEMA,
    operationRequestId,
    response,
  };
  assertNoTransportCapabilities(frame);
  const encoded = JSON.stringify(frame);
  const byteLength =
    new TextEncoder().encode(encoded).byteLength + 1;
  if (byteLength > SESSION_KERNEL_PRODUCTION_MAX_FRAME_BYTES) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_response_frame_oversized'
    );
  }
  return {
    frame,
    encodedLine: `${encoded}\n`,
    byteLength,
  };
}

async function settleResponseFrameDurably(
  operationRequestId: string,
  response: SessionKernelProductionSuccessV2,
  runner: SessionKernelHostRunnerV2 | undefined
): Promise<SessionKernelProductionSettledFrameV2> {
  const direct = productionResponseFrame(
    operationRequestId,
    response
  );
  if (
    direct.byteLength
      <= SESSION_KERNEL_PRODUCTION_MAX_FRAME_BYTES
  ) {
    return direct;
  }
  if (!runner) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_result_store_unavailable'
    );
  }
  if (response.outcome.kind === 'resultStored') {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_result_store_recursive'
    );
  }
  if (
    direct.byteLength
      > SESSION_KERNEL_PRODUCTION_MAX_STORED_RESULT_BYTES
  ) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_result_store_oversized'
    );
  }
  const stored = await runner.persistOperationResult(
    operationRequestId,
    response
  );
  const readPath = [
    '/api/session-store',
    encodeURIComponent(response.sessionId),
    'kernel-v2',
    encodeURIComponent(response.runId),
    'records',
    encodeURIComponent(stored.recordId),
  ].join('/');
  return settleResponseFrame(operationRequestId, {
    ...response,
    outcome: {
      kind: 'resultStored',
      resultRef: stored.recordId,
      originalOutcomeKind: response.outcome.kind,
      storage: 'sessionPersistenceRecord',
      recordId: stored.recordId,
      recordDigest: stored.recordDigest,
      resultDigest: stored.resultDigest,
      readPath,
    },
  });
}

function productionResponseFrame(
  operationRequestId: string,
  response: SessionKernelProductionResponseV2
): SessionKernelProductionSettledFrameV2 {
  const frame: SessionKernelProductionResponseFrameV2 = {
    schemaVersion:
      SESSION_KERNEL_PRODUCTION_RESPONSE_FRAME_V2_SCHEMA,
    operationRequestId,
    response,
  };
  assertNoTransportCapabilities(frame);
  const encoded = JSON.stringify(frame);
  return {
    frame,
    encodedLine: `${encoded}\n`,
    byteLength:
      new TextEncoder().encode(encoded).byteLength + 1,
  };
}

function requestDigest(value: unknown): string {
  return sha256Hash(canonicalJson({ value }));
}

function safeRequestDigest(value: unknown): string {
  try {
    return requestDigest(value);
  } catch {
    return UNHASHABLE_REQUEST_DIGEST;
  }
}

function correlatedOperationRequestId(
  value: unknown
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = Reflect.get(value, 'operationRequestId');
  if (
    typeof candidate !== 'string'
    || candidate.length === 0
    || new TextEncoder().encode(candidate).byteLength > 512
    || candidate.trim() !== candidate
    || /[\u0000-\u001f\u007f-\u009f]/u.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function failureBoundary(
  disposition:
    SessionKernelProductionFailureV2['error']['disposition'],
  commit: SessionKernelProductionFailureV2['error']['commit'],
  effect: SessionKernelProductionFailureV2['error']['effect'],
  pendingRequestLanes: Array<'control' | 'effect' | 'query'> = []
): SessionKernelFailureBoundaryV2 {
  return {
    disposition,
    commit,
    effect,
    pendingRequestLanes: [...pendingRequestLanes],
  };
}

function failureBoundaryFromState(
  state: SessionKernelLoopStateV2 | undefined
): SessionKernelFailureBoundaryV2 {
  return failureBoundary(
    state ? 'queryFacts' : 'doNotRetry',
    state ? 'unknown' : 'none',
    state ? 'possible' : 'none',
    state
      ? (
          Object.keys(state.publicRequests) as Array<
            'control' | 'effect' | 'query'
          >
        ).sort()
      : []
  );
}

function failureBoundaryFromError(
  error: unknown,
  state: SessionKernelLoopStateV2 | undefined
): SessionKernelFailureBoundaryV2 {
  if (
    error instanceof SessionKernelProviderTransportError
    || error instanceof SessionKernelProviderAdapterError
  ) {
    return failureBoundary('doNotRetry', 'none', 'none');
  }
  return failureBoundaryFromState(state);
}

function causalStateSummary(
  state: SessionKernelLoopStateV2
): SessionKernelProductionSuccessV2['causalState'] {
  return {
    controlEpoch: state.controlEpoch,
    currentInputId: state.currentInputId,
    ...(state.plan
      ? { planRevision: state.plan.planRevision }
      : {}),
  };
}

function productionBootstrapFingerprint(
  request: SessionKernelProductionRequestV2
): string {
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    sessionId: request.sessionId,
    hostRunId: request.hostRunId,
    runId: request.runId,
    historySchema: request.historySchema,
    providerProfile: request.providerProfile,
    priorSessionEvents: request.priorSessionEvents,
    prefetchedRun: request.prefetchedRun,
    initialInput: request.initialInput,
  });
}

function requireProductionPlanRevision(
  state: SessionKernelLoopStateV2,
  expectedPlanRevision: string
): void {
  if (state.plan?.planRevision !== expectedPlanRevision) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_plan_revision_stale'
    );
  }
}

function requireExactCapabilityWait(
  state: SessionKernelLoopStateV2,
  input: SessionKernelProductionObserveCapabilityDecisionV2['data']
): void {
  const wait = state.activeWait;
  if (
    !wait
    || wait.kind !== 'capability'
    || wait.previewId !== input.previewId
    || wait.operationId !== input.operationId
    || wait.invocationId !== input.invocationId
  ) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_capability_decision_stale'
    );
  }
  requireExactPlanActionBinding(state, input.operationId, input);
}

function requireExactWake(
  state: SessionKernelLoopStateV2,
  input: SessionKernelProductionReconcileWakeV2['data']
): void {
  const wait = state.activeWait;
  if (
    !wait
    || wait.kind !== input.waitKind
    || (
      wait.kind !== 'capability'
      && wait.kind !== 'invocation'
    )
    || wait.operationId !== input.operationId
    || wait.invocationId !== input.invocationId
    || (
      wait.kind === 'capability'
      && wait.previewId !== input.previewId
    )
  ) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_wake_identity_stale'
    );
  }
  requireExactPlanActionBinding(state, input.operationId, input);
}

function requireExactPlanActionBinding(
  state: SessionKernelLoopStateV2,
  operationId: string,
  input: {
    planActionId?: string;
    expectedPlanRevision?: string;
  }
): void {
  const actual = planActionForOperation(state, operationId);
  if (!actual) {
    if (
      input.planActionId !== undefined
      || input.expectedPlanRevision !== undefined
    ) {
      throw new SessionKernelProductionBridgeError(
        'session_kernel_production_plan_action_binding_stale'
      );
    }
    return;
  }
  if (
    input.planActionId !== actual.planActionId
    || input.expectedPlanRevision
      !== actual.expectedPlanRevision
  ) {
    throw new SessionKernelProductionBridgeError(
      'session_kernel_production_plan_action_binding_stale'
    );
  }
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProductionRequest();
  }
  const record = value as Record<string, unknown>;
  const permitted = new Set([...required, ...optional]);
  if (
    required.some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key)
    )
    || Object.keys(record).some((key) => !permitted.has(key))
  ) {
    throw invalidProductionRequest();
  }
  return record;
}

function identity(value: unknown, field: string): string {
  const text = boundedText(value, field, 512);
  if (
    text.trim() !== text
    || /[\u0000-\u001f\u007f-\u009f]/u.test(text)
  ) {
    throw invalidProductionRequest(
      'session_kernel_production_identity_invalid'
    );
  }
  return text;
}

function sha256Digest(value: unknown, _field: string): string {
  if (
    typeof value !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(value)
  ) {
    throw invalidProductionRequest(
      'session_kernel_production_digest_invalid'
    );
  }
  return value;
}

function positiveTokenLimit(
  value: unknown,
  _field: string
): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) <= 0
    || Number(value) > 1_000_000_000
  ) {
    throw invalidProductionRequest(
      'session_kernel_provider_profile_budget_invalid'
    );
  }
  return Number(value);
}

function boundedText(
  value: unknown,
  _field: string,
  maxBytes: number
): string {
  if (
    typeof value !== 'string'
    || !value
    || new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw invalidProductionRequest();
  }
  return value;
}

function optionalText(
  value: unknown,
  _field: string,
  maxBytes: number
): string {
  if (
    typeof value !== 'string'
    || new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw invalidProductionRequest();
  }
  return value;
}

function assertNoTransportCapabilities(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertNoTransportCapabilities);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'runCapability' || key === 'decisionCapability') {
      throw new SessionKernelProductionBridgeError(
        'session_kernel_production_secret_forbidden'
      );
    }
    assertNoTransportCapabilities(nested);
  }
}

function invalidProductionRequest(
  code = 'session_kernel_production_request_invalid'
): SessionKernelProductionBridgeError {
  return new SessionKernelProductionBridgeError(code);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SessionKernelProductionBridgeError extends Error {
  constructor(readonly code: string) {
    super('Session Kernel v2 production request failed validation.');
    this.name = 'SessionKernelProductionBridgeError';
  }
}
