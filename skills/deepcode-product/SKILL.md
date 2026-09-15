---
name: deepcode-product
description: Explain DeepCode tools, Plans, execution environments, settings and plugins; diagnose Windows shell, missing developer tools and product issues using the recorded facts.
---

Session owns the single Agent Loop, context, interactions, Plan/Todo and terminal state. Kernel owns tool registration, permissions, execution and tool records. GUI, CLI and TUI consume the same Session projection.

Use the actual tool names, arguments and availability in the current run catalog. Basic session queries can call `session.read` directly; reading this Skill is not a prerequisite. When guidance is useful, use `skill.read` to load only the relevant entry or reference. Skill text enters history as an ordinary tool result; reading it does not activate a plugin or rebuild the current catalog. For querying or continuing existing work, see `deepcode-session`.

A Plan describes intended changes, scope and validation. Once confirmed, command details and edit methods for the same targets may change without another confirmation. Expanding authorized targets or deletion scope requires a user decision. Read-only investigation does not require a Plan. Existing successful ToolRecords in the current run may support step progress even when produced before Plan confirmation. Progress is not permission to execute a tool.

For product behavior and configuration, use `doc.read` with `name="operations.md"` or `name="execution-environments.md"`. Product docs are English Markdown and are separate from this workflow Skill.

For UI display plugins and hot replacement, read `doc.read` with `name="ui-plugins.md"`. Write against the documented display slots and lifecycle; adding files does not activate a plugin. The user selects the plugin folder in Settings. Do not expose or replace the Agent Loop or underlying tools through a display plugin.

For Windows shell selection, missing developer tools and platform differences, read [references/windows-environment.md](references/windows-environment.md).
