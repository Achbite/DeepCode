# Agent Runtime v2 合同资产

本目录只保存本地 Agent v2 hard cut 的机器合同。它没有兼容 alias、双读、双写、first-root fallback，也不包含第二套 Session 或 Kernel 执行路径。

## 当前合同

| 事实 owner | 当前建库合同 | 当前 `user_version` | 负责内容 |
| --- | --- | ---: | --- |
| Host Catalog | `catalog.sql` | 3 | Project、Host 私有 workspace、项目目录索引模板、active-v2 Session 归类 |
| Session | `session.sql` | 5 | Session creation snapshot、journal、命令回放、对话目录索引、Plan、Todo、反馈、请求回执与用量 |
| Kernel | `tool-record.sql` | 3 | Session 保留期间不可变的 ToolRecord |

`schema.json` 是 UI、CLI、TUI、Host、Session 与 Kernel 之间的 v2 wire schema。SQL 只约束各自 store 的持久化边界，不能替代 wire schema，也不能跨 owner 推断另一层事实。

## 单向版本链

迁移文件不是冗余建库脚本。运行时只打开当前合同；发现一个受支持的精确旧版本时，按下列链条逐级迁移，每一步成功提交后才进入下一步：

```text
Catalog:    2 -> catalog-v2-to-v3.sql -> 3
Session:    2 -> session-v2-to-v3.sql -> 3
            3 -> session-v3-to-v4.sql -> 4
            4 -> session-v4-to-v5.sql -> 5
ToolRecord: 2 -> tool-record-v2-to-v3.sql -> 3
```

- 不跳版本，不从内容猜测版本，也不在多个 schema 间轮询。
- 当前建库合同不承担旧库识别；迁移入口只接受它声明的前置 `user_version`。
- 迁移后只运行当前代码和当前 schema，不保留 shadow store 或旧写入路径。
- 这些迁移资产不得因“文件较多”被删除；删除任何一步都会使对应已存在本地数据失去明确升级路径。

## 删除与历史边界

删除 active-v2 Session 是一次 Session aggregate 删除：Catalog 条目、Session archive、Session 私有目录索引关系和该 Session 的 ToolRecord 一并删除。ToolRecord 不能被普通工具调用任意修改或删除；只有 Host 协调的 Session aggregate purge 可以删除它。

hard cut 前的 `sessions/` 数据原样保留为只读历史，不迁移进上述三个 store，也不进入新的执行路径。打包目录中的 `session-core/` 是 Session Runtime 代码，不是对话归档。

如果现有数据库出现找不到对应 active-v2 Session 的孤立 ToolRecord，应先保留原始记录并定位生命周期来源；本合同不授权用启动清理、后台扫描或 UI 行为静默删除它们。
