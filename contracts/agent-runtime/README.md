# Agent Runtime 合同资产

本目录只保存当前本地 Agent Runtime 的机器合同。它没有迁移脚本、兼容 alias、双读、双写、旧根 fallback，也不包含第二套 Session 或 Kernel 执行路径。

## 当前合同

| 事实 owner | 当前建库合同 | 当前 `user_version` | 负责内容 |
| --- | --- | ---: | --- |
| Host Catalog | `catalog.sql` | 1 | Project、Host 私有 workspace、项目目录索引模板与 Session 归类 |
| Session | `session.sql` | 1 | Session creation snapshot、journal、命令回放、对话目录索引、Plan、Todo、control 拒绝、请求回执与用量 |
| Kernel | `tool-record.sql` | 1 | Session 保留期间不可变的 ToolRecord |

`schema.json` 是 UI、CLI、TUI、Host、Session 与 Kernel 之间的当前 wire schema。SQL 只约束各自 store 的持久化边界，不能替代 wire schema，也不能跨 owner 推断另一层事实。

## 打开规则

- 文件不存在或数据库为空时，执行对应的当前建库合同。
- `user_version` 精确等于当前版本时，验证必需表后打开。
- 其他版本一律拒绝；不迁移、不猜测、不轮询、不读取旧根，也不自动删除用户数据。
- 三个 owner 各自解释自己的 `user_version`，不能用一个 store 的版本推断另一个 store。

## 删除与历史边界

删除 Session 是一次 Session aggregate 删除：Catalog 条目、Session archive、Session 私有目录索引关系和该 Session 的 ToolRecord 一并删除。ToolRecord 不能被普通工具调用任意修改或删除；只有 Host 协调的 Session aggregate purge 可以删除它。

运行时只使用 `runtime/agent-runtime/` 下的当前三个 store。旧目录和旧数据库不属于当前运行合同，不存在只读历史入口。

如果当前数据库出现找不到对应 Session 的孤立 ToolRecord，应保留原始失败并定位生命周期来源；本合同不授权用启动清理、后台扫描或 UI 行为静默删除它们。
