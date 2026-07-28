import type {
  AgentEvent,
  ConversationLanguage,
  SessionFactLineageV1,
  SessionFactProducerV1,
  SessionKernelFactKindV1,
  SessionKernelFactRefV1,
  SessionProviderAdmissionMetadataV1,
} from '@deepcode/protocol';
import { canonicalJson, stableHash } from '../../cache/canonicalizer.js';
import {
  sessionTurnAuthorityEventByRef,
  type SessionTurnAuthorityEventRef,
} from '../context/userAuthorityFrame.js';
import { resolveConversationLanguagePolicy } from '../context/conversationLanguagePolicy.js';

export type SessionFactLineageErrorCode =
  | 'session_fact_lineage_invalid'
  | 'session_fact_lineage_unavailable'
  | 'session_fact_lineage_legacy_read_only'
  | 'session_provider_admission_invalid'
  | 'session_provider_admission_unavailable';

export class SessionFactLineageError extends Error {
  constructor(
    readonly code: SessionFactLineageErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SessionFactLineageError';
  }
}

export interface PendingProviderAdmissionRegistryState {
  /**
   * Process-local admission identities waiting for a durable Session fact to
   * reference them. The values intentionally contain no prompt or reasoning.
   */
  pendingProviderAdmissions?: Record<string, SessionProviderAdmissionMetadataV1>;
  /**
   * Exact semantic-admission binding. A proposal id may never be rebound to a
   * later retry or to whichever Provider request happens to be latest.
   */
  pendingProviderProposalAdmissions?: Record<string, string>;
}

export type SessionFactLineageDisposition =
  | 'authority'
  | 'persistentDomainFact'
  | 'auxiliaryLedger'
  | 'transientPresentation'
  | 'rawKernelProjection'
  | 'nonDomainEvent';

export interface ProviderFactLineageInput {
  readonly admission: SessionProviderAdmissionMetadataV1;
  readonly proposalId: string;
  readonly domainParentRefs?: readonly string[];
  readonly kernelFactRefs?: readonly SessionKernelFactRefV1[];
}

export interface ProviderProposalFactLineageInput {
  readonly state: PendingProviderAdmissionRegistryState;
  readonly proposalId: string;
  readonly domainParentRefs?: readonly string[];
  readonly kernelFactRefs?: readonly SessionKernelFactRefV1[];
}

export interface SessionRuleFactLineageInput {
  readonly turnAuthorityRef: string;
  readonly ruleId: string;
  readonly sourceEventRefs: readonly string[];
  readonly domainParentRefs?: readonly string[];
  readonly kernelFactRefs?: readonly SessionKernelFactRefV1[];
}

export interface KernelFactRefFromEventInput {
  readonly event: AgentEvent;
  /**
   * Some older Kernel ABI facts omit runId (for example a tool completion
   * keyed only by tool call). The Session run may be supplied only when it is
   * already bound by the surrounding Kernel command/reply contract.
   */
  readonly boundRunId?: string;
}

export interface ValidateSessionFactLineageInput {
  readonly event: AgentEvent;
  readonly eventIndex: number;
  readonly events: readonly AgentEvent[];
  readonly providerAdmissions?: readonly SessionProviderAdmissionMetadataV1[];
  readonly providerProposalBindings?: Readonly<Record<string, string>>;
}

export interface PrepareSessionFactBatchInput {
  readonly existingEvents: readonly AgentEvent[];
  readonly incomingEvents: readonly AgentEvent[];
  /**
   * Explicit lineage material chosen by the Session semantic/rule producer.
   * The preparer never guesses a producer from a request id.
   */
  readonly lineageByEventId?: Readonly<Record<string, SessionFactLineageV1>>;
  readonly providerAdmissionRegistry?: PendingProviderAdmissionRegistryState;
}

export interface PreparedSessionFactBatch {
  readonly events: AgentEvent[];
  /**
   * Records owned by an independent observability ledger. They may feed a
   * read model, but must never advance the canonical Session domain head.
   */
  readonly auxiliaryEvents: AgentEvent[];
  readonly providerAdmissions: SessionProviderAdmissionMetadataV1[];
  readonly referencedProviderRequestIds: string[];
  readonly turnAuthorityRefs: string[];
}

export function providerFactLineage(
  input: ProviderFactLineageInput
): SessionFactLineageV1 {
  const admission = parseProviderAdmissionMetadata(input.admission);
  if (!admission) {
    throw new SessionFactLineageError(
      'session_provider_admission_invalid',
      'Provider fact lineage requires canonical admitted-request metadata.'
    );
  }
  const producer: SessionFactProducerV1 = {
    kind: 'providerAdmission',
    providerRequestId: requiredRef(
      admission.requestId,
      'Provider fact lineage requires an admitted Provider request id.'
    ),
    proposalId: requiredRef(
      input.proposalId,
      'Provider fact lineage requires an exact admitted proposal id.'
    ),
  };
  return freezeLineage({
    schemaVersion: 'deepcode.session.fact-lineage.v1',
    turnAuthorityRef: requiredRef(
      admission.turnAuthorityRef,
      'Provider fact lineage requires an exact turn authority ref.'
    ),
    producer,
    domainParentRefs: normalizedRefs(input.domainParentRefs),
    kernelFactRefs: normalizedKernelFactRefs(input.kernelFactRefs),
  });
}

