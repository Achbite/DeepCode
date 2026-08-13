import { canonicalJson, sha256Hash } from '../cache/canonicalizer.js';
import type {
  CapabilityScopePreviewRecordV2,
  DeadlineRequestV2,
  ToolContextBundleV2,
  ToolContextRefV2,
} from '@deepcode/protocol';
import {
  decodeKernelCommandResponseEnvelopeV2,
  decodeToolContextBundleV2,
  KERNEL_ABI_V2_VERSION,
} from '@deepcode/protocol';
import {
  SessionKernelProjectionDeliveryErrorV2,
} from './ports.js';
import type {
  SessionKernelPersistencePortV2,
  SessionKernelProjectionReceiptV2,
  SessionKernelProjectionPortV2,
  SessionKernelStoredOperationResultV2,
  SessionKernelStoredOperationResultRefV2,
} from './ports.js';
import {
  createSessionKernelLoopStateV2,
  createSessionReviewFactAccumulatorV2,
  currentSessionPlanScopePreviewsV2,
  currentSessionUserInputV2,
  prepareSessionKernelFactReplayV3,
  sameSessionWorkAuthorityV3,
  validateSessionWorkAuthorityShapeV3,
  type SessionKernelCheckpointRecoveryInputV3,
  type SessionKernelCheckpointV2,
  type SessionKernelLoopStateV2,
} from './state.js';
import { projectSessionProviderFactsV2 } from './providerFactProjection.js';
import type {
  SessionActiveWaitV2,
  SessionFinalAnswerStateV3,
  SessionInterventionResearchV4,
  SessionTerminalAnswerCandidateV1,
  SessionKernelFactBarrierV2,
  SessionKernelPersistenceRecordRefV3,
  SessionKernelProjectionEventV2,
  SessionKernelPublicRequestRecordV2,
  SessionKernelReviewV2,
  SessionNaturalLanguagePlanV2,
  SessionOperationPlanActionBindingV2,
  SessionPlanActionSettlementV2,
  SessionPlanDecisionV2,
  SessionProviderAuthorityBindingV3,
  SessionProviderOutcomeRecordV2,
  SessionProviderTerminalOrderedItemV3,
  SessionProviderTurnDispatchRecordV3,
  SessionProviderTurnDurableEvidenceV3,
  SessionProviderTurnRecordV2,
  SessionProviderTurnTargetV2,
  SessionProviderTurnTerminalRecordV3,
  SessionToolContextSnapshotRecordV3,
  SessionRunCancellationV2,
  SessionUserInputRecordV2,
  SessionUserInterventionDecisionV4,
  SessionUserInterventionV4,
  SessionWorkAuthorityV3,
} from './types.js';
import type {
  SessionKernelTransportPrivateAuthV2,
} from './SessionKernelPortV2.js';
import {
  SESSION_KERNEL_CHECKPOINT_V2_SCHEMA as SESSION_KERNEL_CHECKPOINT_V3_SCHEMA,
  SESSION_KERNEL_LOOP_V2_SCHEMA as SESSION_KERNEL_LOOP_V3_SCHEMA,
  SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
  SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA,
  SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA,
  SESSION_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA,
  SESSION_TERMINAL_ANSWER_CANDIDATE_V1_SCHEMA,
} from './types.js';
import {
  decodeAgentInputAttachmentsV3,
  decodeUserAttachmentContextsV1,
} from './inputAttachmentsV2.js';
import {
  assertProviderSafeToolContextV2,
  providerToolContextBindingV2,
  toolContextRefV2,
} from './toolContext.js';
import type {
  SessionProviderToolCallQueueItemV2,
  SessionProviderToolCallQueueV2,
} from './providerToolCallQueue.js';
import {
  repairedSessionProviderOutcomeV2,
  settledSessionProviderToolCallsV2,
  validateSessionProviderToolCallQueueV2,
} from './providerToolCallQueue.js';
import {
  decodeCompletedProviderTerminalV3,
} from './SessionKernelHttpProviderBackendV2.js';
import {
  adaptSessionKernelProviderBackendOutputV2,
} from './SessionKernelProviderAdapterV2.js';
import {
  validateCurrentSessionKernelProjectionEventV2,
} from './SessionKernelHttpProjectionV2.js';

export const SESSION_KERNEL_PERSISTENCE_V3_SCHEMA =
  'deepcode.session.kernel-persistence.v4' as const;
export const SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA =
  'deepcode.session.kernel-persistence-record.v4' as const;
export const SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA =
  'deepcode.session.kernel-persistence-append-request.v2' as const;
export const SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA =
  'deepcode.session.kernel-persistence-list-reply.v2' as const;
export const SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA =
  'deepcode.session.kernel-persistence-append-reply.v2' as const;
export const SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA =
  'deepcode.session.kernel-operation-result.v2' as const;
export const SESSION_KERNEL_REVIEW_RECORD_V3_SCHEMA =
  'deepcode.session.review-record.v4' as const;
export const SESSION_KERNEL_PLAN_ACTION_SETTLEMENT_RECORD_V3_SCHEMA =
  'deepcode.session.plan-action-settlement-record.v4' as const;
export const SESSION_KERNEL_PUBLIC_REQUEST_SETTLEMENT_V3_SCHEMA =
  'deepcode.session.public-request-settlement.v4' as const;
export const SESSION_KERNEL_PROJECTION_RECORD_V3_SCHEMA =
  'deepcode.session.projection-record.v4' as const;

export type SessionKernelPersistenceRecordKindV3 =
  | 'storeHeader'
  | 'input'
  | 'plan'
  | 'planDecision'
  | 'review'
  | 'planActionSettlement'
  | 'publicRequest'
  | 'publicRequestSettled'
  | 'checkpoint'
  | 'operationResult'
  | 'projection'
  | 'projectionDelivered'
  | 'toolContextSnapshot'
  | 'providerTurnDispatch'
  | 'providerTurnTerminal';

type SessionKernelWritablePersistenceRecordKindV3 = Exclude<
  SessionKernelPersistenceRecordKindV3,
  | 'toolContextSnapshot'
  | 'providerTurnDispatch'
  | 'providerTurnTerminal'
>;

export interface SessionKernelPersistenceRecordV3 {
  schemaVersion: typeof SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA;
  recordId: string;
  sessionId: string;
  runId: string;
  recordKind: SessionKernelPersistenceRecordKindV3;
  recordedAt: string;
  data: unknown;
  recordDigest: string;
}

type SessionKernelWritablePersistenceRecordV3 = Omit<
  SessionKernelPersistenceRecordV3,
  'recordKind'
> & {
  recordKind: SessionKernelWritablePersistenceRecordKindV3;
};

/** GET /api/session-store/:sessionId/session-runs/:runId response data. */
export interface SessionKernelPersistenceListReplyV2 {
  schemaVersion:
    typeof SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA;
  sessionId: string;
  runId: string;
  records: SessionKernelPersistenceRecordV3[];
}

/** POST /api/session-store/:sessionId/session-runs/:runId request body. */
export interface SessionKernelPersistenceAppendRequestV2 {
  schemaVersion:
    typeof SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA;
  sessionId: string;
  runId: string;
  record: SessionKernelWritablePersistenceRecordV3;
}

/** POST /api/session-store/:sessionId/session-runs/:runId response data. */
export interface SessionKernelPersistenceAppendReplyV2 {
  schemaVersion:
    typeof SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA;
  sessionId: string;
  runId: string;
  recordId: string;
  recordDigest: string;
  replayed: boolean;
}

export interface SessionKernelAppendOnlyRecordStoreV3 {
  list(): Promise<unknown[]>;
  append(record: SessionKernelWritablePersistenceRecordV3): Promise<void>;
}

type SessionKernelCheckpointCommitScopeV3 =
  | { kind: 'standalone' }
  | {
      kind: 'publicRequestSettlement';
      requestId: string;
      requestDigest: string;
      outcomeDigest: string;
    };

interface SessionKernelCompactProviderReservationV3 {
  providerTurnId: string;
  purpose: 'primary' | 'continuation' | 'finalAnswer';
  target: SessionProviderTurnTargetV2;
  planRevision?: string;
  correction?: import('./types.js').SessionToolCorrectionV2;
  controlEpoch: number;
  contextRef: import('@deepcode/protocol').ToolContextRefV2;
  factProjection: SessionProviderTurnRecordV2['factProjection'];
  contextAssembly: SessionProviderTurnRecordV2['contextAssembly'];
  startedAt: string;
  status: SessionProviderTurnRecordV2['status'];
  cancellationReason?: SessionProviderTurnRecordV2['cancellationReason'];
  dispatchRef?: SessionKernelPersistenceRecordRefV3;
  terminalRef?: SessionKernelPersistenceRecordRefV3;
}

interface SessionKernelCompactProviderQueueV3 {
  providerTurnId: string;
  terminalRef: SessionKernelPersistenceRecordRefV3;
  target: SessionProviderTurnTargetV2;
  calls: SessionProviderToolCallQueueItemV2[];
  mutationDisposition: SessionProviderToolCallQueueV2['mutationDisposition'];
  status: SessionProviderToolCallQueueV2['status'];
  outcomeRecorded: boolean;
  settledAt?: string;
  abortReason?: string;
}

type SessionKernelCompactFinalAnswerV3 = Omit<
  SessionFinalAnswerStateV3,
  'physicalRequestCount' | 'finalText'
>;

type SessionKernelCompactTerminalAnswerCandidateV1 = Omit<
  SessionTerminalAnswerCandidateV1,
  'text'
>;

interface SessionKernelCompactCheckpointV3 {
  schemaVersion: typeof SESSION_KERNEL_CHECKPOINT_V3_SCHEMA;
  checkpointRevision: number;
  savedAt: string;
  parentRef: SessionKernelPersistenceRecordRefV3 | null;
  commitScope: SessionKernelCheckpointCommitScopeV3;
  authority: {
    runId: string;
    workspaceBindingDigest: string;
    controlEpoch: number;
    currentInputId: string;
    currentInputRef: SessionKernelPersistenceRecordRefV3;
    providerProfileId: string;
    providerProfileRevisionDigest: string;
    toolContext: {
      currentRef: import('@deepcode/protocol').ToolContextRefV2;
      refreshRequired: boolean;
      expectedContextRef?: import('@deepcode/protocol').ToolContextRefV2;
    };
    workAuthority?: SessionWorkAuthorityV3;
    planRef?: SessionKernelPersistenceRecordRefV3;
    planConfirmation?: import('./types.js').SessionPlanConfirmationAuthorityV2;
    planDecisionRef?: SessionKernelPersistenceRecordRefV3;
    previews: SessionKernelLoopStateV2['previews'];
    operationPlanActionBindings: Record<
      string,
      SessionOperationPlanActionBindingV2
    >;
  };
  cursor: {
    inputRefs: SessionKernelPersistenceRecordRefV3[];
    inputHistoryOmittedCount: number;
    providerTerminalRefs: SessionKernelPersistenceRecordRefV3[];
    providerOutcomeHistoryOmittedCount: number;
    reviewFactsAfterLedgerSequence: number;
    afterLedgerSequence: number;
    snapshotHighWater: number;
  };
  active: {
    pendingEpochInputRef?: SessionKernelPersistenceRecordRefV3;
    activeWait?: SessionActiveWaitV2;
    interventionResearch?: SessionInterventionResearchV4;
    userIntervention?: SessionUserInterventionV4;
    userInterventionDecision?: SessionUserInterventionDecisionV4;
    pendingGuidance: string[];
    providerReservation?: SessionKernelCompactProviderReservationV3;
    providerQueue?: SessionKernelCompactProviderQueueV3;
    factBarriers: Record<string, SessionKernelFactBarrierV2>;
    publicRequests: Partial<Record<
      SessionKernelPublicRequestRecordV2['lane'],
      SessionKernelPersistenceRecordRefV3
    >>;
    runCancellation?: SessionRunCancellationV2;
    kernelWakeHint: boolean;
  };
  refs: {
    review?: SessionKernelPersistenceRecordRefV3;
    planActionSettlements: Record<
      string,
      SessionKernelPersistenceRecordRefV3
    >;
  };
  finalAnswer?: SessionKernelCompactFinalAnswerV3;
  terminalAnswerCandidate?: SessionKernelCompactTerminalAnswerCandidateV1;
}

interface SessionKernelProjectionRecordV3 {
  schemaVersion: typeof SESSION_KERNEL_PROJECTION_RECORD_V3_SCHEMA;
  commitScope: SessionKernelCheckpointCommitScopeV3;
  event: SessionKernelProjectionEventV2;
}

interface SessionKernelPublicRequestSettlementV3 {
  schemaVersion: typeof SESSION_KERNEL_PUBLIC_REQUEST_SETTLEMENT_V3_SCHEMA;
  requestId: string;
  requestDigest: string;
  outcomeDigest: string;
  checkpointRef: SessionKernelPersistenceRecordRefV3;
  projectionRefs: SessionKernelPersistenceRecordRefV3[];
}

/**
 * Strict client for the Host-owned per-Run Session persistence stream.
 * This endpoint must not alias transcript, wire-ledger, or projection files.
 * Host owns atomic append, fsync, file handles, and recordId/digest replay.
 */
export class HttpSessionKernelAppendOnlyRecordStoreV3
implements SessionKernelAppendOnlyRecordStoreV3 {
  private readonly endpoint: string;
  readonly #runCapability: string;

  constructor(
    private readonly sessionId: string,
    readonly runId: string,
    apiBase: string,
    privateAuth: SessionKernelTransportPrivateAuthV2,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    requiredIdentity(sessionId, 'sessionId');
    requiredIdentity(runId, 'runId');
    this.#runCapability = requiredText(
      privateAuth.runCapability,
      'runCapability'
    );
    this.endpoint = [
      normalizeApiBase(apiBase),
      'api/session-store',
      encodeURIComponent(sessionId),
      'session-runs',
      encodeURIComponent(runId),
    ].join('/');
  }

  async list(): Promise<unknown[]> {
    const response = await this.fetchImpl(this.endpoint, {
      headers: {
        'x-deepcode-run-capability': this.#runCapability,
      },
    });
    if (!response.ok) {
      throw await persistenceHttpError('read', response);
    }
    const envelope = exactObject(
      await response.json(),
      ['ok', 'data'],
      'session_kernel_persistence_list_response_invalid'
    );
    if (envelope.ok !== true) {
      throw new SessionKernelPersistenceError(
        'session_kernel_persistence_list_rejected',
        'Host rejected the dedicated v3 persistence read.'
      );
    }
    const data = exactObject(
      envelope.data,
      ['schemaVersion', 'sessionId', 'runId', 'records'],
      'session_kernel_persistence_list_response_invalid'
    );
    if (
      data.schemaVersion
        !== SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA
      || data.sessionId !== this.sessionId
      || data.runId !== this.runId
      || !Array.isArray(data.records)
    ) {
      throw new SessionKernelPersistenceError(
        'session_kernel_persistence_list_response_invalid',
        'Host returned an invalid dedicated v3 persistence response.'
      );
    }
    return cloneJson(data.records);
  }

  async append(
    record: SessionKernelWritablePersistenceRecordV3
  ): Promise<void> {
    if (
      record.sessionId !== this.sessionId
      || record.runId !== this.runId
    ) {
      throw new SessionKernelPersistenceError(
        'session_kernel_persistence_store_identity_mismatch',
        'Persistence record belongs to another Session or Kernel Run.'
      );
    }
    const request: SessionKernelPersistenceAppendRequestV2 = {
      schemaVersion:
        SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA,
      sessionId: this.sessionId,
      runId: this.runId,
      record,
    };
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-deepcode-run-capability': this.#runCapability,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const httpError = await persistenceHttpError('append', response);
      if (httpError instanceof UnsupportedHistorySchemaError) {
        throw httpError;
      }
      throw httpError;
    }
    const envelope = exactObject(
      await response.json(),
      ['ok', 'data'],
      'session_kernel_persistence_append_response_invalid'
    );
    if (envelope.ok !== true) {
      throw new SessionKernelPersistenceError(
        'session_kernel_persistence_append_rejected',
        'Host rejected the dedicated v3 persistence append.'
      );
    }
    const data = exactObject(
      envelope.data,
      [
        'schemaVersion',
        'sessionId',
        'runId',
        'recordId',
        'recordDigest',
        'replayed',
      ],
      'session_kernel_persistence_append_response_invalid'
    );
    if (
      data.schemaVersion
        !== SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA
      || data.sessionId !== this.sessionId
      || data.runId !== this.runId
      || data.recordId !== record.recordId
      || data.recordDigest !== record.recordDigest
      || typeof data.replayed !== 'boolean'
    ) {
      throw new SessionKernelPersistenceError(
        'session_kernel_persistence_append_response_invalid',
        'Host acknowledgement does not match the appended v2 record.'
      );
    }
  }
}

/**
 * Event-sourced v3 persistence. Every identity is immutable and replay-safe.
 * A non-v3 history fails closed with UnsupportedHistorySchema; no decoder,
 * migration, dual write, or fallback exists here.
 */
