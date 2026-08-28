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
import { activeT, settingText } from '../i18n';

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

type SettingDefinitionSchema = Omit<
  SettingDefinition,
  'label' | 'description' | 'options' | 'catalog'
> & {
  options?: string[];
};

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

const SETTING_DEFINITION_SCHEMAS: SettingDefinitionSchema[] = [
  {
    key: 'workbench.language',
    group: 'workbench',
    control: 'select',
    options: [
      'zh-CN',
      'en-US',
    ],
  },
  {
    key: 'workbench.colorTheme',
    group: 'workbench',
    control: 'select',
    options: [
      'vs-dark',
      'vs-light',
    ],
  },
  {
    key: 'workbench.styleTokenOverrides',
    group: 'workbench',
    control: 'text',
  },
  {
    key: 'gui.colorTheme',
    group: 'gui',
    control: 'select',
    options: [
      'system',
      'light',
      'dark',
    ],
  },
  {
    key: 'gui.accentColor',
    group: 'gui',
    control: 'select',
    options: [
      'blue',
      'purple',
      'green',
    ],
  },
  {
    key: 'gui.navigationDensity',
    group: 'gui',
    control: 'select',
    options: [
      'comfortable',
      'compact',
    ],
  },
  {
    key: 'gui.showContextRail',
    group: 'gui',
    control: 'boolean',
  },
  {
    key: 'editor.tabSize',
    group: 'editor',
    control: 'number',
  },
  {
    key: 'editor.insertSpaces',
    group: 'editor',
    control: 'boolean',
  },
  {
    key: 'editor.wordWrap',
    group: 'editor',
    control: 'select',
    options: [
      'off',
      'on',
      'wordWrapColumn',
      'bounded',
    ],
  },
  {
    key: 'editor.fontSize',
    group: 'editor',
    control: 'number',
  },
  {
    key: 'editor.fontFamily',
    group: 'editor',
    control: 'text',
  },
  {
    key: 'editor.renderWhitespace',
    group: 'editor',
    control: 'select',
    options: [
      'none',
      'boundary',
      'selection',
      'trailing',
      'all',
    ],
  },
  {
    key: 'files.autoSave',
    group: 'files',
    control: 'select',
    options: [
      'off',
      'afterDelay',
    ],
  },
  {
    key: 'files.autoSaveDelay',
    group: 'files',
    control: 'number',
  },
  {
    key: 'files.hotExit',
    group: 'files',
    control: 'boolean',
  },
  {
    key: 'keyboard.enableBasicShortcuts',
    group: 'keyboard',
    control: 'boolean',
  },
  {
    key: 'explorer.confirmDelete',
    group: 'explorer',
    control: 'boolean',
  },
  {
    key: 'terminal.integrated.defaultProfile.windows',
    group: 'terminal',
    control: 'select',
    options: [
      'wsl',
      'powershell',
      'cmd',
    ],
  },
  {
    key: 'terminal.integrated.prewarm',
    group: 'terminal',
    control: 'select',
    options: [
      'afterStartup',
      'off',
    ],
  },
  {
    key: 'terminal.integrated.spawnTimeoutMs',
    group: 'terminal',
    control: 'number',
  },
  {
    key: 'agent.systemPrompt',
    group: 'agent',
    control: 'textarea',
  },
  {
    key: 'agent.permissions.networkRead',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptionValues(),
  },
  {
    key: 'agent.permissions.external',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptionValues(),
  },
  {
    key: 'agent.web.search.endpointTemplate',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'agent.web.search.authHeaderName',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'agent.web.search.authSecretRef',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'skills.mounts',
    group: 'skills',
    control: 'text',
  },
  {
    key: 'mcp.servers',
    group: 'mcp',
    control: 'text',
  },
];

function permissionPolicyOptionValues(): string[] {
  return ['allow', 'ask', 'deny'];
}

function settingDefinitionFromSchema(schema: SettingDefinitionSchema): SettingDefinition {
  const text = settingText('en-US', schema.key);
  if (!text?.label || !text.description) {
    throw new Error(`setting_i18n_text_missing:${schema.key}`);
  }
  const options = schema.options?.map((value) => {
    const label = text.options?.[value];
    if (!label) throw new Error(`setting_i18n_option_missing:${schema.key}:${value}`);
    return { label, value };
  });
  return {
    ...schema,
    label: text.label,
    description: text.description,
    options,
  };
}

export const SETTING_DEFINITIONS: SettingDefinition[] =
  SETTING_DEFINITION_SCHEMAS.map(settingDefinitionFromSchema);

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
          errorMessage: result.message ?? activeT('settings.error.loadUser'),
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
        set({
          errorMessage: result.message ?? activeT('settings.error.saveUser', { key }),
        });
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
        set({ errorMessage: activeT('settings.error.protectedWorkspaceKey', { key }) });
        return;
      }
      const normalized = normalizeSettingValue(key, value);
      const result = await patchWorkspaceSettings({
        [`deepcode.${key}`]: normalized,
      });
      if (!result.ok || !result.data) {
        set({
          errorMessage: result.message ?? activeT('settings.error.saveWorkspace', { key }),
        });
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
        set({
          errorMessage: result.message ?? activeT('settings.error.resetUser', { key }),
        });
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
