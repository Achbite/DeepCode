# DeepCode 本地 Agent 架构 v2 Hard Cut 合同

状态：**LOCKED——作为 P1–P8 的唯一实施合同**

合同 ID：**deepcode.local-agent-hard-cut.v2**

适用范围：DeepCode 本地编码 Agent 的 Kernel / Runtime、Session /
Orchestration、Host composition、CLI、TUI、GUI，以及它们共享的投影与插件边界。

本文是本轮唯一规范性架构合同。用户已完成文本复核并明确回复 **LOCKED**；本文从
该回复起成为 P1–P8 的实施合同。它描述已经确认的目标语义，不把当前代码、现有 v1
schema、store 或运行态误写为已满足本合同。

---

## 1. 产品定位与本次目标

DeepCode 是本地优先的 coding Agent 框架，不是云端 Agent 平台，也不以多租户、
公网服务或对抗性安全平台为当前目标。

本次 hard cut 只解决以下核心问题：

1. 用一个函数式 Agent Loop 取代跨 Rust、Node、Host 重复推进的多套循环。
2. 让 Kernel 成为受控工具目录、effect 准备、执行和执行记录的唯一 owner。
3. 让 Session 成为会话节奏、上下文、模型交互、journal 和语义投影的唯一 owner。
4. 让 CLI、TUI、GUI 只消费同一份共享投影，不在 UI 壳内建立第二事实源。
5. 用 Host 私有 workspace catalog 和 Session creation snapshot 表达项目与工作目录。
6. 用结构化 Plan intent 为 workspace mutation 提供精确、短生命周期的授权。
7. 以显式 v2 hard cut 清除旧数据、旧权限和旧执行路径对新运行时的影响。
8. 保留轻量、可替换的插件组合方式，为 Skill、MCP 和后续 contribution 类型提供
   统一入口，但不提前实现复杂插件管理平台。

本合同追求的是职责清晰、链路透明和最小完整闭环，不是把现有类、事件和文件逐项
保留下来。

## 2. 明确非目标

本阶段不引入：

- 云端控制面、账号系统、多租户或远程协作权限。
- 泛化攻击面审计、复杂 RBAC、策略引擎、审计账本或额外安全平台。
- 为未来公开服务预置的 DDoS、证书轮换、复杂密钥托管或灾备体系。
- Kernel 与 Session 的新独立进程拓扑；第一版保留当前 Rust / Node 物理边界。
- 插件热更新、generation graph、shadow runtime 或多版本同时激活。
- v1 与 v2 双读、双写、兼容 alias、字段猜测或 first-root fallback。
- 强制 Review、Finalize、FinalAnswer 的第二套 Provider 回合。
- 为所有 run 强制经过 Plan；只读任务和直接回答可以不产生 Plan。
- executor.started、run.settling、assistant.chunk 或为 UI 动画额外制造的 canonical
  事件。
- intent digest、自哈希 manifest、巨量 schema 向量或测试专用生产分支。
- 未经测量的吞吐、延迟、并发或规模承诺。

普通边界检查、资源释放、取消、错误传播、路径规范化和 owned process 清理仍属于
基础工程正确性，不因上述非目标而取消。

## 3. Hard-cut 不变量

v2 实现必须同时满足以下不变量：

1. **唯一 Loop**：只有 Session 内的 runAgentLoop 决定下一次 Provider 调用、
   工具调用、等待用户或终止 run。
2. **唯一 Session journal**：每个 Session 只有一条连续、append-only 的
   canonical event 序列；恢复和实时展示使用同一 reducer。
3. **唯一语义投影**：SessionProjection 由 Session reducer 生成；CLI、TUI、
   GUI 不运行私有 reducer，也不从流静默、按钮状态或文案猜测事实。
4. **唯一 effect 执行点**：所有具有副作用的工具只在 Kernel 内通过
   PreparedEffect 执行并记录。
5. **Host 不是第四事实层**：Host 只拥有 composition、进程、transport、私有
   workspace 映射、store adapter 和 operator 入口，不推进 Agent Loop。
6. **模型文本只来自模型**：普通 narrative / answer 由 LLM 直接输出
   Markdown 正文；interaction.request 与 plan.intent 只能由 LLM 调用
   Session 保留的结构化 control 工具产生；Session、Kernel、Host、UI 不伪造、
   猜测或回退生成 DeepCode 助手语义。
7. **activity 只投影已有事实**：Session 只能从 canonical journal facts 和已存在
   的 Kernel record 投影 activities；不得为了显示“正在执行”新增事实。
8. **workspace 身份与路径分离**：Session、Prompt、普通 projection 和普通 UI
   使用 workspaceId 与相对逻辑路径；canonicalRoot 只由 Host 私有持有。
9. **Session creation snapshot 固定、run 目录集合冻结**：Session 创建时固化
   workspace binding snapshot；项目模板后续变化或会话归类变化不修改该 snapshot。
   已有 Session 只能通过显式 directory-index command 追加或移除对话级目录索引；
   每个 run 在 `run.started` 固定一次 creation snapshot 与当时仍 attached 的目录集合。
10. **workspace mutation 只认 Plan authority**：缺少匹配 Plan、Plan 已失效或
    operation / target 不完全覆盖时，Kernel 拒绝执行，不回退到逐调用询问、
    全局 allow 或自然语言 Plan。
11. **终态唯一**：每个 run 恰有一个 run.settled；completed、failed、cancelled、
    indeterminate 不互相折叠。
12. **v2 单路径**：新 catalog、Session store 和 tool-record root 是 v2 唯一执行
    数据源；旧数据只能走只读历史入口。
13. **命令幂等**：同一 sessionId + commandId 的完全相同命令重放原结果；同 ID
    不同内容是冲突，不追加新事件。
14. **调用身份稳定**：callId 表示逻辑调用，attemptId 表示一次执行尝试；旧 attempt
    不能完成另一个 call 或较新的 attempt。
15. **投影不是控制门**：UI 是否在线、是否及时消费 projection，不影响 Agent Loop
    推进、effect 完成或 run settlement。

## 4. 分层职责与事实 owner

| 层或组件 | 唯一负责 | 输入 | 明确不负责 |
| --- | --- | --- | --- |
| Host composition / supervisor | 服务装配、物理进程、transport、私有 workspace catalog、store root、shell 生命周期 | 启动配置、shell 命令 | Agent continuation、模型语义、tool outcome |
| Catalog service | Project、workspaceId、canonicalRoot、project bindings、Session 归类元数据 | 显式项目和文件夹管理命令 | Session directory-index 有效状态、权限自动授予 |
| SessionActor | 命令串行化、Loop、context、journal、Session directory-index、Plan / interaction 等待、run settlement | 用户命令、typed Provider turn、Kernel result | 工具执行、路径根解析、UI 布局 |
| runAgentLoop | 下一步是 Provider、tool、等待或终止 | immutable AgentDeps、Session state | 持久化实现、Host 进程管理 |
| Provider / LLM | 普通 Markdown 文本、typed turn 生命周期、Session control call 与 Kernel tool.call | Session 组装的模型请求 | 授权、effect 执行、终态落库 |
| Kernel | 工具目录、canonical invocation、PreparedEffect、coverage、执行、record、cancel | ToolExecutionRequest、PlanAuthority | Prompt、会话节奏、UI 文案 |
| Session reducer | 从 journal 与 Kernel record 生成 SessionProjection | canonical facts | 生成替代事实、修复上游错误 |
| CLI / TUI / GUI | 输入采集、投影渲染、附件与 artifact 呈现、用户决定采集 | Catalog view、SessionProjection | 私有会话状态机、权限判断、终态推断 |

Project 是 Host catalog 中的归类与新 Session 模板，不是工作区权限本身。
workspace binding snapshot 才是某个 Session 可寻址工作目录的事实。

