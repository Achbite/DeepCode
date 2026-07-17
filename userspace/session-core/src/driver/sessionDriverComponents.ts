import type { PromptEnvelope } from '../prompt/types.js';
import {
  buildReviewFactsContext,
  planInteractionAwaitsDecision,
  type TaskLedgerSnapshot,
} from '../run-state/index.js';
import {
  AcceptedTaskPlanContextBuilder,
  AcceptedPlanBatchPreflight,
  AcceptedPlanExecutionRootResolver,
  AcceptedPlanExecutor,
  AcceptedPlanTargetParser,
  AcceptedPlanTaskLedgerCoordinator,
  ActionBatchFailureIndex,
  CompletedWorkUnitFactIndex,
  ExecutionPromptCoordinator,
  ImplementationBatchContextBuilder,
  KernelEventStatusIndex,
  RepairLoop,
  type AcceptedTaskPlanContext,
} from './execution/index.js';
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
  ContextFrameBuilder,
  GeneratedArtifactEvidenceIndex,
  PathIdentity,
  ProviderContextSupport,
  ResourceEvidenceIndex,
  ResourceManifestBuilder,
  ResourceRequestLoop,
  ResourceRequestResolver,
} from './context/index.js';
import {
  NativeToolCoordinator,
  NativeToolProgressEventBuilder,
  NativeToolExposurePolicy,
  NativeToolProviderLoop,
  NativeToolProjectionBuilder,
  NativeToolTurnHandler,
  ProviderJsonModeCoordinator,
  ProviderPipeline,
  ProviderStreamCoordinator,
  ProviderTraceRecorder,
  ProviderTurnPolicy,
} from './pipelines/providerPipeline.js';
import { PermissionPipeline } from './pipelines/permissionPipeline.js';
import { UserGuidanceQueue } from './pipelines/userGuidanceQueue.js';
import { UserInputPipeline } from './pipelines/userInputPipeline.js';
import { InteractionOverlayCodec } from './pipelines/interactionOverlayCodec.js';
import {
  AssistantProjectionBuilder,
  DriverActivityBuilder,
  KernelEventProjectionBuilder,
  PlanProjectionBuilder,
  RequirementProjectionBuilder,
  ReviewProjectionBuilder,
  SessionFailureProjectionBuilder,
  SessionProgressProjectionBuilder,
  VISIBLE_REASONING_MAX_CHARS,
} from './projection/index.js';
import { DriverInteractionIndex } from './interactions/index.js';
import { ReviewAssembler, ReviewDecisionProjectionBuilder } from './review/index.js';
import { DriverFailureMessageCatalog, DriverParseErrorCatalog } from './diagnostics/index.js';
import { builtinHooks, HookPolicy, HookRegistry, HookRuntime } from './hooks/index.js';
import type { LlmTurnResult, SessionDriverLoopRunState } from './runFrame.js';
import { clip, objectRecord, stringValue, visibleLanguageForRequest } from './runtimeSupport.js';

const MAX_DERIVED_MANIFEST_ENTRIES = 240;
const RESOURCE_MANIFEST_MAX_BYTES = 512 * 1024;

