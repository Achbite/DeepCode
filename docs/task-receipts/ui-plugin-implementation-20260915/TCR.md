# TCR — 已批准交互稿与插件更新策略落地

日期：2026-09-15 至 2026-09-16。

状态：本次批准的 UI/插件调整已实施，已构建本地 macOS 产物并完成约定的基础运行检查；最后的页面代码审查已完成，剩余交互问题见 [FRONTEND-REVIEW.md](FRONTEND-REVIEW.md)。未执行 Git 提交、PR、合并或发布。

## 后续 UI 修复回执

本页记录原功能批次及其 CLI/TUI/插件运行证据。后续 R1—R6 与用户追加的布局调整已进入 [2026-09-16 修复回执](../ui-review-fixes-20260916/TCR.md)，当前 GUI 资源身份和验证状态以该回执为准；本页的旧资源时间与审查缺口保留为历史记录。

## 授权与范围

用户已批准交互稿并要求实际落地，保留 DeepCode 现有风格、任务/产出结构及八个设置栏目；插件策略参考本地 DSH 的清单、逐项配置、串行释放和局部替换。主对话单独实施。核心以 CLI 验证，GUI 仅基础运行与简单插件检查。

项目 AGENTS 已按新增指令明确：CLI 优先；CLI 明显复杂而已有成熟适用的 MCP 方案时可采用 MCP。

## 测试变更说明

本次需要修改少量现有登记测试：UI 插件释放合同从同步返回扩展为可等待的异步清理，原同步断言已不能证明资源完成释放。沿用 `userspace/gui/tests/session-contract.test.mjs` 的 Node 测试框架，改为等待释放完成，保留“清理失败必须显式显示”“迟到导入不能覆盖新实例”“所有旧样式与监听释放”的断言；增加一次异步清理顺序断言。未降低覆盖、取消注册或增加复杂 GUI 驱动脚本。

增加 Rust CLI 插件聚焦测试：真实运行单文件工具，更新后新绑定调用新代码，原绑定仍调用原代码。该测试证明调用路径及准备时捕获的实现身份，不代替真实 Provider / 平台验收。

CLI 既有“目录错误保留”测试的 fixture 缺少 A 批次已必填的目录展示字段，补齐 source/category/contributionKind/discovery 及合法 URI；原始错误断言保持不变。此处是过期测试数据，未修改生产路径默认值来通过测试。

同一问题也存在于 TUI 和 GUI 目录 fixture，一并补齐。GUI 产物 fixture 补上 F 批次必需的媒体类型与固定内容标识，并新增对实际 ToolRecord 的 session/run/call/record/时间关联断言；不让 reducer 为不完整产物伪造数据。纯展示 fixture 补齐投影已有的 artifacts/contextCompositions 数组。

两项过期断言按用户已确认的行为更新：原“Reader 使用模态 dialog”改为“可调整宽度的侧栏 Reader、右侧展开按钮”；模型选择只保存当前会话偏好，不改变新对话采用的最近实际使用模型。保留原有保存确认、失败保持原值、推理强度重置及消息过滤断言。没有删除或跳过登记测试。

PDF 附件激活检查现只查声明的所属插件；选中后的准备仍检查执行文件可用性并保留原始错误。避免在确认附件所需工具名称时就依赖已构建的二进制，发现、选择和准备仍是不同阶段。

## 实施项

