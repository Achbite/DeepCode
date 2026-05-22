/**
 * 文件操作服务
 *
 * 设计要点：
 *   - 按 folderId 在每次调用时解析根目录；状态由 workspaceService 管理；
 *   - 路径安全：所有相对路径解析后必须落在 folder.absolutePath 之内；
 *   - 大文件 / 二进制 / 写入大小阈值 / 目录树节点上限与 Tauri Rust 端 fs.rs 对齐。
 */
import { readdir, readFile, writeFile, mkdir, stat, access, rename } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve, normalize, relative, isAbsolute, sep } from 'node:path';
import type {
  FileTreeNode,
  FileReadResult,
  FileWriteResult,
  CreateFolderResult,
  RenameEntryResult,
} from '@deepcode/protocol';
import { resolveFolder } from './workspaceService.js';

// ---- 常量 ----

/** 文件读取大小阈值；超过此值返回提示信息而不灌入 content */
const READ_SIZE_LIMIT_BYTES = 16 * 1024 * 1024; // 16 MiB

/** 写入大小阈值（防止前端误传超大内容） */
const WRITE_SIZE_LIMIT_BYTES = 16 * 1024 * 1024; // 16 MiB

/** 目录树最大递归深度；防止 monorepo 深目录把响应撑爆 */
const MAX_TREE_DEPTH = 6;

/** 目录树最大总节点数；超过即截断，避免一次性给前端 megabyte 级 JSON */
const MAX_TREE_NODES = 5000;

/** 默认排除的目录名（不递归进入） */
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.vite',
  '.cache',
  '.venv',
  '__pycache__',
  'target',
]);

// ---- 路径安全 ----

/**
 * 把用户传入的相对路径解析为绝对路径，并保证落在 folder root 之内。
 *
 * @param folderRoot folder 的绝对路径（POSIX 风格亦可，内部会再 normalize）
 * @param inputPath  相对 folder root 的 POSIX 路径
 * @throws 路径越界、绝对路径输入、Windows 盘符前缀、含 NUL 字节等情况抛出 Error
 */
