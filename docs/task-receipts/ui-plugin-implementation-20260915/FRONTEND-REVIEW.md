# DeepCode GUI 逐页前端代码审查

日期：2026-09-16。范围：当前 DeepCode GUI 的会话、导航、预览、工具入口、任务/产出、设置八个栏目及其直接弹层。共享组件按 GUI 的调用路径核对；不将本报告扩展为 Editor、VS Code 或 TUI 的独立体验验收。

## 后续修复更新（2026-09-16）

本报告保留修复前的审查快照。R1—R6 的源码修复以及用户后续布局批注已完成，最终构建和 72 项 GUI 测试通过；当前逐页结论、证据与锁屏导致的窗口检查余项以 [本轮完整清单](../ui-review-fixes-20260916/DELIVERY-CHECKLIST.md) 和 [本轮 TCR](../ui-review-fixes-20260916/TCR.md) 为准。下方“剩余”及建议顺序描述的是原检查时点，不是当前待办。

## 结论

本次已批准的布局调整、原生预览入口、统一插件列表和插件生命周期策略已经实现并加载到本地 macOS 包。最后两项布局批注已落实：状态与预览开关固定在工作区右上角，任务/产出位于共用标题栏下方；展开预览时不再显示输入区上方重复的会话产物摘要。主对话中属于历史交付消息的产物卡片仍保留。

代码审查仍发现 **1 项 P1、5 项 P2**。这些是可定位的交互问题，不是 Apple 认证结论，也不以测试通过替代体验判断。以下列出的剩余问题尚未修改。布局交付和审查完成，不代表整个前端已无缺陷。

## 一、剩余审查项（按优先级）

### R1 · P1：普通文本设置直接绑定异步保存结果，连续输入可能回退或丢字

