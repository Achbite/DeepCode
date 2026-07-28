import type { CapabilityScopePreviewReplyV2 } from '@deepcode/protocol';
import {
  nextSessionKernelFactsQueryV2,
} from './lineage.js';
import type { SessionKernelLoopPortsV2 } from './ports.js';
import {
  SessionKernelProviderTurnsV2,
} from './providerTurns.js';
import {
  expectSessionKernelPublicRequestOutcomeV2,
  sameSessionKernelPublicRequestV2,
  sessionKernelPublicRequestLaneV2,
  SessionKernelPublicRequestsV2,
} from './publicRequests.js';
import {
  finalizeSessionKernelReviewV2,
} from './review.js';
import {
  checkpointSessionKernelStateV2,
  cloneSessionKernelLoopStateV2,
  createSessionKernelLoopStateV2,
  recordSessionPlanV2,
  recordSessionUserInputV2,
  restoreSessionKernelLoopStateV2,
  sessionPlanActionV2,
  type SessionKernelInitialStateV2,
  type SessionKernelLoopStateV2,
} from './state.js';
import {
  toolContextRefV2,
} from './toolContext.js';
import type {
  SessionKernelLoopResultV2,
  SessionKernelProjectionEventV2,
  SessionKernelPublicRequestRecordV2,
  SessionKernelReviewV2,
  SessionNaturalLanguagePlanV2,
  SessionProviderTurnRequestV2,
  SessionUserInputRecordV2,
} from './types.js';

export interface SessionKernelLoopV2Options {
  factsPageLimit?: number;
  maxFactsPagesPerWake?: number;
  retryDelayMs?: number;
}

const DEFAULT_FACTS_PAGE_LIMIT = 256;
const DEFAULT_MAX_FACTS_PAGES = 64;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * Session v2 orchestration path. Production composition is supplied only by
 * the strict v2 Host entry and semantic ports in this directory.
 */
export class SessionKernelLoopV2 {
  private readonly factsPageLimit: number;
  private readonly maxFactsPages: number;
  private readonly requests: SessionKernelPublicRequestsV2;
  private readonly providers: SessionKernelProviderTurnsV2;
  private authorityTransitionActive = false;
  private maintenanceActive = false;
  private checkpointWrites: Promise<void> = Promise.resolve();

  private constructor(
    private state: SessionKernelLoopStateV2,
    private readonly ports: SessionKernelLoopPortsV2,
    options: SessionKernelLoopV2Options
  ) {
    this.factsPageLimit =
      options.factsPageLimit ?? DEFAULT_FACTS_PAGE_LIMIT;
    this.maxFactsPages =
      options.maxFactsPagesPerWake ?? DEFAULT_MAX_FACTS_PAGES;
    this.requests = new SessionKernelPublicRequestsV2(
      ports,
      {
        readState: () => this.state,
        replaceState: (state) => {
          this.state = state;
        },
        saveCheckpoint: () => this.saveCheckpoint(),
        event: (projectionId, kind, data, recordedAt) =>
          this.event(projectionId, kind, data, recordedAt),
      },
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    );
    this.providers = new SessionKernelProviderTurnsV2(
      ports,
      this.requests,
      {
        readState: () => this.state,
        saveCheckpoint: () => this.saveCheckpoint(),
        project: (projectionId, kind, data) =>
          this.project(projectionId, kind, data),
        reconcileFacts: () => this.reconcileFactsInternal(),
        recordProviderPlan: (plan) =>
          this.persistPlan(plan),
        transitionBlocked: () =>
          this.authorityTransitionActive || this.maintenanceActive,
        requireNoPendingRequests: () => this.requireNoPendingRequests(),
        requirePlanProjected: () => this.requirePlanProjected(),
      }
    );
  }

