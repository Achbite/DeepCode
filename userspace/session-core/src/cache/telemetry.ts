import type { ProviderCacheTelemetry } from './types.js';

export interface CacheTelemetryEvent {
  kind: 'cache.lookup' | 'cache.hit' | 'cache.miss';
  cacheKey: string;
  provider: string;
  reason?: ProviderCacheTelemetry['cacheMissReason'];
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  cachedTokens?: number;
}

export function providerTelemetryFromUsage(input: {
  provider: string;
  usage?: Record<string, unknown>;
  cacheHit?: boolean;
  cacheMissReason?: ProviderCacheTelemetry['cacheMissReason'];
}): ProviderCacheTelemetry {
  return {
    provider: input.provider,
    promptCacheHitTokens: numberField(input.usage, 'prompt_cache_hit_tokens'),
    promptCacheMissTokens: numberField(input.usage, 'prompt_cache_miss_tokens'),
    cachedTokens: numberField(input.usage, 'cached_tokens'),
    cacheHit: input.cacheHit,
    cacheMissReason: input.cacheMissReason,
  };
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
