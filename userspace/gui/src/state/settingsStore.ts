import { create } from 'zustand';
import { useMemo } from 'react';
import {
  DEFAULT_USER_SETTINGS,
  agentConfigurableSettingsIndex,
  agentSettingsIndex,
  shellPreferenceSettingsIndex,
  workspaceOverridableSettingsIndex,
  type SettingCatalogEntry,
  type SettingsSurface,
  type UserSettingValue,
  type UserSettings,
} from '@deepcode/protocol';
import {
  getUserSettings,
  patchUserSettings,
  patchWorkspaceSettings,
} from '../services/runtimeAdapter';

export type SettingSource = 'default' | 'user' | 'workspace';

export type SettingControlType = 'boolean' | 'number' | 'text' | 'select';

export interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  group:
    | 'editor'
    | 'files'
    | 'keyboard'
    | 'explorer'
    | 'workbench'
    | 'terminal'
    | 'agent'
    | 'gui'
    | 'skills'
    | 'mcp'
    | 'ruler';
  control: SettingControlType;
  options?: Array<{ label: string; value: string }>;
  catalog?: SettingCatalogEntry;
}

export interface EditorEffectiveOptions {
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: string;
  fontSize: number;
  fontFamily: string;
  renderWhitespace: string;
  theme: string;
}

export interface ConfigAuditNotice {
  kind?: string;
  configKind?: string;
  changedKeys?: string[];
  source?: string;
  storePath?: string;
  oldHash?: string;
  newHash?: string;
  message?: string;
  auditError?: string;
}

interface SettingsStateData {
  userSettings: UserSettings;
  workspaceSettings: Record<string, unknown>;
  effectiveSettings: UserSettings;
  sources: Record<string, SettingSource>;
  overriddenKeys: string[];
  storePath: string | null;
  loading: boolean;
  errorMessage: string | null;
  lastConfigAudit: ConfigAuditNotice | null;
}

interface SettingsActions {
  loadUserSettings: () => Promise<void>;
  syncWorkspaceSettings: (settings: Record<string, unknown>) => void;
  patchUserSetting: (key: string, value: UserSettingValue) => Promise<void>;
  patchWorkspaceSetting: (key: string, value: UserSettingValue) => Promise<void>;
  resetUserSetting: (key: string) => Promise<void>;
  getSettingSource: (key: string) => SettingSource;
}

