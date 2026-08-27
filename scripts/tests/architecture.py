#!/usr/bin/env python3
"""DeepCode 本地 Agent v2 hard cut 的小型分层与合同资产检查。"""

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
    contract_root = ROOT / "contracts" / "agent-runtime-v2"
    files = sorted(
        path.relative_to(contract_root).as_posix()
        for path in contract_root.rglob("*")
        if path.is_file()
    )
    require(
        files == [
            "README.md",
            "catalog-v2-to-v3.sql",
            "catalog.sql",
            "schema.json",
            "session-v2-to-v3.sql",
            "session-v3-to-v4.sql",
            "session-v4-to-v5.sql",
            "session.sql",
            "tool-record-v2-to-v3.sql",
            "tool-record.sql",
        ],
        f"v2 合同目录不是精确十文件：{files}",
    )
    contract_readme = read("contracts/agent-runtime-v2/README.md")
    for boundary in (
        "Catalog:    2 -> catalog-v2-to-v3.sql -> 3",
        "Session:    2 -> session-v2-to-v3.sql -> 3",
        "3 -> session-v3-to-v4.sql -> 4",
        "4 -> session-v4-to-v5.sql -> 5",
        "ToolRecord: 2 -> tool-record-v2-to-v3.sql -> 3",
        "不是冗余建库脚本",
    ):
        require(boundary in contract_readme, f"v2 合同说明缺少版本链边界：{boundary}")
    require(
        not (ROOT / "contracts" / "agent-runtime-v1").exists(),
        "v1 执行合同目录仍然存在",
    )
    try:
        schema = json.loads(read("contracts/agent-runtime-v2/schema.json"))
        require(schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", "schema.json draft 不正确")
        require(schema.get("$id", "").endswith("/agent-runtime-v2/schema.json"), "schema.json id 不是 v2")
        require("$defs" in schema, "schema.json 缺少边界定义")
    except json.JSONDecodeError as error:
        ISSUES.append(f"schema.json 不是有效 JSON：{error}")

    sql_contracts = {
        "catalog.sql": (
            {"workspaces", "projects", "project_workspace_bindings", "session_catalog"},
            3,
        ),
        "session.sql": (
            {"sessions", "session_workspace_bindings", "session_events", "session_commands"},
            5,
        ),
        "tool-record.sql": ({"tool_records"}, 3),
    }
    for filename, (expected_tables, expected_version) in sql_contracts.items():
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(read(f"contracts/agent-runtime-v2/{filename}"))
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
                with connection:
                    try:
                        connection.execute(
                            "INSERT INTO session_catalog("
                            "session_id, title, entry_kind, workspace_bindings_json, created_at, updated_at"
                            ") VALUES (?, ?, ?, ?, ?, ?)",
                            ("session:history", "只读历史", "historyOnly", "[]", "now", "now"),
                        )
                    except sqlite3.IntegrityError:
                        pass
                    else:
                        ISSUES.append("活跃 Catalog 仍允许持久化 historyOnly")
        except sqlite3.Error as error:
            ISSUES.append(f"{filename} 无法创建新数据库：{error}")
        finally:
            connection.close()

    connection = sqlite3.connect(":memory:")
    try:
        current_schema = read("contracts/agent-runtime-v2/catalog.sql")
        v2_schema = current_schema.replace("PRAGMA user_version = 3;", "PRAGMA user_version = 2;")
        v2_schema = v2_schema.replace(
            "CHECK(entry_kind = 'activeV2')",
            "CHECK(entry_kind IN ('activeV2', 'historyOnly'))",
        )
        connection.executescript(v2_schema)
        connection.execute(
            "INSERT INTO session_catalog("
            "session_id, title, entry_kind, workspace_bindings_json, created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?)",
            ("session:active", "Active", "activeV2", "[]", "now", "now"),
        )
        connection.commit()
        connection.executescript(read("contracts/agent-runtime-v2/catalog-v2-to-v3.sql"))
        require(connection.execute("PRAGMA user_version").fetchone()[0] == 3, "Catalog schema 2 未迁移到 3")
        require(
            connection.execute("SELECT COUNT(*) FROM session_catalog").fetchone()[0] == 1,
            "Catalog schema 2→3 没有保留 active-v2 Session",
        )
        try:
            connection.execute(
                "INSERT INTO session_catalog("
                "session_id, title, entry_kind, workspace_bindings_json, created_at, updated_at"
                ") VALUES (?, ?, ?, ?, ?, ?)",
                ("session:history", "History", "historyOnly", "[]", "now", "now"),
            )
        except sqlite3.IntegrityError:
            pass
        else:
            ISSUES.append("Catalog schema 2→3 后仍允许写入 historyOnly")
    except sqlite3.Error as error:
        ISSUES.append(f"Catalog schema 2→3 迁移失败：{error}")
    finally:
        connection.close()

    connection = sqlite3.connect(":memory:")
    try:
        current_schema = read("contracts/agent-runtime-v2/session.sql")
        v2_schema = current_schema.replace("PRAGMA user_version = 5;", "PRAGMA user_version = 2;")
        v2_schema = v2_schema.replace("        'session.directory-index.attached',\n", "")
        v2_schema = v2_schema.replace("        'session.directory-index.detached',\n", "")
        v2_schema = v2_schema.replace("        'todo.updated',\n", "")
        v2_schema = v2_schema.replace("        'message.feedback.updated',\n", "")
        v2_schema = v2_schema.replace("        'context.composed',\n", "")
        connection.executescript(v2_schema)
        connection.execute(
            "INSERT INTO sessions(session_id, display_title, created_at) VALUES (?, ?, ?)",
            ("session:migrate", "迁移", "2026-08-25T00:00:00Z"),
        )
        connection.execute(
            "INSERT INTO session_events("
            "session_id, sequence, event_id, event_type, payload_json, occurred_at"
            ") VALUES (?, 1, ?, 'session.created', ?, ?)",
            (
                "session:migrate",
                "event:migrate",
                '{"displayTitle":"迁移","workspaceBindings":[]}',
                "2026-08-25T00:00:00Z",
            ),
        )
        connection.commit()
        connection.executescript(read("contracts/agent-runtime-v2/session-v2-to-v3.sql"))
        require(connection.execute("PRAGMA user_version").fetchone()[0] == 3, "Session schema 2 未迁移到 3")
        require(
            connection.execute("SELECT COUNT(*) FROM session_events").fetchone()[0] == 1,
            "Session schema 迁移没有保留既有事件",
        )
        connection.execute(
            "INSERT INTO session_events("
            "session_id, sequence, event_id, event_type, run_id, call_id, payload_json, occurred_at"
            ") VALUES (?, 2, ?, 'todo.updated', ?, ?, ?, ?)",
            (
                "session:migrate",
                "event:todo",
                "run:migrate",
                "call:todo",
                '{"items":[]}',
                "2026-08-25T00:00:01Z",
            ),
        )
        connection.executescript(read("contracts/agent-runtime-v2/session-v3-to-v4.sql"))
        require(connection.execute("PRAGMA user_version").fetchone()[0] == 4, "Session schema 3 未迁移到 4")
        connection.executescript(read("contracts/agent-runtime-v2/session-v4-to-v5.sql"))
        require(connection.execute("PRAGMA user_version").fetchone()[0] == 5, "Session schema 4 未迁移到 5")
        connection.execute(
            "INSERT INTO session_events("
            "session_id, sequence, event_id, event_type, payload_json, occurred_at"
            ") VALUES (?, 3, ?, 'message.feedback.updated', ?, ?)",
            (
                "session:migrate",
                "event:feedback",
                '{"commandId":"command:feedback","messageId":"message:answer","feedback":"up"}',
                "2026-08-25T00:00:02Z",
            ),
        )
    except sqlite3.Error as error:
        ISSUES.append(f"Session schema 2 -> 3 -> 4 -> 5 迁移失败：{error}")
    finally:
        connection.close()

    connection = sqlite3.connect(":memory:")
    try:
        current_schema = read("contracts/agent-runtime-v2/tool-record.sql")
        v2_schema = current_schema.replace("PRAGMA user_version = 3;", "PRAGMA user_version = 2;")
        v2_schema += """
CREATE TRIGGER tool_records_are_not_deleted
BEFORE DELETE ON tool_records BEGIN
    SELECT RAISE(ABORT, 'tool records are immutable');
END;
"""
        connection.executescript(v2_schema)
        connection.executescript(read("contracts/agent-runtime-v2/tool-record-v2-to-v3.sql"))
        require(connection.execute("PRAGMA user_version").fetchone()[0] == 3, "ToolRecord schema 2 未迁移到 3")
        trigger_count = connection.execute(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type='trigger' AND name='tool_records_are_not_deleted'"
        ).fetchone()[0]
        require(trigger_count == 0, "ToolRecord schema 3 仍阻止显式 Session aggregate purge")
    except sqlite3.Error as error:
        ISSUES.append(f"ToolRecord schema 2 -> 3 迁移失败：{error}")
    finally:
        connection.close()


def check_current_path() -> None:
    required = [
        "docs/architecture/agent-architecture-hard-cut.md",
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

    daemon_sources = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (ROOT / "crates/deepcode-kernel-daemon/src").glob("*.rs")
    )
    for retired in (
        "drive_agent_kernel_until_boundary_v2",
        "SessionKernelLoopV2",
        "FinalAnswer",
        "HostRunBrokerV2",
    ):
        require(retired not in daemon_sources and retired not in loop, f"仍可达旧语义路径：{retired}")

    for retired_path in (
        "crates/deepcode-kernel-ledger",
        "crates/deepcode-kernel-policy",
        "crates/deepcode-kernel-skills",
        "userspace/session-core/src/kernel-v2",
        "fixtures/kernel-session-v2",
    ):
        require(not (ROOT / retired_path).exists(), f"仍保留旧实现目录：{retired_path}")

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
        (model_selector, "contextReceipt.categories.map", "上下文球没有消费请求回执分类"),
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
    print("[PASS] 本地 Agent v2 分层与合同资产")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
