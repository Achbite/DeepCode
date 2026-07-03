import type { AgentConversationActivity, AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type { ResourcePacket } from '../../context/types.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedPlanBatchProgress,
  AcceptedPlanReadOnlyResourceCompletion,
} from '../execution/index.js';
import type { InteractionOverlayContext, SessionTurnPhase } from '../pipelines/index.js';
import { buildTaskLedgerSnapshot } from '../../run-state/index.js';

export interface DecisionOwnerRef {
  kind: 'requirement' | 'plan' | 'review' | 'permission';
  runId: string;
  targetId?: string;
  planId?: string;
  requirementId?: string;
  reviewId?: string;
  permissionId?: string;
}

export type SessionRunStateStatus = 'waiting' | 'running' | 'completed' | 'cancelled' | 'failed';

export type SessionRunStateReason =
  | 'requirement'
  | 'plan_review'
  | 'permission'
  | 'review'
  | 'accepted_plan_execution'
  | 'work_unit_failed';

export interface SessionProgressProjectionBuilderPorts {
  interactionOverlayPayload(overlay: InteractionOverlayContext | undefined): Record<string, unknown>;
  hasFailureOrBlocker(kernelEvents: unknown[]): boolean;
  auditAcceptedPlanBatch(batch: Record<string, unknown>): Record<string, unknown>;
  actionBundleAdmissionBatch(proposal: ProposalEnvelope): Record<string, unknown>;
}

