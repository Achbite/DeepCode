/**
 * 工作区相关共享 DTO
 *
 * 用于 /api/workspaces/* 路由的请求与响应类型；前后端复用此定义。
 *
 * 设计要点：
 *   1. WorkspaceSpec 是当前活动工作区的事实源，包含 source、folders[]、settings 与不支持字段；
 *   2. 兼容 VSCode 风格的 .code-workspace 文件（仅 folders + settings 子集）；
 *   3. 路径安全：每个 WorkspaceFolder 解析后得到独立 rootId，所有文件读写必须绑定到某个 folderId；
 *   4. 不含历史兼容字段，命名直接采用最新方案。
 */

/**
 * 工作区来源类型。
 *   - directory       ：用户打开的是单个目录
 *   - code-workspace  ：用户打开的是 VSCode 兼容 .code-workspace 文件
 *   - fallback        ：无任何用户选择时使用的默认工作区（仓库内 ./workspace）
 */
export type WorkspaceSourceKind = 'directory' | 'code-workspace' | 'fallback';

/**
 * 工作区中的单个根文件夹。
 *
 * id 由后端生成；前端在所有文件 API 调用中通过 folderId 指明落点。
 */
export interface WorkspaceFolderSpec {
  /** 后端生成的稳定 ID，如 'wf-0'；同一会话内不变 */
  id: string;
  /** 展示名；优先取 .code-workspace 中的 name，否则取目录基名 */
  name: string;
  /** 解析后的绝对路径（POSIX 风格） */
  absolutePath: string;
  /** .code-workspace 中的原始 path 字段；directory 来源时与 absolutePath 一致 */
  originalPath: string;
  /** 原始 path 是否为绝对路径；用于 UI 风险提示 */
  isAbsolute: boolean;
}

/**
 * .code-workspace 中我们当前不解析、但保留作为兼容提示的字段名。
 * 例如 'extensions' / 'tasks' / 'launch'。
 */
export interface UnsupportedField {
  /** 字段名 */
  key: string;
  /** 该字段在 JSON 中的类型摘要，如 'object' / 'array' */
  kind: string;
}

/**
 * 当前活动工作区的完整描述。
 */
export interface WorkspaceSpec {
  /** 工作区 ID，按打开次数递增；fallback 工作区固定为 'fallback' */
  id: string;
  /** 工作区名；directory 取目录基名；code-workspace 取文件名（去 .code-workspace 后缀） */
  name: string;
  /** 工作区来源 */
  source: WorkspaceSourceKind;
  /** 当 source 为 'code-workspace' 时存在，是 .code-workspace 文件的绝对路径 */
  sourcePath: string | null;
  /** 解析后的 folders 列表；至少包含 1 个 */
  folders: WorkspaceFolderSpec[];
  /** DeepCode 命名空间下的工作区级设置（透传 .code-workspace.settings 中以 'deepcode.' 开头的键） */
  settings: Record<string, unknown>;
  /** 不支持但保留的字段，用于 UI 提示 */
  unsupportedFields: UnsupportedField[];
  /** 工作区打开时间（ISO） */
  openedAt: string;
}

/**
 * 工作区状态摘要，用于健康检查与启动日志。
 */
export interface WorkspaceSummary {
  id: string;
  name: string;
  source: WorkspaceSourceKind;
  /** folders 数量；首期常为 1 */
  folderCount: number;
}

/** GET /api/workspaces/current 成功响应 data 字段 */
export interface WorkspaceState {
  current: WorkspaceSpec;
  /** 当前是否使用 fallback 工作区（首次启动或上次工作区不可用） */
  fallbackUsed: boolean;
  /** 上一次 openWorkspace 失败原因；成功后清空 */
  lastError: string | null;
}

/** POST /api/workspaces/open 请求体 */
export interface OpenWorkspaceRequest {
  /**
   * 用户选择的绝对路径；可以指向：
   *   - 一个目录
   *   - 一个 .code-workspace 文件
   *
   * 必须是绝对路径；该路由是工作区入口，不受 /api/files/* 的相对路径约束。
   */
  path: string;
}

/** POST /api/workspaces/open 成功响应 data 字段 */
export interface OpenWorkspaceResult {
  workspace: WorkspaceSpec;
}

