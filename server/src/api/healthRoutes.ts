/**
 * 健康检查路由
 * GET /api/health
 * 不访问文件系统，不执行外部命令，只证明服务已启动
 */
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../services/configService.js';
import type { ApiResponse, HealthStatus } from '@deepcode/protocol';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const config = loadConfig();
    const payload: HealthStatus = {
      service: 'agent-light-server',
      status: 'ok',
      version: config.version,
      timestamp: new Date().toISOString(),
    };

    const response: ApiResponse<HealthStatus> = {
      ok: true,
      data: payload,
    };

    return response;
  });
}
