import { create } from 'zustand';
import type {
  CommandReply,
  ConversationCatalog,
  ConversationCommand,
  LlmProviderProfile,
  MessageFeedback,
  PlanResponse,
  SessionProjection,
  UserMessageAttachment,
} from '@deepcode/protocol';
import { CONVERSATION_COMMAND_VERSION } from '@deepcode/protocol';
import { getLlmProfiles } from '../services/apiClient';
import {
  attachConversationDirectoryIndex,
  createConversationProject as createProjectRequest,
  createLocalAgentSession,
  detachConversationDirectoryIndex,
  deleteConversationProject as deleteProjectRequest,
  deleteConversationSession as deleteSessionRequest,
  getConversationCatalog,
  getConversationCatalogManagement,
  getConversationHistoryCatalog,
  getConversationHistoryProjection,
  getLocalAgentProjection,
  submitLocalAgentCommand,
  updateConversationProject as updateProjectRequest,
  updateConversationSession as updateSessionRequest,
} from '../services/localAgentApi';

const SESSION_STORAGE_KEY = 'deepcode.local-agent.active-session.v2';
const EMPTY_CATALOG: ConversationCatalog = { projects: [], sessions: [] };

interface LocalAgentState {
  sessionId: string | null;
  draftProjectId: string | null;
  selectedProfileId: string | null;
  profiles: LlmProviderProfile[];
  defaultProfileId: string | null;
  catalog: ConversationCatalog;
  projection: SessionProjection | null;
  loading: boolean;
  refreshing: boolean;
  submitting: boolean;
  catalogBusy: boolean;
  error: string | null;
  initialize(): Promise<void>;
  refreshCatalog(): Promise<void>;
  startNewSession(projectId?: string | null): void;
  activateSession(sessionId: string): Promise<void>;
  selectProfile(profileId: string): Promise<void>;
  refresh(): Promise<void>;
  sendMessage(
    text: string,
    attachments?: UserMessageAttachment[],
    directoryPaths?: string[],
  ): Promise<CommandReply>;
  setMessageFeedback(messageId: string, feedback: MessageFeedback | null): Promise<CommandReply>;
  attachSessionDirectory(canonicalRoot: string): Promise<void>;
  detachSessionDirectory(workspaceId: string): Promise<void>;
  respondInteraction(response: string): Promise<CommandReply>;
  respondApproval(decision: 'allow' | 'deny'): Promise<CommandReply>;
  respondPlan(response: PlanResponse): Promise<CommandReply>;
  ignorePlan(): Promise<CommandReply>;
  cancelRun(): Promise<CommandReply>;
  createProject(title: string, workspacePaths?: string[]): Promise<void>;
  updateProject(projectId: string, input: { title?: string; workspacePaths?: string[] }): Promise<void>;
  addProjectWorkspace(projectId: string, canonicalRoot: string): Promise<void>;
  removeProjectWorkspace(projectId: string, workspaceId: string): Promise<void>;
  getProjectWorkspacePaths(projectId: string): Promise<Array<{
    workspaceId: string;
    displayName: string;
    canonicalRoot: string;
  }>>;
  deleteProject(projectId: string): Promise<void>;
  updateSession(sessionId: string, input: { title?: string; projectId?: string | null }): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  clearError(): void;
}

type StoreSet = (
  state: Partial<LocalAgentState> | ((state: LocalAgentState) => Partial<LocalAgentState>),
) => void;

let initialization: Promise<void> | null = null;
let generation = 0;

