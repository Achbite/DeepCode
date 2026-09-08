import type {
  CommandReply,
  ConversationCatalog,
  ConversationCatalogManagement,
  ConversationCommand,
  ContextCompositionMessageBlock,
  ContextCompositionTool,
  FilesystemReference,
  PluginCatalogProjection,
  SessionProjection,
} from '@deepcode/protocol';
import {
  COMMAND_REPLY_VERSION,
  RUN_PROJECTION_STATUSES,
  SESSION_PROJECTION_VERSION,
} from '@deepcode/protocol';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';
import { isShellActivityResult } from './shellActivityCodec';

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T | null;
  error?: string | null;
  message?: string | null;
}

const API_BASE = getKernelApiBase();

const CONTEXT_TOOL_ORIGINS: Readonly<Record<ContextCompositionTool['origin'], true>> = {
  coreBuiltin: true,
  extension: true,
  sessionControl: true,
  providerHosted: true,
};

const CONTEXT_MESSAGE_BLOCK_KINDS: Readonly<
  Record<ContextCompositionMessageBlock['kind'], true>
> = {
  text: true,
  reasoning: true,
  toolCall: true,
  toolResult: true,
  hostedWebSearch: true,
};

export interface ConversationResourceReadResult {
  workspaceId: string;
  logicalPath: string;
  content: string;
  sizeBytes: number;
  startLine: number;
  endLine: number;
}

export async function createLocalAgentSession(
  input: {
    workspacePaths?: string[];
    projectId?: string;
    profileId?: string;
  },
  signal?: AbortSignal,
): Promise<SessionProjection> {
  const projection = await request<unknown>(
    `${API_BASE}/conversation/sessions`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
  return decodeProjection(projection);
}

export async function getConversationCatalog(
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/catalog`,
    { signal },
  ));
}

export async function getPluginCatalog(
  signal?: AbortSignal,
): Promise<PluginCatalogProjection> {
  return decodePluginCatalog(await request<unknown>(
    `${API_BASE}/conversation/plugins`,
    { signal },
  ));
}

export async function getConversationCatalogManagement(
  signal?: AbortSignal,
): Promise<ConversationCatalogManagement> {
  return decodeCatalogManagement(await request<unknown>(
    `${API_BASE}/conversation/catalog/manage`,
    { signal },
  ));
}

export async function createConversationProject(
  input: { title: string; workspacePaths?: string[] },
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/projects`,
    { method: 'POST', body: JSON.stringify(input), signal },
  ));
}

export async function updateConversationProject(
  projectId: string,
  input: { title?: string; workspacePaths?: string[] },
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/projects/${encodeURIComponent(projectId)}`,
    { method: 'PATCH', body: JSON.stringify(input), signal },
  ));
}

export async function deleteConversationProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/projects/${encodeURIComponent(projectId)}`,
    { method: 'DELETE', signal },
  ));
}

export async function updateConversationSession(
  sessionId: string,
  input: { title?: string; projectId?: string | null },
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'PATCH', body: JSON.stringify(input), signal },
  ));
}

export async function deleteConversationSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', signal },
  ));
}

export async function attachConversationDirectoryIndex(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<SessionProjection> {
  const projection = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/directory-indexes`,
    { method: 'POST', body: JSON.stringify({ path }), signal },
  );
  return decodeProjection(projection);
}

export async function resolveConversationFilesystemReferences(
  sessionId: string,
  references: Array<{ path: string; kind: 'file' | 'directory' }>,
  signal?: AbortSignal,
): Promise<FilesystemReference[]> {
  const value = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/filesystem-references/resolve`,
    { method: 'POST', body: JSON.stringify({ references }), signal },
  );
  if (!isArrayOf(value, isFilesystemReference)) {
    throw new Error('conversation_filesystem_references_response_invalid');
  }
  return value as FilesystemReference[];
}

export async function detachConversationDirectoryIndex(
  sessionId: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<SessionProjection> {
  const projection = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/directory-indexes/${encodeURIComponent(workspaceId)}`,
    { method: 'DELETE', signal },
  );
  return decodeProjection(projection);
}

export async function submitLocalAgentCommand(
  command: ConversationCommand,
  signal?: AbortSignal,
): Promise<CommandReply> {
  const reply = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(command.sessionId)}/commands`,
    {
      method: 'POST',
      body: JSON.stringify(command),
      signal,
    },
  );
  return decodeCommandReply(reply);
}

export async function getLocalAgentProjection(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionProjection> {
  const projection = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/projection`,
    { signal },
  );
  return decodeProjection(projection);
}

export async function readConversationResource(
  sessionId: string,
  workspaceId: string,
  logicalPath: string,
  signal?: AbortSignal,
): Promise<ConversationResourceReadResult> {
  const value = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/resources/read`,
    {
      method: 'POST',
      body: JSON.stringify({ workspaceId, logicalPath }),
      signal,
    },
  );
  if (
    !isRecord(value)
    || value.workspaceId !== workspaceId
    || typeof value.logicalPath !== 'string'
    || typeof value.content !== 'string'
    || !Number.isSafeInteger(value.sizeBytes)
    || !Number.isSafeInteger(value.startLine)
    || !Number.isSafeInteger(value.endLine)
  ) {
    throw new Error('conversation_resource_response_invalid');
  }
  return value as unknown as ConversationResourceReadResult;
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...getHostConnectionHeaders(),
      ...init.headers,
    },
  });
  let envelope: ApiEnvelope<T>;
  try {
    envelope = await response.json() as ApiEnvelope<T>;
  } catch {
    throw new Error(`conversation_response_invalid:HTTP ${response.status}`);
  }
  if (!response.ok || !envelope.ok || envelope.data === undefined || envelope.data === null) {
    throw new Error(
      `${envelope.error ?? 'conversation_request_failed'}:${envelope.message ?? `HTTP ${response.status}`}`,
    );
  }
  return envelope.data;
}

