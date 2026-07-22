#!/usr/bin/env python3
"""Focused host-safe contracts for the registry test controller."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]
CONTROLLER_PATH = ROOT / "scripts" / "test-controller.py"
REGISTRY_PATH = ROOT / "tests" / "registry.json"


def load_controller():
    spec = importlib.util.spec_from_file_location("deepcode_test_controller", CONTROLLER_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load test controller")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_registry_and_selection(controller) -> None:
    data, digest = controller.load_registry(REGISTRY_PATH)
    suites = controller.validate_registry(data, ROOT)
    assert len(digest) == 64
    assert data["defaultProfile"] == "required"
    assert set(suites) == {"repository.static", "repository.legacy"}

    default_args = argparse.Namespace(profile=None, suite=None)
    suite_ids, selected_by = controller.select_suite_ids(data, suites, default_args)
    assert suite_ids == ["repository.legacy"]
    assert selected_by == "profile:required"

    static_args = argparse.Namespace(profile="static", suite=None)
    suite_ids, selected_by = controller.select_suite_ids(data, suites, static_args)
    assert suite_ids == ["repository.static"]
    assert selected_by == "profile:static"

    weakened = copy.deepcopy(data)
    weakened["defaultProfile"] = "static"
    try:
        controller.validate_registry(weakened, ROOT)
    except controller.ControllerError as error:
        assert "defaultProfile" in str(error)
    else:
        raise AssertionError("weakened default profile was accepted")

    weakened_governance = copy.deepcopy(data)
    weakened_governance["governance"]["testChangesRequireUserApproval"] = False
    try:
        controller.validate_registry(weakened_governance, ROOT)
    except controller.ControllerError as error:
        assert "testChangesRequireUserApproval" in str(error)
    else:
        raise AssertionError("disabled test-change user review was accepted")

    self_declared_review = copy.deepcopy(data)
    self_declared_review["governance"]["reviewModel"] = "self-declared-identity"
    try:
        controller.validate_registry(self_declared_review, ROOT)
    except controller.ControllerError as error:
        assert "reviewModel" in str(error)
    else:
        raise AssertionError("self-declared test review model was accepted")

    omitted = copy.deepcopy(data)
    omitted["profiles"]["required"]["suites"] = ["repository.static"]
    try:
        controller.validate_registry(omitted, ROOT)
    except controller.ControllerError as error:
        assert "omits requiredGate suites" in str(error)
    else:
        raise AssertionError("requiredGate suite omission was accepted")


def assert_machine_list(controller) -> None:
    completed = subprocess.run(
        ["bash", str(ROOT / "test.sh"), "--list", "--json"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    assert payload["defaultProfile"] == "required"
    assert [suite["id"] for suite in payload["suites"]] == [
        "repository.static",
        "repository.legacy",
    ]


def assert_isolated_public_entrypoint() -> None:
    with tempfile.TemporaryDirectory(prefix="deepcode-controller-shadow.") as directory:
        repo = Path(directory)
        (repo / "scripts").mkdir()
        (repo / "tests").mkdir()
        (repo / "docs").mkdir()
        shutil.copy2(ROOT / "test.sh", repo / "test.sh")
        shutil.copy2(CONTROLLER_PATH, repo / "scripts" / "test-controller.py")
        (repo / "scripts" / "argparse.py").write_text(
            "raise SystemExit(0)\n", encoding="utf-8"
        )
        (repo / "scripts" / "json.py").write_text(
            "raise SystemExit(0)\n", encoding="utf-8"
        )
        (repo / "scripts" / "noop.sh").write_text(
            "#!/usr/bin/env bash\nexit 0\n", encoding="utf-8"
        )
        (repo / "scripts" / "noop.contract").write_text("fixture\n", encoding="utf-8")
        (repo / "scripts" / "test-change-gate.py").write_text("fixture\n", encoding="utf-8")
        (repo / "tests" / "protected-paths.json").write_text("{}\n", encoding="utf-8")
        (repo / "docs" / "test-change-request.md").write_text("fixture\n", encoding="utf-8")
        registry = {
            "schemaVersion": 1,
            "defaultProfile": "required",
            "governance": {
                "testChangesRequireUserApproval": True,
                "reviewModel": "procedural-release-task",
                "policyPath": "tests/protected-paths.json",
                "gatePath": "scripts/test-change-gate.py",
                "requestTemplatePath": "docs/test-change-request.md",
            },
            "profiles": {
                "required": {
                    "description": "Required fixture profile.",
                    "suites": ["repository.required"],
                }
            },
            "suites": [
                {
                    "id": "repository.required",
                    "description": "Required fixture suite.",
                    "layer": "cross-layer",
                    "kind": "static",
                    "owner": "repository",
                    "approvalClass": "test-runtime",
                    "requiredGate": True,
                    "transitional": False,
                    "runner": {
                        "type": "shell",
                        "path": "scripts/noop.sh",
                        "args": [],
                        "timeoutSeconds": 10,
                        "terminateGraceSeconds": 1,
                    },
                    "environment": {"container": "optional", "hostPolicy": "allowed"},
                    "resources": [],
                    "contractSources": ["scripts/noop.contract"],
                }
            ],
        }
        (repo / "tests" / "registry.json").write_text(
            json.dumps(registry) + "\n", encoding="utf-8"
        )
        subprocess.run(["git", "init", "--quiet", "--initial-branch=main"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "DeepCode Shadow Test"], cwd=repo, check=True)
        subprocess.run(
            ["git", "config", "user.email", "shadow@example.invalid"],
            cwd=repo,
            check=True,
        )
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "shadow fixture"], cwd=repo, check=True)
        completed = subprocess.run(
            ["bash", str(repo / "test.sh"), "--list", "--json"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(completed.stdout)
        assert payload["defaultProfile"] == "required"
        assert [suite["id"] for suite in payload["suites"]] == ["repository.required"]

        executed = subprocess.run(
            ["bash", str(repo / "test.sh"), "--json"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )
        receipt = json.loads(executed.stdout)
        assert receipt["status"] == "passed"
        assert receipt["authoritative"] is True
        assert receipt["results"][0]["id"] == "repository.required"


def assert_owned_process_group_cleanup(controller) -> None:
    process = subprocess.Popen(
        ["bash", "-c", "sleep 30 & wait"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 2
        while not controller.process_group_exists(process.pid):
            if time.monotonic() >= deadline:
                raise AssertionError("owned process group did not start")
            time.sleep(0.01)
        assert controller.terminate_process_group(process, 1) is True
        assert process.poll() is not None
        assert not controller.process_group_exists(process.pid)
    finally:
        if controller.process_group_exists(process.pid):
            controller.terminate_process_group(process, 0)


def assert_worktree_fingerprint(controller) -> None:
    with tempfile.TemporaryDirectory(prefix="deepcode-controller-fingerprint.") as directory:
        repo = Path(directory)
        subprocess.run(["git", "init", "--quiet", "--initial-branch=main"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "DeepCode Controller Test"], cwd=repo, check=True)
        subprocess.run(
            ["git", "config", "user.email", "controller@example.invalid"],
            cwd=repo,
            check=True,
        )
        tracked = repo / "tracked.txt"
        tracked.write_text("baseline\n", encoding="utf-8")
        subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "baseline"], cwd=repo, check=True)
        head = controller.git_output(repo, "rev-parse", "HEAD")
        clean = controller.worktree_fingerprint(repo, head)
        assert clean["dirty"] is False

        tracked.write_text("changed\n", encoding="utf-8")
        (repo / "untracked.txt").write_text("new\n", encoding="utf-8")
        dirty = controller.worktree_fingerprint(repo, head)
        assert dirty["dirty"] is True
        assert dirty["untrackedCount"] == 1
        assert dirty["sha256"] != clean["sha256"]


def main() -> None:
    controller = load_controller()
    assert_registry_and_selection(controller)
    assert_machine_list(controller)
    assert_isolated_public_entrypoint()
    assert_owned_process_group_cleanup(controller)
    assert_worktree_fingerprint(controller)
    print("[PASS] test controller contracts")


if __name__ == "__main__":
    main()
