#!/usr/bin/env python3
"""DeepCode 当前 Agent Runtime 的小型分层与合同资产检查。"""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import sys


ROOT = Path(__file__).resolve().parents[2]
ISSUES: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        ISSUES.append(message)


def read(relative: str) -> str:
    path = ROOT / relative
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        ISSUES.append(f"无法读取 {relative}: {error}")
        return ""


def check_runtime_contracts() -> None:
    contract_root = ROOT / "contracts" / "agent-runtime"
    files = sorted(
        path.relative_to(contract_root).as_posix()
        for path in contract_root.rglob("*")
        if path.is_file()
    )
    require(
        files == [
            "README.md",
            "catalog.sql",
            "schema.json",
            "session.sql",
            "tool-record.sql",
        ],
        f"当前合同目录不是精确五文件：{files}",
    )
    contract_readme = read("contracts/agent-runtime/README.md")
    for boundary in (
        "`user_version` 精确等于当前版本时",
        "其他版本一律拒绝",
        "不存在只读历史入口",
    ):
        require(boundary in contract_readme, f"当前合同说明缺少 hard-cut 边界：{boundary}")
    require(
        not list(contract_root.glob("*-to-*.sql")),
        "当前合同目录仍包含迁移 SQL",
    )
    contract_directories = sorted(
        path.name
        for path in (ROOT / "contracts").iterdir()
        if path.is_dir() and path.name.startswith("agent-runtime")
    )
    require(
        contract_directories == ["agent-runtime"],
        f"Agent Runtime 合同目录不唯一：{contract_directories}",
    )
    try:
        schema = json.loads(read("contracts/agent-runtime/schema.json"))
        require(schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "schema.json draft 不正确")
        require(schema.get("$id", "").endswith("/agent-runtime/schema.json"), "schema.json id 不是当前路径")
        require("$defs" in schema, "schema.json 缺少边界定义")
    except json.JSONDecodeError as error:
        ISSUES.append(f"schema.json 不是有效 JSON：{error}")

    sql_contracts = {
        "catalog.sql": (
            {"workspaces", "projects", "project_workspace_bindings", "session_catalog"},
            1,
        ),
        "session.sql": (
            {"sessions", "session_workspace_bindings", "session_events", "session_commands"},
            1,
        ),
        "tool-record.sql": ({"tool_records"}, 1),
    }
    for filename, (expected_tables, expected_version) in sql_contracts.items():
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(read(f"contracts/agent-runtime/{filename}"))
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            require(version == expected_version, f"{filename} user_version 不是 {expected_version}")
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            require(expected_tables <= tables, f"{filename} 缺少表：{sorted(expected_tables - tables)}")
            if filename == "catalog.sql":
                columns = {
                    row[1] for row in connection.execute("PRAGMA table_info(session_catalog)")
                }
                require(
                    columns == {
                        "session_id",
                        "title",
                        "project_id",
                        "workspace_bindings_json",
                        "profile_id",
                        "created_at",
                        "updated_at",
                    },
                    f"Catalog Session 列不符合当前合同：{sorted(columns)}",
                )
                connection.execute(
                    "INSERT INTO session_catalog("
                    "session_id, title, workspace_bindings_json, created_at, updated_at"
                    ") VALUES (?, ?, ?, ?, ?)",
                    ("session:current", "当前会话", "[]", "now", "now"),
                )
        except sqlite3.Error as error:
            ISSUES.append(f"{filename} 无法创建新数据库：{error}")
        finally:
            connection.close()


def check_current_path() -> None:
    required = [
        "userspace/protocol/src/localAgent.ts",
        "userspace/session-core/src/local-agent/loop.ts",
        "userspace/session-core/src/local-agent/actor.ts",
        "crates/deepcode-kernel-daemon/src/local_agent_kernel.rs",
        "crates/deepcode-kernel-daemon/src/local_agent_store.rs",
        "crates/deepcode-kernel-client/src/conversation.rs",
    ]
    for relative in required:
        require((ROOT / relative).is_file(), f"缺少当前实现：{relative}")

    loop = read("userspace/session-core/src/local-agent/loop.ts")
    require(loop.count("export async function runAgentLoop(") == 1, "Session 必须只有一个 runAgentLoop 定义")
    require("run.settled" in loop, "唯一 Loop 缺少终态提交")

    session_bridge = read("userspace/session-core/src/sessionServiceBridge.ts")
    for command_type in (
        "session.directory-index.attach",
        "session.directory-index.detach",
        "message.submit",
        "message.feedback.set",
        "run.profile.select",
        "run.cancel",
        "interaction.respond",
        "approval.respond",
        "plan.respond",
    ):
        require(
            f"case '{command_type}'" in session_bridge,
            f"Session bridge 闭合命令解码器缺少：{command_type}",
        )

    gui_panel = read("userspace/gui/src/components/local-agent/LocalAgentPanel.tsx")
    gui_styles = read("userspace/gui/src/components/local-agent/localAgentPanel.css")
    model_selector = read("userspace/gui/src/deepcode-gui/panel/SessionModelSelector.tsx")
    shell_styles = read("userspace/gui/src/deepcode-gui/styles/deepcodeShell.css")
    gui_settings = read("userspace/gui/src/components/settings-center/GuiAppearanceSettings.tsx")
    for source, marker, message in (
        (gui_panel, "selectOrConfirmPlanOption", "GUI Plan 缺少二次点击确认路径"),
        (gui_panel, "event.key === 'Enter'", "GUI composer 缺少 Enter 确认路径"),
        (gui_panel, "local-agent__jump-latest", "GUI 缺少前往最新消息入口"),
        (gui_panel, "local-agent__run-spinner", "GUI 运行中缺少转圈状态"),
        (gui_panel, 'name="copy"', "GUI Assistant 回答缺少复制操作"),
        (gui_panel, 'name="thumbUp"', "GUI Assistant 回答缺少赞操作"),
        (gui_panel, 'name="thumbDown"', "GUI Assistant 回答缺少踩操作"),
        (gui_panel, "作为本条消息的内容快照", "GUI 加号菜单缺少文件快照入口"),
        (gui_panel, "作为此对话的目录索引", "GUI 加号菜单缺少目录索引入口"),
        (model_selector, "receipt.partitions.map", "上下文球没有消费 Session 分区投影"),
        (gui_settings, "tokenUsageHistory.slice", "设置页没有分页消费逐轮用量"),
        (gui_settings, "Newest first, 10 per page", "设置页缺少新到旧每页十条语义"),
        (gui_styles, "margin: 10px auto 0", "前往最新消息按钮没有居中"),
        (gui_styles, "caret-color: transparent", "Assistant draft 没有隐藏文本 caret"),
        (shell_styles, "border-radius: 50%", "上下文用量入口不再是圆形"),
        (shell_styles, "conic-gradient", "上下文用量入口缺少环形进度"),
    ):
        require(marker in source, message)


def main() -> int:
    check_runtime_contracts()
    check_current_path()
    if ISSUES:
        for issue in ISSUES:
            print(f"[FAIL] {issue}", file=sys.stderr)
        return 1
    print("[PASS] 本地 Agent 分层与当前合同资产")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
