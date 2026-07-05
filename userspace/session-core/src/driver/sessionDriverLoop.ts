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
  AcceptedActionBundlePlanExecutor,
  AcceptedPlanActionProposalSubmitter,
  AcceptedPlanBatchPreflight,
  AcceptedPlanExecutor,
  AcceptedPlanExecutionRootResolver,
  AcceptedPlanOperationTargetResolver,
  AcceptedPlanScopeCoverage,
  AcceptedPlanScopeDecisionCoordinator,
  AcceptedPlanScopeDecisionOverlay,
  AcceptedPlanScopeRepairCoordinator,
  AcceptedPlanScopeResourceFollowupCoordinator,
  AcceptedPlanReadOnlyTaskExecutor,
  ActionBundleAdmissionRepairCoordinator,
  ActionBatchFailureIndex,
  CompletedWorkUnitFactIndex,
  AcceptedPlanScopeIntervention,
  AcceptedPlanScopeMatcher,
  AcceptedPlanTargetParser,
  AcceptedPlanTaskLedgerCoordinator,
  ActionBundleAdmissionCoordinator,
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
  NativeToolProviderCoordinator,
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
  ProviderProposalCoordinator,
  ProviderStreamCoordinator,
  ProviderStreamRuntime,
  ProviderTurnRunner,
  ProviderTraceRecorder,
  ProviderToolCallBuffer,
  type ProviderPartFrameParser,
  type NativeToolReadLedgerEntry,
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
  ResourceRequestProposalHandler,
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
  AcceptedPlanStaticSyntaxReviewCoordinator,
  ReviewAssembler,
  ReviewDecisionProjectionBuilder,
  type SessionReviewContext,
} from './review/index.js';
import { DecisionResolver, PermissionDecisionHandler, PlanDecisionHandler, ProviderDecisionRequestHandler, RequirementConfirmationCoordinator, RequirementDecisionHandler, ReviewDecisionHandler, TerminalGuidanceRevisionCoordinator } from './interactions/index.js';
import {
  ActionProposalSubmitter,
  ActionBundleActionInspector,
  PlanContextIndex,
  PlanInteractionIndex,
  PlanReviewGrantProjector,
  PlanReviewReportAnalyzer,
  ProviderPlanProposalHandler,
  ProviderTerminalProposalHandler,
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
  private readonly acceptedActionBundlePlanExecutor: AcceptedActionBundlePlanExecutor;
  private readonly acceptedPlanActionProposalSubmitter: AcceptedPlanActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly acceptedPlanReadOnlyTaskExecutor: AcceptedPlanReadOnlyTaskExecutor<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly acceptedPlanResourceResumeCoordinator: AcceptedPlanResourceResumeCoordinator<SessionDriverLoopRunState>;
  private readonly acceptedPlanScopeDecisionCoordinator: AcceptedPlanScopeDecisionCoordinator<SessionDriverLoopRunState>;
  private readonly acceptedPlanScopeRepairCoordinator: AcceptedPlanScopeRepairCoordinator<SessionDriverLoopRunState>;
  private readonly acceptedPlanScopeResourceFollowupCoordinator: AcceptedPlanScopeResourceFollowupCoordinator<SessionDriverLoopRunState, AcceptedImplementationPlanContext>;
  private readonly acceptedPlanReviewHandoffCoordinator: AcceptedPlanReviewHandoffCoordinator<SessionPlanContext>;
  private readonly acceptedPlanStaticSyntaxReviewCoordinator: AcceptedPlanStaticSyntaxReviewCoordinator<SessionDriverLoopRunState>;
  private readonly actionBundleAdmissionCoordinator: ActionBundleAdmissionCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly actionBundleAdmissionRepairCoordinator: ActionBundleAdmissionRepairCoordinator<SessionDriverLoopRunState>;
  private readonly actionBundleAdmissionResourceFollowupCoordinator: ActionBundleAdmissionResourceFollowupCoordinator<SessionDriverLoopRunState>;
  private readonly decisionResolver: DecisionResolver;
  private readonly permissionDecisionHandler: PermissionDecisionHandler<SessionPlanContext>;
  private readonly planDecisionHandler: PlanDecisionHandler;
  private readonly providerDecisionRequestHandler: ProviderDecisionRequestHandler<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly providerPlanProposalHandler: ProviderPlanProposalHandler<SessionDriverLoopRunState>;
  private readonly providerTerminalProposalHandler: ProviderTerminalProposalHandler<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly requirementConfirmationCoordinator: RequirementConfirmationCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly requirementDecisionHandler: RequirementDecisionHandler;
  private readonly reviewDecisionHandler: ReviewDecisionHandler;
  private readonly terminalGuidanceRevisionCoordinator: TerminalGuidanceRevisionCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly actionProposalSubmitter: ActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly resourceOrchestrator: ResourceOrchestrator<SessionDriverLoopRunState>;
  private readonly resourceRequestProposalHandler: ResourceRequestProposalHandler<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly resourceRequestRepairCoordinator: ResourceRequestRepairCoordinator<SessionDriverLoopRunState>;
  private readonly nativeToolHandlerPortsFactory: NativeToolHandlerPortsFactory<SessionDriverLoopRunState, PromptEnvelope, LlmTurnResult>;
  private readonly nativeToolProviderCoordinator: NativeToolProviderCoordinator<SessionDriverLoopRunState, LlmTurnResult>;
  private readonly providerStreamRuntime: ProviderStreamRuntime<SessionDriverLoopRunState>;
  private readonly providerProposalCoordinator: ProviderProposalCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>;
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
    this.acceptedActionBundlePlanExecutor = new AcceptedActionBundlePlanExecutor({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      kernel: (request) => this.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.appendProjectedKernelEvents(sessionId, reply),
      resumeUserTurn: (resumeInput) => this.runUserTurn(resumeInput),
      kernelExecutionContractId: (report) => planReviewGrantProjector.kernelExecutionContractId(report),
      temporaryGrantsForPlan: (plan) => planReviewGrantProjector.temporaryGrantsForPlan(plan),
      recentResourcePackets: (events) => resourceRequestLoop.recentPackets(events),
      sessionRunStateEvent: (input) => sessionProgressProjectionBuilder.sessionRunStateEvent(input as Parameters<typeof sessionProgressProjectionBuilder.sessionRunStateEvent>[0]),
      acceptedPlanActionBatchPreflightEvent: (sessionId, plan, batch, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanActionBatchPreflightEvent(sessionId, plan, batch, ts, id),
      planActionBundlePreflightFailureEvents: (sessionId, plan, reasons, ts, id) =>
        sessionFailureProjectionBuilder.planActionBundlePreflightFailureEvents(sessionId, plan, reasons, ts, id),
      planActionBundleExecutionFailureEvents: (sessionId, plan, batchEvents, batch, ts, id) =>
        sessionFailureProjectionBuilder.planActionBundleExecutionFailureEvents(sessionId, plan, batchEvents, batch, ts, id),
      planActionBundleExecutionExceptionEvents: (sessionId, plan, message, code, ts, id) =>
        sessionFailureProjectionBuilder.planActionBundleExecutionExceptionEvents(sessionId, plan, message, code, ts, id),
      acceptedPlanBatchCheckpointEvent: (sessionId, runId, accepted, proposal, kernelEvents, progress, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent(sessionId, runId, accepted, proposal as ProposalEnvelope, kernelEvents, progress as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent>[5], ts, id),
      acceptedPlanTaskSavepointEvent: (sessionId, runId, accepted, nextAccepted, progress, kernelEvents, cursor, context, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent(
          sessionId,
          runId,
          accepted,
          nextAccepted,
          progress as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent>[4],
          kernelEvents,
          cursor as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent>[6],
          context as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent>[7],
          ts,
          id
        ),
      deletePreflightReasons: (batch, resourcePackets) => acceptedPlanBatchPreflight.deleteReasons(batch, resourcePackets),
      hasFailureOrBlocker: (events) => kernelEventStatusIndex.hasFailureOrBlocker(events),
      actionBatchReadyForReview: (events) => kernelEventStatusIndex.actionBatchReadyForReview(events),
      hasPermissionRequest: (events) => kernelEventStatusIndex.hasPermissionRequest(events),
      permissionId: (events) => kernelEventStatusIndex.permissionId(events),
      planProposal: (plan) => planContextIndex.proposalEnvelope(plan),
      batchProgress: (input) => acceptedPlanTaskLedger().batchProgress(input as Parameters<ReturnType<typeof acceptedPlanTaskLedger>['batchProgress']>[0]),
      acceptedPlanAfterBatch: (accepted, completedTaskIds) => acceptedPlanTaskLedger().afterBatch(accepted, completedTaskIds),
      runtimeSnapshot: (input) => acceptedPlanTaskLedger().runtimeSnapshot(input),
      acceptedPlanComplete: (accepted) => acceptedPlanTaskLedger().complete(accepted),
      executionRequest: (plan, acceptedPlan) => executionPromptCoordinator().executionRequest(plan, acceptedPlan),
      reviewHandoff: (handoffInput) => this.acceptedPlanReviewHandoffCoordinator.handoff(handoffInput),
    });
    this.acceptedPlanReadOnlyTaskExecutor = new AcceptedPlanReadOnlyTaskExecutor<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      runUserTurn: (resumeInput) => this.runUserTurn(resumeInput),
      readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
      refreshRuntimeState: (state) => acceptedPlanTaskLedger().refreshRuntimeState(state),
      readOnlyResourceCompletion: (accepted, cursor, current, packet) =>
        acceptedPlanExecutor.readOnlyResourceCompletion(
          accepted,
          cursor as TaskExecutionCursor | undefined,
          current as CurrentTaskContext | undefined,
          packet
        ),
      afterBatch: (accepted, completedTaskIds) => acceptedPlanTaskLedger().afterBatch(accepted, completedTaskIds),
      complete: (accepted) => acceptedPlanTaskLedger().complete(accepted),
      resourceValidationCheckpointEvent: (sessionId, runId, accepted, packet, completion, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanResourceValidationCheckpointEvent(
          sessionId,
          runId,
          accepted,
          packet,
          completion,
          ts,
          id
        ),
      executionRequest: (plan, acceptedPlan) =>
        executionPromptCoordinator().executionRequest(
          plan as unknown as Parameters<ReturnType<typeof executionPromptCoordinator>['executionRequest']>[0],
          acceptedPlan
        ),
      readOnlyReviewContext: (reviewInput) => acceptedPlanExecutor.readOnlyReviewContext(reviewInput),
      reviewHandoff: (handoffInput) => this.acceptedPlanReviewHandoffCoordinator.handoff(handoffInput),
      currentTaskIsReadOnlyResourceValidation: (accepted, cursor, current) =>
        acceptedPlanExecutor.currentTaskIsReadOnlyResourceValidation(
          accepted,
          cursor as TaskExecutionCursor | undefined,
          current as CurrentTaskContext | undefined
        ),
      resourceRequestFromReadOnlyActionBundle: (actionBundle, current, requestId) =>
        acceptedPlanExecutor.resourceRequestFromReadOnlyActionBundle(
          actionBundle as Parameters<typeof acceptedPlanExecutor.resourceRequestFromReadOnlyActionBundle>[0],
          current as CurrentTaskContext | undefined,
          requestId
        ),
      resolveResourceRequest: (manifest, request, roots) =>
        resourceRequestResolver().resolve(manifest, request, roots),
      resolveAndRecord: (state, manifest) => this.resourceOrchestrator.resolveAndRecord(state, manifest),
      packetEvent: (state, packet, stage) => this.resourceOrchestrator.packetEvent(state, packet, stage),
      resourceResumeEvent: (sessionId, runId, accepted, cursor, current, packet, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanResourceResumeEvent(
          sessionId,
          runId,
          accepted,
          cursor as TaskExecutionCursor | undefined,
          current as CurrentTaskContext | undefined,
          packet,
          ts,
          id
        ),
      resourceResume: (resumeInput) => this.acceptedPlanResourceResumeCoordinator.run(resumeInput),
      callProviderProposalOnly: (handlerInput, state, prompt, contract, stage, messages) =>
        this.callProviderProposalOnly(handlerInput, state, prompt, contract, stage, messages),
      runRepair: (handlerInput, state, stage, messages) =>
        this.llm(handlerInput.profileId, state, stage, messages),
      submitActionProposal: (handlerInput, state, prompt, proposal, fallback) =>
        this.submitActionProposal(handlerInput, state, prompt, proposal, fallback),
      submitNonExecutableProposal: (state, proposal, fallback) =>
        this.submitNonExecutableProposal(state, proposal, fallback),
    });
    this.acceptedPlanActionProposalSubmitter = new AcceptedPlanActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      kernel: (request) => this.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.appendProjectedKernelEvents(sessionId, reply),
      emitProjectionDelta: (state, delta) => this.emitProjectionDelta(state, delta),
      emitKernelActivityDeltas: (state, events, stage) => this.emitKernelActivityDeltas(state, events, stage),
      readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
      tryCompleteReadOnlyActionBundle: (handlerInput, state, prompt, proposal, fallback) =>
        this.acceptedPlanReadOnlyTaskExecutor.tryCompleteActionBundle(handlerInput, state, prompt, proposal, fallback),
      assessActionProposal: (assessmentInput) => acceptedPlanExecutor.assessActionProposal(assessmentInput as unknown as Parameters<typeof acceptedPlanExecutor.assessActionProposal>[0]),
      admission: () => acceptedPlanAdmission(),
      appendScopeIntervention: (handlerInput, state, proposal, validation) =>
        this.appendAcceptedPlanBatchOutOfScope(handlerInput, state, proposal, validation as AcceptedPlanBatchValidationResult),
      appendThinking: async (state, message, idPrefix, metadata) => {
        await this.append(state.sessionId, [
          assistantProjectionBuilder.thinkingEvent(
            state.sessionId,
            message,
            this.ts(),
            this.id(idPrefix),
            metadata as Parameters<typeof assistantProjectionBuilder.thinkingEvent>[4]
          ),
        ]);
      },
      repairScope: ({ state, prompt, proposal, validation, input: handlerInput }) =>
        this.acceptedPlanScopeRepairCoordinator.repair({
          state,
          prompt,
          proposal,
          validation: validation as AcceptedPlanBatchValidationResult,
          runRepair: (stage, messages) => this.llm(handlerInput.profileId, state, stage, messages),
        }),
      handleScopeResourceFollowup: ({ state, acceptedPlan, proposal, request, result }) =>
        this.acceptedPlanScopeResourceFollowupCoordinator.handle({
          state,
          acceptedPlan,
          proposal,
          request,
          result,
        }),
      waitForScopeDecision: ({ state, proposal, request }) =>
        this.acceptedPlanScopeDecisionCoordinator.waitForDecision({
          state,
          proposal,
          request,
        }),
      appendDiagnostic: (state, code, fallback, params, idPrefix) => this.append(state.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(
          state.sessionId,
          diag(code, fallback, params),
          this.ts(),
          this.id(idPrefix)
        ),
      ]),
      submitNonExecutableProposal: (state, proposal, fallback) => this.submitNonExecutableProposal(state, proposal, fallback),
      sessionRunStateEvent: (eventInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(eventInput as Parameters<typeof sessionProgressProjectionBuilder.sessionRunStateEvent>[0]),
      accessScopesCanonicalizedEvent: (sessionId, runId, accepted, canonicalization, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanAccessScopesCanonicalizedEvent(
          sessionId,
          runId,
          accepted,
          canonicalization as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanAccessScopesCanonicalizedEvent>[3],
          ts,
          id
        ),
      findReviewReport: (events) => planReviewReportAnalyzer.findReport(events),
      appendTrace: (state, stage, payload) => providerTraceRecorder.append(state, stage, payload, this.ports),
      acceptedPlanNeedsRepair: (report) => planReviewReportAnalyzer.acceptedPlanNeedsRepair(report),
      repairPlanReview: (handlerInput, state, prompt, proposal, report) =>
        this.actionProposalSubmitter.repairPlanReview(handlerInput, state, prompt, proposal, report),
      answerEvent: (sessionId, proposal, ts, id) => assistantProjectionBuilder.answerEvent(sessionId, proposal, ts, id),
      denied: (report) => planReviewReportAnalyzer.denied(report),
      diagnosticSummary: (report) => planReviewReportAnalyzer.diagnosticSummary(report),
      nonAcceptedPermissionGaps: (report, accepted) => nonAcceptedPlanPermissionGaps(report, accepted),
      executionContext: (contextInput) => acceptedPlanExecutor.executionContext(contextInput as Parameters<typeof acceptedPlanExecutor.executionContext>[0]),
      temporaryGrantsForPlan: (plan) => planReviewGrantProjector.temporaryGrantsForPlan(plan),
      normalizeKernelBatch: (normalizeInput) => acceptedPlanExecutor.normalizeKernelBatch(normalizeInput as Parameters<typeof acceptedPlanExecutor.normalizeKernelBatch>[0]),
      normalizationFailureEvents: (sessionId, runId, accepted, reasons, ts, id) =>
        sessionFailureProjectionBuilder.acceptedPlanNormalizationFailureEvents(sessionId, runId, accepted, reasons, ts, id),
      executionExceptionEvents: (sessionId, planRef, message, code, ts, id) =>
        sessionFailureProjectionBuilder.planActionBundleExecutionExceptionEvents(sessionId, planRef, message, code, ts, id),
      executionFailureEvents: (sessionId, runId, accepted, batchEvents, batch, ts, id) =>
        sessionFailureProjectionBuilder.acceptedPlanExecutionFailureEvents(sessionId, runId, accepted, batchEvents, batch, ts, id),
      deletePreflightReasons: (batch, resourcePackets) => acceptedPlanBatchPreflight.deleteReasons(batch, resourcePackets as ResourcePacket[]),
      preflightAudit: (batch) => acceptedPlanBatchPreflight.audit(batch),
      acceptedPlanBatchActivitySummary: (batch) => driverActivityBuilder.acceptedPlanBatchActivitySummary(batch),
      acceptedPlanBatchActivity: (activityInput) => driverActivityBuilder.acceptedPlanBatchActivity(activityInput as Parameters<typeof driverActivityBuilder.acceptedPlanBatchActivity>[0]),
      generatedPacketFromSuccessfulBatch: (state, batch, events, id) =>
        generatedArtifactEvidenceIndex().packetFromSuccessfulBatch(state, batch, events, id),
      indexGeneratedPacket: (index, packet) =>
        generatedArtifactEvidenceIndex().indexPacket(index as Parameters<ReturnType<typeof generatedArtifactEvidenceIndex>['indexPacket']>[0], packet as Parameters<ReturnType<typeof generatedArtifactEvidenceIndex>['indexPacket']>[1]),
      recordGeneratedPacket: (state, packet, stage) =>
        this.resourceOrchestrator.recordAndAppend(state, packet as ResourcePacket, stage),
      hasFailureOrBlocker: (events) => kernelEventStatusIndex.hasFailureOrBlocker(events),
      actionBatchReadyForReview: (events) => kernelEventStatusIndex.actionBatchReadyForReview(events),
      hasPermissionRequest: (events) => kernelEventStatusIndex.hasPermissionRequest(events),
      permissionId: (events) => kernelEventStatusIndex.permissionId(events),
      batchProgress: (progressInput) => acceptedPlanTaskLedger().batchProgress(progressInput),
      afterBatch: (accepted, completedTaskIds) => acceptedPlanTaskLedger().afterBatch(accepted, completedTaskIds),
      refreshRuntimeState: (state) => acceptedPlanTaskLedger().refreshRuntimeState(state),
      complete: (accepted) => acceptedPlanTaskLedger().complete(accepted),
      batchCheckpointEvent: (sessionId, runId, accepted, proposal, kernelEvents, progress, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent(
          sessionId,
          runId,
          accepted,
          proposal,
          kernelEvents,
          progress as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent>[5],
          ts,
          id
        ),
      taskSavepointEvent: (sessionId, runId, accepted, nextAccepted, progress, kernelEvents, cursor, context, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent(
          sessionId,
          runId,
          accepted,
          nextAccepted,
          progress as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent>[4],
          kernelEvents,
          cursor as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent>[6],
          context as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent>[7],
          ts,
          id
        ),
      executionRequest: (plan, acceptedPlan) => executionPromptCoordinator().executionRequest(plan, acceptedPlan),
      runUserTurn: (resumeInput) => this.runUserTurn(resumeInput),
      staticSyntaxReview: (reviewInput) => this.acceptedPlanStaticSyntaxReviewCoordinator.run(reviewInput),
      reviewHandoff: (handoffInput) => this.acceptedPlanReviewHandoffCoordinator.handoff(handoffInput),
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
    this.acceptedPlanStaticSyntaxReviewCoordinator = new AcceptedPlanStaticSyntaxReviewCoordinator<SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      emitProjectionDelta: (state, delta) => this.emitProjectionDelta(state, delta),
      runStaticSyntaxReview: ({ profileId, state, stage, messages }) =>
        this.llm(profileId, state, stage, messages),
      event: (sessionId, kind, payload) => this.event(sessionId, kind, payload),
      reviewAssembler: reviewAssembler(),
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
        this.acceptedActionBundlePlanExecutor.execute(handlerInput, plan, initialResult, acceptedOverlay),
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
    this.decisionResolver = new DecisionResolver({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      finalDiagnosticEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(sessionId, content, ts, id),
      missingDecisionKindMessage: (kind) =>
        diag('decisionResolverMissing', `Decision kind "${kind}" is not yet connected to Session DecisionResolver.`, { kind }),
      requirementHandler: this.requirementDecisionHandler,
      planHandler: this.planDecisionHandler,
      permissionHandler: this.permissionDecisionHandler,
      reviewHandler: this.reviewDecisionHandler,
    });
    this.providerDecisionRequestHandler = new ProviderDecisionRequestHandler<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      requirementRecordFromProposal: (proposalInput) =>
        userInputPipeline.requirementRecordFromProposal(proposalInput),
      confirmationEvent: (confirmationInput) =>
        requirementProjectionBuilder.confirmationEvent(confirmationInput),
      interactionOverlayPayload: (overlay) => interactionOverlayCodec.toPayload(overlay),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
    });
    this.providerPlanProposalHandler = new ProviderPlanProposalHandler<SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      implementationPlanCardEvent: (planInput) =>
        planProjectionBuilder.implementationPlanCardEvent(planInput),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
    });
    this.providerTerminalProposalHandler = new ProviderTerminalProposalHandler<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      reviseAnswer: (handlerInput, state, proposal) =>
        this.maybeReviseTerminalAnswerWithGuidance(handlerInput, state, proposal),
      answerEvent: (answerSessionId, proposal, ts, id) =>
        assistantProjectionBuilder.answerEvent(answerSessionId, proposal, ts, id),
      finalDiagnosticEvent: (diagnosticSessionId, summary, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(diagnosticSessionId, summary, ts, id),
    });
    this.requirementConfirmationCoordinator = new RequirementConfirmationCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      assembleContext: (contextInput) => assembleContext(contextInput),
      capabilityCatalogSummary: (state) => nativeToolCoordinator.capabilityCatalogSummary(state),
      collectUserGuidanceEvents: (events, runId) => collectUserGuidanceEvents(events, runId),
      buildProviderTurnContract: (contractInput) =>
        contextFrameBuilder.buildSessionProviderTurnContract(contractInput),
      callProviderAndParse: (handlerInput, state, prompt) =>
        this.callProviderAndParse(handlerInput, state, prompt),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      requirementRecordFromProposal: (proposalInput) =>
        userInputPipeline.requirementRecordFromProposal(proposalInput),
      confirmationEvent: (confirmationInput) =>
        requirementProjectionBuilder.confirmationEvent(confirmationInput),
      executionRootPayload: (state) =>
        AcceptedPlanExecutionRootResolver.toPayload(
          AcceptedPlanExecutionRootResolver.fromState(state)
        ),
    });
    this.terminalGuidanceRevisionCoordinator = new TerminalGuidanceRevisionCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      collectQueued: (events, runId) => userGuidanceQueue.collectQueued(events, runId),
      transitionEvent: (transitionInput) =>
        assistantProjectionBuilder.guidanceRevisionTransitionEvent(
          transitionInput.sessionId,
          transitionInput.runId,
          transitionInput.guidanceIds,
          transitionInput.userRequest,
          transitionInput.ts,
          transitionInput.id
        ),
      overlay: (overlayInput) =>
        assistantProjectionBuilder.guidanceRevisionOverlay(
          overlayInput.originalRequest,
          overlayInput.draftAnswer,
          overlayInput.guidance
        ),
      answerNarrationEvent: (sessionId, proposal, ts, id) =>
        assistantProjectionBuilder.answerNarrationEvent(sessionId, proposal, ts, id),
      answerEvent: (sessionId, proposal, ts, id, metadata) =>
        assistantProjectionBuilder.answerEvent(sessionId, proposal, ts, id, metadata),
      diagnosticEvent: (sessionId, message, ts, id) =>
        assistantProjectionBuilder.guidanceRevisionDiagnosticEvent(sessionId, message, ts, id),
      assembleContext: (contextInput) => assembleContext(contextInput),
      capabilityCatalogSummary: (state) => nativeToolCoordinator.capabilityCatalogSummary(state),
      implementationBatchHints: (state) => implementationBatchHints(state.implementationBatch),
      appendConsumedGuidanceEvents: (guidanceInput) =>
        this.appendConsumedUserGuidanceEvents(
          guidanceInput.sessionId,
          guidanceInput.result,
          guidanceInput.contextAssembly,
          guidanceInput.runId,
          guidanceInput.userRequest,
          guidanceInput.appliedAtProviderStage
        ),
      runRevision: (revisionInput, state, messages) =>
        this.llm(revisionInput.profileId, state, 'guidance_revision', messages),
      parseProposal: (raw, state) =>
        protocolGate().parseAndValidateProposal({
          raw,
          runId: state.runId,
          sessionId: state.sessionId,
          source: 'llm',
        }),
      createError: (code, message) => new SessionDriverLoopError(code, message),
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
    this.resourceRequestProposalHandler = new ResourceRequestProposalHandler<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      generatedPacketForRequest: (state, request, packetId) =>
        generatedArtifactEvidenceIndex().packetForRequest(state, request, packetId),
      recordAndAppend: (state, packet, eventIdPrefix) =>
        this.resourceOrchestrator.recordAndAppend(state, packet, eventIdPrefix),
      resolveRecordAndAppend: (state, manifest, eventIdPrefix) =>
        this.resourceOrchestrator.resolveRecordAndAppend(state, manifest, eventIdPrefix),
      resolveResourceRequest: (manifest, request, roots) =>
        resourceRequestResolver().resolve(manifest, request, roots),
      repairResourceRequest: (input, state, prompt, proposal, resolution) =>
        this.repairResourceRequest(input, state, prompt, proposal, resolution),
      answerEvent: (sessionId, proposal, ts, id) =>
        assistantProjectionBuilder.answerEvent(sessionId, proposal, ts, id),
      finalDiagnosticEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(sessionId, content, ts, id),
      resourceResolutionDiagnostic: (resolution) => resourceRequestLoop.resolutionDiagnostic(resolution),
      resourceRepairFailedDiagnostic: (message) =>
        diag('resourceResolveRepairFailed', `The requested resources could not be located in attachments or project directory, and repair failed: ${message}`, { message }),
      refreshTaskRuntimeState: (state) => acceptedPlanTaskLedger().refreshRuntimeState(state),
      acceptedPlanResourceResumeEvent: (state, packet, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanResourceResumeEvent(
          state.sessionId,
          state.runId,
          state.acceptedImplementationPlan!,
          state.taskExecutionCursor,
          state.currentTaskContext,
          packet,
          ts,
          id
        ),
      tryCompleteResourceTask: (input, state, packet, fallback) =>
        this.acceptedPlanReadOnlyTaskExecutor.tryCompleteResourceTask(input, state, packet, fallback),
      callResourceResume: (input, state, prompt, proposal, packet) =>
        this.acceptedPlanReadOnlyTaskExecutor.callResourceResume(input, state, prompt, proposal, packet),
      submitActionProposal: (input, state, prompt, proposal, fallback) =>
        this.submitActionProposal(input, state, prompt, proposal, fallback),
      submitNonExecutableProposal: (state, proposal, fallback) =>
        this.submitNonExecutableProposal(state, proposal, fallback),
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
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
    this.actionBundleAdmissionCoordinator = new ActionBundleAdmissionCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      admissionFailureEvents: (admissionInput) =>
        sessionFailureProjectionBuilder.actionBundleAdmissionFailureEvents(
          admissionInput.sessionId,
          admissionInput.runId,
          admissionInput.proposal,
          admissionInput.reasons,
          admissionInput.ts,
          admissionInput.id
        ),
      admissionRepairingEvent: (admissionInput) =>
        sessionProgressProjectionBuilder.actionBundleAdmissionRepairingEvent(
          admissionInput.sessionId,
          admissionInput.runId,
          admissionInput.proposal,
          admissionInput.reasons,
          admissionInput.ts,
          admissionInput.id
        ),
      repair: (repairInput) =>
        this.actionBundleAdmissionRepairCoordinator.repair({
          ...repairInput,
          runRepair: (stage, messages) => this.llm(repairInput.input.profileId, repairInput.state, stage, messages),
        }),
      repairErrorMessage: (error) =>
        error instanceof SessionDriverLoopError ? error.message : normalizeParseError(error).message,
      resourceFollowup: (followupInput) =>
        this.actionBundleAdmissionResourceFollowupCoordinator.handle(followupInput),
      resumeAfterResourceFollowup: ({ originalInput, followup }) =>
        this.runUserTurn({
          sessionId: originalInput.sessionId,
          content: followup.content,
          attachments: originalInput.attachments ?? [],
          existingEvents: followup.result.events,
          workspaceBinding: originalInput.workspaceBinding,
          projectWorkingDirectory: originalInput.projectWorkingDirectory,
          profileId: originalInput.profileId,
          workflow: originalInput.workflow,
          appendUserMessage: false,
          requirementConfirmationMode: 'off',
          reviewContinuationMode: originalInput.reviewContinuationMode,
          interventionLevel: originalInput.interventionLevel,
          projectMemoryMode: originalInput.projectMemoryMode,
          resumeResourcePackets: true,
        }),
      submitActionProposal: (handlerInput, state, prompt, proposal, fallback) =>
        this.submitActionProposal(handlerInput, state, prompt, proposal, fallback),
      submitNonExecutableProposal: (state, proposal, fallback) =>
        this.submitNonExecutableProposal(state, proposal, fallback),
      requirementRecordFromProposal: (recordInput) =>
        userInputPipeline.requirementRecordFromProposal(recordInput),
      confirmationEvent: (confirmationInput) =>
        requirementProjectionBuilder.confirmationEvent(confirmationInput),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
      finalDiagnosticEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(sessionId, content, ts, id),
      answerEvent: (sessionId, proposal, ts, id) =>
        assistantProjectionBuilder.answerEvent(sessionId, proposal, ts, id),
      diagnosticSummary: (proposal) => {
        const diagnostic = objectRecord(proposal.payload) ?? {};
        return stringValue(diagnostic.summary)
          ?? stringValue(diagnostic.details)
          ?? 'actionBundle admission repair returned a diagnostic instead of a file-level plan.';
      },
      diagnostic: (code, fallback, params) => diag(code, fallback, params),
    });
    this.actionProposalSubmitter = new ActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.ts(),
      createId: (prefix) => this.id(prefix),
      append: (sessionId, events) => this.append(sessionId, events),
      appendProjectedKernelEvents: (sessionId, reply) => this.appendProjectedKernelEvents(sessionId, reply),
      readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
      actionBundleAdmissionBatch: (proposal) => driverActivityBuilder.proposalActionBundleAdmissionBatch(proposal),
      deleteAdmissionReasons: (batch, resourcePackets) =>
        acceptedPlanBatchPreflight.deleteReasons(batch, resourcePackets),
      repairActionBundleAdmission: (handlerInput, state, prompt, proposal, reasons, fallback) =>
        this.repairActionBundleAdmission(handlerInput, state, prompt, proposal, reasons, fallback),
      submitAcceptedPlanActionProposal: (handlerInput, state, prompt, proposal, fallback) =>
        this.submitAcceptedPlanActionProposal(handlerInput, state, prompt, proposal, fallback),
      submitProposal: (state, proposal, requestId) => this.kernel({
        command: {
          kind: 'proposalSubmit',
          requestId,
          runId: state.runId,
          sessionId: state.sessionId,
          proposal,
        },
      }),
      findReviewReport: (events) => planReviewReportAnalyzer.findReport(events),
      appendTrace: (state, stage, payload) =>
        providerTraceRecorder.append(state, stage, payload, this.ports),
      needsRepair: (report) => planReviewReportAnalyzer.needsRepair(report),
      denied: (report) => planReviewReportAnalyzer.denied(report),
      diagnosticSummary: (report) => planReviewReportAnalyzer.diagnosticSummary(report),
      buildRepairMessages: (prompt, state, proposal, report) =>
        providerRepairMessageBuilder.planReviewRepairMessages(
          prompt,
          providerRepairMessageState(state),
          proposal,
          report
        ),
      runRepair: (handlerInput, state, stage, messages) =>
        this.llm(handlerInput.profileId, state, stage, messages),
      parseRepairedProposal: (raw, state, allowedKinds) => protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds,
      }),
      repairErrorMessage: (error) => normalizeParseError(error).message,
      thinkingEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.thinkingEvent(sessionId, content, ts, id),
      finalDiagnosticEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(sessionId, content, ts, id),
      answerEvent: (sessionId, proposal, ts, id) =>
        assistantProjectionBuilder.answerEvent(sessionId, proposal, ts, id),
      planCardEvent: (planCardInput) =>
        planProjectionBuilder.actionBundlePlanCardEvent(planCardInput),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
      diagnostic: (code, fallback, params) => diag(code, fallback, params),
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
    this.nativeToolProviderCoordinator = new NativeToolProviderCoordinator<SessionDriverLoopRunState, LlmTurnResult>({
      providerLoop: nativeToolProviderLoop,
      handlerPortsFactory: this.nativeToolHandlerPortsFactory,
      repairRunner: nativeToolRepairRunner,
      providerTools: (state) => nativeToolCoordinator.providerTools(state),
      readManifest: (state, toolCall) => nativeToolCoordinator.readManifest(state, toolCall),
      resolveResource: (state, manifest) => this.resourceOrchestrator.resolve(state, manifest),
      runTurn: (profileId, state, stage, messages, options) =>
        this.llmTurn(profileId, state, stage, messages, options),
      isEmptyResponseError,
      consumeGuidanceMessages: (state, stage) =>
        this.consumeQueuedGuidanceForProviderResume(state, stage),
      emitProjectionDelta: (state, delta) => this.emitProjectionDelta(state, delta),
      buildSideEffectRepairMessages: (prompt, state, toolCall, turn, acceptedExecution) =>
        providerRepairMessageBuilder.sideEffectNativeToolRepairMessages(
          prompt,
          providerRepairMessageState(state),
          toolCall,
          turn,
          acceptedExecution
        ),
      buildDuplicateRepairMessages: (prompt, state, turn, duplicates, acceptedExecution) =>
        providerRepairMessageBuilder.nativeToolDuplicateRepairMessages(
          prompt,
          providerRepairMessageState(state),
          turn,
          duplicates,
          acceptedExecution
        ),
      runRepair: (profileId, state, stage, messages) => this.llm(profileId, state, stage, messages),
      repairErrorMessage: (error) => normalizeParseError(error).message,
      createError: (code, message) => new SessionDriverLoopError(code, message),
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
    this.providerProposalCoordinator = new ProviderProposalCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>({
      append: (sessionId, events) => this.append(sessionId, events),
      createId: (prefix) => this.id(prefix),
      now: () => this.ts(),
      thinkingEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.thinkingEvent(sessionId, content, ts, id),
      providerResult: (providerInput, state, prompt, contract) =>
        state.acceptedImplementationPlan
          ? this.callProviderProposalOnly(providerInput, state, prompt, contract, 'accepted_plan_provider_call')
          : this.callProviderWithNativeTools(providerInput, state, prompt, contract),
      runRepair: (providerInput, state, stage, messages) =>
        this.llm(providerInput.profileId, state, stage, messages),
      repairMessageState: (state) => providerRepairMessageState(state),
      repairMessages: (prompt, repairState, raw, error) =>
        providerRepairMessageBuilder.repairMessages(prompt, repairState as ProviderRepairMessageState, raw, error),
      actionBundleCompactionRepairMessages: (prompt, repairState, reason, raw) =>
        providerRepairMessageBuilder.actionBundleCompactionRepairMessages(prompt, repairState as ProviderRepairMessageState, reason, raw),
      repairAllowedKinds: (repairInput) => protocolGate().repairAllowedKinds(repairInput),
      parseProposal: (parseInput) =>
        protocolGate().parseAndValidateProposal({
          raw: parseInput.raw,
          runId: parseInput.state.runId,
          sessionId: parseInput.state.sessionId,
          source: 'llm',
          allowBriefActionBundleUserPlan: parseInput.allowBriefActionBundleUserPlan,
        }),
      parseRepairedProposal: (parseInput) =>
        protocolGate().parseAndValidateRepairedProposal({
          raw: parseInput.raw,
          runId: parseInput.state.runId,
          sessionId: parseInput.state.sessionId,
          source: 'llm',
          allowedKinds: parseInput.allowedKinds,
          allowBriefActionBundleUserPlan: parseInput.allowBriefActionBundleUserPlan,
        }),
      shouldAttemptActionBundleCompactionRepair: (state) =>
        shouldAttemptActionBundleCompactionRepair(state),
      normalizeParseError: (error) => normalizeParseError(error),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      isDriverErrorCode: (error, code) =>
        error instanceof SessionDriverLoopError && error.code === code,
    });
  }

  async resolveDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    return this.decisionResolver.resolve(input);
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
        const event = await this.requirementConfirmationCoordinator.build(input, state);
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
        return this.providerTerminalProposalHandler.handleAnswer(input, state, proposal);
      }
      if (proposal.kind === 'decisionRequest') {
        return this.providerDecisionRequestHandler.handle(input, state, proposal);
      }
      if (proposal.kind === 'diagnostic') {
        return this.providerTerminalProposalHandler.handleDiagnostic(state, proposal);
      }
      if (proposal.kind === 'taskPlan' || proposal.kind === 'implementationPlan') {
        return this.providerPlanProposalHandler.handle(state, proposal);
      }
      if (proposal.kind === 'resourceRequest') {
        const handled = await this.resourceRequestProposalHandler.handle({
          input,
          state,
          prompt,
          proposal,
          lastResult,
        });
        if (handled.kind === 'return') return handled.result;
        lastResult = handled.lastResult;
        continue;
      }
      if (proposal.kind === 'actionBundle') {
        return this.submitActionProposal(input, state, prompt, proposal, lastResult);
      }
      return this.submitNonExecutableProposal(state, proposal, lastResult);
    }

    return lastResult;
  }

  private async maybeReviseTerminalAnswerWithGuidance(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    draftAnswer: ProposalEnvelope
  ): Promise<AgentSessionResult | null> {
    return this.terminalGuidanceRevisionCoordinator.revise(input, state, draftAnswer);
  }

  private async callProviderAndParse(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope
  ): Promise<ProposalEnvelope> {
    return this.providerProposalCoordinator.callAndParse(input, state, prompt);
  }

  private async callProviderWithNativeTools(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    contract: ProviderTurnContract
  ): Promise<string | ProposalEnvelope> {
    return this.nativeToolProviderCoordinator.run({
      profileId: input.profileId,
      state,
      prompt,
      contract,
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
    return this.actionBundleAdmissionCoordinator.repair(input, state, prompt, proposal, reasons, fallback);
  }

  private async submitActionProposal(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    return this.actionProposalSubmitter.submit(input, state, prompt, proposal, fallback);
  }

  private async submitAcceptedPlanActionProposal(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    return this.acceptedPlanActionProposalSubmitter.submit(input, state, prompt, proposal, fallback);
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

  private async submitNonExecutableProposal(
    state: SessionDriverLoopRunState,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    return this.actionProposalSubmitter.submitNonExecutable(state, proposal, fallback);
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
