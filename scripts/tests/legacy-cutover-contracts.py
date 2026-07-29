#!/usr/bin/env python3
"""Fail closed on reachable v1 Kernel/Session surfaces after the v2 cutover."""

from __future__ import annotations

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[2]
ISSUES: list[str] = []


def repository_path(relative: str) -> Path:
    return ROOT / relative


def read_text(relative: str) -> str:
    path = repository_path(relative)
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        ISSUES.append(f"{relative}: cannot read required cutover asset: {error}")
        return ""


def require_absent(relative: str) -> None:
    if repository_path(relative).exists():
        ISSUES.append(f"{relative}: retired v1 asset is still present")


def require_literal(relative: str, literal: str, reason: str) -> None:
    if literal not in read_text(relative):
        ISSUES.append(f"{relative}: missing {reason}")


def forbid_literal(relative: str, literal: str, reason: str) -> None:
    if literal in read_text(relative):
        ISSUES.append(f"{relative}: {reason}")


def forbid_pattern(relative: str, pattern: str, reason: str) -> None:
    if re.search(pattern, read_text(relative), flags=re.MULTILINE):
        ISSUES.append(f"{relative}: {reason}")


def scan_session_agent_surface() -> None:
    """Scan Session orchestration only, not legitimate Host transports or UI tools."""

    root = repository_path("userspace/session-core/src")
    patterns = (
        (r"\bKernelCommandEnvelope\b", "legacy KernelCommandEnvelope is reachable"),
        (r"\bKernelReply\b", "legacy KernelReply is reachable"),
        (r"\bSessionDriverLoop\b", "legacy SessionDriverLoop is reachable"),
        (r"\bActionBatch\b", "legacy ActionBatch is reachable"),
        (r"\bWorkUnit\b", "legacy WorkUnit is reachable"),
        (r"\bReviewGate\b", "legacy ReviewGate is reachable"),
        (re.escape("deepcode.agent.protocol.v4"), "legacy protocol v4 identity is reachable"),
        (re.escape("deepcode.kernel.tools.v3"), "legacy tool catalog v3 identity is reachable"),
        (re.escape("/api/kernel/commands"), "legacy Kernel command route is reachable"),
        (re.escape("/api/kernel/snapshot"), "legacy Kernel snapshot route is reachable"),
        (
            r"""["'](?:git\.push|process\.exec|provider\.call|browser\.[^"']+)["']""",
            "retired agent-facing tool identity is reachable",
        ),
    )
    for path in sorted(root.rglob("*.ts")):
        if "__tests__" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        for pattern, reason in patterns:
            if re.search(pattern, text):
                relative = path.relative_to(ROOT).as_posix()
                ISSUES.append(f"{relative}: {reason}")


def scan_kernel_registry_surface() -> None:
    """Inspect only the agent-facing registry so Host browser/process APIs remain legal."""

    paths = (
        "crates/deepcode-kernel-tools/src/catalog.rs",
        "crates/deepcode-kernel-tools/src/registrations/mod.rs",
        "crates/deepcode-kernel-tools/src/registrations/schema.rs",
    )
    retired_id = re.compile(
        r"""["'](?:git\.push|process\.exec|provider\.call|browser\.[^"']+)["']"""
    )
    for relative in paths:
        text = read_text(relative)
        match = retired_id.search(text)
        if match:
            ISSUES.append(
                f"{relative}: retired agent-facing registry identity remains: {match.group(0)}"
            )

    catalog = read_text("crates/deepcode-kernel-tools/src/catalog.rs")
    for pattern, reason in (
        (r"registrations\.len\(\)\s*,\s*19", "frozen 19-tool registry assertion"),
        (r"\bready\s*,\s*13", "frozen 13-ready-tool assertion"),
        (r"\bexecutable\s*,\s*13", "frozen 13-executor assertion"),
    ):
        if not re.search(pattern, catalog):
            ISSUES.append(
                "crates/deepcode-kernel-tools/src/catalog.rs: "
                f"missing {reason}"
            )
    for tool_id in (
        "fs.rename",
        "git.commit",
        "git.diff",
        "git.stage",
        "git.status",
        "git.unstage",
    ):
        if f'"{tool_id}"' not in catalog:
            ISSUES.append(
                "crates/deepcode-kernel-tools/src/catalog.rs: "
                f"missing frozen disabled identity {tool_id}"
            )


