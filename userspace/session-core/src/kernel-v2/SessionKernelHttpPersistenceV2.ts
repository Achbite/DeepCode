import { canonicalJson, sha256Hash } from '../cache/canonicalizer.js';
import type {
  SessionKernelPersistencePortV2,
  SessionKernelProjectionPortV2,
  SessionKernelStoredOperationResultRefV2,
} from './ports.js';
import type { SessionKernelCheckpointV2 } from './state.js';
import type {
  SessionKernelProjectionEventV2,
  SessionKernelPublicRequestRecordV2,
  SessionNaturalLanguagePlanV2,
  SessionPlanDecisionV2,
  SessionUserInputRecordV2,
} from './types.js';
import type {
  SessionKernelTransportPrivateAuthV2,
} from './SessionKernelPortV2.js';
import {
  SESSION_KERNEL_CHECKPOINT_V2_SCHEMA,
} from './types.js';

export const SESSION_KERNEL_PERSISTENCE_V2_SCHEMA =
  'deepcode.session.kernel-persistence.v2' as const;
export const SESSION_KERNEL_PERSISTENCE_RECORD_V2_SCHEMA =
  'deepcode.session.kernel-persistence-record.v2' as const;
export const SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA =
  'deepcode.session.kernel-persistence-append-request.v2' as const;
export const SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA =
  'deepcode.session.kernel-persistence-list-reply.v2' as const;
export const SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA =
  'deepcode.session.kernel-persistence-append-reply.v2' as const;
export const SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA =
  'deepcode.session.kernel-operation-result.v2' as const;

export type SessionKernelPersistenceRecordKindV2 =
  | 'storeHeader'
  | 'input'
  | 'plan'
  | 'planDecision'
  | 'publicRequest'
  | 'publicRequestSettled'
  | 'checkpoint'
  | 'operationResult'
  | 'projection'
  | 'projectionDelivered';

export interface SessionKernelPersistenceRecordV2 {
  schemaVersion: typeof SESSION_KERNEL_PERSISTENCE_RECORD_V2_SCHEMA;
  recordId: string;
  sessionId: string;
  runId: string;
  recordKind: SessionKernelPersistenceRecordKindV2;
  recordedAt: string;
  data: unknown;
  recordDigest: string;
}

/** GET /api/session-store/:sessionId/kernel-v2/:runId response data. */
export interface SessionKernelPersistenceListReplyV2 {
  schemaVersion:
    typeof SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA;
  sessionId: string;
  runId: string;
  records: SessionKernelPersistenceRecordV2[];
}

/** POST /api/session-store/:sessionId/kernel-v2/:runId request body. */
export interface SessionKernelPersistenceAppendRequestV2 {
  schemaVersion:
    typeof SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA;
  sessionId: string;
  runId: string;
  record: SessionKernelPersistenceRecordV2;
}

/** POST /api/session-store/:sessionId/kernel-v2/:runId response data. */
export interface SessionKernelPersistenceAppendReplyV2 {
  schemaVersion:
    typeof SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA;
  sessionId: string;
  runId: string;
  recordId: string;
  recordDigest: string;
  replayed: boolean;
}

export interface SessionKernelAppendOnlyRecordStoreV2 {
  list(): Promise<unknown[]>;
  append(record: SessionKernelPersistenceRecordV2): Promise<void>;
}

/**
 * Strict client for the Host-owned `kernel-v2/<runId>.jsonl` stream.
 * This endpoint must not alias transcript, wire-ledger, or projection files.
 * Host owns atomic append, fsync, file handles, and recordId/digest replay.
 */