type SettingsStore = SettingsStateData & SettingsActions;

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'workbench.language',
    label: 'Display Language',
    description: 'Choose the UI language. Language packs are loaded from local i18n files; reload the workbench after changing this value.',
    group: 'workbench',
    control: 'select',
    options: [
      { label: 'Simplified Chinese', value: 'zh-CN' },
      { label: 'English', value: 'en-US' },
    ],
  },
  {
    key: 'workbench.colorTheme',
    label: 'Color Theme',
    description: 'Workbench color theme.',
    group: 'workbench',
    control: 'select',
    options: [
      { label: 'Dark', value: 'vs-dark' },
      { label: 'Light', value: 'vs-light' },
    ],
  },
  {
    key: 'workbench.styleTokenOverrides',
    label: 'Style Token Overrides',
    description: 'Reserved JSON style-token override map for future custom themes.',
    group: 'workbench',
    control: 'text',
  },
  {
    key: 'workbench.previewEditor',
    label: 'Preview Editor',
    description: 'External editor used when opening changed files from Agent UI.',
    group: 'workbench',
    control: 'select',
    options: [
      { label: 'VS Code', value: 'vscode' },
    ],
  },
  {
    key: 'gui.colorTheme',
    label: 'DeepCode-GUI Theme',
    description: 'Theme used by the lightweight DeepCode-GUI shell. It does not affect the editor workbench theme.',
    group: 'gui',
    control: 'select',
    options: [
      { label: 'Light', value: 'deepcode-gui-light' },
      { label: 'Dark', value: 'deepcode-gui-dark' },
    ],
  },
  {
    key: 'gui.timelineDensity',
    label: 'GUI Timeline Density',
    description: 'Timeline density for the lightweight conversational GUI shell.',
    group: 'gui',
    control: 'select',
    options: [
      { label: 'Normal', value: 'normal' },
      { label: 'Compact', value: 'compact' },
    ],
  },
  {
    key: 'gui.typewriterAnimation',
    label: 'GUI Typewriter Animation',
    description: 'Animate model narration, thinking, and final answers in the DeepCode-GUI timeline.',
    group: 'gui',
    control: 'boolean',
  },
  {
    key: 'gui.collapseCompletedThinking',
    label: 'Collapse Completed Thinking',
    description: 'Collapse completed thinking blocks in the DeepCode-GUI after the run settles.',
    group: 'gui',
    control: 'boolean',
  },
  {
    key: 'editor.tabSize',
    label: 'Tab Size',
    description: 'Editor indentation width.',
    group: 'editor',
    control: 'number',
  },
  {
    key: 'editor.insertSpaces',
    label: 'Insert Spaces',
    description: 'Insert spaces when pressing Tab.',
    group: 'editor',
    control: 'boolean',
  },
  {
    key: 'editor.wordWrap',
    label: 'Word Wrap',
    description: 'Editor line wrapping strategy.',
    group: 'editor',
    control: 'select',
    options: [
      { label: 'Off', value: 'off' },
      { label: 'On', value: 'on' },
      { label: 'Word Wrap Column', value: 'wordWrapColumn' },
      { label: 'Bounded', value: 'bounded' },
    ],
  },
  {
    key: 'editor.fontSize',
    label: 'Font Size',
    description: 'Editor font size.',
    group: 'editor',
    control: 'number',
  },
  {
    key: 'editor.fontFamily',
    label: 'Font Family',
    description: 'Editor font family.',
    group: 'editor',
    control: 'text',
  },
  {
    key: 'editor.renderWhitespace',
    label: 'Render Whitespace',
    description: 'Whitespace rendering strategy.',
    group: 'editor',
    control: 'select',
    options: [
      { label: 'None', value: 'none' },
      { label: 'Boundary', value: 'boundary' },
      { label: 'Selection', value: 'selection' },
      { label: 'Trailing', value: 'trailing' },
      { label: 'All', value: 'all' },
    ],
  },
  {
    key: 'files.autoSave',
    label: 'Auto Save',
    description: 'File auto-save strategy.',
    group: 'files',
    control: 'select',
    options: [
      { label: 'Off', value: 'off' },
      { label: 'After Delay', value: 'afterDelay' },
    ],
  },
  {
    key: 'files.autoSaveDelay',
    label: 'Auto Save Delay',
    description: 'Auto-save delay in milliseconds.',
    group: 'files',
    control: 'number',
  },
  {
    key: 'files.hotExit',
    label: 'Hot Exit',
    description: 'Keep unsaved editor state across reload or restart.',
    group: 'files',
    control: 'boolean',
  },
  {
    key: 'keyboard.enableBasicShortcuts',
    label: 'Basic Shortcuts',
    description: 'Enable basic shortcuts such as Ctrl+S, Ctrl+Shift+S, Ctrl+A and Ctrl+,.',
    group: 'keyboard',
    control: 'boolean',
  },
  {
    key: 'explorer.confirmDelete',
    label: 'Confirm Delete',
    description: 'Ask for confirmation before deleting resources.',
    group: 'explorer',
    control: 'boolean',
  },
  {
    key: 'terminal.integrated.defaultProfile.windows',
    label: 'Windows Terminal Profile',
    description: 'Default packaged Windows shell. WSL keeps Agent commands Unix-compatible.',
    group: 'terminal',
    control: 'select',
    options: [
      { label: 'WSL', value: 'wsl' },
      { label: 'PowerShell', value: 'powershell' },
      { label: 'Command Prompt', value: 'cmd' },
    ],
  },
  {
    key: 'terminal.integrated.prewarm',
    label: 'Terminal Prewarm',
    description: 'Warm terminal runtime after startup to reduce first terminal latency.',
    group: 'terminal',
    control: 'select',
    options: [
      { label: 'After Startup', value: 'afterStartup' },
      { label: 'Off', value: 'off' },
    ],
  },
  {
    key: 'terminal.integrated.spawnTimeoutMs',
    label: 'Terminal Spawn Timeout',
    description: 'Terminal background spawn timeout in milliseconds.',
    group: 'terminal',
    control: 'number',
  },
  {
    key: 'agent.defaultMode',
    label: 'Default Permission Mode',
    description: 'Default permission mode for new Agent sessions.',
    group: 'agent',
    control: 'select',
    options: [
      { label: 'Read Only', value: 'readOnly' },
      { label: 'Plan', value: 'plan' },
      { label: 'Ask Before Write', value: 'askBeforeWrite' },
    ],
  },
  {
    key: 'agent.defaultWorkflow',
    label: 'Default Workflow',
    description: 'Default Agent behavior when a user sends a task.',
    group: 'agent',
    control: 'select',
    options: [
      { label: 'Plan First', value: 'planFirst' },
      { label: 'Act On Request', value: 'actOnRequest' },
    ],
  },
  {
    key: 'agent.requirementConfirmationMode',
    label: 'Requirement Confirmation',
    description: 'Controls whether Session asks for requirement confirmation before planning side-effect work.',
    group: 'agent',
    control: 'select',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Always', value: 'always' },
      { label: 'Off', value: 'off' },
    ],
  },
  {
    key: 'agent.reviewContinuationMode',
    label: 'Review Continuation',
    description: 'Controls whether accepted Review batches automatically generate the next Plan.',
    group: 'agent',
    control: 'select',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Ask', value: 'ask' },
      { label: 'Off', value: 'off' },
    ],
  },
  {
    key: 'agent.interventionLevel',
    label: 'User Intervention Level',
    description: 'Controls how often Agent asks the user to choose between engineering details before planning.',
    group: 'agent',
    control: 'select',
    options: [
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ],
  },
  {
    key: 'agent.subagents.mode',
    label: 'Sub-agents',
    description: 'Conservative parallel draft generation for independent accepted-plan tasks. Parent Session still validates and submits all work.',
    group: 'agent',
    control: 'select',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Off', value: 'off' },
    ],
  },
  {
    key: 'agent.subagents.maxParallel',
    label: 'Sub-agent Max Parallel',
    description: 'Maximum parallel sub-agent draft branches. Version 1 clamps this value to 2.',
    group: 'agent',
    control: 'number',
  },
  {
    key: 'agent.permissions.allowFileRead',
    label: 'Allow File Read',
    description: 'Allow Agent tools to read workspace files.',
    group: 'agent',
    control: 'boolean',
  },
  {
    key: 'agent.permissions.allowFileWrite',
    label: 'Allow File Write',
    description: 'Allow Agent tools to request file writes. Writes still require approval.',
    group: 'agent',
    control: 'boolean',
  },
  {
    key: 'agent.permissions.allowCodeSearch',
    label: 'Allow Code Search',
    description: 'Allow Agent tools to search code in the workspace.',
    group: 'agent',
    control: 'boolean',
  },
  {
    key: 'agent.permissions.allowShellPropose',
    label: 'Allow Shell Proposals',
    description: 'Allow Agent to propose shell commands without executing them.',
    group: 'agent',
    control: 'boolean',
  },
  {
    key: 'agent.permissions.allowShellExec',
    label: 'Allow Shell Execution Requests',
    description: 'Allow Agent to request or execute shell commands through the Agent permission policy.',
    group: 'agent',
    control: 'boolean',
  },
  {
    key: 'agent.permissions.processExec',
    label: 'Process Execution',
    description: 'Permission policy for process.exec work units.',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptions(),
  },
  {
    key: 'agent.permissions.networkEgress',
    label: 'Network Egress',
    description: 'Permission policy for outbound network or web evidence requests.',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptions(),
  },
  {
    key: 'agent.permissions.gitWrite',
    label: 'Git Write',
    description: 'Permission policy for Git stage, unstage, and commit work units.',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptions(),
  },
  {
    key: 'agent.permissions.gitPush',
    label: 'Git Push',
    description: 'Permission policy for pushing commits to a remote. Push is never enabled by default.',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptions(),
  },
  {
    key: 'agent.git.commitMessageMode',
    label: 'Commit Message Mode',
    description: 'Allow the Agent to ask the model for commit message suggestions from review diff facts.',
    group: 'agent',
    control: 'select',
    options: [
      { label: 'Generate', value: 'generate' },
      { label: 'Ask', value: 'ask' },
      { label: 'Off', value: 'off' },
    ],
  },
  {
    key: 'agent.integrations.github.enabled',
    label: 'GitHub Integration',
    description: 'Enable GitHub metadata access through configured repository and secret references.',
    group: 'agent',
    control: 'boolean',
  },
  {
    key: 'agent.integrations.github.repoUrl',
    label: 'GitHub Repository URL',
    description: 'Optional GitHub repository URL. Workspace git remote is used when this is empty.',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'agent.integrations.github.authSecretRef',
    label: 'GitHub Auth Secret Ref',
    description: 'Secret reference for GitHub authentication. Tokens are not stored in this plain settings value.',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'agent.integrations.github.defaultRemote',
    label: 'GitHub Default Remote',
    description: 'Git remote name used when deriving repository information.',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'agent.integrations.github.pushPolicy',
    label: 'GitHub Push Policy',
    description: 'Controls whether push requires manual confirmation, asks through permission policy, or may follow explicit allow settings.',
    group: 'agent',
    control: 'select',
    options: [
      { label: 'Manual', value: 'manual' },
      { label: 'Ask', value: 'ask' },
      { label: 'Allow', value: 'allow' },
    ],
  },
  {
    key: 'agent.permissions.browserControl',
    label: 'Browser Control',
    description: 'Permission policy for browser.control work units.',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptions(),
  },
  {
    key: 'agent.permissions.providerEgress',
    label: 'Provider Egress',
    description: 'Permission policy for provider egress audit and external model calls.',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptions(),
  },
  {
    key: 'agent.shell.autoExecuteCommands',
    label: 'Auto Execute Commands',
    description: 'Allow approved process.exec requests to run automatically when process execution is enabled.',
    group: 'agent',
    control: 'boolean',
  },
  {
    key: 'agent.shell.commandBlacklist',
    label: 'Command Blacklist',
    description: 'Comma-separated command fragments that always require manual approval before shell execution.',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'skills.mounts',
    label: 'Project Skill Mounts',
    description: 'JSON array of additional Skill mount definitions available to Agent runs.',
    group: 'skills',
    control: 'text',
  },
  {
    key: 'mcp.servers',
    label: 'Project MCP Servers',
    description: 'JSON array of MCP service definitions available to Agent runs.',
    group: 'mcp',
    control: 'text',
  },
  {
    key: 'ruler.rules',
    label: 'Project Ruler Rules',
    description: 'JSON array of Ruler rules or project-level additions used by Agent prompt assembly.',
    group: 'ruler',
    control: 'text',
  },
];

