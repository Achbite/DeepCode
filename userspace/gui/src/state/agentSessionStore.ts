import { create } from 'zustand';
import type {
  AgentContextAttachment,
  AgentEvent,
  AgentMode,
  AgentSession,
  AgentTraceEvent,
  AgentWorkspaceBinding,
  AgentWorkflowConfig,
  AgentWorkflowMode,
  ListAgentSessionsRequest,
  PermissionRequest,
} from '@deepcode/protocol';
import {
  createWorkspaceBinding,
  createWorkspaceScope,
  createWorkspaceScopeKey,
  findLatestPendingPermission,
  mergeContextAttachment,
  SessionStorageClient,
  SessionDriverLoop,
} from '@deepcode/session-core';
import {
  activateAgentSession,
  appendAgentEvents,
  archiveAgentSession,
  deleteAgentSession,
  cancelAgentRun,
  createAgentSession,
  getAgentSession,
  getAgentWorkflowConfig,
  getAgentEventSnapshot,
  getCurrentAgentSession,
  kernelCommand,
  listAgentSessions,
  llmChat,
  patchAgentWorkflowConfig,
  renameAgentSession,
  resolveAgentPermission,
} from '../services/runtimeAdapter';
import { getKernelHttpOrigin } from '../services/hostTarget';
import { useSettingsStore } from './settingsStore';
import { useWorkspaceStore } from './workspaceStore';

interface PendingPermission {
  request: PermissionRequest;
}

type PermissionResolution = {
  id: string;
  decision: 'accept' | 'reject';
};

type PlanResolution = {
  runId: string;
  planId: string;
  decision: 'accept' | 'reject' | 'revise';
};

type RequirementResolution = {
  runId: string;
  requirementId: string;
  decision: 'accept' | 'reject' | 'revise';
};

type ReviewResolution = {
  runId: string;
  decision: 'accept' | 'revise';
};

interface QueuedAgentMessage {
  content: string;
  attachments: AgentContextAttachment[];
}

interface CreateAgentSessionOptions {
  reuseEmpty?: boolean;
}

interface AgentSessionState {
  session: AgentSession | null;
  sessions: AgentSession[];
  currentSessionId?: string;
  workspaceScopeKey?: string;
  events: AgentEvent[];
  traceEvents: AgentTraceEvent[];
  mode: AgentMode;
  workflow: AgentWorkflowMode;
  workflowConfig: AgentWorkflowConfig | null;
  workflowConfigStorePath?: string;
  profileId?: string;
  loading: boolean;
  runningSessionIds: string[];
  errorMessage: string | null;
  messageAttachments: AgentContextAttachment[];
  sessionAttachments: AgentContextAttachment[];
  pendingPermission: PendingPermission | null;
  resolvingPermission: PermissionResolution | null;
  resolvingRequirement: RequirementResolution | null;
  resolvingPlan: PlanResolution | null;
  resolvingReview: ReviewResolution | null;
  queuedMessages: QueuedAgentMessage[];
}

interface AgentSessionActions {
  loadOrCreate: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  createNewSession: (options?: CreateAgentSessionOptions) => Promise<AgentSession | null>;
  activateSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  refreshTraceEvents: (sessionId?: string) => Promise<void>;
  loadWorkflowConfig: () => Promise<void>;
  patchWorkflowConfig: (config: AgentWorkflowConfig) => Promise<void>;
  setMode: (mode: AgentMode) => void;
  setWorkflow: (workflow: AgentWorkflowMode) => void;
  setProfileId: (profileId?: string) => void;
  addAttachment: (attachment: AgentContextAttachment) => void;
  removeAttachment: (path: string, scope: AgentContextAttachment['scope']) => void;
  clearMessageAttachments: () => void;
  sendMessage: (content: string, attachmentsOverride?: AgentContextAttachment[]) => Promise<void>;
  cancelCurrentRun: () => Promise<void>;
  acceptPermission: () => Promise<void>;
  rejectPermission: () => Promise<void>;
  resolveRequirement: (runId: string, requirementId: string, decision: 'accept' | 'reject' | 'revise', guidance?: string) => Promise<void>;
  resolvePlan: (runId: string, planId: string, decision: 'accept' | 'reject' | 'revise', guidance?: string) => Promise<void>;
  resolveReview: (runId: string, decision: 'accept' | 'revise', guidance?: string) => Promise<void>;
}

