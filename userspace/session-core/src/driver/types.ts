import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  ConversationLanguage,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  KernelToolCatalogSnapshot,
  LlmChatRequest,
  LlmChatResult,
  LlmChatStreamEvent,
  ProjectionDelta,
  SessionGoalPendingEffectV1,
  SessionProviderAdmissionMetadataV1,
} from '@deepcode/protocol';
import type { ProjectWorkingDirectory } from '../context/types.js';
import type { AcceptedTaskPlanContext } from './execution/index.js';
import type { InteractionOverlayContext } from './pipelines/interactionOverlayCodec.js';
import type { ProposalEnvelope } from '../protocol/types.js';
import type { PromptEnvelope } from '../prompt/types.js';
import type { ProjectMemoryMode } from '../context/index.js';
import type { RequirementRecord } from '../requirement/types.js';
import type {
  InterventionLevel,
  AutonomyMode,
  RequirementConfirmationMode,
  ReviewContinuationMode,
} from '../sessionModes.js';
import type { TranscriptEntry } from '../transcript.js';
import type { PromptLedgerWireRecord } from '../prompt/promptLedger.js';
import type {
  ProviderAnalysisTimelineAppendResult,
  ProviderAnalysisTimelineEvent,
  ProviderAnalysisTimelineRecord,
} from '../provider/ProviderAnalysisTimeline.js';
import type { SessionGoalOperationContext } from '../goal/index.js';

export type {
  InterventionLevel,
  AutonomyMode,
  RequirementConfirmationMode,
  ReviewContinuationMode,
} from '../sessionModes.js';

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
  draftAdmissionPolicy?: {
    maxTotalUtf8Bytes: number;
  };
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
  analysisTimelineRequired?: boolean;
  providerResponseIdentityRequired?: boolean;
  wireLedgerRequired?: boolean;
  appendEvents(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  appendTranscript?: (sessionId: string, entry: TranscriptEntry) => Promise<void>;
  loadWireLedger?: (sessionId: string) => Promise<PromptLedgerWireRecord[]>;
  appendWireLedger?: (sessionId: string, entries: PromptLedgerWireRecord[]) => Promise<void>;
  appendCacheTelemetry?: (sessionId: string, entry: Record<string, unknown>) => Promise<void>;
  appendAnalysisTimeline?: (
    sessionId: string,
    entries: ProviderAnalysisTimelineEvent[]
  ) => Promise<ProviderAnalysisTimelineAppendResult>;
  loadAnalysisTimelineRecord?: (
    sessionId: string,
    recordId: string
  ) => Promise<ProviderAnalysisTimelineRecord>;
  registerProviderAdmission?: (
    sessionId: string,
    metadata: SessionProviderAdmissionMetadataV1
  ) => void | Promise<void>;
  bindProviderProposalAdmission?: (
    sessionId: string,
    proposalId: string,
    providerRequestId: string
  ) => void | Promise<void>;
  kernelCommand(request: KernelCommandEnvelope): Promise<KernelReply>;
  llmChat(
    request: LlmChatRequest,
    signal?: AbortSignal
  ): Promise<ApiResponse<LlmChatResult>>;
  llmChatStream?: (
    request: LlmChatRequest,
    onEvent: (event: LlmChatStreamEvent) => void | Promise<void>,
    onEvents?: (events: readonly LlmChatStreamEvent[]) => void | Promise<void>,
    signal?: AbortSignal
  ) => Promise<ApiResponse<LlmChatResult>>;
  onProjectionDelta?: (delta: ProjectionDelta) => void | Promise<void>;
  now?: () => string;
  createId?: (prefix: string) => string;
}

export interface SessionDriverLoopInput {
  sessionId: string;
  hostRunId?: string;
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
  appendUserMessage?: boolean;
  confirmedRequirement?: RequirementRecord;
  requirementConfirmationMode?: RequirementConfirmationMode;
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
  autonomyMode?: AutonomyMode;
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  interactionOverlay?: InteractionOverlayContext;
  hostLanguage?: ConversationLanguage;
  bootstrapEvents?: AgentEvent[];
  goalContext?: SessionGoalOperationContext;
  /** Internal recovery input; never accepted directly from Host JSON. */
  goalPendingEffect?: SessionGoalPendingEffectV1;
  /** Recovered from the exact private analysis record referenced by goalPendingEffect. */
  goalRecoveredProposal?: ProposalEnvelope;
}

export interface SessionDecisionResolverInput {
  sessionId: string;
  hostRunId?: string;
  kind: 'requirement' | 'plan' | 'review' | 'permission' | 'boundary';
  decision: 'accept' | 'reject' | 'revise';
  guidance?: string;
  runId?: string;
  targetId?: string;
  interactionId?: string;
  interactionRevision?: string;
  decisionRequestId?: string;
  reviewId?: string;
  existingEvents?: AgentEvent[];
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
  hostLanguage?: ConversationLanguage;
  bootstrapEvents?: AgentEvent[];
  goalContext?: SessionGoalOperationContext;
}
