import { AcceptedPlanResourceResumePromptBuilder } from '../prompt/AcceptedPlanResourceResumePromptBuilder.js';
import { ProviderRepairMessageBuilder } from '../prompt/ProviderRepairMessageBuilder.js';
import type { PromptEnvelope } from '../prompt/types.js';
import {
  buildReviewFactsContext,
  type TaskLedgerSnapshot,
} from '../run-state/index.js';
import {
  AcceptedImplementationPlanContextBuilder,
  AcceptedPlanAdmission,
  AcceptedPlanBatchPreflight,
  AcceptedPlanExecutionRootResolver,
  AcceptedPlanExecutor,
  AcceptedPlanOperationTargetResolver,
  AcceptedPlanScopeCoverage,
  AcceptedPlanScopeDecisionOverlay,
  AcceptedPlanScopeMatcher,
  AcceptedPlanTargetParser,
  AcceptedPlanTaskLedgerCoordinator,
  ActionBatchFailureIndex,
  CompletedWorkUnitFactIndex,
  ExecutionPromptCoordinator,
  ImplementationBatchContextBuilder,
  KernelEventStatusIndex,
  RepairLoop,
  type AcceptedImplementationPlanContext,
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
  NativeToolProviderLoop,
  NativeToolProjectionBuilder,
  NativeToolRepairCoordinator,
  NativeToolRepairRunner,
  NativeToolResourceRecorder,
  NativeToolResultMessageBuilder,
  NativeToolResumeMessageBuilder,
  NativeToolTurnHandler,
  ProposalOnlyProviderRunner,
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
} from './projection/index.js';
import { DriverInteractionIndex } from './interactions/index.js';
import { ReviewAssembler, ReviewDecisionProjectionBuilder } from './review/index.js';
import { DriverFailureMessageCatalog, DriverParseErrorCatalog } from './diagnostics/index.js';
import { builtinHooks, HookPolicy, HookRegistry, HookRuntime } from './hooks/index.js';
import type { LlmTurnResult, SessionDriverLoopRunState } from './runFrame.js';
import { clip, objectRecord, stringValue, visibleLanguageForRequest } from './runtimeSupport.js';

const MAX_DERIVED_MANIFEST_ENTRIES = 240;
const RESOURCE_MANIFEST_MAX_BYTES = 512 * 1024;
export const MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES = 384 * 1024;