type Store = AgentSessionState & AgentSessionActions;

const activeAgentAbortControllers = new Map<string, AbortController>();
const workspaceTreeRefreshEventIds = new Set<string>();

function emptyWorkflowConfig(): AgentWorkflowConfig {
  return {} as AgentWorkflowConfig;
}

function settingMode(value: unknown): AgentMode {
  return value === 'readOnly' || value === 'askBeforeWrite' || value === 'plan'
    ? value
    : 'plan';
}

function settingWorkflow(value: unknown): AgentWorkflowMode {
  return value === 'actOnRequest' ? 'actOnRequest' : 'planFirst';
}

function settingRequirementConfirmationMode(value: unknown): 'auto' | 'always' | 'off' {
  return value === 'always' || value === 'off' ? value : 'auto';
}

function createLocalEvent(
  sessionId: string,
  kind: AgentEvent['kind'],
  payload: unknown
): AgentEvent {
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId,
    ts: new Date().toISOString(),
    kind,
    payload,
  };
}

function readMessageAttachments(state: Store, override?: AgentContextAttachment[]): AgentContextAttachment[] {
  return override ?? [
    ...state.sessionAttachments,
    ...state.messageAttachments,
  ];
}

function currentWorkspaceScope(): ListAgentSessionsRequest {
  const workspace = useWorkspaceStore.getState().current;
  return createWorkspaceScope(workspace);
}

function currentWorkspaceScopeKey(): string {
  return createWorkspaceScopeKey(useWorkspaceStore.getState().current);
}

function currentWorkspaceBinding(): AgentWorkspaceBinding | undefined {
  const workspaceState = useWorkspaceStore.getState();
  return createWorkspaceBinding({
    current: workspaceState.current,
    activeFolder: workspaceState.getActiveFolder(),
    activeFolderId: workspaceState.activeFolderId ?? undefined,
  });
}

function createSessionDriver(): SessionDriverLoop {
  const transcriptClient = new SessionStorageClient(getKernelHttpOrigin());
  return new SessionDriverLoop({
    kernelCommand,
    llmChat,
    appendTranscript: async (targetSessionId, entry) => {
      await transcriptClient.appendTranscript(targetSessionId, entry);
    },
    appendEvents: async (targetSessionId, events) => {
      const result = await appendAgentEvents(targetSessionId, { events });
      if (!result.ok || !result.data) {
        throw new Error(result.message ?? 'Agent event append failed');
      }
      return result.data;
    },
  });
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

function eventToolName(event: AgentEvent): string | undefined {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return undefined;
  }
  const payload = event.payload as Record<string, unknown>;
  const value = payload.toolName ?? payload.name;
  return typeof value === 'string' ? value : undefined;
}

function shouldRefreshWorkspaceTree(events: AgentEvent[]): boolean {
  let shouldRefresh = false;
  for (const event of events) {
    if (event.kind !== 'tool_result') continue;
    const toolName = eventToolName(event);
    if (toolName !== 'fs.write' && toolName !== 'fs.delete') continue;
    if (workspaceTreeRefreshEventIds.has(event.id)) continue;
    workspaceTreeRefreshEventIds.add(event.id);
    shouldRefresh = true;
  }
  return shouldRefresh;
}

function refreshWorkspaceTreeForToolFacts(events: AgentEvent[]) {
  if (shouldRefreshWorkspaceTree(events)) {
    useWorkspaceStore.getState().bumpTreeRevision();
  }
}

