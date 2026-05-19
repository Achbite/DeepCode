/**
 * REST API 客户端
 * 封装与后端的 HTTP 通信；DTO 全部来自共享 protocol 包
 */
import type {
  ApiResponse,
  HealthStatus,
  FileTreeNode,
  FileReadResult,
  FileWriteResult,
} from '@deepcode/protocol';

const API_BASE = '/api';

/** 把任意异常转换为 ApiResponse 错误结构 */
function toErrorResponse(err: unknown): ApiResponse<never> {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('Failed to fetch')
  ) {
    return {
      ok: false,
      error: 'network_error',
      message: `网络不可达: ${message}`,
    };
  }
  return {
    ok: false,
    error: 'unknown_error',
    message,
  };
}

/** 获取后端健康状态 */
export async function getHealth(): Promise<ApiResponse<HealthStatus>> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    return (await response.json()) as ApiResponse<HealthStatus>;
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** 获取工作区目录树 */
export async function getFileTree(
  relativePath?: string
): Promise<ApiResponse<FileTreeNode[]>> {
  try {
    const params = relativePath
      ? `?path=${encodeURIComponent(relativePath)}`
      : '';
    const response = await fetch(`${API_BASE}/files/tree${params}`);
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    return (await response.json()) as ApiResponse<FileTreeNode[]>;
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** 读取文件内容 */
export async function readFile(
  filePath: string
): Promise<ApiResponse<FileReadResult>> {
  try {
    const response = await fetch(
      `${API_BASE}/files/read?path=${encodeURIComponent(filePath)}`
    );
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    return (await response.json()) as ApiResponse<FileReadResult>;
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** 写入文件内容 */
export async function writeFile(
  filePath: string,
  content: string
): Promise<ApiResponse<FileWriteResult>> {
  try {
    const response = await fetch(`${API_BASE}/files/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    return (await response.json()) as ApiResponse<FileWriteResult>;
  } catch (err) {
    return toErrorResponse(err);
  }
}

// 重新导出共享 DTO，方便组件直接 import 自 services/apiClient
export type { FileTreeNode, FileReadResult, FileWriteResult };
