import type {
  LlmChatMessage,
  SessionTurnAuthorityPayload,
  ToolCall,
} from '@deepcode/protocol';
import { stableHash } from '../cache/canonicalizer.js';
import type { UserAuthorityFrame } from '../driver/context/userAuthorityFrame.js';

export type PromptLedgerEntryKind =
  | 'system'
  | 'toolCatalogSnapshot'
  | 'turnAuthority'
  | 'rootUser'
  | 'workspaceBootstrap'
  | 'requestDelta'
  | 'explicitUser'
  | 'memoryDelta'
  | 'workflowDelta'
  | 'resourceDelta'
  | 'repairDelta'
  | 'assistantSemanticTool'
  | 'sessionToolResult';

export interface PromptLedgerEntry {
  readonly entryId: string;
  readonly kind: PromptLedgerEntryKind;
  readonly contentHash: string;
  readonly message: LlmChatMessage;
  readonly sourceRef?: string;
}

export interface PromptLedgerEpoch {
  readonly epochId: string;
  readonly profileId: string;
  readonly epochScopeKey: string;
  readonly taskTemplateHash?: string;
  readonly workspaceScopeKey: string;
  readonly systemHash: string;
  readonly toolsHash: string;
  readonly rootUserHash: string;
  memoryHash?: string;
  readonly entries: PromptLedgerEntry[];
  readonly explicitUserMessageIds: string[];
  readonly createdAt: string;
  compactionLevel: 'none' | 'toolResults' | 'epochSummary' | 'converge';
}

export interface PromptLedgerState {
  readonly schemaVersion: 'deepcode.session.prompt-ledger.v2';
  epochs: PromptLedgerEpoch[];
  activeEpochByScope: Record<string, string>;
}

export interface PromptLedgerBudget {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyTokens: number;
  readonly availableInputTokens: number;
  readonly estimatedInputTokens: number;
  readonly occupancyRatio: number;
  readonly threshold: 'below50' | 'soft50' | 'compact60' | 'newEpoch80' | 'converge90';
}

export interface PromptLedgerPrepareResult {
  readonly state: PromptLedgerState;
  readonly epoch: PromptLedgerEpoch;
  readonly messages: LlmChatMessage[];
  readonly budget: PromptLedgerBudget;
  readonly cacheShapeReason: string;
}

export interface PromptLedgerWireRecord {
  readonly schemaVersion: 'deepcode.session.wire-ledger.v1';
  readonly recordId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly profileId: string;
  readonly semanticProfileId?: string;
  readonly epochId: string;
  readonly epochScopeKey?: string;
  readonly taskTemplateHash?: string;
  readonly workspaceScopeKey?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly sourceMessageHashes?: string[];
  readonly authorityHash?: string;
  readonly kind: 'providerRequest' | 'assistantSemanticTool' | 'sessionToolResult';
  readonly timestamp: string;
  readonly messages?: LlmChatMessage[];
  readonly toolCall?: ToolCall;
  readonly toolResult?: { toolCallId: string; content: string };
  readonly systemHash?: string;
  readonly toolsHash?: string;
  readonly messageHash?: string;
  readonly schemaHash?: string;
  readonly responseFormatHash?: string;
  readonly promptSegmentDigests?: PromptLedgerSegmentDigest[];
  readonly ledgerEntries?: Array<Pick<PromptLedgerEntry, 'entryId' | 'kind' | 'contentHash' | 'sourceRef'>>;
}

export interface PromptLedgerSegmentDigest {
  readonly id: string;
  readonly contentHash: string;
}

export interface ProviderRequestCacheHistoryEntry {
  readonly requestText?: string;
  readonly messages?: LlmChatMessage[];
  readonly toolSchemaHash?: string;
  readonly responseFormatHash?: string;
  readonly segments: PromptLedgerSegmentDigest[];
}

export function emptyPromptLedgerState(): PromptLedgerState {
  return {
    schemaVersion: 'deepcode.session.prompt-ledger.v2',
    epochs: [],
    activeEpochByScope: {},
  };
}

export class PromptLedgerCompatibilityError extends Error {
  readonly code = 'session_task_prompt_epoch_incompatible';
}

