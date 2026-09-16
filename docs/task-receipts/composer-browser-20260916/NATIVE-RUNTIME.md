# 本地打包与运行记录

2026-09-16，用户明确同意“现在打包并重启本地 DeepCode”。目标工作区为 `DeepCode-dev-main`，分支 `session/document-skill-preview`。当前包包含这次输入区 / 浏览器授权修改以及此前已完成的设置、主题、图标与布局修改。

## 产物与加载

- 入口：`make package-macos-deepcode-gui`，按已有容器前端构建与 macOS 宿主原生打包流程完成，退出码 0。日志：`macos-package.log`。
- 运行路径：`bin/macos-arm64/DeepCode-GUI.app/Contents/MacOS/DeepCode-GUI`。
- 包信息：`productVersion=0.5.60`，`buildCommit=33ed55e`，`sourceDirty=1`，`buildTimeUtc=2026-09-16T05:24:33Z`；打包完成时间 `2026-09-16T05:25:40Z`。
- GUI PID 84946；成功重试创建的 daemon PID 87112，子进程 PID 87116 实际使用 `bin/macos-arm64/node/bin/node` 和 `bin/macos-arm64/session-core/dist/sessionServiceBridge.js`。

这些信息证明本地包加载与追溯，不代表已提交或发布，不新增版本相等门禁。

## 实际用户路径

| 检查 | 结果 |
| --- | --- |
| CLI 真实对话 | `DeepCode-CLI.command ask --plain`，回复 `GUI_COMPOSER_RUNTIME_OK`，退出码 0；日志 `native-cli.log` |
| TUI 打开 | `DeepCode-TUI.command --session session:b035b5d7ccbbed8843f73041a76b2b6b`，真实 PTY 显示 CLI 回复、completed 状态和输入区；Ctrl-C 退出码 0 |
| GUI 打开与交互 | 包内 GUI 正常加载原历史；原生菜单、新对话、项目新建、问题自由回复、允许此对话和预览开关均实际操作 |
| 首次浏览器授权 | 真实 `browser.page` 点击触发 `authorizationScope=sessionBrowser` 请求；权限界面没有普通输入区，用户范围通过“允许此对话”采集 |
| 同一轮复用 | 重置、两次增加、输入，共 4 次动作；只首次确认，页面读回计数 2 和 `BROWSER_GRANT_OK` |
| 后续轮次复用 | 同一对话下一轮重置、增加、输入，共 3 次动作；无新增确认，页面读回计数 1 和 `SECOND_RUN_OK` |

原生验证会话：`session:e0cd28ae5e24779d77b04aafcc353593`。

两轮运行：

- `session:e0cd28ae5e24779d77b04aafcc353593:run:mu3o8mkn:2`
- `session:e0cd28ae5e24779d77b04aafcc353593:run:mu3ocr6l:33`

共 1 条 `approval.requested`、1 条 `approval.resolved`、2 条 completed settlement。7 次点击/输入全部引用 `session:e0cd28ae5e24779d77b04aafcc353593:authority:mu3obnnb:2a`；后续调用明确记录 `authorizationScope=sessionBrowser`。`native-browser-grant.json` 为只读提取的相关 Session 事件和 ToolRecord 摘要，保留真实页面结果，不包含运行配置快照或凭据。

## 原始失败与验收边界

1. GUI 首次启动及第一次重试出现 `host_startup_daemon_identity_failed`。诊断目录分别为包根下 `diagnostics/host-startup/host-startup-0cb0c4875f9262b7c6e9da70` 和 `host-startup-f0878e9b528db1603b21db36`，stdout/stderr 均为空。随后为采集进程现场进行一次重试，正常启动。成功进程采样保留为 `gui-startup-stack.txt`；窗口线程采样 `gui-window-stack.txt` 显示正常等待系统事件。没有修改启动实现，尚不能确定前两次失败根因。
2. 自动化差量节点曾失效；重新获取完整窗口节点后完成实际交互，不把这段控制失败算作 UI 验收成功。页面最终可操作的结论来自之后的真实回复提交、允许按钮和新任务切换。
3. 初次相对路径未打开测试文件；通过原生问题卡输入 `/Users/wangdi/Desktop/Project/Test/interactive-test.html` 后继续。没有绕过原始错误或改写工具结果。
4. 另一个 CLI 验证会话 `session:09e17f168320947dcd3b0ea1c907e7b7` 没有 GUI 浏览器绑定，因此仅产生只读操作与“工具不可用”回复；不计入原生浏览器成功结果。
5. Plan / 方案选择的布局、键盘和共享输入在生产组件的隔离预览中验证；本次原生对话进一步验证了问题自由回复。未将隔离组件结果扩大成全部原生 Plan 场景验收。
6. 未执行新的 PNG 捕获任务。产物顺序修复的证据为登记的 GUI 行为回归，不声称完成本轮新 PNG 的原生流式输出验收。新对话重新确认、拒绝优先、文件写入与服务启动不复用浏览器授权的边界由 Kernel 聚焦回归覆盖。

## 资源收尾

- CLI 与 TUI 验证进程正常退出。
- 本轮 Python HTTP 预览服务（exec session 11209，127.0.0.1:19487）已中断并退出；本轮 Codex 浏览器预览标签关闭。
- 原生自预览 `preview-1` 由验证 Agent 关闭；测试页面 `preview-2` 通过 GUI 关闭。
- GUI 返回用户原来的 `session:5202192ffd1a1593cd46adb767ced778` 完成对话，普通输入为空；GUI 和共享 Host 按用户重启应用的要求保持可用。保存验证会话与诊断记录供审阅。
- 未提交源码、未推送、未创建或合并 PR、未发布。