function decodeProjection(value: unknown): SessionProjection {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'sessionId',
      'revision',
      'display',
      'modelSettings',
      'workspaceBindings',
      'sessionDirectoryIndexes',
      'timeline',
      'messages',
      'narratives',
      'assistantDraft',
      'pendingInteraction',
      'pendingApproval',
      'plans',
      'activePlanRef',
      'pendingPlan',
      'todoList',
      'contextUsage',
      'contextCompositions',
      'tokenUsage',
      'tokenUsageHistory',
      'run',
      'activities',
      'artifacts',
      'terminalError',
    ])
    || value.schemaVersion !== SESSION_PROJECTION_VERSION
    || !isIdentifier(value.sessionId)
    || !isNaturalNumber(value.revision)
    || !isSessionDisplay(value.display)
    || !isNullable(value.modelSettings, isModelSettings)
    || !isWorkspaceBindings(value.workspaceBindings)
    || !isWorkspaceBindings(value.sessionDirectoryIndexes)
    || !isArrayOf(value.timeline, isTimelineItem)
    || !isArrayOf(value.messages, isProjectionMessage)
    || !isArrayOf(value.narratives, isNarrative)
    || !isNullable(value.assistantDraft, isAssistantDraft)
    || !isNullable(value.pendingInteraction, isInteraction)
    || !isNullable(value.pendingApproval, isApproval)
    || !isArrayOf(value.plans, isPlanProjection)
    || !isNullable(value.activePlanRef, isPlanReference)
    || !isNullable(value.pendingPlan, isPendingPlan)
    || !isNullable(value.todoList, isTodoList)
    || !isNullable(value.contextUsage, isContextUsage)
    || !isArrayOf(value.contextCompositions, isContextComposition)
    || !isTokenUsage(value.tokenUsage)
    || !isTokenUsageHistory(value.tokenUsageHistory)
    || !isNullable(value.run, isRun)
    || !isArrayOf(value.activities, isActivity)
    || !isArrayOf(value.artifacts, isArtifact)
    || !isNullable(value.terminalError, isLocalAgentError)
  ) {
    throw new Error('conversation_projection_invalid');
  }
  const plans = value.plans as Array<{planId: string; revision: number}>;
  const activePlanRef = value.activePlanRef as {planId: string; revision: number} | null;
  const pendingPlan = value.pendingPlan as {planId: string; revision: number} | null;
  const todoList = value.todoList as {
    sourcePlanId: string;
    sourcePlanRevision: number;
  } | null;
  const timeline = value.timeline as Array<Record<string, unknown>>;
  const projectionRevision = value.revision as number;
  const messages = value.messages as Array<Record<string, unknown>>;
  const narratives = value.narratives as Array<Record<string, unknown>>;
  const activities = value.activities as Array<Record<string, unknown>>;
  const planKeys = plans.map((plan) => planReferenceKey(plan));
  if (
    new Set(planKeys).size !== planKeys.length
    || (activePlanRef !== null
      && !planKeys.includes(planReferenceKey(activePlanRef)))
    || (pendingPlan !== null
      && !planKeys.includes(planReferenceKey(pendingPlan)))
    || (todoList !== null
      && !planKeys.includes(planReferenceKey({
        planId: todoList.sourcePlanId,
        revision: todoList.sourcePlanRevision,
      })))
    || timeline.some((item) => (item.sequence as number) > projectionRevision)
    || !timelineReferencesAreValid(timeline, messages, narratives, plans, activities)
  ) {
    throw new Error('conversation_projection_invalid');
  }
  return value as unknown as SessionProjection;
}

function isTimelineItem(value: unknown): boolean {
  if (!isRecord(value) || !isIdentifier(value.timelineId) || !isPositiveNaturalNumber(value.sequence)) {
    return false;
  }
  switch (value.kind) {
    case 'message':
      return isExactRecord(
        value,
        ['kind', 'timelineId', 'sequence', 'messageId'],
        ['outputIndex'],
      )
        && isIdentifier(value.messageId)
        && (value.outputIndex === undefined || isNaturalNumber(value.outputIndex));
    case 'narrative':
      return isExactRecord(
        value,
        ['kind', 'timelineId', 'sequence', 'providerRequestId', 'narrativeId'],
        ['outputIndex'],
      )
        && isIdentifier(value.providerRequestId)
        && isIdentifier(value.narrativeId)
        && (value.outputIndex === undefined || isNaturalNumber(value.outputIndex));
    case 'plan':
      return isExactRecord(value, [
        'kind', 'timelineId', 'sequence', 'providerRequestId', 'planId', 'revision',
      ])
        && isIdentifier(value.providerRequestId)
        && isIdentifier(value.planId)
        && isPositiveNaturalNumber(value.revision);
    case 'toolGroup':
      return isExactRecord(value, [
        'kind', 'timelineId', 'sequence', 'providerRequestId', 'activityIds',
      ])
        && isIdentifier(value.providerRequestId)
        && Array.isArray(value.activityIds)
        && value.activityIds.length > 0
        && value.activityIds.every(isIdentifier);
    default:
      return false;
  }
}

