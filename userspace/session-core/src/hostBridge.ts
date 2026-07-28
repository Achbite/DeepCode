import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentTimelineDelta,
  AgentTimelineResult,
  AgentTimelineSnapshot,
  AgentWorkspaceBinding,
  ApiResponse,
  ConversationLanguage,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
  LlmChatStreamEvent,
  ProjectionDelta,
  GoalProjectionV1,
  SessionAppendCommandV1,
  SessionAppendErrorDetailsV1,
  ToolCall,
} from '@deepcode/protocol';
import { canonicalJson } from './cache/canonicalizer.js';
import { buildSessionMemorySnapshot } from './context/memory.js';
import { SessionDriverLoop } from './driver/sessionDriverLoop.js';
import type { SessionDecisionResolverInput } from './driver/types.js';
import {
  CanonicalTimelineProjector,
  normalizeAgentTimelineSnapshot,
} from './timelineDelta.js';
import { SessionStorageClient } from './storageClient.js';
import type { ProjectWorkingDirectory } from './context/types.js';
import { planInteractionAwaitsDecision } from './run-state/planInteractionState.js';
import {
  ProjectionDeliveryRecorder,
  projectionDeliveryContentMetadata,
  projectionDeliveryMetadataForTimelineDelta,
} from './projectionDelivery.js';
import {
  SessionAppendCoordinator,
  SessionAppendCoordinatorError,
  type PreparedCanonicalSessionAppend,
  type SessionAppendInteractionContext,
  type SessionRunBootstrapContext,
} from './driver/authority/sessionAppendCoordinator.js';
import {
  readSessionGoal,
  SessionGoalError,
  type SessionGoalOperationContext,
} from './goal/index.js';

declare const process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdin: AsyncIterable<unknown>;
  stdout: { write(value: string, callback?: () => void): boolean };
  stderr: { write(value: string): void };
  exit(code?: number): never;
};

interface HostBridgeRequest {
  op:
    | 'ask'
    | 'resolveDecision'
    | 'startGoal'
    | 'resolveGoalInteraction'
    | 'advanceGoal'
    | 'resumeGoal'
    | 'cancelGoal'
    | 'readGoal';
  apiBase?: string;
  sessionId?: string;
  hostRunId?: string;
  prompt?: string;
  attachments?: AgentContextAttachment[];
  workspacePath?: string;
  workspaceBinding?: AgentWorkspaceBinding;
  noWorkspace?: boolean;
  projectId?: string;
  projectKind?: 'folder' | 'blank';
  projectRootStatus?: 'ready' | 'unbound' | 'unavailable';
  profileId?: string;
  workflow?: 'planFirst' | 'actOnRequest';
  requirementConfirmationMode?: 'off' | 'auto' | 'always';
  reviewContinuationMode?: 'auto' | 'ask' | 'off';
  interventionLevel?: 'low' | 'medium' | 'high';
  autonomyMode?: 'strict' | 'trustedWorkspace' | 'maximum';
  projectMemoryMode?: 'confirm' | 'auto';
  title?: string;
  decisionKind?: SessionDecisionResolverInput['kind'];
  decision?: 'accept' | 'reject' | 'revise';
  guidance?: string;
  runId?: string;
  targetId?: string;
  interactionId?: string;
  interactionRevision?: string;
  decisionRequestId?: string;
  reviewId?: string;
  hostLanguage?: ConversationLanguage;
  bootstrapToken?: string;
  bootstrapAdmissionId?: string;
  bootstrapEvents?: AgentEvent[];
  goalId?: string;
  goalRevision?: number;
  objective?: string;
  callerRequestId?: string;
  requestDigest?: string;
  expectedDomainHeadDigest?: string;
  predecessorGoalRef?: {
    goalId: string;
    goalRevision: number;
  };
  sessionResult?: AgentSessionResult;
  conversationProjection?: AgentTimelineResult;
}

interface HostBridgeResult {
  ok: boolean;
  sessionId?: string;
  session?: unknown;
  events?: unknown[];
  timeline?: AgentTimelineResult;
  finalText?: string;
  runStatus?: 'waiting' | 'completed' | 'failed' | string;
  decisionKind?: string;
  targetId?: string;
  terminalReason?: string;
  message?: string;
  error?: string;
  goalProjection?: GoalProjectionV1 | null;
}

const MEMORY_ARCHIVE_PERSIST_TIMEOUT_MS = 2_000;
const HOST_RUN_CANCELLATION_POLL_MS = 50;

