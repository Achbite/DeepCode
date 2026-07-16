import type {
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
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
    const input = command.input;
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
}
