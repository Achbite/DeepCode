#!/usr/bin/env bash
# Functional tests for the protected branch workflow in disposable repositories.
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/deepcode-branch-flow.XXXXXX")"
REMOTE="$TMP_ROOT/remote.git"
WORK="$TMP_ROOT/work"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf '==[branch-flow-test][error]== %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '==[branch-flow-test]== %s\n' "$*"
}

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$TMP_ROOT/command.out" 2>"$TMP_ROOT/command.err"; then
    fail "$label unexpectedly succeeded"
  fi
  pass "$label"
}

expect_failure_with() {
  local label="$1"
  local expected="$2"
  shift 2
  if "$@" >"$TMP_ROOT/command.out" 2>"$TMP_ROOT/command.err"; then
    fail "$label unexpectedly succeeded"
  fi
  grep -Fq "$expected" "$TMP_ROOT/command.err" \
    || fail "$label did not report: $expected"
  pass "$label"
}

write_approved_tcr() {
  local destination="$1"
  printf '%s\n' \
    '# Branch-flow Test Change Request' \
    '' \
    '## Requested scope' \
    '' \
    '- Request reference: branch-flow-contract-fixture' \
    '- Test IDs: branch-flow-test-entry' \
    '- Exact repository paths (JSON array): ["test.sh"]' \
    '- Change type: replace' \
    '- Why this scope is necessary: exercise the target-materialized protected test gate' \
    '' \
    '## Contract comparison' \
    '' \
    '- Existing invariant and fact source: the baseline fixture test.sh exits unsuccessfully' \
    '- Evidence that the existing test is obsolete or incorrect: the disposable scenario intentionally replaces the fixture entrypoint' \
    '- Proposed invariant and fact source: only the exact reviewed test.sh blob is accepted by the target gate' \
    '- Exact pass/fail boundary change: the disposable test.sh exit status changes only for this reviewed blob' \
    '- Replacement coverage or reason no replacement is valid: branch-flow contract assertions cover gate acceptance and rejection' \
    '- Runtime, compatibility, and cross-layer impact: disposable repository only; no production runtime impact' \
    '' \
    '## User decision' \
    '' \
    '- Decision: approved' \
    '- Approved paths and intent: test.sh for the exact branch-flow fixture' \
    '- Explicit exclusions: no production, Session smoke, or shared fixture changes' \
    '- Approver: branch-flow user fixture; audit text only' \
    '- Decision timestamp: 2026-07-22T00:00:00Z' \
    >"$destination"
}

git init --bare --quiet "$REMOTE"
git init --quiet --initial-branch=main "$WORK"
git -C "$WORK" config user.name 'DeepCode Branch Flow Test'
git -C "$WORK" config user.email 'branch-flow@example.invalid'
mkdir -p "$WORK/.githooks" "$WORK/scripts" "$WORK/tests"
cp "$SOURCE_ROOT/.githooks/reference-transaction" "$WORK/.githooks/reference-transaction"
cp "$SOURCE_ROOT/.githooks/pre-push" "$WORK/.githooks/pre-push"
cp "$SOURCE_ROOT/scripts/branch-flow.sh" "$WORK/scripts/branch-flow.sh"
cp "$SOURCE_ROOT/scripts/test-change-gate.py" "$WORK/scripts/test-change-gate.py"
cp "$SOURCE_ROOT/tests/protected-paths.json" "$WORK/tests/protected-paths.json"
chmod 0755 "$WORK/.githooks/reference-transaction" "$WORK/.githooks/pre-push" "$WORK/scripts/branch-flow.sh"
printf 'baseline\n' >"$WORK/tracked.txt"
printf '#!/usr/bin/env bash\nexit 1\n' >"$WORK/test.sh"
git -C "$WORK" add .githooks scripts tests test.sh tracked.txt
git -C "$WORK" commit --quiet -m 'test: baseline'
git -C "$WORK" branch dev-main
git -C "$WORK" remote add origin "$REMOTE"
git -C "$WORK" push --quiet origin main dev-main

git -C "$WORK" switch --quiet -c fix/hook-test dev-main
(
  cd "$WORK"
  bash ./scripts/branch-flow.sh install-hooks
)

(
  cd "$WORK"
  bash ./scripts/branch-flow.sh start ui start-test --worktree "$WORK" >/dev/null
)
[ "$(git -C "$WORK" branch --show-current)" = 'ui/start-test' ] \
  || fail 'start did not create the expected task branch'
git -C "$WORK" switch --quiet fix/hook-test
git -C "$WORK" branch -d ui/start-test >/dev/null
pass 'start creates a local-only task branch from dev-main'

expect_failure 'local main deletion is rejected' git -C "$WORK" branch -D main
expect_failure 'local dev-main deletion is rejected' git -C "$WORK" branch -D dev-main

git -C "$WORK" push --quiet -u origin fix/hook-test
pass 'task branch push is allowed'