interface HostRunCancellationContext {
  apiBase: string;
  sessionId: string;
  hostRunId: string;
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    const request = JSON.parse(raw || '{}') as HostBridgeRequest;
    let result: HostBridgeResult;
    switch (request.op) {
      case 'ask':
      case 'startGoal':
        result = await runAsk(request);
        break;
      case 'resolveDecision':
      case 'resolveGoalInteraction':
        result = await resolveDecision(request);
        break;
      case 'readGoal':
        result = readGoal(request);
        break;
      case 'advanceGoal':
        result = await advanceGoal(request);
        break;
      case 'resumeGoal':
      case 'cancelGoal':
        result = await mutateGoalLifecycle(request);
        break;
      default:
        throw new SessionGoalError(
          'session_host_bridge_operation_invalid',
          `Unknown Session HostBridge operation ${String((request as { op?: unknown }).op)}.`
        );
    }
    await writeJson(result);
    process.exit(0);
  } catch (error) {
    const code = error instanceof SessionGoalError
      ? error.code
      : error instanceof SessionAppendCoordinatorError
        ? error.code
        : 'session_host_bridge_failed';
    await writeJson({
      ok: false,
      error: code,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

async function advanceGoal(
  request: HostBridgeRequest
): Promise<HostBridgeResult> {
  if (!request.sessionId) {
    throw new SessionGoalError(
      'session_goal_request_invalid',
      'Goal advance requires sessionId.'
    );
  }
  const apiBase = normalizeApiBase(request.apiBase);
  const hostRunId = requiredHostRunId(request);
  const goalContext = goalOperationContext(request);
  if (!goalContext || goalContext.operation !== 'advance') {
    throw new SessionGoalError(
      'session_goal_request_invalid',
      'Goal advance requires an admitted Goal operation context.'
    );
  }
  const current = await getAgentSession(apiBase, request.sessionId);
  const initialTimeline = await loadAgentTimeline(
    apiBase,
    request.sessionId,
    current.events
  );
  const initialCacheTelemetry = await loadCacheTelemetryEvents(
    apiBase,
    request.sessionId
  );
  const binding = request.noWorkspace
    ? undefined
    : request.workspaceBinding
      ?? workspaceBindingFromPath(request.workspacePath);
  const projectWorkingDirectory = request.noWorkspace
    ? undefined
    : projectWorkingDirectoryFromBinding(binding, request.workspacePath);
  const deliveryRecorder = createProjectionDeliveryRecorder(
    apiBase,
    request.sessionId,
    hostRunId
  );
  const projection = createProjectionPublishingDriver(
    apiBase,
    hostRunId,
    request.sessionId,
    current,
    initialTimeline,
    initialCacheTelemetry,
    deliveryRecorder,
    undefined,
    bootstrapContext(request),
    goalContext
  );
  try {
    const result = await projection.driver.advanceGoalStep({
      sessionId: request.sessionId,
      hostRunId,
      content: request.objective ?? '',
      existingEvents: current.events,
      workspaceBinding: binding,
      projectWorkingDirectory,
      projectId: request.projectId,
      projectKind: request.projectKind,
      projectRootStatus: request.projectRootStatus,
      profileId: request.profileId,
      reviewContinuationMode: request.reviewContinuationMode,
      interventionLevel: request.interventionLevel,
      autonomyMode: request.autonomyMode,
      projectMemoryMode: request.projectMemoryMode,
      hostLanguage: request.hostLanguage,
      goalContext,
    });
    const timeline = projection.buildTimeline(result.events ?? []);
    const finalText = extractFinalText(timeline);
    return {
      ok: true,
      sessionId: result.session.id,
      session: result.session,
      events: result.events,
      timeline,
      finalText,
      ...inferHostRunLifecycle(result.events, finalText),
    };
  } finally {
    await deliveryRecorder?.close();
  }
}

async function mutateGoalLifecycle(
  request: HostBridgeRequest
): Promise<HostBridgeResult> {
  if (
    !request.sessionId
    || (request.op !== 'resumeGoal' && request.op !== 'cancelGoal')
  ) {
    throw new SessionGoalError(
      'session_goal_request_invalid',
      'Goal lifecycle mutation requires sessionId and an exact operation.'
    );
  }
  const apiBase = normalizeApiBase(request.apiBase);
  const hostRunId = requiredHostRunId(request);
  const goalContext = goalOperationContext(request);
  const expectedOperation = request.op === 'resumeGoal' ? 'resume' : 'cancel';
  if (!goalContext || goalContext.operation !== expectedOperation) {
    throw new SessionGoalError(
      'session_goal_request_invalid',
      `Goal ${expectedOperation} requires an admitted operation context.`
    );
  }
  const current = await getAgentSession(apiBase, request.sessionId);
  const initialTimeline = await loadAgentTimeline(
    apiBase,
    request.sessionId,
    current.events
  );
  const initialCacheTelemetry = await loadCacheTelemetryEvents(
    apiBase,
    request.sessionId
  );
  const deliveryRecorder = createProjectionDeliveryRecorder(
    apiBase,
    request.sessionId,
    hostRunId
  );
  const projection = createProjectionPublishingDriver(
    apiBase,
    hostRunId,
    request.sessionId,
    current,
    initialTimeline,
    initialCacheTelemetry,
    deliveryRecorder,
    undefined,
    bootstrapContext(request),
    goalContext
  );
  try {
    const driverInput = {
      sessionId: request.sessionId,
      hostRunId,
      content: request.objective ?? '',
      existingEvents: current.events,
      hostLanguage: request.hostLanguage,
      goalContext,
    };
    const result = request.op === 'resumeGoal'
      ? await projection.driver.resumeGoal(driverInput)
      : await projection.driver.cancelGoal(driverInput);
    const timeline = projection.buildTimeline(result.events ?? []);
    const finalText = extractFinalText(timeline);
    return {
      ok: true,
      sessionId: result.session.id,
      session: result.session,
      events: result.events,
      timeline,
      finalText,
      ...inferHostRunLifecycle(result.events, finalText),
    };
  } finally {
    await deliveryRecorder?.close();
  }
}

async function runAsk(request: HostBridgeRequest): Promise<HostBridgeResult> {
  const content = request.prompt?.trim();
  if (!content) throw new Error('prompt is required');

  const apiBase = normalizeApiBase(request.apiBase);
  const hostRunId = requiredHostRunId(request);
  const binding = request.noWorkspace ? undefined : request.workspaceBinding ?? workspaceBindingFromPath(request.workspacePath);
  const projectWorkingDirectory = request.noWorkspace ? undefined : projectWorkingDirectoryFromBinding(binding, request.workspacePath);
  const scope = binding ? { workspaceId: binding.workspaceId, workspaceHash: binding.workspaceHash } : {};
  const sessionResult = request.sessionId
    ? await activateSession(apiBase, request.sessionId)
    : await currentOrCreateSession(apiBase, scope, request.title ?? content);

  const sessionId = sessionResult.session.id;
  const initialTimeline = await loadAgentTimeline(
    apiBase,
    sessionId,
    sessionResult.events ?? []
  );
  const initialCacheTelemetry = await loadCacheTelemetryEvents(apiBase, sessionId);
  const existingEvents = sessionResult.events;
  const deliveryRecorder = createProjectionDeliveryRecorder(
    apiBase,
    sessionId,
    hostRunId
  );
  const projection = createProjectionPublishingDriver(
    apiBase,
    hostRunId,
    sessionId,
    sessionResult,
    initialTimeline,
    initialCacheTelemetry,
    deliveryRecorder,
    undefined,
    bootstrapContext(request),
    goalOperationContext(request)
  );
  try {
    const driver = projection.driver;
    const result = await driver.runUserTurn({
      sessionId,
      hostRunId,
      content,
      attachments: request.attachments ?? [],
      existingEvents,
      workspaceBinding: binding,
      projectWorkingDirectory,
      projectId: request.projectId,
      projectKind: request.projectKind,
      projectRootStatus: request.projectRootStatus,
      profileId: request.profileId,
      workflow: request.op === 'startGoal' ? 'planFirst' : request.workflow,
      requirementConfirmationMode: request.requirementConfirmationMode,
      reviewContinuationMode: request.reviewContinuationMode,
      interventionLevel: request.interventionLevel,
      autonomyMode: request.autonomyMode,
      hostLanguage: request.hostLanguage,
      bootstrapEvents: request.bootstrapEvents,
      goalContext: goalOperationContext(request),
    });
    await persistMemoryArchive(apiBase, result.session.id, result.events ?? [], binding, result.session, request.projectMemoryMode);
    const timeline = projection.buildTimeline(result.events ?? []);
    const finalText = extractFinalText(timeline);
    const lifecycle = inferHostRunLifecycle(result.events, finalText);
    return {
      ok: true,
      sessionId: result.session.id,
      session: result.session,
      events: result.events,
      timeline,
      finalText,
      ...lifecycle,
    };
  } finally {
    await deliveryRecorder?.close();
  }
}

async function resolveDecision(request: HostBridgeRequest): Promise<HostBridgeResult> {
  if (!request.sessionId) throw new Error('sessionId is required');
  if (!request.decisionKind) throw new Error('decisionKind is required');
  if (!request.decision) throw new Error('decision is required');

  const apiBase = normalizeApiBase(request.apiBase);
  const hostRunId = requiredHostRunId(request);
  const current = await getAgentSession(apiBase, request.sessionId);
  const initialTimeline = await loadAgentTimeline(
    apiBase,
    request.sessionId,
    current.events
  );
  const initialCacheTelemetry = await loadCacheTelemetryEvents(
    apiBase,
    request.sessionId
  );
  const existingEvents = current.events;
  assertDecisionAdmissionIdentity(request, existingEvents, initialTimeline);
  const binding = request.noWorkspace ? undefined : request.workspaceBinding ?? workspaceBindingFromPath(request.workspacePath);
  const projectWorkingDirectory = request.noWorkspace ? undefined : projectWorkingDirectoryFromBinding(binding, request.workspacePath);
  const deliveryRecorder = createProjectionDeliveryRecorder(
    apiBase,
    request.sessionId,
    hostRunId
  );
  const projection = createProjectionPublishingDriver(
    apiBase,
    hostRunId,
    request.sessionId,
    current,
    initialTimeline,
    initialCacheTelemetry,
    deliveryRecorder,
    interactionContext(request),
    bootstrapContext(request),
    goalOperationContext(request)
  );
  try {
    const driver = projection.driver;
    const result = await driver.resolveDecision({
      sessionId: request.sessionId,
      hostRunId,
      kind: request.decisionKind,
      decision: request.decision,
      guidance: request.guidance,
      runId: request.runId,
      targetId: request.targetId,
      interactionId: request.interactionId,
      interactionRevision: request.interactionRevision,
      decisionRequestId: request.decisionRequestId,
      reviewId: request.reviewId,
      existingEvents,
      workspaceBinding: binding,
      projectWorkingDirectory,
      projectId: request.projectId,
      projectKind: request.projectKind,
      projectRootStatus: request.projectRootStatus,
      profileId: request.profileId,
      workflow: request.workflow,
      reviewContinuationMode: request.reviewContinuationMode,
      interventionLevel: request.interventionLevel,
      autonomyMode: request.autonomyMode,
      projectMemoryMode: request.projectMemoryMode,
      hostLanguage: request.hostLanguage,
      bootstrapEvents: request.bootstrapEvents,
      goalContext: goalOperationContext(request),
    });
    await persistMemoryArchive(apiBase, result.session.id, result.events ?? [], binding, result.session, request.projectMemoryMode);
    const timeline = projection.buildTimeline(result.events ?? []);
    const finalText = extractFinalText(timeline);
    const lifecycle = goalInteractionHostLifecycle(request, result.events)
      ?? inferHostRunLifecycle(result.events, finalText);
    return {
      ok: true,
      sessionId: result.session.id,
      session: result.session,
      events: result.events,
      timeline,
      finalText,
      ...lifecycle,
    };
  } finally {
    await deliveryRecorder?.close();
  }
}

function readGoal(request: HostBridgeRequest): HostBridgeResult {
  const sessionResult = request.sessionResult;
  const conversationProjection = request.conversationProjection;
  if (
    !sessionResult
    || !isAgentSessionResult(sessionResult)
    || sessionResult.appendWriteability.status !== 'writable'
    || !sessionResult.domainState
  ) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      'Goal read requires a writable canonical Session snapshot.'
    );
  }
  if (
    !conversationProjection
    || conversationProjection.schemaVersion
      !== 'deepcode.shared-conversation-projection.v2'
  ) {
    throw new SessionGoalError(
      'session_goal_projection_stale',
      'Goal read requires Shared Conversation Projection v2.'
    );
  }
  const result = readSessionGoal({
    sessionId: sessionResult.session.id,
    events: sessionResult.events,
    domainState: sessionResult.domainState,
    conversationProjection,
    goalId: request.goalId,
  });
  return {
    ok: true,
    sessionId: sessionResult.session.id,
    goalProjection: result.projection,
  };
}

function goalOperationContext(
  request: HostBridgeRequest
): SessionGoalOperationContext | undefined {
  const operation = request.op === 'startGoal'
    ? 'start'
    : request.op === 'resolveGoalInteraction'
      ? 'resolveInteraction'
      : request.op === 'advanceGoal'
        ? 'advance'
        : request.op === 'resumeGoal'
          ? 'resume'
          : request.op === 'cancelGoal'
            ? 'cancel'
            : undefined;
  if (!operation) return undefined;
  const goalId = requiredGoalString(request.goalId, 'goalId');
  const callerRequestId = requiredGoalString(
    request.callerRequestId,
    'callerRequestId'
  );
  const requestDigest = requiredGoalString(
    request.requestDigest,
    'requestDigest'
  );
  const expectedDomainHeadDigest = requiredGoalString(
    request.expectedDomainHeadDigest,
    'expectedDomainHeadDigest'
  );
  if (
    !Number.isSafeInteger(request.goalRevision)
    || (request.goalRevision ?? 0) < 1
  ) {
    throw new SessionGoalError(
      'session_goal_revision_conflict',
      'Goal operation requires a positive safe goalRevision.'
    );
  }
  const objective = operation === 'start'
    ? requiredGoalString(request.objective ?? request.prompt, 'objective')
    : request.objective;
  return {
    operation,
    goalId,
    goalRevision: request.goalRevision!,
    objective,
    expectedDomainHeadDigest,
    command: {
      callerRequestId,
      requestDigest,
      hostRunId: requiredHostRunId(request),
    },
    predecessorGoalRef: request.predecessorGoalRef,
  };
}

function requiredGoalString(
  value: string | undefined,
  field: string
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new SessionGoalError(
      'session_goal_request_invalid',
      `Goal operation requires ${field}.`
    );
  }
  return normalized;
}

