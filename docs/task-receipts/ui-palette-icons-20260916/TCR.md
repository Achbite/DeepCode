# 设置配色与统一图标：测试变更说明

范围：接管被中断任务 01a0a40a-bbd2-7662-b696-da1b7397d655 的最新 UI 需求。以已有视觉风格为基础，在主题模式下加入配色编辑，微调默认暗色，统一内置界面的图标引用和颜色定义，移除设置项容器的点击蓝框。

测试变更必要性：配色编辑新增了持久化输入和分主题重置行为。沿用 GUI 的 Node 登记测试，在 `userspace/gui/tests/session-contract.test.mjs` 增加最小行为回归，验证同一设置存储的写入与重新读取、重置单个主题时保留另一个主题、非法颜色与未知字段保留错误。界面焦点和实际渲染以简单页面操作检查，不创建复杂 GUI 测试驱动，不放宽或取消既有测试。

通过边界：保存成功后重新加载仍得到相同的主题配色；重置只删除选中主题的覆盖；不完整的色号不能变成已保存的颜色。鼠标点击设置行没有整行蓝框，键盘焦点仍可辨认；设置分类图标不同且从同一注册表引用。

追加的用户裁决：设置页完整覆盖工作区和主面板标题栏；主界面与设置页共用常驻 DeepCodeNavigationBox 和根 Grid 的同一列。导航内容通过同一容器切换，边界由容器唯一绘制。原生窗口按钮保留空间；打开/关闭不卸载会话。用户指出 Esc 回归后，定位到点击空白处焦点落到 body、React 子树监听遗漏，改为只在设置开启时注册 document 键盘监听，并保留内部弹窗优先级。

验证范围：核对容器挂载，执行既有 required 门禁以及 GUI/Editor 前端构建，完成设置页明暗主题、配色保存/重置和键盘焦点的聚焦检查。实际结果如下。

