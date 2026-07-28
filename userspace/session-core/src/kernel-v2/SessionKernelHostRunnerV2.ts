import type { CapabilityScopePreviewReplyV2 } from '@deepcode/protocol';
import {
  SessionKernelLoopV2,
  type SessionKernelLoopV2Options,
} from './SessionKernelLoopV2.js';
import {
  sessionKernelLoopPortsFromHostV2,
  type SessionKernelHostAdaptersV2,
} from './SessionKernelHostAdaptersV2.js';
import type {
  SessionKernelStoredOperationResultRefV2,
} from './ports.js';
import type { SessionKernelLoopStateV2 } from './state.js';
import type {
  SessionActiveWaitV2,
  SessionKernelLoopResultV2,
  SessionKernelReviewV2,
  SessionProviderTurnRequestV2,
  SessionPlanDecisionV2,
  SessionUserInputRecordV2,
} from './types.js';

export interface SessionKernelHostRunnerOpenV2 {
  workspaceBindingRef: string;
  initialInput: SessionUserInputRecordV2;
  signal?: AbortSignal;
}

export interface SessionPlanActionDriveOptionsV2 {
  providerCallBudget?: number;
  guidance?: string[];
}

export type SessionPlanActionDriveStepV2 =
  | {
      kind: 'providerResult';
      result: Extract<
        SessionKernelLoopResultV2,
        { kind: 'answer' | 'noTool' }
      >;
    }
  | {
      kind: 'waiting';
      wait: SessionActiveWaitV2;
    }
  | {
      kind: 'replanRequired';
      guidance: string[];
    }
  | {
      kind: 'budgetExhausted';
      providerCallBudget: number;
      completedProviderCalls: number;
    }
  | {
      kind: 'interrupted';
      result: Extract<
        SessionKernelLoopResultV2,
        { kind: 'staleProviderResult' }
      >;
    };

const DEFAULT_PLAN_ACTION_PROVIDER_CALL_BUDGET = 32;

/**
 * Minimal Host-owned composition for the v2 Session loop. Provider plans are
 * durably recorded and projected here before they are returned for display or
 * user confirmation; the Loop never treats provider output itself as approval.
 */
export class SessionKernelHostRunnerV2 {
  private constructor(
    private readonly loop: SessionKernelLoopV2
  ) {}

  static async open(
    input: SessionKernelHostRunnerOpenV2,
    adapters: SessionKernelHostAdaptersV2,
    options: SessionKernelLoopV2Options = {}
  ): Promise<SessionKernelHostRunnerV2> {
    const binding = await adapters.runs.openRun({
      workspaceBindingRef: input.workspaceBindingRef,
      inputId: input.initialInput.inputId,
      opaqueInputRef: input.initialInput.opaqueInputRef,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const loop = await SessionKernelLoopV2.open(
      {
        runId: binding.kernel.run.runId,
        workspaceBindingDigest:
          binding.kernel.run.workspaceBindingDigest,
        controlEpoch: binding.controlEpoch,
        initialInput: input.initialInput,
        toolContext: binding.toolContext,
      },
      sessionKernelLoopPortsFromHostV2(adapters, binding),
      options
    );
    return new SessionKernelHostRunnerV2(loop);
  }

  snapshot(): SessionKernelLoopStateV2 {
    return this.loop.snapshot();
  }

  persistOperationResult(
    operationRequestId: string,
    result: unknown
  ): Promise<SessionKernelStoredOperationResultRefV2> {
    return this.loop.persistOperationResult(
      operationRequestId,
      result
    );
  }

  async runInitialTurn(
    guidance: string[] = []
  ): Promise<SessionKernelLoopResultV2> {
    const recordedPlan = this.loop.snapshot().plan;
    if (recordedPlan) {
      return { kind: 'plan', plan: recordedPlan };
    }
    return this.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
      guidance,
    });
  }

  async handleUserInput(
    input: SessionUserInputRecordV2,
    guidance: string[] = []
  ): Promise<SessionKernelLoopResultV2> {
    const result = await this.loop.handleUserInput(input, {
      reason: 'userInput',
      target: { kind: 'planning' },
      guidance,
    });
    return this.requireProviderPlanRecorded(result);
  }

  fenceProviderForUserInput(): number {
    return this.loop.fenceProviderForUserInput();
  }

  isUserInputFenceCurrent(generation: number): boolean {
    return this.loop.isUserInputFenceCurrent(generation);
  }