function goalInteractionHostLifecycle(
  request: HostBridgeRequest,
  events: readonly AgentEvent[]
): Pick<
  HostBridgeResult,
  'runStatus' | 'decisionKind' | 'targetId' | 'terminalReason'
> | undefined {
  if (request.op !== 'resolveGoalInteraction') return undefined;
  const callerRequestId = request.callerRequestId?.trim();
  if (!callerRequestId) return undefined;
  const terminalFact = [...events].reverse().find((event) => {
    if (event.kind !== 'session_goal_fact') return false;
    const payload = objectRecord(event.payload);
    const command = objectRecord(payload?.command);
    return stringField(command, 'callerRequestId') === callerRequestId
      && (
        payload?.factKind === 'activated'
        || payload?.factKind === 'cancelled'
      );
  });
  if (!terminalFact) return undefined;
  const payload = objectRecord(terminalFact.payload);
  return {
    runStatus: 'completed',
    decisionKind: request.decisionKind,
    targetId: request.targetId,
    terminalReason: payload?.factKind === 'activated'
      ? 'Goal Plan interaction settled and the Goal is active.'
      : 'Goal Plan interaction settled and the Goal was cancelled.',
  };
}

async function persistMemoryArchive(
  apiBase: string,
  sessionId: string,
  events: AgentEvent[],
  binding: AgentWorkspaceBinding | undefined,
  session: unknown,
  projectMemoryMode: 'confirm' | 'auto' | undefined
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEMORY_ARCHIVE_PERSIST_TIMEOUT_MS);
  try {
    const client = new SessionStorageClient(apiBase);
    const snapshot = buildSessionMemorySnapshot(events, {
      sessionId,
      workspaceScopeKey: binding?.workspaceHash ?? binding?.workspaceId,
      displayProjectName: binding?.openPath,
      displaySessionName: sessionTitle(session) ?? sessionId,
      projectMemoryMode,
    });
    await client.persistMemoryArchive(sessionId, snapshot, controller.signal);
  } catch (error) {
    process.stderr.write(`memory archive persist skipped: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    clearTimeout(timeout);
  }
}

function sessionTitle(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const title = (value as Record<string, unknown>).title;
  return typeof title === 'string' && title.trim() ? title : undefined;
}

function createProjectionPublishingDriver(
  apiBase: string,
  hostRunId: string,
  sessionId: string,
  initialResult: AgentSessionResult,
  initialTimeline?: AgentTimelineSnapshot,
  initialCacheTelemetry: AgentEvent[] = [],
  deliveryRecorder?: ProjectionDeliveryRecorder,
  interaction?: SessionAppendInteractionContext,
  bootstrap?: SessionRunBootstrapContext,
  goal?: SessionGoalOperationContext
): {
  driver: SessionDriverLoop;
  buildTimeline: (events?: AgentEvent[]) => AgentTimelineResult;
} {
  const transcriptClient = new SessionStorageClient(apiBase);
  let committedEvents = [...initialResult.events];
  const appendCoordinator = new SessionAppendCoordinator(
    sessionId,
    hostRunId,
    initialResult,
    interaction,
    bootstrap,
    goal
  );
  const projector = new CanonicalTimelineProjector(
    sessionId,
    committedEvents,
    initialTimeline,
    initialCacheTelemetry
  );
  const buildTimeline = (): AgentTimelineResult => projector.snapshot();
  const driver = new SessionDriverLoop({
    kernelCommand: (request) => kernelCommand(apiBase, request),
    llmChat: (request, signal) => llmChat(
      apiBase,
      request,
      { apiBase, sessionId, hostRunId },
      signal
    ),
    llmChatStream: (request, onEvent, onEvents, signal) => llmChatStream(
      apiBase,
      request,
      onEvent,
      onEvents,
      { apiBase, sessionId, hostRunId },
      signal
    ),
    onProjectionDelta: async (delta) => {
          deliveryRecorder?.record({
            stage: 'session.provider_delta_received',
            turnId: delta.turnId,
            itemId: delta.itemId,
            op: delta.type,
            failureCode: projectionDeltaFailureCode(delta),
            ...projectionDeliveryContentMetadata(projectionDeltaContent(delta)),
            result: 'accepted',
          });
          const timelineDeltas = projector.push(delta);
          for (const timelineDelta of timelineDeltas) {
            await publishTimelineDelta(apiBase, hostRunId, timelineDelta, deliveryRecorder);
          }
        },
    appendTranscript: (sessionId, entry) => transcriptClient.appendTranscript(sessionId, entry),
    loadWireLedger: (sessionId) => transcriptClient.listWireLedger(sessionId),
    appendWireLedger: (sessionId, entries) => transcriptClient.appendWireLedger(sessionId, entries),
    appendCacheTelemetry: (sessionId, entry) => transcriptClient.appendCacheTelemetry(sessionId, entry),
    analysisTimelineRequired: true,
    providerResponseIdentityRequired: true,
    wireLedgerRequired: true,
    appendAnalysisTimeline: (sessionId, entries) =>
      transcriptClient.appendAnalysisTimeline(sessionId, entries),
    loadAnalysisTimelineRecord: (sessionId, recordId) =>
      transcriptClient.loadAnalysisTimelineRecord(sessionId, recordId),
    registerProviderAdmission: (_sessionId, metadata) =>
      appendCoordinator.registerProviderAdmission(metadata),
    bindProviderProposalAdmission: (_sessionId, proposalId, providerRequestId) =>
      appendCoordinator.bindProviderProposalAdmission(
        proposalId,
        providerRequestId
      ),
    appendEvents: async (sessionId, events) => {
      if (events.length === 0) {
        const current = await getAgentSession(apiBase, sessionId);
        if (canonicalJson(current.events) !== canonicalJson(committedEvents)) {
          const currentTimeline = await loadAgentTimeline(
            apiBase,
            sessionId,
            current.events
          );
          projector.acceptAcknowledgedCommit(
            projector.prepareRecoveredCommit(
              current.events,
              requiredSharedProjection(currentTimeline)
            )
          );
        }
        appendCoordinator.refresh(current);
        committedEvents = [...current.events];
        return current;
      }
      if (containsTerminalCancelled(events)) {
        const current = await getAgentSession(apiBase, sessionId);
        if (canonicalJson(current.events) !== canonicalJson(committedEvents)) {
          const currentTimeline = await loadAgentTimeline(
            apiBase,
            sessionId,
            current.events
          );
          projector.acceptAcknowledgedCommit(
            projector.prepareRecoveredCommit(
              current.events,
              requiredSharedProjection(currentTimeline)
            )
          );
        }
        appendCoordinator.refresh(current);
        committedEvents = [...current.events];
      }
      const eventsUrl =
        `${apiBase}/api/agent/sessions/${encodeURIComponent(sessionId)}/events`;
      let staleCancelRefreshUsed = false;
      for (;;) {
        const preparedFacts = appendCoordinator.prepareEvents(events);
        projector.rememberAuxiliaryEvents(preparedFacts.auxiliaryEvents);
        if (preparedFacts.events.length === 0) {
          const current = await getAgentSession(apiBase, sessionId);
          if (canonicalJson(current.events) !== canonicalJson(committedEvents)) {
            const currentTimeline = await loadAgentTimeline(
              apiBase,
              sessionId,
              current.events
            );
            projector.acceptAcknowledgedCommit(
              projector.prepareRecoveredCommit(
                current.events,
                requiredSharedProjection(currentTimeline)
              )
            );
          }
          appendCoordinator.refresh(current);
          committedEvents = [...current.events];
          return current;
        }
        const nextEvents = [...committedEvents, ...preparedFacts.events];
        const preparedProjectionCommit = projector.prepareCommit(nextEvents);
        const preparation = appendCoordinator.buildCommand(
          preparedFacts,
          preparedProjectionCommit.timeline
        );
        const response = await postCanonicalSessionAppend(
          eventsUrl,
          preparation
        );
        if (!response.ok || !isAgentSessionResult(response.data)) {
          if (
            !staleCancelRefreshUsed
            && response.error === 'session_append_head_conflict'
            && preparation.command.transition.kind === 'close'
            && preparation.command.transition.phase === 'terminal'
            && preparation.command.transition.status === 'cancelled'
          ) {
            staleCancelRefreshUsed = true;
            const current = await getAgentSession(apiBase, sessionId);
            const currentTimeline = await loadAgentTimeline(
              apiBase,
              sessionId,
              current.events
            );
            projector.acceptAcknowledgedCommit(
              projector.prepareRecoveredCommit(
                current.events,
                requiredSharedProjection(currentTimeline)
              )
            );
            appendCoordinator.refresh(current);
            committedEvents = [...current.events];
            continue;
          }
          throw sessionAppendApiError(response);
        }
        const acknowledged = appendCoordinator.acknowledge(
          preparation,
          response.data
        );
        if (canonicalJson(acknowledged.events) !== canonicalJson(nextEvents)) {
          throw new SessionAppendCoordinatorError(
            'session_append_recovery_required',
            `Session append ${preparation.command.batchId} acknowledged an unexpected logical event sequence.`
          );
        }
        const projectionCommit = projector.acceptAcknowledgedCommit(
          preparedProjectionCommit
        );
        committedEvents = [...acknowledged.events];
        for (const timelineDelta of projectionCommit.deltas) {
          await publishTimelineDelta(apiBase, hostRunId, timelineDelta, deliveryRecorder);
        }
        return acknowledged;
      }
    },
  });
  return { driver, buildTimeline };
}

async function currentOrCreateSession(
  apiBase: string,
  scope: { workspaceId?: string; workspaceHash?: string },
  title: string
): Promise<AgentSessionResult> {
  const current = await getJson<ApiResponse<AgentSessionResult | null>>(
    `${apiBase}/api/agent/sessions/current${query(scope)}`
  );
  if (current.ok && current.data) return current.data;
  const created = await postJson<ApiResponse<AgentSessionResult>>(`${apiBase}/api/agent/sessions`, {
    initialMode: 'plan',
    title,
    ...scope,
  });
  if (!created.ok || !created.data) {
    throw new Error(created.message ?? created.error ?? 'create agent session failed');
  }
  return created.data;
}

async function activateSession(apiBase: string, sessionId: string): Promise<AgentSessionResult> {
  const response = await postJson<ApiResponse<AgentSessionResult>>(
    `${apiBase}/api/agent/sessions/${encodeURIComponent(sessionId)}/activate`,
    {}
  );
  if (!response.ok || !response.data) {
    throw new Error(response.message ?? response.error ?? `activate session failed: ${sessionId}`);
  }
  return response.data;
}

async function getAgentSession(apiBase: string, sessionId: string): Promise<AgentSessionResult> {
  const response = await getJson<ApiResponse<AgentSessionResult>>(
    `${apiBase}/api/agent/sessions/${encodeURIComponent(sessionId)}/events`
  );
  if (!response.ok || !response.data) {
    throw new Error(response.message ?? response.error ?? `read session failed: ${sessionId}`);
  }
  return response.data;
}

function requiredHostRunId(request: HostBridgeRequest): string {
  const hostRunId = request.hostRunId?.trim();
  if (!hostRunId) {
    throw new SessionAppendCoordinatorError(
      'session_append_run_identity_required',
      'Canonical Session execution requires a Host run identity.'
    );
  }
  return hostRunId;
}

function bootstrapContext(
  request: HostBridgeRequest
): SessionRunBootstrapContext | undefined {
  const token = request.bootstrapToken?.trim();
  const admissionId = request.bootstrapAdmissionId?.trim();
  if (!token && !admissionId) return undefined;
  if (!token || !admissionId) {
    throw new SessionAppendCoordinatorError(
      'session_append_transition_invalid',
      'Run bootstrap requires one admission identity and one transport token.'
    );
  }
  if (
    request.op !== 'ask'
    && request.op !== 'startGoal'
    && request.op !== 'advanceGoal'
    && request.op !== 'resumeGoal'
    && request.op !== 'cancelGoal'
  ) {
    throw new SessionAppendCoordinatorError(
      'session_append_transition_invalid',
      'Only an authoritative user run or an admitted Goal foreground operation may carry a bootstrap admission.'
    );
  }
  return {
    token,
    admissionId,
  };
}

function interactionContext(
  request: HostBridgeRequest
): SessionAppendInteractionContext | undefined {
  if (request.decisionKind === 'boundary') return undefined;
  const interactionId = request.interactionId?.trim();
  const interactionRevision = request.interactionRevision?.trim();
  const targetId = request.targetId?.trim();
  const decisionRequestId = request.decisionRequestId?.trim();
  if (
    !interactionId
    || !interactionRevision
    || !targetId
    || !decisionRequestId
  ) {
    throw new SessionAppendCoordinatorError(
      'session_interaction_identity_required',
      'Canonical interaction settlement requires the exact claimed interaction identity.'
    );
  }
  return {
    interactionId,
    interactionRevision,
    targetId,
    decisionRequestId,
  };
}

async function postCanonicalSessionAppend(
  url: string,
  preparation: PreparedCanonicalSessionAppend
): Promise<ApiResponse<AgentSessionResult | SessionAppendErrorDetailsV1>> {
  const body = JSON.stringify(preparation.command);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json() as ApiResponse<
        AgentSessionResult | SessionAppendErrorDetailsV1
      >;
    } catch (error) {
      lastError = error;
    }
  }
  throw new SessionAppendCoordinatorError(
    'session_append_recovery_required',
    `Canonical Session append ${preparation.command.batchId} has an unknown transport outcome.`,
    lastError
  );
}

function isAgentSessionResult(value: unknown): value is AgentSessionResult {
  const result = objectRecord(value);
  const session = objectRecord(result?.session);
  const writeability = objectRecord(result?.appendWriteability);
  if (
    typeof session?.id !== 'string'
    || !Array.isArray(result?.events)
    || writeability?.schemaVersion !== 'deepcode.session.append-writeability.v1'
  ) {
    return false;
  }
  if (
    writeability.status === 'writable'
    && writeability.format === 'domainBatchV1'
  ) {
    return objectRecord(result?.domainState)?.schemaVersion
      === 'deepcode.session.domain-state-snapshot.v1';
  }
  return writeability.status === 'readOnly'
    && writeability.format === 'legacyRawEventsV1'
    && writeability.reason === 'legacyFormat'
    && result?.domainState === undefined
    && result?.appendReceipt === undefined;
}

function sessionAppendApiError(
  response: ApiResponse<AgentSessionResult | SessionAppendErrorDetailsV1>
): SessionAppendCoordinatorError {
  const details = sessionAppendErrorDetails(response.data);
  const code = details?.code
    ?? response.error
    ?? 'session_append_recovery_required';
  return new SessionAppendCoordinatorError(
    code,
    response.message
      ?? details?.reason
      ?? `Canonical Session append failed with ${code}.`,
    details ?? response.data
  );
}

function sessionAppendErrorDetails(
  value: unknown
): SessionAppendErrorDetailsV1 | undefined {
  const details = objectRecord(value);
  if (
    details?.schemaVersion !== 'deepcode.session.append-error-details.v1'
    || typeof details.code !== 'string'
    || typeof details.sessionId !== 'string'
    || typeof details.reason !== 'string'
  ) {
    return undefined;
  }
  const supported = new Set([
    'session_append_legacy_read_only',
    'session_append_batch_conflict',
    'session_append_head_conflict',
    'session_append_precondition_failed',
    'session_append_transition_invalid',
    'session_append_lineage_invalid',
    'session_append_recovery_required',
  ]);
  return supported.has(details.code)
    ? value as SessionAppendErrorDetailsV1
    : undefined;
}

function assertDecisionAdmissionIdentity(
  request: HostBridgeRequest,
  currentEvents: AgentEvent[],
  snapshot: AgentTimelineSnapshot | undefined
): void {
  if (request.decisionKind === 'boundary') return;
  if (
    !request.interactionId ||
    !request.interactionRevision ||
    !request.targetId ||
    !request.decisionRequestId
  ) {
    throw new Error('session_interaction_identity_required');
  }
  if (!snapshot) throw new Error('session_interaction_projection_unavailable');
  const normalized = normalizeAgentTimelineSnapshot(snapshot, currentEvents);
  if (normalized.compatibility !== 'nativeV2') {
    throw new Error('session_interaction_legacy_read_only');
  }
  const pending = normalized.timeline.interactionProjection?.pending;
  if (
    !pending ||
    pending.kind !== request.decisionKind ||
    pending.interactionId !== request.interactionId ||
    pending.interactionRevision !== request.interactionRevision ||
    pending.targetId !== request.targetId
  ) {
    throw new Error('session_interaction_stale');
  }
  if (
    request.decisionKind === 'review' &&
    (
      !request.reviewId ||
      pending.kind !== 'review' ||
      pending.reviewId !== request.reviewId
    )
  ) {
    throw new Error('session_review_identity_required');
  }
}

interface AgentTimelineLookup {
  current?: AgentTimelineSnapshot;
  staleNativeV2?: AgentTimelineResult;
}

async function readAgentTimeline(
  apiBase: string,
  sessionId: string
): Promise<AgentTimelineLookup> {
  const response = await getJson<ApiResponse<AgentTimelineSnapshot>>(
    `${apiBase}/api/agent/sessions/${encodeURIComponent(sessionId)}/timeline`
  );
  if (!response.ok || !response.data) {
    if (response.error === 'agent_timeline_unavailable') return {};
    if (
      response.error === 'agent_timeline_stale' &&
      response.data?.schemaVersion === 'deepcode.shared-conversation-projection.v2' &&
      response.data.sessionId === sessionId
    ) {
      normalizeAgentTimelineSnapshot(response.data);
      return { staleNativeV2: response.data };
    }
    throw new Error(response.message ?? response.error ?? `read canonical timeline failed: ${sessionId}`);
  }
  if (
    (
      response.data.schemaVersion !== 'deepcode.session.timeline.v1' &&
      response.data.schemaVersion !== 'deepcode.shared-conversation-projection.v2'
    ) ||
    response.data.sessionId !== sessionId
  ) {
    throw new Error(`canonical timeline identity mismatch: ${sessionId}`);
  }
  normalizeAgentTimelineSnapshot(response.data);
  return { current: response.data };
}

async function loadAgentTimeline(
  apiBase: string,
  sessionId: string,
  sourceEvents: AgentEvent[]
): Promise<AgentTimelineSnapshot> {
  const lookup = await readAgentTimeline(apiBase, sessionId);
  if (lookup.current) {
    if (lookup.current.schemaVersion === 'deepcode.session.timeline.v1') {
      return lookup.current;
    }
    if (timelineMatchesEvents(lookup.current, sourceEvents)) {
      return lookup.current;
    }
    throw new SessionAppendCoordinatorError(
      'session_append_recovery_required',
      `Shared Projection v2 for ${sessionId} does not match the committed domain event version.`
    );
  }
  if (lookup.staleNativeV2) {
    throw new SessionAppendCoordinatorError(
      'session_append_recovery_required',
      `Shared Projection v2 for ${sessionId} is stale and cannot be repaired by the Host.`
    );
  }
  if (sourceEvents.length === 0) {
    return new CanonicalTimelineProjector(sessionId, sourceEvents).snapshot();
  }
  throw new SessionAppendCoordinatorError(
    'session_append_recovery_required',
    `Committed Session ${sessionId} has no matching Shared Projection v2.`
  );
}

async function loadCacheTelemetryEvents(
  apiBase: string,
  sessionId: string
): Promise<AgentEvent[]> {
  const entries = await new SessionStorageClient(apiBase).listCacheTelemetry(sessionId);
  return entries.flatMap((entry): AgentEvent[] => {
    const recordId = stringField(entry, 'recordId');
    const timestamp = stringField(entry, 'timestamp');
    const recordSessionId = stringField(entry, 'sessionId');
    if (!recordId || !timestamp || (recordSessionId && recordSessionId !== sessionId)) {
      return [];
    }
    return [{
      id: recordId,
      sessionId,
      ts: timestamp,
      kind: 'cache_telemetry',
      payload: { ...entry },
      display: {
        presentation: 'traceOnly',
        importance: 'debug',
      },
    }];
  });
}

function timelineMatchesEvents(
  timeline: AgentTimelineResult,
  events: readonly AgentEvent[]
): boolean {
  return timeline.eventCount === events.length &&
    timeline.sourceEventVersion === events.length;
}

function requiredSharedProjection(
  timeline: AgentTimelineSnapshot
): AgentTimelineResult {
  if (timeline.schemaVersion === 'deepcode.shared-conversation-projection.v2') {
    return timeline;
  }
  throw new SessionAppendCoordinatorError(
    'session_append_legacy_read_only',
    'Legacy Session projection is read-only and cannot be used for canonical append recovery.'
  );
}

function containsTerminalCancelled(events: readonly AgentEvent[]): boolean {
  return events.some((event) => {
    if (event.kind !== 'session_run_state') return false;
    return objectRecord(event.payload)?.status === 'cancelled';
  });
}

async function kernelCommand(apiBase: string, request: KernelCommandEnvelope): Promise<KernelReply> {
  return postJson<KernelReply>(`${apiBase}/api/kernel/commands`, request);
}

async function llmChat(
  apiBase: string,
  request: LlmChatRequest,
  cancellation?: HostRunCancellationContext,
  signal?: AbortSignal
): Promise<ApiResponse<LlmChatResult>> {
  const controller = new AbortController();
  const unlinkAbortSignal = linkAbortSignal(signal, controller);
  const monitor = cancellation
    ? new HostRunCancellationMonitor(cancellation, controller)
    : undefined;
  try {
    return await postJson<ApiResponse<LlmChatResult>>(
      `${apiBase}/api/llm/chat`,
      request,
      controller.signal
    );
  } catch (error) {
    if (monitor?.cancelled) return cancelledLlmResult();
    if (signal?.aborted) throw abortSignalReason(signal);
    throw error;
  } finally {
    unlinkAbortSignal();
    await monitor?.stop();
  }
}

async function llmChatStream(
  apiBase: string,
  request: LlmChatRequest,
  onEvent: (event: LlmChatStreamEvent) => void | Promise<void>,
  onEvents?: (events: readonly LlmChatStreamEvent[]) => void | Promise<void>,
  cancellation?: HostRunCancellationContext,
  signal?: AbortSignal
): Promise<ApiResponse<LlmChatResult>> {
  const controller = new AbortController();
  const unlinkAbortSignal = linkAbortSignal(signal, controller);
  const monitor = cancellation
    ? new HostRunCancellationMonitor(cancellation, controller)
    : undefined;
  try {
    const response = await fetch(`${apiBase}/api/llm/chat/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...request, stream: true }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    if (!response.body) {
      return {
        ok: false,
        error: 'stream_unavailable',
        message: 'LLM stream response body is unavailable.',
      };
    }

    const chunks: LlmChatResult['chunks'] = [];
    let usage: Record<string, unknown> | undefined;
    let providerProfileId: string | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let responseRequestId: string | undefined;
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    const parser = new SseClientParser();
    const decoder = new TextDecoder();
    const consume = async (events: readonly LlmChatStreamEvent[]) => {
      if (events.length === 0) return;
      // Persist every decoded event as one durable network-read batch before
      // Host aggregation or downstream semantic consumption.
      if (onEvents) {
        await onEvents(events);
      } else {
        for (const event of events) await onEvent(event);
      }
      for (const event of events) {
        if (event.chunk) chunks.push(event.chunk);
        if (event.usage) usage = event.usage;
        if (event.chunk?.usage) usage = event.chunk.usage;
        providerProfileId = event.providerProfileId ?? providerProfileId;
        provider = event.provider ?? provider;
        model = event.model ?? model;
        if (event.requestId) {
          responseRequestId = responseRequestId && responseRequestId !== event.requestId
            ? 'provider-request-identity-conflict'
            : event.requestId;
        }
        if (event.type === 'provider_error') {
          const eventMessage = (event as LlmChatStreamEvent & { message?: string }).message;
          errorCode = event.error === 'provider_thinking_continuation_invalid'
            || event.error === 'provider_profile_identity_invalid'
            || event.error === 'provider_request_identity_invalid'
            || event.error === 'provider_retryable_no_mutation'
            ? event.error
            : undefined;
          errorMessage = eventMessage ?? event.chunk?.error ?? event.error ?? 'Provider stream error.';
        }
      }
    };

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        await consume(parser.push(text));
      }
      const tail = decoder.decode();
      await consume(parser.push(tail));
      await consume(parser.finish());
    } catch (error) {
      controller.abort();
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }

    if (errorMessage) {
      return {
        ok: false,
        error: errorCode ?? 'provider_stream_error',
        message: errorMessage,
      };
    }
    return {
      ok: true,
      data: buildStreamResult(chunks, usage, {
        requestId: responseRequestId,
        providerProfileId,
        provider,
        model,
      }),
    };
  } catch (error) {
    if (monitor?.cancelled) return cancelledLlmResult();
    if (signal?.aborted) throw abortSignalReason(signal);
    const errorCode = typeof objectRecord(error)?.code === 'string'
      ? String(objectRecord(error)?.code)
      : undefined;
    return {
      ok: false,
      error: errorCode ?? (error instanceof Error ? error.name : 'Error'),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unlinkAbortSignal();
    await monitor?.stop();
  }
}

