# Skill / MCP 冒烟资产

该目录只提供小型本地测试输入，用于验证当前插件组合路径：

- `skills/text-echo-declarative` 和 `skills/text-transform-brokered` 的 `SKILL.md`
  会作为 Session instruction contribution 加载；Skill 文本本身不授予工具权限。
- `mcp/mcp-text-tools/server.py` 是行分隔 JSON-RPC 的本地 stdio MCP Server，
  提供 `text.reverse` 工具；MCP 进程由 Kernel 插件适配器持有并在退出时回收。
- MCP 工具与内置工具使用同一个 Kernel 请求、授权、执行记录和恢复读取路径。
- `plugin/text-tools.plugin.json` 等旧描述文件仅作为历史 fixture 输入，不参与当前运行时组合。

这些资产不形成第二套合同，也不作为发布清单或自审计包。
