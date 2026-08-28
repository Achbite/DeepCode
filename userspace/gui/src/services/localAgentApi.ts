import type {
  CommandReply,
  ConversationCatalog,
  ConversationCatalogManagement,
  ConversationCommand,
  SessionProjection,
} from '@deepcode/protocol';
import {
  COMMAND_REPLY_VERSION,
  SESSION_PROJECTION_VERSION,
} from '@deepcode/protocol';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T | null;
  error?: string | null;
  message?: string | null;
}

const API_BASE = getKernelApiBase();

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
      'workspaceBindings',
      'sessionDirectoryIndexes',
      'messages',
      'narratives',
      'assistantDraft',
      'pendingInteraction',
      'pendingApproval',
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
    || !isWorkspaceBindings(value.workspaceBindings)
    || !isWorkspaceBindings(value.sessionDirectoryIndexes)
    || !isArrayOf(value.messages, isProjectionMessage)
    || !isArrayOf(value.narratives, isNarrative)
    || !isNullable(value.assistantDraft, isAssistantDraft)
    || !isNullable(value.pendingInteraction, isInteraction)
    || !isNullable(value.pendingApproval, isApproval)
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
  return value as unknown as SessionProjection;
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
  return isExactRecord(value, ['title'], ['projectId'])
    && typeof value.title === 'string'
    && (value.projectId === undefined || isIdentifier(value.projectId));
}

function isProjectionMessage(value: unknown): boolean {
  return isExactRecord(value, [
    'messageId', 'role', 'content', 'attachments', 'feedback', 'sequence', 'createdAt',
  ])
    && isIdentifier(value.messageId)
    && ['user', 'assistant', 'tool', 'system'].includes(String(value.role))
    && typeof value.content === 'string'
    && isArrayOf(value.attachments, isMessageAttachment)
    && (value.feedback === null || ['up', 'down'].includes(String(value.feedback)))
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt);
}

function isMessageAttachment(value: unknown): boolean {
  return isExactRecord(value, ['attachmentId', 'name', 'mediaType', 'byteLength'])
    && isIdentifier(value.attachmentId)
    && isNonEmptyText(value.name)
    && isNonEmptyText(value.mediaType)
    && isNaturalNumber(value.byteLength);
}

function isNarrative(value: unknown): boolean {
  return isExactRecord(value, ['narrativeId', 'runId', 'content', 'sequence', 'createdAt'])
    && isIdentifier(value.narrativeId)
    && isIdentifier(value.runId)
    && isNonEmptyText(value.content)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt);
}

function isAssistantDraft(value: unknown): boolean {
  return isExactRecord(value, ['runId', 'turnId', 'content'])
    && isIdentifier(value.runId)
    && isIdentifier(value.turnId)
    && typeof value.content === 'string';
}

function isInteraction(value: unknown): boolean {
  return isExactRecord(
    value,
    ['kind', 'prompt', 'allowFreeform', 'interactionId', 'runId', 'sequence', 'createdAt'],
    ['options'],
  )
    && ['question', 'confirmation'].includes(String(value.kind))
    && isNonEmptyText(value.prompt)
    && typeof value.allowFreeform === 'boolean'
    && isIdentifier(value.interactionId)
    && isIdentifier(value.runId)
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
  const effects = ['workspaceRead', 'workspaceMutation', 'process', 'network', 'external'];
  return isExactRecord(value, ['summary', 'effects', 'logicalTargets'])
    && isNonEmptyText(value.summary)
    && Array.isArray(value.effects)
    && value.effects.every((effect) => effects.includes(String(effect)))
    && Array.isArray(value.logicalTargets)
    && value.logicalTargets.every(isNonEmptyText);
}

function isPendingPlan(value: unknown): boolean {
  return isExactRecord(value, [
    'planId',
    'runId',
    'prompt',
    'options',
    'responseMode',
    'ignoreAllowed',
    'sequence',
    'createdAt',
  ])
    && isIdentifier(value.planId)
    && isIdentifier(value.runId)
    && isNonEmptyText(value.prompt)
    && isArrayOf(value.options, isPlanOption)
    && value.options.length > 0
    && value.responseMode === 'optionOrFreeform'
    && value.ignoreAllowed === true
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt);
}

function isPlanOption(value: unknown): boolean {
  return isExactRecord(value, ['optionId', 'label', 'operationsDisplay'], ['description'])
    && isIdentifier(value.optionId)
    && isNonEmptyText(value.label)
    && (value.description === undefined || isNonEmptyText(value.description))
    && Array.isArray(value.operationsDisplay)
    && value.operationsDisplay.every(isNonEmptyText);
}

function isTodoList(value: unknown): boolean {
  if (
    !isExactRecord(value, ['runId', 'items', 'sequence', 'updatedAt'])
    || !isIdentifier(value.runId)
    || !isNaturalNumber(value.sequence)
    || !isNonEmptyText(value.updatedAt)
    || !isArrayOf(value.items, isTodoItem)
    || value.items.length > 12
  ) return false;
  return new Set(value.items.map((item) => item.todoId)).size === value.items.length;
}

