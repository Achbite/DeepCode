import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  ApiResponse,
  KernelCommandEnvelope,
  KernelEventV1,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
  ProjectionDelta,
} from '@deepcode/protocol';
import {
  agentConfigurableSettingsIndex,
  agentSettingsIndex,
  shellPreferenceSettingsIndex,
  workspaceOverridableSettingsIndex,
} from '@deepcode/protocol';
import {
  applyProviderCacheStrategy,
  assembleContext,
  buildNarrativeTimelineProjection,
  buildTimelineProjectionWithLiveOverlay,
  buildPromptEnvelope,
  buildPromptPacketFrames,
  buildResourcePromptContext,
  buildSessionMemoryDocument,
  buildSessionMemorySnapshot,
  buildAcceptedPlanPromptFrame,
  buildTaskLedgerSnapshot,
  collectUserGuidanceEvents,
  createResourcePacket,
  evaluateRunState,
  findActiveInteraction,
  findLatestPendingPermission,
  normalizeDecisionEffect,
  planInteractionAwaitsDecision,
  parseProposalEnvelope,
  SessionDriver,
  SessionDriverLoop,
  type ActionBundleDraft,
  type ProposalEnvelope,
  type ResourceManifest,
  type ResourcePacket,
  type ResourceRequestDraft,
  type TranscriptEntry,
} from '../index.js';
import { AcceptedPlanAdmission, AcceptedTaskRegistry, type AcceptedTaskPlanContext } from '../accepted-plan/index.js';
import { AgentRunReactor } from '../driver/agentRunReactor.js';
import { ContextFrameBuilder } from '../driver/context/contextFrameBuilder.js';
import { createSessionTurnAuthorityEvent } from '../driver/context/userAuthorityFrame.js';
import { ProviderTurnCycle } from '../driver/pipelines/providerTurnCycle.js';
import { routeProposalKind } from '../driver/proposal/proposalRouter.js';
import {
  acceptedPlanContinuationInput,
  decisionContinuationInput,
  type SessionLoopControlResult,
} from '../driver/runContinuation.js';
import { providerVisibleSchemaDigest, renderProviderTurnContractLayer } from '../prompt/providerTurnContract.js';
import { AcceptedPlanResourceResumeCoordinator, ActionBundleAdmissionResourceFollowupCoordinator, GeneratedArtifactEvidenceIndex, PathIdentity, ProviderTurnContextCoordinator, ResourceEvidenceIndex, ResourceOrchestrator, ResourceRequestLoop, ResourceRequestProposalHandler, ResourceRequestRepairCoordinator, buildProviderTurnSnapshot } from '../driver/context/index.js';
import {
  AcceptedActionBundlePlanExecutor,
  AcceptedTaskPlanContextBuilder,
  AcceptedPlanBatchPreflight,
  ActionBundleAdmissionRepairCoordinator,
  AcceptedPlanExecutor,
  AcceptedPlanTargetParser,
  AcceptedPlanTaskLedgerCoordinator,
  AcceptedPlanTaskRuntimeAccessor,
  type AcceptedPlanTaskRuntimeState,
  ActionBatchFailureIndex,
  CompletedWorkUnitFactIndex,
  ImplementationBatchContextBuilder,
  KernelEventStatusIndex,
  RepairLoop,
} from '../driver/execution/index.js';
import { InteractionOverlayCodec, PermissionPipeline, ProviderJsonModeCoordinator, ProviderPipeline, ProviderStreamCoordinator, ProviderStreamRuntime, ProviderToolCallBuffer, ProviderTraceRecorder, ProviderTurnRunner, UserGuidanceQueue, UserInputPipeline } from '../driver/pipelines/index.js';
import { ActionBundleActionInspector, ActionProposalSubmitter, PlanContextIndex, PlanInteractionIndex, PlanReviewGrantProjector, PlanReviewReportAnalyzer, ProposalSemanticValidator, ProtocolGate } from '../driver/proposal/index.js';
import { AssistantProjectionBuilder, DriverActivityBuilder, KernelEventProjectionBuilder, PlanProjectionBuilder, RequirementProjectionBuilder, ReviewProjectionBuilder, SessionFailureProjectionBuilder, SessionProgressProjectionBuilder, VISIBLE_REASONING_MAX_CHARS } from '../driver/projection/index.js';
import { AcceptedPlanReviewHandoffCoordinator, ReviewAssembler, ReviewDecisionProjectionBuilder } from '../driver/review/index.js';
import { PermissionDecisionHandler, PlanDecisionHandler, RequirementDecisionHandler, ReviewDecisionHandler } from '../driver/interactions/index.js';
import { HookPolicy, HookRegistry, HookRuntime } from '../driver/hooks/index.js';
import { RunEngine } from '../driver/runEngine.js';
import {
  SessionDriverActiveTurnRuntimeAccessor,
  SessionDriverNativeToolRuntimeAccessor,
  SessionDriverProviderRuntimeAccessor,
  SessionDriverRepairRuntimeAccessor,
  type ActiveTurnState,
  type DriverProviderTurnFrame,
  type ModelContextBundle,
} from '../driver/runFrame.js';
import { AcceptedPlanResourceResumePromptBuilder } from '../prompt/AcceptedPlanResourceResumePromptBuilder.js';
import { ProviderRepairMessageBuilder } from '../prompt/ProviderRepairMessageBuilder.js';
import { ProviderProfileRegistry } from '../provider/ProviderProfileRegistry.js';
import type { NativeToolCallProposal } from '../provider/providerStreamParts.js';
import { ResourceManifestBuilder } from '../resources/index.js';
import type { ContextAssemblyRecord, PromptCachePlan } from '../context/index.js';
import type { PromptEnvelope } from '../prompt/types.js';
import {
  assert,
  assertCancelledRunState,
  assertEqual,
  assertThrows,
  randomSmokeToken,
  smokePromptEnvelope,
} from './smokeHelpers.js';
import {
  absoluteTargetWriteProposal,
  acceptedTaskPlanCardEvent,
  applyKernelPlanAuthorizationFixture,
  commaSeparatedTargetsAcceptedTaskPlanCardEvent,
  deleteAcceptedTaskPlanCardEvent,
  deleteActionBundleProposal,
  directoryDeleteAcceptedTaskPlanCardEvent,
  fakeKernel,
  fakeLlm,
  generatedArtifactAcceptedTaskPlanCardEvent,
  genericActionBundle,
  genericDecisionRequestProposal,
  genericDirectoryResourceEvent,
  genericPatchProposal,
  genericProposal,
  genericKernelContextProjectionEvent,
  genericMissingResourceEvent,
  genericResolvedResourceEvent,
  genericSessionResult,
  genericTaskPlanProposal,
  genericToolCatalogSnapshot,
  genericWriteProposal,
  jsonLlmResponse,
  kernelTestBatchReviewReady,
  kernelTestPermissionRequest,
  kernelTestResourcePacket,
  kernelTestReviewGateEvaluation,
  kernelTestReviewFacts,
  kernelTestWorkUnit,
  kernelTestWorkUnitCompleted,
  kernelTestWorkUnitFailed,
  kernelTestWorkUnitQueued,
  kernelTestWorkUnitStarted,
  localizedGenericWriteProposal,
  manyContentBlockWriteProposal,
  manyDeleteActionsProposal,
  multiDeleteAcceptedTaskPlanCardEvent,
  multiTargetAcceptedTaskPlanCardEvent,
  multiWriteActionBundle,
  multiWriteProposal,
  planKernel,
  processExecAcceptedTaskPlanCardEvent,
  processExecProposal,
  proposalReviewReport,
  providerFacingWriteProposalWithoutMachineIds,
  randomMultiWriteProposal,
  readOnlyAcceptedTaskPlanCardEvent,
  relativeTargetWriteProposal,
  singleTargetWriteProposal,
  tripleTargetAcceptedTaskPlanCardEvent,
  userMessageWithDirectoryAttachmentEvent,
} from './smokeFixtures.js';
import {
  assertAcceptedPlanStaticSyntaxReviewCoordinatorBuildsEvents,
  assertAcceptedPlanStaticSyntaxReviewCoordinatorTimesOut,
} from './smokeStaticSyntaxReviewTests.js';
import {
  assertNativeToolExposurePolicySuppressesPlanningReadToolsAfterEvidence,
  assertKernelToolCatalogSummaryIsAuthoritative,
  assertNativeToolHandlerPortsFactoryBuildsPorts,
  assertNativeToolProgressEventBuilderBuildsAssistantProgress,
  assertNativeToolProjectionBuilderBuildsDeltas,
  assertNativeToolProviderLoopAdmitsSemanticProposalWithoutNestedResume,
  assertNativeToolProviderLoopReturnsArtifactBudgetFailureToPlanning,
  assertNativeToolProviderLoopRetriesMalformedArgumentsInSameProfile,
  assertNativeToolProviderLoopRetriesInvalidSemanticDirectiveInSameProfile,
  assertNativeToolRepairCoordinatorBuildsRepairContracts,
  assertNativeToolRepairRunnerHandlesRepairs,
  assertNativeToolResourceRecorderRecordsPackets,
  assertNativeToolResultMessageBuilderBuildsToolMessages,
  assertNativeToolResumeMessageBuilderAppendsToolMessages,
  assertProposalOnlyProviderRunnerRepairsToolViolation,
} from './smokeNativeToolPipelineTests.js';
import {
  assertAcceptedPlanContinuationDefaultsResourceResume,
  assertDecisionContinuationInputKeepsDecisionResumeInSameLoop,
  assertHookObserverProducesTraceOnly,
  assertProviderTurnContextCoordinatorScopesCurrentTaskIntent,
  assertProviderTurnContextCoordinatorNarrowsPlanningAllowedKinds,
  assertProviderTurnContextCoordinatorPassesTaskLocalCompactRecords,
  assertProviderTurnContextCoordinatorRejectsMissingDependencyFacts,
  assertProviderTurnContextCoordinatorScopesAcceptedExecutionCatalog,
  assertProviderTurnContextCoordinatorUsesFreshAssembly,
  assertTaskDependencyFactsRequireTerminalKernelEvidence,
  assertProviderTurnContractFrameOrder,
  assertProviderTurnSnapshotRecordsContextAdmissionShape,
  assertRequirementConfirmationRecordsModelContextBundle,
  assertRunEngineContinuationUsesSameLifecycle,
  assertRunEngineContinuesOnlyForResourceRequestRoute,
  assertRunEngineOwnsNativeProviderResume,
  assertRunEngineOwnsReviewAssembly,
  assertRunEngineRejectsUnexpectedContinueRoute,
  assertTaskLocalCompactRecordFlowsThroughCheckpoints,
} from './smokeLoopContextTests.js';
import {
  assertAcceptedPlanResourceResumePromptUsesPromptContent,
  assertContextAssemblerCachePlan,
  assertDeepSeekCacheStrategyDoesNotInjectRequestParameter,
  assertPromptEnvelope,
  assertProviderCacheTelemetryNormalizesBigModelUsage,
  assertProviderCacheTelemetryNormalizesDeepSeekUsage,
  assertProviderTraceArchiveCompactsStreamingChunks,
  assertResourcePromptBlocksStabilize,
  assertSessionMemoryDocument,
} from './smokePromptContextTests.js';
import {
  assertSessionDriverLoopTerminalAnswerGuidanceRevision,
  assertSessionDriverLoopTerminalGuidanceRevisionFallback,
} from './smokeTerminalGuidanceTests.js';
import {
  assertArtifactDraftLeaseEnforcesBoundsAndRestores,
  assertArtifactDraftBudgetReplanClearsAcceptedExecution,
  assertArtifactDraftPreciseEditMatches,
  assertKernelEnvelopeRecoveryUsesLatestMatchingRun,
  assertPromptLedgerReusesPrefixAndAppendsWithinEpoch,
  assertPromptLedgerRotatesAcceptedTaskScope,
  assertProviderCacheHistoryRestoresBySemanticProfile,
  assertInternalFailureProjectsFailedTerminalState,
  assertUserAuthorityFramePreservesExplicitMessages,
  assertWorkspaceBootstrapAndResourceDeltaStayIncremental,
} from './smokeAuthorityLedgerTests.js';

declare const process: {
  env: Record<string, string | undefined>;
};

function returnedSession(
  control: SessionLoopControlResult,
  message: string
): AgentSessionResult {
  assertEqual(control.kind, 'return', message);
  if (control.kind !== 'return') throw new Error(message);
  return control.result;
}

function semanticToolLlmResponse(
  name: string,
  argumentsValue: Record<string, unknown>,
  callId = `semantic-call-${randomSmokeToken('call')}`
): ApiResponse<LlmChatResult> {
  return {
    ok: true,
    data: {
      chunks: [{ type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: callId, name, arguments: argumentsValue }],
      },
    },
  };
}

function completedKernelToolFact(input: {
  runId: string;
  sessionId: string;
  workUnitId: string;
  toolCallId: string;
  toolId: string;
  path: string;
  content?: string;
}): KernelEventV1 {
  return {
    kind: 'tool.completed',
    runId: input.runId,
    sessionId: input.sessionId,
    fact: {
      toolCallId: input.toolCallId,
      toolId: input.toolId,
      operationKind: input.toolId === 'fs.create' ? 'fsCreate' : 'fsWrite',
      ok: true,
      output: {
        path: input.path,
        contentHash: `hash-${input.toolCallId}`,
        sizeBytes: new TextEncoder().encode(input.content ?? input.path).length,
        kernelContext: { workUnitId: input.workUnitId },
      },
      error: null,
    },
  };
}

async function main(): Promise<void> {
  assertLegacyRegressionControllerInvocation();
  assertKernelEnvelopeRecoveryUsesLatestMatchingRun();
  assertUserAuthorityFramePreservesExplicitMessages();
  assertPromptLedgerReusesPrefixAndAppendsWithinEpoch();
  assertPromptLedgerRotatesAcceptedTaskScope();
  assertTaskDependencyFactsRequireTerminalKernelEvidence();
  assertWorkspaceBootstrapAndResourceDeltaStayIncremental();
  assertInternalFailureProjectsFailedTerminalState();
  assertArtifactDraftLeaseEnforcesBoundsAndRestores();
  await assertArtifactDraftBudgetReplanClearsAcceptedExecution();
  assertArtifactDraftPreciseEditMatches();
  assertV4Parser();
  assertLegacyProviderShapesAreRejected();
  assertActionBundleProtocolFields();
  assertProtocolGateCanonicalizesBareRepair();
  assertActionBundleActionInspectorReadsActionShape();
  assertProposalSemanticValidatorLeavesPathSafetyToKernel();
  assertPathIdentityNormalizesWorkspacePaths();
  assertNativeToolProgressEventBuilderBuildsAssistantProgress();
  assertNativeToolProjectionBuilderBuildsDeltas();
  assertNativeToolResultMessageBuilderBuildsToolMessages();
  assertNativeToolResourceRecorderRecordsPackets();
  assertNativeToolResumeMessageBuilderAppendsToolMessages();
  assertNativeToolExposurePolicySuppressesPlanningReadToolsAfterEvidence();
  assertKernelToolCatalogSummaryIsAuthoritative();
  await assertNativeToolProviderLoopAdmitsSemanticProposalWithoutNestedResume();
  await assertNativeToolProviderLoopReturnsArtifactBudgetFailureToPlanning();
  await assertNativeToolProviderLoopRetriesMalformedArgumentsInSameProfile();
  await assertNativeToolProviderLoopRetriesInvalidSemanticDirectiveInSameProfile();
  await assertNativeToolHandlerPortsFactoryBuildsPorts();
  assertProposalSemanticValidatorCanonicalizesAndDefaults();
  assertPromptEnvelope();
  assertDecisionContinuationInputKeepsDecisionResumeInSameLoop();
  assertAcceptedPlanContinuationDefaultsResourceResume();
  await assertRunEngineContinuationUsesSameLifecycle();
  await assertRunEngineOwnsNativeProviderResume();
  await assertRunEngineContinuesOnlyForResourceRequestRoute();
  await assertRunEngineOwnsReviewAssembly();
  await assertRunEngineRejectsUnexpectedContinueRoute();
  assertContextAssemblerCachePlan();
  assertProviderTurnContractFrameOrder();
  assertProviderTurnSnapshotRecordsContextAdmissionShape();
  assertTaskLocalCompactRecordFlowsThroughCheckpoints();
  await assertProviderTurnContextCoordinatorPassesTaskLocalCompactRecords();
  await assertProviderTurnContextCoordinatorUsesFreshAssembly();
  await assertProviderTurnContextCoordinatorNarrowsPlanningAllowedKinds();
  await assertProviderTurnContextCoordinatorScopesAcceptedExecutionCatalog();
  await assertProviderTurnContextCoordinatorRejectsMissingDependencyFacts();
  await assertProviderTurnContextCoordinatorScopesCurrentTaskIntent();
  await assertRequirementConfirmationRecordsModelContextBundle();
  await assertHookObserverProducesTraceOnly();
  await assertProviderPipelineUsesProviderTurnContract();
  assertProviderJsonModeCoordinator();
  assertProviderStreamCoordinatorClassifiesStages();
  await assertProviderStreamRuntimeHandlesStreamEvents();
  await assertProviderStreamRuntimeBudgetsVisibleReasoning();
  await assertProviderTurnRunnerRunsProviderLifecycle();
  assertUserGuidanceQueueBuildsResumeAndConsumedEvents();
  assertPermissionPipelineFindsPendingPermission();
  await assertPermissionDecisionHandlerAcceptsAndRequestsReviewFacts();
  await assertRequirementDecisionHandlerRejectsActiveRequirement();
  assertInteractionOverlayCodecRoundTrips();
  assertUserInputPipelineFindsRequirementInteractions();
  await assertProviderTraceRecorderArchivesPayload();
  await assertResourceRequestLoopBuildsPacketEvents();
  assertResourceManifestBuilderSeedsWorkspaceRootEntries();
  await assertSessionDriverLoopPreResolvesProjectWorkspaceRoot();
  await assertSessionDriverLoopSuppressesPlanningNativeReadToolsAfterInitialEvidence();
  await assertResourceOrchestratorResolvesAndRecordsPackets();
  await assertResourceRequestProposalHandlerContinuesThroughRunEngine();
  assertResourceEvidenceIndexQueriesPackets();
  assertGeneratedArtifactEvidenceIndexBuildsRunLocalPackets();
  assertImplementationBatchContextBuilderExtractsConcreteContinuations();
  assertRepairLoopBuildsPlanRevisionRequest();
  assertCompletedWorkUnitFactIndexMatchesActionAndTarget();
  assertActionBatchFailureIndexSummarizesKernelFailures();
  assertAcceptedPlanBatchPreflightProjectsAuditOnly();
  assertAcceptedPlanExecutorBuildsExecutionBatch();
  await assertAcceptedActionBundlePlanExecutorSubmitsBatchAndReviews();
  assertKernelEventStatusIndexReadsStructuredEvents();
  await assertAcceptedPlanReviewHandoffCoordinatorBuildsReviewState();
  await assertAcceptedPlanStaticSyntaxReviewCoordinatorBuildsEvents();
  await assertAcceptedPlanStaticSyntaxReviewCoordinatorTimesOut();
  assertReviewAssemblerFormatsReviewFacts();
  assertReviewAssemblerFindsWaitingReviewContext();
  assertReviewDecisionProjectionUsesI18nKeys();
  await assertReviewDecisionHandlerAcceptsTerminalReview();
  await assertReviewDecisionHandlerKeepsTerminalReviewOpenWhenKernelRunIsInactive();
  await assertPlanDecisionHandlerRejectsActivePlan();
  assertProjectionBuildersKeepKernelAndReviewReadModels();
  await assertAgentRunReactorCoordinatesPorts();
  assertDriverActivityBuilderCreatesReadModels();
  assertAssistantProjectionBuilderCreatesConversationEvents();
  assertSessionProgressProjectionBuilderCreatesRunAndCheckpointEvents();
  assertSessionFailureProjectionBuilderCreatesFailureEvents();
  assertRequirementProjectionBuilderCreatesDecisionEvents();
  assertPlanReviewReportAnalyzerKeepsReviewSemantics();
  assertPlanContextIndexBuildsPlanReadModels();
  assertInteractionLedgerResolvesTerminalSourcePlanReview();
  assertInteractionLedgerTerminalRunStateClosesPlan();
  assertProjectionResolvesPlanAfterSourceReview();
  assertProjectionPublishesInteractionState();
  assertPlanInteractionIndexFindsActivePlan();
  assertPlanReviewGrantProjectorBuildsExecutionReadModels();
  assertProposalRouterPlansPureRoutes();
  await assertProviderTurnCycleReturnsRoutedProposal();
  assertAcceptedPlanTargetParserUsesCanonicalTarget();
  assertAcceptedPlanAdmissionChecksProtocolShapeOnly();
  assertAcceptedTaskPlanContextBuilderBuildsRuntimeContext();
  assertRunStateMachineTaskLedger();
  assertSessionDriverRuntimeAccessors();
  assertAcceptedTaskRegistryUsesTaskIntentOnly();
  assertResourcePromptBlocksStabilize();
  assertSessionMemoryDocument();
  assertDeepSeekCacheStrategyDoesNotInjectRequestParameter();
  assertProviderCacheTelemetryNormalizesDeepSeekUsage();
  assertProviderCacheHistoryRestoresBySemanticProfile();
  await assertProviderCacheTelemetryNormalizesBigModelUsage();
  await assertProviderTraceArchiveCompactsStreamingChunks();
  await assertProviderPartFramesEnterKernelDraftLedger();
  await assertAcceptedPlanStreamingDraftsAndJsonProgress();
  await assertProviderLifecycleStatusDoesNotEnterReasoningBody();
  assertSettingsCatalogBoundaries();
  assertNarrativeTimelineProjection();
  assertNarrativeTimelineProjectionResolvesAcceptedPlanInteractions();
  assertTimelineProjectionWithLiveOverlay();
  assertTaskPlanTaskProjectionProgress();
  assertSessionDriverSkeleton();
  await assertSessionDriverLoop();
  await assertSessionDriverLoopTerminalAnswerGuidanceRevision();
  await assertSessionDriverLoopTerminalGuidanceRevisionFallback();
  await assertSessionDriverLoopPathResourceRequest();
  await assertSessionDriverLoopSearchResourceRequest();
  await assertSessionDriverLoopRejectsOutsidePath();
  await assertSessionDriverLoopUsesRecentAttachmentRoot();
  await assertSessionDriverLoopReadOnlyRequestsContinueWithoutBudgetDecision();
  await assertSessionDriverLoopOldResourceBudgetDecisionFailsClosed();
  await assertSessionDriverLoopProjectsDecisionRequest();
  await assertSessionDriverLoopStopsBeforeProviderWhenProjectRootIsUnavailable();
  await assertSessionDriverLoopRequirementConfirmationCarriesExecutionRoot();
  await assertSessionDriverLoopRequirementChoiceEntersResumePrompt();
  await assertSessionDriverLoopRequirementFinishWithAnswerClosesWithoutProviderLoop();
  await assertSessionDriverLoopProjectsTaskPlanBeforeComplete();
  await assertSessionDriverLoopAdmitsSemanticTaskPlanWithoutKernelAction();
  await assertSessionDriverLoopPlanRevisionReturnsToPlanning();
  await assertSessionDriverLoopPlanCardAcceptDoesNotNoopWithoutPlanReview();
  await assertSessionDriverLoopPlanCardAcceptExecutesReviewedDeletePlan();
  await assertSessionDriverLoopAcceptedPlanExecutesDeleteWithinKernelAuthorizedTargets();
  await assertSessionDriverLoopUsesExactKernelOperationsForMixedDelete();
  await assertSessionDriverLoopRejectsMissingExactKernelOperationsBeforeProvider();
  await assertSessionDriverLoopAcceptedExecutionExceptionClosesRun();
  await assertSessionDriverLoopAcceptedExecutionKernelErrorClosesRun();
  await assertSessionDriverLoopAcceptedDecisionRecoversUnconsumedExecution();
  await assertSessionDriverLoopDelegatesDirectoryDeleteAdmissionToKernel();
  await assertSessionDriverLoopAcceptedScopeExecutesReviewedDirectoryDelete();
  await assertSessionDriverLoopAcceptedTaskPlanAutoExecutesBatch();
  await assertSessionDriverLoopAcceptedTaskPlanContinuesUntilTasksComplete();
  await assertSessionDriverLoopAcceptedTaskPlanResumesAfterDecisionRequest();
  await assertSessionDriverLoopAcceptedTaskPlanReadsGeneratedArtifactEvidence();
  await assertSessionDriverLoopAcceptedTaskPlanResumesFromResourceCursor();
  await assertSessionDriverLoopAcceptedTaskPlanChainsResourceResumeRequests();
  await assertSessionDriverLoopAcceptedReadOnlyResourceValidationUsesStructuredOutcome();
  await assertSessionDriverLoopAcceptedTaskPlanRejectsBlockedProcessExec();
  await assertSessionDriverLoopAcceptedTaskDiagnosticFailsRun();
  await assertSessionDriverLoopAcceptedDecisionSubmitsMultiWriteBatch();
  await assertSessionDriverLoopAcceptedDecisionPreservesKernelAuthorizedTarget();
  assertWorkflowStagePermissionProjectsPendingDecision();
  await assertSessionDriverLoopReviewRevisionReturnsToPlanning();
  await assertSessionDriverLoopReviewRevisionStopsWhenGateRunIsInactive();
  await assertSessionDriverLoopReviewAcceptAutoGeneratesNextPlan();
  await assertSessionDriverLoopReviewAcceptWithoutContinuationCompletesRun();
  await assertSessionDriverLoopReviewAcceptOffStopsAtCurrentBatch();
  await assertSessionDriverLoopRequirementRejectCancelsRun();
  await assertSessionDriverLoopRejectedDecisionCancelsRun();
  await assertSessionDriverLoopReviewRejectCancelsRun();
  await assertSessionDriverLoopPermissionRejectUsesKernelFacts();
  await assertSessionDriverLoopStaleRequirementDecisionNoopsAfterReviewAccept();
}

function turnAuthorityFixture(
  sessionId: string,
  runId: string,
  content: string,
  tag: string
): AgentEvent[] {
  const messageId = `user-message-${tag}`;
  return [
    {
      id: messageId,
      sessionId,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content },
    },
    createSessionTurnAuthorityEvent({
      sessionId,
      runId,
      turnId: `turn-${tag}`,
      taskId: `task-${tag}`,
      messages: [{ messageId, content }],
      relation: 'newTask',
      boundAtHookRef: 'run.initialized',
      outputLanguage: 'en-US',
      eventId: `authority-${tag}`,
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
  ];
}

function assertActionBundleActionInspectorReadsActionShape(): void {
  const token = randomSmokeToken('action-inspector');
  const argsPath = `args-${token}/target-${randomSmokeToken('args')}.txt`;
  const inspector = new ActionBundleActionInspector();

  assertEqual(
    inspector.actionToolId({ toolId: 'git.status' }),
    'git.status',
    'action inspector keeps canonical git tool ids'
  );
  assertEqual(
    inspector.actionToolId({ toolId: 'git.commit' }),
    'git.commit',
    'action inspector keeps canonical git mutation tool ids'
  );
  assertEqual(
    inspector.actionToolId({ toolId: 'web.search' }),
    'web.search',
    'action inspector keeps canonical web tool ids'
  );
  assertEqual(
    inspector.actionToolId({ toolId: 'browser.open' }),
    'browser.open',
    'action inspector keeps blocked canonical tool ids'
  );
  assertEqual(
    inspector.actionFileTargetPath({ args: { path: argsPath } }),
    argsPath,
    'action inspector reads args path'
  );
}

function assertProposalSemanticValidatorLeavesPathSafetyToKernel(): void {
  const token = randomSmokeToken('root-task-target');
  const inspector = new ActionBundleActionInspector();
  const validator = new ProposalSemanticValidator({
    readActionBundle: () => undefined,
    actionToolId: (action) => inspector.actionToolId(action),
    actionFileTargetPath: (action) => inspector.actionFileTargetPath(action),
  });
  const rootPlan = {
    kind: 'taskPlan',
    payload: {
      title: `Plan ${token}`,
      summary: `Summary ${token}`,
      tasks: [{
        taskId: `task-${token}`,
        title: `Task ${token}`,
        toolId: 'fs.delete',
        target: ['workspace root'],
        args: {},
        dependencies: [],
        acceptanceCriteria: [`accepted-${token}`],
        failureCriteria: [`failed-${token}`],
      }],
    },
  } as ProposalEnvelope;
  validator.validateProposalSemantics(rootPlan);
  const missingToolPlan = {
    kind: 'taskPlan',
    payload: {
      title: `Missing tool plan ${token}`,
      summary: `Missing tool summary ${token}`,
      tasks: [{
        taskId: `missing-tool-task-${token}`,
        title: `Missing tool task ${token}`,
        target: [`dir-${token}/file.txt`],
        dependencies: [],
        acceptanceCriteria: [`accepted-${token}`],
        failureCriteria: [`failed-${token}`],
      }],
    },
  } as ProposalEnvelope;
  assertThrows(
    () => validator.validateProposalSemantics(missingToolPlan),
    'toolId must be a non-empty Kernel catalog tool ID'
  );
  const concretePlan = {
    kind: 'taskPlan',
    payload: {
      title: `Concrete plan ${token}`,
      summary: `Concrete summary ${token}`,
      tasks: [{
        taskId: `concrete-task-${token}`,
        title: `Concrete task ${token}`,
        toolId: 'fs.write',
        target: [`dir-${token}/file.txt`],
        args: {},
        dependencies: [],
        acceptanceCriteria: [`accepted-${token}`],
        failureCriteria: [`failed-${token}`],
      }],
    },
  } as ProposalEnvelope;
  validator.validateProposalSemantics(concretePlan);
}

function assertPathIdentityNormalizesWorkspacePaths(): void {
  const token = randomSmokeToken('path-identity');
  const root = `scope-${token}`;
  const child = `child-${randomSmokeToken('child')}`;
  const file = `file-${randomSmokeToken('file')}.txt`;
  const mixedCase = `Case-${randomSmokeToken('dir')}/MiXeD-${randomSmokeToken('file')}.TXT`;
  const identity = new PathIdentity();

  assertEqual(
    identity.normalizeRelativePath(`./${root}//./${child}/${file}`),
    `${root}/${child}/${file}`,
    'path identity normalizes workspace relative paths'
  );
  assertEqual(
    identity.normalizeRelativePath(`${root}/../${file}`),
    undefined,
    'path identity rejects upward traversal'
  );
  assertEqual(
    identity.comparablePath(`${root}//${child}/`),
    `${root}/${child}`,
    'path identity compares paths without trailing slash'
  );
  assertEqual(
    identity.comparablePath(`${mixedCase}/`),
    mixedCase,
    'path identity preserves path casing while comparing slash-normalized paths'
  );
  assertEqual(
    identity.normalizePlanScope(`./${root}//${child}/`),
    `${root}/${child}/`,
    'path identity normalizes plan scope slashes'
  );
  assertEqual(
    identity.normalizePlanScopeIdentity(`./${root}//${child}/`),
    `${root}/${child}`,
    'path identity normalizes plan scope identity'
  );
  assertEqual(
    identity.expandPlanTargetTokens(`delete ${root}/${child}/${file}`).includes(`${root}/${child}/${file}`),
    true,
    'path identity extracts path-like target tokens'
  );
  assertEqual(
    identity.dirnameLike(`${root}/${child}/${file}`),
    `${root}/${child}`,
    'path identity derives dirname-like parent'
  );
}

function assertProposalSemanticValidatorCanonicalizesAndDefaults(): void {
  const token = randomSmokeToken('proposal-semantic');
  const target = `targets/${token}.txt`;
  const blockId = "block-" + token;
  const actionFileTargetPath = (action: Record<string, unknown>): string | undefined => {
    if (typeof action.targetPath === 'string' && action.targetPath.trim()) return action.targetPath.trim();
    const args = typeof action.args === 'object' && action.args && !Array.isArray(action.args)
      ? action.args as Record<string, unknown>
      : undefined;
    return typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  };
  const validator = new ProposalSemanticValidator({
    readActionBundle: (proposal) => (proposal.payload as Record<string, any>).actionBundle as ActionBundleDraft,
    actionToolId: (action) => typeof action.toolId === 'string' ? action.toolId : '',
    actionFileTargetPath,
  });
  const proposal = {
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `proposal-${token}`,
    runId: `run-${token}`,
    sessionId: `session-${token}`,
    source: 'llm',
    kind: 'actionBundle',
    payload: {
      userPlan: `Brief ${token}`,
      actionBundle: {
        version: '1',
        id: `bundle-${token}`,
        goal: `Goal ${token}`,
        actions: [{
          actionId: `action-${token}`,
          toolId: 'fs.write',
          args: { path: target, contentBlockId: blockId },
          description: `Write ${token}`,
        }],
      },
      contentBlocks: [{
        blockId,
        targetPath: target,
        operation: 'overwrite',
        contentLines: [`content-${token}`],
      }],
    },
  } as ProposalEnvelope;
  validator.validateProposalSemantics(proposal, { allowBriefActionBundleUserPlan: true });
  const bundle = (proposal.payload as Record<string, any>).actionBundle;
  assertEqual(bundle.validationExpectations[0].messageKey, 'session.driver.defaultValidation.targets', 'proposal semantic validator adds validation expectation key');
  assertEqual(bundle.reviewExpectations[0].messageKey, 'session.driver.defaultReview.targets', 'proposal semantic validator adds review expectation key');

  const patchTarget = `targets/${token}-patch.txt`;
  const patchBlockId = `patch-block-${token}`;
  const patchProposal = {
    ...proposal,
    proposalId: `patch-proposal-${token}`,
    payload: {
      userPlan: `Patch ${token}`,
      actionBundle: {
        version: '1',
        id: `patch-bundle-${token}`,
        goal: `Patch goal ${token}`,
        actions: [{
          actionId: `patch-action-${token}`,
          toolId: 'fs.edit',
          args: {
            path: patchTarget,
            replacementBlockId: patchBlockId,
            patchSpec: { match: { kind: 'exactBlock', text: `old-${token}` } },
          },
          description: `Patch ${token}`,
        }],
      },
      contentBlocks: [{
        blockId: patchBlockId,
        targetPath: patchTarget,
        operation: 'patch',
        contentLines: [`new-${token}`],
      }],
    },
  } as ProposalEnvelope;
  validator.validateProposalSemantics(patchProposal, { allowBriefActionBundleUserPlan: true });

  const validTaskPlan = {
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `task-plan-${token}`,
    runId: `run-${token}`,
    sessionId: `session-${token}`,
    source: 'llm',
    kind: 'taskPlan',
    payload: {
      version: '1',
      id: `task-plan-${token}`,
      title: `Plan ${token}`,
      summary: `Plan summary ${token}`,
      tasks: [{
        taskId: `task-${token}`,
        title: `Task ${token}`,
        toolId: 'fs.write',
        target: [target],
        args: {},
        dependencies: [],
        acceptanceCriteria: [`Acceptance ${token}`],
        failureCriteria: [`Failure ${token}`],
      }],
      risks: [],
      reviewCheckpoints: [],
    },
  } as ProposalEnvelope;
  validator.validateProposalSemantics(validTaskPlan);

  const missingTargetTaskPlan = {
    ...validTaskPlan,
    payload: {
      ...(validTaskPlan.payload as Record<string, any>),
      tasks: [{
        taskId: `task-missing-target-${token}`,
        title: `Task missing target ${token}`,
        toolId: 'fs.write',
        target: [],
        args: {},
        dependencies: [],
        acceptanceCriteria: [`Acceptance ${token}`],
        failureCriteria: [`Failure ${token}`],
      }],
    },
  } as ProposalEnvelope;
  assertThrows(() => validator.validateProposalSemantics(missingTargetTaskPlan), 'target must include at least one concrete target');

  const missingAcceptanceTaskPlan = {
    ...validTaskPlan,
    payload: {
      ...(validTaskPlan.payload as Record<string, any>),
      tasks: [{
        taskId: `task-missing-acceptance-${token}`,
        title: `Task missing acceptance ${token}`,
        toolId: 'fs.write',
        target: [target],
        args: {},
        dependencies: [],
        acceptanceCriteria: [],
        failureCriteria: [`Failure ${token}`],
      }],
    },
  } as ProposalEnvelope;
  assertThrows(() => validator.validateProposalSemantics(missingAcceptanceTaskPlan), 'acceptanceCriteria must include at least one reviewable criterion');

  const missingFailureTaskPlan = {
    ...validTaskPlan,
    payload: {
      ...(validTaskPlan.payload as Record<string, any>),
      tasks: [{
        taskId: `task-missing-failure-${token}`,
        title: `Task missing failure ${token}`,
        toolId: 'fs.write',
        target: [target],
        args: {},
        dependencies: [],
        acceptanceCriteria: [`Acceptance ${token}`],
        failureCriteria: [],
      }],
    },
  } as ProposalEnvelope;
  assertThrows(() => validator.validateProposalSemantics(missingFailureTaskPlan), 'failureCriteria must include at least one stop or replan criterion');
}

async function assertProviderPipelineUsesProviderTurnContract(): Promise<void> {
  const token = randomSmokeToken('provider-pipeline');
  const requestText = `visible dialogue request ${token}`;
  const planningProfile = new ProviderProfileRegistry().profile('planning-v1');
  const prompt = buildPromptEnvelope({
    workflowState: `workflow-${token}`,
    allowedProposals: ['answer'],
    toolCatalogSummary: `capability-${token}`,
    providerProfileSystemContract: planningProfile.systemContract,
    userRequest: requestText,
  });
  const contract = new ContextFrameBuilder().buildProviderTurnContract({
    contractId: `contract-${token}`,
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    turnMode: 'planning',
    allowedKinds: ['answer'],
    prompt,
    userRequest: requestText,
    nextActionInstruction: `answer-${token}`,
  });
  const pipeline = new ProviderPipeline();
  const stages: string[] = [];
  const firstMessages: LlmChatRequest['messages'][] = [];
  const turn = await pipeline.runProposalOnly({
    profileId: `profile-${token}`,
    state: { token },
    contract,
    stage: `stage-${token}`,
    isEmptyResponseError: () => false,
    runTurn: async (_profileId, _state, stage, messages) => {
      stages.push(stage);
      firstMessages.push(messages);
      return stages.length === 1
        ? { content: '', toolCalls: [] }
        : { content: `{"kind":"answer","token":"${token}"}`, toolCalls: [] };
    },
  });
  assertEqual(turn.content.includes(token), true, 'provider pipeline returns retried turn content');
  assertEqual(stages[0], `stage-${token}`, 'provider pipeline uses original stage for first call');
  assertEqual(stages[1], `stage-${token}_empty_retry`, 'provider pipeline reuses empty retry stage suffix');
  assertEqual(
    firstMessages[0]?.[0]?.content,
    prompt.stablePrefix,
    'provider pipeline uses the exact ContextAdmission stable prefix'
  );
  assert(String(firstMessages[0]?.[0]?.content ?? '').includes('ProtectedStablePrefix begins here.'), 'provider system message retains the protected stable contract');
  assert(String(firstMessages[0]?.[0]?.content ?? '').includes('Session semantic profile: planning-v1'), 'provider system message includes the stable planning profile contract');
  const firstUserPrompt = String(firstMessages[0]?.[1]?.content ?? '');
  assertEqual(firstUserPrompt.startsWith(prompt.dynamicSuffix), true, 'provider pipeline keeps dynamic suffix first');
  assertEqual(firstUserPrompt.includes('ProviderTurnContract:'), true, 'provider pipeline renders provider turn contract');
  assertEqual(firstUserPrompt.includes('<PromptPacket schemaVersion="deepcode.session.prompt-packet.v1">'), false, 'main provider prompt does not inject legacy prompt-packet renderer');
  assertEqual(firstUserPrompt.includes('"kind": "NextActionInstruction"'), true, 'main provider prompt carries next action through driver contract frames');
  assertEqual(firstUserPrompt.includes(`answer-${token}`), true, 'provider pipeline renders next action instruction');
  assertEqual(firstUserPrompt.includes('"nextActionInstruction"'), false, 'provider turn contract omits duplicated top-level next action field');
  assertEqual((firstUserPrompt.match(new RegExp(`answer-${token}`, 'g')) ?? []).length, 1, 'next action appears only as final instruction');
  assertEqual(firstUserPrompt.includes('See final Provider turn instruction.'), true, 'next action frame points to the final instruction without duplicating it');
  const providerContractText = firstUserPrompt.slice(firstUserPrompt.indexOf('ProviderTurnContract:'));
  assertEqual(providerContractText.includes(requestText), false, 'provider turn contract references dynamic dialogue instead of duplicating it');
  assertEqual(providerContractText.includes('"summaryRef": "dynamicSuffix"'), true, 'provider turn contract uses a dynamic suffix summary reference for repeated frame text');
  assertEqual(buildProviderTurnSnapshot(contract).finalUserPromptCharLength, firstUserPrompt.length, 'provider pipeline and context admission snapshot share user prompt renderer');
  assertEqual(firstMessages[1]?.length, 3, 'provider pipeline appends one retry instruction after empty response');
  const retryUserPrompt = String(firstMessages[1]?.[1]?.content ?? '');
  assertEqual(
    retryUserPrompt.includes('ProviderTurnContract:'),
    true,
    'provider pipeline keeps provider turn contract in retry base prompt'
  );
  const preRenderedMessages = pipeline.messages(contract);
  const preRenderedTurns: LlmChatRequest['messages'][] = [];
  await pipeline.runWithNativeTools({
    profileId: `profile-prerendered-${token}`,
    state: { token },
    contract,
    stage: `stage-prerendered-${token}`,
    messages: preRenderedMessages,
    isEmptyResponseError: () => false,
    runTurn: async (_profileId, _state, _stage, messages) => {
      preRenderedTurns.push(messages);
      return { content: `{"kind":"answer","token":"${token}"}`, toolCalls: [] };
    },
  });
  const preRenderedUserPrompt = String(preRenderedTurns[0]?.find((message) => message.role === 'user')?.content ?? '');
  assertEqual(
    (preRenderedUserPrompt.match(/ProviderTurnContract:/g) ?? []).length,
    1,
    'provider pipeline does not append a second provider turn contract to pre-rendered messages'
  );
  const resumedMessages: LlmChatRequest['messages'][] = [];
  await pipeline.runProposalOnly({
    profileId: `profile-resume-${token}`,
    state: { token },
    contract,
    stage: `stage-resume-${token}`,
    messages: [{ role: 'assistant', content: `tool-result-${token}` }],
    isEmptyResponseError: () => false,
    runTurn: async (_profileId, _state, _stage, messages) => {
      resumedMessages.push(messages);
      return { content: `{"kind":"answer","token":"${token}"}`, toolCalls: [] };
    },
  });
  assertEqual(resumedMessages[0]?.length, 2, 'provider pipeline appends contract frame after non-user resume messages');
  assertEqual(
    String(resumedMessages[0]?.[1]?.content ?? '').includes('ProviderTurnContract:'),
    true,
    'provider pipeline renders contract frame after non-user resume messages'
  );
}

function assertProviderJsonModeCoordinator(): void {
  const coordinator = new ProviderJsonModeCoordinator();
  const messages: LlmChatRequest['messages'] = [{ role: 'user', content: 'Return the next proposal.' }];
  const injected = coordinator.ensureMessages(messages, { type: 'json_object' });
  assertEqual(injected.length, 2, 'provider json mode coordinator injects one system instruction');
  assertEqual(String(injected[0]?.content ?? '').includes('valid JSON object'), true, 'json mode instruction is explicit');
  const audit = coordinator.audit(messages, { type: 'json_object' });
  assertEqual(audit?.injectedJsonInstruction, true, 'json mode audit records injected instruction');
  const userMentionsJson = coordinator.ensureMessages(
    [{ role: 'user', content: 'Return JSON only.' }],
    { type: 'json_object' }
  );
  assertEqual(userMentionsJson.length, 2, 'provider json mode coordinator does not treat user text as a protocol control flag');
  const alreadyInjected = coordinator.ensureMessages(injected, { type: 'json_object' });
  assertEqual(alreadyInjected.length, 2, 'provider json mode coordinator does not duplicate its own exact system instruction');
  assertEqual(coordinator.audit(injected, { type: 'json_object' })?.injectedJsonInstruction, false, 'json mode audit recognizes structured Session injection');
  assertEqual(coordinator.ensureMessages(messages, undefined), messages, 'provider json mode coordinator ignores non-json mode');
}

function assertProviderStreamCoordinatorClassifiesStages(): void {
  const token = randomSmokeToken('provider-stream');
  const coordinator = new ProviderStreamCoordinator();
  assertEqual(coordinator.exposesAssistantDelta('answer_stream'), true, 'provider stream exposes answer deltas');
  assertEqual(coordinator.exposesAssistantDelta(`answer-${token}`), false, 'provider stream rejects unknown assistant stages');
  assertEqual(coordinator.emitsJsonProgress('accepted_plan_provider_call'), true, 'provider stream emits accepted-plan JSON progress');
  assertEqual(coordinator.emitsJsonProgress(`accepted-${token}`), false, 'provider stream rejects unknown JSON progress stages');
  assert(
    coordinator.jsonProgressSummary('en-US', 37).includes('37'),
    'provider stream English progress summary includes received char count'
  );
  assert(
    coordinator.jsonProgressSummary('zh-CN', 41).includes('41'),
    'provider stream Chinese progress summary includes received char count'
  );
  assert(
    coordinator.stageSummary(`stage_${token}`, 'request', 'en-US').includes('requesting'),
    'provider stream coordinator renders request stage summary'
  );
  assert(
    coordinator.nativeToolResolveRunningSummary(`tool-${token}`, 'en-US').includes(`tool-${token}`),
    'provider stream coordinator renders native tool running summary'
  );
  assert(
    coordinator.toolCallPreparingSummary(`tool-${token}`, 'en-US').includes(`tool-${token}`),
    'provider stream coordinator renders tool call summary'
  );
  assert(
    coordinator.usageSummary('en-US').length > 0,
    'provider stream coordinator renders usage summary'
  );
  assert(
    coordinator.guidanceRevisionTransitionMessage('en-US').length > 0,
    'provider stream coordinator renders guidance revision summary'
  );
}

async function assertProviderStreamRuntimeHandlesStreamEvents(): Promise<void> {
  const token = randomSmokeToken('provider-runtime');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const deltas: Array<Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>> = [];
  const kernelRequests: KernelCommandEnvelope[] = [];
  const runtime = new ProviderStreamRuntime<any>({
    reasoningFlushChars: 999_999,
    reasoningFlushMs: 999_999,
    streamCoordinator: new ProviderStreamCoordinator(),
    visibleLanguageForRequest: () => 'en-US',
    providerActivity: (input) => ({
      activityId: `provider-${input.stage}-${token}`,
      kind: 'providerThinking',
      status: input.status,
      title: `provider-${input.stage}`,
      summary: `provider-${input.stage}-${input.status}`,
      source: 'provider',
      runId: input.runId,
    }),
    conversationActivity: (activity) => activity,
    emitProjectionDelta: async (_state, delta) => {
      deltas.push(delta);
    },
    kernelCommand: async (request) => {
      kernelRequests.push(request);
      return { ok: true, events: [] };
    },
    createId: (prefix) => `${prefix}-${token}`,
  });
  const state = {
    sessionId,
    runId,
    userRequest: `request-${token}`,
  };
  const toolCallBuffer = new ProviderToolCallBuffer({
    parseArguments: (raw) => raw ? JSON.parse(raw) as Record<string, unknown> : {},
    normalizeToolName: (name) => name,
  });
  const reasoningBuffer = runtime.createReasoningBuffer();

  await runtime.handleEvent({
    state,
    stage: 'answer_stream',
    event: {
      type: 'provider_delta',
      chunk: {
        type: 'delta',
        content: `answer-${token}`,
        callId: `answer-call-${token}`,
        rawProvider: { token },
      },
    } as any,
    toolCallBuffer,
    reasoningBuffer,
  });
  await runtime.handleEvent({
    state,
    stage: 'accepted_plan_provider_call',
    event: {
      type: 'provider_delta',
      chunk: {
        type: 'delta',
        content: `json-${token}`,
      },
    } as any,
    toolCallBuffer,
    reasoningBuffer,
  });
  await runtime.handleEvent({
    state,
    stage: 'provider_call',
    event: {
      type: 'provider_reasoning_delta',
      chunk: {
        type: 'delta',
        content: `reason-${token}`,
        callId: `reason-call-${token}`,
      },
    } as any,
    toolCallBuffer,
    reasoningBuffer,
  });
  await runtime.handleEvent({
    state,
    stage: 'provider_call',
    event: {
      type: 'provider_tool_call_delta',
      chunk: {
        type: 'delta',
        index: 0,
        callId: `tool-call-${token}`,
        toolCallDelta: {
          index: 0,
          id: `tool-call-${token}`,
          name: `read_${token}`,
          argumentsDelta: JSON.stringify({ ref: token }),
        },
      },
    } as any,
    toolCallBuffer,
    reasoningBuffer,
  });
  await runtime.handleEvent({
    state,
    stage: 'provider_call',
    event: {
      type: 'provider_usage',
      usage: { inputTokens: 1, outputTokens: 2 },
    } as any,
    toolCallBuffer,
    reasoningBuffer,
  });
  const frame = {
    schemaVersion: 'deepcode.agent.stream.part.v1',
    partKind: 'actionDraftChunk',
    draftId: `draft-${token}`,
    frameId: `frame-${token}`,
    targetPath: `scope-${token}/target-${randomSmokeToken('file')}.txt`,
    chunk: `draft-${token}`,
    summary: `draft summary ${token}`,
  };
  await runtime.handleEvent({
    state,
    stage: 'provider_call',
    event: {
      type: 'provider_delta',
      chunk: {
        type: 'delta',
        content: `<deepcode-part>${JSON.stringify(frame)}</deepcode-part>`,
      },
    } as any,
    toolCallBuffer,
    reasoningBuffer,
  });
  await runtime.handleEvent({
    state,
    stage: 'provider_call',
    event: {
      type: 'provider_error',
      error: `err-${token}`,
    } as any,
    toolCallBuffer,
    reasoningBuffer,
  });

  assert(
    deltas.some((delta) => delta.type === 'assistant_delta' && delta.delta === `answer-${token}`),
    'provider stream runtime emits assistant deltas for answer streaming'
  );
  assert(
    deltas.some((delta) => delta.type === 'stage_delta' && delta.itemId === 'accepted_plan_provider_call-provider-json-progress'),
    'provider stream runtime emits JSON progress deltas'
  );
  assert(
    deltas.some((delta) => delta.type === 'reasoning_delta' && delta.delta === `reason-${token}`),
    'provider stream runtime buffers and flushes reasoning deltas'
  );
  assertEqual(toolCallBuffer.toToolCalls().length, 1, 'provider stream runtime records tool call chunks');
  assert(
    deltas.some((delta) => delta.type === 'tool_call_delta' && delta.itemId === `tool-call-${token}`),
    'provider stream runtime emits tool call deltas'
  );
  const reasoningDeltaIndex = deltas.findIndex(
    (delta) => delta.type === 'reasoning_delta' && delta.delta === `reason-${token}`
  );
  const toolCallDeltaIndex = deltas.findIndex(
    (delta) => delta.type === 'tool_call_delta' && delta.itemId === `tool-call-${token}`
  );
  assert(
    reasoningDeltaIndex >= 0 && toolCallDeltaIndex > reasoningDeltaIndex,
    'provider stream runtime flushes buffered reasoning before the following tool call delta'
  );
  assert(
    deltas.some((delta) => delta.type === 'stage_delta' && delta.source === 'provider'),
    'provider stream runtime emits usage deltas'
  );
  assert(
    deltas.some((delta) => delta.type === 'part_delta' && delta.itemId === `frame-${token}`),
    'provider stream runtime emits provider part deltas'
  );
  assertEqual(kernelRequests.length, 0, 'provider stream runtime keeps transport stream frames inside Session');
  assertEqual(
    deltas.some((delta) => delta.type === 'draft_delta' && delta.itemId === `draft-${token}`),
    false,
    'provider stream runtime does not misroute transport frames into the Kernel artifact DraftLedger'
  );
  assert(
    deltas.some((delta) => delta.type === 'error' && delta.summary === `err-${token}`),
    'provider stream runtime emits provider stream errors'
  );
}

async function assertProviderStreamRuntimeBudgetsVisibleReasoning(): Promise<void> {
  const token = randomSmokeToken('provider-runtime-budget');
  const deltas: Array<Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>> = [];
  const runtime = new ProviderStreamRuntime<any>({
    reasoningFlushChars: 1,
    reasoningFlushMs: 999_999,
    visibleReasoningMaxChars: 32,
    streamCoordinator: new ProviderStreamCoordinator(),
    visibleLanguageForRequest: () => 'en-US',
    providerActivity: (input) => ({
      activityId: `provider-${input.stage}-${token}`,
      kind: 'providerThinking',
      status: input.status,
      title: `provider-${input.stage}`,
      summary: `provider-${input.stage}-${input.status}`,
      source: 'provider',
      runId: input.runId,
    }),
    conversationActivity: (activity) => activity,
    emitProjectionDelta: async (_state, delta) => {
      deltas.push(delta);
    },
    kernelCommand: async () => ({ ok: true, events: [] }) as KernelReply,
    createId: (prefix) => `${prefix}-${token}`,
  });
  const reasoningBuffer = runtime.createReasoningBuffer();
  const state = {
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    userRequest: `request-${token}`,
  };
  const toolCallBuffer = new ProviderToolCallBuffer({
    parseArguments: (raw) => raw ? JSON.parse(raw) as Record<string, unknown> : {},
    normalizeToolName: (name) => name,
  });

  await runtime.handleEvent({
    state,
    stage: 'provider_call',
    event: {
      type: 'provider_reasoning_delta',
      chunk: {
        type: 'reasoning_delta',
        content: `${token}-`.repeat(20),
      },
    } as any,
    toolCallBuffer,
    reasoningBuffer,
  });
  await runtime.flushReasoningBuffer(state, 'provider_call', reasoningBuffer);

  const reasoningDelta = deltas.find((delta) => delta.type === 'reasoning_delta');
  if (!reasoningDelta) throw new Error('provider stream runtime should emit a visible reasoning delta');
  assert(
    String(reasoningDelta.delta ?? '').length <= 32,
    'streaming provider reasoning is bounded before entering conversation projection'
  );
  assertEqual((reasoningDelta.payload as any).reasoningProjectionTruncated, true, 'streaming reasoning delta records truncation metadata');
  assert(
    Number((reasoningDelta.payload as any).reasoningProjectionFullCharLength) > Number((reasoningDelta.payload as any).reasoningProjectionVisibleCharLength),
    'streaming reasoning delta records full and visible character lengths'
  );
}

async function assertProviderTurnRunnerRunsProviderLifecycle(): Promise<void> {
  const token = randomSmokeToken('provider-turn');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const deltas: Array<Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>> = [];
  const appendedEvents: AgentEvent[] = [];
  const traceStages: string[] = [];
  const requests: LlmChatRequest[] = [];
  const streamRuntime = new ProviderStreamRuntime<any>({
    reasoningFlushChars: 8,
    reasoningFlushMs: 999_999,
    streamCoordinator: new ProviderStreamCoordinator(),
    visibleLanguageForRequest: () => 'en-US',
    providerActivity: (input) => ({
      activityId: `activity-${input.stage}-${token}`,
      kind: 'providerThinking',
      status: input.status,
      title: `activity-${input.stage}`,
      summary: `activity-${input.stage}-${input.status}`,
      source: 'provider',
      runId: input.runId,
    }),
    conversationActivity: (activity) => activity,
    emitProjectionDelta: async (_state, delta) => {
      deltas.push(delta);
    },
    kernelCommand: async () => ({ ok: true, events: [] }) as KernelReply,
    createId: (prefix) => `${prefix}-${token}`,
  });
  const runner = new ProviderTurnRunner<any>({
    jsonModeCoordinator: new ProviderJsonModeCoordinator(),
    streamCoordinator: new ProviderStreamCoordinator(),
    streamRuntime,
    traceRecorder: new ProviderTraceRecorder(),
    visibleLanguageForRequest: () => 'en-US',
    providerActivity: (input) => ({
      activityId: `provider-${input.stage}-${token}`,
      kind: 'providerThinking',
      status: input.status,
      title: `provider-${input.stage}`,
      summary: `provider-${input.stage}-${input.status}`,
      source: 'provider',
      runId: input.runId,
    }),
    emitProjectionDelta: async (_state, delta) => {
      deltas.push(delta);
    },
    cacheTelemetryEvent: (input) => ({
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'cache_telemetry',
      payload: {
        stage: input.stage,
        usage: input.usage,
      },
    } as unknown as AgentEvent),
    reasoningEvent: (eventSessionId, reasoning, ts, id) => ({
      id,
      sessionId: eventSessionId,
      ts,
      kind: 'assistant_msg',
      payload: {
        channel: 'assistant',
        presentation: 'reasoning',
        content: reasoning,
      },
    } as AgentEvent),
    createToolCallBuffer: () => new ProviderToolCallBuffer({
      parseArguments: (raw) => raw ? JSON.parse(raw) as Record<string, unknown> : {},
      normalizeToolName: (name) => name,
    }),
    collectToolCalls: () => [],
    nativeToolError: () => undefined,
    createError: (code, message) => new Error(`${code}:${message}`),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${token}`,
  });
  const result = await runner.run({
    profileId: `profile-${token}`,
    state: {
      sessionId,
      runId,
      userRequest: `request-${token}`,
      cachePlan: { mode: 'off', reasons: [`reason-${token}`], segments: [] },
      contextAssembly: {
        provider: `provider-${token}`,
        model: `model-${token}`,
        segments: [
          {
            id: `segment-${token}`,
            name: `segment-${token}`,
            cacheClass: 'dynamic',
            stablePrefix: false,
            auditOnly: false,
            contentHash: `hash-${token}`,
            charLength: 3,
          },
        ],
        stablePrefixHash: `stable-${token}`,
        dynamicSuffixHash: `dynamic-${token}`,
        cacheHash: `cache-${token}`,
      },
    },
    stage: `stage-${token}`,
    messages: [{ role: 'user', content: `Return structured output ${token}.` }],
    options: { responseFormat: { type: 'json_object' } },
    ports: {
      llmChat: async (request) => {
        requests.push(request);
        return {
          ok: true,
          data: {
            chunks: [
              { type: 'reasoning_delta', content: `reason-${token}` },
              { type: 'delta', content: `answer-${token}` },
            ],
            assistantMessage: {
              role: 'assistant',
              content: `answer-${token}`,
              reasoningContent: `reason-${token}`,
            },
            usage: { inputTokens: 2, outputTokens: 3 },
          },
        } as ApiResponse<LlmChatResult>;
      },
      appendEvents: async (_eventSessionId, events) => {
        appendedEvents.push(...events);
        return {};
      },
      appendTranscript: async (_eventSessionId, entry) => {
        if (entry.type === 'metadata') {
          const payload = entry.payload as Record<string, unknown>;
          if (typeof payload.stage === 'string') traceStages.push(payload.stage);
        }
      },
      createId: (prefix) => `${prefix}-${token}`,
      now: () => '2026-01-01T00:00:00.000Z',
    },
  });

  assertEqual(result.content, `answer-${token}`, 'provider turn runner returns assistant content');
  assertEqual(result.reasoning, `reason-${token}`, 'provider turn runner returns assistant reasoning');
  assertEqual(requests.length, 1, 'provider turn runner sends one provider request');
  assertEqual(Boolean(requests[0]?.messages[0]?.content.toString().includes('valid JSON object')), true, 'provider turn runner applies JSON mode');
  const deepcodeOptions = (requests[0]?.providerOptions as any)?.deepcode as Record<string, any> | undefined;
  assertEqual(deepcodeOptions?.cachePlan?.mode, 'off', 'provider turn runner forwards cache plan');
  assert(
    traceStages.includes(`stage-${token}.request`) && traceStages.includes(`stage-${token}.response`),
    'provider turn runner records request and response traces'
  );
  assert(
    deltas.some((delta) => delta.type === 'active_turn' && delta.status === 'running') &&
      deltas.some((delta) => delta.type === 'active_turn' && delta.status === 'completed'),
    'provider turn runner emits active turn lifecycle deltas'
  );
  assert(
    appendedEvents.some((event) => event.kind === 'cache_telemetry') &&
      appendedEvents.some((event) => event.kind === 'assistant_msg'),
    'provider turn runner appends cache telemetry and reasoning events'
  );
}

function assertUserGuidanceQueueBuildsResumeAndConsumedEvents(): void {
  const token = randomSmokeToken('guidance-queue');
  const queue = new UserGuidanceQueue();
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const guidanceId = `guidance-${token}`;
  const otherRunGuidanceId = `guidance-other-${token}`;
  const events: AgentEvent[] = [
    {
      id: guidanceId,
      sessionId,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_guidance',
      payload: {
        guidanceId,
        targetRunId: runId,
        content: `Apply generic guidance ${token}`,
        status: 'queued',
      },
    },
    {
      id: otherRunGuidanceId,
      sessionId,
      ts: '2026-01-01T00:00:00.100Z',
      kind: 'user_guidance',
      payload: {
        guidanceId: otherRunGuidanceId,
        targetRunId: `other-${runId}`,
        content: `Ignore other run ${token}`,
        status: 'queued',
      },
    },
  ];

  const resume = queue.providerResume({
    sessionId,
    events,
    runId,
    taskId: `task-${token}`,
    stage: 'provider_resume',
    outputLanguage: 'en-US',
    summary: `summary-${token}`,
    now: () => '2026-01-01T00:00:00.200Z',
    createId: (prefix) => `${prefix}-${token}`,
  });
  assertEqual(resume.guidance.length, 1, 'user guidance queue filters to current run guidance');
  assertEqual(resume.guidance[0]?.id, guidanceId, 'user guidance queue preserves guidance id');
  assert(String(resume.messages[1]?.content ?? '').includes(`Apply generic guidance ${token}`), 'user guidance queue preserves the explicit provider resume message');
  assertEqual(resume.events.length, 2, 'user guidance queue emits authority and consumed events');
  assertEqual(resume.events[0]?.kind, 'session_turn_authority', 'user guidance queue binds queued messages to one turn');
  const consumedPayload = resume.events[1]?.payload as Record<string, unknown>;
  assertEqual(consumedPayload?.status, 'consumed', 'user guidance queue marks guidance consumed');
  assertEqual(consumedPayload?.summary, `summary-${token}`, 'user guidance queue uses caller-provided summary');
  assertEqual(consumedPayload?.appliedAtProviderStage, 'provider_resume', 'user guidance queue records provider stage');

  const duplicate = queue.consumedEvents({
    sessionId,
    events: [...events, ...resume.events],
    consumedIds: [guidanceId],
    runId,
    appliedAtProviderStage: 'provider_resume',
    summary: `summary-${token}`,
    now: () => '2026-01-01T00:00:00.300Z',
    createId: (prefix) => `${prefix}-duplicate-${token}`,
  });
  assertEqual(duplicate.length, 0, 'user guidance queue does not emit duplicate consumed events');
}

function assertPermissionPipelineFindsPendingPermission(): void {
  const token = randomSmokeToken('permission-pipeline');
  const pipeline = new PermissionPipeline();
  const pendingId = `permission-${token}`;
  const resolvedId = `resolved-${token}`;
  const runId = `run-${token}`;
  const planId = `plan-${token}`;
  const events = [
    {
      kind: 'permission_request',
      payload: {
        id: resolvedId,
        runId,
        planId,
      },
    },
    {
      kind: 'permission_result',
      payload: {
        permissionId: resolvedId,
        runId,
      },
    },
    {
      kind: 'kernel_event',
      payload: {
        kernelEvent: {
          kind: 'permission.requested',
          runId,
          request: {
            id: pendingId,
            requestKind: 'scopeExpansion',
            contractId: `contract-${planId}`,
            affectedOperationIds: [`operation-${token}`],
            workUnitIds: [`work-unit-${token}`],
            capability: 'workspace.write',
            riskLevel: 'medium',
            summary: `permission-${token}`,
            argsPreview: {},
          },
        },
      },
    },
  ] as AgentEvent[];
  const pending = pipeline.findPendingPermissionContext(events);
  assertEqual(pending?.id, pendingId, 'permission pipeline finds latest unresolved permission request');
  assertEqual(pending?.contractId, `contract-${planId}`, 'permission pipeline preserves the Kernel contract id');
  assertEqual(
    pipeline.findPendingPermissionContext(events, resolvedId),
    null,
    'permission pipeline ignores resolved permission request'
  );
}

async function assertPermissionDecisionHandlerAcceptsAndRequestsReviewFacts(): Promise<void> {
  const token = randomSmokeToken('permission-handler');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const planId = `plan-${token}`;
  const permissionId = `permission-${token}`;
  const workUnitId = `work-unit-${token}`;
  const session: AgentSession = {
    id: sessionId,
    projectId: `project-${token}`,
    mode: 'plan',
    createdAt: `ts-${token}`,
    updatedAt: `ts-${token}`,
  };
  const planEvent = {
    id: `plan-event-${token}`,
    sessionId,
    ts: `ts-${token}`,
    kind: 'plan_card',
    payload: {
      runId,
      planId,
      proposalId: `proposal-${token}`,
      content: `plan-${token}`,
      actionBundle: { id: `bundle-${token}`, actions: [] },
      contentBlocks: [],
      commandBlocks: [],
      expectedValidation: `validation-${token}`,
      reviewGuide: `review-${token}`,
      authorizationContract: { id: `contract-${planId}` },
    },
  } as unknown as AgentEvent;
  const permissionEvent = {
    id: `permission-event-${token}`,
    sessionId,
    ts: `ts-${token}`,
    kind: 'kernel_event',
    payload: {
      kernelEvent: {
        kind: 'permission.requested',
        runId,
        request: {
          id: permissionId,
          requestKind: 'scopeExpansion',
          contractId: `contract-${planId}`,
          affectedOperationIds: [`operation-${token}`],
          workUnitIds: [workUnitId],
          capability: 'workspace.write',
          riskLevel: 'medium',
          summary: `permission-${token}`,
          argsPreview: {},
        },
      },
    },
  } as unknown as AgentEvent;
  const decisionEvents: KernelEventV1[] = [
    {
      kind: 'work_unit.queued',
      runId,
      workUnit: {
        id: workUnitId,
        planId,
        actionId: `action-${token}`,
        title: `action-${token}`,
        toolId: 'fs.create',
        operationKind: 'fsCreate',
        capability: 'workspace.write',
        readSet: [],
        writeSet: [`target-${token}`],
        conflictKeys: [`workspace:target-${token}`],
        executionMode: 'execute',
        status: 'queued',
      },
    },
    {
      kind: 'work_unit.completed',
      runId,
      workUnitId,
    },
    {
      kind: 'batch.review_ready',
      runId,
      contractId: `contract-${planId}`,
    },
  ];
  const planIndex = new PlanContextIndex({
    interactionOverlayFromPayload: () => undefined,
    executionRootFromPayload: () => undefined,
  });
  let projectedEvents: AgentEvent[] = [planEvent, permissionEvent];
  const kernelCommands: string[] = [];
  const handler = new PermissionDecisionHandler({
    now: () => `ts-${token}`,
    createId: (prefix) => `${prefix}-${token}`,
    observeKernel: async (request: KernelCommandEnvelope) => {
      const command = request.command as { kind?: string; permissionId?: string; decision?: string; runId?: string };
      kernelCommands.push(command.kind ?? '');
      if (command.kind === 'permissionResolve') {
        assertEqual(command.permissionId, permissionId, 'permission handler resolves the pending permission');
        assertEqual(command.decision, 'accept', 'permission handler forwards accept decision');
        return new KernelEventStatusIndex().observe({ ok: true, events: [...decisionEvents] });
      }
      throw new Error(`unexpected kernel command ${command.kind}`);
    },
    appendProjectedKernelEvents: async (nextSessionId, reply) => {
      assertEqual(nextSessionId, sessionId, 'permission handler projects kernel events to current session');
      const projected = (reply.events ?? []).map((kernelEvent, index) => ({
        id: `kernel-${kernelCommands.length}-${index}-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind: 'kernel_event',
        payload: { kernelEvent },
      } as unknown as AgentEvent));
      projectedEvents = [...projectedEvents, ...projected];
      return { session, events: projectedEvents };
    },
    append: async (nextSessionId, events) => {
      assertEqual(nextSessionId, sessionId, 'permission handler appends review events to current session');
      return { session, events: [...projectedEvents, ...events] };
    },
    permissionPipeline: new PermissionPipeline(),
    kernelStatus: new KernelEventStatusIndex(),
    planIndex,
    progressProjection: {
      traceEvent: ({ kind, summary, extra }) => ({
        id: `trace-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind,
        payload: { summary, ...extra },
      }),
      sessionRunStateEvent: ({ phase, reason, decisionOwner }) => ({
        id: `run-state-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind: 'session_run_state',
        payload: { phase, reason, decisionOwner },
      }),
    },
  });

  const control = await handler.resolve({
    sessionId,
    decision: 'accept',
    runId,
    targetId: permissionId,
    existingEvents: [planEvent, permissionEvent],
  });

  assertEqual(kernelCommands.join(','), 'permissionResolve', 'permission handler only resolves the interrupted Kernel command');
  assertEqual(control.kind, 'assembleReview', 'permission completion returns Review assembly control to the decision owner');
  if (control.kind !== 'assembleReview') throw new Error('permission completion must request Review assembly');
  assertEqual(control.request.runId, runId, 'permission Review assembly keeps the original run');
  assertEqual(control.request.planId, planId, 'permission Review assembly keeps the original plan');
  assertEqual(control.request.currentKernelEvents.length, 3, 'permission Review assembly carries Kernel review readiness');
}

async function assertRequirementDecisionHandlerRejectsActiveRequirement(): Promise<void> {
  const token = randomSmokeToken('requirement-handler');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const requirementId = `requirement-${token}`;
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    title: `Session ${token}`,
    createdAt: `created-${token}`,
    updatedAt: `updated-${token}`,
    eventCount: 0,
  };
  const store: AgentEvent[] = [{
    id: `requirement-confirmation-${token}`,
    sessionId,
    ts: `ts-${token}`,
    kind: 'requirement_confirmation',
    payload: {
      confirmable: true,
      status: 'waitingUserConfirmation',
      runId,
      requirementId,
      originalUserRequest: `request-${token}`,
      decisionRequest: {
        id: `decision-${token}`,
        question: `Question ${token}?`,
        options: [
          { id: `accept-${token}`, label: `Accept ${token}` },
          { id: `reject-${token}`, label: `Reject ${token}` },
        ],
      },
    },
  } as AgentEvent];
  const handler = new RequirementDecisionHandler({
    now: () => `now-${token}`,
    createId: (prefix) => `${prefix}-${token}`,
    append: async (nextSessionId, events) => {
      assertEqual(nextSessionId, sessionId, 'requirement handler appends to current session');
      store.push(...events);
      return { session: { ...session, eventCount: store.length }, events: [...store] };
    },
    activeDriverInteraction: () => ({ kind: 'requirement', runId, requirementId }),
    executionRootFromDecision: () => undefined,
    buildAcceptedTaskPlan: () => {
      throw new Error('requirement reject must not build accepted implementation context');
    },
    recoverAcceptedPlanFromOverlay: () => undefined,
    visibleLanguageForRequest: () => 'en-US',
    userInputPipeline: new UserInputPipeline(),
    interactionOverlayCodec: new InteractionOverlayCodec(),
    requirementProjection: new RequirementProjectionBuilder({
      visibleLanguageForRequest: () => 'en-US',
      interactionOverlayPayload: () => ({}),
    }),
    assistantProjection: new AssistantProjectionBuilder({
      visibleLanguageForRequest: () => 'en-US',
      guidanceRevisionTransitionMessage: () => `transition-${token}`,
    }),
    progressProjection: new SessionProgressProjectionBuilder({
      interactionOverlayPayload: () => ({}),
      hasFailureOrBlocker: () => false,
      auditAcceptedPlanBatch: () => ({}),
      actionBundleAdmissionBatch: () => ({}),
      acceptedPlanTaskLedger: () => undefined,
      acceptedPlanPromptFrame: () => undefined,
    }),
    planIndex: new PlanContextIndex({
      interactionOverlayFromPayload: () => undefined,
      executionRootFromPayload: () => undefined,
    }),
    acceptedPlanLedger: new AcceptedPlanTaskLedgerCoordinator(),
    executionPrompt: {
      executionRequest: () => {
        throw new Error('requirement reject must not resume accepted-plan execution');
      },
    } as any,
  });

  const control = await handler.resolve({
    sessionId,
    decision: 'reject',
    runId,
    targetId: requirementId,
    existingEvents: [...store],
  });

  const result = returnedSession(control, 'requirement reject returns a terminal decision result');
  assertEqual(result.events.some((event) => event.kind === 'requirement_decision' && (event.payload as any)?.status === 'rejected'), true, 'requirement handler records rejected requirement decision');
  const cancelled = result.events.find((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'cancelled');
  assert(Boolean(cancelled), 'requirement handler appends cancelled run state');
  const cancelledPayload = cancelled?.payload as Record<string, unknown> | undefined;
  assertEqual(cancelledPayload?.phase, 'cancelled', 'requirement handler cancelled state uses cancelled phase');
  const owner = cancelledPayload?.decisionOwner as Record<string, unknown> | undefined;
  assertEqual(owner?.requirementId, requirementId, 'requirement handler cancelled state keeps requirement owner');
}

function assertInteractionOverlayCodecRoundTrips(): void {
  const token = randomSmokeToken('interaction-overlay');
  const codec = new InteractionOverlayCodec();
  const payload = codec.toPayload({
    parentRunId: `parent-${token}`,
    parentPhase: 'executing_accepted_plan',
    interactionRunId: `interaction-run-${token}`,
    interactionId: `interaction-${token}`,
    sourceInteractionId: `source-${token}`,
    acceptedPlanId: `plan-${token}`,
    acceptedPlanRunId: `plan-run-${token}`,
    acceptedCurrentTaskId: `task-${token}`,
    acceptedCompletedTaskIds: [`completed-${token}`],
  });
  const parsed = codec.fromPayload(payload);
  assertEqual(parsed?.parentRunId, `parent-${token}`, 'interaction overlay codec parses parent run');
  assertEqual(parsed?.parentPhase, 'executing_accepted_plan', 'interaction overlay codec parses parent phase');
  assertEqual(parsed?.acceptedCompletedTaskIds?.[0], `completed-${token}`, 'interaction overlay codec preserves completed task ids');
  const resumed = codec.fromRequirementDecision(
    {
      id: `confirmation-${token}`,
      kind: 'requirement_confirmation',
      payload,
    } as AgentEvent,
    {
      id: `decision-${token}`,
      kind: 'requirement_decision',
      payload: {},
    } as AgentEvent
  );
  assertEqual(resumed?.resumedFromDecisionId, `decision-${token}`, 'interaction overlay codec annotates resumed decision id');
  assertEqual(codec.fromPayload({ ...payload, parentPhase: `unknown-${token}` }), undefined, 'interaction overlay codec rejects unknown phases');
}

function assertUserInputPipelineFindsRequirementInteractions(): void {
  const token = randomSmokeToken('user-input-pipeline');
  const pipeline = new UserInputPipeline();
  const runId = `run-${token}`;
  const requirementId = `requirement-${token}`;
  const confirmation = {
    kind: 'requirement_confirmation',
    payload: {
      confirmable: true,
      status: 'waitingUserConfirmation',
      runId,
      requirementId,
    },
  } as AgentEvent;
  const events = [confirmation];
  const active = pipeline.findLatestActiveRequirementInteraction(events);
  assertEqual(active?.runId, runId, 'user input pipeline finds active requirement run');
  assertEqual(active?.requirementId, requirementId, 'user input pipeline finds active requirement id');
  assertEqual(
    pipeline.findRequirementConfirmation(events, runId, requirementId, active),
    confirmation,
    'user input pipeline finds requirement confirmation'
  );
  assertEqual(
    pipeline.findLatestActiveRequirementInteraction([
      confirmation,
      {
        kind: 'requirement_decision',
        payload: {
          status: 'accepted',
          runId,
          requirementId,
        },
      } as AgentEvent,
    ]),
    null,
    'user input pipeline ignores resolved requirements'
  );
  const requestText = `Request ${token}`;
  const fallbackConfirmation = {
    id: `fallback-${token}`,
    sessionId: `session-${token}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      runId,
      requirementId,
      originalUserRequest: requestText,
      decisionRequest: {
        id: `decision-${token}`,
        question: `Question ${token}`,
      },
    },
  } as AgentEvent;
  const record = pipeline.requirementRecordFromEvent(fallbackConfirmation, 'confirmed');
  assertEqual(record?.requirementId, requirementId, 'user input pipeline recovers requirement id from confirmation payload');
  assertEqual(record?.initialUserRequest, requestText, 'user input pipeline recovers original request from confirmation payload');
  assertEqual(pipeline.requirementOriginalRequest(fallbackConfirmation), requestText, 'user input pipeline recovers original request directly');
  const proposalRecord = pipeline.requirementRecordFromProposal({
    proposal: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'decisionRequest',
      runId,
      sessionId: `session-${token}`,
      proposalId: `proposal-${token}`,
      source: 'llm',
      payload: {
        id: `proposal-requirement-${token}`,
        summary: `Goal ${token}`,
        scope: [`Scope ${token}`],
        acceptanceCriteria: [`Acceptance ${token}`],
      },
    } as ProposalEnvelope,
    sessionId: `session-${token}`,
    runId,
    userRequest: requestText,
    timestamp: '2026-01-01T00:00:00.000Z',
  });
  assertEqual(proposalRecord.requirementId, `proposal-requirement-${token}`, 'user input pipeline builds requirement records from proposal ids');
  assertEqual(proposalRecord.checklist?.goal, `Goal ${token}`, 'user input pipeline builds requirement goal from proposal summary');
  assertEqual(proposalRecord.checklist?.explicitTasks[0], `Scope ${token}`, 'user input pipeline keeps proposal scope as explicit tasks');
  assertEqual(proposalRecord.checklist?.acceptanceCriteriaCandidates[0], `Acceptance ${token}`, 'user input pipeline keeps proposal acceptance criteria');
  const decisionEvent = {
    kind: 'requirement_decision',
    payload: {
      selectedOption: {
        id: `selected-${token}`,
        label: `Selected ${token}`,
        description: `Description ${token}`,
      },
    },
  } as AgentEvent;
  const resume = pipeline.requirementDecisionResumeRequest(fallbackConfirmation, decisionEvent, 'accept', `Guidance ${token}`);
  assert(resume.includes(requestText), 'user input pipeline resume request keeps original request');
  assert(resume.includes(`selected-${token}`), 'user input pipeline resume request keeps selected option id');
  assert(resume.includes(`Guidance ${token}`), 'user input pipeline resume request keeps user guidance');
  const acceptedResume = pipeline.acceptedPlanExecutionRequirementResumeRequest(fallbackConfirmation, decisionEvent, 'accept');
  assert(acceptedResume.includes('Accepted-plan continuation rule:'), 'user input pipeline accepted-plan resume request keeps execution continuation rule');
  const effectTarget = `scope-${token}/target-${randomSmokeToken('file')}.txt`;
  const effectEvent = {
    kind: 'requirement_decision',
    payload: {
      selectedOption: {
        id: `effect-${token}`,
        effect: {
          kind: 'expandCurrentTaskScope',
          taskId: `task-${token}`,
          targetPath: effectTarget,
          targetResourceKind: 'file',
          reason: `Reason ${token}`,
        },
      },
    },
  } as AgentEvent;
  assertEqual(
    pipeline.selectedRequirementDecisionOptionId(effectEvent),
    `effect-${token}`,
    'user input pipeline reads selected requirement option id'
  );
  const selectedEffect = pipeline.selectedRequirementDecisionOptionEffect(effectEvent);
  assertEqual(selectedEffect?.kind, 'expandCurrentTaskScope', 'user input pipeline parses selected option effect kind');
  assertEqual(
    selectedEffect?.kind === 'expandCurrentTaskScope' ? selectedEffect.targetPath : undefined,
    effectTarget,
    'user input pipeline preserves selected option effect target'
  );
  const defaultEffect = pipeline.defaultRequirementDecisionOptionEffect({
    kind: 'requirement_confirmation',
    payload: {
      decisionRequest: {
        options: [
          { id: `first-${token}`, effect: { kind: 'skipCurrentTask' } },
          { id: `recommended-${token}`, recommended: true, effect: { kind: 'finishWithAnswer', reason: `Done ${token}` } },
        ],
      },
    },
  } as AgentEvent);
  assertEqual(defaultEffect?.kind, 'finishWithAnswer', 'user input pipeline prefers recommended default effect');
  assertEqual(
    pipeline.isResourceBudgetConfirmation({
      kind: 'requirement_confirmation',
      payload: { requirementId: `resource-budget-${token}` },
    } as AgentEvent),
    true,
    'user input pipeline recognizes resource budget confirmations'
  );
  assertEqual(
    pipeline.isAcceptedPlanExecutionConfirmation({
      kind: 'requirement_confirmation',
      payload: {
        interactionOverlay: true,
        parentRunId: `parent-${token}`,
        parentPhase: 'executing_accepted_plan',
        interactionRunId: `interaction-run-${token}`,
        interactionId: `interaction-${token}`,
        acceptedPlanId: `plan-${token}`,
      },
    } as AgentEvent),
    true,
    'user input pipeline recognizes accepted-plan execution confirmations'
  );
}

async function assertProviderTraceRecorderArchivesPayload(): Promise<void> {
  const token = randomSmokeToken('provider-trace-recorder');
  const entries: TranscriptEntry[] = [];
  const recorder = new ProviderTraceRecorder();
  await recorder.append(
    { sessionId: `session-${token}`, runId: `run-${token}` },
    `stage-${token}.request`,
    {
      profileId: `profile-${token}`,
      messages: [{ role: 'user', content: `content-${token}` }],
      responseFormat: { type: 'json_object' },
      tools: [],
    },
    {
      appendTranscript: async (_sessionId, entry) => {
        entries.push(entry);
      },
      createId: (prefix) => `${prefix}-${token}`,
      now: () => '2026-01-01T00:00:00.000Z',
    }
  );
  assertEqual(entries.length, 1, 'provider trace recorder appends one transcript entry');
  const entry = entries[0];
  assertEqual(entry?.type, 'metadata', 'provider trace recorder writes metadata transcript entry');
  if (!entry || entry.type !== 'metadata') throw new Error('provider trace recorder did not write metadata');
  assertEqual(entry.kind, 'provider_trace', 'provider trace recorder writes provider trace kind');
  const payload = entry.payload as Record<string, unknown>;
  assertEqual(payload.runId, `run-${token}`, 'provider trace recorder keeps run id');
  const archive = payload.payload as Record<string, unknown>;
  assertEqual(
    archive?.schemaVersion,
    'deepcode.session.provider-trace-archive.v1',
    'provider trace recorder stores compact archive payload'
  );
  assertEqual(archive?.kind, 'request', 'provider trace recorder archives request payloads');
}

async function assertResourceRequestLoopBuildsPacketEvents(): Promise<void> {
  const token = randomSmokeToken('resource-request-loop');
  const loop = new ResourceRequestLoop();
  const packet = loop.findPacket([
    {
      kind: 'resource.packet_produced',
      packet: {
        id: `packet-${token}`,
        workspaceScopeKey: `workspace-${token}`,
        requestId: `request-${token}`,
        items: [
          {
            requestItemId: `item-${token}`,
            manifestEntryId: `entry-${token}`,
            status: 'resolved',
            contentKind: 'text',
            path: `path-${token}.txt`,
            content: `content-${token}`,
            evidenceRefs: [`evidence-${token}`],
          },
        ],
      },
    },
  ]);
  assertEqual(packet?.id, `packet-${token}`, 'resource request loop extracts packet id');
  assertEqual(packet?.items[0]?.sourceKind, 'kernelResource', 'resource request loop marks kernel resource facts');
  const event = loop.packetEvent(`session-${token}`, packet!, '2026-01-01T00:00:00.000Z', `event-${token}`);
  assertEqual(event.kind, 'tool_result', 'resource request loop emits tool_result projection event');
  const payload = event.payload as Record<string, unknown>;
  assertEqual(payload.toolName, 'kernel.resourceResolve', 'resource request loop keeps kernel resource tool name');
  const activity = payload.activity as Record<string, unknown>;
  assertEqual(activity.kind, 'resourceRead', 'resource request loop builds resource read activity');
  const recent = loop.recentPackets([event]);
  assertEqual(recent.length, 1, 'resource request loop reads recent packet from projection event');
  assertEqual(recent[0]?.items[0]?.promptContent, `content-${token}`, 'resource request loop preserves prompt content');

  const manifest: ResourceManifest = {
    id: `manifest-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    entries: [],
    budget: { maxEntries: 16, maxBytes: 1024 },
    defaultDenyPatterns: [],
  };
  loop.addDiscoveredManifestEntries(manifest, {
    id: `tree-packet-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    requestId: `tree-request-${token}`,
    items: [
      {
        requestItemId: `tree-item-${token}`,
        manifestEntryId: `tree-entry-${token}`,
        readPolicy: 'autoRead',
        status: 'resolved',
        contentKind: 'directoryTree',
        absolutePath: `/tmp/root-${token}`,
        nodes: [
          {
            path: `dir-${token}`,
            type: 'directory',
            children: [
              { path: `dir-${token}/file.txt`, type: 'file' },
            ],
          },
        ],
      } as any,
    ],
  });
  assertEqual(manifest.entries.length, 2, 'resource request loop derives manifest entries from directory tree');
  assertEqual(manifest.entries[0]?.kind, 'directory', 'resource request loop preserves derived directory kind');
  assertEqual(manifest.entries[1]?.resourceRef, `/tmp/root-${token}/dir-${token}/file.txt`, 'resource request loop joins derived resource paths');

  const resolved = await loop.resolvePacket(
    { sessionId: `session-${token}`, runId: `run-${token}` },
    manifest,
    {
      createId: (prefix) => `${prefix}-${token}`,
      kernelCommand: async (request): Promise<KernelReply> => {
        const command = request.command;
        assertEqual(command.kind, 'resourceResolve', 'resource request loop submits ResourceResolve command');
        if (command.kind !== 'resourceResolve') throw new Error('expected resourceResolve command');
        assertEqual(command.requestId, `resource-resolve-${token}`, 'resource request loop uses injected id source');
        assertEqual(command.sessionId, `session-${token}`, 'resource request loop keeps session id');
        return {
          ok: true,
          events: [
            {
              kind: 'resource.packet_produced',
              runId: `run-${token}`,
              packet: {
                id: `resolved-packet-${token}`,
                workspaceScopeKey: `workspace-${token}`,
                requestId: `resolved-request-${token}`,
                manifestId: manifest.id,
                evidenceRefs: [`evidence-${token}`],
                summary: `resolved-${token}`,
                items: [
                  {
                    requestItemId: `resolved-item-${token}`,
                    manifestEntryId: `resolved-entry-${token}`,
                    status: 'provided',
                    readPolicy: 'autoRead',
                    sourceKind: 'file',
                    contentKind: 'text',
                    content: `resolved-content-${token}`,
                  },
                  {
                    requestItemId: `missing-item-${token}`,
                    manifestEntryId: `missing-entry-${token}`,
                    status: 'notFound',
                    readPolicy: 'autoRead',
                    sourceKind: 'file',
                    contentKind: 'metadata',
                    path: `missing-${token}.txt`,
                    reason: 'not_found',
                  },
                ],
              },
            },
          ],
        };
      },
    }
  );
  assertEqual(resolved?.id, `resolved-packet-${token}`, 'resource request loop resolves packet from kernel reply');
  assertEqual(resolved?.items.length, 2, 'mixed resolved and notFound resource facts remain in one usable packet');
  assertEqual(resolved?.items[1]?.status, 'notFound', 'missing resource is preserved as a normal notFound fact');

  const diagnostic = loop.resolutionDiagnostic({
    manifest,
    unresolved: [`missing-${token}`],
    ambiguous: [`ambiguous-${token}`],
    availableRoots: [
      {
        rootId: `root-${token}`,
        kind: 'directory',
        label: `Root ${token}`,
        displayPath: `/tmp/root-${token}`,
        absolutePath: `/tmp/root-${token}`,
        source: 'currentAttachment',
      },
    ],
  });
  assertEqual(diagnostic.code, 'resourceResolveFailed', 'resource request loop owns resource resolution diagnostics');
  assert(diagnostic.fallback.includes(`missing-${token}`), 'resource request loop diagnostic includes unresolved target');
  assert(
    diagnostic.fallback.includes(`root-${token} -> /tmp/root-${token}`),
    'resource request loop diagnostic includes available roots'
  );

  const directoryPacket = {
    id: `dir-packet-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    requestId: `dir-request-${token}`,
    items: [
      {
        requestItemId: `dir-item-${token}`,
        manifestEntryId: `dir-entry-${token}`,
        readPolicy: 'autoRead',
        status: 'resolved',
        contentKind: 'directoryTree',
        nodes: [
          {
            type: 'directory',
            path: `root-${token}`,
            children: [
              {
                type: 'directory',
                path: `root-${token}/nested-${token}`,
              },
            ],
          },
        ],
      },
    ],
  } as unknown as ResourcePacket;
  assert(
    loop.containsDirectoryPath([directoryPacket], `./root-${token}/nested-${token}/`),
    'resource request loop recognizes directory targets from ResourcePacket directory trees'
  );
}

function assertResourceManifestBuilderSeedsWorkspaceRootEntries(): void {
  const token = randomSmokeToken('resource-manifest-root');
  const builder = new ResourceManifestBuilder({
    maxDerivedManifestEntries: 8,
    resourceManifestMaxBytes: 4096,
    comparablePath: (value) => value.replace(/\/+$/g, ''),
    isAbsolutePath: (value) => value.startsWith('/'),
  });
  const projectRoot = `/tmp/${token}/${randomSmokeToken('project')}`;
  const project = builder.build({
    sessionId: `session-${token}`,
    projectId: `project-${token}`,
    projectKind: 'folder',
    projectRootStatus: 'ready',
    workspaceBinding: {
      workspaceId: `workspace-${token}`,
      workspaceHash: `hash-${token}`,
      openPath: projectRoot,
    },
    projectWorkingDirectory: {
      rootId: `root-${token}`,
      label: `Project ${token}`,
      displayPath: projectRoot,
      absolutePath: projectRoot,
      source: 'projectWorkingDirectory',
    },
  }, `manifest-${token}`);

  assertEqual(project.manifest.entries.length, 1, 'project working directory becomes an initial manifest entry');
  assertEqual(project.manifest.entries[0]?.id, `root-${token}`, 'project working directory manifest entry preserves root id');
  assertEqual(project.manifest.entries[0]?.kind, 'directory', 'project working directory manifest entry is a directory');
  assertEqual(project.manifest.entries[0]?.resourceRef, '.', 'project working directory manifest entry is root-relative');
  assertEqual(project.manifest.entries[0]?.rootId, `root-${token}`, 'project working directory manifest entry binds the relative root');
  assertEqual(project.manifest.entries[0]?.readPolicy, 'autoRead', 'project working directory manifest entry is auto-read');
  assertEqual(project.conversationRoots[0]?.rootId, `root-${token}`, 'project working directory remains a conversation root');
  assertEqual(project.conversationRoots[0]?.source, 'projectWorkingDirectory', 'project binding owns the primary root identity');
  assertEqual(project.manifest.projectId, `project-${token}`, 'project id is preserved in the resource manifest');
  assertEqual(project.manifest.projectRootStatus, 'ready', 'project root status is preserved in the resource manifest');
  assert(
    project.manifest.workspaceScopeKey.includes(`hash-${token}`),
    'project workspace binding contributes to the cache scope key'
  );
  const reboundProject = builder.build({
    sessionId: `session-${token}`,
    projectId: `project-${token}`,
    projectKind: 'folder',
    projectRootStatus: 'ready',
    workspaceBinding: {
      workspaceId: `workspace-${token}`,
      workspaceHash: `hash-rebound-${token}`,
      openPath: `/tmp/${token}/${randomSmokeToken('rebound')}`,
    },
  }, `manifest-rebound-${token}`);
  assert(
    reboundProject.manifest.workspaceScopeKey !== project.manifest.workspaceScopeKey,
    'project rebind changes the workspace cache scope and starts a new prompt epoch'
  );

  const temporaryRoot = `/tmp/${token}/${randomSmokeToken('temporary')}`;
  const projectWithTemporaryAttachment = builder.build({
    sessionId: `session-priority-${token}`,
    projectId: `project-priority-${token}`,
    projectKind: 'folder',
    projectRootStatus: 'ready',
    workspaceBinding: { workspaceHash: `priority-hash-${token}`, openPath: projectRoot },
    projectWorkingDirectory: {
      rootId: `root-priority-${token}`,
      label: `Project ${token}`,
      displayPath: projectRoot,
      absolutePath: projectRoot,
      source: 'projectWorkingDirectory',
    },
    attachments: [{
      kind: 'directory',
      path: temporaryRoot,
      absolutePath: temporaryRoot,
      source: 'userSelected',
      scope: 'message',
    }],
    acceptedTaskPlan: {
      executionRoot: {
        ref: temporaryRoot,
        attachment: {
          kind: 'directory',
          path: temporaryRoot,
          absolutePath: temporaryRoot,
          source: 'userSelected',
          scope: 'session',
        },
      },
    },
  }, `manifest-priority-${token}`);
  assertEqual(
    projectWithTemporaryAttachment.conversationRoots.find((root) => root.primary)?.absolutePath,
    projectRoot,
    'project root remains primary over accepted-task and attachment roots'
  );
  assertEqual(
    builder.kernelRunAttachments({
      sessionId: `session-priority-${token}`,
      projectWorkingDirectory: projectWithTemporaryAttachment.conversationRoots[0] as any,
      workspaceBinding: { openPath: projectRoot },
      attachments: [{
        kind: 'file',
        path: `${temporaryRoot}/note.txt`,
        absolutePath: `${temporaryRoot}/note.txt`,
        source: 'userSelected',
        scope: 'message',
      }],
    }).some((attachment) => attachment.absolutePath === projectRoot),
    false,
    'project root is carried by workspaceBinding instead of a synthetic attachment'
  );

  const editorRoot = `/tmp/${token}/${randomSmokeToken('editor')}`;
  const editor = builder.build({
    sessionId: `session-editor-${token}`,
    workspaceBinding: { openPath: editorRoot },
  }, `manifest-editor-${token}`);

  assertEqual(editor.manifest.entries.length, 1, 'editor workspace binding becomes an initial manifest entry');
  assertEqual(editor.manifest.entries[0]?.kind, 'directory', 'editor workspace manifest entry is a directory');
  assertEqual(editor.manifest.entries[0]?.resourceRef, '.', 'editor workspace manifest entry is root-relative');
  assertEqual(
    editor.manifest.entries[0]?.rootId,
    editor.manifest.entries[0]?.id,
    'editor workspace manifest entry binds its relative root'
  );
  assertEqual(editor.conversationRoots[0]?.source, 'workspaceBinding', 'editor workspace remains a conversation root');

  const deduped = builder.build({
    sessionId: `session-dedup-${token}`,
    projectWorkingDirectory: {
      rootId: `root-dedup-${token}`,
      label: `Project ${token}`,
      displayPath: projectRoot,
      absolutePath: projectRoot,
      source: 'projectWorkingDirectory',
    },
    workspaceBinding: { openPath: `${projectRoot}/` },
  }, `manifest-dedup-${token}`);

  assertEqual(deduped.manifest.entries.length, 1, 'project root and editor binding dedupe by normalized resource ref');
  assertEqual(deduped.conversationRoots.length, 1, 'deduped workspace root is not duplicated in conversation roots');
}

async function assertSessionDriverLoopPreResolvesProjectWorkspaceRoot(): Promise<void> {
  const token = randomSmokeToken('initial-root');
  const sessionId = `session-${token}`;
  const workspaceRoot = `/tmp/${token}/${randomSmokeToken('workspace')}`;
  const events: AgentEvent[] = [];
  const callOrder: string[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') {
        callOrder.push('kernel:runCreate');
        return fakeKernel(request);
      }
      if (command.kind === 'resourceResolve') {
        callOrder.push('kernel:resourceResolve');
        const manifest = command.request?.manifest as Record<string, any>;
        resourceResolveManifests.push(manifest);
        const entry = manifest.entries[0] ?? {};
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: `run-${token}`,
            sessionId,
            packet: {
              id: `packet-${token}`,
              workspaceScopeKey: manifest.workspaceScopeKey,
              requestId: command.requestId,
              manifestId: manifest.id,
              evidenceRefs: [`evidence-${token}`],
              summary: `workspace-bootstrap-${token}`,
              items: [{
                requestItemId: `item-${token}`,
                manifestEntryId: entry.id,
                readPolicy: 'autoRead',
                status: 'resolved',
                sourceKind: 'directory',
                contentKind: 'directoryTree',
                path: '.',
                absolutePath: entry.resourceRef,
                nodes: [{ type: 'file', path: `${randomSmokeToken('file')}.txt` }],
                evidenceRefs: [`evidence-${token}`],
              }],
            },
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      callOrder.push('llm');
      llmCalls += 1;
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: `Generic workspace root evidence was available for ${token}.` },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId,
    content: 'Summarize the generic project workspace.',
    projectWorkingDirectory: {
      rootId: `root-${token}`,
      label: `Workspace ${token}`,
      displayPath: workspaceRoot,
      absolutePath: workspaceRoot,
      source: 'projectWorkingDirectory',
    },
  });

  assertEqual(resourceResolveManifests.length, 1, 'project workspace root is resolved during run initialization');
  assertEqual(resourceResolveManifests[0]?.entries?.[0]?.kind, 'directory', 'initial resource resolve reads a directory root');
  assertEqual(resourceResolveManifests[0]?.entries?.[0]?.resourceRef, '.', 'initial resource resolve uses the relative project root');
  assertEqual(
    resourceResolveManifests[0]?.entries?.[0]?.rootId,
    `root-${token}`,
    'initial resource resolve binds the project root id'
  );
  assert(
    callOrder.indexOf('kernel:resourceResolve') > callOrder.indexOf('kernel:runCreate') &&
    callOrder.indexOf('kernel:resourceResolve') < callOrder.indexOf('llm'),
    'workspace root ResourceResolve runs after runCreate and before the first provider call'
  );
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'initial root evidence is projected as a resource tool result');
}

async function assertSessionDriverLoopSuppressesPlanningNativeReadToolsAfterInitialEvidence(): Promise<void> {
  const token = randomSmokeToken('planning-tool-policy');
  const sessionId = `session-${token}`;
  const workspaceRoot = `/tmp/${token}/${randomSmokeToken('workspace')}`;
  const events: AgentEvent[] = [];
  const llmRequests: LlmChatRequest[] = [];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        const manifest = command.request?.manifest as Record<string, any>;
        const entry = manifest.entries[0] ?? {};
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: `run-${token}`,
            sessionId,
            packet: {
              id: `packet-${token}`,
              workspaceScopeKey: manifest.workspaceScopeKey,
              requestId: command.requestId,
              manifestId: manifest.id,
              evidenceRefs: [`evidence-${token}`],
              summary: `workspace-bootstrap-${token}`,
              items: [{
                requestItemId: `item-${token}`,
                manifestEntryId: entry.id,
                readPolicy: 'autoRead',
                status: 'resolved',
                sourceKind: 'directory',
                contentKind: 'directoryTree',
                path: '.',
                absolutePath: entry.resourceRef,
                nodes: [{ type: 'file', path: `${randomSmokeToken('file')}.txt` }],
                evidenceRefs: [`evidence-${token}`],
              }],
            },
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      assertEqual(Array.isArray(request.tools), true, 'planning provider request carries an explicit tools list');
      assertEqual(request.tools?.length ?? -1, 0, 'planning provider hides native read tools after initial ResourceEvidence');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: `Generic planning used existing evidence for ${token}.` },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmRequests.length + 1}`,
  });

  await loop.runUserTurn({
    sessionId,
    content: 'Plan from the current generic workspace evidence.',
    projectWorkingDirectory: {
      rootId: `root-${token}`,
      label: `Workspace ${token}`,
      displayPath: workspaceRoot,
      absolutePath: workspaceRoot,
      source: 'projectWorkingDirectory',
    },
  });

  assertEqual(llmRequests.length, 1, 'planning turn completes without a native read tool resume');
}

async function assertResourceOrchestratorResolvesAndRecordsPackets(): Promise<void> {
  const token = randomSmokeToken('resource-orchestrator');
  const childFile = `child-${randomSmokeToken('file')}.txt`;
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const manifest: ResourceManifest = {
    id: `manifest-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    entries: [{
      id: `entry-${token}`,
      kind: 'directory',
      label: `Directory ${token}`,
      resourceRef: `/tmp/root-${token}`,
      readPolicy: 'autoRead',
      reason: `reason-${token}`,
    }],
    budget: { maxEntries: 20, maxBytes: 4096 },
    defaultDenyPatterns: [],
  };
  const state = {
    sessionId,
    runId,
    manifest,
    resourcePackets: [] as ResourcePacket[],
  };
  const appended: AgentEvent[][] = [];
  const orchestrator = new ResourceOrchestrator({
    resourceRequestLoop: new ResourceRequestLoop({ maxDerivedManifestEntries: 20 }),
    runtime: {
      kernel: async (request) => {
        assertEqual((request.command as any).kind, 'resourceResolve', 'resource orchestrator submits resourceResolve commands');
        assertEqual((request.command as any).runId, runId, 'resource orchestrator carries run id');
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId,
            packet: {
              id: `packet-${token}`,
              workspaceScopeKey: `workspace-${token}`,
              requestId: `request-${token}`,
              manifestId: manifest.id,
              evidenceRefs: [`evidence-${token}`],
              summary: `directory-${token}`,
              items: [{
                requestItemId: `item-${token}`,
                manifestEntryId: `entry-${token}`,
                status: 'resolved',
                readPolicy: 'autoRead',
                sourceKind: 'directory',
                contentKind: 'directoryTree',
                absolutePath: `/tmp/root-${token}`,
                nodes: [{ path: childFile, type: 'file' }],
                evidenceRefs: [`evidence-${token}`],
              }],
            },
          }],
        };
      },
      append: async (appendSessionId, events) => {
        appended.push(events);
        return {
          session: {
            id: appendSessionId,
            mode: 'plan',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } satisfies AgentSession,
          events,
        };
      },
      id: (prefix) => `${prefix}-${token}`,
      ts: () => '2026-01-01T00:00:00.000Z',
    },
    createError: (code, message) => Object.assign(new Error(message), { code }),
  });
  const output = await orchestrator.resolveRecordAndAppend(state, manifest, 'resource-context');
  assertEqual(output.packet.id, `packet-${token}`, 'resource orchestrator returns resolved packet');
  assertEqual(state.resourcePackets.length, 1, 'resource orchestrator records packet in state');
  assert(
    state.manifest.entries.some((entry) => entry.resourceRef.endsWith(childFile)),
    'resource orchestrator discovers directory children into manifest'
  );
  assertEqual(output.event.kind, 'tool_result', 'resource orchestrator creates packet projection event');
  assertEqual(appended[0]?.[0]?.id, `resource-context-${token}`, 'resource orchestrator appends packet event through runtime');
}

async function assertAcceptedPlanResourceResumeCoordinatorBuildsProviderTurn(): Promise<void> {
  const token = randomSmokeToken('resource-resume');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const repairBuilder = new ProviderRepairMessageBuilder();
  const coordinator = new AcceptedPlanResourceResumeCoordinator({
    promptBuilder: new AcceptedPlanResourceResumePromptBuilder(repairBuilder),
    contextFrameBuilder: new ContextFrameBuilder(),
    repairMessageBuilder: repairBuilder,
    repairState: (state) => ({
      runId: state.runId,
      userRequest: state.userRequest,
      conversationRoots: [],
      resourcePackets: state.resourcePackets,
      acceptedContext: {},
      currentTaskContext: state.currentTaskContext,
      completedTaskCount: state.acceptedTaskPlan?.completedTaskIds.length,
    }),
    createId: (prefix) => `${prefix}-${token}`,
    parseError: (error) => error instanceof Error
      ? { code: 'error', message: error.message }
      : { code: 'error', message: String(error) },
    createError: (code, message) => Object.assign(new Error(message), { code }),
    appendRepairNotice: async () => {
      throw new Error('resource resume coordinator should not repair valid provider output');
    },
    parseProviderProposal: ({ raw, state }) => parseProposalEnvelope({
      raw,
      runId: state.runId,
      sessionId: state.sessionId,
      source: 'llm',
    }),
    parseRepairedProviderProposal: ({ raw, state }) => parseProposalEnvelope({
      raw,
      runId: state.runId,
      sessionId: state.sessionId,
      source: 'llm',
    }),
  });
  const prompt = smokePromptEnvelope(`stable-${token}`);
  const packet = {
    id: `packet-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    requestId: `request-${token}`,
    items: [{
      requestItemId: `item-${token}`,
      manifestEntryId: `entry-${token}`,
      status: 'resolved',
      contentKind: 'fileText',
      path: `target-${token}.txt`,
      text: `content-${token}`,
    }],
  } as unknown as ResourcePacket;
  const state = {
    sessionId,
    runId,
    userRequest: `request-${token}`,
    acceptedTaskPlan: {
      planId: `plan-${token}`,
      runId,
      tasks: [{ taskId: `task-${token}`, targets: [], dependencies: [], planningArgs: {}, conflictKeys: [] }],
      authorizationOperations: [],
      toolIds: [],
      targetScopes: [],
      batchIndex: 1,
      completedTaskIds: [],
      dependencyFacts: [],
      rawPlan: {},
    } as AcceptedTaskPlanContext,
    taskExecutionCursor: {
      cursorId: `cursor-${token}`,
      planId: `plan-${token}`,
      currentTaskId: `task-${token}`,
      taskOrder: [`task-${token}`],
      pendingTaskIds: [`task-${token}`],
      completedTaskIds: [],
      lastResourcePacketIds: [packet.id],
    },
    currentTaskContext: {
      goal: `goal-${token}`,
      taskId: `task-${token}`,
      targets: [`target-${token}.txt`],
      toolIds: ['fs.read'],
      taskOrder: [`task-${token}`],
      pendingTaskIds: [`task-${token}`],
      dependsOn: [],
      evidenceNeeds: [],
      completedTaskIds: [],
    },
    resourcePackets: [packet],
    generatedArtifactEvidence: { size: 0 },
  };
  let observedStage = '';
  let observedMessages: LlmChatRequest['messages'] = [];
  const proposal = await coordinator.run({
    state,
    prompt,
    userRequest: state.userRequest,
    requestProposal: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-${token}`,
      runId,
      sessionId,
      source: 'llm',
      kind: 'resourceRequest',
      payload: {
        version: '1',
        id: `resource-request-${token}`,
        items: [],
      },
    } as ProposalEnvelope,
    packet,
    callProposalOnly: async ({ contract, stage, messages }) => {
      observedStage = stage;
      observedMessages = messages;
      assertEqual(contract.turnMode, 'resourceResume', 'resource resume coordinator builds resourceResume contract');
      assert(
        contract.nextActionInstruction.summary?.includes('ResourcePacket'),
        'resource resume coordinator keeps NextActionInstruction explicit'
      );
      return JSON.stringify({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'diagnostic',
        proposalId: `diagnostic-${token}`,
        diagnostic: {
          summary: `summary-${token}`,
        },
      });
    },
    runRepair: async () => {
      throw new Error('resource resume coordinator should not run repair for valid provider output');
    },
  });
  assertEqual(observedStage, 'accepted_plan_resource_resume', 'resource resume coordinator uses stable provider stage');
  assertEqual(observedMessages[0]?.role, 'system', 'resource resume coordinator sends stable prefix as system message');
  const resumeUserPrompt = observedMessages.find((message) => message.role === 'user')?.content ?? '';
  assert(
    resumeUserPrompt.includes('Return exactly one Agent Protocol v4 proposal: actionBundle, resourceRequest, decisionRequest, taskOutcome, diagnostic.'),
    'resource resume prompt aligns provider-visible allowed kinds with driver parsing'
  );
  assert(
    !resumeUserPrompt.includes('taskOutcome, answer'),
    'resource resume prompt does not expose answer as an execution-stage output'
  );
  assert(
    resumeUserPrompt.includes('Use the ProviderTurnContract above as the schema authority.'),
    'resource resume prompt delegates schema details to ProviderTurnContract'
  );
  assert(
    resumeUserPrompt.includes('Carrier fields by kind: actionBundle uses userPlanMarkdown/contentBlocks/actionBundle; resourceRequest uses resourceRequest; taskOutcome uses taskOutcome; decisionRequest uses decisionRequest; diagnostic uses diagnostic.'),
    'resource resume prompt keeps only compact carrier guidance'
  );
  assert(
    !resumeUserPrompt.includes('fs.write actions must use args={path,contentBlockId}'),
    'resource resume prompt does not duplicate full actionBundle protocol details'
  );
  assert(
    !resumeUserPrompt.includes('resourceRequest field must be shaped'),
    'resource resume prompt does not duplicate full resourceRequest protocol details'
  );
  assert(
    resumeUserPrompt.includes('ProviderTurnContract:'),
    'resource resume prompt is rendered through the shared ProviderTurnContract prompt renderer'
  );
  assert(
    resumeUserPrompt.includes('"turnMode": "resourceResume"'),
    'resource resume prompt exposes the driver ProviderTurnContract turn mode'
  );
  assertEqual(
    (state as { providerTurnFrame?: { turnMode?: string } }).providerTurnFrame?.turnMode,
    'resourceResume',
    'resource resume coordinator stores provider turn contract on state'
  );
  assertEqual(
    (state as { modelContextBundle?: { providerTurnContract?: { turnMode?: string } } }).modelContextBundle?.providerTurnContract?.turnMode,
    'resourceResume',
    'resource resume coordinator stores ModelContextBundle on state'
  );
  assertEqual(
    (state as { providerTurnFrame?: { snapshot?: { finalUserPromptCharLength?: number } } }).providerTurnFrame?.snapshot?.finalUserPromptCharLength,
    resumeUserPrompt.length,
    'resource resume snapshot tracks the actual final user prompt length'
  );
  assertEqual(proposal.kind, 'diagnostic', 'resource resume coordinator parses provider proposal');
}

async function assertResourceRequestProposalHandlerContinuesThroughRunEngine(): Promise<void> {
  const token = randomSmokeToken('accepted-resource-task-outcome');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const taskId = `task-${token}`;
  const targetPath = `target-${randomSmokeToken('file')}.txt`;
  const fallback = genericSessionResult(sessionId);
  const appendResult = genericSessionResult(sessionId);
  const resumeAppendResult = genericSessionResult(sessionId);
  const packet: ResourcePacket = {
    id: `packet-${token}`,
    requestId: `request-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    items: [{
      requestItemId: `item-${token}`,
      manifestEntryId: `entry-${token}`,
      readPolicy: 'autoRead',
      status: 'resolved',
      contentKind: 'fileText',
      path: targetPath,
      contentSummary: `content-${token}`,
    }],
  };
  const state = {
    sessionId,
    runId,
    workspaceScopeKey: `workspace-${token}`,
    manifest: {
      id: `manifest-${token}`,
      workspaceScopeKey: `workspace-${token}`,
      entries: [{
        id: `entry-${token}`,
        kind: 'file',
        label: targetPath,
        resourceRef: targetPath,
        readPolicy: 'autoRead',
        reason: `reason-${token}`,
      }],
      budget: { maxEntries: 10, maxBytes: 1024 },
      defaultDenyPatterns: [],
    } as ResourceManifest,
    conversationRoots: [],
    resourcePackets: [],
    generatedArtifactEvidence: new Map(),
    acceptedTaskPlan: {
      planId: `plan-${token}`,
      runId,
      tasks: [{
        taskId,
        targets: [targetPath],
        toolId: 'fs.write',
        dependencies: [],
        planningArgs: {},
        conflictKeys: [],
      }],
      authorizationOperations: [{
        operationId: `plan-op-${taskId}-1`,
        sourceTaskId: taskId,
        toolId: 'fs.write',
        operationKind: 'fsWrite',
        contentMode: 'contentBlock',
        targets: [targetPath],
        dependsOn: [],
        fixedArgs: {},
        argsTemplate: { path: targetPath, contentBlockId: 'executionTime' },
        targetResourceKind: 'file',
        recursive: false,
        internal: false,
      }],
      toolIds: ['fs.write'],
      targetScopes: [targetPath],
      batchIndex: 1,
      completedTaskIds: [],
      dependencyFacts: [],
      rawPlan: {},
    } as AcceptedTaskPlanContext,
    taskExecutionCursor: { currentTaskId: taskId },
    currentTaskContext: {
      taskId,
      goal: `Task already satisfied ${token}`,
      targets: [targetPath],
      toolIds: ['fs.write'],
    },
    resourceRequestRepairAttempted: false,
    resourceRequestProgressByTask: new Map(),
    semanticDirectiveErrorSummary: undefined as string | undefined,
  };
  let resolveCalls = 0;
  const handler = new ResourceRequestProposalHandler<any, any>({
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${token}`,
    append: async () => resumeAppendResult,
    generatedPacketForRequest: (_state, request) => ({ remaining: request }),
    recordAndAppend: async () => ({ packet, event: {} as AgentEvent, result: appendResult }),
    resolveRecordAndAppend: async () => {
      resolveCalls += 1;
      return { packet, event: {} as AgentEvent, result: appendResult };
    },
    resolveResourceRequest: (manifest) => ({
      manifest,
      unresolved: [],
      ambiguous: [],
      availableRoots: [],
    }),
    finalDiagnosticEvent: () => ({} as AgentEvent),
    internalFailureEvents: () => [],
    resourceResolutionDiagnostic: () => ({ code: 'unexpected', fallback: 'unexpected' }),
    completeResourceSemanticExchange: async () => undefined,
    refreshTaskRuntimeState: () => undefined,
    acceptedPlanResourceResumeEvent: () => ({
      id: `resume-${token}`,
      kind: 'workflow_stage',
      sessionId,
      ts: '2026-01-01T00:00:00.000Z',
      payload: { stage: 'accepted_plan.resource_resume', runId },
    } as AgentEvent),
  });

  const result = await handler.handle({
    input: { sessionId, content: `request-${token}` },
    state,
    prompt: smokePromptEnvelope(`stable-${token}`),
    proposal: parseProposalEnvelope({
      runId,
      sessionId,
      raw: JSON.stringify({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'resourceRequest',
        outputLanguage: 'en-US',
        resourceRequest: {
          version: '1',
          id: `request-${token}`,
          items: [{ id: `item-${token}`, kind: 'file', path: targetPath, reason: `reason-${token}` }],
        },
      }),
    }),
    lastResult: fallback,
  });

  assertEqual(result.kind, 'continue', 'accepted resource result returns control to the single RunEngine loop');
  assertEqual(result.kind === 'continue' ? result.lastResult : undefined, resumeAppendResult, 'RunEngine continuation keeps the latest accepted-plan resume append result');
  assertEqual(state.resourceRequestProgressByTask.get(taskId)?.signatures.length, 1, 'resolved resource signature is recorded for the active task');
  assertEqual(state.resourceRequestProgressByTask.get(taskId)?.packetIds.includes(packet.id), true, 'resolved resource packet is attributed to the active task');

  const redirected = await handler.handle({
    input: { sessionId, content: `repeat-${token}` },
    state,
    prompt: smokePromptEnvelope(`stable-repeat-${token}`),
    proposal: parseProposalEnvelope({
      runId,
      sessionId,
      raw: JSON.stringify({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'resourceRequest',
        outputLanguage: 'en-US',
        resourceRequest: {
          version: '1',
          id: `repeat-request-${token}`,
          items: [{ id: `repeat-item-${token}`, kind: 'file', path: targetPath, reason: `repeat-reason-${token}` }],
        },
      }),
    }),
    lastResult: fallback,
  });
  assertEqual(redirected.kind, 'continue', 'duplicate resource request redirects through the main loop');
  assertEqual(resolveCalls, 1, 'duplicate resource request does not issue a second Kernel resource command');
  assertEqual(state.semanticDirectiveErrorSummary?.includes('session_resource_no_progress'), true, 'resource no-progress redirect records the structured failure code');

  const terminated = await handler.handle({
    input: { sessionId, content: `repeat-again-${token}` },
    state,
    prompt: smokePromptEnvelope(`stable-repeat-again-${token}`),
    proposal: parseProposalEnvelope({
      runId,
      sessionId,
      raw: JSON.stringify({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'resourceRequest',
        outputLanguage: 'en-US',
        resourceRequest: {
          version: '1',
          id: `repeat-again-request-${token}`,
          items: [{ id: `repeat-again-item-${token}`, kind: 'file', path: targetPath, reason: `repeat-again-reason-${token}` }],
        },
      }),
    }),
    lastResult: fallback,
  });
  assertEqual(terminated.kind, 'return', 'duplicate resource loop terminates after one controlled redirect');
  assertEqual(resolveCalls, 1, 'resource no-progress termination does not issue another Kernel resource command');
}

async function assertResourceRequestRepairCoordinatorRepairsProposal(): Promise<void> {
  const token = randomSmokeToken('resource-request-repair');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const repairBuilder = new ProviderRepairMessageBuilder();
  const coordinator = new ResourceRequestRepairCoordinator({
    repairMessageBuilder: repairBuilder,
    contextFrameBuilder: new ContextFrameBuilder(),
    repairState: (state) => ({
      runId: state.runId,
      userRequest: state.userRequest,
      conversationRoots: [],
      resourcePackets: [],
    }),
    createId: (prefix) => `${prefix}-${token}`,
    parseError: (error) => error instanceof Error
      ? { code: 'error', message: error.message }
      : { code: 'error', message: String(error) },
    createError: (code, message) => Object.assign(new Error(message), { code }),
    parseRepairedProposal: ({ raw, state, allowedKinds }) => {
      assert(
        allowedKinds.includes('resourceRequest') && allowedKinds.includes('decisionRequest') && allowedKinds.includes('diagnostic'),
        'resource request repair coordinator preserves repair allowed kinds'
      );
      return parseProposalEnvelope({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    },
  });
  const prompt = smokePromptEnvelope(`stable-${token}`);
  const state = {
    sessionId,
    runId,
    userRequest: `request-${token}`,
  };
  let observedStage = '';
  let observedMessages: LlmChatRequest['messages'] = [];
  const proposal = await coordinator.repair({
    state,
    prompt,
    proposal: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-${token}`,
      runId,
      sessionId,
      source: 'llm',
      kind: 'resourceRequest',
      payload: {
        version: '1',
        id: `request-${token}`,
        items: [{
          id: `item-${token}`,
          path: `missing-${token}`,
        }],
      },
    } as ProposalEnvelope,
    resolutionDiagnostic: `unresolved-${token}`,
    runRepair: async (stage, messages) => {
      observedStage = stage;
      observedMessages = messages;
      return JSON.stringify({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'diagnostic',
        proposalId: `diagnostic-${token}`,
        diagnostic: {
          summary: `summary-${token}`,
        },
      });
    },
  });
  assertEqual(observedStage, 'resource_request_repair', 'resource request repair coordinator uses stable repair stage');
  assertEqual(observedMessages[0]?.role, 'system', 'resource request repair coordinator sends system repair contract');
  const resourceRepairPrompt = observedMessages.find((message) => message.role === 'user')?.content ?? '';
  assert(
    resourceRepairPrompt.includes('ProviderTurnContract:') && resourceRepairPrompt.includes('"turnMode": "protocolRepair"'),
    'resource request repair coordinator renders side-call ProviderTurnContract'
  );
  assertEqual(
    (state as { modelContextBundle?: { providerTurnContract?: { turnMode?: string } } }).modelContextBundle?.providerTurnContract?.turnMode,
    'protocolRepair',
    'resource request repair coordinator stores ModelContextBundle on state'
  );
  assertEqual(proposal.kind, 'diagnostic', 'resource request repair coordinator parses repaired proposal');
}

async function assertActionBundleAdmissionRepairCoordinatorRepairsProposal(): Promise<void> {
  const token = randomSmokeToken('admission-repair');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const repairBuilder = new ProviderRepairMessageBuilder();
  const coordinator = new ActionBundleAdmissionRepairCoordinator({
    repairMessageBuilder: repairBuilder,
    contextFrameBuilder: new ContextFrameBuilder(),
    repairState: (state) => ({
      runId: state.runId,
      userRequest: state.userRequest,
      conversationRoots: [],
      resourcePackets: [],
    }),
    createId: (prefix) => `${prefix}-${token}`,
    parseError: (error) => error instanceof Error
      ? { code: 'error', message: error.message }
      : { code: 'error', message: String(error) },
    createError: (code, message) => Object.assign(new Error(message), { code }),
    parseRepairedProposal: ({ raw, state, allowedKinds }) => {
      assert(
        allowedKinds.includes('taskPlan')
          && allowedKinds.includes('resourceRequest')
          && allowedKinds.includes('decisionRequest')
          && allowedKinds.includes('diagnostic'),
        'action bundle admission repair coordinator preserves admission repair allowed kinds'
      );
      assert(
        !allowedKinds.includes('actionBundle'),
        'action bundle admission repair coordinator preserves current admission repair gate'
      );
      return parseProposalEnvelope({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    },
  });
  const prompt = smokePromptEnvelope(`stable-${token}`);
  const state = {
    sessionId,
    runId,
    userRequest: `request-${token}`,
  };
  let observedStage = '';
  let observedMessages: LlmChatRequest['messages'] = [];
  const proposal = await coordinator.repair({
    state,
    prompt,
    proposal: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-${token}`,
      runId,
      sessionId,
      source: 'llm',
      kind: 'actionBundle',
      payload: {
        actionBundle: {
          version: '1',
          id: `bundle-${token}`,
          actions: [],
        },
      },
    } as ProposalEnvelope,
    reasons: [`reason-${token}`],
    runRepair: async (stage, messages) => {
      observedStage = stage;
      observedMessages = messages;
      return JSON.stringify({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'diagnostic',
        proposalId: `diagnostic-${token}`,
        diagnostic: {
          summary: `summary-${token}`,
        },
      });
    },
  });
  assertEqual(observedStage, 'action_bundle_admission_repair', 'action bundle admission repair coordinator uses stable repair stage');
  assertEqual(observedMessages[0]?.role, 'system', 'action bundle admission repair coordinator sends system repair contract');
  const admissionRepairPrompt = observedMessages.find((message) => message.role === 'user')?.content ?? '';
  assert(
    admissionRepairPrompt.includes('ProviderTurnContract:') && admissionRepairPrompt.includes('"turnMode": "protocolRepair"'),
    'action bundle admission repair coordinator renders side-call ProviderTurnContract'
  );
  assertEqual(
    (state as { modelContextBundle?: { providerTurnContract?: { turnMode?: string } } }).modelContextBundle?.providerTurnContract?.turnMode,
    'protocolRepair',
    'action bundle admission repair coordinator stores ModelContextBundle on state'
  );
  assertEqual(proposal.kind, 'diagnostic', 'action bundle admission repair coordinator parses repaired proposal');
}

async function assertActionBundleAdmissionResourceFollowupCoordinatorHandlesResourceRequests(): Promise<void> {
  const token = randomSmokeToken('admission-followup');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const manifest: ResourceManifest = {
    id: `manifest-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    entries: [],
    budget: { maxEntries: 16, maxBytes: 4096 },
    defaultDenyPatterns: [],
  };
  const request: ResourceRequestDraft = {
    version: '1',
    id: `request-${token}`,
    reason: `reason-${token}`,
    items: [{ id: `item-${token}`, path: `generated-${token}.txt`, reason: `item-reason-${token}` }],
  };
  const packet = {
    id: `packet-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    requestId: `request-${token}`,
    items: [],
  } as ResourcePacket;
  const initialResult = { events: [{ id: `initial-${token}` }] } as AgentSessionResult;
  const appendedResult = { events: [{ id: `appended-${token}` }] } as AgentSessionResult;
  const state = {
    sessionId,
    runId,
    workspaceScopeKey: `workspace-${token}`,
    manifest,
    conversationRoots: [],
    resourcePackets: [],
    generatedArtifactEvidence: new Map(),
  };
  let recordedPacketId = '';
  const coordinator = new ActionBundleAdmissionResourceFollowupCoordinator({
    generatedEvidence: {
      packetForRequest: (_state, _request, packetId) => {
        recordedPacketId = packetId;
        return { packet, remaining: { version: '1', id: `remaining-${token}`, reason: `remaining-${token}`, items: [] } };
      },
    },
    resolver: {
      resolve: (currentManifest, remaining) => {
        assertEqual(currentManifest.id, manifest.id, 'admission follow-up resolves against current manifest');
        assertEqual(remaining.id, `remaining-${token}`, 'admission follow-up resolves remaining request only');
        return {
          manifest: {
            id: `subset-${token}`,
            workspaceScopeKey: `workspace-${token}`,
            entries: [],
            budget: { maxEntries: 16, maxBytes: 4096 },
            defaultDenyPatterns: [],
          },
          unresolved: [],
          ambiguous: [],
          availableRoots: [],
        };
      },
    },
    resourceLoop: {
      resolutionDiagnostic: () => ({ fallback: `diagnostic-${token}` }),
    },
    orchestrator: {
      recordAndAppend: async (_state, nextPacket, eventIdPrefix) => {
        assertEqual(nextPacket.id, packet.id, 'admission follow-up records generated packet');
        assertEqual(eventIdPrefix, 'action-bundle-admission-generated-resource-context', 'admission follow-up uses stable generated resource event prefix');
        return { result: appendedResult };
      },
      resolveRecordAndAppend: async () => {
        throw new Error('generated admission follow-up should not resolve an empty remaining manifest');
      },
    },
    createId: (prefix) => `${prefix}-${token}`,
    appendFailure: async () => {
      throw new Error('generated admission follow-up should not append a failure');
    },
    followupRequest: ({ runId: nextRunId, reasons }) => `followup-${nextRunId}-${reasons[0]}`,
  });
  const resume = await coordinator.handle({
    state,
    proposal: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-${token}`,
      runId,
      sessionId,
      source: 'llm',
      kind: 'actionBundle',
      payload: {},
    } as ProposalEnvelope,
    request,
    reasons: [`reason-${token}`],
    result: initialResult,
  });
  assertEqual(recordedPacketId, `action-bundle-admission-generated-resource-${token}`, 'admission follow-up creates generated packet id');
  assertEqual(resume.kind, 'resume', 'admission follow-up resumes after generated evidence');
  if (resume.kind === 'resume') {
    assertEqual(resume.result, appendedResult, 'admission follow-up returns latest appended result');
    assertEqual(resume.content, `followup-${runId}-reason-${token}`, 'admission follow-up builds resume content');
  }

  let failureReason = '';
  const failureResult = { events: [{ id: `failure-${token}` }] } as AgentSessionResult;
  const failureCoordinator = new ActionBundleAdmissionResourceFollowupCoordinator({
    generatedEvidence: {
      packetForRequest: () => ({ remaining: request }),
    },
    resolver: {
      resolve: () => ({
        manifest: {
          id: `empty-${token}`,
          workspaceScopeKey: `workspace-${token}`,
          entries: [],
          budget: { maxEntries: 16, maxBytes: 4096 },
          defaultDenyPatterns: [],
        },
        unresolved: [`missing-${token}`],
        ambiguous: [],
        availableRoots: [],
      }),
    },
    resourceLoop: {
      resolutionDiagnostic: () => ({ fallback: `missing-${token}` }),
    },
    orchestrator: {
      recordAndAppend: async () => {
        throw new Error('unresolved admission follow-up should not record packets');
      },
      resolveRecordAndAppend: async () => {
        throw new Error('unresolved admission follow-up should not resolve packets');
      },
    },
    createId: (prefix) => `${prefix}-${token}`,
    appendFailure: async ({ reasons }) => {
      failureReason = reasons[0] ?? '';
      return failureResult;
    },
    followupRequest: () => `unused-${token}`,
  });
  const failed = await failureCoordinator.handle({
    state,
    proposal: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `failed-${token}`,
      runId,
      sessionId,
      source: 'llm',
      kind: 'actionBundle',
      payload: {},
    } as ProposalEnvelope,
    request,
    reasons: [`reason-${token}`],
    result: initialResult,
  });
  assertEqual(failed.kind, 'failed', 'admission follow-up fails when resource request remains unresolved');
  assert(failureReason.includes(`missing-${token}`), 'admission follow-up failure includes resource diagnostic');
}

function assertResourceEvidenceIndexQueriesPackets(): void {
  const token = randomSmokeToken('evidence');
  const packet = {
    id: `evidence-packet-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    requestId: `request-${token}`,
    items: [
      {
        requestItemId: `item-${token}`,
        manifestEntryId: `entry-${token}`,
        readPolicy: 'autoRead',
        status: 'resolved',
        contentKind: 'fileText',
        path: `root-${token}/src-${token}/file-${token}.txt`,
        promptContent: `first line ${token}\r\nsecond line ${token}`,
      },
    ],
  } as unknown as ResourcePacket;
  const index = new ResourceEvidenceIndex({
    normalizeTarget: (value) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, ''),
    clip: (value, maxChars) => value.slice(0, maxChars),
  });
  const target = `./src-${token}/file-${token}.txt`;
  assert(index.mentionsAnyTarget([packet], [target]), 'resource evidence index matches target suffixes');
  assert(
    index.containsExactBlock([packet], [target], `first line ${token}\nsecond line ${token}`),
    'resource evidence index matches exact text after line ending normalization'
  );
  assert(index.existsForTarget([packet], target), 'resource evidence index detects evidence for target');
  assert(
    index.textForTarget([packet], target)?.includes(`second line ${token}`),
    'resource evidence index returns target text'
  );
  assert(
    index.relevantForTargets([packet], [target]).some((line) => line.includes(`file-${token}.txt`)),
    'resource evidence index renders relevant evidence summaries'
  );
}

function assertGeneratedArtifactEvidenceIndexBuildsRunLocalPackets(): void {
  const token = randomSmokeToken('generated-evidence');
  const targetPath = `generated-${token}/artifact-${randomSmokeToken('file')}.txt`;
  const actionId = `action-${token}`;
  const content = `content-${randomSmokeToken('content')}`;
  const toolCallId = `call-${token}`;
  const index = new GeneratedArtifactEvidenceIndex({
    normalizeRelativePath: (value) => value?.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, ''),
    comparablePath: (value) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, ''),
  });
  const state = {
    workspaceScopeKey: `workspace-${token}`,
    conversationRoots: [
      {
        rootId: `root-${token}`,
        label: `Root ${token}`,
        displayPath: `/tmp/root-${token}`,
        absolutePath: `/tmp/root-${token}`,
        source: 'currentAttachment' as const,
        primary: true,
        kind: 'directory' as const,
      },
    ],
    generatedArtifactEvidence: new Map(),
  };
  const generatedPacket = index.packetFromSuccessfulBatch(
    state,
    {},
    [completedKernelToolFact({
      runId: `run-${token}`,
      sessionId: `session-${token}`,
      workUnitId: `work-${token}`,
      toolCallId,
      toolId: 'fs.write',
      path: targetPath,
      content,
    })],
    `packet-${token}`
  );
  assertEqual(generatedPacket, undefined, 'generated artifact facts do not synthesize a Session resource packet');
  const generatedEvidence = state.generatedArtifactEvidence.get(targetPath);
  assertEqual(generatedEvidence?.targetPath, targetPath, 'generated artifact index records Kernel target path');
  assertEqual(
    generatedEvidence?.toolCallId,
    toolCallId,
    'generated artifact index records the Kernel tool fact reference'
  );
  assert(
    state.generatedArtifactEvidence.has(targetPath),
    'generated artifact index stores generated evidence under comparable path'
  );
  const replay = index.packetForRequest(
    state,
    {
      version: '1',
      id: `request-${token}`,
      reason: `read generated artifact ${token}`,
      items: [
        {
          id: `item-${token}`,
          kind: 'file',
          path: targetPath,
          reason: `read generated artifact ${token}`,
        },
      ],
    },
    `replay-${token}`
  );
  assertEqual(replay.remaining.items.length, 1, 'generated artifact requests continue through Kernel ResourceResolve');
  assertEqual(replay.packet, undefined, 'Session does not synthesize generated artifact content');

  index.indexPacket(state.generatedArtifactEvidence, {
    id: `resolved-${token}`,
    workspaceScopeKey: state.workspaceScopeKey,
    requestId: `request-${token}`,
    items: [
      {
        requestItemId: `item-${token}`,
        manifestEntryId: `entry-${token}`,
        readPolicy: 'autoRead',
        status: 'resolved',
        contentKind: 'fileText',
        path: targetPath,
        promptContent: content,
        contentHash: `hash-${toolCallId}`,
      },
    ],
  } as ResourcePacket);
  assertEqual(
    state.generatedArtifactEvidence.get(targetPath)?.content,
    content,
    'Kernel ResourcePacket content enriches the generated artifact fact reference'
  );
}

function assertImplementationBatchContextBuilderExtractsConcreteContinuations(): void {
  const token = randomSmokeToken('implementation-batch');
  const targetPath = `scope-${token}/target-${randomSmokeToken('file')}.txt`;
  const builder = new ImplementationBatchContextBuilder({
    concreteFileOperationTarget: (value) => value && !value.includes('*') ? value : undefined,
  });
  const context = builder.build([
    {
      id: `plan-a-${token}`,
      sessionId: `session-${token}`,
      kind: 'plan_card',
      ts: '2026-01-01T00:00:00.000Z',
      payload: {
        summary: `summary-a-${token}`,
        actionBundle: {
          continuationExpectations: [
            {
              id: `continue-${token}`,
              description: `continue-${token}`,
              target: [targetPath],
            },
            {
              id: `skip-${token}`,
              description: `skip-${token}`,
              target: ['*.tmp'],
            },
          ],
        },
      },
    },
    {
      id: `plan-b-${token}`,
      sessionId: `session-${token}`,
      kind: 'plan_card',
      ts: '2026-01-01T00:00:01.000Z',
      payload: {
        content: `summary-b-${token}`,
      },
    },
  ]);
  assertEqual(context.batchIndex, 3, 'implementation batch context counts prior plan cards');
  assert(
    context.recentPlanSummaries.some((summary) => summary.includes(`summary-b-${token}`)),
    'implementation batch context keeps recent plan summary'
  );
  assert(
    context.continuationSummaries.some((summary) => summary.includes(targetPath)),
    'implementation batch context keeps concrete continuation scope'
  );
  assert(
    !context.continuationSummaries.some((summary) => summary.includes(`skip-${token}`)),
    'implementation batch context ignores non-concrete continuation scope'
  );
}

function assertRepairLoopBuildsPlanRevisionRequest(): void {
  const token = randomSmokeToken('repair-loop');
  const repairLoop = new RepairLoop();
  const revisionRequest = repairLoop.planRevisionRequest({
    plan: {
      userPlan: `Plan body ${token}`,
      planReviewReport: { reportId: `report-${token}` },
    },
    guidance: `Plan revision ${token}`,
  });
  assert(revisionRequest.includes(`Plan revision ${token}`), 'repair loop plan revision request keeps guidance');
  assert(revisionRequest.includes(`Plan body ${token}`), 'repair loop plan revision request keeps previous plan');
  assert(revisionRequest.includes(`report-${token}`), 'repair loop plan revision request keeps review report context');
  assert(revisionRequest.includes('Do not return actionBundle'), 'repair loop plan revision request keeps execution boundary');
}

function assertCompletedWorkUnitFactIndexMatchesActionAndTarget(): void {
  const token = randomSmokeToken('completed-work-unit');
  const actionId = `action-${token}`;
  const targetPath = `scope-${token}/target-${randomSmokeToken('file')}.txt`;
  const index = new CompletedWorkUnitFactIndex({
    kernelEventTargets: (record) => {
      const output = record.output && typeof record.output === 'object' && !Array.isArray(record.output)
        ? record.output as Record<string, unknown>
        : {};
      return typeof output.targetPath === 'string' ? [output.targetPath] : [];
    },
    normalizeRelativePath: (value) => value?.startsWith('./') ? value.slice(2) : value,
    comparablePath: (value) => value.split('\\').join('/').replace(/\/$/, ''),
  });
  const completed = index.completedWorkUnitFacts([
    {
      kind: 'work_unit.completed',
      workUnitId: `work-unit-${token}`,
      output: { actionId, targetPath: `./${targetPath}` },
    },
  ]);
  assertEqual(completed.actionIds.has(actionId), true, 'completed work unit index records action id');
  assertEqual(index.completedActionMatches(actionId, `other-${token}.txt`, completed), true, 'completed work unit index matches action id');
  assertEqual(index.completedActionMatches(undefined, targetPath, completed), true, 'completed work unit index matches normalized target path');
  assertEqual(
    index.codeBlockContent({ contentLines: [`line-a-${token}`, `line-b-${token}`] }),
    [`line-a-${token}`, `line-b-${token}`].join('\n'),
    'completed work unit index reads code block content lines'
  );
}

function assertActionBatchFailureIndexSummarizesKernelFailures(): void {
  const token = randomSmokeToken('action-batch-failure');
  const actionId = `action-${token}`;
  const workUnitId = `work-unit-${token}`;
  const targetPath = `scope-${token}/target-${randomSmokeToken('file')}.txt`;
  const index = new ActionBatchFailureIndex();
  const batch = {
    actionBundle: {
      actions: [
        {
          actionId,
          toolId: 'fs.delete',
          args: { path: targetPath },
        },
      ],
    },
  };
  const failures = index.details([
    {
      kind: 'work_unit.queued',
      workUnit: {
        id: workUnitId,
        actionId,
        writeSet: [targetPath],
      },
    },
    {
      kind: 'work_unit.failed',
      workUnitId,
      error: {
        code: `kernel-${token}`,
        message: `structured failure ${token}`,
        args: {
          stage: 'admission',
          details: { classification: `classification-${token}` },
        },
      },
    },
  ], batch);
  assertEqual(failures.length, 1, 'action batch failure index finds failed work unit');
  const detail = failures[0];
  if (!detail) throw new Error('action batch failure index missing detail');
  assertEqual(detail.workUnitId, workUnitId, 'action batch failure index preserves work unit id');
  assertEqual(detail.actionId, actionId, 'action batch failure index preserves action id');
  assertEqual(detail.code, `classification-${token}`, 'action batch failure index consumes the Kernel typed classification');
  assertEqual(detail.kernelCode, `kernel-${token}`, 'action batch failure index preserves kernel code');
  assert(detail.writeSet.includes(targetPath), 'action batch failure index preserves write set');
  const summary = index.summary(detail);
  assert(summary.includes(workUnitId), 'action batch failure summary includes work unit id');
  assert(summary.includes(actionId), 'action batch failure summary includes action id');
  assert(summary.includes(targetPath), 'action batch failure summary includes write target');
}

function assertAcceptedPlanBatchPreflightProjectsAuditOnly(): void {
  const token = randomSmokeToken('batch-preflight');
  const targetPath = `dir-${token}`;
  const preflight = new AcceptedPlanBatchPreflight({
    batchActionRecords: (batch) => {
      const record = batch && typeof batch === 'object' && !Array.isArray(batch)
        ? batch as Record<string, unknown>
        : {};
      return Array.isArray(record.actions)
        ? record.actions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        : [];
    },
  });
  const batch = {
    actions: [
      {
        actionId: `delete-${token}`,
        toolId: 'fs.delete',
        args: { path: `./${targetPath}/` },
        description: 'Delete a directory target',
        dependsOn: [],
      },
    ],
  };
  const audit = preflight.audit(batch);
  assertEqual(audit.actionCount, 1, 'accepted plan batch preflight audits action count');
  const actions = Array.isArray(audit.actions) ? audit.actions : [];
  const action = actions[0] as Record<string, unknown> | undefined;
  assertEqual(action?.targetPath, `./${targetPath}/`, 'accepted plan batch preflight preserves raw target path');
  assertEqual('deleteReasons' in preflight, false, 'Session preflight exposes no local delete permission or safety gate');
}

function assertAcceptedPlanAdmissionChecksProtocolShapeOnly(): void {
  const token = randomSmokeToken('accepted-admission');
  const taskId = `task-${token}`;
  const accepted: AcceptedTaskPlanContext = {
    planId: `plan-${token}`,
    runId: `run-${token}`,
    tasks: [{
      taskId,
      toolId: `tool-${token}`,
      targets: [`target-${token}`],
      dependencies: [],
      planningArgs: {},
      conflictKeys: [],
    }],
    authorizationOperations: [],
    toolIds: [`tool-${token}`],
    targetScopes: [`target-${token}`],
    batchIndex: 1,
    completedTaskIds: [],
    dependencyFacts: [],
    rawPlan: {},
  };
  const admission = new AcceptedPlanAdmission();
  const structurallyValid = admission.validate(accepted, {
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `proposal-${token}`,
    runId: accepted.runId,
    sessionId: `session-${token}`,
    source: 'llm',
    kind: 'actionBundle',
    payload: {
      actionBundle: {
        actions: [{
          actionId: `action-${token}`,
          toolId: `unregistered-${token}`,
          args: { path: `../candidate-${token}` },
        }],
      },
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  } as ProposalEnvelope);
  assertEqual(structurallyValid.ok, true, 'Session admission does not decide tool legality, path scope, or permission risk');

  const malformed = admission.validate(accepted, {
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `malformed-${token}`,
    runId: accepted.runId,
    sessionId: `session-${token}`,
    source: 'llm',
    kind: 'actionBundle',
    payload: {
      actionBundle: {
        actions: [{ actionId: `action-${token}`, toolId: `tool-${token}` }],
      },
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  } as ProposalEnvelope);
  assertEqual(malformed.ok, false, 'Session admission rejects malformed protocol structure');
  assertEqual(malformed.issues?.[0]?.code, 'protocolShapeInvalid', 'Session admission reports only protocol-shape failure');
}

function assertAcceptedTaskRegistryUsesTaskIntentOnly(): void {
  const token = randomSmokeToken('task-registry-intent');
  const currentTaskId = `current-${token}`;
  const currentTarget = `target-${token}`;
  const accepted: AcceptedTaskPlanContext = {
    planId: `plan-${token}`,
    planHash: `plan-hash-${token}`,
    authorizationContractId: `authorization-${token}`,
    authorizationContractHash: `authorization-hash-${token}`,
    runId: `run-${token}`,
    tasks: [
      { taskId: `completed-${token}`, toolId: 'fs.read', targets: [`completed-${token}`], dependencies: [], planningArgs: {}, conflictKeys: [] },
      { taskId: `sufficient-${token}`, toolId: 'fs.list', targets: [`sufficient-${token}`], dependencies: [], planningArgs: {}, conflictKeys: [] },
      { taskId: currentTaskId, toolId: `tool-${token}`, targets: [currentTarget], dependencies: [], planningArgs: {}, conflictKeys: [] },
    ],
    authorizationOperations: [],
    toolIds: ['fs.read', 'fs.list', `tool-${token}`],
    targetScopes: [currentTarget],
    batchIndex: 1,
    completedTaskIds: [`completed-${token}`],
    modelJudgedSufficientTaskIds: [`sufficient-${token}`],
    dependencyFacts: [],
    rawPlan: {},
  };
  const registry = new AcceptedTaskRegistry(accepted);
  const cursor = registry.cursor([]);
  const context = registry.currentTaskContext(cursor);
  assertEqual(cursor?.currentTaskId, currentTaskId, 'task registry advances using task completion state');
  assertEqual(context?.targets[0], currentTarget, 'task registry exposes the accepted task target intent');
  assertEqual(context?.toolIds[0], `tool-${token}`, 'task registry exposes the accepted task tool intent without grants');
  assertEqual('accessScopes' in accepted, false, 'task registry input carries no Session permission scope');
}


function assertAcceptedPlanExecutorBuildsExecutionBatch(): void {
  const token = randomSmokeToken("executor-v4");
  const target = "generated-" + token + ".txt";
  const blockId = "block-" + token;
  const executor = new AcceptedPlanExecutor({
    readActionBundle: (proposal) => (proposal.payload as Record<string, any>).actionBundle as ActionBundleDraft,
    kernelExecutionContractId: (report) => typeof report?.contractId === "string" ? report.contractId : undefined,
    kernelExecutionContractHash: (report) => typeof report?.contractHash === "string" ? report.contractHash : undefined,
  });
  const acceptedPlan: AcceptedTaskPlanContext = {
    planId: "plan-" + token,
    runId: "run-" + token,
    tasks: [{ taskId: "task-" + token, title: "Write", targets: [target], toolId: "fs.write", dependencies: [], planningArgs: {}, conflictKeys: [] }],
    authorizationOperations: [{
      operationId: "plan-op-task-" + token + "-1",
      sourceTaskId: "task-" + token,
      toolId: "fs.write",
      operationKind: "write",
      contentMode: "contentBlock",
      targets: [target],
      dependsOn: [],
      fixedArgs: {},
      argsTemplate: { path: target, contentBlockId: "executionTime" },
      targetResourceKind: "file",
      recursive: false,
      internal: false,
    }],
    toolIds: ["fs.write"],
    targetScopes: [target],
    batchIndex: 1,
    completedTaskIds: [],
    dependencyFacts: [],
    rawPlan: { id: "plan-" + token },
  };
  const proposal = {
    schemaVersion: "deepcode.agent.protocol.v4",
    proposalId: "proposal-" + token,
    runId: acceptedPlan.runId,
    sessionId: "session-" + token,
    source: "llm",
    kind: "actionBundle",
    payload: {
      userPlan: "Generic accepted execution batch.",
      actionBundle: {
        id: "bundle-" + token,
        goal: "Write generic output",
        actions: [{
          actionId: "action-" + token,
          toolId: "fs.write",
          args: { path: "./" + target, contentBlockId: blockId },
          description: "Write generic output",
          dependsOn: [],
        }],
      },
      contentBlocks: [{ blockId, targetPath: "./" + target, operation: "overwrite", contentLines: ["generic content"] }],
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  } as ProposalEnvelope;
  const plan = executor.executionContext({
    sessionId: "session-" + token,
    runId: acceptedPlan.runId,
    acceptedPlan,
    proposal,
    planReviewReport: { contractId: "contract-" + token, contractHash: "hash-" + token },
  });
  const normalized = executor.normalizeKernelBatch({ planId: acceptedPlan.planId, plan, acceptedPlan });
  assertEqual(normalized.ok, true, "accepted plan executor normalizes canonical v4 batch");
  if (!normalized.ok) throw new Error(normalized.reasons.join("; "));
  const action = (normalized.batch.actionBundle.actions as Array<Record<string, any>>)[0];
  assertEqual(action.args.path, "./" + target, "accepted plan executor preserves Kernel-bound typed args without local path policy");
  assertEqual(action.contentBlockId, undefined, "accepted plan executor does not reintroduce top-level content block aliases");
  assertEqual((normalized.batch.contentBlocks[0] as any).targetPath, "./" + target, "accepted plan executor preserves canonical content block target");
  assertEqual(normalized.batch.contractId, "contract-" + token, "accepted plan executor preserves Kernel contract id");
  assertEqual(normalized.batch.contractHash, "hash-" + token, "accepted plan executor preserves Kernel contract hash");
}

async function assertAcceptedActionBundlePlanExecutorSubmitsBatchAndReviews(): Promise<void> {
  const token = randomSmokeToken('accepted-action-executor');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const planId = `plan-${token}`;
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: `ts-${token}`,
    updatedAt: `ts-${token}`,
  };
  const store: AgentEvent[] = [{
    id: `seed-${token}`,
    sessionId,
    ts: `ts-${token}`,
    kind: 'assistant_msg',
    payload: {},
  }];
  const commands: string[] = [];
  const executor = new AcceptedActionBundlePlanExecutor({
    now: () => `ts-${token}`,
    createId: (prefix) => `${prefix}-${token}`,
    append: async (nextSessionId, events) => {
      assertEqual(nextSessionId, sessionId, 'accepted action executor appends to current session');
      store.push(...events);
      return { session: { ...session, eventCount: store.length }, events: [...store] };
    },
    kernel: async (request) => {
      const kind = request.command.kind;
      assertEqual(typeof kind, 'string', 'accepted action executor submits structured kernel commands');
      commands.push(kind as string);
      if (kind === 'actionBatchSubmit') {
        return {
          ok: true,
          events: [kernelTestWorkUnitCompleted(runId, `work-unit-${token}`)],
        };
      }
      return { ok: true, events: [] };
    },
    observeKernel: async (request) => {
      const kind = request.command.kind;
      assertEqual(kind, 'actionBatchSubmit', 'accepted action executor observes only action batch replies');
      commands.push(String(kind));
      return new KernelEventStatusIndex().observe({
        ok: true,
        events: [
          kernelTestWorkUnitQueued({
            runId,
            workUnitId: `work-unit-${token}`,
            actionId: `action-${token}`,
            planId,
            writeSet: [`target-${token}.txt`],
          }),
          kernelTestWorkUnitCompleted(runId, `work-unit-${token}`),
          kernelTestBatchReviewReady(runId),
        ],
      });
    },
    appendProjectedKernelEvents: async (nextSessionId, reply) => {
      assertEqual(nextSessionId, sessionId, 'accepted action executor projects kernel events to current session');
      store.push(...(reply.events ?? []).map((event, index) => ({
        id: `kernel-${commands.length}-${index}-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind: 'workflow_stage',
        payload: event,
      } as AgentEvent)));
      return { session: { ...session, eventCount: store.length }, events: [...store] };
    },
    kernelExecutionContractId: () => `contract-${token}`,
    kernelExecutionContractHash: () => `contract-hash-${token}`,
    recentResourcePackets: () => [],
    sessionRunStateEvent: (input) => ({
      id: `run-state-${token}`,
      sessionId,
      ts: `ts-${token}`,
      kind: 'session_run_state',
      payload: input,
    } as AgentEvent),
    acceptedPlanActionBatchPreflightEvent: (_sessionId, _plan, batch) => ({
      id: `preflight-${token}`,
      sessionId,
      ts: `ts-${token}`,
      kind: 'workflow_stage',
      payload: { stage: 'accepted_plan.action_batch_preflight', batch },
    } as AgentEvent),
    planActionBundleExecutionFailureEvents: () => [],
    planActionBundleExecutionExceptionEvents: () => [],
    acceptedPlanBatchCheckpointEvent: () => {
      throw new Error('overlay checkpoint is not expected for non-overlay execution');
    },
    acceptedPlanTaskSavepointEvent: () => {
      throw new Error('overlay savepoint is not expected for non-overlay execution');
    },
    planProposal: () => ({
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-${token}`,
      runId,
      sessionId,
      source: 'llm',
      kind: 'actionBundle',
      payload: {},
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    } as ProposalEnvelope),
    recordKernelBatchProgress: (progressInput) => ({
      progress: {
        actionIds: [],
        targetPaths: [],
        workUnitIds: [],
        newlyCompletedTaskIds: [],
        completedTaskIds: [],
        remainingTaskIds: [],
      },
      completedTaskIds: [],
      nextAcceptedPlan: progressInput.acceptedPlan,
    }),
    runtimeSnapshot: () => ({}),
    acceptedPlanComplete: () => true,
    executionRequest: () => `execution-${token}`,
  });

  const plan = {
    sessionId,
    runId,
    planId,
    actionBundle: {
      version: '1',
      id: `bundle-${token}`,
      goal: `Write target-${token}.txt`,
      actions: [{
        actionId: `action-${token}`,
        toolId: 'fs.write',
        args: { path: `target-${token}.txt`, content: token },
        description: `Write target-${token}.txt`,
        dependsOn: [],
      }],
      continuationExpectations: [],
      validationExpectations: [],
      reviewExpectations: [],
    },
    contentBlocks: [],
    commandBlocks: [],
    planReviewReport: {},
  } as any;

  const control = await executor.execute(
    {
      sessionId,
      decision: 'accept',
      guidance: `guidance-${token}`,
    },
    plan,
    { session, events: [...store] }
  );

  assertEqual(commands.length, 1, 'accepted action executor does not request a second execution decision');
  assertEqual(commands[0], 'actionBatchSubmit', 'accepted action executor submits the plan-authorized action batch directly');
  assertEqual(control.kind, 'assembleReview', 'accepted action executor returns Review assembly control');
  if (control.kind !== 'assembleReview') throw new Error('accepted action executor must request Review assembly');
  const reviewHandoffEvents = control.request.currentKernelEvents;
  assertEqual(reviewHandoffEvents.length, 3, 'accepted action executor passes Kernel review readiness to Review assembly');
  const completedFact = reviewHandoffEvents.find((event) =>
    (event as Record<string, unknown>).kind === 'work_unit.completed'
  ) as Record<string, unknown> | undefined;
  assertEqual(
    completedFact?.workUnitId,
    `work-unit-${token}`,
    'accepted action executor preserves work unit fact for review'
  );
  assertEqual(
    control.request.result.events.some((event) => event.kind === 'session_run_state'),
    true,
    'accepted action executor records executing run state'
  );
}

function assertKernelEventStatusIndexReadsStructuredEvents(): void {
  const token = randomSmokeToken('kernel-status');
  const workUnitId = `work-unit-${token}`;
  const permissionId = `permission-${token}`;
  const runId = `run-${token}`;
  const index = new KernelEventStatusIndex();
  const events: KernelEventV1[] = [
    kernelTestWorkUnitQueued({ runId, workUnitId, actionId: `action-${token}` }),
    {
      kind: 'permission.requested',
      runId,
      sessionId: `session-${token}`,
      request: kernelTestPermissionRequest(permissionId, { workUnitIds: [workUnitId] }),
    },
    {
      kind: 'work_unit.blocked',
      runId,
      workUnitId,
      reason: `blocked-${token}`,
    },
  ];
  assert(index.workUnitIds(events).includes(workUnitId), 'kernel event status index reads work unit ids');
  assert(index.hasPermissionRequest(events), 'kernel event status index detects permission request');
  assertEqual(index.permissionId(events), permissionId, 'kernel event status index reads permission id');
  assertEqual(index.runId(events), runId, 'kernel event status index reads run id');
  assert(index.hasFailureOrBlocker(events), 'kernel event status index detects blocker status');
  const queuedWorkUnitId = `queued-${token}`;
  assertEqual(
    index.actionBatchReadyForReview([
      kernelTestWorkUnitQueued({ runId, workUnitId: queuedWorkUnitId, actionId: `action-${token}` }),
      kernelTestWorkUnitCompleted(runId, queuedWorkUnitId),
    ]),
    false,
    'kernel event status index does not infer review readiness from terminal work units'
  );
  assertEqual(
    index.actionBatchReadyForReview([
      kernelTestWorkUnitQueued({ runId, workUnitId: queuedWorkUnitId, actionId: `action-${token}` }),
      kernelTestWorkUnitCompleted(runId, queuedWorkUnitId),
      kernelTestBatchReviewReady(runId),
    ]),
    true,
    'kernel event status index accepts explicit Kernel batch review readiness'
  );
  assertEqual(
    index.actionBatchReadyForReview([
      {
        kind: 'permission.requested',
        runId,
        sessionId: `session-${token}`,
        request: kernelTestPermissionRequest(`permission-${token}`),
      },
      kernelTestBatchReviewReady(runId),
    ]),
    false,
    'kernel event status index keeps permission requests out of review-ready batches'
  );
  assertEqual(
    index.reviewGateStatus([
      {
        kind: 'review_gate.evaluated',
        runId,
        result: kernelTestReviewGateEvaluation(runId, 'cleanupFailed'),
      },
    ]),
    'cleanupFailed',
    'kernel event status index reads review gate status'
  );
  const permissionObservation = index.observe({
    ok: true,
    events: [{
      kind: 'permission.requested',
      runId,
      sessionId: `session-${token}`,
      request: kernelTestPermissionRequest(permissionId),
    }],
  });
  assertEqual(permissionObservation.kind, 'permissionInterrupted', 'Kernel reply reducer classifies permission interrupts');
  const failureObservation = index.observe({
    ok: false,
    events: [],
    error: { code: `code-${token}`, message: `message-${token}` },
  });
  assertEqual(failureObservation.kind, 'commandFailed', 'Kernel reply reducer classifies command failures');
  const factsObservation = index.observe({
    ok: true,
    events: [
      kernelTestWorkUnitQueued({ runId, workUnitId: queuedWorkUnitId, actionId: `action-${token}` }),
      kernelTestWorkUnitCompleted(runId, queuedWorkUnitId),
      kernelTestBatchReviewReady(runId),
    ],
  });
  assertEqual(factsObservation.kind, 'factsObserved', 'Kernel reply reducer classifies completed facts');
  assertEqual(
    factsObservation.kind === 'factsObserved' ? factsObservation.readyForReview : false,
    true,
    'Kernel facts observation carries the shared Review readiness decision'
  );
}

async function assertAcceptedPlanReviewHandoffCoordinatorBuildsReviewState(): Promise<void> {
  const token = randomSmokeToken('review-handoff');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const planId = `plan-${token}`;
  const reviewId = `review-${token}`;
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: `ts-${token}`,
    updatedAt: `ts-${token}`,
  };
  const seedEvent = {
    id: `seed-${token}`,
    sessionId,
    ts: `ts-${token}`,
    kind: 'assistant_msg',
    payload: {},
  } as AgentEvent;
  const initialResult: AgentSessionResult = { session, events: [seedEvent] };
  const completedEvent = kernelTestWorkUnitCompleted(runId, `work-${token}`);
  const factsEvent: KernelEventV1 = {
    kind: 'review.facts_produced',
    runId,
    facts: kernelTestReviewFacts(runId, `facts-${token}`),
  };
  const plan = {
    sessionId,
    runId,
    planId,
    userPlan: `user-plan-${token}`,
    actionBundle: { id: `bundle-${token}` },
    contentBlocks: [],
    commandBlocks: [],
    expectedValidation: `validation-${token}`,
    reviewGuide: `guide-${token}`,
  };
  let kernelRequestId = '';
  let assertCalled = false;
  let aggregationCurrentEvents: unknown[] = [];
  let reviewKernelEvents: unknown[] = [];
  let appendedEvents: AgentEvent[] = [];
  const coordinator = new AcceptedPlanReviewHandoffCoordinator<typeof plan>({
    now: () => `ts-${token}`,
    createId: (prefix) => `${prefix}-${token}`,
    kernel: async (request: KernelCommandEnvelope): Promise<KernelReply> => {
      const command = request.command as { kind?: string; requestId?: string };
      assertEqual(command.kind, 'reviewFactsGet', 'review handoff requests review facts');
      kernelRequestId = command.requestId ?? '';
      return { ok: true, events: [factsEvent] };
    },
    appendProjectedKernelEvents: async (nextSessionId, reply) => {
      assertEqual(nextSessionId, sessionId, 'review handoff projects facts into current session');
      assertEqual(reply.events?.[0], factsEvent, 'review handoff projects facts reply');
      return {
        session,
        events: [
          ...initialResult.events,
          {
            id: `projected-${token}`,
            sessionId,
            ts: `ts-${token}`,
            kind: 'kernel_event',
            payload: { kernelEvent: factsEvent },
          } as unknown as AgentEvent,
        ],
      };
    },
    append: async (nextSessionId, events) => {
      assertEqual(nextSessionId, sessionId, 'review handoff appends review events to current session');
      appendedEvents = events;
      return { session, events };
    },
    assertKernelReplyOk: (reply, code) => {
      assertEqual(reply.ok, true, 'review handoff asserts successful facts reply');
      assertEqual(code, `code-${token}`, 'review handoff forwards assert code');
      assertCalled = true;
    },
    acceptedPlanKernelEvents: (events, nextRunId, nextPlanId, currentEvents) => {
      assertEqual(events.length, 2, 'review handoff aggregates from projected timeline');
      assertEqual(nextRunId, runId, 'review handoff aggregates by run id');
      assertEqual(nextPlanId, planId, 'review handoff aggregates by plan id');
      aggregationCurrentEvents = currentEvents;
      return currentEvents;
    },
    reviewProjection: {
      summaryEvent: ({ kernelEvents }) => {
        reviewKernelEvents = kernelEvents;
        return {
          id: `review-summary-${token}`,
          sessionId,
          ts: `ts-${token}`,
          kind: 'review_summary',
          payload: { reviewId },
        };
      },
    },
    progressProjection: {
      sessionRunStateEvent: ({ phase, reason, decisionOwner }) => ({
        id: `run-state-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind: 'session_run_state',
        payload: {
          phase,
          reason,
          decisionOwner,
        },
      }),
    },
  });

  const result = await coordinator.handoff({
    sessionId,
    runId,
    planId,
    plan,
    result: initialResult,
    currentKernelEvents: [completedEvent],
    requestIdPrefix: `request-${token}`,
    assertFactsReplyOk: {
      code: `code-${token}`,
      fallback: `fallback-${token}`,
    },
  });

  assertEqual(kernelRequestId, `request-${token}-${token}`, 'review handoff uses caller request id prefix');
  assert(assertCalled, 'review handoff applies optional facts reply assertion');
  assertEqual(aggregationCurrentEvents.length, 2, 'review handoff includes current and facts events in aggregation');
  assertEqual(aggregationCurrentEvents[0], completedEvent, 'review handoff preserves current kernel events first');
  assertEqual(aggregationCurrentEvents[1], factsEvent, 'review handoff appends facts reply events');
  assertEqual(reviewKernelEvents.length, 2, 'review handoff passes aggregated events to review projection');
  assertEqual(appendedEvents[0]?.kind, 'review_summary', 'review handoff appends review first');
  assertEqual(appendedEvents[1]?.kind, 'session_run_state', 'review handoff appends waiting review state second');
  const runStatePayload = appendedEvents[1]?.payload as Record<string, unknown> | undefined;
  const decisionOwner = runStatePayload?.decisionOwner as Record<string, unknown> | undefined;
  assertEqual(runStatePayload?.phase, 'waiting_review', 'review handoff enters waiting review');
  assertEqual(decisionOwner?.reviewId, reviewId, 'review handoff uses review id from summary');
  assertEqual(result.events.length, 2, 'review handoff returns append result');
}

function assertReviewAssemblerFormatsReviewFacts(): void {
  const token = randomSmokeToken('review-facts');
  const assembler = new ReviewAssembler({
    completedWorkUnitFacts: () => ({ actionIds: new Set(), targets: new Set() }),
    batchActionRecords: () => [],
    actionToolId: () => '',
    actionFileTargetPath: () => undefined,
    normalizeAcceptedPlanTargetScope: (target) => target,
    comparablePath: (value) => value,
    resourceTextForTarget: () => undefined,
  });
  const events = [
    {
      kind: 'review.facts_produced',
      facts: {
        completedWorkUnits: [
          {
            workUnitId: `work-unit-${token}`,
            output: { path: `path-${token}.txt` },
          },
        ],
        toolResults: [
          {
            toolId: `tool-${token}`,
            ok: true,
            output: { targetPath: `path-${token}.txt` },
          },
        ],
      },
    },
  ];
  assert(
    assembler.findReviewFacts(events)?.completedWorkUnits,
    'review assembler finds latest ReviewFacts event'
  );
  const lines = assembler.reviewFactLines(events);
  assert(lines.some((line) => line.includes(`work-unit-${token}`)), 'review assembler renders work unit facts');
  assert(lines.some((line) => line.includes(`tool-${token}`)), 'review assembler renders tool facts');

  const review = {
    runId: `run-${token}`,
    reviewId: `review-${token}`,
    sourcePlanId: `plan-${token}`,
  };
  assert(
    assembler.reviewAlreadyResolved([
      {
        kind: 'review_summary',
        payload: {
          runId: review.runId,
          reviewId: review.reviewId,
          status: 'accepted',
        },
      },
    ], review),
    'review assembler detects resolved review summaries'
  );
  assert(
    assembler.isTerminalAcceptedPlan([
      {
        kind: 'workflow_stage',
        payload: {
          runId: review.runId,
          planId: review.sourcePlanId,
          stage: 'accepted_plan.batch_checkpoint',
          status: 'completed',
          remainingTaskIds: [],
        },
      },
    ], review),
    'review assembler detects terminal accepted plan checkpoints'
  );
}

function assertReviewAssemblerFindsWaitingReviewContext(): void {
  const token = randomSmokeToken('waiting-review');
  const assembler = new ReviewAssembler({
    completedWorkUnitFacts: () => ({ actionIds: new Set(), targets: new Set() }),
    batchActionRecords: () => [],
    actionToolId: () => '',
    actionFileTargetPath: () => undefined,
    normalizeAcceptedPlanTargetScope: (target) => target,
    comparablePath: (value) => value,
    resourceTextForTarget: () => undefined,
  });
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const reviewId = `review-${token}`;
  const continuationTitle = `continue-${token}`;
  const events = [
    {
      sessionId,
      kind: 'review_summary',
      payload: {
        status: 'waitingUserReview',
        runId,
        reviewId,
        sourcePlanId: `plan-${token}`,
        summary: `summary-${token}`,
        content: `content-${token}`,
        userPlan: `plan-${token}`,
        continuations: [{ id: `continuation-${token}`, title: continuationTitle }],
        reviewExpectations: [{ id: `expectation-${token}` }],
        expectedValidation: `validation-${token}`,
        reviewGuide: `guide-${token}`,
        facts: [`fact-${token}`],
      },
    },
  ];
  const review = assembler.findWaitingReview(events, runId, { kind: 'review', runId });
  if (!review) {
    throw new Error('review assembler finds waiting review context');
  }
  assertEqual(review.sessionId, sessionId, 'review assembler preserves session id');
  assertEqual(review.reviewId, reviewId, 'review assembler preserves review id');
  assertEqual(review.continuations.length, 1, 'review assembler preserves continuations');
  const request = assembler.continuationRequest(review);
  assert(request.includes(`fact-${token}`), 'review assembler continuation request includes review facts');
  assert(request.includes(continuationTitle), 'review assembler continuation request includes continuation title');
  const revisionRequest = assembler.revisionRequest(review, `guidance-${token}`);
  assert(revisionRequest.includes(`guidance-${token}`), 'review assembler revision request includes user guidance');
  assert(revisionRequest.includes(`fact-${token}`), 'review assembler revision request includes review facts');
  assertEqual(
    assembler.continuationSummaries(review)[0],
    continuationTitle,
    'review assembler exposes continuation summaries'
  );
  assertEqual(
    assembler.findLatestActiveReviewInteraction(events)?.runId,
    runId,
    'review assembler finds active review interaction'
  );
  assertEqual(
    assembler.findLatestActiveReviewInteraction([
      ...events,
      {
        sessionId,
        kind: 'review_summary',
        payload: {
          status: 'accepted',
          runId,
          reviewId,
        },
      },
    ]),
    null,
    'review assembler ignores resolved active review interaction'
  );
  assertEqual(
    assembler.findWaitingReview(events, `other-${token}`, { kind: 'review', runId: `other-${token}` }),
    null,
    'review assembler rejects run mismatch'
  );
}

function assertReviewDecisionProjectionUsesI18nKeys(): void {
  const token = randomSmokeToken('review-decision');
  const builder = new ReviewDecisionProjectionBuilder();
  const review = {
    runId: `run-${token}`,
    reviewId: `review-${token}`,
    sourcePlanId: `plan-${token}`,
    continuations: [
      {
        title: `next-${token}`,
        target: `target-${token}.txt`,
        capability: `capability-${token}`,
      },
    ],
  };
  const accepted = builder.event({
    sessionId: `session-${token}`,
    review,
    status: 'accepted',
    continuationRequested: false,
    ts: new Date(0).toISOString(),
    id: `event-${token}`,
  });
  const acceptedPayload = accepted.payload as Record<string, unknown>;
  assertEqual(acceptedPayload.title, 'Review', 'review decision projection uses locale-neutral title fallback');
  assertEqual(acceptedPayload.titleKey, 'review.decision.title', 'review decision projection includes title key');
  assertEqual(acceptedPayload.summaryKey, 'review.decision.accepted.summary', 'review decision projection includes accepted summary key');
  assertEqual(acceptedPayload.messageKey, 'review.decision.accepted.summary', 'review decision projection exposes message key');
  assertEqual(acceptedPayload.content, undefined, 'review decision projection does not emit session-generated localized content');
  assertEqual(acceptedPayload.contentKey, 'review.decision.accepted.content', 'review decision projection emits accepted content key');
  assertEqual((acceptedPayload.messageArgs as Record<string, unknown>).continuationCount, '1', 'review decision projection records continuation count as an i18n arg');
  assertEqual(Array.isArray(acceptedPayload.continuations), true, 'review decision projection preserves continuation facts structurally');
  assertEqual((acceptedPayload.decisionOwner as Record<string, unknown>).kind, 'review', 'review decision projection carries a review decision owner');
  assertEqual((acceptedPayload.decisionOwner as Record<string, unknown>).planId, review.sourcePlanId, 'review decision owner carries the source plan id');

  const guidance = `guidance-${token}`;
  const revision = builder.event({
    sessionId: `session-${token}`,
    review,
    status: 'needsRevision',
    content: guidance,
    continuationRequested: false,
    ts: new Date(0).toISOString(),
    id: `revision-${token}`,
  });
  const revisionPayload = revision.payload as Record<string, unknown>;
  assertEqual(revisionPayload.summaryKey, 'review.decision.needsRevision.summary', 'review decision projection includes revision summary key');
  assertEqual(revisionPayload.content, guidance, 'review decision projection preserves user guidance content');
  assertEqual(revisionPayload.contentKey, undefined, 'review decision projection does not assign content key to user guidance');

  const continuationPrompt = builder.continuationPromptEvent({
    sessionId: `session-${token}`,
    review,
    continuations: [`next-${token}`],
    ts: new Date(0).toISOString(),
    id: `continuation-${token}`,
  });
  const continuationPayload = continuationPrompt.payload as Record<string, unknown>;
  assertEqual(continuationPayload.titleKey, 'review.continuationDecision.title', 'review decision projection emits continuation title key');
  assertEqual(continuationPayload.messageKey, 'review.continuationDecision.summary', 'review decision projection emits continuation message key');
  assertEqual((continuationPayload.messageArgs as Record<string, unknown>).continuationCount, '1', 'review decision projection emits continuation count');
  assertEqual(Array.isArray(continuationPayload.continuations), true, 'review decision projection preserves continuation summaries');
}

async function assertReviewDecisionHandlerAcceptsTerminalReview(): Promise<void> {
  const token = randomSmokeToken('review-handler');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const reviewId = `review-${token}`;
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: `created-${token}`,
    updatedAt: `updated-${token}`,
  };
  const store: AgentEvent[] = [{
    id: `waiting-review-${token}`,
    sessionId,
    ts: `ts-${token}`,
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId,
      reviewId,
      sourcePlanId: `plan-${token}`,
      content: `Review content ${token}`,
      userPlan: `Plan intent ${token}`,
      facts: [`- work unit ${token} completed`],
      continuations: [],
      confirmable: true,
    },
  }];
  const kernelCommands: string[] = [];
  const handler = new ReviewDecisionHandler({
    now: () => `ts-${token}`,
    createId: (prefix) => `${prefix}-${kernelCommands.length}-${store.length}-${token}`,
    kernel: async (request): Promise<KernelReply> => {
      const command = request.command;
      kernelCommands.push(String(command.kind));
      if (command.kind === 'reviewGateEvaluate') {
        return {
          ok: true,
          events: [{
            kind: 'review_gate.evaluated',
            runId,
            result: kernelTestReviewGateEvaluation(runId, 'accepted'),
          }],
        };
      }
      throw new Error(`unexpected review handler kernel command ${String(command.kind)}`);
    },
    appendProjectedKernelEvents: async (nextSessionId, reply) => {
      assertEqual(nextSessionId, sessionId, 'review handler projects kernel events to current session');
      store.push(...(reply.events ?? []).map((kernelEvent, index) => ({
        id: `kernel-${kernelCommands.length}-${index}-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind: 'kernel_event',
        payload: { kernelEvent },
      } as unknown as AgentEvent)));
      return { session: { ...session, eventCount: store.length }, events: [...store] };
    },
    append: async (nextSessionId, events) => {
      assertEqual(nextSessionId, sessionId, 'review handler appends to current session');
      store.push(...events);
      return { session: { ...session, eventCount: store.length }, events: [...store] };
    },
    reviewAssembler: new ReviewAssembler({
      completedWorkUnitFacts: () => ({ actionIds: new Set(), targets: new Set() }),
      batchActionRecords: () => [],
      actionToolId: () => '',
      actionFileTargetPath: () => undefined,
      normalizeAcceptedPlanTargetScope: (target) => target,
      comparablePath: (value) => value,
      resourceTextForTarget: () => undefined,
    }),
    reviewDecisionProjection: new ReviewDecisionProjectionBuilder(),
    kernelStatus: new KernelEventStatusIndex(),
    progressProjection: {
      traceEvent: ({ kind, summary, extra }) => ({
        id: `trace-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind,
        payload: { summary, ...extra },
      }),
      sessionRunStateEvent: ({ phase, status, reason, decisionOwner }) => ({
        id: `run-state-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind: 'session_run_state',
        payload: { phase, status, reason, decisionOwner },
      }),
    },
  });

  const control = await handler.resolve({
    sessionId,
    decision: 'accept',
    runId,
    existingEvents: [...store],
  });

  assertEqual(kernelCommands.join(','), 'reviewGateEvaluate', 'review handler submits only the typed ReviewGate decision');
  const result = returnedSession(control, 'terminal review accept returns a completed decision result');
  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'accepted'), true, 'review handler records accepted review');
  const completed = result.events.find((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'completed');
  assert(Boolean(completed), 'review handler appends completed run state');
  const completedPayload = completed?.payload as Record<string, unknown> | undefined;
  assertEqual(completedPayload?.phase, 'completed', 'review handler completed state uses completed phase');
  const owner = completedPayload?.decisionOwner as Record<string, unknown> | undefined;
  assertEqual(owner?.reviewId, reviewId, 'review handler completed state keeps review owner');
}

async function assertReviewDecisionHandlerKeepsTerminalReviewOpenWhenKernelRunIsInactive(): Promise<void> {
  const token = randomSmokeToken('review-handler-inactive-run');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const reviewId = `review-${token}`;
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: `created-${token}`,
    updatedAt: `updated-${token}`,
  };
  const store: AgentEvent[] = [{
    id: `waiting-review-${token}`,
    sessionId,
    ts: `ts-${token}`,
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId,
      reviewId,
      sourcePlanId: `plan-${token}`,
      content: `Review content ${token}`,
      facts: [`- work unit ${token} completed`],
      continuations: [],
      confirmable: true,
    },
  }];
  const kernelCommands: string[] = [];
  const handler = new ReviewDecisionHandler({
    now: () => `ts-${token}`,
    createId: (prefix) => `${prefix}-${kernelCommands.length}-${store.length}-${token}`,
    kernel: async (request): Promise<KernelReply> => {
      const command = request.command;
      kernelCommands.push(String(command.kind));
      const commandRunId = 'runId' in command ? command.runId : 'unknown';
      throw new Error(`invalid command: run ${String(commandRunId)} is not active`);
    },
    appendProjectedKernelEvents: async () => {
      throw new Error('inactive terminal review must not project rejected Kernel events');
    },
    append: async (nextSessionId, events) => {
      assertEqual(nextSessionId, sessionId, 'inactive review handler appends to current session');
      store.push(...events);
      return { session: { ...session, eventCount: store.length }, events: [...store] };
    },
    reviewAssembler: new ReviewAssembler({
      completedWorkUnitFacts: () => ({ actionIds: new Set(), targets: new Set() }),
      batchActionRecords: () => [],
      actionToolId: () => '',
      actionFileTargetPath: () => undefined,
      normalizeAcceptedPlanTargetScope: (target) => target,
      comparablePath: (value) => value,
      resourceTextForTarget: () => undefined,
    }),
    reviewDecisionProjection: new ReviewDecisionProjectionBuilder(),
    kernelStatus: new KernelEventStatusIndex(),
    progressProjection: {
      traceEvent: ({ kind, summary, extra, id }) => ({
        id,
        sessionId,
        ts: `ts-${token}`,
        kind,
        payload: { summary, ...extra },
      }),
      sessionRunStateEvent: ({ phase, status, reason, decisionOwner }) => ({
        id: `run-state-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind: 'session_run_state',
        payload: { phase, status, reason, decisionOwner },
      }),
    },
  });

  const control = await handler.resolve({
    sessionId,
    decision: 'accept',
    runId,
    existingEvents: [...store],
  });

  assertEqual(kernelCommands.join(','), 'reviewGateEvaluate', 'inactive review handler attempts only the typed ReviewGate decision');
  const result = returnedSession(control, 'inactive terminal review accept returns a non-terminal decision result');
  assertEqual(
    result.events.some((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'accepted'),
    true,
    'inactive terminal review accept records accepted review'
  );
  assertEqual(
    result.events.filter((event) => event.kind === 'trace/review_accept_noop').length,
    1,
    'inactive terminal review accept records one gate-unavailable trace'
  );
  const completed = result.events.find((event) =>
    event.kind === 'session_run_state' &&
    (event.payload as any)?.status === 'completed' &&
    (event.payload as any)?.reason === 'review'
  );
  assertEqual(Boolean(completed), false, 'inactive terminal review cannot be inferred as completed by Session');
}

async function assertPlanDecisionHandlerRejectsActivePlan(): Promise<void> {
  const token = randomSmokeToken('plan-handler');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const planId = `plan-${token}`;
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    title: `Session ${token}`,
    createdAt: `created-${token}`,
    updatedAt: `updated-${token}`,
    eventCount: 0,
  };
  const store: AgentEvent[] = [{
    id: `plan-card-${token}`,
    sessionId,
    ts: `ts-${token}`,
    kind: 'plan_card',
    payload: {
      runId,
      planId,
      status: 'pending',
      confirmable: true,
      content: `Plan ${token}`,
      actionBundle: { id: planId, version: '1', actions: [] },
      contentBlocks: [],
      commandBlocks: [],
      expectedValidation: '',
      reviewGuide: '',
    },
  } as AgentEvent];
  let executed = 0;
  const handler = new PlanDecisionHandler({
    now: () => `now-${token}`,
    createId: (prefix) => `${prefix}-${token}`,
    append: async (nextSessionId, events) => {
      assertEqual(nextSessionId, sessionId, 'plan handler appends to current session');
      store.push(...events);
      return { session: { ...session, eventCount: store.length }, events: [...store] };
    },
    kernel: async (request) => ({
      ok: true,
      events: [{
        kind: 'plan_authorization.decision_recorded',
        requestId: request.command.requestId,
        runId,
        sessionId,
        authorizationContractId: `authorization-${token}`,
        decision: 'reject',
      }],
    }),
    appendProjectedKernelEvents: async () => ({
      session: { ...session, eventCount: store.length },
      events: [...store],
    }),
    diagnosticEvent: (_nextSessionId, content) => ({
      id: `diagnostic-${token}`,
      sessionId,
      ts: `ts-${token}`,
      kind: 'error',
      payload: { content },
    }),
    executeAcceptedActionBundlePlan: async () => {
      executed += 1;
      return {
        kind: 'return',
        result: { session: { ...session, eventCount: store.length }, events: [...store] },
      };
    },
    activeDriverInteraction: () => ({ kind: 'plan', runId, planId }),
    executionRootFromDecision: () => undefined,
    buildAcceptedTaskPlan: () => {
      throw new Error('rejecting a plan must not build accepted implementation context');
    },
    recoverAcceptedPlanFromOverlay: () => undefined,
    planRevisionRequest: () => `revision-${token}`,
    executionRequest: () => `execution-${token}`,
    planIndex: new PlanContextIndex({
      interactionOverlayFromPayload: () => undefined,
      executionRootFromPayload: () => undefined,
    }),
    planProjection: new PlanProjectionBuilder({
      readActionBundle: () => undefined,
      requiredFileOperationsFromReport: () => [],
      permissionBundlesFromReport: () => [],
      gateInterventionsFromReport: () => [],
      planReviewFacts: () => [],
      interactionOverlayProjection: () => ({}),
      visibleLanguageForRequest: () => 'en-US',
    }),
    progressProjection: {
      traceEvent: ({ kind, summary, extra }) => ({
        id: `trace-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind,
        payload: { summary, ...extra },
      }),
      sessionRunStateEvent: ({ phase, status, reason, decisionOwner, interactionOverlay }) => ({
        id: `run-state-${token}`,
        sessionId,
        ts: `ts-${token}`,
        kind: 'session_run_state',
        payload: { phase, status, reason, decisionOwner, interactionOverlay },
      }),
    },
  });

  const control = await handler.resolve({
    sessionId,
    decision: 'reject',
    runId,
    targetId: planId,
    existingEvents: [...store],
  });

  const result = returnedSession(control, 'plan reject returns a terminal decision result');
  assertEqual(executed, 0, 'plan reject does not execute accepted action bundle');
  const rejectedReview = result.events.find((event) => event.kind === 'plan_review' && (event.payload as any)?.status === 'rejected');
  assert(Boolean(rejectedReview), 'plan handler records rejected plan review');
  assertEqual((rejectedReview?.payload as any)?.messageKey, 'session.driver.planReviewRejected', 'plan reject uses rejected i18n key');
  const cancelled = result.events.find((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'cancelled');
  assert(Boolean(cancelled), 'plan handler appends cancelled run state');
  const cancelledPayload = cancelled?.payload as Record<string, unknown> | undefined;
  assertEqual(cancelledPayload?.phase, 'cancelled', 'plan handler cancelled state uses cancelled phase');
  const owner = cancelledPayload?.decisionOwner as Record<string, unknown> | undefined;
  assertEqual(owner?.planId, planId, 'plan handler cancelled state keeps plan owner');
}

function assertProjectionBuildersKeepKernelAndReviewReadModels(): void {
  const token = randomSmokeToken('projection-builder');
  const runId = `run-${token}`;
  const targetPath = `dir-${token}/file-${token}.txt`;
  const workUnitId = `work-unit-${token}`;
  const actionId = `action-${token}`;
  const kernelProjection = new KernelEventProjectionBuilder({
    requiredFileOperationsFromReport: () => [],
    permissionBundlesFromReport: () => [],
    gateInterventionsFromReport: () => [],
    planReviewFacts: () => [],
  });
  const queued = {
    kind: 'work_unit.queued',
    runId,
    workUnit: {
      id: workUnitId,
      planId: `plan-${token}`,
      actionId,
      title: `Delete ${targetPath}`,
      toolId: 'fs.delete',
      operationKind: 'fsDelete',
      capability: 'workspace.write',
      targetRef: {
        kind: 'workspaceRelative',
        path: targetPath,
      },
      readSet: [],
      compiledTool: {
        toolId: 'fs.delete',
        operationKind: 'fsDelete',
        path: targetPath,
        targetKind: 'file',
        recursive: false,
        argsPreview: { path: targetPath },
      },
      writeSet: [targetPath],
      conflictKeys: [`workspace:${targetPath}`],
      executionMode: 'execute',
      status: 'queued',
    },
  };
  const completedWithoutAction = {
    kind: 'work_unit.completed',
    runId,
    workUnitId,
    output: {
      path: targetPath,
      operation: 'delete',
    },
  };
  const facts = kernelProjection.indexKernelWorkUnitFacts([queued]);
  const enriched = kernelProjection.enrichKernelWorkUnitRecord(completedWithoutAction, facts);
  assertEqual(
    kernelProjection.kernelEventTargets(enriched)[0],
    targetPath,
    'kernel projection preserves completed work unit targets'
  );
  assertEqual(
    (enriched.projectionWorkUnit as Record<string, unknown> | undefined)?.actionId,
    actionId,
    'kernel projection associates completed activity identity with the typed queued descriptor'
  );
  const activity = kernelProjection.kernelEventActivity(enriched, `activity-${token}`, runId);
  assertEqual(activity?.kind, 'editFileCompleted', 'kernel projection builds completed edit activity');
  assertEqual(activity?.targets?.[0], targetPath, 'kernel projection carries activity target');
  assertEqual(activity?.operation, 'delete', 'kernel projection preserves the structured operation across work-unit updates');
  const workspaceRoot = `/tmp/workspace-${token}`;
  const normalizedTargets = kernelProjection.kernelEventTargets({
    kind: 'work_unit.completed',
    output: {
      path: targetPath,
      normalizedTargetPath: targetPath,
      absolutePath: `${workspaceRoot}/${targetPath}`,
      workspaceRoot,
      operation: 'delete',
    },
  });
  assertEqual(normalizedTargets.length, 1, 'kernel projection treats workspace-relative and absolute paths as one target');
  assertEqual(normalizedTargets[0], targetPath, 'kernel projection exposes the workspace-relative target to UI shells');
  const projected = kernelProjection.projectKernelEvent({
    sessionId: `session-${token}`,
    event: enriched,
    ts: new Date(0).toISOString(),
    id: `event-${token}`,
  });
  assertEqual(projected.kind, 'workflow_stage', 'kernel projection preserves workflow stage event shape');
  const projectedQueued = kernelProjection.projectKernelEvent({
    sessionId: `session-${token}`,
    event: queued,
    ts: new Date(0).toISOString(),
    id: `event-queued-${token}`,
  });
  const projectedStarted = kernelProjection.projectKernelEvent({
    sessionId: `session-${token}`,
    event: kernelProjection.enrichKernelWorkUnitRecord({
      kind: 'work_unit.started',
      runId,
      workUnitId,
    }, facts),
    ts: new Date(1).toISOString(),
    id: `event-started-${token}`,
  });
  const activityProjection = buildNarrativeTimelineProjection({
    sessionId: `session-${token}`,
    events: [projectedQueued, projectedStarted, projected],
  });
  assertEqual(
    activityProjection.turns.flatMap((turn) => turn.blocks).filter((block) => block.activity).length,
    1,
    'queued, running, and completed facts update one activity block'
  );

  const reviewProjection = new ReviewProjectionBuilder();
  const readableReview = reviewProjection.readableSummary([{
    ...enriched,
    output: {
      path: targetPath,
      actionId,
      operation: 'write',
    },
  }]);
  assertEqual(readableReview.changedFiles[0]?.path, targetPath, 'review projection keeps changed file target');
  assertEqual(readableReview.changedFiles[0]?.operation, 'write', 'review projection keeps changed file operation');
  const reviewSections = reviewProjection.reviewSections({
    plan: {
      userPlan: `plan-${token}`,
      actionBundle: { reviewExpectations: [] },
    },
    readableReview,
    completed: 1,
    failed: 0,
    blocked: 0,
    toolResults: 0,
    continuations: [],
  });
  assert(JSON.stringify(reviewSections).includes(targetPath), 'review projection renders changed file path in structured review sections');
  assert(
    !reviewSections.some((section) => section.sectionId === 'auditDetails' || section.sectionId === 'originalPlan'),
    'readable review projection keeps audit details and the original plan out of the primary card'
  );
  assert(
    !JSON.stringify(reviewSections).includes(workUnitId),
    'readable review projection does not expose work-unit identifiers in primary content'
  );

  const reviewSummaryProjection = new ReviewProjectionBuilder<any, { id: string }, { completedTaskIds: string[] }>({
    reviewFactLines: () => [`fact-${token}`],
    staticSyntaxReviewFactLines: () => [`syntax-${token}`],
    findReviewFacts: () => ({
      completedWorkUnits: [{
        workUnitId,
        output: {
          path: targetPath,
          operation: 'write',
          actionId,
        },
      }],
      failedWorkUnits: [],
      blockedWorkUnits: [],
      toolResults: [],
    }),
    concreteContinuationExpectations: (value) => Array.isArray(value) ? value : [],
    acceptedPlanContext: () => ({ id: `accepted-${token}` }),
    acceptedPlanBatchCompletedTaskIds: () => [`task-${token}`],
    acceptedPlanAfterBatch: (acceptedPlan) => acceptedPlan,
    acceptedPlanTaskLedger: () => ({ completedTaskIds: [`task-${token}`] }),
    buildReviewFactsContext: (input) => input,
  });
  const reviewEvent = reviewSummaryProjection.summaryEvent({
    sessionId: `session-${token}`,
    plan: {
      sessionId: `session-${token}`,
      runId,
      planId: `plan-${token}`,
      userPlan: `plan-${token}`,
      taskPlan: { id: `implementation-${token}` },
      actionBundle: {
        reviewExpectations: [],
        continuationExpectations: [{ targetPath }],
      },
    },
    kernelEvents: [{
      kind: 'work_unit.completed',
      runId,
      workUnitId,
      output: {
        path: targetPath,
        operation: 'write',
        actionId,
      },
    }],
    ts: new Date(0).toISOString(),
    id: `review-${token}`,
  });
  assertEqual(reviewEvent.kind, 'review_summary', 'review projection builds review summary event');
  const reviewPayload = reviewEvent.payload as any;
  assertEqual(reviewPayload.factCounts.workUnitsCompleted, 1, 'review summary event counts completed work units');
  assertEqual(reviewPayload.changedFiles[0]?.path, targetPath, 'review summary event carries changed files');
  assertEqual(reviewPayload.content, undefined, 'review summary event does not emit markdown fallback content');
  assertEqual(reviewPayload.readableReview.schemaVersion, 'deepcode.session.readable-review.v1', 'review summary event carries structured readable review');
  assert(
    JSON.stringify(reviewPayload.readableReview.sections).includes(targetPath),
    'review summary event renders changed file target in structured sections'
  );
  assertEqual(reviewPayload.reviewFactsContext.changedFileCount, 1, 'review summary event carries review facts context');
  assert(reviewPayload.developerDetails.facts.includes(`fact-${token}`), 'review summary event carries review facts details');

  const gitReviewSummaryProjection = (gitReview: Record<string, unknown>) => new ReviewProjectionBuilder<any, { id: string }, { completedTaskIds: string[] }>({
    reviewFactLines: () => [`fact-${token}`],
    staticSyntaxReviewFactLines: () => [],
    findReviewFacts: () => ({
      completedWorkUnits: [{
        workUnitId,
        output: {
          path: targetPath,
          operation: 'write',
          actionId,
        },
      }],
      failedWorkUnits: [],
      blockedWorkUnits: [],
      toolResults: [],
      gitReview,
    }),
    concreteContinuationExpectations: (value) => Array.isArray(value) ? value : [],
    acceptedPlanContext: () => ({ id: `accepted-${token}` }),
    acceptedPlanBatchCompletedTaskIds: () => [`task-${token}`],
    acceptedPlanAfterBatch: (acceptedPlan) => acceptedPlan,
    acceptedPlanTaskLedger: () => ({ completedTaskIds: [`task-${token}`] }),
    buildReviewFactsContext: (input) => input,
  });
  const executionRoot = `/tmp/execution-root-${token}`;
  const executionRootPlanCard = {
    id: `plan-card-${token}`,
    sessionId: `session-${token}`,
    ts: new Date(0).toISOString(),
    kind: 'plan_card',
    payload: {
      planId: `plan-${token}`,
      executionRoot: {
        ref: executionRoot,
        attachment: { kind: 'directory', path: executionRoot, absolutePath: executionRoot },
      },
    },
  } as any;
  const mismatchedGitEvent = gitReviewSummaryProjection({
    available: true,
    root: `/workspace/${token}`,
    repoRoot: `/workspace/${token}`,
    stats: { changedFiles: 1, stagedDiffBytes: 0, unstagedDiffBytes: 10 },
    files: [{ path: `unrelated-${token}.ts` }],
    summary: `wrong root ${token}`,
  }).summaryEvent({
    sessionId: `session-${token}`,
    plan: {
      sessionId: `session-${token}`,
      runId,
      planId: `plan-${token}`,
      userPlan: `plan-${token}`,
      taskPlan: { id: `implementation-${token}` },
      actionBundle: { reviewExpectations: [], continuationExpectations: [] },
    },
    kernelEvents: [],
    events: [executionRootPlanCard],
    ts: new Date(0).toISOString(),
    id: `review-git-mismatch-${token}`,
  });
  const mismatchedGitPayload = mismatchedGitEvent.payload as any;
  assertEqual(mismatchedGitPayload.gitReview.available, false, 'review projection hides git review when root differs from execution root');
  assertEqual(mismatchedGitPayload.gitReview.projectionFilter, 'executionRootMismatch', 'review projection records git root filter reason');
  assertEqual(mismatchedGitPayload.developerDetails.rawGitReview.available, true, 'review projection preserves raw git review for audit');
  assert(
    !JSON.stringify(mismatchedGitPayload.readableReview.sections).includes(`unrelated-${token}.ts`),
    'review projection does not show mismatched git files in readable review'
  );

  const matchedGitEvent = gitReviewSummaryProjection({
    available: true,
    root: executionRoot,
    repoRoot: executionRoot,
    stats: { changedFiles: 1, stagedDiffBytes: 0, unstagedDiffBytes: 12 },
    files: [{ path: targetPath }],
    summary: `right root ${token}`,
  }).summaryEvent({
    sessionId: `session-${token}`,
    plan: {
      sessionId: `session-${token}`,
      runId,
      planId: `plan-${token}`,
      userPlan: `plan-${token}`,
      taskPlan: { id: `implementation-${token}` },
      actionBundle: { reviewExpectations: [], continuationExpectations: [] },
    },
    kernelEvents: [],
    events: [executionRootPlanCard],
    ts: new Date(0).toISOString(),
    id: `review-git-match-${token}`,
  });
  const matchedGitPayload = matchedGitEvent.payload as any;
  assertEqual(matchedGitPayload.gitReview.available, true, 'review projection keeps git review when root matches execution root');
  assert(JSON.stringify(matchedGitPayload.readableReview.sections).includes(targetPath), 'review projection shows matched git files');

  const planProjection = new PlanProjectionBuilder({
    readActionBundle: (proposal) => (proposal.payload as any).actionBundle,
    requiredFileOperationsFromReport: () => [{ operation: 'delete', targetPath, capability: 'fs.delete' }],
    permissionBundlesFromReport: () => [{
      id: `bundle-${token}`,
      capability: 'fs.delete',
      resourceKind: 'workspaceFile',
      targets: [targetPath],
      operationIds: [actionId],
      toolIds: ['fs.delete'],
      permissionMode: 'ask',
      riskLevel: 'medium',
      summary: `delete ${targetPath}`,
    }],
    gateInterventionsFromReport: () => [],
    planReviewFacts: () => [`fact-${token}`],
    interactionOverlayProjection: (overlay) => overlay ? { overlayId: (overlay as any).overlayId } : {},
    visibleLanguageForRequest: () => 'en-US',
  });
  const planState = {
    sessionId: `session-${token}`,
    userRequest: `request-${token}`,
    conversationRoots: [{
      rootId: `root-${token}`,
      displayPath: `/tmp/root-${token}`,
      absolutePath: `/tmp/root-${token}`,
      source: 'attachment',
      primary: true,
    }],
    implementationBatch: {
      batchIndex: 1,
      recentPlanSummaries: [],
      continuationSummaries: [],
    },
  } as any;
  const actionBundlePlan = planProjection.actionBundlePlanCardEvent({
    state: planState,
    proposal: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-${token}`,
      runId,
      source: 'llm',
      kind: 'actionBundle',
      payload: {
        userPlan: `## Plan ${token}\n\nDelete ${targetPath} after review.`,
        actionBundle: {
          version: '1',
          id: `bundle-${token}`,
          goal: `delete ${targetPath}`,
          actions: [],
          validationExpectations: [],
          reviewExpectations: [],
        },
      },
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    },
    report: {
      proposalId: `proposal-${token}`,
      status: 'awaitingUserApproval',
      requiredPermissions: ['workspace.write'],
      diagnostics: [],
      executionContract: {
        id: `contract-${token}`,
        proposalId: `proposal-${token}`,
        status: 'awaitingUserApproval',
        catalogVersion: 'deepcode.kernel.tools.v3',
        catalogHash: `catalog-${token}`,
        operationSetHash: `operations-${token}`,
        contractHash: `contract-hash-${token}`,
        operations: [{
          id: `delete-${token}`,
          title: `Delete ${targetPath}`,
          toolId: 'fs.delete',
          args: { path: targetPath, targetKind: 'file', recursive: false },
          argsHash: `args-${token}`,
          readSet: [],
          writeSet: [targetPath],
          conflictKeys: [targetPath],
          executionMode: 'execute',
          cleanup: { leasePolicy: 'contract', failurePolicy: 'blockReviewAcceptance' },
        }],
        permissionBundles: [],
        interventions: [],
        cleanupPolicy: 'cleanupContractPerOperation',
        expiresAfter: 'reviewGateOrRunTerminal',
      },
    },
    ts: new Date(0).toISOString(),
    id: `plan-card-${token}`,
  });
  const actionPayload = actionBundlePlan.payload as any;
  assertEqual(actionBundlePlan.kind, 'plan_card', 'plan projection builds actionBundle plan card event');
  assertEqual(actionPayload.requiredFileOperations[0]?.targetPath, targetPath, 'plan projection preserves file operation target');
  assertEqual(actionPayload.content, undefined, 'plan projection does not emit markdown fallback content');
  assertEqual(actionPayload.readablePlan.schemaVersion, 'deepcode.session.readable-plan.v1', 'plan projection carries structured readable plan');
  assert(JSON.stringify(actionPayload.readablePlan.sections).includes(targetPath), 'plan projection renders operation target in structured plan sections');

  const taskPlan = planProjection.taskPlanCardEvent({
    state: planState,
    proposal: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `implementation-${token}`,
      runId,
      source: 'llm',
      kind: 'taskPlan',
      payload: {
        version: '1',
        id: `implementation-${token}`,
        title: `Implementation ${token}`,
        summary: `Implement ${targetPath}`,
        tasks: [{
          taskId: `task-${token}`,
          title: `Task ${token}`,
          target: [targetPath],
          toolId: 'fs.write',
          args: {},
          acceptanceCriteria: [`Accept ${token}`],
          failureCriteria: [`Fail ${token}`],
          dependencies: [`dependency-${token}`],
          dependsOn: [`depends-${token}`],
          dependencyDepth: 1,
        }],
      },
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    },
    authorizationReview: {
      planId: `implementation-${token}`,
      status: 'confirmable',
      diagnostics: [],
      authorizationContract: {
        id: `authorization-${token}`,
        planId: `implementation-${token}`,
        planHash: `plan-hash-${token}`,
        status: 'confirmable',
        catalogVersion: 'deepcode.kernel.tools.v3',
        catalogHash: `catalog-${token}`,
        operationSetHash: `operation-set-${token}`,
        contractHash: `authorization-hash-${token}`,
        operations: [{
          id: `authorization-operation-${token}`,
          sourceTaskId: `task-${token}`,
          toolId: 'fs.write',
          operationKind: 'fsWrite',
          contentMode: 'contentBlock',
          targets: [targetPath],
          fixedArgs: {},
          argsTemplate: { path: targetPath },
          readSet: [],
          writeSet: [targetPath],
          conflictKeys: [targetPath],
          dependsOn: [],
          executionMode: 'execute',
          internal: false,
        }],
        permissionBundles: [],
        interventions: [],
        cleanupPolicy: 'planGrantLease',
        expiresAfter: 'reviewGateOrRunTerminal',
      },
    },
    ts: new Date(0).toISOString(),
    id: `implementation-card-${token}`,
  });
  const implementationPayload = taskPlan.payload as any;
  assertEqual(implementationPayload.confirmable, true, 'plan projection keeps implementation plan confirmable');
  assertEqual(implementationPayload.content, undefined, 'implementation plan projection does not emit markdown fallback content');
  assert(JSON.stringify(implementationPayload.readablePlan.sections).includes(targetPath), 'plan projection renders implementation plan target in structured sections');
  const projectedTaskText = JSON.stringify(implementationPayload.taskPlan.tasks[0]);
  assertEqual(
    implementationPayload.taskPlan.tasks[0].dependencies[0],
    `dependency-${token}`,
    'plan projection preserves canonical task dependencies'
  );
  assert(!projectedTaskText.includes('dependsOn'), 'plan projection does not expose legacy dependsOn field');
  assert(!projectedTaskText.includes('dependencyDepth'), 'plan projection does not expose legacy dependencyDepth field');

  const decisionEvent = planProjection.planReviewDecisionEvent({
    sessionId: `session-${token}`,
    plan: {
      runId,
      planId: `plan-${token}`,
      planReviewReport: { executionContract: { id: `contract-${token}` } },
      interactionOverlay: { overlayId: `overlay-${token}` },
    },
    status: 'accepted',
    ts: new Date(0).toISOString(),
    id: `plan-decision-${token}`,
  });
  const decisionPayload = decisionEvent.payload as any;
  assertEqual(decisionEvent.kind, 'plan_review', 'plan projection creates plan review decision event');
  assertEqual(decisionPayload.messageKey, 'session.driver.planReviewAccepted', 'plan projection marks accepted plan review with i18n key');
  assertEqual(decisionPayload.facts[0], `fact-${token}`, 'plan projection preserves plan review facts');
  assertEqual(decisionPayload.overlayId, `overlay-${token}`, 'plan projection preserves interaction overlay payload');

  const rejectedDecisionEvent = planProjection.planReviewDecisionEvent({
    sessionId: `session-${token}`,
    plan: {
      runId,
      planId: `plan-${token}`,
      planReviewReport: { executionContract: { id: `contract-${token}` } },
    },
    status: 'rejected',
    ts: new Date(0).toISOString(),
    id: `plan-rejected-${token}`,
  });
  assertEqual((rejectedDecisionEvent.payload as any).messageKey, 'session.driver.planReviewRejected', 'plan projection marks rejected plan review with i18n key');
}

async function assertAgentRunReactorCoordinatesPorts(): Promise<void> {
  const token = randomSmokeToken('run-reactor');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const targetPath = `dir-${token}/file-${randomSmokeToken('file')}.txt`;
  const workUnitId = `work-unit-${token}`;
  const actionId = `action-${token}`;
  const appended: AgentEvent[][] = [];
  const deltas: ProjectionDelta[] = [];
  const kernelProjection = new KernelEventProjectionBuilder({
    requiredFileOperationsFromReport: () => [],
    permissionBundlesFromReport: () => [],
    gateInterventionsFromReport: () => [],
    planReviewFacts: () => [],
  });
  const progressProjection = new SessionProgressProjectionBuilder({
    interactionOverlayPayload: () => ({}),
    hasFailureOrBlocker: () => false,
    auditAcceptedPlanBatch: () => ({}),
    actionBundleAdmissionBatch: () => ({}),
    acceptedPlanTaskLedger: () => undefined,
    acceptedPlanPromptFrame: () => undefined,
  });
  let kernelReply: KernelReply = {
    ok: true,
    events: [
      kernelTestWorkUnitQueued({ runId, workUnitId, actionId, writeSet: [targetPath] }),
      kernelTestWorkUnitCompleted(runId, workUnitId),
    ],
  };
  const reactor = new AgentRunReactor({
    ports: {
      appendEvents: async (appendSessionId, events) => {
        appended.push(events);
        return {
          session: {
            id: appendSessionId,
            mode: 'plan',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } satisfies AgentSession,
          events,
        };
      },
      kernelCommand: async () => kernelReply,
      onProjectionDelta: async (delta) => {
        deltas.push(delta);
      },
      now: () => '2026-01-01T00:00:00.000Z',
      createId: (prefix) => `${prefix}-${token}`,
    },
    kernelProjection,
    progressProjection,
    createError: (code, message) => Object.assign(new Error(message), { code }),
    errorCode: (error, fallback) => typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : fallback,
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
  });
  const state = { sessionId, runId };
  await reactor.emitProjectionDelta(state, {
    type: 'stage_delta',
    stage: 'provider_call',
    status: 'running',
    channel: 'progress',
    source: 'provider',
    summary: `stage-${token}`,
  });
  assertEqual(deltas.length, 1, 'agent run reactor emits projection deltas through ports');
  assertEqual(deltas[0]?.sessionId, sessionId, 'agent run reactor attaches session id');
  assertEqual(deltas[0]?.runId, runId, 'agent run reactor attaches run id');
  assertEqual(deltas[0]?.seq, 1, 'agent run reactor advances active turn sequence');

  const projected = await reactor.appendProjectedKernelEvents(sessionId, kernelReply);
  assertEqual(projected.events.length, 2, 'agent run reactor projects kernel events');
  assertEqual(appended.at(-1)?.length, 2, 'agent run reactor appends projected kernel events');

  await reactor.emitKernelActivityDeltas(state, kernelReply.events ?? [], 'kernel_activity');
  assert(
    deltas.some((delta) => delta.type === 'workunit_delta' && delta.targetPath === targetPath),
    'agent run reactor emits enriched kernel activity deltas'
  );

  kernelReply = {
    ok: false,
    error: {
      code: `kernel-${token}`,
      message: `kernel message ${token}`,
    },
    events: [],
  };
  const audit = await reactor.tryKernelAudit(
    sessionId,
    { command: { kind: 'runCreate', requestId: `request-${token}`, sessionId, input: {} } } as KernelCommandEnvelope,
    'session_run_state',
    `audit-${token}`
  );
  assertEqual(audit.events[0]?.kind, 'session_run_state', 'agent run reactor records audit failures as trace events');
  assertEqual((audit.events[0]?.payload as any)?.errorCode, `kernel-${token}`, 'agent run reactor preserves audit error code');
  try {
    await reactor.kernel({ command: { kind: 'runCreate', requestId: `request-${token}`, sessionId, input: {} } } as KernelCommandEnvelope);
  } catch (error) {
    assertEqual((error as any).code, `kernel-${token}`, 'agent run reactor wraps kernel failures with loop error code');
    return;
  }
  throw new Error('expected agent run reactor kernel failure');
}

function assertDriverActivityBuilderCreatesReadModels(): void {
  const token = randomSmokeToken('activity-builder');
  const runId = `run-${token}`;
  const planId = `plan-${token}`;
  const targetPath = `dir-${token}/file-${randomSmokeToken('file')}.txt`;
  const builder = new DriverActivityBuilder({
    providerStageSummary: (stage, part, language) => `${stage}:${part}:${language}`,
    visibleLanguageForRequest: () => 'en-US',
    actionFileTargetPath: (action) => {
      const args = action.args && typeof action.args === 'object' && !Array.isArray(action.args)
        ? action.args as Record<string, unknown>
        : undefined;
      return typeof args?.path === 'string' ? args.path : undefined;
    },
  });
  const generic = builder.conversationActivity({
    activityId: `activity-${token}`,
    kind: 'toolExecution',
    status: 'running',
    title: 'Generic activity',
    summary: 'Generic activity summary',
    source: 'session',
    runId,
    targets: [targetPath, targetPath],
    actionIds: [`action-${token}`, `action-${token}`],
    workUnitIds: [`work-${token}`, `work-${token}`],
  });
  assertEqual(generic.targets?.length, 1, 'driver activity builder deduplicates targets');
  assertEqual(generic.actionIds?.length, 1, 'driver activity builder deduplicates action ids');
  assertEqual(generic.workUnitIds?.length, 1, 'driver activity builder deduplicates work unit ids');
  const provider = builder.providerActivity({
    runId,
    userRequest: `Request ${token}`,
    stage: `stage-${token}`,
    status: 'running',
  });
  assertEqual(provider.summary, `stage-${token}:request:en-US`, 'driver activity builder uses provider stage summary port');
  const batch = {
    actionBundle: {
      actions: [{
        actionId: `action-${token}`,
        toolId: 'fs.write',
        args: { path: targetPath },
        description: `Write ${token}`,
      }],
    },
  };
  const acceptedActivity = builder.acceptedPlanBatchActivity({
    accepted: {
      planId,
      runId,
      title: 'Accepted activity plan',
      summary: 'Accepted activity plan summary',
      tasks: [],
      authorizationOperations: [],
      toolIds: [],
      targetScopes: [],
      batchIndex: 2,
      completedTaskIds: [],
      dependencyFacts: [],
      rawPlan: {},
    } as AcceptedTaskPlanContext,
    batch,
    status: 'running',
  });
  assertEqual(acceptedActivity.targets?.[0], targetPath, 'driver activity builder extracts batch target path');
  assertEqual(acceptedActivity.itemCount, 1, 'driver activity builder counts batch actions');
  assertEqual(builder.batchActionRecords(batch).length, 1, 'driver activity builder reads canonical action bundles');
  const proposal = {
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `proposal-${token}`,
    runId,
    sessionId: `session-${token}`,
    source: 'llm',
    kind: 'actionBundle',
    payload: {
      actionBundle: {
        id: `bundle-${token}`,
        version: '1',
        goal: `Goal ${token}`,
        actions: batch.actionBundle.actions,
        validationExpectations: [],
        reviewExpectations: [],
      },
      contentBlocks: [],
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  } as ProposalEnvelope;
  assertEqual(builder.readActionBundle(proposal)?.id, `bundle-${token}`, 'driver activity builder reads actionBundle proposal payload');
  assertEqual(builder.proposalActionBundleAdmissionBatch(proposal).planId, `bundle-${token}`, 'driver activity builder builds admission batch read-model');
}

function assertAssistantProjectionBuilderCreatesConversationEvents(): void {
  const token = randomSmokeToken('assistant-projection');
  const builder = new AssistantProjectionBuilder({
    visibleLanguageForRequest: () => 'en-US',
    guidanceRevisionTransitionMessage: (language) => `transition-${language}-${token}`,
  });
  const proposal: ProposalEnvelope = {
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `proposal-${token}`,
    runId: `run-${token}`,
    source: 'llm',
    kind: 'answer',
    narration: `narration-${token}`,
    payload: {
      answer: {
        content: `answer-${token}`,
      },
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  };
  const answer = builder.answerEvent(`session-${token}`, proposal, '2026-01-01T00:00:00.000Z', `answer-${token}`);
  assertEqual(answer.kind, 'assistant_msg', 'assistant projection creates answer event');
  assertEqual((answer.payload as any).channel, 'final', 'assistant projection marks answer final');
  assertEqual((answer.payload as any).content, `answer-${token}`, 'assistant projection extracts answer content');

  const diagnostic = builder.finalDiagnosticEvent(
    `session-${token}`,
    { code: `code-${token}`, fallback: `fallback-${token}`, params: { token } },
    '2026-01-01T00:00:01.000Z',
    `diagnostic-${token}`
  );
  assertEqual((diagnostic.payload as any).diagnosticCode, `code-${token}`, 'assistant projection preserves diagnostic code');
  assertEqual((diagnostic.payload as any).diagnosticParams.token, token, 'assistant projection preserves diagnostic params');

  const reasoning = builder.reasoningEvent(`session-${token}`, `reasoning-${token}`, '2026-01-01T00:00:02.000Z', `reasoning-${token}`);
  assertEqual((reasoning.payload as any).channel, 'reasoning', 'assistant projection marks provider reasoning');
  assertEqual((reasoning.payload as any).presentation, 'collapsible', 'assistant projection keeps reasoning collapsible');
  const longReasoning = builder.reasoningEvent(`session-${token}`, `${token}-`.repeat(1000), '2026-01-01T00:00:02.500Z', `long-reasoning-${token}`);
  assert(
    String((longReasoning.payload as any).content ?? '').length <= VISIBLE_REASONING_MAX_CHARS,
    'assistant projection bounds visible provider reasoning content'
  );
  assertEqual((longReasoning.payload as any).reasoningProjectionTruncated, true, 'assistant projection marks truncated reasoning');

  const progressProposal: ProposalEnvelope = { ...proposal, kind: 'taskPlan' };
  const narration = builder.proposalNarrationEvent(
    `session-${token}`,
    progressProposal,
    '2026-01-01T00:00:03.000Z',
    `narration-${token}`
  );
  assertEqual((narration?.payload as any).channel, 'progress', 'assistant projection creates narration progress event');

  const transition = builder.guidanceRevisionTransitionEvent(
    `session-${token}`,
    `run-${token}`,
    [`guidance-${token}`],
    `request-${token}`,
    '2026-01-01T00:00:04.000Z',
    `transition-${token}`
  );
  assertEqual((transition.payload as any).content, `transition-en-US-${token}`, 'assistant projection uses guidance transition port');

  const overlay = builder.guidanceRevisionOverlay(`request-${token}`, proposal, [{
    id: `guidance-${token}`,
    source: 'user',
    checkpointKind: 'nextProviderCall',
    content: `guidance-${token}`,
  }]);
  assert(overlay.includes(`guidance-${token}`), 'assistant projection guidance overlay preserves guidance ids');

  const decisionAnswer = builder.decisionEffectAnswerProposal({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    proposalId: `decision-answer-${token}`,
    completedTasks: 2,
    totalTasks: 3,
    pendingTasks: 1,
    reason: `reason-${token}`,
    guidance: `guidance-${token}`,
    language: 'en-US',
  });
  assertEqual(decisionAnswer.kind, 'answer', 'assistant projection creates decision-effect answer proposal');
  assert(
    String((decisionAnswer.payload as any).answer.content).includes('Completed tasks: 2'),
    'assistant projection renders decision-effect answer ledger summary'
  );
}

function assertSessionProgressProjectionBuilderCreatesRunAndCheckpointEvents(): void {
  const token = randomSmokeToken('session-progress');
  const taskId = `task-${token}`;
  const targetPath = `target-${token}.txt`;
  const builder = new SessionProgressProjectionBuilder({
    interactionOverlayPayload: (overlay) => overlay ? { overlayRunId: overlay.parentRunId } : {},
    hasFailureOrBlocker: (events) => events.some((event) => (event as any).kind === 'work_unit.failed'),
    auditAcceptedPlanBatch: (batch) => ({
      actions: Array.isArray((batch as any).actions)
        ? (batch as any).actions.map((action: any) => ({
            actionId: action.actionId,
            toolId: action.toolId,
            targetPath: action.args?.path,
          }))
        : [{ actionId: `action-${token}`, targetPath }],
    }),
    actionBundleAdmissionBatch: () => ({
      actions: [{
        actionId: `admission-action-${token}`,
        toolId: 'fs.write',
        args: { path: targetPath, contentBlockId: `block-${token}` },
      }],
    }),
    acceptedPlanTaskLedger: (accepted) => buildTaskLedgerSnapshot({
      planId: accepted.planId,
      runId: accepted.runId,
      tasks: accepted.tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title ?? task.taskId,
        targets: task.targets,
        toolId: task.toolId,
      })),
      completedTaskIds: accepted.completedTaskIds,
    }),
    acceptedPlanPromptFrame: (accepted, taskLedger) => taskLedger
      ? buildAcceptedPlanPromptFrame({
        planId: accepted.planId,
        runId: accepted.runId,
        title: `Plan ${token}`,
        summary: `Plan summary ${token}`,
        taskLedger,
      })
      : undefined,
  });
  const runState = builder.sessionRunStateEvent({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    phase: 'executing_accepted_plan',
    reason: 'accepted_plan_execution',
    decisionOwner: {
      kind: 'plan',
      runId: `run-${token}`,
      planId: `plan-${token}`,
    },
    interactionOverlay: {
      parentPhase: 'executing_accepted_plan',
      parentRunId: `run-${token}`,
      interactionRunId: `interaction-run-${token}`,
      interactionId: `interaction-${token}`,
    },
    ts: '2026-01-01T00:00:00.000Z',
    id: `run-state-${token}`,
  });
  assertEqual(runState.kind, 'session_run_state', 'session progress projection creates run state events');
  assertEqual((runState.payload as any).messageKey, 'session.runState.acceptedPlanExecution', 'session progress projection uses run-state i18n key');
  assertEqual((runState.payload as any).overlayRunId, `run-${token}`, 'session progress projection preserves overlay payload');

  const trace = builder.traceEvent({
    sessionId: `session-${token}`,
    kind: 'trace/plan_accept_noop',
    summary: `noop-${token}`,
    extra: { runId: `run-${token}`, planId: `plan-${token}` },
    ts: '2026-01-01T00:00:00.250Z',
    id: `trace-${token}`,
  });
  assertEqual(trace.kind, 'trace/plan_accept_noop', 'session progress projection creates generic trace events');
  assertEqual((trace.payload as any).planId, `plan-${token}`, 'session progress projection preserves trace payload');

  const cache = builder.cacheTelemetryEvent({
    sessionId: `session-${token}`,
    profileId: `profile-${token}`,
    provider: `provider-${token}`,
    model: `model-${token}`,
    stage: `stage-${token}`,
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 7 },
    },
    promptSegmentDigests: [{
      id: `segment-${token}`,
      name: `Segment ${token}`,
      cacheClass: 'dynamic',
      contentHash: `hash-${token}`,
      charLength: 42,
    }],
    stablePrefixHash: `stable-${token}`,
    dynamicSuffixHash: `dynamic-${token}`,
    finalUserPromptHash: `final-user-${token}`,
    finalUserPromptCharLength: 2048,
    cacheHash: `cache-${token}`,
    ts: '2026-01-01T00:00:00.500Z',
    id: `cache-${token}`,
  });
  assert(cache, 'session progress projection emits cache telemetry when usage or segments exist');
  assertEqual((cache?.payload as any).promptCacheHitTokens, 7, 'session progress projection normalizes cache usage tokens');
  assertEqual((cache?.payload as any).promptSegmentDigests[0].id, `segment-${token}`, 'session progress projection preserves prompt segment digests');
  assertEqual((cache?.payload as any).finalUserPromptHash, `final-user-${token}`, 'session progress projection preserves final user prompt hash');
  assertEqual((cache?.payload as any).finalUserPromptCharLength, 2048, 'session progress projection preserves final user prompt length');

  const accepted: AcceptedTaskPlanContext = {
    planId: `plan-${token}`,
    runId: `run-${token}`,
    tasks: [{
      taskId,
      title: `Task ${token}`,
      toolId: 'fs.write',
      targets: [targetPath],
      dependencies: [],
      planningArgs: {},
      conflictKeys: [],
    }],
    authorizationOperations: [],
    toolIds: ['fs.write'],
    targetScopes: [targetPath],
    batchIndex: 1,
    completedTaskIds: [],
    dependencyFacts: [],
    rawPlan: {},
  };
  const checkpoint = builder.acceptedPlanBatchCheckpointEvent(
    `session-${token}`,
    `run-${token}`,
    accepted,
    {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-${token}`,
      runId: `run-${token}`,
      source: 'llm',
      kind: 'actionBundle',
      payload: {},
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    },
    [],
    {
      actionIds: [`action-${token}`],
      targetPaths: [targetPath],
      workUnitIds: [`work-unit-${token}`],
      newlyCompletedTaskIds: [taskId],
      completedTaskIds: [taskId],
      remainingTaskIds: [],
    },
    '2026-01-01T00:00:01.000Z',
    `checkpoint-${token}`
  );
  const payload = checkpoint.payload as any;
  assertEqual(payload.stage, 'accepted_plan.batch_checkpoint', 'session progress projection creates accepted-plan checkpoint');
  assertEqual(payload.taskLedger.completedTaskIds[0], taskId, 'session progress projection builds task ledger');
  assertEqual(payload.activity.kind, 'reviewCheckpoint', 'session progress projection marks complete accepted plan for review');

  const resume = builder.acceptedPlanResourceResumeEvent(
    `session-${token}`,
    `run-${token}`,
    accepted,
    {
      cursorId: `cursor-${token}`,
      planId: `plan-${token}`,
      currentTaskId: taskId,
      taskOrder: [taskId],
      pendingTaskIds: [taskId],
      completedTaskIds: [],
      lastResourcePacketIds: [`packet-previous-${token}`],
    },
    {
      taskId,
      taskTitle: `Task ${token}`,
      goal: `Goal ${token}`,
      targets: [targetPath],
      toolIds: ['fs.write'],
      taskOrder: [taskId],
      pendingTaskIds: [taskId],
      dependsOn: [],
      evidenceNeeds: [],
      completedTaskIds: [],
    },
    {
      id: `packet-${token}`,
      workspaceScopeKey: `workspace-${token}`,
      requestId: `request-${token}`,
      items: [{
        requestItemId: `request-item-${token}`,
        manifestEntryId: `manifest-${token}`,
        readPolicy: 'autoRead',
        status: 'provided',
        contentKind: 'text',
        promptContent: `content-${token}`,
        evidenceRefs: [`evidence-${token}`],
      }],
    },
    '2026-01-01T00:00:01.500Z',
    `resource-resume-${token}`
  );
  assertEqual((resume.payload as any).stage, 'accepted_plan.resource_resume', 'session progress projection creates resource resume events');
  assertEqual((resume.payload as any).messageKey, 'session.driver.acceptedPlanResourceResume', 'session progress projection marks resource resume with i18n key');
  assertEqual((resume.payload as any).resourceItemCount, 1, 'session progress projection preserves resource resume packet count');

  const savepoint = builder.acceptedPlanTaskSavepointEvent(
    `session-${token}`,
    `run-${token}`,
    accepted,
    { ...accepted, completedTaskIds: [taskId], batchIndex: 2 },
    {
      actionIds: [`action-${token}`],
      targetPaths: [targetPath],
      workUnitIds: [`work-unit-${token}`],
      newlyCompletedTaskIds: [taskId],
      completedTaskIds: [taskId],
      remainingTaskIds: [],
    },
    [],
    {
      cursorId: `cursor-${token}`,
      planId: `plan-${token}`,
      currentTaskId: taskId,
      taskOrder: [taskId],
      pendingTaskIds: [taskId],
      completedTaskIds: [],
      lastResourcePacketIds: [],
    },
    {
      taskId,
      taskTitle: `Task ${token}`,
      goal: `Goal ${token}`,
      targets: [targetPath],
      toolIds: ['fs.write'],
      taskOrder: [taskId],
      pendingTaskIds: [taskId],
      dependsOn: [],
      evidenceNeeds: [],
      completedTaskIds: [],
    },
    '2026-01-01T00:00:01.750Z',
    `task-savepoint-${token}`
  );
  assertEqual((savepoint.payload as any).stage, 'accepted_plan.task_savepoint', 'session progress projection creates task savepoint events');
  assertEqual((savepoint.payload as any).messageKey, 'session.driver.acceptedPlanTaskSavepointComplete', 'session progress projection marks completed savepoint with i18n key');
  assertEqual((savepoint.payload as any).acceptedPlanPromptFrame.taskLedger.completedTaskIds[0], taskId, 'session progress projection stores accepted-plan prompt frame');

  const preflight = builder.acceptedPlanActionBatchPreflightEvent(
    `session-${token}`,
    { runId: `run-${token}`, planId: `plan-${token}` },
    { actions: [{ actionId: `preflight-action-${token}`, targetPath }] },
    '2026-01-01T00:00:02.000Z',
    `preflight-${token}`
  );
  assertEqual((preflight.payload as any).stage, 'accepted_plan.action_batch_preflight', 'session progress projection creates preflight events');
  assertEqual((preflight.payload as any).messageKey, 'session.driver.acceptedPlanActionBatchPreflight', 'session progress projection marks preflight with i18n key');

  const admissionRepair = builder.actionBundleAdmissionRepairingEvent(
    `session-${token}`,
    `run-${token}`,
    {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-repair-${token}`,
      runId: `run-${token}`,
      source: 'llm',
      kind: 'actionBundle',
      payload: {
        actionBundle: {
          actions: [{
            actionId: `repair-action-${token}`,
            toolId: 'fs.write',
            args: { path: targetPath, contentBlockId: `block-${token}` },
            description: `Update ${targetPath}`,
            dependsOn: [],
          }],
        },
      },
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    },
    [`reason-${token}`],
    '2026-01-01T00:00:03.000Z',
    `admission-repair-${token}`
  );
  assertEqual((admissionRepair.payload as any).stage, 'action_bundle_admission.repairing', 'session progress projection creates admission repair events');
  assertEqual((admissionRepair.payload as any).messageKey, 'session.driver.actionBundleAdmissionRepairing', 'session progress projection marks admission repair with i18n key');
  assertEqual((admissionRepair.payload as any).activity.targets[0], targetPath, 'session progress projection extracts admission repair targets from audit');
}

function assertSessionFailureProjectionBuilderCreatesFailureEvents(): void {
  const token = randomSmokeToken('session-failure');
  const targetPath = `target-${token}.txt`;
  const builder = new SessionFailureProjectionBuilder({
    actionBatchFailureDetails: () => [{
      status: 'failed',
      workUnitId: `work-unit-${token}`,
      actionId: `action-${token}`,
      message: `message-${token}`,
      code: `code-${token}`,
      writeSet: [targetPath],
    }],
    actionBatchFailureSummary: (failure) => `${failure.actionId}:${failure.code}`,
    sessionRunStateEvent: (input) => ({
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'session_run_state',
      payload: {
        runId: input.runId,
        reason: input.reason,
        status: input.status,
        decisionOwner: input.decisionOwner,
      },
    }),
  });

  const admission = builder.actionBundleAdmissionFailureEvents(
    `session-${token}`,
    `run-${token}`,
    {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-${token}`,
      runId: `run-${token}`,
      source: 'llm',
      kind: 'actionBundle',
      payload: {},
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    },
    [`reason-${token}`],
    '2026-01-01T00:00:00.000Z',
    `admission-${token}`
  );
  assertEqual(admission[0].kind, 'error', 'session failure projection creates admission failure error event');
  assertEqual((admission[0].payload as any).messageKey, 'session.driver.actionBundleAdmissionFailed', 'session failure projection marks admission failure with i18n key');
  assertEqual(admission[1].kind, 'session_run_state', 'session failure projection appends failed run state');

  const batchFailure = builder.acceptedPlanExecutionFailureEvents(
    `session-${token}`,
    `run-${token}`,
    {
      planId: `plan-${token}`,
      runId: `run-${token}`,
      tasks: [],
      authorizationOperations: [],
      toolIds: [],
      targetScopes: [],
      batchIndex: 3,
      completedTaskIds: [],
      dependencyFacts: [],
      rawPlan: {},
    },
    [],
    { actions: [{ actionId: `action-${token}`, targetPath }] },
    '2026-01-01T00:00:01.000Z',
    `batch-${token}`
  );
  assertEqual((batchFailure[0].payload as any).stage, 'accepted_plan.batch_failed', 'session failure projection creates accepted-plan batch failure stage');
  assertEqual((batchFailure[0].payload as any).messageKey, 'session.driver.acceptedPlanBatchFailed', 'session failure projection marks batch failure with i18n key');
  assertEqual((batchFailure[0].payload as any).activity.targets[0], targetPath, 'session failure projection preserves failed write set target');

  const normalization = builder.acceptedPlanNormalizationFailureEvents(
    `session-${token}`,
    `run-${token}`,
    {
      planId: `plan-${token}`,
      runId: `run-${token}`,
      tasks: [],
      authorizationOperations: [],
      toolIds: [],
      targetScopes: [],
      batchIndex: 1,
      completedTaskIds: [],
      dependencyFacts: [],
      rawPlan: {},
    },
    [`reason-${token}`],
    '2026-01-01T00:00:02.000Z',
    `normalization-${token}`
  );
  assertEqual((normalization[0].payload as any).messageKey, 'session.driver.acceptedPlanBatchNormalizationFailed', 'session failure projection marks normalization failure with i18n key');
}

function assertPlanReviewReportAnalyzerKeepsReviewSemantics(): void {
  const token = randomSmokeToken('plan-review-analyzer');
  const targetPath = `target-${token}.txt`;
  const analyzer = new PlanReviewReportAnalyzer({
    requiredFileOperationsFromReport: () => [{ operation: 'write', targetPath, toolId: 'fs.write' }],
  });
  const reviewed = analyzer.findReport([{
    kind: 'proposal.reviewed',
    report: {
      proposalId: `proposal-${token}`,
      status: 'denied',
      requiredPermissions: [],
      diagnostics: [`evidence-${token}`],
      executionContract: {
        permissionBundles: [],
        interventions: [],
      },
    },
  }]);
  assert(Boolean(reviewed), 'plan review analyzer finds proposal.reviewed report');
  assertEqual(analyzer.needsRepair(reviewed as Record<string, unknown>), true, 'plan review analyzer preserves repairable finding semantics');
  assert(analyzer.diagnosticSummary(reviewed as Record<string, unknown>).includes(`evidence-${token}`), 'plan review analyzer keeps diagnostic messages');
  const facts = analyzer.facts(reviewed);
  assert(facts.some((fact) => fact.includes(targetPath)), 'plan review analyzer includes required file operation facts');
  assertEqual(
    planInteractionAwaitsDecision({ planId: `plan-${token}`, status: 'pending' }),
    false,
    'plan interaction rejects cards that are not explicitly confirmable'
  );
  assertEqual(
    planInteractionAwaitsDecision({
      planId: `task-plan-${token}`,
      status: 'confirmable',
      confirmable: true,
      taskPlan: { id: `task-plan-${token}` },
    }),
    true,
    'plan interaction preserves an explicit Kernel-authorized task-plan decision'
  );
  assertEqual(
    planInteractionAwaitsDecision({ planId: `plan-${token}`, status: 'accepted', confirmable: false }),
    false,
    'plan interaction rejects resolved plan cards'
  );
  assertEqual(
    planInteractionAwaitsDecision({ planId: `plan-${token}`, status: 'awaitingUserApproval', confirmable: true }),
    true,
    'plan interaction detects explicit waiting plan review events'
  );
  assertEqual(
    planInteractionAwaitsDecision({ planId: `plan-${token}`, confirmable: false, status: 'pending' }),
    false,
    'plan interaction respects non-confirmable plan review events'
  );
  assertEqual(
    analyzer.acceptedPlanNeedsRepair({
      status: 'denied',
      diagnostics: [`access scope must not be the workspace root ${token}`],
    }),
    true,
    'plan review analyzer keeps accepted-plan access-scope repair semantics'
  );
  assertEqual(analyzer.denied({ status: 'denied' }), true, 'plan review analyzer preserves denied status semantics');
}

function assertPlanReviewGrantProjectorBuildsExecutionReadModels(): void {
  const token = randomSmokeToken('plan-review-grants');
  const fileTarget = `dir-${token}/file-${token}.txt`;
  const directoryTarget = `dir-${token}/`;
  const projector = new PlanReviewGrantProjector();
  const report = {
    proposalId: `proposal-${token}`,
    status: 'awaitingUserApproval',
    requiredPermissions: ['workspace.write'],
    diagnostics: [],
    executionContract: {
      id: `contract-${token}`,
      proposalId: `proposal-${token}`,
      status: 'awaitingUserApproval',
      catalogVersion: 'deepcode.kernel.tools.v3',
      catalogHash: `catalog-${token}`,
      operationSetHash: `operations-${token}`,
      contractHash: `contract-hash-${token}`,
      operations: [{
        id: `write-${token}`,
        title: `Write ${fileTarget}`,
        toolId: 'fs.write',
        args: { path: fileTarget },
        argsHash: `write-args-${token}`,
        readSet: [],
        writeSet: [fileTarget],
        conflictKeys: [fileTarget],
        executionMode: 'execute',
        cleanup: {},
      }, {
        id: `delete-${token}`,
        title: `Delete ${directoryTarget}`,
        toolId: 'fs.delete',
        args: { path: directoryTarget, targetKind: 'directory', recursive: true },
        argsHash: `delete-args-${token}`,
        readSet: [],
        writeSet: [directoryTarget],
        conflictKeys: [directoryTarget],
        executionMode: 'execute',
        cleanup: {},
      }],
      permissionBundles: [{
        id: `bundle-${token}`,
        capability: 'workspace.write',
        permissionMode: 'ask',
        risk: 'high',
        resourceKind: 'workspacePath',
        operationIds: [`write-${token}`, `delete-${token}`],
        toolIds: ['fs.write', 'fs.delete'],
        targets: [fileTarget, directoryTarget],
        expiresAfter: 'reviewGateOrRunTerminal',
      }],
      interventions: [{
        id: `intervention-${token}`,
        interventionKind: 'permission',
        status: 'pending',
        permissionBundleId: `bundle-${token}`,
        summary: `summary-${token}`,
        affectedOperationIds: [`write-${token}`, `delete-${token}`],
      }],
      cleanupPolicy: 'cleanupContractPerOperation',
      expiresAfter: 'reviewGateOrRunTerminal',
    },
  };

  const operations = projector.requiredFileOperationsFromReport(report);
  assertEqual(operations.length, 2, 'grant projector keeps required file operations');
  assertEqual(operations[1]?.targetResourceKind, 'directory', 'grant projector preserves directory targets');
  assertEqual(operations[1]?.targetPath, directoryTarget, 'grant projector preserves the Kernel-authored directory target exactly');
  const bundles = projector.permissionBundlesFromReport(report);
  assertEqual(bundles[0]?.id, `bundle-${token}`, 'grant projector reads execution contract permission bundles');
  assertEqual(bundles[0]?.targets[0], fileTarget, 'grant projector does not recompute Kernel permission targets');
  assertEqual(bundles[0]?.riskLevel, 'high', 'grant projector preserves Kernel risk classification');
  const interventions = projector.gateInterventionsFromReport(report);
  assertEqual(interventions[0]?.id, `intervention-${token}`, 'grant projector reads execution contract interventions');
  assertEqual(interventions[0]?.permissionBundleId, `bundle-${token}`, 'grant projector preserves Kernel gate ownership');
  assertEqual(projector.kernelExecutionContractId(report), `contract-${token}`, 'grant projector preserves Kernel contract identity');
  assertEqual(projector.kernelExecutionContractHash(report), `contract-hash-${token}`, 'grant projector preserves Kernel contract hash');
}

function assertAcceptedPlanTargetParserUsesCanonicalTarget(): void {
  const token = randomSmokeToken('target-parser');
  const first = `src-${token}/first-${token}.txt`;
  const second = `src-${token}/second-${token}.txt`;
  const third = `src-${token}/third-${token}.txt`;
  const parser = new AcceptedPlanTargetParser();
  const targets = parser.taskTargets({
    target: `./${first}`,
    targets: [`${second},${third}`],
    fileOperations: [{
      targetRef: { path: `generated-${token}/artifact-${token}.txt` },
    }],
  });
  assert(targets.includes(first), 'target parser normalizes direct task target');
  assertEqual(targets.includes(second), false, 'target parser ignores removed targets compatibility input');
  assertEqual(targets.includes(third), false, 'target parser does not expand removed target-list aliases');
  assertEqual(
    targets.includes(`generated-${token}/artifact-${token}.txt`),
    false,
    'target parser ignores removed file-operation compatibility input'
  );
}


function assertAcceptedTaskPlanContextBuilderBuildsRuntimeContext(): void {
  const token = randomSmokeToken('accepted-context');
  const fileTarget = `src-${token}/file-${token}.txt`;
  const targetParser = new AcceptedPlanTargetParser();
  const builder = new AcceptedTaskPlanContextBuilder({
    normalizePlanScope: (value) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim(),
    uniqueStrings: (values) => [...new Set(values.filter((item): item is string => Boolean(item)))],
    acceptedPlanTaskTargets: (record) => targetParser.taskTargets(record),
  });
  const accepted = builder.build({
    plan: {
      planId: `plan-${token}`,
      planHash: `plan-hash-${token}`,
      authorizationContractId: `authorization-${token}`,
      authorizationContractHash: `authorization-hash-${token}`,
      runId: `run-${token}`,
      taskPlan: {
        title: `Title ${token}`,
        summary: `Summary ${token}`,
        tasks: [{
          taskId: `task-${token}`,
          title: `Task ${token}`,
          toolId: 'fs.write',
          target: [fileTarget],
          args: {},
          batchKind: 'sourceCode',
        }],
      },
    },
    interventionLevel: 'medium',
  });
  assertEqual(accepted.planId, `plan-${token}`, 'accepted context builder keeps plan id');
  assertEqual(accepted.tasks[0]?.taskId, `task-${token}`, 'accepted context builder builds task contexts');
  assert(accepted.toolIds.includes('fs.write'), 'accepted context builder includes task toolIds');
  assert(accepted.targetScopes.includes(fileTarget), 'accepted context builder includes task target scopes');
  assertEqual(accepted.planHash, `plan-hash-${token}`, 'accepted context builder keeps the user-confirmed plan hash');
  assertEqual(accepted.authorizationContractId, `authorization-${token}`, 'accepted context builder keeps Kernel authorization identity');
  assertEqual(accepted.authorizationContractHash, `authorization-hash-${token}`, 'accepted context builder keeps Kernel authorization hash');
  assertEqual('accessScopes' in accepted, false, 'accepted context has no Session-owned permission scopes');
  assertEqual('exactOperationGrants' in accepted, false, 'accepted context has no Session-owned exact grants');
  assertEqual(accepted.interventionLevel, 'medium', 'accepted context builder keeps intervention level');
}

function assertProtocolGateCanonicalizesBareRepair(): void {
  const token = randomSmokeToken('protocol-gate');
  const gate = new ProtocolGate({
    ensureReviewableExpectations: () => undefined,
    validateProposalSemantics: () => undefined,
  });
  assertThrows(() => gate.parseAndValidateRepairedProposal({
    raw: {
      schemaVersion: '1.0',
      kind: 'taskPlan',
      taskPlan: {
        title: `Version plan ${token}`,
        summary: `Version summary ${token}`,
        tasks: [
          {
            taskId: `version-task-${token}`,
            title: `Version task ${token}`,
            toolId: 'fs.read',
            target: [`version-target-${token}.txt`],
            args: {},
            acceptanceCriteria: [`version-accepted-${token}`],
            failureCriteria: [`version-failed-${token}`],
          },
        ],
      },
    },
    runId: `run-version-${token}`,
    sessionId: `session-version-${token}`,
    source: 'llm',
    allowedKinds: ['taskPlan'],
  }), 'schemaVersion must be deepcode.agent.protocol.v4');
  const decision = gate.parseAndValidateRepairedProposal({
    raw: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'decisionRequest',
      decisionRequest: {
        question: `Question ${token}?`,
        options: [
          { id: `first-${token}`, label: `First ${token}`, description: `First choice ${token}`, recommended: true },
          { id: `second-${token}`, label: `Second ${token}`, description: `Second choice ${token}` },
        ],
        allowsFreeform: true,
      },
    },
    runId: `run-decision-${token}`,
    source: 'llm',
    allowedKinds: ['decisionRequest'],
  });
  assertEqual(decision.kind, 'decisionRequest', 'protocol gate accepts canonical repaired decision request');
  assertEqual(
    gate.repairAllowedKinds({ acceptedPlanActive: true, errorCode: `error-${token}` }).includes('taskPlan'),
    false,
    'protocol gate does not allow planning kinds during accepted-plan repair'
  );
}

async function assertSessionDriverLoopProjectsDecisionRequest(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-requirement-auto',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return semanticToolLlmResponse('session.request_decision', {
        question: 'A generic user decision is required before planning.',
        summary: 'Choose how to proceed with the generic side-effect task.',
        options: [
          { id: 'recommended', label: 'Proceed', description: 'Generate the next reviewable plan.', recommended: true },
          { id: 'stop', label: 'Stop', description: 'Do not generate an implementation plan.' },
        ],
        allowsFreeform: true,
      }, 'decision-generic-auto');
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-requirement-auto',
    content: 'Create a generic workspace change.',
  });
  assertEqual(llmCalls, 1, 'decisionRequest is produced by provider once');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'decisionRequest projects to a user intervention card');
  const confirmation = result.events.find((event) => event.kind === 'requirement_confirmation');
  const confirmationPayload = confirmation?.payload as Record<string, unknown> | undefined;
  assertEqual(confirmationPayload?.interactionOverlay, true, 'decisionRequest is projected as an interaction overlay');
  assertEqual(confirmationPayload?.parentRunId, confirmationPayload?.runId, 'decisionRequest overlay keeps the parent run id');
  assertEqual(confirmationPayload?.interactionRunId, confirmationPayload?.runId, 'decisionRequest overlay records the interaction run id');
  assertEqual(confirmationPayload?.sourceInteractionId, confirmationPayload?.requirementId, 'decisionRequest overlay records its source interaction id');
  assertEqual(
    String(confirmationPayload?.content ?? '').includes('## Options'),
    true,
    'decisionRequest renders as an option selection card'
  );
  assertEqual(
    JSON.stringify((confirmationPayload?.requirement as any)?.checklist?.explicitTasks ?? []).includes('Proceed'),
    false,
    'decisionRequest options are not copied into requirement checklist tasks'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.phase === 'waiting_requirement_confirmation' &&
      (event.payload as any)?.reason === 'requirement'
    ),
    true,
    'decisionRequest waits in requirement confirmation phase'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.phase === 'waiting_plan_review' &&
      (event.payload as any)?.reason === 'requirement'
    ),
    false,
    'decisionRequest does not masquerade as plan review waiting state'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'decisionRequest does not generate a plan before user decision');
}

async function assertSessionDriverLoopStopsBeforeProviderWhenProjectRootIsUnavailable(): Promise<void> {
  const token = randomSmokeToken('project-root-unavailable');
  const sessionId = `session-${token}`;
  const events: AgentEvent[] = [];
  const session: AgentSession = {
    id: sessionId,
    projectId: `project-${token}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let kernelCalls = 0;
  let llmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      kernelCalls += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return semanticToolLlmResponse('session.submit_answer', {
        content: `Unexpected provider response for ${token}.`,
      }, `answer-${token}`);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId,
    content: `Inspect the unavailable project ${token}.`,
    projectId: `project-${token}`,
    projectKind: 'folder',
    projectRootStatus: 'unavailable',
  });

  assertEqual(kernelCalls, 0, 'unavailable project root stops before Kernel run creation');
  assertEqual(llmCalls, 0, 'unavailable project root stops before provider invocation');
  const diagnostic = result.events.find((event) =>
    event.kind === 'assistant_msg'
    && (event.payload as any)?.diagnosticCode === 'project_root_unavailable'
  );
  assertEqual(Boolean(diagnostic), true, 'unavailable project root emits a structured diagnostic');
}

async function assertSessionDriverLoopRequirementConfirmationCarriesExecutionRoot(): Promise<void> {
  const token = randomSmokeToken('requirement-root');
  const sessionId = `session-${token}`;
  const root = `/workspace/${token}`;
  const events: AgentEvent[] = [];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let runCreateCount = 0;
  let runCreateAttachments: any[] = [];
  let runCreateWorkspaceBinding: any;
  let runCreateProjectWorkingDirectory: any;
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') {
        runCreateCount += 1;
        runCreateAttachments = command.input?.attachments ?? [];
        runCreateWorkspaceBinding = command.workspaceBinding;
        runCreateProjectWorkingDirectory = command.input?.projectWorkingDirectory;
        return fakeKernel(request);
      }
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      llmCalls += 1;
      if (llmCalls === 1) {
        return semanticToolLlmResponse('session.request_decision', {
          question: `Choose a generic option for ${token}.`,
          options: [
            { id: `first-${token}`, label: `First ${token}`, description: `Use the first generic option for ${token}.` },
            { id: `second-${token}`, label: `Second ${token}`, description: `Use the second generic option for ${token}.` },
          ],
          allowsFreeform: true,
        }, `decision-${token}`);
      }
      return semanticToolLlmResponse('session.submit_answer', {
        content: 'Generic continuation answer.',
      }, `answer-${token}`);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const first = await loop.runUserTurn({
    sessionId,
    content: 'Confirm a generic project-scoped decision before continuing.',
    workspaceBinding: { openPath: root },
    projectWorkingDirectory: {
      rootId: `root-${token}`,
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
    projectId: `project-${token}`,
    projectKind: 'folder',
    projectRootStatus: 'ready',
    requirementConfirmationMode: 'always',
  });
  const confirmation = first.events.find((event) => event.kind === 'requirement_confirmation');
  const confirmationPayload = confirmation?.payload as Record<string, any> | undefined;
  assertEqual(Boolean(confirmation), true, 'requirement confirmation is projected');
  assertEqual((confirmationPayload?.attachments ?? []).length, 0, 'test covers confirmation without direct attachments');
  assertEqual(confirmationPayload?.executionRoot?.attachment?.absolutePath, root, 'requirement confirmation snapshots execution root');

  await loop.resolveDecision({
    sessionId,
    kind: 'requirement',
    decision: 'accept',
    runId: typeof confirmationPayload?.runId === 'string' ? confirmationPayload.runId : undefined,
    targetId: typeof confirmationPayload?.requirementId === 'string' ? confirmationPayload.requirementId : undefined,
    existingEvents: first.events,
    workspaceBinding: { openPath: root },
    projectWorkingDirectory: {
      rootId: `root-${token}`,
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
    projectId: `project-${token}`,
    projectKind: 'folder',
    projectRootStatus: 'ready',
  });

  assertEqual(runCreateAttachments.length, 0, 'project root is not mirrored as a Kernel attachment');
  assertEqual(runCreateCount, 1, 'requirement decision resumes the original run without creating another Kernel run');
  assertEqual(runCreateWorkspaceBinding?.openPath, root, 'project workspace binding is the Kernel run root');
  assertEqual(runCreateProjectWorkingDirectory, undefined, 'requirement continuation does not carry decision-time project working directory when execution root is known');
  assert(
    JSON.stringify(llmRequests.at(-1)?.messages ?? []).includes(root),
    'requirement continuation preserves the execution root in resumed provider context'
  );
}

async function assertSessionDriverLoopRequirementChoiceEntersResumePrompt(): Promise<void> {
  const initialRequest = 'Create a generic user intervention test.';
  const initialMessage: AgentEvent = {
    id: 'requirement-choice-user-message',
    sessionId: 'session-requirement-choice',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: { content: initialRequest },
  };
  const events: AgentEvent[] = [
    initialMessage,
    createSessionTurnAuthorityEvent({
      sessionId: 'session-requirement-choice',
      runId: 'run-requirement-choice',
      turnId: 'turn-requirement-choice',
      taskId: 'task-requirement-choice',
      messages: [{ messageId: initialMessage.id, content: initialRequest }],
      relation: 'newTask',
      boundAtHookRef: 'run.initialized',
      outputLanguage: 'en-US',
      eventId: 'authority-requirement-choice',
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
    genericKernelContextProjectionEvent('session-requirement-choice', 'run-requirement-choice'),
    {
    id: 'requirement-choice-waiting',
    sessionId: 'session-requirement-choice',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      title: 'Requirement confirmation',
      summary: 'Choose a generic test branch.',
      content: 'Choose a generic test branch.',
      originalUserRequest: initialRequest,
      runId: 'run-requirement-choice',
      requirementId: 'requirement-choice',
      status: 'waitingUserConfirmation',
      confirmable: true,
      decisionRequest: {
        id: 'decision-choice',
        question: 'Choose a generic branch.',
        options: [
          { id: 'alpha', label: 'Alpha branch', description: 'Continue with the first generic branch.', recommended: true },
          { id: 'beta', label: 'Beta branch', description: 'Continue with the second generic branch.' },
        ],
        allowsFreeform: true,
      },
    },
    },
  ];
  const session: AgentSession = {
    id: 'session-requirement-choice',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return semanticToolLlmResponse('session.submit_answer', {
        content: 'Generic choice was received.',
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmRequests.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'accept',
    guidance: [
      'Selected option:',
      '- id: alpha',
      '- label: Alpha branch',
    ].join('\n'),
    runId: 'run-requirement-choice',
    targetId: 'requirement-choice',
    existingEvents: events,
  });

  assertEqual(llmRequests.length, 1, 'accepted requirement choice resumes provider once');
  const promptText = llmRequests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assert(promptText.includes('The user has already resolved the previous decisionRequest'), 'resume prompt states that the user already selected an option in English');
  assert(promptText.includes('Alpha branch'), 'resume prompt includes the selected option label');
  assert(promptText.includes('Do not repeat that intervention'), 'resume prompt guards against repeating the same decision request');
  assert(!/[\u3400-\u9FFF]/.test(promptText), 'resume prompt does not inject CJK system instructions for an English user request');
  assert(promptText.includes('current user input language'), 'resume prompt constrains user-visible output language separately from English system instructions');
  assert(
    promptText.includes('kind: ConfirmedDecision') || promptText.includes('"kind": "ConfirmedDecision"'),
    'resume prompt contains a formal confirmed decision frame'
  );
  assert(promptText.includes('state=ConfirmedRequirementContinuation'), 'resume prompt narrows the next action after a confirmed requirement choice');
  assert(promptText.includes('Do not infer extra preserved/deleted/modified targets'), 'resume prompt prevents target guessing after a confirmed choice');
}

async function assertSessionDriverLoopRequirementFinishWithAnswerClosesWithoutProviderLoop(): Promise<void> {
  const suffix = randomSmokeToken('finish');
  const initialRequest = 'Handle a generic accepted-plan checkpoint.';
  const initialMessage: AgentEvent = {
    id: `user-message-${suffix}`,
    sessionId: `session-${suffix}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: { content: initialRequest },
  };
  const events: AgentEvent[] = [
    initialMessage,
    createSessionTurnAuthorityEvent({
      sessionId: `session-${suffix}`,
      runId: `run-${suffix}`,
      turnId: `turn-${suffix}`,
      taskId: `task-${suffix}`,
      messages: [{ messageId: initialMessage.id, content: initialRequest }],
      relation: 'newTask',
      boundAtHookRef: 'run.initialized',
      outputLanguage: 'en-US',
      eventId: `authority-${suffix}`,
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
    {
    id: `requirement-${suffix}`,
    sessionId: `session-${suffix}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      title: 'Requirement confirmation',
      summary: 'Choose a generic continuation.',
      content: 'Choose a generic continuation.',
      originalUserRequest: initialRequest,
      runId: `run-${suffix}`,
      requirementId: `requirement-${suffix}`,
      status: 'waitingUserConfirmation',
      confirmable: true,
      decisionRequest: {
        id: `decision-${suffix}`,
        question: 'Choose a generic continuation.',
        options: [
          {
            id: 'finish',
            label: 'Finish with answer',
            description: 'Stop further implementation and summarize current facts.',
            recommended: true,
            effect: { kind: 'finishWithAnswer', reason: 'generic user stop request' },
          },
          {
            id: 'continue',
            label: 'Continue',
            description: 'Continue with the next implementation batch.',
            effect: { kind: 'continueWithAction' },
          },
        ],
        allowsFreeform: true,
      },
    },
    },
  ];
  const session: AgentSession = {
    id: `session-${suffix}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: 'This should not be needed for finishWithAnswer.' },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'accept',
    guidance: [
      'Selected option:',
      '- id: finish',
      '- label: Finish with answer',
    ].join('\n'),
    runId: `run-${suffix}`,
    targetId: `requirement-${suffix}`,
    existingEvents: events,
  });

  assertEqual(llmCalls, 0, 'finishWithAnswer is handled by Session facts without provider loop');
  assert(result.events.some((event) => event.kind === 'assistant_msg'), 'finishWithAnswer emits an answer message');
  assert(result.events.some((event) =>
    event.kind === 'session_run_state' &&
    (event.payload as any)?.status === 'completed' &&
    (event.payload as any)?.reason === 'requirement'
  ), 'finishWithAnswer closes the requirement run');
}

async function assertSessionDriverLoopProjectsTaskPlanBeforeComplete(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  let proposalSubmits = 0;
  const session: AgentSession = {
    id: 'session-task-plan',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') proposalSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return semanticToolLlmResponse('session.submit_plan', {
        title: 'Generic task plan',
        summary: 'Plan a generic workspace change before implementation.',
        tasks: [{
          taskId: 'task-generic-write',
          title: 'Prepare generic workspace output',
          toolId: 'fs.write',
          target: ['generic-output.txt'],
          args: {},
          dependencies: [],
          acceptanceCriteria: ['Kernel facts show the accepted target was updated after execution.'],
          failureCriteria: ['Stop if implementation needs targets outside the accepted task plan.'],
        }],
        risks: ['Workspace writes remain under Kernel permission policy.'],
        reviewCheckpoints: ['Review Kernel facts after execution.'],
      }, 'task-plan-generic');
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-task-plan',
    content: 'Update the attached generic workspace file.',
    attachments: [{
      kind: 'file',
      path: 'generic-output.txt',
      absolutePath: '/tmp/generic-output.txt',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  const planCard = result.events.find((event) => event.kind === 'plan_card');
  const payload = planCard?.payload as Record<string, any> | undefined;
  assertEqual(llmCalls, 1, 'taskPlan is produced by provider once');
  assertEqual(proposalSubmits, 0, 'taskPlan does not submit executable Kernel ProposalSubmit before user confirmation');
  assertEqual(Boolean(payload?.taskPlan), true, 'taskPlan projects to a confirmable plan card');
  assertEqual(Array.isArray(payload?.contentBlocks) && payload.contentBlocks.length === 0, true, 'taskPlan plan card carries no source code');
  assertEqual(Boolean(payload?.actionBundle?.actions?.length), false, 'taskPlan plan card carries no executable actions');
}

function assertLegacyProviderShapesAreRejected(): void {
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      answer: { format: 'markdown', content: 'Kind inference is not allowed.' },
    }),
  }), 'Agent Protocol v4.kind');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: '```json\n{"schemaVersion":"deepcode.agent.protocol.v4","kind":"answer","answer":{"format":"markdown","content":"fenced"}}\n```',
  }), 'must be valid JSON');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'implementationPlan',
      outputLanguage: 'en-US',
      implementationPlan: {
        version: '1',
        id: 'impl-generic-canonical',
        title: 'Generic plan',
        summary: 'Plan generic workspace edits.',
        tasks: [],
      },
    }),
  }), 'unsupported: implementationPlan');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'actionBundle',
      outputLanguage: 'en-US',
      userPlanMarkdown: '# Plan\n\n## Summary\nGeneric plan.',
      contentBlocks: [],
      actionBundle: {
        version: '1',
        id: 'bundle-legacy-capability',
        goal: 'Generic workspace edit.',
        actions: [{
          actionId: 'write-generic',
          capability: 'fs.write',
          resourceScope: ['generic/output.txt'],
          description: 'Legacy capability action.',
        }],
        validationExpectations: [{ id: 'validation-generic', description: 'Kernel records the proposed validation.' }],
        reviewExpectations: [{ id: 'review-generic', description: 'User reviews the scoped change.' }],
      },
    }),
  }), 'capability is not provider-facing');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'actionBundle',
      outputLanguage: 'en-US',
      userPlanMarkdown: '# Plan\n\n## Summary\nGeneric plan.',
      contentBlocks: [{
        blockId: 'block-generic',
        targetPath: 'generic/output.txt',
        content: 'line 1\nline 2',
      }],
      actionBundle: {
        version: '1',
        id: 'bundle-legacy-content',
        goal: 'Generic workspace edit.',
        actions: [{
          actionId: 'write-generic',
          toolId: 'fs.write',
          args: { path: 'generic/output.txt', contentBlockId: 'block-generic' },
          description: 'Canonical action.',
        }],
        validationExpectations: [{ id: 'validation-generic', description: 'Kernel records the proposed validation.' }],
        reviewExpectations: [{ id: 'review-generic', description: 'User reviews the scoped change.' }],
      },
    }),
  }), 'content is not provider-facing');

  const legacyUserPlan = genericWriteProposal(false);
  legacyUserPlan.userPlan = legacyUserPlan.userPlanMarkdown;
  delete legacyUserPlan.userPlanMarkdown;
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify(legacyUserPlan),
  }), 'userPlan is not provider-facing');

  const stringContentLines = genericWriteProposal(false);
  (stringContentLines.contentBlocks as any[])[0].contentLines = 'line one\nline two';
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify(stringContentLines),
  }), 'contentLines must be non-empty');

  const taskPlan = parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify(genericTaskPlanProposal()),
  });
  assertEqual(taskPlan.kind, 'taskPlan', 'taskPlan is the provider-facing non-executable plan kind');
  const taskPlanPayload = taskPlan.payload as Record<string, any>;
  assertEqual(Array.isArray(taskPlanPayload.tasks) && taskPlanPayload.tasks.length === 1, true, 'taskPlan carries task slices');
  assertEqual(Boolean(taskPlanPayload.actionBundle), false, 'taskPlan does not carry executable actionBundle');

  const invalidTaskPlan = genericTaskPlanProposal();
  (invalidTaskPlan.taskPlan as any).contentBlocks = [{ blockId: 'block-generic', contentLines: ['x'] }];
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify(invalidTaskPlan),
  }), 'contentBlocks is not allowed');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'resourceRequest',
      resourceRequest: {
        id: 'legacy-resource-type',
        reason: 'Legacy resource item shape.',
        items: [{ id: 'legacy-item', resourceType: 'file', path: 'generic.txt', reason: 'Read generic text.' }],
      },
    }),
  }), 'resourceType is not accepted');
}

function assertV4Parser(): void {
  const answer = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'answer',
      narration: 'This narration is ignored for final answer rendering.',
      outputLanguage: 'en-US',
      answer: { format: 'markdown', content: 'Generic answer.' },
    }),
  });
  assertEqual(answer.kind, 'answer', 'v4 answer parses');
  assertEqual(answer.runId, 'run-generic', 'v4 parser binds run id');
  assertEqual(answer.narration, 'This narration is ignored for final answer rendering.', 'v4 parser preserves optional narration');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'taskOutcome',
      taskOutcome: { reason: 'Legacy task outcome.' },
    }),
  }), 'unsupported');

  const resourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-path',
        reason: 'Need a generic file under the attached directory.',
        items: [{ id: 'path-item', rootId: 'root-generic', path: 'src/generic.txt', reason: 'Read generic source.' }],
      },
    }),
  });
  assertEqual(resourceRequest.kind, 'resourceRequest', 'v4 resourceRequest path item parses');
  const resourcePayload = resourceRequest.payload as any;
  assertEqual(resourcePayload.items[0].path, 'src/generic.txt', 'v4 resourceRequest keeps root-relative path');

  const rootResourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-root',
        reason: 'Need the generic root directory.',
        items: [{ id: 'root-item', kind: 'directory', rootId: 'root-generic', path: '', reason: 'Read root directory.' }],
      },
    }),
  });
  const rootPayload = rootResourceRequest.payload as any;
  assertEqual(rootPayload.items[0].manifestEntryId, 'root-generic', 'v4 resourceRequest rootId plus empty path canonicalizes to root manifest entry');
  assertEqual(rootPayload.items[0].path, undefined, 'v4 resourceRequest root path canonicalization omits empty path');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-alias',
        reason: 'Need a generic file using compatibility aliases.',
        resources: [{ id: 'alias-item', resourceType: 'file', rootId: 'root-generic', path: 'src/alias.txt', reason: 'Read alias source.' }],
      },
    }),
  }), 'items must be an array');

  const rangedResourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-range',
        reason: 'Need a generic file segment.',
        items: [{ id: 'range-item', rootId: 'root-generic', path: 'src/generic.txt', offsetBytes: 12000, limitBytes: 6000, reason: 'Read a later generic segment.' }],
      },
    }),
  });
  const rangedPayload = rangedResourceRequest.payload as any;
  assertEqual(rangedPayload.items[0].offsetBytes, 12000, 'v4 resourceRequest preserves offsetBytes');
  assertEqual(rangedPayload.items[0].limitBytes, 6000, 'v4 resourceRequest preserves limitBytes');

  const searchResourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-search',
        reason: 'Need generic search evidence.',
        items: [{
          id: 'search-item',
          kind: 'search',
          rootId: 'root-generic',
          query: 'generic anchor',
          include: ['src/'],
          contextLines: 2,
          maxResults: 25,
          reason: 'Find generic edit anchor.',
        }],
      },
    }),
  });
  const searchPayload = searchResourceRequest.payload as any;
  assertEqual(searchPayload.items[0].kind, 'search', 'v4 resourceRequest search item parses');
  assertEqual(searchPayload.items[0].query, 'generic anchor', 'v4 resourceRequest preserves search query');
  assertEqual(searchPayload.items[0].include[0], 'src/', 'v4 resourceRequest preserves include filter');
  assertEqual(searchPayload.items[0].contextLines, 2, 'v4 resourceRequest preserves contextLines');
  assertEqual(searchPayload.items[0].maxResults, 25, 'v4 resourceRequest preserves maxResults');

  const decisionRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'decisionRequest',
      outputLanguage: 'en-US',
      decisionRequest: {
        id: 'decision-generic-boundary',
        question: 'Need user choice for a generic boundary.',
        options: [
          {
            id: 'retry',
            label: 'Retry',
            description: 'Retry with the current accepted scope.',
          },
          { id: 'revise', label: 'Revise', description: 'Ask the user to revise the scope.' },
        ],
      },
    }),
  });
  const decisionPayload = decisionRequest.payload as any;
  assertEqual(decisionPayload.question, 'Need user choice for a generic boundary.', 'v4 decisionRequest preserves the canonical question');
  assertEqual(decisionPayload.options.length, 2, 'v4 decisionRequest preserves valid options');
  assertEqual(decisionPayload.options[0].recommended, true, 'v4 decisionRequest deterministically recommends the first option by default');

  for (const forbiddenOptionField of ['labelKey', 'descriptionKey', 'messageArgs', 'effect']) {
    assertThrows(() => parseProposalEnvelope({
      runId: 'run-generic',
      raw: JSON.stringify({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'decisionRequest',
        decisionRequest: {
          id: `decision-internal-${forbiddenOptionField}`,
          question: 'Provider options must use the canonical public fields.',
          options: [
            {
              id: 'first',
              label: 'First',
              description: 'First public option.',
              [forbiddenOptionField]: forbiddenOptionField === 'effect'
                ? { kind: 'continueWithAction' }
                : forbiddenOptionField === 'messageArgs'
                  ? { value: 'internal' }
                  : 'internal.key',
            },
            { id: 'second', label: 'Second', description: 'Second public option.' },
          ],
        },
      }),
    }), `${forbiddenOptionField} is Session-internal`);
  }

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'decisionRequest',
      decisionRequest: { id: 'decision-missing-options', question: 'Missing options should fail closed.' },
    }),
  }), 'options must include 2-3 options');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'unsupported.protocol.schema',
      kind: 'answer',
      answer: { format: 'markdown', content: 'legacy' },
    }),
  }), 'deepcode.agent.protocol.v4');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'resourceRequest',
      resourceRequest: {
        version: '1',
        id: 'invalid-resource-request',
        items: [{ id: 'missing-target', reason: 'Missing manifestEntryId and path.' }],
      },
    }),
  }), 'manifestEntryId, path, or kind="search"');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'resourceRequest',
      resourceRequest: {
        version: '1',
        id: 'invalid-empty-path-resource-request',
        items: [{ id: 'empty-path-target', path: '', reason: 'Empty path without root must remain invalid.' }],
      },
    }),
  }), 'manifestEntryId, path, or kind="search"');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'reviewSummary',
      reviewSummary: { status: 'accepted', content: 'not provider output' },
    }),
  }), 'unsupported');
}

function assertActionBundleProtocolFields(): void {
  const proposal = parseProposalEnvelope({
    runId: "run-v4",
    sessionId: "session-v4",
    raw: {
      schemaVersion: "deepcode.agent.protocol.v4",
      proposalId: "proposal-v4",
      kind: "actionBundle",
      userPlanMarkdown: "# Plan\n\n## Summary\nWrite one file.",
      contentBlocks: [{
        blockId: "content-1",
        targetPath: "generic-output.txt",
        operation: "overwrite",
        contentLines: ["line one", "line two"],
      }],
      actionBundle: {
        id: "bundle-v4",
        goal: "Write one file.",
        actions: [{
          actionId: "write-1",
          toolId: "fs.write",
          args: { path: "generic-output.txt", contentBlockId: "content-1" },
          description: "Write generic output",
          dependsOn: [],
        }],
        validationExpectations: [{ id: "validation-1", description: "Kernel records write facts." }],
        reviewExpectations: [{ id: "review-1", description: "Review the write fact." }],
      },
    },
  });
  const payload = proposal.payload as any;
  assertEqual(payload.actionBundle.id, "bundle-v4", "v4 preserves explicit actionBundle id");
  assertEqual(payload.contentBlocks[0].blockId, "content-1", "v4 preserves canonical blockId");
  assertEqual(payload.actionBundle.actions[0].actionId, "write-1", "v4 preserves canonical actionId");
  assertEqual(payload.actionBundle.actions[0].toolId, "fs.write", "v4 preserves canonical toolId");
  assertEqual(payload.actionBundle.actions[0].args.path, "generic-output.txt", "v4 preserves typed args");

  const missingId = JSON.parse(JSON.stringify({
    schemaVersion: "deepcode.agent.protocol.v4",
    kind: "actionBundle",
    userPlanMarkdown: "Plan",
    contentBlocks: [],
    actionBundle: { actions: [], validationExpectations: [], reviewExpectations: [] },
  }));
  assertThrows(() => parseProposalEnvelope({ runId: "run-v4", raw: missingId }), "actionBundle.id");
}

function assertProviderRepairMessageBuilderAvoidsDuplicateActionBundleReference(): void {
  const token = randomSmokeToken('repair-reference');
  const prompt = buildPromptEnvelope({
    workflowState: `accepted-${token}`,
    allowedProposals: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
    toolCatalogSummary: `currentTaskToolIds=fs.write`,
    userRequest: `Repair accepted task ${token}`,
  });
  const messages = new ProviderRepairMessageBuilder().repairMessages(prompt, {
    runId: `run-${token}`,
    userRequest: `Repair accepted task ${token}`,
    conversationRoots: [],
    resourcePackets: [],
    acceptedContext: {
      currentTask: { taskId: `task-${token}`, targets: [`target-${token}.txt`], capability: 'fs.write' },
      currentTaskActionTemplates: [{
        intentId: `template-${token}`,
        operation: 'fs.write',
        targets: [`target-${token}.txt`],
        template: { toolId: 'fs.write', args: { path: `target-${token}.txt` } },
      }],
    },
    currentTaskContext: {
      taskId: `task-${token}`,
      taskTitle: `Task ${token}`,
      goal: `Handle target ${token}`,
      targets: [`target-${token}.txt`],
      toolIds: ['fs.write'],
    },
    completedTaskCount: 0,
  }, '{invalid}', {
    code: 'invalid_action_bundle',
    message: 'Invalid action bundle.',
  });
  const joined = messages
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n');
  const fullShapeLine = 'The nested actionBundle object must include {version,id,goal,actions,...};';
  const compactionRepair = new ProviderRepairMessageBuilder().actionBundleCompactionRepairMessages(prompt, {
    runId: `run-${token}`,
    userRequest: `Repair accepted task ${token}`,
    conversationRoots: [],
    resourcePackets: [],
    implementationBatch: {},
    acceptedContext: {
      currentTask: { taskId: `task-${token}`, targets: [`target-${token}.txt`], capability: 'fs.write' },
      currentTaskActionTemplates: [{
        intentId: `template-${token}`,
        operation: 'fs.write',
        targets: [`target-${token}.txt`],
        template: { toolId: 'fs.write', args: { path: `target-${token}.txt` } },
      }],
    },
    currentTaskContext: {
      taskId: `task-${token}`,
      taskTitle: `Task ${token}`,
      goal: `Handle target ${token}`,
      targets: [`target-${token}.txt`],
      toolIds: ['fs.write'],
    },
    completedTaskCount: 0,
  }, 'Payload budget exceeded.', '{invalid}')
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n');

  assertEqual(joined.split(fullShapeLine).length - 1, 0, 'repair prompt delegates full actionBundle schema to ProviderTurnContract');
  assertEqual(compactionRepair.split(fullShapeLine).length - 1, 0, 'compaction repair delegates full actionBundle schema to ProviderTurnContract');
  assert(joined.includes('<ProviderTurnContract schemaVersion="deepcode.session.provider-turn-contract.v1">'), 'repair prompt includes ProviderTurnContract');
  assert(compactionRepair.includes('<ProviderTurnContract schemaVersion="deepcode.session.provider-turn-contract.v1">'), 'compaction repair includes ProviderTurnContract');
  assert(joined.includes('Use the ProviderTurnContract above as the schema authority.'), 'repair prompt names ProviderTurnContract as schema authority');
  assert(compactionRepair.includes('Use the ProviderTurnContract above as the schema authority.'), 'compaction repair names ProviderTurnContract as schema authority');
  assert(joined.includes('Carrier fields by kind: actionBundle uses top-level userPlanMarkdown, contentBlocks, and actionBundle'), 'repair prompt keeps compact actionBundle carrier guidance');
  assert(!joined.includes('Minimal actionBundle skeleton'), 'repair prompt does not re-inject an actionBundle skeleton');
  const validationLine = 'actionBundle.validationExpectations[] are optional reviewable validation notes shaped';
  assertEqual(joined.split(validationLine).length - 1, 0, 'repair quick reference does not duplicate actionBundle validation schema lines');
}

function assertProviderRepairMessageBuilderKeepsTaskPlanRepairShape(): void {
  const token = randomSmokeToken('task-plan-repair-shape');
  const prompt = buildPromptEnvelope({
    workflowState: `plan-${token}`,
    allowedProposals: ['answer', 'resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'],
    toolCatalogSummary: 'fs.read',
    userRequest: `Plan generic workspace work ${token}`,
  });
  const messages = new ProviderRepairMessageBuilder().repairMessages(prompt, {
    runId: `run-${token}`,
    userRequest: `Plan generic workspace work ${token}`,
    conversationRoots: [],
    resourcePackets: [],
  }, '{"schemaVersion":"deepcode.agent.protocol.v4"}', {
    code: 'invalid_task_plan',
    message: 'taskPlan.tasks[0].acceptanceCriteria must include at least one reviewable criterion.',
  });
  const joined = messages
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n');

  assert(joined.includes('Minimal taskPlan skeleton'), 'taskPlan repair prompt includes a minimal valid taskPlan skeleton');
  assert(joined.includes('acceptanceCriteria'), 'taskPlan repair prompt requires task acceptance criteria');
  assert(joined.includes('failureCriteria'), 'taskPlan repair prompt requires task failure criteria');
  assert(joined.includes('Use fs.write/fs.edit/fs.delete for workspace file-system changes'), 'taskPlan repair prompt routes file-system changes to fs toolIds');
  assert(joined.includes('do not use process.exec for mkdir/rm/cp/sed/cat-redirection'), 'taskPlan repair prompt avoids shell wrappers for workspace file mutations');
  assert(joined.includes('parent directories may be implied by planned concrete file writes'), 'taskPlan repair prompt avoids standalone directory creation tasks');
}

function assertProviderRepairMessageBuilderScopesNativeRepairReferences(): void {
  const token = randomSmokeToken('native-repair-reference');
  const rawAcceptedPlanMarker = `raw-accepted-plan-marker-${token}`;
  const prompt = buildPromptEnvelope({
    workflowState: `repair-${token}`,
    allowedProposals: ['resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'],
    toolCatalogSummary: 'none',
    userRequest: `Repair native tool call ${token}`,
  });
  const state = {
    runId: `run-${token}`,
    userRequest: `Repair native tool call ${token}`,
    conversationRoots: [],
    resourcePackets: [],
    implementationBatch: {},
    acceptedContext: {
      currentTask: { taskId: `task-${token}`, targets: [`target-${token}.txt`], capability: 'fs.write' },
      currentTaskActionTemplates: [{
        intentId: `template-${token}`,
        operation: 'fs.write',
        targets: [`target-${token}.txt`],
        template: { toolId: 'fs.write', args: { path: `target-${token}.txt` } },
      }],
      pendingTasks: [{ taskId: `later-${token}`, title: rawAcceptedPlanMarker }],
      rawPlan: { summary: rawAcceptedPlanMarker },
    },
    currentTaskContext: {
      taskId: `task-${token}`,
      taskTitle: `Task ${token}`,
      goal: `Handle target ${token}`,
      targets: [`target-${token}.txt`],
      toolIds: ['fs.write'],
    },
    completedTaskCount: 0,
  };
  const toolCall = {
    index: 0,
    callId: `call-${token}`,
    name: 'fs.write',
    arguments: { path: `target-${token}.txt` },
  } as NativeToolCallProposal;
  const turn = { content: `native tool attempt ${token}` };
  const builder = new ProviderRepairMessageBuilder();
  const shapeLine = 'The nested actionBundle object must include {version,id,goal,actions,...};';
  const beforeAccepted = builder.sideEffectNativeToolRepairMessages(prompt, state, toolCall, turn, false)
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n');
  const duplicateBeforeAccepted = builder.nativeToolDuplicateRepairMessages(prompt, state, turn, [{
    toolCall,
    signature: {
      key: `key-${token}`,
      toolName: 'fs.read',
      path: `target-${token}.txt`,
    },
    entry: {
      signature: {
        key: `key-${token}`,
        toolName: 'fs.read',
        path: `target-${token}.txt`,
      },
      packet: { id: `packet-${token}` },
      contentHash: `hash-${token}`,
      repeatCount: 2,
    },
  }], false).map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  const planReviewRepair = builder.planReviewRepairMessages(prompt, state, {
    proposalId: `proposal-review-${token}`,
    kind: 'actionBundle',
    payload: { actionBundle: { actions: [] } },
  } as ProposalEnvelope, { reasons: [`plan review issue ${token}`] })
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n');

  assertEqual(beforeAccepted.split(shapeLine).length - 1, 0, 'pre-plan native side-effect repair does not expose actionBundle shape');
  assertEqual(duplicateBeforeAccepted.split(shapeLine).length - 1, 0, 'pre-plan duplicate native read repair does not expose actionBundle shape');
  assert(!beforeAccepted.includes('No executable tool intent templates are visible'), 'pre-plan native repair omits redundant non-executable tool template prose');
  assert(beforeAccepted.includes('[ToolIntentTemplates]\n\n- none\n\n[/ToolIntentTemplates]'), 'pre-plan native repair leaves tool intent templates empty');
  assert(!beforeAccepted.includes('ToolIntentTemplates or currentTaskToolIds'), 'pre-plan native repair does not mention action tool intent selection');
  assertEqual(planReviewRepair.split(shapeLine).length - 1, 0, 'plan review repair relies on Kernel report and provider turn contract instead of full actionBundle shape');
  assert(planReviewRepair.includes('ProviderTurnContract'), 'plan review repair still includes provider turn contract');
  assert(!planReviewRepair.includes(rawAcceptedPlanMarker), 'plan review repair does not expose raw accepted plan context fields');
}

function assertRunStateMachineTaskLedger(): void {
  const suffix = randomSmokeToken('ledger');
  const taskIds = Array.from({ length: 5 }, (_item, index) => `task-${suffix}-${index + 1}`);
  const runId = `run-${suffix}`;
  const planId = `plan-${suffix}`;
  const targets = taskIds.map((_taskId, index) => `generated-${suffix}-${index + 1}.txt`);
  const ledger = buildTaskLedgerSnapshot({
    planId,
    runId,
    tasks: taskIds.map((taskId, index) => ({
      taskId,
      title: `Generic batch ${index + 1}`,
      targets: [targets[index]],
      toolId: 'fs.write',
    })),
    completedTaskIds: [taskIds[0], taskIds[1]],
  });
  assertEqual(ledger.taskOrder.join('|'), taskIds.join('|'), 'task ledger preserves ordered checklist order');
  assertEqual(ledger.currentTaskId, taskIds[2], 'task ledger selects the first incomplete task as current');
  assertEqual(ledger.pendingTaskIds.includes(taskIds[4]), true, 'task ledger keeps later tasks pending instead of ready-node scheduling');
  assertEqual(evaluateRunState({ ledger }).kind, 'continueAcceptedPlan', 'state machine continues accepted plan when tasks remain');
  const finish = evaluateRunState({ ledger, decisionEffect: normalizeDecisionEffect({ kind: 'finishWithAnswer', reason: 'generic stop' }) });
  assertEqual(finish.kind, 'finishWithAnswer', 'finishWithAnswer effect routes to an answer terminal');
  const frame = buildAcceptedPlanPromptFrame({
    planId,
    runId,
    title: 'Generic ordered plan',
    summary: 'Generic ordered plan summary',
    taskLedger: ledger,
  });
  assertEqual(frame.cachePolicy.stablePrefixFrozen, true, 'accepted plan prompt frame freezes stable prefix policy');
  assertEqual(frame.cachePolicy.projectMemoryRefresh, 'afterReviewOrRunCompletion', 'project memory does not refresh during active execution');
  assert(frame.stableFrameHash.length > 0, 'accepted plan prompt frame records a stable hash');

  const acceptedPlan: AcceptedTaskPlanContext = {
    planId,
    runId,
    title: 'Generic ordered plan',
    summary: 'Generic ordered plan summary',
    tasks: taskIds.map((taskId, index) => ({
      taskId,
      title: `Generic batch ${index + 1}`,
      targets: [targets[index]],
      toolId: 'fs.write',
      dependencies: [],
      planningArgs: {},
      conflictKeys: [],
    })),
    authorizationOperations: [],
    toolIds: [],
    targetScopes: [],
    batchIndex: 3,
    completedTaskIds: [taskIds[0], taskIds[1]],
    dependencyFacts: [],
    rawPlan: {},
  };
  const workUnitId = `work-${suffix}`;
  const coordinator = new AcceptedPlanTaskLedgerCoordinator({
    workUnitIdsFromKernelEvents: () => [workUnitId],
    actionBatchHasFailureOrBlocker: () => false,
  });
  const proposal = {
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `proposal-${suffix}`,
    runId,
    sessionId: `session-${suffix}`,
    source: 'llm',
    kind: 'actionBundle',
    payload: {
      actionBundle: {
        id: `bundle-${suffix}`,
        version: '1',
        goal: 'Generic ordered batch',
        actions: [{
          actionId: `action-${suffix}`,
          toolId: 'fs.write',
          args: { path: targets[2], contentBlockId: `block-${suffix}` },
        }],
        validationExpectations: [],
        reviewExpectations: [],
      },
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  } as ProposalEnvelope;
  const progress = coordinator.batchProgress({ acceptedPlan, proposal, kernelEvents: [] });
  assertEqual(progress.newlyCompletedTaskIds[0], taskIds[2], 'task ledger coordinator marks the current covered task complete');
  assertEqual(progress.workUnitIds[0], workUnitId, 'task ledger coordinator preserves work unit ids from kernel events');
  const progressEffect = coordinator.recordKernelBatchProgress({ acceptedPlan, proposal, kernelEvents: [] });
  assertEqual(progressEffect.kind, 'kernelBatchProgressRecorded', 'task ledger records kernel batch progress through command effect');
  assertEqual(progressEffect.completedTaskIds.includes(taskIds[2]), true, 'task ledger command effect carries completed task ids');
  assertEqual(progressEffect.nextAcceptedPlan.completedTaskIds.includes(taskIds[2]), true, 'task ledger command effect carries next accepted plan');
  const afterBatch = coordinator.afterBatch(acceptedPlan, progress.completedTaskIds);
  assertEqual(afterBatch.completedTaskIds.includes(taskIds[2]), true, 'task ledger coordinator advances accepted plan completed ids');
  assertEqual(coordinator.complete(afterBatch), false, 'task ledger coordinator keeps incomplete accepted plan open');
  const completionEffect = coordinator.recordTaskCompletion({ acceptedPlan, completedTaskIds: progress.completedTaskIds });
  assertEqual(completionEffect.kind, 'taskCompletionRecorded', 'task ledger records deterministic task completion through command effect');
  assertEqual(completionEffect.nextAcceptedPlan.completedTaskIds.includes(taskIds[2]), true, 'task completion effect carries next accepted plan');

  const afterOutcome = coordinator.afterTaskOutcome(afterBatch, taskIds[3]);
  const outcomeEffect = coordinator.recordModelTaskOutcome({ acceptedPlan: afterBatch, taskId: taskIds[3] });
  assertEqual(outcomeEffect.kind, 'modelTaskOutcomeRecorded', 'task ledger records model task outcome through command effect');
  assertEqual(outcomeEffect.nextAcceptedPlan.modelJudgedSufficientTaskIds?.includes(taskIds[3]), true, 'task ledger taskOutcome effect carries next accepted plan');
  const outcomeLedger = coordinator.ledger(afterOutcome);
  assertEqual(afterOutcome.modelJudgedSufficientTaskIds?.includes(taskIds[3]), true, 'taskOutcome records model-judged sufficient task ids');
  assertEqual(outcomeLedger?.entries.find((entry) => entry.taskId === taskIds[3])?.status, 'modelJudgedSufficient', 'task ledger exposes model judged sufficient task status');
  assertEqual(outcomeLedger?.currentTaskId, taskIds[4], 'task ledger advances to the next task after taskOutcome');

  const checkpoint = {
    id: `checkpoint-${suffix}`,
    sessionId: `session-${suffix}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.batch_checkpoint',
      runId,
      planId,
      completedTaskIds: taskIds,
    },
  } as AgentEvent;
  const restored = coordinator.withLatestCheckpoint(acceptedPlan, [checkpoint]);
  const recoverEffect = coordinator.recoverLatestCheckpoint({ acceptedPlan, events: [checkpoint] });
  assertEqual(recoverEffect.kind, 'latestCheckpointRecovered', 'task ledger restores checkpoint through command effect');
  assertEqual(coordinator.complete(recoverEffect.nextAcceptedPlan), true, 'task ledger checkpoint effect restores completed state');
  assertEqual(coordinator.complete(restored), true, 'task ledger coordinator restores completed checkpoint state');
  const runtimeState: AcceptedPlanTaskRuntimeState = {
    acceptedTaskPlan: acceptedPlan,
    resourcePackets: [],
    taskExecutionCursor: undefined,
    currentTaskContext: undefined,
    taskLedger: undefined,
    acceptedPlanPromptFrame: undefined,
  };
  coordinator.refreshRuntimeState(runtimeState);
  assertEqual(runtimeState.currentTaskContext?.taskId, taskIds[2], 'task ledger coordinator refreshes current task context');
  assertEqual(runtimeState.taskLedger?.entries.length, taskIds.length, 'task ledger coordinator refreshes task ledger');
  assertEqual(runtimeState.acceptedPlanPromptFrame?.taskLedger.currentTaskId, taskIds[2], 'task ledger coordinator refreshes prompt frame');
  const runtimeAccessor = new AcceptedPlanTaskRuntimeAccessor(runtimeState);
  const runtimeInput = runtimeAccessor.snapshotInput();
  assertEqual(runtimeInput.acceptedPlan, acceptedPlan, 'accepted-plan runtime accessor reads accepted plan authority');
  assertEqual(runtimeInput.resourcePackets, runtimeState.resourcePackets, 'accepted-plan runtime accessor reads resource packets');
  const accessorTargetState: AcceptedPlanTaskRuntimeState = {
    acceptedTaskPlan: acceptedPlan,
    resourcePackets: [],
  };
  new AcceptedPlanTaskRuntimeAccessor(accessorTargetState).apply(coordinator.runtimeSnapshot(runtimeInput));
  assertEqual(accessorTargetState.currentTaskContext?.taskId, taskIds[2], 'accepted-plan runtime accessor applies current task context');
  assertEqual(accessorTargetState.taskLedger?.currentTaskId, taskIds[2], 'accepted-plan runtime accessor applies task ledger');
}

function assertSessionDriverRuntimeAccessors(): void {
  const suffix = randomSmokeToken('driver-runtime');
  const prompt = buildPromptEnvelope({
    workflowState: `workflow-${suffix}`,
    allowedProposals: ['answer'],
    toolCatalogSummary: `capability-${suffix}`,
    userRequest: `request-${suffix}`,
  });
  const contract: DriverProviderTurnFrame = {
    schemaVersion: 'deepcode.session.provider-turn-contract.v1',
    contractId: `contract-${suffix}`,
    sessionId: `session-${suffix}`,
    runId: `run-${suffix}`,
    turnMode: 'planning',
    allowedKinds: ['answer'],
    frames: [],
    toolIntentTemplates: [],
    repairPolicy: 'sameKindOnly',
    projectionVisibility: 'traceOnly',
    nextActionInstruction: {
      kind: 'NextActionInstruction',
      source: 'session',
      trust: 'sessionInstruction',
      use: `answer-${suffix}`,
    },
    prompt,
  };
  const snapshot = buildProviderTurnSnapshot(contract);
  const providerState: {
    cachePlan?: PromptCachePlan;
    contextAssembly?: ContextAssemblyRecord;
    providerTurnFrame?: DriverProviderTurnFrame;
    modelContextBundle?: ModelContextBundle;
  } = {};
  const providerRuntime = new SessionDriverProviderRuntimeAccessor(providerState);
  const manifest: ResourceManifest = {
    id: `manifest-${suffix}`,
    workspaceScopeKey: `workspace-${suffix}`,
    entries: [],
    budget: { maxEntries: 8, maxBytes: 8192 },
    defaultDenyPatterns: [],
  };
  const assembledRuntimeContext = assembleContext({
    workflowState: `workflow-runtime-${suffix}`,
    allowedProposals: ['answer'],
    toolCatalogSummary: `capability-runtime-${suffix}`,
    userRequest: `request-runtime-${suffix}`,
    memoryDocument: buildSessionMemoryDocument([]),
    initialContext: {
      id: `initial-${suffix}`,
      workspaceScopeKey: manifest.workspaceScopeKey,
      manifest,
    },
  });
  const contextAssembly = assembledRuntimeContext.contextAssembly;
  providerRuntime.applyContextAssembly({
    cachePlan: assembledRuntimeContext.cachePlan,
    contextAssembly,
  });
  assertEqual(providerState.cachePlan?.contextAssemblyId, contextAssembly.contextAssemblyId, 'provider runtime accessor writes cache plan');
  assertEqual(providerState.contextAssembly, contextAssembly, 'provider runtime accessor writes context assembly without model bundle');
  assertEqual(providerRuntime.applyProviderTurnFrame(contract), contract, 'provider runtime accessor returns the applied provider turn frame');
  assertEqual(providerState.providerTurnFrame?.contractId, contract.contractId, 'provider runtime accessor writes standalone provider turn frame');
  const bundle = providerRuntime.applyModelContext({
    prompt,
    providerTurnFrame: { ...contract, snapshot, hookTrace: [] },
    snapshot,
    hookTrace: [],
  });
  assertEqual(providerState.providerTurnFrame?.contractId, contract.contractId, 'provider runtime accessor writes provider turn frame');
  assertEqual(providerState.modelContextBundle, bundle, 'provider runtime accessor stores the returned context bundle');
  assertEqual(bundle.providerTurnContract.snapshot?.contractId, contract.contractId, 'provider runtime accessor keeps snapshot on provider contract');
  assertEqual(bundle.snapshot.contractId, contract.contractId, 'provider runtime accessor keeps bundle snapshot authority');

  const repairState = {
    resourceRequestRepairAttempted: false,
    actionBundleAdmissionRepairAttempted: false,
    planReviewRepairAttempted: false,
    terminalGuidanceRevisionAttempted: false,
  };
  const repairRuntime = new SessionDriverRepairRuntimeAccessor(repairState);
  assertEqual(repairRuntime.attempted('planReviewRepairAttempted'), false, 'repair runtime accessor reads inactive repair flag');
  repairRuntime.markAttempted('planReviewRepairAttempted');
  assertEqual(repairState.planReviewRepairAttempted, true, 'repair runtime accessor writes repair flag');
  assertEqual(repairRuntime.attempted('planReviewRepairAttempted'), true, 'repair runtime accessor reads active repair flag');

  const activeTurnState: { activeTurn?: ActiveTurnState } = {};
  const activeTurnRuntime = new SessionDriverActiveTurnRuntimeAccessor(activeTurnState);
  const activeTurn = activeTurnRuntime.ensure(`stage-${suffix}`, (prefix) => `${prefix}-${suffix}`);
  assertEqual(activeTurn.turnId, `active-turn-${suffix}`, 'active turn runtime accessor creates active turn id');
  assertEqual(activeTurn.stage, `stage-${suffix}`, 'active turn runtime accessor initializes active turn stage');
  const advancedTurn = activeTurnRuntime.advance(undefined, (prefix) => `${prefix}-unused`);
  assertEqual(advancedTurn.seq, 1, 'active turn runtime accessor advances sequence');
  assertEqual(advancedTurn.stage, `stage-${suffix}`, 'active turn runtime accessor preserves stage when none is supplied');
  activeTurnRuntime.advance(`stage-next-${suffix}`, (prefix) => `${prefix}-unused`);
  assertEqual(activeTurnState.activeTurn?.stage, `stage-next-${suffix}`, 'active turn runtime accessor updates stage');

  const nativeToolState = { nativeToolDuplicateRepairAttempted: false };
  const nativeToolRuntime = new SessionDriverNativeToolRuntimeAccessor(nativeToolState);
  assertEqual(nativeToolRuntime.duplicateRepairAttempted(), false, 'native tool runtime accessor reads inactive duplicate repair guard');
  nativeToolRuntime.markDuplicateRepairAttempted();
  assertEqual(nativeToolState.nativeToolDuplicateRepairAttempted, true, 'native tool runtime accessor writes duplicate repair guard');
  assertEqual(nativeToolRuntime.duplicateRepairAttempted(), true, 'native tool runtime accessor reads active duplicate repair guard');
}


function assertPlanContextIndexBuildsPlanReadModels(): void {
  const suffix = randomSmokeToken('plan-context');
  const sessionId = `session-${suffix}`;
  const runId = `run-${suffix}`;
  const planId = `plan-${suffix}`;
  const proposalId = `proposal-${suffix}`;
  const bundleId = `bundle-${suffix}`;
  const reviewPlanId = `review-${suffix}`;
  const targetPath = `${suffix}/target-${randomSmokeToken('file')}.txt`;
  const overlay = {
    parentRunId: `parent-${suffix}`,
    parentPhase: 'waiting_permission' as const,
    interactionRunId: runId,
    interactionId: `interaction-${suffix}`,
  };
  const executionRoot = { attachment: { kind: 'directory', path: `root-${suffix}` } };
  const index = new PlanContextIndex({
    interactionOverlayFromPayload: (payload) => payload.overlay === overlay ? overlay as never : undefined,
    executionRootFromPayload: (payload) => payload.executionRoot === executionRoot ? executionRoot as never : undefined,
  });
  const planCard = {
    id: `event-${suffix}-card`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId,
      planId,
      proposalId,
      content: `Plan ${suffix}`,
      actionBundle: {
        id: bundleId,
        version: '1',
        actions: [{ actionId: `action-${suffix}`, targetPath }],
      },
      contentBlocks: [],
      commandBlocks: [],
      expectedValidation: `Validate ${suffix}`,
      reviewGuide: `Review ${suffix}`,
      planReviewReport: { planId: reviewPlanId },
      overlay,
      executionRoot,
    },
  } as AgentEvent;
  const found = index.findPlanCard([planCard], runId, bundleId);
  assertEqual(found?.planId, planId, 'plan context index matches action bundle aliases');
  assertEqual(found?.interactionOverlay, overlay, 'plan context index restores interaction overlay');
  assertEqual(found?.executionRoot, executionRoot, 'plan context index restores execution root');
  const proposal = index.proposalEnvelope(found!);
  assertEqual(proposal.kind, 'actionBundle', 'plan context index converts plan to actionBundle proposal');
  const proposalPayload = proposal.payload as { actionBundle: Record<string, unknown> };
  assertEqual(proposalPayload.actionBundle.id, bundleId, 'plan context proposal preserves action bundle');
  assertEqual(index.latestExecutablePlan([planCard])?.planId, planId, 'plan context index finds executable plan');
  const accepted = {
    id: `event-${suffix}-accepted`,
    sessionId,
    ts: '2026-01-01T00:00:01.000Z',
    kind: 'plan_review',
    payload: { runId: `${runId}-child`, planId, status: 'accepted' },
  } as AgentEvent;
  const review = {
    id: `event-${suffix}-summary`,
    sessionId,
    ts: '2026-01-01T00:00:02.000Z',
    kind: 'review_summary',
    payload: { runId: `${runId}-child`, sourcePlanId: planId, status: 'accepted' },
  } as AgentEvent;
  assertEqual(index.alreadyResolved([planCard, accepted, review], found!), true, 'plan context index treats terminal sourcePlanId reviews as source plan resolution');
}

function assertProposalRouterPlansPureRoutes(): void {
  const suffix = randomSmokeToken('proposal-route');
  const proposal = (kind: string) => ({
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `proposal-${suffix}-${kind}`,
    runId: `run-${suffix}`,
    sessionId: `session-${suffix}`,
    source: 'llm',
    kind,
    payload: {},
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  }) as ProposalEnvelope;
  assertEqual(routeProposalKind(proposal('answer')).kind, 'answer', 'proposal router routes answer proposals without side effects');
  assertEqual(routeProposalKind(proposal('decisionRequest')).kind, 'decisionRequest', 'proposal router routes decision requests without side effects');
  assertEqual(routeProposalKind(proposal('diagnostic')).kind, 'diagnostic', 'proposal router routes diagnostics without side effects');
  assertEqual(routeProposalKind(proposal('taskPlan')).kind, 'plan', 'proposal router routes task plans to plan handling');
  assertEqual(routeProposalKind(proposal('resourceRequest')).kind, 'resourceRequest', 'proposal router routes resource requests without side effects');
  assertEqual(routeProposalKind(proposal('actionBundle')).kind, 'action', 'proposal router routes action bundles to action handling');
  assertEqual(routeProposalKind(proposal('taskOutcome')).kind, 'nonExecutable', 'proposal router rejects removed task outcome proposals');
  assertEqual(routeProposalKind(proposal('unknown-kind')).kind, 'nonExecutable', 'proposal router closes unknown proposal kinds as non-executable');
}

async function assertProviderTurnCycleReturnsRoutedProposal(): Promise<void> {
  const suffix = randomSmokeToken('provider-cycle-route');
  const result: AgentSessionResult = {
    session: {
      id: `session-${suffix}`,
      mode: 'plan',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      eventCount: 0,
    },
    events: [],
  };
  const proposal = {
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `proposal-${suffix}`,
    runId: `run-${suffix}`,
    sessionId: `session-${suffix}`,
    source: 'llm',
    kind: 'resourceRequest',
    payload: {},
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  } as ProposalEnvelope;
  const cycle = new ProviderTurnCycle<
    { sessionId: string },
    { sessionId: string; phase: string }
  >({
    refreshRuntimeState: () => undefined,
    prepareProviderContext: async () => ({
      prompt: { messages: [] },
      lastResult: result,
    } as never),
    callProviderAndParse: async () => proposal,
    admitDirective: (nextProposal) => routeProposalKind(nextProposal),
    appendDriverFailure: async () => null,
    appendProviderFailure: async () => result,
  });
  const routed = await cycle.run({
    input: { sessionId: `session-${suffix}` },
    state: { sessionId: `session-${suffix}`, phase: 'initialized' },
    lastResult: result,
  });
  assertEqual(routed.kind, 'directiveReady', 'provider turn cycle returns one admitted directive without executing it');
  if (routed.kind === 'directiveReady') {
    assertEqual(routed.directive.kind, 'resourceRequest', 'provider turn cycle returns the admitted directive to RunEngine');
    assertEqual(routed.proposal, proposal, 'provider turn cycle preserves provider proposal with routed result');
    assertEqual(routed.lastResult, result, 'provider turn cycle preserves the context admission result');
  }
}

function assertInteractionLedgerResolvesTerminalSourcePlanReview(): void {
  const suffix = randomSmokeToken('interaction-ledger');
  const sessionId = `session-${suffix}`;
  const planRunId = `run-plan-${suffix}`;
  const reviewRunId = `run-review-${suffix}`;
  const planId = `plan-${suffix}`;
  const planCard = {
    id: `event-${suffix}-plan`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId: planRunId,
      planId,
      title: 'Generic plan',
      summary: 'Review a generic plan.',
      status: 'pending',
      confirmable: true,
    },
  } as AgentEvent;
  const waitingReview = {
    id: `event-${suffix}-review-waiting`,
    sessionId,
    ts: '2026-01-01T00:00:01.000Z',
    kind: 'review_summary',
    payload: {
      runId: reviewRunId,
      reviewId: `review-${suffix}`,
      sourcePlanId: planId,
      status: 'waitingUserReview',
      confirmable: true,
    },
  } as AgentEvent;
  assertEqual(
    findActiveInteraction({ events: [planCard, waitingReview] })?.kind,
    'review',
    'interaction ledger prioritizes active review over the source plan'
  );
  const acceptedReview = {
    id: `event-${suffix}-review-accepted`,
    sessionId,
    ts: '2026-01-01T00:00:02.000Z',
    kind: 'review_summary',
    payload: {
      runId: reviewRunId,
      reviewId: `review-${suffix}`,
      sourcePlanId: planId,
      status: 'accepted',
      confirmable: false,
    },
  } as AgentEvent;
  assertEqual(
    findActiveInteraction({ events: [planCard, waitingReview, acceptedReview] }),
    null,
    'interaction ledger closes the source plan when a terminal review references sourcePlanId'
  );
  const targetOnlyPlanReview = {
    id: `event-${suffix}-plan-target-review`,
    sessionId,
    ts: '2026-01-01T00:00:03.000Z',
    kind: 'plan_review',
    payload: {
      runId: planRunId,
      targetId: planId,
      status: 'accepted',
      confirmable: false,
    },
  } as AgentEvent;
  assertEqual(
    findActiveInteraction({ events: [planCard, targetOnlyPlanReview] }),
    null,
    'interaction ledger closes a pending plan when terminal plan review only carries targetId'
  );
}

function assertInteractionLedgerTerminalRunStateClosesPlan(): void {
  const suffix = randomSmokeToken('interaction-state');
  const sessionId = `session-${suffix}`;
  const runId = `run-${suffix}`;
  const planId = `plan-${suffix}`;
  const planCard = {
    id: `event-${suffix}-plan`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId,
      planId,
      title: 'Generic plan',
      status: 'pending',
      confirmable: true,
    },
  } as AgentEvent;
  const terminalState = {
    id: `event-${suffix}-state`,
    sessionId,
    ts: '2026-01-01T00:00:01.000Z',
    kind: 'session_run_state',
    payload: {
      runId,
      status: 'cancelled',
      decisionKind: 'plan',
      targetId: planId,
      decisionOwner: {
        kind: 'plan',
        planId,
        targetId: planId,
      },
    },
  } as AgentEvent;
  assertEqual(
    findActiveInteraction({ events: [planCard, terminalState] }),
    null,
    'interaction ledger closes a pending plan when its run-state owner reaches a terminal status'
  );
}

function assertProjectionResolvesPlanAfterSourceReview(): void {
  const suffix = randomSmokeToken('projection-source-review');
  const sessionId = `session-${suffix}`;
  const planRunId = `run-plan-${suffix}`;
  const reviewRunId = `run-review-${suffix}`;
  const planId = `plan-${suffix}`;
  const planCard = {
    id: `event-${suffix}-plan`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId: planRunId,
      planId,
      title: 'Generic implementation plan',
      summary: 'Review generic implementation work.',
      status: 'pending',
      confirmable: true,
    },
  } as AgentEvent;
  const acceptedReview = {
    id: `event-${suffix}-review`,
    sessionId,
    ts: '2026-01-01T00:00:01.000Z',
    kind: 'review_summary',
    payload: {
      runId: reviewRunId,
      reviewId: `review-${suffix}`,
      sourcePlanId: planId,
      status: 'accepted',
      confirmable: false,
    },
  } as AgentEvent;
  const projection = buildNarrativeTimelineProjection({
    sessionId,
    events: [planCard, acceptedReview],
    generatedAt: '2026-01-01T00:00:02.000Z',
  });
  const planBlock = projection.turns
    .flatMap((turn) => turn.blocks)
    .find((block) => block.events.some((event) => event.id === planCard.id));
  assertEqual(
    planBlock?.status,
    'completed',
    'timeline projection closes the source plan block after a terminal sourcePlanId review'
  );
  const targetOnlyReview = {
    id: `event-${suffix}-target-review`,
    sessionId,
    ts: '2026-01-01T00:00:03.000Z',
    kind: 'plan_review',
    payload: {
      runId: planRunId,
      targetId: planId,
      status: 'accepted',
      confirmable: false,
    },
  } as AgentEvent;
  const targetOnlyProjection = buildNarrativeTimelineProjection({
    sessionId,
    events: [planCard, targetOnlyReview],
    generatedAt: '2026-01-01T00:00:04.000Z',
  });
  const targetOnlyBlock = targetOnlyProjection.turns
    .flatMap((turn) => turn.blocks)
    .find((block) => block.events.some((event) => event.id === planCard.id));
  assertEqual(
    targetOnlyBlock?.status,
    'completed',
    'timeline projection closes the source plan block when terminal plan review only carries targetId'
  );
  const targetOnlyCheckpoint = {
    id: `event-${suffix}-target-checkpoint`,
    sessionId,
    ts: '2026-01-01T00:00:04.000Z',
    kind: 'workflow_stage',
    payload: {
      runId: `run-child-${suffix}`,
      targetId: planId,
      stage: 'accepted_plan.batch_checkpoint',
      taskLedger: {
        schemaVersion: 'deepcode.session.task-ledger.v1',
        planId,
        runId: `run-child-${suffix}`,
        taskOrder: ['task-target-only-generic'],
        completedTaskIds: ['task-target-only-generic'],
        pendingTaskIds: [],
        entries: [{
          taskId: 'task-target-only-generic',
          title: 'Write target-only generic artifact',
          targets: ['src/target-only-generic.txt'],
          status: 'completedByKernelFacts',
        }],
      },
    },
  } as AgentEvent;
  const targetOnlyPlanWithTask = {
    ...planCard,
    id: `event-${suffix}-target-plan`,
    payload: {
      ...(planCard.payload as Record<string, unknown>),
      taskPlan: {
        tasks: [{
          taskId: 'task-target-only-generic',
          title: 'Write target-only generic artifact',
          target: 'src/target-only-generic.txt',
          acceptanceCriteria: ['Kernel facts show the target-only artifact.'],
        }],
      },
    },
  } as AgentEvent;
  const targetOnlyTaskProjection = buildNarrativeTimelineProjection({
    sessionId,
    events: [targetOnlyPlanWithTask, targetOnlyReview, targetOnlyCheckpoint],
    generatedAt: '2026-01-01T00:00:05.000Z',
  });
  assertEqual(
    targetOnlyTaskProjection.taskProjection?.items.find((item) => item.title === 'Write target-only generic artifact')?.status,
    'completed',
    'task projection consumes accepted-plan taskLedger checkpoints when the checkpoint only carries targetId'
  );
}

function assertProjectionPublishesInteractionState(): void {
  const suffix = randomSmokeToken('projection-decision-facts');
  const sessionId = `session-${suffix}`;
  const runId = `run-${suffix}`;
  const planId = `plan-${suffix}`;
  const planCard = {
    id: `event-${suffix}-plan`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId,
      planId,
      title: 'Generic plan',
      summary: 'Review a generic plan.',
      status: 'pending',
      confirmable: true,
    },
  } as AgentEvent;
  const acceptedDecision = {
    id: `event-${suffix}-accepted`,
    sessionId,
    ts: '2026-01-01T00:00:01.000Z',
    kind: 'plan_review',
    payload: {
      runId,
      planId,
      status: 'accepted',
      confirmable: false,
      summary: 'The user accepted the plan; execution can continue.',
    },
  } as AgentEvent;
  const projection = buildNarrativeTimelineProjection({
    sessionId,
    events: [planCard, acceptedDecision],
    generatedAt: '2026-01-01T00:00:02.000Z',
  });
  const planTurn = projection.turns.find((turn) =>
    turn.blocks.some((block) => block.events.some((event) => event.id === planCard.id))
  );
  assertEqual(
    planTurn?.status,
    'completed',
    'timeline projection recomputes turn status after a pending plan block is resolved'
  );
  assertEqual(projection.interactionProjection, undefined, 'timeline projection does not revive an accepted plan interaction');
  const waitingPlanRunState = {
    id: `event-${suffix}-waiting-plan-state`,
    sessionId,
    ts: '2026-01-01T00:00:00.500Z',
    kind: 'session_run_state',
    payload: {
      runId,
      status: 'waiting',
      phase: 'waiting_plan_review',
      decisionOwner: {
        kind: 'plan',
        runId,
        planId,
        targetId: planId,
      },
    },
  } as AgentEvent;
  const resolvedProjection = buildNarrativeTimelineProjection({
    sessionId,
    events: [planCard, waitingPlanRunState, acceptedDecision],
    generatedAt: '2026-01-01T00:00:03.000Z',
  });
  const waitingPlanStateBlock = resolvedProjection.turns
    .flatMap((turn) => turn.blocks)
    .find((block) => block.events.some((event) => event.id === waitingPlanRunState.id));
  assertEqual(
    waitingPlanStateBlock?.status,
    'completed',
    'timeline projection closes waiting plan run-state blocks after the owner is resolved'
  );
  const reviewRunId = `run-review-${suffix}`;
  const reviewId = `review-${suffix}`;
  const waitingReview = {
    id: `event-${suffix}-waiting-review`,
    sessionId,
    ts: '2026-01-01T00:00:04.000Z',
    kind: 'review_summary',
    payload: {
      runId: reviewRunId,
      reviewId,
      sourcePlanId: planId,
      title: 'Generic review',
      status: 'waitingUserReview',
      confirmable: true,
    },
  } as AgentEvent;
  const waitingReviewRunState = {
    id: `event-${suffix}-waiting-review-state`,
    sessionId,
    ts: '2026-01-01T00:00:04.500Z',
    kind: 'session_run_state',
    payload: {
      runId: reviewRunId,
      status: 'waiting',
      phase: 'waiting_review',
      decisionOwner: {
        kind: 'review',
        runId: reviewRunId,
        reviewId,
        sourcePlanId: planId,
      },
    },
  } as AgentEvent;
  const acceptedReview = {
    id: `event-${suffix}-accepted-review`,
    sessionId,
    ts: '2026-01-01T00:00:05.000Z',
    kind: 'review_summary',
    payload: {
      runId: reviewRunId,
      reviewId,
      sourcePlanId: planId,
      status: 'accepted',
      confirmable: false,
    },
  } as AgentEvent;
  const terminalReviewGate = {
    id: `event-${suffix}-review-gate`,
    sessionId,
    ts: '2026-01-01T00:00:05.500Z',
    kind: 'workflow_stage',
    payload: {
      runId: reviewRunId,
      status: 'running',
      kernelEvent: {
        kind: 'review_gate.evaluated',
        runId: reviewRunId,
        reviewId,
        result: { status: 'accepted' },
      },
    },
  } as AgentEvent;
  const resolvedReviewProjection = buildNarrativeTimelineProjection({
    sessionId,
    events: [waitingReview, waitingReviewRunState, acceptedReview, terminalReviewGate],
    generatedAt: '2026-01-01T00:00:06.000Z',
  });
  const waitingReviewStateBlock = resolvedReviewProjection.turns
    .flatMap((turn) => turn.blocks)
    .find((block) => block.events.some((event) => event.id === waitingReviewRunState.id));
  assertEqual(
    waitingReviewStateBlock?.status,
    'completed',
    'timeline projection closes waiting review run-state blocks after review is accepted'
  );
  assertEqual(
    resolvedReviewProjection.turns[0]?.status,
    'completed',
    'timeline projection recomputes review turn status after waiting run-state blocks and terminal kernel stages are closed'
  );
}

function assertPlanInteractionIndexFindsActivePlan(): void {
  const suffix = randomSmokeToken('plan-interaction');
  const runId = `run-${suffix}`;
  const planId = `plan-${suffix}`;
  interface TestPlan {
    runId: string;
    planId: string;
    resolved: boolean;
  }
  const index = new PlanInteractionIndex<TestPlan>({
    planCardAwaitingDecision: (payload) => payload.confirmable !== false && payload.status !== 'accepted',
    planReviewEventAwaitingDecision: (payload) => payload.confirmable !== false && payload.status !== 'accepted',
    planContextFromEvent: (_event, payload) => ({
      runId: String(payload.runId),
      planId: String(payload.planId),
      resolved: payload.resolved === true,
    }),
    findPlanCard: (events, candidateRunId, candidatePlanId) => {
      const event = events.find((item) => {
        const payload = item.payload as Record<string, unknown> | undefined;
        return item.kind === 'plan_card' &&
          payload?.runId === candidateRunId &&
          payload?.planId === candidatePlanId;
      });
      const payload = event?.payload as Record<string, unknown> | undefined;
      return payload
        ? {
          runId: candidateRunId,
          planId: candidatePlanId,
          resolved: payload.resolved === true,
        }
        : null;
    },
    planAlreadyResolved: (_events, plan) => plan.resolved,
  });
  const planCard = {
    id: `event-${suffix}-card`,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: { runId, planId, status: 'pending', confirmable: true },
  } as AgentEvent;
  const planReview = {
    id: `event-${suffix}-review`,
    ts: '2026-01-01T00:00:01.000Z',
    kind: 'plan_review',
    payload: { runId, planId, status: 'awaitingUserApproval', confirmable: true },
  } as AgentEvent;
  assertEqual(
    index.findLatestActivePlanInteraction([planCard])?.planId,
    planId,
    'plan interaction index finds a waiting plan card'
  );
  assertEqual(
    index.findLatestActivePlanInteraction([planCard, planReview])?.runId,
    runId,
    'plan interaction index resolves review events through their plan card'
  );
  const resolvedPlan = {
    id: `event-${suffix}-resolved`,
    ts: '2026-01-01T00:00:02.000Z',
    kind: 'plan_card',
    payload: {
      runId: `resolved-run-${suffix}`,
      planId: `resolved-plan-${suffix}`,
      status: 'pending',
      confirmable: true,
      resolved: true,
    },
  } as AgentEvent;
  assertEqual(
    index.findLatestActivePlanInteraction([resolvedPlan]),
    null,
    'plan interaction index skips plans already resolved by session state'
  );
}

function assertRequirementProjectionBuilderCreatesDecisionEvents(): void {
  const suffix = randomSmokeToken('requirement-projection');
  const runId = `run-${suffix}`;
  const requirementId = `requirement-${suffix}`;
  const selectedOptionId = `option-${suffix}`;
  const builder = new RequirementProjectionBuilder({
    visibleLanguageForRequest: () => 'en-US',
    interactionOverlayPayload: (payload) => ({
      overlayRunId: payload.runId,
      overlayRequirementId: payload.requirementId,
    }),
  });
  const decisionRequest = {
    question: `Choose ${suffix}`,
    options: [
      {
        id: `fallback-${suffix}`,
        label: `Fallback ${suffix}`,
      },
      {
        id: selectedOptionId,
        label: `Selected ${suffix}`,
        recommended: true,
        effect: { kind: 'continueCurrentTask', token: suffix },
      },
    ],
  };
  assertEqual(builder.isDecisionRequestPayload(decisionRequest), true, 'requirement projection recognizes multi-option decision payload');
  assertEqual(builder.decisionRequestSummary(decisionRequest), `Choose ${suffix}`, 'requirement projection summarizes decision payload question');
  assertEqual(
    builder.decisionRequestOptions(decisionRequest).map((option) => option.id).join('|'),
    `fallback-${suffix}|${selectedOptionId}`,
    'requirement projection preserves structured decision options'
  );
  const event = {
    id: `event-${suffix}`,
    sessionId: `session-${suffix}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      runId,
      requirementId,
      originalUserRequest: `Request ${suffix}`,
      decisionRequest,
    },
  } as AgentEvent;
  const decision = builder.decisionEvent({
    sessionId: `session-${suffix}`,
    event,
    decision: 'accept',
    guidance: `- id: ${selectedOptionId}`,
    ts: '2026-01-01T00:00:01.000Z',
    id: `decision-${suffix}`,
  });
  const payload = decision.payload as Record<string, unknown>;
  const selectedOption = payload.selectedOption as Record<string, unknown>;
  assertEqual(decision.kind, 'requirement_decision', 'requirement projection creates requirement decision events');
  assertEqual(payload.status, 'accepted', 'requirement projection maps accepted decisions to accepted status');
  assertEqual(payload.titleKey, 'session.driver.requirementDecision.title', 'requirement decision event exposes title i18n key');
  assertEqual(payload.summaryKey, 'session.driver.requirementDecision.selectedOption', 'requirement decision event exposes selected-option summary key');
  assertEqual(payload.messageKey, 'session.driver.requirementDecision.selectedOption', 'requirement decision event exposes message key');
  assertEqual((payload.messageArgs as Record<string, unknown>).label, `Selected ${suffix}`, 'requirement decision event exposes selected option as i18n arg');
  assertEqual(selectedOption.id, selectedOptionId, 'requirement projection selects the guided option');
  assertEqual(payload.overlayRunId, runId, 'requirement projection preserves overlay payload from ports');
  const confirmation = builder.confirmationEvent({
    sessionId: `session-${suffix}`,
    runId,
    requirement: {
      requirementId,
      sessionId: `session-${suffix}`,
      initialUserRequest: `Request ${suffix}`,
      checklist: {
        goal: `Goal ${suffix}`,
        explicitTasks: [`Task ${suffix}`],
        inferredTasks: [],
        outOfScope: [],
        affectedAreaCandidates: [],
        resourceRequests: [],
        acceptanceCriteriaCandidates: [`Acceptance ${suffix}`],
        clarificationQuestions: [],
        riskNotes: [],
      },
      status: 'probing',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    proposal: {
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'decisionRequest',
      runId,
      sessionId: `session-${suffix}`,
      proposalId: `proposal-${suffix}`,
      source: 'llm',
      payload: decisionRequest,
    } as ProposalEnvelope,
    originalUserRequest: `Request ${suffix}`,
    attachments: [],
    executionRootPayload: { ref: `root-${suffix}` },
    interactionOverlayPayload: { overlayRunId: runId },
    ts: '2026-01-01T00:00:02.000Z',
    id: `confirmation-${suffix}`,
  });
  const confirmationPayload = confirmation.payload as Record<string, any>;
  assertEqual(confirmation.kind, 'requirement_confirmation', 'requirement projection creates confirmation events');
  assertEqual(confirmationPayload.status, 'waitingUserConfirmation', 'requirement projection marks confirmations as waiting');
  assertEqual(confirmationPayload.titleKey, 'session.driver.requirementConfirmation.title', 'requirement confirmation event exposes title i18n key');
  assertEqual(confirmationPayload.decisionRequest, decisionRequest, 'requirement projection preserves decision request payload');
  assertEqual(confirmationPayload.executionRoot.ref, `root-${suffix}`, 'requirement projection preserves execution root payload');
  assertEqual(confirmationPayload.overlayRunId, runId, 'requirement projection preserves confirmation overlay payload');
}

function assertSettingsCatalogBoundaries(): void {
  const sharedAgentKeys = new Set(agentSettingsIndex().map((entry) => entry.key));
  const guiPreferenceKeys = new Set(shellPreferenceSettingsIndex('gui').map((entry) => entry.key));
  const editorPreferenceKeys = new Set(shellPreferenceSettingsIndex('editor').map((entry) => entry.key));
  const workspaceKeys = new Set(workspaceOverridableSettingsIndex().map((entry) => entry.key));
  const agentConfigurableKeys = new Set(agentConfigurableSettingsIndex().map((entry) => entry.key));

  assertEqual(sharedAgentKeys.has('agent.permissions.gitWrite'), true, 'Git write policy is a shared Agent setting');
  assertEqual(sharedAgentKeys.has('agent.memory.projectMode'), true, 'Project memory mode is a shared Agent setting');
  assertEqual(agentConfigurableKeys.has('agent.permissions.gitWrite'), true, 'Agent can request shared Agent setting changes through audited config flow');
  assertEqual(guiPreferenceKeys.has('gui.colorTheme'), true, 'GUI preferences use the gui namespace');
  assertEqual(guiPreferenceKeys.has('workbench.colorTheme'), false, 'GUI preference index does not include editor workbench theme');
  assertEqual(editorPreferenceKeys.has('gui.colorTheme'), false, 'Editor preference index does not include GUI theme');
  assertEqual(workspaceKeys.has('agent.permissions.gitWrite'), false, 'workspace overrides cannot change Agent security gates');
  assertEqual(workspaceKeys.has('agent.memory.projectMode'), true, 'workspace overrides can control project-scoped memory promotion mode');
  assertEqual(workspaceKeys.has('ruler.rules'), true, 'workspace overrides may provide project-level Ruler additions');
}

async function assertProviderPartFramesEnterKernelDraftLedger(): Promise<void> {
  const events: AgentEvent[] = [];
  const deltas: unknown[] = [];
  const draftFrames: Array<Record<string, unknown>> = [];
  const session: AgentSession = {
    id: 'session-draft-frame',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const frame = {
    schemaVersion: 'deepcode.agent.stream.part.v1',
    partKind: 'codeBlockChunk',
    draftId: 'draft-generic',
    frameId: 'frame-generic-1',
    targetPath: 'src/generated.txt',
    toolId: 'fs.write',
    sequence: 1,
    chunk: 'generic draft content\n',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'draftLedgerSubmit') {
        draftFrames.push(command.frame);
        return {
          ok: true,
          events: [
            {
              kind: 'draft.open',
              runId: command.runId,
              sessionId: command.sessionId,
              draft: { draftId: command.frame.draftId, status: 'draft.open' },
            },
            {
              kind: 'draft.chunk',
              runId: command.runId,
              sessionId: command.sessionId,
              draft: { draftId: command.frame.draftId, status: 'draft.chunk', frame: command.frame },
            },
          ],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('provider part frame smoke should use streaming provider path');
    },
    llmChatStream: async (_request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      const chunk: LlmChatResult['chunks'][number] = {
        type: 'delta',
        content: `<deepcode-part>${JSON.stringify(frame)}</deepcode-part>`,
      };
      await onEvent({ type: 'provider_delta', chunk });
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: 'Generic final answer after draft frame.' },
      });
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + deltas.length + draftFrames.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-draft-frame',
    content: 'Generate a generic draft through protocol-level streaming frames.',
    requirementConfirmationMode: 'off',
  });

  assertEqual(draftFrames.length, 0, 'provider stream part frames remain volatile Session projection data');
  assertEqual(deltas.some((delta) => (delta as any).type === 'part_delta'), true, 'Session emits volatile part delta');
  assertEqual(deltas.some((delta) => (delta as any).type === 'draft_delta'), false, 'volatile provider frames do not fabricate Kernel draft facts');
  assertEqual(
    result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'final'),
    false,
    'A JSON answer without the required Session semantic directive does not enter the v4 final path'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any).status === 'failed'),
    true,
    'Missing semantic directive produces an observable failed terminal state'
  );
}

async function assertAcceptedPlanStreamingDraftsAndJsonProgress(): Promise<void> {
  const token = randomSmokeToken('accepted-stream');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const userMessageId = `user-${token}`;
  const userContent = `Execute accepted stream ${token}`;
  const targetPath = `${token}.txt`;
  const events: AgentEvent[] = [
    {
      id: userMessageId,
      sessionId,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content: userContent },
    },
    createSessionTurnAuthorityEvent({
      sessionId,
      runId,
      turnId: `turn-${token}`,
      taskId: `task-authority-${token}`,
      messages: [{ messageId: userMessageId, content: userContent }],
      relation: 'newTask',
      boundAtHookRef: 'smoke.accepted-stream',
      outputLanguage: 'en-US',
      eventId: `authority-${token}`,
      timestamp: '2026-01-01T00:00:00.001Z',
    }),
    genericKernelContextProjectionEvent(sessionId, runId),
    acceptedTaskPlanCardEvent(sessionId, runId),
  ];
  const planPayload = events.find((event) => event.kind === 'plan_card')?.payload as any;
  planPayload.taskPlan.tasks[0].target = [targetPath];
  planPayload.taskPlan.tasks[0].fileOperations = [{
    operation: 'write',
    capability: 'fs.write',
    targetPath,
    reason: 'Random accepted-plan streaming smoke target.',
  }];
  const planEvent = events.find((event) => event.kind === 'plan_card');
  if (!planEvent) throw new Error('Accepted-plan streaming smoke requires a plan card');
  applyKernelPlanAuthorizationFixture(planEvent);
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const deltas: unknown[] = [];
  const draftFrames: unknown[] = [];
  let actionBatchSubmits = 0;
  let providerCalls = 0;
  const proposal = randomMultiWriteProposal([targetPath], { briefUserPlan: true });
  const artifactContentLines = ((proposal as any).contentBlocks?.[0]?.contentLines ?? []) as string[];
  const frame = {
    schemaVersion: 'deepcode.agent.stream.part.v1',
    partKind: 'codeBlockChunk',
    frameId: `frame-${token}`,
    draftId: `draft-${token}`,
    blockId: `block-${token}`,
    targetPath,
    chunk: `preview ${token}`,
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'draftLedgerSubmit') {
        draftFrames.push(command.frame);
        return {
          ok: true,
          events: [{
            kind: 'draft.chunk',
            runId: command.runId,
            sessionId: command.sessionId,
            draft: { draftId: command.frame?.draftId, status: 'draft.chunk' },
          }],
        };
      }
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: `run-${token}`, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: `run-${token}`,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: `run-${token}`, sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitCompleted(
              `run-${token}`,
              `work-unit-${token}`,
              { path: targetPath, actionId: (command.batch?.actionBundle?.actions?.[0] ?? {}).actionId },
            ),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('accepted-plan streaming smoke should use llmChatStream');
    },
    llmChatStream: async (_request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      providerCalls += 1;
      if (providerCalls === 1) {
        await onEvent({
          type: 'provider_reasoning_delta',
          chunk: {
            type: 'reasoning_delta',
            content: `${randomSmokeToken('hidden-reasoning')} `.repeat(240),
          },
        });
        await onEvent({
          type: 'provider_delta',
          chunk: {
            type: 'delta',
            content: `<deepcode-part>${JSON.stringify(frame)}</deepcode-part>`,
          },
        });
      }
      return {
        ok: true,
        data: {
          chunks: [],
          assistantMessage: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: `semantic-artifact-${providerCalls}-${token}`,
              name: providerCalls === 1
                ? 'session.append_artifact_chunk'
                : 'session.finalize_task_artifacts',
              arguments: providerCalls === 1
                ? {
                  slotId: 'slot-task-generic-write-plan-op-task-generic-write-1',
                  contentLines: artifactContentLines,
                  finalChunk: true,
                }
                : { summary: `Write ${targetPath}` },
            }],
          },
        },
      };
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + deltas.length + draftFrames.length + actionBatchSubmits + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: `run-${token}`,
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: `workspace-${token}`,
      label: `Workspace ${token}`,
      displayPath: `/tmp/${token}`,
      absolutePath: `/tmp/${token}`,
      source: 'projectWorkingDirectory',
      primary: true,
    },
  });

  assertEqual(
    draftFrames.length,
    2,
    `only accepted artifact chunk and finalize frames enter Kernel draft ledger; providerCalls=${providerCalls}; events=${JSON.stringify(events.map((event) => ({ kind: event.kind, payload: event.payload })) )}`
  );
  assertEqual((draftFrames[0] as any).partKind, 'artifactChunk', 'accepted-plan artifact content is recorded as a logical Session-owned chunk');
  assertEqual((draftFrames[1] as any).partKind, 'batchDone', 'accepted-plan artifact draft records one terminal finalize frame');
  assertEqual(
    actionBatchSubmits,
    1,
    `accepted-plan streaming final actionBundle still reaches Kernel; events=${JSON.stringify(events.map((event) => ({ kind: event.kind, payload: event.payload })))}`
  );
  assertEqual(
    deltas.some((delta: any) => delta.type === 'part_delta' && delta.targetPath === targetPath),
    true,
    'accepted-plan stream emits visible part_delta before final actionBundle'
  );
  assertEqual(
    deltas.some((delta: any) => delta.type === 'draft_delta'),
    false,
    'accepted-plan artifact ledger facts remain authoritative Kernel events rather than volatile draft deltas'
  );
  assertEqual(
    deltas.some((delta: any) => delta.type === 'assistant_delta'),
    false,
    'accepted-plan raw JSON delta is not exposed as a formal assistant answer'
  );
  assertEqual(
    deltas.some((delta: any) => delta.type === 'reasoning_delta'),
    true,
    'accepted-plan provider reasoning is exposed as a live reasoning trace delta'
  );
}

async function assertProviderLifecycleStatusDoesNotEnterReasoningBody(): Promise<void> {
  const token = randomSmokeToken('provider-lifecycle');
  const events: AgentEvent[] = [];
  const deltas: ProjectionDelta[] = [];
  const session: AgentSession = {
    id: `session-${token}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const reasoningText = `reasoning-${token}`;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => ({
      ok: true,
      data: {
        chunks: [{ type: 'reasoning_delta', content: reasoningText }, { type: 'done' }],
        assistantMessage: {
          role: 'assistant',
          reasoningContent: reasoningText,
          content: JSON.stringify({
            schemaVersion: 'deepcode.agent.protocol.v4',
            kind: 'answer',
            outputLanguage: 'en-US',
            answer: { format: 'markdown', content: `answer-${token}` },
          }),
        },
      },
    }),
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + deltas.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: session.id,
    content: `generic request ${token}`,
    requirementConfirmationMode: 'off',
  });
  const reasoningEvents = result.events.filter((event) =>
    event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'reasoning'
  );
  assertEqual(reasoningEvents.length, 2, 'initial and repair provider reasoning are both committed as reasoning');
  assertEqual(
    reasoningEvents.every((event) => (event.payload as any).content === reasoningText),
    true,
    'provider reasoning content is preserved across the bounded repair'
  );
  assertEqual((reasoningEvents[0].payload as any).visibility, 'conversation', 'provider reasoning remains visible to the user');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.channel === 'reasoning' &&
      String((event.payload as any)?.content ?? '').includes('Provider Call')
    ),
    false,
    'provider lifecycle placeholder is not committed as reasoning body'
  );
  assertEqual(
    deltas.some((delta) =>
      delta.type === 'active_turn' &&
      delta.activity?.activityId === 'provider-provider_call'
    ),
    true,
    'provider lifecycle is projected as replaceable activity status'
  );
}

function assertNarrativeTimelineProjection(): void {
  const events: AgentEvent[] = [
    {
      id: 'event-user',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content: 'Analyze a generic attachment.' },
    },
    {
      id: 'event-thinking',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'assistant_msg',
      payload: { channel: 'reasoning', status: 'running', content: 'Need generic context.' },
    },
    {
      id: 'event-thinking-continued',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.100Z',
      kind: 'assistant_msg',
      payload: { channel: 'reasoning', status: 'running', content: ' Continue with generic constraints.' },
    },
    {
      id: 'event-progress',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.500Z',
      kind: 'assistant_msg',
      payload: { channel: 'progress', source: 'llm', content: 'I will resolve the selected resource before continuing.' },
    },
    {
      id: 'event-progress-session',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.600Z',
      kind: 'assistant_msg',
      payload: { channel: 'progress', source: 'session', content: 'Session-local progress does not become narration.' },
    },
    {
      id: 'event-cache',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.750Z',
      kind: 'cache_telemetry',
      payload: {
        provider: 'deepseek-v4-pro-openai',
        stage: 'plan',
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 20,
        promptTokens: 100,
        completionTokens: 12,
        totalTokens: 112,
      },
    },
    {
      id: 'event-cache-repair',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.850Z',
      kind: 'cache_telemetry',
      payload: {
        provider: 'deepseek-v4-pro-openai',
        stage: 'repair',
        promptCacheHitTokens: 20,
        promptCacheMissTokens: 80,
        promptTokens: 100,
        completionTokens: 8,
        totalTokens: 108,
      },
    },
    {
      id: 'event-tool',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:02.000Z',
      kind: 'tool_result',
      payload: {
        toolName: 'fs.read',
        summary: 'Read generic resource.',
        evidenceRefs: ['evidence-generic'],
        status: 'completed',
      },
    },
    {
      id: 'event-guidance',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:02.500Z',
      kind: 'user_guidance',
      payload: {
        content: 'Apply this generic guidance at the next provider checkpoint.',
        effectiveCheckpoint: 'nextProviderCall',
        status: 'queued',
      },
    },
    {
      id: 'event-plan',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:03.000Z',
      kind: 'plan_card',
      payload: { title: 'Generic plan', summary: 'Review generic next step.' },
    },
    {
      id: 'event-answer',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:04.000Z',
      kind: 'assistant_msg',
      payload: { channel: 'final', content: 'Generic final answer.' },
    },
  ];

  const projection = buildNarrativeTimelineProjection({
    sessionId: 'session-narrative',
    events,
    generatedAt: '2026-01-01T00:00:05.000Z',
  });
  assertEqual(projection.schemaVersion, 'deepcode.session.timeline.v1', 'narrative timeline is versioned');
  assertEqual(projection.turns.length, 2, 'user guidance starts a new user-bubble turn');
  const allBlocks = projection.turns.flatMap((turn) => turn.blocks);
  const kinds = allBlocks.map((block) => block.narrativeKind);
  assertEqual(kinds.includes('user'), true, 'user block is projected');
  assertEqual(kinds.includes('thinking'), true, 'thinking block is projected');
  assertEqual(kinds.includes('assistantNarration'), true, 'llm progress assistant messages become narration');
  assertEqual(kinds.includes('operationEvidence'), true, 'tool facts become operation evidence');
  assertEqual(
    allBlocks.filter((block) => block.narrativeKind === 'user').length,
    2,
    'user guidance is projected as a user bubble'
  );
  assertEqual(kinds.includes('requirement'), false, 'user guidance audit does not become a requirement card');
  assertEqual(kinds.includes('plan'), true, 'plan facts become a plan block');
  assertEqual(kinds.includes('assistantText'), true, 'final answer becomes assistant text');
  assertEqual(
    projection.taskProjection?.items.some((item) => item.narrativeKind === 'operationEvidence'),
    false,
    'operation evidence stays in the timeline and does not enter task projection'
  );
  assertEqual(
    projection.taskProjection?.items.some((item) => item.narrativeKind === 'assistantNarration'),
    false,
    'assistant narration does not enter task projection'
  );
  assertEqual(
    projection.taskProjection?.items.length ?? 0,
    0,
    'task projection is empty when no implementation plan tasks exist'
  );
  const processOnlyProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-process-only',
    events: [
      {
        id: 'event-process-user',
        sessionId: 'session-process-only',
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'user_msg',
        payload: { content: 'Inspect generic process events.' },
      },
      {
        id: 'event-process-resource',
        sessionId: 'session-process-only',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'workflow_stage',
        payload: { stage: 'resource_resolve', status: 'completed', summary: 'Resolved generic resources.' },
      },
      {
        id: 'event-process-tool',
        sessionId: 'session-process-only',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'tool_result',
        payload: { toolName: 'fs.read', ok: true },
      },
    ],
  });
  assertEqual(
    processOnlyProjection.taskProjection?.items.length ?? 0,
    0,
    'resource, tool, and workflow process events do not create task projection items without plan tasks'
  );
  const activityProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-activity-projection',
    events: [
      {
        id: 'event-activity-user',
        sessionId: 'session-activity-projection',
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'user_msg',
        payload: { content: 'Run a generic edit.' },
      },
      {
        id: 'event-activity-workunit',
        sessionId: 'session-activity-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'work_unit.completed',
          status: 'completed',
          summary: 'A generic target was updated.',
          activity: {
            activityId: 'activity-generic-edit',
            kind: 'editFileCompleted',
            status: 'completed',
            title: 'Generic edit completed',
            summary: 'Kernel completed a generic workspace edit.',
            source: 'kernel',
            runId: 'run-generic-activity',
            targets: ['src/random-alpha.ts'],
            actionIds: ['action-random-alpha'],
            workUnitIds: ['work-unit-random-alpha'],
          },
        },
      },
    ],
  });
  const activityBlock = activityProjection.turns[0].blocks.find((block) => block.activity?.activityId === 'activity-generic-edit');
  assertEqual(activityBlock?.activity?.kind, 'editFileCompleted', 'timeline block carries public conversation activity');
  assertEqual(activityBlock?.title, 'Generic edit completed', 'activity title drives operation block title');
  assertEqual(activityBlock?.status, 'completed', 'activity status drives operation block status');
  const narrationBlock = allBlocks.find((block) => block.narrativeKind === 'assistantNarration');
  assertEqual(narrationBlock?.narrativeKind, 'assistantNarration', 'assistant narration keeps its structured narrative kind');
  assertEqual(narrationBlock?.displayHints?.checkpointKind, 'llmProposal', 'assistant narration is tied to an LLM proposal checkpoint');
  const thinkingBlocks = allBlocks.filter((block) => block.narrativeKind === 'thinking');
  assertEqual(
    thinkingBlocks.length,
    2,
    'separate committed reasoning events remain separate timeline items'
  );
  assertEqual(thinkingBlocks[0]?.bodyMarkdown, 'Need generic context.', 'first reasoning item preserves its content');
  assertEqual(thinkingBlocks[1]?.bodyMarkdown, 'Continue with generic constraints.', 'second reasoning item preserves its content');
  assertEqual(Boolean(thinkingBlocks[0]?.displayHints?.collapseAfterComplete), true, 'thinking exposes semantic collapse guidance');
  const guidanceBlock = allBlocks.find((block) =>
    block.events.some((event) => (event.payload as any)?.sourceEventKind === 'user_guidance')
  );
  assertEqual(guidanceBlock?.narrativeKind, 'user', 'user guidance carries a user narrative kind');
  assertEqual(guidanceBlock?.bodyMarkdown, 'Apply this generic guidance at the next provider checkpoint.', 'user guidance bubble preserves the user text');
  assertEqual(
    allBlocks.some((block) => block.events.some((event) => event.kind === 'cache_telemetry')),
    false,
    'cache telemetry is hidden from narrative blocks'
  );
  assertEqual(projection.tokenUsageProjection?.requests.length, 1, 'cache telemetry is grouped by user request');
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.providerCallCount,
    2,
    'multiple provider calls in one user turn are counted together'
  );
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.promptCacheHitTokens,
    100,
    'request cache hit tokens are summed'
  );
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.promptCacheMissTokens,
    100,
    'request cache miss tokens are summed'
  );
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.cacheHitRate,
    0.5,
    'request cache hit rate uses hit divided by hit plus miss'
  );
  assertEqual(
    projection.tokenUsageProjection?.totals.totalTokens,
    220,
    'token projection totals are summed across provider calls'
  );
  assertEqual(
    allBlocks.some((block) => block.evidenceRefs?.includes('evidence-generic')),
    true,
    'evidence refs are preserved for frontend drilldown'
  );
  assertEqual(
    projection.rawEventRefs?.includes('event:event-tool'),
    true,
    'raw event refs are preserved for debug views'
  );
}

function assertNarrativeTimelineProjectionResolvesAcceptedPlanInteractions(): void {
  const events: AgentEvent[] = [
    {
      id: 'event-plan-user',
      sessionId: 'session-plan-resolution',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content: 'Create a generic workspace artifact.' },
    },
    {
      id: 'event-plan-card',
      sessionId: 'session-plan-resolution',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-plan-resolution',
        planId: 'plan-resolution',
        title: 'Generic structured plan',
        summary: 'Create a generic artifact.',
        status: 'pending',
        confirmable: true,
        taskPlan: {
          summary: 'Create a generic artifact.',
          tasks: [{
            taskId: 'task-write-generic-artifact',
            title: 'Write generic artifact',
            target: 'src/generic-artifact.txt',
            acceptanceCriteria: ['The artifact exists.'],
          }],
        },
      },
    },
    {
      id: 'event-plan-accepted',
      sessionId: 'session-plan-resolution',
      ts: '2026-01-01T00:00:02.000Z',
      kind: 'plan_review',
      payload: {
        runId: 'run-plan-resolution',
        planId: 'plan-resolution',
        status: 'accepted',
        confirmable: false,
        summary: 'The user accepted the plan; execution can continue.',
      },
    },
    {
      id: 'event-work-completed',
      sessionId: 'session-plan-resolution',
      ts: '2026-01-01T00:00:03.000Z',
      kind: 'workflow_stage',
      payload: {
        runId: 'run-plan-resolution',
        stage: 'work_unit.completed',
        status: 'completed',
        path: 'src/generic-artifact.txt',
        kernelEvent: {
          kind: 'work_unit.completed',
          output: { path: 'src/generic-artifact.txt' },
          workUnit: { id: 'work-unit-generic-artifact' },
        },
      },
    },
    {
      id: 'event-review-waiting',
      sessionId: 'session-plan-resolution',
      ts: '2026-01-01T00:00:04.000Z',
      kind: 'review_summary',
      payload: {
        runId: 'run-plan-resolution',
        reviewId: 'review-plan-resolution',
        sourcePlanId: 'plan-resolution',
        status: 'waitingUserReview',
        confirmable: true,
        title: 'Review',
        summary: 'Review the generic artifact.',
      },
    },
    {
      id: 'event-review-accepted',
      sessionId: 'session-plan-resolution',
      ts: '2026-01-01T00:00:05.000Z',
      kind: 'review_summary',
      payload: {
        runId: 'run-plan-resolution',
        reviewId: 'review-plan-resolution',
        sourcePlanId: 'plan-resolution',
        status: 'accepted',
        confirmable: false,
        title: 'Review accepted',
        summary: 'Review accepted.',
      },
    },
    {
      id: 'event-run-completed',
      sessionId: 'session-plan-resolution',
      ts: '2026-01-01T00:00:06.000Z',
      kind: 'session_run_state',
      payload: {
        runId: 'run-plan-resolution',
        status: 'completed',
        decisionKind: 'review',
      },
    },
  ];
  const pendingProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-plan-resolution',
    events: events.slice(0, 2),
    generatedAt: '2026-01-01T00:00:01.000Z',
  });
  assertEqual(pendingProjection.interactionProjection?.pending?.kind, 'plan', 'timeline exposes the pending interaction from the same projection');
  assertEqual(
    pendingProjection.interactionProjection?.pending?.blockId,
    pendingProjection.turns[0]?.blocks.find((block) => block.narrativeKind === 'plan')?.id,
    'pending interaction references its projected plan block'
  );
  const projection = buildNarrativeTimelineProjection({
    sessionId: 'session-plan-resolution',
    events,
    generatedAt: '2026-01-01T00:00:07.000Z',
  });
  const blocks = projection.turns.flatMap((turn) => turn.blocks);
  assertEqual(projection.interactionProjection, undefined, 'resolved review leaves no pending interaction in the timeline');
  const planBlock = blocks.find((block) => block.events.some((event) => event.id === 'event-plan-card'));
  assertEqual(planBlock?.status, 'completed', 'accepted plan card no longer remains waiting after raw plan_review acceptance');
  assertEqual(
    projection.taskProjection?.items.find((item) => item.title === 'Write generic artifact')?.status,
    'completed',
    'task projection uses completed work-unit facts after plan acceptance'
  );
}

function assertTimelineProjectionWithLiveOverlay(): void {
  const userEvent: AgentEvent = {
    id: 'event-live-user',
    sessionId: 'session-live-overlay',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: { content: 'Inspect a generic project.' },
  };
  const readActivity = {
    activityId: 'activity-live-read',
    kind: 'resourceRead' as const,
    status: 'completed' as const,
    title: 'Read generic resources',
    summary: 'Read generic project resources.',
    source: 'session' as const,
    runId: 'run-live-overlay',
    targets: ['src/generic-a.ts', 'docs/generic.md'],
  };
  const activeDeltas: ProjectionDelta[] = [
    {
      type: 'active_turn',
      seq: 0,
      sessionId: 'session-live-overlay',
      runId: 'run-live-overlay',
      turnId: 'turn-live-overlay',
      stage: 'provider_call',
      channel: 'progress',
      source: 'provider',
      status: 'running',
      summary: 'Provider lifecycle status only.',
      activity: {
        activityId: 'activity-provider-lifecycle',
        kind: 'providerThinking',
        status: 'running',
        title: 'Provider lifecycle',
        summary: 'Provider lifecycle status only.',
        source: 'provider',
        runId: 'run-live-overlay',
      },
    },
    {
      type: 'reasoning_delta',
      seq: 1,
      sessionId: 'session-live-overlay',
      runId: 'run-live-overlay',
      turnId: 'turn-live-overlay',
      channel: 'reasoning',
      source: 'provider',
      delta: 'Need generic context before proposing changes.',
    },
    {
      type: 'resource_delta',
      seq: 2,
      sessionId: 'session-live-overlay',
      runId: 'run-live-overlay',
      turnId: 'turn-live-overlay',
      channel: 'resource',
      source: 'session',
      status: 'completed',
      summary: 'Read generic project resources.',
      activity: readActivity,
    },
  ];
  const liveProjection = buildTimelineProjectionWithLiveOverlay({
    sessionId: 'session-live-overlay',
    committedEvents: [userEvent],
    activeDeltas,
    generatedAt: '2026-01-01T00:00:01.000Z',
  });
  const liveBlocks = liveProjection.turns[0].blocks;
  const liveKinds = liveBlocks.map((block) => block.narrativeKind);
  assertEqual(
    liveKinds.join('>'),
    'user>thinking>operationEvidence',
    'live overlay keeps visible reasoning and structured activity without provider lifecycle noise'
  );
  assertEqual(
    liveBlocks.some((block) => block.events.some((event) => (event.payload as any)?.activity?.activityId === 'activity-provider-lifecycle')),
    false,
    'live provider lifecycle stays out of the main timeline'
  );
  const liveThinking = liveBlocks.find((block) => block.narrativeKind === 'thinking');
  assert(Boolean(liveThinking?.bodyMarkdown?.includes('Need generic context before proposing changes.')), 'provider reasoning delta enters the live timeline as a reasoning trace block');
  assertEqual(liveThinking?.status, 'completed', 'later activity seals the live thinking block');
  assertEqual(liveThinking?.defaultCollapsed, false, 'sealed live thinking does not disappear before playback completes');
  const liveActivity = liveBlocks.find((block) => block.activity?.activityId === 'activity-live-read');
  assertEqual(liveActivity?.activity?.kind, 'resourceRead', 'live activity survives projection as structured activity');
  assertEqual(
    liveActivity?.rawEventRefs?.some((ref) => ref.startsWith('event:live:session-live-overlay:run-live-overlay:turn-live-overlay:2:resource_delta')),
    true,
    'live activity uses a structured transient event ref'
  );

  const nativeToolProjection = buildTimelineProjectionWithLiveOverlay({
    sessionId: 'session-live-overlay',
    committedEvents: [userEvent],
    activeDeltas: [
      {
        type: 'tool_call_delta',
        seq: 1,
        sessionId: 'session-live-overlay',
        runId: 'run-live-overlay',
        itemId: 'native-call-generic',
        stage: 'native_tool_call',
        status: 'running',
        channel: 'tool',
        source: 'session',
        activity: {
          activityId: 'native-tool-native-call-generic',
          kind: 'toolExecution',
          status: 'running',
          title: 'Resolve native tool',
          summary: 'Resolve a read-only native tool.',
          source: 'session',
          runId: 'run-live-overlay',
          toolName: 'fs__list',
        },
      },
      {
        type: 'stage_delta',
        seq: 2,
        sessionId: 'session-live-overlay',
        runId: 'run-live-overlay',
        stage: 'native_tool_round_1',
        status: 'running',
        channel: 'progress',
        source: 'session',
        activity: {
          activityId: 'native-tool-round-1',
          kind: 'toolExecution',
          status: 'running',
          title: 'Native tool checkpoint',
          summary: 'Internal routing checkpoint.',
          source: 'session',
          runId: 'run-live-overlay',
        },
      },
      {
        type: 'resource_delta',
        seq: 3,
        sessionId: 'session-live-overlay',
        runId: 'run-live-overlay',
        itemId: 'native-call-generic',
        stage: 'native_tool_resource_resolve',
        status: 'completed',
        channel: 'resource',
        source: 'kernel',
        activity: {
          activityId: 'native-tool-resource-native-call-generic',
          kind: 'resourceRead',
          status: 'completed',
          title: 'Resource resolved',
          summary: 'Resolved one directory.',
          source: 'kernel',
          runId: 'run-live-overlay',
          targets: ['.'],
        },
      },
    ],
  });
  const nativeToolBlocks = nativeToolProjection.turns[0].blocks.filter((block) => block.activity);
  assertEqual(nativeToolBlocks.length, 1, 'native tool progress resolves into one activity card');
  assertEqual(nativeToolBlocks[0]?.activity?.kind, 'resourceRead', 'native tool result replaces the running tool card');
  assertEqual(nativeToolBlocks[0]?.activity?.toolName, 'fs__list', 'native tool result retains its structured tool identity');
  assertEqual(nativeToolBlocks[0]?.activity?.operation, 'list', 'native tool result exposes a readable operation type');

  const committedProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-live-overlay',
    events: [
      userEvent,
      {
        id: 'event-committed-provider-lifecycle',
        sessionId: 'session-live-overlay',
        ts: '2026-01-01T00:00:00.500Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'provider_call',
          status: 'running',
          summary: 'Provider lifecycle status only.',
          activity: {
            activityId: 'activity-provider-lifecycle',
            kind: 'providerThinking',
            status: 'running',
            title: 'Provider lifecycle',
            summary: 'Provider lifecycle status only.',
            source: 'provider',
            runId: 'run-live-overlay',
          },
        },
      },
      {
        id: 'event-committed-reasoning',
        sessionId: 'session-live-overlay',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'assistant_msg',
        payload: {
          channel: 'reasoning',
          content: 'Need generic context before proposing changes.',
        },
      },
      {
        id: 'event-committed-resource',
        sessionId: 'session-live-overlay',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'tool_result',
        payload: {
          channel: 'tool',
          status: 'completed',
          summary: 'Read generic project resources.',
          activity: readActivity,
        },
      },
      {
        id: 'event-internal-stage',
        sessionId: 'session-live-overlay',
        ts: '2026-01-01T00:00:03.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'runtime.lifecycle_changed',
          kernelEvent: {
            kind: 'runtime.lifecycle_changed',
            runId: 'run-live-overlay',
            previousState: 'ready',
            currentState: 'executing',
          },
        },
      },
      {
        id: 'event-review-facts-produced',
        sessionId: 'session-live-overlay',
        ts: '2026-01-01T00:00:04.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'review.facts_produced',
          kernelEvent: {
            kind: 'review.facts_produced',
            runId: 'run-live-overlay',
            facts: kernelTestReviewFacts('run-live-overlay'),
          },
        },
      },
    ],
  });
  assertEqual(
    committedProjection.turns[0].blocks.map((block) => block.narrativeKind).join('>'),
    'user>thinking>operationEvidence',
    'committed reasoning remains a separate collapsible audit block when explicitly recorded'
  );
  const committedThinking = committedProjection.turns[0].blocks.find((block) => block.narrativeKind === 'thinking');
  const committedActivity = committedProjection.turns[0].blocks.find((block) => block.activity?.activityId === 'activity-live-read');
  assertEqual(
    committedProjection.turns[0].blocks.some((block) => block.events.some((event) => event.id === 'event-internal-stage' || event.id === 'event-review-facts-produced')),
    false,
    'internal lifecycle events do not render as empty timeline cards'
  );
  assertEqual(liveThinking?.id, committedThinking?.id, 'live and committed reasoning keep one stable timeline block id');
  assertEqual(liveActivity?.id, committedActivity?.id, 'live and committed activity keep one stable timeline block id');

  const streamingProjection = buildTimelineProjectionWithLiveOverlay({
    sessionId: 'session-live-overlay',
    committedEvents: [userEvent],
    activeDeltas: [activeDeltas[1]],
  });
  assertEqual(
    streamingProjection.turns[0].blocks.some((block) => block.narrativeKind === 'thinking'),
    true,
    'standalone provider reasoning delta is visible as a live thinking trace'
  );

  const dedupedProjection = buildTimelineProjectionWithLiveOverlay({
    sessionId: 'session-live-overlay',
    committedEvents: [
      userEvent,
      {
        id: 'event-already-committed-resource',
        sessionId: 'session-live-overlay',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'tool_result',
        payload: {
          channel: 'tool',
          status: 'completed',
          summary: 'Read generic project resources.',
          activity: readActivity,
        },
      },
    ],
    activeDeltas: [activeDeltas[1]],
  });
  assertEqual(
    dedupedProjection.turns[0].blocks.filter((block) => block.activity?.activityId === 'activity-live-read').length,
    1,
    'active activity is suppressed when the same activityId is already committed'
  );

  const firstActionRunning = {
    activityId: 'activity-action-a-running',
    kind: 'editFileStarted' as const,
    status: 'running' as const,
    title: 'Update generic source',
    summary: 'Updating a generic source file.',
    source: 'kernel' as const,
    runId: 'run-live-overlay',
    actionIds: ['action-a'],
    workUnitIds: ['work-unit-a'],
    targets: ['src/generic-a.ts'],
  };
  const firstActionCompleted = {
    ...firstActionRunning,
    activityId: 'activity-action-a-completed',
    kind: 'editFileCompleted' as const,
    status: 'completed' as const,
    summary: 'Updated a generic source file.',
  };
  const secondActionCompleted = {
    ...firstActionCompleted,
    activityId: 'activity-action-b-completed',
    title: 'Update another generic source',
    summary: 'Updated another generic source file.',
    actionIds: ['action-b'],
    workUnitIds: ['work-unit-b'],
    targets: ['src/generic-b.ts'],
  };
  const actionProjection = buildTimelineProjectionWithLiveOverlay({
    sessionId: 'session-live-overlay',
    committedEvents: [userEvent],
    activeDeltas: [
      {
        type: 'workunit_delta',
        seq: 1,
        sessionId: 'session-live-overlay',
        runId: 'run-live-overlay',
        turnId: 'turn-live-overlay',
        channel: 'workunit',
        source: 'kernel',
        status: 'running',
        activity: firstActionRunning,
      },
      {
        type: 'workunit_delta',
        seq: 2,
        sessionId: 'session-live-overlay',
        runId: 'run-live-overlay',
        turnId: 'turn-live-overlay',
        channel: 'workunit',
        source: 'kernel',
        status: 'completed',
        activity: firstActionCompleted,
      },
      {
        type: 'workunit_delta',
        seq: 3,
        sessionId: 'session-live-overlay',
        runId: 'run-live-overlay',
        turnId: 'turn-live-overlay',
        channel: 'workunit',
        source: 'kernel',
        status: 'completed',
        activity: secondActionCompleted,
      },
    ],
  });
  const actionBlocks = actionProjection.turns[0].blocks.filter((block) => block.activity);
  assertEqual(actionBlocks.length, 2, 'different actions render as separate activity cards');
  assertEqual(actionBlocks[0]?.events.length, 2, 'one action updates its activity card in place');
  assertEqual(actionBlocks[0]?.activity?.status, 'completed', 'the latest action fact controls the grouped activity status');
  assertEqual(actionBlocks[1]?.activity?.actionIds?.[0], 'action-b', 'the next action keeps an independent activity card');
}

function assertTaskPlanTaskProjectionProgress(): void {
  const planEvent: AgentEvent = {
    id: 'event-plan-progress',
    sessionId: 'session-task-projection',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId: 'run-task-projection',
      planId: 'plan-task-projection',
      title: 'Generic implementation plan',
      summary: 'Review generic implementation tasks.',
      taskPlan: {
        id: 'plan-task-projection',
        tasks: [
          {
            taskId: 'task-alpha',
            title: 'Update generic module',
            target: ['src/generic-module.ts'],
            scope: 'Update a generic module.',
            acceptanceCriteria: ['Kernel facts show the module update.'],
            failureCriteria: ['Stop if Kernel rejects the update.'],
          },
          {
            taskId: 'task-beta',
            title: 'Update generic validation',
            target: ['src/generic-validation.ts'],
            scope: 'Update generic validation.',
            acceptanceCriteria: ['Kernel facts show validation update.'],
            failureCriteria: ['Stop if validation cannot be updated.'],
          },
        ],
      },
    },
  };
  const waitingProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [planEvent],
  });
  const waitingItems = waitingProjection.taskProjection?.items ?? [];
  assertEqual(
    waitingItems.filter((item) => item.id.includes('implementation-plan')).every((item) => item.status === 'waiting'),
    true,
    'implementation plan tasks wait for user confirmation'
  );

  const acceptedNoFactsProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [
      planEvent,
      {
        id: 'event-plan-accepted-no-facts',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'plan_review',
        payload: {
          runId: 'run-task-projection',
          planId: 'plan-task-projection',
          status: 'accepted',
          summary: 'User accepted the generic implementation plan.',
        },
      },
    ],
  });
  const acceptedNoFactsItems = acceptedNoFactsProjection.taskProjection?.items ?? [];
  assertEqual(
    acceptedNoFactsItems.filter((item) => item.id.includes('implementation-plan')).every((item) => item.status === 'queued'),
    true,
    'accepted implementation tasks stay queued until Kernel WorkUnit or tool facts match them'
  );

  const acceptedProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [
      planEvent,
      {
        id: 'event-plan-accepted',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'plan_review',
        payload: {
          runId: 'run-task-projection',
          planId: 'plan-task-projection',
          status: 'accepted',
          summary: 'User accepted the generic implementation plan.',
        },
      },
      {
        id: 'event-work-alpha',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'work_unit.completed',
          kernelEvent: {
            kind: 'work_unit.completed',
            workUnitId: 'work-unit-task-projection-alpha',
            output: { path: 'src/generic-module.ts' },
          },
        },
      },
      {
        id: 'event-work-beta',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:03.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'work_unit.started',
          activity: {
            targets: ['src/generic-validation.ts'],
            workUnitIds: ['work-unit-task-projection-beta'],
          },
          kernelEvent: {
            kind: 'work_unit.started',
            workUnitId: 'work-unit-task-projection-beta',
          },
        },
      },
    ],
  });
  const acceptedItems = acceptedProjection.taskProjection?.items ?? [];
  const alpha = acceptedItems.find((item) => item.title === 'Update generic module');
  const beta = acceptedItems.find((item) => item.title === 'Update generic validation');
  assertEqual(alpha?.status, 'completed', 'implementation task status follows matching Kernel completion facts');
  assertEqual(beta?.status, 'running', 'implementation task status follows matching Kernel running facts');

  const directoryProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [
      {
        id: 'event-plan-directory-progress',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'plan_card',
        payload: {
          runId: 'run-directory-projection',
          planId: 'plan-directory-projection',
          title: 'Directory cleanup plan',
          summary: 'Review generic directory cleanup tasks.',
          taskPlan: {
            id: 'plan-directory-projection',
            tasks: [
              {
                taskId: 'task-build-dir',
                title: 'Remove generated directory',
                targets: ['alpha-build/'],
                acceptanceCriteria: ['Kernel facts show the directory removal.'],
              },
              {
                taskId: 'task-source-dir',
                title: 'Remove source directory',
                target: ['beta-src/'],
                acceptanceCriteria: ['Kernel facts show the directory removal.'],
              },
            ],
          },
        },
      },
      {
        id: 'event-plan-directory-accepted',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'plan_review',
        payload: {
          runId: 'run-directory-projection',
          planId: 'plan-directory-projection',
          status: 'accepted',
          summary: 'User accepted the directory cleanup plan.',
        },
      },
      {
        id: 'event-plan-directory-checkpoint',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'accepted_plan.batch_checkpoint',
          runId: 'run-directory-projection-child',
          sourcePlanId: 'plan-directory-projection',
          completedTaskIds: ['task-build-dir', 'task-source-dir'],
          remainingTaskIds: [],
          taskLedger: {
            schemaVersion: 'deepcode.session.task-ledger.v1',
            planId: 'plan-directory-projection',
            runId: 'run-directory-projection-child',
            taskOrder: ['task-build-dir', 'task-source-dir'],
            completedTaskIds: ['task-build-dir', 'task-source-dir'],
            skippedTaskIds: [],
            acceptedIncompleteTaskIds: [],
            pendingTaskIds: [],
            entries: [
              {
                taskId: 'task-build-dir',
                title: 'Remove generated directory',
                targets: ['alpha-build/'],
                status: 'completedByKernelFacts',
              },
              {
                taskId: 'task-source-dir',
                title: 'Remove source directory',
                targets: ['beta-src/'],
                status: 'completedByKernelFacts',
              },
            ],
          },
        },
      },
    ],
  });
  const directoryItems = directoryProjection.taskProjection?.items ?? [];
  assertEqual(
    directoryItems.filter((item) => item.id.includes('implementation-plan')).every((item) => item.status === 'completed'),
    true,
    'accepted-plan taskLedger checkpoint from a child run overrides plan-card task statuses for directory targets'
  );

  const staleLedgerProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [
      planEvent,
      {
        id: 'event-stale-ledger-plan-accepted',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'plan_review',
        payload: {
          runId: 'run-task-projection',
          planId: 'plan-task-projection',
          status: 'accepted',
        },
      },
      {
        id: 'event-stale-ledger-checkpoint',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'accepted_plan.batch_checkpoint',
          runId: 'run-task-projection-child',
          planId: 'plan-task-projection',
          taskLedger: {
            schemaVersion: 'deepcode.session.task-ledger.v1',
            planId: 'plan-task-projection',
            runId: 'run-task-projection-child',
            taskOrder: ['task-alpha', 'task-beta'],
            completedTaskIds: [],
            skippedTaskIds: [],
            acceptedIncompleteTaskIds: [],
            pendingTaskIds: ['task-alpha', 'task-beta'],
            entries: [
              {
                taskId: 'task-alpha',
                title: 'Update generic module',
                targets: ['src/generic-module.ts'],
                status: 'pending',
              },
              {
                taskId: 'task-beta',
                title: 'Update generic validation',
                targets: ['src/generic-validation.ts'],
                status: 'pending',
              },
            ],
          },
        },
      },
      {
        id: 'event-stale-ledger-work-alpha',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:03.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'work_unit.completed',
          kernelEvent: {
            kind: 'work_unit.completed',
            workUnitId: 'work-unit-stale-ledger-alpha',
            output: { path: 'src/generic-module.ts' },
          },
        },
      },
    ],
  });
  const staleLedgerAlpha = staleLedgerProjection.taskProjection?.items.find((item) => item.title === 'Update generic module');
  const staleLedgerBeta = staleLedgerProjection.taskProjection?.items.find((item) => item.title === 'Update generic validation');
  assertEqual(staleLedgerAlpha?.status, 'completed', 'Kernel completion facts advance stale pending task-ledger projection entries');
  assertEqual(staleLedgerBeta?.status, 'queued', 'pending task-ledger entries remain queued when no Kernel facts match');
}

function assertSessionDriverSkeleton(): void {
  const driver = new SessionDriver();
  const frame = driver.handleUserTurn({
    sessionId: 'session-generic',
    content: 'Create a generic change.',
    explicitDevelopmentTask: true,
    stateContract: {
      runId: 'run-generic',
      stateId: 'needProposal',
      stateKind: 'driverRequest',
      allowedInputs: ['proposalSubmit'],
      allowedProposals: ['actionBundle'],
      proposalSchemaRefs: ['deepcode.agent.protocol.v4'],
      capabilityProjection: ['fs.write'],
    },
  });
  assertEqual(frame.entryIntent, 'developmentTask', 'SessionDriver routes development work');
  assertEqual(frame.status, 'awaitingKernel', 'SessionDriver skeleton does not execute tools');
}

async function assertSessionDriverLoop(): Promise<void> {
  const events: AgentEvent[] = [];
  const session: AgentSession = {
    id: 'session-generic',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => fakeLlm(request),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-generic',
    content: 'Analyze the attached resource.',
    attachments: [
      {
        kind: 'file',
        path: 'generic/file.txt',
        absolutePath: '/tmp/generic/file.txt',
        source: 'userSelected',
        scope: 'message',
      },
    ],
  });
  assertEqual(result.events.some((event) => event.kind === 'user_msg'), true, 'DriverLoop appends user turn');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'DriverLoop appends final answer');
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'DriverLoop records ResourcePacket context');
}

async function assertSessionDriverLoopPathResourceRequest(): Promise<void> {
  const token = randomSmokeToken('path-resource');
  const sessionId = `session-${token}`;
  const workspaceRoot = `/tmp/${token}/${randomSmokeToken('root')}`;
  const requestedPath = `${randomSmokeToken('directory')}/${randomSmokeToken('file')}.txt`;
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: `run-${token}`,
            sessionId,
            packet: kernelTestResourcePacket(
              `packet-${resourceResolveManifests.length}`,
              command.requestId,
              [{
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                contentKind: entry.kind === 'directory' ? 'directoryTree' : 'fileText',
                absolutePath: entry.resourceRef,
                nodes: entry.kind === 'directory' ? [{ type: 'file', path: 'README.txt' }] : undefined,
                content: entry.kind === 'directory' ? undefined : 'generic resolved file content',
                evidenceRefs: ['evidence-path'],
              }],
            ),
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return semanticToolLlmResponse('session.request_resources', {
          reason: 'Need a generic file from the attached directory.',
          requests: [{ kind: 'fileText', path: requestedPath, reason: 'Read the selected source file.' }],
        }, 'need-generic-file');
      }
      return semanticToolLlmResponse('session.submit_answer', {
        content: 'Generic directory context was resolved by path.',
      }, 'answer-generic-path');
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId,
    content: 'Analyze the attached directory.',
    attachments: [{
      kind: 'directory',
      path: `root-${token}`,
      absolutePath: workspaceRoot,
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'path resourceRequest reaches final answer');
  assert(resourceResolveManifests.length >= 2, 'path resourceRequest triggers a second Kernel ResourceResolve');
  const secondEntry = resourceResolveManifests[1].entries[0];
  assertEqual(secondEntry.kind, 'resource', 'path resourceRequest is synthesized as a Kernel-resolved resource');
  assertEqual(secondEntry.resourceRef, requestedPath, 'path resourceRequest remains relative to the selected root');
  assertEqual(
    secondEntry.rootId,
    resourceResolveManifests[0].entries[0].rootId,
    'path resourceRequest preserves the selected root identity'
  );
}

async function assertSessionDriverLoopSearchResourceRequest(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-search-resource',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        const manifest = command.request?.manifest as any;
        resourceResolveManifests.push(manifest);
        const entry = manifest?.entries?.[0] ?? {};
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            packet: kernelTestResourcePacket(
              `packet-${resourceResolveManifests.length}`,
              command.requestId,
              [{
                requestItemId: 'search-item',
                manifestEntryId: entry.id ?? 'search-entry',
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                resolvedKind: entry.kind,
                contentKind: entry.kind === 'search' ? 'searchResults' : 'directoryTree',
                path: entry.path ?? entry.resourceRef,
                absolutePath: entry.resourceRef,
                query: entry.query,
                include: entry.include,
                matches: entry.kind === 'search'
                  ? [{ path: 'src/generic.txt', line: 2, preview: 'generic anchor line' }]
                  : undefined,
                returnedMatches: entry.kind === 'search' ? 1 : undefined,
                truncated: false,
                promptContent: entry.kind === 'search'
                  ? JSON.stringify({ matches: [{ path: 'src/generic.txt', line: 2, preview: 'generic anchor line' }] })
                  : undefined,
                nodes: entry.kind === 'search' ? undefined : [{ type: 'file', path: 'src/generic.txt' }],
                evidenceRefs: ['evidence-search'],
              }],
            ),
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return semanticToolLlmResponse('session.request_resources', {
          reason: 'Need generic search evidence.',
          requests: [{
            kind: 'search',
            query: 'generic anchor',
            include: ['src/'],
            contextLines: 2,
            maxResults: 10,
            reason: 'Find a generic anchor.',
          }],
        }, 'need-generic-search');
      }
      return semanticToolLlmResponse('session.submit_answer', {
        content: 'Generic search evidence was resolved.',
      }, 'answer-generic-search');
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-search-resource',
    content: 'Find a generic anchor before editing.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'search resourceRequest reaches final answer');
  assert(resourceResolveManifests.length >= 2, 'search resourceRequest triggers Kernel ResourceResolve');
  const secondEntry = resourceResolveManifests[1].entries[0];
  assertEqual(secondEntry.kind, 'search', 'search resourceRequest is synthesized as a Kernel search entry');
  assertEqual(secondEntry.query, 'generic anchor', 'search manifest carries query');
  assertEqual(secondEntry.include[0], 'src/', 'search manifest carries include filter');
  assertEqual(secondEntry.contextLines, 2, 'search manifest carries contextLines');
  assertEqual(secondEntry.maxResults, 10, 'search manifest carries maxResults');
}

async function assertSessionDriverLoopRejectsOutsidePath(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-outside',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: 'run-generic',
            sessionId: 'session-outside',
            packet: kernelTestResourcePacket(
              `packet-outside-${resourceResolveManifests.length}`,
              command.requestId,
              [{
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                contentKind: 'directoryTree',
                absolutePath: entry.resourceRef,
                nodes: [],
                evidenceRefs: ['evidence-outside'],
              }],
            ),
          }],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return semanticToolLlmResponse('session.request_resources', {
          reason: 'Attempt to read an outside path.',
          requests: [{ kind: 'fileText', path: '/tmp/outside.txt', reason: 'Outside path should not be granted.' }],
        }, 'outside-request');
      }
      return semanticToolLlmResponse('session.submit_answer', {
        content: 'Outside path was not granted.',
      }, 'answer-outside-path');
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-outside',
    content: 'Analyze the attached directory.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'outside path repair reaches final answer');
  assertEqual(resourceResolveManifests.length, 1, 'outside absolute path does not become a Kernel ResourceResolve manifest entry');
}

async function assertSessionDriverLoopUsesRecentAttachmentRoot(): Promise<void> {
  const token = randomSmokeToken('recent-root');
  const sessionId = `session-${token}`;
  const previousRoot = `/tmp/${token}/${randomSmokeToken('root')}`;
  const requestedPath = `${randomSmokeToken('overview')}.txt`;
  const events: AgentEvent[] = [];
  const existingEvents: AgentEvent[] = [{
    id: `previous-user-${token}`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: {
      content: 'Analyze the attached directory.',
      attachments: [{
        kind: 'directory',
        path: `root-${token}`,
        absolutePath: previousRoot,
        source: 'userSelected',
        scope: 'message',
      }],
    },
  }];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: `run-${token}`,
            sessionId,
            packet: kernelTestResourcePacket(
              `packet-recent-${resourceResolveManifests.length}`,
              command.requestId,
              [{
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                contentKind: 'fileText',
                absolutePath: entry.resourceRef,
                content: 'recent generic content',
                evidenceRefs: ['evidence-recent'],
              }],
            ),
          }],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return semanticToolLlmResponse('session.request_resources', {
          reason: 'Need a file from the recent attached directory.',
          requests: [{ kind: 'fileText', path: requestedPath, reason: 'Read the selected overview.' }],
        }, 'recent-path-request');
      }
      return semanticToolLlmResponse('session.submit_answer', {
        content: 'Recent attachment root was reused.',
      }, 'answer-recent-path');
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId,
    content: 'Read the overview from that project.',
    attachments: [],
    existingEvents,
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'recent root path request reaches final answer');
  assertEqual(resourceResolveManifests.length, 1, 'recent attachment root is not auto-read before the model requests a path');
  assertEqual(resourceResolveManifests[0].entries[0].resourceRef, requestedPath, 'recent root keeps the requested path relative');
  assert(
    typeof resourceResolveManifests[0].entries[0].rootId === 'string',
    'recent root request keeps the selected root identity'
  );
}

async function assertSessionDriverLoopReadOnlyRequestsContinueWithoutBudgetDecision(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-readonly-unbounded',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => resourceBudgetKernel(request, resourceResolveManifests, 'session-readonly-unbounded'),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(!promptText.includes('Read-only resource budget:'), 'provider prompt does not expose fixed read-only resource budget');
      if (llmCalls > 12) {
        return semanticToolLlmResponse('session.submit_answer', {
          content: 'Read-only exploration continued and then converged.',
        }, 'answer-readonly-converged');
      }
      return semanticToolLlmResponse('session.request_resources', {
        reason: 'Need another generic resource.',
        requests: [{ kind: 'fileText', path: `src/file-${llmCalls}.txt`, reason: 'Read the next generic source.' }],
      }, `budget-request-${llmCalls}`);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-readonly-unbounded',
    content: 'Analyze the attached generic project.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(llmCalls, 13, 'read-only resource requests continue beyond the former eight-round budget and then converge');
  assertEqual(resourceResolveManifests.length, 13, 'initial attachment plus twelve requested resource packets were resolved');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'read-only resource loop no longer emits a budget decision card');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any)?.diagnostic === true), false, 'read-only continuation is not a terminal diagnostic');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.channel === 'final' &&
      String((event.payload as any)?.content ?? '').includes('continued')
    ),
    true,
    'read-only continuation produces a final answer when the provider converges'
  );
}

async function assertSessionDriverLoopOldResourceBudgetDecisionFailsClosed(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-budget-legacy',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const oldBudgetConfirmation: AgentEvent = {
    id: 'legacy-resource-budget-confirmation',
    sessionId: 'session-budget-legacy',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      title: '用户介入请求',
      summary: '只读资源预算已用完，需要用户决定是否继续读取上下文。',
      status: 'waitingUserConfirmation',
      confirmable: true,
      runId: 'run-budget-legacy',
      requirementId: 'resource-budget-run-budget-legacy',
      originalUserRequest: 'Analyze the attached generic project.',
      attachments: [],
      requirement: {
        requirementId: 'resource-budget-run-budget-legacy',
        sessionId: 'session-budget-legacy',
        initialUserRequest: 'Analyze the attached generic project.',
        checklist: { goal: 'Legacy budget confirmation.' },
        status: 'probing',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => resourceBudgetKernel(request, resourceResolveManifests, 'session-budget-legacy'),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(!promptText.includes('Read-only resource budget:'), 'legacy budget continuation resumes without exposing a new fixed budget');
      return semanticToolLlmResponse('session.submit_answer', {
        content: 'Continued after legacy budget approval.',
      }, 'answer-legacy-budget');
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const next = await loop.resolveDecision({
    sessionId: 'session-budget-legacy',
    kind: 'requirement',
    decision: 'accept',
    runId: 'run-budget-legacy',
    targetId: 'resource-budget-run-budget-legacy',
    existingEvents: [oldBudgetConfirmation],
  });
  assertEqual(llmCalls, 0, 'legacy in-progress interaction without turn authority does not call the provider');
  assertEqual(
    next.events.some((event) =>
      event.kind === 'error' &&
      JSON.stringify(event.payload).includes('session_turn_authority_unavailable')
    ),
    true,
    'legacy in-progress interaction without turn authority fails closed with a structured diagnostic'
  );
  assertEqual(
    next.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'),
    false,
    'legacy in-progress interaction does not fabricate a final answer'
  );
}

function resourceBudgetKernel(
  request: KernelCommandEnvelope,
  resourceResolveManifests: Array<Record<string, any>>,
  sessionId: string
): KernelReply {
  const command = request.command as Record<string, any>;
  if (command.kind === 'runCreate') {
    const reply = fakeKernel(request);
    for (const event of reply.events ?? []) {
      (event as any).sessionId = sessionId;
    }
    return reply;
  }
  if (command.kind === 'resourceResolve') {
    resourceResolveManifests.push(command.request.manifest);
    const entry = command.request.manifest.entries[0];
    return {
      ok: true,
      events: [{
        kind: 'resource.packet_produced',
        runId: 'run-generic',
        sessionId,
        packet: kernelTestResourcePacket(
          `packet-budget-${resourceResolveManifests.length}`,
          command.requestId,
          [{
            requestItemId: 'item-generic',
            manifestEntryId: entry.id,
            status: 'resolved',
            readPolicy: 'explicit-manifest-readonly',
            sourceKind: entry.kind,
            contentKind: entry.kind === 'directory' ? 'directoryTree' : 'fileText',
            absolutePath: entry.resourceRef,
            path: entry.resourceRef,
            nodes: entry.kind === 'directory' ? [{ type: 'file', path: 'src/file-1.txt' }] : undefined,
            content: entry.kind === 'directory' ? undefined : `content for ${String(entry.resourceRef).replace('/tmp/generic-project/', '')}`,
            truncated: entry.kind !== 'directory' && String(entry.resourceRef).endsWith('file-8.txt'),
            originalBytes: entry.kind !== 'directory' ? 24000 : undefined,
            evidenceRefs: ['evidence-budget'],
          }],
        ),
      }],
    };
  }
  return { ok: true, events: [] };
}

async function assertSessionDriverLoopAdmitsSemanticTaskPlanWithoutKernelAction(): Promise<void> {
  const events: AgentEvent[] = [];
  const transcript: TranscriptEntry[] = [];
  let llmCalls = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-plan-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    appendTranscript: async (_sessionId, entry) => {
      transcript.push(entry);
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'proposalSubmit') {
        submittedPlans.push(command.proposal);
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        return {
          ok: true,
          events: [
            {
              kind: 'proposal.accepted',
              runId: 'run-generic',
              sessionId: 'session-plan-repair',
              proposal: command.proposal,
            },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: 'session-plan-repair',
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const response = semanticToolLlmResponse('session.submit_plan', {
        title: 'Generic scaffold plan',
        summary: 'Prepare one generic workspace artifact after user confirmation.',
        tasks: [{
          taskId: 'task-generic-scaffold',
          title: 'Prepare generic workspace artifact',
          toolId: 'fs.write',
          targets: ['generic-output.txt'],
          args: {},
          dependencies: [],
          acceptanceCriteria: ['Kernel facts record the confirmed artifact operation.'],
          failureCriteria: ['Stop if the target leaves the confirmed task scope.'],
        }],
        risks: [],
        reviewCheckpoints: ['Review Kernel facts after execution.'],
      }, 'plan-generic-scaffold');
      if (response.ok && response.data?.assistantMessage) {
        response.data.chunks = [{ type: 'reasoning_delta', content: `generic reasoning ${llmCalls}` }, { type: 'done' }];
        response.data.assistantMessage.reasoningContent = `generic reasoning ${llmCalls}`;
      }
      return response;
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + transcript.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-plan-repair',
    content: 'Create a generic scaffold.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 1, 'planning accepts one Session semantic plan directive');
  assertEqual(submittedPlans.length, 0, 'planning does not compile or submit Kernel actions before user confirmation');
  const planCards = result.events.filter((event) => event.kind === 'plan_card');
  const planReviews = result.events.filter((event) => event.kind === 'plan_review');
  assertEqual(
    planCards.length,
    1,
    `semantic task plan renders one interactive plan card; events=${JSON.stringify(result.events.map((event) => ({ kind: event.kind, payload: event.payload })))}`
  );
  assertEqual((planCards[0]?.payload as any)?.decisionOwner?.kind, 'plan', 'plan card owns the plan decision');
  assertEqual((planCards[0]?.payload as any)?.status, 'confirmable', 'Kernel-authorized plan card waits for user confirmation');
  assertEqual(planReviews.length, 0, 'planning does not create a Kernel action review event');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.reason === 'plan_review'
    ),
    true,
    'waiting plan review is exposed as an explicit session run state'
  );
  const timeline = buildNarrativeTimelineProjection({
    sessionId: result.session.id,
    events: result.events,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  assertEqual(
    timeline.interactionProjection?.pending?.kind,
    'plan',
    'Kernel-authorized confirmable plan remains available as the pending user decision'
  );
  assertEqual(
    timeline.turns.flatMap((turn) => turn.blocks).find((block) => block.narrativeKind === 'plan')?.status,
    'waiting',
    'Kernel-authorized confirmable plan remains waiting in the canonical timeline'
  );
  assertEqual(
    timeline.turns.find((turn) => turn.blocks.some((block) => block.narrativeKind === 'plan'))?.status,
    'blocked',
    'the containing turn remains paused at the external plan decision boundary'
  );
  const providerReasoningEvent = result.events.find((event) =>
    event.kind === 'assistant_msg' &&
    (event.payload as any).channel === 'reasoning' &&
    String((event.payload as any).content ?? '').includes('generic reasoning')
  );
  assert(Boolean(providerReasoningEvent), 'provider reasoning is archived as an assistant reasoning event');
  assertEqual((providerReasoningEvent?.payload as any)?.visibility, 'conversation', 'provider reasoning remains visible to the user');
  assertEqual((providerReasoningEvent?.payload as any)?.presentation, 'collapsible', 'provider reasoning is visible as a collapsible trace, not body text');
  assertEqual(transcript.some((entry) => entry.type === 'metadata' && entry.kind === 'provider_trace'), true, 'provider trace is archived');
}

async function assertSessionDriverLoopRepairsInvalidSourceBlock(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-source-block-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-source-block-repair', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const proposal = genericWriteProposal(false);
      if (llmCalls === 1) {
        (proposal.actionBundle as any).actions[0].contentBlockId = 'missing-code-block';
      }
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-source-block-repair',
    content: 'Create a generic scaffold.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'invalid contentBlockId triggers one protocol repair');
  assertEqual(submittedPlans.length, 1, 'only repaired actionBundle reaches Kernel');
  assertEqual(
    submittedPlans[0].payload?.actionBundle?.actions?.[0]?.contentBlockId,
    'generic-block',
    'repaired actionBundle contentBlockId matches a code block'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired contentBlockId plan renders a plan card');
}

async function assertSessionDriverLoopCanonicalizesMissingSourceBlockId(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-source-block-canonicalize',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-source-block-canonicalize', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const proposal = genericWriteProposal(false);
      delete (proposal.actionBundle as any).actions[0].args.contentBlockId;
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-source-block-canonicalize',
    content: 'Create a generic file from the provided code block.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 1, 'missing contentBlockId with a unique targetPath match is canonicalized without provider repair');
  assertEqual(submittedPlans.length, 1, 'canonicalized actionBundle reaches Kernel PlanReview once');
  const action = submittedPlans[0].payload?.actionBundle?.actions?.[0] ?? {};
  assertEqual(action.contentBlockId, 'generic-block', 'canonicalized action exposes contentBlockId for existing Session checks');
  assertEqual(action.args?.contentBlockId, 'generic-block', 'canonicalized action writes args.contentBlockId for Kernel execution');
  assertEqual(
    submittedPlans[0].parserDiagnostics?.canonicalizations?.[0]?.kind,
    'fs_write_contentBlockId_canonicalized',
    'canonicalization telemetry records the safe contentBlockId repair'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'canonicalized write renders a plan card');
}

async function assertSessionDriverLoopRepairsAmbiguousSourceBlockId(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-source-block-ambiguous',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-source-block-ambiguous', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      if (llmCalls === 1) {
        const proposal = genericWriteProposal(false);
        proposal.contentBlocks = [
          { blockId: 'generic-block-a', targetPath: 'generic-output.txt', contentLines: ['generic content a'] },
          { blockId: 'generic-block-b', targetPath: 'generic-output.txt', contentLines: ['generic content b'] },
        ];
        delete (proposal.actionBundle as any).actions[0].args.contentBlockId;
        return jsonLlmResponse(proposal);
      }
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-source-block-ambiguous',
    content: 'Create a generic file from one of several candidate blocks.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'ambiguous missing contentBlockId triggers one protocol repair');
  assertEqual(repairRequests.length, 1, 'ambiguous contentBlockId repair asks provider once');
  assert(
    repairRequests[0].messages.some((message) => message.content.includes('args.contentBlockId')),
    'repair prompt explains the fs.write args.contentBlockId requirement'
  );
  assertEqual(submittedPlans.length, 1, 'only repaired ambiguous contentBlockId proposal reaches Kernel');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired ambiguous write renders a plan card');
}

async function assertSessionDriverLoopRepairsEmptyDirectoryPlaceholderWrite(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-empty-placeholder-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-empty-placeholder-repair', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      if (llmCalls === 1) {
        const proposal = genericWriteProposal(false);
        proposal.contentBlocks = [{
          blockId: 'generic-placeholder-block',
          targetPath: 'generic-dir/.gitkeep',
          operation: 'create',
          allowEmptyContent: true,
          contentLines: [],
        }];
        (proposal.actionBundle as any).actions[0].args = {
          path: 'generic-dir/.gitkeep',
          contentBlockId: 'generic-placeholder-block',
        };
        return jsonLlmResponse(proposal);
      }
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-empty-placeholder-repair',
    content: 'Create concrete files under a generic directory.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'empty placeholder write triggers one protocol repair');
  assert(
    repairRequests[0].messages.some((message) => message.content.includes('.gitkeep') && message.content.includes('Directory targets')),
    'repair prompt rejects empty directory placeholder writes'
  );
  assertEqual(submittedPlans.length, 1, 'repaired placeholder write reaches Kernel');
  assertEqual(
    submittedPlans[0].payload?.actionBundle?.actions?.[0]?.args?.path,
    'generic-output.txt',
    'repair replaces placeholder directory write with a concrete file write'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired placeholder write renders a plan card');
}

async function assertSessionDriverLoopAllowsManyNoCodeActionsWithoutBatchRepair(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-many-delete-actions',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-many-delete-actions', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      return jsonLlmResponse(manyDeleteActionsProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-many-delete-actions',
    content: 'Delete several generic obsolete files in one reviewed batch.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 1, 'many no-code actions do not trigger implementation batch repair');
  assertEqual(repairRequests.length, 0, 'many no-code actions do not ask the provider to shrink by action count');
  assertEqual(submittedPlans.length, 1, 'many delete actions reach Kernel PlanReview once');
  assertEqual(submittedPlans[0].payload?.actionBundle?.actions?.length, 7, 'all delete actions remain in the Kernel-reviewed proposal');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'many delete action plan renders a Kernel-reviewed plan card');
}

async function assertSessionDriverLoopAllowsManyContentBlocksWithoutBatchRepair(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-many-codeblocks',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-many-codeblocks', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      return jsonLlmResponse(manyContentBlockWriteProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-many-codeblocks',
    content: 'Create several generic files in one reviewed batch.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 1, 'many contentBlocks under payload budget do not trigger repair');
  assertEqual(repairRequests.length, 0, 'many contentBlocks do not ask the provider to shrink by count');
  assertEqual(submittedPlans.length, 1, 'many contentBlocks reach Kernel PlanReview once');
  assertEqual(submittedPlans[0].payload?.contentBlocks?.length, 7, 'all contentBlocks remain in the Kernel-reviewed proposal');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'many codeBlock plan renders a plan card');
}

async function assertSessionDriverLoopRepairsEmptyActionBundleResponse(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const retryRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-empty-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-empty-repair', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'reasoning_delta', content: 'generic large draft reasoning' }, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              reasoningContent: 'generic large draft reasoning',
              content: '',
            },
          },
        };
      }
      retryRequests.push(request);
      return jsonLlmResponse(genericTaskPlanProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-empty-repair',
    content: 'Create a generic workspace change in reviewable batches.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'empty planning response triggers one provider retry');
  assertEqual(submittedPlans.length, 0, 'repaired empty planning response does not submit executable Kernel plan review');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired empty response renders a taskPlan card');
  assertEqual(retryRequests.length, 1, 'empty planning response retry asks provider once');
  const retryPrompt = retryRequests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assert(
    retryPrompt.includes('The previous provider turn returned no JSON proposal.'),
    'empty planning response uses provider retry before protocol repair'
  );
  assert(
    !retryPrompt.includes('requiredKind: actionBundle'),
    'empty planning response retry must not force an actionBundle'
  );
  assert(
    !retryPrompt.includes('actionBundle.actions[] are executable Kernel tool actions') &&
      !retryPrompt.includes('Kernel catalog ids') &&
      !retryPrompt.includes('fs.delete intent'),
    'planning empty response retry must not expose execution tool schema'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      String((event.payload as any)?.summary ?? '').includes('Agent Protocol v4 修复')
    ),
    false,
    'empty response retry should not enter protocol repair when retry succeeds'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      String((event.payload as any)?.summary ?? '').includes('缩小为下一批可审查 actionBundle')
    ),
    false,
    'planning empty response must not be projected as actionBundle compaction repair'
  );
}

async function assertSessionDriverLoopCanonicalizesSchemaVersionOnlyProposal(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-schema-version-only',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-schema-version-only', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      const proposal = genericTaskPlanProposal();
      proposal.schemaVersion = '1.0';
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-schema-version-only',
    content: 'Create a generic workspace change in reviewable batches.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 1, 'schemaVersion-only proposal repair is handled without a second provider call');
  assertEqual(repairRequests.length, 0, 'schemaVersion-only proposal does not build an LLM repair request');
  assertEqual(submittedPlans.length, 0, 'schemaVersion-only taskPlan remains non-executable');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'schemaVersion-only taskPlan renders a plan card');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      String((event.payload as any)?.summary ?? '').includes('Agent Protocol v4 repair')
    ),
    false,
    'schemaVersion-only proposal does not project a protocol repair stage'
  );
}

async function assertSessionDriverLoopCanonicalizesBareTaskPlanRepair(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const token = randomSmokeToken('bare-repair');
  const targetPath = `${token}/${randomSmokeToken('target')}.txt`;
  const session: AgentSession = {
    id: `session-${token}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, session.id, submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'reasoning_delta', content: 'generic protocol reasoning' }, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              reasoningContent: 'generic protocol reasoning',
              content: `not-json-${token}`,
            },
          },
        };
      }
      const repairedPlan = {
        version: '1',
        id: `task-plan-${token}`,
        title: 'Generic repaired task plan',
        summary: 'Plan a generic workspace change after protocol repair.',
        tasks: [
          {
            taskId: `task-${token}`,
            title: 'Prepare repaired generic output',
            target: [targetPath],
            capability: 'fs.write',
            acceptanceCriteria: ['Kernel facts later show the reviewed target was updated.'],
            failureCriteria: ['Stop if execution needs targets outside the accepted task plan.'],
          },
        ],
        risks: ['Workspace writes remain under Kernel permission policy.'],
        reviewCheckpoints: ['Review Kernel facts after Complete stage execution.'],
      };
      return {
        ok: true,
        data: {
          chunks: [{ type: 'reasoning_delta', content: `hidden repair reasoning ${token}` }, { type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            reasoningContent: `hidden repair reasoning ${token}`,
            content: JSON.stringify(repairedPlan),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: session.id,
    content: 'Create a generic workspace change in reviewable batches.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'invalid planning JSON triggers one protocol repair');
  assertEqual(submittedPlans.length, 0, 'bare repaired taskPlan remains non-executable');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'bare repaired taskPlan renders a plan card');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      String((event.payload as any)?.content ?? '').includes(`hidden repair reasoning ${token}`)
    ),
    false,
    'protocol repair reasoning stays in provider trace instead of user-visible assistant messages'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      String((event.payload as any)?.diagnosticCode ?? '').includes('agent_protocol_repair_failed')
    ),
    false,
    'bare repaired taskPlan does not terminate as protocol repair failure'
  );
}

async function assertSessionDriverLoopAcceptsLocalizedStructuredPlan(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-localized-plan',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-localized-plan', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(localizedGenericWriteProposal()),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-localized-plan',
    content: 'Create a generic workspace change.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(submittedPlans.length, 1, 'localized structured plan reaches Kernel without heading repair');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'localized structured plan renders a plan card');
}

async function assertSessionDriverLoopPlanRevisionReturnsToPlanning(): Promise<void> {
  const token = randomSmokeToken('plan-revision');
  const revisedTarget = `scope-${token}/target.txt`;
  const events = [
    ...turnAuthorityFixture(
      'session-plan-revision',
      'run-plan-revision',
      'Prepare a generic plan that can be revised before execution.',
      `plan-revision-${token}`
    ),
    genericKernelContextProjectionEvent('session-plan-revision', 'run-plan-revision'),
    genericResolvedResourceEvent('session-plan-revision', 'run-plan-revision', revisedTarget),
    acceptedTaskPlanCardEvent('session-plan-revision', 'run-plan-revision'),
  ];
  const session: AgentSession = {
    id: 'session-plan-revision',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const llmRequests: LlmChatRequest[] = [];
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return semanticToolLlmResponse('session.submit_plan', {
        title: `Revised plan ${token}`,
        summary: `Revised plan summary ${token}`,
        tasks: [{
          taskId: `task-${token}`,
          title: `Revise target ${token}`,
          toolId: 'fs.read',
          target: [revisedTarget],
          args: {},
          dependencies: [],
          acceptanceCriteria: [`Acceptance ${token}`],
          failureCriteria: [`Failure ${token}`],
        }],
        risks: [],
        reviewCheckpoints: [],
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmRequests.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'revise',
    guidance: 'Adjust the generic plan to stay as a reply-only planning exercise.',
    runId: 'run-plan-revision',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(
    result.events.some((event) =>
      event.kind === 'plan_review' &&
      (event.payload as any)?.status === 'needsRevision' &&
      (event.payload as any)?.planId === 'impl-generic-auto'
    ),
    true,
    'plan revise records a needsRevision decision for the pending plan'
  );
  assertEqual(
    result.events.filter((event) => event.kind === 'plan_card').length >= 2,
    true,
    'plan revise starts a new planning turn with a new plan card'
  );
  assertEqual(llmRequests.length, 1, 'plan revise calls provider once for replanning');
  assertEqual(actionBatchSubmits, 0, 'plan revise does not execute the old plan');
  const promptText = llmRequests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assert(promptText.includes('reply-only planning exercise'), 'plan revision guidance enters the next PromptEnvelope');
  const planningToolNames = (llmRequests[0]?.tools ?? []).map((tool) => tool.name);
  assert(planningToolNames.includes('session.submit_plan'), 'plan revision exposes the planning directive');
  assert(!planningToolNames.includes('session.append_artifact_chunk'), 'plan revision does not expose execution artifact tools');
}

function assertWorkflowStagePermissionProjectsPendingDecision(): void {
  const pending = findLatestPendingPermission([
    {
      id: 'event-permission',
      sessionId: 'session-permission',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'workflow_stage',
      payload: {
        kernelEvent: {
          kind: 'permission.requested',
          runId: 'run-permission',
          sessionId: 'session-permission',
          request: kernelTestPermissionRequest('permission-generic', {
            contractId: 'contract-permission',
            capability: 'fs.write',
            riskLevel: 'medium',
            summary: 'Allow a generic write operation?',
            argsPreview: { path: 'generic-output.txt' },
          }),
        },
      },
    },
  ]);
  assertEqual(pending?.request.id, 'permission-generic', 'workflow_stage permission.requested is recognized as pending permission');
}

async function assertSessionDriverLoopReviewRevisionReturnsToPlanning(): Promise<void> {
  const token = randomSmokeToken('review-revision-plan');
  const revisedTarget = `scope-${token}/revision.txt`;
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-review-revision',
      'run-review-source',
      'Create a generic batch and review its result.',
      `review-revision-${token}`
    ),
    genericKernelContextProjectionEvent('session-review-revision', 'run-review-source'),
    genericResolvedResourceEvent('session-review-revision', 'run-review-source', revisedTarget),
    {
    id: 'review-waiting-generic',
    sessionId: 'session-review-revision',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-source',
      reviewId: 'review-generic',
      sourcePlanId: 'plan-generic',
      content: '## Review\n\nThe first batch wrote a generic source file.',
      userPlan: '# Plan\n\n## Summary\nCreate the first generic batch.',
      facts: [
        '- `fs.write` ok: {"path":"generic-output.txt","validation":{"kind":"readBack","passed":true}}',
        '- `work-unit-generic` completed: {"path":"generic-output.txt"}',
      ],
      continuations: [{
        id: 'next-generic-batch',
        title: 'Add a generic follow-up script',
        capability: 'fs.write',
        kind: 'write',
        resourceScope: ['scripts/generic.sh'],
      }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-revision',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  let runCreates = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      if (request.command.kind === 'runCreate') runCreates += 1;
      return planKernel(request, 'session-review-revision', submittedPlans);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return semanticToolLlmResponse('session.submit_plan', {
        title: `Review revision plan ${token}`,
        summary: `Plan the requested review revision ${token}`,
        tasks: [{
          taskId: `task-${token}`,
          title: `Apply review revision ${token}`,
          toolId: 'fs.write',
          targets: [revisedTarget],
          args: {},
          dependencies: [],
          acceptanceCriteria: [`Acceptance ${token}`],
          failureCriteria: [`Failure ${token}`],
        }],
        risks: [],
        reviewCheckpoints: [],
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-revision',
    kind: 'review',
    decision: 'revise',
    guidance: 'Add a generic script and document how to run it.',
    runId: 'run-review-source',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'needsRevision'), true, 'review guidance is recorded as needsRevision');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'review revision starts a new planning turn');
  assertEqual(submittedPlans.length, 0, 'review revision projects the semantic task plan before any Kernel execution contract');
  assertEqual(llmRequests.length, 1, 'review revision calls the provider for a new plan once');
  assertEqual(runCreates, 0, 'Review revision resumes the original run without Kernel runCreate');
  const promptText = llmRequests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assert(promptText.includes('Add a generic script and document how to run it.'), 'review guidance enters the next PromptEnvelope');
  assert(promptText.includes('ProjectMemoryIndexDigest'), 'pending project memory candidates expose governance metadata');
  assert(!promptText.includes('ProjectMemoryRecall'), 'empty project memory recall is omitted from the provider prompt');
  assert(promptText.includes('SessionMemoryCompact'), 'structured session memory compact summary is included');
  assert(!promptText.includes('content=Review fact'), 'raw review facts are not promoted into ProjectMemory prompt content');
}

async function assertSessionDriverLoopReviewRevisionStopsWhenGateRunIsInactive(): Promise<void> {
  const token = randomSmokeToken('inactive-review-revision');
  const revisedTarget = `scope-${token}/revision.txt`;
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-review-revision-inactive-audit',
      'run-review-inactive-audit',
      'Create a generic batch and review its result.',
      `inactive-review-revision-${token}`
    ),
    genericKernelContextProjectionEvent('session-review-revision-inactive-audit', 'run-review-inactive-audit'),
    genericResolvedResourceEvent('session-review-revision-inactive-audit', 'run-review-inactive-audit', revisedTarget),
    {
    id: 'review-waiting-inactive-audit',
    sessionId: 'session-review-revision-inactive-audit',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-inactive-audit',
      reviewId: 'review-inactive-audit',
      sourcePlanId: 'plan-inactive-audit',
      content: '## Review\n\nA generic completed batch needs a revision.',
      userPlan: '# Plan\n\n## Summary\nCreate a generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-revision-inactive-audit',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'reviewGateEvaluate') {
        return {
          ok: false,
          events: [],
          error: {
            code: 'run_not_active',
            message: 'invalid command: run is not active',
          },
        };
      }
      return planKernel(request, session.id, submittedPlans);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return semanticToolLlmResponse('session.submit_plan', {
        title: `Inactive review revision plan ${token}`,
        summary: `Plan the requested revision after an inactive audit ${token}`,
        tasks: [{
          taskId: `task-${token}`,
          title: `Apply inactive review revision ${token}`,
          toolId: 'fs.write',
          targets: [revisedTarget],
          args: {},
          dependencies: [],
          acceptanceCriteria: [`Acceptance ${token}`],
          failureCriteria: [`Failure ${token}`],
        }],
        risks: [],
        reviewCheckpoints: [],
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'review',
    decision: 'revise',
    guidance: 'Revise the generic batch with an additional safe detail.',
    runId: 'run-review-inactive-audit',
    existingEvents: events,
  });

  assertEqual(
    result.events.some((event) =>
      event.kind === 'trace/review_accept_noop' &&
      (event.payload as any)?.errorCode === 'run_not_active'
    ),
    true,
    'inactive ReviewGate is recorded as a Session trace'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'review revise cannot continue when Kernel did not accept needsReplan');
  assertEqual(submittedPlans.length, 0, 'review revise projects the semantic task plan before Kernel execution admission');
  assertEqual(llmRequests.length, 0, 'review revise does not call Provider after ReviewGate failure');
}

async function assertSessionDriverLoopAcceptedDecisionSubmitsMultiWriteBatch(): Promise<void> {
  const actionBundle = multiWriteActionBundle();
  const events: AgentEvent[] = [
    {
      id: 'plan-card-multi-write',
      sessionId: 'session-plan-grant-group',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-plan-grant-group',
        planId: 'bundle-multi-write',
        proposalId: 'proposal-multi-write',
        content: '# Plan\n\n## Summary\nWrite multiple generic files.',
        actionBundle,
        contentBlocks: [
          { id: 'code-one', blockId: 'code-one', targetPath: 'generic-one.txt', content: 'one', contentLines: ['one'] },
          { id: 'code-two', blockId: 'code-two', targetPath: 'generic-two.txt', content: 'two', contentLines: ['two'] },
        ],
        commandBlocks: [],
        planReviewReport: proposalReviewReport(actionBundle),
      },
    },
    {
      id: 'plan-review-multi-write',
      sessionId: 'session-plan-grant-group',
      ts: '2026-01-01T00:00:00.001Z',
      kind: 'plan_review',
      payload: {
        status: 'awaitingUserApproval',
        runId: 'run-plan-grant-group',
        planId: 'bundle-multi-write',
        confirmable: true,
        report: proposalReviewReport(actionBundle),
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-plan-grant-group',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  await loop.resolveDecision({
    sessionId: 'session-plan-grant-group',
    kind: 'plan',
    decision: 'accept',
    runId: 'run-plan-grant-group',
    targetId: 'bundle-multi-write',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'multiple fs.write actions submit one plan-authorized action batch');
}

async function assertSessionDriverLoopAcceptedDecisionPreservesKernelAuthorizedTarget(): Promise<void> {
  const authorizedTarget = `${randomSmokeToken('authorized-target')}.txt`;
  const actionBundle: Record<string, any> = {
    version: '1',
    id: 'bundle-external-write',
    goal: 'Write a Kernel-authorized file.',
    actions: [
      {
        actionId: 'write-external',
        toolId: 'fs.write',
        args: { path: authorizedTarget, contentBlockId: 'code-external' },
        description: 'Write authorized file',
        dependsOn: [],
      },
    ],
    validationExpectations: [{ id: 'validation', description: 'Kernel records the authorized file write.' }],
    reviewExpectations: [{ id: 'review', description: 'User reviews the authorized file operation.' }],
  };
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-external-write',
      sessionId: 'session-plan-grant-external',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-plan-grant-external',
        planId: 'bundle-external-write',
        proposalId: 'proposal-external-write',
        content: '# Plan\n\n## Summary\nWrite one Kernel-authorized file.',
        actionBundle,
        contentBlocks: [
          { blockId: 'code-external', targetPath: authorizedTarget, operation: 'overwrite', contentLines: ['authorized'] },
        ],
        commandBlocks: [],
        planReviewReport: report,
      },
    },
    {
      id: 'plan-review-external-write',
      sessionId: 'session-plan-grant-external',
      ts: '2026-01-01T00:00:00.001Z',
      kind: 'plan_review',
      payload: {
        status: 'awaitingUserApproval',
        runId: 'run-plan-grant-external',
        planId: 'bundle-external-write',
        confirmable: true,
        report,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-plan-grant-external',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedBatches: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        submittedBatches.push(command.batch);
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedBatches.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: 'session-plan-grant-external',
    kind: 'plan',
    decision: 'accept',
    runId: 'run-plan-grant-external',
    targetId: 'bundle-external-write',
    existingEvents: events,
  });

  assertEqual(submittedBatches.length, 1, 'Kernel-authorized batch is submitted without a second Session decision');
  const submittedAction = submittedBatches[0]?.actionBundle?.actions?.[0];
  assertEqual(submittedAction?.args?.path, authorizedTarget, 'submitted action preserves the Kernel-authorized target');
}

async function assertSessionDriverLoopPlanCardAcceptDoesNotNoopWithoutPlanReview(): Promise<void> {
  const actionBundle = genericActionBundle();
  const events: AgentEvent[] = [
    {
      id: 'plan-card-only-generic',
      sessionId: 'session-plan-card-only',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-plan-card-only',
        planId: 'bundle-generic',
        proposalId: 'proposal-plan-card-only',
        title: 'Generic reviewed plan',
        summary: 'Review a generic workspace plan.',
        content: '# Plan\n\n## Summary\nReview a generic workspace plan.',
        actionBundle,
        contentBlocks: [{ id: 'code-generic', targetPath: 'generic/output.txt', content: 'generic output' }],
        commandBlocks: [],
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-plan-card-only',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-plan-card-only',
    kind: 'plan',
    decision: 'accept',
    runId: 'run-plan-card-only',
    targetId: 'bundle-generic',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 0, 'plan_card-only history cannot execute without a Kernel contract');
  assertEqual(
    result.events.some((event) => event.kind === 'error' || event.kind === 'trace/plan_accept_noop'),
    true,
    'missing Kernel contract closes through a structured diagnostic or no-op trace'
  );
}

async function assertSessionDriverLoopPlanCardAcceptExecutesReviewedDeletePlan(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-obsolete.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-reviewed-delete',
      sessionId: 'session-reviewed-delete-plan',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-reviewed-delete-plan',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-reviewed-delete',
        title: 'Generic delete plan',
        summary: 'Delete one generic reviewed file.',
        content: '# Plan\n\n## Summary\nDelete one generic reviewed file.',
        actionBundle,
        contentBlocks: [],
        commandBlocks: [],
        confirmable: true,
        status: 'awaitingUserApproval',
        planReviewReport: report,
      },
    },
    {
      id: 'plan-review-reviewed-delete',
      sessionId: 'session-reviewed-delete-plan',
      ts: '2026-01-01T00:00:00.001Z',
      kind: 'plan_review',
      payload: {
        status: 'awaitingUserApproval',
        runId: 'run-reviewed-delete-plan',
        planId: 'bundle-generic-delete',
        confirmable: true,
        report,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-reviewed-delete-plan',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-reviewed-delete',
              output: { path: 'generic-obsolete.txt' },
            },
            kernelTestBatchReviewReady(command.runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-reviewed-delete-plan',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'reviewed fs.delete plan submits accepted action batch');
  assertEqual(
    result.events.some((event) => event.kind === 'workflow_stage' && (event.payload as any)?.stage === 'accepted_plan.action_batch_preflight'),
    true,
    'reviewed fs.delete plan emits accepted-plan preflight before Kernel submit'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'failed'),
    false,
    'reviewed fs.delete plan does not fail before actionBatchSubmit'
  );
}

async function assertSessionDriverLoopAcceptedPlanExecutesDeleteWithinKernelAuthorizedTargets(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-obsolete.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const planCard = deleteAcceptedTaskPlanCardEvent('session-reviewed-delete-no-targets', 'run-reviewed-delete-no-targets');
  const planPayload = planCard.payload as any;
  planPayload.planReviewReport = report;
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-reviewed-delete-no-targets',
      'run-reviewed-delete-no-targets',
      'Delete the accepted generic obsolete target.',
      'reviewed-delete-no-targets'
    ),
    genericKernelContextProjectionEvent('session-reviewed-delete-no-targets', 'run-reviewed-delete-no-targets'),
    genericResolvedResourceEvent('session-reviewed-delete-no-targets', 'run-reviewed-delete-no-targets', 'generic-obsolete.txt'),
    planCard,
  ];
  const session: AgentSession = {
    id: 'session-reviewed-delete-no-targets',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let submittedProposal: any;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        submittedProposal = command.proposal;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report,
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-reviewed-delete-no-targets',
              output: { path: 'generic-obsolete.txt' },
            },
            kernelTestBatchReviewReady(command.runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(deleteActionBundleProposal('generic-obsolete.txt'));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-reviewed-delete-no-targets',
    targetId: 'impl-generic-delete',
    existingEvents: events,
  });

  assertEqual(llmCalls, 0, 'content-free delete intent can be compiled from the accepted task without another provider turn');
  assertEqual(proposalSubmits, 1, 'compiled delete intent is submitted to Kernel PlanReview once');
  const submittedActions = submittedProposal?.payload?.actionBundle?.actions ?? [];
  assertEqual(submittedActions.length, 1, 'Complete submits one delete action within the Kernel-authorized task target');
  assertEqual(submittedActions[0]?.args?.path, 'generic-obsolete.txt', 'delete action exposes canonical Kernel args.path');
  assertEqual(submittedActions[0]?.targetPath, undefined, 'delete action does not reintroduce a top-level path alias');
  assertEqual(submittedActions[0]?.targetRef, undefined, 'delete action does not duplicate the canonical args path into targetRef');
  assertEqual(
    submittedProposal?.payload?.authorizationContractId,
    'plan-authorization-impl-generic-delete',
    'Session binds the compiled task intent to the accepted Kernel authorization contract without deciding permission'
  );
  assertEqual(actionBatchSubmits, 1, 'Kernel-reviewed delete action reaches ActionBatch once');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'in-contract delete does not create a Session permission intervention');
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'failed'),
    false,
    'reviewed delete exact grant does not fail Session admission'
  );
}

async function assertSessionDriverLoopAcceptedPlanDeleteUsesCurrentTaskTargetsWhenCapabilityIsDisplayOnly(): Promise<void> {
  const token = randomSmokeToken('display-delete');
  const targetPath = `${token}.tmp`;
  const events = [acceptedTaskPlanCardEvent(`session-${token}`, `run-${token}`)];
  const planPayload = events[0].payload as any;
  planPayload.planId = `impl-${token}`;
  planPayload.taskPlan.id = `impl-${token}`;
  planPayload.taskPlan.title = 'Generic display capability delete plan';
  planPayload.taskPlan.summary = 'Delete one current task target with a display-only operation label.';
  planPayload.taskPlan.tasks = [{
    taskId: `task-${token}`,
    title: 'Remove current target',
    target: [targetPath],
    scope: 'The target is concrete and already belongs to the current accepted task.',
    dependencies: [],
    capability: `display-${token}`,
    acceptanceCriteria: ['Kernel records the delete work unit fact for the current task target.'],
    failureCriteria: ['Stop if the delete target leaves the accepted current task scope.'],
  }];
  delete planPayload.planReviewReport;
  delete planPayload.requiredFileOperations;

  const session: AgentSession = {
    id: `session-${token}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: command.batch },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: `work-unit-${token}`,
              output: { path: targetPath },
            },
            kernelTestBatchReviewReady(command.runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(deleteActionBundleProposal(targetPath));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: `run-${token}`,
    targetId: `impl-${token}`,
    existingEvents: events,
  });

  assertEqual(llmCalls, 1, 'display-only accepted task capability does not trigger accepted-plan scope repair');
  assertEqual(proposalSubmits, 1, 'display-only capability delete still goes through Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'display-only capability delete submits actionBatch for the current task target');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted-plan-scope-repair'
    ),
    false,
    'display-only capability delete does not emit accepted-plan scope repair'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'requirement_confirmation'),
    false,
    'display-only capability delete does not ask the user to reconfirm current task scope'
  );
}

async function assertSessionDriverLoopAcceptedExecutionExceptionClosesRun(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-stale.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-preflight-failure',
      sessionId: 'session-preflight-failure',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-preflight-failure',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-preflight-failure',
        content: '# Plan\n\n## Summary\nDelete one reviewed file.',
        actionBundle,
        contentBlocks: [],
        commandBlocks: [],
        confirmable: true,
        status: 'awaitingUserApproval',
        planReviewReport: report,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-preflight-failure',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let preflightAppendFailed = false;
  let kernelCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      const hasPreflight = nextEvents.some((event) =>
        event.kind === 'workflow_stage' &&
        (event.payload as any)?.stage === 'accepted_plan.action_batch_preflight'
      );
      if (hasPreflight && !preflightAppendFailed) {
        preflightAppendFailed = true;
        throw new Error('generic preflight append failed');
      }
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        kernelCalls += 1;
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + kernelCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-preflight-failure',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(preflightAppendFailed, true, 'preflight append failure was exercised');
  assertEqual(kernelCalls, 0, 'preflight failure stops before Kernel actionBatch submission');
  assertEqual(
    result.events.some((event) => event.kind === 'error' && (event.payload as any)?.code === 'accepted_plan_execution_failed'),
    true,
    'preflight failure emits accepted-plan execution diagnostic'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'failed'),
    true,
    'preflight failure closes the run with failed lifecycle'
  );
}

async function assertSessionDriverLoopAcceptedExecutionKernelErrorClosesRun(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-kernel-error.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-kernel-error',
      sessionId: 'session-kernel-error',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-kernel-error',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-kernel-error',
        content: '# Plan\n\n## Summary\nDelete one reviewed file.',
        actionBundle,
        contentBlocks: [],
        commandBlocks: [],
        confirmable: true,
        status: 'awaitingUserApproval',
        planReviewReport: report,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-kernel-error',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: false,
          events: [],
          error: { code: 'generic_kernel_error', message: 'generic Kernel action batch submit failed' },
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-kernel-error',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'Kernel actionBatchSubmit failure path is exercised once');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'error' &&
      (event.payload as any)?.messageKey === 'session.driver.acceptedPlanExecutionFailed' &&
      (event.payload as any)?.code === 'generic_kernel_error' &&
      String((event.payload as any)?.activity?.errorMessage ?? '').includes('generic Kernel action batch submit failed')
    ),
    true,
    'Kernel actionBatchSubmit error is projected as an accepted-plan failure while preserving the Kernel error'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'failed'),
    true,
    'Kernel actionBatchSubmit error closes the run with failed lifecycle'
  );
}

async function assertSessionDriverLoopAcceptedDecisionRecoversUnconsumedExecution(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-retry.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-unconsumed-accepted',
      sessionId: 'session-unconsumed-accepted',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-unconsumed-accepted',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-unconsumed-accepted',
        content: '# Plan\n\n## Summary\nDelete one reviewed file.',
        actionBundle,
        contentBlocks: [],
        commandBlocks: [],
        confirmable: true,
        status: 'awaitingUserApproval',
        planReviewReport: report,
      },
    },
    {
      id: 'plan-accepted-unconsumed',
      sessionId: 'session-unconsumed-accepted',
      ts: '2026-01-01T00:00:00.001Z',
      kind: 'plan_review',
      payload: {
        status: 'accepted',
        runId: 'run-unconsumed-accepted',
        planId: 'bundle-generic-delete',
        confirmable: false,
        report,
      },
    },
    {
      id: 'session-run-unconsumed-running',
      sessionId: 'session-unconsumed-accepted',
      ts: '2026-01-01T00:00:00.002Z',
      kind: 'session_run_state',
      payload: {
        status: 'running',
        phase: 'executing_accepted_plan',
        reason: 'accepted_plan_execution',
        runId: 'run-unconsumed-accepted',
        decisionOwner: { kind: 'plan', runId: 'run-unconsumed-accepted', planId: 'bundle-generic-delete', targetId: 'bundle-generic-delete' },
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-unconsumed-accepted',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [{ kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } }] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-unconsumed-accepted',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'trace/plan_accept_noop'), false, 'unconsumed accepted plan is not treated as stale');
  assertEqual(actionBatchSubmits, 1, 'unconsumed accepted plan can retry into actionBatchSubmit');
}

async function assertSessionDriverLoopRequirementAcceptedActionBundleWaitsForExplicitPlanConfirmation(): Promise<void> {
  const events: AgentEvent[] = [
    {
      id: 'requirement-generic-auto-plan',
      sessionId: 'session-requirement-auto-plan',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'requirement_confirmation',
      payload: {
        title: 'Requirement confirmation',
        summary: 'Confirm a generic side-effect choice.',
        content: 'Confirm the generic side-effect scope.',
        originalUserRequest: 'Create one generic reviewed workspace update.',
        runId: 'run-requirement-auto-plan',
        requirementId: 'requirement-generic-auto-plan',
        status: 'waitingUserConfirmation',
        confirmable: true,
        attachments: [],
        interactionOverlay: true,
        parentRunId: 'run-requirement-parent',
        parentPhase: 'provider_proposing',
        interactionRunId: 'run-requirement-auto-plan',
        interactionId: 'requirement-generic-auto-plan',
        sourceInteractionId: 'requirement-generic-auto-plan',
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-requirement-auto-plan',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let reviewFactsRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId ?? 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId ?? 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            {
              kind: 'action_batch.accepted',
              runId: command.runId,
              sessionId: session.id,
              batch: { actionCount: 1 },
            },
            kernelTestWorkUnitQueued({
              runId: command.runId,
              workUnitId: 'work-unit-generic-auto-plan',
              actionId: 'write-generic-output',
              toolId: 'fs.write',
              writeSet: ['generic-output.txt'],
            }),
            kernelTestWorkUnitCompleted(command.runId, 'work-unit-generic-auto-plan', { ok: true }),
            kernelTestBatchReviewReady(command.runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        reviewFactsRequests += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + reviewFactsRequests + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'accept',
    runId: 'run-requirement-auto-plan',
    targetId: 'requirement-generic-auto-plan',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'requirement accept generates one actionBundle plan through provider');
  assertEqual(actionBatchSubmits, 0, 'requirement accept does not continue into actionBatchSubmit');
  assertEqual(reviewFactsRequests, 0, 'requirement accept does not reach review facts before explicit plan confirmation');
  assertEqual(result.events.some((event) => event.kind === 'trace/plan_accept_noop'), false, 'requirement accept generates a fresh plan instead of a stale noop');
  assertEqual(result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any).reason === 'accepted_plan_execution'), false, 'requirement accept does not emit accepted-plan execution lifecycle');
  const planCard = result.events.find((event) => event.kind === 'plan_card');
  assertEqual(Boolean(planCard), true, 'requirement accept generates a confirmable actionBundle plan card');
  assertEqual((planCard?.payload as any)?.interactionOverlay, true, 'overlay requirement resume keeps plan card in the parent interaction flow');
  assertEqual((planCard?.payload as any)?.parentRunId, 'run-requirement-parent', 'overlay requirement resume keeps parentRunId on plan card');
  assertEqual(
    result.events.some((event) => event.kind === 'plan_review' && (event.payload as any)?.status === 'accepted'),
    false,
    'requirement accept does not auto-accept the generated plan'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.reason === 'plan_review'
    ),
    true,
    'generated plan waits for explicit plan confirmation'
  );
}

async function assertSessionDriverLoopDelegatesDirectoryDeleteAdmissionToKernel(): Promise<void> {
  const deleteProposal = deleteActionBundleProposal('generic-dir');
  const actionBundle = deleteProposal.actionBundle as Record<string, any>;
  const events: AgentEvent[] = [
    {
      id: 'resource-generic-directory',
      sessionId: 'session-delete-directory-preflight',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'tool_result',
      payload: {
        output: {
          id: 'resource-packet-generic-directory',
          workspaceScopeKey: 'workspace',
          requestId: 'resource-request-generic-directory',
          items: [{
            requestItemId: 'item-directory',
            manifestEntryId: 'attachment-generic',
            status: 'resolved',
            contentKind: 'directoryTree',
            nodes: [
              {
                name: 'generic-dir',
                path: 'generic-dir',
                type: 'directory',
                children: [{ name: 'inside.txt', path: 'generic-dir/inside.txt', type: 'file', children: null }],
              },
            ],
          }],
        },
      },
    },
    {
      id: 'plan-delete-directory-preflight',
      sessionId: 'session-delete-directory-preflight',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-delete-directory-preflight',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-delete-directory-preflight',
        title: 'Generic delete plan',
        summary: 'Delete a generic target after review.',
        content: '# Plan\n\n## Summary\nDelete a generic target after review.',
        actionBundle,
        contentBlocks: [],
        commandBlocks: [],
        planReviewReport: proposalReviewReport(actionBundle),
        confirmable: true,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-delete-directory-preflight',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-delete-directory-preflight',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'Session submits typed directory delete args so Kernel owns target and recursive admission');
  assertEqual(
    result.events.some((event) => event.kind === 'error' && (event.payload as any).code === 'accepted_plan_action_batch_preflight_failed'),
    false,
    'Session does not emit a local directory-delete permission or path diagnostic'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any).status === 'failed'),
    false,
    'Session does not fail the run before Kernel admission'
  );
}

async function assertSessionDriverLoopAcceptedScopeExecutesReviewedDirectoryDelete(): Promise<void> {
  const deleteProposal = deleteActionBundleProposal('generic-dir/') as any;
  const actionBundle = deleteProposal.actionBundle as Record<string, any>;
  actionBundle.actions[0].args = {
    ...actionBundle.actions[0].args,
    path: 'generic-dir',
    targetKind: 'directory',
    recursive: true,
  };
  const planReviewReport = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    genericDirectoryResourceEvent('session-delete-directory-reviewed', 'generic-dir', ['generic-dir/inside.txt']),
    {
      id: 'plan-delete-directory-reviewed',
      sessionId: 'session-delete-directory-reviewed',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-delete-directory-reviewed',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-delete-directory-reviewed',
        title: 'Generic delete plan',
        summary: 'Delete a generic directory after review.',
        content: '# Plan\n\n## Summary\nDelete a generic directory after review.',
        actionBundle,
        contentBlocks: [],
        commandBlocks: [],
        planReviewReport,
        confirmable: true,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-delete-directory-reviewed',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: command.batch },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-generic-directory-delete',
              output: { path: 'generic-dir', kind: 'directory', recursive: true },
            },
          ],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-delete-directory-reviewed',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'reviewed directory delete submits an action batch');
  assertEqual(
    result.events.some((event) => event.kind === 'error' && (event.payload as any).code === 'accepted_plan_action_batch_preflight_failed'),
    false,
    'reviewed directory delete does not fail Session preflight'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanAutoExecutesBatch(): Promise<void> {
  const token = randomSmokeToken('accepted-exec-original');
  const originalRequest = `T60_FULL_ORIGINAL_REQUEST_${token}_SHOULD_NOT_BE_REEXPANDED`;
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-accepted-plan-auto',
      'run-accepted-plan-auto',
      originalRequest,
      `accepted-plan-auto-${token}`
    ),
    genericKernelContextProjectionEvent('session-accepted-plan-auto', 'run-accepted-plan-auto'),
    acceptedTaskPlanCardEvent('session-accepted-plan-auto', 'run-accepted-plan-auto'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-auto',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        assertEqual(
          command.proposal?.payload?.contentBlocks?.[0]?.contentLines?.join('\n'),
          `generic output ${token}`,
          'artifact compiler submits canonical contentLines to Kernel PlanReview'
        );
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            {
              kind: 'action_batch.accepted',
              runId: command.runId,
              sessionId: session.id,
              batch: { planId: command.batch?.planId },
            },
            kernelTestWorkUnitQueued({
              runId: command.runId,
              workUnitId: 'work-unit-generic',
              actionId: 'write-generic-output',
              toolId: 'fs.write',
              writeSet: ['generic-output.txt'],
            }),
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              output: { path: 'generic-output.txt' },
            },
            kernelTestBatchReviewReady(command.runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return llmRequests.length === 1
        ? semanticToolLlmResponse('session.append_artifact_chunk', {
          slotId: 'slot-task-generic-write-plan-op-task-generic-write-1',
          contentLines: [`generic output ${token}`],
          finalChunk: true,
        })
        : semanticToolLlmResponse('session.finalize_task_artifacts', {
          summary: `Generated current task artifact ${token}`,
        });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-auto',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    interventionLevel: 'medium',
  });

  assertEqual(proposalSubmits, 1, 'accepted taskPlan still submits actionBundle to Kernel PlanReview for audit');
  assertEqual(actionBatchSubmits, 1, 'accepted taskPlan auto-submits in-scope actionBundle to Kernel execution');
  assertEqual(llmRequests.length, 2, 'accepted taskPlan execution appends one chunk and finalizes it in a second provider turn');
  const promptText = llmRequests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assertEqual(
    llmRequests[0]?.messages.filter((message) => message.role === 'user' && message.content === originalRequest).length,
    1,
    'accepted execution preserves the exact authoritative root user message once in PromptLedger'
  );
  assert(promptText.includes('Session semantic profile: execution-v1'), 'accepted execution uses the stable execution provider profile');
  assert(
    promptText.includes('slot-task-generic-write-plan-op-task-generic-write-1'),
    'accepted execution exposes the current Kernel-authorized IntentSlot id'
  );
  assert(promptText.includes('Kernel records the generic output write fact.'), 'accepted execution exposes current task acceptance criteria');
  assert(promptText.includes('Stop if the write leaves the accepted target scope.'), 'accepted execution exposes current task failure criteria');
  assert(promptText.includes(originalRequest), 'accepted execution retains the original user request as authoritative PromptLedger content');
  assert(!promptText.includes('Accepted execution contract context'), 'accepted execution does not send raw contract JSON');
  assert(!promptText.includes('taskOrder='), 'accepted execution does not expose taskOrder in provider text');
  assert(!promptText.includes('pendingTasks='), 'accepted execution does not expose pending task ids in provider text');
  assert(!promptText.includes('dependsOn'), 'accepted execution does not expose provider dependency fields');
  assert(!promptText.includes('dependencyDepth'), 'accepted execution does not expose dependency depth');
  assertEqual(result.events.filter((event) => event.kind === 'plan_card').length, 1, 'accepted taskPlan execution does not create a second confirmable plan card');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'running' &&
      (event.payload as any)?.reason === 'accepted_plan_execution'
    ),
    true,
    'accepted taskPlan execution records running session state'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanNormalizesWriteBatchForKernel(): Promise<void> {
  const events = [acceptedTaskPlanCardEvent('session-accepted-plan-normalize', 'run-accepted-plan-normalize')];
  const session: AgentSession = {
    id: 'session-accepted-plan-normalize',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let submittedBatch: any;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        submittedBatch = command.batch;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId: 'work-unit-generic',
              actionId: 'write-generic-output',
              toolId: 'fs.write',
              writeSet: ['generic-output.txt'],
            }),
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              output: { path: 'generic-output.txt' },
            },
            kernelTestBatchReviewReady('run-generic'),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-normalize',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assert(Boolean(submittedBatch), 'accepted taskPlan submits a normalized action batch');
  const action = submittedBatch.actionBundle.actions[0];
  const block = submittedBatch.contentBlocks[0];
  assertEqual(action.kind, 'write', 'fs.write action keeps explicit write kind before Kernel submit');
  assertEqual(action.targetPath, 'generic-output.txt', 'fs.write action has explicit targetPath before Kernel submit');
  assertEqual(action.resourceScope[0], 'generic-output.txt', 'fs.write action keeps concrete resourceScope before Kernel submit');
  assertEqual(block.id, 'generic-block', 'codeBlock keeps canonical id before Kernel submit');
  assertEqual(block.blockId, 'generic-block', 'codeBlock also carries blockId compatibility field before Kernel submit');
  assertEqual(block.path, 'generic-output.txt', 'codeBlock keeps path before Kernel submit');
  assertEqual(block.targetPath, 'generic-output.txt', 'codeBlock carries targetPath before Kernel submit');
}

async function assertSessionDriverLoopAcceptedTaskPlanPrefersTargetPathOverRootResourceScope(): Promise<void> {
  const events = [acceptedTaskPlanCardEvent('session-root-scope-targetpath', 'run-root-scope-targetpath')];
  const planPayload = events[0].payload as any;
  planPayload.planId = 'impl-root-file-write';
  planPayload.taskPlan.id = 'impl-root-file-write';
  planPayload.taskPlan.title = 'Generic root file write plan';
  planPayload.taskPlan.summary = 'Create one generic root-level workspace file.';
  planPayload.taskPlan.tasks = [{
    taskId: 'task-root-file-write',
    title: 'Create root-level script',
    target: ['root-output.sh'],
    scope: 'Create one generic root-level file already listed in the accepted plan.',
    dependencies: [],
    capability: 'fs.write',
    fileOperations: [{
      operation: 'create',
      capability: 'fs.write',
      targetPath: 'root-output.sh',
      reason: 'Create the accepted root-level file.',
    }],
    acceptanceCriteria: ['Kernel records the root-level write fact.'],
    failureCriteria: ['Stop if the action tries to write the workspace root instead of the file.'],
  }];
  const session: AgentSession = {
    id: 'session-root-scope-targetpath',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  let proposalSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        assertEqual(Array.isArray(actionBundle.accessScopes), false, 'canonical root actionBundle does not submit provider accessScopes');
        assertEqual(
          JSON.stringify(actionBundle.actions ?? []).includes('"accessScopes"'),
          false,
          'canonical root action does not submit provider accessScopes'
        );
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: command.runId,
              workUnitId: 'work-unit-root-output',
              actionId: 'write-root-output',
              toolId: 'fs.write',
              writeSet: ['root-output.sh'],
            }),
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-root-output',
              output: { path: 'root-output.sh' },
            },
            kernelTestBatchReviewReady(command.runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      const proposal = genericWriteProposal(false);
      proposal.contentBlocks = [{
        blockId: 'root-output-block',
        targetPath: 'root-output.sh',
        language: 'bash',
        operation: 'create',
        contentLines: ['#!/bin/sh', 'echo generic'],
      }];
      (proposal.actionBundle as any).id = 'bundle-root-output';
      (proposal.actionBundle as any).goal = 'Create the accepted root-level file.';
      (proposal.actionBundle as any).actions = [{
        actionId: 'write-root-output',
        toolId: 'fs.write',
        args: { path: 'root-output.sh', contentBlockId: 'root-output-block' },
        description: 'Write root output',
      }];
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + repairRequests.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-root-scope-targetpath',
    targetId: 'impl-root-file-write',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'accepted plan root-level write uses targetPath before root resourceScope');
  assertEqual(proposalSubmits, 1, 'accepted plan batch still goes through Kernel PlanReview after scope narrowing');
  assertEqual(repairRequests.length, 0, 'root resourceScope does not trigger accepted-plan scope repair when targetPath is concrete');
}

async function assertSessionDriverLoopAcceptedTaskPlanRepairsPlanReviewRootAccessScope(): Promise<void> {
  const events = [acceptedTaskPlanCardEvent('session-planreview-root-scope-repair', 'run-planreview-root-scope-repair')];
  const session: AgentSession = {
    id: 'session-planreview-root-scope-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const repairRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        if (proposalSubmits === 1) {
          const deniedReport = proposalReviewReport(actionBundle);
          return {
            ok: true,
            events: [
              { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
              {
                kind: 'proposal.reviewed',
                runId: command.runId,
                sessionId: session.id,
                proposalId: command.proposal?.proposalId,
                report: {
                  ...deniedReport,
                  status: 'denied',
                  diagnostics: ['actionBundle access scope . (workspaceModule) access scope must not be the workspace root'],
                  executionContract: {
                    ...deniedReport.executionContract,
                    status: 'denied',
                  },
                },
              },
            ],
          };
        }
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitCompleted(command.runId, 'work-unit-generic', { path: 'generic-output.txt' }),
            kernelTestBatchReviewReady(command.runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-planreview-root-scope-repair',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 2, 'Kernel denied diagnostic triggers one automatic ProposalReview repair');
  assertEqual(actionBatchSubmits, 1, 'repaired accepted-plan batch continues to actionBatchSubmit');
  assertEqual(repairRequests.length, 1, 'Session asks provider for one controlled PlanReview repair');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'repairable ProposalReview issue does not trigger user intervention');
  assert(
    JSON.stringify(repairRequests[0].messages).includes('contentLines') &&
      JSON.stringify(repairRequests[0].messages).includes('toolId'),
    'PlanReview repair prompt uses canonical toolId/contentLines protocol'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanPreservesExecutionRoot(): Promise<void> {
  const root = '/workspace/generic-project';
  const events: AgentEvent[] = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-root', root),
    acceptedTaskPlanCardEvent('session-accepted-plan-root', 'run-accepted-plan-root'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-root',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let runCreateCount = 0;
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') {
        runCreateCount += 1;
        return fakeKernel(request);
      }
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-root',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
  });

  assertEqual(runCreateCount, 0, 'accepted taskPlan continuation resumes without creating another Kernel run');
  assert(
    JSON.stringify(llmRequests.at(-1)?.messages ?? []).includes(root),
    'accepted taskPlan continuation preserves the primary root in provider context'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanUsesPlanCardExecutionRoot(): Promise<void> {
  const token = randomSmokeToken('plan-root');
  const root = `/workspace/${token}`;
  const sessionId = `session-${token}`;
  const plan = acceptedTaskPlanCardEvent(sessionId, `run-${token}`);
  (plan.payload as any).executionRoot = {
    ref: root,
    source: 'recentAttachment',
    attachment: {
      kind: 'directory',
      path: root,
      absolutePath: root,
      source: 'currentAttachment',
      scope: 'session',
      rootId: `root-${token}`,
    },
  };
  const events: AgentEvent[] = [plan];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let runCreateCount = 0;
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') {
        runCreateCount += 1;
        return fakeKernel(request);
      }
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId: `run-${token}`,
    targetId: 'impl-generic-auto',
    existingEvents: events,
    workspaceBinding: { openPath: `/workspace/${randomSmokeToken('conflicting-root')}` },
  });

  assertEqual(runCreateCount, 0, 'plan-card continuation resumes without creating another Kernel run');
  const promptText = JSON.stringify(llmRequests.at(-1)?.messages ?? []);
  assert(promptText.includes(root), 'plan-card execution root wins over decision-time workspace binding');
}

async function assertSessionDriverLoopAcceptedTaskPlanRecoversExecutionRootFromResourcePacket(): Promise<void> {
  const token = randomSmokeToken('resource-root');
  const root = `/workspace/${token}`;
  const sessionId = `session-${token}`;
  const events: AgentEvent[] = [
    {
      id: `event-${token}-resource-root`,
      sessionId,
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'tool_result',
      payload: {
        toolName: 'kernel.resourceResolve',
        output: {
          id: `resource-packet-${token}`,
          workspaceScopeKey: 'workspace',
          requestId: `resource-request-${token}`,
          items: [{
            requestItemId: `item-${token}`,
            manifestEntryId: `manifest-${token}`,
            status: 'resolved',
            resolvedKind: 'directory',
            contentKind: 'directoryTree',
            sourceKind: 'kernelResource',
            absolutePath: root,
            path: `${root}/.`,
            nodes: [{ name: 'generic.txt', path: 'generic.txt', type: 'file', children: null }],
          }],
        },
      },
    },
    acceptedTaskPlanCardEvent(sessionId, `run-${token}`),
  ];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let runCreateCount = 0;
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') {
        runCreateCount += 1;
        return fakeKernel(request);
      }
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId: `run-${token}`,
    targetId: 'impl-generic-auto',
    existingEvents: events,
    workspaceBinding: { openPath: `/workspace/${randomSmokeToken('conflicting-root')}` },
  });

  assertEqual(runCreateCount, 0, 'ResourcePacket continuation resumes without creating another Kernel run');
  const promptText = JSON.stringify(llmRequests.at(-1)?.messages ?? []);
  assert(promptText.includes(root), 'ResourcePacket directory fact becomes the accepted execution root context');
}

async function assertSessionDriverLoopAcceptedTaskPlanAutoExecutesMultiTargetBatch(): Promise<void> {
  const events = [multiTargetAcceptedTaskPlanCardEvent('session-accepted-plan-multi', 'run-accepted-plan-multi')];
  const session: AgentSession = {
    id: 'session-accepted-plan-multi',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId: 'work-unit-one',
              actionId: 'write-generic-one',
              toolId: 'fs.write',
              writeSet: ['generic-one.txt'],
            }),
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-one',
              output: { path: 'generic-one.txt' },
            },
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId: 'work-unit-two',
              actionId: 'write-generic-two',
              toolId: 'fs.write',
              writeSet: ['generic-two.txt'],
            }),
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-two',
              output: { path: 'generic-two.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(multiWriteProposal()),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-multi',
    targetId: 'impl-generic-multi',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'multi-target accepted taskPlan batch still reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'multi-target accepted taskPlan batch is auto-executed');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'multi-target in-scope batch does not become a user intervention');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      Array.isArray((event.payload as any)?.remainingTaskIds) &&
      (event.payload as any).remainingTaskIds.length === 0
    ),
    true,
    'multi-target batch records an accepted-plan checkpoint with no remaining tasks'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanSplitsCommaSeparatedTargets(): Promise<void> {
  const paths = Array.from({ length: 6 }, () => `${randomSmokeToken('dir')}/${randomSmokeToken('file')}.txt`);
  const sessionId = `session-${randomSmokeToken('comma')}`;
  const runId = `run-${randomSmokeToken('comma')}`;
  const events = [commaSeparatedTargetsAcceptedTaskPlanCardEvent(sessionId, runId, paths)];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let submittedPaths: string[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId, sessionId, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId,
              sessionId,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const actions = Array.isArray(command.batch?.actionBundle?.actions) ? command.batch.actionBundle.actions : [];
        submittedPaths = actions.map((action: any) => String(action?.args?.path ?? action?.targetPath ?? ''));
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId, sessionId, batch: { planId: command.batch?.planId } },
            ...submittedPaths.flatMap((path, index): KernelEventV1[] => [
              kernelTestWorkUnitQueued({
                runId,
                workUnitId: `work-unit-${index}`,
                actionId: String(actions[index]?.actionId ?? `action-${index}`),
                toolId: 'fs.write',
                writeSet: [path],
              }),
              kernelTestWorkUnitCompleted(runId, `work-unit-${index}`, { path }),
            ]),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(randomMultiWriteProposal(paths)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: 'impl-random-comma',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'comma-separated accepted targets still submit one Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'comma-separated accepted targets execute in one actionBatch');
  assertEqual(submittedPaths.length, paths.length, 'all random targets are submitted to Kernel');
  assertEqual([...submittedPaths].sort().join('\n'), [...paths].sort().join('\n'), 'submitted target set matches the accepted comma-separated target list');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'comma-separated accepted targets do not trigger user intervention');
  assert(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      Array.isArray((event.payload as any)?.remainingTaskIds) &&
      (event.payload as any).remainingTaskIds.length === 0
    ),
    'comma-separated target batch completes the accepted task'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanAllowsBriefExecutionBatchPlan(): Promise<void> {
  const path = `${randomSmokeToken('single')}/${randomSmokeToken('target')}.txt`;
  const sessionId = `session-${randomSmokeToken('brief')}`;
  const runId = `run-${randomSmokeToken('brief')}`;
  const events = [commaSeparatedTargetsAcceptedTaskPlanCardEvent(sessionId, runId, [path])];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId, sessionId, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId,
              sessionId,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId, sessionId, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId,
              workUnitId: 'work-unit-brief',
              actionId: 'write-brief',
              toolId: 'fs.write',
              writeSet: [path],
            }),
            {
              kind: 'work_unit.completed',
              runId,
              sessionId,
              workUnitId: 'work-unit-brief',
              output: { path },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(randomMultiWriteProposal([path], { briefUserPlan: true })),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: 'impl-random-comma',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'brief accepted-plan execution batch still reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'brief accepted-plan execution batch is submitted to Kernel');
  assertEqual(
    result.events.some((event) => event.kind === 'error' && String((event.payload as any)?.message ?? '').includes('userPlan')),
    false,
    'brief accepted-plan execution batch is not rejected by detailed initial-plan userPlan validation'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanKeepsContinuationNonExecutable(): Promise<void> {
  const events = [acceptedTaskPlanCardEvent('session-accepted-plan-continuation', 'run-accepted-plan-continuation')];
  const session: AgentSession = {
    id: 'session-accepted-plan-continuation',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let submittedActionCount = 0;
  let submittedContinuationCount = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const actionBundle = command.batch?.actionBundle as Record<string, any> | undefined;
        submittedActionCount = Array.isArray(actionBundle?.actions) ? actionBundle.actions.length : 0;
        submittedContinuationCount = Array.isArray(actionBundle?.continuationExpectations)
          ? actionBundle.continuationExpectations.length
          : 0;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId: 'work-unit-resource-resume',
              actionId: 'write-generic-output',
              toolId: 'fs.write',
              writeSet: ['generic-output.txt'],
            }),
            kernelTestWorkUnitCompleted('run-generic', 'work-unit-continuation-current', { path: 'generic-output.txt' }),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      const proposal = singleTargetWriteProposal('generic-output.txt', 'continuation-current') as any;
      proposal.actionBundle = {
        ...proposal.actionBundle,
        actions: [{
          actionId: 'write-continuation-current',
          toolId: 'fs.write',
          args: { path: 'generic-output.txt', contentBlockId: 'code-continuation-current' },
          description: 'Write current generic output.',
        }],
        continuationExpectations: ['Continue with another generic target after review.'],
      };
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-continuation',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'continuation smoke submits current actionBundle to Kernel PlanReview once');
  assertEqual(actionBatchSubmits, 1, 'continuation smoke submits current action batch once');
  assertEqual(submittedActionCount, 1, 'continuation smoke keeps executable actions limited to the current action');
  assertEqual(submittedContinuationCount, 1, 'continuation smoke preserves one non-executable continuation note');
}

async function assertSessionDriverLoopAcceptedTaskPlanAutoExecutesDeleteAction(): Promise<void> {
  const events = [deleteAcceptedTaskPlanCardEvent('session-accepted-plan-delete', 'run-accepted-plan-delete')];
  const session: AgentSession = {
    id: 'session-accepted-plan-delete',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const transcripts: TranscriptEntry[] = [];
  let submittedBatch: Record<string, any> | undefined;
  let submittedProposal: Record<string, any> | undefined;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        submittedProposal = command.proposal;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        submittedBatch = command.batch;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId: 'work-unit-delete',
              actionId: 'delete-generic-obsolete',
              toolId: 'fs.delete',
              writeSet: ['generic-obsolete.txt'],
            }),
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-delete',
              output: { path: 'generic-obsolete.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    appendTranscript: async (_sessionId, entry): Promise<void> => {
      transcripts.push(entry);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      const proposal = deleteActionBundleProposal('generic-obsolete.txt');
      proposal.userPlan = 'Delete the accepted obsolete target.';
      delete (proposal.actionBundle as any).goal;
      (proposal.actionBundle as any).validationExpectations = [];
      (proposal.actionBundle as any).reviewExpectations = [];
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-delete',
    targetId: 'impl-generic-delete',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'delete-only accepted taskPlan batch still reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'delete-only accepted taskPlan batch is auto-executed without contentBlocks');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'in-scope delete action does not become a user intervention');
  assertEqual(result.events.filter((event) => event.kind === 'plan_card').length, 1, 'delete action does not create a second confirmable plan card');
  assert(
    String((submittedProposal?.payload as any)?.userPlan ?? '').includes('## Key Changes'),
    'Session expands brief delete actionBundle userPlan before Kernel proposalSubmit'
  );
  assertEqual(
    (((submittedProposal?.payload as any)?.actionBundle?.validationExpectations ?? []) as unknown[]).length > 0,
    true,
    'Session adds default validation expectations before Kernel proposalSubmit'
  );
  assertEqual(
    (((submittedProposal?.payload as any)?.actionBundle?.reviewExpectations ?? []) as unknown[]).length > 0,
    true,
    'Session adds default review expectations before Kernel proposalSubmit'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      String((event.payload as any)?.content ?? (event.payload as any)?.summary ?? '').includes('Agent Protocol v4 修复')
    ),
    false,
    'clear delete actionBundle does not enter LLM protocol repair only to expand display markdown'
  );
  const deleteAction = submittedBatch?.actionBundle?.actions?.[0];
  assertEqual(deleteAction?.capability, 'fs.delete', 'submitted delete batch keeps fs.delete capability');
  assertEqual(deleteAction?.kind, 'delete', 'submitted delete batch keeps delete kind');
  assertEqual(deleteAction?.targetPath, 'generic-obsolete.txt', 'submitted delete batch keeps concrete targetPath');
  assertEqual(deleteAction?.resourceScope?.[0], 'generic-obsolete.txt', 'submitted delete batch normalizes resourceScope to the concrete file');
  const preflight = transcripts.find((entry) => {
    const record = entry as Record<string, any>;
    return record.kind === 'provider_trace' &&
      record.payload?.stage === 'accepted_plan.action_batch_preflight';
  });
  assert(Boolean(preflight), 'delete preflight trace is archived before Kernel actionBatchSubmit');
}

async function assertSessionDriverLoopUsesExactKernelOperationsForMixedDelete(): Promise<void> {
  const token = randomSmokeToken('multi-delete');
  const targets = [
    `${token}-tree`,
    `${token}-two.tmp`,
    `${token}-three.bin`,
  ];
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const events = [
    ...turnAuthorityFixture(sessionId, runId, `Delete the accepted targets for ${token}.`, `mixed-delete-${token}`),
    genericKernelContextProjectionEvent(sessionId, runId),
    multiDeleteAcceptedTaskPlanCardEvent(
      sessionId,
      runId,
      token,
      targets,
      ['directory', 'file', 'file']
    ),
  ];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let submittedBatch: Record<string, any> | undefined;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId, sessionId, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId,
              sessionId,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        submittedBatch = command.batch;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId, sessionId, batch: { planId: command.batch?.planId } },
            ...targets.flatMap((target, index): KernelEventV1[] => [
              kernelTestWorkUnitQueued({
                runId,
                workUnitId: `work-unit-${index}`,
                actionId: `delete-${index}`,
                toolId: 'fs.delete',
                writeSet: [target],
              }),
              kernelTestWorkUnitCompleted(runId, `work-unit-${index}`, { path: target }),
            ]),
            kernelTestBatchReviewReady(runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('content-free mixed delete must compile from exact Kernel authorization operations');
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: `impl-${token}`,
    existingEvents: events,
  });

  assertEqual(
    proposalSubmits,
    1,
    `exact mixed-delete proposal reaches Kernel PlanReview once; events=${JSON.stringify(result.events.map((event) => ({ kind: event.kind, payload: event.payload })))}`
  );
  assertEqual(actionBatchSubmits, 1, 'exact mixed-delete batch reaches Kernel execution once');
  const actions = submittedBatch?.actionBundle?.actions ?? [];
  assertEqual(actions.length, targets.length, 'submitted batch preserves one action per Kernel authorization operation');
  assertEqual(actions[0]?.args?.path, targets[0], 'directory delete keeps the exact Kernel target');
  assertEqual(actions[0]?.args?.targetKind, 'directory', 'directory delete keeps Kernel targetKind');
  assertEqual(actions[0]?.args?.recursive, true, 'directory delete keeps Kernel recursive semantics');
  assertEqual(actions[1]?.args?.targetKind, 'file', 'first file delete keeps Kernel targetKind');
  assertEqual(actions[1]?.args?.recursive, false, 'first file delete keeps Kernel recursive semantics');
  assertEqual(actions[2]?.args?.targetKind, 'file', 'second file delete keeps Kernel targetKind');
  assertEqual(actions[2]?.args?.recursive, false, 'second file delete keeps Kernel recursive semantics');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      String((event.payload as any)?.content ?? (event.payload as any)?.summary ?? '').includes('Agent Protocol v4 修复')
    ),
    false,
    'exact mixed-delete operations do not enter LLM protocol repair'
  );
}

async function assertSessionDriverLoopRejectsMissingExactKernelOperationsBeforeProvider(): Promise<void> {
  const token = randomSmokeToken('missing-exact-operations');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const planEvent = multiDeleteAcceptedTaskPlanCardEvent(
    sessionId,
    runId,
    token,
    [`${token}-one`, `${token}-two`],
    ['directory', 'file']
  );
  const payload = planEvent.payload as Record<string, any>;
  payload.authorizationContract.operations = [];
  payload.planAuthorizationReview.authorizationContract.operations = [];
  const events = [
    ...turnAuthorityFixture(sessionId, runId, `Delete the accepted targets for ${token}.`, `missing-operations-${token}`),
    genericKernelContextProjectionEvent(sessionId, runId),
    planEvent,
  ];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let providerCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') proposalSubmits += 1;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      providerCalls += 1;
      return jsonLlmResponse(deleteActionBundleProposal(`${token}-one`));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: `impl-${token}`,
    existingEvents: events,
  });

  assertEqual(providerCalls, 0, 'missing exact Kernel operations fail before a Provider call');
  assertEqual(proposalSubmits, 0, 'missing exact Kernel operations fail before proposalSubmit');
  assertEqual(actionBatchSubmits, 0, 'missing exact Kernel operations fail before actionBatchSubmit');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'error' &&
      (event.payload as any)?.code === 'accepted_plan_authorization_contract_incompatible'
    ),
    true,
    'missing exact Kernel operations produce a structured incompatibility error'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanClassifiesDeleteCompileMismatch(): Promise<void> {
  const events = [deleteAcceptedTaskPlanCardEvent('session-accepted-plan-delete-mismatch', 'run-accepted-plan-delete-mismatch')];
  const session: AgentSession = {
    id: 'session-accepted-plan-delete-mismatch',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  let reviewFactsGet = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId: 'work-unit-delete-mismatch',
              actionId: 'delete-generic-obsolete',
              toolId: 'fs.delete',
              writeSet: ['generic-obsolete.txt'],
            }),
            kernelTestWorkUnitStarted('run-generic', 'work-unit-delete-mismatch'),
            kernelTestWorkUnitFailed(
              'run-generic',
              'work-unit-delete-mismatch',
              'invalid_command',
              'invalid command: fs.write target path is empty',
            ),
            kernelTestBatchReviewReady('run-generic'),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        reviewFactsGet += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(deleteActionBundleProposal('generic-obsolete.txt')),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + reviewFactsGet + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-delete-mismatch',
    targetId: 'impl-generic-delete',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'delete compile mismatch still comes from one Kernel actionBatchSubmit');
  assertEqual(reviewFactsGet, 0, 'delete compile mismatch stops before terminal review facts');
  const failure = result.events.find((event) =>
    event.kind === 'workflow_stage' &&
    (event.payload as any)?.stage === 'accepted_plan.batch_failed'
  );
  assertEqual((failure?.payload as any)?.failures?.[0]?.code, 'kernel_delete_compile_mismatch', 'delete write-path error is classified as Kernel delete compile mismatch');
  assertEqual(
    String((failure?.payload as any)?.summary ?? '').includes('fs.write target path is empty'),
    true,
    'delete compile mismatch keeps the original Kernel error message'
  );
  const projectedFailure = result.events.find((event) =>
    event.kind === 'error' &&
    (event.payload as any)?.kernelEvent?.kind === 'work_unit.failed'
  );
  assertEqual(
    JSON.stringify((projectedFailure?.payload as any)?.activity?.targets ?? []),
    JSON.stringify(['generic-obsolete.txt']),
    'work_unit.failed projection backfills targets from queued writeSet'
  );
  const projectedStarted = result.events.find((event) =>
    event.kind === 'workflow_stage' &&
    (event.payload as any)?.kernelEvent?.kind === 'work_unit.started'
  );
  assertEqual(
    JSON.stringify((projectedStarted?.payload as any)?.activity?.targets ?? []),
    JSON.stringify(['generic-obsolete.txt']),
    'work_unit.started projection backfills targets from queued writeSet'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanClassifiesPatchEvidenceMismatch(): Promise<void> {
  const token = randomSmokeToken('patch-mismatch');
  const targetPath = `${token}.txt`;
  const oldText = `old-${randomSmokeToken('text')}`;
  const replacementText = `new-${randomSmokeToken('text')}`;
  const events = [acceptedTaskPlanCardEvent(`session-${token}`, `run-${token}`)];
  const planPayload = events[0].payload as any;
  planPayload.taskPlan.tasks[0].target = [targetPath];
  planPayload.taskPlan.tasks[0].capability = 'fs.edit';
  planPayload.taskPlan.tasks[0].fileOperations = [{
    operation: 'patch',
    capability: 'fs.edit',
    targetPath,
    reason: 'Random accepted-plan patch mismatch smoke target.',
  }];
  const resourcePacket = {
    id: `packet-${token}`,
    requestId: `request-${token}`,
    items: [{
      requestItemId: `item-${token}`,
      manifestEntryId: `entry-${token}`,
      status: 'resolved',
      readPolicy: 'explicit-manifest-readonly',
      sourceKind: 'file',
      contentKind: 'fileText',
      path: targetPath,
      content: oldText,
      promptContent: oldText,
      contentSummary: oldText,
      evidenceRefs: [`evidence-${token}`],
    }],
  };
  events.push({
    id: `event-${token}-resource-packet`,
    sessionId: `session-${token}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'tool_result',
    payload: { toolName: 'kernel.resourceResolve', output: resourcePacket },
  });
  const session: AgentSession = {
    id: `session-${token}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  const patchProposal = (): Record<string, unknown> => ({
    schemaVersion: 'deepcode.agent.protocol.v4',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Random patch batch',
      '',
      '## Summary',
      'Patch one accepted random target file using current ResourcePacket evidence.',
      '',
      '## Key Changes',
      '- Replace the exact old block with the generated replacement block.',
      '',
      '## Validation',
      '- Kernel records the patch result or a fail-closed mismatch.',
      '',
      '## Assumptions',
      '- The target path remains inside the accepted implementation plan.',
    ].join('\n'),
    contentBlocks: [{
      blockId: `block-${token}`,
      targetPath,
      contentLines: [replacementText],
    }],
    actionBundle: {
      version: '1',
      id: `bundle-${token}`,
      goal: 'Patch one random accepted target file.',
      actions: [{
        actionId: `patch-${token}`,
        toolId: 'fs.edit',
        args: {
          path: targetPath,
          replacementBlockId: `block-${token}`,
          patchSpec: { match: { kind: 'exactBlock', text: oldText } },
        },
        description: 'Patch the random accepted target.',
      }],
      validationExpectations: [{ id: `validation-${token}`, description: 'Kernel records the patch fact.' }],
      reviewExpectations: [{ id: `review-${token}`, description: 'User reviews the patch result.' }],
    },
    expectedValidation: 'Kernel records the patch fact.',
    reviewGuide: 'Review the patch result and Kernel facts.',
  });
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: `run-${token}`,
            sessionId: session.id,
            packet: kernelTestResourcePacket(
              `packet-${token}`,
              command.requestId,
              [{
                requestItemId: `item-${token}`,
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: 'file',
                contentKind: 'fileText',
                path: targetPath,
                content: oldText,
                promptContent: oldText,
                contentSummary: oldText,
                evidenceRefs: [`evidence-${token}`],
              }],
            ),
          }],
        };
      }
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: `run-${token}`, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: `run-${token}`,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            kernelTestWorkUnitQueued({
              runId: `run-${token}`,
              workUnitId: `work-unit-${token}`,
              actionId: `patch-${token}`,
              toolId: 'fs.edit',
              writeSet: [targetPath],
            }),
            kernelTestWorkUnitFailed(
              `run-${token}`,
              `work-unit-${token}`,
              'invalid_patch',
              'patch match did not occur in target file',
            ),
            kernelTestBatchReviewReady(`run-${token}`),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(patchProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: `run-${token}`,
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(
    actionBatchSubmits,
    1,
    `patch mismatch is returned by one Kernel actionBatchSubmit; events=${events.map((event) => `${event.kind}:${String((event.payload as any)?.stage ?? (event.payload as any)?.reason ?? (event.payload as any)?.summary ?? (event.payload as any)?.content ?? (event.payload as any)?.message ?? '')}`).join('|')}`
  );
  const failure = result.events.find((event) =>
    event.kind === 'workflow_stage' &&
    (event.payload as any)?.stage === 'accepted_plan.batch_failed'
  );
  assertEqual(
    (failure?.payload as any)?.failures?.[0]?.code,
    'patch_stale_or_mismatched_evidence',
    'patch match miss is classified as stale or mismatched evidence'
  );
  assertEqual(
    String((failure?.payload as any)?.summary ?? '').includes('patch match did not occur'),
    true,
    'patch mismatch summary keeps the original Kernel error'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanRejectsBlockedProcessExec(): Promise<void> {
  const events = [
    ...turnAuthorityFixture(
      'session-accepted-plan-exec',
      'run-accepted-plan-exec',
      'Execute the accepted process task under Kernel policy.',
      'accepted-plan-exec'
    ),
    genericKernelContextProjectionEvent('session-accepted-plan-exec', 'run-accepted-plan-exec'),
    processExecAcceptedTaskPlanCardEvent('session-accepted-plan-exec', 'run-accepted-plan-exec'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-exec',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let providerCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [{
            kind: 'permission.requested',
            runId: 'run-generic',
            sessionId: session.id,
            request: kernelTestPermissionRequest('permission-exec-generic', {
              capability: 'process.exec',
              toolId: 'process.exec',
              riskLevel: 'high',
              summary: 'Run a generic validation command.',
            }),
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      providerCalls += 1;
      return semanticToolLlmResponse('session.report_diagnostic', {
        code: 'unexpected_provider_call',
        summary: 'A blocked Kernel tool must be rejected before the Provider is called.',
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-exec',
    targetId: 'impl-generic-exec',
    existingEvents: events,
  });

  assertEqual(providerCalls, 0, 'blocked process.exec is rejected before accepted-task Provider execution');
  assertEqual(proposalSubmits, 0, 'blocked process.exec does not reach Kernel ProposalSubmit');
  assertEqual(actionBatchSubmits, 0, 'blocked process.exec does not reach Kernel execution');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'error' &&
      (event.payload as any)?.code === 'accepted_task_tool_unavailable'
    ),
    true,
    `blocked process.exec closes the accepted task with its structured Session diagnostic code; events=${result.events.map((event) => `${event.kind}:${JSON.stringify(event.payload)}`).join('|')}`
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'failed'
    ),
    true,
    'blocked process.exec marks the current run failed'
  );
}

async function assertSessionDriverLoopAcceptedTaskDiagnosticFailsRun(): Promise<void> {
  const token = randomSmokeToken('accepted-task-diagnostic');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const events = [
    ...turnAuthorityFixture(sessionId, runId, `Execute the accepted task for ${token}.`, `diagnostic-${token}`),
    genericKernelContextProjectionEvent(sessionId, runId),
    acceptedTaskPlanCardEvent(sessionId, runId),
  ];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let providerCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request) => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      providerCalls += 1;
      return semanticToolLlmResponse('session.report_diagnostic', {
        severity: 'info',
        summary: `The current accepted task cannot continue for ${token}.`,
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${token}-${events.length + providerCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(providerCalls, 1, 'accepted task diagnostic is handled by one Provider turn');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.task_failed'
    ),
    true,
    'accepted task diagnostic records a failed task stage regardless of display severity'
  );
  assertEqual(
    result.events.filter((event) =>
      event.kind === 'error' &&
      (event.payload as any)?.code === 'accepted_task_diagnostic'
    ).length,
    1,
    'accepted task diagnostic produces one structured error projection'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'failed' &&
      (event.payload as any)?.reason === 'task_diagnostic'
    ),
    true,
    'accepted task diagnostic terminates the run as failed'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'review_summary'),
    false,
    'accepted task diagnostic never enters Review'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanContinuesUntilTasksComplete(): Promise<void> {
  const events = [
    ...turnAuthorityFixture(
      'session-accepted-plan-continue',
      'run-accepted-plan-continue',
      'Create both accepted generic artifacts.',
      'accepted-plan-continue'
    ),
    genericKernelContextProjectionEvent('session-accepted-plan-continue', 'run-accepted-plan-continue'),
    multiTargetAcceptedTaskPlanCardEvent('session-accepted-plan-continue', 'run-accepted-plan-continue'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-continue',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const directives = [
    {
      taskId: 'task-generic-one',
      slotId: 'slot-task-generic-one-plan-op-task-generic-one-1',
      content: 'generic one',
    },
    {
      taskId: 'task-generic-two',
      slotId: 'slot-task-generic-two-plan-op-task-generic-two-1',
      content: 'generic two',
    },
  ];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  let runCreates = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') runCreates += 1;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const action = command.batch?.actionBundle?.actions?.[0] ?? {};
        const actionId = action.id ?? action.actionId ?? `write-generic-${actionBatchSubmits}`;
        const path = action.args?.path ?? `generic-${actionBatchSubmits}.txt`;
        const workUnitId = `work-unit-${actionBatchSubmits}`;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: command.runId,
              workUnitId,
              actionId,
              toolId: String(action.toolId ?? 'fs.write'),
              writeSet: [path],
            }),
            completedKernelToolFact({
              runId: String(command.runId),
              sessionId: session.id,
              workUnitId,
              toolCallId: `tool-call-${actionBatchSubmits}`,
              toolId: String(action.toolId ?? 'fs.write'),
              path,
              content: (command.batch?.contentBlocks?.[0]?.contentLines ?? []).join('\n'),
            }),
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId,
              output: { path },
            },
            kernelTestBatchReviewReady(String(command.runId)),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      const directive = directives[Math.min(Math.floor(llmCalls / 2), directives.length - 1)];
      const appendChunk = llmCalls % 2 === 0;
      llmCalls += 1;
      return appendChunk
        ? semanticToolLlmResponse('session.append_artifact_chunk', {
          slotId: directive.slotId,
          contentLines: [directive.content],
          finalChunk: true,
        })
        : semanticToolLlmResponse('session.finalize_task_artifacts', {
          summary: `Generate ${directive.taskId}`,
        });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-continue',
    targetId: 'impl-generic-multi',
    existingEvents: events,
  });

  assertEqual(llmCalls, 4, 'accepted taskPlan appends and finalizes artifacts for both task batches');
  assertEqual(actionBatchSubmits, 2, 'accepted taskPlan executes both in-scope batches');
  assertEqual(runCreates, 0, 'accepted taskPlan resumes the existing run without Kernel runCreate');
  assertEqual(result.events.filter((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'waitingUserReview').length, 1, 'accepted taskPlan produces only one terminal review');
  const terminalReview = result.events.find((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'waitingUserReview');
  const terminalReviewPayload = terminalReview?.payload as any;
  const terminalChangedFiles = Array.isArray(terminalReviewPayload?.readableReview?.changedFiles)
    ? terminalReviewPayload.readableReview.changedFiles.map((item: any) => String(item?.path ?? ''))
    : [];
  assertEqual(terminalReviewPayload?.content, undefined, 'terminal accepted-plan review does not emit markdown fallback content');
  assert(
    terminalChangedFiles.includes('generic-one.txt') && terminalChangedFiles.includes('generic-two.txt'),
    'terminal accepted-plan review aggregates changed files from every executed task batch'
  );
  const terminalReviewLedger = terminalReviewPayload?.reviewFactsContext?.taskLedger;
  assertEqual(
    Array.isArray(terminalReviewLedger?.completedTaskIds) &&
      terminalReviewLedger.completedTaskIds.includes('task-generic-one') &&
      terminalReviewLedger.completedTaskIds.includes('task-generic-two'),
    true,
    'terminal accepted-plan review facts context uses the latest task checkpoint ledger'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      Array.isArray((event.payload as any)?.remainingTaskIds) &&
      (event.payload as any).remainingTaskIds.includes('task-generic-two')
    ),
    true,
    'first accepted-plan checkpoint keeps the remaining task queued'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanResumesAfterDecisionRequest(): Promise<void> {
  const token = `resume-${Math.random().toString(36).slice(2, 10)}`;
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const events = [
    ...turnAuthorityFixture(sessionId, runId, `Create the accepted artifacts for ${token}.`, `decision-resume-${token}`),
    genericKernelContextProjectionEvent(sessionId, runId),
    tripleTargetAcceptedTaskPlanCardEvent(sessionId, runId, token),
  ];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const targets = [
    `generic-${token}-one.txt`,
    `generic-${token}-two.txt`,
    `generic-${token}-three.txt`,
  ];
  const directives = [
    {
      name: 'session.append_artifact_chunk',
      args: {
        slotId: `slot-task-${token}-one-plan-op-task-${token}-one-1`,
        contentLines: [`content-${token}-one`],
        finalChunk: true,
      },
    },
    {
      name: 'session.finalize_task_artifacts',
      args: { summary: `Generate first artifact ${token}` },
    },
    {
      name: 'session.request_decision',
      args: {
        question: `Choose how to continue current task ${token}`,
        summary: `Current task decision ${token}`,
        allowsFreeform: true,
        options: [
          { id: 'continue', label: `Continue ${token}`, description: `Continue the accepted current task ${token}`, recommended: true },
          { id: 'stop', label: `Stop ${token}`, description: `Stop before the current task ${token}` },
        ],
      },
    },
    {
      name: 'session.append_artifact_chunk',
      args: {
        slotId: `slot-task-${token}-two-plan-op-task-${token}-two-1`,
        contentLines: [`content-${token}-two`],
        finalChunk: true,
      },
    },
    {
      name: 'session.finalize_task_artifacts',
      args: { summary: `Generate second artifact ${token}` },
    },
    {
      name: 'session.append_artifact_chunk',
      args: {
        slotId: `slot-task-${token}-three-plan-op-task-${token}-three-1`,
        contentLines: [`content-${token}-three`],
        finalChunk: true,
      },
    },
    {
      name: 'session.finalize_task_artifacts',
      args: { summary: `Generate third artifact ${token}` },
    },
  ];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId, sessionId, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId,
              sessionId,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const action = command.batch?.actionBundle?.actions?.[0] ?? {};
        const actionId = action.id ?? action.actionId ?? `write-${token}-${actionBatchSubmits}`;
        const path = action.targetPath ?? action.args?.path ?? action.resourceScope?.[0] ?? `generic-${token}-${actionBatchSubmits}.txt`;
        const workUnitId = `work-unit-${token}-${actionBatchSubmits}`;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId, sessionId, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId,
              workUnitId,
              actionId,
              toolId: String(action.toolId ?? 'fs.write'),
              writeSet: [path],
            }),
            completedKernelToolFact({
              runId,
              sessionId,
              workUnitId,
              toolCallId: `tool-call-${token}-${actionBatchSubmits}`,
              toolId: String(action.toolId ?? 'fs.write'),
              path,
              content: (command.batch?.contentBlocks?.[0]?.contentLines ?? []).join('\n'),
            }),
            {
              kind: 'work_unit.completed',
              runId,
              sessionId,
              workUnitId,
              output: { path },
            },
            kernelTestBatchReviewReady(runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      const directive = directives[Math.min(llmCalls, directives.length - 1)];
      llmCalls += 1;
      return semanticToolLlmResponse(directive.name, directive.args);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + 1}`,
  });

  const waitingDecision = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: `impl-${token}`,
    existingEvents: events,
  });

  const confirmation = waitingDecision.events.find((event) => event.kind === 'requirement_confirmation');
  const confirmationPayload = confirmation?.payload as Record<string, any> | undefined;
  assertEqual(Boolean(confirmation), true, 'accepted taskPlan can pause at a normal decisionRequest');
  assertEqual(confirmationPayload?.acceptedPlanId, `impl-${token}`, 'decision overlay keeps the parent accepted plan id');
  assertEqual(confirmationPayload?.acceptedCurrentTaskId, `task-${token}-two`, 'decision overlay keeps the current accepted task cursor');
  assertEqual(actionBatchSubmits, 1, 'first accepted task executes before the decision request');
  assertEqual(
    waitingDecision.events.some((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'waitingUserReview'),
    false,
    'accepted plan does not enter final review while a decision request is waiting'
  );

  const final = await loop.resolveDecision({
    sessionId,
    kind: 'requirement',
    decision: 'accept',
    runId: String(confirmationPayload?.runId ?? runId),
    targetId: String(confirmationPayload?.requirementId),
    guidance: '- id: continue\n- label: Continue current accepted task',
    existingEvents: waitingDecision.events,
  });

  assertEqual(llmCalls, 7, 'accepted plan resumes provider after decision and finalizes both remaining task drafts');
  assertEqual(actionBatchSubmits, 3, 'accepted plan executes all queued tasks after decision');
  assertEqual(
    final.events.filter((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'waitingUserReview').length,
    1,
    'accepted plan enters one final review only after all tasks complete'
  );
  assertEqual(
    final.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      Array.isArray((event.payload as any)?.remainingTaskIds) &&
      (event.payload as any).remainingTaskIds.length === 0
    ),
    true,
    'accepted-plan checkpoint records no remaining tasks after resume'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanReadsGeneratedArtifactEvidence(): Promise<void> {
  const workspaceRootId = `root-${randomSmokeToken('generated-artifact')}`;
  const workspacePath = `/tmp/${randomSmokeToken('generated-artifact-workspace')}`;
  const acceptedPlanEvent = generatedArtifactAcceptedTaskPlanCardEvent(
    'session-generated-artifact-evidence',
    'run-generated-artifact-evidence'
  );
  const acceptedPlanPayload = acceptedPlanEvent.payload as any;
  acceptedPlanPayload.taskPlan.tasks[1].title = 'Verify generated input is already sufficient';
  acceptedPlanPayload.taskPlan.tasks[1].target = ['generic-generated/input.txt'];
  acceptedPlanPayload.taskPlan.tasks[1].acceptanceCriteria = [
    'Fresh generated input evidence proves the dependent task needs no additional mutation.',
  ];
  applyKernelPlanAuthorizationFixture(acceptedPlanEvent);
  const events = [
    ...turnAuthorityFixture(
      'session-generated-artifact-evidence',
      'run-generated-artifact-evidence',
      'Create and then verify the accepted generated artifact.',
      'generated-artifact-evidence'
    ),
    genericKernelContextProjectionEvent('session-generated-artifact-evidence', 'run-generated-artifact-evidence'),
    acceptedPlanEvent,
  ];
  const session: AgentSession = {
    id: 'session-generated-artifact-evidence',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const directives = [
    {
      name: 'session.append_artifact_chunk',
      args: {
        slotId: 'slot-task-generated-input-plan-op-task-generated-input-1',
        contentLines: ['generated input'],
        finalChunk: true,
      },
    },
    {
      name: 'session.finalize_task_artifacts',
      args: { summary: 'Generate the accepted input artifact.' },
    },
    {
      name: 'session.request_resources',
      args: {
        reason: 'Read the file generated by the previous accepted batch.',
        requests: [{
          kind: 'fileText',
          path: 'generic-generated/input.txt',
          reason: 'Use the current run generated artifact as evidence for the next batch.',
        }],
      },
    },
    {
      name: 'session.submit_task_outcome',
      args: {
        outcome: 'alreadySatisfied',
        summary: 'Fresh generated input evidence already satisfies the dependent accepted task.',
        evidenceRefs: ['generated-generic-generated/input.txt'],
        acceptanceResults: [{
          criterionIndex: 1,
          status: 'satisfied',
          evidenceRefs: ['generated-generic-generated/input.txt'],
        }],
      },
    },
  ];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  let resourceResolveCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'resourceResolve') {
        resourceResolveCalls += 1;
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: command.runId,
            sessionId: session.id,
            packet: kernelTestResourcePacket(
              `packet-generated-${resourceResolveCalls}`,
              String(command.requestId),
              [{
                requestItemId: `item-generated-${resourceResolveCalls}`,
                manifestEntryId: 'generated-generic-generated/input.txt',
                readPolicy: 'autoRead',
                sourceKind: 'workspace',
                status: 'resolved',
                resolvedKind: 'file',
                contentKind: 'fileText',
                path: 'generic-generated/input.txt',
                promptContent: 'generated input',
                contentHash: 'hash-generated-input',
                evidenceRefs: ['generated-generic-generated/input.txt'],
              }],
              `session:${session.id}:${workspaceRootId}`
            ),
          }],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const action = command.batch?.actionBundle?.actions?.[0] ?? {};
        const actionId = action.id ?? action.actionId ?? `write-generated-${actionBatchSubmits}`;
        const path = action.args?.path ?? action.targetPath ?? action.resourceScope?.[0] ?? `generic-generated/${actionBatchSubmits}.txt`;
        const workUnitId = `work-unit-generated-${actionBatchSubmits}`;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId,
              actionId,
              toolId: String(action.toolId ?? 'fs.write'),
              writeSet: [path],
            }),
            completedKernelToolFact({
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId,
              toolCallId: `tool-call-generated-${actionBatchSubmits}`,
              toolId: String(action.toolId ?? 'fs.write'),
              path,
              content: (command.batch?.contentBlocks?.[0]?.contentLines ?? []).join('\n'),
            }),
            kernelTestWorkUnitCompleted('run-generic', workUnitId, { actionId, path }),
            kernelTestBatchReviewReady('run-generic'),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      const directive = directives[Math.min(llmCalls, directives.length - 1)];
      llmCalls += 1;
      return semanticToolLlmResponse(directive.name, directive.args);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + resourceResolveCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-generated-artifact-evidence',
    targetId: 'impl-generated-artifact',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: workspaceRootId,
      label: 'Generated artifact workspace',
      displayPath: workspacePath,
      absolutePath: workspacePath,
      source: 'projectWorkingDirectory',
    },
  });

  assertEqual(llmCalls, 4, 'provider resumes after generated artifact resourceRequest and closes the dependent task with one structured outcome');
  assertEqual(actionBatchSubmits, 1, 'alreadySatisfied does not fabricate a second Kernel mutation batch');
  assertEqual(resourceResolveCalls, 1, 'generated artifact content is read through Kernel ResourceResolve');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'tool_result' &&
      (event.payload as any)?.toolName === 'kernel.resourceResolve' &&
      Array.isArray((event.payload as any)?.output?.items) &&
      (event.payload as any).output.items.some((item: any) =>
        item.path === 'generic-generated/input.txt' &&
        typeof item.promptContent === 'string' &&
        item.promptContent.includes('generated input')
      )
    ),
    true,
    'Kernel ResourcePacket content is projected for the generated artifact request'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      (event.payload as any)?.source === 'modelTaskOutcome' &&
      (event.payload as any)?.taskId === 'task-generated-output'
    ),
    true,
    'fresh generated evidence records a modelJudgedSufficient task checkpoint'
  );
  assertEqual(
    result.events.filter((event) =>
      event.kind === 'review_summary' &&
      (event.payload as any)?.status === 'waitingUserReview'
    ).length,
    1,
    'the final task outcome transitions directly to one Review without another Provider turn'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanResumesFromResourceCursor(): Promise<void> {
  const events = [
    ...turnAuthorityFixture(
      'session-accepted-plan-resource-resume',
      'run-accepted-plan-resource-resume',
      'Complete the accepted task after reading its required evidence.',
      'resource-resume'
    ),
    genericKernelContextProjectionEvent('session-accepted-plan-resource-resume', 'run-accepted-plan-resource-resume'),
    acceptedTaskPlanCardEvent('session-accepted-plan-resource-resume', 'run-accepted-plan-resource-resume'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-resource-resume',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const providerPrompts: string[] = [];
  const providerSystems: string[] = [];
  const providerToolShapes: string[] = [];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  let resourceResolveCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'resourceResolve') {
        resourceResolveCalls += 1;
        return fakeKernel(request);
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId: 'work-unit-resource-resume',
              actionId: 'write-generic-output',
              toolId: 'fs.write',
              writeSet: ['generic-output.txt'],
            }),
            kernelTestWorkUnitCompleted('run-generic', 'work-unit-resource-resume', { path: 'generic-output.txt' }),
            kernelTestBatchReviewReady('run-generic'),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const requestText = request.messages.map((message) => message.content).join('\n');
      providerPrompts.push(requestText);
      providerSystems.push(request.messages.find((message) => message.role === 'system')?.content ?? '');
      providerToolShapes.push(JSON.stringify((request.tools ?? []).map((tool) => tool.name)));
      if (llmCalls === 1) {
        return semanticToolLlmResponse('session.request_resources', {
          reason: 'Read the current generic output evidence before writing.',
          requests: [{
            kind: 'fileText',
            path: 'generic-output.txt',
            reason: 'Use current file evidence for the accepted task.',
          }],
        });
      }
      assert(requestText.includes('slot-task-generic-write-plan-op-task-generic-write-1'), 'resource resume keeps the same current Kernel-authorized IntentSlot');
      assert(requestText.includes('ResourceEvidence'), 'resource resume appends ResourceEvidence to the same ContextAdmission shape');
      return llmCalls === 2
        ? semanticToolLlmResponse('session.append_artifact_chunk', {
          slotId: 'slot-task-generic-write-plan-op-task-generic-write-1',
          contentLines: ['generic output after evidence'],
          finalChunk: true,
        })
        : semanticToolLlmResponse('session.finalize_task_artifacts', {
          summary: 'Generate the accepted artifact after reading current evidence.',
        });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + resourceResolveCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-resource-resume',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'root-generic-workspace',
      label: 'Generic workspace',
      displayPath: '/tmp/generic-workspace',
      absolutePath: '/tmp/generic-workspace',
      source: 'projectWorkingDirectory',
    },
  });

  assertEqual(llmCalls, 3, 'accepted-plan resourceRequest resumes through bounded append and finalize calls');
  assertEqual(providerSystems.every((value) => value === providerSystems[0]), true, 'resource resume keeps the same execution profile system contract');
  assertEqual(providerToolShapes.every((value) => value === providerToolShapes[0]), true, 'resource resume keeps the execution semantic tool schema and order stable');
  assertEqual(actionBatchSubmits, 1, 'compact resource resume actionBundle is submitted to Kernel');
  assertEqual(resourceResolveCalls >= 1, true, 'resource resume resolves current evidence through Kernel ResourceResolve');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.resource_resume' &&
      typeof (event.payload as any)?.taskCursorId === 'string'
    ),
    true,
    'accepted-plan resource resume writes cursor projection'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.task_savepoint'
    ),
    true,
    'accepted-plan execution writes a task savepoint after the resumed batch'
  );
  assert(providerPrompts[0] && providerPrompts[0].includes('slot-task-generic-write-plan-op-task-generic-write-1'), 'first call starts with the same current Kernel-authorized IntentSlot');
}

async function assertSessionDriverLoopAcceptedTaskPlanChainsResourceResumeRequests(): Promise<void> {
  const token = randomSmokeToken('resource-chain');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const events = [
    ...turnAuthorityFixture(sessionId, runId, `Resolve the accepted task evidence for ${token}.`, `resource-chain-${token}`),
    genericKernelContextProjectionEvent(sessionId, runId),
    acceptedTaskPlanCardEvent(sessionId, runId),
  ];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const providerPrompts: string[] = [];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  let resourceResolveCalls = 0;
  const evidencePaths = [
    `${randomSmokeToken('evidence')}/${randomSmokeToken('file')}.txt`,
    `${randomSmokeToken('evidence')}/${randomSmokeToken('file')}.txt`,
  ];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'resourceResolve') {
        resourceResolveCalls += 1;
        return fakeKernel(request);
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitCompleted('run-generic', `work-unit-${token}`, { path: 'generic-output.txt' }),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const requestText = request.messages.map((message) => message.content).join('\n');
      providerPrompts.push(requestText);
      if (llmCalls === 1 || llmCalls === 2) {
        if (llmCalls === 2) {
          assert(requestText.includes(evidencePaths[0]), 'second call appends the first resolved evidence path');
        }
        return semanticToolLlmResponse('session.request_resources', {
          reason: `Read additional generic evidence ${llmCalls}.`,
          requests: [{
            kind: 'fileText',
            path: evidencePaths[llmCalls - 1],
            reason: 'Use current file evidence for the accepted task.',
          }],
        });
      }
      assert(requestText.includes(evidencePaths[0]), 'artifact calls retain the first resolved evidence path');
      assert(requestText.includes(evidencePaths[1]), 'artifact calls retain the second resolved evidence path');
      return llmCalls === 3
        ? semanticToolLlmResponse('session.append_artifact_chunk', {
          slotId: 'slot-task-generic-write-plan-op-task-generic-write-1',
          contentLines: [`content-${token}`],
          finalChunk: true,
        })
        : semanticToolLlmResponse('session.finalize_task_artifacts', {
          summary: `Generate artifact after chained evidence ${token}`,
        });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + resourceResolveCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: `root-${token}`,
      label: 'Generic workspace',
      displayPath: `/tmp/${token}`,
      absolutePath: `/tmp/${token}`,
      source: 'projectWorkingDirectory',
    },
  });

  const terminalSummary = result.events.slice(-8).map((event) => ({
    kind: event.kind,
    stage: (event.payload as any)?.stage,
    code: (event.payload as any)?.code,
    status: (event.payload as any)?.status,
    message: event.kind === 'error' ? (event.payload as any)?.message : undefined,
  }));
  assertEqual(
    llmCalls,
    4,
    `chained resource resume requests terminate with bounded append and finalize calls; events=${JSON.stringify(terminalSummary)}`
  );
  assertEqual(actionBatchSubmits, 1, 'chained resource resume actionBundle is submitted once');
  assertEqual(resourceResolveCalls, 2, 'each chained resourceRequest resolves through Kernel ResourceResolve');
  assertEqual(
    (providerPrompts[1]?.match(/ProviderTurnContract:/g) ?? []).length,
    1,
    `resource resume reuses the existing workflow contract instead of appending a duplicate contract; contracts=${JSON.stringify((providerPrompts[1] ?? '').split('ProviderTurnContract:').slice(1).map((value) => value.slice(0, 700)))}`
  );
  assertEqual(
    result.events.filter((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.resource_resume'
    ).length,
    2,
    'each chained resource resume writes a cursor projection'
  );
  assert(providerPrompts[0] && providerPrompts[0].includes('slot-task-generic-write-plan-op-task-generic-write-1'), 'first call starts with the current Kernel-authorized IntentSlot');
}

async function assertSessionDriverLoopAcceptedReadOnlyResourceValidationUsesStructuredOutcome(): Promise<void> {
  const token = randomSmokeToken('readonly');
  const targets = Array.from({ length: 5 }, () => `${randomSmokeToken('scope')}/${randomSmokeToken('target')}.txt`);
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const events = [
    ...turnAuthorityFixture(sessionId, runId, `Validate the accepted read-only targets for ${token}.`, `readonly-${token}`),
    genericKernelContextProjectionEvent(sessionId, runId),
    readOnlyAcceptedTaskPlanCardEvent(sessionId, runId, token, targets),
  ];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  let reviewFactsRequests = 0;
  let resourceResolveCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveCalls += 1;
        const entries = Array.isArray(command.request?.manifest?.entries)
          ? command.request.manifest.entries
          : [];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId,
            sessionId,
            packet: kernelTestResourcePacket(
              `packet-${token}-${resourceResolveCalls}`,
              command.requestId,
              entries.map((entry: any, index: number) => {
                const target = targets[index] ?? String(entry.resourceRef ?? entry.id ?? `fallback-${index}`);
                return {
                  requestItemId: `item-${token}-${index}`,
                  manifestEntryId: String(entry.id ?? target),
                  readPolicy: 'explicit-manifest-readonly',
                  status: 'resolved',
                  path: target,
                  absolutePath: `/tmp/${token}/${target}`,
                  contentKind: 'fileText',
                  promptContent: `resolved ${randomSmokeToken('content')} for ${target}`,
                  evidenceRefs: [`evidence-${token}-${index}`],
                };
              }),
              command.request?.manifest?.workspaceScopeKey ?? `workspace-${token}`,
            ),
          }],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return fakeKernel(request);
      }
      if (command.kind === 'reviewFactsGet') {
        reviewFactsRequests += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return semanticToolLlmResponse('session.request_resources', {
          reason: 'Read current evidence for the accepted validation task.',
          requests: targets.map((target) => ({
            kind: 'fileText',
            path: target,
            reason: 'Resolve read-only validation evidence.',
          })),
        });
      }
      const evidenceRefs = [`packet-${token}-1`];
      return semanticToolLlmResponse('session.submit_task_outcome', {
        outcome: 'alreadySatisfied',
        summary: 'Fresh Kernel resource evidence satisfies the accepted read-only validation task.',
        evidenceRefs,
        acceptanceResults: [{
          criterionIndex: 1,
          status: 'satisfied',
          evidenceRefs,
        }],
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + resourceResolveCalls + reviewFactsRequests + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: `impl-${token}`,
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: `root-${token}`,
      label: 'Random workspace',
      displayPath: `/tmp/${token}`,
      absolutePath: `/tmp/${token}`,
      source: 'projectWorkingDirectory',
    },
  });

  assertEqual(llmCalls, 2, 'resource evidence resumes the provider once for a structured task outcome');
  assertEqual(resourceResolveCalls, 1, 'read-only validation resolves one focused ResourcePacket');
  assertEqual(actionBatchSubmits, 0, 'already-satisfied read-only validation does not fabricate a Kernel execution batch');
  assertEqual(reviewFactsRequests, 1, 'read-only validation enters final review facts collection');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      (event.payload as any)?.source === 'modelTaskOutcome'
    ),
    true,
    'read-only validation records a structured model outcome without Kernel completion facts'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'review_summary' &&
      (event.payload as any)?.status === 'waitingUserReview'
    ),
    true,
    'read-only validation reaches review instead of waiting for permission or provider output'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.phase === 'waiting_review'
    ),
    true,
    'read-only validation leaves the run waiting for review'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanAllowsAbsoluteAttachmentChildTarget(): Promise<void> {
  const root = '/workspace/generic-project';
  const events: AgentEvent[] = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-absolute-child', root),
    acceptedTaskPlanCardEvent('session-accepted-plan-absolute-child', 'run-accepted-plan-absolute-child'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-absolute-child',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}, root),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(absoluteTargetWriteProposal(`${root}/generic-output.txt`)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-absolute-child',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
  });

  assertEqual(actionBatchSubmits, 1, 'absolute child target under accepted attachment root is auto-executed');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'absolute child target does not trigger scope intervention');
}

async function assertSessionDriverLoopAcceptedImplementationRejectsAttachmentRootTarget(): Promise<void> {
  const root = '/workspace/generic-project';
  const events: AgentEvent[] = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-root-target', root),
    acceptedTaskPlanCardEvent('session-accepted-plan-root-target', 'run-accepted-plan-root-target'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-root-target',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(absoluteTargetWriteProposal(root)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-root-target',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
  });

  assertEqual(actionBatchSubmits, 0, 'attachment root target is rejected before Kernel actionBatchSubmit');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'attachment root target becomes one scope intervention');
  assert(
    result.events.some((event) => String((event.payload as any)?.summary ?? '').includes('not a writable file target')),
    'attachment root target intervention explains that the target is a directory root'
  );
}

async function assertSessionDriverLoopAcceptedTaskPlanProjectsWorkUnitFailureReason(): Promise<void> {
  const events = [acceptedTaskPlanCardEvent('session-accepted-plan-failure', 'run-accepted-plan-failure')];
  const session: AgentSession = {
    id: 'session-accepted-plan-failure',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let reviewFactsRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        return {
          ok: true,
          events: [
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId: 'work-unit-generic',
              actionId: 'write-generic-output',
              toolId: 'fs.write',
              writeSet: ['generic-output.txt'],
            }),
            kernelTestWorkUnitStarted('run-generic', 'work-unit-generic'),
            kernelTestWorkUnitFailed(
              'run-generic',
              'work-unit-generic',
              'invalid_path',
              'fs.write target is outside workspace binding',
            ),
            kernelTestBatchReviewReady('run-generic'),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        reviewFactsRequests += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-failure',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  const errorMessage = result.events
    .filter((event) => event.kind === 'error')
    .map((event) => String((event.payload as any)?.message ?? ''))
    .join('\n');
  assert(errorMessage.includes('work-unit-generic'), 'work_unit.failed projection includes the work unit id');
  assert(errorMessage.includes('fs.write target is outside workspace binding'), 'work_unit.failed projection includes the Kernel error message');
  assert(!errorMessage.includes('Kernel rejected the proposal'), 'work_unit.failed projection is not mislabeled as proposal rejection');
  assertEqual(reviewFactsRequests, 0, 'work_unit.failed stops accepted-plan flow before reviewFactsGet');
  assertEqual(result.events.some((event) => event.kind === 'review_summary'), false, 'work_unit.failed does not create terminal review');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'failed' &&
      (event.payload as any)?.reason === 'work_unit_failed'
    ),
    true,
    'work_unit.failed appends explicit failed session lifecycle'
  );
  const failureCheckpoint = result.events.find((event) =>
    event.kind === 'workflow_stage' &&
    (event.payload as any)?.stage === 'accepted_plan.batch_failed'
  );
  assert(Boolean(failureCheckpoint), 'work_unit.failed records an accepted-plan failure checkpoint');
  assert(
    JSON.stringify((failureCheckpoint?.payload as any)?.failures ?? []).includes('generic-output.txt'),
    'failure checkpoint retains writeSet details'
  );
}

async function assertSessionDriverLoopAcceptedImplementationRejectsOutOfScopeBatch(): Promise<void> {
  const events = [acceptedTaskPlanCardEvent('session-accepted-plan-oos', 'run-accepted-plan-oos')];
  const session: AgentSession = {
    id: 'session-accepted-plan-oos',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let llmCalls = 0;
  const outOfScopeProposal = genericWriteProposal(false);
  (outOfScopeProposal.contentBlocks as any[])[0].targetPath = 'outside-output.txt';
  (outOfScopeProposal.actionBundle as any).actions[0].args = { path: 'outside-output.txt', contentBlockId: 'generic-block' };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitCompleted(command.runId, 'work-unit-generic', { path: 'generic-output.txt' }),
            kernelTestBatchReviewReady(command.runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(llmCalls === 1 ? outOfScopeProposal : genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-oos',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    interventionLevel: 'medium',
  });

  assertEqual(proposalSubmits, 0, 'out-of-scope accepted taskPlan batch does not reach Kernel PlanReview');
  assertEqual(actionBatchSubmits, 0, 'out-of-scope accepted taskPlan batch is not executed');
  assertEqual(result.events.filter((event) => event.kind === 'plan_card').length, 1, 'out-of-scope batch does not create another plan card');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'out-of-scope batch becomes one user intervention request');
  const confirmation = result.events.find((event) => event.kind === 'requirement_confirmation');
  const confirmationPayload = confirmation?.payload as any;
  assertEqual(confirmationPayload?.interactionOverlay, true, 'accepted-plan scope intervention is marked as an overlay');
  assertEqual(confirmationPayload?.parentPhase, 'executing_accepted_plan', 'accepted-plan scope intervention records the parent phase');
  assertEqual(confirmationPayload?.decisionRequest?.decisionScope, 'acceptedPlanBatchOutOfScope', 'accepted-plan scope decision is identifiable');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.phase === 'waiting_permission' &&
      (event.payload as any)?.reason === 'requirement' &&
      (event.payload as any)?.interactionOverlay === true
    ),
    true,
    'out-of-scope batch records waiting execution-scope overlay session state without returning to plan review'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.phase === 'waiting_plan_review' &&
      (event.payload as any)?.reason === 'requirement'
    ),
    false,
    'out-of-scope accepted execution does not enter plan-review waiting phase'
  );

  const resumed = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'accept',
    runId: confirmationPayload?.runId,
    targetId: confirmationPayload?.requirementId,
    guidance: '- id: regenerate-in-scope',
    existingEvents: result.events,
    interventionLevel: 'medium',
  });

  assertEqual(llmCalls, 2, 'out-of-scope accepted batch skips provider scope repair and resumes once after user decision');
  assertEqual(proposalSubmits, 1, 'accepted-plan scope decision resumes provider checkpoint and submits repaired batch');
  assertEqual(actionBatchSubmits, 1, 'accepted-plan scope decision continues to actionBatchSubmit after in-scope regeneration');
  assertEqual(
    resumed.events.some((event) =>
      event.kind === 'requirement_decision' &&
      (event.payload as any)?.interactionOverlay === true &&
      (event.payload as any)?.parentPhase === 'executing_accepted_plan'
    ),
    true,
    'accepted-plan scope decision remains attached to the parent execution overlay'
  );
}

async function assertSessionDriverLoopAcceptedScopeRepairDecisionWaitsForPermission(): Promise<void> {
  const token = randomSmokeToken('scope-decision');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const events = [acceptedTaskPlanCardEvent(sessionId, runId)];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const llmPromptTexts: string[] = [];
  const outOfScopeProposal = genericWriteProposal(false);
  (outOfScopeProposal.contentBlocks as any[])[0].targetPath = `${token}-outside.txt`;
  (outOfScopeProposal.actionBundle as any).actions[0].args = { path: `${token}-outside.txt`, contentBlockId: 'generic-block' };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') proposalSubmits += 1;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      llmPromptTexts.push(request.messages.map((message) => message.content).join('\n'));
      return jsonLlmResponse(llmCalls === 1 ? outOfScopeProposal : genericDecisionRequestProposal(`decision-${token}`));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: 'impl-generic-auto',
    existingEvents: events,
    interventionLevel: 'medium',
  });

  assertEqual(llmCalls, 1, 'target out-of-scope accepted batch does not ask provider for scope repair');
  assertEqual(proposalSubmits, 0, 'scope repair decision does not submit out-of-scope work to Kernel PlanReview');
  assertEqual(actionBatchSubmits, 0, 'scope repair decision does not execute out-of-scope work');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'valid scope repair decision projects to user intervention');
  const confirmation = result.events.find((event) => event.kind === 'requirement_confirmation');
  const decisionOptions = (((confirmation?.payload as any)?.decisionRequest?.options ?? []) as any[]);
  assert(
    decisionOptions.some((option) => option?.effect?.kind === 'expandCurrentTaskScope'),
    'target out-of-scope decision offers an explicit current-task scope expansion'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.phase === 'waiting_permission' &&
      (event.payload as any)?.reason === 'requirement'
    ),
    true,
    'scope repair decision waits in execution permission phase'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.phase === 'waiting_plan_review' &&
      (event.payload as any)?.reason === 'requirement'
    ),
    false,
    'scope repair decision does not return accepted execution to plan review'
  );
}

async function assertSessionDriverLoopAcceptedScopeAcceptUsesDefaultOptionEffect(): Promise<void> {
  const token = randomSmokeToken('scope-default');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const events = [acceptedTaskPlanCardEvent(sessionId, runId)];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const expandedTarget = `${token}-outside.txt`;
  const outOfScopeProposal = genericWriteProposal(false);
  (outOfScopeProposal.contentBlocks as any[])[0].targetPath = expandedTarget;
  (outOfScopeProposal.actionBundle as any).actions[0].args = { path: expandedTarget, contentBlockId: 'generic-block' };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitCompleted(command.runId, `work-unit-${token}`, { path: expandedTarget }),
            kernelTestBatchReviewReady(command.runId),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(outOfScopeProposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const first = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: 'impl-generic-auto',
    existingEvents: events,
    interventionLevel: 'medium',
  });
  const confirmation = first.events.find((event) => event.kind === 'requirement_confirmation');
  const confirmationPayload = confirmation?.payload as Record<string, any> | undefined;
  assertEqual(Boolean(confirmation), true, 'out-of-scope batch asks for one current-task scope decision');

  const resumed = await loop.resolveDecision({
    sessionId,
    kind: 'requirement',
    decision: 'accept',
    runId: typeof confirmationPayload?.runId === 'string' ? confirmationPayload.runId : undefined,
    targetId: typeof confirmationPayload?.requirementId === 'string' ? confirmationPayload.requirementId : undefined,
    existingEvents: first.events,
    interventionLevel: 'medium',
  });

  assertEqual(llmCalls, 2, 'default accepted scope option resumes the same current task once');
  assertEqual(proposalSubmits, 1, 'default accepted scope option expands current task scope before Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'default accepted scope option allows the expanded current-task batch to execute');
  assertEqual(
    resumed.events.filter((event) => event.kind === 'plan_card').length,
    1,
    'default accepted scope option does not create a new plan card'
  );
}

async function assertSessionDriverLoopAcceptedScopeRepairInvalidDecisionFallsBackToIntervention(): Promise<void> {
  const token = randomSmokeToken('scope-fallback');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const events = [acceptedTaskPlanCardEvent(sessionId, runId)];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const outOfScopeProposal = genericWriteProposal(false);
  (outOfScopeProposal.contentBlocks as any[])[0].targetPath = `${token}-outside.txt`;
  (outOfScopeProposal.actionBundle as any).actions[0].args = { path: `${token}-outside.txt`, contentBlockId: 'generic-block' };
  const invalidDecisionRequest = {
    schemaVersion: 'deepcode.agent.protocol.v4',
    kind: 'decisionRequest',
    outputLanguage: 'en-US',
    decisionRequest: {
      version: '1',
      id: `decision-${token}`,
      options: [
        { id: 'continue', label: 'Continue', description: 'Continue the current task.', recommended: true },
        { id: 'revise', label: 'Revise', description: 'Revise the current task scope.' },
      ],
      allowsFreeform: true,
    },
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') proposalSubmits += 1;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(llmCalls === 1 ? outOfScopeProposal : invalidDecisionRequest);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: 'impl-generic-auto',
    existingEvents: events,
    interventionLevel: 'medium',
  });

  const confirmation = result.events.find((event) => event.kind === 'requirement_confirmation');
  const confirmationPayload = confirmation?.payload as Record<string, any> | undefined;
  assertEqual(llmCalls, 1, 'target out-of-scope deterministic intervention bypasses invalid provider scope repair');
  assertEqual(proposalSubmits, 0, 'invalid scope repair fallback does not submit out-of-scope work to Kernel PlanReview');
  assertEqual(actionBatchSubmits, 0, 'invalid scope repair fallback does not execute out-of-scope work');
  assertEqual(Boolean(confirmation), true, 'invalid scope repair decision falls back to a legal user intervention');
  assertEqual(typeof confirmationPayload?.decisionRequest?.question, 'string', 'fallback decisionRequest includes required question');
  assertEqual(Array.isArray(confirmationPayload?.decisionRequest?.options), true, 'fallback decisionRequest includes options');
  assertEqual(confirmationPayload?.decisionRequest?.allowsFreeform, true, 'fallback decisionRequest allows freeform guidance');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'error' &&
      String((event.payload as any)?.diagnosticCode ?? '').includes('autoBatchScopeRepairFailed')
    ),
    false,
    'invalid scope repair decision no longer terminates as autoBatchScopeRepairFailed'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.phase === 'waiting_permission' &&
      (event.payload as any)?.reason === 'requirement'
    ),
    true,
    'fallback intervention waits in execution permission phase'
  );
}

async function assertSessionDriverLoopAcceptedPlanPatchRequestsSearchEvidence(): Promise<void> {
  const planEvent = acceptedTaskPlanCardEvent('session-accepted-plan-patch-evidence', 'run-accepted-plan-patch-evidence');
  const planPayload = planEvent.payload as any;
  planPayload.planId = 'impl-generic-patch';
  planPayload.taskPlan.id = 'impl-generic-patch';
  planPayload.taskPlan.tasks = [{
    taskId: 'task-generic-patch',
    title: 'Patch generic file',
    target: ['generic-patch.txt'],
    scope: 'Patch one generic file with exact ResourcePacket evidence.',
    dependencies: [],
    capability: 'fs.write',
    acceptanceCriteria: ['Kernel records the generic patch work unit fact.'],
    failureCriteria: ['Stop if the patch lacks current exact-block evidence.'],
  }];
  const root = '/workspace/generic-project';
  const events = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-patch-evidence', root),
    planEvent,
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-patch-evidence',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let resourceSearchRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        const entry = command.request?.manifest?.entries?.[0] ?? {};
        if (entry.kind === 'search') resourceSearchRequests += 1;
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            packet: kernelTestResourcePacket(
              `packet-generic-${resourceSearchRequests}`,
              command.requestId,
              [{
                requestItemId: 'search-item',
                manifestEntryId: entry.id ?? 'search-entry',
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                resolvedKind: entry.kind,
                contentKind: entry.kind === 'search' ? 'searchResults' : 'directoryTree',
                path: entry.kind === 'search' ? 'generic-patch.txt' : entry.resourceRef,
                absolutePath: entry.resourceRef,
                query: entry.query,
                matches: entry.kind === 'search'
                  ? [{ path: 'generic-patch.txt', line: 1, preview: 'old generic line' }]
                  : undefined,
                returnedMatches: entry.kind === 'search' ? 1 : undefined,
                promptContent: entry.kind === 'search'
                  ? JSON.stringify({ matches: [{ path: 'generic-patch.txt', line: 1, preview: 'old generic line' }] })
                  : undefined,
                nodes: entry.kind === 'search' ? undefined : [{ type: 'file', path: 'generic-patch.txt' }],
                evidenceRefs: ['evidence-generic-patch'],
              }],
            ),
          }],
        };
      }
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            kernelTestWorkUnitQueued({
              runId: 'run-generic',
              workUnitId: 'work-unit-generic-patch',
              actionId: 'patch-generic-output',
              toolId: 'fs.edit',
              writeSet: ['generic-patch.txt'],
            }),
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic-patch',
              output: { path: 'generic-patch.txt' },
            },
            kernelTestBatchReviewReady('run-generic'),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) return jsonLlmResponse(genericPatchProposal());
      if (llmCalls === 2) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v4',
          kind: 'resourceRequest',
          outputLanguage: 'en-US',
          resourceRequest: {
            version: '1',
            id: 'need-generic-patch-anchor',
            reason: 'Need current exact-block evidence before patching.',
            items: [{
              id: 'search-generic-patch-anchor',
              kind: 'search',
              query: 'old generic line',
              include: ['generic-patch.txt'],
              contextLines: 1,
              maxResults: 5,
              reason: 'Find the generic exact patch anchor.',
            }],
          },
        });
      }
      return jsonLlmResponse(genericPatchProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + resourceSearchRequests + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-patch-evidence',
    targetId: 'impl-generic-patch',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
    interventionLevel: 'medium',
  });

  assertEqual(resourceSearchRequests, 1, 'patch without evidence is repaired through one search ResourceResolve');
  assertEqual(proposalSubmits, 1, 'patch action reaches Kernel PlanReview only after ResourcePacket evidence exists');
  assertEqual(actionBatchSubmits, 1, 'patch action executes after exact-block evidence is available');
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'search ResourcePacket is committed before patch execution');
}

async function assertSessionDriverLoopReviewAcceptAutoGeneratesNextPlan(): Promise<void> {
  const token = randomSmokeToken('review-continuation-plan');
  const continuationTarget = `scope-${token}/follow-up.sh`;
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-review-accept',
      'run-review-accept',
      'Create a generic batch with a possible reviewed continuation.',
      `review-accept-${token}`
    ),
    genericKernelContextProjectionEvent('session-review-accept', 'run-review-accept'),
    genericMissingResourceEvent('session-review-accept', 'run-review-accept', continuationTarget),
    {
    id: 'review-waiting-accept-generic',
    sessionId: 'session-review-accept',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-accept',
      reviewId: 'review-accept-generic',
      sourcePlanId: 'plan-accept-generic',
      content: '## Review\n\nThe first batch wrote a generic source file.',
      userPlan: '# Plan\n\n## Summary\nCreate the first generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [{
        id: 'next-generic-batch',
        title: 'Add a generic follow-up script',
        capability: 'fs.write',
        kind: 'write',
        resourceScope: ['scripts/generic.sh'],
      }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-accept',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  let runCreates = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      if (request.command.kind === 'runCreate') runCreates += 1;
      return planKernel(request, 'session-review-accept', submittedPlans);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return semanticToolLlmResponse('session.submit_plan', {
        title: `Continuation plan ${token}`,
        summary: `Plan the accepted review continuation ${token}`,
        tasks: [{
          taskId: `task-${token}`,
          title: `Implement continuation ${token}`,
          toolId: 'fs.create',
          targets: [continuationTarget],
          args: {},
          dependencies: [],
          acceptanceCriteria: [`Acceptance ${token}`],
          failureCriteria: [`Failure ${token}`],
        }],
        risks: [],
        reviewCheckpoints: [],
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-accept',
    kind: 'review',
    decision: 'accept',
    runId: 'run-review-accept',
    existingEvents: events,
  });

  const acceptedReview = result.events.find((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted');
  if (!acceptedReview) throw new Error('review accept records an accepted review event');
  const acceptedPayload = acceptedReview.payload as any;
  assertEqual(acceptedPayload.continuationRequested, false, 'review accept closes the current review before continuation planning');
  assertEqual(acceptedPayload.summaryKey, 'review.decision.accepted.summary', 'accepted review records localized summary key');
  assertEqual(acceptedPayload.content, undefined, 'accepted review does not emit session-generated localized content');
  assertEqual(acceptedPayload.contentKey, 'review.decision.accepted.content', 'accepted review records localized content key');
  assertEqual(acceptedPayload.continuationCount, 1, 'accepted review records continuation count structurally');
  assertEqual(Array.isArray(acceptedPayload.continuations), true, 'accepted review retains continuation facts structurally');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'completed' &&
      (event.payload as any)?.reason === 'review'
    ),
    false,
    'auto continuation review accept does not mark the current run completed before continuation planning'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'default review continuation mode generates the next plan');
  assertEqual(submittedPlans.length, 0, 'default review continuation mode projects the next semantic task plan before Kernel execution admission');
  assertEqual(llmRequests.length, 1, 'default review continuation mode calls the provider once for a new plan');
  assertEqual(runCreates, 0, 'Review continuation resumes the original run without Kernel runCreate');
}

async function assertSessionDriverLoopReviewAcceptWithoutContinuationCompletesRun(): Promise<void> {
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-review-terminal',
      'run-review-terminal',
      'Create a generic batch and close it after review.',
      'review-terminal'
    ),
    {
    id: 'review-waiting-terminal-generic',
    sessionId: 'session-review-terminal',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-terminal',
      reviewId: 'review-terminal-generic',
      sourcePlanId: 'plan-terminal-generic',
      content: '## Review\n\nThe generic batch completed.',
      userPlan: '# Plan\n\n## Summary\nCreate a generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
    },
  ];
  const session: AgentSession = {
    id: 'session-review-terminal',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-terminal', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-terminal',
    kind: 'review',
    decision: 'accept',
    runId: 'run-review-terminal',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted'), true, 'terminal review accept records an accepted review event');
  const completedState = result.events.find((event) =>
    event.kind === 'session_run_state' &&
    (event.payload as any)?.status === 'completed' &&
    (event.payload as any)?.reason === 'review'
  );
  assert(Boolean(completedState), 'terminal review accept records an explicit completed session state');
  const completedPayload = completedState?.payload as any;
  assertEqual(completedPayload.phase, 'completed', 'terminal review completed state carries completed phase');
  assertEqual(completedPayload.decisionKind, 'review', 'terminal review completed state keeps review owner kind');
  assertEqual(completedPayload.targetId, 'review-terminal-generic', 'terminal review completed state keeps review owner target');
  assertEqual(submittedPlans.length, 0, 'terminal review accept does not submit a new plan');
  assertEqual(llmRequests.length, 0, 'terminal review accept does not call the provider');
}

async function assertSessionDriverLoopReviewAcceptOffStopsAtCurrentBatch(): Promise<void> {
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-review-accept-off',
      'run-review-accept-off',
      'Create a generic batch and stop at the current review.',
      'review-accept-off'
    ),
    {
    id: 'review-waiting-accept-off-generic',
    sessionId: 'session-review-accept-off',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-accept-off',
      reviewId: 'review-accept-off-generic',
      sourcePlanId: 'plan-accept-off-generic',
      content: '## Review\n\nThe first batch wrote a generic source file.',
      userPlan: '# Plan\n\n## Summary\nCreate the first generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [{
        id: 'next-generic-batch',
        title: 'Add a generic follow-up script',
        capability: 'fs.write',
        kind: 'write',
        resourceScope: ['scripts/generic.sh'],
      }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
    },
  ];
  const session: AgentSession = {
    id: 'session-review-accept-off',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-accept-off', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-accept-off',
    kind: 'review',
    decision: 'accept',
    runId: 'run-review-accept-off',
    existingEvents: events,
    reviewContinuationMode: 'off',
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted'), true, 'review accept records an accepted review event');
  const completedState = result.events.find((event) =>
    event.kind === 'session_run_state' &&
    (event.payload as any)?.status === 'completed' &&
    (event.payload as any)?.reason === 'review'
  );
  assertEqual((completedState?.payload as any)?.summary, 'session.runState.reviewCompleted', 'completed review run state stores i18n key as summary fallback');
  assertEqual((completedState?.payload as any)?.summaryKey, 'session.runState.reviewCompleted', 'completed review run state records localized summary key');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'completed' &&
      (event.payload as any)?.reason === 'review'
    ),
    true,
    'off review continuation mode records an explicit completed session state'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'off review continuation mode does not generate a continuation plan');
  assertEqual(submittedPlans.length, 0, 'off review continuation mode does not submit a new plan');
  assertEqual(llmRequests.length, 0, 'off review continuation mode does not call the provider');
}

async function assertSessionDriverLoopRequirementRejectCancelsRun(): Promise<void> {
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-requirement-reject',
      'run-requirement-reject',
      'Create a generic workspace change.',
      'requirement-reject'
    ),
    {
    id: 'requirement-waiting-generic',
    sessionId: 'session-requirement-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      title: 'Requirement confirmation',
      summary: 'Confirm a generic requirement.',
      content: 'Confirm how to proceed with a generic request.',
      originalRequest: 'Create a generic workspace change.',
      runId: 'run-requirement-reject',
      requirementId: 'requirement-generic-reject',
      status: 'waitingUserConfirmation',
      confirmable: true,
    },
    },
  ];
  const session: AgentSession = {
    id: 'session-requirement-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'reject',
    runId: 'run-requirement-reject',
    targetId: 'requirement-generic-reject',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'requirement_decision' && (event.payload as any)?.status === 'rejected'), true, 'requirement reject records a rejected decision');
  assertCancelledRunState(result.events, 'requirement', 'run-requirement-reject', 'requirement-generic-reject');
  assertEqual(llmCalls, 0, 'requirement reject does not call the provider');
}

async function assertSessionDriverLoopRejectedDecisionCancelsRun(): Promise<void> {
  const events = [
    ...turnAuthorityFixture(
      'session-plan-reject',
      'run-plan-reject',
      'Prepare a generic plan that may be rejected.',
      'plan-reject'
    ),
    acceptedTaskPlanCardEvent('session-plan-reject', 'run-plan-reject'),
  ];
  const session: AgentSession = {
    id: 'session-plan-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'reject',
    runId: 'run-plan-reject',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'plan_review' && (event.payload as any)?.status === 'rejected'), true, 'plan reject records a rejected plan decision');
  assertCancelledRunState(result.events, 'plan_review', 'run-plan-reject', 'impl-generic-auto');
  assertEqual(actionBatchSubmits, 0, 'plan reject does not submit an action batch');
}

async function assertSessionDriverLoopReviewRejectCancelsRun(): Promise<void> {
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-review-reject',
      'run-review-reject',
      'Create a generic batch that may be rejected during review.',
      'review-reject'
    ),
    {
    id: 'review-waiting-reject-generic',
    sessionId: 'session-review-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-reject',
      reviewId: 'review-generic-reject',
      sourcePlanId: 'plan-generic-reject',
      content: '## Review\n\nA generic batch is ready.',
      userPlan: '# Plan\n\n## Summary\nCreate a generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [{ id: 'next-generic', title: 'A generic follow-up task.' }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
    },
  ];
  const session: AgentSession = {
    id: 'session-review-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let reviewGateEvaluations = 0;
  let llmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'reviewGateEvaluate') {
        reviewGateEvaluations += 1;
        assertEqual(command.decision?.decision, 'reject', 'review reject submits a typed reject decision to Kernel ReviewGate');
        return {
          ok: true,
          events: [{
            kind: 'review_gate.evaluated',
            runId: command.runId,
            result: kernelTestReviewGateEvaluation(command.runId, 'aborted'),
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + reviewGateEvaluations + llmCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'review',
    decision: 'reject',
    runId: 'run-review-reject',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'rejected'), true, 'review reject records a rejected review decision');
  assertCancelledRunState(result.events, 'review', 'run-review-reject', 'review-generic-reject');
  assertEqual(reviewGateEvaluations, 1, 'review reject records exactly one Kernel ReviewGate decision');
  assertEqual(llmCalls, 0, 'review reject does not call the provider for revision or continuation');
}

async function assertSessionDriverLoopPermissionRejectUsesKernelFacts(): Promise<void> {
  const planEvent = {
    id: 'plan-permission-reject',
    sessionId: 'session-permission-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId: 'run-permission-reject',
      planId: 'plan-permission-reject',
      proposalId: 'proposal-permission-reject',
      content: 'Review the Kernel-authorized operation.',
      actionBundle: { id: 'bundle-permission-reject', actions: [] },
      contentBlocks: [],
      commandBlocks: [],
      authorizationContract: { id: 'contract-permission-reject' },
    },
  } as unknown as AgentEvent;
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-permission-reject',
      'run-permission-reject',
      'Execute a generic gated operation.',
      'permission-reject'
    ),
    planEvent,
    {
    id: 'permission-request-generic',
    sessionId: 'session-permission-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'permission_request',
    payload: {
      id: 'permission-generic-reject',
      runId: 'run-permission-reject',
      planId: 'plan-permission-reject',
      status: 'pending',
      summary: 'A generic permission request is pending.',
    },
    },
  ];
  const session: AgentSession = {
    id: 'session-permission-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let permissionResolves = 0;
  let reviewFactsRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'permissionResolve') {
        permissionResolves += 1;
        assertEqual(command.decision, 'reject', 'permission ignore sends a reject decision to Kernel');
        return {
          ok: true,
          events: [
            {
              kind: 'permission.resolved',
              permissionId: 'permission-generic-reject',
              runId: 'run-permission-reject',
              sessionId: session.id,
              decision: 'reject',
            },
            {
              kind: 'work_unit.blocked',
              runId: 'run-permission-reject',
              sessionId: session.id,
              workUnitId: 'work-unit-permission-reject',
              reason: 'permission rejected by user',
            },
            kernelTestBatchReviewReady('run-permission-reject', 'contract-permission-reject'),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        reviewFactsRequests += 1;
        return {
          ok: true,
          events: [{
            kind: 'review.facts_produced',
            runId: 'run-permission-reject',
            sessionId: session.id,
            facts: kernelTestReviewFacts('run-permission-reject'),
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + permissionResolves + reviewFactsRequests + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'permission',
    decision: 'reject',
    runId: 'run-permission-reject',
    targetId: 'permission-generic-reject',
    existingEvents: events,
  });

  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'cancelled'),
    false,
    'Session does not infer cancellation from a rejected Kernel permission'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'waitingUserReview'),
    true,
    'Kernel blocked facts continue into Review'
  );
  assertEqual(permissionResolves, 1, 'permission reject resolves exactly one Kernel permission request');
  assertEqual(reviewFactsRequests, 1, 'permission reject requests Kernel ReviewFacts after review readiness');
}

async function assertSessionDriverLoopStaleRequirementDecisionNoopsAfterReviewAccept(): Promise<void> {
  const events: AgentEvent[] = [
    ...turnAuthorityFixture(
      'session-stale-interaction',
      'run-current-review',
      'Create a generic batch and handle only its current review.',
      'stale-interaction'
    ),
    {
      id: 'old-requirement-generic',
      sessionId: 'session-stale-interaction',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'requirement_confirmation',
      payload: {
        title: 'Requirement confirmation',
        summary: 'Confirm an earlier generic requirement.',
        content: 'Create a generic workspace change.',
        originalRequest: 'Create a generic workspace change.',
        runId: 'run-stale-requirement',
        requirementId: 'requirement-stale-generic',
        status: 'waitingUserConfirmation',
        confirmable: true,
      },
    },
    {
      id: 'new-review-generic',
      sessionId: 'session-stale-interaction',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'review_summary',
      payload: {
        status: 'waitingUserReview',
        runId: 'run-current-review',
        reviewId: 'review-current-generic',
        sourcePlanId: 'plan-current-generic',
        content: '## Review\n\nThe current generic batch is ready for review.',
        userPlan: '# Plan\n\n## Summary\nReview the current generic batch.',
        facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
        continuations: [{
          id: 'next-generic-batch',
          title: 'Record a later generic continuation.',
          capability: 'fs.write',
          kind: 'write',
          resourceScope: ['generic-follow-up.txt'],
        }],
        confirmable: true,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-stale-interaction',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-stale-interaction', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const accepted = await loop.resolveDecision({
    sessionId: 'session-stale-interaction',
    kind: 'review',
    decision: 'accept',
    runId: 'run-current-review',
    existingEvents: events,
    reviewContinuationMode: 'off',
  });
  assertEqual(accepted.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted'), true, 'current review is accepted');

  const stale = await loop.resolveDecision({
    sessionId: 'session-stale-interaction',
    kind: 'requirement',
    decision: 'accept',
    runId: 'run-stale-requirement',
    targetId: 'requirement-stale-generic',
    existingEvents: accepted.events,
  });

  assertEqual(stale.events.some((event) => event.kind === 'trace/requirement_decision_noop'), true, 'stale requirement decision is recorded as noop');
  assertEqual(llmRequests.length, 0, 'stale requirement decision does not call the provider');
  assertEqual(submittedPlans.length, 0, 'stale requirement decision does not submit a plan');
}

async function assertSessionDriverLoopNativeReadToolStreamsThroughResourceResolve(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-native-read',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native read smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      if (streamRequests.length === 1) {
        const chunks: LlmChatResult['chunks'] = [
          {
            type: 'tool_call',
            index: 0,
            callId: 'call-generic-read',
            toolCallDelta: { id: 'call-generic-read', index: 0, name: 'fs.read', argumentsDelta: '{"path":"' },
          },
          {
            type: 'tool_call',
            index: 0,
            callId: 'call-generic-read',
            toolCallDelta: { index: 0, argumentsDelta: 'generic-input.txt"}' },
          },
          { type: 'done' },
        ];
        for (const chunk of chunks.slice(0, 2)) {
          await onEvent({ type: 'provider_tool_call_delta', chunk });
        }
        return {
          ok: true,
          data: {
            chunks,
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call-generic-read',
                name: 'fs.read',
                arguments: { path: 'generic-input.txt' },
              }],
            },
          },
        };
      }
      const toolMessage = request.messages.find((message) => message.role === 'tool');
      assert(Boolean(toolMessage?.content.includes('resolved generic content')), 'provider resume receives Kernel resource tool result');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: {
          format: 'markdown',
          content: 'The generic read result was incorporated after Kernel ResourceResolve.',
        },
      });
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read',
    content: 'Use a native read tool only if resource context is needed.',
  });

  assertEqual(streamRequests.length, 2, 'native read tool triggers provider resume after Kernel result');
  assertEqual(resourceResolveManifests.length >= 1, true, 'native read tool is routed through Kernel ResourceResolve');
  assertEqual(
    resourceResolveManifests.some((manifest) =>
      (manifest.entries ?? []).some((entry: Record<string, unknown>) => String(entry.resourceRef ?? '').endsWith('generic-input.txt'))
    ),
    true,
    'native read manifest carries the requested resource'
  );
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'Kernel ResourcePacket is committed as tool_result');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'final'), true, 'provider resume produces one final answer');
  assertEqual(deltas.some((delta) => (delta as any).type === 'tool_call_delta'), true, 'streaming native tool deltas are exposed as active projection deltas');
  assertEqual(
    deltas.some((delta) => (delta as any).activity?.kind === 'toolExecution'),
    true,
    'active projection deltas carry public conversation activity metadata'
  );
}

async function assertSessionDriverLoopNativeReadToolStreamFailureFallsBackToNonStreaming(): Promise<void> {
  const token = randomSmokeToken('native-stream-fallback');
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const fallbackRequests: LlmChatRequest[] = [];
  const session: AgentSession = {
    id: `session-${token}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const requestedPath = `${token}.txt`;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      fallbackRequests.push(request);
      const toolMessage = request.messages.find((message) => message.role === 'tool');
      assert(Boolean(toolMessage?.content.includes('resolved generic content')), 'non-stream fallback receives Kernel resource tool result');
      assertEqual(request.stream, false, 'non-stream fallback disables streaming on the retry request');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: {
          format: 'markdown',
          content: `The fallback incorporated ${token} after Kernel ResourceResolve.`,
        },
      });
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      if (streamRequests.length === 1) {
        const chunks: LlmChatResult['chunks'] = [
          {
            type: 'tool_call',
            index: 0,
            callId: `call-${token}`,
            toolCallDelta: { id: `call-${token}`, index: 0, name: 'fs.read', argumentsDelta: JSON.stringify({ path: requestedPath }) },
          },
          { type: 'done' },
        ];
        await onEvent({ type: 'provider_tool_call_delta', chunk: chunks[0] });
        return {
          ok: true,
          data: {
            chunks,
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: `call-${token}`,
                name: 'fs.read',
                arguments: { path: requestedPath },
              }],
            },
          },
        };
      }
      return {
        ok: false,
        error: 'provider_stream_error',
        message: 'stream transport failed before final proposal',
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + fallbackRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: session.id,
    content: `Read a generic file if needed for ${token}.`,
  });

  assertEqual(streamRequests.length, 2, 'native read tool resume first attempts streaming provider call');
  assertEqual(fallbackRequests.length, 1, 'streaming provider failure falls back to one non-stream request');
  assertEqual(resourceResolveManifests.length >= 1, true, 'fallback path still routes native read through Kernel ResourceResolve');
  assertEqual(
    result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'final'),
    true,
    'non-stream fallback response commits final answer'
  );
}

async function assertSessionDriverLoopNativeReadToolLoopHasNoFourRoundLimit(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-native-read-unbounded',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native read unbounded smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      const round = streamRequests.length;
      if (round <= 6) {
        const path = `generic-input-${round}.txt`;
        const chunk: LlmChatResult['chunks'][number] = {
          type: 'tool_call',
          index: 0,
          callId: `call-generic-read-${round}`,
          toolCallDelta: {
            id: `call-generic-read-${round}`,
            index: 0,
            name: 'fs.read',
            argumentsDelta: JSON.stringify({ path }),
          },
        };
        await onEvent({ type: 'provider_tool_call_delta', chunk });
        return {
          ok: true,
          data: {
            chunks: [chunk, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: `call-generic-read-${round}`,
                name: 'fs.read',
                arguments: { path },
              }],
            },
          },
        };
      }
      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      assertEqual(toolMessages.length >= 6, true, 'provider resume receives all prior Kernel resource tool results');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'answer',
        outputLanguage: 'zh-CN',
        answer: {
          format: 'markdown',
          content: '已在多轮只读资源读取后收口。',
        },
      });
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read-unbounded',
    content: '分析这个项目，需要连续读取多个只读文件后再回答。',
  });

  assertEqual(streamRequests.length, 7, 'native read tool loop continues past the former four-resume limit and then converges');
  assertEqual(resourceResolveManifests.length >= 6, true, 'each native read tool request is routed through Kernel ResourceResolve');
  assertEqual(result.events.some((event) => event.id.includes('native_tool_loop_exhausted')), false, 'native read tool loop does not emit the former exhaustion diagnostic');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.source === 'session' &&
      String((event.payload as any)?.content ?? '').includes('原生工具')
    ),
    false,
    'native tool progress metadata does not become Session-authored conversation narration'
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).summary === 'native_tool_checkpoint' &&
      Number((delta as any).payload?.nativeToolRound ?? -1) >= 4
    ),
    true,
    'high-round native tool checkpoints are exposed as task/debug projection metadata'
  );
  assertEqual(deltas.some((delta) => (delta as any).type === 'tool_call_delta'), true, 'high-round native tool deltas remain visible');
}

async function assertSessionDriverLoopNativeReadToolDuplicateLoopRepairsToProposal(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const session: AgentSession = {
    id: 'session-native-read-duplicate',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native duplicate read smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      if (request.tools?.length) {
        const callId = `call-duplicate-read-${streamRequests.length}`;
        const chunk: LlmChatResult['chunks'][number] = {
          type: 'tool_call',
          index: 0,
          callId,
          toolCallDelta: {
            id: callId,
            index: 0,
            name: 'fs.read',
            argumentsDelta: JSON.stringify({ path: 'generic-duplicate.txt' }),
          },
        };
        await onEvent({ type: 'provider_tool_call_delta', chunk });
        return {
          ok: true,
          data: {
            chunks: [chunk, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: streamRequests.length > 1 ? 'I already have the file and should answer now.' : '',
              toolCalls: [{
                id: callId,
                name: 'fs.read',
                arguments: { path: 'generic-duplicate.txt' },
              }],
            },
          },
        };
      }
      assertEqual(request.tools?.length ?? 0, 0, 'duplicate read repair disables provider-native tools');
      const duplicateRepairPrompt = request.messages.some((message) =>
        message.role === 'user' && String(message.content).includes('Duplicate native read targets')
      );
      if (!duplicateRepairPrompt) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v4',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: {
            format: 'markdown',
            content: 'The repeated read was stopped and the existing resource facts were used.',
          },
        });
      }
      assert(duplicateRepairPrompt, 'duplicate read repair prompt includes duplicate target facts');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v4',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: {
          format: 'markdown',
          content: 'The repeated read was stopped and the existing resource facts were used.',
        },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read-duplicate',
    content: 'Read a generic file if needed, then answer.',
  });

  const nativeResourceResolveManifests = resourceResolveManifests.filter((manifest) =>
    Array.isArray(manifest.entries) && manifest.entries.some((entry: any) => String(entry?.id ?? '').startsWith('native-'))
  );
  assertEqual(nativeResourceResolveManifests.length, 1, 'duplicate native read does not repeatedly call Kernel ResourceResolve');
  assertEqual(streamRequests.length, 2, 'ContextAdmission suppresses a repeated native read after the first ResourceEvidence update');
  assertEqual(
    result.events.some((event) => event.kind === 'assistant_msg' && String((event.payload as any)?.content ?? '').includes('repeated read was stopped')),
    true,
    'duplicate native read repair returns a final answer'
  );
}

async function assertSessionDriverLoopNativeReadToolDuplicateProposalWinsOverToolCall(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const session: AgentSession = {
    id: 'session-native-read-duplicate-proposal',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native duplicate proposal smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      const callId = `call-duplicate-proposal-${streamRequests.length}`;
      const chunk: LlmChatResult['chunks'][number] = {
        type: 'tool_call',
        index: 0,
        callId,
        toolCallDelta: {
          id: callId,
          index: 0,
          name: 'fs.read',
          argumentsDelta: JSON.stringify({ path: 'generic-proposal.txt' }),
        },
      };
      await onEvent({ type: 'provider_tool_call_delta', chunk });
      if (streamRequests.length === 1) {
        return {
          ok: true,
          data: {
            chunks: [chunk, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: callId,
                name: 'fs.read',
                arguments: { path: 'generic-proposal.txt' },
              }],
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          chunks: [chunk, { type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v4',
              kind: 'answer',
              outputLanguage: 'en-US',
              answer: {
                format: 'markdown',
                content: 'The proposal content is accepted even when a duplicate read tool call is present.',
              },
            }),
            toolCalls: [{
              id: callId,
              name: 'fs.read',
              arguments: { path: 'generic-proposal.txt' },
            }],
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read-duplicate-proposal',
    content: 'Read a generic file if needed, then answer.',
  });

  const nativeResourceResolveManifests = resourceResolveManifests.filter((manifest) =>
    Array.isArray(manifest.entries) && manifest.entries.some((entry: any) => String(entry?.id ?? '').startsWith('native-'))
  );
  assertEqual(nativeResourceResolveManifests.length, 1, 'duplicate proposal path does not call Kernel ResourceResolve twice');
  assertEqual(streamRequests.length, 2, 'valid proposal content stops native tool resume despite duplicate tool call');
  assertEqual(
    result.events.some((event) => event.kind === 'assistant_msg' && String((event.payload as any)?.content ?? '').includes('proposal content is accepted')),
    true,
    'valid proposal content wins over duplicate native read tool call'
  );
}

async function assertSessionDriverLoopNativeWriteToolTriggersTaskPlanRepair(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  let repairCalls = 0;
  const session: AgentSession = {
    id: 'session-native-write',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-native-write', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native write smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      if (!request.tools?.length) {
        repairCalls += 1;
        return jsonLlmResponse(genericTaskPlanProposal());
      }
      const chunk: LlmChatResult['chunks'][number] = {
        type: 'tool_call',
        index: 0,
        callId: 'call-generic-write',
        toolCallDelta: {
          id: 'call-generic-write',
          index: 0,
          name: 'fs.write',
          argumentsDelta: '{"path":"generic-output.txt","content":"generic content"}',
        },
      };
      await onEvent({ type: 'provider_tool_call_delta', chunk });
      return {
        ok: true,
        data: {
          chunks: [chunk, { type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'call-generic-write',
              name: 'fs.write',
              arguments: { path: 'generic-output.txt', content: 'generic content' },
            }],
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + streamRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-write',
    content: '请把 native write 只作为需要审查的计划。',
  });

  assertEqual(streamRequests.length, 2, 'native write is followed by one streaming protocol repair');
  assertEqual(repairCalls, 1, 'native write side effect triggers one protocol repair');
  assertEqual(submittedPlans.length, 0, 'native write repair does not submit executable work before taskPlan acceptance');
  const planCard = result.events.find((event) => event.kind === 'plan_card');
  const payload = planCard?.payload as any;
  assertEqual(Boolean(payload?.taskPlan), true, 'native write repair produces a taskPlan card');
  assertEqual(Array.isArray(payload?.contentBlocks) && payload.contentBlocks.length === 0, true, 'taskPlan repair does not carry contentBlocks');
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), false, 'native write is not executed as an immediate tool result');
}

async function assertSessionDriverLoopAcceptedPlanNativeWriteToolUsesProposalOnlyRepair(): Promise<void> {
  const events = [acceptedTaskPlanCardEvent('session-accepted-plan-native-write-tool', 'run-accepted-plan-native-write-tool')];
  const deltas: unknown[] = [];
  const streamRequests: LlmChatRequest[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-native-write-tool',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-native-write-tool-repair',
              output: { path: 'generic-output.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('accepted-plan native tool violation smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      assertEqual(Boolean(request.tools?.length), false, 'accepted-plan Complete stage uses proposal-only provider calls');
      if (streamRequests.length === 1) {
        const chunk: LlmChatResult['chunks'][number] = {
          type: 'tool_call',
          index: 0,
          callId: 'call-generic-complete-write',
          toolCallDelta: {
            id: 'call-generic-complete-write',
            index: 0,
            name: 'fs.write',
            argumentsDelta: '{"path":"generic-output.txt","content":"generic content"}',
          },
        };
        await onEvent({ type: 'provider_tool_call_delta', chunk });
        return {
          ok: true,
          data: {
            chunks: [chunk, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call-generic-complete-write',
                name: 'fs.write',
                arguments: { path: 'generic-output.txt', content: 'generic content' },
              }],
            },
          },
        };
      }
      return jsonLlmResponse(singleTargetWriteProposal('generic-output.txt', 'native-tool-violation-repair'));
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + proposalSubmits + actionBatchSubmits + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-native-write-tool',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(streamRequests.length, 2, 'Complete-stage native tool violation is retried once with proposal-only contract');
  assertEqual(proposalSubmits, 1, 'proposal-only repair returns an actionBundle for Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'proposal-only repair reaches Kernel execution path');
  assertEqual(
    deltas.some((delta) => (delta as any).stage === 'accepted_plan.provider_tool_violation'),
    true,
    'Complete-stage native tool request is surfaced as a Session violation'
  );
  assertEqual(
    deltas.some((delta) => (delta as any).stage === 'native_tool_side_effect_blocked'),
    false,
    'accepted-plan Complete stage does not use native side-effect tool repair'
  );
}

function assertLegacyRegressionControllerInvocation(): void {
  if (
    process.env.DEEPCODE_TEST_CONTROLLER !== '1' ||
    process.env.DEEPCODE_TEST_SUITE_ID !== 'session.legacy-regression'
  ) {
    throw new Error(
      'Legacy Session regression is internal; use bash ./test.sh --profile regression.'
    );
  }
}

main().catch((error) => {
  console.error(error);
  throw error;
});
