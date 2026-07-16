import type { AgentConversationActivity, AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { AcceptedTaskPlanContext, ActionBatchFailureDetail } from '../execution/index.js';
import type { InteractionOverlayContext, SessionTurnPhase } from '../pipelines/index.js';
import type { DecisionOwnerRef, SessionRunStateReason, SessionRunStateStatus } from './sessionProgressProjectionBuilder.js';

export interface SessionFailurePlanContext {
  runId: string;
  planId: string;
  interactionOverlay?: InteractionOverlayContext;
}

export interface SessionFailureProjectionBuilderPorts {
  actionBatchFailureDetails(kernelEvents: unknown[], batch?: Record<string, unknown>): ActionBatchFailureDetail[];
  actionBatchFailureSummary(failure: ActionBatchFailureDetail): string;
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: SessionTurnPhase;
    status?: SessionRunStateStatus;
    reason: SessionRunStateReason;
    decisionOwner: DecisionOwnerRef;
    interactionOverlay?: InteractionOverlayContext;
    ts: string;
    id: string;
  }): AgentEvent;
}

export class SessionFailureProjectionBuilder {
  constructor(private readonly ports: SessionFailureProjectionBuilderPorts) {}

  internalFailureEvents(input: {
    sessionId: string;
    runId: string;
    stage: string;
    code: string;
    message: string;
    reason: 'driver_failure' | 'provider_failure';
    ts: string;
    id: string;
  }): AgentEvent[] {
    const diagnosticRef = `${input.id}-diagnostic`;
    return [
      this.errorEvent({
        id: diagnosticRef,
        sessionId: input.sessionId,
        ts: input.ts,
        message: input.message,
        messageKey: 'session.driver.internalFailure',
        code: input.code,
        runId: input.runId,
        title: `Session ${input.stage} failed`,
        errorMessage: input.message,
      }),
      this.ports.sessionRunStateEvent({
        sessionId: input.sessionId,
        runId: input.runId,
        phase: 'failed',
        status: 'failed',
        reason: input.reason,
        decisionOwner: {
          kind: 'session',
          runId: input.runId,
          targetId: diagnosticRef,
        },
        ts: input.ts,
        id: input.id,
      }),
    ];
  }

  acceptedTaskDiagnosticFailureEvents(input: {
    sessionId: string;
    runId: string;
    planId: string;
    taskId: string;
    severity: string;
    message: string;
    ts: string;
    id: string;
  }): AgentEvent[] {
    const diagnosticId = `${input.id}-diagnostic`;
    return [
      {
        id: `${input.id}-task`,
        sessionId: input.sessionId,
        ts: input.ts,
        kind: 'workflow_stage',
        payload: {
          stage: 'accepted_plan.task_failed',
          status: 'failed',
          code: 'accepted_task_diagnostic',
          severity: input.severity,
          summary: input.message,
          runId: input.runId,
          planId: input.planId,
          taskId: input.taskId,
          channel: 'progress',
          visibility: 'conversation',
          presentation: 'collapsible',
        },
      },
      this.errorEvent({
        id: diagnosticId,
        sessionId: input.sessionId,
        ts: input.ts,
        message: input.message,
        messageKey: 'session.driver.acceptedTaskDiagnostic',
        code: 'accepted_task_diagnostic',
        runId: input.runId,
        planId: input.planId,
        title: 'Accepted task diagnostic',
        errorMessage: input.message,
      }),
      this.ports.sessionRunStateEvent({
        sessionId: input.sessionId,
        runId: input.runId,
        phase: 'failed',
        status: 'failed',
        reason: 'task_diagnostic',
        decisionOwner: {
          kind: 'plan',
          runId: input.runId,
          targetId: input.taskId,
          planId: input.planId,
        },
        ts: input.ts,
        id: input.id,
      }),
    ];
  }

  actionBundleAdmissionFailureEvents(
    sessionId: string,
    runId: string,
    proposal: ProposalEnvelope,
    reasons: string[],
    ts: string,
    id: string
  ): AgentEvent[] {
    const summary = `ActionBundle did not enter the Plan confirmation card; Session has stopped plan generation: ${reasons.join('; ')}`;
    return [
      {
        id,
        sessionId,
        ts,
        kind: 'error',
        payload: {
          message: summary,
          messageKey: 'session.driver.actionBundleAdmissionFailed',
          messageArgs: { reasonCount: reasons.length },
          code: 'action_bundle_admission_failed',
          runId,
          proposalId: proposal.proposalId,
          reasons,
          channel: 'error',
          visibility: 'conversation',
          activity: conversationActivity({
            activityId: id,
            kind: 'diagnostic',
            status: 'failed',
            title: 'ActionBundle admission failed',
            summary,
            source: 'session',
            runId,
            errorCode: 'action_bundle_admission_failed',
            errorMessage: summary,
          }),
        },
      },
      this.failedRunState(sessionId, runId, proposal.proposalId, proposal.proposalId, 'plan_review', ts, `${id}-state`),
    ];
  }

  planActionBundlePreflightFailureEvents(
    sessionId: string,
    plan: SessionFailurePlanContext,
    reasons: string[],
    ts: string,
    id: string
  ): AgentEvent[] {
    const summary = `Accepted plan actionBatch pre-submission audit failed; Session did not submit to Kernel: ${reasons.join('; ')}`;
    return [
      this.errorEvent({
        id,
        sessionId,
        ts,
        message: summary,
        messageKey: 'session.driver.acceptedPlanActionBatchPreflightFailed',
        code: 'accepted_plan_action_batch_preflight_failed',
        runId: plan.runId,
        planId: plan.planId,
        reasons,
        title: 'Accepted plan action batch preflight failed',
      }),
      this.failedRunState(sessionId, plan.runId, plan.planId, plan.planId, 'work_unit_failed', ts, `${id}-state`, plan.interactionOverlay),
    ];
  }

