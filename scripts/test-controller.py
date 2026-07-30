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
TRUSTED_GIT_PATH = "/usr/bin/git"
TRUSTED_BASH_PATH = "/bin/bash"
UNTRUSTED_GIT_ENVIRONMENT = {
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIFF_OPTS",
    "GIT_DIR",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_EXEC_PATH",
    "GIT_EXTERNAL_DIFF",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_QUARANTINE_PATH",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
}
UNTRUSTED_RUNNER_ENVIRONMENT = {
    "BASHOPTS",
    "BASH_ENV",
    "BASH_XTRACEFD",
    "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
    "CARGO_BUILD_RUSTC_WRAPPER",
    "CDPATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "ENV",
    "GLOBIGNORE",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NPM_CONFIG_SCRIPT_SHELL",
    "PROMPT_COMMAND",
    "PYTHONHOME",
    "PYTHONINSPECT",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "RUSTC",
    "RUSTC_WORKSPACE_WRAPPER",
    "RUSTC_WRAPPER",
    "RUSTDOC",
    "RUBYOPT",
    "SHELLOPTS",
    "npm_config_script_shell",
}


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
    smoke_policy = governance.get("smokePolicy")
    if not isinstance(smoke_policy, dict):
        raise ControllerError("governance.smokePolicy must be an object")
    max_smoke_cases = require_nonnegative_int(
        smoke_policy.get("maxCasesPerSuite"),
        "governance.smokePolicy.maxCasesPerSuite",
        positive=True,
    )
    max_smoke_suites = require_nonnegative_int(
        smoke_policy.get("maxSuites"),
        "governance.smokePolicy.maxSuites",
        positive=True,
    )
    max_total_smoke_cases = require_nonnegative_int(
        smoke_policy.get("maxTotalCases"),
        "governance.smokePolicy.maxTotalCases",
        positive=True,
    )
    if smoke_policy.get("caseRegistration") != "exact-controller-handshake":
        raise ControllerError(
            "governance.smokePolicy.caseRegistration must be "
            "'exact-controller-handshake'"
        )
    if smoke_policy.get("scope") != "runtime-path-and-historical-defects":
        raise ControllerError(
            "governance.smokePolicy.scope must be "
            "'runtime-path-and-historical-defects'"
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
    registered_smoke_case_ids: set[str] = set()
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
        if suite["kind"] == "smoke" and suite["requiredGate"]:
            raise ControllerError(f"{prefix}: smoke suites cannot be requiredGate")
        if not isinstance(suite.get("transitional"), bool):
            raise ControllerError(f"{prefix}.transitional must be a Boolean")
        if suite["kind"] == "smoke":
            if suite["transitional"]:
                raise ControllerError(f"{prefix}: smoke suites cannot be transitional")
            group = require_string(suite.get("group"), f"{prefix}.group")
            if suite_id != f"session.smoke.{group}":
                raise ControllerError(
                    f"{prefix}.id must be session.smoke.<group> and match {prefix}.group"
                )
            cases = suite.get("cases")
            if not isinstance(cases, list) or not cases:
                raise ControllerError(f"{prefix}.cases must be a non-empty array")
            if len(cases) > max_smoke_cases:
                raise ControllerError(
                    f"{prefix}.cases exceeds smokePolicy.maxCasesPerSuite={max_smoke_cases}"
                )
            suite_case_ids: set[str] = set()
            for case_index, smoke_case in enumerate(cases):
                case_prefix = f"{prefix}.cases[{case_index}]"
                if not isinstance(smoke_case, dict):
                    raise ControllerError(f"{case_prefix} must be an object")
                case_id = require_string(smoke_case.get("id"), f"{case_prefix}.id")
                if not SUITE_ID_PATTERN.fullmatch(case_id):
                    raise ControllerError(f"{case_prefix}.id has an invalid format: {case_id!r}")
                if not case_id.startswith(f"{group}."):
                    raise ControllerError(
                        f"{case_prefix}.id must start with the smoke group {group}."
                    )
                if case_id in suite_case_ids or case_id in registered_smoke_case_ids:
                    raise ControllerError(f"duplicate smoke case id: {case_id}")
                suite_case_ids.add(case_id)
                registered_smoke_case_ids.add(case_id)
                require_string(smoke_case.get("incidentRef"), f"{case_prefix}.incidentRef")
                require_string(smoke_case.get("invariant"), f"{case_prefix}.invariant")
                require_string(smoke_case.get("sourcePath"), f"{case_prefix}.sourcePath")
        elif "group" in suite or "cases" in suite:
            raise ControllerError(f"{prefix}: only smoke suites may declare group or cases")
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

        if suite["kind"] == "smoke":
            for case_index, smoke_case in enumerate(suite["cases"]):
                source_path = smoke_case["sourcePath"]
                if source_path not in contract_sources:
                    raise ControllerError(
                        f"{prefix}.cases[{case_index}].sourcePath must be listed in "
                        f"{prefix}.contractSources"
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
    required_profile_suite_ids = set(profiles[default_profile]["suites"])
    missing_required = required_suite_ids.difference(required_profile_suite_ids)
    if missing_required:
        raise ControllerError(
            "default required profile omits requiredGate suites: "
            + ", ".join(sorted(missing_required))
        )
    unexpected_required = required_profile_suite_ids.difference(required_suite_ids)
    if unexpected_required:
        raise ControllerError(
            "default required profile includes non-requiredGate suites: "
            + ", ".join(sorted(unexpected_required))
        )
    if "smoke" not in profiles:
        raise ControllerError("schemaVersion 1 requires a smoke profile")
    smoke_suite_ids = {
        suite_id for suite_id, suite in suites.items() if suite["kind"] == "smoke"
    }
    if not smoke_suite_ids:
        raise ControllerError("registry must contain at least one smoke suite")
    if len(smoke_suite_ids) > max_smoke_suites:
        raise ControllerError(
            f"smoke suite count exceeds smokePolicy.maxSuites={max_smoke_suites}"
        )
    if len(registered_smoke_case_ids) > max_total_smoke_cases:
        raise ControllerError(
            "smoke case count exceeds "
            f"smokePolicy.maxTotalCases={max_total_smoke_cases}"
        )
    smoke_profile_suite_ids = set(profiles["smoke"]["suites"])
    if smoke_profile_suite_ids != smoke_suite_ids:
        raise ControllerError(
            "smoke profile must contain every and only smoke suite: "
            + ", ".join(sorted(smoke_suite_ids))
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


def trusted_git_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in list(environment):
        if (
            name in UNTRUSTED_GIT_ENVIRONMENT
            or name == "GIT_CONFIG_COUNT"
            or name.startswith("GIT_CONFIG_KEY_")
            or name.startswith("GIT_CONFIG_VALUE_")
            or name.startswith("GIT_TRACE")
        ):
            environment.pop(name, None)
    environment["GIT_CONFIG_GLOBAL"] = os.devnull
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    environment["GIT_NO_REPLACE_OBJECTS"] = "1"
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    environment["GIT_TERMINAL_PROMPT"] = "0"
    environment["LC_ALL"] = "C"
    return environment


def trusted_runner_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in list(environment):
        if (
            name in UNTRUSTED_RUNNER_ENVIRONMENT
            or name in UNTRUSTED_GIT_ENVIRONMENT
            or name.startswith("BASH_FUNC_")
            or name == "GIT_CONFIG_COUNT"
            or name.startswith("GIT_CONFIG_KEY_")
            or name.startswith("GIT_CONFIG_VALUE_")
            or name.startswith("GIT_TRACE")
            or (name.startswith("CARGO_TARGET_") and name.endswith("_RUNNER"))
        ):
            environment.pop(name, None)
    environment["DEEPCODE_DISABLE_SCCACHE"] = "1"
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


def trusted_git_command(*args: str) -> list[str]:
    return [
        TRUSTED_GIT_PATH,
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        *args,
    ]


def git_output(root: Path, *args: str) -> str:
    try:
        completed = subprocess.run(
            trusted_git_command(*args),
            cwd=root,
            env=trusted_git_environment(),
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ControllerError(f"git {' '.join(args)} failed: {error}") from error
    return completed.stdout.strip()


def git_bytes(root: Path, *args: str) -> bytes:
    try:
        completed = subprocess.run(
            trusted_git_command(*args),
            cwd=root,
            env=trusted_git_environment(),
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ControllerError(f"git {' '.join(args)} failed: {error}") from error
    return completed.stdout


def git_blob_at_head(root: Path, head_sha: str, relative: str) -> bytes | None:
    completed = subprocess.run(
        trusted_git_command("cat-file", "blob", f"{head_sha}:{relative}"),
        cwd=root,
        env=trusted_git_environment(),
        capture_output=True,
    )
    return completed.stdout if completed.returncode == 0 else None


def verify_repository_root(root: Path) -> None:
    observed = Path(git_output(root, "rev-parse", "--show-toplevel")).resolve()
    expected = root.resolve()
    if observed != expected:
        raise ControllerError(
            f"Git worktree root mismatch: expected {expected}, observed {observed}"
        )


def worktree_fingerprint(root: Path, head_sha: str) -> dict[str, Any]:
    root = root.resolve()
    tracked_diff = git_bytes(
        root,
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        head_sha,
        "--",
    )
    index_entries_raw = git_bytes(root, "ls-files", "-v", "-z")
    untrusted_index_entries = [
        entry for entry in index_entries_raw.split(b"\0")
        if entry and not entry.startswith(b"H ")
    ]
    untracked_raw = git_bytes(root, "ls-files", "--others", "--exclude-standard", "-z")
    untracked_paths = sorted(path for path in untracked_raw.split(b"\0") if path)
    digest = hashlib.sha256()
    digest.update(b"head\0" + head_sha.encode("ascii") + b"\0")
    digest.update(b"tracked\0" + tracked_diff + b"\0")
    digest.update(b"index\0" + index_entries_raw + b"\0")
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
        "dirty": bool(tracked_diff or untracked_paths or untrusted_index_entries),
        "trackedDiffSha256": sha256_bytes(tracked_diff),
        "untrackedCount": len(untracked_paths),
        "indexTrusted": not untrusted_index_entries,
        "untrustedIndexEntryCount": len(untrusted_index_entries),
    }


def selected_asset_manifest(
    root: Path,
    suites: list[dict[str, Any]],
    head_sha: str,
) -> dict[str, Any]:
    root = root.resolve()
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
            head_blob = git_blob_at_head(root, head_sha, relative)
            assets[relative] = {
                "sha256": sha256_bytes(raw),
                "size": len(raw),
                "headBound": head_blob == raw,
            }
    canonical_suites = json.dumps(
        suite_definitions,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "suiteDefinitionsSha256": sha256_bytes(canonical_suites),
        "headBound": all(asset["headBound"] for asset in assets.values()),
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
    command = [TRUSTED_BASH_PATH, str(runner_path), *runner.get("args", [])]
    environment = trusted_runner_environment()
    environment["DEEPCODE_TEST_CONTROLLER"] = "1"
    environment["DEEPCODE_TEST_SUITE_ID"] = suite["id"]
    environment.pop("DEEPCODE_TEST_CASE_IDS", None)
    environment.pop("DEEPCODE_TEST_SMOKE_GROUP", None)
    if suite["kind"] == "smoke":
        environment["DEEPCODE_TEST_CASE_IDS"] = json.dumps(
            [smoke_case["id"] for smoke_case in suite["cases"]],
            separators=(",", ":"),
        )
        environment["DEEPCODE_TEST_SMOKE_GROUP"] = suite["group"]
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

        def restore_child_signal_mask() -> None:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

        try:
            process = subprocess.Popen(
                command,
                cwd=root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log_stream,
                stderr=sys.stderr,
                start_new_session=True,
                preexec_fn=restore_child_signal_mask,
            )
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        try:
            exit_code = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            residual_group_reclaimed = terminate_process_group(
                process, grace_seconds
            )
            exit_code = 124
        except BaseException:
            terminate_process_group(process, grace_seconds)
            raise
    finally:
        if process is not None:
            residual_group_reclaimed = (
                terminate_process_group(process, grace_seconds)
                or residual_group_reclaimed
            )

    duration_seconds = round(time.monotonic() - started, 3)
    status = "timed-out" if timed_out else ("passed" if exit_code == 0 else "failed")
    status_label = {"passed": "PASS", "failed": "FAIL", "timed-out": "TIMEOUT"}[status]
    print(
        f"[{status_label}] {suite['id']} ({duration_seconds:.3f}s)",
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
                "group": suite.get("group"),
                "cases": suite.get("cases", []),
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
        if suite["kind"] == "smoke":
            print(
                "    cases: "
                + ", ".join(smoke_case["id"] for smoke_case in suite["cases"])
            )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run DeepCode test suites from the repository registry."
    )
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
    registry_path = root / "tests" / "registry.json"
    if registry_path.is_symlink() or registry_path.resolve() != registry_path:
        raise ControllerError("canonical tests/registry.json must be a regular in-tree path")

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

    verify_repository_root(root)
    head_before = git_output(root, "rev-parse", "HEAD")
    worktree_before = worktree_fingerprint(root, head_before)
    asset_manifest_before = selected_asset_manifest(
        root, [suites[suite_id] for suite_id in suite_ids], head_before
    )
    controller_digest = sha256_bytes(controller_path.read_bytes())
    registry_head_bound = git_blob_at_head(
        root, head_before, str(registry_path.relative_to(root))
    ) == registry_path.read_bytes()
    controller_head_bound = git_blob_at_head(
        root, head_before, str(controller_path.relative_to(root))
    ) == controller_path.read_bytes()
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
        root, [suites[suite_id] for suite_id in suite_ids], head_after
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

    required_gate_suite_ids = {
        suite_id for suite_id, suite in suites.items() if suite["requiredGate"]
    }
    selected_all_required = (
        len(suite_ids) == len(required_gate_suite_ids)
        and set(suite_ids) == required_gate_suite_ids
    )
    required_gate_complete = (
        selected_by == "profile:required"
        and selected_all_required
        and overall_exit == 0
        and not worktree_before["dirty"]
        and registry_head_bound
        and controller_head_bound
        and asset_manifest_before["headBound"]
        and identity_stable
    )

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
            "indexTrusted": worktree_before["indexTrusted"],
            "untrustedIndexEntryCount": worktree_before["untrustedIndexEntryCount"],
        },
        "registrySha256": registry_digest,
        "registryStable": final_registry_digest == registry_digest,
        "registryHeadBound": registry_head_bound,
        "controllerSha256": controller_digest,
        "controllerStable": final_controller_digest == controller_digest,
        "controllerHeadBound": controller_head_bound,
        "selectedAssets": asset_manifest_before,
        "selectedAssetsStable": asset_manifest_after == asset_manifest_before,
        "authoritative": False,
        "finalAcceptance": False,
        "evidenceRole": "supporting-evidence-only",
        "requiredGateComplete": required_gate_complete,
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
