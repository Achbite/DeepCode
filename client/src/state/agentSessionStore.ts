import { create } from 'zustand';
import type {
  AgentContextAttachment,
  AgentEvent,
  AgentMode,
  AgentSession,
  AgentWorkflowConfig,
  AgentWorkflowMode,
  PermissionRequest,
} from '@deepcode/protocol';
import { AGENT_WORKFLOW_STAGES } from '@deepcode/protocol';
import {
  createAgentSession,
  getAgentWorkflowConfig,
  getCurrentAgentSession,
  patchAgentWorkflowConfig,
  resolveAgentPermission,
  sendAgentMessage,
} from '../services/runtimeAdapter';
import { useSettingsStore } from './settingsStore';

interface PendingPermission {
  request: PermissionRequest;
}

interface AgentSessionState {
  session: AgentSession | null;
  events: AgentEvent[];
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
}

interface AgentSessionActions {
  loadOrCreate: () => Promise<void>;
  loadWorkflowConfig: () => Promise<void>;
  patchWorkflowConfig: (config: AgentWorkflowConfig) => Promise<void>;
  setMode: (mode: AgentMode) => void;
  setWorkflow: (workflow: AgentWorkflowMode) => void;
  setProfileId: (profileId?: string) => void;
  addAttachment: (attachment: AgentContextAttachment) => void;
  removeAttachment: (path: string, scope: AgentContextAttachment['scope']) => void;
  clearMessageAttachments: () => void;
  sendMessage: (content: string) => Promise<void>;
  acceptPermission: () => Promise<void>;
  rejectPermission: () => Promise<void>;
}

type Store = AgentSessionState & AgentSessionActions;

function mergeAttachments(
  list: AgentContextAttachment[],
  next: AgentContextAttachment
): AgentContextAttachment[] {
  const key = `${next.folderId ?? ''}:${next.path}`;
  const filtered = list.filter((item) => `${item.folderId ?? ''}:${item.path}` !== key);
  return [...filtered, next];
}

function findLatestPendingPermission(events: AgentEvent[]): PendingPermission | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'permission_result') return null;
    if (event.kind === 'permission_request') {
      return { request: event.payload as PermissionRequest };
    }
  }
  return null;
}

function emptyWorkflowConfig(): AgentWorkflowConfig {
  return Object.fromEntries(
    AGENT_WORKFLOW_STAGES.map((stage) => [stage, {}])
  ) as AgentWorkflowConfig;
}

function settingMode(value: unknown): AgentMode {
  return value === 'readOnly' || value === 'askBeforeWrite' || value === 'plan'
    ? value
    : 'plan';
}

function settingWorkflow(value: unknown): AgentWorkflowMode {
  return value === 'actOnRequest' ? 'actOnRequest' : 'planFirst';
}

export const useAgentSessionStore = create<Store>((set, get) => ({
  session: null,
  events: [],
  mode: 'plan',
  workflow: 'planFirst',
  workflowConfig: null,
  loading: false,
  errorMessage: null,
  messageAttachments: [],
  sessionAttachments: [],
  pendingPermission: null,

  loadOrCreate: async () => {
    if (get().session || get().loading) return;
    set({ loading: true, errorMessage: null });
    const settings = useSettingsStore.getState().effectiveSettings;
    const initialMode = settingMode(settings['agent.defaultMode']);
    const workflow = settingWorkflow(settings['agent.defaultWorkflow']);
    set({ mode: initialMode, workflow });
    await get().loadWorkflowConfig();
    const current = await getCurrentAgentSession();
    if (current.ok && current.data) {
      set({
        session: current.data.session,
        events: current.data.events,
        mode: current.data.session.mode,
        profileId: current.data.session.profileId,
        loading: false,
      });
      return;
    }
    const created = await createAgentSession({ initialMode });
    if (created.ok && created.data) {
      set({
        session: created.data.session,
        events: created.data.events,
        mode: created.data.session.mode,
        profileId: created.data.session.profileId,
        loading: false,
      });
    } else {
      set({
        errorMessage: created.message ?? current.message ?? 'Agent 会话初始化失败',
        loading: false,
      });
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
        sessionAttachments: mergeAttachments(state.sessionAttachments, attachment),
      }));
    } else {
      set((state) => ({
        messageAttachments: mergeAttachments(state.messageAttachments, attachment),
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

  sendMessage: async (content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    await get().loadOrCreate();
    const session = get().session;
    if (!session) return;
    const attachments = [
      ...get().sessionAttachments,
      ...get().messageAttachments,
    ];
    set((state) => ({
      events: state.events,
      messageAttachments: [],
      loading: true,
      errorMessage: null,
    }));
    try {
      const result = await sendAgentMessage(session.id, {
        content: trimmed,
        attachments,
        mode: get().mode,
        workflow: get().workflow,
        workflowConfig: get().workflowConfig ?? undefined,
        profileId: get().profileId,
      });
      if (!result.ok || !result.data) {
        throw new Error(result.message ?? 'Agent message failed');
      }
      const data = result.data;
      set(() => ({
        session: data.session,
        events: data.events,
        pendingPermission: findLatestPendingPermission(data.events),
        loading: false,
      }));
    } catch (err) {
      set({
        errorMessage: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  acceptPermission: async () => {
    const pending = get().pendingPermission;
    const session = get().session;
    if (!pending || !session) return;
    set({ loading: true, pendingPermission: null });
    const result = await resolveAgentPermission(pending.request.id, { decision: 'accept' });
    if (result.ok && result.data) {
      set({
        session: result.data.session,
        events: result.data.events,
        pendingPermission: findLatestPendingPermission(result.data.events),
        loading: false,
      });
    } else {
      set({ errorMessage: result.message ?? 'Permission resolve failed', loading: false });
    }
  },

  rejectPermission: async () => {
    const pending = get().pendingPermission;
    const session = get().session;
    if (!pending || !session) return;
    set({ loading: true, pendingPermission: null });
    const result = await resolveAgentPermission(pending.request.id, { decision: 'reject' });
    if (result.ok && result.data) {
      set({
        session: result.data.session,
        events: result.data.events,
        pendingPermission: findLatestPendingPermission(result.data.events),
        loading: false,
      });
    } else {
      set({ errorMessage: result.message ?? 'Permission resolve failed', loading: false });
    }
  },
}));
