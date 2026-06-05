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
} from '@deepcode/session-core';
import {
  activateAgentSession,
  archiveAgentSession,
  cancelAgentRun,
  createAgentSession,
  getAgentWorkflowConfig,
  getAgentEventSnapshot,
  getCurrentAgentSession,
  listAgentSessions,
  patchAgentWorkflowConfig,
  renameAgentSession,
  resolveAgentPlan,
  resolveAgentPermission,
  sendAgentMessage,
} from '../services/runtimeAdapter';
import { useSettingsStore } from './settingsStore';
import { useWorkspaceStore } from './workspaceStore';

interface PendingPermission {
  request: PermissionRequest;
}

type PermissionResolution = {
  id: string;
  decision: 'accept' | 'reject';
};

interface QueuedAgentMessage {
  content: string;
  attachments: AgentContextAttachment[];
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
  errorMessage: string | null;
  messageAttachments: AgentContextAttachment[];
  sessionAttachments: AgentContextAttachment[];
  pendingPermission: PendingPermission | null;
  resolvingPermission: PermissionResolution | null;
  queuedMessages: QueuedAgentMessage[];
}

interface AgentSessionActions {
  loadOrCreate: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  createNewSession: () => Promise<void>;
  activateSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
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
  resolvePlan: (runId: string, planId: string, decision: 'accept' | 'reject' | 'revise', guidance?: string) => Promise<void>;
}

type Store = AgentSessionState & AgentSessionActions;

let activeAgentAbortController: AbortController | null = null;

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

function isEmptyAgentSession(session: AgentSession | null | undefined): boolean {
  return Boolean(session) && (session?.eventCount ?? 0) === 0;
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
  errorMessage: null,
  messageAttachments: [],
  sessionAttachments: [],
  pendingPermission: null,
  resolvingPermission: null,
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

  createNewSession: async () => {
    if (isEmptyAgentSession(get().session)) {
      set({ errorMessage: null });
      return;
    }
    const settings = useSettingsStore.getState().effectiveSettings;
    const initialMode = settingMode(settings['agent.defaultMode']);
    const result = await createAgentSession({ initialMode, ...currentWorkspaceScope() });
    if (result.ok && result.data) {
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
        errorMessage: null,
      });
      void get().refreshSessions();
      return;
    }
    set({ errorMessage: result.message ?? 'Agent session create failed' });
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
        ...(wasActive ? { session: null, events: [], traceEvents: [], pendingPermission: null, resolvingPermission: null } : {}),
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
    if (get().loading) {
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
      loading: true,
      errorMessage: null,
    }));

    let progressTimer: number | undefined;
    let pollingStopped = false;
    const refreshProgress = async () => {
      if (pollingStopped) return;
      const current = await getCurrentAgentSession(currentWorkspaceScope());
      if (current.ok && current.data?.session.id === session.id) {
        set({
          session: current.data.session,
          events: current.data.events,
          pendingPermission: findLatestPendingPermission(current.data.events),
        });
        await get().refreshTraceEvents(session.id);
      }
    };
    progressTimer = window.setInterval(() => {
      void refreshProgress();
    }, 300);
    void refreshProgress();

    const abortController = new AbortController();
    activeAgentAbortController = abortController;
    let wasAborted = false;

    try {
      const result = await sendAgentMessage(session.id, {
        content: trimmed,
        attachments,
        workspaceBinding: currentWorkspaceBinding(),
        mode: get().mode,
        workflow: get().workflow,
        workflowConfig: get().workflowConfig ?? undefined,
        profileId: get().profileId,
      }, abortController.signal);
      if (!result.ok || !result.data) {
        if (result.error === 'request_aborted') {
          throw new Error('request_aborted');
        }
        throw new Error(result.message ?? 'Agent message failed');
      }
      const data = result.data;
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      set({
        session: data.session,
        sessions: [data.session, ...get().sessions.filter((item) => item.id !== data.session.id)],
        currentSessionId: data.session.id,
        events: data.events,
        pendingPermission: findLatestPendingPermission(data.events),
        resolvingPermission: null,
        loading: false,
      });
      void get().refreshTraceEvents(data.session.id);
    } catch (err) {
      pollingStopped = true;
      if (progressTimer !== undefined) window.clearInterval(progressTimer);
      const message = err instanceof Error ? err.message : String(err);
      wasAborted = abortController.signal.aborted || message === 'request_aborted';
      if (wasAborted) {
        set({
          loading: false,
          errorMessage: null,
          queuedMessages: [],
        });
      } else {
        set((state) => ({
          events: [
            ...state.events,
            createLocalEvent(session.id, 'error', { message }),
          ],
          errorMessage: message,
          loading: false,
        }));
      }
    } finally {
      if (activeAgentAbortController === abortController) {
        activeAgentAbortController = null;
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
    activeAgentAbortController?.abort();
    set({
      loading: false,
      queuedMessages: [],
      pendingPermission: null,
      resolvingPermission: null,
      errorMessage: null,
    });

    const result = await cancelAgentRun(session.id);
    if (result.ok && result.data) {
      set({
        session: result.data.session,
        sessions: [result.data.session, ...get().sessions.filter((item) => item.id !== result.data!.session.id)],
        currentSessionId: result.data.session.id,
        events: result.data.events,
        pendingPermission: findLatestPendingPermission(result.data.events),
        resolvingPermission: null,
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
    set({
      loading: true,
      resolvingPermission: { id: pending.request.id, decision: 'accept' },
      errorMessage: null,
    });
    const result = await resolveAgentPermission(pending.request.id, { decision: 'accept' });
    if (result.ok && result.data) {
      set({
        session: result.data.session,
        events: result.data.events,
        pendingPermission: findLatestPendingPermission(result.data.events),
        resolvingPermission: null,
        loading: false,
      });
      void get().refreshTraceEvents(result.data.session.id);
    } else {
      set({ errorMessage: result.message ?? 'Permission resolve failed', resolvingPermission: null, loading: false });
    }
  },

  rejectPermission: async () => {
    const pending = get().pendingPermission;
    const session = get().session;
    if (!pending || !session || get().resolvingPermission) return;
    set({
      loading: true,
      resolvingPermission: { id: pending.request.id, decision: 'reject' },
      errorMessage: null,
    });
    const result = await resolveAgentPermission(pending.request.id, { decision: 'reject' });
    if (result.ok && result.data) {
      set({
        session: result.data.session,
        events: result.data.events,
        pendingPermission: findLatestPendingPermission(result.data.events),
        resolvingPermission: null,
        loading: false,
      });
      void get().refreshTraceEvents(result.data.session.id);
    } else {
      set({ errorMessage: result.message ?? 'Permission resolve failed', resolvingPermission: null, loading: false });
    }
  },

  resolvePlan: async (runId, planId, decision, guidance) => {
    const session = get().session;
    if (!session || get().loading) return;
    set({ loading: true, errorMessage: null });
    const result = await resolveAgentPlan(runId, planId, { decision, guidance });
    if (result.ok && result.data) {
      set({
        session: result.data.session,
        events: result.data.events,
        pendingPermission: findLatestPendingPermission(result.data.events),
        resolvingPermission: null,
        loading: false,
      });
      void get().refreshTraceEvents(result.data.session.id);
    } else {
      set({ errorMessage: result.message ?? 'Plan resolve failed', loading: false });
    }
  },
}));
