export type LlmProviderKind =
  | 'openaiCompatible'
  | 'responses'
  | 'anthropic'
  | 'ollama';

export type LlmProviderFlavor = 'openai' | 'deepseek' | 'zhipu' | 'moonshot';
export type LlmReasoningEffort = 'low' | 'medium' | 'high' | 'max';
export type LlmThinkingMode = 'enabled' | 'disabled';
export type LlmHostedWebSearch = 'web_search';

interface LlmProviderProfileFields {
  id: string;
  name: string;
  kind: LlmProviderKind;
  providerFlavor: LlmProviderFlavor;
  baseUrl?: string;
  model: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: LlmThinkingMode;
  hostedWebSearch?: LlmHostedWebSearch;
  secretRef?: string;
  enabled: boolean;
}

export type LlmProviderProfile = LlmProviderProfileFields;

export const DEEPSEEK_OPENAI_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
export const GLM_OPENAI_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const KIMI_OPENAI_BASE_URL = 'https://api.moonshot.ai/v1';

export const DEEPSEEK_LLM_MODEL_OPTIONS = [
  'deepseek-flash',
  'deepseek-v4-pro',
] as const;

export const GLM_LLM_MODEL_OPTIONS = ['glm-5.3', 'glm-5.2', 'glm-5.1'] as const;
export const KIMI_LLM_MODEL_OPTIONS = ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'] as const;

export const DEFAULT_LLM_PROVIDER_PROFILES: LlmProviderProfile[] = [
  {
    id: 'deepseek-v4-flash-openai',
    name: 'DeepSeek Flash',
    kind: 'responses',
    providerFlavor: 'deepseek',
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    model: 'deepseek-flash',
    contextWindowTokens: 1000000,
    maxOutputTokens: 384000,
    temperature: 0.2,
    reasoningEffort: 'high',
    thinking: 'enabled',
    enabled: true,
  },
  {
    id: 'deepseek-v4-pro-openai',
    name: 'DeepSeek V4 Pro',
    kind: 'responses',
    providerFlavor: 'deepseek',
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    model: 'deepseek-v4-pro',
    contextWindowTokens: 1000000,
    maxOutputTokens: 384000,
    temperature: 0.2,
    reasoningEffort: 'max',
    thinking: 'enabled',
    enabled: true,
  },
];

export interface LlmProfilesResult {
  profiles: LlmProviderProfile[];
  defaultProfileId?: string;
  storePath?: string;
}

export interface PatchLlmProfilesRequest {
  profiles: LlmProviderProfile[];
  defaultProfileId?: string;
  secrets?: Record<string, string | null>;
}

export interface LlmProbeRequest {
  profileId: string;
}

export interface LlmProbeResult {
  ok: boolean;
  provider: LlmProviderKind;
  model?: string;
  latencyMs?: number;
  reasoningPresent?: boolean;
  responsePresent?: boolean;
  nativeCompletion?: {
    providerKind: LlmProviderKind;
    terminalSignal: string;
    finishReason?: 'stop' | 'tool_calls';
  };
  errorCode?: string;
  httpStatus?: number;
  error?: string;
}
