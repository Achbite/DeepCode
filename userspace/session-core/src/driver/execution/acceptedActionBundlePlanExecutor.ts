import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../../context/index.js';
import type { ProjectWorkingDirectory, ResourcePacket } from '../../context/types.js';
import type { AcceptedImplementationPlanContext } from '../../accepted-plan/types.js';
import type { InteractionOverlayContext } from '../pipelines/interactionOverlayCodec.js';
import type { PlanContext } from '../proposal/planContextIndex.js';
import { decisionContinuationInput } from '../runContinuation.js';
import type { InterventionLevel, ReviewContinuationMode } from '../types.js';
import { assertKernelReplyOk, kernelReplyErrorMessage } from './kernelReplyGuard.js';

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

export interface AcceptedActionBundlePlanResumeInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  appendUserMessage: false;
  requirementConfirmationMode: 'off';
  reviewContinuationMode?: AcceptedActionBundlePlanReviewContinuationMode;
  interventionLevel?: AcceptedActionBundlePlanInterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export interface AcceptedActionBundlePlanOverlay {
  plan: PlanContext;
  acceptedPlan: AcceptedImplementationPlanContext;
}

export interface AcceptedActionBundlePlanExecutorPorts {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult | undefined>;
  resumeUserTurn(input: AcceptedActionBundlePlanResumeInput): Promise<AgentSessionResult>;
  kernelExecutionContractId(report?: Record<string, unknown>): string | undefined;
  temporaryGrantsForPlan(plan: PlanContext): unknown[];
  recentResourcePackets(events: AgentEvent[]): ResourcePacket[];
  sessionRunStateEvent(input: Record<string, unknown>): AgentEvent;
  acceptedPlanActionBatchPreflightEvent(
    sessionId: string,
    plan: PlanContext,
    batch: Record<string, unknown>,
    ts: string,
    id: string
  ): AgentEvent;
  planActionBundlePreflightFailureEvents(
    sessionId: string,
    plan: PlanContext,
    reasons: string[],
    ts: string,
    id: string
  ): AgentEvent[];
  planActionBundleExecutionFailureEvents(
    sessionId: string,
    plan: PlanContext,
    batchEvents: unknown[],
    batch: Record<string, unknown>,
    ts: string,
    id: string
  ): AgentEvent[];
  planActionBundleExecutionExceptionEvents(
    sessionId: string,
    plan: PlanContext,
    message: string,
    code: string,
    ts: string,
    id: string
  ): AgentEvent[];
  acceptedPlanBatchCheckpointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    proposal: unknown,
    kernelEvents: unknown[],
    progress: unknown,
    ts: string,
    id: string
  ): AgentEvent;
  acceptedPlanTaskSavepointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    nextAccepted: AcceptedImplementationPlanContext,
    progress: unknown,
    kernelEvents: unknown[],
    cursor: unknown,
    context: unknown,
    ts: string,
    id: string
  ): AgentEvent;
  deletePreflightReasons(batch: Record<string, unknown>, resourcePackets: ResourcePacket[]): string[];
  hasFailureOrBlocker(events: unknown[]): boolean;
  actionBatchReadyForReview(events: unknown[]): boolean;
  hasPermissionRequest(events: unknown[]): boolean;
  permissionId(events: unknown[]): string | undefined;
  planProposal(plan: PlanContext): unknown;
  batchProgress(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
    proposal: unknown;
    kernelEvents: unknown[];
  }): { completedTaskIds: string[] };
  acceptedPlanAfterBatch(accepted: AcceptedImplementationPlanContext, completedTaskIds: string[]): AcceptedImplementationPlanContext;
  runtimeSnapshot(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
    resourcePackets: ResourcePacket[];
  }): {
    taskExecutionCursor?: unknown;
    currentTaskContext?: unknown;
  };
  acceptedPlanComplete(accepted: AcceptedImplementationPlanContext): boolean;
  executionRequest(plan: PlanContext, acceptedPlan: AcceptedImplementationPlanContext): string;
  reviewHandoff(input: {
    sessionId: string;
    runId: string;
    planId: string;
    plan: PlanContext;
    result: AgentSessionResult;
    currentKernelEvents: unknown[];
    requestIdPrefix: string;
    interactionOverlay?: InteractionOverlayContext;
    assertFactsReplyOk?: {
      code: string;
      fallback: string;
    };
  }): Promise<AgentSessionResult>;
}

