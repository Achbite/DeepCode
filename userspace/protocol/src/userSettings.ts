export type UserSettingValue = string | number | boolean | null;
export type UserSettings = Record<string, UserSettingValue>;
export type SettingsSurface = 'editor' | 'gui' | 'cli' | 'tui';

export type SettingCatalogDomain =
  | 'agent'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'editor'
  | 'workbench'
  | 'files'
  | 'keyboard'
  | 'explorer'
  | 'terminal'
  | 'gui'
  | 'cli'
  | 'tui';

export interface SettingCatalogEntry {
  key: string;
  domain: SettingCatalogDomain;
  shellSurface: SettingsSurface[];
  workspaceOverridable: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  'editor.tabSize': 4,
  'editor.insertSpaces': true,
  'editor.wordWrap': 'off',
  'editor.fontSize': 14,
  'editor.fontFamily': "Consolas, 'Courier New', monospace",
  'editor.renderWhitespace': 'none',
  'files.autoSave': 'afterDelay',
  'files.autoSaveDelay': 1000,
  'files.hotExit': true,
  'files.encoding': 'utf8',
  'files.eol': '\n',
  'keyboard.enableBasicShortcuts': true,
  'explorer.confirmDelete': false,
  'workbench.colorTheme': 'vs-dark',
  'workbench.language': 'zh-CN',
  'workbench.styleTokenOverrides': '{}',
  'workbench.uiPlugins': '[]',
  'gui.colorTheme': 'light',
  'gui.accentColor': 'blue',
  'gui.navigationDensity': 'comfortable',
  'gui.showContextRail': true,
  'gui.showReasoning': false,
  'gui.defaultFileOpen': 'reader',
  'gui.sidebarOrder': '{"projects":[],"sessions":[]}',
  'terminal.integrated.defaultProfile.windows': 'wsl',
  'terminal.integrated.prewarm': 'afterStartup',
  'terminal.integrated.spawnTimeoutMs': 8000,
  'agent.systemPrompt': '',
  'agent.responseLanguage': 'auto',
  'agent.windows.shell': 'auto',
  'agent.windows.gitBashPath': '',
  'agent.environmentRevision': 0,
  'agent.projectEnvironments': '{}',
  'agent.permissions.workspaceMutation': 'plan',
  'agent.permissions.engineeringDecisions': 'ask',
  'agent.permissions.networkRead': 'allow',
  'agent.permissions.external': 'ask',
  'agent.web.search.endpointTemplate': '',
  'agent.web.search.authHeaderName': 'Authorization',
  'agent.web.search.authSecretRef': '',
  'agent.documents.pythonPath': '',
  'skills.autoLoad': true,
  'skills.mounts': '[]',
  'mcp.autoLoad': false,
  'mcp.servers': '[]',
  'plugins.sources': '[]',
  'plugins.disabled': '[]',
};

const SHARED_AGENT_PREFIX = 'agent.';
const PLUGIN_SETTING_PREFIXES = ['skills.', 'mcp.', 'plugins.'];
const NON_SHELL_SETTING_PREFIXES = [SHARED_AGENT_PREFIX, ...PLUGIN_SETTING_PREFIXES];
const WORKSPACE_OVERRIDABLE_KEYS = new Set(['skills.mounts', 'mcp.servers', 'plugins.sources']);

export const SETTING_CATALOG: readonly SettingCatalogEntry[] = Object.freeze(
  Object.keys(DEFAULT_USER_SETTINGS).map((key) => ({
    key,
    domain: domainForKey(key),
    shellSurface: surfacesForKey(key),
    workspaceOverridable: WORKSPACE_OVERRIDABLE_KEYS.has(key),
  })),
);

export function settingCatalogIndex(): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG;
}

export function agentSettingsIndex(): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) => entry.key.startsWith(SHARED_AGENT_PREFIX));
}

export function pluginSettingsIndex(): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) =>
    PLUGIN_SETTING_PREFIXES.some((prefix) => entry.key.startsWith(prefix)),
  );
}

export function shellPreferenceSettingsIndex(
  surface: SettingsSurface,
): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) =>
    !NON_SHELL_SETTING_PREFIXES.some((prefix) => entry.key.startsWith(prefix))
      && entry.shellSurface.includes(surface),
  );
}

export function workspaceOverridableSettingsIndex(): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) => entry.workspaceOverridable);
}

function domainForKey(key: string): SettingCatalogDomain {
  const prefix = key.split('.')[0];
  return isDomain(prefix) ? prefix : 'agent';
}

function isDomain(value: string): value is SettingCatalogDomain {
  return [
    'agent', 'skills', 'mcp', 'plugins', 'editor', 'workbench', 'files', 'keyboard',
    'explorer', 'terminal', 'gui', 'cli', 'tui',
  ].includes(value);
}

function surfacesForKey(key: string): SettingsSurface[] {
  if (key === 'workbench.uiPlugins') return ['editor', 'gui'];
  const domain = domainForKey(key);
  if (NON_SHELL_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return ['editor', 'gui', 'cli', 'tui'];
  }
  if (domain === 'gui') return ['gui'];
  if (domain === 'cli') return ['cli'];
  if (domain === 'tui') return ['tui'];
  return ['editor'];
}

export interface GetUserSettingsResult {
  environment?: Record<string, unknown>;
  settings: UserSettings;
  runtimeSettings: UserSettings;
  overriddenKeys: string[];
  storePath: string;
}

export interface SkillSettingsItem {
  id: string;
  displayName: string;
  description: string;
  source: 'builtin' | 'mounted';
}

export interface PatchUserSettingsRequest {
  patches: Record<string, UserSettingValue>;
}

export type UserSettingsActivation = 'immediate' | 'nextRun';

export interface PatchUserSettingsResult {
  settings: UserSettings;
  changedKeys: string[];
  activation: UserSettingsActivation;
}