export function providerFactLineageForProposal(
  input: ProviderProposalFactLineageInput
): SessionFactLineageV1 {
  const proposalId = requiredRef(
    input.proposalId,
    'Provider fact lineage requires an admitted proposal id.'
  );
  const admission = pendingProviderAdmissionForProposal(input.state, proposalId);
  if (!admission) {
    throw new SessionFactLineageError(
      'session_provider_admission_unavailable',
      `Provider proposal ${proposalId} has no exact semantic-admission binding.`
    );
  }
  return providerFactLineage({
    admission,
    proposalId,
    domainParentRefs: input.domainParentRefs,
    kernelFactRefs: input.kernelFactRefs,
  });
}

export function sessionRuleFactLineage(
  input: SessionRuleFactLineageInput
): SessionFactLineageV1 {
  const sourceEventRefs = normalizedRefs(input.sourceEventRefs);
  if (sourceEventRefs.length === 0) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Session rule ${input.ruleId || 'unknown'} requires at least one immutable source event ref.`
    );
  }
  return freezeLineage({
    schemaVersion: 'deepcode.session.fact-lineage.v1',
    turnAuthorityRef: requiredRef(
      input.turnAuthorityRef,
      'Session rule lineage requires an exact turn authority ref.'
    ),
    producer: {
      kind: 'sessionRule',
      ruleId: requiredRef(
        input.ruleId,
        'Session rule lineage requires a stable rule id.'
      ),
      sourceEventRefs,
    },
    domainParentRefs: normalizedRefs(input.domainParentRefs),
    kernelFactRefs: normalizedKernelFactRefs(input.kernelFactRefs),
  });
}

export function kernelFactRefFromEvent(
  input: KernelFactRefFromEventInput
): SessionKernelFactRefV1 {
  const payload = objectRecord(input.event.payload);
  const kernelEvent = objectRecord(payload?.kernelEvent);
  const kind = kernelFactKind(kernelEvent?.kind);
  const runId = stringValue(kernelEvent?.runId) ?? optionalRef(input.boundRunId);
  if (!kernelEvent || !kind || !runId) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Agent event ${input.event.id} is not a supported typed Kernel fact with a bound run.`
    );
  }
  const fact = objectRecord(kernelEvent.fact)
    ?? objectRecord(kernelEvent.result)
    ?? objectRecord(kernelEvent.output);
  const projectionWorkUnit = objectRecord(kernelEvent.projectionWorkUnit);
  const kernelContext = objectRecord(fact?.kernelContext);
  const ref: SessionKernelFactRefV1 = {
    schemaVersion: 'deepcode.session.kernel-fact-ref.v1',
    kernelEventRef: requiredRef(
      input.event.id,
      'Typed Kernel fact requires the immutable projected event id.'
    ),
    kind,
    runId,
    factId: stringValue(kernelEvent.factId)
      ?? stringValue(fact?.id)
      ?? stringValue(fact?.factId),
    planActionId: stringValue(kernelEvent.planActionId)
      ?? stringValue(fact?.planActionId)
      ?? stringValue(projectionWorkUnit?.actionId)
      ?? stringValue(fact?.actionId),
    capabilityGrantId: stringValue(kernelEvent.capabilityGrantId)
      ?? stringValue(fact?.capabilityGrantId),
    authorizationContractId: stringValue(kernelEvent.authorizationContractId)
      ?? stringValue(fact?.authorizationContractId)
      ?? stringValue(fact?.contractId),
    operationId: stringValue(kernelEvent.operationId)
      ?? stringValue(fact?.operationId)
      ?? stringValue(projectionWorkUnit?.operationId),
    workUnitId: stringValue(kernelEvent.workUnitId)
      ?? stringValue(fact?.workUnitId)
      ?? stringValue(kernelContext?.workUnitId),
  };
  const parsed = parseKernelFactRef(ref);
  if (!parsed) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Agent event ${input.event.id} could not produce a typed Kernel fact ref.`
    );
  }
  return parsed;
}

export function withSessionFactLineage(
  event: AgentEvent,
  lineage: SessionFactLineageV1
): AgentEvent {
  if (
    sessionFactLineageDisposition(event) !== 'persistentDomainFact'
    && !isSessionRunBootstrapFact(event)
  ) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Agent event ${event.id} (${event.kind}) is not an eligible persistent Session domain fact.`
    );
  }
  const payload = objectRecord(event.payload);
  if (!payload) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Session domain event ${event.id} must use an object payload before lineage can be attached.`
    );
  }
  const existing = parseSessionFactLineage(payload.lineage);
  if (payload.lineage !== undefined && !existing) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Session domain event ${event.id} contains malformed lineage.`
    );
  }
  if (existing && canonicalJson(existing) !== canonicalJson(lineage)) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Session domain event ${event.id} lineage is immutable and cannot be replaced.`
    );
  }
  return {
    ...event,
    payload: {
      ...payload,
      lineage: cloneLineage(lineage),
    },
  };
}

/**
 * Prepare the logical event portion of a domain append. Existing legacy facts
 * make the Session read-only; new persistent facts must carry explicit
 * lineage. Provider metadata is selected only from the in-memory registry
 * populated by the canonical request admission path.
 */
export function prepareSessionFactBatch(
  input: PrepareSessionFactBatchInput
): PreparedSessionFactBatch {
  assertNoLegacySessionDomainFacts(input.existingEvents);
  const lineageByEventId = input.lineageByEventId ?? {};
  const existingIds = new Set(input.existingEvents.map((event) => event.id));
  const incomingIds = new Set<string>();
  const auxiliaryEvents = input.incomingEvents
    .filter((event) => sessionFactLineageDisposition(event) === 'auxiliaryLedger')
    .map(cloneEvent);
  const domainIncomingEvents = input.incomingEvents.filter(
    (event) => sessionFactLineageDisposition(event) !== 'auxiliaryLedger'
  );
  const events = domainIncomingEvents.map((event) => {
    if (
      !event.id.trim()
      || existingIds.has(event.id)
      || incomingIds.has(event.id)
    ) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Incoming Session fact batch contains an empty or reused event id ${event.id || '<empty>'}.`
      );
    }
    incomingIds.add(event.id);
    const explicit = lineageByEventId[event.id];
    const payload = objectRecord(event.payload);
    const payloadLineage = parseSessionFactLineage(payload?.lineage);
    if (payload?.lineage !== undefined && !payloadLineage) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Incoming Session domain event ${event.id} contains malformed lineage.`
      );
    }
    if (
      explicit
      && payloadLineage
      && canonicalJson(explicit) !== canonicalJson(payloadLineage)
    ) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Incoming Session domain event ${event.id} has conflicting lineage sources.`
      );
    }
    const lineage = explicit ?? payloadLineage;
    const disposition = isSessionRunBootstrapFact(event) && Boolean(lineage)
      ? 'persistentDomainFact'
      : sessionFactLineageDisposition(event);
    if (disposition === 'persistentDomainFact') {
      if (!lineage) {
        throw new SessionFactLineageError(
          'session_fact_lineage_unavailable',
          `New Session domain event ${event.id} (${event.kind}) has no SessionFactLineage v1.`
        );
      }
      return withSessionFactLineage(event, lineage);
    }
    if (explicit || payloadLineage) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Non-domain event ${event.id} (${event.kind}, ${disposition}) must not carry SessionFactLineage.`
      );
    }
    return cloneEvent(event);
  });
  for (const eventId of Object.keys(lineageByEventId)) {
    if (!incomingIds.has(eventId)) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Lineage was supplied for non-member event ${eventId}.`
      );
    }
  }

  const combined = [...input.existingEvents, ...events];
  const registry = input.providerAdmissionRegistry?.pendingProviderAdmissions ?? {};
  const providerAdmissionsById = new Map<string, SessionProviderAdmissionMetadataV1>();
  const turnAuthorityRefs = new Set<string>();
  const referencedProviderRequestIds = new Set<string>();
  const resolvingProviderAdmissions = new Set<string>();
  const includePendingProviderAdmission = (
    requestId: string,
    eventId: string,
    required: boolean
  ): void => {
    if (providerAdmissionsById.has(requestId)) return;
    if (resolvingProviderAdmissions.has(requestId)) {
      throw new SessionFactLineageError(
        'session_provider_admission_invalid',
        `Provider admission ancestry for ${requestId} contains a cycle.`
      );
    }
    const metadata = registry[requestId];
    if (!metadata) {
      if (!required) return;
      throw new SessionFactLineageError(
        'session_provider_admission_unavailable',
        `Session fact ${eventId} references Provider request ${requestId}, but no canonical admission metadata is pending.`
      );
    }
    resolvingProviderAdmissions.add(requestId);
    try {
      if (metadata.parentRequestId) {
        includePendingProviderAdmission(metadata.parentRequestId, eventId, false);
      }
      providerAdmissionsById.set(requestId, cloneProviderAdmission(metadata));
      referencedProviderRequestIds.add(requestId);
    } finally {
      resolvingProviderAdmissions.delete(requestId);
    }
  };
  for (let offset = 0; offset < events.length; offset += 1) {
    const event = events[offset]!;
    if (sessionFactLineageDisposition(event) !== 'persistentDomainFact') continue;
    const lineage = sessionFactLineage(event);
    if (!lineage) {
      throw new SessionFactLineageError(
        'session_fact_lineage_unavailable',
        `Prepared Session domain event ${event.id} lost its lineage.`
      );
    }
    turnAuthorityRefs.add(lineage.turnAuthorityRef);
    if (lineage.producer.kind === 'providerAdmission') {
      const requestId = lineage.producer.providerRequestId;
      includePendingProviderAdmission(requestId, event.id, true);
    }
    validateSessionFactLineage({
      event,
      eventIndex: input.existingEvents.length + offset,
      events: combined,
      providerAdmissions: [...providerAdmissionsById.values()],
      providerProposalBindings:
        input.providerAdmissionRegistry?.pendingProviderProposalAdmissions,
    });
  }

  return Object.freeze({
    events,
    auxiliaryEvents,
    providerAdmissions: [...providerAdmissionsById.values()],
    referencedProviderRequestIds: [...referencedProviderRequestIds],
    turnAuthorityRefs: [...turnAuthorityRefs],
  });
}