## 5. 组合根与最小端口

### 5.1 Composition root

Host 只装配稳定端口：

    HostComposition {
      catalogPort
      conversationPort
      projectionPort
      providerPort
      kernelPort
      workspaceResolverPort
      sessionStore
      toolRecordStore
      pluginContributions
    }

这些端口可由内进程对象或受监督 IPC 实现。端口身份不等于插件实例身份、
extension generation、logical call 或 attempt。

### 5.2 CatalogPort

CatalogPort 负责：

- 创建、重命名和归类 Project。
- 显式登记 workspace folder，并生成稳定 workspaceId。
- 管理 Project 的有序 workspace binding 模板。
- 创建独立 Session 或基于 Project 模板创建 Session。
- 移动 Session 的 Project 归类，但不改 Session binding snapshot。
- 为文件夹选择和管理弹窗提供受限的真实路径视图。
- 为普通侧栏和会话投影提供不含绝对路径的 display view。

CatalogPort 不向 Provider 目录暴露，不授予工具 effect。

### 5.3 ConversationPort

第一版只接受少量 versioned command：

    message.submit
    session.directory-index.attach
    session.directory-index.detach
    run.profile.select
    run.cancel
    interaction.respond
    plan.respond

创建、删除、移动 Project / Session 属于 CatalogPort，不混入 Agent continuation。Host
先把显式选择的目录 canonicalize 并私有登记为 workspaceId，再向 ConversationPort
提交只含 `workspaceId + displayName` 的 directory-index command；绝对路径不进入命令。
即使调用方使用通用 command submit 路由，Host 也必须在转交 Session 前，以私有 Catalog
核对该 workspaceId 已登记且 displayName 与 Catalog display view 完全一致；未知 ID 或伪造
显示名直接拒绝，不能让 Session 或 GUI 根据公开字段反推 canonicalRoot。

plan.respond 是闭合 union：

    select { optionId }
    feedback { text, optionId? }
    ignore

所有 command 都携带 commandId、sessionId；run 内命令还必须携带 runId 和精确的
interactionId 或 planId。SessionActor 串行录入并执行命令幂等检查。

### 5.4 ProjectionPort

ProjectionPort 提供：

- 按 sessionId 读取当前 SessionProjection。
- 按 projection revision 订阅 snapshot 或 delta。
- 读取 Session 私有维护并随快照投影的当前 run assistantDraft；该字段可丢弃，
  不属于 journal。

projection revision 只描述展示快照版本，不是 Agent 执行 epoch。

### 5.5 ProviderPort

ProviderPort 接受 Session 组装的 immutable request，并输出 typed turn 事件：
text.delta、assistant.message、tool.call、completed 或 failed。普通文本不再包装为
DeepCode 自定义 JSON / JSONL。Provider adapter 不拥有 Session state，也不根据
UI 是否在线决定 continuation。

Provider 若要求在同一原生工具调用续轮中回送其私有 reasoning 字段，adapter 可以按
`providerRequestId + callId` 在当前 run 内短暂持有并原样回送该字段。它不是 narrative、
answer、journal 或 projection；turn 闭合、失败、取消、settled 或进程恢复时直接丢弃。
Shell 不展示该字段，也不把它改写为用户可见的“思考过程”。

### 5.6 KernelPort

KernelPort 第一版保留：

    listTools()
    executeTool(request)
    cancelTool(callId, attemptId)
    readRecord(callId)

executeTool 内部完成 canonicalize、prepare、authority coverage、execute 和 record。
Host 与 UI 不直接执行工具。

### 5.7 WorkspaceResolverPort

WorkspaceResolverPort 是 Host 提供给 Kernel 的可信本地端口：

- 输入 workspaceId。
- 返回该 ID 对应的 immutable canonicalRoot 或明确错误。
- 不向 Session Prompt、Provider tool schema、普通 projection 或普通 UI 返回绝对路径。

Kernel 使用它将 workspaceId + normalized relative target 解析为私有执行目标。解析
失败、越出 root、symlink 逃逸或 ID 不存在都直接拒绝，不猜测其他 root。

### 5.8 本地 Session 子进程 transport

Host 与本地 Session 子进程的 JSON line frame 仍是 transport，不是第四层事实源。第一版
单帧上限为 1 MiB；reader 必须在累计读取时增量检查上限，在换行出现前越界即拒绝，不能
先无界读入内存再校验。被监督子进程的 stderr 只作为有界诊断回执保留，当前实现上限为
16 KiB；进程退出、启动失败、显式 shutdown 与 owner drop 都必须 join reader 并回收句柄。

## 6. 唯一函数式 Agent Loop

SessionActor 保证一个 Session 同时只有一个状态推进者。runAgentLoop 的核心形态为：

    runAgentLoop(state, deps):
      while run 尚未 settled:
        1. 从 journal reducer state 构造下一次模型请求。
        2. 调用 ProviderPort，按 requestId 校验 typed turn 事件，并把 text.delta
           累计到当前 run 的 assistantDraft。
        3. turn 含 Kernel tool.call 时，把同时产生的普通文本作为 narrative 提交，
           追加 tool.requested 并调用 KernelPort。
        4. turn 调用 interaction.request control 时，提交同时产生的 narrative，
           校验 control 参数，追加 interaction.requested 与 run.waiting，等待
           interaction.respond。
        5. turn 调用 plan.intent control 时，提交同时产生的 narrative，校验 Plan
           结构，追加 plan.intent.requested 与 run.waiting，等待 plan.respond。
        6. Kernel result -> 追加 tool.completed 或对应拒绝事实，把结果送回同一 Loop。
        7. turn 没有任何 tool.call 时，普通文本就是 answer；原子追加 assistant
           message.committed 与 run.settled(completed)。
        8. turn 闭合提交后清除 assistantDraft；恢复只依赖 journal，不恢复草稿。
        9. Provider、typed turn、control 合同或不可恢复执行错误 -> 追加
           run.settled(failed 或
           indeterminate)。

Loop 不经过 Review、Finalize 或第二次 FinalAnswer Provider pass。answer 本身就是模型
明确输出的终答。

Session persistence、Provider adapter、Kernel transport 和 UI subscription 是 Loop
依赖，不在 Loop 内形成第二组业务 switch。

## 7. 模型 turn、叙述与用户介入

### 7.1 Typed Provider turn

ProviderPort 第一版只向 Session 交付与同一 requestId 绑定的 typed turn 生命周期：

    text.delta
    assistant.message
    tool.call
    completed
    failed

普通文本是 LLM 原生 Markdown 正文，不再要求模型把正文编码成 DeepCode JSON 或
JSONL。Session 不保留双解析器，不从自然语言猜测 control，也不在解析失败后回退到
另一种输出协议。

Session 只依据该 turn 是否包含 tool.call 确定普通文本的角色：

- turn 不含 tool.call 并正常 completed：累计文本是 answer。只有该 answer 与
  run.settled(completed) 的原子提交可以正常完成 run。
- turn 含 Kernel tool.call：同时累计的普通文本是 narrative；它进入中间对话区，
  但不证明工具已执行。工具请求仍由 Kernel 决定是否可执行。
- turn 调用一个 Session control：同时累计的普通文本是 narrative；control 参数
  另外按其闭合结构校验。
- turn 只有 tool.call 而没有文本：不制造 narrative。

`assistant.message` 若 Provider 提供，必须与同一 turn 的累计 delta 一致；它不建立
第二份正文。Provider failed、requestId 错配、消息与 delta 不一致、未声明工具、
control 冲突或空 answer 都是显式合同失败。

流式工具调用的数组 index 是 Provider wire 事实。OpenAI-compatible 与 Anthropic adapter
都必须收到非负整数 index；缺失、负值或错误类型直接以
`provider_tool_call_index_invalid` 失败，不能默认成 0 后把不同调用合并。