export function restorePromptLedger(records: readonly PromptLedgerWireRecord[]): PromptLedgerState {
  const state = emptyPromptLedgerState();
  const latestRequestByEpoch = new Map<string, PromptLedgerWireRecord>();
  for (const record of records) {
    if (record.kind === 'providerRequest' && record.messages?.length) {
      latestRequestByEpoch.set(record.epochId, record);
    }
  }
  for (const record of latestRequestByEpoch.values()) {
    if (!record.epochScopeKey?.trim()) {
      throw new PromptLedgerCompatibilityError(
        `PromptLedger record ${record.recordId} has no task-scoped epoch metadata.`
      );
    }
    const messages = record.messages ?? [];
    const systemMessage = messages.find((message) => message.role === 'system');
    const rootUserIndex = record.ledgerEntries?.findIndex((entry) => entry.kind === 'rootUser') ?? -1;
    const rootUser = rootUserIndex >= 0
      ? messages[rootUserIndex]
      : messages.find((message) => message.role === 'user');
    if (!systemMessage || !rootUser) continue;
    const entries = messages.map((message, index): PromptLedgerEntry => {
      const stored = record.ledgerEntries?.[index];
      return {
        entryId: stored?.entryId ?? `${record.epochId}-restored-${index + 1}`,
        kind: stored?.kind ?? restoredEntryKind(message, index),
        contentHash: stored?.contentHash ?? stableHash(messageSignature(message)),
        message: cloneMessage(message),
        sourceRef: stored?.sourceRef ?? message.toolCalls?.[0]?.id ?? message.toolCallId,
      };
    });
    const ledgerProfileId = record.semanticProfileId ?? record.profileId;
    const epoch: PromptLedgerEpoch = {
      epochId: record.epochId,
      profileId: ledgerProfileId,
      epochScopeKey: record.epochScopeKey,
      taskTemplateHash: record.taskTemplateHash,
      workspaceScopeKey: record.workspaceScopeKey ?? 'unbound-workspace',
      systemHash: record.systemHash ?? stableHash(systemMessage.content),
      toolsHash: record.toolsHash ?? '',
      rootUserHash: stableHash(rootUser.content),
      entries,
      explicitUserMessageIds: entries
        .filter((entry) => entry.kind === 'rootUser' || entry.kind === 'explicitUser')
        .flatMap((entry) => entry.sourceRef ? [entry.sourceRef] : []),
      createdAt: record.timestamp,
      compactionLevel: 'none',
    };
    state.epochs.push(epoch);
    state.activeEpochByScope[activeEpochKey(ledgerProfileId, record.epochScopeKey)] = record.epochId;
  }
  for (const record of records) {
    if (record.kind === 'providerRequest') continue;
    const epoch = state.epochs.find((candidate) => candidate.epochId === record.epochId);
    if (!epoch) continue;
    if (record.kind === 'assistantSemanticTool' && record.toolCall) {
      const message: LlmChatMessage = {
        role: 'assistant',
        content: '',
        toolCalls: [structuredCloneValue(record.toolCall)],
      };
      if (!epoch.entries.some((entry) => entry.sourceRef === record.toolCall?.id && entry.kind === 'assistantSemanticTool')) {
        epoch.entries.push({
          entryId: record.recordId,
          kind: 'assistantSemanticTool',
          contentHash: record.messageHash ?? stableHash(messageSignature(message)),
          message,
          sourceRef: record.toolCall.id,
        });
      }
    }
    if (record.kind === 'sessionToolResult' && record.toolResult) {
      const entryKind: PromptLedgerEntryKind = isSerializedResourceDelta(record.toolResult.content)
        ? 'resourceDelta'
        : 'sessionToolResult';
      const message: LlmChatMessage = {
        role: 'tool',
        content: record.toolResult.content,
        toolCallId: record.toolResult.toolCallId,
      };
      if (!epoch.entries.some((entry) => entry.sourceRef === record.toolResult?.toolCallId && (entry.kind === 'sessionToolResult' || entry.kind === 'resourceDelta'))) {
        epoch.entries.push({
          entryId: record.recordId,
          kind: entryKind,
          contentHash: record.messageHash ?? stableHash(messageSignature(message)),
          message,
          sourceRef: record.toolResult.toolCallId,
        });
      }
    }
  }
  state.epochs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return state;
}