- 页面：Agent 行为的系统提示词、执行环境中的文本路径、模型与服务中的搜索服务文本配置；共享数字输入也有同类编辑状态问题。
- 触发：连续输入内容时，每个 `onChange` 都发送保存请求；受控输入的 `value` 却仍来自后端确认后的 `effectiveSettings`。没有独立编辑草稿，响应尚未返回时重新渲染会使用旧值，多次请求也未在该控件内串行化。数字输入清空则立即按 `Number('')` 提交 0。
- 依据：[SettingsField.tsx:69](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/SettingsField.tsx:69)、[SettingsField.tsx:93](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/SettingsField.tsx:93)、[CategorizedSettingsSections.tsx:204](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/CategorizedSettingsSections.tsx:204)、[settingsStore.ts:490](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/state/settingsStore.ts:490)。这是源码链路结论；本次没有修改用户真实系统提示词来做输入试验。
- 建议：文本与多行输入维护本地草稿，沿用已有文档环境/模型卡片的逐项保存方式；确认成功后更新已保存值，失败保留草稿并就地显示原因。布尔开关和固定选项仍可即时保存。不需要改配置 owner 或持久化合同。
- 对照原则：编辑行为应可预测、保留用户输入，并明确区分编辑内容与生效状态。[Apple Settings](https://developer.apple.com/design/human-interface-guidelines/settings)、[Apple Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。

### R2 · P2：“搜索设置”的范围与界面表达不一致

- 页面：整个设置中心，尤其“模型与服务”“执行环境”。
- 触发：在外观页搜索“PDF”不会导航到执行环境；模型卡片根本未接收搜索词；执行环境的一些子卡片在有任何搜索词时全部隐藏。用户可能误认为配置不存在。
- 依据：[SettingsCenter.tsx:65](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/SettingsCenter.tsx:65)、[SettingsCenter.tsx:103](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/SettingsCenter.tsx:103)、[CategorizedSettingsSections.tsx:239](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/CategorizedSettingsSections.tsx:239)。
- 建议：搜索覆盖八个栏目的名称和设置项，结果保留栏目归属并可跳转；无结果显示明确空态。切换结果时保留现有逐项草稿。若暂时仅做栏目内过滤，搜索框必须明确标注其范围。
- 对照原则：设置易于寻找，分类使用用户熟悉的任务词汇。[Apple Settings](https://developer.apple.com/design/human-interface-guidelines/settings)、[Apple Layout](https://developer.apple.com/design/human-interface-guidelines/layout)。

### R3 · P2：自定义模态层缺少完整的焦点进入、约束与返回

- 页面：设置覆盖层、插件导入确认、新建/重命名、删除确认和工作目录管理。
- 触发：这些界面大多是带 `aria-modal` 的普通 `div`；没有统一限制 Tab 留在弹层内、让背景不可交互、处理 Esc 和关闭后恢复触发点。新建/重命名仅有 `autoFocus`。左栏的全局会话快捷键仍处于挂载状态，弹层并未暂停它们。
- 依据：[DeepCodeWorkbenchLayout.tsx:474](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/deepcode-gui/layout/DeepCodeWorkbenchLayout.tsx:474)、[DeepCodeWorkbenchLayout.tsx:647](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/deepcode-gui/layout/DeepCodeWorkbenchLayout.tsx:647)、[PluginsSection.tsx:518](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/PluginsSection.tsx:518)、[DeepCodeSidebar.tsx:160](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/deepcode-gui/layout/DeepCodeSidebar.tsx:160)。
- 建议：优先使用原生 `<dialog>` 或复用一个明确的弹层焦点实现；打开时进入首个合适控件，关闭后返回原按钮；只在无保存操作进行时响应取消。macOS 文件/文件夹选择器已走系统对话框，不归入此问题。
- 对照原则：键盘使用者必须能识别当前操作范围，并可靠地离开临时界面。[Apple Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)、[Apple Popovers](https://developer.apple.com/design/human-interface-guidelines/popovers)。

### R4 · P2：工具搜索和预览标签的键盘行为未统一

- 工具选择：方向键和 Enter 逻辑位于对话输入框。焦点进入工具搜索框后未复用这些逻辑；Esc 仅将焦点移回输入框，未在这一次按键关闭选择器。`aria-selected` 表示高亮行，选择标记又表示已选择/当前请求已就绪，辅助技术不易分辨这两个状态。
- 预览标签：已有 `tablist/tab/tabpanel` 角色，但没有方向键切换、活动标签的 roving tabIndex，以及标签到面板的 `aria-controls/aria-labelledby` 关联。可以用 Tab 逐个访问按钮，尚未形成完整的标签控件操作。
- 依据：[ConversationComposer.tsx:137](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/ConversationComposer.tsx:137)、[useAgentComposer.ts:410](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/useAgentComposer.ts:410)、[ResourcePreview.tsx:280](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/ResourcePreview.tsx:280)。
- 建议：将选择器键盘处理应用到实际焦点所在的控件，明确高亮与选择状态；给 Reader 标签补齐方向键及面板关联。模型菜单已有方向键、Esc、初始焦点和焦点返回，可复用其交互约定：[SessionModelSelector.tsx:56](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/SessionModelSelector.tsx:56)。
- 对照原则：同类控件保持一致，图标按钮有可读名称，并支持完整键盘操作。[Apple Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)、[Apple Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。

### R5 · P2：英语模式仍有部分固定中文文案

- 页面：插件详情、导入确认、连接配置、原生浏览器地址工具条、文件修改与图片加载状态。
- 依据：[PluginsSection.tsx:476](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/PluginsSection.tsx:476)、[NativeBrowserPreview.tsx:195](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/NativeBrowserPreview.tsx:195)、[ArtifactLinks.tsx:40](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/ArtifactLinks.tsx:40)、[FileChanges.tsx:59](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/FileChanges.tsx:59)。
- 建议：将这些产品操作文案迁入现有 i18n 字典；插件自身名称、用户内容和后端原始错误保持来源文本。检查较长英文按钮的换行与截断，不额外建立翻译系统。
- 对照原则：本地化要同时处理文字和布局。[Apple Layout](https://developer.apple.com/design/human-interface-guidelines/layout)、[Apple Typography](https://developer.apple.com/design/human-interface-guidelines/typography)。

### R6 · P2：整套 UI 资源更新后、窗口重新加载前有短暂的新旧资源混用窗口

- 页面：设置等按需加载的页面；只涉及整套 GUI 更新，不是单个展示插件热替换。
- 实际观察：更新工具完成目录替换后，在旧窗口尚未重新加载时进入此前未加载的设置页面，曾出现 `Importing a module script failed`。重新加载后正常。旧窗口仍持有旧分块 URL，而旧资源目录已被替换。
- 依据：[update-ui.py:69](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/scripts/update-ui.py:69)、[DeepCodeWorkbenchLayout.tsx:20](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/deepcode-gui/layout/DeepCodeWorkbenchLayout.tsx:20)、[CategorizedSettingsSections.tsx:149](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/CategorizedSettingsSections.tsx:149)。
- 当前使用边界：整套 UI 更新后立即重新加载窗口；本次已按此路径加载并检查。插件源码热更新不需要这个操作，也不会清空会话输入。
- 建议：把整套 UI 更新后的重新加载通知/操作放在始终已加载的外层界面，清楚提示保存未发送草稿，避免用户先访问失效的懒加载入口。是否需要进一步改变资源发布生命周期应单独决定，本次没有引入旧资源回退或第二套运行路径。
- 对照原则：用户操作应获得清楚且可靠的反馈。[Apple Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)。

## 二、本次审查已经修正的项

| 项目 | 修正及实际边界 | 依据 |
| --- | --- | --- |
| 状态与预览按钮位置 | 同一个 Session header 由原组件渲染到工作区顶部；状态、预览按钮位于最右侧，右侧任务/产出从下一行开始 | [LocalAgentPanel.tsx:117](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/LocalAgentPanel.tsx:117)、[DeepCodeWorkbenchLayout.tsx:304](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/deepcode-gui/layout/DeepCodeWorkbenchLayout.tsx:304) |
| 左栏宽度漂移 | 普通与阅读布局共用 `--dc-sidebar-width`，在既有断点切换；不再在 Reader 单独写死 232px | [deepcodeShell.css:346](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/deepcode-gui/styles/deepcodeShell.css:346)、[documentPreview.css:83](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/documentPreview.css:83) |
| 重复产出区域 | Reader 展开时隐藏窄屏/无上下文栏使用的产物摘要；历史消息中的交付卡片保留 | [documentPreview.css:85](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/documentPreview.css:85) |
| 图标实际绘制过小 | 给 Reader 图标按钮设置正确优先级、30px 点击框和 18px 图标，消除通用 padding 挤压 | [documentPreview.css:50](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/documentPreview.css:50) |
| 通用/外观保存错误不可见 | 将共享保存错误移出“关于”分支，在当前栏目以 alert 显示原始错误 | [CategorizedSettingsSections.tsx:156](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/CategorizedSettingsSections.tsx:156) |
| 归档 HTML 空白、本地地址错误 | 原生导航允许文档 iframe 的 about:srcdoc；本地路径交给原有 filePath 入口；真实本地页和归档 HTML 均已打开 | [nativeBrowser.ts](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/services/nativeBrowser.ts)、[运行记录](native-address-loaded.txt) |

## 三、逐页检查结果

### 主工作区及临时界面

| 页面 / 交互面 | 代码审查与结果 | 实际检查 |
| --- | --- | --- |
| 启动与错误诊断 | 失败保留 Host 原因及日志引用，诊断使用 alert；正常状态从 Host 健康信息读取。[HostStartupDiagnostic](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/shared/HostStartupDiagnostic.tsx:6) | 最终 GUI 显示 API 已连接、Agent 就绪 |
| 项目/会话导航、空对话 | 保留现有品牌、分组、排序和输入空态；导航宽度已统一。菜单和重命名等临时界面存在 R3。[DeepCodeSidebar](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/deepcode-gui/layout/DeepCodeSidebar.tsx:48) | 切换至原历史会话，目录可见；未新增空对话 |
| 会话正文与执行过程 | 使用既有投影和 Markdown；过程默认折叠；文件引用只改渲染，不修改历史内容。[ConversationTranscript](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/ConversationTranscript.tsx)、[resourceLinks](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/resourceLinks.ts:33) | 原会话正文和归档交付可读 |
| 输入与工具选择 | 名称、简短用途、选择标记；错误按实际不可用原因展示，入口不显示 MCP/Skill 类型徽章；文件和文件夹仍共用选择流程。键盘缺口见 R4 | 未发送新的 GUI 对话；CLI 真实运行单独验收 |
| 模型选择 / 用量 / 权限 | 模型菜单保留完整键盘导航；设置与运行中权限分别来自各自投影，等待新 run 生效可见；未知用量不伪造为 0。[SessionModelSelector](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/SessionModelSelector.tsx:56)、[ComposerPermissionControl](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/ComposerPermissionControl.tsx:7) | 当前模型与用量可见；本次没有改用户权限配置 |
| Plan / 请求补充 / 工具授权 | 决策控件紧邻其内容，提交时禁用重复操作；原错误由 store 保留，输入失败不清空草稿。[ComposerDecisionPanels](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/ComposerDecisionPanels.tsx:7) | 代码检查；没有为审查制造新的权限请求 |
| 任务与 Session 产出 | 保留真实任务卡片、计数、时间和缩略图；会话固定产物版本按执行时间倒序，取消“当前轮”过滤；标题栏以下布局已对齐。[DeepCodeTaskPanel](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/deepcode-gui/layout/DeepCodeTaskPanel.tsx:13) | 原会话 PNG 在 HTML 上方；开关预览时位置符合要求 |
| 文件变更 / diff | 基于执行记录读变更，二进制单独标识；读取错误保留。Diff 清理 editor/model/listener，有进入与返回焦点。自定义模态仍需 R3 的整体约束。[FileChanges](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/FileChanges.tsx:16) | 原有修改清单可见；未做复杂编辑器测试 |
| Reader 并排 / 收起 / 铺满 | 单一入口，展开/返回均在右上角；保持挂载实例，拖动分隔条支持方向键；标签键盘见 R4。[ResourcePreview](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/ResourcePreview.tsx:241) | HTML 并排、铺满、恢复、折叠检查通过 |
| HTML / Markdown / 图片 / PDF | HTML 使用 sandbox iframe，执行页面使用原生浏览器；图片适应区域，PDF 页码/缩放保留并取消过期渲染；下载释放对象 URL。PDF 数字页码同样缺少可为空的编辑草稿。[DocumentPreview](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/DocumentPreview.tsx:12)、[PdfDocumentPreview](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/PdfDocumentPreview.tsx:9) | GUI 实看 HTML、图片和展示组件；PDF 内容提取以 CLI 验证，未开展 PDF GUI 全页测试 |
| 原生浏览器 / 页面操作 | 绑定指定 Session/Host，尺寸更新与显隐使用同一页面；原生页避让弹层，明确 close 与 hide；错误原样显示。[NativeBrowserPreview](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/local-agent/NativeBrowserPreview.tsx:130) | 本地页输入/计数、收起/恢复保留；页面关闭；无额外授权弹窗 |

### 设置八个栏目

| 栏目 | 本次代码结论 | 尚存问题 |
| --- | --- | --- |
| 通用 | 语言与默认打开方式归在一起；普通配置使用既有 owner，预览和 diff 不被默认打开方式覆盖；保存错误现已在本栏目可见 | 全局搜索 R2、设置覆盖层 R3 |
| 外观 | 复用系统字体与既有 token；跟随系统主题有监听和清理；主题/强调色使用实际选中状态；说明默认折叠，外观错误可见 | 没有测量所有主题组合的对比度；R2、R3 |
| Agent 行为 | 响应语言与系统提示分组，显示待下次运行生效，保留错误 | 系统提示连续编辑 R1 |
| 执行环境 | 文档 Python 单项保存；项目执行位置独立保存；平台能力不满足时禁用 WSL；来源错误保留 | 文本 Shell 路径 R1，搜索丢失子卡片 R2 |
| 工具权限 | 按工作区写、工程决策、网络读、外部操作呈现；显示设置变更与实际运行状态的区别；授权仍由 Kernel 执行 | R2、R3；未修改实际授权策略来简化 GUI |
| 模型与服务 | 逐模型保存、验证、密钥输入、失败原因及读取状态完整；切栏目保留已挂载草稿；最近实际使用模型由原 owner 管理 | 普通服务文本字段 R1；模型无搜索过滤 R2 |
| 插件 | 用途驱动的统一列表；从既有来源读取，逐项启停/配置、自动读取本地清单、实际加载状态、组件展示在详情内；协议细节只放高级连接配置 | 导入确认 R3；筛选/选择键盘 R4；部分文案 R5 |
| 关于 | 展示实际连接、版本和配置加载状态；可重新加载界面，并提示先保存草稿；不常驻展示后端绝对路径 | 整套 UI 更新后的入口可达性 R6 |

设置依据：[SettingsCenter.tsx](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/SettingsCenter.tsx)、[分类栏目](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/CategorizedSettingsSections.tsx)、[模型](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/LlmSection.tsx)、[插件](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/PluginsSection.tsx)、[项目环境](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/ProjectEnvironmentSettings.tsx)、[工作区 Shell](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/components/settings-center/sections/WorkspaceSandboxSettings.tsx)。

## 四、尺寸、文字与设计边界

- 保留 `-apple-system / SF Pro Text / PingFang SC` 字体栈；既有 token 的辅助文字 11–12px、标签 13px、正文 14–15px、普通标题 16px；设置页面标题仍使用既有 20px。没有将预览稿的大号展示标题搬进产品操作区。[design tokens:123](/Users/wangdi/Desktop/Project/DeepCode/DeepCode-dev-main/userspace/gui/src/deepcode-gui/styles/deepcodeDesignTokens.css:123)。
- Reader 图标按钮 30px、图标 18px、标签栏最小 40px；工具选择行最小 48px，管理列表行最小 68px，名称/用途 13/12px。长说明和本地位置进入详情。这里是项目当前取值，不宣称 Apple 规定所有 Web 控件使用这些像素尺寸。
- 保留现有卡片圆角、分隔线、主题及任务/产出结构；仅对已经批准的入口、布局和信息密度做调整。Apple HIG 用于指导层级、邻近关系、操作一致性和可读性，不自动要求换成另一套视觉语言。
- 位置与状态依据：[最终并排截图](final-layout-split.jpeg)、[右侧任务布局](header-preview-closed.png)、[铺满原生页面](native-expanded.png)。截图中的旧批注 HTML 是用户历史交付物，其正文和样式不是此次重写的产品 UI。

## 五、验证范围与后续顺序

最终前端资源在 Docker 构建并通过类型检查；GUI 现有 67 项登记测试通过（0 失败/跳过）；真实 macOS GUI、CLI、TUI 和简单插件检查见 [TCR](TCR.md)。没有新增复杂 GUI 脚本，也没有进行 VoiceOver 全流程、所有窗口尺寸/主题/平台组合检查。代码支持某种行为与完成该行为的系统验收是不同结论。

建议下一次前端修复先处理 R1，其次将 R3/R4 的键盘和焦点行为统一，再处理 R2、R5 与整套 UI 更新的 R6。本报告没有把这些剩余问题写回锁定开发规划，也没有改变本次验收范围。

## 2026-09-16 最终布局复核

用户后续批注和此前检查缺口已汇总至 [最新 Apple 设计审查](../ui-columns-i18n-20260916/APPLE-REVIEW.md)；以最新分栏、语言、缓存和按钮实现为准，保留本文件的早期审查事实。
