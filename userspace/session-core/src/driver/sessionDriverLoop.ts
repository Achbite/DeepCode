import type {
  AgentEvent,
  AgentSessionResult,
} from '@deepcode/protocol';
import {
  AcceptedActionBundlePlanExecutor,
  AcceptedPlanActionProposalSubmitter,
  AcceptedPlanExecutionRootResolver,
  AcceptedTaskOutcomeCoordinator,
  AcceptedTaskOutcomeError,
  ReviewFactsAggregator,
  assertKernelReplyOk as assertExecutionKernelReplyOk,
  type AcceptedTaskPlanContext,
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
import { takeProviderCommitEvents } from './pipelines/providerCommitBuffer.js';
import {
  ProviderTurnContextCoordinator,
  ResourceOrchestrator,
  ResourceRequestProposalHandler,
  buildResourceDelta,
} from './context/index.js';
import {
  buildUserAuthorityFrame,
  createSessionTurnAuthorityEvent,
  hasLegacySessionTurnAuthority,
  latestExplicitUserContent,
  latestSessionTurnAuthority,
} from './context/userAuthorityFrame.js';
import {
  createSessionLanguageDecisionEvent,
  decideConversationLanguageFromProvider,
  nextConversationLanguageRevision,
  normalizeHostLanguage,
  resolveConversationLanguagePolicy,
} from './context/conversationLanguagePolicy.js';
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
import {
  SessionSemanticDirectiveError,
  SessionSemanticToolAdapter,
  type SessionSemanticDirective,
} from '../provider/SessionSemanticToolAdapter.js';
import { ArtifactDraftCoordinator } from './execution/artifactDraftCoordinator.js';
import { ArtifactDraftError } from './execution/artifactDraftLedger.js';
import { ArtifactDraftReplanCoordinator } from './execution/artifactDraftReplanCoordinator.js';
import type { NativeToolCallProposal } from '../provider/providerStreamParts.js';
import {
  appendPromptLedgerCurrentTurn,
  appendPromptLedgerSemanticExchange,
  promptLedgerWireSemanticExchange,
} from '../prompt/promptLedger.js';
import { RunEngine } from './runEngine.js';
import { diag, isEmptyResponseError, objectRecord, SessionDriverLoopError, stringValue } from './runtimeSupport.js';
import { AgentRunReactor } from './agentRunReactor.js';
import {
  acceptedTaskPlanContextBuilder,
  acceptedPlanBatchPreflight,
  acceptedPlanExecutor,
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
  private readonly artifactDraftCoordinator: ArtifactDraftCoordinator<SessionDriverLoopRunState>;
  private readonly artifactDraftReplanCoordinator: ArtifactDraftReplanCoordinator<SessionDriverLoopRunState>;
  private readonly acceptedTaskOutcomeCoordinator: AcceptedTaskOutcomeCoordinator<SessionDriverLoopRunState>;

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
      kernelExecutionContractHash: (report) => planReviewGrantProjector.kernelExecutionContractHash(report),
      recentResourcePackets: (events) => resourceRequestLoop.recentPackets(events),
      sessionRunStateEvent: (input) => sessionProgressProjectionBuilder.sessionRunStateEvent(input as Parameters<typeof sessionProgressProjectionBuilder.sessionRunStateEvent>[0]),
      acceptedPlanActionBatchPreflightEvent: (sessionId, plan, batch, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanActionBatchPreflightEvent(sessionId, plan, batch, ts, id),
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
      planProposal: (plan) => planContextIndex.proposalEnvelope(plan),
      recordKernelBatchProgress: (input) => acceptedPlanTaskLedger().recordKernelBatchProgress(input),
      runtimeSnapshot: (input) => acceptedPlanTaskLedger().runtimeSnapshot(input),
      acceptedPlanComplete: (accepted) => acceptedPlanTaskLedger().complete(accepted),
      executionRequest: (plan, acceptedPlan) => executionPromptCoordinator().executionRequest(plan, acceptedPlan),
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
      findReviewReport: (events) => planReviewReportAnalyzer.findReport(events),
      appendTrace: (state, stage, payload) => providerTraceRecorder.append(state, stage, payload, this.ports),
      denied: (report) => planReviewReportAnalyzer.denied(report),
      diagnosticSummary: (report) => planReviewReportAnalyzer.diagnosticSummary(report),
      executionContext: (contextInput) => acceptedPlanExecutor.executionContext(contextInput as Parameters<typeof acceptedPlanExecutor.executionContext>[0]),
      normalizeKernelBatch: (normalizeInput) => acceptedPlanExecutor.normalizeKernelBatch(normalizeInput as Parameters<typeof acceptedPlanExecutor.normalizeKernelBatch>[0]),
      normalizationFailureEvents: (sessionId, runId, accepted, reasons, ts, id) =>
        sessionFailureProjectionBuilder.acceptedPlanNormalizationFailureEvents(sessionId, runId, accepted, reasons, ts, id),
      executionExceptionEvents: (sessionId, planRef, message, code, ts, id) =>
        sessionFailureProjectionBuilder.planActionBundleExecutionExceptionEvents(sessionId, planRef, message, code, ts, id),
      executionFailureEvents: (sessionId, runId, accepted, batchEvents, batch, ts, id) =>
        sessionFailureProjectionBuilder.acceptedPlanExecutionFailureEvents(sessionId, runId, accepted, batchEvents, batch, ts, id),
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
      kernel: (request) => this.agentRunReactor.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) =>
        this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      diagnosticEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(sessionId, content, ts, id),
      executeAcceptedActionBundlePlan: (handlerInput, plan, initialResult, acceptedOverlay) =>
        this.acceptedActionBundlePlanExecutor.execute(handlerInput, plan, initialResult, acceptedOverlay),
      activeDriverInteraction: (events) => driverInteractionIndex.active(events),
      executionRootFromDecision: (handlerInput, events) =>
        AcceptedPlanExecutionRootResolver.fromDecision(handlerInput, events),
      buildAcceptedTaskPlan: ({ plan, interventionLevel, executionRoot }) =>
        acceptedTaskPlanContextBuilder().build({ plan, interventionLevel, executionRoot }),
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
      buildAcceptedTaskPlan: ({ plan, interventionLevel, executionRoot }) =>
        acceptedTaskPlanContextBuilder().build({ plan, interventionLevel, executionRoot }),
      recoverAcceptedPlanFromOverlay: (handlerInput, events, overlay) =>
        driverInteractionIndex.recoverAcceptedPlanFromOverlay(handlerInput, events, overlay),
      userInputPipeline,
      interactionOverlayCodec,
      requirementProjection: requirementProjectionBuilder,
      assistantProjection: assistantProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
      planIndex: planContextIndex,
      acceptedPlanLedger: acceptedPlanTaskLedger(),
      executionPrompt: executionPromptCoordinator(),
    });
    this.reviewDecisionHandler = new ReviewDecisionHandler({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      kernel: (request) => this.agentRunReactor.kernel(request),
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
      createError: (code, message) => new SessionDriverLoopError(code, message),
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
      kernel: (request) => this.agentRunReactor.kernel(request),
      projectKernelEvents: (sessionId, reply) =>
        this.agentRunReactor.projectKernelEvents(sessionId, reply),
      taskPlanCardEvent: (planInput) =>
        planProjectionBuilder.taskPlanCardEvent(planInput),
      diagnosticEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.finalDiagnosticEvent(sessionId, content, ts, id),
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
      acceptedTaskDiagnosticFailureEvents: (failureInput) =>
        sessionFailureProjectionBuilder.acceptedTaskDiagnosticFailureEvents(failureInput),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
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
      toolCatalogSummary: (state) => nativeToolCoordinator.toolCatalogSummary(state),
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
      admitQueuedGuidance: async (state, current) => {
        const resume = userGuidanceQueue.providerResume({
          sessionId: state.sessionId,
          events: current.events,
          runId: state.runId,
          taskId: state.userAuthorityFrame.turnAuthority.taskId,
          stage: 'guidance_revision',
          defaultHostLanguage: state.userAuthorityFrame.languagePolicy.hostLanguage,
          promptEpochId: state.providerTurnFrame?.promptLedgerEpochId,
          summary: providerStreamCoordinator.userGuidanceConsumedSummary(
            state.userAuthorityFrame.effectiveLanguage
          ),
          now: () => this.agentRunReactor.ts(),
          createId: (prefix) => this.agentRunReactor.id(prefix),
        });
        if (!resume.events.length) return current;
        const appended = await this.agentRunReactor.append(state.sessionId, resume.events);
        state.userAuthorityFrame = buildUserAuthorityFrame(
          appended.events,
          {
            messageId: state.userAuthorityFrame.rootMessage.messageId,
            content: state.userAuthorityFrame.rootMessage.content,
            timestamp: state.userAuthorityFrame.rootMessage.timestamp,
          },
          state.userAuthorityFrame.autonomyMode,
          { runId: state.runId }
        );
        state.userRequest = latestExplicitUserContent(state.userAuthorityFrame);
        if (state.promptLedger && state.providerTurnFrame?.promptLedgerEpochId) {
          appendPromptLedgerCurrentTurn({
            state: state.promptLedger,
            epochId: state.providerTurnFrame.promptLedgerEpochId,
            authority: state.userAuthorityFrame,
            createId: (prefix) => this.agentRunReactor.id(prefix),
          });
        }
        return appended;
      },
      transitionEvent: (transitionInput) =>
        assistantProjectionBuilder.guidanceRevisionTransitionEvent(
          transitionInput.sessionId,
          transitionInput.runId,
          transitionInput.guidanceIds,
          transitionInput.language,
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
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
      assembleContext: (contextInput) => assembleContext(contextInput),
      toolCatalogSummary: (state) => nativeToolCoordinator.toolCatalogSummary(state),
      implementationBatchHints: (state) => providerContextSupport.implementationBatchHints(state.implementationBatch),
      appendConsumedGuidanceEvents: (guidanceInput) =>
        userGuidanceQueue.appendConsumed({
          sessionId: guidanceInput.sessionId,
          result: guidanceInput.result,
          consumedIds: guidanceInput.contextAssembly?.consumedUserGuidanceIds ?? [],
          runId: guidanceInput.runId,
          appliedAtProviderStage: guidanceInput.appliedAtProviderStage,
          summary: providerStreamCoordinator.userGuidanceConsumedSummary(
            guidanceInput.language
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
      now: () => this.agentRunReactor.ts(),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      kernel: (request) => this.agentRunReactor.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
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
      loadWireLedger: this.ports.loadWireLedger,
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
      internalFailureEvents: (state, stage, code, message, id) =>
        sessionFailureProjectionBuilder.internalFailureEvents({
          sessionId: state.sessionId,
          runId: state.runId,
          stage,
          code,
          message,
          reason: 'driver_failure',
          ts: this.agentRunReactor.ts(),
          id,
        }),
      resourceResolutionDiagnostic: (resolution) => resourceRequestLoop.resolutionDiagnostic(resolution),
      completeResourceSemanticExchange: async (state, proposal, packets, issues = []) => {
        const toolCall = state.pendingSemanticToolCalls?.[proposal.proposalId];
        if (!toolCall) return;
        const request = objectRecord(proposal.payload);
        const delta = buildResourceDelta({
          requestId: stringValue(request?.id) ?? proposal.proposalId,
          workspaceScopeKey: state.workspaceScopeKey,
          packets,
          roots: state.conversationRoots,
        });
        if (issues.length) {
          delta.items.push(...issues.map((issue) => ({
            requestItemId: issue.requestItemId,
            status: 'error' as const,
            reason: issue.reason,
          })));
        }
        await this.appendSemanticExchange(state, toolCall, delta);
        delete state.pendingSemanticToolCalls?.[proposal.proposalId];
      },
      refreshTaskRuntimeState: (state) => acceptedPlanTaskLedger().refreshRuntimeState(state),
      acceptedPlanResourceResumeEvent: (state, packet, ts, id) =>
        sessionProgressProjectionBuilder.acceptedPlanResourceResumeEvent(
          state.sessionId,
          state.runId,
          state.acceptedTaskPlan!,
          state.taskExecutionCursor,
          state.currentTaskContext,
          packet,
          ts,
          id
        ),
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
    this.artifactDraftCoordinator = new ArtifactDraftCoordinator<SessionDriverLoopRunState>({
      createId: (prefix) => this.agentRunReactor.id(prefix),
      kernel: (request) => this.agentRunReactor.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) =>
        this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      compileArtifacts: (input) => this.semanticToolAdapter.compileArtifacts(input),
      createError: (code, message) => new SessionDriverLoopError(code, message),
    });
    this.artifactDraftReplanCoordinator = new ArtifactDraftReplanCoordinator<SessionDriverLoopRunState>({
      discard: (state, reason) => this.artifactDraftCoordinator.discard(state, reason),
    });
    this.acceptedTaskOutcomeCoordinator = new AcceptedTaskOutcomeCoordinator<SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      recordModelTaskOutcome: (outcomeInput) => acceptedPlanTaskLedger().recordModelTaskOutcome(outcomeInput),
      refreshRuntimeState: (state) => acceptedPlanTaskLedger().refreshRuntimeState(state),
      complete: (accepted) => acceptedPlanTaskLedger().complete(accepted),
      taskOutcomeCheckpointEvent: (eventInput) =>
        sessionProgressProjectionBuilder.acceptedPlanTaskOutcomeCheckpointEvent(eventInput),
      taskSavepointEvent: (sessionId, runId, accepted, nextAccepted, progress, kernelEvents, cursor, context, ts, id, contextCompactRecord) =>
        sessionProgressProjectionBuilder.acceptedPlanTaskSavepointEvent(
          sessionId,
          runId,
          accepted,
          nextAccepted,
          progress,
          kernelEvents,
          cursor,
          context,
          ts,
          id,
          contextCompactRecord
        ),
    });
    this.nativeToolHandlerPortsFactory = new NativeToolHandlerPortsFactory({
      progressEventBuilder: nativeToolProgressEventBuilder,
      projectionBuilder: nativeToolProjectionBuilder,
      event: (sessionId, kind, payload) => this.agentRunReactor.event(sessionId, kind, payload),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
      recordSemanticExchange: async (state, toolCall, result) => {
        if (result.kind === 'proposal' && result.proposal.kind === 'resourceRequest') {
          state.pendingSemanticToolCalls ??= {};
          state.pendingSemanticToolCalls[result.proposal.proposalId] = toolCall;
          return;
        }
        await this.appendSemanticExchange(state, toolCall, result.toolResult);
      },
    });
    this.nativeToolProviderCoordinator = new NativeToolProviderCoordinator<SessionDriverLoopRunState, LlmTurnResult>({
      providerLoop: nativeToolProviderLoop,
      handlerPortsFactory: this.nativeToolHandlerPortsFactory,
      providerTools: (state) =>
        nativeToolExposurePolicy.providerTools(
          state,
          [...this.providerProfileRegistry.profileForFrame(state.providerTurnFrame).tools]
        ),
      semanticDirective: async (state, toolCall) => {
        const directive: SessionSemanticDirective | null = this.semanticToolAdapter.directive(state, toolCall);
        if (!directive) return null;
        try {
          if (directive.kind === 'taskOutcome') {
            return await this.acceptedTaskOutcomeCoordinator.handle({ state, directive });
          }
          return await this.artifactDraftCoordinator.handle({
            state,
            callId: toolCall.callId,
            directive,
          });
        } catch (error) {
          if (error instanceof SessionSemanticDirectiveError) throw error;
          if (
            error instanceof ArtifactDraftError
            || error instanceof AcceptedTaskOutcomeError
            || error instanceof SessionDriverLoopError
          ) {
            throw new SessionSemanticDirectiveError(
              toolCall.name,
              toolCall.callId,
              toolCall.arguments,
              error
            );
          }
          throw error;
        }
      },
      runTurn: (profileId, state, stage, messages, options) =>
        this.providerRuntimeBridge.llmTurn(profileId, state, stage, messages, options),
      isEmptyResponseError,
      semanticDirectiveError: (error) =>
        error instanceof SessionDriverLoopError && error.code === 'native_tool_arguments_invalid'
          ? { code: error.code, message: error.message }
          : undefined,
      onSemanticDraftFailure: (state, callId, failureCode) =>
        this.providerStreamRuntime.failSemanticDraft(
          state,
          state.activeTurn?.stage ?? 'provider_call',
          callId,
          failureCode
        ),
      onArtifactDraftBudgetExceeded: async (state, error) => {
        const reason = await this.artifactDraftReplanCoordinator.replan(state, error.message);
        const content = state.userAuthorityFrame.effectiveLanguage === 'zh-CN'
          ? '当前任务的产物总量超过 Kernel 草稿预算，Session 已保留审计事实并返回 Plan 阶段重新拆分任务。'
          : 'The current task exceeded the Kernel artifact budget. Session preserved the audit facts and returned to Plan for task-level replanning.';
        await this.agentRunReactor.append(state.sessionId, [
          this.agentRunReactor.event(state.sessionId, 'workflow_stage', {
            stage: 'accepted_plan.replan_required',
            status: 'needsReplan',
            code: reason.code,
            runId: state.runId,
            previousPlanId: reason.previousPlanId,
            previousTaskId: reason.previousTaskId,
            message: reason.message,
            channel: 'progress',
            visibility: 'conversation',
          }),
          assistantProjectionBuilder.thinkingEvent(
            state.sessionId,
            content,
            this.agentRunReactor.ts(),
            this.agentRunReactor.id(reason.code)
          ),
        ]);
      },
      createError: (code, message) => new SessionDriverLoopError(code, message),
    });
    this.providerStreamRuntime = new ProviderStreamRuntime<SessionDriverLoopRunState>({
      reasoningFlushChars: PROVIDER_REASONING_FLUSH_CHARS,
      reasoningFlushMs: PROVIDER_REASONING_FLUSH_MS,
      semanticDraftFlushChars: PROVIDER_REASONING_FLUSH_CHARS,
      semanticDraftFlushMs: PROVIDER_REASONING_FLUSH_MS,
      visibleReasoningMaxChars: VISIBLE_REASONING_MAX_CHARS,
      streamCoordinator: providerStreamCoordinator,
      visibleLanguage: (state) => state.userAuthorityFrame.effectiveLanguage,
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
      visibleLanguage: (state) => state.userAuthorityFrame.effectiveLanguage,
      admitLanguageDecision: async (state, decisionInput) => {
        const policy = state.userAuthorityFrame.languagePolicy;
        if (policy.status !== 'pending') return;
        const decision = decideConversationLanguageFromProvider({
          hostLanguage: policy.hostLanguage,
          content: decisionInput.content,
          toolCalls: decisionInput.toolCalls,
        });
        const appended = await this.agentRunReactor.append(state.sessionId, [
          createSessionLanguageDecisionEvent({
            sessionId: state.sessionId,
            runId: state.runId,
            turnId: state.userAuthorityFrame.turnAuthority.turnId,
            revision: policy.revision,
            status: decision.status,
            responseLanguage: decision.responseLanguage,
            decisionSource: decision.decisionSource,
            sourceProviderRequestId: decisionInput.requestId,
            sourceToolCallId: decision.sourceToolCallId,
            eventId: this.agentRunReactor.id('session-language-decision'),
            timestamp: this.agentRunReactor.ts(),
          }),
        ]);
        state.userAuthorityFrame = buildUserAuthorityFrame(
          appended.events,
          {
            messageId: state.userAuthorityFrame.rootMessage.messageId,
            content: state.userAuthorityFrame.rootMessage.content,
            timestamp: state.userAuthorityFrame.rootMessage.timestamp,
          },
          state.userAuthorityFrame.autonomyMode,
          { runId: state.runId }
        );
        state.userRequest = latestExplicitUserContent(state.userAuthorityFrame);
      },
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
        const language = state.userAuthorityFrame.effectiveLanguage;
        const resume = userGuidanceQueue.providerResume({
          sessionId: state.sessionId,
          events: current.events,
          runId: state.runId,
          taskId: state.userAuthorityFrame.turnAuthority.taskId,
          stage,
          defaultHostLanguage: state.userAuthorityFrame.languagePolicy.hostLanguage,
          promptEpochId: state.providerTurnFrame?.promptLedgerEpochId,
          summary: providerStreamCoordinator.userGuidanceConsumedSummary(language),
          now: () => this.agentRunReactor.ts(),
          createId: (prefix) => this.agentRunReactor.id(prefix),
        });
        if (resume.events.length) {
          const appended = await this.agentRunReactor.append(state.sessionId, resume.events);
          state.userAuthorityFrame = buildUserAuthorityFrame(
            appended.events,
            {
              messageId: state.userAuthorityFrame.rootMessage.messageId,
              content: state.userAuthorityFrame.rootMessage.content,
              timestamp: state.userAuthorityFrame.rootMessage.timestamp,
            },
            state.userAuthorityFrame.autonomyMode,
            { runId: state.runId }
          );
          state.userRequest = latestExplicitUserContent(state.userAuthorityFrame);
          if (state.promptLedger && state.providerTurnFrame?.promptLedgerEpochId) {
            appendPromptLedgerCurrentTurn({
              state: state.promptLedger,
              epochId: state.providerTurnFrame.promptLedgerEpochId,
              authority: state.userAuthorityFrame,
              createId: (prefix) => this.agentRunReactor.id(prefix),
            });
          }
        }
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
      toolCatalogSummary: (state) => nativeToolCoordinator.toolCatalogSummary(state),
      memoryHints: (state) => [
        ...acceptedPlanTaskLedger().memoryHints(state.currentTaskContext),
        ...providerContextSupport.implementationBatchHints(state.implementationBatch, state.acceptedTaskPlan),
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
            guidanceInput.language
          ),
          append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
          now: () => this.agentRunReactor.ts(),
          createId: (prefix) => this.agentRunReactor.id(prefix),
        }),
      buildProviderTurnContract: (contractInput) =>
        contextFrameBuilder.buildSessionProviderTurnContract(contractInput),
      runHook: (hookInput) => hookRuntime.run(hookInput),
      createError: (code, message) => new SessionDriverLoopError(code, message),
    });
    this.providerTurnCycle = new ProviderTurnCycle<SessionDriverLoopInput, SessionDriverLoopRunState>({
      refreshRuntimeState: (state) => acceptedPlanTaskLedger().refreshRuntimeState(state),
      takePendingReview: (state) => {
        const pending = state.pendingAcceptedTaskOutcomeReview;
        const accepted = state.acceptedTaskPlan;
        if (!pending || !accepted) return undefined;
        state.pendingAcceptedTaskOutcomeReview = undefined;
        const plan = acceptedPlanExecutor.modelTaskOutcomeReviewContext({
          sessionId: state.sessionId,
          runId: state.runId,
          acceptedPlan: accepted,
          taskId: pending.taskId,
          summary: pending.summary,
          evidenceRefs: pending.evidenceRefs,
        });
        return {
          sessionId: state.sessionId,
          runId: state.runId,
          planId: accepted.planId,
          plan,
          result: pending.result,
          currentKernelEvents: [],
          requestIdPrefix: 'accepted-plan-task-outcome-review-facts-get',
        };
      },
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
      appendProviderRunningState: (state) => this.agentRunReactor.append(state.sessionId, [
        sessionProgressProjectionBuilder.sessionRunStateEvent({
          sessionId: state.sessionId,
          runId: state.runId,
          phase: 'provider_proposing',
          status: 'running',
          reason: 'session',
          decisionOwner: {
            kind: 'session',
            runId: state.runId,
          },
          ts: this.agentRunReactor.ts(),
          id: this.agentRunReactor.id('session-run-provider-proposing'),
        }),
      ]),
      callProviderAndParse: (handlerInput, state, prompt) =>
        this.providerProposalCoordinator.callAndParse(handlerInput, state, prompt),
      deterministicProposal: (state) =>
        this.semanticToolAdapter.deterministicCurrentTask(state),
      admitDirective: (proposal) => this.proposalRouter.route(proposal),
      appendDriverFailure: async (state, error) => {
        if (!(error instanceof SessionDriverLoopError)) return null;
        await this.artifactDraftCoordinator.discard(
          state,
          `Session stopped the current artifact draft after ${error.code}.`
        ).catch(() => undefined);
        if (error.code === 'session_run_cancelled') {
          takeProviderCommitEvents(state);
          return this.agentRunReactor.append(state.sessionId, [
            sessionProgressProjectionBuilder.sessionRunStateEvent({
              sessionId: state.sessionId,
              runId: state.runId,
              phase: 'cancelled',
              status: 'cancelled',
              reason: 'session',
              decisionOwner: {
                kind: 'session',
                runId: state.runId,
              },
              ts: this.agentRunReactor.ts(),
              id: this.agentRunReactor.id('session-run-cancelled'),
            }),
          ]);
        }
        const diagnostic = driverFailureMessageCatalog.driverFailure(error.code, error.message);
        return this.agentRunReactor.append(state.sessionId, [
          ...takeProviderCommitEvents(state),
          ...sessionFailureProjectionBuilder.internalFailureEvents({
            sessionId: state.sessionId,
            runId: state.runId,
            stage: 'driver',
            code: diagnostic.code,
            message: diagnostic.fallback,
            reason: 'driver_failure',
            ts: this.agentRunReactor.ts(),
            id: this.agentRunReactor.id(error.code),
          }),
        ]);
      },
      appendProviderFailure: async (state, error) => {
        await this.artifactDraftCoordinator.discard(
          state,
          'Session stopped the current artifact draft after a Provider failure.'
        ).catch(() => undefined);
        const diagnostic = driverFailureMessageCatalog.providerFailure(error);
        return this.agentRunReactor.append(state.sessionId, [
          ...takeProviderCommitEvents(state),
          ...sessionFailureProjectionBuilder.internalFailureEvents({
            sessionId: state.sessionId,
            runId: state.runId,
            stage: 'provider',
            code: diagnostic.code,
            message: diagnostic.fallback,
            reason: 'provider_failure',
            ts: this.agentRunReactor.ts(),
            id: this.agentRunReactor.id('provider-call-failed'),
          }),
        ]);
      },
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
          return this.agentRunReactor.append(runInput.sessionId, sessionFailureProjectionBuilder.internalFailureEvents({
            sessionId: runInput.sessionId,
            runId: state.runId,
            stage: 'requirement_confirmation',
            code: 'requirement_confirmation_failed',
            message,
            reason: 'driver_failure',
            ts: this.agentRunReactor.ts(),
            id: this.agentRunReactor.id('requirement-confirmation-failed'),
          }));
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
    try {
      return await this.decisionResolver.resolve(input);
    } catch (error) {
      const message = error instanceof SessionDriverLoopError ? error.message : String(error);
      return this.agentRunReactor.append(input.sessionId, sessionFailureProjectionBuilder.internalFailureEvents({
        sessionId: input.sessionId,
        runId: input.runId ?? latestRunIdForFailure(input.existingEvents ?? []) ?? 'run-unavailable',
        stage: 'decision_resolver',
        code: error instanceof SessionDriverLoopError ? error.code : 'decision_resolver_failed',
        message: `Session decision resolver failed: ${message}`,
        reason: 'driver_failure',
        ts: this.agentRunReactor.ts(),
        id: this.agentRunReactor.id('decision-resolver-failed'),
      }));
    }
  }

  async runUserTurn(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    return this.runLoopInput(input);
  }

  private async appendSemanticExchange(
    state: SessionDriverLoopRunState,
    toolCall: NativeToolCallProposal,
    result: unknown
  ): Promise<void> {
    const profileId = this.providerProfileRegistry.profileForFrame(state.providerTurnFrame).id;
    const protocolToolCall = {
      id: toolCall.callId,
      name: toolCall.name,
      arguments: toolCall.arguments,
    };
    const epochId = state.providerTurnFrame?.promptLedgerEpochId;
    if (!epochId) {
      if (!state.acceptedTaskPlan) return;
      throw new SessionDriverLoopError(
        'session_task_prompt_epoch_incompatible',
        'Session semantic exchange has no active task-scoped PromptLedger epoch.'
      );
    }
    const epoch = appendPromptLedgerSemanticExchange({
      state: state.promptLedger,
      epochId,
      toolCall: protocolToolCall,
      result,
      createId: (prefix) => this.agentRunReactor.id(prefix),
    });
    if (!epoch || !this.ports.appendWireLedger) return;
    await this.ports.appendWireLedger(state.sessionId, promptLedgerWireSemanticExchange({
      sessionId: state.sessionId,
      runId: state.runId,
      profileId,
      epoch,
      toolCall: protocolToolCall,
      result,
      timestamp: this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
    }));
  }

  private async resumeRun(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    return this.runLoopInput(input, 'resumeRun');
  }

  private async runLoopInput(
    input: SessionDriverLoopInput,
    mode: 'userTurn' | 'resumeRun' = 'userTurn'
  ): Promise<AgentSessionResult> {
    const existingEvents = input.existingEvents ?? [];
    if (hasLegacySessionTurnAuthority(existingEvents) && !latestSessionTurnAuthority(existingEvents)) {
      return this.agentRunReactor.append(input.sessionId, sessionFailureProjectionBuilder.internalFailureEvents({
        sessionId: input.sessionId,
        runId: latestRunIdForFailure(existingEvents) ?? 'run-unavailable',
        stage: 'run_engine',
        code: 'session_language_policy_unavailable',
        message: 'This Session uses turn authority v1 and cannot continue without ConversationLanguagePolicy v1.',
        reason: 'driver_failure',
        ts: this.agentRunReactor.ts(),
        id: this.agentRunReactor.id('session-language-policy-unavailable'),
      }));
    }
    if (
      input.projectId
      && input.projectKind === 'folder'
      && (
        input.projectRootStatus === 'unavailable'
        || !input.workspaceBinding?.openPath
        || !(input.projectWorkingDirectory?.absolutePath ?? input.projectWorkingDirectory?.displayPath)
      )
    ) {
      const userMessage = input.appendUserMessage === false
        ? undefined
        : this.agentRunReactor.event(input.sessionId, 'user_msg', {
          content: input.content,
          attachments: input.attachments ?? [],
          channel: 'user',
          visibility: 'conversation',
        });
      const events = userMessage ? [userMessage] : [];
      if (userMessage) {
        const previousAuthority = latestSessionTurnAuthority(existingEvents);
        if (
          previousAuthority
          && resolveConversationLanguagePolicy(existingEvents, previousAuthority).status === 'pending'
        ) {
          events.push(createSessionLanguageDecisionEvent({
            sessionId: previousAuthority.sessionId,
            runId: previousAuthority.runId,
            turnId: previousAuthority.turnId,
            revision: previousAuthority.languagePolicy.revision,
            status: 'superseded',
            decisionSource: 'supersededByLaterUserInput',
            eventId: this.agentRunReactor.id('session-language-superseded'),
            timestamp: this.agentRunReactor.ts(),
          }));
        }
        events.push(createSessionTurnAuthorityEvent({
          sessionId: input.sessionId,
          runId: this.agentRunReactor.id('project-root-unavailable-run'),
          turnId: this.agentRunReactor.id('session-turn'),
          taskId: this.agentRunReactor.id('session-task'),
          messages: [{ messageId: userMessage.id, content: input.content }],
          relation: 'newTask',
          boundAtHookRef: 'run.projectRootUnavailable',
          languageRevision: nextConversationLanguageRevision(existingEvents),
          hostLanguage: normalizeHostLanguage(input.hostLanguage),
          previousTaskId: previousAuthority?.taskId,
          eventId: this.agentRunReactor.id('session-turn-authority'),
          timestamp: this.agentRunReactor.ts(),
        }));
      }
      events.push(assistantProjectionBuilder.finalDiagnosticEvent(
        input.sessionId,
        {
          code: 'project_root_unavailable',
          fallback: 'The project directory is unavailable. Rebind the project directory before using this project session.',
          params: { projectId: input.projectId },
        },
        this.agentRunReactor.ts(),
        this.agentRunReactor.id('project-root-unavailable')
      ));
      return this.agentRunReactor.append(input.sessionId, events);
    }
    try {
      return mode === 'resumeRun'
        ? await this.runEngine.resume(input)
        : await this.runEngine.run(input);
    } catch (error) {
      const message = error instanceof SessionDriverLoopError ? error.message : String(error);
      const runId = input.existingEvents ? latestRunIdForFailure(input.existingEvents) : undefined;
      return this.agentRunReactor.append(input.sessionId, sessionFailureProjectionBuilder.internalFailureEvents({
        sessionId: input.sessionId,
        runId: runId ?? 'run-unavailable',
        stage: 'run_engine',
        code: error instanceof SessionDriverLoopError ? error.code : 'run_engine_failed',
        message: `Session RunEngine failed: ${message}`,
        reason: 'driver_failure',
        ts: this.agentRunReactor.ts(),
        id: this.agentRunReactor.id('run-engine-failed'),
      }));
    }
  }
}

function latestRunIdForFailure(events: AgentEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    const payload = objectRecord(event.payload);
    const runId = stringValue(payload?.runId);
    if (runId) return runId;
  }
  return undefined;
}
