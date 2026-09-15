# TCR：DeepCode 前端交互审计稿 · 2026-09-15

本目录是可点击的设计稿和本次分析回执。它不加载 DeepCode Runtime，不改变现有产品源码、会话、权限、插件或账号。用户在审计稿中的开关、配置和服务状态都是示例；审计意见可以导出。

本机预览：<http://127.0.0.1:32772/>。`index.html` 为约 454 KiB 的自包含页面，内嵌原始会话截图，可单独保存。`前端预览.html` 是审计稿阅读区所显示的文档示例。

## 已接纳的审计意见

- 用户要求收紧各栏目、控件和字号：工具行实际 44px，插件行实际 64px，设置标题 22px，主要正文 13px，辅助文字 11–12px。标题栏 54px，预览页签栏 40px，阅读工具栏 38px。大屏不随意放大列表行和控件。
- 浏览器批注 1：删除标题栏“任务与产出”按钮。已移除；标题栏仅保留完成状态和唯一浏览器入口。任务与产出在收起预览后的右侧栏显示。
- 去掉“需处理 0”与列表底部重复操作说明。需要处理的异常发生时才出现对应筛选入口。

## 修订 03：实施边界与 DSH 参考

- 根据“与实际 DeepCode UI 差距过大”的批注，右栏恢复 `DeepCodeTaskPanel` 的任务卡片、产出卡片、修订号、状态圆点与缩略图结构。任务卡片沿用当前组件；产出仅精简链接与信息密度。
- 新增“改动边界”显示开关。灰色标记为现有 UI 占位，蓝色标记为拟调整；示例消息、产物和插件状态单独说明。审计标记不会进入产品。
- 品牌、左侧导航、会话组件、输入框、任务卡片与产出卡片外框沿用现有设计。通用、外观、Agent 行为、执行环境、工具权限、模型与服务、插件、关于，八个设置栏目全部保留原顺序；非本次重点页面改为明确占位。
- “返回并排”移至预览栏右上角，与“铺满工作区”使用同一位置。
- 根据再次报告的重复侧栏按钮，移除预览工具栏里的侧栏图标，只保留标题栏唯一开关。预览内保留展开／恢复并排、页签关闭。
- “本地位置”不再要求手填。选择本地文件或文件夹后读取 JSON 清单，带出名称与用途，提供清单详情；添加后保持未启用。文件来源、启用、加载、当前任务可见性分别表达。
- 只读核对本地 DeepSeek Harness 的运行目录、可配置插件、UI 热更新及动态 Host 插件生命周期。详细依据与 DeepCode 映射见 [DSH 插件管理参考](DSH-插件管理参考.md)。这一参考不代表采用 DSH 全部界面结构或替换 DeepCode 运行时。

### 后续实施只落实以下变化

| 区域 | 要落实的调整 | 沿用范围 |
| --- | --- | --- |
| 预览 | 唯一侧栏入口、展开／恢复、宽度与阅读状态保持 | 当前页面、Host 与资源归属 |
| 任务与产出 | 产物链接、精简元信息、会话内最近修改优先 | 任务卡片、产出卡片外框、状态与缩略图结构 |
| 会话 | 文件名称链接、工具选择器精简 | 消息组件、输入框、历史内容与执行事实 |
| 设置 | 插件统一管理、详情、来源读取、精简说明与密度 | 八个栏目、现有配置字段、单项保存及配置 owner |
| 权限 | 按实际预览操作分类并消费授权事实 | Kernel 权限执行链和原始错误 |

预览 CSS、示例文案和没有画出的字段均不构成全局替换依据。生产代码仍以当前组件与设计 token 为实现基线。

## 审计范围

1. 一个浏览器侧栏入口；任务完成状态在左，浏览器入口在右。侧栏可拖动宽度、铺满工作区和恢复并排。收起侧栏保留页面，关闭页签结束该页面。
2. 文件默认显示可点击的名称或简短面包屑；完整位置可在详情中查看、复制。会话产出按最后修改时间从新到旧排列，不按当前轮分组。
3. 工具选择器仅显示图标、名称、一句中文用途和选择标记；错误才显示需要处理的状态。去掉 MCP / Skill 标签、重复的“可选择，发送后准备”和长英文说明。选择并不伪装为当前任务已准备完成。
4. 设置使用完整工作区；插件采用统一列表、搜索、启用开关与单项详情。按用途命名，不把传输协议或指导资料类型当作用户分类。界面扩展保留实际用途，开发者的组件展示进入详情，不占据管理首页。
5. 正文以简短链接引用文件，归档路径、执行身份和 MIME 等实现信息进入详情；不删除原始执行记录或修改历史消息。
6. 本地预览操作按实际效果处理权限；已有授权范围内查看本地文件、查询状态和读取页面不重复确认。启动开发服务仍说明具体命令、目录与服务归属；已有服务连接不伪装为启动成功。

