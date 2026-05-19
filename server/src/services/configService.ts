/**
 * 服务基础配置
 * 端口来自环境变量 AGENT_LIGHT_PORT 或默认 31245
 * host 强制 127.0.0.1，不允许公网暴露
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  /** 监听地址，首期固定 127.0.0.1 */
  host: '127.0.0.1';
  /** 监听端口，默认 31245，可通过 AGENT_LIGHT_PORT 环境变量覆盖 */
  port: number;
  /** 服务版本，来自 package.json */
  version: string;
}

const DEFAULT_PORT = 31245;
const DEFAULT_HOST = '127.0.0.1' as const;

// ESM 兼容：使用 import.meta.url 获取当前文件路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

/**
 * 读取服务配置
 * 优先从环境变量读取，否则使用默认值
 */
export function loadConfig(): ServerConfig {
  const portEnv = process.env.AGENT_LIGHT_PORT;
  const port = portEnv ? parseInt(portEnv, 10) : DEFAULT_PORT;

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(
      `无效端口号: AGENT_LIGHT_PORT=${portEnv}，取值范围 1-65535`
    );
  }

  // ESM 兼容：使用 fs 读取 package.json 获取版本号
  let version = '0.1.0';
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    version = pkg.version || version;
  } catch {
    // 读取失败时使用默认版本
  }

  return {
    host: DEFAULT_HOST,
    port,
    version,
  };
}
