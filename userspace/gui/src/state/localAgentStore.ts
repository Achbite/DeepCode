import { create } from 'zustand';
import type {
  CommandReply,
  ConversationCatalog,
  ConversationCommand,
  LlmProviderProfile,
  LlmReasoningEffort,
  SessionModelSettings,
  MessageFeedback,
  PluginCatalogProjection,
  PluginSelectionInput,
  PlanResponse,
  SessionProjection,
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
  getPluginCatalog,
  getLocalAgentProjection,
  resolveConversationFilesystemReferences,
  submitLocalAgentCommand,
  updateConversationProject as updateProjectRequest,
  updateConversationSession as updateSessionRequest,
} from '../services/localAgentApi';

const SESSION_STORAGE_KEY = 'deepcode.local-agent.active-session';
const EMPTY_CATALOG: ConversationCatalog = { projects: [], sessions: [] };
const EMPTY_PLUGIN_CATALOG: PluginCatalogProjection = { revision: 'plugin-catalog:empty', plugins: [] };

interface PendingFilesystemPath {
  path: string;
  kind: 'file' | 'directory';
}

type StoreErrorSource =
  | 'initialization'
  | 'projection'
  | 'catalog'
  | 'pluginCatalog'
  | 'profiles'
  | 'command'
  | 'operation';