export const providerRepairMessageBuilder = new ProviderRepairMessageBuilder(MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES);
export const acceptedPlanResourceResumePromptBuilder = new AcceptedPlanResourceResumePromptBuilder(providerRepairMessageBuilder);
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
  planCardAwaitingDecision: (payload) => planReviewReportAnalyzer.planCardAwaitingDecision(payload),
  planReviewEventAwaitingDecision: (payload) => planReviewReportAnalyzer.planReviewEventAwaitingDecision(payload),
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
  buildAcceptedPlan: (input) => acceptedImplementationPlanContextBuilder().build(input),
  withLatestCheckpoint: (acceptedPlan, events) => acceptedPlanTaskLedger().withLatestCheckpoint(acceptedPlan, events),
  afterBatch: (acceptedPlan, completedTaskIds) => acceptedPlanTaskLedger().afterBatch(acceptedPlan, completedTaskIds),
});
export const kernelEventProjectionBuilder = new KernelEventProjectionBuilder({
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
  requiredAccessScopesFromReport: (report) => planReviewGrantProjector.requiredAccessScopesFromReport(report),
  permissionBundlesFromReport: (report) => planReviewGrantProjector.permissionBundlesFromReport(report),
  gateInterventionsFromReport: (report) => planReviewGrantProjector.gateInterventionsFromReport(report),
  planReviewFacts: (report) => planReviewReportAnalyzer.facts(report),
});
export const planProjectionBuilder = new PlanProjectionBuilder({
  readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
  requiredFileOperationsFromReport: (report) => planReviewGrantProjector.requiredFileOperationsFromReport(report),
  requiredAccessScopesFromReport: (report) => planReviewGrantProjector.requiredAccessScopesFromReport(report),
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
  hasFailureOrBlocker: (kernelEvents) => kernelEventStatusIndex.hasFailureOrBlocker(kernelEvents),
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
export const reviewProjectionBuilder = new ReviewProjectionBuilder<SessionPlanContext, AcceptedImplementationPlanContext, TaskLedgerSnapshot>({
  reviewFactLines: (kernelEvents) => reviewAssembler().reviewFactLines(kernelEvents),
  staticSyntaxReviewFactLines: (kernelEvents) => reviewAssembler().staticSyntaxReviewFactLines(kernelEvents),
  findReviewFacts: (kernelEvents) => reviewAssembler().findReviewFacts(kernelEvents),
  concreteContinuationExpectations: (value) => implementationBatchContextBuilder().concreteContinuationExpectations(value),
  acceptedPlanContext: (plan) => plan.implementationPlan
    ? acceptedImplementationPlanContextBuilder().build({ plan, interventionLevel: undefined, executionRoot: plan.executionRoot })
    : undefined,
  acceptedPlanBatchCompletedTaskIds: (acceptedPlan, plan, kernelEvents) =>
    acceptedPlanTaskLedger().batchProgress({ acceptedPlan, proposal: planContextIndex.proposalEnvelope(plan), kernelEvents }).completedTaskIds,
  acceptedPlanAfterBatch: (acceptedPlan, completedTaskIds) => acceptedPlanTaskLedger().afterBatch(acceptedPlan, completedTaskIds),
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
export const acceptedPlanScopeMatcher = new AcceptedPlanScopeMatcher();
export const acceptedPlanScopeCoverage = new AcceptedPlanScopeCoverage({
  taskTargets: (task) => acceptedPlanTargetParser.taskTargets(task),
});
export const acceptedPlanOperationTargetResolver = new AcceptedPlanOperationTargetResolver({
  normalizeTargetScope: (value, accepted) => acceptedPlanScopeMatcher.normalizeTargetScope(value, accepted),
  normalizePlanScope: (value) => pathIdentity.normalizePlanScope(value),
  concreteDirectoryOperationTarget: (value) => planReviewGrantProjector.concreteDirectoryOperationTarget(value),
  concreteFileOperationTarget: (value) => planReviewGrantProjector.concreteFileOperationTarget(value),
  exactGrantCapabilityMatches: (grant, capability) => acceptedPlanScopeCoverage.exactGrantCapabilityMatches(grant, capability),
  actionEffectiveCapability: (action) => actionBundleActionInspector.actionEffectiveCapability(action),
  actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
});
export const acceptedPlanScopeDecisionOverlay = new AcceptedPlanScopeDecisionOverlay({
  planAcceptedAutoGrantCapability: (capability) => planReviewGrantProjector.planAcceptedAutoGrantCapability(capability),
  concreteDirectoryOperationTarget: (value) => planReviewGrantProjector.concreteDirectoryOperationTarget(value),
  concreteFileOperationTarget: (value) => planReviewGrantProjector.concreteFileOperationTarget(value),
  normalizeAcceptedPlanExactOperationGrants: (grants, executionRoot) =>
    planReviewGrantProjector.normalizeAcceptedPlanExactOperationGrants(grants, executionRoot),
  normalizeTargetForExecutionRoot: (value, executionRoot) =>
    acceptedPlanScopeMatcher.normalizeTargetForExecutionRoot(value, executionRoot),
});
export const acceptedPlanBatchPreflight = new AcceptedPlanBatchPreflight({
  batchActionRecords: (batch) => driverActivityBuilder.batchActionRecords(batch),
  actionEffectiveCapability: (action) => actionBundleActionInspector.actionEffectiveCapability(action),
  actionFileTargetPath: (action) => actionBundleActionInspector.actionFileTargetPath(action),
  deleteActionTargetResourceKind: (action) => actionBundleActionInspector.deleteActionTargetResourceKind(action),
  deleteActionRecursive: (action) => actionBundleActionInspector.deleteActionRecursive(action),
  normalizePlanScope: (value) => pathIdentity.normalizePlanScope(value),
  containsDirectoryPath: (resourcePackets, path) => resourceRequestLoop.containsDirectoryPath(resourcePackets, path),
});
export const completedWorkUnitFactIndex = new CompletedWorkUnitFactIndex({
  kernelEventTargets: (record) => kernelEventProjectionBuilder.kernelEventTargets(record),
  normalizeRelativePath: (value) => pathIdentity.normalizeRelativePath(value),
  comparablePath: (value) => pathIdentity.comparablePath(value),
});
export const nativeToolCoordinator = new NativeToolCoordinator();
export const nativeToolTurnHandler = new NativeToolTurnHandler(nativeToolCoordinator);
export const nativeToolRepairCoordinator = new NativeToolRepairCoordinator({
  conversationActivity: (input) => driverActivityBuilder.conversationActivity(input),
  parseProposal: (input) => protocolGate().parseAndValidateProposal(input),
  parseRepairedProposal: (input) => protocolGate().parseAndValidateRepairedProposal(input),
});
export const acceptedPlanExecutor = new AcceptedPlanExecutor({
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
const NATIVE_TOOL_RESULT_MAX_CHARS = 12 * 1024;
export const nativeToolResultMessageBuilder = new NativeToolResultMessageBuilder({
  duplicateResult: (toolCall, existing) => nativeToolCoordinator.duplicateResult(toolCall, existing),
  resultFromPacket: (toolCall, packet) => nativeToolCoordinator.resultFromPacket(toolCall, packet),
}, NATIVE_TOOL_RESULT_MAX_CHARS);
export const nativeToolResourceRecorder = new NativeToolResourceRecorder({
  packetContentHash: (packet) => nativeToolCoordinator.packetContentHash(packet),
  addDiscoveredManifestEntries: (manifest, packet) => resourceRequestLoop.addDiscoveredManifestEntries(manifest, packet),
  packetEvent: (sessionId, packet, ts, id) => resourceRequestLoop.packetEvent(sessionId, packet, ts, id),
});
export const nativeToolResumeMessageBuilder = new NativeToolResumeMessageBuilder({
  callToProtocol: (toolCall) => nativeToolCoordinator.callToProtocol(toolCall),
});
export const nativeToolProgressEventBuilder = new NativeToolProgressEventBuilder();
export const nativeToolProviderLoop = new NativeToolProviderLoop<SessionDriverLoopRunState, PromptEnvelope, LlmTurnResult>({
  providerPipeline,
  turnHandler: nativeToolTurnHandler,
  resumeMessageBuilder: nativeToolResumeMessageBuilder,
});
export const proposalOnlyProviderRunner = new ProposalOnlyProviderRunner<SessionDriverLoopRunState, LlmTurnResult>({
  providerPipeline,
  repairCoordinator: nativeToolRepairCoordinator,
});
export const nativeToolRepairRunner = new NativeToolRepairRunner({
  repairCoordinator: nativeToolRepairCoordinator,
});
export const PROVIDER_REASONING_FLUSH_CHARS = 768;
export const PROVIDER_REASONING_FLUSH_MS = 120;
export const SIDE_EFFECT_CAPABILITIES = new Set([
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
export const providerTurnPolicy = new ProviderTurnPolicy({
  sideEffectCapabilities: SIDE_EFFECT_CAPABILITIES,
});
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

export function implementationBatchContextBuilder(): ImplementationBatchContextBuilder {
  return new ImplementationBatchContextBuilder({
    concreteFileOperationTarget: (value) => planReviewGrantProjector.concreteFileOperationTarget(value),
  });
}

export function acceptedImplementationPlanContextBuilder(): AcceptedImplementationPlanContextBuilder {
  return new AcceptedImplementationPlanContextBuilder({
    normalizePlanScope: (value) => pathIdentity.normalizePlanScope(value),
    uniqueStrings: (values) => driverActivityBuilder.uniqueStrings(values),
    acceptedPlanTaskTargets: (record) => acceptedPlanTargetParser.taskTargets(record),
    exactOperationGrantsFromImplementationPlan: (plan, executionRoot) =>
      planReviewGrantProjector.exactOperationGrantsFromImplementationPlan(plan, executionRoot),
    exactOperationGrantsFromPlanReviewReport: (report, executionRoot) =>
      planReviewGrantProjector.exactOperationGrantsFromPlanReviewReport(report, executionRoot),
    accessScopesFromImplementationPlan: (plan) => planReviewGrantProjector.accessScopesFromImplementationPlan(plan),
    requiredAccessScopesFromReport: (report) => planReviewGrantProjector.requiredAccessScopesFromReport(report),
  });
}

export function acceptedPlanAdmission(): AcceptedPlanAdmission {
  return new AcceptedPlanAdmission({
    scopeMatcher: new AcceptedPlanScopeMatcher(),
    fileOperationFreshnessReasons: (accepted, proposal, resourcePackets) =>
      acceptedPlanExecutor.fileOperationFreshnessValidationReasons(accepted, proposal, resourcePackets),
  });
}

export function acceptedPlanTaskLedger(): AcceptedPlanTaskLedgerCoordinator {
  return new AcceptedPlanTaskLedgerCoordinator({
    workUnitIdsFromKernelEvents: (events) => kernelEventStatusIndex.workUnitIds(events),
    actionBatchHasFailureOrBlocker: (events) => kernelEventStatusIndex.hasFailureOrBlocker(events),
  });
}

export function reviewAssembler(): ReviewAssembler {
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

export function reviewDecisionProjection(): ReviewDecisionProjectionBuilder {
  return new ReviewDecisionProjectionBuilder();
}

export function protocolGate(): ProtocolGate {
  const validator = proposalSemanticValidator();
  return new ProtocolGate({
    canonicalizeWriteActionSourceBlockRefs: (proposal) => validator.canonicalizeWriteActionSourceBlockRefs(proposal),
    ensureReviewableExpectations: (proposal) => executionPromptCoordinator().ensureReviewableExpectations(proposal),
    validateProposalSemantics: (proposal, options) => validator.validateProposalSemantics(proposal, options),
  });
}

export function proposalSemanticValidator(): ProposalSemanticValidator {
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

export function executionPromptCoordinator(): ExecutionPromptCoordinator<SessionPlanContext> {
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