- 预览保留标签页实例，可调整宽度、收起与铺满工作区；右上角统一展开/返回位置。
- 完成状态后保留一个浏览器与预览按钮，移除任务侧重复入口。
- 保留当前任务卡片、会话输入、导航与设计 token。
- 工具选择以名称、用途、选择标记呈现；状态和原始错误按需显示。
- 插件管理读取已有配置 owner 和实际运行状态，统一列表、逐项开关与配置、本地元数据读取。
- UI 更新等待旧实例与子视图的异步释放；单个插件可独立重新加载。
- GitHub/PDF/arXiv 默认直接 CLI 调用；外部 MCP 继续按原路径接入。
- 本地 CLI 单文件工具模板；准备时保留代码内容，运行中下一请求刷新，旧请求绑定保持有效。
- 本地预览读与页面生命周期操作按实际 effect 分类；开发服务启动仍经 Kernel 外部执行权限。
- 状态与唯一预览开关位于共用工作区标题栏最右侧，任务/产出下移至标题栏以下。标题依旧由 Session 展示组件消费原投影，不复制状态。
- 展开预览时隐藏输入区域前重复的 Session 产物摘要；历史消息中的交付卡片继续保留。Session 产物按固定版本的内容生成时间从新到旧排列。
- 左侧导航在普通和阅读布局使用同一个宽度变量；保持现有字体、主题、卡片结构和栏目划分。
- 通用/外观栏目保存失败在本栏目显示原始错误，避免错误只出现在“关于”页。

## 运行检查发现与修正

- CLI 首次运行暴露准备配置误带实现指纹字段，被 Session 当前公共合同正确拒绝。已将实现身份移回准备缓存和 generation 的私有输入，公共选择配置保持既有字段。
- 随后的真实 CLI 运行发现初次请求选择被下一请求刷新清空：初始输入在 run 创建前产生，不带 runId。已使用 run.started.inputMessageId 关联初始 input.accepted 的真实选择；添加一项现有 Session 框架测试，覆盖初始选择、运行中追加选择以及同一 run 下一请求同时保留两者。Session 测试现为 62 项通过。
- GUI 检查发现旧通用按钮 padding 挤压新图标，以及 WKWebView 的应用导航规则误拦截 sandbox iframe 的 about:srcdoc。已修正控件样式优先级和内嵌文档导航；最终原生产物已实际显示归档 HTML，并完成并排/铺满/恢复检查。
- 本地展示插件通过真实 GUI 读取清单、添加、显示 V1、保存源码后显示 V2，停用后恢复原内置正文。未重启会话或窗口。检查注册已从用户配置移除，源码和截图仅保留在本次回执目录。
- 原生页面地址输入将本地绝对路径、file URI 与网络 URL 分别传给原有文件/网络入口。本次最终 GUI 用绝对路径实际打开本地 HTML；无需额外授权。file URI、Windows 路径分支为代码检查，未声称逐个平台实跑。

## DSH 参考与 DeepCode 实现边界

本地参考仓库：`/Users/wangdi/Desktop/Project/deepseek-harness`。参考其清单与逐项配置、局部模块更新及释放旧实例的组织方式；原始依据：[DSH Entry](/Users/wangdi/Desktop/Project/deepseek-harness/vendor/loader/src/config/entry.ts:8)、[DSH Loader](/Users/wangdi/Desktop/Project/deepseek-harness/vendor/loader/src/index.ts:103)、[DSH HMR](/Users/wangdi/Desktop/Project/deepseek-harness/vendor/hmr/src/index.ts:353)。

| 对象 | 实施方式 | 生效时点 / 边界 |
| --- | --- | --- |
| 本地插件发现与管理 | 先读清单得到名称、用途、入口；不要求用户重复手填元数据；统一用途列表，详情中逐项配置/启停 | 读取清单不执行工具，不把注册等同于加入任务 |
| UI 展示插件 | 复用既有插槽，监听构建后的模块；等待旧子视图与作用域异步释放，再加载替换模块 | 同一窗口局部更新，保留外层输入及 Reader 状态；失败明确显示 |
| 本地 CLI 工具 | 一次调用一个 CLI 进程，结构化 JSON 输入输出；准备时捕获单文件入口实现 | 运行中下一个请求更新选择、定义、指导和绑定；已有请求/等待授权保留旧绑定 |
| 第一方 GitHub / PDF / arXiv | `deepcode-first-party-provider --plugin … --call` 直接调用既有实现 | 不启动 MCP 握手或常驻 MCP Server；GitHub 当前使用已有 API 实现，并非声称已改为 `gh` |
| 外部 MCP | 保留现有 stdio 接入作为高级连接方式 | 采用与 CLI 一致的 Kernel 权限、执行和记录，不在工具选择器展示协议分类 |
| 整套 GUI / Editor 资源 | `make ui UI_SURFACE=…` 单目标构建，`scripts/update-ui.py` 发布至已有本地包 | 完成后重新加载窗口；原生二进制与 Kernel/Session 不重启 |
| Host / 原生或核心实现 | 使用正常平台打包 | 需要对应进程更新，未宣称任意原生代码可热替换 |