interface LocalAgentState {
  sessionId: string | null;
  draftProjectId: string | null;
  selectedProfileId: string | null;
  reasoningEffortOverride: LlmReasoningEffort | null;
  modelSettingsBusy: boolean;
  profiles: LlmProviderProfile[];
  defaultProfileId: string | null;
  catalog: ConversationCatalog;
  pluginCatalog: PluginCatalogProjection;
  projection: SessionProjection | null;
  loading: boolean;
  submitting: boolean;
  catalogBusy: boolean;
  error: string | null;
  errorSource: StoreErrorSource | null;
  initialize(): Promise<void>;
  refreshProfiles(): Promise<void>;
  refreshCatalog(): Promise<void>;
  refreshPluginCatalog(): Promise<void>;
  startNewSession(projectId?: string | null): void;
  activateSession(sessionId: string): Promise<void>;
  selectProfile(profileId: string): Promise<void>;
  selectReasoningEffort(effort: LlmReasoningEffort | null): Promise<void>;
  refresh(): Promise<void>;
  sendMessage(
    text: string,
    filesystemPaths?: PendingFilesystemPath[],
    pluginSelections?: PluginSelectionInput[],
  ): Promise<CommandReply>;
  focusContext(
    task: string,
    filesystemPaths?: PendingFilesystemPath[],
    pluginSelections?: PluginSelectionInput[],
  ): Promise<CommandReply>;
  setMessageFeedback(messageId: string, feedback: MessageFeedback | null): Promise<CommandReply>;
  attachSessionDirectory(canonicalRoot: string): Promise<void>;
  detachSessionDirectory(workspaceId: string): Promise<void>;
  respondInteraction(response: string): Promise<CommandReply>;
  respondApproval(decision: 'allow' | 'deny'): Promise<CommandReply>;
  respondPlan(response: PlanResponse): Promise<CommandReply>;
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
type StoreGet = () => LocalAgentState;

let initialization: Promise<void> | null = null;
let generation = 0;
let activeSubmissionCount = 0;
const decisionSubmissions = new Map<string, Promise<CommandReply>>();
let projectionRefreshFlight: {
  sessionId: string;
  generation: number;
  promise: Promise<void>;
} | null = null;

export const useLocalAgentStore = create<LocalAgentState>((set, get) => ({
  sessionId: null,
  draftProjectId: null,
  selectedProfileId: null,
  reasoningEffortOverride: null,
  modelSettingsBusy: false,
  profiles: [],
  defaultProfileId: null,
  catalog: EMPTY_CATALOG,
  pluginCatalog: EMPTY_PLUGIN_CATALOG,
  projection: null,
  loading: false,
  submitting: false,
  catalogBusy: false,
  error: null,
  errorSource: null,

  initialize: async () => {
    if (initialization) return await initialization;
    const currentGeneration = ++generation;
    initialization = (async () => {
      set({ loading: true, error: null, errorSource: null });
      try {
        const [catalog, pluginCatalog, profileResult] = await Promise.all([
          getConversationCatalog(),
          getPluginCatalog(),
          getLlmProfiles(),
        ]);
        const profiles = profileResult.ok
          ? (profileResult.data?.profiles ?? []).filter((profile) => profile.enabled)
          : [];
        const defaultProfileId = enabledProfileId(
          profiles,
          profileResult.data?.defaultProfileId,
        );
        // Catalog readiness is independent of navigation. Starting a new draft
        // while boot data loads cancels view restoration, not the shared data.
        set({ catalog, pluginCatalog, profiles, defaultProfileId });
        if (currentGeneration !== generation) {
          set({
            selectedProfileId: resolveEnabledProfileId(profiles, get().selectedProfileId, defaultProfileId),
          });
          if (!profileResult.ok) {
            set({
              error: profileResult.message ?? 'llm_profiles_unavailable',
              errorSource: 'initialization',
            });
          }
          return;
        }
        const remembered = readRememberedSession();
        const candidate = catalog.sessions.find((session) => session.id === remembered);
        let projection: SessionProjection | null = null;
        let projectionError: string | null = null;
        if (candidate) {
          try {
            projection = await getLocalAgentProjection(candidate.id);
          } catch (error) {
            projectionError = errorMessage(error);
          }
        }
        if (currentGeneration !== generation) return;
        set({
          catalog,
          pluginCatalog,
          profiles,
          defaultProfileId,
          selectedProfileId: projection?.modelSettings?.profileId ?? resolveEnabledProfileId(
            profiles,
            candidate?.profileId,
            defaultProfileId,
          ),
          reasoningEffortOverride: projection?.modelSettings?.reasoningEffortOverride ?? null,
          sessionId: projection?.sessionId ?? candidate?.id ?? null,
          projection,
          draftProjectId: null,
          loading: false,
          error: projectionError
            ?? (profileResult.ok ? null : (profileResult.message ?? 'llm_profiles_unavailable')),
          errorSource: projectionError || !profileResult.ok ? 'initialization' : null,
        });
      } catch (error) {
        if (currentGeneration === generation) {
          set({
            loading: false,
            error: errorMessage(error),
            errorSource: 'initialization',
          });
        }
      }
    })();
    try {
      await initialization;
    } finally {
      initialization = null;
    }
  },

  refreshProfiles: async () => {
    const profileResult = await getLlmProfiles();
    if (!profileResult.ok) {
      set({
        error: profileResult.message ?? 'llm_profiles_unavailable',
        errorSource: 'profiles',
      });
      return;
    }
    const profiles = (profileResult.data?.profiles ?? []).filter((profile) => profile.enabled);
    const defaultProfileId = enabledProfileId(
      profiles,
      profileResult.data?.defaultProfileId,
    );
    set((state) => {
      const summary = state.sessionId
        ? state.catalog.sessions.find((session) => session.id === state.sessionId)
        : undefined;
      return {
        profiles,
        defaultProfileId,
        selectedProfileId: resolveEnabledProfileId(
          profiles,
          state.selectedProfileId ?? summary?.profileId,
          defaultProfileId,
        ),
        ...(state.errorSource === 'profiles' ? { error: null, errorSource: null } : {}),
      };
    });
  },

  refreshCatalog: async () => {
    try {
      const catalog = await getConversationCatalog();
      set((state) => ({
        catalog,
        ...(state.errorSource === 'catalog' ? { error: null, errorSource: null } : {}),
      }));
    } catch (error) {
      set({ error: errorMessage(error), errorSource: 'catalog' });
    }
  },

  refreshPluginCatalog: async () => {
    try {
      const pluginCatalog = await getPluginCatalog();
      set((state) => ({
        pluginCatalog,
        ...(state.errorSource === 'pluginCatalog'
          ? { error: null, errorSource: null }
          : {}),
      }));
    } catch (error) {
      set({ error: errorMessage(error), errorSource: 'pluginCatalog' });
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
      reasoningEffortOverride: null,
      loading: false,
      submitting: activeSubmissionCount > 0,
      error: null,
      errorSource: null,
    });
  },

  activateSession: async (sessionId) => {
    const summary = get().catalog.sessions.find((session) => session.id === sessionId);
    if (!summary) {
      set({ error: 'conversation_session_not_found', errorSource: 'operation' });
      return;
    }
    const currentGeneration = ++generation;
    set({
      loading: true,
      error: null,
      errorSource: null,
      sessionId,
      projection: null,
      draftProjectId: null,
    });
    try {
      const projection = await getLocalAgentProjection(sessionId);
      if (currentGeneration !== generation) return;
      rememberSession(sessionId);
      set({
        sessionId,
        selectedProfileId: projection.modelSettings?.profileId ?? resolveEnabledProfileId(
          get().profiles,
          summary.profileId,
          get().defaultProfileId,
        ),
        reasoningEffortOverride: projection.modelSettings?.reasoningEffortOverride ?? null,
        projection,
        loading: false,
      });
    } catch (error) {
      if (currentGeneration === generation) {
        set({
          loading: false,
          error: errorMessage(error),
          errorSource: 'projection',
        });
      }
    }
  },

  selectProfile: async (profileId) => {
    if (!get().profiles.some((profile) => profile.id === profileId && profile.enabled)) return;
    if (get().selectedProfileId === profileId) return;
    await saveModelSettings(set, get, { profileId, reasoningEffortOverride: null });
  },

  selectReasoningEffort: async (reasoningEffortOverride) => {
    const { selectedProfileId, profiles } = get();
    if (!selectedProfileId || profiles.find((profile) => profile.id === selectedProfileId)?.thinking === 'disabled') return;
    await saveModelSettings(set, get, { profileId: selectedProfileId, reasoningEffortOverride });
  },

  refresh: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    const refreshGeneration = generation;
    if (
      projectionRefreshFlight?.sessionId === sessionId
      && projectionRefreshFlight.generation === refreshGeneration
    ) {
      return await projectionRefreshFlight.promise;
    }

    const promise = (async () => {
      try {
        const projection = await getLocalAgentProjection(sessionId);
        if (generation !== refreshGeneration || get().sessionId !== sessionId) return;
        set((state) => {
          const nextProjection = shouldApplyProjection(state.projection, projection)
            ? projection
            : state.projection;
          if (
            nextProjection === state.projection
            && state.errorSource !== 'projection'
          ) return state;
          return {
            projection: nextProjection,
            ...projectModelSettings(nextProjection),
            ...(state.errorSource === 'projection'
              ? { error: null, errorSource: null }
              : {}),
          };
        });
      } catch (error) {
        if (generation === refreshGeneration && get().sessionId === sessionId) {
          set({ error: errorMessage(error), errorSource: 'projection' });
        }
      }
    })();
    projectionRefreshFlight = { sessionId, generation: refreshGeneration, promise };
    try {
      await promise;
    } finally {
      if (projectionRefreshFlight?.promise === promise) projectionRefreshFlight = null;
    }
  },

  sendMessage: async (
    text,
    filesystemPaths = [],
    pluginSelections = [],
  ) => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('message_empty');
    if (trimmed.startsWith('/')) throw new Error(`conversation_command_unknown:${trimmed}`);
    const { projection } = get();
    if (projection?.pendingPlan) {
      if (filesystemPaths.length || pluginSelections.length) {
        throw new Error('plan_revision_filesystem_references_unsupported');
      }
      return await get().respondPlan({ kind: 'requestRevision', text: trimmed });
    }
    if (projection?.pendingApproval) {
      throw new Error('approval_response_requires_explicit_command');
    }
    if (projection?.pendingInteraction) {
      if (filesystemPaths.length || pluginSelections.length) {
        throw new Error('interaction_response_filesystem_references_unsupported');
      }
      return await get().respondInteraction(trimmed);
    }

    return await submitNewRun(
      set,
      get,
      'message.submit',
      text,
      filesystemPaths,
      pluginSelections,
    );
  },

