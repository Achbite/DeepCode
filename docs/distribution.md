# DeepCode 完整运行包

当前产品提供一个 DeepCode-GUI，以及共享 Session/Kernel 的 CLI、TUI。独立 Editor 已退役，编辑能力后续由 VS Code 插件提供。

macOS 的 `DeepCode-GUI.app` 包含所有程序和运行资源，可以整体移动。`DeepCode-CLI.command`、`DeepCode-TUI.command` 指向同目录 App 内的可执行文件。GUI 通过平台 Bundle/Resource API 定位资源；启动器显式传递资源位置。Linux/Windows 的 GUI、CLI/TUI、Kernel、first-party provider、Host Web、Node、Session JS 和 Web 资源各保留一份。

包内没有源码树、构建缓存、开发依赖或用户数据库。Linux 桌面仍需要系统 GTK/WebKitGTK，Windows GUI 需要系统 WebView2 Evergreen Runtime。随包保留 Node 和前端依赖许可证；这些系统运行库不重复打进程序包。

所有 GUI、CLI、TUI、daemon 的默认用户数据根一致：macOS 为 `~/.config/DeepCode`，Windows 为 `%APPDATA%/DeepCode`，Linux 为 `${XDG_CONFIG_HOME:-~/.config}/DeepCode`。`DEEPCODE_CONFIG_DIR` 可显式指定独立数据根；解压包使用同样规则，不自动迁移其他目录的数据。设置和凭据继续位于 `config/user/local/`，会话、附件及会话工作目录位于 `runtime/agent-runtime/`；日志、缓存、单次调用临时文件分别使用 `logs/`、`cache/`、`tmp/`。需要随会话保留的预览和产物继续留在会话工作目录，不按临时文件清理。已有输出目录中的用户文件不会被构建覆盖或放入压缩包。

开发环境先在目标 worktree 使用 `make shell` 准备 Docker；Mac 上同时自动准备绑定当前 worktree 和容器的宿主打包通道。随后在容器或宿主执行 `bash build.sh` 均会尝试所有可用平台；`--stage package-linux`、`--stage package-windows`、`--stage package-macos` 可指定单平台。容器生成一次共享 TypeScript/GUI 产物，macOS 请求通过共享目录交给宿主，由宿主既有工具链编译 Darwin、组装并签名。

已知存在 Mac 宿主时，通道或工具链失败会使构建返回非零退出码；没有 Mac 构建能力时，默认构建明确跳过，显式指定 macOS 则报错。最终摘要列出实际更新和跳过的平台。通道传回本次日志及退出码，取消只停止本次原生构建；容器停止、`make reset-dev` 或 `make clean` 会结束对应通道。同一 worktree 同时只允许一个构建写入共享产物，宿主未确认退出时保留 staging 和锁，并报告路径。构建不自动安装 Node/Rust、不失败换源重试。通过 PATH 或 DEEPCODE_MACOS_CARGO、DEEPCODE_MACOS_NODE_BIN 指定已安装工具；宿主通道不进入发行包。

一次 package 调用只准备一次依赖、编译一次共享 TypeScript、检查一次 GUI 类型并构建一次 GUI。Cargo target、registry、pnpm store、已有 sccache 保留；不同 worktree 使用独立可变 target/node_modules。每次清理 TS/Vite 输出并新建空 staging，完整组装后替换明确的程序内容，因此删除的文件和旧 chunk 不会残留。构建号/提交只用于追溯，不用于跨组件相等校验。

`make ui` 只构建共享 JS 和 GUI，输出 `bin/ui/web-deepcode-gui`。`make ui-update UI_PACKAGE=bin/macos-arm64` 或 `python3 scripts/update-ui.py --assets <完整 GUI 目录> --package <现有包目录或 App>` 会完整替换一个 GUI 目录，macOS 同时重新签名。更新后关闭并重开窗口。开发调试使用 `make dev-deepcode-gui` 的 Vite HMR；TypeScript 必须先转译，Session JS 更新需结束当前活动运行并受控重启 Host，不在活动 Agent Loop 内替换模块。

macOS 同时输出 `DeepCode-<version>-macos-arm64.pkg`，安装到 `/Applications/DeepCode-GUI.app`，在 `/usr/local/bin` 提供 `deepcode`、`deepcode-cli` 和 `deepcode-tui`。安装后可直接启动 GUI 或终端命令；用户数据由首次运行的用户创建，不由系统安装器写入 root 的 HOME。当前打包使用临时本地签名；正式分发的开发者签名和公证不由本地构建代替。

Windows 同时输出 `DeepCode-<version>-win64-setup.exe`，默认按用户安装到 `%LOCALAPPDATA%/Programs/DeepCode`，创建开始菜单项并添加用户 PATH；重新打开终端后使用 `deepcode`、`deepcode-cli` 或 `deepcode-tui`。Setup 检测 WebView2 Evergreen Runtime，缺少时联网运行微软安装器；安装失败明确报错。卸载移除本安装的程序和 PATH 项，保留 `%APPDATA%/DeepCode` 用户数据。Windows 原生安装、sandbox 和 Shell 适配在 Windows 环境验收。

Host 或启动器自动设置 `DEEPCODE_RUNTIME_DIR`、`DEEPCODE_KERNEL_BIN` 等内部资源位置，无需用户全局配置 Node 或开发工具链。PDF 导出仍需设置可用的 WeasyPrint Python 环境；当前系统 WebKit 打印未保留模板的页边距和页码，因此本轮不替换此依赖。完整目录、压缩包和安装器消费同一份平台 staging；程序包生成与平台交互验收分别记录。