export function restoreProviderRequestCacheHistory(
  records: readonly PromptLedgerWireRecord[]
): Record<string, ProviderRequestCacheHistoryEntry> {
  const history: Record<string, ProviderRequestCacheHistoryEntry> = {};
  for (const record of records) {
    if (record.kind !== 'providerRequest' || !record.messages?.length) continue;
    history[record.semanticProfileId ?? record.profileId] = {
      messages: record.messages.map(cloneMessage),
      toolSchemaHash: record.schemaHash ?? record.toolsHash,
      responseFormatHash: record.responseFormatHash,
      segments: (record.promptSegmentDigests ?? []).map((segment) => ({ ...segment })),
    };
  }
  return history;
}

export function preparePromptLedger(input: {
  state?: PromptLedgerState;
  profileId: string;
  epochScopeKey: string;
  taskTemplateHash?: string;
  workspaceScopeKey: string;
  systemContent: string;
  toolsHash: string;
  authority: UserAuthorityFrame;
  requestFrame: string;
  toolCatalogSnapshot?: string;
  workspaceBootstrap?: string;
  memorySnapshot?: unknown;
  workflowDelta?: string;
  repairDelta?: string;
  now: string;
  createId(prefix: string): string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}): PromptLedgerPrepareResult {
  const state = input.state ?? emptyPromptLedgerState();
  const systemHash = stableHash(input.systemContent);
  const currentRoot = input.authority.currentMessages[0] ?? input.authority.rootMessage;
  const rootUserHash = stableHash(currentRoot.content);
  const toolsHash = input.toolsHash;
  const memoryHash = input.memorySnapshot === undefined
    ? undefined
    : stableHash(serializeSnapshot(input.memorySnapshot));
  const active = activeEpoch(state, input.profileId, input.epochScopeKey);
  const priorProfileEpoch = [...state.epochs]
    .reverse()
    .find((epoch) => epoch.profileId === input.profileId);
  const activeOccupancy = active
    ? promptLedgerBudget(
      providerPromptEntries(active).map((entry) => entry.message),
      input.contextWindowTokens,
      input.maxOutputTokens
    ).occupancyRatio
    : 0;
  const shouldRotate = !active
    || active.workspaceScopeKey !== input.workspaceScopeKey
    || active.systemHash !== systemHash
    || active.toolsHash !== toolsHash
    || activeOccupancy >= 0.8;
  const cacheShapeReason = !active
    ? priorProfileEpoch && input.profileId === 'execution-v1'
      ? 'acceptedTaskChanged'
      : 'newProfileEpoch'
    : active.workspaceScopeKey !== input.workspaceScopeKey
      ? 'workspaceScopeChanged'
      : active.systemHash !== systemHash
      ? 'stableSystemChanged'
      : active.toolsHash !== toolsHash
        ? 'toolSchemaChanged'
        : shouldRotate
            ? 'contextOccupancyReached80Percent'
            : 'appendOnlyReuse';
  const epoch = shouldRotate
    ? createEpoch(input, systemHash, toolsHash, rootUserHash, memoryHash)
    : active;
  if (shouldRotate) {
    state.epochs.push(epoch);
    state.activeEpochByScope[activeEpochKey(input.profileId, input.epochScopeKey)] = epoch.epochId;
  } else {
    appendMemoryDelta(epoch, memoryHash, input.memorySnapshot, input.createId);
  }
  appendCurrentTurn(epoch, input.authority, input.createId);
  appendUnique(epoch, 'requestDelta', input.requestFrame, input.createId('prompt-request-delta'));
  appendUnique(epoch, 'workflowDelta', input.workflowDelta ?? '', input.createId('prompt-workflow-delta'));
  appendUnique(epoch, 'repairDelta', input.repairDelta ?? '', input.createId('prompt-repair-delta'));

  let messages = providerPromptEntries(epoch).map((entry) => cloneMessage(entry.message));
  let budget = promptLedgerBudget(messages, input.contextWindowTokens, input.maxOutputTokens);
  if (!shouldRotate && (budget.threshold === 'newEpoch80' || budget.threshold === 'converge90')) {
    epoch.compactionLevel = budget.threshold === 'converge90' ? 'converge' : 'epochSummary';
    const rotated = createEpoch(input, systemHash, toolsHash, rootUserHash, memoryHash);
    appendCurrentTurn(rotated, input.authority, input.createId);
    appendUnique(rotated, 'requestDelta', input.requestFrame, input.createId('prompt-request-delta'));
    appendUnique(rotated, 'workflowDelta', input.workflowDelta ?? '', input.createId('prompt-workflow-delta'));
    appendUnique(rotated, 'repairDelta', input.repairDelta ?? '', input.createId('prompt-repair-delta'));
    rotated.compactionLevel = 'epochSummary';
    state.epochs.push(rotated);
    state.activeEpochByScope[activeEpochKey(input.profileId, input.epochScopeKey)] = rotated.epochId;
    messages = providerPromptEntries(rotated).map((entry) => cloneMessage(entry.message));
    budget = promptLedgerBudget(messages, input.contextWindowTokens, input.maxOutputTokens);
    return {
      state,
      epoch: rotated,
      messages: budget.threshold === 'compact60' ? compactOldToolResults(messages) : messages,
      budget,
      cacheShapeReason: 'contextOccupancyReached80Percent',
    };
  }
  if (budget.threshold === 'compact60') {
    messages = compactOldToolResults(messages);
    epoch.compactionLevel = 'toolResults';
    budget = promptLedgerBudget(messages, input.contextWindowTokens, input.maxOutputTokens);
  }
  if (budget.threshold === 'converge90') epoch.compactionLevel = 'converge';
  else if (shouldRotate && cacheShapeReason === 'contextOccupancyReached80Percent') {
    epoch.compactionLevel = 'epochSummary';
  }
  return { state, epoch, messages, budget, cacheShapeReason };
}

