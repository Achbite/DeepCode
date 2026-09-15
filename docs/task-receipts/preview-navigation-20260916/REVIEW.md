# 预览边界、图片产物与起始页修订

日期：2026-09-16。延续已授权的前端调整；以下是用户在上一轮审查后的最新修订。范围为 GUI 呈现与入口，不改变 Kernel、Session、artifact 或原生浏览器的事实合同。

## 逐项实现

| 需求 | 实现与本次检查 |
| --- | --- |
| 放大预览不覆盖左侧项目、对话导航 | 删除 expanded 状态隐藏左导航、改写外层网格列的规则。Reader 仅铺满导航右侧工作区；顶栏保留同宽导航区域。实际窗口已检查放大和还原 |
| 顶部标题稍大、下方增加留白 | 会话标题 13px → 14px，顶栏 40px → 48px；标题与预览头部使用 2px 顶部、8px 底部内边距，按钮在两种布局中保持同一位置 |
| PNG 产物只显示预览图片 | 可直接预览的固定图片产物不再渲染重复文件名和时间；图片本身可点击，文件名保留在按钮无障碍名称与悬停提示。会话区与产出卡片共用同一个组件 |
| 删除“预览 DeepCode”快照入口 | 从起始页删除入口，已打开页面列表也不再推荐应用自身快照；不更改已有原生浏览器协议 |
| 起始页参考 Codex 分区 | 文件、浏览器为居中、无包围线的两行操作入口；文件打开原有本地选择器，浏览器展开网址输入。真实已有页面存在时才显示“已打开的页面” |
| 中英文、主题与键盘一致 | 新文案全部使用 i18n；图标沿用共享组件，背景与文字取现有语义 token；网址输入自动聚焦，Esc 关闭输入并恢复到浏览器按钮 |

普通窄窗口仍沿用已有的响应式导航规则。本次修复的是“放大”动作隐藏导航的问题；没有把预览做成覆盖整个窗口的新页面或新实例。

## 验证

- 容器 `make ui UI_SURFACE=gui`：类型检查与构建通过，见 [build.log](build.log)。构建时间 **2026-09-15 18:54:43 UTC**，见 [frontend-build-info.json](frontend-build-info.json)。
- 构建完成后顺序运行 `pnpm --filter @deepcode/client test`：**72/72 通过，0 失败、0 跳过**，见 [gui-tests.log](gui-tests.log)。本次没有新增或更改测试资产和断言。
- 使用既有更新脚本将 GUI Web 资源更新到本地 macOS .app，见 [publish.log](publish.log)，并通过界面“重新加载”实际加载。
- [PNG 无重复链接](collapsed-images.jpeg)：会话区和产出卡片均仅显示图片；HTML 项仍为文件入口。
- [点击图片后的并排预览](split-image.jpeg)、[放大保留导航](expanded-navigation.jpeg)、[还原并排](restored-navigation.jpeg)。实际点击成功，展开/还原控件在相同右上位置。
- [中文起始页](start-zh.jpeg)、[英文深色起始页](start-en-dark.jpeg)、[网址输入](browser-address-zh.jpeg)。已检查新增文字、分区、主题和输入焦点；Esc 返回浏览器按钮。没有在本轮重新执行网络导航全链路验收。
- [本地文件选择器](file-picker.txt)：从“文件”入口打开原有系统选择器，并取消退出；本轮没有重新验证全部文件类型。
- [最终中文窗口](final-start-zh.jpeg)、[窗口文本](final-window.txt)：已退出设置并恢复中文、跟随系统模式。没有发送聊天任务、创建验证会话或修改用户产物。
- `git diff --check` 通过。