const SETTING_DEFINITION_BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

export function agentSettingDefinitions(): SettingDefinition[] {
  return definitionsForCatalog(agentSettingsIndex());
}

export function shellPreferenceSettingDefinitions(surface: SettingsSurface): SettingDefinition[] {
  return definitionsForCatalog(shellPreferenceSettingsIndex(surface));
}

export function workspaceSettingDefinitions(): SettingDefinition[] {
  return definitionsForCatalog(workspaceOverridableSettingsIndex());
}

export function agentConfigurableSettingDefinitions(): SettingDefinition[] {
  return definitionsForCatalog(agentConfigurableSettingsIndex());
}

function definitionsForCatalog(entries: readonly SettingCatalogEntry[]): SettingDefinition[] {
  return entries.flatMap((entry) => {
    const definition = SETTING_DEFINITION_BY_KEY.get(entry.key);
    return definition ? [{ ...definition, catalog: entry }] : [];
  });
}

function permissionPolicyOptions(): NonNullable<SettingDefinition['options']> {
  return [
    { label: 'Deny', value: 'deny' },
    { label: 'Ask', value: 'ask' },
    { label: 'Allow', value: 'allow' },
  ];
}

const KNOWN_SETTING_KEYS = new Set(Object.keys(DEFAULT_USER_SETTINGS));
const WORKSPACE_OVERRIDABLE_SETTING_KEYS = new Set(
  workspaceOverridableSettingsIndex().map((entry) => entry.key)
);

