/**
 * WebSocket 心跳通道
 * 路径: /ws/heartbeat
 * 连接后发送 server.ready
 * 收到 heartbeat.ping 回复 heartbeat.pong
 * 收到无法识别的消息回复 error
 */
import type { FastifyInstance } from 'fastify';
import type {
  HeartbeatClientEvent,
  HeartbeatServerEvent,
} from '@deepcode/protocol';

export async function registerHeartbeatWs(app: FastifyInstance): Promise<void> {
  app.get('/ws/heartbeat', { websocket: true }, (socket) => {
    // ---- 1. 连接建立，发送 server.ready ----
    const readyEvent: HeartbeatServerEvent = {
      type: 'server.ready',
      timestamp: new Date().toISOString(),
    };
    socket.send(JSON.stringify(readyEvent));

    // ---- 2. 监听客户端消息 ----
    socket.on('message', (raw: Buffer) => {
      let parsed: HeartbeatClientEvent;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        const errEvent: HeartbeatServerEvent = {
          type: 'error',
          message: '无法解析 JSON 消息',
        };
        socket.send(JSON.stringify(errEvent));
        return;
      }

      if (parsed.type === 'heartbeat.ping') {
        const pong: HeartbeatServerEvent = {
          type: 'heartbeat.pong',
          timestamp: new Date().toISOString(),
        };
        socket.send(JSON.stringify(pong));
      } else {
        const errEvent: HeartbeatServerEvent = {
          type: 'error',
          message: `不支持的心跳事件类型: ${parsed.type}`,
        };
        socket.send(JSON.stringify(errEvent));
      }
    });

    // ---- 3. 连接关闭 ----
    socket.on('close', () => {
      // 首期不做自动重连，只记录断开
    });
  });
}
