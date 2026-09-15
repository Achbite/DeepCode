# TCR：历史会话保留与 GUI 启动修复

## 授权与问题

用户报告 GUI 因 Session Store schema 7 / 8 不相等而退出，并明确要求减少版本硬切、保留历史会话，允许清理版本号门禁并采用更合适的兼容方式。本次以此新指令为准。

实际旧库包含 4 个会话、443 条事件、8 条命令和 77 条工具记录。7→8 的 SQL 差异只有事件白名单新增 `run.tools.prepared`，没有表或字段变化；上一轮隔离目录验证未覆盖用户日常数据，是此次启动问题的验证缺口。

## 实现边界

- Session Store 按必需表和字段读取能力检查，不再要求应用版本号相等；新库不设置 `user_version`，已有编号保留为历史信息。
- 旧事件白名单在 SQLite 事务内解除，保留原表的其他约束、记录、索引；历史 JSON 不重写。新增事件类型由既有写入入口验证。
- 能正确解析的历史会话保留继续对话能力。本次不新增无法解析的历史格式转换或只读投影。
- 原数据和配置先完整备份，再使用实际 macOS 应用与默认数据目录验证。

## 测试变更理由与新边界

原测试将 SQL 事件白名单差异定义为启动失败。用户已明确改变这项要求，因此需要调整该断言；记录、命令、索引、工作区关联、完整性等保留断言继续有效。

- 更新现有 Rust journal 回归：旧事件约束打开成功，原事件/命令/索引/关联和版本编号不变；新事件可以写入；第二次打开不重复改表；未知事件仍被写入入口拒绝。
- 增加最小聚焦检查：编号差异不影响结构可读的库；缺少必需字段仍返回具体错误；事务失败保留原库。
- 同步既有离线事件修复工具及其聚焦测试，使其消费当前事件存储合同，不依赖 schema 7 或固定事件清单。保留备份、回滚和 owner 锁断言。
- 使用项目现有 Rust/Python 测试入口，不增加复杂 runner，不运行完整 GUI 自动化矩阵。

## 执行结果

| 项目 | 实际结果 |
| --- | --- |
| Docker Rust | `cargo test -p deepcode-kernel-daemon local_agent_store::tests -- --nocapture`，14 项通过 |
| Docker 离线修复工具 | 既有 Python unittest 5 项通过，保留备份、失败回滚、重复执行和 owner 锁覆盖 |
| Docker 静态检查 | `bash ./test.sh static` 通过，包括架构、脚本语法与构建入口检查；`git diff --check` 通过 |
| macOS 包 | 0.5.60，基线 `0369515` 的 dirty 工作区；最终包完成于 2026-09-15 13:17:16 UTC / 北京时间 21:17:16 |
| 真实旧库读取 | 原 4 个 Session 均通过正式 Conversation projection 接口读取 |
| 真实 CLI | 使用包内 `DeepCode-CLI.command` 和默认目录，对原有 Session 发起两次简短问候；两次真实 Provider 往返 completed，退出码 0 |
| GUI | 从 Finder 打开最终 `DeepCode-GUI.app`，API 已连接、Agent 就绪；原项目、旧消息、工具记录及本次续聊均可见 |
| TUI | 最终平台入口在 PTY 中打开已有 Session、显示历史，Ctrl-C 退出码 0 |

### 实际历史保留

实际数据目录：`bin/macos-arm64/runtime/agent-runtime`。先在 owner 锁保护下备份完整 Runtime 与模型配置到：

`bin/runtime-backups/session-storage-20260915-210303`。

