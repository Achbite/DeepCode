import { create } from 'zustand';
import type {
  ApiResponse,
  AgentHostCallerMutationErrorV2,
  AgentConversationDraftTargetV1,
  AgentConversationTargetV1,
  AgentInputAttachmentV3,
  AgentRunGuidanceRequest,
  AgentSession,
  AgentTimelinePermissionRequestView,
  AgentTimelineResult,
  AgentTimelineStreamEvent,
  ListAgentSessionsRequest,
} from '@deepcode/protocol';
import {
  AgentTimelineRevisionGapError,
  UnsupportedTimelineHistorySchemaError,
  applyAgentTimelineDelta,
  assertSharedConversationProjectionV3,
  createWorkspaceBinding,
  createWorkspaceScope,
  createWorkspaceScopeKey,
  emptyTimeline,
  isNativeWorkSegmentsTimelineSnapshot,
  reconcileTimelineSnapshot,
  timelineAsReplay,
} from '@deepcode/session-core';
import {
  activateAgentSession,
  archiveAgentSession,
  deleteAgentSession,
  cancelCurrentAgentRun,
  createAgentSession,
  getAgentTimeline,
  getCurrentAgentSession,
  listAgentSessions,
  renameAgentSession,
  revokeUserAttachmentGrant,
  startAgentRun,
  startConversationDraftRun,
  streamAgentTimeline,
  submitCurrentAgentRunGuidance,
  submitAgentRunGuidance,
  updateAgentSession,
} from '../services/runtimeAdapter';
import { AgentTimelineStreamProtocolError } from '../services/apiClient';
import type { AgentRunResult, StartAgentRunRequest } from '../services/apiClient';
import { activeT } from '../i18n';
import { useWorkspaceStore } from './workspaceStore';

interface PendingPermission {
  request: AgentTimelinePermissionRequestView;
}

type PermissionResolution = {
  id: string;
  decision: 'accept' | 'reject';
};

function agentSessionMessage(key: string, variables?: Record<string, string | number | boolean | null | undefined>): string {
  return activeT(key, variables);
}

type PlanResolution = {
  runId: string;
  planId: string;
  decision: 'accept' | 'reject' | 'revise';
};

type InterventionResolution = {
  interactionId: string;
  decision: 'select' | 'revise' | 'reject';
};

export interface AgentSessionSubmissionTarget {
  sessionId: string;
  selectionGeneration: number;
  conversationTarget: AgentConversationTargetV1;
}

interface AgentSessionState {
  session: AgentSession | null;
  sessions: AgentSession[];
  currentSessionId?: string;
  localWorkspaceScopeKey?: string;
  timeline: AgentTimelineResult | null;
  profileId?: string;
  profileSelectionBusy: boolean;
  loading: boolean;
  selectionReady: boolean;
  cancellingSessionIds: string[];
  activeSubmissionSessionIds: string[];
  errorMessage: string | null;
  messageAttachments: AgentInputAttachmentV3[];
  sessionAttachments: AgentInputAttachmentV3[];
  pendingPermission: PendingPermission | null;
  resolvingPermission: PermissionResolution | null;
  resolvingPlan: PlanResolution | null;
  resolvingIntervention?: InterventionResolution | null;
}

interface AgentSessionActions {
  loadCurrentSelection: () => Promise<void>;
  enterDraft: () => void;
  observeSessionProjection: (sessionId: string) => () => Promise<void>;
  refreshSessions: () => Promise<void>;
  createNewSession: () => Promise<AgentSession | null>;
  captureSubmissionTarget: (expectedSessionId?: string) => AgentSessionSubmissionTarget | null;
  activateSession: (sessionId: string) => Promise<boolean>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  selectProfile: (profileId: string | null) => Promise<boolean>;
  refreshSessionProfile: () => Promise<void>;
  refreshActiveSessionContext: () => Promise<void>;
  addAttachment: (attachment: AgentInputAttachmentV3) => void;
  removeAttachment: (
    attachmentId: string,
    scope: AgentInputAttachmentV3['scope']
  ) => void;
  clearMessageAttachments: () => void;
  sendMessage: (content: string, options?: AgentSendMessageOptions) => Promise<boolean>;
  sendDraftMessage: (
    conversationDraftTarget: AgentConversationDraftTargetV1,
    content: string,
    profileId: string
  ) => Promise<AgentSession | null>;
  cancelCurrentRun: () => Promise<void>;
  acceptPermission: (request?: AgentTimelinePermissionRequestView) => Promise<void>;
  rejectPermission: (request?: AgentTimelinePermissionRequestView) => Promise<void>;
  resolvePlan: (runId: string, planId: string, decision: 'accept' | 'reject' | 'revise', guidance?: string) => Promise<void>;
  resolveUserIntervention: (input: {
    runId: string;
    targetId: string;
    interactionId: string;
    interactionRevision: string;
    candidateSetDigest: string;
    expectedProjectionCursor: number;
    decision: 'select' | 'revise' | 'reject';
    optionId?: string;
    guidance?: string;
  }) => Promise<void>;
}

type Store = AgentSessionState & AgentSessionActions;

interface AgentSendMessageOptions {
  expectedTarget?: AgentSessionSubmissionTarget;
}

const workspaceTreeRevisionBySession = new Map<string, number>();
const MAX_AGENT_INPUT_ATTACHMENTS_V3 = 32;
const CANONICAL_PROGRESS_STREAM_RETRY_MS = 250;
const CANONICAL_PROGRESS_REQUEST_TIMEOUT_MS = 5_000;
const CANONICAL_PROGRESS_TRAILING_ATTEMPTS = 3;
const AGENT_SESSION_INITIALIZATION_RETRY_DELAYS_MS = [0, 250, 750] as const;

interface CanonicalProgressWatcher {
  readonly sessionId: string;
  acquire: () => () => Promise<void>;
  stop: () => void;
}

const canonicalProgressWatchers =
  new Map<string, CanonicalProgressWatcher>();
const canonicalTimelineFetches =
  new Map<string, ReturnType<typeof getAgentTimeline>>();
const canonicalTimelineStaleSessions = new Set<string>();
const canonicalTimelineFailClosedSessions = new Set<string>();
const canonicalTimelineGenerations = new Map<string, number>();
const pendingHostMutationOwners = new Map<string, string>();

function boundedStoredString(value: unknown, maxBytes: number): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && new TextEncoder().encode(value).byteLength <= maxBytes
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : null;
}

function decodeStoredHostAttachment(value: unknown): AgentInputAttachmentV3 | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  const attachmentId = boundedStoredString(value.attachmentId, 512);
  const resourceId = boundedStoredString(value.resourceId, 512);
  const displayName = boundedStoredString(value.displayName, 1024);
  if (
    keys !== 'attachmentId,displayName,kind,resourceId,scope'
    || !attachmentId
    || !resourceId
    || !displayName
    || displayName === '.'
    || displayName === '..'
    || displayName.includes('/')
    || displayName.includes('\\')
    || (value.kind !== 'file' && value.kind !== 'directory')
    || (value.scope !== 'message' && value.scope !== 'session')
  ) {
    return null;
  }
  return {
    kind: value.kind,
    attachmentId,
    resourceId,
    displayName,
    scope: value.scope,
  };
}

let agentSessionSelectionGeneration = 0;
let settledAgentSessionSelectionGeneration = 0;
let activeAgentSessionLoadingScopeKey: string | null = null;
const agentSessionSelectionQueues = new Map<string, Promise<void>>();

function enqueueAgentSessionSelection<T>(
  operation: () => Promise<T>,
  scopeKey = currentWorkspaceScopeKey()
): Promise<T> {
  const previous = agentSessionSelectionQueues.get(scopeKey) ?? Promise.resolve();
  const queued = previous.then(operation, operation);
  const settled = queued.then(
    () => undefined,
    () => undefined
  );
  agentSessionSelectionQueues.set(scopeKey, settled);
  void settled.finally(() => {
    if (agentSessionSelectionQueues.get(scopeKey) === settled) {
      agentSessionSelectionQueues.delete(scopeKey);
    }
  });
  return queued;
}

function markCanonicalTimelineStale(sessionId: string): void {
  canonicalTimelineGenerations.set(
    sessionId,
    (canonicalTimelineGenerations.get(sessionId) ?? 0) + 1
  );
  canonicalTimelineStaleSessions.add(sessionId);
}

function currentTimelineRevision(sessionId: string): number {
  const timeline = useAgentSessionStore.getState().timeline;
  return timeline?.sessionId === sessionId
    ? timeline.revision ?? 0
    : 0;
}

function currentWorkspaceScope(): ListAgentSessionsRequest {
  const workspace = useWorkspaceStore.getState().current;
  return createWorkspaceScope(workspace);
}

function currentWorkspaceScopeKey(): string {
  return createWorkspaceScopeKey(useWorkspaceStore.getState().current);
}

function currentWorkspacePath(): string | undefined {
  const workspaceState = useWorkspaceStore.getState();
  return createWorkspaceBinding({
    current: workspaceState.current,
    activeFolder: workspaceState.getActiveFolder(),
    activeFolderId: workspaceState.activeFolderId ?? undefined,
  })?.openPath;
}

function captureCurrentSubmissionTarget(
  expectedSessionId?: string
): AgentSessionSubmissionTarget | null {
  const state = useAgentSessionStore.getState();
  const session = state.session;
  const sessionId = session?.id;
  const conversationTarget = session?.conversationTarget;
  if (
    !sessionId
    || !conversationTarget
    || conversationTarget.sessionId !== sessionId
    || (expectedSessionId !== undefined && sessionId !== expectedSessionId)
    || !state.selectionReady
    || state.localWorkspaceScopeKey !== conversationTarget.workspaceScopeKey
    || (!session.projectId
      && conversationTarget.workspaceScopeKey !== currentWorkspaceScopeKey())
    || state.timeline?.sessionId !== sessionId
    || canonicalTimelineStaleSessions.has(sessionId)
    || canonicalTimelineFailClosedSessions.has(sessionId)
    || settledAgentSessionSelectionGeneration !== agentSessionSelectionGeneration
  ) {
    return null;
  }
  return {
    sessionId,
    selectionGeneration: settledAgentSessionSelectionGeneration,
    conversationTarget,
  };
}

function submissionTargetIsCurrent(target: AgentSessionSubmissionTarget): boolean {
  const current = captureCurrentSubmissionTarget(target.sessionId);
  return Boolean(
    current
    && current.selectionGeneration === target.selectionGeneration
    && current.conversationTarget.targetId === target.conversationTarget.targetId
    && current.conversationTarget.targetRevision
      === target.conversationTarget.targetRevision
  );
}

