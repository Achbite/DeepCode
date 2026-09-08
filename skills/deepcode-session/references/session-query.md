# 会话查询

`session.read` 的 `sessionId` 使用完整标识，例如 `session:...`。默认 `view=summary`；`items` 按事件顺序排列，先返回最近一页。`revision` 是此次读取的 journal 序号，`sequence`、`eventId`、`recordId` 可用于定位证据。

| view | 内容 | 可选筛选 |
| --- | --- | --- |
| summary | 持久化状态、最后请求和回答、Todo、Plan、累计用量及近期工具 | limit |
| messages | 用户、助手和进度消息 | before、limit |
| tools | 工具输入、结果、错误、记录 ID | recordId、before、limit |
| plans | Plan 与 Todo 的事件 | before、limit |
| context | 输入结构和对应调用用量，不含模型推理正文 | providerRequestId、before、limit |

`before` 是不包含该序号的向前游标；将 `nextBefore` 传给下一次读取，返回 null 表示没有更早的匹配事件。`limit` 为 1–50。文本片段带 `truncated` 和原始 `totalBytes`；片段不是全文，不能用它断言被截断部分不存在。`recordId` 仅用于 tools，`providerRequestId` 仅用于 context。读取只覆盖当前配置根的对话。

CLI 使用相同的只读接口，输出 JSON：

```sh
deepcode-cli read --session 'session:...'
deepcode-cli read --session 'session:...' --view tools --limit 5
deepcode-cli read --session 'session:...' --view messages --before 120
deepcode-cli read --session 'session:...' --view tools --record 'record:...'
```

输入缓存命中率 = `cacheReadInputTokens / inputTokens`，不能将输出 token 加入分母。上下文球显示上一次已结算调用的命中率和结构；右上角为整个 session 的累计缓存 token 除以累计输入 token。不同范围的比例不同是正常现象。没有 Provider 用量时保留未统计状态，不将缺失值当作 0。
