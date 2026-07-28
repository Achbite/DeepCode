import type { CapabilityScopePreviewReplyV2 } from '@deepcode/protocol';
import {
  SessionKernelLoopV2,
  type SessionKernelLoopV2Options,
} from './SessionKernelLoopV2.js';
import {
  sessionKernelLoopPortsFromHostV2,
  type SessionKernelHostAdaptersV2,
} from './SessionKernelHostAdaptersV2.js';
import type { SessionKernelLoopStateV2 } from './state.js';
import type {
  SessionActiveWaitV2,
  SessionKernelLoopResultV2,
  SessionKernelReviewV2,
  SessionProviderTurnRequestV2,
  SessionUserInputRecordV2,
} from './types.js';

export interface SessionKernelHostRunnerOpenV2 {
  workspaceBindingRef: string;
  initialInput: SessionUserInputRecordV2;
  signal?: AbortSignal;
}

export interface SessionPlanActionDriveOptionsV2 {
  wakeHint?: boolean;
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

  async runProviderTurn(
    request: SessionProviderTurnRequestV2
  ): Promise<SessionKernelLoopResultV2> {
    const result = await this.loop.runProviderTurn(request);
    return this.requireProviderPlanRecorded(result);
  }

  async previewPlanAction(
    planActionId: string
  ): Promise<CapabilityScopePreviewReplyV2> {
    return this.loop.previewPlanAction(planActionId);
  }

  async skipPlanAction(
    planActionId: string,
    reason: string
  ): Promise<void> {
    await this.loop.skipPlanAction(planActionId, reason);
  }

  async runPlanAction(
    planActionId: string,
    guidance: string[] = []
  ): Promise<SessionKernelLoopResultV2> {
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
    planActionId: string;
    guidance: string[];
  }): Promise<SessionKernelLoopResultV2> {
    const wait = this.loop.snapshot().activeWait;
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
    return this.loop.resumeAfterBackpressure({
      reason: 'retryGuidance',
      target: {
        kind: 'planAction',
        planActionId: input.planActionId,
      },
      guidance: input.guidance,
    });
  }

  /**
   * Performs one recoverable PlanAction drive step. Canonical terminal facts,
   * not a ToolIntent admission reply or daemon notification, release the next
   * Provider call. The Host re-enters this method after a wake; no polling
   * loop is hidden here.
   */
  async drivePlanActionStep(
    planActionId: string,
    options: SessionPlanActionDriveOptionsV2 = {}
  ): Promise<SessionPlanActionDriveStepV2> {
    const budget = normalizeProviderCallBudget(
      options.providerCallBudget
    );
    if (options.wakeHint) {
      await this.loop.notifyKernelWakeHint();
    }
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
  }): Promise<SessionKernelLoopResultV2 | undefined> {
    return this.loop.observeCapabilityDecision({
      decision: input.decision,
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

  async notifyKernelWakeHint(): Promise<void> {
    await this.loop.notifyKernelWakeHint();
  }

  /**
   * Context-read facts are reconciled before the follow-up planning turn, so
   * the Provider receives the new canonical facts instead of planning blind.
   */
  async resumePlanningAfterContextRead(
    guidance: string[] = []
  ): Promise<SessionKernelLoopResultV2 | undefined> {
    await this.loop.notifyKernelWakeHint();
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

  async reconcileFacts(): Promise<void> {
    await this.loop.reconcileFacts();
  }

  async finalizeReview(): Promise<SessionKernelReviewV2> {
    return this.loop.finalizeReview();
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