function sessionMatchesDraftAdmission(
  session: AgentSession,
  draftTarget: AgentConversationDraftTargetV1,
  profileId: string
): boolean {
  const target = session.conversationTarget;
  if (
    session.profileId !== profileId
    || target.sessionId !== session.id
    || target.workspaceScopeKey !== draftTarget.workspaceScopeKey
  ) {
    return false;
  }
  if (draftTarget.kind === 'project') {
    return session.projectId === draftTarget.projectId
      && target.projectId === draftTarget.projectId;
  }
  return session.projectId === undefined && target.projectId === undefined;
}

function normalizeInputAttachment(
  attachment: AgentInputAttachmentV3
): AgentInputAttachmentV3 | null {
  return decodeStoredHostAttachment(attachment);
}

function attachmentKey(attachment: AgentInputAttachmentV3): string {
  return `${attachment.scope}:${attachment.attachmentId}:${attachment.resourceId}`;
}

function mergeAttachments(
  existing: AgentInputAttachmentV3[],
  attachment: AgentInputAttachmentV3
): AgentInputAttachmentV3[] {
  const key = attachmentKey(attachment);
  return [
    ...existing.filter((candidate) => attachmentKey(candidate) !== key),
    attachment,
  ];
}

function retainUnsubmittedMessageAttachments(
  current: AgentInputAttachmentV3[],
  submitted: AgentInputAttachmentV3[]
): AgentInputAttachmentV3[] {
  const submittedInstances = new Set(submitted);
  return current.filter((attachment) => !submittedInstances.has(attachment));
}

function claimPendingHostMutation(sessionId: string): string | null {
  if (pendingHostMutationOwners.has(sessionId)) return null;
  const ownerToken = globalThis.crypto.randomUUID();
  pendingHostMutationOwners.set(sessionId, ownerToken);
  useAgentSessionStore.setState((state) => ({
    activeSubmissionSessionIds: state.activeSubmissionSessionIds.includes(sessionId)
      ? state.activeSubmissionSessionIds
      : [...state.activeSubmissionSessionIds, sessionId],
  }));
  return ownerToken;
}

function releasePendingHostMutation(sessionId: string, ownerToken: string): void {
  if (pendingHostMutationOwners.get(sessionId) === ownerToken) {
    pendingHostMutationOwners.delete(sessionId);
    useAgentSessionStore.setState((state) => ({
      activeSubmissionSessionIds: state.activeSubmissionSessionIds.filter(
        (candidate) => candidate !== sessionId
      ),
    }));
  }
}

function outboundAttachments(state: Store): AgentInputAttachmentV3[] | undefined {
  const normalized = [...state.sessionAttachments, ...state.messageAttachments]
    .map((attachment) => normalizeInputAttachment(attachment));
  if (normalized.some((attachment) => attachment === null)) return undefined;
  const deduplicated = new Map<string, AgentInputAttachmentV3>();
  for (const attachment of normalized) {
    if (!attachment) continue;
    if (deduplicated.has(attachment.resourceId)) return undefined;
    deduplicated.set(attachment.resourceId, attachment);
  }
  return [...deduplicated.values()];
}

type DurableSessionAttachments =
  | { ok: true; attachments: AgentInputAttachmentV3[] }
  | { ok: false };

function durableSessionAttachments(
  timeline: AgentTimelineResult,
  expectedSessionId?: string
): DurableSessionAttachments {
  if (expectedSessionId && timeline.sessionId !== expectedSessionId) {
    return { ok: false };
  }
  for (let turnIndex = timeline.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const blocks = timeline.turns[turnIndex].blocks;
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block.kind !== 'user') continue;
      const attachments = block.attachments ?? [];
      if (attachments.length > 32) return { ok: false };
      const decoded: AgentInputAttachmentV3[] = [];
      const attachmentIds = new Set<string>();
      const resourceIds = new Set<string>();
      for (const value of attachments) {
        const attachment = decodeStoredHostAttachment(value);
        if (
          !attachment
          || attachmentIds.has(attachment.attachmentId)
          || resourceIds.has(attachment.resourceId)
        ) return { ok: false };
        attachmentIds.add(attachment.attachmentId);
        resourceIds.add(attachment.resourceId);
        decoded.push(attachment);
      }
      const sessionAttachments = decoded.filter(
        (attachment) => attachment.scope === 'session'
      );
      return { ok: true, attachments: sessionAttachments };
    }
  }
  return { ok: true, attachments: [] };
}

function restoredSessionAttachmentState(
  timeline: AgentTimelineResult,
  expectedSessionId?: string
): {
  sessionAttachments: AgentInputAttachmentV3[];
  attachmentError: string | null;
} {
  const restored = durableSessionAttachments(timeline, expectedSessionId);
  return restored.ok
    ? { sessionAttachments: restored.attachments, attachmentError: null }
    : {
        sessionAttachments: [],
        attachmentError: agentSessionMessage('agent.attachment.durableInvalid'),
      };
}

function permissionRequestRunId(request: AgentTimelinePermissionRequestView): string | null {
  const runId = request.runId?.trim();
  return runId || null;
}

function cancellableTimelineRunId(
  timeline: AgentTimelineResult | null
): string | null {
  const projection = timeline?.runProjection;
  if (
    !projection
    || !['active', 'waitingUser', 'waitingExternal', 'paused'].includes(
      projection.status
    )
  ) {
    return null;
  }
  const runId = projection.runId.trim();
  return runId || null;
}

function addInFlightSessionId(ids: string[], sessionId: string): string[] {
  return ids.includes(sessionId) ? ids : [...ids, sessionId];
}

function removeInFlightSessionId(ids: string[], sessionId: string): string[] {
  return ids.filter((id) => id !== sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireExactNativeTimeline(value: unknown): AgentTimelineResult {
  if (
    !isNativeWorkSegmentsTimelineSnapshot(value)
    || Object.prototype.hasOwnProperty.call(value, 'legacyPrefixTurnCount')
  ) {
    throw new UnsupportedTimelineHistorySchemaError();
  }
  assertSharedConversationProjectionV3(value);
  return value;
}

function pendingPermissionFromTimeline(
  timeline: AgentTimelineResult
): PendingPermission | null {
  const pending = timeline.interactionProjection?.pending;
  return pending?.kind === 'permission'
    ? { request: pending.request }
    : null;
}

function boundedAgentTimelineRequest(
  sessionId: string
): ReturnType<typeof getAgentTimeline> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    CANONICAL_PROGRESS_REQUEST_TIMEOUT_MS
  );
  return getAgentTimeline(sessionId, controller.signal).finally(() => {
    window.clearTimeout(timeout);
  });
}

function boundedAgentSessionActivationRequest(
  sessionId: string
): ReturnType<typeof activateAgentSession> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    CANONICAL_PROGRESS_REQUEST_TIMEOUT_MS
  );
  return activateAgentSession(sessionId, controller.signal).finally(() => {
    window.clearTimeout(timeout);
  });
}

async function refreshCanonicalTimeline(
  sessionId: string,
  preservePlayback: boolean,
  forceFresh = false
): Promise<boolean> {
  const staleAtStart = canonicalTimelineStaleSessions.has(sessionId);
  const refreshGeneration =
    canonicalTimelineGenerations.get(sessionId) ?? 0;
  if (forceFresh) {
    const existing = canonicalTimelineFetches.get(sessionId);
    if (existing) {
      try {
        await existing;
      } catch {
        // A trailing refresh still needs a new request after a failed or stale
        // in-flight fetch.
      }
      if (canonicalTimelineFetches.get(sessionId) === existing) {
        canonicalTimelineFetches.delete(sessionId);
      }
    }
  }
  let request = canonicalTimelineFetches.get(sessionId);
  if (!request) {
    const created = boundedAgentTimelineRequest(sessionId);
    request = created;
    canonicalTimelineFetches.set(sessionId, created);
    const clear = () => {
      if (canonicalTimelineFetches.get(sessionId) === created) {
        canonicalTimelineFetches.delete(sessionId);
      }
    };
    void created.then(clear, clear);
  }
  const result = await request;
  if (!result.ok || !result.data) {
    canonicalTimelineStaleSessions.add(sessionId);
    useAgentSessionStore.setState((state) => state.session?.id === sessionId
      ? { selectionReady: false }
      : state);
    return false;
  }
  if (useAgentSessionStore.getState().session?.id !== sessionId) return true;
  let incomingTimeline: AgentTimelineResult;
  try {
    incomingTimeline = requireExactNativeTimeline(result.data);
  } catch (error) {
    canonicalTimelineStaleSessions.add(sessionId);
    canonicalTimelineFailClosedSessions.add(sessionId);
    useAgentSessionStore.setState((state) => state.session?.id === sessionId
      ? {
          errorMessage: error instanceof Error ? error.message : String(error),
          selectionReady: false,
        }
      : state);
    return false;
  }
  let nextTimeline: AgentTimelineResult | null = null;
  useAgentSessionStore.setState((state) => {
    if (
      preservePlayback &&
      state.timeline &&
      (incomingTimeline.revision ?? 0) < (state.timeline.revision ?? 0)
    ) {
      nextTimeline = state.timeline;
      return state;
    }
    nextTimeline = preservePlayback
      ? reconcileTimelineSnapshot(state.timeline, incomingTimeline)
      : timelineAsReplay(incomingTimeline);
    return {
      timeline: nextTimeline,
      pendingPermission: pendingPermissionFromTimeline(nextTimeline),
    };
  });
  if (nextTimeline) {
    refreshWorkspaceTreeForTimeline(nextTimeline);
    if (!await validateProjectedRunIdentity(nextTimeline)) {
      canonicalTimelineStaleSessions.add(sessionId);
      useAgentSessionStore.setState((state) => state.session?.id === sessionId
        ? { selectionReady: false }
        : state);
      return false;
    }
  } else {
    canonicalTimelineStaleSessions.add(sessionId);
    return false;
  }
  if (
    (canonicalTimelineGenerations.get(sessionId) ?? 0)
      !== refreshGeneration
    || (staleAtStart && !forceFresh)
  ) {
    return false;
  }
  canonicalTimelineStaleSessions.delete(sessionId);
  canonicalTimelineFailClosedSessions.delete(sessionId);
  useAgentSessionStore.setState((state) => state.session?.id === sessionId
    ? { selectionReady: true }
    : state);
  return true;
}

