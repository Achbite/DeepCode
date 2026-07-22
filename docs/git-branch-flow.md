# Git branch and pull-request workflow

DeepCode uses one Git repository, reusable worktree directories, two permanent
branches, and short-lived task branches.

## Permanent branches

- `main` is the stable release branch.
- `dev-main` is the development integration branch.
- Both branches are updated only by pull-request merge commits.
- Local deletion, remote deletion, direct push, and force push are prohibited.

Install the repository-managed guards once for the shared repository:

```bash
bash ./scripts/branch-flow.sh install-hooks
```

The installer writes the managed hooks to the shared Git common directory, so
the protection applies to every linked worktree. It refuses to replace a hook
that is not already managed by DeepCode.

## Task branches

| Work | Start | Pull-request target |
| --- | --- | --- |
| `kernel/<task>` | `dev-main` | `dev-main` |
| `session/<task>` | `dev-main` | `dev-main` |
| `ui/<task>` | `dev-main` | `dev-main` |
| `fix/<task>` | `dev-main` | `dev-main` |
| `hotfix/<issue>` | `main` | `main` |
| approved `release/<version>` | `dev-main` | `main` |

`integration/*` and persistent `dev-kernel`, `dev-session`, or `dev-ui`
branches are not valid PR sources. Reusable worktree directories do not make a
task branch permanent.

Create local work without creating a cloud branch:

```bash
bash ./scripts/branch-flow.sh start kernel permission-facts --worktree ../DeepCode-Kernel
```

After review and validation, prepare and publish the exact reviewed commit:

```bash
bash ./scripts/branch-flow.sh prepare-pr --target dev-main --json
bash ./scripts/branch-flow.sh publish-task \
  --target dev-main \
  --expected-head <reviewed-sha> \
  --acknowledge-side-effect
```

`--acknowledge-side-effect` only makes the caller explicitly acknowledge that
the command will push. It is not authentication or authorization proof; the
user decision and independent release-task boundary remain outside this Boolean
CLI acknowledgement.

GitHub rulesets enforce pull-request-only updates, deletion protection,
non-fast-forward protection, resolved review conversations, and merge commits.
They do not prove that local validation ran. Before asking the GitHub App to
merge, materialize the reviewed target's `branch-flow.sh` and use that trusted
copy to verify the exact remote head and target:

```bash
trusted_dir="$(mktemp -d)"
/usr/bin/git --no-replace-objects show \
  <reviewed-target-sha>:scripts/branch-flow.sh \
  >"$trusted_dir/branch-flow.sh"
chmod 0755 "$trusted_dir/branch-flow.sh"
bash "$trusted_dir/branch-flow.sh" verify-pr \
  --head kernel/permission-facts \
  --target dev-main \
  --expected-head <reviewed-sha> \
  --expected-target <reviewed-target-sha>
```

The explicit `--no-replace-objects` is part of the trust boundary: a local Git
replace ref must not substitute another tree while preserving the displayed
target SHA. The script also exports `GIT_NO_REPLACE_OBJECTS=1`, verifies that
its own blob matches the expected target, then loads
the test-change classifier and protected-path policy from that same target.
This prevents a PR head from weakening its own gate. Remove `trusted_dir` after
verification.

If the diff changes a protected test asset, verification fails with
`test-change-user-review-required` and reports a digest bound to the exact PR
head/target route and SHA, policy, gate, paths, categories, modes, object IDs,
and file contents. Explicit user approval of a
[Test Change Request](test-change-request.md) is required before editing.

After the development task has produced a final committed head and evidence,
the user must designate a separate top-level release task. That task stays
read-only while it independently rechecks the exact route, commits, protected
manifest, TCR scope, test receipts, and cleanup evidence. A fork, sub-agent, or
continuation of the development task is not the independent release role. If
the release task edits code, tests, fixtures, registry, gate, policy, or
documentation, it loses that role for the batch and must return the work to the
development task.

After the user explicitly accepts the exact head/target in that release task,
materialize the gate from the target commit and generate the canonical review
record outside every worktree:

```bash
umask 077
/usr/bin/git --no-replace-objects show \
  <reviewed-target-sha>:scripts/test-change-gate.py |
  /usr/bin/python3 -I -S - record-release-review \
    --repository /absolute/path/to/DeepCode-worktree \
    --target-ref dev-main \
    --head-ref fix/example \
    --target <reviewed-target-sha> \
    --head <reviewed-head-sha> \
    --policy-ref <reviewed-target-sha> \
    --test-change-request /private/path/test-change-request.md \
    --development-session-ref '<development audit reference>' \
    --user-decision-ref '<user decision audit reference>' \
    --release-session-ref '<release audit reference>' \
    --valid-seconds 3600 \
    > /private/path/test-release-review.json
```

