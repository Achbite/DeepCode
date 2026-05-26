import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  LlmProviderProfile,
  LlmProfilesResult,
  PatchLlmProfilesRequest,
} from '@deepcode/protocol';
import { DEFAULT_LLM_PROVIDER_PROFILES } from '@deepcode/protocol';
import { resolveDeepCodeSettingsDir } from './appDataPath.js';
import {
  deleteLlmSecret,
  getSecretStorePath,
  saveLlmSecret,
} from './secretStore.js';
import { ensureDefaultAgentWorkflowConfig } from './agentWorkflowConfigService.js';
import { atomicWriteJsonFile } from './persistentFileService.js';

interface LlmProfilesFile {
  profiles: LlmProviderProfile[];
  defaultProfileId?: string;
}

const STORE_PATH = join(resolveDeepCodeSettingsDir(), 'llm-profiles.json');

let cache: LlmProfilesFile | null = null;

function createDefaultProfilesFile(): LlmProfilesFile {
  return {
    profiles: DEFAULT_LLM_PROVIDER_PROFILES.map((profile) => ({ ...profile })),
    defaultProfileId: DEFAULT_LLM_PROVIDER_PROFILES[0]?.id,
  };
}

function sanitizeProfile(profile: LlmProviderProfile): LlmProviderProfile {
  const model = String(profile.model || '').trim();
  const deepSeekV4 = model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro';
  return {
    id: String(profile.id || '').trim(),
    name: String(profile.name || '').trim(),
    kind: profile.kind,
    baseUrl: profile.baseUrl?.trim() || undefined,
    model,
    contextWindowTokens:
      typeof profile.contextWindowTokens === 'number'
        ? profile.contextWindowTokens
        : deepSeekV4
          ? 1000000
          : undefined,
    maxOutputTokens:
      typeof profile.maxOutputTokens === 'number'
        ? profile.maxOutputTokens
        : deepSeekV4
          ? 384000
          : undefined,
    maxTokens: typeof profile.maxTokens === 'number' ? profile.maxTokens : undefined,
    temperature: typeof profile.temperature === 'number' ? profile.temperature : undefined,
    reasoningEffort: ['low', 'medium', 'high', 'max'].includes(String(profile.reasoningEffort))
      ? profile.reasoningEffort
      : deepSeekV4
        ? model === 'deepseek-v4-pro'
          ? 'max'
          : 'high'
        : undefined,
    thinking: ['enabled', 'disabled'].includes(String(profile.thinking))
      ? profile.thinking
      : undefined,
    secretRef: profile.secretRef || undefined,
    enabled: profile.enabled !== false,
  };
}

async function loadProfiles(): Promise<LlmProfilesFile> {
  if (cache) return cache;
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.profiles)) {
      const profiles = parsed.profiles
        .map(sanitizeProfile)
        .filter((p: LlmProviderProfile) => p.id && p.name && p.model);
      cache = {
        profiles,
        defaultProfileId:
          typeof parsed.defaultProfileId === 'string'
            ? parsed.defaultProfileId
            : profiles[0]?.id,
      };
      if (cache.profiles.length === 0) {
        cache = createDefaultProfilesFile();
      }
    } else {
      cache = createDefaultProfilesFile();
    }
  } catch {
    cache = createDefaultProfilesFile();
  }
  return cache;
}

async function persistProfiles(file: LlmProfilesFile): Promise<void> {
  await atomicWriteJsonFile(STORE_PATH, file);
}

export async function getLlmProfiles(): Promise<LlmProfilesResult> {
  const file = await loadProfiles();
  return {
    profiles: file.profiles,
    defaultProfileId: file.defaultProfileId,
    storePath: STORE_PATH,
  };
}

export async function patchLlmProfiles(
  request: PatchLlmProfilesRequest
): Promise<LlmProfilesResult> {
  const previous = await loadProfiles();
  const previousById = new Map(previous.profiles.map((p) => [p.id, p]));
  const nextProfiles: LlmProviderProfile[] = [];
  const seen = new Set<string>();

  for (const rawProfile of request.profiles ?? []) {
    const profile = sanitizeProfile(rawProfile);
    if (!profile.id || !profile.name || !profile.model || seen.has(profile.id)) {
      continue;
    }
    seen.add(profile.id);

    const providedSecret = request.secrets?.[profile.id];
    if (typeof providedSecret === 'string' && providedSecret.trim()) {
      profile.secretRef = await saveLlmSecret(profile.id, providedSecret.trim());
    } else if (providedSecret === null) {
      await deleteLlmSecret(profile.secretRef);
      profile.secretRef = undefined;
    } else if (!profile.secretRef && previousById.get(profile.id)?.secretRef) {
      profile.secretRef = previousById.get(profile.id)?.secretRef;
    }
    nextProfiles.push(profile);
  }

  for (const oldProfile of previous.profiles) {
    if (!seen.has(oldProfile.id)) {
      await deleteLlmSecret(oldProfile.secretRef);
    }
  }

  const defaultProfileId =
    request.defaultProfileId && seen.has(request.defaultProfileId)
      ? request.defaultProfileId
      : nextProfiles[0]?.id;

  const file: LlmProfilesFile = {
    profiles: nextProfiles,
    defaultProfileId,
  };
  cache = file;
  await persistProfiles(file);
  await ensureDefaultAgentWorkflowConfig(file.profiles);

  return {
    profiles: file.profiles,
    defaultProfileId: file.defaultProfileId,
    storePath: STORE_PATH,
  };
}

export async function getLlmProfileById(
  profileId: string
): Promise<LlmProviderProfile | null> {
  const { profiles } = await getLlmProfiles();
  return profiles.find((p) => p.id === profileId) ?? null;
}

export function getLlmProfileStorePath(): { profilesPath: string; secretsPath: string } {
  return {
    profilesPath: STORE_PATH,
    secretsPath: getSecretStorePath(),
  };
}
