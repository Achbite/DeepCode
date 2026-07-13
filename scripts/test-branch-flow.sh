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

git init --bare --quiet "$REMOTE"
git init --quiet --initial-branch=main "$WORK"
git -C "$WORK" config user.name 'DeepCode Branch Flow Test'
git -C "$WORK" config user.email 'branch-flow@example.invalid'
mkdir -p "$WORK/.githooks" "$WORK/scripts"
cp "$SOURCE_ROOT/.githooks/reference-transaction" "$WORK/.githooks/reference-transaction"
cp "$SOURCE_ROOT/.githooks/pre-push" "$WORK/.githooks/pre-push"
cp "$SOURCE_ROOT/scripts/branch-flow.sh" "$WORK/scripts/branch-flow.sh"
chmod 0755 "$WORK/.githooks/reference-transaction" "$WORK/.githooks/pre-push" "$WORK/scripts/branch-flow.sh"
printf 'baseline\n' >"$WORK/tracked.txt"
git -C "$WORK" add .githooks scripts tracked.txt
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
expect_failure 'stale publish authorization is rejected' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh publish-task --target dev-main --expected-head 0000000000000000000000000000000000000000 --authorized"

git -C "$WORK" switch --quiet dev-main
git -C "$WORK" switch --quiet -c fix/finished
printf 'finished\n' >>"$WORK/tracked.txt"
git -C "$WORK" add tracked.txt
git -C "$WORK" commit --quiet -m 'test: merged task'
finished_head="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" push --quiet -u origin fix/finished
git --git-dir="$REMOTE" update-ref refs/heads/dev-main "$finished_head"
git -C "$WORK" fetch --quiet origin
(
  cd "$WORK"
  bash ./scripts/branch-flow.sh finish \
    --branch fix/finished \
    --target dev-main \
    --expected-head "$finished_head" \
    --authorized
)
git -C "$WORK" show-ref --verify --quiet refs/heads/fix/finished \
  && fail 'finished local branch still exists'
git -C "$WORK" show-ref --verify --quiet refs/remotes/origin/fix/finished \
  && fail 'finished remote branch still exists'
pass 'merged clean task branch is removed safely'

git -C "$WORK" switch --quiet -c kernel/active dev-main
printf 'active dirty work\n' >>"$WORK/tracked.txt"
active_head="$(git -C "$WORK" rev-parse HEAD)"
expect_failure 'dirty active branch cleanup is rejected' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh finish --branch kernel/active --target dev-main --expected-head '$active_head' --authorized"
git -C "$WORK" restore tracked.txt
git -C "$WORK" switch --quiet -c integration/legacy
audit_output="$(cd "$WORK" && bash ./scripts/branch-flow.sh audit)"
grep -Fq 'legacy active branch requires rename before PR' <<<"$audit_output" \
  || fail 'audit did not report the legacy active branch'
pass 'audit reports legacy active branches without mutation'

expect_failure 'protected branch cleanup is rejected' \
  bash -c "cd '$WORK' && bash ./scripts/branch-flow.sh finish --branch main --target dev-main --expected-head '$(git -C "$WORK" rev-parse main)' --authorized"

(
  cd "$WORK"
  bash ./scripts/branch-flow.sh self-check >/dev/null
)
pass 'branch flow functional tests passed'