git -C "$WORK" switch --quiet main
printf 'protected update\n' >>"$WORK/tracked.txt"
git -C "$WORK" add tracked.txt
git -C "$WORK" commit --quiet -m 'test: protected update'
expect_failure 'direct main push is rejected' git -C "$WORK" push origin main
expect_failure 'force main push is rejected' git -C "$WORK" push --force origin main
git -C "$WORK" switch --quiet fix/hook-test
git -C "$WORK" branch -f main origin/main >/dev/null
expect_failure 'remote dev-main deletion is rejected' git -C "$WORK" push origin --delete dev-main

(
  cd "$WORK"
  bash ./scripts/branch-flow.sh check-pr-route kernel/example dev-main >/dev/null
  bash ./scripts/branch-flow.sh check-pr-route main dev-main >/dev/null
  bash ./scripts/branch-flow.sh check-pr-route dev-main main >/dev/null
  bash ./scripts/branch-flow.sh check-pr-route hotfix/example main >/dev/null
)
expect_failure 'integration PR route is rejected' \
  bash "$WORK/scripts/branch-flow.sh" check-pr-route integration/example dev-main
expect_failure 'module-to-main PR route is rejected' \
  bash "$WORK/scripts/branch-flow.sh" check-pr-route kernel/example main
pass 'PR route policy is enforced'

printf 'dirty\n' >>"$WORK/tracked.txt"
expect_failure 'dirty worktree PR preparation is rejected' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh prepare-pr --target dev-main"
git -C "$WORK" restore tracked.txt
expect_failure 'stale publish head acknowledgement is rejected' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh publish-task --target dev-main --expected-head 0000000000000000000000000000000000000000 --acknowledge-side-effect"

git -C "$WORK" switch --quiet dev-main
git -C "$WORK" switch --quiet -c fix/finished
printf 'finished\n' >>"$WORK/tracked.txt"
git -C "$WORK" add tracked.txt
git -C "$WORK" commit --quiet -m 'test: merged task'
finished_head="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push --quiet -u origin fix/finished
verified_target="$(git -C "$WORK" rev-parse origin/dev-main)"
(
  cd "$WORK"
  bash ./scripts/branch-flow.sh verify-pr \
    --head fix/finished \
    --target dev-main \
    --expected-head "$finished_head" \
    --expected-target "$verified_target" >/dev/null
)
pass 'exact remote PR head and target are verified locally'
expect_failure 'moved PR head is rejected' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh verify-pr --head fix/finished --target dev-main --expected-head 0000000000000000000000000000000000000000 --expected-target '$verified_target'"
expect_failure 'moved PR target is rejected' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh verify-pr --head fix/finished --target dev-main --expected-head '$finished_head' --expected-target 0000000000000000000000000000000000000000"
printf 'uncommitted after publish\n' >>"$WORK/tracked.txt"
expect_failure 'dirty PR worktree is rejected at merge verification' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh verify-pr --head fix/finished --target dev-main --expected-head '$finished_head' --expected-target '$verified_target'"
git -C "$WORK" restore tracked.txt
git --git-dir="$REMOTE" update-ref refs/heads/dev-main "$finished_head"
git -C "$WORK" fetch --quiet origin
(
  cd "$WORK"
  bash ./scripts/branch-flow.sh finish \
    --branch fix/finished \
    --target dev-main \
    --expected-head "$finished_head" \
    --acknowledge-side-effect
)
git -C "$WORK" show-ref --verify --quiet refs/heads/fix/finished \
  && fail 'finished local branch still exists'
git -C "$WORK" show-ref --verify --quiet refs/remotes/origin/fix/finished \
  && fail 'finished remote branch still exists'
pass 'merged clean task branch is removed safely'

git -C "$WORK" switch --quiet -c fix/test-change dev-main
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/test.sh"
printf '%s\n' 'raise SystemExit(0)' >"$WORK/argparse.py"
git -C "$WORK" add argparse.py test.sh
git -C "$WORK" commit --quiet -m 'test: protected test entry change'
test_change_head="$(git -C "$WORK" rev-parse HEAD)"
test_change_target="$(git -C "$WORK" rev-parse origin/dev-main)"
git -C "$WORK" push --quiet -u origin fix/test-change
expect_failure_with 'protected change rejects root Python import shadow without release review' 'test-change-user-review-required' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh verify-pr --head fix/test-change --target dev-main --expected-head '$test_change_head' --expected-target '$test_change_target'"

write_approved_tcr "$TMP_ROOT/test-change-request.md"
printf '%s\n' '{"approvedBy":"self-asserted","schemaVersion":1}' >"$TMP_ROOT/false-identity-review.json"
expect_failure_with 'self-asserted identity cannot replace the release review schema' 'release review record recordType mismatch' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh verify-pr --head fix/test-change --target dev-main --expected-head '$test_change_head' --expected-target '$test_change_target' --test-change-request '$TMP_ROOT/test-change-request.md' --test-release-review '$TMP_ROOT/false-identity-review.json'"

