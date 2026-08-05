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
  currentSessionWorkAuthorityV3,
  recordSessionContextReadWorkAuthorityV3,
  recordSessionProviderOutcomeV2,
  sameSessionWorkAuthorityV3,
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
  finalizeSessionKernelReviewV2,
  sameSessionFinalAnswerAuthorityV3,
  sameSessionFinalAnswerBindingV3,
} from './review.js';
import {
  abortSessionProviderToolCallQueueV2,
  activeSessionProviderToolCallQueueV2,
  createSessionProviderToolCallQueueV2,
  prepareSessionProviderToolCallSubmissionV2,
  publicSessionProviderOrderedItemsV2,
  publicSessionProviderToolCallQueueItemsV2,
  type SessionProviderToolCallQueueV2,
} from './providerToolCallQueue.js';
import {
  normalizeProviderKernelToolIntentV2,
  type ProviderKernelToolSourceV2,
} from './toolIntent.js';
import {
  decodeCompletedProviderTerminalV3,
  decodeProviderPlanProposalArgumentsV2,
} from './SessionKernelHttpProviderBackendV2.js';
import {
  adaptSessionKernelProviderBackendOutputV2,
  SESSION_PROVIDER_PLAN_PROPOSAL_V2_TOOL_NAME,
} from './SessionKernelProviderAdapterV2.js';
import type { SessionKernelLoopPortsV2 } from './ports.js';
import type {
  SessionKernelLoopResultV2,
  SessionNaturalLanguagePlanV2,
  SessionPlanActionSettlementV2,
  SessionKernelProjectionEventV2,
  SessionKernelPublicRequestRecordV2,
  SessionProviderTurnTargetV2,
  SessionProviderTurnRequestV2,
  SessionProviderTurnDurableEvidenceV3,
  SessionProviderTurnDispatchRecordV3,
  SessionProviderTurnInputV2,
  SessionProviderTurnOutputV2,
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

  settleProviderToolCallQueue(): Promise<void>;

  recordProviderPlan(
    plan: SessionNaturalLanguagePlanV2
  ): Promise<void>;

  settlePlanActionCompleted(
    planActionId: string,
    completionKind: 'answer' | 'noTool',
    providerTurnId: string,
    recordedAt: string
  ): SessionPlanActionSettlementV2;

  transitionBlocked(): boolean;

  requireNoPendingRequests(): void;

  requirePlanProjected(): void;

  requirePlanAccepted(): void;
}

type SessionProviderEvidenceBindingInputV3 = Pick<
  SessionProviderTurnInputV2,
  | 'providerTurnId'
  | 'purpose'
  | 'runId'
  | 'controlEpoch'
  | 'currentInput'
  | 'providerProfile'
  | 'plan'
  | 'target'
> & {
  expectedPlanRevision?: string;
  contextAssembly: Pick<
    SessionProviderTurnInputV2['contextAssembly'],
    'receipt'
  >;
};