  async applyFencedUserInput(
    input: SessionUserInputRecordV2,
    generation: number
  ): Promise<void> {
    await this.loop.applyFencedUserInput(input, generation);
  }

  async runUserInputProviderTurn(
    guidance: string[] = []
  ): Promise<SessionKernelLoopResultV2> {
    return this.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
      guidance,
    });
  }

  async runProviderTurn(
    request: SessionProviderTurnRequestV2
  ): Promise<SessionKernelLoopResultV2> {
    const result = await this.loop.runProviderTurn(request);
    return this.requireProviderPlanRecorded(result);
  }

  async previewPlanAction(
    planActionId: string,
    expectedPlanRevision: string
  ): Promise<CapabilityScopePreviewReplyV2> {
    return this.loop.previewPlanAction(
      planActionId,
      expectedPlanRevision
    );
  }

  async decidePlan(input: {
    planRevision: string;
    decision: SessionPlanDecisionV2['decision'];
    guidance?: string;
  }): Promise<SessionPlanDecisionV2> {
    return this.loop.decidePlan(input);
  }

  async skipPlanAction(
    planActionId: string,
    expectedPlanRevision: string,
    reason: string
  ): Promise<void> {
    await this.loop.skipPlanAction(
      planActionId,
      expectedPlanRevision,
      reason
    );
  }

  async runPlanAction(
    planActionId: string,
    expectedPlanRevision: string,
    guidance: string[] = []
  ): Promise<SessionKernelLoopResultV2> {
    const state = this.loop.snapshot();
    requireExactPlanRevision(state, expectedPlanRevision);
    requirePlanActionUnsettled(state, planActionId);
    return this.runProviderTurn({
      reason: 'planExecution',
      target: { kind: 'planAction', planActionId },
      guidance,
    });
  }

  async replan(input: {
    expectedPlanRevision: string;
    guidance: string[];
  }): Promise<SessionKernelLoopResultV2> {
    const state = this.loop.snapshot();
    if (state.plan?.planRevision !== input.expectedPlanRevision) {
      throw new SessionKernelHostRunnerError(
        'session_kernel_replan_revision_stale',
        'Replan request does not match the current persisted Plan revision.'
      );
    }
    if (state.activeWait) {
      throw new SessionKernelHostRunnerError(
        'session_kernel_replan_wait_active',
        'Replan cannot start while an authority or invocation wait is active.'
      );
    }
    return this.runProviderTurn({
      reason: 'recovery',
      target: { kind: 'planning' },
      guidance: [
        ...state.pendingGuidance,
        ...input.guidance,
      ],
    });
  }

  async resumeAfterBackpressure(input: {
    operationId: string;
    retryAt: string;
    planActionId?: string;
    expectedPlanRevision?: string;
    guidance: string[];
  }, signal?: AbortSignal): Promise<SessionKernelLoopResultV2> {
    const snapshot = this.loop.snapshot();
    const wait = snapshot.activeWait;
    if (
      !wait
      || wait.kind !== 'backpressure'
      || wait.operationId !== input.operationId
      || wait.retryAt !== input.retryAt
    ) {
      throw new SessionKernelHostRunnerError(
        'session_kernel_backpressure_identity_stale',
        'Backpressure continuation does not match the current durable wait identity.'
      );
    }
    const operationLineage =
      snapshot.lineage.operations[input.operationId];
    if (!operationLineage) {
      throw new SessionKernelHostRunnerError(
        'session_kernel_backpressure_operation_stale',
        'Backpressure continuation does not bind a current operation.'
      );
    }
    const expectedPlanActionId = operationLineage.planActionId;
    if (expectedPlanActionId) {
      if (!input.planActionId || !input.expectedPlanRevision) {
        throw new SessionKernelHostRunnerError(
          'session_kernel_backpressure_plan_binding_required',
          'PlanAction backpressure requires its exact PlanAction identity and Plan revision.'
        );
      }
      requireAcceptedPlanRevision(snapshot);
      if (
        snapshot.plan?.planRevision !== input.expectedPlanRevision
        || expectedPlanActionId !== input.planActionId
      ) {
        throw new SessionKernelHostRunnerError(
          'session_kernel_backpressure_plan_binding_stale',
          'Backpressure continuation does not match the current PlanAction binding.'
        );
      }
    } else if (input.planActionId || input.expectedPlanRevision) {
      throw new SessionKernelHostRunnerError(
        'session_kernel_backpressure_plan_binding_unexpected',
        'Planning context-read backpressure cannot carry a PlanAction binding.'
      );
    }
    return this.loop.resumeAfterBackpressure(input.guidance, signal);
  }

  /**
   * Performs one recoverable PlanAction drive step. Canonical terminal facts,
   * not a ToolIntent admission reply or daemon notification, release the next
   * Provider call. The Host re-enters this method after a wake; no polling
   * loop is hidden here.
   */
  async drivePlanActionStep(
    planActionId: string,
    expectedPlanRevision: string,
    options: SessionPlanActionDriveOptionsV2 = {}
  ): Promise<SessionPlanActionDriveStepV2> {
    const initialState = this.loop.snapshot();
    requireAcceptedPlanRevision(initialState);
    requireExactPlanRevision(initialState, expectedPlanRevision);
    requirePlanActionUnsettled(initialState, planActionId);
    const budget = normalizeProviderCallBudget(
      options.providerCallBudget
    );
    let state = this.loop.snapshot();
    if (state.activeWait) {
      return {
        kind: 'waiting',
        wait: cloneJson(state.activeWait),
      };
    }
    if (state.pendingGuidance.length > 0) {
      return {
        kind: 'replanRequired',
        guidance: [...state.pendingGuidance],
      };
    }
    const completedProviderCalls =
      planActionProviderCallCount(state, planActionId);
    if (completedProviderCalls >= budget) {
      return {
        kind: 'budgetExhausted',
        providerCallBudget: budget,
        completedProviderCalls,
      };
    }
    const result = await this.runPlanAction(
      planActionId,
      expectedPlanRevision,
      options.guidance
    );
    state = this.loop.snapshot();
    if (state.activeWait) {
      return {
        kind: 'waiting',
        wait: cloneJson(state.activeWait),
      };
    }
    if (result.kind === 'answer' || result.kind === 'noTool') {
      return { kind: 'providerResult', result };
    }
    if (result.kind === 'staleProviderResult') {
      return { kind: 'interrupted', result };
    }
    if (result.kind === 'rejected') {
      return {
        kind: 'replanRequired',
        guidance: [result.guidance],
      };
    }
    if (state.pendingGuidance.length > 0) {
      return {
        kind: 'replanRequired',
        guidance: [...state.pendingGuidance],
      };
    }
    throw new SessionKernelHostRunnerError(
      'session_kernel_drive_result_unsettled',
      'PlanAction drive returned neither an ActiveWait nor a terminal Session result.'
    );
  }

  /**
   * The trusted Host submits the decision outside Session, then reports only
   * the semantic observation here so facts can reconcile it.
   */
  async observeCapabilityDecision(input: {
    decision: 'allow' | 'deny';
    guidance?: string;
    replanAfterDeny?: boolean;
    previewId: string;
    operationId: string;
    invocationId: string;
    planActionId?: string;
    expectedPlanRevision?: string;
  }): Promise<SessionKernelLoopResultV2 | undefined> {
    return this.loop.observeCapabilityDecision({
      decision: input.decision,
      previewId: input.previewId,
      operationId: input.operationId,
      invocationId: input.invocationId,
      ...(input.planActionId
        ? { planActionId: input.planActionId }
        : {}),
      ...(input.expectedPlanRevision
        ? {
            expectedPlanRevision:
              input.expectedPlanRevision,
          }
        : {}),
      ...(input.guidance ? { guidance: input.guidance } : {}),
      ...(input.decision === 'deny' && input.replanAfterDeny
        ? {
            nextTurn: {
              reason: 'capabilityDenied',
              target: { kind: 'planning' },
              ...(input.guidance
                ? { guidance: [input.guidance] }
                : {}),
            } satisfies SessionProviderTurnRequestV2,
          }
        : {}),
    });
  }

  async notifyKernelWakeHint(input: {
    waitKind: 'capability' | 'invocation';
    operationId: string;
    invocationId: string;
    previewId?: string;
    planActionId?: string;
    expectedPlanRevision?: string;
  }): Promise<void> {
    await this.loop.notifyKernelWakeHint(input);
  }

  /**
   * Context-read facts are reconciled before the follow-up planning turn, so
   * the Provider receives the new canonical facts instead of planning blind.
   */
  async resumePlanningAfterContextRead(
    wake: {
      waitKind: 'capability' | 'invocation';
      operationId: string;
      invocationId: string;
      previewId?: string;
      planActionId?: string;
      expectedPlanRevision?: string;
    },
    guidance: string[] = []
  ): Promise<SessionKernelLoopResultV2 | undefined> {
    await this.loop.notifyKernelWakeHint(wake);
    const state = this.loop.snapshot();
    if (
      state.activeWait
      || Object.keys(state.publicRequests).length > 0
    ) {
      return undefined;
    }
    return this.runProviderTurn({
      reason: 'recovery',
      target: { kind: 'planning' },
      guidance,
    });
  }

  async resumePlanning(
    guidance: string[] = []
  ): Promise<SessionKernelLoopResultV2 | undefined> {
    const highWater =
      this.loop.snapshot().lineage.cursor.snapshotHighWater;
    await this.loop.reconcileFacts(highWater);
    const state = this.loop.snapshot();
    if (
      state.activeWait
      || Object.keys(state.publicRequests).length > 0
    ) {
      return undefined;
    }
    return this.runProviderTurn({
      reason: 'recovery',
      target: { kind: 'planning' },
      guidance,
    });
  }

  async reconcileFactsAfter(
    observedHighWater: number
  ): Promise<void> {
    const currentHighWater =
      this.loop.snapshot().lineage.cursor.snapshotHighWater;
    if (
      !Number.isSafeInteger(observedHighWater)
      || observedHighWater < 0
      || observedHighWater > currentHighWater
    ) {
      throw new SessionKernelHostRunnerError(
        'session_kernel_facts_high_water_invalid',
        'Facts reconciliation must bind an observed Session high-water.'
      );
    }
    await this.loop.reconcileFacts(observedHighWater);
  }

  async finalizeReview(
    expectedPlanRevision: string
  ): Promise<SessionKernelReviewV2> {
    return this.loop.finalizeReview(expectedPlanRevision);
  }

  private requireProviderPlanRecorded(
    result: SessionKernelLoopResultV2
  ): SessionKernelLoopResultV2 {
    if (result.kind !== 'plan') return result;
    const recorded = this.loop.snapshot().plan;
    if (
      !recorded
      || recorded.planRevision !== result.plan.planRevision
      || JSON.stringify(recorded) !== JSON.stringify(result.plan)
    ) {
      throw new SessionKernelHostRunnerError(
        'session_kernel_host_plan_not_recorded',
        'Provider plan was not durably recorded before turn completion.'
      );
    }
    return result;
  }
}