export class SessionKernelAppendOnlyPersistenceV3
implements SessionKernelPersistencePortV2 {
  private loadPromise?: Promise<SessionKernelPersistenceRecordV3[]>;
  private records?: SessionKernelPersistenceRecordV3[];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionId: string,
    readonly runId: string,
    historySchema: string,
    private readonly store: SessionKernelAppendOnlyRecordStoreV3
  ) {
    if (historySchema !== SESSION_KERNEL_PERSISTENCE_V3_SCHEMA) {
      throw new UnsupportedHistorySchemaError(historySchema);
    }
    requiredIdentity(sessionId, 'sessionId');
    requiredIdentity(runId, 'runId');
  }

  async loadCheckpoint(
    runId: string,
    recovery: SessionKernelCheckpointRecoveryInputV3
  ): Promise<SessionKernelCheckpointV2 | undefined> {
    this.requireRun(runId);
    const records = await this.loadRecords();
    const committed = committedSessionHistoryV3(records, this.runId);
    const checkpoints = committed.checkpoints
      .map((record) => ({
        record,
        checkpoint: decodeCompactCheckpointV3(
          record.data,
          this.runId,
          record.recordId
        ),
      }))
      .sort((left, right) =>
        left.checkpoint.checkpointRevision
          - right.checkpoint.checkpointRevision
      );
    const checkpointByRevision = new Map<number, string>();
    let parentRef: SessionKernelPersistenceRecordRefV3 | null = null;
    let previousRevision = 0;
    for (const { record, checkpoint } of checkpoints) {
      const digest = record.recordDigest;
      const previous = checkpointByRevision.get(
        checkpoint.checkpointRevision
      );
      if (previous && previous !== digest) {
        throw new SessionKernelPersistenceError(
          'session_kernel_checkpoint_revision_conflict',
          `Checkpoint revision ${checkpoint.checkpointRevision} has conflicting durable content.`
        );
      }
      checkpointByRevision.set(checkpoint.checkpointRevision, digest);
      if (
        checkpoint.checkpointRevision !== previousRevision + 1
        || !sameRecordRefV3(checkpoint.parentRef, parentRef)
      ) {
        throw new SessionKernelPersistenceError(
          'session_kernel_checkpoint_parent_conflict',
          `Checkpoint revision ${checkpoint.checkpointRevision} does not continue the committed checkpoint chain.`
        );
      }
      parentRef = recordRefV3(record);
      previousRevision = checkpoint.checkpointRevision;
    }
    const latest = checkpoints.at(-1);
    return latest
      ? materializeCompactCheckpointV3({
          checkpoint: latest.checkpoint,
          checkpointRecord: latest.record,
          records,
          committedCheckpoints: committed.checkpoints,
          committedProjections: committed.projections,
          recovery,
        })
      : undefined;
  }

  async loadProviderTurnEvidence(
    runId: string,
    providerTurnId: string
  ): Promise<SessionProviderTurnDurableEvidenceV3> {
    this.requireRun(runId);
    requiredIdentity(providerTurnId, 'providerTurnId');
    const records = await this.refreshRecords();
    return providerTurnEvidenceV3(
      records,
      this.runId,
      providerTurnId
    );
  }

  async loadToolContextSnapshot(
    runId: string,
    contextRef: ToolContextRefV2
  ): Promise<ToolContextBundleV2> {
    this.requireRun(runId);
    const records = await this.refreshRecords();
    return cloneJson(toolContextSnapshotByRefV3(
      new Map(records.map((record) => [record.recordId, record])),
      this.runId,
      contextRef
    ));
  }

  async loadLatestPlan(
    runId: string
  ): Promise<SessionNaturalLanguagePlanV2 | undefined> {
    this.requireRun(runId);
    return cloneJson(
      (await this.loadRecords())
        .filter((record) => record.recordKind === 'plan')
        .at(-1)?.data as SessionNaturalLanguagePlanV2 | undefined
    );
  }

  async loadLatestInput(
    runId: string
  ): Promise<SessionUserInputRecordV2 | undefined> {
    this.requireRun(runId);
    return cloneJson(
      (await this.loadRecords())
        .filter((record) => record.recordKind === 'input')
        .at(-1)?.data as SessionUserInputRecordV2 | undefined
    );
  }

  async loadInput(
    runId: string,
    inputId: string
  ): Promise<SessionUserInputRecordV2 | undefined> {
    this.requireRun(runId);
    requiredIdentity(inputId, 'inputId');
    const expectedRecordId = [
      'session-kernel-v3',
      runId,
      `input:${inputId}`,
    ].join(':');
    const record = (await this.loadRecords()).find(
      (candidate) =>
        candidate.recordKind === 'input'
        && candidate.recordId === expectedRecordId
    );
    if (!record) return undefined;
    const input = record.data as SessionUserInputRecordV2;
    if (input.inputId !== inputId) {
      throw new SessionKernelPersistenceError(
        'session_kernel_input_identity_mismatch',
        `Input ${inputId} does not match its durable record identity.`
      );
    }
    return cloneJson(input);
  }

  async loadPlanDecision(
    runId: string,
    planRevision: string
  ): Promise<SessionPlanDecisionV2 | undefined> {
    this.requireRun(runId);
    requiredIdentity(planRevision, 'planRevision');
    const expectedRecordId = [
      'session-kernel-v3',
      runId,
      `plan-decision:${planRevision}`,
    ].join(':');
    const record = (await this.loadRecords()).find(
      (candidate) =>
        candidate.recordKind === 'planDecision'
        && candidate.recordId === expectedRecordId
    );
    if (!record) return undefined;
    const decision = objectRecord(record.data);
    if (decision?.planRevision !== planRevision) {
      throw new SessionKernelPersistenceError(
        'session_kernel_plan_decision_identity_mismatch',
        `Plan decision ${planRevision} does not match its durable record identity.`
      );
    }
    return cloneJson(record.data as SessionPlanDecisionV2);
  }

  async loadPendingPublicRequests(
    runId: string
  ): Promise<SessionKernelPublicRequestRecordV2[]> {
    this.requireRun(runId);
    const pending = new Map<
      string,
      SessionKernelPublicRequestRecordV2
    >();
    const requestDigests = new Map<string, string>();
    const settledRequestIds = new Set<string>();
    for (const record of await this.loadRecords()) {
      if (record.recordKind === 'publicRequest') {
        const request = decodePersistedPublicRequestV2(
          record.data,
          this.runId,
          record.recordId
        );
        const requestDigest = publicRequestDigest(request);
        const boundDigest = requestDigests.get(request.requestId);
        if (boundDigest && boundDigest !== requestDigest) {
          throw new SessionKernelPersistenceError(
            'session_kernel_public_request_identity_conflict',
            `Kernel request ${request.requestId} changed its immutable lane or intent.`
          );
        }
        if (settledRequestIds.has(request.requestId)) {
          throw new SessionKernelPersistenceError(
            'session_kernel_public_request_reopened',
            `Settled Kernel request ${request.requestId} has a later durable attempt.`
          );
        }
        requestDigests.set(request.requestId, requestDigest);
        const previous = pending.get(request.requestId);
        if (previous && request.attemptCount <= previous.attemptCount) {
          throw new SessionKernelPersistenceError(
            'session_kernel_public_request_attempt_order_invalid',
            `Kernel request ${request.requestId} has a non-increasing durable attempt.`
          );
        }
        pending.set(request.requestId, cloneJson(request));
      }
      if (record.recordKind === 'publicRequestSettled') {
        const settlement = decodePublicRequestSettlement(
          record.data,
          this.runId,
          record.recordId
        );
        const request = pending.get(settlement.requestId);
        if (
          !request
          || requestDigests.get(settlement.requestId)
            !== settlement.requestDigest
          || publicRequestDigest(request) !== settlement.requestDigest
        ) {
          throw new SessionKernelPersistenceError(
            'session_kernel_public_request_settlement_identity_mismatch',
            `Settlement ${settlement.requestId} does not match a durable request identity and payload.`
          );
        }
        if (settledRequestIds.has(settlement.requestId)) {
          throw new SessionKernelPersistenceError(
            'session_kernel_public_request_settlement_conflict',
            `Kernel request ${settlement.requestId} has multiple settlements.`
          );
        }
        settledRequestIds.add(settlement.requestId);
        pending.delete(settlement.requestId);
      }
    }
    return [...pending.values()].sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt)
        || left.requestId.localeCompare(right.requestId)
    );
  }

  persistPlan(plan: SessionNaturalLanguagePlanV2): Promise<void> {
    return this.append(
      'plan',
      `plan:${plan.planRevision}`,
      plan,
      plan.recordedAt
    );
  }

  persistPlanDecision(
    decision: SessionPlanDecisionV2
  ): Promise<void> {
    return this.append(
      'planDecision',
      `plan-decision:${decision.planRevision}`,
      decision,
      decision.recordedAt
    );
  }

  persistInput(input: SessionUserInputRecordV2): Promise<void> {
    return this.append(
      'input',
      `input:${input.inputId}`,
      input,
      input.recordedAt
    );
  }

  persistPublicRequest(
    request: SessionKernelPublicRequestRecordV2
  ): Promise<void> {
    return this.append(
      'publicRequest',
      `request:${request.requestId}:attempt:${request.attemptCount}`,
      request,
      request.startedAt
    ).catch((error: unknown) => {
      if (error instanceof SessionKernelPublicRequestPersistenceError) {
        throw error;
      }
      const disposition = error instanceof SessionKernelPersistenceError
        ? error.replayDisposition
        : error instanceof UnsupportedHistorySchemaError
          ? 'doNotRetry'
          : 'retrySameRequest';
      throw new SessionKernelPublicRequestPersistenceError(
        disposition,
        error
      );
    });
  }

  settlePublicRequest(
    request: SessionKernelPublicRequestRecordV2,
    outcomeDigest: string,
    checkpoint: SessionKernelCheckpointV2,
    projections: SessionKernelProjectionEventV2[]
  ): Promise<void> {
    const exactOutcomeDigest = requiredDigest(
      outcomeDigest,
      'outcomeDigest'
    );
    const requestDigest = publicRequestDigest(request);
    const commitScope: SessionKernelCheckpointCommitScopeV3 = {
      kind: 'publicRequestSettlement',
      requestId: request.requestId,
      requestDigest,
      outcomeDigest: exactOutcomeDigest,
    };
    const operation = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await this.ensureInitialized(checkpoint.savedAt);
        const existingRecords = await this.refreshRecords();
        const markerId =
          `session-kernel-v3:${this.runId}:request:${request.requestId}:settled`;
        const existingMarker = existingRecords.find(
          (record) => record.recordId === markerId
        );
        if (existingMarker) {
          const marker = decodePublicRequestSettlement(
            existingMarker.data,
            this.runId,
            existingMarker.recordId
          );
          if (
            existingMarker.recordKind !== 'publicRequestSettled'
            || marker.requestDigest !== requestDigest
            || marker.outcomeDigest !== exactOutcomeDigest
          ) {
            throw new SessionKernelPersistenceError(
              'session_kernel_public_request_settlement_conflict',
              `Kernel request ${request.requestId} already has a different settlement.`
            );
          }
          committedSessionHistoryV3(existingRecords, this.runId);
          return;
        }
        const prepared = await this.preparePublicRequestSettlementRefs(
          checkpoint,
          projections,
          commitScope
        );
        const marker = createRecord({
          sessionId: this.sessionId,
          runId: this.runId,
          recordKind: 'publicRequestSettled',
          logicalId: `request:${request.requestId}:settled`,
          recordedAt: (prepared.checkpoint.data as
            SessionKernelCompactCheckpointV3).savedAt,
          data: {
            schemaVersion:
              SESSION_KERNEL_PUBLIC_REQUEST_SETTLEMENT_V3_SCHEMA,
            requestId: request.requestId,
            requestDigest,
            outcomeDigest: exactOutcomeDigest,
            checkpointRef: recordRefV3(prepared.checkpoint),
            projectionRefs: prepared.projections.map(recordRefV3),
          } satisfies SessionKernelPublicRequestSettlementV3,
        });
        await this.appendUnique(marker);
      });
    this.writeChain = operation;
    return operation;
  }

  persistCheckpoint(
    checkpoint: SessionKernelCheckpointV2
  ): Promise<void> {
    const operation = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await this.ensureInitialized(checkpoint.savedAt);
        await this.appendCheckpointRecord(
          checkpoint,
          { kind: 'standalone' }
        );
      });
    this.writeChain = operation;
    return operation;
  }

  async persistOperationResult(
    operationRequestId: string,
    result: unknown,
    recordedAt: string
  ): Promise<SessionKernelStoredOperationResultRefV2> {
    requiredIdentity(operationRequestId, 'operationRequestId');
    const resultDigest = sha256Hash(canonicalJson(result));
    const recordId = [
      'session-kernel-v3',
      this.runId,
      `operation-result:${operationRequestId}`,
    ].join(':');
    const operation = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await this.ensureInitialized(recordedAt);
        const records = await this.loadRecords();
        const existing = records.find(
          (candidate) => candidate.recordId === recordId
        );
        if (existing) {
          const data = exactObject(
            existing.data,
            [
              'schemaVersion',
              'operationRequestId',
              'resultDigest',
              'result',
            ],
            'session_kernel_operation_result_invalid'
          );
          if (
            existing.recordKind !== 'operationResult'
            || data.schemaVersion
              !== SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA
            || data.operationRequestId !== operationRequestId
            || data.resultDigest !== resultDigest
            || sha256Hash(canonicalJson(data.result)) !== resultDigest
          ) {
            throw new SessionKernelPersistenceError(
              'session_kernel_persistence_identity_conflict',
              `Operation result ${operationRequestId} changed immutable content.`
            );
          }
          return existing;
        }
        const created = createRecord({
          sessionId: this.sessionId,
          runId: this.runId,
          recordKind: 'operationResult',
          logicalId: `operation-result:${operationRequestId}`,
          recordedAt,
          data: {
            schemaVersion: SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA,
            operationRequestId,
            resultDigest,
            result: cloneJson(result),
          },
        });
        await this.appendUnique(created);
        return created;
      });
    this.writeChain = operation.then(() => undefined);
    const record = await operation;
    return {
      recordId: record.recordId,
      recordDigest: record.recordDigest,
      resultDigest,
    };
  }

  async loadOperationResult(
    operationRequestId: string
  ): Promise<SessionKernelStoredOperationResultV2 | undefined> {
    requiredIdentity(operationRequestId, 'operationRequestId');
    const recordId = [
      'session-kernel-v3',
      this.runId,
      `operation-result:${operationRequestId}`,
    ].join(':');
    const record = (await this.loadRecords()).find(
      (candidate) => candidate.recordId === recordId
    );
    if (!record) return undefined;
    const data = exactObject(
      record.data,
      [
        'schemaVersion',
        'operationRequestId',
        'resultDigest',
        'result',
      ],
      'session_kernel_operation_result_invalid'
    );
    const resultDigest = requiredDigest(
      data.resultDigest,
      'resultDigest'
    );
    if (
      record.recordKind !== 'operationResult'
      || data.schemaVersion !== SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA
      || data.operationRequestId !== operationRequestId
      || sha256Hash(canonicalJson(data.result)) !== resultDigest
    ) {
      throw new SessionKernelPersistenceError(
        'session_kernel_operation_result_invalid',
        `Operation result ${operationRequestId} is not exact durable v3 data.`
      );
    }
    return {
      resultDigest,
      result: cloneJson(data.result),
    };
  }

  persistProjection(
    event: SessionKernelProjectionEventV2
  ): Promise<void> {
    validateCurrentSessionKernelProjectionEventV2(event);
    return this.append(
      'projection',
      `projection:${event.projectionId}`,
      projectionRecordDataV3(event, { kind: 'standalone' }),
      event.recordedAt
    );
  }

  persistProjectionDelivered(
    event: SessionKernelProjectionEventV2
  ): Promise<void> {
    return this.append(
      'projectionDelivered',
      `projection-delivery:${event.projectionId}`,
      {
        projectionId: event.projectionId,
        projectionDigest: projectionDigest(event),
      },
      event.recordedAt
    );
  }

  async loadUndeliveredProjections(
    runId: string
  ): Promise<SessionKernelProjectionEventV2[]> {
    this.requireRun(runId);
    const projected = new Map<
      string,
      SessionKernelProjectionEventV2
    >();
    const delivered = new Map<string, string>();
    const records = await this.loadRecords();
    const committed = committedSessionHistoryV3(records, this.runId);
    for (const record of records) {
      if (
        record.recordKind === 'projection'
        && committed.projections.some(
          (candidate) => candidate.recordId === record.recordId
        )
      ) {
        const event = decodeProjectionRecordV3(
          record.data,
          this.runId
        ).event;
        const previous = projected.get(event.projectionId);
        if (
          previous
          && projectionDigest(previous) !== projectionDigest(event)
        ) {
          throw new SessionKernelPersistenceError(
            'session_kernel_projection_identity_conflict',
            `Projection ${event.projectionId} changed immutable content.`
          );
        }
        projected.set(event.projectionId, event);
      }
      if (record.recordKind === 'projectionDelivered') {
        const receipt = decodeProjectionDelivery(record.data);
        const previous = delivered.get(receipt.projectionId);
        if (previous && previous !== receipt.projectionDigest) {
          throw new SessionKernelPersistenceError(
            'session_kernel_projection_delivery_conflict',
            `Projection ${receipt.projectionId} has conflicting delivery receipts.`
          );
        }
        delivered.set(
          receipt.projectionId,
          receipt.projectionDigest
        );
      }
    }
    for (const [projectionId, digest] of delivered) {
      const event = projected.get(projectionId);
      if (!event || projectionDigest(event) !== digest) {
        throw new SessionKernelPersistenceError(
          'session_kernel_projection_delivery_orphaned',
          `Projection ${projectionId} delivery has no matching durable event.`
        );
      }
    }
    return [...projected.values()]
      .filter(
        (event) =>
          delivered.get(event.projectionId)
            !== projectionDigest(event)
      )
      .map(cloneJson);
  }

  async loadProjectionEvents(
    runId: string
  ): Promise<SessionKernelProjectionEventV2[]> {
    this.requireRun(runId);
    const records = await this.loadRecords();
    const committed = committedSessionHistoryV3(records, this.runId);
    const projected = new Map<string, SessionKernelProjectionEventV2>();
    for (const record of committed.projections) {
      const event = decodeProjectionRecordV3(
        record.data,
        this.runId
      ).event;
      {
        const previous = projected.get(event.projectionId);
        if (
          previous
          && projectionDigest(previous) !== projectionDigest(event)
        ) {
          throw new SessionKernelPersistenceError(
            'session_kernel_projection_identity_conflict',
            `Projection ${event.projectionId} changed immutable content.`
          );
        }
        if (!previous) projected.set(event.projectionId, event);
      }
    }
    return [...projected.values()].map(cloneJson);
  }

  private append(
    recordKind: SessionKernelWritablePersistenceRecordKindV3,
    logicalId: string,
    data: unknown,
    recordedAt: string
  ): Promise<void> {
    return this.appendRecord(
      recordKind,
      logicalId,
      data,
      recordedAt
    ).then(() => undefined);
  }

  private appendRecord(
    recordKind: SessionKernelWritablePersistenceRecordKindV3,
    logicalId: string,
    data: unknown,
    recordedAt: string
  ): Promise<SessionKernelPersistenceRecordV3> {
    const operation = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await this.ensureInitialized(recordedAt);
        const record = createRecord({
          sessionId: this.sessionId,
          runId: this.runId,
          recordKind,
          logicalId,
          recordedAt,
          data,
        });
        await this.appendUnique(record);
        return record;
      });
    this.writeChain = operation.then(() => undefined);
    return operation;
  }

  private async appendCheckpointRecord(
    checkpoint: SessionKernelCheckpointV2,
    commitScope: SessionKernelCheckpointCommitScopeV3
  ): Promise<SessionKernelPersistenceRecordV3> {
    await this.appendCheckpointAuthorityRecords(checkpoint.state);
    const records = await this.refreshRecords();
    const committed = committedSessionHistoryV3(records, this.runId);
    const previous = committed.checkpoints
      .map((record) => ({
        record,
        revision: decodeCompactCheckpointV3(
          record.data,
          this.runId,
          record.recordId
        ).checkpointRevision,
      }))
      .sort((left, right) => left.revision - right.revision)
      .at(-1);
    const expectedRevision = (previous?.revision ?? 0) + 1;
    if (checkpoint.checkpointRevision !== expectedRevision) {
      throw new SessionKernelPersistenceError(
        'session_kernel_checkpoint_revision_noncontiguous',
        `Checkpoint revision ${checkpoint.checkpointRevision} does not immediately continue revision ${expectedRevision - 1}.`
      );
    }
    const data = compactCheckpointFromStateV3({
      checkpoint,
      records,
      parentRef: previous ? recordRefV3(previous.record) : null,
      commitScope,
    });
    const record = createRecord({
      sessionId: this.sessionId,
      runId: this.runId,
      recordKind: 'checkpoint',
      logicalId: `checkpoint:${checkpoint.checkpointRevision}`,
      recordedAt: checkpoint.savedAt,
      data,
    });
    await this.appendUnique(record);
    return record;
  }

  private async preparePublicRequestSettlementRefs(
    checkpoint: SessionKernelCheckpointV2,
    projections: readonly SessionKernelProjectionEventV2[],
    commitScope: Extract<
      SessionKernelCheckpointCommitScopeV3,
      { kind: 'publicRequestSettlement' }
    >
  ): Promise<{
    checkpoint: SessionKernelPersistenceRecordV3;
    projections: SessionKernelPersistenceRecordV3[];
  }> {
    await this.appendCheckpointAuthorityRecords(checkpoint.state);
    const records = await this.refreshRecords();
    const committed = committedSessionHistoryV3(records, this.runId);
    const committedCheckpointIds = new Set(
      committed.checkpoints.map((record) => record.recordId)
    );
    const committedProjectionIds = new Set(
      committed.projections.map((record) => record.recordId)
    );
    const orphanCheckpoints = records.filter((record) =>
      record.recordKind === 'checkpoint'
      && !committedCheckpointIds.has(record.recordId)
      && canonicalJson(
        (record.data as SessionKernelCompactCheckpointV3).commitScope
      ) === canonicalJson(commitScope)
    );
    const orphanProjections = records.filter((record) =>
      record.recordKind === 'projection'
      && !committedProjectionIds.has(record.recordId)
      && canonicalJson(
        (record.data as SessionKernelProjectionRecordV3).commitScope
      ) === canonicalJson(commitScope)
    );
    if (orphanCheckpoints.length > 1) {
      throw new SessionKernelPersistenceError(
        'session_kernel_public_request_orphan_conflict',
        `Settlement ${commitScope.requestId} has multiple orphan checkpoints.`
      );
    }
    const latest = committed.checkpoints
      .map((record) => ({
        record,
        revision: (record.data as SessionKernelCompactCheckpointV3)
          .checkpointRevision,
      }))
      .sort((left, right) => left.revision - right.revision)
      .at(-1);
    const expectedParent = latest ? recordRefV3(latest.record) : null;
    const expectedRevision = (latest?.revision ?? 0) + 1;
    const orphanCheckpoint = orphanCheckpoints[0];
    if (orphanCheckpoint) {
      const orphan = orphanCheckpoint.data as
        SessionKernelCompactCheckpointV3;
      if (
        orphan.checkpointRevision !== expectedRevision
        || !sameRecordRefV3(orphan.parentRef, expectedParent)
        || checkpoint.checkpointRevision !== expectedRevision
      ) {
        throw new SessionKernelPersistenceError(
          'session_kernel_public_request_orphan_conflict',
          `Settlement ${commitScope.requestId} orphan checkpoint does not continue the latest committed state.`
        );
      }
      const replayCheckpoint: SessionKernelCheckpointV2 = {
        ...cloneJson(checkpoint),
        savedAt: orphan.savedAt,
      };
      const expectedData = compactCheckpointFromStateV3({
        checkpoint: replayCheckpoint,
        records,
        parentRef: expectedParent,
        commitScope,
      });
      if (canonicalJson(expectedData) !== canonicalJson(orphan)) {
        throw new SessionKernelPersistenceError(
          'session_kernel_public_request_orphan_conflict',
          `Settlement ${commitScope.requestId} replay changed orphan checkpoint content.`
        );
      }
      const expectedProjectionIds = projections.map((event) =>
        `session-kernel-v3:${this.runId}:projection:${event.projectionId}`
      );
      const orphanProjectionsById = new Map(
        orphanProjections.map((record) => [record.recordId, record])
      );
      const expectedOrphanPrefix = expectedProjectionIds.slice(
        0,
        orphanProjections.length
      );
      if (
        new Set(expectedProjectionIds).size !== projections.length
        || orphanProjections.length > projections.length
        || expectedOrphanPrefix.some((recordId) =>
          !orphanProjectionsById.has(recordId)
        )
      ) {
        throw new SessionKernelPersistenceError(
          'session_kernel_public_request_orphan_projection_conflict',
          `Settlement ${commitScope.requestId} replay changed the orphan projection set.`
        );
      }
      const projectionRecords: SessionKernelPersistenceRecordV3[] = [];
      for (const [index, event] of projections.entries()) {
        const orphanRecord = orphanProjectionsById.get(
          expectedProjectionIds[index]!
        );
        if (!orphanRecord) {
          const projectionRecord = createRecord({
            sessionId: this.sessionId,
            runId: this.runId,
            recordKind: 'projection',
            logicalId: `projection:${event.projectionId}`,
            recordedAt: event.recordedAt,
            data: projectionRecordDataV3(event, commitScope),
          });
          await this.appendUnique(projectionRecord);
          projectionRecords.push(projectionRecord);
          continue;
        }
        const orphanEvent = (orphanRecord.data as
          SessionKernelProjectionRecordV3).event;
        const normalizedReplay = {
          ...cloneJson(event),
          recordedAt: orphanEvent.recordedAt,
        };
        if (canonicalJson(normalizedReplay) !== canonicalJson(orphanEvent)) {
          throw new SessionKernelPersistenceError(
            'session_kernel_public_request_orphan_projection_conflict',
            `Settlement ${commitScope.requestId} replay changed projection ${event.projectionId}.`
          );
        }
        projectionRecords.push(orphanRecord);
      }
      return {
        checkpoint: orphanCheckpoint,
        projections: projectionRecords,
      };
    }
    if (orphanProjections.length > 0) {
      throw new SessionKernelPersistenceError(
        'session_kernel_public_request_orphan_projection_conflict',
        `Settlement ${commitScope.requestId} has projections without its unique orphan checkpoint.`
      );
    }
    const checkpointRecord = await this.appendCheckpointRecord(
      checkpoint,
      commitScope
    );
    const projectionRecords: SessionKernelPersistenceRecordV3[] = [];
    for (const event of projections) {
      const projectionRecord = createRecord({
        sessionId: this.sessionId,
        runId: this.runId,
        recordKind: 'projection',
        logicalId: `projection:${event.projectionId}`,
        recordedAt: event.recordedAt,
        data: projectionRecordDataV3(event, commitScope),
      });
      await this.appendUnique(projectionRecord);
      projectionRecords.push(projectionRecord);
    }
    return { checkpoint: checkpointRecord, projections: projectionRecords };
  }

  private async appendCheckpointAuthorityRecords(
    state: SessionKernelLoopStateV2
  ): Promise<void> {
    if (state.review) {
      const review = createRecord({
        sessionId: this.sessionId,
        runId: this.runId,
        recordKind: 'review',
        logicalId: `review:${state.review.revision}`,
        recordedAt: state.review.finalizedAt ?? state.review.createdAt,
        data: {
          schemaVersion: SESSION_KERNEL_REVIEW_RECORD_V3_SCHEMA,
          review: cloneJson(state.review),
        },
      });
      await this.appendUnique(review);
    }
    for (const settlement of Object.values(
      state.planActionSettlements
    )) {
      const record = createRecord({
        sessionId: this.sessionId,
        runId: this.runId,
        recordKind: 'planActionSettlement',
        logicalId:
          `plan-action-settlement:${settlement.planActionId}`,
        recordedAt: settlement.recordedAt,
        data: {
          schemaVersion:
            SESSION_KERNEL_PLAN_ACTION_SETTLEMENT_RECORD_V3_SCHEMA,
          settlement: cloneJson(settlement),
        },
      });
      await this.appendUnique(record);
    }
  }

  private async ensureInitialized(recordedAt: string): Promise<void> {
    const records = await this.loadRecords();
    if (records.some((record) => record.recordKind === 'storeHeader')) {
      return;
    }
    const header = createRecord({
      sessionId: this.sessionId,
      runId: this.runId,
      recordKind: 'storeHeader',
      logicalId: 'store',
      recordedAt,
      data: {
        schemaVersion: SESSION_KERNEL_PERSISTENCE_V3_SCHEMA,
      },
    });
    await this.appendUnique(header);
  }

  private async appendUnique(
    record: SessionKernelWritablePersistenceRecordV3
  ): Promise<void> {
    const records = await this.loadRecords();
    const existing = records.find(
      (candidate) => candidate.recordId === record.recordId
    );
    if (existing) {
      if (existing.recordDigest !== record.recordDigest) {
        throw new SessionKernelPersistenceError(
          'session_kernel_persistence_identity_conflict',
          `Persistence record ${record.recordId} changed immutable content.`
        );
      }
      return;
    }
    try {
      await this.store.append(record);
    } catch (appendError) {
      let refreshed: SessionKernelPersistenceRecordV3[];
      try {
        refreshed = await this.readRecords();
      } catch (readError) {
        this.records = undefined;
        this.loadPromise = undefined;
        if (
          readError instanceof UnsupportedHistorySchemaError
          || (
            readError instanceof SessionKernelPersistenceError
            && readError.code
              === 'session_kernel_persistence_identity_conflict'
          )
        ) {
          throw readError;
        }
        throw appendError;
      }
      const durable = refreshed.find(
        (candidate) => candidate.recordId === record.recordId
      );
      if (durable) {
        if (durable.recordDigest !== record.recordDigest) {
          throw new SessionKernelPersistenceError(
            'session_kernel_persistence_identity_conflict',
            `Persistence record ${record.recordId} changed immutable content.`
          );
        }
        return;
      }
      throw appendError;
    }
    const current = this.records ?? records;
    if (
      !current.some(
        (candidate) => candidate.recordId === record.recordId
      )
    ) {
      current.push(cloneJson(record));
    }
  }

  private loadRecords(): Promise<SessionKernelPersistenceRecordV3[]> {
    if (this.records) return Promise.resolve(this.records);
    this.loadPromise ??= this.readRecords();
    return this.loadPromise;
  }

  private async refreshRecords():
  Promise<SessionKernelPersistenceRecordV3[]> {
    this.records = undefined;
    this.loadPromise = undefined;
    return this.readRecords();
  }

  private async readRecords(): Promise<SessionKernelPersistenceRecordV3[]> {
    const rawEntries = await this.store.list();
    const records: SessionKernelPersistenceRecordV3[] = [];
    for (const rawEntry of rawEntries) {
      const record = objectRecord(rawEntry);
      if (!record) {
        throw new UnsupportedHistorySchemaError(
          'invalid-dedicated-store-record'
        );
      }
      records.push(
        decodeRecord(record, this.sessionId, this.runId)
      );
    }
    if (records.length > 0) {
      const headers = records.filter(
        (record) => record.recordKind === 'storeHeader'
      );
      if (
        records[0]?.recordKind !== 'storeHeader'
        || headers.length !== 1
        || headers[0]?.recordId !== headerRecordId(this.runId)
        || !isValidStoreHeaderData(headers[0].data)
      ) {
        throw new UnsupportedHistorySchemaError(
          'invalid-dedicated-store-header'
        );
      }
    }
    const byId = new Map<string, SessionKernelPersistenceRecordV3>();
    for (const record of records) {
      const existing = byId.get(record.recordId);
      if (existing && existing.recordDigest !== record.recordDigest) {
        throw new SessionKernelPersistenceError(
          'session_kernel_persistence_identity_conflict',
          `Persistence record ${record.recordId} has conflicting durable copies.`
        );
      }
      if (!existing) byId.set(record.recordId, record);
    }
    const deduplicated = [...byId.values()];
    for (const record of deduplicated) {
      if (record.recordKind !== 'providerTurnDispatch') continue;
      const providerTurnId = (record.data as
        SessionProviderTurnDispatchRecordV3['data']).providerTurnId;
      providerTurnEvidenceV3(
        deduplicated,
        this.runId,
        providerTurnId
      );
    }
    if (deduplicated.some((record) =>
      record.recordKind === 'providerTurnTerminal'
      && !deduplicated.some((candidate) =>
        candidate.recordKind === 'providerTurnDispatch'
        && (candidate.data as SessionProviderTurnDispatchRecordV3['data'])
          .providerTurnId
          === (record.data as SessionProviderTurnTerminalRecordV3['data'])
            .providerTurnId
      )
    )) {
      throw new SessionKernelPersistenceError(
        'session_kernel_provider_terminal_dispatch_missing',
        'Provider terminal history contains an orphan terminal.'
      );
    }
    this.records = deduplicated;
    return deduplicated;
  }

  private requireRun(runId: string): void {
    if (runId !== this.runId) {
      throw new SessionKernelPersistenceError(
        'session_kernel_persistence_run_mismatch',
        'Session persistence request belongs to another Kernel Run.'
      );
    }
  }
}