Session 为 Provider 注册两个保留 control 工具：

    interaction.request
    plan.intent

它们只能由 LLM 通过原生结构化 tool.call 调用。每个 control call 的 callId 分别成为
interactionId 或 planId；同一 turn 最多一个 Session control，且不能同时调用 Kernel
工具。普通自然语言、Markdown 标题、代码块和 UI 文案都不能产生这两类事实。

普通 narrative / answer 与 control 中的 prompt、option 文案只能来自 LLM。Session
可以：

- 校验结构。
- 分配 eventId、sequence、messageId 等系统身份。
- 追加 canonical event。
- 投影确定性的状态码、工具名、时间和 outcome。

Session 不可以：

- 用模板拼接出伪装为 DeepCode 的中间叙述。
- 把 tool.requested 投影成“执行成功”。
- 因模型未输出 narrative 而自行补写思考过程。
- 把错误码改写成 assistant answer。
- 把正文重新包装成自定义 JSONL，或在 control 失败后把原文当作普通 answer。

UI 可以根据 error code 显示本地化系统提示，但必须与 DeepCode 的模型消息在视觉和
语义上区分。

### 7.2 模型主动请求用户介入

interaction.request 必须来自保留 control call，并以其 callId 作为 interactionId。
Session 追加
interaction.requested + run.waiting(userInput)，Shell 只渲染 projection 中的
prompt、options、allowFreeform。

用户回复通过 interaction.respond 返回。自由文本是用户消息事实，不是 permission
或 Plan authority。Session 在同一 run 中恢复唯一 Loop。

### 7.3 中间过程展示

中间对话区的叙述由 narrative 驱动；工具 activity 也按 journal 顺序留在中间主时间线，
并由 canonical facts 驱动。右侧任务区只显示 LLM 通过 `todo.update` 明确提交的 Todo，
右侧产出区显示 artifacts。三者不能互相替代：

- narrative 可以解释意图，但不能证明 effect。
- activity 可以显示已请求、等待和结果，但不能生成模型解释。
- Todo 只表达模型明确提交的任务状态，不能根据工具请求、工具完成或自然语言自动补写。
- 当前 turn 的 token 文本只能通过共享 projection 的 assistantDraft 短暂显示；第一版
  不把 Kernel tool progress 另建成 Shell 可消费的私有流。

模型若没有输出 narrative，UI 不制造叙述。Provider 输出合同和 Prompt 应鼓励模型在
长任务的有意义边界输出 narrative，但这不是 Session 合成文本的许可。

### 7.4 当前 run assistantDraft

SessionActor 私有持有至多一个当前 run 的累计 assistantDraft，并把它作为共享
SessionProjection 的 transient 字段发布：

- draft 只累计 typed `text.delta`，并绑定 sessionId、runId 和 Provider requestId。
- turn 的 narrative 或 answer 成功提交时，draft 在同一 SessionActor 串行边界内清除。
- Provider 失败、run settled、取消或进程恢复时，draft 可以直接丢弃。
- 第一版不写入 durable `assistant.chunk`，不从 token stream 重建 journal，也不把
  draft 当作 committed message。
- CLI、TUI、GUI 都只消费共享投影中的 assistantDraft，不各自订阅 Provider 或维护
  另一份语义草稿。
- GUI 的 Markdown 增量渲染和缓冲打字机只延迟或平滑展示已收到的 draft 字符；它们是
  可丢弃的表现状态，不改变文本、顺序、终态或 projection 事实。assistant 输出区域不显示
  文本输入 caret；run 仍在进行且当前没有新增字符时，GUI 可以显示纯表现性的转圈状态。

### 7.5 回答反馈

复制是 Shell 私有操作，不写入 Session。赞、踩和清除反馈则通过共享
`message.feedback.set(messageId, feedback)` 命令提交；Session 只允许目标为已提交的
assistant message，并把结果持久化为 `message.feedback.updated`。反馈只保存在本地
active-v2 Session journal，恢复与命令回放使用同一 reducer；GUI、CLI、TUI 都只能消费
消息 projection 的 `feedback` 字段，不能各自保存第二份状态，也不能把反馈发送给
Provider。删除 Session 时，该反馈随完整 Session archive 一同删除。

## 8. Session journal、终态与 activity 投影

### 8.1 最小 canonical event vocabulary

v2 journal 允许以下事件：

    session.created
    input.accepted
    run.started
    run.profile.selected
    message.committed
    message.feedback.updated
    narrative.committed
    interaction.requested
    interaction.resolved
    plan.intent.requested
    plan.intent.resolved
    todo.updated
    tool.requested
    approval.requested
    approval.resolved
    tool.completed
    context.composed
    context.updated
    run.waiting
    run.settled

其中 approval.requested / approval.resolved 只服务于不属于 workspace mutation Plan
的明确 effect 边界；它们不能为 workspace write 提供 fallback。

第一版明确不新增：

    executor.started
    run.settling
    assistant.chunk

如果 tool.requested 尚无 tool.completed，projection 只能表述为 requested / pending，
不能声称 executor 已启动。第一版不投影 Kernel 临时 progress。

### 8.2 run.settled

run.settled 的 outcome 为闭合 union：

    completed
    failed
    cancelled
    indeterminate

规则：

- 每个 run 只能追加一次 run.settled。
- completed 必须引用同一原子提交中的最终 assistant message。
- 已经发生但无法确认结果的 effect 使用 indeterminate，不伪造 cancelled 或 failed。
- run settled 后，所有 pending Plan authority、interaction continuation 和 attempt
  continuation 都失效。
- Session 恢复时只依据 journal 与必要的 Kernel readRecord，不根据 UI 文案猜测。

CLI 对 failed 和 indeterminate 必须返回非零退出码；不得打印失败文本后仍以 0
退出。cancelled 的具体非零码由 CLI 实现确定，completed 才是正常成功退出。

### 8.3 SessionProjection

共享投影至少包含：

- sessionId、projection revision。
- Session display metadata 与 Project 归类，不含 canonicalRoot。
- immutable creation workspace binding display snapshot，不含绝对路径。
- 当前仍 attached 的 ordered Session directory indexes，以及两者组成的当前有效目录集合。
- 当前 run 在 `run.started` 固定的 workspace binding display snapshot；run 中途的
  attach / detach 不改该快照。
- ordered messages、narratives。
- 当前 run 的 transient assistantDraft；没有活动草稿时为 null。
- 当前 runId、profileId、run status、context usage。
- pending interaction、pending Plan、pending non-workspace approval。
- 当前 run 的结构化 todoList；新 run 开始时清空，run settled 后保留最后状态供复核。
- 最新一次 contextUsage，以及由 context.updated 确定性累加的 tokenUsage。
- activities。
- artifacts 与链接。
- 明确的 failed / cancelled / indeterminate error。

### 8.4 activities

activities 不是新的事实表。Session reducer 从以下既有事实确定性生成：

| 来源事实 | activity 可表达 |
| --- | --- |
| run.started 且无 run.settled | run active |
| tool.requested | tool requested / pending |
| approval.requested | waiting for approval |
| plan.intent.requested 且未 resolved | waiting for Plan decision |
| interaction.requested 且未 resolved | waiting for user input |
| tool.completed / Kernel record | completed、denied、failed、cancelled、indeterminate |
| run.settled | run terminal outcome |

`todo.updated` 不是 activity。它由 LLM 的保留 `todo.update` control call 产生，payload
为最多十二项的闭合列表：`todoId`、`label`、`pending | inProgress | completed`。同一个
Provider turn 最多一次；它可以与 Kernel 工具调用并存，但不能与阻塞的
`interaction.request` 或 `plan.intent` 并存。Session 不根据工具结果自动改变 Todo。
todoId 与 label 都在 Session control decoder 和 durable store 使用同一严格规则；label
首尾空白、控制字符或超过 240 个可显示字符时直接拒绝，不在任一边界自动 trim。