export const useAgentSessionStore = create<Store>((set, get) => ({
  session: null,
  sessions: [],
  currentSessionId: undefined,
  workspaceScopeKey: undefined,
  events: [],
  traceEvents: [],
  mode: 'plan',
  workflow: 'planFirst',
  workflowConfig: null,
  loading: false,
  runningSessionIds: [],
  errorMessage: null,
  messageAttachments: [],
  sessionAttachments: [],
  pendingPermission: null,
  resolvingPermission: null,
  resolvingRequirement: null,
  resolvingPlan: null,
  resolvingReview: null,
  queuedMessages: [],

  loadOrCreate: async () => {
    const nextScopeKey = currentWorkspaceScopeKey();
    if (get().session && get().workspaceScopeKey === nextScopeKey) return;
    if (get().loading) return;
    set({ loading: true, errorMessage: null });
    const settings = useSettingsStore.getState().effectiveSettings;
    const initialMode = settingMode(settings['agent.defaultMode']);
    const workflow = settingWorkflow(settings['agent.defaultWorkflow']);
    set({ mode: initialMode, workflow });
    await get().loadWorkflowConfig();
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
      refreshWorkspaceTreeForToolFacts(current.data.events);
      set({
        session: current.data.session,
        workspaceScopeKey: nextScopeKey,
        events: current.data.events,
        mode: current.data.session.mode,
        profileId: current.data.session.profileId,
        loading: false,
      });
      void get().refreshTraceEvents(current.data.session.id);
      return;
    }
    const created = await createAgentSession({ initialMode, ...scope });
    if (created.ok && created.data) {
      refreshWorkspaceTreeForToolFacts(created.data.events);
      set({
        session: created.data.session,
        workspaceScopeKey: nextScopeKey,
        sessions: [created.data.session, ...get().sessions.filter((item) => item.id !== created.data!.session.id)],
        currentSessionId: created.data.session.id,
        events: created.data.events,
        mode: created.data.session.mode,
        profileId: created.data.session.profileId,
        loading: false,
      });
      void get().refreshTraceEvents(created.data.session.id);
    } else {
      set({
        errorMessage: created.message ?? current.message ?? 'Agent session initialization failed',
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
    const currentSession = get().session;
    if (options.reuseEmpty !== false && isEmptyAgentSession(currentSession)) {
      set({ errorMessage: null });
      return currentSession ?? null;
    }
    const settings = useSettingsStore.getState().effectiveSettings;
    const initialMode = settingMode(settings['agent.defaultMode']);
    const result = await createAgentSession({ initialMode, ...currentWorkspaceScope() });
    if (result.ok && result.data) {
      refreshWorkspaceTreeForToolFacts(result.data.events);
      set({
        session: result.data.session,
        workspaceScopeKey: currentWorkspaceScopeKey(),
        sessions: [result.data.session, ...get().sessions.filter((item) => item.id !== result.data!.session.id)],
        currentSessionId: result.data.session.id,
        events: result.data.events,
        traceEvents: [],
        mode: result.data.session.mode,
        profileId: result.data.session.profileId,
        pendingPermission: null,
        resolvingPermission: null,
        resolvingRequirement: null,
        resolvingPlan: null,
        resolvingReview: null,
        errorMessage: null,
      });
      void get().refreshSessions();
      return result.data.session;
    }
    set({ errorMessage: result.message ?? 'Agent session create failed' });
    return null;
  },

  activateSession: async (sessionId) => {
    if (get().session?.id === sessionId) return;
    set({ loading: true, errorMessage: null });
    const result = await activateAgentSession(sessionId);
    if (result.ok && result.data) {
      set({
        session: result.data.session,
        workspaceScopeKey: currentWorkspaceScopeKey(),
        currentSessionId: result.data.session.id,
        events: result.data.events,
        traceEvents: [],
        mode: result.data.session.mode,
        profileId: result.data.session.profileId,
        pendingPermission: findLatestPendingPermission(result.data.events),
        resolvingPermission: null,
        resolvingRequirement: null,
        resolvingPlan: null,
        resolvingReview: null,
        loading: false,
      });
      void get().refreshTraceEvents(result.data.session.id);
      void get().refreshSessions();
      return;
    }
    set({ errorMessage: result.message ?? 'Agent session activate failed', loading: false });
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
      const wasActive = get().session?.id === sessionId;
      set({
        sessions: result.data.sessions,
        currentSessionId: result.data.currentSessionId,
        ...(wasActive ? { session: null, events: [], traceEvents: [], pendingPermission: null, resolvingPermission: null, resolvingRequirement: null, resolvingPlan: null, resolvingReview: null } : {}),
      });
      if (wasActive) {
        const nextSessionId = result.data.currentSessionId;
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
      const wasActive = get().session?.id === sessionId;
      set({
        sessions: result.data.sessions,
        currentSessionId: result.data.currentSessionId,
        ...(wasActive ? { session: null, events: [], traceEvents: [], pendingPermission: null, resolvingPermission: null, resolvingRequirement: null, resolvingPlan: null, resolvingReview: null } : {}),
      });
      if (wasActive) {
        const nextSessionId = result.data.currentSessionId;
        if (nextSessionId && nextSessionId !== sessionId) {
          await get().activateSession(nextSessionId);
        }
      }
      return;
    }
    set({ errorMessage: result.message ?? 'Agent session delete failed' });
  },

  refreshTraceEvents: async (sessionId) => {
    const id = sessionId ?? get().session?.id;
    if (!id) return;
    const result = await getAgentEventSnapshot(id);
    if (result.ok && result.data) {
      set({ traceEvents: result.data.trace.events });
    }
  },

  loadWorkflowConfig: async () => {
    const result = await getAgentWorkflowConfig();
    if (result.ok && result.data) {
      set({
        workflowConfig: result.data.config,
        workflowConfigStorePath: result.data.storePath,
      });
      return;
    }
    set({ workflowConfig: emptyWorkflowConfig() });
  },

  patchWorkflowConfig: async (config) => {
    set({ workflowConfig: config });
    const result = await patchAgentWorkflowConfig({ config });
    if (result.ok && result.data) {
      set({
        workflowConfig: result.data.config,
        workflowConfigStorePath: result.data.storePath,
      });
    } else {
      set({ errorMessage: result.message ?? 'Agent workflow config save failed' });
    }
  },

  setMode: (mode) => set({ mode }),
  setWorkflow: (workflow) => set({ workflow }),
  setProfileId: (profileId) => set({ profileId }),

  addAttachment: (attachment) => {
    if (attachment.scope === 'session') {
      set((state) => ({
        sessionAttachments: mergeContextAttachment(state.sessionAttachments, attachment),
      }));
    } else {
      set((state) => ({
        messageAttachments: mergeContextAttachment(state.messageAttachments, attachment),
      }));
    }
  },

  removeAttachment: (path, scope) => {
    const remove = (items: AgentContextAttachment[]) =>
      items.filter((item) => !(item.path === path && item.scope === scope));
    if (scope === 'session') {
      set((state) => ({ sessionAttachments: remove(state.sessionAttachments) }));
    } else {
      set((state) => ({ messageAttachments: remove(state.messageAttachments) }));
    }
  },

  clearMessageAttachments: () => set({ messageAttachments: [] }),

  sendMessage: async (content, attachmentsOverride) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    await get().loadOrCreate();
    const session = get().session;
    if (!session) return;

    const attachments = readMessageAttachments(get(), attachmentsOverride);
    if (get().runningSessionIds.includes(session.id)) {
      const queuedEvent = createLocalEvent(session.id, 'user_msg', {
        content: trimmed,
        attachments,
        pending: true,
        queued: true,
      });
      set((state) => ({
        events: [...state.events, queuedEvent],
        messageAttachments: [],
        queuedMessages: [...state.queuedMessages, { content: trimmed, attachments }],
        errorMessage: null,
      }));
      return;
    }

    const localUserEvent = createLocalEvent(session.id, 'user_msg', {
      content: trimmed,
      attachments,
      pending: true,
    });
    set((state) => ({
      events: [...state.events, localUserEvent],
      messageAttachments: [],
      runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
      errorMessage: null,
    }));

    let progressTimer: number | undefined;
    let pollingStopped = false;
    const refreshProgress = async () => {
      if (pollingStopped) return;
      const current = await getAgentSession(session.id);
      if (current.ok && current.data) {
        refreshWorkspaceTreeForToolFacts(current.data.events);
        if (get().session?.id === session.id) {
          set({
            session: current.data.session,
            events: current.data.events,
            pendingPermission: findLatestPendingPermission(current.data.events),
          });
        }
        await get().refreshTraceEvents(session.id);
      }
    };
    progressTimer = window.setInterval(() => {
      void refreshProgress();
    }, 300);
    void refreshProgress();

    const abortController = new AbortController();
    activeAgentAbortControllers.set(session.id, abortController);
    let wasAborted = false;

    try {
      const transcriptClient = new SessionStorageClient(getKernelHttpOrigin());
      const driver = new SessionDriverLoop({
        kernelCommand,
        llmChat,
        appendTranscript: async (targetSessionId, entry) => {
          await transcriptClient.appendTranscript(targetSessionId, entry);
        },
        appendEvents: async (targetSessionId, events) => {
          if (abortController.signal.aborted) {
            throw new Error('request_aborted');
          }
          const result = await appendAgentEvents(targetSessionId, { events });
          if (abortController.signal.aborted) {
            throw new Error('request_aborted');
          }
          if (!result.ok || !result.data) {
            throw new Error(result.message ?? 'Agent event append failed');
          }
          return result.data;
        },
      });
      const data = await driver.runUserTurn({
        sessionId: session.id,
        content: trimmed,
        attachments,
        existingEvents: get().events,
        workspaceBinding: currentWorkspaceBinding(),
        workflow: get().workflow,
        profileId: get().profileId,
        requirementConfirmationMode: settingRequirementConfirmationMode(
          useSettingsStore.getState().effectiveSettings['agent.requirementConfirmationMode']
        ),
      });
      refreshWorkspaceTreeForToolFacts(data.events);
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      const isActiveSession = get().session?.id === data.session.id;
      set((state) => {
        const nextState: Partial<Store> = {
          sessions: [data.session, ...state.sessions.filter((item) => item.id !== data.session.id)],
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, data.session.id),
          resolvingPermission: null,
          resolvingRequirement: null,
          resolvingPlan: null,
          resolvingReview: null,
        };
        if (isActiveSession) {
          nextState.session = data.session;
          nextState.currentSessionId = data.session.id;
          nextState.events = data.events;
          nextState.pendingPermission = findLatestPendingPermission(data.events);
        }
        return nextState;
      });
      void get().refreshTraceEvents(data.session.id);
    } catch (err) {
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      const message = err instanceof Error ? err.message : String(err);
      wasAborted = abortController.signal.aborted || message === 'request_aborted';
      if (wasAborted) {
        set((state) => ({
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
          errorMessage: null,
          queuedMessages: [],
        }));
      } else {
        set((state) => ({
          events: state.session?.id === session.id
            ? [
                ...state.events,
                createLocalEvent(session.id, 'error', { message }),
              ]
            : state.events,
          errorMessage: state.session?.id === session.id ? message : state.errorMessage,
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
        }));
      }
    } finally {
      if (activeAgentAbortControllers.get(session.id) === abortController) {
        activeAgentAbortControllers.delete(session.id);
      }
    }

    if (wasAborted) {
      return;
    }

    const nextQueuedMessage = get().queuedMessages[0];
    if (nextQueuedMessage) {
      set((state) => ({
        queuedMessages: state.queuedMessages.slice(1),
      }));
      void get().sendMessage(nextQueuedMessage.content, nextQueuedMessage.attachments);
    }
  },

  cancelCurrentRun: async () => {
    const session = get().session;
    if (!session) return;
    activeAgentAbortControllers.get(session.id)?.abort();
    set((state) => ({
      runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      queuedMessages: [],
      pendingPermission: null,
      resolvingPermission: null,
      resolvingRequirement: null,
      resolvingPlan: null,
      resolvingReview: null,
      errorMessage: null,
    }));

    const result = await cancelAgentRun(session.id);
    if (result.ok && result.data) {
      refreshWorkspaceTreeForToolFacts(result.data.events);
      set({
        session: result.data.session,
        sessions: [result.data.session, ...get().sessions.filter((item) => item.id !== result.data!.session.id)],
        currentSessionId: result.data.session.id,
        events: result.data.events,
        pendingPermission: findLatestPendingPermission(result.data.events),
        resolvingPermission: null,
        resolvingRequirement: null,
        resolvingPlan: null,
        resolvingReview: null,
        loading: false,
        errorMessage: null,
      });
      void get().refreshTraceEvents(result.data.session.id);
      return;
    }

    set((state) => ({
      events: [
        ...state.events,
        createLocalEvent(session.id, 'assistant_msg', {
          content: "\u5df2\u4e2d\u6b62\u5f53\u524d Agent \u8bf7\u6c42\u3002",
          channel: 'final',
          visibility: 'conversation',
          label: 'Agent',
          cancelled: true,
        }),
      ],
      loading: false,
      errorMessage: result.message ?? null,
    }));
  },

  acceptPermission: async () => {
    const pending = get().pendingPermission;
    const session = get().session;
    if (!pending || !session || get().resolvingPermission) return;
    set((state) => ({
      resolvingPermission: { id: pending.request.id, decision: 'accept' },
      runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
      errorMessage: null,
    }));
    let progressTimer: number | undefined;
    let pollingStopped = false;
    const refreshProgress = async () => {
      if (pollingStopped) return;
      const current = await getAgentSession(session.id);
      if (current.ok && current.data) {
        refreshWorkspaceTreeForToolFacts(current.data.events);
        if (get().session?.id === session.id) {
          set({
            session: current.data.session,
            events: current.data.events,
            pendingPermission: findLatestPendingPermission(current.data.events),
          });
        }
        await get().refreshTraceEvents(session.id);
      }
    };
    progressTimer = window.setInterval(() => {
      void refreshProgress();
    }, 300);
    void refreshProgress();
    try {
      const result = await resolveAgentPermission(pending.request.id, { decision: 'accept' });
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      if (result.ok && result.data) {
        refreshWorkspaceTreeForToolFacts(result.data.events);
        set((state) => ({
          session: result.data!.session,
          events: result.data!.events,
          pendingPermission: findLatestPendingPermission(result.data!.events),
          resolvingPermission: null,
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, result.data!.session.id),
        }));
        void get().refreshTraceEvents(result.data.session.id);
      } else {
        set((state) => ({
          errorMessage: result.message ?? 'Permission resolve failed',
          resolvingPermission: null,
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
        }));
      }
    } catch (err) {
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: message,
        resolvingPermission: null,
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      }));
    }
  },

  rejectPermission: async () => {
    const pending = get().pendingPermission;
    const session = get().session;
    if (!pending || !session || get().resolvingPermission) return;
    set((state) => ({
      resolvingPermission: { id: pending.request.id, decision: 'reject' },
      runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
      errorMessage: null,
    }));
    let progressTimer: number | undefined;
    let pollingStopped = false;
    const refreshProgress = async () => {
      if (pollingStopped) return;
      const current = await getAgentSession(session.id);
      if (current.ok && current.data) {
        refreshWorkspaceTreeForToolFacts(current.data.events);
        if (get().session?.id === session.id) {
          set({
            session: current.data.session,
            events: current.data.events,
            pendingPermission: findLatestPendingPermission(current.data.events),
          });
        }
        await get().refreshTraceEvents(session.id);
      }
    };
    progressTimer = window.setInterval(() => {
      void refreshProgress();
    }, 300);
    void refreshProgress();
    try {
      const result = await resolveAgentPermission(pending.request.id, { decision: 'reject' });
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      if (result.ok && result.data) {
        refreshWorkspaceTreeForToolFacts(result.data.events);
        set((state) => ({
          session: result.data!.session,
          events: result.data!.events,
          pendingPermission: findLatestPendingPermission(result.data!.events),
          resolvingPermission: null,
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, result.data!.session.id),
        }));
        void get().refreshTraceEvents(result.data.session.id);
      } else {
        set((state) => ({
          errorMessage: result.message ?? 'Permission resolve failed',
          resolvingPermission: null,
          runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
        }));
      }
    } catch (err) {
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: message,
        resolvingPermission: null,
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      }));
    }
  },

  resolveRequirement: async (runId, requirementId, decision, guidance) => {
    const session = get().session;
    if (!session || get().resolvingRequirement) return;

    set((state) => ({
      resolvingRequirement: { runId, requirementId, decision },
      runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
      errorMessage: null,
    }));

    let progressTimer: number | undefined;
    let pollingStopped = false;
    const refreshProgress = async () => {
      if (pollingStopped) return;
      const current = await getAgentSession(session.id);
      if (current.ok && current.data) {
        refreshWorkspaceTreeForToolFacts(current.data.events);
        if (get().session?.id === session.id) {
          set({
            session: current.data.session,
            events: current.data.events,
            pendingPermission: findLatestPendingPermission(current.data.events),
          });
        }
        await get().refreshTraceEvents(session.id);
      }
    };
    progressTimer = window.setInterval(() => {
      void refreshProgress();
    }, 300);
    void refreshProgress();

    try {
      const driver = createSessionDriver();
      const data = await driver.resolveDecision({
        sessionId: session.id,
        kind: 'requirement',
        decision,
        guidance,
        runId,
        targetId: requirementId,
        existingEvents: get().events,
        workspaceBinding: currentWorkspaceBinding(),
        workflow: get().workflow,
        profileId: get().profileId,
      });
      refreshWorkspaceTreeForToolFacts(data.events);
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      set((state) => ({
        session: data.session,
        sessions: [data.session, ...state.sessions.filter((item) => item.id !== data.session.id)],
        currentSessionId: data.session.id,
        events: data.events,
        pendingPermission: findLatestPendingPermission(data.events),
        resolvingRequirement: null,
        resolvingPermission: null,
        resolvingPlan: null,
        resolvingReview: null,
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, data.session.id),
      }));
      void get().refreshTraceEvents(data.session.id);
    } catch (err) {
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: message,
        resolvingRequirement: null,
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      }));
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
    let progressTimer: number | undefined;
    let pollingStopped = false;
    const refreshProgress = async () => {
      if (pollingStopped) return;
      const current = await getAgentSession(session.id);
      if (current.ok && current.data) {
        refreshWorkspaceTreeForToolFacts(current.data.events);
        if (get().session?.id === session.id) {
          set({
            session: current.data.session,
            events: current.data.events,
            pendingPermission: findLatestPendingPermission(current.data.events),
          });
        }
        await get().refreshTraceEvents(session.id);
      }
    };
    progressTimer = window.setInterval(() => {
      void refreshProgress();
    }, 300);
    void refreshProgress();
    try {
      const driver = createSessionDriver();
      const data = await driver.resolveDecision({
        sessionId: session.id,
        kind: 'plan',
        decision,
        guidance,
        runId,
        targetId: planId,
        existingEvents: get().events,
        workspaceBinding: currentWorkspaceBinding(),
        workflow: get().workflow,
        profileId: get().profileId,
      });
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      refreshWorkspaceTreeForToolFacts(data.events);
      set((state) => ({
        session: data.session,
        sessions: [data.session, ...state.sessions.filter((item) => item.id !== data.session.id)],
        currentSessionId: data.session.id,
        events: data.events,
        pendingPermission: findLatestPendingPermission(data.events),
        resolvingPermission: null,
        resolvingRequirement: null,
        resolvingPlan: null,
        resolvingReview: null,
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, data.session.id),
      }));
      void get().refreshTraceEvents(data.session.id);
    } catch (err) {
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: message,
        resolvingPlan: null,
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      }));
    }
  },

  resolveReview: async (runId, decision, guidance) => {
    const session = get().session;
    if (!session || get().resolvingReview) return;
    set((state) => ({
      resolvingReview: { runId, decision },
      runningSessionIds: addRunningSessionId(state.runningSessionIds, session.id),
      errorMessage: null,
    }));
    let progressTimer: number | undefined;
    let pollingStopped = false;
    const refreshProgress = async () => {
      if (pollingStopped) return;
      const current = await getAgentSession(session.id);
      if (current.ok && current.data) {
        refreshWorkspaceTreeForToolFacts(current.data.events);
        if (get().session?.id === session.id) {
          set({
            session: current.data.session,
            events: current.data.events,
            pendingPermission: findLatestPendingPermission(current.data.events),
          });
        }
        await get().refreshTraceEvents(session.id);
      }
    };
    progressTimer = window.setInterval(() => {
      void refreshProgress();
    }, 300);
    void refreshProgress();
    try {
      const driver = createSessionDriver();
      const data = await driver.resolveDecision({
        sessionId: session.id,
        kind: 'review',
        decision,
        guidance,
        runId,
        existingEvents: get().events,
        workspaceBinding: currentWorkspaceBinding(),
        workflow: get().workflow,
        profileId: get().profileId,
      });
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      refreshWorkspaceTreeForToolFacts(data.events);
      set((state) => ({
        session: data.session,
        sessions: [data.session, ...state.sessions.filter((item) => item.id !== data.session.id)],
        currentSessionId: data.session.id,
        events: data.events,
        pendingPermission: findLatestPendingPermission(data.events),
        resolvingPermission: null,
        resolvingRequirement: null,
        resolvingPlan: null,
        resolvingReview: null,
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, data.session.id),
      }));
      void get().refreshTraceEvents(data.session.id);
    } catch (err) {
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        errorMessage: message,
        resolvingReview: null,
        runningSessionIds: removeRunningSessionId(state.runningSessionIds, session.id),
      }));
    }
  },
}));