  focusContext: async (
    task,
    filesystemPaths = [],
    pluginSelections = [],
  ) => {
    if (!task.trim()) throw new Error('context_focus_task_empty');
    const { projection } = get();
    if (projection?.pendingPlan || projection?.pendingApproval || projection?.pendingInteraction) {
      throw new Error('context_focus_run_waiting');
    }
    return await submitNewRun(
      set,
      get,
      'context.focus',
      task,
      filesystemPaths,
      pluginSelections,
    );
  },

  setMessageFeedback: async (messageId, feedback) => {
    const state = get();
    const sessionId = requiredSession(state);
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
    const sessionId = requiredSession(get());
    set({ catalogBusy: true, error: null, errorSource: null });
    try {
      const projection = await attachConversationDirectoryIndex(sessionId, canonicalRoot);
      if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
      set({ projection });
    } catch (error) {
      set({ error: errorMessage(error), errorSource: 'operation' });
      throw error;
    } finally {
      set({ catalogBusy: false });
    }
  },

  detachSessionDirectory: async (workspaceId) => {
    const sessionId = requiredSession(get());
    set({ catalogBusy: true, error: null, errorSource: null });
    try {
      const projection = await detachConversationDirectoryIndex(sessionId, workspaceId);
      if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
      set({ projection });
    } catch (error) {
      set({ error: errorMessage(error), errorSource: 'operation' });
      throw error;
    } finally {
      set({ catalogBusy: false });
    }
  },

