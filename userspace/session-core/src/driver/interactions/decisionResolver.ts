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
import type { InterventionLevel, ReviewContinuationMode } from '../types.js';

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
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: DecisionResolverReviewContinuationMode;
  interventionLevel?: DecisionResolverInterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
}

export interface DecisionResolverDiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export interface DecisionResolverPorts {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  finalDiagnosticEvent(sessionId: string, content: string | DecisionResolverDiagnosticInfo, ts: string, id: string): AgentEvent;
  missingDecisionKindMessage(kind: string): string | DecisionResolverDiagnosticInfo;
  requirementHandler: RequirementDecisionHandler;
  planHandler: PlanDecisionHandler;
  permissionHandler: PermissionDecisionHandler;
  reviewHandler: ReviewDecisionHandler;
}

export class DecisionResolver {
  constructor(private readonly ports: DecisionResolverPorts) {}

  async resolve(input: DecisionResolverInput): Promise<AgentSessionResult> {
    if (input.kind === 'requirement') {
      return this.ports.requirementHandler.resolve({
        sessionId: input.sessionId,
        decision: input.decision,
        guidance: input.guidance,
        runId: input.runId,
        targetId: input.targetId,
        existingEvents: input.existingEvents,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
        interactionOverlay: input.interactionOverlay,
      });
    }
    if (input.kind === 'plan') {
      return this.ports.planHandler.resolve({
        sessionId: input.sessionId,
        decision: input.decision,
        guidance: input.guidance,
        runId: input.runId,
        targetId: input.targetId,
        existingEvents: input.existingEvents,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
        interactionOverlay: input.interactionOverlay,
      });
    }
    if (input.kind === 'permission') {
      return this.ports.permissionHandler.resolve({
        sessionId: input.sessionId,
        decision: input.decision,
        runId: input.runId,
        targetId: input.targetId,
        existingEvents: input.existingEvents,
      });
    }
    if (input.kind === 'review') {
      return this.ports.reviewHandler.resolve({
        sessionId: input.sessionId,
        decision: input.decision,
        guidance: input.guidance,
        runId: input.runId,
        existingEvents: input.existingEvents,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
      });
    }
    return this.ports.append(input.sessionId, [
      this.ports.finalDiagnosticEvent(
        input.sessionId,
        this.ports.missingDecisionKindMessage(input.kind),
        this.ports.now(),
        this.ports.createId('decision-unsupported')
      ),
    ]);
  }
}