export class SessionProgressProjectionBuilder {
  constructor(private readonly ports: SessionProgressProjectionBuilderPorts) {}

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
  }): AgentEvent {
    const status = input.status ?? 'waiting';
    const overlayPayload = this.ports.interactionOverlayPayload(input.interactionOverlay);
    const summary = this.sessionRunStateSummary(input.reason, status);
    const messageArgs = { reason: input.reason, status };
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'session_run_state',
      payload: {
        status,
        phase: input.phase,
        reason: input.reason,
        runId: input.runId,
        decisionKind: input.decisionOwner.kind,
        targetId: input.decisionOwner.targetId,
        decisionOwner: input.decisionOwner,
        ...overlayPayload,
        summary: summary.key,
        summaryKey: summary.key,
        messageKey: summary.key,
        messageArgs,
        channel: 'task',
        visibility: 'debug',
        presentation: 'stageSummary',
      },
    };
  }

  requirementDrivenTaskCheckpointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    newlyCompletedTaskIds: string[],
    completedTaskIds: string[],
    remainingTaskIds: string[],
    effectKind: string,
    selectedOptionId: string | undefined,
    ts: string,
    id: string
  ): AgentEvent {
    const complete = remainingTaskIds.length === 0;
    const ledger = buildTaskLedgerSnapshot({
      planId: accepted.planId,
      runId,
      tasks: this.taskRecords(accepted),
      completedTaskIds,
      skippedTaskIds: effectKind === 'skipCurrentTask' ? newlyCompletedTaskIds : [],
      acceptedIncompleteTaskIds: effectKind === 'markAcceptedIncomplete' ? newlyCompletedTaskIds : [],
    });
    const summary = complete
      ? 'Accepted plan tasks resolved via user requirement decision; ready for final review.'
      : 'User requirement decision advanced the accepted plan task cursor.';
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_checkpoint',
        status: 'completed',
        summary,
        runId,
        planId: accepted.planId,
        source: 'requirementDecision',
        effectKind,
        selectedOptionId,
        batchIndex: accepted.batchIndex,
        newlyCompletedTaskIds,
        completedTaskIds,
        remainingTaskIds,
        taskLedger: ledger,
        taskOrder: ledger.taskOrder,
        nextPendingTaskIds: ledger.pendingTaskIds,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
          status: 'completed',
          title: complete ? 'Accepted plan complete' : 'Task advanced by user decision',
          summary,
          source: 'session',
          runId,
          planId: accepted.planId,
        }),
      },
    };
  }

  acceptedPlanBatchCheckpointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    proposal: ProposalEnvelope,
    kernelEvents: unknown[],
    progress: AcceptedPlanBatchProgress,
    ts: string,
    id: string
  ): AgentEvent {
    const failedOrBlocked = this.ports.hasFailureOrBlocker(kernelEvents);
    const complete = !failedOrBlocked && progress.remainingTaskIds.length === 0;
    const ledger = buildTaskLedgerSnapshot({
      planId: accepted.planId,
      runId,
      tasks: this.taskRecords(accepted),
      completedTaskIds: progress.completedTaskIds,
      failedTaskId: failedOrBlocked
        ? accepted.tasks.find((task) => !progress.completedTaskIds.includes(task.taskId))?.taskId
        : undefined,
    });
    const summary = failedOrBlocked
      ? '已确认计划的当前执行批次存在失败或阻塞，已暂停自动推进。'
      : complete
        ? '已确认计划的任务清单已执行完成，准备进入最终 Review。'
        : '已确认计划的当前执行批次已完成，Session 将继续生成下一批。';
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_checkpoint',
        status: failedOrBlocked ? 'blocked' : 'completed',
        summary,
        runId,
        planId: accepted.planId,
        proposalId: proposal.proposalId,
        batchIndex: accepted.batchIndex,
        actionIds: progress.actionIds,
        targetPaths: progress.targetPaths,
        workUnitIds: progress.workUnitIds,
        newlyCompletedTaskIds: progress.newlyCompletedTaskIds,
        completedTaskIds: progress.completedTaskIds,
        remainingTaskIds: progress.remainingTaskIds,
        taskLedger: ledger,
        taskOrder: ledger.taskOrder,
        nextPendingTaskIds: ledger.pendingTaskIds,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: complete ? 'reviewCheckpoint' : failedOrBlocked ? 'diagnostic' : 'editBatchQueued',
          status: failedOrBlocked ? 'blocked' : 'completed',
          title: complete ? 'Accepted plan complete' : failedOrBlocked ? 'Accepted plan batch blocked' : 'Accepted plan batch completed',
          summary,
          source: 'session',
          runId,
          planId: accepted.planId,
          targets: progress.targetPaths,
          actionIds: progress.actionIds,
          workUnitIds: progress.workUnitIds,
        }),
      },
    };
  }

  acceptedPlanResourceValidationCheckpointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    packet: ResourcePacket,
    completion: AcceptedPlanReadOnlyResourceCompletion,
    ts: string,
    id: string
  ): AgentEvent {
    const complete = completion.remainingTaskIds.length === 0;
    const ledger = buildTaskLedgerSnapshot({
      planId: accepted.planId,
      runId,
      tasks: this.taskRecords(accepted),
      completedTaskIds: completion.completedTaskIds,
    });
    const summary = complete
      ? 'Read-only evidence satisfied the remaining accepted task; ready for final review.'
      : 'Read-only evidence satisfied the current accepted task; Session will continue with the next task.';
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_checkpoint',
        status: 'completed',
        summary,
        runId,
        planId: accepted.planId,
        source: 'resourceValidation',
        batchIndex: accepted.batchIndex,
        resourcePacketId: packet.id,
        validatedTaskId: completion.taskId,
        coveredTargets: completion.coveredTargets,
        targetPaths: completion.coveredTargets,
        newlyCompletedTaskIds: completion.newlyCompletedTaskIds,
        completedTaskIds: completion.completedTaskIds,
        remainingTaskIds: completion.remainingTaskIds,
        taskLedger: ledger,
        taskOrder: ledger.taskOrder,
        nextPendingTaskIds: ledger.pendingTaskIds,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
          status: 'completed',
          title: complete ? 'Accepted plan validation complete' : 'Accepted plan read-only validation completed',
          summary,
          source: 'session',
          runId,
          planId: accepted.planId,
          targets: completion.coveredTargets,
        }),
      },
    };
  }

  acceptedPlanActionBatchPreflightEvent(
    sessionId: string,
    plan: { runId: string; planId: string },
    batch: Record<string, unknown>,
    ts: string,
    id: string
  ): AgentEvent {
    const audit = this.ports.auditAcceptedPlanBatch(batch);
    const actionCount = Array.isArray(audit.actions) ? audit.actions.length : 0;
    const summary = `Session completed accepted-plan actionBatch preflight audit for ${actionCount} action(s).`;
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.action_batch_preflight',
        status: 'completed',
        summary,
        summaryKey: 'session.driver.acceptedPlanActionBatchPreflight',
        messageKey: 'session.driver.acceptedPlanActionBatchPreflight',
        messageArgs: { actionCount },
        runId: plan.runId,
        planId: plan.planId,
        audit,
        channel: 'progress',
        visibility: 'debug',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'completed',
          title: 'Accepted plan action batch preflight',
          summary,
          source: 'session',
          runId: plan.runId,
          planId: plan.planId,
        }),
      },
    };
  }

  actionBundleAdmissionRepairingEvent(
    sessionId: string,
    runId: string,
    proposal: ProposalEnvelope,
    reasons: string[],
    ts: string,
    id: string
  ): AgentEvent {
    const batch = this.ports.actionBundleAdmissionBatch(proposal);
    const audit = this.ports.auditAcceptedPlanBatch(batch);
    const summary = `ActionBundle requires revision before entering the Plan card: ${reasons.join('; ')}`;
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'action_bundle_admission.repairing',
        status: 'running',
        summary,
        summaryKey: 'session.driver.actionBundleAdmissionRepairing',
        messageKey: 'session.driver.actionBundleAdmissionRepairing',
        messageArgs: { reasonCount: reasons.length },
        runId,
        proposalId: proposal.proposalId,
        reasons,
        audit,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'running',
          title: 'ActionBundle admission repair',
          summary,
          source: 'session',
          runId,
          targets: actionTargetsFromAudit(audit),
        }),
      },
    };
  }

  private sessionRunStateSummary(
    reason: SessionRunStateReason,
    status: SessionRunStateStatus
  ): { key: string } {
    if (status === 'cancelled') return { key: 'session.runState.cancelled' };
    if (status === 'failed' && reason === 'work_unit_failed') return { key: 'session.runState.workUnitFailed' };
    if (status === 'failed') return { key: 'session.runState.failed' };
    if (status === 'completed' && reason === 'review') return { key: 'session.runState.reviewCompleted' };
    if (status === 'completed') return { key: 'session.runState.completed' };
    if (reason === 'accepted_plan_execution') return { key: 'session.runState.acceptedPlanExecution' };
    if (status === 'running') return { key: 'session.runState.running' };
    if (reason === 'requirement') return { key: 'session.runState.requirement' };
    if (reason === 'permission') return { key: 'session.runState.permission' };
    if (reason === 'review') return { key: 'session.runState.review' };
    return { key: 'session.runState.planReview' };
  }

  private taskRecords(accepted: AcceptedImplementationPlanContext): Array<{
    taskId: string;
    title: string;
    targets: string[];
    capability?: string;
  }> {
    return accepted.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title ?? task.taskId,
      targets: task.targets,
      capability: task.capability,
    }));
  }
}

function conversationActivity(input: AgentConversationActivity): AgentConversationActivity {
  return { ...input };
}

function actionTargetsFromAudit(audit: Record<string, unknown>): string[] {
  if (!Array.isArray(audit.actions)) return [];
  return audit.actions.flatMap((item) => {
    const record = objectRecord(item);
    if (!record) return [];
    return stringArrayValue(record.resourceScope).concat(stringValue(record.targetPath) ?? []);
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}