上述是采用 DSH 思路后的 DeepCode 实现，不是移植 DSH 全部插件运行时。当前本地 CLI 热更新合同明确针对单文件入口；UI 模块按单个已构建文件替换。未测量大量插件的规模性能，也未实现或承诺任意依赖树、解释器或原生核心的热更新。DSH 的依赖解析与回退机制没有被另行复制进 DeepCode。

实际接口说明和模板：[UI/插件开发说明](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/docs/product/ui-plugins.md)、[CLI 插件模板](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/examples/plugins/cli-text/README.md)。

## 验证

### 1. 源码与构建身份

- worktree：`/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main`。
- 分支：`session/document-skill-preview`；基线 HEAD：`0369515`，包含既有 A—H 和本次未提交修改。
- 容器：`deepcode-dev`，目标 worktree 挂载到 `/workspace`；依赖、类型检查、通用编译和前端构建均在项目 Docker 环境完成。
- macOS 平台包：`bin/macos-arm64`，产品版本 **0.5.60**，构建时间 **2026-09-15 15:56:37 UTC**，`sourceDirty=1`。本次授权的 macOS 原生打包步骤在宿主执行。
- 最终 GUI 资源身份时间：**2026-09-15 16:21:14.840 UTC**；按单个 GUI surface 更新并重新加载。后续只改了文档回执，没有再改变运行源码。
- 原生包与最后 GUI 资源有各自的时间和身份，不把两者伪装成同一次完整打包。记录见 [delivery-identity.json](delivery-identity.json) 和 [最终 GUI 更新日志](gui-final-reviewed-update.log)。

### 2. 登记测试与类型检查

| 检查 | 结果 | 证据与范围 |
| --- | --- | --- |
| Rust workspace 登记测试 | 194 通过 | [required.log](required.log)；其 GUI 阶段当时有过期 fixture 失败，已保留原日志 |
| daemon 最后聚焦重跑 | 98 通过 | [daemon-final-tests.log](daemon-final-tests.log)，覆盖 CLI 准备配置修正；不与 workspace 数量相加 |
| Session | 62 通过 | [session-final-tests.log](session-final-tests.log)，含初始选择与运行中追加选择保留 |
| GUI | 67 通过，0 失败/跳过 | [最终 GUI 测试](gui-final-reviewed-tests.log)，在最后布局/错误反馈修改后运行 |
| 既有 Python 检查 | 修复工具 5 项、UI 更新 5 项通过 | [required.log](required.log)，不另外增加复杂 GUI 验证脚本 |
| 类型检查 | 4 个相关包通过；最后 GUI 构建再次 typecheck 通过 | [typecheck.log](typecheck.log)、[最终 GUI 构建](gui-final-reviewed-build.log) |
| 差异检查 | `git diff --check` 通过 | 未放宽测试断言、取消注册或删除测试 |

最初 `required.log` 中的 GUI 失败按过期 fixture/已确认行为变化处理，原因在上方“测试变更说明”；最终通过日志独立保留。没有把最初失败日志改写为成功。CLI 两次真实失败分别保留在 [准备合同失败](cli-live-initial.log)、[选择丢失失败](cli-live-selection-failure.log)，对应生产修复后才进行了最终运行。

### 3. 本次平台包的真实运行

**CLI（通过）**

使用本次包的 `DeepCode-CLI.command ask --plain`，选择 `plugin://pdf@first-party` 与 `plugin://github@first-party`，在本次检查目录读取 1 页 PDF，并查询 `repo:deepseek-ai/DeepSeek-V3`。使用现有配置的 DeepSeek Flash，没有输出凭据。

