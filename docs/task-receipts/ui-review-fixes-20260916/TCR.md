# TCR — 前端批注收敛与审查缺口修复

日期：2026-09-16。用户授权：汇总并处理全部前端批注，以及上一轮审查报告 R1—R6。主对话单独实施，沿用现有界面风格及配置 owner，不修改 Session Store 版本或权限语义。

## 测试变更必要性

沿用现有 GUI Node 登记测试框架，增加最小行为回归：文本草稿在异步保存和失败时保留；设置跨栏目搜索与模型过滤；工具/标签键盘导航；更新通知保留实际加载错误。测试验证用户可观察的状态和边界，不建立复杂 GUI 驱动脚本、不放宽既有断言或删除登记项。涉及真实 DOM 焦点的部分以目标 GUI 简单键盘检查补充，不能用源码字符串断言替代系统行为。

## 已确认的测试合同调整

用户将展开/返回按钮移至共用顶部的侧栏按钮旁。因此维护现有 Reader 测试：原先断言展开按钮在 Reader 内部；现在断言 Reader 内没有重复的展开/侧栏入口，共用控制在并排和铺满状态均包含同一顺序的两个按钮。保留 Reader 的非模态、分栏调整、内容与投影断言。

## 结果

- 最终 `make ui UI_SURFACE=gui` 在 `deepcode-dev` 容器成功：相关依赖构建、GUI TypeScript 类型检查、Vite GUI 构建通过。容器挂载已核对为当前 worktree → `/workspace`。[build.log](build.log)
- GUI 现有登记框架 **72 项通过，0 失败、取消、跳过**。其中本批次 R1/R2/R4/R6 五项聚焦回归编号 68—72；原 67 项保留登记。[gui-tests.log](gui-tests.log)
- `git diff --check` 通过。
- `scripts/update-ui.py` 将最终 GUI 资源更新至本地 `bin/macos-arm64/DeepCode-GUI.app` 并验证签名。仅更新 Web 资源和外层资源签名，未重编译原生二进制或更换 Kernel/Session。[publish.log](publish.log)
- 最终 GUI 资源时间：**2026-09-15 17:44:04.992419 UTC**（北京时间 9 月 16 日 01:44:04）。产品版本 0.5.60，基线 0369515，包含未提交修改。[frontend-build-info.json](frontend-build-info.json)
- 真实 GUI 已核对顶栏/侧栏、并排与铺满、窄列输入、缓存与权限、浅色/深色设置、搜索定位、草稿保留与撤销、Esc、英文工作区和更新提示。最后内置插件英文修订已构建/发布；重新加载及最后的导入/键盘人工检查遇 Mac 锁屏，未伪称通过。
- 检查期间切换了语言/主题；主题已恢复跟随系统。锁屏时界面处于英文，解锁后需要完成最后检查并恢复中文；未发送任务或保存临时 PDF 路径，未新增插件注册。
- 现有 GUI/daemon/Host 进程为用户继续检查而保留；没有模糊杀进程、没有新建后台服务。测试 runner 已退出。

## 失败分类与修正

1. 早期并行执行 UI 构建与测试，构建清理共享 dist 导致测试暂时报模块缺失：属于本轮执行次序问题。随后采用先构建、后测试的串行顺序，最终 72 项通过；没有为该错误增加生产代码兜底。
2. 旧“内部设置 key 不进入 DOM”断言暴露搜索初版直接把 key 放入 DOM：改用 ref Map 定位，保留原断言。
3. Host OS 控件测试使用 React 服务端渲染时读取 Zustand 初始快照，初版 fixture 只改了当前快照：修正隔离 fixture 并恢复初始状态；Windows/macOS 分支都按当前合同断言，没有生产测试专用分支。
4. 真机主题检查定位到 portal 主题别名丢失；在统一产品根节点定义别名。搜索焦点样式原先也框住整个页面，已把整页排除，保留具体设置项焦点。
5. 真机英文检查发现自带插件说明仍是清单中文。内置 first-party 工具在当前 catalog 中的 source 是 mounted，不能按 builtin 字段猜其身份；最终 UI 翻译只按固定 canonical URI 匹配，保持原目录与自定义插件文本不变。
6. 真实 UI 资源替换后保留了 `Unable to preload CSS` 原始错误，并提供可操作的更新提示；重新加载后设置正常。[update-notice.txt](update-notice.txt)

本轮未扩大到 Windows/Linux 平台运行、VoiceOver、压力或复杂 GUI 矩阵。此前 CLI/PDF/GitHub、TUI 与插件 V1/V2 实跑属于原功能批次，见原 TCR；本轮未冒充重新验收这些未改动的后端能力。

完整需求、逐页审查与窗口余项：[DELIVERY-CHECKLIST.md](DELIVERY-CHECKLIST.md)。

## 后续闭合

此前锁屏留下的窗口验证已在后续分栏修订中继续完成。当前最终布局、缓存位置、Setting 拼写、按钮状态和 Apple 逐页审查以 [最新报告](../ui-columns-i18n-20260916/APPLE-REVIEW.md) 为准；本文件保留当时的实施和验证记录。
