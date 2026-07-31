import type {
  CapabilityScopePreviewReplyV2,
  ControlEpochAdvancedReplyV2,
  InvocationCancelReplyV2,
  KernelFactProjectionV2,
} from '@deepcode/protocol';
import {
  nextSessionKernelFactsQueryV2,
  sessionKernelFactsCaughtUpV2,
} from './lineage.js';
import {
  registerSessionKernelFactBarrierV2,
  sessionKernelFactBarriersPendingV2,
} from './factBarriers.js';
import type {
  SessionKernelLoopPortsV2,
  SessionKernelProjectionReceiptV2,
  SessionKernelStoredOperationResultV2,
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
  recordSessionProviderOutcomeV2,
  recordSessionPlanDecisionV2,
  recordSessionPlanV2,
  recordSessionUserInputV2,
  restoreSessionKernelLoopStateV2,
  sessionPlanActionV2,
  type SessionKernelInitialStateV2,
  type SessionKernelLoopStateV2,
} from './state.js';
import {
  markSessionProviderToolCallQueueOutcomeRecordedV2,
  reconcileSessionProviderToolCallQueueV2,
} from './providerToolCallQueue.js';
import {
  toolContextRefV2,
} from './toolContext.js';
import type {
  SessionKernelLoopResultV2,
  SessionKernelProjectionEventV2,
  SessionKernelPublicRequestRecordV2,
  SessionKernelReviewV2,
  SessionRunCancellationV2,
  SessionNaturalLanguagePlanV2,
  SessionPlanActionSettlementV2,
  SessionPlanDecisionV2,
  SessionProviderTurnRequestV2,
  SessionUserInputRecordV2,
} from './types.js';

export interface SessionKernelRunCancelInputV2 {
  callerRequestId: string;
  callerRequestDigest: string;
  cancelOperationId: string;
}

