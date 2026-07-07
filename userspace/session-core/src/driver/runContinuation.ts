import type { AgentContextAttachment, AgentEvent, AgentWorkspaceBinding } from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../context/index.js';
import type { ProjectWorkingDirectory } from '../context/types.js';
import type { RequirementRecord } from '../requirement/types.js';
import type { AcceptedImplementationPlanContext } from './execution/index.js';
import type { InteractionOverlayContext } from './pipelines/interactionOverlayCodec.js';
import type { InterventionLevel, ReviewContinuationMode } from './types.js';

export interface DecisionContinuationSource {
  sessionId: string;
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
}

export interface DecisionContinuationOverride {
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  reviewContinuationMode?: ReviewContinuationMode;
  resumeResourcePackets?: boolean;
  confirmedRequirement?: RequirementRecord;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export type DecisionContinuationInput<Extra extends object = Record<string, never>> = {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  appendUserMessage: false;
  requirementConfirmationMode: 'off';
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  confirmedRequirement?: RequirementRecord;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
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
    reviewContinuationMode,
    resumeResourcePackets,
    confirmedRequirement,
    acceptedImplementationPlan,
    interactionOverlay,
    ...extra
  } = override;
  return {
    ...extra,
    sessionId: source.sessionId,
    content,
    attachments: attachments ?? [],
    existingEvents,
    workspaceBinding: source.workspaceBinding,
    projectWorkingDirectory: source.projectWorkingDirectory,
    profileId: source.profileId,
    workflow: source.workflow,
    appendUserMessage: false,
    requirementConfirmationMode: 'off',
    reviewContinuationMode: reviewContinuationMode ?? source.reviewContinuationMode,
    interventionLevel: source.interventionLevel,
    projectMemoryMode: source.projectMemoryMode,
    resumeResourcePackets,
    confirmedRequirement,
    acceptedImplementationPlan,
    interactionOverlay: interactionOverlay ?? source.interactionOverlay,
  } as DecisionContinuationInput<Extra>;
}
