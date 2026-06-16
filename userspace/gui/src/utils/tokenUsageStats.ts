import type { AgentEvent, AgentTimelineTokenUsageProjection } from '@deepcode/protocol';

export interface TokenUsageRequestStats {
  id: string;
  title: string;
  startedAt?: string;
  providerIds: string[];
  stages: string[];
  providerCallCount: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cachedTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  hasCacheData: boolean;
  hasTokenData: boolean;
}

export interface TokenUsageStats {
  requestCount: number;
  providerCallCount: number;
  providerIds: string[];
  requests: TokenUsageRequestStats[];
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cachedTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  hasCacheData: boolean;
  hasTokenData: boolean;
}

export function deriveTokenUsageStats(
  events: AgentEvent[],
  tokenUsageProjection?: AgentTimelineTokenUsageProjection | null
): TokenUsageStats {
  if (tokenUsageProjection) {
    return statsFromTokenUsageProjection(tokenUsageProjection);
  }

  const requests: TokenUsageRequestStats[] = [];
  let currentRequest: MutableRequestStats | null = null;

  for (const event of events) {
    if (event.kind === 'user_msg') {
      finalizeRequest(currentRequest, requests);
      currentRequest = createRequestStats(event, requests.length + 1);
      continue;
    }

    if (event.kind !== 'cache_telemetry' || !isRecord(event.payload)) continue;
    if (!currentRequest) {
      currentRequest = createSyntheticRequestStats(event, requests.length + 1);
    }

    addTelemetry(currentRequest, event.payload);
  }

  finalizeRequest(currentRequest, requests);

  const promptCacheHitTokens = sumRequests(requests, 'promptCacheHitTokens');
  const promptCacheMissTokens = sumRequests(requests, 'promptCacheMissTokens');
  const cachedTokens = sumRequests(requests, 'cachedTokens');
  const promptTokens = sumRequests(requests, 'promptTokens');
  const completionTokens = sumRequests(requests, 'completionTokens');
  const totalTokens = sumRequests(requests, 'totalTokens');
  const providerIds = Array.from(new Set(requests.flatMap((request) => request.providerIds)));
  const providerCallCount = requests.reduce((total, request) => total + request.providerCallCount, 0);

  const measuredPromptTokens = promptCacheHitTokens + promptCacheMissTokens;
  const effectivePromptTokens = promptTokens > 0 ? promptTokens : measuredPromptTokens;
  const effectiveTotalTokens = totalTokens > 0 ? totalTokens : effectivePromptTokens + completionTokens;

  const cacheDenominator = measuredPromptTokens > 0 ? measuredPromptTokens : effectivePromptTokens;
  const cacheNumerator = promptCacheHitTokens > 0 ? promptCacheHitTokens : cachedTokens;
  const cacheHitRate = cacheDenominator > 0 ? cacheNumerator / cacheDenominator : null;

  return {
    requestCount: requests.length,
    providerCallCount,
    providerIds,
    requests,
    promptCacheHitTokens,
    promptCacheMissTokens,
    cachedTokens,
    promptTokens: effectivePromptTokens,
    completionTokens,
    totalTokens: effectiveTotalTokens,
    cacheHitRate,
    hasCacheData: cacheHitRate !== null,
    hasTokenData: effectiveTotalTokens > 0 || effectivePromptTokens > 0 || completionTokens > 0,
  };
}