export class SessionKernelHostRunnerError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelHostRunnerError';
  }
}

function normalizeProviderCallBudget(value: number | undefined): number {
  const budget = value ?? DEFAULT_PLAN_ACTION_PROVIDER_CALL_BUDGET;
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 256) {
    throw new SessionKernelHostRunnerError(
      'session_kernel_drive_budget_invalid',
      'PlanAction Provider-call budget must be an integer between 1 and 256.'
    );
  }
  return budget;
}

function planActionProviderCallCount(
  state: SessionKernelLoopStateV2,
  planActionId: string
): number {
  const action = state.plan?.actions.find(
    (candidate) => candidate.manifest.planActionId === planActionId
  );
  if (!action) {
    throw new SessionKernelHostRunnerError(
      'session_kernel_drive_plan_action_missing',
      `PlanAction ${planActionId} is not present in the current Plan.`
    );
  }
  return (
    state.lineage.planActions[planActionId]?.operationIds ?? []
  ).filter(
    (operationId) => operationId !== action.manifest.operationId
  ).length;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireAcceptedPlanRevision(
  state: SessionKernelLoopStateV2
): void {
  if (
    !state.plan
    || state.planDecision?.planRevision !== state.plan.planRevision
    || state.planDecision.decision !== 'accept'
  ) {
    throw new SessionKernelHostRunnerError(
      'session_kernel_plan_acceptance_required',
      'The exact current Plan revision must be durably accepted before PlanAction drive.'
    );
  }
}

function requireExactPlanRevision(
  state: SessionKernelLoopStateV2,
  expectedPlanRevision: string
): void {
  if (
    !expectedPlanRevision.trim()
    || state.plan?.planRevision !== expectedPlanRevision
  ) {
    throw new SessionKernelHostRunnerError(
      'session_kernel_plan_revision_stale',
      'Operation does not match the current persisted Plan revision.'
    );
  }
}

function requirePlanActionUnsettled(
  state: SessionKernelLoopStateV2,
  planActionId: string
): void {
  if (state.planActionSettlements[planActionId]) {
    throw new SessionKernelHostRunnerError(
      'session_kernel_plan_action_already_settled',
      `PlanAction ${planActionId} is already settled.`
    );
  }
}
