import type {
  AgentContextAttachment,
  AgentConversationActivity,
  AgentEvent,
  AgentSessionResult,
  AgentStreamPartFrame,
  AgentWorkspaceBinding,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatStreamEvent,
  LlmChatResult,
  ProjectionDelta,
} from '@deepcode/protocol';
import {
  AcceptedPlanAdmission,
  AcceptedPlanBatchPreflight,
  AcceptedPlanExecutor,
  AcceptedPlanExecutionRootResolver,
  AcceptedPlanProgressAggregator,
  AcceptedPlanOperationTargetResolver,
  AcceptedPlanScopeCoverage,
  AcceptedPlanScopeDecisionOverlay,
  ActionBatchFailureIndex,
  CompletedWorkUnitFactIndex,
  type AcceptedPlanReadOnlyResourceCompletion,
  AcceptedPlanScopeIntervention,
  AcceptedPlanScopeMatcher,
  AcceptedPlanTargetParser,
  AcceptedPlanTaskLedgerCoordinator,
  AcceptedImplementationPlanContextBuilder,
  ExecutionPromptCoordinator,
  ImplementationBatchContextBuilder,
  KernelEventStatusIndex,
  ReviewFactsAggregator,
  type AcceptedImplementationPlanContext,
  type AcceptedImplementationPlanExecutionRoot,
  type AcceptedPlanAccessScope,
  type AcceptedPlanBatchValidationResult,
  type AcceptedPlanBatchProgress,
  type AcceptedPlanExactOperationGrant,
  type CurrentTaskContext,
  type ExecutionSliceRole,
  type ImplementationBatchContext,
  type TaskExecutionCursor,
} from './execution/index.js';
import {
  AgentPlanParseError,
  type ActionBundleDraft,
  type ProposalEnvelope,
  type ResourceRequestDraft,
  type ReviewExpectationDraft,
  type ValidationExpectationDraft,
} from '../agent-plan/types.js';
import type {
  InitialContextPacket,
  ConversationResourceRoot,
  ProjectWorkingDirectory,
  ResourceManifest,
  ResourcePacket,
} from '../context/types.js';
import {
  assembleContext,
  buildSessionMemoryDocument,
  collectUserGuidanceEvents,
  type ContextAssemblyRecord,
  type PromptCachePlan,
  type ProjectMemoryMode,
  type SessionMemoryDocument,
  type UserGuidanceEvent,
} from '../context/index.js';
import type { PromptEnvelope } from '../prompt/types.js';
import { AcceptedPlanResourceResumePromptBuilder } from '../prompt/AcceptedPlanResourceResumePromptBuilder.js';
import { ProviderRepairMessageBuilder, type ProviderRepairMessageState } from '../prompt/ProviderRepairMessageBuilder.js';
import {
  NativeToolCoordinator,
  NativeToolCoordinatorError,
  NativeToolTurnHandler,
  ProviderJsonModeCoordinator,
  ProviderPipeline,
  ProviderStreamCoordinator,
  ProviderTraceRecorder,
  ProviderPartFrameParser,
  ProviderToolCallBuffer,
  stripProviderPartFrames,
  type NativeToolHandlingResult,
  type NativeToolReadLedgerEntry,
  type NativeToolReadSignature,
  type NativeToolCallProposal,
} from './pipelines/providerPipeline.js';
import { PermissionPipeline } from './pipelines/permissionPipeline.js';
import { UserInputPipeline } from './pipelines/userInputPipeline.js';
import {
  ContextFrameBuilder,
  GeneratedArtifactEvidenceIndex,
  ResourceEvidenceIndex,
  ResourceManifestBuilder,
  ResourceRequestLoop,
  ResourceRequestResolver,
  type GeneratedArtifactEvidence,
  type ResourceRequestResolution,
} from './context/index.js';
import type { RequirementChecklist, RequirementRecord } from '../requirement/types.js';
import type { TranscriptEntry } from '../transcript.js';
import {
  buildAcceptedPlanPromptFrame,
  buildAnswerFactsContext,
  buildReviewFactsContext,
  buildTaskLedgerSnapshot,
  evaluateRunState,
  normalizeDecisionEffect,
  type AcceptedPlanPromptFrame,
  type TaskLedgerSnapshot,
} from '../run-state/index.js';
import type { DriverRequestRef, KernelStateContractRef } from './types.js';
import { ReviewAssembler, ReviewDecisionProjectionBuilder, type SessionReviewContext } from './review/index.js';
import {
  PlanInteractionIndex,
  PlanReviewGrantProjector,
  PlanReviewReportAnalyzer,
  ProtocolGate,
} from './proposal/index.js';
import {
  KernelEventProjectionBuilder,
  PlanProjectionBuilder,
  RequirementProjectionBuilder,
  ReviewProjectionBuilder,
} from './projection/index.js';
import type { ProviderTurnContract } from './runFrame.js';

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

interface SessionDriverLoopRunState {
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
  providerTurnContract?: ProviderTurnContract;
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

type SessionTurnPhase =
  | 'context_reading'
  | 'provider_proposing'
  | 'waiting_requirement_confirmation'
  | 'waiting_plan_review'
  | 'waiting_permission'
  | 'executing_accepted_plan'
  | 'executing'
  | 'waiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface DecisionOwnerRef {
  kind: 'requirement' | 'plan' | 'review' | 'permission';
  runId: string;
  targetId?: string;
  planId?: string;
  requirementId?: string;
  reviewId?: string;
  permissionId?: string;
}

interface InteractionOverlayContext {
  parentRunId: string;
  parentPhase: SessionTurnPhase;
  interactionRunId: string;
  interactionId: string;
  sourceInteractionId?: string;
  resumedFromDecisionId?: string;
  acceptedPlanId?: string;
  acceptedPlanRunId?: string;
  acceptedCurrentTaskId?: string;
  acceptedCompletedTaskIds?: string[];
}

interface AcceptedPlanAccessScopeCanonicalizationResult {
  proposal: ProposalEnvelope;
  changed: boolean;
  removedAccessScopes: RemovedAcceptedPlanAccessScope[];
  actionTargets: string[];
}

interface RemovedAcceptedPlanAccessScope {
  index: number;
  reason: string;
  source: string;
  path?: string;
  scopeKind?: string;
  scope: unknown;
}

type SessionRunStateStatus = 'waiting' | 'running' | 'completed' | 'cancelled' | 'failed';

type SessionRunStateReason =
  | 'requirement'
  | 'plan_review'
  | 'permission'
  | 'review'
  | 'accepted_plan_execution'
  | 'work_unit_failed';

interface ActiveTurnState {
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

interface ProviderReasoningDeltaBuffer {
  pending: string;
  lastFlushAt: number;
  itemId?: string;
}

interface LlmTurnResult {
  result: LlmChatResult;
  content: string;
  reasoning: string;
  toolCalls: NativeToolCallProposal[];
}

const RESOURCE_BUDGET_REQUIREMENT_PREFIX = 'resource-budget';
const MAX_DERIVED_MANIFEST_ENTRIES = 240;
const RESOURCE_MANIFEST_MAX_BYTES = 512 * 1024;
const MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES = 384 * 1024;
const providerRepairMessageBuilder = new ProviderRepairMessageBuilder(MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES);
const acceptedPlanResourceResumePromptBuilder = new AcceptedPlanResourceResumePromptBuilder(providerRepairMessageBuilder);
const providerPipeline = new ProviderPipeline();
const providerJsonModeCoordinator = new ProviderJsonModeCoordinator();
const providerStreamCoordinator = new ProviderStreamCoordinator();
const providerTraceRecorder = new ProviderTraceRecorder();
const permissionPipeline = new PermissionPipeline();
const userInputPipeline = new UserInputPipeline();
const acceptedPlanTargetParser = new AcceptedPlanTargetParser();
const planReviewGrantProjector = new PlanReviewGrantProjector();
const planReviewReportAnalyzer = new PlanReviewReportAnalyzer({
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
});
const planInteractionIndex = new PlanInteractionIndex<SessionPlanContext>({
  planCardAwaitingDecision: (payload) => planReviewReportAnalyzer.planCardAwaitingDecision(payload),
  planReviewEventAwaitingDecision: (payload) => planReviewReportAnalyzer.planReviewEventAwaitingDecision(payload),
  planContextFromEvent,
  findPlanCard,
  planAlreadyResolved,
});
const kernelEventProjectionBuilder = new KernelEventProjectionBuilder({
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
  requiredAccessScopesFromReport: (report) => planReviewGrantProjector.requiredAccessScopesFromReport(report),
  permissionBundlesFromReport: (report) => planReviewGrantProjector.permissionBundlesFromReport(report),
  gateInterventionsFromReport: (report) => planReviewGrantProjector.gateInterventionsFromReport(report),
  planReviewFacts: (report) => planReviewReportAnalyzer.facts(report),
});
const planProjectionBuilder = new PlanProjectionBuilder({
  readActionBundle,
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
  requiredAccessScopesFromReport: (report) => planReviewGrantProjector.requiredAccessScopesFromReport(report),
  permissionBundlesFromReport: (report) => planReviewGrantProjector.permissionBundlesFromReport(report),
  gateInterventionsFromReport: (report) => planReviewGrantProjector.gateInterventionsFromReport(report),
  interactionOverlayProjection,
  visibleLanguageForRequest,
});
const requirementProjectionBuilder = new RequirementProjectionBuilder({
  visibleLanguageForRequest,
  interactionOverlayPayload: (payload) => interactionOverlayProjection(interactionOverlayFromPayload(payload)),
});
const reviewProjectionBuilder = new ReviewProjectionBuilder();
const actionBatchFailureIndex = new ActionBatchFailureIndex();
const kernelEventStatusIndex = new KernelEventStatusIndex();
const acceptedPlanScopeMatcher = new AcceptedPlanScopeMatcher();
const acceptedPlanScopeCoverage = new AcceptedPlanScopeCoverage({
  taskTargets: (task) => acceptedPlanTargetParser.taskTargets(task),
});
const acceptedPlanOperationTargetResolver = new AcceptedPlanOperationTargetResolver({
  normalizeTargetScope: (value, accepted) => acceptedPlanScopeMatcher.normalizeTargetScope(value, accepted),
  normalizePlanScope,
  concreteDirectoryOperationTarget: (value) => planReviewGrantProjector.concreteDirectoryOperationTarget(value),
  concreteFileOperationTarget: (value) => planReviewGrantProjector.concreteFileOperationTarget(value),
  exactGrantCapabilityMatches: (grant, capability) => acceptedPlanScopeCoverage.exactGrantCapabilityMatches(grant, capability),
  actionEffectiveCapability,
  actionFileTargetPath,
});
const acceptedPlanScopeDecisionOverlay = new AcceptedPlanScopeDecisionOverlay({
  planAcceptedAutoGrantCapability: (capability) => planReviewGrantProjector.planAcceptedAutoGrantCapability(capability),
  concreteDirectoryOperationTarget: (value) => planReviewGrantProjector.concreteDirectoryOperationTarget(value),
  concreteFileOperationTarget: (value) => planReviewGrantProjector.concreteFileOperationTarget(value),
  normalizeAcceptedPlanExactOperationGrants: (grants, executionRoot) =>
    planReviewGrantProjector.normalizeAcceptedPlanExactOperationGrants(grants, executionRoot),
  normalizeTargetForExecutionRoot: (value, executionRoot) =>
    acceptedPlanScopeMatcher.normalizeTargetForExecutionRoot(value, executionRoot),
});
const acceptedPlanBatchPreflight = new AcceptedPlanBatchPreflight({
  batchActionRecords,
  objectRecord,
  stringValue,
  stringArrayValue,
  actionEffectiveCapability,
  actionFileTargetPath,
  deleteActionTargetResourceKind,
  deleteActionRecursive,
  normalizePlanScope,
  containsDirectoryPath: (resourcePackets, path) => resourceRequestLoop.containsDirectoryPath(resourcePackets, path),
});
const completedWorkUnitFactIndex = new CompletedWorkUnitFactIndex({
  objectRecord,
  stringValue,
  stringArrayValue,
  kernelEventTargets: (record) => kernelEventProjectionBuilder.kernelEventTargets(record),
  normalizeRelativePath,
  comparablePath,
});
const nativeToolCoordinator = new NativeToolCoordinator();
const nativeToolTurnHandler = new NativeToolTurnHandler(nativeToolCoordinator);
const acceptedPlanExecutor = new AcceptedPlanExecutor();
const contextFrameBuilder = new ContextFrameBuilder();
const resourceRequestLoop = new ResourceRequestLoop({
  maxDerivedManifestEntries: MAX_DERIVED_MANIFEST_ENTRIES,
});
const NATIVE_TOOL_RESULT_MAX_CHARS = 12 * 1024;
const PROVIDER_REASONING_FLUSH_CHARS = 768;
const PROVIDER_REASONING_FLUSH_MS = 120;
const SIDE_EFFECT_CAPABILITIES = new Set([
  'fs.write',
  'fs.patch',
  'fs.delete',
  'fs.rename',
  'process.exec',
  'network.egress',
  'git.write',
  'git.push',
  'config.modify',
  'browser.control',
  'provider.egress',
]);

export class SessionDriverLoop {
  constructor(private readonly ports: SessionDriverLoopPorts) {}

  async resolveDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    if (input.kind === 'requirement') return this.resolveRequirementDecision(input);
    if (input.kind === 'plan') return this.resolvePlanDecision(input);
    if (input.kind === 'permission') return this.resolvePermissionDecision(input);
    if (input.kind === 'review') return this.resolveReviewDecision(input);
    return this.append(input.sessionId, [
      finalDiagnosticEvent(
        input.sessionId,
        diag('decisionResolverMissing', `Decision kind "${input.kind}" is not yet connected to Session DecisionResolver.`, { kind: input.kind }),
        this.ts(),
        this.id('decision-unsupported')
      ),
    ]);
  }