function isSupportedSettingValue(value: unknown): value is UserSettingValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

function getDefaultValue(key: string): UserSettingValue {
  return DEFAULT_USER_SETTINGS[key] ?? null;
}

function normalizeSettingValue(key: string, value: unknown): UserSettingValue {
  const defaultValue = getDefaultValue(key);
  if (typeof defaultValue === 'boolean') return Boolean(value);
  if (typeof defaultValue === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : defaultValue;
  }
  if (typeof defaultValue === 'string') {
    return typeof value === 'string' ? value : String(value ?? defaultValue);
  }
  return isSupportedSettingValue(value) ? value : defaultValue;
}

function normalizeWorkspaceSettings(settings: Record<string, unknown>): UserSettings {
  const normalized: UserSettings = {};
  for (const [rawKey, rawValue] of Object.entries(settings)) {
    const key = rawKey.startsWith('deepcode.')
      ? rawKey.slice('deepcode.'.length)
      : rawKey;
    if (!KNOWN_SETTING_KEYS.has(key) || !WORKSPACE_OVERRIDABLE_SETTING_KEYS.has(key)) continue;
    normalized[key] = normalizeSettingValue(key, rawValue);
  }
  return normalized;
}

function buildEffectiveSettings(
  userSettings: UserSettings,
  workspaceSettings: Record<string, unknown>,
  overriddenKeys: string[]
): Pick<SettingsStateData, 'effectiveSettings' | 'sources'> {
  const normalizedWorkspace = normalizeWorkspaceSettings(workspaceSettings);
  const effectiveSettings: UserSettings = {
    ...DEFAULT_USER_SETTINGS,
    ...userSettings,
    ...normalizedWorkspace,
  };
  const sources: Record<string, SettingSource> = {};
  for (const key of Object.keys(effectiveSettings)) {
    if (key in normalizedWorkspace) {
      sources[key] = 'workspace';
    } else if (overriddenKeys.includes(key)) {
      sources[key] = 'user';
    } else {
      sources[key] = 'default';
    }
  }
  return { effectiveSettings, sources };
}

