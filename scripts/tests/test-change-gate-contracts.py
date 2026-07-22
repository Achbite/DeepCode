#!/usr/bin/env python3
"""Disposable-repository contracts for protected test-change classification."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


SOURCE_ROOT = Path(__file__).resolve().parents[2]
GATE = SOURCE_ROOT / "scripts" / "test-change-gate.py"
POLICY = SOURCE_ROOT / "tests" / "protected-paths.json"
POLICY_VALUE = json.loads(POLICY.read_text(encoding="utf-8"))
REVIEW_POLICY = POLICY_VALUE["releaseReview"]
TEST_TARGET_REF = "main"
TEST_HEAD_REF = "scenario/candidate"
DEVELOPMENT_SESSION_REF = "development-session-fixture"
USER_DECISION_REF = "user-confirmed exact fixture scope"
RELEASE_SESSION_REF = "release-session-fixture"
PYTHON = (sys.executable, "-I", "-S")


def run(*args: str, cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
    )


def git(repo: Path, *args: str) -> str:
    return run("git", *args, cwd=repo).stdout.strip()


def write(repo: Path, path: str, value: str) -> None:
    destination = repo / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(value, encoding="utf-8")


def commit_all(repo: Path, message: str) -> str:
    git(repo, "add", "-A")
    git(repo, "commit", "--quiet", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def canonical_json(value: dict) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ) + "\n"


def approved_tcr() -> str:
    return """# Gate contract Test Change Request

## Requested scope

- Request reference: gate-contract-fixture
- Test IDs: gate-contract-test-entry
- Exact repository paths (JSON array): ["test.sh"]
- Change type: replace
- Why this scope is necessary: exercise the protected test entrypoint classifier

## Contract comparison

- Existing invariant and fact source: test.sh exits with the baseline fixture result
- Evidence that the existing test is obsolete or incorrect: the disposable scenario intentionally changes that fixture
- Proposed invariant and fact source: the changed test.sh blob is classified and bound by the target gate
- Exact pass/fail boundary change: only the exact disposable test.sh blob may pass review verification
- Replacement coverage or reason no replacement is valid: gate contract assertions cover the replacement
- Runtime, compatibility, and cross-layer impact: disposable repository only; no runtime contract change

## User decision