export function appendPromptLedgerSemanticExchange(input: {
  state: PromptLedgerState;
  epochId: string;
  toolCall: ToolCall;
  result: unknown;
  createId(prefix: string): string;
}): PromptLedgerEpoch | undefined {
  const epoch = input.state.epochs.find((candidate) => candidate.epochId === input.epochId);
  if (!epoch) return undefined;
  const assistantMessage: LlmChatMessage = {
    role: 'assistant',
    content: '',
    toolCalls: [structuredCloneValue(input.toolCall)],
  };
  appendMessage(epoch, {
    entryId: input.createId('prompt-assistant-tool'),
    kind: 'assistantSemanticTool',
    contentHash: stableHash(messageSignature(assistantMessage)),
    message: assistantMessage,
    sourceRef: input.toolCall.id,
  });
  const resultContent = JSON.stringify(input.result);
  const toolMessage: LlmChatMessage = {
    role: 'tool',
    content: resultContent,
    toolCallId: input.toolCall.id,
  };
  appendMessage(epoch, {
    entryId: input.createId('prompt-tool-result'),
    kind: isResourceDelta(input.result) ? 'resourceDelta' : 'sessionToolResult',
    contentHash: stableHash(messageSignature(toolMessage)),
    message: toolMessage,
    sourceRef: input.toolCall.id,
  });
  return epoch;
}

export function appendPromptLedgerCurrentTurn(input: {
  state: PromptLedgerState;
  epochId: string;
  authority: UserAuthorityFrame;
  createId(prefix: string): string;
}): PromptLedgerEpoch | undefined {
  const epoch = input.state.epochs.find((candidate) => candidate.epochId === input.epochId);
  if (!epoch) return undefined;
  appendCurrentTurn(epoch, input.authority, input.createId);
  return epoch;
}

