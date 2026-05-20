import type { ToolCall, ToolDefinition } from './tools.js';

export type LlmProviderKind =
  | 'openaiCompatible'
  | 'anthropic'
  | 'codex'
  | 'ollama';

export interface LlmProviderProfile {
  id: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  secretRef?: string;
  enabled: boolean;
}

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