export interface SessionKernelHostProjectionSinkV2 {
  publish(
    event: SessionKernelProjectionEventV2,
    projectionHistory: () => Promise<SessionKernelProjectionEventV2[]>
  ): Promise<SessionKernelProjectionReceiptV2>;
}

export class DurableSessionKernelProjectionV2
implements SessionKernelProjectionPortV2 {
  constructor(
    private readonly persistence:
      SessionKernelAppendOnlyPersistenceV3,
    private readonly sink?: SessionKernelHostProjectionSinkV2
  ) {}

  async project(
    event: SessionKernelProjectionEventV2
  ): Promise<SessionKernelProjectionReceiptV2> {
    await this.persistence.persistProjection(event);
    if (this.sink) {
      let receipt: SessionKernelProjectionReceiptV2;
      try {
        receipt = await this.sink.publish(
          cloneJson(event),
          () => this.projectionHistoryThrough(event.projectionId)
        );
      } catch (error) {
        throw new SessionKernelProjectionDeliveryErrorV2(
          event.projectionId,
          'publish',
          error
        );
      }
      try {
        await this.persistence.persistProjectionDelivered(event);
      } catch (error) {
        throw new SessionKernelProjectionDeliveryErrorV2(
          event.projectionId,
          'deliveryReceipt',
          error
        );
      }
      return receipt;
    }
    return {
      projectionId: event.projectionId,
      projectionDigest: sha256Hash(canonicalJson(event)),
      delivered: false,
    };
  }

  async flushPending(runId: string): Promise<void> {
    if (!this.sink) return;
    const pending = await this.persistence
      .loadUndeliveredProjections(runId);
    for (const event of pending) {
      try {
        await this.sink.publish(
          cloneJson(event),
          () => this.projectionHistoryThrough(event.projectionId)
        );
      } catch (error) {
        throw new SessionKernelProjectionDeliveryErrorV2(
          event.projectionId,
          'publish',
          error
        );
      }
      try {
        await this.persistence.persistProjectionDelivered(event);
      } catch (error) {
        throw new SessionKernelProjectionDeliveryErrorV2(
          event.projectionId,
          'deliveryReceipt',
          error
        );
      }
    }
  }

  private async projectionHistoryThrough(
    projectionId: string
  ): Promise<SessionKernelProjectionEventV2[]> {
    const history = await this.persistence.loadProjectionEvents(
      this.persistence.runId
    );
    const index = history.findIndex(
      (event) => event.projectionId === projectionId
    );
    if (index < 0) {
      throw new SessionKernelPersistenceError(
        'session_kernel_projection_history_missing',
        `Projection ${projectionId} is missing from durable history.`
      );
    }
    return history.slice(0, index + 1);
  }
}

const SESSION_KERNEL_PROJECTION_KINDS_V2 = new Set<
  SessionKernelProjectionEventV2['kind']
>([
  'plan.persisted',
  'plan.decided',
  'plan.commentaryReleased',
  'plan.confirmationReady',
  'input.persisted',
  'scope.previewed',
  'provider.started',
  'provider.composing',
  'provider.completed',
  'provider.answerState',
  'provider.stale',
  'toolIntent.submitted',
  'capability.awaiting',
  'kernelFacts.reconciled',
  'authorization.decided',
  'review.revised',
  'planAction.completed',
  'userIntervention.changed',
  'run.cancelled',
  'wait.changed',
  'diagnostic',
]);

function decodeProjectionEvent(
  value: unknown,
  runId: string
): SessionKernelProjectionEventV2 {
  const record = objectRecord(value);
  const expected = [
    'projectionId',
    'runId',
    'recordedAt',
    'kind',
    'data',
  ].sort();
  const actual = record ? Object.keys(record).sort() : [];
  if (
    !record
    || actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || record.runId !== runId
    || !SESSION_KERNEL_PROJECTION_KINDS_V2.has(
      record.kind as SessionKernelProjectionEventV2['kind']
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'invalid-v2-projection-record'
    );
  }
  const event: SessionKernelProjectionEventV2 = {
    projectionId: requiredIdentity(
      record.projectionId,
      'projectionId'
    ),
    runId,
    recordedAt: requiredText(record.recordedAt, 'recordedAt'),
    kind: record.kind as SessionKernelProjectionEventV2['kind'],
    data: cloneJson(record.data),
  };
  validateCurrentSessionKernelProjectionEventV2(event);
  assertNoTransportCapabilities(event.data);
  return event;
}

function decodeProjectionDelivery(value: unknown): {
  projectionId: string;
  projectionDigest: string;
} {
  const record = objectRecord(value);
  const expected = ['projectionId', 'projectionDigest'].sort();
  const actual = record ? Object.keys(record).sort() : [];
  if (
    !record
    || actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new UnsupportedHistorySchemaError(
      'invalid-v2-projection-delivery-record'
    );
  }
  return {
    projectionId: requiredIdentity(
      record.projectionId,
      'projectionId'
    ),
    projectionDigest: requiredIdentity(
      record.projectionDigest,
      'projectionDigest'
    ),
  };
}

function projectionDigest(
  event: SessionKernelProjectionEventV2
): string {
  assertNoTransportCapabilities(event);
  return sha256Hash(canonicalJson(event));
}

function projectionRecordDataV3(
  event: SessionKernelProjectionEventV2,
  commitScope: SessionKernelCheckpointCommitScopeV3
): SessionKernelProjectionRecordV3 {
  return {
    schemaVersion: SESSION_KERNEL_PROJECTION_RECORD_V3_SCHEMA,
    commitScope: cloneJson(commitScope),
    event: cloneJson(event),
  };
}

function decodeProjectionRecordV3(
  value: unknown,
  runId: string
): SessionKernelProjectionRecordV3 {
  const record = exactObject(
    value,
    ['schemaVersion', 'commitScope', 'event'],
    'session_kernel_projection_record_invalid'
  );
  if (record.schemaVersion !== SESSION_KERNEL_PROJECTION_RECORD_V3_SCHEMA) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_projection_record_invalid'
    );
  }
  return {
    schemaVersion: SESSION_KERNEL_PROJECTION_RECORD_V3_SCHEMA,
    commitScope: decodeCommitScopeV3(record.commitScope),
    event: decodeProjectionEvent(record.event, runId),
  };
}

function decodePersistedPublicRequestV2(
  value: unknown,
  runId: string,
  recordId: string
): SessionKernelPublicRequestRecordV2 {
  const record = exactObject(
    value,
    ['requestId', 'lane', 'intent', 'startedAt', 'attemptCount'],
    'session_kernel_public_request_invalid'
  );
  const requestId = requiredIdentity(record.requestId, 'requestId');
  const attemptCount = record.attemptCount;
  if (!Number.isSafeInteger(attemptCount) || (attemptCount as number) < 1) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_public_request_attempt_invalid'
    );
  }
  if (
    recordId
      !== `session-kernel-v3:${runId}:request:${requestId}:attempt:${attemptCount}`
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_public_request_identity_invalid'
    );
  }
  const intent = exactObject(
    record.intent,
    ['kind', 'payload'],
    'session_kernel_public_request_intent_invalid'
  );
  const payload = objectRecord(intent.payload);
  const expectedLane = intent.kind === 'controlEpochAdvance'
      || intent.kind === 'invocationCancel'
    ? 'control'
    : intent.kind === 'toolIntentSubmit'
      ? 'effect'
      : intent.kind === 'toolContextGet'
          || intent.kind === 'capabilityPreviewBatch'
          || intent.kind === 'factsQuery'
        ? 'query'
        : undefined;
  if (!payload || !expectedLane || record.lane !== expectedLane) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_public_request_intent_invalid'
    );
  }
  const startedAt = requiredText(record.startedAt, 'startedAt');
  if (!Number.isFinite(Date.parse(startedAt))) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_public_request_time_invalid'
    );
  }
  return {
    requestId,
    lane: expectedLane,
    intent: {
      kind: intent.kind,
      payload: cloneJson(payload),
    } as SessionKernelPublicRequestRecordV2['intent'],
    startedAt,
    attemptCount: attemptCount as number,
  };
}

function decodePublicRequestSettlement(
  value: unknown,
  runId: string,
  recordId: string
): SessionKernelPublicRequestSettlementV3 {
  const record = exactObject(
    value,
    [
      'schemaVersion',
      'requestId',
      'requestDigest',
      'outcomeDigest',
      'checkpointRef',
      'projectionRefs',
    ],
    'session_kernel_public_request_settlement_invalid'
  );
  if (
    record.schemaVersion
      !== SESSION_KERNEL_PUBLIC_REQUEST_SETTLEMENT_V3_SCHEMA
    || !Array.isArray(record.projectionRefs)
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_public_request_settlement_invalid'
    );
  }
  const requestId = requiredIdentity(record.requestId, 'requestId');
  if (
    recordId !== `session-kernel-v3:${runId}:request:${requestId}:settled`
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_public_request_settlement_identity_invalid'
    );
  }
  const requestDigest = requiredDigest(
    record.requestDigest,
    'requestDigest'
  );
  const outcomeDigest = requiredDigest(
    record.outcomeDigest,
    'outcomeDigest'
  );
  return {
    schemaVersion: SESSION_KERNEL_PUBLIC_REQUEST_SETTLEMENT_V3_SCHEMA,
    requestId,
    requestDigest,
    outcomeDigest,
    checkpointRef: decodeRecordRefV3(record.checkpointRef),
    projectionRefs: record.projectionRefs.map(decodeRecordRefV3),
  };
}

function publicRequestDigest(
  request: SessionKernelPublicRequestRecordV2
): string {
  return sha256Hash(canonicalJson({
    requestId: request.requestId,
    lane: request.lane,
    intent: request.intent,
  }));
}

function requiredDigest(value: unknown, field: string): string {
  const digest = requiredIdentity(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new SessionKernelPersistenceError(
      'session_kernel_persistence_digest_invalid',
      `${field} is not a canonical sha256 digest.`
    );
  }
  return digest;
}

function createRecord(input: {
  sessionId: string;
  runId: string;
  recordKind: SessionKernelWritablePersistenceRecordKindV3;
  logicalId: string;
  recordedAt: string;
  data: unknown;
}): SessionKernelWritablePersistenceRecordV3 {
  requiredIdentity(input.logicalId, 'logicalId');
  requiredText(input.recordedAt, 'recordedAt');
  assertNoTransportCapabilities(input.data);
  const withoutDigest = {
    schemaVersion: SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA,
    recordId: [
      'session-kernel-v3',
      input.runId,
      input.logicalId,
    ].join(':'),
    sessionId: input.sessionId,
    runId: input.runId,
    recordKind: input.recordKind,
    recordedAt: input.recordedAt,
    data: cloneJson(input.data),
  };
  return {
    ...withoutDigest,
    recordDigest: sha256Hash(canonicalJson(withoutDigest)),
  };
}

function headerRecordId(runId: string): string {
  return `session-kernel-v3:${runId}:store`;
}

function isValidStoreHeaderData(value: unknown): boolean {
  const record = objectRecord(value);
  return !!record
    && Object.keys(record).length === 1
    && record.schemaVersion === SESSION_KERNEL_PERSISTENCE_V3_SCHEMA;
}

function decodeRecord(
  value: Record<string, unknown>,
  sessionId: string,
  runId: string
): SessionKernelPersistenceRecordV3 {
  const expected = [
    'schemaVersion',
    'recordId',
    'sessionId',
    'runId',
    'recordKind',
    'recordedAt',
    'data',
    'recordDigest',
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || value.schemaVersion !== SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA
    || value.sessionId !== sessionId
    || value.runId !== runId
  ) {
    throw new UnsupportedHistorySchemaError('invalid-v3-record');
  }
  const recordKind = value.recordKind;
  if (
    recordKind !== 'storeHeader'
    && recordKind !== 'input'
    && recordKind !== 'plan'
    && recordKind !== 'planDecision'
    && recordKind !== 'review'
    && recordKind !== 'planActionSettlement'
    && recordKind !== 'publicRequest'
    && recordKind !== 'publicRequestSettled'
    && recordKind !== 'checkpoint'
    && recordKind !== 'operationResult'
    && recordKind !== 'projection'
    && recordKind !== 'projectionDelivered'
    && recordKind !== 'toolContextSnapshot'
    && recordKind !== 'providerTurnDispatch'
    && recordKind !== 'providerTurnTerminal'
  ) {
    throw new UnsupportedHistorySchemaError('unknown-v3-record-kind');
  }
  const withoutDigest = {
    schemaVersion: SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA,
    recordId: requiredIdentity(value.recordId, 'recordId'),
    sessionId,
    runId,
    recordKind: recordKind as SessionKernelPersistenceRecordKindV3,
    recordedAt: requiredText(value.recordedAt, 'recordedAt'),
    data: decodeRecordDataV3(
      recordKind as SessionKernelPersistenceRecordKindV3,
      value.data,
      runId,
      requiredIdentity(value.recordId, 'recordId')
    ),
  };
  const recordDigest = requiredIdentity(
    value.recordDigest,
    'recordDigest'
  );
  if (recordDigest !== sha256Hash(canonicalJson(withoutDigest))) {
    throw new SessionKernelPersistenceError(
      'session_kernel_persistence_digest_mismatch',
      `Persistence record ${withoutDigest.recordId} failed digest verification.`
    );
  }
  assertNoTransportCapabilities(withoutDigest.data);
  return { ...withoutDigest, recordDigest };
}

function decodeRecordDataV3(
  recordKind: SessionKernelPersistenceRecordKindV3,
  value: unknown,
  runId: string,
  recordId: string
): unknown {
  switch (recordKind) {
    case 'input':
      return decodePersistedSessionInputV2(value);
    case 'plan':
      return decodePersistedPlanIdentityV3(value, runId, recordId);
    case 'planDecision':
      return decodePersistedPlanDecisionIdentityV3(
        value,
        runId,
        recordId
      );
    case 'publicRequest':
      return decodePersistedPublicRequestV2(value, runId, recordId);
    case 'checkpoint':
      return decodeCompactCheckpointV3(value, runId, recordId);
    case 'projection':
      return decodeProjectionRecordV3(value, runId);
    case 'publicRequestSettled':
      return decodePublicRequestSettlement(value, runId, recordId);
    case 'toolContextSnapshot':
      return decodeToolContextSnapshotDataV3(value, runId, recordId);
    case 'providerTurnDispatch':
      return decodeProviderTurnDispatchDataV3(value, runId, recordId);
    case 'providerTurnTerminal':
      return decodeProviderTurnTerminalDataV3(value, runId, recordId);
    case 'review':
      return decodeReviewRecordDataV3(value, runId, recordId);
    case 'planActionSettlement':
      return decodePlanActionSettlementRecordDataV3(
        value,
        runId,
        recordId
      );
    case 'projectionDelivered':
      return decodeProjectionDelivery(value);
    default:
      return cloneJson(value);
  }
}

function decodeToolContextSnapshotDataV3(
  value: unknown,
  runId: string,
  recordId: string
): SessionToolContextSnapshotRecordV3['data'] {
  const record = exactObject(
    value,
    ['schemaVersion', 'runId', 'contextRef', 'toolContext'],
    'session_kernel_tool_context_snapshot_invalid'
  );
  let toolContext: ToolContextBundleV2;
  try {
    toolContext = decodeToolContextBundleV2(record.toolContext);
    assertProviderSafeToolContextV2(toolContext);
  } catch {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_tool_context_snapshot_invalid'
    );
  }
  const contextRef = decodeToolContextSnapshotRefV3(record.contextRef);
  const derivedRef = toolContextRefV2(toolContext);
  if (
    record.schemaVersion !== SESSION_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA
    || record.runId !== runId
    || canonicalJson(contextRef) !== canonicalJson(derivedRef)
    || recordId
      !== `session-kernel-v3:${runId}:tool-context:${contextRef.contextDigest}`
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_tool_context_snapshot_invalid'
    );
  }
  return {
    schemaVersion: SESSION_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA,
    runId,
    contextRef,
    toolContext,
  };
}

function decodeToolContextSnapshotRefV3(
  value: unknown
): ToolContextRefV2 {
  const record = exactObject(
    value,
    ['contextVersion', 'catalogDigest', 'contextDigest'],
    'session_kernel_tool_context_snapshot_invalid'
  );
  return {
    contextVersion: positiveSafeIntegerV3(
      record.contextVersion,
      'contextVersion'
    ),
    catalogDigest: requiredDigest(
      record.catalogDigest,
      'catalogDigest'
    ),
    contextDigest: requiredDigest(
      record.contextDigest,
      'contextDigest'
    ),
  };
}

function decodeProviderAuthorityBindingV3(
  value: unknown
): SessionProviderAuthorityBindingV3 {
  const record = exactObjectOptional(
    value,
    [
      'runId',
      'inputId',
      'controlEpoch',
      'currentInputDigest',
      'providerProfileId',
      'providerProfileRevisionDigest',
    ],
    ['planRevision', 'reviewRevision', 'snapshotHighWater'],
    'session_kernel_provider_authority_invalid'
  );
  const controlEpoch = positiveSafeIntegerV3(
    record.controlEpoch,
    'controlEpoch'
  );
  const reviewRevision = record.reviewRevision === undefined
    ? undefined
    : positiveSafeIntegerV3(record.reviewRevision, 'reviewRevision');
  const snapshotHighWater = record.snapshotHighWater === undefined
    ? undefined
    : nonnegativeSafeIntegerV3(
        record.snapshotHighWater,
        'snapshotHighWater'
      );
  if ((reviewRevision === undefined) !== (snapshotHighWater === undefined)) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_authority_invalid'
    );
  }
  return {
    runId: requiredIdentity(record.runId, 'runId'),
    inputId: requiredIdentity(record.inputId, 'inputId'),
    controlEpoch,
    currentInputDigest: requiredDigest(
      record.currentInputDigest,
      'currentInputDigest'
    ),
    ...(record.planRevision === undefined
      ? {}
      : {
          planRevision: requiredIdentity(
            record.planRevision,
            'planRevision'
          ),
        }),
    ...(reviewRevision === undefined ? {} : { reviewRevision }),
    ...(snapshotHighWater === undefined
      ? {}
      : { snapshotHighWater }),
    providerProfileId: requiredIdentity(
      record.providerProfileId,
      'providerProfileId'
    ),
    providerProfileRevisionDigest: requiredDigest(
      record.providerProfileRevisionDigest,
      'providerProfileRevisionDigest'
    ),
  };
}

function decodeProviderTurnDispatchDataV3(
  value: unknown,
  runId: string,
  recordId: string
): SessionProviderTurnDispatchRecordV3['data'] {
  const record = exactObject(
    value,
    [
      'schemaVersion',
      'providerTurnId',
      'purpose',
      'authorityBinding',
      'requestDigest',
    ],
    'session_kernel_provider_dispatch_invalid'
  );
  const providerTurnId = requiredIdentity(
    record.providerTurnId,
    'providerTurnId'
  );
  const purpose = record.purpose;
  const authorityBinding = decodeProviderAuthorityBindingV3(
    record.authorityBinding
  );
  if (
    record.schemaVersion !== SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA
    || (
      purpose !== 'primary'
      && purpose !== 'continuation'
      && purpose !== 'finalAnswer'
    )
    || authorityBinding.runId !== runId
    || (purpose === 'finalAnswer')
      !== (authorityBinding.reviewRevision !== undefined)
    || recordId
      !== `session-kernel-v3:${runId}:provider-turn:${providerTurnId}:dispatch`
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_dispatch_invalid'
    );
  }
  return {
    schemaVersion: SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA,
    providerTurnId,
    purpose,
    authorityBinding,
    requestDigest: requiredDigest(record.requestDigest, 'requestDigest'),
  };
}

function decodeProviderCompletionReceiptV1(
  value: unknown
): import('./types.js').SessionProviderCompletionReceiptV1 {
  const record = exactObject(
    value,
    [
      'schemaVersion',
      'nativeCompletion',
      'reasoningPresent',
      'reasoningTransport',
      'reasoningDigest',
      'responseDigest',
      'trace',
    ],
    'session_kernel_provider_completion_invalid'
  );
  const native = objectRecord(record.nativeCompletion);
  if (
    record.schemaVersion !== SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA
    || record.reasoningPresent !== true
    || !native
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_completion_invalid'
    );
  }
  let nativeCompletion:
    import('./types.js').SessionProviderNativeCompletionV1;
  if (native.providerKind === 'openaiCompatible') {
    const exact = exactObject(
      native,
      ['providerKind', 'terminalSignal', 'finishReason'],
      'session_kernel_provider_completion_invalid'
    );
    if (
      exact.terminalSignal !== '[DONE]'
      || (
        exact.finishReason !== 'stop'
        && exact.finishReason !== 'tool_calls'
      )
      || record.reasoningTransport !== 'openaiPlaintext'
    ) {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_provider_completion_invalid'
      );
    }
    nativeCompletion = {
      providerKind: 'openaiCompatible',
      terminalSignal: '[DONE]',
      finishReason: exact.finishReason,
    };
  } else if (native.providerKind === 'anthropic') {
    const exact = exactObject(
      native,
      ['providerKind', 'terminalSignal'],
      'session_kernel_provider_completion_invalid'
    );
    if (
      exact.terminalSignal !== 'message_stop'
      || record.reasoningTransport !== 'anthropicPlaintext'
    ) {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_provider_completion_invalid'
      );
    }
    nativeCompletion = {
      providerKind: 'anthropic',
      terminalSignal: 'message_stop',
    };
  } else if (native.providerKind === 'ollama') {
    const exact = exactObject(
      native,
      ['providerKind', 'terminalSignal'],
      'session_kernel_provider_completion_invalid'
    );
    if (
      exact.terminalSignal !== 'done:true'
      || record.reasoningTransport !== 'ollamaPlaintext'
    ) {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_provider_completion_invalid'
      );
    }
    nativeCompletion = {
      providerKind: 'ollama',
      terminalSignal: 'done:true',
    };
  } else {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_completion_invalid'
    );
  }
  const trace = exactObject(
    record.trace,
    ['sealed', 'sealDigest', 'terminalDigest', 'recordCount'],
    'session_kernel_provider_completion_invalid'
  );
  if (trace.sealed !== true) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_completion_invalid'
    );
  }
  return {
    schemaVersion: SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
    nativeCompletion,
    reasoningPresent: true,
    reasoningTransport: record.reasoningTransport as
      import('./types.js').SessionProviderCompletionReceiptV1['reasoningTransport'],
    reasoningDigest: requiredDigest(
      record.reasoningDigest,
      'reasoningDigest'
    ),
    responseDigest: requiredDigest(
      record.responseDigest,
      'responseDigest'
    ),
    trace: {
      sealed: true,
      sealDigest: requiredDigest(trace.sealDigest, 'trace.sealDigest'),
      terminalDigest: requiredDigest(
        trace.terminalDigest,
        'trace.terminalDigest'
      ),
      recordCount: positiveSafeIntegerV3(
        trace.recordCount,
        'trace.recordCount'
      ),
    },
  };
}

