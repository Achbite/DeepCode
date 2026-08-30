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
        definitions = schema.get("$defs", {})
        display = definitions.get("SessionDisplayProjection", {})
        require(
            display.get("required") == ["creationTitle"]
            and display.get("additionalProperties") is False,
            "Session display 必须只承载不可变 creationTitle",
        )
        require(
            definitions.get("SessionProjection", {})
            .get("properties", {})
            .get("display", {})
            .get("$ref") == "#/$defs/SessionDisplayProjection",
            "SessionProjection.display 没有绑定精确 schema",
        )
        session_event_rules = json.dumps(
            definitions.get("SessionEvent", {}).get("allOf", []),
            ensure_ascii=False,
            sort_keys=True,
        )
        require(
            "providerCallId" in session_event_rules
            and "interactionId" in session_event_rules
            and "planId" in session_event_rules,
            "SessionEvent schema 没有要求 Provider 与 Logical call identity 分离承载",
        )
        model_assistant = next(
            (
                candidate
                for candidate in definitions.get("ModelMessage", {}).get("oneOf", [])
                if candidate.get("properties", {}).get("role", {}).get("const") == "assistant"
            ),
            {},
        )
        require(
            model_assistant.get("properties", {}).get("reasoningContent", {}).get("minLength") == 1
            and {"required": ["reasoningContent"]} in model_assistant.get("anyOf", []),
            "ModelMessage assistant 没有闭合 reasoning-only 合同",
        )
        provider_assistant = next(
            (
                candidate
                for candidate in definitions.get("ProviderEvent", {}).get("oneOf", [])
                if candidate.get("properties", {}).get("type", {}).get("const")
                == "assistant.message"
            ),
            {},
        ).get("properties", {}).get("data", {})
        require(
            provider_assistant.get("properties", {}).get("content") == {"type": "string"}
            and provider_assistant.get("properties", {})
            .get("reasoningContent", {})
            .get("minLength") == 1,
            "Provider assistant.message 与 reasoning-only producer 不一致",
        )
    except json.JSONDecodeError as error:
        ISSUES.append(f"schema.json 不是有效 JSON：{error}")

    sql_contracts = {
        "catalog.sql": (
            {"workspaces", "projects", "project_workspace_bindings", "session_catalog"},
            1,
        ),
        "session.sql": (
            {"sessions", "session_workspace_bindings", "session_events", "session_commands"},
            3,
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
    require("deps.nextId('call')" in loop, "Session 没有生成 LogicalCallId")
    require("providerCallId" in loop, "Session 没有保留 Provider call identity")

    protocol = read("userspace/protocol/src/localAgent.ts")
    session_service = read("userspace/session-core/src/local-agent/service.ts")
    session_actor = read("userspace/session-core/src/local-agent/actor.ts")
    daemon_routes = read("crates/deepcode-kernel-daemon/src/routes.rs")
    host_proxy = read("crates/deepcode-host-web/src/main.rs")
    for source, marker in (
        (protocol, "PROJECTION_UPDATE_VERSION"),
        (protocol, "subscribe(sessionId"),
        (session_service, "AsyncUpdateQueue"),
        (session_actor, "onUpdate"),
        (daemon_routes, "projection/stream"),
        (host_proxy, 'ends_with("/stream")'),
    ):
        require(marker not in source, f"snapshot pull 合同仍残留推送路径：{marker}")

    config_root_lease = read("crates/deepcode-kernel-daemon/src/config_root_lease.rs")
    daemon_state = read("crates/deepcode-kernel-daemon/src/state.rs")
    require("BEGIN EXCLUSIVE" in config_root_lease, "配置根租约没有持有独占生命周期 owner")
    require("config_root_already_owned" in config_root_lease, "配置根冲突没有显式错误")
    require("read_optional_json_file" in daemon_state, "权威配置仍未区分缺失与损坏")
    require("read_json_file(&paths" not in daemon_state, "权威配置仍在吞掉读取或解析失败")

    abi_connection = read("crates/deepcode-kernel-abi/src/connection.rs")
    kernel_bootstrap = read("crates/deepcode-kernel-client/src/bootstrap.rs")
    gui_host = read("shells/deepcode-gui/src-tauri/src/main.rs")
    tui_host = read("shells/tauri/src-tauri/src/main.rs")
    require(
        "HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS" in abi_connection
        and all(
            "HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS" in source
            for source in (kernel_bootstrap, gui_host, tui_host)
        ),
        "Host 关闭回执预算没有统一由 ABI 拥有",
    )

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
    plan_card = read("userspace/gui/src/components/local-agent/PlanCard.tsx")
    composer_keyboard = read("userspace/gui/src/components/local-agent/composerKeyboard.ts")
    gui_store = read("userspace/gui/src/state/localAgentStore.ts")
    gui_styles = read("userspace/gui/src/components/local-agent/localAgentPanel.css")
    model_selector = read("userspace/gui/src/deepcode-gui/panel/SessionModelSelector.tsx")
    shell_styles = read("userspace/gui/src/deepcode-gui/styles/deepcodeShell.css")
    gui_settings = read("userspace/gui/src/components/settings-center/GuiAppearanceSettings.tsx")
    require("projection?.display.title" not in gui_panel, "GUI 仍把 Session 创建标题当作当前标题")
    require("activeSummary?.title.trim()" in gui_panel, "GUI 当前标题没有消费 Catalog authority")
    for source, marker, message in (
        (gui_panel, "<PlanCard", "GUI timeline 没有渲染 Plan 卡片"),
        (gui_panel, "{ kind: 'confirm' }", "GUI composer 缺少 Plan 确认动作"),
        (plan_card, "plan.status === 'confirmed'", "GUI Plan 卡确认后没有自动折叠"),
        (gui_panel, "local-agent__interaction-panel", "GUI 没有复用底部交互面板"),
        (composer_keyboard, "event.key === 'Enter'", "GUI composer 缺少 Enter 确认路径"),
        (gui_panel, "local-agent__jump-latest", "GUI 缺少前往最新消息入口"),
        (gui_panel, "local-agent__run-spinner", "GUI 运行中缺少转圈状态"),
        (gui_panel, 'name="copy"', "GUI Assistant 回答缺少复制操作"),
        (gui_panel, 'name="thumbUp"', "GUI Assistant 回答缺少赞操作"),
        (gui_panel, 'name="thumbDown"', "GUI Assistant 回答缺少踩操作"),
        (gui_panel, 'name="plus"', "GUI 附件入口没有使用一级加号入口"),
        (gui_panel, 'name="paperclip"', "GUI 二级附件能力没有使用文件和文件夹符号"),
        (gui_panel, "agent.attachment.filesAndFolders", "GUI 二级菜单缺少统一文件和文件夹能力"),
        (gui_panel, 'selectionMode="messageAttachment"', "GUI 文件和文件夹能力没有进入统一选择器"),
        (model_selector, "receipt.partitions.map", "上下文球没有消费 Session 分区投影"),
        (gui_settings, "tokenUsageHistory.slice", "设置页没有分页消费逐轮用量"),
        (gui_settings, "settings.gui.usage.historyDescription", "设置页缺少新到旧每页十条语义"),
        (gui_styles, "margin: 10px auto 0", "前往最新消息按钮没有居中"),
        (gui_styles, "caret-color: transparent", "Assistant draft 没有隐藏文本 caret"),
        (shell_styles, "border-radius: 50%", "上下文用量入口不再是圆形"),
        (shell_styles, "conic-gradient", "上下文用量入口缺少环形进度"),
    ):
        require(marker in source, message)
    require(
        "shouldSubmitComposerKey" in gui_panel
        and "compositionCommitPendingRef" in gui_panel
        and "event.isComposing" in composer_keyboard
        and "event.keyCode !== 229" in composer_keyboard,
        "GUI composer 的 Enter 路径没有保护输入法组合态",
    )
    require(
        "避免使用表情符号" in session_bridge,
        "Session 最小系统指令缺少减少表情符号的表达约束",
    )
    require("<textarea" not in plan_card, "GUI Plan 卡不应创建第二个输入框")
    require(
        "respondPlan({ kind: 'requestRevision'" not in gui_panel,
        "GUI Plan 修改意见没有复用主 composer 发送路径",
    )
    require(
        "return await get().respondPlan({ kind: 'requestRevision', text: trimmed })" in gui_store,
        "GUI 主 composer 没有把待确认 Plan 文本路由为 revision response",
    )


def check_development_tooling() -> None:
    makefile = read("Makefile")
    dockerfile = read("Dockerfile.dev")
    rust_toolchain = read("rust-toolchain.toml")
    build = read("build.sh")
    source_identity = read("scripts/source-identity.sh")
    package = read("scripts/package-macos.sh")
    service = read("scripts/macos-package-service.sh")
    test_entry = read("test.sh")

    for marker, message in (
        ("CONTAINER_NAME ?= deepcode-dev", "开发链没有唯一容器名"),
        ("DEEPCODE_PROJECT_ROOT := $(realpath $(CURDIR))", "开发链没有绑定当前项目根"),
        ("mounted_root", "容器复用没有核对源码挂载"),
        ("container_image", "容器复用没有核对当前镜像"),
        ("docker build --provenance=false", "Docker 缓存构建没有稳定镜像身份"),
        ("docker rm -f $(CONTAINER_NAME)", "失效容器没有精确重建路径"),
        ("DEEPCODE_MACOS_PACKAGE_MODE=require bash ./build.sh", "完整构建没有要求 macOS 请求闭合"),
    ):
        require(marker in makefile, message)
    require("DEEPCODE_WORKTREE_ID" not in makefile, "开发链仍保留多 worktree 容器分叉")
    require(
        "ARG DEEPCODE_RUST_VERSION=1.88" in dockerfile
        and "DEEPCODE_RUST_TOOLCHAIN ?=" in makefile
        and "rust-toolchain.toml" in makefile
        and 'channel = "1.88.0"' in rust_toolchain,
        "Docker 与宿主没有统一到满足当前锁文件的 Rust 工具链",
    )
    require(
        "SCCACHE_CONFIGURED=0" in build and "SCCACHE_CONFIGURED=1" in build,
        "单次构建仍会重复启动或探测 sccache server",
    )

    require(
        "source \"$ROOT_DIR/scripts/source-identity.sh\"" in build
        and "source \"$ROOT_DIR/scripts/source-identity.sh\"" in package
        and "source \"$ROOT_DIR/scripts/source-identity.sh\"" not in service,
        "源码制品身份没有由 build/package 共享，或被错误提升成 worker 请求协议",
    )
    require(
        "service_status_value worker_root" in service
        and "service_status_value output_root" in service
        and "worker_root=${worker_root:-unknown}" in service,
        "macOS 请求回执没有消费宿主 worker 的物理根与输出目录",
    )
    for marker in (
        "deepcode_source_commit",
        "deepcode_source_dirty",
        "deepcode_source_status_hash",
        "deepcode_source_fingerprint",
        "untracked=%s",
    ):
        require(marker in source_identity, f"共享源码身份 helper 缺少：{marker}")

    require(
        all(
            marker not in service
            for marker in (
                "checkout_root=%s",
                "source_commit=%s",
                "source_status_hash=%s",
                "source_fingerprint=%s",
                "validate_request_identity",
                "verify_published_request_identity",
            )
        )
        and "verify_source_fingerprint_unchanged" in package,
        "单仓 macOS worker 仍承载多层身份协议，或 package 丢失事务内源码一致性",
    )
    require(
        "scripts/tests/development_tooling.py" in test_entry
        and "scripts/macos-package-service.sh" in test_entry
        and "scripts/source-identity.sh" in test_entry,
        "required/static gate 没有登记开发工具身份回归",
    )


def main() -> int:
    check_runtime_contracts()
    check_current_path()
    check_development_tooling()
    if ISSUES:
        for issue in ISSUES:
            print(f"[FAIL] {issue}", file=sys.stderr)
        return 1
    print("[PASS] 本地 Agent 分层与当前合同资产")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
