export interface LocalL2CacheEntry<T = unknown> {
  cacheKey: string;
  response: T;
  createdAtMs: number;
  expiresAtMs: number;
  hitCount: number;
  modelId: string;
  templateVersion: string;
}

export interface LocalL2CacheLookup<T = unknown> {
  hit: boolean;
  entry?: LocalL2CacheEntry<T>;
  missReason?: 'cold_start' | 'ttl_expired' | 'version_mismatch';
}

export class LocalL2Cache<T = unknown> {
  private entries = new Map<string, LocalL2CacheEntry<T>>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  get(input: { cacheKey: string; templateVersion: string }): LocalL2CacheLookup<T> {
    const entry = this.entries.get(input.cacheKey);
    if (!entry) return { hit: false, missReason: 'cold_start' };
    if (entry.templateVersion !== input.templateVersion) return { hit: false, missReason: 'version_mismatch' };
    if (entry.expiresAtMs <= this.nowMs()) {
      this.entries.delete(input.cacheKey);
      return { hit: false, missReason: 'ttl_expired' };
    }
    entry.hitCount += 1;
    return { hit: true, entry };
  }

  set(input: {
    cacheKey: string;
    response: T;
    ttlMs: number;
    modelId: string;
    templateVersion: string;
  }): LocalL2CacheEntry<T> {
    const now = this.nowMs();
    const entry: LocalL2CacheEntry<T> = {
      cacheKey: input.cacheKey,
      response: input.response,
      createdAtMs: now,
      expiresAtMs: now + input.ttlMs,
      hitCount: 0,
      modelId: input.modelId,
      templateVersion: input.templateVersion,
    };
    this.entries.set(input.cacheKey, entry);
    return entry;
  }
}
