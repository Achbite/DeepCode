import type { AgentConversationActivity, AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { ContextAssemblyTaskLocalCompactRecord } from '../../context/index.js';
import type { ResourcePacket } from '../../context/types.js';
import type {
  AcceptedTaskPlanContext,
  AcceptedPlanBatchProgress,
  AcceptedPlanReadOnlyResourceCompletion,
  CurrentTaskContext,
  TaskExecutionCursor,
} from '../execution/index.js';
import type { InteractionOverlayContext, SessionTurnPhase } from '../pipelines/index.js';
import { buildTaskLedgerSnapshot, type AcceptedPlanPromptFrame, type TaskLedgerSnapshot } from '../../run-state/index.js';
import { providerTelemetryFromUsage } from '../../cache/telemetry.js';
import {
  localizedProjectionText,
  type ConversationPresentationLanguage,
} from './conversationPresentationLanguage.js';

export interface DecisionOwnerRef {
  kind: 'requirement' | 'plan' | 'review' | 'permission' | 'session';
  runId: string;
  targetId?: string;
  planId?: string;
  requirementId?: string;
  reviewId?: string;
  permissionId?: string;
}

export type SessionRunStateStatus = 'waiting' | 'running' | 'completed' | 'cancelled' | 'failed';

export type SessionRunStateReason =
  | 'session'
  | 'requirement'
  | 'plan_review'
  | 'permission'
  | 'review'
  | 'accepted_plan_execution'
  | 'task_diagnostic'
  | 'work_unit_failed'
  | 'driver_failure'
  | 'provider_failure';

export interface SessionProgressProjectionBuilderPorts {
  interactionOverlayPayload(overlay: InteractionOverlayContext | undefined): Record<string, unknown>;
  hasFailureOrBlocker(kernelEvents: unknown[]): boolean;
  auditAcceptedPlanBatch(batch: unknown): Record<string, unknown>;
  actionBundleAdmissionBatch(proposal: ProposalEnvelope): Record<string, unknown>;
  acceptedPlanTaskLedger(accepted: AcceptedTaskPlanContext): TaskLedgerSnapshot | undefined;
  acceptedPlanPromptFrame(
    accepted: AcceptedTaskPlanContext,
    taskLedger: TaskLedgerSnapshot | undefined
  ): AcceptedPlanPromptFrame | undefined;
}

export class SessionProgressProjectionBuilder {
  constructor(private readonly ports: SessionProgressProjectionBuilderPorts) {}

  traceEvent(input: {
    sessionId: string;
    kind: AgentEvent['kind'];
    summary: string;
    extra: Record<string, unknown>;
    language?: ConversationPresentationLanguage;
    ts: string;
    id: string;
  }): AgentEvent {
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: input.kind,
      payload: {
        title: localizedProjectionText(input.language ?? 'neutral', {
          zh: 'Session 决策',
          en: 'Session decision',
          neutral: 'Session',
        }),
        summary: input.summary,
        presentationLanguage: input.language ?? 'neutral',
        status: 'noop',
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        ...input.extra,
      },
    };
  }

  cacheTelemetryEvent(input: {
    sessionId: string;
    profileId?: string;
    provider?: string;
    model?: string;
    stage: string;
    usage?: Record<string, unknown>;
    promptSegmentDigests: Array<Record<string, unknown>>;
    stablePrefixHash?: string;
    dynamicSuffixHash?: string;
    finalUserPromptHash?: string;
    finalUserPromptCharLength?: number;
    cacheHash?: string;
    promptLedgerEpochScopeKey?: string;
    promptLedgerTaskTemplateHash?: string;
    ts: string;
    id: string;
  }): AgentEvent | null {
    const normalized = providerTelemetryFromUsage({
      provider: input.provider ?? 'unknown',
      usage: input.usage,
    });
    if (
      normalized.promptCacheHitTokens === undefined &&
      normalized.promptCacheMissTokens === undefined &&
      normalized.cachedTokens === undefined &&
      normalized.promptTokens === undefined &&
      normalized.completionTokens === undefined &&
      normalized.totalTokens === undefined &&
      input.promptSegmentDigests.length === 0
    ) {
      return null;
    }

    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'cache_telemetry',
      payload: {
        provider: input.provider ?? 'unknown',
        providerProfileId: input.profileId,
        model: input.model,
        stage: input.stage,
        promptCacheHitTokens: normalized.promptCacheHitTokens,
        promptCacheMissTokens: normalized.promptCacheMissTokens,
        cachedTokens: normalized.cachedTokens,
        promptTokens: normalized.promptTokens,
        completionTokens: normalized.completionTokens,
        totalTokens: normalized.totalTokens,
        normalizedUsage: normalized,
        rawUsage: input.usage,
        promptSegmentDigests: input.promptSegmentDigests,
        stablePrefixHash: input.stablePrefixHash,
        dynamicSuffixHash: input.dynamicSuffixHash,
        finalUserPromptHash: input.finalUserPromptHash,
        finalUserPromptCharLength: input.finalUserPromptCharLength,
        cacheHash: input.cacheHash,
        promptLedgerEpochScopeKey: input.promptLedgerEpochScopeKey,
        promptLedgerTaskTemplateHash: input.promptLedgerTaskTemplateHash,
        cacheAffectsCorrectness: false,
      },
    };
  }

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
    accepted: AcceptedTaskPlanContext,
    newlySettledTaskIds: string[],
    remainingTaskIds: string[],
    effectKind: string,
    selectedOptionId: string | undefined,
    ts: string,
    id: string,
    language: ConversationPresentationLanguage = 'neutral'
  ): AgentEvent {
    const complete = remainingTaskIds.length === 0;
    const ledger = buildTaskLedgerSnapshot({
      planId: accepted.planId,
      runId,
      tasks: this.taskRecords(accepted),
      completedTaskIds: accepted.completedTaskIds,
      modelJudgedSufficientTaskIds: accepted.modelJudgedSufficientTaskIds ?? [],
      skippedTaskIds: accepted.skippedTaskIds ?? [],
      acceptedIncompleteTaskIds: accepted.acceptedIncompleteTaskIds ?? [],
    });
    const summary = complete
      ? localizedProjectionText(language, {
        zh: '用户需求决策后，已确认计划的任务清单已结算，准备进入最终 Review；该状态不等同于 Kernel 执行完成事实。',
        en: 'The accepted-plan task ledger is settled after the user requirement decision and is ready for final Review; this status is not a Kernel execution-completion fact.',
        neutral: 'AcceptedPlan task ledger settled after user decision',
      })
      : localizedProjectionText(language, {
        zh: '用户需求决策已推进已确认计划的任务游标。',
        en: 'User requirement decision advanced the accepted plan task cursor.',
        neutral: 'AcceptedPlan cursor →',
      });
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_checkpoint',
        status: 'completed',
        summary,
        presentationLanguage: language,
        runId,
        planId: accepted.planId,
        source: 'requirementDecision',
        effectKind,
        selectedOptionId,
        batchIndex: accepted.batchIndex,
        newlyCompletedTaskIds: [],
        newlySettledTaskIds,
        completedTaskIds: ledger.completedTaskIds,
        skippedTaskIds: ledger.skippedTaskIds,
        acceptedIncompleteTaskIds: ledger.acceptedIncompleteTaskIds,
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
          title: complete
            ? localizedProjectionText(language, {
              zh: '已确认计划已结算',
              en: 'Accepted plan settled',
              neutral: 'AcceptedPlan settled',
            })
            : localizedProjectionText(language, {
              zh: '用户决策已推进任务',
              en: 'Task advanced by user decision',
              neutral: 'Task →',
            }),
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
    accepted: AcceptedTaskPlanContext,
    proposal: ProposalEnvelope,
    kernelEvents: unknown[],
    progress: AcceptedPlanBatchProgress,
    ts: string,
    id: string,
    contextCompactRecord?: ContextAssemblyTaskLocalCompactRecord,
    language: ConversationPresentationLanguage = 'neutral'
  ): AgentEvent {
    const failedOrBlocked = this.ports.hasFailureOrBlocker(kernelEvents);
    const complete = !failedOrBlocked && progress.remainingTaskIds.length === 0;
    const evidenceAssessedTaskIds = progress.modelJudgedSufficientTaskIds
      ?? accepted.modelJudgedSufficientTaskIds
      ?? [];
    const kernelCompletedTaskCount = progress.completedTaskIds.length;
    const evidenceAssessedTaskCount = evidenceAssessedTaskIds.length;
    const ledger = buildTaskLedgerSnapshot({
      planId: accepted.planId,
      runId,
      tasks: this.taskRecords(accepted),
      completedTaskIds: progress.completedTaskIds,
      modelJudgedSufficientTaskIds: evidenceAssessedTaskIds,
      failedTaskId: failedOrBlocked
        ? accepted.tasks.find((task) => (
          !progress.completedTaskIds.includes(task.taskId)
          && !evidenceAssessedTaskIds.includes(task.taskId)
        ))?.taskId
        : undefined,
    });
    const summary = failedOrBlocked
      ? localizedProjectionText(language, {
        zh: '已确认计划的当前执行批次存在失败或阻塞，已暂停自动推进。',
        en: 'The current accepted-plan batch failed or was blocked; automatic progress is paused.',
        neutral: 'AcceptedPlan batch !',
      })
      : complete
        ? localizedProjectionText(language, {
          zh: `已确认计划的任务已全部结算：${kernelCompletedTaskCount} 个由 Kernel facts 确认完成，${evidenceAssessedTaskCount} 个由 Session 根据任务证据评估为无需额外 workspace mutation；准备进入最终 Review。`,
          en: `All accepted-plan tasks are settled: ${kernelCompletedTaskCount} completed by Kernel facts and ${evidenceAssessedTaskCount} assessed by Session evidence as requiring no additional workspace mutation; preparing the final Review.`,
          neutral: `AcceptedPlan settled kernelCompleted=${kernelCompletedTaskCount} evidenceAssessedNoMutation=${evidenceAssessedTaskCount}`,
        })
        : localizedProjectionText(language, {
          zh: '已确认计划的当前执行批次已完成，Session 将继续生成下一批。',
          en: 'The current accepted-plan batch is complete; Session will prepare the next batch.',
          neutral: 'AcceptedPlan batch ✓',
        });
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_checkpoint',
        status: failedOrBlocked ? 'blocked' : 'completed',
        summary,
        presentationLanguage: language,
        runId,
        planId: accepted.planId,
        proposalId: proposal.proposalId,
        batchIndex: accepted.batchIndex,
        actionIds: progress.actionIds,
        targetPaths: progress.targetPaths,
        workUnitIds: progress.workUnitIds,
        newlyCompletedTaskIds: progress.newlyCompletedTaskIds,
        completedTaskIds: progress.completedTaskIds,
        dependencyFacts: accepted.dependencyFacts,
        newlyModelJudgedSufficientTaskIds: progress.newlyModelJudgedSufficientTaskIds ?? [],
        modelJudgedSufficientTaskIds: evidenceAssessedTaskIds,
        remainingTaskIds: progress.remainingTaskIds,
        taskLedger: ledger,
        taskOrder: ledger.taskOrder,
        nextPendingTaskIds: ledger.pendingTaskIds,
        contextCompactRecord,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: complete ? 'reviewCheckpoint' : failedOrBlocked ? 'diagnostic' : 'editBatchQueued',
          status: failedOrBlocked ? 'blocked' : 'completed',
          title: complete
            ? localizedProjectionText(language, {
              zh: '已确认计划已结算',
              en: 'Accepted plan settled',
              neutral: 'AcceptedPlan settled',
            })
            : failedOrBlocked
              ? localizedProjectionText(language, {
                zh: '已确认计划批次已阻塞',
                en: 'Accepted plan batch blocked',
                neutral: 'AcceptedPlan !',
              })
              : localizedProjectionText(language, {
                zh: '已确认计划批次已完成',
                en: 'Accepted plan batch completed',
                neutral: 'AcceptedPlan batch ✓',
              }),
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
    accepted: AcceptedTaskPlanContext,
    packet: ResourcePacket,
    completion: AcceptedPlanReadOnlyResourceCompletion,
    ts: string,
    id: string,
    contextCompactRecord?: ContextAssemblyTaskLocalCompactRecord,
    language: ConversationPresentationLanguage = 'neutral'
  ): AgentEvent {
    const complete = completion.remainingTaskIds.length === 0;
    const ledger = buildTaskLedgerSnapshot({
      planId: accepted.planId,
      runId,
      tasks: this.taskRecords(accepted),
      completedTaskIds: completion.completedTaskIds,
      modelJudgedSufficientTaskIds: accepted.modelJudgedSufficientTaskIds ?? [],
    });
    const summary = complete
      ? localizedProjectionText(language, {
        zh: '只读证据已满足剩余的已确认任务，准备进入最终 Review。',
        en: 'Read-only evidence satisfied the remaining accepted task; ready for final review.',
        neutral: 'ReadOnly evidence ✓',
      })
      : localizedProjectionText(language, {
        zh: '只读证据已满足当前已确认任务，Session 将继续下一项任务。',
        en: 'Read-only evidence satisfied the current accepted task; Session will continue with the next task.',
        neutral: 'ReadOnly task ✓',
      });
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_checkpoint',
        status: 'completed',
        summary,
        presentationLanguage: language,
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
        contextCompactRecord,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
          status: 'completed',
          title: complete
            ? localizedProjectionText(language, {
              zh: '已确认计划验证完成',
              en: 'Accepted plan validation complete',
              neutral: 'Validation ✓',
            })
            : localizedProjectionText(language, {
              zh: '已确认计划的只读验证已完成',
              en: 'Accepted plan read-only validation completed',
              neutral: 'ReadOnly validation ✓',
            }),
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
    batch: unknown,
    ts: string,
    id: string,
    language: ConversationPresentationLanguage = 'neutral'
  ): AgentEvent {
    const audit = this.ports.auditAcceptedPlanBatch(batch);
    const actionCount = Array.isArray(audit.actions) ? audit.actions.length : 0;
    const summary = localizedProjectionText(language, {
      zh: `Session 已完成已确认计划 actionBatch 的预检审计，共 ${actionCount} 个操作。`,
      en: `Session completed accepted-plan actionBatch preflight audit for ${actionCount} action(s).`,
      neutral: `ActionBatch preflight actions=${actionCount}`,
    });
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.action_batch_preflight',
        status: 'completed',
        summary,
        presentationLanguage: language,
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
          title: localizedProjectionText(language, {
            zh: '已确认计划操作批次预检',
            en: 'Accepted plan action batch preflight',
            neutral: 'ActionBatch preflight',
          }),
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
    id: string,
    language: ConversationPresentationLanguage = 'neutral'
  ): AgentEvent {
    const batch = this.ports.actionBundleAdmissionBatch(proposal);
    const audit = this.ports.auditAcceptedPlanBatch(batch);
    const summary = localizedProjectionText(language, {
      zh: `ActionBundle 在进入 Plan 卡片前需要修订：${reasons.join('; ')}`,
      en: `ActionBundle requires revision before entering the Plan card: ${reasons.join('; ')}`,
      neutral: `ActionBundle revision required: ${reasons.join('; ')}`,
    });
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'action_bundle_admission.repairing',
        status: 'running',
        summary,
        presentationLanguage: language,
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
          title: localizedProjectionText(language, {
            zh: 'ActionBundle 入场修复',
            en: 'ActionBundle admission repair',
            neutral: 'ActionBundle repair',
          }),
          summary,
          source: 'session',
          runId,
          targets: actionTargetsFromAudit(audit),
        }),
      },
    };
  }

  acceptedPlanResourceResumeEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    cursor: TaskExecutionCursor | undefined,
    context: CurrentTaskContext | undefined,
    packet: ResourcePacket,
    ts: string,
    id: string,
    language: ConversationPresentationLanguage = 'neutral'
  ): AgentEvent {
    const summary = localizedProjectionText(language, {
      zh: 'Session 已解析当前已确认任务的只读资源证据，将从同一任务游标继续。',
      en: 'Session resolved read-only resource evidence for the current accepted task and will resume from the same task cursor.',
      neutral: 'ResourceEvidence ✓; TaskCursor resume',
    });
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.resource_resume',
        status: 'completed',
        summary,
        presentationLanguage: language,
        summaryKey: 'session.driver.acceptedPlanResourceResume',
        messageKey: 'session.driver.acceptedPlanResourceResume',
        messageArgs: { resourceItemCount: packet.items.length },
        runId,
        planId: accepted.planId,
        taskCursorId: cursor?.cursorId,
        currentTaskId: context?.taskId,
        targetPaths: context?.targets ?? [],
        resourcePacketId: packet.id,
        resourceItemCount: packet.items.length,
        lastResourcePacketIds: cursor?.lastResourcePacketIds ?? [],
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: 'resourceRead',
          status: 'completed',
          title: localizedProjectionText(language, {
            zh: '已确认计划资源继续',
            en: 'Accepted plan resource resume',
            neutral: 'Resource resume',
          }),
          summary,
          source: 'session',
          runId,
          targets: context?.targets,
        }),
      },
    };
  }

  acceptedPlanTaskSavepointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    nextAccepted: AcceptedTaskPlanContext,
    progress: AcceptedPlanBatchProgress,
    kernelEvents: unknown[],
    cursor: TaskExecutionCursor | undefined,
    context: CurrentTaskContext | undefined,
    ts: string,
    id: string,
    contextCompactRecord?: ContextAssemblyTaskLocalCompactRecord,
    language: ConversationPresentationLanguage = 'neutral'
  ): AgentEvent {
    const complete = progress.remainingTaskIds.length === 0 && !this.ports.hasFailureOrBlocker(kernelEvents);
    const ledger = this.ports.acceptedPlanTaskLedger(nextAccepted);
    const promptFrame = this.ports.acceptedPlanPromptFrame(nextAccepted, ledger);
    const kernelCompletedTaskCount = progress.completedTaskIds.length;
    const evidenceAssessedTaskIds = progress.modelJudgedSufficientTaskIds
      ?? nextAccepted.modelJudgedSufficientTaskIds
      ?? [];
    const evidenceAssessedTaskCount = evidenceAssessedTaskIds.length;
    const summary = complete
      ? localizedProjectionText(language, {
        zh: `已确认 taskPlan 的任务已全部结算：${kernelCompletedTaskCount} 个由 Kernel facts 确认完成，${evidenceAssessedTaskCount} 个由 Session 根据任务证据评估为无需额外 workspace mutation。`,
        en: `All accepted taskPlan tasks are settled: ${kernelCompletedTaskCount} completed by Kernel facts and ${evidenceAssessedTaskCount} assessed by Session evidence as requiring no additional workspace mutation.`,
        neutral: `taskPlan settled kernelCompleted=${kernelCompletedTaskCount} evidenceAssessedNoMutation=${evidenceAssessedTaskCount}`,
      })
      : localizedProjectionText(language, {
        zh: '已保存已确认 taskPlan 的进度；下一批将按任务清单顺序继续。',
        en: 'Accepted taskPlan progress was saved; the next batch will continue in task-list order.',
        neutral: 'taskPlan savepoint ✓',
      });
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.task_savepoint',
        status: complete ? 'completed' : 'running',
        summary,
        memorySummary: [
          'accepted_plan.task_savepoint',
          `status=${complete ? 'completed' : 'running'}`,
          `kernelCompleted=${kernelCompletedTaskCount}`,
          `evidenceAssessedNoMutation=${evidenceAssessedTaskCount}`,
          `remaining=${progress.remainingTaskIds.length}`,
        ].join(' '),
        presentationLanguage: language,
        ...(!complete ? {
          summaryKey: 'session.driver.acceptedPlanTaskSavepointRunning',
          messageKey: 'session.driver.acceptedPlanTaskSavepointRunning',
        } : {}),
        messageArgs: {
          newlyCompletedTaskCount: progress.newlyCompletedTaskIds.length,
          kernelCompletedTaskCount,
          evidenceAssessedTaskCount,
        },
        runId,
        planId: accepted.planId,
        taskCursorId: cursor?.cursorId,
        taskId: context?.taskId,
        completedTaskIds: progress.completedTaskIds,
        newlyCompletedTaskIds: progress.newlyCompletedTaskIds,
        modelJudgedSufficientTaskIds: evidenceAssessedTaskIds,
        dependencyFacts: nextAccepted.dependencyFacts,
        newlyModelJudgedSufficientTaskIds: progress.newlyModelJudgedSufficientTaskIds ?? [],
        remainingTaskIds: progress.remainingTaskIds,
        taskLedger: ledger,
        taskOrder: ledger?.taskOrder ?? [],
        nextPendingTaskIds: ledger?.pendingTaskIds ?? [],
        acceptedPlanPromptFrame: promptFrame,
        targetPaths: progress.targetPaths,
        workUnitIds: progress.workUnitIds,
        kernelEventCount: kernelEvents.length,
        contextCompactRecord,
        memoryUpdateSummary: localizedProjectionText(language, {
          zh: 'SessionMemory 将分别保留 Kernel 完成记录、证据评估无需 mutation 的记录、当前任务焦点和下一检查点。',
          en: 'SessionMemory will retain Kernel-completion records, evidence-assessed no-mutation records, the active task focus, and the next checkpoint separately.',
          neutral: 'SessionMemory checkpoint updated with separate settlement sources',
        }),
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
          status: complete ? 'completed' : 'running',
          title: complete
            ? localizedProjectionText(language, {
              zh: '任务计划保存点已结算',
              en: 'Task plan savepoint settled',
              neutral: 'Savepoint settled',
            })
            : localizedProjectionText(language, {
              zh: '任务计划保存点',
              en: 'Task plan savepoint',
              neutral: 'Savepoint',
            }),
          summary: complete
            ? localizedProjectionText(language, {
              zh: `任务已结算：Kernel facts 完成 ${kernelCompletedTaskCount} 个；证据评估无需 mutation ${evidenceAssessedTaskCount} 个。`,
              en: `Tasks settled: ${kernelCompletedTaskCount} completed by Kernel facts; ${evidenceAssessedTaskCount} evidence-assessed as needing no mutation.`,
              neutral: `AcceptedTasks settled kernelCompleted=${kernelCompletedTaskCount} evidenceAssessedNoMutation=${evidenceAssessedTaskCount}`,
            })
            : localizedProjectionText(language, {
              zh: '已保存已确认任务进度，供下一 Provider 检查点继续。',
              en: 'Accepted task progress saved for the next provider checkpoint.',
              neutral: 'Provider checkpoint saved',
            }),
          source: 'session',
          runId,
          targets: progress.targetPaths,
          itemCount: progress.newlyCompletedTaskIds.length
            + (progress.newlyModelJudgedSufficientTaskIds?.length ?? 0),
        }),
      },
    };
  }

  acceptedPlanTaskOutcomeCheckpointEvent(input: {
    sessionId: string;
    runId: string;
    accepted: AcceptedTaskPlanContext;
    nextAccepted: AcceptedTaskPlanContext;
    taskId: string;
    evidenceRefs: string[];
    acceptanceResults: Array<{
      criterionIndex: number;
      status: 'satisfied';
      evidenceRefs: string[];
    }>;
    evidenceRevision: number;
    progress: AcceptedPlanBatchProgress;
    contextCompactRecord?: ContextAssemblyTaskLocalCompactRecord;
    language: ConversationPresentationLanguage;
    ts: string;
    id: string;
  }): AgentEvent {
    const taskLedger = this.ports.acceptedPlanTaskLedger(input.nextAccepted);
    const summary = localizedProjectionText(input.language, {
      zh: `Session 已根据当前任务范围内最新、完整且未截断的资源证据，将任务 ${input.taskId} 评估为无需额外 workspace mutation；这不是 Kernel 执行完成事实。`,
      en: `Session assessed task ${input.taskId} from fresh, complete, non-truncated task-scoped resource evidence as requiring no additional workspace mutation; this is not a Kernel execution-completion fact.`,
      neutral: `task=${input.taskId} evidenceAssessment=noAdditionalMutation kernelExecutionCompleted=false`,
    });
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_checkpoint',
        source: 'modelTaskOutcome',
        assessmentOwner: 'session',
        settlementKind: 'evidenceAssessedNoMutation',
        kernelExecutionCompleted: false,
        status: input.progress.remainingTaskIds.length ? 'running' : 'completed',
        summary,
        memorySummary: [
          'accepted_plan.batch_checkpoint',
          `taskId=${input.taskId}`,
          'settlement=evidenceAssessedNoMutation',
          'kernelExecutionCompleted=false',
          `evidenceRefs=${input.evidenceRefs.length}`,
        ].join(' '),
        presentationLanguage: input.language,
        runId: input.runId,
        planId: input.accepted.planId,
        taskId: input.taskId,
        outcome: 'alreadySatisfied',
        modelJudgedSufficient: true,
        evidenceRefs: input.evidenceRefs,
        evidenceRevision: input.evidenceRevision,
        acceptanceResults: input.acceptanceResults,
        newlyCompletedTaskIds: [],
        completedTaskIds: input.progress.completedTaskIds,
        modelJudgedSufficientTaskIds: input.progress.modelJudgedSufficientTaskIds ?? [],
        newlyModelJudgedSufficientTaskIds: input.progress.newlyModelJudgedSufficientTaskIds ?? [],
        remainingTaskIds: input.progress.remainingTaskIds,
        taskLedger,
        taskOrder: taskLedger?.taskOrder ?? [],
        nextPendingTaskIds: taskLedger?.pendingTaskIds ?? [],
        contextCompactRecord: input.contextCompactRecord,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: input.id,
          kind: input.progress.remainingTaskIds.length ? 'editBatchQueued' : 'reviewCheckpoint',
          status: 'completed',
          title: localizedProjectionText(input.language, {
            zh: '任务证据评估结果',
            en: 'Task evidence assessment',
            neutral: 'Task evidence assessment',
          }),
          summary,
          source: 'session',
          runId: input.runId,
          planId: input.accepted.planId,
          targets: input.accepted.tasks.find((task) => task.taskId === input.taskId)?.targets,
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

  private taskRecords(accepted: AcceptedTaskPlanContext): Array<{
    taskId: string;
    title: string;
    targets: string[];
    capability?: string;
  }> {
    return accepted.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title ?? task.taskId,
      targets: task.targets,
      toolId: task.toolId,
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
    return stringValue(record.targetPath) ?? [];
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