(
  cd "$WORK"
  /usr/bin/git --no-replace-objects show "$test_change_target:scripts/test-change-gate.py" \
    | /usr/bin/python3 -I -S - record-release-review \
      --repository . \
      --target-ref dev-main \
      --head-ref fix/test-change \
      --target "$test_change_target" \
      --head "$test_change_head" \
      --policy-ref "$test_change_target" \
      --test-change-request "$TMP_ROOT/test-change-request.md" \
      --development-session-ref 'development-session-fixture' \
      --user-decision-ref 'user confirmed exact fixture scope' \
      --release-session-ref 'release-session-fixture' \
      --valid-seconds 3600 \
    >"$TMP_ROOT/test-release-review.json"
)
(
  cd "$WORK"
  bash ./scripts/branch-flow.sh verify-pr \
    --head fix/test-change \
    --target dev-main \
    --expected-head "$test_change_head" \
    --expected-target "$test_change_target" \
    --test-change-request "$TMP_ROOT/test-change-request.md" \
    --test-release-review "$TMP_ROOT/test-release-review.json" \
    >/dev/null
)
pass 'target gate accepts the exact procedural release review record'

git --git-dir="$REMOTE" update-ref refs/heads/main "$test_change_target"
git -C "$WORK" fetch --quiet origin main
git -C "$WORK" branch -f main "$test_change_target" >/dev/null
git -C "$WORK" branch hotfix/route-replay "$test_change_head"
git -C "$WORK" push --quiet -u origin hotfix/route-replay
expect_failure_with 'same-SHA review cannot cross PR route' 'release review record targetRef mismatch' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh verify-pr --head hotfix/route-replay --target main --expected-head '$test_change_head' --expected-target '$test_change_target' --test-change-request '$TMP_ROOT/test-change-request.md' --test-release-review '$TMP_ROOT/test-release-review.json'"

printf '#!/usr/bin/env bash\nprintf changed\\n\n' >"$WORK/test.sh"
git -C "$WORK" add test.sh
git -C "$WORK" commit --quiet -m 'test: move protected head'
moved_test_head="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push --quiet origin fix/test-change
expect_failure_with 'stale test review is rejected' 'release review record headSha mismatch' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh verify-pr --head fix/test-change --target dev-main --expected-head '$moved_test_head' --expected-target '$test_change_target' --test-change-request '$TMP_ROOT/test-change-request.md' --test-release-review '$TMP_ROOT/test-release-review.json'"

git -C "$WORK" switch --quiet dev-main
git -C "$WORK" switch --quiet -c fix/gate-self-change
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/scripts/branch-flow.sh"
printf '#!/usr/bin/env python3\nraise SystemExit(0)\n' >"$WORK/scripts/test-change-gate.py"
git -C "$WORK" add scripts/branch-flow.sh scripts/test-change-gate.py
git -C "$WORK" commit --quiet -m 'test: change branch gate'
gate_change_head="$(git -C "$WORK" rev-parse HEAD)"
gate_change_target="$(git -C "$WORK" rev-parse origin/dev-main)"
git -C "$WORK" push --quiet -u origin fix/gate-self-change
git -C "$WORK" --no-replace-objects show "$gate_change_target:scripts/branch-flow.sh" \
  >"$TMP_ROOT/trusted-branch-flow.sh"
chmod 0755 "$TMP_ROOT/trusted-branch-flow.sh"
expect_failure_with 'target-materialized gate rejects malicious head stubs' 'test-change-user-review-required' \
  bash -c "cd '$WORK' && bash '$TMP_ROOT/trusted-branch-flow.sh' verify-pr --head fix/gate-self-change --target dev-main --expected-head '$gate_change_head' --expected-target '$gate_change_target'"

git -C "$WORK" replace "$gate_change_target" "$gate_change_head"
expect_failure_with 'target-materialized gate ignores local replace refs' 'test-change-user-review-required' \
  bash -c "cd '$WORK' && bash '$TMP_ROOT/trusted-branch-flow.sh' verify-pr --head fix/gate-self-change --target dev-main --expected-head '$gate_change_head' --expected-target '$gate_change_target'"
git -C "$WORK" replace -d "$gate_change_target" >/dev/null

git -C "$WORK" switch --quiet -c kernel/active dev-main
printf 'active dirty work\n' >>"$WORK/tracked.txt"
active_head="$(git -C "$WORK" rev-parse HEAD)"
expect_failure 'dirty active branch cleanup is rejected' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh finish --branch kernel/active --target dev-main --expected-head '$active_head' --acknowledge-side-effect"
git -C "$WORK" restore tracked.txt
git -C "$WORK" switch --quiet -c integration/legacy
audit_output="$(cd "$WORK" && bash ./scripts/branch-flow.sh audit)"
grep -Fq 'legacy active branch requires rename before PR' <<<"$audit_output" \
  || fail 'audit did not report the legacy active branch'
pass 'audit reports legacy active branches without mutation'

expect_failure 'protected branch cleanup is rejected' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh finish --branch main --target dev-main --expected-head '$(git -C "$WORK" rev-parse main)' --acknowledge-side-effect"

(
  cd "$WORK"
  bash ./scripts/branch-flow.sh self-check >/dev/null
)
pass 'branch flow functional tests passed'
