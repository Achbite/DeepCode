import type {
  AgentEvent,
  AgentSessionResult,
  AgentTimelineResult,
  SessionAppendCommandV1,
  SessionAppendPreconditionV1,
  SessionAppendReceiptV1,
  SessionAppendTransitionV1,
  SessionDomainHeadV1,
  SessionDomainStateSnapshotV1,
  SessionFactLineageV1,
  SessionInteractionEffectV1,
  SessionInteractionIdentityV1,
  SessionKernelFactRefV1,
  SessionProjectionCommitAckV1,
  SessionProviderAdmissionMetadataV1,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
  stableHash,
} from '../../cache/canonicalizer.js';
import {
  latestSessionTurnAuthorityEvent,
  sessionTurnAuthorityEventByRef,
} from '../context/userAuthorityFrame.js';
import {
  acknowledgeProviderAdmissions,
  bindPendingProviderProposalAdmission,
  isSessionRunBootstrapFact,
  kernelFactRefFromEvent,
  pendingProviderAdmission,
  pendingProviderAdmissionForProposal,
  prepareSessionFactBatch,
  providerFactLineageForProposal,
  registerPendingProviderAdmission,
  sessionFactLineage,
  sessionFactLineageDisposition,
  sessionRuleFactLineage,
  type PendingProviderAdmissionRegistryState,
  type PreparedSessionFactBatch,
} from './sessionFactLineage.js';
import { TURN_KERNEL_EFFECT_TASK_IDS_STAGING_FIELD } from './finalSettlementEvidence.js';

type WritableAgentSessionResult = AgentSessionResult & {
  appendWriteability: {
    schemaVersion: 'deepcode.session.append-writeability.v1';
    status: 'writable';
    format: 'domainBatchV1';
  };
  domainState: SessionDomainStateSnapshotV1;
  appendReceipt?: SessionAppendReceiptV1;
};

export interface SessionAppendInteractionContext {
  readonly interactionId: string;
  readonly interactionRevision: string;
  readonly targetId: string;
  readonly decisionRequestId: string;
}

export interface SessionRunBootstrapContext {
  readonly token: string;
  readonly admissionId: string;
}

type SessionAppendInteractionKind =
  | 'requirement'
  | 'plan'
  | 'review'
  | 'permission';

interface ExactClaimedSessionInteraction extends SessionAppendInteractionContext {
  readonly kind: SessionAppendInteractionKind;
  readonly claimEventRef: string;
  readonly claimBatchId: string;
}

export interface PreparedCanonicalSessionAppend {
  readonly command: SessionAppendCommandV1;
  readonly preparedFacts: PreparedSessionFactBatch;
  readonly closesRun: boolean;
}

export class SessionAppendCoordinatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'SessionAppendCoordinatorError';
  }
}

/**
 * Owns the process-local half of one canonical Session writer. It never
 * decides Kernel permission or effect semantics: it only binds exact Session
 * facts to an admitted Provider request or deterministic Session rule, then
 * constructs the CAS command against the last acknowledged domain head.
 */