function decodeProviderTerminalOrderedItemV3(
  value: unknown
): SessionProviderTerminalOrderedItemV3 {
  const record = objectRecord(value);
  if (record?.kind === 'text') {
    const exact = exactObject(
      record,
      ['kind', 'phase', 'text'],
      'session_kernel_provider_terminal_item_invalid'
    );
    if (
      exact.phase !== 'commentary'
      && exact.phase !== 'final_answer'
      && exact.phase !== 'unknown'
    ) {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_provider_terminal_item_invalid'
      );
    }
    return {
      kind: 'text',
      phase: exact.phase,
      text: requiredText(exact.text, 'terminal.text'),
    };
  }
  if (record?.kind === 'toolCall') {
    const exact = exactObject(
      record,
      ['kind', 'index', 'callId', 'name', 'arguments'],
      'session_kernel_provider_terminal_item_invalid'
    );
    const argumentsText = requiredText(
      exact.arguments,
      'terminal.arguments'
    );
    try {
      JSON.parse(argumentsText);
    } catch {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_provider_terminal_item_invalid'
      );
    }
    return {
      kind: 'toolCall',
      index: nonnegativeSafeIntegerV3(exact.index, 'terminal.index'),
      callId: requiredIdentity(exact.callId, 'terminal.callId'),
      name: requiredIdentity(exact.name, 'terminal.name'),
      arguments: argumentsText,
    };
  }
  throw new UnsupportedHistorySchemaError(
    'session_kernel_provider_terminal_item_invalid'
  );
}

function decodeProviderTurnTerminalDataV3(
  value: unknown,
  runId: string,
  recordId: string
): SessionProviderTurnTerminalRecordV3['data'] {
  const record = exactObjectOptional(
    value,
    [
      'schemaVersion',
      'providerTurnId',
      'dispatchRef',
      'authorityBinding',
      'terminalKind',
      'traceRef',
      'orderedItems',
    ],
    ['reasonCode', 'responseDigest', 'completion', 'providerResult'],
    'session_kernel_provider_terminal_invalid'
  );
  const providerTurnId = requiredIdentity(
    record.providerTurnId,
    'providerTurnId'
  );
  if (
    record.schemaVersion !== SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA
    || recordId
      !== `session-kernel-v3:${runId}:provider-turn:${providerTurnId}:terminal`
    || !Array.isArray(record.orderedItems)
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_terminal_invalid'
    );
  }
  const terminalKind = record.terminalKind;
  if (
    terminalKind !== 'completed'
    && terminalKind !== 'failed'
    && terminalKind !== 'cancelled'
    && terminalKind !== 'limitExceeded'
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_terminal_invalid'
    );
  }
  const trace = exactObject(
    record.traceRef,
    ['terminalDigest', 'sealDigest', 'recordCount'],
    'session_kernel_provider_terminal_invalid'
  );
  const traceRef = {
    terminalDigest: requiredDigest(
      trace.terminalDigest,
      'traceRef.terminalDigest'
    ),
    sealDigest: requiredDigest(trace.sealDigest, 'traceRef.sealDigest'),
    recordCount: positiveSafeIntegerV3(
      trace.recordCount,
      'traceRef.recordCount'
    ),
  };
  const orderedItems = record.orderedItems.map(
    decodeProviderTerminalOrderedItemV3
  );
  const authorityBinding = decodeProviderAuthorityBindingV3(
    record.authorityBinding
  );
  const dispatchRef = decodeRecordRefV3(record.dispatchRef);
  if (authorityBinding.runId !== runId) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_terminal_invalid'
    );
  }
  if (terminalKind === 'completed') {
    const completion = decodeProviderCompletionReceiptV1(
      record.completion
    );
    const providerResultRecord = exactObjectOptional(
      record.providerResult,
      ['providerProfileId', 'provider', 'model'],
      ['usage'],
      'session_kernel_provider_terminal_result_invalid'
    );
    const usage = providerResultRecord.usage;
    const usageRecord = usage === undefined
      ? undefined
      : objectRecord(usage);
    if (usage !== undefined && !usageRecord) {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_provider_terminal_result_invalid'
      );
    }
    const responseDigest = requiredDigest(
      record.responseDigest,
      'responseDigest'
    );
    if (
      record.reasonCode !== undefined
      || responseDigest !== completion.responseDigest
      || providerResultRecord.providerProfileId
        !== authorityBinding.providerProfileId
      || traceRef.terminalDigest !== completion.trace.terminalDigest
      || traceRef.sealDigest !== completion.trace.sealDigest
      || traceRef.recordCount !== completion.trace.recordCount
    ) {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_provider_terminal_invalid'
      );
    }
    validateTerminalOrderedCompletionV3(orderedItems, completion);
    return {
      schemaVersion: SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA,
      providerTurnId,
      dispatchRef,
      authorityBinding,
      terminalKind,
      responseDigest,
      completion,
      providerResult: {
        providerProfileId: requiredIdentity(
          providerResultRecord.providerProfileId,
          'providerProfileId'
        ),
        provider: requiredIdentity(providerResultRecord.provider, 'provider'),
        model: requiredIdentity(providerResultRecord.model, 'model'),
        ...(usageRecord === undefined
          ? {}
          : { usage: cloneJson(usageRecord) }),
      },
      traceRef,
      orderedItems,
    };
  }
  if (
    record.reasonCode === undefined
    || record.responseDigest !== undefined
    || record.completion !== undefined
    || record.providerResult !== undefined
    || orderedItems.length !== 0
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_terminal_invalid'
    );
  }
  return {
    schemaVersion: SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA,
    providerTurnId,
    dispatchRef,
    authorityBinding,
    terminalKind,
    reasonCode: requiredIdentity(record.reasonCode, 'reasonCode'),
    traceRef,
    orderedItems: [],
  };
}

function validateTerminalOrderedCompletionV3(
  orderedItems: readonly SessionProviderTerminalOrderedItemV3[],
  completion: import('./types.js').SessionProviderCompletionReceiptV1
): void {
  if (orderedItems.length > 96) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_terminal_item_invalid'
    );
  }
  let finalStarted = false;
  let toolCount = 0;
  for (const item of orderedItems) {
    if (item.kind === 'text') {
      if (finalStarted && item.phase === 'commentary') {
        throw new UnsupportedHistorySchemaError(
          'session_kernel_provider_terminal_phase_conflict'
        );
      }
      if (item.phase === 'final_answer') finalStarted = true;
      continue;
    }
    if (finalStarted) {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_provider_terminal_phase_conflict'
      );
    }
    toolCount += 1;
  }
  const native = completion.nativeCompletion;
  if (
    native.providerKind === 'openaiCompatible'
    && native.finishReason !== (toolCount > 0 ? 'tool_calls' : 'stop')
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_terminal_completion_conflict'
    );
  }
}

function decodeRecordRefV3(
  value: unknown
): SessionKernelPersistenceRecordRefV3 {
  const record = exactObject(
    value,
    ['recordId', 'recordDigest'],
    'session_kernel_record_ref_invalid'
  );
  return {
    recordId: requiredIdentity(record.recordId, 'recordId'),
    recordDigest: requiredDigest(record.recordDigest, 'recordDigest'),
  };
}

function decodeCommitScopeV3(
  value: unknown
): SessionKernelCheckpointCommitScopeV3 {
  const record = objectRecord(value);
  if (record?.kind === 'standalone') {
    exactObject(
      record,
      ['kind'],
      'session_kernel_commit_scope_invalid'
    );
    return { kind: 'standalone' };
  }
  const exact = exactObject(
    record,
    ['kind', 'requestId', 'requestDigest', 'outcomeDigest'],
    'session_kernel_commit_scope_invalid'
  );
  if (exact.kind !== 'publicRequestSettlement') {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_commit_scope_invalid'
    );
  }
  return {
    kind: 'publicRequestSettlement',
    requestId: requiredIdentity(exact.requestId, 'requestId'),
    requestDigest: requiredDigest(exact.requestDigest, 'requestDigest'),
    outcomeDigest: requiredDigest(exact.outcomeDigest, 'outcomeDigest'),
  };
}

function decodeCompactCheckpointV3(
  value: unknown,
  runId: string,
  recordId: string
): SessionKernelCompactCheckpointV3 {
  const record = exactObjectOptional(
    value,
    [
      'schemaVersion',
      'checkpointRevision',
      'savedAt',
      'parentRef',
      'commitScope',
      'authority',
      'cursor',
      'active',
      'refs',
    ],
    ['finalAnswer', 'terminalAnswerCandidate'],
    'session_kernel_checkpoint_invalid'
  );
  const revision = positiveSafeIntegerV3(
    record.checkpointRevision,
    'checkpointRevision'
  );
  if (
    record.schemaVersion !== SESSION_KERNEL_CHECKPOINT_V3_SCHEMA
    || recordId !== `session-kernel-v3:${runId}:checkpoint:${revision}`
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_checkpoint_invalid'
    );
  }
  const authority = exactObjectOptional(
    record.authority,
    [
      'runId',
      'workspaceBindingDigest',
      'controlEpoch',
      'currentInputId',
      'currentInputRef',
      'providerProfileId',
      'providerProfileRevisionDigest',
      'toolContext',
      'previews',
      'operationPlanActionBindings',
    ],
    [
      'workAuthority',
      'planRef',
      'planConfirmation',
      'planDecisionRef',
    ],
    'session_kernel_checkpoint_authority_invalid'
  );
  if (authority.runId !== runId) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_checkpoint_authority_invalid'
    );
  }
  const controlEpoch = positiveSafeIntegerV3(
    authority.controlEpoch,
    'controlEpoch'
  );
  const previews = decodeCheckpointScopePreviewsV3(
    authority.previews,
    runId,
    controlEpoch
  );
  const toolContext = exactObjectOptional(
    authority.toolContext,
    ['currentRef', 'refreshRequired'],
    ['expectedContextRef'],
    'session_kernel_checkpoint_tool_context_invalid'
  );
  if (typeof toolContext.refreshRequired !== 'boolean') {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_checkpoint_tool_context_invalid'
    );
  }
  const cursor = exactObject(
    record.cursor,
    [
      'inputRefs',
      'inputHistoryOmittedCount',
      'providerTerminalRefs',
      'providerOutcomeHistoryOmittedCount',
      'reviewFactsAfterLedgerSequence',
      'afterLedgerSequence',
      'snapshotHighWater',
    ],
    'session_kernel_checkpoint_cursor_invalid'
  );
  if (!Array.isArray(cursor.inputRefs)
    || !Array.isArray(cursor.providerTerminalRefs)) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_checkpoint_cursor_invalid'
    );
  }
  const active = exactObjectOptional(
    record.active,
    [
      'pendingGuidance',
      'factBarriers',
      'publicRequests',
      'kernelWakeHint',
    ],
    [
      'pendingEpochInputRef',
      'activeWait',
      'interventionResearch',
      'userIntervention',
      'userInterventionDecision',
      'providerReservation',
      'providerQueue',
      'runCancellation',
    ],
    'session_kernel_checkpoint_active_invalid'
  );
  if (
    !Array.isArray(active.pendingGuidance)
    || typeof active.kernelWakeHint !== 'boolean'
    || !objectRecord(active.factBarriers)
    || !objectRecord(active.publicRequests)
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_checkpoint_active_invalid'
    );
  }
  const refs = exactObjectOptional(
    record.refs,
    ['planActionSettlements'],
    ['review'],
    'session_kernel_checkpoint_refs_invalid'
  );
  const settlementRefs = objectRecord(refs.planActionSettlements);
  if (!settlementRefs) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_checkpoint_refs_invalid'
    );
  }
  const publicRequestRefs = Object.fromEntries(
    Object.entries(active.publicRequests as Record<string, unknown>)
      .map(([lane, ref]) => {
        if (lane !== 'control' && lane !== 'effect' && lane !== 'query') {
          throw new UnsupportedHistorySchemaError(
            'session_kernel_checkpoint_public_request_refs_invalid'
          );
        }
        return [lane, decodeRecordRefV3(ref)];
      })
  ) as SessionKernelCompactCheckpointV3['active']['publicRequests'];
  const currentToolContextRef = decodeToolContextRefV3(
    toolContext.currentRef
  );
  const providerReservation = active.providerReservation === undefined
    ? undefined
    : decodeCompactProviderReservationV3(active.providerReservation);
  if (
    providerReservation
    && canonicalJson(providerReservation.contextRef)
      !== canonicalJson(currentToolContextRef)
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-reservation-tool-context-ref-mismatch'
    );
  }
  const finalAnswer = record.finalAnswer === undefined
    ? undefined
    : decodeCompactFinalAnswerV3(record.finalAnswer);
  const terminalAnswerCandidate =
    record.terminalAnswerCandidate === undefined
      ? undefined
      : decodeCompactTerminalAnswerCandidateV1(
          record.terminalAnswerCandidate
        );
  const reviewFactsAfterLedgerSequence = nonnegativeSafeIntegerV3(
    cursor.reviewFactsAfterLedgerSequence,
    'reviewFactsAfterLedgerSequence'
  );
  const afterLedgerSequence = nonnegativeSafeIntegerV3(
    cursor.afterLedgerSequence,
    'afterLedgerSequence'
  );
  if (reviewFactsAfterLedgerSequence > afterLedgerSequence) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_checkpoint_review_facts_cursor_invalid'
    );
  }
  return {
    schemaVersion: SESSION_KERNEL_CHECKPOINT_V3_SCHEMA,
    checkpointRevision: revision,
    savedAt: requiredText(record.savedAt, 'savedAt'),
    parentRef: record.parentRef === null
      ? null
      : decodeRecordRefV3(record.parentRef),
    commitScope: decodeCommitScopeV3(record.commitScope),
    authority: {
      runId,
      workspaceBindingDigest: requiredDigest(
        authority.workspaceBindingDigest,
        'workspaceBindingDigest'
      ),
      controlEpoch,
      currentInputId: requiredIdentity(
        authority.currentInputId,
        'currentInputId'
      ),
      currentInputRef: decodeRecordRefV3(authority.currentInputRef),
      providerProfileId: requiredIdentity(
        authority.providerProfileId,
        'providerProfileId'
      ),
      providerProfileRevisionDigest: requiredDigest(
        authority.providerProfileRevisionDigest,
        'providerProfileRevisionDigest'
      ),
      toolContext: {
        currentRef: currentToolContextRef,
        refreshRequired: toolContext.refreshRequired,
        ...(toolContext.expectedContextRef === undefined
          ? {}
          : {
              expectedContextRef: decodeToolContextRefV3(
                toolContext.expectedContextRef
              ),
            }),
      },
      ...(authority.workAuthority === undefined
        ? {}
        : {
            workAuthority: decodeSessionWorkAuthorityV3(
              authority.workAuthority
            ),
          }),
      ...(authority.planRef === undefined
        ? {}
        : { planRef: decodeRecordRefV3(authority.planRef) }),
      ...(authority.planDecisionRef === undefined
        ? {}
        : {
            planDecisionRef: decodeRecordRefV3(
              authority.planDecisionRef
            ),
          }),
      ...(authority.planConfirmation === undefined
        ? {}
        : {
            planConfirmation: cloneJson(
              authority.planConfirmation
            ) as import('./types.js').SessionPlanConfirmationAuthorityV2,
          }),
      previews,
      operationPlanActionBindings: cloneJson(
        authority.operationPlanActionBindings
      ) as Record<string, SessionOperationPlanActionBindingV2>,
    },
    cursor: {
      inputRefs: cursor.inputRefs.map(decodeRecordRefV3),
      inputHistoryOmittedCount: nonnegativeSafeIntegerV3(
        cursor.inputHistoryOmittedCount,
        'inputHistoryOmittedCount'
      ),
      providerTerminalRefs:
        cursor.providerTerminalRefs.map(decodeRecordRefV3),
      providerOutcomeHistoryOmittedCount: nonnegativeSafeIntegerV3(
        cursor.providerOutcomeHistoryOmittedCount,
        'providerOutcomeHistoryOmittedCount'
      ),
      reviewFactsAfterLedgerSequence,
      afterLedgerSequence,
      snapshotHighWater: nonnegativeSafeIntegerV3(
        cursor.snapshotHighWater,
        'snapshotHighWater'
      ),
    },
    active: {
      ...(active.pendingEpochInputRef === undefined
        ? {}
        : {
            pendingEpochInputRef: decodeRecordRefV3(
              active.pendingEpochInputRef
            ),
          }),
      ...(active.activeWait === undefined
        ? {}
        : { activeWait: cloneJson(active.activeWait) as SessionActiveWaitV2 }),
      ...(active.interventionResearch === undefined
        ? {}
        : {
            interventionResearch: cloneJson(
              active.interventionResearch
            ) as SessionInterventionResearchV4,
          }),
      ...(active.userIntervention === undefined
        ? {}
        : {
            userIntervention: cloneJson(
              active.userIntervention
            ) as SessionUserInterventionV4,
          }),
      ...(active.userInterventionDecision === undefined
        ? {}
        : {
            userInterventionDecision: cloneJson(
              active.userInterventionDecision
            ) as SessionUserInterventionDecisionV4,
          }),
      pendingGuidance: active.pendingGuidance.map((guidance) =>
        requiredText(guidance, 'pendingGuidance')
      ),
      ...(providerReservation === undefined
        ? {}
        : { providerReservation }),
      ...(active.providerQueue === undefined
        ? {}
        : {
            providerQueue: decodeCompactProviderQueueV3(
              active.providerQueue
            ),
          }),
      factBarriers: cloneJson(active.factBarriers) as Record<
        string,
        SessionKernelFactBarrierV2
      >,
      publicRequests: publicRequestRefs,
      ...(active.runCancellation === undefined
        ? {}
        : {
            runCancellation: cloneJson(
              active.runCancellation
            ) as SessionRunCancellationV2,
          }),
      kernelWakeHint: active.kernelWakeHint,
    },
    refs: {
      ...(refs.review === undefined
        ? {}
        : { review: decodeRecordRefV3(refs.review) }),
      planActionSettlements: Object.fromEntries(
        Object.entries(settlementRefs).map(([planActionId, ref]) => [
          requiredIdentity(planActionId, 'planActionId'),
          decodeRecordRefV3(ref),
        ])
      ),
    },
    ...(finalAnswer === undefined ? {} : { finalAnswer }),
    ...(terminalAnswerCandidate === undefined
      ? {}
      : { terminalAnswerCandidate }),
  };
}

function decodeCompactTerminalAnswerCandidateV1(
  value: unknown
): SessionKernelCompactTerminalAnswerCandidateV1 {
  const record = exactObject(
    value,
    [
      'schemaVersion',
      'providerTurnId',
      'inputId',
      'controlEpoch',
      'languageRevision',
      'snapshotHighWater',
      'workAuthority',
      'textDigest',
      'sourceEventRefs',
      'recordedAt',
    ],
    'session_kernel_terminal_answer_candidate_invalid'
  );
  const controlEpoch = positiveSafeIntegerV3(
    record.controlEpoch,
    'terminalAnswerCandidate.controlEpoch'
  );
  const languageRevision = positiveSafeIntegerV3(
    record.languageRevision,
    'terminalAnswerCandidate.languageRevision'
  );
  const sourceEventRefs = Array.isArray(record.sourceEventRefs)
    ? record.sourceEventRefs.map((ref) =>
        requiredIdentity(ref, 'terminalAnswerCandidate.sourceEventRef')
      )
    : [];
  if (
    record.schemaVersion
      !== SESSION_TERMINAL_ANSWER_CANDIDATE_V1_SCHEMA
    || languageRevision !== controlEpoch
    || sourceEventRefs.length === 0
    || new Set(sourceEventRefs).size !== sourceEventRefs.length
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_terminal_answer_candidate_invalid'
    );
  }
  return {
    schemaVersion: SESSION_TERMINAL_ANSWER_CANDIDATE_V1_SCHEMA,
    providerTurnId: requiredIdentity(
      record.providerTurnId,
      'terminalAnswerCandidate.providerTurnId'
    ),
    inputId: requiredIdentity(
      record.inputId,
      'terminalAnswerCandidate.inputId'
    ),
    controlEpoch,
    languageRevision,
    snapshotHighWater: nonnegativeSafeIntegerV3(
      record.snapshotHighWater,
      'terminalAnswerCandidate.snapshotHighWater'
    ),
    workAuthority: decodeSessionWorkAuthorityV3(record.workAuthority),
    textDigest: requiredDigest(
      record.textDigest,
      'terminalAnswerCandidate.textDigest'
    ),
    sourceEventRefs,
    recordedAt: requiredText(
      record.recordedAt,
      'terminalAnswerCandidate.recordedAt'
    ),
  };
}

function decodeCheckpointScopePreviewsV3(
  value: unknown,
  runId: string,
  controlEpoch: number
): Record<string, CapabilityScopePreviewRecordV2> {
  const records = objectRecord(value);
  if (!records) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_checkpoint_scope_previews_invalid'
    );
  }
  const previews: Record<string, CapabilityScopePreviewRecordV2> = {};
  const previewIds = new Set<string>();
  const planActionIds = new Set<string>();
  for (const [operationId, rawPreview] of Object.entries(records)) {
    const rawRecord = objectRecord(rawPreview);
    const planRevision = rawRecord?.planRevision;
    let preview: CapabilityScopePreviewRecordV2;
    try {
      const envelope = decodeKernelCommandResponseEnvelopeV2({
        kind: 'correlated',
        data: {
          serverAbiVersion: KERNEL_ABI_V2_VERSION,
          requestId: 'session-kernel-checkpoint-preview',
          handling: 'replayed',
          reply: {
            kind: 'capabilityScopePreviewBatchResult',
            data: {
              runId,
              acceptedControlEpoch: controlEpoch,
              planRevision,
              results: [{
                kind: 'previewed',
                data: { preview: rawPreview },
              }],
            },
          },
        },
      });
      const reply = envelope.kind === 'correlated'
        ? envelope.data.reply
        : undefined;
      const result = reply?.kind === 'capabilityScopePreviewBatchResult'
        ? reply.data.results[0]
        : undefined;
      if (!result || result.kind !== 'previewed') {
        throw new Error('scope preview decoder returned another reply kind');
      }
      preview = result.data.preview;
    } catch {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_checkpoint_scope_preview_invalid'
      );
    }
    if (
      operationId !== preview.operationId
      || preview.runId !== runId
      || preview.controlEpoch !== controlEpoch
      || !previewIds.add(preview.previewId)
      || !planActionIds.add(preview.planActionId)
    ) {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_checkpoint_scope_preview_binding_invalid'
      );
    }
    previews[operationId] = cloneJson(preview);
  }
  return previews;
}

function decodeToolContextRefV3(
  value: unknown
): import('@deepcode/protocol').ToolContextRefV2 {
  const record = exactObject(
    value,
    ['contextVersion', 'catalogDigest', 'contextDigest'],
    'session_kernel_checkpoint_tool_context_invalid'
  );
  return {
    contextVersion: positiveSafeIntegerV3(
      record.contextVersion,
      'contextVersion'
    ),
    catalogDigest: requiredDigest(
      record.catalogDigest,
      'catalogDigest'
    ),
    contextDigest: requiredDigest(
      record.contextDigest,
      'contextDigest'
    ),
  };
}