  respondInteraction: async (response) => {
    const state = get();
    const sessionId = requiredSession(state);
    const interaction = state.projection?.pendingInteraction;
    if (!interaction || !response.trim()) throw new Error('interaction_response_missing');
    return await submitDecision(
      set,
      get,
      `interaction:${sessionId}:${interaction.runId}:${interaction.interactionId}`,
      () => ({
        schemaVersion: CONVERSATION_COMMAND_VERSION,
        type: 'interaction.respond',
        commandId: nextId('command'),
        sessionId,
        runId: interaction.runId,
        interactionId: interaction.interactionId,
        response: response.trim(),
      }),
    );
  },

  respondApproval: async (decision) => {
    const state = get();
    const sessionId = requiredSession(state);
    const approval = state.projection?.pendingApproval;
    if (!approval) throw new Error('approval_response_missing');
    return await submitDecision(
      set,
      get,
      `approval:${sessionId}:${approval.runId}:${approval.approvalId}`,
      () => ({
        schemaVersion: CONVERSATION_COMMAND_VERSION,
        type: 'approval.respond',
        commandId: nextId('command'),
        sessionId,
        runId: approval.runId,
        callId: approval.callId,
        approvalId: approval.approvalId,
        decision,
      }),
    );
  },

  respondPlan: async (response) => await submitPlanResponse(set, get, response),

  cancelRun: async () => {
    const state = get();
    const sessionId = requiredSession(state);
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
    requiredSummary(get().catalog, sessionId);
    await mutateCatalog(set, async () => await updateSessionRequest(sessionId, input));
  },

  deleteSession: async (sessionId) => {
    const summary = requiredSummary(get().catalog, sessionId);
    const projectId = summary.projectId;
    await mutateCatalog(set, async () => await deleteSessionRequest(sessionId));
    if (get().sessionId === sessionId) get().startNewSession(projectId ?? null);
  },

  clearError: () => set({ error: null, errorSource: null }),
}));

async function submitPlanResponse(
  set: StoreSet,
  get: () => LocalAgentState,
  response: PlanResponse,
): Promise<CommandReply> {
  const state = get();
  const sessionId = requiredSession(state);
  const plan = state.projection?.pendingPlan;
  if (!plan) throw new Error('plan_response_missing');
  return await submitDecision(
    set,
    get,
    `plan:${sessionId}:${plan.runId}:${plan.planId}:${plan.revision}`,
    () => ({
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      type: 'plan.respond',
      commandId: nextId('command'),
      sessionId,
      runId: plan.runId,
      planId: plan.planId,
      revision: plan.revision,
      response,
    }),
  );
}