function timelineReferencesAreValid(
  timeline: Array<Record<string, unknown>>,
  messages: Array<Record<string, unknown>>,
  narratives: Array<Record<string, unknown>>,
  plans: Array<{ planId: string; revision: number }>,
  activities: Array<Record<string, unknown>>,
): boolean {
  const timelineIds = new Set<string>();
  const messageIds = new Set<string>();
  const narrativeIds = new Set<string>();
  const planRefs = new Set<string>();
  const activityIds = new Set<string>();
  const addUnique = (values: Set<string>, value: string): boolean => {
    if (values.has(value)) return false;
    values.add(value);
    return true;
  };
  const valid = timeline.every((item) => {
    const timelineId = item.timelineId as string;
    if (!addUnique(timelineIds, timelineId)) return false;
    switch (item.kind) {
      case 'message': {
        const messageId = item.messageId as string;
        return addUnique(messageIds, messageId)
          && messages.some((message) => (
            message.messageId === messageId
            && ['user', 'assistant'].includes(String(message.role))
          ));
      }
      case 'narrative': {
        const narrativeId = item.narrativeId as string;
        return addUnique(narrativeIds, narrativeId)
          && narratives.some((narrative) => (
            narrative.narrativeId === narrativeId
            && narrative.providerRequestId === item.providerRequestId
          ));
      }
      case 'plan': {
        const reference = planReferenceKey({
          planId: item.planId as string,
          revision: item.revision as number,
        });
        return addUnique(planRefs, reference)
          && plans.some((plan) => planReferenceKey(plan) === reference);
      }
      case 'toolGroup':
        return (item.activityIds as string[]).every((activityId) => (
          addUnique(activityIds, activityId)
          && activities.some((activity) => (
            activity.activityId === activityId
            && ['tool', 'providerHosted'].includes(String(activity.kind))
          ))
        ));
      default:
        return false;
    }
  });
  return valid
    && messageIds.size === messages.filter((message) => (
      ['user', 'assistant'].includes(String(message.role))
    )).length
    && narrativeIds.size === narratives.length
    && planRefs.size === plans.length
    && activityIds.size === activities.filter((activity) => (
      ['tool', 'providerHosted'].includes(String(activity.kind))
    )).length;
}

function decodeCommandReply(value: unknown): CommandReply {
  if (
    !isRecord(value)
    || value.schemaVersion !== COMMAND_REPLY_VERSION
    || typeof value.commandId !== 'string'
    || typeof value.sessionId !== 'string'
    || !Number.isSafeInteger(value.revision)
    || !['accepted', 'replayed', 'rejected'].includes(String(value.status))
  ) {
    throw new Error('conversation_command_reply_invalid');
  }
  return value as unknown as CommandReply;
}

function decodeCatalog(value: unknown): ConversationCatalog {
  if (!isRecord(value) || !Array.isArray(value.projects) || !Array.isArray(value.sessions)) {
    throw new Error('conversation_catalog_invalid');
  }
  for (const project of value.projects) {
    if (
      !isRecord(project)
      || typeof project.id !== 'string'
      || typeof project.title !== 'string'
      || typeof project.createdAt !== 'string'
      || typeof project.updatedAt !== 'string'
      || !isWorkspaceBindings(project.workspaceBindings)
    ) throw new Error('conversation_catalog_invalid');
  }
  for (const session of value.sessions) {
    if (
      !isExactRecord(
        session,
        ['id', 'title', 'workspaceBindings', 'createdAt', 'updatedAt'],
        ['projectId', 'profileId'],
      )
      || typeof session.id !== 'string'
      || typeof session.title !== 'string'
      || typeof session.createdAt !== 'string'
      || typeof session.updatedAt !== 'string'
      || (session.projectId !== undefined && typeof session.projectId !== 'string')
      || (session.profileId !== undefined && typeof session.profileId !== 'string')
      || !isWorkspaceBindings(session.workspaceBindings)
    ) throw new Error('conversation_catalog_invalid');
  }
  return value as unknown as ConversationCatalog;
}

function decodePluginCatalog(value: unknown): PluginCatalogProjection {
  if (
    !isExactRecord(value, ['revision', 'plugins'])
    || !isIdentifier(value.revision)
    || !Array.isArray(value.plugins)
  ) throw new Error('plugin_catalog_invalid');
  const uris = new Set<string>();
  for (const plugin of value.plugins) {
    if (
      !isExactRecord(
        plugin,
        [
          'uri', 'displayName', 'shortDescription', 'activationMediaTypes',
          'enabled', 'available',
        ],
        ['iconRef'],
      )
      || typeof plugin.uri !== 'string'
      || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(plugin.uri)
      || uris.has(plugin.uri)
      || !isNonEmptyText(plugin.displayName)
      || !isNonEmptyText(plugin.shortDescription)
      || (plugin.iconRef !== undefined && !isNonEmptyText(plugin.iconRef))
      || !isArrayOf(plugin.activationMediaTypes, isMediaType)
      || new Set(plugin.activationMediaTypes).size !== plugin.activationMediaTypes.length
      || plugin.enabled !== true
      || plugin.available !== true
    ) throw new Error('plugin_catalog_invalid');
    uris.add(plugin.uri);
  }
  return value as unknown as PluginCatalogProjection;
}

function decodeCatalogManagement(value: unknown): ConversationCatalogManagement {
  const catalog = decodeCatalog(value);
  if (!isRecord(value) || !Array.isArray(value.workspaces)) {
    throw new Error('conversation_catalog_management_invalid');
  }
  for (const workspace of value.workspaces) {
    if (
      !isRecord(workspace)
      || typeof workspace.workspaceId !== 'string'
      || typeof workspace.displayName !== 'string'
      || typeof workspace.canonicalRoot !== 'string'
      || typeof workspace.createdAt !== 'string'
    ) throw new Error('conversation_catalog_management_invalid');
  }
  return { ...catalog, workspaces: value.workspaces } as ConversationCatalogManagement;
}