function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function abortSignalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Session Provider call was aborted.');
}

class HostRunCancellationMonitor {
  private stopped = false;
  private cancellationObserved = false;
  private readonly completion: Promise<void>;

  constructor(
    private readonly context: HostRunCancellationContext,
    private readonly controller: AbortController
  ) {
    this.completion = this.poll();
  }

  get cancelled(): boolean {
    return this.cancellationObserved;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.completion;
  }

  private async poll(): Promise<void> {
    while (!this.stopped && !this.controller.signal.aborted) {
      if (await hostRunCancellationRequested(this.context)) {
        this.cancellationObserved = true;
        this.controller.abort();
        return;
      }
      await delay(HOST_RUN_CANCELLATION_POLL_MS);
    }
  }
}

async function hostRunCancellationRequested(
  context: HostRunCancellationContext
): Promise<boolean> {
  try {
    const response = await getJson<ApiResponse<{ run?: { status?: string } }>>(
      `${context.apiBase}/api/agent/sessions/${encodeURIComponent(context.sessionId)}/runs/${encodeURIComponent(context.hostRunId)}`
    );
    const status = response.data?.run?.status;
    return status === 'cancelling' || status === 'cancelled';
  } catch {
    return false;
  }
}

function cancelledLlmResult(): ApiResponse<LlmChatResult> {
  return {
    ok: false,
    error: 'session_run_cancelled',
    message: 'Session run cancelled by user.',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postProjectionDelta(apiBase: string, hostRunId: string, delta: AgentTimelineDelta): Promise<void> {
  const response = await postJson<ApiResponse<unknown>>(
    `${apiBase}/api/agent/sessions/${encodeURIComponent(delta.sessionId)}/runs/${encodeURIComponent(hostRunId)}/deltas`,
    delta
  );
  if (!response.ok) {
    throw new Error(response.message ?? response.error ?? 'post projection delta failed');
  }
}

function createProjectionDeliveryRecorder(
  apiBase: string,
  sessionId: string,
  hostRunId: string | undefined
): ProjectionDeliveryRecorder | undefined {
  if (!hostRunId) return undefined;
  const client = new SessionStorageClient(apiBase);
  return new ProjectionDeliveryRecorder(
    (entries, signal) => client.appendProjectionDelivery(sessionId, entries, signal),
    { sessionId, runId: hostRunId },
    {
      onError: (error) => {
        process.stderr.write(`projection delivery archive skipped: ${error instanceof Error ? error.message : String(error)}\n`);
      },
    }
  );
}

async function publishTimelineDelta(
  apiBase: string,
  hostRunId: string,
  delta: AgentTimelineDelta,
  recorder?: ProjectionDeliveryRecorder
): Promise<void> {
  recorder?.record(projectionDeliveryMetadataForTimelineDelta(
    'session.timeline_delta_projected',
    delta,
    'accepted'
  ));
  try {
    await postProjectionDelta(apiBase, hostRunId, delta);
    recorder?.record(projectionDeliveryMetadataForTimelineDelta(
      'session.timeline_delta_posted',
      delta,
      'sent'
    ));
  } catch (error) {
    recorder?.record(projectionDeliveryMetadataForTimelineDelta(
      'session.timeline_delta_post_failed',
      delta,
      'failed'
    ));
    throw error;
  }
}

function projectionDeltaContent(delta: ProjectionDelta): string {
  const payload = objectRecord(delta.payload);
  if (delta.type === 'semantic_delta' && payload?.schemaVersion === 'deepcode.session.semantic-draft.v1') {
    const answer = objectRecord(payload.answer);
    if (typeof answer?.content === 'string') return answer.content;
    const plan = objectRecord(payload.plan);
    if (plan) return JSON.stringify(plan);
  }
  if (typeof delta.delta === 'string') return delta.delta;
  if (typeof delta.summary === 'string') return delta.summary;
  return '';
}

function projectionDeltaFailureCode(delta: ProjectionDelta): string | undefined {
  const payload = objectRecord(delta.payload);
  if (delta.type !== 'semantic_delta' || payload?.schemaVersion !== 'deepcode.session.semantic-draft.v1') {
    return undefined;
  }
  return typeof payload.failureCode === 'string' && payload.failureCode.trim()
    ? payload.failureCode
    : undefined;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return await response.json() as T;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return await response.json() as T;
}

class SseClientParser {
  private buffer = '';

  push(text: string): LlmChatStreamEvent[] {
    if (!text) return [];
    this.buffer += text;
    const events: LlmChatStreamEvent[] = [];
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) break;
      const raw = this.buffer.slice(0, boundary);
      const separator = this.buffer.slice(boundary).match(/^\r?\n\r?\n/);
      this.buffer = this.buffer.slice(boundary + (separator?.[0].length ?? 2));
      const event = parseSseClientEvent(raw);
      if (event) events.push(event);
    }
    return events;
  }

  finish(): LlmChatStreamEvent[] {
    const text = this.buffer.trim();
    this.buffer = '';
    const event = parseSseClientEvent(text);
    return event ? [event] : [];
  }
}