async function submitNewRun(
  set: StoreSet,
  get: StoreGet,
  type: 'message.submit' | 'context.focus',
  text: string,
  filesystemPaths: PendingFilesystemPath[],
  pluginSelections: PluginSelectionInput[],
): Promise<CommandReply> {
  beginSubmission(set);
  try {
    const messageProfileId = get().selectedProfileId;
    const reasoningEffortOverride = get().reasoningEffortOverride;
    if (!messageProfileId) throw new Error('llm_profile_unavailable');
    const pluginCatalog = get().pluginCatalog;
    const effectivePluginSelections = requiredFilesystemPluginSelections(
      pluginCatalog,
      filesystemPaths,
      pluginSelections,
    );
    const availableUris = new Set(pluginCatalog.plugins.map((plugin) => plugin.uri));
    if (effectivePluginSelections.some((selection) => !availableUris.has(selection.uri))) {
      throw new Error('plugin_selection_unavailable');
    }
    let { sessionId } = get();
    if (!sessionId) {
      const { draftProjectId } = get();
      const created = await createLocalAgentSession({
        ...(draftProjectId ? { projectId: draftProjectId } : {}),
      });
      sessionId = created.sessionId;
      rememberSession(sessionId);
      set({ sessionId, projection: created, draftProjectId: null });
      await get().refreshCatalog();
    }
    const filesystemReferences = filesystemPaths.length
      ? await resolveConversationFilesystemReferences(sessionId, filesystemPaths)
      : [];
    if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
    const common = {
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      commandId: nextId('command'),
      sessionId,
      ...(filesystemReferences.length
        ? {
            filesystemReferences: filesystemReferences.map((reference) => ({
              ...reference,
            })),
          }
        : {}),
      profileId: messageProfileId,
      reasoningEffortOverride,
      ...(effectivePluginSelections.length
        ? {
            pluginCatalogRevision: pluginCatalog.revision,
            pluginSelections: effectivePluginSelections.map((selection) => ({ ...selection })),
          }
        : {}),
    };
    const command: ConversationCommand = type === 'message.submit'
      ? { ...common, type, text }
      : { ...common, type, task: text };
    const reply = await submitCommandAndReconcile(set, get, command);
    await Promise.all([
      get().refreshCatalog(),
      get().refreshPluginCatalog(),
    ]);
    return reply;
  } catch (error) {
    if (errorMessage(error).includes('plugin_selection_stale')) {
      await get().refreshPluginCatalog();
    }
    set({ error: errorMessage(error), errorSource: 'command' });
    throw error;
  } finally {
    endSubmission(set);
  }
}

async function submitDecision(
  set: StoreSet,
  get: StoreGet,
  decisionKey: string,
  command: () => ConversationCommand,
): Promise<CommandReply> {
  const existing = decisionSubmissions.get(decisionKey);
  if (existing) return await existing;
  const submission = submitExisting(set, get, command());
  decisionSubmissions.set(decisionKey, submission);
  try {
    return await submission;
  } finally {
    if (decisionSubmissions.get(decisionKey) === submission) {
      decisionSubmissions.delete(decisionKey);
    }
  }
}

async function submitExisting(
  set: StoreSet,
  get: () => LocalAgentState,
  command: ConversationCommand,
): Promise<CommandReply> {
  beginSubmission(set);
  try {
    return await submitCommandAndReconcile(set, get, command);
  } catch (error) {
    set({ error: errorMessage(error), errorSource: 'command' });
    throw error;
  } finally {
    endSubmission(set);
  }
}

async function submitCommandAndReconcile(
  set: StoreSet,
  get: StoreGet,
  command: ConversationCommand,
): Promise<CommandReply> {
  const reply = await submitLocalAgentCommand(command);
  const rejection = reply.status === 'rejected' ? commandRejectionMessage(reply) : null;
  try {
    await reconcileProjectionAfterReply(set, get, command.sessionId, reply.revision);
  } catch (error) {
    const reconciliation = `conversation_projection_reconcile_failed:${errorMessage(error)}`;
    throw new Error(rejection ? `${rejection};${reconciliation}` : reconciliation);
  }
  if (rejection) throw new Error(rejection);
  set({ error: null, errorSource: null });
  return reply;
}

async function reconcileProjectionAfterReply(
  set: StoreSet,
  get: StoreGet,
  sessionId: string,
  replyRevision: number,
): Promise<void> {
  const projection = await getLocalAgentProjection(sessionId);
  if (projection.revision < replyRevision) {
    throw new Error(
      `conversation_projection_behind_command_reply:${projection.revision}:${replyRevision}`,
    );
  }
  if (get().sessionId !== sessionId) return;
  set((state) => {
    const nextProjection = shouldApplyProjection(state.projection, projection) ? projection : state.projection;
    return { projection: nextProjection, ...projectModelSettings(nextProjection) };
  });
}

function projectModelSettings(projection: SessionProjection | null): Partial<LocalAgentState> {
  return projection?.modelSettings ? {
    selectedProfileId: projection.modelSettings.profileId,
    reasoningEffortOverride: projection.modelSettings.reasoningEffortOverride,
  } : {};
}

