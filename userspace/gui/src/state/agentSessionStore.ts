import { create } from 'zustand';
import type {
  AgentInputAttachmentV2,
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
  assertSharedConversationProjectionV2,
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
  cancelAgentRunById,
  createAgentSession,
  getAgentRun,
  getAgentTimeline,
  getCurrentAgentSession,
  listAgentSessions,
  renameAgentSession,
  startAgentRun,
  streamAgentTimeline,
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

interface CreateAgentSessionOptions {
  reuseEmpty?: boolean;
  projectId?: string;
  preserveAttachments?: boolean;
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
  runningSessionIds: string[];
  activeRunSessionIds: string[];
  cancellingSessionIds: string[];
  errorMessage: string | null;
  messageAttachments: AgentInputAttachmentV2[];
  sessionAttachments: AgentInputAttachmentV2[];
  pendingPermission: PendingPermission | null;
  resolvingPermission: PermissionResolution | null;
  resolvingPlan: PlanResolution | null;
}

interface AgentSessionActions {
  loadOrCreate: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  createNewSession: (options?: CreateAgentSessionOptions) => Promise<AgentSession | null>;
  activateSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  selectProfile: (profileId: string | null) => Promise<boolean>;
  refreshSessionProfile: () => Promise<void>;
  refreshActiveSessionContext: () => Promise<void>;
  addAttachment: (attachment: AgentInputAttachmentV2) => void;
  removeAttachment: (
    path: string,
    scope: AgentInputAttachmentV2['scope'],
    folderId?: string
  ) => void;
  clearMessageAttachments: () => void;
  synchronizeAttachmentRoot: (folderId?: string | null) => void;
  sendMessage: (content: string) => Promise<void>;
  cancelCurrentRun: () => Promise<void>;
  acceptPermission: (request?: AgentTimelinePermissionRequestView) => Promise<void>;
  rejectPermission: (request?: AgentTimelinePermissionRequestView) => Promise<void>;
  resolvePlan: (runId: string, planId: string, decision: 'accept' | 'reject' | 'revise', guidance?: string) => Promise<void>;
}

type Store = AgentSessionState & AgentSessionActions;

interface ActiveAgentRunIdentity {
  hostRunId: string;
  kernelRunId?: string;
  timelineRevision: number;
}

const activeAgentRunIds = new Map<string, ActiveAgentRunIdentity>();
const workspaceTreeRevisionBySession = new Map<string, number>();
const MAX_AGENT_INPUT_ATTACHMENTS_V2 = 32;
const CANONICAL_PROGRESS_STREAM_RETRY_MS = 250;
const CANONICAL_PROGRESS_REQUEST_TIMEOUT_MS = 5_000;
const CANONICAL_PROGRESS_TRAILING_ATTEMPTS = 3;

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
let agentSessionActivationGeneration = 0;
let settledAgentSessionActivationGeneration = 0;
let agentSessionActivationQueue: Promise<void> = Promise.resolve();

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

function hostObservedRunIdentity(
  sessionId: string,
  hostRunId: string,
  previous?: ActiveAgentRunIdentity,
  timelineRevisionFloor = 0
): ActiveAgentRunIdentity {
  if (previous?.hostRunId === hostRunId) return { ...previous };
  return {
    hostRunId,
    timelineRevision: Math.max(
      timelineRevisionFloor,
      currentTimelineRevision(sessionId)
    ),
  };
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

function normalizeWorkspaceRelativePath(path: string): string | null {
  if (
    path.trim() !== path
    || new TextEncoder().encode(path).byteLength > 4096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(path)
  ) {
    return null;
  }
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (
    !normalized.trim()
    || normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.includes('\0')
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

function decodeDurableWorkspaceRelativePath(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 4096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value.startsWith('/')
    || /^[A-Za-z]:/u.test(value)
    || value.includes('\\')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return null;
  }
  return value;
}

function normalizeInputAttachment(
  attachment: AgentInputAttachmentV2,
  requireSessionBinding = false
): AgentInputAttachmentV2 | null {
  const workspace = useWorkspaceStore.getState().current;
  const session = useAgentSessionStore.getState().session;
  const workspaceHash = createWorkspaceScope(workspace).workspaceHash;
  const sessionWorkspaceHash = session?.workspaceHash
    ?? session?.workspaceBinding?.workspaceHash;
  if (
    requireSessionBinding
    && (
      (session?.projectId && !sessionWorkspaceHash)
      || (sessionWorkspaceHash && sessionWorkspaceHash !== workspaceHash)
    )
  ) {
    return null;
  }
  const requestedFolderId = attachment.folderId?.trim();
  const activeFolder = useWorkspaceStore.getState().getActiveFolder();
  const activeFolderId = useWorkspaceStore.getState().activeFolderId
    ?? activeFolder?.id;
  if (
    !activeFolder
    || !activeFolderId
    || (requestedFolderId && requestedFolderId !== activeFolderId)
  ) {
    return null;
  }
  const folder = activeFolder;
  const path = normalizeWorkspaceRelativePath(attachment.path);
  if (
    !folder
    || !path
    || (attachment.kind !== 'file' && attachment.kind !== 'directory')
    || (attachment.scope !== 'message' && attachment.scope !== 'session')
  ) {
    return null;
  }
  const resourceId = attachment.resourceId;
  if (
    resourceId !== undefined
    && (
      !resourceId
      || resourceId.trim() !== resourceId
      || new TextEncoder().encode(resourceId).byteLength > 512
      || /[\u0000-\u001f\u007f-\u009f]/u.test(resourceId)
    )
  ) {
    return null;
  }
  return {
    kind: attachment.kind,
    path,
    scope: attachment.scope,
    folderId: folder.id,
    ...(resourceId ? { resourceId } : {}),
  };
}

function attachmentKey(attachment: AgentInputAttachmentV2): string {
  return [
    attachment.scope,
    attachment.folderId ?? '',
    attachment.kind,
    attachment.path,
    attachment.resourceId ?? '',
  ].join(':');
}

function mergeAttachments(
  existing: AgentInputAttachmentV2[],
  attachment: AgentInputAttachmentV2
): AgentInputAttachmentV2[] {
  const key = attachmentKey(attachment);
  return [
    ...existing.filter((candidate) => attachmentKey(candidate) !== key),
    attachment,
  ];
}

function outboundAttachments(state: Store): AgentInputAttachmentV2[] | undefined {
  const normalized = [...state.sessionAttachments, ...state.messageAttachments]
    .map((attachment) => normalizeInputAttachment(attachment, true));
  if (normalized.some((attachment) => attachment === null)) return undefined;
  const deduplicated = new Map<string, AgentInputAttachmentV2>();
  for (const attachment of normalized) {
    if (!attachment) continue;
    if (deduplicated.has(attachment.path)) return undefined;
    deduplicated.set(attachment.path, attachment);
  }
  return [...deduplicated.values()];
}

type DurableSessionAttachments =
  | { ok: true; attachments: AgentInputAttachmentV2[] }
  | { ok: false };

function durableSessionAttachments(
  timeline: AgentTimelineResult,
  activeFolderId?: string | null,
  expectedSessionId?: string
): DurableSessionAttachments {
  if (!activeFolderId) return { ok: true, attachments: [] };
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
      const decoded: AgentInputAttachmentV2[] = [];
      const paths = new Set<string>();
      for (const value of attachments) {
        const path = decodeDurableWorkspaceRelativePath(value.path);
        if (!path || paths.has(path)) return { ok: false };
        paths.add(path);
        const folderId = value.folderId;
        const resourceId = value.resourceId;
        if (
          (
            folderId !== undefined
            && (
              !folderId
              || folderId.trim() !== folderId
              || new TextEncoder().encode(folderId).byteLength > 512
              || /[\u0000-\u001f\u007f-\u009f]/u.test(folderId)
            )
          )
          || (
            resourceId !== undefined
            && (
              !resourceId
              || resourceId.trim() !== resourceId
              || new TextEncoder().encode(resourceId).byteLength > 512
              || /[\u0000-\u001f\u007f-\u009f]/u.test(resourceId)
            )
          )
        ) {
          return { ok: false };
        }
        decoded.push({
          kind: value.kind,
          path,
          scope: value.scope,
          folderId,
          ...(resourceId ? { resourceId } : {}),
        });
      }
      const sessionAttachments = decoded.filter(
        (attachment) => attachment.scope === 'session'
      );
      if (sessionAttachments.some((attachment) => attachment.folderId !== activeFolderId)) {
        return { ok: false };
      }
      return { ok: true, attachments: sessionAttachments };
    }
  }
  return { ok: true, attachments: [] };
}

function restoredSessionAttachmentState(
  timeline: AgentTimelineResult,
  expectedSessionId?: string
): {
  sessionAttachments: AgentInputAttachmentV2[];
  attachmentError: string | null;
} {
  const workspaceState = useWorkspaceStore.getState();
  const activeFolderId = workspaceState.activeFolderId
    ?? workspaceState.getActiveFolder()?.id;
  const restored = durableSessionAttachments(
    timeline,
    activeFolderId,
    expectedSessionId
  );
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

function isEmptyAgentSession(session: AgentSession | null | undefined): boolean {
  return Boolean(session) && (session?.eventCount ?? 0) === 0;
}

function addRunningSessionId(ids: string[], sessionId: string): string[] {
  return ids.includes(sessionId) ? ids : [...ids, sessionId];
}

function removeRunningSessionId(ids: string[], sessionId: string): string[] {
  return ids.filter((id) => id !== sessionId);
}

function publishActiveAgentRunIdentity(
  sessionId: string,
  identity: ActiveAgentRunIdentity | null
): void {
  if (identity) {
    activeAgentRunIds.set(sessionId, identity);
  } else {
    activeAgentRunIds.delete(sessionId);
  }
  useAgentSessionStore.setState((state) => ({
    activeRunSessionIds: identity
      ? addRunningSessionId(state.activeRunSessionIds, sessionId)
      : removeRunningSessionId(state.activeRunSessionIds, sessionId),
  }));
}

function replaceActiveAgentRunIdentityIfCurrent(
  sessionId: string,
  observed: ActiveAgentRunIdentity | undefined,
  identity: ActiveAgentRunIdentity | null
): boolean {
  if (activeAgentRunIds.get(sessionId) !== observed) return false;
  publishActiveAgentRunIdentity(sessionId, identity);
  return true;
}

function clearActiveAgentRunIdentityByHostRunId(
  sessionId: string,
  hostRunId: string
): boolean {
  const current = activeAgentRunIds.get(sessionId);
  if (!current || current.hostRunId !== hostRunId) return false;
  publishActiveAgentRunIdentity(sessionId, null);
  return true;
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
  assertSharedConversationProjectionV2(value);
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

function boundedAgentRunRequest(
  sessionId: string,
  runId: string
): ReturnType<typeof getAgentRun> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    CANONICAL_PROGRESS_REQUEST_TIMEOUT_MS
  );
  return getAgentRun(sessionId, runId, controller.signal).finally(() => {
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
    if (!await refreshActiveAgentRunIdentity(nextTimeline)) {
      canonicalTimelineStaleSessions.add(sessionId);
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
      publishActiveAgentRunIdentity(sessionId, null);
      stop();
      return;
    }
    void refreshActiveAgentRunIdentity(appliedTimeline).then((ready) => {
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

async function refreshActiveAgentRunIdentity(
  timeline: AgentTimelineResult
): Promise<boolean> {
  const runProjection = timeline.runProjection;
  const routeRunId = runProjection?.runId.trim();
  if (!runProjection || !routeRunId) {
    return !activeAgentRunIds.has(timeline.sessionId);
  }
  if (isCanonicalTimelineTerminal(timeline)) {
    publishActiveAgentRunIdentity(timeline.sessionId, null);
    return true;
  }
  const timelineRevision = timeline.revision ?? 0;
  let knownIdentity = activeAgentRunIds.get(timeline.sessionId);
  if (
    knownIdentity?.kernelRunId
    && knownIdentity.kernelRunId !== routeRunId
  ) {
    if (timelineRevision <= knownIdentity.timelineRevision) return false;
    replaceActiveAgentRunIdentityIfCurrent(
      timeline.sessionId,
      knownIdentity,
      null
    );
    knownIdentity = undefined;
  }
  const current = await boundedAgentRunRequest(
    timeline.sessionId,
    routeRunId
  );
  if (!current.ok || !current.data) return false;
  if (activeAgentRunIds.get(timeline.sessionId) !== knownIdentity) return true;
  if (
    knownIdentity
    && !knownIdentity.kernelRunId
    && current.data.run.runId !== knownIdentity.hostRunId
    && timelineRevision <= knownIdentity.timelineRevision
  ) {
    return false;
  }
  const latestTimeline = useAgentSessionStore.getState().timeline;
  const latestRunId = latestTimeline?.runProjection?.runId.trim();
  if (
    latestTimeline?.sessionId === timeline.sessionId
    && latestRunId
    && latestRunId !== routeRunId
  ) {
    return true;
  }
  if (
    isTerminalRunStatus(current.data.run.status)
  ) {
    replaceActiveAgentRunIdentityIfCurrent(
      timeline.sessionId,
      knownIdentity,
      null
    );
  } else {
    replaceActiveAgentRunIdentityIfCurrent(
      timeline.sessionId,
      knownIdentity,
      {
        hostRunId: current.data.run.runId,
        kernelRunId: routeRunId,
        timelineRevision,
      }
    );
  }
  return true;
}

function refreshWorkspaceTreeForTimeline(timeline: AgentTimelineResult): void {
  const revision = timeline.workspaceProjection?.revision ?? 0;
  const previous = workspaceTreeRevisionBySession.get(timeline.sessionId) ?? 0;
  if (revision <= previous) return;
  workspaceTreeRevisionBySession.set(timeline.sessionId, revision);
  useWorkspaceStore.getState().bumpTreeRevision();
}


function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isCanonicalTimelineTerminal(timeline: AgentTimelineResult): boolean {
  const status = timeline.runProjection?.status;
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function canonicalTimelineTerminalAfter(
  sessionId: string,
  revisionFloor: number
): boolean {
  const timeline = useAgentSessionStore.getState().timeline;
  return timeline?.sessionId === sessionId
    && timeline.revision > revisionFloor
    && isCanonicalTimelineTerminal(timeline);
}

function isQuiescentRunStatus(status: string): boolean {
  return isTerminalRunStatus(status) || status === 'waiting';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function newHostCallerRequestId(kind: string): string {
  return `host-ui-${kind}-${globalThis.crypto.randomUUID()}`;
}

async function startAndWaitAgentRun(
  sessionId: string,
  request: StartAgentRunRequest
): Promise<AgentRunResult> {
  const timelineRevisionFloor = currentTimelineRevision(sessionId);
  const started = await startAgentRun(sessionId, request);
  if (!started.ok || !started.data) {
    throw new Error(started.message ?? started.error ?? 'Shared session run start failed');
  }
  let result = started.data;
  const runId = result.run.runId;
  publishActiveAgentRunIdentity(
    sessionId,
    hostObservedRunIdentity(
      sessionId,
      runId,
      undefined,
      timelineRevisionFloor
    )
  );
  try {
    while (
      !isQuiescentRunStatus(result.run.status)
      && !canonicalTimelineTerminalAfter(sessionId, timelineRevisionFloor)
    ) {
      await sleep(300);
      if (canonicalTimelineTerminalAfter(sessionId, timelineRevisionFloor)) break;
      const current = await boundedAgentRunRequest(
        result.run.sessionId,
        result.run.runId
      );
      if (!current.ok || !current.data) {
        throw new Error(current.message ?? current.error ?? 'Shared session run refresh failed');
      }
      result = current.data;
    }
    await refreshCanonicalTimeline(sessionId, true, true);
    return result;
  } finally {
    if (
      activeAgentRunIds.get(sessionId)?.hostRunId === runId
      && (
        isTerminalRunStatus(result.run.status)
        || canonicalTimelineTerminalAfter(sessionId, timelineRevisionFloor)
      )
    ) {
      clearActiveAgentRunIdentityByHostRunId(sessionId, runId);
    }
  }
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

export const useAgentSessionStore = create<Store>((set, get) => ({
  session: null,
  sessions: [],
  currentSessionId: undefined,
  localWorkspaceScopeKey: undefined,
  timeline: null,
  profileId: undefined,
  profileSelectionBusy: false,
  loading: false,
  runningSessionIds: [],
  activeRunSessionIds: [],
  cancellingSessionIds: [],
  errorMessage: null,
  messageAttachments: [],
  sessionAttachments: [],
  pendingPermission: null,
  resolvingPermission: null,
  resolvingPlan: null,

  loadOrCreate: async () => {
    const nextScopeKey = currentWorkspaceScopeKey();
    if (get().session && get().localWorkspaceScopeKey === nextScopeKey) return;
    if (get().loading) {
      await waitForAgentSessionLoad();
      if (!get().session || get().localWorkspaceScopeKey !== currentWorkspaceScopeKey()) {
        await get().loadOrCreate();
      }
      return;
    }
    set({
      loading: true,
      errorMessage: null,
      messageAttachments: [],
      sessionAttachments: [],
    });
    try {
      const scope = currentWorkspaceScope();
      const list = await listAgentSessions(scope);
      if (list.ok && list.data) {
        set({
          sessions: list.data.sessions,
          currentSessionId: list.data.currentSessionId,
        });
      }
      const current = await getCurrentAgentSession(scope);
      if (current.ok && current.data) {
        const timelineResult = await getAgentTimeline(current.data.session.id);
        if (!timelineResult.ok || !timelineResult.data) {
          throw new Error(
            timelineResult.message ?? 'Canonical Session timeline is unavailable.'
          );
        }
        const timeline = timelineAsReplay(
          requireExactNativeTimeline(timelineResult.data)
        );
        await refreshActiveAgentRunIdentity(timeline);
        const restoredAttachments = restoredSessionAttachmentState(
          timeline,
          current.data.session.id
        );
        set({
          session: current.data.session,
          localWorkspaceScopeKey: nextScopeKey,
          timeline,
          profileId: current.data.session.profileId,
          messageAttachments: [],
          sessionAttachments: restoredAttachments.sessionAttachments,
          pendingPermission: pendingPermissionFromTimeline(timeline),
          errorMessage: restoredAttachments.attachmentError,
          loading: false,
        });
        return;
      }
      const created = await createAgentSession(scope);
      if (created.ok && created.data) {
        set({
          session: created.data.session,
          localWorkspaceScopeKey: nextScopeKey,
          sessions: [created.data.session, ...get().sessions.filter((item) => item.id !== created.data!.session.id)],
          currentSessionId: created.data.session.id,
          timeline: emptyTimeline(created.data.session.id),
          profileId: created.data.session.profileId,
          messageAttachments: [],
          sessionAttachments: [],
          loading: false,
        });
      } else {
        set({
          errorMessage: created.message ?? current.message ?? 'Agent session initialization failed',
          loading: false,
        });
      }
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  refreshSessions: async () => {
    const result = await listAgentSessions(currentWorkspaceScope());
    if (result.ok && result.data) {
      set({
        sessions: result.data.sessions,
        currentSessionId: result.data.currentSessionId,
      });
    }
  },

  createNewSession: async (options = {}) => {
    if (get().loading) await waitForAgentSessionLoad();
    const currentSession = get().session;
    if (
      options.reuseEmpty !== false &&
      isEmptyAgentSession(currentSession) &&
      get().localWorkspaceScopeKey === currentWorkspaceScopeKey()
    ) {
      if (options.projectId && currentSession?.projectId !== options.projectId) {
        const rebound = await updateAgentSession(currentSession!.id, {
          projectId: options.projectId,
        });
        if (!rebound.ok || !rebound.data) {
          set({ errorMessage: rebound.message ?? 'Agent session project binding failed' });
          return null;
        }
        set((state) => ({
          session: rebound.data!.session,
          sessions: [
            rebound.data!.session,
            ...state.sessions.filter((item) => item.id !== rebound.data!.session.id),
          ],
          currentSessionId: rebound.data!.session.id,
          messageAttachments: options.preserveAttachments ? state.messageAttachments : [],
          sessionAttachments: options.preserveAttachments ? state.sessionAttachments : [],
          errorMessage: null,
        }));
        return rebound.data.session;
      }
      set({ errorMessage: null });
      return currentSession ?? null;
    }
    const result = await createAgentSession({
      ...(options.projectId ? { projectId: options.projectId } : currentWorkspaceScope()),
    });
    if (result.ok && result.data) {
      set((state) => ({
        session: result.data!.session,
        localWorkspaceScopeKey: currentWorkspaceScopeKey(),
        sessions: [result.data!.session, ...state.sessions.filter((item) => item.id !== result.data!.session.id)],
        currentSessionId: result.data!.session.id,
        timeline: emptyTimeline(result.data!.session.id),
        profileId: result.data!.session.profileId,
        pendingPermission: null,
        resolvingPermission: null,
        resolvingPlan: null,
        messageAttachments: options.preserveAttachments ? state.messageAttachments : [],
        sessionAttachments: options.preserveAttachments ? state.sessionAttachments : [],
        errorMessage: null,
      }));
      void get().refreshSessions();
      return result.data.session;
    }
    set({ errorMessage: result.message ?? 'Agent session create failed' });
    return null;
  },

  activateSession: async (sessionId) => {
    if (
      get().session?.id === sessionId
      && settledAgentSessionActivationGeneration
        === agentSessionActivationGeneration
    ) {
      return;
    }
    const activationGeneration = ++agentSessionActivationGeneration;
    set({ loading: true, errorMessage: null });
    const activate = async () => {
      if (activationGeneration !== agentSessionActivationGeneration) return;
      try {
        const result = await boundedAgentSessionActivationRequest(sessionId);
        if (activationGeneration !== agentSessionActivationGeneration) return;
        if (result.ok && result.data) {
          const timelineGeneration =
            canonicalTimelineGenerations.get(sessionId) ?? 0;
          const timelineResult = await boundedAgentTimelineRequest(
            result.data.session.id
          );
          if (activationGeneration !== agentSessionActivationGeneration) return;
          if (!timelineResult.ok || !timelineResult.data) {
            throw new Error(
              timelineResult.message ?? 'Canonical Session timeline is unavailable.'
            );
          }
          const timeline = timelineAsReplay(
            requireExactNativeTimeline(timelineResult.data)
          );
          const identityReady = await refreshActiveAgentRunIdentity(timeline);
          if (activationGeneration !== agentSessionActivationGeneration) return;
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
            localWorkspaceScopeKey: currentWorkspaceScopeKey(),
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
          });
          settledAgentSessionActivationGeneration = activationGeneration;
          void get().refreshSessions();
          return;
        }
        set({
          errorMessage: result.message ?? 'Agent session activate failed',
          loading: false,
        });
      } catch (err) {
        if (activationGeneration !== agentSessionActivationGeneration) return;
        set({
          errorMessage: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      }
    };
    const queued = agentSessionActivationQueue.then(activate, activate);
    agentSessionActivationQueue = queued.catch(() => {});
    await queued;
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
      publishActiveAgentRunIdentity(sessionId, null);
      const data = result.data;
      const wasActive = get().session?.id === sessionId;
      set((state) => ({
        sessions: data.sessions,
        currentSessionId: data.currentSessionId,
        runningSessionIds: state.runningSessionIds.filter((id) => id !== sessionId),
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
        await get().loadOrCreate();
      }
      return;
    }
    set({ errorMessage: result.message ?? 'Agent session archive failed' });
  },

  deleteSession: async (sessionId) => {
    const result = await deleteAgentSession(sessionId);
    if (result.ok && result.data) {
      publishActiveAgentRunIdentity(sessionId, null);
      const data = result.data;
      const wasActive = get().session?.id === sessionId;
      set((state) => ({
        sessions: data.sessions,
        currentSessionId: data.currentSessionId,
        runningSessionIds: state.runningSessionIds.filter((id) => id !== sessionId),
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
        }
      }
      return;
    }
    set({ errorMessage: result.message ?? 'Agent session delete failed' });
  },

  selectProfile: async (profileId) => {
    const state = get();
    const session = state.session;
    if (!session) return false;
    const locked = state.loading
      || state.profileSelectionBusy
      || state.runningSessionIds.includes(session.id)
      || state.activeRunSessionIds.includes(session.id)
      || state.cancellingSessionIds.includes(session.id)
      || activeAgentRunIds.has(session.id)
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
    const [sessionsResult, timelineResult] = await Promise.all([
      listAgentSessions(currentWorkspaceScope()),
      getAgentTimeline(sessionId),
    ]);
    if (!sessionsResult.ok || !sessionsResult.data) {
      set({
        errorMessage: sessionsResult.message
          ?? agentSessionMessage('memoryV2.refreshFailed'),
      });
      return;
    }
    const refreshedSession = sessionsResult.data.sessions.find(
      (item) => item.id === sessionId
    );
    if (!refreshedSession || !timelineResult.ok || !timelineResult.data) {
      set({
        errorMessage: timelineResult.message
          ?? agentSessionMessage('memoryV2.refreshFailed'),
      });
      return;
    }
    if (get().session?.id !== sessionId) return;
    let timeline: AgentTimelineResult;
    try {
      timeline = timelineAsReplay(
        requireExactNativeTimeline(timelineResult.data)
      );
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    set((state) => ({
      session: refreshedSession,
      sessions: sessionsResult.data!.sessions,
      timeline,
      pendingPermission: pendingPermissionFromTimeline(timeline),
      errorMessage: null,
    }));
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
      .some((candidate) => candidate.path === normalized.path);
    if (!alreadyPresent && existingCount >= MAX_AGENT_INPUT_ATTACHMENTS_V2) {
      set({
        errorMessage: agentSessionMessage('agent.attachment.tooMany'),
      });
      return;
    }
    if (normalized.scope === 'session') {
      set((state) => ({
        sessionAttachments: mergeAttachments(
          state.sessionAttachments.filter((candidate) => candidate.path !== normalized.path),
          normalized
        ),
        messageAttachments: state.messageAttachments.filter(
          (candidate) => candidate.path !== normalized.path
        ),
        errorMessage: null,
      }));
      return;
    }
    set((state) => ({
      messageAttachments: mergeAttachments(
        state.messageAttachments.filter((candidate) => candidate.path !== normalized.path),
        normalized
      ),
      sessionAttachments: state.sessionAttachments.filter(
        (candidate) => candidate.path !== normalized.path
      ),
      errorMessage: null,
    }));
  },
  removeAttachment: (path, scope, folderId) => {
    const remove = (attachments: AgentInputAttachmentV2[]) => attachments.filter((attachment) => (
      attachment.path !== path
      || attachment.scope !== scope
      || (folderId !== undefined && attachment.folderId !== folderId)
    ));
    if (scope === 'session') {
      set((state) => ({ sessionAttachments: remove(state.sessionAttachments) }));
      return;
    }
    set((state) => ({ messageAttachments: remove(state.messageAttachments) }));
  },
  clearMessageAttachments: () => set({ messageAttachments: [] }),
  synchronizeAttachmentRoot: (folderId) => {
    const normalizedFolderId = folderId?.trim() || null;
    set((state) => {
      const mismatched = [...state.messageAttachments, ...state.sessionAttachments]
        .some((attachment) => attachment.folderId !== normalizedFolderId);
      return mismatched
        ? {
            messageAttachments: [],
            sessionAttachments: [],
            errorMessage: agentSessionMessage('agent.attachment.rootChanged'),
          }
        : state;
    });
  },
  sendMessage: async (content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (!get().session) await get().loadOrCreate();
    const session = get().session;
    if (!session) return;
    const attachments = outboundAttachments(get());
    if (!attachments) {
      set({
        errorMessage: agentSessionMessage('agent.attachment.invalidWorkspacePath'),
      });
      return;
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
        return;
      }
    }
    if (get().session?.id !== session.id) return;

    const activeInteraction = get().timeline?.interactionProjection?.pending ?? null;
    const interactionRunId = activeInteraction?.kind === 'permission'
      ? permissionRequestRunId(activeInteraction.request)
      : activeInteraction?.kind === 'plan'
        ? activeInteraction.runId
        : null;
    if (interactionRunId) {
      const observedIdentity = activeAgentRunIds.get(session.id);
      set((state) => ({
        runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
        errorMessage: null,
      }));
      const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
      try {
        const result = await submitAgentRunGuidance(session.id, interactionRunId, {
          guidance: trimmed,
          ...(attachments.length > 0 ? { attachments } : {}),
          callerRequestId: newHostCallerRequestId('input'),
        });
        if (result.ok && result.data) {
          if (isTerminalRunStatus(result.data.run.status)) {
            clearActiveAgentRunIdentityByHostRunId(
              session.id,
              result.data.run.runId
            );
          } else {
            replaceActiveAgentRunIdentityIfCurrent(
              session.id,
              observedIdentity,
              hostObservedRunIdentity(
                session.id,
                result.data.run.runId,
                observedIdentity
              )
            );
          }
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
              messageAttachments: [],
              errorMessage: null,
            };
          });
          markCanonicalTimelineStale(result.data.session.id);
          void refreshCanonicalTimeline(result.data.session.id, true, true);
        } else {
          set((state) => state.session?.id === session.id
            ? {
                errorMessage:
                  result.message ?? 'New user input append failed',
              }
            : state);
        }
      } catch (error) {
        set((state) => state.session?.id === session.id
          ? {
              errorMessage:
                error instanceof Error ? error.message : String(error),
            }
          : state);
      } finally {
        void stopProgressWatcher();
        set((state) => ({
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
        }));
      }
      return;
    }
    if (activeInteraction?.kind === 'permission') {
      set({ errorMessage: 'Permission request is missing its v2 Run identity.' });
      return;
    }

    const activeRun = activeAgentRunIds.get(session.id);
    if (activeRun) {
      set((state) => ({
        runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
        errorMessage: null,
      }));
      const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
      try {
        const result = await submitAgentRunGuidance(session.id, activeRun.hostRunId, {
          guidance: trimmed,
          ...(attachments.length > 0 ? { attachments } : {}),
          callerRequestId: newHostCallerRequestId('input'),
        });
        if (result.ok && result.data) {
          if (isTerminalRunStatus(result.data.run.status)) {
            clearActiveAgentRunIdentityByHostRunId(
              session.id,
              result.data.run.runId
            );
          } else {
            replaceActiveAgentRunIdentityIfCurrent(
              session.id,
              activeRun,
              hostObservedRunIdentity(
                session.id,
                result.data.run.runId,
                activeRun
              )
            );
          }
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
              messageAttachments: [],
              errorMessage: null,
            };
          });
          markCanonicalTimelineStale(result.data.session.id);
          void refreshCanonicalTimeline(result.data.session.id, true, true);
        } else {
          set((state) => state.session?.id === session.id
            ? {
                errorMessage:
                  result.message ?? 'User guidance append failed',
              }
            : state);
        }
      } catch (error) {
        set((state) => state.session?.id === session.id
          ? {
              errorMessage:
                error instanceof Error ? error.message : String(error),
            }
          : state);
      } finally {
        void stopProgressWatcher();
        set((state) => ({
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
        }));
      }
      return;
    }
    if (get().runningSessionIds.includes(session.id)) {
      set({ errorMessage: 'No active shared run id is available for guidance. Refresh the session or start a new turn.' });
      return;
    }

    set((state) => ({
      runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
      errorMessage: null,
    }));

    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);

    try {
      const workspacePath = session.projectId ? undefined : currentWorkspacePath();
      const result = await startAndWaitAgentRun(session.id, {
        op: 'ask',
        content: trimmed,
        ...(attachments.length > 0 ? { attachments } : {}),
        workspacePath,
        noWorkspace: session.projectId ? undefined : !workspacePath,
        callerRequestId: newHostCallerRequestId('ask'),
      });
      const data = { session: result.session };
      set((state) => {
        const nextState: Partial<Store> = {
          sessions: [data.session, ...state.sessions.filter((item) => item.id !== data.session.id)],
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, data.session.id),
          resolvingPermission: null,
          resolvingPlan: null,
        };
        if (state.session?.id === data.session.id) {
          nextState.session = data.session;
          nextState.currentSessionId = data.session.id;
          nextState.messageAttachments = [];
        }
        return nextState;
      });
      markCanonicalTimelineStale(data.session.id);
      void refreshCanonicalTimeline(data.session.id, true, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: state.session?.id === session.id ? message : state.errorMessage,
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      }));
    } finally {
      void stopProgressWatcher();
    }

  },

  cancelCurrentRun: async () => {
    const session = get().session;
    if (!session) return;
    if (get().cancellingSessionIds.includes(session.id)) return;
    const activeRunId =
      activeAgentRunIds.get(session.id)?.hostRunId
      ?? cancellableTimelineRunId(get().timeline);
    if (!activeRunId) {
      set({
        errorMessage:
          'The active Kernel–Session v2 Run identity is unavailable; refresh the canonical timeline before cancelling.',
      });
      return;
    }
    set((state) => ({
      runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      cancellingSessionIds: addRunningSessionId(state.cancellingSessionIds, session.id),
      pendingPermission: null,
      resolvingPermission: null,
      resolvingPlan: null,
      errorMessage: null,
    }));

    let result;
    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const callerRequestId = newHostCallerRequestId('cancel');
      result = await cancelAgentRunById(
        session.id,
        activeRunId,
        callerRequestId
      );
    } catch (error) {
      set((state) => ({
        cancellingSessionIds: removeRunningSessionId(state.cancellingSessionIds, session.id),
        errorMessage: state.session?.id === session.id
          ? error instanceof Error ? error.message : String(error)
          : state.errorMessage,
      }));
      return;
    } finally {
      void stopProgressWatcher();
    }
    if (result.ok && result.data) {
      clearActiveAgentRunIdentityByHostRunId(session.id, activeRunId);
      set((state) => {
        const sessions = [
          result.data!.session,
          ...state.sessions.filter(
            (item) => item.id !== result.data!.session.id
          ),
        ];
        const nextState: Partial<Store> = {
          sessions,
          resolvingPermission: null,
          resolvingPlan: null,
          cancellingSessionIds: removeRunningSessionId(
            state.cancellingSessionIds,
            session.id
          ),
        };
        if (state.session?.id === session.id) {
          nextState.session = result.data!.session;
          nextState.currentSessionId = result.data!.session.id;
          nextState.errorMessage = null;
        }
        return nextState;
      });
      markCanonicalTimelineStale(result.data.session.id);
      void refreshCanonicalTimeline(result.data.session.id, true, true);
      return;
    }

    set((state) => ({
      cancellingSessionIds: removeRunningSessionId(state.cancellingSessionIds, session.id),
      errorMessage: state.session?.id === session.id
        ? result.message ?? 'Agent run cancellation failed'
        : state.errorMessage,
    }));
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
    set((state) => ({
      resolvingPermission: { id: request.id, decision: 'accept' },
      runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
      errorMessage: null,
    }));
    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const result = await startAndWaitAgentRun(session.id, {
        op: 'resolveDecision',
        decisionKind: 'permission',
        decision: 'accept',
        runId,
        targetId: request.id,
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
          runningSessionIds: removeRunningSessionId(
            state.runningSessionIds,
            data.session.id
          ),
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
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
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
    set((state) => ({
      resolvingPermission: { id: request.id, decision: 'reject' },
      runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
      errorMessage: null,
    }));
    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const result = await startAndWaitAgentRun(session.id, {
        op: 'resolveDecision',
        decisionKind: 'permission',
        decision: 'reject',
        runId,
        targetId: request.id,
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
          runningSessionIds: removeRunningSessionId(
            state.runningSessionIds,
            data.session.id
          ),
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
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      }));
    } finally {
      void stopProgressWatcher();
    }
  },

  resolvePlan: async (runId, planId, decision, guidance) => {
    const session = get().session;
    if (!session || get().resolvingPlan) return;
    set((state) => ({
      resolvingPlan: { runId, planId, decision },
      runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
      errorMessage: null,
    }));
    const stopProgressWatcher = startCanonicalProgressWatcher(session.id);
    try {
      const result = await startAndWaitAgentRun(session.id, {
        op: 'resolveDecision',
        decisionKind: 'plan',
        decision,
        guidance,
        runId,
        targetId: planId,
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
          runningSessionIds: removeRunningSessionId(
            state.runningSessionIds,
            data.session.id
          ),
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
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      }));
    } finally {
      void stopProgressWatcher();
    }
  },

}));
