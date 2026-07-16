import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
} from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../../context/index.js';
import type { ProjectWorkingDirectory } from '../../context/types.js';
import {
  buildAnswerFactsContext,
  buildReviewFactsContext,
  evaluateRunState,
  normalizeDecisionEffect,
} from '../../run-state/index.js';
import type {
  AcceptedTaskPlanContext,
  AcceptedTaskPlanExecutionRoot,
  AcceptedPlanTaskLedgerCoordinator,
  ExecutionPromptCoordinator,
} from '../execution/index.js';
import type { InteractionOverlayCodec, InteractionOverlayContext, SessionTurnPhase } from '../pipelines/interactionOverlayCodec.js';
import type { RequirementOptionEffect, UserInputPipeline } from '../pipelines/userInputPipeline.js';
import type { PlanContext, PlanContextIndex } from '../proposal/planContextIndex.js';
import type {
  AssistantProjectionBuilder,
  RequirementProjectionBuilder,
  SessionProgressProjectionBuilder,
} from '../projection/index.js';
import {
  decisionContinuationInput,
  returnSessionResult,
  type SessionLoopControlResult,
} from '../runContinuation.js';
import type { AutonomyMode, InterventionLevel, RequirementConfirmationMode, ReviewContinuationMode } from '../types.js';

export type RequirementDecisionHandlerDecision = 'accept' | 'reject' | 'revise';
export type RequirementDecisionHandlerContinuationMode = ReviewContinuationMode;
export type RequirementDecisionHandlerInterventionLevel = InterventionLevel;
export type RequirementDecisionHandlerConfirmationMode = RequirementConfirmationMode;
export type RequirementDecisionHandlerVisibleLanguage = 'zh-CN' | 'en-US';

export interface RequirementDecisionHandlerInput {
  sessionId: string;
  decision: RequirementDecisionHandlerDecision;
  guidance?: string;
  runId?: string;
  targetId?: string;
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  projectId?: string;
  projectKind?: 'folder' | 'blank';
  projectRootStatus?: 'ready' | 'unbound' | 'unavailable';
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: RequirementDecisionHandlerContinuationMode;
  interventionLevel?: RequirementDecisionHandlerInterventionLevel;
  autonomyMode?: AutonomyMode;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
}

export type RequirementDriverInteractionRef =
  | { kind: 'review'; runId: string }
  | { kind: 'plan'; runId: string; planId: string }
  | { kind: 'requirement'; runId: string; requirementId: string };

export interface RequirementRecoveredAcceptedPlanContext {
  plan: PlanContext;
  acceptedPlan: AcceptedTaskPlanContext;
}

export interface RequirementDecisionHandlerPorts {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  activeDriverInteraction(events: AgentEvent[]): RequirementDriverInteractionRef | null;
  executionRootFromDecision(input: RequirementDecisionHandlerInput, events: AgentEvent[]): AcceptedTaskPlanExecutionRoot | undefined;
  buildAcceptedTaskPlan(input: {
    plan: PlanContext;
    interventionLevel?: RequirementDecisionHandlerInterventionLevel;
    executionRoot?: AcceptedTaskPlanExecutionRoot;
  }): AcceptedTaskPlanContext;
  recoverAcceptedPlanFromOverlay(
    input: RequirementDecisionHandlerInput,
    events: AgentEvent[],
    overlay: InteractionOverlayContext | undefined
  ): RequirementRecoveredAcceptedPlanContext | undefined;
  visibleLanguageForRequest(userRequest: string): RequirementDecisionHandlerVisibleLanguage;
  userInputPipeline: UserInputPipeline;
  interactionOverlayCodec: InteractionOverlayCodec;
  requirementProjection: RequirementProjectionBuilder;
  assistantProjection: AssistantProjectionBuilder;
  progressProjection: SessionProgressProjectionBuilder;
  planIndex: PlanContextIndex;
  acceptedPlanLedger: AcceptedPlanTaskLedgerCoordinator;
  executionPrompt: ExecutionPromptCoordinator<PlanContext>;
}

