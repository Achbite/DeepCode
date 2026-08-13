import type {
  CapabilityScopePreviewBatchReplyV2,
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
import {
  SessionKernelProjectionDeliveryErrorV2,
} from './ports.js';
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
  recordSessionKernelReviewV2,
} from './review.js';
import {
  checkpointSessionKernelStateV2,
  buildSessionPlanConfirmationAuthorityV2,
  cloneSessionKernelLoopStateV2,
  createSessionKernelLoopStateV2,
  currentSessionPlanScopePreviewsV2,
  currentSessionPlanConfirmationAuthorityV2,
  currentSessionWorkAuthorityV3,
  recordSessionPlanConfirmationAuthorityV2,
  recordSessionProviderOutcomeV2,
  recordSessionPlanDecisionV2,
  recordSessionPlanV2,
  recordSessionUserInputV2,
  restoreSessionKernelLoopStateV2,
  sameSessionWorkAuthorityV3,
  sessionInterventionEvidenceProgressDigestV4,
  sessionUserInterventionCandidateSetDigestV4,
  sessionPlanActionV2,
  type SessionKernelInitialStateV2,
  type SessionKernelLoopStateV2,
} from './state.js';
import {
  markSessionProviderToolCallQueueOutcomeRecordedV2,
  publicSessionProviderOrderedItemsV2,
  publicSessionProviderToolCallQueueItemsV2,
  reconcileSessionProviderToolCallQueueV2,
  settledSessionProviderToolCallsV2,
} from './providerToolCallQueue.js';
import {
  toolContextRefV2,
} from './toolContext.js';
import type {
  SessionKernelLoopResultV2,
  SessionKernelProjectionEventV2,
  SessionKernelPublicRequestRecordV2,
  SessionKernelReviewV2,
  SessionInterventionResearchV4,
  SessionRunCancellationV2,
  SessionNaturalLanguagePlanV2,
  SessionPlanConfirmationAuthorityV2,
  SessionPlanActionSettlementV2,
  SessionPlanDecisionV2,
  SessionProviderTurnRequestV2,
  SessionUserInputRecordV2,
  SessionUserInterventionDecisionResultV4,
  SessionUserInterventionDecisionV4,
  SessionWorkAuthorityV3,
} from './types.js';
import type {
  SessionProviderInterventionProposalV1,
} from './SessionKernelProviderAdapterV2.js';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';

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

