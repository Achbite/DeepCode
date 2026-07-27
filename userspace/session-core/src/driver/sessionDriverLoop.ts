import type {
  AgentEvent,
  AgentSessionResult,
  ConversationLanguage,
  LlmChatRequest,
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
  effectiveConversationLanguage,
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
import type { ResourcePacketActivityIdentity } from './context/resourceRequestLoop.js';
import {
  providerAnalysisTimelineAckViolation,
  providerSideCallSemanticFailureAnalysisEvent,
  semanticDirectiveAdmissionAnalysisEvent,
  semanticDirectiveTerminalAnalysisEvent,
  semanticExchangeAnalysisEvent,
} from '../provider/ProviderAnalysisTimeline.js';
import {
  appendPromptLedgerCurrentTurn,
  appendPromptLedgerGuidanceBatch,
  appendPromptLedgerSemanticExchange,
  promptLedgerEpoch,
  promptLedgerWireSemanticExchange,
} from '../prompt/promptLedger.js';
import { RunEngine } from './runEngine.js';
import { diag, isEmptyResponseError, objectRecord, SessionDriverLoopError, stringValue } from './runtimeSupport.js';
import { AgentRunReactor } from './agentRunReactor.js';
import {
  bindPendingProviderProposalAdmission,
  SessionFactLineageError,
} from './authority/sessionFactLineage.js';
import { SessionAppendCoordinatorError } from './authority/sessionAppendCoordinator.js';
import { SessionGoalError } from '../goal/index.js';
import {
  conversationPresentationLanguage,
  conversationPresentationLanguageBinding,
  conversationPresentationLanguageBindingFromEvents,
} from './projection/index.js';
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
  PROVIDER_SEMANTIC_DRAFT_FLUSH_CHARS,
  PROVIDER_SEMANTIC_DRAFT_FLUSH_MS,
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
      appendProjectedKernelEvents: (sessionId, reply, language) =>
        this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply, language),
      kernelExecutionContractId: (report) => planReviewGrantProjector.kernelExecutionContractId(report),
      kernelExecutionContractHash: (report) => planReviewGrantProjector.kernelExecutionContractHash(report),
      recentResourcePackets: (events) => resourceRequestLoop.recentPackets(events),
      sessionRunStateEvent: (input) => sessionProgressProjectionBuilder.sessionRunStateEvent(input as Parameters<typeof sessionProgressProjectionBuilder.sessionRunStateEvent>[0]),
      acceptedPlanActionBatchPreflightEvent: (sessionId, plan, batch, ts, id, language) =>
        sessionProgressProjectionBuilder.acceptedPlanActionBatchPreflightEvent(
          sessionId,
          plan,
          batch,
          ts,
          id,
          language
        ),
      planActionBundleExecutionFailureEvents: (sessionId, plan, batchEvents, batch, ts, id, language) =>
        sessionFailureProjectionBuilder.planActionBundleExecutionFailureEvents(
          sessionId,
          plan,
          batchEvents,
          batch,
          ts,
          id,
          language
        ),
      planActionBundleExecutionExceptionEvents: (sessionId, plan, message, code, ts, id, language) =>
        sessionFailureProjectionBuilder.planActionBundleExecutionExceptionEvents(
          sessionId,
          plan,
          message,
          code,
          ts,
          id,
          language
        ),
      acceptedPlanBatchCheckpointEvent: (sessionId, runId, accepted, proposal, kernelEvents, progress, ts, id, language) =>
        sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent(
          sessionId,
          runId,
          accepted,
          proposal as ProposalEnvelope,
          kernelEvents,
          progress as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent>[5],
          ts,
          id,
          undefined,
          language
        ),
      acceptedPlanTaskSavepointEvent: (sessionId, runId, accepted, nextAccepted, progress, kernelEvents, cursor, context, ts, id, language) =>
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
          undefined,
          language
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
      appendProjectedKernelEvents: (sessionId, reply, language) =>
        this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply, language),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
      emitKernelActivityDeltas: (state, events, stage) => this.agentRunReactor.emitKernelActivityDeltas(state, events, stage),
      readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
      appendDiagnostic: (state, code, fallback, params, idPrefix) => this.agentRunReactor.append(state.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(
          state.sessionId,
          diag(code, fallback, params),
          this.agentRunReactor.ts(),
          this.agentRunReactor.id(idPrefix),
          conversationPresentationLanguageBinding(state)
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
      normalizationFailureEvents: (sessionId, runId, accepted, reasons, ts, id, language) =>
        sessionFailureProjectionBuilder.acceptedPlanNormalizationFailureEvents(
          sessionId,
          runId,
          accepted,
          reasons,
          ts,
          id,
          language
        ),
      executionExceptionEvents: (sessionId, planRef, message, code, ts, id, language) =>
        sessionFailureProjectionBuilder.planActionBundleExecutionExceptionEvents(
          sessionId,
          planRef,
          message,
          code,
          ts,
          id,
          language
        ),
      executionFailureEvents: (sessionId, runId, accepted, batchEvents, batch, ts, id, language) =>
        sessionFailureProjectionBuilder.acceptedPlanExecutionFailureEvents(
          sessionId,
          runId,
          accepted,
          batchEvents,
          batch,
          ts,
          id,
          language
        ),
      preflightAudit: (batch) => acceptedPlanBatchPreflight.audit(batch),
      acceptedPlanBatchActivitySummary: (batch, language) =>
        driverActivityBuilder.acceptedPlanBatchActivitySummary(batch, language),
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
      batchCheckpointEvent: (sessionId, runId, accepted, proposal, kernelEvents, progress, ts, id, contextCompactRecord, language) =>
        sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent(
          sessionId,
          runId,
          accepted,
          proposal,
          kernelEvents,
          progress as Parameters<typeof sessionProgressProjectionBuilder.acceptedPlanBatchCheckpointEvent>[5],
          ts,
          id,
          contextCompactRecord,
          language
        ),
      taskSavepointEvent: (sessionId, runId, accepted, nextAccepted, progress, kernelEvents, cursor, context, ts, id, contextCompactRecord, language) =>
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
          contextCompactRecord,
          language
        ),
      executionRequest: (plan, acceptedPlan) => executionPromptCoordinator().executionRequest(plan, acceptedPlan),
      staticSyntaxReview: (reviewInput) => this.acceptedPlanStaticSyntaxReviewCoordinator.run(reviewInput),
    });
    this.acceptedPlanReviewHandoffCoordinator = new AcceptedPlanReviewHandoffCoordinator<SessionPlanContext>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      kernel: (request) => this.agentRunReactor.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply, language) =>
        this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply, language),
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
      createError: (code, message) => new SessionDriverLoopError(code, message),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
      runStaticSyntaxReview: ({ profileId, state, stage, messages, signal }) =>
        this.providerRuntimeBridge.llmTurn(profileId, state, stage, messages, {
          tools: [...this.providerProfileRegistry.profile('review-v1').tools],
        }, {
          abortSignal: signal,
          consumeGuidance: false,
          stream: false,
        }),
      recordStaticSyntaxReviewSemanticExchange: ({
        state,
        turn,
        toolCall,
        result,
        stage,
      }) => this.appendProviderSideCallSemanticExchange(
        state,
        turn,
        toolCall,
        result,
        stage
      ),
      recordStaticSyntaxReviewSemanticFailure: ({
        state,
        turn,
        toolCall,
        error,
        stage,
      }) => this.appendProviderSideCallSemanticFailure(
        state,
        turn,
        toolCall,
        error,
        stage
      ),
      event: (sessionId, kind, payload) => this.agentRunReactor.event(sessionId, kind, payload),
      reviewAssembler: reviewAssembler(),
      contextFrameBuilder,
    });
    this.permissionDecisionHandler = new PermissionDecisionHandler<SessionPlanContext>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      observeKernel: async (request) => kernelEventStatusIndex.observe(await this.ports.kernelCommand(request)),
      appendProjectedKernelEvents: (sessionId, reply, language) =>
        this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply, language),
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
      appendProjectedKernelEvents: (sessionId, reply, language) =>
        this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply, language),
      diagnosticEvent: (sessionId, content, ts, id, presentationBinding) =>
        assistantProjectionBuilder.finalDiagnosticEvent(
          sessionId,
          content,
          ts,
          id,
          presentationBinding
        ),
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
      createError: (code, message) => new SessionDriverLoopError(code, message),
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
      appendProjectedKernelEvents: (sessionId, reply, language) =>
        this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply, language),
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
      finalDiagnosticEvent: (sessionId, content, ts, id, presentationBinding) =>
        assistantProjectionBuilder.finalDiagnosticEvent(
          sessionId,
          content,
          ts,
          id,
          presentationBinding
        ),
      missingDecisionKindMessage: (kind) =>
        diag('decisionResolverMissing', `Decision kind "${kind}" is not yet connected to Session DecisionResolver.`, { kind }),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      exactDecisionTarget: (input, events) => {
        const runId = input.runId?.trim();
        const targetId = input.targetId?.trim();
        if (!runId || !targetId) return undefined;
        if (input.kind === 'plan' || input.kind === 'requirement') {
          const active = driverInteractionIndex.active(events);
          if (
            input.kind === 'plan'
            && active?.kind === 'plan'
            && active.runId === runId
            && active.planId === targetId
          ) return { runId, targetId };
          if (
            input.kind === 'requirement'
            && active?.kind === 'requirement'
            && active.runId === runId
            && active.requirementId === targetId
          ) return { runId, targetId };
          return undefined;
        }
        if (input.kind === 'permission') {
          return permissionPipeline.findPendingPermissionContext(events, targetId, runId)
            ? { runId, targetId }
            : undefined;
        }
        if (input.kind === 'review') {
          const assembler = reviewAssembler();
          const active = assembler.findLatestActiveReviewInteraction(events);
          return assembler.findWaitingReview(events, runId, active, targetId)
            ? { runId, targetId }
            : undefined;
        }
        return undefined;
      },
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
      projectKernelEvents: (sessionId, reply, language) =>
        this.agentRunReactor.projectKernelEvents(sessionId, reply, language),
      taskPlanCardEvent: (planInput) =>
        planProjectionBuilder.taskPlanCardEvent(planInput),
      diagnosticEvent: (sessionId, content, ts, id, presentationBinding) =>
        assistantProjectionBuilder.finalDiagnosticEvent(
          sessionId,
          content,
          ts,
          id,
          presentationBinding
        ),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
    });
    this.providerTerminalProposalHandler = new ProviderTerminalProposalHandler<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      reviseAnswer: (handlerInput, state, proposal) =>
        this.terminalGuidanceRevisionCoordinator.revise(handlerInput, state, proposal),
      answerEvent: (answerSessionId, proposal, ts, id, metadata) =>
        assistantProjectionBuilder.answerEvent(
          answerSessionId,
          proposal,
          ts,
          id,
          metadata
        ),
      finalDiagnosticEvent: (
        diagnosticSessionId,
        summary,
        ts,
        id,
        presentationBinding,
        metadata
      ) =>
        assistantProjectionBuilder.finalDiagnosticEvent(
          diagnosticSessionId,
          summary,
          ts,
          id,
          presentationBinding,
          metadata
        ),
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
      presentationBinding: (state) =>
        conversationPresentationLanguageBinding(state),
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
      collectQueued: (events, runId, hostRunId) =>
        userGuidanceQueue.collectQueued(events, runId, hostRunId),
      admitQueuedGuidance: async (state, current) => {
        const resume = userGuidanceQueue.providerResume({
          sessionId: state.sessionId,
          events: current.events,
          runId: state.runId,
          hostRunId: state.hostRunId,
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
        state.activeProviderContinuation = undefined;
        state.pendingProviderRetry = undefined;
        state.semanticDirectiveRepairAttempted = false;
        state.semanticDirectiveRepairAttempts = {};
        state.semanticDirectiveErrorSummary = undefined;
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
          overlayInput.draftAnswer
        ),
      answerEvent: (sessionId, proposal, ts, id, metadata) =>
        assistantProjectionBuilder.answerEvent(sessionId, proposal, ts, id, metadata),
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
          hostRunId: guidanceInput.hostRunId,
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
          stage: 'guidance_revision',
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
      projectKernelEvents: (sessionId, reply, language) =>
        this.agentRunReactor.projectKernelEvents(sessionId, reply, language),
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
      recordAndAppend: (state, packet, eventIdPrefix, activityIdentity) =>
        this.resourceOrchestrator.recordAndAppend(state, packet, eventIdPrefix, {
          activityIdentity,
        }),
      resolveRecordAndAppend: (state, manifest, eventIdPrefix, activityIdentity) =>
        this.resourceOrchestrator.resolveRecordAndAppend(state, manifest, eventIdPrefix, {
          discoverManifestEntries: true,
          activityIdentity,
        }),
      resolveResourceRequest: (manifest, request, roots) =>
        resourceRequestResolver().resolve(manifest, request, roots),
      finalDiagnosticEvent: (sessionId, content, ts, id, presentationBinding) =>
        assistantProjectionBuilder.finalDiagnosticEvent(
          sessionId,
          content,
          ts,
          id,
          presentationBinding
        ),
      internalFailureEvents: (state, stage, code, message, id) =>
        sessionFailureProjectionBuilder.internalFailureEvents({
          sessionId: state.sessionId,
          runId: state.runId,
          stage,
          code,
          message,
          language: state.userAuthorityFrame.effectiveLanguage,
          reason: 'driver_failure',
          ts: this.agentRunReactor.ts(),
          id,
        }),
      resourceResolutionDiagnostic: (state, resolution) =>
        resourceRequestLoop.resolutionDiagnostic(
          resolution,
          conversationPresentationLanguage(state)
        ),
      completeResourceSemanticExchange: async (state, proposal, packets, issues = []) => {
        const pending = state.pendingSemanticExchanges?.[proposal.proposalId];
        if (!pending) {
          throw new SessionDriverLoopError(
            'session_provider_continuation_invalid',
            `Resource semantic exchange ${proposal.proposalId} has no complete in-memory Provider turn.`
          );
        }
        pending.phase = 'continuationPersistenceStarted';
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
        await this.appendSemanticExchange(
          state,
          pending.turn,
          pending.toolCall,
          delta,
          true,
          proposal.proposalId
        );
        delete state.pendingSemanticExchanges?.[proposal.proposalId];
      },
      beginResourceSemanticEffect: async (state, proposal) => {
        const pending = state.pendingSemanticExchanges?.[proposal.proposalId];
        if (!pending) {
          throw new SessionDriverLoopError(
            'session_provider_continuation_invalid',
            `Resource semantic exchange ${proposal.proposalId} has no admitted lifecycle record.`
          );
        }
        const providerRequestId = pending.turn.providerRequestId;
        if (!providerRequestId) {
          throw new SessionDriverLoopError(
            'session_provider_continuation_invalid',
            `Resource semantic exchange ${proposal.proposalId} has no Provider request identity.`
          );
        }
        if (pending.phase === 'continuationPersistenceStarted') {
          throw new SessionDriverLoopError(
            'session_provider_continuation_invalid',
            `Resource semantic exchange ${proposal.proposalId} already started continuation persistence.`
          );
        }
        const identity = resourcePacketActivityIdentity(
          state.runId,
          providerRequestId,
          pending.toolCall
        );
        if (pending.phase === 'admitted') {
          await this.agentRunReactor.emitProjectionDelta(
            state,
            nativeToolProjectionBuilder.toolCallRunningDelta({
              sessionId: state.sessionId,
              runId: state.runId,
              language: effectiveConversationLanguage(pending.turn.sourceLanguagePolicy),
              toolCall: pending.toolCall,
              activityId: identity.activityId,
            })
          );
          pending.phase = 'effectStarted';
        }
        return identity;
      },
      failResourceSemanticExchange: async (state, proposal, error) => {
        const pending = state.pendingSemanticExchanges?.[proposal.proposalId];
        if (!pending) return;
        const status = pending.phase === 'admitted'
          ? resourceSemanticTerminalStatus(error)
          : 'postEffectPersistenceFailed';
        try {
          await this.appendSemanticDirectiveTerminal(
            state,
            pending.turn,
            pending.toolCall,
            status,
            error
          );
        } catch (terminalError) {
          throw new SessionDriverLoopError(
            'session_analysis_timeline_write_failed',
            [
              `Resource semantic exchange ${proposal.proposalId} failed: ${errorText(error)}.`,
              `Its terminal analysis record also failed: ${errorText(terminalError)}.`,
            ].join(' ')
          );
        } finally {
          delete state.pendingSemanticExchanges?.[proposal.proposalId];
        }
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
          id,
          conversationPresentationLanguage(state)
        ),
    });
    this.actionProposalSubmitter = new ActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
      submitAcceptedPlanActionProposal: (handlerInput, state, prompt, proposal, fallback) =>
        this.acceptedPlanActionProposalSubmitter.submit(handlerInput, state, prompt, proposal, fallback),
      finalDiagnosticEvent: (sessionId, content, ts, id, presentationBinding) =>
        assistantProjectionBuilder.finalDiagnosticEvent(
          sessionId,
          content,
          ts,
          id,
          presentationBinding
        ),
      sessionRunStateEvent: (runStateInput) =>
        sessionProgressProjectionBuilder.sessionRunStateEvent(runStateInput),
      diagnostic: (code, fallback, params) => diag(code, fallback, params),
    });
    this.artifactDraftCoordinator = new ArtifactDraftCoordinator<SessionDriverLoopRunState>({
      createId: (prefix) => this.agentRunReactor.id(prefix),
      kernel: (request) => this.agentRunReactor.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply, language) =>
        this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply, language),
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
      taskSavepointEvent: (
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
        contextCompactRecord,
        language
      ) =>
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
          contextCompactRecord,
          language
        ),
    });
    this.nativeToolHandlerPortsFactory = new NativeToolHandlerPortsFactory({
      projectionBuilder: nativeToolProjectionBuilder,
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
      recordSemanticDirectiveAdmission: (state, turn, toolCall) =>
        this.appendSemanticDirectiveAdmission(state, turn, toolCall),
      recordSemanticDirectiveTerminal: (state, turn, toolCall, status, error) =>
        this.appendSemanticDirectiveTerminal(
          state,
          turn,
          toolCall,
          status,
          error
        ),
      recordSemanticExchange: async (state, turn, toolCall, result) => {
        if (result.kind === 'proposal') {
          const providerRequestId = exactSemanticProviderRequestId(
            turn,
            `Provider proposal ${result.proposal.proposalId}`
          );
          try {
            bindPendingProviderProposalAdmission(
              state,
              result.proposal.proposalId,
              turn.providerAdmission
            );
          } catch (error) {
            throw new SessionDriverLoopError(
              stringValue(objectRecord(error)?.code)
                ?? 'session_provider_admission_invalid',
              error instanceof Error ? error.message : String(error)
            );
          }
          try {
            await this.ports.bindProviderProposalAdmission?.(
              state.sessionId,
              result.proposal.proposalId,
              providerRequestId
            );
          } catch (error) {
            throw new SessionDriverLoopError(
              'session_provider_admission_write_failed',
              `Provider proposal ${result.proposal.proposalId} could not persist its exact request binding: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
        if (result.kind === 'proposal' && result.proposal.kind === 'resourceRequest') {
          state.pendingSemanticExchanges ??= {};
          state.pendingSemanticExchanges[result.proposal.proposalId] = {
            toolCall,
            phase: 'admitted',
            turn: {
              providerAdmission: turn.providerAdmission,
              providerRequestId: turn.providerRequestId,
              providerParentRequestId: turn.providerParentRequestId,
              continuationBaseMessages: turn.continuationBaseMessages,
              continuationBaseMessagesDigest: turn.continuationBaseMessagesDigest,
              sourceLanguagePolicy: turn.sourceLanguagePolicy,
              assistantMessage: turn.assistantMessage,
              providerProfileId: turn.providerProfileId,
              provider: turn.provider,
              model: turn.model,
              content: turn.content,
              reasoning: turn.reasoning,
            },
          };
          return;
        }
        await this.appendSemanticExchange(
          state,
          turn,
          toolCall,
          result.toolResult,
          result.kind === 'providerResume' && toolCall.name !== 'session.submit_task_outcome',
          result.kind === 'proposal' ? result.proposal.proposalId : undefined
        );
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
        error instanceof SessionDriverLoopError && (
          error.code === 'native_tool_arguments_invalid'
          || error.code === 'provider_reserved_token_invalid'
          || error.code === 'provider_continuation_control_leak'
        )
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
            visibility: 'hidden',
            presentation: 'traceOnly',
          }),
          assistantProjectionBuilder.statusSummaryEvent(
            state.sessionId,
            content,
            this.agentRunReactor.ts(),
            this.agentRunReactor.id(reason.code),
            undefined,
            conversationPresentationLanguageBinding(state)
          ),
        ]);
      },
      createError: (code, message) => new SessionDriverLoopError(code, message),
    });
    this.providerStreamRuntime = new ProviderStreamRuntime<SessionDriverLoopRunState>({
      semanticDraftFlushChars: PROVIDER_SEMANTIC_DRAFT_FLUSH_CHARS,
      semanticDraftFlushMs: PROVIDER_SEMANTIC_DRAFT_FLUSH_MS,
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
        const decision = decideConversationLanguageFromProvider({
          hostLanguage: policy.hostLanguage,
          content: decisionInput.content,
          toolCalls: decisionInput.toolCalls,
        });
        if (policy.status !== 'pending') {
          // The persisted Session policy remains authoritative for retries and
          // continuations. Missing, invalid, or conflicting Provider metadata
          // is normalized at semantic admission without a repair call.
          return;
        }
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
        const admitted = await this.admitQueuedProviderGuidance(state, stage);
        return admitted.messages;
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
        const language = conversationPresentationLanguage(state);
        const safeAssessmentSummary = language === 'zh-CN'
          ? `Session 已根据任务 ${pending.taskId} 的当前证据评估其无需额外 workspace mutation；此结论等待用户复核，且不代表 Kernel 执行完成。`
          : language === 'en-US'
            ? `Session assessed task ${pending.taskId} from current evidence as requiring no additional workspace mutation; this awaits user review and is not a Kernel execution-completion fact.`
            : `task=${pending.taskId} evidenceAssessment=noAdditionalMutation userReview=pending kernelExecutionCompleted=false`;
        const plan = acceptedPlanExecutor.modelTaskOutcomeReviewContext({
          sessionId: state.sessionId,
          runId: state.runId,
          acceptedPlan: accepted,
          taskId: pending.taskId,
          summary: safeAssessmentSummary,
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
          presentationBinding: conversationPresentationLanguageBinding(state),
        };
      },
      prepareProviderContext: async (handlerInput, state, lastResult) => {
        const guidance = await this.admitQueuedProviderGuidance(
          state,
          'provider_call',
          'contextPreparation'
        );
        return this.providerTurnContextCoordinator.prepare(state, {
          contextAssemblyId: this.agentRunReactor.id('context-assembly'),
          contractId: this.agentRunReactor.id('provider-turn-contract'),
          inputContent: handlerInput.content,
          projectMemoryMode: handlerInput.projectMemoryMode,
          interventionLevel: handlerInput.interventionLevel,
          confirmedRequirement: handlerInput.confirmedRequirement,
          priorUserGuidance: guidance.priorGuidance,
          lastResult: guidance.result.events.length >= lastResult.events.length
            ? guidance.result
            : lastResult,
        });
      },
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
          const language = await this.localOutputLanguage(
            state.sessionId,
            state.runId,
            state.userAuthorityFrame?.languagePolicy.hostLanguage
          );
          return this.agentRunReactor.append(state.sessionId, [
            ...language.decisionEvents,
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
        const language = await this.localOutputLanguage(
          state.sessionId,
          state.runId,
          state.userAuthorityFrame?.languagePolicy.hostLanguage
        );
        const diagnostic = driverFailureMessageCatalog.driverFailure(
          error.code,
          error.message,
          language.language
        );
        return this.agentRunReactor.append(state.sessionId, [
          ...language.decisionEvents,
          ...takeProviderCommitEvents(state),
          ...sessionFailureProjectionBuilder.internalFailureEvents({
            sessionId: state.sessionId,
            runId: state.runId,
            stage: 'driver',
            code: diagnostic.code,
            message: diagnostic.fallback,
            language: language.language,
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
        const language = await this.localOutputLanguage(
          state.sessionId,
          state.runId,
          state.userAuthorityFrame?.languagePolicy.hostLanguage
        );
        const diagnostic = driverFailureMessageCatalog.providerFailure(
          error,
          language.language
        );
        return this.agentRunReactor.append(state.sessionId, [
          ...language.decisionEvents,
          ...takeProviderCommitEvents(state),
          ...sessionFailureProjectionBuilder.internalFailureEvents({
            sessionId: state.sessionId,
            runId: state.runId,
            stage: 'provider',
            code: diagnostic.code,
            message: diagnostic.fallback,
            language: language.language,
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
          const rawMessage = error instanceof SessionDriverLoopError ? error.message : String(error);
          const code = error instanceof SessionDriverLoopError
            ? error.code
            : 'requirement_confirmation_failed';
          const language = await this.localOutputLanguage(
            runInput.sessionId,
            state.runId,
            state.userAuthorityFrame?.languagePolicy.hostLanguage
          );
          const diagnostic = driverFailureMessageCatalog.driverFailure(
            code,
            rawMessage,
            language.language
          );
          return this.agentRunReactor.append(runInput.sessionId, [
            ...language.decisionEvents,
            ...sessionFailureProjectionBuilder.internalFailureEvents({
              sessionId: runInput.sessionId,
              runId: state.runId,
              stage: 'requirement_confirmation',
              code: diagnostic.code,
              message: diagnostic.fallback,
              language: language.language,
              reason: 'driver_failure',
              ts: this.agentRunReactor.ts(),
              id: this.agentRunReactor.id('requirement-confirmation-failed'),
            }),
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
    try {
      return await this.decisionResolver.resolve(input);
    } catch (error) {
      if (input.goalContext) throw error;
      const rawMessage = error instanceof SessionDriverLoopError ? error.message : String(error);
      const code = error instanceof SessionDriverLoopError ? error.code : 'decision_resolver_failed';
      const language = await this.localOutputLanguage(
        input.sessionId,
        input.runId,
        input.hostLanguage
      );
      if (
        input.hostRunId
        && hasClosedHostRunFence(language.currentResult, input.hostRunId)
      ) {
        return language.currentResult;
      }
      const diagnostic = driverFailureMessageCatalog.driverFailure(
        code,
        rawMessage,
        language.language
      );
      return this.agentRunReactor.append(input.sessionId, [
        ...(input.bootstrapEvents ?? []),
        ...language.decisionEvents,
        ...sessionFailureProjectionBuilder.internalFailureEvents({
          sessionId: input.sessionId,
          runId: input.runId
            ?? language.runId
            ?? latestRunIdForFailure(language.currentEvents)
            ?? 'run-unavailable',
          stage: 'decision_resolver',
          code: diagnostic.code,
          message: diagnostic.fallback,
          language: language.language,
          reason: 'driver_failure',
          ts: this.agentRunReactor.ts(),
          id: this.agentRunReactor.id('decision-resolver-failed'),
        }),
      ]);
    }
  }

  async runUserTurn(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    return this.runLoopInput(input);
  }

  private async appendSemanticDirectiveAdmission(
    state: SessionDriverLoopRunState,
    turn: Pick<
      LlmTurnResult,
      | 'providerAdmission'
      | 'providerRequestId'
      | 'assistantMessage'
      | 'providerProfileId'
      | 'provider'
      | 'model'
      | 'content'
      | 'reasoning'
    >,
    toolCall: NativeToolCallProposal
  ): Promise<void> {
    const providerRequestId = exactSemanticProviderRequestId(
      turn,
      `Session semantic tool ${toolCall.callId} before execution`
    );
    if (!this.ports.appendAnalysisTimeline) {
      if (this.ports.analysisTimelineRequired) {
        throw new SessionDriverLoopError(
          'session_analysis_timeline_unavailable',
          'Session semantic directives require pre-execution analysis persistence.'
        );
      }
      return;
    }
    const decodedToolCall = turn.assistantMessage?.toolCalls?.find(
      (candidate) => candidate.id === toolCall.callId
    );
    const analysisEntries = [
      semanticDirectiveAdmissionAnalysisEvent({
        state,
        requestId: providerRequestId,
        stage: state.activeTurn?.stage ?? 'provider_call',
        languageRevision: state.userAuthorityFrame.languagePolicy.revision,
        providerProfileId: turn.providerProfileId,
        provider: turn.provider,
        model: turn.model,
        promptLedgerEpochId: this.semanticPromptLedgerEpochId(state, toolCall.callId),
        toolCallId: toolCall.callId,
        toolCall: {
          ...(decodedToolCall ?? {
            id: toolCall.callId,
            name: toolCall.name,
            arguments: toolCall.arguments,
          }),
          arguments: toolCall.rawArguments
            ?? decodedToolCall?.arguments
            ?? toolCall.arguments,
        },
        assistantContent: turn.assistantMessage?.content ?? turn.content,
        assistantReasoning: turn.reasoning,
        recordId: this.agentRunReactor.id('analysis-semantic-directive-admitted'),
        createdAt: this.agentRunReactor.ts(),
      }),
    ];
    try {
      const result = await this.ports.appendAnalysisTimeline(
        state.sessionId,
        analysisEntries
      );
      if (this.ports.analysisTimelineRequired) {
        const violation = providerAnalysisTimelineAckViolation(analysisEntries, result);
        if (violation) throw new Error(violation);
      }
    } catch (error) {
      throw new SessionDriverLoopError(
        'session_analysis_timeline_write_failed',
        `Session semantic directive admission failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async appendSemanticDirectiveTerminal(
    state: SessionDriverLoopRunState,
    turn: Pick<
      LlmTurnResult,
      | 'providerAdmission'
      | 'providerRequestId'
      | 'assistantMessage'
      | 'providerProfileId'
      | 'provider'
      | 'model'
      | 'content'
      | 'reasoning'
    >,
    toolCall: NativeToolCallProposal,
    status: 'failed' | 'cancelled' | 'superseded' | 'postEffectPersistenceFailed',
    error: unknown
  ): Promise<void> {
    const providerRequestId = exactSemanticProviderRequestId(
      turn,
      `Session semantic tool ${toolCall.callId} at terminal analysis`
    );
    if (!this.ports.appendAnalysisTimeline) {
      if (this.ports.analysisTimelineRequired) {
        throw new SessionDriverLoopError(
          'session_analysis_timeline_unavailable',
          'Session semantic directive terminal state requires analysis persistence.'
        );
      }
      return;
    }
    const decodedToolCall = turn.assistantMessage?.toolCalls?.find(
      (candidate) => candidate.id === toolCall.callId
    );
    const errorRecord = objectRecord(error);
    const analysisEntries = [
      semanticDirectiveTerminalAnalysisEvent({
        state,
        requestId: providerRequestId,
        stage: state.activeTurn?.stage ?? 'provider_call',
        languageRevision: state.userAuthorityFrame.languagePolicy.revision,
        providerProfileId: turn.providerProfileId,
        provider: turn.provider,
        model: turn.model,
        promptLedgerEpochId: this.semanticPromptLedgerEpochId(state, toolCall.callId),
        toolCallId: toolCall.callId,
        toolCall: {
          ...(decodedToolCall ?? {
            id: toolCall.callId,
            name: toolCall.name,
            arguments: toolCall.arguments,
          }),
          arguments: toolCall.rawArguments
            ?? decodedToolCall?.arguments
            ?? toolCall.arguments,
        },
        assistantContent: turn.assistantMessage?.content ?? turn.content,
        assistantReasoning: turn.reasoning,
        status,
        errorCode: stringValue(errorRecord?.code)
          ?? stringValue(errorRecord?.causeCode)
          ?? (error instanceof Error ? error.name : undefined),
        errorMessage: error instanceof Error ? error.message : String(error),
        recordId: this.agentRunReactor.id(`analysis-semantic-directive-${status}`),
        createdAt: this.agentRunReactor.ts(),
      }),
    ];
    try {
      const result = await this.ports.appendAnalysisTimeline(
        state.sessionId,
        analysisEntries
      );
      if (this.ports.analysisTimelineRequired) {
        const violation = providerAnalysisTimelineAckViolation(analysisEntries, result);
        if (violation) throw new Error(violation);
      }
    } catch (analysisError) {
      throw new SessionDriverLoopError(
        'session_analysis_timeline_write_failed',
        `Session semantic directive terminal append failed: ${analysisError instanceof Error ? analysisError.message : String(analysisError)}`
      );
    }
  }

  private async appendProviderSideCallSemanticExchange(
    state: SessionDriverLoopRunState,
    turn: Pick<
      LlmTurnResult,
      | 'providerAdmission'
      | 'providerRequestId'
      | 'assistantMessage'
      | 'providerProfileId'
      | 'provider'
      | 'model'
      | 'content'
      | 'reasoning'
      | 'sourceLanguagePolicy'
    >,
    toolCall: NativeToolCallProposal,
    result: unknown,
    stage: string
  ): Promise<void> {
    const providerRequestId = exactSemanticProviderRequestId(
      turn,
      `Session read-only semantic tool ${toolCall.callId}`
    );
    if (!this.ports.appendAnalysisTimeline) {
      if (this.ports.analysisTimelineRequired) {
        throw new SessionDriverLoopError(
          'session_analysis_timeline_unavailable',
          'Session read-only semantic directives require analysis timeline storage.'
        );
      }
      return;
    }
    const decodedToolCall = turn.assistantMessage?.toolCalls?.find(
      (candidate) => candidate.id === toolCall.callId
    );
    const analysisEntries = [
      semanticExchangeAnalysisEvent({
        state,
        requestId: providerRequestId,
        stage,
        languageRevision: turn.sourceLanguagePolicy.revision,
        providerProfileId: turn.providerProfileId,
        provider: turn.provider,
        model: turn.model,
        providerTurnContractId: this.providerSideCallContractId(state, toolCall.callId),
        toolCallId: toolCall.callId,
        toolCall: {
          ...(decodedToolCall ?? {
            id: toolCall.callId,
            name: toolCall.name,
            arguments: toolCall.arguments,
          }),
          arguments: toolCall.rawArguments
            ?? decodedToolCall?.arguments
            ?? toolCall.arguments,
        },
        toolResult: result,
        assistantContent: turn.assistantMessage?.content ?? turn.content,
        assistantReasoning: turn.reasoning,
        recordId: this.agentRunReactor.id('analysis-read-only-semantic-exchange'),
        createdAt: this.agentRunReactor.ts(),
      }),
    ];
    try {
      const analysisResult = await this.ports.appendAnalysisTimeline(
        state.sessionId,
        analysisEntries
      );
      if (this.ports.analysisTimelineRequired) {
        const violation = providerAnalysisTimelineAckViolation(
          analysisEntries,
          analysisResult
        );
        if (violation) throw new Error(violation);
      }
    } catch (error) {
      throw new SessionDriverLoopError(
        'session_analysis_timeline_write_failed',
        `Session read-only semantic analysis append failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async appendProviderSideCallSemanticFailure(
    state: SessionDriverLoopRunState,
    turn: Pick<
      LlmTurnResult,
      | 'providerAdmission'
      | 'providerRequestId'
      | 'assistantMessage'
      | 'providerProfileId'
      | 'provider'
      | 'model'
      | 'content'
      | 'reasoning'
      | 'sourceLanguagePolicy'
    >,
    toolCall: NativeToolCallProposal | undefined,
    error: unknown,
    stage: string
  ): Promise<void> {
    const providerRequestId = exactSemanticProviderRequestId(
      turn,
      'Session Provider side-call failure'
    );
    if (!this.ports.appendAnalysisTimeline) {
      if (this.ports.analysisTimelineRequired) {
        throw new SessionDriverLoopError(
          'session_analysis_timeline_unavailable',
          'Session Provider side-call failures require analysis timeline storage.'
        );
      }
      return;
    }
    const decodedToolCall = toolCall
      ? turn.assistantMessage?.toolCalls?.find((candidate) => candidate.id === toolCall.callId)
      : undefined;
    const errorRecord = objectRecord(error);
    const contractId = this.providerSideCallContractId(state, toolCall?.callId);
    const analysisEntries = [
      providerSideCallSemanticFailureAnalysisEvent({
        state,
        requestId: providerRequestId,
        stage,
        languageRevision: turn.sourceLanguagePolicy.revision,
        providerProfileId: turn.providerProfileId,
        provider: turn.provider,
        model: turn.model,
        providerTurnContractId: contractId,
        ...(toolCall
          ? {
              toolCallId: toolCall.callId,
              toolCall: {
                ...(decodedToolCall ?? {
                  id: toolCall.callId,
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                }),
                arguments: toolCall.rawArguments
                  ?? decodedToolCall?.arguments
                  ?? toolCall.arguments,
              },
            }
          : {}),
        assistantContent: turn.assistantMessage?.content ?? turn.content,
        assistantReasoning: turn.reasoning,
        errorCode: stringValue(errorRecord?.code)
          ?? stringValue(errorRecord?.causeCode)
          ?? (error instanceof Error ? error.name : undefined),
        errorMessage: error instanceof Error ? error.message : String(error),
        recordId: this.agentRunReactor.id('analysis-provider-side-call-failed'),
        createdAt: this.agentRunReactor.ts(),
      }),
    ];
    try {
      const analysisResult = await this.ports.appendAnalysisTimeline(
        state.sessionId,
        analysisEntries
      );
      if (this.ports.analysisTimelineRequired) {
        const violation = providerAnalysisTimelineAckViolation(
          analysisEntries,
          analysisResult
        );
        if (violation) throw new Error(violation);
      }
    } catch (analysisError) {
      throw new SessionDriverLoopError(
        'session_analysis_timeline_write_failed',
        `Session Provider side-call failure append failed: ${analysisError instanceof Error ? analysisError.message : String(analysisError)}`
      );
    }
  }

  private async appendSemanticExchange(
    state: SessionDriverLoopRunState,
    turn: Pick<
      LlmTurnResult,
      | 'providerRequestId'
      | 'providerParentRequestId'
      | 'continuationBaseMessages'
      | 'continuationBaseMessagesDigest'
      | 'providerAdmission'
      | 'sourceLanguagePolicy'
      | 'assistantMessage'
      | 'providerProfileId'
      | 'provider'
      | 'model'
      | 'content'
      | 'reasoning'
    >,
    toolCall: NativeToolCallProposal,
    result: unknown,
    preserveActiveContinuation: boolean,
    proposalId?: string
  ): Promise<void> {
    const profileId = this.providerProfileRegistry.profileForFrame(state.providerTurnFrame).id;
    const protocolToolCall = {
      id: toolCall.callId,
      name: toolCall.name,
      arguments: toolCall.arguments,
    };
    const decodedReplayToolCall = turn.assistantMessage?.toolCalls?.find(
      (candidate) => candidate.id === toolCall.callId
    );
    if (
      preserveActiveContinuation
      && (!turn.assistantMessage || !decodedReplayToolCall)
    ) {
      throw new SessionDriverLoopError(
        'session_provider_continuation_invalid',
        `Session semantic tool ${toolCall.callId} has no complete Provider assistant replay message.`
      );
    }
    if (
      preserveActiveContinuation
      && this.ports.providerResponseIdentityRequired
      && (!turn.providerProfileId || !turn.provider || !turn.model)
    ) {
      throw new SessionDriverLoopError(
        'session_provider_continuation_invalid',
        `Session semantic tool ${toolCall.callId} has no complete Provider identity.`
      );
    }
    const replayToolCall = {
      ...(decodedReplayToolCall ?? protocolToolCall),
      arguments: toolCall.rawArguments
        ?? decodedReplayToolCall?.arguments
        ?? protocolToolCall.arguments,
    };
    const providerRequestId = exactSemanticProviderRequestId(
      turn,
      `Session semantic tool ${toolCall.callId}`
    );
    const epochId = state.providerTurnFrame?.promptLedgerEpochId;
    if (!epochId) {
      throw new SessionDriverLoopError(
        'session_task_prompt_epoch_incompatible',
        'Session semantic exchange has no active PromptLedger epoch.'
      );
    }
    const priorContinuation = state.activeProviderContinuation;
    if (priorContinuation) {
      for (const [name, previous, current] of [
        ['sessionId', priorContinuation.sessionId, state.sessionId],
        ['runId', priorContinuation.runId, state.runId],
        ['turnId', priorContinuation.turnId, state.userAuthorityFrame.turnAuthority.turnId],
        ['taskId', priorContinuation.taskId, state.userAuthorityFrame.turnAuthority.taskId],
        [
          'turnAuthorityRef',
          priorContinuation.turnAuthorityRef,
          state.userAuthorityFrame.turnAuthorityRef,
        ],
        ['promptLedgerEpochId', priorContinuation.promptLedgerEpochId, epochId],
      ] as const) {
        if (previous !== current) {
          throw new SessionDriverLoopError(
            'session_provider_continuation_invalid',
            `Session semantic tool ${toolCall.callId} changed continuation ${name} from ${previous} to ${current}.`
          );
        }
      }
    }
    const continuationLanguagePolicy = priorContinuation?.sourceLanguagePolicy
      ?? turn.sourceLanguagePolicy;
    const toolResultContent = JSON.stringify(result);
    const continuationExchange = {
      sourceRequestId: providerRequestId,
      sourceParentRequestId: turn.providerParentRequestId,
      languageRevision: state.userAuthorityFrame.languagePolicy.revision,
      stage: state.activeTurn?.stage ?? 'provider_call',
      assistantContent: preserveActiveContinuation
        ? turn.assistantMessage!.content
        : turn.assistantMessage?.content ?? turn.content,
      reasoningContent: turn.reasoning,
      toolCall: replayToolCall,
      toolResultContent,
    };
    if (
      priorContinuation?.semanticProfileId
      && priorContinuation.semanticProfileId !== profileId
    ) {
      throw new SessionDriverLoopError(
        'session_provider_continuation_invalid',
        `Session semantic tool ${toolCall.callId} changed Provider profile within an active continuation.`
      );
    }
    for (const [name, previous, current] of [
      ['providerProfileId', priorContinuation?.providerProfileId, turn.providerProfileId],
      ['provider', priorContinuation?.provider, turn.provider],
      ['model', priorContinuation?.model, turn.model],
    ] as const) {
      if (previous && current && previous !== current) {
        throw new SessionDriverLoopError(
          'session_provider_continuation_invalid',
          `Session semantic tool ${toolCall.callId} changed ${name} from ${previous} to ${current}.`
        );
      }
    }
    if (
      priorContinuation
      && priorContinuation.baseMessagesDigest !== turn.continuationBaseMessagesDigest
    ) {
      throw new SessionDriverLoopError(
        'session_provider_continuation_invalid',
        `Session semantic tool ${toolCall.callId} changed the admitted continuation base messages.`
      );
    }
    if (
      priorContinuation?.exchanges.some(
        (exchange) => exchange.toolCall.id === protocolToolCall.id
      )
    ) {
      throw new SessionDriverLoopError(
        'session_provider_continuation_invalid',
        `Session semantic tool ${toolCall.callId} duplicated an active continuation call id.`
      );
    }
    const activeProviderContinuation = {
      schemaVersion: 'deepcode.session.active-provider-continuation.v1' as const,
      sessionId: state.sessionId,
      runId: state.runId,
      turnId: state.userAuthorityFrame.turnAuthority.turnId,
      taskId: state.userAuthorityFrame.turnAuthority.taskId,
      turnAuthorityRef: state.userAuthorityFrame.turnAuthorityRef,
      promptLedgerEpochId: epochId,
      semanticProfileId: profileId,
      providerProfileId: priorContinuation?.providerProfileId ?? turn.providerProfileId,
      provider: priorContinuation?.provider ?? turn.provider,
      model: priorContinuation?.model ?? turn.model,
      toolSchemaHash: priorContinuation?.toolSchemaHash
        ?? state.providerTurnFrame?.snapshot?.toolSchemaHash,
      responseFormatHash: priorContinuation?.responseFormatHash
        ?? state.providerTurnFrame?.snapshot?.responseFormatHash,
      sourceRequestId: priorContinuation?.sourceRequestId ?? providerRequestId,
      sourceLanguagePolicy: continuationLanguagePolicy,
      baseMessages: priorContinuation?.baseMessages ?? turn.continuationBaseMessages,
      baseMessagesDigest: priorContinuation?.baseMessagesDigest ?? turn.continuationBaseMessagesDigest,
      exchanges: [
        ...(priorContinuation?.exchanges ?? []),
        continuationExchange,
      ],
    };
    if (!this.ports.appendAnalysisTimeline) {
      if (this.ports.analysisTimelineRequired) {
        throw new SessionDriverLoopError(
          'session_analysis_timeline_unavailable',
          'Session semantic directives require the full analysis timeline storage port.'
        );
      }
    } else {
      const analysisEntries = [
        semanticExchangeAnalysisEvent({
          state,
          requestId: providerRequestId,
          stage: continuationExchange.stage,
          languageRevision: continuationExchange.languageRevision,
          providerProfileId: turn.providerProfileId,
          provider: turn.provider,
          model: turn.model,
          promptLedgerEpochId: epochId,
          toolCallId: toolCall.callId,
          proposalId,
          toolCall: replayToolCall,
          toolResult: result,
          assistantContent: preserveActiveContinuation
            ? turn.assistantMessage!.content
            : turn.assistantMessage?.content ?? turn.content,
          assistantReasoning: turn.reasoning,
          recordId: this.agentRunReactor.id('analysis-semantic-exchange'),
          createdAt: this.agentRunReactor.ts(),
        }),
      ];
      try {
        const analysisResult = await this.ports.appendAnalysisTimeline(
          state.sessionId,
          analysisEntries
        );
        if (this.ports.analysisTimelineRequired) {
          const violation = providerAnalysisTimelineAckViolation(
            analysisEntries,
            analysisResult
          );
          if (violation) {
            throw new Error(violation);
          }
        }
      } catch (error) {
        throw new SessionDriverLoopError(
          'session_analysis_timeline_write_failed',
          `Session semantic analysis append failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const epoch = promptLedgerEpoch(state.promptLedger, epochId);
    if (!epoch) {
      throw new SessionDriverLoopError(
        'session_task_prompt_epoch_incompatible',
        `Session semantic exchange PromptLedger epoch ${epochId} is unavailable.`
      );
    }
    if (!this.ports.appendWireLedger) {
      if (this.ports.wireLedgerRequired) {
        throw new SessionDriverLoopError(
          'session_wire_ledger_unavailable',
          'Session semantic exchange requires the durable wire ledger storage port.'
        );
      }
    } else {
      await this.ports.appendWireLedger(state.sessionId, promptLedgerWireSemanticExchange({
          sessionId: state.sessionId,
          runId: state.runId,
          profileId,
          sourceRequestId: providerRequestId,
          epoch,
          toolCall: protocolToolCall,
          result,
          timestamp: this.agentRunReactor.ts(),
          createId: (prefix) => this.agentRunReactor.id(prefix),
      }));
    }
    const appendedEpoch = appendPromptLedgerSemanticExchange({
      state: state.promptLedger,
      epochId,
      toolCall: protocolToolCall,
      result,
      createId: (prefix) => this.agentRunReactor.id(prefix),
    });
    if (!appendedEpoch) {
      throw new SessionDriverLoopError(
        'session_task_prompt_epoch_incompatible',
        `Session semantic exchange PromptLedger epoch ${epochId} became unavailable after durable append.`
      );
    }
    state.activeProviderContinuation = preserveActiveContinuation
      ? activeProviderContinuation
      : undefined;
  }

  private async resumeRun(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    return this.runLoopInput(input, 'resumeRun');
  }

  private async admitQueuedProviderGuidance(
    state: SessionDriverLoopRunState,
    stage: string,
    admissionPhase: 'contextPreparation' | 'physicalAdmission' = 'physicalAdmission'
  ): Promise<{
    result: AgentSessionResult;
    messages: LlmChatRequest['messages'];
    priorGuidance: Array<{ id: string; content: string }>;
  }> {
    const current = await this.agentRunReactor.append(state.sessionId, []);
    const resume = userGuidanceQueue.providerResume({
      sessionId: state.sessionId,
      events: current.events,
      runId: state.runId,
      hostRunId: state.hostRunId,
      taskId: state.userAuthorityFrame.turnAuthority.taskId,
      stage,
      defaultHostLanguage: state.userAuthorityFrame.languagePolicy.hostLanguage,
      promptEpochId: state.providerTurnFrame?.promptLedgerEpochId,
      summary: providerStreamCoordinator.userGuidanceConsumedSummary(
        state.userAuthorityFrame.effectiveLanguage
      ),
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
    });
    if (!resume.events.length) {
      return { result: current, messages: [], priorGuidance: [] };
    }
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
    state.activeProviderContinuation = undefined;
    state.pendingProviderRetry = undefined;
    state.semanticDirectiveRepairAttempted = false;
    state.semanticDirectiveRepairAttempts = {};
    state.semanticDirectiveErrorSummary = undefined;
    const priorGuidance = resume.guidance.slice(0, -1).map((item) => ({
      id: item.id,
      content: item.content,
    }));
    if (admissionPhase === 'contextPreparation') {
      return { result: appended, messages: [], priorGuidance };
    }
    const epochId = state.providerTurnFrame?.promptLedgerEpochId;
    if (!state.promptLedger || !epochId) {
      throw new SessionDriverLoopError(
        'session_task_prompt_epoch_incompatible',
        'Queued user guidance has no active PromptLedger epoch.'
      );
    }
    const epoch = promptLedgerEpoch(state.promptLedger, epochId);
    if (!epoch) {
      throw new SessionDriverLoopError(
        'session_task_prompt_epoch_incompatible',
        `Queued user guidance PromptLedger epoch ${epochId} is unavailable.`
      );
    }
    const priorEntryIds = new Set(epoch.entries.map((entry) => entry.entryId));
    appendPromptLedgerGuidanceBatch({
      state: state.promptLedger,
      epochId,
      guidance: priorGuidance,
      createId: (prefix) => this.agentRunReactor.id(prefix),
    });
    appendPromptLedgerCurrentTurn({
      state: state.promptLedger,
      epochId,
      authority: state.userAuthorityFrame,
      createId: (prefix) => this.agentRunReactor.id(prefix),
    });
    const messages = epoch.entries
      .filter((entry) => !priorEntryIds.has(entry.entryId))
      .map((entry) => structuredClone(entry.message));
    return { result: appended, messages, priorGuidance };
  }

  private async localOutputLanguage(
    sessionId: string,
    runId?: string,
    fallbackHostLanguage?: ConversationLanguage
  ): Promise<{
    readonly language: ConversationLanguage;
    readonly runId?: string;
    readonly currentResult: AgentSessionResult;
    readonly currentEvents: AgentEvent[];
    readonly decisionEvents: AgentEvent[];
  }> {
    const current = await this.agentRunReactor.append(sessionId, []);
    const authority = latestSessionTurnAuthority(current.events, runId);
    if (!authority) {
      return {
        language: normalizeHostLanguage(fallbackHostLanguage),
        runId,
        currentResult: current,
        currentEvents: current.events,
        decisionEvents: [],
      };
    }
    const policy = resolveConversationLanguagePolicy(current.events, authority);
    if (policy.status !== 'pending') {
      return {
        language: effectiveConversationLanguage(policy),
        runId: authority.runId,
        currentResult: current,
        currentEvents: current.events,
        decisionEvents: [],
      };
    }
    return {
      language: policy.hostLanguage,
      runId: authority.runId,
      currentResult: current,
      currentEvents: current.events,
      decisionEvents: [
        createSessionLanguageDecisionEvent({
          sessionId: authority.sessionId,
          runId: authority.runId,
          turnId: authority.turnId,
          revision: authority.languagePolicy.revision,
          status: 'fallback',
          responseLanguage: policy.hostLanguage,
          decisionSource: 'hostFallbackMissing',
          eventId: this.agentRunReactor.id('session-language-fallback'),
          timestamp: this.agentRunReactor.ts(),
        }),
      ],
    };
  }

  private semanticPromptLedgerEpochId(
    state: SessionDriverLoopRunState,
    toolCallId: string
  ): string {
    const epochId = state.providerTurnFrame?.promptLedgerEpochId;
    if (!epochId?.trim()) {
      throw new SessionDriverLoopError(
        'session_task_prompt_epoch_incompatible',
        `Session semantic tool ${toolCallId} has no active PromptLedger epoch.`
      );
    }
    return epochId;
  }

  private providerSideCallContractId(
    state: SessionDriverLoopRunState,
    toolCallId?: string
  ): string {
    const frame = state.providerTurnFrame;
    const contractId = frame?.contractId?.trim();
    if (!contractId) {
      throw new SessionDriverLoopError(
        'session_provider_continuation_invalid',
        `Session Provider side-call${toolCallId ? ` tool ${toolCallId}` : ''} has no active ProviderTurn contract.`
      );
    }
    if (frame?.promptLedgerEpochId?.trim()) {
      throw new SessionDriverLoopError(
        'session_task_prompt_epoch_incompatible',
        `Session Provider side-call contract ${contractId} must not reuse PromptLedger epoch ${frame.promptLedgerEpochId}.`
      );
    }
    return contractId;
  }

  private async runLoopInput(
    input: SessionDriverLoopInput,
    mode: 'userTurn' | 'resumeRun' = 'userTurn'
  ): Promise<AgentSessionResult> {
    const existingEvents = input.existingEvents ?? [];
    if (hasLegacySessionTurnAuthority(existingEvents) && !latestSessionTurnAuthority(existingEvents)) {
      const language = normalizeHostLanguage(input.hostLanguage);
      return this.agentRunReactor.append(input.sessionId, sessionFailureProjectionBuilder.internalFailureEvents({
        sessionId: input.sessionId,
        runId: latestRunIdForFailure(existingEvents) ?? 'run-unavailable',
        stage: 'run_engine',
        code: 'session_language_policy_unavailable',
        message: language === 'zh-CN'
          ? '此 Session 使用 turn authority v1，缺少 ConversationLanguagePolicy v1，无法继续。'
          : 'This Session uses turn authority v1 and cannot continue without ConversationLanguagePolicy v1.',
        language,
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
      const hostLanguage = normalizeHostLanguage(input.hostLanguage);
      const userMessage = input.appendUserMessage === false
        ? undefined
        : this.agentRunReactor.event(input.sessionId, 'user_msg', {
          content: input.content,
          attachments: input.attachments ?? [],
          channel: 'user',
          visibility: 'conversation',
        });
      const events = [
        ...(input.bootstrapEvents ?? []),
        ...(userMessage ? [userMessage] : []),
      ];
      let responseLanguage = hostLanguage;
      let failureRunId: string | undefined;
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
        const runId = this.agentRunReactor.id('project-root-unavailable-run');
        failureRunId = runId;
        const turnId = this.agentRunReactor.id('session-turn');
        const languageRevision = nextConversationLanguageRevision(existingEvents);
        events.push(createSessionTurnAuthorityEvent({
          sessionId: input.sessionId,
          runId,
          turnId,
          taskId: this.agentRunReactor.id('session-task'),
          messages: [{ messageId: userMessage.id, content: input.content }],
          relation: 'newTask',
          boundAtHookRef: 'run.projectRootUnavailable',
          languageRevision,
          hostLanguage,
          previousTaskId: previousAuthority?.taskId,
          eventId: this.agentRunReactor.id('session-turn-authority'),
          timestamp: this.agentRunReactor.ts(),
        }));
        events.push(createSessionLanguageDecisionEvent({
          sessionId: input.sessionId,
          runId,
          turnId,
          revision: languageRevision,
          status: 'fallback',
          responseLanguage: hostLanguage,
          decisionSource: 'hostFallbackMissing',
          eventId: this.agentRunReactor.id('session-language-fallback'),
          timestamp: this.agentRunReactor.ts(),
        }));
      } else {
        const authority = latestSessionTurnAuthority(existingEvents);
        if (authority) {
          failureRunId = authority.runId;
          const policy = resolveConversationLanguagePolicy(existingEvents, authority);
          responseLanguage = effectiveConversationLanguage(policy);
          if (policy.status === 'pending') {
            responseLanguage = policy.hostLanguage;
            events.push(createSessionLanguageDecisionEvent({
              sessionId: authority.sessionId,
              runId: authority.runId,
              turnId: authority.turnId,
              revision: authority.languagePolicy.revision,
              status: 'fallback',
              responseLanguage,
              decisionSource: 'hostFallbackMissing',
              eventId: this.agentRunReactor.id('session-language-fallback'),
              timestamp: this.agentRunReactor.ts(),
            }));
          }
        }
      }
      if (!failureRunId) {
        throw new SessionDriverLoopError(
          'session_turn_authority_unavailable',
          'Project-root failure cannot bootstrap a run without an exact turn authority.'
        );
      }
      events.push(sessionProgressProjectionBuilder.sessionRunStateEvent({
        sessionId: input.sessionId,
        runId: failureRunId,
        phase: 'context_reading',
        status: 'running',
        reason: 'session',
        decisionOwner: {
          kind: 'session',
          runId: failureRunId,
        },
        ts: this.agentRunReactor.ts(),
        id: this.agentRunReactor.id('session-run-project-root-bootstrap'),
      }));
      const bootstrapped = await this.agentRunReactor.append(
        input.sessionId,
        events
      );
      const diagnosticPresentationBinding =
        conversationPresentationLanguageBindingFromEvents(bootstrapped.events);
      const diagnosticId = this.agentRunReactor.id('project-root-unavailable');
      const terminalEvents = [assistantProjectionBuilder.finalDiagnosticEvent(
        input.sessionId,
        {
          code: 'project_root_unavailable',
          fallback: responseLanguage === 'zh-CN'
            ? '项目目录当前不可用。请重新绑定项目目录后再使用该项目会话。'
            : 'The project directory is unavailable. Rebind the project directory before using this project session.',
          params: { projectId: input.projectId },
        },
        this.agentRunReactor.ts(),
        diagnosticId,
        diagnosticPresentationBinding
      ), sessionProgressProjectionBuilder.sessionRunStateEvent({
        sessionId: input.sessionId,
        runId: failureRunId,
        phase: 'failed',
        status: 'failed',
        reason: 'driver_failure',
        decisionOwner: {
          kind: 'session',
          runId: failureRunId,
          targetId: diagnosticId,
        },
        ts: this.agentRunReactor.ts(),
        id: this.agentRunReactor.id('session-run-project-root-unavailable'),
      })];
      return this.agentRunReactor.append(input.sessionId, terminalEvents);
    }
    try {
      return mode === 'resumeRun'
        ? await this.runEngine.resume(input)
        : await this.runEngine.run(input);
    } catch (error) {
      // A rejected canonical append did not establish a new durable authority
      // boundary. A second diagnostic append could bind to an older turn or
      // manufacture an unowned terminal fact, so surface the admission failure
      // unchanged and let deterministic recovery inspect the durable store.
      if (
        error instanceof SessionAppendCoordinatorError
        || error instanceof SessionFactLineageError
        || error instanceof SessionGoalError
      ) {
        throw error;
      }
      const rawMessage = error instanceof Error ? error.message : String(error);
      const code = error instanceof SessionDriverLoopError
        ? error.code
        : stringValue(objectRecord(error)?.code) ?? 'run_engine_failed';
      const language = await this.localOutputLanguage(
        input.sessionId,
        undefined,
        input.hostLanguage
      );
      const runId = language.runId ?? latestRunIdForFailure(language.currentEvents);
      if (error instanceof SessionDriverLoopError && error.code === 'session_run_cancelled') {
        const cancellationRunId = runId ?? 'run-unavailable';
        return this.agentRunReactor.append(input.sessionId, [
          ...language.decisionEvents,
          sessionProgressProjectionBuilder.sessionRunStateEvent({
            sessionId: input.sessionId,
            runId: cancellationRunId,
            phase: 'cancelled',
            status: 'cancelled',
            reason: 'session',
            decisionOwner: {
              kind: 'session',
              runId: cancellationRunId,
            },
            ts: this.agentRunReactor.ts(),
            id: this.agentRunReactor.id('session-run-cancelled'),
          }),
        ]);
      }
      const diagnostic = driverFailureMessageCatalog.driverFailure(
        code,
        rawMessage,
        language.language
      );
      try {
        return await this.agentRunReactor.append(input.sessionId, [
          ...language.decisionEvents,
          ...sessionFailureProjectionBuilder.internalFailureEvents({
            sessionId: input.sessionId,
            runId: runId ?? 'run-unavailable',
            stage: 'run_engine',
            code: diagnostic.code,
            message: diagnostic.fallback,
            language: language.language,
            reason: 'driver_failure',
            ts: this.agentRunReactor.ts(),
            id: this.agentRunReactor.id('run-engine-failed'),
          }),
        ]);
      } catch (persistenceError) {
        const persistenceMessage = persistenceError instanceof Error
          ? persistenceError.message
          : String(persistenceError);
        throw new SessionDriverLoopError(
          'session_run_failure_persistence_failed',
          `Run initialization failed with ${code}: ${rawMessage}; persisting that failure also failed: ${persistenceMessage}`
        );
      }
    }
  }
}

function exactSemanticProviderRequestId(
  turn: Pick<LlmTurnResult, 'providerAdmission' | 'providerRequestId'>,
  context: string
): string {
  const admittedRequestId = turn.providerAdmission.requestId.trim();
  const reportedRequestId = turn.providerRequestId?.trim();
  if (!admittedRequestId) {
    throw new SessionDriverLoopError(
      'session_provider_admission_unavailable',
      `${context} has no canonical admitted Provider request identity.`
    );
  }
  if (reportedRequestId && reportedRequestId !== admittedRequestId) {
    throw new SessionDriverLoopError(
      'session_provider_admission_invalid',
      `${context} reported Provider request ${reportedRequestId}, but its canonical admission is ${admittedRequestId}.`
    );
  }
  return admittedRequestId;
}

function hasClosedHostRunFence(
  result: AgentSessionResult,
  hostRunId: string
): boolean {
  return result.domainState?.runFences.some(
    (fence) => fence.runId === hostRunId && fence.state === 'closed'
  ) ?? false;
}

function latestRunIdForFailure(events: AgentEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    const payload = objectRecord(event.payload);
    const runId = stringValue(payload?.runId);
    if (runId) return runId;
  }
  return undefined;
}

function resourcePacketActivityIdentity(
  runId: string,
  providerRequestId: string,
  toolCall: NativeToolCallProposal
): ResourcePacketActivityIdentity {
  const identityPart = (value: string): string => encodeURIComponent(value);
  return {
    activityId: [
      'resource',
      identityPart(runId),
      identityPart(providerRequestId),
      identityPart(toolCall.callId),
    ].join(':'),
    runId,
    providerRequestId,
    callId: toolCall.callId,
    toolName: toolCall.name,
  };
}

function resourceSemanticTerminalStatus(
  error: unknown
): 'failed' | 'cancelled' {
  return stringValue(objectRecord(error)?.code) === 'session_run_cancelled'
    ? 'cancelled'
    : 'failed';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
