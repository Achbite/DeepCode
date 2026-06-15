import type { AgentEvent } from '@deepcode/protocol';

export interface TokenUsageStats {
  requestCount: number;
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

export function deriveTokenUsageStats(events: AgentEvent[]): TokenUsageStats {
  let requestCount = 0;
  let promptCacheHitTokens = 0;
  let promptCacheMissTokens = 0;
  let cachedTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  for (const event of events) {
    if (event.kind !== 'cache_telemetry' || !isRecord(event.payload)) continue;
    requestCount += 1;
    promptCacheHitTokens += numberField(event.payload, 'promptCacheHitTokens') ?? 0;
    promptCacheMissTokens += numberField(event.payload, 'promptCacheMissTokens') ?? 0;
    cachedTokens += numberField(event.payload, 'cachedTokens') ?? 0;
    promptTokens += numberField(event.payload, 'promptTokens') ?? 0;
    completionTokens += numberField(event.payload, 'completionTokens') ?? 0;
    totalTokens += numberField(event.payload, 'totalTokens') ?? 0;
  }

  const measuredPromptTokens = promptCacheHitTokens + promptCacheMissTokens;
  if (promptTokens <= 0) promptTokens = measuredPromptTokens;
  if (totalTokens <= 0) totalTokens = promptTokens + completionTokens;

  const cacheDenominator = measuredPromptTokens > 0 ? measuredPromptTokens : promptTokens;
  const cacheNumerator = promptCacheHitTokens > 0 ? promptCacheHitTokens : cachedTokens;
  const cacheHitRate = cacheDenominator > 0 ? cacheNumerator / cacheDenominator : null;

  return {
    requestCount,
    promptCacheHitTokens,
    promptCacheMissTokens,
    cachedTokens,
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitRate,
    hasCacheData: cacheHitRate !== null,
    hasTokenData: totalTokens > 0 || promptTokens > 0 || completionTokens > 0,
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
