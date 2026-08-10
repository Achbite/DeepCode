# DeepCode

> 英文说明：[README.md](README.md)

DeepCode 是本地优先的 AI 编程工作台。完整 Editor、简洁对话 GUI、CLI 和 TUI 共用同一个本地 Session Runtime 与 Kernel。

“本地优先”表示应用、工作区访问、会话记录、权限与工具执行由本机承载。除非使用 Ollama 等本地 Provider，否则 Prompt 和选中的上下文仍会发送给你配置的 LLM Provider。

## 选择使用入口

| 入口 | 适合场景 | 启动文件 |
| --- | --- | --- |
| DeepCode Editor | 在一个工作台中使用文件树、编辑器、终端、Git、浏览器和 Agent 会话 | `DeepCode.app`、`DeepCode.exe` 或 Linux GUI launcher |
| DeepCode-GUI | 专注对话、附件、项目会话和结果复核 | `DeepCode-GUI.app` 或 `DeepCode-GUI.exe` |
| CLI | 脚本、一次性提问、会话检查和终端工作流 | `DeepCode-CLI.command` 或 `deepcode-cli` |
| TUI | 交互式终端会话 | `DeepCode-TUI.command` 或 `deepcode-tui` |

只要使用同一配置根，这些入口就会共享会话、模型配置、权限和 canonical timeline。

## macOS 快速开始

### 使用已有本地包

如果已经生成 `bin/macos-arm64/`：

```bash
open bin/macos-arm64/DeepCode.app
open bin/macos-arm64/DeepCode-GUI.app
```

使用终端入口：

```bash
cd bin/macos-arm64
./DeepCode-TUI.command
./DeepCode-CLI.command --help
```

两个 App 都会自动启动各自打包的本地 Kernel。TUI launcher 在无法连接现有 Kernel 时也会启动包内 Kernel。

### 从源码生成本地包

先启动 Docker Desktop 或 Colima，然后执行：

```bash
make package-macos
```

输出位于 `bin/macos-arm64/`，包含两个 App、CLI/TUI launcher、Kernel、Session runtime、Web assets 和包内可写数据根。

如果 App 看起来仍在使用旧资源或旧 Kernel，先退出正在运行的 DeepCode App，再执行：

```bash
make package-macos-clean
```

当前 macOS 包用于本机运行。它采用 ad-hoc 签名，但不是 DMG，也未使用 Developer ID 签名或公证。

## Linux 与 Windows 包

开发和便携打包通过项目容器完成。Windows 用户应在 WSL 中执行以下命令；不支持从原生 PowerShell 直接构建。

```bash
make shell
```

进入容器后执行：

```bash
bash ./build.sh
```

构建结果写入：

```text
bin/linux-x64/
bin/win64/
```

Linux 启动方式：

```bash
cd bin/linux-x64
./deepcode-gui
```

