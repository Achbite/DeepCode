import type {
  AgentEvent,
  AgentSessionResult,
} from '@deepcode/protocol';
import {
  AcceptedActionBundlePlanExecutor,
  AcceptedPlanActionProposalSubmitter,
  AcceptedPlanExecutionRootResolver,
  AcceptedPlanScopeDecisionCoordinator,
  AcceptedPlanScopeRepairCoordinator,
  AcceptedPlanScopeResourceFollowupCoordinator,
  AcceptedPlanReadOnlyTaskExecutor,
  ActionBundleAdmissionRepairCoordinator,
  ActionBundleAdmissionCoordinator,
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
import type { ProviderRepairMessageState } from '../prompt/ProviderRepairMessageBuilder.js';
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
  AcceptedPlanResourceResumeCoordinator,
  ActionBundleAdmissionResourceFollowupCoordinator,
  ProviderTurnContextCoordinator,
  ResourceOrchestrator,
  ResourceRequestProposalHandler,
  ResourceRequestRepairCoordinator,
} from './context/index.js';
import {
  AcceptedPlanReviewHandoffCoordinator,
  AcceptedPlanStaticSyntaxReviewCoordinator,
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
import { decisionContinuationInput, SameLoopContinuation } from './runContinuation.js';
import { RunEngine } from './runEngine.js';
import { diag, isEmptyResponseError, objectRecord, SessionDriverLoopError, stringValue, visibleLanguageForRequest } from './runtimeSupport.js';
import { AgentRunReactor } from './agentRunReactor.js';
import {
  acceptedImplementationPlanContextBuilder,
  acceptedPlanAdmission,
  acceptedPlanBatchPreflight,
  acceptedPlanExecutor,
  acceptedPlanResourceResumePromptBuilder,
  acceptedPlanScopeDecisionOverlay,
  acceptedPlanTaskLedger,
  assistantProjectionBuilder,
  contextFrameBuilder,
  driverActivityBuilder,
  driverFailureMessageCatalog,
  driverInteractionIndex,
  driverParseErrorCatalog,
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
  nativeToolRepairRunner,
  nativeToolResourceRecorder,
  nativeToolResultMessageBuilder,
  permissionPipeline,
  planContextIndex,
  planProjectionBuilder,
  planReviewGrantProjector,
  planReviewReportAnalyzer,
  proposalOnlyProviderRunner,
  protocolGate,
  providerContextSupport,
  providerJsonModeCoordinator,
  providerRepairMessageBuilder,
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
  private readonly proposalRouter: ProposalRouter;
  private readonly proposalRouteExecutor: ProposalRouteExecutor<SessionDriverLoopInput, SessionDriverLoopRunState>;
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
  private readonly providerRuntimeBridge: ProviderRuntimeBridge<SessionDriverLoopRunState, LlmTurnResult>;
  private readonly providerTurnContextCoordinator: ProviderTurnContextCoordinator<SessionDriverLoopRunState>;
  private readonly providerTurnCycle: ProviderTurnCycle<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly runEngine: RunEngine<SessionDriverLoopInput, SessionDriverLoopRunState>;
  private readonly runLifecyclePipeline: RunLifecyclePipeline<SessionDriverLoopRunState>;
  private readonly providerTurnRunner: ProviderTurnRunner<SessionDriverLoopRunState>;
  private readonly sameLoopContinuation: SameLoopContinuation<SessionDriverLoopInput>;

  constructor(private readonly ports: SessionDriverLoopPorts) {
    this.agentRunReactor = new AgentRunReactor<SessionDriverLoopRunState>({
      ports: this.ports,
      kernelProjection: kernelEventProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
      createError: (code, message) => new SessionDriverLoopError(code, message),
      errorCode: (error, fallback) => error instanceof SessionDriverLoopError ? error.code : fallback,
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
    });
    this.sameLoopContinuation = new SameLoopContinuation((resumeInput) => this.continueSameLoop(resumeInput));
    this.acceptedActionBundlePlanExecutor = new AcceptedActionBundlePlanExecutor({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      kernel: (request) => this.agentRunReactor.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      continueSameLoop: this.sameLoopContinuation.resumeUserTurn,
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
      recordKernelBatchProgress: (input) => acceptedPlanTaskLedger().recordKernelBatchProgress(input),
      runtimeSnapshot: (input) => acceptedPlanTaskLedger().runtimeSnapshot(input),
      acceptedPlanComplete: (accepted) => acceptedPlanTaskLedger().complete(accepted),
      executionRequest: (plan, acceptedPlan) => executionPromptCoordinator().executionRequest(plan, acceptedPlan),
      reviewHandoff: (handoffInput) => this.acceptedPlanReviewHandoffCoordinator.handoff(handoffInput),
    });
    this.acceptedPlanReadOnlyTaskExecutor = new AcceptedPlanReadOnlyTaskExecutor<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      continueSameLoop: this.sameLoopContinuation.runUserTurn,
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
        this.providerRuntimeBridge.runProposalOnly({
          profileId: handlerInput.profileId,
          state,
          prompt,
          contract,
          stage,
          messages,
        }),
      runRepair: (handlerInput, state, stage, messages) =>
        this.providerRuntimeBridge.llm(handlerInput.profileId, state, stage, messages),
      submitActionProposal: (handlerInput, state, prompt, proposal, fallback) =>
        this.actionProposalSubmitter.submit(handlerInput, state, prompt, proposal, fallback),
      submitNonExecutableProposal: (state, proposal, fallback) =>
        this.actionProposalSubmitter.submitNonExecutable(state, proposal, fallback),
    });
    this.acceptedPlanActionProposalSubmitter = new AcceptedPlanActionProposalSubmitter<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      kernel: (request) => this.agentRunReactor.kernel(request),
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
      appendThinking: async (state, message, idPrefix, metadata) => {
        await this.agentRunReactor.append(state.sessionId, [
          assistantProjectionBuilder.thinkingEvent(
            state.sessionId,
            message,
            this.agentRunReactor.ts(),
            this.agentRunReactor.id(idPrefix),
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
          runRepair: (stage, messages) => this.providerRuntimeBridge.llm(handlerInput.profileId, state, stage, messages),
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
      appendDiagnostic: (state, code, fallback, params, idPrefix) => this.agentRunReactor.append(state.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(
          state.sessionId,
          diag(code, fallback, params),
          this.agentRunReactor.ts(),
          this.agentRunReactor.id(idPrefix)
        ),
      ]),
      submitNonExecutableProposal: (state, proposal, fallback) =>
        this.actionProposalSubmitter.submitNonExecutable(state, proposal, fallback),
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
      hasFailureOrBlocker: (events) => kernelEventStatusIndex.hasFailureOrBlocker(events),
      actionBatchReadyForReview: (events) => kernelEventStatusIndex.actionBatchReadyForReview(events),
      hasPermissionRequest: (events) => kernelEventStatusIndex.hasPermissionRequest(events),
      permissionId: (events) => kernelEventStatusIndex.permissionId(events),
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
      continueSameLoop: this.sameLoopContinuation.runUserTurn,
      staticSyntaxReview: (reviewInput) => this.acceptedPlanStaticSyntaxReviewCoordinator.run(reviewInput),
      reviewHandoff: (handoffInput) => this.acceptedPlanReviewHandoffCoordinator.handoff(handoffInput),
    });
    this.acceptedPlanResourceResumeCoordinator = new AcceptedPlanResourceResumeCoordinator<SessionDriverLoopRunState>({
      promptBuilder: acceptedPlanResourceResumePromptBuilder,
      contextFrameBuilder,
      repairMessageBuilder: providerRepairMessageBuilder,
      repairState: (state) => providerContextSupport.repairMessageState(state),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      parseError: (error) => driverParseErrorCatalog.normalize(error),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      appendRepairNotice: (state, message) => this.agentRunReactor.append(state.sessionId, [
        assistantProjectionBuilder.thinkingEvent(
          state.sessionId,
          message,
          this.agentRunReactor.ts(),
          this.agentRunReactor.id('accepted-plan-resource-resume-repair')
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
      contextFrameBuilder,
      repairState: (state) => providerContextSupport.repairMessageState(state),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      parseError: (error) => driverParseErrorCatalog.normalize(error),
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
        this.providerRuntimeBridge.llm(profileId, state, stage, messages),
      event: (sessionId, kind, payload) => this.agentRunReactor.event(sessionId, kind, payload),
      reviewAssembler: reviewAssembler(),
      contextFrameBuilder,
    });
    this.permissionDecisionHandler = new PermissionDecisionHandler<SessionPlanContext>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      kernel: (request) => this.agentRunReactor.kernel(request),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      permissionPipeline,
      kernelStatus: kernelEventStatusIndex,
      planIndex: planContextIndex,
      reviewProjection: reviewProjectionBuilder,
      progressProjection: sessionProgressProjectionBuilder,
    });
    this.planDecisionHandler = new PlanDecisionHandler({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      resumeUserTurn: this.sameLoopContinuation.resumeUserTurn,
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
      resumeUserTurn: this.sameLoopContinuation.resumeUserTurn,
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
      resumeUserTurn: this.sameLoopContinuation.resumeUserTurn,
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
      capabilityCatalogSummary: (state) => nativeToolCoordinator.capabilityCatalogSummary(state),
      collectUserGuidanceEvents: (events, runId) => collectUserGuidanceEvents(events, runId),
      buildProviderTurnContract: (contractInput) =>
        contextFrameBuilder.buildSessionProviderTurnContract(contractInput),
      callProviderAndParse: (handlerInput, state, prompt) =>
        this.providerProposalCoordinator.callAndParse(handlerInput, state, prompt),
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
      capabilityCatalogSummary: (state) => nativeToolCoordinator.capabilityCatalogSummary(state),
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
      runRevision: (revisionInput, state, messages) =>
        this.providerRuntimeBridge.llm(revisionInput.profileId, state, 'guidance_revision', messages),
      parseProposal: (raw, state) =>
        protocolGate().parseAndValidateProposal({
          raw,
          runId: state.runId,
          sessionId: state.sessionId,
          source: 'llm',
        }),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      contextFrameBuilder,
    });
    this.actionBundleAdmissionRepairCoordinator = new ActionBundleAdmissionRepairCoordinator<SessionDriverLoopRunState>({
      repairMessageBuilder: providerRepairMessageBuilder,
      contextFrameBuilder,
      repairState: (state) => providerContextSupport.repairMessageState(state),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      parseError: (error) => driverParseErrorCatalog.normalize(error),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      parseRepairedProposal: ({ raw, state, allowedKinds }) => protocolGate().parseAndValidateRepairedProposal({ raw, runId: state.runId, sessionId: state.sessionId, source: 'llm', allowedKinds }),
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
      repairResourceRequest: (input, state, prompt, proposal, resolution) =>
        this.resourceRequestRepairCoordinator.repair({
          state,
          prompt,
          proposal,
          resolutionDiagnostic: resourceRequestLoop.resolutionDiagnostic(resolution).fallback,
          runRepair: (stage, messages) => this.providerRuntimeBridge.llm(input.profileId, state, stage, messages),
        }),
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
        this.actionProposalSubmitter.submit(input, state, prompt, proposal, fallback),
      submitNonExecutableProposal: (state, proposal, fallback) =>
        this.actionProposalSubmitter.submitNonExecutable(state, proposal, fallback),
      errorMessage: (error) => error instanceof Error ? error.message : String(error),
    });
    this.acceptedPlanScopeResourceFollowupCoordinator = new AcceptedPlanScopeResourceFollowupCoordinator<SessionDriverLoopRunState, AcceptedImplementationPlanContext>({
      generatedEvidence: generatedArtifactEvidenceIndex(),
      resolver: resourceRequestResolver(),
      resourceLoop: resourceRequestLoop,
      orchestrator: this.resourceOrchestrator,
      createId: (prefix) => this.agentRunReactor.id(prefix),
      appendFailure: ({ state, detail, eventId }) => this.agentRunReactor.append(state.sessionId, [
        assistantProjectionBuilder.finalDiagnosticEvent(
          state.sessionId,
          diag(
            'autoBatchResourceResolveFailed',
            `Automatic execution batch requires additional resource evidence, but the repaired resourceRequest could not be located: ${detail}`,
            { detail }
          ),
          this.agentRunReactor.ts(),
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
      createId: (prefix) => this.agentRunReactor.id(prefix),
      appendFailure: ({ state, proposal, reasons, eventId }) => this.agentRunReactor.append(
        state.sessionId,
        sessionFailureProjectionBuilder.actionBundleAdmissionFailureEvents(
          state.sessionId,
          state.runId,
          proposal,
          reasons,
          this.agentRunReactor.ts(),
          eventId
        )
      ),
      followupRequest: (request) => repairLoop.actionBundleAdmissionResourceFollowupRequest(request),
    });
    this.actionBundleAdmissionCoordinator = new ActionBundleAdmissionCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
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
          runRepair: (stage, messages) => this.providerRuntimeBridge.llm(repairInput.input.profileId, repairInput.state, stage, messages),
        }),
      repairErrorMessage: (error) =>
        error instanceof SessionDriverLoopError ? error.message : driverParseErrorCatalog.message(error),
      resourceFollowup: (followupInput) =>
        this.actionBundleAdmissionResourceFollowupCoordinator.handle(followupInput),
      resumeAfterResourceFollowup: ({ originalInput, followup }) =>
        this.sameLoopContinuation.runUserTurn(decisionContinuationInput(originalInput, {
          content: followup.content,
          attachments: originalInput.attachments ?? [],
          existingEvents: followup.result.events,
          reviewContinuationMode: originalInput.reviewContinuationMode,
          resumeResourcePackets: true,
        })),
      submitActionProposal: (handlerInput, state, prompt, proposal, fallback) =>
        this.actionProposalSubmitter.submit(handlerInput, state, prompt, proposal, fallback),
      submitNonExecutableProposal: (state, proposal, fallback) =>
        this.actionProposalSubmitter.submitNonExecutable(state, proposal, fallback),
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
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      appendProjectedKernelEvents: (sessionId, reply) => this.agentRunReactor.appendProjectedKernelEvents(sessionId, reply),
      readActionBundle: (proposal) => driverActivityBuilder.readActionBundle(proposal),
      actionBundleAdmissionBatch: (proposal) => driverActivityBuilder.proposalActionBundleAdmissionBatch(proposal),
      deleteAdmissionReasons: (batch, resourcePackets) =>
        acceptedPlanBatchPreflight.deleteReasons(batch, resourcePackets),
      repairActionBundleAdmission: (handlerInput, state, prompt, proposal, reasons, fallback) =>
        this.actionBundleAdmissionCoordinator.repair(handlerInput, state, prompt, proposal, reasons, fallback),
      submitAcceptedPlanActionProposal: (handlerInput, state, prompt, proposal, fallback) =>
        this.acceptedPlanActionProposalSubmitter.submit(handlerInput, state, prompt, proposal, fallback),
      submitProposal: (state, proposal, requestId) => this.agentRunReactor.kernel({
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
          providerContextSupport.repairMessageState(state),
          proposal,
          report
        ),
      runRepair: (handlerInput, state, stage, messages) =>
        this.providerRuntimeBridge.llm(handlerInput.profileId, state, stage, messages),
      parseRepairedProposal: (raw, state, allowedKinds) => protocolGate().parseAndValidateRepairedProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowedKinds,
      }),
      repairErrorMessage: (error) => driverParseErrorCatalog.message(error),
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
      contextFrameBuilder,
      repairState: (state) => providerContextSupport.repairMessageState(state),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      parseError: (error) => driverParseErrorCatalog.normalize(error),
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
      event: (sessionId, kind, payload) => this.agentRunReactor.event(sessionId, kind, payload),
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
    });
    this.nativeToolProviderCoordinator = new NativeToolProviderCoordinator<SessionDriverLoopRunState, LlmTurnResult>({
      providerLoop: nativeToolProviderLoop,
      handlerPortsFactory: this.nativeToolHandlerPortsFactory,
      repairRunner: nativeToolRepairRunner,
      providerTools: (state) =>
        nativeToolExposurePolicy.providerTools(state, nativeToolCoordinator.providerTools(state)),
      readManifest: (state, toolCall) => nativeToolCoordinator.readManifest(state, toolCall),
      resolveResource: (state, manifest) => this.resourceOrchestrator.resolve(state, manifest),
      runTurn: (profileId, state, stage, messages, options) =>
        this.providerRuntimeBridge.llmTurn(profileId, state, stage, messages, options),
      isEmptyResponseError,
      consumeGuidanceMessages: (state, stage) =>
        this.providerRuntimeBridge.consumeGuidanceMessages(state, stage),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
      buildSideEffectRepairMessages: (prompt, state, toolCall, turn, acceptedExecution) =>
        providerRepairMessageBuilder.sideEffectNativeToolRepairMessages(
          prompt,
          providerContextSupport.repairMessageState(state),
          toolCall,
          turn,
          acceptedExecution
        ),
      buildDuplicateRepairMessages: (prompt, state, turn, duplicates, acceptedExecution) =>
        providerRepairMessageBuilder.nativeToolDuplicateRepairMessages(
          prompt,
          providerContextSupport.repairMessageState(state),
          turn,
          duplicates,
          acceptedExecution
        ),
      runRepair: (profileId, state, stage, messages) => this.providerRuntimeBridge.llm(profileId, state, stage, messages),
      repairErrorMessage: (error) => driverParseErrorCatalog.message(error),
      createError: (code, message) => new SessionDriverLoopError(code, message),
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
      proposalOnlyProviderRunner,
      providerTurnRunner: this.providerTurnRunner,
    }, {
      ...this.ports,
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      emitProjectionDelta: (state, delta) => this.agentRunReactor.emitProjectionDelta(state, delta),
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
      acceptedPlanId: (state) => state.acceptedImplementationPlan?.planId,
      buildProposalOnlyRepairMessages: ({ prompt, state, toolCall, turn }) =>
        providerRepairMessageBuilder.completeStageToolViolationRepairMessages(
          prompt,
          providerContextSupport.repairMessageState(state),
          toolCall,
          turn
        ),
      repairErrorMessage: (error) => driverParseErrorCatalog.message(error),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      isEmptyResponseError,
    });
    this.providerProposalCoordinator = new ProviderProposalCoordinator<SessionDriverLoopInput, SessionDriverLoopRunState>({
      append: (sessionId, events) => this.agentRunReactor.append(sessionId, events),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      now: () => this.agentRunReactor.ts(),
      thinkingEvent: (sessionId, content, ts, id) =>
        assistantProjectionBuilder.thinkingEvent(sessionId, content, ts, id),
      providerResult: (providerInput, state, prompt, contract) =>
        state.acceptedImplementationPlan
          ? this.providerRuntimeBridge.runProposalOnly({
            profileId: providerInput.profileId,
            state,
            prompt,
            contract,
            stage: 'accepted_plan_provider_call',
          })
          : this.providerRuntimeBridge.runWithNativeTools({
            profileId: providerInput.profileId,
            state,
            prompt,
            contract,
          }),
      runRepair: (providerInput, state, stage, messages) =>
        this.providerRuntimeBridge.llm(providerInput.profileId, state, stage, messages),
      repairMessageState: (state) => providerContextSupport.repairMessageState(state),
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
        providerTurnPolicy.shouldAttemptActionBundleCompactionRepair(state),
      normalizeParseError: (error) => driverParseErrorCatalog.normalize(error),
      createError: (code, message) => new SessionDriverLoopError(code, message),
      isDriverErrorCode: (error, code) =>
        error instanceof SessionDriverLoopError && error.code === code,
    });
    this.providerTurnContextCoordinator = new ProviderTurnContextCoordinator<SessionDriverLoopRunState>({
      now: () => this.agentRunReactor.ts(),
      createId: (prefix) => this.agentRunReactor.id(prefix),
      assembleContext: (contextInput) => assembleContext(contextInput),
      allowedProposals: (kernelAllowed, state) =>
        providerTurnPolicy.allowedProposals(kernelAllowed, state),
      capabilityCatalogSummary: (state) => nativeToolCoordinator.capabilityCatalogSummary(state),
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
      routeProposal: (proposal) => this.proposalRouter.route(proposal),
      executeRoutedProposal: (routerInput) => this.proposalRouteExecutor.execute(routerInput),
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
    });
  }

  async resolveDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    return this.decisionResolver.resolve(input);
  }

  async runUserTurn(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    return this.runLoopInput(input);
  }

  private async continueSameLoop(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    return this.runLoopInput(input, 'continueSameLoop');
  }

  private async runLoopInput(
    input: SessionDriverLoopInput,
    mode: 'userTurn' | 'continueSameLoop' = 'userTurn'
  ): Promise<AgentSessionResult> {
    try {
      return mode === 'continueSameLoop'
        ? await this.runEngine.continueSameLoop(input)
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
