/**
 * 用户设置协议（阶段 4 / S4-4）
 *
 * 仅定义 DTO 与默认值常量；实际 UI 与 Monaco 选项实时应用在阶段 5 落地。
 *
 * 默认值种子来源：
 *   - 用户当前 vscode 用户工作区设置可移植子集
 *     （`C:\Users\kkkdiwang\AppData\Roaming\Code\User\settings.json` 在阶段 4 启动前提取）
 *   - 未显式覆盖的 key 使用 VSCode 出厂默认（如 tabSize=4 / fontSize=14）
 *
 * 设计要求：
 *   - key 命名一律使用 `domain.key` 形式（与 VSCode settings 生态一致）
 *   - 值类型限制为 string / number / boolean / null（null 仅用于 patch 时表示恢复默认）
 *   - schema 演进时只允许新增 key，不允许变更已有 key 的值类型
 */

/** 用户设置可序列化值的并集类型；null 仅在 patch 请求中表示恢复默认 */
export type UserSettingValue = string | number | boolean | null;

/**
 * 用户设置整体类型；扁平 key-value 结构。
 *
 * 不使用嵌套对象：扁平结构便于 patch、便于 storage、便于 UI 控件按 key 分组。
 */
export type UserSettings = Record<string, UserSettingValue>;

/**
 * 默认用户设置常量
 *
 * 从用户当前 vscode 全局 settings.json 提取的可移植子集；
 * 标 `← 来自当前 vscode 用户设置` 的项即真实命中过用户配置，其余为 VSCode 出厂默认。
 *
 * 不包含项目专属或路径专属字段（如 terminal.integrated.profiles.windows、
 * remote.SSH.remotePlatform 等），这些不构成本编辑器的合理种子。
 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  // ---- 编辑器 ----
  'editor.tabSize': 4,
  'editor.insertSpaces': true,
  'editor.wordWrap': 'off',
  'editor.fontSize': 14,
  'editor.fontFamily': "Consolas, 'Courier New', monospace",
  'editor.renderWhitespace': 'none', // ← 来自当前 vscode 用户设置
  'editor.tabCompletion': 'on', // ← 来自当前 vscode 用户设置
  'editor.accessibilitySupport': 'off', // ← 来自当前 vscode 用户设置
  'editor.unicodeHighlight.invisibleCharacters': false, // ← 来自当前 vscode 用户设置
  // ---- 文件 ----
  'files.autoSave': 'afterDelay', // ← 来自当前 vscode 用户设置
  'files.autoSaveDelay': 1000,
  'files.hotExit': true,
  'files.encoding': 'utf8',
  'files.eol': '\n',
  // ---- 键盘 ----
  'keyboard.enableBasicShortcuts': true,
  // ---- 资源管理器 ----
  'explorer.confirmDelete': false, // ← 来自当前 vscode 用户设置
  // ---- 工作台 ----
  // 用户 vscode 是 "Visual Studio 2017 Dark - C++"，本项目暂不引入完整主题包，
  // 简化为 vs-dark；阶段 5 引入主题切换最小集后再扩展。
  'workbench.colorTheme': 'vs-dark',
  // ---- Agent / Skill / Prompt ----
  'skills.pythonPath': 'python',
  'skills.autoLoad': true,
  'skills.mounts': '[]',
  'prompt.defaultProfileId': 'default-agent',
  'prompt.profiles':
    '[{"id":"default-agent","name":"Default Agent","description":"通用代码协作 Agent","systemPrompt":"You are DeepCode Agent. Work inside the current workspace, explain important risks, and ask for approval before writing files.","enabled":true}]',
  'ruler.enabled': true,
  'ruler.rules':
    '[{"id":"default-safety","name":"Default Safety Boundary","source":"system","priority":100,"path":"<builtin>/default-safety.md","content":"Default to plan mode. Read before write. Show diff before saving files. Never run destructive commands without explicit approval.","enabled":true}]',
};

/** GET /api/user-settings 成功响应 data 字段 */
export interface GetUserSettingsResult {
  /** 完整设置（已合并默认值 + 用户覆盖） */
  settings: UserSettings;
  /** 用户实际写过的 key 子集；不在此列表的从默认值取 */
  overriddenKeys: string[];
  /** 持久化文件的绝对路径，便于用户手工编辑 */
  storePath: string;
}

/** PATCH /api/user-settings 请求体 */
export interface PatchUserSettingsRequest {
  /** 浅合并；显式 null 表示恢复该 key 默认值 */
  patches: Record<string, UserSettingValue>;
}

/** PATCH /api/user-settings 成功响应 data 字段 */
export interface PatchUserSettingsResult {
  /** 合并后完整设置 */
  settings: UserSettings;
  /** 本次实际产生变化的 key 集合 */
  changedKeys: string[];
}
