import type { AgentContextAttachment, AgentEvent, AgentSessionResult, AgentWorkspaceBinding } from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../context/index.js';
import type { ProjectWorkingDirectory } from '../context/types.js';
import type { RequirementRecord } from '../requirement/types.js';
import type { AcceptedTaskPlanContext } from './execution/index.js';
import type { InteractionOverlayContext } from './pipelines/interactionOverlayCodec.js';
import type {
  AcceptedPlanReviewHandoffPlan,
  AcceptedPlanReviewHandoffRunInput,
} from './review/acceptedPlanReviewHandoffCoordinator.js';
import type { AutonomyMode, InterventionLevel, ReviewContinuationMode } from './types.js';

export interface DecisionContinuationSource {
  sessionId: string;
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  projectId?: string;
  projectKind?: 'folder' | 'blank';
  projectRootStatus?: 'ready' | 'unbound' | 'unavailable';
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
  autonomyMode?: AutonomyMode;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
}

export interface SessionLoopResumeInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  projectId?: string;
  projectKind?: 'folder' | 'blank';
  projectRootStatus?: 'ready' | 'unbound' | 'unavailable';
  profileId?: string;
  workflow?: string;
  appendUserMessage: false;
  confirmedRequirement?: RequirementRecord;
  requirementConfirmationMode: 'off' | 'always';
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
  autonomyMode?: AutonomyMode;
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export type SessionLoopControlResult =
  | { readonly kind: 'return'; readonly result: AgentSessionResult }
  | { readonly kind: 'resume'; readonly input: SessionLoopResumeInput }
  | {
    readonly kind: 'assembleReview';
    readonly request: AcceptedPlanReviewHandoffRunInput<AcceptedPlanReviewHandoffPlan>;
  };

export function returnSessionResult(result: AgentSessionResult): SessionLoopControlResult {
  return { kind: 'return', result };
}

export interface DecisionContinuationOverride {
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  reviewContinuationMode?: ReviewContinuationMode;
  resumeResourcePackets?: boolean;
  confirmedRequirement?: RequirementRecord;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export interface AcceptedPlanContinuationOverride extends DecisionContinuationOverride {
  acceptedTaskPlan: AcceptedTaskPlanContext;
}

export type DecisionContinuationInput<Extra extends object = Record<string, never>> = {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  projectId?: string;
  projectKind?: 'folder' | 'blank';
  projectRootStatus?: 'ready' | 'unbound' | 'unavailable';
  profileId?: string;
  workflow?: string;
  appendUserMessage: false;
  requirementConfirmationMode: 'off';
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
  autonomyMode?: AutonomyMode;
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  confirmedRequirement?: RequirementRecord;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  interactionOverlay?: InteractionOverlayContext;
} & Extra;

export function decisionContinuationInput<Extra extends object = Record<string, never>>(
  source: DecisionContinuationSource,
  override: DecisionContinuationOverride & Extra
): DecisionContinuationInput<Extra> {
  const {
    content,
    attachments,
    existingEvents,
    workspaceBinding,
    projectWorkingDirectory,
    reviewContinuationMode,
    resumeResourcePackets,
    confirmedRequirement,
    acceptedTaskPlan,
    interactionOverlay,
    ...extra
  } = override;
  const hasWorkspaceBindingOverride = hasOwnProperty(override, 'workspaceBinding');
  const hasProjectWorkingDirectoryOverride = hasOwnProperty(override, 'projectWorkingDirectory');
  return {
    ...extra,
    sessionId: source.sessionId,
    content,
    attachments: attachments ?? [],
    existingEvents,
    workspaceBinding: hasWorkspaceBindingOverride ? workspaceBinding : source.workspaceBinding,
    projectWorkingDirectory: hasProjectWorkingDirectoryOverride ? projectWorkingDirectory : source.projectWorkingDirectory,
    projectId: source.projectId,
    projectKind: source.projectKind,
    projectRootStatus: source.projectRootStatus,
    profileId: source.profileId,
    workflow: source.workflow,
    appendUserMessage: false,
    requirementConfirmationMode: 'off',
    reviewContinuationMode: reviewContinuationMode ?? source.reviewContinuationMode,
    interventionLevel: source.interventionLevel,
    autonomyMode: source.autonomyMode,
    projectMemoryMode: source.projectMemoryMode,
    resumeResourcePackets,
    confirmedRequirement,
    acceptedTaskPlan,
    interactionOverlay: interactionOverlay ?? source.interactionOverlay,
  } as DecisionContinuationInput<Extra>;
}

export function acceptedPlanContinuationInput<Extra extends object = Record<string, never>>(
  source: DecisionContinuationSource,
  override: AcceptedPlanContinuationOverride & Extra
): DecisionContinuationInput<Extra> {
  return decisionContinuationInput(source, {
    ...override,
    resumeResourcePackets: override.resumeResourcePackets ?? true,
  });
}

function hasOwnProperty(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
