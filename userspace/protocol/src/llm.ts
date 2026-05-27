import type { ToolCall, ToolDefinition } from './tools.js';

export type LlmProviderKind =
  | 'openaiCompatible'
  | 'anthropic'
  | 'codex'
  | 'ollama';

export type LlmReasoningEffort = 'low' | 'medium' | 'high' | 'max';
export type LlmThinkingMode = 'enabled' | 'disabled';
export type LlmResponseFormat = { type: 'json_object' };

export interface LlmProviderProfile {
  id: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl?: string;
  model: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
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

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface LlmChatRequest {
  profileId: string;
  messages: LlmChatMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  providerUserId?: string;
  responseFormat?: LlmResponseFormat;
  providerOptions?: Record<string, unknown>;
}

export interface LlmChatChunk {
  type: 'delta' | 'reasoning_delta' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
}

export interface LlmChatResult {
  chunks: LlmChatChunk[];
  assistantMessage?: LlmChatMessage;
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