- 原有 4 条 Session、3 条工作区关联、443 条事件、8 条命令逐行完全保留，包括 rowid、事件身份、顺序、原始 JSON 与时间。
- 原 77 条工具记录和所有归档输出内容未变；模型 profile 与凭据文件字节未变。
- 原索引保持，三个 SQLite 库的完整性检查均为 `ok`。
- 验证后新增 22 条正常续聊事件与 2 条命令，共 465 条事件、10 条命令。旧内容没有被更新；目录中该会话的 `updated_at` 因实际续聊正常变化。
- 旧库 `user_version` 仍为 7，未涂改成 8；运行入口不再读取或要求该编号。新库保持 SQLite 未设置的值 0。
- 两次续聊属于原 Session `session:c701be8e1278ab0125e22cbaf9e51732`；最终 run `session:c701be8e1278ab0125e22cbaf9e51732:run:mu2p67ms:2`，outcome `completed`。

### Finder 启动中的另一处问题

会话库修复后，直接运行应用可正常连接，但 Finder 启动曾停在 `startup_permission_preflight → read_dir → open`。系统设置中 DeepCode-GUI 的桌面访问已开启；本次只读核对，没有修改 macOS 权限。

Host 在实际读取配置前额外枚举父目录；点击重试时，同一预检还会在 UI 线程等待。修复位于 `shells/deepcode-gui/src-tauri/src/main.rs`：移除该重复预检，实际 I/O 保留原始错误；重试命令改用 Tauri 后台执行。最终 Finder 启动成功，daemon 和 UI proxy 真实加载，未通过临时配置目录或跳过权限环境变量制造成功。

一次重新打包因本轮 GUI 仍在运行而被既有打包入口拒绝；先正常退出窗口再打包成功。原失败日志保留。

## Codex 参考与取舍

参考了 Codex 官方实现：历史 `ResponseItemEnvelope` 保持响应正文，新增 harness metadata 独立存储并使用可选/默认字段；SQLite StateRuntime 在初始化时执行明确的存储演进步骤。参考的是保留历史、按内容和结构演进的方式，没有声称 Codex 完全不使用版本或校验。

- [Codex history domain types](https://github.com/openai/codex/blob/main/codex-rs/history/src/lib.rs)
- [Codex StateRuntime 初始化](https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime.rs)
- [Codex CLI 恢复已保存会话](https://learn.chatgpt.com/docs/codex/cli)

本次旧会话可以被当前 Session 正确解析，因此保留继续对话能力。未知且无法恢复执行语义的旧格式没有新增转换或只读投影；不将这次验证扩大为任意历史格式兼容承诺。

## 资源与证据

- CLI、TUI 检查进程已退出。TUI 首次启动产生的空 Session `session:dc717584729f08d3b0a8d2b75412e53e` 在确认只有一条 `session.created` 且无命令后，经正式 Conversation API 删除；原 4 个会话保留。
- 首次工具拉起后卡在预检的 GUI 仅清理本轮明确 PID；后续 GUI 均正常退出。最终从 Finder 打开的应用留给用户使用，其 daemon / UI proxy 随应用拥有和释放。
- [逐行数据对比](evidence-20260915-startup/history-preservation.json)、[4 个历史投影](evidence-20260915-startup/history-projections.json)、[最终 CLI 回复](evidence-20260915-startup/cli-final.log)。
- [最终 Finder 启动截图](evidence-20260915-startup/finder-startup-final.jpeg)、[Rust 检查](evidence-20260915-startup/rust-tests.log)、[最终静态检查](evidence-20260915-startup/static-final.log)、[最终 macOS 打包](evidence-20260915-startup/macos-package-final.log)、[清理记录](evidence-20260915-startup/cleanup.json)。

本次没有运行完整 `test.sh required/full`、GUI 复杂脚本或其他平台验收。原 A—H 已有改动继续保留；本次新增修改限定为 Session 存储、直接消费该 SQL 的离线修复工具/测试，以及实际暴露的 DeepCode-GUI Host 启动阻塞。没有提交、PR、push、tag 或发布。

结论：本次实际旧库已保留并恢复读取/续聊，最终 macOS 包的 CLI、TUI 和 Finder GUI 基础运行通过。
