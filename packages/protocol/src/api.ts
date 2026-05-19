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

/**
 * 健康检查状态
 * GET /api/health 的响应数据类型
 */
export interface HealthStatus {
  service: 'agent-light-server';
  status: 'ok';
  version: string;
  timestamp: string;
}
