export type LlmProviderKind =
  | 'openaiCompatible'
  | 'anthropic'
  | 'ollama';

export type LlmProviderFlavor = 'openai' | 'deepseek' | 'zhipu';
export type LlmReasoningEffort = 'low' | 'medium' | 'high' | 'max';
export type LlmThinkingMode = 'enabled' | 'disabled';

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
  secretRef?: string;
  enabled: boolean;
}

export type LlmProviderProfile = LlmProviderProfileFields;

export const DEEPSEEK_OPENAI_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';

export const DEEPSEEK_LLM_MODEL_OPTIONS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
] as const;

export const DEPRECATED_DEEPSEEK_LLM_MODELS = [
  'deepseek-chat',
  'deepseek-reasoner',
] as const;

export const DEFAULT_LLM_PROVIDER_PROFILES: LlmProviderProfile[] = [
  {
    id: 'deepseek-v4-flash-openai',
    name: 'DeepSeek V4 Flash',
    kind: 'openaiCompatible',
    providerFlavor: 'deepseek',
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    model: 'deepseek-v4-flash',
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
    kind: 'openaiCompatible',
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