export interface SessionPlanConfirmationReadyResultV2 {
  planRevision: string;
  providerTurnId: string;
  recordedAt: string;
  commentaryProjection?: SessionKernelProjectionReceiptV2;
  confirmationProjection: SessionKernelProjectionReceiptV2;
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
          return this.project(projectionId, kind, data, recordedAt);
        },
        reconcileFacts: () => this.reconcileFactsInternal(),
        settleProviderToolCallQueue: () =>
          this.settleProviderToolCallQueue(),
        recordProviderPlan: (plan) =>
          this.persistPlan(plan),
        recordProviderIntervention: (proposal, providerTurnId, recordedAt) =>
          this.persistProviderIntervention(
            proposal,
            providerTurnId,
            recordedAt
          ),
        settlePlanActionComplete: (
          planActionId,
          outcome,
          providerTurnId,
          controlCallId,
          controlArgumentsDigest,
          recordedAt
        ) => this.settlePlanActionComplete(
          planActionId,
          outcome,
          providerTurnId,
          controlCallId,
          controlArgumentsDigest,
          recordedAt
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
      ports.persistence.loadCheckpoint(initial.runId, {
        workspaceBindingDigest: initial.workspaceBindingDigest,
        sessionMemory: initial.sessionMemory,
        providerProfile: initial.providerProfile,
        toolContext: initial.toolContext,
      }),
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
      if (!currentSessionPlanConfirmationAuthorityV2(this.state)) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_confirmation_required',
          'The exact current Plan confirmation boundary must be durably published before a trusted decision.'
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

  async previewPlan(
    expectedPlanRevision: string
  ): Promise<CapabilityScopePreviewBatchReplyV2> {
    this.beginMaintenance('previewPlan');
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
      const plan = this.state.plan!;
      const existingPreviews = currentSessionPlanScopePreviewsV2(
        this.state,
        plan,
        { requireComplete: false }
      );
      if (
        existingPreviews.length > 0
        && existingPreviews.length !== plan.actions.length
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_scope_preview_batch_incomplete',
          'The current Plan contains a partial scope preview batch.'
        );
      }
      const reply: CapabilityScopePreviewBatchReplyV2 =
        existingPreviews.length === plan.actions.length
          ? {
              runId: this.state.runId,
              acceptedControlEpoch: this.state.controlEpoch,
              planRevision: plan.planRevision,
              results: existingPreviews.map((preview) => ({
                kind: 'previewed' as const,
                data: { preview: cloneJson(preview) },
              })),
            }
          : expectSessionKernelPublicRequestOutcomeV2(
              await this.requests.execute(
                this.requests.newRecord({
                  kind: 'capabilityPreviewBatch',
                  payload: {
                    expectedControlEpoch: this.state.controlEpoch,
                    planRevision: plan.planRevision,
                    items: plan.actions.map((action) => ({
                      planActionId: action.manifest.planActionId,
                      operationId: action.manifest.operationId,
                      idempotencyKey: action.idempotencyKey,
                      toolId: action.manifest.toolId,
                      scopeIntent: cloneJson(action.manifest.scopeIntent),
                      deadline: cloneJson(action.deadline),
                      origin: { kind: 'plan', data: {} },
                    })),
                    toolContextRef: toolContextRefV2(
                      this.state.toolContext.bundle
                    ),
                  },
                })
              ),
              'capabilityPreviewBatch'
            ).reply;
      const scopePreviews = currentSessionPlanScopePreviewsV2(
        this.state,
        plan,
        { requireComplete: false }
      );
      for (const result of reply.results) {
        const correlation = result.kind === 'previewed'
          ? result.data.preview
          : result.data;
        const projectionData = {
          ...result,
          plan: cloneJson(plan),
          scopePreviews,
          planRevision: plan.planRevision,
          planActionId: correlation.planActionId,
          operationId: correlation.operationId,
        };
        await this.project(
          result.kind === 'previewed'
            ? `scope:${result.data.preview.previewId}`
            : [
                'scope',
                plan.planRevision,
                result.data.planActionId,
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

  async decideUserIntervention(input: {
    interactionId: string;
    interactionRevision: string;
    candidateSetDigest: string;
    decision: 'select' | 'revise' | 'reject';
    optionId?: string;
    guidance?: string;
    callerRequestId: string;
  }): Promise<SessionUserInterventionDecisionResultV4> {
    this.beginMaintenance('decideUserIntervention');
    try {
      this.requireNoPendingRequests();
      const intervention = this.state.userIntervention;
      const wait = this.state.activeWait;
      if (
        !intervention
        || !wait
        || wait.kind !== 'userIntervention'
        || intervention.interactionId !== input.interactionId
        || intervention.interactionRevision !== input.interactionRevision
        || intervention.candidateSetDigest !== input.candidateSetDigest
        || wait.interactionId !== input.interactionId
        || wait.interactionRevision !== input.interactionRevision
        || wait.candidateSetDigest !== input.candidateSetDigest
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_user_intervention_stale',
          'User intervention decision does not bind the exact active card and wait.'
        );
      }
      const guidance = input.guidance?.trim();
      if (
        !input.callerRequestId.trim()
        || (input.decision === 'select') !== Boolean(input.optionId)
        || (input.decision === 'revise' && !guidance)
        || (input.decision !== 'select' && input.optionId !== undefined)
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_user_intervention_decision_invalid',
          'User intervention select, revise, and reject require their exact closed decision fields.'
        );
      }
      const selectedOption = input.optionId
        ? intervention.options.find(
            (option) => option.optionId === input.optionId
          )
        : undefined;
      if (input.decision === 'select' && !selectedOption) {
        throw new SessionKernelLoopError(
          'session_kernel_user_intervention_option_stale',
          'Selected intervention option is not part of the exact active candidate set.'
        );
      }
      const requestedDecision = {
        interactionId: input.interactionId,
        interactionRevision: input.interactionRevision,
        candidateSetDigest: input.candidateSetDigest,
        decision: input.decision,
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(guidance ? { guidance } : {}),
        callerRequestId: input.callerRequestId,
      };
      let decision = this.state.userInterventionDecision;
      if (decision) {
        const { recordedAt: _recordedAt, ...durableRequest } = decision;
        if (canonicalJson(durableRequest) !== canonicalJson(requestedDecision)) {
          throw new SessionKernelLoopError(
            'session_kernel_user_intervention_decision_conflict',
            'The intervention interaction already has a different durable user decision.'
          );
        }
      } else {
        decision = {
          ...requestedDecision,
          recordedAt: this.ports.clock.now(),
        };
        this.state.userInterventionDecision = cloneJson(decision);
      }

      if (input.decision === 'select' && selectedOption?.kind === 'executable') {
        await this.reconcileFactsInternal();
        requireInterventionSelectionFactsV4(
          this.state,
          intervention,
          selectedOption.optionId
        );
        const candidatePlan = selectedOption.candidatePlan;
        if (!candidatePlan) {
          throw new SessionKernelLoopError(
            'session_kernel_user_intervention_candidate_plan_missing',
            'Executable intervention selection lost its final candidate Plan.'
          );
        }
        const planDecision: SessionPlanDecisionV2 = {
          planRevision: candidatePlan.planRevision,
          decision: 'accept',
          recordedAt: decision.recordedAt,
        };
        await this.ports.persistence.persistPlan(candidatePlan);
        await this.ports.persistence.persistPlanDecision(planDecision);
        this.state = recordSessionPlanV2(this.state, candidatePlan);
        this.state.userInterventionDecision = cloneJson(decision);
        this.state.planDecision = planDecision;
        this.state.activeWait = undefined;
        this.state.projectedPlanRevision = undefined;
        this.state.projectedPlanDecisionKey = undefined;
        await this.saveCheckpoint();
        await this.ensurePlanProjected();
        await this.ensurePlanDecisionProjected();
        await this.project(
          `user-intervention:${input.interactionId}:${input.interactionRevision}:selected`,
          'userIntervention.changed',
          {
            state: 'accepted',
            intervention: cloneJson(intervention),
            decision: cloneJson(decision),
            acceptedPlanRevision: candidatePlan.planRevision,
          },
          decision.recordedAt
        );
        return {
          decision: cloneJson(decision),
          disposition: 'planAccepted',
          planRevision: candidatePlan.planRevision,
        };
      }

      this.state.activeWait = undefined;
      if (input.decision === 'revise') {
        const research = this.state.interventionResearch;
        if (!research) {
          throw new SessionKernelLoopError(
            'session_kernel_intervention_research_missing',
            'Intervention revision requires its durable research record.'
          );
        }
        research.guidanceRevision += 1;
        research.updatedAt = decision.recordedAt;
        this.state.userIntervention = undefined;
        this.state.pendingGuidance = unique([
          ...this.state.pendingGuidance,
          guidance!,
        ]);
      } else if (
        input.decision === 'select'
        && selectedOption?.kind === 'guidanceOnly'
      ) {
        this.state.userIntervention = undefined;
        this.state.pendingGuidance = unique([
          ...this.state.pendingGuidance,
          [
            `The user selected guidance-only intervention option ${selectedOption.optionId}: ${selectedOption.description}`,
            guidance,
          ].filter(Boolean).join(' '),
        ]);
        this.state.interventionResearch = undefined;
        this.state.userInterventionDecision = undefined;
      }
      await this.saveCheckpoint();
      await this.project(
        `user-intervention:${input.interactionId}:${input.interactionRevision}:${input.decision}`,
        'userIntervention.changed',
        {
          state: input.decision === 'reject'
            ? 'rejected'
            : input.decision === 'revise'
              ? 'needsRevision'
              : 'guidanceReplan',
          intervention: cloneJson(intervention),
          decision: cloneJson(decision),
        },
        decision.recordedAt
      );
      return {
        decision: cloneJson(decision),
        disposition: input.decision === 'reject'
          ? 'runCancellationRequired'
          : input.decision === 'revise'
            ? 'researchRevision'
            : 'guidanceReplan',
      };
    } finally {
      this.endMaintenance();
    }
  }

  private async persistProviderIntervention(
    proposal: SessionProviderInterventionProposalV1,
    providerTurnId: string,
    recordedAt: string
  ): Promise<{ published: boolean; guidance?: string }> {
    const research = this.state.interventionResearch;
    if (
      !research
      || this.state.providerTurn?.providerTurnId !== providerTurnId
      || this.state.providerTurn.target.kind !== 'interventionResearch'
      || this.state.providerTurn.target.researchId !== research.researchId
      || research.runId !== this.state.runId
      || research.inputId !== this.state.currentInputId
      || research.controlEpoch !== this.state.controlEpoch
      || this.state.activeWait
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_intervention_research_binding_invalid',
        'Provider intervention proposal is not bound to the active intervention research state.'
      );
    }
    const canonicalProposal: SessionProviderInterventionProposalV1 = {
      ...cloneJson(proposal),
      options: proposal.options.map((option) => ({
        ...cloneJson(option),
        ...(option.candidatePlan
          ? {
              candidatePlan: carrySettledPlanActionsV4(
                this.state,
                option.candidatePlan
              ),
            }
          : {}),
      })),
    };
    const exactFactIds = new Set(Object.keys(this.state.factsById));
    if (canonicalProposal.relevantFactRefs.some(
      (factId) => !exactFactIds.has(factId)
    )) {
      throw new SessionKernelLoopError(
        'session_kernel_intervention_fact_ref_stale',
        'Provider intervention references a fact outside the exact current Session snapshot.'
      );
    }
    const unsettledPlanActionIds = new Set(
      (this.state.plan?.actions ?? [])
        .filter((action) =>
          !this.state.planActionSettlements[action.manifest.planActionId]
        )
        .map((action) => action.manifest.planActionId)
    );
    if (
      canonicalProposal.affectedPlanActionIds.some(
        (planActionId) => !unsettledPlanActionIds.has(planActionId)
      )
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_intervention_affected_action_stale',
        'Provider intervention references a settled or non-current PlanAction.'
      );
    }
    const candidateSetDigest =
      sessionUserInterventionCandidateSetDigestV4({
        researchId: research.researchId,
        evidenceProgressDigest: research.evidenceProgressDigest,
        guidanceRevision: research.guidanceRevision,
        problemSummary: canonicalProposal.problemSummary,
        ...(canonicalProposal.recommendation
          ? { recommendation: canonicalProposal.recommendation }
          : {}),
        relevantFactRefs: canonicalProposal.relevantFactRefs,
        affectedPlanActionIds:
          canonicalProposal.affectedPlanActionIds,
        options: canonicalProposal.options,
      });
    const identityDigest = candidateSetDigest.slice('sha256:'.length);
    const interactionId = `user-intervention-${research.researchId}`;
    const interactionRevision = `intervention-revision-${identityDigest}`;
    if (this.state.userIntervention) {
      if (
        this.state.userIntervention.interactionId === interactionId
        && this.state.userIntervention.candidateSetDigest === candidateSetDigest
      ) {
        return { published: false };
      }
      throw new SessionKernelLoopError(
        'session_kernel_intervention_duplicate_without_guidance',
        'A different intervention card is already active for this research identity.'
      );
    }
    if (research.lastCandidateSetDigest === candidateSetDigest) {
      throw new SessionKernelLoopError(
        'session_kernel_intervention_no_progress',
        'Intervention research repeated the same canonical candidate set without new facts or user guidance; it must request clarification or report a blocked state instead of reopening the same choice.'
      );
    }
    const contextRef = toolContextRefV2(this.state.toolContext.bundle);
    const options = [];
    for (const option of canonicalProposal.options) {
      if (option.kind === 'guidanceOnly') {
        options.push({
          ...option,
          actions: [],
        });
        continue;
      }
      const plan = option.candidatePlan;
      if (!plan || plan.actions.length === 0) {
        throw new SessionKernelLoopError(
          'session_kernel_intervention_candidate_plan_missing',
          'Executable intervention option lacks one non-empty candidate Plan.'
        );
      }
      const outcome = expectSessionKernelPublicRequestOutcomeV2(
        await this.requests.execute(this.requests.newRecord({
          kind: 'capabilityPreviewBatch',
          payload: {
            expectedControlEpoch: this.state.controlEpoch,
            planRevision: plan.planRevision,
            items: plan.actions.map((action) => ({
              planActionId: action.manifest.planActionId,
              operationId: action.manifest.operationId,
              idempotencyKey: action.idempotencyKey,
              toolId: action.manifest.toolId,
              scopeIntent: cloneJson(action.manifest.scopeIntent),
              deadline: cloneJson(action.deadline),
              origin: {
                kind: 'interventionCandidate' as const,
                data: {
                  interactionId,
                  interactionRevision,
                  candidateSetDigest,
                  optionId: option.optionId,
                },
              },
            })),
            toolContextRef: contextRef,
          },
        })),
        'capabilityPreviewBatch'
      );
      const rejection = outcome.reply.results.find(
        (result) => result.kind === 'rejected'
      );
      if (rejection?.kind === 'rejected') {
        const guidance = [
          `Intervention option ${option.optionId} cannot be offered as executable.`,
          rejection.data.guidance,
          'Continue evidence research and replace the consolidated intervention proposal.',
        ].join(' ');
        if (!this.state.pendingGuidance.includes(guidance)) {
          this.state.pendingGuidance.push(guidance);
        }
        const currentResearch = this.currentInterventionResearchAfterRequest(
          research
        );
        currentResearch.lastCandidateSetDigest = candidateSetDigest;
        currentResearch.updatedAt = recordedAt;
        await this.saveCheckpoint();
        return { published: false, guidance };
      }
      const actions = outcome.reply.results.map((result) => {
        if (result.kind !== 'previewed') {
          throw new SessionKernelLoopError(
            'session_kernel_intervention_candidate_preview_incomplete',
            'Executable intervention option did not receive a complete Kernel preview batch.'
          );
        }
        return {
          planActionId: result.data.preview.planActionId,
          operationId: result.data.preview.operationId,
          toolId: result.data.preview.toolId,
          summary: result.data.preview.approvalView.summary,
          preview: cloneJson(result.data.preview),
        };
      });
      options.push({
        ...option,
        candidatePlan: cloneJson(plan),
        actions,
      });
    }
    const currentResearch = this.currentInterventionResearchAfterRequest(
      research
    );
    const userIntervention = {
      schemaVersion: 'deepcode.session.user-intervention.v1' as const,
      runId: this.state.runId,
      inputId: this.state.currentInputId,
      controlEpoch: this.state.controlEpoch,
      interactionId,
      interactionRevision,
      candidateSetDigest,
      problemSummary: canonicalProposal.problemSummary,
      ...(canonicalProposal.recommendation
        ? { recommendation: canonicalProposal.recommendation }
        : {}),
      relevantFactRefs: [...canonicalProposal.relevantFactRefs],
      affectedPlanActionIds: [...canonicalProposal.affectedPlanActionIds],
      options,
      evidenceProgressDigest: research.evidenceProgressDigest,
      recordedAt,
    };
    this.state.userIntervention = userIntervention;
    this.state.userInterventionDecision = undefined;
    this.state.activeWait = {
      kind: 'userIntervention',
      interactionId,
      interactionRevision,
      candidateSetDigest,
      sinceHighWater: this.state.lineage.cursor.snapshotHighWater,
    };
    currentResearch.lastCandidateSetDigest = candidateSetDigest;
    currentResearch.updatedAt = recordedAt;
    await this.saveCheckpoint();
    await this.project(
      `user-intervention:${interactionId}:${interactionRevision}`,
      'userIntervention.changed',
      {
        state: 'open',
        wait: cloneJson(this.state.activeWait),
        intervention: cloneJson(userIntervention),
      },
      recordedAt
    );
    return { published: true };
  }

  private currentInterventionResearchAfterRequest(
    expected: NonNullable<SessionKernelLoopStateV2['interventionResearch']>
  ): NonNullable<SessionKernelLoopStateV2['interventionResearch']> {
    const current = this.state.interventionResearch;
    if (!current || canonicalJson(current) !== canonicalJson(expected)) {
      throw new SessionKernelLoopError(
        'session_kernel_intervention_research_changed',
        'Intervention research authority changed while Kernel candidate previews were settling.'
      );
    }
    return current;
  }

  async publishPlanConfirmationReady(
    expectedPlanRevision: string
  ): Promise<SessionPlanConfirmationReadyResultV2> {
    this.beginMaintenance('publishPlanConfirmationReady');
    try {
      this.requireNoPendingRequests();
      this.requirePlanProjected();
      this.requireCurrentPlanRevision(expectedPlanRevision);
      if (this.state.planDecision) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_confirmation_ready_stale',
          'Plan confirmation publication cannot follow a durable Plan decision.'
        );
      }
      const existingAuthority =
        currentSessionPlanConfirmationAuthorityV2(this.state);
      if (existingAuthority) {
        return planConfirmationReadyResultV2(existingAuthority);
      }
      const plan = this.state.plan!;
      if (this.state.toolContext.refreshRequired) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_confirmation_context_stale',
          'Plan confirmation cannot publish while ToolContext refresh is required.'
        );
      }
      const scopePreviews = currentSessionPlanScopePreviewsV2(
        this.state,
        plan
      );
      const providerTurn = this.state.providerTurn;
      const providerOutcome = [...this.state.providerOutcomes]
        .reverse()
        .find((candidate) =>
          candidate.providerTurnId === providerTurn?.providerTurnId
          && candidate.outputKind === 'plan'
        );
      if (
        !providerTurn
        || providerTurn.target.kind !== 'planning'
        || providerTurn.controlEpoch !== this.state.controlEpoch
        || providerTurn.status !== 'completed'
        || !providerTurn.response
        || !providerOutcome
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_plan_confirmation_provider_evidence_missing',
          'Confirmation publication requires the current sealed planning Provider response.'
        );
      }
      const orderedItems = publicSessionProviderOrderedItemsV2(
        providerTurn.response.items
      ).filter((item) =>
        item.kind === 'text' && item.phase === 'commentary'
      );
      const commentaryRecordedAt = providerOutcome.recordedAt;
      const commentaryEvent = orderedItems.length === 0
        ? undefined
        : this.event(
            `plan:${expectedPlanRevision}:commentary-ready`,
            'plan.commentaryReleased',
            {
              planRevision: expectedPlanRevision,
              providerTurnId: providerTurn.providerTurnId,
              controlEpoch: providerTurn.controlEpoch,
              orderedItems,
              recordedAt: commentaryRecordedAt,
            },
            commentaryRecordedAt
          );
      const recordedAt = this.ports.clock.now();
      const confirmationEvent = this.event(
        `plan:${expectedPlanRevision}:confirmation-ready`,
        'plan.confirmationReady',
        {
          planRevision: expectedPlanRevision,
          providerTurnId: providerTurn.providerTurnId,
          plan: cloneJson(plan),
          scopePreviews,
          ...(commentaryEvent
            ? { commentaryProjectionId: commentaryEvent.projectionId }
            : {}),
          recordedAt,
        },
        recordedAt
      );
      const commentaryProjection = commentaryEvent
        ? requiredDeliveredProjectionReceiptV2(
            [await this.ports.projection.project(commentaryEvent)],
            commentaryEvent.projectionId
          )
        : undefined;
      const confirmationProjection = requiredDeliveredProjectionReceiptV2(
        [await this.ports.projection.project(confirmationEvent)],
        confirmationEvent.projectionId
      );
      const authority = buildSessionPlanConfirmationAuthorityV2(
        this.state,
        {
          providerTurnId: providerTurn.providerTurnId,
          providerResponseDigest:
            providerTurn.response.completion.responseDigest,
          recordedAt,
          ...(commentaryProjection
            ? {
                commentaryProjection: {
                  projectionId: commentaryProjection.projectionId,
                  projectionDigest: commentaryProjection.projectionDigest,
                },
              }
            : {}),
          confirmationProjection: {
            projectionId: confirmationProjection.projectionId,
            projectionDigest: confirmationProjection.projectionDigest,
          },
        }
      );
      const previousState = this.state;
      this.state = recordSessionPlanConfirmationAuthorityV2(
        previousState,
        authority
      );
      try {
        await this.saveCheckpoint();
      } catch (error) {
        this.state = previousState;
        throw error;
      }
      return planConfirmationReadyResultV2(authority);
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
        // A prior response may have observed projection delivery while the
        // final checkpoint write failed. Reassert the terminal checkpoint
        // before returning the canonical acknowledgement.
        await this.saveCheckpoint();
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

      if (cancellation.status === 'factsReconciled') {
        return await this.finalizeRunCancellationProjection(input);
      }

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
      return await this.finalizeRunCancellationProjection(input);
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

  private async finalizeRunCancellationProjection(
    input: SessionKernelRunCancelInputV2
  ): Promise<SessionKernelRunCancelResultV2> {
    let cancellation = currentRunCancellation(this.state, input);
    if (
      cancellation.status !== 'factsReconciled'
      || !cancellation.cancellation
      || !cancellation.facts
      || !cancellation.cancelledAt
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_run_cancellation_projection_not_ready',
        'Session Run cancellation cannot project before canonical facts are reconciled.'
      );
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
    expectedWorkAuthority: SessionWorkAuthorityV3
  ): Promise<SessionKernelReviewV2> {
    this.beginMaintenance('finalizeReview');
    try {
      this.requireNoPendingRequests();
      const workAuthority = currentSessionWorkAuthorityV3(this.state);
      if (
        !workAuthority
        || !sameSessionWorkAuthorityV3(
          workAuthority,
          expectedWorkAuthority
        )
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_work_authority_stale',
          'Review finalization does not bind the current durable work authority.'
        );
      }
      if (workAuthority.kind === 'plan') {
        this.requireCurrentPlanRevision(workAuthority.planRevision);
        this.requireReviewablePlanDecision();
      }
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
      recordSessionKernelReviewV2(this.state, review);
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
    const recoverySnapshotHighWater =
      this.state.lineage.cursor.snapshotHighWater;
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
      if (
        this.state.lineage.cursor.snapshotHighWater
          < recoverySnapshotHighWater
        || this.state.lineage.cursor.afterLedgerSequence
          < recoverySnapshotHighWater
      ) {
        throw new SessionKernelLoopError(
          'session_kernel_recovery_fact_replay_incomplete',
          'Canonical Kernel fact replay did not cover the restored checkpoint high-water.'
        );
      }
      await this.ensurePlanProjected();
      await this.ensurePlanDecisionProjected();
      await this.ensurePlanActionSettlementsProjected();
      await this.providers.recoverCompletedProviderTurn();
      // Recovery may have materialized a new Plan or PlanAction settlement
      // from the sealed terminal. Re-run the idempotent projection gates over
      // that newly admitted state before delivery flush.
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
    if (this.state.pendingEpochInput) {
      await this.settleProviderToolCallQueue();
      this.providers.retireSupersededForEpochAdvance();
    }
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
    const researchProgressChanged =
      queue.status !== 'active'
      && queue.target.kind === 'interventionResearch'
      && queue.abortReason !== 'userIntervention'
      && this.refreshInterventionResearchProgressV4(queue.settledAt);
    if (reconciliation.changed || researchProgressChanged) {
      await this.saveCheckpoint();
    }
    if (queue.status === 'active' || queue.outcomeRecorded) return;
    if (!queue.settledAt) {
      throw new SessionKernelLoopError(
        'session_kernel_provider_tool_settlement_missing',
        'A settled Provider tool-call queue requires its durable settlement time.'
      );
    }

    if (
      queue.status === 'aborted'
      && queue.abortReason !== 'userInput'
      && queue.abortReason !== 'runCancelled'
      && queue.abortReason !== 'capabilityDenied'
      && queue.abortReason !== 'planDiscovery'
      && queue.abortReason !== 'userIntervention'
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
    if (queue.status === 'aborted' && queue.abortReason === 'planDiscovery') {
      const guidance = [
        'The mutation candidates were previewed but not executed because no accepted mutation Plan exists.',
        'Continue safe evidence reads as needed, then propose one mutation-only Plan with no blocking unknowns.',
      ].join(' ');
      if (!this.state.pendingGuidance.includes(guidance)) {
        this.state.pendingGuidance.push(guidance);
      }
    }
    if (
      queue.status === 'aborted'
      && queue.abortReason === 'userIntervention'
    ) {
      this.recordInterventionResearchFromQueue(queue, queue.settledAt);
    }
    const outcome = {
      providerTurnId: queue.providerTurnId,
      outputKind: 'toolIntent',
      recordedAt: queue.settledAt,
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
      toolSettlement: {
        status: queue.status,
        settledAt: queue.settledAt,
      },
      toolCalls: settledSessionProviderToolCallsV2(queue),
      providerResult: cloneJson(queue.providerResult),
    } as const;
    let projectionDeliveryError:
      SessionKernelProjectionDeliveryErrorV2 | undefined;
    try {
      if (
        queue.status === 'completed'
        || queue.abortReason === 'planDiscovery'
        || queue.abortReason === 'userIntervention'
      ) {
        await this.project(
          `provider:${queue.providerTurnId}:completed`,
          'provider.completed',
          {
            providerTurnId: queue.providerTurnId,
            controlEpoch: queue.controlEpoch,
            outputKind: 'toolIntent',
            terminalScope: 'providerTurn',
            result: {
              kind: queue.status === 'completed'
                ? 'orderedToolCallsCompleted'
                : queue.abortReason === 'planDiscovery'
                  ? 'mutationPlanDiscoveryRequired'
                  : 'userInterventionResearchRequired',
              callCount: queue.calls.length,
              ...(queue.status === 'aborted'
                ? {
                    unexecutedOrdinals: queue.calls
                      .filter((call) => call.status === 'unexecuted')
                      .map((call) => call.ordinal),
                  }
                : {}),
            },
            orderedItems:
              publicSessionProviderToolCallQueueItemsV2(queue),
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
            orderedItems:
              publicSessionProviderToolCallQueueItemsV2(queue),
            unexecutedOrdinals: queue.calls
              .filter((call) => call.status === 'unexecuted')
              .map((call) => call.ordinal),
            toolCallReceipt: queue.receipt,
          },
          queue.settledAt
        );
      }
    } catch (error) {
      if (!(error instanceof SessionKernelProjectionDeliveryErrorV2)) {
        throw error;
      }
      projectionDeliveryError = error;
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
    if (projectionDeliveryError) throw projectionDeliveryError;
  }

  private recordInterventionResearchFromQueue(
    queue: NonNullable<SessionKernelLoopStateV2['providerToolCallQueue']>,
    recordedAt: string
  ): void {
    const plan = this.state.plan;
    if (
      !plan
      || queue.controlEpoch !== this.state.controlEpoch
      || queue.mutationDisposition !== 'userIntervention'
      || queue.calls.every((call) => call.dispatchKind !== 'mutation')
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_intervention_research_source_invalid',
        'User intervention research requires one current Plan and canonical out-of-plan mutation candidates.'
      );
    }
    const triggerCandidates = queue.calls.flatMap((call) => {
      const candidate = call.candidatePreview;
      if (call.dispatchKind !== 'mutation' || !candidate) return [];
      return [{
        discoveryId: candidate.discoveryId,
        operationId: candidate.operationId,
        toolId: candidate.toolId,
        argumentsDigest: sha256Hash(canonicalJson(candidate.rawArguments)),
        classification: candidate.classification ?? 'outOfPlan',
        ...(candidate.preview
          ? { preview: cloneJson(candidate.preview) }
          : {}),
        ...(candidate.rejection
          ? { rejection: cloneJson(candidate.rejection) }
          : {}),
      }];
    });
    if (triggerCandidates.length === 0) {
      throw new SessionKernelLoopError(
        'session_kernel_intervention_research_candidates_missing',
        'User intervention research lost every canonical mutation candidate.'
      );
    }
    const triggerCandidateSetDigest = sha256Hash(canonicalJson(
      triggerCandidates.map((candidate) => ({
        discoveryId: candidate.discoveryId,
        operationId: candidate.operationId,
        toolId: candidate.toolId,
        argumentsDigest: candidate.argumentsDigest,
        classification: candidate.classification,
        previewId: candidate.preview?.previewId,
        scopeDigest: candidate.preview?.scopeDigest,
        rejection: candidate.rejection,
      }))
    ));
    const unsettledPlanActionIds = plan.actions
      .filter((action) =>
        !this.state.planActionSettlements[action.manifest.planActionId]
      )
      .map((action) => action.manifest.planActionId);
    const evidenceProgressDigest = sessionInterventionEvidenceProgressDigestV4(
      this.state,
      triggerCandidateSetDigest
    );
    const predecessorPlanRef = {
      planRevision: plan.planRevision,
      planDigest: sha256Hash(canonicalJson(plan)),
    };
    const existing = this.state.interventionResearch;
    const researchId = existing?.runId === this.state.runId
      && existing.inputId === this.state.currentInputId
      && existing.controlEpoch === this.state.controlEpoch
      && existing.predecessorPlanRef.planRevision === plan.planRevision
        ? existing.researchId
        : `intervention-research-${sha256Hash(canonicalJson({
            runId: this.state.runId,
            inputId: this.state.currentInputId,
            controlEpoch: this.state.controlEpoch,
            predecessorPlanRef,
          })).slice('sha256:'.length)}`;
    const research: SessionInterventionResearchV4 = {
      schemaVersion: 'deepcode.session.intervention-research.v1',
      runId: this.state.runId,
      inputId: this.state.currentInputId,
      controlEpoch: this.state.controlEpoch,
      researchId,
      triggerProviderTurnId: queue.providerTurnId,
      predecessorPlanRef,
      triggerCandidates,
      triggerCandidateSetDigest,
      evidenceProgressDigest,
      ...(existing
        ? {
            previousEvidenceProgressDigest: existing.evidenceProgressDigest,
            ...(existing.lastCandidateSetDigest
              ? { lastCandidateSetDigest: existing.lastCandidateSetDigest }
              : {}),
          }
        : {}),
      guidanceRevision: existing
        ? existing.guidanceRevision + (
            existing.evidenceProgressDigest === evidenceProgressDigest
            && existing.triggerCandidateSetDigest === triggerCandidateSetDigest
              ? 0
              : 1
          )
        : 1,
      startedAt: existing?.startedAt ?? recordedAt,
      updatedAt: recordedAt,
    };
    this.state.interventionResearch = research;
    this.state.userIntervention = undefined;
    this.state.userInterventionDecision = undefined;
    const guidance = canonicalJson({
      schemaVersion: 'deepcode.session.intervention-research-guidance.v1',
      researchId: research.researchId,
      guidanceRevision: research.guidanceRevision,
      predecessorPlanRef: research.predecessorPlanRef,
      triggerCandidateSetDigest,
      evidenceProgressDigest,
      affectedUnsettledPlanActionIds: unsettledPlanActionIds,
      triggerCandidates: triggerCandidates.map((candidate) => ({
        operationId: candidate.operationId,
        toolId: candidate.toolId,
        classification: candidate.classification,
        preview: candidate.preview
          ? {
              previewId: candidate.preview.previewId,
              summary: candidate.preview.approvalView.summary,
              risk: candidate.preview.risk,
              effectClass: candidate.preview.effectClass,
              canonicalTargets:
                candidate.preview.approvalView.canonicalTargets,
            }
          : undefined,
        rejection: candidate.rejection,
      })),
      instruction: 'Continue directly related safe reads until material options and blocking unknowns converge, then emit exactly one consolidated intervention proposal. Do not execute or claim any mutation.',
    });
    if (!this.state.pendingGuidance.includes(guidance)) {
      this.state.pendingGuidance.push(guidance);
    }
  }

  private refreshInterventionResearchProgressV4(
    recordedAt: string | undefined
  ): boolean {
    const research = this.state.interventionResearch;
    if (!research || !recordedAt || this.state.userIntervention) {
      return false;
    }
    const evidenceProgressDigest = sessionInterventionEvidenceProgressDigestV4(
      this.state,
      research.triggerCandidateSetDigest
    );
    if (evidenceProgressDigest === research.evidenceProgressDigest) {
      return false;
    }
    research.previousEvidenceProgressDigest =
      research.evidenceProgressDigest;
    research.evidenceProgressDigest = evidenceProgressDigest;
    research.guidanceRevision += 1;
    research.updatedAt = recordedAt;
    return true;
  }

  private async ensurePlanProjected(): Promise<void> {
    const plan = this.state.plan;
    if (!plan || this.state.projectedPlanRevision === plan.planRevision) {
      return;
    }
    await this.project(
      `plan:${plan.planRevision}`,
      'plan.persisted',
      cloneJson(plan),
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
    const canonicalPlan = carrySettledPlanActionsV4(this.state, plan);
    const previousRevision = this.state.plan?.planRevision;
    const next = recordSessionPlanV2(this.state, canonicalPlan);
    await this.ports.persistence.persistPlan(canonicalPlan);
    this.state = next;
    if (previousRevision !== canonicalPlan.planRevision) {
      this.state.projectedPlanRevision = undefined;
    }
    await this.saveCheckpoint();
    await this.ensurePlanProjected();
  }

  private settlePlanActionComplete(
    planActionId: string,
    outcome: SessionPlanActionSettlementV2['outcome'],
    providerTurnId: string,
    controlCallId: string,
    controlArgumentsDigest: string,
    recordedAt: string
  ): SessionPlanActionSettlementV2 {
    this.requireAcceptedPlan();
    this.requireNoPendingRequests();
    const plan = this.state.plan!;
    const action = sessionPlanActionV2(this.state, planActionId);
    const providerTurn = this.state.providerTurn;
    if (
      providerTurn?.providerTurnId !== providerTurnId
      || providerTurn.status !== 'active'
      || providerTurn.target.kind !== 'planAction'
      || providerTurn.target.planActionId !== planActionId
      || providerTurn.controlEpoch !== this.state.controlEpoch
      || providerTurn.planRevision !== plan.planRevision
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_complete_authority_stale',
        'PlanActionComplete does not bind the exact current Provider target, Plan revision, and control epoch.'
      );
    }
    if (
      this.state.kernelWakeHint
      || !sessionKernelFactsCaughtUpV2(this.state.lineage)
      || sessionKernelFactBarriersPendingV2(this.state)
      || this.state.activeWait
      || this.state.providerToolCallQueue?.status === 'active'
      || (
        this.state.providerToolCallQueue
        && !this.state.providerToolCallQueue.outcomeRecorded
      )
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_complete_state_unsettled',
        'PlanActionComplete requires caught-up Kernel facts and no pending request, wait, invocation, or Provider tool queue.'
      );
    }
    if (this.state.reviewFacts.indeterminate.totalCount > 0) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_complete_indeterminate',
        'PlanActionComplete cannot settle while an indeterminate Kernel outcome remains.'
      );
    }
    const planActionLineage = this.state.lineage.planActions[planActionId];
    const operationIds = new Set(planActionLineage?.operationIds ?? []);
    const relatedInvocations = Object.values(
      this.state.lineage.invocations
    ).filter(
      (invocation) =>
        invocation.operationId !== undefined
        && operationIds.has(invocation.operationId)
    );
    if (relatedInvocations.some(
      (invocation) => invocation.lastTerminalPhase === undefined
    )) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_complete_invocation_pending',
        'PlanActionComplete cannot settle while a related Kernel invocation has no terminal fact.'
      );
    }
    if (outcome === 'completed' && relatedInvocations.length === 0) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_complete_invocation_missing',
        'A completed PlanAction requires at least one related Kernel invocation with canonical terminal facts.'
      );
    }
    const descriptor = this.state.toolContext.bundle.tools.find(
      (tool) => tool.toolId === action.manifest.toolId
    );
    if (!descriptor) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_complete_tool_missing',
        'PlanActionComplete cannot resolve the immutable Kernel tool descriptor for the current PlanAction.'
      );
    }
    if (
      outcome === 'completed'
      && descriptor.effectClass === 'mutation'
      && !this.state.reviewFacts.observedEffectPlanActions[
        plan.planRevision
      ]?.[planActionId]
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_complete_effect_missing',
        'A mutation PlanAction cannot be completed without a canonical observed-effect fact.'
      );
    }
    const existing = this.state.planActionSettlements[planActionId];
    if (existing) {
      if (
        existing.kind === 'planActionComplete'
        && existing.planRevision === plan.planRevision
        && existing.controlEpoch === this.state.controlEpoch
        && existing.outcome === outcome
        && existing.providerTurnId === providerTurnId
        && existing.controlCallId === controlCallId
        && existing.controlArgumentsDigest === controlArgumentsDigest
        && existing.snapshotHighWater
          === this.state.lineage.cursor.snapshotHighWater
      ) {
        return cloneJson(existing);
      }
      throw new SessionKernelLoopError(
        'session_kernel_plan_action_completion_conflict',
        `PlanAction ${planActionId} already has a different Session settlement.`
      );
    }
    const settlement: SessionPlanActionSettlementV2 = {
      kind: 'planActionComplete',
      planRevision: plan.planRevision,
      planActionId,
      controlEpoch: this.state.controlEpoch,
      outcome,
      providerTurnId,
      controlCallId,
      controlArgumentsDigest,
      snapshotHighWater:
        this.state.lineage.cursor.snapshotHighWater,
      recordedAt,
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
        inputId: input.inputId,
        opaqueInputRef: input.opaqueInputRef,
        text: input.text,
        attachments: cloneJson(input.attachments),
        recordedAt: input.recordedAt,
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

  private requireReviewablePlanDecision(): void {
    const plan = this.state.plan;
    const decision = this.state.planDecision;
    if (
      !plan
      || !decision
      || decision.planRevision !== plan.planRevision
      || (
        decision.decision !== 'accept'
        && decision.decision !== 'reject'
      )
    ) {
      throw new SessionKernelLoopError(
        'session_kernel_plan_review_decision_required',
        'The exact current Plan revision must be durably accepted or rejected before Review finalization.'
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

function requiredDeliveredProjectionReceiptV2(
  receipts: readonly SessionKernelProjectionReceiptV2[],
  projectionId: string
): SessionKernelProjectionReceiptV2 {
  const receipt = receipts.find(
    (candidate) => candidate.projectionId === projectionId
  );
  if (
    !receipt
    || !receipt.delivered
    || !/^sha256:[0-9a-f]{64}$/u.test(receipt.projectionDigest)
  ) {
    throw new SessionKernelLoopError(
      'session_kernel_plan_confirmation_projection_unconfirmed',
      `Plan confirmation projection ${projectionId} was not durably acknowledged by Host.`
    );
  }
  return cloneJson(receipt);
}

function planConfirmationReadyResultV2(
  authority: SessionPlanConfirmationAuthorityV2
): SessionPlanConfirmationReadyResultV2 {
  return {
    planRevision: authority.planRevision,
    providerTurnId: authority.providerTurnId,
    recordedAt: authority.recordedAt,
    ...(authority.commentaryProjection
      ? {
          commentaryProjection: {
            ...cloneJson(authority.commentaryProjection),
            delivered: true,
          },
        }
      : {}),
    confirmationProjection: {
      ...cloneJson(authority.confirmationProjection),
      delivered: true,
    },
  };
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

function carrySettledPlanActionsV4(
  state: SessionKernelLoopStateV2,
  plan: SessionNaturalLanguagePlanV2
): SessionNaturalLanguagePlanV2 {
  if (!state.plan || state.plan.planRevision === plan.planRevision) {
    return cloneJson(plan);
  }
  const predecessorPlanRef = {
    planRevision: state.plan.planRevision,
    planDigest: sha256Hash(canonicalJson(state.plan)),
  };
  if (
    plan.predecessorPlanRef
    && canonicalJson(plan.predecessorPlanRef)
      !== canonicalJson(predecessorPlanRef)
  ) {
    throw new SessionKernelLoopError(
      'session_kernel_plan_predecessor_mismatch',
      'A new Plan revision does not bind the exact predecessor Plan.'
    );
  }
  const carriedSettlementRefs = Object.values(
    state.planActionSettlements
  )
    .sort((left, right) =>
      left.planActionId.localeCompare(right.planActionId)
    )
    .map((settlement) => ({
      planRevision: settlement.planRevision,
      planActionId: settlement.planActionId,
      settlementDigest: sha256Hash(canonicalJson(settlement)),
      kernelFactRefs: Object.values(state.factsById)
        .filter((fact) =>
          fact.lineage.planActionIds.includes(settlement.planActionId)
        )
        .sort((left, right) =>
          left.ledgerSequence - right.ledgerSequence
          || left.factId.localeCompare(right.factId)
        )
        .map((fact) => fact.factId),
    }));
  return {
    ...cloneJson(plan),
    predecessorPlanRef,
    carriedSettlementRefs,
  };
}

function requireInterventionSelectionFactsV4(
  state: SessionKernelLoopStateV2,
  intervention: NonNullable<SessionKernelLoopStateV2['userIntervention']>,
  selectedOptionId: string
): void {
  const facts = Object.values(state.factsById);
  for (const option of intervention.options) {
    for (const action of option.actions) {
      const matching = facts.some((fact) =>
        fact.domain === 'authorization'
        && fact.lineage.operationId === action.operationId
        && fact.lineage.planActionIds.includes(action.planActionId)
        && canonicalJson(fact.details).includes(action.preview.previewId)
        && (
          option.optionId === selectedOptionId
          || canonicalJson(fact.details).includes(selectedOptionId)
        )
      );
      if (!matching) {
        throw new SessionKernelLoopError(
          'session_kernel_user_intervention_kernel_facts_missing',
          'Session cannot accept an intervention candidate until exact selected and superseded Kernel authorization facts are reconciled.'
        );
      }
    }
  }
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