  static async open(
    initial: SessionKernelInitialStateV2,
    ports: SessionKernelLoopPortsV2,
    options: SessionKernelLoopV2Options = {}
  ): Promise<SessionKernelLoopV2> {
    if (
      ports.kernel.run.runId !== initial.runId
      || ports.kernel.run.workspaceBindingDigest
        !== initial.workspaceBindingDigest
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_loop_run_mismatch',
        'Loop initial state does not match SessionKernelPortV2.'
      );
    }
    const [
      checkpoint,
      persistedPlan,
      persistedInput,
      pendingRequests,
    ] = await Promise.all([
      ports.persistence.loadCheckpoint(initial.runId),
      ports.persistence.loadLatestPlan(initial.runId),
      ports.persistence.loadLatestInput(initial.runId),
      ports.persistence.loadPendingPublicRequests(initial.runId),
    ]);
    let state = checkpoint
      ? restoreSessionKernelLoopStateV2(checkpoint, ports.kernel.run)
      : createSessionKernelLoopStateV2(initial);
    const checkpointInitial = state.inputs.find(
      (input) => input.inputId === initial.initialInput.inputId
    );
    if (
      checkpoint
      && (
        !checkpointInitial
        || JSON.stringify(checkpointInitial)
          !== JSON.stringify(initial.initialInput)
      )
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_initial_input_identity_conflict',
        'Checkpoint state does not contain the RunOpen initial input identity.'
      );
    }
    if (checkpoint && !persistedInput) {
      throw new SessionKernelLoopError(
        'session_kernel_persisted_input_missing',
        'Checkpoint recovery requires the durable latest user input record.'
      );
    }
    if (!persistedInput) {
      await ports.persistence.persistInput(initial.initialInput);
    }
    if (persistedInput) {
      const existingInput = state.inputs.find(
        (input) => input.inputId === persistedInput.inputId
      );
      if (!existingInput) {
        state = recordSessionUserInputV2(state, persistedInput);
      } else if (
        JSON.stringify(existingInput) !== JSON.stringify(persistedInput)
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_input_identity_conflict',
          'Checkpoint and persistence disagree about the latest user input.'
        );
      }
    }
    if (
      persistedPlan
      && persistedPlan.inputId === state.currentInputId
    ) {
      state = recordSessionPlanV2(state, persistedPlan);
    }
    state.publicRequests = authoritativePendingRequests(
      state,
      pendingRequests
    );
    const loop = new SessionKernelLoopV2(state, ports, options);
    await loop.recover();
    return loop;
  }

  snapshot(): SessionKernelLoopStateV2 {
    return cloneSessionKernelLoopStateV2(this.state);
  }

  async recordPlan(plan: SessionNaturalLanguagePlanV2): Promise<void> {
    this.beginMaintenance('recordPlan');
    try {
      await this.persistPlan(plan);
    } finally {
      this.endMaintenance();
    }
  }

  async previewPlanAction(
    planActionId: string
  ): Promise<CapabilityScopePreviewReplyV2> {
    this.beginMaintenance('previewPlanAction');
    try {
      this.requireNoPendingRequests();
      this.requirePlanProjected();
      if (this.state.toolContext.refreshRequired) {
        throw new SessionKernelLoopError(
          'session_kernel_context_refresh_boundary_required',
          'ToolContext invalidation is refreshed only at the next provider-turn boundary.'
        );
      }
      const action = sessionPlanActionV2(this.state, planActionId);
      const outcome = await this.requests.execute(
        this.requests.newRecord({
          kind: 'capabilityPreview',
          payload: {
            expectedControlEpoch: this.state.controlEpoch,
            manifest: action.manifest,
            rawArguments: action.previewArguments,
            idempotencyKey: action.idempotencyKey,
            deadline: action.deadline,
            toolContextRef: toolContextRefV2(
              this.state.toolContext.bundle
            ),
          },
        })
      );
      const reply = expectSessionKernelPublicRequestOutcomeV2(
        outcome,
        'capabilityPreview'
      ).reply;
      if (reply.kind === 'previewed') {
        await this.project(
          `scope:${reply.data.preview.previewId}`,
          'scope.previewed',
          reply
        );
      } else {
        await this.project(
          [
            'scope',
            action.manifest.planRevision,
            action.manifest.planActionId,
            String(this.state.controlEpoch),
            this.state.toolContext.bundle.contextDigest,
            'rejected',
          ].join(':'),
          'scope.previewed',
          {
            ...reply,
            planRevision: action.manifest.planRevision,
            planActionId: action.manifest.planActionId,
            operationId: action.manifest.operationId,
          }
        );
      }
      return reply;
    } finally {
      this.endMaintenance();
    }
  }

  async runProviderTurn(
    request: SessionProviderTurnRequestV2
  ): Promise<SessionKernelLoopResultV2> {
    return this.providers.run(request);
  }

  async handleUserInput(
    input: SessionUserInputRecordV2,
    nextTurn: SessionProviderTurnRequestV2
  ): Promise<SessionKernelLoopResultV2> {
    this.beginAuthorityTransition();
    try {
      const oldInvocationId = activeInvocationId(this.state);
      this.providers.supersedeForUserInput();
      this.requests.supersedeForUserInput();
      this.state = recordSessionUserInputV2(this.state, input);
      await this.ports.persistence.persistInput(input);
      await this.saveCheckpoint();
      await this.ensureInputProjected(input);

      await this.advancePendingInput(oldInvocationId);
      await this.reconcileFactsInternal();
      await this.requests.replay('effect');
      await this.reconcileFactsInternal();
    } finally {
      this.authorityTransitionActive = false;
    }
    return this.runProviderTurn(nextTurn);
  }

  async observeCapabilityDecision(input: {
    decision: 'allow' | 'deny';
    guidance?: string;
    nextTurn?: SessionProviderTurnRequestV2;
  }): Promise<SessionKernelLoopResultV2 | undefined> {
    let continueWith: SessionProviderTurnRequestV2 | undefined;
    this.beginMaintenance('observeCapabilityDecision');
    try {
      if (this.state.activeWait?.kind !== 'capability') {
        throw new SessionKernelLoopError(
          'session_kernel_capability_wait_missing',
          'No capability ActiveWait is available for reconciliation.'
        );
      }
      this.state.activeWait.decisionHint = input.decision;
      if (input.guidance) {
        this.state.activeWait.denialGuidance = input.guidance;
      }
      await this.saveCheckpoint();
      await this.reconcileFactsInternal();
      if (
        input.decision === 'deny'
        && !this.state.activeWait
        && input.nextTurn
      ) {
        continueWith = input.nextTurn;
      }
    } finally {
      this.endMaintenance();
    }
    return continueWith
      ? this.runProviderTurn(continueWith)
      : undefined;
  }

  async notifyKernelWakeHint(): Promise<void> {
    this.state.kernelWakeHint = true;
    if (
      this.authorityTransitionActive
      || this.maintenanceActive
      || this.providers.isReserved()
    ) {
      return;
    }
    this.beginMaintenance('kernelWake');
    try {
      await this.saveCheckpoint();
      await this.reconcileFactsInternal();
    } finally {
      this.endMaintenance();
    }
  }

  /**
   * Backpressure never resubmits the rejected ToolIntent. A caller must
   * supply a newly planned operation after the delay.
   */
  async resumeAfterBackpressure(
    nextTurn: SessionProviderTurnRequestV2
  ): Promise<SessionKernelLoopResultV2> {
    const wait = this.state.activeWait;
    if (!wait || wait.kind !== 'backpressure') {
      throw new SessionKernelLoopError(
        'session_kernel_backpressure_wait_missing',
        'No backpressure ActiveWait is present.'
      );
    }
    const nextOperationId = this.operationIdForTarget(nextTurn);
    if (nextOperationId === wait.operationId) {
      throw new SessionKernelLoopError(
        'session_kernel_backpressure_replan_required',
        'Backpressure requires a new planned operation; the rejected ToolIntent cannot be resubmitted.'
      );
    }
    await this.ports.clock.waitUntil(wait.retryAt);
    this.beginMaintenance('resumeAfterBackpressure');
    try {
      if (
        this.state.activeWait?.kind !== 'backpressure'
        || this.state.activeWait.operationId !== wait.operationId
        || this.state.activeWait.retryAt !== wait.retryAt
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_backpressure_wait_superseded',
          'The backpressure ActiveWait was superseded before its deadline.'
        );
      }
      this.state.activeWait = undefined;
      this.state.pendingGuidance = unique([
        ...this.state.pendingGuidance,
        wait.guidance,
      ]);
      await this.saveCheckpoint();
      await this.project(
        `backpressure:${wait.operationId}:${wait.retryAt}:resumed`,
        'wait.changed',
        undefined
      );
    } finally {
      this.endMaintenance();
    }
    return this.runProviderTurn({
      ...nextTurn,
      reason: 'retryGuidance',
      guidance: unique([
        ...(nextTurn.guidance ?? []),
        wait.guidance,
      ]),
    });
  }

  async reconcileFacts(): Promise<void> {
    this.beginMaintenance('reconcileFacts');
    try {
      await this.reconcileFactsInternal();
    } finally {
      this.endMaintenance();
    }
  }

  async finalizeReview(): Promise<SessionKernelReviewV2> {
    this.beginMaintenance('finalizeReview');
    try {
      this.requireNoPendingRequests();
      await this.reconcileFactsInternal();
      const review = finalizeSessionKernelReviewV2(
        this.state,
        this.ports.clock.now()
      );
      this.state.review = review;
      await this.saveCheckpoint();
      await this.project(
        `review:${review.revision}:${review.snapshotHighWater}:final`,
        'review.revised',
        review,
        review.finalizedAt
      );
      return JSON.parse(JSON.stringify(review)) as SessionKernelReviewV2;
    } finally {
      this.endMaintenance();
    }
  }

  async recover(): Promise<void> {
    this.beginMaintenance('recover');
    try {
      await this.ensurePlanProjected();
      for (const input of this.state.inputs) {
        await this.ensureInputProjected(input);
      }
      const oldInvocationId = activeInvocationId(this.state);
      if (this.state.pendingEpochInput) {
        await this.advancePendingInput(oldInvocationId);
      } else {
        await this.requests.replay('control');
      }
      await this.reconcileFactsInternal();
      await this.requests.replay('effect');
      await this.reconcileFactsInternal();
    } finally {
      this.endMaintenance();
    }
  }

  private async advancePendingInput(
    oldInvocationId?: string
  ): Promise<void> {
    await this.requests.replay('control');
    const input = this.state.pendingEpochInput;
    if (!input) return;
    const outcome = await this.requests.execute(
      this.requests.newRecord({
        kind: 'controlEpochAdvance',
        payload: {
          precondition: {
            kind: 'exact',
            data: { controlEpoch: this.state.controlEpoch },
          },
          inputId: input.inputId,
          opaqueInputRef: input.opaqueInputRef,
        },
      })
    );
    const reply = expectSessionKernelPublicRequestOutcomeV2(
      outcome,
      'controlEpochAdvance'
    ).reply;
    if (reply.cancellation.kind === 'none' && oldInvocationId) {
      await this.requests.execute(
        this.requests.newRecord({
          kind: 'invocationCancel',
          payload: {
            expectedControlEpoch: reply.acceptedControlEpoch,
            target: {
              kind: 'exact',
              data: { invocationId: oldInvocationId },
            },
            reasonCode: 'epochSuperseded',
            reason:
              'A persisted user input superseded the prior control epoch.',
          },
        })
      );
    }
  }

  private async reconcileFactsInternal(): Promise<void> {
    await this.requests.replay('query');
    for (let pageIndex = 0; pageIndex < this.maxFactsPages; pageIndex += 1) {
      const query = nextSessionKernelFactsQueryV2(
        this.state.lineage,
        this.factsPageLimit
      );
      const outcome = await this.requests.execute(
        this.requests.newRecord({
          kind: 'factsQuery',
          payload: {
            afterLedgerSequence: query.afterLedgerSequence,
            limit: query.limit,
            ...(query.continuation
              ? { continuation: query.continuation }
              : {}),
          },
        })
      );
      const page = expectSessionKernelPublicRequestOutcomeV2(
        outcome,
        'factsQuery'
      ).reply;
      if (!page.hasMore) return;
    }
    throw new SessionKernelLoopError(
      'session_kernel_fact_page_budget_exhausted',
      'Kernel facts remained paginated after the bounded wake budget.'
    );
  }

  private async ensurePlanProjected(): Promise<void> {
    const plan = this.state.plan;
    if (!plan || this.state.projectedPlanRevision === plan.planRevision) {
      return;
    }
    await this.project(
      `plan:${plan.planRevision}`,
      'plan.persisted',
      plan,
      plan.recordedAt
    );
    this.state.projectedPlanRevision = plan.planRevision;
    await this.saveCheckpoint();
  }

  private async persistPlan(
    plan: SessionNaturalLanguagePlanV2
  ): Promise<void> {
    this.requireNoPendingRequests();
    if (
      this.state.activeWait
      && this.state.activeWait.kind !== 'backpressure'
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_change_blocked',
        'Plan cannot change while capability, invocation, or recovery work is active.'
      );
    }
    const previousRevision = this.state.plan?.planRevision;
    const next = recordSessionPlanV2(this.state, plan);
    await this.ports.persistence.persistPlan(plan);
    this.state = next;
    if (previousRevision !== plan.planRevision) {
      this.state.projectedPlanRevision = undefined;
    }
    await this.saveCheckpoint();
    await this.ensurePlanProjected();
  }

  private async ensureInputProjected(
    input: SessionUserInputRecordV2
  ): Promise<void> {
    if (this.state.projectedInputIds.includes(input.inputId)) return;
    await this.project(
      `input:${input.inputId}`,
      'input.persisted',
      input,
      input.recordedAt
    );
    this.state.projectedInputIds.push(input.inputId);
    await this.saveCheckpoint();
  }

  private requirePlanProjected(): void {
    if (
      !this.state.plan
      || this.state.projectedPlanRevision
        !== this.state.plan.planRevision
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_projection_required',
        'A Plan must be durably persisted and projected before preview or ToolIntent generation.'
      );
    }
  }

  private operationIdForTarget(
    request: SessionProviderTurnRequestV2
  ): string {
    if (request.target.kind === 'planAction') {
      return sessionPlanActionV2(
        this.state,
        request.target.planActionId
      ).manifest.operationId;
    }
    if (request.target.kind === 'contextRead') {
      return request.target.operationId;
    }
    throw new SessionKernelLoopError(
      'session_kernel_backpressure_target_invalid',
      'A planning turn cannot replace a backpressured operation.'
    );
  }

  private beginAuthorityTransition(): void {
    if (this.authorityTransitionActive || this.maintenanceActive) {
      throw new SessionKernelLoopError(
        'session_kernel_authority_transition_concurrent',
        'Another serialized Session authority transition is active.'
      );
    }
    this.authorityTransitionActive = true;
  }

  private beginMaintenance(operation: string): void {
    if (
      this.authorityTransitionActive
      || this.maintenanceActive
      || this.providers.isReserved()
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_operation_concurrent',
        `${operation} cannot interleave with another Session transition.`
      );
    }
    this.maintenanceActive = true;
  }

  private endMaintenance(): void {
    this.maintenanceActive = false;
  }

  private requireNoPendingRequests(): void {
    const lanes = this.requests.pendingRecords()
      .map((request) => request.lane)
      .sort();
    if (lanes.length > 0) {
      throw new SessionKernelLoopError(
        'session_kernel_public_request_recovery_required',
        `Persisted Kernel request recovery is required for lanes: ${lanes.join(', ')}.`
      );
    }
  }

  private async saveCheckpoint(): Promise<void> {
    const checkpoint = checkpointSessionKernelStateV2(
      this.state,
      this.ports.clock.now()
    );
    this.state.checkpointRevision = checkpoint.checkpointRevision;
    const write = this.checkpointWrites
      .catch(() => undefined)
      .then(() => this.ports.persistence.persistCheckpoint(checkpoint));
    this.checkpointWrites = write;
    await write;
  }

  private async project(
    projectionId: string,
    kind: SessionKernelProjectionEventV2['kind'],
    data: unknown,
    recordedAt?: string
  ): Promise<void> {
    await this.ports.projection.project(
      this.event(projectionId, kind, data, recordedAt)
    );
  }

  private event(
    projectionId: string,
    kind: SessionKernelProjectionEventV2['kind'],
    data: unknown,
    recordedAt?: string
  ): SessionKernelProjectionEventV2 {
    return {
      projectionId,
      runId: this.state.runId,
      recordedAt: recordedAt ?? this.ports.clock.now(),
      kind,
      data,
    };
  }
}

