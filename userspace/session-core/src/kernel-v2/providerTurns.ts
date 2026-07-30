import type {
  CapabilityLeaseRefV2,
  ToolIntentV2,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  contextReadAuthorityV2,
  planActionAuthorityV2,
} from './authority.js';
import {
  expectSessionKernelPublicRequestOutcomeV2,
  SessionKernelPublicRequestsV2,
} from './publicRequests.js';
import {
  currentSessionUserInputV2,
  recordSessionProviderOutcomeV2,
  sessionPlanActionV2,
  type SessionKernelLoopStateV2,
} from './state.js';
import {
  providerToolContextBindingV2,
  toolContextRefV2,
} from './toolContext.js';
import {
  sessionKernelFactsCaughtUpV2,
} from './lineage.js';
import {
  sessionKernelFactBarriersPendingV2,
} from './factBarriers.js';
import {
  projectSessionProviderFactsV2,
} from './providerFactProjection.js';
import {
  buildSessionProviderContextV2,
} from './providerContext.js';
import {
  decodeProviderToolIntentTextFrameV2,
  normalizeProviderKernelToolIntentV2,
  type ProviderKernelToolSourceV2,
} from './toolIntent.js';
import type { SessionKernelLoopPortsV2 } from './ports.js';
import type {
  SessionKernelLoopResultV2,
  SessionNaturalLanguagePlanV2,
  SessionPlanActionSettlementV2,
  SessionKernelProjectionEventV2,
  SessionProviderTurnRequestV2,
} from './types.js';

export interface SessionKernelProviderTurnHostV2 {
  readState(): SessionKernelLoopStateV2;

  saveCheckpoint(): Promise<void>;

  project(
    projectionId: string,
    kind: SessionKernelProjectionEventV2['kind'],
    data: unknown,
    recordedAt?: string
  ): Promise<void>;

  reconcileFacts(): Promise<void>;

  recordProviderPlan(
    plan: SessionNaturalLanguagePlanV2
  ): Promise<void>;

  settlePlanActionCompleted(
    planActionId: string,
    completionKind: 'answer' | 'noTool',
    providerTurnId: string
  ): SessionPlanActionSettlementV2;

  transitionBlocked(): boolean;

  requireNoPendingRequests(): void;

  requirePlanProjected(): void;

  requirePlanAccepted(): void;
}

/**
 * Provider lifecycle is Session-owned. This coordinator never sees raw
 * Kernel commands or run capabilities; provider output can only become a
 * normalized ToolIntent submitted through the durable semantic request lane.
 */
export class SessionKernelProviderTurnsV2 {
  private authorityGeneration = 0;
  private userInputFenceGeneration?: number;
  private reservation?: symbol;
  private providerAbort?: {
    reservation: symbol;
    controller: AbortController;
  };
  private admissionCommit?: {
    token: symbol;
    settled: Promise<void>;
    resolve: () => void;
  };

  constructor(
    private readonly ports: SessionKernelLoopPortsV2,
    private readonly requests: SessionKernelPublicRequestsV2,
    private readonly host: SessionKernelProviderTurnHostV2
  ) {}

  isReserved(): boolean {
    return Boolean(this.reservation);
  }

  supersedeForUserInput(): {
    generation: number;
    quiescence: Promise<void>;
  } {
    this.authorityGeneration += 1;
    this.userInputFenceGeneration = this.authorityGeneration;
    const quiescence =
      this.admissionCommit?.settled ?? Promise.resolve();
    this.providerAbort?.controller.abort('userInput');
    this.providerAbort = undefined;
    this.reservation = undefined;
    const state = this.host.readState();
    if (state.providerTurn?.status === 'active') {
      state.providerTurn.status = 'cancelled';
      state.providerTurn.cancellationReason = 'userInput';
    }
    return {
      generation: this.authorityGeneration,
      quiescence,
    };
  }

  releaseUserInputFence(generation: number): void {
    if (this.userInputFenceGeneration === generation) {
      this.userInputFenceGeneration = undefined;
    }
  }

  isAuthorityGenerationCurrent(generation: number): boolean {
    return generation === this.authorityGeneration;
  }