export function promptLedgerBudget(
  messages: readonly LlmChatMessage[],
  contextWindowTokens = 1_000_000,
  maxOutputTokens = 384_000
): PromptLedgerBudget {
  const reservedOutputTokens = Math.min(384_000, Math.max(1, maxOutputTokens));
  const safetyTokens = Math.max(8_192, Math.ceil(contextWindowTokens * 0.02));
  const availableInputTokens = Math.max(1, contextWindowTokens - reservedOutputTokens - safetyTokens);
  const estimatedInputTokens = estimateTokens(JSON.stringify(messages));
  const occupancyRatio = estimatedInputTokens / availableInputTokens;
  const threshold = occupancyRatio >= 0.9
    ? 'converge90'
    : occupancyRatio >= 0.8
      ? 'newEpoch80'
      : occupancyRatio >= 0.6
        ? 'compact60'
        : occupancyRatio >= 0.5
          ? 'soft50'
          : 'below50';
  return {
    contextWindowTokens,
    maxOutputTokens,
    reservedOutputTokens,
    safetyTokens,
    availableInputTokens,
    estimatedInputTokens,
    occupancyRatio,
    threshold,
  };
}

export function promptLedgerAuthorityFits(
  authority: UserAuthorityFrame,
  budget: PromptLedgerBudget
): boolean {
  const authorityTokens = estimateTokens(JSON.stringify(
    authority.currentMessages.map((message) => message.content)
  ));
  return authorityTokens <= budget.availableInputTokens;
}

export function promptLedgerWireRequest(input: {
  recordId: string;
  sessionId: string;
  runId: string;
  profileId: string;
  semanticProfileId?: string;
  epoch: PromptLedgerEpoch;
  messages: LlmChatMessage[];
  timestamp: string;
  schemaHash?: string;
  responseFormatHash?: string;
  promptSegmentDigests?: PromptLedgerSegmentDigest[];
  turnAuthority?: SessionTurnAuthorityPayload;
}): PromptLedgerWireRecord {
  const projectedEntries = providerPromptEntries(input.epoch);
  return {
    schemaVersion: 'deepcode.session.wire-ledger.v1',
    recordId: input.recordId,
    sessionId: input.sessionId,
    runId: input.runId,
    profileId: input.profileId,
    semanticProfileId: input.semanticProfileId,
    epochId: input.epoch.epochId,
    epochScopeKey: input.epoch.epochScopeKey,
    taskTemplateHash: input.epoch.taskTemplateHash,
    workspaceScopeKey: input.epoch.workspaceScopeKey,
    turnId: input.turnAuthority?.turnId,
    taskId: input.turnAuthority?.taskId,
    sourceMessageHashes: input.turnAuthority?.sourceMessageHashes,
    authorityHash: input.turnAuthority?.authorityHash,
    kind: 'providerRequest',
    timestamp: input.timestamp,
    messages: input.messages.map(cloneMessage),
    systemHash: input.epoch.systemHash,
    toolsHash: input.epoch.toolsHash,
    messageHash: stableHash(JSON.stringify(input.messages)),
    schemaHash: input.schemaHash,
    responseFormatHash: input.responseFormatHash,
    promptSegmentDigests: input.promptSegmentDigests?.map((segment) => ({ ...segment })),
    ledgerEntries: input.messages.map((message, index) => {
      const entry = projectedEntries[index];
      return entry ? {
        entryId: entry.entryId,
        kind: entry.kind,
        contentHash: entry.contentHash,
        sourceRef: entry.sourceRef,
      } : {
        entryId: `${input.recordId}-message-${index + 1}`,
        kind: restoredEntryKind(message, index),
        contentHash: stableHash(messageSignature(message)),
        sourceRef: message.toolCalls?.[0]?.id ?? message.toolCallId,
      };
    }),
  };
}

export function promptLedgerEpoch(
  state: PromptLedgerState,
  epochId: string | undefined
): PromptLedgerEpoch | undefined {
  return epochId ? state.epochs.find((epoch) => epoch.epochId === epochId) : undefined;
}