function decodeCompactProviderReservationV3(
  value: unknown
): SessionKernelCompactProviderReservationV3 {
  const record = exactObjectOptional(
    value,
    [
      'providerTurnId',
      'purpose',
      'target',
      'controlEpoch',
      'contextRef',
      'factProjection',
      'contextAssembly',
      'startedAt',
      'status',
    ],
    [
      'planRevision',
      'correction',
      'cancellationReason',
      'dispatchRef',
      'terminalRef',
    ],
    'session_kernel_provider_reservation_invalid'
  );
  if (
    record.purpose !== 'primary'
    && record.purpose !== 'continuation'
    && record.purpose !== 'finalAnswer'
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_reservation_invalid'
    );
  }
  const target = decodeProviderTurnTargetV3(record.target);
  if ((record.purpose === 'finalAnswer') !== (target.kind === 'finalAnswer')) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_reservation_invalid'
    );
  }
  const allowedStatuses: readonly SessionProviderTurnRecordV2['status'][] = [
    'active',
    'awaitingTools',
    'cancelled',
    'completed',
    'aborted',
    'stale',
    'failed',
  ];
  if (!allowedStatuses.includes(
    record.status as SessionProviderTurnRecordV2['status']
  )) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_reservation_status_invalid'
    );
  }
  const cancellationReasons: readonly NonNullable<
    SessionProviderTurnRecordV2['cancellationReason']
  >[] = ['userInput', 'runCancelled', 'superseded', 'shutdown'];
  if (
    record.cancellationReason !== undefined
    && !cancellationReasons.includes(
      record.cancellationReason as NonNullable<
        SessionProviderTurnRecordV2['cancellationReason']
      >
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_reservation_cancellation_invalid'
    );
  }
  return {
    providerTurnId: requiredIdentity(
      record.providerTurnId,
      'providerTurnId'
    ),
    purpose: record.purpose,
    target,
    ...(record.planRevision === undefined
      ? {}
      : {
          planRevision: requiredIdentity(
            record.planRevision,
            'planRevision'
          ),
        }),
    ...(record.correction === undefined
      ? {}
      : {
          correction: decodeSessionToolCorrectionV3(
            record.correction
          ),
        }),
    controlEpoch: positiveSafeIntegerV3(
      record.controlEpoch,
      'controlEpoch'
    ),
    contextRef: decodeToolContextRefV3(record.contextRef),
    factProjection: cloneJson(record.factProjection) as
      SessionProviderTurnRecordV2['factProjection'],
    contextAssembly: cloneJson(record.contextAssembly) as
      SessionProviderTurnRecordV2['contextAssembly'],
    startedAt: requiredText(record.startedAt, 'startedAt'),
    status: record.status as SessionProviderTurnRecordV2['status'],
    ...(record.cancellationReason === undefined
      ? {}
      : {
          cancellationReason: requiredIdentity(
            record.cancellationReason,
            'cancellationReason'
          ) as SessionProviderTurnRecordV2['cancellationReason'],
        }),
    ...(record.dispatchRef === undefined
      ? {}
      : { dispatchRef: decodeRecordRefV3(record.dispatchRef) }),
    ...(record.terminalRef === undefined
      ? {}
      : { terminalRef: decodeRecordRefV3(record.terminalRef) }),
  };
}

function decodeProviderTurnTargetV3(
  value: unknown
): SessionProviderTurnTargetV2 {
  const tagged = objectRecord(value);
  if (!tagged || typeof tagged.kind !== 'string') {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_target_invalid'
    );
  }
  switch (tagged.kind) {
    case 'planning':
      exactObject(tagged, ['kind'], 'session_kernel_provider_target_invalid');
      return { kind: 'planning' };
    case 'planAction':
      exactObject(
        tagged,
        ['kind', 'planActionId'],
        'session_kernel_provider_target_invalid'
      );
      return {
        kind: 'planAction',
        planActionId: requiredIdentity(
          tagged.planActionId,
          'target.planActionId'
        ),
      };
    case 'interventionResearch':
      exactObject(
        tagged,
        ['kind', 'researchId'],
        'session_kernel_provider_target_invalid'
      );
      return {
        kind: 'interventionResearch',
        researchId: requiredIdentity(
          tagged.researchId,
          'target.researchId'
        ),
      };
    case 'contextRead':
      exactObjectOptional(
        tagged,
        ['kind', 'operationId', 'purpose', 'idempotencyKey'],
        ['deadline'],
        'session_kernel_provider_target_invalid'
      );
      return {
        kind: 'contextRead',
        operationId: requiredIdentity(
          tagged.operationId,
          'target.operationId'
        ),
        purpose: requiredText(tagged.purpose, 'target.purpose'),
        idempotencyKey: requiredIdentity(
          tagged.idempotencyKey,
          'target.idempotencyKey'
        ),
        ...(tagged.deadline === undefined
          ? {}
          : { deadline: decodeDeadlineRequestV3(tagged.deadline) }),
      };
    case 'finalAnswer':
      exactObject(
        tagged,
        [
          'kind',
          'inputId',
          'controlEpoch',
          'workAuthority',
          'reviewRevision',
          'snapshotHighWater',
        ],
        'session_kernel_provider_target_invalid'
      );
      return {
        kind: 'finalAnswer',
        inputId: requiredIdentity(tagged.inputId, 'target.inputId'),
        controlEpoch: positiveSafeIntegerV3(
          tagged.controlEpoch,
          'target.controlEpoch'
        ),
        workAuthority: decodeSessionWorkAuthorityV3(
          tagged.workAuthority
        ),
        reviewRevision: positiveSafeIntegerV3(
          tagged.reviewRevision,
          'target.reviewRevision'
        ),
        snapshotHighWater: nonnegativeSafeIntegerV3(
          tagged.snapshotHighWater,
          'target.snapshotHighWater'
        ),
      };
    default:
      throw new UnsupportedHistorySchemaError(
        'session_kernel_provider_target_invalid'
      );
  }
}

function decodeSessionToolCorrectionV3(
  value: unknown
): import('./types.js').SessionToolCorrectionV2 {
  const record = exactObject(
    value,
    ['retryGroupId', 'predecessorOperationId', 'retryOrdinal'],
    'session_kernel_tool_correction_invalid'
  );
  const retryOrdinal = positiveSafeIntegerV3(
    record.retryOrdinal,
    'retryOrdinal'
  );
  if (retryOrdinal < 2) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_tool_correction_invalid'
    );
  }
  return {
    retryGroupId: requiredIdentity(
      record.retryGroupId,
      'retryGroupId'
    ),
    predecessorOperationId: requiredIdentity(
      record.predecessorOperationId,
      'predecessorOperationId'
    ),
    retryOrdinal,
  };
}

function decodeDeadlineRequestV3(value: unknown): DeadlineRequestV2 {
  const tagged = exactObject(
    value,
    ['kind', 'data'],
    'session_kernel_provider_deadline_invalid'
  );
  if (tagged.kind === 'contractDefault') {
    exactObject(
      tagged.data,
      [],
      'session_kernel_provider_deadline_invalid'
    );
    return { kind: 'contractDefault', data: {} };
  }
  if (tagged.kind === 'exactMilliseconds') {
    const data = exactObject(
      tagged.data,
      ['value'],
      'session_kernel_provider_deadline_invalid'
    );
    return {
      kind: 'exactMilliseconds',
      data: {
        value: positiveSafeIntegerV3(data.value, 'deadline.value'),
      },
    };
  }
  throw new UnsupportedHistorySchemaError(
    'session_kernel_provider_deadline_invalid'
  );
}

function decodeCompactProviderQueueV3(
  value: unknown
): SessionKernelCompactProviderQueueV3 {
  const record = exactObjectOptional(
    value,
    [
      'providerTurnId',
      'terminalRef',
      'target',
      'calls',
      'mutationDisposition',
      'status',
      'outcomeRecorded',
    ],
    ['settledAt', 'abortReason'],
    'session_kernel_provider_queue_invalid'
  );
  if (!Array.isArray(record.calls)
    || typeof record.outcomeRecorded !== 'boolean'
    || ![
      'notRequired',
      'classifying',
      'planned',
      'initialPlanDiscovery',
      'userIntervention',
    ].includes(String(record.mutationDisposition))
    || !['active', 'completed', 'aborted'].includes(String(record.status))) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_provider_queue_invalid'
    );
  }
  return {
    providerTurnId: requiredIdentity(
      record.providerTurnId,
      'providerTurnId'
    ),
    terminalRef: decodeRecordRefV3(record.terminalRef),
    target: cloneJson(record.target) as SessionProviderTurnTargetV2,
    calls: cloneJson(record.calls) as SessionProviderToolCallQueueItemV2[],
    mutationDisposition: record.mutationDisposition as
      SessionProviderToolCallQueueV2['mutationDisposition'],
    status: record.status as SessionProviderToolCallQueueV2['status'],
    outcomeRecorded: record.outcomeRecorded,
    ...(record.settledAt === undefined
      ? {}
      : { settledAt: requiredText(record.settledAt, 'settledAt') }),
    ...(record.abortReason === undefined
      ? {}
      : {
          abortReason: requiredIdentity(
            record.abortReason,
            'abortReason'
          ),
        }),
  };
}

function decodeCompactFinalAnswerV3(
  value: unknown
): SessionKernelCompactFinalAnswerV3 {
  const record = exactObjectOptional(
    value,
    ['status', 'binding'],
    [
      'providerTurnId',
      'startedAt',
      'staleAt',
      'committedAt',
      'failedAt',
      'lastErrorCode',
      'commitKind',
    ],
    'session_kernel_final_answer_checkpoint_invalid'
  );
  const binding = exactObject(
    record.binding,
    [
      'inputId',
      'controlEpoch',
      'workAuthority',
      'reviewRevision',
      'snapshotHighWater',
    ],
    'session_kernel_final_answer_checkpoint_invalid'
  );
  return cloneJson({
    status: record.status,
    binding: {
      inputId: requiredIdentity(binding.inputId, 'inputId'),
      controlEpoch: positiveSafeIntegerV3(
        binding.controlEpoch,
        'controlEpoch'
      ),
      workAuthority: decodeSessionWorkAuthorityV3(
        binding.workAuthority
      ),
      reviewRevision: positiveSafeIntegerV3(
        binding.reviewRevision,
        'reviewRevision'
      ),
      snapshotHighWater: nonnegativeSafeIntegerV3(
        binding.snapshotHighWater,
        'snapshotHighWater'
      ),
    },
    ...(record.providerTurnId === undefined
      ? {}
      : {
          providerTurnId: requiredIdentity(
            record.providerTurnId,
            'providerTurnId'
          ),
        }),
    ...(record.startedAt === undefined
      ? {}
      : { startedAt: requiredText(record.startedAt, 'startedAt') }),
    ...(record.staleAt === undefined
      ? {}
      : { staleAt: requiredText(record.staleAt, 'staleAt') }),
    ...(record.committedAt === undefined
      ? {}
      : {
          committedAt: requiredText(
            record.committedAt,
            'committedAt'
          ),
        }),
    ...(record.failedAt === undefined
      ? {}
      : { failedAt: requiredText(record.failedAt, 'failedAt') }),
    ...(record.lastErrorCode === undefined
      ? {}
      : {
          lastErrorCode: requiredIdentity(
            record.lastErrorCode,
            'lastErrorCode'
          ),
        }),
    ...(record.commitKind === undefined
      ? {}
      : record.commitKind === 'candidatePromotion'
          || record.commitKind === 'finalSynthesis'
        ? { commitKind: record.commitKind }
        : (() => {
            throw new UnsupportedHistorySchemaError(
              'session_kernel_final_answer_checkpoint_invalid'
            );
          })()),
  }) as SessionKernelCompactFinalAnswerV3;
}

function decodeSessionWorkAuthorityV3(
  value: unknown
): SessionWorkAuthorityV3 {
  const tagged = objectRecord(value);
  if (!tagged || typeof tagged.kind !== 'string') {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_work_authority_invalid'
    );
  }
  let authority: SessionWorkAuthorityV3;
  if (tagged.kind === 'plan') {
    const record = exactObject(
      value,
      ['kind', 'planRevision'],
      'session_kernel_work_authority_invalid'
    );
    authority = {
      kind: 'plan',
      planRevision: requiredIdentity(
        record.planRevision,
        'workAuthority.planRevision'
      ),
    };
  } else if (tagged.kind === 'contextRead') {
    const record = exactObject(
      value,
      [
        'kind',
        'batchSequence',
        'predecessorDigest',
        'operationIds',
        'digest',
      ],
      'session_kernel_work_authority_invalid'
    );
    if (!Array.isArray(record.operationIds)) {
      throw new UnsupportedHistorySchemaError(
        'session_kernel_work_authority_invalid'
      );
    }
    authority = {
      kind: 'contextRead',
      batchSequence: positiveSafeIntegerV3(
        record.batchSequence,
        'workAuthority.batchSequence'
      ),
      predecessorDigest: record.predecessorDigest === null
        ? null
        : requiredDigest(
            record.predecessorDigest,
            'workAuthority.predecessorDigest'
          ),
      operationIds: record.operationIds.map((operationId) =>
        requiredIdentity(operationId, 'workAuthority.operationId')
      ),
      digest: requiredDigest(
        record.digest,
        'workAuthority.digest'
      ),
    };
  } else {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_work_authority_invalid'
    );
  }
  try {
    validateSessionWorkAuthorityShapeV3(authority);
  } catch {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_work_authority_invalid'
    );
  }
  return authority;
}

function decodeReviewRecordDataV3(
  value: unknown,
  runId: string,
  recordId: string
): { schemaVersion: typeof SESSION_KERNEL_REVIEW_RECORD_V3_SCHEMA; review: SessionKernelReviewV2 } {
  const record = exactObject(
    value,
    ['schemaVersion', 'review'],
    'session_kernel_review_record_invalid'
  );
  const review = objectRecord(record.review);
  if (
    record.schemaVersion !== SESSION_KERNEL_REVIEW_RECORD_V3_SCHEMA
    || !review
    || !Number.isSafeInteger(review.revision)
    || recordId !== `session-kernel-v3:${runId}:review:${review.revision}`
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_review_record_invalid'
    );
  }
  return {
    schemaVersion: SESSION_KERNEL_REVIEW_RECORD_V3_SCHEMA,
    review: cloneJson(record.review) as SessionKernelReviewV2,
  };
}

function lastDurableReviewRevisionV3(
  records: readonly SessionKernelPersistenceRecordV3[],
  runId: string
): number {
  let revision = 0;
  for (const record of records) {
    if (record.recordKind !== 'review') continue;
    revision = Math.max(
      revision,
      Number(decodeReviewRecordDataV3(
        record.data,
        runId,
        record.recordId
      ).review.revision)
    );
  }
  return revision;
}

function decodePlanActionSettlementRecordDataV3(
  value: unknown,
  runId: string,
  recordId: string
): {
  schemaVersion: typeof SESSION_KERNEL_PLAN_ACTION_SETTLEMENT_RECORD_V3_SCHEMA;
  settlement: SessionPlanActionSettlementV2;
} {
  const record = exactObject(
    value,
    ['schemaVersion', 'settlement'],
    'session_kernel_plan_action_settlement_record_invalid'
  );
  const settlement = objectRecord(record.settlement);
  const planActionId = settlement?.planActionId;
  if (
    record.schemaVersion
      !== SESSION_KERNEL_PLAN_ACTION_SETTLEMENT_RECORD_V3_SCHEMA
    || !settlement
    || typeof planActionId !== 'string'
    || recordId
      !== `session-kernel-v3:${runId}:plan-action-settlement:${planActionId}`
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_plan_action_settlement_record_invalid'
    );
  }
  return {
    schemaVersion:
      SESSION_KERNEL_PLAN_ACTION_SETTLEMENT_RECORD_V3_SCHEMA,
    settlement: cloneJson(
      record.settlement
    ) as SessionPlanActionSettlementV2,
  };
}

function recordRefV3(
  record: SessionKernelPersistenceRecordV3
): SessionKernelPersistenceRecordRefV3 {
  return {
    recordId: record.recordId,
    recordDigest: record.recordDigest,
  };
}

function sameRecordRefV3(
  left: SessionKernelPersistenceRecordRefV3 | null,
  right: SessionKernelPersistenceRecordRefV3 | null
): boolean {
  return left === null || right === null
    ? left === right
    : left.recordId === right.recordId
      && left.recordDigest === right.recordDigest;
}

function toolContextSnapshotByRefV3(
  records: ReadonlyMap<string, SessionKernelPersistenceRecordV3>,
  runId: string,
  contextRef: ToolContextRefV2
): ToolContextBundleV2 {
  const recordId =
    `session-kernel-v3:${runId}:tool-context:${contextRef.contextDigest}`;
  const record = records.get(recordId);
  if (!record || record.recordKind !== 'toolContextSnapshot') {
    throw new UnsupportedHistorySchemaError(
      'tool-context-snapshot-missing'
    );
  }
  const snapshot = record.data as
    SessionToolContextSnapshotRecordV3['data'];
  if (
    snapshot.runId !== runId
    || canonicalJson(snapshot.contextRef) !== canonicalJson(contextRef)
    || canonicalJson(toolContextRefV2(snapshot.toolContext))
      !== canonicalJson(contextRef)
  ) {
    throw new UnsupportedHistorySchemaError(
      'tool-context-snapshot-ref-mismatch'
    );
  }
  return cloneJson(snapshot.toolContext);
}

