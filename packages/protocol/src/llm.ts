import type { ToolCall, ToolDefinition } from './tools.js';

export type LlmProviderKind =
  | 'openaiCompatible'
  | 'anthropic'
  | 'codex'
  | 'ollama';

export type LlmReasoningEffort = 'low' | 'medium' | 'high';
export type LlmThinkingMode = 'enabled' | 'disabled';

export interface LlmProviderProfile {
  id: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: LlmThinkingMode;
  secretRef?: string;
  enabled: boolean;
}

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
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    model: 'deepseek-v4-flash',
    maxTokens: 4096,
    temperature: 0.2,
    reasoningEffort: 'medium',
    thinking: 'enabled',
    enabled: true,
  },
  {
    id: 'deepseek-v4-pro-openai',
    name: 'DeepSeek V4 Pro',
    kind: 'openaiCompatible',
    baseUrl: DEEPSEEK_OPENAI_BASE_URL,
    model: 'deepseek-v4-pro',
    maxTokens: 4096,
    temperature: 0.2,
    reasoningEffort: 'high',
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

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface LlmChatRequest {
  profileId: string;
  messages: LlmChatMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
}

export interface LlmChatChunk {
  type: 'delta' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
}

export interface LlmChatResult {
  chunks: LlmChatChunk[];
}

export interface LlmProbeRequest {
  profileId: string;
}

export interface LlmProbeResult {
  ok: boolean;
  provider: LlmProviderKind;
  model?: string;
  latencyMs?: number;
  error?: string;
}
