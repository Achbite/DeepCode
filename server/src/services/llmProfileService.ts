import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  LlmProviderProfile,
  LlmProfilesResult,
  PatchLlmProfilesRequest,
} from '@deepcode/protocol';
import { resolveDeepCodeSettingsDir } from './appDataPath.js';
import {
  deleteLlmSecret,
  getSecretStorePath,
  saveLlmSecret,
} from './secretStore.js';

interface LlmProfilesFile {
  profiles: LlmProviderProfile[];
  defaultProfileId?: string;
}

const STORE_PATH = join(resolveDeepCodeSettingsDir(), 'llm-profiles.json');

let cache: LlmProfilesFile | null = null;

function sanitizeProfile(profile: LlmProviderProfile): LlmProviderProfile {
  return {
    id: String(profile.id || '').trim(),
    name: String(profile.name || '').trim(),
    kind: profile.kind,
    baseUrl: profile.baseUrl?.trim() || undefined,
    model: String(profile.model || '').trim(),
    maxTokens: typeof profile.maxTokens === 'number' ? profile.maxTokens : undefined,
    temperature: typeof profile.temperature === 'number' ? profile.temperature : undefined,
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
      cache = {
        profiles: parsed.profiles.map(sanitizeProfile).filter((p: LlmProviderProfile) => p.id && p.name && p.model),
        defaultProfileId: typeof parsed.defaultProfileId === 'string'
          ? parsed.defaultProfileId
          : undefined,
      };
    } else {
      cache = { profiles: [] };
    }
  } catch {
    cache = { profiles: [] };
  }
  return cache;
}

async function persistProfiles(file: LlmProfilesFile): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await rename(tmp, STORE_PATH);
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
