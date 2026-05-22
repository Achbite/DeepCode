/**
 * 工作区路由
 *
 * GET   /api/workspaces/current             - 获取当前工作区状态
 * POST  /api/workspaces/open                - 打开新的工作区（绝对路径）
 * PATCH /api/workspaces/current/settings    - 合并 DeepCode 命名空间设置
 *
 * 安全：openWorkspace 是平台中唯一接受绝对路径输入的入口；
 *       后续所有文件读写都通过 folderId 落点到 folder 之内。
 */
import type { FastifyInstance } from 'fastify';
import {
  getWorkspaceState,
  openWorkspace,
  saveWorkspaceFile,
  patchWorkspaceSettings,
} from '../services/workspaceService.js';
import type {
  ApiResponse,
  OpenWorkspaceRequest,
  OpenWorkspaceResult,
  SaveWorkspaceFileRequest,
  SaveWorkspaceFileResult,
  PatchWorkspaceSettingsRequest,
  PatchWorkspaceSettingsResult,
  WorkspaceState,
} from '@deepcode/protocol';

function workspaceRouteError(fallback: string, err: unknown): { error: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: message.startsWith('no_workspace:') ? 'no_workspace' : fallback,
    message,
  };
}

export async function registerWorkspaceRoutes(
  app: FastifyInstance
): Promise<void> {
  // ---- 当前工作区状态 ----
  app.get('/api/workspaces/current', async () => {
    const state = getWorkspaceState();
    const response: ApiResponse<WorkspaceState> = {
      ok: true,
      data: state,
    };
    return response;
  });

  // ---- 打开工作区 ----
  app.post('/api/workspaces/open', async (request) => {
    const body = request.body as OpenWorkspaceRequest | undefined;
    if (!body || typeof body.path !== 'string' || body.path.trim() === '') {
      const response: ApiResponse<never> = {
        ok: false,
        error: 'missing_param',
        message: '缺少 path 参数',
      };
      return response;
    }
    try {
      const ws = openWorkspace(body.path);
      const response: ApiResponse<OpenWorkspaceResult> = {
        ok: true,
        data: { workspace: ws },
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response: ApiResponse<never> = {
        ok: false,
        error: 'workspace_open_error',
        message,
      };
      return response;
    }
  });

  // ---- 合并 DeepCode 命名空间设置 ----
  app.post('/api/workspaces/save-file', async (request) => {
    const body = request.body as SaveWorkspaceFileRequest | undefined;
    try {
      const result = saveWorkspaceFile(body?.folderId, body?.fileName);
      const response: ApiResponse<SaveWorkspaceFileResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const failure = workspaceRouteError('workspace_save_file_error', err);
      const response: ApiResponse<never> = {
        ok: false,
        ...failure,
      };
      return response;
    }
  });

  app.patch('/api/workspaces/current/settings', async (request) => {
    const body = request.body as PatchWorkspaceSettingsRequest | undefined;
    if (!body || typeof body.settings !== 'object' || body.settings === null) {
      const response: ApiResponse<never> = {
        ok: false,
        error: 'missing_param',
        message: '缺少 settings 字段',
      };
      return response;
    }
    try {
      const merged = patchWorkspaceSettings(body.settings);
      const response: ApiResponse<PatchWorkspaceSettingsResult> = {
        ok: true,
        data: { settings: merged },
      };
      return response;
    } catch (err) {
      const failure = workspaceRouteError('workspace_settings_error', err);
      const response: ApiResponse<never> = {
        ok: false,
        ...failure,
      };
      return response;
    }
  });
}