type SessionProviderSealedInputV3 =
  SessionProviderEvidenceBindingInputV3
  & Pick<SessionProviderTurnInputV2, 'toolContext'>;

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
    return this.supersedeForAuthorityTransition(
      'userInput',
      'userInput'
    );
  }

  supersedeForRunCancellation(): {
    generation: number;
    quiescence: Promise<void>;
  } {
    return this.supersedeForAuthorityTransition(
      'runCancelled',
      'userRequested'
    );
  }

  private supersedeForAuthorityTransition(
    cancellationReason: 'userInput' | 'runCancelled',
    abortReason: 'userInput' | 'userRequested'
  ): {
    generation: number;
    quiescence: Promise<void>;
  } {
    this.authorityGeneration += 1;
    this.userInputFenceGeneration = this.authorityGeneration;
    const quiescence =
      this.admissionCommit?.settled ?? Promise.resolve();
    this.providerAbort?.controller.abort(abortReason);
    this.providerAbort = undefined;
    this.reservation = undefined;
    const state = this.host.readState();
    abortSessionProviderToolCallQueueV2(
      state,
      cancellationReason,
      this.ports.clock.now()
    );
    if (
      state.providerTurn?.status === 'active'
      || state.providerTurn?.status === 'awaitingTools'
    ) {
      state.providerTurn.status = 'cancelled';
      state.providerTurn.cancellationReason = cancellationReason;
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
    if (request.target.kind !== 'finalAnswer') {
      return this.runOnce(request);
    }
    let currentRequest: SessionProviderTurnRequestV2 & {
      target: Extract<
        SessionProviderTurnTargetV2,
        { kind: 'finalAnswer' }
      >;
    } = {
      ...request,
      target: request.target,
    };
    for (;;) {
      const state = this.host.readState();
      const finalAnswer = state.finalAnswer;
      if (
        finalAnswer
        && !sameSessionFinalAnswerAuthorityV3(
          finalAnswer.binding,
          currentRequest.target
        )
      ) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_final_answer_binding_stale',
          'Final-answer request belongs to a superseded authority identity.'
        );
      }
      if (finalAnswer?.status === 'committed') {
        await this.ensureCommittedFinalAnswerProjected(state);
        return { kind: 'answer', text: finalAnswer.finalText! };
      }
      if (finalAnswer?.status === 'finalAnswerFailed') {
        return await this.projectFinalAnswerFailure(state);
      }
      if (
        finalAnswer?.status === 'pending'
        && !sameSessionFinalAnswerBindingV3(
          finalAnswer.binding,
          currentRequest.target
        )
      ) {
        currentRequest = {
          reason: 'finalAnswer',
          target: {
            kind: 'finalAnswer',
            ...cloneJson(finalAnswer.binding),
          },
        };
        continue;
      }
      if (finalAnswer?.status === 'stale') {
        const binding = await this.refreshFinalAnswerAfterDrift(
          currentRequest.target
        );
        const refreshed = this.host.readState().finalAnswer;
        if (refreshed?.status === 'finalAnswerFailed') {
          return await this.projectFinalAnswerFailure(
            this.host.readState()
          );
        }
        currentRequest = {
          reason: 'finalAnswer',
          target: { kind: 'finalAnswer', ...binding },
        };
        continue;
      }
      try {
        return await this.runOnce(currentRequest);
      } catch (error) {
        if (
          safeErrorCode(error)
            === 'session_kernel_final_answer_binding_stale'
        ) {
          const binding = await this.refreshFinalAnswerAfterDrift(
            currentRequest.target
          );
          const refreshed = this.host.readState().finalAnswer;
          if (refreshed?.status === 'finalAnswerFailed') {
            return await this.projectFinalAnswerFailure(
              this.host.readState()
            );
          }
          currentRequest = {
            reason: 'finalAnswer',
            target: { kind: 'finalAnswer', ...binding },
          };
          continue;
        }
        const failed = this.host.readState().finalAnswer;
        if (failed?.status !== 'requesting') throw error;
        const errorCode = safeErrorCode(error);
        const retry = finalAnswerFailureIsRetryable(error)
          && failed.physicalRequestCount < 3;
        this.host.readState().finalAnswer = retry
          ? {
              status: 'pending',
              binding: cloneJson(failed.binding),
              physicalRequestCount: failed.physicalRequestCount,
              lastErrorCode: errorCode,
            }
          : {
              status: 'finalAnswerFailed',
              binding: cloneJson(failed.binding),
              physicalRequestCount: failed.physicalRequestCount,
              providerTurnId: failed.providerTurnId,
              failedAt: this.ports.clock.now(),
              lastErrorCode: errorCode,
            };
        await this.host.saveCheckpoint();
        if (retry) continue;
        return await this.projectFinalAnswerFailure(
          this.host.readState()
        );
      }
    }
  }

  private async runOnce(
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
      if (
        request.target.kind === 'finalAnswer'
        && !finalAnswerTargetIsPendingCurrent(state, request.target)
      ) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_final_answer_binding_stale',
          'Final-answer request no longer binds the pending frozen Review.'
        );
      }
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
        purpose: request.target.kind === 'finalAnswer'
          ? 'finalAnswer' as const
          : request.reason === 'userInput'
            ? 'primary' as const
            : 'continuation' as const,
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
        ...(request.target.kind === 'finalAnswer' && state.review
          ? { review: state.review }
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
        if (state.providerToolCallQueue?.outcomeRecorded) {
          state.providerToolCallQueue = undefined;
        }
        if (request.target.kind === 'finalAnswer') {
          const finalAnswer = state.finalAnswer;
          if (
            !finalAnswer
            || finalAnswer.status !== 'pending'
            || !sameSessionFinalAnswerBindingV3(
              finalAnswer.binding,
              request.target
            )
            || finalAnswer.physicalRequestCount >= 3
          ) {
            throw new SessionKernelProviderTurnError(
              'session_kernel_final_answer_binding_stale',
              'Final-answer request no longer binds the pending frozen Review.'
            );
          }
          state.finalAnswer = {
            status: 'requesting',
            binding: cloneJson(finalAnswer.binding),
            // A reservation is not a physical request. This runtime cache is
            // advanced only after a matching daemon-written dispatch exists.
            physicalRequestCount: finalAnswer.physicalRequestCount,
            providerTurnId,
            startedAt: this.ports.clock.now(),
          };
        }
        state.providerTurn = {
          providerTurnId,
          purpose: providerInput.purpose,
          target: cloneJson(request.target),
          ...(state.plan
            ? { planRevision: state.plan.planRevision }
            : {}),
          ...(request.target.kind === 'planAction'
            ? {
                remainingToolCallBudget:
                  request.remainingToolCallBudget,
              }
            : {}),
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

      let output: SessionProviderTurnOutputV2;
      let completedTerminalRecordedAt: string | undefined;
      try {
        const liveOutput = await this.ports.provider.requestTurn({
          ...providerInput,
          contextAssembly,
          publicTextObserver: this.publicTextObserverForTurn(
            reservation,
            generation,
            providerTurnId,
            state.controlEpoch
          ),
          publicActivityObserver: this.publicActivityObserverForTurn(
            reservation,
            generation,
            providerTurnId,
            state.controlEpoch
          ),
          signal: controller.signal,
        });
        const evidence = await this.ports.persistence
          .loadProviderTurnEvidence(state.runId, providerTurnId);
        output = this.decodeCompletedProviderOutput(
          {
            ...providerInput,
            expectedPlanRevision: providerInput.plan?.planRevision,
            contextAssembly,
          },
          evidence,
          liveOutput
        );
        completedTerminalRecordedAt = evidence.terminal!.recordedAt;
      } catch (error) {
        if (this.resultIsStale(reservation, providerTurnId, generation)) {
          return await this.settleStale(providerTurnId);
        }
        const latest = this.host.readState();
        const evidence = await this.ports.persistence
          .loadProviderTurnEvidence(latest.runId, providerTurnId);
        let recoveredOutput: SessionProviderTurnOutputV2 | undefined;
        let terminalError: unknown = error;
        if (evidence.terminal?.data.terminalKind === 'completed') {
          try {
            recoveredOutput = this.decodeCompletedProviderOutput(
              {
                ...providerInput,
                expectedPlanRevision: providerInput.plan?.planRevision,
                contextAssembly,
              },
              evidence
            );
            completedTerminalRecordedAt = evidence.terminal.recordedAt;
          } catch (decodeError) {
            terminalError = decodeError;
          }
        }
        if (recoveredOutput) {
          output = recoveredOutput;
        } else {
          const failureCommit = this.beginAdmissionCommit(
            reservation,
            generation
          );
          if (!failureCommit) {
            return await this.settleStale(providerTurnId);
          }
          try {
            if (latest.providerTurn?.providerTurnId === providerTurnId) {
              latest.providerTurn.status =
                evidence.terminal?.data.terminalKind === 'completed'
                  ? 'failed'
                  : bindFailedProviderEvidenceV3(
                      latest,
                      {
                        ...providerInput,
                        expectedPlanRevision:
                          providerInput.plan?.planRevision,
                        contextAssembly,
                      },
                      evidence
                    );
              await this.host.saveCheckpoint();
              if (request.target.kind !== 'finalAnswer') {
                try {
                  await this.host.project(
                    `provider:${providerTurnId}:failed`,
                    'diagnostic',
                    {
                      providerTurnId,
                      status: 'failed',
                      terminalScope: 'turn',
                      code: safeErrorCode(terminalError),
                      message: safeErrorMessage(terminalError),
                      stage:
                        evidence.terminal?.data.terminalKind === 'completed'
                          ? 'provider.outputValidation'
                          : 'provider.requestTurn',
                      ...(evidence.terminal?.data.terminalKind === 'completed'
                        ? {
                            providerOutcome:
                              evidence.terminal.data.providerResult,
                          }
                        : {}),
                    }
                  );
                } catch {
                  // The failed Provider checkpoint is already durable.
                  // Preserve its no-effect boundary even if diagnostic
                  // projection fails.
                }
              }
            }
          } finally {
            this.endAdmissionCommit(failureCommit);
          }
          throw terminalError;
        }
      } finally {
        if (this.providerAbort?.reservation === reservation) {
          this.providerAbort = undefined;
        }
      }

      if (this.resultIsStale(reservation, providerTurnId, generation)) {
        return await this.settleStale(providerTurnId);
      }

      let result: SessionKernelLoopResultV2 | undefined;
      let queuedToolIntents = false;
      const outputCommit = this.beginAdmissionCommit(
        reservation,
        generation
      );
      if (!outputCommit) {
        return await this.settleStale(providerTurnId);
      }
      try {
        try {
          const admission = await this.admitProviderOutput(
            request,
            output,
            providerTurnId
          );
          result = admission.result;
          queuedToolIntents = admission.queuedToolIntents;
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
            if (request.target.kind !== 'finalAnswer') {
              await this.host.project(
                `provider:${providerTurnId}:failed`,
                'diagnostic',
                {
                  providerTurnId,
                  code: safeErrorCode(error),
                  message: safeErrorMessage(error),
                  stage: 'provider.outputAdmission',
                  providerOutcome: output.providerResult,
                }
              );
            }
          }
          throw error;
        }
      } finally {
        this.endAdmissionCommit(outputCommit);
      }

      if (request.target.kind === 'finalAnswer') {
        if (output.kind !== 'answer') {
          throw new SessionKernelProviderTurnError(
            'session_kernel_final_answer_output_invalid',
            'A final-answer turn must produce one non-empty answer.'
          );
        }
        await this.host.reconcileFacts();
        if (!finalAnswerBindingIsCurrent(
          this.host.readState(),
          request.target,
          providerTurnId
        )) {
          throw new SessionKernelProviderTurnError(
            'session_kernel_final_answer_binding_stale',
            'Canonical facts changed before the final answer could be committed.'
          );
        }
      }

      if (queuedToolIntents) {
        const queue = activeSessionProviderToolCallQueueV2(
          this.host.readState()
        );
        if (!queue) {
          throw new SessionKernelProviderTurnError(
            'session_kernel_provider_tool_call_queue_missing',
            'Durable Provider response lost its ordered tool-call queue before projection.'
          );
        }
        await this.ensureQueuedProviderResponseProjected(queue);
        try {
          result = await this.submitNextQueuedIntent();
        } catch (error) {
          if (this.resultIsStale(
            reservation,
            providerTurnId,
            generation
          )) {
            return await this.settleStale(providerTurnId);
          }
          await this.host.settleProviderToolCallQueue();
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
          await this.host.settleProviderToolCallQueue();
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
      if (output.kind === 'toolIntent') {
        return result;
      }
      const terminalCommit = this.beginAdmissionCommit(
        reservation,
        generation
      );
      if (!terminalCommit) {
        return await this.settleStale(providerTurnId);
      }
      try {
        if (!completedTerminalRecordedAt) {
          throw new SessionKernelProviderTurnError(
            'session_kernel_provider_terminal_evidence_mismatch',
            'Provider completion has no durable terminal timestamp.'
          );
        }
        await this.completeProviderOutput(
          request,
          output,
          result,
          providerTurnId,
          completedTerminalRecordedAt
        );
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

  private async admitProviderOutput(
    request: SessionProviderTurnRequestV2,
    output: SessionProviderTurnOutputV2,
    providerTurnId: string
  ): Promise<{
    result: SessionKernelLoopResultV2;
    queuedToolIntents: boolean;
  }> {
    const acceptingState = this.host.readState();
    acceptingState.pendingGuidance = [];
    if (
      acceptingState.providerTurn?.providerTurnId !== providerTurnId
      || acceptingState.providerTurn.status !== 'active'
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_turn_identity_mismatch',
        'Provider response cannot be attached to a different active turn.'
      );
    }
    const response = {
      items: cloneJson(output.items),
      completion: cloneJson(output.completion),
    };
    if (
      acceptingState.providerTurn.response
      && canonicalJson(acceptingState.providerTurn.response)
        !== canonicalJson(response)
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_response_recovery_conflict',
        'Recovered Provider response differs from the durable active reservation.'
      );
    }
    acceptingState.providerTurn.response = response;
    await this.host.saveCheckpoint();

    if (output.kind === 'answer') {
      return {
        result: { kind: 'answer', text: output.text },
        queuedToolIntents: false,
      };
    }
    if (output.kind === 'plan') {
      await this.host.recordProviderPlan(output.plan);
      return {
        result: { kind: 'plan', plan: output.plan },
        queuedToolIntents: false,
      };
    }
    if (output.kind === 'noTool') {
      return {
        result: {
          kind: 'noTool',
          ...(output.guidance ? { guidance: output.guidance } : {}),
        },
        queuedToolIntents: false,
      };
    }
    if (
      request.target.kind === 'planAction'
      && output.sources.length > request.remainingToolCallBudget!
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_call_budget_exceeded',
        [
          'Provider output exceeds the remaining PlanAction tool-call',
          `budget (${output.sources.length} requested,`,
          `${request.remainingToolCallBudget} remaining).`,
        ].join(' ')
      );
    }
    const intents = output.sources.map((source, index) =>
      this.normalizeOutput(
        source,
        request,
        index,
        output.sources.length
      )
    );
    const latest = this.host.readState();
    if (intents[0]?.authority.kind === 'contextRead') {
      recordSessionContextReadWorkAuthorityV3(latest, intents);
    }
    latest.providerToolCallQueue =
      createSessionProviderToolCallQueueV2({
        providerTurnId,
        controlEpoch: latest.controlEpoch,
        target: request.target,
        receipt: output.receipt,
        providerResult: output.providerResult,
        orderedItems: output.items,
        completion: output.completion,
        intents,
      });
    latest.providerTurn!.status = 'awaitingTools';
    await this.host.saveCheckpoint();
    return {
      result: { kind: 'noTool' },
      queuedToolIntents: true,
    };
  }

  private async completeProviderOutput(
    request: SessionProviderTurnRequestV2,
    output: Exclude<SessionProviderTurnOutputV2, { kind: 'toolIntent' }>,
    result: SessionKernelLoopResultV2,
    providerTurnId: string,
    recordedAt: string
  ): Promise<void> {
    const current = this.host.readState();
    if (
      current.providerTurn?.providerTurnId !== providerTurnId
      || current.providerTurn.status !== 'active'
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_turn_identity_mismatch',
        'Provider completion cannot settle a different or inactive turn.'
      );
    }
    let planActionSettlement:
      | SessionPlanActionSettlementV2
      | undefined;
    if (
      request.target.kind === 'planAction'
      && (output.kind === 'answer' || output.kind === 'noTool')
    ) {
      planActionSettlement = this.host.settlePlanActionCompleted(
        request.target.planActionId,
        output.kind,
        providerTurnId,
        recordedAt
      );
    }
    if (request.target.kind === 'finalAnswer') {
      if (result.kind !== 'answer') {
        throw new SessionKernelProviderTurnError(
          'session_kernel_final_answer_output_invalid',
          'A final-answer turn cannot commit a non-answer result.'
        );
      }
      current.finalAnswer = {
        status: 'committed',
        binding: finalAnswerBindingFromTarget(request.target),
        physicalRequestCount:
          current.finalAnswer!.physicalRequestCount,
        providerTurnId,
        committedAt: recordedAt,
        finalText: result.text,
      };
    }
    current.providerTurn.status = 'completed';
    const outcome = {
      providerTurnId,
      outputKind: output.kind,
      recordedAt,
      ...providerOutcomeSummary(output),
      providerResult: output.providerResult,
    };
    const existingOutcome = current.providerOutcomes.find(
      (candidate) => candidate.providerTurnId === providerTurnId
    );
    if (
      existingOutcome
      && canonicalJson(existingOutcome) !== canonicalJson(outcome)
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_outcome_recovery_conflict',
        'Recovered Provider outcome conflicts with durable Session history.'
      );
    }
    if (!existingOutcome) {
      recordSessionProviderOutcomeV2(current, outcome);
    }
    await this.host.saveCheckpoint();
    await this.host.project(
      `provider:${providerTurnId}:completed`,
      'provider.completed',
      {
        providerTurnId,
        controlEpoch: current.providerTurn.controlEpoch,
        outputKind: output.kind,
        result,
        terminalScope:
          output.kind === 'answer'
          && (
            request.target.kind === 'finalAnswer'
            || currentSessionWorkAuthorityV3(current) === undefined
          )
            ? 'turn'
            : 'providerTurn',
        orderedItems: publicSessionProviderOrderedItemsV2(output.items),
        providerOutcome: output.providerResult,
      },
      recordedAt
    );
    if (planActionSettlement) {
      await this.host.project(
        `plan-action:${planActionSettlement.planActionId}:completed`,
        'planAction.completed',
        planActionSettlement,
        planActionSettlement.recordedAt
      );
    }
  }

  private decodeCompletedProviderOutput(
    input: SessionProviderSealedInputV3,
    evidence: SessionProviderTurnDurableEvidenceV3,
    liveOutput?: SessionProviderTurnOutputV2
  ): SessionProviderTurnOutputV2 {
    const terminal = evidence.terminal;
    if (
      !evidence.dispatch
      || !terminal
      || terminal.data.terminalKind !== 'completed'
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_terminal_evidence_mismatch',
        'Provider output is missing one exact completed daemon terminal.'
      );
    }
    const backendOutput = decodeCompletedProviderTerminalV3(
      input,
      terminal,
      input.providerProfile.providerProfileId
    );
    const output = adaptSessionKernelProviderBackendOutputV2(
      input,
      backendOutput,
      terminal.recordedAt
    );
    if (
      liveOutput
      && !sameProviderOutputIgnoringAdapterTimestampV3(
        liveOutput,
        output
      )
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_live_terminal_output_mismatch',
        'Live Provider output differs from deterministic terminal reconstruction.'
      );
    }
    bindProviderEvidenceV3(
      this.host.readState(),
      input,
      output,
      evidence
    );
    return output;
  }

  /**
   * Settles a daemon-sealed primary/continuation terminal that was persisted
   * before Session could cross its terminal checkpoint. Completed responses
   * use the exact live decode/admission path; non-completed terminals bind the
   * same dispatch authority and settle without another Provider request.
   */
  async recoverCompletedProviderTurn(): Promise<void> {
    const state = this.host.readState();
    const turn = state.providerTurn;
    if (!turn) return;
    if (turn.purpose === 'finalAnswer') {
      if (turn.target.kind !== 'finalAnswer') {
        throw new SessionKernelProviderTurnError(
          'session_kernel_provider_final_answer_purpose_mismatch',
          'Recovered final-answer reservation has a non-final target.'
        );
      }
      if (state.finalAnswer?.status === 'committed') {
        await this.ensureCommittedFinalAnswerProjected(state);
        return;
      }
      if (state.finalAnswer?.status === 'stale') {
        if (turn.status === 'active' || turn.status === 'completed') {
          turn.status = 'stale';
          await this.host.saveCheckpoint();
        }
        await this.refreshFinalAnswerAfterDrift(turn.target);
        return;
      }
      if (
        state.finalAnswer?.status !== 'requesting'
        || turn.status !== 'active'
      ) {
        return;
      }
    } else if (turn.status !== 'active') {
      return;
    }
    if (
      !turn.dispatchRef
      && !turn.terminalRef
      && !state.providerToolCallQueue
      && !state.providerOutcomes.some(
        (outcome) => outcome.providerTurnId === turn.providerTurnId
      )
    ) {
      // The reservation checkpoint precedes Daemon dispatch. No durable
      // dispatch means the Provider network boundary was never crossed, so
      // this Session-only identity can be abandoned without consuming a
      // physical request. The Host driver will re-plan the unsettled target
      // with a fresh providerTurnId after this durable checkpoint.
      state.providerTurn = undefined;
      await this.host.saveCheckpoint();
      return;
    }
    if (
      !turn.dispatchRef
      || !turn.terminalRef
      || state.providerToolCallQueue
      || state.providerOutcomes.some(
        (outcome) => outcome.providerTurnId === turn.providerTurnId
      )
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_recovery_state_invalid',
        'Active Provider recovery requires one terminal and no admitted outcome or tool queue.'
      );
    }
    this.host.requireNoPendingRequests();
    if (turn.controlEpoch !== state.controlEpoch) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_recovery_authority_mismatch',
        'Completed Provider terminal belongs to a stale control epoch.'
      );
    }
    const toolContext = providerToolContextBindingV2(
      await this.ports.persistence.loadToolContextSnapshot(
        state.runId,
        turn.contextRef
      )
    );
    const evidence = await this.ports.persistence
      .loadProviderTurnEvidence(state.runId, turn.providerTurnId);
    if (!evidence.dispatch || !evidence.terminal) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_terminal_evidence_mismatch',
        'Active Provider recovery has no exact daemon terminal.'
      );
    }
    const semanticInput = {
      providerTurnId: turn.providerTurnId,
      purpose: turn.purpose,
      runId: state.runId,
      currentInput: currentSessionUserInputV2(state),
      providerProfile: cloneJson(state.providerProfile),
      ...(state.plan?.planRevision === turn.planRevision
        ? { plan: cloneJson(state.plan) }
        : {}),
      target: cloneJson(turn.target),
      toolContext,
    };
    if (turn.target.kind === 'planAction' && !semanticInput.plan) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_recovery_plan_missing',
        'PlanAction terminal recovery requires its exact request Plan revision.'
      );
    }
    const sealedInput: SessionProviderSealedInputV3 = {
      ...semanticInput,
      controlEpoch: state.controlEpoch,
      expectedPlanRevision: turn.planRevision,
      contextAssembly: {
        receipt: cloneJson(turn.contextAssembly),
      },
    };
    if (evidence.terminal.data.terminalKind !== 'completed') {
      if (turn.response) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_provider_terminal_evidence_mismatch',
          'A non-completed Provider terminal cannot carry an admitted response.'
        );
      }
      turn.status = bindFailedProviderEvidenceV3(
        state,
        sealedInput,
        evidence
      );
      await this.host.saveCheckpoint();
      return;
    }
    if (!turn.response) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_recovery_state_invalid',
        'A completed Provider terminal has no deterministically reconstructed response.'
      );
    }
    const output = this.decodeCompletedProviderOutput(
      sealedInput,
      evidence
    );
    if (
      turn.target.kind === 'finalAnswer'
      && !finalAnswerBindingIsCurrent(
        this.host.readState(),
        turn.target,
        turn.providerTurnId
      )
    ) {
      const latest = this.host.readState();
      const finalAnswer = latest.finalAnswer;
      if (finalAnswer?.status !== 'requesting') {
        throw new SessionKernelProviderTurnError(
          'session_kernel_final_answer_binding_stale',
          'Recovered final answer lost its requesting authority state.'
        );
      }
      latest.finalAnswer = {
        status: 'stale',
        binding: cloneJson(finalAnswer.binding),
        physicalRequestCount: finalAnswer.physicalRequestCount,
        providerTurnId: turn.providerTurnId,
        staleAt: evidence.terminal.recordedAt,
        lastErrorCode:
          'session_kernel_final_answer_binding_stale',
      };
      latest.providerTurn!.status = 'stale';
      await this.host.saveCheckpoint();
      await this.refreshFinalAnswerAfterDrift(turn.target);
      return;
    }
    const request: SessionProviderTurnRequestV2 = {
      reason: 'recovery',
      target: cloneJson(turn.target),
      ...(turn.remainingToolCallBudget === undefined
        ? {}
        : {
            remainingToolCallBudget:
              turn.remainingToolCallBudget,
          }),
    };
    const admission = await this.admitProviderOutput(
      request,
      output,
      turn.providerTurnId
    );
    if (admission.queuedToolIntents) return;
    if (output.kind === 'toolIntent') {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_recovery_queue_missing',
        'Recovered tool output did not produce its durable ordered queue.'
      );
    }
    await this.completeProviderOutput(
      request,
      output,
      admission.result,
      turn.providerTurnId,
      evidence.terminal.recordedAt
    );
  }

  /**
   * Advances only the next durable call from an already accepted Provider
   * response. No new Provider request is made while this queue is active.
   */
  async resumePendingToolCalls():
  Promise<SessionKernelLoopResultV2 | undefined> {
    const existing = this.host.readState().providerToolCallQueue;
    if (!existing) return undefined;
    await this.ensureQueuedProviderResponseProjected(existing);
    if (existing.status !== 'active') {
      if (!existing.outcomeRecorded) {
        await this.host.settleProviderToolCallQueue();
      }
      return undefined;
    }
    const queued = existing;
    const reservation = this.begin();
    const generation = this.authorityGeneration;
    const providerTurnId = queued.providerTurnId;
    try {
      const submitting = queued.calls.find(
        (candidate) => candidate.status === 'submitting'
      );
      if (submitting) {
        this.assertMayReplayQueuedSubmission(submitting.requestId!);
        const result = await this.submitNextQueuedIntent();
        if (this.resultIsStale(
          reservation,
          providerTurnId,
          generation
        )) {
          return await this.settleStale(providerTurnId);
        }
        await this.host.reconcileFacts();
        await this.host.settleProviderToolCallQueue();
        return result;
      }
      this.assertMayReconcileProviderBoundary();
      await this.host.reconcileFacts();
      await this.host.settleProviderToolCallQueue();
      if (!this.boundaryIsCurrent(reservation, generation)) {
        return await this.settleStale(providerTurnId);
      }
      const state = this.host.readState();
      if (!activeSessionProviderToolCallQueueV2(state)) return undefined;
      if (state.activeWait) return undefined;
      this.assertMayAdvanceQueuedToolCall();
      const result = await this.submitNextQueuedIntent();
      if (this.resultIsStale(
        reservation,
        providerTurnId,
        generation
      )) {
        return await this.settleStale(providerTurnId);
      }
      await this.host.reconcileFacts();
      await this.host.settleProviderToolCallQueue();
      return result;
    } finally {
      if (this.reservation === reservation) {
        this.reservation = undefined;
      }
    }
  }

  private async ensureQueuedProviderResponseProjected(
    queue: SessionProviderToolCallQueueV2
  ): Promise<void> {
    await this.host.project(
      `provider:${queue.providerTurnId}:response-completed`,
      'provider.completed',
      {
        providerTurnId: queue.providerTurnId,
        controlEpoch: queue.controlEpoch,
        status: 'responseAccepted',
        outputKind: 'toolIntent',
        terminalScope: 'providerTurn',
        orderedItems:
          publicSessionProviderToolCallQueueItemsV2(queue, 'response'),
        providerOutcome: queue.providerResult,
      },
      queue.receipt.recordedAt
    );
  }

  private async ensureCommittedFinalAnswerProjected(
    state: SessionKernelLoopStateV2
  ): Promise<void> {
    const finalAnswer = state.finalAnswer;
    const providerTurn = state.providerTurn;
    if (
      finalAnswer?.status !== 'committed'
      || !finalAnswer.providerTurnId
      || providerTurn?.providerTurnId !== finalAnswer.providerTurnId
      || providerTurn.status !== 'completed'
      || !providerTurn.response
      || !finalAnswer.finalText
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_final_answer_projection_source_missing',
        'Committed final answer is missing its durable Provider response.'
      );
    }
    const outcome = [...state.providerOutcomes].reverse().find(
      (candidate) =>
        candidate.providerTurnId === finalAnswer.providerTurnId
        && candidate.outputKind === 'answer'
    );
    if (!outcome) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_final_answer_projection_source_missing',
        'Committed final answer is missing its durable Provider outcome.'
      );
    }
    await this.host.project(
      `provider:${finalAnswer.providerTurnId}:completed`,
      'provider.completed',
      {
        providerTurnId: finalAnswer.providerTurnId,
        controlEpoch: providerTurn.controlEpoch,
        outputKind: 'answer',
        result: { kind: 'answer', text: finalAnswer.finalText },
        terminalScope: 'turn',
        orderedItems: publicSessionProviderOrderedItemsV2(
          providerTurn.response.items
        ),
        providerOutcome: outcome.providerResult,
      },
      finalAnswer.committedAt
    );
  }

  private async projectFinalAnswerFailure(
    state: SessionKernelLoopStateV2
  ): Promise<Extract<
    SessionKernelLoopResultV2,
    { kind: 'finalAnswerFailed' }
  >> {
    const finalAnswer = state.finalAnswer;
    if (finalAnswer?.status !== 'finalAnswerFailed') {
      return finalAnswerFailedResult(state);
    }
    const failureIdentity = finalAnswer.providerTurnId
      ?? `recovery-${sha256Hash(canonicalJson({
        binding: finalAnswer.binding,
        physicalRequestCount: finalAnswer.physicalRequestCount,
        lastErrorCode: finalAnswer.lastErrorCode,
      })).slice('sha256:'.length)}`;
    let providerOutcome:
      | import('./types.js').SessionProviderResultMetadataV2
      | undefined;
    if (finalAnswer.providerTurnId) {
      try {
        const evidence = await this.ports.persistence
          .loadProviderTurnEvidence(
            state.runId,
            finalAnswer.providerTurnId
          );
        if (evidence.terminal?.data.terminalKind === 'completed') {
          providerOutcome = evidence.terminal.data.providerResult;
        }
      } catch {
        // Failure projection remains available even when its optional usage
        // metadata cannot be reloaded from the durable Provider terminal.
      }
    }
    await this.host.project(
      `provider:${failureIdentity}:final-answer-failed`,
      'diagnostic',
      {
        stage: 'provider.finalAnswer',
        status: 'failed',
        terminalScope: 'turn',
        ...(finalAnswer.providerTurnId
          ? { providerTurnId: finalAnswer.providerTurnId }
          : {}),
        code: finalAnswer.lastErrorCode,
        message: 'Final answer generation failed.',
        physicalRequestCount: finalAnswer.physicalRequestCount,
        controlEpoch: finalAnswer.binding.controlEpoch,
        reviewRevision: finalAnswer.binding.reviewRevision,
        snapshotHighWater: finalAnswer.binding.snapshotHighWater,
        ...(providerOutcome ? { providerOutcome } : {}),
      },
      finalAnswer.failedAt
    );
    return finalAnswerFailedResult(state);
  }

  private async refreshFinalAnswerAfterDrift(
    requested: Extract<
      SessionProviderTurnTargetV2,
      { kind: 'finalAnswer' }
    >
  ): Promise<import('./types.js').SessionFinalAnswerBindingV3> {
    const state = this.host.readState();
    const current = state.finalAnswer;
    if (
      current
      && sameSessionFinalAnswerBindingV3(current.binding, requested)
      && current.status !== 'stale'
    ) {
      state.finalAnswer = {
        status: 'stale',
        binding: cloneJson(current.binding),
        physicalRequestCount: current.physicalRequestCount,
        providerTurnId: current.providerTurnId,
        staleAt: this.ports.clock.now(),
        lastErrorCode:
          'session_kernel_final_answer_binding_stale',
      };
      const providerTurn = state.providerTurn;
      if (
        current.providerTurnId
        && providerTurn
        && providerTurn.providerTurnId === current.providerTurnId
        && (
          providerTurn.status === 'active'
          || providerTurn.status === 'completed'
        )
      ) {
        providerTurn.status = 'stale';
      }
    }
    const latest = this.host.readState();
    if (
      latest.finalAnswer
      && latest.finalAnswer.status !== 'stale'
      && !sameSessionFinalAnswerBindingV3(
        latest.finalAnswer.binding,
        requested
      )
    ) {
      return cloneJson(latest.finalAnswer.binding);
    }
    const review = finalizeSessionKernelReviewV2(
      latest,
      this.ports.clock.now()
    );
    latest.review = review;
    await this.host.saveCheckpoint();
    await this.host.project(
      `review:${review.revision}:${review.snapshotHighWater}:final`,
      'review.revised',
      review,
      review.finalizedAt
    );
    return cloneJson(latest.finalAnswer!.binding);
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

  private assertMayReplayQueuedSubmission(requestId: string): void {
    if (this.userInputFenceGeneration !== undefined) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_user_input_admission_fenced',
        'Queued submission recovery is fenced until the ordered user input transition is durable.'
      );
    }
    if (this.host.transitionBlocked()) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_authority_transition_active',
        'A serialized Session authority transition is active.'
      );
    }
    const pending = this.requests.pendingRecords();
    if (
      pending.some((record) =>
        record.lane !== 'effect'
        || record.requestId !== requestId
        || record.intent.kind !== 'toolIntentSubmit'
      )
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_call_recovery_conflict',
        'Queued Provider recovery found another unresolved Kernel request.'
      );
    }
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
    request: SessionProviderTurnRequestV2,
    index: number,
    callCount: number
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
    if (request.target.kind === 'finalAnswer') {
      throw new SessionKernelProviderTurnError(
        'session_kernel_final_answer_tool_forbidden',
        'A no-tools final-answer turn cannot admit a Provider tool call.'
      );
    } else if (request.target.kind === 'planAction') {
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
    const contextReadIdentity = callCount === 1
      ? {
          operationId: request.target.operationId,
          idempotencyKey: request.target.idempotencyKey,
        }
      : providerCallIdentity(
          state,
          source,
          [
            'contextRead',
            request.target.operationId,
            request.target.idempotencyKey,
            String(index + 1),
          ].join(':')
        );
    return normalizeProviderKernelToolIntentV2(source, {
      runId: state.runId,
      controlEpoch: state.controlEpoch,
      operationId: contextReadIdentity.operationId,
      authority: contextReadAuthorityV2(request.target.purpose),
      idempotencyKey: contextReadIdentity.idempotencyKey,
      toolContext: state.toolContext.bundle,
      ...(request.target.deadline
        ? { deadline: request.target.deadline }
        : {}),
    });
  }

  private async submitNextQueuedIntent():
  Promise<SessionKernelLoopResultV2> {
    const reservation = this.reservation;
    const generation = this.authorityGeneration;
    if (!reservation) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_call_reservation_missing',
        'Queued Provider submission requires a live Session reservation.'
      );
    }
    const state = this.host.readState();
    const queue = activeSessionProviderToolCallQueueV2(state);
    const item = queue?.calls.find((candidate) =>
      candidate.status !== 'completed'
    );
    if (
      !queue
      || !item
      || (
        item.status !== 'pending'
        && item.status !== 'submitting'
      )
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_call_queue_missing',
        'No resumable Provider tool call is available to submit.'
      );
    }
    let request: SessionKernelPublicRequestRecordV2;
    if (item.status === 'pending') {
      this.refreshPendingPlanActionLease(queue.target, item.intent);
      request = this.requests.newRecord({
        kind: 'toolIntentSubmit',
        payload: { intent: item.intent },
      });
      prepareSessionProviderToolCallSubmissionV2(state, {
        operationId: item.intent.operationId,
        requestId: request.requestId,
        requestStartedAt: request.startedAt,
      });
      await this.host.saveCheckpoint();
    } else {
      const pending = state.publicRequests.effect;
      if (pending) {
        if (
          pending.requestId !== item.requestId
          || pending.intent.kind !== 'toolIntentSubmit'
          || canonicalJson(pending.intent.payload.intent)
            !== canonicalJson(item.intent)
        ) {
          throw new SessionKernelProviderTurnError(
            'session_kernel_provider_tool_call_request_conflict',
            'The pending Kernel effect request does not match the durable Provider tool call.'
          );
        }
        request = pending;
      } else {
        request = {
          requestId: item.requestId!,
          lane: 'effect',
          intent: {
            kind: 'toolIntentSubmit',
            payload: { intent: item.intent },
          },
          startedAt: item.requestStartedAt!,
          attemptCount: 1,
        };
      }
    }
    try {
      const current = activeSessionProviderToolCallQueueV2(
        this.host.readState()
      )?.calls.find((candidate) =>
        candidate.status === 'submitting'
      );
      if (
        !this.boundaryIsCurrent(reservation, generation)
        || current?.requestId !== request.requestId
        || current.intent.operationId !== item.intent.operationId
      ) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_provider_tool_call_submission_superseded',
          'Queued Provider submission was superseded before Kernel dispatch.'
        );
      }
      const result = await this.submitIntentOnce(request);
      await this.host.settleProviderToolCallQueue();
      return result;
    } catch (error) {
      await this.host.settleProviderToolCallQueue();
      throw error;
    }
  }

  private async submitIntentOnce(
    request: SessionKernelPublicRequestRecordV2
  ): Promise<SessionKernelLoopResultV2> {
    const outcome = await this.requests.execute(request);
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

  private refreshPendingPlanActionLease(
    target: SessionProviderTurnTargetV2,
    intent: ToolIntentV2
  ): void {
    if (target.kind !== 'planAction') return;
    if (
      intent.authority.kind !== 'planAction'
      || intent.authority.data.planActionId !== target.planActionId
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_call_authority_mismatch',
        'Queued Provider tool-call authority no longer matches its PlanAction.'
      );
    }
    const lease = latestPlanActionLease(
      this.host.readState(),
      target.planActionId
    );
    if (lease) {
      intent.authority.data.lease = lease;
    } else {
      delete intent.authority.data.lease;
    }
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
    if (activeSessionProviderToolCallQueueV2(state)) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_call_queue_active',
        'A new Provider turn cannot start before the prior ordered tool-call queue settles.'
      );
    }
    if (
      state.providerToolCallQueue
      && !state.providerToolCallQueue.outcomeRecorded
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_call_settlement_required',
        'A settled Provider tool-call sequence must be durably projected before another Provider turn.'
      );
    }
    if (request.target.kind === 'planAction') {
      if (
        !Number.isSafeInteger(request.remainingToolCallBudget)
        || request.remainingToolCallBudget! <= 0
        || request.remainingToolCallBudget! > 256
      ) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_provider_tool_call_budget_invalid',
          'A PlanAction Provider turn requires a remaining tool-call budget between 1 and 256.'
        );
      }
      this.host.requirePlanProjected();
      this.host.requirePlanAccepted();
      sessionPlanActionV2(state, request.target.planActionId);
      if (state.planActionSettlements[request.target.planActionId]) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_plan_action_already_settled',
          `PlanAction ${request.target.planActionId} is already settled.`
        );
      }
    } else if (request.remainingToolCallBudget !== undefined) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_call_budget_unexpected',
        'Only a PlanAction Provider turn may carry a tool-call budget.'
      );
    }
  }

  private assertMayAdvanceQueuedToolCall(): void {
    const state = this.host.readState();
    this.host.requireNoPendingRequests();
    if (
      state.kernelWakeHint
      || !sessionKernelFactsCaughtUpV2(state.lineage)
      || sessionKernelFactBarriersPendingV2(state)
    ) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_facts_not_caught_up',
        'The next queued Provider tool call is blocked until canonical Kernel facts are caught up.'
      );
    }
    if (state.activeWait) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_active_wait',
        `Queued tool execution is blocked by ${state.activeWait.kind}.`
      );
    }
    if (!activeSessionProviderToolCallQueueV2(state)) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_provider_tool_call_queue_missing',
        'No active Provider tool-call queue is available.'
      );
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
      || (
        turn.status !== 'active'
        && turn.status !== 'awaitingTools'
        && turn.status !== 'completed'
        && turn.status !== 'aborted'
      );
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
        || providerTurn.status === 'awaitingTools'
        || providerTurn.status === 'completed'
        || providerTurn.status === 'aborted'
      )
    ) {
      providerTurn.status = 'stale';
      await this.host.saveCheckpoint();
    }
    if (state.runCancellation) {
      return { kind: 'staleProviderResult', providerTurnId };
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

  private publicTextObserverForTurn(
    reservation: symbol,
    generation: number,
    providerTurnId: string,
    controlEpoch: number
  ): NonNullable<SessionProviderTurnInputV2['publicTextObserver']> {
    return async (delta) => {
      if (
        delta.providerTurnId !== providerTurnId
        || !Number.isSafeInteger(delta.streamSequence)
        || delta.streamSequence <= 0
        || !Number.isSafeInteger(delta.textOrdinal)
        || delta.textOrdinal <= 0
        || (
          delta.providerPhase !== undefined
          && delta.providerPhase !== 'commentary'
        )
        || typeof delta.textDelta !== 'string'
        || delta.textDelta.length === 0
      ) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_provider_public_text_invalid',
          'Provider public text delta is invalid.'
        );
      }
      const commit = this.beginAdmissionCommit(
        reservation,
        generation
      );
      if (!commit) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_provider_publication_stale',
          'Provider public text delta belongs to a stale authority epoch.'
        );
      }
      try {
        const turn = this.host.readState().providerTurn;
        if (
          turn?.providerTurnId !== providerTurnId
          || turn.controlEpoch !== controlEpoch
          || turn.status !== 'active'
        ) {
          throw new SessionKernelProviderTurnError(
            'session_kernel_provider_publication_stale',
            'Provider public text delta no longer matches the active turn.'
          );
        }
        await this.host.project(
          `provider:${providerTurnId}:composing:${delta.streamSequence}`,
          'provider.composing',
          {
            providerTurnId,
            controlEpoch,
            streamSequence: delta.streamSequence,
            textOrdinal: delta.textOrdinal,
            ...(delta.providerPhase
              ? { providerPhase: delta.providerPhase }
              : {}),
            textDelta: delta.textDelta,
          }
        );
        if (this.resultIsStale(
          reservation,
          providerTurnId,
          generation
        )) {
          throw new SessionKernelProviderTurnError(
            'session_kernel_provider_publication_stale',
            'Provider public text delta was superseded during publication.'
          );
        }
      } finally {
        this.endAdmissionCommit(commit);
      }
    };
  }

  private publicActivityObserverForTurn(
    reservation: symbol,
    generation: number,
    providerTurnId: string,
    controlEpoch: number
  ): NonNullable<SessionProviderTurnInputV2['publicActivityObserver']> {
    return async (activity) => {
      if (
        activity.providerTurnId !== providerTurnId
        || !Number.isSafeInteger(activity.activitySequence)
        || activity.activitySequence <= 0
        || (
          activity.code !== 'provider.reasoning'
          && activity.code !== 'provider.composing'
        )
      ) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_provider_public_activity_invalid',
          'Provider public activity metadata is invalid.'
        );
      }
      const commit = this.beginAdmissionCommit(
        reservation,
        generation
      );
      if (!commit) {
        throw new SessionKernelProviderTurnError(
          'session_kernel_provider_publication_stale',
          'Provider public activity belongs to a stale authority epoch.'
        );
      }
      try {
        const turn = this.host.readState().providerTurn;
        if (
          turn?.providerTurnId !== providerTurnId
          || turn.controlEpoch !== controlEpoch
          || turn.status !== 'active'
        ) {
          throw new SessionKernelProviderTurnError(
            'session_kernel_provider_publication_stale',
            'Provider public activity no longer matches the active turn.'
          );
        }
        await this.host.project(
          `provider:${providerTurnId}:activity:${activity.activitySequence}`,
          'provider.started',
          {
            providerTurnId,
            controlEpoch,
            activitySequence: activity.activitySequence,
            currentActivityCode: activity.code,
          }
        );
        if (this.resultIsStale(
          reservation,
          providerTurnId,
          generation
        )) {
          throw new SessionKernelProviderTurnError(
            'session_kernel_provider_publication_stale',
            'Provider public activity was superseded during publication.'
          );
        }
      } finally {
        this.endAdmissionCommit(commit);
      }
    };
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

