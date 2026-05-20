/**
 * 工作区服务
 *
 * 职责：
 *   1. 启动时根据环境变量决定 fallback 工作区（DEEPCODE_WORKSPACE，缺省为 ./workspace）；
 *   2. 解析 .code-workspace 文件 / 普通目录为 WorkspaceSpec；
 *   3. 维护当前活动工作区与 fallbackUsed / lastError 状态；
 *   4. 提供 folderId -> 绝对路径的解析；
 *   5. 提供 patchSettings 入口（首期仅在内存合并，不落盘）。
 *
 * 安全约束：
 *   - 解析 .code-workspace 中相对路径时以该文件所在目录为基准；
 *   - folders[].path 解析后必须是已存在的目录；不存在时该 folder 被丢弃，并写入 lastError；
 *   - openWorkspace 接收的绝对路径仅在该路由放行；后续文件读写全部按 folderId 锁定在 folder 之内。
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  resolve,
  extname,
} from 'node:path';
import type {
  WorkspaceFolderSpec,
  WorkspaceSourceKind,
  WorkspaceSpec,
  WorkspaceState,
  WorkspaceSummary,
  UnsupportedField,
} from '@deepcode/protocol';

// ---- 常量 ----

/** 当前已知不解析、但向 UI 提示的字段（VSCode .code-workspace 兼容） */
const UNSUPPORTED_TOP_LEVEL_KEYS = [
  'extensions',
  'tasks',
  'launch',
  'remoteAuthority',
] as const;

/** DeepCode 工作区设置的命名空间前缀；只有该前缀的键会被纳入 workspace.settings */
const DEEPCODE_SETTINGS_PREFIX = 'deepcode.';

/** fallback 工作区目录名 */
const FALLBACK_WORKSPACE_DIR = 'workspace';

// ---- 内部状态 ----

let currentWorkspace: WorkspaceSpec | null = null;
let fallbackUsed = false;
let lastError: string | null = null;
let openCounter = 0;

// ---- helper ----

/** 将本机绝对路径转为 POSIX 风格（仅用于展示） */
function toPosix(abs: string): string {
  return abs.split('\\').join('/');
}

