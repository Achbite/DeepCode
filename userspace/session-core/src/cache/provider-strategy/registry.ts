export type ProviderSemanticMode = 'openai' | 'deepseek-openai' | 'anthropic-native' | 'anthropic-openai-compat' | 'ollama' | 'none';

export interface ProviderCacheStrategyInput {
  provider: string;
  model: string;
  prefixHash: string;
  requestBody: Record<string, unknown>;
}

export interface ProviderCacheStrategyResult {
  semanticMode: ProviderSemanticMode;
  requestBody: Record<string, unknown>;
  serverPromptCacheSupported: boolean;
}

export function applyProviderCacheStrategy(input: ProviderCacheStrategyInput): ProviderCacheStrategyResult {
  const provider = input.provider.toLowerCase();
  if (provider.includes('deepseek')) {
    return {
      semanticMode: 'deepseek-openai',
      requestBody: { ...input.requestBody },
      serverPromptCacheSupported: true,
    };
  }
  if (provider.includes('openai')) {
    return {
      semanticMode: 'openai',
      requestBody: { ...input.requestBody },
      serverPromptCacheSupported: true,
    };
  }
  if (provider.includes('anthropic-native')) {
    return {
      semanticMode: 'anthropic-native',
      requestBody: { ...input.requestBody },
      serverPromptCacheSupported: true,
    };
  }
  if (provider.includes('anthropic')) {
    return {
      semanticMode: 'anthropic-openai-compat',
      requestBody: { ...input.requestBody },
      serverPromptCacheSupported: false,
    };
  }
  if (provider.includes('ollama')) {
    return {
      semanticMode: 'ollama',
      requestBody: { ...input.requestBody, keep_alive: '30m' },
      serverPromptCacheSupported: false,
    };
  }
  return {
    semanticMode: 'none',
    requestBody: { ...input.requestBody },
    serverPromptCacheSupported: false,
  };
}