沿用上一轮实际查阅的 [Apple Layout](https://developer.apple.com/design/human-interface-guidelines/layout)、[Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)、[Typography](https://developer.apple.com/design/human-interface-guidelines/typography) 和 [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode) 作为审查依据。本次关注导航边界、控件位置、字级留白、无重复内容、深浅色一致性与焦点返回；具体 CSS 尺寸是产品选择，不声称为 Apple 规定值。

本次没有原生重新编译、Git 提交或发布。macOS 当前窗口的 GUI 检查不代表 Windows 原生窗口或完整平台包验收。

## 后续修订：并排预览增加细线

用户最新要求为“侧边栏展开之后还是加一个细线分割和主面板”，取代此前右侧无线的选择。

- 复用现有 5px 列宽拖拽区域，在中间显示 1px 主题分隔线；顶栏在同一列补齐细线。没有扩大布局间距或增加第二个拖拽控件。
- 并排展开时显示；铺满预览时沿用原有隐藏拖拽区的规则，顶栏细线也仅匹配非铺满状态。窄窗口上下排列时不增加竖线。
- 颜色使用既有 `--dc-border`，跟随浅深色主题。未增加新的颜色配置或改变主题规则。
- 容器构建通过：[divider-build.log](divider-build.log)；最终资源身份：[divider-build-info.json](divider-build-info.json)。GUI 登记测试 **72/72 通过，0 失败、0 跳过**：[divider-tests.log](divider-tests.log)。没有修改测试资产。
- GUI Web 资源已更新并实际重新加载：[divider-publish.log](divider-publish.log)。[实际并排窗口](split-divider.jpeg) 已确认从顶栏到正文的连续细线；本次未再次切换深色或做完整窗口组合检查。

## 后续修订：拖拽命中范围与灰色反馈

- 用户反馈分隔条悬停显示蓝线，且命中范围过小。鼠标响应宽度由 **5px 增至 15px**，向原网格间隔两侧扩展；实际网格仍为 5px，可见细线仍为 1px，面板间距不变。
- 原悬停 `background` 简写既设为强调蓝色，又重置了裁剪方式，导致整个拖拽条变蓝。现改为独立的 1px 伪元素绘制线条，普通态用 `--dc-border`，悬停、拖拽和键盘焦点使用 `--dc-border-strong`；移除分隔条的蓝色焦点外框。
- 容器构建与现有 **72/72 GUI 测试通过**，未修改测试资产。见 [构建](drag-target-build.log)、[测试](drag-target-tests.log)、[本地资源更新](drag-target-publish.log) 和 [资源身份](drag-target-build-info.json)。
- 当前 macOS 窗口已从细线右侧约 4 个截图像素的位置拖拽成功，预览宽度显示由 64 变为 61；见 [交互记录](drag-target-interaction.txt) 与 [灰色细线截图](drag-target-check.jpeg)。尝试恢复时工具检测到用户已操作界面，已停止操作并保留用户当前列宽。
- 用户明确反馈 **“我已验证”**，据此结束本轮交互检查。

## 保存点前修订：移除常驻说明文字

用户要求清理权限菜单截图中的“已保存的选项将在下一个 run 激活”，并明确包含设置中的“Agent 运行配置已保存；下一个 run 将从 Host 激活最新配置”等说明占位文字。

- 移除权限菜单和 Agent 设置的激活说明框、对应的无用状态订阅、专用样式和中英文文案。
- 清理通用、外观、执行环境、模型、插件和用量页面中常驻的介绍、实现细节与重复操作说明，包括语言包占位说明、主题生效说明、环境切换长段说明和插件页介绍。
- 保留选项标题、输入控件、字段悬停帮助、空态、实际运行数据、保存失败及配置异常反馈。没有修改设置保存、运行配置激活、权限或 Windows 平台条件。
- 容器 `make ui UI_SURFACE=gui` 通过，见 [构建记录](settings-cleanup-build.log) 和 [资源身份](settings-cleanup-build-info.json)。随后独立运行现有 GUI 登记测试，**72/72 通过，0 失败、0 跳过**，见 [测试记录](settings-cleanup-tests.log)；本次未新增或修改测试资产。
- GUI Web 资源已更新到本地 macOS 包，见 [更新记录](settings-cleanup-publish.log)。本次没有再次操作或重载用户当前窗口；重新加载界面后使用新资源。前述用户验证针对拖拽交互，不据此宣称这次文字清理已经过用户验收。
- 源码中已无上述两处说明文案及组件引用，`git diff --check` 通过。随后按用户要求将累计改动分组提交为本地保存点。
