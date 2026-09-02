export interface CanonicalProviderInputCacheUsage {
  providerCallCount: number;
  reportedCallCount: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheMissInputTokens: number;
  cacheAvailable: boolean;
  cacheComplete: boolean;
  cacheHitRatio: number | null;
}

export interface InputCacheMetric {
  inputTokens: number;
  hitTokens: number;
  missTokens: number;
  hitPercent: number;
  providerCallCount: number;
  reportedCallCount: number;
  complete: boolean;
}

export function inputCacheMetric(
  usage: CanonicalProviderInputCacheUsage | null | undefined,
): InputCacheMetric | null {
  if (!usage?.cacheAvailable || usage.cacheHitRatio === null) return null;
  const reportedInputTokens = usage.cacheReadInputTokens + usage.cacheMissInputTokens;
  return {
    inputTokens: reportedInputTokens,
    hitTokens: usage.cacheReadInputTokens,
    missTokens: usage.cacheMissInputTokens,
    hitPercent: usage.cacheHitRatio * 100,
    providerCallCount: usage.providerCallCount,
    reportedCallCount: usage.reportedCallCount,
    complete: usage.cacheComplete,
  };
}

export function completeInputCacheMetric(
  usage: CanonicalProviderInputCacheUsage | null | undefined,
): InputCacheMetric | null {
  const metric = inputCacheMetric(usage);
  return metric?.complete ? metric : null;
}