export class RequirementDecisionHandler {
  constructor(private readonly ports: RequirementDecisionHandlerPorts) {}

  async resolve(input: RequirementDecisionHandlerInput): Promise<SessionLoopControlResult> {
    const events = input.existingEvents ?? [];
    const requirementId = input.targetId;
    const confirmation = this.ports.userInputPipeline.findRequirementConfirmation(
      events,
      input.runId,
      requirementId,
      this.ports.activeDriverInteraction(events)
    );
    if (!confirmation) {
      return returnSessionResult(await this.appendNoop(input, requirementId));
    }

    const decisionEvent = this.ports.requirementProjection.decisionEvent({
      sessionId: input.sessionId,
      event: confirmation,
      decision: input.decision,
      guidance: input.guidance,
      ts: this.ports.now(),
      id: this.ports.createId('requirement-decision'),
    });
    const interactionOverlay = this.ports.interactionOverlayCodec.fromRequirementDecision(confirmation, decisionEvent);
    const result = await this.ports.append(input.sessionId, [decisionEvent]);

    if (input.decision === 'reject') {
      return returnSessionResult(await this.reject(input, decisionEvent, interactionOverlay, result, requirementId));
    }
    if (this.ports.userInputPipeline.isResourceBudgetConfirmation(confirmation)) {
      return this.resolveResourceBudgetDecision(input, confirmation, interactionOverlay, result);
    }
    if (this.ports.userInputPipeline.isAcceptedPlanExecutionConfirmation(confirmation)) {
      return normalizeRequirementControl(await this.resolveAcceptedPlanExecutionDecision(
        input,
        confirmation,
        decisionEvent,
        interactionOverlay,
        result
      ));
    }

    if (input.decision === 'accept') {
      const optionEffect = this.ports.userInputPipeline.selectedRequirementDecisionOptionEffect(decisionEvent);
      if (optionEffect) {
        const dispatched = await this.applyRequirementOptionEffect(
          input,
          confirmation,
          decisionEvent,
          interactionOverlay,
          optionEffect,
          result
        );
        if (dispatched) return normalizeRequirementControl(dispatched);
      }
    }

    return this.resumeParentFlow(input, confirmation, decisionEvent, interactionOverlay, result);
  }

  private appendNoop(
    input: RequirementDecisionHandlerInput,
    requirementId: string | undefined
  ): Promise<AgentSessionResult> {
    return this.ports.append(input.sessionId, [
      this.ports.progressProjection.traceEvent({
        sessionId: input.sessionId,
        kind: 'trace/requirement_decision_noop',
        summary: 'Requirement decision request is already resolved or expired; no duplicate action was taken.',
        ts: this.ports.now(),
        id: this.ports.createId('requirement-noop'),
        extra: {
          messageKey: 'session.driver.requirementDecision.noop',
          messageArgs: {},
          runId: input.runId,
          requirementId,
          decision: input.decision,
        },
      }),
    ]);
  }

  private reject(
    input: RequirementDecisionHandlerInput,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    current: AgentSessionResult,
    requirementId: string | undefined
  ): Promise<AgentSessionResult> {
    const payload = objectRecord(decisionEvent.payload) ?? {};
    const runId = stringValue(payload.runId) ?? input.runId ?? 'run-unknown';
    const resolvedRequirementId = stringValue(payload.requirementId) ?? requirementId;
    return this.ports.append(input.sessionId, [
      this.ports.progressProjection.sessionRunStateEvent({
        sessionId: input.sessionId,
        runId,
        phase: 'cancelled',
        status: 'cancelled',
        reason: 'requirement',
        decisionOwner: {
          kind: 'requirement',
          runId,
          targetId: resolvedRequirementId,
          requirementId: resolvedRequirementId,
        },
        interactionOverlay,
        ts: this.ports.now(),
        id: this.ports.createId('session-run-cancelled-requirement'),
      }),
    ]) ?? Promise.resolve(current);
  }

