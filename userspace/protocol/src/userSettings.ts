export type UserSettingValue = string | number | boolean | null;

export type UserSettings = Record<string, UserSettingValue>;

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
  'terminal.integrated.defaultProfile.windows': 'wsl',
  'terminal.integrated.prewarm': 'afterStartup',
  'terminal.integrated.spawnTimeoutMs': 8000,
  'agent.defaultMode': 'plan',
  'agent.defaultWorkflow': 'planFirst',
  'agent.requirementConfirmationMode': 'auto',
  'agent.permissions.allowFileRead': true,
  'agent.permissions.allowFileWrite': true,
  'agent.permissions.allowCodeSearch': true,
  'agent.permissions.allowShellPropose': true,
  'agent.permissions.allowShellExec': true,
  'agent.permissions.processExec': 'ask',
  'agent.permissions.networkEgress': 'ask',
  'agent.permissions.gitWrite': 'ask',
  'agent.permissions.browserControl': 'ask',
  'agent.permissions.providerEgress': 'ask',
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
}