export const useLocalAgentStore = create<LocalAgentState>((set, get) => ({
  sessionId: null,
  draftProjectId: null,
  selectedProfileId: null,
  profiles: [],
  defaultProfileId: null,
  catalog: EMPTY_CATALOG,
  projection: null,
  loading: false,
  refreshing: false,
  submitting: false,
  catalogBusy: false,
  error: null,

  initialize: async () => {
    if (initialization) return await initialization;
    const currentGeneration = ++generation;
    initialization = (async () => {
      set({ loading: true, error: null });
      try {
        const [catalogResult, profileResult] = await Promise.all([
          loadCombinedCatalog(),
          getLlmProfiles(),
        ]);
        if (currentGeneration !== generation) return;
        const profiles = profileResult.ok
          ? (profileResult.data?.profiles ?? []).filter((profile) => profile.enabled)
          : [];
        const defaultProfileId = enabledProfileId(
          profiles,
          profileResult.data?.defaultProfileId,
        );
        const remembered = readRememberedSession();
        const candidate = catalogResult.catalog.sessions.find((session) => session.id === remembered);
        let projection: SessionProjection | null = null;
        let projectionError: string | null = null;
        if (candidate) {
          try {
            projection = await loadProjection(candidate);
          } catch (error) {
            projectionError = errorMessage(error);
          }
        }
        if (currentGeneration !== generation) return;
        set({
          catalog: catalogResult.catalog,
          profiles,
          defaultProfileId,
          selectedProfileId: projection?.run?.profileId
            ?? candidate?.profileId
            ?? defaultProfileId,
          sessionId: projection?.sessionId ?? candidate?.id ?? null,
          projection,
          draftProjectId: null,
          loading: false,
          error: projectionError
            ?? catalogResult.historyError
            ?? (profileResult.ok ? null : (profileResult.message ?? 'llm_profiles_unavailable')),
        });
      } catch (error) {
        if (currentGeneration === generation) {
          set({ loading: false, error: errorMessage(error) });
        }
      }
    })();
    try {
      await initialization;
    } finally {
      initialization = null;
    }
  },

  refreshCatalog: async () => {
    try {
      const result = await loadCombinedCatalog();
      set({ catalog: result.catalog, error: result.historyError });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  startNewSession: (projectId = null) => {
    generation += 1;
    forgetSession();
    set({
      sessionId: null,
      projection: null,
      draftProjectId: projectId,
      selectedProfileId: get().defaultProfileId,
      loading: false,
      refreshing: false,
      submitting: false,
      error: null,
    });
  },

  activateSession: async (sessionId) => {
    const summary = get().catalog.sessions.find((session) => session.id === sessionId);
    if (!summary) {
      set({ error: 'conversation_session_not_found' });
      return;
    }
    const currentGeneration = ++generation;
    set({ loading: true, error: null, sessionId: null, projection: null, draftProjectId: null });
    try {
      const projection = await loadProjection(summary);
      if (currentGeneration !== generation) return;
      rememberSession(sessionId);
      set({
        sessionId,
        selectedProfileId: projection.run?.profileId
          ?? summary.profileId
          ?? get().defaultProfileId,
        projection,
        loading: false,
      });
    } catch (error) {
      if (currentGeneration === generation) set({ loading: false, error: errorMessage(error) });
    }
  },

  selectProfile: async (profileId) => {
    assertActiveProjection(get());
    if (!get().profiles.some((profile) => profile.id === profileId && profile.enabled)) return;
    const previous = get().selectedProfileId;
    set({ selectedProfileId: profileId, error: null });
    const { sessionId, projection } = get();
    const run = projection?.run;
    if (!sessionId || !run || isTerminalRun(run.status)) return;
    try {
      const reply = await submitLocalAgentCommand({
        schemaVersion: CONVERSATION_COMMAND_VERSION,
        type: 'run.profile.select',
        commandId: nextId('command'),
        sessionId,
        runId: run.runId,
        profileId,
      });
      assertAccepted(reply);
      await get().refresh();
    } catch (error) {
      set({ selectedProfileId: previous, error: errorMessage(error) });
      throw error;
    }
  },

  refresh: async () => {
    const { sessionId, refreshing, projection } = get();
    if (!sessionId || refreshing) return;
    if (projection?.display.entryKind === 'historyOnly') return;
    set({ refreshing: true });
    try {
      const projection = await getLocalAgentProjection(sessionId);
      if (get().sessionId !== sessionId) return;
      set((state) => ({
        projection: !state.projection || projection.revision >= state.projection.revision
          ? projection
          : state.projection,
        selectedProfileId: projection.run?.profileId ?? state.selectedProfileId,
        error: null,
      }));
    } catch (error) {
      if (get().sessionId === sessionId) set({ error: errorMessage(error) });
    } finally {
      if (get().sessionId === sessionId) set({ refreshing: false });
    }
  },

  sendMessage: async (text, attachments = [], directoryPaths = []) => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('message_empty');
    const { projection } = get();
    if (projection?.display.entryKind === 'historyOnly') {
      throw new Error('conversation_history_read_only');
    }
    if (projection?.pendingPlan) {
      throw new Error('plan_response_requires_explicit_command');
    }
    if (projection?.pendingApproval) {
      throw new Error('approval_response_requires_explicit_command');
    }
    if (projection?.pendingInteraction) {
      if (attachments.length) throw new Error('interaction_response_attachments_unsupported');
      return await get().respondInteraction(trimmed);
    }

    set({ submitting: true, error: null });
    try {
      let { sessionId } = get();
      if (!sessionId) {
        const { draftProjectId, selectedProfileId } = get();
        if (!selectedProfileId) throw new Error('llm_profile_unavailable');
        const created = await createLocalAgentSession({
          ...(draftProjectId ? { projectId: draftProjectId } : {}),
          profileId: selectedProfileId,
        });
        sessionId = created.sessionId;
        rememberSession(sessionId);
        set({ sessionId, projection: created, draftProjectId: null });
        await get().refreshCatalog();
      }
      for (const directoryPath of directoryPaths) {
        const nextProjection = await attachConversationDirectoryIndex(sessionId, directoryPath);
        if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
        set({ projection: nextProjection });
      }
      const messageProfileId = get().selectedProfileId;
      const reply = await submitLocalAgentCommand({
        schemaVersion: CONVERSATION_COMMAND_VERSION,
        type: 'message.submit',
        commandId: nextId('command'),
        sessionId,
        text,
        ...(attachments.length
          ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
          : {}),
        ...(messageProfileId ? { profileId: messageProfileId } : {}),
      });
      assertAccepted(reply);
      await Promise.all([get().refresh(), get().refreshCatalog()]);
      return reply;
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    } finally {
      set({ submitting: false });
    }
  },

  setMessageFeedback: async (messageId, feedback) => {
    const state = get();
    const sessionId = requiredActiveSession(state);
    const target = state.projection?.messages.find((message) => message.messageId === messageId);
    if (!target || target.role !== 'assistant') throw new Error('message_feedback_target_invalid');
    return await submitExisting(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      type: 'message.feedback.set',
      commandId: nextId('command'),
      sessionId,
      messageId,
      feedback,
    });
  },

  attachSessionDirectory: async (canonicalRoot) => {
    const sessionId = requiredActiveSession(get());
    set({ catalogBusy: true, error: null });
    try {
      const projection = await attachConversationDirectoryIndex(sessionId, canonicalRoot);
      if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
      set({ projection });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    } finally {
      set({ catalogBusy: false });
    }
  },

  detachSessionDirectory: async (workspaceId) => {
    const sessionId = requiredActiveSession(get());
    set({ catalogBusy: true, error: null });
    try {
      const projection = await detachConversationDirectoryIndex(sessionId, workspaceId);
      if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
      set({ projection });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    } finally {
      set({ catalogBusy: false });
    }
  },

  respondInteraction: async (response) => {
    const state = get();
    const sessionId = requiredActiveSession(state);
    const interaction = state.projection?.pendingInteraction;
    if (!interaction || !response.trim()) throw new Error('interaction_response_missing');
    return await submitExisting(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      type: 'interaction.respond',
      commandId: nextId('command'),
      sessionId,
      runId: interaction.runId,
      interactionId: interaction.interactionId,
      response: response.trim(),
    });
  },

  respondApproval: async (decision) => {
    const state = get();
    const sessionId = requiredActiveSession(state);
    const approval = state.projection?.pendingApproval;
    if (!approval) throw new Error('approval_response_missing');
    return await submitExisting(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      type: 'approval.respond',
      commandId: nextId('command'),
      sessionId,
      runId: approval.runId,
      callId: approval.callId,
      approvalId: approval.approvalId,
      decision,
    });
  },

  respondPlan: async (response) => await submitPlanResponse(set, get, response),

  ignorePlan: async () => await submitPlanResponse(set, get, { kind: 'ignore' }),

  cancelRun: async () => {
    const state = get();
    const sessionId = requiredActiveSession(state);
    const runId = state.projection?.run?.runId;
    if (!runId) throw new Error('conversation_run_missing');
    return await submitExisting(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      type: 'run.cancel',
      commandId: nextId('command'),
      sessionId,
      runId,
    });
  },

  createProject: async (title, workspacePaths = []) => {
    await mutateCatalog(set, async () => await createProjectRequest({ title, workspacePaths }));
  },

  updateProject: async (projectId, input) => {
    await mutateCatalog(set, async () => await updateProjectRequest(projectId, input));
  },

  addProjectWorkspace: async (projectId, canonicalRoot) => {
    const management = await getConversationCatalogManagement();
    const project = management.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('conversation_project_not_found');
    const roots = rootsForProject(management, project.workspaceBindings.map((binding) => binding.workspaceId));
    if (!roots.includes(canonicalRoot)) roots.push(canonicalRoot);
    await get().updateProject(projectId, { workspacePaths: roots });
  },

  removeProjectWorkspace: async (projectId, workspaceId) => {
    const management = await getConversationCatalogManagement();
    const project = management.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('conversation_project_not_found');
    const roots = rootsForProject(
      management,
      project.workspaceBindings
        .filter((binding) => binding.workspaceId !== workspaceId)
        .map((binding) => binding.workspaceId),
    );
    await get().updateProject(projectId, { workspacePaths: roots });
  },

  getProjectWorkspacePaths: async (projectId) => {
    const management = await getConversationCatalogManagement();
    const project = management.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('conversation_project_not_found');
    return project.workspaceBindings.map((binding) => {
      const record = management.workspaces.find((workspace) => (
        workspace.workspaceId === binding.workspaceId
      ));
      if (!record) throw new Error('conversation_workspace_record_missing');
      return {
        workspaceId: record.workspaceId,
        displayName: record.displayName,
        canonicalRoot: record.canonicalRoot,
      };
    });
  },

  deleteProject: async (projectId) => {
    await mutateCatalog(set, async () => await deleteProjectRequest(projectId));
    if (get().draftProjectId === projectId) get().startNewSession(null);
  },

  updateSession: async (sessionId, input) => {
    assertActiveSummary(get().catalog, sessionId);
    await mutateCatalog(set, async () => await updateSessionRequest(sessionId, input));
  },

  deleteSession: async (sessionId) => {
    const summary = assertActiveSummary(get().catalog, sessionId);
    const projectId = summary.projectId;
    await mutateCatalog(set, async () => await deleteSessionRequest(sessionId));
    if (get().sessionId === sessionId) get().startNewSession(projectId ?? null);
  },

  clearError: () => set({ error: null }),
}));