function isWorkspaceBindings(value: unknown): boolean {
  return Array.isArray(value) && value.every((binding) => (
    isExactRecord(binding, ['workspaceId', 'displayName'])
    && isIdentifier(binding.workspaceId)
    && isNonEmptyText(binding.displayName)
  ));
}

function isSessionDisplay(value: unknown): boolean {
  return isExactRecord(value, ['creationTitle'])
    && typeof value.creationTitle === 'string';
}

function isProjectionMessage(value: unknown): boolean {
  if (!isExactRecord(value, [
    'messageId', 'role', 'content', 'filesystemReferences',
    'pluginSelections', 'feedback', 'sequence', 'createdAt',
  ], ['runId', 'providerRequestId'])) return false;
  const hasRunId = value.runId !== undefined;
  const hasProviderRequestId = value.providerRequestId !== undefined;
  return isIdentifier(value.messageId)
    && ['user', 'assistant', 'tool', 'system'].includes(String(value.role))
    && typeof value.content === 'string'
    && isArrayOf(value.filesystemReferences, isFilesystemReference)
    && isArrayOf(value.pluginSelections, isPluginSelection)
    && (value.feedback === null || ['up', 'down'].includes(String(value.feedback)))
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt)
    && (!hasRunId || isIdentifier(value.runId))
    && (!hasProviderRequestId || isIdentifier(value.providerRequestId))
    && (value.role === 'assistant'
      ? hasRunId && hasProviderRequestId
      : !hasProviderRequestId);
}

function isPluginSelection(value: unknown): boolean {
  return isExactRecord(value, ['selectionId', 'uri', 'label'])
    && isIdentifier(value.selectionId)
    && typeof value.uri === 'string'
    && /^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.uri)
    && isNonEmptyText(value.label);
}

function isFilesystemReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const common = ['referenceId', 'workspaceId', 'logicalPath', 'displayName', 'kind'];
  const keys = value.kind === 'file' ? [...common, 'mediaType', 'byteLength'] : common;
  if (!isExactRecord(value, keys)) return false;
  const commonValid = isIdentifier(value.referenceId)
    && isIdentifier(value.workspaceId)
    && isNonEmptyText(value.logicalPath)
    && isNonEmptyText(value.displayName);
  if (!commonValid) return false;
  if (value.kind === 'directory') return value.logicalPath === '.';
  return value.kind === 'file'
    && value.logicalPath !== '.'
    && isMediaType(value.mediaType)
    && isNaturalNumber(value.byteLength);
}

function isMediaType(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value);
}

function isNarrative(value: unknown): boolean {
  return isExactRecord(value, [
    'narrativeId', 'runId', 'providerRequestId', 'content', 'sequence', 'createdAt',
  ])
    && isIdentifier(value.narrativeId)
    && isIdentifier(value.runId)
    && isIdentifier(value.providerRequestId)
    && isNonEmptyText(value.content)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt);
}

function isAssistantDraft(value: unknown): boolean {
  if (!isExactRecord(
    value,
    ['runId', 'turnId', 'content'],
    ['reasoningContent', 'orderedBlocks', 'activity'],
  )
    || !isIdentifier(value.runId)
    || !isIdentifier(value.turnId)
    || typeof value.content !== 'string'
    || value.reasoningContent !== undefined && typeof value.reasoningContent !== 'string'
    || value.activity !== undefined && !isProviderActivity(value.activity)
  ) return false;
  if (value.orderedBlocks === undefined) return true;
  const orderedBlocks = value.orderedBlocks;
  if (
    value.content !== ''
    || value.reasoningContent !== undefined
    || !Array.isArray(orderedBlocks)
    || orderedBlocks.length === 0
    || !orderedBlocks.every(isAssistantDraftBlock)
  ) return false;
  return orderedBlocks.every((block, index) => (
    index === 0 || block.outputIndex > orderedBlocks[index - 1].outputIndex
  ));
}

function isProviderActivity(value: unknown): boolean {
  return isExactRecord(value, ['purpose', 'phase', 'startedAt'], ['lastContentAt'])
    && ['agent', 'contextCompaction'].includes(String(value.purpose))
    && ['waitingResponse', 'reasoning', 'awaitingOutput', 'generatingOutput'].includes(String(value.phase))
    && isNonEmptyText(value.startedAt) && Number.isFinite(Date.parse(value.startedAt))
    && (value.lastContentAt === undefined || isNonEmptyText(value.lastContentAt) && Number.isFinite(Date.parse(value.lastContentAt)));
}

function isAssistantDraftBlock(value: unknown): value is Record<string, unknown> & {
  outputIndex: number;
} {
  if (!isRecord(value) || !isNaturalNumber(value.outputIndex)) return false;
  if (value.kind === 'narrative' || value.kind === 'finalMessage' || value.kind === 'message') {
    return isExactRecord(value, ['outputIndex', 'kind', 'content'])
      && isNonEmptyText(value.content);
  }
  return value.kind === 'providerHosted'
    && isExactRecord(value, [
      'outputIndex', 'kind', 'providerCallId', 'providerToolType', 'status', 'action',
    ])
    && isIdentifier(value.providerCallId)
    && value.providerToolType === 'web_search'
    && (value.status === 'completed' || value.status === 'failed')
    && isRecord(value.action);
}