export interface SessionKernelRunCancelResultV2 {
  callerRequestId: string;
  callerRequestDigest: string;
  cancelOperationId: string;
  controlEpoch: number;
  cancellation: InvocationCancelReplyV2;
  facts: {
    afterLedgerSequence: number;
    snapshotHighWater: number;
    runSequenceHighWater: number;
    caughtUp: true;
    pendingFactBarrierCount: 0;
  };
  projection: {
    projectionId: string;
    projectionDigest: string;
  };
}

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
  private runCancellationFence?: {
    generation: number;
    quiescence: Promise<void>;
  };
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
        project: async (projectionId, kind, data, recordedAt) => {
          await this.project(projectionId, kind, data, recordedAt);
        },
        reconcileFacts: () => this.reconcileFactsInternal(),
        settleProviderToolCallQueue: () =>
          this.settleProviderToolCallQueue(),
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
          this.authorityTransitionActive
          || this.maintenanceActive
          || this.pendingUserInputFences.size > 0
          || Boolean(this.runCancellationFence),
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
      ? restoreSessionKernelLoopStateV2(checkpoint, {
          runId: initial.runId,
          workspaceBindingDigest: initial.workspaceBindingDigest,
          sessionMemory: initial.sessionMemory,
          providerProfile: initial.providerProfile,
        })
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

  loadOperationResult(
    operationRequestId: string
  ): Promise<SessionKernelStoredOperationResultV2 | undefined> {
    return this.ports.persistence.loadOperationResult(
      operationRequestId
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
      const scopePreviews = this.state.plan?.actions.flatMap(
        (planAction) => {
          const preview =
            this.state.previews[planAction.manifest.operationId];
          return preview ? [preview] : [];
        }
      ) ?? [];
      const projectionData = {
        ...reply,
        plan: this.state.plan,
        scopePreviews,
        planRevision: action.manifest.planRevision,
        planActionId: action.manifest.planActionId,
        operationId: action.manifest.operationId,
      };
      if (reply.kind === 'previewed') {
        await this.project(
          `scope:${reply.data.preview.previewId}`,
          'scope.previewed',
          projectionData
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
          projectionData
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
    if (this.state.runCancellation) {
      throw new SessionKernelLoopError(
        'session_kernel_run_cancelled',
        'A cancelled Session Run cannot start another Provider turn.'
      );
    }
    if (request.target.kind === 'planAction') {
      this.requireAcceptedPlan();
    }
    return this.providers.run(request);
  }

  async resumePendingProviderToolCalls():
  Promise<SessionKernelLoopResultV2 | undefined> {
    if (this.state.runCancellation) return undefined;
    return this.providers.resumePendingToolCalls();
  }

  async handleUserInput(
    input: SessionUserInputRecordV2,
    nextTurn: SessionProviderTurnRequestV2
  ): Promise<SessionKernelLoopResultV2> {
    this.requireRunAcceptsUserInput();
    const generation =
      await this.persistUserInputBeforeFence(input);
    await this.applyFencedUserInput(input, generation);
    return this.runProviderTurn(nextTurn);
  }

  async cancelRun(
    input: SessionKernelRunCancelInputV2
  ): Promise<SessionKernelRunCancelResultV2> {
    validateRunCancelInput(input);
    const prior = this.state.runCancellation;
    if (prior) {
      requireExactRunCancellation(prior, input);
      if (prior.status === 'projected') {
        await this.ports.projection.flushPending(this.state.runId);
        return completedRunCancellation(prior, this.state.controlEpoch);
      }
    }
    const fence = this.fenceForRunCancellation();
    let transitionStarted = false;
    try {
      await fence.quiescence;
      this.beginAuthorityTransition();
      transitionStarted = true;
      if (!this.state.runCancellation) {
        this.state.runCancellation = {
          ...cloneJson(input),
          requestedAt: this.ports.clock.now(),
          status: 'requested',
        };
        await this.saveCheckpoint();
      }
      await this.settleProviderToolCallQueue();
      let cancellation = currentRunCancellation(this.state, input);

      await this.requests.replay('control');
      cancellation = currentRunCancellation(this.state, input);

      if (!cancellation.cancellation) {
        let request: SessionKernelPublicRequestRecordV2;
        if (cancellation.invocationCancelRequestId) {
          request = {
            requestId: cancellation.invocationCancelRequestId,
            lane: 'control',
            intent: {
              kind: 'invocationCancel',
              payload: {
                expectedControlEpoch: this.state.controlEpoch,
                target: { kind: 'currentForRun', data: {} },
                reasonCode: 'userRequested',
                reason: 'The trusted user requested this Session Run to stop.',
              },
            },
            startedAt: cancellation.requestedAt,
            attemptCount: 1,
          };
        } else {
          request = this.requests.newRecord({
            kind: 'invocationCancel',
            payload: {
              expectedControlEpoch: this.state.controlEpoch,
              target: { kind: 'currentForRun', data: {} },
              reasonCode: 'userRequested',
              reason: 'The trusted user requested this Session Run to stop.',
            },
          });
          cancellation.invocationCancelRequestId = request.requestId;
          await this.saveCheckpoint();
        }
        expectSessionKernelPublicRequestOutcomeV2(
          await this.requests.execute(request),
          'invocationCancel'
        );
      }
      cancellation = currentRunCancellation(this.state, input);
      if (!cancellation.cancellation) {
        throw new SessionKernelLoopError(
          'session_kernel_run_cancellation_reply_missing',
          'Kernel cancellation settled without a durable correlated reply.'
        );
      }
      await this.requests.replay('query');
      cancellation = currentRunCancellation(this.state, input);
      if (!cancellation.cancellation) {
        throw new SessionKernelLoopError(
          'session_kernel_run_cancellation_reply_missing',
          'Kernel cancellation reply disappeared during query reconciliation.'
        );
      }
      if (this.requests.pending('effect')) {
        throw new SessionKernelLoopError(
          'session_kernel_run_cancellation_effect_indeterminate',
          'A pending mutation has no safe no-effect proof; Run cancellation remains indeterminate and must not replay that mutation.'
        );
      }

      await this.proveRunCancellationFacts(cancellation.cancellation);
      cancellation = currentRunCancellation(this.state, input);
      if (cancellation.status !== 'factsReconciled') {
        cancellation.facts = cancellationFacts(this.state);
        cancellation.cancelledAt = this.ports.clock.now();
        cancellation.status = 'factsReconciled';
        await this.saveCheckpoint();
      }
      const event = this.event(
        `cancel:${cancellation.cancelOperationId}:settled`,
        'run.cancelled',
        {
          callerRequestId: cancellation.callerRequestId,
          callerRequestDigest: cancellation.callerRequestDigest,
          cancelOperationId: cancellation.cancelOperationId,
          controlEpoch: this.state.controlEpoch,
          cancellation: cancellation.cancellation,
          facts: cancellation.facts,
        },
        cancellation.cancelledAt
      );
      const projection = await this.ports.projection.project(event);
      if (
        !projection.delivered
        || projection.projectionId !== event.projectionId
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_run_cancellation_projection_unconfirmed',
          'Session Run cancellation projection was not durably acknowledged by Host.'
        );
      }
      cancellation = currentRunCancellation(this.state, input);
      cancellation.projection = {
        projectionId: projection.projectionId,
        projectionDigest: projection.projectionDigest,
      };
      cancellation.status = 'projected';
      await this.saveCheckpoint();
      return completedRunCancellation(
        cancellation,
        this.state.controlEpoch
      );
    } finally {
      this.providers.releaseUserInputFence(fence.generation);
      if (this.runCancellationFence === fence) {
        this.runCancellationFence = undefined;
      }
      if (transitionStarted) {
        this.authorityTransitionActive = false;
      }
    }
  }

  private fenceForRunCancellation(): {
    generation: number;
    quiescence: Promise<void>;
  } {
    if (this.runCancellationFence) {
      return this.runCancellationFence;
    }
    if (this.pendingUserInputFences.size > 0) {
      throw new SessionKernelLoopError(
        'session_kernel_run_cancellation_transition_busy',
        'Session Run cancellation must serialize after the current user-input transition.'
      );
    }
    const providerFence =
      this.providers.supersedeForRunCancellation();
    this.runCancellationFence = {
      generation: providerFence.generation,
      quiescence: Promise.all([
        providerFence.quiescence,
        this.requests.supersedeForRunCancellation(),
        this.maintenanceQuiescence,
      ]).then(() => undefined),
    };
    return this.runCancellationFence;
  }

  private async proveRunCancellationFacts(
    reply: InvocationCancelReplyV2
  ): Promise<void> {
    await this.drainCancellationFacts();
    const requiredFactId = reply.kind === 'alreadyTerminal'
      ? reply.data.terminalFactId
      : reply.kind === 'requested'
        || reply.kind === 'alreadyRequested'
        ? reply.data.factId
        : undefined;
    if (requiredFactId) {
      const requestId = this.state.runCancellation
        ?.invocationCancelRequestId;
      if (!requestId) {
        throw new SessionKernelLoopError(
          'session_kernel_run_cancellation_request_missing',
          'Session Run cancellation fact proof has no request identity.'
        );
      }
      registerSessionKernelFactBarrierV2(this.state, {
        requestId,
        source: 'invocationCancel',
        minimumHighWater: Math.max(
          1,
          this.state.runCancellation?.facts?.snapshotHighWater
            ?? this.state.lineage.cursor.snapshotHighWater
        ),
        requiredFactIds: [requiredFactId],
      });
      await this.saveCheckpoint();
      await this.drainCancellationFacts();
    }
    if (
      !sessionKernelFactsCaughtUpV2(this.state.lineage)
      || sessionKernelFactBarriersPendingV2(this.state)
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_run_cancellation_facts_unsettled',
        'Session Run cancellation cannot settle before canonical Kernel facts and exact barriers converge.'
      );
    }
  }

  private async drainCancellationFacts(): Promise<void> {
    let previousAfter = -1;
    for (;;) {
      await this.reconcileFactsInternal();
      if (
        sessionKernelFactsCaughtUpV2(this.state.lineage)
        && !sessionKernelFactBarriersPendingV2(this.state)
      ) {
        return;
      }
      const after = this.state.lineage.cursor.afterLedgerSequence;
      if (after <= previousAfter) {
        throw new SessionKernelLoopError(
          'session_kernel_run_cancellation_facts_stalled',
          'Canonical Kernel facts made no progress while settling Session Run cancellation.'
        );
      }
      previousAfter = after;
    }
  }

  /**
   * Persists the immutable user input before changing any local authority or
   * cancelling in-flight work. Once persistence succeeds, the synchronous
   * fence prevents later Provider output from crossing the new-input
   * boundary while the epoch transition is made durable.
   */
  async persistUserInputBeforeFence(
    input: SessionUserInputRecordV2
  ): Promise<number> {
    this.requireRunAcceptsUserInput();
    this.requireNoPendingUserInputTransition();
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
    return this.fenceProviderForUserInput();
  }

  /**
   * Establishes the local Provider/output fence synchronously. The returned
   * generation carries a quiescence barrier for local preparing/applying
   * commits; an already-durable transport attempt is detached and can only be
   * recovered with its exact persisted identity after the epoch advances.
   */
  fenceProviderForUserInput(): number {
    this.requireRunAcceptsUserInput();
    this.requireNoPendingUserInputTransition();
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
    let liveFence = false;
    let transitionCompleted = false;
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
      liveFence = true;
      await quiescence;
      this.requireRunAcceptsUserInput();
      this.beginAuthorityTransition();
      transitionStarted = true;
      const oldInvocationId = activeInvocationId(this.state);
      this.state = recordSessionUserInputV2(this.state, input);
      await this.saveCheckpoint();
      await this.settleProviderToolCallQueue();

      await this.advancePendingInput(oldInvocationId);
      await this.ensureInputProjected(input);
      if (!this.state.runCancellation) {
        await this.requests.replay('effect');
      }
      await this.reconcileFactsInternal();
      transitionCompleted = true;
    } finally {
      if (liveFence && transitionCompleted) {
        this.providers.releaseUserInputFence(generation);
        this.userInputQuiescence.delete(generation);
        this.pendingUserInputFences.delete(generation);
      }
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
      || Boolean(this.state.runCancellation)
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
      if (
        this.state.review?.status === 'final'
        && JSON.stringify(this.state.review)
          === JSON.stringify(review)
      ) {
        return cloneJson(review);
      }
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
    let recovered = false;
    this.beginMaintenance('recover', true);
    try {
      if (this.state.runCancellation?.status === 'projected') {
        this.requireNoPendingRequests();
        await this.ports.projection.flushPending(this.state.runId);
        recovered = true;
        return;
      }
      const oldInvocationId = activeInvocationId(this.state);
      if (this.state.pendingEpochInput) {
        await this.advancePendingInput(oldInvocationId);
      } else {
        await this.requests.replay('control');
      }
      for (const input of this.state.inputs) {
        await this.ensureInputProjected(input);
      }
      if (!this.state.runCancellation) {
        await this.requests.replay('effect');
      }
      await this.reconcileFactsInternal();
      await this.ensurePlanProjected();
      await this.ensurePlanDecisionProjected();
      await this.ensurePlanActionSettlementsProjected();
      await this.ports.projection.flushPending(this.state.runId);
      recovered = true;
    } finally {
      if (recovered) {
        for (const generation of this.pendingUserInputFences) {
          this.providers.releaseUserInputFence(generation);
        }
        this.pendingUserInputFences.clear();
        this.userInputQuiescence.clear();
      }
      this.endMaintenance();
    }
  }

  private async advancePendingInput(
    oldInvocationId?: string
  ): Promise<void> {
    const replayed = await this.requests.replay('control');
    if (replayed?.kind === 'controlEpochAdvance') {
      await this.ensureEpochCancellation(
        replayed.reply,
        oldInvocationId
      );
    }
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
    await this.ensureEpochCancellation(reply, oldInvocationId);
  }

  private async ensureEpochCancellation(
    reply: ControlEpochAdvancedReplyV2,
    oldInvocationId?: string
  ): Promise<void> {
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
    const replayed = await this.requests.replay('query');
    if (replayed?.kind === 'factsQuery') {
      await this.settleProviderToolCallQueue(replayed.reply.facts);
    }
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
      await this.settleProviderToolCallQueue(page.facts);
      if (!page.hasMore) {
        return;
      }
    }
    this.state.kernelWakeHint = true;
    await this.saveCheckpoint();
  }

  private async settleProviderToolCallQueue(
    observedFacts: readonly KernelFactProjectionV2[] = []
  ): Promise<void> {
    const reconciliation = reconcileSessionProviderToolCallQueueV2(
      this.state,
      this.ports.clock.now(),
      observedFacts
    );
    const queue = this.state.providerToolCallQueue;
    if (!queue) return;
    if (reconciliation.changed) {
      await this.saveCheckpoint();
    }
    if (queue.status === 'active' || queue.outcomeRecorded) return;

    if (
      queue.status === 'aborted'
      && queue.abortReason !== 'userInput'
      && queue.abortReason !== 'runCancelled'
      && queue.abortReason !== 'capabilityDenied'
    ) {
      const guidance = [
        'The ordered Provider tool-call sequence stopped after',
        queue.abortReason ?? 'an execution failure',
        `(${queue.calls.filter((call) =>
          call.status === 'unexecuted'
        ).length} queued call(s) were not executed).`,
      ].join(' ');
      if (!this.state.pendingGuidance.includes(guidance)) {
        this.state.pendingGuidance.push(guidance);
      }
    }
    const outcome = {
      providerTurnId: queue.providerTurnId,
      outputKind: 'toolIntent',
      recordedAt: queue.settledAt ?? this.ports.clock.now(),
      summary: queue.status === 'completed'
        ? `Completed ${queue.calls.length} ordered Provider tool call(s).`
        : [
            'Aborted ordered Provider tool calls:',
            queue.abortReason ?? 'unknown',
            `unexecuted=${queue.calls.filter((call) =>
              call.status === 'unexecuted'
            ).length}`,
          ].join(' '),
      toolCallReceipt: cloneJson(queue.receipt),
      providerResult: cloneJson(queue.providerResult),
    } as const;
    if (queue.status === 'completed') {
      await this.project(
        `provider:${queue.providerTurnId}:completed`,
        'provider.completed',
        {
          providerTurnId: queue.providerTurnId,
          controlEpoch: queue.controlEpoch,
          outputKind: 'toolIntent',
          result: {
            kind: 'orderedToolCallsCompleted',
            callCount: queue.calls.length,
          },
          toolCallReceipt: queue.receipt,
          providerOutcome: queue.providerResult,
        },
        queue.settledAt
      );
    } else {
      await this.project(
        `provider:${queue.providerTurnId}:tool-calls-aborted`,
        'diagnostic',
        {
          providerTurnId: queue.providerTurnId,
          status: 'blocked',
          code: 'session_kernel_provider_tool_calls_aborted',
          stage: 'provider.toolCallQueue',
          reason: queue.abortReason,
          unexecutedOrdinals: queue.calls
            .filter((call) => call.status === 'unexecuted')
            .map((call) => call.ordinal),
          toolCallReceipt: queue.receipt,
        },
        queue.settledAt
      );
    }
    const previousOutcomes = cloneJson(this.state.providerOutcomes);
    const previousOmittedCount =
      this.state.providerOutcomeHistoryOmittedCount;
    try {
      recordSessionProviderOutcomeV2(this.state, outcome);
      markSessionProviderToolCallQueueOutcomeRecordedV2(this.state);
      await this.saveCheckpoint();
    } catch (error) {
      this.state.providerOutcomes = previousOutcomes;
      this.state.providerOutcomeHistoryOmittedCount =
        previousOmittedCount;
      queue.outcomeRecorded = false;
      throw error;
    }
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
      this.state.kernelWakeHint
      || !sessionKernelFactsCaughtUpV2(this.state.lineage)
      || sessionKernelFactBarriersPendingV2(this.state)
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_change_facts_pending',
        'Plan cannot change before exact Kernel command facts are reconciled.'
      );
    }
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
        `plan-action:${settlement.planActionId}:completed`,
        'planAction.completed',
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
      {
        ...input,
        controlEpoch: this.state.controlEpoch,
      },
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

  private requireRunAcceptsUserInput(): void {
    if (this.state.runCancellation) {
      throw new SessionKernelLoopError(
        'session_kernel_run_cancelled',
        'A cancelled Session Run cannot accept another user input.'
      );
    }
  }

  private beginMaintenance(
    operation: string,
    allowPendingUserInputRecovery = false
  ): void {
    if (
      this.authorityTransitionActive
      || this.maintenanceActive
      || this.providers.isReserved()
      || Boolean(this.runCancellationFence)
      || (
        Boolean(this.state.runCancellation)
        && operation !== 'recover'
      )
      || (
        this.pendingUserInputFences.size > 0
        && !allowPendingUserInputRecovery
      )
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

  private requireNoPendingUserInputTransition(): void {
    if (this.pendingUserInputFences.size > 0) {
      throw new SessionKernelLoopError(
        'session_kernel_user_input_recovery_required',
        'The prior persisted user input transition must recover before another input can be fenced.'
      );
    }
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
  ): Promise<SessionKernelProjectionReceiptV2> {
    return this.ports.projection.project(
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
      projectionId: [
        'run',
        this.state.runId,
        projectionId,
      ].join(':'),
      runId: this.state.runId,
      recordedAt: recordedAt ?? this.ports.clock.now(),
      kind,
      data: data === undefined ? null : data,
    };
  }
}

function validateRunCancelInput(
  input: SessionKernelRunCancelInputV2
): void {
  for (const [field, value] of [
    ['callerRequestId', input.callerRequestId],
    ['cancelOperationId', input.cancelOperationId],
  ] as const) {
    if (
      !value
      || value.trim() !== value
      || new TextEncoder().encode(value).byteLength > 512
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_run_cancellation_identity_invalid',
        `${field} is not a bounded exact identity.`
      );
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.callerRequestDigest)) {
    throw new SessionKernelLoopError(
      'session_kernel_run_cancellation_digest_invalid',
      'callerRequestDigest is not a canonical SHA-256 digest.'
    );
  }
}

