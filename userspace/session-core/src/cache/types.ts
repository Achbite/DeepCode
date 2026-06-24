export type ProviderCacheTelemetryKind = 'deepseek' | 'openai' | 'anthropic' | 'ollama' | 'none';

export interface ProviderCacheTelemetry {
  provider: ProviderCacheTelemetryKind | string;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  cachedTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheHit?: boolean;
  cacheMissReason?: 'cold_start' | 'version_mismatch' | 'ttl_expired' | 'key_changed' | 'provider_unavailable';
}

export interface ProviderCacheChangedPartition {
  name: string;
  previousHash?: string;
  currentHash: string;
  charDelta?: number;
  reason: 'initial_or_no_previous_record' | 'stable_policy_changed' | 'project_archive_changed' | 'session_state_changed' | 'evidence_tail_changed' | 'audit_only_changed';
}

export interface ProviderCacheAttribution {
  provider: ProviderCacheTelemetryKind | string;
  model: string;
  providerCacheMode: 'automatic-prefix-cache' | 'provider-managed' | 'not-supported' | 'unknown';
  requestShapeHash: string;
  stableMessageHash: string;
  dynamicMessageHash: string;
  cacheEligiblePrefixCharLength: number;
  cacheEligiblePrefixTokenEstimate: number;
  changedPartitions: ProviderCacheChangedPartition[];
}

export interface CacheCorrectnessBoundary {
  cacheAffectsCorrectness: false;
  note: 'cache only affects cost latency and telemetry';
}

export const CACHE_CORRECTNESS_BOUNDARY: CacheCorrectnessBoundary = {
  cacheAffectsCorrectness: false,
  note: 'cache only affects cost latency and telemetry',
};
