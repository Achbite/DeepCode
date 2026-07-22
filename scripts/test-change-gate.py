#!/usr/bin/env python3
"""Classify and verify protected test-asset changes between two commits."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from typing import Any
from urllib.parse import urlsplit, urlunsplit


POLICY_PATH = "tests/protected-paths.json"
REVIEW_RECORD_SCHEMA_VERSION = 1
REVIEW_MODEL = "procedural-release-task"
REVIEW_RECORD_TYPE = "deepcode-test-release-review"
REVIEW_WORKFLOW_MODEL = "development-session-user-independent-release-session"
REVIEW_AUTHENTICATION = "none"
REVIEW_AUTHORIZATION_PROOF = "none"
REVIEW_SESSION_INDEPENDENCE_PROOF = "none"
REVIEW_ASSERTED_STAGE = "release-review-completed"
GIT = Path("/usr/bin/git")
TCR_REQUIRED_HEADINGS = ("Requested scope", "Contract comparison", "User decision")
TCR_REQUIRED_FIELDS = (
    "Request reference",
    "Test IDs",
    "Exact repository paths (JSON array)",
    "Change type",
    "Why this scope is necessary",
    "Existing invariant and fact source",
    "Evidence that the existing test is obsolete or incorrect",
    "Proposed invariant and fact source",
    "Exact pass/fail boundary change",
    "Replacement coverage or reason no replacement is valid",
    "Runtime, compatibility, and cross-layer impact",
    "Decision",
    "Approved paths and intent",
    "Explicit exclusions",
    "Approver",
    "Decision timestamp",
)
TCR_CHANGE_TYPES = {
    "add",
    "replace",
    "expectation-change",
    "fixture-change",
    "remove",
    "rename",
    "runner",
    "policy",
}


class GateError(Exception):
    """Invalid policy, Git input, or release-review evidence."""


class ReviewError(Exception):
    """A release review record is missing, stale, malformed, or out of scope."""


class DuplicateJsonKey(ValueError):
    """A JSON object contains the same member name more than once."""


def strict_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKey(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def git_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    environment["GIT_NO_REPLACE_OBJECTS"] = "1"
    return environment


def canonical_json(value: Any) -> bytes:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise GateError(f"cannot encode canonical JSON: {error}") from error
    return encoded.encode("ascii") + b"\n"


def run_git(root: Path, *args: str, text: bool = False) -> bytes | str:
    try:
        completed = subprocess.run(
            [str(GIT), *args],
            cwd=root,
            env=git_environment(),
            check=True,
            capture_output=True,
            text=text,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        detail = ""
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            stderr = error.stderr
            detail = stderr.strip() if isinstance(stderr, str) else stderr.decode(errors="replace").strip()
        suffix = f": {detail}" if detail else ""
        raise GateError(f"git {' '.join(args)} failed{suffix}") from error
    return completed.stdout


def resolve_commit(root: Path, value: str, field: str) -> str:
    output = run_git(root, "rev-parse", "--verify", f"{value}^{{commit}}", text=True)
    assert isinstance(output, str)
    resolved = output.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", resolved):
        raise GateError(f"{field} did not resolve to a full commit SHA")
    return resolved


def validate_branch_ref(root: Path, value: str | None, field: str) -> str:
    if value is None or not value:
        raise GateError(f"{field} is required")
    completed = subprocess.run(
        [str(GIT), "check-ref-format", "--branch", value],
        cwd=root,
        env=git_environment(),
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0 or completed.stdout.rstrip("\n") != value:
        raise GateError(f"{field} is not a canonical branch name: {value!r}")
    return value


def repository_identity(root: Path) -> str:
    completed = subprocess.run(
        [str(GIT), "config", "--get", "remote.origin.url"],
        cwd=root,
        env=git_environment(),
        check=False,
        capture_output=True,
        text=True,
    )
    origin = completed.stdout.strip() if completed.returncode == 0 else ""
    if not origin:
        origin = f"local:{root}"
    elif "://" in origin:
        parsed = urlsplit(origin)
        host = parsed.hostname or ""
        if parsed.port is not None:
            host = f"{host}:{parsed.port}"
        origin = urlunsplit((parsed.scheme.lower(), host.lower(), parsed.path, "", ""))
    elif "@" in origin:
        origin = origin.split("@", 1)[1]
    return hashlib.sha256(origin.encode("utf-8")).hexdigest()


def load_json_bytes(raw: bytes, source: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=strict_json_object)
    except (UnicodeDecodeError, json.JSONDecodeError, DuplicateJsonKey) as error:
        raise GateError(f"invalid UTF-8 JSON in {source}: {error}") from error
    if not isinstance(value, dict):
        raise GateError(f"{source} must contain a JSON object")
    return value


def load_policy(
    root: Path, policy_ref: str, policy_file: Path | None, *, verify_mode: bool
) -> tuple[dict[str, Any], str, str]:
    if policy_file is not None:
        if verify_mode:
            raise GateError("verify mode requires policy loaded from the trusted target commit")
        try:
            raw = policy_file.read_bytes()
        except OSError as error:
            raise GateError(f"cannot read policy file {policy_file}: {error}") from error
        source = str(policy_file)
    else:
        try:
            raw_value = run_git(root, "show", f"{policy_ref}:{POLICY_PATH}")
        except GateError as error:
            raise GateError(
                f"trusted target {policy_ref} does not contain {POLICY_PATH}; "
                "test-governance bootstrap requires explicit user review"
            ) from error
        assert isinstance(raw_value, bytes)
        raw = raw_value
        source = f"{policy_ref}:{POLICY_PATH}"

    policy = load_json_bytes(raw, source)
    validate_policy(policy)
    return policy, hashlib.sha256(raw).hexdigest(), source


def validate_rule_list(policy: dict[str, Any], field: str, pattern_field: str) -> None:
    rules = policy.get(field, [])
    if not isinstance(rules, list):
        raise GateError(f"policy {field} must be an array")
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise GateError(f"policy {field}[{index}] must be an object")
        rule_id = rule.get("id")
        if not isinstance(rule_id, str) or not rule_id:
            raise GateError(f"policy {field}[{index}].id must be a non-empty string")
        patterns = rule.get(pattern_field)
        if not isinstance(patterns, list) or not patterns or not all(
            isinstance(pattern, str) and pattern for pattern in patterns
        ):
            raise GateError(f"policy {field}[{index}].{pattern_field} must contain strings")


def validate_policy(policy: dict[str, Any]) -> None:
    if policy.get("schemaVersion") != 2:
        raise GateError("unsupported protected-path policy schemaVersion")
    validate_rule_list(policy, "categories", "pathPatterns")
    validate_rule_list(policy, "changedLineRules", "pathPatterns")
    validate_rule_list(policy, "inlineTestRules", "pathPatterns")
    seen: set[str] = set()
    for field in ("categories", "changedLineRules", "inlineTestRules"):
        for rule in policy.get(field, []):
            if rule["id"] in seen:
                raise GateError(f"duplicate policy rule id: {rule['id']}")
            seen.add(rule["id"])
            regex_field = "linePatterns" if field == "changedLineRules" else "markerPatterns"
            if field != "categories":
                regexes = rule.get(regex_field)
                if not isinstance(regexes, list) or not regexes or not all(
                    isinstance(pattern, str) and pattern for pattern in regexes
                ):
                    raise GateError(f"policy rule {rule['id']} requires {regex_field}")
                try:
                    for pattern in regexes:
                        re.compile(pattern)
                except re.error as error:
                    raise GateError(f"invalid regex in policy rule {rule['id']}: {error}") from error

    review_policy = policy.get("releaseReview")
    if not isinstance(review_policy, dict):
        raise GateError("policy releaseReview must be an object")
    expected_fields = {
        "type",
        "defaultLifetimeSeconds",
        "maxLifetimeSeconds",
        "clockSkewSeconds",
    }
    if set(review_policy) != expected_fields:
        raise GateError(
            "policy releaseReview fields must be exactly: "
            + ", ".join(sorted(expected_fields))
        )
    if review_policy.get("type") != REVIEW_MODEL:
        raise GateError(f"policy releaseReview.type must be {REVIEW_MODEL!r}")
    default_lifetime = review_policy.get("defaultLifetimeSeconds")
    maximum_lifetime = review_policy.get("maxLifetimeSeconds")
    clock_skew = review_policy.get("clockSkewSeconds")
    if not isinstance(default_lifetime, int) or isinstance(default_lifetime, bool):
        raise GateError("policy releaseReview.defaultLifetimeSeconds must be an integer")
    if not isinstance(maximum_lifetime, int) or isinstance(maximum_lifetime, bool):
        raise GateError("policy releaseReview.maxLifetimeSeconds must be an integer")
    if not isinstance(clock_skew, int) or isinstance(clock_skew, bool):
        raise GateError("policy releaseReview.clockSkewSeconds must be an integer")
    if not 60 <= default_lifetime <= maximum_lifetime <= 604800:
        raise GateError(
            "policy release review lifetimes must satisfy 60 <= defaultLifetimeSeconds "
            "<= maxLifetimeSeconds <= 604800"
        )
    if not 0 <= clock_skew <= 600:
        raise GateError("policy releaseReview.clockSkewSeconds must be between 0 and 600")


def path_matches(path: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if fnmatch.fnmatchcase(path, pattern):
            return True
        if pattern.startswith("**/") and fnmatch.fnmatchcase(path, pattern[3:]):
            return True
    return False


def parse_name_status(raw: bytes) -> list[dict[str, Any]]:
    fields = raw.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    changes: list[dict[str, Any]] = []
    index = 0
    while index < len(fields):
        status_token = fields[index].decode("ascii", errors="strict")
        index += 1
        action = status_token[:1]
        if action in {"R", "C"}:
            if index + 1 >= len(fields):
                raise GateError("truncated rename/copy record from git diff")
            old_path = fields[index].decode("utf-8", errors="surrogateescape")
            new_path = fields[index + 1].decode("utf-8", errors="surrogateescape")
            index += 2
        else:
            if index >= len(fields):
                raise GateError("truncated path record from git diff")
            path = fields[index].decode("utf-8", errors="surrogateescape")
            index += 1
            old_path = None if action == "A" else path
            new_path = None if action == "D" else path
        changes.append(
            {
                "status": status_token,
                "action": action,
                "oldPath": old_path,
                "newPath": new_path,
            }
        )
    return changes


def git_entry(root: Path, commit: str, path: str | None) -> dict[str, Any] | None:
    if path is None:
        return None
    raw = run_git(root, "ls-tree", "-z", commit, "--", path)
    assert isinstance(raw, bytes)
    exact: tuple[str, str, str] | None = None
    for record in raw.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", 1)
            mode, object_type, object_id = metadata.decode("ascii").split(" ", 2)
        except ValueError as error:
            raise GateError(f"invalid git ls-tree record for {path}") from error
        candidate = raw_path.decode("utf-8", errors="surrogateescape")
        if candidate == path:
            exact = (mode, object_type, object_id)
            break
    if exact is None:
        raise GateError(f"expected path is missing from {commit}: {path}")
    mode, object_type, object_id = exact
    content = run_git(root, "cat-file", "-p", object_id)
    assert isinstance(content, bytes)
    return {
        "mode": mode,
        "objectType": object_type,
        "objectId": object_id,
        "content": content,
    }


def entry_field(entry: dict[str, Any] | None, field: str) -> Any:
    return None if entry is None else entry[field]


def entry_content_digest(entry: dict[str, Any] | None) -> str | None:
    return None if entry is None else hashlib.sha256(entry["content"]).hexdigest()


def release_review_policy(policy: dict[str, Any]) -> dict[str, Any]:
    review_policy = policy["releaseReview"]
    assert isinstance(review_policy, dict)
    return review_policy


def changed_lines(root: Path, target: str, head: str, paths: list[str]) -> list[str]:
    raw = run_git(
        root,
        "diff",
        "--unified=0",
        "--text",
        "--no-textconv",
        "--no-ext-diff",
        f"{target}...{head}",
        "--",
        *paths,
    )
    assert isinstance(raw, bytes)
    result: list[str] = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        if line.startswith(("+++", "---")):
            continue
        if line.startswith(("+", "-")):
            result.append(line[1:])
    return result


def json_test_surface(path: str, value: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"invalidJsonSha256": hashlib.sha256(value).hexdigest()}
    if not isinstance(parsed, dict):
        return {"value": parsed}

    name = Path(path).name
    if name == "package.json":
        script_pattern = re.compile(r"(?i)(test|smoke|check|verify|lint)")
        dependency_pattern = re.compile(
            r"(?i)(vitest|jest|mocha|ava|tap|playwright|cypress|testing-library|test)"
        )
        scripts = parsed.get("scripts", {})
        dev_dependencies = parsed.get("devDependencies", {})
        return {
            "scripts": {
                key: value
                for key, value in scripts.items()
                if isinstance(key, str) and script_pattern.search(key)
            }
            if isinstance(scripts, dict)
            else scripts,
            "testDevDependencies": {
                key: value
                for key, value in dev_dependencies.items()
                if isinstance(key, str) and dependency_pattern.search(key)
            }
            if isinstance(dev_dependencies, dict)
            else dev_dependencies,
        }
    if name.startswith("tsconfig") and name.endswith(".json"):
        compiler_options = parsed.get("compilerOptions", {})
        selected_options = {}
        if isinstance(compiler_options, dict):
            for key in ("outDir", "rootDir", "types", "typeRoots", "noEmit"):
                if key in compiler_options:
                    selected_options[key] = compiler_options[key]
        return {
            "files": parsed.get("files"),
            "include": parsed.get("include"),
            "exclude": parsed.get("exclude"),
            "references": parsed.get("references"),
            "compilerOptions": selected_options,
        }
    return {}


def make_test_surface(value: bytes) -> list[str]:
    lines = value.decode("utf-8", errors="replace").splitlines()
    keyword = re.compile(r"(?i)(^|[-_.])(test|tests|smoke|check|verify|lint)([-_.]|$)")
    target = re.compile(r"^([^#\t][^:=]*):(?!=)")
    assignment = re.compile(r"^([A-Za-z0-9_.-]+)\s*(?::|\?|\+)?=")
    result: list[str] = []
    include_block = False
    continuation = False
    for line in lines:
        target_match = target.match(line)
        assignment_match = assignment.match(line)
        if target_match:
            names = target_match.group(1).split()
            include_block = any(keyword.search(name) for name in names)
        elif assignment_match and not line.startswith((" ", "\t")):
            include_block = bool(keyword.search(assignment_match.group(1)))
        elif not line.startswith((" ", "\t")) and not continuation:
            include_block = False
        if include_block:
            result.append(line)
        continuation = line.rstrip().endswith("\\") and include_block
    return result


def cargo_test_surface(value: bytes) -> list[str]:
    lines = value.decode("utf-8", errors="replace").splitlines()
    section = re.compile(r"^\s*(\[\[?[^]]+\]\]?)\s*$")
    relevant = re.compile(r"(?i)(dev-dependencies|\[\[(test|bench)\]\])")
    result: list[str] = []
    include_section = False
    for line in lines:
        match = section.match(line)
        if match:
            include_section = bool(relevant.search(match.group(1)))
        if include_section:
            result.append(line)
    return result


def test_command_surface(path: str | None, value: bytes | None) -> bytes | None:
    if path is None or value is None:
        return None
    name = Path(path).name
    if name == "Makefile":
        surface: Any = make_test_surface(value)
    elif name == "Cargo.toml":
        surface = cargo_test_surface(value)
    elif name == "package.json" or (name.startswith("tsconfig") and name.endswith(".json")):
        surface = json_test_surface(path, value)
    else:
        return b""
    return json.dumps(surface, ensure_ascii=False, sort_keys=True).encode("utf-8")


def inline_test_surface(value: bytes | None, marker_patterns: list[str]) -> bytes | None:
    if value is None:
        return None
    text = value.decode("utf-8", errors="replace")
    lines = text.splitlines(keepends=True)
    compiled = [re.compile(pattern) for pattern in marker_patterns]
    for index, line in enumerate(lines):
        if any(pattern.search(line) for pattern in compiled):
            return "".join(lines[index:]).encode("utf-8")
    return b""


def classify_changes(
    root: Path, target: str, head: str, policy: dict[str, Any]
) -> list[dict[str, Any]]:
    raw = run_git(root, "diff", "--name-status", "-z", "--find-renames", f"{target}...{head}")
    assert isinstance(raw, bytes)
    changes = parse_name_status(raw)
    classified: list[dict[str, Any]] = []

    for change in changes:
        paths = [path for path in (change["oldPath"], change["newPath"]) if path is not None]
        old_entry = git_entry(root, target, change["oldPath"])
        new_entry = git_entry(root, head, change["newPath"])
        old_bytes = entry_field(old_entry, "content")
        new_bytes = entry_field(new_entry, "content")
        categories: set[str] = set()
        for rule in policy["categories"]:
            if any(path_matches(path, rule["pathPatterns"]) for path in paths):
                categories.add(rule["id"])

        lines: list[str] | None = None
        for rule in policy.get("changedLineRules", []):
            if not any(path_matches(path, rule["pathPatterns"]) for path in paths):
                continue
            if lines is None:
                lines = changed_lines(root, target, head, paths)
            regexes = [re.compile(pattern) for pattern in rule["linePatterns"]]
            if any(regex.search(line) for regex in regexes for line in lines):
                categories.add(rule["id"])
            elif rule["id"] == "test-command":
                old_surface = test_command_surface(change["oldPath"], old_bytes)
                new_surface = test_command_surface(change["newPath"], new_bytes)
                if old_surface != new_surface and (
                    old_surface not in {None, b"[]", b"{}"}
                    or new_surface not in {None, b"[]", b"{}"}
                ):
                    categories.add(rule["id"])

        for rule in policy.get("inlineTestRules", []):
            if not any(path_matches(path, rule["pathPatterns"]) for path in paths):
                continue
            old_surface = inline_test_surface(old_bytes, rule["markerPatterns"])
            new_surface = inline_test_surface(new_bytes, rule["markerPatterns"])
            if old_surface != new_surface and (old_surface not in {None, b""} or new_surface not in {None, b""}):
                categories.add(rule["id"])

        classified.append(
            {
                **change,
                "categories": sorted(categories),
                "protected": bool(categories),
                "oldMode": entry_field(old_entry, "mode"),
                "newMode": entry_field(new_entry, "mode"),
                "oldObjectType": entry_field(old_entry, "objectType"),
                "newObjectType": entry_field(new_entry, "objectType"),
                "oldObjectId": entry_field(old_entry, "objectId"),
                "newObjectId": entry_field(new_entry, "objectId"),
                "oldSha256": entry_content_digest(old_entry),
                "newSha256": entry_content_digest(new_entry),
            }
        )
    return classified


PROTECTED_CHANGE_FIELDS = (
    "status",
    "action",
    "oldPath",
    "newPath",
    "categories",
    "oldMode",
    "newMode",
    "oldObjectType",
    "newObjectType",
    "oldObjectId",
    "newObjectId",
    "oldSha256",
    "newSha256",
)


def protected_manifest(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    manifest = [
        {field: change[field] for field in PROTECTED_CHANGE_FIELDS}
        for change in changes
        if change["protected"]
    ]
    return sorted(
        manifest,
        key=lambda change: (
            change["newPath"] or "",
            change["oldPath"] or "",
            change["status"],
        ),
    )


def protected_digest(
    repository_id: str,
    target_ref: str,
    head_ref: str,
    target: str,
    head: str,
    policy_digest: str,
    gate_digest: str,
    changes: list[dict[str, Any]],
) -> str:
    canonical = {
        "repositoryId": repository_id,
        "targetRef": target_ref,
        "headRef": head_ref,
        "targetSha": target,
        "headSha": head,
        "policySha256": policy_digest,
        "gateSha256": gate_digest,
        "protectedChanges": protected_manifest(changes),
    }
    return hashlib.sha256(canonical_json(canonical)).hexdigest()


def load_external_bytes(path: Path, root: Path, label: str, maximum_size: int) -> bytes:
    expanded = path.expanduser()
    if not expanded.is_absolute():
        raise ReviewError(f"{label} path must be absolute")
    if expanded.is_symlink():
        raise ReviewError(f"{label} must not be a symbolic link")
    try:
        resolved = expanded.resolve(strict=True)
    except OSError as error:
        raise ReviewError(f"cannot resolve {label} {expanded}: {error}") from error
    forbidden_roots = {root.resolve()}
    common_dir = run_git(root, "rev-parse", "--path-format=absolute", "--git-common-dir", text=True)
    assert isinstance(common_dir, str)
    forbidden_roots.add(Path(common_dir.strip()).resolve())
    worktrees = run_git(root, "worktree", "list", "--porcelain", "-z")
    assert isinstance(worktrees, bytes)
    for field in worktrees.split(b"\0"):
        if field.startswith(b"worktree "):
            worktree_path = field.removeprefix(b"worktree ").decode(
                "utf-8", errors="surrogateescape"
            )
            forbidden_roots.add(Path(worktree_path).resolve())
    for forbidden_root in forbidden_roots:
        try:
            resolved.relative_to(forbidden_root)
        except ValueError:
            continue
        raise ReviewError(f"{label} must be outside every Git worktree and Git metadata directory")
    if not resolved.is_file():
        raise ReviewError(f"{label} must be a regular file: {resolved}")
    metadata = resolved.stat()
    if metadata.st_uid != os.getuid():
        raise ReviewError(f"{label} must be owned by the current user")
    if metadata.st_mode & 0o022:
        raise ReviewError(f"{label} must not be group- or world-writable")
    try:
        raw = resolved.read_bytes()
    except OSError as error:
        raise ReviewError(f"cannot read {label} {resolved}: {error}") from error
    if len(raw) > maximum_size:
        raise ReviewError(f"{label} exceeds the {maximum_size}-byte limit")
    return raw


def validate_test_change_request(raw: bytes, payload: dict[str, Any]) -> None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ReviewError(f"Test Change Request must be valid UTF-8: {error}") from error
    if not text.strip():
        raise ReviewError("Test Change Request must not be empty")
    if "\x00" in text:
        raise ReviewError("Test Change Request must not contain NUL bytes")

    normalized_lines = [line.strip() for line in text.splitlines()]
    for heading in TCR_REQUIRED_HEADINGS:
        if normalized_lines.count(f"## {heading}") != 1:
            raise ReviewError(
                f"Test Change Request must contain exactly one '## {heading}' heading"
            )

    values: dict[str, str] = {}
    for field in TCR_REQUIRED_FIELDS:
        matches = re.findall(
            rf"(?m)^-[ \t]+{re.escape(field)}:[ \t]*(.*?)[ \t]*$",
            text,
        )
        if len(matches) != 1:
            raise ReviewError(
                f"Test Change Request must contain exactly one non-empty '{field}' field"
            )
        value = matches[0].strip()
        if not value:
            raise ReviewError(f"Test Change Request field '{field}' must not be empty")
        values[field] = value

    if values["Decision"] != "approved":
        raise ReviewError("Test Change Request Decision must be exactly 'approved'")
    if values["Change type"].casefold() not in TCR_CHANGE_TYPES:
        raise ReviewError(
            "Test Change Request Change type must be one of: "
            + ", ".join(sorted(TCR_CHANGE_TYPES))
        )

    path_field = "Exact repository paths (JSON array)"
    try:
        approved_paths_value = json.loads(values[path_field])
    except json.JSONDecodeError as error:
        raise ReviewError(f"Test Change Request {path_field} is invalid JSON: {error}") from error
    if not isinstance(approved_paths_value, list) or not approved_paths_value:
        raise ReviewError(f"Test Change Request {path_field} must be a non-empty array")
    approved_paths: set[str] = set()
    for index, approved_path in enumerate(approved_paths_value):
        if not isinstance(approved_path, str) or not approved_path:
            raise ReviewError(
                f"Test Change Request {path_field}[{index}] must be a non-empty string"
            )
        canonical_path = str(PurePosixPath(approved_path))
        if (
            approved_path.startswith("/")
            or approved_path.endswith("/")
            or "\\" in approved_path
            or canonical_path != approved_path
            or canonical_path == "."
            or any(part in {"", ".", ".."} for part in PurePosixPath(approved_path).parts)
            or any(ord(character) < 32 for character in approved_path)
        ):
            raise ReviewError(
                f"Test Change Request {path_field}[{index}] is not a canonical repository-relative POSIX path"
            )
        if approved_path in approved_paths:
            raise ReviewError(f"Test Change Request {path_field} contains duplicate paths")
        approved_paths.add(approved_path)

    protected_paths = {
        path
        for change in payload["protectedChanges"]
        for path in (change["oldPath"], change["newPath"])
        if path is not None
    }
    uncovered = protected_paths.difference(approved_paths)
    if uncovered:
        raise ReviewError(
            "Test Change Request exact paths do not cover protected change paths: "
            + ", ".join(sorted(uncovered))
        )


def load_review_record(raw: bytes) -> dict[str, Any]:
    try:
        return load_json_bytes(raw, "release review record")
    except GateError as error:
        raise ReviewError(str(error)) from error


def format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        raise ReviewError(f"release review record {field} must be canonical UTC RFC3339")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ReviewError(f"release review record {field} is not a valid timestamp") from error


def fixed_review_fields(
    payload: dict[str, Any],
    test_change_request_digest: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": REVIEW_RECORD_SCHEMA_VERSION,
        "recordType": REVIEW_RECORD_TYPE,
        "workflowModel": REVIEW_WORKFLOW_MODEL,
        "authentication": REVIEW_AUTHENTICATION,
        "authorizationProof": REVIEW_AUTHORIZATION_PROOF,
        "sessionIndependenceProof": REVIEW_SESSION_INDEPENDENCE_PROOF,
        "assertedWorkflowStage": REVIEW_ASSERTED_STAGE,
        "repositoryId": payload["repositoryId"],
        "targetRef": payload["targetRef"],
        "headRef": payload["headRef"],
        "targetSha": payload["targetSha"],
        "headSha": payload["headSha"],
        "protectedDigest": payload["protectedDigest"],
        "policySha256": payload["policySha256"],
        "gateSha256": payload["gateSha256"],
        "categories": payload["categories"],
        "protectedChanges": payload["protectedChanges"],
        "testChangeRequestSha256": test_change_request_digest,
    }


def validate_audit_reference(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > 512
        or any(ord(character) < 32 for character in value)
    ):
        raise ReviewError(f"release review record {field} is invalid")
    return value


def build_review_record(
    payload: dict[str, Any],
    review_policy: dict[str, Any],
    test_change_request_digest: str,
    development_session_ref: str,
    user_decision_ref: str,
    release_session_ref: str,
    valid_seconds: int,
    now: datetime,
) -> dict[str, Any]:
    validate_audit_reference(development_session_ref, "developmentSessionRef")
    validate_audit_reference(user_decision_ref, "userDecisionRef")
    validate_audit_reference(release_session_ref, "releaseSessionRef")
    if development_session_ref == release_session_ref:
        raise ReviewError(
            "developmentSessionRef and releaseSessionRef must differ as a workflow assertion"
        )
    if not 60 <= valid_seconds <= review_policy["maxLifetimeSeconds"]:
        raise GateError(
            f"valid-seconds must be between 60 and {review_policy['maxLifetimeSeconds']}"
        )
    recorded_at = now.astimezone(timezone.utc).replace(microsecond=0)
    record = fixed_review_fields(payload, test_change_request_digest)
    record.update(
        {
            "developmentSessionRef": development_session_ref,
            "userDecisionRef": user_decision_ref,
            "releaseSessionRef": release_session_ref,
            "recordedAt": format_utc(recorded_at),
            "expiresAt": format_utc(recorded_at + timedelta(seconds=valid_seconds)),
        }
    )
    return record


def validate_review_record(
    raw: bytes,
    record: dict[str, Any],
    payload: dict[str, Any],
    review_policy: dict[str, Any],
    test_change_request_digest: str,
    now: datetime,
) -> None:
    expected = fixed_review_fields(payload, test_change_request_digest)
    for field, value in expected.items():
        if record.get(field) != value:
            raise ReviewError(f"release review record {field} mismatch: expected {value!r}")
    expected_keys = set(expected) | {
        "developmentSessionRef",
        "userDecisionRef",
        "releaseSessionRef",
        "recordedAt",
        "expiresAt",
    }
    if set(record) != expected_keys:
        raise ReviewError("release review record contains missing or unsupported fields")
    development_session_ref = validate_audit_reference(
        record.get("developmentSessionRef"), "developmentSessionRef"
    )
    validate_audit_reference(record.get("userDecisionRef"), "userDecisionRef")
    release_session_ref = validate_audit_reference(
        record.get("releaseSessionRef"), "releaseSessionRef"
    )
    if development_session_ref == release_session_ref:
        raise ReviewError(
            "developmentSessionRef and releaseSessionRef must differ as a workflow assertion"
        )
    if raw != canonical_json(record):
        raise ReviewError("release review record is not in canonical JSON form")

    recorded_at = parse_utc(record.get("recordedAt"), "recordedAt")
    expires_at = parse_utc(record.get("expiresAt"), "expiresAt")
    if expires_at <= recorded_at:
        raise ReviewError("release review record expiresAt must be later than recordedAt")
    if (expires_at - recorded_at).total_seconds() > review_policy["maxLifetimeSeconds"]:
        raise ReviewError("release review record lifetime exceeds the trusted policy maximum")
    clock_skew = timedelta(seconds=review_policy["clockSkewSeconds"])
    if recorded_at > now + clock_skew:
        raise ReviewError("release review record recordedAt is in the future")
    if now >= expires_at:
        raise ReviewError("release review record has expired")


def result_payload(
    repository_id: str,
    target_ref: str,
    head_ref: str,
    target: str,
    head: str,
    policy_digest: str,
    policy_source: str,
    gate_digest: str,
    changes: list[dict[str, Any]],
) -> dict[str, Any]:
    protected = [change for change in changes if change["protected"]]
    categories = sorted({category for change in protected for category in change["categories"]})
    digest = protected_digest(
        repository_id,
        target_ref,
        head_ref,
        target,
        head,
        policy_digest,
        gate_digest,
        changes,
    )
    return {
        "schemaVersion": 1,
        "repositoryId": repository_id,
        "targetRef": target_ref,
        "headRef": head_ref,
        "targetSha": target,
        "headSha": head,
        "policySource": policy_source,
        "policySha256": policy_digest,
        "gateSha256": gate_digest,
        "protectedDigest": digest,
        "categories": categories,
        "protectedChangeCount": len(protected),
        "protectedChanges": protected_manifest(changes),
        "changes": changes,
    }


def emit(payload: dict[str, Any], *, json_mode: bool, quiet: bool) -> None:
    if quiet:
        return
    if json_mode:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return
    print(
        "test-change classification: "
        f"protected={payload['protectedChangeCount']} "
        f"categories={','.join(payload['categories']) or 'none'} "
        f"digest={payload['protectedDigest']}"
    )
    for change in payload["changes"]:
        if change["protected"]:
            path = change["newPath"] or change["oldPath"]
            print(f"  {change['status']} {path}: {','.join(change['categories'])}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("classify", "record-release-review", "verify"))
    parser.add_argument("--repository", default=".")
    parser.add_argument("--target-ref", required=True)
    parser.add_argument("--head-ref", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--policy-ref")
    parser.add_argument("--policy-file")
    parser.add_argument("--test-change-request")
    parser.add_argument("--test-release-review")
    parser.add_argument("--development-session-ref")
    parser.add_argument("--user-decision-ref")
    parser.add_argument("--release-session-ref")
    parser.add_argument("--valid-seconds", type=int)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.repository).resolve()
    if not (root / ".git").exists():
        raise GateError(f"not a Git worktree: {root}")
    target_ref = validate_branch_ref(root, args.target_ref, "target-ref")
    head_ref = validate_branch_ref(root, args.head_ref, "head-ref")
    target = resolve_commit(root, args.target, "target")
    head = resolve_commit(root, args.head, "head")
    ancestor = subprocess.run(
        [str(GIT), "merge-base", "--is-ancestor", target, head],
        cwd=root,
        env=git_environment(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if ancestor.returncode != 0:
        raise GateError("target must be an ancestor of head")

    policy_ref = resolve_commit(root, args.policy_ref or target, "policy-ref")
    if args.mode in {"record-release-review", "verify"} and policy_ref != target:
        raise GateError(f"{args.mode} mode requires policy-ref to equal the exact target SHA")
    policy_file = Path(args.policy_file).resolve() if args.policy_file else None
    policy, policy_digest, policy_source = load_policy(
        root,
        policy_ref,
        policy_file,
        verify_mode=args.mode in {"record-release-review", "verify"},
    )
    try:
        gate_value = run_git(root, "show", f"{target}:scripts/test-change-gate.py")
    except GateError:
        if args.mode != "classify" or policy_file is None:
            raise
        gate_value = Path(__file__).read_bytes()
    assert isinstance(gate_value, bytes)
    gate_digest = hashlib.sha256(gate_value).hexdigest()
    repository_id = repository_identity(root)
    changes = classify_changes(root, target, head, policy)
    payload = result_payload(
        repository_id,
        target_ref,
        head_ref,
        target,
        head,
        policy_digest,
        policy_source,
        gate_digest,
        changes,
    )

    if args.mode == "classify":
        if any(
            value is not None
            for value in (
                args.test_change_request,
                args.test_release_review,
                args.development_session_ref,
                args.user_decision_ref,
                args.release_session_ref,
                args.valid_seconds,
            )
        ):
            raise GateError("classify mode does not accept release review arguments")
        emit(payload, json_mode=args.json, quiet=args.quiet)
        return 0

    review_policy = release_review_policy(policy)
    if args.mode == "record-release-review":
        if args.json or args.quiet:
            raise GateError(
                "record-release-review mode emits canonical JSON and does not accept --json or --quiet"
            )
        if args.test_release_review:
            raise GateError(
                "record-release-review mode does not accept an existing review record"
            )
        if (
            not args.test_change_request
            or not args.development_session_ref
            or not args.user_decision_ref
            or not args.release_session_ref
        ):
            raise GateError(
                "record-release-review mode requires --test-change-request, "
                "--development-session-ref, --user-decision-ref, and --release-session-ref"
            )
        if payload["protectedChangeCount"] == 0:
            raise GateError("no protected test change requires a release review record")
        tcr_raw = load_external_bytes(
            Path(args.test_change_request), root, "Test Change Request", 1024 * 1024
        )
        validate_test_change_request(tcr_raw, payload)
        valid_seconds = (
            args.valid_seconds
            if args.valid_seconds is not None
            else review_policy["defaultLifetimeSeconds"]
        )
        record = build_review_record(
            payload,
            review_policy,
            hashlib.sha256(tcr_raw).hexdigest(),
            args.development_session_ref,
            args.user_decision_ref,
            args.release_session_ref,
            valid_seconds,
            datetime.now(timezone.utc),
        )
        sys.stdout.buffer.write(canonical_json(record))
        return 0

    supplied = (
        args.test_change_request,
        args.test_release_review,
    )
    if (
        args.development_session_ref is not None
        or args.user_decision_ref is not None
        or args.release_session_ref is not None
        or args.valid_seconds is not None
    ):
        raise GateError(
            "verify mode does not accept --development-session-ref, --user-decision-ref, "
            "--release-session-ref, or --valid-seconds"
        )
    if payload["protectedChangeCount"] == 0:
        if any(supplied):
            raise ReviewError(
                "release review artifacts were supplied for a diff with no protected test change"
            )
        emit(payload, json_mode=args.json, quiet=args.quiet)
        return 0
    if not any(supplied):
        print(
            "test-change-user-review-required: "
            f"head={head} target={target} digest={payload['protectedDigest']} "
            f"categories={','.join(payload['categories'])}",
            file=sys.stderr,
        )
        return 3
    if not all(supplied):
        raise ReviewError(
            "protected changes require --test-change-request and --test-release-review together"
        )
    tcr_raw = load_external_bytes(
        Path(args.test_change_request), root, "Test Change Request", 1024 * 1024
    )
    validate_test_change_request(tcr_raw, payload)
    record_raw = load_external_bytes(
        Path(args.test_release_review), root, "release review record", 2 * 1024 * 1024
    )
    record = load_review_record(record_raw)
    verification_time = datetime.now(timezone.utc).replace(microsecond=0)
    validate_review_record(
        record_raw,
        record,
        payload,
        review_policy,
        hashlib.sha256(tcr_raw).hexdigest(),
        verification_time,
    )
    emit(payload, json_mode=args.json, quiet=args.quiet)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GateError as error:
        print(f"test-change-gate-error: {error}", file=sys.stderr)
        raise SystemExit(2)
    except ReviewError as error:
        print(f"test-change-review-invalid: {error}", file=sys.stderr)
        raise SystemExit(3)