function requireExactRunCancellation(
  cancellation: SessionRunCancellationV2,
  input: SessionKernelRunCancelInputV2
): void {
  if (
    cancellation.callerRequestId !== input.callerRequestId
    || cancellation.callerRequestDigest !== input.callerRequestDigest
    || cancellation.cancelOperationId !== input.cancelOperationId
  ) {
    throw new SessionKernelLoopError(
      'session_kernel_run_cancellation_identity_conflict',
      'Session Run cancellation is already bound to another caller or operation.'
    );
  }
}

function currentRunCancellation(
  state: SessionKernelLoopStateV2,
  input: SessionKernelRunCancelInputV2
): SessionRunCancellationV2 {
  const cancellation = state.runCancellation;
  if (!cancellation) {
    throw new SessionKernelLoopError(
      'session_kernel_run_cancellation_missing',
      'The durable Session Run cancellation disappeared during reconciliation.'
    );
  }
  requireExactRunCancellation(cancellation, input);
  return cancellation;
}

function cancellationFacts(
  state: SessionKernelLoopStateV2
): SessionKernelRunCancelResultV2['facts'] {
  if (
    !sessionKernelFactsCaughtUpV2(state.lineage)
    || sessionKernelFactBarriersPendingV2(state)
  ) {
    throw new SessionKernelLoopError(
      'session_kernel_run_cancellation_facts_unsettled',
      'Session Run cancellation facts are not canonical and caught up.'
    );
  }
  return {
    afterLedgerSequence: state.lineage.cursor.afterLedgerSequence,
    snapshotHighWater: state.lineage.cursor.snapshotHighWater,
    runSequenceHighWater: state.lineage.factCount,
    caughtUp: true,
    pendingFactBarrierCount: 0,
  };
}

function completedRunCancellation(
  cancellation: SessionRunCancellationV2,
  controlEpoch: number
): SessionKernelRunCancelResultV2 {
  if (
    cancellation.status !== 'projected'
    || !cancellation.cancellation
    || !cancellation.facts
    || !cancellation.projection
  ) {
    throw new SessionKernelLoopError(
      'session_kernel_run_cancellation_incomplete',
      'Session Run cancellation has not reached its durable terminal projection.'
    );
  }
  return {
    callerRequestId: cancellation.callerRequestId,
    callerRequestDigest: cancellation.callerRequestDigest,
    cancelOperationId: cancellation.cancelOperationId,
    controlEpoch,
    cancellation: cloneJson(cancellation.cancellation),
    facts: cloneJson(cancellation.facts),
    projection: cloneJson(cancellation.projection),
  };
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