  async run(
    request: SessionProviderTurnRequestV2
  ): Promise<SessionKernelLoopResultV2> {
    const reservation = this.begin();
    const generation = this.authorityGeneration;
    const providerTurnId = this.ports.ids.nextProviderTurnId();
    try {
      this.assertMayReconcileProviderBoundary();
      await this.host.reconcileFacts();
      if (!this.boundaryIsCurrent(reservation, generation)) {
        return await this.settleStale(providerTurnId);
      }
      await this.refreshToolContextAtBoundary();
      if (!this.boundaryIsCurrent(reservation, generation)) {
        return await this.settleStale(providerTurnId);
      }
      this.assertMayRun(request);

      const state = this.host.readState();
      const binding = providerToolContextBindingV2(
        state.toolContext.bundle
      );
      const controller = new AbortController();
      this.providerAbort = { reservation, controller };
      const guidance = unique([
        ...state.pendingGuidance,
        ...(request.guidance ?? []),
      ]);
      const factProjection = projectSessionProviderFactsV2(
        state,
        request.target
      );
      const providerInput = {
        providerTurnId,
        runId: state.runId,
        controlEpoch: state.controlEpoch,
        currentInput: currentSessionUserInputV2(state),
        conversationInputs: state.inputs,
        conversationInputOmittedCount:
          state.inputHistoryOmittedCount,
        providerOutcomes: state.providerOutcomes,
        providerOutcomeOmittedCount:
          state.providerOutcomeHistoryOmittedCount,
        sessionMemory: state.sessionMemory,
        providerProfile: state.providerProfile,
        ...(state.plan ? { plan: state.plan } : {}),
        ...(state.planDecision
          ? { planDecision: state.planDecision }
          : {}),
        kernelFacts: factProjection,
        target: request.target,
        guidance,
        toolContext: binding,
      };
      const contextAssembly = buildSessionProviderContextV2(
        providerInput
      );
      const startCommit = this.beginAdmissionCommit(
        reservation,
        generation
      );
      if (!startCommit) {
        return await this.settleStale(providerTurnId);
      }
      try {
        state.providerTurn = {
          providerTurnId,
          controlEpoch: state.controlEpoch,
          contextRef: binding.contextRef,
          factProjection: {
            snapshotHighWater: factProjection.snapshotHighWater,
            omittedCount: factProjection.omittedCount,
            factIds: factProjection.facts.map((fact) => fact.factId),
          },
          contextAssembly: contextAssembly.receipt,
          startedAt: this.ports.clock.now(),
          status: 'active',
        };
        this.providerAbort = { reservation, controller };
        await this.host.saveCheckpoint();
        await this.host.project(
          `provider:${providerTurnId}:started`,
          'provider.started',
          {
            providerTurnId,
            controlEpoch: state.controlEpoch,
            contextRef: binding.contextRef,
            factProjection: state.providerTurn.factProjection,
            contextAssembly: state.providerTurn.contextAssembly,
          }
        );
      } finally {
        this.endAdmissionCommit(startCommit);
      }
      if (this.resultIsStale(reservation, providerTurnId, generation)) {
        return await this.settleStale(providerTurnId);
      }

      let output;
      try {
        output = await this.ports.provider.requestTurn({
          ...providerInput,
          contextAssembly,
          signal: controller.signal,
        });
      } catch (error) {
        if (this.resultIsStale(reservation, providerTurnId, generation)) {
          return await this.settleStale(providerTurnId);
        }
        const failureCommit = this.beginAdmissionCommit(
          reservation,
          generation
        );
        if (!failureCommit) {
          return await this.settleStale(providerTurnId);
        }
        try {
          const latest = this.host.readState();
          if (latest.providerTurn?.providerTurnId === providerTurnId) {
            latest.providerTurn.status = 'failed';
            await this.host.saveCheckpoint();
            try {
              await this.host.project(
                `provider:${providerTurnId}:failed`,
                'diagnostic',
                {
                  providerTurnId,
                  code: safeErrorCode(error),
                  message: safeErrorMessage(error),
                  stage: 'provider.requestTurn',
                }
              );
            } catch {
              // The failed Provider checkpoint is already durable. Preserve
              // its no-effect boundary even if diagnostic projection fails.
            }
          }
        } finally {
          this.endAdmissionCommit(failureCommit);
        }
        throw error;
      } finally {
        if (this.providerAbort?.reservation === reservation) {
          this.providerAbort = undefined;
        }
      }

      if (this.resultIsStale(reservation, providerTurnId, generation)) {
        return await this.settleStale(providerTurnId);
      }

      let result: SessionKernelLoopResultV2 | undefined;
      let toolIntent: ToolIntentV2 | undefined;
      const outputCommit = this.beginAdmissionCommit(
        reservation,
        generation
      );
      if (!outputCommit) {
        return await this.settleStale(providerTurnId);
      }
      try {
        this.host.readState().pendingGuidance = [];
        try {
          if (output.kind === 'answer') {
            result = { kind: 'answer', text: output.text };
          } else if (output.kind === 'plan') {
            await this.host.recordProviderPlan(output.plan);
            result = { kind: 'plan', plan: output.plan };
          } else if (output.kind === 'noTool') {
            result = {
              kind: 'noTool',
              ...(output.guidance ? { guidance: output.guidance } : {}),
            };
          } else {
            toolIntent = this.normalizeOutput(output.source, request);
          }
        } catch (error) {
          if (this.resultIsStale(
            reservation,
            providerTurnId,
            generation
          )) {
            return await this.settleStale(providerTurnId);
          }
          const latest = this.host.readState();
          if (latest.providerTurn?.providerTurnId === providerTurnId) {
            latest.providerTurn.status = 'failed';
            await this.host.saveCheckpoint();
            await this.host.project(
              `provider:${providerTurnId}:failed`,
              'diagnostic',
              {
                providerTurnId,
                code: safeErrorCode(error),
                stage: 'provider.outputAdmission',
              }
            );
          }
          throw error;
        }
      } finally {
        this.endAdmissionCommit(outputCommit);
      }

      if (toolIntent) {
        try {
          result = await this.submitIntentOnce(toolIntent);
        } catch (error) {
          if (this.resultIsStale(
            reservation,
            providerTurnId,
            generation
          )) {
            return await this.settleStale(providerTurnId);
          }
          const failureCommit = this.beginAdmissionCommit(
            reservation,
            generation
          );
          if (!failureCommit) {
            return await this.settleStale(providerTurnId);
          }
          try {
            const latest = this.host.readState();
            if (latest.providerTurn?.providerTurnId === providerTurnId) {
              latest.providerTurn.status = 'failed';
              await this.host.saveCheckpoint();
              await this.host.project(
                `provider:${providerTurnId}:failed`,
                'diagnostic',
                {
                  providerTurnId,
                  code: safeErrorCode(error),
                  stage: 'provider.outputAdmission',
                }
              );
            }
          } finally {
            this.endAdmissionCommit(failureCommit);
          }
          throw error;
        }
        if (this.resultIsStale(
          reservation,
          providerTurnId,
          generation
        )) {
          return await this.settleStale(providerTurnId);
        }
        const reconcileCommit = this.beginAdmissionCommit(
          reservation,
          generation
        );
        if (!reconcileCommit) {
          return await this.settleStale(providerTurnId);
        }
        try {
          await this.host.reconcileFacts();
        } finally {
          this.endAdmissionCommit(reconcileCommit);
        }
      }

      if (this.resultIsStale(reservation, providerTurnId, generation)) {
        return await this.settleStale(providerTurnId);
      }
      if (!result) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_provider_result_missing',
          'Provider output admission did not produce a Session result.'
        );
      }
      const terminalCommit = this.beginAdmissionCommit(
        reservation,
        generation
      );
      if (!terminalCommit) {
        return await this.settleStale(providerTurnId);
      }
      try {
        const current = this.host.readState();
        let planActionSettlement:
          | SessionPlanActionSettlementV2
          | undefined;
        if (
          request.target.kind === 'planAction'
          && (output.kind === 'answer' || output.kind === 'noTool')
        ) {
          planActionSettlement =
            this.host.settlePlanActionCompleted(
              request.target.planActionId,
              output.kind,
              providerTurnId
            );
        }
        current.providerTurn!.status = 'completed';
        recordSessionProviderOutcomeV2(current, {
          providerTurnId,
          outputKind: output.kind,
          recordedAt: this.ports.clock.now(),
          ...providerOutcomeSummary(output),
          providerResult: output.providerResult,
        });
        await this.host.saveCheckpoint();
        await this.host.project(
          `provider:${providerTurnId}:completed`,
          'provider.completed',
          {
            providerTurnId,
            controlEpoch: current.providerTurn!.controlEpoch,
            outputKind: output.kind,
            result,
            providerOutcome: output.providerResult,
          }
        );
        if (planActionSettlement) {
          await this.host.project(
            `plan-action:${planActionSettlement.planActionId}:completed`,
            'planAction.completed',
            planActionSettlement,
            planActionSettlement.recordedAt
          );
        }
      } finally {
        this.endAdmissionCommit(terminalCommit);
      }
      return result;
    } finally {
      if (this.reservation === reservation) {
        this.reservation = undefined;
      }
    }
  }

  private async refreshToolContextAtBoundary(): Promise<void> {
    const state = this.host.readState();
    if (!state.toolContext.refreshRequired) return;
    const outcome = await this.requests.execute(
      this.requests.newRecord({
        kind: 'toolContextGet',
        payload: {
          knownContext: toolContextRefV2(state.toolContext.bundle),
        },
      })
    );
    expectSessionKernelPublicRequestOutcomeV2(outcome, 'toolContextGet');
  }

  private assertMayReconcileProviderBoundary(): void {
    if (this.userInputFenceGeneration !== undefined) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_user_input_admission_fenced',
        'Provider boundary reconciliation is fenced until the ordered user input transition is durable.'
      );
    }
    if (this.host.transitionBlocked()) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_authority_transition_active',
        'A serialized Session authority transition is active.'
      );
    }
    this.host.requireNoPendingRequests();
  }

  private boundaryIsCurrent(
    reservation: symbol,
    generation: number
  ): boolean {
    return this.reservation === reservation
      && generation === this.authorityGeneration
      && this.userInputFenceGeneration === undefined;
  }

  private normalizeOutput(
    source: ProviderKernelToolSourceV2,
    request: SessionProviderTurnRequestV2
  ): ToolIntentV2 {
    const state = this.host.readState();
    const toolId = providerSourceToolId(source);
    const descriptor = state.toolContext.bundle.tools.find(
      (tool) => tool.toolId === toolId
    );
    if (!descriptor || descriptor.availability !== 'ready') {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_unavailable',
        `Provider requested a tool outside the current ready ToolContext: ${toolId}.`
      );
    }
    if (request.target.kind === 'planning') {
      if (descriptor.effectClass !== 'read') {
        throw new SessionKernelProviderTurnError(
          'session_kernel_planning_mutation_forbidden',
          'A planning turn cannot invoke a mutation without a confirmed PlanAction.'
        );
      }
      const identity = providerCallIdentity(
        state,
        source,
        `planning:${toolId}`
      );
      return normalizeProviderKernelToolIntentV2(source, {
        runId: state.runId,
        controlEpoch: state.controlEpoch,
        operationId: identity.operationId,
        authority: contextReadAuthorityV2(
          `Session planning context read using ${toolId}.`
        ),
        idempotencyKey: identity.idempotencyKey,
        toolContext: state.toolContext.bundle,
      });
    }
    if (request.target.kind === 'planAction') {
      const action = sessionPlanActionV2(
        state,
        request.target.planActionId
      );
      if (toolId !== action.manifest.toolId) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_plan_action_tool_mismatch',
          'Provider tool does not match the persisted PlanAction tool.'
        );
      }
      const identity = providerCallIdentity(
        state,
        source,
        `planAction:${action.manifest.planActionId}`
      );
      const lease = latestPlanActionLease(
        state,
        action.manifest.planActionId
      );
      return normalizeProviderKernelToolIntentV2(source, {
        runId: state.runId,
        controlEpoch: state.controlEpoch,
        operationId: identity.operationId,
        authority: planActionAuthorityV2({
          planRevision: action.manifest.planRevision,
          planActionId: action.manifest.planActionId,
          ...(lease ? { lease } : {}),
        }),
        idempotencyKey: identity.idempotencyKey,
        toolContext: state.toolContext.bundle,
        deadline: action.deadline,
      });
    }
    if (descriptor.effectClass !== 'read') {
      throw new SessionKernelProviderTurnError(
        'session_kernel_context_read_mutation_forbidden',
        'A contextRead turn cannot invoke a mutation tool.'
      );
    }
    return normalizeProviderKernelToolIntentV2(source, {
      runId: state.runId,
      controlEpoch: state.controlEpoch,
      operationId: request.target.operationId,
      authority: contextReadAuthorityV2(request.target.purpose),
      idempotencyKey: request.target.idempotencyKey,
      toolContext: state.toolContext.bundle,
      ...(request.target.deadline
        ? { deadline: request.target.deadline }
        : {}),
    });
  }

  private async submitIntentOnce(
    intent: ToolIntentV2
  ): Promise<SessionKernelLoopResultV2> {
    const outcome = await this.requests.execute(
      this.requests.newRecord({
        kind: 'toolIntentSubmit',
        payload: { intent },
      })
    );
    const reply = expectSessionKernelPublicRequestOutcomeV2(
      outcome,
      'toolIntentSubmit'
    ).reply;
    if (reply.kind === 'admitted') {
      return {
        kind: 'admitted',
        operationId: reply.data.operationId,
        invocationId: reply.data.invocationId,
      };
    }
    if (reply.kind === 'awaitingCapability') {
      return {
        kind: 'awaitingCapability',
        operationId: reply.data.operationId,
        invocationId: reply.data.invocationId,
        preview: reply.data.preview,
      };
    }
    if (
      reply.data.reason === 'runBusy'
      || reply.data.reason === 'capacityExceeded'
    ) {
      const wait = this.host.readState().activeWait;
      return {
        kind: 'retryScheduled',
        operationId: reply.data.operationId,
        retryAt:
          wait?.kind === 'backpressure'
            ? wait.retryAt
            : this.ports.clock.now(),
      };
    }
    if (reply.data.reason === 'indeterminateRecoveryRequired') {
      return {
        kind: 'manualRecovery',
        operationId: reply.data.operationId,
      };
    }
    return {
      kind: 'rejected',
      operationId: reply.data.operationId,
      guidance: reply.data.guidance,
    };
  }

  private assertMayRun(request: SessionProviderTurnRequestV2): void {
    const state = this.host.readState();
    if (this.userInputFenceGeneration !== undefined) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_user_input_admission_fenced',
        'Provider output admission is fenced until the ordered user input transition is durable.'
      );
    }
    if (this.host.transitionBlocked()) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_authority_transition_active',
        'A serialized Session authority transition is active.'
      );
    }
    this.host.requireNoPendingRequests();
    if (
      state.kernelWakeHint
      || !sessionKernelFactsCaughtUpV2(state.lineage)
      || sessionKernelFactBarriersPendingV2(state)
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_facts_not_caught_up',
        'Provider execution is blocked until durable Kernel facts reach the advertised high-water mark.'
      );
    }
    if (state.activeWait) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_active_wait',
        `Provider execution is blocked by ${state.activeWait.kind}.`
      );
    }
    if (request.target.kind === 'planAction') {
      this.host.requirePlanProjected();
      this.host.requirePlanAccepted();
      sessionPlanActionV2(state, request.target.planActionId);
      if (state.planActionSettlements[request.target.planActionId]) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_plan_action_already_settled',
          `PlanAction ${request.target.planActionId} is already settled.`
        );
      }
    }
  }

  private resultIsStale(
    reservation: symbol,
    providerTurnId: string,
    generation: number
  ): boolean {
    const turn = this.host.readState().providerTurn;
    return this.reservation !== reservation
      || generation !== this.authorityGeneration
      || turn?.providerTurnId !== providerTurnId
      || turn.controlEpoch !== this.host.readState().controlEpoch
      || (turn.status !== 'active' && turn.status !== 'completed');
  }

  private async settleStale(
    providerTurnId: string
  ): Promise<SessionKernelLoopResultV2> {
    const state = this.host.readState();
    const providerTurn = state.providerTurn?.providerTurnId === providerTurnId
      ? state.providerTurn
      : undefined;
    if (
      providerTurn
      && (
        providerTurn.status === 'active'
        || providerTurn.status === 'completed'
      )
    ) {
      providerTurn.status = 'stale';
      await this.host.saveCheckpoint();
    }
    await this.host.project(
      `provider:${providerTurnId}:stale`,
      'provider.stale',
      {
        providerTurnId,
        ...(providerTurn
          ? { controlEpoch: providerTurn.controlEpoch }
          : {}),
      }
    );
    return { kind: 'staleProviderResult', providerTurnId };
  }

  private beginAdmissionCommit(
    reservation: symbol,
    generation: number
  ): symbol | undefined {
    if (
      this.reservation !== reservation
      || generation !== this.authorityGeneration
      || this.userInputFenceGeneration !== undefined
    ) {
      return undefined;
    }
    if (this.admissionCommit) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_commit_concurrent',
        'Provider admission commit phases must be serialized.'
      );
    }
    const token = Symbol('providerAdmissionCommit');
    let resolve: () => void = () => {};
    const settled = new Promise<void>((complete) => {
      resolve = complete;
    });
    this.admissionCommit = { token, settled, resolve };
    return token;
  }

  private endAdmissionCommit(token: symbol): void {
    const commit = this.admissionCommit;
    if (!commit || commit.token !== token) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_commit_identity_mismatch',
        'Provider admission commit identity was lost.'
      );
    }
    this.admissionCommit = undefined;
    commit.resolve();
  }

  private begin(): symbol {
    if (this.reservation) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_turn_concurrent',
        'A provider turn is already active.'
      );
    }
    const reservation = Symbol('providerTurn');
    this.reservation = reservation;
    return reservation;
  }
}

