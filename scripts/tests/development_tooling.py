#!/usr/bin/env python3
"""Focused checks for the single-checkout DeepCode development chain."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / "scripts" / "macos-package-service.sh"


def run(
    *args: str,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=ROOT,
        env=env,
        check=check,
        text=True,
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def read_key_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value
    return values


def check_toolchain_contract() -> None:
    toolchain = (ROOT / "rust-toolchain.toml").read_text(encoding="utf-8")
    if 'channel = "1.88.0"' not in toolchain:
        raise AssertionError("unexpected Rust toolchain channel")

    for manifest_path in (
        ROOT / "Cargo.toml",
        ROOT / "shells" / "deepcode-gui" / "src-tauri" / "Cargo.toml",
        ROOT / "shells" / "tauri" / "src-tauri" / "Cargo.toml",
    ):
        manifest = manifest_path.read_text(encoding="utf-8")
        if 'rust-version = "1.86"' not in manifest:
            raise AssertionError(f"{manifest_path} does not declare Rust 1.86")

    dockerfile = (ROOT / "Dockerfile.dev").read_text(encoding="utf-8")
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    package = (ROOT / "scripts" / "package-macos.sh").read_text(encoding="utf-8")
    if "ARG DEEPCODE_RUST_VERSION=1.88" not in dockerfile:
        raise AssertionError("Docker development image is not rooted at Rust 1.88")
    if "DEEPCODE_RUST_TOOLCHAIN ?=" not in makefile or "rust-toolchain.toml" not in makefile:
        raise AssertionError("Makefile does not derive the Docker Rust version from rust-toolchain.toml")
    if "docker build --provenance=false" not in makefile:
        raise AssertionError("Docker image identity is not stable across cached development builds")
    if "rust-toolchain.toml" not in package or "CANONICAL_RUST_TOOLCHAIN" not in package:
        raise AssertionError("macOS packaging does not consume rust-toolchain.toml")

    build = (ROOT / "build.sh").read_text(encoding="utf-8")
    if "SCCACHE_CONFIGURED=0" not in build or 'SCCACHE_CONFIGURED=1' not in build:
        raise AssertionError("sccache is not configured exactly once per build process")


def check_single_container_reconciliation(temporary_root: Path) -> None:
    fake_bin = temporary_root / "fake-bin"
    fake_bin.mkdir()
    docker_log = temporary_root / "fake-docker.log"
    container_state = temporary_root / "container-exists"
    container_state.touch()
    fake_docker = fake_bin / "docker"
    fake_docker.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "${1:-} ${2:-}" in
  "build "*) exit 0 ;;
  "container inspect")
    [ -f "$FAKE_CONTAINER_STATE" ] || exit 1
    if [ "${3:-}" = -f ]; then
      case "${4:-}" in
        *.Mounts*) printf '/retired-checkout\n' ;;
        *'.Image'*) printf 'sha256:old\n' ;;
        *'.State.Status'*) printf 'running\n' ;;
        *) printf '\n' ;;
      esac
    fi
    exit 0
    ;;
  "image inspect") printf 'sha256:new\n'; exit 0 ;;
  "container port") printf '127.0.0.1:39999\n'; exit 0 ;;
  "rm -f") rm -f "$FAKE_CONTAINER_STATE"; exit 0 ;;
  "run -d") touch "$FAKE_CONTAINER_STATE"; exit 0 ;;
esac
printf 'unexpected docker command: %s\n' "$*" >&2
exit 97
""",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)

    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment.get('PATH', '')}",
            "FAKE_DOCKER_LOG": str(docker_log),
            "FAKE_CONTAINER_STATE": str(container_state),
        }
    )
    run("make", "_ensure_container", env=environment)
    commands = docker_log.read_text(encoding="utf-8")
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    if 'reason="源码挂载已变化"' not in makefile:
        raise AssertionError("stale single container did not explain why it was rebuilt")
    if "rm -f deepcode-dev" not in commands:
        raise AssertionError("stale single container was not removed precisely")
    if "run -d --name deepcode-dev" not in commands:
        raise AssertionError("canonical deepcode-dev container was not recreated")
    if "DEEPCODE_WORKTREE_ID" in makefile:
        raise AssertionError("retired multi-worktree container configuration is still present")
    if "deepcode-dev-dev-main" in commands:
        raise AssertionError("single-checkout reconciliation created a branch-specific container")


def check_single_repository_package_queue(temporary_root: Path) -> None:
    service_root = temporary_root / "service"
    worker_root = temporary_root / "single-checkout"
    output_root = worker_root / "bin" / "macos-arm64"
    run_root = service_root / "run"
    run_root.mkdir(parents=True)
    (run_root / "service.status").write_text(
        f"worker_root={worker_root}\noutput_root={output_root}\n",
        encoding="utf-8",
    )
    environment = os.environ.copy()
    environment["DEEPCODE_MACOS_PACKAGE_SERVICE_DIR"] = str(service_root)
    result = run(
        "bash",
        str(SERVICE),
        "submit",
        "--products",
        "DeepCode-GUI,DeepCode",
        env=environment,
    )

    requests = list((service_root / "requests").glob("*.request"))
    statuses = list((service_root / "status").glob("*.status"))
    if len(requests) != 1 or len(statuses) != 1:
        raise AssertionError("macOS package submit did not create one request and one status")
    request = read_key_values(requests[0])
    if set(request) != {
        "products",
        "clean",
        "refresh_gui_dist",
        "kill_running",
        "created_at",
    }:
        raise AssertionError(f"package request carries unexpected authority fields: {sorted(request)}")
    if read_key_values(statuses[0]).get("state") != "queued":
        raise AssertionError("macOS package request was not queued")
    expected_receipt = f"worker_root={worker_root} output={output_root}"
    if expected_receipt not in result.stdout:
        raise AssertionError("package queue receipt does not expose the host worker root and output")


def main() -> int:
    check_toolchain_contract()
    with tempfile.TemporaryDirectory(prefix="deepcode-development-tooling-") as temporary:
        temporary_root = Path(temporary)
        check_single_container_reconciliation(temporary_root)
        check_single_repository_package_queue(temporary_root)
    print("[PASS] 单 checkout 开发容器、Rust 工具链与 macOS 打包队列")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