  private resolveResourceBudgetDecision(
    input: RequirementDecisionHandlerInput,
    confirmation: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    current: AgentSessionResult
  ): SessionLoopControlResult {
    const originalRequest = this.ports.userInputPipeline.requirementOriginalRequest(confirmation);
    const attachments = this.ports.userInputPipeline.requirementAttachments(confirmation);
    return {
      kind: 'resume',
      input: decisionContinuationInput(input, {
        content: input.decision === 'revise' && input.guidance
          ? [
              originalRequest,
              '',
              'User guidance after the read-only resource budget checkpoint (verbatim):',
              input.guidance,
              '',
              'If the user asks for an answer from the current evidence, prefer closing with the existing ResourcePackets.',
              'If the user narrowed the scope and key facts are still missing, continue with focused read-only resourceRequest within the additional budget.',
              'Write user-visible proposal fields in the current user request language; keep protocol keys and evidence refs unchanged.',
            ].join('\n')
          : originalRequest,
        attachments,
        existingEvents: current.events,
        resumeResourcePackets: true,
        interactionOverlay,
        ...continuationRootOverride(attachments),
      }),
    };
  }

  private async resolveAcceptedPlanExecutionDecision(
    input: RequirementDecisionHandlerInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    current: AgentSessionResult
  ): Promise<AgentSessionResult | SessionLoopControlResult> {
    const acceptedContext = this.ports.recoverAcceptedPlanFromOverlay(input, current.events, interactionOverlay);
    if (!acceptedContext) {
      return this.ports.append(input.sessionId, [
        this.ports.assistantProjection.finalDiagnosticEvent(
          input.sessionId,
          'Accepted-plan interaction decision could not recover the parent taskPlan; Session will not start a detached requirement flow.',
          this.ports.now(),
          this.ports.createId('accepted-plan-interaction-missing-plan')
        ),
      ]) ?? current;
    }
    const guidance = this.ports.userInputPipeline.acceptedPlanExecutionRequirementResumeRequest(
      confirmation,
      decisionEvent,
      input.decision,
      input.guidance
    );
    if (input.decision !== 'revise') {
      const attachments = acceptedContext.acceptedPlan.executionRoot
        ? [acceptedContext.acceptedPlan.executionRoot.attachment]
        : this.ports.userInputPipeline.requirementAttachments(confirmation);
      return {
        kind: 'resume',
        input: decisionContinuationInput(input, {
          content: this.ports.executionPrompt.executionRequest(acceptedContext.plan, acceptedContext.acceptedPlan, guidance),
          attachments,
          existingEvents: current.events,
          reviewContinuationMode: input.reviewContinuationMode,
          resumeResourcePackets: true,
          acceptedTaskPlan: acceptedContext.acceptedPlan,
          interactionOverlay,
          ...continuationRootOverride(attachments),
        }),
      };
    }
    const attachments = acceptedContext.acceptedPlan.executionRoot
      ? [acceptedContext.acceptedPlan.executionRoot.attachment]
      : this.ports.userInputPipeline.requirementAttachments(confirmation);
    return {
      kind: 'resume',
      input: {
        sessionId: input.sessionId,
        content: this.ports.executionPrompt.executionRequest(acceptedContext.plan, acceptedContext.acceptedPlan, guidance),
        attachments,
        existingEvents: current.events,
        workspaceBinding: continuationWorkspaceBinding(input, attachments),
        projectWorkingDirectory: continuationProjectWorkingDirectory(input, attachments),
        projectId: input.projectId,
        projectKind: input.projectKind,
        projectRootStatus: input.projectRootStatus,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
        resumeResourcePackets: true,
        acceptedTaskPlan: acceptedContext.acceptedPlan,
        interactionOverlay,
      },
    };
  }

