# DeepCode

**0.6.2** · [English](README.md)

## 快速使用

从 [Releases](https://github.com/Achbite/DeepCode/releases) 下载对应平台的程序包，解压后打开 GUI：

| 平台 | 启动方式 |
| --- | --- |
| macOS Apple Silicon | `open DeepCode-GUI.app` |
| Windows x64 | `DeepCode-GUI.exe` |
| Linux x64 / ARM64 | `./DeepCode-GUI` |

在 **设置 → 模型与服务** 中添加 API 连接，或登录支持的 Coding Plan。新建对话、选择模型，即可描述任务。项目菜单中的 **管理工作区** 用于配置文件夹和执行环境；Windows 项目可以选择本地 Shell 或 WSL。

同一程序包也提供终端入口：

```bash
# Linux 示例；macOS 使用 DeepCode-CLI.command / DeepCode-TUI.command，
# Windows 使用 deepcode-cli.bat / deepcode-tui.bat。
./deepcode-cli connections
./deepcode-cli auth login openai-codex browser
./deepcode-cli ask -C /path/to/project "分析一下这个项目"
./deepcode-tui -C /path/to/project
```

`-C` 显式选择工作目录；省略时创建独立对话，使用 `--session <id>` 可以继续已有对话。更多命令见 `--help`，连接与订阅配置见 [模型与服务](docs/product/model-services.md)。

GUI 支持向消息附加文件或文件夹、查看产物和 diff，以及让 Agent 打开 HTML 预览。浏览器批注仅通过工具栏按钮或 Esc 退出。新对话继承上次选择的模型及该模型记住的推理强度。重载界面使用 macOS 的 **Cmd+Shift+R**，其他平台使用 **Ctrl+Shift+R**。

Windows GUI 需要 WebView2 Evergreen Runtime，Linux GUI 需要 GTK/WebKitGTK。macOS 程序包使用 ad-hoc 签名，详见 [程序包说明](docs/distribution.md)。

## 从源码编译

先安装 Docker 和 GNU Make。Windows 请在已启用 Docker 集成的 WSL2 中运行构建命令。打包 macOS 还需要宿主机的 Xcode Command Line Tools、`rust-toolchain.toml` 指定的 Rust 工具链和 Node.js。

```bash
git clone https://github.com/Achbite/DeepCode.git
cd DeepCode
make shell
```

`make shell` 准备开发容器；macOS 上还会启动当前 worktree 的原生构建通道。在容器中执行下列命令，或保持容器运行后从宿主机执行：

| 目标平台 | 编译命令 | 输出目录 |
| --- | --- | --- |
| macOS Apple Silicon | `bash ./build.sh --stage package-macos` | `bin/macos-arm64/` |
| Windows x64 | `bash ./build.sh --stage package-windows` | `bin/win64/` |
| Linux，与容器架构一致 | `bash ./build.sh --stage package-linux` | `bin/linux-x64/` 或 `bin/linux-arm64/` |
| 所有可用平台 | `bash ./build.sh` | 上述受支持平台的目录 |

共享 TypeScript、GUI、Linux 程序和 Windows 交叉编译都在 Docker 中执行。macOS 原生编译与签名通过通道交给 Mac 宿主。不可用的平台会明确列出，构建错误仍会返回失败。每个平台也会在 `bin/` 生成带版本号的压缩包；已有用户配置和会话会保留，且不会进入压缩包。

只更新已有程序包的前端：

```bash
make ui-update UI_PACKAGE=bin/macos-arm64
```

其他平台替换为 `bin/win64` 或对应 Linux 目录。macOS 资源更新在宿主机运行以完成签名，随后重载界面。后端发生变化时仍需构建对应服务或程序包。详见 [分发与构建说明](docs/distribution.md)。

## 产品介绍

DeepCode 是优先在本机工作的编程 Agent，提供桌面 GUI、用于脚本的 CLI 和交互式 TUI。三种入口共享对话、工具记录、模型连接和权限设置。

- **处理项目任务：** 读取和修改文件、搜索代码、执行 Bash 或 PowerShell、检查 diff。工作区访问和外部操作遵循配置的权限策略。
- **预览并持续修改：** 通过截图和页面交互检查内置浏览器，选取元素或区域批注，在同一对话中继续修改。原始附件保持只读，可编辑副本可以放在 DeepCode 管理的会话目录中。
- **使用模型服务：** API 连接与订阅服务分别配置和查看用量。Provider 返回的 Token、缓存计数与上下文估算分开呈现。
- **扩展工具与界面：** 通过 Skill、CLI 工具、MCP 和 UI 插件扩展能力。Agent 可以发现并激活可用插件，用户也可以显式引用。外部电脑控制目前支持 macOS，每次调用需要额外授权。
- **生成与阅读文档：** 生成 HTML、Markdown、PDF 产物并在界面中预览。PDF 生成需要安装 [文档运行环境](skills/deepcode-documents/SKILL.md)。

工作区数据、会话日志和工具执行保留在本机。选中的提示词、上下文和图片会发送给配置的模型服务；如果模型服务也在本机运行，则无需发送到远程 Provider。

Session 负责 Agent Loop 和会话状态，Kernel 负责工具与执行权限，GUI、CLI、TUI 展示共享结果。具体说明见：

- [模型、订阅与用量](docs/product/model-services.md)
- [Shell、工作区环境与权限](docs/product/execution-environments.md)
- [运行管理与本地数据](docs/product/operations.md)
- [Computer Use](plugins/computer-use/README.md) · [UI 插件](docs/product/ui-plugins.md)

## 开发检查

在 `make shell` 中执行：

```bash
bash ./test.sh required   # Rust 格式/测试、共享 TS、GUI 合同/类型、构建行为
bash ./test.sh cli        # 另加 CLI → Session → Kernel 链路
bash ./test.sh full       # 另加终端/Web 壳及文档产出检查
```

`bash ./test.sh static` 检查 Shell 语法和 Git 空白差异，可在宿主机运行。端到端脚本使用本地 fixture Provider，不替代真实模型或原生 GUI 验收。原生 GUI 测试使用独立 Cargo workspace：`shells/deepcode-gui/src-tauri/Cargo.toml`。

## 许可证

[MIT](LICENSE)。另见 [来源说明](ATTRIBUTION.md)、[第三方声明](THIRD_PARTY_NOTICES.md) 和 [引用信息](CITATION.cff)。