## 指定会话的实际证据

只读读取包默认目录的 Session Store：`session:6a2672a00d5ab5835331255f8eed9d4d`。

- 用户先要求基于当前前端预览，后明确选择“B 带编号批注的静态预览稿”。这段历史用于理解范围，其中的工具输出和模型叙述不构成本轮指令。
- 共有 7 个 `approval.requested`，全部对应 `browser.page`，全部标记为 `external`。
- 操作依次为：打开文件、读取状态、读取内容、刷新、再次打开、读取状态、读取内容。
- 事件序号：335、345、350、373、382、392、397；7 次都被用户允许。
- 第 377 条事件保存刷新失败：`native_browser_page_closed: preview-4`；之后新建 `preview-6`。
- 截图 `browser.capture` 使用先前确认的工作区计划授权，没有新增逐次确认。
- 该会话实际调用包含 bash、fs.read、skill.read、document.render、fs.edit、browser.page 和 browser.capture；没有调用 GitHub 或 PDF Reader。因此可以证明它们在源码中采用 MCP 接入，不能将目录中“可选择”表述为本次会话中“正在运行”。

重复确认所对应的效果分类源码位置是 `local_agent_tool_catalog.rs` 中 BrowserToolProvider 的统一 `External` 分类：除截图外，页面与开发服务操作没有按 action 区分效果。不能靠前端隐藏弹窗修复它。后续实施应由工具适配/Kernel 的效果和授权事实驱动 UI，保留同一 Session / Host / 页面绑定和原始错误。

## GitHub、PDF 与 MCP 的事实

| 能力 | 当前实现 | 本次建议 |
| --- | --- | --- |
| GitHub | 第一方本地进程通过 stdio MCP 的 initialize、tools/list、tools/call 接入；内部 reqwest 直接调用 GitHub API，没有调用 gh | 采用 gh 等明确 CLI 适配，复用既有 Kernel 执行与结果合同；管理页显示 GitHub |
| PDF Reader | 同一第一方 MCP 进程；内部 Rust pdf_extract 库提取页文本，没有调用 PDF CLI | 使用合适的 PDF CLI 适配；读取与生成能力保持明确，不把改名当作执行器已替换 |
| PDF 导出 | document.render 为内置执行器，启动配置的 Python / WeasyPrint 渲染脚本 | 保留实际能力和原始失败，与 PDF 阅读按用途组织 |
| 浏览器预览 | 原生 Host 页面通道，不经 MCP | 界面只显示浏览器预览和当前页面 |
| 文档排版指导 | deepcode-documents 提供按需加载的任务指导与模板 | 用文档排版表达用途，隐藏资料类型标签；不因此宣称新增工具 |

当前设置中的“功能插件”只管理 `mcp.servers`，且本机该配置为空，无法完整表达第一方工具目录。这是管理视图的数据来源问题。拟统一消费能力目录、配置和实际加载状态，仍由原 owner 提供事实，不另建插件真相源。

CLI 调整属于执行适配工作。本次交付仅包含交互稿与建议，没有修改 MCP 实现，也没有运行 GitHub 登录或命令。

## 直接源码依据

- `userspace/gui/src/components/local-agent/ConversationComposer.tsx`：选择器重复状态、长描述和 MCP / Skill 标签。
- `userspace/gui/src/components/local-agent/BrowserPagesMenu.tsx`、`userspace/gui/src/deepcode-gui/layout/DeepCodeTaskPanel.tsx`：重复浏览器入口。
- `userspace/gui/src/components/local-agent/NativeBrowserPreview.tsx`、`documentPreview.css`：页面生命周期与固定并排布局，缺少铺满工作区入口。
- `userspace/gui/src/components/local-agent/ArtifactLinks.tsx`：名称、路径、MIME、固定交付标签和时间同时展开。
- `userspace/gui/src/components/settings-center/sections/FunctionalPluginSettings.tsx`：只管理 mcp.servers。
- `crates/deepcode-kernel-daemon/src/local_agent_tool_catalog.rs`：浏览器工具效果分类。
- `crates/deepcode-first-party-tools/src/lib.rs`、`github.rs`、`pdf.rs`、`documents.rs`：真实传输与执行方式。