  private async applyRequirementOptionEffect(
    input: RequirementDecisionHandlerInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    effect: RequirementOptionEffect,
    current: AgentSessionResult
  ): Promise<AgentSessionResult | SessionLoopControlResult | undefined> {
    const normalizedEffect = normalizeDecisionEffect(effect);
    const stateDecision = evaluateRunState({ decisionEffect: normalizedEffect });
    if (stateDecision.kind === 'continueAcceptedPlan') return undefined;

    const decisionPayload = objectRecord(decisionEvent.payload) ?? {};
    const runId = stringValue(decisionPayload.runId) ?? input.runId ?? 'run-unknown';
    const requirementId = stringValue(decisionPayload.requirementId) ?? input.targetId;
    const baseOwner = {
      kind: 'requirement' as const,
      runId,
      targetId: requirementId,
      requirementId,
    };

    if (stateDecision.kind === 'finishWithAnswer') {
      return this.finishWithAnswer(input, confirmation, current, runId, baseOwner, interactionOverlay, effect);
    }

    if (stateDecision.kind === 'cancel') {
      return this.ports.append(input.sessionId, [
        this.ports.progressProjection.sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'completed',
          status: 'completed',
          reason: 'requirement',
          decisionOwner: baseOwner,
          interactionOverlay,
          ts: this.ports.now(),
          id: this.ports.createId('session-run-completed-requirement'),
        }),
      ]) ?? current;
    }

    if (stateDecision.kind === 'waitForPlanReview') {
      return this.ports.append(input.sessionId, [
        this.ports.progressProjection.sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'waiting_plan_review',
          status: 'waiting',
          reason: 'plan_review',
          decisionOwner: baseOwner,
          interactionOverlay,
          ts: this.ports.now(),
          id: this.ports.createId('session-run-replan-requirement'),
        }),
      ]) ?? current;
    }

    return this.applyTaskProgressEffect(input, confirmation, decisionEvent, interactionOverlay, effect, normalizedEffect, current, runId, baseOwner);
  }

  private finishWithAnswer(
    input: RequirementDecisionHandlerInput,
    confirmation: AgentEvent,
    current: AgentSessionResult,
    runId: string,
    baseOwner: { kind: 'requirement'; runId: string; targetId?: string; requirementId?: string },
    interactionOverlay: InteractionOverlayContext | undefined,
    effect: RequirementOptionEffect
  ): Promise<AgentSessionResult> {
    const confirmationPayload = objectRecord(confirmation.payload) ?? {};
    const accepted = this.recoverAcceptedPlanForRequirement(current.events, runId, undefined);
    const taskLedger = this.ports.acceptedPlanLedger.ledger(accepted);
    const reason = effect.kind === 'finishWithAnswer'
      ? effect.reason
      : effect.kind === 'markAcceptedIncomplete'
        ? effect.reason
        : undefined;
    const answerProposal = this.ports.assistantProjection.decisionEffectAnswerProposal({
      sessionId: input.sessionId,
      runId,
      proposalId: this.ports.createId('finish-with-answer-proposal'),
      completedTasks: taskLedger?.completedTaskIds.length ?? 0,
      totalTasks: taskLedger?.taskOrder.length ?? 0,
      pendingTasks: taskLedger?.pendingTaskIds.length ?? 0,
      reason,
      guidance: input.guidance,
      language: this.ports.visibleLanguageForRequest(stringValue(confirmationPayload.originalUserRequest) ?? input.guidance ?? ''),
    });
    return this.ports.append(input.sessionId, [
      this.ports.assistantProjection.answerEvent(input.sessionId, answerProposal, this.ports.now(), this.ports.createId('answer'), {
        answerFactsContext: buildAnswerFactsContext({
          reviewFactsContext: buildReviewFactsContext({
            runId,
            taskLedger,
          }),
          userGuidance: input.guidance,
        }),
      }),
      this.ports.progressProjection.sessionRunStateEvent({
        sessionId: input.sessionId,
        runId,
        phase: 'completed',
        status: 'completed',
        reason: 'requirement',
        decisionOwner: baseOwner,
        interactionOverlay,
        ts: this.ports.now(),
        id: this.ports.createId('session-run-completed-answer'),
      }),
    ]) ?? current;
  }

  private async applyTaskProgressEffect(
    input: RequirementDecisionHandlerInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    effect: RequirementOptionEffect,
    normalizedEffect: ReturnType<typeof normalizeDecisionEffect>,
    current: AgentSessionResult,
    runId: string,
    baseOwner: { kind: 'requirement'; runId: string; targetId?: string; requirementId?: string }
  ): Promise<AgentSessionResult | SessionLoopControlResult | undefined> {
    const decisionPayload = objectRecord(decisionEvent.payload) ?? {};
    const confirmationPayload = objectRecord(confirmation.payload) ?? {};
    const decisionRequest = objectRecord(confirmationPayload.decisionRequest) ?? {};
    const planId = stringValue(decisionRequest.acceptedPlanId)
      ?? stringValue(confirmationPayload.acceptedPlanId)
      ?? stringValue(decisionPayload.acceptedPlanId);
    const accepted = this.recoverAcceptedPlanForRequirement(current.events, runId, planId);
    if (!accepted) return undefined;

    const settledTaskIds = new Set([
      ...accepted.completedTaskIds,
      ...(accepted.modelJudgedSufficientTaskIds ?? []),
    ]);
    const currentTaskId = accepted.tasks.find((task) => !settledTaskIds.has(task.taskId))?.taskId;
    const newlyCompleted: string[] = [];
    let acceptedIncompleteTaskIds: string[] = [];
    if (normalizedEffect.kind === 'skipTask') {
      if (!currentTaskId) return undefined;
      newlyCompleted.push(currentTaskId);
    } else if (normalizedEffect.kind === 'markAcceptedIncomplete') {
      const ids = normalizedEffect.taskIds?.length ? normalizedEffect.taskIds : (currentTaskId ? [currentTaskId] : []);
      acceptedIncompleteTaskIds = ids.filter((id) => !settledTaskIds.has(id) && accepted.tasks.some((task) => task.taskId === id));
      newlyCompleted.push(...acceptedIncompleteTaskIds);
      if (newlyCompleted.length === 0) return undefined;
    } else {
      return undefined;
    }
    const mergedCompletedTaskIds = [...accepted.completedTaskIds, ...newlyCompleted];
    const nextAccepted = this.ports.acceptedPlanLedger.recordTaskCompletion({
      acceptedPlan: accepted,
      completedTaskIds: mergedCompletedTaskIds,
    }).nextAcceptedPlan;
    const mergedSettledTaskIds = new Set([
      ...mergedCompletedTaskIds,
      ...(accepted.modelJudgedSufficientTaskIds ?? []),
    ]);
    const remainingTaskIds = accepted.tasks
      .map((task) => task.taskId)
      .filter((id) => !mergedSettledTaskIds.has(id));
    const allDone = remainingTaskIds.length === 0;

    const checkpointId = this.ports.createId('requirement-driven-task-checkpoint');
    const events: AgentEvent[] = [
      this.ports.progressProjection.requirementDrivenTaskCheckpointEvent(
        input.sessionId,
        runId,
        nextAccepted,
        newlyCompleted,
        mergedCompletedTaskIds,
        remainingTaskIds,
        effect.kind,
        stringValue(objectRecord(decisionPayload.selectedOption)?.id),
        this.ports.now(),
        checkpointId
      ),
    ];
    if (allDone) {
      events.push(this.ports.progressProjection.sessionRunStateEvent({
        sessionId: input.sessionId,
        runId,
        phase: 'completed',
        status: 'completed',
        reason: 'requirement',
        decisionOwner: baseOwner,
        interactionOverlay,
        ts: this.ports.now(),
        id: this.ports.createId('session-run-completed-requirement-tasks'),
      }));
      return this.ports.append(input.sessionId, events) ?? current;
    }

    const result = await this.ports.append(input.sessionId, events) ?? current;
    const originalRequest = this.ports.userInputPipeline.requirementDecisionResumeRequest(confirmation, decisionEvent, input.decision, input.guidance);
    const attachments = this.ports.userInputPipeline.requirementAttachments(confirmation);
    return {
      kind: 'resume',
      input: decisionContinuationInput(input, {
        content: originalRequest,
        attachments,
        existingEvents: result.events,
        confirmedRequirement: this.ports.userInputPipeline.requirementRecordFromEvent(confirmation, 'confirmed'),
        acceptedTaskPlan: nextAccepted,
        interactionOverlay,
        ...continuationRootOverride(attachments),
      }),
    };
  }

  private recoverAcceptedPlanForRequirement(
    events: AgentEvent[],
    runId: string,
    planId: string | undefined
  ): AcceptedTaskPlanContext | undefined {
    const plan = (runId ? this.ports.planIndex.findPlanCard(events, runId, planId) : null)
      ?? this.ports.planIndex.findPlanCard(events, undefined, planId)
      ?? (runId ? this.ports.planIndex.latestExecutablePlan(events, runId) : null);
    if (!plan || !plan.taskPlan) return undefined;
    const base = this.ports.buildAcceptedTaskPlan({ plan, interventionLevel: undefined, executionRoot: plan.executionRoot });
    return this.ports.acceptedPlanLedger.recoverLatestCheckpoint({
      acceptedPlan: base,
      events,
    }).nextAcceptedPlan;
  }

  private resumeParentFlow(
    input: RequirementDecisionHandlerInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    current: AgentSessionResult
  ): SessionLoopControlResult {
    const originalRequest = this.ports.userInputPipeline.requirementDecisionResumeRequest(confirmation, decisionEvent, input.decision, input.guidance);
    const attachments = this.ports.userInputPipeline.requirementAttachments(confirmation);
    return {
      kind: 'resume',
      input: {
        sessionId: input.sessionId,
        content: originalRequest,
        attachments,
        existingEvents: current.events,
        workspaceBinding: continuationWorkspaceBinding(input, attachments),
        projectMemoryMode: input.projectMemoryMode,
        projectWorkingDirectory: continuationProjectWorkingDirectory(input, attachments),
        projectId: input.projectId,
        projectKind: input.projectKind,
        projectRootStatus: input.projectRootStatus,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        confirmedRequirement: input.decision === 'accept' ? this.ports.userInputPipeline.requirementRecordFromEvent(confirmation, 'confirmed') : undefined,
        requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
        interventionLevel: input.interventionLevel,
        interactionOverlay,
      },
    };
  }
}

