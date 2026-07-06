import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  KernelToolCatalogSnapshot,
  LlmChatRequest,
  LlmChatResult,
  LlmChatStreamEvent,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ProjectWorkingDirectory } from '../context/types.js';
import type { AcceptedImplementationPlanContext } from './execution/index.js';
import type { InteractionOverlayContext } from './pipelines/interactionOverlayCodec.js';
import type { ProposalEnvelope } from '../protocol/types.js';
import type { PromptEnvelope } from '../prompt/types.js';
import type { ProjectMemoryMode } from '../context/index.js';
import type { RequirementRecord } from '../requirement/types.js';
import type { TranscriptEntry } from '../transcript.js';

export type EntryIntent = 'readOnlyAnswer' | 'resourceDiscovery' | 'developmentTask' | 'repairLoop';

export interface SessionUserTurn {
  sessionId: string;
  parentUuid?: string;
  content: string;
  attachments?: AgentContextAttachment[];
}

export interface KernelStateContractRef {
  runId: string;
  stateId: string;
  stateKind: string;
  allowedInputs: string[];
  allowedProposals: string[];
  proposalSchemaRefs: string[];
  capabilityProjection: string[];
  toolCatalogRef?: string;
  toolCatalogHash?: string;
  toolCatalogSnapshot?: KernelToolCatalogSnapshot;
}

export interface DriverRequestRef {
  id: string;
  runId: string;
  sessionId?: string;
  kind: string;
  reason: string;
  stateContract?: KernelStateContractRef;
}

export interface SessionTurnFrame {
  sessionId: string;
  userTurn: SessionUserTurn;
  entryIntent: EntryIntent;
  driverRequest?: DriverRequestRef;
  stateContract?: KernelStateContractRef;
  promptEnvelope?: PromptEnvelope;
  proposalEnvelope?: ProposalEnvelope;
  projectionFrames: unknown[];
  status: 'created' | 'awaitingKernel' | 'awaitingProvider' | 'awaitingUser' | 'completed' | 'blocked';
}

export interface SessionDriverInput extends SessionUserTurn {
  stateContract?: KernelStateContractRef;
  driverRequest?: DriverRequestRef;
  repairRequested?: boolean;
  requestedResources?: boolean;
  explicitDevelopmentTask?: boolean;
}

export interface SessionDriverLoopPorts {
  appendEvents(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  appendTranscript?: (sessionId: string, entry: TranscriptEntry) => Promise<void>;
  kernelCommand(request: KernelCommandEnvelope): Promise<KernelReply>;
  llmChat(request: LlmChatRequest): Promise<ApiResponse<LlmChatResult>>;
  llmChatStream?: (
    request: LlmChatRequest,
    onEvent: (event: LlmChatStreamEvent) => void | Promise<void>
  ) => Promise<ApiResponse<LlmChatResult>>;
  onProjectionDelta?: (delta: ProjectionDelta) => void | Promise<void>;
  now?: () => string;
  createId?: (prefix: string) => string;
}

export interface SessionDriverLoopInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  appendUserMessage?: boolean;
  confirmedRequirement?: RequirementRecord;
  requirementConfirmationMode?: RequirementConfirmationMode;
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export type RequirementConfirmationMode = 'auto' | 'always' | 'off';
export type ReviewContinuationMode = 'auto' | 'ask' | 'off';
export type InterventionLevel = 'low' | 'medium' | 'high';

export interface SessionDecisionResolverInput {
  sessionId: string;
  kind: 'requirement' | 'plan' | 'review' | 'permission' | 'boundary';
  decision: 'accept' | 'reject' | 'revise';
  guidance?: string;
  runId?: string;
  targetId?: string;
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
}
