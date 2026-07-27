import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  ConversationLanguage,
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
  conversationPresentationLanguageBindingFromEvents,
  localizedProjectionText,
} from '../projection/index.js';
import {
  decisionContinuationInput,
  returnSessionResult,
  type SessionLoopControlResult,
} from '../runContinuation.js';
import type { AutonomyMode, InterventionLevel, RequirementConfirmationMode, ReviewContinuationMode } from '../types.js';
import {
  createSessionLanguageDecisionEvent,
  effectiveConversationLanguage,
  normalizeHostLanguage,
  resolveConversationLanguagePolicy,
} from '../context/conversationLanguagePolicy.js';
import { latestSessionTurnAuthority } from '../context/userAuthorityFrame.js';
import { finalSettlementEvidenceMetadata } from '../authority/finalSettlementEvidence.js';

export type RequirementDecisionHandlerDecision = 'accept' | 'reject' | 'revise';
export type RequirementDecisionHandlerContinuationMode = ReviewContinuationMode;
export type RequirementDecisionHandlerInterventionLevel = InterventionLevel;
export type RequirementDecisionHandlerConfirmationMode = RequirementConfirmationMode;

export interface RequirementDecisionHandlerInput {
  sessionId: string;
  hostRunId?: string;
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
  hostLanguage?: ConversationLanguage;
  admittedFreeformAuthority?: {
    readonly messageId: string;
    readonly runId: string;
    readonly turnId: string;
    readonly revision: number;
    readonly hostLanguage: ConversationLanguage;
  };
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
  createError(code: string, message: string): Error;
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
    const active = this.ports.activeDriverInteraction(events);
    if (
      !input.runId
      || !requirementId
      || active?.kind !== 'requirement'
      || active.runId !== input.runId
      || active.requirementId !== requirementId
    ) {
      return returnSessionResult(await this.appendNoop(input, requirementId));
    }
    const confirmation = this.ports.userInputPipeline.findRequirementConfirmation(
      events,
      input.runId,
      requirementId,
      active
    );
    if (!confirmation) {
      return returnSessionResult(await this.appendNoop(input, requirementId));
    }
    const confirmationRunId = stringValue(objectRecord(confirmation.payload)?.runId)
      ?? input.runId;