export function validateSessionFactLineage(
  input: ValidateSessionFactLineageInput
): SessionTurnAuthorityEventRef {
  const disposition = sessionFactLineageDisposition(input.event);
  const lineage = sessionFactLineage(input.event);
  if (disposition !== 'persistentDomainFact') {
    if (lineage) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Event ${input.event.id} (${disposition}) must not carry SessionFactLineage.`
      );
    }
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Event ${input.event.id} is not a persistent Session domain fact.`
    );
  }
  if (!lineage) {
    throw new SessionFactLineageError(
      'session_fact_lineage_unavailable',
      `Persistent Session domain event ${input.event.id} has no valid SessionFactLineage v1.`
    );
  }
  if (input.eventIndex < 0 || input.eventIndex >= input.events.length) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Session domain event ${input.event.id} has an invalid batch position.`
    );
  }
  const authority = sessionTurnAuthorityEventByRef(
    input.events,
    lineage.turnAuthorityRef
  );
  if (!authority || authority.eventIndex >= input.eventIndex) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Session domain event ${input.event.id} must reference a valid earlier session_turn_authority event.`
    );
  }
  validateTurnAuthoritySourceMessages(input.events, authority);
  const languagePolicy = resolveConversationLanguagePolicy(
    input.events.slice(0, input.eventIndex),
    authority.payload
  );
  validateConsumerAuthorityIdentity(input.event, authority, languagePolicy);
  validateLineageProducer(input, lineage, authority);
  validateExactAuthorityDomainParent(
    input.events,
    input.eventIndex,
    input.event,
    lineage
  );
  if (lineage.producer.kind === 'sessionRule') {
    validateEarlierRefs(
      input.events,
      input.eventIndex,
      lineage.producer.sourceEventRefs,
      'Session rule source'
    );
  }
  validateKernelFactRefs(
    lineage.kernelFactRefs,
    authority,
    input.events,
    input.eventIndex
  );
  return authority;
}

