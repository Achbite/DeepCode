# DeepCode

> English default version: [README.md](README.md)

DeepCode 是一个本地优先的 AI 编程工作台实验项目，目标是把 Agent 会话协议、Kernel 工具执行、权限审计、上下文压缩、Editor/GUI/CLI/TUI 多入口封装在同一套后端事实源上。当前项目仍处于快速架构闭合阶段，重点是 Kernel 与 Session 层的稳定性，而不是发布级产品承诺。

## 当前状态

- Kernel daemon 提供 `/api/health`、会话归档、工具目录、权限审计、工作区、Git、内部浏览器等 API 入口。
- live 会话协议只接受 `deepcode.agent.protocol.v3` JSON Envelope；userspace Session DriverLoop 负责 prompt 组装、provider 调用、parser 和一次 repair。tagged Markdown 协议输出会被 Session parser 拒绝。
- Editor 是完整工作台封装：文件树、Monaco-based editor surface、终端、Agent 面板、Git 面板、内部浏览器。
- DeepCode-GUI 是简洁对话式 GUI，不等同于完整 Editor。
- GUI 只读分析可以由显式附件或 Session 记忆的项目默认工作目录锚定；这不同于 Editor workspace binding，后者仍是编辑器文件树和代码修改隔离边界。
- CLI/TUI 是命令行和终端交互入口，复用同一个 Kernel/session 事实源。
- Web Dev Host 仅用于开发预览和协议调试，不是正式 UI 封装。

## UI 封装口径

DeepCode 当前区分四套正式 UI 封装：

| 名称 | 定义 | 当前优先级 |
| --- | --- | --- |
| Editor / DeepCode Editor | 带编辑器的完整 GUI 打包态 | 优先承接 Git、内部浏览器、工作台组件 |
| DeepCode-GUI / GUI | 简洁对话式 GUI | 等 Editor 稳定后复用同一套组件流 |
| CLI | 脚本化 Host Shell | 面向自动化和集成 |
| TUI | Ratatui/Crossterm 终端交互 | 面向轻量本地使用 |

UI shell 不拥有第二套 Kernel、Session truth、tool execution、permission 或用户偏好存储。功能组件、权限和工具调用由 Kernel/session 提供。会话编排、上下文组装、PromptEnvelope、provider lifecycle、协议解析和 repair 由 userspace Session DriverLoop 负责，UI 只负责展示、输入和交互差异。

Editor workspace binding 是 Editor 的文件树展示、编辑和代码修改隔离事实。DeepCode-GUI 可以通过显式附件或 Session 项目默认工作目录携带 conversation roots，不要求必须存在 Editor workspace。写入、删除、Git、终端命令和跨项目修改仍必须进入可审查计划、Kernel policy 检查，并清晰披露目标范围。

## 构建与发布模式

常规开发、Linux/Windows 打包优先在 Docker/Colima 环境内完成：

```bash
make shell
bash ./build.sh
bash ./test.sh
```

默认构建目标是完整的本地分发闭环。在容器内，`bash ./build.sh` 会构建共享
GUI assets、DeepCode-GUI assets、Linux/Windows Rust 二进制、可选 Linux Tauri
shell，以及 portable package layout。macOS 环境下，它随后可以向宿主机打包服务
提交请求，补齐 Darwin 原生发布产物。

macOS 原生发布是 Docker-only 构建规则的显式例外。Editor app、DeepCode-GUI
app、CLI、TUI、TUI launcher 和 Darwin Kernel 都是 macOS native artifact，必须
由 macOS 宿主机打包步骤产出，不能用 Linux 容器内二进制替代。

先在 macOS 宿主机启动一次打包服务：

```bash
make macos-package-service
```

然后进入开发容器执行常规构建：

```bash
bash ./build.sh
```