function safePath(folderRoot: string, inputPath: string | undefined): string {
  const raw = inputPath ?? '';
  if (raw.includes('\0')) {
    throw new Error(`路径含非法字符: ${inputPath}`);
  }
  if (isAbsolute(raw)) {
    throw new Error(`不允许使用绝对路径: ${inputPath}`);
  }
  // 顯式拒绝 Windows 盘符前缀（举例："C:foo"在 Windows 上会被 resolve 误作盘符相对路径）
  if (/^[a-zA-Z]:/.test(raw)) {
    throw new Error(`不允许使用含盘符前缀的路径: ${inputPath}`);
  }
  const root = normalize(folderRoot);
  const absolute = normalize(resolve(root, raw));
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径穿越检测: ${inputPath}`);
  }
  return absolute;
}

/** 把绝对路径转换为前端使用的 POSIX 风格相对路径（相对于 folder root） */
function toRelativePosix(folderRoot: string, absolutePath: string): string {
  const rel = relative(normalize(folderRoot), absolutePath);
  return rel.split(sep).join('/');
}

// ---- 目录树 ----

/**
 * 读取目录树
 *
 * @param folderId 目标 WorkspaceFolder id；省略使用首个 folder
 * @param relativePath 起始相对路径，默认为 folder 根
 * @param maxDepth 最大递归深度，默认 6；上限为 MAX_TREE_DEPTH
 */
export async function readDirectoryTree(
  folderId: string | undefined,
  relativePath?: string,
  maxDepth: number = MAX_TREE_DEPTH
): Promise<FileTreeNode[]> {
  const folder = resolveFolder(folderId);
  const folderRoot = folder.absolutePath;

  // folder root 必须存在；不存在时自动创建（fallback 工作区可能首次启动）
  await mkdir(folderRoot, { recursive: true });

  const targetPath = safePath(folderRoot, relativePath);
  // 节点计数器随递归传递；超过 MAX_TREE_NODES 即截断
  const counter = { count: 0 };
  return readDirRecursive(folderRoot, targetPath, Math.min(maxDepth, MAX_TREE_DEPTH), counter);
}

async function readDirRecursive(
  folderRoot: string,
  absolutePath: string,
  depth: number,
  counter: { count: number }
): Promise<FileTreeNode[]> {
  if (depth <= 0) return [];
  if (counter.count >= MAX_TREE_NODES) return [];

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];

  // 排序：目录在前，文件在后；各自按名称排序
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (counter.count >= MAX_TREE_NODES) break;
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIR_NAMES.has(entry.name)) continue;

    const entryAbsolutePath = join(absolutePath, entry.name);
    const entryRelativePath = toRelativePosix(folderRoot, entryAbsolutePath);

    if (entry.isDirectory()) {
      const children = await readDirRecursive(
        folderRoot,
        entryAbsolutePath,
        depth - 1,
        counter
      );
      counter.count += 1;
      nodes.push({
        name: entry.name,
        path: entryRelativePath,
        type: 'directory',
        children,
      });
    } else if (entry.isFile()) {
      counter.count += 1;
      nodes.push({
        name: entry.name,
        path: entryRelativePath,
        type: 'file',
      });
    }
  }
  return nodes;
}

// ---- 文件读写 ----

/** 简单的二进制内容嗅探：前 1024 字节内出现空字节即视为二进制 */
function looksBinary(buffer: Buffer): boolean {
  const sniffLen = Math.min(buffer.length, 1024);
  for (let i = 0; i < sniffLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * 读取文件内容
 *
 * 大文件返回提示而非原始内容；二进制文件返回 binary=true 且 content 为空。
 */
export async function readFileContent(
  folderId: string | undefined,
  relativePath: string
): Promise<FileReadResult> {
  const folder = resolveFolder(folderId);
  const folderRoot = folder.absolutePath;
  const absolutePath = safePath(folderRoot, relativePath);
  const fileStat = await stat(absolutePath);

  if (!fileStat.isFile()) {
    throw new Error(`目标不是文件: ${relativePath}`);
  }

  const sizeBytes = fileStat.size;
  const posixPath = toRelativePosix(folderRoot, absolutePath);

  if (sizeBytes > READ_SIZE_LIMIT_BYTES) {
    return {
      folderId: folder.id,
      path: posixPath,
      content: `// 文件过大（${sizeBytes} 字节，阈值 ${READ_SIZE_LIMIT_BYTES} 字节），已自动切换到只读提示模式。`,
      sizeBytes,
      binary: false,
    };
  }

  const buffer = await readFile(absolutePath);
  if (looksBinary(buffer)) {
    return {
      folderId: folder.id,
      path: posixPath,
      content: '',
      sizeBytes,
      binary: true,
    };
  }

  return {
    folderId: folder.id,
    path: posixPath,
    content: buffer.toString('utf-8'),
    sizeBytes,
    binary: false,
  };
}

/**
 * 写入文件内容
 *
 * 自动创建不存在的父目录；写入前检查大小阈值。
 */
export async function writeFileContent(
  folderId: string | undefined,
  relativePath: string,
  content: string
): Promise<FileWriteResult> {
  const folder = resolveFolder(folderId);
  const folderRoot = folder.absolutePath;
  const absolutePath = safePath(folderRoot, relativePath);

  const sizeBytes = Buffer.byteLength(content, 'utf-8');
  if (sizeBytes > WRITE_SIZE_LIMIT_BYTES) {
    throw new Error(
      `写入内容过大（${sizeBytes} 字节，阈值 ${WRITE_SIZE_LIMIT_BYTES} 字节）`
    );
  }

  const dir = join(absolutePath, '..');
  await mkdir(dir, { recursive: true });
  await writeFile(absolutePath, content, 'utf-8');

  return {
    folderId: folder.id,
    path: toRelativePosix(folderRoot, absolutePath),
    saved: true,
    sizeBytes,
  };
}

// ---- 新建文件 / 新建目录（阶段 4 / S4-1）----