function bindProviderEvidenceV3(
  state: SessionKernelLoopStateV2,
  input: SessionProviderEvidenceBindingInputV3,
  output: SessionProviderTurnOutputV2,
  evidence: SessionProviderTurnDurableEvidenceV3
): void {
  const providerTurn = state.providerTurn;
  const dispatch = evidence.dispatch;
  const terminal = evidence.terminal;
  if (
    !providerTurn
    || providerTurn.providerTurnId !== input.providerTurnId
    || !dispatch
    || !terminal
    || terminal.data.terminalKind !== 'completed'
    || terminal.data.providerTurnId !== input.providerTurnId
    || terminal.data.responseDigest !== output.completion.responseDigest
    || canonicalJson(terminal.data.completion)
      !== canonicalJson(output.completion)
    || canonicalJson(terminal.data.providerResult)
      !== canonicalJson(output.providerResult)
    || !terminalItemsMatchProviderOutputV3(
      terminal.data.orderedItems,
      output,
      input.target.kind === 'planning'
    )
  ) {
    throw new SessionKernelProviderTurnError(
      'session_kernel_provider_terminal_evidence_mismatch',
      'Provider output is not bound to one matching completed daemon terminal.'
    );
  }
  requireProviderDispatchAuthorityV3(input, dispatch.data);
  bindProviderRecordRefsV3(state, evidence);
}

