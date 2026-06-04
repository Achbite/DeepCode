export type ProviderCacheTelemetryKind = 'deepseek' | 'openai' | 'anthropic' | 'ollama' | 'none';

export interface ProviderCacheTelemetry {
  provider: ProviderCacheTelemetryKind | string;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  cachedTokens?: number;
  cacheHit?: boolean;
  cacheMissReason?: 'cold_start' | 'version_mismatch' | 'ttl_expired' | 'key_changed' | 'provider_unavailable';
}

export interface CacheCorrectnessBoundary {
  cacheAffectsCorrectness: false;
  note: 'cache only affects cost latency and telemetry';
}

export const CACHE_CORRECTNESS_BOUNDARY: CacheCorrectnessBoundary = {
  cacheAffectsCorrectness: false,
  note: 'cache only affects cost latency and telemetry',
};