function isInteraction(value: unknown): boolean {
  return isExactRecord(
    value,
    [
      'kind', 'prompt', 'allowFreeform', 'interactionId', 'runId', 'callId', 'sequence',
      'createdAt',
    ],
    ['options'],
  )
    && ['question', 'confirmation'].includes(String(value.kind))
    && isNonEmptyText(value.prompt)
    && typeof value.allowFreeform === 'boolean'
    && isIdentifier(value.interactionId)
    && isIdentifier(value.runId)
    && isIdentifier(value.callId)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt)
    && (value.options === undefined || isArrayOf(value.options, isInteractionOption));
}

function isInteractionOption(value: unknown): boolean {
  return isExactRecord(value, ['id', 'label'], ['description'])
    && isIdentifier(value.id)
    && isNonEmptyText(value.label)
    && (value.description === undefined || isNonEmptyText(value.description));
}

function isApproval(value: unknown): boolean {
  return isExactRecord(
    value,
    ['approvalId', 'runId', 'callId', 'preview', 'sequence', 'createdAt'],
  )
    && isIdentifier(value.approvalId)
    && isIdentifier(value.runId)
    && isIdentifier(value.callId)
    && isEffectPreview(value.preview)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt);
}

function isEffectPreview(value: unknown): boolean {
  const effects = ['localRead', 'workspaceRead', 'workspaceMutation', 'process', 'network', 'external'];
  return isExactRecord(value, ['summary', 'effects', 'logicalTargets'])
    && isNonEmptyText(value.summary)
    && Array.isArray(value.effects)
    && value.effects.every((effect) => effects.includes(String(effect)))
    && Array.isArray(value.logicalTargets)
    && value.logicalTargets.every(isNonEmptyText);
}

const PLAN_STATUSES = [
  'published',
  'revisionRequested',
  'confirmed',
  'superseded',
  'cancelled',
  'completed',
  'invalidated',
] as const;

const PLAN_FIELDS = [
  'planId',
  'revision',
  'title',
  'summary',
  'steps',
  'mutationManifest',
  'runId',
  'callId',
  'status',
  'sequence',
  'createdAt',
  'updatedAt',
] as const;

function isPlanProjection(value: unknown): value is Record<string, unknown> & {
  planId: string;
  revision: number;
} {
  return isExactRecord(value, PLAN_FIELDS, ['decisionId'])
    && isPlanProjectionFields(value);
}

function isPendingPlan(value: unknown): boolean {
  return isExactRecord(value, [...PLAN_FIELDS, 'responseMode'], ['decisionId'])
    && isPlanProjectionFields(value)
    && value.status === 'published'
    && value.responseMode === 'confirmReviseOrCancel';
}

function isPlanProjectionFields(value: Record<string, unknown>): boolean {
  if (
    !isIdentifier(value.planId)
    || !isPositiveNaturalNumber(value.revision)
    || !isNonEmptyText(value.title)
    || !isNonEmptyText(value.summary)
    || !isIdentifier(value.runId)
    || !isIdentifier(value.callId)
    || !PLAN_STATUSES.includes(value.status as typeof PLAN_STATUSES[number])
    || !isNaturalNumber(value.sequence)
    || !isNonEmptyText(value.createdAt)
    || !isNonEmptyText(value.updatedAt)
    || (value.decisionId !== undefined && !isIdentifier(value.decisionId))
    || !isArrayOf(value.steps, isPlanStep)
    || value.steps.length < 1
    || value.steps.length > 12
    || !isArrayOf(value.mutationManifest, isPlanOperation)
    || value.mutationManifest.length > 128
  ) return false;
  return new Set(value.steps.map((step) => step.stepId)).size === value.steps.length;
}

function isPlanStep(value: unknown): value is Record<string, unknown> & { stepId: string } {
  return isExactRecord(value, ['stepId', 'title', 'details'], ['verification'])
    && isIdentifier(value.stepId)
    && isNonEmptyText(value.title)
    && isNonEmptyText(value.details)
    && (value.verification === undefined
      || (Array.isArray(value.verification) && value.verification.every(isNonEmptyText)));
}

function isPlanOperation(value: unknown): boolean {
  if (!isRecord(value) || !isIdentifier(value.workspaceId)) {
    return false;
  }
  if (value.operation === 'bash') {
    return isExactRecord(
      value,
      ['workspaceId', 'operation', 'workspaceMode', 'executionScope'],
      ['command', 'terminal'],
    )
      && (value.command === undefined || isNonEmptyText(value.command))
      && value.workspaceMode === 'write'
      && (value.executionScope === 'workspace' || value.executionScope === 'host')
      && (value.terminal === undefined || (
        isExactRecord(value.terminal, ['stdin'])
        && typeof value.terminal.stdin === 'string'
        && new TextEncoder().encode(value.terminal.stdin).byteLength <= 65_536
      ));
  }
  if (!isNonEmptyText(value.target)) return false;
  if (value.operation === 'fs.delete') {
    return isExactRecord(value, ['workspaceId', 'operation', 'target', 'targetKind'])
      && ['file', 'directoryTree'].includes(String(value.targetKind));
  }
  return isExactRecord(value, ['workspaceId', 'operation', 'target'])
    && ['fs.write', 'fs.edit']
      .includes(String(value.operation));
}

function isPlanReference(value: unknown): value is { planId: string; revision: number } {
  return isExactRecord(value, ['planId', 'revision'])
    && isIdentifier(value.planId)
    && isPositiveNaturalNumber(value.revision);
}

function planReferenceKey(value: { planId: string; revision: number }): string {
  return `${value.planId}\u0000${value.revision}`;
}