export function promptLedgerWireSemanticExchange(input: {
  sessionId: string;
  runId: string;
  profileId: string;
  epoch: PromptLedgerEpoch;
  toolCall: ToolCall;
  result: unknown;
  timestamp: string;
  createId(prefix: string): string;
}): PromptLedgerWireRecord[] {
  const resultContent = JSON.stringify(input.result);
  return [
    {
      schemaVersion: 'deepcode.session.wire-ledger.v1',
      recordId: input.createId('wire-assistant-tool'),
      sessionId: input.sessionId,
      runId: input.runId,
      profileId: input.profileId,
      epochId: input.epoch.epochId,
      epochScopeKey: input.epoch.epochScopeKey,
      taskTemplateHash: input.epoch.taskTemplateHash,
      workspaceScopeKey: input.epoch.workspaceScopeKey,
      kind: 'assistantSemanticTool',
      timestamp: input.timestamp,
      toolCall: structuredCloneValue(input.toolCall),
      messageHash: stableHash(JSON.stringify(input.toolCall)),
      systemHash: input.epoch.systemHash,
      toolsHash: input.epoch.toolsHash,
    },
    {
      schemaVersion: 'deepcode.session.wire-ledger.v1',
      recordId: input.createId('wire-tool-result'),
      sessionId: input.sessionId,
      runId: input.runId,
      profileId: input.profileId,
      epochId: input.epoch.epochId,
      epochScopeKey: input.epoch.epochScopeKey,
      taskTemplateHash: input.epoch.taskTemplateHash,
      workspaceScopeKey: input.epoch.workspaceScopeKey,
      kind: 'sessionToolResult',
      timestamp: input.timestamp,
      toolResult: { toolCallId: input.toolCall.id, content: resultContent },
      messageHash: stableHash(resultContent),
      systemHash: input.epoch.systemHash,
      toolsHash: input.epoch.toolsHash,
    },
  ];
}

function createEpoch(
  input: Parameters<typeof preparePromptLedger>[0],
  systemHash: string,
  toolsHash: string,
  rootUserHash: string,
  memoryHash: string | undefined
): PromptLedgerEpoch {
  const epochId = input.createId('prompt-epoch');
  const entries: PromptLedgerEntry[] = [{
    entryId: input.createId('prompt-system'),
    kind: 'system',
    contentHash: systemHash,
    message: { role: 'system', content: input.systemContent },
  }];
  if (input.toolCatalogSnapshot?.trim()) {
    entries.push({
      entryId: input.createId('prompt-tool-catalog'),
      kind: 'toolCatalogSnapshot',
      contentHash: stableHash(input.toolCatalogSnapshot),
      message: { role: 'system', content: input.toolCatalogSnapshot },
    });
  }
  if (input.workspaceBootstrap?.trim()) {
    entries.push({
      entryId: input.createId('prompt-workspace-bootstrap'),
      kind: 'workspaceBootstrap',
      contentHash: stableHash(input.workspaceBootstrap),
      message: { role: 'user', content: input.workspaceBootstrap },
    });
  }
  if (input.memorySnapshot !== undefined) {
    entries.push({
      entryId: input.createId('prompt-memory-epoch'),
      kind: 'memoryDelta',
      contentHash: memoryHash ?? stableHash('null'),
      message: {
        role: 'user',
        content: `SessionMemoryEpochSnapshot:\n${serializeSnapshot(input.memorySnapshot)}`,
      },
    });
  }
  return {
    epochId,
    profileId: input.profileId,
    epochScopeKey: input.epochScopeKey,
    taskTemplateHash: input.taskTemplateHash,
    workspaceScopeKey: input.workspaceScopeKey,
    systemHash,
    toolsHash,
    rootUserHash,
    memoryHash,
    entries,
    explicitUserMessageIds: [],
    createdAt: input.now,
    compactionLevel: 'none',
  };
}

function isResourceDelta(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { schemaVersion?: unknown }).schemaVersion === 'deepcode.session.resource-delta.v1'
  );
}

function isSerializedResourceDelta(value: string): boolean {
  try {
    return isResourceDelta(JSON.parse(value));
  } catch {
    return false;
  }
}

function appendMemoryDelta(
  epoch: PromptLedgerEpoch,
  memoryHash: string | undefined,
  memorySnapshot: unknown,
  createId: (prefix: string) => string
): void {
  if (!memoryHash || memoryHash === epoch.memoryHash) return;
  appendUnique(
    epoch,
    'memoryDelta',
    `SessionMemoryDelta: hash=${memoryHash}\n${serializeSnapshot(memorySnapshot)}`,
    createId('prompt-memory-delta')
  );
  epoch.memoryHash = memoryHash;
}