async function submitPlanResponse(
  set: StoreSet,
  get: () => LocalAgentState,
  response: PlanResponse,
): Promise<CommandReply> {
  const state = get();
  const sessionId = requiredActiveSession(state);
  const plan = state.projection?.pendingPlan;
  if (!plan) throw new Error('plan_response_missing');
  return await submitExisting(set, get, {
    schemaVersion: CONVERSATION_COMMAND_VERSION,
    type: 'plan.respond',
    commandId: nextId('command'),
    sessionId,
    runId: plan.runId,
    planId: plan.planId,
    response,
  });
}

async function submitExisting(
  set: StoreSet,
  get: () => LocalAgentState,
  command: ConversationCommand,
): Promise<CommandReply> {
  set({ submitting: true, error: null });
  try {
    const reply = await submitLocalAgentCommand(command);
    assertAccepted(reply);
    await get().refresh();
    return reply;
  } catch (error) {
    set({ error: errorMessage(error) });
    throw error;
  } finally {
    set({ submitting: false });
  }
}

async function mutateCatalog(
  set: StoreSet,
  operation: () => Promise<ConversationCatalog>,
): Promise<void> {
  set({ catalogBusy: true, error: null });
  try {
    const activeCatalog = await operation();
    set((state) => ({ catalog: mergeCatalogs(activeCatalog, historyCatalogFrom(state.catalog)) }));
  } catch (error) {
    set({ error: errorMessage(error) });
    throw error;
  } finally {
    set({ catalogBusy: false });
  }
}