Then pass the two external artifacts to the target-materialized branch gate:

```bash
bash "$trusted_dir/branch-flow.sh" verify-pr \
  --head kernel/permission-facts \
  --target dev-main \
  --expected-head <reviewed-sha> \
  --expected-target <reviewed-target-sha> \
  --test-change-request /private/path/test-change-request.md \
  --test-release-review /private/path/test-release-review.json
```

Both paths must be absolute, outside every worktree and Git metadata directory,
owned by the current user, and not group- or world-writable. The record is exact
canonical JSON. It binds the repository, route, commits, target policy and gate,
complete protected manifest, TCR digest, and a short validity window. Any new
push, target movement, reuse on another route, protected diff, TCR, policy,
gate, expiry, or canonical-byte change invalidates it. Missing or partial
artifacts fail closed. The TCR must also contain every required template field,
an exact `approved` decision, and a resolved change type; blank, free-form, or
unfinished templates are rejected.

The record fixes `authentication`, `authorizationProof`, and
`sessionIndependenceProof` to `none`. Its development, user-decision, and
release references are audit locators only. Different reference strings do not
prove who acted, that the user authorized the change, or that the tasks are
independent. Local canonicalization, hashes, file ownership, task IDs, commit
authors, and timestamps likewise do not create an identity boundary. The
workflow separation and the user's explicit decisions remain procedural
requirements enforced by the participants, not cryptographic claims made by
the repository.

Run the relevant module checks and the default repository `test.sh` required
profile in the project Docker environment before this command. The explicit
host-safe `bash ./test.sh --profile static` profile is useful for early
feedback, but it is not a substitute for the required profile. The registered
`bash ./test.sh --profile smoke` profile contains non-authoritative Agent-loop
and selected historical-defect diagnostics grouped as communication, tool
Loop, resource-path, and authorization checks. Every smoke case is registered
with an incident reference and stable invariant; the controller and runner
must agree on the exact case list. The current policy permits at most four
groups, five total cases, and three cases per group. Changing those limits or
case boundaries requires a user-approved test change; smoke must not become a
default home for broad regression coverage. Even a passing smoke receipt remains
`authoritative: false` and does not replace the required profile. The former
broad Session smoke/timeline aggregate was deleted instead of becoming a
parallel regression gate. The combined `full` profile is also
non-authoritative and does not replace the required profile. `verify-pr`
fetches current remote
state and rejects an invalid route, moved head, moved target, dirty active head
worktree, stale target ancestry, missing commits, or diff whitespace errors.
The GitHub App must merge with the same expected head SHA immediately after the
local gate. Any later branch movement stops the closure and requires a new
verification.

This workflow intentionally does not depend on GitHub-hosted Actions runners.
It is free and works for a single-authority repository, but GitHub cannot
server-enforce that a local command was run. Repository administrators must not
manually bypass the documented local gate.

The first PR that bootstraps the classifier cannot be verified by an older
target that does not contain it. That one transition requires explicit user
review of the gate, policy, wiring, and tests. Once present on the protected
target, a missing trusted gate is fail-closed and is not a reusable exception.

After merge, GitHub removes the remote head branch. The local cleanup command
also handles a remaining remote ref, but only after proving that the exact head
is contained in the target:

```bash
bash ./scripts/branch-flow.sh finish \
  --branch kernel/permission-facts \
  --target dev-main \
  --expected-head <merged-head-sha> \
  --acknowledge-side-effect
```

Here too, the flag acknowledges branch-deletion side effects only. It does not
prove who requested cleanup or authorize it on the user's behalf.

The command refuses protected, dirty, active-unmerged, stale, or unmerged
branches. A clean reusable module worktree is parked at detached
`origin/dev-main` when `dev-main` is already checked out elsewhere.

## Release and hotfix synchronization

Normal release:

```text
dev-main -> PR -> main
main -> PR -> dev-main
```

Stable hotfix:

```text
main -> hotfix/<issue> -> PR -> main
main -> PR -> dev-main
```

The second PR carries the release or hotfix merge topology back to the
integration branch. Neither flow directly pushes `main` or `dev-main`.

Use `bash ./scripts/branch-flow.sh audit` at any time to report dirty
worktrees, nonstandard branch names, checked-out branches, and whether local or
remote task branches have been merged. Audit never deletes or switches refs.