function startCanonicalProgressWatcher(
  sessionId: string
): () => Promise<void> {
  const existing = canonicalProgressWatchers.get(sessionId);
  if (existing) return existing.acquire();

  let stopped = false;
  let consumers = 0;
  let streamInFlight: Promise<void> | undefined;
  let streamController: AbortController | undefined;
  let releaseInFlight: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  const isActiveSession = () =>
    !stopped
    && useAgentSessionStore.getState().session?.id === sessionId;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    streamController?.abort();
    streamController = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    if (canonicalProgressWatchers.get(sessionId) === watcher) {
      canonicalProgressWatchers.delete(sessionId);
    }
  };
  const applyStreamEvent = (event: AgentTimelineStreamEvent): void => {
    if (event.sessionId !== sessionId || event.revision < 0) {
      throw new Error('Agent timeline stream session or revision mismatch.');
    }
    let appliedTimeline: AgentTimelineResult | null = null;
    let applyError: unknown;
    useAgentSessionStore.setState((state) => {
      if (state.session?.id !== sessionId || !isActiveSession()) return state;
      try {
        if (event.type === 'snapshot') {
          const incoming = requireExactNativeTimeline(event.snapshot);
          if (
            incoming.sessionId !== sessionId
            || incoming.revision !== event.revision
          ) {
            throw new Error('Agent timeline snapshot identity mismatch.');
          }
          if (
            state.timeline
            && incoming.revision < state.timeline.revision
          ) {
            return state;
          }
          appliedTimeline = reconcileTimelineSnapshot(state.timeline, incoming);
        } else {
          if (
            event.delta.sessionId !== sessionId
            || event.delta.revision !== event.revision
          ) {
            throw new Error('Agent timeline delta identity mismatch.');
          }
          if (
            state.timeline
            && event.delta.revision <= state.timeline.revision
          ) {
            return state;
          }
          if (!state.timeline) {
            throw new AgentTimelineRevisionGapError(0, event.delta.baseRevision);
          }
          appliedTimeline = applyAgentTimelineDelta(state.timeline, event.delta);
          requireExactNativeTimeline(appliedTimeline);
        }
        return {
          timeline: appliedTimeline,
          pendingPermission: pendingPermissionFromTimeline(appliedTimeline),
        };
      } catch (error) {
        applyError = error instanceof AgentTimelineRevisionGapError
          || error instanceof UnsupportedTimelineHistorySchemaError
          || error instanceof AgentTimelineStreamProtocolError
          ? error
          : new AgentTimelineStreamProtocolError(
              error instanceof Error ? error.message : String(error)
            );
        return state;
      }
    });
    if (applyError) throw applyError;
    if (!appliedTimeline) return;
    refreshWorkspaceTreeForTimeline(appliedTimeline);
    if (isCanonicalTimelineTerminal(appliedTimeline)) {
      stop();
      return;
    }
    void validateProjectedRunIdentity(appliedTimeline).then((ready) => {
      if (!ready) markCanonicalTimelineStale(sessionId);
    });
  };
  const runStreamLoop = async (): Promise<void> => {
    while (consumers > 0 && isActiveSession()) {
      const controller = new AbortController();
      streamController = controller;
      try {
        await streamAgentTimeline(
          sessionId,
          applyStreamEvent,
          { afterRevision: currentTimelineRevision(sessionId) },
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted || stopped || consumers === 0) break;
        if (
          error instanceof UnsupportedTimelineHistorySchemaError
          || error instanceof AgentTimelineStreamProtocolError
        ) {
          canonicalTimelineStaleSessions.add(sessionId);
          canonicalTimelineFailClosedSessions.add(sessionId);
          useAgentSessionStore.setState((state) => state.session?.id === sessionId
            ? {
                errorMessage: error.message,
              }
            : state);
          break;
        }
        markCanonicalTimelineStale(sessionId);
      } finally {
        if (streamController === controller) streamController = undefined;
      }
      if (controller.signal.aborted || stopped || consumers === 0) break;
      await refreshCanonicalTimeline(sessionId, true, true);
      if (stopped || consumers === 0 || !isActiveSession()) break;
      await sleep(CANONICAL_PROGRESS_STREAM_RETRY_MS);
    }
  };
  const ensureStream = () => {
    if (
      stopped
      || consumers === 0
      || streamInFlight
      || canonicalTimelineFailClosedSessions.has(sessionId)
      || !isActiveSession()
    ) {
      return;
    }
    const current = runStreamLoop();
    streamInFlight = current;
    const finish = () => {
      if (streamInFlight === current) streamInFlight = undefined;
      if (!stopped && consumers > 0 && isActiveSession()) ensureStream();
    };
    void current.then(finish, finish);
  };
  const releaseWhenUnused = (): Promise<void> => {
    if (releaseInFlight) return releaseInFlight;
    const current = (async () => {
      streamController?.abort();
      const pendingStream = streamInFlight;
      if (pendingStream) await pendingStream;
      if (consumers > 0) {
        ensureStream();
        return;
      }
      if (!isActiveSession()) {
        stop();
        return;
      }
      for (
        let attempt = 0;
        attempt < CANONICAL_PROGRESS_TRAILING_ATTEMPTS;
        attempt += 1
      ) {
        if (consumers > 0 || !isActiveSession()) break;
        if (await refreshCanonicalTimeline(sessionId, true, true)) break;
        if (attempt + 1 < CANONICAL_PROGRESS_TRAILING_ATTEMPTS) {
          await sleep(CANONICAL_PROGRESS_STREAM_RETRY_MS);
        }
      }
      if (consumers === 0) {
        stop();
      } else {
        ensureStream();
      }
    })().catch(() => {
      if (consumers === 0) stop();
    });
    releaseInFlight = current;
    const finish = () => {
      if (releaseInFlight === current) {
        releaseInFlight = undefined;
      }
      if (!stopped && consumers === 0) {
        void releaseWhenUnused();
      }
    };
    void current.then(finish, finish);
    return current;
  };
  const watcher: CanonicalProgressWatcher = {
    sessionId,
    acquire: () => {
      if (stopped) return async () => {};
      consumers += 1;
      ensureStream();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        consumers -= 1;
        if (consumers > 0) return;
        await releaseWhenUnused();
      };
    },
    stop,
  };
  canonicalProgressWatchers.set(sessionId, watcher);
  unsubscribe = useAgentSessionStore.subscribe((state) => {
    if (state.session?.id === sessionId) {
      ensureStream();
      return;
    }
    stop();
  });
  return watcher.acquire();
}

async function validateProjectedRunIdentity(
  timeline: AgentTimelineResult
): Promise<boolean> {
  const runProjection = timeline.runProjection;
  if (runProjection && !runProjection.runId.trim()) return false;
  return true;
}

function refreshWorkspaceTreeForTimeline(timeline: AgentTimelineResult): void {
  const revision = timeline.workspaceProjection?.revision ?? 0;
  const previous = workspaceTreeRevisionBySession.get(timeline.sessionId) ?? 0;
  if (revision <= previous) return;
  workspaceTreeRevisionBySession.set(timeline.sessionId, revision);
  useWorkspaceStore.getState().bumpTreeRevision();
}


function isCanonicalTimelineTerminal(timeline: AgentTimelineResult): boolean {
  const status = timeline.runProjection?.status;
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function newHostCallerRequestId(kind: string): string {
  return `host-ui-${kind}-${globalThis.crypto.randomUUID()}`;
}

class HostMutationOutcomeError extends Error {
  constructor(
    message: string,
    readonly disposition: AgentHostCallerMutationErrorV2['disposition']
  ) {
    super(message);
    this.name = 'HostMutationOutcomeError';
  }
}

function hostCallerMutationDisposition(
  response: Pick<ApiResponse<unknown>, 'ok' | 'data'>
): AgentHostCallerMutationErrorV2['disposition'] | null {
  if (response.ok) return null;
  if (
    isRecord(response.data)
    && response.data.schemaVersion === 'deepcode.host.caller-mutation-error.v2'
    && (
      response.data.disposition === 'rejected'
      || response.data.disposition === 'pending'
      || response.data.disposition === 'indeterminate'
    )
  ) {
    return response.data.disposition;
  }
  return 'indeterminate';
}

async function startAndWaitAgentRun(
  sessionId: string,
  request: StartAgentRunRequest,
  admitted?: () => void
): Promise<AgentRunResult> {
  const started = await startAgentRun(sessionId, request);
  if (!started.ok || !started.data) {
    const message = started.message ?? started.error ?? 'Shared session run start failed';
    throw new HostMutationOutcomeError(
      message,
      hostCallerMutationDisposition(started) ?? 'indeterminate'
    );
  }
  const result = started.data;
  admitted?.();
  markCanonicalTimelineStale(sessionId);
  void refreshCanonicalTimeline(sessionId, true, true);
  return result;
}

function waitForAgentSessionLoad(): Promise<void> {
  if (!useAgentSessionStore.getState().loading) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      unsubscribe?.();
      resolve();
    };
    unsubscribe = useAgentSessionStore.subscribe((state) => {
      if (!state.loading) finish();
    });
    if (!useAgentSessionStore.getState().loading) finish();
  });
}

interface AgentSessionSelectionSnapshot {
  session: AgentSession | null;
  currentSessionId?: string;
  localWorkspaceScopeKey?: string;
  timeline: AgentTimelineResult | null;
  profileId?: string;
  selectionReady: boolean;
  messageAttachments: AgentInputAttachmentV3[];
  sessionAttachments: AgentInputAttachmentV3[];
  pendingPermission: PendingPermission | null;
  resolvingPermission: PermissionResolution | null;
  resolvingPlan: PlanResolution | null;
}

type CanonicalHostSelection =
  | {
      kind: 'ready';
      session: AgentSession;
      timeline: AgentTimelineResult;
      sessionAttachments: AgentInputAttachmentV3[];
      attachmentError: string | null;
    }
  | { kind: 'empty' }
  | { kind: 'invalid'; session: AgentSession; message: string }
  | { kind: 'unavailable'; message: string };

function captureAgentSessionSelection(
  state: AgentSessionState
): AgentSessionSelectionSnapshot {
  return {
    session: state.session,
    currentSessionId: state.currentSessionId,
    localWorkspaceScopeKey: state.localWorkspaceScopeKey,
    timeline: state.timeline,
    profileId: state.profileId,
    selectionReady: state.selectionReady,
    messageAttachments: state.messageAttachments,
    sessionAttachments: state.sessionAttachments,
    pendingPermission: state.pendingPermission,
    resolvingPermission: state.resolvingPermission,
    resolvingPlan: state.resolvingPlan,
  };
}

function restoredAgentSessionSelection(
  snapshot: AgentSessionSelectionSnapshot,
  errorMessage: string
): Partial<AgentSessionState> {
  return {
    ...snapshot,
    loading: false,
    errorMessage,
  };
}

function finishAgentSessionSelection(
  selectionGeneration: number,
  selectionScopeKey: string
): void {
  if (selectionGeneration !== agentSessionSelectionGeneration) return;
  if (activeAgentSessionLoadingScopeKey === selectionScopeKey) {
    activeAgentSessionLoadingScopeKey = null;
  }
  useAgentSessionStore.setState({ loading: false });
}