async function saveModelSettings(set: StoreSet, get: StoreGet, settings: SessionModelSettings): Promise<void> {
  if (get().modelSettingsBusy) return;
  const sessionId = get().sessionId;
  if (!sessionId) {
    set({ selectedProfileId: settings.profileId, reasoningEffortOverride: settings.reasoningEffortOverride });
    return;
  }
  set({ modelSettingsBusy: true });
  try {
    await submitCommandAndReconcile(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'session.model-settings.set',
      sessionId, commandId: nextId('command'), settings,
    });
  } catch (error) {
    if (get().sessionId === sessionId) set({ error: errorMessage(error), errorSource: 'command' });
  } finally {
    set({ modelSettingsBusy: false });
  }
}

function beginSubmission(set: StoreSet): void {
  activeSubmissionCount += 1;
  set({ submitting: true, error: null, errorSource: null });
}

function endSubmission(set: StoreSet): void {
  activeSubmissionCount -= 1;
  set({ submitting: activeSubmissionCount > 0 });
}

async function mutateCatalog(
  set: StoreSet,
  operation: () => Promise<ConversationCatalog>,
): Promise<void> {
  set({ catalogBusy: true, error: null, errorSource: null });
  try {
    const activeCatalog = await operation();
    set({ catalog: activeCatalog });
  } catch (error) {
    set({ error: errorMessage(error), errorSource: 'operation' });
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

function commandRejectionMessage(reply: CommandReply): string {
  return `${reply.error?.code ?? 'conversation_command_rejected'}:${reply.error?.message ?? ''}`;
}

function requiredSession(state: LocalAgentState): string {
  if (!state.sessionId) throw new Error('conversation_session_missing');
  return state.sessionId;
}

function requiredSummary(catalog: ConversationCatalog, sessionId: string) {
  const summary = catalog.sessions.find((session) => session.id === sessionId);
  if (!summary) throw new Error('conversation_session_not_found');
  return summary;
}

function enabledProfileId(
  profiles: readonly LlmProviderProfile[],
  preferred: string | undefined,
): string | null {
  return profiles.find((profile) => profile.id === preferred)?.id ?? profiles[0]?.id ?? null;
}

function resolveEnabledProfileId(
  profiles: readonly LlmProviderProfile[],
  preferred: string | null | undefined,
  configuredDefault: string | null,
): string | null {
  return profiles.find((profile) => profile.id === preferred)?.id
    ?? profiles.find((profile) => profile.id === configuredDefault)?.id
    ?? profiles[0]?.id
    ?? null;
}

function shouldApplyProjection(
  current: SessionProjection | null,
  incoming: SessionProjection,
): boolean {
  if (!current || incoming.revision > current.revision) return true;
  if (incoming.revision < current.revision) return false;
  return !sameAssistantDraft(current.assistantDraft, incoming.assistantDraft);
}

function sameAssistantDraft(
  left: SessionProjection['assistantDraft'],
  right: SessionProjection['assistantDraft'],
): boolean {
  if (left === null || right === null) return left === right;
  return left.runId === right.runId
    && left.turnId === right.turnId
    && left.content === right.content
    && left.reasoningContent === right.reasoningContent
    && JSON.stringify(left.activity) === JSON.stringify(right.activity)
    && JSON.stringify(left.orderedBlocks) === JSON.stringify(right.orderedBlocks);
}

function requiredFilesystemPluginSelections(
  catalog: PluginCatalogProjection,
  filesystemPaths: readonly PendingFilesystemPath[],
  explicitSelections: readonly PluginSelectionInput[],
): PluginSelectionInput[] {
  const selections = explicitSelections.map((selection) => ({ ...selection }));
  const selectedUris = new Set(selections.map((selection) => selection.uri));
  const requiredMediaTypes = new Set(filesystemPaths.flatMap((reference) => (
    reference.kind === 'file' && reference.path.toLocaleLowerCase().endsWith('.pdf')
      ? ['application/pdf']
      : []
  )));
  for (const mediaType of requiredMediaTypes) {
    const matches = catalog.plugins.filter((plugin) => (
      plugin.activationMediaTypes.includes(mediaType)
    ));
    if (matches.length !== 1) {
      throw new Error(`plugin_selection_unavailable:${mediaType}`);
    }
    const plugin = matches[0]!;
    if (selectedUris.has(plugin.uri)) continue;
    selections.push({
      selectionId: nextId('plugin-selection'),
      uri: plugin.uri,
      label: plugin.displayName,
    });
    selectedUris.add(plugin.uri);
  }
  return selections;
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