function bindFailedProviderEvidenceV3(
  state: SessionKernelLoopStateV2,
  input: SessionProviderEvidenceBindingInputV3,
  evidence: SessionProviderTurnDurableEvidenceV3
): 'failed' | 'cancelled' {
  if (evidence.dispatch && !evidence.terminal) {
    throw new SessionKernelProviderTurnError(
      'session_kernel_provider_dispatch_unresolved',
      'Provider dispatch has no reconstructible durable terminal; automatic resend is forbidden.'
    );
  }
  if (
    state.providerTurn?.providerTurnId !== input.providerTurnId
    || evidence.terminal?.data.terminalKind === 'completed'
  ) {
    throw new SessionKernelProviderTurnError(
      'session_kernel_provider_terminal_evidence_mismatch',
      'Provider failure is not bound to one matching non-completed daemon terminal.'
    );
  }
  if (evidence.dispatch) {
    requireProviderDispatchAuthorityV3(input, evidence.dispatch.data);
  }
  bindProviderRecordRefsV3(state, evidence);
  return evidence.terminal?.data.terminalKind === 'cancelled'
    ? 'cancelled'
    : 'failed';
}

function bindProviderRecordRefsV3(
  state: SessionKernelLoopStateV2,
  evidence: SessionProviderTurnDurableEvidenceV3
): void {
  const turn = state.providerTurn;
  if (!turn) return;
  const newlyDispatched = Boolean(
    evidence.dispatch && !turn.dispatchRef
  );
  if (
    (turn.dispatchRef && (
      !evidence.dispatch
      || canonicalJson(turn.dispatchRef)
        !== canonicalJson(evidence.dispatch.ref)
    ))
    || (turn.terminalRef && (
      !evidence.terminal
      || canonicalJson(turn.terminalRef)
        !== canonicalJson(evidence.terminal.ref)
    ))
  ) {
    throw new SessionKernelProviderTurnError(
      'session_kernel_provider_record_ref_conflict',
      'Provider durable record refs changed immutable identity.'
    );
  }
  if (evidence.dispatch) {
    turn.dispatchRef = cloneJson(evidence.dispatch.ref);
  }
  if (evidence.terminal) {
    turn.terminalRef = cloneJson(evidence.terminal.ref);
  }
  if (
    newlyDispatched
    && state.finalAnswer?.status === 'requesting'
    && state.finalAnswer.providerTurnId === turn.providerTurnId
  ) {
    state.finalAnswer.physicalRequestCount += 1;
    if (state.finalAnswer.physicalRequestCount > 3) {
      throw new SessionKernelProviderTurnError(
        'session_kernel_final_answer_request_budget_exceeded',
        'Durable final-answer dispatch count exceeds the retry budget.'
      );
    }
  }
}

