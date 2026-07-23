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

export type DecisionResolverKind = 'requirement' | 'plan' | 'review' | 'permission' | 'boundary';
export type DecisionResolverDecision = 'accept' | 'reject' | 'revise';
export type DecisionResolverReviewContinuationMode = ReviewContinuationMode;
export type DecisionResolverInterventionLevel = InterventionLevel;

export interface DecisionResolverInput {
  sessionId: string;
  kind: DecisionResolverKind;
  decision: DecisionResolverDecision;
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
  reviewContinuationMode?: DecisionResolverReviewContinuationMode;
  interventionLevel?: DecisionResolverInterventionLevel;
  autonomyMode?: AutonomyMode;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
  hostLanguage?: ConversationLanguage;
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
  finalDiagnosticEvent(sessionId: string, content: string | DecisionResolverDiagnosticInfo, ts: string, id: string): AgentEvent;
  missingDecisionKindMessage(kind: string): string | DecisionResolverDiagnosticInfo;
  createError(code: string, message: string): Error;
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
    const input = await this.admitFreeformGuidance(command.input);
    if (input.kind === 'requirement') {
      const result = await this.settle(await this.ports.requirementHandler.resolve({
        sessionId: input.sessionId,
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
      }));
      return { kind: 'decisionRouted', decisionKind: 'requirement', result };
    }
    if (input.kind === 'plan') {
      const result = await this.settle(await this.ports.planHandler.resolve({
        sessionId: input.sessionId,
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
      }));
      return { kind: 'decisionRouted', decisionKind: 'plan', result };
    }
    if (input.kind === 'permission') {
      const result = await this.settle(await this.ports.permissionHandler.resolve({
        sessionId: input.sessionId,
        decision: input.decision,
        runId: input.runId,
        targetId: input.targetId,
        existingEvents: input.existingEvents,
      }));
      return { kind: 'decisionRouted', decisionKind: 'permission', result };
    }
    if (input.kind === 'review') {
      const result = await this.settle(await this.ports.reviewHandler.resolve({
        sessionId: input.sessionId,
        decision: input.decision,
        guidance: input.guidance,
        runId: input.runId,
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
    const result = await this.ports.append(input.sessionId, [
      this.ports.finalDiagnosticEvent(
        input.sessionId,
        this.ports.missingDecisionKindMessage(input.kind),
        this.ports.now(),
        this.ports.createId('decision-unsupported')
      ),
    ]);
    return { kind: 'unsupportedDecisionKind', decisionKind: input.kind, result };
  }

  private settle(control: SessionLoopControlResult): Promise<AgentSessionResult> {
    if (control.kind === 'return') return Promise.resolve(control.result);
    if (control.kind === 'resume') return this.ports.resume(control.input);
    return this.ports.assembleReview(control.request);
  }

  private async admitFreeformGuidance(input: DecisionResolverInput): Promise<DecisionResolverInput> {
    const guidance = input.guidance?.trim();
    if (!guidance) return input;
    const current = await this.ports.append(input.sessionId, []);
    const events = current.events.length ? current.events : input.existingEvents ?? [];
    const authority = latestSessionTurnAuthority(events, input.runId);
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
        decisionKind: input.kind,
        targetId: input.targetId,
        targetRunId: input.runId ?? authority.runId,
        channel: 'user',
        visibility: 'conversation',
      },
    };
    const turnId = this.ports.createId('session-turn');
    const authorityEvent = createSessionTurnAuthorityEvent({
      sessionId: input.sessionId,
      runId: input.runId ?? authority.runId,
      turnId,
      taskId: authority.taskId,
      messages: [{ messageId, content: guidance }],
      relation: 'interactionContinuation',
      boundAtHookRef: `interaction.${input.kind}.decisionGuidance`,
      languageRevision: nextConversationLanguageRevision(events),
      hostLanguage: normalizeHostLanguage(input.hostLanguage),
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
      ...input,
      existingEvents: appended.events,
    };
  }
}
