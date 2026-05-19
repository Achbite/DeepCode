/**
 * WebSocket 心跳事件类型
 * 用于 /ws/heartbeat 通道的消息协议
 */

/** 客户端发送的心跳 ping */
export interface HeartbeatPingEvent {
  type: 'heartbeat.ping';
  timestamp: string;
}

/** 服务端响应的心跳 pong */
export interface HeartbeatPongEvent {
  type: 'heartbeat.pong';
  timestamp: string;
}

/** 服务端就绪事件（连接建立后立即发送） */
export interface ServerReadyEvent {
  type: 'server.ready';
  timestamp: string;
}

/** 错误事件 */
export interface HeartbeatErrorEvent {
  type: 'error';
  message: string;
}

/** 服务端发出的所有心跳事件 */
export type HeartbeatServerEvent =
  | ServerReadyEvent
  | HeartbeatPongEvent
  | HeartbeatErrorEvent;

/** 客户端发出的心跳事件 */
export type HeartbeatClientEvent = HeartbeatPingEvent;

/** 心跳通道上所有可能的事件 */
export type HeartbeatEvent =
  | HeartbeatClientEvent
  | HeartbeatServerEvent;
