import type { ProviderCacheTelemetry } from './types.js';

export interface CacheTelemetryEvent {
  kind: 'cache.lookup' | 'cache.hit' | 'cache.miss';
  cacheKey: string;
  provider: string;
  reason?: ProviderCacheTelemetry['cacheMissReason'];
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  cachedTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export function providerTelemetryFromUsage(input: {
  provider: string;
  usage?: Record<string, unknown>;
  cacheHit?: boolean;
  cacheMissReason?: ProviderCacheTelemetry['cacheMissReason'];
}): ProviderCacheTelemetry {
  const cachedTokens = numberField(input.usage, 'cached_tokens')
    ?? numberPath(input.usage, ['prompt_tokens_details', 'cached_tokens'])
    ?? numberPath(input.usage, ['input_tokens_details', 'cached_tokens']);
  const promptTokens = numberField(input.usage, 'prompt_tokens') ?? numberField(input.usage, 'input_tokens');
  const completionTokens = numberField(input.usage, 'completion_tokens') ?? numberField(input.usage, 'output_tokens');
  const promptCacheHitTokens = numberField(input.usage, 'prompt_cache_hit_tokens')
    ?? numberField(input.usage, 'cache_read_input_tokens')
    ?? cachedTokens;
  return {
    provider: input.provider,
    promptCacheHitTokens,
    promptCacheMissTokens: numberField(input.usage, 'prompt_cache_miss_tokens')
      ?? numberField(input.usage, 'cache_creation_input_tokens')
      ?? (promptTokens !== undefined && promptCacheHitTokens !== undefined
        ? Math.max(0, promptTokens - promptCacheHitTokens)
        : undefined),
    cachedTokens,
    promptTokens,
    completionTokens,
    totalTokens: numberField(input.usage, 'total_tokens')
      ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined),
    cacheHit: input.cacheHit,
    cacheMissReason: input.cacheMissReason,
  };
}

function numberPath(value: Record<string, unknown> | undefined, path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
