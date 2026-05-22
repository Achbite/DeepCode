import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentWorkflowConfig,
  AgentWorkflowStage,
  GetAgentWorkflowConfigResult,
  LlmProviderProfile,
  PatchAgentWorkflowConfigRequest,
} from '@deepcode/protocol';
import { AGENT_WORKFLOW_STAGES } from '@deepcode/protocol';
import { resolveDeepCodeConfigDir } from './appDataPath.js';

interface AgentWorkflowConfigFile {
  config: AgentWorkflowConfig;
  userConfigured?: boolean;
}

const STORE_PATH = join(resolveDeepCodeConfigDir(), 'agent', 'workflow-config.json');

let cache: AgentWorkflowConfigFile | null = null;

function emptyConfig(): AgentWorkflowConfig {
  return Object.fromEntries(
    AGENT_WORKFLOW_STAGES.map((stage) => [stage, {}])
  ) as AgentWorkflowConfig;
}

function normalizeConfig(raw: unknown): AgentWorkflowConfig {
  const source = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const config = emptyConfig();
  for (const stage of AGENT_WORKFLOW_STAGES) {
    const profileId = source[stage]?.profileId;
    config[stage] = typeof profileId === 'string' && profileId.trim()
      ? { profileId: profileId.trim() }
      : {};
  }
  return config;
}

function hasConfiguredStage(config: AgentWorkflowConfig): boolean {
  return AGENT_WORKFLOW_STAGES.some((stage) => Boolean(config[stage]?.profileId));
}

function firstValidProfile(profiles: LlmProviderProfile[]): LlmProviderProfile | undefined {
  return profiles.find((profile) =>
    profile.enabled !== false &&
    (profile.kind === 'ollama' || Boolean(profile.secretRef))
  );
}

async function loadFile(): Promise<AgentWorkflowConfigFile> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(STORE_PATH, 'utf-8'));
    cache = {
      config: normalizeConfig(parsed?.config),
      userConfigured: parsed?.userConfigured === true,
    };
  } catch {
    cache = { config: emptyConfig(), userConfigured: false };
  }
  return cache;
}

async function persistFile(file: AgentWorkflowConfigFile): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await rename(tmp, STORE_PATH);
  cache = file;
}

export async function getAgentWorkflowConfig(): Promise<GetAgentWorkflowConfigResult> {
  const file = await loadFile();
  return {
    config: file.config,
    storePath: STORE_PATH,
    initialized: hasConfiguredStage(file.config),
  };
}

export async function patchAgentWorkflowConfig(
  request: PatchAgentWorkflowConfigRequest
): Promise<GetAgentWorkflowConfigResult> {
  const current = await loadFile();
  const next = normalizeConfig({
    ...current.config,
    ...(request.config ?? {}),
  });
  await persistFile({ config: next, userConfigured: true });
  return getAgentWorkflowConfig();
}

export async function ensureDefaultAgentWorkflowConfig(
  profiles: LlmProviderProfile[]
): Promise<void> {
  const current = await loadFile();
  if (current.userConfigured || hasConfiguredStage(current.config)) return;

  const profile = firstValidProfile(profiles);
  if (!profile) return;

  const config = Object.fromEntries(
    AGENT_WORKFLOW_STAGES.map((stage: AgentWorkflowStage) => [
      stage,
      { profileId: profile.id },
    ])
  ) as AgentWorkflowConfig;

  await persistFile({ config, userConfigured: false });
}
