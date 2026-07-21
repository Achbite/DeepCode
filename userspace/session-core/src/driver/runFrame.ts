import type { AgentEvent, AgentWorkspaceBinding, LlmChatRequest, LlmChatResult } from '@deepcode/protocol';
import type {
  ContextAssemblyRecord,
  ContextAssemblyTaskLocalCompactRecord,
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
  AcceptedTaskPlanContext,
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
import type { SessionSemanticDraftStreamRecord } from '../provider/SessionSemanticDraftDecoder.js';
import type { GeneratedArtifactEvidence } from './context/index.js';
import type { HookResult } from './hooks/hookResult.js';
import type { InteractionOverlayContext, SessionTurnPhase } from './pipelines/interactionOverlayCodec.js';
import type { DriverRequestRef, KernelStateContractRef } from './types.js';
import type { UserAuthorityFrame } from './context/userAuthorityFrame.js';
import type {
  PromptLedgerState,
  ProviderRequestCacheHistoryEntry,
} from '../prompt/promptLedger.js';
import type { ArtifactDraftLease } from './execution/artifactDraftLedger.js';
import type { AcceptedTaskReplanReason } from './execution/artifactDraftReplanCoordinator.js';
import type { PendingAcceptedTaskOutcomeReview } from './execution/acceptedTaskOutcomeCoordinator.js';

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
  readonly template?: unknown;
}

export interface ProviderTurnSnapshotSegment {
  readonly id: string;
  readonly name: string;
  readonly cacheClass: string;
  readonly stablePrefix: boolean;
  readonly auditOnly: boolean;
  readonly contentHash: string;
  readonly charLength: number;
}

export interface ProviderTurnSnapshotDynamicAppendLogEntry {
  readonly index: number;
  readonly segmentId: string;
  readonly name: string;
  readonly cacheClass: string;
  readonly partitionName: string;
  readonly foldPolicy: string;
  readonly contentHash: string;
  readonly renderedHash: string;
  readonly charLength: number;
  readonly renderedCharLength: number;
}

export interface ProviderTurnSnapshotDynamicAppendFoldSummary {
  readonly policy: string;
  readonly segmentCount: number;
  readonly renderedCharLength: number;
  readonly contentHash: string;
  readonly renderedHash: string;
  readonly segmentIds: string[];
}

export interface ProviderTurnSnapshotTaskLocalFoldPlan {
  readonly schemaVersion: 'deepcode.session.context-task-fold.v1';
  readonly taskCursorId?: string;
  readonly lastTaskSavepointId?: string;
  readonly currentTaskGoalHash?: string;
  readonly currentTaskContextHash?: string;
  readonly dynamicAppendLogHash: string;
  readonly foldableSegmentCount: number;
  readonly foldableRenderedCharLength: number;
  readonly retainedSegmentCount: number;
  readonly retainedRenderedCharLength: number;
  readonly policySummaries: ProviderTurnSnapshotDynamicAppendFoldSummary[];
  readonly boundary: 'metadataOnlyNoPromptMutation';
}

export interface ProviderTurnSnapshotFrame {
  readonly index: number;
  readonly kind: string;
  readonly source: ProviderFrameSource;
  readonly trust: ProviderFrameTrust;
  readonly scope?: string;
  readonly useCharLength: number;
  readonly useHash: string;
  readonly dynamicUseOverlapCharLength: number;
  readonly summaryCharLength: number;
  readonly summaryHash?: string;
  readonly dynamicSummaryOverlapCharLength: number;
  readonly refsCount: number;
  readonly dataHash?: string;
  readonly currentTaskEvidenceLineCount: number;
  readonly currentTaskEvidenceCoveredCount: number;
  readonly currentTaskEvidenceUncoveredCount: number;
  readonly currentTaskEvidenceFullTextCount: number;
  readonly currentTaskEvidenceTargets: string[];
  readonly currentTaskEvidenceMatchedRefs: string[];
}

export interface ProviderTurnSnapshotResourceBlock {
  readonly index: number;
  readonly blockKey: string;
  readonly displayRef: string;
  readonly retention: string;
  readonly status: string;
  readonly readPolicy: string;
  readonly contentHash: string;
  readonly charLength: number;
  readonly summaryCharLength: number;
  readonly fullTextCharLength: number;
}