export class AcceptedActionBundlePlanExecutor {
  constructor(private readonly ports: AcceptedActionBundlePlanExecutorPorts) {}

  async execute(
    input: AcceptedActionBundlePlanInput,
    plan: PlanContext,
    initialResult: AgentSessionResult,
    acceptedOverlay?: AcceptedActionBundlePlanOverlay
  ): Promise<AgentSessionResult> {
    let result = initialResult;
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

      const batch: Record<string, unknown> = {
        planId: plan.planId,
        contractId: this.ports.kernelExecutionContractId(plan.planReviewReport),
        actionBundle: plan.actionBundle,
        codeBlocks: plan.codeBlocks,
        commandBlocks: plan.commandBlocks,
      };
      result = await this.ports.append(input.sessionId, [
        this.ports.acceptedPlanActionBatchPreflightEvent(
          input.sessionId,
          plan,
          batch,
          this.ports.now(),
          this.ports.createId('accepted-action-plan-preflight')
        ),
      ]) ?? result;

      const deletePreflightReasons = this.ports.deletePreflightReasons(batch, this.ports.recentResourcePackets(result.events));
      if (deletePreflightReasons.length) {
        return this.ports.append(input.sessionId, this.ports.planActionBundlePreflightFailureEvents(
          input.sessionId,
          plan,
          deletePreflightReasons,
          this.ports.now(),
          this.ports.createId('accepted-action-plan-preflight-failed')
        )) ?? result;
      }

      const decisionReply = await this.ports.kernel({
        command: {
          kind: 'userDecisionSubmit',
          requestId: this.ports.createId('user-decision-plan'),
          runId: plan.runId,
          sessionId: input.sessionId,
          decision: {
            decisionId: this.ports.createId('decision-plan'),
            decisionKind: 'plan',
            targetId: plan.planId,
            payload: {
              decision: input.decision,
              guidance: input.guidance,
            },
          },
        },
      });
      assertKernelReplyOk(
        decisionReply,
        (code, message) => new AcceptedActionBundlePlanExecutionError(code, message),
        'accepted_plan_user_decision_failed',
        'Kernel plan decision submit failed'
      );
      result = await this.ports.appendProjectedKernelEvents(input.sessionId, decisionReply) ?? result;

      const grantEvents: unknown[] = [];
      for (const grant of this.ports.temporaryGrantsForPlan(plan)) {
        const grantReply = await this.ports.kernel({
          command: {
            kind: 'permissionGrantTemporary',
            requestId: this.ports.createId('plan-temp-grant'),
            runId: plan.runId,
            grant,
          },
        });
        assertKernelReplyOk(
          grantReply,
          (code, message) => new AcceptedActionBundlePlanExecutionError(code, message),
          'accepted_plan_grant_failed',
          'Kernel temporary grant failed'
        );
        grantEvents.push(...(grantReply.events ?? []));
      }
      if (grantEvents.length) {
        result = await this.ports.appendProjectedKernelEvents(input.sessionId, { ok: true, events: grantEvents }) ?? result;
      }

      const batchReply = await this.ports.kernel({
        command: {
          kind: 'actionBatchSubmit',
          requestId: this.ports.createId('action-batch-submit'),
          runId: plan.runId,
          sessionId: input.sessionId,
          batch,
        },
      });
      result = await this.ports.appendProjectedKernelEvents(input.sessionId, batchReply) ?? result;
      const batchEvents = batchReply.events ?? [];
      if (!batchReply.ok && batchEvents.length === 0) {
        throw new AcceptedActionBundlePlanExecutionError(
          stringValue(objectRecord(batchReply.error)?.code) ?? 'accepted_plan_action_batch_submit_failed',
          kernelReplyErrorMessage(batchReply, 'Kernel actionBatchSubmit failed without execution facts')
        );
      }
      if (this.ports.hasFailureOrBlocker(batchEvents)) {
        return this.ports.append(input.sessionId, this.ports.planActionBundleExecutionFailureEvents(
          input.sessionId,
          plan,
          batchEvents,
          batch,
          this.ports.now(),
          this.ports.createId('accepted-action-plan-batch-failed')
        )) ?? result;
      }
      if (!this.ports.actionBatchReadyForReview(batchEvents)) {
        if (this.ports.hasPermissionRequest(batchEvents)) {
          const permissionId = this.ports.permissionId(batchEvents);
          return this.ports.append(input.sessionId, [
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
          ]) ?? result;
        }
        return result;
      }

      if (acceptedOverlay) {
        const progressProposal = this.ports.planProposal(plan);
        const progress = this.ports.batchProgress({
          acceptedPlan: acceptedOverlay.acceptedPlan,
          proposal: progressProposal,
          kernelEvents: batchEvents,
        });
        const nextAccepted = this.ports.acceptedPlanAfterBatch(acceptedOverlay.acceptedPlan, progress.completedTaskIds);
        const runtime = this.ports.runtimeSnapshot({
          acceptedPlan: acceptedOverlay.acceptedPlan,
          resourcePackets: this.ports.recentResourcePackets(result.events),
        });
        const savepointId = this.ports.createId('accepted-plan-overlay-task-savepoint');
        result = await this.ports.append(input.sessionId, [
          this.ports.acceptedPlanBatchCheckpointEvent(
            input.sessionId,
            plan.runId,
            acceptedOverlay.acceptedPlan,
            progressProposal,
            batchEvents,
            progress,
            this.ports.now(),
            this.ports.createId('accepted-plan-overlay-batch-checkpoint')
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
            savepointId
          ),
        ]) ?? result;
        if (!this.ports.acceptedPlanComplete(nextAccepted)) {
          return this.ports.resumeUserTurn(decisionContinuationInput(input, {
            content: this.ports.executionRequest(acceptedOverlay.plan, nextAccepted),
            attachments: nextAccepted.executionRoot ? [nextAccepted.executionRoot.attachment] : [],
            existingEvents: result.events,
            reviewContinuationMode: input.reviewContinuationMode,
            resumeResourcePackets: true,
            acceptedImplementationPlan: nextAccepted,
            interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          }));
        }
        plan = {
          ...plan,
          planId: acceptedOverlay.acceptedPlan.planId,
          implementationPlan: acceptedOverlay.acceptedPlan.rawPlan,
        };
      }

      return this.ports.reviewHandoff({
        sessionId: input.sessionId,
        runId: plan.runId,
        planId: plan.planId,
        plan,
        result,
        currentKernelEvents: batchEvents,
        requestIdPrefix: 'review-facts-get',
        interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
        assertFactsReplyOk: {
          code: 'accepted_plan_review_facts_failed',
          fallback: 'Kernel reviewFactsGet failed',
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const structuredCode = stringValue(objectRecord(error)?.code);
      const code = error instanceof AcceptedActionBundlePlanExecutionError
        ? error.code
        : structuredCode ?? 'accepted_plan_execution_failed';
      return this.ports.append(input.sessionId, this.ports.planActionBundleExecutionExceptionEvents(
        input.sessionId,
        plan,
        message,
        code,
        this.ports.now(),
        this.ports.createId('accepted-action-plan-execution-failed')
      )) ?? result;
    }
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
