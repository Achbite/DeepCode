/**
 * 文件操作路由
 * GET  /api/files/tree    - 获取工作区目录树
 * GET  /api/files/read    - 读取文件内容
 * POST /api/files/write   - 写入文件内容
 *
 * 所有响应统一使用 ApiResponse<T> 包装；错误使用机器可读 error 字段。
 */
import type { FastifyInstance } from 'fastify';
import {
  readDirectoryTree,
  readFileContent,
  writeFileContent,
} from '../services/fileService.js';
import type {
  ApiResponse,
  FileTreeNode,
  FileTreeQuery,
  FileReadQuery,
  FileWriteRequest,
  FileReadResult,
  FileWriteResult,
} from '@deepcode/protocol';

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // ---- 获取目录树 ----
  app.get('/api/files/tree', async (request) => {
    const query = request.query as FileTreeQuery;
    try {
      const tree = await readDirectoryTree(query.path);
      const response: ApiResponse<FileTreeNode[]> = {
        ok: true,
        data: tree,
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response: ApiResponse<never> = {
        ok: false,
        error: 'file_tree_error',
        message,
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
      const result = await readFileContent(query.path);
      const response: ApiResponse<FileReadResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response: ApiResponse<never> = {
        ok: false,
        error: 'file_read_error',
        message,
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
      const result = await writeFileContent(body.path, body.content);
      const response: ApiResponse<FileWriteResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response: ApiResponse<never> = {
        ok: false,
        error: 'file_write_error',
        message,
      };
      return response;
    }
  });
}