/** POST /api/workspaces/save-file 请求体 */
export interface SaveWorkspaceFileRequest {
  /** 目标 WorkspaceFolder；省略时使用当前 active/default folder */
  folderId?: string;
  /** 可选文件名；省略时使用当前工作区名生成 <name>.code-workspace */
  fileName?: string;
}

/** POST /api/workspaces/save-file 成功响应 data 字段 */
export interface SaveWorkspaceFileResult {
  /** 生成或覆盖的 .code-workspace 文件绝对路径 */
  workspaceFilePath: string;
  /** 保存后重新打开的工作区状态 */
  workspace: WorkspaceSpec;
  /** 本次是否创建了新文件 */
  created: boolean;
  /** 本次是否覆盖了已有文件 */
  overwritten: boolean;
}

/** PATCH /api/workspaces/current/settings 请求体 */
export interface PatchWorkspaceSettingsRequest {
  /**
   * 仅允许 DeepCode 命名空间下的键（前缀 'deepcode.'）；
   * 后端会拒绝其他键，避免误写入 VSCode 通用配置。
   */
  settings: Record<string, unknown>;
}

/** PATCH /api/workspaces/current/settings 成功响应 data 字段 */
export interface PatchWorkspaceSettingsResult {
  /** 合并后的最新 settings */
  settings: Record<string, unknown>;
}

// ============================================================================
// 文件系统浏览（用于"Open Workspace"可视化对话框）
// ============================================================================

/**
 * 浏览目录的单个子项。
 *
 * 该 DTO 仅用于 /api/fs/browse 路由：在用户点击 Open Workspace 时由前端
 * 模态对话框驱动进行目录浏览，最终由用户确认目录或 .code-workspace 文件，
 * 再走 POST /api/workspaces/open 完成切换。
 *
 * 注意：这里不暴露文件大小、修改时间等细节，避免成为通用文件系统 API；
 * 仅满足"打开工作区/打开 .code-workspace"场景所需的最小信息。
 */
export interface BrowseEntry {
  /** 条目名 */
  name: string;
  /** 解析后的绝对路径（POSIX 风格） */
  absolutePath: string;
  /** 条目类型 */
  type: 'directory' | 'file';
  /** 文件名是否以 .code-workspace 结尾；UI 据此突出显示 */
  isCodeWorkspace: boolean;
  /** 是否为隐藏项（以 . 开头），UI 默认折叠 */
  hidden: boolean;
}

/** GET /api/fs/browse 查询参数 */
export interface BrowsePathQuery {
  /**
   * 要浏览的绝对路径；不传或空字符串时由后端返回首选起点（用户主目录）。
   * 与 /api/files/* 不同，本路由出于"打开工作区"场景必须接受绝对路径。
   */
  path?: string;
}

/** GET /api/fs/browse 成功响应 data 字段 */
export interface BrowsePathResult {
  /** 实际解析到的绝对路径（POSIX 风格） */
  absolutePath: string;
  /** 父目录绝对路径；位于驱动器/文件系统根时为 null */
  parentPath: string | null;
  /** 子项列表（已按 directory 优先 + 名称升序排序） */
  entries: BrowseEntry[];
}

/**
 * 用户主目录、Windows 盘符、当前工作区父目录等"快捷起点"。
 * 由 GET /api/fs/initial-locations 返回，用于对话框侧栏。
 */
export interface InitialLocation {
  /** 展示标签，例如 "Home"、"E:\\"、"Current Workspace" */
  label: string;
  /** 绝对路径（POSIX 风格） */
  absolutePath: string;
  /** 分组：home / drive / workspace */
  kind: 'home' | 'drive' | 'workspace';
}

/** GET /api/fs/initial-locations 成功响应 data 字段 */
export interface InitialLocations {
  /**
   * 平台标识，与 Node.js `process.platform` 取值一致；
   * 这里用字符串字面量集合表达，避免 protocol 包依赖 @types/node。
   * 常见值：'win32' | 'linux' | 'darwin'，其余按字符串透传。
   */
  platform: 'win32' | 'linux' | 'darwin' | 'aix' | 'freebsd' | 'openbsd' | 'sunos' | 'cygwin' | 'netbsd' | string;
  /** 推荐起点列表（按重要性排序） */
  locations: InitialLocation[];
}
