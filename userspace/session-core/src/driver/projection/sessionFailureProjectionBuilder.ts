import type {
  AgentConversationActivity,
  AgentEvent,
  ConversationLanguage,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { AcceptedTaskPlanContext, ActionBatchFailureDetail } from '../execution/index.js';
import type { InteractionOverlayContext, SessionTurnPhase } from '../pipelines/index.js';
import type { DecisionOwnerRef, SessionRunStateReason, SessionRunStateStatus } from './sessionProgressProjectionBuilder.js';
import {
  localizedProjectionText,
  type ConversationPresentationLanguage,
} from './conversationPresentationLanguage.js';

export interface SessionFailurePlanContext {
  runId: string;
  planId: string;
  interactionOverlay?: InteractionOverlayContext;
  responseLanguage?: ConversationLanguage;
}

export interface SessionFailureProjectionBuilderPorts {
  actionBatchFailureDetails(kernelEvents: unknown[], batch?: unknown): ActionBatchFailureDetail[];
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
    language?: 'zh-CN' | 'en-US';
    reason: 'driver_failure' | 'provider_failure';
    ts: string;
    id: string;
  }): AgentEvent[] {
    const diagnosticRef = `${input.id}-diagnostic`;
    const visibleMessage = internalFailureMessage(input.reason, input.code, input.language);
    return [
      this.errorEvent({
        id: diagnosticRef,
        sessionId: input.sessionId,
        ts: input.ts,
        message: visibleMessage,
        messageKey: 'session.driver.internalFailure',
        code: input.code,
        runId: input.runId,
        title: internalFailureTitle(input.stage, input.language),
        errorMessage: visibleMessage,
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
    proposalId: string;
    severity: string;
    message: string;
    language?: ConversationLanguage;
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
        proposalId: input.proposalId,
        title: input.language === 'zh-CN'
          ? '已接受任务诊断'
          : 'Accepted task diagnostic',
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
    id: string,
    language?: ConversationLanguage
  ): AgentEvent[] {
    const visibleReasons = language === 'zh-CN' ? undefined : reasons;
    const summary = language === 'zh-CN'
      ? `ActionBundle 未进入 Plan 确认卡；Session 已停止生成计划（错误代码：action_bundle_admission_failed，原因数：${reasons.length}）。`
      : `ActionBundle did not enter the Plan confirmation card; Session has stopped plan generation: ${reasons.join('; ')}`;
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
          reasons: visibleReasons,
          channel: 'error',
          visibility: 'conversation',
          activity: conversationActivity({
            activityId: id,
            kind: 'diagnostic',
            status: 'failed',
            title: language === 'zh-CN'
              ? 'ActionBundle 入场失败'
              : 'ActionBundle admission failed',
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
    id: string,
    language: ConversationLanguage = plan.responseLanguage ?? 'en-US'
  ): AgentEvent[] {
    const visibleReasons = language === 'zh-CN' ? undefined : reasons;
    const summary = language === 'zh-CN'
      ? `已接受计划的 actionBatch 提交前审计失败；Session 未提交至 Kernel（错误代码：accepted_plan_action_batch_preflight_failed，原因数：${reasons.length}）。`
      : `Accepted plan actionBatch pre-submission audit failed; Session did not submit to Kernel: ${reasons.join('; ')}`;
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
        reasons: visibleReasons,
        reasonCount: reasons.length,
        title: language === 'zh-CN'
          ? '已接受计划的 actionBatch 预检失败'
          : 'Accepted plan action batch preflight failed',
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
    id: string,
    language: ConversationPresentationLanguage = plan.responseLanguage ?? 'en-US'
  ): AgentEvent[] {
    const summary = localizedProjectionText(language, {
      zh: `已接受计划执行失败；Session 已停止自动推进（错误代码：${code}）。`,
      en: `Accepted plan execution failed; Session has stopped auto-advancing: ${message}`,
      neutral: `accepted_plan_execution=failed; code=${code}`,
    });
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
        title: localizedProjectionText(language, {
          zh: '已接受计划执行失败',
          en: 'Accepted plan execution failed',
          neutral: 'AcceptedPlan failed',
        }),
        presentationLanguage: language,
        errorMessage: language === 'en-US' ? message : summary,
      }),
      this.failedRunState(sessionId, plan.runId, plan.planId, plan.planId, 'work_unit_failed', ts, `${id}-state`, plan.interactionOverlay),
    ];
  }

  planActionBundleExecutionFailureEvents(
    sessionId: string,
    plan: SessionFailurePlanContext,
    kernelEvents: unknown[],
    batch: unknown,
    ts: string,
    id: string,
    language: ConversationPresentationLanguage = plan.responseLanguage ?? 'en-US'
  ): AgentEvent[] {
    const failures = this.ports.actionBatchFailureDetails(kernelEvents, batch);
    return [
      this.batchFailureEvent(sessionId, plan.runId, plan.planId, failures, ts, id, undefined, language),
      this.failedRunState(sessionId, plan.runId, plan.planId, plan.planId, 'work_unit_failed', ts, `${id}-state`, plan.interactionOverlay),
    ];
  }

  acceptedPlanNormalizationFailureEvents(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    reasons: string[],
    ts: string,
    id: string,
    language: ConversationLanguage = 'en-US'
  ): AgentEvent[] {
    const visibleReasons = language === 'zh-CN' ? undefined : reasons;
    const summary = language === 'zh-CN'
      ? `已接受计划的 actionBatch 提交前规范化失败；Session 未提交至 Kernel（错误代码：accepted_plan_batch_normalization_failed，原因数：${reasons.length}）。`
      : `Accepted plan actionBatch pre-submission canonicalization failed; Session did not submit to Kernel: ${reasons.join('; ')}`;
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
        reasons: visibleReasons,
        reasonCount: reasons.length,
        title: language === 'zh-CN'
          ? '已接受计划的批次规范化失败'
          : 'Accepted plan batch normalization failed',
      }),
      this.failedRunState(sessionId, runId, accepted.planId, accepted.planId, 'work_unit_failed', ts, `${id}-state`),
    ];
  }

  acceptedPlanExecutionFailureEvents(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    kernelEvents: unknown[],
    batch: unknown,
    ts: string,
    id: string,
    language: ConversationLanguage = 'en-US'
  ): AgentEvent[] {
    const failures = this.ports.actionBatchFailureDetails(kernelEvents, batch);
    return [
      this.batchFailureEvent(
        sessionId,
        runId,
        accepted.planId,
        failures,
        ts,
        id,
        accepted.batchIndex,
        language
      ),
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
    proposalId?: string;
    reasons?: string[];
    reasonCount?: number;
    title: string;
    errorMessage?: string;
    presentationLanguage?: ConversationPresentationLanguage;
  }): AgentEvent {
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'error',
      payload: {
        message: input.message,
        messageKey: input.messageKey,
        messageArgs: { reasonCount: input.reasonCount ?? input.reasons?.length ?? 0 },
        code: input.code,
        diagnosticRef: input.id,
        runId: input.runId,
        planId: input.planId,
        proposalId: input.proposalId,
        reasons: input.reasons,
        presentationLanguage: input.presentationLanguage,
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
    batchIndex?: number,
    language: ConversationPresentationLanguage = 'en-US'
  ): AgentEvent {
    const failureSummary = failures.map((failure) => this.ports.actionBatchFailureSummary(failure)).join('; ');
    const summary = failures.length
      ? localizedProjectionText(language, {
        zh: `已接受计划的执行批次失败；Session 已停止自动推进：${failureSummary}`,
        en: `Accepted plan execution batch failed; Session has stopped auto-advancing: ${failureSummary}`,
        neutral: `accepted_plan_batch=failed: ${failureSummary}`,
      })
      : localizedProjectionText(language, {
        zh: '已接受计划的执行批次失败或被阻塞；Session 已停止自动推进。',
        en: 'Accepted plan execution batch failed or blocked; Session has stopped auto-advancing.',
        neutral: 'accepted_plan_batch=failed_or_blocked',
      });
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
        presentationLanguage: language,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: localizedProjectionText(language, {
            zh: '已接受计划的执行批次失败',
            en: 'Accepted plan batch failed',
            neutral: 'AcceptedPlan batch failed',
          }),
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

function internalFailureMessage(
  reason: 'driver_failure' | 'provider_failure',
  code: string,
  language: 'zh-CN' | 'en-US' | undefined
): string {
  const candidateCode = code.trim();
  const safeCode = /^[A-Za-z0-9_.-]{1,96}$/.test(candidateCode) ? candidateCode : 'generic';
  if (reason === 'provider_failure') {
    return language === 'zh-CN'
      ? `模型调用失败，Session 已安全停止本轮（错误代码：${safeCode}）。此前已完成的步骤不受影响；请重试本轮。`
      : `The model call failed, so Session stopped this turn safely (error code: ${safeCode}). Previously completed steps are not affected; retry this turn.`;
  }
  return language === 'zh-CN'
    ? `Session 未能完成本轮并已安全停止（错误代码：${safeCode}）。此前已完成的步骤不受影响；请重试本轮。`
    : `Session could not complete this turn and stopped safely (error code: ${safeCode}). Previously completed steps are not affected; retry this turn.`;
}

function internalFailureTitle(
  stage: string,
  language: 'zh-CN' | 'en-US' | undefined
): string {
  const labels: Record<string, { zh: string; en: string }> = {
    driver: { zh: '会话编排', en: 'Session driver' },
    provider: { zh: '模型调用', en: 'Model call' },
    requirement_confirmation: { zh: '需求确认', en: 'Requirement confirmation' },
    decision_resolver: { zh: '决策处理', en: 'Decision handling' },
    run_engine: { zh: '执行循环', en: 'Session run loop' },
    resource_resolution: { zh: '资源解析', en: 'Resource resolution' },
    guidance_revision: { zh: '用户指令修订', en: 'Guidance revision' },
  };
  const label = labels[stage];
  if (language === 'zh-CN') return `${label?.zh ?? `Session ${stage}`}失败`;
  return `${label?.en ?? `Session ${stage}`} failed`;
}

function conversationActivity(input: AgentConversationActivity): AgentConversationActivity {
  return { ...input };
}