然后打开 [http://127.0.0.1:31245/](http://127.0.0.1:31245/)。Linux 包同时包含 `deepcode-cli` 和 `deepcode-tui`。

Windows 可打开 `DeepCode.exe` 使用完整 Editor，或打开 `DeepCode-GUI.exe` 使用对话 GUI。请保持 `WebView2Loader.dll` 与可执行文件在同一目录，并在目标系统安装 Microsoft Edge WebView2 Evergreen Runtime。

## 配置 LLM

首次对话前：

1. 打开“设置”，选择“LLM”。
2. 添加预设，或新建 OpenAI-compatible、Anthropic、Ollama profile。
3. 填写 Provider Base URL、模型名，以及 Provider 要求的 API key。
4. 启用该 profile，设置默认 profile，然后保存。
5. 在界面提供 Probe 时，用它检查连接。

打包产物可能包含 profile 预设，但不会包含你的 API key。API key 会写入当前配置根的本地 secret store；不要分享该目录。

会话输入框旁的模型选择器决定当前 Session 使用的 profile。Session 已开始执行后，选择器可能暂时锁定，直到当前 run 到达安全边界。

## 开始会话

GUI 的常见使用流程：

1. 打开或选择项目工作区；只读问题也可以直接附加所需文件。
2. 新建 Session，并选择模型 profile。
3. 在输入框中描述希望得到的结果。
4. DeepCode 要求确认时，检查 Requirement 或 Plan 卡片。
5. 根据精确目标允许或拒绝 Kernel permission。
6. 根据结构化事实和实际变更完成最终 Review。

接受 Plan 不等于授予所有权限。文件写入、删除、Git 修改和其他受控动作仍需经过 Kernel permission 与 audit 链路。

普通聊天可以不绑定 workspace：GUI 中不选择项目，或在 CLI/TUI 使用 `--no-workspace`。未绑定 workspace 时，workspace 工具会 fail closed。

## CLI 示例

以下示例使用 macOS launcher；Linux 将 `./DeepCode-CLI.command` 替换为 `./deepcode-cli`。

```bash
./DeepCode-CLI.command daemon status
./DeepCode-CLI.command sessions list
./DeepCode-CLI.command ask -C /path/to/project "分析这个项目"
./DeepCode-CLI.command -p ask --no-workspace "简要解释 RAII"
./DeepCode-CLI.command timeline
```

继续已有 Session：

```bash
./DeepCode-CLI.command sessions resume <session-id>
./DeepCode-CLI.command --session <session-id> ask "继续刚才的分析"
```

运行 `./DeepCode-CLI.command --help` 查看 permission 以及 requirement/plan/review 决策命令。

## TUI 基础用法

以当前目录作为 workspace 启动：

```bash
./DeepCode-TUI.command
```

也可以指定 workspace：

```bash
./DeepCode-TUI.command -C /path/to/project
```

常用交互命令：

- `/help`：显示完整命令。
- `/status`：检查本地 Kernel。
- `/workspace`：查看或修改 workspace 绑定。
- `/sessions`、`/new`、`/use`、`/timeline`：管理和查看 Session。
- `/allow`、`/deny`：处理界面显示的 permission request。
- `/decision`：处理 requirement、Plan 或 Review 决策。
- `/cancel`：取消活动 run 请求，并刷新共享 projection。

## 本地数据与配置

打包桌面壳默认把可写数据保存在分发目录：

```text
config/user/local/settings/   设置与 LLM profiles
config/user/local/secrets/    本地 secret references
sessions/                     Session projection 与 transcript cache
conversation-archives/        对话导出和 debug packages
kernel/                       Kernel ledger 与 runtime records
logs/                         launcher 或 Kernel 产生的日志
```

使用 `DEEPCODE_CONFIG_DIR` 可以指定其他配置根。直接运行 CLI 或 daemon 时，如果未设置该变量，会使用操作系统配置目录。需要在多个入口间共享会话和 profile 时，请让它们使用同一配置根。

分享文件前应检查内容，不要直接发布 secrets 目录、原始 conversation archive 或 debug export。

## 常见问题

### 没有可用模型

打开“设置 → LLM”，确认至少一个 profile 已启用，填写所需 API key，保存并 Probe。

### 应用无法连接 Kernel

检查本地 health endpoint：

```bash
curl http://127.0.0.1:31245/api/health
```

桌面壳通常会自动选择或启动本地端口。直接使用 CLI/TUI 时，`DEEPCODE_API_URL` 可连接已有 daemon，`DEEPCODE_PORT` 可覆盖默认端口。

### CLI/TUI 提示缺少 Session runtime

优先使用完整打包产物；也可以在源码 checkout 中构建 Session runtime：

```bash
pnpm --filter @deepcode/session-core build
```

便携包必须保留 launcher 同目录下的 `session-core/`、打包 Node runtime 和 protocol package。

### macOS App 看起来仍是旧版本

退出全部 DeepCode App，然后执行：

```bash
make package-macos-clean
```

还可以比较 `bin/macos-arm64/build-info.json` 与 `/api/health` 中的源码身份。

### 查看运行诊断

使用“设置 → Runtime Doctor”、Session timeline 或包内 `logs/` 目录。会话导出位于 `conversation-archives/`。

## 从源码运行 UI 调试环境

启动本地对话 GUI 预览：

```bash
make dev-deepcode-gui
```

打开 [http://127.0.0.1:31246/](http://127.0.0.1:31246/)。`make docker-info` 可以查看实际使用的容器、端口、挂载和 volume。

贡献者分支流程和受保护测试变更规则见 [docs/git-branch-flow.md](docs/git-branch-flow.md) 与 [docs/test-change-request.md](docs/test-change-request.md)；它们不属于普通用户使用流程。

## 第三方说明与许可证

详见 [NOTICE.md](NOTICE.md)、[ATTRIBUTION.md](ATTRIBUTION.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [CITATION.cff](CITATION.cff)。

DeepCode 使用 [MIT License](LICENSE)。
