import type {
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  ConversationLanguage,
} from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../../context/index.js';
import type { ProjectWorkingDirectory } from '../../context/types.js';
import type { InteractionOverlayContext } from '../pipelines/interactionOverlayCodec.js';
import type { PermissionDecisionHandler } from './permissionDecisionHandler.js';
import type { PlanDecisionHandler } from './planDecisionHandler.js';
import type { RequirementDecisionHandler } from './requirementDecisionHandler.js';
import type { ReviewDecisionHandler } from './reviewDecisionHandler.js';
import type { AutonomyMode, InterventionLevel, ReviewContinuationMode } from '../types.js';
import type {
  SessionLoopControlResult,
  SessionLoopResumeInput,
} from '../runContinuation.js';
import type {
  AcceptedPlanReviewHandoffPlan,
  AcceptedPlanReviewHandoffRunInput,
} from '../review/acceptedPlanReviewHandoffCoordinator.js';
import type { SessionGoalOperationContext } from '../../goal/index.js';
import {
  createSessionTurnAuthorityEvent,
  hasLegacySessionTurnAuthority,
  latestSessionTurnAuthority,
} from '../context/userAuthorityFrame.js';
import {
  createSessionLanguageDecisionEvent,
  nextConversationLanguageRevision,
  normalizeHostLanguage,
  resolveConversationLanguagePolicy,
} from '../context/conversationLanguagePolicy.js';
import {
  conversationPresentationLanguageBindingFromEvents,
  localizedProjectionText,
  type ProjectionLanguageBinding,
} from '../projection/index.js';

export type DecisionResolverKind = 'requirement' | 'plan' | 'review' | 'permission' | 'boundary';
export type DecisionResolverDecision = 'accept' | 'reject' | 'revise';
export type DecisionResolverReviewContinuationMode = ReviewContinuationMode;
export type DecisionResolverInterventionLevel = InterventionLevel;

export interface DecisionResolverInput {
  sessionId: string;
  hostRunId?: string;
  kind: DecisionResolverKind;
  decision: DecisionResolverDecision;
  guidance?: string;
  runId?: string;
  targetId?: string;
  interactionId?: string;
  interactionRevision?: string;
  decisionRequestId?: string;
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  projectId?: string;
  projectKind?: 'folder' | 'blank';
  projectRootStatus?: 'ready' | 'unbound' | 'unavailable';
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: DecisionResolverReviewContinuationMode;
  interventionLevel?: DecisionResolverInterventionLevel;
  autonomyMode?: AutonomyMode;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
  hostLanguage?: ConversationLanguage;
  bootstrapEvents?: AgentEvent[];
  goalContext?: SessionGoalOperationContext;
  admittedFreeformAuthority?: {
    readonly messageId: string;
    readonly runId: string;
    readonly turnId: string;
    readonly revision: number;
    readonly hostLanguage: ConversationLanguage;
  };
}

export interface DecisionResolverDiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export interface DecisionRunCommand {
  readonly kind: 'resolveDecision';
  readonly input: DecisionResolverInput;
}

export type DecisionRunEffect =
  | {
    readonly kind: 'decisionRouted';
    readonly decisionKind: Exclude<DecisionResolverKind, 'boundary'>;
    readonly result: AgentSessionResult;
  }
  | {
    readonly kind: 'unsupportedDecisionKind';
    readonly decisionKind: DecisionResolverKind;
    readonly result: AgentSessionResult;
  };

export interface DecisionResolverPorts {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  finalDiagnosticEvent(
    sessionId: string,
    content: string | DecisionResolverDiagnosticInfo,
    ts: string,
    id: string,
    presentationBinding: ProjectionLanguageBinding
  ): AgentEvent;
  missingDecisionKindMessage(kind: string): string | DecisionResolverDiagnosticInfo;
  createError(code: string, message: string): Error;
  exactDecisionTarget(
    input: DecisionResolverInput,
    events: AgentEvent[]
  ): { runId: string; targetId: string } | undefined;
  resume(input: SessionLoopResumeInput): Promise<AgentSessionResult>;
  assembleReview(
    input: AcceptedPlanReviewHandoffRunInput<AcceptedPlanReviewHandoffPlan>
  ): Promise<AgentSessionResult>;
  requirementHandler: RequirementDecisionHandler;
  planHandler: PlanDecisionHandler;
  permissionHandler: PermissionDecisionHandler;
  reviewHandler: ReviewDecisionHandler;
}

export class DecisionResolver {
  constructor(private readonly ports: DecisionResolverPorts) {}

  async resolve(input: DecisionResolverInput): Promise<AgentSessionResult> {
    const effect = await this.execute({ kind: 'resolveDecision', input });
    return effect.result;
  }

