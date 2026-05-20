import { create } from 'zustand';
import type {
  AgentContextAttachment,
  AgentEvent,
  AgentMode,
  AgentSession,
  PermissionRequest,
  ToolCall,
} from '@deepcode/protocol';
import {
  appendAgentEvents,
  createAgentSession,
  getCurrentAgentSession,
} from '../services/runtimeAdapter';
import { resolvePendingTool, runAgentTurn } from '../services/agentRuntime';

interface PendingPermission {
  request: PermissionRequest;
  toolCall: ToolCall;
}

interface AgentSessionState {
  session: AgentSession | null;
  events: AgentEvent[];
  mode: AgentMode;
  profileId?: string;
  loading: boolean;
  errorMessage: string | null;
  messageAttachments: AgentContextAttachment[];
  sessionAttachments: AgentContextAttachment[];
  pendingPermission: PendingPermission | null;
}

interface AgentSessionActions {
  loadOrCreate: () => Promise<void>;
  setMode: (mode: AgentMode) => void;
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

function newEvent(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId,
    ts: new Date().toISOString(),
    kind,
    payload,
  };
}

export const useAgentSessionStore = create<Store>((set, get) => ({
  session: null,
  events: [],
  mode: 'plan',
  loading: false,
  errorMessage: null,
  messageAttachments: [],
  sessionAttachments: [],
  pendingPermission: null,

  loadOrCreate: async () => {
    if (get().session || get().loading) return;
    set({ loading: true, errorMessage: null });
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
    const created = await createAgentSession({ initialMode: 'plan' });
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

  setMode: (mode) => set({ mode }),
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
    const userEvent = newEvent(session.id, 'user_msg', {
      content: trimmed,
      attachments: get().messageAttachments,
    });
    void appendAgentEvents(session.id, { events: [userEvent] });
    set((state) => ({
      events: [...state.events, userEvent],
      messageAttachments: [],
      loading: true,
      errorMessage: null,
    }));
    try {
      const result = await runAgentTurn({
        sessionId: session.id,
        content: trimmed,
        attachments,
        mode: get().mode,
        profileId: get().profileId,
      });
      set((state) => ({
        events: [...state.events, ...result.events],
        pendingPermission: result.pending ?? null,
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
    const events = await resolvePendingTool({
      sessionId: session.id,
      toolCall: pending.toolCall,
      accepted: true,
    });
    set((state) => ({ events: [...state.events, ...events], loading: false }));
  },

  rejectPermission: async () => {
    const pending = get().pendingPermission;
    const session = get().session;
    if (!pending || !session) return;
    set({ loading: true, pendingPermission: null });
    const events = await resolvePendingTool({
      sessionId: session.id,
      toolCall: pending.toolCall,
      accepted: false,
    });
    set((state) => ({ events: [...state.events, ...events], loading: false }));
  },
}));
