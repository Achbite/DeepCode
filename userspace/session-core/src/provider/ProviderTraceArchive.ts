import { stableHash } from '../cache/canonicalizer.js';

const PRIVATE_PROVIDER_CONTROL_MARKERS = [
  '<｜end▁of▁thinking｜>',
  '<session-continuation-language>',
  '</session-continuation-language>',
] as const;

const PRIVATE_PROVIDER_ANALYSIS_KEYS = new Set([
  'reasoning',
  'reasoningcontent',
  'reasoningdelta',
  'providerreasoning',
  'providerreasoningdelta',
  'hiddenreasoning',
  'rawprovider',
]);

export interface ProviderTraceArchiveRecord {
  schemaVersion: 'deepcode.session.provider-trace-archive.v1';
  traceArchiveMode: 'compact';
  stage: string;
  kind: 'request' | 'response' | 'generic';
  request?: {
    profileId?: string;
    semanticProfileId?: string;
    messageMaterialScope?: string;
    exactAdmittedMessagesAvailable?: boolean;
    messageCount: number;
    totalContentChars: number;
    messages: ProviderTraceMessageDigest[];
    responseFormat?: unknown;
    toolCount: number;
    tools?: ProviderTraceToolDefinitionDigest[];
    cacheTopology?: unknown;
  };
  response?: {
    requestId?: string;
    parentRequestId?: string;
    attemptKind?: string;
    usage?: unknown;
    assistantMessage?: ProviderTraceMessageDigest;
    chunkSummary: ProviderTraceChunkSummary;
    toolCalls: ProviderTraceToolCallDigest[];
  };
  payload?: unknown;
  cachePlan?: unknown;
  contextAssembly?: unknown;
  providerTurnSnapshot?: unknown;
  hookTrace?: unknown;
}

export interface ProviderTraceToolDefinitionDigest {
  index: number;
  name?: string;
  descriptionHash?: string;
  parameterHash?: string;
}

export interface ProviderTraceMessageDigest {
  index?: number;
  role?: string;
  contentCharLength: number;
  contentHash: string;
  contentPreview: string;
  contentProviderControlRedacted?: boolean;
  reasoningCharLength?: number;
  reasoningHash?: string;
  toolCallCount?: number;
  toolCalls?: ProviderTraceToolCallDigest[];
  toolCallId?: string;
}

export interface ProviderTraceToolCallDigest {
  index?: number;
  id?: string;
  name?: string;
  argumentsCharLength: number;
  argumentsHash: string;
  argumentsPreview: string;
  argumentsProviderControlRedacted?: boolean;
}

export interface ProviderTraceChunkSummary {
  chunkCount: number;
  byType: Record<string, number>;
  contentCharLength: number;
  reasoningCharLength: number;
  toolCallDeltaCharLength: number;
  toolCallDeltaCount: number;
  rawProviderCount: number;
  rawProviderCharLength: number;
  usageChunkCount: number;
  finishReasons: string[];
}

