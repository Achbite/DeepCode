/**
 * 文件相关共享 DTO
 * 用于 /api/files/* 路由的请求与响应类型；前后端复用此定义。
 */

/** 文件树节点 */
export interface FileTreeNode {
  /** 节点名（不含路径） */
  name: string;
  /** 相对工作区根目录的 POSIX 风格路径（用 / 分隔） */
  path: string;
  /** 节点类型 */
  type: 'file' | 'directory';
  /** 子节点；仅 type=directory 且未被惰性折叠时存在 */
  children?: FileTreeNode[];
}

/** GET /api/files/tree 查询参数 */
export interface FileTreeQuery {
  /** 起始相对路径，默认为工作区根 */
  path?: string;
}

/** GET /api/files/read 查询参数 */
export interface FileReadQuery {
  path: string;
}

/** GET /api/files/read 成功响应 data 字段 */
export interface FileReadResult {
  path: string;
  content: string;
  /** 字节数；用于前端文件大小阈值判断 */
  sizeBytes: number;
  /** 文件是否被认定为二进制；二进制文件 content 为空 */
  binary: boolean;
}

/** POST /api/files/write 请求体 */
export interface FileWriteRequest {
  path: string;
  content: string;
}

/** POST /api/files/write 成功响应 data 字段 */
export interface FileWriteResult {
  path: string;
  saved: boolean;
  sizeBytes: number;
}