export function parseSessionFactLineage(
  value: unknown
): SessionFactLineageV1 | undefined {
  const record = objectRecord(value);
  if (record?.schemaVersion !== 'deepcode.session.fact-lineage.v1') return undefined;
  const turnAuthorityRef = stringValue(record.turnAuthorityRef);
  const producer = parseSessionFactProducer(record.producer);
  const domainParentRefs = strictStringArray(record.domainParentRefs);
  const kernelFactRefs = strictKernelFactRefs(record.kernelFactRefs);
  if (
    !turnAuthorityRef
    || !producer
    || !domainParentRefs
    || !kernelFactRefs
    || hasDuplicates(domainParentRefs)
  ) {
    return undefined;
  }
  return freezeLineage({
    schemaVersion: 'deepcode.session.fact-lineage.v1',
    turnAuthorityRef,
    producer,
    domainParentRefs,
    kernelFactRefs,
  });
}

export function sessionFactLineage(
  event: AgentEvent
): SessionFactLineageV1 | undefined {
  return parseSessionFactLineage(objectRecord(event.payload)?.lineage);
}

export function sessionFactLineageDisposition(
  event: AgentEvent
): SessionFactLineageDisposition {
  const payload = objectRecord(event.payload);
  if (event.kind === 'session_turn_authority') return 'authority';
  if (event.kind === 'cache_telemetry') return 'auxiliaryLedger';
  if (event.kind === 'session_goal_fact') return 'persistentDomainFact';
  if (event.kind === 'permission_request' || event.kind === 'permission_result') {
    const kernelEvent = objectRecord(payload?.kernelEvent);
    if (!kernelEvent || acceptedPermissionKernelKind(event.kind, kernelEvent.kind)) {
      return 'persistentDomainFact';
    }
    return 'rawKernelProjection';
  }
  if (payload?.kernelEvent !== undefined) return 'rawKernelProjection';
  // Terminal run state is a durable Session settlement fact even though its
  // presentation remains debug-only. The initial running state becomes
  // durable only after the bootstrap coordinator supplies explicit lineage,
  // preserving the transient meaning of older unlineaged progress events.
  if (
    event.kind === 'session_run_state'
    && (
      isTerminalSessionRunStatus(payload?.status)
      || (
        isSessionRunBootstrapFact(event)
        && sessionFactLineage(event) !== undefined
      )
    )
  ) {
    return 'persistentDomainFact';
  }
  if (
    event.kind === 'workflow_stage'
    || event.kind === 'tool_call'
    || event.kind === 'tool_result'
    || stringValue(payload?.channel) === 'reasoning'
    || (
      stringValue(payload?.channel) === 'progress'
      && event.kind !== 'requirement_decision'
      && event.kind !== 'plan_review'
      && event.kind !== 'review_summary'
    )
    || payload?.visibility === 'hidden'
    || event.display?.presentation === 'traceOnly'
  ) {
    return 'transientPresentation';
  }
  if (
    event.kind === 'requirement_confirmation'
    || event.kind === 'requirement_decision'
    || event.kind === 'plan_card'
    || event.kind === 'plan_review'
    || event.kind === 'review_summary'
    || event.kind === 'error'
    || (
      event.kind === 'assistant_msg'
      && stringValue(payload?.channel) === 'final'
    )
  ) {
    return 'persistentDomainFact';
  }
  return 'nonDomainEvent';
}

export function isSessionRunBootstrapFact(event: AgentEvent): boolean {
  if (event.kind !== 'session_run_state') return false;
  const payload = objectRecord(event.payload);
  const decisionOwner = objectRecord(payload?.decisionOwner);
  const runId = stringValue(payload?.runId);
  return payload?.status === 'running'
    && payload?.phase === 'context_reading'
    && payload?.reason === 'session'
    && payload?.decisionKind === 'session'
    && decisionOwner?.kind === 'session'
    && Boolean(runId)
    && stringValue(decisionOwner?.runId) === runId;
}