function isTodoList(value: unknown): boolean {
  if (
    !isExactRecord(value, [
      'sourcePlanId',
      'sourcePlanRevision',
      'items',
      'sequence',
      'updatedAt',
    ])
    || !isIdentifier(value.sourcePlanId)
    || !isPositiveNaturalNumber(value.sourcePlanRevision)
    || !isNaturalNumber(value.sequence)
    || !isNonEmptyText(value.updatedAt)
    || !isArrayOf(value.items, isTodoItem)
    || value.items.length > 12
  ) return false;
  return new Set(value.items.map((item) => item.todoId)).size === value.items.length;
}

function isTodoItem(value: unknown): value is Record<string, unknown> & { todoId: string } {
  return isExactRecord(value, ['todoId', 'sourceStepId', 'label', 'status'])
    && isIdentifier(value.todoId)
    && isIdentifier(value.sourceStepId)
    && isNonEmptyText(value.label)
    && ['pending', 'inProgress', 'completed'].includes(String(value.status));
}

function isContextUsage(value: unknown): boolean {
  if (!isExactRecord(
    value,
    [
      'providerRequestId',
      'providerRuntimeRef',
      'runId',
      'sequence',
      'updatedAt',
      'inputTokens',
      'outputTokens',
      'contextWindowTokens',
    ],
    ['cacheReadInputTokens', 'cacheMissInputTokens'],
  )) return false;
  if (
    !isIdentifier(value.providerRequestId)
    || !isIdentifier(value.providerRuntimeRef)
    || !isIdentifier(value.runId)
    || !isNaturalNumber(value.sequence)
    || !isNonEmptyText(value.updatedAt)
    || !isNaturalNumber(value.inputTokens)
    || !isNaturalNumber(value.outputTokens)
    || !isPositiveNaturalNumber(value.contextWindowTokens)
    || value.inputTokens + value.outputTokens > value.contextWindowTokens
  ) return false;
  const hasRead = value.cacheReadInputTokens !== undefined;
  const hasMiss = value.cacheMissInputTokens !== undefined;
  return hasRead === hasMiss
    && (!hasRead || (
      isNaturalNumber(value.cacheReadInputTokens)
      && isNaturalNumber(value.cacheMissInputTokens)
      && value.cacheReadInputTokens + value.cacheMissInputTokens === value.inputTokens
    ));
}

function isContextComposition(value: unknown): boolean {
  return isExactRecord(value, [
    'providerRequestId',
    'purpose',
    'responseConstraint',
    'stableCoreHash',
    'baseToolSchemaHash',
    'selectedPluginSnapshotHash',
    'dynamicInstructionBytes',
    'runId',
    'messages',
    'workspaceBindings',
    'tools',
    'partitions',
    'sequence',
    'createdAt',
  ])
    && isIdentifier(value.providerRequestId)
    && ['agent', 'contextCompaction'].includes(String(value.purpose))
    && ['normal', 'toolRequired', 'answerOnly'].includes(String(value.responseConstraint))
    && isNonEmptyText(value.stableCoreHash)
    && isNonEmptyText(value.baseToolSchemaHash)
    && isNonEmptyText(value.selectedPluginSnapshotHash)
    && isNaturalNumber(value.dynamicInstructionBytes)
    && isIdentifier(value.runId)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt)
    && Array.isArray(value.messages)
    && value.messages.every((message, index) => isContextMessage(message, index))
    && isArrayOf(value.workspaceBindings, isContextItem)
    && isArrayOf(value.tools, isContextTool)
    && contextPartitionsAreValid(value.partitions);
}

const CONTEXT_PARTITION_ORDER = [
  'instructions',
  'sessionControls',
  'tools',
  'workspaceBindings',
  'contextProviders',
  'journalMessages',
  'filesystemReferences',
] as const;

function contextPartitionsAreValid(value: unknown): boolean {
  if (
    !Array.isArray(value)
    || value.length !== CONTEXT_PARTITION_ORDER.length
    || value.some((partition, index) => !isContextPartition(
      partition,
      CONTEXT_PARTITION_ORDER[index],
    ))
    || value.every((partition) => partition.requestShapeUnits === 0)
  ) return false;
  const first = value[0] as Record<string, unknown>;
  const hasEstimates = first.estimatedInputTokens !== undefined;
  return value.every((partition) => (
    (partition as Record<string, unknown>).estimatedInputTokens !== undefined
  ) === hasEstimates);
}

function isContextPartition(value: unknown, kind: string): boolean {
  if (!isExactRecord(
    value,
    ['kind', 'itemCount', 'requestShapeUnits'],
    ['estimatedInputTokens', 'tokenSource'],
  )) return false;
  const hasEstimate = value.estimatedInputTokens !== undefined;
  return value.kind === kind
    && isNaturalNumber(value.itemCount)
    && isNaturalNumber(value.requestShapeUnits)
    && (hasEstimate
      ? isNaturalNumber(value.estimatedInputTokens) && value.tokenSource === 'sessionEstimated'
      : value.tokenSource === undefined);
}

function isContextMessage(value: unknown, messageIndex: number): boolean {
  const kinds = [
    'instructions',
    'workspaceBindings',
    'sessionControls',
    'journalMessages',
    'contextProviders',
  ];
  return isExactRecord(value, [
    'messageIndex',
    'contributionId',
    'contributionKind',
    'label',
    'role',
    'blocks',
    'filesystemReferences',
  ])
    && value.messageIndex === messageIndex
    && isIdentifier(value.contributionId)
    && kinds.includes(String(value.contributionKind))
    && isNonEmptyText(value.label)
    && ['system', 'user', 'assistant', 'tool'].includes(String(value.role))
    && Array.isArray(value.blocks)
    && value.blocks.every((block, index) => isContextMessageBlock(block, index))
    && isArrayOf(value.filesystemReferences, isContextItem);
}

