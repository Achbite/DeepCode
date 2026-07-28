import type {
  CapabilityScopePreviewReplyV2,
} from '@deepcode/protocol';
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
} from './SessionKernelHttpProviderBackendV2.js';
import {
  StrictSessionKernelProviderAdapterV2,
} from './SessionKernelProviderAdapterV2.js';
import {
  SessionKernelHostRunnerV2,
  type SessionPlanActionDriveStepV2,
} from './SessionKernelHostRunnerV2.js';
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
  SessionUserInputRecordV2,
} from './types.js';

export const SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA =
  'deepcode.session.kernel-production-request.v2' as const;
export const SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA =
  'deepcode.session.kernel-production-response.v2' as const;

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
    wakeHint: boolean;
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

export interface SessionKernelProductionResumeAfterBackpressureV2 {
  kind: 'resumeAfterBackpressure';
  data: {
    operationId: string;
    retryAt: string;
    planActionId: string;
    guidance: string[];
  };
}

export interface SessionKernelProductionPreviewPlanActionV2 {
  kind: 'previewPlanAction';
  data: {
    planActionId: string;
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

export interface SessionKernelProductionSkipPlanActionV2 {
  kind: 'skipPlanAction';
  data: {
    planActionId: string;
    reason: string;
  };
}

export interface SessionKernelProductionObserveCapabilityDecisionV2 {
  kind: 'observeCapabilityDecision';
  data: {
    decision: 'allow' | 'deny';
    guidance: string;
  };
}

export interface SessionKernelProductionReconcileWakeV2 {
  kind: 'reconcileWake';
  data: Record<string, never>;
}

export interface SessionKernelProductionFinalizeReviewV2 {
  kind: 'finalizeReview';
  data: Record<string, never>;
}

export type SessionKernelProductionOperationV2 =
  | SessionKernelProductionInitialTurnV2
  | SessionKernelProductionResumePlanActionV2
  | SessionKernelProductionUserInputV2
  | SessionKernelProductionReplanV2
  | SessionKernelProductionResumeAfterBackpressureV2
  | SessionKernelProductionPreviewPlanActionV2
  | SessionKernelProductionDecidePlanV2
  | SessionKernelProductionSkipPlanActionV2
  | SessionKernelProductionObserveCapabilityDecisionV2
  | SessionKernelProductionReconcileWakeV2
  | SessionKernelProductionFinalizeReviewV2;

/**
 * Exact safe JSON sent by the Rust Host over stdin. The run capability is
 * intentionally absent and must be supplied through the inherited private
 * process seam.
 */
export interface SessionKernelProductionRequestV2 {
  schemaVersion: typeof SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA;
  apiBase: string;
  sessionId: string;
  hostRunId: string;
  runId: string;
  historySchema: typeof SESSION_KERNEL_PERSISTENCE_V2_SCHEMA;
  providerProfileId?: string;
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
      kind: 'replanResult';
      result: SessionKernelLoopResultV2;
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
      kind: 'planActionSkipped';
      planActionId: string;
    }
  | {
      kind: 'capabilityDecisionObserved';
      decision: 'allow' | 'deny';
      result?: SessionKernelLoopResultV2;
    }
  | {
      kind: 'factsReconciled';
    }
  | {
      kind: 'reviewFinalized';
      review: SessionKernelReviewV2;
    };

export type SessionKernelProductionContinuationV2 =
  | {
      kind: 'awaitingUserPlanConfirmation';
      planRevision: string;
    }
  | {
      kind: 'awaitingUserScopeDecision';
      previewId: string;
      disposition: 'autoIssuable' | 'requiresUserDecision';
    }
  | {
      kind: 'awaitingKernelWake';
      waitKind: 'capabilityDecisionFact' | 'invocation';
      operationId: string;
      invocationId: string;
    }
  | {
      kind: 'awaitingBackpressureDeadline';
      operationId: string;
      retryAt: string;
    }
  | {
      kind: 'manualRecoveryRequired';
      operationId: string;
      invocationId?: string;
    }
  | {
      kind: 'replanRequired';
      guidance: string[];
    }
  | {
      kind: 'readyToDrivePlanAction';
    }
  | {
      kind: 'recoveryRequired';
      pendingRequestLanes: Array<'control' | 'effect' | 'query'>;
    }
  | {
      kind: 'providerTurnSuperseded';
      providerTurnId: string;
    }
  | {
      kind: 'providerBudgetExhausted';
      providerCallBudget: number;
      completedProviderCalls: number;
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
  operationKind: SessionKernelProductionOperationV2['kind'];
  state: SessionKernelProductionStateSummaryV2;
  outcome: SessionKernelProductionOutcomeV2;
  continuation: SessionKernelProductionContinuationV2;
}

export interface SessionKernelProductionFailureV2 {
  schemaVersion: typeof SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA;
  ok: false;
  error: {
    code: string;
  };
}

export type SessionKernelProductionResponseV2 =
  | SessionKernelProductionSuccessV2
  | SessionKernelProductionFailureV2;

/**
 * Strict v2 composition over semantic Kernel, persistence, Provider, and
 * projection ports. No compatibility or fallback path exists here.
 */
export async function executeSessionKernelProductionRequestV2(
  value: unknown,
  privateAuth: SessionKernelTransportPrivateAuthV2,
  fetchImpl: typeof fetch = fetch
): Promise<SessionKernelProductionSuccessV2> {
  const request = decodeSessionKernelProductionRequestV2(value);
  const transport = new HttpKernelCommandTransportV2({
    baseUrl: request.apiBase,
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
    request.apiBase,
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
      request.apiBase,
      privateAuth,
      fetchImpl
    )
  );
  const clock = new SystemSessionKernelClockV2();
  const provider = new StrictSessionKernelProviderAdapterV2(
    new HttpSessionKernelProviderBackendV2(
      new HttpSessionKernelLlmTransportV2(
        request.apiBase,
        fetchImpl
      ),
      request.providerProfileId
    ),
    clock
  );

  await projection.flushPending(request.runId);
  const runner = await SessionKernelHostRunnerV2.open(
    {
      workspaceBindingRef:
        request.prefetchedRun.workspaceBindingRef,
      initialInput: request.initialInput,
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

  const outcome = await executeProductionOperation(
    runner,
    request.operation
  );
  const state = runner.snapshot();
  const response: SessionKernelProductionSuccessV2 = {
    schemaVersion: SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA,
    ok: true,
    sessionId: request.sessionId,
    hostRunId: request.hostRunId,
    runId: request.runId,
    operationKind: request.operation.kind,
    state: summarizeState(state),
    outcome,
    continuation: productionContinuation(state, outcome),
  };
  assertNoTransportCapabilities(response);
  return response;
}

async function executeProductionOperation(
  runner: SessionKernelHostRunnerV2,
  operation: SessionKernelProductionOperationV2
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
      return {
        kind: 'userInputResult',
        result: await runner.handleUserInput(
          operation.data.input,
          operation.data.guidance
        ),
      };
    case 'replan':
      return {
        kind: 'replanResult',
        result: await runner.replan(operation.data),
      };
    case 'resumeAfterBackpressure':
      return {
        kind: 'backpressureResumeResult',
        result: await runner.resumeAfterBackpressure(operation.data),
      };
    case 'resumePlanAction':
      return {
        kind: 'resumePlanActionStep',
        step: await runner.drivePlanActionStep(
          operation.data.planActionId,
          {
            wakeHint: operation.data.wakeHint,
            providerCallBudget:
              operation.data.providerCallBudget,
            guidance: operation.data.guidance,
          }
        ),
      };
    case 'previewPlanAction':
      return {
        kind: 'planActionPreview',
        preview: await runner.previewPlanAction(
          operation.data.planActionId
        ),
      };
    case 'decidePlan':
      return {
        kind: 'planDecisionRecorded',
        decision: await runner.decidePlan(operation.data),
      };
    case 'skipPlanAction':
      await runner.skipPlanAction(
        operation.data.planActionId,
        operation.data.reason
      );
      return {
        kind: 'planActionSkipped',
        planActionId: operation.data.planActionId,
      };
    case 'observeCapabilityDecision': {
      const result = await runner.observeCapabilityDecision({
        decision: operation.data.decision,
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
    case 'reconcileWake':
      await runner.notifyKernelWakeHint();
      return { kind: 'factsReconciled' };
    case 'finalizeReview':
      return {
        kind: 'reviewFinalized',
        review: await runner.finalizeReview(),
      };
  }
}

export function decodeSessionKernelProductionRequestV2(
  value: unknown
): SessionKernelProductionRequestV2 {
  const record = exactObject(
    value,
    [
      'schemaVersion',
      'apiBase',
      'sessionId',
      'hostRunId',
      'runId',
      'historySchema',
      'prefetchedRun',
      'initialInput',
      'operation',
    ],
    ['providerProfileId']
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
  if (
    prefetchedRun.runOpenReply.runId !== runId
    || prefetchedRun.inputId !== initialInput.inputId
    || prefetchedRun.opaqueInputRef !== initialInput.opaqueInputRef
  ) {
    throw invalidProductionRequest(
      'session_kernel_production_run_identity_mismatch'
    );
  }
  assertNoTransportCapabilities(record);
  return {
    schemaVersion: SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA,
    apiBase: boundedText(record.apiBase, 'apiBase', 4 * 1024),
    sessionId,
    hostRunId,
    runId,
    historySchema: SESSION_KERNEL_PERSISTENCE_V2_SCHEMA,
    ...(record.providerProfileId !== undefined
      ? {
          providerProfileId: identity(
            record.providerProfileId,
            'providerProfileId'
          ),
        }
      : {}),
    prefetchedRun,
    initialInput,
    operation: decodeOperation(record.operation),
  };
}

export function sessionKernelProductionFailureV2(
  error: unknown
): SessionKernelProductionFailureV2 {
  const candidate =
    error && typeof error === 'object' && !Array.isArray(error)
      ? error as { code?: unknown }
      : undefined;
  const code = typeof candidate?.code === 'string'
    && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(candidate.code)
      ? candidate.code
      : 'session_kernel_production_failed';
  return {
    schemaVersion: SESSION_KERNEL_PRODUCTION_RESPONSE_V2_SCHEMA,
    ok: false,
    error: { code },
  };
}

function decodeInitialInput(value: unknown): SessionUserInputRecordV2 {
  const record = exactObject(
    value,
    ['inputId', 'opaqueInputRef', 'text', 'recordedAt']
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
        'wakeHint',
        'providerCallBudget',
        'guidance',
      ]
    );
    if (
      typeof body.wakeHint !== 'boolean'
      || !Number.isSafeInteger(body.providerCallBudget)
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
        wakeHint: body.wakeHint,
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
  if (tagged.kind === 'resumeAfterBackpressure') {
    const body = exactObject(
      data,
      ['operationId', 'retryAt', 'planActionId', 'guidance']
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
        planActionId: identity(body.planActionId, 'planActionId'),
        guidance: decodeGuidance(body.guidance),
      },
    };
  }
  if (tagged.kind === 'previewPlanAction') {
    const body = exactObject(data, ['planActionId']);
    return {
      kind: tagged.kind,
      data: {
        planActionId: identity(
          body.planActionId,
          'planActionId'
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
  if (tagged.kind === 'skipPlanAction') {
    const body = exactObject(data, ['planActionId', 'reason']);
    return {
      kind: tagged.kind,
      data: {
        planActionId: identity(body.planActionId, 'planActionId'),
        reason: boundedText(body.reason, 'reason', 64 * 1024),
      },
    };
  }
  if (tagged.kind === 'observeCapabilityDecision') {
    const body = exactObject(data, ['decision', 'guidance']);
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
      },
    };
  }
  if (
    tagged.kind === 'reconcileWake'
    || tagged.kind === 'finalizeReview'
  ) {
    exactObject(data, []);
    return { kind: tagged.kind, data: {} };
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
  outcome: SessionKernelProductionOutcomeV2
): SessionKernelProductionContinuationV2 {
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
    ? continuationForWait(state, state.activeWait)
    : undefined;
  if (waitContinuation) return waitContinuation;
  if (state.pendingGuidance.length > 0) {
    return {
      kind: 'replanRequired',
      guidance: [...state.pendingGuidance],
    };
  }
  if (
    outcome.kind === 'replanResult'
    && outcome.result.kind !== 'plan'
  ) {
    return continuationForLoopResult(outcome.result);
  }
  if (
    state.plan
    && (
      state.planDecision?.planRevision !== state.plan.planRevision
      || state.planDecision.decision !== 'accept'
    )
  ) {
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
    return { kind: 'readyToDrivePlanAction' };
  }
  switch (outcome.kind) {
    case 'initialTurnResult':
    case 'userInputResult':
    case 'replanResult':
    case 'backpressureResumeResult':
      return continuationForLoopResult(outcome.result);
    case 'resumePlanActionStep':
      return continuationForDriveStep(outcome.step);
    case 'planActionPreview':
      if (outcome.preview.kind === 'rejected') {
        return {
          kind: 'replanRequired',
          guidance: [outcome.preview.data.guidance],
        };
      }
      return outcome.preview.data.preview.disposition
        === 'requiresUserDecision'
          ? {
              kind: 'awaitingUserScopeDecision',
              previewId:
                outcome.preview.data.preview.previewId,
              disposition:
                outcome.preview.data.preview.disposition,
            }
          : { kind: 'readyToDrivePlanAction' };
    case 'planDecisionRecorded':
      return outcome.decision.decision === 'accept'
        ? { kind: 'readyToDrivePlanAction' }
        : {
            kind: 'replanRequired',
            guidance: outcome.decision.guidance
              ? [outcome.decision.guidance]
              : [],
          };
    case 'planActionSkipped':
      return { kind: 'readyToDrivePlanAction' };
    case 'capabilityDecisionObserved':
      return outcome.result
        ? continuationForLoopResult(outcome.result)
        : { kind: 'readyToDrivePlanAction' };
    case 'factsReconciled':
      return { kind: 'readyToDrivePlanAction' };
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
  wait: SessionActiveWaitV2
): SessionKernelProductionContinuationV2 {
  switch (wait.kind) {
    case 'capability': {
      if (wait.decisionHint) {
        return {
          kind: 'awaitingKernelWake',
          waitKind: 'capabilityDecisionFact',
          operationId: wait.operationId,
          invocationId: wait.invocationId,
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
      };
    }
    case 'invocation':
      return {
        kind: 'awaitingKernelWake',
        waitKind: 'invocation',
        operationId: wait.operationId,
        invocationId: wait.invocationId,
      };
    case 'backpressure':
      return {
        kind: 'awaitingBackpressureDeadline',
        operationId: wait.operationId,
        retryAt: wait.retryAt,
      };
    case 'manualRecovery':
      return {
        kind: 'manualRecoveryRequired',
        operationId: wait.operationId,
        ...(wait.invocationId
          ? { invocationId: wait.invocationId }
          : {}),
      };
  }
}

function continuationForLoopResult(
  result: SessionKernelLoopResultV2
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
      return { kind: 'readyToDrivePlanAction' };
    case 'awaitingCapability':
      return {
        kind: 'awaitingUserScopeDecision',
        previewId: result.preview.previewId,
        disposition: result.preview.disposition,
      };
    case 'retryScheduled':
      return {
        kind: 'awaitingBackpressureDeadline',
        operationId: result.operationId,
        retryAt: result.retryAt,
      };
    case 'rejected':
      return {
        kind: 'replanRequired',
        guidance: [result.guidance],
      };
    case 'manualRecovery':
      return {
        kind: 'manualRecoveryRequired',
        operationId: result.operationId,
        ...(result.invocationId
          ? { invocationId: result.invocationId }
          : {}),
      };
    case 'staleProviderResult':
      return {
        kind: 'providerTurnSuperseded',
        providerTurnId: result.providerTurnId,
      };
  }
}

function continuationForDriveStep(
  step: SessionPlanActionDriveStepV2
): SessionKernelProductionContinuationV2 {
  switch (step.kind) {
    case 'providerResult':
      return step.result.kind === 'answer'
        ? { kind: 'terminalProviderAnswer' }
        : { kind: 'terminalProviderStop' };
    case 'waiting':
      return continuationForStandaloneWait(step.wait);
    case 'replanRequired':
      return {
        kind: 'replanRequired',
        guidance: [...step.guidance],
      };
    case 'budgetExhausted':
      return {
        kind: 'providerBudgetExhausted',
        providerCallBudget: step.providerCallBudget,
        completedProviderCalls: step.completedProviderCalls,
      };
    case 'interrupted':
      return {
        kind: 'providerTurnSuperseded',
        providerTurnId: step.result.providerTurnId,
      };
  }
}

function continuationForStandaloneWait(
  wait: SessionActiveWaitV2
): SessionKernelProductionContinuationV2 {
  if (wait.kind === 'capability') {
    return wait.decisionHint
      ? {
          kind: 'awaitingKernelWake',
          waitKind: 'capabilityDecisionFact',
          operationId: wait.operationId,
          invocationId: wait.invocationId,
        }
      : {
          kind: 'awaitingUserScopeDecision',
          previewId: wait.previewId,
          disposition: 'requiresUserDecision',
        };
  }
  if (wait.kind === 'invocation') {
    return {
      kind: 'awaitingKernelWake',
      waitKind: 'invocation',
      operationId: wait.operationId,
      invocationId: wait.invocationId,
    };
  }
  if (wait.kind === 'backpressure') {
    return {
      kind: 'awaitingBackpressureDeadline',
      operationId: wait.operationId,
      retryAt: wait.retryAt,
    };
  }
  return {
    kind: 'manualRecoveryRequired',
    operationId: wait.operationId,
    ...(wait.invocationId
      ? { invocationId: wait.invocationId }
      : {}),
  };
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