export class HttpSessionKernelAppendOnlyRecordStoreV2
implements SessionKernelAppendOnlyRecordStoreV2 {
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
      'kernel-v2',
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
      throw persistenceHttpError('read', response.status);
    }
    const envelope = exactObject(
      await response.json(),
      ['ok', 'data'],
      'session_kernel_persistence_list_response_invalid'
    );
    if (envelope.ok !== true) {
      throw new SessionKernelPersistenceError(
        'session_kernel_persistence_list_rejected',
        'Host rejected the dedicated v2 persistence read.'
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
        'Host returned an invalid dedicated v2 persistence response.'
      );
    }
    return cloneJson(data.records);
  }

  async append(record: SessionKernelPersistenceRecordV2): Promise<void> {
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
      if (response.status === 409) {
        throw new SessionKernelPersistenceError(
          'session_kernel_persistence_identity_conflict',
          `Persistence record ${record.recordId} conflicts with durable content.`
        );
      }
      throw persistenceHttpError('append', response.status);
    }
    const envelope = exactObject(
      await response.json(),
      ['ok', 'data'],
      'session_kernel_persistence_append_response_invalid'
    );
    if (envelope.ok !== true) {
      throw new SessionKernelPersistenceError(
        'session_kernel_persistence_append_rejected',
        'Host rejected the dedicated v2 persistence append.'
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
 * Event-sourced v2 persistence. Every identity is immutable and replay-safe.
 * A non-v2 history fails closed with UnsupportedHistorySchema; no decoder,
 * migration, dual write, or fallback exists here.
 */
export class SessionKernelAppendOnlyPersistenceV2
implements SessionKernelPersistencePortV2 {
  private loadPromise?: Promise<SessionKernelPersistenceRecordV2[]>;
  private records?: SessionKernelPersistenceRecordV2[];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionId: string,
    readonly runId: string,
    historySchema: string,
    private readonly store: SessionKernelAppendOnlyRecordStoreV2
  ) {
    if (historySchema !== SESSION_KERNEL_PERSISTENCE_V2_SCHEMA) {
      throw new UnsupportedHistorySchemaError(historySchema);
    }
    requiredIdentity(sessionId, 'sessionId');
    requiredIdentity(runId, 'runId');
  }

  async loadCheckpoint(
    runId: string
  ): Promise<SessionKernelCheckpointV2 | undefined> {
    this.requireRun(runId);
    const records = await this.loadRecords();
    const checkpoints = records
      .flatMap((record) => {
        if (record.recordKind === 'checkpoint') {
          return [record.data as SessionKernelCheckpointV2];
        }
        if (record.recordKind === 'publicRequestSettled') {
          return [
            decodePublicRequestSettlement(
              record.data,
              this.runId
            ).checkpoint,
          ];
        }
        return [];
      })
      .sort(
        (left, right) =>
          left.checkpointRevision - right.checkpointRevision
      );
    const checkpointByRevision = new Map<number, string>();
    for (const checkpoint of checkpoints) {
      const digest = sha256Hash(canonicalJson(checkpoint));
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
    }
    return cloneJson(checkpoints.at(-1));
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
      'session-kernel-v2',
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
      'session-kernel-v2',
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
    for (const record of await this.loadRecords()) {
      if (record.recordKind === 'publicRequest') {
        const request =
          record.data as SessionKernelPublicRequestRecordV2;
        const previous = pending.get(request.requestId);
        if (
          !previous
          || request.attemptCount >= previous.attemptCount
        ) {
          pending.set(request.requestId, cloneJson(request));
        }
      }
      if (record.recordKind === 'publicRequestSettled') {
        const settlement = decodePublicRequestSettlement(
          record.data,
          this.runId
        );
        const request = pending.get(settlement.requestId);
        if (
          !request
          || publicRequestDigest(request) !== settlement.requestDigest
        ) {
          throw new SessionKernelPersistenceError(
            'session_kernel_public_request_settlement_identity_mismatch',
            `Settlement ${settlement.requestId} does not match a durable request identity and payload.`
          );
        }
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
    );
  }

  settlePublicRequest(
    request: SessionKernelPublicRequestRecordV2,
    outcomeDigest: string,
    checkpoint: SessionKernelCheckpointV2,
    projections: SessionKernelProjectionEventV2[]
  ): Promise<void> {
    return this.append(
      'publicRequestSettled',
      `request:${request.requestId}:settled`,
      {
        requestId: request.requestId,
        requestDigest: publicRequestDigest(request),
        outcomeDigest: requiredDigest(
          outcomeDigest,
          'outcomeDigest'
        ),
        checkpoint: cloneJson(checkpoint),
        projections: projections.map(cloneJson),
      },
      checkpoint.savedAt
    );
  }

  persistCheckpoint(
    checkpoint: SessionKernelCheckpointV2
  ): Promise<void> {
    return this.append(
      'checkpoint',
      `checkpoint:${checkpoint.checkpointRevision}`,
      checkpoint,
      checkpoint.savedAt
    );
  }

  async persistOperationResult(
    operationRequestId: string,
    result: unknown,
    recordedAt: string
  ): Promise<SessionKernelStoredOperationResultRefV2> {
    requiredIdentity(operationRequestId, 'operationRequestId');
    const resultDigest = sha256Hash(canonicalJson(result));
    const recordId = [
      'session-kernel-v2',
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

  persistProjection(
    event: SessionKernelProjectionEventV2
  ): Promise<void> {
    return this.append(
      'projection',
      `projection:${event.projectionId}`,
      event,
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
    for (const record of await this.loadRecords()) {
      if (record.recordKind === 'projection') {
        const event = decodeProjectionEvent(record.data, this.runId);
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
      if (record.recordKind === 'publicRequestSettled') {
        const settlement = decodePublicRequestSettlement(
          record.data,
          this.runId
        );
        for (const event of settlement.projections) {
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
    const projected = new Map<string, SessionKernelProjectionEventV2>();
    for (const record of await this.loadRecords()) {
      const events = record.recordKind === 'projection'
        ? [decodeProjectionEvent(record.data, this.runId)]
        : record.recordKind === 'publicRequestSettled'
          ? decodePublicRequestSettlement(
              record.data,
              this.runId
            ).projections
          : [];
      for (const event of events) {
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
    recordKind: SessionKernelPersistenceRecordKindV2,
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
    recordKind: SessionKernelPersistenceRecordKindV2,
    logicalId: string,
    data: unknown,
    recordedAt: string
  ): Promise<SessionKernelPersistenceRecordV2> {
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
        schemaVersion: SESSION_KERNEL_PERSISTENCE_V2_SCHEMA,
      },
    });
    await this.appendUnique(header);
  }

  private async appendUnique(
    record: SessionKernelPersistenceRecordV2
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
    await this.store.append(record);
    records.push(cloneJson(record));
  }

  private loadRecords(): Promise<SessionKernelPersistenceRecordV2[]> {
    if (this.records) return Promise.resolve(this.records);
    this.loadPromise ??= this.readRecords();
    return this.loadPromise;
  }

  private async readRecords(): Promise<SessionKernelPersistenceRecordV2[]> {
    const rawEntries = await this.store.list();
    const records: SessionKernelPersistenceRecordV2[] = [];
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
    const byId = new Map<string, SessionKernelPersistenceRecordV2>();
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
    projectionHistory: SessionKernelProjectionEventV2[]
  ): Promise<void>;
}

export class DurableSessionKernelProjectionV2
implements SessionKernelProjectionPortV2 {
  constructor(
    private readonly persistence:
      SessionKernelAppendOnlyPersistenceV2,
    private readonly sink?: SessionKernelHostProjectionSinkV2
  ) {}

  async project(event: SessionKernelProjectionEventV2): Promise<void> {
    await this.persistence.persistProjection(event);
    if (this.sink) {
      await this.sink.publish(
        cloneJson(event),
        await this.projectionHistoryThrough(event.projectionId)
      );
      await this.persistence.persistProjectionDelivered(event);
    }
  }

  async flushPending(runId: string): Promise<void> {
    if (!this.sink) return;
    for (
      const event
      of await this.persistence.loadUndeliveredProjections(runId)
    ) {
      await this.sink.publish(
        cloneJson(event),
        await this.projectionHistoryThrough(event.projectionId)
      );
      await this.persistence.persistProjectionDelivered(event);
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
  'input.persisted',
  'scope.previewed',
  'provider.started',
  'provider.completed',
  'provider.stale',
  'toolIntent.submitted',
  'capability.awaiting',
  'kernelFacts.reconciled',
  'authorization.decided',
  'review.revised',
  'planAction.skipped',
  'planAction.completed',
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

interface SessionKernelPublicRequestSettlementV2 {
  requestId: string;
  requestDigest: string;
  outcomeDigest: string;
  checkpoint: SessionKernelCheckpointV2;
  projections: SessionKernelProjectionEventV2[];
}

function decodePublicRequestSettlement(
  value: unknown,
  runId: string
): SessionKernelPublicRequestSettlementV2 {
  const record = exactObject(
    value,
    [
      'requestId',
      'requestDigest',
      'outcomeDigest',
      'checkpoint',
      'projections',
    ],
    'session_kernel_public_request_settlement_invalid'
  );
  const checkpointRecord = exactObject(
    record.checkpoint,
    ['schemaVersion', 'checkpointRevision', 'savedAt', 'state'],
    'session_kernel_public_request_settlement_invalid'
  );
  const state = objectRecord(checkpointRecord.state);
  if (
    checkpointRecord.schemaVersion
      !== SESSION_KERNEL_CHECKPOINT_V2_SCHEMA
    || !Number.isSafeInteger(checkpointRecord.checkpointRevision)
    || (checkpointRecord.checkpointRevision as number) < 1
    || !state
    || state.runId !== runId
    || state.checkpointRevision !== checkpointRecord.checkpointRevision
    || !Array.isArray(record.projections)
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_public_request_settlement_invalid'
    );
  }
  const requestId = requiredIdentity(record.requestId, 'requestId');
  const requestDigest = requiredDigest(
    record.requestDigest,
    'requestDigest'
  );
  const outcomeDigest = requiredDigest(
    record.outcomeDigest,
    'outcomeDigest'
  );
  const checkpoint = cloneJson(
    record.checkpoint
  ) as SessionKernelCheckpointV2;
  const pending = Object.values(
    checkpoint.state.publicRequests ?? {}
  );
  if (
    pending.some(
      (request) => request?.requestId === requestId
    )
  ) {
    throw new UnsupportedHistorySchemaError(
      'session_kernel_public_request_settlement_still_pending'
    );
  }
  return {
    requestId,
    requestDigest,
    outcomeDigest,
    checkpoint,
    projections: record.projections.map(
      (projection) => decodeProjectionEvent(projection, runId)
    ),
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
  recordKind: SessionKernelPersistenceRecordKindV2;
  logicalId: string;
  recordedAt: string;
  data: unknown;
}): SessionKernelPersistenceRecordV2 {
  requiredIdentity(input.logicalId, 'logicalId');
  requiredText(input.recordedAt, 'recordedAt');
  assertNoTransportCapabilities(input.data);
  const withoutDigest = {
    schemaVersion: SESSION_KERNEL_PERSISTENCE_RECORD_V2_SCHEMA,
    recordId: [
      'session-kernel-v2',
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
  return `session-kernel-v2:${runId}:store`;
}

function isValidStoreHeaderData(value: unknown): boolean {
  const record = objectRecord(value);
  return !!record
    && Object.keys(record).length === 1
    && record.schemaVersion === SESSION_KERNEL_PERSISTENCE_V2_SCHEMA;
}

function decodeRecord(
  value: Record<string, unknown>,
  sessionId: string,
  runId: string
): SessionKernelPersistenceRecordV2 {
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
    || value.schemaVersion !== SESSION_KERNEL_PERSISTENCE_RECORD_V2_SCHEMA
    || value.sessionId !== sessionId
    || value.runId !== runId
  ) {
    throw new UnsupportedHistorySchemaError('invalid-v2-record');
  }
  const recordKind = value.recordKind;
  if (
    recordKind !== 'storeHeader'
    && recordKind !== 'input'
    && recordKind !== 'plan'
    && recordKind !== 'planDecision'
    && recordKind !== 'publicRequest'
    && recordKind !== 'publicRequestSettled'
    && recordKind !== 'checkpoint'
    && recordKind !== 'operationResult'
    && recordKind !== 'projection'
    && recordKind !== 'projectionDelivered'
  ) {
    throw new UnsupportedHistorySchemaError('unknown-v2-record-kind');
  }
  const withoutDigest = {
    schemaVersion: SESSION_KERNEL_PERSISTENCE_RECORD_V2_SCHEMA,
    recordId: requiredIdentity(value.recordId, 'recordId'),
    sessionId,
    runId,
    recordKind: recordKind as SessionKernelPersistenceRecordKindV2,
    recordedAt: requiredText(value.recordedAt, 'recordedAt'),
    data: cloneJson(value.data),
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
      'Host returned an invalid dedicated v2 persistence response.'
    );
  }
  return record;
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
    'Session v2 persistence requires an absolute loopback HTTP origin.'
  );
}

function persistenceHttpError(
  operation: 'read' | 'append',
  status: number
): SessionKernelPersistenceError {
  return new SessionKernelPersistenceError(
    `session_kernel_persistence_http_${operation}_failed`,
    `Dedicated Session v2 persistence ${operation} failed with HTTP ${status}.`
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
    super('Session history schema is unsupported by Kernel–Session v2.');
    this.name = 'UnsupportedHistorySchemaError';
  }
}

export class SessionKernelPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelPersistenceError';
  }
}