export interface ProviderTurnSnapshot {
  readonly schemaVersion: 'deepcode.session.provider-turn-snapshot.v1';
  readonly contractId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnMode: ProviderTurnMode;
  readonly allowedKinds: string[];
  readonly requiredKind?: string;
  readonly repairPolicy: ProviderRepairPolicy;
  readonly projectionVisibility: ProviderProjectionVisibility;
  readonly semanticProfileId: string;
  readonly systemHash: string;
  readonly toolSchemaHash: string;
  readonly responseFormatHash: string;
  readonly messageShapeHash: string;
  readonly stablePrefixHash: string;
  readonly dynamicSuffixHash: string;
  readonly stablePrefixCharLength: number;
  readonly dynamicSuffixCharLength: number;
  readonly finalUserPromptHash: string;
  readonly finalUserPromptCharLength: number;
  readonly providerTurnContractHash: string;
  readonly providerTurnContractCharLength: number;
  readonly dynamicDialogueSummaryHash?: string;
  readonly dynamicDialogueSummaryCharLength: number;
  readonly dynamicDialogueDynamicSuffixOccurrences: number;
  readonly dynamicDialogueFrameTextOccurrences: number;
  readonly dynamicFrameOverlapCharLength: number;
  readonly dynamicFrameOverlapRatio: number;
  readonly currentTaskEvidenceLineCount: number;
  readonly currentTaskEvidenceCoveredCount: number;
  readonly currentTaskEvidenceUncoveredCount: number;
  readonly currentTaskEvidenceFullTextCount: number;
  readonly currentTaskEvidenceTargets: string[];
  readonly currentTaskEvidenceMatchedRefs: string[];
  readonly segmentOrder: string[];
  readonly segments: ProviderTurnSnapshotSegment[];
  readonly dynamicAppendLog: ProviderTurnSnapshotDynamicAppendLogEntry[];
  readonly dynamicAppendLogHash?: string;
  readonly dynamicAppendLogCharLength: number;
  readonly taskLocalFoldPlan?: ProviderTurnSnapshotTaskLocalFoldPlan;
  readonly taskLocalFoldPlanHash?: string;
  readonly taskLocalCompactRecords: ContextAssemblyTaskLocalCompactRecord[];
  readonly taskLocalCompactRecordCount: number;
  readonly taskLocalCompactRecordsHash?: string;
  readonly latestTaskLocalCompactHash?: string;
  readonly frames: ProviderTurnSnapshotFrame[];
  readonly resourceBlocks: ProviderTurnSnapshotResourceBlock[];
  readonly resourceRetentionCounts: Record<string, number>;
  readonly cacheClasses: Record<string, number>;
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
  readonly snapshot?: ProviderTurnSnapshot;
  readonly hookTrace?: readonly HookResult[];
  readonly providerMessages?: LlmChatRequest['messages'];
  readonly promptLedgerEpochId?: string;
  readonly promptLedgerEpochScopeKey?: string;
  readonly promptLedgerTaskTemplateHash?: string;
  readonly promptLedgerCacheShapeReason?: string;
}

export interface ModelContextBundle {
  readonly prompt: PromptEnvelope;
  readonly providerTurnContract: DriverProviderTurnFrame;
  readonly contextAssembly?: ContextAssemblyRecord;
  readonly snapshot: ProviderTurnSnapshot;
  readonly hookTrace: readonly HookResult[];
}

export interface SessionDriverIdentityState {
  sessionId: string;
  runId: string;
  userRequest: string;
  userAuthorityFrame: UserAuthorityFrame;
  phase: SessionTurnPhase;
}

export interface SessionDriverResourceState {
  workspaceScopeKey: string;
  workspaceBinding?: AgentWorkspaceBinding;
  stateContract?: KernelStateContractRef;
  driverRequest?: DriverRequestRef;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  initialContext: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  resourceEvidenceRevision: number;
  generatedArtifactEvidence: Map<string, GeneratedArtifactEvidence>;
  resourceRequestProgressByTask: Map<string, SessionDriverTaskResourceProgress>;
}

export interface SessionDriverTaskResourceProgress {
  signatures: string[];
  packetIds: string[];
  noProgressCount: number;
}

export interface SessionDriverMemoryState {
  memoryDocument: SessionMemoryDocument;
  memoryHints: string[];
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  taskLocalCompactRecords?: ContextAssemblyTaskLocalCompactRecord[];
}

export interface SessionDriverAcceptedPlanState {
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshot;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
  implementationBatch: ImplementationBatchContext;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  pendingAcceptedTaskOutcomeReview?: PendingAcceptedTaskOutcomeReview;
}

export interface SessionDriverRepairState {
  resourceRequestRepairAttempted: boolean;
  actionBundleAdmissionRepairAttempted: boolean;
  planReviewRepairAttempted: boolean;
  terminalGuidanceRevisionAttempted: boolean;
}