function isContextMessageBlock(value: unknown, blockIndex: number): boolean {
  if (!isRecord(value) || value.blockIndex !== blockIndex) return false;
  if (!Object.hasOwn(CONTEXT_MESSAGE_BLOCK_KINDS, String(value.kind))) return false;
  if (value.kind === 'text' || value.kind === 'reasoning') {
    return isExactRecord(value, ['blockIndex', 'kind']);
  }
  if (value.kind === 'toolCall') {
    return isExactRecord(value, ['blockIndex', 'kind', 'callId', 'toolName'])
      && isIdentifier(value.callId)
      && isNonEmptyText(value.toolName);
  }
  if (value.kind === 'toolResult') {
    return isExactRecord(value, ['blockIndex', 'kind', 'resultForCallId'])
      && isIdentifier(value.resultForCallId);
  }
  if (value.kind === 'hostedWebSearch') {
    return isExactRecord(value, ['blockIndex', 'kind', 'providerCallId'])
      && isIdentifier(value.providerCallId);
  }
  return false;
}

function isContextItem(value: unknown): boolean {
  return isExactRecord(value, ['itemId', 'label'])
    && isIdentifier(value.itemId)
    && isNonEmptyText(value.label);
}

function isContextTool(value: unknown): boolean {
  return isExactRecord(
    value,
    ['itemId', 'label', 'canonicalName', 'wireName', 'origin', 'availability'],
    ['pluginUri'],
  )
    && isIdentifier(value.itemId)
    && isNonEmptyText(value.label)
    && isNonEmptyText(value.canonicalName)
    && isNonEmptyText(value.wireName)
    && Object.hasOwn(CONTEXT_TOOL_ORIGINS, String(value.origin))
    && ['callable', 'blocked'].includes(String(value.availability))
    && (value.pluginUri === undefined
      || typeof value.pluginUri === 'string'
        && /^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u
          .test(value.pluginUri));
}

function isTokenUsage(value: unknown): boolean {
  return isExactRecord(value, [
    'providerCallCount',
    'reportedCallCount',
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheMissInputTokens',
    'cacheAvailable',
    'cacheComplete',
    'cacheHitRatio',
  ])
    && isTokenUsageFields(value);
}

function isTokenUsageHistory(value: unknown): boolean {
  if (!isArrayOf(value, isTokenUsageRound)) return false;
  return value.every((round, index) => index === 0 || value[index - 1].sequence >= round.sequence);
}

function isTokenUsageRound(value: unknown): value is Record<string, unknown> & { sequence: number } {
  return isExactRecord(value, [
    'runId',
    'inputMessageId',
    'title',
    'sequence',
    'startedAt',
    'providerCallCount',
    'reportedCallCount',
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheMissInputTokens',
    'cacheAvailable',
    'cacheComplete',
    'cacheHitRatio',
  ], ['completedAt', 'outcome'])
    && isIdentifier(value.runId)
    && isIdentifier(value.inputMessageId)
    && isNonEmptyText(value.title)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.startedAt)
    && (value.completedAt === undefined || isNonEmptyText(value.completedAt))
    && (value.outcome === undefined
      || ['completed', 'failed', 'cancelled', 'indeterminate'].includes(String(value.outcome)))
    && isTokenUsageFields(value);
}

function isTokenUsageFields(value: Record<string, unknown>): boolean {
  if (!(isNaturalNumber(value.providerCallCount)
    && isNaturalNumber(value.reportedCallCount)
    && isNaturalNumber(value.inputTokens)
    && isNaturalNumber(value.outputTokens)
    && isNaturalNumber(value.cacheReadInputTokens)
    && isNaturalNumber(value.cacheMissInputTokens)
    && typeof value.cacheAvailable === 'boolean'
    && typeof value.cacheComplete === 'boolean'
    && isCacheHitRatio(value.cacheHitRatio)
    && value.reportedCallCount <= value.providerCallCount
    && Number.isSafeInteger(value.inputTokens + value.outputTokens)
    && Number.isSafeInteger(value.cacheReadInputTokens + value.cacheMissInputTokens)
    && value.cacheReadInputTokens + value.cacheMissInputTokens <= value.inputTokens)) {
    return false;
  }
  const expectedRatio = value.reportedCallCount > 0 && value.inputTokens > 0
    ? value.cacheReadInputTokens / value.inputTokens
    : null;
  return value.cacheAvailable === (value.reportedCallCount > 0)
    && value.cacheComplete === (
      value.providerCallCount > 0
      && value.reportedCallCount === value.providerCallCount
    )
    && (expectedRatio === null
      ? value.cacheHitRatio === null
      : typeof value.cacheHitRatio === 'number'
        && Math.abs(value.cacheHitRatio - expectedRatio) <= Number.EPSILON * 8);
}