export class SessionAppendCoordinator
  implements PendingProviderAdmissionRegistryState {
  pendingProviderAdmissions?: Record<string, SessionProviderAdmissionMetadataV1>;
  pendingProviderProposalAdmissions?: Record<string, string>;

  private result: WritableAgentSessionResult;

  constructor(
    private readonly sessionId: string,
    private readonly hostRunId: string,
    initialResult: AgentSessionResult,
    private readonly interaction?: SessionAppendInteractionContext,
    private readonly bootstrap?: SessionRunBootstrapContext
  ) {
    this.result = writableSessionResult(initialResult);
    if (this.result.session.id !== sessionId) {
      throw new SessionAppendCoordinatorError(
        'session_append_identity_invalid',
        `Session append coordinator expected ${sessionId}, received ${this.result.session.id}.`
      );
    }
    if (!hostRunId.trim()) {
      throw new SessionAppendCoordinatorError(
        'session_append_run_identity_required',
        'Canonical Session append requires a Host run identity.'
      );
    }
  }

  get currentResult(): WritableAgentSessionResult {
    return this.result;
  }

  get currentState(): SessionDomainStateSnapshotV1 {
    return this.result.domainState;
  }

  registerProviderAdmission(metadata: SessionProviderAdmissionMetadataV1): void {
    registerPendingProviderAdmission(this, metadata);
  }

  bindProviderProposalAdmission(
    proposalId: string,
    providerRequestId: string
  ): void {
    const metadata = pendingProviderAdmission(this, providerRequestId);
    if (!metadata) {
      throw new SessionAppendCoordinatorError(
        'session_provider_admission_unavailable',
        `Provider proposal ${proposalId} cannot bind missing request ${providerRequestId}.`
      );
    }
    bindPendingProviderProposalAdmission(this, proposalId, metadata);
  }

  refresh(result: AgentSessionResult): void {
    const writable = writableSessionResult(result);
    if (writable.session.id !== this.sessionId) {
      throw new SessionAppendCoordinatorError(
        'session_append_identity_invalid',
        `Session append refresh crossed from ${this.sessionId} to ${writable.session.id}.`
      );
    }
    this.result = writable;
  }

  prepareEvents(incomingEvents: readonly AgentEvent[]): PreparedSessionFactBatch {
    const normalizedIncoming = splitAcceptedPermissionFacts(incomingEvents);
    const lineageByEventId = this.buildLineages(normalizedIncoming);
    return prepareSessionFactBatch({
      existingEvents: this.result.events,
      incomingEvents: normalizedIncoming,
      lineageByEventId,
      providerAdmissionRegistry: this,
    });
  }

  buildCommand(
    preparedFacts: PreparedSessionFactBatch,
    timeline: AgentTimelineResult
  ): PreparedCanonicalSessionAppend {
    if (preparedFacts.events.length === 0) {
      throw new SessionAppendCoordinatorError(
        'session_append_transition_invalid',
        'An empty event list is a read, not a Session append command.'
      );
    }
    const runFence = this.currentState.runFences.find(
      (candidate) => candidate.runId === this.hostRunId
    );
    if (!runFence) {
      return this.buildBootstrapCommand(preparedFacts, timeline);
    }

    const terminal = terminalRunState(preparedFacts.events);
    const claimedInteraction = this.claimedInteraction();
    const settlement = claimedInteraction
      ? batchInteractionSettlement(preparedFacts.events, claimedInteraction)
      : { settles: false, hasSettlementFact: false };
    if (
      claimedInteraction
      && settlement.hasSettlementFact
      && !settlement.settles
    ) {
      throw new SessionAppendCoordinatorError(
        'session_append_transition_invalid',
        `Interaction settlement facts do not match claimed interaction ${claimedInteraction.interactionId}.`
      );
    }
    const settlesInteraction = settlement.settles;
    const preconditions: SessionAppendPreconditionV1[] = [
      {
        kind: 'runFence',
        runId: this.hostRunId,
        expected: runFence.state === 'open'
          ? { state: 'open', revision: runFence.revision }
          : {
              state: runFence.state,
              revision: runFence.revision,
              ownerBatchId: runFence.ownerBatchId,
            },
      },
    ];

    let transition: SessionAppendTransitionV1;
    if (terminal) {
      if (terminal.status === 'waiting' && claimedInteraction) {
        throw new SessionAppendCoordinatorError(
          'session_append_transition_invalid',
          settlesInteraction
            ? 'A claimed interaction settlement must be persisted and acknowledged before a later waiting close can open another interaction.'
            : 'A waiting close cannot leave its claimed interaction unresolved while opening another interaction.',
          {
            interactionId: claimedInteraction.interactionId,
            interactionRevision: claimedInteraction.interactionRevision,
            decisionRequestId: claimedInteraction.decisionRequestId,
            claimBatchId: claimedInteraction.claimBatchId,
            settlementInBatch: settlesInteraction,
          }
        );
      }
      const interactionEffect = terminal.status === 'waiting'
        ? pendingInteractionOpenEffect(timeline)
        : claimedInteraction && settlesInteraction
          ? claimedInteractionEffect(claimedInteraction)
          : undefined;
      if (claimedInteraction && settlesInteraction) {
        preconditions.push(claimedInteractionPrecondition(claimedInteraction));
      }
      transition = terminal.status === 'cancelled'
        ? {
            kind: 'close',
            phase: 'terminal',
            runId: this.hostRunId,
            status: 'cancelled',
            parentCloseBatchId: closingOwner(runFence),
            ...(interactionEffect ? { interactionEffect } : {}),
          }
        : {
            kind: 'close',
            phase: 'terminal',
            runId: this.hostRunId,
            status: terminal.status,
            ...(interactionEffect ? { interactionEffect } : {}),
          };
    } else if (claimedInteraction && settlesInteraction) {
      preconditions.push(claimedInteractionPrecondition(claimedInteraction));
      transition = {
        kind: 'append',
        intent: 'interactionSettlement',
        runId: this.hostRunId,
        interactionId: claimedInteraction.interactionId,
        interactionRevision: claimedInteraction.interactionRevision,
        targetId: claimedInteraction.targetId,
        claimBatchId: claimedInteraction.claimBatchId,
      };
    } else {
      const turnAuthorityRef = appendTurnAuthorityRef(
        this.result.events,
        preparedFacts
      );
      if (this.result.events.some(
        (event) =>
          event.id === turnAuthorityRef
          && event.kind === 'session_turn_authority'
      )) {
        preconditions.push({ kind: 'turnAuthority', eventId: turnAuthorityRef });
      }
      transition = {
        kind: 'append',
        intent: 'domainFacts',
        runId: this.hostRunId,
        turnAuthorityRef,
      };
    }

    const batchId = canonicalBatchId({
      sessionId: this.sessionId,
      hostRunId: this.hostRunId,
      baseHead: this.currentState.head,
      transition,
      events: preparedFacts.events,
    });
    return {
      command: {
        schemaVersion: 'deepcode.session.append-command.v1',
        batchId,
        baseHead: this.currentState.head,
        preconditions,
        transition,
        events: preparedFacts.events,
        timeline,
        providerAdmissions: preparedFacts.providerAdmissions,
      },
      preparedFacts,
      closesRun: transition.kind === 'close',
    };
  }

  private buildBootstrapCommand(
    preparedFacts: PreparedSessionFactBatch,
    timeline: AgentTimelineResult
  ): PreparedCanonicalSessionAppend {
    const bootstrap = this.bootstrap;
    if (!bootstrap?.token.trim() || !bootstrap.admissionId.trim()) {
      throw new SessionAppendCoordinatorError(
        'session_append_precondition_failed',
        `Host run fence ${this.hostRunId} is unavailable and no complete bootstrap admission was supplied.`
      );
    }
    if (this.interaction) {
      throw new SessionAppendCoordinatorError(
        'session_append_transition_invalid',
        'Interaction decision runs must use their durable claim fence and cannot bootstrap a second run fence.'
      );
    }
    if (terminalRunState(preparedFacts.events)) {
      throw new SessionAppendCoordinatorError(
        'session_append_transition_invalid',
        'A new run must durably bootstrap its authority before a later terminal close batch.'
      );
    }
    if (preparedFacts.providerAdmissions.length > 0) {
      throw new SessionAppendCoordinatorError(
        'session_append_transition_invalid',
        'Provider admission cannot precede the durable run bootstrap acknowledgement.'
      );
    }

    const turnAuthorityRef = appendTurnAuthorityRef(
      this.result.events,
      preparedFacts
    );
    const incomingAuthority = preparedFacts.events.filter(
      (event) =>
        event.kind === 'session_turn_authority'
        && event.id === turnAuthorityRef
    );
    const existingAuthority = this.result.events.find(
      (event) =>
        event.kind === 'session_turn_authority'
        && event.id === turnAuthorityRef
    );
    if (incomingAuthority.length !== 1 || existingAuthority) {
      throw new SessionAppendCoordinatorError(
        'session_append_transition_invalid',
        'A new-turn bootstrap must introduce exactly one new durable turn authority in its own batch.'
      );
    }
    assertBootstrapAuthoritySources(
      incomingAuthority[0]!,
      preparedFacts.events
    );

    const transition: SessionAppendTransitionV1 = {
      kind: 'append',
      intent: 'bootstrapRun',
      runId: this.hostRunId,
      bootstrapAdmissionId: bootstrap.admissionId,
      turnAuthorityRef,
    };
    const batchId = canonicalBatchId({
      sessionId: this.sessionId,
      hostRunId: this.hostRunId,
      baseHead: this.currentState.head,
      transition,
      events: preparedFacts.events,
    });
    return {
      command: {
        schemaVersion: 'deepcode.session.append-command.v1',
        batchId,
        baseHead: this.currentState.head,
        preconditions: [],
        transition,
        events: preparedFacts.events,
        timeline,
        providerAdmissions: [],
        bootstrapToken: bootstrap.token,
      },
      preparedFacts,
      closesRun: false,
    };
  }

  acknowledge(
    preparation: PreparedCanonicalSessionAppend,
    result: AgentSessionResult
  ): WritableAgentSessionResult {
    const writable = writableSessionResult(result);
    const receipt = writable.appendReceipt;
    const expectedEvents = [
      ...this.result.events,
      ...preparation.command.events,
    ];
    if (!receipt) {
      throw new SessionAppendCoordinatorError(
        'session_append_recovery_required',
        `Session append ${preparation.command.batchId} has no matching canonical receipt.`
      );
    }
    assertCanonicalAppendAcknowledgement({
      sessionId: this.sessionId,
      command: preparation.command,
      receipt,
      result: writable,
      expectedEvents,
    });
    this.refresh(writable);
    acknowledgeProviderAdmissions(
      this,
      preparation.preparedFacts.referencedProviderRequestIds
    );
    if (preparation.closesRun) {
      this.pendingProviderAdmissions = undefined;
      this.pendingProviderProposalAdmissions = undefined;
    }
    return writable;
  }

  private buildLineages(
    incomingEvents: readonly AgentEvent[]
  ): Record<string, SessionFactLineageV1> {
    const lineageByEventId: Record<string, SessionFactLineageV1> = {};
    const combined = [...this.result.events, ...incomingEvents];
    const priorDomainEventByAuthority = new Map<string, AgentEvent>();
    const priorLineageByAuthority = new Map<string, SessionFactLineageV1>();
    for (const event of this.result.events) {
      if (sessionFactLineageDisposition(event) !== 'persistentDomainFact') {
        continue;
      }
      const lineage = sessionFactLineage(event);
      if (!lineage) continue;
      priorDomainEventByAuthority.set(lineage.turnAuthorityRef, event);
      priorLineageByAuthority.set(lineage.turnAuthorityRef, lineage);
    }
    const batchRunId = uniqueBatchRunId(incomingEvents);
    const claimedInteraction = this.claimedInteraction();

    for (let offset = 0; offset < incomingEvents.length; offset += 1) {
      let event = incomingEvents[offset]!;
      const materializesBootstrapFact = (
        !this.currentState.runFences.some(
          (candidate) => candidate.runId === this.hostRunId
        )
        && Boolean(this.bootstrap)
        && isSessionRunBootstrapFact(event)
      );
      if (
        sessionFactLineageDisposition(event) !== 'persistentDomainFact'
        && !materializesBootstrapFact
      ) {
        continue;
      }
      const existing = sessionFactLineage(event);
      if (existing) {
        lineageByEventId[event.id] = existing;
        priorDomainEventByAuthority.set(existing.turnAuthorityRef, event);
        priorLineageByAuthority.set(existing.turnAuthorityRef, existing);
        continue;
      }

      const payload = objectRecord(event.payload) ?? {};
      let proposalId = stringValue(payload.proposalId);
      let providerAdmission = proposalId
        ? pendingProviderAdmissionForProposal(this, proposalId)
        : undefined;
      const authorityRef = providerAdmission?.turnAuthorityRef
        ?? exactAuthorityRefForEvent(
          combined,
          this.result.events.length + offset,
          event,
          batchRunId,
          this.hostRunId
        );
      const priorLineage = priorLineageByAuthority.get(authorityRef);
      if (!proposalId && event.kind === 'session_run_state') {
        proposalId = priorLineage?.producer.kind === 'providerAdmission'
          ? priorLineage.producer.proposalId
          : undefined;
        if (proposalId) {
          event = withPayload(event, { proposalId });
          (incomingEvents as AgentEvent[])[offset] = event;
          providerAdmission = pendingProviderAdmissionForProposal(
            this,
            proposalId
          );
          if (
            providerAdmission
            && providerAdmission.turnAuthorityRef !== authorityRef
          ) {
            throw new SessionAppendCoordinatorError(
              'session_fact_lineage_invalid',
              `Provider proposal ${proposalId} is bound to a different turn authority.`
            );
          }
        }
      }
      event = materializeTurnKernelEffectClaims(
        combined,
        this.result.events.length + offset,
        event,
        authorityRef
      );
      (incomingEvents as AgentEvent[])[offset] = event;
      combined[this.result.events.length + offset] = event;
      const kernelFactRefs = requiredKernelFactRefs(
        combined,
        this.result.events.length + offset,
        event,
        authorityRef
      );
      const priorDomainEvent = priorDomainEventByAuthority.get(authorityRef);
      const domainParentRefs = priorDomainEvent ? [priorDomainEvent.id] : [];
      const lineage = providerAdmission && proposalId
        ? providerFactLineageForProposal({
            state: this,
            proposalId,
            domainParentRefs,
            kernelFactRefs,
          })
        : sessionRuleFactLineage({
            turnAuthorityRef: authorityRef,
            ruleId: sessionRuleId(event),
            sourceEventRefs: sessionRuleSourceRefs(
              event,
              authorityRef,
              claimedInteraction,
              kernelFactRefs.map((ref) => ref.kernelEventRef)
            ),
            domainParentRefs,
            kernelFactRefs,
          });
      lineageByEventId[event.id] = lineage;
      priorDomainEventByAuthority.set(authorityRef, event);
      priorLineageByAuthority.set(authorityRef, lineage);
    }
    return lineageByEventId;
  }

  private claimedInteraction(): ExactClaimedSessionInteraction | undefined {
    if (!this.interaction) return undefined;
    const fence = this.currentState.interactionFences.find(
      (candidate) =>
        candidate.interactionId === this.interaction!.interactionId
        && candidate.interactionRevision === this.interaction!.interactionRevision
        && candidate.targetId === this.interaction!.targetId
        && candidate.state === 'claimed'
    );
    if (!fence || fence.state !== 'claimed') return undefined;
    const claim = latestInteractionClaim(
      this.result.events,
      this.hostRunId,
      this.interaction
    );
    const claimPayload = objectRecord(claim?.payload);
    const kind = sessionAppendInteractionKind(
      stringValue(claimPayload?.decisionKind)
    );
    if (
      !claim
      || !claimPayload
      || !kind
      || stringValue(claimPayload.status) !== 'claimed'
      || !stringValue(fence.claimBatchId)
    ) {
      throw new SessionAppendCoordinatorError(
        'session_append_precondition_failed',
        `Claimed interaction ${fence.interactionId} has no exact persisted claim identity.`
      );
    }
    return {
      kind,
      claimEventRef: claim.id,
      interactionId: fence.interactionId,
      interactionRevision: fence.interactionRevision,
      targetId: fence.targetId,
      decisionRequestId: this.interaction.decisionRequestId,
      claimBatchId: fence.claimBatchId,
    };
  }
}