`tool.completed` 投影 activity 时必须保留 `tool.requested` 的原始 sequence，并从同一
Kernel ToolExecutionRecord 的 PreparedEffect 生成公开 activity detail：operation、
workspaceId 与 logicalTargets。绝对 resolved target 不进入 projection。GUI、TUI 和 CLI
可以把 `workspaceId + logicalPath` 渲染成可打开资源；显式打开时由 Host 私有
workspace map 解析，并在同一 Shell 中只读展示。未知插件工具最多展示其公开逻辑目标，
不能把任意原始参数当作可点击路径。

### 8.5 Provider 用量与缓存统计

Session 每次调用 Provider 前，必须先持久化 `context.composed` 请求回执。回执与实际
Provider request 使用同一个 `providerRequestId`，只记录本次请求实际采用的分类、条目
标识与显示标签，不复制完整 Prompt、消息正文、secret 或绝对路径。Provider 调用只有在
回执提交成功后才可开始；`context.updated` 必须引用一个同 run 中已有的
`providerRequestId`，否则 reducer 拒绝该用量事实。

`context.updated` 的 `inputTokens`、`outputTokens` 与 `contextWindowTokens` 表达该次
Provider turn 的上下文用量。Provider 明确报告缓存事实时，同一事件还必须同时包含
`cacheReadInputTokens` 与 `cacheMissInputTokens`；缺失任一字段均不是零值。

Session reducer 累加共享 `tokenUsage`：Provider 调用次数、输入/输出 token、缓存读取/
未命中 token，以及真实报告缓存字段的调用次数。缓存命中率只在缓存读取与未命中总量
大于零时计算；否则 Shell 显示未知，不允许本地散列、文本比较或模型名规则猜测命中率。
Session 同时按 run 累加 `tokenUsageHistory`。一轮用户消息可以触发多个 Provider turn，
该轮记录汇总这些调用并保存输入消息、run、起止时间与 settlement 身份。投影按 run
开始 sequence 从新到旧排列；GUI 设置页每页渲染 10 条，分页仅是 Shell 表现状态。
标题栏和 GUI 设置页消费同一投影，CLI/TUI 可以用各自粒度呈现，但不建立第二套统计。
尚未 settled 的历史轮次可以显示已知用量，但同时省略 `completedAt` 与 `outcome`；不得
把“仍未观测到终态”投影成 indeterminate 完成回执。只有 durable settlement 同时提供
终止时间与 outcome。

Shell 可以改变图标、折叠粒度和动画，但不能把 requested 改成 executing，也不能在
本地删除 failed / indeterminate。

recovery reducer 和 live reducer 必须是同一实现；任何 projection cache 都可删除并
从 journal 重建。

## 9. Project、workspace 与 Session binding

### 9.1 Host 私有 workspace catalog

Host 私有维护：

    workspaceId -> canonicalRoot

约束：

- canonicalRoot 在登记时解析为现存目录的 canonical filesystem path。
- workspaceId 创建后，其 canonicalRoot 不可变。
- Project、Session、Prompt 和普通 projection 只保存或传输 workspaceId。
- ordinary log 和 UI 不输出 canonicalRoot。
- 文件夹选择器和 workspace 管理弹窗可以通过专用 Catalog view 显示真实路径，因为
  该交互的目的就是让用户确认或管理路径。

canonicalRoot 不是模型可写字符串，也不能由 Session 从路径文本重建。

### 9.2 Project binding 是新 Session 模板

Project 保存一个有序 workspaceId 列表，作为后续新 Session 的 binding 模板：

- 在 Project 下创建新 Session 时，Session 复制当时的 workspaceId 列表。
- 该列表写入 session.created 的 creation snapshot，之后不可变。
- Project 后续附加、移除或排序 workspace 不影响已有 Session。
- Project 可以绑定多个工作目录，用于显式的上下文提示与工具寻址优先级。
- Project display name 和 workspace display name 可以进入普通 projection；
  canonicalRoot 不进入。

### 9.3 独立 Session

独立 Session：

- 可以没有任何 workspace binding。
- 可以在创建时显式绑定一个或多个 workspaceId。
- 没有 binding 仍可进行普通问答；workspace 工具调用必须明确失败为 unbound，
  不能使用进程 cwd 或最近 Project 的 root。

### 9.4 已有 Session 的对话目录索引

文件附件和文件夹目录索引是两种不同事实：

- 文件附件是 `message.submit` 中的消息级不可变内容快照；它不产生目录访问权。
- 对话中显式选择文件夹时，Host 将 canonicalRoot 私有登记为 workspaceId，Session
  必须在提交该消息并启动 run 前先持久化 `session.directory-index.attached`。
- 文件夹不复制内容。LLM 只得到 workspace display binding，并通过 `fs.list`、
  `fs.glob`、`code.grep` 与 `fs.read` 自主探索。
- 当前有效目录集合是 immutable creation snapshot 加当前仍处于 attached 状态的
  ordered Session directory indexes；workspaceId 去重且保持该顺序。
- 每个 run 把当时的有效目录集合写入 `run.started.workspaceBindings`。运行中的
  attach / detach 只影响下一 run，不改当前 run 的 Kernel authority。
- 用户可显式 detach 对话目录索引。detach 不删除历史消息、activity 或工具记录，
  只使后续 run 不再包含该目录。
- 对话目录索引不静默写回 Project 模板；“同时加入项目索引”是单独的显式用户动作。

删除 Session 与 detach 不同：显式删除会移除 Catalog 对话条目，并在同一归档删除
事务中移除该 Session 的 journal、command、creation binding、对话目录索引事实和
Kernel ToolRecord。保留中的 ToolRecord 不允许更新；删除只通过 Session 生命周期入口。

### 9.5 CLI / TUI

CLI、TUI 只有在用户显式传入 -C 或 --workspace 时才登记或选择 workspaceId，并把
它写入新 Session creation snapshot。已有 Session 通过显式 attach / detach command
管理对话目录索引，不从当前目录推断。

未提供参数时：

- 不使用当前目录作为隐式 binding。
- 不读取“第一个项目目录”。
- 不继承最近 GUI Project。
- 不创建 workspace grant。

### 9.6 Session 归类移动

把独立 Session 移入 Project，或把 Session 从一个 Project 移到另一个 Project：

- 只改变 Catalog 中的 projectId 归类。
- 不修改 Session creation snapshot。
- 不新增、删除或排序 workspace binding。
- 不产生 workspace authority。

改变 Project 归类本身不能改变可访问目录。用户需要显式使用 Session directory-index
attach / detach；该操作不改 creation snapshot，也不静默改 Project 模板。

### 9.7 路径可见性

普通 Session Prompt、Provider request、SessionProjection、CLI 普通输出和 GUI /
TUI 普通页面只使用：

    workspaceId
    workspace display name
    normalized relative path

绝对路径只允许出现在：

- 显式文件夹选择器。
- workspace 管理弹窗。
- Host / Kernel 私有诊断中，且不得作为普通模型上下文。

工具请求必须携带 workspaceId；即使 Session 只有一个 binding，也不得省略并回退到
first root。

## 10. Workspace read 与结构化 Plan authority

### 10.1 Workspace read

对当前 run 在 `run.started.workspaceBindings` 中冻结的 workspaceId：

- workspace read 默认允许。
- Kernel 仍必须先 canonicalize 调用并验证 normalized target 位于该 root 内。
- 未绑定 workspace、绝对路径、root 逃逸或未知 workspaceId 直接拒绝。

binding 只授权 read 的默认范围，不授权 mutation、network 或 external effect。

### 10.2 PlanIntent

