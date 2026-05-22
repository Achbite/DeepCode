/**
 * 文件系统浏览服务（仅用于"Open Workspace"对话框）
 *
 * 设计要点：
 *   1. 该服务是平台中**唯一**接受任意绝对路径输入并列出其子项的入口；
 *      其余 /api/files/* 路由仍严格落在当前活动 WorkspaceFolder 之内。
 *   2. 仅做**只读**目录列举：返回 name / absolutePath / type / isCodeWorkspace / hidden；
 *      不返回文件大小、内容、修改时间，避免成为通用文件系统 API。
 *   3. 启动初始位置（initial-locations）只返回少量"安全的快捷起点"：
 *      用户主目录、Windows 盘符、当前活动工作区父目录。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  resolve,
  sep,
} from 'node:path';
import type {
  BrowseEntry,
  BrowsePathResult,
  InitialLocation,
  InitialLocations,
} from '@deepcode/protocol';
import { getCurrentWorkspace } from './workspaceService.js';

// ---- helper ----

/** 将绝对路径转为前端展示用的 POSIX 风格 */
function toPosix(abs: string): string {
  return abs.split('\\').join('/');
}

/** 是否为 .code-workspace 文件（不区分大小写） */
function isCodeWorkspaceFile(name: string): boolean {
  return /\.code-workspace$/i.test(name);
}

/** 计算父目录；位于根（如 'E:/' 或 '/'）时返回 null */
function computeParent(abs: string): string | null {
  const normalized = normalize(abs);
  const parent = dirname(normalized);
  // dirname 在 'E:\\' 下返回 'E:\\'；在 '/' 下返回 '/'，需要识别为根
  if (parent === normalized) return null;
  return toPosix(parent);
}

// ---- 列目录 ----

/**
 * 列出指定绝对路径下的子项。
 *
 * @param requestedPath 用户请求的绝对路径；空字符串或 undefined 时使用主目录
 * @throws 路径不存在 / 不是目录 / 不是绝对路径时抛出 Error
 */
export function browsePath(requestedPath: string | undefined): BrowsePathResult {
  // 入口规则：缺省时回到主目录
  const target = requestedPath && requestedPath.trim() !== ''
    ? requestedPath
    : homedir();

  if (!isAbsolute(target)) {
    throw new Error(`browsePath 仅接受绝对路径，收到: ${target}`);
  }

  const normalized = normalize(target);
  if (!existsSync(normalized)) {
    throw new Error(`路径不存在: ${normalized}`);
  }
  const st = statSync(normalized);
  if (!st.isDirectory()) {
    throw new Error(`路径不是目录: ${normalized}`);
  }

  const rawEntries = readdirSync(normalized, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  for (const dirent of rawEntries) {
    // 仅返回普通文件 / 目录；过滤 socket / fifo / device 等特殊节点
    let type: 'file' | 'directory';
    if (dirent.isDirectory()) {
      type = 'directory';
    } else if (dirent.isFile()) {
      type = 'file';
    } else {
      continue;
    }

    const childAbs = resolve(normalized, dirent.name);
    entries.push({
      name: dirent.name,
      absolutePath: toPosix(childAbs),
      type,
      isCodeWorkspace: type === 'file' && isCodeWorkspaceFile(dirent.name),
      hidden: dirent.name.startsWith('.'),
    });
  }

  // 排序：目录优先；其次 .code-workspace 文件；最后按名称升序（不区分大小写）
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (a.type === 'file') {
      if (a.isCodeWorkspace !== b.isCodeWorkspace) {
        return a.isCodeWorkspace ? -1 : 1;
      }
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    absolutePath: toPosix(normalized),
    parentPath: computeParent(normalized),
    entries,
  };
}

// ---- 初始位置 ----

/**
 * 返回对话框打开时推荐的起点列表。
 *
 * 顺序：
 *   1) 用户主目录（Home）
 *   2) Windows 平台下的逻辑盘符（仅探测 A-Z 范围内实际存在的盘符）
 *   3) 当前活动工作区根 / 父目录（便于在原工作区附近切换）
 */
export function getInitialLocations(): InitialLocations {
  const locations: InitialLocation[] = [];

  // 主目录
  const home = homedir();
  if (home && existsSync(home)) {
    locations.push({
      label: 'Home',
      absolutePath: toPosix(home),
      kind: 'home',
    });
  }

  // Windows 盘符
  if (platform() === 'win32') {
    for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
      const driveLetter = String.fromCharCode(code);
      const drivePath = `${driveLetter}:${sep}`;
      try {
        if (existsSync(drivePath)) {
          locations.push({
            label: `${driveLetter}:\\`,
            absolutePath: toPosix(drivePath),
            kind: 'drive',
          });
        }
      } catch {
        // 某些盘符（如未挂载的 CD-ROM）会抛错，静默跳过
      }
    }
  }

  // 当前活动工作区
  try {
    const ws = getCurrentWorkspace();
    if (ws && ws.folders.length > 0) {
      const first = ws.folders[0];
      locations.push({
        label: `Current Workspace · ${first.name}`,
        absolutePath: first.absolutePath,
        kind: 'workspace',
      });
      // 工作区父目录，方便切换"兄弟"工作区
      const parent = computeParent(first.absolutePath);
      if (parent) {
        locations.push({
          label: `Parent of ${basename(first.absolutePath)}`,
          absolutePath: parent,
          kind: 'workspace',
        });
      }
    }
  } catch {
    // 工作区尚未初始化时跳过
  }

  return {
    platform: platform(),
    locations,
  };
}