export function assertNoLegacySessionDomainFacts(
  events: readonly AgentEvent[]
): void {
  for (const event of events) {
    if (sessionFactLineageDisposition(event) !== 'persistentDomainFact') continue;
    const rawLineage = objectRecord(event.payload)?.lineage;
    const lineage = parseSessionFactLineage(rawLineage);
    if (rawLineage !== undefined && !lineage) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Session domain event ${event.id} (${event.kind}) contains malformed lineage.`
      );
    }
    if (!lineage) {
      throw new SessionFactLineageError(
        'session_fact_lineage_legacy_read_only',
        `Session contains legacy domain event ${event.id} (${event.kind}) without SessionFactLineage v1 and is read-only.`
      );
    }
  }
}

export function registerPendingProviderAdmission(
  state: PendingProviderAdmissionRegistryState,
  metadata: SessionProviderAdmissionMetadataV1
): void {
  const normalized = parseProviderAdmissionMetadata(metadata);
  if (!normalized) {
    throw new SessionFactLineageError(
      'session_provider_admission_invalid',
      `Provider request ${metadata.requestId || 'unknown'} produced invalid admission metadata.`
    );
  }
  const registry = state.pendingProviderAdmissions ?? {};
  const existing = registry[normalized.requestId];
  if (existing) {
    throw new SessionFactLineageError(
      'session_provider_admission_invalid',
      `Provider request ${normalized.requestId} admission identity was reused for more than one physical admission.`
    );
  }
  registry[normalized.requestId] = cloneProviderAdmission(normalized);
  state.pendingProviderAdmissions = registry;
}

export function bindPendingProviderProposalAdmission(
  state: PendingProviderAdmissionRegistryState,
  proposalId: string,
  metadata: SessionProviderAdmissionMetadataV1
): void {
  const normalizedProposalId = requiredRef(
    proposalId,
    'Provider semantic admission requires a proposal id.'
  );
  const normalized = parseProviderAdmissionMetadata(metadata);
  if (!normalized) {
    throw new SessionFactLineageError(
      'session_provider_admission_invalid',
      `Provider proposal ${normalizedProposalId} has malformed admission metadata.`
    );
  }
  const registered = state.pendingProviderAdmissions?.[normalized.requestId];
  if (!registered || canonicalJson(registered) !== canonicalJson(normalized)) {
    throw new SessionFactLineageError(
      'session_provider_admission_unavailable',
      `Provider proposal ${normalizedProposalId} cannot bind request ${normalized.requestId} before canonical request admission.`
    );
  }
  const bindings = state.pendingProviderProposalAdmissions ?? {};
  const existingRequestId = bindings[normalizedProposalId];
  if (existingRequestId && existingRequestId !== normalized.requestId) {
    throw new SessionFactLineageError(
      'session_provider_admission_invalid',
      `Provider proposal ${normalizedProposalId} is already bound to request ${existingRequestId} and cannot be rebound to ${normalized.requestId}.`
    );
  }
  bindings[normalizedProposalId] = normalized.requestId;
  state.pendingProviderProposalAdmissions = bindings;
}

/**
 * Remove metadata only after the append receipt has durably acknowledged the
 * exact batch. Preparing or attempting a batch never consumes the registry.
 */
export function acknowledgeProviderAdmissions(
  state: PendingProviderAdmissionRegistryState,
  requestIds: readonly string[]
): void {
  const registry = state.pendingProviderAdmissions;
  if (!registry) return;
  const consumed = new Set(normalizedRefs(requestIds));
  for (const requestId of consumed) delete registry[requestId];
  const bindings = state.pendingProviderProposalAdmissions;
  if (bindings) {
    for (const [proposalId, requestId] of Object.entries(bindings)) {
      if (consumed.has(requestId)) delete bindings[proposalId];
    }
    if (Object.keys(bindings).length === 0) {
      state.pendingProviderProposalAdmissions = undefined;
    }
  }
  if (Object.keys(registry).length === 0) state.pendingProviderAdmissions = undefined;
}

export function pendingProviderAdmission(
  state: PendingProviderAdmissionRegistryState,
  requestId: string
): SessionProviderAdmissionMetadataV1 | undefined {
  const metadata = state.pendingProviderAdmissions?.[requestId.trim()];
  return metadata ? cloneProviderAdmission(metadata) : undefined;
}

export function pendingProviderAdmissionForProposal(
  state: PendingProviderAdmissionRegistryState,
  proposalId: string
): SessionProviderAdmissionMetadataV1 | undefined {
  const requestId = state.pendingProviderProposalAdmissions?.[proposalId.trim()];
  return requestId ? pendingProviderAdmission(state, requestId) : undefined;
}

function validateLineageProducer(
  input: ValidateSessionFactLineageInput,
  lineage: SessionFactLineageV1,
  authority: SessionTurnAuthorityEventRef
): void {
  const payload = objectRecord(input.event.payload) ?? {};
  if (lineage.producer.kind === 'providerAdmission') {
    const producer = lineage.producer;
    const admission = input.providerAdmissions?.find(
      (candidate) => candidate.requestId === producer.providerRequestId
    );
    if (!admission) {
      throw new SessionFactLineageError(
        'session_provider_admission_unavailable',
        `Session fact ${input.event.id} has no matching Provider admission metadata.`
      );
    }
    const normalized = parseProviderAdmissionMetadata(admission);
    if (
      !normalized
      || normalized.turnAuthorityRef !== lineage.turnAuthorityRef
      || normalized.languageRevision !== authority.payload.languagePolicy.revision
    ) {
      throw new SessionFactLineageError(
        'session_provider_admission_invalid',
        `Session fact ${input.event.id} Provider admission does not match its turn authority.`
      );
    }
    const payloadProposalId = stringValue(payload.proposalId);
    const proposalId = producer.proposalId ?? payloadProposalId;
    if (!proposalId) {
      throw new SessionFactLineageError(
        'session_provider_admission_unavailable',
        `Session fact ${input.event.id} has a Provider producer but no exact proposal binding.`
      );
    }
    if (
      producer.proposalId
      && payloadProposalId
      && producer.proposalId !== payloadProposalId
    ) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Session fact ${input.event.id} proposal ${payloadProposalId} does not match lineage proposal ${producer.proposalId}.`
      );
    }
    if (
      input.providerProposalBindings?.[proposalId]
      !== producer.providerRequestId
    ) {
      throw new SessionFactLineageError(
        'session_provider_admission_unavailable',
        `Session fact ${input.event.id} proposal ${proposalId} is not bound to Provider request ${producer.providerRequestId}.`
      );
    }
    return;
  }
  if (
    lineage.producer.sourceEventRefs.length === 0
    || lineage.producer.sourceEventRefs.includes(input.event.id)
  ) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Session rule ${lineage.producer.ruleId} requires earlier immutable source refs.`
    );
  }
}

function validateTurnAuthoritySourceMessages(
  events: readonly AgentEvent[],
  authority: SessionTurnAuthorityEventRef
): void {
  const available = events.slice(0, authority.eventIndex);
  for (let index = 0; index < authority.payload.sourceMessageIds.length; index += 1) {
    const messageId = authority.payload.sourceMessageIds[index]!;
    const expectedHash = authority.payload.sourceMessageHashes[index]!;
    const source = available.find((event) => {
      if (event.kind === 'user_msg') return event.id === messageId;
      if (event.kind !== 'user_guidance') return false;
      const payload = objectRecord(event.payload);
      return (stringValue(payload?.guidanceId) ?? event.id) === messageId;
    });
    const sourcePayload = objectRecord(source?.payload);
    const content = source?.kind === 'user_guidance'
      ? stringContent(sourcePayload?.content) ?? stringContent(sourcePayload?.guidance)
      : stringContent(sourcePayload?.content);
    if (!source || content === undefined || stableHash(content) !== expectedHash) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Turn authority ${authority.eventId} source message ${messageId} is missing or does not match its persisted hash.`
      );
    }
  }
}