默认 Docker-side 构建使用 `DEEPCODE_MACOS_PACKAGE_MODE=auto`：如果宿主机打包
服务正在运行，构建会自动提交 macOS 打包请求；如果服务未运行，Docker package
仍会完成，macOS 打包会带明确日志跳过。需要发布验收时让 macOS 打包缺失直接失败，
使用：

```bash
DEEPCODE_MACOS_PACKAGE_MODE=require bash ./build.sh
```

macOS product set 默认是 `DeepCode-GUI,DeepCode`。这个顺序是有意的：
先打包 DeepCode-GUI，再由 Editor package 刷新共享根目录 sidecar 和 `web/`，
同时保留 `DeepCode-GUI.app`。只在定向重打包时覆盖：

```bash
DEEPCODE_MACOS_PRODUCTS=DeepCode bash ./build.sh --stage package-macos
```

也可以直接在 macOS 宿主机生成完整 macOS 包：

```bash
make package-macos
```

当打包后的 App 看起来仍在运行旧 Kernel 时，使用清缓存打包入口：

```bash
make package-macos-clean
```

`make package-macos-clean` 会在重新构建前删除 product `.app`、根目录 sidecar binaries、打包 web assets、Tauri dist 和 macOS target release 二进制等构建/打包产物。它会保留 package-local 运行数据：`config/`、`sessions/`、`conversation-archives/` 和 `kernel/`。

`make package-macos` 会调用 `scripts/package-macos.sh`，输出完整 macOS arm64
发布包：

```text
bin/macos-arm64/
  DeepCode.app
  DeepCode-GUI.app
  deepcode-kernel
  deepcode-cli
  deepcode-tui
  DeepCode-TUI.command
  web/
  DeepCode-GUI.app/Contents/MacOS/web-deepcode-gui/
  config/
  sessions/
  conversation-archives/
  kernel/
  build-info.json
  README.txt
```

本阶段 macOS 包是本机可运行包，不包含 DMG、Developer ID 签名或公证。脚本会生成 package-local 配置根，并写入 `build-info.json` 供 `/api/health` 诊断读取。

如果 `/api/health` 没有 `buildCommit`、`protocolVersion` 或 `toolCatalogVersion`，或者新 run 归档仍显示旧中文 tagged protocol prompt 而不是 `deepcode.agent.protocol.v3`，先退出正在运行的 `DeepCode.app`，再执行 `make package-macos-clean`，然后重新打开 App。打包脚本会在目标 App 或其 bundled `deepcode-kernel` 仍在运行时 fail fast，因为旧进程不退出会导致 review 测试继续命中旧 Kernel。

## 会话协议

live provider-facing 输出以 `deepcode.agent.protocol.v3` JSON Envelope 为准：

```json
{
  "schemaVersion": "deepcode.agent.protocol.v3",
  "proposalId": "proposal-example",
  "kind": "answer",
  "source": "llm",
  "outputLanguage": "zh-CN",
  "referencedResourcePacketRefs": [],
  "answer": {
    "format": "markdown",
    "content": "..."
  }
}
```

`kind` 只能是：

- `answer`：只读回答、解释、身份说明、设计讨论。
- `resourceRequest`：通过 Kernel `ResourceResolve` 补充上下文，可以引用 Session 暴露的 manifest entry id，或 Session conversation root 下的相对路径。
- `actionBundle`：提交给 Kernel 校验的可审查 proposal，不是授权或执行事实。

Resource request 可以指向精确 manifest entry，也可以指向 Session
conversation root 下的路径：

```json
{
  "schemaVersion": "deepcode.agent.protocol.v3",
  "proposalId": "proposal-context-request",
  "kind": "resourceRequest",
  "source": "llm",
  "outputLanguage": "zh-CN",
  "resourceRequest": {
    "version": "1",
    "id": "need-more-context",
    "reason": "需要读取已附加项目中的更多上下文。",
    "items": [
      {
        "id": "entry-readme",
        "manifestEntryId": "manifest-entry-id",
        "reason": "解析已知 manifest entry。"
      },
      {
        "id": "project-file",
        "rootId": "conversation-root-id",
        "path": "relative/path.ext",
        "reason": "解析 conversation root 下的文件。"
      }
    ]
  }
}
```

