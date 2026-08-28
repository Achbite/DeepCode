import type { AgentPlugin } from './plugins.js';

export interface StartupPluginConfig {
  systemPrompt: string;
  skills: readonly {
    id: string;
    instructions: string;
  }[];
}

export function decodeStartupPluginConfig(encoded: string | undefined): StartupPluginConfig {
  if (!encoded) return { systemPrompt: '', skills: [] };
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error('startup_plugin_config_json_invalid');
  }
  if (
    !isRecord(value)
    || typeof value.systemPrompt !== 'string'
    || new TextEncoder().encode(value.systemPrompt).byteLength > 64 * 1024
    || !Array.isArray(value.skills)
  ) {
    throw new Error('startup_plugin_config_invalid');
  }
  const skills = value.skills.map((item) => {
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || !item.id
      || typeof item.instructions !== 'string'
      || !item.instructions.trim()
    ) {
      throw new Error('startup_skill_config_invalid');
    }
    return { id: item.id, instructions: item.instructions };
  });
  return { systemPrompt: value.systemPrompt, skills };
}

export function skillPlugin(skill: StartupPluginConfig['skills'][number]): AgentPlugin {
  return {
    id: `skill.${skill.id}`,
    setup: () => ({
      instructions: [{
        id: `skill.${skill.id}.instructions`,
        text: skill.instructions,
      }],
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
