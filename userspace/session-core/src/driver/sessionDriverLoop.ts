import type {
  AgentEvent,
  AgentSessionResult,
} from '@deepcode/protocol';
import {
  AcceptedActionBundlePlanExecutor,
  AcceptedPlanActionProposalSubmitter,
  AcceptedPlanExecutionRootResolver,
  AcceptedPlanScopeDecisionCoordinator,
  AcceptedPlanReadOnlyTaskExecutor,
  ReviewFactsAggregator,
  assertKernelReplyOk as assertExecutionKernelReplyOk,
  type AcceptedImplementationPlanContext,
  type AcceptedPlanBatchValidationResult,
  type CurrentTaskContext,
  type TaskExecutionCursor,
} from './execution/index.js';
import type { ProposalEnvelope } from '../protocol/types.js';
import type { ResourcePacket } from '../context/types.js';
import {
  assembleContext,
  buildSessionMemoryDocument,
  collectUserGuidanceEvents,
} from '../context/index.js';
import type { PromptEnvelope } from '../prompt/types.js';
import {
  NativeToolCoordinatorError,
  NativeToolHandlerPortsFactory,
  NativeToolProviderCoordinator,
  ProviderProposalCoordinator,
  ProviderStreamRuntime,
  ProviderTurnRunner,
  ProviderToolCallBuffer,
} from './pipelines/providerPipeline.js';
import type { InteractionOverlayContext } from './pipelines/interactionOverlayCodec.js';
import { RunLifecyclePipeline } from './pipelines/lifecyclePipeline.js';
import { ProviderRuntimeBridge } from './pipelines/providerRuntimeBridge.js';
import { ProviderTurnCycle } from './pipelines/providerTurnCycle.js';
import {
  ProviderTurnContextCoordinator,
  ResourceOrchestrator,
  ResourceRequestProposalHandler,
} from './context/index.js';
import {
  AcceptedPlanReviewHandoffCoordinator,
  AcceptedPlanStaticSyntaxReviewCoordinator,
  type AcceptedPlanReviewHandoffRunInput,
} from './review/index.js';
import { DecisionResolver, PermissionDecisionHandler, PlanDecisionHandler, ProviderDecisionRequestHandler, RequirementConfirmationCoordinator, RequirementDecisionHandler, ReviewDecisionHandler, TerminalGuidanceRevisionCoordinator } from './interactions/index.js';
import {
  ActionProposalSubmitter,
  ProviderPlanProposalHandler,
  ProviderTerminalProposalHandler,
  ProposalRouteExecutor,
  ProposalRouter,
  type PlanContext as SessionPlanContext,
} from './proposal/index.js';
import type { LlmTurnResult, SessionDriverLoopRunState } from './runFrame.js';
import { ProviderProfileRegistry } from '../provider/ProviderProfileRegistry.js';
import { SessionSemanticToolAdapter } from '../provider/SessionSemanticToolAdapter.js';
import { RunEngine } from './runEngine.js';
import { diag, isEmptyResponseError, objectRecord, SessionDriverLoopError, stringValue, visibleLanguageForRequest } from './runtimeSupport.js';
import { AgentRunReactor } from './agentRunReactor.js';
import {
  acceptedImplementationPlanContextBuilder,
  acceptedPlanAdmission,
  acceptedPlanBatchPreflight,
  acceptedPlanExecutor,
  acceptedPlanScopeDecisionOverlay,
  acceptedPlanTaskLedger,
  assistantProjectionBuilder,
  contextFrameBuilder,
  driverActivityBuilder,
  driverFailureMessageCatalog,
  driverInteractionIndex,
  executionPromptCoordinator,
  generatedArtifactEvidenceIndex,
  hookRuntime,
  implementationBatchContextBuilder,
  interactionOverlayCodec,
  kernelEventProjectionBuilder,
  kernelEventStatusIndex,
  nativeToolCoordinator,
  nativeToolExposurePolicy,
  nativeToolProgressEventBuilder,
  nativeToolProviderLoop,
  nativeToolProjectionBuilder,
  permissionPipeline,
  planContextIndex,
  planProjectionBuilder,
  planReviewGrantProjector,
  planReviewReportAnalyzer,
  protocolGate,
  providerContextSupport,
  providerJsonModeCoordinator,
  providerStreamCoordinator,
  providerTraceRecorder,
  providerTurnPolicy,
  repairLoop,
  requirementProjectionBuilder,
  resourceManifestBuilder,
  resourceRequestLoop,
  resourceRequestResolver,
  reviewAssembler,
  reviewDecisionProjection,
  reviewProjectionBuilder,
  sessionFailureProjectionBuilder,
  sessionProgressProjectionBuilder,
  userGuidanceQueue,
  userInputPipeline,
  PROVIDER_REASONING_FLUSH_CHARS,
  PROVIDER_REASONING_FLUSH_MS,
  VISIBLE_REASONING_MAX_CHARS,
} from './sessionDriverComponents.js';
import type {
  SessionDecisionResolverInput,
  SessionDriverLoopInput,
  SessionDriverLoopPorts,
} from './types.js';

