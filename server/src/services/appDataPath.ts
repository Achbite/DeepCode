import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function resolveDeepCodeConfigDir(): string {
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
