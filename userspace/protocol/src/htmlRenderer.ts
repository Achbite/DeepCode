/**
 * HTML 渲染器协议契约（阶段 4 / S4-5 预留；阶段 7 落地）
 *
 * 背景：未来阶段 7 解决"Agent 生成的 HTML 方案需要复制到外部浏览器审查"工作流痛点。
 * 让前端就地用 `<iframe sandbox>` 渲染 Agent 输出，对齐 VSCode WebView Panel 体验。
 *
 * 本阶段只定义 DTO，**不实装**：
 *   - 前端：HtmlPreviewPane 容器（阶段 7）
 *   - Rust Kernel Web Host：/api/workspace-assets/<rel-path> 受控资源处理器（阶段 7）
 *   - CSP 策略（阶段 7：由统一 GUI Host 注入）
 *
 * 协议字段未来可扩展（如 ResourceUsage / Trace），不会破坏老调用方。
 */

/**
 * Agent 输出块的多形态类型
 *
 * - text: 纯文本回复
 * - code: 代码片段；language 用于前端语法高亮
 * - html: 富 HTML；前端需要在 iframe sandbox 中渲染
 *
 * 后续如需扩展（diff / image / audio / tool-call），加新的判别 `kind` 即可，
 * 已有调用方按 default 分支兜底显示原始文本即可。
 */
export type AgentOutputBlock =
  | { kind: 'text'; content: string }
  | { kind: 'code'; language: string; content: string }
  | {
      kind: 'html';
      content: string;
      sandboxLevel: HtmlSandboxLevel;
    };

/**
 * HTML 沙箱等级
 *
 * - strict: iframe 完全隔离；无网络、无脚本、无 form、无 same-origin。
 *           适合预览未审核 Agent 输出，纯展示文本/CSS。
 * - workspace-assets: 在 strict 基础上允许受控 workspace-assets 入口加载工作区资源
 *                    （图片、CSS）。仍禁脚本与外网。
 *                    适合 Agent 生成的报告引用工作区已有图片 / 样式。
 *
 * 未引入 `network-allowed` 等更宽等级；任何外网访问应通过显式 Agent 工具调用，
 * 不应通过 HTML 渲染器隐式发起。
 */
export type HtmlSandboxLevel = 'strict' | 'workspace-assets';

/**
 * 请求前端渲染一段 HTML
 *
 * 调用路径（阶段 7）：
 *   Agent → backend → IPC event `agent.render_html` → 前端 HtmlPreviewPane
 *
 * 安全约束：
 *   - 前端必须将 content 装入 `<iframe sandbox>`，不允许 `dangerouslySetInnerHTML`。
 *   - sandboxLevel 由后端按 Agent 权限策略决定，不接受前端越权升级。
 *   - 未来若引入 CSP nonce / hash，扩展本接口 `csp` 字段，不破坏老调用。
 */
export interface RenderHtmlRequest {
  /** HTML 字符串；由 Agent 生成 */
  html: string;
  /** 渲染策略 */
  sandboxLevel: HtmlSandboxLevel;
}