function writableSessionResult(result: AgentSessionResult): WritableAgentSessionResult {
  if (
    result.appendWriteability.status !== 'writable'
    || result.appendWriteability.format !== 'domainBatchV1'
  ) {
    throw new SessionAppendCoordinatorError(
      'session_append_legacy_read_only',
      'Legacy Session history is read-only and cannot admit a canonical append.'
    );
  }
  return result as WritableAgentSessionResult;
}

function splitAcceptedPermissionFacts(
  incomingEvents: readonly AgentEvent[]
): AgentEvent[] {
  const normalized: AgentEvent[] = [];
  for (const event of incomingEvents) {
    const payload = objectRecord(event.payload);
    const kernelEvent = objectRecord(payload?.kernelEvent);
    const accepted = (
      event.kind === 'permission_request'
      && stringValue(kernelEvent?.kind) === 'permission.requested'
    ) || (
      event.kind === 'permission_result'
      && stringValue(kernelEvent?.kind) === 'permission.resolved'
    );
    if (!accepted || !payload || !kernelEvent) {
      normalized.push(event);
      continue;
    }
    const rawEventId = `${event.id}-kernel-fact`;
    normalized.push({
      id: rawEventId,
      sessionId: event.sessionId,
      ts: event.ts,
      kind: 'workflow_stage',
      payload: {
        stage: kernelEvent.kind,
        status: 'completed',
        summary: `Kernel fact ${kernelEvent.kind}`,
        channel: 'trace',
        visibility: 'hidden',
        presentation: 'traceOnly',
        kernelEvent,
      },
      display: {
        presentation: 'traceOnly',
        importance: 'debug',
      },
    });
    const { kernelEvent: _kernelEvent, ...domainPayload } = payload;
    normalized.push({
      ...event,
      payload: {
        ...domainPayload,
        kernelFactEventRef: rawEventId,
      },
    });
  }
  return normalized;
}