  private async execute(command: DecisionRunCommand): Promise<DecisionRunEffect> {
    const current = await this.ports.append(command.input.sessionId, []);
    if (
      command.input.kind === 'permission'
      && command.input.decision === 'revise'
    ) {
      throw this.ports.createError(
        'session_permission_revision_unsupported',
        'Permission requests only support accept or reject; Session did not admit free-text guidance, create a language revision, or submit a Kernel decision.'
      );
    }
    const input = await this.admitFreeformGuidance({
      ...command.input,
      existingEvents: current.events,
    });
    if (input.kind === 'requirement') {
      const result = await this.settle(input, await this.ports.requirementHandler.resolve({
        sessionId: input.sessionId,
        hostRunId: input.hostRunId,
        decision: input.decision,
        guidance: input.guidance,
        runId: input.runId,
        targetId: input.targetId,
        interactionId: input.interactionId,
        interactionRevision: input.interactionRevision,
        existingEvents: input.existingEvents,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        projectId: input.projectId,
        projectKind: input.projectKind,
        projectRootStatus: input.projectRootStatus,
        profileId: input.profileId,
        workflow: input.workflow,
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        autonomyMode: input.autonomyMode,
        projectMemoryMode: input.projectMemoryMode,
        interactionOverlay: input.interactionOverlay,
        hostLanguage: input.hostLanguage,
        admittedFreeformAuthority: input.admittedFreeformAuthority,
      }));
      return { kind: 'decisionRouted', decisionKind: 'requirement', result };
    }
    if (input.kind === 'plan') {
      const result = await this.settle(input, await this.ports.planHandler.resolve({
        sessionId: input.sessionId,
        hostRunId: input.hostRunId,
        decision: input.decision,
        guidance: input.guidance,
        runId: input.runId,
        targetId: input.targetId,
        existingEvents: input.existingEvents,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        projectId: input.projectId,
        projectKind: input.projectKind,
        projectRootStatus: input.projectRootStatus,
        profileId: input.profileId,
        workflow: input.workflow,
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        autonomyMode: input.autonomyMode,
        projectMemoryMode: input.projectMemoryMode,
        interactionOverlay: input.interactionOverlay,
        hostLanguage: input.hostLanguage,
        goalContext: input.goalContext,
      }));
      return { kind: 'decisionRouted', decisionKind: 'plan', result };
    }
    if (input.kind === 'permission') {
      const result = await this.settle(input, await this.ports.permissionHandler.resolve({
        sessionId: input.sessionId,
        hostRunId: input.hostRunId,
        decision: input.decision,
        runId: input.runId,
        targetId: input.targetId,
        existingEvents: input.existingEvents,
      }));
      return { kind: 'decisionRouted', decisionKind: 'permission', result };
    }
    if (input.kind === 'review') {
      const result = await this.settle(input, await this.ports.reviewHandler.resolve({
        sessionId: input.sessionId,
        hostRunId: input.hostRunId,
        decision: input.decision,
        guidance: input.guidance,
        runId: input.runId,
        targetId: input.targetId,
        existingEvents: input.existingEvents,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        projectId: input.projectId,
        projectKind: input.projectKind,
        projectRootStatus: input.projectRootStatus,
        profileId: input.profileId,
        workflow: input.workflow,
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        autonomyMode: input.autonomyMode,
        projectMemoryMode: input.projectMemoryMode,
        hostLanguage: input.hostLanguage,
      }));
      return { kind: 'decisionRouted', decisionKind: 'review', result };
    }
    const unsupportedCurrent = await this.ports.append(input.sessionId, []);
    await this.settlePendingFreeformAuthority(input, unsupportedCurrent);
    const presentationBinding = conversationPresentationLanguageBindingFromEvents(
      input.existingEvents ?? unsupportedCurrent.events,
      input.runId
    );
    const missing = this.ports.missingDecisionKindMessage(input.kind);
    const diagnostic: DecisionResolverDiagnosticInfo = typeof missing === 'string'
      ? { code: 'decisionResolverMissing', fallback: missing, params: { kind: input.kind } }
      : missing;
    const result = await this.ports.append(input.sessionId, [
      ...(input.bootstrapEvents ?? []),
      this.ports.finalDiagnosticEvent(
        input.sessionId,
        {
          ...diagnostic,
          fallback: localizedProjectionText(presentationBinding.language, {
            zh: `决策类型“${input.kind}”尚未接入 Session DecisionResolver。`,
            en: diagnostic.fallback,
            neutral: `decision_kind=${input.kind} resolver=unavailable`,
          }),
        },
        this.ports.now(),
        this.ports.createId('decision-unsupported'),
        presentationBinding
      ),
    ]);
    return { kind: 'unsupportedDecisionKind', decisionKind: input.kind, result };
  }

  private async settle(
    input: DecisionResolverInput,
    control: SessionLoopControlResult
  ): Promise<AgentSessionResult> {
    if (control.kind === 'return') {
      return this.settlePendingFreeformAuthority(input, control.result);
    }
    if (control.kind === 'resume') return this.ports.resume(control.input);
    if (input.kind === 'permission' && input.admittedFreeformAuthority) {
      this.validatedFreeformAuthority(
        input,
        control.request.result,
        control.request.runId
      );
      return this.ports.assembleReview(control.request);
    }
    const settled = await this.settlePendingFreeformAuthority(input, control.request.result);
    return this.ports.assembleReview({
      ...control.request,
      result: settled,
    });
  }