约束：

- 协议字段、capability、tool schema、代码标识符固定使用英文。
- 最终回答和 review 总结跟随用户语言，默认中文。
- `resourceRequest.items[]` 必须包含 `manifestEntryId` 或 `path` 二选一。存在多个 conversation root 时，`path` 应搭配 `rootId`。
- `path` 只由 Session 在显式附件、项目默认工作目录或已证明的 conversation roots 内解析，然后提交 Kernel `ResourceResolve`；LLM 自行生成的任意本地绝对路径无效。
- `actionBundle.actions[].capability` 使用 capability namespace，如 `workspace.write`、`workspace.delete`、`network.egress`。
- executor tool name 如 `fs.write`、`fs.delete`、`web.search` 只属于 complete 阶段工具调用。
- 写入草案通过 top-level `codeBlocks` 表达，action 通过 `sourceBlockId` 引用。
- v3 parser 保持 fail-closed；解析失败只允许 Session 中的一次受控 LLM repair。Kernel 只验证结构化 proposal，不组装 prompt，也不 repair 模型输出。

## Kernel 能力

当前 Kernel-visible tool catalog 包含：

- 文件与搜索：`fs.list`、`fs.read`、`fs.diff`、`fs.write`、`fs.delete`、`code.search`
- Shell：`shell.propose`、`shell.exec`
- 联网证据：`web.search`、`web.fetch`
- Git：`git.status`、`git.diff`、`git.stage`、`git.unstage`、`git.commit`
- 内部浏览器：`browser.open`、`browser.reload`、`browser.snapshot`、`browser.inspect`、`browser.click`、`browser.type`、`browser.scroll`

高风险能力必须经过 Kernel PermissionGate 与 audit 链路。`fs.delete` 对 LLM 可见，但属于高风险删除能力；用户拒绝后不得 fallback 成 shell 删除。

## 归档与复制

会话归档默认写入用户配置根下的 `conversation-archives/`。便携包或设置了 `DEEPCODE_CONFIG_DIR` 时，归档写入对应配置根。

每个 run 保留：

- `exports/complete.md`
- `exports/debug.json`
- `projection.jsonl`
- `transcript.jsonl`

同时新增 session 级全局时序导出：

- `exports/chronological.md`
- `exports/chronological-debug.json`

完整时序导出包含用户消息、LLM request、provider error、plan/review、用户确认和 tool facts。GUI 的“复制完整时序对话”读取 session 级 chronological export，不再依赖某个 run 必须产生 final answer。

## LLM Provider

DeepCode 支持 OpenAI-compatible、Anthropic、Ollama profile，并针对 DeepSeek V4-compatible 部署提供 best-effort 支持和优化 profile。

这是独立工程适配，也表达对 DeepSeek 团队在开放 AI 研究、前沿模型发展以及 AGI 探索方向上贡献的技术敬意；不表示正式关系、授权、赞助、背书、伙伴关系或长期兼容承诺。

## 第三方与归属

- 编辑器表面是 Monaco-based editor surface，并提供 limited VS Code-style workspace interoperability。
- Codex、Claude、Gemini 等仅作为 AI-assisted development tools 或 architecture / workflow / UX reference；DeepCode 不是这些项目的 upstream、fork 或官方关联项目。
- Codicons、Monaco、Tauri、React、Rust crates、Node packages 等第三方依赖按其各自许可证使用。

更多信息见：

- [NOTICE.md](NOTICE.md)
- [ATTRIBUTION.md](ATTRIBUTION.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [CITATION.cff](CITATION.cff)

## 许可证

DeepCode 使用 MIT License。详见 [LICENSE](LICENSE)。
