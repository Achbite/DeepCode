import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
  LlmChatStreamEvent,
  ProjectionDelta,
} from '@deepcode/protocol';
import {
  AcceptedPlanAdmission,
  AcceptedPlanBatchPreflight,
  AcceptedPlanExecutor,
  AcceptedPlanExecutionRootResolver,
  AcceptedPlanOperationTargetResolver,
  AcceptedPlanScopeCoverage,
  AcceptedPlanScopeDecisionCoordinator,
  AcceptedPlanScopeDecisionOverlay,
  AcceptedPlanScopeRepairCoordinator,
  AcceptedPlanScopeResourceFollowupCoordinator,
  ActionBundleAdmissionRepairCoordinator,
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
  RepairLoop,
  ReviewFactsAggregator,
  type AcceptedImplementationPlanContext,
  type AcceptedImplementationPlanExecutionRoot,
  type AcceptedPlanAccessScope,
  type AcceptedPlanBatchValidationResult,
  type AcceptedPlanExactOperationGrant,
  type CurrentTaskContext,
  type ExecutionSliceRole,
  type ImplementationBatchContext,
  type TaskExecutionCursor,
} from './execution/index.js';
import {
  AgentPlanParseError,
  type ProposalEnvelope,
  type ResourceRequestDraft,
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
} from '../context/index.js';
import type { PromptEnvelope } from '../prompt/types.js';
import { AcceptedPlanResourceResumePromptBuilder } from '../prompt/AcceptedPlanResourceResumePromptBuilder.js';
import { ProviderRepairMessageBuilder, type ProviderRepairMessageState } from '../prompt/ProviderRepairMessageBuilder.js';
import {
  NativeToolCoordinator,
  NativeToolCoordinatorError,
  NativeToolHandlerPortsFactory,
  NativeToolProgressEventBuilder,
  NativeToolProviderLoop,
  NativeToolProjectionBuilder,
  NativeToolRepairCoordinator,
  NativeToolRepairRunner,
  NativeToolResultMessageBuilder,
  NativeToolResourceRecorder,
  NativeToolResumeMessageBuilder,
  NativeToolTurnHandler,
  ProposalOnlyProviderRunner,
  ProviderJsonModeCoordinator,
  ProviderPipeline,
  ProviderStreamCoordinator,
  ProviderStreamRuntime,
  ProviderTurnRunner,
  ProviderTraceRecorder,
  ProviderToolCallBuffer,
  type ProviderPartFrameParser,
  type NativeToolHandlingResult,
  type NativeToolReadLedgerEntry,
  type NativeToolReadSignature,
  type NativeToolCallProposal,
} from './pipelines/providerPipeline.js';
import { InteractionOverlayCodec, type InteractionOverlayContext, type SessionTurnPhase } from './pipelines/interactionOverlayCodec.js';
import { PermissionPipeline } from './pipelines/permissionPipeline.js';
import { UserGuidanceQueue } from './pipelines/userGuidanceQueue.js';
import { UserInputPipeline } from './pipelines/userInputPipeline.js';
import {
  AcceptedPlanResourceResumeCoordinator,
  ActionBundleAdmissionResourceFollowupCoordinator,
  ContextFrameBuilder,
  GeneratedArtifactEvidenceIndex,
  PathIdentity,
  ResourceEvidenceIndex,
  ResourceManifestBuilder,
  ResourceOrchestrator,
  ResourceRequestRepairCoordinator,
  ResourceRequestLoop,
  ResourceRequestResolver,
  type GeneratedArtifactEvidence,
  type ResourceRequestResolution,
} from './context/index.js';
import type { RequirementRecord } from '../requirement/types.js';
import type { TranscriptEntry } from '../transcript.js';
import {
  buildAcceptedPlanPromptFrame,
  buildReviewFactsContext,
  buildTaskLedgerSnapshot,
  type AcceptedPlanPromptFrame,
  type TaskLedgerSnapshot,
} from '../run-state/index.js';
import type { DriverRequestRef, KernelStateContractRef } from './types.js';
import {
  AcceptedPlanReviewHandoffCoordinator,
  ReviewAssembler,
  ReviewDecisionProjectionBuilder,
  type SessionReviewContext,
} from './review/index.js';
import { PermissionDecisionHandler, PlanDecisionHandler, RequirementDecisionHandler, ReviewDecisionHandler } from './interactions/index.js';
import {
  ActionBundleActionInspector,
  PlanContextIndex,
  PlanInteractionIndex,
  PlanReviewGrantProjector,
  PlanReviewReportAnalyzer,
  ProposalSemanticValidator,
  ProtocolGate,
  type PlanContext as SessionPlanContext,
} from './proposal/index.js';
import {
  AssistantProjectionBuilder,
  DriverActivityBuilder,
  KernelEventProjectionBuilder,
  PlanProjectionBuilder,
  RequirementProjectionBuilder,
  ReviewProjectionBuilder,
  SessionFailureProjectionBuilder,
  SessionProgressProjectionBuilder,
  type DecisionOwnerRef,
  type SessionRunStateReason,
  type SessionRunStateStatus,
} from './projection/index.js';
import type { ProviderTurnContract } from './runFrame.js';
import { AgentRunReactor } from './agentRunReactor.js';

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

interface LlmTurnResult {
  result: LlmChatResult;
  content: string;
  reasoning: string;
  toolCalls: NativeToolCallProposal[];
}

