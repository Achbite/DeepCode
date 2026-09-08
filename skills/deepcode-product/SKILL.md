---
name: deepcode-product
description: 了解 DeepCode 的工具、Plan、运行环境、模型设置和缓存显示；处理 DeepCode 自身操作疑问时使用。
---

DeepCode 的 Session 负责唯一 Agent Loop、上下文、交互、Plan/Todo 和终态；Kernel 负责统一工具注册、权限、执行与工具记录；GUI、CLI、TUI 消费同一会话投影。

工具以本轮目录中的实际名称、参数和可用状态为准。`session.read` 可直接读取已有对话事实，基础查询无需先读 Skill，也不恢复目标任务。需要产品说明时，使用 `skill.read` 仅读取与当前问题相关的正文或引用，无需预先读完所有文档。正文作为普通工具结果进入对话，不激活插件、不重建本轮目录。需要接续历史工作的查询指引时可读取 `deepcode-session`。

Plan 用来向用户说明将做的修改、影响范围和验证方式。用户确认后，范围内的具体命令和同目标编辑方式可随实际情况调整；超出授权目标或删除范围才需要修订。只读调查不要求先建 Plan。当前 run 内已有的有效工具结果可以作为步骤进度证据，即使结果产生在确认 Plan 之前；完成步骤仍需要成功记录，工具调用必须通过真实权限检查。

需要 Shell 环境、验证、推理强度或缓存说明时，读取 [references/operations.md](references/operations.md)。
