/**
 * WebSocket 心跳客户端
 * 连接 /ws/heartbeat，发送 ping，接收 pong 和 server.ready
 */
import type { HeartbeatServerEvent } from '@deepcode/protocol';
import useAppStatusStore from '../state/appStatusStore';

const WS_BASE = `ws://${window.location.host}/ws`;
const HEARTBEAT_INTERVAL_MS = 5000; // 5秒发送一次 ping

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 建立心跳 WebSocket 连接
 */
export function connectHeartbeat(): void {
  const store = useAppStatusStore.getState();
  store.setWsStatus('checking');

  ws = new WebSocket(`${WS_BASE}/heartbeat`);

  ws.onopen = () => {
    // 状态将在收到 server.ready 后更新为 connected
  };

  ws.onmessage = (event) => {
    let parsed: HeartbeatServerEvent;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      store.setWsStatus('error');
      store.setErrorMessage('WebSocket 消息解析失败');
      return;
    }

    switch (parsed.type) {
      case 'server.ready':
        store.setWsStatus('connected');
        if (parsed.timestamp) {
          store.setLastHeartbeatAt(parsed.timestamp);
        }
        startHeartbeatLoop();
        break;

      case 'heartbeat.pong':
        store.setWsStatus('connected');
        store.setLastHeartbeatAt(parsed.timestamp);
        break;

      case 'error':
        store.setWsStatus('error');
        store.setErrorMessage(parsed.message);
        break;

      default:
        // 未知事件类型，忽略
        break;
    }
  };

  ws.onerror = () => {
    store.setWsStatus('error');
    store.setErrorMessage('WebSocket 连接错误');
  };

  ws.onclose = () => {
    store.setWsStatus('disconnected');
    stopHeartbeatLoop();
    // 首期不自动重连，后续阶段再做
  };
}

/**
 * 断开心跳连接
 */
export function disconnectHeartbeat(): void {
  stopHeartbeatLoop();
  if (ws) {
    ws.close();
    ws = null;
  }
  const store = useAppStatusStore.getState();
  store.setWsStatus('disconnected');
}

/**
 * 启动定时心跳发送
 */
function startHeartbeatLoop(): void {
  stopHeartbeatLoop();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const ping = {
        type: 'heartbeat.ping',
        timestamp: new Date().toISOString(),
      };
      ws.send(JSON.stringify(ping));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * 停止心跳发送
 */
function stopHeartbeatLoop(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