参考依据：Apple [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)、[Color](https://developer.apple.com/design/human-interface-guidelines/color)、[SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)。这里采用其层次、语义颜色及一致光学重量的原则；应用内置矢量图标不依赖 SF Symbols 字体。

追加测试范围：用户要求具名主题导入、浅/深主题独立选择及 UI 字体配置。增加最小测试，覆盖导入校验、导入只保存库不应用、选择保留另一模式、手动改色后的选择标识、字体与字号保存/重置。沿用现有设置协议和测试工具，不增加第二套存储。另针对用户报告 WebSocket 长期检查中的问题，在确认首个错误事实后添加对应生命周期回归。


## 实际验证结果

- 容器 `deepcode-dev` 的 `/workspace` 实际挂载 `DeepCode-dev-main`。常规类型检查、测试和前端构建全部在该容器执行。
- `bash ./test.sh required` 通过，包含已有 Rust / 工具链 / Node 登记检查和跨包类型检查；Session 登记测试 62/62，GUI 登记测试 76/76，失败数均为 0。日志：`final-required.log`。
- 本轮共新增 4 个 GUI 行为测试：配色保存及分模式重置；非法颜色及派生强调色对比；主题导入与浅/深模式独立选择；主题库/字体在同一设置存储持久化且不改变当前主题模式。没有删除、跳过或放宽既有测试。
- 最后按用户要求精简说明文本，补齐主题保存后返回控件的焦点及设置页对背景快捷键的隔离。最终 GUI 类型检查通过（`final-focus-check.log`），GUI/Editor 构建通过（`final-build.log`，2026-09-16 03:51:25 UTC）。既有 Vite 大分包提示仍存在，未作为本次配色功能扩大打包优化范围。
- `git diff --check` 通过。静态扫描：自有 TSX 的 SVG 渲染只剩 `icons/registry.tsx`；CSS 引用的 `--dc-*` 变量均能在色表、样式或明确运行时入口找到定义。未声称第三方渲染内容也属于此范围。

## macOS GUI 实机结果

使用当前工作区 `bin/macos-arm64/DeepCode-GUI.app`，以 `scripts/update-ui.py --package bin/macos-arm64 --surface all` 更新前端资源，并在应用内重新加载。

最终资源：GUI 构建时间 `2026-09-16T03:51:24.739484+00:00`，Editor `2026-09-16T03:51:14.149858+00:00`，均基于 `33ed55e9d6a45ea7331912825acb05e974693d3c` 加本轮未提交改动。该操作保留既有 Kernel/Session 原生产物，关于页服务端版本为 `0369515`；没有把前端资源更新当作整包发布。

| 检查 | 观察结果 |
| --- | --- |
| 设置完整覆盖及导航边界 | 主面板标题栏不再露出；主导航和设置导航使用同一左列边界 |
| 点击设置与明暗层次 | 没有整块设置容器的点击蓝框；默认暗色的背景、侧栏、卡片和控件层次可区分 |
| 主题列表 | Aa 配色预览与勾选位置正常，键盘 Down/Return 选择 Catppuccin 成功 |
| 模式独立性 | 改浅色主题后深色保持 DeepCode；手动更改深色背景后深色名称变为自定义配色 |
| 保存与持久化 | 选择主题并把 UI 字号改为 16 后，关闭/打开设置、重新加载整个界面均保留原值 |
| 配色编辑及重置 | 深色背景改为 #202024、Enter 保存成功；重置此配色恢复默认并重新显示 DeepCode |
| 复制与导入 | 当前浅/深完整 JSON 可复制并粘贴回导入弹窗，名称和两种预览正常；非法 #12 显示原始校验错误且添加按钮禁用 |
| Esc 顺序 | 主题列表先关闭，设置保留；导入弹窗先关闭，设置保留；搜索框、切换分类后、空白区域均可 Esc 退出设置 |
| 最终焦点修复 | 主题保存后焦点返回主题选择器；最后重新验证空白处 Esc 退出成功 |
| 运行时信息 | API 已连接、用户设置已加载；不存在的 WebSocket 状态项已移除 |

实机临时修改已恢复为原来的跟随系统、DeepCode 浅/深配色、系统 UI 字体和 14 px。导入弹窗只做预览/拒绝/取消，不向真实用户主题库写测试条目；主题库实际保存与重新读取由上述登记测试证明。

截图：`settings-final-light.jpg`、`settings-final-dark.jpg`、`theme-picker.jpg`、`about-runtime.jpg`、`main-final-light.jpg`。早期截图仅记录迭代过程，以 final 截图和本回执的行为边界为准。

本轮一次重启 GUI 时出现既有 `host_startup_daemon_identity_failed`，随后应用恢复连接，最终本轮界面检查在连接正常状态完成；未修改 daemon 启动实现，不宣称修复该原生启动问题。没有运行新的 Provider 对话，没有执行 CLI/TUI 或 Windows 验收；Editor 的证据为类型检查和构建，未完成实机界面检查。极窄窗口的排列有 CSS 断点，未单独操作原生窗口尺寸验收。

## 交付范围

用户最后要求的冗余说明已收敛：移除主题/字体卡片的流程说明、配色区重复副标题和保存提示；保留字段名、预览、必要导入提示和明确错误/操作结果。状态残留问题通过清理不存在的心跳连接及显示链修复，不新增服务端接口。

架构审查结果在 `FRONTEND-ARCHITECTURE-REVIEW.md`，9 组后续发现与本批次已实施项分别列出。未提交、未建 PR、未发布。

## 追加回归：主题选择菜单被卡片裁剪

用户随后反馈深色主题列表只显示前几项。原菜单在卡片内使用绝对定位，`.settings-card` 的 `overflow: hidden` 裁剪了下方内容；`.appearance-config-box` 的同优先级 `overflow: visible` 受样式加载顺序影响。此前的 `theme-picker.jpg` 未证明菜单完整显示，以上初次主题列表验收范围不包含这一缺陷，完整显示以本次截图为准。

修复在 `ThemePicker.tsx` 和 `appearanceConfiguration.css`：沿用现有设置帮助的原生 Popover 顶层机制，菜单使用固定定位脱离祖先裁剪；按窗口剩余空间选择展开方向、限制菜单高度和横向位置；设置区域滚动或窗口尺寸变化时关闭菜单，菜单内部滚动保持打开。保留原有主题选择、键盘操作、点击外部关闭及焦点返回逻辑。移除卡片上的 `overflow: visible` 特例。实现依据：[HTML Popover 标准](https://html.spec.whatwg.org/multipage/popover.html)。本次没有新增或修改测试资产。

- 容器 `deepcode-dev` 挂载当前 worktree；`bash ./test.sh required` 通过，Session 62/62、GUI 76/76 及跨包类型检查均通过。日志：`popup-required.log`。
- `make ui UI_SURFACE=all` 通过，保留既有 Vite 大分包提示。日志：`popup-build.log`。
- 通过既有 `scripts/update-ui.py --package bin/macos-arm64 --surface all` 更新本地包的前端资源；GUI 构建时间为 `2026-09-16T04:23:51.416917+00:00`，Editor 为 `2026-09-16T04:23:41.053203+00:00`，基于同一源码基线加未提交改动；保留原生 Kernel/Session 产物。
- 在实际 `DeepCode-GUI.app` 重新加载后，浅色、深色列表的 DeepCode、Catppuccin、Gruvbox、Nord 四项均完整显示，菜单跨越主题配置卡片底边并覆盖下方卡片，没有裁剪。截图：`theme-picker-fixed.jpg`、`theme-picker-light-fixed.jpg`。
- 实机确认 `End` 聚焦 Nord、`Return` 选择成功；再次打开后 `Home` / `Return` 恢复 DeepCode，保存后焦点回到主题选择器。深色菜单中 `Esc` 只关闭菜单，设置页面保留，焦点回到深色主题选择器。
- 本次实际临时修改的浅色主题已恢复为 DeepCode；未改变深色主题、主题模式或字体。点击外部、滚动及窗口尺寸变化的关闭逻辑已核对源码，未把中途被用户操作取消的自动化动作记录为实机通过；小窗口向上展开及长列表内部滚动未单独实机验收。

这次回执证明前端修复、容器检查和本地 macOS GUI 上述行为，不构成整包重新发布或 CLI/TUI/Provider 验收。
