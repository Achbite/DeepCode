#!/usr/bin/env python3
"""Focused host-safe contracts for the registry test controller."""

from __future__ import annotations

import argparse
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]
CONTROLLER_PATH = ROOT / "scripts" / "test-controller.py"
REGISTRY_PATH = ROOT / "tests" / "registry.json"
SMOKE_SUITE_IDS = [
    "session.smoke.communication",
    "session.smoke.tools",
    "session.smoke.paths",
    "session.smoke.authorization",
]
REQUIRED_SUITE_IDS = ["repository.required", "kernel.v2.contracts"]
ALL_SUITE_IDS = ["repository.static", *REQUIRED_SUITE_IDS, *SMOKE_SUITE_IDS]


def load_controller():
    spec = importlib.util.spec_from_file_location("deepcode_test_controller", CONTROLLER_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load test controller")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_suite_quiet(controller, suite):
    with open(os.devnull, "w", encoding="utf-8") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            return controller.run_suite(ROOT, suite, json_mode=False)


def assert_registry_and_selection(controller) -> None:
    data, digest = controller.load_registry(REGISTRY_PATH)
    suites = controller.validate_registry(data, ROOT)
    assert len(digest) == 64
    assert data["defaultProfile"] == "required"
    assert set(suites) == set(ALL_SUITE_IDS)

    default_args = argparse.Namespace(profile=None, suite=None)
    suite_ids, selected_by = controller.select_suite_ids(data, suites, default_args)
    assert suite_ids == REQUIRED_SUITE_IDS
    assert selected_by == "profile:required"

    static_args = argparse.Namespace(profile="static", suite=None)
    suite_ids, selected_by = controller.select_suite_ids(data, suites, static_args)
    assert suite_ids == ["repository.static"]
    assert selected_by == "profile:static"

    smoke_args = argparse.Namespace(profile="smoke", suite=None)
    suite_ids, selected_by = controller.select_suite_ids(data, suites, smoke_args)
    assert suite_ids == SMOKE_SUITE_IDS
    assert selected_by == "profile:smoke"

    full_args = argparse.Namespace(profile="full", suite=None)
    suite_ids, selected_by = controller.select_suite_ids(data, suites, full_args)
    assert suite_ids == [*REQUIRED_SUITE_IDS, *SMOKE_SUITE_IDS]
    assert selected_by == "profile:full"

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
    omitted["profiles"]["required"]["suites"] = ["repository.required"]
    try:
        controller.validate_registry(omitted, ROOT)
    except controller.ControllerError as error:
        assert "omits requiredGate suites" in str(error)
    else:
        raise AssertionError("requiredGate suite omission was accepted")

    mixed = copy.deepcopy(data)
    mixed["profiles"]["required"]["suites"].append(SMOKE_SUITE_IDS[0])
    try:
        controller.validate_registry(mixed, ROOT)
    except controller.ControllerError as error:
        assert "includes non-requiredGate suites" in str(error)
    else:
        raise AssertionError("optional suite in required profile was accepted")

    authoritative_smoke = copy.deepcopy(data)
    for suite in authoritative_smoke["suites"]:
        if suite["id"] == SMOKE_SUITE_IDS[0]:
            suite["requiredGate"] = True
            break
    authoritative_smoke["profiles"]["required"]["suites"].append(SMOKE_SUITE_IDS[0])
    try:
        controller.validate_registry(authoritative_smoke, ROOT)
    except controller.ControllerError as error:
        assert "smoke suites cannot be requiredGate" in str(error)
    else:
        raise AssertionError("authoritative smoke suite was accepted")

    omitted_smoke = copy.deepcopy(data)
    omitted_smoke["profiles"]["smoke"]["suites"] = SMOKE_SUITE_IDS[:-1]
    try:
        controller.validate_registry(omitted_smoke, ROOT)
    except controller.ControllerError as error:
        assert "every and only smoke suite" in str(error)
    else:
        raise AssertionError("smoke profile omission was accepted")

    unregistered_case = copy.deepcopy(data)
    for suite in unregistered_case["suites"]:
        if suite["id"] == "session.smoke.communication":
            suite["cases"].append({
                "id": "communication.unregistered_growth_1",
                "incidentRef": "fixture:case-budget",
                "invariant": "fixture",
                "sourcePath": "userspace/session-core/src/__tests__/smoke/communicationSmoke.ts",
            })
            suite["cases"].append({
                "id": "communication.unregistered_growth_2",
                "incidentRef": "fixture:case-budget",
                "invariant": "fixture",
                "sourcePath": "userspace/session-core/src/__tests__/smoke/communicationSmoke.ts",
            })
            break
    try:
        controller.validate_registry(unregistered_case, ROOT)
    except controller.ControllerError as error:
        assert "maxCasesPerSuite" in str(error)
    else:
        raise AssertionError("smoke suite case budget was not enforced")

    missing_case_source = copy.deepcopy(data)
    for suite in missing_case_source["suites"]:
        if suite["id"] == "session.smoke.paths":
            suite["cases"][0]["sourcePath"] = "README.md"
            break
    try:
        controller.validate_registry(missing_case_source, ROOT)
    except controller.ControllerError as error:
        assert "sourcePath must be listed" in str(error)
    else:
        raise AssertionError("unbound smoke case source was accepted")

    excess_groups = copy.deepcopy(data)
    excess_groups["governance"]["smokePolicy"]["maxSuites"] = 3
    try:
        controller.validate_registry(excess_groups, ROOT)
    except controller.ControllerError as error:
        assert "maxSuites" in str(error)
    else:
        raise AssertionError("smoke suite budget was not enforced")

    excess_total_cases = copy.deepcopy(data)
    excess_total_cases["governance"]["smokePolicy"]["maxTotalCases"] = 4
    try:
        controller.validate_registry(excess_total_cases, ROOT)
    except controller.ControllerError as error:
        assert "maxTotalCases" in str(error)
    else:
        raise AssertionError("total smoke case budget was not enforced")


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
    assert [suite["id"] for suite in payload["suites"]] == ALL_SUITE_IDS
    smoke_payloads = [suite for suite in payload["suites"] if suite["kind"] == "smoke"]
    assert [suite["group"] for suite in smoke_payloads] == [
        "communication",
        "tools",
        "paths",
        "authorization",
    ]
    assert all(suite["cases"] for suite in smoke_payloads)


def assert_registry_override_is_rejected() -> None:
    completed = subprocess.run(
        [
            "bash",
            str(ROOT / "test.sh"),
            "--registry",
            str(ROOT / "tests" / "protected-paths.json"),
            "--list",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 2
    assert "unrecognized arguments: --registry" in completed.stderr


def assert_internal_runners_are_guarded() -> None:
    environment = os.environ.copy()
    environment.pop("DEEPCODE_TEST_CONTROLLER", None)
    environment.pop("DEEPCODE_TEST_SUITE_ID", None)
    for runner, arguments, expected in (
        ("session-smoke.sh", ["communication"], "use bash ./test.sh --profile smoke"),
        ("repository-required.sh", [], "use bash ./test.sh"),
        (
            "kernel-v2-contracts.sh",
            [],
            "use bash ./test.sh --suite kernel.v2.contracts",
        ),
    ):
        completed = subprocess.run(
            ["bash", str(ROOT / "scripts" / "tests" / runner), *arguments],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 2
        assert expected in completed.stderr


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
        def fixture_suite(
            suite_id: str,
            required_gate: bool,
            *,
            kind: str = "static",
        ) -> dict[str, object]:
            suite: dict[str, object] = {
                "id": suite_id,
                "description": f"{suite_id} fixture suite.",
                "layer": "cross-layer",
                "kind": kind,
                "owner": "repository",
                "approvalClass": "test-runtime",
                "requiredGate": required_gate,
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
            if kind == "smoke":
                suite["group"] = "fixture"
                suite["cases"] = [{
                    "id": "fixture.roundtrip",
                    "incidentRef": "fixture:roundtrip",
                    "invariant": "The fixture smoke case is registry-bound.",
                    "sourcePath": "scripts/noop.contract",
                }]
            return suite

        registry = {
            "schemaVersion": 1,
            "defaultProfile": "required",
            "governance": {
                "testChangesRequireUserApproval": True,
                "reviewModel": "procedural-release-task",
                "policyPath": "tests/protected-paths.json",
                "gatePath": "scripts/test-change-gate.py",
                "requestTemplatePath": "docs/test-change-request.md",
                "smokePolicy": {
                    "scope": "runtime-path-and-historical-defects",
                    "caseRegistration": "exact-controller-handshake",
                    "maxCasesPerSuite": 3,
                    "maxSuites": 4,
                    "maxTotalCases": 5,
                },
            },
            "profiles": {
                "required": {
                    "description": "Required fixture profile.",
                    "suites": ["repository.required", "kernel.v2.contracts"],
                },
                "static": {
                    "description": "Static fixture profile.",
                    "suites": ["repository.static"],
                },
                "smoke": {
                    "description": "Smoke fixture profile.",
                    "suites": ["session.smoke.fixture"],
                },
                "full": {
                    "description": "Full fixture profile.",
                    "suites": [
                        "repository.required",
                        "kernel.v2.contracts",
                        "session.smoke.fixture",
                    ],
                },
            },
            "suites": [
                fixture_suite("repository.required", True),
                fixture_suite("kernel.v2.contracts", True),
                fixture_suite("repository.static", False),
                fixture_suite("session.smoke.fixture", False, kind="smoke"),
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
        assert [suite["id"] for suite in payload["suites"]] == [
            "repository.required",
            "kernel.v2.contracts",
            "repository.static",
            "session.smoke.fixture",
        ]

        def run_receipt(*arguments: str) -> dict[str, object]:
            executed = subprocess.run(
                ["bash", str(repo / "test.sh"), *arguments, "--json"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(executed.stdout)

        receipt = run_receipt()
        assert receipt["status"] == "passed"
        assert receipt["authoritative"] is True
        assert receipt["selectedBy"] == "profile:required"
        assert receipt["registryHeadBound"] is True
        assert receipt["controllerHeadBound"] is True
        assert receipt["selectedAssets"]["headBound"] is True
        assert receipt["worktree"]["indexTrusted"] is True
        assert receipt["results"][0]["id"] == "repository.required"
        assert receipt["results"][1]["id"] == "kernel.v2.contracts"

        required_receipt = run_receipt("--profile", "required")
        assert required_receipt["authoritative"] is True

        for profile in ("static", "smoke", "full"):
            optional_receipt = run_receipt("--profile", profile)
            assert optional_receipt["status"] == "passed"
            assert optional_receipt["authoritative"] is False
            assert optional_receipt["selectedBy"] == f"profile:{profile}"

        explicit_receipt = run_receipt("--suite", "repository.required")
        assert explicit_receipt["status"] == "passed"
        assert explicit_receipt["authoritative"] is False
        assert explicit_receipt["selectedBy"] == "explicit-suites"


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


def assert_suite_child_signals_are_unblocked(controller) -> None:
    with tempfile.TemporaryDirectory(prefix="deepcode-controller-signal-mask.") as directory:
        runner = Path(directory) / "signal-mask.sh"
        runner.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
/usr/bin/python3 - <<'PY'
import signal
blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set())
if signal.SIGINT in blocked or signal.SIGTERM in blocked:
    raise SystemExit(f"runner inherited blocked controller signals: {blocked}")
PY
""",
            encoding="utf-8",
        )
        suite = {
            "id": "fixture.signal-mask",
            "description": "Child signal mask fixture.",
            "kind": "static",
            "runner": {
                "path": str(runner),
                "args": [],
                "timeoutSeconds": 10,
                "terminateGraceSeconds": 1,
            },
            "environment": {"hostPolicy": "allowed"},
        }
        result = run_suite_quiet(controller, suite)
        assert result["status"] == "passed"


def assert_runner_environment_rejects_bash_injection(controller) -> None:
    with tempfile.TemporaryDirectory(prefix="deepcode-controller-runner-env.") as directory:
        temp_root = Path(directory)
        actual_marker = temp_root / "runner-executed"
        bypass_marker = temp_root / "bash-env-sourced"
        runner = temp_root / "runner.sh"
        runner.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail
test -z "${{CARGO_BUILD_RUSTC_WRAPPER:-}}"
test -z "${{CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER:-}}"
test -z "${{RUSTC_WRAPPER:-}}"
test -z "${{RUSTC_WORKSPACE_WRAPPER:-}}"
test -z "${{CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER:-}}"
test "${{DEEPCODE_DISABLE_SCCACHE:-}}" = "1"
test "${{PYTHONDONTWRITEBYTECODE:-}}" = "1"
printf ran > {actual_marker}
""",
            encoding="utf-8",
        )
        bash_env = temp_root / "bash-env.sh"
        bash_env.write_text(
            f"printf bypass > {bypass_marker}\nexit 0\n",
            encoding="utf-8",
        )
        injected_environment = {
            "BASH_ENV": str(bash_env),
            "CARGO_BUILD_RUSTC_WRAPPER": "malicious-wrapper",
            "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER": "malicious-workspace-wrapper",
            "RUSTC_WRAPPER": "malicious-wrapper",
            "RUSTC_WORKSPACE_WRAPPER": "malicious-workspace-wrapper",
            "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER": "malicious-runner",
            "DEEPCODE_DISABLE_SCCACHE": "0",
            "PYTHONDONTWRITEBYTECODE": "0",
        }
        previous_environment = {
            name: os.environ.get(name) for name in injected_environment
        }
        os.environ.update(injected_environment)
        try:
            suite = {
                "id": "fixture.runner-environment",
                "description": "Runner environment fixture.",
                "kind": "static",
                "runner": {
                    "path": str(runner),
                    "args": [],
                    "timeoutSeconds": 10,
                    "terminateGraceSeconds": 1,
                },
                "environment": {"hostPolicy": "allowed"},
            }
            result = run_suite_quiet(controller, suite)
        finally:
            for name, previous_value in previous_environment.items():
                if previous_value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = previous_value
        assert result["status"] == "passed"
        assert actual_marker.is_file()
        assert not bypass_marker.exists()


def assert_timeout_receipt_reports_process_group_reclaim(controller) -> None:
    with tempfile.TemporaryDirectory(prefix="deepcode-controller-timeout.") as directory:
        runner = Path(directory) / "timeout.sh"
        runner.write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\nsleep 30 &\nwait\n",
            encoding="utf-8",
        )
        suite = {
            "id": "fixture.timeout",
            "description": "Timeout process-group fixture.",
            "kind": "static",
            "runner": {
                "path": str(runner),
                "args": [],
                "timeoutSeconds": 1,
                "terminateGraceSeconds": 1,
            },
            "environment": {"hostPolicy": "allowed"},
        }
        result = run_suite_quiet(controller, suite)
        assert result["status"] == "timed-out"
        assert result["exitCode"] == 124
        assert result["residualProcessGroupReclaimed"] is True


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


def assert_git_identity_ignores_replace_and_environment(controller) -> None:
    with tempfile.TemporaryDirectory(prefix="deepcode-controller-git-identity.") as directory:
        repo = Path(directory) / "repo"
        redirected = Path(directory) / "redirected"
        repo.mkdir()
        redirected.mkdir()
        for path in (repo, redirected):
            subprocess.run(["git", "init", "--quiet", "--initial-branch=main"], cwd=path, check=True)
            subprocess.run(["git", "config", "user.name", "DeepCode Identity Test"], cwd=path, check=True)
            subprocess.run(
                ["git", "config", "user.email", "identity@example.invalid"],
                cwd=path,
                check=True,
            )
            (path / "tracked.txt").write_text("baseline\n", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.txt"], cwd=path, check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "baseline"], cwd=path, check=True)

        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        (repo / "tracked.txt").write_text("changed\n", encoding="utf-8")
        subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True)
        replacement_tree = subprocess.run(
            ["git", "write-tree"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        replacement_commit = subprocess.run(
            ["git", "commit-tree", replacement_tree, "-m", "replacement"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(["git", "replace", head, replacement_commit], cwd=repo, check=True)
        hidden_by_replace = subprocess.run(
            ["git", "diff", "--quiet", head, "--"],
            cwd=repo,
        )
        assert hidden_by_replace.returncode == 0

        fingerprint = controller.worktree_fingerprint(repo, head)
        assert fingerprint["dirty"] is True
        assert fingerprint["untrackedCount"] == 0

        previous_git_dir = os.environ.get("GIT_DIR")
        os.environ["GIT_DIR"] = str(redirected / ".git")
        try:
            assert controller.git_output(repo, "rev-parse", "HEAD") == head
        finally:
            if previous_git_dir is None:
                os.environ.pop("GIT_DIR", None)
            else:
                os.environ["GIT_DIR"] = previous_git_dir

        controller.verify_repository_root(repo)
        subprocess.run(
            ["git", "config", "core.worktree", str(redirected)],
            cwd=repo,
            check=True,
        )
        try:
            controller.verify_repository_root(repo)
        except controller.ControllerError:
            pass
        else:
            raise AssertionError("repository-local core.worktree redirection was accepted")
        subprocess.run(
            ["git", "config", "--unset", "core.worktree"],
            cwd=repo,
            check=True,
        )

        flagged = Path(directory) / "flagged"
        flagged.mkdir()
        subprocess.run(["git", "init", "--quiet", "--initial-branch=main"], cwd=flagged, check=True)
        subprocess.run(["git", "config", "user.name", "DeepCode Index Test"], cwd=flagged, check=True)
        subprocess.run(
            ["git", "config", "user.email", "index@example.invalid"],
            cwd=flagged,
            check=True,
        )
        for name in ("assume.txt", "skip.txt"):
            (flagged / name).write_text("baseline\n", encoding="utf-8")
        subprocess.run(["git", "add", "assume.txt", "skip.txt"], cwd=flagged, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "baseline"], cwd=flagged, check=True)
        flagged_head = controller.git_output(flagged, "rev-parse", "HEAD")
        subprocess.run(
            ["git", "update-index", "--assume-unchanged", "assume.txt"],
            cwd=flagged,
            check=True,
        )
        subprocess.run(
            ["git", "update-index", "--skip-worktree", "skip.txt"],
            cwd=flagged,
            check=True,
        )
        for name in ("assume.txt", "skip.txt"):
            (flagged / name).write_text("modified\n", encoding="utf-8")
        hidden_by_index_flags = subprocess.run(
            ["git", "diff", "--quiet", flagged_head, "--"],
            cwd=flagged,
        )
        assert hidden_by_index_flags.returncode == 0

        flagged_fingerprint = controller.worktree_fingerprint(flagged, flagged_head)
        assert flagged_fingerprint["dirty"] is True
        assert flagged_fingerprint["indexTrusted"] is False
        assert flagged_fingerprint["untrustedIndexEntryCount"] == 2
        flagged_manifest = controller.selected_asset_manifest(
            flagged,
            [{
                "runner": {"path": "assume.txt"},
                "contractSources": ["skip.txt"],
            }],
            flagged_head,
        )
        assert flagged_manifest["headBound"] is False


def main() -> None:
    controller = load_controller()
    assert_registry_and_selection(controller)
    assert_machine_list(controller)
    assert_registry_override_is_rejected()
    assert_internal_runners_are_guarded()
    assert_isolated_public_entrypoint()
    assert_owned_process_group_cleanup(controller)
    assert_suite_child_signals_are_unblocked(controller)
    assert_runner_environment_rejects_bash_injection(controller)
    assert_timeout_receipt_reports_process_group_reclaim(controller)
    assert_worktree_fingerprint(controller)
    assert_git_identity_ignores_replace_and_environment(controller)
    print("[PASS] test controller contracts")


if __name__ == "__main__":
    main()
