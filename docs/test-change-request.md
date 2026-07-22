# Test Change Request

This template is required before changing a protected test asset. A normal
implementation or bug-fix request does not authorize test changes.

## Requested scope

- Request reference:
- Test IDs:
- Exact repository paths (JSON array):
- Change type: add / replace / expectation-change / fixture-change / remove / rename / runner / policy
- Why this scope is necessary:

## Contract comparison

- Existing invariant and fact source:
- Evidence that the existing test is obsolete or incorrect:
- Proposed invariant and fact source:
- Exact pass/fail boundary change:
- Replacement coverage or reason no replacement is valid:
- Runtime, compatibility, and cross-layer impact:

## User decision

- Decision: pending / approved / rejected
- Approved paths and intent:
- Explicit exclusions:
- Approver:
- Decision timestamp:

Approval applies only to the listed paths and intent. New paths, removed cases,
weaker assertions, changed fixtures, disabled registration, or a new head/target
pair require another decision.

The exact-path array uses repository-relative POSIX paths without globs; a
rename lists both its old and new path. The gate accepts this document only
when each heading and field above appears
exactly once with a non-empty value, `Decision` is exactly `approved`, and
`Change type` is one listed value rather than the unresolved template options.
Every protected old/new path in the final manifest must be covered by that
array. Empty, free-form, duplicate-field, pending, rejected, malformed-path, or
out-of-scope documents fail closed.
This validation proves template completeness only. `Approver`, timestamp, and
decision text remain audit statements and do not authenticate the user.

## Independent release review record

Explicit user agreement is required before a development task edits any
protected test asset. That decision is recorded in the Test Change Request and
applies only to its listed paths and intent. It is not inferred from a feature
request, a failing test, or a request to continue.

After the approved changes are committed, the development task stops and hands
off the exact head/target SHA, protected manifest, TCR digest, test receipts,
resource cleanup evidence, and residual risks. The user then designates a
separate top-level release task. That task must remain read-only while it
rechecks the final facts. A fork, sub-agent, or continuation of the development
task is not the independent release role. If the release task edits code,
tests, fixtures, registry, gate, policy, or documentation, it loses that role
for the batch; the changes return to development and a new independent release
review is required.

After the user explicitly accepts the exact final head/target in the release
task, use the target version of the gate to create a canonical record outside
every Git worktree. The referenced Test Change Request must also be outside all
worktrees and already reviewed by the user:

```bash
umask 077
/usr/bin/git --no-replace-objects show <target-sha>:scripts/test-change-gate.py |
  /usr/bin/python3 -I -S - record-release-review \
    --repository /absolute/path/to/DeepCode-worktree \
    --target-ref dev-main \
    --head-ref fix/example \
    --target <target-sha> \
    --head <head-sha> \
    --policy-ref <target-sha> \
    --test-change-request /private/path/test-change-request.md \
    --development-session-ref '<development audit reference>' \
    --user-decision-ref '<user decision audit reference>' \
    --release-session-ref '<release audit reference>' \
    --valid-seconds 3600 \
    > /private/path/test-release-review.json
```

`--no-replace-objects` prevents local replace refs from substituting another
target tree. Python isolated/no-site mode prevents PR files such as
`argparse.py` or `json.py` from shadowing standard-library imports. The TCR and
record paths must be absolute, outside every worktree and Git metadata
directory, regular files owned by the current user, and not group- or
world-writable.

The release review is ASCII canonical JSON with sorted keys, no insignificant
whitespace, and one final LF. It contains only the fixed schema fields and
binds:

- repository, exact PR head/target branch route, and exact target/head SHA;
- target policy and gate SHA-256;
- the complete protected A/M/D/R/C/T manifest, paths, categories, modes, object
  IDs, and content SHA-256 values;
- the exact Test Change Request SHA-256;
- canonical UTC `recordedAt` and `expiresAt` within the target policy lifetime;
- development, user-decision, and release references used only as audit
  locators.

The record fixes `workflowModel` to
`development-session-user-independent-release-session` and fixes
`authentication`, `authorizationProof`, and `sessionIndependenceProof` to
`none`. The gate requires different development and release reference strings
as a workflow assertion, but it cannot prove those references are real, who
acted, whether the user authorized the change, or whether two tasks are truly
independent. Task IDs, usernames, `approvedBy`, Boolean flags, file ownership,
hashes, timestamps, commit authors, and canonical JSON do not create an
authentication or authorization boundary.

Verification requires the TCR and canonical release-review record together.
Any changed byte, new push, branch-route reuse, target movement, protected
manifest change, policy/gate change, TCR edit, or expiration invalidates the
record. Partial artifacts, extra schema fields, self-declared identity claims,
and records for an unprotected diff fail closed.

The record proves only scope consistency, exact Git binding, canonical form,
and limited freshness. The independent release task provides a second context
and review discipline, not a separate OS security domain. GitHub also cannot
prove that this local gate ran. The user's decisions and the release task's
read-only conduct therefore remain procedural governance requirements.

## Bootstrap boundary

The first PR introducing `scripts/test-change-gate.py` cannot prove itself with
the target version because that version does not exist yet. It therefore needs
an explicit one-time user review of the classifier, policy, branch-flow wiring,
and tests. After the bootstrap lands on the protected target, absence of the
trusted target gate is fail-closed and is not a reusable bypass.