export interface SessionDriverProviderState {
  providerTurnFrame?: DriverProviderTurnFrame;
  modelContextBundle?: ModelContextBundle;
  nativeToolReadLedger: Map<string, NativeToolReadLedgerEntry>;
  nativeToolDuplicateRepairAttempted: boolean;
  nativeToolResumeMessages?: LlmChatRequest['messages'];
  nativeToolResumeRound?: number;
  semanticDirectiveRepairAttempted?: boolean;
  semanticDirectiveErrorSummary?: string;
  taskPlanReplanReason?: AcceptedTaskReplanReason;
  providerRequestCacheHistory?: Record<string, ProviderRequestCacheHistoryEntry>;
  activeTurn?: ActiveTurnState;
  promptLedger: PromptLedgerState;
  artifactDraftLease?: ArtifactDraftLease;
  artifactChunkRepairAttempts?: Record<string, number>;
  semanticDirectiveRepairAttempts?: Record<string, number>;
  pendingSemanticToolCalls?: Record<string, NativeToolCallProposal>;
  pendingProviderCommitEvents?: AgentEvent[];
  providerCommitDeferred?: boolean;
}

export interface SessionDriverProviderRuntimeState {
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  providerTurnFrame?: DriverProviderTurnFrame;
  modelContextBundle?: ModelContextBundle;
}

export class SessionDriverProviderRuntimeAccessor {
  constructor(private readonly state: SessionDriverProviderRuntimeState) {}

  applyContextAssembly(input: {
    cachePlan?: PromptCachePlan;
    contextAssembly?: ContextAssemblyRecord;
  }): ContextAssemblyRecord | undefined {
    this.state.cachePlan = input.cachePlan;
    this.state.contextAssembly = input.contextAssembly;
    return this.state.contextAssembly;
  }

  applyProviderTurnFrame(providerTurnFrame: DriverProviderTurnFrame): DriverProviderTurnFrame {
    this.state.providerTurnFrame = providerTurnFrame;
    return providerTurnFrame;
  }

  applyModelContext(input: {
    prompt: PromptEnvelope;
    cachePlan?: PromptCachePlan;
    contextAssembly?: ContextAssemblyRecord;
    providerTurnFrame: DriverProviderTurnFrame;
    snapshot: ProviderTurnSnapshot;
    hookTrace: readonly HookResult[];
  }): ModelContextBundle {
    this.applyContextAssembly(input);
    this.applyProviderTurnFrame(input.providerTurnFrame);
    this.state.modelContextBundle = {
      prompt: input.prompt,
      providerTurnContract: input.providerTurnFrame,
      contextAssembly: input.contextAssembly,
      snapshot: input.snapshot,
      hookTrace: input.hookTrace,
    };
    return this.state.modelContextBundle;
  }
}

export class SessionDriverRepairRuntimeAccessor {
  constructor(private readonly state: Partial<SessionDriverRepairState>) {}

  attempted(flag: keyof SessionDriverRepairState): boolean {
    return this.state[flag] === true;
  }

  markAttempted(flag: keyof SessionDriverRepairState): void {
    this.state[flag] = true;
  }
}

export interface SessionDriverActiveTurnRuntimeState {
  activeTurn?: ActiveTurnState;
}

export class SessionDriverActiveTurnRuntimeAccessor {
  constructor(private readonly state: SessionDriverActiveTurnRuntimeState) {}

  ensure(stage: string | undefined, createId: (prefix: string) => string): ActiveTurnState {
    const activeTurn = this.state.activeTurn ?? {
      turnId: createId('active-turn'),
      seq: 0,
      stage: stage ?? 'provider_call',
    };
    activeTurn.stage = stage ?? activeTurn.stage;
    this.state.activeTurn = activeTurn;
    return activeTurn;
  }

  advance(stage: string | undefined, createId: (prefix: string) => string): ActiveTurnState {
    const activeTurn = this.ensure(stage, createId);
    activeTurn.seq += 1;
    this.state.activeTurn = activeTurn;
    return activeTurn;
  }
}

export interface SessionDriverNativeToolRuntimeState {
  nativeToolDuplicateRepairAttempted: boolean;
}

export class SessionDriverNativeToolRuntimeAccessor {
  constructor(private readonly state: SessionDriverNativeToolRuntimeState) {}

  duplicateRepairAttempted(): boolean {
    return this.state.nativeToolDuplicateRepairAttempted === true;
  }

  markDuplicateRepairAttempted(): void {
    this.state.nativeToolDuplicateRepairAttempted = true;
  }
}

export interface SessionDriverInteractionState {
  interactionOverlay?: InteractionOverlayContext;
}

export interface SessionDriverLoopRunState
  extends SessionDriverIdentityState,
    SessionDriverResourceState,
    SessionDriverMemoryState,
    SessionDriverAcceptedPlanState,
    SessionDriverRepairState,
    SessionDriverProviderState,
    SessionDriverInteractionState {}

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
  submittedPartFrames?: Record<string, true>;
  semanticDrafts?: Record<string, SessionSemanticDraftStreamRecord>;
}

export interface LlmTurnResult {
  result: LlmChatResult;
  content: string;
  reasoning: string;
  toolCalls: NativeToolCallProposal[];
}
