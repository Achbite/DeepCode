import type { FastifyInstance } from 'fastify';
import type { ApiResponse, ShellEnvironmentStatus } from '@deepcode/protocol';
import { getShellEnvironmentStatus } from '../services/runtimeShellService.js';

export async function registerRuntimeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/runtime/shell', async () => {
    const response: ApiResponse<ShellEnvironmentStatus> = {
      ok: true,
      data: getShellEnvironmentStatus(),
    };
    return response;
  });
}
