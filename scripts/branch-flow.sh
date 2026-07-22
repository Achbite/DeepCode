#!/usr/bin/env bash
# DeepCode protected-branch and short-lived task-branch workflow.
set -euo pipefail

export GIT_NO_REPLACE_OBJECTS=1

git() {
  /usr/bin/git "$@"
}

readonly MANAGED_MARKER='managed-by: deepcode-branch-flow'

die() {
  printf '==[branch-flow][error]== %s\n' "$*" >&2
  exit 1
}

info() {
  printf '==[branch-flow]== %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage:
  scripts/branch-flow.sh audit
  scripts/branch-flow.sh install-hooks
  scripts/branch-flow.sh start <kernel|session|ui|fix|hotfix|release> <slug> [--worktree PATH] [--release-approved]
  scripts/branch-flow.sh prepare-pr --target <dev-main|main> [--json]
  scripts/branch-flow.sh publish-task --target <dev-main|main> --expected-head SHA --acknowledge-side-effect
  scripts/branch-flow.sh verify-pr --head NAME --target <dev-main|main> --expected-head SHA --expected-target SHA [--test-change-request FILE --test-release-review FILE] [--json]
  scripts/branch-flow.sh sync-protected
  scripts/branch-flow.sh finish --branch NAME --target <dev-main|main> --expected-head SHA --acknowledge-side-effect
  scripts/branch-flow.sh check-pr-route HEAD BASE
  scripts/branch-flow.sh self-check
EOF
}

is_protected_branch() {
  case "$1" in
    main|dev-main) return 0 ;;
    *) return 1 ;;
  esac
}

assert_target() {
  case "$1" in
    main|dev-main) ;;
    *) die "unsupported PR target: $1" ;;
  esac
}

