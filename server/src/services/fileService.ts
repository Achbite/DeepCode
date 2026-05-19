/**
 * 文件操作服务
 *
 * 工作区模型升级版：
 *   - 不再依赖模块级 WORKSPACE_ROOT；改为按 folderId 在每次调用时解析根目录；
 *   - 路径安全：所有相对路径解析后必须落在 folder.absolutePath 之内；
 *   - 大文件 / 二进制 / 写入大小阈值与上版保持一致。
 *
 * 该文件不再持有任何"全局工作区"状态；状态由 workspaceService 管理。
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve, normalize, relative, isAbsolute, sep } from 'node:path';
import type {
  FileTreeNode,
  FileReadResult,
  FileWriteResult,
} from '@deepcode/protocol';
import { resolveFolder } from './workspaceService.js';

// ---- 常量 ----

/** 文件读取大小阈值；超过此值返回提示信息而不灌入 content */
const READ_SIZE_LIMIT_BYTES = 1024 * 1024; // 1 MiB

/** 写入大小阈值（防止前端误传超大内容） */
const WRITE_SIZE_LIMIT_BYTES = 8 * 1024 * 1024; // 8 MiB

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
 * @throws 路径越界、绝对路径输入等情况抛出 Error
 */
function safePath(folderRoot: string, inputPath: string | undefined): string {
  const raw = inputPath ?? '';
  if (isAbsolute(raw)) {
    throw new Error(`不允许使用绝对路径: ${inputPath}`);
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
 * @param maxDepth 最大递归深度，默认 3
 */
export async function readDirectoryTree(
  folderId: string | undefined,
  relativePath?: string,
  maxDepth: number = 3
): Promise<FileTreeNode[]> {
  const folder = resolveFolder(folderId);
  const folderRoot = folder.absolutePath;

  // folder root 必须存在；不存在时自动创建（fallback 工作区可能首次启动）
  await mkdir(folderRoot, { recursive: true });

  const targetPath = safePath(folderRoot, relativePath);
  return readDirRecursive(folderRoot, targetPath, maxDepth);
}

async function readDirRecursive(
  folderRoot: string,
  absolutePath: string,
  depth: number
): Promise<FileTreeNode[]> {
  if (depth <= 0) return [];

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];

  // 排序：目录在前，文件在后；各自按名称排序
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIR_NAMES.has(entry.name)) continue;

    const entryAbsolutePath = join(absolutePath, entry.name);
    const entryRelativePath = toRelativePosix(folderRoot, entryAbsolutePath);

    if (entry.isDirectory()) {
      const children = await readDirRecursive(
        folderRoot,
        entryAbsolutePath,
        depth - 1
      );
      nodes.push({
        name: entry.name,
        path: entryRelativePath,
        type: 'directory',
        children,
      });
    } else if (entry.isFile()) {
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