  async runUserTurn(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    const sessionId = input.sessionId;
    let lastResult = input.appendUserMessage === false
      ? await this.append(sessionId, [])
      : await this.append(sessionId, [
        this.event(sessionId, 'user_msg', {
          content: input.content,
          attachments: input.attachments ?? [],
          channel: 'user',
          visibility: 'conversation',
        }),
      ]);

    const manifestBuilder = resourceManifestBuilder();
    const kernelAttachments = manifestBuilder.kernelRunAttachments(input);
    const runReply = await this.kernel({
      command: {
        kind: 'runCreate',
        requestId: this.id('run-create'),
        sessionId,
        input: {
          text: input.content,
          attachments: kernelAttachments,
        },
        workspaceBinding: input.workspaceBinding,
        profileRef: input.profileId ? { id: input.profileId, kind: 'llm' } : undefined,
        workflowRef: input.workflow ? { id: input.workflow } : undefined,
        runOverrides: undefined,
      },
    });
    lastResult = await this.appendProjectedKernelEvents(sessionId, runReply);
    const runId = firstString(runReply.events, 'runId') ?? this.id('run');
    const stateContract = findStateContract(runReply.events);
    const driverRequest = findDriverRequest(runReply.events);

    const manifestBuild = manifestBuilder.build(input, this.id('resource-manifest'));
    const acceptedImplementationPlan = input.acceptedImplementationPlan;
    const implementationBatch = implementationBatchContextBuilder().build(input.existingEvents ?? []);
    if (acceptedImplementationPlan) {
      implementationBatch.batchIndex = acceptedImplementationPlan.batchIndex;
    }
    const memoryDocument = buildSessionMemoryDocument(input.existingEvents ?? [], {
      projectMemoryMode: input.projectMemoryMode,
    });
    const restoredResourcePackets = input.resumeResourcePackets
      ? resourceRequestLoop.recentPackets(input.existingEvents ?? [])
      : [];
    const initialTaskCursor = buildTaskExecutionCursor(
      acceptedImplementationPlan,
      restoredResourcePackets,
      lastAcceptedPlanTaskSavepointId(input.existingEvents ?? [])
    );
    const initialTaskContext = buildCurrentTaskContext(acceptedImplementationPlan, initialTaskCursor);
    const initialTaskLedger = buildAcceptedPlanTaskLedger(acceptedImplementationPlan);
    const initialAcceptedPlanPromptFrame = buildAcceptedPlanPromptFrameForContext(acceptedImplementationPlan, initialTaskLedger);
    const state: SessionDriverLoopRunState = {
      sessionId,
      runId,
      userRequest: input.content,
      phase: 'context_reading',
      workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
      stateContract,
      driverRequest,
      manifest: manifestBuild.manifest,
      conversationRoots: manifestBuild.conversationRoots,
      initialContext: {
        id: this.id('initial-context'),
        workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
        manifest: manifestBuild.manifest,
      },
      resourcePackets: [...restoredResourcePackets],
      generatedArtifactEvidence: generatedArtifactEvidenceIndex().fromPackets(restoredResourcePackets),
      memoryDocument,
      memoryHints: implementationBatchHints(implementationBatch, acceptedImplementationPlan),
      taskExecutionCursor: initialTaskCursor,
      currentTaskContext: initialTaskContext,
      taskLedger: initialTaskLedger,
      acceptedPlanPromptFrame: initialAcceptedPlanPromptFrame,
      implementationBatch,
      acceptedImplementationPlan,
      resourceRequestRepairAttempted: false,
      actionBundleAdmissionRepairAttempted: false,
      planReviewRepairAttempted: false,
      acceptedPlanScopeRepairAttempted: false,
      terminalGuidanceRevisionAttempted: false,
      nativeToolReadLedger: new Map(),
      nativeToolDuplicateRepairAttempted: false,
      interactionOverlay: input.interactionOverlay,
    };
    if (state.manifest.entries.length > 0 && !input.resumeResourcePackets) {
      const packet = await this.resolveResources(state, state.manifest);
      state.resourcePackets.push(packet);
      resourceRequestLoop.addDiscoveredManifestEntries(state.manifest, packet);
      lastResult = await this.append(sessionId, [resourceRequestLoop.packetEvent(sessionId, packet, this.ts(), this.id('resource-context'))]);
    }

    if (shouldRequestRequirementConfirmation(input, state)) {
      try {
        const event = await this.buildRequirementConfirmation(input, state);
        state.phase = 'waiting_requirement_confirmation';
        const payload = objectRecord(event.payload) ?? {};
        return this.append(sessionId, [
          event,
          sessionRunStateEvent({
            sessionId,
            runId: state.runId,
            phase: 'waiting_requirement_confirmation',
            reason: 'requirement',
            decisionOwner: {
              kind: 'requirement',
              runId: state.runId,
              targetId: stringValue(payload.requirementId),
              requirementId: stringValue(payload.requirementId),
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-requirement'),
          }),
        ]);
      } catch (error) {
        const message = error instanceof SessionDriverLoopError ? error.message : String(error);
        return this.append(sessionId, [
          finalDiagnosticEvent(
            sessionId,
            diag('requirementConfirmationFailed', `Requirement confirmation generation failed: ${message}`, { message }),
            this.ts(),
            this.id('requirement-confirmation-failed')
          ),
        ]);
      }
    }

    while (true) {
      refreshTaskExecutionState(state);
      const allowedProposals = sessionProviderAllowedProposals(state.stateContract?.allowedProposals ?? [
        'answer',
        'resourceRequest',
        'decisionRequest',
        'taskPlan',
        'actionBundle',
        'diagnostic',
      ], state);
      const assembledContext = assembleContext({
        contextAssemblyId: this.id('context-assembly'),
        workflowState: state.stateContract?.stateId ?? state.driverRequest?.kind ?? 'needProposal',
        allowedProposals,
        capabilityCatalogSummary: nativeToolCoordinator.capabilityCatalogSummary(state),
        memoryDocument: state.memoryDocument,
        projectMemoryMode: input.projectMemoryMode,
        extraMemoryHints: [
          ...currentTaskMemoryHints(state.currentTaskContext),
          ...implementationBatchHints(state.implementationBatch, state.acceptedImplementationPlan),
        ],
        interventionLevel: input.interventionLevel,
        userGuidance: collectUserGuidanceEvents(lastResult.events, state.runId),
        userRequest: input.content,
        currentTaskGoal: state.currentTaskContext?.goal,
        currentTaskContext: state.currentTaskContext,
        taskCursor: state.taskExecutionCursor,
        initialContext: state.initialContext,
        resourcePackets: state.resourcePackets,
        conversationRoots: state.conversationRoots,
        requirement: input.confirmedRequirement,
        auditOnly: {
          runId: state.runId,
          sessionId,
        },
      });
      state.cachePlan = assembledContext.cachePlan;
      state.contextAssembly = assembledContext.contextAssembly;
      lastResult = await this.appendConsumedUserGuidanceEvents(sessionId, lastResult, state.contextAssembly, state.runId);
      const prompt = assembledContext.prompt;
      state.providerTurnContract = contextFrameBuilder.buildSessionProviderTurnContract({
        contractId: this.id('provider-turn-contract'),
        sessionId,
        runId: state.runId,
        allowedKinds: allowedProposals,
        prompt,
        contextAssembly: state.contextAssembly,
        userRequest: input.content,
        acceptedPlanActive: Boolean(state.acceptedImplementationPlan),
        currentTaskContext: state.currentTaskContext,
        resourcePackets: state.resourcePackets,
        generatedArtifactCount: state.generatedArtifactEvidence.size,
      });
      state.phase = 'provider_proposing';
      let proposal: ProposalEnvelope;
      try {
        proposal = await this.callProviderAndParse(input, state, prompt);
      } catch (error) {
        if (error instanceof SessionDriverLoopError) {
          return this.append(sessionId, [
            finalDiagnosticEvent(
              sessionId,
              readableDriverFailureMessage(error.code, error.message),
              this.ts(),
              this.id(error.code)
            ),
          ]);
        }
        return this.append(sessionId, [
          finalDiagnosticEvent(
            sessionId,
            readableProviderFailureMessage(error),
            this.ts(),
            this.id('provider_call_failed')
          ),
        ]);
      }
      const narration = proposalNarrationEvent(sessionId, proposal, this.ts(), this.id('progress-model-narration'));
      if (narration) {
        lastResult = await this.append(sessionId, [narration]);
      }
      if (proposal.kind === 'answer') {
        const revised = await this.maybeReviseTerminalAnswerWithGuidance(input, state, proposal);
        if (revised) return revised;
        return this.append(sessionId, [answerEvent(sessionId, proposal, this.ts(), this.id('answer'))]);
      }
      if (proposal.kind === 'decisionRequest') {
        const requirement = requirementRecordFromProposal(proposal, input, state, this.ts());
        const interactionOverlay: InteractionOverlayContext = {
          parentRunId: state.interactionOverlay?.parentRunId ?? state.runId,
          parentPhase: state.phase,
          interactionRunId: state.runId,
          interactionId: requirement.requirementId,
          sourceInteractionId: requirement.requirementId,
          acceptedPlanId: state.acceptedImplementationPlan?.planId,
          acceptedPlanRunId: state.acceptedImplementationPlan?.runId,
          acceptedCurrentTaskId: state.currentTaskContext?.taskId,
          acceptedCompletedTaskIds: state.acceptedImplementationPlan?.completedTaskIds,
        };
        const confirmation = requirementConfirmationEvent({
            sessionId,
            runId: state.runId,
            requirement,
            proposal,
            originalUserRequest: input.content,
            attachments: input.attachments ?? [],
            interactionOverlay,
            ts: this.ts(),
            id: this.id('decision-request'),
          });
        state.phase = 'waiting_requirement_confirmation';
        return this.append(sessionId, [
          confirmation,
          sessionRunStateEvent({
            sessionId,
            runId: state.runId,
            phase: 'waiting_requirement_confirmation',
            reason: 'requirement',
            decisionOwner: {
              kind: 'requirement',
              runId: state.runId,
              targetId: requirement.requirementId,
              requirementId: requirement.requirementId,
            },
            interactionOverlay,
            ts: this.ts(),
            id: this.id('session-run-waiting-requirement'),
          }),
        ]);
      }
      if (proposal.kind === 'diagnostic') {
        const diagnostic = objectRecord(proposal.payload) ?? {};
        const summary = stringValue(diagnostic.summary)
          ?? stringValue(diagnostic.details)
          ?? 'The model returned diagnostic information without generating a plan or execution queue.';
        return this.append(sessionId, [
          finalDiagnosticEvent(sessionId, summary, this.ts(), this.id('diagnostic')),
        ]);
      }
      if (proposal.kind === 'taskPlan' || proposal.kind === 'implementationPlan') {
        const planId = stringValue(objectRecord(proposal.payload)?.id) ?? proposal.proposalId;
        state.phase = 'waiting_plan_review';
        return this.append(sessionId, [
          planProjectionBuilder.implementationPlanCardEvent({
            state,
            proposal,
            ts: this.ts(),
            id: this.id('task-plan'),
          }),
          sessionRunStateEvent({
            sessionId,
            runId: state.runId,
            phase: 'waiting_plan_review',
            reason: 'plan_review',
            decisionOwner: {
              kind: 'plan',
              runId: state.runId,
              targetId: planId,
              planId,
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-plan'),
          }),
        ]);
      }
      if (proposal.kind === 'resourceRequest') {
        const generated = generatedArtifactEvidenceIndex().packetForRequest(
          state,
          proposal.payload as ResourceRequestDraft,
          this.id('generated-artifact-resource')
        );
        if (generated.packet) {
          state.resourcePackets.push(generated.packet);
          lastResult = await this.append(sessionId, [resourceRequestLoop.packetEvent(sessionId, generated.packet, this.ts(), this.id('generated-artifact-resource-context'))]);
          if (!generated.remaining.items.length) continue;
        }
        let subset = resourceRequestResolver().resolve(state.manifest, generated.remaining, state.conversationRoots);
        if (!subset.manifest.entries.length) {
          if (!state.resourceRequestRepairAttempted) {
            state.resourceRequestRepairAttempted = true;
            try {
              const repaired = await this.repairResourceRequest(input, state, prompt, proposal, subset);
              if (repaired.kind === 'answer') {
                return this.append(sessionId, [answerEvent(sessionId, repaired, this.ts(), this.id('answer'))]);
              }
              if (repaired.kind === 'resourceRequest') {
                subset = resourceRequestResolver().resolve(state.manifest, repaired.payload as ResourceRequestDraft, state.conversationRoots);
              } else if (repaired.kind === 'actionBundle') {
                return this.submitActionProposal(input, state, prompt, repaired, lastResult);
              } else {
                return this.submitNonExecutableProposal(state, repaired, lastResult);
              }
            } catch (error) {
              const message = error instanceof SessionDriverLoopError ? error.message : String(error);
              return this.append(sessionId, [
                finalDiagnosticEvent(
                  sessionId,
                  diag('resourceResolveRepairFailed', `The requested resources could not be located in attachments or project directory, and repair failed: ${message}`, { message }),
                  this.ts(),
                  this.id('resource-repair-failed')
                ),
              ]);
            }
          }
        }
        if (!subset.manifest.entries.length) {
          return this.append(sessionId, [
            finalDiagnosticEvent(
              sessionId,
              resourceRequestLoop.resolutionDiagnostic(subset),
              this.ts(),
              this.id('resource-invalid')
            ),
          ]);
        }
        const packet = await this.resolveResources(state, subset.manifest);
        state.resourcePackets.push(packet);
        resourceRequestLoop.addDiscoveredManifestEntries(state.manifest, packet);
        lastResult = await this.append(sessionId, [resourceRequestLoop.packetEvent(sessionId, packet, this.ts(), this.id('resource-context'))]);
        if (state.acceptedImplementationPlan) {
          refreshTaskExecutionState(state);
          const resumeEvent = acceptedPlanResourceResumeEvent(
            sessionId,
            state.runId,
            state.acceptedImplementationPlan,
            state.taskExecutionCursor,
            state.currentTaskContext,
            packet,
            this.ts(),
            this.id('accepted-plan-resource-resume')
          );
          lastResult = await this.append(sessionId, [resumeEvent]) ?? lastResult;
          const readOnlyCompletion = await this.tryCompleteAcceptedPlanReadOnlyResourceTask(
            input,
            state,
            packet,
            lastResult
          );
          if (readOnlyCompletion) return readOnlyCompletion;
          const resumed = await this.callAcceptedPlanResourceResume(input, state, prompt, proposal, packet);
          if (resumed.kind === 'actionBundle') {
            return this.submitActionProposal(input, state, prompt, resumed, lastResult);
          }
          if (resumed.kind !== 'resourceRequest') {
            return this.submitNonExecutableProposal(state, resumed, lastResult);
          }
        }
        continue;
      }
      if (proposal.kind === 'actionBundle') {
        return this.submitActionProposal(input, state, prompt, proposal, lastResult);
      }
      return this.submitNonExecutableProposal(state, proposal, lastResult);
    }

    return lastResult;
  }

  private async resolveRequirementDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const requirementId = input.targetId;
    const confirmation = userInputPipeline.findRequirementConfirmation(
      events,
      input.runId,
      requirementId,
      findActiveDriverInteraction(events)
    );
    if (!confirmation) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/requirement_decision_noop', '该需求确认已处理或已过期。', this.ts(), this.id('requirement-noop'), {
          runId: input.runId,
          requirementId,
          decision: input.decision,
        }),
      ]);
    }

    const decisionEvent = requirementProjectionBuilder.decisionEvent({
      sessionId: input.sessionId,
      event: confirmation,
      decision: input.decision,
      guidance: input.guidance,
      ts: this.ts(),
      id: this.id('requirement-decision'),
    });
    const interactionOverlay = interactionOverlayFromRequirementDecision(confirmation, decisionEvent);
    let result = await this.append(input.sessionId, [decisionEvent]);
    if (input.decision === 'reject') {
      const payload = objectRecord(decisionEvent.payload) ?? {};
      const runId = stringValue(payload.runId) ?? input.runId ?? 'run-unknown';
      const resolvedRequirementId = stringValue(payload.requirementId) ?? requirementId;
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'cancelled',
          status: 'cancelled',
          reason: 'requirement',
          decisionOwner: {
            kind: 'requirement',
            runId,
            targetId: resolvedRequirementId,
            requirementId: resolvedRequirementId,
          },
          interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-cancelled-requirement'),
        }),
      ]) ?? result;
    }
    if (isResourceBudgetConfirmation(confirmation)) {
      const originalRequest = userInputPipeline.requirementOriginalRequest(confirmation);
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: input.decision === 'revise' && input.guidance
          ? [
              originalRequest,
              '',
              'User guidance after the read-only resource budget checkpoint (verbatim):',
              input.guidance,
              '',
              'If the user asks for an answer from the current evidence, prefer closing with the existing ResourcePackets.',
              'If the user narrowed the scope and key facts are still missing, continue with focused read-only resourceRequest within the additional budget.',
              'Write user-visible proposal fields in the current user request language; keep protocol keys and evidence refs unchanged.',
            ].join('\n')
          : originalRequest,
        attachments: userInputPipeline.requirementAttachments(confirmation),
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        projectMemoryMode: input.projectMemoryMode,
        interventionLevel: input.interventionLevel,
        resumeResourcePackets: true,
        interactionOverlay,
      });
    }
    if (isAcceptedPlanScopeConfirmation(confirmation)) {
      return this.resolveAcceptedPlanScopeRequirementDecision(input, confirmation, decisionEvent, interactionOverlay, result);
    }
    if (isAcceptedPlanExecutionConfirmation(confirmation)) {
      return this.resolveAcceptedPlanExecutionRequirementDecision(input, confirmation, decisionEvent, interactionOverlay, result);
    }

    if (input.decision === 'accept') {
      const optionEffect = selectedRequirementDecisionOptionEffect(decisionEvent);
      if (optionEffect) {
        const dispatched = await this.applyRequirementOptionEffect(
          input,
          confirmation,
          decisionEvent,
          interactionOverlay,
          optionEffect,
          result
        );
        if (dispatched) return dispatched;
      }
    }

    const originalRequest = userInputPipeline.requirementDecisionResumeRequest(confirmation, decisionEvent, input.decision, input.guidance);
    const next = await this.runUserTurn({
      sessionId: input.sessionId,
      content: originalRequest,
      attachments: userInputPipeline.requirementAttachments(confirmation),
      existingEvents: result.events,
      workspaceBinding: input.workspaceBinding,
      projectMemoryMode: input.projectMemoryMode,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      confirmedRequirement: input.decision === 'accept' ? userInputPipeline.requirementRecordFromEvent(confirmation, 'confirmed') : undefined,
      requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
      interventionLevel: input.interventionLevel,
      interactionOverlay,
    });

    return next;
  }

  private async resolveAcceptedPlanScopeRequirementDecision(
    input: SessionDecisionResolverInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    current: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const confirmationPayload = objectRecord(confirmation.payload) ?? {};
    const decisionRequest = objectRecord(confirmationPayload.decisionRequest) ?? {};
    const runId = stringValue(confirmationPayload.runId) ?? input.runId;
    const planId = stringValue(decisionRequest.acceptedPlanId);
    const selectedOptionId = selectedRequirementDecisionOptionId(decisionEvent);
    const plan = (runId ? findPlanCard(current.events, runId, planId) : null)
      ?? findPlanCard(current.events, undefined, planId)
      ?? (runId ? latestExecutablePlan(current.events, runId) : null);

    if (input.decision === 'revise' || selectedOptionId === 'revise-plan') {
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: acceptedPlanScopeRevisionRequest(confirmation, plan, input.guidance),
        attachments: userInputPipeline.requirementAttachments(confirmation),
        existingEvents: current.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
        resumeResourcePackets: true,
        interactionOverlay,
      });
    }

    if (!plan || !plan.implementationPlan) {
      return this.append(input.sessionId, [
        finalDiagnosticEvent(
          input.sessionId,
          'Accepted-plan scope decision could not recover the original implementationPlan; Session will not start a detached requirement flow.',
          this.ts(),
          this.id('accepted-plan-scope-decision-missing-plan')
        ),
      ]) ?? current;
    }

    const executionRoot = plan.executionRoot ?? AcceptedPlanExecutionRootResolver.fromDecision(input, current.events);
    const acceptedPlan = acceptedPlanWithLatestCheckpoint(
      acceptedImplementationPlanContext(plan, input.interventionLevel, executionRoot),
      current.events
    );
    const selectedEffect = selectedRequirementDecisionOptionEffect(decisionEvent)
      ?? (input.decision === 'accept' ? defaultRequirementDecisionOptionEffect(confirmation) : undefined);
    const nextAcceptedPlan = acceptedPlanScopeDecisionOverlay.apply(acceptedPlan, selectedEffect);
    const guidance = input.guidance?.trim()
      ? `User guidance for the accepted-plan scope intervention (verbatim):\n${input.guidance.trim()}`
      : acceptedPlanScopeDecisionOverlay.resumeGuidance(selectedEffect);
    return this.runUserTurn({
      sessionId: input.sessionId,
      content: implementationPlanExecutionRequest(plan, nextAcceptedPlan, guidance),
      attachments: nextAcceptedPlan.executionRoot ? [nextAcceptedPlan.executionRoot.attachment] : userInputPipeline.requirementAttachments(confirmation),
      existingEvents: current.events,
      workspaceBinding: input.workspaceBinding,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      requirementConfirmationMode: 'off',
      reviewContinuationMode: input.reviewContinuationMode,
      interventionLevel: input.interventionLevel,
      projectMemoryMode: input.projectMemoryMode,
      resumeResourcePackets: true,
      acceptedImplementationPlan: nextAcceptedPlan,
      interactionOverlay,
    });
  }

  private async applyRequirementOptionEffect(
    input: SessionDecisionResolverInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    effect: RequirementOptionEffect,
    current: AgentSessionResult
  ): Promise<AgentSessionResult | undefined> {
    const normalizedEffect = normalizeDecisionEffect(effect);
    const stateDecision = evaluateRunState({ decisionEffect: normalizedEffect });
    if (stateDecision.kind === 'continueAcceptedPlan') return undefined;

    const decisionPayload = objectRecord(decisionEvent.payload) ?? {};
    const runId = stringValue(decisionPayload.runId) ?? input.runId ?? 'run-unknown';
    const requirementId = stringValue(decisionPayload.requirementId) ?? input.targetId;
    const baseOwner = {
      kind: 'requirement' as const,
      runId,
      targetId: requirementId,
      requirementId,
    };

    if (stateDecision.kind === 'finishWithAnswer') {
      return this.append(input.sessionId, [
        answerEvent(input.sessionId, answerProposalFromDecisionEffect(
          input.sessionId,
          runId,
          effect,
          current.events,
          input.guidance,
          this.id('finish-with-answer-proposal')
        ), this.ts(), this.id('answer'), {
          answerFactsContext: buildAnswerFactsContext({
            reviewFactsContext: buildReviewFactsContext({
              runId,
              taskLedger: buildAcceptedPlanTaskLedger(this.recoverAcceptedPlanForRequirement(current.events, runId, undefined)),
            }),
            userGuidance: input.guidance,
          }),
        }),
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'completed',
          status: 'completed',
          reason: 'requirement',
          decisionOwner: baseOwner,
          interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-completed-answer'),
        }),
      ]) ?? current;
    }

    if (stateDecision.kind === 'cancel') {
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'completed',
          status: 'completed',
          reason: 'requirement',
          decisionOwner: baseOwner,
          interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-completed-requirement'),
        }),
      ]) ?? current;
    }

    if (stateDecision.kind === 'waitForPlanReview') {
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'waiting_plan_review',
          status: 'waiting',
          reason: 'plan_review',
          decisionOwner: baseOwner,
          interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-replan-requirement'),
        }),
      ]) ?? current;
    }

    const confirmationPayload = objectRecord(confirmation.payload) ?? {};
    const decisionRequest = objectRecord(confirmationPayload.decisionRequest) ?? {};
    const planId = stringValue(decisionRequest.acceptedPlanId)
      ?? stringValue(confirmationPayload.acceptedPlanId)
      ?? stringValue(decisionPayload.acceptedPlanId);
    const accepted = this.recoverAcceptedPlanForRequirement(current.events, runId, planId);
    if (!accepted) return undefined;

    const currentCompleted = new Set(accepted.completedTaskIds);
    const currentTaskId = accepted.tasks.find((task) => !currentCompleted.has(task.taskId))?.taskId;
    const newlyCompleted: string[] = [];
    let acceptedIncompleteTaskIds: string[] = [];
    if (normalizedEffect.kind === 'skipTask') {
      if (!currentTaskId) return undefined;
      newlyCompleted.push(currentTaskId);
    } else if (normalizedEffect.kind === 'markAcceptedIncomplete') {
      const ids = normalizedEffect.taskIds?.length ? normalizedEffect.taskIds : (currentTaskId ? [currentTaskId] : []);
      acceptedIncompleteTaskIds = ids.filter((id) => !currentCompleted.has(id) && accepted.tasks.some((task) => task.taskId === id));
      newlyCompleted.push(...acceptedIncompleteTaskIds);
      if (newlyCompleted.length === 0) return undefined;
    } else {
      return undefined;
    }
    const mergedCompletedTaskIds = [...accepted.completedTaskIds, ...newlyCompleted];
    const nextAccepted = acceptedPlanAfterBatch(accepted, mergedCompletedTaskIds);
    const remainingTaskIds = accepted.tasks
      .map((task) => task.taskId)
      .filter((id) => !mergedCompletedTaskIds.includes(id));
    const allDone = remainingTaskIds.length === 0;

    const checkpointId = this.id('requirement-driven-task-checkpoint');
    const events: AgentEvent[] = [
      requirementDrivenTaskCheckpointEvent(
        input.sessionId,
        runId,
        nextAccepted,
        newlyCompleted,
        mergedCompletedTaskIds,
        remainingTaskIds,
        effect.kind,
        stringValue(objectRecord(decisionPayload.selectedOption)?.id),
        this.ts(),
        checkpointId
      ),
    ];
    if (allDone) {
      events.push(sessionRunStateEvent({
        sessionId: input.sessionId,
        runId,
        phase: 'completed',
        status: 'completed',
        reason: 'requirement',
        decisionOwner: baseOwner,
        interactionOverlay,
        ts: this.ts(),
        id: this.id('session-run-completed-requirement-tasks'),
      }));
      return this.append(input.sessionId, events) ?? current;
    }

    const result = await this.append(input.sessionId, events) ?? current;
    const originalRequest = userInputPipeline.requirementDecisionResumeRequest(confirmation, decisionEvent, input.decision, input.guidance);
    return this.runUserTurn({
      sessionId: input.sessionId,
      content: originalRequest,
      attachments: userInputPipeline.requirementAttachments(confirmation),
      existingEvents: result.events,
      workspaceBinding: input.workspaceBinding,
      projectMemoryMode: input.projectMemoryMode,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      confirmedRequirement: userInputPipeline.requirementRecordFromEvent(confirmation, 'confirmed'),
      requirementConfirmationMode: 'off',
      interventionLevel: input.interventionLevel,
      acceptedImplementationPlan: nextAccepted,
      interactionOverlay,
    });
  }

  private recoverAcceptedPlanForRequirement(
    events: AgentEvent[],
    runId: string,
    planId: string | undefined
  ): AcceptedImplementationPlanContext | undefined {
    const plan = (runId ? findPlanCard(events, runId, planId) : null)
      ?? findPlanCard(events, undefined, planId)
      ?? (runId ? latestExecutablePlan(events, runId) : null);
    if (!plan || !plan.implementationPlan) return undefined;
    const base = acceptedImplementationPlanContext(plan, undefined, plan.executionRoot);
    return acceptedPlanWithLatestCheckpoint(base, events);
  }

  private async resolveAcceptedPlanExecutionRequirementDecision(
    input: SessionDecisionResolverInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    current: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const acceptedContext = recoverAcceptedPlanFromOverlay(input, current.events, interactionOverlay);
    if (!acceptedContext) {
      return this.append(input.sessionId, [
        finalDiagnosticEvent(
          input.sessionId,
          'Accepted-plan interaction decision could not recover the parent implementationPlan; Session will not start a detached requirement flow.',
          this.ts(),
          this.id('accepted-plan-interaction-missing-plan')
        ),
      ]) ?? current;
    }
    const guidance = userInputPipeline.acceptedPlanExecutionRequirementResumeRequest(
      confirmation,
      decisionEvent,
      input.decision,
      input.guidance
    );
    return this.runUserTurn({
      sessionId: input.sessionId,
      content: implementationPlanExecutionRequest(acceptedContext.plan, acceptedContext.acceptedPlan, guidance),
      attachments: acceptedContext.acceptedPlan.executionRoot
        ? [acceptedContext.acceptedPlan.executionRoot.attachment]
        : userInputPipeline.requirementAttachments(confirmation),
      existingEvents: current.events,
      workspaceBinding: input.workspaceBinding,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
      reviewContinuationMode: input.reviewContinuationMode,
      interventionLevel: input.interventionLevel,
      projectMemoryMode: input.projectMemoryMode,
      resumeResourcePackets: true,
      acceptedImplementationPlan: acceptedContext.acceptedPlan,
      interactionOverlay,
    });
  }

  private async resolvePlanDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const active = findActiveDriverInteraction(events);
    const activePlanMatches = active?.kind === 'plan' &&
      active.runId === input.runId &&
      (!input.targetId || active.planId === input.targetId || Boolean(findPlanCard(events, input.runId, input.targetId)));
    if (!activePlanMatches) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/plan_accept_noop', '该计划已处理或已过期，没有再次提交执行。', this.ts(), this.id('plan-noop'), {
          runId: input.runId,
          planId: input.targetId,
          decision: input.decision,
          visibility: 'debug',
        }),
      ]);
    }
    const plan = findPlanCard(events, input.runId, input.targetId);
    if (!plan || planAlreadyResolved(events, plan)) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/plan_accept_noop', '该计划已处理或已过期，没有再次提交执行。', this.ts(), this.id('plan-noop'), {
          runId: input.runId,
          planId: input.targetId,
          decision: input.decision,
          visibility: 'debug',
        }),
      ]);
    }

    if (input.decision !== 'accept') {
      const status = input.decision === 'revise' ? 'needsRevision' : 'rejected';
      let result = await this.append(input.sessionId, [
        planReviewDecisionEvent(input.sessionId, plan, status, input.guidance, this.ts(), this.id('plan-decision')),
      ]);
      if (input.decision === 'revise') {
        return this.runUserTurn({
          sessionId: input.sessionId,
          content: planRevisionRequest(plan, input.guidance),
          attachments: [],
          existingEvents: result.events,
          workspaceBinding: input.workspaceBinding,
          projectWorkingDirectory: input.projectWorkingDirectory,
          profileId: input.profileId,
          workflow: input.workflow,
          appendUserMessage: false,
          requirementConfirmationMode: 'off',
          reviewContinuationMode: input.reviewContinuationMode,
          interventionLevel: input.interventionLevel,
          projectMemoryMode: input.projectMemoryMode,
          interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
        });
      }
      if (input.decision === 'reject') {
        result = await this.append(input.sessionId, [
          sessionRunStateEvent({
            sessionId: input.sessionId,
            runId: plan.runId,
            phase: 'cancelled',
            status: 'cancelled',
            reason: 'plan_review',
            decisionOwner: {
              kind: 'plan',
              runId: plan.runId,
              targetId: plan.planId,
              planId: plan.planId,
            },
            interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
            ts: this.ts(),
            id: this.id('session-run-cancelled-plan'),
          }),
        ]) ?? result;
      }
      return result;
    }

    let result = await this.append(input.sessionId, [
      planReviewDecisionEvent(input.sessionId, plan, 'accepted', '用户已确认计划，准备进入执行。', this.ts(), this.id('plan-accepted')),
    ]);
    if (plan.implementationPlan) {
      const executionRoot = plan.executionRoot ?? AcceptedPlanExecutionRootResolver.fromDecision(input, result.events);
      const acceptedPlan = acceptedImplementationPlanContext(plan, input.interventionLevel, executionRoot);
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: implementationPlanExecutionRequest(plan, acceptedPlan, input.guidance),
        attachments: acceptedPlan.executionRoot ? [acceptedPlan.executionRoot.attachment] : [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        projectMemoryMode: input.projectMemoryMode,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        resumeResourcePackets: true,
        acceptedImplementationPlan: acceptedPlan,
        interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
      });
    }
    const acceptedOverlay = recoverAcceptedPlanFromOverlay(input, result.events, plan.interactionOverlay ?? input.interactionOverlay);
    return this.executeAcceptedActionBundlePlan(input, plan, result, acceptedOverlay);
  }

  private async executeAcceptedActionBundlePlan(
    input: SessionDecisionResolverInput,
    plan: SessionPlanContext,
    initialResult: AgentSessionResult,
    acceptedOverlay?: RecoveredAcceptedPlanContext
  ): Promise<AgentSessionResult> {
    let result = initialResult;
    try {
      result = await this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId: plan.runId,
          phase: 'executing_accepted_plan',
          status: 'running',
          reason: 'accepted_plan_execution',
          decisionOwner: {
            kind: 'plan',
            runId: plan.runId,
            targetId: plan.planId,
            planId: plan.planId,
          },
          interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-accepted-action-plan-execution'),
        }),
      ]) ?? result;
      const batch: Record<string, unknown> = {
        planId: plan.planId,
        contractId: planReviewGrantProjector.kernelExecutionContractId(plan.planReviewReport),
        actionBundle: plan.actionBundle,
        codeBlocks: plan.codeBlocks,
        commandBlocks: plan.commandBlocks,
      };
      result = await this.append(input.sessionId, [
        acceptedPlanActionBatchPreflightEvent(
          input.sessionId,
          plan,
          batch,
          this.ts(),
          this.id('accepted-action-plan-preflight')
        ),
      ]) ?? result;
      const deletePreflightReasons = acceptedPlanBatchPreflight.deleteReasons(batch, resourceRequestLoop.recentPackets(result.events));
      if (deletePreflightReasons.length) {
        return this.append(input.sessionId, planActionBundlePreflightFailureEvents(
          input.sessionId,
          plan,
          deletePreflightReasons,
          this.ts(),
          this.id('accepted-action-plan-preflight-failed')
        )) ?? result;
      }
      const decisionReply = await this.kernel({
        command: {
          kind: 'userDecisionSubmit',
          requestId: this.id('user-decision-plan'),
          runId: plan.runId,
          sessionId: input.sessionId,
          decision: {
            decisionId: this.id('decision-plan'),
            decisionKind: 'plan',
            targetId: plan.planId,
            payload: {
              decision: input.decision,
              guidance: input.guidance,
            },
          },
        },
      });
      assertKernelReplyOk(decisionReply, 'accepted_plan_user_decision_failed', 'Kernel plan decision submit failed');
      result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply) ?? result;

      const grantEvents: unknown[] = [];
      for (const grant of planReviewGrantProjector.temporaryGrantsForPlan(plan)) {
        const grantReply = await this.kernel({
          command: {
            kind: 'permissionGrantTemporary',
            requestId: this.id('plan-temp-grant'),
            runId: plan.runId,
            grant,
          },
        });
        assertKernelReplyOk(grantReply, 'accepted_plan_grant_failed', 'Kernel temporary grant failed');
        grantEvents.push(...(grantReply.events ?? []));
      }
      if (grantEvents.length) {
        result = await this.appendProjectedKernelEvents(input.sessionId, { ok: true, events: grantEvents }) ?? result;
      }

      const batchReply = await this.kernel({
        command: {
          kind: 'actionBatchSubmit',
          requestId: this.id('action-batch-submit'),
          runId: plan.runId,
          sessionId: input.sessionId,
          batch,
        },
      });
      result = await this.appendProjectedKernelEvents(input.sessionId, batchReply) ?? result;
      const batchEvents = batchReply.events ?? [];
      if (!batchReply.ok && batchEvents.length === 0) {
        throw new SessionDriverLoopError(
          'accepted_plan_action_batch_submit_failed',
          kernelReplyErrorMessage(batchReply, 'Kernel actionBatchSubmit failed without execution facts')
        );
      }
      if (kernelEventStatusIndex.hasFailureOrBlocker(batchEvents)) {
        return this.append(input.sessionId, planActionBundleExecutionFailureEvents(
          input.sessionId,
          plan,
          batchEvents,
          batch,
          this.ts(),
          this.id('accepted-action-plan-batch-failed')
        )) ?? result;
      }
      if (!kernelEventStatusIndex.actionBatchReadyForReview(batchEvents)) {
        if (kernelEventStatusIndex.hasPermissionRequest(batchEvents)) {
          const permissionId = kernelEventStatusIndex.permissionId(batchEvents);
          return this.append(input.sessionId, [
            sessionRunStateEvent({
              sessionId: input.sessionId,
              runId: plan.runId,
              phase: 'waiting_permission',
              reason: 'permission',
              decisionOwner: {
                kind: 'permission',
                runId: plan.runId,
                targetId: permissionId,
                permissionId,
                planId: plan.planId,
              },
              interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
              ts: this.ts(),
              id: this.id('session-run-waiting-permission'),
            }),
          ]) ?? result;
        }
        return result;
      }
      if (acceptedOverlay) {
        const progressProposal = proposalEnvelopeFromPlanContext(plan);
        const progress = acceptedPlanBatchProgress(acceptedOverlay.acceptedPlan, progressProposal, batchEvents);
        const nextAccepted = acceptedPlanAfterBatch(acceptedOverlay.acceptedPlan, progress.completedTaskIds);
        const cursor = buildTaskExecutionCursor(acceptedOverlay.acceptedPlan, resourceRequestLoop.recentPackets(result.events));
        const context = buildCurrentTaskContext(acceptedOverlay.acceptedPlan, cursor);
        const savepointId = this.id('accepted-plan-overlay-task-savepoint');
        result = await this.append(input.sessionId, [
          acceptedPlanBatchCheckpointEvent(
            input.sessionId,
            plan.runId,
            acceptedOverlay.acceptedPlan,
            progressProposal,
            batchEvents,
            progress,
            this.ts(),
            this.id('accepted-plan-overlay-batch-checkpoint')
          ),
          acceptedPlanTaskSavepointEvent(
            input.sessionId,
            plan.runId,
            acceptedOverlay.acceptedPlan,
            nextAccepted,
            progress,
            batchEvents,
            cursor,
            context,
            this.ts(),
            savepointId
          ),
        ]) ?? result;
        if (!acceptedPlanComplete(nextAccepted)) {
          return this.runUserTurn({
            sessionId: input.sessionId,
            content: implementationPlanExecutionRequest(acceptedOverlay.plan, nextAccepted),
            attachments: nextAccepted.executionRoot ? [nextAccepted.executionRoot.attachment] : [],
            existingEvents: result.events,
            workspaceBinding: input.workspaceBinding,
            projectWorkingDirectory: input.projectWorkingDirectory,
            profileId: input.profileId,
            workflow: input.workflow,
            appendUserMessage: false,
            requirementConfirmationMode: 'off',
            reviewContinuationMode: input.reviewContinuationMode,
            interventionLevel: input.interventionLevel,
            projectMemoryMode: input.projectMemoryMode,
            resumeResourcePackets: true,
            acceptedImplementationPlan: nextAccepted,
            interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          });
        }
        plan = {
          ...plan,
          planId: acceptedOverlay.acceptedPlan.planId,
          implementationPlan: acceptedOverlay.acceptedPlan.rawPlan,
        };
      }
      const staticReviewEvents: AgentEvent[] = [];

      const factsReply = await this.kernel({
        command: {
          kind: 'reviewFactsGet',
          requestId: this.id('review-facts-get'),
          runId: plan.runId,
          sessionId: input.sessionId,
        },
      });
      assertKernelReplyOk(factsReply, 'accepted_plan_review_facts_failed', 'Kernel reviewFactsGet failed');
      result = await this.appendProjectedKernelEvents(input.sessionId, factsReply) ?? result;
      const reviewKernelEvents = ReviewFactsAggregator.acceptedPlanKernelEvents(
        result.events,
        plan.runId,
        plan.planId,
        [...batchEvents, ...staticReviewEvents.map((event) => event.payload), ...(factsReply.events ?? [])]
      );
      const review = reviewSummaryEvent(
        input.sessionId,
        plan,
        reviewKernelEvents,
        this.ts(),
        this.id('review-summary')
      );
      const reviewPayload = objectRecord(review.payload) ?? {};
      return this.append(input.sessionId, [
        review,
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId: plan.runId,
          phase: 'waiting_review',
          reason: 'review',
          decisionOwner: {
            kind: 'review',
            runId: plan.runId,
            targetId: stringValue(reviewPayload.reviewId) ?? plan.runId,
            reviewId: stringValue(reviewPayload.reviewId) ?? plan.runId,
            planId: plan.planId,
          },
          interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-waiting-review'),
        }),
      ]) ?? result;
    } catch (error) {
      const message = error instanceof SessionDriverLoopError ? error.message : String(error);
      const code = error instanceof SessionDriverLoopError ? error.code : 'accepted_plan_execution_failed';
      return this.append(input.sessionId, planActionBundleExecutionExceptionEvents(
        input.sessionId,
        plan,
        message,
        code,
        this.ts(),
        this.id('accepted-action-plan-execution-failed')
      )) ?? result;
    }
  }

  private async resolvePermissionDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const pending = permissionPipeline.findPendingPermissionContext(events, input.targetId);
    if (!pending) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/permission_accept_noop', '该权限请求已处理或已过期，没有重复执行。', this.ts(), this.id('permission-noop'), {
          runId: input.runId,
          permissionId: input.targetId,
          decision: input.decision,
        }),
      ]);
    }
    const decisionReply = await this.kernel({
      command: {
        kind: 'permissionResolve',
        requestId: this.id('permission-resolve'),
        permissionId: pending.id,
        decision: input.decision === 'accept' ? 'accept' : 'reject',
      },
    });
    let result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);
    if (input.decision === 'reject') {
      const runId = pending.runId ?? input.runId ?? kernelEventStatusIndex.runId(decisionReply.events ?? []) ?? 'run-unknown';
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'cancelled',
          status: 'cancelled',
          reason: 'permission',
          decisionOwner: {
            kind: 'permission',
            runId,
            targetId: pending.id,
            permissionId: pending.id,
            planId: pending.planId,
          },
          ts: this.ts(),
          id: this.id('session-run-cancelled-permission'),
        }),
      ]) ?? result;
    }
    if (!kernelEventStatusIndex.actionBatchReadyForReview(decisionReply.events ?? [])) {
      if (kernelEventStatusIndex.hasPermissionRequest(decisionReply.events ?? [])) {
        const runId = pending.runId ?? input.runId ?? kernelEventStatusIndex.runId(decisionReply.events ?? []) ?? 'run-unknown';
        const permissionId = kernelEventStatusIndex.permissionId(decisionReply.events ?? []);
        return this.append(input.sessionId, [
          sessionRunStateEvent({
            sessionId: input.sessionId,
            runId,
            phase: 'waiting_permission',
            reason: 'permission',
            decisionOwner: {
              kind: 'permission',
              runId,
              targetId: permissionId,
              permissionId,
              planId: pending.planId,
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-permission'),
          }),
        ]) ?? result;
      }
      return result;
    }

    const runId = pending.runId ?? input.runId ?? kernelEventStatusIndex.runId(decisionReply.events ?? []);
    if (!runId) return result;
    const plan = findPlanCard(result.events, runId, pending.planId);
    if (!plan) return result;

    const factsReply = await this.kernel({
      command: {
        kind: 'reviewFactsGet',
        requestId: this.id('review-facts-get'),
        runId,
        sessionId: input.sessionId,
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, factsReply);
    const review = reviewSummaryEvent(
        input.sessionId,
        plan,
        [...(decisionReply.events ?? []), ...(factsReply.events ?? [])],
        this.ts(),
        this.id('review-summary')
      );
    const reviewPayload = objectRecord(review.payload) ?? {};
    return this.append(input.sessionId, [
      review,
      sessionRunStateEvent({
        sessionId: input.sessionId,
        runId,
        phase: 'waiting_review',
        reason: 'review',
        decisionOwner: {
          kind: 'review',
          runId,
          targetId: stringValue(reviewPayload.reviewId) ?? runId,
          reviewId: stringValue(reviewPayload.reviewId) ?? runId,
          planId: plan.planId,
        },
        ts: this.ts(),
        id: this.id('session-run-waiting-review'),
      }),
    ]) ?? result;
  }

  private async resolveReviewDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const review = reviewAssembler().findWaitingReview(events, input.runId, findActiveDriverInteraction(events));
    if (!review || reviewAssembler().reviewAlreadyResolved(events, review)) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/review_accept_noop', '该 Review 已处理或已过期，没有重复推进任务。', this.ts(), this.id('review-noop'), {
          runId: input.runId,
          decision: input.decision,
        }),
      ]);
    }

    if (input.decision === 'reject') {
      let result = await this.append(input.sessionId, [
        reviewDecisionProjection().event({
          sessionId: input.sessionId,
          review,
          status: 'rejected',
          content: input.guidance,
          continuationRequested: false,
          ts: this.ts(),
          id: this.id('review-rejected'),
        }),
      ]);
      const decisionReply = await this.kernel({
        command: {
          kind: 'userDecisionSubmit',
          requestId: this.id('user-decision-review'),
          runId: review.runId,
          sessionId: input.sessionId,
          decision: {
            decisionId: this.id('decision-review'),
            decisionKind: 'review',
            targetId: review.reviewId,
            payload: {
              decision: input.decision,
              guidance: input.guidance,
              continuationRequested: false,
              revisionRequested: false,
              ignored: true,
            },
          },
        },
      });
      result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId: review.runId,
          phase: 'cancelled',
          status: 'cancelled',
          reason: 'review',
          decisionOwner: {
            kind: 'review',
            runId: review.runId,
            targetId: review.reviewId,
            reviewId: review.reviewId,
            planId: review.sourcePlanId,
          },
          ts: this.ts(),
          id: this.id('session-run-cancelled-review'),
        }),
      ]) ?? result;
    }

    if (input.decision !== 'accept') {
      let result = await this.append(input.sessionId, [
        reviewDecisionProjection().event({
          sessionId: input.sessionId,
          review,
          status: 'needsRevision',
          content: input.guidance,
          continuationRequested: false,
          ts: this.ts(),
          id: this.id('review-revise'),
        }),
      ]);
      result = await this.tryKernelAudit(
        input.sessionId,
        {
          command: {
            kind: 'userDecisionSubmit',
            requestId: this.id('user-decision-review'),
            runId: review.runId,
            sessionId: input.sessionId,
            decision: {
              decisionId: this.id('decision-review'),
              decisionKind: 'review',
              targetId: review.reviewId,
              payload: {
                decision: input.decision,
                guidance: input.guidance,
                continuationRequested: true,
                revisionRequested: true,
              },
            },
          },
        },
        'trace/review_accept_noop',
        'Kernel 未接受 Review 修订决策审计；Session 将继续按用户补充信息发起修订流程。'
      ) ?? result;
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: reviewAssembler().revisionRequest(review, input.guidance),
        attachments: [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
      });
    }

    const terminalAcceptedPlan = reviewAssembler().isTerminalAcceptedPlan(events, review);
    const accepted = reviewDecisionProjection().event({
      sessionId: input.sessionId,
      review,
      status: 'accepted',
      continuationRequested: false,
      terminalAcceptedPlan,
      ts: this.ts(),
      id: this.id('review-accepted'),
    });
    let result = await this.append(input.sessionId, [accepted]);
    const decisionReply = await this.kernel({
      command: {
        kind: 'userDecisionSubmit',
        requestId: this.id('user-decision-review'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decisionId: this.id('decision-review'),
          decisionKind: 'review',
          targetId: review.reviewId,
          payload: {
            decision: input.decision,
            guidance: input.guidance,
            continuationRequested: false,
            continuationRecorded: review.continuations.length > 0,
          },
        },
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);
    const gateReply = await this.kernel({
      command: {
        kind: 'reviewGateEvaluate',
        requestId: this.id('review-gate-evaluate'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decision: input.decision,
          guidance: input.guidance,
        },
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, gateReply) ?? result;

    const continuationMode = input.reviewContinuationMode ?? 'auto';
    if (terminalAcceptedPlan || !review.continuations.length || continuationMode === 'off') {
      if (kernelEventStatusIndex.reviewGateStatus(gateReply.events) === 'accepted') {
        result = await this.append(input.sessionId, [
          sessionRunStateEvent({
            sessionId: input.sessionId,
            runId: review.runId,
            phase: 'completed',
            status: 'completed',
            reason: 'review',
            decisionOwner: {
              kind: 'review',
              runId: review.runId,
              targetId: review.reviewId,
              reviewId: review.reviewId,
              planId: review.sourcePlanId,
            },
            ts: this.ts(),
            id: this.id('session-run-completed-review'),
          }),
        ]) ?? result;
      }
      return result;
    }
    if (continuationMode === 'ask') {
      return this.append(input.sessionId, [
        reviewDecisionProjection().continuationPromptEvent({
          sessionId: input.sessionId,
          review,
          continuations: reviewAssembler().continuationSummaries(review),
          ts: this.ts(),
          id: this.id('review-continuation-choice'),
        }),
      ]) ?? result;
    }
    return this.runUserTurn({
      sessionId: input.sessionId,
      content: reviewAssembler().continuationRequest(review),
      attachments: [],
      existingEvents: result.events,
      workspaceBinding: input.workspaceBinding,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      requirementConfirmationMode: 'off',
      reviewContinuationMode: continuationMode,
      interventionLevel: input.interventionLevel,
      projectMemoryMode: input.projectMemoryMode,
    });
  }

  private async buildRequirementConfirmation(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState
  ): Promise<AgentEvent> {
    const assembledContext = assembleContext({
      contextAssemblyId: this.id('context-assembly'),
      workflowState: 'needDecisionRequest',
      allowedProposals: ['decisionRequest'],
      capabilityCatalogSummary: nativeToolCoordinator.capabilityCatalogSummary(state),
      memoryDocument: state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
      extraMemoryHints: state.memoryHints,
      interventionLevel: input.interventionLevel,
      userGuidance: collectUserGuidanceEvents(input.existingEvents ?? [], state.runId),
      userOverlay: [
        'Before proposing side-effect work, request user intervention only if a concrete decision is needed.',
        'Return kind="decisionRequest" only.',
        'Provide 2-3 clear options with one recommended option and impact descriptions.',
        'Do not output actionBundle yet.',
      ].join('\n'),
      userRequest: input.content,
      initialContext: state.initialContext,
      resourcePackets: state.resourcePackets,
      conversationRoots: state.conversationRoots,
      auditOnly: {
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });
    state.cachePlan = assembledContext.cachePlan;
    state.contextAssembly = assembledContext.contextAssembly;
    const prompt = assembledContext.prompt;
    state.providerTurnContract = contextFrameBuilder.buildSessionProviderTurnContract({
      contractId: this.id('provider-turn-contract-requirement'),
      sessionId: state.sessionId,
      runId: state.runId,
      turnMode: 'requirementDecision',
      allowedKinds: ['decisionRequest'],
      requiredKind: 'decisionRequest',
      prompt,
      contextAssembly: state.contextAssembly,
      userRequest: input.content,
      resourcePackets: state.resourcePackets,
      generatedArtifactCount: state.generatedArtifactEvidence.size,
      repairPolicy: 'deterministicIntervention',
      nextActionInstruction: 'Return exactly one decisionRequest proposal for the concrete user decision needed before planning side-effect work.',
    });
    const proposal = await this.callProviderAndParse(input, state, prompt);
    if (proposal.kind !== 'decisionRequest') {
      throw new SessionDriverLoopError(
        'decision_request_expected',
        `Expected decisionRequest before side-effect planning, got ${proposal.kind}.`
      );
    }
    const requirement = requirementRecordFromProposal(proposal, input, state, this.ts());
    return requirementConfirmationEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      requirement,
      proposal,
      originalUserRequest: input.content,
      attachments: input.attachments ?? [],
      executionRoot: AcceptedPlanExecutionRootResolver.fromState(state),
      ts: this.ts(),
      id: this.id('requirement-confirmation'),
    });
  }

  private async maybeReviseTerminalAnswerWithGuidance(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    draftAnswer: ProposalEnvelope
  ): Promise<AgentSessionResult | null> {
    if (state.terminalGuidanceRevisionAttempted) return null;
    state.terminalGuidanceRevisionAttempted = true;

    let result = await this.append(state.sessionId, []);
    const guidance = collectQueuedUserGuidanceEvents(result.events, state.runId);
    if (guidance.length === 0) return null;

    result = await this.append(state.sessionId, [
      guidanceRevisionTransitionEvent(
        state.sessionId,
        state.runId,
        guidance.map((item) => item.id),
        input.content,
        this.ts(),
        this.id('guidance-revision-transition')
      ),
    ]);
    const assembledContext = assembleContext({
      contextAssemblyId: this.id('context-assembly-guidance-revision'),
      workflowState: 'guidanceRevision',
      allowedProposals: ['answer'],
      capabilityCatalogSummary: nativeToolCoordinator.capabilityCatalogSummary(state),
      memoryDocument: state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
      extraMemoryHints: implementationBatchHints(state.implementationBatch),
      interventionLevel: input.interventionLevel,
      userOverlay: guidanceRevisionOverlay(input.content, draftAnswer, guidance),
      userGuidance: guidance,
      userRequest: input.content,
      initialContext: state.initialContext,
      resourcePackets: state.resourcePackets,
      conversationRoots: state.conversationRoots,
      requirement: input.confirmedRequirement,
      auditOnly: {
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });
    state.cachePlan = assembledContext.cachePlan;
    state.contextAssembly = assembledContext.contextAssembly;
    result = await this.appendConsumedUserGuidanceEvents(
      state.sessionId,
      result,
      state.contextAssembly,
      state.runId,
      'guidance_revision'
    );

    let revised: ProposalEnvelope;
    try {
      const raw = await this.llm(input.profileId, state, 'guidance_revision', [
        { role: 'system', content: assembledContext.prompt.stablePrefix },
        { role: 'user', content: assembledContext.prompt.dynamicSuffix },
      ]);
      revised = protocolGate().parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
      if (revised.kind !== 'answer') {
        throw new SessionDriverLoopError(
          'guidance_revision_non_answer',
          `Guidance revision expected answer, got ${revised.kind}.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.append(state.sessionId, [
        guidanceRevisionDiagnosticEvent(
          state.sessionId,
          `用户引导合并失败，已回退到初版回复：${message}`,
          this.ts(),
          this.id('guidance-revision-failed')
        ),
      ]);
      return this.append(state.sessionId, [
        answerEvent(state.sessionId, draftAnswer, this.ts(), this.id('answer'), {
          guidanceRevisionFailed: true,
          appliedGuidanceIds: guidance.map((item) => item.id),
          replacesDraftProposalId: draftAnswer.proposalId,
        }),
      ]);
    }

    const narration = answerNarrationEvent(state.sessionId, revised, this.ts(), this.id('guidance-revision-narration'));
    if (narration) {
      result = await this.append(state.sessionId, [narration]);
    }
    return this.append(state.sessionId, [
      answerEvent(state.sessionId, revised, this.ts(), this.id('answer'), {
        guidanceRevision: true,
        appliedGuidanceIds: guidance.map((item) => item.id),
        replacesDraftProposalId: draftAnswer.proposalId,
      }),
    ]);
  }

  private async callProviderAndParse(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope
  ): Promise<ProposalEnvelope> {
    let raw: string;
    try {
      const contract = state.providerTurnContract;
      if (!contract) {
        throw new SessionDriverLoopError(
          'provider_turn_contract_missing',
          'Provider turn contract is required before calling the provider.'
        );
      }
      const providerResult = state.acceptedImplementationPlan
        ? await this.callProviderProposalOnly(input, state, prompt, contract, 'accepted_plan_provider_call')
        : await this.callProviderWithNativeTools(input, state, prompt, contract);
      if (typeof providerResult !== 'string') return providerResult;
      raw = providerResult;
    } catch (error) {
      if (error instanceof SessionDriverLoopError
        && error.code === 'llm_empty_response') {
        if (!shouldAttemptActionBundleCompactionRepair(state)) {
          const parseError = {
            code: 'llm_empty_response',
            message: 'LLM provider returned an empty response before emitting a JSON proposal.',
          };
          await this.append(state.sessionId, [
            thinkingEvent(
              state.sessionId,
              `Model output requires Agent Protocol v3 repair: ${parseError.message}`,
              this.ts(),
              this.id('protocol-repair')
            ),
          ]);
          const repairedRaw = await this.llm(
            input.profileId,
            state,
            'protocol_repair',
            providerRepairMessageBuilder.repairMessages(prompt, providerRepairMessageState(state), '', parseError)
          );
          try {
            return protocolGate().parseAndValidateRepairedProposal({
              raw: repairedRaw,
              runId: state.runId,
              sessionId: state.sessionId,
              source: 'llm',
              allowedKinds: protocolGate().repairAllowedKinds({
                acceptedPlanActive: Boolean(state.acceptedImplementationPlan),
                errorCode: 'llm_empty_response',
              }),
              allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
            });
          } catch (repairError) {
            throw new SessionDriverLoopError(
              'agent_protocol_repair_failed',
              `Empty model response still could not be parsed after repair: ${normalizeParseError(repairError).message}`
            );
          }
        }
        await this.append(state.sessionId, [
          thinkingEvent(
            state.sessionId,
            'The model did not return valid JSON; Session is asking it to narrow the response to the next reviewable actionBundle.',
            this.ts(),
            this.id('action-bundle-compaction-repair')
          ),
        ]);
        const repairedRaw = await this.llm(
          input.profileId,
          state,
          'action_bundle_compaction_repair',
          providerRepairMessageBuilder.actionBundleCompactionRepairMessages(prompt, providerRepairMessageState(state), 'LLM provider returned an empty response before emitting a JSON proposal.', '')
        );
        try {
          return protocolGate().parseAndValidateRepairedProposal({
            raw: repairedRaw,
            runId: state.runId,
            sessionId: state.sessionId,
            source: 'llm',
            allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
            allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
          });
        } catch (repairError) {
          throw new SessionDriverLoopError(
            'agent_protocol_repair_failed',
            `Empty model response still could not be parsed after repair: ${normalizeParseError(repairError).message}`
          );
        }
      }
      throw error;
    }
    try {
      return protocolGate().parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
      });
    } catch (error) {
      const parseError = normalizeParseError(error);
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          `Model output requires Agent Protocol v3 repair: ${parseError.message}`,
          this.ts(),
          this.id('protocol-repair')
        ),
      ]);
      const repairStage = parseError.code === 'action_bundle_budget_exceeded'
        ? 'action_bundle_budget_repair'
        : 'protocol_repair';
      const repairPrompt = parseError.code === 'action_bundle_budget_exceeded'
        ? providerRepairMessageBuilder.actionBundleCompactionRepairMessages(prompt, providerRepairMessageState(state), parseError.message, raw)
        : providerRepairMessageBuilder.repairMessages(prompt, providerRepairMessageState(state), raw, parseError);
      const repairedRaw = await this.llm(input.profileId, state, repairStage, repairPrompt);
      try {
        return protocolGate().parseAndValidateRepairedProposal({
          raw: repairedRaw,
          runId: state.runId,
          sessionId: state.sessionId,
          source: 'llm',
          allowedKinds: protocolGate().repairAllowedKinds({
            acceptedPlanActive: Boolean(state.acceptedImplementationPlan),
            errorCode: parseError.code,
          }),
          allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
        });
      } catch (repairError) {
        throw new SessionDriverLoopError(
          'agent_protocol_repair_failed',
          `Model output still does not satisfy Agent Protocol v3 after repair: ${normalizeParseError(repairError).message}`
        );
      }
    }
  }

  private async tryCompleteAcceptedPlanReadOnlyResourceTask(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    packet: ResourcePacket,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | null> {
    const accepted = state.acceptedImplementationPlan;
    if (!accepted) return null;
    refreshTaskExecutionState(state);
    const completion = acceptedPlanExecutor.readOnlyResourceCompletion(
      accepted,
      state.taskExecutionCursor,
      state.currentTaskContext,
      packet
    );
    if (!completion.ok) return null;

    const nextAccepted = acceptedPlanAfterBatch(accepted, completion.completedTaskIds);
    const checkpoint = acceptedPlanResourceValidationCheckpointEvent(
      state.sessionId,
      state.runId,
      accepted,
      packet,
      completion,
      this.ts(),
      this.id('accepted-plan-resource-validation-checkpoint')
    );
    let result = await this.append(state.sessionId, [checkpoint]) ?? fallback;

    if (!acceptedPlanComplete(nextAccepted)) {
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: implementationPlanExecutionRequest(
          {
            sessionId: state.sessionId,
            runId: state.runId,
            planId: accepted.planId,
            userPlan: accepted.summary ?? accepted.title ?? 'Accepted implementation plan',
            actionBundle: {
              version: '1',
              id: `${accepted.planId}:read-only-validation`,
              goal: 'Read-only validation evidence satisfied the current accepted task.',
              actions: [],
              validationExpectations: [],
              reviewExpectations: [],
            },
            codeBlocks: [],
            commandBlocks: [],
            expectedValidation: '',
            reviewGuide: '',
            implementationPlan: accepted.rawPlan,
          },
          nextAccepted
        ),
        attachments: nextAccepted.executionRoot ? [nextAccepted.executionRoot.attachment] : [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
        resumeResourcePackets: true,
        acceptedImplementationPlan: nextAccepted,
      });
    }

    const factsReply = await this.kernel({
      command: {
        kind: 'reviewFactsGet',
        requestId: this.id('accepted-plan-review-facts-get'),
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });
    result = await this.appendProjectedKernelEvents(state.sessionId, factsReply) ?? result;
    const plan = acceptedPlanReadOnlyReviewContext(state, nextAccepted, packet, completion);
    const resourceFact = {
      kind: 'tool.completed',
      toolName: 'kernel.resourceResolve',
      status: 'ok',
      summary: `Kernel resolved ${packet.items.length} resource item(s) for accepted-plan read-only validation.`,
      output: packet,
    };
    const review = reviewSummaryEvent(
      state.sessionId,
      plan,
      [resourceFact, ...(factsReply.events ?? [])],
      this.ts(),
      this.id('review-summary')
    );
    const reviewPayload = objectRecord(review.payload) ?? {};
    return this.append(state.sessionId, [
      review,
      sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_review',
        reason: 'review',
        decisionOwner: {
          kind: 'review',
          runId: state.runId,
          targetId: stringValue(reviewPayload.reviewId) ?? state.runId,
          reviewId: stringValue(reviewPayload.reviewId) ?? state.runId,
          planId: accepted.planId,
        },
        ts: this.ts(),
        id: this.id('session-run-waiting-review'),
      }),
    ]) ?? result;
  }

  private async tryCompleteAcceptedPlanReadOnlyActionBundle(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | null> {
    const accepted = state.acceptedImplementationPlan;
    const actionBundle = readActionBundle(proposal);
    if (!accepted || !actionBundle) return null;
    refreshTaskExecutionState(state);
    if (!acceptedPlanExecutor.currentTaskIsReadOnlyResourceValidation(
      accepted,
      state.taskExecutionCursor,
      state.currentTaskContext
    )) {
      return null;
    }

    const request = acceptedPlanExecutor.resourceRequestFromReadOnlyActionBundle(
      actionBundle,
      state.currentTaskContext,
      this.id('accepted-plan-readonly-action-resource-request')
    );
    if (!request) return null;
    const subset = resourceRequestResolver().resolve(state.manifest, request, state.conversationRoots);
    if (!subset.manifest.entries.length) return null;

    const packet = await this.resolveResources(state, subset.manifest);
    state.resourcePackets.push(packet);
    resourceRequestLoop.addDiscoveredManifestEntries(state.manifest, packet);
    let result = await this.append(state.sessionId, [
      resourceRequestLoop.packetEvent(state.sessionId, packet, this.ts(), this.id('accepted-plan-readonly-action-resource-context')),
      acceptedPlanResourceResumeEvent(
        state.sessionId,
        state.runId,
        accepted,
        state.taskExecutionCursor,
        state.currentTaskContext,
        packet,
        this.ts(),
        this.id('accepted-plan-readonly-action-resource-resume')
      ),
    ]) ?? fallback;

    const readOnlyCompletion = await this.tryCompleteAcceptedPlanReadOnlyResourceTask(
      input,
      state,
      packet,
      result
    );
    if (readOnlyCompletion) return readOnlyCompletion;

    const resumed = await this.callAcceptedPlanResourceResume(input, state, prompt, proposal, packet);
    if (resumed.kind === 'actionBundle') {
      return this.submitActionProposal(input, state, prompt, resumed, result);
    }
    if (resumed.kind !== 'resourceRequest') {
      return this.submitNonExecutableProposal(state, resumed, result);
    }
    return result;
  }

  private async callAcceptedPlanResourceResume(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    requestProposal: ProposalEnvelope,
    packet: ResourcePacket
  ): Promise<ProposalEnvelope> {
    const messages: LlmChatRequest['messages'] = [
      { role: 'system', content: prompt.stablePrefix },
      {
        role: 'user',
        content: acceptedPlanResourceResumePromptBuilder.render({
          repairState: providerRepairMessageState(state),
          acceptedPlan: state.acceptedImplementationPlan,
          cursor: state.taskExecutionCursor,
          currentTask: state.currentTaskContext,
          requestProposal,
          packet,
        }),
      },
    ];
    const contract = contextFrameBuilder.buildSessionProviderTurnContract({
      contractId: this.id('provider-turn-contract-resource-resume'),
      sessionId: state.sessionId,
      runId: state.runId,
      turnMode: 'resourceResume',
      allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
      prompt,
      contextAssembly: state.contextAssembly,
      userRequest: input.content,
      acceptedPlanActive: Boolean(state.acceptedImplementationPlan),
      currentTaskContext: state.currentTaskContext,
      resourcePackets: state.resourcePackets,
      generatedArtifactCount: state.generatedArtifactEvidence.size,
      nextActionInstruction: 'Use the newly resolved ResourcePacket for the current accepted task. Return one actionBundle, resourceRequest, decisionRequest, or diagnostic proposal.',
    });
    state.providerTurnContract = contract;
    const providerResult = await this.callProviderProposalOnly(
      input,
      state,
      prompt,
      contract,
      'accepted_plan_resource_resume',
      messages
    );
    if (typeof providerResult !== 'string') return providerResult;
    try {
      return protocolGate().parseAndValidateProposal({
        raw: providerResult,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowBriefActionBundleUserPlan: true,
      });
    } catch (error) {
      const parseError = normalizeParseError(error);
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          `Accepted-plan resource resume output requires Agent Protocol v3 repair: ${parseError.message}`,
          this.ts(),
          this.id('accepted-plan-resource-resume-repair')
        ),
      ]);
      const repairedRaw = await this.llm(
        input.profileId,
        state,
        'accepted_plan_resource_resume_repair',
        providerRepairMessageBuilder.repairMessages(prompt, providerRepairMessageState(state), providerResult, parseError)
      );
      try {
        return protocolGate().parseAndValidateRepairedProposal({
          raw: repairedRaw,
          runId: state.runId,
          sessionId: state.sessionId,
          source: 'llm',
          allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
          allowBriefActionBundleUserPlan: true,
        });
      } catch (repairError) {
        throw new SessionDriverLoopError(
          'accepted_plan_resource_resume_repair_failed',
          `Accepted-plan resource resume output still could not be parsed after repair: ${normalizeParseError(repairError).message}`
        );
      }
    }
  }

  private async maybeRunStaticSyntaxReview(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    accepted: AcceptedImplementationPlanContext,
    batch: Record<string, unknown>,
    batchEvents: unknown[]
  ): Promise<AgentEvent[]> {
    const packet = reviewAssembler().staticSyntaxReviewPacket({
      accepted,
      batch,
      batchEvents,
      generatedArtifactEvidence: state.generatedArtifactEvidence,
      resourcePackets: state.resourcePackets,
    });
    if (!packet.files.length) return [];
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'accepted_plan.static_syntax_review',
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: `Session 正在对 ${packet.files.length} 个生成代码文件做 Review 前静态语法/API 审查。`,
      payload: {
        runId: state.runId,
        planId: accepted.planId,
        targetPaths: packet.files.map((file) => file.targetPath),
      },
    });
    let parsed: Record<string, unknown>;
    try {
      const raw = await this.llm(
        input.profileId,
        state,
        'accepted_plan_static_syntax_review',
        reviewAssembler().staticSyntaxReviewMessages({
          prompt,
          runId: state.runId,
          accepted,
          packet,
        })
      );
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        this.event(state.sessionId, 'workflow_stage', {
          kind: 'accepted_plan.static_syntax_review',
          stage: 'accepted_plan.static_syntax_review',
          status: 'failed',
          channel: 'progress',
          visibility: 'conversation',
          presentation: 'collapsible',
          runId: state.runId,
          planId: accepted.planId,
          summary: `Review 前静态审查未能解析：${message}`,
          targetPaths: packet.files.map((file) => file.targetPath),
          issues: [{ severity: 'warning', message }],
        }),
      ];
    }
    const issues = reviewAssembler().normalizeStaticSyntaxIssues(parsed.issues);
    const status = issues.length ? 'blocked' : 'completed';
    const summary = stringValue(parsed.summary)
      ?? (issues.length ? `Review 前静态审查发现 ${issues.length} 个潜在问题。` : 'Review 前静态审查未发现明显语法/API 问题。');
    return [
      this.event(state.sessionId, 'workflow_stage', {
        kind: 'accepted_plan.static_syntax_review',
        stage: 'accepted_plan.static_syntax_review',
        status,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        runId: state.runId,
        planId: accepted.planId,
        summary,
        targetPaths: packet.files.map((file) => file.targetPath),
        issues,
      }),
    ];
  }

  private async callProviderWithNativeTools(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    contract: ProviderTurnContract
  ): Promise<string | ProposalEnvelope> {
    let currentMessages = providerPipeline.messages(contract);
    for (let round = 0; ; round += 1) {
      const stage = round === 0 ? 'provider_call' : `provider_tool_resume_${round}`;
      const effectiveTurn = await providerPipeline.runWithNativeTools({
        profileId: input.profileId,
        state,
        contract,
        stage,
        messages: currentMessages,
        options: {
          tools: nativeToolCoordinator.providerTools(state),
        },
        runTurn: (profileId, runState, retryStage, retryMessages, options) =>
          this.llmTurn(profileId, runState, retryStage, retryMessages, options),
        isEmptyResponseError,
      });
      if (effectiveTurn.toolCalls.length === 0) return effectiveTurn.content;

      const handled = await nativeToolTurnHandler.handle({
        state,
        prompt,
        turn: effectiveTurn,
        round,
        ports: {
          appendAssistantProgress: async (runState, narration) => {
            await this.append(runState.sessionId, [
              this.event(runState.sessionId, 'assistant_msg', {
                content: narration,
                channel: 'progress',
                source: 'llm',
                visibility: 'conversation',
                presentation: 'body',
                runId: runState.runId,
              }),
            ]);
          },
          emitCheckpoint: async (runState, nativeToolRound, toolCallCount) => {
            await this.emitProjectionDelta(runState, {
              type: 'stage_delta',
              stage: `native_tool_round_${nativeToolRound + 1}`,
              status: 'running',
              channel: 'progress',
              source: 'session',
              summary: 'native_tool_checkpoint',
              activity: conversationActivity({
                activityId: `native-tool-round-${nativeToolRound + 1}`,
                kind: 'toolExecution',
                status: 'running',
                title: 'Native tool checkpoint',
                summary: 'Provider requested read-only native tools. Session is routing them through Kernel resource boundaries.',
                source: 'session',
                runId: runState.runId,
                itemCount: toolCallCount,
              }),
              payload: {
                visibility: 'task',
                nativeToolRound,
                toolCallCount,
                resourcePacketCount: runState.resourcePackets.length,
              },
            });
          },
          repairSideEffect: (runState, repairPrompt, toolCall, turn) =>
            this.repairSideEffectNativeTool(input, runState, repairPrompt, toolCall, turn),
          tryParseTurnProposal: (runState, turn) =>
            this.tryParseNativeToolTurnProposal(runState, turn),
          repairDuplicate: (runState, repairPrompt, turn, duplicates) =>
            this.repairDuplicateNativeReadTool(input, runState, repairPrompt, turn, duplicates),
          emitDuplicateRead: async (runState, toolCall, existing) => {
            await this.emitProjectionDelta(runState, {
              type: 'stage_delta',
              stage: 'native_tool_duplicate_read',
              status: 'completed',
              channel: 'tool',
              source: 'session',
              itemId: toolCall.callId,
              summary: `Provider repeated ${toolCall.name} for an already resolved target; Session is reusing the existing ResourcePacket without another Kernel read.`,
              activity: conversationActivity({
                activityId: `native-tool-duplicate-${toolCall.callId}`,
                kind: 'resourceRead',
                status: 'completed',
                title: 'Duplicate native read reused',
                summary: `Session reused ${existing.packet.id} for a repeated ${toolCall.name} request.`,
                source: 'session',
                runId: runState.runId,
                toolName: toolCall.name,
                targets: [existing.signature.path],
              }),
              payload: {
                callId: toolCall.callId,
                name: toolCall.name,
                duplicateOfPacketId: existing.packet.id,
                duplicateCount: existing.repeatCount,
                signature: existing.signature,
                contentHash: existing.contentHash,
              },
            });
          },
          duplicateToolMessage: (toolCall, existing) => ({
            role: 'tool',
            toolCallId: toolCall.callId,
            content: clipJson(nativeToolCoordinator.duplicateResult(toolCall, existing), NATIVE_TOOL_RESULT_MAX_CHARS),
          }),
          emitToolCallRunning: async (runState, toolCall, nativeToolRound) => {
            const language = visibleLanguageForRequest(runState.userRequest);
            await this.emitProjectionDelta(runState, {
              type: 'tool_call_delta',
              stage: 'native_tool_call',
              status: 'running',
              channel: 'tool',
              source: 'session',
              itemId: toolCall.callId,
              summary: providerStreamCoordinator.nativeToolResolveRunningSummary(toolCall.name, language),
              activity: conversationActivity({
                activityId: `native-tool-${toolCall.callId}`,
                kind: 'toolExecution',
                status: 'running',
                title: 'Resolving native read tool',
                summary: providerStreamCoordinator.nativeToolResolveRunningSummary(toolCall.name, language),
                source: 'session',
                runId: runState.runId,
                toolName: toolCall.name,
              }),
              payload: {
                callId: toolCall.callId,
                name: toolCall.name,
                arguments: toolCall.arguments,
                nativeToolRound,
              },
            });
          },
          resolveReadToolCall: (runState, toolCall) =>
            this.resolveNativeReadToolCall(runState, toolCall),
          recordResolvedPacket: async (runState, signature, packet) => {
            runState.nativeToolReadLedger.set(signature.key, {
              signature,
              packet,
              contentHash: nativeToolCoordinator.packetContentHash(packet),
              repeatCount: 0,
            });
            runState.resourcePackets.push(packet);
            resourceRequestLoop.addDiscoveredManifestEntries(runState.manifest, packet);
            await this.append(runState.sessionId, [
              resourceRequestLoop.packetEvent(runState.sessionId, packet, this.ts(), this.id('native-resource-context')),
            ]);
          },
          emitResourceResolved: async (runState, toolCall, packet, nativeToolRound) => {
            const language = visibleLanguageForRequest(runState.userRequest);
            await this.emitProjectionDelta(runState, {
              type: 'resource_delta',
              stage: 'native_tool_resource_resolve',
              status: 'completed',
              channel: 'resource',
              source: 'kernel',
              itemId: toolCall.callId,
              summary: providerStreamCoordinator.nativeToolResolveCompletedSummary(toolCall.name, language),
              activity: resourceRequestLoop.packetActivity(packet, `native-tool-resource-${toolCall.callId}`, runState.runId),
              payload: {
                callId: toolCall.callId,
                packetId: packet.id,
                itemCount: packet.items.length,
                nativeToolRound,
                resourcePacketCount: runState.resourcePackets.length,
              },
            });
          },
          packetToolMessage: (toolCall, packet) => ({
            role: 'tool',
            toolCallId: toolCall.callId,
            content: clipJson(nativeToolCoordinator.resultFromPacket(toolCall, packet), NATIVE_TOOL_RESULT_MAX_CHARS),
          }),
        },
      });
      if (handled.kind === 'proposal') return handled.proposal;

      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant',
          content: effectiveTurn.content,
          reasoningContent: effectiveTurn.reasoning || undefined,
          toolCalls: effectiveTurn.toolCalls.map((toolCall) => nativeToolCoordinator.callToProtocol(toolCall)),
        },
        ...handled.toolMessages,
      ];
      const guidanceMessages = await this.consumeQueuedGuidanceForProviderResume(state, stage);
      currentMessages.push(...guidanceMessages);
    }
  }

  private async callProviderProposalOnly(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    contract: ProviderTurnContract,
    stage: string,
    messages?: LlmChatRequest['messages']
  ): Promise<string | ProposalEnvelope> {
    const effectiveTurn = await providerPipeline.runProposalOnly({
      profileId: input.profileId,
      state,
      contract,
      stage,
      messages,
      runTurn: (profileId, runState, retryStage, retryMessages, options) =>
        this.llmTurn(profileId, runState, retryStage, retryMessages, options),
      isEmptyResponseError,
    });
    if (effectiveTurn.toolCalls.length === 0) return effectiveTurn.content;

    const firstToolCall = effectiveTurn.toolCalls[0];
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'accepted_plan.provider_tool_violation',
      status: 'failed',
      channel: 'progress',
      source: 'session',
      summary: `Complete-stage provider requested native tool ${firstToolCall.name}; Session is retrying once with proposal-only contract.`,
      activity: conversationActivity({
        activityId: `accepted-plan-provider-tool-violation-${firstToolCall.callId}`,
        kind: 'diagnostic',
        status: 'failed',
        title: 'Complete-stage native tool blocked',
        summary: `Provider requested ${firstToolCall.name} during proposal-only accepted-plan execution.`,
        source: 'session',
        runId: state.runId,
        toolName: firstToolCall.name,
      }),
      payload: {
        visibility: 'task',
        callId: firstToolCall.callId,
        name: firstToolCall.name,
        arguments: firstToolCall.arguments,
        stage,
        acceptedPlanId: state.acceptedImplementationPlan?.planId,
      },
    });
    const repairedRaw = await this.llm(
      input.profileId,
      state,
      `${stage}_tool_violation_repair`,
      providerRepairMessageBuilder.completeStageToolViolationRepairMessages(prompt, providerRepairMessageState(state), firstToolCall, effectiveTurn)
    );
    try {
      return protocolGate().parseAndValidateRepairedProposal({
        raw: repairedRaw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'accepted_plan_provider_tool_violation',
        `Complete-stage provider requested native tool ${firstToolCall.name}; proposal-only repair failed: ${normalizeParseError(error).message}`
      );
    }
  }

  private async resolveNativeReadToolCall(
    state: SessionDriverLoopRunState,
    toolCall: NativeToolCallProposal
  ): Promise<ResourcePacket> {
    const manifest = nativeToolCoordinator.readManifest(state, toolCall);
    return this.resolveResources(state, manifest);
  }

  private async repairSideEffectNativeTool(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    toolCall: NativeToolCallProposal,
    turn: LlmTurnResult
  ): Promise<ProposalEnvelope> {
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'native_tool_side_effect_blocked',
      status: 'failed',
      channel: 'progress',
      source: 'session',
      summary: 'side_effect_native_tool_blocked',
      activity: conversationActivity({
        activityId: `native-tool-side-effect-${toolCall.callId}`,
        kind: 'diagnostic',
        status: 'failed',
        title: 'Native tool blocked',
        summary: 'Provider requested a side-effect tool. Session is converting it back through the plan/permission path.',
        source: 'session',
        runId: state.runId,
        toolName: toolCall.name,
      }),
      payload: {
        visibility: 'task',
        callId: toolCall.callId,
        name: toolCall.name,
      },
    });
    const raw = await this.llm(
      input.profileId,
      state,
      'native_tool_side_effect_repair',
      providerRepairMessageBuilder.sideEffectNativeToolRepairMessages(
        prompt,
        providerRepairMessageState(state),
        toolCall,
        turn,
        Boolean(state.acceptedImplementationPlan) || state.implementationBatch.batchIndex > 1
      )
    );
    try {
      return protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds: state.acceptedImplementationPlan || state.implementationBatch.batchIndex > 1
          ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']
          : ['decisionRequest', 'taskPlan', 'resourceRequest', 'diagnostic'],
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'native_tool_side_effect_repair_failed',
        `Provider requested side-effect native tool ${toolCall.name}; repair failed: ${normalizeParseError(error).message}`
      );
    }
  }

  private tryParseNativeToolTurnProposal(
    state: SessionDriverLoopRunState,
    turn: LlmTurnResult
  ): ProposalEnvelope | null {
    if (!turn.content.trim().startsWith('{')) return null;
    try {
      return protocolGate().parseAndValidateProposal({
        raw: turn.content,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch {
      return null;
    }
  }

  private async repairDuplicateNativeReadTool(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    turn: LlmTurnResult,
    duplicates: Array<{ toolCall: NativeToolCallProposal; signature: NativeToolReadSignature; entry: NativeToolReadLedgerEntry }>
  ): Promise<ProposalEnvelope> {
    if (state.nativeToolDuplicateRepairAttempted) {
      const duplicateSummary = duplicates
        .map((item) => `${item.toolCall.name}:${item.signature.path}`)
        .join(', ');
      throw new SessionDriverLoopError(
        'native_tool_duplicate_loop',
        `Provider repeated already-resolved read-only native tool calls after repair: ${duplicateSummary}. Session stopped the run to avoid an infinite ResourceResolve loop.`
      );
    }
    state.nativeToolDuplicateRepairAttempted = true;
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'native_tool_duplicate_repair',
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: 'Provider repeated already resolved read-only native tool targets; Session is requesting a no-tool proposal.',
      activity: conversationActivity({
        activityId: `native-tool-duplicate-repair-${state.runId}`,
        kind: 'diagnostic',
        status: 'running',
        title: 'Duplicate native read repair',
        summary: 'Session detected repeated read-only native tool calls with no new evidence.',
        source: 'session',
        runId: state.runId,
        targets: duplicates.map((item) => item.signature.path),
      }),
      payload: {
        visibility: 'task',
        duplicateTargets: duplicates.map((item) => ({
          callId: item.toolCall.callId,
          toolName: item.toolCall.name,
          signature: item.signature,
          packetId: item.entry.packet.id,
          contentHash: item.entry.contentHash,
          repeatCount: item.entry.repeatCount,
        })),
      },
    });
    const raw = await this.llm(
      input.profileId,
      state,
      'native_tool_duplicate_repair',
      providerRepairMessageBuilder.nativeToolDuplicateRepairMessages(
        prompt,
        providerRepairMessageState(state),
        turn,
        duplicates,
        Boolean(state.acceptedImplementationPlan) || state.implementationBatch.batchIndex > 1
      )
    );
    try {
      return protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds: ['resourceRequest', 'decisionRequest', 'diagnostic'],
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'native_tool_duplicate_repair_failed',
        `Provider repeated read-only native tools and duplicate-loop repair did not return a valid Agent Protocol v3 proposal: ${normalizeParseError(error).message}`
      );
    }
  }

  private async consumeQueuedGuidanceForProviderResume(
    state: SessionDriverLoopRunState,
    stage: string
  ): Promise<LlmChatRequest['messages']> {
    const current = await this.append(state.sessionId, []);
    const guidance = collectQueuedUserGuidanceEvents(current.events, state.runId);
    if (guidance.length === 0) return [];
    const language = visibleLanguageForRequest(state.userRequest);
    const events = guidance.map((item) => {
      const payload: Record<string, unknown> = {
        title: 'User guidance',
        summary: providerStreamCoordinator.userGuidanceConsumedSummary(language),
        status: 'consumed',
        guidanceId: item.id,
        targetRunId: state.runId,
        targetInteractionKind: 'runningRunGuidance',
        effectiveCheckpoint: 'nextProviderCall',
        checkpointKind: 'userGuidance',
        appliedAtProviderStage: stage,
        source: 'session',
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'body',
      };
      return this.event(state.sessionId, 'user_guidance', payload);
    });
    await this.append(state.sessionId, events);
    return [{
      role: 'user',
      content: [
        'User guidance received before the provider resume. Apply it to the next response or tool decision without starting a parallel run:',
        ...guidance.map((item) => `- ${item.id}: ${clip(item.content, 1200)}`),
      ].join('\n'),
    }];
  }

  private async repairResourceRequest(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    resolution: ResourceRequestResolution
  ): Promise<ProposalEnvelope> {
    const raw = await this.llm(
      input.profileId,
      state,
      'resource_request_repair',
      providerRepairMessageBuilder.resourceRequestRepairMessages(
        prompt,
        providerRepairMessageState(state),
        proposal,
        resourceRequestLoop.resolutionDiagnostic(resolution).fallback
      )
    );
    try {
      return protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds: ['resourceRequest', 'decisionRequest', 'diagnostic'],
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'agent_protocol_repair_failed',
        `Model resourceRequest output still could not be parsed after repair: ${normalizeParseError(error).message}`
      );
    }
  }

  private async repairActionBundleAdmission(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    reasons: string[],
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    if (state.actionBundleAdmissionRepairAttempted) {
      return this.append(state.sessionId, actionBundleAdmissionFailureEvents(
        state.sessionId,
        state.runId,
        proposal,
        reasons,
        this.ts(),
        this.id('action-bundle-admission-failed')
      )) ?? fallback;
    }
    state.actionBundleAdmissionRepairAttempted = true;
    let result = await this.append(state.sessionId, [
      actionBundleAdmissionRepairingEvent(
        state.sessionId,
        state.runId,
        proposal,
        reasons,
        this.ts(),
        this.id('action-bundle-admission-repairing')
      ),
    ]) ?? fallback;

    let repaired: ProposalEnvelope;
    try {
      const raw = await this.llm(
        input.profileId,
        state,
        'action_bundle_admission_repair',
        providerRepairMessageBuilder.actionBundleAdmissionRepairMessages(prompt, providerRepairMessageState(state), proposal, reasons)
      );
      repaired = protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds: ['taskPlan', 'resourceRequest', 'decisionRequest', 'diagnostic'],
      });
    } catch (error) {
      const message = error instanceof SessionDriverLoopError ? error.message : normalizeParseError(error).message;
      return this.append(state.sessionId, actionBundleAdmissionFailureEvents(
        state.sessionId,
        state.runId,
        proposal,
        [`actionBundle admission repair failed: ${message}`],
        this.ts(),
        this.id('action-bundle-admission-repair-failed')
      )) ?? result;
    }

    if (repaired.kind === 'actionBundle') {
      return this.submitActionProposal(input, state, prompt, repaired, result);
    }
    if (repaired.kind === 'resourceRequest') {
      const generated = generatedArtifactEvidenceIndex().packetForRequest(
        state,
        repaired.payload as ResourceRequestDraft,
        this.id('action-bundle-admission-generated-resource')
      );
      if (generated.packet) {
        state.resourcePackets.push(generated.packet);
        result = await this.append(state.sessionId, [
          resourceRequestLoop.packetEvent(state.sessionId, generated.packet, this.ts(), this.id('action-bundle-admission-generated-resource-context')),
        ]) ?? result;
      }
      const subset = resourceRequestResolver().resolve(state.manifest, generated.remaining, state.conversationRoots);
      if (!subset.manifest.entries.length) {
        if (!generated.packet) {
          const diagnostic = resourceRequestLoop.resolutionDiagnostic(subset);
          return this.append(state.sessionId, actionBundleAdmissionFailureEvents(
            state.sessionId,
            state.runId,
            proposal,
            [`actionBundle admission repair returned resourceRequest that cannot be resolved: ${diagnostic.fallback}`],
            this.ts(),
            this.id('action-bundle-admission-resource-invalid')
          )) ?? result;
        }
      } else {
        const packet = await this.resolveResources(state, subset.manifest);
        state.resourcePackets.push(packet);
        resourceRequestLoop.addDiscoveredManifestEntries(state.manifest, packet);
        result = await this.append(state.sessionId, [
          resourceRequestLoop.packetEvent(state.sessionId, packet, this.ts(), this.id('action-bundle-admission-resource-context')),
        ]) ?? result;
      }
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: actionBundleAdmissionResourceFollowupRequest(state, reasons),
        attachments: input.attachments ?? [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
        resumeResourcePackets: true,
      });
    }
    if (repaired.kind === 'decisionRequest') {
      const requirement = requirementRecordFromProposal(repaired, input, state, this.ts());
      const confirmation = requirementConfirmationEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        requirement,
        proposal: repaired,
        originalUserRequest: input.content,
        attachments: input.attachments ?? [],
        ts: this.ts(),
        id: this.id('action-bundle-admission-decision'),
      });
      state.phase = 'waiting_plan_review';
      return this.append(state.sessionId, [
        confirmation,
        sessionRunStateEvent({
          sessionId: state.sessionId,
          runId: state.runId,
          phase: 'waiting_plan_review',
          reason: 'requirement',
          decisionOwner: {
            kind: 'requirement',
            runId: state.runId,
            targetId: requirement.requirementId,
            requirementId: requirement.requirementId,
          },
          ts: this.ts(),
          id: this.id('session-run-waiting-action-bundle-admission-decision'),
        }),
      ]) ?? result;
    }
    if (repaired.kind === 'taskPlan' || repaired.kind === 'implementationPlan') {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          diag(
            'actionBundleAdmissionRepairReturnedPlan',
            'Action-bundle admission repair returned a plan proposal during execution. Session will not switch execution repair back into plan review; request a scoped actionBundle, resourceRequest, decisionRequest, or diagnostic instead.',
            { returnedKind: repaired.kind, proposalId: repaired.proposalId }
          ),
          this.ts(),
          this.id('action-bundle-admission-repair-plan-forbidden')
        ),
      ]) ?? result;
    }
    if (repaired.kind === 'answer') {
      return this.append(state.sessionId, [answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]) ?? result;
    }
    if (repaired.kind === 'diagnostic') {
      const diagnostic = objectRecord(repaired.payload) ?? {};
      const summary = stringValue(diagnostic.summary)
        ?? stringValue(diagnostic.details)
        ?? 'actionBundle admission repair returned a diagnostic instead of a file-level plan.';
      return this.append(state.sessionId, [
        finalDiagnosticEvent(state.sessionId, summary, this.ts(), this.id('action-bundle-admission-diagnostic')),
      ]) ?? result;
    }
    return this.submitNonExecutableProposal(state, repaired, result);
  }

  private async resolveResources(
    state: SessionDriverLoopRunState,
    manifest: ResourceManifest
  ): Promise<ResourcePacket> {
    const packet = await resourceRequestLoop.resolvePacket(state, manifest, {
      kernelCommand: (request) => this.kernel(request),
      createId: (prefix) => this.id(prefix),
    });
    if (!packet) {
      throw new SessionDriverLoopError('resource_packet_missing', 'Kernel ResourceResolve did not produce a ResourcePacket.');
    }
    return packet;
  }

  private async submitActionProposal(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const actionBundle = readActionBundle(proposal);
    if (actionBundle && state.acceptedImplementationPlan) {
      return this.submitAcceptedPlanActionProposal(input, state, prompt, proposal, fallback);
    }
    if (actionBundle) {
      const admissionBatch = proposalActionBundleAdmissionBatch(proposal);
      const admissionReasons = acceptedPlanBatchPreflight.deleteReasons(admissionBatch, state.resourcePackets);
      if (admissionReasons.length) {
        return this.repairActionBundleAdmission(input, state, prompt, proposal, admissionReasons, fallback);
      }
    }
    const proposalReply = await this.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.id('proposal-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal,
      },
    });
    if (!actionBundle) return await this.appendProjectedKernelEvents(state.sessionId, proposalReply) ?? fallback;
    const reviewReport = planReviewReportAnalyzer.findReport(proposalReply.events);
    await providerTraceRecorder.append(state, 'plan_review_report', {
      proposalId: proposal.proposalId,
      report: reviewReport,
      events: proposalReply.events,
    }, this.ports);
    if (!reviewReport) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          diag('planProposalReviewedMissing', 'Kernel did not return a proposal.reviewed event for the actionBundle; Session will not display a confirmable plan.'),
          this.ts(),
          this.id('plan-review-missing')
        ),
      ]);
    }
    if (reviewReport && planReviewReportAnalyzer.needsRepair(reviewReport) && !state.planReviewRepairAttempted) {
      state.planReviewRepairAttempted = true;
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          'Kernel PlanReview requires additional proposal evidence; Session is running one controlled repair attempt.',
          this.ts(),
          this.id('plan-review-repair')
        ),
      ]);
      let repaired: ProposalEnvelope;
      try {
        repaired = await this.repairPlanReview(input, state, prompt, proposal, reviewReport);
      } catch (error) {
        const message = error instanceof SessionDriverLoopError ? error.message : String(error);
        return this.append(state.sessionId, [
          finalDiagnosticEvent(
            state.sessionId,
            diag('planRevisionRepairFailed', `The plan needs revision, but model repair failed: ${message}`, { message }),
            this.ts(),
            this.id('plan-review-repair-failed')
          ),
        ]);
      }
      if (repaired.kind === 'actionBundle') {
        return this.submitActionProposal(input, state, prompt, repaired, fallback);
      }
      if (repaired.kind === 'answer') {
        return this.append(state.sessionId, [answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]);
      }
      return this.submitNonExecutableProposal(state, repaired, fallback);
    }
    let result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply);
    if (planReviewReportAnalyzer.denied(reviewReport)) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          diag('planRejected', `Kernel rejected the plan: ${planReviewReportAnalyzer.diagnosticSummary(reviewReport)}`, { reasons: planReviewReportAnalyzer.diagnosticSummary(reviewReport) }),
          this.ts(),
          this.id('plan-review-denied')
        ),
      ]);
    }
    const planCard = planProjectionBuilder.actionBundlePlanCardEvent({
      state,
      proposal,
      report: reviewReport,
      ts: this.ts(),
      id: this.id('plan-card'),
    });
    const planId = stringValue(objectRecord(planCard.payload)?.planId) ?? proposal.proposalId;
    state.phase = 'waiting_plan_review';
    result = await this.append(state.sessionId, [
      planCard,
      sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_plan_review',
        reason: 'plan_review',
        decisionOwner: {
          kind: 'plan',
          runId: state.runId,
          targetId: planId,
          planId,
        },
        ts: this.ts(),
        id: this.id('session-run-waiting-plan'),
      }),
    ]);
    return result ?? fallback;
  }

  private async submitAcceptedPlanActionProposal(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const accepted = state.acceptedImplementationPlan;
    const actionBundle = readActionBundle(proposal);
    if (!accepted || !actionBundle) return fallback;

    const readOnlyActionResult = await this.tryCompleteAcceptedPlanReadOnlyActionBundle(
      input,
      state,
      prompt,
      proposal,
      fallback
    );
    if (readOnlyActionResult) return readOnlyActionResult;

    const assessment = acceptedPlanExecutor.assessActionProposal({
      accepted,
      proposal,
      actionBundle,
      resourcePackets: state.resourcePackets,
      scopeRepairAttempted: state.acceptedPlanScopeRepairAttempted,
      admission: acceptedPlanAdmission(),
      canonicalizeAccessScopes: canonicalizeAcceptedPlanExecutionAccessScopes,
    });
    if (assessment.kind === 'missingActionBundle') return fallback;
    if (assessment.kind === 'deterministicScopeIntervention') {
      return this.appendAcceptedPlanBatchOutOfScope(input, state, proposal, assessment.validation);
    }
    if (assessment.kind === 'scopeRepair') {
      state.acceptedPlanScopeRepairAttempted = true;
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          'The current execution batch is outside the confirmed current-task scope; Session is asking the model to continue the current task or request additional authorization.',
          this.ts(),
          this.id('accepted-plan-scope-repair'),
          {
            messageKey: 'session.driver.acceptedPlanScopeRepair',
            messageArgs: {},
          }
        ),
      ]);
      try {
        const repaired = await this.repairAcceptedPlanScope(input, state, prompt, proposal, assessment.validation);
        if (repaired.kind === 'actionBundle') {
          return this.submitAcceptedPlanActionProposal(input, state, prompt, repaired, fallback);
        }
        if (repaired.kind === 'resourceRequest') {
          let result = fallback;
          const generated = generatedArtifactEvidenceIndex().packetForRequest(
            state,
            repaired.payload as ResourceRequestDraft,
            this.id('accepted-plan-repair-generated-resource')
          );
          if (generated.packet) {
            state.resourcePackets.push(generated.packet);
            result = await this.append(state.sessionId, [
              resourceRequestLoop.packetEvent(state.sessionId, generated.packet, this.ts(), this.id('accepted-plan-repair-generated-resource-context')),
            ]) ?? result;
          }
          const subset = resourceRequestResolver().resolve(state.manifest, generated.remaining, state.conversationRoots);
          if (!subset.manifest.entries.length) {
            if (!generated.packet) {
              const diagnostic = resourceRequestLoop.resolutionDiagnostic(subset);
              return this.append(state.sessionId, [
                finalDiagnosticEvent(
                  state.sessionId,
                  diag(
                    'autoBatchResourceResolveFailed',
                    `Automatic execution batch requires additional resource evidence, but the repaired resourceRequest could not be located: ${diagnostic.fallback}`,
                    { detail: diagnostic.fallback }
                  ),
                  this.ts(),
                  this.id('accepted-plan-scope-repair-resource-invalid')
                ),
              ]);
            }
          } else {
            const packet = await this.resolveResources(state, subset.manifest);
            state.resourcePackets.push(packet);
            resourceRequestLoop.addDiscoveredManifestEntries(state.manifest, packet);
            result = await this.append(state.sessionId, [
              resourceRequestLoop.packetEvent(state.sessionId, packet, this.ts(), this.id('accepted-plan-repair-resource-context')),
            ]) ?? result;
          }
          return this.runUserTurn({
            sessionId: input.sessionId,
            content: implementationPlanExecutionRequest(
              acceptedPlanExecutionContext(state, proposal, {}),
              accepted,
              [
                'Session has resolved the read-only search/read evidence required for the current edit.',
                'Use the ResourcePacket evidence to continue the same accepted taskPlan cursor.',
                'If evidence is sufficient and the current task remains in scope, output the next actionBundle.',
                'If evidence is still missing, output a focused resourceRequest.',
                'If scope must expand, output decisionRequest instead of guessing.',
                'Write user-visible proposal fields in the current user request language; keep protocol keys, toolIds, paths, and evidence refs unchanged.',
              ].join('\n')
            ),
            attachments: accepted.executionRoot ? [accepted.executionRoot.attachment] : [],
            existingEvents: result.events,
            workspaceBinding: input.workspaceBinding,
            projectWorkingDirectory: input.projectWorkingDirectory,
            profileId: input.profileId,
            workflow: input.workflow,
            appendUserMessage: false,
            requirementConfirmationMode: 'off',
            reviewContinuationMode: input.reviewContinuationMode,
            interventionLevel: input.interventionLevel,
            projectMemoryMode: input.projectMemoryMode,
            resumeResourcePackets: true,
            acceptedImplementationPlan: accepted,
          });
        }
        if (repaired.kind === 'decisionRequest') {
          const requirement = requirementRecordFromProposal(repaired, input, state, this.ts());
          const interactionOverlay: InteractionOverlayContext = {
            parentRunId: state.runId,
            parentPhase: 'executing_accepted_plan',
            interactionRunId: state.runId,
            interactionId: requirement.requirementId,
            sourceInteractionId: repaired.proposalId,
          };
          const confirmation = requirementConfirmationEvent({
            sessionId: state.sessionId,
            runId: state.runId,
            requirement,
            proposal: repaired,
            originalUserRequest: input.content,
            attachments: input.attachments ?? [],
            interactionOverlay,
            ts: this.ts(),
            id: this.id('accepted-plan-scope-repair-decision'),
          });
          state.phase = 'waiting_permission';
          return this.append(state.sessionId, [
            confirmation,
            sessionRunStateEvent({
              sessionId: state.sessionId,
              runId: state.runId,
              phase: 'waiting_permission',
              reason: 'requirement',
              decisionOwner: {
                kind: 'requirement',
                runId: state.runId,
                targetId: requirement.requirementId,
                requirementId: requirement.requirementId,
              },
              interactionOverlay,
              ts: this.ts(),
              id: this.id('session-run-waiting-accepted-plan-repair-decision'),
            }),
          ]);
        }
        if (repaired.kind === 'taskPlan' || repaired.kind === 'implementationPlan') {
          return this.append(state.sessionId, [
            finalDiagnosticEvent(
              state.sessionId,
              diag(
                'acceptedPlanScopeRepairReturnedPlan',
                'Accepted-plan execution repair returned a plan proposal. Session will not re-enter plan review from an accepted task; request a scoped actionBundle, resourceRequest, decisionRequest, or diagnostic instead.',
                { returnedKind: repaired.kind, proposalId: repaired.proposalId }
              ),
              this.ts(),
              this.id('accepted-plan-scope-repair-plan-forbidden')
            ),
          ]);
        }
        return this.submitNonExecutableProposal(state, repaired, fallback);
      } catch (error) {
        return this.appendAcceptedPlanBatchOutOfScope(input, state, proposal, assessment.validation);
      }
    }

    const scopeCanonicalization = assessment.scopeCanonicalization;
    const executionProposal = scopeCanonicalization.proposal;
    state.phase = 'executing_accepted_plan';
    let result = fallback;
    if (scopeCanonicalization.changed) {
      result = await this.append(state.sessionId, [
        acceptedPlanAccessScopesCanonicalizedEvent(
          state.sessionId,
          state.runId,
          accepted,
          scopeCanonicalization,
          this.ts(),
          this.id('accepted-plan-access-scopes-canonicalized')
        ),
      ]) ?? result;
    }
    result = await this.append(state.sessionId, [
      sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'executing_accepted_plan',
        status: 'running',
        reason: 'accepted_plan_execution',
        decisionOwner: {
          kind: 'plan',
          runId: state.runId,
          targetId: accepted.planId,
          planId: accepted.planId,
        },
        ts: this.ts(),
        id: this.id('session-run-accepted-plan-execution'),
      }),
    ]) ?? result;

    const proposalReply = await this.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.id('proposal-submit-accepted-plan'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal: executionProposal,
      },
    });
    const reviewReport = planReviewReportAnalyzer.findReport(proposalReply.events);
    await providerTraceRecorder.append(state, 'accepted_plan_batch_review_report', {
      acceptedPlanId: accepted.planId,
      proposalId: proposal.proposalId,
      report: reviewReport,
      events: proposalReply.events,
    }, this.ports);
    if (!reviewReport) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          diag('autoPlanProposalReviewedMissing', 'Kernel did not return a proposal.reviewed event for the accepted-plan actionBundle; Session will not auto-execute this batch.'),
          this.ts(),
          this.id('accepted-plan-review-missing')
        ),
      ]);
    }
    if (reviewReport && planReviewReportAnalyzer.acceptedPlanNeedsRepair(reviewReport) && !state.planReviewRepairAttempted) {
      state.planReviewRepairAttempted = true;
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          'Kernel PlanReview requires revising the current accepted-plan batch; Session is running one controlled repair attempt.',
          this.ts(),
          this.id('accepted-plan-review-repair')
        ),
      ]);
      let repaired: ProposalEnvelope;
      try {
        repaired = await this.repairPlanReview(input, state, prompt, executionProposal, reviewReport);
      } catch (error) {
        const message = error instanceof SessionDriverLoopError ? error.message : String(error);
        return this.append(state.sessionId, [
          finalDiagnosticEvent(
            state.sessionId,
            diag('autoBatchRevisionRepairFailed', `The automatic execution batch needs revision, but model repair failed: ${message}`, { message }),
            this.ts(),
            this.id('accepted-plan-review-repair-failed')
          ),
        ]);
      }
      if (repaired.kind === 'actionBundle') {
        return this.submitAcceptedPlanActionProposal(input, state, prompt, repaired, fallback);
      }
      if (repaired.kind === 'answer') {
        return this.append(state.sessionId, [answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]);
      }
      return this.submitNonExecutableProposal(state, repaired, fallback);
    }

    result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply) ?? result;
    if (planReviewReportAnalyzer.denied(reviewReport)) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          diag('autoBatchRejected', `Kernel rejected the automatic execution batch: ${planReviewReportAnalyzer.diagnosticSummary(reviewReport)}`, { reasons: planReviewReportAnalyzer.diagnosticSummary(reviewReport) }),
          this.ts(),
          this.id('accepted-plan-review-denied')
        ),
      ]);
    }
    if (reviewReport.status === 'needsRevision') {
      return this.appendAcceptedPlanBatchOutOfScope(input, state, executionProposal, {
        ok: false,
        reasons: [`Kernel PlanReview requires revising the current batch: ${planReviewReportAnalyzer.diagnosticSummary(reviewReport)}`],
      });
    }

    const autoGrantBlockers = nonAcceptedPlanPermissionGaps(reviewReport, accepted);
    if (autoGrantBlockers.length) {
      return this.appendAcceptedPlanBatchOutOfScope(input, state, executionProposal, {
        ok: false,
        reasons: autoGrantBlockers.map((capability) => `The current batch requires additional permission ${capability}, which is outside the accepted taskPlan automatic execution scope.`),
      });
    }

    const plan = acceptedPlanExecutionContext(state, executionProposal, reviewReport);
    const grantEvents: unknown[] = [];
    for (const grant of planReviewGrantProjector.temporaryGrantsForPlan(plan)) {
      const grantReply = await this.kernel({
        command: {
          kind: 'permissionGrantTemporary',
          requestId: this.id('accepted-plan-temp-grant'),
          runId: state.runId,
          grant,
        },
      });
      grantEvents.push(...(grantReply.events ?? []));
    }
    if (grantEvents.length) {
      result = await this.appendProjectedKernelEvents(state.sessionId, { ok: true, events: grantEvents }) ?? result;
    }

    const normalizedBatch = normalizeAcceptedPlanKernelBatch(accepted.planId, plan, accepted);
    if (!normalizedBatch.ok) {
      return this.append(state.sessionId, acceptedPlanNormalizationFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        normalizedBatch.reasons,
        this.ts(),
        this.id('accepted-plan-batch-normalization-failed')
      )) ?? result;
    }
    const batch = normalizedBatch.batch;
    const deletePreflightReasons = acceptedPlanBatchPreflight.deleteReasons(batch, state.resourcePackets);
    if (deletePreflightReasons.length) {
      return this.append(state.sessionId, acceptedPlanNormalizationFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        deletePreflightReasons,
        this.ts(),
        this.id('accepted-plan-delete-preflight-failed')
      )) ?? result;
    }
    await providerTraceRecorder.append(state, 'accepted_plan.action_batch_preflight', {
      planId: accepted.planId,
      batchIndex: accepted.batchIndex,
      audit: acceptedPlanBatchPreflight.audit(batch),
    }, this.ports);

    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'accepted_plan.action_batch_submit',
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: acceptedPlanBatchActivitySummary(batch),
      activity: acceptedPlanBatchActivity(accepted, batch, 'running'),
      payload: {
        visibility: 'task',
        planId: accepted.planId,
        batchIndex: accepted.batchIndex,
        actionCount: Array.isArray((batch as Record<string, unknown>).actions)
          ? ((batch as Record<string, unknown>).actions as unknown[]).length
          : undefined,
      },
    });

    const batchReply = await this.kernel({
      command: {
        kind: 'actionBatchSubmit',
        requestId: this.id('accepted-plan-action-batch-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        batch,
      },
    });
    await this.emitKernelActivityDeltas(state, batchReply.events ?? [], 'accepted_plan.action_batch_submit');
    result = await this.appendProjectedKernelEvents(state.sessionId, batchReply) ?? result;
    const batchEvents = batchReply.events ?? [];
    if (kernelEventStatusIndex.hasFailureOrBlocker(batchEvents)) {
      return this.append(state.sessionId, acceptedPlanExecutionFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        batchEvents,
        batch,
        this.ts(),
        this.id('accepted-plan-batch-failed')
      )) ?? result;
    }
    const generatedPacket = generatedArtifactEvidenceIndex().packetFromSuccessfulBatch(
      state,
      batch,
      batchEvents,
      this.id('generated-artifact-evidence')
    );
    if (generatedPacket) {
      generatedArtifactEvidenceIndex().indexPacket(state.generatedArtifactEvidence, generatedPacket);
      state.resourcePackets.push(generatedPacket);
      result = await this.append(state.sessionId, [
        resourceRequestLoop.packetEvent(state.sessionId, generatedPacket, this.ts(), this.id('accepted-plan-generated-artifact-evidence')),
      ]) ?? result;
    }
    if (!kernelEventStatusIndex.actionBatchReadyForReview(batchReply.events ?? [])) {
      if (kernelEventStatusIndex.hasPermissionRequest(batchReply.events ?? [])) {
        const permissionId = kernelEventStatusIndex.permissionId(batchReply.events ?? []);
        return this.append(state.sessionId, [
          sessionRunStateEvent({
            sessionId: state.sessionId,
            runId: state.runId,
            phase: 'waiting_permission',
            reason: 'permission',
            decisionOwner: {
              kind: 'permission',
              runId: state.runId,
              targetId: permissionId,
              permissionId,
              planId: accepted.planId,
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-permission'),
          }),
        ]) ?? result;
      }
      return result;
    }
    const batchProgress = acceptedPlanBatchProgress(accepted, executionProposal, batchReply.events ?? []);
    const nextAccepted = acceptedPlanAfterBatch(accepted, batchProgress.completedTaskIds);
    refreshTaskExecutionState(state);
    const savepointId = this.id('accepted-plan-task-savepoint');
    result = await this.append(state.sessionId, [
      acceptedPlanBatchCheckpointEvent(
        state.sessionId,
        state.runId,
        accepted,
        executionProposal,
        batchReply.events ?? [],
        batchProgress,
        this.ts(),
        this.id('accepted-plan-batch-checkpoint')
      ),
      acceptedPlanTaskSavepointEvent(
        state.sessionId,
        state.runId,
        accepted,
        nextAccepted,
        batchProgress,
        batchReply.events ?? [],
        state.taskExecutionCursor,
        state.currentTaskContext,
        this.ts(),
        savepointId
      ),
    ]) ?? result;
    if (state.taskExecutionCursor) state.taskExecutionCursor.lastSavepointId = savepointId;

    if (!kernelEventStatusIndex.hasFailureOrBlocker(batchReply.events ?? []) && !acceptedPlanComplete(nextAccepted)) {
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: implementationPlanExecutionRequest(
          { ...acceptedPlanExecutionContext(state, executionProposal, reviewReport), implementationPlan: accepted.rawPlan },
          nextAccepted
        ),
        attachments: nextAccepted.executionRoot ? [nextAccepted.executionRoot.attachment] : [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
        resumeResourcePackets: true,
        acceptedImplementationPlan: nextAccepted,
      });
    }

    const staticReviewEvents = await this.maybeRunStaticSyntaxReview(
      input,
      state,
      prompt,
      accepted,
      batch,
      batchEvents
    );
    if (staticReviewEvents.length) {
      result = await this.append(state.sessionId, staticReviewEvents) ?? result;
    }

    const factsReply = await this.kernel({
      command: {
        kind: 'reviewFactsGet',
        requestId: this.id('accepted-plan-review-facts-get'),
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });
    result = await this.appendProjectedKernelEvents(state.sessionId, factsReply) ?? result;
    const reviewKernelEvents = ReviewFactsAggregator.acceptedPlanKernelEvents(
      result.events,
      state.runId,
      accepted.planId,
      [...(batchReply.events ?? []), ...staticReviewEvents.map((event) => event.payload), ...(factsReply.events ?? [])]
    );
    const review = reviewSummaryEvent(
      state.sessionId,
      plan,
      reviewKernelEvents,
      this.ts(),
      this.id('review-summary')
    );
    const reviewPayload = objectRecord(review.payload) ?? {};
    return this.append(state.sessionId, [
      review,
      sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_review',
        reason: 'review',
        decisionOwner: {
          kind: 'review',
          runId: state.runId,
          targetId: stringValue(reviewPayload.reviewId) ?? state.runId,
          reviewId: stringValue(reviewPayload.reviewId) ?? state.runId,
          planId: accepted.planId,
        },
        ts: this.ts(),
        id: this.id('session-run-waiting-review'),
      }),
    ]) ?? result;
  }

  private async appendAcceptedPlanBatchOutOfScope(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    proposal: ProposalEnvelope,
    validation: AcceptedPlanBatchValidationResult
  ): Promise<AgentSessionResult> {
    const decisionProposal = acceptedPlanScopeIntervention((prefix) => this.id(prefix)).createDecisionProposal({
      runId: state.runId,
      sessionId: state.sessionId,
      userRequest: state.userRequest,
      acceptedPlan: state.acceptedImplementationPlan,
      currentTaskId: state.currentTaskContext?.taskId,
    }, proposal, validation);
    const requirement = requirementRecordFromProposal(decisionProposal, input, state, this.ts());
    const interactionOverlay: InteractionOverlayContext = {
      parentRunId: state.runId,
      parentPhase: 'executing_accepted_plan',
      interactionRunId: state.runId,
      interactionId: requirement.requirementId,
      sourceInteractionId: proposal.proposalId,
    };
    const confirmation = requirementConfirmationEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      requirement,
      proposal: decisionProposal,
      originalUserRequest: input.content,
      attachments: input.attachments ?? [],
      interactionOverlay,
      ts: this.ts(),
      id: this.id('accepted-plan-scope-confirmation'),
    });
    state.phase = 'waiting_permission';
    return this.append(state.sessionId, [
      confirmation,
      sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_permission',
        reason: 'requirement',
        decisionOwner: {
          kind: 'requirement',
          runId: state.runId,
          targetId: requirement.requirementId,
          requirementId: requirement.requirementId,
        },
        interactionOverlay,
        ts: this.ts(),
        id: this.id('session-run-waiting-accepted-plan-scope'),
      }),
    ]);
  }

  private async repairPlanReview(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    report: Record<string, unknown>
  ): Promise<ProposalEnvelope> {
    const raw = await this.llm(
      input.profileId,
      state,
      'plan_review_repair',
      providerRepairMessageBuilder.planReviewRepairMessages(prompt, providerRepairMessageState(state), proposal, report)
    );
    try {
      return protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'agent_protocol_repair_failed',
        `Model plan output still could not be parsed after repair: ${normalizeParseError(error).message}`
      );
    }
  }

  private async repairAcceptedPlanScope(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    validation: AcceptedPlanBatchValidationResult
  ): Promise<ProposalEnvelope> {
    const raw = await this.llm(
      input.profileId,
      state,
      'accepted_plan_scope_repair',
      providerRepairMessageBuilder.acceptedPlanScopeRepairMessages(prompt, providerRepairMessageState(state), proposal, validation.reasons)
    );
    try {
      return protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
        allowBriefActionBundleUserPlan: true,
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'accepted_plan_scope_repair_failed',
        `Accepted-plan scope repair output still could not be parsed after repair: ${normalizeParseError(error).message}`
      );
    }
  }

  private async submitNonExecutableProposal(
    state: SessionDriverLoopRunState,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const proposalReply = await this.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.id('proposal-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal,
      },
    });
    const result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply);
    return result ?? fallback;
  }

  private async llm(
    profileId: string | undefined,
    state: SessionDriverLoopRunState,
    stage: string,
    messages: LlmChatRequest['messages']
  ): Promise<string> {
    const turn = await this.llmTurn(profileId, state, stage, messages, {
      responseFormat: { type: 'json_object' },
    });
    if (!turn.content.trim()) {
      throw new SessionDriverLoopError('llm_empty_response', 'LLM provider returned an empty response.');
    }
    return turn.content;
  }

  private async llmTurn(
    profileId: string | undefined,
    state: SessionDriverLoopRunState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: Pick<LlmChatRequest, 'responseFormat' | 'tools'> = {}
  ): Promise<LlmTurnResult> {
    const jsonModeMessages = providerJsonModeCoordinator.ensureMessages(messages, options.responseFormat);
    await providerTraceRecorder.append(state, `${stage}.request`, {
      profileId,
      messages: jsonModeMessages,
      cachePlan: state.cachePlan,
      contextAssembly: state.contextAssembly,
      responseFormat: options.responseFormat,
      responseFormatAudit: providerJsonModeCoordinator.audit(messages, options.responseFormat),
    }, this.ports);
    await this.emitProjectionDelta(state, {
      type: 'active_turn',
      stage,
      status: this.ports.llmChatStream ? 'streaming' : 'running',
      channel: 'progress',
      source: 'session',
      summary: providerStreamCoordinator.stageSummary(stage, 'request', visibleLanguageForRequest(state.userRequest)),
      activity: providerActivity(state, stage, 'running'),
    });
    const request: LlmChatRequest = {
      profileId,
      messages: jsonModeMessages,
      responseFormat: options.responseFormat,
      tools: options.tools,
      stream: Boolean(this.ports.llmChatStream),
      providerOptions: {
        deepcode: {
          cachePlan: state.cachePlan,
        },
      },
    };
    const toolCallBuffer = new ProviderToolCallBuffer({
      parseArguments: (raw, toolName) => nativeToolCoordinator.parseArguments(raw, toolName),
      normalizeToolName: (name) => nativeToolCoordinator.normalizeToolName(name),
    });
    const reasoningBuffer: ProviderReasoningDeltaBuffer = {
      pending: '',
      lastFlushAt: Date.now(),
      itemId: undefined,
    };
    let result = this.ports.llmChatStream
      ? await this.ports.llmChatStream(request, async (event) => {
        await this.handleLlmStreamEvent(state, stage, event, toolCallBuffer, reasoningBuffer);
      })
      : await this.ports.llmChat(request);
    await this.flushProviderReasoningBuffer(state, stage, reasoningBuffer);
    if (this.ports.llmChatStream && (!result.ok || !result.data)) {
      const fallbackRequest: LlmChatRequest = { ...request, stream: false };
      await providerTraceRecorder.append(state, `${stage}.stream_fallback.request`, {
        reason: result.message ?? result.error ?? 'streaming provider request failed',
        request: fallbackRequest,
      }, this.ports);
      result = await this.ports.llmChat(fallbackRequest);
    }
    if (!result.ok || !result.data) {
      await this.emitProjectionDelta(state, {
        type: 'error',
        stage,
        status: 'failed',
        channel: 'progress',
        source: 'provider',
        summary: result.message ?? result.error ?? 'LLM provider request failed.',
      });
      throw new SessionDriverLoopError(
        'llm_chat_failed',
        result.message ?? result.error ?? 'LLM provider request failed.'
      );
    }
    const cacheEvent = cacheTelemetryEvent(
      state.sessionId,
      profileId,
      state,
      stage,
      result.data,
      this.ts(),
      this.id(`cache-${stage}`)
    );
    if (cacheEvent) {
      await this.append(state.sessionId, [cacheEvent]);
    }
    await providerTraceRecorder.append(state, `${stage}.response`, result.data, this.ports);
    const reasoning = collectReasoning(result.data);
    if (reasoning.trim()) {
      await this.append(state.sessionId, [
        reasoningEvent(state.sessionId, reasoning, this.ts(), this.id(`reasoning-${stage}`)),
      ]);
    }
    await this.emitProjectionDelta(state, {
      type: 'active_turn',
      stage,
      status: 'completed',
      channel: 'progress',
      source: 'provider',
      summary: providerStreamCoordinator.stageSummary(stage, 'response', visibleLanguageForRequest(state.userRequest)),
      activity: providerActivity(state, stage, 'completed'),
    });
    const content = stripProviderPartFrames(result.data.assistantMessage?.content
      ?? result.data.chunks
        .filter((chunk) => chunk.type === 'delta' && typeof chunk.content === 'string')
        .map((chunk) => chunk.content)
        .join(''));
    let toolCalls: NativeToolCallProposal[];
    try {
      toolCalls = nativeToolCoordinator.collectCalls(result.data, toolCallBuffer);
    } catch (error) {
      if (error instanceof NativeToolCoordinatorError) {
        throw new SessionDriverLoopError(error.code, error.message);
      }
      throw error;
    }
    if (!content.trim() && toolCalls.length === 0) {
      throw new SessionDriverLoopError('llm_empty_response', 'LLM provider returned an empty response.');
    }
    return {
      result: result.data,
      content,
      reasoning,
      toolCalls,
    };
  }

  private async handleLlmStreamEvent(
    state: SessionDriverLoopRunState,
    stage: string,
    event: LlmChatStreamEvent,
    toolCallBuffer: ProviderToolCallBuffer,
    reasoningBuffer: ProviderReasoningDeltaBuffer
  ): Promise<void> {
    const chunk = event.chunk;
    if (event.type === 'provider_delta' && chunk?.content) {
      const frames = this.consumeProviderPartFrames(state, stage, chunk.content);
      for (const frame of frames) {
        await this.submitProviderPartFrame(state, stage, frame);
      }
      if (providerStreamCoordinator.exposesAssistantDelta(stage)) {
        await this.emitProjectionDelta(state, {
          type: 'assistant_delta',
          stage,
          status: 'streaming',
          channel: 'final',
          source: 'provider',
          itemId: chunk.callId,
          delta: chunk.content,
          payload: chunk.rawProvider,
        });
      } else if (providerStreamCoordinator.emitsJsonProgress(stage)) {
        await this.emitProviderJsonStreamProgress(state, stage, chunk.content);
      }
      return;
    }
    if (event.type === 'provider_reasoning_delta' && chunk?.content) {
      await this.bufferProviderReasoningDelta(state, stage, reasoningBuffer, chunk);
      return;
    }
    if (event.type === 'provider_tool_call_delta' && chunk) {
      const language = visibleLanguageForRequest(state.userRequest);
      toolCallBuffer.addChunk(chunk);
      await this.emitProjectionDelta(state, {
        type: 'tool_call_delta',
        stage,
        status: 'streaming',
        channel: 'tool',
        source: 'provider',
        itemId: chunk.callId ?? String(chunk.index ?? 0),
        delta: chunk.toolCallDelta?.argumentsDelta,
        summary: chunk.toolCallDelta?.name
          ? providerStreamCoordinator.toolCallPreparingSummary(chunk.toolCallDelta.name, language)
          : providerStreamCoordinator.toolCallStreamingSummary(language),
        activity: conversationActivity({
          activityId: `provider-tool-${chunk.callId ?? chunk.index ?? 0}`,
          kind: 'toolExecution',
          status: 'running',
          title: 'Provider tool call',
          summary: chunk.toolCallDelta?.name
            ? providerStreamCoordinator.toolCallPreparingSummary(chunk.toolCallDelta.name, language)
            : providerStreamCoordinator.toolCallStreamingSummary(language),
          source: 'provider',
          runId: state.runId,
          toolName: chunk.toolCallDelta?.name,
        }),
        payload: {
          index: chunk.index,
          callId: chunk.callId,
          finishReason: chunk.finishReason,
          toolCallDelta: chunk.toolCallDelta,
          rawProvider: chunk.rawProvider,
        },
      });
      return;
    }
    if (event.type === 'provider_usage') {
      await this.emitProjectionDelta(state, {
        type: 'stage_delta',
        stage,
        status: 'running',
        channel: 'progress',
        source: 'provider',
        summary: providerStreamCoordinator.usageSummary(visibleLanguageForRequest(state.userRequest)),
        payload: event.usage ?? chunk?.usage,
      });
      return;
    }
    if (event.type === 'provider_error') {
      await this.emitProjectionDelta(state, {
        type: 'error',
        stage,
        status: 'failed',
        channel: 'progress',
        source: 'provider',
        summary: event.error ?? chunk?.error ?? 'Provider stream error.',
        activity: conversationActivity({
          activityId: `provider-${stage}-stream-error`,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Provider stream error',
          summary: event.error ?? chunk?.error ?? 'Provider stream error.',
          source: 'provider',
          runId: state.runId,
        }),
        payload: event.rawProvider ?? chunk?.rawProvider,
      });
    }
  }

  private async bufferProviderReasoningDelta(
    state: SessionDriverLoopRunState,
    stage: string,
    buffer: ProviderReasoningDeltaBuffer,
    chunk: LlmChatResult['chunks'][number]
  ): Promise<void> {
    if (typeof chunk.content !== 'string' || chunk.content.length === 0) return;
    buffer.pending += chunk.content;
    buffer.itemId = chunk.callId ?? buffer.itemId;
    const now = Date.now();
    if (
      buffer.pending.length < PROVIDER_REASONING_FLUSH_CHARS &&
      now - buffer.lastFlushAt < PROVIDER_REASONING_FLUSH_MS
    ) {
      return;
    }
    await this.flushProviderReasoningBuffer(state, stage, buffer);
  }

  private async flushProviderReasoningBuffer(
    state: SessionDriverLoopRunState,
    stage: string,
    buffer: ProviderReasoningDeltaBuffer
  ): Promise<void> {
    if (!buffer.pending) return;
    const delta = buffer.pending;
    buffer.pending = '';
    buffer.lastFlushAt = Date.now();
    await this.emitProjectionDelta(state, {
      type: 'reasoning_delta',
      stage,
      status: 'streaming',
      channel: 'reasoning',
      source: 'provider',
      itemId: buffer.itemId,
      delta,
      activity: providerActivity(state, stage, 'running'),
      payload: {
        presentation: 'reasoningTrace',
        streamMode: 'markdownBlocks',
        buffered: true,
      },
    });
  }

  private async emitProjectionDelta(
    state: SessionDriverLoopRunState,
    delta: Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>
  ): Promise<void> {
    if (!this.ports.onProjectionDelta) return;
    const activeTurn = state.activeTurn ?? {
      turnId: this.id('active-turn'),
      seq: 0,
      stage: delta.stage ?? 'provider_call',
    };
    activeTurn.seq += 1;
    activeTurn.stage = delta.stage ?? activeTurn.stage;
    state.activeTurn = activeTurn;
    const activity = delta.activity ?? kernelEventProjectionBuilder.projectionDeltaActivity({
      runId: state.runId,
      delta,
    });
    await this.ports.onProjectionDelta({
      ...delta,
      activity,
      sessionId: state.sessionId,
      runId: state.runId,
      turnId: activeTurn.turnId,
      seq: activeTurn.seq,
    });
  }

  private async emitProviderJsonStreamProgress(
    state: SessionDriverLoopRunState,
    stage: string,
    content: string
  ): Promise<void> {
    const activeTurn = state.activeTurn ?? {
      turnId: this.id('active-turn'),
      seq: 0,
      stage,
    };
    activeTurn.providerJsonStreamProgress ??= {};
    const progress = activeTurn.providerJsonStreamProgress[stage] ?? {
      receivedChars: 0,
      lastEmittedChars: 0,
    };
    progress.receivedChars += content.length;
    activeTurn.providerJsonStreamProgress[stage] = progress;
    state.activeTurn = activeTurn;

    const shouldEmit = progress.lastEmittedChars === 0 ||
      progress.receivedChars - progress.lastEmittedChars >= 1_500;
    if (!shouldEmit) return;
    progress.lastEmittedChars = progress.receivedChars;
    const language = visibleLanguageForRequest(state.userRequest);
    const summary = providerStreamCoordinator.jsonProgressSummary(language, progress.receivedChars);
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage,
      status: 'streaming',
      channel: 'progress',
      source: 'session',
      itemId: `${stage}-provider-json-progress`,
      summary,
      activity: providerActivity(state, stage, 'running'),
      payload: {
        stage,
        receivedChars: progress.receivedChars,
        rawJsonHidden: true,
        reason: 'proposal_json_stream_hidden_from_assistant',
      },
    });
  }

  private async emitKernelActivityDeltas(
    state: SessionDriverLoopRunState,
    kernelEvents: unknown[],
    stage: string
  ): Promise<void> {
    const workUnitFacts = kernelEventProjectionBuilder.indexKernelWorkUnitFacts(kernelEvents);
    for (let index = 0; index < kernelEvents.length; index += 1) {
      const record = objectRecord(kernelEvents[index]);
      if (!record) continue;
      const enriched = kernelEventProjectionBuilder.enrichKernelWorkUnitRecord(record, workUnitFacts);
      const activity = kernelEventProjectionBuilder.kernelEventActivity(enriched, `kernel-activity-${index}`, state.runId);
      if (!activity) continue;
      await this.emitProjectionDelta(state, {
        type: kernelEventProjectionBuilder.kernelActivityDeltaType(enriched),
        stage,
        status: kernelEventProjectionBuilder.projectionStatusForActivity(activity),
        channel: kernelEventProjectionBuilder.kernelActivityChannel(activity),
        source: 'kernel',
        itemId: activity.workUnitIds?.[0] ?? activity.actionIds?.[0] ?? activity.toolName ?? activity.activityId,
        targetPath: activity.targets?.[0],
        summary: activity.summary,
        activity,
        payload: {
          kernelEvent: enriched,
          activity,
        },
      });
    }
  }

  private consumeProviderPartFrames(
    state: SessionDriverLoopRunState,
    stage: string,
    content: string
  ): AgentStreamPartFrame[] {
    const activeTurn = state.activeTurn ?? {
      turnId: this.id('active-turn'),
      seq: 0,
      stage,
    };
    activeTurn.partFrameParser ??= new ProviderPartFrameParser();
    state.activeTurn = activeTurn;
    return activeTurn.partFrameParser.push(content);
  }

  private async submitProviderPartFrame(
    state: SessionDriverLoopRunState,
    stage: string,
    frame: AgentStreamPartFrame
  ): Promise<void> {
    const enrichedFrame = {
      ...frame,
      draftId: frame.draftId,
      targetPath: frame.targetPath,
    };
    await this.emitProjectionDelta(state, {
      type: 'part_delta',
      stage,
      status: 'streaming',
      channel: enrichedFrame.partKind === 'thinkingDelta' ? 'reasoning' : 'draft',
      source: 'session',
      itemId: enrichedFrame.frameId ?? enrichedFrame.draftId,
      draftId: enrichedFrame.draftId,
      targetPath: enrichedFrame.targetPath,
      delta: enrichedFrame.chunk,
      summary: enrichedFrame.summary ?? `Provider stream part: ${enrichedFrame.partKind}`,
      payload: enrichedFrame,
    });

    const reply = await this.ports.kernelCommand({
      requestId: this.id('draft-ledger-submit'),
      command: {
        kind: 'draftLedgerSubmit',
        requestId: this.id('draft-ledger'),
        runId: state.runId,
        sessionId: state.sessionId,
        frame: {
          ...enrichedFrame,
          runId: enrichedFrame.runId ?? state.runId,
        },
      },
    });
    if (!reply.ok) {
      await this.emitProjectionDelta(state, {
        type: 'error',
        stage,
        status: 'failed',
        channel: 'draft',
        source: 'kernel',
        itemId: enrichedFrame.frameId ?? enrichedFrame.draftId,
        draftId: enrichedFrame.draftId,
        targetPath: enrichedFrame.targetPath,
        summary: reply.error?.message ?? 'Kernel draft ledger rejected provider stream part.',
        payload: reply.error,
      });
      return;
    }
    for (const event of reply.events) {
      const record = objectRecord(event);
      await this.emitProjectionDelta(state, {
        type: 'draft_delta',
        stage,
        status: 'streaming',
        channel: 'draft',
        source: 'kernel',
        itemId: stringValue(record?.draftId) ?? enrichedFrame.draftId,
        draftId: stringValue(record?.draftId) ?? enrichedFrame.draftId,
        targetPath: enrichedFrame.targetPath,
        summary: stringValue(record?.summary) ?? stringValue(objectRecord(record?.draft)?.summary),
        payload: event,
      });
    }
  }

  private async kernel(request: KernelCommandEnvelope): Promise<KernelReply> {
    const reply = await this.ports.kernelCommand(request);
    if (!reply.ok) {
      throw new SessionDriverLoopError(
        reply.error?.code ?? 'kernel_command_failed',
        reply.error?.message ?? 'Kernel command failed.'
      );
    }
    return reply;
  }

  private async tryKernelAudit(
    sessionId: string,
    request: KernelCommandEnvelope,
    traceKind: AgentEvent['kind'],
    summary: string
  ): Promise<AgentSessionResult> {
    try {
      const reply = await this.ports.kernelCommand(request);
      if (reply.ok) {
        return this.appendProjectedKernelEvents(sessionId, reply);
      }
      return this.append(sessionId, [
        traceEvent(sessionId, traceKind, summary, this.ts(), this.id('kernel-audit-noop'), {
          errorCode: reply.error?.code ?? 'kernel_audit_failed',
          errorMessage: reply.error?.message ?? 'Kernel audit command failed.',
        }),
      ]);
    } catch (error) {
      return this.append(sessionId, [
        traceEvent(sessionId, traceKind, summary, this.ts(), this.id('kernel-audit-noop'), {
          errorCode: error instanceof SessionDriverLoopError ? error.code : 'kernel_audit_failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      ]);
    }
  }

  private async append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult> {
    return this.ports.appendEvents(sessionId, events);
  }

  private async appendConsumedUserGuidanceEvents(
    sessionId: string,
    result: AgentSessionResult,
    contextAssembly: ContextAssemblyRecord | undefined,
    runId: string,
    appliedAtProviderStage = 'provider_call'
  ): Promise<AgentSessionResult> {
    const consumedIds = contextAssembly?.consumedUserGuidanceIds ?? [];
    if (consumedIds.length === 0) return result;

    const alreadyConsumed = new Set<string>();
    const queuedGuidance = new Map<string, AgentEvent>();
    for (const event of result.events) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload) continue;
      const guidanceId = stringValue(payload.guidanceId) ?? event.id;
      if (stringValue(payload.status) === 'consumed') {
        alreadyConsumed.add(guidanceId);
      } else {
        queuedGuidance.set(guidanceId, event);
      }
    }

    const events: AgentEvent[] = [];
    for (const guidanceId of consumedIds) {
      if (alreadyConsumed.has(guidanceId)) continue;
      const source = queuedGuidance.get(guidanceId);
      if (!source) continue;
      const payload = objectRecord(source.payload) ?? {};
      events.push({
        id: this.id('user-guidance-consumed'),
        sessionId,
        ts: this.ts(),
        kind: 'user_guidance',
        payload: {
          title: 'User guidance',
          summary: '用户引导已进入下一次 provider prompt。',
          status: 'consumed',
          guidanceId,
          targetRunId: stringValue(payload.targetRunId) ?? stringValue(payload.runId) ?? runId,
          targetInteractionKind: stringValue(payload.targetInteractionKind) ?? 'runningRunGuidance',
          effectiveCheckpoint: 'nextProviderCall',
          checkpointKind: 'userGuidance',
          appliedAtProviderStage,
          source: 'session',
          channel: 'progress',
          visibility: 'conversation',
          presentation: 'body',
        },
      });
    }

    return events.length > 0 ? this.append(sessionId, events) : result;
  }

  private async appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult> {
    const workUnitFacts = kernelEventProjectionBuilder.indexKernelWorkUnitFacts(reply.events ?? []);
    const events = (reply.events ?? []).map((event) => {
      const record = objectRecord(event);
      const projected = record ? kernelEventProjectionBuilder.enrichKernelWorkUnitRecord(record, workUnitFacts) : event;
      return kernelEventProjectionBuilder.projectKernelEvent({
        sessionId,
        event: projected,
        ts: this.ts(),
        id: this.id('kernel'),
      });
    });
    if (events.length === 0) {
      return this.ports.appendEvents(sessionId, []);
    }
    return this.append(sessionId, events);
  }

  private event(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent {
    return {
      id: this.id(kind),
      sessionId,
      ts: this.ts(),
      kind,
      payload,
    };
  }

  private id(prefix: string): string {
    return this.ports.createId?.(prefix) ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private ts(): string {
    return this.ports.now?.() ?? new Date().toISOString();
  }
}

function isEmptyResponseError(error: unknown): boolean {
  return error instanceof SessionDriverLoopError && error.code === 'llm_empty_response';
}

function assertKernelReplyOk(reply: KernelReply, code: string, fallback: string): void {
  if (reply.ok) return;
  if ((reply.events ?? []).length > 0) return;
  throw new SessionDriverLoopError(code, kernelReplyErrorMessage(reply, fallback));
}

function kernelReplyErrorMessage(reply: KernelReply, fallback: string): string {
  const message = reply.error?.message?.trim();
  const code = reply.error?.code?.trim();
  if (message && code) return `${code}: ${message}`;
  return message || code || fallback;
}

export class SessionDriverLoopError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionDriverLoopError';
  }
}

function resourceManifestBuilder(): ResourceManifestBuilder {
  return new ResourceManifestBuilder({
    maxDerivedManifestEntries: MAX_DERIVED_MANIFEST_ENTRIES,
    resourceManifestMaxBytes: RESOURCE_MANIFEST_MAX_BYTES,
    comparablePath,
    isAbsolutePath,
    sanitizeId,
    objectRecord,
  });
}

function resourceRequestResolver(): ResourceRequestResolver {
  return new ResourceRequestResolver();
}

function resourceEvidenceIndex(): ResourceEvidenceIndex {
  return new ResourceEvidenceIndex({
    normalizeTarget: normalizePlanScope,
    clip,
  });
}

function generatedArtifactEvidenceIndex(): GeneratedArtifactEvidenceIndex {
  return new GeneratedArtifactEvidenceIndex({
    normalizeRelativePath,
    comparablePath,
    utf8Bytes,
    sanitizeId,
    joinFsPath,
    objectRecord,
    stringValue,
    uniqueStrings,
    batchActionRecords,
    actionEffectiveCapability,
    actionFileTargetPath,
    completedWorkUnitFacts: (events) => completedWorkUnitFactIndex.completedWorkUnitFacts(events),
    completedActionMatches: (actionId, targetPath, completed) =>
      completedWorkUnitFactIndex.completedActionMatches(actionId, targetPath, completed),
    codeBlockContent: (block) => completedWorkUnitFactIndex.codeBlockContent(block),
    resolveRelativePath: (value, rootId, roots) =>
      resourceRequestResolver().resolveRelativePath(value, rootId, roots),
  });
}

function implementationBatchContextBuilder(): ImplementationBatchContextBuilder {
  return new ImplementationBatchContextBuilder({
    objectRecord,
    stringArrayValue,
    concreteFileOperationTarget: (value) => planReviewGrantProjector.concreteFileOperationTarget(value),
    clip,
  });
}

function acceptedImplementationPlanContextBuilder(): AcceptedImplementationPlanContextBuilder {
  return new AcceptedImplementationPlanContextBuilder({
    objectRecord,
    stringValue,
    stringArrayValue,
    normalizePlanScope,
    uniqueStrings,
    acceptedPlanTaskTargets: (record) => acceptedPlanTargetParser.taskTargets(record),
    executionSliceRoleValue,
    exactOperationGrantsFromImplementationPlan: (plan, executionRoot) =>
      planReviewGrantProjector.exactOperationGrantsFromImplementationPlan(plan, executionRoot),
    exactOperationGrantsFromPlanReviewReport: (report, executionRoot) =>
      planReviewGrantProjector.exactOperationGrantsFromPlanReviewReport(report, executionRoot),
    accessScopesFromImplementationPlan: (plan) => planReviewGrantProjector.accessScopesFromImplementationPlan(plan),
    requiredAccessScopesFromReport: (report) => planReviewGrantProjector.requiredAccessScopesFromReport(report),
  });
}

function acceptedPlanAdmission(): AcceptedPlanAdmission {
  return new AcceptedPlanAdmission({
    scopeMatcher: new AcceptedPlanScopeMatcher(),
    fileOperationFreshnessReasons: fileOperationFreshnessValidationReasons,
  });
}

function acceptedPlanTaskLedger(): AcceptedPlanTaskLedgerCoordinator {
  return new AcceptedPlanTaskLedgerCoordinator();
}

function acceptedPlanScopeIntervention(createId: (prefix: string) => string): AcceptedPlanScopeIntervention {
  return new AcceptedPlanScopeIntervention({
    createId,
    visibleLanguageForRequest,
  });
}

function reviewAssembler(): ReviewAssembler {
  return new ReviewAssembler({
    completedWorkUnitFacts: (events) => completedWorkUnitFactIndex.completedWorkUnitFacts(events),
    batchActionRecords,
    actionEffectiveCapability,
    actionFileTargetPath,
    normalizeAcceptedPlanTargetScope: (value, accepted) =>
      acceptedPlanScopeMatcher.normalizeTargetScope(value, accepted),
    comparablePath,
    resourceTextForTarget: (packets, target) => resourceEvidenceIndex().textForTarget(packets, target),
  });
}

function reviewDecisionProjection(): ReviewDecisionProjectionBuilder {
  return new ReviewDecisionProjectionBuilder();
}

function implementationBatchHints(
  context: ImplementationBatchContext,
  acceptedPlan?: AcceptedImplementationPlanContext
): string[] {
  const hints = [
    `Implementation batch context: nextBatchIndex=${context.batchIndex}. Generate only the next reviewable batch when proposing side-effect actions.`,
    'Context boundary: plan cards and continuation expectations are intent only; they are not evidence that files exist or were modified.',
    'Authoritative generated-file facts come only from ResourcePacket contents, ToolCompleted(ok=true), or WorkUnitCompleted facts.',
  ];
  if (acceptedPlan) {
    const currentTask = acceptedPlan.tasks.find((task) => !acceptedPlan.completedTaskIds.includes(task.taskId));
    const currentTaskOperations = objectRecord(executionPromptCoordinator().sanitizedContext(acceptedPlan))?.currentTaskOperations;
    hints.push(
      `Accepted taskPlan active: planId=${acceptedPlan.planId}; currentTask=${currentTask?.taskId ?? 'complete'}; completedTasks=${acceptedPlan.completedTaskIds.length}/${acceptedPlan.tasks.length}. Automatic execution is allowed only for the current task when targets and capabilities stay inside the accepted plan.`,
      currentTask
        ? `Current accepted taskPlan task: taskId=${currentTask.taskId}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; capability=${currentTask.capability ?? 'none'}.`
        : 'Current accepted taskPlan task is complete or unavailable; return diagnostic or review-ready summary rather than expanding scope.',
      Array.isArray(currentTaskOperations) && currentTaskOperations.length
        ? `Accepted current task operations: ${JSON.stringify(currentTaskOperations)}.`
        : 'Accepted current task operations: none.',
      'Exact file operations such as fs.delete/fs.rename are authorized by exact operation grants, not by provider-declared scope fields.',
      acceptedPlan.executionRoot
        ? `Accepted taskPlan primary root: ${acceptedPlan.executionRoot.ref}. Workspace actionBundle targetPath/codeBlock paths must be relative to this root and must not include the root directory name. Absolute paths are allowed only for outside-workspace targets already reviewed in the accepted plan.`
        : 'Accepted taskPlan primary root is not explicit; use relative target paths from the authorized workspace root unless the accepted plan explicitly contains outside-workspace absolute file targets.',
      'Do not ask the user to reconfirm routine implementation batches already covered by the accepted taskPlan. If new targets, capabilities, or material technical choices are needed during accepted execution, return decisionRequest instead of an out-of-scope actionBundle.'
    );
  }
  if (context.recentPlanSummaries.length) {
    hints.push(`Recent implementation batch plans (intent only, not execution facts): ${context.recentPlanSummaries.join(' | ')}`);
  }
  if (context.continuationSummaries.length) {
    hints.push(`Pending continuation expectations (intent only, not files already created): ${context.continuationSummaries.join(' | ')}`);
  }
  return hints;
}

function refreshTaskExecutionState(state: SessionDriverLoopRunState): void {
  const snapshot = acceptedPlanTaskLedger().runtimeSnapshot({
    acceptedPlan: state.acceptedImplementationPlan,
    resourcePackets: state.resourcePackets,
    lastSavepointId: state.taskExecutionCursor?.lastSavepointId,
  });
  state.taskExecutionCursor = snapshot.taskExecutionCursor;
  state.currentTaskContext = snapshot.currentTaskContext;
  state.taskLedger = snapshot.taskLedger;
  state.acceptedPlanPromptFrame = snapshot.acceptedPlanPromptFrame;
}

function buildAcceptedPlanTaskLedger(
  acceptedPlan: AcceptedImplementationPlanContext | undefined,
  failedTaskId?: string,
  skippedTaskIds: string[] = [],
  acceptedIncompleteTaskIds: string[] = []
): TaskLedgerSnapshot | undefined {
  return acceptedPlanTaskLedger().ledger(acceptedPlan, failedTaskId, skippedTaskIds, acceptedIncompleteTaskIds);
}

function buildAcceptedPlanPromptFrameForContext(
  acceptedPlan: AcceptedImplementationPlanContext | undefined,
  taskLedger: TaskLedgerSnapshot | undefined
): AcceptedPlanPromptFrame | undefined {
  return acceptedPlanTaskLedger().promptFrame(acceptedPlan, taskLedger);
}

function buildTaskExecutionCursor(
  acceptedPlan: AcceptedImplementationPlanContext | undefined,
  resourcePackets: ResourcePacket[],
  lastSavepointId?: string
): TaskExecutionCursor | undefined {
  return acceptedPlanTaskLedger().cursor(acceptedPlan, resourcePackets, lastSavepointId);
}

function buildCurrentTaskContext(
  acceptedPlan: AcceptedImplementationPlanContext | undefined,
  cursor: TaskExecutionCursor | undefined
): CurrentTaskContext | undefined {
  return acceptedPlanTaskLedger().currentTaskContext(acceptedPlan, cursor);
}

function currentTaskMemoryHints(context: CurrentTaskContext | undefined): string[] {
  return acceptedPlanTaskLedger().memoryHints(context);
}

function providerRepairMessageState(state: SessionDriverLoopRunState): ProviderRepairMessageState {
  return {
    runId: state.runId,
    userRequest: state.userRequest,
    conversationRoots: state.conversationRoots,
    resourcePackets: state.resourcePackets,
    implementationBatch: state.implementationBatch,
    acceptedContext: executionPromptCoordinator().sanitizedContext(state.acceptedImplementationPlan),
    currentTaskContext: state.currentTaskContext
      ? {
        taskId: state.currentTaskContext.taskId,
        taskTitle: state.currentTaskContext.taskTitle,
        goal: state.currentTaskContext.goal,
        targets: state.currentTaskContext.targets,
        capabilities: state.currentTaskContext.capabilities,
      }
      : undefined,
    completedTaskCount: state.acceptedImplementationPlan?.completedTaskIds.length ?? 0,
  };
}

function lastAcceptedPlanTaskSavepointId(events: AgentEvent[]): string | undefined {
  return acceptedPlanTaskLedger().lastSavepointId(events);
}

function acceptedPlanResourceResumeEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  cursor: TaskExecutionCursor | undefined,
  context: CurrentTaskContext | undefined,
  packet: ResourcePacket,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.resource_resume',
      status: 'completed',
      summary: `已为当前任务补充只读资源证据，Session 将从同一 task cursor 紧凑续接。`,
      runId,
      planId: accepted.planId,
      taskCursorId: cursor?.cursorId,
      currentTaskId: context?.taskId,
      targetPaths: context?.targets ?? [],
      resourcePacketId: packet.id,
      resourceItemCount: packet.items.length,
      lastResourcePacketIds: cursor?.lastResourcePacketIds ?? [],
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: 'resourceRead',
        status: 'completed',
        title: 'Accepted plan resource resume',
        summary: 'Session resolved evidence for the current accepted-plan task and will resume from a compact task checkpoint.',
        source: 'session',
        runId,
        targets: context?.targets,
      }),
    },
  };
}

function acceptedPlanTaskSavepointEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  nextAccepted: AcceptedImplementationPlanContext,
  progress: AcceptedPlanBatchProgress,
  kernelEvents: unknown[],
  cursor: TaskExecutionCursor | undefined,
  context: CurrentTaskContext | undefined,
  ts: string,
  id: string
): AgentEvent {
  const complete = progress.remainingTaskIds.length === 0 && !kernelEventStatusIndex.hasFailureOrBlocker(kernelEvents);
  const ledger = buildAcceptedPlanTaskLedger(nextAccepted);
  const promptFrame = buildAcceptedPlanPromptFrameForContext(nextAccepted, ledger);
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.task_savepoint',
      status: complete ? 'completed' : 'running',
      summary: complete
        ? '当前 accepted taskPlan 已完成全部任务清单。'
        : '当前 accepted taskPlan 已保存任务批次进度，下一批将按任务清单顺序继续。',
      runId,
      planId: accepted.planId,
      taskCursorId: cursor?.cursorId,
      taskId: context?.taskId,
      completedTaskIds: progress.completedTaskIds,
      newlyCompletedTaskIds: progress.newlyCompletedTaskIds,
      remainingTaskIds: progress.remainingTaskIds,
      taskLedger: ledger,
      taskOrder: ledger?.taskOrder ?? [],
      nextPendingTaskIds: ledger?.pendingTaskIds ?? [],
      acceptedPlanPromptFrame: promptFrame,
      targetPaths: progress.targetPaths,
      workUnitIds: progress.workUnitIds,
      kernelEventCount: kernelEvents.length,
      memoryUpdateSummary: 'SessionMemory will retain the active task focus, completed task ids, and next checkpoint as derived intent/checkpoint memory.',
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
        status: complete ? 'completed' : 'running',
        title: complete ? 'Task plan savepoint complete' : 'Task plan savepoint',
        summary: complete ? 'All accepted tasks are complete.' : 'Accepted task progress saved for the next provider checkpoint.',
        source: 'session',
        runId,
        targets: progress.targetPaths,
        itemCount: progress.newlyCompletedTaskIds.length,
      }),
    },
  };
}

function normalizedNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

function normalizedPositiveInteger(value: unknown): number | undefined {
  const integer = normalizedNonNegativeInteger(value);
  return typeof integer === 'number' && integer > 0 ? integer : undefined;
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeSlashes(value).replace(/^\.\/+/, '').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return undefined;
    parts.push(part);
  }
  return parts.join('/') || '.';
}

function normalizeSlashes(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function comparablePath(value: string): string {
  return normalizeSlashes(value).replace(/\/+$/g, '');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}

function basename(value: string): string {
  const normalized = normalizeSlashes(value).replace(/\/+$/g, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

interface DiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

function diag(code: string, fallback: string, params?: Record<string, string | number>): DiagnosticInfo {
  return { code, fallback, params };
}

function findStateContract(events: unknown[]): KernelStateContractRef | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const contract = objectRecord(record?.stateContract);
    if (contract) return contract as unknown as KernelStateContractRef;
  }
  return undefined;
}

function findDriverRequest(events: unknown[]): DriverRequestRef | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const driverRequest = objectRecord(record?.driverRequest);
    if (driverRequest) return driverRequest as unknown as DriverRequestRef;
  }
  return undefined;
}

function firstString(events: unknown[], key: string): string | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function conversationActivity(input: AgentConversationActivity): AgentConversationActivity {
  return {
    ...input,
    targets: uniqueStrings(input.targets ?? []),
    actionIds: uniqueStrings(input.actionIds ?? []),
    workUnitIds: uniqueStrings(input.workUnitIds ?? []),
  };
}

function providerActivity(
  state: SessionDriverLoopRunState,
  stage: string,
  status: 'running' | 'completed'
): AgentConversationActivity {
  return conversationActivity({
    activityId: `provider-${stage}`,
    kind: 'providerThinking',
    status,
    title: status === 'running' ? 'Provider call running' : 'Provider call completed',
    summary: providerStreamCoordinator.stageSummary(stage, status === 'running' ? 'request' : 'response', visibleLanguageForRequest(state.userRequest)),
    source: 'provider',
    runId: state.runId,
  });
}

function acceptedPlanBatchActivity(
  accepted: AcceptedImplementationPlanContext,
  batch: unknown,
  status: 'running' | 'completed'
): AgentConversationActivity {
  const actions = batchActionRecords(batch);
  return conversationActivity({
    activityId: `accepted-plan-batch-${accepted.planId}-${accepted.batchIndex}-${status}`,
    kind: 'editBatchQueued',
    status,
    title: status === 'running' ? 'Submitting accepted-plan batch' : 'Accepted-plan batch submitted',
    summary: acceptedPlanBatchActivitySummary(batch),
    source: 'session',
    runId: accepted.runId,
    planId: accepted.planId,
    targets: actions.flatMap(actionTargetCandidates),
    actionIds: actions.flatMap((action) => stringValue(action.actionId) ?? stringValue(action.id) ?? []),
    itemCount: actions.length,
  });
}

function acceptedPlanBatchActivitySummary(batch: unknown): string {
  const actions = batchActionRecords(batch);
  const targetCount = uniqueStrings(actions.flatMap(actionTargetCandidates)).length;
  return `Session is submitting ${actions.length} accepted-plan action(s) for ${targetCount} target(s).`;
}

function batchActionRecords(batch: unknown): Record<string, unknown>[] {
  const record = objectRecord(batch);
  const nested = objectRecord(record?.actionBundle);
  const actions = Array.isArray(record?.actions)
    ? record.actions
    : Array.isArray(nested?.actions)
      ? nested.actions
      : [];
  return actions.flatMap((item) => objectRecord(item) ? [objectRecord(item) as Record<string, unknown>] : []);
}

function actionTargetCandidates(action: Record<string, unknown>): string[] {
  return uniqueStrings([
    actionFileTargetPath(action),
    stringValue(action.targetPath),
    ...stringArrayValue(action.resourceScope),
  ]);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function answerEvent(
  sessionId: string,
  proposal: ProposalEnvelope,
  ts: string,
  id: string,
  metadata: Record<string, unknown> = {}
): AgentEvent {
  const content = answerContent(proposal);
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'final',
      visibility: 'conversation',
      label: 'DeepCode',
      proposalId: proposal.proposalId,
      ...metadata,
    },
  };
}

function answerProposalFromDecisionEffect(
  sessionId: string,
  runId: string,
  effect: RequirementOptionEffect,
  events: AgentEvent[],
  guidance: string | undefined,
  proposalId: string
): ProposalEnvelope {
  const accepted = recoverAcceptedPlanFromEvents(events, runId);
  const ledger = buildAcceptedPlanTaskLedger(accepted);
  const completed = ledger?.completedTaskIds.length ?? 0;
  const total = ledger?.taskOrder.length ?? 0;
  const pending = ledger?.pendingTaskIds.length ?? 0;
  const reason = effect.kind === 'finishWithAnswer'
    ? effect.reason
    : effect.kind === 'markAcceptedIncomplete'
      ? effect.reason
      : undefined;
  const lines = [
    '## 当前会话已按用户介入收口',
    '',
    '用户已要求停止继续执行并输出总结。以下内容只基于 Session ledger 与 Kernel facts 派生，不声明未发生的工具执行。',
    '',
    total ? `- 已确认任务总数：${total}` : '- 当前没有可恢复的 accepted plan 任务清单。',
    total ? `- 已完成任务：${completed}` : '',
    total ? `- 未继续执行任务：${pending}` : '',
    reason ? `- 用户介入原因：${reason}` : '',
    guidance?.trim() ? `- 用户补充说明：${guidance.trim()}` : '',
    '',
    '后续如需继续，需要重新生成或确认新的 Plan；未提交 Kernel 的任务不会被视为完成事实。',
  ].filter(Boolean);
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    proposalId,
    runId,
    sessionId,
    source: 'system',
    kind: 'answer',
    payload: {
      answer: {
        version: '1',
        format: 'markdown',
        content: lines.join('\n'),
      },
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  };
}

function recoverAcceptedPlanFromEvents(events: AgentEvent[], runId: string): AcceptedImplementationPlanContext | undefined {
  const plan = latestExecutablePlan(events, runId);
  if (!plan?.implementationPlan) return undefined;
  return acceptedPlanWithLatestCheckpoint(acceptedImplementationPlanContext(plan, undefined, plan.executionRoot), events);
}

function answerContent(proposal: ProposalEnvelope): string {
  const payload = objectRecord(proposal.payload) ?? {};
  const answer = objectRecord(payload.answer) ?? payload;
  return typeof answer.content === 'string' ? answer.content : '';
}

function guidanceRevisionTransitionEvent(
  sessionId: string,
  runId: string,
  guidanceIds: string[],
  userRequest: string,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content: providerStreamCoordinator.guidanceRevisionTransitionMessage(visibleLanguageForRequest(userRequest)),
      channel: 'progress',
      source: 'session',
      visibility: 'conversation',
      presentation: 'body',
      label: 'DeepCode',
      runId,
      guidanceIds,
    },
  };
}

function guidanceRevisionDiagnosticEvent(sessionId: string, message: string, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'error',
    payload: {
      message,
      status: 'error',
      channel: 'error',
      visibility: 'conversation',
      source: 'session',
    },
  };
}

function answerNarrationEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent | null {
  const content = proposal.narration?.trim();
  if (!content) return null;
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'progress',
      source: 'llm',
      visibility: 'conversation',
      presentation: 'body',
      label: 'DeepCode',
      proposalId: proposal.proposalId,
    },
  };
}

function guidanceRevisionOverlay(
  originalRequest: string,
  draftAnswer: ProposalEnvelope,
  guidance: UserGuidanceEvent[]
): string {
  return [
    'Terminal user guidance revision:',
    'A draft answer was generated but has not been shown to the user because new user guidance arrived before the final response was committed.',
    'Return a JSON ProposalEnvelope with kind="answer" only. Do not return resourceRequest, decisionRequest, actionBundle, or diagnostic.',
    'Include a short top-level narration sentence that naturally acknowledges the guidance merge before the final answer.',
    `Original user request:\n${clip(originalRequest, 1800)}`,
    `Unshown draft answer:\n${clip(answerContent(draftAnswer), 3200)}`,
    'Latest user guidance to apply:',
    ...guidance.map((item) => `- id=${item.id} ${clip(item.content, 800)}`),
  ].join('\n\n');
}

function finalDiagnosticEvent(sessionId: string, content: string | DiagnosticInfo, ts: string, id: string): AgentEvent {
  const info: DiagnosticInfo = typeof content === 'string'
    ? { code: 'generic', fallback: content }
    : content;
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content: info.fallback,
      channel: 'final',
      visibility: 'conversation',
      label: 'DeepCode',
      diagnostic: true,
      diagnosticCode: info.code,
      ...(info.params ? { diagnosticParams: info.params } : {}),
    },
  };
}

function thinkingEvent(
  sessionId: string,
  content: string,
  ts: string,
  id: string,
  message?: { messageKey: string; messageArgs?: Record<string, string> }
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'session.provider_status',
      status: 'completed',
      summary: content,
      content,
      channel: 'progress',
      source: 'session',
      visibility: 'conversation',
      presentation: 'stageSummary',
      label: 'Session status',
      ...(message ? { messageKey: message.messageKey, messageArgs: message.messageArgs ?? {} } : {}),
    },
  };
}

function reasoningEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'reasoning',
      source: 'provider',
      visibility: 'conversation',
      presentation: 'collapsible',
      reasoningTrace: true,
      label: 'Model reasoning',
    },
  };
}

function readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined {
  const payload = objectRecord(proposal.payload);
  const actionBundle = objectRecord(payload?.actionBundle);
  return actionBundle as unknown as ActionBundleDraft | undefined;
}

function proposalActionBundleAdmissionBatch(proposal: ProposalEnvelope): Record<string, unknown> {
  const payload = objectRecord(proposal.payload) ?? {};
  const actionBundle = objectRecord(payload.actionBundle) ?? {};
  return {
    planId: stringValue(actionBundle.id) ?? proposal.proposalId,
    actionBundle,
    codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
    commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
  };
}

function protocolGate(): ProtocolGate {
  return new ProtocolGate({
    canonicalizeWriteActionSourceBlockRefs,
    ensureReviewableExpectations: (proposal) => executionPromptCoordinator().ensureReviewableExpectations(proposal),
    validateProposalSemantics,
  });
}

function executionPromptCoordinator(): ExecutionPromptCoordinator<SessionPlanContext> {
  return new ExecutionPromptCoordinator<SessionPlanContext>({
    maxActionBundleTotalCodeBytes: MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES,
    sideEffectCapabilities: SIDE_EFFECT_CAPABILITIES,
    objectRecord,
    stringValue,
    planId: (plan) => plan.planId,
    actionEffectiveCapability,
    isDetailedUserPlanMarkdown,
    defaultActionBundleUserPlanMarkdown,
    expectationsHaveDescription,
    defaultValidationExpectation,
    defaultReviewExpectation,
  });
}

function expectationsHaveDescription(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => typeof objectRecord(item)?.description === 'string' && Boolean(String(objectRecord(item)?.description).trim()));
}

function defaultValidationExpectation(actions: Record<string, unknown>[]): ValidationExpectationDraft {
  const targets = actions.map(actionFileTargetPath).filter((target): target is string => Boolean(target));
  const targetSummary = targets.slice(0, 8).join(', ');
  const expectation: ValidationExpectationDraft & Record<string, unknown> = {
    id: 'session-default-validation',
    messageKey: targets.length
      ? 'session.driver.defaultValidation.targets'
      : 'session.driver.defaultValidation.generic',
    messageArgs: targets.length ? { targets: targetSummary } : {},
    description: targets.length
      ? `Kernel facts must show the requested operation completed for: ${targetSummary}.`
      : 'Kernel facts must show the requested side-effect operation completed.',
  };
  return expectation;
}

function defaultReviewExpectation(actions: Record<string, unknown>[]): ReviewExpectationDraft {
  const targets = actions.map(actionFileTargetPath).filter((target): target is string => Boolean(target));
  const targetSummary = targets.slice(0, 8).join(', ');
  const expectation: ReviewExpectationDraft & Record<string, unknown> = {
    id: 'session-default-review',
    messageKey: targets.length
      ? 'session.driver.defaultReview.targets'
      : 'session.driver.defaultReview.generic',
    messageArgs: targets.length ? { targets: targetSummary } : {},
    description: targets.length
      ? `Review the Kernel facts and resulting workspace state for: ${targetSummary}.`
      : 'Review the Kernel facts and resulting workspace state for this action bundle.',
  };
  return expectation;
}

function isDetailedUserPlanMarkdown(userPlan: string | undefined): boolean {
  if (!userPlan || userPlan.trim().length < 240) return false;
  const lines = userPlan.split(/\r?\n/);
  const headings = lines.filter((line) => /^#{1,3}\s+\S/.test(line.trim()));
  const listItems = lines.filter((line) => /^\s*[-*+]\s+\S/.test(line));
  return headings.length >= 4 && listItems.length >= 3;
}

function defaultActionBundleUserPlanMarkdown(input: {
  goal?: string;
  actions: Record<string, unknown>[];
  existingUserPlan?: string;
  outputLanguage?: string;
}): string {
  const targets = input.actions.map(actionFileTargetPath).filter((target): target is string => Boolean(target));
  const actionLines = input.actions.map((action, index) => {
    const capability = actionEffectiveCapability(action) || 'side-effect';
    const target = actionFileTargetPath(action) ?? `action-${index + 1}`;
    const description = stringValue(action.description) ?? stringValue(action.title) ?? capability;
    return { capability, target, description };
  });
  const targetList = targets.length
    ? targets.slice(0, 12).map((target) => `- ${target}`)
    : ['- Kernel facts will identify the affected workspace targets.'];
  const changeList = actionLines.length
    ? actionLines.slice(0, 12).map((action) => `- ${action.capability}: ${action.target} - ${action.description}`)
    : ['- Submit the current accepted-task side-effect batch to Kernel review.'];
  const summary = input.goal ?? input.existingUserPlan ?? 'Execute the current accepted-task action bundle.';
  if ((input.outputLanguage ?? '').toLowerCase().startsWith('zh')) {
    return [
      '# 执行批次',
      '',
      '## 摘要',
      summary,
      '',
      '## 关键变更',
      ...changeList,
      '',
      '## 影响范围',
      ...targetList,
      '',
      '## 验证计划',
      '- Kernel facts 必须记录本批次的工具执行结果。',
      '- Review 阶段必须展示实际变更路径和执行状态。',
      '',
      '## 假设与约束',
      '- 本批次只覆盖当前已确认任务范围内的操作。',
      '- Session 只补充可审查说明，不把该说明当作完成事实。',
    ].join('\n');
  }
  return [
    '# Execution Batch',
    '',
    '## Summary',
    summary,
    '',
    '## Key Changes',
    ...changeList,
    '',
    '## Affected Targets',
    ...targetList,
    '',
    '## Validation Plan',
    '- Kernel facts must record the tool execution results for this batch.',
    '- Review must show the actual changed paths and execution status.',
    '',
    '## Assumptions And Constraints',
    '- This batch only covers operations inside the current accepted task scope.',
    '- Session adds reviewable explanation only; this explanation is not a completion fact.',
  ].join('\n');
}

function canonicalizeWriteActionSourceBlockRefs(proposal: ProposalEnvelope): void {
  if (proposal.kind !== 'actionBundle') return;
  const payload = objectRecord(proposal.payload);
  const bundle = objectRecord(payload?.actionBundle);
  const codeBlocks = Array.isArray(payload?.codeBlocks) ? payload.codeBlocks : [];
  const actions = Array.isArray(bundle?.actions) ? bundle.actions : [];
  if (!payload || !bundle || !codeBlocks.length || !actions.length) return;

  const blocks = codeBlocks.flatMap((block) => {
    const record = objectRecord(block);
    const id = stringValue(record?.id) ?? stringValue(record?.blockId);
    const targetPath = stringValue(record?.targetPath) ?? stringValue(record?.path);
    if (!id || !targetPath) return [];
    return [{ id, targetPath: normalizePlanScope(targetPath) }];
  });
  if (!blocks.length) return;

  const fixes: Array<Record<string, unknown>> = [];
  for (const [index, action] of actions.entries()) {
    const record = objectRecord(action);
    if (!record) continue;
    const capability = actionEffectiveCapability(record);
    if (capability !== 'fs.write') continue;
    const args = objectRecord(record.args) ?? objectRecord(record.toolArgs);
    const existingSource = stringValue(record.sourceBlockId) ?? stringValue(args?.sourceBlockId);
    if (existingSource) continue;
    const actionKind = stringValue(record.kind);
    if (['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(actionKind ?? '')) continue;
    const targetPath = actionFileTargetPath(record);
    if (!targetPath) continue;
    const normalizedTarget = normalizePlanScope(targetPath);
    const matches = blocks.filter((block) => block.targetPath === normalizedTarget);
    if (matches.length !== 1) continue;

    const nextArgs = { ...(args ?? {}) };
    nextArgs.sourceBlockId = matches[0].id;
    record.args = nextArgs;
    record.toolArgs = nextArgs;
    record.sourceBlockId = matches[0].id;
    fixes.push({
      kind: 'fs_write_sourceBlockId_canonicalized',
      actionIndex: index,
      actionId: stringValue(record.actionId) ?? stringValue(record.id),
      path: normalizedTarget,
      sourceBlockId: matches[0].id,
      reason: 'unique_codeBlock_targetPath_match',
    });
  }

  if (!fixes.length) return;
  const diagnostics = objectRecord(proposal.parserDiagnostics);
  proposal.parserDiagnostics = {
    ...(diagnostics ?? {}),
    canonicalizations: [
      ...(Array.isArray(diagnostics?.canonicalizations) ? diagnostics.canonicalizations : []),
      ...fixes,
    ],
  };
}

function validateProposalSemantics(proposal: ProposalEnvelope, options?: {
  allowBriefActionBundleUserPlan?: boolean;
}): void {
  if (proposal.kind !== 'actionBundle') return;
  const payload = objectRecord(proposal.payload) ?? {};
  const bundle = readActionBundle(proposal);
  if (!bundle) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle must include an actionBundle object.');
  }
  if (typeof bundle.id !== 'string' || !bundle.id.trim()) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.id must be a non-empty string.');
  }
  if (bundle.version !== '1') {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.version must be "1".');
  }
  if (typeof bundle.goal !== 'string' || !bundle.goal.trim()) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.goal must be a non-empty string.');
  }
  if (!Array.isArray(bundle.actions) || bundle.actions.length === 0) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.actions must not be empty.');
  }
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
  const codeBlockIds = new Set<string>();
  let totalCodeBytes = 0;
  for (const [index, block] of codeBlocks.entries()) {
    const record = objectRecord(block);
    const blockId = typeof record?.id === 'string' ? record.id.trim() : '';
    if (!blockId) {
      throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}].id must be a non-empty string.`);
    }
    codeBlockIds.add(blockId);
    const content = typeof record?.content === 'string' ? record.content : '';
    const size = utf8Bytes(content);
    totalCodeBytes += size;
    const operation = typeof record?.operation === 'string' ? record.operation : '';
    const allowEmptyContent = record?.allowEmptyContent === true;
    if (size === 0 && !(allowEmptyContent && ['createEmpty', 'patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(operation))) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `codeBlocks[${index}].content must be non-empty. Empty content is allowed only with operation="createEmpty" for an explicit empty file or with patch/replace/insert operations; do not use empty .gitkeep or placeholder writes to create directories.`
      );
    }
  }
  if (totalCodeBytes > MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES) {
    throw new AgentPlanParseError(
      'action_bundle_budget_exceeded',
      `codeBlocks total content is ${totalCodeBytes} bytes; reorganize the implementation by module, file section, class, or function so this actionBundle stays within the ${MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES} byte payload budget without reducing the accepted plan scope.`
    );
  }
  for (const [index, action] of bundle.actions.entries()) {
    if (typeof action.id !== 'string' || !action.id.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].id must be a non-empty string.`);
    }
    if (typeof action.title !== 'string' || !action.title.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].title must be a non-empty string.`);
    }
    if (typeof action.capability !== 'string' || !action.capability.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].capability must be a non-empty string.`);
    }
    if (!Array.isArray(action.resourceScope)) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].resourceScope must be an array.`);
    }
    const actionKind = typeof action.kind === 'string' ? action.kind : '';
    const effectiveActionKind = actionKind || (action.capability === 'fs.patch' ? 'patch' : '');
    const isPatchAction = ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(effectiveActionKind);
    const replacementBlockId = typeof action.replacementBlockId === 'string'
      ? action.replacementBlockId.trim()
      : '';
    if (action.capability === 'fs.delete') {
      const deleteTargetError = deleteActionTargetError(action);
      if (deleteTargetError) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${deleteTargetError}`);
      }
      if (action.sourceBlockId?.trim() || replacementBlockId) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] fs.delete must not reference codeBlocks/sourceBlockId.`);
      }
    }
    if (action.capability === 'fs.write' && !isPatchAction && !action.sourceBlockId?.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${action.capability} must include sourceBlockId.`);
    }
    if (isPatchAction && !(replacementBlockId || action.sourceBlockId?.trim())) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] patch action must include replacementBlockId or sourceBlockId.`);
    }
    if (isPatchAction) {
      const patchSpecError = patchActionSpecError(action);
      if (patchSpecError) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${patchSpecError}`);
      }
    }
    if (action.sourceBlockId && !codeBlockIds.has(action.sourceBlockId)) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `actionBundle.actions[${index}].sourceBlockId "${action.sourceBlockId}" does not match any codeBlocks[].id.`
      );
    }
    if (replacementBlockId && !codeBlockIds.has(replacementBlockId)) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `actionBundle.actions[${index}].replacementBlockId "${replacementBlockId}" does not match any codeBlocks[].id.`
      );
    }
  }
  const sideEffectful = bundle.actions.some((action) => SIDE_EFFECT_CAPABILITIES.has(action.capability));
  if (!sideEffectful) return;
  for (const [index, block] of codeBlocks.entries()) {
    const record = objectRecord(block);
    const hasPath = typeof record?.path === 'string' && record.path.trim();
    const hasTargetPath = typeof record?.targetPath === 'string' && record.targetPath.trim();
    if (!hasPath && !hasTargetPath) {
      throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}] must include path or targetPath.`);
    }
    if (typeof record?.content !== 'string') {
      throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}].content must be a string.`);
    }
  }
  let userPlan = typeof payload.userPlan === 'string' ? payload.userPlan.trim() : '';
  if (!options?.allowBriefActionBundleUserPlan) {
    if (!isDetailedUserPlanMarkdown(userPlan)) {
      const generatedUserPlan = defaultActionBundleUserPlanMarkdown({
        goal: bundle.goal,
        actions: bundle.actions as unknown as Record<string, unknown>[],
        existingUserPlan: userPlan,
        outputLanguage: stringValue(payload.outputLanguage)
          ?? stringValue((proposal as unknown as Record<string, unknown>).outputLanguage),
      });
      payload.userPlan = generatedUserPlan;
      payload.userPlanMarkdown = generatedUserPlan;
      userPlan = generatedUserPlan.trim();
    }
    validateDetailedUserPlan(userPlan);
  }
  const validationExpectations = Array.isArray(bundle.validationExpectations) ? bundle.validationExpectations : [];
  const reviewExpectations = Array.isArray(bundle.reviewExpectations) ? bundle.reviewExpectations : [];
  if (!validationExpectations.some((item) => item?.description?.trim())) {
    bundle.validationExpectations = [defaultValidationExpectation(bundle.actions as unknown as Record<string, unknown>[])];
  }
  if (!reviewExpectations.some((item) => item?.description?.trim())) {
    bundle.reviewExpectations = [defaultReviewExpectation(bundle.actions as unknown as Record<string, unknown>[])];
  }
}

function deleteActionTargetError(action: ActionBundleDraft['actions'][number]): string | undefined {
  const target = actionFileTargetPath(action);
  if (!target) {
    return 'fs.delete must include a concrete targetPath or resourceScope[0].';
  }
  const normalized = normalizeSlashes(target);
  if (!normalized || normalized === '.' || normalized === './') {
    return 'fs.delete target cannot be empty or the workspace root.';
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return 'fs.delete target cannot escape the primary workspace root.';
  }
  if (normalized.includes('*')) {
    return 'fs.delete target must name concrete files; wildcard cleanup is not allowed.';
  }
  if (deleteActionTargetResourceKind(action) === 'directory') {
    if (!deleteActionRecursive(action) && normalized.endsWith('/')) {
      return 'fs.delete directory target with trailing slash must set recursive=true or use the normalized directory path.';
    }
    return undefined;
  }
  if (normalized.endsWith('/')) {
    return 'fs.delete directory target must set targetKind="directory" and recursive=true when deleting a directory tree.';
  }
  return undefined;
}

function deleteActionTargetResourceKind(action: {
  targetResourceKind?: unknown;
  targetKind?: unknown;
  toolArgs?: unknown;
  args?: unknown;
}): 'file' | 'directory' | undefined {
  const toolArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
  const value = stringValue(action.targetResourceKind)
    ?? stringValue(action.targetKind)
    ?? stringValue(toolArgs?.targetResourceKind)
    ?? stringValue(toolArgs?.targetKind);
  if (value === 'directory' || value === 'dir') return 'directory';
  if (value === 'file') return 'file';
  return undefined;
}

function deleteActionRecursive(action: { recursive?: unknown; toolArgs?: unknown; args?: unknown }): boolean {
  const toolArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
  return action.recursive === true || toolArgs?.recursive === true;
}

function patchActionSpecError(action: ActionBundleDraft['actions'][number]): string | undefined {
  const patchSpec = objectRecord(action.patchSpec);
  if (!patchSpec) {
    return 'patch action must include patchSpec.';
  }
  const match = objectRecord(patchSpec.match);
  if (!match) {
    return 'patch action must include patchSpec.match.';
  }
  const matchKind = stringValue(match.kind);
  if (matchKind !== 'exactBlock') {
    return 'patchSpec.match.kind must be "exactBlock".';
  }
  const text = stringValue(match.text);
  if (!text) {
    return 'patchSpec.match.text must be a non-empty exact block from current ResourcePacket evidence.';
  }
  return undefined;
}

function validateDetailedUserPlan(userPlan: string): void {
  if (userPlan.length < 240) {
    throw new AgentPlanParseError(
      'action_bundle_plan_required',
      'Side-effect actionBundle must include a detailed Markdown userPlan, not a one-line summary.'
    );
  }
  const headings = userPlan
    .split(/\r?\n/)
    .filter((line) => /^#{1,3}\s+\S/.test(line.trim()));
  const listItems = userPlan
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*+]\s+\S/.test(line));
  if (headings.length < 4 || listItems.length < 3) {
    throw new AgentPlanParseError(
      'action_bundle_plan_required',
      'Side-effect actionBundle.userPlan must use structured Markdown with multiple headings and concrete reviewable items; localized headings are accepted.'
    );
  }
}

function shouldAttemptActionBundleCompactionRepair(state: SessionDriverLoopRunState): boolean {
  if (!state.acceptedImplementationPlan && !state.currentTaskContext) return false;
  const allowed = state.stateContract?.allowedProposals ?? state.driverRequest?.stateContract?.allowedProposals ?? [];
  if (allowed.length && !allowed.includes('actionBundle')) return false;
  const capabilities = state.stateContract?.capabilityProjection ?? state.driverRequest?.stateContract?.capabilityProjection ?? [];
  return capabilities.some((capability) => SIDE_EFFECT_CAPABILITIES.has(capability));
}

interface SessionPlanContext {
  sessionId: string;
  runId: string;
  planId: string;
  proposalId?: string;
  userPlan: string;
  actionBundle: Record<string, unknown>;
  codeBlocks: unknown[];
  commandBlocks: unknown[];
  expectedValidation: string;
  reviewGuide: string;
  planReviewReport?: Record<string, unknown>;
  implementationPlan?: Record<string, unknown>;
  interactionOverlay?: InteractionOverlayContext;
  executionRoot?: AcceptedImplementationPlanExecutionRoot;
}

interface RecoveredAcceptedPlanContext {
  plan: SessionPlanContext;
  acceptedPlan: AcceptedImplementationPlanContext;
}

function sessionProviderAllowedProposals(allowed: string[], state: SessionDriverLoopRunState): string[] {
  const merged = new Set(allowed);
  if (state.acceptedImplementationPlan) {
    merged.delete('taskPlan');
    merged.delete('implementationPlan');
    for (const kind of ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']) merged.add(kind);
  } else {
    merged.add('taskPlan');
  }
  return [...merged];
}

function findPlanCard(events: AgentEvent[], runId?: string, planId?: string): SessionPlanContext | null {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload);
    const candidate = payload ? planContextFromEvent(event, payload) : null;
    if (!candidate) continue;
    if (runId && candidate.runId !== runId) continue;
    if (planId && !planAliases(candidate).has(planId)) continue;
    return candidate;
  }
  return null;
}

function recoverAcceptedPlanFromOverlay(
  input: SessionDecisionResolverInput,
  events: AgentEvent[],
  overlay: InteractionOverlayContext | undefined
): RecoveredAcceptedPlanContext | undefined {
  const planId = overlay?.acceptedPlanId;
  if (!planId) return undefined;
  const plan = (overlay.acceptedPlanRunId ? findPlanCard(events, overlay.acceptedPlanRunId, planId) : null)
    ?? findPlanCard(events, undefined, planId);
  if (!plan?.implementationPlan) return undefined;
  const executionRoot = plan.executionRoot ?? AcceptedPlanExecutionRootResolver.fromDecision(input, events);
  let acceptedPlan = acceptedPlanWithLatestCheckpoint(
    acceptedImplementationPlanContext(plan, input.interventionLevel, executionRoot),
    events
  );
  const overlayCompletedTaskIds = overlay.acceptedCompletedTaskIds ?? [];
  if (overlayCompletedTaskIds.length) {
    acceptedPlan = acceptedPlanAfterBatch(acceptedPlan, [
      ...new Set([...acceptedPlan.completedTaskIds, ...overlayCompletedTaskIds]),
    ]);
  }
  return { plan, acceptedPlan };
}

function latestExecutablePlan(events: AgentEvent[], previousRunId?: string): SessionPlanContext | null {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload);
    const candidate = payload ? planContextFromEvent(event, payload) : null;
    if (!candidate) continue;
    if (previousRunId && candidate.runId === previousRunId) continue;
    if (planAlreadyResolved(events, candidate)) continue;
    return candidate;
  }
  return null;
}

function planContextFromEvent(event: AgentEvent, payload: Record<string, unknown>): SessionPlanContext | null {
  const implementationPlan = objectRecord(payload.taskPlan) ?? objectRecord(payload.implementationPlan) ?? undefined;
  const actionBundle = objectRecord(payload.actionBundle) ?? (implementationPlan ? {
    id: stringValue(payload.planId) ?? stringValue(implementationPlan.id) ?? stringValue(payload.proposalId),
    version: '1',
    actions: [],
  } : undefined);
  if (!actionBundle) return null;
  const planId = stringValue(payload.planId)
    ?? stringValue(actionBundle.id)
    ?? stringValue(implementationPlan?.id)
    ?? stringValue(payload.proposalId);
  const runId = stringValue(payload.runId);
  if (!planId || !runId) return null;
  return {
    sessionId: event.sessionId,
    runId,
    planId,
    proposalId: stringValue(payload.proposalId),
    userPlan: stringValue(payload.content) ?? stringValue(payload.summary) ?? 'Agent plan',
    actionBundle: actionBundle as unknown as Record<string, unknown>,
    codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
    commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
    expectedValidation: stringValue(payload.expectedValidation) ?? '',
    reviewGuide: stringValue(payload.reviewGuide) ?? '',
    planReviewReport: objectRecord(payload.planReviewReport) ?? undefined,
    implementationPlan,
    interactionOverlay: interactionOverlayFromPayload(payload),
    executionRoot: AcceptedPlanExecutionRootResolver.fromPayload(payload),
  };
}

function proposalEnvelopeFromPlanContext(plan: SessionPlanContext): ProposalEnvelope {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    proposalId: plan.proposalId ?? plan.planId,
    runId: plan.runId,
    sessionId: plan.sessionId,
    source: 'system',
    kind: 'actionBundle',
    narration: plan.userPlan,
    payload: {
      userPlan: plan.userPlan,
      actionBundle: plan.actionBundle,
      codeBlocks: plan.codeBlocks,
      commandBlocks: plan.commandBlocks,
      expectedValidation: plan.expectedValidation,
      reviewGuide: plan.reviewGuide,
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  };
}

function interactionOverlayFromRequirementDecision(confirmation: AgentEvent, decision: AgentEvent): InteractionOverlayContext | undefined {
  const confirmationPayload = objectRecord(confirmation.payload) ?? {};
  const overlay = interactionOverlayFromPayload(confirmationPayload);
  if (!overlay) return undefined;
  return {
    ...overlay,
    resumedFromDecisionId: decision.id,
  };
}

function interactionOverlayFromPayload(payload: Record<string, unknown> | undefined): InteractionOverlayContext | undefined {
  if (!payload || payload.interactionOverlay !== true) return undefined;
  const parentRunId = stringValue(payload.parentRunId);
  const parentPhase = sessionTurnPhaseValue(payload.parentPhase);
  const interactionRunId = stringValue(payload.interactionRunId) ?? stringValue(payload.runId);
  const interactionId = stringValue(payload.interactionId)
    ?? stringValue(payload.requirementId)
    ?? stringValue(payload.targetId);
  if (!parentRunId || !parentPhase || !interactionRunId || !interactionId) return undefined;
  return {
    parentRunId,
    parentPhase,
    interactionRunId,
    interactionId,
    sourceInteractionId: stringValue(payload.sourceInteractionId) ?? interactionId,
    resumedFromDecisionId: stringValue(payload.resumedFromDecisionId),
    acceptedPlanId: stringValue(payload.acceptedPlanId),
    acceptedPlanRunId: stringValue(payload.acceptedPlanRunId),
    acceptedCurrentTaskId: stringValue(payload.acceptedCurrentTaskId),
    acceptedCompletedTaskIds: stringArrayValue(payload.acceptedCompletedTaskIds),
  };
}

function interactionOverlayProjection(overlay: InteractionOverlayContext | undefined): Record<string, unknown> {
  if (!overlay) return {};
  return {
    interactionOverlay: true,
    parentRunId: overlay.parentRunId,
    parentPhase: overlay.parentPhase,
    interactionRunId: overlay.interactionRunId,
    interactionId: overlay.interactionId,
    sourceInteractionId: overlay.sourceInteractionId ?? overlay.interactionId,
    resumedFromDecisionId: overlay.resumedFromDecisionId,
    acceptedPlanId: overlay.acceptedPlanId,
    acceptedPlanRunId: overlay.acceptedPlanRunId,
    acceptedCurrentTaskId: overlay.acceptedCurrentTaskId,
    acceptedCompletedTaskIds: overlay.acceptedCompletedTaskIds,
  };
}

function sessionTurnPhaseValue(value: unknown): SessionTurnPhase | undefined {
  const phase = stringValue(value);
  if (
    phase === 'context_reading' ||
    phase === 'provider_proposing' ||
    phase === 'waiting_requirement_confirmation' ||
    phase === 'waiting_plan_review' ||
    phase === 'waiting_permission' ||
    phase === 'executing_accepted_plan' ||
    phase === 'executing' ||
    phase === 'waiting_review' ||
    phase === 'completed' ||
    phase === 'failed' ||
    phase === 'cancelled'
  ) {
    return phase;
  }
  return undefined;
}

function planAliases(plan: SessionPlanContext): Set<string> {
  const aliases = new Set<string>([plan.planId]);
  if (plan.proposalId) aliases.add(plan.proposalId);
  const bundleId = stringValue(plan.actionBundle.id);
  if (bundleId) aliases.add(bundleId);
  const reportPlanId = stringValue(plan.planReviewReport?.planId);
  if (reportPlanId) aliases.add(reportPlanId);
  return aliases;
}

function planAlreadyResolved(events: AgentEvent[], plan: SessionPlanContext): boolean {
  const aliases = planAliases(plan);
  return events.some((event, index) => {
    if (event.kind !== 'plan_review') return false;
    const payload = objectRecord(event.payload);
    if (!payload) return false;
    const status = stringValue(payload.status);
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
    const runId = stringValue(payload.runId);
    const planId = stringValue(payload.planId);
    if (runId !== plan.runId || (planId && !aliases.has(planId))) return false;
    if (status === 'rejected' || status === 'needsRevision') return true;
    return acceptedPlanExecutionConsumed(events, plan, aliases, index);
  });
}

function acceptedPlanExecutionConsumed(
  events: AgentEvent[],
  plan: SessionPlanContext,
  aliases: Set<string>,
  acceptedIndex: number
): boolean {
  for (let index = acceptedIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    const payload = objectRecord(event.payload) ?? {};
    const kernelEvent = objectRecord(payload.kernelEvent);
    const runId = stringValue(payload.runId) ?? stringValue(kernelEvent?.runId);
    if (runId && runId !== plan.runId) continue;
    const owner = objectRecord(payload.decisionOwner);
    const batch = objectRecord(kernelEvent?.batch);
    const planId = stringValue(payload.planId)
      ?? stringValue(owner?.planId)
      ?? stringValue(kernelEvent?.planId)
      ?? stringValue(batch?.planId);
    if (planId && !aliases.has(planId)) continue;

    if (event.kind === 'review_summary') return true;
    if (event.kind === 'permission_request') return true;
    if (event.kind === 'error') return true;

    if (event.kind === 'session_run_state') {
      const status = stringValue(payload.status);
      const reason = stringValue(payload.reason);
      if (status === 'failed' || status === 'cancelled' || status === 'completed') return true;
      if (reason === 'permission' || reason === 'review' || reason === 'work_unit_failed') return true;
      continue;
    }

    const stage = stringValue(payload.stage);
    if (stage === 'accepted_plan.action_batch_submit' || stage === 'accepted_plan.batch_failed') return true;

    const kernelKind = stringValue(kernelEvent?.kind) ?? stringValue(payload.kind);
    if (
      kernelKind === 'action_batch.accepted' ||
      kernelKind === 'permission.requested' ||
      kernelKind?.startsWith('work_unit.')
    ) {
      return true;
    }
  }
  return false;
}

function acceptedImplementationPlanContext(
  plan: SessionPlanContext,
  interventionLevel?: InterventionLevel,
  executionRoot?: AcceptedImplementationPlanExecutionRoot
): AcceptedImplementationPlanContext {
  return acceptedImplementationPlanContextBuilder().build({
    plan,
    interventionLevel,
    executionRoot,
  });
}

function acceptedPlanExecutionContext(
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  planReviewReport: Record<string, unknown>
): SessionPlanContext {
  const accepted = state.acceptedImplementationPlan;
  const payload = objectRecord(proposal.payload) ?? {};
  const actionBundle = readActionBundle(proposal) ?? {
    id: accepted?.planId ?? proposal.proposalId,
    version: '1',
    goal: stringValue(accepted?.summary) ?? 'Accepted implementation plan batch',
    actions: [],
    validationExpectations: [],
    reviewExpectations: [],
  };
  return {
    sessionId: state.sessionId,
    runId: state.runId,
    planId: accepted?.planId ?? stringValue(actionBundle.id) ?? proposal.proposalId,
    proposalId: proposal.proposalId,
    userPlan: stringValue(payload.userPlan) ?? stringValue(accepted?.summary) ?? 'Accepted implementation plan batch',
    actionBundle: actionBundle as unknown as Record<string, unknown>,
    codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
    commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
    expectedValidation: stringValue(payload.expectedValidation) ?? '',
    reviewGuide: stringValue(payload.reviewGuide) ?? '',
    planReviewReport,
    implementationPlan: accepted?.rawPlan,
  };
}

function acceptedPlanReadOnlyReviewContext(
  state: SessionDriverLoopRunState,
  accepted: AcceptedImplementationPlanContext,
  packet: ResourcePacket,
  completion: AcceptedPlanReadOnlyResourceCompletion
): SessionPlanContext {
  const targets = completion.coveredTargets.join(', ');
  return {
    sessionId: state.sessionId,
    runId: state.runId,
    planId: accepted.planId,
    proposalId: `${accepted.planId}:read-only-validation`,
    userPlan: targets
      ? `Read-only validation evidence resolved for accepted targets: ${targets}.`
      : 'Read-only validation evidence resolved for the accepted plan.',
    actionBundle: {
      version: '1',
      id: `${accepted.planId}:read-only-validation`,
      goal: 'Read-only validation evidence satisfied the accepted task.',
      actions: [],
      validationExpectations: [{
        id: 'read-only-resource-validation',
        description: `ResourcePacket ${packet.id} resolved the read-only evidence required by the accepted task.`,
      }],
      reviewExpectations: [{
        id: 'review-read-only-validation',
        description: 'Review the resolved resource evidence and accepted-plan checkpoint.',
      }],
    },
    codeBlocks: [],
    commandBlocks: [],
    expectedValidation: `ResourcePacket ${packet.id} resolved the read-only evidence for the accepted task.`,
    reviewGuide: 'Review the resolved ResourcePacket evidence and accepted-plan checkpoint.',
    implementationPlan: accepted.rawPlan,
  };
}

type NormalizedAcceptedPlanKernelBatch =
  | {
    ok: true;
    batch: {
    planId: string;
    contractId?: string;
    actionBundle: Record<string, unknown>;
    codeBlocks: unknown[];
    commandBlocks: unknown[];
    };
    reasons: [];
  }
  | {
    ok: false;
    reasons: string[];
  };

function normalizeAcceptedPlanKernelBatch(
  planId: string,
  plan: SessionPlanContext,
  accepted?: AcceptedImplementationPlanContext
): NormalizedAcceptedPlanKernelBatch {
  const actionBundle = objectRecord(plan.actionBundle);
  const actions = Array.isArray(actionBundle?.actions) ? actionBundle.actions : [];
  const codeBlocks = plan.codeBlocks.map((block) => objectRecord(block) ? { ...(objectRecord(block) ?? {}) } : block);
  const commandBlocks = [...plan.commandBlocks];
  const codeBlockById = new Map<string, Record<string, unknown>>();
  const reasons: string[] = [];

  for (const [index, block] of codeBlocks.entries()) {
    const record = objectRecord(block);
    if (!record) continue;
    const id = stringValue(record.id) ?? stringValue(record.blockId);
    if (!id) continue;
    record.id = id;
    record.blockId = stringValue(record.blockId) ?? id;
    const path = acceptedPlanOperationTargetResolver.concreteFileTarget(
      stringValue(record.targetPath) ?? stringValue(record.path) ?? '',
      accepted
    );
    if (path) {
      record.targetPath = path;
      record.path = stringValue(record.path) ?? path;
    }
    codeBlocks[index] = record;
    codeBlockById.set(id, record);
  }

  const normalizedActions = actions.map((action, index) => {
    const record = objectRecord(action);
    if (!record) {
      reasons.push(`actionBundle.actions[${index}] is not an object and cannot be submitted to Kernel.`);
      return action;
    }
    const next = { ...record };
    const capability = stringValue(next.capability);
    const kind = stringValue(next.kind);
    if (capability === 'fs.delete') {
      next.kind = kind ?? 'delete';
      const deleteGrant = acceptedPlanOperationTargetResolver.exactGrantForAction(next, accepted);
      const target = acceptedPlanOperationTargetResolver.concreteDeleteTarget(
        actionFileTargetPath(next) ?? '',
        accepted,
        deleteGrant
      );
      if (!target) {
        reasons.push(`actionBundle.actions[${index}] fs.delete is missing an executable concrete targetPath/resourceScope.`);
      } else {
        next.targetPath = target;
        next.resourceScope = [target];
        next.targetRef = objectRecord(next.targetRef) ?? fileTargetRefFromPath(target);
        const targetResourceKind = deleteActionTargetResourceKind(next) ?? deleteGrant?.targetResourceKind;
        if (targetResourceKind === 'directory') {
          next.targetKind = 'directory';
          next.targetResourceKind = 'directory';
          next.recursive = deleteActionRecursive(next) || deleteGrant?.recursive === true;
        }
      }
      return next;
    }

    if (capability !== 'fs.write' && capability !== 'fs.patch') {
      return next;
    }

    next.kind = kind ?? (capability === 'fs.patch' ? 'patch' : 'write');
    const patchLike = ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(String(next.kind));
    const blockRef = stringValue(next.replacementBlockId) ?? stringValue(next.sourceBlockId);
    if (!blockRef) {
      reasons.push(`actionBundle.actions[${index}] ${capability} is missing sourceBlockId/replacementBlockId.`);
      return next;
    }
    const block = codeBlockById.get(blockRef);
    if (!block) {
      reasons.push(`actionBundle.actions[${index}] references missing codeBlock "${blockRef}".`);
      return next;
    }
    const target = acceptedPlanOperationTargetResolver.concreteFileTarget(
      actionFileTargetPath(next) ??
      stringValue(block.targetPath) ??
      stringValue(block.path) ??
      '',
      accepted
    );
    if (!target) {
      reasons.push(`actionBundle.actions[${index}] ${capability} is missing an executable file targetPath/resourceScope.`);
      return next;
    }
    next.targetPath = target;
    next.targetRef = objectRecord(next.targetRef) ?? fileTargetRefFromPath(target);
    const existingScope = stringArrayValue(next.resourceScope)
      .map((scope) => acceptedPlanOperationTargetResolver.concreteFileTarget(scope, accepted))
      .filter((scope): scope is string => Boolean(scope));
    next.resourceScope = existingScope.length ? existingScope : [target];
    block.targetPath = stringValue(block.targetPath) ?? target;
    block.path = stringValue(block.path) ?? target;
    if (patchLike && !stringValue(next.replacementBlockId)) {
      next.replacementBlockId = blockRef;
    } else if (!stringValue(next.sourceBlockId)) {
      next.sourceBlockId = blockRef;
    }
    return next;
  });

  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
  return {
    ok: true,
    reasons: [],
    batch: {
      planId,
      contractId: planReviewGrantProjector.kernelExecutionContractId(plan.planReviewReport),
      actionBundle: {
        ...(actionBundle ?? {}),
        actions: normalizedActions,
      },
      codeBlocks,
      commandBlocks,
    },
  };
}

function canonicalizeAcceptedPlanExecutionAccessScopes(
  accepted: AcceptedImplementationPlanContext,
  proposal: ProposalEnvelope
): AcceptedPlanAccessScopeCanonicalizationResult {
  const payload = objectRecord(proposal.payload);
  const actionBundle = objectRecord(payload?.actionBundle);
  const base = {
    proposal,
    changed: false,
    removedAccessScopes: [] as RemovedAcceptedPlanAccessScope[],
    actionTargets: acceptedPlanScopeMatcher.proposalTargetScopes(proposal, accepted).map((target) => target.normalized),
  };
  if (!payload || !actionBundle) return base;

  const topLevel = canonicalizeAcceptedPlanAccessScopeArray(actionBundle.accessScopes, 'actionBundle.accessScopes');
  let nextActionBundle: Record<string, unknown> | undefined;
  if (topLevel.changed) {
    nextActionBundle = { ...actionBundle };
    if (topLevel.kept.length) {
      nextActionBundle.accessScopes = topLevel.kept;
    } else {
      delete nextActionBundle.accessScopes;
    }
  }

  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const nextActions = actions.map((action, actionIndex) => {
    const record = objectRecord(action);
    if (!record) return action;
    const actionScopes = canonicalizeAcceptedPlanAccessScopeArray(
      record.accessScopes,
      `actionBundle.actions[${actionIndex}].accessScopes`
    );
    if (!actionScopes.changed) return action;
    if (!nextActionBundle) nextActionBundle = { ...actionBundle };
    const nextAction = { ...record };
    if (actionScopes.kept.length) {
      nextAction.accessScopes = actionScopes.kept;
    } else {
      delete nextAction.accessScopes;
    }
    topLevel.removed.push(...actionScopes.removed);
    return nextAction;
  });

  if (!topLevel.changed && topLevel.removed.length === 0) return base;
  if (!nextActionBundle) nextActionBundle = { ...actionBundle };
  nextActionBundle.actions = nextActions;
  return {
    proposal: {
      ...proposal,
      payload: {
        ...payload,
        actionBundle: nextActionBundle,
      },
    },
    changed: true,
    removedAccessScopes: topLevel.removed,
    actionTargets: base.actionTargets,
  };
}

function canonicalizeAcceptedPlanAccessScopeArray(
  value: unknown,
  source: string
): { kept: unknown[]; removed: RemovedAcceptedPlanAccessScope[]; changed: boolean } {
  if (!Array.isArray(value)) return { kept: [], removed: [], changed: false };
  const kept: unknown[] = [];
  const removed: RemovedAcceptedPlanAccessScope[] = [];
  for (const [index, scope] of value.entries()) {
    const reason = invalidAcceptedPlanExecutionAccessScopeReason(scope);
    if (reason) {
      const record = objectRecord(scope);
      removed.push({
        index,
        source,
        reason,
        path: stringValue(record?.path) ?? stringValue(record?.targetPath) ?? stringValue(record?.resourcePath),
        scopeKind: stringValue(record?.scopeKind),
        scope,
      });
      continue;
    }
    kept.push(scope);
  }
  return { kept, removed, changed: removed.length > 0 };
}

function invalidAcceptedPlanExecutionAccessScopeReason(scope: unknown): string | undefined {
  const record = objectRecord(scope);
  if (!record) return 'non_object_scope';
  const rawPath = stringValue(record.path) ?? stringValue(record.targetPath) ?? stringValue(record.resourcePath);
  const normalized = rawPath ? normalizePlanScope(rawPath).replace(/\/+$/, '') : '';
  if (!normalized || normalized === '.' || normalized === '..' || normalized === '/') return 'invalid_root_scope';
  if (normalized.startsWith('../') || normalized.includes('/../')) return 'path_traversal_scope';
  if (normalized.includes('*')) return 'wildcard_scope';
  if (isAbsolutePath(normalized)) return 'absolute_scope_not_allowed_in_execution_batch';
  return undefined;
}

function fileOperationFreshnessValidationReasons(
  accepted: AcceptedImplementationPlanContext,
  proposal: ProposalEnvelope,
  resourcePackets: ResourcePacket[]
): string[] {
  const actionBundle = readActionBundle(proposal);
  const reasons: string[] = [];
  const evidenceIndex = resourceEvidenceIndex();
  for (const [index, action] of (actionBundle?.actions ?? []).entries()) {
    const capability = actionEffectiveCapability(action as unknown as Record<string, unknown>);
    const actionKind = stringValue(action.kind) ?? (capability === 'fs.patch' ? 'patch' : undefined);
    const actionArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
    const targets = acceptedPlanScopeMatcher.actionTargetScopes(action, proposal)
      .map((target) => acceptedPlanScopeMatcher.normalizeTargetScope(target, accepted))
      .filter(Boolean);
    if (capability === 'fs.patch' || ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(actionKind ?? '')) {
      const patchSpec = objectRecord(action.patchSpec) ?? objectRecord(actionArgs?.patchSpec);
      const match = objectRecord(patchSpec?.match);
      const matchText = stringValue(match?.text);
      if (!matchText) continue;
      if (!evidenceIndex.containsExactBlock(resourcePackets, targets, matchText)) {
        const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
        reasons.push(`patch action ${action.actionId || action.id || action.title || index} is missing current file/search evidence: patchSpec.match.text must come from recent ResourcePacket fileText/searchResults (target=${targetLabel}). Return resourceRequest kind="search" or read the target file/range first.`);
      }
      continue;
    }
    if (capability === 'fs.write') {
      if (writeActionIsExplicitCreate(action, proposal)) continue;
      const targetIsAccepted = targets.some((target) => acceptedPlanScopeCoverage.scopeCoveredForCapability(target, capability, accepted));
      if (!targetIsAccepted && !evidenceIndex.mentionsAnyTarget(resourcePackets, targets) && !actionDeclaresOverwritePlan(action)) {
        const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
        reasons.push(`write action ${action.actionId || action.id || action.title || index} is missing current read/search evidence or an explicit overwrite plan before overwriting an existing file (target=${targetLabel}). Return resourceRequest to read/search the target file or range first.`);
      }
      continue;
    }
    if (capability === 'fs.delete') {
      if (!targets.some((target) => acceptedPlanScopeCoverage.scopeCoveredForCapability(target, capability, accepted)) && !evidenceIndex.mentionsAnyTarget(resourcePackets, targets)) {
        const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
        reasons.push(`delete action ${action.actionId || action.id || action.title || index} is missing current directory/read/search evidence or confirmed file-level scope (target=${targetLabel}). Return resourceRequest to read the directory tree or target-file evidence first.`);
      }
      continue;
    }
    if (capability === 'fs.rename' || actionKind === 'rename') {
      if (!evidenceIndex.mentionsAnyTarget(resourcePackets, targets)) {
        const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
        reasons.push(`rename action ${action.actionId || action.id || action.title || index} is missing current source evidence (target=${targetLabel}). Return resourceRequest to read the source file or directory evidence first.`);
      }
    }
  }
  return reasons;
}

function writeActionIsExplicitCreate(action: ActionBundleDraft['actions'][number], proposal: ProposalEnvelope): boolean {
  const actionKind = stringValue(action.kind);
  if (actionKind === 'create') return true;
  const actionArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
  const payload = objectRecord(proposal.payload) ?? {};
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
  const blockIds = new Set([
    stringValue(action.sourceBlockId),
    stringValue(action.replacementBlockId),
    stringValue(actionArgs?.sourceBlockId),
    stringValue(actionArgs?.replacementBlockId),
  ].filter((item): item is string => Boolean(item)));
  return codeBlocks.some((block) => {
    const record = objectRecord(block);
    const blockId = stringValue(record?.id) ?? stringValue(record?.blockId);
    if (!blockId || !blockIds.has(blockId)) return false;
    const operation = stringValue(record?.operation);
    return operation === 'create' || operation === 'createEmpty';
  });
}

function actionDeclaresOverwritePlan(action: ActionBundleDraft['actions'][number]): boolean {
  const toolArgs = objectRecord(action.toolArgs) ?? objectRecord(action.args);
  return toolArgs?.overwrite === true || toolArgs?.overwritePlan === true || toolArgs?.confirmedOverwrite === true;
}

function acceptedPlanBatchProgress(
  accepted: AcceptedImplementationPlanContext,
  proposal: ProposalEnvelope,
  kernelEvents: unknown[]
): AcceptedPlanBatchProgress {
  return new AcceptedPlanProgressAggregator({
    scopeMatcher: new AcceptedPlanScopeMatcher(),
    workUnitIdsFromKernelEvents: (events) => kernelEventStatusIndex.workUnitIds(events),
    actionBatchHasFailureOrBlocker: (events) => kernelEventStatusIndex.hasFailureOrBlocker(events),
  }).progress(accepted, proposal, kernelEvents);
}

function acceptedPlanAfterBatch(
  accepted: AcceptedImplementationPlanContext,
  completedTaskIds: string[]
): AcceptedImplementationPlanContext {
  return acceptedPlanTaskLedger().withCompleted(accepted, completedTaskIds) ?? accepted;
}

function acceptedPlanWithLatestCheckpoint(
  accepted: AcceptedImplementationPlanContext,
  events: AgentEvent[]
): AcceptedImplementationPlanContext {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'workflow_stage') continue;
    const payload = objectRecord(event.payload);
    if (!payload) continue;
    if (stringValue(payload.stage) !== 'accepted_plan.batch_checkpoint') continue;
    if (stringValue(payload.runId) !== accepted.runId || stringValue(payload.planId) !== accepted.planId) continue;
    const completedTaskIds = stringArrayValue(payload.completedTaskIds);
    if (!completedTaskIds.length) return accepted;
    return acceptedPlanAfterBatch(accepted, completedTaskIds);
  }
  return accepted;
}

function looksLikeResourcePath(value: string): boolean {
  if (!value || value.includes(' ') || value.includes('\n')) return false;
  return value.includes('/') || /\.[A-Za-z0-9]+$/.test(value);
}

function looksLikeSearchEvidenceQuery(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120 || normalized.includes('\n')) return false;
  if (/\s/.test(normalized)) return false;
  return /^[A-Za-z_$][A-Za-z0-9_$:.*#-]*$/.test(normalized);
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function acceptedPlanComplete(accepted: AcceptedImplementationPlanContext): boolean {
  if (!accepted.tasks.length) return true;
  const completed = new Set(accepted.completedTaskIds);
  return accepted.tasks.every((task) => completed.has(task.taskId));
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizePlanScopeIdentity(value: string): string {
  return normalizePlanScope(value).replace(/\/+$/, '');
}

function expandPlanTargetTokens(target: string): string[] {
  if (!target || !target.trim()) return [];
  const candidates = target.match(/[A-Za-z0-9_.\-/]+/g) ?? [];
  const pathLike = candidates.filter((token) => token.includes('/') || /\.[A-Za-z0-9]+$/.test(token));
  return pathLike.length ? pathLike : [target.trim()];
}

function dirnameLike(value: string): string | undefined {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return undefined;
  return normalized.slice(0, index);
}

function executionSliceRoleValue(value: unknown): ExecutionSliceRole | undefined {
  const role = stringValue(value);
  if (
    role === 'sourceCode' ||
    role === 'infra' ||
    role === 'script' ||
    role === 'test' ||
    role === 'docs' ||
    role === 'config' ||
    role === 'review'
  ) {
    return role;
  }
  return undefined;
}

function nonAcceptedPlanPermissionGaps(report: Record<string, unknown>, accepted: AcceptedImplementationPlanContext): string[] {
  const gaps = Array.isArray(report.permissionGaps)
    ? report.permissionGaps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const acceptedCapabilities = new Set(accepted.capabilities);
  return gaps.filter((capability) => !planReviewGrantProjector.planAcceptedAutoGrantCapability(capability) && !acceptedCapabilities.has(capability));
}

function planReviewDecisionEvent(
  sessionId: string,
  plan: SessionPlanContext,
  status: 'accepted' | 'rejected' | 'needsRevision',
  summary: string | undefined,
  ts: string,
  id: string
): AgentEvent {
  const overlayPayload = interactionOverlayProjection(plan.interactionOverlay);
  return {
    id,
    sessionId,
    ts,
    kind: 'plan_review',
    payload: {
      title: '计划确认',
      summary: summary || (status === 'accepted' ? '用户已确认计划，准备进入执行。' : '用户要求修改计划。'),
      status,
      runId: plan.runId,
      planId: plan.planId,
      confirmable: false,
      facts: planReviewReportAnalyzer.facts(plan.planReviewReport),
      requiredFileOperations: planReviewGrantProjector.requiredFileOperationsFromReport(plan.planReviewReport),
      permissionBundles: planReviewGrantProjector.permissionBundlesFromReport(plan.planReviewReport),
      interventions: planReviewGrantProjector.gateInterventionsFromReport(plan.planReviewReport),
      executionContract: objectRecord(plan.planReviewReport?.executionContract) ?? undefined,
      ...overlayPayload,
      channel: status === 'accepted' ? 'progress' : 'final',
      visibility: 'conversation',
      presentation: 'body',
      report: plan.planReviewReport,
    },
  };
}

function sessionRunStateEvent(input: {
  sessionId: string;
  runId: string;
  phase: SessionTurnPhase;
  status?: SessionRunStateStatus;
  reason: SessionRunStateReason;
  decisionOwner: DecisionOwnerRef;
  interactionOverlay?: InteractionOverlayContext;
  ts: string;
  id: string;
}): AgentEvent {
  const status = input.status ?? 'waiting';
  const overlayPayload = interactionOverlayProjection(input.interactionOverlay);
  const summary = sessionRunStateSummary(input.reason, status);
  const messageArgs = { reason: input.reason, status };
  return {
    id: input.id,
    sessionId: input.sessionId,
    ts: input.ts,
    kind: 'session_run_state',
    payload: {
      status,
      phase: input.phase,
      reason: input.reason,
      runId: input.runId,
      decisionKind: input.decisionOwner.kind,
      targetId: input.decisionOwner.targetId,
      decisionOwner: input.decisionOwner,
      ...overlayPayload,
      summary: summary.key,
      summaryKey: summary.key,
      messageKey: summary.key,
      messageArgs,
      channel: 'task',
      visibility: 'debug',
      presentation: 'stageSummary',
    },
  };
}

function sessionRunStateSummary(
  reason: SessionRunStateReason,
  status: SessionRunStateStatus
): { key: string } {
  if (status === 'cancelled') return { key: 'session.runState.cancelled' };
  if (status === 'failed' && reason === 'work_unit_failed') return { key: 'session.runState.workUnitFailed' };
  if (status === 'failed') return { key: 'session.runState.failed' };
  if (status === 'completed' && reason === 'review') return { key: 'session.runState.reviewCompleted' };
  if (status === 'completed') return { key: 'session.runState.completed' };
  if (reason === 'accepted_plan_execution') return { key: 'session.runState.acceptedPlanExecution' };
  if (status === 'running') return { key: 'session.runState.running' };
  if (reason === 'requirement') return { key: 'session.runState.requirement' };
  if (reason === 'permission') return { key: 'session.runState.permission' };
  if (reason === 'review') return { key: 'session.runState.review' };
  return { key: 'session.runState.planReview' };
}

function requirementDrivenTaskCheckpointEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  newlyCompletedTaskIds: string[],
  completedTaskIds: string[],
  remainingTaskIds: string[],
  effectKind: RequirementOptionEffect['kind'],
  selectedOptionId: string | undefined,
  ts: string,
  id: string
): AgentEvent {
  const complete = remainingTaskIds.length === 0;
  const ledger = buildTaskLedgerSnapshot({
    planId: accepted.planId,
    runId,
    tasks: accepted.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      targets: task.targets,
      capability: task.capability,
    })),
    completedTaskIds,
    skippedTaskIds: effectKind === 'skipCurrentTask' ? newlyCompletedTaskIds : [],
    acceptedIncompleteTaskIds: effectKind === 'markAcceptedIncomplete' ? newlyCompletedTaskIds : [],
  });
  const summary = complete
    ? 'Accepted plan tasks resolved via user requirement decision; ready for final review.'
    : 'User requirement decision advanced the accepted plan task cursor.';
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.batch_checkpoint',
      status: 'completed',
      summary,
      runId,
      planId: accepted.planId,
      source: 'requirementDecision',
      effectKind,
      selectedOptionId,
      batchIndex: accepted.batchIndex,
      newlyCompletedTaskIds,
      completedTaskIds,
      remainingTaskIds,
      taskLedger: ledger,
      taskOrder: ledger.taskOrder,
      nextPendingTaskIds: ledger.pendingTaskIds,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
        status: 'completed',
        title: complete ? 'Accepted plan complete' : 'Task advanced by user decision',
        summary,
        source: 'session',
        runId,
        planId: accepted.planId,
      }),
    },
  };
}

function acceptedPlanBatchCheckpointEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  proposal: ProposalEnvelope,
  kernelEvents: unknown[],
  progress: AcceptedPlanBatchProgress,
  ts: string,
  id: string
): AgentEvent {
  const failedOrBlocked = kernelEventStatusIndex.hasFailureOrBlocker(kernelEvents);
  const complete = !failedOrBlocked && progress.remainingTaskIds.length === 0;
  const ledger = buildTaskLedgerSnapshot({
    planId: accepted.planId,
    runId,
    tasks: accepted.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      targets: task.targets,
      capability: task.capability,
    })),
    completedTaskIds: progress.completedTaskIds,
    failedTaskId: failedOrBlocked
      ? accepted.tasks.find((task) => !progress.completedTaskIds.includes(task.taskId))?.taskId
      : undefined,
  });
  const summary = failedOrBlocked
    ? '已确认计划的当前执行批次存在失败或阻塞，已暂停自动推进。'
    : complete
      ? '已确认计划的任务清单已执行完成，准备进入最终 Review。'
      : '已确认计划的当前执行批次已完成，Session 将继续生成下一批。';
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.batch_checkpoint',
      status: failedOrBlocked ? 'blocked' : 'completed',
      summary,
      runId,
      planId: accepted.planId,
      proposalId: proposal.proposalId,
      batchIndex: accepted.batchIndex,
      actionIds: progress.actionIds,
      targetPaths: progress.targetPaths,
      workUnitIds: progress.workUnitIds,
      newlyCompletedTaskIds: progress.newlyCompletedTaskIds,
      completedTaskIds: progress.completedTaskIds,
      remainingTaskIds: progress.remainingTaskIds,
      taskLedger: ledger,
      taskOrder: ledger.taskOrder,
      nextPendingTaskIds: ledger.pendingTaskIds,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: complete ? 'reviewCheckpoint' : failedOrBlocked ? 'diagnostic' : 'editBatchQueued',
        status: failedOrBlocked ? 'blocked' : 'completed',
        title: complete ? 'Accepted plan complete' : failedOrBlocked ? 'Accepted plan batch blocked' : 'Accepted plan batch completed',
        summary,
        source: 'session',
        runId,
        planId: accepted.planId,
        targets: progress.targetPaths,
        actionIds: progress.actionIds,
        workUnitIds: progress.workUnitIds,
      }),
    },
  };
}

function acceptedPlanResourceValidationCheckpointEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  packet: ResourcePacket,
  completion: AcceptedPlanReadOnlyResourceCompletion,
  ts: string,
  id: string
): AgentEvent {
  const complete = completion.remainingTaskIds.length === 0;
  const ledger = buildTaskLedgerSnapshot({
    planId: accepted.planId,
    runId,
    tasks: accepted.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      targets: task.targets,
      capability: task.capability,
    })),
    completedTaskIds: completion.completedTaskIds,
  });
  const summary = complete
    ? 'Read-only evidence satisfied the remaining accepted task; ready for final review.'
    : 'Read-only evidence satisfied the current accepted task; Session will continue with the next task.';
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.batch_checkpoint',
      status: 'completed',
      summary,
      runId,
      planId: accepted.planId,
      source: 'resourceValidation',
      batchIndex: accepted.batchIndex,
      resourcePacketId: packet.id,
      validatedTaskId: completion.taskId,
      coveredTargets: completion.coveredTargets,
      targetPaths: completion.coveredTargets,
      newlyCompletedTaskIds: completion.newlyCompletedTaskIds,
      completedTaskIds: completion.completedTaskIds,
      remainingTaskIds: completion.remainingTaskIds,
      taskLedger: ledger,
      taskOrder: ledger.taskOrder,
      nextPendingTaskIds: ledger.pendingTaskIds,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
        status: 'completed',
        title: complete ? 'Accepted plan validation complete' : 'Accepted plan read-only validation completed',
        summary,
        source: 'session',
        runId,
        planId: accepted.planId,
        targets: completion.coveredTargets,
      }),
    },
  };
}

function acceptedPlanActionBatchPreflightEvent(
  sessionId: string,
  plan: SessionPlanContext,
  batch: Record<string, unknown>,
  ts: string,
  id: string
): AgentEvent {
  const audit = acceptedPlanBatchPreflight.audit(batch);
  const summary = `Session 已完成已确认计划 actionBatch 提交前审计：${Array.isArray(audit.actions) ? audit.actions.length : 0} 个 action。`;
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.action_batch_preflight',
      status: 'completed',
      summary,
      runId: plan.runId,
      planId: plan.planId,
      audit,
      channel: 'progress',
      visibility: 'debug',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: 'diagnostic',
        status: 'completed',
        title: 'Accepted plan action batch preflight',
        summary,
        source: 'session',
        runId: plan.runId,
        planId: plan.planId,
      }),
    },
  };
}

function actionBundleAdmissionRepairingEvent(
  sessionId: string,
  runId: string,
  proposal: ProposalEnvelope,
  reasons: string[],
  ts: string,
  id: string
): AgentEvent {
  const batch = proposalActionBundleAdmissionBatch(proposal);
  const audit = acceptedPlanBatchPreflight.audit(batch);
  const summary = `ActionBundle requires revision before entering the Plan card: ${reasons.join('; ')}`;
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'action_bundle_admission.repairing',
      status: 'running',
      summary,
      runId,
      proposalId: proposal.proposalId,
      reasons,
      audit,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: 'diagnostic',
        status: 'running',
        title: 'ActionBundle admission repair',
        summary,
        source: 'session',
        runId,
        targets: audit.actions && Array.isArray(audit.actions)
          ? audit.actions.flatMap((item: unknown) => stringArrayValue(objectRecord(item)?.resourceScope).concat(stringValue(objectRecord(item)?.targetPath) ?? []))
          : [],
      }),
    },
  };
}

function actionBundleAdmissionFailureEvents(
  sessionId: string,
  runId: string,
  proposal: ProposalEnvelope,
  reasons: string[],
  ts: string,
  id: string
): AgentEvent[] {
  const summary = `ActionBundle did not enter the Plan confirmation card; Session has stopped plan generation: ${reasons.join('; ')}`;
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: summary,
        code: 'action_bundle_admission_failed',
        runId,
        proposalId: proposal.proposalId,
        reasons,
        channel: 'error',
        visibility: 'conversation',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'ActionBundle admission failed',
          summary,
          source: 'session',
          runId,
          errorCode: 'action_bundle_admission_failed',
          errorMessage: summary,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId,
      phase: 'failed',
      status: 'failed',
      reason: 'plan_review',
      decisionOwner: {
        kind: 'plan',
        runId,
        targetId: proposal.proposalId,
        planId: proposal.proposalId,
      },
      ts,
      id: `${id}-state`,
    }),
  ];
}

function planActionBundlePreflightFailureEvents(
  sessionId: string,
  plan: SessionPlanContext,
  reasons: string[],
  ts: string,
  id: string
): AgentEvent[] {
  const summary = `Accepted plan actionBatch pre-submission audit failed; Session did not submit to Kernel: ${reasons.join('; ')}`;
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: summary,
        code: 'accepted_plan_action_batch_preflight_failed',
        runId: plan.runId,
        planId: plan.planId,
        reasons,
        channel: 'error',
        visibility: 'conversation',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan action batch preflight failed',
          summary,
          source: 'session',
          runId: plan.runId,
          planId: plan.planId,
          errorCode: 'accepted_plan_action_batch_preflight_failed',
          errorMessage: summary,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId: plan.runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId: plan.runId,
        targetId: plan.planId,
        planId: plan.planId,
      },
      interactionOverlay: plan.interactionOverlay,
      ts,
      id: `${id}-state`,
    }),
  ];
}

function planActionBundleExecutionExceptionEvents(
  sessionId: string,
  plan: SessionPlanContext,
  message: string,
  code: string,
  ts: string,
  id: string
): AgentEvent[] {
  const summary = `已确认计划执行链路失败，Session 已停止自动推进：${message}`;
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: summary,
        code,
        runId: plan.runId,
        planId: plan.planId,
        channel: 'error',
        visibility: 'conversation',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan execution failed',
          summary,
          source: 'session',
          runId: plan.runId,
          planId: plan.planId,
          errorCode: code,
          errorMessage: message,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId: plan.runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId: plan.runId,
        targetId: plan.planId,
        planId: plan.planId,
      },
      interactionOverlay: plan.interactionOverlay,
      ts,
      id: `${id}-state`,
    }),
  ];
}

function planActionBundleExecutionFailureEvents(
  sessionId: string,
  plan: SessionPlanContext,
  kernelEvents: unknown[],
  batch: Record<string, unknown>,
  ts: string,
  id: string
): AgentEvent[] {
  const failures = actionBatchFailureIndex.details(kernelEvents, batch);
  const summary = failures.length
    ? `Accepted plan execution batch failed; Session has stopped auto-advancing: ${failures.map((failure) => actionBatchFailureIndex.summary(failure)).join('; ')}`
    : 'Accepted plan execution batch failed or blocked; Session has stopped auto-advancing.';
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_failed',
        status: 'failed',
        summary,
        runId: plan.runId,
        planId: plan.planId,
        failures,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan batch failed',
          summary,
          source: 'session',
          runId: plan.runId,
          planId: plan.planId,
          targets: failures.flatMap((failure) => failure.writeSet),
          actionIds: failures.flatMap((failure) => failure.actionId ? [failure.actionId] : []),
          workUnitIds: failures.flatMap((failure) => failure.workUnitId ? [failure.workUnitId] : []),
          errorCode: failures.find((failure) => failure.code)?.code,
          errorMessage: failures.find((failure) => failure.message)?.message,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId: plan.runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId: plan.runId,
        targetId: plan.planId,
        planId: plan.planId,
      },
      interactionOverlay: plan.interactionOverlay,
      ts,
      id: `${id}-state`,
    }),
  ];
}

function acceptedPlanNormalizationFailureEvents(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  reasons: string[],
  ts: string,
  id: string
): AgentEvent[] {
  const summary = `Accepted plan actionBatch pre-submission canonicalization failed; Session did not submit to Kernel: ${reasons.join('; ')}`;
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: summary,
        code: 'accepted_plan_batch_normalization_failed',
        runId,
        planId: accepted.planId,
        reasons,
        channel: 'error',
        visibility: 'conversation',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan batch normalization failed',
          summary,
          source: 'session',
          runId,
          planId: accepted.planId,
          errorCode: 'accepted_plan_batch_normalization_failed',
          errorMessage: summary,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId,
        targetId: accepted.planId,
        planId: accepted.planId,
      },
      ts,
      id: `${id}-state`,
    }),
  ];
}

function acceptedPlanExecutionFailureEvents(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  kernelEvents: unknown[],
  batch: Record<string, unknown> | undefined,
  ts: string,
  id: string
): AgentEvent[] {
  const failures = actionBatchFailureIndex.details(kernelEvents, batch);
  const summary = failures.length
    ? `Accepted plan execution batch failed; Session has stopped auto-advancing: ${failures.map((failure) => actionBatchFailureIndex.summary(failure)).join('; ')}`
    : 'Accepted plan execution batch failed or blocked; Session has stopped auto-advancing.';
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_failed',
        status: 'failed',
        summary,
        runId,
        planId: accepted.planId,
        batchIndex: accepted.batchIndex,
        failures,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan batch failed',
          summary,
          source: 'session',
          runId,
          planId: accepted.planId,
          targets: failures.flatMap((failure) => failure.writeSet),
          actionIds: failures.flatMap((failure) => failure.actionId ? [failure.actionId] : []),
          workUnitIds: failures.flatMap((failure) => failure.workUnitId ? [failure.workUnitId] : []),
          errorCode: failures.find((failure) => failure.code)?.code,
          errorMessage: failures.find((failure) => failure.message)?.message,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId,
        targetId: accepted.planId,
        planId: accepted.planId,
      },
      ts,
      id: `${id}-state`,
    }),
  ];
}

function reviewSummaryEvent(
  sessionId: string,
  plan: SessionPlanContext,
  kernelEvents: unknown[],
  ts: string,
  id: string
): AgentEvent {
  const review = reviewAssembler();
  const facts = [
    ...review.reviewFactLines(kernelEvents),
    ...review.staticSyntaxReviewFactLines(kernelEvents),
  ];
  const reviewFacts = review.findReviewFacts(kernelEvents);
  const gitReview = reviewFacts ? objectRecord(reviewFacts.gitReview) : undefined;
  const completed = Math.max(
    reviewFacts ? arrayLength(reviewFacts.completedWorkUnits) : 0,
    kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.completed').length
  );
  const failed = Math.max(
    reviewFacts ? arrayLength(reviewFacts.failedWorkUnits) : 0,
    kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.failed').length
  );
  const blocked = Math.max(
    reviewFacts ? arrayLength(reviewFacts.blockedWorkUnits) : 0,
    kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.blocked').length
  );
  const toolResults = Math.max(
    reviewFacts ? arrayLength(reviewFacts.toolResults) : 0,
    kernelEvents.filter((event) => objectRecord(event)?.kind === 'tool.completed').length
  );
  const continuations = implementationBatchContextBuilder().concreteContinuationExpectations(plan.actionBundle.continuationExpectations);
  const language = visibleLanguageForRequest(plan.userPlan);
  const summary = reviewProjectionBuilder.waitingSummary(failed, blocked, language);
  const readableReview = reviewProjectionBuilder.readableSummary(kernelEvents, reviewFacts);
  const acceptedPlanForReview = plan.implementationPlan
    ? acceptedImplementationPlanContext(plan, undefined, plan.executionRoot)
    : undefined;
  const reviewTaskLedger = acceptedPlanForReview
    ? buildAcceptedPlanTaskLedger(acceptedPlanAfterBatch(
      acceptedPlanForReview,
      acceptedPlanBatchProgress(acceptedPlanForReview, proposalEnvelopeFromPlanContext(plan), kernelEvents).completedTaskIds
    ))
    : undefined;
  const reviewFactsContext = buildReviewFactsContext({
    planId: plan.planId,
    runId: plan.runId,
    taskLedger: reviewTaskLedger,
    changedFileCount: readableReview.changedFiles.length,
    auditRefCount: readableReview.auditRefs.length,
  });
  return {
    id,
    sessionId,
    ts,
    kind: 'review_summary',
    payload: {
      title: 'Review',
      summary,
      messageKey: failed || blocked ? 'review.summary.needsAttention' : 'review.summary.waitingUserReview',
      messageArgs: {
        completed: String(completed),
        failed: String(failed),
        blocked: String(blocked),
        toolResults: String(toolResults),
      },
      content: reviewProjectionBuilder.waitingContent({
        plan,
        readableReview,
        summary,
        completed,
        failed,
        blocked,
        toolResults,
        continuations,
        gitReview,
        reviewFacts,
        language,
      }),
      status: 'waitingUserReview',
      runId: plan.runId,
      reviewId: `${plan.runId}:${plan.planId}`,
      sourcePlanId: plan.planId,
      confirmable: true,
      continuationRequested: false,
      continuationCount: continuations.length,
      continuations,
      reviewExpectations: Array.isArray(plan.actionBundle.reviewExpectations) ? plan.actionBundle.reviewExpectations : [],
      reviewFacts,
      gitReview,
      readableReview,
      reviewFactsContext,
      changedFiles: readableReview.changedFiles,
      developerDetails: {
        facts,
        reviewFacts,
        gitReview,
        reviewFactsContext,
      },
      facts,
      factCounts: {
        workUnitsCompleted: completed,
        workUnitsFailed: failed,
        workUnitsBlocked: blocked,
        toolResults,
      },
      channel: 'review',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function implementationPlanExecutionRequest(
  plan: SessionPlanContext,
  acceptedPlan: AcceptedImplementationPlanContext,
  guidance?: string
): string {
  return executionPromptCoordinator().executionRequest(plan, acceptedPlan, guidance);
}

function planRevisionRequest(plan: SessionPlanContext, guidance?: string): string {
  const report = plan.planReviewReport ? clipJson(plan.planReviewReport, 4_000) : '';
  return [
    'The user revised the pending plan card. Generate a new reviewable taskPlan from the same user goal and the revision guidance.',
    'This is plan revision, not plan acceptance. Do not execute work, do not output actionBundle, and do not claim any files were changed.',
    guidance?.trim() ? `User plan revision guidance:\n${guidance.trim()}` : 'User plan revision guidance: revise the pending plan before execution.',
    plan.userPlan ? `Previous plan card content:\n${clip(plan.userPlan, 6_000)}` : '',
    report ? `Previous Kernel PlanReview report, clipped:\n${report}` : '',
    [
      'Next proposal requirements:',
      '- Prefer kind="taskPlan" with a complete non-executable plan that waits for user confirmation.',
      '- If more read-only evidence is required before planning, return resourceRequest.',
      '- If a material user choice is still required, return decisionRequest.',
      '- Do not return actionBundle until the revised plan is explicitly accepted.',
      '- Keep targets and capabilities concrete enough for Kernel PlanReview, but do not include codeBlocks or executable tool actions in taskPlan.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function traceEvent(
  sessionId: string,
  kind: AgentEvent['kind'],
  summary: string,
  ts: string,
  id: string,
  extra: Record<string, unknown>
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind,
    payload: {
      title: 'Session decision',
      summary,
      status: 'noop',
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      ...extra,
    },
  };
}

function collectQueuedUserGuidanceEvents(events: AgentEvent[], runId?: string): UserGuidanceEvent[] {
  const consumedIds = new Set<string>();
  for (const event of events.slice(-120)) {
    if (event.kind !== 'user_guidance') continue;
    const payload = objectRecord(event.payload);
    if (!payload || stringValue(payload.status) !== 'consumed') continue;
    consumedIds.add(stringValue(payload.guidanceId) ?? event.id);
  }

  const collected: UserGuidanceEvent[] = [];
  const seen = new Set<string>();
  for (const event of events.slice(-80)) {
    if (event.kind !== 'user_guidance') continue;
    const payload = objectRecord(event.payload);
    if (!payload || stringValue(payload.status) === 'consumed') continue;
    const eventRunId = stringValue(payload.targetRunId) ?? stringValue(payload.runId);
    if (runId && eventRunId && eventRunId !== runId) continue;
    const guidanceId = stringValue(payload.guidanceId) ?? event.id;
    if (consumedIds.has(guidanceId) || seen.has(guidanceId)) continue;
    const content = stringValue(payload.content) ?? stringValue(payload.guidance) ?? stringValue(payload.summary);
    if (!content) continue;
    seen.add(guidanceId);
    collected.push({
      id: guidanceId,
      ts: event.ts,
      content: clip(content, 600),
      source: 'user',
      checkpointKind: 'nextProviderCall',
    });
  }
  return collected.slice(-8);
}

type DriverInteraction =
  | { kind: 'review'; runId: string }
  | { kind: 'plan'; runId: string; planId: string }
  | { kind: 'requirement'; runId: string; requirementId: string };

function findActiveDriverInteraction(events: AgentEvent[]): DriverInteraction | null {
  const review = reviewAssembler().findLatestActiveReviewInteraction(events);
  if (review) return review;
  const plan = planInteractionIndex.findLatestActivePlanInteraction(events);
  if (plan) return plan;
  return userInputPipeline.findLatestActiveRequirementInteraction(events);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'item';
}

function clipJson(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return clip(text ?? '', maxChars);
}

function readableDriverFailureMessage(code: string, message: string): DiagnosticInfo {
  const protocolFailureCodes = new Set([
    'agent_protocol_repair_failed',
    'accepted_plan_resource_resume_repair_failed',
    'invalid_json_envelope',
    'invalid_action_bundle',
    'invalid_action_bundle_expectation',
    'invalid_action_bundle_continuation',
  ]);
  if (!protocolFailureCodes.has(code)) return diag('generic', message, { message });
  const fallback = `${message}\n\nThe model output could not form a valid structured proposal (protocol format issue); automatic repair was attempted but unsuccessful. Previously completed steps are not affected. You may retry this turn or rephrase your request.`;
  return diag('protocolRepairFailed', fallback, { message });
}

function readableProviderFailureMessage(error: unknown): DiagnosticInfo {
  const raw = (error instanceof Error ? error.message : String(error)).trim() || 'unknown error';
  const fallback = `Model call failed: ${raw}\n\nThe connection to the model was interrupted (possibly due to network fluctuation, provider timeout, or response stream closure). Previously completed steps are not affected; please retry this turn.`;
  return diag('providerCallFailed', fallback, { raw });
}

function actionBundleAdmissionResourceFollowupRequest(
  state: SessionDriverLoopRunState,
  reasons: string[]
): string {
  return [
    'Session has resolved the read-only resource evidence required for actionBundle admission.',
    'Continue the same user request by producing a confirmable plan, but satisfy the concrete target constraints for deletion.',
    'fs.delete must use toolId="fs.delete" and args.path with concrete file targets or explicit directory targets. Workspace targets must be relative paths; user-confirmed outside targets may be absolute paths.',
    'Directory deletion must use args.targetKind="directory" and args.recursive=true so Kernel PlanReview can display it and request user confirmation. Do not output wildcards, workspace root targets, empty targets, or ambiguous cleanup targets.',
    'If ResourcePacket shows a target is a directory and the user intent really is to delete that directory, keep that directory path and set args.targetKind="directory" and args.recursive=true.',
    'If the directory scope is uncertain, or if concrete file scope still cannot be confirmed, return decisionRequest instead of an unexecutable actionBundle.',
    'Write user-visible proposal fields in the current user request language; keep protocol keys, toolIds, args keys, paths, and evidence refs unchanged.',
    reasons.length ? `Previous admission rejection reasons:\n${reasons.map((reason) => `- ${reason}`).join('\n')}` : '',
    `Current runId: ${state.runId}`,
  ].filter(Boolean).join('\n\n');
}

function shouldRequestRequirementConfirmation(
  input: SessionDriverLoopInput,
  _state: SessionDriverLoopRunState
): boolean {
  if (input.confirmedRequirement) return false;
  const mode = input.requirementConfirmationMode ?? 'auto';
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return false;
}

function requirementRecordFromProposal(
  proposal: ProposalEnvelope,
  input: SessionDriverLoopInput,
  state: SessionDriverLoopRunState,
  timestamp: string
): RequirementRecord {
  const draft = objectRecord(proposal.payload) ?? {};
  const requirementId = stringValue(draft.requirementId)
    ?? stringValue(draft.id)
    ?? proposal.proposalId
    ?? `requirement-${state.runId}`;
  const checklist: RequirementChecklist = {
    goal: stringValue(draft.goal) ?? stringValue(draft.summary) ?? stringValue(draft.reason) ?? input.content,
    explicitTasks: stringArrayValue(draft.scope)
      .concat(stringArrayValue(draft.explicitTasks))
      .filter(Boolean),
    inferredTasks: stringArrayValue(draft.inferredTasks)
      .concat(stringArrayValue(draft.constraints))
      .filter(Boolean),
    outOfScope: stringArrayValue(draft.outOfScope).concat(stringArrayValue(draft.nonGoals)),
    affectedAreaCandidates: stringArrayValue(draft.affectedAreas)
      .concat(stringArrayValue(draft.affectedAreaCandidates)),
    resourceRequests: stringArrayValue(draft.resourceRequests),
    acceptanceCriteriaCandidates: stringArrayValue(draft.acceptanceCriteria)
      .concat(stringArrayValue(draft.acceptanceCriteriaCandidates)),
    clarificationQuestions: stringArrayValue(draft.openQuestions)
      .concat(stringArrayValue(draft.clarificationQuestions)),
    riskNotes: stringArrayValue(draft.risks).concat(stringArrayValue(draft.riskNotes)),
  };
  return {
    requirementId,
    sessionId: state.sessionId,
    initialUserRequest: input.content,
    checklist,
    status: 'probing',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function requirementConfirmationEvent(input: {
  sessionId: string;
  runId: string;
  requirement: RequirementRecord;
  proposal: ProposalEnvelope;
  originalUserRequest: string;
  attachments: AgentContextAttachment[];
  executionRoot?: AcceptedImplementationPlanExecutionRoot;
  interactionOverlay?: InteractionOverlayContext;
  ts: string;
  id: string;
}): AgentEvent {
  const decisionRequest = objectRecord(input.proposal.payload);
  const language = visibleLanguageForRequest(input.originalUserRequest);
  const content = decisionRequest && requirementProjectionBuilder.isDecisionRequestPayload(decisionRequest)
    ? renderDecisionRequestMarkdown(decisionRequest, language)
    : renderRequirementConfirmationMarkdown(input.requirement);
  const summary = requirementProjectionBuilder.decisionRequestSummary(decisionRequest) ?? requirementSummary(input.requirement);
  const overlayPayload = interactionOverlayProjection(input.interactionOverlay);
  return {
    id: input.id,
    sessionId: input.sessionId,
    ts: input.ts,
    kind: 'requirement_confirmation',
    payload: {
      title: '用户介入请求',
      summary,
      content,
      status: 'waitingUserConfirmation',
      confirmable: true,
      runId: input.runId,
      requirementId: input.requirement.requirementId,
      requirement: input.requirement,
      decisionRequest: input.proposal.payload,
      proposalId: input.proposal.proposalId,
      originalUserRequest: input.originalUserRequest,
      attachments: input.attachments,
      executionRoot: AcceptedPlanExecutionRootResolver.toPayload(input.executionRoot),
      ...overlayPayload,
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function acceptedPlanAccessScopesCanonicalizedEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  canonicalization: AcceptedPlanAccessScopeCanonicalizationResult,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      title: 'Accepted plan access scope canonicalized',
      summary: 'Session removed invalid execution-batch accessScopes before Kernel PlanReview.',
      stage: 'accepted_plan.access_scope_canonicalized',
      status: 'completed',
      runId,
      planId: accepted.planId,
      removedAccessScopes: canonicalization.removedAccessScopes,
      actionTargets: [...new Set(canonicalization.actionTargets.filter(Boolean))],
      reason: 'invalid_execution_scope',
      channel: 'progress',
      visibility: 'debug',
      presentation: 'collapsible',
    },
  };
}

function isResourceBudgetConfirmation(event: AgentEvent): boolean {
  const payload = objectRecord(event.payload);
  const requirementId = stringValue(payload?.requirementId);
  return Boolean(requirementId?.startsWith(`${RESOURCE_BUDGET_REQUIREMENT_PREFIX}-`));
}

function isAcceptedPlanScopeConfirmation(event: AgentEvent): boolean {
  const payload = objectRecord(event.payload);
  const decisionRequest = objectRecord(payload?.decisionRequest);
  return stringValue(decisionRequest?.decisionScope) === 'acceptedPlanBatchOutOfScope';
}

function isAcceptedPlanExecutionConfirmation(event: AgentEvent): boolean {
  const payload = objectRecord(event.payload);
  const overlay = interactionOverlayFromPayload(payload);
  return Boolean(overlay?.acceptedPlanId);
}

function selectedRequirementDecisionOptionId(event: AgentEvent): string | undefined {
  const payload = objectRecord(event.payload);
  const selectedOption = objectRecord(payload?.selectedOption);
  return stringValue(selectedOption?.id);
}

function selectedRequirementDecisionOptionEffect(event: AgentEvent): RequirementOptionEffect | undefined {
  const payload = objectRecord(event.payload);
  const selectedOption = objectRecord(payload?.selectedOption);
  return requirementDecisionOptionEffect(selectedOption);
}

function defaultRequirementDecisionOptionEffect(event: AgentEvent): RequirementOptionEffect | undefined {
  const payload = objectRecord(event.payload);
  const decisionRequest = objectRecord(payload?.decisionRequest);
  const options = Array.isArray(decisionRequest?.options)
    ? decisionRequest.options
      .map((option) => objectRecord(option))
      .filter((option): option is Record<string, unknown> => Boolean(option))
    : [];
  const selected = options.find((option) => option.recommended === true) ?? options[0];
  return requirementDecisionOptionEffect(selected);
}

function requirementDecisionOptionEffect(
  selectedOption: Record<string, unknown> | undefined
): RequirementOptionEffect | undefined {
  const effect = objectRecord(selectedOption?.effect);
  if (!effect) return undefined;
  const kind = stringValue(effect.kind);
  if (!kind) return undefined;
  switch (kind) {
    case 'continueWithAction':
    case 'skipCurrentTask':
    case 'finishRun':
    case 'finishWithAnswer':
      return { kind } as RequirementOptionEffect;
    case 'continueCurrentTask': {
      const taskId = stringValue(effect.taskId);
      return taskId ? { kind: 'continueCurrentTask', taskId } : { kind: 'continueCurrentTask' };
    }
    case 'expandCurrentTaskScope': {
      const taskId = stringValue(effect.taskId);
      const targetPath = stringValue(effect.targetPath);
      const targetKind = stringValue(effect.targetResourceKind);
      const targetResourceKind = targetKind === 'directory' || targetKind === 'file' ? targetKind : undefined;
      const reason = stringValue(effect.reason);
      return {
        kind: 'expandCurrentTaskScope',
        ...(taskId ? { taskId } : {}),
        ...(targetPath ? { targetPath } : {}),
        ...(targetResourceKind ? { targetResourceKind } : {}),
        ...(effect.recursive === true ? { recursive: true } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case 'confirmOperationGrant':
    case 'answerReviewQuestion': {
      const taskId = stringValue(effect.taskId);
      const reason = stringValue(effect.reason);
      return {
        kind,
        ...(taskId ? { taskId } : {}),
        ...(reason ? { reason } : {}),
      } as RequirementOptionEffect;
    }
    case 'cancel': {
      const reason = stringValue(effect.reason);
      return reason ? { kind: 'cancel', reason } : { kind: 'cancel' };
    }
    case 'markAcceptedIncomplete': {
      const taskIds = Array.isArray(effect.taskIds)
        ? effect.taskIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : undefined;
      const reason = stringValue(effect.reason);
      return {
        kind: 'markAcceptedIncomplete',
        ...(taskIds?.length ? { taskIds } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case 'replan': {
      const reason = stringValue(effect.reason);
      return reason ? { kind: 'replan', reason } : { kind: 'replan' };
    }
    default:
      return undefined;
  }
}

type RequirementOptionEffect =
  | { kind: 'continueWithAction' }
  | { kind: 'skipCurrentTask' }
  | { kind: 'continueCurrentTask'; taskId?: string }
  | {
    kind: 'expandCurrentTaskScope';
    taskId?: string;
    targetPath?: string;
    targetResourceKind?: 'file' | 'directory';
    recursive?: boolean;
    reason?: string;
  }
  | { kind: 'confirmOperationGrant'; taskId?: string; reason?: string }
  | { kind: 'answerReviewQuestion'; reason?: string }
  | { kind: 'replan'; reason?: string }
  | { kind: 'finishRun' }
  | { kind: 'markAcceptedIncomplete'; taskIds?: string[]; reason?: string }
  | { kind: 'finishWithAnswer'; reason?: string }
  | { kind: 'cancel'; reason?: string };

function acceptedPlanScopeRevisionRequest(
  confirmation: AgentEvent,
  plan: SessionPlanContext | null,
  guidance?: string
): string {
  const decisionRequest = objectRecord(objectRecord(confirmation.payload)?.decisionRequest) ?? {};
  const implementationPlan = objectRecord(plan?.implementationPlan);
  const planSummary = plan
    ? {
        planId: plan.planId,
        title: stringValue(implementationPlan?.title),
        summary: stringValue(implementationPlan?.summary),
      }
    : undefined;
  return [
    'User requested an accepted-plan scope revision.',
    'Return a decisionRequest if a new user choice is required, or return a new actionBundle if the requested revision is already precise enough.',
    'Do not output legacy implementationPlan, fileOperations, accessScopes, capability, resourceScope, commandBlocks, or large/multiline codeBlocks.content.',
    'Only expand targets or toolIds when the user guidance or Kernel review reason requires it. Kernel will review the resulting execution contract and the user must confirm it before execution continues.',
    guidance?.trim() ? `User guidance:\n${guidance.trim()}` : '',
    planSummary ? `Current accepted execution summary:\n${JSON.stringify(planSummary, null, 2)}` : '',
    Object.keys(decisionRequest).length ? `Accepted-plan scope decision:\n${JSON.stringify(decisionRequest, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');
}

function renderRequirementConfirmationMarkdown(requirement: RequirementRecord): string {
  const checklist = requirement.checklist;
  const sections = [
    ['目标', checklist?.goal ? [checklist.goal] : []],
    ['范围', checklist?.explicitTasks ?? []],
    ['非目标', checklist?.outOfScope ?? []],
    ['约束', checklist?.inferredTasks ?? []],
    ['风险点', checklist?.riskNotes ?? []],
    ['验收标准', checklist?.acceptanceCriteriaCandidates ?? []],
    ['仍不明确的问题', checklist?.clarificationQuestions ?? []],
  ] as const;
  return sections
    .map(([heading, items]) => {
      const body = items.length
        ? items.map((item) => `- ${item}`).join('\n')
        : '- 暂无。';
      return `## ${heading}\n${body}`;
    })
    .join('\n\n');
}

function renderDecisionRequestMarkdown(
  decisionRequest: Record<string, unknown>,
  language: VisibleLanguage
): string {
  const options = requirementProjectionBuilder.decisionRequestOptions(decisionRequest);
  const summary = requirementProjectionBuilder.decisionRequestSummary(decisionRequest);
  const labels = language === 'en-US'
    ? {
      heading: 'Decision needed',
      options: 'Options',
      recommended: 'recommended',
      supplement: 'Supplemental input',
      supplementText: 'Use the input box to choose an option or add constraints before continuing.',
    }
    : {
      heading: '需要确认的选择',
      options: '可选方案',
      recommended: '推荐',
      supplement: '补充信息',
      supplementText: '可在输入框选择方案编号，或补充约束后再继续。',
    };
  const lines = [`## ${labels.heading}`];
  if (summary) lines.push('', summary);
  lines.push('', `## ${labels.options}`, '');
  options.forEach((option, index) => {
    const recommended = option.recommended ? `（${labels.recommended}）` : '';
    lines.push(`${index + 1}. ${option.label}${recommended}`);
    if (option.description) lines.push(`   ${option.description}`);
  });
  lines.push('', `## ${labels.supplement}`, '', labels.supplementText);
  return lines.join('\n');
}

function requirementSummary(requirement: RequirementRecord): string {
  return requirement.checklist?.goal || requirement.initialUserRequest;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string {
  const capability = stringValue(action.capability);
  if (capability) return capability;
  const toolId = stringValue(action.toolId);
  if (!toolId) return '';
  if (toolId === 'git.status' || toolId === 'git.diff') return 'git.read';
  if (toolId === 'git.push') return 'git.push';
  if (toolId.startsWith('git.')) return 'git.write';
  if (toolId === 'web.search' || toolId === 'web.fetch') return 'network.egress';
  if (toolId.startsWith('browser.')) return 'browser.control';
  if (toolId === 'provider.call') return 'provider.egress';
  return toolId;
}

function actionFileTargetPath(action: { targetRef?: unknown; targetPath?: unknown; resourceScope?: unknown; args?: unknown }): string | undefined {
  const args = objectRecord(action.args);
  return fileTargetRefPath(action.targetRef)
    ?? stringValue(action.targetPath)
    ?? stringArrayValue(action.resourceScope)[0]
    ?? stringValue(args?.path)
    ?? stringValue(args?.targetPath);
}

function fileTargetRefPath(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  const record = objectRecord(value);
  return stringValue(record?.path) ?? stringValue(record?.targetPath);
}

function fileTargetRefFromPath(path: string): Record<string, unknown> {
  return {
    kind: isAbsolutePath(path) ? 'absolutePath' : 'workspaceRelative',
    path,
  };
}

function normalizeParseError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentPlanParseError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'parse_failed', message: error.message };
  return { code: 'parse_failed', message: String(error) };
}