export const providerPipeline = new ProviderPipeline();
export const providerJsonModeCoordinator = new ProviderJsonModeCoordinator();
export const providerStreamCoordinator = new ProviderStreamCoordinator();
export const providerTraceRecorder = new ProviderTraceRecorder();
export const hookRegistry = new HookRegistry();
for (const hook of builtinHooks()) hookRegistry.register(hook);
export const hookRuntime = new HookRuntime(hookRegistry, HookPolicy.observerOnly());
export const actionBundleActionInspector = new ActionBundleActionInspector();
export const driverActivityBuilder = new DriverActivityBuilder({
  providerStageSummary: (stage, part, language) => providerStreamCoordinator.stageSummary(stage, part, language),
  visibleLanguageForRequest,
  actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
});
export const permissionPipeline = new PermissionPipeline();
export const userInputPipeline = new UserInputPipeline();
export const userGuidanceQueue = new UserGuidanceQueue();
export const interactionOverlayCodec = new InteractionOverlayCodec();
export const acceptedPlanTargetParser = new AcceptedPlanTargetParser();
export const planReviewGrantProjector = new PlanReviewGrantProjector();
export const planReviewReportAnalyzer = new PlanReviewReportAnalyzer({
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
});
export const planContextIndex = new PlanContextIndex({
  interactionOverlayFromPayload: (payload) => interactionOverlayCodec.fromPayload(payload),
  executionRootFromPayload: (payload) => AcceptedPlanExecutionRootResolver.fromPayload(payload),
});
export const planInteractionIndex = new PlanInteractionIndex<SessionPlanContext>({
  planCardAwaitingDecision: planInteractionAwaitsDecision,
  planReviewEventAwaitingDecision: planInteractionAwaitsDecision,
  planContextFromEvent: (event, payload) => planContextIndex.contextFromEvent(event, payload),
  findPlanCard: (events, runId, planId) => planContextIndex.findPlanCard(events, runId, planId),
  planAlreadyResolved: (events, plan) => planContextIndex.alreadyResolved(events, plan),
});
export const driverInteractionIndex = new DriverInteractionIndex({
  latestActiveReviewInteraction: (events) => reviewAssembler().findLatestActiveReviewInteraction(events),
  latestActivePlanInteraction: (events) => planInteractionIndex.findLatestActivePlanInteraction(events),
  latestActiveRequirementInteraction: (events) => userInputPipeline.findLatestActiveRequirementInteraction(events),
  findPlanCard: (events, runId, planId) => planContextIndex.findPlanCard(events, runId, planId),
  executionRootFromDecision: (input, events) => AcceptedPlanExecutionRootResolver.fromDecision(input, events),
  buildAcceptedPlan: (input) => acceptedTaskPlanContextBuilder().build(input),
  recoverLatestCheckpoint: (input) => acceptedPlanTaskLedger().recoverLatestCheckpoint(input),
  recordTaskCompletion: (input) => acceptedPlanTaskLedger().recordTaskCompletion(input),
});
export const kernelEventProjectionBuilder = new KernelEventProjectionBuilder({
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
  permissionBundlesFromReport: (report) => planReviewGrantProjector.permissionBundlesFromReport(report),
  gateInterventionsFromReport: (report) => planReviewGrantProjector.gateInterventionsFromReport(report),
  planReviewFacts: (report) => planReviewReportAnalyzer.facts(report),
});
export const planProjectionBuilder = new PlanProjectionBuilder({
  readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
  permissionBundlesFromReport: (report) => planReviewGrantProjector.permissionBundlesFromReport(report),
  gateInterventionsFromReport: (report) => planReviewGrantProjector.gateInterventionsFromReport(report),
  planReviewFacts: (report) => planReviewReportAnalyzer.facts(report),
  interactionOverlayProjection: (overlay) => interactionOverlayCodec.toPayload(overlay as Parameters<typeof interactionOverlayCodec.toPayload>[0]),
  visibleLanguageForRequest,
});
export const requirementProjectionBuilder = new RequirementProjectionBuilder({
  visibleLanguageForRequest,
  interactionOverlayPayload: (payload) => interactionOverlayCodec.toPayload(interactionOverlayCodec.fromPayload(payload)),
});
export const assistantProjectionBuilder = new AssistantProjectionBuilder({
  visibleLanguageForRequest,
  guidanceRevisionTransitionMessage: (language) => providerStreamCoordinator.guidanceRevisionTransitionMessage(language),
});
export const sessionProgressProjectionBuilder = new SessionProgressProjectionBuilder({
  interactionOverlayPayload: (overlay) => interactionOverlayCodec.toPayload(overlay),
  hasFailureOrBlocker: (kernelEvents) =>
    kernelEventStatusIndex.hasFailureOrBlocker(kernelEventStatusIndex.decodeEvents(kernelEvents)),
  auditAcceptedPlanBatch: (batch) => acceptedPlanBatchPreflight.audit(batch),
  actionBundleAdmissionBatch: (proposal) => driverActivityBuilder.proposalActionBundleAdmissionBatch(proposal),
  acceptedPlanTaskLedger: (accepted) => acceptedPlanTaskLedger().ledger(accepted),
  acceptedPlanPromptFrame: (accepted, taskLedger) => acceptedPlanTaskLedger().promptFrame(accepted, taskLedger),
});
export const sessionFailureProjectionBuilder = new SessionFailureProjectionBuilder({
  actionBatchFailureDetails: (kernelEvents, batch) => actionBatchFailureIndex.details(kernelEvents, batch),
  actionBatchFailureSummary: (failure) => actionBatchFailureIndex.summary(failure),
  sessionRunStateEvent: (input) => sessionProgressProjectionBuilder.sessionRunStateEvent(input),
});
export const reviewProjectionBuilder = new ReviewProjectionBuilder<SessionPlanContext, AcceptedTaskPlanContext, TaskLedgerSnapshot>({
  reviewFactLines: (kernelEvents) => reviewAssembler().reviewFactLines(kernelEvents),
  staticSyntaxReviewFactLines: (kernelEvents) => reviewAssembler().staticSyntaxReviewFactLines(kernelEvents),
  findReviewFacts: (kernelEvents) => reviewAssembler().findReviewFacts(kernelEvents),
  concreteContinuationExpectations: (value) => implementationBatchContextBuilder().concreteContinuationExpectations(value),
  acceptedPlanContext: (plan) => plan.taskPlan
    ? acceptedTaskPlanContextBuilder().build({ plan, interventionLevel: undefined, executionRoot: plan.executionRoot })
    : undefined,
  acceptedPlanBatchCompletedTaskIds: (acceptedPlan, plan, kernelEvents) =>
    acceptedPlanTaskLedger().recordKernelBatchProgress({ acceptedPlan, proposal: planContextIndex.proposalEnvelope(plan), kernelEvents }).completedTaskIds,
  acceptedPlanAfterBatch: (acceptedPlan, completedTaskIds) => acceptedPlanTaskLedger().recordTaskCompletion({ acceptedPlan, completedTaskIds }).nextAcceptedPlan,
  acceptedPlanTaskLedger: (acceptedPlan) => acceptedPlanTaskLedger().ledger(acceptedPlan),
  buildReviewFactsContext: (input) => buildReviewFactsContext(input),
});
export const actionBatchFailureIndex = new ActionBatchFailureIndex();
export const kernelEventStatusIndex = new KernelEventStatusIndex();
export const repairLoop = new RepairLoop();
export const pathIdentity = new PathIdentity();
export const providerContextSupport = new ProviderContextSupport({
  acceptedContext: (acceptedPlan) => executionPromptCoordinator().sanitizedContext(acceptedPlan),
});
export const acceptedPlanBatchPreflight = new AcceptedPlanBatchPreflight({
  batchActionRecords: (batch) => driverActivityBuilder.batchActionRecords(batch),
});
export const completedWorkUnitFactIndex = new CompletedWorkUnitFactIndex({
  kernelEventTargets: (record) => kernelEventProjectionBuilder.kernelEventTargets(record),
  normalizeRelativePath: (value) => pathIdentity.normalizeRelativePath(value),
  comparablePath: (value) => pathIdentity.comparablePath(value),
});
export const nativeToolCoordinator = new NativeToolCoordinator();
export const nativeToolExposurePolicy = new NativeToolExposurePolicy();
export const nativeToolTurnHandler = new NativeToolTurnHandler();
export const acceptedPlanExecutor = new AcceptedPlanExecutor({
  readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
  kernelExecutionContractId: (report) => planReviewGrantProjector.kernelExecutionContractId(report),
  kernelExecutionContractHash: (report) => planReviewGrantProjector.kernelExecutionContractHash(report),
});
export const contextFrameBuilder = new ContextFrameBuilder();
export const resourceRequestLoop = new ResourceRequestLoop({
  maxDerivedManifestEntries: MAX_DERIVED_MANIFEST_ENTRIES,
});
export const nativeToolProjectionBuilder = new NativeToolProjectionBuilder({
  conversationActivity: (input) => driverActivityBuilder.conversationActivity(input),
  packetActivity: (packet, activityId, runId) => resourceRequestLoop.packetActivity(packet, activityId, runId),
  runningSummary: (toolName, language) => providerStreamCoordinator.nativeToolResolveRunningSummary(toolName, language),
  completedSummary: (toolName, language) => providerStreamCoordinator.nativeToolResolveCompletedSummary(toolName, language),
});
export const nativeToolProgressEventBuilder = new NativeToolProgressEventBuilder();
export const nativeToolProviderLoop = new NativeToolProviderLoop<SessionDriverLoopRunState, PromptEnvelope, LlmTurnResult>({
  providerPipeline,
  turnHandler: nativeToolTurnHandler,
});
export const PROVIDER_REASONING_FLUSH_CHARS = 768;
export const PROVIDER_REASONING_FLUSH_MS = 120;
export { VISIBLE_REASONING_MAX_CHARS };
export const providerTurnPolicy = new ProviderTurnPolicy();
export const driverFailureMessageCatalog = new DriverFailureMessageCatalog();
export const driverParseErrorCatalog = new DriverParseErrorCatalog();

