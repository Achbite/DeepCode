import type {
  LlmChatRequest,
  LlmChatResult,
  LlmProbeResult,
  LlmProviderProfile,
} from '@deepcode/protocol';
import { LlmProviderRegistry } from '../modules/llm/providerRegistry.js';
import { getLlmProfileById } from './llmProfileService.js';
import { getLlmSecret } from './secretStore.js';

const registry = new LlmProviderRegistry();

async function loadProfileAndSecret(profileId: string): Promise<{
  profile: LlmProviderProfile;
  apiKey: string;
}> {
  const profile = await getLlmProfileById(profileId);
  if (!profile) {
    throw new Error(`LLM profile not found: ${profileId}`);
  }
  if (!profile.enabled) {
    throw new Error(`LLM profile is disabled: ${profile.name}`);
  }
  const apiKey = await getLlmSecret(profile.secretRef);
  if (!apiKey && profile.kind !== 'ollama') {
    throw new Error(`LLM profile is missing API key: ${profile.name}`);
  }
  return { profile, apiKey: apiKey ?? '' };
}

export async function probeLlmProfile(profileId: string): Promise<LlmProbeResult> {
  const started = Date.now();
  try {
    const { profile, apiKey } = await loadProfileAndSecret(profileId);
    await registry.chat(profile, apiKey, {
      profileId,
      stream: false,
      messages: [
        { role: 'system', content: 'You are a health check endpoint.' },
        { role: 'user', content: 'Reply with ok.' },
      ],
    });

    return {
      ok: true,
      provider: profile.kind,
      model: profile.model,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'openaiCompatible',
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function chatWithLlm(request: LlmChatRequest): Promise<LlmChatResult> {
  const { profile, apiKey } = await loadProfileAndSecret(request.profileId);
  return registry.chat(profile, apiKey, request);
}