function requireProviderDispatchAuthorityV3(
  input: SessionProviderEvidenceBindingInputV3,
  dispatch: SessionProviderTurnDispatchRecordV3['data']
): void {
  const currentInputSections = input.contextAssembly.receipt.trimming.sections
    .filter((section) => section.section === 'currentInput');
  const authority = dispatch.authorityBinding;
  const expectedPlanRevision = input.expectedPlanRevision;
  const expectedReviewRevision = input.target.kind === 'finalAnswer'
    ? input.target.reviewRevision
    : undefined;
  const expectedSnapshotHighWater = input.target.kind === 'finalAnswer'
    ? input.target.snapshotHighWater
    : undefined;
  if (
    dispatch.providerTurnId !== input.providerTurnId
    || dispatch.purpose !== input.purpose
    || authority.runId !== input.runId
    || authority.inputId !== input.currentInput.inputId
    || authority.controlEpoch !== input.controlEpoch
    || currentInputSections.length !== 1
    || authority.currentInputDigest !== currentInputSections[0]!.digest
    || authority.planRevision !== expectedPlanRevision
    || authority.reviewRevision !== expectedReviewRevision
    || authority.snapshotHighWater !== expectedSnapshotHighWater
    || authority.providerProfileId
      !== input.providerProfile.providerProfileId
    || authority.providerProfileRevisionDigest
      !== input.providerProfile.providerProfileRevisionDigest
  ) {
    throw new SessionKernelProviderTurnError(
      'session_kernel_provider_dispatch_authority_mismatch',
      'Provider dispatch does not bind the exact Session authority and context.'
    );
  }
}