export class ProviderTraceArchive {
  static archivePayload(stage: string, payload: unknown): ProviderTraceArchiveRecord {
    const record = objectRecord(payload);
    if (record && (Array.isArray(record.messages) || record.contextAssembly || record.cachePlan)) {
      const messages = Array.isArray(record.messages) ? record.messages : [];
      const messageDigests = messages.map((message, index) => providerTraceMessageDigest(message, index));
      return {
        schemaVersion: 'deepcode.session.provider-trace-archive.v1',
        traceArchiveMode: 'compact',
        stage,
        kind: 'request',
        request: {
          profileId: stringValue(record.profileId),
          semanticProfileId: stringValue(record.semanticProfileId),
          messageMaterialScope: stringValue(record.messageMaterialScope),
          exactAdmittedMessagesAvailable: booleanValue(record.exactAdmittedMessagesAvailable),
          messageCount: messages.length,
          totalContentChars: messageDigests.reduce((sum, item) => sum + item.contentCharLength, 0),
          messages: messageDigests,
          responseFormat: compactArchiveValue(record.responseFormat),
          toolCount: Array.isArray(record.tools) ? record.tools.length : 0,
          tools: providerTraceToolDefinitions(record.tools),
          cacheTopology: compactArchiveValue(record.cacheTopology),
        },
        cachePlan: compactArchiveValue(record.cachePlan),
        contextAssembly: compactArchiveValue(record.contextAssembly),
        providerTurnSnapshot: compactArchiveValue(record.providerTurnSnapshot),
        hookTrace: compactArchiveValue(record.hookTrace),
      };
    }

    if (record && (Array.isArray(record.chunks) || record.assistantMessage || record.usage)) {
      const chunks = Array.isArray(record.chunks) ? record.chunks : [];
      return {
        schemaVersion: 'deepcode.session.provider-trace-archive.v1',
        traceArchiveMode: 'compact',
        stage,
        kind: 'response',
        response: {
          requestId: stringValue(record.requestId),
          parentRequestId: stringValue(record.parentRequestId),
          attemptKind: stringValue(record.attemptKind),
          usage: compactArchiveValue(record.usage),
          assistantMessage: record.assistantMessage ? providerTraceMessageDigest(record.assistantMessage) : undefined,
          chunkSummary: providerTraceChunkSummary(chunks),
          toolCalls: providerTraceAssistantToolCalls(record.assistantMessage),
        },
      };
    }

    return {
      schemaVersion: 'deepcode.session.provider-trace-archive.v1',
      traceArchiveMode: 'compact',
      stage,
      kind: 'generic',
      payload: compactArchiveValue(payload),
    };
  }
}

function providerTraceMessageDigest(value: unknown, index?: number): ProviderTraceMessageDigest {
  const record = objectRecord(value);
  const content = stringValue(record?.content) ?? compactString(record?.content);
  const reasoning = stringValue(record?.reasoningContent) ?? stringValue(record?.reasoning_content);
  const toolCalls = providerTraceAssistantToolCalls(value);
  const contentContainsProviderControl = containsPrivateProviderControl(content);
  return {
    ...(typeof index === 'number' ? { index } : {}),
    role: stringValue(record?.role),
    contentCharLength: content.length,
    contentHash: stableHash(content),
    contentPreview: contentContainsProviderControl
      ? '[private-provider-control-redacted]'
      : clip(content, 800),
    ...(contentContainsProviderControl
      ? { contentProviderControlRedacted: true }
      : {}),
    ...(reasoning
      ? {
        reasoningCharLength: reasoning.length,
        reasoningHash: stableHash(reasoning),
      }
      : {}),
    ...(toolCalls.length
      ? {
        toolCallCount: toolCalls.length,
        toolCalls,
      }
      : {}),
    ...(stringValue(record?.toolCallId) ? { toolCallId: stringValue(record?.toolCallId) } : {}),
  };
}

function providerTraceAssistantToolCalls(value: unknown): ProviderTraceToolCallDigest[] {
  const record = objectRecord(value);
  const calls = Array.isArray(record?.toolCalls)
    ? record.toolCalls
    : Array.isArray(record?.tool_calls)
      ? record.tool_calls
      : [];
  return calls.map((call, index) => providerTraceToolCallDigest(call, index));
}

function providerTraceToolCallDigest(value: unknown, index?: number): ProviderTraceToolCallDigest {
  const record = objectRecord(value);
  const functionRecord = objectRecord(record?.function);
  const name = stringValue(record?.name) ?? stringValue(functionRecord?.name);
  const rawArguments = record?.arguments ?? functionRecord?.arguments;
  const argumentsText = typeof rawArguments === 'string' ? rawArguments : compactString(rawArguments);
  const argumentsContainProviderControl = containsPrivateProviderControl(argumentsText);
  return {
    ...(typeof index === 'number' ? { index } : {}),
    id: stringValue(record?.id),
    name,
    argumentsCharLength: argumentsText.length,
    argumentsHash: stableHash(argumentsText),
    argumentsPreview: argumentsContainProviderControl
      ? '[private-provider-control-redacted]'
      : clip(argumentsText, 800),
    ...(argumentsContainProviderControl
      ? { argumentsProviderControlRedacted: true }
      : {}),
  };
}