function validateConsumerAuthorityIdentity(
  event: AgentEvent,
  authority: SessionTurnAuthorityEventRef,
  languagePolicy: SessionTurnAuthorityEventRef['payload']['languagePolicy']
): void {
  const payload = objectRecord(event.payload) ?? {};
  const expected = authority.payload;
  if (event.sessionId !== expected.sessionId) {
    authorityMismatch(event, 'sessionId', event.sessionId, expected.sessionId);
  }
  for (const [name, actual, expectedValue] of [
    ['runId', stringValue(payload.runId), expected.runId],
    ['turnId', stringValue(payload.turnId), expected.turnId],
    ['sourceTurnId', stringValue(payload.sourceTurnId), expected.turnId],
    ['taskId', stringValue(payload.taskId), expected.taskId],
  ] as const) {
    if (actual !== undefined && actual !== expectedValue) {
      authorityMismatch(event, name, actual, expectedValue);
    }
  }
  const languageRevision = positiveInteger(payload.languageRevision);
  if (
    payload.languageRevision !== undefined
    && languageRevision !== expected.languagePolicy.revision
  ) {
    authorityMismatch(
      event,
      'languageRevision',
      String(payload.languageRevision),
      String(expected.languagePolicy.revision)
    );
  }
  const authorityLanguage = languagePolicy.language;
  if (authorityLanguage) {
    for (const [name, language] of [
      ['responseLanguage', conversationLanguage(payload.responseLanguage)],
      ['presentationLanguage', conversationLanguage(payload.presentationLanguage)],
    ] as const) {
      if (language && language !== authorityLanguage) {
        authorityMismatch(event, name, language, authorityLanguage);
      }
    }
  }
}

