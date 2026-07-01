import type { AgentConversationActivity } from './agent.js';
import type { ToolCall, ToolDefinition } from './tools.js';

export type LlmProviderKind =
  | 'openaiCompatible'
  | 'anthropic'
  | 'ollama';

export type LlmProviderFlavor = 'openai' | 'deepseek' | 'zhipu';
export type LlmReasoningEffort = 'low' | 'medium' | 'high' | 'max';
export type LlmThinkingMode = 'enabled' | 'disabled';
export type LlmResponseFormat = { type: 'json_object' };

export interface LlmProviderProfile {
  id: string;
  name: string;
  kind: LlmProviderKind;
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

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface LlmChatRequest {
  profileId?: string;
  messages: LlmChatMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  providerUserId?: string;
  responseFormat?: LlmResponseFormat;
  providerOptions?: Record<string, unknown>;
}

export interface LlmChatChunk {
  type: 'delta' | 'reasoning_delta' | 'tool_call' | 'part' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  toolCallDelta?: {
    id?: string;
    index?: number;
    name?: string;
    argumentsDelta?: string;
  };
  error?: string;
  index?: number;
  callId?: string;
  finishReason?: string;
  usage?: Record<string, unknown>;
  rawProvider?: unknown;
}

export type AgentStreamPartKind =
  | 'thinkingDelta'
  | 'codeBlockChunk'
  | 'actionDraftChunk'
  | 'fileDone'
  | 'batchDone'
  | 'diagnostic';

export interface AgentStreamPartFrame {
  schemaVersion: 'deepcode.agent.stream.part.v1';
  partKind: AgentStreamPartKind;
  draftId?: string;
  frameId?: string;
  runId?: string;
  targetPath?: string;
  language?: string;
  capability?: string;
  blockId?: string;
  actionId?: string;
  sequence?: number;
  chunk?: string;
  contentHash?: string;
  summary?: string;
  diagnostic?: {
    severity?: 'info' | 'warning' | 'error';
    code?: string;
    message?: string;
  };
  resumeHandle?: string;
  metadata?: Record<string, unknown>;
}

export interface LlmChatResult {
  chunks: LlmChatChunk[];
  assistantMessage?: LlmChatMessage;
  usage?: Record<string, unknown>;
}

export type LlmChatStreamEventType =
  | 'provider_delta'
  | 'provider_reasoning_delta'
  | 'provider_tool_call_delta'
  | 'provider_usage'
  | 'provider_done'
  | 'provider_error';

export interface LlmChatStreamEvent {
  type: LlmChatStreamEventType;
  chunk?: LlmChatChunk;
  error?: string;
  usage?: Record<string, unknown>;
  rawProvider?: unknown;
}

export type ProjectionDeltaType =
  | 'active_turn'
  | 'assistant_delta'
  | 'reasoning_delta'
  | 'tool_call_delta'
  | 'part_delta'
  | 'draft_delta'
  | 'resource_delta'
  | 'workunit_delta'
  | 'stage_delta'
  | 'committed'
  | 'error';

export interface ProjectionDelta {
  type: ProjectionDeltaType;
  seq?: number;
  sessionId: string;
  runId?: string;
  turnId?: string;
  draftId?: string;
  targetPath?: string;
  itemId?: string;
  stage?: string;
  status?: 'queued' | 'running' | 'streaming' | 'waiting' | 'draftReady' | 'discarded' | 'skipped' | 'completed' | 'failed';
  channel?: 'progress' | 'reasoning' | 'final' | 'tool' | 'resource' | 'workunit' | 'draft';
  source?: 'session' | 'driver' | 'llm' | 'kernel' | 'provider';
  delta?: string;
  summary?: string;
  activity?: AgentConversationActivity;
  payload?: unknown;
  committedEventIds?: string[];
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