function providerOutcomeSummary(
  output: import('./types.js').SessionProviderTurnOutputV2
): { summary?: string } {
  if (output.kind === 'answer') {
    return { summary: output.text.slice(0, 8_192) };
  }
  if (output.kind === 'noTool' && output.guidance) {
    return { summary: output.guidance.slice(0, 8_192) };
  }
  if (output.kind === 'plan') {
    return {
      summary: `${output.plan.title}\n${output.plan.objective}`
        .slice(0, 8_192),
    };
  }
  return {};
}

function providerSourceToolId(
  source: ProviderKernelToolSourceV2
): string {
  return source.source === 'providerNative'
    ? source.toolId
    : decodeProviderToolIntentTextFrameV2(source.frame).toolId;
}

function providerCallIdentity(
  state: SessionKernelLoopStateV2,
  source: ProviderKernelToolSourceV2,
  authorityKey: string
): {
  operationId: string;
  idempotencyKey: string;
} {
  const providerTurnId = state.providerTurn?.providerTurnId;
  if (
    !providerTurnId
    || state.providerTurn?.status !== 'active'
  ) {
    throw new SessionKernelProviderTurnError(
      'session_kernel_provider_call_identity_missing',
      'A Provider call requires an active persisted Provider turn identity.'
    );
  }
  const callIdentity = source.source === 'providerNative'
    ? `native:${source.callId}`
    : `text:${sha256Hash(source.frame.trim())}`;
  const digest = sha256Hash(canonicalJson({
    runId: state.runId,
    controlEpoch: state.controlEpoch,
    providerTurnId,
    callIdentity,
    authorityKey,
  })).slice('sha256:'.length);
  return {
    operationId: `operation-${digest}`,
    idempotencyKey: `intent-${digest}`,
  };
}