function serializeSnapshot(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function appendCurrentTurn(
  epoch: PromptLedgerEpoch,
  authority: UserAuthorityFrame,
  createId: (prefix: string) => string
): void {
  if (!epoch.entries.some((entry) => (
    entry.kind === 'turnAuthority' && entry.sourceRef === authority.turnAuthority.turnId
  ))) {
    const content = JSON.stringify({
      kind: 'CurrentTurnAuthority',
      turnId: authority.turnAuthority.turnId,
      taskId: authority.turnAuthority.taskId,
      relation: authority.turnAuthority.relation,
      sourceMessageIds: authority.turnAuthority.sourceMessageIds,
      sourceMessageHashes: authority.turnAuthority.sourceMessageHashes,
      outputLanguage: authority.turnAuthority.outputLanguage,
      authorityHash: authority.turnAuthority.authorityHash,
    });
    epoch.entries.push({
      entryId: createId('prompt-turn-authority'),
      kind: 'turnAuthority',
      contentHash: stableHash(content),
      message: { role: 'user', content },
      sourceRef: authority.turnAuthority.turnId,
    });
  }
  const seen = new Set(epoch.explicitUserMessageIds);
  for (const message of authority.currentMessages) {
    if (seen.has(message.messageId)) continue;
    const kind: PromptLedgerEntryKind = epoch.explicitUserMessageIds.length === 0
      ? 'rootUser'
      : 'explicitUser';
    epoch.entries.push({
      entryId: createId('prompt-explicit-user'),
      kind,
      contentHash: stableHash(message.content),
      message: { role: 'user', content: message.content },
      sourceRef: message.messageId,
    });
    epoch.explicitUserMessageIds.push(message.messageId);
    seen.add(message.messageId);
  }
}

function appendUnique(
  epoch: PromptLedgerEpoch,
  kind: PromptLedgerEntryKind,
  content: string,
  entryId: string
): void {
  if (!content.trim()) return;
  const contentHash = stableHash(content);
  const previous = [...epoch.entries].reverse().find((entry) => entry.kind === kind);
  if (previous?.contentHash === contentHash) return;
  appendMessage(epoch, {
    entryId,
    kind,
    contentHash,
    message: { role: 'user', content },
  });
}

function appendMessage(epoch: PromptLedgerEpoch, entry: PromptLedgerEntry): void {
  epoch.entries.push(entry);
}

function providerPromptEntries(epoch: PromptLedgerEpoch): PromptLedgerEntry[] {
  return epoch.entries;
}

function activeEpoch(
  state: PromptLedgerState,
  profileId: string,
  epochScopeKey: string
): PromptLedgerEpoch | undefined {
  const epochId = state.activeEpochByScope[activeEpochKey(profileId, epochScopeKey)];
  return epochId ? state.epochs.find((epoch) => epoch.epochId === epochId) : undefined;
}

function activeEpochKey(profileId: string, epochScopeKey: string): string {
  return `${profileId}\u0000${epochScopeKey}`;
}

function compactOldToolResults(messages: readonly LlmChatMessage[]): LlmChatMessage[] {
  const toolIndexes = messages
    .map((message, index) => message.role === 'tool' ? index : -1)
    .filter((index) => index >= 0);
  const keep = new Set(toolIndexes.slice(-4));
  return messages.map((message, index) => {
    if (message.role !== 'tool' || keep.has(index) || message.content.length <= 2048) {
      return cloneMessage(message);
    }
    const hash = stableHash(message.content);
    return {
      ...cloneMessage(message),
      content: JSON.stringify({
        status: 'compacted',
        contentHash: hash,
        originalBytes: utf8Length(message.content),
        summary: message.content.slice(0, 1024),
      }),
    };
  });
}

function restoredEntryKind(message: LlmChatMessage, index: number): PromptLedgerEntryKind {
  if (message.role === 'system') return 'system';
  if (message.role === 'assistant') return 'assistantSemanticTool';
  if (message.role === 'tool') return 'sessionToolResult';
  return index === 1 ? 'rootUser' : 'workflowDelta';
}

function messageSignature(message: LlmChatMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls ?? [],
    toolCallId: message.toolCallId,
  });
}

function cloneMessage(message: LlmChatMessage): LlmChatMessage {
  return structuredCloneValue(message);
}

function structuredCloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function estimateTokens(value: string): number {
  return Math.ceil(utf8Length(value) / 4);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