function validateEarlierRefs(
  events: readonly AgentEvent[],
  consumerIndex: number,
  refs: readonly string[],
  label: string,
  predicate: (event: AgentEvent) => boolean = () => true
): void {
  for (const ref of refs) {
    const index = events.findIndex((candidate) => candidate.id === ref);
    if (index < 0 || index >= consumerIndex || !predicate(events[index]!)) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Session fact at index ${consumerIndex} has invalid ${label} ref ${ref}.`
      );
    }
  }
}

function validateExactAuthorityDomainParent(
  events: readonly AgentEvent[],
  consumerIndex: number,
  consumer: AgentEvent,
  lineage: SessionFactLineageV1
): void {
  let expectedParentId: string | undefined;
  for (let index = consumerIndex - 1; index >= 0; index -= 1) {
    const candidate = events[index]!;
    if (sessionFactLineageDisposition(candidate) !== 'persistentDomainFact') {
      continue;
    }
    const candidateLineage = sessionFactLineage(candidate);
    if (candidateLineage?.turnAuthorityRef !== lineage.turnAuthorityRef) {
      continue;
    }
    expectedParentId = candidate.id;
    break;
  }
  const exact = expectedParentId
    ? lineage.domainParentRefs.length === 1
      && lineage.domainParentRefs[0] === expectedParentId
    : lineage.domainParentRefs.length === 0;
  if (!exact) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      `Session fact ${consumer.id} must reference the latest earlier same-authority domain fact${expectedParentId ? ` ${expectedParentId}` : ''}.`
    );
  }
}

function validateKernelFactRefs(
  refs: readonly SessionKernelFactRefV1[],
  authority: SessionTurnAuthorityEventRef,
  events: readonly AgentEvent[],
  consumerIndex: number
): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    const sourceIndex = events.findIndex((event) => event.id === ref.kernelEventRef);
    const sourceEvent = sourceIndex >= 0 ? events[sourceIndex] : undefined;
    const sourcePayload = sourceIndex >= 0
      ? objectRecord(sourceEvent?.payload)
      : undefined;
    const kernelEvent = objectRecord(sourcePayload?.kernelEvent);
    if (
      seen.has(ref.kernelEventRef)
      || ref.runId !== authority.payload.runId
      || !parseKernelFactRef(ref)
      || sourceIndex < 0
      || sourceIndex >= consumerIndex
      || !kernelEvent
      || stringValue(kernelEvent.kind) !== ref.kind
      || (
        stringValue(kernelEvent.runId) !== undefined
        && stringValue(kernelEvent.runId) !== ref.runId
      )
    ) {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Session fact has an invalid or mismatched Kernel fact ref ${ref.kernelEventRef || '<empty>'}.`
      );
    }
    let authoritativeRef: SessionKernelFactRefV1;
    try {
      authoritativeRef = kernelFactRefFromEvent({
        event: sourceEvent!,
        boundRunId: ref.runId,
      });
    } catch {
      throw new SessionFactLineageError(
        'session_fact_lineage_invalid',
        `Session fact references unsupported Kernel fact ${ref.kernelEventRef}.`
      );
    }
    for (const field of [
      'factId',
      'planActionId',
      'capabilityGrantId',
      'authorizationContractId',
      'operationId',
      'workUnitId',
    ] as const) {
      if (ref[field] !== undefined && ref[field] !== authoritativeRef[field]) {
        throw new SessionFactLineageError(
          'session_fact_lineage_invalid',
          `Session Kernel fact ref ${ref.kernelEventRef} has mismatched ${field}.`
        );
      }
    }
    seen.add(ref.kernelEventRef);
  }
}

function parseSessionFactProducer(value: unknown): SessionFactProducerV1 | undefined {
  const record = objectRecord(value);
  if (record?.kind === 'providerAdmission') {
    const providerRequestId = stringValue(record.providerRequestId);
    if (!providerRequestId) return undefined;
    return {
      kind: 'providerAdmission',
      providerRequestId,
      proposalId: stringValue(record.proposalId),
    };
  }
  if (record?.kind === 'sessionRule') {
    const ruleId = stringValue(record.ruleId);
    const sourceEventRefs = strictStringArray(record.sourceEventRefs);
    if (!ruleId || !sourceEventRefs || sourceEventRefs.length === 0 || hasDuplicates(sourceEventRefs)) {
      return undefined;
    }
    return { kind: 'sessionRule', ruleId, sourceEventRefs };
  }
  return undefined;
}

function parseProviderAdmissionMetadata(
  value: unknown
): SessionProviderAdmissionMetadataV1 | undefined {
  const record = objectRecord(value);
  if (record?.schemaVersion !== 'deepcode.session.provider-admission-metadata.v1') {
    return undefined;
  }
  const requestId = stringValue(record.requestId);
  const parentRequestId = stringValue(record.parentRequestId);
  const turnAuthorityRef = stringValue(record.turnAuthorityRef);
  const stage = stringValue(record.stage);
  const providerPayloadDigest = stringValue(record.providerPayloadDigest);
  const transportDigest = stringValue(record.transportDigest);
  const attemptKind = providerAttemptKind(record.attemptKind);
  const languageRevision = record.languageRevision === undefined
    ? undefined
    : positiveInteger(record.languageRevision);
  if (
    !requestId
    || !turnAuthorityRef
    || !stage
    || !providerPayloadDigest
    || !transportDigest
    || !attemptKind
    || (record.parentRequestId !== undefined && !parentRequestId)
    || parentRequestId === requestId
    || (attemptKind === 'streamFallback' && !parentRequestId)
    || (record.languageRevision !== undefined && languageRevision === undefined)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 'deepcode.session.provider-admission-metadata.v1',
    requestId,
    parentRequestId,
    turnAuthorityRef,
    attemptKind,
    stage,
    languageRevision,
    providerPayloadDigest,
    transportDigest,
  };
}

function strictKernelFactRefs(value: unknown): SessionKernelFactRefV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parseKernelFactRef);
  return parsed.every((item): item is SessionKernelFactRefV1 => Boolean(item))
    ? parsed
    : undefined;
}

