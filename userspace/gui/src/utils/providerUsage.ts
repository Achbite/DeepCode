export interface ProviderInputCacheUsage {
  inputTokens: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
}

export interface AggregateProviderInputCacheUsage extends ProviderInputCacheUsage {
  providerCallCount: number;
  cacheReportedCallCount: number;
}

export interface InputCacheMetric {
  inputTokens: number;
  hitTokens: number;
  missTokens: number;
  hitPercent: number;
}

export function inputCacheMetric(
  usage: ProviderInputCacheUsage | null | undefined,
): InputCacheMetric | null {
  if (
    !usage
    || usage.inputTokens <= 0
    || usage.cacheReadInputTokens === undefined
    || usage.cacheMissInputTokens === undefined
  ) {
    return null;
  }
  return {
    inputTokens: usage.inputTokens,
    hitTokens: usage.cacheReadInputTokens,
    missTokens: usage.cacheMissInputTokens,
    hitPercent: (usage.cacheReadInputTokens / usage.inputTokens) * 100,
  };
}

export function completeInputCacheMetric(
  usage: AggregateProviderInputCacheUsage | null | undefined,
): InputCacheMetric | null {
  if (
    !usage
    || usage.providerCallCount <= 0
    || usage.cacheReportedCallCount !== usage.providerCallCount
  ) {
    return null;
  }
  return inputCacheMetric(usage);
}