route_allowed() {
  local head="$1"
  local base="$2"
  case "$base:$head" in
    dev-main:kernel/*|dev-main:session/*|dev-main:ui/*|dev-main:fix/*|dev-main:main) return 0 ;;
    main:dev-main|main:hotfix/*|main:release/*) return 0 ;;
    *) return 1 ;;
  esac
}

target_for_branch() {
  case "$1" in
    kernel/*|session/*|ui/*|fix/*|main) printf 'dev-main\n' ;;
    dev-main|hotfix/*|release/*) printf 'main\n' ;;
    *) return 1 ;;
  esac
}

require_repo() {
  [ -x /usr/bin/git ] || die '/usr/bin/git is required for branch governance'
  git rev-parse --show-toplevel >/dev/null 2>&1 || die 'run this command inside a DeepCode Git worktree'
}

repo_root() {
  git rev-parse --show-toplevel
}

common_git_dir() {
  git rev-parse --path-format=absolute --git-common-dir
}

current_branch() {
  git symbolic-ref --quiet --short HEAD || die 'detached HEAD is not valid for this command'
}

worktree_path_for_branch() {
  local wanted="$1"
  local wt=''
  local branch=''
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      worktree\ *) wt="${line#worktree }"; branch='' ;;
      branch\ refs/heads/*) branch="${line#branch refs/heads/}" ;;
      '')
        if [ "$branch" = "$wanted" ]; then
          printf '%s\n' "$wt"
          return 0
        fi
        wt=''
        branch=''
        ;;
    esac
  done < <(git worktree list --porcelain; printf '\n')
  return 1
}

assert_clean_worktree() {
  local wt="$1"
  if [ -n "$(git -C "$wt" status --porcelain)" ]; then
    die "worktree has uncommitted changes: $wt"
  fi
}

assert_same_repository() {
  local wt="$1"
  local current_common
  local candidate_common
  current_common="$(common_git_dir)"
  candidate_common="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || die "not a Git worktree: $wt"
  [ "$current_common" = "$candidate_common" ] \
    || die "worktree belongs to another Git repository: $wt"
}

assert_verify_script_matches_target() {
  local expected_target="$1"
  local script_source="${BASH_SOURCE[0]}"
  local current_blob
  local target_blob
  [ -f "$script_source" ] \
    || die 'verify-pr must run from a materialized branch-flow.sh file'
  current_blob="$(git hash-object --no-filters "$script_source")"
  target_blob="$(git rev-parse "$expected_target:scripts/branch-flow.sh" 2>/dev/null)" \
    || die 'verified target does not contain scripts/branch-flow.sh'
  [ "$current_blob" = "$target_blob" ] || die \
    'verify-pr script differs from the trusted target; materialize scripts/branch-flow.sh from the expected target commit and run that copy'
}

run_trusted_test_change_gate() {
  local target_ref="$1"
  local target_sha="$2"
  local head_ref="$3"
  local head_sha="$4"
  local test_change_request="$5"
  local release_review="$6"
  local root
  local gate_args
  root="$(repo_root)"
  [ -x /usr/bin/python3 ] || die '/usr/bin/python3 is required for the test change gate'
  git cat-file -e "$target_sha:scripts/test-change-gate.py" 2>/dev/null \
    || die 'trusted target has no test change gate; bootstrap requires explicit user review'

  gate_args=(
    verify
    --repository "$root"
    --target-ref "$target_ref"
    --head-ref "$head_ref"
    --target "$target_sha"
    --head "$head_sha"
    --policy-ref "$target_sha"
    --quiet
  )
  if [ -n "$test_change_request" ]; then
    gate_args+=(--test-change-request "$test_change_request")
  fi
  if [ -n "$release_review" ]; then
    gate_args+=(--test-release-review "$release_review")
  fi
  if ! git show "$target_sha:scripts/test-change-gate.py" \
    | /usr/bin/python3 -I -S - "${gate_args[@]}"; then
    die 'trusted target test change gate rejected this PR'
  fi
}

check_pr_route() {
  local head="${1:-}"
  local base="${2:-}"
  [ -n "$head" ] && [ -n "$base" ] || die 'check-pr-route requires HEAD and BASE'
  assert_target "$base"
  if ! route_allowed "$head" "$base"; then
    die "PR route is not allowed: $head -> $base"
  fi
  info "PR route allowed: $head -> $base"
}

self_check() {
  route_allowed kernel/example dev-main || die 'kernel route self-check failed'
  route_allowed session/example dev-main || die 'session route self-check failed'
  route_allowed ui/example dev-main || die 'ui route self-check failed'
  route_allowed fix/example dev-main || die 'fix route self-check failed'
  route_allowed main dev-main || die 'main sync route self-check failed'
  route_allowed dev-main main || die 'release route self-check failed'
  route_allowed hotfix/example main || die 'hotfix route self-check failed'
  route_allowed release/example main || die 'release branch route self-check failed'
  if route_allowed integration/example dev-main; then
    die 'legacy integration route must remain rejected'
  fi
  if route_allowed kernel/example main; then
    die 'module-to-main route must remain rejected'
  fi
  info 'branch policy self-check passed'
}

install_hooks() {
  require_repo
  local root
  local hooks_dir
  local source
  local destination
  local hook
  root="$(repo_root)"
  hooks_dir="$(common_git_dir)/hooks"
  mkdir -p "$hooks_dir"

  for hook in reference-transaction pre-push; do
    source="$root/.githooks/$hook"
    destination="$hooks_dir/$hook"
    [ -f "$source" ] || die "missing versioned hook: $source"
    if [ -e "$destination" ] && ! grep -Fq "$MANAGED_MARKER" "$destination"; then
      die "refusing to overwrite an unmanaged hook: $destination"
    fi
  done

  for hook in reference-transaction pre-push; do
    source="$root/.githooks/$hook"
    destination="$hooks_dir/$hook"
    cp "$source" "$destination"
    chmod 0755 "$destination"
    info "installed shared hook: $destination"
  done
}

audit_worktrees() {
  local wt=''
  local branch='(detached)'
  local line
  local changes
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      worktree\ *) wt="${line#worktree }"; branch='(detached)' ;;
      branch\ refs/heads/*) branch="${line#branch refs/heads/}" ;;
      '')
        if [ -n "$wt" ]; then
          changes="$(git -C "$wt" status --porcelain | wc -l | tr -d '[:space:]')"
          if [ "$changes" -gt 0 ]; then
            info "worktree protected by dirty state: branch=$branch changes=$changes path=$wt"
          else
            info "worktree clean: branch=$branch path=$wt"
          fi
          case "$branch" in
            integration/*) info "legacy active branch requires rename before PR; no cleanup performed: $branch" ;;
          esac
        fi
        wt=''
        branch='(detached)'
        ;;
    esac
  done < <(git worktree list --porcelain; printf '\n')
}

audit_local_branches() {
  local branch
  local target
  local checked='no'
  local merged='no'
  while IFS= read -r branch; do
    is_protected_branch "$branch" && continue
    target="$(target_for_branch "$branch" || true)"
    if [ -z "$target" ]; then
      info "local branch has nonstandard prefix: $branch"
      continue
    fi
    checked='no'
    merged='no'
    worktree_path_for_branch "$branch" >/dev/null 2>&1 && checked='yes'
    if git show-ref --verify --quiet "refs/heads/$target" \
      && git merge-base --is-ancestor "$branch" "$target"; then
      merged='yes'
    fi
    info "local branch: name=$branch target=$target checkedOut=$checked merged=$merged"
  done < <(git for-each-ref --format='%(refname:short)' refs/heads | sort)
}

audit_remote_branches() {
  local remote_ref
  local branch
  local target
  local merged='no'
  while IFS= read -r remote_ref; do
    branch="${remote_ref#origin/}"
    case "$branch" in
      origin|HEAD|main|dev-main) continue ;;
    esac
    target="$(target_for_branch "$branch" || true)"
    if [ -z "$target" ]; then
      info "remote branch has nonstandard prefix: $branch"
      continue
    fi
    merged='no'
    if git show-ref --verify --quiet "refs/remotes/origin/$target" \
      && git merge-base --is-ancestor "$remote_ref" "origin/$target"; then
      merged='yes'
    fi
    info "remote branch: name=$branch target=$target merged=$merged"
  done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin | sort)
}

audit() {
  require_repo
  audit_worktrees
  audit_local_branches
  audit_remote_branches
  info 'audit completed without modifying branches or worktrees'
}

start_branch() {
  require_repo
  local kind="${1:-}"
  local slug="${2:-}"
  shift 2 || true
  local wt
  local release_approved='no'
  local base
  local branch
  wt="$(repo_root)"

  case "$kind" in
    kernel|session|ui|fix|hotfix|release) ;;
    *) die "unsupported branch kind: $kind" ;;
  esac
  [[ "$slug" =~ ^[a-z0-9][a-z0-9._-]*$ ]] \
    || die 'slug must use lowercase letters, digits, dots, underscores, or hyphens'

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --worktree)
        [ "$#" -ge 2 ] || die '--worktree requires a path'
        wt="$2"
        shift 2
        ;;
      --release-approved)
        release_approved='yes'
        shift
        ;;
      *) die "unknown start option: $1" ;;
    esac
  done

  if [ "$kind" = 'release' ] && [ "$release_approved" != 'yes' ]; then
    die 'release/* requires --release-approved'
  fi
  assert_same_repository "$wt"
  assert_clean_worktree "$wt"
  base='dev-main'
  [ "$kind" = 'hotfix' ] && base='main'
  branch="$kind/$slug"

  git -C "$wt" fetch origin --prune
  git -C "$wt" show-ref --verify --quiet "refs/heads/$base" || die "missing local base: $base"
  git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$base" || die "missing remote base: origin/$base"
  [ "$(git -C "$wt" rev-parse "$base")" = "$(git -C "$wt" rev-parse "origin/$base")" ] \
    || die "$base must exactly match origin/$base before starting work"
  if git -C "$wt" show-ref --verify --quiet "refs/heads/$branch" \
    || git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    die "branch already exists: $branch"
  fi

  git -C "$wt" switch -c "$branch" "$base"
  info "created local-only branch: $branch from $base in $wt"
}

prepare_pr() {
  require_repo
  local target=''
  local json='no'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --target)
        [ "$#" -ge 2 ] || die '--target requires a branch'
        target="$2"
        shift 2
        ;;
      --json) json='yes'; shift ;;
      *) die "unknown prepare-pr option: $1" ;;
    esac
  done
  [ -n "$target" ] || die 'prepare-pr requires --target'
  assert_target "$target"

  local head
  local head_sha
  local target_sha
  local counts
  local behind
  local ahead
  local root
  head="$(current_branch)"
  route_allowed "$head" "$target" || die "PR route is not allowed: $head -> $target"
  root="$(repo_root)"
  assert_clean_worktree "$root"
  git fetch origin --prune
  git show-ref --verify --quiet "refs/remotes/origin/$target" || die "missing target: origin/$target"

  if [ "$head" != 'main' ] || [ "$target" != 'dev-main' ]; then
    git merge-base --is-ancestor "origin/$target" HEAD \
      || die "branch is not based on the latest origin/$target"
  fi
  git diff --check "origin/$target...HEAD"
  head_sha="$(git rev-parse HEAD)"
  target_sha="$(git rev-parse "origin/$target")"
  counts="$(git rev-list --left-right --count "origin/$target...HEAD")"
  behind="${counts%%[[:space:]]*}"
  ahead="${counts##*[[:space:]]}"
  [ "$ahead" -gt 0 ] || die "no commits are available for PR: $head -> $target"

  if [ "$json" = 'yes' ]; then
    printf '{"allowed":true,"head":"%s","headSha":"%s","target":"%s","targetSha":"%s","behind":%s,"ahead":%s}\n' \
      "$head" "$head_sha" "$target" "$target_sha" "$behind" "$ahead"
  else
    info "PR ready: head=$head headSha=$head_sha target=$target targetSha=$target_sha behind=$behind ahead=$ahead"
  fi
}

publish_task() {
  require_repo
  local target=''
  local expected_head=''
  local side_effect_acknowledged='no'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --target) target="${2:-}"; shift 2 ;;
      --expected-head) expected_head="${2:-}"; shift 2 ;;
      --acknowledge-side-effect) side_effect_acknowledged='yes'; shift ;;
      *) die "unknown publish-task option: $1" ;;
    esac
  done
  [ "$side_effect_acknowledged" = 'yes' ] \
    || die 'publish-task requires --acknowledge-side-effect; this flag confirms the push side effect and is not authorization proof'
  [ -n "$target" ] && [ -n "$expected_head" ] \
    || die 'publish-task requires --target and --expected-head'
  local head
  local actual_head
  head="$(current_branch)"
  is_protected_branch "$head" && die "protected branches cannot be published directly: $head"
  actual_head="$(git rev-parse HEAD)"
  [ "$actual_head" = "$expected_head" ] \
    || die "expected head mismatch: expected $expected_head, found $actual_head"
  prepare_pr --target "$target"
  git push -u origin "HEAD:refs/heads/$head"
  info "published task branch for PR: $head -> $target at $actual_head"
}

verify_pr() {
  require_repo
  local head=''
  local target=''
  local expected_head=''
  local expected_target=''
  local test_change_request=''
  local test_release_review=''
  local json='no'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --head) head="${2:-}"; shift 2 ;;
      --target) target="${2:-}"; shift 2 ;;
      --expected-head) expected_head="${2:-}"; shift 2 ;;
      --expected-target) expected_target="${2:-}"; shift 2 ;;
      --test-change-request) test_change_request="${2:-}"; shift 2 ;;
      --test-release-review) test_release_review="${2:-}"; shift 2 ;;
      --json) json='yes'; shift ;;
      *) die "unknown verify-pr option: $1" ;;
    esac
  done
  [ -n "$head" ] && [ -n "$target" ] \
    && [ -n "$expected_head" ] && [ -n "$expected_target" ] \
    || die 'verify-pr requires --head, --target, --expected-head, and --expected-target'
  assert_target "$target"
  route_allowed "$head" "$target" || die "PR route is not allowed: $head -> $target"
  [[ "$expected_head" =~ ^[0-9a-f]{40}$ ]] \
    || die "expected head is not a full commit SHA: $expected_head"
  [[ "$expected_target" =~ ^[0-9a-f]{40}$ ]] \
    || die "expected target is not a full commit SHA: $expected_target"

  local actual_head
  local actual_target
  local local_head
  local wt
  local counts
  local behind
  local ahead
  git fetch origin --prune
  git show-ref --verify --quiet "refs/remotes/origin/$head" \
    || die "missing PR head: origin/$head"
  git show-ref --verify --quiet "refs/remotes/origin/$target" \
    || die "missing PR target: origin/$target"
  actual_head="$(git rev-parse "origin/$head")"
  actual_target="$(git rev-parse "origin/$target")"
  [ "$actual_head" = "$expected_head" ] \
    || die "PR head moved: expected $expected_head, found $actual_head"
  [ "$actual_target" = "$expected_target" ] \
    || die "PR target moved: expected $expected_target, found $actual_target"
  assert_verify_script_matches_target "$expected_target"

  if git show-ref --verify --quiet "refs/heads/$head"; then
    local_head="$(git rev-parse "$head")"
    [ "$local_head" = "$expected_head" ] \
      || die "local PR head differs from reviewed head: $head"
    wt="$(worktree_path_for_branch "$head" || true)"
    [ -z "$wt" ] || assert_clean_worktree "$wt"
  fi

  if [ "$head" != 'main' ] || [ "$target" != 'dev-main' ]; then
    git merge-base --is-ancestor "origin/$target" "origin/$head" \
      || die "PR head is not based on the verified origin/$target"
  fi
  git diff --check "origin/$target...origin/$head"
  counts="$(git rev-list --left-right --count "origin/$target...origin/$head")"
  behind="${counts%%[[:space:]]*}"
  ahead="${counts##*[[:space:]]}"
  [ "$ahead" -gt 0 ] || die "no commits are available for PR: $head -> $target"
  run_trusted_test_change_gate \
    "$target" \
    "$actual_target" \
    "$head" \
    "$actual_head" \
    "$test_change_request" \
    "$test_release_review"

  if [ "$json" = 'yes' ]; then
    printf '{"verified":true,"head":"%s","headSha":"%s","target":"%s","targetSha":"%s","behind":%s,"ahead":%s}\n' \
      "$head" "$actual_head" "$target" "$actual_target" "$behind" "$ahead"
  else
    info "PR verified locally: head=$head headSha=$actual_head target=$target targetSha=$actual_target behind=$behind ahead=$ahead"
  fi
}

sync_protected() {
  require_repo
  local branch
  local wt
  git fetch origin --prune

  for branch in main dev-main; do
    git show-ref --verify --quiet "refs/heads/$branch" || die "missing local protected branch: $branch"
    git show-ref --verify --quiet "refs/remotes/origin/$branch" || die "missing remote protected branch: origin/$branch"
    git merge-base --is-ancestor "$branch" "origin/$branch" \
      || die "local $branch contains commits not present in origin/$branch"
    wt="$(worktree_path_for_branch "$branch" || true)"
    [ -z "$wt" ] || assert_clean_worktree "$wt"
  done

  for branch in main dev-main; do
    wt="$(worktree_path_for_branch "$branch" || true)"
    if [ -n "$wt" ]; then
      git -C "$wt" merge --ff-only "origin/$branch"
    else
      git branch -f "$branch" "origin/$branch"
    fi
    info "synchronized local protected branch: $branch"
  done
}

finish_branch() {
  require_repo
  local branch=''
  local target=''
  local expected_head=''
  local side_effect_acknowledged='no'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --branch) branch="${2:-}"; shift 2 ;;
      --target) target="${2:-}"; shift 2 ;;
      --expected-head) expected_head="${2:-}"; shift 2 ;;
      --acknowledge-side-effect) side_effect_acknowledged='yes'; shift ;;
      *) die "unknown finish option: $1" ;;
    esac
  done
  [ "$side_effect_acknowledged" = 'yes' ] \
    || die 'finish requires --acknowledge-side-effect; this flag confirms branch cleanup side effects and is not authorization proof'
  [ -n "$branch" ] && [ -n "$target" ] && [ -n "$expected_head" ] \
    || die 'finish requires --branch, --target, and --expected-head'
  assert_target "$target"
  is_protected_branch "$branch" && die "protected branches can never be deleted: $branch"
  route_allowed "$branch" "$target" || die "branch/target route is not allowed: $branch -> $target"

  local local_exists='no'
  local remote_exists='no'
  local wt
  local target_wt
  git fetch origin --prune
  git show-ref --verify --quiet "refs/remotes/origin/$target" || die "missing target: origin/$target"

  if git show-ref --verify --quiet "refs/heads/$branch"; then
    local_exists='yes'
    [ "$(git rev-parse "$branch")" = "$expected_head" ] \
      || die "local branch head does not match expected head: $branch"
  fi
  if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    remote_exists='yes'
    [ "$(git rev-parse "origin/$branch")" = "$expected_head" ] \
      || die "remote branch head does not match expected head: origin/$branch"
  fi
  [ "$local_exists" = 'yes' ] || [ "$remote_exists" = 'yes' ] \
    || die "branch no longer exists: $branch"
  git merge-base --is-ancestor "$expected_head" "origin/$target" \
    || die "branch has not been merged into origin/$target: $branch"

  wt="$(worktree_path_for_branch "$branch" || true)"
  if [ -n "$wt" ]; then
    assert_clean_worktree "$wt"
  fi

  if [ "$remote_exists" = 'yes' ]; then
    git push origin --delete "$branch"
    info "deleted merged remote task branch: $branch"
  fi

  if [ -n "$wt" ]; then
    target_wt="$(worktree_path_for_branch "$target" || true)"
    if [ -n "$target_wt" ] && [ "$target_wt" != "$wt" ]; then
      git -C "$wt" switch --detach "origin/$target"
      info "parked reusable worktree at detached origin/$target: $wt"
    else
      git -C "$wt" switch "$target"
      git -C "$wt" merge --ff-only "origin/$target"
      info "returned worktree to synchronized $target: $wt"
    fi
  fi

  if [ "$local_exists" = 'yes' ]; then
    git branch -d "$branch"
    info "deleted merged local task branch: $branch"
  fi
}

main() {
  local command="${1:-}"
  [ -n "$command" ] || { usage; exit 1; }
  shift
  case "$command" in
    audit) [ "$#" -eq 0 ] || die 'audit takes no arguments'; audit ;;
    install-hooks) [ "$#" -eq 0 ] || die 'install-hooks takes no arguments'; install_hooks ;;
    start) start_branch "$@" ;;
    prepare-pr) prepare_pr "$@" ;;
    publish-task) publish_task "$@" ;;
    verify-pr) verify_pr "$@" ;;
    sync-protected) [ "$#" -eq 0 ] || die 'sync-protected takes no arguments'; sync_protected ;;
    finish) finish_branch "$@" ;;
    check-pr-route) check_pr_route "$@" ;;
    self-check) [ "$#" -eq 0 ] || die 'self-check takes no arguments'; self_check ;;
    help|-h|--help) usage ;;
    *) usage; die "unknown command: $command" ;;
  esac
}

main "$@"
