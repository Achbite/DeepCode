# DeepCode 完整运行包

当前产品提供一个 DeepCode-GUI，以及共享 Session/Kernel 的 CLI、TUI。独立 Editor 已退役，编辑能力后续由 VS Code 插件提供。

macOS 的 `DeepCode-GUI.app` 包含所有程序和运行资源，可以整体移动。`DeepCode-CLI.command`、`DeepCode-TUI.command` 指向同目录 App 内的可执行文件。GUI 通过平台 Bundle/Resource API 定位资源；启动器显式传递资源位置。Linux/Windows 的 GUI、CLI/TUI、Kernel、first-party provider、Host Web、Node、Session JS 和 Web 资源各保留一份。

包内没有源码树、构建缓存、开发依赖或用户数据库。Linux 桌面仍需要系统 GTK/WebKitGTK，Windows GUI 需要系统 WebView2 Evergreen Runtime。随包保留 Node 和前端依赖许可证；这些系统运行库不重复打进程序包。

`DEEPCODE_CONFIG_DIR` 可指定现有用户数据位置。macOS 启动器及 GUI 默认沿用包所在目录的数据根，移动 App 时可显式指定原数据根；本次整理不迁移已有数据。Linux/Windows GUI 保持程序目录的数据根，直接 CLI/TUI 保持现有 Host config_root 规则。已有输出目录中的 config、runtime、会话、日志等不会被构建覆盖或放进压缩包。

开发环境先在目标 worktree 使用 `make shell` 准备 Docker。从宿主执行 `bash build.sh` 会尝试所有可用平台；`--stage package-linux`、`--stage package-windows`、`--stage package-macos` 可指定单平台。macOS 必须从宿主入口调用，Docker 编译共享 TypeScript/GUI，宿主既有工具链编译 Darwin。缺少的工具链会明确报错；构建不自动安装 Node/Rust、不启用后台打包服务、不失败换源重试。通过 PATH 或 DEEPCODE_MACOS_CARGO、DEEPCODE_MACOS_NODE_BIN 指定已安装工具。

一次 package 调用只准备一次依赖、编译一次共享 TypeScript、检查一次 GUI 类型并构建一次 GUI。Cargo target、registry、pnpm store、已有 sccache 保留；不同 worktree 使用独立可变 target/node_modules。每次清理 TS/Vite 输出并新建空 staging，完整组装后替换明确的程序内容，因此删除的文件和旧 chunk 不会残留。构建号/提交只用于追溯，不用于跨组件相等校验。

`make ui` 只构建共享 JS 和 GUI，输出 `bin/ui/web-deepcode-gui`。`make ui-update UI_PACKAGE=bin/macos-arm64` 或 `python3 scripts/update-ui.py --assets <完整 GUI 目录> --package <现有包目录或 App>` 会完整替换一个 GUI 目录，macOS 同时重新签名。更新后关闭并重开窗口。开发调试使用 `make dev-deepcode-gui` 的 Vite HMR；TypeScript 必须先转译，Session JS 更新需结束当前活动运行并受控重启 Host，不在活动 Agent Loop 内替换模块。

输出同时提供完整目录和压缩包。后续安装器可消费同一份运行内容完成新装或程序替换，NSIS/PKG 等安装格式不属于当前阶段。程序包构建成功与平台交互验收是不同结果。