function providerTraceToolDefinitions(value: unknown): ProviderTraceToolDefinitionDigest[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 64).map((tool, index) => {
    const record = objectRecord(tool);
    return {
      index,
      name: stringValue(record?.name),
      descriptionHash: stableHash(stringValue(record?.description) ?? ''),
      parameterHash: stableHash(compactString(record?.inputSchema ?? record?.parameters)),
    };
  });
}

function providerTraceChunkSummary(chunks: unknown[]): ProviderTraceChunkSummary {
  const summary: ProviderTraceChunkSummary = {
    chunkCount: chunks.length,
    byType: {},
    contentCharLength: 0,
    reasoningCharLength: 0,
    toolCallDeltaCharLength: 0,
    toolCallDeltaCount: 0,
    rawProviderCount: 0,
    rawProviderCharLength: 0,
    usageChunkCount: 0,
    finishReasons: [],
  };
  const finishReasons = new Set<string>();
  for (const chunk of chunks) {
    const record = objectRecord(chunk);
    const type = stringValue(record?.type) ?? 'unknown';
    summary.byType[type] = (summary.byType[type] ?? 0) + 1;
    if (type === 'delta') summary.contentCharLength += stringValue(record?.content)?.length ?? 0;
    if (type === 'reasoning_delta') summary.reasoningCharLength += stringValue(record?.content)?.length ?? 0;
    const toolCallDelta = objectRecord(record?.toolCallDelta);
    const argumentsDelta = stringValue(toolCallDelta?.argumentsDelta);
    if (argumentsDelta) {
      summary.toolCallDeltaCount += 1;
      summary.toolCallDeltaCharLength += argumentsDelta.length;
    }
    if (record?.rawProvider !== undefined) {
      summary.rawProviderCount += 1;
      summary.rawProviderCharLength += compactString(record.rawProvider).length;
    }
    if (record?.usage !== undefined) summary.usageChunkCount += 1;
    const finishReason = stringValue(record?.finishReason);
    if (finishReason) finishReasons.add(finishReason);
  }
  summary.finishReasons = [...finishReasons].sort();
  return summary;
}

function compactArchiveValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return clip(value, 4000);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 80).map((item) => compactArchiveValue(item, depth + 1));
    if (value.length > 80) items.push({ omittedItems: value.length - 80 });
    return items;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isPrivateProviderAnalysisKey(key)) {
      const material = compactString(item);
      output[key] = {
        redacted: 'private-provider-analysis',
        charLength: material.length,
        contentHash: stableHash(material),
      };
    } else if (isSensitiveKey(key)) {
      output[key] = '[redacted]';
    } else if (key === 'messages' && Array.isArray(item)) {
      output[key] = item.map((message, index) => providerTraceMessageDigest(message, index));
    } else if (key === 'chunks' && Array.isArray(item)) {
      output[key] = providerTraceChunkSummary(item);
    } else if ((key === 'assistantMessage' || key === 'assistant_message') && item && typeof item === 'object') {
      output[key] = providerTraceMessageDigest(item);
    } else if (depth >= 8) {
      output[key] = compactString(item);
    } else {
      output[key] = compactArchiveValue(item, depth + 1);
    }
  }
  return output;
}

function isPrivateProviderAnalysisKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return PRIVATE_PROVIDER_ANALYSIS_KEYS.has(normalized);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return ['secret', 'apikey', 'api_key', 'authorization', 'password', 'bearer', 'credential', 'cookie', 'token']
    .some((needle) => normalized.includes(needle));
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}... [truncated]`;
}

function compactString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function containsPrivateProviderControl(value: string): boolean {
  return PRIVATE_PROVIDER_CONTROL_MARKERS.some((marker) => value.includes(marker));
}
