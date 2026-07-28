import type { CapabilityScopePreviewReplyV2 } from '@deepcode/protocol';
import {
  nextSessionKernelFactsQueryV2,
} from './lineage.js';
import type {
  SessionKernelLoopPortsV2,
  SessionKernelStoredOperationResultRefV2,
} from './ports.js';
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
  recordSessionPlanDecisionV2,
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
  SessionPlanActionSettlementV2,
  SessionPlanDecisionV2,
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
  private maintenanceQuiescence: Promise<void> = Promise.resolve();
  private resolveMaintenanceQuiescence?: () => void;
  private readonly pendingUserInputFences = new Set<number>();
  private checkpointWrites: Promise<void> = Promise.resolve();
  private pendingPlanDecision?: SessionPlanDecisionV2;
  private readonly userInputQuiescence = new Map<
    number,
    Promise<void>
  >();

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
        project: (projectionId, kind, data, recordedAt) =>
          this.project(projectionId, kind, data, recordedAt),
        reconcileFacts: () => this.reconcileFactsInternal(),
        recordProviderPlan: (plan) =>
          this.persistPlan(plan),
        settlePlanActionCompleted: (
          planActionId,
          completionKind,
          providerTurnId
        ) => this.settlePlanActionCompleted(
          planActionId,
          completionKind,
          providerTurnId
        ),
        transitionBlocked: () =>
          this.authorityTransitionActive || this.maintenanceActive,
        requireNoPendingRequests: () => this.requireNoPendingRequests(),
        requirePlanProjected: () => this.requirePlanProjected(),
        requirePlanAccepted: () => this.requireAcceptedPlan(),
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
    const persistedPlanDecision = state.plan
      ? await ports.persistence.loadPlanDecision(
          initial.runId,
          state.plan.planRevision
        )
      : undefined;
    if (
      state.planDecision
      && !persistedPlanDecision
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_persisted_plan_decision_missing',
        'Checkpoint Plan decision requires its immutable durable decision record.'
      );
    }
    if (
      persistedPlanDecision
      && persistedPlanDecision.planRevision === state.plan?.planRevision
    ) {
      state = recordSessionPlanDecisionV2(
        state,
        persistedPlanDecision
      );
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

  persistOperationResult(
    operationRequestId: string,
    result: unknown
  ): Promise<SessionKernelStoredOperationResultRefV2> {
    return this.ports.persistence.persistOperationResult(
      operationRequestId,
      result,
      this.ports.clock.now()
    );
  }

  async recordPlan(plan: SessionNaturalLanguagePlanV2): Promise<void> {
    this.beginMaintenance('recordPlan');
    try {
      await this.persistPlan(plan);
    } finally {
      this.endMaintenance();
    }
  }

  async decidePlan(input: {
    planRevision: string;
    decision: SessionPlanDecisionV2['decision'];
    guidance?: string;
  }): Promise<SessionPlanDecisionV2> {
    this.beginMaintenance('decidePlan');
    try {
      this.requireNoPendingRequests();
      this.requirePlanProjected();
      if (this.state.activeWait) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_decision_wait_active',
          'Plan decision cannot change while authority or invocation work is active.'
        );
      }
      if (this.state.plan?.planRevision !== input.planRevision) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_decision_revision_stale',
          `Plan revision ${input.planRevision} is not the current persisted Plan.`
        );
      }
      if (
        input.decision === 'accept'
        && (
          this.state.toolContext.refreshRequired
          || this.state.plan.actions.some((action) => {
            const preview =
              this.state.previews[action.manifest.operationId];
            const contextRef = toolContextRefV2(
              this.state.toolContext.bundle
            );
            return (
              !preview
              || preview.runId !== this.state.runId
              || preview.controlEpoch !== this.state.controlEpoch
              || preview.planRevision
                !== action.manifest.planRevision
              || preview.planActionId
                !== action.manifest.planActionId
              || preview.operationId
                !== action.manifest.operationId
              || preview.toolId !== action.manifest.toolId
              || preview.contextRef.contextVersion
                !== contextRef.contextVersion
              || preview.contextRef.catalogDigest
                !== contextRef.catalogDigest
              || preview.contextRef.contextDigest
                !== contextRef.contextDigest
            );
          })
        )
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_scope_preview_required',
          'Every PlanAction must have a canonical Kernel scope preview before Plan acceptance.'
        );
      }
      const guidance = input.guidance;
      const existing = this.state.planDecision
        ?? (
          this.pendingPlanDecision?.planRevision === input.planRevision
            ? this.pendingPlanDecision
            : undefined
        );
      if (existing) {
        if (
          existing.planRevision !== input.planRevision
          || existing.decision !== input.decision
          || (existing.guidance ?? undefined) !== (guidance || undefined)
        ) {
          throw new SessionKernelLoopError(
            'session_kernel_plan_decision_conflict',
            `Plan revision ${input.planRevision} already has a different immutable decision attempt.`
          );
        }
        if (!this.state.planDecision) {
          await this.ports.persistence.persistPlanDecision(existing);
          this.state = recordSessionPlanDecisionV2(
            this.state,
            existing
          );
          this.pendingPlanDecision = undefined;
          await this.saveCheckpoint();
        }
        await this.ensurePlanDecisionProjected();
        return cloneJson(existing);
      }
      const decision: SessionPlanDecisionV2 = {
        planRevision: input.planRevision,
        decision: input.decision,
        ...(guidance ? { guidance } : {}),
        recordedAt: this.ports.clock.now(),
      };
      const next = recordSessionPlanDecisionV2(this.state, decision);
      this.pendingPlanDecision = decision;
      await this.ports.persistence.persistPlanDecision(decision);
      this.state = next;
      this.pendingPlanDecision = undefined;
      await this.saveCheckpoint();
      await this.ensurePlanDecisionProjected();
      return cloneJson(decision);
    } finally {
      this.endMaintenance();
    }
  }

  async skipPlanAction(
    planActionId: string,
    expectedPlanRevision: string,
    reason: string
  ): Promise<void> {
    this.beginMaintenance('skipPlanAction');
    try {
      this.requireNoPendingRequests();
      this.requireCurrentPlanRevision(expectedPlanRevision);
      this.requireAcceptedPlan();
      if (this.state.activeWait) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_action_skip_wait_active',
          'PlanAction cannot be skipped while an authority or invocation wait is active.'
        );
      }
      sessionPlanActionV2(this.state, planActionId);
      const recordedAt = this.ports.clock.now();
      const settlement = {
        kind: 'skipped' as const,
        planActionId,
        reason: requiredReason(reason),
        recordedAt,
      };
      const existing = this.state.planActionSettlements[planActionId];
      if (existing && JSON.stringify(existing) !== JSON.stringify(settlement)) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_action_skip_conflict',
          `PlanAction ${planActionId} already has a different settlement.`
        );
      }
      this.state.planActionSettlements[planActionId] = settlement;
      await this.saveCheckpoint();
      await this.project(
        `plan-action:${planActionId}:skipped`,
        'planAction.skipped',
        settlement,
        recordedAt
      );
    } finally {
      this.endMaintenance();
    }
  }

  async previewPlanAction(
    planActionId: string,
    expectedPlanRevision: string
  ): Promise<CapabilityScopePreviewReplyV2> {
    this.beginMaintenance('previewPlanAction');
    try {
      this.requireNoPendingRequests();
      this.requirePlanProjected();
      this.requireCurrentPlanRevision(expectedPlanRevision);
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
    if (request.target.kind === 'planAction') {
      this.requireAcceptedPlan();
    }
    return this.providers.run(request);
  }

  async handleUserInput(
    input: SessionUserInputRecordV2,
    nextTurn: SessionProviderTurnRequestV2
  ): Promise<SessionKernelLoopResultV2> {
    const generation = this.fenceProviderForUserInput();
    await this.applyFencedUserInput(input, generation);
    return this.runProviderTurn(nextTurn);
  }

  /**
   * Establishes the local Provider/output fence synchronously. The returned
   * generation carries a quiescence barrier for local preparing/applying
   * commits; an already-durable transport attempt is detached and can only be
   * recovered with its exact persisted identity after the epoch advances.
   */
  fenceProviderForUserInput(): number {
    const providerFence = this.providers.supersedeForUserInput();
    const requestQuiescence = this.requests.supersedeForUserInput();
    this.pendingUserInputFences.add(providerFence.generation);
    this.userInputQuiescence.set(
      providerFence.generation,
      Promise.all([
        providerFence.quiescence,
        requestQuiescence,
        this.maintenanceQuiescence,
      ]).then(() => undefined)
    );
    return providerFence.generation;
  }

  isUserInputFenceCurrent(generation: number): boolean {
    return this.providers.isAuthorityGenerationCurrent(generation);
  }

  async applyFencedUserInput(
    input: SessionUserInputRecordV2,
    generation: number
  ): Promise<void> {
    let transitionStarted = false;
    try {
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new SessionKernelLoopError(
          'session_kernel_user_input_fence_invalid',
          'User input transition requires a valid local Provider fence.'
        );
      }
      const quiescence = this.userInputQuiescence.get(generation);
      if (!quiescence) {
        throw new SessionKernelLoopError(
          'session_kernel_user_input_fence_unknown',
          'User input transition does not match a live local fence.'
        );
      }
      await quiescence;
      this.beginAuthorityTransition();
      transitionStarted = true;
      const oldInvocationId = activeInvocationId(this.state);
      const durableInput =
        await this.ports.persistence.loadInput(
          this.state.runId,
          input.inputId
        );
      if (
        durableInput
        && JSON.stringify(durableInput) !== JSON.stringify(input)
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_input_identity_conflict',
          `Input ${input.inputId} already has different durable content.`
        );
      }
      if (
        durableInput
        && this.state.currentInputId !== input.inputId
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_input_identity_reused',
          `Input ${input.inputId} cannot be reused as a later user turn.`
        );
      }
      await this.ports.persistence.persistInput(input);
      this.state = recordSessionUserInputV2(this.state, input);
      await this.saveCheckpoint();

      await this.advancePendingInput(oldInvocationId);
      await this.reconcileFactsInternal();
      await this.requests.replay('effect');
      await this.reconcileFactsInternal();
      await this.ensureInputProjected(input);
      this.providers.releaseUserInputFence(generation);
    } finally {
      this.userInputQuiescence.delete(generation);
      this.pendingUserInputFences.delete(generation);
      if (transitionStarted) {
        this.authorityTransitionActive = false;
      }
    }
  }

  async observeCapabilityDecision(input: {
    decision: 'allow' | 'deny';
    guidance?: string;
    previewId: string;
    operationId: string;
    invocationId: string;
    planActionId?: string;
    expectedPlanRevision?: string;
    nextTurn?: SessionProviderTurnRequestV2;
  }): Promise<SessionKernelLoopResultV2 | undefined> {
    let continueWith: SessionProviderTurnRequestV2 | undefined;
    this.beginMaintenance('observeCapabilityDecision');
    try {
      if (
        this.state.activeWait?.kind !== 'capability'
        || this.state.activeWait.previewId !== input.previewId
        || this.state.activeWait.operationId !== input.operationId
        || this.state.activeWait.invocationId !== input.invocationId
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_capability_wait_stale',
          'Capability observation does not match the current durable ActiveWait.'
        );
      }
      this.requireExactPlanActionBinding(input.operationId, input);
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

  async notifyKernelWakeHint(input: {
    waitKind: 'capability' | 'invocation';
    operationId: string;
    invocationId: string;
    previewId?: string;
    planActionId?: string;
    expectedPlanRevision?: string;
  }): Promise<void> {
    const wait = this.state.activeWait;
    if (
      !wait
      || wait.kind !== input.waitKind
      || wait.operationId !== input.operationId
      || wait.invocationId !== input.invocationId
      || (
        wait.kind === 'capability'
          ? wait.previewId !== input.previewId
          : input.previewId !== undefined
      )
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_wake_identity_stale',
        'Kernel wake does not match the current durable ActiveWait.'
      );
    }
    this.requireExactPlanActionBinding(input.operationId, input);
    this.state.kernelWakeHint = true;
    if (
      this.authorityTransitionActive
      || this.maintenanceActive
      || this.providers.isReserved()
      || this.pendingUserInputFences.size > 0
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
    guidance: string[] = [],
    signal?: AbortSignal
  ): Promise<SessionKernelLoopResultV2> {
    const wait = this.state.activeWait;
    if (!wait || wait.kind !== 'backpressure') {
      throw new SessionKernelLoopError(
        'session_kernel_backpressure_wait_missing',
        'No backpressure ActiveWait is present.'
      );
    }
    await this.ports.clock.waitUntil(wait.retryAt, signal);
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
      reason: 'retryGuidance',
      target: { kind: 'planning' },
      guidance: unique([
        ...guidance,
        wait.guidance,
      ]),
    });
  }

  async reconcileFacts(observedHighWater: number): Promise<void> {
    if (
      !Number.isSafeInteger(observedHighWater)
      || observedHighWater < 0
      || observedHighWater
        > this.state.lineage.cursor.snapshotHighWater
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_facts_high_water_invalid',
        'Facts reconciliation must bind an observed Session high-water.'
      );
    }
    this.beginMaintenance('reconcileFacts');
    try {
      await this.reconcileFactsInternal();
    } finally {
      this.endMaintenance();
    }
  }

  async finalizeReview(
    expectedPlanRevision: string
  ): Promise<SessionKernelReviewV2> {
    this.beginMaintenance('finalizeReview');
    try {
      this.requireNoPendingRequests();
      this.requireCurrentPlanRevision(expectedPlanRevision);
      this.requireAcceptedPlan();
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
      const oldInvocationId = activeInvocationId(this.state);
      if (this.state.pendingEpochInput) {
        await this.advancePendingInput(oldInvocationId);
      } else {
        await this.requests.replay('control');
      }
      await this.reconcileFactsInternal();
      await this.requests.replay('effect');
      await this.reconcileFactsInternal();
      await this.ensurePlanProjected();
      await this.ensurePlanDecisionProjected();
      for (const input of this.state.inputs) {
        await this.ensureInputProjected(input);
      }
      await this.ensurePlanActionSettlementsProjected();
      await this.ports.projection.flushPending(this.state.runId);
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
    this.state.kernelWakeHint = true;
    await this.saveCheckpoint();
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

  private async ensurePlanDecisionProjected(): Promise<void> {
    const decision = this.state.planDecision;
    if (!decision) return;
    const key = planDecisionKey(decision);
    if (this.state.projectedPlanDecisionKey === key) return;
    await this.project(
      `plan-decision:${decision.planRevision}`,
      'plan.decided',
      decision,
      decision.recordedAt
    );
    this.state.projectedPlanDecisionKey = key;
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

  private settlePlanActionCompleted(
    planActionId: string,
    completionKind: 'answer' | 'noTool',
    providerTurnId: string
  ): SessionPlanActionSettlementV2 {
    this.requireAcceptedPlan();
    sessionPlanActionV2(this.state, planActionId);
    const existing = this.state.planActionSettlements[planActionId];
    if (existing) {
      if (
        existing.kind === 'completed'
        && existing.completionKind === completionKind
        && existing.providerTurnId === providerTurnId
      ) {
        return cloneJson(existing);
      }
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_completion_conflict',
        `PlanAction ${planActionId} already has a different Session settlement.`
      );
    }
    const settlement: SessionPlanActionSettlementV2 = {
      kind: 'completed',
      planActionId,
      completionKind,
      providerTurnId,
      recordedAt: this.ports.clock.now(),
    };
    this.state.planActionSettlements[planActionId] = settlement;
    return cloneJson(settlement);
  }

  private async ensurePlanActionSettlementsProjected(): Promise<void> {
    const settlements = Object.values(
      this.state.planActionSettlements
    ).sort((left, right) =>
      left.recordedAt.localeCompare(right.recordedAt)
      || left.planActionId.localeCompare(right.planActionId)
    );
    for (const settlement of settlements) {
      await this.project(
        `plan-action:${settlement.planActionId}:${settlement.kind}`,
        settlement.kind === 'completed'
          ? 'planAction.completed'
          : 'planAction.skipped',
        settlement,
        settlement.recordedAt
      );
    }
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

  private requireAcceptedPlan(): void {
    const plan = this.state.plan;
    const decision = this.state.planDecision;
    if (
      !plan
      || !decision
      || decision.planRevision !== plan.planRevision
      || decision.decision !== 'accept'
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_acceptance_required',
        'The exact current Plan revision must be durably accepted before preview or execution.'
      );
    }
  }

  private requireCurrentPlanRevision(
    expectedPlanRevision: string
  ): void {
    if (
      !expectedPlanRevision.trim()
      || this.state.plan?.planRevision !== expectedPlanRevision
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_revision_stale',
        'Operation does not match the current persisted Plan revision.'
      );
    }
  }

  private requireExactPlanActionBinding(
    operationId: string,
    input: {
      planActionId?: string;
      expectedPlanRevision?: string;
    }
  ): void {
    if (
      Boolean(input.planActionId)
        !== Boolean(input.expectedPlanRevision)
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_binding_invalid',
        'PlanAction identity and Plan revision must be supplied together.'
      );
    }
    const actualPlanActionId =
      this.state.lineage.operations[operationId]?.planActionId;
    if (!actualPlanActionId) {
      if (input.planActionId || input.expectedPlanRevision) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_action_binding_unexpected',
          'Context-read operation cannot carry a PlanAction binding.'
        );
      }
      return;
    }
    if (
      input.planActionId !== actualPlanActionId
      || this.state.plan?.planRevision
        !== input.expectedPlanRevision
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_binding_stale',
        'Operation does not match the current PlanAction binding.'
      );
    }
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
    this.maintenanceQuiescence = new Promise((resolve) => {
      this.resolveMaintenanceQuiescence = resolve;
    });
  }

  private endMaintenance(): void {
    this.maintenanceActive = false;
    this.resolveMaintenanceQuiescence?.();
    this.resolveMaintenanceQuiescence = undefined;
    this.maintenanceQuiescence = Promise.resolve();
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

function requiredReason(value: string): string {
  if (!value.trim() || value.length > 64 * 1024) {
    throw new SessionKernelLoopError(
      'session_kernel_plan_action_skip_reason_invalid',
      'Skipped PlanAction requires a bounded non-empty reason.'
    );
  }
  return value;
}

function planDecisionKey(decision: SessionPlanDecisionV2): string {
  return JSON.stringify([
    decision.planRevision,
    decision.decision,
    decision.guidance ?? '',
  ]);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