function providerTurnEvidenceV3(
  records: readonly SessionKernelPersistenceRecordV3[],
  runId: string,
  providerTurnId: string
): SessionProviderTurnDurableEvidenceV3 {
  const dispatchId =
    `session-kernel-v3:${runId}:provider-turn:${providerTurnId}:dispatch`;
  const terminalId =
    `session-kernel-v3:${runId}:provider-turn:${providerTurnId}:terminal`;
  const dispatchRecord = records.find(
    (record) => record.recordId === dispatchId
  );
  const terminalRecord = records.find(
    (record) => record.recordId === terminalId
  );
  if (
    dispatchRecord
    && dispatchRecord.recordKind !== 'providerTurnDispatch'
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_provider_dispatch_identity_conflict',
      `Provider dispatch identity ${providerTurnId} belongs to another record kind.`
    );
  }
  if (
    terminalRecord
    && terminalRecord.recordKind !== 'providerTurnTerminal'
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_provider_terminal_identity_conflict',
      `Provider terminal identity ${providerTurnId} belongs to another record kind.`
    );
  }
  if (terminalRecord && !dispatchRecord) {
    throw new SessionKernelPersistenceError(
      'session_kernel_provider_terminal_dispatch_missing',
      `Provider terminal ${providerTurnId} has no matching durable dispatch.`
    );
  }
  const dispatch = dispatchRecord
    ? {
        ref: recordRefV3(dispatchRecord),
        recordedAt: dispatchRecord.recordedAt,
        data: dispatchRecord.data as
          SessionProviderTurnDispatchRecordV3['data'],
      }
    : undefined;
  const terminal = terminalRecord
    ? {
        ref: recordRefV3(terminalRecord),
        recordedAt: terminalRecord.recordedAt,
        data: terminalRecord.data as
          SessionProviderTurnTerminalRecordV3['data'],
      }
    : undefined;
  if (
    dispatch
    && terminal
    && (
      !sameRecordRefV3(terminal.data.dispatchRef, dispatch.ref)
      || canonicalJson(terminal.data.authorityBinding)
        !== canonicalJson(dispatch.data.authorityBinding)
    )
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_provider_terminal_dispatch_conflict',
      `Provider terminal ${providerTurnId} does not bind its exact dispatch.`
    );
  }
  return {
    ...(dispatch ? { dispatch } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

function committedSessionHistoryV3(
  records: readonly SessionKernelPersistenceRecordV3[],
  runId: string
): {
  checkpoints: SessionKernelPersistenceRecordV3[];
  projections: SessionKernelPersistenceRecordV3[];
} {
  const byId = new Map(records.map((record) => [record.recordId, record]));
  const committedCheckpoints = new Map<
    string,
    SessionKernelPersistenceRecordV3
  >();
  const committedProjections = new Map<
    string,
    SessionKernelPersistenceRecordV3
  >();
  for (const record of records) {
    if (record.recordKind === 'checkpoint') {
      const checkpoint = record.data as SessionKernelCompactCheckpointV3;
      if (checkpoint.commitScope.kind === 'standalone') {
        committedCheckpoints.set(record.recordId, record);
      }
    }
    if (record.recordKind === 'projection') {
      const projection = record.data as SessionKernelProjectionRecordV3;
      if (projection.commitScope.kind === 'standalone') {
        committedProjections.set(record.recordId, record);
      }
    }
  }
  for (const markerRecord of records) {
    if (markerRecord.recordKind !== 'publicRequestSettled') continue;
    const marker = markerRecord.data as
      SessionKernelPublicRequestSettlementV3;
    const expectedScope: SessionKernelCheckpointCommitScopeV3 = {
      kind: 'publicRequestSettlement',
      requestId: marker.requestId,
      requestDigest: marker.requestDigest,
      outcomeDigest: marker.outcomeDigest,
    };
    const matchingRequest = records.find((candidate) => {
      if (candidate.recordKind !== 'publicRequest') return false;
      const request = candidate.data as SessionKernelPublicRequestRecordV2;
      return request.requestId === marker.requestId
        && publicRequestDigest(request) === marker.requestDigest;
    });
    if (!matchingRequest) {
      throw new SessionKernelPersistenceError(
        'session_kernel_public_request_settlement_identity_mismatch',
        `Settlement ${marker.requestId} has no matching durable request.`
      );
    }
    const checkpointRecord = resolveRecordRefV3(
      byId,
      marker.checkpointRef,
      'checkpoint'
    );
    const checkpoint = checkpointRecord.data as
      SessionKernelCompactCheckpointV3;
    if (
      canonicalJson(checkpoint.commitScope)
        !== canonicalJson(expectedScope)
      || Object.values(checkpoint.active.publicRequests).some((ref) => {
        const request = resolveRecordRefV3(byId, ref, 'publicRequest')
          .data as SessionKernelPublicRequestRecordV2;
        return request.requestId === marker.requestId;
      })
    ) {
      throw new SessionKernelPersistenceError(
        'session_kernel_public_request_settlement_checkpoint_conflict',
        `Settlement ${marker.requestId} does not bind an exact settled checkpoint.`
      );
    }
    const scopedCheckpoints = records.filter((candidate) =>
      candidate.recordKind === 'checkpoint'
      && canonicalJson(
        (candidate.data as SessionKernelCompactCheckpointV3).commitScope
      ) === canonicalJson(expectedScope)
    );
    if (
      scopedCheckpoints.length !== 1
      || scopedCheckpoints[0]!.recordId !== checkpointRecord.recordId
    ) {
      throw new SessionKernelPersistenceError(
        'session_kernel_public_request_settlement_checkpoint_conflict',
        `Settlement ${marker.requestId} has an extra or missing scoped checkpoint.`
      );
    }
    committedCheckpoints.set(checkpointRecord.recordId, checkpointRecord);
    const projectionIds = new Set<string>();
    for (const ref of marker.projectionRefs) {
      const projectionRecord = resolveRecordRefV3(
        byId,
        ref,
        'projection'
      );
      if (projectionIds.has(projectionRecord.recordId)) {
        throw new SessionKernelPersistenceError(
          'session_kernel_public_request_settlement_projection_conflict',
          `Settlement ${marker.requestId} repeats a projection ref.`
        );
      }
      projectionIds.add(projectionRecord.recordId);
      const projection = projectionRecord.data as
        SessionKernelProjectionRecordV3;
      if (
        canonicalJson(projection.commitScope)
          !== canonicalJson(expectedScope)
      ) {
        throw new SessionKernelPersistenceError(
          'session_kernel_public_request_settlement_projection_conflict',
          `Settlement ${marker.requestId} projection scope does not match its marker.`
        );
      }
      committedProjections.set(projectionRecord.recordId, projectionRecord);
    }
    const scopedProjectionIds = records
      .filter((candidate) =>
        candidate.recordKind === 'projection'
        && canonicalJson(
          (candidate.data as SessionKernelProjectionRecordV3).commitScope
        ) === canonicalJson(expectedScope)
      )
      .map((candidate) => candidate.recordId)
      .sort();
    if (
      canonicalJson(scopedProjectionIds)
        !== canonicalJson([...projectionIds].sort())
    ) {
      throw new SessionKernelPersistenceError(
        'session_kernel_public_request_settlement_projection_conflict',
        `Settlement ${marker.requestId} has an extra or missing scoped projection.`
      );
    }
  }
  for (const record of records) {
    if (record.recordKind !== 'projectionDelivered') continue;
    const receipt = decodeProjectionDelivery(record.data);
    const projectionRecord = [...committedProjections.values()].find(
      (candidate) => {
        const projection = candidate.data as SessionKernelProjectionRecordV3;
        return projection.event.projectionId === receipt.projectionId;
      }
    );
    if (
      !projectionRecord
      || projectionDigest(
        (projectionRecord.data as SessionKernelProjectionRecordV3).event
      ) !== receipt.projectionDigest
    ) {
      throw new SessionKernelPersistenceError(
        'session_kernel_projection_delivery_orphaned',
        `Projection ${receipt.projectionId} delivery is not bound to a committed event.`
      );
    }
  }
  return {
    checkpoints: [...committedCheckpoints.values()],
    projections: records.filter((record) =>
      committedProjections.has(record.recordId)
    ),
  };
}

function resolveRecordRefV3(
  records: ReadonlyMap<string, SessionKernelPersistenceRecordV3>,
  ref: SessionKernelPersistenceRecordRefV3,
  expectedKind: SessionKernelPersistenceRecordKindV3
): SessionKernelPersistenceRecordV3 {
  const record = records.get(ref.recordId);
  if (
    !record
    || record.recordKind !== expectedKind
    || record.recordDigest !== ref.recordDigest
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_record_ref_conflict',
      `Persistence ref ${ref.recordId} is missing or changed identity.`
    );
  }
  return record;
}

function compactCheckpointFromStateV3(input: {
  checkpoint: SessionKernelCheckpointV2;
  records: readonly SessionKernelPersistenceRecordV3[];
  parentRef: SessionKernelPersistenceRecordRefV3 | null;
  commitScope: SessionKernelCheckpointCommitScopeV3;
}): SessionKernelCompactCheckpointV3 {
  const { checkpoint, records, parentRef, commitScope } = input;
  const state = checkpoint.state;
  if (
    checkpoint.schemaVersion !== SESSION_KERNEL_CHECKPOINT_V3_SCHEMA
    || checkpoint.checkpointRevision !== state.checkpointRevision
    || state.schemaVersion !== SESSION_KERNEL_LOOP_V3_SCHEMA
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_checkpoint_invalid',
      'Only an exact in-memory v3 checkpoint can be compacted.'
    );
  }
  const byId = new Map(records.map((record) => [record.recordId, record]));
  const durableLastReviewRevision = lastDurableReviewRevisionV3(
    records,
    state.runId
  );
  if (state.lastReviewRevision !== durableLastReviewRevision) {
    throw new SessionKernelPersistenceError(
      'session_kernel_review_revision_invalid',
      'In-memory Review sequence does not match immutable Run history.'
    );
  }
  const currentToolContextRef = toolContextRefV2(
    state.toolContext.bundle
  );
  const durableCurrentToolContext = toolContextSnapshotByRefV3(
    byId,
    state.runId,
    currentToolContextRef
  );
  if (
    canonicalJson(durableCurrentToolContext)
      !== canonicalJson(state.toolContext.bundle)
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_tool_context_snapshot_conflict',
      'Current Session ToolContext does not match its immutable Daemon snapshot.'
    );
  }
  const inputRefs = state.inputs.map((sessionInput) => {
    const record = requireExactDataRecordV3(
      byId,
      `session-kernel-v3:${state.runId}:input:${sessionInput.inputId}`,
      'input',
      sessionInput
    );
    return recordRefV3(record);
  });
  const currentInputIndex = state.inputs.findIndex(
    (candidate) => candidate.inputId === state.currentInputId
  );
  if (currentInputIndex < 0) {
    throw new SessionKernelPersistenceError(
      'session_kernel_current_input_missing',
      'Compact checkpoint current input has no immutable input record.'
    );
  }
  const planRef = state.plan
    ? recordRefV3(requireExactDataRecordV3(
        byId,
        `session-kernel-v3:${state.runId}:plan:${state.plan.planRevision}`,
        'plan',
        state.plan
      ))
    : undefined;
  const planDecisionRef = state.planDecision
    ? recordRefV3(requireExactDataRecordV3(
        byId,
        `session-kernel-v3:${state.runId}:plan-decision:${state.planDecision.planRevision}`,
        'planDecision',
        state.planDecision
      ))
    : undefined;
  const reviewRef = state.review
    ? recordRefV3(requireExactWrappedDataRecordV3(
        byId,
        `session-kernel-v3:${state.runId}:review:${state.review.revision}`,
        'review',
        'review',
        state.review
      ))
    : undefined;
  const settlementRefs = Object.fromEntries(
    Object.entries(state.planActionSettlements).map(
      ([planActionId, settlement]) => [
        planActionId,
        recordRefV3(requireExactWrappedDataRecordV3(
          byId,
          `session-kernel-v3:${state.runId}:plan-action-settlement:${planActionId}`,
          'planActionSettlement',
          'settlement',
          settlement
        )),
      ]
    )
  );
  const publicRequests = Object.fromEntries(
    Object.entries(state.publicRequests).map(([lane, request]) => {
      if (!request) {
        throw new SessionKernelPersistenceError(
          'session_kernel_public_request_ref_invalid',
          'Compact checkpoint has an empty public request lane.'
        );
      }
      const record = requireExactDataRecordV3(
        byId,
        `session-kernel-v3:${state.runId}:request:${request.requestId}:attempt:${request.attemptCount}`,
        'publicRequest',
        request
      );
      return [lane, recordRefV3(record)];
    })
  ) as SessionKernelCompactCheckpointV3['active']['publicRequests'];
  const providerTerminalRefs = state.providerOutcomes.map((outcome) => {
    const evidence = providerTurnEvidenceV3(
      records,
      state.runId,
      outcome.providerTurnId
    );
    if (evidence.terminal?.data.terminalKind !== 'completed') {
      throw new UnsupportedHistorySchemaError(
        'provider-outcome-terminal-missing'
      );
    }
    return cloneJson(evidence.terminal.ref);
  });
  const providerEvidence = state.providerTurn
    ? providerTurnEvidenceV3(
        records,
        state.runId,
        state.providerTurn.providerTurnId
      )
    : {};
  const providerReservation = state.providerTurn
    ? compactProviderReservationV3(state.providerTurn, providerEvidence)
    : undefined;
  if (
    providerReservation
    && canonicalJson(providerReservation.contextRef)
      !== canonicalJson(currentToolContextRef)
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_provider_context_changed_in_flight',
      'A Provider reservation cannot outlive its exact ToolContext.'
    );
  }
  const providerQueue = state.providerToolCallQueue
    ? compactProviderQueueV3(
        state.providerToolCallQueue,
        providerEvidence
      )
    : undefined;
  const pendingEpochInputRef = state.pendingEpochInput
    ? recordRefV3(requireExactDataRecordV3(
        byId,
        `session-kernel-v3:${state.runId}:input:${state.pendingEpochInput.inputId}`,
        'input',
        state.pendingEpochInput
      ))
    : undefined;
  const finalAnswer = state.finalAnswer
    ? compactFinalAnswerV3(state.finalAnswer)
    : undefined;
  const terminalAnswerCandidate = state.terminalAnswerCandidate
    ? compactTerminalAnswerCandidateV1(
        state.terminalAnswerCandidate
      )
    : undefined;
  return {
    schemaVersion: SESSION_KERNEL_CHECKPOINT_V3_SCHEMA,
    checkpointRevision: checkpoint.checkpointRevision,
    savedAt: checkpoint.savedAt,
    parentRef: cloneJson(parentRef),
    commitScope: cloneJson(commitScope),
    authority: {
      runId: state.runId,
      workspaceBindingDigest: state.workspaceBindingDigest,
      controlEpoch: state.controlEpoch,
      currentInputId: state.currentInputId,
      currentInputRef: inputRefs[currentInputIndex]!,
      providerProfileId: state.providerProfile.providerProfileId,
      providerProfileRevisionDigest:
        state.providerProfile.providerProfileRevisionDigest,
      toolContext: {
        currentRef: currentToolContextRef,
        refreshRequired: state.toolContext.refreshRequired,
        ...(state.toolContext.expectedContextRef
          ? {
              expectedContextRef: cloneJson(
                state.toolContext.expectedContextRef
              ),
            }
          : {}),
      },
      ...(state.workAuthority
        ? { workAuthority: cloneJson(state.workAuthority) }
        : {}),
      ...(planRef ? { planRef } : {}),
      ...(state.planConfirmation
        ? { planConfirmation: cloneJson(state.planConfirmation) }
        : {}),
      ...(planDecisionRef ? { planDecisionRef } : {}),
      previews: cloneJson(state.previews),
      operationPlanActionBindings: cloneJson(
        state.operationPlanActionBindings
      ),
    },
    cursor: {
      inputRefs,
      inputHistoryOmittedCount: state.inputHistoryOmittedCount,
      providerTerminalRefs,
      providerOutcomeHistoryOmittedCount:
        state.providerOutcomeHistoryOmittedCount,
      reviewFactsAfterLedgerSequence:
        state.reviewFacts.coverageAfterLedgerSequence,
      afterLedgerSequence: state.lineage.cursor.afterLedgerSequence,
      snapshotHighWater: state.lineage.cursor.snapshotHighWater,
    },
    active: {
      ...(pendingEpochInputRef ? { pendingEpochInputRef } : {}),
      ...(state.activeWait
        ? { activeWait: cloneJson(state.activeWait) }
        : {}),
      ...(state.interventionResearch
        ? { interventionResearch: cloneJson(state.interventionResearch) }
        : {}),
      ...(state.userIntervention
        ? { userIntervention: cloneJson(state.userIntervention) }
        : {}),
      ...(state.userInterventionDecision
        ? {
            userInterventionDecision: cloneJson(
              state.userInterventionDecision
            ),
          }
        : {}),
      pendingGuidance: cloneJson(state.pendingGuidance),
      ...(providerReservation ? { providerReservation } : {}),
      ...(providerQueue ? { providerQueue } : {}),
      factBarriers: cloneJson(state.factBarriers),
      publicRequests,
      ...(state.runCancellation
        ? { runCancellation: cloneJson(state.runCancellation) }
        : {}),
      kernelWakeHint: state.kernelWakeHint,
    },
    refs: {
      ...(reviewRef ? { review: reviewRef } : {}),
      planActionSettlements: settlementRefs,
    },
    ...(finalAnswer ? { finalAnswer } : {}),
    ...(terminalAnswerCandidate
      ? { terminalAnswerCandidate }
      : {}),
  };
}

function requireExactDataRecordV3(
  records: ReadonlyMap<string, SessionKernelPersistenceRecordV3>,
  recordId: string,
  recordKind: SessionKernelPersistenceRecordKindV3,
  data: unknown
): SessionKernelPersistenceRecordV3 {
  const record = records.get(recordId);
  if (
    !record
    || record.recordKind !== recordKind
    || canonicalJson(record.data) !== canonicalJson(data)
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_immutable_ref_conflict',
      `Immutable ${recordKind} record ${recordId} is missing or changed.`
    );
  }
  return record;
}

function requireExactWrappedDataRecordV3(
  records: ReadonlyMap<string, SessionKernelPersistenceRecordV3>,
  recordId: string,
  recordKind: SessionKernelPersistenceRecordKindV3,
  field: 'review' | 'settlement',
  data: unknown
): SessionKernelPersistenceRecordV3 {
  const record = records.get(recordId);
  const wrapper = objectRecord(record?.data);
  if (
    !record
    || record.recordKind !== recordKind
    || !wrapper
    || canonicalJson(wrapper[field]) !== canonicalJson(data)
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_immutable_ref_conflict',
      `Immutable ${recordKind} record ${recordId} is missing or changed.`
    );
  }
  return record;
}

function compactProviderReservationV3(
  turn: SessionProviderTurnRecordV2,
  evidence: SessionProviderTurnDurableEvidenceV3
): SessionKernelCompactProviderReservationV3 {
  const dispatchRef = turn.dispatchRef ?? evidence.dispatch?.ref;
  const terminalRef = turn.terminalRef ?? evidence.terminal?.ref;
  return {
    providerTurnId: turn.providerTurnId,
    purpose: turn.purpose,
    target: cloneJson(turn.target),
    ...(turn.planRevision === undefined
      ? {}
      : { planRevision: turn.planRevision }),
    ...(turn.correction === undefined
      ? {}
      : { correction: cloneJson(turn.correction) }),
    controlEpoch: turn.controlEpoch,
    contextRef: cloneJson(turn.contextRef),
    factProjection: cloneJson(turn.factProjection),
    contextAssembly: cloneJson(turn.contextAssembly),
    startedAt: turn.startedAt,
    status: turn.status,
    ...(turn.cancellationReason
      ? { cancellationReason: turn.cancellationReason }
      : {}),
    ...(dispatchRef ? { dispatchRef: cloneJson(dispatchRef) } : {}),
    ...(terminalRef ? { terminalRef: cloneJson(terminalRef) } : {}),
  };
}

function compactProviderQueueV3(
  queue: SessionProviderToolCallQueueV2,
  evidence: SessionProviderTurnDurableEvidenceV3
): SessionKernelCompactProviderQueueV3 {
  const terminal = evidence.terminal;
  if (
    terminal?.data.terminalKind !== 'completed'
    || terminal.data.providerTurnId !== queue.providerTurnId
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_provider_queue_terminal_missing',
      'Provider queue cannot persist without its completed terminal ref.'
    );
  }
  return {
    providerTurnId: queue.providerTurnId,
    terminalRef: cloneJson(terminal.ref),
    target: cloneJson(queue.target),
    calls: cloneJson(queue.calls),
    mutationDisposition: queue.mutationDisposition,
    status: queue.status,
    outcomeRecorded: queue.outcomeRecorded,
    ...(queue.settledAt ? { settledAt: queue.settledAt } : {}),
    ...(queue.abortReason ? { abortReason: queue.abortReason } : {}),
  };
}

function compactFinalAnswerV3(
  finalAnswer: SessionFinalAnswerStateV3
): SessionKernelCompactFinalAnswerV3 {
  const {
    physicalRequestCount: _derived,
    finalText: _terminalText,
    ...wire
  } = finalAnswer;
  return cloneJson(wire);
}

function compactTerminalAnswerCandidateV1(
  candidate: SessionTerminalAnswerCandidateV1
): SessionKernelCompactTerminalAnswerCandidateV1 {
  const { text: _terminalText, ...wire } = candidate;
  return cloneJson(wire);
}

function materializeCompactCheckpointV3(input: {
  checkpoint: SessionKernelCompactCheckpointV3;
  checkpointRecord: SessionKernelPersistenceRecordV3;
  records: readonly SessionKernelPersistenceRecordV3[];
  committedCheckpoints: readonly SessionKernelPersistenceRecordV3[];
  committedProjections: readonly SessionKernelPersistenceRecordV3[];
  recovery: SessionKernelCheckpointRecoveryInputV3;
}): SessionKernelCheckpointV2 {
  const {
    checkpoint,
    records,
    committedCheckpoints,
    committedProjections,
    recovery,
  } = input;
  const byId = new Map(records.map((record) => [record.recordId, record]));
  if (
    checkpoint.authority.workspaceBindingDigest
      !== recovery.workspaceBindingDigest
    || checkpoint.authority.providerProfileId
      !== recovery.providerProfile.providerProfileId
    || checkpoint.authority.providerProfileRevisionDigest
      !== recovery.providerProfile.providerProfileRevisionDigest
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_checkpoint_identity_mismatch',
      'Compact checkpoint does not bind the current RunOpen authority.'
    );
  }
  const inputs = checkpoint.cursor.inputRefs.map((ref) => {
    const record = resolveRecordRefV3(byId, ref, 'input');
    return cloneJson(record.data) as SessionUserInputRecordV2;
  });
  if (new Set(inputs.map((record) => record.inputId)).size !== inputs.length) {
    throw new UnsupportedHistorySchemaError('checkpoint-input-order-invalid');
  }
  const currentInputRecord = resolveRecordRefV3(
    byId,
    checkpoint.authority.currentInputRef,
    'input'
  );
  const currentInput = cloneJson(
    currentInputRecord.data
  ) as SessionUserInputRecordV2;
  if (
    currentInput.inputId !== checkpoint.authority.currentInputId
    || !checkpoint.cursor.inputRefs.some((ref) =>
      sameRecordRefV3(ref, checkpoint.authority.currentInputRef)
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'checkpoint-current-input-ref-invalid'
    );
  }
  const runOpenToolContextRef = toolContextRefV2(recovery.toolContext);
  const durableRunOpenToolContext = toolContextSnapshotByRefV3(
    byId,
    checkpoint.authority.runId,
    runOpenToolContextRef
  );
  if (
    canonicalJson(durableRunOpenToolContext)
      !== canonicalJson(recovery.toolContext)
  ) {
    throw new UnsupportedHistorySchemaError(
      'run-open-tool-context-snapshot-mismatch'
    );
  }
  const checkpointToolContext = toolContextSnapshotByRefV3(
    byId,
    checkpoint.authority.runId,
    checkpoint.authority.toolContext.currentRef
  );
  const state = createSessionKernelLoopStateV2({
    runId: checkpoint.authority.runId,
    workspaceBindingDigest: recovery.workspaceBindingDigest,
    controlEpoch: checkpoint.authority.controlEpoch,
    initialInput: currentInput,
    toolContext: checkpointToolContext,
    sessionMemory: recovery.sessionMemory,
    providerProfile: recovery.providerProfile,
  });
  state.lastReviewRevision = lastDurableReviewRevisionV3(
    records,
    checkpoint.authority.runId
  );
  state.inputs = inputs;
  state.currentInputId = currentInput.inputId;
  state.inputHistoryOmittedCount =
    checkpoint.cursor.inputHistoryOmittedCount;
  state.checkpointRevision = checkpoint.checkpointRevision;
  state.workAuthority = cloneJson(
    checkpoint.authority.workAuthority
  );
  state.planConfirmation = cloneJson(
    checkpoint.authority.planConfirmation
  );
  state.previews = cloneJson(checkpoint.authority.previews);
  state.operationPlanActionBindings = cloneJson(
    checkpoint.authority.operationPlanActionBindings
  );
  state.toolContext = materializeToolContextStateV3(
    checkpoint.authority.toolContext,
    checkpointToolContext
  );
  if (checkpoint.authority.planRef) {
    state.plan = cloneJson(resolveRecordRefV3(
      byId,
      checkpoint.authority.planRef,
      'plan'
    ).data) as SessionNaturalLanguagePlanV2;
  }
  try {
    currentSessionPlanScopePreviewsV2(
      state,
      state.plan,
      { requireComplete: false }
    );
  } catch {
    throw new UnsupportedHistorySchemaError(
      'checkpoint-scope-preview-binding-invalid'
    );
  }
  if (checkpoint.authority.planDecisionRef) {
    state.planDecision = cloneJson(resolveRecordRefV3(
      byId,
      checkpoint.authority.planDecisionRef,
      'planDecision'
    ).data) as SessionPlanDecisionV2;
  }
  if (checkpoint.refs.review) {
    const data = resolveRecordRefV3(
      byId,
      checkpoint.refs.review,
      'review'
    ).data as { review: SessionKernelReviewV2 };
    state.review = cloneJson(data.review);
  }
  state.planActionSettlements = Object.fromEntries(
    Object.entries(checkpoint.refs.planActionSettlements).map(
      ([planActionId, ref]) => {
        const data = resolveRecordRefV3(
          byId,
          ref,
          'planActionSettlement'
        ).data as { settlement: SessionPlanActionSettlementV2 };
        if (data.settlement.planActionId !== planActionId) {
          throw new UnsupportedHistorySchemaError(
            'checkpoint-plan-action-settlement-ref-invalid'
          );
        }
        return [planActionId, cloneJson(data.settlement)];
      }
    )
  );
  state.pendingEpochInput = checkpoint.active.pendingEpochInputRef
    ? cloneJson(resolveRecordRefV3(
        byId,
        checkpoint.active.pendingEpochInputRef,
        'input'
      ).data) as SessionUserInputRecordV2
    : undefined;
  state.activeWait = cloneJson(checkpoint.active.activeWait);
  state.interventionResearch = cloneJson(
    checkpoint.active.interventionResearch
  );
  state.userIntervention = cloneJson(
    checkpoint.active.userIntervention
  );
  state.userInterventionDecision = cloneJson(
    checkpoint.active.userInterventionDecision
  );
  state.pendingGuidance = cloneJson(checkpoint.active.pendingGuidance);
  state.factBarriers = cloneJson(checkpoint.active.factBarriers);
  state.publicRequests = Object.fromEntries(
    Object.entries(checkpoint.active.publicRequests).map(([lane, ref]) => {
      const request = cloneJson(resolveRecordRefV3(
        byId,
        ref!,
        'publicRequest'
      ).data) as SessionKernelPublicRequestRecordV2;
      if (request.lane !== lane) {
        throw new UnsupportedHistorySchemaError(
          'checkpoint-public-request-ref-invalid'
        );
      }
      return [lane, request];
    })
  );
  state.runCancellation = cloneJson(checkpoint.active.runCancellation);
  state.kernelWakeHint = checkpoint.active.kernelWakeHint;
  prepareSessionKernelFactReplayV3(state, {
    coverageAfterLedgerSequence:
      checkpoint.cursor.reviewFactsAfterLedgerSequence,
    snapshotHighWater: checkpoint.cursor.snapshotHighWater,
  });
  state.providerOutcomes = materializeProviderOutcomesV3(
    checkpoint.cursor.providerTerminalRefs,
    byId,
    records,
    committedCheckpoints,
    recovery
  );
  if (checkpoint.terminalAnswerCandidate) {
    state.terminalAnswerCandidate =
      materializeTerminalAnswerCandidateV1({
        candidate: checkpoint.terminalAnswerCandidate,
        state,
        records,
        committedProjections,
      });
  }
  const currentInputHasDurableToolResponse =
    checkpoint.cursor.providerTerminalRefs.some((ref) => {
      const terminal = resolveRecordRefV3(
        byId,
        ref,
        'providerTurnTerminal'
      ).data as SessionProviderTurnTerminalRecordV3['data'];
      return terminal.authorityBinding.inputId === state.currentInputId
        && terminal.authorityBinding.controlEpoch === state.controlEpoch
        && terminal.orderedItems.some((item) =>
          item.kind === 'toolCall'
        );
    });
  if (
    !state.workAuthority
    && !state.plan
    && (
      currentInputHasDurableToolResponse
      || checkpoint.active.providerQueue?.calls.some((call) =>
        call.intent?.authority.kind === 'read'
      )
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'checkpoint-context-read-work-authority-missing'
    );
  }
  state.providerOutcomeHistoryOmittedCount =
    checkpoint.cursor.providerOutcomeHistoryOmittedCount;
  const activeEvidence = checkpoint.active.providerReservation
    ? providerTurnEvidenceV3(
        records,
        state.runId,
        checkpoint.active.providerReservation.providerTurnId
      )
    : {};
  if (checkpoint.active.providerReservation) {
    state.providerTurn = materializeProviderReservationV3(
      checkpoint.active.providerReservation,
      activeEvidence,
      state,
      byId
    );
  }
  if (checkpoint.active.providerQueue) {
    state.providerToolCallQueue = materializeProviderQueueV3(
      checkpoint.active.providerQueue,
      activeEvidence
    );
  }
  if (checkpoint.finalAnswer) {
    const physicalRequestCount =
      checkpoint.finalAnswer.commitKind === 'candidatePromotion'
        ? 0
        : countMatchingFinalAnswerDispatchesV3(
            records,
            state.runId,
            checkpoint.finalAnswer,
            recovery.providerProfile
          );
    state.finalAnswer = {
      ...cloneJson(checkpoint.finalAnswer),
      physicalRequestCount,
    } as SessionFinalAnswerStateV3;
    if (checkpoint.finalAnswer.commitKind === 'candidatePromotion') {
      recoverPromotedCandidateFinalAnswerV1(state);
    } else {
      recoverFinalAnswerFromTerminalV3(state, activeEvidence);
    }
  }
  restoreProjectionHeadsV3(state, committedProjections);
  return {
    schemaVersion: SESSION_KERNEL_CHECKPOINT_V3_SCHEMA,
    checkpointRevision: checkpoint.checkpointRevision,
    savedAt: checkpoint.savedAt,
    state,
  };
}