  planActionBundleExecutionExceptionEvents(
    sessionId: string,
    plan: SessionFailurePlanContext,
    message: string,
    code: string,
    ts: string,
    id: string
  ): AgentEvent[] {
    const summary = `Accepted plan execution failed; Session has stopped auto-advancing: ${message}`;
    return [
      this.errorEvent({
        id,
        sessionId,
        ts,
        message: summary,
        messageKey: 'session.driver.acceptedPlanExecutionFailed',
        code,
        runId: plan.runId,
        planId: plan.planId,
        title: 'Accepted plan execution failed',
        errorMessage: message,
      }),
      this.failedRunState(sessionId, plan.runId, plan.planId, plan.planId, 'work_unit_failed', ts, `${id}-state`, plan.interactionOverlay),
    ];
  }

  planActionBundleExecutionFailureEvents(
    sessionId: string,
    plan: SessionFailurePlanContext,
    kernelEvents: unknown[],
    batch: Record<string, unknown>,
    ts: string,
    id: string
  ): AgentEvent[] {
    const failures = this.ports.actionBatchFailureDetails(kernelEvents, batch);
    return [
      this.batchFailureEvent(sessionId, plan.runId, plan.planId, failures, ts, id),
      this.failedRunState(sessionId, plan.runId, plan.planId, plan.planId, 'work_unit_failed', ts, `${id}-state`, plan.interactionOverlay),
    ];
  }

  acceptedPlanNormalizationFailureEvents(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    reasons: string[],
    ts: string,
    id: string
  ): AgentEvent[] {
    const summary = `Accepted plan actionBatch pre-submission canonicalization failed; Session did not submit to Kernel: ${reasons.join('; ')}`;
    return [
      this.errorEvent({
        id,
        sessionId,
        ts,
        message: summary,
        messageKey: 'session.driver.acceptedPlanBatchNormalizationFailed',
        code: 'accepted_plan_batch_normalization_failed',
        runId,
        planId: accepted.planId,
        reasons,
        title: 'Accepted plan batch normalization failed',
      }),
      this.failedRunState(sessionId, runId, accepted.planId, accepted.planId, 'work_unit_failed', ts, `${id}-state`),
    ];
  }

  acceptedPlanExecutionFailureEvents(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    kernelEvents: unknown[],
    batch: Record<string, unknown> | undefined,
    ts: string,
    id: string
  ): AgentEvent[] {
    const failures = this.ports.actionBatchFailureDetails(kernelEvents, batch);
    return [
      this.batchFailureEvent(sessionId, runId, accepted.planId, failures, ts, id, accepted.batchIndex),
      this.failedRunState(sessionId, runId, accepted.planId, accepted.planId, 'work_unit_failed', ts, `${id}-state`),
    ];
  }

  private errorEvent(input: {
    id: string;
    sessionId: string;
    ts: string;
    message: string;
    messageKey: string;
    code: string;
    runId: string;
    planId?: string;
    reasons?: string[];
    title: string;
    errorMessage?: string;
  }): AgentEvent {
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'error',
      payload: {
        message: input.message,
        messageKey: input.messageKey,
        messageArgs: { reasonCount: input.reasons?.length ?? 0 },
        code: input.code,
        diagnosticRef: input.id,
        runId: input.runId,
        planId: input.planId,
        reasons: input.reasons,
        channel: 'error',
        visibility: 'conversation',
        activity: conversationActivity({
          activityId: input.id,
          kind: 'diagnostic',
          status: 'failed',
          title: input.title,
          summary: input.message,
          source: 'session',
          runId: input.runId,
          planId: input.planId,
          errorCode: input.code,
          errorMessage: input.errorMessage ?? input.message,
        }),
      },
    };
  }

  private batchFailureEvent(
    sessionId: string,
    runId: string,
    planId: string,
    failures: ActionBatchFailureDetail[],
    ts: string,
    id: string,
    batchIndex?: number
  ): AgentEvent {
    const summary = failures.length
      ? `Accepted plan execution batch failed; Session has stopped auto-advancing: ${failures.map((failure) => this.ports.actionBatchFailureSummary(failure)).join('; ')}`
      : 'Accepted plan execution batch failed or blocked; Session has stopped auto-advancing.';
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_failed',
        status: 'failed',
        summary,
        summaryKey: 'session.driver.acceptedPlanBatchFailed',
        messageKey: 'session.driver.acceptedPlanBatchFailed',
        messageArgs: { failureCount: failures.length },
        runId,
        planId,
        batchIndex,
        failures,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan batch failed',
          summary,
          source: 'session',
          runId,
          planId,
          targets: failures.flatMap((failure) => failure.writeSet),
          actionIds: failures.flatMap((failure) => failure.actionId ? [failure.actionId] : []),
          workUnitIds: failures.flatMap((failure) => failure.workUnitId ? [failure.workUnitId] : []),
          errorCode: failures.find((failure) => failure.code)?.code,
          errorMessage: failures.find((failure) => failure.message)?.message,
        }),
      },
    };
  }

  private failedRunState(
    sessionId: string,
    runId: string,
    targetId: string,
    planId: string,
    reason: SessionRunStateReason,
    ts: string,
    id: string,
    interactionOverlay?: InteractionOverlayContext
  ): AgentEvent {
    return this.ports.sessionRunStateEvent({
      sessionId,
      runId,
      phase: 'failed',
      status: 'failed',
      reason,
      decisionOwner: {
        kind: 'plan',
        runId,
        targetId,
        planId,
      },
      interactionOverlay,
      ts,
      id,
    });
  }
}

function conversationActivity(input: AgentConversationActivity): AgentConversationActivity {
  return { ...input };
}
