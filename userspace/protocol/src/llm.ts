import type { ToolCall } from './tools.js';

export type LlmProviderKind =
  | 'openaiCompatible'
  | 'anthropic'
  | 'ollama';

export type LlmReasoningTransport =
  | 'openaiPlaintext'
  | 'anthropicPlaintext'
  | 'ollamaPlaintext';

export type LlmProviderReasoningContract =
  | {
      kind: 'openaiCompatible';
      reasoningTransport: 'openaiPlaintext';
    }
  | {
      kind: 'anthropic';
      reasoningTransport: 'anthropicPlaintext';
    }
  | {
      kind: 'ollama';
      reasoningTransport: 'ollamaPlaintext';
    };

export type LlmProviderFlavor = 'openai' | 'deepseek' | 'zhipu';
export type LlmReasoningEffort = 'low' | 'medium' | 'high' | 'max';
export type LlmThinkingMode = 'enabled' | 'disabled';
export type LlmResponseFormat = { type: 'json_object' };

interface LlmProviderProfileFields {
  id: string;
  name: string;
  providerFlavor?: LlmProviderFlavor;
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

export type LlmProviderProfile =
  LlmProviderProfileFields & LlmProviderReasoningContract;

/**
 * Read model for stores created before the reasoning transport contract.
 *
 * This shape is intentionally excluded from write requests and execution
 * selection. It only lets settings surfaces show and repair the old profile.
 */
export type LegacyReadableLlmProviderProfile = LlmProviderProfileFields & {
  kind: LlmProviderKind;
  reasoningTransport?: undefined;
};

export type ReadableLlmProviderProfile =
  | LlmProviderProfile
  | LegacyReadableLlmProviderProfile;

export const LLM_REASONING_TRANSPORT_BY_PROVIDER_KIND = {
  openaiCompatible: 'openaiPlaintext',
  anthropic: 'anthropicPlaintext',
  ollama: 'ollamaPlaintext',
} as const satisfies Readonly<Record<LlmProviderKind, LlmReasoningTransport>>;

export function reasoningTransportForProviderKind<
  Kind extends LlmProviderKind,
>(
  kind: Kind,
): (typeof LLM_REASONING_TRANSPORT_BY_PROVIDER_KIND)[Kind] {
  return LLM_REASONING_TRANSPORT_BY_PROVIDER_KIND[kind];
}

/**
 * Runtime compatibility check for profiles loaded from durable stores.
 *
 * Older profiles without `reasoningTransport` remain readable, but callers
 * must not offer them for execution until the user saves a matching contract.
 */
export function hasCompatibleReasoningTransport<
  Profile extends {
    kind: LlmProviderKind;
    reasoningTransport?: unknown;
  },
>(profile: Profile): profile is Profile & LlmProviderReasoningContract {
  return profile.reasoningTransport
    === LLM_REASONING_TRANSPORT_BY_PROVIDER_KIND[profile.kind];
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
    reasoningTransport: 'openaiPlaintext',
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
    reasoningTransport: 'openaiPlaintext',
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
  profiles: ReadableLlmProviderProfile[];
  defaultProfileId?: string;
  storePath?: string;
  profileMigrations?: AgentSessionProfileMigration[];
}

export interface AgentSessionProfileMigration {
  sessionId: string;
  fromProfileId?: string;
  toProfileId: string;
}

export interface PatchLlmProfilesRequest {
  profiles: LlmProviderProfile[];
  defaultProfileId?: string;
  secrets?: Record<string, string | null>;
  reenableProfileIds?: string[];
}

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/**
 * Provider wire metadata only. Permission, risk, and execution policy remain
 * Kernel facts and must not be synthesized by Session into Provider tools.
 */
export interface ProviderWireToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface LlmChatRequest {
  requestId: string;
  parentRequestId?: string;
  profileId?: string;
  messages: LlmChatMessage[];
  tools?: ProviderWireToolDefinition[];
  stream: true;
  providerUserId?: string;
  responseFormat?: LlmResponseFormat;
  providerOptions?: Record<string, unknown>;
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