function recoverPromotedCandidateFinalAnswerV1(
  state: SessionKernelLoopStateV2
): void {
  const finalAnswer = state.finalAnswer;
  const candidate = state.terminalAnswerCandidate;
  const providerTurn = state.providerTurn;
  if (
    finalAnswer?.status !== 'committed'
    || finalAnswer.commitKind !== 'candidatePromotion'
    || finalAnswer.physicalRequestCount !== 0
    || !finalAnswer.providerTurnId
    || !finalAnswer.committedAt
    || !candidate
    || candidate.providerTurnId !== finalAnswer.providerTurnId
    || candidate.inputId !== finalAnswer.binding.inputId
    || candidate.controlEpoch !== finalAnswer.binding.controlEpoch
    || candidate.languageRevision !== finalAnswer.binding.controlEpoch
    || candidate.snapshotHighWater
      !== finalAnswer.binding.snapshotHighWater
    || !sameSessionWorkAuthorityV3(
      candidate.workAuthority,
      finalAnswer.binding.workAuthority
    )
    || !providerTurn
    || providerTurn.providerTurnId !== candidate.providerTurnId
    || providerTurn.status !== 'completed'
    || !providerTurn.response
    || providerTurn.purpose === 'finalAnswer'
    || providerTurn.target.kind === 'finalAnswer'
    || state.currentInputId !== finalAnswer.binding.inputId
    || state.controlEpoch !== finalAnswer.binding.controlEpoch
    || state.review?.status !== 'final'
    || state.review.revision !== finalAnswer.binding.reviewRevision
    || state.review.snapshotHighWater
      !== finalAnswer.binding.snapshotHighWater
    || !state.review.workAuthority
    || !sameSessionWorkAuthorityV3(
      state.review.workAuthority,
      finalAnswer.binding.workAuthority
    )
    || !state.providerOutcomes.some((outcome) =>
      outcome.providerTurnId === candidate.providerTurnId
      && outcome.outputKind === 'answer'
      && outcome.recordedAt === candidate.recordedAt
      && outcome.summary === candidate.text.slice(0, 8_192)
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_promoted_terminal_answer_invalid'
    );
  }
  state.finalAnswer = {
    ...cloneJson(finalAnswer),
    finalText: candidate.text,
  };
}

function recoverFinalAnswerFromTerminalV3(
  state: SessionKernelLoopStateV2,
  evidence: SessionProviderTurnDurableEvidenceV3
): void {
  const finalAnswer = state.finalAnswer;
  if (
    finalAnswer?.status !== 'requesting'
    && finalAnswer?.status !== 'committed'
  ) {
    return;
  }
  const providerTurnId = finalAnswer.providerTurnId;
  const providerTurn = state.providerTurn;
  if (
    !providerTurnId
    || !providerTurn
    || providerTurn.providerTurnId !== providerTurnId
    || providerTurn.purpose !== 'finalAnswer'
    || providerTurn.target.kind !== 'finalAnswer'
    || canonicalJson(providerTurn.target) !== canonicalJson({
      kind: 'finalAnswer',
      ...finalAnswer.binding,
    })
    || providerTurn.controlEpoch !== finalAnswer.binding.controlEpoch
    || providerTurn.planRevision
      !== finalAnswerPlanRevisionV3(finalAnswer.binding)
    || providerTurn.contextAssembly.providerProfile.providerProfileId
      !== state.providerProfile.providerProfileId
    || providerTurn.contextAssembly.providerProfile
      .providerProfileRevisionDigest
      !== state.providerProfile.providerProfileRevisionDigest
    || state.currentInputId !== finalAnswer.binding.inputId
    || state.controlEpoch !== finalAnswer.binding.controlEpoch
    || !state.workAuthority
    || !sameSessionWorkAuthorityV3(
      state.workAuthority,
      finalAnswer.binding.workAuthority
    )
    || state.review?.revision !== finalAnswer.binding.reviewRevision
    || state.review.snapshotHighWater
      !== finalAnswer.binding.snapshotHighWater
    || !state.review.workAuthority
    || !sameSessionWorkAuthorityV3(
      state.review.workAuthority,
      finalAnswer.binding.workAuthority
    )
    || (
      evidence.dispatch !== undefined
      && evidence.dispatch.data.providerTurnId !== providerTurnId
    )
    || (
      evidence.terminal !== undefined
      && evidence.terminal.data.providerTurnId !== providerTurnId
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'final-answer-provider-turn-identity-mismatch'
    );
  }
  const terminal = evidence.terminal;
  if (!evidence.dispatch) {
    if (finalAnswer.status === 'committed') {
      throw new UnsupportedHistorySchemaError(
        'final-answer-committed-dispatch-missing'
      );
    }
    state.finalAnswer = {
      status: 'pending',
      binding: cloneJson(finalAnswer.binding),
      physicalRequestCount: finalAnswer.physicalRequestCount,
    };
    state.providerTurn = undefined;
    return;
  }
  if (!terminal) {
    throw new SessionKernelPersistenceError(
      'session_kernel_provider_dispatch_unresolved',
      'Final-answer dispatch has no terminal and cannot be retried.'
    );
  }
  const currentInputSections = providerTurn.contextAssembly.trimming.sections
    .filter((section) => section.section === 'currentInput');
  if (
    evidence.dispatch.data.purpose !== 'finalAnswer'
    || evidence.dispatch.data.authorityBinding.runId !== state.runId
    || evidence.dispatch.data.authorityBinding.inputId
      !== finalAnswer.binding.inputId
    || evidence.dispatch.data.authorityBinding.controlEpoch
      !== finalAnswer.binding.controlEpoch
    || currentInputSections.length !== 1
    || evidence.dispatch.data.authorityBinding.currentInputDigest
      !== currentInputSections[0]!.digest
    || evidence.dispatch.data.authorityBinding.planRevision
      !== finalAnswerPlanRevisionV3(finalAnswer.binding)
    || evidence.dispatch.data.authorityBinding.reviewRevision
      !== finalAnswer.binding.reviewRevision
    || evidence.dispatch.data.authorityBinding.snapshotHighWater
      !== finalAnswer.binding.snapshotHighWater
    || evidence.dispatch.data.authorityBinding.providerProfileId
      !== state.providerProfile.providerProfileId
    || evidence.dispatch.data.authorityBinding
      .providerProfileRevisionDigest
      !== state.providerProfile.providerProfileRevisionDigest
  ) {
    throw new UnsupportedHistorySchemaError(
      'final-answer-terminal-authority-mismatch'
    );
  }
  if (terminal.data.terminalKind !== 'completed') {
    if (finalAnswer.status === 'committed') {
      throw new UnsupportedHistorySchemaError(
        'final-answer-committed-terminal-invalid'
      );
    }
    const reasonCode = terminal.data.reasonCode
      ?? 'session_kernel_provider_terminal_failed';
    state.finalAnswer =
      terminal.data.terminalKind === 'failed'
      && reasonCode === 'provider_retryable_no_mutation'
      && finalAnswer.physicalRequestCount < 3
        ? {
            status: 'pending',
            binding: cloneJson(finalAnswer.binding),
            physicalRequestCount: finalAnswer.physicalRequestCount,
            lastErrorCode: reasonCode,
          }
        : {
            status: 'finalAnswerFailed',
            binding: cloneJson(finalAnswer.binding),
            physicalRequestCount: finalAnswer.physicalRequestCount,
            providerTurnId: finalAnswer.providerTurnId,
            failedAt: terminal.recordedAt,
            lastErrorCode: reasonCode,
          };
    if (state.providerTurn) state.providerTurn.status = 'failed';
    return;
  }
  if (terminal.data.orderedItems.some((item) => item.kind === 'toolCall')) {
    throw new UnsupportedHistorySchemaError(
      'final-answer-terminal-tool-conflict'
    );
  }
  const text = terminalFinalTextV3(
    terminal.data.orderedItems.filter(
      (item): item is Extract<
        SessionProviderTerminalOrderedItemV3,
        { kind: 'text' }
      > => item.kind === 'text'
    )
  );
  if (!text.trim()) {
    state.finalAnswer = {
      status: 'finalAnswerFailed',
      binding: cloneJson(finalAnswer.binding),
      physicalRequestCount: finalAnswer.physicalRequestCount,
      providerTurnId: finalAnswer.providerTurnId,
      failedAt: terminal.recordedAt,
      lastErrorCode: 'session_kernel_final_answer_missing',
    };
    if (state.providerTurn) state.providerTurn.status = 'failed';
    return;
  }
  if (finalAnswer.status === 'requesting') {
    if (state.providerTurn?.status !== 'active') {
      throw new UnsupportedHistorySchemaError(
        'final-answer-candidate-reservation-invalid'
      );
    }
    return;
  }
  state.finalAnswer = {
    status: 'committed',
    binding: cloneJson(finalAnswer.binding),
    physicalRequestCount: finalAnswer.physicalRequestCount,
    providerTurnId: terminal.data.providerTurnId,
    committedAt: terminal.recordedAt,
    finalText: text,
    commitKind: 'finalSynthesis',
  };
  if (state.providerTurn) state.providerTurn.status = 'completed';
  const outcome = state.providerOutcomes.find((candidate) =>
    candidate.providerTurnId === providerTurnId
  );
  if (
    !outcome
    || outcome.outputKind !== 'answer'
    || outcome.recordedAt !== terminal.recordedAt
    || outcome.summary !== text.slice(0, 8_192)
    || canonicalJson(outcome.providerResult)
      !== canonicalJson(terminal.data.providerResult)
  ) {
    throw new UnsupportedHistorySchemaError(
      'final-answer-provider-outcome-mismatch'
    );
  }
}

function finalAnswerPlanRevisionV3(
  binding: SessionFinalAnswerStateV3['binding']
): string | undefined {
  return binding.workAuthority.kind === 'plan'
    ? binding.workAuthority.planRevision
    : undefined;
}

function materializeToolContextStateV3(
  wire: SessionKernelCompactCheckpointV3['authority']['toolContext'],
  bundle: import('@deepcode/protocol').ToolContextBundleV2
): SessionKernelLoopStateV2['toolContext'] {
  const initialRef = toolContextRefV2(bundle);
  if (
    canonicalJson(initialRef) !== canonicalJson(wire.currentRef)
  ) {
    throw new UnsupportedHistorySchemaError(
      'checkpoint-tool-context-snapshot-mismatch'
    );
  }
  return {
    bundle: cloneJson(bundle),
    refreshRequired: wire.refreshRequired,
    ...(wire.expectedContextRef
      ? { expectedContextRef: cloneJson(wire.expectedContextRef) }
      : {}),
    ...(wire.refreshRequired
      ? { invalidationReason: 'kernelFact' as const }
      : {}),
  };
}

function materializeProviderOutcomesV3(
  refs: readonly SessionKernelPersistenceRecordRefV3[],
  byId: ReadonlyMap<string, SessionKernelPersistenceRecordV3>,
  records: readonly SessionKernelPersistenceRecordV3[],
  committedCheckpoints: readonly SessionKernelPersistenceRecordV3[],
  recovery: SessionKernelCheckpointRecoveryInputV3
): SessionProviderOutcomeRecordV2[] {
  const seen = new Set<string>();
  return refs.map((ref) => {
    if (seen.has(ref.recordId)) {
      throw new UnsupportedHistorySchemaError(
        'provider-terminal-history-duplicate'
      );
    }
    seen.add(ref.recordId);
    const terminalRecord = resolveRecordRefV3(
      byId,
      ref,
      'providerTurnTerminal'
    );
    const terminal = terminalRecord.data as
      SessionProviderTurnTerminalRecordV3['data'];
    if (
      terminal.terminalKind !== 'completed'
      || !terminal.providerResult
      || !terminal.completion
    ) {
      throw new UnsupportedHistorySchemaError(
        'provider-outcome-terminal-not-completed'
      );
    }
    const evidence = providerTurnEvidenceV3(
      records,
      terminal.authorityBinding.runId,
      terminal.providerTurnId
    );
    if (!evidence.dispatch || !evidence.terminal) {
      throw new UnsupportedHistorySchemaError(
        'provider-outcome-evidence-incomplete'
      );
    }
    const source = providerOutcomeSourceCheckpointV3(
      ref,
      terminal.providerTurnId,
      committedCheckpoints
    );
    return materializeProviderOutcomeV3({
      terminalRef: ref,
      evidence: {
        dispatch: evidence.dispatch,
        terminal: evidence.terminal,
      },
      source,
      byId,
      recovery,
    });
  });
}

function providerOutcomeSourceCheckpointV3(
  terminalRef: SessionKernelPersistenceRecordRefV3,
  providerTurnId: string,
  committedCheckpoints: readonly SessionKernelPersistenceRecordV3[]
): SessionKernelCompactCheckpointV3 {
  const source = committedCheckpoints
    .map((record) => record.data as SessionKernelCompactCheckpointV3)
    .filter((checkpoint) =>
      checkpoint.cursor.providerTerminalRefs.some((ref) =>
        sameRecordRefV3(ref, terminalRef)
      )
    )
    .sort((left, right) =>
      left.checkpointRevision - right.checkpointRevision
    )[0];
  const reservation = source?.active.providerReservation;
  if (
    !source
    || !reservation
    || reservation.providerTurnId !== providerTurnId
    || !reservation.dispatchRef
    || !reservation.terminalRef
    || !sameRecordRefV3(reservation.terminalRef, terminalRef)
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-reservation-checkpoint-missing'
    );
  }
  return source;
}

function materializeProviderOutcomeV3(input: {
  terminalRef: SessionKernelPersistenceRecordRefV3;
  evidence: Required<SessionProviderTurnDurableEvidenceV3>;
  source: SessionKernelCompactCheckpointV3;
  byId: ReadonlyMap<string, SessionKernelPersistenceRecordV3>;
  recovery: SessionKernelCheckpointRecoveryInputV3;
}): SessionProviderOutcomeRecordV2 {
  const { terminalRef, evidence, source, byId, recovery } = input;
  const reservation = source.active.providerReservation!;
  const dispatch = evidence.dispatch;
  const terminal = evidence.terminal;
  if (
    !sameRecordRefV3(reservation.dispatchRef!, dispatch.ref)
    || !sameRecordRefV3(reservation.terminalRef!, terminal.ref)
    || !sameRecordRefV3(terminalRef, terminal.ref)
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-record-ref-mismatch'
    );
  }
  const currentInput = cloneJson(resolveRecordRefV3(
    byId,
    source.authority.currentInputRef,
    'input'
  ).data) as SessionUserInputRecordV2;
  if (
    currentInput.inputId !== source.authority.currentInputId
    || !source.cursor.inputRefs.some((ref) =>
      sameRecordRefV3(ref, source.authority.currentInputRef)
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-current-input-ref-invalid'
    );
  }
  const toolContext = providerToolContextBindingV2(
    toolContextSnapshotByRefV3(
      byId,
      source.authority.runId,
      reservation.contextRef
    )
  );
  if (
    canonicalJson(source.authority.toolContext.currentRef)
      !== canonicalJson(reservation.contextRef)
    || canonicalJson(reservation.contextRef)
      !== canonicalJson(toolContext.contextRef)
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-tool-context-unavailable'
    );
  }
  const plan = reservation.planRevision === undefined
    ? undefined
    : immutablePlanByRevisionV3(
        byId,
        source.authority.runId,
        reservation.planRevision
      );
  const currentInputSections = reservation.contextAssembly.trimming.sections
    .filter((section) => section.section === 'currentInput');
  const authority = dispatch.data.authorityBinding;
  const target = reservation.target;
  const expectedReviewRevision = target.kind === 'finalAnswer'
    ? target.reviewRevision
    : undefined;
  const expectedSnapshotHighWater = target.kind === 'finalAnswer'
    ? target.snapshotHighWater
    : undefined;
  if (
    dispatch.data.providerTurnId !== reservation.providerTurnId
    || dispatch.data.purpose !== reservation.purpose
    || terminal.data.providerTurnId !== reservation.providerTurnId
    || authority.runId !== source.authority.runId
    || authority.inputId !== currentInput.inputId
    || authority.controlEpoch !== reservation.controlEpoch
    || source.authority.controlEpoch !== reservation.controlEpoch
    || currentInputSections.length !== 1
    || authority.currentInputDigest !== currentInputSections[0]!.digest
    || authority.planRevision !== reservation.planRevision
    || authority.reviewRevision !== expectedReviewRevision
    || authority.snapshotHighWater !== expectedSnapshotHighWater
    || authority.providerProfileId
      !== recovery.providerProfile.providerProfileId
    || authority.providerProfileRevisionDigest
      !== recovery.providerProfile.providerProfileRevisionDigest
    || source.authority.providerProfileId
      !== recovery.providerProfile.providerProfileId
    || source.authority.providerProfileRevisionDigest
      !== recovery.providerProfile.providerProfileRevisionDigest
    || reservation.contextAssembly.providerProfile.providerProfileId
      !== recovery.providerProfile.providerProfileId
    || reservation.contextAssembly.providerProfile
      .providerProfileRevisionDigest
      !== recovery.providerProfile.providerProfileRevisionDigest
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-authority-mismatch'
    );
  }
  if (target.kind === 'planAction') {
    if (
      !plan
      || source.authority.planRef === undefined
      || !plan.actions.some((action) =>
        action.manifest.planActionId === target.planActionId
      )
      || !sameRecordRefV3(
        source.authority.planRef,
        planRecordRefV3(byId, source.authority.runId, plan)
      )
    ) {
      throw new UnsupportedHistorySchemaError(
        'provider-outcome-plan-action-plan-mismatch'
      );
    }
  }
  if (target.kind === 'finalAnswer') {
    requireFinalAnswerOutcomeAuthorityV3(
      source,
      byId,
      reservation.providerTurnId,
      target,
      plan
    );
  }
  const semanticInput = {
    providerTurnId: reservation.providerTurnId,
    purpose: reservation.purpose,
    runId: source.authority.runId,
    currentInput,
    providerProfile: cloneJson(recovery.providerProfile),
    ...(plan ? { plan: cloneJson(plan) } : {}),
    target: cloneJson(target),
    toolContext,
  };
  const backendOutput = decodeCompletedProviderTerminalV3(
    semanticInput,
    terminal,
    recovery.providerProfile.providerProfileId
  );
  const output = adaptSessionKernelProviderBackendOutputV2(
    semanticInput,
    backendOutput,
    terminal.recordedAt
  );
  if (output.kind !== 'toolIntent' && reservation.status !== 'completed') {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-reservation-status-mismatch'
    );
  }
  if (output.kind !== 'plan') {
    const expectedPlanRef = plan
      ? planRecordRefV3(byId, source.authority.runId, plan)
      : undefined;
    if (
      (source.authority.planRef === undefined)
        !== (expectedPlanRef === undefined)
      || (
        source.authority.planRef !== undefined
        && expectedPlanRef !== undefined
        && !sameRecordRefV3(source.authority.planRef, expectedPlanRef)
      )
    ) {
      throw new UnsupportedHistorySchemaError(
        'provider-outcome-input-plan-ref-mismatch'
      );
    }
  }
  if (output.kind === 'plan') {
    const ref = planRecordRefV3(
      byId,
      source.authority.runId,
      output.plan
    );
    if (
      source.authority.planRef === undefined
      || !sameRecordRefV3(source.authority.planRef, ref)
    ) {
      throw new UnsupportedHistorySchemaError(
        'provider-outcome-plan-ref-mismatch'
      );
    }
  }
  if (
    target.kind === 'planAction'
    && output.kind === 'planActionComplete'
  ) {
    requirePlanActionOutcomeSettlementV3(
      source,
      byId,
      plan!.planRevision,
      target.planActionId,
      source.authority.controlEpoch,
      output.outcome,
      reservation.providerTurnId,
      output.control.callId,
      output.control.argumentsDigest,
      source.cursor.snapshotHighWater,
      terminal.recordedAt
    );
  }
  if (output.kind === 'toolIntent') {
    return materializeToolProviderOutcomeV3(source, evidence, output);
  }
  if (source.active.providerQueue?.providerTurnId
    === reservation.providerTurnId) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-unexpected-tool-settlement'
    );
  }
  if (output.kind === 'noTool' && output.repair) {
    return repairedSessionProviderOutcomeV2(
      reservation.providerTurnId,
      output,
      terminal.recordedAt
    );
  }
  const summary = providerOutputSummaryV3(output);
  return {
    providerTurnId: reservation.providerTurnId,
    outputKind: output.kind,
    recordedAt: terminal.recordedAt,
    ...(summary === undefined ? {} : { summary }),
    providerResult: cloneJson(output.providerResult),
  };
}

function immutablePlanByRevisionV3(
  byId: ReadonlyMap<string, SessionKernelPersistenceRecordV3>,
  runId: string,
  planRevision: string
): SessionNaturalLanguagePlanV2 {
  const record = byId.get(
    `session-kernel-v3:${runId}:plan:${planRevision}`
  );
  const plan = record?.data as SessionNaturalLanguagePlanV2 | undefined;
  if (!record || record.recordKind !== 'plan'
    || plan?.planRevision !== planRevision) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-plan-unavailable'
    );
  }
  return cloneJson(plan);
}

function planRecordRefV3(
  byId: ReadonlyMap<string, SessionKernelPersistenceRecordV3>,
  runId: string,
  plan: SessionNaturalLanguagePlanV2
): SessionKernelPersistenceRecordRefV3 {
  const record = byId.get(
    `session-kernel-v3:${runId}:plan:${plan.planRevision}`
  );
  if (!record || record.recordKind !== 'plan'
    || canonicalJson(record.data) !== canonicalJson(plan)) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-plan-record-mismatch'
    );
  }
  return recordRefV3(record);
}

function requirePlanActionOutcomeSettlementV3(
  source: SessionKernelCompactCheckpointV3,
  byId: ReadonlyMap<string, SessionKernelPersistenceRecordV3>,
  planRevision: string,
  planActionId: string,
  controlEpoch: number,
  outcome: SessionPlanActionSettlementV2['outcome'],
  providerTurnId: string,
  controlCallId: string,
  controlArgumentsDigest: string,
  snapshotHighWater: number,
  recordedAt: string
): void {
  const ref = source.refs.planActionSettlements[planActionId];
  if (!ref) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-plan-action-settlement-missing'
    );
  }
  const wrapper = resolveRecordRefV3(
    byId,
    ref,
    'planActionSettlement'
  ).data as { settlement: SessionPlanActionSettlementV2 };
  const expected: SessionPlanActionSettlementV2 = {
    kind: 'planActionComplete',
    planRevision,
    planActionId,
    controlEpoch,
    outcome,
    providerTurnId,
    controlCallId,
    controlArgumentsDigest,
    snapshotHighWater,
    recordedAt,
  };
  if (canonicalJson(wrapper.settlement) !== canonicalJson(expected)) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-plan-action-settlement-mismatch'
    );
  }
}

function requireFinalAnswerOutcomeAuthorityV3(
  source: SessionKernelCompactCheckpointV3,
  byId: ReadonlyMap<string, SessionKernelPersistenceRecordV3>,
  providerTurnId: string,
  target: Extract<SessionProviderTurnTargetV2, { kind: 'finalAnswer' }>,
  plan: SessionNaturalLanguagePlanV2 | undefined
): void {
  const reviewRef = source.refs.review;
  if (!reviewRef || !source.authority.workAuthority) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-final-answer-authority-missing'
    );
  }
  const review = (resolveRecordRefV3(
    byId,
    reviewRef,
    'review'
  ).data as { review: SessionKernelReviewV2 }).review;
  const finalAnswer = source.finalAnswer;
  const targetWorkAuthority = target.workAuthority;
  const planAuthorityInvalid = targetWorkAuthority.kind === 'plan'
    ? !plan
      || !source.authority.planRef
      || plan.planRevision !== targetWorkAuthority.planRevision
      || !sameRecordRefV3(
        source.authority.planRef,
        planRecordRefV3(byId, source.authority.runId, plan)
      )
    : plan !== undefined || source.authority.planRef !== undefined;
  if (
    review.revision !== target.reviewRevision
    || review.snapshotHighWater !== target.snapshotHighWater
    || !review.workAuthority
    || !sameSessionWorkAuthorityV3(
      review.workAuthority,
      targetWorkAuthority
    )
    || !sameSessionWorkAuthorityV3(
      source.authority.workAuthority,
      targetWorkAuthority
    )
    || planAuthorityInvalid
    || finalAnswer?.status !== 'committed'
    || finalAnswer.providerTurnId !== providerTurnId
    || canonicalJson(finalAnswer.binding) !== canonicalJson({
      inputId: target.inputId,
      controlEpoch: target.controlEpoch,
      workAuthority: targetWorkAuthority,
      reviewRevision: target.reviewRevision,
      snapshotHighWater: target.snapshotHighWater,
    })
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-final-answer-authority-mismatch'
    );
  }
}