function collectReasoning(result: LlmChatResult): string {
  const chunks = result.chunks
    .filter((chunk) => chunk.type === 'reasoning_delta' && typeof chunk.content === 'string')
    .map((chunk) => chunk.content)
    .join('');
  return result.assistantMessage?.reasoningContent ?? chunks;
}

function proposalNarrationEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent | null {
  if (proposal.source !== 'llm') return null;
  if (proposal.kind === 'answer') return null;
  const content = proposal.narration?.trim();
  if (!content) return null;
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'progress',
      source: 'llm',
      visibility: 'conversation',
      presentation: 'body',
      label: 'DeepCode',
      proposalId: proposal.proposalId,
    },
  };
}

function planInitialUserRequest(plan: SessionPlanContext): string {
  return plan.userPlan;
}

function cacheTelemetryEvent(
  sessionId: string,
  profileId: string | undefined,
  state: SessionDriverLoopRunState,
  stage: string,
  result: LlmChatResult,
  ts: string,
  id: string
): AgentEvent | null {
  const usage = objectRecord(result.usage);
  const normalized = normalizeProviderUsage(usage);
  const promptSegmentDigests = state.contextAssembly?.segments.map((segment) => ({
    id: segment.id,
    name: segment.name,
    cacheClass: segment.cacheClass,
    stablePrefix: segment.stablePrefix,
    auditOnly: segment.auditOnly,
    contentHash: segment.contentHash,
    charLength: segment.charLength,
  })) ?? [];
  if (
    normalized.promptCacheHitTokens === undefined &&
    normalized.promptCacheMissTokens === undefined &&
    normalized.cachedTokens === undefined &&
    normalized.promptTokens === undefined &&
    normalized.completionTokens === undefined &&
    normalized.totalTokens === undefined &&
    promptSegmentDigests.length === 0
  ) {
    return null;
  }

  return {
    id,
    sessionId,
    ts,
    kind: 'cache_telemetry',
    payload: {
      provider: profileId ?? state.contextAssembly?.provider ?? 'unknown',
      providerProfileId: profileId,
      model: state.contextAssembly?.model,
      stage,
      promptCacheHitTokens: normalized.promptCacheHitTokens,
      promptCacheMissTokens: normalized.promptCacheMissTokens,
      cachedTokens: normalized.cachedTokens,
      promptTokens: normalized.promptTokens,
      completionTokens: normalized.completionTokens,
      totalTokens: normalized.totalTokens,
      normalizedUsage: normalized,
      rawUsage: usage,
      promptSegmentDigests,
      stablePrefixHash: state.contextAssembly?.stablePrefixHash,
      dynamicSuffixHash: state.contextAssembly?.dynamicSuffixHash,
      cacheHash: state.contextAssembly?.cacheHash,
      cacheAffectsCorrectness: false,
    },
  };
}