function exactAuthorityRefForEvent(
  events: readonly AgentEvent[],
  eventIndex: number,
  event: AgentEvent,
  batchRunId: string | undefined,
  hostRunId: string
): string {
  const payload = objectRecord(event.payload) ?? {};
  const explicit = stringValue(payload.turnAuthorityRef);
  if (explicit) {
    const authority = sessionTurnAuthorityEventByRef(
      events.slice(0, eventIndex),
      explicit
    );
    if (authority) return explicit;
  }
  const runId = stringValue(payload.runId) ?? batchRunId;
  const authority = latestSessionTurnAuthorityEvent(
    events.slice(0, eventIndex),
    runId
  );
  if (authority) return authority.eventId;
  const claim = latestInteractionClaim(
    events.slice(0, eventIndex),
    hostRunId
  );
  const claimAuthority = stringValue(objectRecord(claim?.payload)?.turnAuthorityRef);
  if (
    claimAuthority
    && sessionTurnAuthorityEventByRef(events.slice(0, eventIndex), claimAuthority)
  ) {
    return claimAuthority;
  }
  throw new SessionAppendCoordinatorError(
    'session_fact_lineage_unavailable',
    `Session fact ${event.id} (${event.kind}) has no exact earlier turn authority.`
  );
}

function materializeTurnKernelEffectClaims(
  events: readonly AgentEvent[],
  eventIndex: number,
  event: AgentEvent,
  authorityRef: string
): AgentEvent {
  const payload = objectRecord(event.payload) ?? {};
  const rawTaskIds = payload[TURN_KERNEL_EFFECT_TASK_IDS_STAGING_FIELD];
  if (rawTaskIds === undefined) return event;
  if (!isTurnExecutionEvidenceStagingTarget(event, payload)) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Session fact ${event.id} uses Kernel effect staging outside a final assistant or waiting review fact.`
    );
  }
  const taskIds = strictIdentityArray(rawTaskIds);
  if (!taskIds) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Turn execution evidence fact ${event.id} has invalid pending Kernel-completed task identities.`
    );
  }
  const authority = sessionTurnAuthorityEventByRef(
    events.slice(0, eventIndex),
    authorityRef
  );
  if (!authority) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_unavailable',
      `Turn execution evidence fact ${event.id} cannot materialize Kernel effect claims without turn authority.`
    );
  }
  if (taskIds.length === 0) {
    const {
      [TURN_KERNEL_EFFECT_TASK_IDS_STAGING_FIELD]: _stagingTaskIds,
      ...persistentPayload
    } = payload;
    return {
      ...event,
      payload: {
        ...persistentPayload,
        requiresKernelFacts: false,
        kernelEffectClaims: [],
      },
    };
  }
  const requestedTasks = new Set(taskIds);
  const workUnitsByTask = new Map<string, string[]>();
  for (const source of events.slice(0, eventIndex)) {
    if (source.kind !== 'workflow_stage') continue;
    const sourcePayload = objectRecord(source.payload);
    const stage = stringValue(sourcePayload?.stage);
    if (
      !sourcePayload
      || (
        stage !== 'accepted_plan.batch_checkpoint'
        && stage !== 'accepted_plan.task_savepoint'
      )
      || stringValue(sourcePayload.runId) !== authority.payload.runId
    ) {
      continue;
    }
    const newlyCompletedTaskIds = strictIdentityArray(
      sourcePayload.newlyCompletedTaskIds
    );
    if (!newlyCompletedTaskIds) {
      throw new SessionAppendCoordinatorError(
        'session_fact_lineage_invalid',
        `Accepted-plan checkpoint ${source.id} has invalid completed-task settlement identities.`
      );
    }
    const relevantTaskIds = newlyCompletedTaskIds.filter((taskId) =>
      requestedTasks.has(taskId)
    );
    if (relevantTaskIds.length === 0) continue;
    const workUnitIds = strictIdentityArray(sourcePayload.workUnitIds);
    if (!workUnitIds) {
      throw new SessionAppendCoordinatorError(
        'session_fact_lineage_invalid',
        `Accepted-plan checkpoint ${source.id} has invalid work-unit settlement identities.`
      );
    }
    if (newlyCompletedTaskIds.length !== 1 || workUnitIds.length === 0) {
      throw new SessionAppendCoordinatorError(
        'session_kernel_effect_claim_unavailable',
        `Accepted-plan checkpoint ${source.id} cannot map one completed task to exact work units.`
      );
    }
    const taskId = newlyCompletedTaskIds[0]!;
    const normalizedWorkUnitIds = [...workUnitIds].sort();
    const prior = workUnitsByTask.get(taskId);
    if (
      prior
      && canonicalJson(prior) !== canonicalJson(normalizedWorkUnitIds)
    ) {
      throw new SessionAppendCoordinatorError(
        'session_kernel_effect_claim_unavailable',
        `Accepted-plan checkpoints disagree on exact work units for task ${taskId}.`
      );
    }
    workUnitsByTask.set(taskId, normalizedWorkUnitIds);
  }
  const missingTaskIds = taskIds.filter((taskId) => !workUnitsByTask.has(taskId));
  if (missingTaskIds.length > 0) {
    throw new SessionAppendCoordinatorError(
      'session_kernel_effect_claim_unavailable',
      `Turn execution evidence fact ${event.id} has no exact checkpoint work-unit mapping for tasks ${missingTaskIds.join(',')}.`
    );
  }
  const {
    [TURN_KERNEL_EFFECT_TASK_IDS_STAGING_FIELD]: _stagingTaskIds,
    ...persistentPayload
  } = payload;
  return {
    ...event,
    payload: {
      ...persistentPayload,
      requiresKernelFacts: taskIds.length > 0,
      kernelEffectClaims: taskIds.map((taskId) => ({
        taskId,
        operationIds: [],
        workUnitIds: workUnitsByTask.get(taskId)!,
      })),
    },
  };
}

