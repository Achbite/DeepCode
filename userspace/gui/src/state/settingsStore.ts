import { create } from 'zustand';
import { useMemo } from 'react';
import {
  DEFAULT_USER_SETTINGS,
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
import {
  normalizeGuiAccentColor,
  normalizeGuiThemePreference,
} from '../theme/deepcodeGuiTheme';

export type SettingSource = 'default' | 'user' | 'workspace';

export type SettingControlType = 'boolean' | 'number' | 'text' | 'textarea' | 'select';

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
    | 'mcp';
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

interface SettingsStateData {
  userSettings: UserSettings;
  workspaceSettings: Record<string, unknown>;
  effectiveSettings: UserSettings;
  sources: Record<string, SettingSource>;
  overriddenKeys: string[];
  storePath: string | null;
  loading: boolean;
  restartRequired: boolean;
  errorMessage: string | null;
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
    key: 'gui.colorTheme',
    label: 'DeepCode-GUI Theme',
    description: 'Theme used by the lightweight DeepCode-GUI shell. It does not affect the editor workbench theme.',
    group: 'gui',
    control: 'select',
    options: [
      { label: 'System', value: 'system' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' },
    ],
  },
  {
    key: 'gui.accentColor',
    label: 'DeepCode-GUI Accent Color',
    description: 'Accent color used by interactive controls in the DeepCode-GUI shell.',
    group: 'gui',
    control: 'select',
    options: [
      { label: 'Blue', value: 'blue' },
      { label: 'Purple', value: 'purple' },
      { label: 'Green', value: 'green' },
    ],
  },
  {
    key: 'gui.navigationDensity',
    label: 'Navigation Density',
    description: 'Spacing used by the DeepCode-GUI navigation shell.',
    group: 'gui',
    control: 'select',
    options: [
      { label: 'Comfortable', value: 'comfortable' },
      { label: 'Compact', value: 'compact' },
    ],
  },
  {
    key: 'gui.showContextRail',
    label: 'Show Context Rail',
    description: 'Show the projection-only Todo and artifact rail in DeepCode-GUI.',
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
    key: 'agent.systemPrompt',
    label: 'System Prompt',
    description: 'Additional user-authored instructions shared by every DeepCode UI shell.',
    group: 'agent',
    control: 'textarea',
  },
  {
    key: 'agent.permissions.networkRead',
    label: 'Network Read',
    description: 'Default Kernel decision for public network read tools.',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptions(),
  },
  {
    key: 'agent.permissions.external',
    label: 'External Plugin Tools',
    description: 'Default Kernel decision for tool effects contributed by external plugins.',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptions(),
  },
  {
    key: 'agent.web.search.endpointTemplate',
    label: 'Web Search Endpoint Template',
    description: 'HTTP endpoint template containing {query} and optional {limit}.',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'agent.web.search.authHeaderName',
    label: 'Web Search Auth Header',
    description: 'Header name used with the configured search SecretRef.',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'agent.web.search.authSecretRef',
    label: 'Web Search Auth Secret',
    description: 'Secret reference used for the configured search endpoint.',
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
];

function permissionPolicyOptions(): Array<{ label: string; value: string }> {
  return [
    { label: 'Allow', value: 'allow' },
    { label: 'Ask every time', value: 'ask' },
    { label: 'Deny', value: 'deny' },
  ];
}

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

function definitionsForCatalog(entries: readonly SettingCatalogEntry[]): SettingDefinition[] {
  return entries.flatMap((entry) => {
    const definition = SETTING_DEFINITION_BY_KEY.get(entry.key);
    return definition ? [{ ...definition, catalog: entry }] : [];
  });
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
  if (key === 'gui.colorTheme') {
    return normalizeGuiThemePreference(value);
  }
  if (key === 'gui.accentColor') {
    return normalizeGuiAccentColor(value);
  }
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
  const normalizedUserSettings = Object.fromEntries(
    Object.entries(userSettings).map(([key, value]) => [
      key,
      KNOWN_SETTING_KEYS.has(key) ? normalizeSettingValue(key, value) : value,
    ])
  ) as UserSettings;
  const effectiveSettings: UserSettings = {
    ...DEFAULT_USER_SETTINGS,
    ...normalizedUserSettings,
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
    restartRequired: false,
    errorMessage: null,

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
        restartRequired: false,
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
        restartRequired: get().restartRequired || Boolean(result.data.restartRequired),
        errorMessage: null,
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
        restartRequired: get().restartRequired || Boolean(result.data.restartRequired),
        errorMessage: null,
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