function configAuditNotice(value: unknown): ConfigAuditNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as ConfigAuditNotice;
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
  const initialEffective = buildEffectiveSettings(DEFAULT_USER_SETTINGS, {}, []);

  return {
    userSettings: DEFAULT_USER_SETTINGS,
    workspaceSettings: {},
    effectiveSettings: initialEffective.effectiveSettings,
    sources: initialEffective.sources,
    overriddenKeys: [],
    storePath: null,
    loading: false,
    errorMessage: null,
    lastConfigAudit: null,

    loadUserSettings: async () => {
      if (get().loading) return;
      set({ loading: true, errorMessage: null });
      const result = await getUserSettings();
      if (!result.ok || !result.data) {
        set({
          loading: false,
          errorMessage: result.message ?? 'Failed to load user settings.',
        });
        return;
      }
      const next = buildEffectiveSettings(
        result.data.settings,
        get().workspaceSettings,
        result.data.overriddenKeys
      );
      set({
        userSettings: result.data.settings,
        overriddenKeys: result.data.overriddenKeys,
        storePath: result.data.storePath,
        effectiveSettings: next.effectiveSettings,
        sources: next.sources,
        loading: false,
        errorMessage: null,
      });
    },

    syncWorkspaceSettings: (settings) => {
      const next = buildEffectiveSettings(
        get().userSettings,
        settings,
        get().overriddenKeys
      );
      set({
        workspaceSettings: settings,
        effectiveSettings: next.effectiveSettings,
        sources: next.sources,
      });
    },

    patchUserSetting: async (key, value) => {
      const normalized = normalizeSettingValue(key, value);
      const result = await patchUserSettings({ [key]: normalized });
      if (!result.ok || !result.data) {
        set({ errorMessage: result.message ?? `Failed to save setting: ${key}` });
        return;
      }
      const overriddenKeys = Array.from(
        new Set([...get().overriddenKeys, key, ...result.data.changedKeys])
      );
      const next = buildEffectiveSettings(
        result.data.settings,
        get().workspaceSettings,
        overriddenKeys
      );
      set({
        userSettings: result.data.settings,
        overriddenKeys,
        effectiveSettings: next.effectiveSettings,
        sources: next.sources,
        errorMessage: null,
        lastConfigAudit: configAuditNotice(result.data.configAudit),
      });
    },

    patchWorkspaceSetting: async (key, value) => {
      if (!WORKSPACE_OVERRIDABLE_SETTING_KEYS.has(key)) {
        set({ errorMessage: `Workspace setting is not allowed to override protected key: ${key}` });
        return;
      }
      const normalized = normalizeSettingValue(key, value);
      const result = await patchWorkspaceSettings({
        [`deepcode.${key}`]: normalized,
      });
      if (!result.ok || !result.data) {
        set({ errorMessage: result.message ?? `Failed to save workspace setting: ${key}` });
        return;
      }
      const next = buildEffectiveSettings(
        get().userSettings,
        result.data.settings,
        get().overriddenKeys
      );
      set({
        workspaceSettings: result.data.settings,
        effectiveSettings: next.effectiveSettings,
        sources: next.sources,
        errorMessage: null,
      });
    },

    resetUserSetting: async (key) => {
      const result = await patchUserSettings({ [key]: null });
      if (!result.ok || !result.data) {
        set({ errorMessage: result.message ?? `Failed to reset setting: ${key}` });
        return;
      }
      const overriddenKeys = get().overriddenKeys.filter((k) => k !== key);
      const next = buildEffectiveSettings(
        result.data.settings,
        get().workspaceSettings,
        overriddenKeys
      );
      set({
        userSettings: result.data.settings,
        overriddenKeys,
        effectiveSettings: next.effectiveSettings,
        sources: next.sources,
        errorMessage: null,
        lastConfigAudit: configAuditNotice(result.data.configAudit),
      });
    },

    getSettingSource: (key) => get().sources[key] ?? 'default',
  };
});

