import type { AgentContextAttachment, AgentEvent, AgentSessionResult, AgentWorkspaceBinding } from '@deepcode/protocol';
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
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  reviewContinuationMode?: ReviewContinuationMode;
  resumeResourcePackets?: boolean;
  confirmedRequirement?: RequirementRecord;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export interface AcceptedPlanContinuationOverride extends DecisionContinuationOverride {
  acceptedImplementationPlan: AcceptedImplementationPlanContext;
}

export class SameLoopContinuation<Input> {
  constructor(private readonly resume: (input: Input) => Promise<AgentSessionResult>) {}

  readonly resumeUserTurn = (input: Input): Promise<AgentSessionResult> => this.resume(input);

  readonly runUserTurn = (input: Input): Promise<AgentSessionResult> => this.resume(input);
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
    workspaceBinding,
    projectWorkingDirectory,
    reviewContinuationMode,
    resumeResourcePackets,
    confirmedRequirement,
    acceptedImplementationPlan,
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
