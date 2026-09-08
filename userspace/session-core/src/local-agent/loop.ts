import type {
  AssistantDraftBlockProjection,
  AssistantDraftProjection,
  ExecutionPlan,
  JsonObject,
  LocalAgentError,
  ModelInteractionRequest,
  ModelMessage,
  NewSessionEvent,
  PlanAuthority,
  ProviderTokenUsage,
  ProviderActivityProjection,
  ProviderEvent,
  ProviderOutputBlock,
  ProviderRequest,
  RunSettlement,
  RunRuntimeSnapshot,
  SessionEvent,
  PreparedToolDescriptor,
  ToolExecutionReply,
  ToolExecutionRecord,
  ToolInputRejection,
  ToolExecutionRequest,
  TodoProgressUpdate,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import {
  KERNEL_REPLY_VERSION,
  KERNEL_REQUEST_VERSION,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_PLAN_PROGRESS,
} from '@deepcode/protocol';
import type { AgentComposition } from './plugins.js';
import {
  pendingContextCompaction,
  prepareContextCompaction,
  pressureCompactionCutoff,
  type ContextCompactionRequestEvent,
} from './compaction.js';
import { buildAgentProviderRequest } from './contextComposer.js';
import { LoopFailure, ProviderCompletedFailure, ProviderReportedFailure } from './loopFailure.js';
import {
  canonicalJsonValue,
  decodeProviderToolInput,
  type ProviderToolCodec,
} from './providerToolCodec.js';
import { recoverSession, type SessionState } from './reducer.js';
import {
  decodeSessionControlCall,
  SessionControlError,
  type PlanPublicationDraft,
  type SessionControlCall,
} from './sessionControls.js';

export interface LoopSnapshot {
  events: readonly SessionEvent[];
  state: SessionState;
}

export type LoopCommand =
  | { type: 'start'; runId: string }
  | { type: 'resume'; runId: string }
  | { type: 'recover'; runId: string }
  | { type: 'cancel'; runId: string };

export type LoopResult =
  | { status: 'suspended'; runId: string }
  | {
      status: 'waiting';
      runId: string;
      reason: 'approval' | 'userInput' | 'plan';
      callId?: string;
      interactionId?: string;
      planId?: string;
    }
  | {
      status: 'settled';
      runId: string;
      outcome: 'completed' | 'failed' | 'cancelled' | 'indeterminate';
    }
  | {
      status: 'finishing';
      runId: string;
      settlement: RunSettlement;
    };

export interface AgentLoopDeps {
  composition: AgentComposition;
  commit(event: NewSessionEvent | readonly NewSessionEvent[]): Promise<LoopSnapshot>;
  updateAssistantDraft(draft: AssistantDraftProjection | null): void;
  nextId(kind: string): string;
}

type ProviderTurnCommon = {
  completion: ProviderTurnCompletion;
  narratives?: Array<{ narrativeId: string; content: string }>;
  contextUsage?: ProviderTokenUsage & {
    providerRequestId: string;
    providerRuntimeRef: string;
  };
};

interface ProviderTurnCompletion {
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction';
  providerRuntimeRef: string;
  orderedCallIds: string[];
  reasoningContent?: string;
  reasoningSignature?: string;
  hostedWebSearchCalls?: JsonObject[];
  orderedOutputBlocks?: ProviderOutputBlock[];
}

type DecodedProviderOutputBlock = {
  outputIndex: number;
  item: JsonObject;
} & (
  | { kind: 'reasoning'; content: string }
  | { kind: 'message'; content: string }
  | {
      kind: 'toolCall';
      providerCallId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: 'toolCallRejected';
      providerCallId: string;
      name: string;
      error: Extract<ProviderOutputBlock, { kind: 'toolCallRejected' }>['error'];
    }
  | { kind: 'providerHosted'; providerCallId: string }
);

interface ExpectedToolRecordIdentity {
  sessionId: string;
  runId: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  toolBindingRef: string;
  callId: string;
  attemptId: string;
  toolName: string;
  input: Record<string, unknown>;
}

type ProviderTurn =
  | ({ kind: 'planProgress'; callId: string; providerCallId: string;
       sourceFactRef: string; updates: TodoProgressUpdate[] } & ProviderTurnCommon)
  | ({ kind: 'answer'; content: string; messageId?: string } & ProviderTurnCommon)
  | {
      kind: 'interaction';
      interactionId: string;
      callId: string;
      providerCallId: string;
      request: ModelInteractionRequest;
      narrative?: string;
    } & ProviderTurnCommon
  | ({
      kind: 'plan';
      callId: string;
      draft: PlanPublicationDraft;
      providerCallId: string;
      narrative?: string;
    } & ProviderTurnCommon)
  | ({
      kind: 'tools';
      calls: Array<{
        callId: string;
        providerCallId: string;
        name: string;
        input: Record<string, unknown>;
      }>;
      narrative?: string;
    } & ProviderTurnCommon)
  | ({
      kind: 'controlRejected';
      rejection: {
        callId: string;
        providerCallId: string;
        toolName: string;
        input: Record<string, unknown>;
        error: LocalAgentError;
      };
      narrative?: string;
    } & ProviderTurnCommon)
  | ({ kind: 'continue'; narrative?: string } & ProviderTurnCommon);

export async function runAgentLoop(
  initial: LoopSnapshot,
  command: LoopCommand,
  deps: AgentLoopDeps,
  signal: AbortSignal,
): Promise<LoopResult> {
  let snapshot = initial;
  const runId = command.runId;
  const commit = async (
    event: NewSessionEvent | readonly NewSessionEvent[],
  ): Promise<void> => {
    snapshot = await deps.commit(event);
  };

  if (hasSettlement(snapshot.events, runId)) return settlementResult(snapshot.events, runId);
  const interrupted = uncompletedProviderComposition(snapshot, runId);
  if (interrupted) {
    const settlement: RunSettlement = {
      outcome: 'indeterminate',
      error: {
        code: 'provider_turn_outcome_unknown',
        message: `Provider request ${interrupted.providerRequestId} 已组成上下文但没有持久化完成事实。`,
      },
    };
    await commit([
      providerTurnTerminalEvent(
        snapshot.state.sessionId,
        runId,
        interrupted,
        runRuntimeSnapshot(snapshot, runId).provider.providerRuntimeRef,
        settlement,
      ),
      {
        type: 'run.finishing',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: settlement,
      },
    ]);
    return finishingResult(runId, settlement);
  }
  const runtime = runRuntimeSnapshot(snapshot, runId);
  try {
    for (const requestEvent of pendingToolRequests(snapshot.events, runId)) {
      const existing = await deps.composition.kernel.readRecord(requestEvent.callId);
      if (existing) {
        await commitToolRecord(
          existing,
          expectedToolRecordIdentity(snapshot, runtime, requestEvent),
          commit,
        );
      }
    }

    if (command.type === 'recover') {
      const unresolved = pendingToolRequests(snapshot.events, runId)[0];
      if (unresolved) {
        const approval = latestApproval(snapshot.events, runId, unresolved.callId);
        if (approval.requested && !approval.resolved) {
          return { status: 'waiting', runId, reason: 'approval', callId: unresolved.callId };
        }
        await commit({
          type: 'run.finishing',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: {
            outcome: 'indeterminate',
            error: {
              code: 'tool_effect_outcome_unknown',
              message: `进程恢复时 Kernel 没有工具调用 ${unresolved.callId} 的确定记录。`,
            },
          },
        });
        return finishingResult(runId, {
          outcome: 'indeterminate',
          error: {
            code: 'tool_effect_outcome_unknown',
            message: `进程恢复时 Kernel 没有工具调用 ${unresolved.callId} 的确定记录。`,
          },
        });
      }
    }

    if (command.type === 'cancel') return await cancelRun(snapshot, command, deps, commit);

    while (true) {
      throwIfAborted(signal);
      const pendingCompaction = pendingContextCompaction(snapshot.events, runId);
      if (pendingCompaction) {
        await performContextCompaction(snapshot, pendingCompaction, runId, deps, signal, commit);
        continue;
      }
      const pending = pendingToolRequests(snapshot.events, runId);
      for (const requestEvent of pending) {
        const approval = latestApproval(snapshot.events, runId, requestEvent.callId);
        if (approval.requested && !approval.resolved) {
          return { status: 'waiting', runId, reason: 'approval', callId: requestEvent.callId };
        }
        const existing = await deps.composition.kernel.readRecord(requestEvent.callId);
        if (existing) {
          await commitToolRecord(
            existing,
            expectedToolRecordIdentity(snapshot, runtime, requestEvent),
            commit,
          );
          continue;
        }
        throwIfAborted(signal);
        const request: ToolExecutionRequest = {
          schemaVersion: KERNEL_REQUEST_VERSION,
          type: 'tool.execute',
          requestId: deps.nextId('kernel-request'),
          sessionId: snapshot.state.sessionId,
          runId,
          extensionGenerationRef: runtime.extensionGenerationRef,
          kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
          toolBindingRef: runtimeTool(runtime, requestEvent.payload.toolName).toolBindingRef,
          callId: requestEvent.callId,
          attemptId: requestEvent.payload.attemptId,
          toolName: requestEvent.payload.toolName,
          input: requestEvent.payload.input,
          workspaceBindings: runWorkspaceBindings(snapshot, runId).map((binding) => binding.workspaceId),
          ...(selectedPlanAuthorities(snapshot.events).length
            ? { planAuthorities: selectedPlanAuthorities(snapshot.events) }
            : {}),
          ...(approval.resolved
            ? {
                nonWorkspaceAuthority: {
                  authorityId: approval.resolved.payload.authorityId,
                  decision: approval.resolved.payload.decision,
                },
              }
            : {}),
        };
        const reply = await executeUntilAbort(deps, request, signal);
        if (reply.callId !== requestEvent.callId) {
          throw new LoopFailure('kernel_call_identity_mismatch', 'Kernel 返回了其他工具调用的结果。');
        }
        if (reply.status === 'inputRejected') {
          assertToolRecordIdentity(reply.rejection, expectedToolRecordIdentity(snapshot, runtime, requestEvent));
          await commit({
            type: 'tool.input-rejected',
            sessionId: snapshot.state.sessionId,
            runId,
            callId: requestEvent.callId,
            payload: { rejection: reply.rejection },
          });
          continue;
        }
        if (reply.status === 'approvalRequired') {
          if (approval.resolved) {
            throw new LoopFailure('kernel_approval_not_honored', 'Kernel 未接受已持久化的用户决策。');
          }
          const approvalId = reply.approvalId || deps.nextId('approval');
          await commit([
            {
              type: 'approval.requested',
              sessionId: snapshot.state.sessionId,
              runId,
              callId: requestEvent.callId,
              payload: { approvalId, preview: reply.preview },
            },
            {
              type: 'run.waiting',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { reason: 'approval', detail: reply.preview.summary },
            },
          ]);
          return { status: 'waiting', runId, reason: 'approval', callId: requestEvent.callId };
        }
        await commitToolRecord(
          reply.record,
          expectedToolRecordIdentity(snapshot, runtime, requestEvent),
          commit,
        );
      }

      throwIfAborted(signal);
      const correctionFailure = inputCorrectionFailure(snapshot.events, runId);
      if (correctionFailure) throw correctionFailure;
      const completedPlan = completedPlanAwaitingLifecycle(snapshot.state);
      if (completedPlan) {
        await commit({
          type: 'plan.completed',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: completedPlan,
        });
      }
      const executionPlan = confirmedPlanAwaitingExecution(snapshot.state);
      const preparedProviderRequest = await buildAgentProviderRequest({
        sessionId: snapshot.state.sessionId,
        runId,
        runtime,
        events: snapshot.events,
        responseConstraint: executionPlan ? 'toolRequired' : 'normal',
        workspaceBindings: runWorkspaceBindings(snapshot, runId),
        contextProviders: deps.composition.contextProviders,
        memory: deps.composition.memory,
        providerRequestId: deps.nextId('provider-request'),
      });
      const pressureCutoff = pressureCompactionCutoff(
        snapshot,
        runId,
        preparedProviderRequest.receipt,
        runtime,
      );
      if (pressureCutoff !== null) {
        throwIfAborted(signal);
        await commit({
          type: 'context.compaction.requested',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: {
            compactionId: deps.nextId('compaction'),
            providerRequestId: deps.nextId('provider-request'),
            trigger: 'pressure',
            coveredThroughSequence: pressureCutoff,
          },
        });
        continue;
      }
      throwIfAborted(signal);
      await commit({
        type: 'context.composed',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: preparedProviderRequest.receipt,
      });
      const turn = await consumeProvider(
        preparedProviderRequest.request,
        preparedProviderRequest.toolCodec,
        runId,
        deps,
        signal,
      );
      const providerCallFacts: NewSessionEvent[] = [];
      const completionDerivedFacts: NewSessionEvent[] = [];
      const turnNarratives = [
        ...(turn.narratives ?? []),
        ...('narrative' in turn && turn.narrative
          ? [{ narrativeId: deps.nextId('narrative'), content: turn.narrative }]
          : []),
      ];
      for (const narrative of turnNarratives) {
        completionDerivedFacts.push({
          type: 'narrative.committed',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: {
            narrativeId: narrative.narrativeId,
            content: narrative.content,
            providerRequestId: turn.completion.providerRequestId,
          },
        });
      }
      if (turn.contextUsage) {
        completionDerivedFacts.unshift({
          type: 'context.updated',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: turn.contextUsage,
        });
      }
      switch (turn.kind) {
        case 'planProgress': {
          const fact = planProgressFact(snapshot, runId, turn);
          await commit([
            ...orderedProviderCallFacts(turn.completion, [fact]),
            providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
            ...completionDerivedFacts,
          ]);
          break;
        }
        case 'interaction': {
          const interactionFact: NewSessionEvent = {
            type: 'interaction.requested',
            sessionId: snapshot.state.sessionId,
            runId,
            callId: turn.callId,
            payload: {
              interactionId: turn.interactionId,
              providerCallId: turn.providerCallId,
              ...turn.request,
            },
          };
          await commit([
            ...orderedProviderCallFacts(
              turn.completion,
              [...providerCallFacts, interactionFact],
            ),
            providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
            ...completionDerivedFacts,
            {
              type: 'run.waiting',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { reason: 'userInput', detail: turn.request.prompt },
            },
          ]);
          return {
            status: 'waiting',
            runId,
            reason: 'userInput',
            interactionId: turn.interactionId,
          };
        }
        case 'plan': {
          const identity = nextPlanIdentity(snapshot.events, runId, () => deps.nextId('plan'));
          if (
            identity.planId === turn.callId
            || identity.planId === turn.providerCallId
            || turn.callId === turn.providerCallId
          ) {
            throw new LoopFailure(
              'plan_identity_invalid',
              'PlanId、LogicalCallId 与 ProviderCallId 必须是互不复用的独立身份。',
            );
          }
          const plan: ExecutionPlan = {
            planId: identity.planId,
            revision: identity.revision,
            title: turn.draft.title,
            summary: turn.draft.summary,
            steps: turn.draft.steps.map((step) => ({
              ...step,
              ...(step.verification ? { verification: [...step.verification] } : {}),
            })),
            mutationManifest: turn.draft.mutationManifest.map((operation) => ({ ...operation })),
          };
          assertPlanWorkspaceBindings(
            plan,
            runWorkspaceBindings(snapshot, runId).map((binding) => binding.workspaceId),
          );
          const comparable = comparablePriorPlan(snapshot.state, plan);
          if (comparable && planDefinitionKey(comparable) === planDefinitionKey(plan)) {
            const rejectionEvent: NewSessionEvent = {
              type: 'session.control.rejected',
              sessionId: snapshot.state.sessionId,
              runId,
              callId: turn.callId,
              payload: {
                providerCallId: turn.providerCallId,
                toolName: SESSION_CONTROL_PLAN_PUBLISH,
                input: planDraftInput(turn.draft),
                error: {
                  code: 'plan_revision_unchanged',
                  message: 'The proposed Plan is unchanged. Continue executing the confirmed Plan, or publish a materially revised Plan only when its scope must change.',
                },
              },
            };
            await commit([
              ...orderedProviderCallFacts(
                turn.completion,
                [...providerCallFacts, rejectionEvent],
              ),
              providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
              ...completionDerivedFacts,
            ]);
            break;
          }
          const planFact: NewSessionEvent = {
            type: 'plan.published',
            sessionId: snapshot.state.sessionId,
            runId,
            callId: turn.callId,
            payload: { ...clonePlan(plan), providerCallId: turn.providerCallId },
          };
          await commit([
            ...orderedProviderCallFacts(turn.completion, [...providerCallFacts, planFact]),
            providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
            ...completionDerivedFacts,
            {
              type: 'run.waiting',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { reason: 'plan', detail: plan.title },
            },
          ]);
          return {
            status: 'waiting',
            runId,
            reason: 'plan',
            planId: plan.planId,
          };
        }
        case 'answer': {
          if (executionPlan) {
            await commit([
              ...orderedProviderCallFacts(turn.completion, providerCallFacts),
              providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
              ...completionDerivedFacts,
              {
                type: 'run.finishing',
                sessionId: snapshot.state.sessionId,
                runId,
                payload: {
                  outcome: 'failed',
                  error: {
                    code: 'confirmed_plan_execution_required',
                    message: `Plan ${executionPlan.planId} revision ${executionPlan.revision} 已确认且 Todo 尚未完成；execution turn 不接受普通终答。`,
                  },
                },
              },
            ]);
            return finishingResult(runId, {
              outcome: 'failed',
              error: {
                code: 'confirmed_plan_execution_required',
                message: `Plan ${executionPlan.planId} revision ${executionPlan.revision} 已确认且 Todo 尚未完成；execution turn 不接受普通终答。`,
              },
            });
          }
          const messageId = turn.messageId ?? deps.nextId('message');
          await commit([
            ...orderedProviderCallFacts(turn.completion, providerCallFacts),
            providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
            ...completionDerivedFacts,
            {
              type: 'message.committed',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: {
                messageId,
                role: 'assistant',
                content: turn.content,
                providerRequestId: turn.completion.providerRequestId,
              },
            },
            {
              type: 'run.finishing',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { outcome: 'completed', finalMessageId: messageId },
            },
          ]);
          return finishingResult(runId, { outcome: 'completed', finalMessageId: messageId });
        }
        case 'tools': {
          const seenCalls = new Set<string>();
          const callFacts: NewSessionEvent[] = [...providerCallFacts];
          for (const call of turn.calls) {
            if (seenCalls.has(call.callId)) {
              throw new LoopFailure('provider_tool_call_duplicate', 'Provider 重复了工具调用标识。');
            }
            seenCalls.add(call.callId);
            callFacts.push({
              type: 'tool.requested',
              sessionId: snapshot.state.sessionId,
              runId,
              callId: call.callId,
              payload: {
                providerCallId: call.providerCallId,
                attemptId: deps.nextId('attempt'),
                toolName: call.name,
                input: call.input,
              },
            });
          }
          const events = orderedProviderCallFacts(turn.completion, callFacts);
          events.push(providerTurnSettledEvent(
            snapshot.state.sessionId,
            runId,
            turn.completion,
          ));
          events.push(...completionDerivedFacts);
          await commit(events);
          break;
        }
        case 'controlRejected': {
          const rejectionEvent: NewSessionEvent = {
            type: 'session.control.rejected',
            sessionId: snapshot.state.sessionId,
            runId,
            callId: turn.rejection.callId,
            payload: {
              providerCallId: turn.rejection.providerCallId,
              toolName: turn.rejection.toolName,
              input: { ...turn.rejection.input },
              error: { ...turn.rejection.error },
            },
          };
          await commit([
            ...orderedProviderCallFacts(
              turn.completion,
              [...providerCallFacts, rejectionEvent],
            ),
            providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
            ...completionDerivedFacts,
          ]);
          break;
        }
        case 'continue':
          await commit([
            ...orderedProviderCallFacts(turn.completion, providerCallFacts),
            providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
            ...completionDerivedFacts,
          ]);
          break;
      }
    }
  } catch (error) {
    if (error instanceof ProviderReportedFailure || error instanceof ProviderCompletedFailure) {
      const failure = localAgentError(error);
      if (!hasSettlement(snapshot.events, runId)) {
        const pending = uncompletedProviderComposition(snapshot, runId);
        await commit([
          ...(pending
            ? [providerTurnTerminalEvent(
                snapshot.state.sessionId,
                runId,
                pending,
                runRuntimeSnapshot(snapshot, runId).provider.providerRuntimeRef,
                { outcome: 'failed', error: failure },
              )]
            : []),
          {
            type: 'run.finishing',
            sessionId: snapshot.state.sessionId,
            runId,
            payload: { outcome: 'failed', error: failure },
          },
        ]);
      }
      return finishingResult(runId, { outcome: 'failed', error: failure });
    }
    const unknownTurn = uncompletedProviderComposition(snapshot, runId);
    if (unknownTurn && !hasSettlement(snapshot.events, runId)) {
      const cause = localAgentError(error);
      const settlement: RunSettlement = {
        outcome: 'indeterminate',
        error: {
          code: 'provider_turn_outcome_unknown',
          message: `Provider request ${unknownTurn.providerRequestId} 的完成结果不可判定；原始错误 ${cause.code}：${cause.message}`,
        },
      };
      await commit([
        providerTurnTerminalEvent(
          snapshot.state.sessionId,
          runId,
          unknownTurn,
          runRuntimeSnapshot(snapshot, runId).provider.providerRuntimeRef,
          settlement,
        ),
        {
          type: 'run.finishing',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: settlement,
        },
      ]);
      return finishingResult(runId, settlement);
    }
    if (
      signal.aborted
      && signal.reason === 'session_service_stopped'
      && !(error instanceof LoopFailure && error.code === 'tool_cancel_cleanup_failed')
    ) {
      return { status: 'suspended', runId };
    }
    if (signal.aborted) {
      return await cancelRun(snapshot, { type: 'cancel', runId }, deps, commit);
    }
    const failure = localAgentError(error);
    if (!hasSettlement(snapshot.events, runId)) {
      await commit({
        type: 'run.finishing',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: { outcome: 'failed', error: failure },
      });
    }
    return finishingResult(runId, { outcome: 'failed', error: failure });
  }
}

async function performContextCompaction(
  snapshot: LoopSnapshot,
  requestEvent: ContextCompactionRequestEvent,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  commit: (event: NewSessionEvent | readonly NewSessionEvent[]) => Promise<void>,
): Promise<void> {
  const cutoff = requestEvent.payload.coveredThroughSequence;
  const runtime = runRuntimeSnapshot(snapshot, runId);
  const prepared = prepareContextCompaction({
    sessionId: snapshot.state.sessionId,
    runId,
    runtime,
    workspaceBindings: runWorkspaceBindings(snapshot, runId),
    events: snapshot.events,
    requestEvent,
  });
  throwIfAborted(signal);
  await commit({
    type: 'context.composed',
    sessionId: snapshot.state.sessionId,
    runId,
    payload: prepared.receipt,
  });
  const compacted = await consumeCompactionProvider(prepared.request, deps, signal);
  const facts: NewSessionEvent[] = [providerTurnSettledEvent(
    snapshot.state.sessionId,
    runId,
    compacted.completion,
  )];
  if (compacted.contextUsage) {
    facts.push({
      type: 'context.updated',
      sessionId: snapshot.state.sessionId,
      runId,
      payload: compacted.contextUsage,
    });
  }
  facts.push({
    type: 'context.compacted',
    sessionId: snapshot.state.sessionId,
    runId,
    payload: {
      compactionId: requestEvent.payload.compactionId,
      providerRequestId: requestEvent.payload.providerRequestId,
      trigger: requestEvent.payload.trigger,
      coveredThroughSequence: cutoff,
      summary: compacted.summary,
    },
  });
  await commit(facts);
}

async function consumeCompactionProvider(
  request: ProviderRequest,
  deps: AgentLoopDeps,
  signal: AbortSignal,
): Promise<{
  summary: string;
  completion: ProviderTurnCompletion;
  contextUsage?: ProviderTokenUsage & {
    providerRequestId: string;
    providerRuntimeRef: string;
  };
}> {
  const activity = trackProviderActivity(request, deps);
  let deltas = '';
  let completeMessage: Extract<ProviderEvent, { type: 'assistant.message' }>['data'] | undefined;
  const orderedOutputItems: Array<{ outputIndex: number; item: JsonObject }> = [];
  let contextUsage: ProviderTokenUsage | undefined;
  let completed = false;
  for await (const event of deps.composition.provider.stream(request, signal)) {
    assertProviderEvent(event, request.requestId);
    if (completed) {
      throw new LoopFailure(
        'provider_event_after_completion',
        'Provider 在 completed 之后继续发送压缩事件。',
      );
    }
    activity.observe(event);
    switch (event.type) {
      case 'text.delta':
        deltas += event.data.text;
        break;
      case 'reasoning.delta':
        break;
      case 'output.item.completed':
        if (
          orderedOutputItems.at(-1)?.outputIndex !== undefined
          && event.data.outputIndex <= orderedOutputItems.at(-1)!.outputIndex
        ) {
          throw new LoopFailure(
            'provider_output_item_order_invalid',
            '上下文压缩 output item 没有按原生 output_index 递增返回。',
          );
        }
        if (event.data.item.type === 'function_call') {
          throw new LoopFailure(
            'context_compaction_tool_call_invalid',
            '上下文压缩请求不能调用工具或 Session control。',
          );
        }
        if (event.data.item.type === 'web_search_call') {
          throw new LoopFailure(
            'context_compaction_hosted_tool_invalid',
            '上下文压缩请求不能调用 Provider hosted search。',
          );
        }
        orderedOutputItems.push({
          outputIndex: event.data.outputIndex,
          item: structuredClone(event.data.item),
        });
        break;
      case 'assistant.message':
        if (completeMessage !== undefined) {
          throw new LoopFailure(
            'provider_message_duplicate',
            '上下文压缩返回了多个最终消息。',
          );
        }
        completeMessage = event.data;
        break;
      case 'tool.call':
        throw new LoopFailure(
          'context_compaction_tool_call_invalid',
          '上下文压缩请求不能调用工具或 Session control。',
        );
      case 'hosted.web-search.completed':
        throw new LoopFailure(
          'context_compaction_hosted_tool_invalid',
          '上下文压缩请求不能调用 Provider hosted search。',
        );
      case 'completed':
        contextUsage = decodeContextUsage(event.data);
        completed = true;
        break;
      case 'failed':
        throw new ProviderReportedFailure(event.data.code, event.data.message);
    }
  }
  if (!completed) {
    throw new LoopFailure('provider_stream_incomplete', '上下文压缩 Provider 流未产生完成事件。');
  }
  if (orderedOutputItems.length > 0 && completeMessage !== undefined) {
    throw new LoopFailure(
      'provider_output_contract_mixed',
      '上下文压缩同一 turn 混用了有序 output item 与聚合完成事件。',
    );
  }
  if (completeMessage !== undefined && deltas && completeMessage.content !== deltas) {
    throw new LoopFailure('provider_message_mismatch', '上下文压缩最终消息与流式文本不一致。');
  }
  const orderedMessages = orderedOutputItems.flatMap((output) => (
    output.item.type === 'message'
      ? [providerOutputItemText(output.item, 'output_text', true)]
      : []
  ));
  if (orderedMessages.length > 1) {
    throw new LoopFailure(
      'context_compaction_message_count_invalid',
      '上下文压缩必须只产生一个最终消息。',
    );
  }
  const orderedSummary = orderedMessages[0];
  if (orderedSummary !== undefined && deltas && orderedSummary !== deltas) {
    throw new LoopFailure(
      'provider_output_text_mismatch',
      '上下文压缩有序 message item 与流式文本不一致。',
    );
  }
  const summary = (orderedSummary ?? completeMessage?.content ?? deltas).trim();
  if (!summary) {
    throw new LoopFailure('context_compaction_empty', '上下文压缩没有产生摘要。');
  }
  return {
    summary,
    completion: {
      providerRequestId: request.requestId,
      purpose: 'contextCompaction',
      providerRuntimeRef: request.providerRuntimeRef,
      orderedCallIds: [],
      ...(completeMessage?.reasoningContent !== undefined
        ? { reasoningContent: completeMessage.reasoningContent }
        : {}),
      ...(completeMessage?.reasoningSignature !== undefined
        ? { reasoningSignature: completeMessage.reasoningSignature }
        : {}),
    },
    ...(contextUsage
      ? {
          contextUsage: {
            ...contextUsage,
            providerRequestId: request.requestId,
            providerRuntimeRef: request.providerRuntimeRef,
          },
        }
      : {}),
  };
}

function assertPlanWorkspaceBindings(plan: ExecutionPlan, bindings: readonly string[]): void {
  const bound = new Set(bindings);
  for (const operation of plan.mutationManifest) {
    if (!bound.has(operation.workspaceId)) {
      throw new LoopFailure(
        'plan_workspace_not_bound',
        `Plan 引用了当前 Session creation snapshot 之外的 workspaceId：${operation.workspaceId}`,
      );
    }
  }
}

async function consumeProvider(
  request: ProviderRequest,
  toolCodec: ProviderToolCodec,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
): Promise<ProviderTurn> {
  let completed = false;
  try {
    return await consumeProviderOutput(request, toolCodec, runId, deps, signal, () => {
      completed = true;
    });
  } catch (error) {
    if (completed && !signal.aborted && !(error instanceof ProviderReportedFailure)) {
      const failure = localAgentError(error);
      throw new ProviderCompletedFailure(failure.code, failure.message);
    }
    throw error;
  }
}

async function consumeProviderOutput(
  request: ProviderRequest,
  toolCodec: ProviderToolCodec,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  onCompleted: () => void,
): Promise<ProviderTurn> {
  const activity = trackProviderActivity(request, deps);
  deps = { ...deps, updateAssistantDraft: activity.updateDraft };
  let deltas = '';
  let reasoningDeltas = '';
  let completeMessage: {
    messageId: string;
    content: string;
    reasoningContent?: string;
    reasoningSignature?: string;
  } | undefined;
  const providerCalls: Array<{
    providerCallId: string;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const hostedWebSearchCalls: JsonObject[] = [];
  const orderedOutputItems: Array<{ outputIndex: number; item: JsonObject }> = [];
  const streamedTextByOutputIndex = new Map<number, string>();
  let contextUsage: ProviderTokenUsage | undefined;
  let completed = false;
  for await (const event of deps.composition.provider.stream(request, signal)) {
    assertProviderEvent(event, request.requestId);
    if (completed) {
      throw new LoopFailure(
        'provider_event_after_completion',
        'Provider 在 completed 之后继续发送事件。',
      );
    }
    activity.observe(event);
    switch (event.type) {
      case 'reasoning.delta': {
        reasoningDeltas += event.data.text;
        break;
      }
      case 'text.delta': {
        deltas += event.data.text;
        if (event.data.outputIndex !== undefined) {
          if (orderedOutputItems.some((output) => output.outputIndex === event.data.outputIndex)) {
            throw new LoopFailure(
              'provider_output_delta_after_completion',
              'Provider 在 output item 完成后继续发送该 item 的正文增量。',
            );
          }
          streamedTextByOutputIndex.set(
            event.data.outputIndex,
            `${streamedTextByOutputIndex.get(event.data.outputIndex) ?? ''}${event.data.text}`,
          );
          deps.updateAssistantDraft({
            runId,
            turnId: request.requestId,
            content: '',
            orderedBlocks: assistantDraftBlocks(
              orderedOutputItems,
              toolCodec,
              streamedTextByOutputIndex,
            ),
          });
        } else if (orderedOutputItems.length === 0) {
          deps.updateAssistantDraft({
            runId,
            turnId: request.requestId,
            content: deltas,
          });
        }
        break;
      }
      case 'output.item.completed': {
        const previous = orderedOutputItems.at(-1);
        if (previous && event.data.outputIndex <= previous.outputIndex) {
          throw new LoopFailure(
            'provider_output_item_order_invalid',
            'Provider output item 没有按原生 output_index 递增返回。',
          );
        }
        orderedOutputItems.push({
          outputIndex: event.data.outputIndex,
          item: structuredClone(event.data.item),
        });
        streamedTextByOutputIndex.delete(event.data.outputIndex);
        const orderedBlocks = assistantDraftBlocks(
          orderedOutputItems,
          toolCodec,
          streamedTextByOutputIndex,
        );
        deps.updateAssistantDraft(orderedBlocks.length > 0
          ? {
              runId,
              turnId: request.requestId,
              content: '',
              orderedBlocks,
            }
          : null);
        break;
      }
      case 'assistant.message':
        if (completeMessage) {
          throw new LoopFailure(
            'provider_message_duplicate',
            'Provider 同一 turn 返回了多个最终消息。',
          );
        }
        completeMessage = event.data;
        break;
      case 'tool.call': {
        const canonicalName = toolCodec.canonicalByWire.get(event.data.name);
        if (!canonicalName) {
          throw new LoopFailure(
            'provider_tool_alias_unknown',
            `Provider 返回了当前 run 未声明的工具别名：${event.data.name}`,
          );
        }
        providerCalls.push({
          providerCallId: event.data.callId,
          name: canonicalName,
          input: decodeProviderToolInput(toolCodec, canonicalName, event.data.input),
        });
        break;
      }
      case 'hosted.web-search.completed':
        hostedWebSearchCalls.push(structuredClone(event.data.item));
        break;
      case 'completed':
        completed = true;
        onCompleted();
        contextUsage = decodeContextUsage(event.data);
        break;
      case 'failed':
        throw new ProviderReportedFailure(event.data.code, event.data.message);
    }
  }
  if (!completed) throw new LoopFailure('provider_stream_incomplete', 'Provider 流未产生完成事件。');
  if (
    orderedOutputItems.length > 0
    && (completeMessage !== undefined || providerCalls.length > 0 || hostedWebSearchCalls.length > 0)
  ) {
    throw new LoopFailure(
      'provider_output_contract_mixed',
      'Provider 同一 turn 混用了有序 output item 与聚合完成事件。',
    );
  }
  if (completeMessage) {
    if (
      completeMessage.reasoningContent !== undefined
      && !completeMessage.reasoningContent.trim()
    ) {
      throw new LoopFailure(
        'provider_reasoning_content_invalid',
        'Provider 返回了空的 reasoningContent。',
      );
    }
    if (
      completeMessage.reasoningSignature !== undefined
      && !completeMessage.reasoningSignature.trim()
    ) {
      throw new LoopFailure(
        'provider_reasoning_signature_invalid',
        'Provider 返回了空的 reasoningSignature。',
      );
    }
    if (
      completeMessage.reasoningSignature !== undefined
      && completeMessage.reasoningContent === undefined
    ) {
      throw new LoopFailure(
        'provider_reasoning_signature_without_content',
        'Provider reasoningSignature 缺少对应 reasoningContent。',
      );
    }
    if (deltas && completeMessage.content !== deltas) {
      throw new LoopFailure('provider_message_mismatch', 'Provider 最终消息与流式文本不一致。');
    }
    if (
      reasoningDeltas
      && completeMessage.reasoningContent !== reasoningDeltas
    ) {
      throw new LoopFailure(
        'provider_reasoning_message_mismatch',
        'Provider 最终 reasoningContent 与流式 reasoning 不一致。',
      );
    }
    if (!deltas) {
      deltas = completeMessage.content;
      if (deltas) {
        deps.updateAssistantDraft({
          runId,
          turnId: request.requestId,
          content: deltas,
        });
      }
    }
  }

  const decodedOutputBlocks = orderedOutputItems.map((output) => (
    decodeProviderOutputBlock(output, toolCodec)
  ));
  if (decodedOutputBlocks.length > 0) {
    const outputText = decodedOutputBlocks
      .filter((block): block is Extract<DecodedProviderOutputBlock, { kind: 'message' }> => (
        block.kind === 'message'
      ))
      .map((block) => block.content)
      .join('');
    if (deltas && outputText !== deltas) {
      throw new LoopFailure(
        'provider_output_text_mismatch',
        'Provider 有序 message items 与流式文本不一致。',
      );
    }
    if (!deltas && outputText) {
      deltas = outputText;
    }
    for (const block of decodedOutputBlocks) {
      if (block.kind === 'toolCall') {
        providerCalls.push({
          providerCallId: block.providerCallId,
          name: block.name,
          input: block.input,
        });
      }
    }
  }

  const orderedReasoningContent = decodedOutputBlocks
    .filter((block): block is Extract<DecodedProviderOutputBlock, { kind: 'reasoning' }> => (
      block.kind === 'reasoning'
    ))
    .map((block) => block.content)
    .join('');
  const reasoningContent = completeMessage?.reasoningContent
    ?? (orderedReasoningContent || reasoningDeltas || undefined);

  const usage = contextUsage
    ? {
        contextUsage: {
          ...contextUsage,
          providerRequestId: request.requestId,
          providerRuntimeRef: request.providerRuntimeRef,
        },
      }
    : {};
  const narrative = decodedOutputBlocks.length === 0 && deltas.trim() ? deltas : undefined;
  const rejectedCalls = decodedOutputBlocks.filter(
    (block): block is Extract<DecodedProviderOutputBlock, { kind: 'toolCallRejected' }> => (
      block.kind === 'toolCallRejected'
    ),
  );
  const seenCalls = new Set<string>();
  for (const call of [...providerCalls, ...rejectedCalls]) {
    if (!call.providerCallId || seenCalls.has(call.providerCallId)) {
      throw new LoopFailure(
        'provider_tool_call_duplicate',
        'Provider 工具调用标识为空或重复。',
      );
    }
    seenCalls.add(call.providerCallId);
  }
  const seenHostedSearchCalls = new Set(seenCalls);
  for (const item of hostedWebSearchCalls) {
    const callId = typeof item.id === 'string' ? item.id : '';
    if (!callId || seenHostedSearchCalls.has(callId)) {
      throw new LoopFailure(
        'provider_hosted_search_call_duplicate',
        'Provider hosted search 调用标识为空或重复。',
      );
    }
    seenHostedSearchCalls.add(callId);
  }
  for (const block of decodedOutputBlocks) {
    if (block.kind !== 'providerHosted') continue;
    if (seenHostedSearchCalls.has(block.providerCallId)) {
      throw new LoopFailure(
        'provider_hosted_search_call_duplicate',
        'Provider hosted search 调用标识为空或重复。',
      );
    }
    seenHostedSearchCalls.add(block.providerCallId);
  }
  const logicalCallIds = new Set<string>();
  const calls = providerCalls.map((call) => {
    const callId = deps.nextId('call');
    if (!callId || callId === call.providerCallId || logicalCallIds.has(callId)) {
      throw new LoopFailure(
        'logical_call_identity_invalid',
        'Session 必须为每个 Provider call 生成非空、唯一且不复用原生值的 LogicalCallId。',
      );
    }
    logicalCallIds.add(callId);
    return {
      callId,
      providerCallId: call.providerCallId,
      name: call.name,
      input: call.input,
    };
  });
  const logicalCallByProviderCallId = new Map(calls.map((call) => (
    [call.providerCallId, call.callId] as const
  )));
  for (const call of rejectedCalls) {
    const callId = deps.nextId('call');
    if (!callId || callId === call.providerCallId || logicalCallIds.has(callId)) {
      throw new LoopFailure('logical_call_identity_invalid', 'Session 拒绝调用缺少独立且唯一的 LogicalCallId。');
    }
    logicalCallIds.add(callId);
    logicalCallByProviderCallId.set(call.providerCallId, callId);
  }
  const orderedMessageBlocks = decodedOutputBlocks.filter(
    (block): block is Extract<DecodedProviderOutputBlock, { kind: 'message' }> => (
      block.kind === 'message'
    ),
  );
  const hasCalls = calls.length + rejectedCalls.length > 0;
  const finalOrderedMessage = !hasCalls ? orderedMessageBlocks.at(-1) : undefined;
  if (decodedOutputBlocks.length > 0 && !hasCalls && !finalOrderedMessage) {
    throw new LoopFailure(
      'provider_answer_empty',
      'Provider 有序 output items 没有产生最终答复消息。',
    );
  }
  const orderedNarratives: Array<{ narrativeId: string; content: string }> = [];
  let orderedFinalMessage: { messageId: string; content: string } | undefined;
  const orderedOutputBlocks = decodedOutputBlocks.map((block): ProviderOutputBlock => {
    switch (block.kind) {
      case 'reasoning':
        return {
          outputIndex: block.outputIndex,
          kind: 'reasoning',
          item: structuredClone(block.item),
        };
      case 'message': {
        if (block.outputIndex === finalOrderedMessage?.outputIndex) {
          const messageId = deps.nextId('message');
          orderedFinalMessage = { messageId, content: block.content };
          return {
            outputIndex: block.outputIndex,
            kind: 'finalMessage',
            messageId,
            item: structuredClone(block.item),
          };
        }
        const narrativeId = deps.nextId('narrative');
        orderedNarratives.push({ narrativeId, content: block.content });
        return {
          outputIndex: block.outputIndex,
          kind: 'narrative',
          narrativeId,
          item: structuredClone(block.item),
        };
      }
      case 'toolCall':
      case 'toolCallRejected': {
        const callId = logicalCallByProviderCallId.get(block.providerCallId);
        if (!callId) {
          throw new LoopFailure(
            'provider_turn_call_fact_mismatch',
            'Provider output toolCall 缺少对应的 Session LogicalCallId。',
          );
        }
        const callBlock = {
          outputIndex: block.outputIndex,
          callId,
          providerCallId: block.providerCallId,
          toolName: block.name,
          item: structuredClone(block.item),
        };
        return block.kind === 'toolCallRejected'
          ? { ...callBlock, kind: 'toolCallRejected', error: structuredClone(block.error) }
          : { ...callBlock, kind: 'toolCall' };
      }
      case 'providerHosted':
        return {
          outputIndex: block.outputIndex,
          kind: 'providerHosted',
          activityId: deps.nextId('activity'),
          providerCallId: block.providerCallId,
          providerToolType: 'web_search',
          item: structuredClone(block.item),
        };
    }
  });
  const completion: ProviderTurnCompletion = {
    providerRequestId: request.requestId,
    purpose: 'agent',
    providerRuntimeRef: request.providerRuntimeRef,
    orderedCallIds: calls.map((call) => call.callId),
    ...(reasoningContent !== undefined
      ? { reasoningContent }
      : {}),
    ...(completeMessage?.reasoningSignature !== undefined
      ? { reasoningSignature: completeMessage.reasoningSignature }
      : {}),
    ...(hostedWebSearchCalls.length > 0
      ? { hostedWebSearchCalls }
      : {}),
    ...(orderedOutputBlocks.length > 0
      ? { orderedOutputBlocks }
      : {}),
  };

  const controlCalls: Array<SessionControlCall & { providerCallId: string }> = [];
  const kernelCalls: typeof calls = [];
  if ([...calls, ...rejectedCalls].some((call) => (
    call.name === SESSION_CONTROL_INTERACTION_REQUEST || call.name === SESSION_CONTROL_PLAN_PUBLISH
    || call.name === SESSION_CONTROL_PLAN_PROGRESS
  )) && calls.length + rejectedCalls.length > 1) {
    throw new LoopFailure(
      'session_control_turn_conflict',
      'interaction.request 与 plan.publish 必须独占 Provider turn。',
    );
  }
  for (const call of calls) {
    try {
      const control = decodeSessionControlCall(call.callId, call.name, call.input);
      if (control) controlCalls.push({ ...control, providerCallId: call.providerCallId });
      else kernelCalls.push(call);
    } catch (error) {
      if (!(error instanceof SessionControlError)) throw error;
      if (calls.length !== 1) {
        throw new LoopFailure(
          'session_control_rejection_turn_ambiguous',
          '包含多个调用的 Provider turn 无法只持久化单个 control rejection。',
        );
      }
      return {
        kind: 'controlRejected',
        rejection: {
          callId: call.callId,
          providerCallId: call.providerCallId,
          toolName: call.name,
          input: { ...call.input },
          error: { code: error.code, message: error.message },
        },
        ...(narrative ? { narrative } : {}),
        ...(orderedNarratives.length > 0 ? { narratives: orderedNarratives } : {}),
        ...usage,
        completion,
      };
    }
  }
  const blockingControls = controlCalls;
  if (
    blockingControls.length > 1
    || blockingControls.length > 0 && kernelCalls.length > 0
  ) {
    throw new LoopFailure(
      'session_control_turn_conflict',
      'interaction.request 与 plan.publish 必须独占 Provider turn。',
    );
  }

  const common = {
    ...usage,
    completion,
    ...(orderedNarratives.length > 0 ? { narratives: orderedNarratives } : {}),
  };
  const control = blockingControls[0];
  if (control?.kind === 'planProgress') return { ...control, ...common };
  if (control?.kind === 'interaction') {
    const interactionId = deps.nextId('interaction');
    if (interactionId === control.callId || interactionId === control.providerCallId) {
      throw new LoopFailure(
        'interaction_identity_invalid',
        'InteractionId、LogicalCallId 与 ProviderCallId 必须是互不复用的独立身份。',
      );
    }
    return {
      kind: 'interaction',
      interactionId,
      callId: control.callId,
      providerCallId: control.providerCallId,
      request: control.request,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (control?.kind === 'plan') {
    return {
      kind: 'plan',
      callId: control.callId,
      draft: control.draft,
      providerCallId: control.providerCallId,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (kernelCalls.length > 0 || rejectedCalls.length > 0) {
    return {
      kind: 'tools',
      calls: kernelCalls,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  const answer = orderedFinalMessage ?? (narrative
    ? { content: narrative, messageId: completeMessage?.messageId }
    : undefined);
  if (!answer) {
    throw new LoopFailure(
      'provider_answer_empty',
      'Provider turn 正常结束，但没有产生最终答复文本。',
    );
  }
  return {
    kind: 'answer',
    content: answer.content,
    ...(answer.messageId ? { messageId: answer.messageId } : {}),
    ...common,
  };
}

function trackProviderActivity(request: ProviderRequest, deps: AgentLoopDeps): {
  updateDraft(draft: AssistantDraftProjection | null): void;
  observe(event: ProviderEvent): void;
} {
  let draft: AssistantDraftProjection = { runId: request.runId, turnId: request.requestId, content: '' };
  const activity: ProviderActivityProjection = {
    purpose: request.purpose, phase: 'waitingResponse', startedAt: new Date().toISOString(),
  };
  const publish = () => deps.updateAssistantDraft({ ...draft, activity: { ...activity } });
  publish();
  return {
    updateDraft(next) {
      draft = next ?? { runId: request.runId, turnId: request.requestId, content: '' };
      publish();
    },
    observe(event) {
      if (event.type === 'reasoning.delta' && event.data.text) activity.phase = 'reasoning';
      else if (event.type === 'text.delta' && event.data.text) activity.phase = 'generatingOutput';
      else if (event.type === 'assistant.message') activity.phase = 'generatingOutput';
      else if (event.type === 'output.item.completed') {
        activity.phase = event.data.item.type === 'message' ? 'generatingOutput' : 'awaitingOutput';
      } else if (event.type === 'tool.call' || event.type === 'hosted.web-search.completed') {
        activity.phase = 'awaitingOutput';
      } else return;
      activity.lastContentAt = new Date().toISOString();
      publish();
    },
  };
}

function decodeProviderOutputBlock(
  output: { outputIndex: number; item: JsonObject },
  toolCodec: ProviderToolCodec,
): DecodedProviderOutputBlock {
  const item = structuredClone(output.item);
  switch (item.type) {
    case 'reasoning':
      return {
        outputIndex: output.outputIndex,
        kind: 'reasoning',
        content: providerOutputItemText(item, 'reasoning_text', false),
        item,
      };
    case 'message': {
      if (item.role !== 'assistant') {
        throw new LoopFailure(
          'provider_output_message_invalid',
          'Provider output message 不是 assistant 消息。',
        );
      }
      return {
        outputIndex: output.outputIndex,
        kind: 'message',
        content: providerOutputItemText(item, 'output_text', true),
        item,
      };
    }
    case 'function_call': {
      const providerCallId = typeof item.call_id === 'string' ? item.call_id : '';
      const wireName = typeof item.name === 'string' ? item.name : '';
      const canonicalName = toolCodec.canonicalByWire.get(wireName);
      if (!providerCallId || !wireName || !canonicalName || typeof item.arguments !== 'string') {
        throw new LoopFailure(
          canonicalName ? 'provider_tool_call_invalid' : 'provider_tool_alias_unknown',
          canonicalName
            ? 'Provider function_call 终态事实无效。'
            : `Provider 返回了当前 run 未声明的工具别名：${wireName}`,
        );
      }
      let input: unknown;
      const rejectInput = (message: string): DecodedProviderOutputBlock => ({
        outputIndex: output.outputIndex,
        kind: 'toolCallRejected',
        providerCallId,
        name: canonicalName,
        item,
        error: {
          code: 'provider_tool_call_arguments_invalid',
          message,
          issues: [{ path: '$', rule: 'json_object', message, expected: 'JSON object' }],
        },
      });
      try {
        input = JSON.parse(item.arguments);
      } catch {
        return rejectInput('Provider function_call arguments 不是有效 JSON。');
      }
      if (!isRecord(input)) {
        return rejectInput('Provider function_call arguments 必须是 JSON 对象。');
      }
      let decodedInput: JsonObject;
      try {
        decodedInput = decodeProviderToolInput(toolCodec, canonicalName, input);
      } catch (error) {
        if (!(error instanceof LoopFailure)) throw error;
        return {
          outputIndex: output.outputIndex,
          kind: 'toolCallRejected',
          providerCallId,
          name: canonicalName,
          item,
          error: {
            code: error.code,
            message: error.message,
            issues: [{ path: '$.workspace', rule: 'workspace_binding', message: error.message }],
          },
        };
      }
      return {
        outputIndex: output.outputIndex,
        kind: 'toolCall',
        providerCallId,
        name: canonicalName,
        input: decodedInput,
        item,
      };
    }
    case 'web_search_call': {
      const providerCallId = typeof item.id === 'string' ? item.id : '';
      if (
        !providerCallId
        || item.status !== 'completed' && item.status !== 'failed'
        || !isRecord(item.action)
      ) {
        throw new LoopFailure(
          'provider_hosted_search_item_invalid',
          'Provider hosted search 终态事实无效。',
        );
      }
      return {
        outputIndex: output.outputIndex,
        kind: 'providerHosted',
        providerCallId,
        item,
      };
    }
    default:
      throw new LoopFailure(
        'provider_output_item_type_unsupported',
        `Provider 返回了当前合同未支持的 output item 类型：${String(item.type)}`,
      );
  }
}

/** One correction turn per run, counted from durable facts rather than process state. */
function inputCorrectionFailure(events: readonly SessionEvent[], runId: string): LoopFailure | null {
  const errorsByCall = new Map<string, LocalAgentError>();
  for (const event of events) {
    if (!('runId' in event) || event.runId !== runId) continue;
    if (event.type === 'tool.input-rejected') {
      errorsByCall.set(event.callId, event.payload.rejection.error);
    } else if (event.type === 'session.control.rejected' && event.payload.error.code !== 'plan_revision_unchanged') {
      errorsByCall.set(event.callId, event.payload.error);
    }
  }
  const rejectedTurns: LocalAgentError[][] = [];
  for (const event of events) {
    if (event.type !== 'provider.turn.settled' || event.runId !== runId || event.payload.outcome !== 'completed') continue;
    const errors = [
      ...event.payload.orderedCallIds.flatMap((callId) => {
        const error = errorsByCall.get(callId);
        return error ? [error] : [];
      }),
      ...(event.payload.orderedOutputBlocks ?? []).flatMap((block) => (
        block.kind === 'toolCallRejected' ? [block.error] : []
      )),
    ];
    if (errors.length > 0) rejectedTurns.push(errors);
  }
  if (rejectedTurns.length < 2) return null;
  return new LoopFailure(
    'tool_input_correction_exhausted',
    `本次运行的工具参数纠正机会已用尽。原始拒绝：${rejectedTurns.flat().map((error) => `${error.code}: ${error.message}`).join('；')}`,
  );
}

function assistantDraftBlocks(
  outputs: readonly { outputIndex: number; item: JsonObject }[],
  toolCodec: ProviderToolCodec,
  streamedTextByOutputIndex: ReadonlyMap<number, string> = new Map(),
): AssistantDraftBlockProjection[] {
  const blocks = outputs.flatMap((output): AssistantDraftBlockProjection[] => {
    // Draft presentation must not admit tool inputs or interrupt their native stream.
    if (output.item.type === 'function_call' || output.item.type === 'reasoning') return [];
    const block = decodeProviderOutputBlock(output, toolCodec);
    switch (block.kind) {
      case 'reasoning':
      case 'toolCall':
      case 'toolCallRejected':
        return [];
      case 'message': {
        const phase = block.item.phase;
        if (phase !== undefined && phase !== null && typeof phase !== 'string') {
          throw new LoopFailure(
            'provider_output_message_phase_invalid',
            'Provider output message 的 phase 不是字符串。',
          );
        }
        const kind = phase === 'commentary'
          ? 'narrative'
          : phase === 'final_answer'
            ? 'finalMessage'
            : phase === undefined || phase === null
              ? 'message'
              : undefined;
        if (!kind) {
          throw new LoopFailure(
            'provider_output_message_phase_unsupported',
            `Provider output message 返回了当前合同未支持的 phase：${phase}`,
          );
        }
        return [{
          outputIndex: block.outputIndex,
          kind,
          content: block.content,
        }];
      }
      case 'providerHosted': {
        const status = block.item.status;
        const action = block.item.action;
        if (
          status !== 'completed'
          && status !== 'failed'
          || !isRecord(action)
        ) {
          throw new LoopFailure(
            'provider_hosted_search_item_invalid',
            'Provider hosted search 终态事实无效。',
          );
        }
        return [{
          outputIndex: block.outputIndex,
          kind: 'providerHosted',
          providerCallId: block.providerCallId,
          providerToolType: 'web_search',
          status,
          action: structuredClone(action),
        }];
      }
    }
  });
  const completedOutputIndexes = new Set(outputs.map((output) => output.outputIndex));
  for (const [outputIndex, content] of streamedTextByOutputIndex) {
    if (completedOutputIndexes.has(outputIndex)) {
      throw new LoopFailure(
        'provider_output_delta_after_completion',
        'Provider 在 output item 完成后继续发送该 item 的正文增量。',
      );
    }
    blocks.push({ outputIndex, kind: 'message', content });
  }
  return blocks.sort((left, right) => left.outputIndex - right.outputIndex);
}

function providerOutputItemText(
  item: JsonObject,
  partType: 'output_text' | 'reasoning_text',
  required: boolean,
): string {
  const parts = item.content;
  if (!Array.isArray(parts)) {
    if (!required && parts === undefined) return '';
    throw new LoopFailure(
      'provider_output_item_content_invalid',
      'Provider output item content 不是数组。',
    );
  }
  let text = '';
  for (const part of parts) {
    if (!isRecord(part) || part.type !== partType) continue;
    if (typeof part.text !== 'string') {
      throw new LoopFailure(
        'provider_output_item_content_invalid',
        'Provider output item 文本 part 缺少 text。',
      );
    }
    text += part.text;
  }
  if (required && !text.trim()) {
    throw new LoopFailure(
      'provider_output_item_content_invalid',
      'Provider output message 没有可显示正文。',
    );
  }
  return text;
}

function selectedPlanAuthorities(events: readonly SessionEvent[]): PlanAuthority[] {
  const confirmed = events.findLast(
    (event): event is Extract<SessionEvent, { type: 'plan.confirmed' }> => (
      event.type === 'plan.confirmed'
    ),
  );
  if (!confirmed) return [];
  const inactive = events.some((event) => (
    event.sequence > confirmed.sequence
    && (
      event.type === 'plan.revision.requested'
      || event.type === 'plan.superseded'
      || event.type === 'plan.cancelled'
      || event.type === 'plan.completed'
      || event.type === 'plan.invalidated'
    )
    && event.payload.planId === confirmed.payload.planId
    && event.payload.revision === confirmed.payload.revision
  ));
  return inactive ? [] : confirmed.payload.authorities.map(cloneAuthority);
}

function cloneAuthority(authority: PlanAuthority): PlanAuthority {
  return {
    ...authority,
    coveredOperations: authority.coveredOperations.map((operation) => ({ ...operation })),
  };
}

async function cancelRun(
  snapshot: LoopSnapshot,
  command: Extract<LoopCommand, { type: 'cancel' }>,
  deps: AgentLoopDeps,
  commit: (event: NewSessionEvent | readonly NewSessionEvent[]) => Promise<void>,
): Promise<LoopResult> {
  if (hasSettlement(snapshot.events, command.runId)) {
    return settlementResult(snapshot.events, command.runId);
  }
  let indeterminate: LocalAgentError | undefined;
  const current = pendingToolRequests(snapshot.events, command.runId)[0];
  if (current) {
    const reply = await deps.composition.kernel.cancel(current.callId, current.payload.attemptId);
    if (reply.status !== 'notFound') {
      await commitToolRecord(
        reply.record,
        expectedToolRecordIdentity(
          snapshot,
          runRuntimeSnapshot(snapshot, command.runId),
          current,
        ),
        commit,
      );
      if (reply.record.outcome === 'indeterminate') indeterminate = reply.record.error;
    } else if (!latestApproval(snapshot.events, command.runId, current.callId).requested) {
      indeterminate = {
        code: 'tool_effect_outcome_unknown',
        message: '取消时 Kernel 没有该调用的确定记录。',
      };
    }
  }
  if (indeterminate) {
    await commit({
      type: 'run.finishing',
      sessionId: snapshot.state.sessionId,
      runId: command.runId,
      payload: { outcome: 'indeterminate', error: indeterminate },
    });
    return finishingResult(command.runId, { outcome: 'indeterminate', error: indeterminate });
  }
  await commit({
    type: 'run.finishing',
    sessionId: snapshot.state.sessionId,
    runId: command.runId,
    payload: { outcome: 'cancelled' },
  });
  return finishingResult(command.runId, { outcome: 'cancelled' });
}

async function executeUntilAbort(
  deps: AgentLoopDeps,
  request: ToolExecutionRequest,
  signal: AbortSignal,
): Promise<ToolExecutionReply> {
  if (signal.aborted) {
    await cancelExecutingAttempt(deps, request);
    throw signal.reason ?? new Error('run_cancelled');
  }
  const execution = deps.composition.kernel.execute(request);
  void execution.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => {
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const winner = await Promise.race([
      execution.then((reply) => ({ type: 'execution' as const, reply })),
      aborted.then(() => ({ type: 'abort' as const })),
    ]);
    if (winner.type === 'execution') return winner.reply;
    const cancelled = await cancelExecutingAttempt(deps, request);
    if (cancelled.status === 'notFound') return await execution;
    return {
      schemaVersion: KERNEL_REPLY_VERSION,
      type: 'tool.execution',
      requestId: request.requestId,
      callId: request.callId,
      status: cancelled.status,
      record: cancelled.record,
    };
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function cancelExecutingAttempt(
  deps: AgentLoopDeps,
  request: ToolExecutionRequest,
) {
  try {
    return await deps.composition.kernel.cancel(request.callId, request.attemptId);
  } catch (error) {
    throw new LoopFailure(
      'tool_cancel_cleanup_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function commitToolRecord(
  record: ToolExecutionRecord,
  expected: ExpectedToolRecordIdentity,
  commit: (event: NewSessionEvent | readonly NewSessionEvent[]) => Promise<void>,
): Promise<void> {
  assertToolRecordIdentity(record, expected);
  await commit({
    type: 'tool.completed',
    sessionId: record.sessionId,
    runId: expected.runId,
    callId: expected.callId,
    payload: { record },
  });
}

function expectedToolRecordIdentity(
  snapshot: LoopSnapshot,
  runtime: RunRuntimeSnapshot,
  requestEvent: Extract<SessionEvent, { type: 'tool.requested' }>,
): ExpectedToolRecordIdentity {
  return {
    sessionId: snapshot.state.sessionId,
    runId: requestEvent.runId,
    extensionGenerationRef: runtime.extensionGenerationRef,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
    toolBindingRef: runtimeTool(runtime, requestEvent.payload.toolName).toolBindingRef,
    callId: requestEvent.callId,
    attemptId: requestEvent.payload.attemptId,
    toolName: requestEvent.payload.toolName,
    input: requestEvent.payload.input,
  };
}

function assertToolRecordIdentity(
  record: ToolExecutionRecord | ToolInputRejection,
  expected: ExpectedToolRecordIdentity,
): void {
  if (
    record.sessionId !== expected.sessionId
    || record.runId !== expected.runId
    || record.extensionGenerationRef !== expected.extensionGenerationRef
    || record.kernelCatalogSnapshotRef !== expected.kernelCatalogSnapshotRef
    || record.toolBindingRef !== expected.toolBindingRef
    || record.callId !== expected.callId
    || record.attemptId !== expected.attemptId
    || record.toolName !== expected.toolName
    || JSON.stringify(canonicalJsonValue(record.input))
      !== JSON.stringify(canonicalJsonValue(expected.input))
  ) {
    throw new LoopFailure(
      'kernel_record_identity_mismatch',
      'Kernel 记录不属于当前 run 固定的工具 binding 或调用事实。',
    );
  }
}

function pendingToolRequests(
  events: readonly SessionEvent[],
  runId: string,
): Array<Extract<SessionEvent, { type: 'tool.requested' }>> {
  const completed = new Set(events.flatMap((event) => (
    (event.type === 'tool.completed' || event.type === 'tool.input-rejected')
      && event.runId === runId ? [event.callId] : []
  )));
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'tool.requested' }> => (
      event.type === 'tool.requested'
      && event.runId === runId
      && !completed.has(event.callId)
    ),
  );
}

function latestApproval(
  events: readonly SessionEvent[],
  runId: string,
  callId: string,
): {
  requested?: Extract<SessionEvent, { type: 'approval.requested' }>;
  resolved?: Extract<SessionEvent, { type: 'approval.resolved' }>;
} {
  const result: {
    requested?: Extract<SessionEvent, { type: 'approval.requested' }>;
    resolved?: Extract<SessionEvent, { type: 'approval.resolved' }>;
  } = {};
  for (const event of events) {
    if (event.type === 'approval.requested' && event.runId === runId && event.callId === callId) {
      result.requested = event;
    }
    if (event.type === 'approval.resolved' && event.runId === runId && event.callId === callId) {
      result.resolved = event;
    }
  }
  return result;
}

function decodeContextUsage(data: Record<string, unknown>): ProviderTokenUsage | undefined {
  const value = data.usage;
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new LoopFailure('provider_usage_invalid', 'Provider 完成事件中的 usage 不是对象。');
  }
  const inputTokens = positiveOrZeroInteger(value.inputTokens);
  const outputTokens = positiveOrZeroInteger(value.outputTokens);
  const contextWindowTokens = positiveInteger(value.contextWindowTokens);
  const cacheReadPresent = Object.hasOwn(value, 'cacheReadInputTokens');
  const cacheMissPresent = Object.hasOwn(value, 'cacheMissInputTokens');
  const cacheReadInputTokens = !cacheReadPresent
    ? undefined
    : positiveOrZeroInteger(value.cacheReadInputTokens);
  const cacheMissInputTokens = !cacheMissPresent
    ? undefined
    : positiveOrZeroInteger(value.cacheMissInputTokens);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || contextWindowTokens === undefined
    || inputTokens + outputTokens > contextWindowTokens
    || cacheReadPresent !== cacheMissPresent
    || cacheReadPresent && (cacheReadInputTokens === undefined || cacheMissInputTokens === undefined)
    || cacheReadInputTokens !== undefined && cacheMissInputTokens !== undefined
      && cacheReadInputTokens + cacheMissInputTokens !== inputTokens
  ) {
    throw new LoopFailure('provider_usage_invalid', 'Provider 完成事件中的上下文计数无效。');
  }
  return {
    inputTokens,
    outputTokens,
    contextWindowTokens,
    ...(cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens, cacheMissInputTokens: cacheMissInputTokens! }),
  };
}

function assertProviderEvent(event: ProviderEvent, requestId: string): void {
  if (event.requestId !== requestId) {
    throw new LoopFailure('provider_request_identity_mismatch', 'Provider 事件属于其他请求。');
  }
}

function clonePlan(plan: ExecutionPlan): ExecutionPlan {
  return {
    planId: plan.planId,
    revision: plan.revision,
    title: plan.title,
    summary: plan.summary,
    steps: plan.steps.map((step) => ({
      ...step,
      ...(step.verification ? { verification: [...step.verification] } : {}),
    })),
    mutationManifest: plan.mutationManifest.map((operation) => ({ ...operation })),
  };
}

function nextPlanIdentity(
  events: readonly SessionEvent[],
  runId: string,
  createPlanId: () => string,
): Pick<ExecutionPlan, 'planId' | 'revision'> {
  const revisionRequest = events.findLast(
    (event): event is Extract<SessionEvent, { type: 'plan.revision.requested' }> => (
      event.type === 'plan.revision.requested'
      && event.runId === runId
      && !events.some((candidate) => (
        candidate.sequence > event.sequence
        && candidate.type === 'run.settled'
        && candidate.runId === runId
      ))
      && !events.some((candidate) => (
        candidate.sequence > event.sequence
        && (
          candidate.type === 'plan.cancelled'
          || candidate.type === 'plan.invalidated'
        )
        && candidate.payload.planId === event.payload.planId
        && candidate.payload.revision === event.payload.revision
      ))
      && !events.some((candidate) => (
        candidate.type === 'plan.published'
        && candidate.sequence > event.sequence
        && candidate.payload.planId === event.payload.planId
        && candidate.payload.revision === event.payload.revision + 1
      ))
    ),
  );
  if (revisionRequest) {
    return {
      planId: revisionRequest.payload.planId,
      revision: revisionRequest.payload.revision + 1,
    };
  }
  const planId = createPlanId();
  if (!planId || events.some((event) => event.type === 'plan.published' && event.payload.planId === planId)) {
    throw new LoopFailure('plan_id_reused', 'Session 生成的 planId 已经存在。');
  }
  return { planId, revision: 1 };
}

function comparablePriorPlan(
  state: SessionState,
  proposed: ExecutionPlan,
): ExecutionPlan | null {
  if (proposed.revision > 1) {
    return state.plans.find((candidate) => (
      candidate.planId === proposed.planId
      && candidate.revision === proposed.revision - 1
    )) ?? null;
  }
  const active = state.activePlanRef;
  if (!active) return null;
  return state.plans.find((candidate) => (
    candidate.planId === active.planId
    && candidate.revision === active.revision
    && candidate.status === 'confirmed'
  )) ?? null;
}

function planDefinitionKey(
  plan: Pick<ExecutionPlan, 'title' | 'summary' | 'steps' | 'mutationManifest'>,
): string {
  return JSON.stringify(canonicalJsonValue({
    title: plan.title,
    summary: plan.summary,
    steps: plan.steps,
    mutationManifest: plan.mutationManifest,
  }));
}

function planDraftInput(draft: PlanPublicationDraft): Record<string, unknown> {
  return {
    title: draft.title,
    summary: draft.summary,
    steps: draft.steps.map((step) => ({
      ...step,
      ...(step.verification ? { verification: [...step.verification] } : {}),
    })),
    mutationManifest: draft.mutationManifest.map((operation) => ({ ...operation })),
  };
}

function planProgressFact(
  snapshot: LoopSnapshot,
  runId: string,
  turn: Extract<ProviderTurn, { kind: 'planProgress' }>,
): NewSessionEvent {
  const active = snapshot.state.activePlanRef;
  const todo = snapshot.state.todoList;
  const confirmation = snapshot.events.findLast((event) => (
    event.type === 'plan.confirmed' && event.payload.planId === active?.planId
    && event.payload.revision === active?.revision
  ));
  const evidence = snapshot.events.find((event) => (
    event.type === 'tool.completed' && event.runId === runId
    && event.payload.record.recordId === turn.sourceFactRef
    && event.sequence > (confirmation?.sequence ?? Infinity)
  ));
  const valid = active && todo && confirmation
    && todo.sourcePlanId === active.planId && todo.sourcePlanRevision === active.revision
    && evidence?.type === 'tool.completed'
    && turn.updates.every((update) => todo.items.some((item) => item.todoId === update.todoId))
    && (!turn.updates.some((update) => update.status === 'completed') || evidence.payload.record.outcome === 'completed');
  if (!valid) return {
    type: 'session.control.rejected', sessionId: snapshot.state.sessionId, runId, callId: turn.callId,
    payload: {
      providerCallId: turn.providerCallId, toolName: SESSION_CONTROL_PLAN_PROGRESS,
      input: { sourceFactRef: turn.sourceFactRef, updates: turn.updates },
      error: { code: 'plan_progress_evidence_invalid', message: 'Use current Todo IDs and a tool result recordId from this run after Plan confirmation. Completion requires a successful result.' },
    },
  };
  return {
    type: 'todo.progressed', sessionId: snapshot.state.sessionId, runId, callId: turn.callId,
    payload: {
      providerCallId: turn.providerCallId,
      sourcePlanId: active.planId, sourcePlanRevision: active.revision,
      sourceFactRef: turn.sourceFactRef, updates: turn.updates,
    },
  };
}

function completedPlanAwaitingLifecycle(
  state: SessionState,
): { planId: string; revision: number } | null {
  const todo = state.todoList;
  if (!todo) return null;
  const plan = state.plans.find((candidate) => (
    candidate.planId === todo.sourcePlanId
    && candidate.revision === todo.sourcePlanRevision
  ));
  return plan?.status === 'confirmed'
    && todo.items.length > 0
    && todo.items.every((item) => item.status === 'completed')
    ? { planId: plan.planId, revision: plan.revision }
    : null;
}

function confirmedPlanAwaitingExecution(
  state: SessionState,
): { planId: string; revision: number } | null {
  const active = state.activePlanRef;
  const todo = state.todoList;
  if (
    !active
    || !todo
    || todo.sourcePlanId !== active.planId
    || todo.sourcePlanRevision !== active.revision
    || todo.items.length === 0
    || todo.items.every((item) => item.status === 'completed')
  ) return null;
  const plan = state.plans.find((candidate) => (
    candidate.planId === active.planId
    && candidate.revision === active.revision
  ));
  return plan?.status === 'confirmed' ? { ...active } : null;
}

function hasSettlement(events: readonly SessionEvent[], runId: string): boolean {
  return events.some((event) => event.type === 'run.settled' && event.runId === runId);
}

function uncompletedProviderComposition(
  snapshot: LoopSnapshot,
  runId: string,
): SessionState['contextCompositions'][number] | null {
  return snapshot.state.contextCompositions.find((receipt) => (
    receipt.runId === runId
    && snapshot.state.providerTurns[receipt.providerRequestId] === undefined
  )) ?? null;
}

function runRuntimeSnapshot(snapshot: LoopSnapshot, runId: string): RunRuntimeSnapshot {
  const runtime = snapshot.state.runRuntimeSnapshots[runId];
  if (!runtime) throw new LoopFailure('run_runtime_snapshot_missing', '当前 run 缺少运行时快照。');
  return runtime;
}

function runtimeTool(runtime: RunRuntimeSnapshot, name: string): PreparedToolDescriptor {
  const tool = runtime.tools.find((candidate) => candidate.name === name);
  if (!tool || tool.availability !== 'callable') {
    throw new LoopFailure('run_tool_binding_missing', `当前 run 缺少可调用工具 binding：${name}`);
  }
  return tool;
}

function providerTurnSettledEvent(
  sessionId: string,
  runId: string,
  completion: ProviderTurnCompletion,
): NewSessionEvent {
  return {
    type: 'provider.turn.settled',
    sessionId,
    runId,
    payload: {
      providerRequestId: completion.providerRequestId,
      purpose: completion.purpose,
      providerRuntimeRef: completion.providerRuntimeRef,
      outcome: 'completed',
      orderedCallIds: [...completion.orderedCallIds],
      ...(completion.reasoningContent !== undefined
        ? { reasoningContent: completion.reasoningContent }
        : {}),
      ...(completion.reasoningSignature !== undefined
        ? { reasoningSignature: completion.reasoningSignature }
        : {}),
      ...(completion.hostedWebSearchCalls !== undefined
        ? {
            hostedWebSearchCalls: completion.hostedWebSearchCalls
              .map((item) => structuredClone(item)),
          }
        : {}),
      ...(completion.orderedOutputBlocks !== undefined
        ? {
            orderedOutputBlocks: completion.orderedOutputBlocks.map((block) => ({
              ...block,
              item: structuredClone(block.item),
            })),
          }
        : {}),
    },
  };
}

function providerTurnTerminalEvent(
  sessionId: string,
  runId: string,
  composition: SessionState['contextCompositions'][number],
  providerRuntimeRef: string,
  settlement: Extract<RunSettlement, { outcome: 'failed' | 'indeterminate' }>,
): NewSessionEvent {
  return {
    type: 'provider.turn.settled',
    sessionId,
    runId,
    payload: {
      providerRequestId: composition.providerRequestId,
      purpose: composition.purpose,
      providerRuntimeRef,
      outcome: settlement.outcome,
      error: { ...settlement.error },
    },
  };
}

function orderedProviderCallFacts(
  completion: ProviderTurnCompletion,
  facts: readonly NewSessionEvent[],
): NewSessionEvent[] {
  const byCallId = new Map<string, NewSessionEvent>();
  for (const fact of facts) {
    if (!('callId' in fact) || !fact.callId || byCallId.has(fact.callId)) {
      throw new LoopFailure(
        'provider_turn_call_fact_invalid',
        'Provider turn 的调用事实缺少或重复 LogicalCallId。',
      );
    }
    byCallId.set(fact.callId, fact);
  }
  if (
    byCallId.size !== completion.orderedCallIds.length
    || completion.orderedCallIds.some((callId) => !byCallId.has(callId))
  ) {
    throw new LoopFailure(
      'provider_turn_call_fact_mismatch',
      'Provider turn 完成事实与本 turn 的调用事实集合不一致。',
    );
  }
  return completion.orderedCallIds.map((callId) => byCallId.get(callId)!);
}

function settlementResult(events: readonly SessionEvent[], runId: string): LoopResult {
  const event = events.findLast(
    (candidate): candidate is Extract<SessionEvent, { type: 'run.settled' }> => (
      candidate.type === 'run.settled' && candidate.runId === runId
    ),
  );
  if (!event) throw new Error('run_settlement_missing');
  return { status: 'settled', runId, outcome: event.payload.outcome };
}

function finishingResult(runId: string, settlement: RunSettlement): LoopResult {
  return {
    status: 'finishing',
    runId,
    settlement: settlement.outcome === 'completed'
      ? { ...settlement }
      : settlement.outcome === 'failed' || settlement.outcome === 'indeterminate'
        ? { outcome: settlement.outcome, error: { ...settlement.error } }
        : { outcome: 'cancelled' },
  };
}

export function loopSnapshot(sessionId: string, events: readonly SessionEvent[]): LoopSnapshot {
  return { events: [...events], state: recoverSession(sessionId, events) };
}

function runWorkspaceBindings(
  snapshot: LoopSnapshot,
  runId: string,
): WorkspaceBindingDisplay[] {
  const run = snapshot.state.run;
  if (!run || run.runId !== runId) {
    throw new LoopFailure('run_workspace_snapshot_missing', '当前 run 缺少冻结的目录索引快照。');
  }
  return run.workspaceBindings.map((binding) => ({ ...binding }));
}

function positiveOrZeroInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('run_cancelled');
}

function localAgentError(error: unknown): LocalAgentError {
  if (error instanceof LoopFailure) return { code: error.code, message: error.message };
  if (error instanceof SessionControlError) return { code: error.code, message: error.message };
  return {
    code: 'agent_loop_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
