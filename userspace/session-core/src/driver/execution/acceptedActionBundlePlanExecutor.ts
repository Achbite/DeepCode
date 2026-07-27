import type {
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  KernelCommandEnvelope,
  KernelActionBatchV1,
  KernelReply,
} from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../../context/index.js';
import type { ProjectWorkingDirectory, ResourcePacket } from '../../context/types.js';
import type { AcceptedTaskPlanContext, AcceptedPlanBatchProgress } from '../../accepted-plan/types.js';
import type { InteractionOverlayContext } from '../pipelines/interactionOverlayCodec.js';
import type { PlanContext } from '../proposal/planContextIndex.js';
import type { ProposalEnvelope } from '../../protocol/types.js';
import {
  acceptedPlanContinuationInput,
  returnSessionResult,
  type SessionLoopControlResult,
} from '../runContinuation.js';
import type { InterventionLevel, ReviewContinuationMode } from '../types.js';
import {
  conversationPresentationLanguageBindingFromEvents,
  type ConversationPresentationLanguage,
} from '../projection/conversationPresentationLanguage.js';
import { assertKernelReplyOk, kernelReplyErrorMessage } from './kernelReplyGuard.js';
import type { KernelReplyObservation } from './kernelEventStatusIndex.js';

export type AcceptedActionBundlePlanDecision = 'accept' | 'reject' | 'revise';
export type AcceptedActionBundlePlanReviewContinuationMode = ReviewContinuationMode;
export type AcceptedActionBundlePlanInterventionLevel = InterventionLevel;

export interface AcceptedActionBundlePlanInput {
  sessionId: string;
  decision: AcceptedActionBundlePlanDecision;
  guidance?: string;
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: AcceptedActionBundlePlanReviewContinuationMode;
  interventionLevel?: AcceptedActionBundlePlanInterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
}

export interface AcceptedActionBundlePlanOverlay {
  plan: PlanContext;
  acceptedPlan: AcceptedTaskPlanContext;
}

export interface AcceptedActionBundlePlanExecutorPorts {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  observeKernel(request: KernelCommandEnvelope): Promise<KernelReplyObservation>;
  appendProjectedKernelEvents(
    sessionId: string,
    reply: KernelReply,
    language: ConversationPresentationLanguage
  ): Promise<AgentSessionResult | undefined>;
  kernelExecutionContractId(report?: Record<string, unknown>): string | undefined;
  kernelExecutionContractHash(report?: Record<string, unknown>): string | undefined;
  recentResourcePackets(events: AgentEvent[]): ResourcePacket[];
  sessionRunStateEvent(input: Record<string, unknown>): AgentEvent;
  acceptedPlanActionBatchPreflightEvent(
    sessionId: string,
    plan: PlanContext,
    batch: KernelActionBatchV1,
    ts: string,
    id: string,
    language: ConversationPresentationLanguage
  ): AgentEvent;
  planActionBundleExecutionFailureEvents(
    sessionId: string,
    plan: PlanContext,
    batchEvents: unknown[],
    batch: KernelActionBatchV1,
    ts: string,
    id: string,
    language: ConversationPresentationLanguage
  ): AgentEvent[];
  planActionBundleExecutionExceptionEvents(
    sessionId: string,
    plan: PlanContext,
    message: string,
    code: string,
    ts: string,
    id: string,
    language: ConversationPresentationLanguage
  ): AgentEvent[];
  acceptedPlanBatchCheckpointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    proposal: unknown,
    kernelEvents: unknown[],
    progress: unknown,
    ts: string,
    id: string,
    language: ConversationPresentationLanguage
  ): AgentEvent;
  acceptedPlanTaskSavepointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    nextAccepted: AcceptedTaskPlanContext,
    progress: unknown,
    kernelEvents: unknown[],
    cursor: unknown,
    context: unknown,
    ts: string,
    id: string,
    language: ConversationPresentationLanguage
  ): AgentEvent;
  planProposal(plan: PlanContext): ProposalEnvelope;
  recordKernelBatchProgress(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    proposal: ProposalEnvelope;
    kernelEvents: unknown[];
  }): {
    progress: AcceptedPlanBatchProgress;
    completedTaskIds: string[];
    nextAcceptedPlan: AcceptedTaskPlanContext;
  };
  runtimeSnapshot(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    resourcePackets: ResourcePacket[];
  }): {
    taskExecutionCursor?: unknown;
    currentTaskContext?: unknown;
  };
  acceptedPlanComplete(accepted: AcceptedTaskPlanContext): boolean;
  executionRequest(plan: PlanContext, acceptedPlan: AcceptedTaskPlanContext): string;
}