function continuationRootOverride(attachments: AgentContextAttachment[]): {
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
} {
  return hasDirectoryRootAttachment(attachments)
    ? { workspaceBinding: undefined, projectWorkingDirectory: undefined }
    : {};
}

function continuationWorkspaceBinding(
  input: RequirementDecisionHandlerInput,
  attachments: AgentContextAttachment[]
): AgentWorkspaceBinding | undefined {
  return hasDirectoryRootAttachment(attachments) ? undefined : input.workspaceBinding;
}

function continuationProjectWorkingDirectory(
  input: RequirementDecisionHandlerInput,
  attachments: AgentContextAttachment[]
): ProjectWorkingDirectory | undefined {
  return hasDirectoryRootAttachment(attachments) ? undefined : input.projectWorkingDirectory;
}

function hasDirectoryRootAttachment(attachments: AgentContextAttachment[]): boolean {
  return attachments.some((attachment) =>
    attachment.kind === 'directory' && Boolean(attachment.absolutePath ?? attachment.path)
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRequirementControl(
  value: AgentSessionResult | SessionLoopControlResult
): SessionLoopControlResult {
  const kind = objectRecord(value)?.kind;
  return kind === 'return' || kind === 'resume' || kind === 'assembleReview'
    ? value as SessionLoopControlResult
    : returnSessionResult(value as AgentSessionResult);
}
