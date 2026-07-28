import type {
  LlmChatMessage,
  SessionTurnAuthorityPayload,
  ToolCall,
} from '@deepcode/protocol';
import {
  stripSessionOwnedConversationLanguageControls,
} from '../driver/context/conversationLanguagePolicy.js';
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
  | 'userGuidance'
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
  readonly parentRequestId?: string;
  readonly sourceRequestId?: string;
  readonly attemptKind?: string;
  readonly languageRevision?: number;
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
  readonly providerPayloadDigest?: string;
  readonly transportDigest?: string;
  readonly digestMaterialScope?: 'sessionAdmitted';
  readonly messageMaterialScope?: 'restorationBase';
  readonly exactExternalWireBody?: false;
  readonly stream?: boolean;
  readonly promptSegmentDigests?: PromptLedgerSegmentDigest[];
  readonly ledgerEntries?: Array<Pick<PromptLedgerEntry, 'entryId' | 'kind' | 'contentHash' | 'sourceRef'>>;
}

export interface PromptLedgerSegmentDigest {
  readonly id: string;
  readonly contentHash: string;
}

export interface ProviderRequestCacheHistoryEntry {
  readonly requestText?: string;
  readonly toolSchemaHash?: string;
  readonly responseFormatHash?: string;
  readonly exactMaterialAvailable?: boolean;
  readonly exactMaterialRedactionReason?: 'restoredAdmissionOnly' | 'privateReasoning';
  readonly disposition?: 'providerObserved' | 'restoredAdmissionOnly';
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
  const latestRequestByEpoch = new Map<
    string,
    { record: PromptLedgerWireRecord; recordIndex: number }
  >();
  for (const [recordIndex, record] of records.entries()) {
    if (record.kind === 'providerRequest' && record.messages?.length) {
      latestRequestByEpoch.set(record.epochId, { record, recordIndex });
    }
  }
  for (const { record } of latestRequestByEpoch.values()) {
    if (!record.epochScopeKey?.trim()) {
      throw new PromptLedgerCompatibilityError(
        `PromptLedger record ${record.recordId} has no task-scoped epoch metadata.`
      );
    }
    const messages = (record.messages ?? []).map(
      (message, index) => restoreWireLedgerMessage(record, message, index)
    );
    const systemMessage = messages.find((message) => message.role === 'system');
    const rootUserIndex = record.ledgerEntries?.findIndex((entry) => entry.kind === 'rootUser') ?? -1;
    const rootUser = rootUserIndex >= 0
      ? messages[rootUserIndex]
      : messages.find((message) => message.role === 'user');
    if (!systemMessage || !rootUser) continue;
    const entries = messages.map((message, index): PromptLedgerEntry => {
      const stored = record.ledgerEntries?.[index];
      const restoredControlFrame = record.messages?.[index]?.content !== message.content;
      return {
        entryId: stored?.entryId ?? `${record.epochId}-restored-${index + 1}`,
        kind: stored?.kind ?? restoredEntryKind(message, index),
        contentHash: restoredControlFrame
          ? stableHash(message.content)
          : stored?.contentHash ?? stableHash(messageSignature(message)),
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
      memoryHash: restoredPromptLedgerMemoryHash(entries),
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
  const pendingSemanticToolByEpoch = new Map<string, PromptLedgerWireRecord>();
  for (const [recordIndex, record] of records.entries()) {
    if (record.kind === 'providerRequest') continue;
    const restoreBoundary = latestRequestByEpoch.get(record.epochId);
    if (!restoreBoundary || recordIndex <= restoreBoundary.recordIndex) continue;
    const epoch = state.epochs.find((candidate) => candidate.epochId === record.epochId);
    if (!epoch) continue;
    if (record.kind === 'assistantSemanticTool') {
      if (record.sourceRequestId !== restoreBoundary.record.recordId) {
        throw new PromptLedgerCompatibilityError(
          `PromptLedger semantic tool record ${record.recordId} does not belong to the latest Provider request ${restoreBoundary.record.recordId}.`
        );
      }
      if (!record.toolCall?.id?.trim()) {
        throw new PromptLedgerCompatibilityError(
          `PromptLedger semantic tool record ${record.recordId} has no tool-call identity.`
        );
      }
      const pending = pendingSemanticToolByEpoch.get(record.epochId);
      if (pending) {
        throw new PromptLedgerCompatibilityError(
          `PromptLedger record ${record.recordId} follows unmatched semantic tool record ${pending.recordId}.`
        );
      }
      pendingSemanticToolByEpoch.set(record.epochId, record);
      continue;
    }
    if (record.kind === 'sessionToolResult') {
      if (record.sourceRequestId !== restoreBoundary.record.recordId) {
        throw new PromptLedgerCompatibilityError(
          `PromptLedger tool result ${record.recordId} does not belong to the latest Provider request ${restoreBoundary.record.recordId}.`
        );
      }
      if (!record.toolResult?.toolCallId?.trim()) {
        throw new PromptLedgerCompatibilityError(
          `PromptLedger tool result ${record.recordId} has no tool-call identity.`
        );
      }
      const pending = pendingSemanticToolByEpoch.get(record.epochId);
      const toolCall = pending?.toolCall;
      if (!pending || !toolCall || toolCall.id !== record.toolResult.toolCallId) {
        throw new PromptLedgerCompatibilityError(
          `PromptLedger tool result ${record.recordId} has no matching semantic tool record after the latest Provider request.`
        );
      }
      if (epoch.entries.some((entry) => entry.sourceRef === toolCall.id)) {
        throw new PromptLedgerCompatibilityError(
          `PromptLedger tool call ${toolCall.id} appears in both the latest Provider request and its post-request semantic records.`
        );
      }
      const assistantMessage: LlmChatMessage = {
        role: 'assistant',
        content: '',
        toolCalls: [structuredCloneValue(toolCall)],
      };
      epoch.entries.push({
        entryId: pending.recordId,
        kind: 'assistantSemanticTool',
        contentHash: pending.messageHash ?? stableHash(messageSignature(assistantMessage)),
        message: assistantMessage,
        sourceRef: toolCall.id,
      });
      const entryKind: PromptLedgerEntryKind = isSerializedResourceDelta(record.toolResult.content)
        ? 'resourceDelta'
        : 'sessionToolResult';
      const toolMessage: LlmChatMessage = {
        role: 'tool',
        content: record.toolResult.content,
        toolCallId: record.toolResult.toolCallId,
      };
      epoch.entries.push({
        entryId: record.recordId,
        kind: entryKind,
        contentHash: record.messageHash ?? stableHash(messageSignature(toolMessage)),
        message: toolMessage,
        sourceRef: record.toolResult.toolCallId,
      });
      pendingSemanticToolByEpoch.delete(record.epochId);
    }
  }
  const unmatched = pendingSemanticToolByEpoch.values().next().value;
  if (unmatched) {
    throw new PromptLedgerCompatibilityError(
      `PromptLedger semantic tool record ${unmatched.recordId} has no matching tool result after the latest Provider request.`
    );
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
    history[record.profileId] = {
      toolSchemaHash: record.schemaHash ?? record.toolsHash,
      responseFormatHash: record.responseFormatHash,
      // WireLedger deliberately removes raw reasoning. A restored request
      // therefore cannot support an exact physical-prefix comparison.
      exactMaterialAvailable: false,
      exactMaterialRedactionReason: 'restoredAdmissionOnly',
      disposition: 'restoredAdmissionOnly',
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
  priorUserGuidance?: readonly {
    id: string;
    content: string;
  }[];
  activeContinuationToolCallIds?: readonly string[];
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
  const activeContinuationToolCallIds = input.activeContinuationToolCallIds ?? [];
  const activeContinuationInEpoch = Boolean(
    active
    && activeContinuationToolCallIds.length > 0
    && activeContinuationToolCallIds.every((toolCallId) => hasToolExchange(active, toolCallId))
  );
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
    || (!activeContinuationInEpoch && activeOccupancy >= 0.8);
  const cacheShapeReason = !active
    ? priorProfileEpoch
      ? input.profileId === 'execution-v1'
        ? 'acceptedTaskChanged'
        : 'taskAuthorityChanged'
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
  } else if (!activeContinuationInEpoch) {
    appendMemoryDelta(epoch, memoryHash, input.memorySnapshot, input.createId);
  }
  if (!activeContinuationInEpoch) {
    appendGuidanceBatch(epoch, input.priorUserGuidance, input.createId);
    appendCurrentTurn(epoch, input.authority, input.createId);
    appendUnique(epoch, 'requestDelta', input.requestFrame, input.createId('prompt-request-delta'));
    appendUnique(epoch, 'workflowDelta', input.workflowDelta ?? '', input.createId('prompt-workflow-delta'));
    appendUnique(epoch, 'repairDelta', input.repairDelta ?? '', input.createId('prompt-repair-delta'));
  }

  let messages = providerPromptEntries(epoch).map((entry) => cloneMessage(entry.message));
  let budget = promptLedgerBudget(messages, input.contextWindowTokens, input.maxOutputTokens);
  if (
    !shouldRotate
    && !activeContinuationInEpoch
    && (budget.threshold === 'newEpoch80' || budget.threshold === 'converge90')
  ) {
    epoch.compactionLevel = budget.threshold === 'converge90' ? 'converge' : 'epochSummary';
    const rotated = createEpoch(input, systemHash, toolsHash, rootUserHash, memoryHash);
    appendGuidanceBatch(rotated, input.priorUserGuidance, input.createId);
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
  if (!activeContinuationInEpoch && budget.threshold === 'compact60') {
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

export function appendPromptLedgerGuidanceBatch(input: {
  state: PromptLedgerState;
  epochId: string;
  guidance: readonly {
    id: string;
    content: string;
  }[];
  createId(prefix: string): string;
}): PromptLedgerEpoch | undefined {
  const epoch = input.state.epochs.find((candidate) => candidate.epochId === input.epochId);
  if (!epoch) return undefined;
  appendGuidanceBatch(epoch, input.guidance, input.createId);
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
  parentRequestId?: string;
  attemptKind?: string;
  languageRevision?: number;
  sessionId: string;
  runId: string;
  profileId: string;
  semanticProfileId?: string;
  epoch: PromptLedgerEpoch;
  messages: LlmChatMessage[];
  timestamp: string;
  schemaHash?: string;
  responseFormatHash?: string;
  providerPayloadDigest?: string;
  transportDigest?: string;
  digestMaterialScope?: 'sessionAdmitted';
  messageMaterialScope?: 'restorationBase';
  exactExternalWireBody?: false;
  stream?: boolean;
  promptSegmentDigests?: PromptLedgerSegmentDigest[];
  turnAuthority?: SessionTurnAuthorityPayload;
}): PromptLedgerWireRecord {
  const projectedEntries = providerPromptEntries(input.epoch);
  const claimedEntryIds = new Set<string>();
  return {
    schemaVersion: 'deepcode.session.wire-ledger.v1',
    recordId: input.recordId,
    parentRequestId: input.parentRequestId,
    attemptKind: input.attemptKind,
    languageRevision: input.languageRevision,
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
    messages: input.messages.map(wireSafeMessage),
    systemHash: input.epoch.systemHash,
    toolsHash: input.epoch.toolsHash,
    messageHash: stableHash(JSON.stringify(input.messages.map(wireSafeMessage))),
    schemaHash: input.schemaHash,
    responseFormatHash: input.responseFormatHash,
    providerPayloadDigest: input.providerPayloadDigest,
    transportDigest: input.transportDigest,
    digestMaterialScope: input.digestMaterialScope,
    messageMaterialScope: input.messageMaterialScope,
    exactExternalWireBody: input.exactExternalWireBody,
    stream: input.stream,
    promptSegmentDigests: input.promptSegmentDigests?.map((segment) => ({ ...segment })),
    ledgerEntries: input.messages.map((message, index) => {
      const contentHash = stableHash(messageSignature(wireSafeMessage(message)));
      const entry = projectedEntries.find((candidate) => (
        !claimedEntryIds.has(candidate.entryId)
        && stableHash(messageSignature(wireSafeMessage(candidate.message))) === contentHash
      ));
      if (entry) claimedEntryIds.add(entry.entryId);
      return entry ? {
        entryId: entry.entryId,
        kind: entry.kind,
        contentHash: entry.contentHash,
        sourceRef: entry.sourceRef,
      } : {
        entryId: `${input.recordId}-message-${index + 1}`,
        kind: restoredEntryKind(message, index),
        contentHash,
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
  sourceRequestId: string;
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
      sourceRequestId: input.sourceRequestId,
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
      sourceRequestId: input.sourceRequestId,
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

function restoredPromptLedgerMemoryHash(
  entries: readonly PromptLedgerEntry[]
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'memoryDelta' || entry.message.role !== 'user') continue;
    const deltaMatch = /^SessionMemoryDelta: hash=([^\n]+)\n/.exec(entry.message.content);
    if (deltaMatch?.[1]) return deltaMatch[1];
    const epochPrefix = 'SessionMemoryEpochSnapshot:\n';
    if (entry.message.content.startsWith(epochPrefix)) {
      return stableHash(entry.message.content.slice(epochPrefix.length));
    }
  }
  return undefined;
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
      languagePolicy: authority.languagePolicy,
      effectiveLanguage: authority.effectiveLanguage,
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

function appendGuidanceBatch(
  epoch: PromptLedgerEpoch,
  guidance: readonly {
    id: string;
    content: string;
  }[] | undefined,
  createId: (prefix: string) => string
): void {
  if (!guidance?.length) return;
  const content = JSON.stringify({
    schemaVersion: 'deepcode.session.user-guidance-batch.v1',
    authority: 'user',
    languageSource: 'The later CurrentTurnAuthority message is the language source.',
    messages: guidance.map((item) => ({
      messageId: item.id,
      content: item.content,
    })),
  });
  const contentHash = stableHash(content);
  if (epoch.entries.some((entry) => (
    entry.kind === 'userGuidance' && entry.contentHash === contentHash
  ))) {
    return;
  }
  appendMessage(epoch, {
    entryId: createId('prompt-user-guidance-batch'),
    kind: 'userGuidance',
    contentHash,
    message: { role: 'user', content },
    sourceRef: stableHash(guidance.map((item) => item.id).join('\n')),
  });
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

function hasToolExchange(epoch: PromptLedgerEpoch, toolCallId: string): boolean {
  const assistantIndex = epoch.entries.findIndex((entry) => (
    entry.kind === 'assistantSemanticTool'
    && entry.sourceRef === toolCallId
    && entry.message.role === 'assistant'
    && entry.message.toolCalls?.some((toolCall) => toolCall.id === toolCallId)
  ));
  if (assistantIndex < 0) return false;
  const toolResult = epoch.entries[assistantIndex + 1];
  return Boolean(
    toolResult
    && (toolResult.kind === 'sessionToolResult' || toolResult.kind === 'resourceDelta')
    && toolResult.sourceRef === toolCallId
    && toolResult.message.role === 'tool'
    && toolResult.message.toolCallId === toolCallId
  );
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

function wireSafeMessage(message: LlmChatMessage): LlmChatMessage {
  const cloned = cloneMessage(message);
  delete cloned.reasoningContent;
  return cloned;
}

function restoreWireLedgerMessage(
  _record: PromptLedgerWireRecord,
  message: LlmChatMessage,
  _index: number
): LlmChatMessage {
  const cloned = cloneMessage(message);
  if (cloned.role !== 'user') return cloned;
  const baseContent = stripSessionOwnedConversationLanguageControls(cloned.content);
  return baseContent === cloned.content
    ? cloned
    : { ...cloned, content: baseContent };
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