/**
 * 新建文件
 *
 * 语义与 VSCode 一致：路径已存在时报错（`file_already_exists`），不覆盖。
 * 需要覆盖请走 writeFileContent。
 * 父目录不存在时递归创建，与 VSCode New File 体验一致。
 */
export async function createFile(
  folderId: string | undefined,
  relativePath: string,
  initialContent: string = ''
): Promise<FileWriteResult> {
  if (!relativePath || relativePath.trim() === '') {
    throw new Error('路径不能为空');
  }
  const folder = resolveFolder(folderId);
  const folderRoot = folder.absolutePath;
  const absolutePath = safePath(folderRoot, relativePath);

  // 存在性检查：文件或目录已存在则报错
  try {
    await access(absolutePath, fsConstants.F_OK);
    throw new Error(`file_already_exists: ${relativePath}`);
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') {
      // 已存在或其他错误直接上抛
      throw err;
    }
    // ENOENT 是预期状态，继续创建
  }

  const sizeBytes = Buffer.byteLength(initialContent, 'utf-8');
  if (sizeBytes > WRITE_SIZE_LIMIT_BYTES) {
    throw new Error(
      `写入内容过大（${sizeBytes} 字节，阈值 ${WRITE_SIZE_LIMIT_BYTES} 字节）`
    );
  }

  const dir = join(absolutePath, '..');
  await mkdir(dir, { recursive: true });
  await writeFile(absolutePath, initialContent, 'utf-8');

  return {
    folderId: folder.id,
    path: toRelativePosix(folderRoot, absolutePath),
    saved: true,
    sizeBytes,
  };
}

/**
 * 新建目录（递归创建中间目录）
 *
 * 与 VSCode 一致：使用 mkdir recursive；路径已存在为目录时返回 created=false 不报错；
 * 路径已存在为文件时报错 file_already_exists。
 */
export async function createFolderEntry(
  folderId: string | undefined,
  relativePath: string
): Promise<CreateFolderResult> {
  if (!relativePath || relativePath.trim() === '') {
    throw new Error('路径不能为空');
  }
  const folder = resolveFolder(folderId);
  const folderRoot = folder.absolutePath;
  const absolutePath = safePath(folderRoot, relativePath);

  let created = true;
  try {
    const st = await stat(absolutePath);
    if (st.isFile()) {
      throw new Error(`file_already_exists: ${relativePath}`);
    }
    // 已存在为目录：mkdir recursive 幂等，标记 created=false
    created = false;
  } catch (err: any) {
    if (err && err.code && err.code !== 'ENOENT') {
      throw err;
    }
  }

  await mkdir(absolutePath, { recursive: true });

  return {
    folderId: folder.id,
    path: toRelativePosix(folderRoot, absolutePath),
    created,
  };
}

/**
 * 重命名文件或目录。
 *
 * 与 VSCode Explorer 基础语义一致：目标已存在时报错，不覆盖；允许在
 * 同一 WorkspaceFolder 内移动，但不能越出 folder root。
 */
export async function renameEntry(
  folderId: string | undefined,
  oldPath: string,
  newPath: string
): Promise<RenameEntryResult> {
  if (!oldPath || !newPath || oldPath.trim() === '' || newPath.trim() === '') {
    throw new Error('路径不能为空');
  }
  const folder = resolveFolder(folderId);
  const folderRoot = folder.absolutePath;
  const oldAbs = safePath(folderRoot, oldPath);
  const newAbs = safePath(folderRoot, newPath);

  await access(oldAbs, fsConstants.F_OK);
  try {
    await access(newAbs, fsConstants.F_OK);
    throw new Error(`file_already_exists: ${newPath}`);
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') {
      throw err;
    }
  }

  const parent = join(newAbs, '..');
  await mkdir(parent, { recursive: true });
  await rename(oldAbs, newAbs);

  return {
    folderId: folder.id,
    oldPath: toRelativePosix(folderRoot, oldAbs),
    newPath: toRelativePosix(folderRoot, newAbs),
    renamed: true,
  };
}
