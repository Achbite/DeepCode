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
  --authorized
```

The GitHub App creates the ready-for-review PR and merges it with the same
expected head SHA after required checks pass. A changed SHA, dirty worktree,
failed check, unresolved review, conflict, or moved target stops the closure.

After merge, GitHub removes the remote head branch. The local cleanup command
also handles a remaining remote ref, but only after proving that the exact head
is contained in the target:

```bash
bash ./scripts/branch-flow.sh finish \
  --branch kernel/permission-facts \
  --target dev-main \
  --expected-head <merged-head-sha> \
  --authorized
```

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
