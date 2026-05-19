/**
 * 服务端启动入口
 * 创建 Fastify 实例，注册路由和 WebSocket，监听 127.0.0.1
 */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { loadConfig } from './services/configService.js';
import { validateLocalHost } from './security/localHostGuard.js';
import { registerHealthRoutes } from './api/healthRoutes.js';
import { registerFileRoutes } from './api/fileRoutes.js';
import { registerHeartbeatWs } from './ws/heartbeatWs.js';
import { getWorkspaceRoot } from './services/fileService.js';
import type { ServerStartResult } from './types/server.js';

async function main(): Promise<ServerStartResult> {
  // ---- 1. 读取并校验配置 ----
  const config = loadConfig();
  validateLocalHost(config);

  // ---- 2. 创建 Fastify 实例 ----
  const app = Fastify({
    logger: {
      level: 'info',
    },
  });

  // ---- 3. 注册 WebSocket 支持 ----
  await app.register(websocket);

  // ---- 4. 注册路由 ----
  await registerHealthRoutes(app);
  await registerFileRoutes(app);
  await registerHeartbeatWs(app);

  // ---- 5. 启动监听 ----
  await app.listen({ host: config.host, port: config.port });
  console.log(
    `✅ DeepCode Server 已启动: http://${config.host}:${config.port}`
  );
  console.log(`   工作区根目录: ${getWorkspaceRoot()}`);

  return {
    host: config.host,
    port: config.port,
    url: `http://${config.host}:${config.port}`,
  };
}

main().catch((err) => {
  // 启动失败必须输出原因并以非零退出码终止
  console.error('❌ DeepCode Server 启动失败:', err);
  process.exit(1);
});
