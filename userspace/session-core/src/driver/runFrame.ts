import type { LlmChatResult } from '@deepcode/protocol';
import type {
  ContextAssemblyRecord,
  PromptCachePlan,
  SessionMemoryDocument,
} from '../context/index.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ResourceManifest,
  ResourcePacket,
} from '../context/types.js';
import type {
  AcceptedImplementationPlanContext,
  CurrentTaskContext,
  ImplementationBatchContext,
  TaskExecutionCursor,
} from './execution/index.js';
import type { PromptEnvelope } from '../prompt/types.js';
import type { AcceptedPlanPromptFrame, TaskLedgerSnapshot } from '../run-state/index.js';
import type {
  NativeToolCallProposal,
  NativeToolReadLedgerEntry,
  ProviderPartFrameParser,
} from '../provider/providerStreamParts.js';
import type { GeneratedArtifactEvidence } from './context/index.js';
import type { InteractionOverlayContext, SessionTurnPhase } from './pipelines/interactionOverlayCodec.js';
import type { DriverRequestRef, KernelStateContractRef } from './types.js';

export interface RunFrame {
  readonly sessionId: string;
  readonly runId: string;
}

export type ProviderTurnMode =
  | 'planning'
  | 'requirementDecision'
  | 'acceptedTaskExecution'
  | 'protocolRepair'
  | 'resourceResume'
  | 'scopeIntervention'
  | 'reviewAnswer';

export type ProviderFrameSource =
  | 'system'
  | 'protocol'
  | 'memory'
  | 'user'
  | 'decision'
  | 'session'
  | 'kernel'
  | 'derived'
  | 'error';

export type ProviderFrameTrust =
  | 'contract'
  | 'compressedReference'
  | 'userConfirmedFact'
  | 'kernelObservedFact'
  | 'derivedObservedFact'
  | 'sessionInstruction'
  | 'diagnostic';

export type ProviderRepairPolicy =
  | 'sameKindOnly'
  | 'deterministicIntervention'
  | 'diagnosticOnly';

export type ProviderProjectionVisibility =
  | 'conversation'
  | 'traceOnly'
  | 'developerOnly';

export interface ProviderContextFrame {
  readonly kind: string;
  readonly source: ProviderFrameSource;
  readonly trust: ProviderFrameTrust;
  readonly scope?: string;
  readonly use: string;
  readonly summary?: string;
  readonly refs?: string[];
  readonly data?: unknown;
}

export interface ToolIntentTemplate {
  readonly intentId: string;
  readonly label: string;
  readonly operation: string;
  readonly targets: string[];
  readonly evidencePolicy?: string;
}

export interface DriverProviderTurnFrame {
  readonly schemaVersion: 'deepcode.session.provider-turn-contract.v1';
  readonly contractId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnMode: ProviderTurnMode;
  readonly allowedKinds: string[];
  readonly requiredKind?: string;
  readonly frames: ProviderContextFrame[];
  readonly toolIntentTemplates: ToolIntentTemplate[];
  readonly repairPolicy: ProviderRepairPolicy;
  readonly projectionVisibility: ProviderProjectionVisibility;
  readonly nextActionInstruction: ProviderContextFrame;
  readonly prompt: PromptEnvelope;
  readonly contextAssembly?: ContextAssemblyRecord;
}

export interface SessionDriverLoopRunState {
  sessionId: string;
  runId: string;
  userRequest: string;
  phase: SessionTurnPhase;
  workspaceScopeKey: string;
  stateContract?: KernelStateContractRef;
  driverRequest?: DriverRequestRef;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  initialContext: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  generatedArtifactEvidence: Map<string, GeneratedArtifactEvidence>;
  memoryDocument: SessionMemoryDocument;
  memoryHints: string[];
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshot;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
  providerTurnFrame?: DriverProviderTurnFrame;
  implementationBatch: ImplementationBatchContext;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  resourceRequestRepairAttempted: boolean;
  actionBundleAdmissionRepairAttempted: boolean;
  planReviewRepairAttempted: boolean;
  acceptedPlanScopeRepairAttempted: boolean;
  terminalGuidanceRevisionAttempted: boolean;
  nativeToolReadLedger: Map<string, NativeToolReadLedgerEntry>;
  nativeToolDuplicateRepairAttempted: boolean;
  activeTurn?: ActiveTurnState;
  interactionOverlay?: InteractionOverlayContext;
}

export interface ActiveTurnState {
  turnId: string;
  seq: number;
  stage: string;
  providerCallId?: string;
  partFrameParser?: ProviderPartFrameParser;
  providerJsonStreamProgress?: Record<string, {
    receivedChars: number;
    lastEmittedChars: number;
  }>;
}

export interface LlmTurnResult {
  result: LlmChatResult;
  content: string;
  reasoning: string;
  toolCalls: NativeToolCallProposal[];
}