export function resourceManifestBuilder(): ResourceManifestBuilder {
  return new ResourceManifestBuilder({
    maxDerivedManifestEntries: MAX_DERIVED_MANIFEST_ENTRIES,
    resourceManifestMaxBytes: RESOURCE_MANIFEST_MAX_BYTES,
    comparablePath: (value) => pathIdentity.comparablePath(value),
    isAbsolutePath: (value) => pathIdentity.isAbsolutePath(value),
  });
}

export function resourceRequestResolver(): ResourceRequestResolver {
  return new ResourceRequestResolver();
}

export function resourceEvidenceIndex(): ResourceEvidenceIndex {
  return new ResourceEvidenceIndex({
    normalizeTarget: (value) => pathIdentity.normalizePlanScope(value),
    clip,
  });
}

export function generatedArtifactEvidenceIndex(): GeneratedArtifactEvidenceIndex {
  return new GeneratedArtifactEvidenceIndex({
    normalizeRelativePath: (value) => pathIdentity.normalizeRelativePath(value),
    comparablePath: (value) => pathIdentity.comparablePath(value),
  });
}

export function implementationBatchContextBuilder(): ImplementationBatchContextBuilder {
  return new ImplementationBatchContextBuilder({
    concreteFileOperationTarget: (value) => {
      const normalized = pathIdentity.normalizePlanScope(value);
      return normalized && normalized !== '.' ? normalized : undefined;
    },
  });
}

