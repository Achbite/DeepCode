/**
 * 文件系统浏览路由（仅用于"Open Workspace"对话框）
 *
 * GET /api/fs/initial-locations  - 返回对话框推荐起点（Home / Drives / Current Workspace）
 * GET /api/fs/browse?path=<abs>  - 列出指定绝对路径下的子项
 *
 * 安全：本路由是平台中接受任意绝对路径输入的少数入口之一；只做只读列目录，
 * 不返回文件大小、内容、修改时间，避免成为通用文件系统 API。后续切换工作区
 * 仍由 POST /api/workspaces/open 完成。
 */
import type { FastifyInstance } from 'fastify';
import {
  browsePath,
  getInitialLocations,
} from '../services/fsBrowseService.js';
import type {
  ApiResponse,
  BrowsePathQuery,
  BrowsePathResult,
  InitialLocations,
} from '@deepcode/protocol';

export async function registerFsBrowseRoutes(
  app: FastifyInstance
): Promise<void> {
  // ---- 推荐起点 ----
  app.get('/api/fs/initial-locations', async () => {
    try {
      const data = getInitialLocations();
      const response: ApiResponse<InitialLocations> = { ok: true, data };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response: ApiResponse<never> = {
        ok: false,
        error: 'fs_initial_locations_error',
        message,
      };
      return response;
    }
  });

  // ---- 列目录 ----
  app.get('/api/fs/browse', async (request) => {
    const query = request.query as BrowsePathQuery;
    try {
      const data = browsePath(query?.path);
      const response: ApiResponse<BrowsePathResult> = { ok: true, data };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response: ApiResponse<never> = {
        ok: false,
        error: 'fs_browse_error',
        message,
      };
      return response;
    }
  });
}
