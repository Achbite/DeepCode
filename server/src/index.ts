/**
 * 服务端启动入口
 * 创建 Fastify 实例，注册路由和 WebSocket，监听 127.0.0.1
 *
 * 生产部署：
 *   - 设置环境变量 DEEPCODE_SERVE_CLIENT=1，并提供 DEEPCODE_CLIENT_DIST 指向 client/dist，
 *     即可在同一端口承载前端静态资源；开发模式不要启用，以避免与 Vite HMR 冲突。
 */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { loadConfig } from './services/configService.js';
import { validateLocalHost } from './security/localHostGuard.js';
import { registerHealthRoutes } from './api/healthRoutes.js';
import { registerFileRoutes } from './api/fileRoutes.js';
import { registerWorkspaceRoutes } from './api/workspaceRoutes.js';
import { registerFsBrowseRoutes } from './api/fsBrowseRoutes.js';
import { registerUserSettingsRoutes } from './api/userSettingsRoutes.js';
import { registerLlmRoutes } from './api/llmRoutes.js';
import { registerCodeSearchRoutes } from './api/codeSearchRoutes.js';
import { registerAgentRoutes } from './api/agentRoutes.js';
import { registerAgentToolRoutes } from './api/agentToolRoutes.js';
import { registerHeartbeatWs } from './ws/heartbeatWs.js';
import {
  loadInitialWorkspace,
  getCurrentWorkspace,
} from './services/workspaceService.js';
import type { ServerStartResult } from './types/server.js';

async function main(): Promise<ServerStartResult> {
  // ---- 1. 读取并校验配置 ----
  const config = loadConfig();
  validateLocalHost(config);

  // ---- 2. 初始化可选工作区 ----
  loadInitialWorkspace();

  // ---- 3. 创建 Fastify 实例 ----
  const app = Fastify({
    logger: { level: 'info' },
  });

  // ---- 4. 注册 WebSocket 支持 ----
  await app.register(websocket);

  // ---- 5. 注册业务路由（API 优先于静态托管） ----
  await registerHealthRoutes(app);
  await registerWorkspaceRoutes(app);
  await registerFsBrowseRoutes(app);
  await registerFileRoutes(app);
  await registerUserSettingsRoutes(app);
  await registerLlmRoutes(app);
  await registerCodeSearchRoutes(app);
  await registerAgentToolRoutes(app);
  await registerAgentRoutes(app);
  await registerHeartbeatWs(app);

  // ---- 6. 可选：静态前端托管 ----
  if (process.env.DEEPCODE_SERVE_CLIENT === '1') {
    const distEnv = process.env.DEEPCODE_CLIENT_DIST ?? '../client/dist';
    const distAbs = isAbsolute(distEnv) ? distEnv : resolve(process.cwd(), distEnv);
    if (existsSync(distAbs)) {
      await app.register(fastifyStatic, {
        root: distAbs,
        prefix: '/',
      });
      // SPA fallback：未匹配 API/WS 的请求返回 index.html
      app.setNotFoundHandler(async (req, reply) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
          reply.code(404).send({ ok: false, error: 'not_found' });
          return;
        }
        return reply.sendFile('index.html');
      });
      console.log(`📦 静态前端托管已启用: ${distAbs}`);
    } else {
      console.warn(`⚠️ DEEPCODE_SERVE_CLIENT=1 但目录不存在: ${distAbs}，已跳过静态托管`);
    }
  }

  // ---- 7. 启动监听 ----
  await app.listen({ host: config.host, port: config.port });
  console.log(
    `✅ DeepCode Server 已启动: http://${config.host}:${config.port}`
  );
  const ws = getCurrentWorkspace();
  if (ws) {
    console.log(
      `   当前工作区: ${ws.name} (source=${ws.source}, folders=${ws.folders.length})`
    );
    for (const f of ws.folders) {
      console.log(`     - [${f.id}] ${f.name} -> ${f.absolutePath}`);
    }
  } else {
    console.log('   当前工作区: none (waiting for user to open a folder)');
  }

  return {
    host: config.host,
    port: config.port,
    url: `http://${config.host}:${config.port}`,
  };
}

main().catch((err) => {
  console.error('❌ DeepCode Server 启动失败:', err);
  process.exit(1);
});
