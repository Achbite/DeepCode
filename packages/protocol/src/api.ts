/**
 * API 响应通用包装
 * 遵循统一响应格式：{ ok, data?, message?, error? }
 */
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  message?: string;
  error?: string;
}

import type { WorkspaceSummary } from './workspace.js';

/**
 * 健康检查状态
 * GET /api/health 的响应数据类型
 *
 * 注意：service 字面量已固定为 'deepcode-server'；当前阶段为初始化期，
 * 不保留旧的 'agent-light-server' 兼容字面量。
 */
export interface HealthStatus {
  service: 'deepcode-server';
  status: 'ok';
  version: string;
  timestamp: string;
  /** 当前活动工作区摘要；启动后总是存在（至少为 fallback 工作区） */
  workspace: WorkspaceSummary;
}