function rootsForProject(
  management: Awaited<ReturnType<typeof getConversationCatalogManagement>>,
  workspaceIds: readonly string[],
): string[] {
  return workspaceIds.map((workspaceId) => {
    const record = management.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!record) throw new Error('conversation_workspace_record_missing');
    return record.canonicalRoot;
  });
}

function assertAccepted(reply: CommandReply): void {
  if (reply.status === 'rejected') {
    throw new Error(`${reply.error?.code ?? 'conversation_command_rejected'}:${reply.error?.message ?? ''}`);
  }
}

function requiredSession(state: LocalAgentState): string {
  if (!state.sessionId) throw new Error('conversation_session_missing');
  return state.sessionId;
}

function requiredActiveSession(state: LocalAgentState): string {
  const sessionId = requiredSession(state);
  assertActiveProjection(state);
  return sessionId;
}

function assertActiveProjection(state: LocalAgentState): void {
  if (state.projection?.display.entryKind === 'historyOnly') {
    throw new Error('conversation_history_read_only');
  }
}

function assertActiveSummary(catalog: ConversationCatalog, sessionId: string) {
  const summary = catalog.sessions.find((session) => session.id === sessionId);
  if (!summary) throw new Error('conversation_session_not_found');
  if (summary.entryKind !== 'activeV2') throw new Error('conversation_history_read_only');
  return summary;
}

