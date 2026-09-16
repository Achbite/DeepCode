# 前端设计与布局责任审查

日期：2026-09-16。工作区：`DeepCode-dev-main`，分支 `session/document-skill-preview`，基线 `33ed55e9d6a45ea7331912825acb05e974693d3c`。本报告针对当前未提交改动后的源码；原生行为验证单独记录在 TCR，不把静态扫描视为整个平台验收。

## 结论与范围

用户指出的设置标题栏没有覆盖、侧栏边界错位、点击出现大蓝框、Esc 失效、图标/颜色散落，以及没有主题导入和 UI 字体入口，已在本批次处理。继续审查发现，编辑器弹窗、阅读区双列布局、局部样式归属、菜单交互和原生浏览器浮层判断仍存在责任分散。建议沿已有容器逐项收敛，不更换前端框架。

覆盖 `userspace/gui/src` 全部目录的静态检索（当前 168 个文件），阅读 GUI/Editor 入口、根布局、设置组件、资源预览、菜单/弹窗、主题/图标入口及直接状态调用链；同时核对 Protocol 用户设置登记和服务端当前路由。没有逐项执行所有产品流程，没有修改 Kernel/Session 的执行合同。各处行号以本轮交付时源码为准。

Apple 依据是可见交互、语义颜色、层次和无障碍要求；Apple 没有规定 React 必须使用何种 Box 或状态库。下文“统一容器/组件所有权”是结合代码与 DSH 的工程判断。[Layout](https://developer.apple.com/design/human-interface-guidelines/layout)、[Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)、[Color](https://developer.apple.com/design/human-interface-guidelines/color)、[Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)、[Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection/)、[Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards)、[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。

## 已在本批次落实的责任边界

| 所有者 | 负责的事实与布局 |
| --- | --- |
| `DeepCodeWorkbenchLayout` + `deepcodeWorkbench.css` | 根 Grid 的列宽、标题行、设置覆盖区域；主会话保持挂载但在设置打开时 inert |
| `DeepCodeNavigationBox` | 常驻的左列 DOM、顶部原生窗口按钮空间和整条侧栏边界；普通导航与设置导航共享该 Box |
| `SettingsCenter` | 分类与搜索；通过 portal 把导航内容放入根导航 Box，不再自己创建另一条窗口侧栏 |
| `AppearanceConfiguration` | 顶部主题/字体两列卡片与窄窗口单列排列 |
| `palette.json` + `palette.ts` | 默认色号、语义字段、用户覆盖校验和 CSS 注入 |
| `themeLibrary.ts` | 主题文件解析、模式独立应用、基于实际颜色推导选中状态 |
| 既有 `settingsStore` | 用户主题、字体和其他设置的唯一保存/读取路径 |
| `icons/registry.tsx` | 内置操作图标及分类语义映射，业务组件只引用 |
| `ModalDialog` / `ThemePicker` | 导入弹窗和主题列表自己的焦点、关闭和键盘生命周期 |

Esc 在设置开启期间由 document 层处理，以覆盖点击空白导致焦点回到 body 的情况；消费 Escape 的内部选择菜单和原生 dialog 优先。未移除键盘可见焦点，只去掉设置行容器的点击蓝框。

“WebSocket 一直检查中”的首个错误位于前端组合入口：GUI 与 Editor 启动了 `heartbeatSocket`，请求 `/ws/heartbeat`；当前 `crates/deepcode-kernel-daemon/src/routes.rs` 没有该路由，会话走 `/api/conversation/sessions/:session_id/read`。本批次删除前端无消费者合同的心跳连接和状态传递，保留真实 `/api/health` 连接状态。没有把 API 已连接映射成虚构的 WebSocket 已连接，也没有为残留 UI 新增服务端路由。

## 仍需分批处理的发现

### 1. P2：弹窗实现分散，背景快捷键没有一致的隔离边界

证据：`components/shared/ModalDialog.tsx:5` 已有原生 `showModal()`、焦点恢复与取消处理；但 `app/App.tsx:397`、`components/code-workspace-choice-dialog/CodeWorkspaceChoiceDialog.tsx:59`、`components/workspace-open-dialog/WorkspaceOpenDialog.tsx:159` / `342` 仍用普通 div 模拟模态。工作区选择框各自安装 window 监听，代码工作区选择框没有同等键盘生命周期；Editor 的全局快捷键处理在 `app/App.tsx:322` 未统一检查弹窗是否消费事件。

影响：不同弹窗的 Esc、Tab、焦点返回行为不同，某些组合下 Cmd+S/Cmd+W 会继续到背景工作区。静态证据成立，本轮没有执行全部弹窗组合。

建议：以现有 `ModalDialog` 承接真正的模态框，把焦点/退出从业务框里移出；全页设置保留根布局切换。聚焦验证取消、提交、返回焦点和一个背景快捷键即可。

### 2. P2：插件设置样式由文档预览模块加载

证据：`components/settings-center/sections/FunctionalPluginSettings.tsx:17` 使用 `settings-plugin-master-detail`，其定义却在 `components/local-agent/documentPreview.css:108`。该样式仅由 `DocumentPreview.tsx:7`、`ResourcePreview.tsx:28` 导入。

影响：设置布局依赖另一个懒加载功能是否已加载，模块抽出或加载顺序改变就会缺样式；这与用户指出的“分别渲染导致结构漂移”属于相同的责任分散。

建议：把这些设置样式移动到实际设置组件的样式文件，并直接从拥有组件导入。新主题/字体模块已经按这个方式组织。

### 3. P2：阅读区标题与正文仍各自定义列几何

证据：`deepcode-gui/deepcodeGui.css:125` 与 `components/local-agent/documentPreview.css:35` 分别定义 `260px / 5px / 280px` 的分栏约束；`LocalAgentPanel.tsx:93` 把同一个 reader-width 分别传给标题与正文。

影响：当前常用窗口下没有观察到错位，但两套最小宽度和断点需要同步维护。后续改动仍可能重现设置页这次的边界不齐。

建议：为阅读区建立唯一几何所有者，标题/正文消费同一列轨道或 subgrid。不要再用空占位元素独立模拟边界。

### 4. P2：部分菜单缺少完整的键盘选择行为

证据：`DeepCodeWorkbenchLayout.tsx:337` 起的项目/会话菜单有 `role=menu` 与 `menuitem`，退出仅通过该文件 `146` 的全局 pointerdown；没有配套的箭头、Home/End、选项焦点或 Escape 管理。其他组件分别实现了类似控制，例如 `SessionModelSelector`、本批次的 `ThemePicker`。

影响：鼠标可用不等于键盘可用，而且菜单打开/关闭后焦点位置不一致。

建议：从实际共性收敛一个锚定选择/菜单基础组件，拥有定位、焦点和关闭生命周期，业务组件只给出选项与操作。不要把 Session 或项目数据移入该组件。

### 5. P2：原生浏览器遮挡判断依赖全局 CSS 选择器

证据：`components/local-agent/NativeBrowserPreview.tsx:138` 起通过一组 dialog、class 和 `data-native-overlay` 选择器判断原生窗口是否应隐藏，并监听 body 的子节点/属性变化。

影响：任何新浮层都必须知道浏览器模块内部的选择器约定；遗漏标记可能导致原生浏览器覆盖页面浮层。新主题菜单已加现有标记，导入窗口使用原生 dialog。

建议：在 UI 根组合层明确可遮挡原生视图的浮层注册/状态接口，再让原生预览消费。只共享 UI 展示状态，不引入第二套运行事实。

### 6. P2：Editor 首次布局尺寸把“无保存值”当成 0

证据：`app/layout/WorkbenchLayout.tsx:43–54` 直接执行 `Number(localStorage.getItem(key))`。没有保存值时 `getItem` 返回 null，`Number(null)` 等于 0，随后被 clamp 到最小值。调用处 `113–119` 传入的默认侧栏 260、Agent 380、底栏 220，首次实际成为 180、300、140。

建议：在数值解析前区分合法缺省和已保存数字。这个问题与 GUI 设置侧栏是不同容器，本轮仅记录，不连带修改 Editor 布局。

### 7. P2：Editor 拖动监听的释放只覆盖 mouseup

证据：`app/layout/WorkbenchLayout.tsx:216–249` 安装 window mousemove/mouseup，清理只在 mouseup，缺少拖动期间卸载和取消的释放路径。

影响：拖动被窗口切换或组件退出打断时，监听与 body 的 resizing 状态可能保留。代码结构可确认；本轮没有人为触发所有中断组合。

建议：把拖动资源放进拥有生命周期的 ResizeHandle，使用 pointer capture 并在 pointercancel/unmount 释放，保留现有宽度语义。

### 8. P2/P3：颜色入口统一后，仍有可读性与系统偏好覆盖缺口

证据：Editor 的 `--dc-editor-dark-text-placeholder` 为 `#52525b`，常用面板背景 `#131316`，sRGB 对比度计算约 2.40:1。当前源码没有 `prefers-contrast` / `forced-colors` 分支。GUI 默认暗色正文、次要/辅助文字在 raised 背景的计算分别约 10.47 / 6.24 / 4.83:1，但这些数值不能证明任意用户主题、图片或全部状态的可读性。

建议：下一批集中调整弱文字和键盘焦点的语义角色，并处理系统增强对比度；不要向每个组件追加硬编码。用户导入的主题目前负责展示其实际色号，不自动修正或伪造主题内容。[Apple Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)

### 9. P3：组件与样式体积偏大，业务组合仍可细分

证据：`localAgentPanel.css` 2288 行、`settingsCenter.css` 1710 行，`LlmSection.tsx` 765 行；根 Workbench 同时组合布局、项目/会话菜单、表单和 workspace 管理。部分设置标签仍在组件里直接写中英文分支。UI 字体族和字号已经集中，但间距、圆角及部分字号角色仍分布在多个样式文件中。单纯使用 CSS Modules 并不能自动解决这些责任问题。

建议：按实际功能拆出可独立装配的 Box、表单控制器和同目录样式，沿现有 store 保留事实所有权；先处理上面的跨模块样式与弹窗问题，再在后续功能修改时逐步拆大文件，不开展一次性全量重写。

## DSH 对照

参考仓库 `/Users/wangdi/Desktop/Project/deepseek-harness`，本轮只读。`packages/client/ui-layout/src/client/AppFrame.tsx:205–234` 由同一个 frame 装配 sidebar / center / rightbar / overlay；`AppFrame.module.css:25` 的 sidebarCol 自己拥有边界，`columns.ts` 集中尺寸计算。这正是本批次常驻 NavigationBox 与根 Grid 的参考。

值得沿用的是“根容器负责几何，内容通过 slot 进入，业务状态留在原 owner”的边界，而非照搬 DSH 的默认宽度、状态管理或全部组件。DSH 的基础按钮和模态也可作为局部参考，但不能据此宣称它的每个交互均满足 Apple 指南。

## 建议顺序与验收边界

优先处理弹窗/菜单的键盘生命周期和设置样式归属，其次收敛阅读区列几何与 Editor resize 所有权，再整理弱文字及大组件。上面未实施的发现是审查建议，不代表本轮已修复，也不作为本次已授权功能交付的附加阻塞。

本轮不包含平台发布、真实 Provider/CLI/TUI 全链路验收，也不把前端构建通过等同于这些结果。实际测试、构建和原生窗口观察见同目录 `TCR.md`。
