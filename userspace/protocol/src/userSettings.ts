export type UserSettingValue = string | number | boolean | null;

export type UserSettings = Record<string, UserSettingValue>;

export type SettingsSurface = 'editor' | 'gui' | 'cli' | 'tui';

export type SettingCatalogDomain =
  | 'agent'
  | 'ruler'
  | 'skills'
  | 'mcp'
  | 'llm'
  | 'editor'
  | 'workbench'
  | 'files'
  | 'keyboard'
  | 'explorer'
  | 'terminal'
  | 'gui'
  | 'cli'
  | 'tui';

export type SettingCatalogScope = 'user' | 'workspace';

export interface SettingCatalogEntry {
  key: string;
  domain: SettingCatalogDomain;
  scope: SettingCatalogScope;
  shellSurface: SettingsSurface[];
  agentConfigurable: boolean;
  workspaceOverridable: boolean;
  requiresAudit: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  'editor.tabSize': 4,
  'editor.insertSpaces': true,
  'editor.wordWrap': 'off',
  'editor.fontSize': 14,
  'editor.fontFamily': "Consolas, 'Courier New', monospace",
  'editor.renderWhitespace': 'none',
  'editor.tabCompletion': 'on',
  'editor.accessibilitySupport': 'off',
  'editor.unicodeHighlight.invisibleCharacters': false,
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
  'workbench.previewEditor': 'vscode',
  'gui.colorTheme': 'deepcode-gui-light',
  'gui.timelineDensity': 'normal',
  'gui.typewriterAnimation': true,
  'gui.collapseCompletedThinking': true,
  'cli.outputFormat': 'rich',
  'cli.colorMode': 'auto',
  'tui.colorTheme': 'system',
  'tui.panelDensity': 'normal',
  'terminal.integrated.defaultProfile.windows': 'wsl',
  'terminal.integrated.prewarm': 'afterStartup',
  'terminal.integrated.spawnTimeoutMs': 8000,
  'agent.defaultMode': 'plan',
  'agent.defaultWorkflow': 'planFirst',
  'agent.requirementConfirmationMode': 'auto',
  'agent.reviewContinuationMode': 'auto',
  'agent.interventionLevel': 'medium',
  'agent.subagents.mode': 'auto',
  'agent.subagents.maxParallel': 2,
  'agent.permissions.allowFileRead': true,
  'agent.permissions.allowFileWrite': true,
  'agent.permissions.allowCodeSearch': true,
  'agent.permissions.allowShellPropose': true,
  'agent.permissions.allowShellExec': true,
  'agent.permissions.processExec': 'ask',
  'agent.permissions.networkEgress': 'ask',
  'agent.permissions.gitWrite': 'ask',
  'agent.permissions.gitPush': 'ask',
  'agent.permissions.browserControl': 'ask',
  'agent.permissions.providerEgress': 'ask',
  'agent.git.commitMessageMode': 'generate',
  'agent.integrations.github.enabled': false,
  'agent.integrations.github.repoUrl': '',
  'agent.integrations.github.authSecretRef': '',
  'agent.integrations.github.defaultRemote': 'origin',
  'agent.integrations.github.pushPolicy': 'manual',
  'agent.shell.autoExecuteCommands': false,
  'agent.shell.commandBlacklist':
    'rm -rf, del /f, format, shutdown, reboot, git reset --hard, git clean -fd',
  'skills.pythonPath': 'python',
  'skills.autoLoad': true,
  'skills.mounts': '[]',
  'mcp.autoLoad': false,
  'mcp.servers': '[]',
  'ruler.enabled': true,
  'ruler.rules':
    '[{"id":"default-safety","name":"Default Safety Boundary","source":"system","priority":100,"path":"<builtin>/default-safety.md","content":"Default to plan mode. Read before write. Show diff before saving files. Never run destructive commands without explicit approval.","enabled":true}]',
};

const ALL_SURFACES: SettingsSurface[] = ['editor', 'gui', 'cli', 'tui'];

const SHARED_AGENT_KEY_PREFIXES = [
  'agent.',
  'ruler.',
  'skills.',
  'mcp.',
  'llm.',
];

const WORKSPACE_OVERRIDABLE_KEYS = new Set([
  'skills.mounts',
  'mcp.servers',
  'ruler.rules',
]);

export const SETTING_CATALOG: readonly SettingCatalogEntry[] = Object.freeze(
  Object.keys(DEFAULT_USER_SETTINGS).map((key) => settingCatalogEntry(key))
);

export function settingCatalogIndex(): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG;
}

export function agentSettingsIndex(): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) => isSharedAgentSetting(entry));
}

export function shellPreferenceSettingsIndex(surface: SettingsSurface): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) =>
    !isSharedAgentSetting(entry) && entry.shellSurface.includes(surface)
  );
}

export function workspaceOverridableSettingsIndex(): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) => entry.workspaceOverridable);
}

export function agentConfigurableSettingsIndex(): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) => entry.agentConfigurable);
}

export function settingCatalogEntryForKey(key: string): SettingCatalogEntry | undefined {
  return SETTING_CATALOG.find((entry) => entry.key === key);
}

function settingCatalogEntry(key: string): SettingCatalogEntry {
  const domain = settingDomainForKey(key);
  const sharedAgent = SHARED_AGENT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
  const workspaceOverridable = WORKSPACE_OVERRIDABLE_KEYS.has(key);
  return {
    key,
    domain,
    scope: 'user',
    shellSurface: sharedAgent ? ALL_SURFACES : shellSurfacesForDomain(domain),
    agentConfigurable: sharedAgent,
    workspaceOverridable,
    requiresAudit: sharedAgent || workspaceOverridable,
  };
}

function isSharedAgentSetting(entry: SettingCatalogEntry): boolean {
  return SHARED_AGENT_KEY_PREFIXES.some((prefix) => entry.key.startsWith(prefix));
}

function settingDomainForKey(key: string): SettingCatalogDomain {
  const prefix = key.split('.')[0] as SettingCatalogDomain | undefined;
  if (prefix === 'agent' ||
    prefix === 'ruler' ||
    prefix === 'skills' ||
    prefix === 'mcp' ||
    prefix === 'llm' ||
    prefix === 'editor' ||
    prefix === 'workbench' ||
    prefix === 'files' ||
    prefix === 'keyboard' ||
    prefix === 'explorer' ||
    prefix === 'terminal' ||
    prefix === 'gui' ||
    prefix === 'cli' ||
    prefix === 'tui'
  ) {
    return prefix;
  }
  return 'agent';
}

function shellSurfacesForDomain(domain: SettingCatalogDomain): SettingsSurface[] {
  if (domain === 'gui') return ['gui'];
  if (domain === 'cli') return ['cli'];
  if (domain === 'tui') return ['tui'];
  if (
    domain === 'editor' ||
    domain === 'workbench' ||
    domain === 'files' ||
    domain === 'keyboard' ||
    domain === 'explorer' ||
    domain === 'terminal'
  ) {
    return ['editor'];
  }
  return ALL_SURFACES;
}

export interface GetUserSettingsResult {
  settings: UserSettings;
  overriddenKeys: string[];
  storePath: string;
}

export interface PatchUserSettingsRequest {
  patches: Record<string, UserSettingValue>;
}

export interface PatchUserSettingsResult {
  settings: UserSettings;
  changedKeys: string[];
  configAudit?: {
    kind: string;
    changedKeys: string[];
    source: string;
    storePath?: string;
    oldHash?: string;
    newHash?: string;
    message: string;
  };
}
