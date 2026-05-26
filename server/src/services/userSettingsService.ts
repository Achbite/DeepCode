/**
 * 用户设置服务（阶段 4 / S4-4）
 *
 * 职责：
 *   - 加载持久化文件 → 与 DEFAULT_USER_SETTINGS 浅合并 → 返回完整设置
 *   - 将 patch 合并到内存覆盖集 + 原子写文件
 *
 * 持久化路径（与平台约定一致）：
 *   - Linux/macOS/WSL: $XDG_CONFIG_HOME/deepcode/config/user/<user>/settings/user-settings.json
 *                      （未设 XDG_CONFIG_HOME 时落到 $HOME/.config/deepcode/）
 *   - Windows:        %APPDATA%/DeepCode/config/user/<user>/settings/user-settings.json
 *
 * 不在本阶段范围：Settings UI / 把这些值实时应用到 Monaco 选项 / 工作区级覆盖
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_USER_SETTINGS,
  type UserSettings,
  type UserSettingValue,
  type GetUserSettingsResult,
  type PatchUserSettingsResult,
} from '@deepcode/protocol';
import { resolveDeepCodeSettingsDir } from './appDataPath.js';
import { atomicWriteJsonFile } from './persistentFileService.js';

// ---- 路径解析 ----

function resolveStorePath(): string {
  return join(resolveDeepCodeSettingsDir(), 'user-settings.json');
}

const STORE_PATH = resolveStorePath();

// ---- 内存态：用户覆盖 ----

/**
 * 仅保存"用户实际写入"的 key；从默认值派生的 key 不进入 overrides，
 * 这样默认值未来调整时已发布产物的体验也跟着变化（与 VSCode 行为一致）。
 */
let overrides: UserSettings = {};
let loaded = false;

// ---- 加载 ----

async function loadIfNeeded(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // 仅接收已知 value 类型，丢弃 undefined / 函数 / 嵌套对象
      const safe: UserSettings = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean' ||
          v === null
        ) {
          safe[k] = v as UserSettingValue;
        }
      }
      overrides = safe;
    }
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      // 首次启动文件不存在；保持空覆盖
      overrides = {};
    } else {
      // JSON 解析失败 / 权限问题：降级为空覆盖并保留错误日志，
      // 不阻塞 server 启动；用户后续 patch 会重写为合法 JSON。
      // eslint-disable-next-line no-console
      console.warn(`[userSettings] 加载持久化失败，降级为内存默认: ${err}`);
      overrides = {};
    }
  } finally {
    loaded = true;
  }
}

// ---- 合并 ----

function mergeWithDefaults(): UserSettings {
  return { ...DEFAULT_USER_SETTINGS, ...overrides };
}

// ---- 原子写 ----

async function persistOverrides(): Promise<void> {
  await atomicWriteJsonFile(STORE_PATH, overrides);
}

// ---- public API ----

export async function getUserSettings(): Promise<GetUserSettingsResult> {
  await loadIfNeeded();
  return {
    settings: mergeWithDefaults(),
    overriddenKeys: Object.keys(overrides),
    storePath: STORE_PATH,
  };
}

export async function patchUserSettings(
  patches: Record<string, UserSettingValue>
): Promise<PatchUserSettingsResult> {
  await loadIfNeeded();
  const before = mergeWithDefaults();
  const changedKeys: string[] = [];

  for (const [k, v] of Object.entries(patches)) {
    if (v === null) {
      // null = 恢复默认：从 overrides 移除
      if (k in overrides) {
        delete overrides[k];
        changedKeys.push(k);
      }
      continue;
    }
    if (
      typeof v !== 'string' &&
      typeof v !== 'number' &&
      typeof v !== 'boolean'
    ) {
      // 非法值类型：忽略；保留 server 不崩溃语义
      continue;
    }
    if (overrides[k] !== v) {
      overrides[k] = v;
    }
  }

  const after = mergeWithDefaults();
  for (const [k, v] of Object.entries(after)) {
    if (before[k] !== v && !changedKeys.includes(k)) {
      changedKeys.push(k);
    }
  }

  if (changedKeys.length > 0) {
    await persistOverrides();
  }

  return {
    settings: after,
    changedKeys,
  };
}