async function loadProjection(
  summary: ConversationCatalog['sessions'][number],
): Promise<SessionProjection> {
  return summary.entryKind === 'historyOnly'
    ? await getConversationHistoryProjection(summary.id)
    : await getLocalAgentProjection(summary.id);
}

async function loadCombinedCatalog(): Promise<{
  catalog: ConversationCatalog;
  historyError: string | null;
}> {
  const historyPromise = getConversationHistoryCatalog().then(
    (catalog) => ({ catalog, error: null as string | null }),
    (error: unknown) => ({ catalog: EMPTY_CATALOG, error: errorMessage(error) }),
  );
  const [activeCatalog, historyResult] = await Promise.all([
    getConversationCatalog(),
    historyPromise,
  ]);
  return {
    catalog: mergeCatalogs(activeCatalog, historyResult.catalog),
    historyError: historyResult.error,
  };
}

function historyCatalogFrom(catalog: ConversationCatalog): ConversationCatalog {
  return {
    projects: [],
    sessions: catalog.sessions.filter((session) => session.entryKind === 'historyOnly'),
  };
}

function mergeCatalogs(
  activeCatalog: ConversationCatalog,
  historyCatalog: ConversationCatalog,
): ConversationCatalog {
  if (historyCatalog.projects.length > 0
    || activeCatalog.sessions.some((session) => session.entryKind !== 'activeV2')
    || historyCatalog.sessions.some((session) => session.entryKind !== 'historyOnly')) {
    throw new Error('conversation_catalog_partition_invalid');
  }
  const ids = new Set(activeCatalog.sessions.map((session) => session.id));
  if (historyCatalog.sessions.some((session) => ids.has(session.id))) {
    throw new Error('conversation_catalog_identity_collision');
  }
  return {
    projects: activeCatalog.projects,
    sessions: [...activeCatalog.sessions, ...historyCatalog.sessions].sort((left, right) => (
      compareTimestamp(right.updatedAt, left.updatedAt) || right.id.localeCompare(left.id)
    )),
  };
}

function compareTimestamp(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

function enabledProfileId(
  profiles: readonly LlmProviderProfile[],
  preferred: string | undefined,
): string | null {
  return profiles.find((profile) => profile.id === preferred)?.id ?? profiles[0]?.id ?? null;
}

function isTerminalRun(status: NonNullable<SessionProjection['run']>['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'indeterminate'].includes(status);
}

function nextId(kind: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${random}`;
}

function readRememberedSession(): string | null {
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberSession(sessionId: string): void {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // 最近打开项只是 UI 快捷索引；Catalog 与 Session journal 仍是事实源。
  }
}

function forgetSession(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 无可清理的 UI 快捷索引。
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