function parseKernelFactRef(value: unknown): SessionKernelFactRefV1 | undefined {
  const record = objectRecord(value);
  if (record?.schemaVersion !== 'deepcode.session.kernel-fact-ref.v1') return undefined;
  const kernelEventRef = stringValue(record.kernelEventRef);
  const kind = kernelFactKind(record.kind);
  const runId = stringValue(record.runId);
  if (!kernelEventRef || !kind || !runId) return undefined;
  return {
    schemaVersion: 'deepcode.session.kernel-fact-ref.v1',
    kernelEventRef,
    kind,
    runId,
    factId: stringValue(record.factId),
    planActionId: stringValue(record.planActionId),
    capabilityGrantId: stringValue(record.capabilityGrantId),
    authorizationContractId: stringValue(record.authorizationContractId),
    operationId: stringValue(record.operationId),
    workUnitId: stringValue(record.workUnitId),
  };
}

function providerAttemptKind(
  value: unknown
): SessionProviderAdmissionMetadataV1['attemptKind'] | undefined {
  return value === 'primary'
    || value === 'resume'
    || value === 'repair'
    || value === 'emptyRetry'
    || value === 'streamFallback'
    || value === 'review'
    ? value
    : undefined;
}

function kernelFactKind(value: unknown): SessionKernelFactKindV1 | undefined {
  return value === 'plan_authorization.decision_recorded'
    || value === 'tool.execution_attempted'
    || value === 'tool.effect_observed'
    || value === 'tool.outcome_indeterminate'
    || value === 'tool.completed'
    || value === 'work_unit.completed'
    || value === 'work_unit.failed'
    || value === 'work_unit.blocked'
    || value === 'review.facts_produced'
    || value === 'review_gate.evaluated'
    || value === 'run.completed'
    || value === 'runtime.lifecycle_changed'
    || value === 'resource.cleanup_state_changed'
    ? value
    : undefined;
}

function freezeLineage(lineage: SessionFactLineageV1): SessionFactLineageV1 {
  return Object.freeze(cloneLineage(lineage));
}

function cloneLineage(lineage: SessionFactLineageV1): SessionFactLineageV1 {
  return {
    schemaVersion: 'deepcode.session.fact-lineage.v1',
    turnAuthorityRef: lineage.turnAuthorityRef,
    producer: lineage.producer.kind === 'providerAdmission'
      ? {
          kind: 'providerAdmission',
          providerRequestId: lineage.producer.providerRequestId,
          proposalId: lineage.producer.proposalId,
        }
      : {
          kind: 'sessionRule',
          ruleId: lineage.producer.ruleId,
          sourceEventRefs: [...lineage.producer.sourceEventRefs],
        },
    domainParentRefs: [...lineage.domainParentRefs],
    kernelFactRefs: lineage.kernelFactRefs.map((ref) => ({ ...ref })),
  };
}

function cloneProviderAdmission(
  admission: SessionProviderAdmissionMetadataV1
): SessionProviderAdmissionMetadataV1 {
  return { ...admission };
}

function cloneEvent(event: AgentEvent): AgentEvent {
  const payload = objectRecord(event.payload);
  return {
    ...event,
    payload: payload ? { ...payload } : event.payload,
    display: event.display ? { ...event.display } : undefined,
  };
}

function normalizedRefs(values: readonly string[] | undefined): string[] {
  const refs = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (hasDuplicates(refs)) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      'Session fact lineage contains duplicate immutable refs.'
    );
  }
  return refs;
}

function normalizedKernelFactRefs(
  values: readonly SessionKernelFactRefV1[] | undefined
): SessionKernelFactRefV1[] {
  const refs = (values ?? []).map((value) => parseKernelFactRef(value));
  if (!refs.every((value): value is SessionKernelFactRefV1 => Boolean(value))) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      'Session fact lineage contains an invalid typed Kernel fact ref.'
    );
  }
  if (hasDuplicates(refs.map((ref) => ref.kernelEventRef))) {
    throw new SessionFactLineageError(
      'session_fact_lineage_invalid',
      'Session fact lineage contains duplicate Kernel event refs.'
    );
  }
  return refs;
}

function strictStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: string[] = [];
  for (const item of value) {
    const ref = stringValue(item);
    if (!ref) return undefined;
    refs.push(ref);
  }
  return refs;
}

function requiredRef(value: string, message: string): string {
  const ref = value.trim();
  if (!ref) {
    throw new SessionFactLineageError('session_fact_lineage_invalid', message);
  }
  return ref;
}

function optionalRef(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function authorityMismatch(
  event: AgentEvent,
  field: string,
  actual: string,
  expected: string
): never {
  throw new SessionFactLineageError(
    'session_fact_lineage_invalid',
    `Session fact ${event.id} ${field}=${actual} does not match turn authority ${expected}.`
  );
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function conversationLanguage(value: unknown): ConversationLanguage | undefined {
  return value === 'zh-CN' || value === 'en-US' ? value : undefined;
}

function isTerminalSessionRunStatus(value: unknown): boolean {
  return value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'waiting';
}

function acceptedPermissionKernelKind(
  eventKind: 'permission_request' | 'permission_result',
  kernelKind: unknown
): boolean {
  return eventKind === 'permission_request'
    ? kernelKind === 'permission.requested'
    : kernelKind === 'permission.resolved';
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringContent(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
