/**
 * 设置状态管理
 *
 * 设计意图：
 *   1. 汇总默认设置、用户覆盖、工作区覆盖三层配置；
 *   2. 对外暴露 Monaco 编辑器可直接消费的 effective settings；
 *   3. 统一封装用户设置与工作区 deepcode.* 设置写回。
 */
import { create } from 'zustand';
import { useMemo } from 'react';
import {
  DEFAULT_USER_SETTINGS,
  type UserSettingValue,
  type UserSettings,
} from '@deepcode/protocol';
import {
  getUserSettings,
  patchUserSettings,
  patchWorkspaceSettings,
} from '../services/runtimeAdapter';

// ---- 类型定义 ----

export type SettingSource = 'default' | 'user' | 'workspace';

export type SettingControlType = 'boolean' | 'number' | 'text' | 'select';

export interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  group: 'editor' | 'files' | 'keyboard' | 'explorer' | 'workbench';
  control: SettingControlType;
  options?: Array<{ label: string; value: string }>;
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

// ---- 设置定义 ----

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'editor.tabSize',
    label: 'Tab Size',
    description: '编辑器缩进宽度。',
    group: 'editor',
    control: 'number',
  },
  {
    key: 'editor.insertSpaces',
    label: 'Insert Spaces',
    description: '按 Tab 时插入空格而非制表符。',
    group: 'editor',
    control: 'boolean',
  },
  {
    key: 'editor.wordWrap',
    label: 'Word Wrap',
    description: '编辑器自动换行策略。',
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
    description: '编辑器字体大小。',
    group: 'editor',
    control: 'number',
  },
  {
    key: 'editor.fontFamily',
    label: 'Font Family',
    description: '编辑器字体族。',
    group: 'editor',
    control: 'text',
  },
  {
    key: 'editor.renderWhitespace',
    label: 'Render Whitespace',
    description: '空白字符显示策略。',
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
    description: '文件自动保存策略。',
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
    description: '自动保存延迟，单位毫秒。',
    group: 'files',
    control: 'number',
  },
  {
    key: 'files.hotExit',
    label: 'Hot Exit',
    description: '刷新或重启后保留未保存草稿，再次打开文件时恢复。',
    group: 'files',
    control: 'boolean',
  },
  {
    key: 'keyboard.enableBasicShortcuts',
    label: 'Basic Shortcuts',
    description: '启用 Ctrl+S 保存、Ctrl+Shift+S 全部保存、Ctrl+, 打开设置等基础快捷键。',
    group: 'keyboard',
    control: 'boolean',
  },
  {
    key: 'explorer.confirmDelete',
    label: 'Confirm Delete',
    description: '删除资源前是否确认。',
    group: 'explorer',
    control: 'boolean',
  },
  {
    key: 'workbench.colorTheme',
    label: 'Color Theme',
    description: '工作台主题。',
    group: 'workbench',
    control: 'select',
    options: [
      { label: 'Dark', value: 'vs-dark' },
      { label: 'Light', value: 'vs-light' },
    ],
  },
];

const KNOWN_SETTING_KEYS = new Set(Object.keys(DEFAULT_USER_SETTINGS));

// ---- 合并与标准化 ----

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
  if (typeof defaultValue === 'boolean') {
    return Boolean(value);
  }
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
    if (!KNOWN_SETTING_KEYS.has(key)) continue;
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

// ---- Store ----

export const useSettingsStore = create<SettingsStore>((set, get) => {
  const initialEffective = buildEffectiveSettings(
    DEFAULT_USER_SETTINGS,
    {},
    []
  );

  return {
    userSettings: DEFAULT_USER_SETTINGS,
    workspaceSettings: {},
    effectiveSettings: initialEffective.effectiveSettings,
    sources: initialEffective.sources,
    overriddenKeys: [],
    storePath: null,
    loading: false,
    errorMessage: null,

    loadUserSettings: async () => {
      if (get().loading) return;
      set({ loading: true, errorMessage: null });
      const result = await getUserSettings();
      if (!result.ok || !result.data) {
        set({
          loading: false,
          errorMessage: result.message ?? '加载用户设置失败',
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
        set({ errorMessage: result.message ?? `保存设置失败: ${key}` });
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
      });
    },

    patchWorkspaceSetting: async (key, value) => {
      const normalized = normalizeSettingValue(key, value);
      const result = await patchWorkspaceSettings({
        [`deepcode.${key}`]: normalized,
      });
      if (!result.ok || !result.data) {
        set({ errorMessage: result.message ?? `保存工作区设置失败: ${key}` });
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
        set({ errorMessage: result.message ?? `恢复默认失败: ${key}` });
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
      });
    },

    getSettingSource: (key) => get().sources[key] ?? 'default',
  };
});

/**
 * Monaco 编辑器有效选项 hook（阶段 5 / S5-2）
 *
 * 实现要点：
 *   - **不要**在单个 selector 中返回新对象，会触发 React 18 + Zustand "getSnapshot
 *     should be cached" 无限重渲染或在 release 模式下静默崩溃黑屏。
 *   - 拆为多个原始值 selector：每个 selector 返回 number / boolean / string，
 *     Zustand 默认 Object.is 比较，原始值天然稳定。
 *   - 用 useMemo 把这些原始值聚合成稳定对象，供 CodeEditor.tsx 单次 useEffect 消费。
 */
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
