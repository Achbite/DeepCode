# Skill / MCP 链路输入

该目录只保留两项可由测试临时装配的原始输入：

- `skills/text-echo-declarative/SKILL.md` 是纯 instruction contribution；它不授予
  Kernel 工具、工作区、Shell、网络或 secret 权限。
- `mcp/mcp-text-tools/server.py` 是行分隔 JSON-RPC 的本地 stdio MCP Server，提供
  `text.reverse` 工具。测试通过临时设置注册它，Kernel 持有并回收对应进程。

测试应通过结构化 Provider fixture 驱动工具识别和执行，不依赖固定自然语言问句或
关键词。运行中的 generation 保持其启动快照；输入变更只应在下一次 run 被发现。

这些文件不是插件 descriptor、运行时合同、发布清单或第二套事实源。