    const decisionEvent = this.ports.requirementProjection.decisionEvent({
      sessionId: input.sessionId,
      event: confirmation,
      decision: input.decision,
      guidance: input.guidance,
      presentationBinding: conversationPresentationLanguageBindingFromEvents(
        events,
        confirmationRunId
      ),
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
    const binding = conversationPresentationLanguageBindingFromEvents(
      input.existingEvents ?? [],
      input.runId
    );
    return this.ports.append(input.sessionId, [
      this.ports.progressProjection.traceEvent({
        sessionId: input.sessionId,
        kind: 'trace/requirement_decision_noop',
        summary: localizedProjectionText(binding.language, {
          zh: '需求决策请求已解决或过期，未重复执行。',
          en: 'Requirement decision request is already resolved or expired; no duplicate action was taken.',
          neutral: 'requirement_decision=noop',
        }),
        language: binding.language,
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
      const confirmationRunId = stringValue(objectRecord(confirmation.payload)?.runId)
        ?? input.runId;
      const presentationBinding = conversationPresentationLanguageBindingFromEvents(
        current.events,
        confirmationRunId
      );
      return this.ports.append(input.sessionId, [
        this.ports.assistantProjection.finalDiagnosticEvent(
          input.sessionId,
          {
            code: 'accepted_plan_interaction_missing_plan',
            fallback: localizedProjectionText(presentationBinding.language, {
              zh: '已接受计划的交互决策无法恢复父级 taskPlan；Session 不会启动脱离原计划的需求流程。',
              en: 'Accepted-plan interaction decision could not recover the parent taskPlan; Session will not start a detached requirement flow.',
              neutral: 'accepted_plan_parent_task_plan=unavailable detached_requirement_flow=blocked',
            }),
          },
          this.ports.now(),
          this.ports.createId('accepted-plan-interaction-missing-plan'),
          presentationBinding
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
      input: decisionContinuationInput(input, {
        content: this.ports.executionPrompt.executionRequest(acceptedContext.plan, acceptedContext.acceptedPlan, guidance),
        attachments,
        existingEvents: current.events,
        workspaceBinding: continuationWorkspaceBinding(input, attachments),
        projectWorkingDirectory: continuationProjectWorkingDirectory(input, attachments),
        requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        resumeResourcePackets: true,
        acceptedTaskPlan: acceptedContext.acceptedPlan,
        interactionOverlay,
      }),
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
      const legacyFinishRun = effect.kind === 'finishRun';
      return this.ports.append(input.sessionId, [
        this.ports.progressProjection.sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: legacyFinishRun ? 'completed' : 'cancelled',
          status: legacyFinishRun ? 'completed' : 'cancelled',
          reason: 'requirement',
          decisionOwner: baseOwner,
          interactionOverlay,
          ts: this.ports.now(),
          id: this.ports.createId(
            legacyFinishRun
              ? 'session-run-completed-requirement'
              : 'session-run-cancelled-requirement'
          ),
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

  private async finishWithAnswer(
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
    let language = conversationLanguage(confirmationPayload.responseLanguage)
      ?? normalizeHostLanguage(input.hostLanguage);
    if (input.guidance?.trim()) {
      const admittedAuthority = input.admittedFreeformAuthority;
      if (!admittedAuthority) {
        throw this.ports.createError(
          'session_turn_authority_invalid',
          'Free-text requirement completion has no admitted authority reference.'
        );
      }
      const authority = latestSessionTurnAuthority(current.events, runId);
      if (
        !authority
        || authority.runId !== admittedAuthority.runId
        || authority.turnId !== admittedAuthority.turnId
        || authority.languagePolicy.revision !== admittedAuthority.revision
        || authority.languagePolicy.hostLanguage !== admittedAuthority.hostLanguage
        || !authority.sourceMessageIds.includes(admittedAuthority.messageId)
      ) {
        throw this.ports.createError(
          'session_turn_authority_invalid',
          'Free-text requirement completion authority no longer matches the admitted revision.'
        );
      }
      let policy = resolveConversationLanguagePolicy(current.events, authority);
      if (policy.status === 'pending') {
        const persisted = await this.ports.append(input.sessionId, [
          createSessionLanguageDecisionEvent({
            sessionId: authority.sessionId,
            runId: authority.runId,
            turnId: authority.turnId,
            revision: authority.languagePolicy.revision,
            status: 'fallback',
            responseLanguage: policy.hostLanguage,
            decisionSource: 'hostFallbackMissing',
            eventId: this.ports.createId('session-language-fallback'),
            timestamp: this.ports.now(),
          }),
        ]);
        policy = resolveConversationLanguagePolicy(persisted.events, authority);
      }
      if (policy.status === 'superseded') {
        throw this.ports.createError(
          'session_turn_authority_invalid',
          'Free-text requirement completion authority was superseded before local output.'
        );
      }
      language = effectiveConversationLanguage(policy);
    }
    const answerProposal = this.ports.assistantProjection.decisionEffectAnswerProposal({
      sessionId: input.sessionId,
      runId,
      proposalId: this.ports.createId('finish-with-answer-proposal'),
      completedTasks: taskLedger?.completedTaskIds.length ?? 0,
      totalTasks: taskLedger?.taskOrder.length ?? 0,
      pendingTasks: taskLedger?.pendingTaskIds.length ?? 0,
      reason,
      guidance: input.guidance,
      language,
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
        ...finalSettlementEvidenceMetadata(accepted),
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
      ...(accepted.skippedTaskIds ?? []),
      ...(accepted.acceptedIncompleteTaskIds ?? []),
    ]);
    const currentTaskId = accepted.tasks.find((task) => !settledTaskIds.has(task.taskId))?.taskId;
    let skippedTaskIds: string[] = [];
    let acceptedIncompleteTaskIds: string[] = [];
    if (normalizedEffect.kind === 'skipTask') {
      if (!currentTaskId) return undefined;
      skippedTaskIds = [currentTaskId];
    } else if (normalizedEffect.kind === 'markAcceptedIncomplete') {
      const ids = normalizedEffect.taskIds?.length ? normalizedEffect.taskIds : (currentTaskId ? [currentTaskId] : []);
      acceptedIncompleteTaskIds = ids.filter((id) => !settledTaskIds.has(id) && accepted.tasks.some((task) => task.taskId === id));
      if (acceptedIncompleteTaskIds.length === 0) return undefined;
    } else {
      return undefined;
    }
    const newlySettledTaskIds = [...skippedTaskIds, ...acceptedIncompleteTaskIds];
    const nextAccepted = this.ports.acceptedPlanLedger.recordUserTaskSettlement({
      acceptedPlan: accepted,
      skippedTaskIds,
      acceptedIncompleteTaskIds,
    }).nextAcceptedPlan;
    const mergedSettledTaskIds = new Set([
      ...nextAccepted.completedTaskIds,
      ...(nextAccepted.modelJudgedSufficientTaskIds ?? []),
      ...(nextAccepted.skippedTaskIds ?? []),
      ...(nextAccepted.acceptedIncompleteTaskIds ?? []),
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
        newlySettledTaskIds,
        remainingTaskIds,
        effect.kind,
        stringValue(objectRecord(decisionPayload.selectedOption)?.id),
        this.ports.now(),
        checkpointId,
        input.guidance?.trim()
          ? normalizeHostLanguage(input.hostLanguage)
          : conversationLanguage(confirmationPayload.responseLanguage)
            ?? normalizeHostLanguage(input.hostLanguage)
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
      input: decisionContinuationInput(input, {
        content: originalRequest,
        attachments,
        existingEvents: current.events,
        workspaceBinding: continuationWorkspaceBinding(input, attachments),
        projectWorkingDirectory: continuationProjectWorkingDirectory(input, attachments),
        confirmedRequirement: input.decision === 'accept' ? this.ports.userInputPipeline.requirementRecordFromEvent(confirmation, 'confirmed') : undefined,
        requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interactionOverlay,
      }),
    };
  }
}

function conversationLanguage(value: unknown): ConversationLanguage | undefined {
  return value === 'zh-CN' || value === 'en-US' ? value : undefined;
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