function materializeToolProviderOutcomeV3(
  source: SessionKernelCompactCheckpointV3,
  evidence: Required<SessionProviderTurnDurableEvidenceV3>,
  output: Extract<
    import('./types.js').SessionProviderTurnOutputV2,
    { kind: 'toolIntent' }
  >
): SessionProviderOutcomeRecordV2 {
  const compactQueue = source.active.providerQueue;
  const reservation = source.active.providerReservation!;
  if (!compactQueue
    || compactQueue.providerTurnId !== output.receipt.providerTurnId
    || !compactQueue.outcomeRecorded
    || compactQueue.status === 'active'
    || !compactQueue.settledAt) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-tool-settlement-missing'
    );
  }
  const queue = materializeProviderQueueV3(compactQueue, evidence);
  if (
    canonicalJson(queue.receipt) !== canonicalJson(output.receipt)
    || canonicalJson(queue.providerResult)
      !== canonicalJson(output.providerResult)
    || canonicalJson(queue.orderedItems) !== canonicalJson(output.items)
    || canonicalJson(queue.completion)
      !== canonicalJson(output.completion)
    || canonicalJson(queue.target)
      !== canonicalJson(source.active.providerReservation!.target)
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-tool-settlement-mismatch'
    );
  }
  const expectedReservationStatus = compactQueue.status === 'completed'
    ? 'completed'
    : compactQueue.abortReason === 'userInput'
        || compactQueue.abortReason === 'runCancelled'
      ? 'cancelled'
      : 'aborted';
  if (reservation.status !== expectedReservationStatus) {
    throw new UnsupportedHistorySchemaError(
      'provider-outcome-tool-reservation-status-mismatch'
    );
  }
  const summary = queue.status === 'completed'
    ? `Completed ${queue.calls.length} ordered Provider tool call(s).`
    : [
        'Aborted ordered Provider tool calls:',
        queue.abortReason ?? 'unknown',
        `unexecuted=${queue.calls.filter((call) =>
          call.status === 'unexecuted'
        ).length}`,
      ].join(' ');
  return {
    providerTurnId: output.receipt.providerTurnId,
    outputKind: 'toolIntent',
    recordedAt: compactQueue.settledAt,
    summary,
    toolCallReceipt: cloneJson(output.receipt),
    toolSettlement: {
      status: compactQueue.status,
      settledAt: compactQueue.settledAt,
    },
    toolCalls: settledSessionProviderToolCallsV2(queue),
    providerResult: cloneJson(output.providerResult),
  };
}

function providerOutputSummaryV3(
  output: Exclude<
    import('./types.js').SessionProviderTurnOutputV2,
    { kind: 'toolIntent' }
  >
): string | undefined {
  if (output.kind === 'answer') return output.text.slice(0, 8_192);
  if (output.kind === 'noTool') return output.guidance?.slice(0, 8_192);
  if (output.kind === 'planActionComplete') {
    return `PlanAction outcome: ${output.outcome}`;
  }
  if (output.kind === 'intervention') {
    return output.proposal.problemSummary.slice(0, 8_192);
  }
  return `${output.plan.title}\n${output.plan.objective}`.slice(0, 8_192);
}

function terminalFinalTextV3(
  items: readonly Extract<SessionProviderTerminalOrderedItemV3, { kind: 'text' }>[]
): string {
  const firstFinal = items.findIndex((item) => item.phase === 'final_answer');
  const lastCommentary = items.findLastIndex(
    (item) => item.phase === 'commentary'
  );
  return (firstFinal >= 0
    ? items.slice(firstFinal)
    : items.slice(lastCommentary + 1)
        .filter((item) => item.phase === 'unknown'))
    .map((item) => item.text)
    .join('');
}

function materializeTerminalAnswerCandidateV1(input: {
  candidate: SessionKernelCompactTerminalAnswerCandidateV1;
  state: SessionKernelLoopStateV2;
  records: readonly SessionKernelPersistenceRecordV3[];
  committedProjections: readonly SessionKernelPersistenceRecordV3[];
}): SessionTerminalAnswerCandidateV1 {
  const { candidate, state, records, committedProjections } = input;
  const evidence = providerTurnEvidenceV3(
    records,
    state.runId,
    candidate.providerTurnId
  );
  const terminal = evidence.terminal;
  if (
    !evidence.dispatch
    || !terminal
    || terminal.data.terminalKind !== 'completed'
    || terminal.data.authorityBinding.inputId !== candidate.inputId
    || terminal.data.authorityBinding.controlEpoch
      !== candidate.controlEpoch
    || terminal.recordedAt !== candidate.recordedAt
    || candidate.inputId !== state.currentInputId
    || candidate.controlEpoch !== state.controlEpoch
    || candidate.snapshotHighWater
      > state.lineage.cursor.snapshotHighWater
    || !state.workAuthority
    || !sameSessionWorkAuthorityV3(
      candidate.workAuthority,
      state.workAuthority
    )
    || !state.providerOutcomes.some((outcome) =>
      outcome.providerTurnId === candidate.providerTurnId
      && outcome.outputKind === 'answer'
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_terminal_answer_candidate_invalid'
    );
  }
  const text = terminalFinalTextV3(
    terminal.data.orderedItems.filter(
      (item): item is Extract<
        SessionProviderTerminalOrderedItemV3,
        { kind: 'text' }
      > => item.kind === 'text'
    )
  );
  if (
    !text.trim()
    || sha256Hash(text) !== candidate.textDigest
    || candidate.sourceEventRefs.some((sourceRef) =>
      !committedProjections.some((record) => {
        const event = (record.data as SessionKernelProjectionRecordV3).event;
        const data = objectRecord(event.data);
        return event.projectionId === sourceRef
          && event.kind === 'provider.completed'
          && data?.providerTurnId === candidate.providerTurnId
          && data?.outputKind === 'answer';
      })
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_terminal_answer_candidate_source_invalid'
    );
  }
  return {
    ...cloneJson(candidate),
    text,
  };
}

function materializeProviderReservationV3(
  reservation: SessionKernelCompactProviderReservationV3,
  evidence: SessionProviderTurnDurableEvidenceV3,
  state: SessionKernelLoopStateV2,
  records: ReadonlyMap<string, SessionKernelPersistenceRecordV3>
): SessionProviderTurnRecordV2 {
  if (
    reservation.dispatchRef
    && (
      !evidence.dispatch
      || !sameRecordRefV3(reservation.dispatchRef, evidence.dispatch.ref)
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-reservation-dispatch-ref-invalid'
    );
  }
  if (
    reservation.terminalRef
    && (
      !evidence.terminal
      || !sameRecordRefV3(reservation.terminalRef, evidence.terminal.ref)
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-reservation-terminal-ref-invalid'
    );
  }
  if (evidence.dispatch && !evidence.terminal) {
    throw new SessionKernelPersistenceError(
      'session_kernel_provider_dispatch_unresolved',
      'A durable Provider dispatch has no terminal and cannot be retried automatically.'
    );
  }
  if (
    evidence.dispatch
    && evidence.dispatch.data.authorityBinding.planRevision
      !== reservation.planRevision
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-reservation-plan-revision-mismatch'
    );
  }
  const response = evidence.terminal?.data.terminalKind === 'completed'
    ? materializeCompletedProviderResponseV3(
        reservation,
        evidence.terminal,
        state,
        records
      )
    : undefined;
  return {
    providerTurnId: reservation.providerTurnId,
    purpose: reservation.purpose,
    target: cloneJson(reservation.target),
    ...(reservation.planRevision === undefined
      ? {}
      : { planRevision: reservation.planRevision }),
    ...(reservation.correction === undefined
      ? {}
      : { correction: cloneJson(reservation.correction) }),
    controlEpoch: reservation.controlEpoch,
    contextRef: cloneJson(reservation.contextRef),
    factProjection: cloneJson(reservation.factProjection),
    contextAssembly: cloneJson(reservation.contextAssembly),
    startedAt: reservation.startedAt,
    status: reservation.status,
    ...(reservation.cancellationReason
      ? { cancellationReason: reservation.cancellationReason }
      : {}),
    ...(evidence.dispatch
      ? { dispatchRef: cloneJson(evidence.dispatch.ref) }
      : {}),
    ...(evidence.terminal
      ? { terminalRef: cloneJson(evidence.terminal.ref) }
      : {}),
    ...(response ? { response } : {}),
  };
}

function materializeCompletedProviderResponseV3(
  reservation: SessionKernelCompactProviderReservationV3,
  terminal: SessionProviderTurnTerminalRecordV3,
  state: SessionKernelLoopStateV2,
  records: ReadonlyMap<string, SessionKernelPersistenceRecordV3>
): NonNullable<SessionProviderTurnRecordV2['response']> {
  const toolContext = providerToolContextBindingV2(
    toolContextSnapshotByRefV3(
      records,
      state.runId,
      reservation.contextRef
    )
  );
  if (reservation.controlEpoch !== state.controlEpoch) {
    throw new UnsupportedHistorySchemaError(
      'provider-terminal-recovery-epoch-mismatch'
    );
  }
  const input = {
    providerTurnId: reservation.providerTurnId,
    purpose: reservation.purpose,
    runId: state.runId,
    currentInput: currentSessionUserInputV2(state),
    providerProfile: cloneJson(state.providerProfile),
    ...(state.plan?.planRevision === reservation.planRevision
      ? { plan: cloneJson(state.plan) }
      : {}),
    target: cloneJson(reservation.target),
    toolContext,
    kernelFacts: projectSessionProviderFactsV2(
      state,
      reservation.target
    ),
  };
  if (reservation.target.kind === 'planAction' && !input.plan) {
    throw new UnsupportedHistorySchemaError(
      'provider-terminal-recovery-plan-missing'
    );
  }
  const backendOutput = decodeCompletedProviderTerminalV3(
    input,
    terminal,
    state.providerProfile.providerProfileId
  );
  const output = adaptSessionKernelProviderBackendOutputV2(
    input,
    backendOutput,
    terminal.recordedAt
  );
  return {
    items: cloneJson(output.items),
    completion: cloneJson(output.completion),
  };
}

function materializeProviderQueueV3(
  compact: SessionKernelCompactProviderQueueV3,
  evidence: SessionProviderTurnDurableEvidenceV3
): SessionProviderToolCallQueueV2 {
  const terminal = evidence.terminal;
  if (
    terminal?.data.terminalKind !== 'completed'
    || !terminal.data.completion
    || !terminal.data.providerResult
    || !terminal.data.responseDigest
    || !sameRecordRefV3(compact.terminalRef, terminal.ref)
  ) {
    throw new UnsupportedHistorySchemaError(
      'provider-queue-terminal-ref-invalid'
    );
  }
  const orderedItems = materializeTerminalOrderedItemsV3(
    terminal.data.orderedItems,
    compact
  );
  const orderedCalls = orderedItems.filter(
    (item): item is Extract<
      import('./types.js').SessionProviderOrderedItemV2,
      { kind: 'toolCall' }
    > => item.kind === 'toolCall'
  );
  if (orderedCalls.length !== compact.calls.length) {
    throw new UnsupportedHistorySchemaError(
      'provider-queue-call-count-invalid'
    );
  }
  const queue: SessionProviderToolCallQueueV2 = {
    providerTurnId: compact.providerTurnId,
    controlEpoch: terminal.data.authorityBinding.controlEpoch,
    target: cloneJson(compact.target),
    receipt: {
      schemaVersion: 'deepcode.session.provider-tool-call-receipt.v2',
      providerTurnId: compact.providerTurnId,
      responseDigest: terminal.data.responseDigest,
      callCount: compact.calls.length,
      calls: orderedCalls.map((call, index) => ({
        ordinal: index + 1,
        callId: call.callId,
        toolName: call.toolName,
        toolId: call.toolId,
        argumentsDigest: sha256Hash(canonicalJson(call.arguments)),
      })),
      recordedAt: terminal.recordedAt,
    },
    providerResult: cloneJson(terminal.data.providerResult),
    orderedItems,
    completion: cloneJson(terminal.data.completion),
    calls: cloneJson(compact.calls),
    mutationDisposition: compact.mutationDisposition,
    status: compact.status,
    outcomeRecorded: compact.outcomeRecorded,
    ...(compact.settledAt ? { settledAt: compact.settledAt } : {}),
    ...(compact.abortReason ? { abortReason: compact.abortReason } : {}),
  };
  try {
    validateSessionProviderToolCallQueueV2(queue, {
      runId: terminal.data.authorityBinding.runId,
      controlEpoch: terminal.data.authorityBinding.controlEpoch,
    });
  } catch {
    throw new UnsupportedHistorySchemaError(
      'provider-queue-settlement-invalid'
    );
  }
  return queue;
}

function materializeTerminalOrderedItemsV3(
  rawItems: readonly SessionProviderTerminalOrderedItemV3[],
  queue: SessionKernelCompactProviderQueueV3 | undefined
): import('./types.js').SessionProviderOrderedItemV2[] {
  let callIndex = 0;
  return rawItems.map((raw) => {
    if (raw.kind === 'text') return cloneJson(raw);
    const call = queue?.calls[callIndex];
    callIndex += 1;
    if (!call) {
      throw new UnsupportedHistorySchemaError(
        'provider-native-tool-queue-missing'
      );
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(raw.arguments);
    } catch {
      throw new UnsupportedHistorySchemaError(
        'provider-native-tool-arguments-invalid'
      );
    }
    const callArguments = call.intent?.rawArguments
      ?? call.candidatePreview?.rawArguments;
    const callToolId = call.intent?.toolId
      ?? call.candidatePreview?.toolId;
    if (
      !callArguments
      || !callToolId
      || canonicalJson(argumentsValue) !== canonicalJson(callArguments)
    ) {
      throw new UnsupportedHistorySchemaError(
        'provider-native-tool-queue-mismatch'
      );
    }
    return {
      kind: 'toolCall',
      source: 'providerNative',
      ordinal: callIndex,
      callId: raw.callId,
      toolName: raw.name,
      toolId: callToolId,
      arguments: cloneJson(callArguments),
    };
  });
}

function countMatchingFinalAnswerDispatchesV3(
  records: readonly SessionKernelPersistenceRecordV3[],
  runId: string,
  finalAnswer: SessionKernelCompactFinalAnswerV3,
  profile: import('./types.js').SessionProviderProfileBootstrapV2
): number {
  const binding = finalAnswer.binding;
  const matches = records.filter((record) => {
    if (record.recordKind !== 'providerTurnDispatch') return false;
    const dispatch = record.data as SessionProviderTurnDispatchRecordV3['data'];
    const authority = dispatch.authorityBinding;
    return dispatch.purpose === 'finalAnswer'
      && authority.runId === runId
      && authority.inputId === binding.inputId
      && authority.controlEpoch === binding.controlEpoch
      && authority.providerProfileId === profile.providerProfileId
      && authority.providerProfileRevisionDigest
        === profile.providerProfileRevisionDigest;
  });
  if (matches.length > 3) {
    throw new UnsupportedHistorySchemaError(
      'final-answer-dispatch-authority-conflict'
    );
  }
  return matches.length;
}

function restoreProjectionHeadsV3(
  state: SessionKernelLoopStateV2,
  projectionRecords: readonly SessionKernelPersistenceRecordV3[]
): void {
  const inputIds = new Set<string>();
  for (const record of projectionRecords) {
    const event = (record.data as SessionKernelProjectionRecordV3).event;
    const data = objectRecord(event.data);
    if (event.kind === 'input.persisted' && data?.inputId) {
      inputIds.add(requiredIdentity(data.inputId, 'projection.inputId'));
    }
    if (
      event.kind === 'plan.persisted'
      && state.plan
      && data?.planRevision === state.plan.planRevision
    ) {
      state.projectedPlanRevision = state.plan.planRevision;
    }
    if (
      event.kind === 'plan.decided'
      && state.planDecision
      && canonicalJson(event.data) === canonicalJson(state.planDecision)
    ) {
      state.projectedPlanDecisionKey = JSON.stringify([
        state.planDecision.planRevision,
        state.planDecision.decision,
        state.planDecision.guidance ?? '',
      ]);
    }
  }
  state.projectedInputIds = state.inputs
    .map((record) => record.inputId)
    .filter((inputId) => inputIds.has(inputId));
}

function decodePersistedSessionInputV2(
  value: unknown
): SessionUserInputRecordV2 {
  const record = exactObject(
    value,
    [
      'inputId',
      'opaqueInputRef',
      'text',
      'attachments',
      'attachmentContexts',
      'recordedAt',
    ],
    'session_kernel_persisted_input_invalid'
  );
  const text = requiredText(record.text, 'input.text');
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_persisted_input_too_large'
    );
  }
  const opaqueInputRef = requiredIdentity(
    record.opaqueInputRef,
    'opaqueInputRef'
  );
  if (
    new TextEncoder().encode(opaqueInputRef).byteLength > 64 * 1024
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_persisted_input_identity_too_large'
    );
  }
  const recordedAt = requiredText(record.recordedAt, 'recordedAt');
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_persisted_input_time_invalid'
    );
  }
  const attachments = decodeAgentInputAttachmentsV3(record.attachments);
  return {
    inputId: requiredIdentity(record.inputId, 'inputId'),
    opaqueInputRef,
    text,
    attachments,
    attachmentContexts: decodeUserAttachmentContextsV1(
      record.attachmentContexts,
      attachments
    ),
    recordedAt,
  };
}

function decodePersistedPlanIdentityV3(
  value: unknown,
  runId: string,
  recordId: string
): SessionNaturalLanguagePlanV2 {
  const record = objectRecord(value);
  const planRevision = record?.planRevision;
  if (
    !record
    || record.runId !== runId
    || typeof planRevision !== 'string'
    || recordId !== `session-kernel-v3:${runId}:plan:${planRevision}`
  ) {
    throw new UnsupportedHistorySchemaError(
      'session-kernel-plan-identity-invalid'
    );
  }
  return cloneJson(value) as SessionNaturalLanguagePlanV2;
}

function decodePersistedPlanDecisionIdentityV3(
  value: unknown,
  runId: string,
  recordId: string
): SessionPlanDecisionV2 {
  const record = objectRecord(value);
  const planRevision = record?.planRevision;
  if (
    !record
    || typeof planRevision !== 'string'
    || recordId
      !== `session-kernel-v3:${runId}:plan-decision:${planRevision}`
  ) {
    throw new UnsupportedHistorySchemaError(
      'session-kernel-plan-decision-identity-invalid'
    );
  }
  return cloneJson(value) as SessionPlanDecisionV2;
}

function assertNoTransportCapabilities(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertNoTransportCapabilities);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'runCapability' || key === 'decisionCapability') {
      throw new SessionKernelPersistenceError(
        'session_kernel_persistence_secret_forbidden',
        'Transport capabilities cannot enter Session persistence.'
      );
    }
    assertNoTransportCapabilities(nested);
  }
}

function requiredIdentity(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (
    text.trim() !== text
    || /[\u0000-\u001f\u007f-\u009f]/u.test(text)
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_persistence_identity_invalid',
      `${field} is not a valid persistence identity.`
    );
  }
  return text;
}

function requiredText(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || new TextEncoder().encode(value).byteLength > 128 * 1024
  ) {
    throw new SessionKernelPersistenceError(
      'session_kernel_persistence_text_invalid',
      `${field} is missing or exceeds the persistence text limit.`
    );
  }
  return value;
}

function objectRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  errorCode: string
): Record<string, unknown> {
  const record = objectRecord(value);
  const expected = [...keys].sort();
  const actual = record ? Object.keys(record).sort() : [];
  if (
    !record
    || actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new SessionKernelPersistenceError(
      errorCode,
      'Host returned an invalid dedicated v3 persistence response.'
    );
  }
  return record;
}

function exactObjectOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  errorCode: string
): Record<string, unknown> {
  const record = objectRecord(value);
  const permitted = new Set([...requiredKeys, ...optionalKeys]);
  if (
    !record
    || requiredKeys.some((key) =>
      !Object.prototype.hasOwnProperty.call(record, key)
    )
    || Object.keys(record).some((key) => !permitted.has(key))
  ) {
    throw new SessionKernelPersistenceError(
      errorCode,
      'Host returned an invalid dedicated v3 persistence response.'
    );
  }
  return record;
}

function positiveSafeIntegerV3(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new UnsupportedHistorySchemaError(`${field}-invalid`);
  }
  return Number(value);
}

function nonnegativeSafeIntegerV3(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new UnsupportedHistorySchemaError(`${field}-invalid`);
  }
  return Number(value);
}

function normalizeApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidApiBase();
  }
  const authority = value
    .split('://')[1]
    ?.split('/')[0] ?? '';
  const hostname = url.hostname.startsWith('[')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const loopback = hostname === '::1'
    || (
      hostname.split('.').length === 4
      && hostname.split('.').every(
        (part) =>
          /^\d{1,3}$/u.test(part)
          && Number(part) >= 0
          && Number(part) <= 255
      )
      && Number(hostname.split('.')[0]) === 127
    );
  if (
    value.trim() !== value
    || url.protocol !== 'http:'
    || !loopback
    || authority.includes('@')
    || url.username
    || url.password
    || url.search
    || url.hash
    || !['', '/'].includes(url.pathname)
  ) {
    throw invalidApiBase();
  }
  return url.origin;
}

function invalidApiBase(): SessionKernelPersistenceError {
  return new SessionKernelPersistenceError(
    'session_kernel_persistence_api_base_invalid',
    'Session v3 persistence requires an absolute loopback HTTP origin.'
  );
}

async function persistenceHttpError(
  operation: 'read' | 'append',
  response: Response
): Promise<SessionKernelPersistenceError | UnsupportedHistorySchemaError> {
  let hostErrorCode: string | undefined;
  let hostErrorMessage: string | undefined;
  try {
    const body = objectRecord(await response.json());
    const error = objectRecord(body?.error);
    if (error?.code === 'UnsupportedHistorySchema') {
      return new UnsupportedHistorySchemaError(
        'pre-cutover-history'
      );
    }
    if (
      typeof error?.code === 'string'
      && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/u.test(error.code)
    ) {
      hostErrorCode = error.code;
    }
    if (
      typeof error?.message === 'string'
      && error.message.length > 0
      && error.message.length <= 1024
      && error.message.trim() === error.message
    ) {
      hostErrorMessage = error.message;
    }
  } catch {
    // Preserve the typed transport failure when the Host error body is absent
    // or malformed. The status remains sufficient for a bounded diagnostic.
  }
  const baseCode =
    `session_kernel_persistence_http_${operation}_failed`;
  return new SessionKernelPersistenceError(
    hostErrorCode ? `${baseCode}.${hostErrorCode}` : baseCode,
    [
      `Dedicated Session v3 persistence ${operation} failed with HTTP ${response.status}`,
      hostErrorCode ? ` (${hostErrorCode})` : '',
      hostErrorMessage ? `: ${hostErrorMessage}` : '.',
    ].join(''),
    response.status >= 500
      || response.status === 408
      || response.status === 425
      || response.status === 429
      ? 'retrySameRequest'
      : 'doNotRetry'
  );
}

function cloneJson<T>(value: T): T {
  return value === undefined
    ? value
    : JSON.parse(JSON.stringify(value)) as T;
}

export class UnsupportedHistorySchemaError extends Error {
  readonly code = 'UnsupportedHistorySchema';

  constructor(readonly observedSchema: string) {
    super('Session active history schema is unsupported by Kernel–Session v3.');
    this.name = 'UnsupportedHistorySchemaError';
  }
}

export class SessionKernelPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly replayDisposition:
      | 'doNotRetry'
      | 'retrySameRequest' = 'doNotRetry'
  ) {
    super(message);
    this.name = 'SessionKernelPersistenceError';
  }
}

export class SessionKernelPublicRequestPersistenceError extends Error {
  readonly code: string;

  constructor(
    readonly disposition: 'doNotRetry' | 'retrySameRequest',
    readonly persistenceCause: unknown
  ) {
    const code = persistenceCause instanceof SessionKernelPersistenceError
      ? persistenceCause.code
      : persistenceCause instanceof UnsupportedHistorySchemaError
        ? persistenceCause.code
        : 'session_kernel_public_request_persistence_unavailable';
    const message = persistenceCause instanceof Error
      ? persistenceCause.message
      : 'Session Kernel public request persistence failed before Kernel dispatch.';
    super(message);
    this.name = 'SessionKernelPublicRequestPersistenceError';
    this.code = code;
  }
}