Plan intent 由 LLM 调用保留的 `plan.intent` control 工具输出，Session 以该 callId
作为 planId，校验闭合参数后写入 journal：

    PlanIntent {
      planId
      prompt
      options: PlanOption[1..3]
    }

    PlanOption {
      optionId
      label
      description?
      operations: PlanOperation[]
    }

prompt、label 和 description 由 LLM 输出并用于用户理解，但不参与授权匹配。
每个 option 的 operations 是该选项自身的 coverage 事实；不同 option 之间不能合并
授权。自然语言消息、narrative、answer、interaction response 或 UI 文案都不能
替代 PlanOperation。

### 10.3 闭合 PlanOperation

第一版 PlanOperation 只允许当前内建 workspace mutation：

    fs.create
    fs.write
    fs.edit
    fs.delete
    fs.ensure_directory

每项 operation 必须包含：

    workspaceId
    operation
    exact normalized target
    delete 时额外包含 targetKind = file | directoryTree

target 使用 workspace-relative canonical logical path，并满足：

- 非空、非绝对路径。
- 规范化后不含 .、.. 或平台歧义分隔。
- 不含 glob、regex、父目录隐式覆盖或“工作区全部文件”。
- operation 和 target 的比较使用规范化后的精确值。
- fs.delete 的 directoryTree 只覆盖该精确 tree root 的删除语义，不转换成其他
  operation 的前缀授权。

新 workspace mutation 工具或插件若无法映射到上述闭合 union，第一版必须拒绝；
不得复用最接近的 operation。扩展 enum 属于后续 versioned contract 变更。

### 10.4 Plan 选项与 authority

Plan intent 不是授权。只有当前 pending Plan 收到
plan.respond(select, optionId)，Session 才从该 Plan 中已提交且被选中的 option
派生 PlanAuthority：

    PlanAuthority {
      authorityId
      planId
      sessionId
      runId
      workspaceId
      coveredOperations
    }

未选中的 option 不产生 authority。plan.respond(feedback) 与 plan.respond(ignore)
同样不产生 authority。

一个 Plan 涉及多个 workspaceId 时，Session 为每个 workspace 形成独立、不可混用的
authority scope。authority 通过可信 Session -> Kernel 请求传递，不能由 Provider
或 UI 自行构造。

### 10.5 生命周期与覆盖

PlanAuthority 仅在以下条件全部成立时有效：

- sessionId 完全相同。
- runId 完全相同。
- workspaceId 完全相同。
- Plan 的某个 option 已由 select 明确提交，且 run 尚未 settled。
- PreparedEffect.operation 与某一 covered operation 完全相同。
- PreparedEffect.targets 与该 operation 的 exact normalized targets 完全匹配。

同一 run 内，可以重复执行已经覆盖的同一 operation / targets；不要求每次重新确认。

以下情况都拒绝且不执行 effect：

- 没有 Plan。
- Plan 仍 pending。
- Plan 收到 feedback 或 ignore。
- run 已 settled。
- workspace、operation、target 或 targetKind 不匹配。
- 新调用尝试把相对目标扩展到父目录或其他 workspace。

拒绝时 Kernel 生成明确的 denied record 或合同错误。Session 可以把该事实交回同一
Loop，让 LLM 产生新 Plan 或 answer；不得自动发起逐调用 ask。

### 10.6 不采用的授权来源

workspace mutation 第一版明确不接受：

- agent.permissions.workspaceWrite = allow。
- agent.permissions.workspaceWrite = ask。
- approval.resolve 的逐调用 allow。
- Project binding 本身。
- workspace read binding。
- system prompt 或自然语言 Plan。
- UI 本地“已确认”状态。
- 最近一次 Plan、其他 run 的 Plan 或其他 Session 的 Plan。

本版不引入 intent digest。authority 的身份、scope 和 exact coverage 由 canonical
journal facts、可信端口参数与 Kernel 精确比较保证。

## 11. PreparedEffect：同一对象完成覆盖、执行与记录

Kernel 收到 tool.call 后，按固定顺序处理：

1. 从 Kernel catalog 找到 tool descriptor。
2. 将输入转换为 canonical invocation。
3. 解析 workspaceId 和 normalized relative targets。
4. 通过 WorkspaceResolverPort 得到私有 canonicalRoot。
5. 构造一次 immutable PreparedEffect。
6. 使用该 PreparedEffect 检查 workspace read 或 Plan coverage。
7. 若允许，executor 直接消费同一 PreparedEffect。
8. 执行结束后，从同一 PreparedEffect 写入 ToolExecutionRecord。

PreparedEffect 至少包含：

    callId
    attemptId
    sessionId
    runId
    toolName
    workspaceId
    operation / effect class
    normalized logical targets
    private resolved targets
    canonical invocation

coverage 后不得重新解析另一份路径或从原始模型参数重建执行目标。record 必须引用
同一 operation、logical targets、authorityId 和 outcome。

普通 projection 只消费 record 的逻辑字段与结果，不暴露 private resolved targets。

ToolExecutionRecord outcome 为：

    completed
    denied
    failed
    cancelled
    indeterminate

不确定副作用不能被 Session 或 UI 改写为“未执行”。KernelPort.readRecord(callId)
是跨恢复读取 exact fact 的唯一端口。

## 12. Plan 交互与 Shell 渲染合同

“Plan 卡”只指 GUI 对共享 SessionProjection.pendingPlan 的具体可视化渲染，不是
GUI 私有事实、GUI 私有状态机或第二套 Plan 协议。CLI、TUI、GUI 都消费同一个
pendingPlan，最终都只发送 ConversationPort 中的同一个 plan.respond 闭合 union；
各壳之间只允许存在渲染粒度、焦点操作和输入适配的差异。

### 12.1 共享语义，一个 composer

Plan 卡复用中间主输入框所在的 composer 边界：

- 不弹出独立 Plan modal。
- 不在右侧任务面板再创建一套 Plan controls。
- 不创建第二个 textarea。
- context usage、模型选择和发送 / 停止按钮仍属于同一 composer。
- Shell 只根据 SessionProjection.pendingPlan 切换 composer mode。

pendingPlan 投影提供：

    planId
    prompt
    options[] {
      optionId
      label
      description?
      operationsDisplay
    }
    responseMode = optionOrFreeform
    ignoreAllowed = true

options 及其文案来自 LLM 已提交的 Plan fact；operationsDisplay 由 Session 从每个
option 的结构化 operations 投影。任何 Shell 都不生成、合并或改写选项。

### 12.2 GUI 可见结构与共享提交语义

Plan 卡的可见结构为：

    Plan

    选项：
    ○ 1. <LLM option>
    ○ 2. <LLM option>
    ○ 3. <LLM option>

    [用户输入窗口........................] [忽略] [↵]

交互规则：

- option 以编号列表显示；第一版最多三个，全部来自同一个 plan.intent。
- 点击 option 只改变 composer 内尚未提交的选中态，不立即执行，也不产生 authority。
- 再次点击同一已选 option 等价于按 Enter：输入为空时提交该 option；存在输入时提交
  带 optionId 的 feedback。两种路径都复用同一提交函数，不创建额外“执行”按钮。
- 用户可以不选 option，直接在原输入窗口输入调整、补充或替代要求。
- 右侧回车按钮与键盘 Enter 使用同一提交语义；Shift+Enter 只在输入窗口换行。
- 已选择 option 且输入窗口为空时，提交 plan.respond(select, optionId)。
- 输入窗口非空时，提交 plan.respond(feedback, text, optionId?)；即使当前有选中
  option，该自由文本也表示需要模型重新处理，不授权旧 option。
- option 未选择且输入窗口为空时，回车按钮不可提交；Shell 不自动选择推荐项。
- 只有 Session 写入 plan.intent.resolved(select) 后，选中 option 才能产生
  PlanAuthority。
