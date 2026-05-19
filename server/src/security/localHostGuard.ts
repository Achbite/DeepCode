/**
 * 本地监听安全守卫
 * 首期强制只监听 127.0.0.1，拒绝 0.0.0.0
 */
import type { ServerConfig } from '../services/configService.js';

/**
 * 校验配置是否安全
 * 如果 host 配置为 0.0.0.0 或其他公网地址，直接拒绝启动
 */
export function validateLocalHost(config: ServerConfig): void {
  if (config.host !== '127.0.0.1') {
    throw new Error(
      `安全校验失败：首期不允许监听 ${config.host}，只允许 127.0.0.1。不允许首期暴露到局域网。`
    );
  }
}