function statsFromTokenUsageProjection(projection: AgentTimelineTokenUsageProjection): TokenUsageStats {
  const requests = projection.requests.map((request): TokenUsageRequestStats => ({
    id: request.requestId,
    title: request.title,
    startedAt: request.startedAt,
    providerIds: request.providers,
    stages: request.stages,
    providerCallCount: request.providerCallCount,
    promptCacheHitTokens: request.promptCacheHitTokens,
    promptCacheMissTokens: request.promptCacheMissTokens,
    cachedTokens: request.cachedTokens,
    promptTokens: request.promptTokens,
    completionTokens: request.completionTokens,
    totalTokens: request.totalTokens,
    cacheHitRate: request.cacheHitRate,
    hasCacheData: request.cacheHitRate !== null,
    hasTokenData: request.totalTokens > 0 || request.promptTokens > 0 || request.completionTokens > 0,
  }));

  const totals = projection.totals;
  return {
    requestCount: requests.length,
    providerCallCount: totals.providerCallCount,
    providerIds: totals.providers,
    requests,
    promptCacheHitTokens: totals.promptCacheHitTokens,
    promptCacheMissTokens: totals.promptCacheMissTokens,
    cachedTokens: totals.cachedTokens,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
    cacheHitRate: totals.cacheHitRate,
    hasCacheData: totals.cacheHitRate !== null,
    hasTokenData: totals.totalTokens > 0 || totals.promptTokens > 0 || totals.completionTokens > 0,
  };
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return `${Math.round(value * 100)}%`;
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

type TokenNumberField =
  | 'promptCacheHitTokens'
  | 'promptCacheMissTokens'
  | 'cachedTokens'
  | 'promptTokens'
  | 'completionTokens'
  | 'totalTokens';

interface MutableRequestStats {
  id: string;
  title: string;
  startedAt?: string;
  providerIds: Set<string>;
  stages: Set<string>;
  providerCallCount: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cachedTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function createRequestStats(event: AgentEvent, index: number): MutableRequestStats {
  return {
    id: event.id || `request-${index}`,
    title: requestTitle(event.payload, index),
    startedAt: event.ts,
    providerIds: new Set(),
    stages: new Set(),
    providerCallCount: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cachedTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function createSyntheticRequestStats(event: AgentEvent, index: number): MutableRequestStats {
  const request = createRequestStats(event, index);
  request.id = `request-${index}`;
  request.title = `Request ${index}`;
  return request;
}

function addTelemetry(request: MutableRequestStats, payload: Record<string, unknown>): void {
  request.providerCallCount += 1;
  const provider = stringField(payload, 'provider');
  const stage = stringField(payload, 'stage');
  if (provider) request.providerIds.add(provider);
  if (stage) request.stages.add(stage);
  request.promptCacheHitTokens += numberField(payload, 'promptCacheHitTokens') ?? 0;
  request.promptCacheMissTokens += numberField(payload, 'promptCacheMissTokens') ?? 0;
  request.cachedTokens += numberField(payload, 'cachedTokens') ?? 0;
  request.promptTokens += numberField(payload, 'promptTokens') ?? 0;
  request.completionTokens += numberField(payload, 'completionTokens') ?? 0;
  request.totalTokens += numberField(payload, 'totalTokens') ?? 0;
}

function finalizeRequest(
  request: MutableRequestStats | null,
  requests: TokenUsageRequestStats[]
): void {
  if (!request) return;
  const measuredPromptTokens = request.promptCacheHitTokens + request.promptCacheMissTokens;
  const promptTokens = request.promptTokens > 0 ? request.promptTokens : measuredPromptTokens;
  const totalTokens = request.totalTokens > 0 ? request.totalTokens : promptTokens + request.completionTokens;
  const cacheDenominator = measuredPromptTokens > 0 ? measuredPromptTokens : promptTokens;
  const cacheNumerator = request.promptCacheHitTokens > 0 ? request.promptCacheHitTokens : request.cachedTokens;
  const cacheHitRate = cacheDenominator > 0 ? cacheNumerator / cacheDenominator : null;
  const hasTokenData = totalTokens > 0 || promptTokens > 0 || request.completionTokens > 0;
  if (!hasTokenData && cacheHitRate === null) return;

  requests.push({
    id: request.id,
    title: request.title,
    startedAt: request.startedAt,
    providerIds: Array.from(request.providerIds),
    stages: Array.from(request.stages),
    providerCallCount: request.providerCallCount,
    promptCacheHitTokens: request.promptCacheHitTokens,
    promptCacheMissTokens: request.promptCacheMissTokens,
    cachedTokens: request.cachedTokens,
    promptTokens,
    completionTokens: request.completionTokens,
    totalTokens,
    cacheHitRate,
    hasCacheData: cacheHitRate !== null,
    hasTokenData,
  });
}

function sumRequests(requests: TokenUsageRequestStats[], key: TokenNumberField): number {
  return requests.reduce((total, request) => total + request[key], 0);
}

function requestTitle(payload: unknown, index: number): string {
  const text = isRecord(payload)
    ? stringField(payload, 'content') ?? stringField(payload, 'message') ?? stringField(payload, 'summary')
    : typeof payload === 'string'
      ? payload
      : undefined;
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return `Request ${index}`;
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim().length > 0 ? field : undefined;
}