function isCacheHitRatio(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function isRun(value: unknown): boolean {
  return isExactRecord(
    value,
    ['runId', 'profileId', 'workspaceBindings', 'status'],
    ['waitingReason', 'reasoningEffort', 'thinking'],
  )
    && isIdentifier(value.runId)
    && isIdentifier(value.profileId)
    && (value.reasoningEffort === undefined || isReasoningEffort(value.reasoningEffort))
    && (value.thinking === undefined || ['enabled', 'disabled'].includes(String(value.thinking)))
    && isWorkspaceBindings(value.workspaceBindings)
    && RUN_PROJECTION_STATUSES.includes(
      value.status as typeof RUN_PROJECTION_STATUSES[number],
    )
    && (value.waitingReason === undefined
      || ['approval', 'userInput', 'plan'].includes(String(value.waitingReason)));
}

function isReasoningEffort(value: unknown): boolean {
  return typeof value === 'string' && ['low', 'medium', 'high', 'max'].includes(value);
}

function isModelSettings(value: unknown): boolean {
  return isExactRecord(value, ['profileId', 'reasoningEffortOverride']) && isIdentifier(value.profileId)
    && (value.reasoningEffortOverride === null || isReasoningEffort(value.reasoningEffortOverride));
}

function isActivity(value: unknown): boolean {
  return isExactRecord(
    value,
    ['activityId', 'kind', 'status', 'label', 'runId', 'sequence'],
    ['callId', 'tool', 'providerHosted', 'inputRejection'],
  )
    && isIdentifier(value.activityId)
    && ['run', 'tool', 'providerHosted', 'approval', 'plan', 'interaction']
      .includes(String(value.kind))
    && ['active', 'requested', 'waiting', 'completed', 'denied', 'rejected', 'failed', 'cancelled', 'indeterminate']
      .includes(String(value.status))
    && isNonEmptyText(value.label)
    && isIdentifier(value.runId)
    && (value.callId === undefined || isIdentifier(value.callId))
    && isNaturalNumber(value.sequence)
    && (value.tool === undefined || isToolActivity(value.tool, String(value.status)))
    && (value.providerHosted === undefined || isProviderHostedActivity(value.providerHosted))
    && (value.kind === 'tool'
      ? value.status === 'rejected' ? value.tool === undefined && isInputRejection(value.inputRejection) : value.status === 'requested' || value.tool !== undefined
      : value.tool === undefined)
    && (value.status === 'rejected' && value.kind === 'tool') === (value.inputRejection !== undefined)
    && (value.kind === 'providerHosted') === (value.providerHosted !== undefined);
}

function isInputRejection(value: unknown): boolean {
  return isExactRecord(value, ['code', 'message', 'issues'])
    && isNonEmptyText(value.code) && isNonEmptyText(value.message)
    && Array.isArray(value.issues) && value.issues.length > 0
    && value.issues.every((issue) => isExactRecord(issue, ['path', 'rule', 'message'], ['expected'])
      && isNonEmptyText(issue.path) && isNonEmptyText(issue.rule) && isNonEmptyText(issue.message));
}

function isProviderHostedActivity(value: unknown): boolean {
  return isExactRecord(value, ['providerToolType', 'providerCallId', 'action'])
    && value.providerToolType === 'web_search'
    && isIdentifier(value.providerCallId)
    && isRecord(value.action);
}

function isToolActivity(value: unknown, activityStatus: string): boolean {
  return isExactRecord(value, ['operation', 'resources'], ['shell'])
    && isNonEmptyText(value.operation)
    && isArrayOf(value.resources, isActivityResource)
    && (value.operation === 'bash'
      ? isShellActivity(value.shell, activityStatus)
      : value.shell === undefined);
}

function isShellActivity(value: unknown, activityStatus: string): boolean {
  const resultValid = isRecord(value) && value.result !== undefined
    ? isShellActivityResult(value.result)
    : false;
  const resultMatchesShell = !isRecord(value) || value.result === undefined || (
    isRecord(value.result)
    && isRecord(value.result.environment)
    && value.result.environment.executionScope === value.executionScope
    && value.result.environment.terminal === value.terminal
  );
  return isExactRecord(value, ['command', 'cwd', 'executionScope', 'terminal'], ['result'])
    && isNonEmptyText(value.command)
    && isNonEmptyText(value.cwd)
    && (value.executionScope === 'workspace' || value.executionScope === 'host')
    && typeof value.terminal === 'boolean'
    && resultMatchesShell
    && (activityStatus === 'completed'
      ? resultValid
      : activityStatus === 'failed'
        ? value.result === undefined || resultValid
        : value.result === undefined);
}

function isActivityResource(value: unknown): boolean {
  return isExactRecord(value, ['kind', 'label'], ['workspaceId', 'logicalPath', 'uri'])
    && ['workspacePath', 'url', 'logicalTarget'].includes(String(value.kind))
    && isNonEmptyText(value.label)
    && (value.workspaceId === undefined || isIdentifier(value.workspaceId))
    && (value.logicalPath === undefined || isNonEmptyText(value.logicalPath))
    && (value.uri === undefined || isNonEmptyText(value.uri));
}

function isArtifact(value: unknown): boolean {
  return isExactRecord(value, ['artifactId', 'label'], ['workspaceId', 'logicalPath', 'uri'])
    && isIdentifier(value.artifactId)
    && isNonEmptyText(value.label)
    && (value.workspaceId === undefined || isIdentifier(value.workspaceId))
    && (value.logicalPath === undefined || isNonEmptyText(value.logicalPath))
    && (value.uri === undefined || isNonEmptyText(value.uri));
}

function isLocalAgentError(value: unknown): boolean {
  return isExactRecord(value, ['code', 'message'])
    && isIdentifier(value.code)
    && isNonEmptyText(value.message);
}

function isNullable(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return value === null || predicate(value);
}

function isArrayOf<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T[];
function isArrayOf(value: unknown, predicate: (candidate: unknown) => boolean): value is unknown[];
function isArrayOf(value: unknown, predicate: (candidate: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.every(predicate);
}

function isExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNaturalNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveNaturalNumber(value: unknown): value is number {
  return isNaturalNumber(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