function normalizeProviderUsage(usage: Record<string, unknown> | undefined): Record<string, number | undefined> {
  const promptTokens = numberValue(usage?.prompt_tokens) ?? numberValue(usage?.input_tokens);
  const completionTokens = numberValue(usage?.completion_tokens) ?? numberValue(usage?.output_tokens);
  const totalTokens = numberValue(usage?.total_tokens)
    ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
  const cachedTokens = numberValue(usage?.cached_tokens)
    ?? numberAtPath(usage, ['prompt_tokens_details', 'cached_tokens'])
    ?? numberAtPath(usage, ['input_tokens_details', 'cached_tokens']);
  const promptCacheHitTokens = numberValue(usage?.prompt_cache_hit_tokens)
    ?? numberValue(usage?.cache_read_input_tokens)
    ?? cachedTokens;
  const promptCacheMissTokens = numberValue(usage?.prompt_cache_miss_tokens)
    ?? numberValue(usage?.cache_creation_input_tokens)
    ?? (promptTokens !== undefined && promptCacheHitTokens !== undefined
      ? Math.max(0, promptTokens - promptCacheHitTokens)
      : undefined);
  return {
    promptCacheHitTokens,
    promptCacheMissTokens,
    cachedTokens,
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function numberAtPath(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    const record = objectRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return numberValue(current);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

type VisibleLanguage = 'zh-CN' | 'en-US';

function visibleLanguageForRequest(userRequest: string): VisibleLanguage {
  return /[\u3400-\u9fff]/.test(userRequest) ? 'zh-CN' : 'en-US';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}... [truncated]`;
}

function compactString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'resource';
}

function joinFsPath(root: string, child: string): string {
  const cleanRoot = root.replace(/\/+$/g, '');
  const cleanChild = child.replace(/^\/+/g, '');
  return `${cleanRoot}/${cleanChild}`;
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}