function parseSseClientEvent(raw: string): LlmChatStreamEvent | null {
  if (!raw.trim()) return null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    if (field === 'data') data.push(value);
  }
  const payload = data.join('\n').trim();
  if (!payload || payload === '[DONE]') {
    return { type: 'provider_done', chunk: { type: 'done' } };
  }
  try {
    return JSON.parse(payload) as LlmChatStreamEvent;
  } catch (error) {
    return {
      type: 'provider_error',
      error: `Invalid LLM stream event JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function buildStreamResult(
  chunks: LlmChatResult['chunks'],
  usage: Record<string, unknown> | undefined,
  metadata: Pick<LlmChatResult, 'requestId' | 'providerProfileId' | 'provider' | 'model'>
): LlmChatResult {
  const content = chunks
    .filter((chunk) => chunk.type === 'delta' && typeof chunk.content === 'string')
    .map((chunk) => chunk.content)
    .join('');
  const reasoningContent = chunks
    .filter((chunk) => chunk.type === 'reasoning_delta' && typeof chunk.content === 'string')
    .map((chunk) => chunk.content)
    .join('');
  const toolCalls = collectStreamToolCalls(chunks);
  return {
    chunks,
    usage,
    ...metadata,
    assistantMessage: {
      role: 'assistant',
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    },
  };
}

function collectStreamToolCalls(chunks: LlmChatResult['chunks']): ToolCall[] {
  const byIndex = new Map<number, { id?: string; name?: string; argumentsText: string }>();
  const ready: ToolCall[] = [];
  for (const chunk of chunks) {
    if (chunk.type === 'tool_call' && chunk.toolCall) {
      ready.push(chunk.toolCall);
      continue;
    }
    if (chunk.type !== 'tool_call' || !chunk.toolCallDelta) continue;
    const index = chunk.toolCallDelta.index ?? chunk.index ?? 0;
    const current = byIndex.get(index) ?? { argumentsText: '' };
    current.id = chunk.toolCallDelta.id ?? chunk.callId ?? current.id;
    current.name = chunk.toolCallDelta.name ?? current.name;
    current.argumentsText += chunk.toolCallDelta.argumentsDelta ?? '';
    byIndex.set(index, current);
  }
  for (const [index, item] of byIndex.entries()) {
    if (!item.name) continue;
    ready.push({
      id: item.id ?? `tool-call-${index + 1}`,
      name: item.name,
      arguments: parseToolArguments(item.argumentsText),
    });
  }
  return ready;
}

function parseToolArguments(raw: string): unknown {
  const text = raw.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw };
  }
}

function workspaceBindingFromPath(path: string | undefined): AgentWorkspaceBinding | undefined {
  const normalized = normalizePath(path);
  if (!normalized) return undefined;
  const hash = simpleWorkspaceHash(normalized);
  return {
    workspaceId: 'terminal',
    workspaceHash: hash,
    openPath: normalized,
    activeFolderId: 'wf-0',
    folderHash: hash,
  };
}

function projectWorkingDirectoryFromBinding(
  binding: AgentWorkspaceBinding | undefined,
  fallbackPath: string | undefined
): ProjectWorkingDirectory | undefined {
  const normalized = normalizePath(binding?.openPath ?? fallbackPath);
  if (!normalized) return undefined;
  return {
    rootId: binding?.activeFolderId ?? `project-root-${binding?.workspaceHash ?? simpleWorkspaceHash(normalized)}`,
    label: `Project workspace ${normalized}`,
    displayPath: normalized,
    absolutePath: normalized,
    source: 'projectWorkingDirectory',
  };
}

function normalizePath(path: string | undefined): string | undefined {
  const value = path?.trim();
  if (!value) return undefined;
  return value.replace(/\\/g, '/').replace(/\/+$/g, '') || value;
}

function normalizeApiBase(apiBase: string | undefined): string {
  const value = apiBase?.trim()
    || process.env.DEEPCODE_API_URL
    || `http://${process.env.DEEPCODE_HOST ?? '127.0.0.1'}:${process.env.DEEPCODE_PORT ?? '31245'}`;
  return value.replace(/\/+$/g, '');
}

function simpleWorkspaceHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ws-${(hash >>> 0).toString(16)}`;
}

function query(values: Record<string, string | undefined>): string {
  const parts = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? '')}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function extractFinalText(timeline: AgentTimelineResult): string {
  for (const turn of [...timeline.turns].reverse()) {
    for (const block of [...turn.blocks].reverse()) {
      if (block.entryRole === 'finalAnswer' && block.durability === 'committed') {
        const text = (block.bodyMarkdown || block.summary || '').trim();
        if (text) return text;
      }
    }
  }
  return '';
}

function inferHostRunLifecycle(
  events: unknown[],
  finalText: string
): Pick<HostBridgeResult, 'runStatus' | 'decisionKind' | 'targetId' | 'terminalReason'> {
  const consumedOwners = collectConsumedInteractionOwners(events);
  for (const event of [...events].reverse()) {
    const record = objectRecord(event);
    const kind = stringField(record, 'kind');
    const payload = objectRecord(record?.payload);
    if (!kind || !payload) continue;

    if (kind === 'error') {
      return {
        runStatus: 'failed',
        terminalReason: stringField(payload, 'message') ?? stringField(payload, 'summary') ?? 'session run failed',
      };
    }

    if (kind === 'session_run_state') {
      const status = stringField(payload, 'status');
      if (status === 'completed') {
        return {
          runStatus: 'completed',
          terminalReason: stringField(payload, 'summary') ?? 'Session run is completed.',
        };
      }
      if (status === 'cancelled') {
        return {
          runStatus: 'cancelled',
          terminalReason: stringField(payload, 'summary') ?? 'Session run is cancelled.',
        };
      }
      if (status === 'running') {
        return {
          runStatus: 'failed',
          terminalReason: stringField(payload, 'summary') ??
            `Session bridge returned before ${stringField(payload, 'reason') ?? 'running'} reached a terminal checkpoint.`,
        };
      }
      if (status === 'waiting') {
        const owner = objectRecord(payload.decisionOwner);
        if (waitingOwnerWasConsumed('session_run_state', payload, consumedOwners)) {
          continue;
        }
        return {
          runStatus: 'waiting',
          decisionKind: stringField(payload, 'decisionKind') ?? stringField(owner, 'kind'),
          targetId: stringField(payload, 'targetId') ?? stringField(owner, 'targetId'),
          terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for user input.',
        };
      }
    }

    if (kind === 'permission_request') {
      return {
        runStatus: 'waiting',
        decisionKind: 'permission',
        targetId: stringField(payload, 'id') ?? stringField(payload, 'permissionId'),
        terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for a permission decision.',
      };
    }

    if (kind === 'review_summary' && stringField(payload, 'status') === 'waitingUserReview') {
      if (waitingOwnerWasConsumed(kind, payload, consumedOwners)) {
        continue;
      }
      return {
        runStatus: 'waiting',
        decisionKind: 'review',
        targetId: stringField(payload, 'reviewId') ?? stringField(payload, 'runId'),
        terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for user review.',
      };
    }

    if (kind === 'requirement_confirmation' && stringField(payload, 'status') === 'waitingUserConfirmation') {
      if (waitingOwnerWasConsumed(kind, payload, consumedOwners)) {
        continue;
      }
      return {
        runStatus: 'waiting',
        decisionKind: 'requirement',
        targetId: stringField(payload, 'requirementId'),
        terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for requirement confirmation.',
      };
    }

    if (kind === 'plan_card' && planInteractionAwaitsDecision(payload)) {
      if (waitingOwnerWasConsumed(kind, payload, consumedOwners)) {
        continue;
      }
      return {
        runStatus: 'waiting',
        decisionKind: 'plan',
        targetId: stringField(payload, 'planId'),
        terminalReason: stringField(payload, 'summary') ?? 'Session run is waiting for plan review.',
      };
    }
  }

  return {
    runStatus: finalText ? 'completed' : 'completed',
    terminalReason: finalText ? 'final_answer' : 'session_run_returned',
  };
}

interface ConsumedInteractionOwners {
  readonly plans: Set<string>;
  readonly requirements: Set<string>;
  readonly reviews: Set<string>;
  readonly permissions: Set<string>;
}

function collectConsumedInteractionOwners(events: unknown[]): ConsumedInteractionOwners {
  const consumed: ConsumedInteractionOwners = {
    plans: new Set<string>(),
    requirements: new Set<string>(),
    reviews: new Set<string>(),
    permissions: new Set<string>(),
  };
  for (const event of events) {
    const record = objectRecord(event);
    const kind = stringField(record, 'kind');
    const payload = objectRecord(record?.payload);
    if (!kind || !payload) continue;

    if (kind === 'requirement_decision') {
      addStrings(consumed.requirements,
        stringField(payload, 'requirementId'),
        stringField(payload, 'interactionId'),
        stringField(payload, 'sourceInteractionId'),
        stringField(payload, 'targetId'));
      continue;
    }

    if (kind === 'plan_review') {
      const status = stringField(payload, 'status')?.toLowerCase();
      if (status === 'accepted' || status === 'rejected' || status === 'needsrevision') {
        addStrings(consumed.plans,
          stringField(payload, 'planId'),
          stringField(payload, 'interactionId'),
          stringField(payload, 'sourceInteractionId'),
          stringField(payload, 'targetId'));
      }
      continue;
    }

    if (kind === 'review_summary') {
      const status = stringField(payload, 'status')?.toLowerCase();
      if (status && status !== 'waitinguserreview' && status !== 'pending') {
        addStrings(consumed.reviews,
          stringField(payload, 'reviewId'),
          stringField(payload, 'interactionId'),
          stringField(payload, 'sourceInteractionId'),
          stringField(payload, 'targetId'));
        addStrings(consumed.plans,
          stringField(payload, 'planId'),
          stringField(payload, 'sourcePlanId'));
      }
      continue;
    }

    if (kind === 'permission_decision') {
      addStrings(consumed.permissions,
        stringField(payload, 'permissionId'),
        stringField(payload, 'interactionId'),
        stringField(payload, 'sourceInteractionId'),
        stringField(payload, 'targetId'));
      continue;
    }

    if (kind === 'session_run_state') {
      const status = stringField(payload, 'status');
      const reason = stringField(payload, 'reason');
      if (status === 'completed' || status === 'cancelled' || status === 'failed') {
        const owner = objectRecord(payload.decisionOwner);
        const decisionKind = stringField(payload, 'decisionKind') ?? stringField(owner, 'kind');
        if (decisionKind === 'plan') {
          addStrings(consumed.plans,
            stringField(payload, 'planId'),
            stringField(payload, 'targetId'),
            stringField(owner, 'planId'),
            stringField(owner, 'targetId'));
        }
        if (decisionKind === 'requirement') {
          addStrings(consumed.requirements,
            stringField(payload, 'requirementId'),
            stringField(payload, 'targetId'),
            stringField(owner, 'requirementId'),
            stringField(owner, 'targetId'));
        }
        if (decisionKind === 'review') {
          addStrings(consumed.reviews,
            stringField(payload, 'reviewId'),
            stringField(payload, 'targetId'),
            stringField(owner, 'reviewId'),
            stringField(owner, 'targetId'));
        }
        if (decisionKind === 'permission') {
          addStrings(consumed.permissions,
            stringField(payload, 'permissionId'),
            stringField(payload, 'targetId'),
            stringField(owner, 'permissionId'),
            stringField(owner, 'targetId'));
        }
      }
      if (status === 'running' && reason === 'accepted_plan_execution') {
        const owner = objectRecord(payload.decisionOwner);
        addStrings(consumed.plans,
          stringField(payload, 'planId'),
          stringField(payload, 'targetId'),
          stringField(owner, 'targetId'),
          stringField(owner, 'planId'));
      }
    }
  }
  return consumed;
}

function waitingOwnerWasConsumed(
  kind: string,
  payload: Record<string, unknown>,
  consumed: ConsumedInteractionOwners
): boolean {
  if (kind === 'plan_card') {
    return hasAny(consumed.plans,
      stringField(payload, 'planId'),
      stringField(payload, 'targetId'),
      stringField(payload, 'interactionId'),
      stringField(payload, 'sourceInteractionId'));
  }
  if (kind === 'requirement_confirmation') {
    return hasAny(consumed.requirements,
      stringField(payload, 'requirementId'),
      stringField(payload, 'targetId'),
      stringField(payload, 'interactionId'),
      stringField(payload, 'sourceInteractionId'));
  }
  if (kind === 'session_run_state') {
    const owner = objectRecord(payload.decisionOwner);
    const decisionKind = stringField(payload, 'decisionKind') ?? stringField(owner, 'kind');
    const targetId = stringField(payload, 'targetId') ?? stringField(owner, 'targetId');
    if (decisionKind === 'plan') {
      return hasAny(consumed.plans, targetId, stringField(payload, 'planId'), stringField(owner, 'planId'));
    }
    if (decisionKind === 'requirement') {
      return hasAny(consumed.requirements, targetId, stringField(payload, 'requirementId'), stringField(owner, 'requirementId'));
    }
    if (decisionKind === 'review') {
      return hasAny(consumed.reviews, targetId, stringField(payload, 'reviewId'), stringField(owner, 'reviewId'));
    }
    if (decisionKind === 'permission') {
      return hasAny(consumed.permissions, targetId, stringField(payload, 'permissionId'), stringField(owner, 'permissionId'));
    }
  }
  if (kind === 'review_summary') {
    return hasAny(consumed.reviews,
      stringField(payload, 'reviewId'),
      stringField(payload, 'targetId'),
      stringField(payload, 'interactionId'),
      stringField(payload, 'sourceInteractionId'));
  }
  return false;
}

function addStrings(target: Set<string>, ...values: Array<string | undefined>): void {
  for (const value of values) {
    if (value) target.add(value);
  }
}

function hasAny(target: Set<string>, ...values: Array<string | undefined>): boolean {
  return values.some((value) => Boolean(value && target.has(value)));
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }
  return raw;
}

function writeJson(result: HostBridgeResult): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, resolve);
  });
}

main().catch((error: unknown) => {
  void writeJson({
    ok: false,
    error: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  }).finally(() => {
    process.exit(1);
  });
});