export function acceptedTaskPlanContextBuilder(): AcceptedTaskPlanContextBuilder {
  return new AcceptedTaskPlanContextBuilder({
    normalizePlanScope: (value) => pathIdentity.normalizePlanScope(value),
    uniqueStrings: (values) => driverActivityBuilder.uniqueStrings(values),
    acceptedPlanTaskTargets: (record) => acceptedPlanTargetParser.taskTargets(record),
  });
}

export function acceptedPlanTaskLedger(): AcceptedPlanTaskLedgerCoordinator {
  return new AcceptedPlanTaskLedgerCoordinator({
    workUnitIdsFromKernelEvents: (events) =>
      kernelEventStatusIndex.workUnitIds(kernelEventStatusIndex.decodeEvents(events)),
    actionBatchHasFailureOrBlocker: (events) =>
      kernelEventStatusIndex.hasFailureOrBlocker(kernelEventStatusIndex.decodeEvents(events)),
  });
}

export function reviewAssembler(): ReviewAssembler {
  return new ReviewAssembler({
    completedWorkUnitFacts: (events) => completedWorkUnitFactIndex.completedWorkUnitFacts(events),
    batchActionRecords: (batch) => driverActivityBuilder.batchActionRecords(batch),
    actionToolId: (action) => actionBundleActionInspector.actionToolId(action),
    actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
    normalizeAcceptedPlanTargetScope: (value) => pathIdentity.normalizePlanScope(value),
    comparablePath: (value) => pathIdentity.comparablePath(value),
    resourceTextForTarget: (packets, target) => resourceEvidenceIndex().textForTarget(packets, target),
  });
}

export function reviewDecisionProjection(): ReviewDecisionProjectionBuilder {
  return new ReviewDecisionProjectionBuilder();
}

export function protocolGate(): ProtocolGate {
  const validator = proposalSemanticValidator();
  return new ProtocolGate({
    ensureReviewableExpectations: (proposal) => executionPromptCoordinator().ensureReviewableExpectations(proposal),
    validateProposalSemantics: (proposal, options) => validator.validateProposalSemantics(proposal, options),
  });
}

export function proposalSemanticValidator(): ProposalSemanticValidator {
  return new ProposalSemanticValidator({
    readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
    actionToolId: (action) => actionBundleActionInspector.actionToolId(action),
    actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
  });
}

export function executionPromptCoordinator(): ExecutionPromptCoordinator<SessionPlanContext> {
  const validator = proposalSemanticValidator();
  return new ExecutionPromptCoordinator<SessionPlanContext>({
    objectRecord,
    stringValue,
    planId: (plan) => plan.planId,
    isDetailedUserPlanMarkdown: (userPlan) => validator.isDetailedUserPlanMarkdown(userPlan),
    defaultActionBundleUserPlanMarkdown: (input) => validator.defaultActionBundleUserPlanMarkdown(input),
    expectationsHaveDescription: (value) => validator.expectationsHaveDescription(value),
    defaultValidationExpectation: (actions) => validator.defaultValidationExpectation(actions),
    defaultReviewExpectation: (actions) => validator.defaultReviewExpectation(actions),
  });
}