  private async settlePendingFreeformAuthority(
    input: DecisionResolverInput,
    current: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const admitted = input.admittedFreeformAuthority;
    if (!admitted) return current;
    const { authority, policy } = this.validatedFreeformAuthority(input, current);
    if (policy.status !== 'pending') return current;
    return this.ports.append(input.sessionId, [
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
  }

  private validatedFreeformAuthority(
    input: DecisionResolverInput,
    current: AgentSessionResult,
    expectedRunId?: string
  ): {
    authority: NonNullable<ReturnType<typeof latestSessionTurnAuthority>>;
    policy: ReturnType<typeof resolveConversationLanguagePolicy>;
  } {
    const admitted = input.admittedFreeformAuthority;
    if (!admitted) {
      throw this.ports.createError(
        'session_turn_authority_invalid',
        'Free-text decision authority admission is missing.'
      );
    }
    if (expectedRunId && admitted.runId !== expectedRunId) {
      throw this.ports.createError(
        'session_turn_authority_invalid',
        `Free-text permission authority run ${admitted.runId} does not match review run ${expectedRunId}.`
      );
    }
    const authority = latestSessionTurnAuthority(current.events, admitted.runId);
    if (
      !authority
      || authority.turnId !== admitted.turnId
      || authority.languagePolicy.revision !== admitted.revision
      || authority.languagePolicy.hostLanguage !== admitted.hostLanguage
      || !authority.sourceMessageIds.includes(admitted.messageId)
    ) {
      throw this.ports.createError(
        'session_turn_authority_invalid',
        'Free-text decision authority no longer matches the admitted revision.'
      );
    }
    const policy = resolveConversationLanguagePolicy(current.events, authority);
    if (policy.status === 'superseded') {
      throw this.ports.createError(
        'session_turn_authority_invalid',
        'Free-text decision authority was superseded before local settlement.'
      );
    }
    return { authority, policy };
  }

  private async admitFreeformGuidance(input: DecisionResolverInput): Promise<DecisionResolverInput> {
    const guidance = input.guidance?.trim();
    if (!guidance) return input;
    const current = await this.ports.append(input.sessionId, []);
    const events = current.events.length ? current.events : input.existingEvents ?? [];
    const exactTarget = this.ports.exactDecisionTarget(input, events);
    if (!exactTarget) {
      throw this.ports.createError(
        'session_decision_target_invalid',
        'Free-text decision guidance requires the exact active interaction run and target identity.'
      );
    }
    const admittedInput = {
      ...input,
      runId: exactTarget.runId,
      targetId: exactTarget.targetId,
    };
    const authority = latestSessionTurnAuthority(events, exactTarget.runId);
    if (!authority) {
      const code = hasLegacySessionTurnAuthority(events, input.runId)
        ? 'session_language_policy_unavailable'
        : 'session_turn_authority_unavailable';
      throw this.ports.createError(
        code,
        code === 'session_language_policy_unavailable'
          ? 'This Session uses turn authority v1 and cannot continue without ConversationLanguagePolicy v1.'
          : 'A free-text decision requires a persisted CurrentTurnAuthority binding.'
      );
    }
    const messageId = this.ports.createId('decision-guidance-user');
    const userMessage: AgentEvent = {
      id: messageId,
      sessionId: input.sessionId,
      ts: this.ports.now(),
      kind: 'user_msg',
      payload: {
        content: guidance,
        source: 'decisionGuidance',
        decisionKind: admittedInput.kind,
        targetId: exactTarget.targetId,
        targetRunId: exactTarget.runId,
        channel: 'user',
        visibility: 'conversation',
      },
    };
    const turnId = this.ports.createId('session-turn');
    const hostLanguage = normalizeHostLanguage(input.hostLanguage);
    const revision = nextConversationLanguageRevision(events);
    const authorityEvent = createSessionTurnAuthorityEvent({
      sessionId: input.sessionId,
      runId: exactTarget.runId,
      turnId,
      taskId: authority.taskId,
      messages: [{ messageId, content: guidance }],
      relation: 'interactionContinuation',
      boundAtHookRef: `interaction.${admittedInput.kind}.decisionGuidance`,
      languageRevision: revision,
      hostLanguage,
      promptEpochId: authority.promptEpochId,
      eventId: this.ports.createId('session-turn-authority'),
      timestamp: this.ports.now(),
    });
    const superseded = resolveConversationLanguagePolicy(events, authority).status === 'pending'
      ? [createSessionLanguageDecisionEvent({
          sessionId: authority.sessionId,
          runId: authority.runId,
          turnId: authority.turnId,
          revision: authority.languagePolicy.revision,
          status: 'superseded',
          decisionSource: 'supersededByLaterUserInput',
          eventId: this.ports.createId('session-language-superseded'),
          timestamp: this.ports.now(),
        })]
      : [];
    const appended = await this.ports.append(input.sessionId, [
      userMessage,
      ...superseded,
      authorityEvent,
    ]);
    return {
      ...admittedInput,
      existingEvents: appended.events,
      admittedFreeformAuthority: {
        messageId,
        runId: exactTarget.runId,
        turnId,
        revision,
        hostLanguage,
      },
    };
  }
}
