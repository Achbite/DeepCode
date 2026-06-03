# WorkflowDescriptor V1

`WorkflowDescriptor` 是阶段 14 Kernel DSL / workflow contract 的结构化描述。它只描述 Kernel 能解释的状态、proposal、predicate 和 capability 上限，不承载 Session 编排、自然语言计划解析、上下文缓存或并行调度。

## 顶层字段

- `schema_version`: schema 版本，V1 接受 `1`、`1.0`、`1.0.0`。
- `id`: workflow 模板 ID，例如 `plan-check-complete-review`。
- `title`: 用户可读标题。
- `description`: 可选说明。
- `initial_state`: 初始 state ID。
- `states`: 状态描述列表。
- `transitions`: 状态转移描述列表。
- `terminal_states`: 终态 ID 列表。
- `max_iterations`: 可选最大迭代次数。

## State Contract

每个 state 必须声明：

- `id`: state ID。
- `kind`: `llm`、`kernel`、`llm_tool`、`kernel_review` 或 `terminal`。
- `allowed_capabilities`: 当前 state 的 capability 上限，不等于实际授权。
- `allowed_proposals`: 当前 state 可解释的 typed proposal。
- `entry_hooks`: symbolic hook ID；禁止 shell、script、eval 或任意函数。
- `exit_predicates`: `predicate id + args`，只引用 registry 中的安全 predicate。
- `invalid_proposal_policy`: invalid proposal 的处理策略。

实际授权仍由 PolicyProfile、RuntimeGrant、PermissionGate、HardFloor 和 resource scope 裁决。

## Proposal Boundary

阶段 14 V1 的默认模板允许：

- `plan`: `RequirementChecklist`、`ResourceRequest`、`PlanDraft`、`AgentPlanDraft`、`ActionBundleDraft`。
- `check`: `PlanReviewReport`、`PermissionPreflightResult`。
- `complete`: `ToolActionDraft`、`PatchDraft`、`ValidationProposal`、`RepairProposal`。
- `review`: `ReviewPacket`、`ReplanRequest`、`FinalAnswerDraft`。

`ActionBundleDraft` 只表达阶段 19 Session 编译后的结构化执行清单草案，不执行工具。

## Predicate Boundary

V1 只使用 `predicate id + args`，不支持 CEL、OPA、JavaScript、Python、shell 或 eval。以下 predicate 永远非法：

- `llm_says_done`
- `model_claims_test_passed`
- `assistant_final_answer_exists`
- `natural_language_contains_done`