- Session：`session:9eb8d5ee274b0de310b949af8c7f0e9e`。
- `pdf.read` 实际返回：`DeepCode CLI plugin verification.`。
- `github.search` 实际返回仓库 `deepseek-ai/DeepSeek-V3` 及其 GitHub 链接。
- 两个 Kernel tool record 均 completed；后续 `runtime.released`、`run.settled` 均有记录，最终 run 为 completed；CLI 退出码 0。
- PDF 读取来自工作区绑定授权，GitHub 网络查询来自既有用户设置授权。没有为测试改成宽泛的默认允许。
- 证据：[cli-live.log](cli-live.log)、[cli-runtime-facts.json](cli-runtime-facts.json)。

**TUI（通过）**

使用本次 `DeepCode-TUI.command --session …` 打开上述会话；终端展示 PDF/GitHub 真实结果、completed 状态和可输入提示。Ctrl+C 正常退出，退出码 0。没有发送新的任务。[tui-runtime.txt](tui-runtime.txt)。

**GUI 与简单插件（通过）**

- 本次 `.app` 正常打开，API 已连接、Agent 就绪，原历史会话可读。
- 归档 HTML 实际渲染；并排、铺满、右侧返回、收起/展开有效。
- 原生本地 HTML 输入和计数在收起/展开、铺满/恢复后保留；地址栏绝对路径入口也实际打开；测试页面已关闭。
- 本地 UI 插件读取清单后加载 V1，修改模块显示 V2，停用后恢复内置展示；无需重启会话/窗口。证据：[V1](plugin-v1.png)、[V2](plugin-v2.png)、[停用状态](plugin-disabled.txt)。
- 最后的状态/侧栏位置、重复产物隐藏和导航宽度已实际核对：[并排布局](final-layout-split.jpeg)、[侧栏关闭布局](final-layout-closed.jpeg)。
- 所有八个设置栏目和主交互面的代码审查已完成：[FRONTEND-REVIEW.md](FRONTEND-REVIEW.md)。并非逐页进行复杂 GUI 脚本测试。

### 4. 历史与运行资源

- 原会话 `session:6a2672a00d5ab5835331255f8eed9d4d` 保留既有事件与产物，最终只读核对仍为 432 个事件、最大序号 432；本次运行检查写入单独的测试会话，没有向原会话追加问句或改写原始消息。[事件数量记录](session-event-counts.json)。
- 本次没有修改 Session Store 版本 ID，没有增加硬版本相等门禁；沿用此前已确认的历史读取修正。
- 最终 GUI PID 58968、Kernel PID 58969、Host Web PID 59013 保持运行，留给用户继续查看；GUI 正在使用该 Kernel 的租约。CLI/TUI 检查进程已退出。没有按端口或名称清理其他任务的进程。
- 简单展示插件的测试注册已移除，检查源码和运行证据保留在此目录；本次打开的原生测试页已关闭。历史 HTML 的只读 Reader 保留可供查看。

## 未验收与明确限制

1. Windows/Linux 平台打包和真实运行未在本次 macOS 环境验收。
2. UI 插件与 CLI 绑定更换有聚焦测试及简单实跑依据；没有做大量插件规模、任意依赖树或压力测试。
3. 同一 run 的运行中追加选择由 Session 登记测试覆盖；最终真实 Provider 场景验证的是开始时明确选择的 GitHub/PDF 两个 CLI 工具，不把它表述成“运行第三步添加工具”的完整人工场景。
4. 部分页码/缩放和异步释放路径有源码及登记测试依据；没有运行全主题、全字号、全部窗口尺寸、VoiceOver 或复杂前端脚本矩阵。
5. 前端代码审查仍有 1 项 P1、5 项 P2；其中普通设置文本的编辑草稿应优先修正。整套 UI 更新后需立即重新加载，过渡期间访问旧懒加载入口的缺口见报告 R6。
6. 所有结果为本地源码、测试、构建和运行回执。没有 commit、PR、push、tag 或对外发布。