- feedback 作为用户消息进入同一 run，关闭旧 Plan 且不产生 authority；同一 Loop
  恢复后，LLM 可以输出新的 plan.intent 或 answer。

UI 中不存在“执行此计划”和“调整计划”两个固定动作按钮。选择具体 option 与自由
输入本身就是这两种语义。

### 12.3 忽略的共享语义

当 pendingPlan 有效时，GUI 可见的“忽略”按钮与 TUI 的 Esc 完全等价；CLI 的等价
输入适配见 12.5：

- 它发送有 commandId、sessionId、runId、planId 的
  plan.respond(ignore)。
- 它不是纯前端 hide，也不是只关闭卡片。
- 它终止当前 Plan 等待轮次，但不把整个 Session 当作已取消。
- 当前 Plan 关闭，所有 workspace mutation authority 保持不存在或立即失效。
- 未提交的 option 选中态和输入草稿不进入 journal。
- Session 把 ignore 事实交回同一 Loop，并要求下一次有效模型输出只能是 answer；
  不得再调用工具、提出 Plan 或发起 interaction。
- 有效 answer 必须由 LLM 生成；Session 不拼接答案，也不把已有 narrative 冒充终答。
- 若 Provider 违反 answer-only 合同，run 必须 failed；CLI 非零退出。
- 在服务确认命令前，Shell 不得本地删除 pending Plan；失败时保留卡片并显示命令
  错误，避免产生 ghost state。

run.cancel 是另一个明确动作，不能由 Plan 卡 Esc 隐式触发。

### 12.4 串行与幂等

Plan pending 时，composer 的普通提交被解释为当前 plan.respond(select 或
feedback)，而不是并发创建新 run。plan.intent.resolved 的 resolution 是
select | feedback | ignore。重复按键或网络重放依靠 commandId 幂等；同一
commandId 不同 resolution、optionId 或 text 是冲突。

### 12.5 CLI / TUI 等价输入适配

CLI 与 TUI 同样展示 pendingPlan.prompt 和按投影顺序排列的 options。它们可以不绘制
GUI 卡片，而采用终端编号列表和同一输入区：

    Plan

    选项：
    1. <LLM option>
    2. <LLM option>
    3. <LLM option>

    > [输入选项编号或调整文本]

终端适配遵循：

- 输入去除首尾空白后，若完整内容是当前有效范围内的单个十进制编号，例如 `1`，
  按 Enter 后，Shell 将它解析为当前 pendingPlan.options[0].optionId，并发送
  plan.respond(select, optionId)。
- 编号只是当前投影顺序的本地输入别名；journal、command 和 authority 中只记录
  planId 与 optionId，不记录“第 1 项”作为事实。
- 任何不是有效单编号的非空文本都按自由反馈处理，发送
  plan.respond(feedback, text)；例如 `1 但不要删除文件` 是调整文本，不是 option 选择。
- TUI 若同时提供可视化选中态和输入区，其提交规则与 GUI 相同：空输入提交选中的
  optionId，非空输入提交 feedback。
- TUI 的 Esc 和 CLI 中明确展示的忽略入口都映射为 plan.respond(ignore)；具体键位或
  命令字是 Shell 渲染配置，不得改变 ignore 的 canonical 语义。空行、EOF、Ctrl-C
  不得被静默解释为 ignore。
- 空输入且没有选中 option 时不发送命令。CLI / TUI 不自动采用第一个选项。
- Shell 必须基于命令携带的 planId 和当前投影解析编号；投影已经变化或 Plan 已关闭
  时，旧编号输入必须以 stale command 明确失败，不能落到新 Plan 的同序号选项。

因此，GUI 的 radio / 点击、TUI 的焦点选择、CLI 的 `1` + Enter 都只是同一
plan.respond(select, optionId) 的不同输入适配；它们不形成不同 Session 行为、不同
authority 或不同 projection reducer。

## 13. Shell、模型切换与设置边界

### 13.1 共享布局语义

GUI 的语义区域为：

- 左侧：Project、Project 下 Session、独立 Session 与管理入口。
- 中间：主对话、narrative / answer、interaction、同一 composer。
- 右侧：由 todoList 和 artifacts 投影形成的任务、产出面板。

CLI、TUI 可以采用不同渲染粒度，但消费相同字段。

空 Session 可以把 composer 放在中部；出现消息后可将 composer 固定到底部。这是
Shell 渲染状态，不改变 Session facts。

hover action、侧栏展开方式、Markdown 视觉样式、字号、密度和动画属于 GUI 私有
渲染配置。Markdown renderer 可以复用 DeepSeek Harness 的展示形式，但只能渲染
message / narrative 内容，不能解析 Markdown 来生成 Agent 状态。

### 13.2 模型选择

模型选择属于共享 Agent 能力：

- 新消息可携带 profileId。
- run.profile.select 改变同一 run 后续 Provider request 使用的 profile。
- 已经发出的 in-flight Provider request 不被中途篡改。
- Session journal 记录选择事实，所有 Shell 从 projection 显示当前 profile。
- GUI 不因 run 已开始而永久禁用模型选择。

### 13.3 设置

所有 Shell 共享的 Agent 设置包括：

- Provider / 模型 profile。
- Session 组装使用的系统提示词扩展。
- 非 workspace mutation 的现行 effect 设置。
- Plugin、Skill、MCP 的配置入口。

Shell 私有设置包括：

- 主题、密度、侧栏、面板尺寸。
- Markdown 渲染和代码块展示。
- 快捷键、动画和其他纯交互偏好。

设置页可以展示共享 projection 中的只读运行事实，包括累计 Provider 用量、缓存统计和
按 run 汇总的逐轮 Token 用量。它们不是用户设置，也不由 GUI 重新计算；上下文构成弹层
同样只消费 `context.composed` 回执，不显示未进入该次请求的候选内容。

workspaceId -> canonicalRoot 是 Host 私有 catalog 事实，不是普通“设置”。旧
workspaceWrite=allow|ask 不在 v2 设置面中提供，也不映射为 v2 authority。

## 14. 插件体系

Kernel、Session 和 Shell 都以稳定 port 由 composition root 装配，因此可以彼此视为
可替换服务插件，但不混淆事实 owner。

Session 每次 Provider turn 使用 immutable AgentDeps：

    AgentDeps {
      instructions
      contextContributions
      tools
      providerProfile
      memoryContributions
      skillContributions
      mcpContributions
    }

第一版插件原则：

- first-party builtin、Tool、Skill、MCP 共享来源、激活、调用谱系和生命周期准则。
- Tool descriptor 由 Kernel catalog 提供；Provider 只看到当前可调用目录。
- Skill 与 MCP 后续作为 contribution kind 接入，不建立平行 Agent Loop。
- Agent 可以生成插件草稿或激活提案，但 Provider 工具目录不暴露 PluginAdminPort。
- 写出文件不等于安装，登记不等于激活。
- 第一版不实现 HMR、generation、shadow activation 或复杂 manifest graph。
- 插件不能绕过 WorkspaceResolver、PreparedEffect、Plan coverage 或 Kernel record。

## 15. v2 Store Root 与历史数据 hard cut

### 15.1 新 root

v2 使用一个由 Host 选择、进程私有管理的全新 RuntimeStoreRootV2，包含三个独立
事实域：

1. **Catalog store**
   - workspaces：workspaceId、private canonicalRoot、createdAt。
   - projects：projectId、display metadata。
   - project_workspace_bindings：Project 的新 Session 模板。
   - session_catalog：只保存 active-v2 Session 的 Project 归类与执行入口元数据；旧历史由独立只读 adapter 提供，不写入此表。
2. **Session store**
   - sessions：sessionId 与 creation metadata。
   - session_events：连续 append-only journal。
   - session_commands：command idempotency。