/** 读取并解析 .code-workspace JSON 文件；失败抛出 Error */
function parseCodeWorkspaceFile(filePath: string): {
  folders: Array<{ path: string; name?: string }>;
  settings: Record<string, unknown>;
  unsupported: UnsupportedField[];
} {
  const raw = readFileSync(filePath, 'utf-8');
  // .code-workspace 允许 JSONC（带注释 / 尾随逗号）；首期仅做最小宽容处理：
  // 去除以 // 开头的整行注释 + /* ... */ 块注释。复杂场景留作后续扩展。
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(
      `.code-workspace JSON 解析失败: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const rawFolders = Array.isArray(parsed.folders)
    ? (parsed.folders as Array<{ path: string; name?: string }>)
    : [];
  if (rawFolders.length === 0) {
    throw new Error('.code-workspace 中未声明任何 folders');
  }

  const settings: Record<string, unknown> = {};
  if (parsed.settings && typeof parsed.settings === 'object') {
    for (const [k, v] of Object.entries(parsed.settings as Record<string, unknown>)) {
      if (k.startsWith(DEEPCODE_SETTINGS_PREFIX)) {
        settings[k] = v;
      }
    }
  }

  const unsupported: UnsupportedField[] = [];
  for (const key of UNSUPPORTED_TOP_LEVEL_KEYS) {
    if (key in parsed) {
      unsupported.push({
        key,
        kind: Array.isArray(parsed[key])
          ? 'array'
          : typeof parsed[key] === 'object'
            ? 'object'
            : typeof parsed[key],
      });
    }
  }

  return { folders: rawFolders, settings, unsupported };
}

/** 把 folders[] 解析为绝对路径并校验存在性 */
function resolveFolders(
  rawFolders: Array<{ path: string; name?: string }>,
  baseDir: string
): { folders: WorkspaceFolderSpec[]; warnings: string[] } {
  const result: WorkspaceFolderSpec[] = [];
  const warnings: string[] = [];
  rawFolders.forEach((entry, idx) => {
    const original = entry.path;
    const absoluteRaw = isAbsolute(original)
      ? normalize(original)
      : normalize(resolve(baseDir, original));

    if (!existsSync(absoluteRaw)) {
      warnings.push(`folder 路径不存在已忽略: ${original}`);
      return;
    }
    const st = statSync(absoluteRaw);
    if (!st.isDirectory()) {
      warnings.push(`folder 路径不是目录已忽略: ${original}`);
      return;
    }
    const name = entry.name ?? basename(absoluteRaw);
    result.push({
      id: `wf-${idx}`,
      name,
      absolutePath: toPosix(absoluteRaw),
      originalPath: original,
      isAbsolute: isAbsolute(original),
    });
  });
  return { folders: result, warnings };
}

/** 构造一个目录型 WorkspaceSpec */
function buildDirectoryWorkspace(absoluteDir: string): WorkspaceSpec {
  openCounter += 1;
  return {
    id: `ws-${openCounter}`,
    name: basename(absoluteDir),
    source: 'directory',
    sourcePath: null,
    folders: [
      {
        id: 'wf-0',
        name: basename(absoluteDir),
        absolutePath: toPosix(absoluteDir),
        originalPath: absoluteDir,
        isAbsolute: true,
      },
    ],
    settings: {},
    unsupportedFields: [],
    openedAt: new Date().toISOString(),
  };
}

/** 构造一个 .code-workspace 型 WorkspaceSpec */
function buildCodeWorkspace(filePath: string): WorkspaceSpec {
  const { folders, settings, unsupported } = parseCodeWorkspaceFile(filePath);
  const baseDir = dirname(filePath);
  const { folders: resolved, warnings } = resolveFolders(folders, baseDir);
  // 把本次解析产生的 warnings 合并到模块级 lastError；
  // 由调用方在解析前重置 lastError，避免跨 open 累积。
  if (warnings.length > 0) {
    lastError = warnings.join('\n');
  }
  if (resolved.length === 0) {
    throw new Error('.code-workspace 中所有 folders 路径都无效，无法打开工作区');
  }
  openCounter += 1;
  const wsName = basename(filePath).replace(/\.code-workspace$/i, '');
  return {
    id: `ws-${openCounter}`,
    name: wsName || basename(baseDir),
    source: 'code-workspace',
    sourcePath: toPosix(filePath),
    folders: resolved,
    settings,
    unsupportedFields: unsupported,
    openedAt: new Date().toISOString(),
  };
}

/** 解析路径并判定是 .code-workspace 文件还是目录 */
function classifyTarget(absolutePath: string): WorkspaceSourceKind {
  if (!existsSync(absolutePath)) {
    throw new Error(`路径不存在: ${absolutePath}`);
  }
  const st = statSync(absolutePath);
  if (st.isFile()) {
    if (extname(absolutePath).toLowerCase() === '.code-workspace') {
      return 'code-workspace';
    }
    throw new Error(`不支持的文件类型，需要目录或 .code-workspace 文件: ${absolutePath}`);
  }
  if (st.isDirectory()) {
    return 'directory';
  }
  throw new Error(`既不是文件也不是目录: ${absolutePath}`);
}

// ---- public API ----

/**
 * 启动时初始化 fallback 工作区。
 *
 * 优先级：
 *   1. 环境变量 DEEPCODE_WORKSPACE 指定的绝对/相对路径
 *   2. ./workspace 子目录（自动创建）
 */
export function loadInitialWorkspace(): WorkspaceSpec {
  lastError = null;
  const envRoot = process.env.DEEPCODE_WORKSPACE;
  let target: string;
  if (envRoot && envRoot.trim() !== '') {
    target = isAbsolute(envRoot)
      ? normalize(envRoot)
      : normalize(resolve(process.cwd(), envRoot));
  } else {
    target = normalize(resolve(process.cwd(), FALLBACK_WORKSPACE_DIR));
  }

  // 不存在时自动创建（fallback 行为）
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }
  const st = statSync(target);
  if (!st.isDirectory()) {
    throw new Error(`DEEPCODE_WORKSPACE 必须指向目录: ${target}`);
  }

  currentWorkspace = buildDirectoryWorkspace(target);
  // fallback 工作区 ID 固定为 'fallback'，与多次 open 区分
  currentWorkspace = { ...currentWorkspace, id: 'fallback' };
  fallbackUsed = true;
  return currentWorkspace;
}

/**
 * 用户主动打开工作区。
 *
 * 接受 .code-workspace 文件 或 目录的**绝对路径**；
 * 该路由是工作区入口，是 /api/files/* 之外唯一接受绝对路径的位置。
 */
export function openWorkspace(absolutePath: string): WorkspaceSpec {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`openWorkspace 仅接受绝对路径，收到: ${absolutePath}`);
  }
  const normalized = normalize(absolutePath);
  lastError = null;
  const kind = classifyTarget(normalized);
  let spec: WorkspaceSpec;
  if (kind === 'code-workspace') {
    spec = buildCodeWorkspace(normalized);
  } else {
    spec = buildDirectoryWorkspace(normalized);
  }
  currentWorkspace = spec;
  fallbackUsed = false;
  return spec;
}

/** 获取当前活动工作区；启动后必然存在 */
export function getCurrentWorkspace(): WorkspaceSpec {
  if (!currentWorkspace) {
    throw new Error('工作区尚未初始化，请先调用 loadInitialWorkspace');
  }
  return currentWorkspace;
}

/** 获取工作区状态包装（含 fallbackUsed / lastError） */
export function getWorkspaceState(): WorkspaceState {
  return {
    current: getCurrentWorkspace(),
    fallbackUsed,
    lastError,
  };
}

/** 摘要：用于健康检查与启动日志 */
export function getWorkspaceSummary(): WorkspaceSummary {
  const ws = getCurrentWorkspace();
  return {
    id: ws.id,
    name: ws.name,
    source: ws.source,
    folderCount: ws.folders.length,
  };
}

/**
 * 解析 folderId -> 绝对路径。
 *
 * 不传 folderId 时返回 folders[0]，与前端"无 folderId 时使用首个 folder"约定一致。
 *
 * @throws folderId 不存在时抛出 Error
 */
export function resolveFolder(folderId?: string): WorkspaceFolderSpec {
  const ws = getCurrentWorkspace();
  if (!folderId) {
    return ws.folders[0];
  }
  const target = ws.folders.find((f) => f.id === folderId);
  if (!target) {
    throw new Error(`未知 folderId: ${folderId}`);
  }
  return target;
}

/**
 * 合并 DeepCode 命名空间设置。
 *
 * 仅允许 'deepcode.' 前缀的键；其他键被拒绝以避免污染 VSCode 通用配置；
 * 首期仅在内存合并，不落盘到 .code-workspace（落盘策略待后续阶段决定）。
 */
export function patchWorkspaceSettings(
  patch: Record<string, unknown>
): Record<string, unknown> {
  const ws = getCurrentWorkspace();
  const next: Record<string, unknown> = { ...ws.settings };
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!k.startsWith(DEEPCODE_SETTINGS_PREFIX)) {
      rejected.push(k);
      continue;
    }
    next[k] = v;
  }
  if (rejected.length > 0) {
    throw new Error(
      `仅允许 'deepcode.' 前缀的设置键；被拒绝: ${rejected.join(', ')}`
    );
  }
  currentWorkspace = { ...ws, settings: next };
  return next;
}
