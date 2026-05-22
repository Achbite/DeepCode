/**
 * 文件操作路由
 *
 * GET  /api/files/tree?folderId=&path=    - 获取目录树
 * GET  /api/files/read?folderId=&path=    - 读取文件内容
 * POST /api/files/write                   - 写入文件内容（folderId/path/content）
 * POST /api/files/create                  - 新建文件（已存在报错 file_already_exists）
 * POST /api/folders/create                - 新建目录（递归创建中间目录）
 *
 * 所有响应统一使用 ApiResponse<T> 包装；错误使用机器可读 error 字段。
 * 所有路径都基于 folderId 解析；不传 folderId 时使用当前工作区 folders[0]。
 */
import type { FastifyInstance } from 'fastify';
import {
  readDirectoryTree,
  readFileContent,
  writeFileContent,
  createFile,
  createFolderEntry,
  renameEntry,
} from '../services/fileService.js';
import type {
  ApiResponse,
  FileTreeNode,
  FileTreeQuery,
  FileReadQuery,
  FileWriteRequest,
  FileReadResult,
  FileWriteResult,
  CreateFileRequest,
  CreateFolderRequest,
  CreateFolderResult,
  RenameEntryRequest,
  RenameEntryResult,
} from '@deepcode/protocol';

function routeError(fallback: string, err: unknown): { error: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: message.startsWith('no_workspace:') ? 'no_workspace' : fallback,
    message,
  };
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // ---- 获取目录树 ----
  app.get('/api/files/tree', async (request) => {
    const query = request.query as FileTreeQuery;
    try {
      const tree = await readDirectoryTree(query.folderId, query.path);
      const response: ApiResponse<FileTreeNode[]> = {
        ok: true,
        data: tree,
      };
      return response;
    } catch (err) {
      const failure = routeError('file_tree_error', err);
      const response: ApiResponse<never> = {
        ok: false,
        ...failure,
      };
      return response;
    }
  });

  // ---- 读取文件内容 ----
  app.get('/api/files/read', async (request) => {
    const query = request.query as FileReadQuery;
    if (!query.path) {
      const response: ApiResponse<never> = {
        ok: false,
        error: 'missing_param',
        message: '缺少 path 参数',
      };
      return response;
    }
    try {
      const result = await readFileContent(query.folderId, query.path);
      const response: ApiResponse<FileReadResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const failure = routeError('file_read_error', err);
      const response: ApiResponse<never> = {
        ok: false,
        ...failure,
      };
      return response;
    }
  });

  // ---- 写入文件内容 ----
  app.post('/api/files/write', async (request) => {
    const body = request.body as FileWriteRequest;
    if (!body || !body.path || body.content === undefined) {
      const response: ApiResponse<never> = {
        ok: false,
        error: 'missing_param',
        message: '缺少 path 或 content 参数',
      };
      return response;
    }
    try {
      const result = await writeFileContent(body.folderId, body.path, body.content);
      const response: ApiResponse<FileWriteResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const failure = routeError('file_write_error', err);
      const response: ApiResponse<never> = {
        ok: false,
        ...failure,
      };
      return response;
    }
  });

  // ---- 新建文件（阶段 4 / S4-1）----
  app.post('/api/files/create', async (request) => {
    const body = request.body as CreateFileRequest;
    if (!body || !body.path) {
      const response: ApiResponse<never> = {
        ok: false,
        error: 'missing_param',
        message: '缺少 path 参数',
      };
      return response;
    }
    try {
      const result = await createFile(body.folderId, body.path, body.content ?? '');
      const response: ApiResponse<FileWriteResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 区分 file_already_exists，方便前端展示“该名称已存在”提示
      const isExist = message.startsWith('file_already_exists');
      const response: ApiResponse<never> = {
        ok: false,
        error: message.startsWith('no_workspace:')
          ? 'no_workspace'
          : isExist
            ? 'file_already_exists'
            : 'file_create_error',
        message,
      };
      return response;
    }
  });

  // ---- 新建目录（阶段 4 / S4-1）----
  app.post('/api/folders/create', async (request) => {
    const body = request.body as CreateFolderRequest;
    if (!body || !body.path) {
      const response: ApiResponse<never> = {
        ok: false,
        error: 'missing_param',
        message: '缺少 path 参数',
      };
      return response;
    }
    try {
      const result = await createFolderEntry(body.folderId, body.path);
      const response: ApiResponse<CreateFolderResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isExist = message.startsWith('file_already_exists');
      const response: ApiResponse<never> = {
        ok: false,
        error: message.startsWith('no_workspace:')
          ? 'no_workspace'
          : isExist
            ? 'file_already_exists'
            : 'folder_create_error',
        message,
      };
      return response;
    }
  });

  // ---- 重命名文件 / 目录（编辑器基建）----
  app.post('/api/files/rename', async (request) => {
    const body = request.body as RenameEntryRequest;
    if (!body || !body.oldPath || !body.newPath) {
      const response: ApiResponse<never> = {
        ok: false,
        error: 'missing_param',
        message: '缺少 oldPath 或 newPath 参数',
      };
      return response;
    }
    try {
      const result = await renameEntry(body.folderId, body.oldPath, body.newPath);
      const response: ApiResponse<RenameEntryResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isExist = message.startsWith('file_already_exists');
      const response: ApiResponse<never> = {
        ok: false,
        error: message.startsWith('no_workspace:')
          ? 'no_workspace'
          : isExist
            ? 'file_already_exists'
            : 'file_rename_error',
        message,
      };
      return response;
    }
  });
}