def main() -> int:
    for relative in (
        "crates/deepcode-kernel-abi/src/tests",
        "crates/deepcode-kernel-audit",
        "crates/deepcode-kernel-daemon/src/agent_bridge.rs",
        "crates/deepcode-kernel-daemon/src/session_store.rs",
        "crates/deepcode-kernel-daemon/src/session_store_tests.rs",
        "crates/deepcode-kernel-runtime/src/resources.rs",
        "crates/deepcode-kernel-runtime/src/scheduler.rs",
        "crates/deepcode-kernel-runtime/src/tests/authorization_tests.rs",
        "crates/deepcode-kernel-runtime/src/tests/draft_tests.rs",
        "crates/deepcode-kernel-runtime/src/tests/execution_tests.rs",
        "crates/deepcode-kernel-runtime/src/tests/tool_tests.rs",
        "crates/deepcode-kernel-runtime/src/tests/workspace_tests.rs",
        "crates/deepcode-kernel-tools/src/authorization.rs",
        "crates/deepcode-kernel-tools/src/sandbox.rs",
        "fixtures/kernel-tools-v3",
        "scripts/verify-kernel-cli.py",
        "userspace/protocol/src/kernel.ts",
    ):
        require_absent(relative)

    forbid_literal(
        "Cargo.toml",
        "deepcode-kernel-audit",
        "retired audit crate remains in the production workspace",
    )
    forbid_pattern(
        "crates/deepcode-kernel-abi/src/lib.rs",
        r"^\s*(?:pub\s+)?mod\s+(?:audit|command|draft|driver|event|execution|facts|ids|"
        r"lifecycle|permissions|plan|refs|resource|resource_packet|run|snapshot|tool|wire)\s*;",
        "legacy ABI module remains exported or compiled",
    )
    forbid_pattern(
        "crates/deepcode-kernel-runtime/src/lib.rs",
        r"\bDeepCodeKernelRuntime\b|^\s*(?:pub\s+)?mod\s+(?:resources|scheduler)\s*;",
        "legacy Runtime authority remains reachable",
    )
    for symbol in (
        "pub struct LedgerEvent",
        "pub trait EventLedger",
        "pub struct InMemoryEventLedger",
        "pub struct NdjsonEventLedger",
    ):
        forbid_literal(
            "crates/deepcode-kernel-ledger/src/lib.rs",
            symbol,
            f"legacy ledger symbol remains reachable: {symbol}",
        )
    require_literal(
        "crates/deepcode-kernel-ledger/src/lib.rs",
        "pub mod v2;",
        "canonical v2 fact-store export",
    )

    routes = "crates/deepcode-kernel-daemon/src/routes.rs"
    for retired_route in (
        '"/api/kernel/commands"',
        '"/api/kernel/snapshot"',
        '"/api/agent/tools"',
    ):
        forbid_literal(routes, retired_route, f"legacy live route remains: {retired_route}")
    for required_route in (
        "KERNEL_V2_COMMANDS_PATH",
        "KERNEL_V2_USER_DECISIONS_PATH",
    ):
        require_literal(routes, required_route, f"required v2 route {required_route}")

    forbid_literal(
        "userspace/protocol/src/index.ts",
        "export * from './kernel.js';",
        "legacy TypeScript Kernel wire export remains reachable",
    )
    require_literal(
        "userspace/protocol/src/index.ts",
        "export * from './kernelAbiV2.js';",
        "v2 TypeScript Kernel ABI export",
    )
    require_literal(
        "userspace/session-core/src/index.ts",
        "export * from './kernel-v2/index.js';",
        "Session v2 public entrypoint",
    )

    for relative in ("build.sh", "scripts/package-macos.sh"):
        for retired_identity in (
            "deepcode.agent.protocol.v4",
            "deepcode.kernel.tools.v3",
            "browser.snapshot",
        ):
            forbid_literal(
                relative,
                retired_identity,
                f"retired packaged agent identity remains: {retired_identity}",
            )

    scan_kernel_registry_surface()
    scan_session_agent_surface()

    if ISSUES:
        for issue in ISSUES:
            print(f"[FAIL] {issue}", file=sys.stderr)
        return 1
    print("[PASS] legacy cutover semantic contracts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