const MAX_DERIVED_MANIFEST_ENTRIES = 240;
const RESOURCE_MANIFEST_MAX_BYTES = 512 * 1024;
const MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES = 384 * 1024;
const providerRepairMessageBuilder = new ProviderRepairMessageBuilder(MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES);
const acceptedPlanResourceResumePromptBuilder = new AcceptedPlanResourceResumePromptBuilder(providerRepairMessageBuilder);
const providerPipeline = new ProviderPipeline();
const providerJsonModeCoordinator = new ProviderJsonModeCoordinator();
const providerStreamCoordinator = new ProviderStreamCoordinator();
const providerTraceRecorder = new ProviderTraceRecorder();
const actionBundleActionInspector = new ActionBundleActionInspector();
const driverActivityBuilder = new DriverActivityBuilder({
  providerStageSummary: (stage, part, language) => providerStreamCoordinator.stageSummary(stage, part, language),
  visibleLanguageForRequest,
  actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
});
const permissionPipeline = new PermissionPipeline();
const userInputPipeline = new UserInputPipeline();
const userGuidanceQueue = new UserGuidanceQueue();
const interactionOverlayCodec = new InteractionOverlayCodec();
const acceptedPlanTargetParser = new AcceptedPlanTargetParser();
const planReviewGrantProjector = new PlanReviewGrantProjector();
const planReviewReportAnalyzer = new PlanReviewReportAnalyzer({
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
});
const planContextIndex = new PlanContextIndex({
  interactionOverlayFromPayload: (payload) => interactionOverlayCodec.fromPayload(payload),
  executionRootFromPayload: (payload) => AcceptedPlanExecutionRootResolver.fromPayload(payload),
});
const planInteractionIndex = new PlanInteractionIndex<SessionPlanContext>({
  planCardAwaitingDecision: (payload) => planReviewReportAnalyzer.planCardAwaitingDecision(payload),
  planReviewEventAwaitingDecision: (payload) => planReviewReportAnalyzer.planReviewEventAwaitingDecision(payload),
  planContextFromEvent: (event, payload) => planContextIndex.contextFromEvent(event, payload),
  findPlanCard: (events, runId, planId) => planContextIndex.findPlanCard(events, runId, planId),
  planAlreadyResolved: (events, plan) => planContextIndex.alreadyResolved(events, plan),
});
const kernelEventProjectionBuilder = new KernelEventProjectionBuilder({
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
  requiredAccessScopesFromReport: (report) => planReviewGrantProjector.requiredAccessScopesFromReport(report),
  permissionBundlesFromReport: (report) => planReviewGrantProjector.permissionBundlesFromReport(report),
  gateInterventionsFromReport: (report) => planReviewGrantProjector.gateInterventionsFromReport(report),
  planReviewFacts: (report) => planReviewReportAnalyzer.facts(report),
});
const planProjectionBuilder = new PlanProjectionBuilder({
  readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
  requiredAccessScopesFromReport: (report) => planReviewGrantProjector.requiredAccessScopesFromReport(report),
  permissionBundlesFromReport: (report) => planReviewGrantProjector.permissionBundlesFromReport(report),
  gateInterventionsFromReport: (report) => planReviewGrantProjector.gateInterventionsFromReport(report),
  planReviewFacts: (report) => planReviewReportAnalyzer.facts(report),
  interactionOverlayProjection: (overlay) => interactionOverlayCodec.toPayload(overlay as InteractionOverlayContext | undefined),
  visibleLanguageForRequest,
});
const requirementProjectionBuilder = new RequirementProjectionBuilder({
  visibleLanguageForRequest,
  interactionOverlayPayload: (payload) => interactionOverlayCodec.toPayload(interactionOverlayCodec.fromPayload(payload)),
});
const assistantProjectionBuilder = new AssistantProjectionBuilder({
  visibleLanguageForRequest,
  guidanceRevisionTransitionMessage: (language) => providerStreamCoordinator.guidanceRevisionTransitionMessage(language),
});
const sessionProgressProjectionBuilder = new SessionProgressProjectionBuilder({
  interactionOverlayPayload: (overlay) => interactionOverlayCodec.toPayload(overlay),
  hasFailureOrBlocker: (kernelEvents) => kernelEventStatusIndex.hasFailureOrBlocker(kernelEvents),
  auditAcceptedPlanBatch: (batch) => acceptedPlanBatchPreflight.audit(batch),
  actionBundleAdmissionBatch: (proposal) => driverActivityBuilder.proposalActionBundleAdmissionBatch(proposal),
  acceptedPlanTaskLedger: (accepted) => acceptedPlanTaskLedger().ledger(accepted),
  acceptedPlanPromptFrame: (accepted, taskLedger) => acceptedPlanTaskLedger().promptFrame(accepted, taskLedger),
});
const sessionFailureProjectionBuilder = new SessionFailureProjectionBuilder({
  actionBatchFailureDetails: (kernelEvents, batch) => actionBatchFailureIndex.details(kernelEvents, batch),
  actionBatchFailureSummary: (failure) => actionBatchFailureIndex.summary(failure),
  sessionRunStateEvent: (input) => sessionProgressProjectionBuilder.sessionRunStateEvent(input),
});
const reviewProjectionBuilder = new ReviewProjectionBuilder<SessionPlanContext, AcceptedImplementationPlanContext, TaskLedgerSnapshot>({
  reviewFactLines: (kernelEvents) => reviewAssembler().reviewFactLines(kernelEvents),
  staticSyntaxReviewFactLines: (kernelEvents) => reviewAssembler().staticSyntaxReviewFactLines(kernelEvents),
  findReviewFacts: (kernelEvents) => reviewAssembler().findReviewFacts(kernelEvents),
  concreteContinuationExpectations: (value) => implementationBatchContextBuilder().concreteContinuationExpectations(value),
  languageForRequest: (userPlan) => visibleLanguageForRequest(userPlan),
  acceptedPlanContext: (plan) => plan.implementationPlan
    ? acceptedImplementationPlanContextBuilder().build({ plan, interventionLevel: undefined, executionRoot: plan.executionRoot })
    : undefined,
  acceptedPlanBatchCompletedTaskIds: (acceptedPlan, plan, kernelEvents) =>
    acceptedPlanTaskLedger().batchProgress({ acceptedPlan, proposal: planContextIndex.proposalEnvelope(plan), kernelEvents }).completedTaskIds,
  acceptedPlanAfterBatch: (acceptedPlan, completedTaskIds) => acceptedPlanTaskLedger().afterBatch(acceptedPlan, completedTaskIds),
  acceptedPlanTaskLedger: (acceptedPlan) => acceptedPlanTaskLedger().ledger(acceptedPlan),
  buildReviewFactsContext: (input) => buildReviewFactsContext(input),
});
const actionBatchFailureIndex = new ActionBatchFailureIndex();
const kernelEventStatusIndex = new KernelEventStatusIndex();
const repairLoop = new RepairLoop();
const pathIdentity = new PathIdentity();
const acceptedPlanScopeMatcher = new AcceptedPlanScopeMatcher();
const acceptedPlanScopeCoverage = new AcceptedPlanScopeCoverage({
  taskTargets: (task) => acceptedPlanTargetParser.taskTargets(task),
});
const acceptedPlanOperationTargetResolver = new AcceptedPlanOperationTargetResolver({
  normalizeTargetScope: (value, accepted) => acceptedPlanScopeMatcher.normalizeTargetScope(value, accepted),
  normalizePlanScope: (value) => pathIdentity.normalizePlanScope(value),
  concreteDirectoryOperationTarget: (value) => planReviewGrantProjector.concreteDirectoryOperationTarget(value),
  concreteFileOperationTarget: (value) => planReviewGrantProjector.concreteFileOperationTarget(value),
  exactGrantCapabilityMatches: (grant, capability) => acceptedPlanScopeCoverage.exactGrantCapabilityMatches(grant, capability),
  actionEffectiveCapability: (action) => actionBundleActionInspector.actionEffectiveCapability(action),
  actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
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
  batchActionRecords: (batch) => driverActivityBuilder.batchActionRecords(batch),
  objectRecord,
  stringValue,
  stringArrayValue,
  actionEffectiveCapability: (action) => actionBundleActionInspector.actionEffectiveCapability(action),
  actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
  deleteActionTargetResourceKind: (action) => actionBundleActionInspector.deleteActionTargetResourceKind(action),
  deleteActionRecursive: (action) => actionBundleActionInspector.deleteActionRecursive(action),
  normalizePlanScope: (value) => pathIdentity.normalizePlanScope(value),
  containsDirectoryPath: (resourcePackets, path) => resourceRequestLoop.containsDirectoryPath(resourcePackets, path),
});
const completedWorkUnitFactIndex = new CompletedWorkUnitFactIndex({
  objectRecord,
  stringValue,
  stringArrayValue,
  kernelEventTargets: (record) => kernelEventProjectionBuilder.kernelEventTargets(record),
  normalizeRelativePath: (value) => pathIdentity.normalizeRelativePath(value),
  comparablePath: (value) => pathIdentity.comparablePath(value),
});
const nativeToolCoordinator = new NativeToolCoordinator();
const nativeToolTurnHandler = new NativeToolTurnHandler(nativeToolCoordinator);
const nativeToolRepairCoordinator = new NativeToolRepairCoordinator({
  conversationActivity: (input) => driverActivityBuilder.conversationActivity(input),
  parseProposal: (input) => protocolGate().parseAndValidateProposal(input),
  parseRepairedProposal: (input) => protocolGate().parseAndValidateRepairedProposal(input),
});
const acceptedPlanExecutor = new AcceptedPlanExecutor({
  readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
  operationTargetResolver: acceptedPlanOperationTargetResolver,
  actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
  fileTargetRefFromPath: (path) => actionBundleActionInspector.fileTargetRefFromPath(path),
  deleteActionTargetResourceKind: (action) => actionBundleActionInspector.deleteActionTargetResourceKind(action),
  deleteActionRecursive: (action) => actionBundleActionInspector.deleteActionRecursive(action),
  kernelExecutionContractId: (report) => planReviewGrantProjector.kernelExecutionContractId(report),
  proposalTargetScopes: (proposal, accepted) =>
    acceptedPlanScopeMatcher.proposalTargetScopes(proposal, accepted).map((target) => target.normalized),
  actionTargetScopes: (action, proposal, accepted) =>
    acceptedPlanScopeMatcher.actionTargetScopes(action, proposal)
      .map((target) => acceptedPlanScopeMatcher.normalizeTargetScope(target, accepted))
      .filter(Boolean),
  scopeCoveredForCapability: (scope, capability, accepted) =>
    acceptedPlanScopeCoverage.scopeCoveredForCapability(scope, capability, accepted),
  resourceEvidenceIndex: resourceEvidenceIndex(),
});
const contextFrameBuilder = new ContextFrameBuilder();
const resourceRequestLoop = new ResourceRequestLoop({
  maxDerivedManifestEntries: MAX_DERIVED_MANIFEST_ENTRIES,
});
const nativeToolProjectionBuilder = new NativeToolProjectionBuilder({
  conversationActivity: (input) => driverActivityBuilder.conversationActivity(input),
  packetActivity: (packet, activityId, runId) => resourceRequestLoop.packetActivity(packet, activityId, runId),
  runningSummary: (toolName, language) => providerStreamCoordinator.nativeToolResolveRunningSummary(toolName, language),
  completedSummary: (toolName, language) => providerStreamCoordinator.nativeToolResolveCompletedSummary(toolName, language),
});
const NATIVE_TOOL_RESULT_MAX_CHARS = 12 * 1024;
const nativeToolResultMessageBuilder = new NativeToolResultMessageBuilder({
  duplicateResult: (toolCall, existing) => nativeToolCoordinator.duplicateResult(toolCall, existing),
  resultFromPacket: (toolCall, packet) => nativeToolCoordinator.resultFromPacket(toolCall, packet),
}, NATIVE_TOOL_RESULT_MAX_CHARS);
const nativeToolResourceRecorder = new NativeToolResourceRecorder({
  packetContentHash: (packet) => nativeToolCoordinator.packetContentHash(packet),
  addDiscoveredManifestEntries: (manifest, packet) => resourceRequestLoop.addDiscoveredManifestEntries(manifest, packet),
  packetEvent: (sessionId, packet, ts, id) => resourceRequestLoop.packetEvent(sessionId, packet, ts, id),
});
const nativeToolResumeMessageBuilder = new NativeToolResumeMessageBuilder({
  callToProtocol: (toolCall) => nativeToolCoordinator.callToProtocol(toolCall),
});
const nativeToolProgressEventBuilder = new NativeToolProgressEventBuilder();
const nativeToolProviderLoop = new NativeToolProviderLoop<SessionDriverLoopRunState, PromptEnvelope, LlmTurnResult>({
  providerPipeline,
  turnHandler: nativeToolTurnHandler,
  resumeMessageBuilder: nativeToolResumeMessageBuilder,
});
const proposalOnlyProviderRunner = new ProposalOnlyProviderRunner<SessionDriverLoopRunState, LlmTurnResult>({
  providerPipeline,
  repairCoordinator: nativeToolRepairCoordinator,
});
const nativeToolRepairRunner = new NativeToolRepairRunner({
  repairCoordinator: nativeToolRepairCoordinator,
});
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
  private readonly agentRunReactor: AgentRunReactor<SessionDriverLoopRunState>;
  private readonly acceptedPlanResourceResumeCoordinator: AcceptedPlanResourceResumeCoordinator<SessionDriverLoopRunState>;
  private readonly acceptedPlanScopeDecisionCoordinator: AcceptedPlanScopeDecisionCoordinator<SessionDriverLoopRunState>;
  private readonly acceptedPlanScopeRepairCoordinator: AcceptedPlanScopeRepairCoordinator<SessionDriverLoopRunState>;
  private readonly acceptedPlanScopeResourceFollowupCoordinator: AcceptedPlanScopeResourceFollowupCoordinator<SessionDriverLoopRunState, AcceptedImplementationPlanContext>;
  private readonly acceptedPlanReviewHandoffCoordinator: AcceptedPlanReviewHandoffCoordinator<SessionPlanContext>;
  private readonly actionBundleAdmissionRepairCoordinator: ActionBundleAdmissionRepairCoordinator<SessionDriverLoopRunState>;
  private readonly actionBundleAdmissionResourceFollowupCoordinator: ActionBundleAdmissionResourceFollowupCoordinator<SessionDriverLoopRunState>;
  private readonly permissionDecisionHandler: PermissionDecisionHandler<SessionPlanContext>;
  private readonly planDecisionHandler: PlanDecisionHandler;
  private readonly requirementDecisionHandler: RequirementDecisionHandler;
  private readonly reviewDecisionHandler: ReviewDecisionHandler;
  private readonly resourceOrchestrator: ResourceOrchestrator<SessionDriverLoopRunState>;
  private readonly resourceRequestRepairCoordinator: ResourceRequestRepairCoordinator<SessionDriverLoopRunState>;
  private readonly nativeToolHandlerPortsFactory: NativeToolHandlerPortsFactory<SessionDriverLoopRunState, PromptEnvelope, LlmTurnResult>;
  private readonly providerStreamRuntime: ProviderStreamRuntime<SessionDriverLoopRunState>;
  private readonly providerTurnRunner: ProviderTurnRunner<SessionDriverLoopRunState>;

  constructor(private readonly ports: SessionDriverLoopPorts) {
    this.agentRunReactor = new AgentRunReactor<SessionDriverLoopRunState>({
      ports: this.ports,
      kernelProjection: kernelEventProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
      createError: (code, message) => new SessionDriverLoopError(code, message),
      errorCode: (error, fallback) => error instanceof SessionDriverLoopError ? error.code : fallback,
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
    });
    this.acceptedPlanResourceResumeCoordinator = new AcceptedPlanResourceResumeCoordinator<SessionDriverLoopRunState>({
      promptBuilder: acceptedPlanResourceResumePromptBuilder,
      contextFrameBuilder,
      repairMessageBuilder: providerRepairMessageBuilder,
      repairState: (state) => providerRepairMessageState(state),
      createId: (prefix) => this.id(prefix),
      parseError: (error) => normalizeParseError(error),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      appendRepairNotice: (state, message) => this.append(state.sessionId, [
        assistantProjectionBuilder.thinkingEvent(
          state.sessionId,
          message,
          this.ts(),
          this.id('accepted-plan-resource-resume-repair')
        ),
      ]),
      parseProviderProposal: ({ raw, state }) => protocolGate().parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowBriefActionBundleUserPlan: true,
      }),
      parseRepairedProviderProposal: ({ raw, state, allowedKinds }) => protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds,
        allowBriefActionBundleUserPlan: true,
      }),
    });
    this.acceptedPlanScopeRepairCoordinator = new AcceptedPlanScopeRepairCoordinator<SessionDriverLoopRunState>({
      repairMessageBuilder: providerRepairMessageBuilder,
      repairState: (state) => providerRepairMessageState(state),
      parseError: (error) => normalizeParseError(error),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      parseRepairedProposal: ({ raw, state, allowedKinds }) => protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds,
        allowBriefActionBundleUserPlan: true,
      }),
    });
    this.acceptedPlanScopeDecisionCoordinator = new AcceptedPlanScopeDecisionCoordinator<SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      requirementPipeline: userInputPipeline,
      interactionOverlayCodec,
      requirementProjection: requirementProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
      append: (sessionId, events) => this.append(sessionId, events),
    });
    this.acceptedPlanReviewHandoffCoordinator = new AcceptedPlanReviewHandoffCoordinator<SessionPlanContext>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      kernel: (request) => this.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.appendProjectedKernelEvents(sessionId, reply),
      append: (sessionId, events) => this.append(sessionId, events),
      assertKernelReplyOk,
      acceptedPlanKernelEvents: ReviewFactsAggregator.acceptedPlanKernelEvents,
      reviewProjection: reviewProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
    });
    this.permissionDecisionHandler = new PermissionDecisionHandler<SessionPlanContext>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      kernel: (request) => this.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.appendProjectedKernelEvents(sessionId, reply),
      append: (sessionId, events) => this.append(sessionId, events),
      permissionPipeline,
      kernelStatus: kernelEventStatusIndex,
      planIndex: planContextIndex,
      reviewProjection: reviewProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
    });
    this.planDecisionHandler = new PlanDecisionHandler({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      resumeUserTurn: (resumeInput) => this.runUserTurn(resumeInput),
      executeAcceptedActionBundlePlan: (handlerInput, plan, initialResult, acceptedOverlay) =>
        this.executeAcceptedActionBundlePlan({ ...handlerInput, kind: 'plan' }, plan, initialResult, acceptedOverlay),
      activeDriverInteraction: (events) => findActiveDriverInteraction(events),
      executionRootFromDecision: (handlerInput, events) =>
        AcceptedPlanExecutionRootResolver.fromDecision(handlerInput, events),
      buildAcceptedImplementationPlan: ({ plan, interventionLevel, executionRoot }) =>
        acceptedImplementationPlanContextBuilder().build({ plan, interventionLevel, executionRoot }),
      recoverAcceptedPlanFromOverlay: (handlerInput, events, overlay) =>
        recoverAcceptedPlanFromOverlay({ ...handlerInput, kind: 'plan' }, events, overlay),
      planRevisionRequest: (request) => repairLoop.planRevisionRequest(request),
      executionRequest: (plan, acceptedPlan, guidance) => executionPromptCoordinator().executionRequest(plan, acceptedPlan, guidance),
      planIndex: planContextIndex,
      planProjection: planProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
    });
    this.requirementDecisionHandler = new RequirementDecisionHandler({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      resumeUserTurn: (resumeInput) => this.runUserTurn(resumeInput),
      activeDriverInteraction: (events) => findActiveDriverInteraction(events),
      executionRootFromDecision: (handlerInput, events) =>
        AcceptedPlanExecutionRootResolver.fromDecision(handlerInput, events),
      buildAcceptedImplementationPlan: ({ plan, interventionLevel, executionRoot }) =>
        acceptedImplementationPlanContextBuilder().build({ plan, interventionLevel, executionRoot }),
      recoverAcceptedPlanFromOverlay: (handlerInput, events, overlay) =>
        recoverAcceptedPlanFromOverlay({ ...handlerInput, kind: 'requirement' }, events, overlay),
      visibleLanguageForRequest,
      userInputPipeline,
      interactionOverlayCodec,
      requirementProjection: requirementProjectionBuilder,
      assistantProjection: assistantProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
      planIndex: planContextIndex,
      acceptedPlanLedger: acceptedPlanTaskLedger(),
      acceptedPlanScopeDecisionOverlay,
      executionPrompt: executionPromptCoordinator(),
      repairLoop,
    });
    this.reviewDecisionHandler = new ReviewDecisionHandler({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      kernel: (request) => this.kernel(request),
      kernelAudit: (request) => this.ports.kernelCommand(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.appendProjectedKernelEvents(sessionId, reply),
      append: (sessionId, events) => this.append(sessionId, events),
      resumeUserTurn: (resumeInput) => this.runUserTurn(resumeInput),
      reviewAssembler: reviewAssembler(),
      reviewDecisionProjection: reviewDecisionProjection(),
      kernelStatus: kernelEventStatusIndex,
      progressProjection: sessionProgressProjectionBuilder,
    });
    this.actionBundleAdmissionRepairCoordinator = new ActionBundleAdmissionRepairCoordinator<SessionDriverLoopRunState>({
      repairMessageBuilder: providerRepairMessageBuilder,
      repairState: providerRepairMessageState,
      parseError: normalizeParseError,
      createError: (code, message) => new SessionDriverLoopError(code, message),
      parseRepairedProposal: ({ raw, state, allowedKinds }) => protocolGate().parseAndValidateRepairedProposal({ raw, runId: state.runId, sessionId: state.sessionId, source: 'llm', allowedKinds }),
    });
    this.resourceOrchestrator = new ResourceOrchestrator<SessionDriverLoopRunState>({
      resourceRequestLoop,
      runtime: this.agentRunReactor,
      createError: (code, message) => new SessionDriverLoopError(code, message),
    });
    this.acceptedPlanScopeResourceFollowupCoordinator = new AcceptedPlanScopeResourceFollowupCoordinator<SessionDriverLoopRunState, AcceptedImplementationPlanContext>({
      generatedEvidence: generatedArtifactEvidenceIndex(),
      resolver: resourceRequestResolver(),
      resourceLoop: resourceRequestLoop,
      orchestrator: this.resourceOrchestrator,
      createId: (prefix) => this.id(prefix),
      appendFailure: ({ state, detail, eventId }) => this.append(state.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(
          state.sessionId,
          diag(
            'autoBatchResourceResolveFailed',
            `Automatic execution batch requires additional resource evidence, but the repaired resourceRequest could not be located: ${detail}`,
            { detail }
          ),
          this.ts(),
          eventId
        ),
      ]),
      followupRequest: ({ state, acceptedPlan, proposal, guidance }) => executionPromptCoordinator().executionRequest(
        acceptedPlanExecutor.executionContext({
          sessionId: state.sessionId,
          runId: state.runId,
          acceptedPlan,
          proposal,
          planReviewReport: {},
        }),
        acceptedPlan,
        guidance
      ),
    });
    this.actionBundleAdmissionResourceFollowupCoordinator = new ActionBundleAdmissionResourceFollowupCoordinator<SessionDriverLoopRunState>({
      generatedEvidence: generatedArtifactEvidenceIndex(),
      resolver: resourceRequestResolver(),
      resourceLoop: resourceRequestLoop,
      orchestrator: this.resourceOrchestrator,
      createId: (prefix) => this.id(prefix),
      appendFailure: ({ state, proposal, reasons, eventId }) => this.append(
        state.sessionId,
        sessionFailureProjectionBuilder.actionBundleAdmissionFailureEvents(
          state.sessionId,
          state.runId,
          proposal,
          reasons,
          this.ts(),
          eventId
        )
      ),
      followupRequest: (request) => repairLoop.actionBundleAdmissionResourceFollowupRequest(request),
    });
    this.resourceRequestRepairCoordinator = new ResourceRequestRepairCoordinator<SessionDriverLoopRunState>({
      repairMessageBuilder: providerRepairMessageBuilder,
      repairState: (state) => providerRepairMessageState(state),
      parseError: (error) => normalizeParseError(error),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      parseRepairedProposal: ({ raw, state, allowedKinds }) => protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds,
      }),
    });
    this.nativeToolHandlerPortsFactory = new NativeToolHandlerPortsFactory({
      progressEventBuilder: nativeToolProgressEventBuilder,
      projectionBuilder: nativeToolProjectionBuilder,
      resultMessageBuilder: nativeToolResultMessageBuilder,
      resourceRecorder: nativeToolResourceRecorder,
      visibleLanguage: (userRequest) => visibleLanguageForRequest(userRequest),
      event: (sessionId, kind, payload) => this.event(sessionId, kind, payload),
      append: (sessionId, events) => this.append(sessionId, events),
      emitProjectionDelta: (state, delta) => this.emitProjectionDelta(state, delta),
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
    });
    this.providerStreamRuntime = new ProviderStreamRuntime<SessionDriverLoopRunState>({
      reasoningFlushChars: PROVIDER_REASONING_FLUSH_CHARS,
      reasoningFlushMs: PROVIDER_REASONING_FLUSH_MS,
      streamCoordinator: providerStreamCoordinator,
      visibleLanguageForRequest,
      providerActivity: (input) => driverActivityBuilder.providerActivity(input),
      conversationActivity: (input) => driverActivityBuilder.conversationActivity(input),
      emitProjectionDelta: (state, delta) => this.emitProjectionDelta(state, delta),
      kernelCommand: (request) => this.ports.kernelCommand(request),
      createId: (prefix) => this.id(prefix),
    });
    this.providerTurnRunner = new ProviderTurnRunner<SessionDriverLoopRunState>({
      jsonModeCoordinator: providerJsonModeCoordinator,
      streamCoordinator: providerStreamCoordinator,
      streamRuntime: this.providerStreamRuntime,
      traceRecorder: providerTraceRecorder,
      visibleLanguageForRequest,
      providerActivity: (input) => driverActivityBuilder.providerActivity(input),
      emitProjectionDelta: (state, delta) => this.emitProjectionDelta(state, delta),
      cacheTelemetryEvent: (input) => sessionProgressProjectionBuilder.cacheTelemetryEvent(input),
      reasoningEvent: (sessionId, reasoning, ts, id) =>
        assistantProjectionBuilder.reasoningEvent(sessionId, reasoning, ts, id),
      createToolCallBuffer: () => new ProviderToolCallBuffer({
        parseArguments: (raw, toolName) => nativeToolCoordinator.parseArguments(raw, toolName),
        normalizeToolName: (name) => nativeToolCoordinator.normalizeToolName(name),
      }),
      collectToolCalls: (result, buffer) => nativeToolCoordinator.collectCalls(result, buffer),
      nativeToolError: (error) => error instanceof NativeToolCoordinatorError
        ? { code: error.code, message: error.message }
        : undefined,
      createError: (code, message) => new SessionDriverLoopError(code, message),
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
    });
  }

  async resolveDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    if (input.kind === 'requirement') return this.resolveRequirementDecision(input);
    if (input.kind === 'plan') return this.resolvePlanDecision(input);
    if (input.kind === 'permission') return this.resolvePermissionDecision(input);
    if (input.kind === 'review') return this.resolveReviewDecision(input);
    return this.append(input.sessionId, [
      assistantProjectionBuilder.finalDiagnosticEvent(
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
    const initialTaskRuntime = acceptedPlanTaskLedger().runtimeSnapshot({
      acceptedPlan: acceptedImplementationPlan,
      resourcePackets: restoredResourcePackets,
      lastSavepointId: acceptedPlanTaskLedger().lastSavepointId(input.existingEvents ?? []),
    });
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
      taskExecutionCursor: initialTaskRuntime.taskExecutionCursor,
      currentTaskContext: initialTaskRuntime.currentTaskContext,
      taskLedger: initialTaskRuntime.taskLedger,
      acceptedPlanPromptFrame: initialTaskRuntime.acceptedPlanPromptFrame,
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
      lastResult = (await this.resourceOrchestrator.resolveRecordAndAppend(
        state,
        state.manifest,
        'resource-context'
      )).result;
    }

    if (shouldRequestRequirementConfirmation(input, state)) {
      try {
        const event = await this.buildRequirementConfirmation(input, state);
        state.phase = 'waiting_requirement_confirmation';
        const payload = objectRecord(event.payload) ?? {};
        return this.append(sessionId, [
          event,
          sessionProgressProjectionBuilder.sessionRunStateEvent({
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
          assistantProjectionBuilder.finalDiagnosticEvent(
            sessionId,
            diag('requirementConfirmationFailed', `Requirement confirmation generation failed: ${message}`, { message }),
            this.ts(),
            this.id('requirement-confirmation-failed')
          ),
        ]);
      }
    }

    while (true) {
      acceptedPlanTaskLedger().refreshRuntimeState(state);
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
          ...acceptedPlanTaskLedger().memoryHints(state.currentTaskContext),
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
      lastResult = await this.appendConsumedUserGuidanceEvents(sessionId, lastResult, state.contextAssembly, state.runId, state.userRequest);
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
            assistantProjectionBuilder.finalDiagnosticEvent(
              sessionId,
              readableDriverFailureMessage(error.code, error.message),
              this.ts(),
              this.id(error.code)
            ),
          ]);
        }
        return this.append(sessionId, [
          assistantProjectionBuilder.finalDiagnosticEvent(
            sessionId,
            readableProviderFailureMessage(error),
            this.ts(),
            this.id('provider_call_failed')
          ),
        ]);
      }
      const narration = assistantProjectionBuilder.proposalNarrationEvent(sessionId, proposal, this.ts(), this.id('progress-model-narration'));
      if (narration) {
        lastResult = await this.append(sessionId, [narration]);
      }
      if (proposal.kind === 'answer') {
        const revised = await this.maybeReviseTerminalAnswerWithGuidance(input, state, proposal);
        if (revised) return revised;
        return this.append(sessionId, [assistantProjectionBuilder.answerEvent(sessionId, proposal, this.ts(), this.id('answer'))]);
      }
      if (proposal.kind === 'decisionRequest') {
        const requirement = userInputPipeline.requirementRecordFromProposal({
          proposal,
          sessionId: state.sessionId,
          runId: state.runId,
          userRequest: input.content,
          timestamp: this.ts(),
        });
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
        const confirmation = requirementProjectionBuilder.confirmationEvent({
          sessionId,
          runId: state.runId,
          requirement,
          proposal,
          originalUserRequest: input.content,
          attachments: input.attachments ?? [],
          interactionOverlayPayload: interactionOverlayCodec.toPayload(interactionOverlay),
          ts: this.ts(),
          id: this.id('decision-request'),
        });
        state.phase = 'waiting_requirement_confirmation';
        return this.append(sessionId, [
          confirmation,
          sessionProgressProjectionBuilder.sessionRunStateEvent({
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
          assistantProjectionBuilder.finalDiagnosticEvent(sessionId, summary, this.ts(), this.id('diagnostic')),
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
          sessionProgressProjectionBuilder.sessionRunStateEvent({
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
          lastResult = (await this.resourceOrchestrator.recordAndAppend(
            state,
            generated.packet,
            'generated-artifact-resource-context'
          )).result;
          if (!generated.remaining.items.length) continue;
        }
        let subset = resourceRequestResolver().resolve(state.manifest, generated.remaining, state.conversationRoots);
        if (!subset.manifest.entries.length) {
          if (!state.resourceRequestRepairAttempted) {
            state.resourceRequestRepairAttempted = true;
            try {
              const repaired = await this.repairResourceRequest(input, state, prompt, proposal, subset);
              if (repaired.kind === 'answer') {
                return this.append(sessionId, [assistantProjectionBuilder.answerEvent(sessionId, repaired, this.ts(), this.id('answer'))]);
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
                assistantProjectionBuilder.finalDiagnosticEvent(
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
            assistantProjectionBuilder.finalDiagnosticEvent(
              sessionId,
              resourceRequestLoop.resolutionDiagnostic(subset),
              this.ts(),
              this.id('resource-invalid')
            ),
          ]);
        }
        const resourceAppend = await this.resourceOrchestrator.resolveRecordAndAppend(
          state,
          subset.manifest,
          'resource-context'
        );
        const packet = resourceAppend.packet;
        lastResult = resourceAppend.result;
        if (state.acceptedImplementationPlan) {
          acceptedPlanTaskLedger().refreshRuntimeState(state);
          const resumeEvent = sessionProgressProjectionBuilder.acceptedPlanResourceResumeEvent(
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
    return this.requirementDecisionHandler.resolve({
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

  private async resolvePlanDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    return this.planDecisionHandler.resolve({
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

  private async executeAcceptedActionBundlePlan(
    input: SessionDecisionResolverInput,
    plan: SessionPlanContext,
    initialResult: AgentSessionResult,
    acceptedOverlay?: RecoveredAcceptedPlanContext
  ): Promise<AgentSessionResult> {
    let result = initialResult;
    try {
      result = await this.append(input.sessionId, [
        sessionProgressProjectionBuilder.sessionRunStateEvent({
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
        sessionProgressProjectionBuilder.acceptedPlanActionBatchPreflightEvent(
          input.sessionId,
          plan,
          batch,
          this.ts(),
          this.id('accepted-action-plan-preflight')
        ),
      ]) ?? result;
      const deletePreflightReasons = acceptedPlanBatchPreflight.deleteReasons(batch, resourceRequestLoop.recentPackets(result.events));
      if (deletePreflightReasons.length) {
        return this.append(input.sessionId, sessionFailureProjectionBuilder.planActionBundlePreflightFailureEvents(
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
          stringValue(objectRecord(batchReply.error)?.code) ?? 'accepted_plan_action_batch_submit_failed',
          kernelReplyErrorMessage(batchReply, 'Kernel actionBatchSubmit failed without execution facts')
        );
      }
      if (kernelEventStatusIndex.hasFailureOrBlocker(batchEvents)) {
        return this.append(input.sessionId, sessionFailureProjectionBuilder.planActionBundleExecutionFailureEvents(
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
            sessionProgressProjectionBuilder.sessionRunStateEvent({
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
        const progressProposal = planContextIndex.proposalEnvelope(plan);
        const progress = acceptedPlanTaskLedger().batchProgress({ acceptedPlan: acceptedOverlay.acceptedPlan, proposal: progressProposal, kernelEvents: batchEvents });
        const nextAccepted = acceptedPlanTaskLedger().afterBatch(acceptedOverlay.acceptedPlan, progress.completedTaskIds);
        const runtime = acceptedPlanTaskLedger().runtimeSnapshot({
          acceptedPlan: acceptedOverlay.acceptedPlan,
          resourcePackets: resourceRequestLoop.recentPackets(result.events),
        });
        const savepointId = this.id('accepted-plan-overlay-task-savepoint');
        result = await this.append(input.sessionId, [
          sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent(
            input.sessionId,
            plan.runId,
            acceptedOverlay.acceptedPlan,
            progressProposal,
            batchEvents,
            progress,
            this.ts(),
            this.id('accepted-plan-overlay-batch-checkpoint')
          ),
          sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent(
            input.sessionId,
            plan.runId,
            acceptedOverlay.acceptedPlan,
            nextAccepted,
            progress,
            batchEvents,
            runtime.taskExecutionCursor,
            runtime.currentTaskContext,
            this.ts(),
            savepointId
          ),
        ]) ?? result;
        if (!acceptedPlanTaskLedger().complete(nextAccepted)) {
          return this.runUserTurn({
            sessionId: input.sessionId,
            content: executionPromptCoordinator().executionRequest(acceptedOverlay.plan, nextAccepted),
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

      return this.acceptedPlanReviewHandoffCoordinator.handoff({
        sessionId: input.sessionId,
        runId: plan.runId,
        planId: plan.planId,
        plan,
        result,
        currentKernelEvents: [...batchEvents, ...staticReviewEvents.map((event) => event.payload)],
        requestIdPrefix: 'review-facts-get',
        interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
        assertFactsReplyOk: {
          code: 'accepted_plan_review_facts_failed',
          fallback: 'Kernel reviewFactsGet failed',
        },
      });
    } catch (error) {
      const message = error instanceof SessionDriverLoopError ? error.message : String(error);
      const code = error instanceof SessionDriverLoopError ? error.code : 'accepted_plan_execution_failed';
      return this.append(input.sessionId, sessionFailureProjectionBuilder.planActionBundleExecutionExceptionEvents(
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
    return this.permissionDecisionHandler.resolve({
      sessionId: input.sessionId,
      decision: input.decision,
      runId: input.runId,
      targetId: input.targetId,
      existingEvents: input.existingEvents,
    });
  }

  private async resolveReviewDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    return this.reviewDecisionHandler.resolve({
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
    const requirement = userInputPipeline.requirementRecordFromProposal({
      proposal,
      sessionId: state.sessionId,
      runId: state.runId,
      userRequest: input.content,
      timestamp: this.ts(),
    });
    return requirementProjectionBuilder.confirmationEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      requirement,
      proposal,
      originalUserRequest: input.content,
      attachments: input.attachments ?? [],
      executionRootPayload: AcceptedPlanExecutionRootResolver.toPayload(
        AcceptedPlanExecutionRootResolver.fromState(state)
      ),
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
    const guidance = userGuidanceQueue.collectQueued(result.events, state.runId);
    if (guidance.length === 0) return null;

    result = await this.append(state.sessionId, [
      assistantProjectionBuilder.guidanceRevisionTransitionEvent(
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
      userOverlay: assistantProjectionBuilder.guidanceRevisionOverlay(input.content, draftAnswer, guidance),
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
      state.userRequest,
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
        assistantProjectionBuilder.guidanceRevisionDiagnosticEvent(
          state.sessionId,
          `用户引导合并失败，已回退到初版回复：${message}`,
          this.ts(),
          this.id('guidance-revision-failed')
        ),
      ]);
      return this.append(state.sessionId, [
        assistantProjectionBuilder.answerEvent(state.sessionId, draftAnswer, this.ts(), this.id('answer'), {
          guidanceRevisionFailed: true,
          appliedGuidanceIds: guidance.map((item) => item.id),
          replacesDraftProposalId: draftAnswer.proposalId,
        }),
      ]);
    }

    const narration = assistantProjectionBuilder.answerNarrationEvent(state.sessionId, revised, this.ts(), this.id('guidance-revision-narration'));
    if (narration) {
      result = await this.append(state.sessionId, [narration]);
    }
    return this.append(state.sessionId, [
      assistantProjectionBuilder.answerEvent(state.sessionId, revised, this.ts(), this.id('answer'), {
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
            assistantProjectionBuilder.thinkingEvent(
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
          assistantProjectionBuilder.thinkingEvent(
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
        assistantProjectionBuilder.thinkingEvent(
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
    acceptedPlanTaskLedger().refreshRuntimeState(state);
    const completion = acceptedPlanExecutor.readOnlyResourceCompletion(
      accepted,
      state.taskExecutionCursor,
      state.currentTaskContext,
      packet
    );
    if (!completion.ok) return null;

    const nextAccepted = acceptedPlanTaskLedger().afterBatch(accepted, completion.completedTaskIds);
    const checkpoint = sessionProgressProjectionBuilder.acceptedPlanResourceValidationCheckpointEvent(
      state.sessionId,
      state.runId,
      accepted,
      packet,
      completion,
      this.ts(),
      this.id('accepted-plan-resource-validation-checkpoint')
    );
    let result = await this.append(state.sessionId, [checkpoint]) ?? fallback;

    if (!acceptedPlanTaskLedger().complete(nextAccepted)) {
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: executionPromptCoordinator().executionRequest(
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

    const plan = acceptedPlanExecutor.readOnlyReviewContext({
      sessionId: state.sessionId,
      runId: state.runId,
      acceptedPlan: nextAccepted,
      packet,
      completion,
    });
    const resourceFact = {
      kind: 'tool.completed',
      toolName: 'kernel.resourceResolve',
      status: 'ok',
      summary: `Kernel resolved ${packet.items.length} resource item(s) for accepted-plan read-only validation.`,
      output: packet,
    };

    return this.acceptedPlanReviewHandoffCoordinator.handoff({
      sessionId: state.sessionId,
      runId: state.runId,
      planId: accepted.planId,
      plan,
      result,
      currentKernelEvents: [resourceFact],
      requestIdPrefix: 'accepted-plan-review-facts-get',
    });
  }

  private async tryCompleteAcceptedPlanReadOnlyActionBundle(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | null> {
    const accepted = state.acceptedImplementationPlan;
    const actionBundle = driverActivityBuilder.readActionBundle(proposal);
    if (!accepted || !actionBundle) return null;
    acceptedPlanTaskLedger().refreshRuntimeState(state);
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

    const packet = await this.resourceOrchestrator.resolveAndRecord(state, subset.manifest);
    let result = await this.append(state.sessionId, [
      this.resourceOrchestrator.packetEvent(state, packet, 'accepted-plan-readonly-action-resource-context'),
      sessionProgressProjectionBuilder.acceptedPlanResourceResumeEvent(
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
    return this.acceptedPlanResourceResumeCoordinator.run({
      state,
      prompt,
      userRequest: input.content,
      requestProposal,
      packet,
      callProposalOnly: ({ state: runState, prompt: runPrompt, contract, stage, messages }) =>
        this.callProviderProposalOnly(input, runState, runPrompt, contract, stage, messages),
      runRepair: (stage, messages) =>
        this.llm(
          input.profileId,
          state,
          stage,
          messages
        ),
    });
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
    return nativeToolProviderLoop.run({
      profileId: input.profileId,
      state,
      prompt,
      contract,
      providerTools: nativeToolCoordinator.providerTools(state),
      runTurn: (profileId, runState, retryStage, retryMessages, options) =>
        this.llmTurn(profileId, runState, retryStage, retryMessages, options),
      isEmptyResponseError,
      consumeGuidanceMessages: (runState, stage) =>
        this.consumeQueuedGuidanceForProviderResume(runState, stage),
      handlerPorts: this.nativeToolHandlerPortsFactory.create({
        prompt,
        repairSideEffect: (runState, repairPrompt, toolCall, turn) =>
          this.repairSideEffectNativeTool(input, runState, repairPrompt, toolCall, turn),
        tryParseTurnProposal: (runState, turn) =>
          this.tryParseNativeToolTurnProposal(runState, turn),
        repairDuplicate: (runState, repairPrompt, turn, duplicates) =>
          this.repairDuplicateNativeReadTool(input, runState, repairPrompt, turn, duplicates),
        resolveReadToolCall: (runState, toolCall) =>
          this.resolveNativeReadToolCall(runState, toolCall),
      }),
    });
  }

  private async callProviderProposalOnly(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    contract: ProviderTurnContract,
    stage: string,
    messages?: LlmChatRequest['messages']
  ): Promise<string | ProposalEnvelope> {
    const result = await proposalOnlyProviderRunner.run({
      profileId: input.profileId,
      state,
      contract,
      stage,
      messages,
      runTurn: (profileId, runState, retryStage, retryMessages, options) =>
        this.llmTurn(profileId, runState, retryStage, retryMessages, options),
      isEmptyResponseError,
      acceptedPlanId: state.acceptedImplementationPlan?.planId,
      emitProjectionDelta: (runState, delta) => this.emitProjectionDelta(runState, delta),
      buildRepairMessages: (toolCall, turn) =>
        providerRepairMessageBuilder.completeStageToolViolationRepairMessages(prompt, providerRepairMessageState(state), toolCall, turn),
      runRepair: (repairStage, repairMessages) =>
        this.llm(input.profileId, state, repairStage, repairMessages),
      repairErrorMessage: (error) => normalizeParseError(error).message,
    });
    if (result.kind === 'content') return result.content;
    if (result.kind === 'proposal') return result.proposal;
    if (result.kind === 'repairFailed') {
      throw new SessionDriverLoopError(
        'accepted_plan_provider_tool_violation',
        `Complete-stage provider requested native tool ${result.toolCall.name}; proposal-only repair failed: ${result.message}`
      );
    }
    const exhaustive: never = result;
    return exhaustive;
  }

  private async resolveNativeReadToolCall(
    state: SessionDriverLoopRunState,
    toolCall: NativeToolCallProposal
  ): Promise<ResourcePacket> {
    const manifest = nativeToolCoordinator.readManifest(state, toolCall);
    return this.resourceOrchestrator.resolve(state, manifest);
  }

  private async repairSideEffectNativeTool(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    toolCall: NativeToolCallProposal,
    turn: LlmTurnResult
  ): Promise<ProposalEnvelope> {
    const acceptedExecution = Boolean(state.acceptedImplementationPlan) || state.implementationBatch.batchIndex > 1;
    const result = await nativeToolRepairRunner.repairSideEffect({
      state,
      toolCall,
      turn,
      acceptedExecution,
      emitProjectionDelta: (runState, delta) => this.emitProjectionDelta(runState, delta),
      buildRepairMessages: (repairToolCall, repairTurn, repairAcceptedExecution) =>
        providerRepairMessageBuilder.sideEffectNativeToolRepairMessages(
          prompt,
          providerRepairMessageState(state),
          repairToolCall,
          repairTurn,
          repairAcceptedExecution
        ),
      runRepair: (stage, messages) => this.llm(input.profileId, state, stage, messages),
      repairErrorMessage: (error) => normalizeParseError(error).message,
    });
    if (result.kind === 'proposal') return result.proposal;
    if (result.kind === 'failed') {
      throw new SessionDriverLoopError(result.code, result.message);
    }
    const exhaustive: never = result;
    return exhaustive;
  }

  private tryParseNativeToolTurnProposal(
    state: SessionDriverLoopRunState,
    turn: LlmTurnResult
  ): ProposalEnvelope | null {
    return nativeToolRepairRunner.parseTurnProposal(state, turn);
  }

  private async repairDuplicateNativeReadTool(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    turn: LlmTurnResult,
    duplicates: Array<{ toolCall: NativeToolCallProposal; signature: NativeToolReadSignature; entry: NativeToolReadLedgerEntry }>
  ): Promise<ProposalEnvelope> {
    const result = await nativeToolRepairRunner.repairDuplicate({
      state,
      turn,
      duplicates,
      duplicateRepairAttempted: state.nativeToolDuplicateRepairAttempted,
      markDuplicateRepairAttempted: () => {
        state.nativeToolDuplicateRepairAttempted = true;
      },
      emitProjectionDelta: (runState, delta) => this.emitProjectionDelta(runState, delta),
      buildRepairMessages: (repairTurn, repairDuplicates, acceptedExecution) =>
        providerRepairMessageBuilder.nativeToolDuplicateRepairMessages(
          prompt,
          providerRepairMessageState(state),
          repairTurn,
          repairDuplicates,
          acceptedExecution
        ),
      runRepair: (stage, messages) => this.llm(input.profileId, state, stage, messages),
      repairErrorMessage: (error) => normalizeParseError(error).message,
      acceptedExecution: Boolean(state.acceptedImplementationPlan) || state.implementationBatch.batchIndex > 1,
    });
    if (result.kind === 'proposal') return result.proposal;
    if (result.kind === 'failed') {
      throw new SessionDriverLoopError(result.code, result.message);
    }
    const exhaustive: never = result;
    return exhaustive;
  }

  private async consumeQueuedGuidanceForProviderResume(
    state: SessionDriverLoopRunState,
    stage: string
  ): Promise<LlmChatRequest['messages']> {
    const current = await this.append(state.sessionId, []);
    const language = visibleLanguageForRequest(state.userRequest);
    const resume = userGuidanceQueue.providerResume({
      sessionId: state.sessionId,
      events: current.events,
      runId: state.runId,
      stage,
      summary: providerStreamCoordinator.userGuidanceConsumedSummary(language),
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
    });
    if (resume.events.length) await this.append(state.sessionId, resume.events);
    return resume.messages;
  }

  private async repairResourceRequest(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    resolution: ResourceRequestResolution
  ): Promise<ProposalEnvelope> {
    return this.resourceRequestRepairCoordinator.repair({
      state,
      prompt,
      proposal,
      resolutionDiagnostic: resourceRequestLoop.resolutionDiagnostic(resolution).fallback,
      runRepair: (stage, messages) => this.llm(input.profileId, state, stage, messages),
    });
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
      return this.append(state.sessionId, sessionFailureProjectionBuilder.actionBundleAdmissionFailureEvents(
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
      sessionProgressProjectionBuilder.actionBundleAdmissionRepairingEvent(
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
      repaired = await this.actionBundleAdmissionRepairCoordinator.repair({
        state, prompt, proposal, reasons,
        runRepair: (stage, messages) => this.llm(input.profileId, state, stage, messages),
      });
    } catch (error) {
      const message = error instanceof SessionDriverLoopError ? error.message : normalizeParseError(error).message;
      return this.append(state.sessionId, sessionFailureProjectionBuilder.actionBundleAdmissionFailureEvents(
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
      const followup = await this.actionBundleAdmissionResourceFollowupCoordinator.handle({
        state,
        proposal,
        request: repaired.payload as ResourceRequestDraft,
        reasons,
        result,
      });
      if (followup.kind === 'failed') return followup.result;
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: followup.content,
        attachments: input.attachments ?? [],
        existingEvents: followup.result.events,
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
      const requirement = userInputPipeline.requirementRecordFromProposal({
        proposal: repaired,
        sessionId: state.sessionId,
        runId: state.runId,
        userRequest: input.content,
        timestamp: this.ts(),
      });
      const confirmation = requirementProjectionBuilder.confirmationEvent({
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
        sessionProgressProjectionBuilder.sessionRunStateEvent({
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
        assistantProjectionBuilder.finalDiagnosticEvent(
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
      return this.append(state.sessionId, [assistantProjectionBuilder.answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]) ?? result;
    }
    if (repaired.kind === 'diagnostic') {
      const diagnostic = objectRecord(repaired.payload) ?? {};
      const summary = stringValue(diagnostic.summary)
        ?? stringValue(diagnostic.details)
        ?? 'actionBundle admission repair returned a diagnostic instead of a file-level plan.';
      return this.append(state.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(state.sessionId, summary, this.ts(), this.id('action-bundle-admission-diagnostic')),
      ]) ?? result;
    }
    return this.submitNonExecutableProposal(state, repaired, result);
  }

  private async submitActionProposal(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const actionBundle = driverActivityBuilder.readActionBundle(proposal);
    if (actionBundle && state.acceptedImplementationPlan) {
      return this.submitAcceptedPlanActionProposal(input, state, prompt, proposal, fallback);
    }
    if (actionBundle) {
      const admissionBatch = driverActivityBuilder.proposalActionBundleAdmissionBatch(proposal);
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
        assistantProjectionBuilder.finalDiagnosticEvent(
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
        assistantProjectionBuilder.thinkingEvent(
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
          assistantProjectionBuilder.finalDiagnosticEvent(
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
        return this.append(state.sessionId, [assistantProjectionBuilder.answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]);
      }
      return this.submitNonExecutableProposal(state, repaired, fallback);
    }
    let result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply);
    if (planReviewReportAnalyzer.denied(reviewReport)) {
      return this.append(state.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(
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
      sessionProgressProjectionBuilder.sessionRunStateEvent({
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
    const actionBundle = driverActivityBuilder.readActionBundle(proposal);
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
    });
    if (assessment.kind === 'missingActionBundle') return fallback;
    if (assessment.kind === 'deterministicScopeIntervention') {
      return this.appendAcceptedPlanBatchOutOfScope(input, state, proposal, assessment.validation);
    }
    if (assessment.kind === 'scopeRepair') {
      state.acceptedPlanScopeRepairAttempted = true;
      await this.append(state.sessionId, [
        assistantProjectionBuilder.thinkingEvent(
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
        const repaired = await this.acceptedPlanScopeRepairCoordinator.repair({
          state,
          prompt,
          proposal,
          validation: assessment.validation,
          runRepair: (stage, messages) => this.llm(input.profileId, state, stage, messages),
        });
        if (repaired.kind === 'actionBundle') {
          return this.submitAcceptedPlanActionProposal(input, state, prompt, repaired, fallback);
        }
        if (repaired.kind === 'resourceRequest') {
          const followup = await this.acceptedPlanScopeResourceFollowupCoordinator.handle({
            state,
            acceptedPlan: accepted,
            proposal,
            request: repaired.payload as ResourceRequestDraft,
            result: fallback,
          });
          if (followup.kind === 'failed') return followup.result;
          return this.runUserTurn({
            sessionId: input.sessionId,
            content: followup.content,
            attachments: accepted.executionRoot ? [accepted.executionRoot.attachment] : [],
            existingEvents: followup.result.events,
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
          return this.acceptedPlanScopeDecisionCoordinator.waitForDecision({
            state,
            proposal: repaired,
            request: {
              content: input.content,
              attachments: input.attachments,
            },
          });
        }
        if (repaired.kind === 'taskPlan' || repaired.kind === 'implementationPlan') {
          return this.append(state.sessionId, [
            assistantProjectionBuilder.finalDiagnosticEvent(
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
        sessionProgressProjectionBuilder.acceptedPlanAccessScopesCanonicalizedEvent(
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
      sessionProgressProjectionBuilder.sessionRunStateEvent({
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
        assistantProjectionBuilder.finalDiagnosticEvent(
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
        assistantProjectionBuilder.thinkingEvent(
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
          assistantProjectionBuilder.finalDiagnosticEvent(
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
        return this.append(state.sessionId, [assistantProjectionBuilder.answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]);
      }
      return this.submitNonExecutableProposal(state, repaired, fallback);
    }

    result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply) ?? result;
    if (planReviewReportAnalyzer.denied(reviewReport)) {
      return this.append(state.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(
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

    const plan = acceptedPlanExecutor.executionContext({
      sessionId: state.sessionId,
      runId: state.runId,
      acceptedPlan: accepted,
      proposal: executionProposal,
      planReviewReport: reviewReport,
    });
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

    const normalizedBatch = acceptedPlanExecutor.normalizeKernelBatch({
      planId: accepted.planId,
      plan,
      acceptedPlan: accepted,
    });
    if (!normalizedBatch.ok) {
      return this.append(state.sessionId, sessionFailureProjectionBuilder.acceptedPlanNormalizationFailureEvents(
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
      return this.append(state.sessionId, sessionFailureProjectionBuilder.acceptedPlanNormalizationFailureEvents(
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
      summary: driverActivityBuilder.acceptedPlanBatchActivitySummary(batch),
      activity: driverActivityBuilder.acceptedPlanBatchActivity({ accepted, batch, status: 'running' }),
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
    if (!batchReply.ok) {
      const message = kernelReplyErrorMessage(batchReply, 'Kernel actionBatchSubmit failed');
      const code = stringValue(objectRecord(batchReply.error)?.code) ?? 'accepted_plan_execution_failed';
      return this.append(state.sessionId, sessionFailureProjectionBuilder.planActionBundleExecutionExceptionEvents(
        state.sessionId,
        { runId: state.runId, planId: accepted.planId },
        message,
        code,
        this.ts(),
        this.id('accepted-plan-action-batch-submit-failed')
      )) ?? result;
    }
    const batchEvents = batchReply.events ?? [];
    if (kernelEventStatusIndex.hasFailureOrBlocker(batchEvents)) {
      return this.append(state.sessionId, sessionFailureProjectionBuilder.acceptedPlanExecutionFailureEvents(
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
      result = (await this.resourceOrchestrator.recordAndAppend(
        state,
        generatedPacket,
        'accepted-plan-generated-artifact-evidence'
      )).result ?? result;
    }
    if (!kernelEventStatusIndex.actionBatchReadyForReview(batchReply.events ?? [])) {
      if (kernelEventStatusIndex.hasPermissionRequest(batchReply.events ?? [])) {
        const permissionId = kernelEventStatusIndex.permissionId(batchReply.events ?? []);
        return this.append(state.sessionId, [
          sessionProgressProjectionBuilder.sessionRunStateEvent({
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
    const batchProgress = acceptedPlanTaskLedger().batchProgress({ acceptedPlan: accepted, proposal: executionProposal, kernelEvents: batchReply.events ?? [] });
    const nextAccepted = acceptedPlanTaskLedger().afterBatch(accepted, batchProgress.completedTaskIds);
    acceptedPlanTaskLedger().refreshRuntimeState(state);
    const savepointId = this.id('accepted-plan-task-savepoint');
    result = await this.append(state.sessionId, [
      sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent(
        state.sessionId,
        state.runId,
        accepted,
        executionProposal,
        batchReply.events ?? [],
        batchProgress,
        this.ts(),
        this.id('accepted-plan-batch-checkpoint')
      ),
      sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent(
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

    if (!kernelEventStatusIndex.hasFailureOrBlocker(batchReply.events ?? []) && !acceptedPlanTaskLedger().complete(nextAccepted)) {
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: executionPromptCoordinator().executionRequest(
          {
            ...acceptedPlanExecutor.executionContext({
              sessionId: state.sessionId,
              runId: state.runId,
              acceptedPlan: accepted,
              proposal: executionProposal,
              planReviewReport: reviewReport,
            }),
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

    return this.acceptedPlanReviewHandoffCoordinator.handoff({
      sessionId: state.sessionId,
      runId: state.runId,
      planId: accepted.planId,
      plan,
      result,
      currentKernelEvents: [...(batchReply.events ?? []), ...staticReviewEvents.map((event) => event.payload)],
      requestIdPrefix: 'accepted-plan-review-facts-get',
    });
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
    return this.acceptedPlanScopeDecisionCoordinator.waitForDecision({
      state,
      proposal: decisionProposal,
      request: {
        content: input.content,
        attachments: input.attachments ?? [],
      },
      confirmationIdPrefix: 'accepted-plan-scope-confirmation',
      runStateIdPrefix: 'session-run-waiting-accepted-plan-scope',
    });
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
    return this.providerTurnRunner.run({
      profileId,
      state,
      stage,
      messages,
      options,
      ports: this.ports,
    });
  }

  private async emitProjectionDelta(
    state: SessionDriverLoopRunState,
    delta: Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>
  ): Promise<void> {
    return this.agentRunReactor.emitProjectionDelta(state, delta);
  }

  private async emitKernelActivityDeltas(
    state: SessionDriverLoopRunState,
    kernelEvents: unknown[],
    stage: string
  ): Promise<void> {
    return this.agentRunReactor.emitKernelActivityDeltas(state, kernelEvents, stage);
  }

  private async kernel(request: KernelCommandEnvelope): Promise<KernelReply> {
    return this.agentRunReactor.kernel(request);
  }

  private async tryKernelAudit(
    sessionId: string,
    request: KernelCommandEnvelope,
    traceKind: AgentEvent['kind'],
    summary: string
  ): Promise<AgentSessionResult> {
    return this.agentRunReactor.tryKernelAudit(sessionId, request, traceKind, summary);
  }

  private async append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult> {
    return this.agentRunReactor.append(sessionId, events);
  }

  private async appendConsumedUserGuidanceEvents(
    sessionId: string,
    result: AgentSessionResult,
    contextAssembly: ContextAssemblyRecord | undefined,
    runId: string,
    userRequest: string,
    appliedAtProviderStage = 'provider_call'
  ): Promise<AgentSessionResult> {
    const consumedIds = contextAssembly?.consumedUserGuidanceIds ?? [];
    const events = userGuidanceQueue.consumedEvents({
      sessionId,
      events: result.events,
      consumedIds,
      runId,
      appliedAtProviderStage,
      summary: providerStreamCoordinator.userGuidanceConsumedSummary(visibleLanguageForRequest(userRequest)),
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
    });

    return events.length > 0 ? this.append(sessionId, events) : result;
  }

  private async appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult> {
    return this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply);
  }

  private event(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent {
    return this.agentRunReactor.event(sessionId, kind, payload);
  }

  private id(prefix: string): string {
    return this.agentRunReactor.id(prefix);
  }

  private ts(): string {
    return this.agentRunReactor.ts();
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
    comparablePath: (value) => pathIdentity.comparablePath(value),
    isAbsolutePath: (value) => pathIdentity.isAbsolutePath(value),
    sanitizeId,
    objectRecord,
  });
}

function resourceRequestResolver(): ResourceRequestResolver {
  return new ResourceRequestResolver();
}

function resourceEvidenceIndex(): ResourceEvidenceIndex {
  return new ResourceEvidenceIndex({
    normalizeTarget: (value) => pathIdentity.normalizePlanScope(value),
    clip,
  });
}

function generatedArtifactEvidenceIndex(): GeneratedArtifactEvidenceIndex {
  return new GeneratedArtifactEvidenceIndex({
    normalizeRelativePath: (value) => pathIdentity.normalizeRelativePath(value),
    comparablePath: (value) => pathIdentity.comparablePath(value),
    utf8Bytes,
    sanitizeId,
    joinFsPath,
    objectRecord,
    stringValue,
    uniqueStrings: (values) => driverActivityBuilder.uniqueStrings(values),
    batchActionRecords: (batch) => driverActivityBuilder.batchActionRecords(batch),
    actionEffectiveCapability: (action) => actionBundleActionInspector.actionEffectiveCapability(action),
    actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
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
    normalizePlanScope: (value) => pathIdentity.normalizePlanScope(value),
    uniqueStrings: (values) => driverActivityBuilder.uniqueStrings(values),
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
    fileOperationFreshnessReasons: (accepted, proposal, resourcePackets) =>
      acceptedPlanExecutor.fileOperationFreshnessValidationReasons(accepted, proposal, resourcePackets),
  });
}

function acceptedPlanTaskLedger(): AcceptedPlanTaskLedgerCoordinator {
  return new AcceptedPlanTaskLedgerCoordinator({
    workUnitIdsFromKernelEvents: (events) => kernelEventStatusIndex.workUnitIds(events),
    actionBatchHasFailureOrBlocker: (events) => kernelEventStatusIndex.hasFailureOrBlocker(events),
  });
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
    batchActionRecords: (batch) => driverActivityBuilder.batchActionRecords(batch),
    actionEffectiveCapability: (action) => actionBundleActionInspector.actionEffectiveCapability(action),
    actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
    normalizeAcceptedPlanTargetScope: (value, accepted) =>
      acceptedPlanScopeMatcher.normalizeTargetScope(value, accepted),
    comparablePath: (value) => pathIdentity.comparablePath(value),
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

function normalizedNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

function normalizedPositiveInteger(value: unknown): number | undefined {
  const integer = normalizedNonNegativeInteger(value);
  return typeof integer === 'number' && integer > 0 ? integer : undefined;
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

function protocolGate(): ProtocolGate {
  const validator = proposalSemanticValidator();
  return new ProtocolGate({
    canonicalizeWriteActionSourceBlockRefs: (proposal) => validator.canonicalizeWriteActionSourceBlockRefs(proposal),
    ensureReviewableExpectations: (proposal) => executionPromptCoordinator().ensureReviewableExpectations(proposal),
    validateProposalSemantics: (proposal, options) => validator.validateProposalSemantics(proposal, options),
  });
}

function proposalSemanticValidator(): ProposalSemanticValidator {
  return new ProposalSemanticValidator({
    maxActionBundleTotalCodeBytes: MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES,
    sideEffectCapabilities: SIDE_EFFECT_CAPABILITIES,
    readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
    actionEffectiveCapability: (action) => actionBundleActionInspector.actionEffectiveCapability(action),
    actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
    deleteActionTargetResourceKind: (action) => actionBundleActionInspector.deleteActionTargetResourceKind(action),
    deleteActionRecursive: (action) => actionBundleActionInspector.deleteActionRecursive(action),
  });
}

function executionPromptCoordinator(): ExecutionPromptCoordinator<SessionPlanContext> {
  const validator = proposalSemanticValidator();
  return new ExecutionPromptCoordinator<SessionPlanContext>({
    maxActionBundleTotalCodeBytes: MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES,
    sideEffectCapabilities: SIDE_EFFECT_CAPABILITIES,
    objectRecord,
    stringValue,
    planId: (plan) => plan.planId,
    actionEffectiveCapability: (action) => actionBundleActionInspector.actionEffectiveCapability(action),
    isDetailedUserPlanMarkdown: (userPlan) => validator.isDetailedUserPlanMarkdown(userPlan),
    defaultActionBundleUserPlanMarkdown: (input) => validator.defaultActionBundleUserPlanMarkdown(input),
    expectationsHaveDescription: (value) => validator.expectationsHaveDescription(value),
    defaultValidationExpectation: (actions) => validator.defaultValidationExpectation(actions),
    defaultReviewExpectation: (actions) => validator.defaultReviewExpectation(actions),
  });
}

function shouldAttemptActionBundleCompactionRepair(state: SessionDriverLoopRunState): boolean {
  if (!state.acceptedImplementationPlan && !state.currentTaskContext) return false;
  const allowed = state.stateContract?.allowedProposals ?? state.driverRequest?.stateContract?.allowedProposals ?? [];
  if (allowed.length && !allowed.includes('actionBundle')) return false;
  const capabilities = state.stateContract?.capabilityProjection ?? state.driverRequest?.stateContract?.capabilityProjection ?? [];
  return capabilities.some((capability) => SIDE_EFFECT_CAPABILITIES.has(capability));
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

function recoverAcceptedPlanFromOverlay(
  input: SessionDecisionResolverInput,
  events: AgentEvent[],
  overlay: InteractionOverlayContext | undefined
): RecoveredAcceptedPlanContext | undefined {
  const planId = overlay?.acceptedPlanId;
  if (!planId) return undefined;
  const plan = (overlay.acceptedPlanRunId ? planContextIndex.findPlanCard(events, overlay.acceptedPlanRunId, planId) : null)
    ?? planContextIndex.findPlanCard(events, undefined, planId);
  if (!plan?.implementationPlan) return undefined;
  const executionRoot = plan.executionRoot ?? AcceptedPlanExecutionRootResolver.fromDecision(input, events);
  let acceptedPlan = acceptedPlanTaskLedger().withLatestCheckpoint(
    acceptedImplementationPlanContextBuilder().build({ plan, interventionLevel: input.interventionLevel, executionRoot }),
    events
  );
  const overlayCompletedTaskIds = overlay.acceptedCompletedTaskIds ?? [];
  if (overlayCompletedTaskIds.length) {
    acceptedPlan = acceptedPlanTaskLedger().afterBatch(acceptedPlan, [
      ...new Set([...acceptedPlan.completedTaskIds, ...overlayCompletedTaskIds]),
    ]);
  }
  return { plan, acceptedPlan };
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

function normalizeParseError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentPlanParseError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'parse_failed', message: error.message };
  return { code: 'parse_failed', message: String(error) };
}

function planInitialUserRequest(plan: SessionPlanContext): string {
  return plan.userPlan;
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