3. **Tool-record store**
   - Kernel-owned ToolExecutionRecord；保留期间不可更新。
   - callId / attemptId 索引与 exact read。

三者可以由独立 SQLite 文件或等价 adapter 实现，但 owner 不合并：

- Catalog 不写 Session event。
- Session 不写 ToolExecutionRecord。
- Kernel 不改 Project 或 workspace binding。

SQLite 第一版继续使用 rollback journal mode 和 synchronous=FULL。schema 只表达
运行所需的表、约束和索引，不保留自哈希 manifest 或巨量测试向量。

`todo.updated` 加入后，active-v2 Session store 从 schema 2 单向升级到 schema 3；
directory-index events 与 run workspace snapshot 加入后再单向升级到 schema 4；
`message.feedback.updated` 与 `context.composed` 加入后单向升级到 schema 5。schema 3
既有 `run.started` 由 creation binding 确定性补齐 `workspaceBindings`，不读取其他 root，
不推断后续目录索引；schema 4→5 只扩展闭合事件词汇，不改写既有 payload。
ToolRecord store 从 schema 2 单向升级到 schema 3，仅移除阻止 Session aggregate purge 的
delete trigger；普通 Kernel API 仍没有任意删除入口。

Catalog store 从 schema 2 单向升级到 schema 3，重建 `session_catalog` 并把
`entry_kind` 收紧为唯一合法值 `activeV2`。迁移逐行复制现有记录；若旧表中混入
`historyOnly`，CHECK 会使整个事务失败并保留原库，不静默删除或把旧历史转成可执行
Session。只读旧历史继续由 Host history adapter 从旧 root 投影。

schema 4 既有 `context.updated` 没有当时尚不存在的 `providerRequestId`。schema 4→5
迁移不得伪造 `context.composed`、请求身份或上下文分类；recovery reducer 只把这类原样
保留的旧事件恢复为累计与逐轮 Token 历史，不投影 `contextUsage` 或上下文构成。schema 5
新追加的 `context.updated` 仍必须带同 run 已持久化回执的 `providerRequestId`，否则在
append/reducer 边界明确拒绝。

显式删除 active-v2 Session 时，Host 先拒绝活动 run，再使用 SQLite attached database
事务同时删除 Session store 与 ToolRecord store 中相同 sessionId 的归档事实；任一删除
失败则整个归档事务回滚。Catalog 条目先删除并可在归档事务失败时恢复。执行路径只读写
当前 schema，不双读、不双写、不保留 alias。这些都不会读取或迁移 hard cut 之前的旧
历史 root。

### 15.2 旧数据

旧 catalog、Session store、tool record 和配置：

- 原样保留，不原地改写。
- 只允许通过 history-only adapter 读取。
- 不进入 v2 ConversationPort、KernelPort 或 Provider context。
- 旧 Session 不能继续执行、批准 pending call 或恢复旧 run。
- 若 UI 展示旧会话，必须明确标记为只读历史，composer 不可提交。
- 创建可执行 v2 Session 必须走新的显式创建流程，不自动复制旧 authority。

### 15.3 显式失效

hard cut 后以下旧事实对 v2 一律无效：

- pending approval / authority。
- workspaceAuthorityId 旧绑定。
- agent.permissions.workspaceWrite = allow。
- agent.permissions.workspaceWrite = ask。
- 旧 Session 的 first workspace root。
- 旧 projection cache。
- 旧 Host / Bridge continuation。

v2 不：

- 双读旧新 store。
- 双写旧新 store。
- 通过 alias 接受 v1 字段。
- 在新字段缺失时读取旧字段。
- 在 workspaceId 缺失时选第一个 root。
- 把旧 setting 转换成 PlanAuthority。

旧历史 reader 与 v2 execution adapter 必须是两个显式入口；history reader 不实现
任何 mutation 或 continuation command。

## 16. 物理拓扑

第一版保留当前物理边界：

- Rust Daemon 是本地 composition / supervision 进程，并承载 Rust Kernel service。
- 一个 Daemon-owned、长生命周期的 Node Session service 承载串行 SessionActor。
- Session 通过 KernelPort 调用 Rust，通过 ProviderPort 调用配置的模型。
- Host 转发命令、投影和 readiness，但不理解模型 continuation kind。
- CLI、TUI、GUI 通过同一 ConversationPort / ProjectionPort 使用系统。

本 cut 不创建新的 standalone Kernel 进程，也不把 Kernel 合并进 Node。只有在唯一
Loop 落地后，才能基于真实测量比较 IPC 延迟、故障隔离和打包成本。

## 17. 从当前实现到 v2 的职责替换

| 当前区域 | v2 目标 |
| --- | --- |
| SessionKernelLoopV2 与 providerTurns.ts 的有效部分 | 一个小型 runAgentLoop + 一个串行 SessionActor |
| SessionKernelHostRunnerV2 | 薄的 open / submit / cancel / query facade，或删除 |
| SessionKernelProductionBridgeV2 | 通用 mailbox / IPC adapter |
| Rust drive_agent_kernel_until_boundary_v2 | transport、wake、cancel、supervision、cleanup；无业务 continuation switch |
| Review / Finalize / FinalAnswer | 删除终态 authority 和第二次 Provider answer pass |
| Host operation settlement | transport ack / error，不推进会话 |
| Session / Host timeline stores | 一个 Session journal + 可重建 reducer |
| 现有 Rust tool catalog / executor | 保留能力，置于 v2 KernelPort 与 PreparedEffect 后 |
| workspaceRoot / workspaceAuthorityId | Host private workspaceId mapping + Session snapshot |
| workspaceWrite allow / ask | 结构化 PlanAuthority |
| GUI / TUI / CLI 私有状态 | 共享 SessionProjection |

开发期间可以在测试中直接实例化 v2 组件，但产品运行入口在 cutover 前仍只使用旧
路径；切换时一次性改为 v2，并删除旧可达路径。不得以“过渡”为由发布双运行时。

## 18. 依赖顺序 P1–P8

以下阶段按已锁定合同开始。它们是同一 hard cut 的依赖顺序，不是八套可并存架构。

### P1 — v2 composition 与空 store root

- 建立 v2 composition root、稳定端口和全新 RuntimeStoreRootV2。
- 建立 Catalog / Session / ToolRecord 三个 owner 的空 schema。
- 不读取或写入 v1 root。

### P2 — Catalog、workspace identity 与 Session creation

- 实现 private workspaceId -> canonicalRoot。
- 实现 Project binding 模板、独立 Session 和 immutable creation snapshot。
- 实现 -C / --workspace 显式绑定；无参数不使用 cwd。
- 实现普通 view 隐藏路径、管理 view 显示路径。
- 实现 Project 的有序多目录模板；从文件夹创建项目时只登记第一个目录索引。

### P3 — journal、command 与共享 reducer

- 实现 append-only journal、command idempotency、recovery reducer。
- 实现 SessionProjection、activities 和当前 run 的 transient assistantDraft。
- 不加入 executor.started / run.settling。
- 实现 Session directory-index attach / detach 事件、当前有效目录投影与
  `run.started.workspaceBindings` 冻结快照。

### P4 — 唯一 Session Loop 与模型输出

- 实现 runAgentLoop、narrative、answer、interaction.request。
- 实现 plan.intent / plan.respond 的 canonical 生命周期。
- 实现共享 pendingPlan 响应语义，以及 GUI 卡片、TUI / CLI 编号或自由文本输入、
  ignore 和 answer-only continuation 的等价适配。
- 删除 Session 侧重复 continuation。

### P5 — Kernel PreparedEffect 与 Plan coverage

- 将内建 workspace mutation 映射到闭合 PlanOperation。
- 用同一 PreparedEffect 做 coverage、execution、record。
- 实现 workspace read 默认 allow、mutation 无 Plan 直接拒绝。
- 实现 callId + attemptId 和 readRecord。