function latestPlanActionLease(
  state: SessionKernelLoopStateV2,
  planActionId: string
): CapabilityLeaseRefV2 | undefined {
  const operationIds =
    state.lineage.planActions[planActionId]?.operationIds ?? [];
  const leases: CapabilityLeaseRefV2[] = [];
  for (const operationId of operationIds) {
    leases.push(
      ...(state.lineage.operations[operationId]?.leases ?? [])
    );
  }
  if (leases.length === 0) return undefined;
  const latestVersion = leases.reduce(
    (maximum, lease) => Math.max(maximum, lease.version),
    -1
  );
  const candidates = leases.filter(
    (lease) => lease.version === latestVersion
  );
  const expected = candidates[0]!;
  if (
    candidates.some(
      (lease) =>
        lease.leaseId !== expected.leaseId
        || lease.scopeDigest !== expected.scopeDigest
    )
  ) {
    throw new SessionKernelProviderTurnError(
      'session_kernel_plan_action_lease_conflict',
      `PlanAction ${planActionId} has conflicting lease identities at version ${latestVersion}.`
    );
  }
  return { ...expected };
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(error.code)
  ) {
    return error.code;
  }
  return 'provider_request_failed';
}

function safeErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message.trim();
  if (
    !message
    || new TextEncoder().encode(message).byteLength > 2_048
  ) {
    return undefined;
  }
  return message;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

export class SessionKernelProviderTurnError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelProviderTurnError';
  }
}