export function useEditorOptions(): EditorEffectiveOptions {
  const tabSize = useSettingsStore((s) =>
    Number(s.effectiveSettings['editor.tabSize'] ?? 4)
  );
  const insertSpaces = useSettingsStore((s) =>
    Boolean(s.effectiveSettings['editor.insertSpaces'] ?? true)
  );
  const wordWrap = useSettingsStore((s) =>
    String(s.effectiveSettings['editor.wordWrap'] ?? 'off')
  );
  const fontSize = useSettingsStore((s) =>
    Number(s.effectiveSettings['editor.fontSize'] ?? 14)
  );
  const fontFamily = useSettingsStore((s) =>
    String(
      s.effectiveSettings['editor.fontFamily'] ??
        "Consolas, 'Courier New', monospace"
    )
  );
  const renderWhitespace = useSettingsStore((s) =>
    String(s.effectiveSettings['editor.renderWhitespace'] ?? 'none')
  );
  const theme = useSettingsStore((s) =>
    String(s.effectiveSettings['workbench.colorTheme'] ?? 'vs-dark')
  );

  return useMemo(
    () => ({
      tabSize,
      insertSpaces,
      wordWrap,
      fontSize,
      fontFamily,
      renderWhitespace,
      theme,
    }),
    [tabSize, insertSpaces, wordWrap, fontSize, fontFamily, renderWhitespace, theme]
  );
}