function isTodoItem(value: unknown): value is Record<string, unknown> & { todoId: string } {
  return isExactRecord(value, ['todoId', 'label', 'status'])
    && isIdentifier(value.todoId)
    && isNonEmptyText(value.label)
    && ['pending', 'inProgress', 'completed'].includes(String(value.status));
}

function isContextUsage(value: unknown): boolean {
  if (!isExactRecord(
    value,
    [
      'providerRequestId',
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
      && value.cacheReadInputTokens + value.cacheMissInputTokens <= value.inputTokens
    ));
}

function isContextComposition(value: unknown): boolean {
  return isExactRecord(value, [
    'providerRequestId',
    'responseConstraint',
    'runId',
    'messages',
    'workspaceBindings',
    'tools',
    'partitions',
    'sequence',
    'createdAt',
  ])
    && isIdentifier(value.providerRequestId)
    && ['normal', 'answerOnly'].includes(String(value.responseConstraint))
    && isIdentifier(value.runId)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt)
    && Array.isArray(value.messages)
    && value.messages.every((message, index) => isContextMessage(message, index))
    && isArrayOf(value.workspaceBindings, isContextItem)
    && isArrayOf(value.tools, isContextItem)
    && contextPartitionsAreValid(value.partitions);
}

const CONTEXT_PARTITION_ORDER = [
  'instructions',
  'sessionControls',
  'tools',
  'workspaceBindings',
  'contextProviders',
  'journalMessages',
  'messageAttachments',
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
    'attachments',
  ])
    && value.messageIndex === messageIndex
    && isIdentifier(value.contributionId)
    && kinds.includes(String(value.contributionKind))
    && isNonEmptyText(value.label)
    && ['system', 'user', 'assistant', 'tool'].includes(String(value.role))
    && Array.isArray(value.blocks)
    && value.blocks.every((block, index) => isContextMessageBlock(block, index))
    && isArrayOf(value.attachments, isContextItem);
}

function isContextMessageBlock(value: unknown, blockIndex: number): boolean {
  if (!isRecord(value) || value.blockIndex !== blockIndex) return false;
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
  return false;
}

function isContextItem(value: unknown): boolean {
  return isExactRecord(value, ['itemId', 'label'])
    && isIdentifier(value.itemId)
    && isNonEmptyText(value.label);
}

function isTokenUsage(value: unknown): boolean {
  return isExactRecord(value, [
    'providerCallCount',
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheMissInputTokens',
    'cacheReportedCallCount',
  ])
    && isNaturalNumber(value.providerCallCount)
    && isNaturalNumber(value.inputTokens)
    && isNaturalNumber(value.outputTokens)
    && isNaturalNumber(value.cacheReadInputTokens)
    && isNaturalNumber(value.cacheMissInputTokens)
    && isNaturalNumber(value.cacheReportedCallCount)
    && value.cacheReportedCallCount <= value.providerCallCount;
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
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheMissInputTokens',
    'cacheReportedCallCount',
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
  return isNaturalNumber(value.providerCallCount)
    && isNaturalNumber(value.inputTokens)
    && isNaturalNumber(value.outputTokens)
    && isNaturalNumber(value.cacheReadInputTokens)
    && isNaturalNumber(value.cacheMissInputTokens)
    && isNaturalNumber(value.cacheReportedCallCount)
    && value.cacheReportedCallCount <= value.providerCallCount;
}

function isRun(value: unknown): boolean {
  return isExactRecord(value, ['runId', 'workspaceBindings', 'status'], ['profileId', 'waitingReason'])
    && isIdentifier(value.runId)
    && isWorkspaceBindings(value.workspaceBindings)
    && ['running', 'waiting', 'completed', 'failed', 'cancelled', 'indeterminate']
      .includes(String(value.status))
    && (value.profileId === undefined || isIdentifier(value.profileId))
    && (value.waitingReason === undefined
      || ['approval', 'userInput', 'plan'].includes(String(value.waitingReason)));
}

function isActivity(value: unknown): boolean {
  return isExactRecord(
    value,
    ['activityId', 'kind', 'status', 'label', 'runId', 'sequence'],
    ['callId', 'tool'],
  )
    && isIdentifier(value.activityId)
    && ['run', 'tool', 'approval', 'plan', 'interaction'].includes(String(value.kind))
    && ['active', 'requested', 'waiting', 'completed', 'denied', 'failed', 'cancelled', 'indeterminate']
      .includes(String(value.status))
    && isNonEmptyText(value.label)
    && isIdentifier(value.runId)
    && (value.callId === undefined || isIdentifier(value.callId))
    && isNaturalNumber(value.sequence)
    && (value.tool === undefined || isToolActivity(value.tool));
}

function isToolActivity(value: unknown): boolean {
  return isExactRecord(value, ['operation', 'resources'])
    && isNonEmptyText(value.operation)
    && isArrayOf(value.resources, isActivityResource);
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