export class AcceptedActionBundlePlanExecutor {
  constructor(private readonly ports: AcceptedActionBundlePlanExecutorPorts) {}

  async execute(
    input: AcceptedActionBundlePlanInput,
    plan: PlanContext,
    initialResult: AgentSessionResult,
    acceptedOverlay?: AcceptedActionBundlePlanOverlay
  ): Promise<SessionLoopControlResult> {
    let result = initialResult;
    const presentationBinding = conversationPresentationLanguageBindingFromEvents(
      initialResult.events,
      plan.runId
    );
    const presentationLanguage = presentationBinding.language;
    try {
      result = await this.ports.append(input.sessionId, [
        this.ports.sessionRunStateEvent({
          sessionId: input.sessionId,
          runId: plan.runId,
          phase: 'executing_accepted_plan',
          status: 'running',
          reason: 'accepted_plan_execution',
          decisionOwner: {
            kind: 'plan',
            runId: plan.runId,
            targetId: plan.planId,
            planId: plan.planId,
          },
          interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          ts: this.ports.now(),
          id: this.ports.createId('session-run-accepted-action-plan-execution'),
        }),
      ]) ?? result;

      const batchCandidate: unknown = {
        planId: plan.planId,
        contractId: this.ports.kernelExecutionContractId(plan.planReviewReport),
        contractHash: this.ports.kernelExecutionContractHash(plan.planReviewReport),
        actionBundle: plan.actionBundle,
        contentBlocks: plan.contentBlocks,
      };
      assertKernelActionBatch(batchCandidate);
      const batch = batchCandidate;
      result = await this.ports.append(input.sessionId, [
        this.ports.acceptedPlanActionBatchPreflightEvent(
          input.sessionId,
          plan,
          batch,
          this.ports.now(),
          this.ports.createId('accepted-action-plan-preflight'),
          presentationLanguage
        ),
      ]) ?? result;

      const contractId = this.ports.kernelExecutionContractId(plan.planReviewReport);
      if (!contractId) {
        throw new AcceptedActionBundlePlanExecutionError(
          'missing_execution_contract',
          'Kernel proposal review did not produce an execution contract.'
        );
      }

      const observed = await this.ports.observeKernel({
        command: {
          kind: 'actionBatchSubmit',
          requestId: this.ports.createId('action-batch-submit'),
          runId: plan.runId,
          sessionId: input.sessionId,
          batch,
        },
      });
      const batchReply = observed.reply;
      result = await this.ports.appendProjectedKernelEvents(
        input.sessionId,
        batchReply,
        presentationLanguage
      ) ?? result;
      const batchEvents = batchReply.events ?? [];
      if (observed.kind === 'commandFailed') {
        throw new AcceptedActionBundlePlanExecutionError(
          observed.code,
          kernelReplyErrorMessage(batchReply, 'Kernel actionBatchSubmit failed without execution facts')
        );
      }
      if (observed.kind === 'factsObserved' && observed.hasFailureOrBlocker) {
        return returnSessionResult(await this.ports.append(input.sessionId, this.ports.planActionBundleExecutionFailureEvents(
          input.sessionId,
          plan,
          batchEvents,
          batch,
          this.ports.now(),
          this.ports.createId('accepted-action-plan-batch-failed'),
          presentationLanguage
        )) ?? result);
      }
      if (observed.kind === 'permissionInterrupted') {
        const permissionId = observed.permissionId;
        return returnSessionResult(await this.ports.append(input.sessionId, [
          this.ports.sessionRunStateEvent({
            sessionId: input.sessionId,
            runId: plan.runId,
            phase: 'waiting_permission',
            reason: 'permission',
            decisionOwner: {
              kind: 'permission',
              runId: plan.runId,
              targetId: permissionId,
              permissionId,
              planId: plan.planId,
            },
            interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
            ts: this.ports.now(),
            id: this.ports.createId('session-run-waiting-permission'),
          }),
        ]) ?? result);
      }
      if (observed.kind !== 'factsObserved' || !observed.readyForReview) {
        return returnSessionResult(result);
      }

      if (acceptedOverlay) {
        const progressProposal = this.ports.planProposal(plan);
        const ledgerEffect = this.ports.recordKernelBatchProgress({
          acceptedPlan: acceptedOverlay.acceptedPlan,
          proposal: progressProposal,
          kernelEvents: batchEvents,
        });
        const progress = ledgerEffect.progress;
        const nextAccepted = ledgerEffect.nextAcceptedPlan;
        const runtime = this.ports.runtimeSnapshot({
          acceptedPlan: acceptedOverlay.acceptedPlan,
          resourcePackets: this.ports.recentResourcePackets(result.events),
        });
        const savepointId = this.ports.createId('accepted-plan-overlay-task-savepoint');
        result = await this.ports.append(input.sessionId, [
          this.ports.acceptedPlanBatchCheckpointEvent(
            input.sessionId,
            plan.runId,
            nextAccepted,
            progressProposal,
            batchEvents,
            progress,
            this.ports.now(),
            this.ports.createId('accepted-plan-overlay-batch-checkpoint'),
            presentationLanguage
          ),
          this.ports.acceptedPlanTaskSavepointEvent(
            input.sessionId,
            plan.runId,
            acceptedOverlay.acceptedPlan,
            nextAccepted,
            progress,
            batchEvents,
            runtime.taskExecutionCursor,
            runtime.currentTaskContext,
            this.ports.now(),
            savepointId,
            presentationLanguage
          ),
        ]) ?? result;
        if (!this.ports.acceptedPlanComplete(nextAccepted)) {
          return {
            kind: 'resume',
            input: acceptedPlanContinuationInput(input, {
              content: this.ports.executionRequest(acceptedOverlay.plan, nextAccepted),
              attachments: nextAccepted.executionRoot ? [nextAccepted.executionRoot.attachment] : [],
              existingEvents: result.events,
              reviewContinuationMode: input.reviewContinuationMode,
              acceptedTaskPlan: nextAccepted,
              interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
            }),
          };
        }
        plan = {
          ...plan,
          planId: acceptedOverlay.acceptedPlan.planId,
          taskPlan: acceptedOverlay.acceptedPlan.rawPlan,
        };
      }

      return {
        kind: 'assembleReview',
        request: {
          sessionId: input.sessionId,
          runId: plan.runId,
          planId: plan.planId,
          plan,
          result,
          currentKernelEvents: batchEvents,
          requestIdPrefix: 'review-facts-get',
          presentationBinding,
          interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          assertFactsReplyOk: {
            code: 'accepted_plan_review_facts_failed',
            fallback: 'Kernel reviewFactsGet failed',
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const structuredCode = stringValue(objectRecord(error)?.code);
      const code = error instanceof AcceptedActionBundlePlanExecutionError
        ? error.code
        : structuredCode ?? 'accepted_plan_execution_failed';
      return returnSessionResult(await this.ports.append(input.sessionId, this.ports.planActionBundleExecutionExceptionEvents(
        input.sessionId,
        plan,
        message,
        code,
        this.ports.now(),
        this.ports.createId('accepted-action-plan-execution-failed'),
        presentationLanguage
      )) ?? result);
    }
  }
}

function assertKernelActionBatch(value: unknown): asserts value is KernelActionBatchV1 {
  const batch = objectRecord(value);
  const bundle = objectRecord(batch?.actionBundle);
  if (
    !stringValue(batch?.planId)
    || !stringValue(batch?.contractId)
    || !stringValue(batch?.contractHash)
    || !stringValue(bundle?.id)
    || !stringValue(bundle?.goal)
    || !Array.isArray(bundle?.actions)
    || !Array.isArray(batch?.contentBlocks)
  ) {
    throw new AcceptedActionBundlePlanExecutionError(
      'kernel_action_batch_invalid',
      'Accepted action plan could not form a canonical KernelActionBatchV1.'
    );
  }
}

export class AcceptedActionBundlePlanExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AcceptedActionBundlePlanExecutionError';
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
