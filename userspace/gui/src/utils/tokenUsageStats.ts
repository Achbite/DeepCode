import type { AgentTimelineTokenUsageProjection } from '@deepcode/protocol';

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
  tokenUsageProjection?: AgentTimelineTokenUsageProjection | null
): TokenUsageStats {
  if (tokenUsageProjection) {
    return statsFromTokenUsageProjection(tokenUsageProjection);
  }
  return {
    requestCount: 0,
    providerCallCount: 0,
    providerIds: [],
    requests: [],
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cachedTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitRate: null,
    hasCacheData: false,
    hasTokenData: false,
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