- Decision: approved
- Approved paths and intent: test.sh for the exact disposable gate scenario
- Explicit exclusions: no production, fixture, or Session smoke changes
- Approver: gate-contract user fixture; audit text only
- Decision timestamp: 2026-07-22T00:00:00Z
"""


def classify(repo: Path, target: str, head: str) -> dict:
    completed = run(
        *PYTHON,
        str(GATE),
        "classify",
        "--repository",
        str(repo),
        "--target-ref",
        TEST_TARGET_REF,
        "--head-ref",
        TEST_HEAD_REF,
        "--target",
        target,
        "--head",
        head,
        "--policy-ref",
        target,
        "--json",
        cwd=repo,
    )
    return json.loads(completed.stdout)


def new_scenario(repo: Path, target: str, name: str) -> None:
    git(repo, "switch", "--quiet", "-C", name, target)


def only_change(payload: dict) -> dict:
    assert len(payload["changes"]) == 1, payload
    return payload["changes"][0]


def assert_classifier(repo: Path, target: str) -> tuple[str, str, dict]:
    new_scenario(repo, target, "scenario/production")
    write(repo, "src/app.ts", "export const value = 2;\n")
    production_head = commit_all(repo, "production only")
    assert classify(repo, target, production_head)["protectedChangeCount"] == 0

    new_scenario(repo, target, "scenario/runtime")
    write(repo, "test.sh", "#!/usr/bin/env bash\nexit 0\n")
    runtime_head = commit_all(repo, "change test entry")
    runtime_payload = classify(repo, target, runtime_head)
    assert only_change(runtime_payload)["categories"] == ["test-runtime"]

    new_scenario(repo, target, "scenario/fixture-rename")
    git(repo, "mv", "fixtures/input.json", "fixtures/renamed.json")
    rename_head = commit_all(repo, "rename fixture")
    rename_change = only_change(classify(repo, target, rename_head))
    assert rename_change["action"] == "R"
    assert "test-data" in rename_change["categories"]

    new_scenario(repo, target, "scenario/delete-test")
    (repo / "tests" / "example.test.ts").unlink()
    delete_head = commit_all(repo, "delete test")
    delete_change = only_change(classify(repo, target, delete_head))
    assert delete_change["action"] == "D"
    assert "test-contract" in delete_change["categories"]

    new_scenario(repo, target, "scenario/inline-test")
    write(
        repo,
        "src/lib.rs",
        "pub fn value() -> i32 { 1 }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn value_is_stable() { assert_eq!(super::value(), 2); }\n}\n",
    )
    inline_head = commit_all(repo, "change inline test")
    inline_change = only_change(classify(repo, target, inline_head))
    assert "inline-test" in inline_change["categories"]

    new_scenario(repo, target, "scenario/cfg-all-test")
    write(
        repo,
        "src/lib.rs",
        "pub fn value() -> i32 { 1 }\n\n#[cfg(all(test, unix))]\nmod tests {\n    #[test]\n    fn value_is_stable() { assert_eq!(super::value(), 1); }\n}\n",
    )
    cfg_all_head = commit_all(repo, "change inline test cfg")
    cfg_all_change = only_change(classify(repo, target, cfg_all_head))
    assert "inline-test" in cfg_all_change["categories"]

    new_scenario(repo, target, "scenario/make-build")
    write(
        repo,
        "Makefile",
        "build:\n\t@echo compile\n\ntest:\n\t@runner \\\n\t  --mode old\n",
    )
    make_build_head = commit_all(repo, "change build command")
    assert classify(repo, target, make_build_head)["protectedChangeCount"] == 0

    new_scenario(repo, target, "scenario/make-test")
    write(
        repo,
        "Makefile",
        "build:\n\t@echo build\n\ntest:\n\t@runner \\\n\t  --mode new\n",
    )
    make_test_head = commit_all(repo, "change test continuation")
    make_change = only_change(classify(repo, target, make_test_head))
    assert "test-command" in make_change["categories"]

    new_scenario(repo, target, "scenario/cargo-dev-dependency")
    write(repo, "Cargo.toml", "[package]\nname = \"fixture\"\n\n[dev-dependencies]\nhelper = \"2\"\n")
    cargo_head = commit_all(repo, "change dev dependency")
    cargo_change = only_change(classify(repo, target, cargo_head))
    assert "test-command" in cargo_change["categories"]

    new_scenario(repo, target, "scenario/tsconfig-output")
    write(
        repo,
        "tsconfig.json",
        '{"compilerOptions":{"outDir":"dist-new"},"include":["src"]}\n',
    )
    tsconfig_head = commit_all(repo, "change test compilation output")
    tsconfig_change = only_change(classify(repo, target, tsconfig_head))
    assert "test-command" in tsconfig_change["categories"]

    new_scenario(repo, target, "scenario/docs")
    write(repo, "README.md", "Run bash ./test.sh --profile static.\n")
    docs_head = commit_all(repo, "change test docs")
    docs_change = only_change(classify(repo, target, docs_head))
    assert "test-documentation" in docs_change["categories"]

    new_scenario(repo, target, "scenario/chinese-test-docs")
    write(repo, "docs/governance.md", "测试失败时不得放宽断言。\n")
    chinese_docs_head = commit_all(repo, "change Chinese test governance docs")
    chinese_docs_change = only_change(classify(repo, target, chinese_docs_head))
    assert "test-documentation" in chinese_docs_change["categories"]

    new_scenario(repo, target, "scenario/attributes-bypass")
    write(repo, ".gitattributes", "README.md -diff\n")
    info_attributes = repo / ".git" / "info" / "attributes"
    info_attributes.write_text("README.md -diff\n", encoding="utf-8")
    write(repo, "README.md", "Run bash ./test.sh --profile static.\n")
    attributes_head = commit_all(repo, "attempt to hide test documentation diff")
    attributes_payload = classify(repo, target, attributes_head)
    info_attributes.unlink()
    readme_change = next(
        change for change in attributes_payload["changes"] if change["newPath"] == "README.md"
    )
    attributes_change = next(
        change
        for change in attributes_payload["changes"]
        if change["newPath"] == ".gitattributes"
    )
    assert "test-documentation" in readme_change["categories"]
    assert "test-policy" in attributes_change["categories"]

    new_scenario(repo, target, "scenario/policy")
    policy_value = json.loads((repo / "tests" / "protected-paths.json").read_text())
    policy_value["bootstrapTestValue"] = True
    (repo / "tests" / "protected-paths.json").write_text(
        json.dumps(policy_value, indent=2) + "\n", encoding="utf-8"
    )
    policy_head = commit_all(repo, "change gate policy")
    policy_change = only_change(classify(repo, target, policy_head))
    assert {"test-contract", "test-policy"}.issubset(policy_change["categories"])

    return production_head, runtime_head, runtime_payload


def assert_release_review_binding(
    repo: Path,
    temp_root: Path,
    target: str,
    production_head: str,
    head: str,
    payload: dict,
) -> None:
    base_command = [
        *PYTHON,
        str(GATE),
        "verify",
        "--repository",
        str(repo),
        "--target-ref",
        TEST_TARGET_REF,
        "--head-ref",
        TEST_HEAD_REF,
        "--target",
        target,
        "--head",
        head,
        "--policy-ref",
        target,
        "--quiet",
    ]
    rejected = run(*base_command, cwd=repo, check=False)
    assert rejected.returncode == 3
    assert "test-change-user-review-required" in rejected.stderr

    untrusted_policy = list(base_command)
    untrusted_policy[untrusted_policy.index("--policy-ref") + 1] = head
    untrusted = run(*untrusted_policy, cwd=repo, check=False)
    assert untrusted.returncode == 2
    assert "policy-ref to equal the exact target SHA" in untrusted.stderr

    nonprotected_command = [
        value if value != head else production_head for value in base_command
    ]
    unexpected_review = run(
        *nonprotected_command,
        "--test-release-review",
        str(temp_root / "unused-review.json"),
        cwd=repo,
        check=False,
    )
    assert unexpected_review.returncode == 3
    assert "no protected test change" in unexpected_review.stderr

    test_change_request = temp_root / "test-change-request.md"
    test_change_request.write_text(approved_tcr(), encoding="utf-8")
    partial_result = run(
        *base_command,
        "--test-change-request",
        str(test_change_request),
        cwd=repo,
        check=False,
    )
    assert partial_result.returncode == 3
    assert "require --test-change-request and --test-release-review together" in partial_result.stderr

    false_identity_path = temp_root / "false-identity-review.json"
    false_identity_path.write_text(
        canonical_json(
            {
                "schemaVersion": 1,
                "approvedBy": "self-asserted",
                "decision": "approve-test-change",
            }
        ),
        encoding="utf-8",
    )
    false_identity = run(
        *base_command,
        "--test-change-request",
        str(test_change_request),
        "--test-release-review",
        str(false_identity_path),
        cwd=repo,
        check=False,
    )
    assert false_identity.returncode == 3
    assert "release review record recordType mismatch" in false_identity.stderr

    record_command = [
        *PYTHON,
        str(GATE),
        "record-release-review",
        "--repository",
        str(repo),
        "--target-ref",
        TEST_TARGET_REF,
        "--head-ref",
        TEST_HEAD_REF,
        "--target",
        target,
        "--head",
        head,
        "--policy-ref",
        target,
        "--test-change-request",
        str(test_change_request),
        "--development-session-ref",
        DEVELOPMENT_SESSION_REF,
        "--user-decision-ref",
        USER_DECISION_REF,
        "--release-session-ref",
        RELEASE_SESSION_REF,
        "--valid-seconds",
        "3600",
    ]

    empty_tcr = temp_root / "empty-test-change-request.md"
    empty_tcr.write_text("\n", encoding="utf-8")
    empty_record_command = list(record_command)
    empty_record_command[empty_record_command.index("--test-change-request") + 1] = str(
        empty_tcr
    )
    empty_record = run(*empty_record_command, cwd=repo, check=False)
    assert empty_record.returncode == 3
    assert "Test Change Request must not be empty" in empty_record.stderr

    pending_tcr = temp_root / "pending-test-change-request.md"
    pending_tcr.write_text(
        approved_tcr().replace("- Decision: approved", "- Decision: pending"),
        encoding="utf-8",
    )
    pending_record_command = list(record_command)
    pending_record_command[pending_record_command.index("--test-change-request") + 1] = str(
        pending_tcr
    )
    pending_record = run(*pending_record_command, cwd=repo, check=False)
    assert pending_record.returncode == 3
    assert "Decision must be exactly 'approved'" in pending_record.stderr

    out_of_scope_tcr = temp_root / "out-of-scope-test-change-request.md"
    out_of_scope_tcr.write_text(
        approved_tcr().replace('["test.sh"]', '["fixtures/unrelated.json"]'),
        encoding="utf-8",
    )
    out_of_scope_record_command = list(record_command)
    out_of_scope_record_command[
        out_of_scope_record_command.index("--test-change-request") + 1
    ] = str(out_of_scope_tcr)
    out_of_scope_record = run(*out_of_scope_record_command, cwd=repo, check=False)
    assert out_of_scope_record.returncode == 3
    assert "exact paths do not cover protected change paths: test.sh" in out_of_scope_record.stderr

    prepared = run(*record_command, cwd=repo)
    prepared_value = json.loads(prepared.stdout)
    assert prepared_value["authentication"] == "none"
    assert prepared_value["authorizationProof"] == "none"
    assert prepared_value["sessionIndependenceProof"] == "none"
    assert prepared_value["assertedWorkflowStage"] == "release-review-completed"
    overlong_command = list(record_command)
    overlong_command[overlong_command.index("--valid-seconds") + 1] = str(
        REVIEW_POLICY["maxLifetimeSeconds"] + 1
    )
    overlong = run(*overlong_command, cwd=repo, check=False)
    assert overlong.returncode == 2
    assert "valid-seconds must be between" in overlong.stderr
    same_session_command = list(record_command)
    same_session_command[same_session_command.index("--release-session-ref") + 1] = (
        DEVELOPMENT_SESSION_REF
    )
    same_session = run(*same_session_command, cwd=repo, check=False)
    assert same_session.returncode == 3
    assert "must differ as a workflow assertion" in same_session.stderr

    review_path = temp_root / "test-release-review.json"
    review_path.write_text(prepared.stdout, encoding="utf-8")
    review_arguments = [
        "--test-change-request",
        str(test_change_request),
        "--test-release-review",
        str(review_path),
    ]
    accepted = run(*base_command, *review_arguments, cwd=repo, check=False)
    assert accepted.returncode == 0, accepted.stderr

    blank_verification = run(
        *base_command,
        "--test-change-request",
        str(empty_tcr),
        "--test-release-review",
        str(review_path),
        cwd=repo,
        check=False,
    )
    assert blank_verification.returncode == 3
    assert "Test Change Request must not be empty" in blank_verification.stderr

    cross_route_command = list(base_command)
    cross_route_command[cross_route_command.index("--target-ref") + 1] = "dev-main"
    cross_route = run(
        *cross_route_command,
        *review_arguments,
        cwd=repo,
        check=False,
    )
    assert cross_route.returncode == 3
    assert "release review record targetRef mismatch" in cross_route.stderr

    sibling_worktree = temp_root / "sibling-worktree"
    git(repo, "worktree", "add", "--quiet", "--detach", str(sibling_worktree), target)
    sibling_review = sibling_worktree / "test-release-review.json"
    sibling_review.write_text(prepared.stdout, encoding="utf-8")
    sibling_arguments = list(review_arguments)
    sibling_arguments[-1] = str(sibling_review)
    sibling_result = run(*base_command, *sibling_arguments, cwd=repo, check=False)
    assert sibling_result.returncode == 3
    assert "outside every Git worktree" in sibling_result.stderr

    tampered_value = json.loads(prepared.stdout)
    tampered_value["protectedDigest"] = "0" * 64
    tampered_path = temp_root / "tampered-review.json"
    tampered_path.write_text(canonical_json(tampered_value), encoding="utf-8")
    tampered_arguments = list(review_arguments)
    tampered_arguments[-1] = str(tampered_path)
    tampered = run(*base_command, *tampered_arguments, cwd=repo, check=False)
    assert tampered.returncode == 3
    assert "release review record protectedDigest mismatch" in tampered.stderr

    identity_claim_value = json.loads(prepared.stdout)
    identity_claim_value["approvedBy"] = "self-asserted"
    identity_claim_path = temp_root / "identity-claim-review.json"
    identity_claim_path.write_text(canonical_json(identity_claim_value), encoding="utf-8")
    identity_claim_arguments = list(review_arguments)
    identity_claim_arguments[-1] = str(identity_claim_path)
    identity_claim = run(*base_command, *identity_claim_arguments, cwd=repo, check=False)
    assert identity_claim.returncode == 3
    assert "missing or unsupported fields" in identity_claim.stderr

    authentication_value = json.loads(prepared.stdout)
    authentication_value["authentication"] = "self-declared-identity"
    authentication_path = temp_root / "false-authentication-review.json"
    authentication_path.write_text(canonical_json(authentication_value), encoding="utf-8")
    authentication_arguments = list(review_arguments)
    authentication_arguments[-1] = str(authentication_path)
    authentication = run(*base_command, *authentication_arguments, cwd=repo, check=False)
    assert authentication.returncode == 3
    assert "release review record authentication mismatch" in authentication.stderr

    for field in ("authorizationProof", "sessionIndependenceProof"):
        false_proof_value = json.loads(prepared.stdout)
        false_proof_value[field] = "self-declared"
        false_proof_path = temp_root / f"false-{field}-review.json"
        false_proof_path.write_text(canonical_json(false_proof_value), encoding="utf-8")
        false_proof_arguments = list(review_arguments)
        false_proof_arguments[-1] = str(false_proof_path)
        false_proof = run(*base_command, *false_proof_arguments, cwd=repo, check=False)
        assert false_proof.returncode == 3
        assert f"release review record {field} mismatch" in false_proof.stderr

    binding_mutations = {
        "headRef": "scenario/other-candidate",
        "policySha256": "1" * 64,
        "gateSha256": "2" * 64,
        "protectedChanges": [],
    }
    for field, replacement in binding_mutations.items():
        binding_value = json.loads(prepared.stdout)
        binding_value[field] = replacement
        binding_path = temp_root / f"tampered-{field}-review.json"
        binding_path.write_text(canonical_json(binding_value), encoding="utf-8")
        binding_arguments = list(review_arguments)
        binding_arguments[-1] = str(binding_path)
        binding = run(*base_command, *binding_arguments, cwd=repo, check=False)
        assert binding.returncode == 3
        assert f"release review record {field} mismatch" in binding.stderr

    noncanonical_path = temp_root / "noncanonical-review.json"
    noncanonical_text = json.dumps(json.loads(prepared.stdout), indent=2) + "\n"
    noncanonical_path.write_text(noncanonical_text, encoding="utf-8")
    noncanonical_arguments = list(review_arguments)
    noncanonical_arguments[-1] = str(noncanonical_path)
    noncanonical = run(*base_command, *noncanonical_arguments, cwd=repo, check=False)
    assert noncanonical.returncode == 3
    assert "not in canonical JSON form" in noncanonical.stderr

    duplicate_text = prepared.stdout.replace("{", '{"schemaVersion":1,', 1)
    duplicate_path = temp_root / "duplicate-key-review.json"
    duplicate_path.write_text(duplicate_text, encoding="utf-8")
    duplicate_arguments = list(review_arguments)
    duplicate_arguments[-1] = str(duplicate_path)
    duplicate = run(*base_command, *duplicate_arguments, cwd=repo, check=False)
    assert duplicate.returncode == 3
    assert "duplicate JSON object key" in duplicate.stderr

    future_value = json.loads(prepared.stdout)
    future_now = datetime.now(timezone.utc).replace(microsecond=0)
    future_value["recordedAt"] = (future_now + timedelta(hours=1)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    future_value["expiresAt"] = (future_now + timedelta(hours=2)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    future_text = canonical_json(future_value)
    future_path = temp_root / "future-review.json"
    future_path.write_text(future_text, encoding="utf-8")
    future_arguments = list(review_arguments)
    future_arguments[-1] = str(future_path)
    future = run(*base_command, *future_arguments, cwd=repo, check=False)
    assert future.returncode == 3
    assert "recordedAt is in the future" in future.stderr

    expired_value = json.loads(prepared.stdout)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    expired_value["recordedAt"] = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    expired_value["expiresAt"] = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    expired_text = canonical_json(expired_value)
    expired_path = temp_root / "expired-review.json"
    expired_path.write_text(expired_text, encoding="utf-8")
    expired_arguments = list(review_arguments)
    expired_arguments[-1] = str(expired_path)
    expired = run(*base_command, *expired_arguments, cwd=repo, check=False)
    assert expired.returncode == 3
    assert "release review record has expired" in expired.stderr

    original_tcr = test_change_request.read_text(encoding="utf-8")
    test_change_request.write_text(original_tcr + "tampered\n", encoding="utf-8")
    stale_tcr = run(*base_command, *review_arguments, cwd=repo, check=False)
    assert stale_tcr.returncode == 3
    assert "testChangeRequestSha256 mismatch" in stale_tcr.stderr
    test_change_request.write_text(original_tcr, encoding="utf-8")

    git(repo, "switch", "--quiet", "scenario/runtime")
    write(repo, "test.sh", "#!/usr/bin/env bash\nprintf changed\\n\n")
    moved_head = commit_all(repo, "move protected head")
    stale_command = [value if value != head else moved_head for value in base_command]
    stale = run(*stale_command, *review_arguments, cwd=repo, check=False)
    assert stale.returncode == 3
    assert "release review record headSha mismatch" in stale.stderr


def assert_policy_hardening(
    repo: Path,
    target: str,
) -> None:
    new_scenario(repo, target, "scenario/invalid-review-policy")
    policy_path = repo / "tests" / "protected-paths.json"
    invalid_policy = json.loads(policy_path.read_text(encoding="utf-8"))
    invalid_policy["releaseReview"]["type"] = "self-declared-identity"
    policy_path.write_text(json.dumps(invalid_policy, indent=2) + "\n", encoding="utf-8")
    mismatched_target = commit_all(repo, "target with invalid release review model")
    write(repo, "test.sh", "#!/usr/bin/env bash\nexit 0\n")
    mismatched_head = commit_all(repo, "protected change after invalid review policy")
    mismatched = run(
        *PYTHON,
        str(GATE),
        "classify",
        "--repository",
        str(repo),
        "--target-ref",
        TEST_TARGET_REF,
        "--head-ref",
        TEST_HEAD_REF,
        "--target",
        mismatched_target,
        "--head",
        mismatched_head,
        "--policy-ref",
        mismatched_target,
        "--json",
        cwd=repo,
        check=False,
    )
    assert mismatched.returncode == 2
    assert "policy releaseReview.type must be 'procedural-release-task'" in mismatched.stderr

    new_scenario(repo, target, "scenario/duplicate-policy-key")
    policy_path = repo / "tests" / "protected-paths.json"
    policy_text = policy_path.read_text(encoding="utf-8")
    policy_path.write_text(
        policy_text.replace(
            '"schemaVersion": 2,',
            '"schemaVersion": 2,\n  "schemaVersion": 2,',
            1,
        ),
        encoding="utf-8",
    )
    duplicate_target = commit_all(repo, "target with duplicate policy key")
    write(repo, "src/app.ts", "export const value = 9;\n")
    duplicate_head = commit_all(repo, "change after duplicate policy")
    duplicate = run(
        *PYTHON,
        str(GATE),
        "classify",
        "--repository",
        str(repo),
        "--target-ref",
        TEST_TARGET_REF,
        "--head-ref",
        TEST_HEAD_REF,
        "--target",
        duplicate_target,
        "--head",
        duplicate_head,
        "--policy-ref",
        duplicate_target,
        "--json",
        cwd=repo,
        check=False,
    )
    assert duplicate.returncode == 2
    assert "duplicate JSON object key" in duplicate.stderr


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="deepcode-test-change-gate.") as directory:
        temp_root = Path(directory)
        repo = temp_root / "repo"
        repo.mkdir()
        run("git", "init", "--quiet", "--initial-branch=main", str(repo), cwd=temp_root)
        git(repo, "config", "user.name", "DeepCode Test Gate")
        git(repo, "config", "user.email", "test-gate@example.invalid")

        write(repo, "src/app.ts", "export const value = 1;\n")
        write(
            repo,
            "src/lib.rs",
            "pub fn value() -> i32 { 1 }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn value_is_stable() { assert_eq!(super::value(), 1); }\n}\n",
        )
        write(repo, "test.sh", "#!/usr/bin/env bash\nexit 1\n")
        write(repo, "tests/example.test.ts", "export const expected = true;\n")
        write(repo, "fixtures/input.json", "{}\n")
        write(
            repo,
            "Makefile",
            "build:\n\t@echo build\n\ntest:\n\t@runner \\\n\t  --mode old\n",
        )
        write(repo, "Cargo.toml", "[package]\nname = \"fixture\"\n\n[dev-dependencies]\nhelper = \"1\"\n")
        write(
            repo,
            "tsconfig.json",
            '{"compilerOptions":{"outDir":"dist-old"},"include":["src"]}\n',
        )
        write(repo, "README.md", "Build the project.\n")
        (repo / "tests").mkdir(parents=True, exist_ok=True)
        shutil.copy2(POLICY, repo / "tests" / "protected-paths.json")
        (repo / "scripts").mkdir(parents=True, exist_ok=True)
        shutil.copy2(GATE, repo / "scripts" / "test-change-gate.py")
        target = commit_all(repo, "baseline with trusted gate")

        production_head, runtime_head, runtime_payload = assert_classifier(repo, target)
        assert_release_review_binding(
            repo,
            temp_root,
            target,
            production_head,
            runtime_head,
            runtime_payload,
        )
        assert_policy_hardening(repo, target)

    print("[PASS] test change gate contracts")


if __name__ == "__main__":
    main()
