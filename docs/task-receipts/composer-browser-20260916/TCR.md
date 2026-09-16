# 输入区、产物显示与浏览器授权：测试变更说明

用户要求：权限确认复用底部容器且不显示输入框；Plan 和方案选择保留共享输入框，减少嵌套边框；最终回复显示完后再出现产物预览。用户在本轮明确选择浏览器授权覆盖当前对话全程；新对话重新确认，截图写文件和启动服务继续遵循原有规则。

## 当前证据与合同

- 只读核对 `session:5202192ffd1a1593cd46adb767ced778`：同一 `browser:preview-1` 共出现 7 次 `approval.requested` / `approval.resolved`，均为单调用授权；UI 没有重复发送同一请求。
- 产物随 `tool.completed` 进入 Session projection，正文仍在生成或显示。UI 原先直接挂载 ArtifactLinks；本次只改变交付显示时机，不改写产物和任务终态事实。
- 权限有效期由 Kernel 产生的 `EffectPreview.authorizationScope = sessionBrowser` 明确告知。Session 保留该请求及用户决策，Kernel 只复用当前对话中明确授予的浏览器权限；普通单次许可不扩大范围。现有全局拒绝规则仍生效，不借用浏览器授权放行 Shell、服务启动或文件写入。

## 必要测试变更

1. GUI 既有测试 `pending approvals preserve ordinary input with one primary action` 的旧合同是审批时仍显示普通输入。按用户本轮明确要求更新为审批界面无输入和普通工具栏、只有允许/拒绝；保留的草稿在返回输入模式后仍可用。这是合同变更，不是放宽失败断言。
2. 按用户随后提供的两张参考图调整测试：Plan/方案选择仍只有一个共享 textarea，顶部轻量标题和关闭按钮，中部编号选项，底部横排输入与发送。Plan 的确认选项和修改意见发送分别调用原决策链；输入为空时发送禁用，确认选项仍可用。保留取消/跳过；权限和模型工具栏不占用确认界面。
   范围增量测试检查完整输入区，保持“确认新增范围”按钮及保留进度提示的断言，提示放在按钮 tooltip 中。权限卡具有拒绝和允许此对话两个动作，补充 Esc/Enter 及输入草稿恢复的页面交互检查。
   Markdown 选项测试将查找范围限定在选项列表，避免新增的标题关闭按钮被误认作第一个选项；禁用、描述、可访问名称和无嵌套链接断言保持完整。
3. 新增产物显示顺序回归：截图已产出但正文未完成时隐藏；任务结束但显示缓冲未追上时仍隐藏，随后开启新一轮也不绕过显示确认；正文显示完成后同时提供给对话与产物栏；历史产物即时可读，失败/取消仍保留实际产物。
4. Session 回归确认浏览器授权范围经过 reducer / projection 后保持不变；GUI 严格 wire decoder 接纳明确范围、仍拒绝非法范围。CLI/TUI 的共享 Rust consumer 同步范围字段和说明，避免切换界面时遗漏授权范围。
5. Kernel 聚焦验证当前对话浏览器授权在不同调用及后续运行复用；新对话仍询问；普通许可不转为浏览器授权，拒绝规则不被复用许可覆盖。沿用 Rust 单元测试和内存 journal，不增加其他测试矩阵。
6. 独立视觉夹具复用生产组件和输入 hook，通过页面控件检查权限、Plan、方案选择及浅/深色布局；决策回调仅显示结果，不访问实际会话或调用后端。

验证入口：容器 `deepcode-dev` 挂载当前 `DeepCode-dev-main` 到 `/workspace`，使用 `bash ./test.sh required` 及 `make ui UI_SURFACE=all`。实际结果与界面证据在完成后补充。

