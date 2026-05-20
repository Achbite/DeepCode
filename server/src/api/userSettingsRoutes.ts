/**
 * 用户设置路由（阶段 4 / S4-4）
 *
 * GET   /api/user-settings   - 获取完整设置（默认值 + 用户覆盖）
 * PATCH /api/user-settings   - 浅合并 patch；patches 中显式 null = 恢复默认
 */
import type { FastifyInstance } from 'fastify';
import {
  getUserSettings,
  patchUserSettings,
} from '../services/userSettingsService.js';
import type {
  ApiResponse,
  GetUserSettingsResult,
  PatchUserSettingsRequest,
  PatchUserSettingsResult,
} from '@deepcode/protocol';

export async function registerUserSettingsRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get('/api/user-settings', async () => {
    try {
      const result = await getUserSettings();
      const response: ApiResponse<GetUserSettingsResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response: ApiResponse<never> = {
        ok: false,
        error: 'user_settings_load_error',
        message,
      };
      return response;
    }
  });

  app.patch('/api/user-settings', async (request) => {
    const body = request.body as PatchUserSettingsRequest | undefined;
    if (!body || !body.patches || typeof body.patches !== 'object') {
      const response: ApiResponse<never> = {
        ok: false,
        error: 'missing_param',
        message: '缺少 patches 字段',
      };
      return response;
    }
    try {
      const result = await patchUserSettings(body.patches);
      const response: ApiResponse<PatchUserSettingsResult> = {
        ok: true,
        data: result,
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response: ApiResponse<never> = {
        ok: false,
        error: 'user_settings_patch_error',
        message,
      };
      return response;
    }
  });
}
