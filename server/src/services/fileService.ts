/**
 * 文件操作服务
 * 提供工作区目录树、文件读取、文件写入功能
 * 安全约束：
 *   1. 所有路径都必须落在 WORKSPACE_ROOT 之内，使用 path.relative 防穿越
 *   2. 默认 WORKSPACE_ROOT 指向项目根下的 ./workspace 子目录，避免 Agent 修改自身仓库
 *   3. 文件读取设有大小阈值，二进制内容不返回给前端
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve, normalize, relative, isAbsolute, sep } from 'node:path';
import type {
  FileTreeNode,
  FileReadResult,
  FileWriteResult,
} from '@deepcode/protocol';

// ---- 常量与工作区根目录 ----

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
]);

/**
 * 解析工作区根目录
 * 优先级：
 *   1. WORKSPACE_ROOT 环境变量（绝对路径或相对当前进程工作目录）
 *   2. 进程工作目录下的 ./workspace 子目录
 * 不再回落到 process.cwd() 本身，避免 Agent 写入仓库自身
 */
function resolveWorkspaceRoot(): string {
  const envRoot = process.env.WORKSPACE_ROOT;
  if (envRoot && envRoot.trim() !== '') {
    return normalize(resolve(process.cwd(), envRoot));
  }
  return normalize(resolve(process.cwd(), 'workspace'));
}

const WORKSPACE_ROOT = resolveWorkspaceRoot();

/**
 * 获取当前工作区根目录（供路由层日志或调试使用）
 */
export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

// ---- 路径安全 ----

/**
 * 把用户传入的相对路径解析为绝对路径，并保证落在 WORKSPACE_ROOT 之内。
 * 防穿越策略：使用 path.relative 比对结果不能以 .. 开头，也不能是绝对路径。
 *
 * @throws 路径越界、路径包含非法字符等情况抛出 Error
 */
function safePath(inputPath: string | undefined): string {
  // 空路径表示工作区根
  const raw = inputPath ?? '';

  // 用户不应传入绝对路径；统一按相对工作区根处理
  if (isAbsolute(raw)) {
    throw new Error(`不允许使用绝对路径: ${inputPath}`);
  }

  const absolute = normalize(resolve(WORKSPACE_ROOT, raw));
  const rel = relative(WORKSPACE_ROOT, absolute);

  // path.relative 返回 "" / "subdir" / "../foo"；带 .. 即越界
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径穿越检测: ${inputPath}`);
  }

  return absolute;
}

/**
 * 把绝对路径转换为前端使用的 POSIX 风格相对路径
 */
function toRelativePosix(absolutePath: string): string {
  const rel = relative(WORKSPACE_ROOT, absolutePath);
  return rel.split(sep).join('/');
}

// ---- 目录树 ----

/**
 * 读取目录树
 * @param relativePath 相对工作区的路径，默认为根目录
 * @param maxDepth 最大递归深度，默认 3
 */
export async function readDirectoryTree(
  relativePath?: string,
  maxDepth: number = 3
): Promise<FileTreeNode[]> {
  // 工作区根目录必须存在；不存在时自动创建空目录，避免首次启动 500
  await mkdir(WORKSPACE_ROOT, { recursive: true });

  const targetPath = safePath(relativePath);
  return readDirRecursive(targetPath, maxDepth);
}

async function readDirRecursive(
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
    // 隐藏文件（以 . 开头）和黑名单目录直接跳过
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIR_NAMES.has(entry.name)) continue;

    const entryAbsolutePath = join(absolutePath, entry.name);
    const entryRelativePath = toRelativePosix(entryAbsolutePath);

    if (entry.isDirectory()) {
      const children = await readDirRecursive(entryAbsolutePath, depth - 1);
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
    // 其他类型（symlink / fifo / socket）暂不展示
  }

  return nodes;
}

// ---- 文件读写 ----

/**
 * 简单的二进制内容嗅探：前 1024 字节内出现空字节即视为二进制
 */
function looksBinary(buffer: Buffer): boolean {
  const sniffLen = Math.min(buffer.length, 1024);
  for (let i = 0; i < sniffLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * 读取文件内容
 * 大文件返回提示而非原始内容；二进制文件返回 binary=true 且 content 为空
 */
export async function readFileContent(
  relativePath: string
): Promise<FileReadResult> {
  const absolutePath = safePath(relativePath);
  const fileStat = await stat(absolutePath);

  if (!fileStat.isFile()) {
    throw new Error(`目标不是文件: ${relativePath}`);
  }

  const sizeBytes = fileStat.size;
  const posixPath = toRelativePosix(absolutePath);

  // ---- 1. 文件超出阈值：不读内容，由前端展示提示 ----
  if (sizeBytes > READ_SIZE_LIMIT_BYTES) {
    return {
      path: posixPath,
      content: `// 文件过大（${sizeBytes} 字节，阈值 ${READ_SIZE_LIMIT_BYTES} 字节），暂不直接打开。\n// 请在阶段 5 接入 Monaco 后查看。`,
      sizeBytes,
      binary: false,
    };
  }

  // ---- 2. 读取原始 buffer，做二进制嗅探 ----
  const buffer = await readFile(absolutePath);
  if (looksBinary(buffer)) {
    return {
      path: posixPath,
      content: '',
      sizeBytes,
      binary: true,
    };
  }

  return {
    path: posixPath,
    content: buffer.toString('utf-8'),
    sizeBytes,
    binary: false,
  };
}

/**
 * 写入文件内容
 * 自动创建不存在的父目录
 */
export async function writeFileContent(
  relativePath: string,
  content: string
): Promise<FileWriteResult> {
  const absolutePath = safePath(relativePath);

  const sizeBytes = Buffer.byteLength(content, 'utf-8');
  if (sizeBytes > WRITE_SIZE_LIMIT_BYTES) {
    throw new Error(
      `写入内容过大（${sizeBytes} 字节，阈值 ${WRITE_SIZE_LIMIT_BYTES} 字节）`
    );
  }

  // 确保父目录存在
  const dir = join(absolutePath, '..');
  await mkdir(dir, { recursive: true });

  await writeFile(absolutePath, content, 'utf-8');

  return {
    path: toRelativePosix(absolutePath),
    saved: true,
    sizeBytes,
  };
}