async function readCanonicalHostSelection(
  scope: ListAgentSessionsRequest
): Promise<CanonicalHostSelection> {
  let current;
  try {
    current = await getCurrentAgentSession(scope);
  } catch (error) {
    return {
      kind: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!current.ok) {
    return {
      kind: 'unavailable',
      message: current.message ?? current.error ?? 'Agent session lookup failed',
    };
  }
  if (!current.data) return { kind: 'empty' };

  const session = current.data.session;
  let timelineResult;
  try {
    timelineResult = await boundedAgentTimelineRequest(session.id);
  } catch (error) {
    return {
      kind: 'invalid',
      session,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!timelineResult.ok || !timelineResult.data) {
    return {
      kind: 'invalid',
      session,
      message: timelineResult.message
        ?? timelineResult.error
        ?? 'Canonical Session timeline is unavailable.',
    };
  }
  try {
    const timeline = timelineAsReplay(
      requireExactNativeTimeline(timelineResult.data)
    );
    if (!await validateProjectedRunIdentity(timeline)) {
      return {
        kind: 'invalid',
        session,
        message: 'Canonical Session run identity is unavailable.',
      };
    }
    const restoredAttachments = restoredSessionAttachmentState(
      timeline,
      session.id
    );
    return {
      kind: 'ready',
      session,
      timeline,
      sessionAttachments: restoredAttachments.sessionAttachments,
      attachmentError: restoredAttachments.attachmentError,
    };
  } catch (error) {
    return {
      kind: 'invalid',
      session,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyCanonicalHostSelection(
  selection: Exclude<CanonicalHostSelection, { kind: 'unavailable' }>,
  selectionScopeKey: string,
  fallbackError?: string
): void {
  if (selection.kind === 'ready') {
    canonicalTimelineStaleSessions.delete(selection.session.id);
    canonicalTimelineFailClosedSessions.delete(selection.session.id);
    useAgentSessionStore.setState((state) => ({
      session: selection.session,
      localWorkspaceScopeKey: selection.session.conversationTarget.workspaceScopeKey,
      sessions: [
        selection.session,
        ...state.sessions.filter((item) => item.id !== selection.session.id),
      ],
      currentSessionId: selection.session.id,
      timeline: selection.timeline,
      profileId: selection.session.profileId,
      messageAttachments: [],
      sessionAttachments: selection.sessionAttachments,
      pendingPermission: pendingPermissionFromTimeline(selection.timeline),
      resolvingPermission: null,
      resolvingPlan: null,
      errorMessage: selection.attachmentError,
      loading: false,
      selectionReady: true,
    }));
    return;
  }
  if (selection.kind === 'invalid') {
    canonicalTimelineStaleSessions.add(selection.session.id);
    canonicalTimelineFailClosedSessions.add(selection.session.id);
    useAgentSessionStore.setState((state) => ({
      session: selection.session,
      localWorkspaceScopeKey: selection.session.conversationTarget.workspaceScopeKey,
      sessions: [
        selection.session,
        ...state.sessions.filter((item) => item.id !== selection.session.id),
      ],
      currentSessionId: selection.session.id,
      timeline: null,
      profileId: selection.session.profileId,
      messageAttachments: [],
      sessionAttachments: [],
      pendingPermission: null,
      resolvingPermission: null,
      resolvingPlan: null,
      errorMessage: selection.message || fallbackError || null,
      loading: false,
      selectionReady: false,
    }));
    return;
  }
  useAgentSessionStore.setState({
    session: null,
    localWorkspaceScopeKey: selectionScopeKey,
    currentSessionId: undefined,
    timeline: null,
    profileId: undefined,
    messageAttachments: [],
    sessionAttachments: [],
    pendingPermission: null,
    resolvingPermission: null,
    resolvingPlan: null,
    errorMessage: fallbackError ?? null,
    loading: false,
    selectionReady: false,
  });
}

export const useAgentSessionStore = create<Store>((set, get) => ({
  session: null,
  sessions: [],
  currentSessionId: undefined,
  localWorkspaceScopeKey: undefined,
  timeline: null,
  profileId: undefined,
  profileSelectionBusy: false,
  loading: false,
  selectionReady: false,
  cancellingSessionIds: [],
  activeSubmissionSessionIds: [],
  errorMessage: null,
  messageAttachments: [],
  sessionAttachments: [],
  pendingPermission: null,
  resolvingPermission: null,
  resolvingPlan: null,

  loadCurrentSelection: async () => {
    const nextScopeKey = currentWorkspaceScopeKey();
    const currentSelectionReady = () => {
      const state = get();
      return Boolean(
        state.session
        && state.selectionReady
        && state.localWorkspaceScopeKey === nextScopeKey
        && state.timeline?.sessionId === state.session.id
        && !canonicalTimelineStaleSessions.has(state.session.id)
        && !canonicalTimelineFailClosedSessions.has(state.session.id)
      );
    };
    if (currentSelectionReady()) return;
    if (
      get().loading
      && activeAgentSessionLoadingScopeKey === nextScopeKey
    ) {
      await waitForAgentSessionLoad();
      if (currentWorkspaceScopeKey() !== nextScopeKey) return get().loadCurrentSelection();
      if (!currentSelectionReady()) await get().loadCurrentSelection();
      return;
    }
    const selectionGeneration = ++agentSessionSelectionGeneration;
    activeAgentSessionLoadingScopeKey = nextScopeKey;
    const existingSession = get().session;
    const existingTimeline = get().timeline;
    const failClosedSelection = Boolean(
      existingSession
      && (
        get().localWorkspaceScopeKey !== nextScopeKey
        || existingTimeline?.sessionId !== existingSession.id
      )
    );
    set({
      loading: true,
      selectionReady: false,
      errorMessage: null,
      messageAttachments: [],
      sessionAttachments: [],
      ...(failClosedSelection ? {
        session: null,
        timeline: null,
        profileId: undefined,
        localWorkspaceScopeKey: undefined,
        pendingPermission: null,
        resolvingPermission: null,
        resolvingPlan: null,
      } : {}),
    });
    try {
      await enqueueAgentSessionSelection(async () => {
      let lastError = 'Agent session initialization failed';
      for (
        let attempt = 0;
        attempt < AGENT_SESSION_INITIALIZATION_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        if (selectionGeneration !== agentSessionSelectionGeneration) return;
        if (currentWorkspaceScopeKey() !== nextScopeKey) return;
        const retryDelay = AGENT_SESSION_INITIALIZATION_RETRY_DELAYS_MS[attempt] ?? 0;
        if (retryDelay > 0) await sleep(retryDelay);
        if (selectionGeneration !== agentSessionSelectionGeneration) return;
        if (currentWorkspaceScopeKey() !== nextScopeKey) return;
        try {
          const scope = currentWorkspaceScope();
          const list = await listAgentSessions(scope);
          if (selectionGeneration !== agentSessionSelectionGeneration) return;
          if (currentWorkspaceScopeKey() !== nextScopeKey) return;
          if (list.ok && list.data) {
            set({
              sessions: list.data.sessions,
              currentSessionId: list.data.currentSessionId,
            });
          }
          const current = await getCurrentAgentSession(scope);
          if (selectionGeneration !== agentSessionSelectionGeneration) return;
          if (currentWorkspaceScopeKey() !== nextScopeKey) return;
          if (!current.ok) {
            throw new Error(
              current.message ?? current.error ?? 'Agent session lookup failed'
            );
          }
          if (current.data) {
            const timelineResult = await boundedAgentTimelineRequest(
              current.data.session.id
            );
            if (selectionGeneration !== agentSessionSelectionGeneration) return;
            if (currentWorkspaceScopeKey() !== nextScopeKey) return;
            if (!timelineResult.ok || !timelineResult.data) {
              throw new Error(
                timelineResult.message ?? 'Canonical Session timeline is unavailable.'
              );
            }
            const timeline = timelineAsReplay(
              requireExactNativeTimeline(timelineResult.data)
            );
            const identityReady = await validateProjectedRunIdentity(timeline);
            if (!identityReady) {
              markCanonicalTimelineStale(current.data.session.id);
              throw new Error(
                'Canonical Session run identity is unavailable.'
              );
            }
            if (selectionGeneration !== agentSessionSelectionGeneration) return;
            if (currentWorkspaceScopeKey() !== nextScopeKey) return;
            canonicalTimelineStaleSessions.delete(current.data.session.id);
            canonicalTimelineFailClosedSessions.delete(current.data.session.id);
            const restoredAttachments = restoredSessionAttachmentState(
              timeline,
              current.data.session.id
            );
            set({
              session: current.data.session,
              localWorkspaceScopeKey:
                current.data.session.conversationTarget.workspaceScopeKey,
              timeline,
              profileId: current.data.session.profileId,
              messageAttachments: [],
              sessionAttachments: restoredAttachments.sessionAttachments,
              pendingPermission: pendingPermissionFromTimeline(timeline),
              errorMessage: restoredAttachments.attachmentError,
              loading: false,
              selectionReady: true,
            });
            settledAgentSessionSelectionGeneration = selectionGeneration;
            return;
          }
          set({
            session: null,
            localWorkspaceScopeKey: nextScopeKey,
            currentSessionId: undefined,
            timeline: null,
            profileId: undefined,
            messageAttachments: [],
            sessionAttachments: [],
            pendingPermission: null,
            resolvingPermission: null,
            resolvingPlan: null,
            errorMessage: null,
            loading: false,
            selectionReady: true,
          });
          settledAgentSessionSelectionGeneration = selectionGeneration;
          return;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (selectionGeneration !== agentSessionSelectionGeneration) return;
      const failedSessionId = get().session?.id;
      if (failedSessionId) {
        canonicalTimelineFailClosedSessions.add(failedSessionId);
      }
      set({
        errorMessage: lastError,
        loading: false,
        selectionReady: false,
      });
      }, nextScopeKey);
    } finally {
      finishAgentSessionSelection(selectionGeneration, nextScopeKey);
    }
  },

  enterDraft: () => {
    agentSessionSelectionGeneration += 1;
    settledAgentSessionSelectionGeneration = agentSessionSelectionGeneration;
    activeAgentSessionLoadingScopeKey = null;
    set({
      session: null,
      currentSessionId: undefined,
      localWorkspaceScopeKey: currentWorkspaceScopeKey(),
      timeline: null,
      profileId: undefined,
      profileSelectionBusy: false,
      loading: false,
      selectionReady: true,
      errorMessage: null,
      messageAttachments: [],
      sessionAttachments: [],
      pendingPermission: null,
      resolvingPermission: null,
      resolvingPlan: null,
    });
  },

  observeSessionProjection: (sessionId) =>
    startCanonicalProgressWatcher(sessionId),

  refreshSessions: async () => {
    const selectionGeneration = agentSessionSelectionGeneration;
    const selectionScopeKey = currentWorkspaceScopeKey();
    const selectionScope = currentWorkspaceScope();
    await enqueueAgentSessionSelection(async () => {
      const result = await listAgentSessions(selectionScope);
      if (
        selectionGeneration !== agentSessionSelectionGeneration
        || selectionScopeKey !== currentWorkspaceScopeKey()
      ) return;
      if (result.ok && result.data) {
        set({
          sessions: result.data.sessions,
          currentSessionId: result.data.currentSessionId,
        });
      }
    }, selectionScopeKey);
  },

  captureSubmissionTarget: (expectedSessionId) => (
    captureCurrentSubmissionTarget(expectedSessionId)
  ),

  createNewSession: async () => {
    const selectionScopeKey = currentWorkspaceScopeKey();
    if (
      get().loading
      && activeAgentSessionLoadingScopeKey === selectionScopeKey
    ) {
      await waitForAgentSessionLoad();
      if (selectionScopeKey !== currentWorkspaceScopeKey()) return null;
    }
    const selectionGeneration = ++agentSessionSelectionGeneration;
    const previousSelection = captureAgentSessionSelection(get());
    const operationScope = currentWorkspaceScope();
    activeAgentSessionLoadingScopeKey = selectionScopeKey;
    set({ loading: true, selectionReady: false, errorMessage: null });
    try {
      return await enqueueAgentSessionSelection(async () => {
        if (
          selectionGeneration !== agentSessionSelectionGeneration
          || selectionScopeKey !== currentWorkspaceScopeKey()
        ) return null;

        const reconcileUnknownResult = async (
          errorMessage: string
        ): Promise<AgentSession | null> => {
          const canonical = await readCanonicalHostSelection(operationScope);
          if (
            selectionGeneration !== agentSessionSelectionGeneration
            || selectionScopeKey !== currentWorkspaceScopeKey()
          ) return null;
          if (canonical.kind === 'unavailable') {
            if (previousSelection.session) {
              markCanonicalTimelineStale(previousSelection.session.id);
            }
            set({
              ...restoredAgentSessionSelection(previousSelection, errorMessage),
              selectionReady: false,
              loading: false,
            });
            return null;
          }
          applyCanonicalHostSelection(canonical, selectionScopeKey, errorMessage);
          if (canonical.kind === 'ready') {
            if (canonical.session.id === previousSelection.session?.id) {
              set({ errorMessage });
            }
            settledAgentSessionSelectionGeneration = selectionGeneration;
            return canonical.session;
          }
          return null;
        };

        let result;
        try {
          result = await createAgentSession(operationScope);
        } catch (error) {
          return reconcileUnknownResult(
            error instanceof Error ? error.message : String(error)
          );
        }
        if (
          selectionGeneration !== agentSessionSelectionGeneration
          || selectionScopeKey !== currentWorkspaceScopeKey()
        ) return null;
        if (result.ok && result.data) {
          set((state) => ({
            session: result.data!.session,
            localWorkspaceScopeKey:
              result.data!.session.conversationTarget.workspaceScopeKey,
            sessions: [
              result.data!.session,
              ...state.sessions.filter((item) => item.id !== result.data!.session.id),
            ],
            currentSessionId: result.data!.session.id,
            timeline: emptyTimeline(result.data!.session.id),
            profileId: result.data!.session.profileId,
            pendingPermission: null,
            resolvingPermission: null,
            resolvingPlan: null,
            messageAttachments: [],
            sessionAttachments: [],
            errorMessage: null,
            loading: false,
            selectionReady: true,
          }));
          canonicalTimelineStaleSessions.delete(result.data.session.id);
          canonicalTimelineFailClosedSessions.delete(result.data.session.id);
          settledAgentSessionSelectionGeneration = selectionGeneration;
          void get().refreshSessions();
          return result.data.session;
        }

        const message = result.message ?? 'Agent session create failed';
        if (hostCallerMutationDisposition(result) === 'rejected') {
          set(restoredAgentSessionSelection(previousSelection, message));
          settledAgentSessionSelectionGeneration = selectionGeneration;
          return null;
        }
        return reconcileUnknownResult(message);
      }, selectionScopeKey);
    } finally {
      finishAgentSessionSelection(selectionGeneration, selectionScopeKey);
    }
  },

  activateSession: async (sessionId) => {
    const selectionScopeKey = currentWorkspaceScopeKey();
    const currentSelection = get();
    if (
      currentSelection.session?.id === sessionId
      && currentSelection.selectionReady
      && currentSelection.localWorkspaceScopeKey
        === currentSelection.session.conversationTarget.workspaceScopeKey
      && (
        Boolean(currentSelection.session.projectId)
        || currentSelection.session.conversationTarget.workspaceScopeKey === selectionScopeKey
      )
      && currentSelection.timeline?.sessionId === sessionId
      && settledAgentSessionSelectionGeneration
        === agentSessionSelectionGeneration
    ) {
      return true;
    }
    const selectionGeneration = ++agentSessionSelectionGeneration;
    const previousSelection = captureAgentSessionSelection(get());
    const operationScope = currentWorkspaceScope();
    activeAgentSessionLoadingScopeKey = selectionScopeKey;
    set({ loading: true, selectionReady: false, errorMessage: null });
    const activate = async () => {
      if (
        selectionGeneration !== agentSessionSelectionGeneration
        || selectionScopeKey !== currentWorkspaceScopeKey()
      ) return;

      const reconcileUnknownResult = async (errorMessage: string) => {
        const canonical = await readCanonicalHostSelection(operationScope);
        if (
          selectionGeneration !== agentSessionSelectionGeneration
          || selectionScopeKey !== currentWorkspaceScopeKey()
        ) return;
        if (canonical.kind === 'unavailable') {
          if (previousSelection.session) {
            markCanonicalTimelineStale(previousSelection.session.id);
          }
          set({
            ...restoredAgentSessionSelection(previousSelection, errorMessage),
            selectionReady: false,
          });
          return;
        }
        applyCanonicalHostSelection(canonical, selectionScopeKey, errorMessage);
        if (canonical.kind === 'ready') {
          if (canonical.session.id !== sessionId) {
            set({ errorMessage });
          }
          settledAgentSessionSelectionGeneration = selectionGeneration;
        }
      };

      let activatedSession: AgentSession | null = null;
      try {
        const result = await boundedAgentSessionActivationRequest(sessionId);
        if (
          selectionGeneration !== agentSessionSelectionGeneration
          || selectionScopeKey !== currentWorkspaceScopeKey()
        ) return;
        if (result.ok && result.data) {
          activatedSession = result.data.session;
          const timelineGeneration =
            canonicalTimelineGenerations.get(sessionId) ?? 0;
          const timelineResult = await boundedAgentTimelineRequest(
            result.data.session.id
          );
          if (
            selectionGeneration !== agentSessionSelectionGeneration
            || selectionScopeKey !== currentWorkspaceScopeKey()
          ) return;
          if (!timelineResult.ok || !timelineResult.data) {
            throw new Error(
              timelineResult.message ?? 'Canonical Session timeline is unavailable.'
            );
          }
          const timeline = timelineAsReplay(
            requireExactNativeTimeline(timelineResult.data)
          );
          const identityReady = await validateProjectedRunIdentity(timeline);
          if (
            selectionGeneration !== agentSessionSelectionGeneration
            || selectionScopeKey !== currentWorkspaceScopeKey()
          ) return;
          const canonicalReady = identityReady
            && (canonicalTimelineGenerations.get(sessionId) ?? 0)
              === timelineGeneration;
          if (canonicalReady) {
            canonicalTimelineStaleSessions.delete(sessionId);
          } else {
            markCanonicalTimelineStale(sessionId);
          }
          const restoredAttachments = restoredSessionAttachmentState(
            timeline,
            result.data.session.id
          );
          set({
            session: result.data.session,
            localWorkspaceScopeKey:
              result.data.session.conversationTarget.workspaceScopeKey,
            currentSessionId: result.data.session.id,
            timeline,
            profileId: result.data.session.profileId,
            pendingPermission: pendingPermissionFromTimeline(timeline),
            resolvingPermission: null,
            resolvingPlan: null,
            messageAttachments: [],
            sessionAttachments: restoredAttachments.sessionAttachments,
            errorMessage: canonicalReady
              ? restoredAttachments.attachmentError
              : 'Canonical Session timeline is unavailable; refresh before sending guidance.',
            loading: false,
            selectionReady: canonicalReady,
          });
          if (!canonicalReady) {
            canonicalTimelineFailClosedSessions.add(sessionId);
          }
          settledAgentSessionSelectionGeneration = selectionGeneration;
          void get().refreshSessions();
          return;
        }
        const message = result.message ?? 'Agent session activate failed';
        if (hostCallerMutationDisposition(result) === 'rejected') {
          set(restoredAgentSessionSelection(previousSelection, message));
          settledAgentSessionSelectionGeneration = selectionGeneration;
          return;
        }
        await reconcileUnknownResult(message);
      } catch (err) {
        if (
          selectionGeneration !== agentSessionSelectionGeneration
          || selectionScopeKey !== currentWorkspaceScopeKey()
        ) return;
        const message = err instanceof Error ? err.message : String(err);
        if (activatedSession) {
          canonicalTimelineStaleSessions.add(activatedSession.id);
          canonicalTimelineFailClosedSessions.add(activatedSession.id);
          set({
            session: activatedSession,
            localWorkspaceScopeKey:
              activatedSession.conversationTarget.workspaceScopeKey,
            currentSessionId: activatedSession.id,
            timeline: null,
            profileId: activatedSession.profileId,
            pendingPermission: null,
            resolvingPermission: null,
            resolvingPlan: null,
            messageAttachments: [],
            sessionAttachments: [],
            errorMessage: message,
            loading: false,
            selectionReady: false,
          });
          return;
        }
        await reconcileUnknownResult(message);
      }
    };
    try {
      await enqueueAgentSessionSelection(activate, selectionScopeKey);
    } finally {
      finishAgentSessionSelection(selectionGeneration, selectionScopeKey);
    }
    const selected = get().session;
    return selected?.id === sessionId
      && selected.conversationTarget.sessionId === sessionId
      && get().localWorkspaceScopeKey === selected.conversationTarget.workspaceScopeKey
      && (
        Boolean(selected.projectId)
        || selected.conversationTarget.workspaceScopeKey === selectionScopeKey
      );
  },

  renameSession: async (sessionId, title) => {
    const result = await renameAgentSession(sessionId, { title });
    if (result.ok && result.data) {
      set((state) => ({
        session: state.session?.id === sessionId ? result.data!.session : state.session,
        sessions: state.sessions.map((item) => item.id === sessionId ? result.data!.session : item),
      }));
      return;
    }
    set({ errorMessage: result.message ?? 'Agent session rename failed' });
  },

  archiveSession: async (sessionId) => {
    const result = await archiveAgentSession(sessionId, { archived: true });
    if (result.ok && result.data) {
      const data = result.data;
      const wasActive = get().session?.id === sessionId;
      set((state) => ({
        sessions: data.sessions,
        currentSessionId: data.currentSessionId,
        ...(wasActive ? {
          session: null,
          timeline: null,
          pendingPermission: null,
          resolvingPermission: null,
          resolvingPlan: null,
          messageAttachments: [],
          sessionAttachments: [],
          errorMessage: null,
          loading: false,
        } : {}),
      }));
      if (wasActive) {
        const nextSessionId = data.currentSessionId;
        if (nextSessionId && nextSessionId !== sessionId) {
          await get().activateSession(nextSessionId);
          return;
        }
        await get().loadCurrentSelection();
      }
      return;
    }
    set({ errorMessage: result.message ?? 'Agent session archive failed' });
  },

  deleteSession: async (sessionId) => {
    const selectionScopeKey = currentWorkspaceScopeKey();
    const operationScope = currentWorkspaceScope();
    const selectionGeneration = ++agentSessionSelectionGeneration;
    const requestSelection = captureAgentSessionSelection(get());
    activeAgentSessionLoadingScopeKey = selectionScopeKey;
    set({
      loading: true,
      errorMessage: null,
      ...(requestSelection.session?.id === sessionId
        ? { selectionReady: false }
        : {}),
    });

    let deletion: {
      deleted: boolean;
      chooseNext: boolean;
      nextSessionId?: string;
    } = { deleted: false, chooseNext: false };
    try {
      deletion = await enqueueAgentSessionSelection(async () => {
        const activeAtCommit = get().session?.id === sessionId;
        const commitSelection = captureAgentSessionSelection(get());
        const rollbackSelection = activeAtCommit
          && requestSelection.session?.id === sessionId
          ? requestSelection
          : commitSelection;
        if (activeAtCommit) {
          set({ loading: true, selectionReady: false });
        }

        const reconcileUnknownResult = async (
          errorMessage: string
        ): Promise<{
          deleted: boolean;
          chooseNext: boolean;
          nextSessionId?: string;
        }> => {
          const canonical = await readCanonicalHostSelection(operationScope);
          if (
            selectionGeneration !== agentSessionSelectionGeneration
            || selectionScopeKey !== currentWorkspaceScopeKey()
          ) {
            return { deleted: false, chooseNext: false };
          }
          if (canonical.kind === 'unavailable') {
            if (rollbackSelection.session) {
              markCanonicalTimelineStale(rollbackSelection.session.id);
            }
            set({
              ...restoredAgentSessionSelection(rollbackSelection, errorMessage),
              selectionReady: false,
            });
            return { deleted: false, chooseNext: false };
          }
          applyCanonicalHostSelection(canonical, selectionScopeKey, errorMessage);
          if (canonical.kind === 'ready') {
            if (canonical.session.id === sessionId) {
              set({ errorMessage });
            }
            settledAgentSessionSelectionGeneration = selectionGeneration;
            return { deleted: canonical.session.id !== sessionId, chooseNext: false };
          }
          return {
            deleted: canonical.kind === 'empty',
            chooseNext: canonical.kind === 'empty',
          };
        };

        let result;
        try {
          result = await deleteAgentSession(sessionId);
        } catch (error) {
          return reconcileUnknownResult(
            error instanceof Error ? error.message : String(error)
          );
        }
        if (result.ok && result.data) {
          const data = result.data;
          const selectionStillCurrent =
            selectionGeneration === agentSessionSelectionGeneration
            && selectionScopeKey === currentWorkspaceScopeKey();
          let clearedCurrent = false;
          set((state) => {
            const currentStillDeleted = state.session?.id === sessionId;
            clearedCurrent = currentStillDeleted;
            return {
              ...(selectionStillCurrent ? {
                sessions: data.sessions,
                currentSessionId: data.currentSessionId,
              } : {}),
              ...(currentStillDeleted ? {
                session: null,
                timeline: null,
                profileId: undefined,
                localWorkspaceScopeKey: selectionScopeKey,
                pendingPermission: null,
                resolvingPermission: null,
                resolvingPlan: null,
                messageAttachments: [],
                sessionAttachments: [],
                errorMessage: null,
                loading: false,
                selectionReady: false,
              } : {}),
            };
          });
          return {
            deleted: true,
            chooseNext: clearedCurrent && selectionStillCurrent,
            nextSessionId: clearedCurrent && selectionStillCurrent
              ? data.currentSessionId
              : undefined,
          };
        }

        const message = result.message ?? 'Agent session delete failed';
        if (hostCallerMutationDisposition(result) === 'rejected') {
          if (
            selectionGeneration === agentSessionSelectionGeneration
            && selectionScopeKey === currentWorkspaceScopeKey()
          ) {
            set(restoredAgentSessionSelection(rollbackSelection, message));
            settledAgentSessionSelectionGeneration = selectionGeneration;
          }
          return { deleted: false, chooseNext: false };
        }
        return reconcileUnknownResult(message);
      }, selectionScopeKey);
    } finally {
      finishAgentSessionSelection(selectionGeneration, selectionScopeKey);
    }

    if (
      !deletion.chooseNext
      || selectionGeneration !== agentSessionSelectionGeneration
      || selectionScopeKey !== currentWorkspaceScopeKey()
    ) return deletion.deleted;
    if (deletion.nextSessionId && deletion.nextSessionId !== sessionId) {
      await get().activateSession(deletion.nextSessionId);
      return deletion.deleted;
    }
    get().enterDraft();
    return deletion.deleted;
  },

  selectProfile: async (profileId) => {
    const state = get();
    const session = state.session;
    if (!session) return false;
    const locked = state.loading
      || state.profileSelectionBusy
      || state.cancellingSessionIds.includes(session.id)
      || cancellableTimelineRunId(state.timeline) !== null
      || Boolean(state.timeline?.interactionProjection?.pending)
      || Boolean(
        state.resolvingPermission
        || state.resolvingPlan
      );
    if (locked) {
      set({ errorMessage: agentSessionMessage('agent.profile.locked') });
      return false;
    }
    set({ profileSelectionBusy: true, errorMessage: null });
    let result;
    try {
      result = await updateAgentSession(session.id, { profileId });
    } catch (error) {
      set({
        profileSelectionBusy: false,
        errorMessage: error instanceof Error
          ? error.message
          : agentSessionMessage('agent.profile.updateFailed'),
      });
      return false;
    }
    if (!result.ok || !result.data) {
      set({
        profileSelectionBusy: false,
        errorMessage: result.message ?? agentSessionMessage('agent.profile.updateFailed'),
      });
      return false;
    }
    set((current) => ({
      session: current.session?.id === session.id ? result.data!.session : current.session,
      sessions: [
        result.data!.session,
        ...current.sessions.filter((item) => item.id !== result.data!.session.id),
      ],
      currentSessionId: current.session?.id === session.id
        ? result.data!.session.id
        : current.currentSessionId,
      profileId: current.session?.id === session.id
        ? result.data!.session.profileId
        : current.profileId,
      profileSelectionBusy: false,
      errorMessage: null,
    }));
    return true;
  },
  refreshSessionProfile: async () => {
    const sessionId = get().session?.id;
    if (!sessionId) return;
    let result;
    try {
      result = await listAgentSessions(currentWorkspaceScope());
    } catch {
      return;
    }
    if (!result.ok || !result.data) return;
    const refreshedSession = result.data.sessions.find((item) => item.id === sessionId);
    if (!refreshedSession) return;
    set((state) => ({
      session: state.session?.id === sessionId ? refreshedSession : state.session,
      sessions: result.data!.sessions,
      profileId: state.session?.id === sessionId
        ? refreshedSession.profileId
        : state.profileId,
    }));
  },
  refreshActiveSessionContext: async () => {
    const sessionId = get().session?.id;
    if (!sessionId) return;
    const selectionGeneration = ++agentSessionSelectionGeneration;
    const selectionScopeKey = currentWorkspaceScopeKey();
    const selectionScope = currentWorkspaceScope();
    activeAgentSessionLoadingScopeKey = selectionScopeKey;
    set({ loading: true, selectionReady: false, errorMessage: null });
    try {
      await enqueueAgentSessionSelection(async () => {
        if (
          selectionGeneration !== agentSessionSelectionGeneration
          || selectionScopeKey !== currentWorkspaceScopeKey()
        ) return;
        try {
          const [sessionsResult, timelineResult] = await Promise.all([
            listAgentSessions(selectionScope),
            boundedAgentTimelineRequest(sessionId),
          ]);
          if (
            selectionGeneration !== agentSessionSelectionGeneration
            || selectionScopeKey !== currentWorkspaceScopeKey()
          ) return;
          if (!sessionsResult.ok || !sessionsResult.data) {
            throw new Error(
              sessionsResult.message ?? agentSessionMessage('memoryV2.refreshFailed')
            );
          }
          const refreshedSession = sessionsResult.data.sessions.find(
            (item) => item.id === sessionId
          );
          if (!refreshedSession || !timelineResult.ok || !timelineResult.data) {
            throw new Error(
              timelineResult.message ?? agentSessionMessage('memoryV2.refreshFailed')
            );
          }
          const timeline = timelineAsReplay(
            requireExactNativeTimeline(timelineResult.data)
          );
          if (!await validateProjectedRunIdentity(timeline)) {
            throw new Error(agentSessionMessage('memoryV2.refreshFailed'));
          }
          if (
            selectionGeneration !== agentSessionSelectionGeneration
            || selectionScopeKey !== currentWorkspaceScopeKey()
          ) return;
          canonicalTimelineStaleSessions.delete(sessionId);
          canonicalTimelineFailClosedSessions.delete(sessionId);
          set({
            session: refreshedSession,
            localWorkspaceScopeKey:
              refreshedSession.conversationTarget.workspaceScopeKey,
            sessions: sessionsResult.data.sessions,
            currentSessionId: refreshedSession.id,
            timeline,
            profileId: refreshedSession.profileId,
            pendingPermission: pendingPermissionFromTimeline(timeline),
            errorMessage: null,
            loading: false,
            selectionReady: true,
          });
          settledAgentSessionSelectionGeneration = selectionGeneration;
        } catch (error) {
          if (
            selectionGeneration !== agentSessionSelectionGeneration
            || selectionScopeKey !== currentWorkspaceScopeKey()
          ) return;
          canonicalTimelineFailClosedSessions.add(sessionId);
          set({
            errorMessage: error instanceof Error
              ? error.message
              : agentSessionMessage('memoryV2.refreshFailed'),
            loading: false,
            selectionReady: false,
          });
        }
      }, selectionScopeKey);
    } finally {
      finishAgentSessionSelection(selectionGeneration, selectionScopeKey);
    }
  },
  addAttachment: (attachment) => {
    const normalized = normalizeInputAttachment(attachment);
    if (!normalized) {
      set({
        errorMessage: agentSessionMessage('agent.attachment.invalidWorkspacePath'),
      });
      return;
    }
    const existingCount = get().messageAttachments.length + get().sessionAttachments.length;
    const alreadyPresent = [...get().messageAttachments, ...get().sessionAttachments]
      .some((candidate) => candidate.attachmentId === normalized.attachmentId);
    if (!alreadyPresent && existingCount >= MAX_AGENT_INPUT_ATTACHMENTS_V3) {
      set({
        errorMessage: agentSessionMessage('agent.attachment.tooMany'),
      });
      return;
    }
    if (normalized.scope === 'session') {
      set((state) => ({
        sessionAttachments: mergeAttachments(
          state.sessionAttachments,
          normalized
        ),
        messageAttachments: state.messageAttachments.filter(
          (candidate) => candidate.attachmentId !== normalized.attachmentId
        ),
        errorMessage: null,
      }));
      return;
    }
    set((state) => ({
      messageAttachments: mergeAttachments(
        state.messageAttachments,
        normalized
      ),
      sessionAttachments: state.sessionAttachments.filter(
        (candidate) => candidate.attachmentId !== normalized.attachmentId
      ),
      errorMessage: null,
    }));
  },
  removeAttachment: (attachmentId, scope) => {
    const attachment = [...get().messageAttachments, ...get().sessionAttachments]
      .find((candidate) => (
        candidate.attachmentId === attachmentId && candidate.scope === scope
      ));
    const remove = (attachments: AgentInputAttachmentV3[]) => attachments.filter((attachment) => (
      attachment.attachmentId !== attachmentId
      || attachment.scope !== scope
    ));
    if (scope === 'session') {
      set((state) => ({ sessionAttachments: remove(state.sessionAttachments) }));
    } else {
      set((state) => ({ messageAttachments: remove(state.messageAttachments) }));
    }
    if (attachment) {
      void revokeUserAttachmentGrant(attachment.attachmentId).then((result) => {
        if (!result.ok) {
          set({ errorMessage: result.message ?? agentSessionMessage('agent.attachment.loadFailed') });
        }
      });
    }
  },
  clearMessageAttachments: () => set({ messageAttachments: [] }),
  sendDraftMessage: async (conversationDraftTarget, content, profileId) => {
    const trimmed = content.trim();
    if (!trimmed || !profileId.trim()) return null;
    // A draft has no Session inheritance. Only resources explicitly selected
    // for this first input may cross the atomic admission boundary.
    const attachments = [...get().messageAttachments];
    const submittedMessageAttachments = [...get().messageAttachments];
    const callerRequestId = newHostCallerRequestId('conversation-draft');
    const selectionGeneration = ++agentSessionSelectionGeneration;
    const previousSelection = captureAgentSessionSelection(get());
    set({ loading: true, selectionReady: false, errorMessage: null });

    let admitted;
    try {
      admitted = await startConversationDraftRun({
        conversationDraftTarget,
        profileId,
        content: trimmed,
        ...(attachments.length > 0 ? { attachments } : {}),
        callerRequestId,
      });
    } catch (error) {
      if (selectionGeneration === agentSessionSelectionGeneration) {
        set(restoredAgentSessionSelection(
          previousSelection,
          error instanceof Error ? error.message : String(error)
        ));
        settledAgentSessionSelectionGeneration = selectionGeneration;
      }
      return null;
    }
    if (!admitted.ok || !admitted.data) {
      if (selectionGeneration === agentSessionSelectionGeneration) {
        set(restoredAgentSessionSelection(
          previousSelection,
          admitted.message ?? admitted.error ?? 'Conversation draft admission failed'
        ));
        settledAgentSessionSelectionGeneration = selectionGeneration;
      }
      return null;
    }

    const result = admitted.data;
    const session = result.session;
    if (!sessionMatchesDraftAdmission(session, conversationDraftTarget, profileId)) {
      if (selectionGeneration === agentSessionSelectionGeneration) {
        set(restoredAgentSessionSelection(
          previousSelection,
          agentSessionMessage('agent.session.draftAdmissionMismatch')
        ));
        settledAgentSessionSelectionGeneration = selectionGeneration;
      }
      void get().refreshSessions();
      return null;
    }
    let admittedTimeline = emptyTimeline(session.id);
    let timelineReady = false;
    try {
      const timelineResult = await boundedAgentTimelineRequest(session.id);
      if (timelineResult.ok && timelineResult.data) {
        admittedTimeline = timelineAsReplay(
          requireExactNativeTimeline(timelineResult.data)
        );
        timelineReady = true;
      }
    } catch {
      // The first input is already durably admitted. Canonical progress replay
      // owns observation recovery; the draft must not be submitted again.
    }
    if (selectionGeneration !== agentSessionSelectionGeneration) {
      set((state) => ({
        sessions: [
          session,
          ...state.sessions.filter((item) => item.id !== session.id),
        ],
      }));
      return session;
    }
    if (timelineReady) {
      await validateProjectedRunIdentity(admittedTimeline);
      canonicalTimelineStaleSessions.delete(session.id);
      canonicalTimelineFailClosedSessions.delete(session.id);
    } else {
      markCanonicalTimelineStale(session.id);
    }
    set((state) => ({
      session,
      localWorkspaceScopeKey: session.conversationTarget.workspaceScopeKey,
      sessions: [
        session,
        ...state.sessions.filter((item) => item.id !== session.id),
      ],
      currentSessionId: session.id,
      timeline: admittedTimeline,
      profileId: session.profileId,
      messageAttachments: retainUnsubmittedMessageAttachments(
        state.messageAttachments,
        submittedMessageAttachments
      ),
      sessionAttachments: [],
      pendingPermission: pendingPermissionFromTimeline(admittedTimeline),
      resolvingPermission: null,
      resolvingPlan: null,
      loading: false,
      selectionReady: timelineReady,
      errorMessage: timelineReady
        ? null
        : 'Canonical Session timeline is recovering after durable input admission.',
    }));
    settledAgentSessionSelectionGeneration = selectionGeneration;
    return session;
  },
  sendMessage: async (content, options) => {
    const trimmed = content.trim();
    if (!trimmed) return false;
    const expectedTarget = options?.expectedTarget ?? captureCurrentSubmissionTarget();
    if (!expectedTarget || !submissionTargetIsCurrent(expectedTarget)) {
      set({
        errorMessage: agentSessionMessage('agent.session.selectionChangedBeforeSend'),
      });
      return false;
    }
    const session = get().session;
    if (
      !session
      || session.id !== expectedTarget.sessionId
    ) {
      set({
        errorMessage: agentSessionMessage('agent.session.selectionChangedBeforeSend'),
      });
      return false;
    }
    if (!submissionTargetIsCurrent(expectedTarget)) {
      set({
        errorMessage: agentSessionMessage('agent.session.selectionChangedBeforeSend'),
      });
      return false;
    }
    const submittedMessageAttachments = [...get().messageAttachments];
    const attachments = outboundAttachments(get());
    if (!attachments) {
      set({
        errorMessage: agentSessionMessage('agent.attachment.invalidWorkspacePath'),
      });
      return false;
    }
    if (canonicalTimelineStaleSessions.has(session.id)) {
      const refreshed = await refreshCanonicalTimeline(
        session.id,
        true,
        true
      );
      if (!refreshed) {
        set((state) => state.session?.id === session.id
          ? {
              errorMessage:
                'Canonical Session timeline is unavailable; refresh before sending guidance.',
            }
          : state);
        return false;
      }
    }
    if (
      get().session?.id !== session.id
      || !submissionTargetIsCurrent(expectedTarget)
    ) {
      set({
        errorMessage: agentSessionMessage('agent.session.selectionChangedBeforeSend'),
      });
      return false;
    }
    const guidanceWorkspacePath = session.projectId
      ? undefined
      : currentWorkspacePath();
    const guidanceWorkspaceRequest = session.projectId
      ? {}
      : {
          workspacePath: guidanceWorkspacePath,
          noWorkspace: !guidanceWorkspacePath,
        };

    const activeInteraction = get().timeline?.interactionProjection?.pending ?? null;
    const applyAcceptedSession = (acceptedSession: AgentSession): void => {
      set((state) => {
        const sessions = [
          acceptedSession,
          ...state.sessions.filter((item) => item.id !== acceptedSession.id),
        ];
        if (state.session?.id !== session.id) return { sessions };
        return {
          session: acceptedSession,
          sessions,
          currentSessionId: acceptedSession.id,
          messageAttachments: retainUnsubmittedMessageAttachments(
            state.messageAttachments,
            submittedMessageAttachments
          ),
          errorMessage: null,
        };
      });
      markCanonicalTimelineStale(acceptedSession.id);
      void refreshCanonicalTimeline(acceptedSession.id, true, true);
    };
    const recordNonAcceptance = (
      response: Pick<ApiResponse<unknown>, 'ok' | 'data' | 'message' | 'error'>,
      fallbackMessage: string
    ): void => {
      const disposition = hostCallerMutationDisposition(response) ?? 'indeterminate';
      const message = response.message ?? response.error ?? fallbackMessage;
      markCanonicalTimelineStale(session.id);
      set((state) => state.session?.id === session.id
        ? {
            errorMessage: message,
            selectionReady: disposition === 'rejected'
              ? state.selectionReady
              : false,
          }
        : state);
      void refreshCanonicalTimeline(session.id, true, true);
    };
    const recordUnknownOutcome = (error: unknown): void => {
      markCanonicalTimelineStale(session.id);
      set((state) => state.session?.id === session.id
        ? {
            errorMessage: error instanceof Error ? error.message : String(error),
            selectionReady: false,
          }
        : state);
      void refreshCanonicalTimeline(session.id, true, true);
    };
    const interactionRunId = activeInteraction?.kind === 'permission'
      ? permissionRequestRunId(activeInteraction.request)
      : activeInteraction?.kind === 'plan'
        ? activeInteraction.runId
        : null;
    if (interactionRunId) {
      const mutationOwner = claimPendingHostMutation(session.id);
      if (!mutationOwner) {
        set({
          errorMessage: agentSessionMessage('agent.hostSubmission.busy'),
        });
        return false;
      }
      const callerRequestId = newHostCallerRequestId('input');
      const request: AgentRunGuidanceRequest = {
        guidance: trimmed,
        ...guidanceWorkspaceRequest,
        ...(attachments.length > 0 ? { attachments } : {}),
        conversationTarget: expectedTarget.conversationTarget,
        callerRequestId,
      };
      set({ errorMessage: null });
      const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
      try {
        const result = await submitAgentRunGuidance(
          session.id,
          interactionRunId,
          request
        );
        if (result.ok && result.data) {
          applyAcceptedSession(result.data.session);
          return true;
        }
        recordNonAcceptance(result, 'New user input append failed');
        return false;
      } catch (error) {
        recordUnknownOutcome(error);
        return false;
      } finally {
        releasePendingHostMutation(session.id, mutationOwner);
        void stopProgressWatcher();
      }
    }
    if (activeInteraction?.kind === 'permission') {
      set({ errorMessage: 'Permission request is missing its v2 Run identity.' });
      return false;
    }

    const projectedActiveRun = cancellableTimelineRunId(get().timeline) !== null;
    if (projectedActiveRun) {
      const mutationOwner = claimPendingHostMutation(session.id);
      if (!mutationOwner) {
        set({
          errorMessage: agentSessionMessage('agent.hostSubmission.busy'),
        });
        return false;
      }
      const callerRequestId = newHostCallerRequestId('input');
      const request: AgentRunGuidanceRequest = {
        guidance: trimmed,
        ...guidanceWorkspaceRequest,
        ...(attachments.length > 0 ? { attachments } : {}),
        conversationTarget: expectedTarget.conversationTarget,
        callerRequestId,
      };
      set({ errorMessage: null });
      const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
      try {
        const result = await submitCurrentAgentRunGuidance(
          session.id,
          request
        );
        if (result.ok && result.data) {
          applyAcceptedSession(result.data.session);
          return true;
        }
        recordNonAcceptance(result, 'User guidance append failed');
        return false;
      } catch (error) {
        recordUnknownOutcome(error);
        return false;
      } finally {
        releasePendingHostMutation(session.id, mutationOwner);
        void stopProgressWatcher();
      }
    }

    const mutationOwner = claimPendingHostMutation(session.id);
    if (!mutationOwner) {
      set({
        errorMessage: agentSessionMessage('agent.hostSubmission.busy'),
      });
      return false;
    }
    const workspacePath = session.projectId ? undefined : currentWorkspacePath();
    const callerRequestId = newHostCallerRequestId('ask');
    set({ errorMessage: null });
    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const result = await startAndWaitAgentRun(session.id, {
        op: 'ask',
        content: trimmed,
        ...(attachments.length > 0 ? { attachments } : {}),
        workspacePath,
        noWorkspace: session.projectId ? undefined : !workspacePath,
        conversationTarget: expectedTarget.conversationTarget,
        callerRequestId,
      });
      applyAcceptedSession(result.session);
      return true;
    } catch (error) {
      if (error instanceof HostMutationOutcomeError) {
        recordNonAcceptance({
          ok: false,
          data: {
            schemaVersion: 'deepcode.host.caller-mutation-error.v2',
            disposition: error.disposition,
          },
          message: error.message,
        }, error.message);
      } else {
        recordUnknownOutcome(error);
      }
      return false;
    } finally {
      releasePendingHostMutation(session.id, mutationOwner);
      void stopProgressWatcher();
    }
  },

  cancelCurrentRun: async () => {
    const session = get().session;
    if (!session) return;
    if (get().cancellingSessionIds.includes(session.id)) return;
    set((state) => ({
      cancellingSessionIds: addInFlightSessionId(state.cancellingSessionIds, session.id),
      errorMessage: null,
    }));

    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const callerRequestId = newHostCallerRequestId('cancel');
      const result = await cancelCurrentAgentRun(
        session.id,
        callerRequestId,
        session.conversationTarget
      );
      if (result.ok && result.data) {
        set((state) => {
          const sessions = [
            result.data!.session,
            ...state.sessions.filter(
              (item) => item.id !== result.data!.session.id
            ),
          ];
          if (state.session?.id !== session.id) return { sessions };
          return {
            session: result.data!.session,
            sessions,
            currentSessionId: result.data!.session.id,
            errorMessage: null,
          };
        });
        markCanonicalTimelineStale(result.data.session.id);
        void refreshCanonicalTimeline(result.data.session.id, true, true);
        return;
      }
      set((state) => ({
        errorMessage: state.session?.id === session.id
          ? result.message ?? 'Agent run cancellation failed'
          : state.errorMessage,
      }));
    } catch (error) {
      markCanonicalTimelineStale(session.id);
      set((state) => ({
        errorMessage: state.session?.id === session.id
          ? error instanceof Error ? error.message : String(error)
          : state.errorMessage,
        selectionReady: state.session?.id === session.id
          ? false
          : state.selectionReady,
      }));
      void refreshCanonicalTimeline(session.id, true, true);
    } finally {
      set((state) => ({
        cancellingSessionIds: removeInFlightSessionId(
          state.cancellingSessionIds,
          session.id
        ),
      }));
      void stopProgressWatcher();
    }
  },

  acceptPermission: async (requestOverride) => {
    const request = requestOverride ?? get().pendingPermission?.request;
    const session = get().session;
    if (!request || !session || get().resolvingPermission) return;
    const runId = permissionRequestRunId(request);
    if (!runId) {
      set({ errorMessage: 'Permission request is missing its v2 Run identity.' });
      return;
    }
    set({
      resolvingPermission: { id: request.id, decision: 'accept' },
      errorMessage: null,
    });
    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const result = await startAndWaitAgentRun(session.id, {
        op: 'resolveDecision',
        decisionKind: 'permission',
        decision: 'accept',
        runId,
        targetId: request.id,
        conversationTarget: session.conversationTarget,
        callerRequestId: newHostCallerRequestId('permission-allow'),
      });
      const data = { session: result.session };
      set((state) => {
        const nextState: Partial<Store> = {
          sessions: [
            data.session,
            ...state.sessions.filter(
              (item) => item.id !== data.session.id
            ),
          ],
          resolvingPermission: null,
        };
        if (state.session?.id === data.session.id) {
          nextState.session = data.session;
        }
        return nextState;
      });
      markCanonicalTimelineStale(data.session.id);
      void refreshCanonicalTimeline(data.session.id, true, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: state.session?.id === session.id
          ? message
          : state.errorMessage,
        resolvingPermission: null,
      }));
    } finally {
      void stopProgressWatcher();
    }
  },

  rejectPermission: async (requestOverride) => {
    const request = requestOverride ?? get().pendingPermission?.request;
    const session = get().session;
    if (!request || !session || get().resolvingPermission) return;
    const runId = permissionRequestRunId(request);
    if (!runId) {
      set({ errorMessage: 'Permission request is missing its v2 Run identity.' });
      return;
    }
    set({
      resolvingPermission: { id: request.id, decision: 'reject' },
      errorMessage: null,
    });
    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const result = await startAndWaitAgentRun(session.id, {
        op: 'resolveDecision',
        decisionKind: 'permission',
        decision: 'reject',
        runId,
        targetId: request.id,
        conversationTarget: session.conversationTarget,
        callerRequestId: newHostCallerRequestId('permission-deny'),
      });
      const data = { session: result.session };
      set((state) => {
        const nextState: Partial<Store> = {
          sessions: [
            data.session,
            ...state.sessions.filter(
              (item) => item.id !== data.session.id
            ),
          ],
          resolvingPermission: null,
        };
        if (state.session?.id === data.session.id) {
          nextState.session = data.session;
        }
        return nextState;
      });
      markCanonicalTimelineStale(data.session.id);
      void refreshCanonicalTimeline(data.session.id, true, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: state.session?.id === session.id
          ? message
          : state.errorMessage,
        resolvingPermission: null,
      }));
    } finally {
      void stopProgressWatcher();
    }
  },

  resolvePlan: async (runId, planId, decision, guidance) => {
    const session = get().session;
    if (!session || get().resolvingPlan) return;
    set({
      resolvingPlan: { runId, planId, decision },
      errorMessage: null,
    });
    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const result = await startAndWaitAgentRun(session.id, {
        op: 'resolveDecision',
        decisionKind: 'plan',
        decision,
        guidance,
        runId,
        targetId: planId,
        conversationTarget: session.conversationTarget,
        callerRequestId: newHostCallerRequestId('plan-decision'),
      });
      const data = { session: result.session };
      set((state) => {
        const nextState: Partial<Store> = {
          sessions: [
            data.session,
            ...state.sessions.filter(
              (item) => item.id !== data.session.id
            ),
          ],
          resolvingPermission: null,
          resolvingPlan: null,
        };
        if (state.session?.id === data.session.id) {
          nextState.session = data.session;
          nextState.currentSessionId = data.session.id;
        }
        return nextState;
      });
      markCanonicalTimelineStale(data.session.id);
      void refreshCanonicalTimeline(data.session.id, true, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: state.session?.id === session.id
          ? message
          : state.errorMessage,
        resolvingPlan: null,
      }));
    } finally {
      void stopProgressWatcher();
    }
  },

  resolveUserIntervention: async (input) => {
    const session = get().session;
    const timeline = get().timeline;
    const pending = timeline?.interactionProjection?.pending;
    if (!session || get().resolvingIntervention) return;
    if (
      pending?.kind !== 'userIntervention'
      || pending.runId !== input.runId
      || pending.targetId !== input.targetId
      || pending.interactionId !== input.interactionId
      || pending.interactionRevision !== input.interactionRevision
      || pending.candidateSetDigest !== input.candidateSetDigest
      || timeline?.revision !== input.expectedProjectionCursor
    ) {
      set({
        errorMessage: 'The user intervention changed before this decision was submitted.',
      });
      return;
    }
    if (
      input.decision === 'select'
      && !pending.intervention.options.some((option) => option.id === input.optionId)
    ) {
      set({ errorMessage: 'The selected intervention option is no longer available.' });
      return;
    }
    set({
      resolvingIntervention: {
        interactionId: input.interactionId,
        decision: input.decision,
      },
      errorMessage: null,
    });
    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const result = await startAndWaitAgentRun(session.id, {
        op: 'resolveDecision',
        decisionKind: 'userIntervention',
        decision: input.decision,
        optionId: input.optionId,
        guidance: input.guidance,
        runId: input.runId,
        targetId: input.targetId,
        interactionId: input.interactionId,
        interactionRevision: input.interactionRevision,
        candidateSetDigest: input.candidateSetDigest,
        expectedProjectionCursor: input.expectedProjectionCursor,
        conversationTarget: session.conversationTarget,
        callerRequestId: newHostCallerRequestId('intervention-decision'),
      });
      const data = { session: result.session };
      set((state) => {
        const nextState: Partial<Store> = {
          sessions: [
            data.session,
            ...state.sessions.filter((item) => item.id !== data.session.id),
          ],
          resolvingIntervention: null,
        };
        if (state.session?.id === data.session.id) {
          nextState.session = data.session;
          nextState.currentSessionId = data.session.id;
        }
        return nextState;
      });
      markCanonicalTimelineStale(data.session.id);
      await refreshCanonicalTimeline(data.session.id, true, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: state.session?.id === session.id
          ? message
          : state.errorMessage,
        resolvingIntervention: null,
      }));
    } finally {
      void stopProgressWatcher();
    }
  },

}));