function terminalItemsMatchProviderOutputV3(
  terminalItems: readonly import('./types.js').SessionProviderTerminalOrderedItemV3[],
  output: SessionProviderTurnOutputV2,
  planningTarget: boolean
): boolean {
  const outputItems = output.items;
  const terminalTextItems = terminalItems.filter(
    (item): item is Extract<
      import('./types.js').SessionProviderTerminalOrderedItemV3,
      { kind: 'text' }
    > => item.kind === 'text'
  );
  if (
    planningTarget
    && output.kind === 'plan'
  ) {
    try {
      const controlItems = terminalItems.filter(
        (item): item is Extract<
          import('./types.js').SessionProviderTerminalOrderedItemV3,
          { kind: 'toolCall' }
        > => item.kind === 'toolCall'
          && item.name === SESSION_PROVIDER_PLAN_PROPOSAL_V2_TOOL_NAME
      );
      if (
        controlItems.length !== 1
        || terminalTextItems.length + 1 !== terminalItems.length
        || terminalItems.at(-1) !== controlItems[0]
        || terminalTextItems.some(
          (item) => item.phase === 'final_answer'
        )
      ) {
        return false;
      }
      const draft = decodeProviderPlanProposalArgumentsV2(
        controlItems[0]!.arguments
      );
      const normalizedTextItems = terminalTextItems.map((item) => ({
        kind: 'text' as const,
        phase: 'commentary' as const,
        text: item.text,
      }));
      return canonicalJson(outputItems) === canonicalJson(normalizedTextItems)
        && providerPlanMatchesDraftV3(output.plan, draft);
    } catch {
      return false;
    }
  }
  if (terminalItems.length !== outputItems.length) return false;
  return terminalItems.every((terminal, index) => {
    const output = outputItems[index];
    if (terminal.kind === 'text') {
      return output?.kind === 'text'
        && terminal.phase === output.phase
        && terminal.text === output.text;
    }
    if (output?.kind !== 'toolCall' || output.source !== 'providerNative') {
      return false;
    }
    let rawArguments: unknown;
    try {
      rawArguments = JSON.parse(terminal.arguments);
    } catch {
      return false;
    }
    return terminal.callId === output.callId
      && terminal.name === output.toolName
      && canonicalJson(rawArguments) === canonicalJson(output.arguments);
  });
}