function requiredKernelFactRefs(
  events: readonly AgentEvent[],
  eventIndex: number,
  event: AgentEvent,
  authorityRef: string
) {
  const payload = objectRecord(event.payload) ?? {};
  const explicitKernelRef = stringValue(payload.kernelFactEventRef);
  const finalAssistant = isFinalAssistantFact(event, payload);
  const reviewEvidence = isWaitingReviewExecutionEvidenceFact(event, payload);
  const executionEvidenceFact = finalAssistant || reviewEvidence;
  if (
    executionEvidenceFact
    && payload.requiresKernelFacts !== undefined
    && typeof payload.requiresKernelFacts !== 'boolean'
  ) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Turn execution evidence fact ${event.id} requiresKernelFacts must be boolean.`
    );
  }
  const effectClaims = executionEvidenceFact
    ? turnKernelEffectClaims(payload, event.id)
    : [];
  const authority = sessionTurnAuthorityEventByRef(
    events.slice(0, eventIndex),
    authorityRef
  );
  if (!authority) return [];
  const requiresKernelFacts = payload.requiresKernelFacts === true
    || event.kind === 'review_summary';
  if (effectClaims.length > 0 && payload.requiresKernelFacts !== true) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Session fact ${event.id} has Kernel effect claims without requiring Kernel facts.`
    );
  }
  if (
    executionEvidenceFact
    && payload.requiresKernelFacts === true
    && effectClaims.length === 0
  ) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Turn execution evidence fact ${event.id} requires exact per-task Kernel effect claims.`
    );
  }
  if (reviewEvidence && payload.requiresKernelFacts !== true) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Waiting review execution evidence fact ${event.id} must require exact Kernel facts.`
    );
  }
  const candidates = events.slice(0, eventIndex).filter((candidate) => {
    if (explicitKernelRef) return candidate.id === explicitKernelRef;
    if (!requiresKernelFacts) return false;
    const kernelEvent = objectRecord(objectRecord(candidate.payload)?.kernelEvent);
    return stringValue(kernelEvent?.runId) === authority.payload.runId;
  });
  let refs = candidates.flatMap((candidate) => {
    try {
      return [kernelFactRefFromEvent({
        event: candidate,
        boundRunId: authority.payload.runId,
      })];
    } catch {
      return [];
    }
  });
  if (refs.some((ref) => ref.runId !== authority.payload.runId)) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Session fact ${event.id} references a Kernel fact from another run.`
    );
  }
  if (executionEvidenceFact && !requiresKernelFacts && refs.length > 0) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Turn execution evidence fact ${event.id} has unclaimed Kernel facts.`
    );
  }
  if (effectClaims.length > 0) {
    const operationIds = new Set(effectClaims.flatMap((claim) => claim.operationIds));
    const workUnitIds = new Set(effectClaims.flatMap((claim) => claim.workUnitIds));
    refs = refs.filter((ref) => (
      terminalOrEffectKernelFactKind(ref.kind)
      && (
        (ref.operationId && operationIds.has(ref.operationId))
        || (ref.workUnitId && workUnitIds.has(ref.workUnitId))
      )
    ));
    const terminalRefs = refs;
    for (const claim of effectClaims) {
      const missingOperations = claim.operationIds.filter((operationId) =>
        !terminalRefs.some((ref) => ref.operationId === operationId)
      );
      const missingWorkUnits = claim.workUnitIds.filter((workUnitId) =>
        !terminalRefs.some((ref) => ref.workUnitId === workUnitId)
      );
      if (missingOperations.length > 0 || missingWorkUnits.length > 0) {
        throw new SessionAppendCoordinatorError(
          'session_fact_lineage_invalid',
          `Turn execution evidence fact ${event.id} is missing exact Kernel terminal/effect refs for task ${claim.taskId}: operations=${missingOperations.join(',') || 'none'} workUnits=${missingWorkUnits.join(',') || 'none'}.`
        );
      }
    }
  }
  if (
    requiresKernelFacts
    && !refs.some((ref) => terminalOrEffectKernelFactKind(ref.kind))
  ) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Session fact ${event.id} requires Kernel evidence but has no earlier typed Kernel terminal/effect fact.`
    );
  }
  return refs;
}

function isFinalAssistantFact(
  event: AgentEvent,
  payload: Record<string, unknown>
): boolean {
  return event.kind === 'assistant_msg' && stringValue(payload.channel) === 'final';
}

function isWaitingReviewFact(
  event: AgentEvent,
  payload: Record<string, unknown>
): boolean {
  return event.kind === 'review_summary'
    && stringValue(payload.status) === 'waitingUserReview';
}

function isTurnExecutionEvidenceStagingTarget(
  event: AgentEvent,
  payload: Record<string, unknown>
): boolean {
  return isFinalAssistantFact(event, payload)
    || isWaitingReviewFact(event, payload);
}

function isWaitingReviewExecutionEvidenceFact(
  event: AgentEvent,
  payload: Record<string, unknown>
): boolean {
  return isWaitingReviewFact(event, payload)
    && (
      payload.requiresKernelFacts !== undefined
      || payload.kernelEffectClaims !== undefined
      || payload[TURN_KERNEL_EFFECT_TASK_IDS_STAGING_FIELD] !== undefined
    );
}

interface TurnKernelEffectClaimRecord {
  readonly taskId: string;
  readonly operationIds: string[];
  readonly workUnitIds: string[];
}

function turnKernelEffectClaims(
  payload: Record<string, unknown>,
  eventId: string
): TurnKernelEffectClaimRecord[] {
  if (payload.kernelEffectClaims === undefined) return [];
  if (!Array.isArray(payload.kernelEffectClaims)) {
    throw new SessionAppendCoordinatorError(
      'session_fact_lineage_invalid',
      `Turn execution evidence fact ${eventId} kernelEffectClaims must be an array.`
    );
  }
  const taskIds = new Set<string>();
  const claimedOperationIds = new Set<string>();
  const claimedWorkUnitIds = new Set<string>();
  return payload.kernelEffectClaims.map((value, index) => {
    const record = objectRecord(value);
    const taskId = stringValue(record?.taskId);
    const operationIds = strictIdentityArray(record?.operationIds);
    const workUnitIds = strictIdentityArray(record?.workUnitIds);
    if (
      !record
      || !taskId
      || !operationIds
      || !workUnitIds
      || (operationIds.length === 0 && workUnitIds.length === 0)
    ) {
      throw new SessionAppendCoordinatorError(
        'session_fact_lineage_invalid',
        `Turn execution evidence fact ${eventId} has an invalid Kernel effect claim at index ${index}.`
      );
    }
    if (
      taskIds.has(taskId)
      || operationIds.some((operationId) => claimedOperationIds.has(operationId))
      || workUnitIds.some((workUnitId) => claimedWorkUnitIds.has(workUnitId))
    ) {
      throw new SessionAppendCoordinatorError(
        'session_fact_lineage_invalid',
        `Turn execution evidence fact ${eventId} has duplicated Kernel effect claim identities.`
      );
    }
    taskIds.add(taskId);
    operationIds.forEach((operationId) => claimedOperationIds.add(operationId));
    workUnitIds.forEach((workUnitId) => claimedWorkUnitIds.add(workUnitId));
    return { taskId, operationIds, workUnitIds };
  });
}

function strictIdentityArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const identities = value.map(stringValue);
  if (identities.some((identity) => !identity)) return undefined;
  const normalized = identities as string[];
  return new Set(normalized).size === normalized.length
    ? normalized
    : undefined;
}

function terminalOrEffectKernelFactKind(
  kind: SessionKernelFactRefV1['kind']
): boolean {
  return kind === 'tool.effect_observed'
    || kind === 'tool.completed'
    || kind === 'work_unit.completed'
    || kind === 'review.facts_produced'
    || kind === 'review_gate.evaluated'
    || kind === 'run.completed'
    || kind === 'resource.cleanup_state_changed';
}

function sessionRuleSourceRefs(
  event: AgentEvent,
  authorityRef: string,
  claimedInteraction: ExactClaimedSessionInteraction | undefined,
  kernelEventRefs: readonly string[]
): string[] {
  if (
    claimedInteraction
    && interactionSettlementPayloadMatches(event, claimedInteraction)
  ) {
    return [
      ...new Set([
        claimedInteraction.claimEventRef,
        ...kernelEventRefs,
      ]),
    ];
  }
  if (kernelEventRefs.length > 0) return [...kernelEventRefs];
  return [authorityRef];
}

function sessionRuleId(event: AgentEvent): string {
  const payload = objectRecord(event.payload) ?? {};
  const suffix = stringValue(payload.status)
    ?? stringValue(payload.reason)
    ?? stringValue(payload.stage)
    ?? 'record';
  return `session.${event.kind}.${suffix}`;
}

function appendTurnAuthorityRef(
  existingEvents: readonly AgentEvent[],
  prepared: PreparedSessionFactBatch
): string {
  const refs = [...new Set(prepared.turnAuthorityRefs)];
  if (refs.length === 1) return refs[0]!;
  if (refs.length > 1) {
    throw new SessionAppendCoordinatorError(
      'session_append_lineage_invalid',
      `One append batch cannot advance facts under multiple turn authorities: ${refs.join(', ')}.`
    );
  }
  for (const event of [...prepared.events].reverse()) {
    if (event.kind === 'session_turn_authority') return event.id;
  }
  const latest = latestSessionTurnAuthorityEvent(existingEvents);
  if (latest) return latest.eventId;
  throw new SessionAppendCoordinatorError(
    'session_append_lineage_invalid',
    'Domain append has no exact turn authority transition ref.'
  );
}

function assertBootstrapAuthoritySources(
  authority: AgentEvent,
  incomingEvents: readonly AgentEvent[]
): void {
  const payload = objectRecord(authority.payload);
  const sourceMessageIds = Array.isArray(payload?.sourceMessageIds)
    ? payload.sourceMessageIds.filter(
      (value): value is string => typeof value === 'string' && Boolean(value.trim())
    )
    : [];
  if (
    payload?.schemaVersion !== 'deepcode.session.turn-authority.v2'
    || sourceMessageIds.length === 0
    || new Set(sourceMessageIds).size !== sourceMessageIds.length
  ) {
    throw new SessionAppendCoordinatorError(
      'session_append_lineage_invalid',
      `Bootstrap authority ${authority.id} has no exact v2 user-message source set.`
    );
  }
  const authorityIndex = incomingEvents.findIndex(
    (event) => event.id === authority.id
  );
  for (const sourceMessageId of sourceMessageIds) {
    const matches = incomingEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.id === sourceMessageId);
    if (
      matches.length !== 1
      || matches[0]!.index >= authorityIndex
      || matches[0]!.event.kind !== 'user_msg'
    ) {
      throw new SessionAppendCoordinatorError(
        'session_append_lineage_invalid',
        `Bootstrap authority ${authority.id} must bind one earlier user_msg ${sourceMessageId} from the same batch.`
      );
    }
  }
}

function terminalRunState(
  events: readonly AgentEvent[]
): { status: 'completed' | 'failed' | 'cancelled' | 'waiting' } | undefined {
  const terminals: Array<{
    status: 'completed' | 'failed' | 'cancelled' | 'waiting';
  }> = events.flatMap((event) => {
    if (event.kind !== 'session_run_state') return [];
    const status = stringValue(objectRecord(event.payload)?.status);
    if (
      status !== 'completed'
      && status !== 'failed'
      && status !== 'cancelled'
      && status !== 'waiting'
    ) {
      return [];
    }
    return [{ status }];
  });
  if (terminals.length > 1) {
    throw new SessionAppendCoordinatorError(
      'session_append_transition_invalid',
      'One append batch contains more than one terminal Session run state.'
    );
  }
  return terminals[0];
}

function batchInteractionSettlement(
  events: readonly AgentEvent[],
  interaction: ExactClaimedSessionInteraction
): { settles: boolean; hasSettlementFact: boolean } {
  const settlementFacts = events.filter(isInteractionSettlementFact);
  const matchingSettlementFacts = settlementFacts.filter((event) =>
    interactionSettlementEventMatches(event, interaction)
  );
  return {
    settles:
      settlementFacts.length === 1
      && matchingSettlementFacts.length === 1,
    hasSettlementFact: settlementFacts.length > 0,
  };
}

function interactionSettlementEventMatches(
  event: AgentEvent,
  interaction: ExactClaimedSessionInteraction
): boolean {
  if (!interactionSettlementPayloadMatches(event, interaction)) return false;
  const lineage = sessionFactLineage(event);
  return lineage?.producer.kind === 'sessionRule'
    && lineage.producer.sourceEventRefs.includes(interaction.claimEventRef);
}

function interactionSettlementPayloadMatches(
  event: AgentEvent,
  interaction: ExactClaimedSessionInteraction
): boolean {
  const payload = objectRecord(event.payload);
  if (!payload) return false;
  const eventKind = interactionSettlementEventKind(event);
  if (eventKind !== interaction.kind) return false;
  if (
    eventKind !== 'permission'
    && !interactionSettlementStatus(stringValue(payload.status))
  ) {
    return false;
  }
  const targetId = interactionTargetId(eventKind, payload);
  const runId = stringValue(payload.runId);
  const interactionRunId = runId ?? (
    eventKind === 'permission' ? 'session' : undefined
  );
  if (
    !targetId
    || targetId !== interaction.targetId
    || !interactionRunId
  ) {
    return false;
  }
  if (
    interaction.interactionId
      !== `interaction:${eventKind}:${interactionRunId}:${targetId}`
  ) {
    return false;
  }
  const owner = objectRecord(payload.decisionOwner);
  if (
    owner
    && (
      stringValue(owner.kind) !== eventKind
      || stringValue(owner.targetId) !== targetId
      || interactionTargetId(eventKind, owner) !== targetId
    )
  ) {
    return false;
  }
  return true;
}

function isInteractionSettlementFact(event: AgentEvent): boolean {
  const kind = interactionSettlementEventKind(event);
  if (!kind) return false;
  if (kind === 'requirement' || kind === 'permission') return true;
  const payload = objectRecord(event.payload);
  return Boolean(
    payload && interactionSettlementStatus(stringValue(payload.status))
  );
}

function interactionSettlementEventKind(
  event: AgentEvent
): SessionAppendInteractionKind | undefined {
  if (event.kind === 'requirement_decision') return 'requirement';
  if (event.kind === 'plan_review') return 'plan';
  if (event.kind === 'review_summary') return 'review';
  if (event.kind === 'permission_result') return 'permission';
  return undefined;
}

function interactionTargetId(
  kind: SessionAppendInteractionKind,
  payload: Record<string, unknown>
): string | undefined {
  if (kind === 'requirement') return stringValue(payload.requirementId);
  if (kind === 'plan') return stringValue(payload.planId);
  if (kind === 'review') return stringValue(payload.reviewId);
  return stringValue(payload.permissionId);
}

function interactionSettlementStatus(status: string | undefined): boolean {
  return status === 'accepted'
    || status === 'rejected'
    || status === 'needsRevision'
    || status === 'cancelled'
    || status === 'failed'
    || status === 'completed'
    || status === 'superseded'
    || status === 'expired';
}

function sessionAppendInteractionKind(
  value: string | undefined
): SessionAppendInteractionKind | undefined {
  return value === 'requirement'
    || value === 'plan'
    || value === 'review'
    || value === 'permission'
    ? value
    : undefined;
}

function claimedInteractionPrecondition(input: {
  interactionId: string;
  interactionRevision: string;
  targetId: string;
  claimBatchId: string;
}): SessionAppendPreconditionV1 {
  return {
    kind: 'interaction',
    interactionId: input.interactionId,
    interactionRevision: input.interactionRevision,
    targetId: input.targetId,
    expected: {
      state: 'claimed',
      claimBatchId: input.claimBatchId,
    },
  };
}

function claimedInteractionEffect(input: {
  interactionId: string;
  interactionRevision: string;
  targetId: string;
  claimBatchId: string;
}): SessionInteractionEffectV1 {
  return {
    kind: 'settle',
    interactionId: input.interactionId,
    interactionRevision: input.interactionRevision,
    targetId: input.targetId,
    claimBatchId: input.claimBatchId,
  };
}

function pendingInteractionOpenEffect(
  timeline: AgentTimelineResult
): SessionInteractionEffectV1 | undefined {
  const pending = timeline.interactionProjection?.pending;
  if (!pending) return undefined;
  return {
    kind: 'open',
    interactionId: pending.interactionId,
    interactionRevision: pending.interactionRevision,
    targetId: pending.targetId,
  };
}

function closingOwner(
  fence: SessionDomainStateSnapshotV1['runFences'][number]
): string {
  if (fence.state !== 'closing' || !fence.ownerBatchId) {
    throw new SessionAppendCoordinatorError(
      'session_append_transition_invalid',
      `Cancelled terminal close requires a closing run fence for ${fence.runId}.`
    );
  }
  return fence.ownerBatchId;
}

function latestInteractionClaim(
  events: readonly AgentEvent[],
  hostRunId: string,
  interaction?: SessionAppendInteractionContext
): AgentEvent | undefined {
  return [...events].reverse().find((event) => {
    if (String(event.kind) !== 'session_interaction_claim') return false;
    const payload = objectRecord(event.payload) ?? {};
    if (stringValue(payload.admittedRunId) !== hostRunId) return false;
    if (!interaction) return true;
    return stringValue(payload.interactionId) === interaction.interactionId
      && stringValue(payload.interactionRevision) === interaction.interactionRevision
      && stringValue(payload.targetId) === interaction.targetId
      && stringValue(payload.decisionRequestId) === interaction.decisionRequestId;
  });
}

function uniqueBatchRunId(events: readonly AgentEvent[]): string | undefined {
  const runIds = [...new Set(events.flatMap((event) => {
    const runId = stringValue(objectRecord(event.payload)?.runId);
    return runId ? [runId] : [];
  }))];
  return runIds.length === 1 ? runIds[0] : undefined;
}

function canonicalBatchId(value: unknown): string {
  return `session-batch-${stableHash(canonicalJson(value)).slice(0, 32)}`;
}

function withPayload(
  event: AgentEvent,
  additions: Record<string, unknown>
): AgentEvent {
  return {
    ...event,
    payload: {
      ...(objectRecord(event.payload) ?? {}),
      ...additions,
    },
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function sessionAppendReceipt(
  result: AgentSessionResult
): SessionAppendReceiptV1 | undefined {
  return result.appendWriteability.status === 'writable'
    ? result.appendReceipt
    : undefined;
}

function assertCanonicalAppendAcknowledgement(input: {
  sessionId: string;
  command: SessionAppendCommandV1;
  receipt: SessionAppendReceiptV1;
  result: WritableAgentSessionResult;
  expectedEvents: readonly AgentEvent[];
}): void {
  const expectedProjectionAck = projectionCommitAckForCommand(input.command);
  const expectedServerDigest = serverDigestForCommand(
    input.sessionId,
    input.command,
    expectedProjectionAck
  );
  const expectedResultHead = resultHeadForCommand(
    input.command,
    expectedServerDigest
  );
  const mismatches: string[] = [];

  if (input.receipt.schemaVersion !== 'deepcode.session.append-receipt.v1') {
    mismatches.push('receipt.schemaVersion');
  }
  if (input.receipt.sessionId !== input.sessionId) {
    mismatches.push('receipt.sessionId');
  }
  if (input.receipt.batchId !== input.command.batchId) {
    mismatches.push('receipt.batchId');
  }
  if (
    canonicalJson(input.receipt.baseHead)
      !== canonicalJson(input.command.baseHead)
  ) {
    mismatches.push('receipt.baseHead');
  }
  if (input.receipt.serverDigest !== expectedServerDigest) {
    mismatches.push('receipt.serverDigest');
  }
  if (!expectedProjectionAck) {
    if (input.receipt.projectionAck !== undefined) {
      mismatches.push('receipt.projectionAck');
    }
  } else {
    if (
      input.receipt.projectionAck?.schemaVersion
        !== expectedProjectionAck.schemaVersion
    ) {
      mismatches.push('receipt.projectionAck.schemaVersion');
    }
    if (
      input.receipt.projectionAck?.revision
        !== expectedProjectionAck.revision
    ) {
      mismatches.push('receipt.projectionAck.revision');
    }
    if (
      input.receipt.projectionAck?.sourceEventVersion
        !== expectedProjectionAck.sourceEventVersion
    ) {
      mismatches.push('receipt.projectionAck.sourceEventVersion');
    }
    if (
      input.receipt.projectionAck?.projectionDigest
        !== expectedProjectionAck.projectionDigest
    ) {
      mismatches.push('receipt.projectionAck.projectionDigest');
    }
  }
  if (
    canonicalJson(input.receipt.resultState)
      !== canonicalJson(input.result.domainState)
  ) {
    mismatches.push('receipt.resultState');
  }
  if (
    canonicalJson(input.receipt.resultState?.head)
      !== canonicalJson(expectedResultHead)
  ) {
    mismatches.push('receipt.resultState.head');
  }
  if (
    canonicalJson(input.result.events)
      !== canonicalJson(input.expectedEvents)
  ) {
    mismatches.push('result.events');
  }
  if (
    typeof input.receipt.idempotent !== 'boolean'
    || typeof input.receipt.committedAt !== 'string'
    || !input.receipt.committedAt.trim()
  ) {
    mismatches.push('receipt.metadata');
  }

  if (mismatches.length > 0) {
    throw new SessionAppendCoordinatorError(
      'session_append_recovery_required',
      `Session append ${input.command.batchId} returned an acknowledgement that does not match the canonical command: ${mismatches.join(', ')}.`
    );
  }
}

function projectionCommitAckForCommand(
  command: SessionAppendCommandV1
): SessionProjectionCommitAckV1 | undefined {
  const timeline = command.timeline;
  if (!timeline) return undefined;
  if (
    !Number.isSafeInteger(timeline.revision)
    || timeline.revision < 0
  ) {
    throw new SessionAppendCoordinatorError(
      'session_append_recovery_required',
      `Session append ${command.batchId} cannot verify an unsafe projection revision.`
    );
  }
  const sourceEventVersion = checkedDomainCounter(
    command.baseHead.eventVersion,
    command.events.length,
    command.batchId,
    'source event version'
  );
  return {
    schemaVersion: 'deepcode.session.projection-commit-ack.v1',
    revision: timeline.revision,
    sourceEventVersion,
    projectionDigest: sha256Hash(canonicalJson(timeline)),
  };
}

function serverDigestForCommand(
  sessionId: string,
  command: SessionAppendCommandV1,
  projectionAck: SessionProjectionCommitAckV1 | undefined
): string {
  return sha256Hash(canonicalJson({
    schemaVersion: command.schemaVersion,
    sessionId,
    batchId: command.batchId,
    baseHead: command.baseHead,
    preconditions: command.preconditions,
    transition: daemonCanonicalTransitionForDigest(command.transition),
    providerAdmissions: command.providerAdmissions,
    events: command.events,
    projectionDigest: projectionAck?.projectionDigest ?? null,
    projectionRevision: projectionAck?.revision ?? null,
  }));
}

function daemonCanonicalTransitionForDigest(
  transition: SessionAppendTransitionV1
): unknown {
  if (transition.kind !== 'close') return transition;
  // Session domain v1 digests are owned by the Daemon's typed Rust
  // representation. Its close transition serializes an absent optional parent
  // as null even though the strict wire contract omits that field when no
  // cancellation parent exists. Normalize digest material only; do not widen
  // the wire command or invalidate already persisted v1 records.
  return {
    ...transition,
    parentCloseBatchId: 'parentCloseBatchId' in transition
      ? transition.parentCloseBatchId ?? null
      : null,
  };
}

function resultHeadForCommand(
  command: SessionAppendCommandV1,
  serverDigest: string
): SessionDomainHeadV1 {
  const headRevision = checkedDomainCounter(
    command.baseHead.headRevision,
    1,
    command.batchId,
    'head revision'
  );
  const eventVersion = checkedDomainCounter(
    command.baseHead.eventVersion,
    command.events.length,
    command.batchId,
    'event version'
  );
  return {
    schemaVersion: 'deepcode.session.domain-head.v1',
    headRevision,
    eventVersion,
    headDigest: sha256Hash(canonicalJson({
      schemaVersion: 'deepcode.session.domain-head.v1',
      baseHead: command.baseHead,
      batchId: command.batchId,
      batchDigest: serverDigest,
      headRevision,
      eventVersion,
    })),
  };
}

function checkedDomainCounter(
  current: number,
  increment: number,
  batchId: string,
  label: string
): number {
  const next = current + increment;
  if (
    !Number.isSafeInteger(current)
    || current < 0
    || !Number.isSafeInteger(increment)
    || increment < 0
    || !Number.isSafeInteger(next)
  ) {
    throw new SessionAppendCoordinatorError(
      'session_append_recovery_required',
      `Session append ${batchId} cannot verify an unsafe ${label}.`
    );
  }
  return next;
}