export type {
  InterventionLevel,
  RequirementConfirmationMode,
  ReviewContinuationMode,
  SessionDecisionResolverInput,
  SessionDriverLoopInput,
  SessionDriverLoopPorts,
} from './types.js';
export { SessionDriverLoopError } from './runtimeSupport.js';

export class SessionDriverLoop {
  private readonly providerProfileRegistry = new ProviderProfileRegistry();
  private readonly semanticToolAdapter = new SessionSemanticToolAdapter(this.providerProfileRegistry);
  private readonly agentRunReactor: AgentRunReactor<SessionDriverLoopRunState>;
  private readonly acceptedActionBundlePlanExecutor: AcceptedActionBundlePlanExecutor;
  private readonly acceptedPlanActionProposalSubmitter: AcceptedPlanActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly acceptedPlanReadOnlyTaskExecutor: AcceptedPlanReadOnlyTaskExecutor<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly acceptedPlanScopeDecisionCoordinator: AcceptedPlanScopeDecisionCoordinator<SessionDriverLoopRunState>;
  private readonly acceptedPlanReviewHandoffCoordinator: AcceptedPlanReviewHandoffCoordinator<SessionPlanContext>;
  private readonly acceptedPlanStaticSyntaxReviewCoordinator: AcceptedPlanStaticSyntaxReviewCoordinator<SessionDriverLoopRunState>;
  private readonly decisionResolver: DecisionResolver;
  private readonly permissionDecisionHandler: PermissionDecisionHandler<SessionPlanContext>;
  private readonly planDecisionHandler: PlanDecisionHandler;
  private readonly providerDecisionRequestHandler: ProviderDecisionRequestHandler<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly providerPlanProposalHandler: ProviderPlanProposalHandler<SessionDriverLoopRunState>;
  private readonly providerTerminalProposalHandler: ProviderTerminalProposalHandler<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly proposalRouter: ProposalRouter;
  private readonly proposalRouteExecutor: ProposalRouteExecutor<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly requirementConfirmationCoordinator: RequirementConfirmationCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly requirementDecisionHandler: RequirementDecisionHandler;
  private readonly reviewDecisionHandler: ReviewDecisionHandler;
  private readonly terminalGuidanceRevisionCoordinator: TerminalGuidanceRevisionCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly actionProposalSubmitter: ActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly resourceOrchestrator: ResourceOrchestrator<SessionDriverLoopRunState>;
  private readonly resourceRequestProposalHandler: ResourceRequestProposalHandler<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly nativeToolHandlerPortsFactory: NativeToolHandlerPortsFactory<SessionDriverLoopRunState, PromptEnvelope, LlmTurnResult>;
  private readonly nativeToolProviderCoordinator: NativeToolProviderCoordinator<SessionDriverLoopRunState, LlmTurnResult>;
  private readonly providerStreamRuntime: ProviderStreamRuntime<SessionDriverLoopRunState>;
  private readonly providerProposalCoordinator: ProviderProposalCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly providerRuntimeBridge: ProviderRuntimeBridge<SessionDriverLoopRunState, LlmTurnResult>;
  private readonly providerTurnContextCoordinator: ProviderTurnContextCoordinator<SessionDriverLoopRunState>;
  private readonly providerTurnCycle: ProviderTurnCycle<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly runEngine: RunEngine<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly runLifecyclePipeline: RunLifecyclePipeline<SessionDriverLoopRunState>;
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
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      kernel: (request) => this.agentRunReactor.kernel(request),
      observeKernel: async (request) => kernelEventStatusIndex.observe(await this.ports.kernelCommand(request)),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
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
      planProposal: (plan) => planContextIndex.proposalEnvelope(plan),
      recordKernelBatchProgress: (input) => acceptedPlanTaskLedger().recordKernelBatchProgress(input),
      runtimeSnapshot: (input) => acceptedPlanTaskLedger().runtimeSnapshot(input),
      acceptedPlanComplete: (accepted) => acceptedPlanTaskLedger().complete(accepted),
      executionRequest: (plan, acceptedPlan) => executionPromptCoordinator().executionRequest(plan, acceptedPlan),
    });
    this.acceptedPlanReadOnlyTaskExecutor = new AcceptedPlanReadOnlyTaskExecutor<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
      refreshRuntimeState: (state) => acceptedPlanTaskLedger().refreshRuntimeState(state),
      readOnlyResourceCompletion: (accepted, cursor, current, packet) =>
        acceptedPlanExecutor.readOnlyResourceCompletion(
          accepted,
          cursor as TaskExecutionCursor | undefined,
          current as CurrentTaskContext | undefined,
          packet
        ),
      recordTaskCompletion: (completionInput) => acceptedPlanTaskLedger().recordTaskCompletion(completionInput),
      complete: (accepted) => acceptedPlanTaskLedger().complete(accepted),
      resourceValidationCheckpointEvent: (sessionId, runId, accepted, packet, completion, ts, id, contextCompactRecord) =>
        sessionProgressProjectionBuilder.acceptedPlanResourceValidationCheckpointEvent(
          sessionId,
          runId,
          accepted,
          packet,
          completion,
          ts,
          id,
          contextCompactRecord
        ),
      executionRequest: (plan, acceptedPlan) =>
        executionPromptCoordinator().executionRequest(
          plan as unknown as Parameters<ReturnType<typeof executionPromptCoordinator>['executionRequest']>[0],
          acceptedPlan
        ),
      readOnlyReviewContext: (reviewInput) => acceptedPlanExecutor.readOnlyReviewContext(reviewInput),
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
    });
    this.acceptedPlanActionProposalSubmitter = new AcceptedPlanActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      kernel: (request) => this.agentRunReactor.kernel(request),
      observeKernel: async (request) => kernelEventStatusIndex.observe(await this.ports.kernelCommand(request)),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
      emitKernelActivityDeltas: (state, events, stage) => this.agentRunReactor.emitKernelActivityDeltas(state, events, stage),
      readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
      tryCompleteReadOnlyActionBundle: (handlerInput, state, prompt, proposal, fallback) =>
        this.acceptedPlanReadOnlyTaskExecutor.tryCompleteActionBundle(handlerInput, state, prompt, proposal, fallback),
      assessActionProposal: (assessmentInput) => acceptedPlanExecutor.assessActionProposal(assessmentInput as unknown as Parameters<typeof acceptedPlanExecutor.assessActionProposal>[0]),
      admission: () => acceptedPlanAdmission(),
      appendScopeIntervention: (handlerInput, state, proposal, validation) =>
        this.acceptedPlanScopeDecisionCoordinator.waitForOutOfScopeDecision({
          state,
          proposal,
          validation: validation as AcceptedPlanBatchValidationResult,
          request: {
            content: handlerInput.content,
            attachments: handlerInput.attachments ?? [],
          },
          intervention: {
            userRequest: state.userRequest,
            acceptedPlan: state.acceptedImplementationPlan,
            currentTaskId: state.currentTaskContext?.taskId,
          },
        }),
      appendDiagnostic: (state, code, fallback, params, idPrefix) => this.agentRunReactor.append(state.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(
          state.sessionId,
          diag(code, fallback, params),
          this.agentRunReactor.ts(),
          this.agentRunReactor.id(idPrefix)
        ),
      ]),
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
      denied: (report) => planReviewReportAnalyzer.denied(report),
      diagnosticSummary: (report) => planReviewReportAnalyzer.diagnosticSummary(report),
      nonAcceptedPermissionGaps: (report, accepted) =>
        planReviewGrantProjector.nonAcceptedPermissionGaps(report, accepted.capabilities),
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
      recordKernelBatchProgress: (progressInput) => acceptedPlanTaskLedger().recordKernelBatchProgress(progressInput),
      recordModelTaskOutcome: (outcomeInput) => acceptedPlanTaskLedger().recordModelTaskOutcome(outcomeInput),
      refreshRuntimeState: (state) => acceptedPlanTaskLedger().refreshRuntimeState(state),
      complete: (accepted) => acceptedPlanTaskLedger().complete(accepted),
      batchCheckpointEvent: (sessionId, runId, accepted, proposal, kernelEvents, progress, ts, id, contextCompactRecord) =>
        sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent(
          sessionId,
          runId,
          accepted,
          proposal,
          kernelEvents,
          progress as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent>[5],
          ts,
          id,
          contextCompactRecord
        ),
      taskSavepointEvent: (sessionId, runId, accepted, nextAccepted, progress, kernelEvents, cursor, context, ts, id, contextCompactRecord) =>
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
          id,
          contextCompactRecord
        ),
      executionRequest: (plan, acceptedPlan) => executionPromptCoordinator().executionRequest(plan, acceptedPlan),
      staticSyntaxReview: (reviewInput) => this.acceptedPlanStaticSyntaxReviewCoordinator.run(reviewInput),
    });
    this.acceptedPlanScopeDecisionCoordinator = new AcceptedPlanScopeDecisionCoordinator<SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      visibleLanguageForRequest,
      requirementPipeline: userInputPipeline,
      interactionOverlayCodec,
      requirementProjection: requirementProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
    });
    this.acceptedPlanReviewHandoffCoordinator = new AcceptedPlanReviewHandoffCoordinator<SessionPlanContext>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      kernel: (request) => this.agentRunReactor.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      assertKernelReplyOk: (reply, code, fallback) =>
        assertExecutionKernelReplyOk(
          reply,
          (errorCode, message) => new SessionDriverLoopError(errorCode, message),
          code,
          fallback
        ),
      acceptedPlanKernelEvents: ReviewFactsAggregator.acceptedPlanKernelEvents,
      reviewProjection: reviewProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
    });
    this.acceptedPlanStaticSyntaxReviewCoordinator = new AcceptedPlanStaticSyntaxReviewCoordinator<SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
      runStaticSyntaxReview: ({ profileId, state, stage, messages }) =>
        this.providerRuntimeBridge.llmTurn(profileId, state, stage, messages, {
          tools: [...this.providerProfileRegistry.profile('review-v1').tools],
        }),
      event: (sessionId, kind, payload) => this.agentRunReactor.event(sessionId, kind, payload),
      reviewAssembler: reviewAssembler(),
      contextFrameBuilder,
    });
    this.permissionDecisionHandler = new PermissionDecisionHandler<SessionPlanContext>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      observeKernel: async (request) => kernelEventStatusIndex.observe(await this.ports.kernelCommand(request)),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      permissionPipeline,
      kernelStatus: kernelEventStatusIndex,
      planIndex: planContextIndex,
      progressProjection: sessionProgressProjectionBuilder,
    });
    this.planDecisionHandler = new PlanDecisionHandler({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      executeAcceptedActionBundlePlan: (handlerInput, plan, initialResult, acceptedOverlay) =>
        this.acceptedActionBundlePlanExecutor.execute(handlerInput, plan, initialResult, acceptedOverlay),
      activeDriverInteraction: (events) => driverInteractionIndex.active(events),
      executionRootFromDecision: (handlerInput, events) =>
        AcceptedPlanExecutionRootResolver.fromDecision(handlerInput, events),
      buildAcceptedImplementationPlan: ({ plan, interventionLevel, executionRoot }) =>
        acceptedImplementationPlanContextBuilder().build({ plan, interventionLevel, executionRoot }),
      recoverAcceptedPlanFromOverlay: (handlerInput, events, overlay) =>
        driverInteractionIndex.recoverAcceptedPlanFromOverlay(handlerInput, events, overlay),
      planRevisionRequest: (request) => repairLoop.planRevisionRequest(request),
      executionRequest: (plan, acceptedPlan, guidance) => executionPromptCoordinator().executionRequest(plan, acceptedPlan, guidance),
      planIndex: planContextIndex,
      planProjection: planProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
    });
    this.requirementDecisionHandler = new RequirementDecisionHandler({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      activeDriverInteraction: (events) => driverInteractionIndex.active(events),
      executionRootFromDecision: (handlerInput, events) =>
        AcceptedPlanExecutionRootResolver.fromDecision(handlerInput, events),
      buildAcceptedImplementationPlan: ({ plan, interventionLevel, executionRoot }) =>
        acceptedImplementationPlanContextBuilder().build({ plan, interventionLevel, executionRoot }),
      recoverAcceptedPlanFromOverlay: (handlerInput, events, overlay) =>
        driverInteractionIndex.recoverAcceptedPlanFromOverlay(handlerInput, events, overlay),
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
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      kernel: (request) => this.agentRunReactor.kernel(request),
      kernelAudit: (request) => this.ports.kernelCommand(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      reviewAssembler: reviewAssembler(),
      reviewDecisionProjection: reviewDecisionProjection(),
      kernelStatus: kernelEventStatusIndex,
      progressProjection: sessionProgressProjectionBuilder,
    });
    this.decisionResolver = new DecisionResolver({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      finalDiagnosticEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(sessionId, content, ts, id),
      missingDecisionKindMessage: (kind) =>
        diag('decisionResolverMissing', `Decision kind "${kind}" is not yet connected to Session DecisionResolver.`, { kind }),
      resume: (resumeInput) => this.resumeRun(resumeInput),
      assembleReview: (reviewInput) => this.acceptedPlanReviewHandoffCoordinator.handoff(
        reviewInput as AcceptedPlanReviewHandoffRunInput<SessionPlanContext>
      ),
      requirementHandler: this.requirementDecisionHandler,
      planHandler: this.planDecisionHandler,
      permissionHandler: this.permissionDecisionHandler,
      reviewHandler: this.reviewDecisionHandler,
    });
    this.providerDecisionRequestHandler = new ProviderDecisionRequestHandler<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      requirementRecordFromProposal: (proposalInput) =>
        userInputPipeline.requirementRecordFromProposal(proposalInput),
      confirmationEvent: (confirmationInput) =>
        requirementProjectionBuilder.confirmationEvent(confirmationInput),
      interactionOverlayPayload: (overlay) => interactionOverlayCodec.toPayload(overlay),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
    });
    this.providerPlanProposalHandler = new ProviderPlanProposalHandler<SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      implementationPlanCardEvent: (planInput) =>
        planProjectionBuilder.implementationPlanCardEvent(planInput),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
    });
    this.providerTerminalProposalHandler = new ProviderTerminalProposalHandler<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      reviseAnswer: (handlerInput, state, proposal) =>
        this.terminalGuidanceRevisionCoordinator.revise(handlerInput, state, proposal),
      answerEvent: (answerSessionId, proposal, ts, id) =>
        assistantProjectionBuilder.answerEvent(answerSessionId, proposal, ts, id),
      finalDiagnosticEvent: (diagnosticSessionId, summary, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(diagnosticSessionId, summary, ts, id),
    });
    this.proposalRouter = new ProposalRouter();
    this.proposalRouteExecutor = new ProposalRouteExecutor<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      proposalNarrationEvent: (narrationSessionId, proposal, ts, id) =>
        assistantProjectionBuilder.proposalNarrationEvent(narrationSessionId, proposal, ts, id),
      handleAnswer: (handlerInput, state, proposal) =>
        this.providerTerminalProposalHandler.handleAnswer(handlerInput, state, proposal),
      handleDecisionRequest: (handlerInput, state, proposal) =>
        this.providerDecisionRequestHandler.handle(handlerInput, state, proposal),
      handleDiagnostic: (state, proposal) =>
        this.providerTerminalProposalHandler.handleDiagnostic(state, proposal),
      handlePlan: (state, proposal) =>
        this.providerPlanProposalHandler.handle(state, proposal),
      handleResourceRequest: (handlerInput) =>
        this.resourceRequestProposalHandler.handle(handlerInput),
      submitActionProposal: (handlerInput, state, prompt, proposal, fallback) =>
        this.actionProposalSubmitter.submit(handlerInput, state, prompt, proposal, fallback),
      submitNonExecutableProposal: (state, proposal, fallback) =>
        this.actionProposalSubmitter.submitNonExecutable(state, proposal, fallback),
    });
    this.requirementConfirmationCoordinator = new RequirementConfirmationCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      assembleContext: (contextInput) => assembleContext(contextInput),
      capabilityCatalogSummary: () => '',
      collectUserGuidanceEvents: (events, runId) => collectUserGuidanceEvents(events, runId),
      buildProviderTurnContract: (contractInput) =>
        contextFrameBuilder.buildSessionProviderTurnContract(contractInput),
      callProviderAndParse: (handlerInput, state, prompt) =>
        this.providerProposalCoordinator.callAndParseRequiredProposal(handlerInput, state, prompt),
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
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
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
      capabilityCatalogSummary: () => '',
      implementationBatchHints: (state) => providerContextSupport.implementationBatchHints(state.implementationBatch),
      appendConsumedGuidanceEvents: (guidanceInput) =>
        userGuidanceQueue.appendConsumed({
          sessionId: guidanceInput.sessionId,
          result: guidanceInput.result,
          consumedIds: guidanceInput.contextAssembly?.consumedUserGuidanceIds ?? [],
          runId: guidanceInput.runId,
          appliedAtProviderStage: guidanceInput.appliedAtProviderStage,
          summary: providerStreamCoordinator.userGuidanceConsumedSummary(
            visibleLanguageForRequest(guidanceInput.userRequest)
          ),
          append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
          now: () => this.agentRunReactor.ts(),
          createId: (prefix) => this.agentRunReactor.id(prefix),
        }),
      runRevision: (revisionInput, state, prompt, contract) =>
        this.providerRuntimeBridge.runWithNativeTools({
          profileId: revisionInput.profileId,
          state,
          prompt,
          contract,
        }),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      contextFrameBuilder,
    });
    this.resourceOrchestrator = new ResourceOrchestrator<SessionDriverLoopRunState>({
      resourceRequestLoop,
      runtime: this.agentRunReactor,
      createError: (code, message) => new SessionDriverLoopError(code, message),
    });
    this.runLifecyclePipeline = new RunLifecyclePipeline<SessionDriverLoopRunState>({
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      kernel: (request) => this.agentRunReactor.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      userMessageEvent: ({ sessionId, content, attachments }) =>
        this.agentRunReactor.event(sessionId, 'user_msg', {
          content,
          attachments,
          channel: 'user',
          visibility: 'conversation',
        }),
      kernelRunAttachments: (input) => resourceManifestBuilder().kernelRunAttachments(input),
      buildManifest: (input, manifestId) => resourceManifestBuilder().build(input, manifestId),
      buildImplementationBatch: (events) => implementationBatchContextBuilder().build(events),
      buildMemoryDocument: (events, options) => buildSessionMemoryDocument(events, options),
      recentResourcePackets: (events) => resourceRequestLoop.recentPackets(events),
      generatedArtifactEvidenceFromPackets: (packets) => generatedArtifactEvidenceIndex().fromPackets(packets),
      initialTaskRuntime: (snapshotInput) => acceptedPlanTaskLedger().runtimeSnapshot(snapshotInput),
      lastSavepointId: (events) => acceptedPlanTaskLedger().lastSavepointId(events),
      implementationBatchHints: (context, acceptedPlan) =>
        providerContextSupport.implementationBatchHints(context, acceptedPlan),
      resolveInitialResources: async (state) => (
        await this.resourceOrchestrator.resolveRecordAndAppend(
          state,
          state.manifest,
          'resource-context'
        )
      ).result,
    });
    this.resourceRequestProposalHandler = new ResourceRequestProposalHandler<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      generatedPacketForRequest: (state, request, packetId) =>
        generatedArtifactEvidenceIndex().packetForRequest(state, request, packetId),
      recordAndAppend: (state, packet, eventIdPrefix) =>
        this.resourceOrchestrator.recordAndAppend(state, packet, eventIdPrefix),
      resolveRecordAndAppend: (state, manifest, eventIdPrefix) =>
        this.resourceOrchestrator.resolveRecordAndAppend(state, manifest, eventIdPrefix),
      resolveResourceRequest: (manifest, request, roots) =>
        resourceRequestResolver().resolve(manifest, request, roots),
      finalDiagnosticEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(sessionId, content, ts, id),
      resourceResolutionDiagnostic: (resolution) => resourceRequestLoop.resolutionDiagnostic(resolution),
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
    });
    this.actionProposalSubmitter = new ActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
      submitAcceptedPlanActionProposal: (handlerInput, state, prompt, proposal, fallback) =>
        this.acceptedPlanActionProposalSubmitter.submit(handlerInput, state, prompt, proposal, fallback),
      finalDiagnosticEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(sessionId, content, ts, id),
      diagnostic: (code, fallback, params) => diag(code, fallback, params),
    });
    this.nativeToolHandlerPortsFactory = new NativeToolHandlerPortsFactory({
      progressEventBuilder: nativeToolProgressEventBuilder,
      projectionBuilder: nativeToolProjectionBuilder,
      event: (sessionId, kind, payload) => this.agentRunReactor.event(sessionId, kind, payload),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
    });
    this.nativeToolProviderCoordinator = new NativeToolProviderCoordinator<SessionDriverLoopRunState, LlmTurnResult>({
      providerLoop: nativeToolProviderLoop,
      handlerPortsFactory: this.nativeToolHandlerPortsFactory,
      providerTools: (state) =>
        nativeToolExposurePolicy.providerTools(
          state,
          [...this.providerProfileRegistry.profileForFrame(state.providerTurnFrame).tools]
        ),
      semanticProposal: (state, toolCall) =>
        this.semanticToolAdapter.proposal(state, toolCall),
      runTurn: (profileId, state, stage, messages, options) =>
        this.providerRuntimeBridge.llmTurn(profileId, state, stage, messages, options),
      isEmptyResponseError,
      semanticDirectiveError: (error) =>
        error instanceof SessionDriverLoopError && error.code === 'native_tool_arguments_invalid'
          ? { code: error.code, message: error.message }
          : undefined,
    });
    this.providerStreamRuntime = new ProviderStreamRuntime<SessionDriverLoopRunState>({
      reasoningFlushChars: PROVIDER_REASONING_FLUSH_CHARS,
      reasoningFlushMs: PROVIDER_REASONING_FLUSH_MS,
      visibleReasoningMaxChars: VISIBLE_REASONING_MAX_CHARS,
      streamCoordinator: providerStreamCoordinator,
      visibleLanguageForRequest,
      providerActivity: (input) => driverActivityBuilder.providerActivity(input),
      conversationActivity: (input) => driverActivityBuilder.conversationActivity(input),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
      kernelCommand: (request) => this.ports.kernelCommand(request),
      createId: (prefix) => this.agentRunReactor.id(prefix),
    });
    this.providerTurnRunner = new ProviderTurnRunner<SessionDriverLoopRunState>({
      jsonModeCoordinator: providerJsonModeCoordinator,
      streamCoordinator: providerStreamCoordinator,
      streamRuntime: this.providerStreamRuntime,
      traceRecorder: providerTraceRecorder,
      visibleLanguageForRequest,
      providerActivity: (input) => driverActivityBuilder.providerActivity(input),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
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
      runHook: (hookInput) => hookRuntime.run(hookInput),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
    });
    this.providerRuntimeBridge = new ProviderRuntimeBridge<SessionDriverLoopRunState, LlmTurnResult>({
      nativeToolProviderCoordinator: this.nativeToolProviderCoordinator,
      providerTurnRunner: this.providerTurnRunner,
    }, {
      ...this.ports,
      consumeGuidanceMessages: async (state, stage) => {
        const current = await this.agentRunReactor.append(state.sessionId, []);
        const language = visibleLanguageForRequest(state.userRequest);
        const resume = userGuidanceQueue.providerResume({
          sessionId: state.sessionId,
          events: current.events,
          runId: state.runId,
          stage,
          summary: providerStreamCoordinator.userGuidanceConsumedSummary(language),
          now: () => this.agentRunReactor.ts(),
          createId: (prefix) => this.agentRunReactor.id(prefix),
        });
        if (resume.events.length) await this.agentRunReactor.append(state.sessionId, resume.events);
        return resume.messages;
      },
      createError: (code, message) => new SessionDriverLoopError(code, message),
    });
    this.providerProposalCoordinator = new ProviderProposalCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>({
      providerResult: (providerInput, state, prompt, contract) =>
        this.providerRuntimeBridge.runWithNativeTools({
          profileId: providerInput.profileId,
          state,
          prompt,
          contract,
        }),
      createError: (code, message) => new SessionDriverLoopError(code, message),
    });
    this.providerTurnContextCoordinator = new ProviderTurnContextCoordinator<SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      assembleContext: (contextInput) => assembleContext(contextInput),
      allowedProposals: (kernelAllowed, state) =>
        providerTurnPolicy.allowedProposals(kernelAllowed, state),
      capabilityCatalogSummary: () => '',
      memoryHints: (state) => [
        ...acceptedPlanTaskLedger().memoryHints(state.currentTaskContext),
        ...providerContextSupport.implementationBatchHints(state.implementationBatch, state.acceptedImplementationPlan),
      ],
      collectUserGuidanceEvents: (events, runId) => collectUserGuidanceEvents(events, runId),
      appendConsumedGuidance: (guidanceInput) =>
        userGuidanceQueue.appendConsumed({
          sessionId: guidanceInput.sessionId,
          result: guidanceInput.result,
          consumedIds: guidanceInput.consumedIds,
          runId: guidanceInput.runId,
          appliedAtProviderStage: guidanceInput.appliedAtProviderStage,
          summary: providerStreamCoordinator.userGuidanceConsumedSummary(
            visibleLanguageForRequest(guidanceInput.userRequest)
          ),
          append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
          now: () => this.agentRunReactor.ts(),
          createId: (prefix) => this.agentRunReactor.id(prefix),
        }),
      buildProviderTurnContract: (contractInput) =>
        contextFrameBuilder.buildSessionProviderTurnContract(contractInput),
      runHook: (hookInput) => hookRuntime.run(hookInput),
    });
    this.providerTurnCycle = new ProviderTurnCycle<SessionDriverLoopInput, SessionDriverLoopRunState>({
      refreshRuntimeState: (state) => acceptedPlanTaskLedger().refreshRuntimeState(state),
      prepareProviderContext: (handlerInput, state, lastResult) =>
        this.providerTurnContextCoordinator.prepare(state, {
          contextAssemblyId: this.agentRunReactor.id('context-assembly'),
          contractId: this.agentRunReactor.id('provider-turn-contract'),
          inputContent: handlerInput.content,
          projectMemoryMode: handlerInput.projectMemoryMode,
          interventionLevel: handlerInput.interventionLevel,
          confirmedRequirement: handlerInput.confirmedRequirement,
          lastResult,
        }),
      callProviderAndParse: (handlerInput, state, prompt) =>
        this.providerProposalCoordinator.callAndParse(handlerInput, state, prompt),
      deterministicProposal: (state) =>
        this.semanticToolAdapter.deterministicCurrentTask(state),
      admitDirective: (proposal) => this.proposalRouter.route(proposal),
      appendDriverFailure: async (state, error) => {
        if (!(error instanceof SessionDriverLoopError)) return null;
        return this.agentRunReactor.append(state.sessionId, [
          assistantProjectionBuilder.finalDiagnosticEvent(
            state.sessionId,
            driverFailureMessageCatalog.driverFailure(error.code, error.message),
            this.agentRunReactor.ts(),
            this.agentRunReactor.id(error.code)
          ),
        ]);
      },
      appendProviderFailure: (state, error) =>
        this.agentRunReactor.append(state.sessionId, [
          assistantProjectionBuilder.finalDiagnosticEvent(
            state.sessionId,
            driverFailureMessageCatalog.providerFailure(error),
            this.agentRunReactor.ts(),
            this.agentRunReactor.id('provider_call_failed')
          ),
        ]),
    });
    this.runEngine = new RunEngine<SessionDriverLoopInput, SessionDriverLoopRunState>({
      initialize: (runInput) => this.runLifecyclePipeline.initialize(runInput),
      resume: (runInput) => this.runLifecyclePipeline.resume(runInput),
      shouldBuildRequirementConfirmation: (runInput) =>
        this.requirementConfirmationCoordinator.shouldBuild(runInput),
      waitForRequirementDecision: async (runInput, state) => {
        try {
          const event = await this.requirementConfirmationCoordinator.build(runInput, state);
          state.phase = 'waiting_requirement_confirmation';
          const payload = objectRecord(event.payload) ?? {};
          return this.agentRunReactor.append(runInput.sessionId, [
            event,
            sessionProgressProjectionBuilder.sessionRunStateEvent({
              sessionId: runInput.sessionId,
              runId: state.runId,
              phase: 'waiting_requirement_confirmation',
              reason: 'requirement',
              decisionOwner: {
                kind: 'requirement',
                runId: state.runId,
                targetId: stringValue(payload.requirementId),
                requirementId: stringValue(payload.requirementId),
              },
              ts: this.agentRunReactor.ts(),
              id: this.agentRunReactor.id('session-run-waiting-requirement'),
            }),
          ]);
        } catch (error) {
          const message = error instanceof SessionDriverLoopError ? error.message : String(error);
          return this.agentRunReactor.append(runInput.sessionId, [
            assistantProjectionBuilder.finalDiagnosticEvent(
              runInput.sessionId,
              diag('requirementConfirmationFailed', message, { message }),
              this.agentRunReactor.ts(),
              this.agentRunReactor.id('requirement-confirmation-failed')
            ),
          ]);
        }
      },
      runProviderTurn: (cycleInput) => this.providerTurnCycle.run(cycleInput),
      executeDirective: (routerInput) => this.proposalRouteExecutor.execute(routerInput),
      assembleReview: (reviewInput) => this.acceptedPlanReviewHandoffCoordinator.handoff(
        reviewInput as AcceptedPlanReviewHandoffRunInput<SessionPlanContext>
      ),
    });
  }

  async resolveDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    return this.decisionResolver.resolve(input);
  }

  async runUserTurn(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    return this.runLoopInput(input);
  }

  private async resumeRun(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    return this.runLoopInput(input, 'resumeRun');
  }

  private async runLoopInput(
    input: SessionDriverLoopInput,
    mode: 'userTurn' | 'resumeRun' = 'userTurn'
  ): Promise<AgentSessionResult> {
    try {
      return mode === 'resumeRun'
        ? await this.runEngine.resume(input)
        : await this.runEngine.run(input);
    } catch (error) {
      const message = error instanceof SessionDriverLoopError ? error.message : String(error);
      return this.agentRunReactor.append(input.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(
          input.sessionId,
          diag('runEngineFailed', `Session RunEngine failed: ${message}`, { message }),
          this.agentRunReactor.ts(),
          this.agentRunReactor.id('run-engine-failed')
        ),
      ]);
    }
  }
}