### P6 — 插件 contributions

- 把 instructions、context、tools、Provider、Memory、Skill、MCP 组合为
  immutable AgentDeps。
- 不加入 HMR、generation 或 PluginAdminPort 的模型可调用入口。

### P7 — Shell 收敛与原子 cutover

- CLI 首先消费 v2 ConversationPort / SessionProjection。
- TUI、GUI 改为同一投影消费者。
- GUI 落实同一 composer 的 Plan 卡、模型切换和中间 narrative；TUI / CLI 对同一
  pendingPlan 落实编号选择、自由文本反馈和显式 ignore 输入。
- 产品入口一次性切到 v2；删除旧可达 authority、continuation、store fallback 和
  私有 reducer。
- GUI 文件夹选择、CLI / TUI attach / detach 都提交同一 ConversationPort command；
  普通页面不显示 canonicalRoot。

### P8 — 真实运行验收与打包

- 运行真实 CLI coding task，再验证 TUI / GUI 共享投影。
- 验证 Project / workspace / Plan / PreparedEffect / recovery / cancellation。
- 验证 failed / indeterminate CLI 非零退出。
- 验证 old history 只读且不能进入执行。
- 打包 CLI、TUI、GUI，并回收本次启动的进程、端口和临时资源。

## 19. 验证与验收矩阵

### 19.1 已完成的 R0 文本复核

R0 已完成以下合同检查：

- 检查本文内部无第二 Loop、第二 reducer 或第二 workspace mutation authority。
- 检查 D4–D7 的每项已确认语义均有唯一落点。
- 检查 Plan 选项、自由输入、忽略按钮、Esc 和 answer-only 分支无 ghost pending
  state。
- 检查 Project classification 与 Session binding snapshot 没有混用。
- 检查 v1 机器合同未被当作 v2 已实现事实。

原 v1 schema、store 和代码不作为本版通过证据。它们由 P1–P5 按 v2 合同原子替换，
不得形成一半 v1、一半 v2 的可执行合同。

### 19.2 实施后的合同验证

至少覆盖：

- 直接 answer 产生一个 assistant message 和一个 run.settled(completed)。
- narrative 只来自模型块；Session 不补写。
- interaction.request 的选项和自由输入可恢复同一 Loop。
- activities 只从 journal / record 派生，whole-tree 不存在 executor.started 与
  run.settling。
- CLI failed 与 indeterminate 非零退出。
- Project 多 workspace 新 Session 正确快照；Project 改动不影响旧 Session。
- 文件附件保持消息级内容快照且不产生目录访问权。
- 对话文件夹 attach 先写 journal 后启动 run；LLM 可通过 fs.list / fs.glob /
  code.grep / fs.read 探索该目录。
- run 中途 attach / detach 不改变当前 run snapshot，只影响下一 run。
- detach 保留历史消息、activity 与 ToolRecord；删除 Session 同时移除 Catalog、
  Session archive、私有目录索引事实和该 Session 的 ToolRecord，跨 store 失败时回滚。
- 独立 Session 无 binding 可问答但 workspace tool 明确失败。
- 无 -C / --workspace 时 CLI / TUI 不使用 cwd。
- 普通 projection / Prompt / UI 不含 absolute canonicalRoot。
- 显式 picker / management view 能显示并确认真实路径。
- Session 移入 Project 只改归类，不新增 grant。
- bound workspace read 可执行，root 外 read 被拒绝。
- 每个闭合 PlanOperation 的 option select、target mismatch、workspace mismatch、
  run mismatch 和 post-settlement 路径均被验证。
- 同 run 相同 operation / targets 可重复；新 run 不复用 authority。
- 无 Plan 时不产生逐调用 workspace write ask，也不执行 effect。
- option select 后，只有被选中 option 的 operations 可使 Kernel 使用同一
  PreparedEffect 覆盖、执行和记录。
- Plan feedback 使用原输入窗口，旧 Plan 不授予 authority。
- Plan ignore 按钮与 Esc 都阻止 mutation，并由 LLM 输出直接 answer。
- 同一 pendingPlan 在 CLI、TUI、GUI 中产生相同 plan.respond；终端单独输入有效编号
  选择对应 optionId，其他非空文本产生 feedback，显示编号不进入 journal。
- 旧 planId 下输入的编号不能被重新解释为新 Plan 的同序号 option。
- 恢复进程从 journal + readRecord 重建相同 projection，不重复 effect。
- v1 old pending / workspaceWrite setting / first-root fallback 全部不可达。
- CLI、TUI、GUI 消费同一 projection contract。
- Daemon / Host 不包含 Agent continuation switch。
- 所有验收资源在成功、失败、取消和超时后均由 owner 回收。

局部单测、schema 解析和 UI 截图只能证明对应局部路径，不替代 P8 真实运行验收。

## 20. R0 决策映射

| 决策 | 本合同中的落点 |
| --- | --- |
| R0-SCOPE-1 | Kernel PreparedEffect + 精确 authority coverage |
| R0-JOURNAL-1 | 单一连续 Session journal |
| R0-SQLITE-1 | v2 三 owner store、rollback journal、FULL synchronous |
| R0-COMMAND-1 | sessionId + commandId exact replay / conflict |
| R0-EPOCH-1A | callId + attemptId |
| R0-ABI-1A | v2 端口消息显式 schemaVersion |
| R0-FACTREAD-1A | KernelPort.readRecord(callId) |
| R0-ADD-D4 / A1-min | LLM-only 文本、fact-derived activities、无新增两事件、CLI 非零失败 |
| R0-ADD-D5 / B1 | Host 私有 workspace map、Project 模板、Session snapshot、隐藏路径 |
| R0-ADD-D6 / C1 | PlanOperation、exact targets、run-scoped authority、同一 PreparedEffect |
| R0-ADD-D7 / A1+B1+C1 | v2 新 root、旧历史只读、旧 authority 失效、无兼容路径 |
| R0-ADD-D8 / C1-PI | typed Provider turn 正文、结构化 blocking control、废止 JSONL 正文 |
| R0-ADD-D9 / A1-transient | Session 私有 draft、共享投影、GUI 可丢弃缓冲表现状态 |
| R0-ADD-D10 / K1-min | Provider cache usage、Session 累计 tokenUsage、未知不归零 |
| R0-ADD-D11 / T1-structured | LLM todo.update、todo.updated、右侧 Todo 投影 |
| R0-ADD-D12 / A1-canonical-activity-links | PreparedEffect 公开资源投影与同壳只读链接 |
| R0-ADD-D13 / S1-session-directory-index | 文件快照与目录索引分离、Session attach / detach、per-run 根目录冻结、完整归档删除 |
| R0-ADD-D14 / F1-local-durable | assistant message 本地持久反馈、共享命令与投影、随 Session archive 删除 |
| R0-ADD-D15 / C1-request-receipt | Provider 调用前持久请求构成回执、request identity 绑定用量与逐轮统计 |

R0-FRAME-1、R0-STREAM-1A 与 R0-MANIFEST-1 的现实需求由选定 IPC 库的正常 frame /
stream 生命周期、构建 manifest 和实现测试承担；它们不建立第二套运行时事实、自哈希
合同包或巨量审计材料。

## 21. 实施门禁

本合同已 LOCKED，由当前主 Agent 按 P1–P8 实施。LOCKED 只授权本合同范围内的本地
实现与验证，不自动授权 commit、push、PR、发布或破坏旧历史数据。

若实际代码暴露本文未裁决的公共 ABI、事实 owner、持久化、权限或验收取舍，则停在
可恢复边界并提交精确的新裁决点，不用兼容、fallback 或 UI 文案绕过。没有新取舍时，
不重复重开已锁定决定。