function activeInvocationId(
  state: SessionKernelLoopStateV2
): string | undefined {
  const wait = state.activeWait;
  return wait?.kind === 'capability' || wait?.kind === 'invocation'
    ? wait.invocationId
    : wait?.kind === 'manualRecovery'
      ? wait.invocationId
      : undefined;
}

function authoritativePendingRequests(
  state: SessionKernelLoopStateV2,
  records: SessionKernelPublicRequestRecordV2[]
): SessionKernelLoopStateV2['publicRequests'] {
  const result: SessionKernelLoopStateV2['publicRequests'] = {};
  for (const record of records) {
    const expectedLane = sessionKernelPublicRequestLaneV2(record.intent);
    if (record.lane !== expectedLane) {
      throw new SessionKernelLoopError(
        'session_kernel_public_request_lane_mismatch',
        'Persisted Kernel request has an invalid lane.'
      );
    }
    const existing = result[record.lane];
    if (existing && !sameSessionKernelPublicRequestV2(existing, record)) {
      throw new SessionKernelLoopError(
        'session_kernel_public_request_lane_conflict',
        `Persistence contains multiple unresolved ${record.lane} requests.`
      );
    }
    const checkpointRecord = state.publicRequests[record.lane];
    if (
      checkpointRecord
      && !sameSessionKernelPublicRequestV2(checkpointRecord, record)
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_public_request_conflict',
        'Checkpoint and persistence disagree about a pending Kernel request.'
      );
    }
    result[record.lane] = record;
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

export class SessionKernelLoopError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelLoopError';
  }
}