function providerPlanMatchesDraftV3(
  plan: SessionNaturalLanguagePlanV2,
  draft: ReturnType<typeof decodeProviderPlanProposalArgumentsV2>
): boolean {
  return plan.title === draft.title
    && plan.objective === draft.objective
    && plan.narrative === draft.narrative
    && plan.actions.length === draft.actions.length
    && draft.actions.every((actionDraft, index) => {
      const action = plan.actions[index];
      return action?.manifest.toolId === actionDraft.toolId
        && canonicalJson(action.manifest.requestedResources)
          === canonicalJson(actionDraft.requestedResources)
        && canonicalJson(action.previewArguments)
          === canonicalJson(actionDraft.previewArguments)
        && canonicalJson(action.deadline) === canonicalJson(
          actionDraft.deadline ?? {
            kind: 'contractDefault',
            data: {},
          }
        );
    });
}

function sameProviderOutputIgnoringAdapterTimestampV3(
  left: SessionProviderTurnOutputV2,
  right: SessionProviderTurnOutputV2
): boolean {
  const normalize = (value: SessionProviderTurnOutputV2): unknown => {
    const output = cloneJson(value);
    if (output.kind === 'plan') {
      output.plan.recordedAt = '<durable-terminal-recorded-at>';
    }
    if (output.kind === 'toolIntent') {
      output.receipt.recordedAt = '<durable-terminal-recorded-at>';
    }
    return output;
  };
  return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
}

