import { homedir, platform } from 'node:os';
import { join } from 'node:path';

function resolveDeepCodeAppDataDir(): string {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA;
    const base =
      appData && appData.length > 0
        ? appData
        : join(homedir(), 'AppData', 'Roaming');
    return join(base, 'DeepCode');
  }

  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'deepcode');
}

function sanitizeUserId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || 'local';
}

export function resolveDeepCodeConfigRoot(): string {
  return join(resolveDeepCodeAppDataDir(), 'config');
}

export function resolveDeepCodeGlobalConfigDir(): string {
  return join(resolveDeepCodeConfigRoot(), 'global');
}

export function resolveDeepCodeUserConfigDir(userId = process.env.DEEPCODE_USER_ID ?? 'local'): string {
  return join(resolveDeepCodeConfigRoot(), 'user', sanitizeUserId(userId));
}

/**
 * Backward-compatible default user config directory.
 * New code should prefer the category-specific helpers below.
 */
export function resolveDeepCodeConfigDir(): string {
  return resolveDeepCodeUserConfigDir();
}

export function resolveDeepCodeSettingsDir(): string {
  return join(resolveDeepCodeConfigDir(), 'settings');
}

export function resolveDeepCodeSkillsDir(): string {
  return join(resolveDeepCodeConfigDir(), 'skills');
}

export function resolveDeepCodePromptsDir(): string {
  return join(resolveDeepCodeConfigDir(), 'prompts');
}

export function resolveDeepCodeRulerDir(): string {
  return join(resolveDeepCodeConfigDir(), 'ruler');
}