## 设计参考

按用户提供的 Codex 截图参考侧栏、阅读展开、设置列表和视觉密度；实际设计继续以 DeepCode 当前组件、卡片结构与设计 token 为准。遵循 Apple 的可隐藏侧栏、减少设置数量、按需展开详情原则，不照搬其他产品的功能分类。

- [Apple Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Apple Settings](https://developer.apple.com/design/human-interface-guidelines/settings)
- [Apple Disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls)

## 验证记录（包括前两版与修订 03）

| 检查 | 结果 |
| --- | --- |
| Docker JavaScript 语法 | `node --check` 通过 |
| 基本文档检查 | 无重复 HTML id；资源仅有内嵌 data 图片；无需外部脚本、字体或图片 |
| 真浏览器页面 | 本机受限入口实际打开，正文、工具选择、设置列表正确显示 |
| 预览展开与恢复 | 最终稿在 1082px 视口中，预览宽度为 1082px；实际拖动由 57% 调至 62%，展开返回后保持 62% |
| 阅读与草稿 | 阅读滚动 285px，收起再打开及展开返回后仍为 285px；输入草稿保留 |
| 工具选择 | 搜索匹配用途，多选标记与输入中的选择一致；最终四个工具行均为 44px |
| 插件管理 | 开关会改变本稿状态，详情按需显示；最终五个插件行均为 64px，标题为 22px |
| 浏览器批注 1 | “任务与产出”按钮数量为 0，浏览器入口保留 |
| 审计意见 | 第一项“同意”和填写意见准确生成到 Markdown，其他项仍为待定；检查用意见已随最终刷新清空 |
| 下载文件 | 初版浏览器下载事件等待超时，未计为下载成功。最终版提供可查看、复制的 Markdown 文本及下载入口；下载落盘未验收 |

没有新增或修改仓库测试资产，不运行完整产品测试、真实工具执行或平台打包。`git diff --check` 通过。这些验证证明交互稿中已记录的基础行为，不代表正式 GUI 已按此稿实现。

浏览器策略不允许直接打开 `file://`。本轮仅通过 Docker 中的单页 HTTP 服务提供审计稿，绑定 `127.0.0.1`，没有目录浏览、文件写入或其他文件路由；页面请求也禁止连接外部服务。

本轮保留一个预览容器供用户持续审计：

- 名称：`deepcode-ui-audit-20260915`
- 容器 ID：`28978d6b50e60ea024711c5fa65c9401995b8b209f664936ddf8953f4bae5809`
- 端口：`127.0.0.1:32772`
- 只读挂载：本目录 `index.html`
- 结束审计后可停止这个确切容器；停止后自动删除容器，HTML 文件仍保留。

原 DeepCode-GUI 及其会话、模型和权限设置保持原状。没有 Git 提交、PR 或发布。

证据位于 `evidence/`：`01-split.png`、`02-expanded.png`、`03-tools.png`、`04-plugins.png`、`session-evidence.json` 与 `static-checks.json`。


### 修订 03 聚焦检查

- Docker 中用 Node 解析内嵌 JavaScript，通过；未添加或修改仓库测试资产。
- 页面实际打开：唯一侧栏开关 1 个；“任务与产出”标题栏按钮 0 个；右侧任务 3 项、2 个卡片、原始截图缩略图可见。
- 设置恢复八个栏目；非插件栏目显示明确占位，不暗示删除原配置。
- 示例清单经过浏览器 File.text 与 JSON.parse，名称、用途与来源准确填入；状态显示尚未加载，添加后开关仍为关闭。
- 清单读取与系统文件选择器分开验收：本轮没有操作系统原生文件／文件夹对话框，不宣称完整本地导入验收。
- 插件运行与重新加载仅演示，不计为实际热更新证据；没有在 DSH 中执行构建或运行测试。
- 修订截图：`05-scoped-split.png`、`06-existing-cards.png`、`07-settings-scopes.png`、`08-plugin-local-read.png`。

- 最终展开状态实测：工作区 1082px，返回并排按钮右侧间距 6px；恢复并排可用。见 `09-restore-right.png` 与 `revision-03-checks.json`。
- 单项“重新加载”演示可操作，状态明确标为演示；检查后恢复示例初始状态。