视觉依据：[Apple Layout](https://developer.apple.com/design/human-interface-guidelines/layout) 的稳定布局与渐进披露，[Apple Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) 的相关操作集中呈现和仅在需要输入时显示文本字段。底部工作区复用是本项目实现选择，不声称 Apple 要求采用某个组件结构。

## 实施与已完成验证

- 输入区继续使用 `ConversationComposer` 与既有输入 hook。权限确认不挂载普通输入区；Plan 与方案选择共用 textarea 和发送链。旧的独立交互输入框样式已清理，新增问题图标仍走统一图标注册表，颜色使用语义变量。
- `ConversationDisplayProvider` 将实际正文显示回执同时供给对话和右侧产物栏；只控制显示时机，不修改 Session 的消息、产物和运行事实。
- Kernel 从已有 Session journal 查找明确的对话浏览器授权，限定真实的内置 `browser.page` 绑定。Session reducer、GUI 严格 decoder 及 CLI/TUI 消费者同步保留授权范围；未增加权限数据库或第二份设置。
- Docker `required` 全部通过：Rust 登记测试 195 项，Session 63 项，GUI 77 项，以及登记静态/类型检查。最新参考布局调整后的 GUI 复跑仍为 77/77，0 失败、0 跳过；最终前端重新构建，记录见 `ui-build.log`。
- 初次新增 Session 测试缺少必要运行快照；修正为真实 `message.committed → run.started → approval.requested` 夹具。布局测试随用户参考图调整了按钮查找区域，保留原有行为断言，没有放宽生产检查或取消登记。
- 隔离浏览器实际点击验证：允许/拒绝、Esc/Enter、Plan 确认、修改意见提交、选项与自由回复。普通输入草稿在决策后恢复；权限无 textarea，Plan/问题各只有一个 textarea。
- 浅色/深色布局已检查并留图；420px 窄窗 DOM 读取显示页面 `clientWidth=scrollWidth=420`，输入和按钮保持可见。深色权限主按钮键盘聚焦后背景 `rgb(245,245,247)`、文字 `rgb(36,36,38)`，已修正通用 focus 样式覆盖。

图片：`choices-light.png`、`plan-light.png`、`plan-dark.png`、`approval-light.png`、`approval-dark.png`。这是生产组件的隔离界面验证，不能替代原生内置浏览器的真实授权链。

## 本地运行更新

用户已明确同意现在重新打包并重启本地 DeepCode。打包前只读核对当前数据库无未终结运行；当前窗口显示原浏览器测试任务已完成，普通输入为空。按现有 `make package-macos-deepcode-gui` 入口更新，再记录实际 CLI 对话、TUI/GUI 启动和浏览器连续操作结果。

- `make package-macos-deepcode-gui` 已完成，产物位于 `bin/macos-arm64`，同时更新共享运行时及现有 GUI / Editor 包。`DeepCode-GUI.app` 为本地 0.5.60 构建，基线 `33ed55e`，包含本工作区未提交修改；打包完成时间 `2026-09-16T05:25:40Z`，不是发布版本或已提交源码回执。
- 真实 CLI 对话返回 `GUI_COMPOSER_RUNTIME_OK`，退出码 0；TUI 在真实 PTY 打开该会话，显示同一回复、完成状态及输入区，随后 Ctrl-C 正常退出。GUI 进程实际运行本次包路径，历史对话与产物正常加载。
- GUI 首次启动及第一次重试分别报 `host_startup_daemon_identity_failed`，对应启动日志为空；为采集进程现场进行的下一次重试正常启动，未修改启动超时、身份校验、配置或数据库。成功启动的 daemon 使用包内 Node 和 Session Service。两次启动失败的根因尚未确定，不能将后续成功称为已修复启动问题；详情见 `NATIVE-RUNTIME.md`。
- 原生 GUI 的独立 Test 项目对话 `session:e0cd28ae5e24779d77b04aafcc353593` 实测新权限卡：单层容器、无普通 textarea、仅“拒绝 / 允许此对话”。问题自由回复使用共享输入区，提交后 journal 中的 `interaction.resolved` 保留了准确输入。
- 两轮真实浏览器操作共 7 次点击/输入，仅有 1 条 `approval.requested` 和 1 条允许记录，全部引用同一 authorityId。第一轮读回 `点击次数：2` / `BROWSER_GRANT_OK`，第二轮读回 `点击次数：1` / `SECOND_RUN_OK`；两轮均 `run.settled: completed`。证据为 `native-browser-grant.json`、`native-approval.png`、`native-question.png` 和 `native-second-run.png`。
- 初始浏览器相对路径打开失败后，通过问题输入区补充已有文件的绝对路径继续；原始失败保留。CLI 创建的另一验证对话没有 GUI 原生浏览器绑定，未执行浏览器动作，不将该轮计入浏览器验收。
- 本轮未新增 PNG 捕获任务；产物延后显示由 GUI 回归覆盖“运行尚未结束、正文缓冲未追上、切到下一轮、历史读取”等行为，不能将上述浏览器点击验收当作新 PNG 输出顺序的完整原生验收。
- 临时 HTTP 预览服务和 Codex 预览标签已关闭；CLI/TUI 验证进程已退出；本轮原生浏览器测试页已关闭。已返回用户原来的完成对话，普通输入为空；更新后的 GUI 及其共享 Host 留给用户继续使用。验证会话记录保留用于核对。

本轮没有 Git 提交、PR、推送或平台发布。