function providerSourceToolId(
  source: ProviderKernelToolSourceV2
): string {
  return source.toolId;
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
  const callIdentity = `native:${source.callId}`;
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

function finalAnswerBindingFromTarget(
  target: Extract<
    SessionProviderTurnTargetV2,
    { kind: 'finalAnswer' }
  >
): import('./types.js').SessionFinalAnswerBindingV3 {
  return {
    inputId: target.inputId,
    controlEpoch: target.controlEpoch,
    workAuthority: cloneJson(target.workAuthority),
    reviewRevision: target.reviewRevision,
    snapshotHighWater: target.snapshotHighWater,
  };
}

function finalAnswerTargetIsPendingCurrent(
  state: SessionKernelLoopStateV2,
  target: Extract<
    SessionProviderTurnTargetV2,
    { kind: 'finalAnswer' }
  >
): boolean {
  const finalAnswer = state.finalAnswer;
  const workAuthority = currentSessionWorkAuthorityV3(state);
  return finalAnswer?.status === 'pending'
    && finalAnswer.physicalRequestCount < 3
    && sameSessionFinalAnswerBindingV3(
      finalAnswer.binding,
      target
    )
    && target.inputId === state.currentInputId
    && target.controlEpoch === state.controlEpoch
    && workAuthority !== undefined
    && sameSessionWorkAuthorityV3(
      target.workAuthority,
      workAuthority
    )
    && state.review?.status === 'final'
    && target.reviewRevision === state.review.revision
    && target.snapshotHighWater === state.review.snapshotHighWater
    && target.snapshotHighWater
      === state.lineage.cursor.snapshotHighWater;
}

function finalAnswerBindingIsCurrent(
  state: SessionKernelLoopStateV2,
  target: Extract<
    SessionProviderTurnTargetV2,
    { kind: 'finalAnswer' }
  >,
  providerTurnId: string
): boolean {
  const finalAnswer = state.finalAnswer;
  const workAuthority = currentSessionWorkAuthorityV3(state);
  return finalAnswer?.status === 'requesting'
    && finalAnswer.providerTurnId === providerTurnId
    && sameSessionFinalAnswerBindingV3(
      finalAnswer.binding,
      target
    )
    && target.inputId === state.currentInputId
    && target.controlEpoch === state.controlEpoch
    && workAuthority !== undefined
    && sameSessionWorkAuthorityV3(
      target.workAuthority,
      workAuthority
    )
    && state.review?.status === 'final'
    && target.reviewRevision === state.review.revision
    && target.snapshotHighWater === state.review.snapshotHighWater
    && target.snapshotHighWater
      === state.lineage.cursor.snapshotHighWater
    && state.providerTurn?.providerTurnId === providerTurnId
    && state.providerTurn.controlEpoch === target.controlEpoch;
}

function finalAnswerFailureIsRetryable(error: unknown): boolean {
  const code = safeErrorCode(error);
  if (
    code === 'session_kernel_provider_transport_failed'
    || code === 'session_kernel_provider_stream_read_failed'
    || code === 'provider_retryable_no_mutation'
  ) {
    return true;
  }
  if (code !== 'session_kernel_provider_http_failed') return false;
  const candidate = error && typeof error === 'object'
    ? error as { httpStatus?: unknown }
    : undefined;
  return Number.isInteger(candidate?.httpStatus)
    && Number(candidate!.httpStatus) >= 500
    && Number(candidate!.httpStatus) <= 599;
}

function finalAnswerFailedResult(
  state: SessionKernelLoopStateV2
): Extract<
  SessionKernelLoopResultV2,
  { kind: 'finalAnswerFailed' }
> {
  const finalAnswer = state.finalAnswer;
  if (finalAnswer?.status !== 'finalAnswerFailed') {
    throw new SessionKernelProviderTurnError(
      'session_kernel_final_answer_failure_state_missing',
      'Final-answer failure result requires a durable terminal failure state.'
    );
  }
  return {
    kind: 'finalAnswerFailed',
    errorCode: finalAnswer.lastErrorCode!,
    physicalRequestCount: finalAnswer.physicalRequestCount,
  };
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
