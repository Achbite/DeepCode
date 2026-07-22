#!/usr/bin/env python3
"""Registry-driven controller behind the repository test.sh entrypoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any


SCHEMA_VERSION = 1
SUITE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


class ControllerError(Exception):
    """Configuration or selection error that must fail closed."""


class CancellationRequested(Exception):
    """Raised after SIGINT or SIGTERM so the active process group is reclaimed."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"received signal {signum}")
        self.signum = signum


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_registry(path: Path) -> tuple[dict[str, Any], str]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise ControllerError(f"cannot read registry {path}: {error}") from error

    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControllerError(f"invalid UTF-8 JSON registry {path}: {error}") from error

    if not isinstance(data, dict):
        raise ControllerError("registry root must be an object")
    return data, sha256_bytes(raw)


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ControllerError(f"{field} must be a non-empty string")
    return value


def require_nonnegative_int(value: Any, field: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ControllerError(f"{field} must be an integer")
    if (positive and value <= 0) or (not positive and value < 0):
        qualifier = "positive" if positive else "non-negative"
        raise ControllerError(f"{field} must be {qualifier}")
    return value


def validate_registry(data: dict[str, Any], root: Path) -> dict[str, dict[str, Any]]:
    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise ControllerError(
            f"unsupported registry schemaVersion {data.get('schemaVersion')!r}; "
            f"expected {SCHEMA_VERSION}"
        )

    profiles = data.get("profiles")
    raw_suites = data.get("suites")
    if not isinstance(profiles, dict) or not profiles:
        raise ControllerError("registry profiles must be a non-empty object")
    if not isinstance(raw_suites, list) or not raw_suites:
        raise ControllerError("registry suites must be a non-empty array")

    governance = data.get("governance")
    if not isinstance(governance, dict):
        raise ControllerError("registry governance must be an object")
    if governance.get("testChangesRequireUserApproval") is not True:
        raise ControllerError("governance.testChangesRequireUserApproval must be true")
    if governance.get("reviewModel") != "procedural-release-task":
        raise ControllerError(
            "governance.reviewModel must be 'procedural-release-task'"
        )
    for field in ("policyPath", "gatePath", "requestTemplatePath"):
        relative = require_string(governance.get(field), f"governance.{field}")
        resolved = (root / relative).resolve()
        try:
            resolved.relative_to(root)
        except ValueError as error:
            raise ControllerError(f"governance.{field} escapes the repository root") from error
        if not resolved.is_file():
            raise ControllerError(f"governance.{field} does not exist: {relative}")

    suites: dict[str, dict[str, Any]] = {}
    for index, suite in enumerate(raw_suites):
        prefix = f"suites[{index}]"
        if not isinstance(suite, dict):
            raise ControllerError(f"{prefix} must be an object")
        suite_id = require_string(suite.get("id"), f"{prefix}.id")
        if not SUITE_ID_PATTERN.fullmatch(suite_id):
            raise ControllerError(f"{prefix}.id has an invalid format: {suite_id!r}")
        if suite_id in suites:
            raise ControllerError(f"duplicate suite id: {suite_id}")

        require_string(suite.get("description"), f"{prefix}.description")
        for field in ("layer", "kind", "owner", "approvalClass"):
            require_string(suite.get(field), f"{prefix}.{field}")
        if not isinstance(suite.get("requiredGate"), bool):
            raise ControllerError(f"{prefix}.requiredGate must be a Boolean")
        if not isinstance(suite.get("transitional"), bool):
            raise ControllerError(f"{prefix}.transitional must be a Boolean")
        runner = suite.get("runner")
        if not isinstance(runner, dict):
            raise ControllerError(f"{prefix}.runner must be an object")
        if runner.get("type") != "shell":
            raise ControllerError(f"{prefix}.runner.type must be 'shell'")

        runner_path = require_string(runner.get("path"), f"{prefix}.runner.path")
        resolved_runner = (root / runner_path).resolve()
        try:
            resolved_runner.relative_to(root)
        except ValueError as error:
            raise ControllerError(f"{prefix}.runner.path escapes the repository root") from error
        if not resolved_runner.is_file():
            raise ControllerError(f"{prefix}.runner.path does not exist: {runner_path}")

        args = runner.get("args", [])
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            raise ControllerError(f"{prefix}.runner.args must be an array of strings")
        require_nonnegative_int(
            runner.get("timeoutSeconds"), f"{prefix}.runner.timeoutSeconds", positive=True
        )
        require_nonnegative_int(
            runner.get("terminateGraceSeconds", 5),
            f"{prefix}.runner.terminateGraceSeconds",
        )

        environment = suite.get("environment", {})
        if not isinstance(environment, dict):
            raise ControllerError(f"{prefix}.environment must be an object")
        host_policy = environment.get("hostPolicy", "allowed")
        if host_policy not in {"allowed", "explicit-opt-in", "forbidden"}:
            raise ControllerError(f"{prefix}.environment.hostPolicy is invalid")
        if host_policy == "explicit-opt-in":
            require_string(
                environment.get("hostOptInEnv"),
                f"{prefix}.environment.hostOptInEnv",
            )

        resources = suite.get("resources")
        if not isinstance(resources, list) or not all(
            isinstance(resource, str) and resource for resource in resources
        ):
            raise ControllerError(f"{prefix}.resources must be an array of strings")
        contract_sources = suite.get("contractSources")
        if not isinstance(contract_sources, list) or not contract_sources:
            raise ControllerError(f"{prefix}.contractSources must be a non-empty array")
        for source_index, source in enumerate(contract_sources):
            source_path = require_string(
                source, f"{prefix}.contractSources[{source_index}]"
            )
            resolved_source = (root / source_path).resolve()
            try:
                resolved_source.relative_to(root)
            except ValueError as error:
                raise ControllerError(
                    f"{prefix}.contractSources[{source_index}] escapes the repository root"
                ) from error
            if not resolved_source.is_file():
                raise ControllerError(
                    f"{prefix}.contractSources[{source_index}] does not exist: {source_path}"
                )

        suites[suite_id] = suite

    for profile_id, profile in profiles.items():
        if not isinstance(profile_id, str) or not SUITE_ID_PATTERN.fullmatch(profile_id):
            raise ControllerError(f"invalid profile id: {profile_id!r}")
        if not isinstance(profile, dict):
            raise ControllerError(f"profiles.{profile_id} must be an object")
        require_string(profile.get("description"), f"profiles.{profile_id}.description")
        suite_ids = profile.get("suites")
        if not isinstance(suite_ids, list) or not suite_ids:
            raise ControllerError(f"profiles.{profile_id}.suites must be a non-empty array")
        if not all(isinstance(suite_id, str) for suite_id in suite_ids):
            raise ControllerError(f"profiles.{profile_id}.suites must contain strings")
        if len(suite_ids) != len(set(suite_ids)):
            raise ControllerError(f"profiles.{profile_id}.suites contains duplicates")
        unknown = [suite_id for suite_id in suite_ids if suite_id not in suites]
        if unknown:
            raise ControllerError(
                f"profiles.{profile_id}.suites references unknown suites: {', '.join(unknown)}"
            )

    default_profile = require_string(data.get("defaultProfile"), "defaultProfile")
    if default_profile not in profiles:
        raise ControllerError(f"defaultProfile references unknown profile: {default_profile}")
    if default_profile != "required":
        raise ControllerError("schemaVersion 1 requires defaultProfile to be 'required'")
    required_suite_ids = {
        suite_id for suite_id, suite in suites.items() if suite["requiredGate"]
    }
    if not required_suite_ids:
        raise ControllerError("registry must contain at least one requiredGate suite")
    missing_required = required_suite_ids.difference(profiles[default_profile]["suites"])
    if missing_required:
        raise ControllerError(
            "default required profile omits requiredGate suites: "
            + ", ".join(sorted(missing_required))
        )
    return suites


def is_container_environment() -> bool:
    if Path("/.dockerenv").is_file():
        return True
    try:
        cgroup = Path("/proc/1/cgroup").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return any(marker in cgroup for marker in ("docker", "containerd", "kubepods"))


def git_output(root: Path, *args: str) -> str:
    environment = os.environ.copy()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=root,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ControllerError(f"git {' '.join(args)} failed: {error}") from error
    return completed.stdout.strip()


def git_bytes(root: Path, *args: str) -> bytes:
    environment = os.environ.copy()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=root,
            env=environment,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ControllerError(f"git {' '.join(args)} failed: {error}") from error
    return completed.stdout


def worktree_fingerprint(root: Path, head_sha: str) -> dict[str, Any]:
    root = root.resolve()
    tracked_diff = git_bytes(root, "diff", "--binary", head_sha, "--")
    untracked_raw = git_bytes(root, "ls-files", "--others", "--exclude-standard", "-z")
    untracked_paths = sorted(path for path in untracked_raw.split(b"\0") if path)
    digest = hashlib.sha256()
    digest.update(b"head\0" + head_sha.encode("ascii") + b"\0")
    digest.update(b"tracked\0" + tracked_diff + b"\0")
    for raw_path in untracked_paths:
        relative = raw_path.decode("utf-8", errors="surrogateescape")
        path = (root / relative).resolve(strict=False)
        try:
            path.relative_to(root)
        except ValueError as error:
            raise ControllerError(f"untracked path escapes repository root: {relative}") from error
        try:
            stat = path.lstat()
        except OSError as error:
            raise ControllerError(f"cannot fingerprint untracked path {relative}: {error}") from error
        digest.update(b"untracked\0" + raw_path + b"\0")
        digest.update(str(stat.st_mode).encode("ascii") + b"\0")
        if path.is_symlink():
            digest.update(os.readlink(path).encode("utf-8", errors="surrogateescape"))
        elif path.is_file():
            digest.update(path.read_bytes())
        else:
            raise ControllerError(f"unsupported untracked path type: {relative}")
        digest.update(b"\0")
    return {
        "sha256": digest.hexdigest(),
        "dirty": bool(tracked_diff or untracked_paths),
        "trackedDiffSha256": sha256_bytes(tracked_diff),
        "untrackedCount": len(untracked_paths),
    }


def selected_asset_manifest(root: Path, suites: list[dict[str, Any]]) -> dict[str, Any]:
    assets: dict[str, dict[str, Any]] = {}
    suite_definitions: list[dict[str, Any]] = []
    for suite in suites:
        suite_definitions.append(suite)
        paths = [suite["runner"]["path"], *suite["contractSources"]]
        for relative in paths:
            if relative in assets:
                continue
            path = (root / relative).resolve()
            try:
                path.relative_to(root)
            except ValueError as error:
                raise ControllerError(f"selected asset escapes repository root: {relative}") from error
            raw = path.read_bytes()
            assets[relative] = {
                "sha256": sha256_bytes(raw),
                "size": len(raw),
            }
    canonical_suites = json.dumps(
        suite_definitions,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "suiteDefinitionsSha256": sha256_bytes(canonical_suites),
        "files": {key: assets[key] for key in sorted(assets)},
    }


def select_suite_ids(
    data: dict[str, Any], suites: dict[str, dict[str, Any]], args: argparse.Namespace
) -> tuple[list[str], str]:
    profiles = data["profiles"]
    if args.profile and args.suite:
        raise ControllerError("--profile and --suite cannot be combined")
    if args.profile:
        if args.profile not in profiles:
            raise ControllerError(f"unknown profile: {args.profile}")
        return list(profiles[args.profile]["suites"]), f"profile:{args.profile}"
    if args.suite:
        unknown = [suite_id for suite_id in args.suite if suite_id not in suites]
        if unknown:
            raise ControllerError(f"unknown suite: {', '.join(unknown)}")
        if len(args.suite) != len(set(args.suite)):
            raise ControllerError("--suite cannot select the same suite more than once")
        return list(args.suite), "explicit-suites"
    default_profile = data["defaultProfile"]
    return list(profiles[default_profile]["suites"]), f"profile:{default_profile}"


def check_host_policy(suite: dict[str, Any]) -> None:
    if is_container_environment():
        return
    environment = suite.get("environment", {})
    policy = environment.get("hostPolicy", "allowed")
    suite_id = suite["id"]
    if policy == "forbidden":
        raise ControllerError(f"suite {suite_id} cannot run outside a container")
    if policy == "explicit-opt-in":
        opt_in = environment["hostOptInEnv"]
        if os.environ.get(opt_in) != "1":
            raise ControllerError(
                f"suite {suite_id} requires a container; select --profile static for "
                f"host-safe checks or set {opt_in}=1 for explicit host execution"
            )


def process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def terminate_process_group(process: subprocess.Popen[Any], grace_seconds: int) -> bool:
    """Reclaim this controller's process group and report whether it existed."""

    process_group_id = process.pid
    previous_sigint = signal.signal(signal.SIGINT, signal.SIG_IGN)
    previous_sigterm = signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        if not process_group_exists(process_group_id):
            if process.poll() is None:
                process.wait()
            return False
        try:
            os.killpg(process_group_id, signal.SIGTERM)
        except ProcessLookupError:
            return False

        deadline = time.monotonic() + grace_seconds
        while process_group_exists(process_group_id) and time.monotonic() < deadline:
            process.poll()
            time.sleep(0.05)
        if process_group_exists(process_group_id):
            try:
                os.killpg(process_group_id, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.poll() is None:
            process.wait()
        kill_deadline = time.monotonic() + 1
        while process_group_exists(process_group_id) and time.monotonic() < kill_deadline:
            time.sleep(0.05)
        if process_group_exists(process_group_id):
            raise ControllerError(
                f"owned process group {process_group_id} survived SIGKILL"
            )
        return True
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        signal.signal(signal.SIGTERM, previous_sigterm)


def run_suite(
    root: Path, suite: dict[str, Any], *, json_mode: bool
) -> dict[str, Any]:
    check_host_policy(suite)
    runner = suite["runner"]
    runner_path = (root / runner["path"]).resolve()
    command = ["bash", str(runner_path), *runner.get("args", [])]
    environment = os.environ.copy()
    environment["DEEPCODE_TEST_CONTROLLER"] = "1"
    environment["DEEPCODE_TEST_SUITE_ID"] = suite["id"]
    timeout_seconds = runner["timeoutSeconds"]
    grace_seconds = runner.get("terminateGraceSeconds", 5)

    log_stream = sys.stderr if json_mode else sys.stdout
    print(f"[RUN] {suite['id']}: {suite['description']}", file=log_stream, flush=True)
    started_at = utc_now()
    started = time.monotonic()
    process: subprocess.Popen[Any] | None = None
    timed_out = False
    residual_group_reclaimed = False
    try:
        blocked_signals = {signal.SIGINT, signal.SIGTERM}
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
        try:
            process = subprocess.Popen(
                command,
                cwd=root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log_stream,
                stderr=sys.stderr,
                start_new_session=True,
            )
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        try:
            exit_code = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            terminate_process_group(process, grace_seconds)
            exit_code = 124
        except BaseException:
            terminate_process_group(process, grace_seconds)
            raise
    finally:
        if process is not None:
            residual_group_reclaimed = terminate_process_group(process, grace_seconds)

    duration_seconds = round(time.monotonic() - started, 3)
    status = "timed-out" if timed_out else ("passed" if exit_code == 0 else "failed")
    print(
        f"[{status.upper()}] {suite['id']} ({duration_seconds:.3f}s)",
        file=log_stream,
        flush=True,
    )
    return {
        "id": suite["id"],
        "status": status,
        "exitCode": exit_code,
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "durationSeconds": duration_seconds,
        "residualProcessGroupReclaimed": residual_group_reclaimed,
    }


def list_payload(
    data: dict[str, Any], suites: dict[str, dict[str, Any]], registry_digest: str
) -> dict[str, Any]:
    return {
        "schemaVersion": data["schemaVersion"],
        "defaultProfile": data["defaultProfile"],
        "registrySha256": registry_digest,
        "profiles": [
            {
                "id": profile_id,
                "description": profile["description"],
                "suites": profile["suites"],
            }
            for profile_id, profile in data["profiles"].items()
        ],
        "suites": [
            {
                "id": suite_id,
                "description": suite["description"],
                "kind": suite.get("kind"),
                "layer": suite.get("layer"),
                "requiredGate": suite.get("requiredGate", False),
                "transitional": suite.get("transitional", False),
                "hostPolicy": suite.get("environment", {}).get("hostPolicy", "allowed"),
                "timeoutSeconds": suite["runner"]["timeoutSeconds"],
            }
            for suite_id, suite in suites.items()
        ],
    }


def print_list(payload: dict[str, Any], *, json_mode: bool) -> None:
    if json_mode:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    print(f"Default profile: {payload['defaultProfile']}")
    print("Profiles:")
    for profile in payload["profiles"]:
        marker = " (default)" if profile["id"] == payload["defaultProfile"] else ""
        print(f"  {profile['id']}{marker}: {profile['description']}")
        print(f"    suites: {', '.join(profile['suites'])}")
    print("Suites:")
    for suite in payload["suites"]:
        flags = []
        if suite["requiredGate"]:
            flags.append("required")
        if suite["transitional"]:
            flags.append("transitional")
        suffix = f" [{', '.join(flags)}]" if flags else ""
        print(f"  {suite['id']}{suffix}: {suite['description']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run DeepCode test suites from the repository registry."
    )
    parser.add_argument("--registry", required=True, help=argparse.SUPPRESS)
    parser.add_argument("--list", action="store_true", help="list registered profiles and suites")
    parser.add_argument("--profile", help="run one registered profile")
    parser.add_argument(
        "--suite", action="append", help="run one suite; repeat to select multiple suites"
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable result JSON")
    return parser


def install_signal_handlers() -> None:
    def handle_signal(signum: int, _frame: Any) -> None:
        raise CancellationRequested(signum)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    install_signal_handlers()
    controller_path = Path(__file__).resolve()
    root = controller_path.parent.parent
    registry_path = Path(args.registry).resolve()
    try:
        registry_path.relative_to(root)
    except ValueError as error:
        raise ControllerError("registry must be inside the repository root") from error

    data, registry_digest = load_registry(registry_path)
    suites = validate_registry(data, root)
    if args.list:
        if args.profile or args.suite:
            raise ControllerError("--list cannot be combined with --profile or --suite")
        print_list(list_payload(data, suites, registry_digest), json_mode=args.json)
        return 0

    suite_ids, selected_by = select_suite_ids(data, suites, args)
    for suite_id in suite_ids:
        check_host_policy(suites[suite_id])

    head_before = git_output(root, "rev-parse", "HEAD")
    worktree_before = worktree_fingerprint(root, head_before)
    asset_manifest_before = selected_asset_manifest(
        root, [suites[suite_id] for suite_id in suite_ids]
    )
    controller_digest = sha256_bytes(controller_path.read_bytes())
    started_at = utc_now()
    run_started = time.monotonic()
    results: list[dict[str, Any]] = []
    overall_exit = 0

    for index, suite_id in enumerate(suite_ids):
        result = run_suite(root, suites[suite_id], json_mode=args.json)
        results.append(result)
        if result["exitCode"] != 0:
            overall_exit = result["exitCode"]
            for skipped_id in suite_ids[index + 1 :]:
                results.append({"id": skipped_id, "status": "skipped", "exitCode": None})
            break

    head_after = git_output(root, "rev-parse", "HEAD")
    worktree_after = worktree_fingerprint(root, head_after)
    asset_manifest_after = selected_asset_manifest(
        root, [suites[suite_id] for suite_id in suite_ids]
    )
    final_registry_digest = sha256_bytes(registry_path.read_bytes())
    final_controller_digest = sha256_bytes(controller_path.read_bytes())
    identity_stable = (
        head_after == head_before
        and final_registry_digest == registry_digest
        and final_controller_digest == controller_digest
        and asset_manifest_after == asset_manifest_before
        and worktree_after["sha256"] == worktree_before["sha256"]
    )
    if not identity_stable and overall_exit == 0:
        overall_exit = 2

    receipt = {
        "schemaVersion": 1,
        "status": "passed" if overall_exit == 0 else "failed",
        "selectedBy": selected_by,
        "suiteIds": suite_ids,
        "headSha": head_before,
        "headStable": head_after == head_before,
        "worktree": {
            "dirtyAtStart": worktree_before["dirty"],
            "sha256Before": worktree_before["sha256"],
            "sha256After": worktree_after["sha256"],
            "stable": worktree_after["sha256"] == worktree_before["sha256"],
            "trackedDiffSha256": worktree_before["trackedDiffSha256"],
            "untrackedCount": worktree_before["untrackedCount"],
        },
        "registrySha256": registry_digest,
        "registryStable": final_registry_digest == registry_digest,
        "controllerSha256": controller_digest,
        "controllerStable": final_controller_digest == controller_digest,
        "selectedAssets": asset_manifest_before,
        "selectedAssetsStable": asset_manifest_after == asset_manifest_before,
        "authoritative": overall_exit == 0
        and not worktree_before["dirty"]
        and identity_stable,
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "durationSeconds": round(time.monotonic() - run_started, 3),
        "results": results,
    }
    encoded_receipt = json.dumps(receipt, ensure_ascii=False, sort_keys=True)
    if args.json:
        print(encoded_receipt)
    else:
        print(f"[TEST RECEIPT] {encoded_receipt}")
    return overall_exit


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CancellationRequested as error:
        print(f"[CANCELLED] {error}", file=sys.stderr)
        raise SystemExit(128 + error.signum)
    except ControllerError as error:
        print(f"[TEST CONFIG ERROR] {error}", file=sys.stderr)
        raise SystemExit(2)
